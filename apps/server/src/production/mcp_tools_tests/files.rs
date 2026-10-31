//! The workspace file tools (#139 slice X5) end to end: the real `projects.*` handlers and
//! workspace service on a temporary folder, the real transfer mint and routes, and the real
//! auth service and live controls. Only the trash is faked, so a delete never reaches the
//! system trash.

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::body::Body;
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{CREATED_AT, Harness, command, error_tag, structured};
use crate::{
    git::{FileTrash, FileTrashFuture, TrashUnavailable},
    mcp::control::{ClientPrincipal, McpAccess, McpCapabilities, McpServerSettings},
    production::{
        http_routes::{
            HttpRouteError, RouteContext, TransferDownloadHttpOutcome, TransferUploadHttpOutcome,
        },
        transfer_routes,
        workspace_preview::register_transfer_mints,
    },
    transfer::TransferAccess,
    workspace::{WorkspaceRpc, WorkspaceRpcDependencies, WorkspaceService},
};

const THREAD: &str = "files-thread";
const BASE: &str = "http://127.0.0.1:43210";
const PLAIN_METHODS: &[&str] = &[
    "projects.listEntries",
    "projects.searchEntries",
    "projects.readFile",
    "projects.writeFileIfUnchanged",
    "projects.createEntry",
    "projects.renameEntry",
    "projects.deleteEntry",
];

/// Moves a deleted entry into a folder of its own, or refuses while switched off.
struct TestTrash {
    folder: PathBuf,
    available: AtomicBool,
    count: AtomicUsize,
}

impl FileTrash for TestTrash {
    fn trash<'a>(&'a self, path: PathBuf, _: &'a CancellationToken) -> FileTrashFuture<'a> {
        Box::pin(async move {
            if !self.available.load(Ordering::SeqCst) {
                return Err(TrashUnavailable);
            }
            let index = self.count.fetch_add(1, Ordering::SeqCst);
            tokio::fs::rename(&path, self.folder.join(index.to_string()))
                .await
                .map_err(|_| TrashUnavailable)
        })
    }
}

struct Fixture {
    harness: Harness,
    agent: ClientPrincipal,
    /// The thread's folder.
    folder: PathBuf,
    /// A folder outside it.
    outside: PathBuf,
    trash: Arc<TestTrash>,
    access: TransferAccess,
    _folders: [tempfile::TempDir; 3],
}

async fn fixture() -> Fixture {
    let folders = [
        tempfile::tempdir().expect("folder"),
        tempfile::tempdir().expect("outside"),
        tempfile::tempdir().expect("trash"),
    ];
    let folder = folders[0].path().canonicalize().unwrap();
    let outside = folders[1].path().canonicalize().unwrap();
    let trash = Arc::new(TestTrash {
        folder: folders[2].path().to_path_buf(),
        available: AtomicBool::new(true),
        count: AtomicUsize::new(0),
    });
    let access = TransferAccess::new(vec![9_u8; 32]);
    let workspace = WorkspaceRpc::with_dependencies(
        WorkspaceService::default().with_trash(trash.clone()),
        WorkspaceRpcDependencies {
            transfer_access: Some(access.clone()),
            ..WorkspaceRpcDependencies::default()
        },
    );
    let harness = Harness::with_methods(move |registry| {
        for method in PLAIN_METHODS {
            let workspace = workspace.clone();
            registry.register_unary(*method, move |request, cancellation| {
                let workspace = workspace.clone();
                async move {
                    workspace
                        .handle_with_cancellation(&request.tag, request.payload, cancellation)
                        .await
                }
            });
        }
        register_transfer_mints(registry, workspace);
    })
    .await;
    harness.control.attach_transfer_base(BASE.to_owned());
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.create", "commandId": "create-files-thread", "threadId": THREAD,
            "projectId": "p1", "title": "Files",
            "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "approval-required", "interactionMode": "default", "branch": null,
            "worktreePath": folder, "createdAt": CREATED_AT,
        })))
        .await
        .expect("thread created");
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
    Fixture {
        harness,
        agent,
        folder,
        outside,
        trash,
        access,
        _folders: folders,
    }
}

fn context() -> RouteContext {
    RouteContext {
        headers: axum::http::HeaderMap::new(),
        uri: axum::http::Uri::from_static("/api/transfers/token"),
        cancellation: CancellationToken::new(),
    }
}

fn token_of(url: &Value) -> String {
    url.as_str().unwrap().rsplit('/').next().unwrap().to_owned()
}

fn status<T>(result: Result<T, HttpRouteError>) -> u16 {
    match result {
        Ok(_) => 200,
        Err(error) => error.status().as_u16(),
    }
}

impl Fixture {
    async fn call(&self, tool: &str, mut arguments: Value) -> Value {
        arguments["threadId"] = THREAD.into();
        self.harness.call(&self.agent, tool, arguments).await
    }

    fn write(&self, path: &str, contents: impl AsRef<[u8]>) {
        let path = self.folder.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.folder.join(path)).ok()
    }

    fn settings(&self, change: impl FnOnce(&mut McpServerSettings)) {
        self.harness.settings.send_modify(change);
    }

    async fn download_url(&self, path: &str) -> String {
        let minted = self.call("files_download", json!({ "path": path })).await;
        token_of(&structured(&minted)["url"])
    }

    async fn upload_url(&self, file_name: &str, overwrite: bool) -> String {
        let minted = self
            .call(
                "files_upload",
                json!({ "directory": "", "fileName": file_name, "overwrite": overwrite }),
            )
            .await;
        token_of(&structured(&minted)["url"])
    }

    fn downloads(&self) -> crate::production::http_routes::TransferDownloadHandler {
        transfer_routes::download_handler_with_mcp(
            self.access.clone(),
            self.harness.control.clone(),
        )
    }

    fn uploads(&self) -> crate::production::http_routes::TransferUploadHandler {
        transfer_routes::upload_handler_with_mcp(
            self.access.clone(),
            Arc::new(|_| Box::pin(async {})),
            self.harness.control.clone(),
        )
    }

    async fn download(&self, token: &str) -> Result<Vec<u8>, u16> {
        match (self.downloads())(token.to_owned(), context()).await {
            Ok(TransferDownloadHttpOutcome::Stream(response)) => {
                axum::body::to_bytes(response.body, usize::MAX)
                    .await
                    .map(|bytes| bytes.to_vec())
                    .map_err(|_| 0)
            }
            Ok(TransferDownloadHttpOutcome::ArchiveTooLarge { .. }) => Err(413),
            Err(error) => Err(error.status().as_u16()),
        }
    }

    async fn upload(&self, token: &str, overwrite_query: bool, bytes: &'static [u8]) -> u16 {
        match (self.uploads())(
            token.to_owned(),
            None,
            overwrite_query,
            Body::from(bytes),
            context(),
        )
        .await
        {
            Ok(TransferUploadHttpOutcome::Created { .. }) => 201,
            Ok(TransferUploadHttpOutcome::Exists) => 409,
            Ok(TransferUploadHttpOutcome::TooLarge { .. }) => 413,
            Err(error) => error.status().as_u16(),
        }
    }

    async fn revoke(&self) {
        assert!(
            self.harness
                .auth
                .revoke_client("a-person", &self.agent.principal.session_id)
                .await
                .unwrap()
        );
    }

    async fn shutdown(self) {
        self.harness.shutdown().await;
    }
}

#[tokio::test]
async fn the_files_tools_are_listed_with_their_hints_and_hidden_with_their_set() {
    let fixture = fixture().await;
    let tools = fixture.harness.control.tools(&fixture.agent);
    let hints = |name: &str| {
        tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} is listed"))["annotations"]
            .clone()
    };
    for name in ["files_list", "files_search", "files_read", "files_download"] {
        assert_eq!(hints(name)["readOnlyHint"], true, "{name}");
        assert_eq!(hints(name)["destructiveHint"], false, "{name}");
    }
    for name in ["files_write", "files_create", "files_rename"] {
        assert_eq!(hints(name)["readOnlyHint"], false, "{name}");
        assert_eq!(hints(name)["destructiveHint"], false, "{name}");
        assert_eq!(hints(name)["idempotentHint"], false, "{name}");
    }
    for name in ["files_delete", "files_upload"] {
        assert_eq!(hints(name)["destructiveHint"], true, "{name}");
        assert_eq!(hints(name)["idempotentHint"], false, "{name}");
    }

    fixture.settings(|settings| {
        settings.capabilities = McpCapabilities {
            files: false,
            ..McpCapabilities::default()
        };
    });
    let tools = fixture.harness.control.tools(&fixture.agent);
    assert!(
        !tools
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"].as_str().unwrap().starts_with("files_"))
    );
    let refused = fixture.call("files_list", json!({})).await;
    assert_eq!(error_tag(&refused), "McpCapabilityDisabledError");
    fixture.shutdown().await;
}

#[tokio::test]
async fn reads_come_in_pages_with_the_version_and_refuse_large_and_binary_files() {
    let fixture = fixture().await;
    let text: String = (0..40_000)
        .map(|index| char::from(b'a' + (index % 26) as u8))
        .collect();
    fixture.write("src/big.txt", &text);
    let first = fixture
        .call("files_read", json!({ "path": "./src//big.txt" }))
        .await;
    let first = structured(&first).clone();
    assert_eq!(first["path"], "src/big.txt");
    assert_eq!(first["text"].as_str().unwrap().chars().count(), 16_000);
    assert_eq!(first["truncated"], true);
    assert_eq!(first["byteLength"], 40_000);
    assert_eq!(
        first["version"],
        crate::crypto::sha256_hex(text.as_bytes()).as_str()
    );
    let mut read = first["text"].as_str().unwrap().to_owned();
    let mut next = first["nextOffset"].clone();
    while let Some(offset) = next.as_u64() {
        let page = fixture
            .call(
                "files_read",
                json!({ "path": "src/big.txt", "offset": offset }),
            )
            .await;
        let page = structured(&page);
        read.push_str(page["text"].as_str().unwrap());
        next = page["nextOffset"].clone();
    }
    assert_eq!(read, text);

    // A page of control characters escapes to six times its length; it is halved to fit.
    fixture.write("controls.txt", "\u{1}".repeat(20_000));
    let page = fixture
        .call("files_read", json!({ "path": "controls.txt" }))
        .await;
    assert!(page["content"][0]["text"].as_str().unwrap().chars().count() <= 80_000);
    let page = structured(&page);
    assert!(page["text"].as_str().unwrap().chars().count() < 16_000);
    assert_eq!(page["truncated"], true);

    fixture.write("huge.txt", vec![b'x'; 2 * 1024 * 1024]);
    let refused = fixture
        .call("files_read", json!({ "path": "huge.txt" }))
        .await;
    assert_eq!(error_tag(&refused), "McpFileTooLargeError");
    assert!(
        refused["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("files_download")
    );
    fixture.write("image.bin", b"\x89PNG\0\0data");
    let refused = fixture
        .call("files_read", json!({ "path": "image.bin" }))
        .await;
    assert_eq!(
        refused["structuredContent"]["error"]["failure"],
        "binary_file"
    );
    assert!(
        refused["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("files_download")
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_write_needs_the_version_it_read_or_create_only() {
    let fixture = fixture().await;
    fixture.write("a.txt", "one\n");
    let read = fixture.call("files_read", json!({ "path": "a.txt" })).await;
    let version = structured(&read)["version"].as_str().unwrap().to_owned();

    let written = fixture
        .call(
            "files_write",
            json!({ "path": "a.txt", "content": "two\n", "expectedVersion": version }),
        )
        .await;
    assert_eq!(
        structured(&written)["version"],
        crate::crypto::sha256_hex(b"two\n").as_str()
    );
    assert_eq!(fixture.read("a.txt").as_deref(), Some("two\n"));

    // The version read before is stale now.
    let stale = fixture
        .call(
            "files_write",
            json!({ "path": "a.txt", "content": "three\n", "expectedVersion": version }),
        )
        .await;
    assert_eq!(
        stale["structuredContent"]["error"]["failure"],
        "file_changed_on_disk"
    );
    assert_eq!(fixture.read("a.txt").as_deref(), Some("two\n"));
    // The message names the path the agent gave, never the host's.
    assert!(
        !stale["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(&*fixture.folder.to_string_lossy())
    );

    let exists = fixture
        .call(
            "files_write",
            json!({ "path": "a.txt", "content": "x", "createOnly": true }),
        )
        .await;
    assert_eq!(
        exists["structuredContent"]["error"]["failure"],
        "file_changed_on_disk"
    );
    let created = fixture
        .call(
            "files_write",
            json!({ "path": "new/dir/b.txt", "content": "b", "createOnly": true }),
        )
        .await;
    structured(&created);
    assert_eq!(fixture.read("new/dir/b.txt").as_deref(), Some("b"));

    for arguments in [
        json!({ "path": "a.txt", "content": "x" }),
        json!({ "path": "a.txt", "content": "x", "expectedVersion": version, "createOnly": true }),
        json!({ "path": "a.txt", "content": "x", "expectedVersion": "not-a-version" }),
    ] {
        let refused = fixture.call("files_write", arguments).await;
        assert_eq!(error_tag(&refused), "McpInvalidArgumentError");
    }
    let too_big = fixture
        .call(
            "files_write",
            json!({ "path": "c.txt", "content": "x".repeat(1024 * 1024 + 1), "createOnly": true }),
        )
        .await;
    assert_eq!(error_tag(&too_big), "McpInvalidArgumentError");
    fixture.shutdown().await;
}

#[tokio::test]
async fn create_rename_list_and_search_work_in_the_threads_folder() {
    let fixture = fixture().await;
    let created = fixture
        .call(
            "files_create",
            json!({ "path": "docs", "kind": "directory" }),
        )
        .await;
    structured(&created);
    let created = fixture
        .call(
            "files_create",
            json!({ "path": "docs/notes.md", "kind": "file" }),
        )
        .await;
    structured(&created);
    let again = fixture
        .call(
            "files_create",
            json!({ "path": "docs/notes.md", "kind": "file" }),
        )
        .await;
    assert_eq!(
        again["structuredContent"]["error"]["failure"],
        "entry_already_exists"
    );
    let renamed = fixture
        .call(
            "files_rename",
            json!({ "from": "docs/notes.md", "to": "docs/readme.md" }),
        )
        .await;
    assert_eq!(structured(&renamed)["to"], "docs/readme.md");
    assert!(fixture.folder.join("docs/readme.md").exists());
    fixture.write("docs/other.md", "x");
    let occupied = fixture
        .call(
            "files_rename",
            json!({ "from": "docs/readme.md", "to": "docs/other.md" }),
        )
        .await;
    assert_eq!(
        occupied["structuredContent"]["error"]["failure"],
        "entry_already_exists"
    );

    let listed = fixture.call("files_list", json!({})).await;
    let paths: Vec<_> = structured(&listed)["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap().to_owned())
        .collect();
    assert!(paths.contains(&"docs/readme.md".to_owned()), "{paths:?}");
    let found = fixture
        .call("files_search", json!({ "query": "readme" }))
        .await;
    assert_eq!(structured(&found)["entries"][0]["path"], "docs/readme.md");
    let refused = fixture.call("files_list", json!({ "limit": 201 })).await;
    assert_eq!(error_tag(&refused), "McpInvalidArgumentError");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_delete_goes_to_the_trash_unless_permanent_and_never_falls_back() {
    let fixture = fixture().await;
    fixture.write("trash-me/inner.txt", "x");
    let trashed = fixture
        .call("files_delete", json!({ "path": "trash-me" }))
        .await;
    assert_eq!(structured(&trashed)["trashed"], true);
    assert!(!fixture.folder.join("trash-me").exists());
    assert_eq!(fixture.trash.count.load(Ordering::SeqCst), 1);

    fixture.trash.available.store(false, Ordering::SeqCst);
    fixture.write("kept.txt", "x");
    let refused = fixture
        .call("files_delete", json!({ "path": "kept.txt" }))
        .await;
    assert_eq!(
        refused["structuredContent"]["error"]["failure"],
        "trash_unavailable"
    );
    assert!(fixture.folder.join("kept.txt").exists());

    let removed = fixture
        .call(
            "files_delete",
            json!({ "path": "kept.txt", "permanent": true, "clientRequestId": "delete-1" }),
        )
        .await;
    assert_eq!(structured(&removed)["trashed"], false);
    assert!(!fixture.folder.join("kept.txt").exists());
    // A retry answers the recorded outcome and deletes nothing more.
    fixture.write("kept.txt", "again");
    let retried = fixture
        .call(
            "files_delete",
            json!({ "path": "kept.txt", "permanent": true, "clientRequestId": "delete-1" }),
        )
        .await;
    assert_eq!(structured(&retried)["trashed"], false);
    assert!(fixture.folder.join("kept.txt").exists());
    assert_eq!(fixture.trash.count.load(Ordering::SeqCst), 1);
    fixture.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlink_out_of_the_threads_folder_is_refused_by_every_tool() {
    let fixture = fixture().await;
    std::fs::write(fixture.outside.join("secret.txt"), "secret").unwrap();
    std::os::unix::fs::symlink(&fixture.outside, fixture.folder.join("escape")).unwrap();
    std::os::unix::fs::symlink(
        fixture.outside.join("secret.txt"),
        fixture.folder.join("leak.txt"),
    )
    .unwrap();
    // Through a symlinked folder: refused before any RPC.
    for (tool, arguments) in [
        ("files_read", json!({ "path": "escape/secret.txt" })),
        (
            "files_write",
            json!({ "path": "escape/new.txt", "content": "x", "createOnly": true }),
        ),
        (
            "files_create",
            json!({ "path": "escape/new", "kind": "file" }),
        ),
        (
            "files_rename",
            json!({ "from": "escape/secret.txt", "to": "mine.txt" }),
        ),
        (
            "files_rename",
            json!({ "from": "leak.txt", "to": "escape/moved.txt" }),
        ),
        (
            "files_delete",
            json!({ "path": "escape/secret.txt", "permanent": true }),
        ),
        ("files_download", json!({ "path": "escape/secret.txt" })),
        (
            "files_upload",
            json!({ "directory": "escape/inner", "fileName": "new.txt" }),
        ),
        ("files_read", json!({ "path": "../outside.txt" })),
        ("files_read", json!({ "path": "/etc/hosts" })),
    ] {
        let refused = fixture.call(tool, arguments.clone()).await;
        assert_eq!(
            error_tag(&refused),
            "McpInvalidArgumentError",
            "{tool} {arguments}"
        );
    }
    // A symlink that is itself the path, pointing out: the workspace refuses to follow it.
    for (tool, arguments) in [
        ("files_read", json!({ "path": "leak.txt" })),
        (
            "files_write",
            json!({ "path": "leak.txt", "content": "x", "expectedVersion": "0".repeat(64) }),
        ),
        ("files_download", json!({ "path": "leak.txt" })),
        ("files_download", json!({ "path": "escape" })),
        (
            "files_upload",
            json!({ "directory": "escape", "fileName": "new.txt" }),
        ),
    ] {
        let refused = fixture.call(tool, arguments.clone()).await;
        let failure = &refused["structuredContent"]["error"]["failure"];
        assert!(
            failure == "resolved_path_outside_root" || failure == "outside_root",
            "{tool}: {refused}"
        );
    }
    let refused = fixture
        .call(
            "files_upload",
            json!({ "directory": "", "fileName": "../x" }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpInvalidArgumentError");
    // A dangling symlink is never followed to create its target outside.
    std::os::unix::fs::symlink(
        fixture.outside.join("created.txt"),
        fixture.folder.join("dangling.txt"),
    )
    .unwrap();
    for arguments in [
        json!({ "path": "dangling.txt", "content": "x", "createOnly": true }),
        json!({ "path": "dangling.txt", "content": "x", "expectedVersion": "0".repeat(64) }),
    ] {
        let refused = fixture.call("files_write", arguments).await;
        assert_eq!(refused["isError"], true, "{refused}");
    }
    assert_eq!(
        std::fs::read_to_string(fixture.outside.join("secret.txt")).unwrap(),
        "secret"
    );
    assert_eq!(std::fs::read_dir(&fixture.outside).unwrap().count(), 1);
    fixture.shutdown().await;
}

#[tokio::test]
async fn transfer_urls_use_the_bound_address_and_an_upload_binds_overwrite() {
    let fixture = fixture().await;
    fixture.write("a.txt", "old");
    let minted = fixture
        .call("files_download", json!({ "path": "a.txt" }))
        .await;
    let minted = structured(&minted).clone();
    assert!(
        minted["url"]
            .as_str()
            .unwrap()
            .starts_with(&format!("{BASE}/api/transfers/")),
        "{minted}"
    );
    assert_eq!(minted["method"], "GET");
    assert_eq!(
        minted["transferId"],
        crate::transfer::transfer_id(minted["url"].as_str().unwrap()).as_str()
    );
    assert_eq!(
        fixture.download(&token_of(&minted["url"])).await.unwrap(),
        b"old"
    );

    // Minted without overwrite: `?overwrite=1` is refused and an existing file is kept.
    let token = fixture.upload_url("a.txt", false).await;
    assert_eq!(fixture.upload(&token, true, b"new").await, 400);
    assert_eq!(fixture.upload(&token, false, b"new").await, 409);
    assert_eq!(fixture.read("a.txt").as_deref(), Some("old"));
    // Minted with it: the upload replaces the file.
    let token = fixture.upload_url("a.txt", true).await;
    assert_eq!(fixture.upload(&token, false, b"new").await, 201);
    assert_eq!(fixture.read("a.txt").as_deref(), Some("new"));
    // A UI token keeps the query flag.
    let ui = fixture
        .access
        .issue_upload(&fixture.folder, "", "a.txt")
        .unwrap();
    assert_eq!(
        fixture
            .upload(&token_of(&json!(ui.relative_url)), true, b"ui")
            .await,
        201
    );
    assert_eq!(fixture.read("a.txt").as_deref(), Some("ui"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn an_agents_url_ends_with_its_access_and_a_ui_url_does_not() {
    let fixture = fixture().await;
    fixture.write("a.txt", "data");
    let ui_download = fixture
        .access
        .issue_download(&fixture.folder, "a.txt")
        .unwrap();
    let ui_download = token_of(&json!(ui_download.relative_url));

    // The off switch, then the Files set.
    let download = fixture.download_url("a.txt").await;
    let upload = fixture.upload_url("b.txt", false).await;
    fixture.settings(|settings| settings.enabled = false);
    assert_eq!(fixture.download(&download).await, Err(404));
    assert_eq!(fixture.upload(&upload, false, b"x").await, 404);
    assert_eq!(fixture.download(&ui_download).await.unwrap(), b"data");
    fixture.settings(|settings| settings.enabled = true);
    assert_eq!(fixture.download(&download).await.unwrap(), b"data");
    fixture.settings(|settings| settings.capabilities.files = false);
    assert_eq!(fixture.download(&download).await, Err(404));
    assert_eq!(fixture.upload(&upload, false, b"x").await, 404);
    fixture.settings(|settings| settings.capabilities.files = true);

    // Read-only refuses the upload and keeps the download.
    fixture.settings(|settings| settings.access = McpAccess::ReadOnly);
    assert_eq!(fixture.upload(&upload, false, b"x").await, 404);
    assert_eq!(fixture.download(&download).await.unwrap(), b"data");
    fixture.settings(|settings| settings.access = McpAccess::FullAccess);

    // Take over: the same, for this agent only.
    fixture
        .harness
        .auth
        .set_mcp_access(&fixture.agent.principal.session_id, "read-only")
        .await
        .unwrap();
    assert_eq!(fixture.upload(&upload, false, b"x").await, 404);
    assert_eq!(fixture.download(&download).await.unwrap(), b"data");
    fixture
        .harness
        .auth
        .set_mcp_access(&fixture.agent.principal.session_id, "approval-required")
        .await
        .unwrap();
    assert_eq!(fixture.upload(&upload, false, b"x").await, 201);
    assert_eq!(fixture.read("b.txt").as_deref(), Some("x"));

    // Revocation ends both, and never the UI's.
    fixture.revoke().await;
    assert_eq!(fixture.download(&download).await, Err(404));
    let upload_after = fixture.access.issue_upload_bound(
        &fixture.folder,
        "",
        "c.txt",
        1024,
        &crate::transfer::TransferBinding {
            mcp_session_id: Some(fixture.agent.principal.session_id.clone()),
            overwrite: Some(false),
        },
    );
    let upload_after = token_of(&json!(upload_after.unwrap().relative_url));
    assert_eq!(fixture.upload(&upload_after, false, b"x").await, 404);
    assert!(!fixture.folder.join("c.txt").exists());
    assert_eq!(fixture.download(&ui_download).await.unwrap(), b"data");
    fixture.shutdown().await;
}

#[tokio::test]
async fn revoking_during_an_upload_leaves_neither_the_target_nor_a_partial() {
    let fixture = fixture().await;
    let token = fixture.upload_url("big.bin", false).await;
    let (sender, receiver) =
        tokio::sync::mpsc::unbounded_channel::<Result<axum::body::Bytes, std::io::Error>>();
    sender
        .send(Ok(axum::body::Bytes::from_static(b"first half")))
        .unwrap();
    let body = Body::from_stream(tokio_stream::wrappers::UnboundedReceiverStream::new(
        receiver,
    ));
    let uploads = fixture.uploads();
    let upload = tokio::spawn(async move { uploads(token, None, false, body, context()).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    fixture.revoke().await;
    let result = tokio::time::timeout(Duration::from_secs(10), upload)
        .await
        .expect("the upload stops")
        .unwrap();
    assert_eq!(status(result), 404);
    drop(sender);
    let left: Vec<_> = std::fs::read_dir(&fixture.folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(left.is_empty(), "{left:?}");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_download_stream_stops_on_revocation_and_records_its_activity() {
    let fixture = fixture().await;
    fixture.write("large.bin", vec![7_u8; 8 * 1024 * 1024]);
    let token = fixture.download_url("large.bin").await;
    let Ok(TransferDownloadHttpOutcome::Stream(response)) =
        (fixture.downloads())(token.clone(), context()).await
    else {
        panic!("the download starts");
    };
    let mut stream = response.body.into_data_stream();
    assert!(stream.next().await.unwrap().is_ok());
    fixture.revoke().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut ended_with_error = false;
    let mut read = 0_usize;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => read += bytes.len(),
            Err(_) => {
                ended_with_error = true;
                break;
            }
        }
    }
    assert!(ended_with_error, "the stream broke off");
    assert!(read < 8 * 1024 * 1024);

    // The transfer's row names the transfer, never the path.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let rows = fixture.harness.control.activity().recent().await.unwrap();
    let row = rows
        .iter()
        .find(|row| row["tool"] == "files_download")
        .expect("a download row");
    assert_eq!(row["outcome"], "McpAccessEndedError");
    assert_eq!(
        row["target"]["transferId"],
        crate::transfer::transfer_id(&token).as_str()
    );
    assert!(!row.to_string().contains("large.bin"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn an_upload_records_its_mint_and_its_finish_with_one_transfer_id() {
    let fixture = fixture().await;
    let minted = fixture
        .call(
            "files_upload",
            json!({ "directory": ".", "fileName": "up.txt" }),
        )
        .await;
    let minted = structured(&minted).clone();
    assert_eq!(minted["method"], "POST");
    let token = token_of(&minted["url"]);
    assert_eq!(fixture.upload(&token, false, b"hello").await, 201);
    assert_eq!(fixture.read("up.txt").as_deref(), Some("hello"));
    tokio::time::sleep(Duration::from_millis(50)).await;
    let rows = fixture.harness.control.activity().recent().await.unwrap();
    let uploads: Vec<_> = rows
        .iter()
        .filter(|row| row["tool"] == "files_upload")
        .collect();
    assert_eq!(uploads.len(), 2, "{rows:?}");
    for row in &uploads {
        assert_eq!(row["outcome"], "success");
        assert_eq!(row["target"]["transferId"], minted["transferId"]);
        assert!(!row.to_string().contains("up.txt"));
    }
    fixture.shutdown().await;
}
