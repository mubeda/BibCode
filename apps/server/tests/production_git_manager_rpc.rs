use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::Arc,
    time::Duration,
};

use base64::Engine;
use bibcode_server::{
    RequestId, RpcRequest,
    git::{GitRepository, MAX_DIFF_BUFFER_SIZE, NativeFileTrash, StatusBroadcaster},
    persistence::{Database, ProjectionProject, Repositories, run_migrations},
    production::git_manager_rpc::{ConfiguredGitManagerRpcServices, GitManagerRpcServices},
    worktree_catalog::{WorkspaceAvailabilityRegistry, WorktreeCatalogService},
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

struct Fixture {
    _root: TempDir,
    repository_path: PathBuf,
    remote_path: PathBuf,
    services: ConfiguredGitManagerRpcServices,
}

#[test]
fn phase_13_history_rewrite_sources_do_not_log_repository_operands() {
    let operations = include_str!("../src/git/manager/operations.rs");
    let operation_section = operations
        .split_once("pub async fn run_branch_or_sync_operation")
        .expect("operation section starts")
        .1
        .split_once("fn validate_merge_source")
        .expect("operation section ends")
        .0;
    let repository = include_str!("../src/git/repository.rs");
    let repository_section = repository
        .split_once("pub(crate) async fn git_manager_rebase")
        .expect("rewrite repository section starts")
        .1
        .split_once("pub async fn switch_ref")
        .expect("rewrite repository section ends")
        .0;
    for source in [
        include_str!("../src/git/manager/rewrite.rs"),
        include_str!("../src/git/manager/conflicts.rs"),
        operation_section,
        repository_section,
    ] {
        assert!(!source.contains("tracing::"));
    }
}

impl Fixture {
    async fn new() -> Self {
        let root = TempDir::new().expect("temporary Git Manager fixture");
        let repository_path = root.path().join("main");
        let remote_path = root.path().join("remote.git");
        fs::create_dir(&repository_path).expect("main checkout directory");
        git(root.path(), &["init", "-q", "--bare", path(&remote_path)]);
        git(&repository_path, &["init", "-q", "-b", "main"]);
        git(&repository_path, &["config", "core.autocrlf", "false"]);
        configure_identity(&repository_path);
        fs::write(repository_path.join("tracked.txt"), "base\n").expect("base file");
        git(&repository_path, &["add", "tracked.txt"]);
        git(&repository_path, &["commit", "-q", "-m", "base"]);
        git(
            &repository_path,
            &["remote", "add", "origin", path(&remote_path)],
        );
        git(&repository_path, &["push", "-q", "-u", "origin", "main"]);

        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let repositories = Repositories::new(database);
        repositories
            .upsert_project(ProjectionProject {
                project_id: "project-1".to_owned(),
                title: "Git Manager Operations".to_owned(),
                workspace_root: repository_path.to_string_lossy().into_owned(),
                default_model_selection: None,
                scripts: json!([]),
                worktree_discovery: json!({}),
                worktree_repository_key: None,
                created_at: "2026-09-01T00:00:00Z".to_owned(),
                updated_at: "2026-09-01T00:00:00Z".to_owned(),
                deleted_at: None,
            })
            .await
            .expect("project projection");
        let repository = Arc::new(GitRepository::default());
        let (remote_refresh_interval, _) = tokio::sync::watch::channel(Duration::from_millis(50));
        let broadcaster = StatusBroadcaster::with_automatic_remote_refresh_interval(
            repository.clone(),
            Duration::from_secs(3_600),
            remote_refresh_interval,
            8,
        );
        let availability = WorkspaceAvailabilityRegistry::new();
        let catalog = WorktreeCatalogService::new_with_availability_registry(
            Arc::new(repositories.clone()),
            repository.clone(),
            availability.clone(),
        );
        let services = GitManagerRpcServices::with_dependencies(
            repository,
            broadcaster.clone(),
            catalog,
            repositories,
            availability,
            Arc::new(NativeFileTrash::default()),
        );
        Self {
            _root: root,
            repository_path,
            remote_path,
            services,
        }
    }

    fn operation(&self, id: &str, payload: Value) -> mpsc::Receiver<Result<Vec<Value>, Value>> {
        self.services.operation_stream(
            RpcRequest {
                id: RequestId::try_from(id).expect("request id"),
                tag: "gitManager.runOperation".to_owned(),
                payload,
                headers: Vec::new(),
                trace_id: None,
                span_id: None,
                sampled: None,
            },
            CancellationToken::new(),
        )
    }

    async fn read(&self, id: &str, tag: &str, payload: Value) -> Result<Value, Value> {
        self.services
            .read_unary(rpc_request(id, tag, payload), CancellationToken::new())
            .await
    }

    async fn mutate(&self, id: &str, tag: &str, payload: Value) -> Result<Value, Value> {
        self.services
            .mutation_unary(rpc_request(id, tag, payload), CancellationToken::new())
            .await
    }
}

#[tokio::test]
async fn commit_image_diff_round_trips_both_binary_blobs_byte_for_byte() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    let before = b"\x89PNG\r\n\x1a\n\0\xff\xfe\x80before".to_vec();
    let after = b"\x89PNG\r\n\x1a\n\0\xff\xfe\x80after".to_vec();
    fs::write(cwd.join("image.png"), &before).expect("before image");
    git(&cwd, &["add", "image.png"]);
    git(&cwd, &["commit", "-q", "-m", "image before"]);
    fs::write(cwd.join("image.png"), &after).expect("after image");
    git(&cwd, &["commit", "-qam", "image after"]);
    let sha = git_stdout(&cwd, &["rev-parse", "HEAD"]);

    let diff = fixture
        .read(
            "90",
            "gitManager.getDiff",
            json!({
                "cwd": cwd,
                "source": { "_tag": "commit", "sha": sha, "path": "image.png" }
            }),
        )
        .await
        .expect("image diff");

    assert_eq!(diff["_tag"], "image");
    assert_eq!(diff["before"]["mimeType"], "image/png");
    assert_eq!(diff["after"]["mimeType"], "image/png");
    let decode = |value: &Value| {
        base64::engine::general_purpose::STANDARD
            .decode(value.as_str().expect("base64 image side"))
            .expect("valid base64 image side")
    };
    assert_eq!(decode(&diff["before"]["contentBase64"]), before);
    assert_eq!(decode(&diff["after"]["contentBase64"]), after);
}

#[tokio::test]
async fn added_image_diff_has_one_side_and_an_oversized_blob_is_unrenderable() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    let added = b"\x89PNG\r\n\x1a\nadded".to_vec();
    fs::write(cwd.join("added.png"), &added).expect("added image");
    git(&cwd, &["add", "added.png"]);
    git(&cwd, &["commit", "-q", "-m", "add image"]);
    let sha = git_stdout(&cwd, &["rev-parse", "HEAD"]);

    let diff = fixture
        .read(
            "91",
            "gitManager.getDiff",
            json!({
                "cwd": cwd,
                "source": { "_tag": "commit", "sha": sha, "path": "added.png" }
            }),
        )
        .await
        .expect("added image diff");
    assert_eq!(diff["_tag"], "image");
    assert!(diff["before"]["contentBase64"].is_null());
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(
                diff["after"]["contentBase64"]
                    .as_str()
                    .expect("after image")
            )
            .expect("base64 after image"),
        added
    );

    fs::write(
        cwd.join("oversized.png"),
        vec![0xa5; MAX_DIFF_BUFFER_SIZE + 1],
    )
    .expect("oversized image");
    git(&cwd, &["add", "oversized.png"]);
    git(&cwd, &["commit", "-q", "-m", "oversized image"]);
    let oversized_sha = git_stdout(&cwd, &["rev-parse", "HEAD"]);
    let oversized = fixture
        .read(
            "92",
            "gitManager.getDiff",
            json!({
                "cwd": cwd,
                "source": {
                    "_tag": "commit",
                    "sha": oversized_sha,
                    "path": "oversized.png"
                }
            }),
        )
        .await
        .expect("oversized image result");
    assert_eq!(oversized["_tag"], "unrenderable");
    assert_eq!(oversized["byteLength"], MAX_DIFF_BUFFER_SIZE + 1);
}

#[tokio::test]
async fn tag_create_push_and_delete_share_the_streaming_mutation_fence() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    let sha = git_stdout(&cwd, &["rev-parse", "HEAD"]);

    let created = collect_events(fixture.operation(
        "93",
        json!({
            "_tag": "tag-create",
            "cwd": cwd,
            "projectId": "project-1",
            "name": "release/v1",
            "sha": sha
        }),
    ))
    .await;
    assert_eq!(event_kinds(&created).last(), Some(&"finished"));
    let refs = fixture
        .read("94", "gitManager.getRefs", json!({ "cwd": cwd }))
        .await
        .expect("refs after tag create");
    assert!(
        refs["tags"]
            .as_array()
            .is_some_and(|tags| tags.iter().any(|tag| tag["name"] == "release/v1"))
    );

    let pushed = collect_events(fixture.operation(
        "95",
        json!({
            "_tag": "tag-push",
            "cwd": cwd,
            "projectId": "project-1",
            "name": "release/v1",
            "remote": "origin"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&pushed).last(), Some(&"finished"));
    assert!(
        git_output(
            &cwd,
            &["ls-remote", "--exit-code", "origin", "refs/tags/release/v1"]
        )
        .status
        .success()
    );

    let deleted = collect_events(fixture.operation(
        "96",
        json!({
            "_tag": "tag-delete",
            "cwd": cwd,
            "projectId": "project-1",
            "name": "release/v1"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&deleted).last(), Some(&"finished"));
    assert!(
        !git_output(&cwd, &["show-ref", "--verify", "refs/tags/release/v1"])
            .status
            .success()
    );
    assert!(
        git_output(
            &cwd,
            &["ls-remote", "--exit-code", "origin", "refs/tags/release/v1"]
        )
        .status
        .success(),
        "local deletion must not delete the remote tag"
    );

    let missing = collect_events(fixture.operation(
        "97",
        json!({
            "_tag": "tag-delete",
            "cwd": cwd,
            "projectId": "project-1",
            "name": "release/v1"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&missing), ["started", "failed"]);
    assert_eq!(missing[1]["code"], "tag-not-found");
}

/// A GitHub CLI stub that resolves pull request 42 for `pr list` and answers the
/// rollup read with `checks_stdout` (or fails it with `checks_exit`), recording
/// every argv line into `calls`.
#[cfg(unix)]
struct GitHubProviderStub {
    calls: PathBuf,
    services: ConfiguredGitManagerRpcServices,
}

#[cfg(unix)]
impl GitHubProviderStub {
    fn install(fixture: &Fixture, checks_stdout: &str, checks_exit: u8) -> Self {
        use bibcode_server::source_control::PullRequestService;

        git(
            &fixture.repository_path,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/example/repository.git",
            ],
        );
        let calls = fixture._root.path().join("provider-calls");
        let command = fixture._root.path().join("provider-gh");
        fs::write(
            &command,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\ncase \"$1:$2\" in\n  pr:list) printf '%s\\n' '[{{\"number\":42,\"title\":\"Explicit PR\",\"url\":\"https://github.test/42\",\"baseRefName\":\"main\",\"headRefName\":\"main\",\"state\":\"OPEN\"}}]' ;;\n  pr:view) printf '%s\\n' '{checks_stdout}'; exit {checks_exit} ;;\n  *) exit 64 ;;\nesac\n",
                calls.to_string_lossy()
            ),
        )
        .expect("provider fixture");
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&command, fs::Permissions::from_mode(0o755))
            .expect("provider fixture executable");
        let services = fixture.services.clone().with_pull_request_service(
            PullRequestService::with_provider_commands(
                command.to_string_lossy(),
                "unused-glab",
                "unused-az",
            ),
        );
        Self { calls, services }
    }

    async fn list_pull_requests(&self, cwd: &Path) -> Result<Value, Value> {
        self.services
            .read_unary(
                rpc_request("98", "gitManager.listPullRequests", json!({ "cwd": cwd })),
                CancellationToken::new(),
            )
            .await
    }

    fn calls(&self) -> String {
        fs::read_to_string(&self.calls).expect("provider calls")
    }
}

#[cfg(unix)]
#[tokio::test]
async fn explicit_pull_request_read_invokes_the_provider_once_for_prs_and_once_for_checks() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    let stub = GitHubProviderStub::install(
        &fixture,
        r#"{"statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-09-02T13:09:09Z","conclusion":"SUCCESS","detailsUrl":"https://github.test/check/1","name":"build","startedAt":"2026-09-02T12:52:36Z","status":"COMPLETED","workflowName":"CI"}]}"#,
        0,
    );

    let result = stub
        .list_pull_requests(&cwd)
        .await
        .expect("explicit provider read");

    assert_eq!(result["status"], "available");
    assert_eq!(result["pullRequests"][0]["number"], 42);
    assert_eq!(
        result["checks"],
        json!([{
            "name": "build",
            "state": "SUCCESS",
            "link": "https://github.test/check/1",
            "workflow": "CI",
        }])
    );
    let calls = stub.calls();
    assert_eq!(calls.lines().count(), 2);
    assert!(calls.contains("pr list --head main --state open --limit 1 --json"));
    assert!(calls.contains("pr view 42 --json statusCheckRollup"));
    assert!(!calls.contains("pr checks"));
    assert!(!calls.contains("--watch"));
}

#[cfg(unix)]
#[tokio::test]
async fn explicit_pull_request_read_renders_an_open_pull_request_that_has_no_checks() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    let stub = GitHubProviderStub::install(&fixture, r#"{"statusCheckRollup":[]}"#, 0);

    let result = stub
        .list_pull_requests(&cwd)
        .await
        .expect("a pull request without checks is not a provider failure");

    assert_eq!(result["status"], "available");
    assert_eq!(result["pullRequests"][0]["number"], 42);
    assert_eq!(result["checks"], json!([]));
    assert_eq!(stub.calls().lines().count(), 2);
}

#[cfg(unix)]
#[tokio::test]
async fn explicit_pull_request_read_keeps_pending_checks_available() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    let stub = GitHubProviderStub::install(
        &fixture,
        r#"{"statusCheckRollup":[{"__typename":"CheckRun","conclusion":null,"detailsUrl":"https://github.test/check/2","name":"build","startedAt":"2026-09-02T12:52:36Z","status":"IN_PROGRESS","workflowName":"CI"},{"__typename":"StatusContext","context":"ci/external","state":"PENDING","targetUrl":"https://external.test/1"}]}"#,
        0,
    );

    let result = stub
        .list_pull_requests(&cwd)
        .await
        .expect("pending checks remain readable");

    assert_eq!(result["status"], "available");
    assert_eq!(
        result["checks"],
        json!([
            {
                "name": "build",
                "state": "IN_PROGRESS",
                "link": "https://github.test/check/2",
                "workflow": "CI",
            },
            {
                "name": "ci/external",
                "state": "PENDING",
                "link": "https://external.test/1",
                "workflow": null,
            },
        ])
    );
}

#[cfg(unix)]
#[tokio::test]
async fn explicit_pull_request_read_reports_a_genuine_check_command_failure() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    let stub = GitHubProviderStub::install(&fixture, "HTTP 401: Bad credentials", 1);

    let error = stub
        .list_pull_requests(&cwd)
        .await
        .expect_err("a failing provider command is surfaced, not rendered as no checks");

    assert_eq!(error["code"], "provider-command-failed");
    assert_eq!(
        error["message"],
        "The source-control provider could not load pull-request checks."
    );
    assert_eq!(stub.calls().lines().count(), 2);
}

#[tokio::test]
async fn partial_stage_unstage_and_discard_mutate_only_their_intended_store() {
    let fixture = Fixture::new().await;
    let path = fixture.repository_path.join("tracked.txt");
    fs::write(&path, "base\none\ntwo\nthree\nfour\n").expect("four-line working change");

    let unstaged = fixture
        .read(
            "50",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "tracked.txt", "staged": false }
            }),
        )
        .await
        .expect("unstaged diff");
    fixture
        .mutate(
            "51",
            "gitManager.stagePartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "tracked.txt",
                "selectedLines": [1, 3],
                "baseGeneration": unstaged["generation"]
            }),
        )
        .await
        .expect("partial stage");

    assert_eq!(
        index_content(&fixture.repository_path),
        "base\none\nthree\n"
    );
    assert_eq!(
        fs::read(&path).expect("working bytes after stage"),
        b"base\none\ntwo\nthree\nfour\n"
    );

    let staged = fixture
        .read(
            "52",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "tracked.txt", "staged": true }
            }),
        )
        .await
        .expect("staged diff");
    let before_unstage = fs::read(&path).expect("working bytes before unstage");
    fixture
        .mutate(
            "53",
            "gitManager.unstagePartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "tracked.txt",
                "selectedLines": [1],
                "baseGeneration": staged["generation"]
            }),
        )
        .await
        .expect("partial unstage");

    assert_eq!(index_content(&fixture.repository_path), "base\nthree\n");
    assert_eq!(
        fs::read(&path).expect("working bytes after unstage"),
        before_unstage,
        "unstaging must leave the working tree byte-for-byte unchanged"
    );

    let before_discard_index = index_content(&fixture.repository_path);
    let unstaged = fixture
        .read(
            "54",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "tracked.txt", "staged": false }
            }),
        )
        .await
        .expect("remaining unstaged diff");
    fixture
        .mutate(
            "55",
            "gitManager.discardPartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "tracked.txt",
                "selectedLines": [2],
                "baseGeneration": unstaged["generation"]
            }),
        )
        .await
        .expect("partial discard");

    assert_eq!(
        fs::read_to_string(&path).expect("working content after discard"),
        "base\none\nthree\nfour\n"
    );
    assert_eq!(
        index_content(&fixture.repository_path),
        before_discard_index,
        "discarding must leave the index unchanged"
    );
}

#[tokio::test]
async fn stale_partial_requests_fail_closed_for_stage_unstage_and_discard() {
    let fixture = Fixture::new().await;
    let path = fixture.repository_path.join("tracked.txt");

    fs::write(&path, "base\none\ntwo\n").expect("unstaged additions");
    let stage_diff = fixture
        .read(
            "60",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "tracked.txt", "staged": false }
            }),
        )
        .await
        .expect("stage source diff");
    fs::write(&path, "base\none\ntwo\nthree\n").expect("rewrite after stage selection");
    let stale_stage = fixture
        .mutate(
            "61",
            "gitManager.stagePartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "tracked.txt",
                "selectedLines": [1],
                "baseGeneration": stage_diff["generation"]
            }),
        )
        .await
        .expect_err("stale stage selection");
    assert_eq!(stale_stage["code"], "stale-selection");
    assert_eq!(index_content(&fixture.repository_path), "base\n");

    git(&fixture.repository_path, &["add", "tracked.txt"]);
    let unstage_diff = fixture
        .read(
            "62",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "tracked.txt", "staged": true }
            }),
        )
        .await
        .expect("unstage source diff");
    git(&fixture.repository_path, &["reset", "--", "tracked.txt"]);
    let before_unstage = fs::read(&path).expect("working bytes before stale unstage");
    let stale_unstage = fixture
        .mutate(
            "63",
            "gitManager.unstagePartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "tracked.txt",
                "selectedLines": [1],
                "baseGeneration": unstage_diff["generation"]
            }),
        )
        .await
        .expect_err("stale unstage selection");
    assert_eq!(stale_unstage["code"], "stale-selection");
    assert_eq!(index_content(&fixture.repository_path), "base\n");
    assert_eq!(
        fs::read(&path).expect("bytes after stale unstage"),
        before_unstage
    );

    let discard_diff = fixture
        .read(
            "64",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "tracked.txt", "staged": false }
            }),
        )
        .await
        .expect("discard source diff");
    fs::write(&path, "base\none\ntwo\nthree\nfour\n").expect("rewrite after discard selection");
    let before_discard = fs::read(&path).expect("bytes before stale discard");
    let stale_discard = fixture
        .mutate(
            "65",
            "gitManager.discardPartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "tracked.txt",
                "selectedLines": [1],
                "baseGeneration": discard_diff["generation"]
            }),
        )
        .await
        .expect_err("stale discard selection");
    assert_eq!(stale_discard["code"], "stale-selection");
    assert_eq!(
        fs::read(&path).expect("bytes after stale discard"),
        before_discard
    );
    assert_eq!(index_content(&fixture.repository_path), "base\n");
}

#[tokio::test]
async fn untracked_partial_selection_round_trips_through_intent_to_add() {
    let fixture = Fixture::new().await;
    let path = fixture.repository_path.join("new.txt");
    fs::write(&path, "one\ntwo\nthree\nfour\n").expect("untracked content");

    let unstaged = fixture
        .read(
            "70",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "new.txt", "staged": false }
            }),
        )
        .await
        .expect("untracked diff");
    fixture
        .mutate(
            "71",
            "gitManager.stagePartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "new.txt",
                "selectedLines": [0, 2],
                "baseGeneration": unstaged["generation"]
            }),
        )
        .await
        .expect("partial stage of untracked file");
    assert_eq!(
        index_file_content(&fixture.repository_path, "new.txt"),
        "one\nthree\n"
    );
    assert_eq!(
        fs::read_to_string(&path).expect("untracked working content"),
        "one\ntwo\nthree\nfour\n"
    );

    let staged = fixture
        .read(
            "72",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "new.txt", "staged": true }
            }),
        )
        .await
        .expect("staged new-file diff");
    fixture
        .mutate(
            "73",
            "gitManager.unstagePartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "new.txt",
                "selectedLines": [0],
                "baseGeneration": staged["generation"]
            }),
        )
        .await
        .expect("partial unstage of new file");
    assert_eq!(
        index_file_content(&fixture.repository_path, "new.txt"),
        "three\n"
    );

    let index_before_discard = index_file_content(&fixture.repository_path, "new.txt");
    let unstaged = fixture
        .read(
            "74",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "new.txt", "staged": false }
            }),
        )
        .await
        .expect("remaining new-file diff");
    fixture
        .mutate(
            "75",
            "gitManager.discardPartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "new.txt",
                "selectedLines": [1],
                "baseGeneration": unstaged["generation"]
            }),
        )
        .await
        .expect("partial discard of new file");
    assert_eq!(
        fs::read_to_string(&path).expect("working content after discard"),
        "one\nthree\nfour\n"
    );
    assert_eq!(
        index_file_content(&fixture.repository_path, "new.txt"),
        index_before_discard
    );
}

#[tokio::test]
async fn partial_operations_preserve_no_trailing_newline_markers() {
    let fixture = Fixture::new().await;
    let path = fixture.repository_path.join("tracked.txt");
    fs::write(&path, b"").expect("empty tracked file");
    git(&fixture.repository_path, &["add", "tracked.txt"]);
    git(
        &fixture.repository_path,
        &["commit", "-q", "-m", "empty tracked file"],
    );
    fs::write(&path, b"one\ntwo").expect("working content without trailing newline");

    let unstaged = fixture
        .read(
            "80",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "tracked.txt", "staged": false }
            }),
        )
        .await
        .expect("no-newline unstaged diff");
    fixture
        .mutate(
            "81",
            "gitManager.stagePartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "tracked.txt",
                "selectedLines": [1],
                "baseGeneration": unstaged["generation"]
            }),
        )
        .await
        .expect("stage no-newline line");
    assert_eq!(index_content(&fixture.repository_path).as_bytes(), b"two");
    assert_eq!(
        fs::read(&path).expect("working bytes after stage"),
        b"one\ntwo"
    );

    let staged = fixture
        .read(
            "82",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "tracked.txt", "staged": true }
            }),
        )
        .await
        .expect("no-newline staged diff");
    let before_unstage = fs::read(&path).expect("working bytes before no-newline unstage");
    fixture
        .mutate(
            "83",
            "gitManager.unstagePartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "tracked.txt",
                "selectedLines": [0],
                "baseGeneration": staged["generation"]
            }),
        )
        .await
        .expect("unstage no-newline line");
    assert_eq!(index_content(&fixture.repository_path), "");
    assert_eq!(
        fs::read(&path).expect("working bytes after unstage"),
        before_unstage
    );

    let unstaged = fixture
        .read(
            "84",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "working-tree", "path": "tracked.txt", "staged": false }
            }),
        )
        .await
        .expect("no-newline discard diff");
    fixture
        .mutate(
            "85",
            "gitManager.discardPartial",
            json!({
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "path": "tracked.txt",
                "selectedLines": [1],
                "baseGeneration": unstaged["generation"]
            }),
        )
        .await
        .expect("discard no-newline line");
    assert_eq!(
        fs::read(&path).expect("working bytes after discard"),
        b"one\n"
    );
    assert_eq!(index_content(&fixture.repository_path), "");
}

#[tokio::test]
async fn stash_listing_and_diff_use_the_full_native_list_and_stable_sha() {
    let fixture = Fixture::new().await;
    let linked = fixture._root.path().join("stash-linked");
    git(
        &fixture.repository_path,
        &["worktree", "add", "-q", "-b", "stash-linked", path(&linked)],
    );
    fs::write(linked.join("tracked.txt"), "first stash\n").expect("first stash content");
    git(
        &linked,
        &["stash", "push", "-q", "-m", "agent-created stash"],
    );
    let first_sha = String::from_utf8(
        git_output(&fixture.repository_path, &["rev-parse", "refs/stash"]).stdout,
    )
    .expect("UTF-8 stash sha")
    .trim()
    .to_owned();
    fs::write(linked.join("tracked.txt"), "second stash\n").expect("second stash content");
    git(
        &linked,
        &["stash", "push", "-q", "-m", "user-created stash"],
    );

    let stashes = fixture
        .read(
            "30",
            "gitManager.getStashes",
            json!({ "cwd": fixture.repository_path }),
        )
        .await
        .expect("stash list");

    let stashes = stashes.as_array().expect("stash array");
    assert_eq!(stashes.len(), 2);
    assert_eq!(stashes[0]["message"], "On stash-linked: user-created stash");
    assert!(stashes.iter().any(|stash| stash["sha"] == first_sha));
    assert!(stashes.iter().all(|stash| stash["files"].is_array()));

    let diff = fixture
        .read(
            "31",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "stash", "sha": first_sha, "path": "tracked.txt" }
            }),
        )
        .await
        .expect("stable-SHA stash diff");
    assert_eq!(diff["_tag"], "patch");
    assert!(
        diff["patch"]
            .as_str()
            .is_some_and(|patch| patch.contains("first stash"))
    );

    git(&fixture.repository_path, &["stash", "drop", "stash@{1}"]);
    let missing = fixture
        .read(
            "32",
            "gitManager.getDiff",
            json!({
                "cwd": fixture.repository_path,
                "source": { "_tag": "stash", "sha": first_sha, "path": "tracked.txt" }
            }),
        )
        .await
        .expect_err("dropped stash fails structurally");
    assert_eq!(missing["code"], "stash-not-found");
}

#[tokio::test]
async fn merge_preview_reports_clean_ahead_and_behind_state() {
    let fixture = Fixture::new().await;
    git(&fixture.repository_path, &["switch", "-q", "-c", "feature"]);
    fs::write(fixture.repository_path.join("feature.txt"), "feature\n").expect("feature file");
    git(&fixture.repository_path, &["add", "feature.txt"]);
    git(&fixture.repository_path, &["commit", "-q", "-m", "feature"]);
    git(&fixture.repository_path, &["switch", "-q", "main"]);

    let preview = fixture
        .read(
            "33",
            "gitManager.previewMerge",
            json!({ "cwd": fixture.repository_path, "source": "feature" }),
        )
        .await
        .expect("merge preview");

    assert_eq!(preview["_tag"], "clean");
    assert_eq!(preview["source"], "feature");
    assert_eq!(preview["current"], "main");
    assert_eq!(preview["ahead"], 1);
    assert_eq!(preview["behind"], 0);
}

#[tokio::test]
async fn refs_detect_an_external_merge_inside_a_linked_worktree() {
    let fixture = Fixture::new().await;
    let linked = fixture._root.path().join("linked");
    git(&fixture.repository_path, &["switch", "-q", "-c", "feature"]);
    fs::write(fixture.repository_path.join("tracked.txt"), "feature\n").expect("feature content");
    git(&fixture.repository_path, &["commit", "-qam", "feature"]);
    git(&fixture.repository_path, &["switch", "-q", "main"]);
    git(&fixture.repository_path, &["branch", "linked"]);
    git(
        &fixture.repository_path,
        &["worktree", "add", "-q", path(&linked), "linked"],
    );
    configure_identity(&linked);
    fs::write(linked.join("tracked.txt"), "linked\n").expect("linked content");
    git(&linked, &["commit", "-qam", "linked"]);
    assert!(!git_output(&linked, &["merge", "feature"]).status.success());

    let refs = fixture
        .read("35", "gitManager.getRefs", json!({ "cwd": linked }))
        .await
        .expect("refs snapshot");

    assert_eq!(refs["inProgressOperation"]["kind"], "merge");
}

#[tokio::test]
async fn git_manager_signal_generation_bumps_after_an_external_commit() {
    let fixture = Fixture::new().await;
    let linked = fixture._root.path().join("signal-linked");
    git(
        &fixture.repository_path,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "signal-linked",
            path(&linked),
        ],
    );
    configure_identity(&linked);
    let cancellation = CancellationToken::new();
    let mut stream = fixture.services.git_manager_signal_stream(
        rpc_request("34", "subscribeGitManagerSignal", json!({ "cwd": linked })),
        cancellation.clone(),
    );
    let initial = next_event(&mut stream).await;
    let first = next_generation_after(&mut stream, initial["generation"].as_u64().unwrap()).await;

    fs::write(linked.join("external.txt"), "external\n").expect("external file");
    git(&linked, &["add", "external.txt"]);
    git(&linked, &["commit", "-q", "-m", "external"]);
    let second = next_generation_after(&mut stream, first).await;

    assert!(second > first);
    cancellation.cancel();
}

#[tokio::test]
async fn fetch_stream_orders_started_output_and_finished_events() {
    let fixture = Fixture::new().await;
    publish_remote_change(&fixture.remote_path, fixture._root.path());

    let events = collect_events(fixture.operation(
        "1",
        json!({
            "_tag": "fetch",
            "cwd": fixture.repository_path,
            "projectId": "project-1",
            "remote": "origin"
        }),
    ))
    .await;

    let kinds = events
        .iter()
        .map(|event| event["_tag"].as_str().expect("event tag"))
        .collect::<Vec<_>>();
    assert_eq!(kinds.first(), Some(&"started"));
    assert!(kinds[1..kinds.len() - 1].contains(&"output"), "{events:?}");
    assert_eq!(kinds.last(), Some(&"finished"));
    assert!(events.iter().all(|event| event["operation"] == "fetch"));
}

#[tokio::test]
async fn stale_missing_worktree_delete_emits_a_structured_blocked_failure_without_deleting() {
    let fixture = Fixture::new().await;
    let topic_path = fixture._root.path().join("topic-worktree");
    git(&fixture.repository_path, &["branch", "topic"]);
    git(
        &fixture.repository_path,
        &["worktree", "add", "-q", path(&topic_path), "topic"],
    );
    fs::remove_dir_all(&topic_path).expect("remove only the temporary worktree directory");

    let events = collect_events(fixture.operation(
        "2",
        json!({
            "_tag": "branch-delete",
            "cwd": fixture.repository_path,
            "projectId": "project-1",
            "name": "topic",
            "force": true,
            "deleteRemote": false
        }),
    ))
    .await;

    assert_eq!(event_kinds(&events), ["started", "failed"]);
    let failed = &events[1];
    assert_eq!(failed["code"], "worktree-checked-out");
    assert_eq!(failed["blocked"]["operation"], "delete-branch");
    assert_eq!(failed["blocked"]["code"], "worktree-checked-out");
    assert!(
        failed["message"]
            .as_str()
            .is_some_and(|message| message.contains("remove or prune the worktree first"))
    );
    assert!(
        !failed["message"]
            .as_str()
            .unwrap()
            .contains("cannot delete branch")
    );
    assert!(
        git_output(
            &fixture.repository_path,
            &["show-ref", "--verify", "refs/heads/topic"]
        )
        .status
        .success()
    );
}

#[tokio::test]
async fn branch_and_sync_operations_execute_through_the_streaming_adapter() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();

    for (id, payload) in [
        (
            "10",
            json!({
                "_tag": "branch-create", "cwd": cwd, "projectId": "project-1",
                "name": "topic", "startPoint": "main", "checkout": false
            }),
        ),
        (
            "11",
            json!({
                "_tag": "branch-checkout", "cwd": cwd, "projectId": "project-1",
                "name": "topic", "strategy": "bring"
            }),
        ),
        (
            "12",
            json!({
                "_tag": "branch-rename", "cwd": cwd, "projectId": "project-1",
                "name": "topic", "newName": "renamed"
            }),
        ),
        (
            "13",
            json!({
                "_tag": "branch-checkout", "cwd": cwd, "projectId": "project-1",
                "name": "main", "strategy": null
            }),
        ),
        (
            "14",
            json!({
                "_tag": "branch-delete", "cwd": cwd, "projectId": "project-1",
                "name": "renamed", "force": false, "deleteRemote": false
            }),
        ),
        (
            "15",
            json!({
                "_tag": "branch-create", "cwd": cwd, "projectId": "project-1",
                "name": "publishme", "startPoint": "main", "checkout": true
            }),
        ),
        (
            "16",
            json!({
                "_tag": "publish-branch", "cwd": cwd, "projectId": "project-1",
                "remote": "origin", "localBranch": "publishme", "remoteBranch": "published"
            }),
        ),
        (
            "17",
            json!({
                "_tag": "push", "cwd": cwd, "projectId": "project-1",
                "remote": "origin", "localBranch": "publishme", "remoteBranch": "published"
            }),
        ),
        (
            "18",
            json!({
                "_tag": "force-push", "cwd": cwd, "projectId": "project-1",
                "remote": "origin", "localBranch": "publishme", "remoteBranch": "published"
            }),
        ),
        (
            "19",
            json!({
                "_tag": "pull", "cwd": cwd, "projectId": "project-1", "remote": "origin"
            }),
        ),
        (
            "20",
            json!({
                "_tag": "branch-checkout", "cwd": cwd, "projectId": "project-1",
                "name": "main", "strategy": null
            }),
        ),
        (
            "21",
            json!({
                "_tag": "branch-delete", "cwd": cwd, "projectId": "project-1",
                "name": "publishme", "force": false, "deleteRemote": true
            }),
        ),
    ] {
        let events = collect_events(fixture.operation(id, payload)).await;
        assert_eq!(
            events.first().and_then(|event| event["_tag"].as_str()),
            Some("started")
        );
        assert_eq!(
            events.last().and_then(|event| event["_tag"].as_str()),
            Some("finished"),
            "operation {id} failed: {events:?}"
        );
    }

    assert!(
        !git_output(&cwd, &["show-ref", "--verify", "refs/heads/renamed"])
            .status
            .success()
    );
    assert!(
        !git_output(&cwd, &["show-ref", "--verify", "refs/heads/publishme"])
            .status
            .success()
    );
    assert!(
        !git_output(
            &cwd,
            &["ls-remote", "--exit-code", "origin", "refs/heads/published"]
        )
        .status
        .success()
    );
}

#[tokio::test]
async fn stash_and_merge_operations_execute_through_the_existing_mutation_path() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    fs::write(cwd.join("tracked.txt"), "saved change\n").expect("stash content");
    fs::write(cwd.join("untracked.txt"), "untracked\n").expect("untracked content");

    let pushed = collect_events(fixture.operation(
        "40",
        json!({
            "_tag": "stash-push", "cwd": cwd, "projectId": "project-1",
            "message": "save visible work", "paths": ["untracked.txt"]
        }),
    ))
    .await;
    assert_eq!(
        pushed.last().and_then(|event| event["_tag"].as_str()),
        Some("finished")
    );
    assert!(!cwd.join("untracked.txt").exists());

    let applied = collect_events(fixture.operation(
        "41",
        json!({
            "_tag": "stash-apply", "cwd": cwd, "projectId": "project-1", "index": 0
        }),
    ))
    .await;
    assert_eq!(
        applied.last().and_then(|event| event["_tag"].as_str()),
        Some("finished")
    );
    assert_eq!(
        fs::read_to_string(cwd.join("tracked.txt")).expect("applied tracked content"),
        "saved change\n"
    );
    git(&cwd, &["reset", "--hard", "-q", "HEAD"]);
    let _ = fs::remove_file(cwd.join("untracked.txt"));
    let dropped = collect_events(fixture.operation(
        "42",
        json!({
            "_tag": "stash-drop", "cwd": cwd, "projectId": "project-1", "index": 0
        }),
    ))
    .await;
    assert_eq!(
        dropped.last().and_then(|event| event["_tag"].as_str()),
        Some("finished")
    );

    git(&cwd, &["switch", "-q", "-c", "feature"]);
    fs::write(cwd.join("feature.txt"), "feature\n").expect("feature file");
    git(&cwd, &["add", "feature.txt"]);
    git(&cwd, &["commit", "-q", "-m", "feature"]);
    git(&cwd, &["switch", "-q", "main"]);
    let merged = collect_events(fixture.operation(
        "43",
        json!({
            "_tag": "merge", "cwd": cwd, "projectId": "project-1",
            "source": "feature", "noVerify": false
        }),
    ))
    .await;
    assert_eq!(
        merged.last().and_then(|event| event["_tag"].as_str()),
        Some("finished")
    );
    assert!(cwd.join("feature.txt").exists());

    git(&cwd, &["switch", "-q", "-c", "squash-source"]);
    fs::write(cwd.join("squash.txt"), "squash\n").expect("squash file");
    git(&cwd, &["add", "squash.txt"]);
    git(&cwd, &["commit", "-q", "-m", "squash source"]);
    git(&cwd, &["switch", "-q", "main"]);
    let squashed = collect_events(fixture.operation(
        "44",
        json!({
            "_tag": "squash-merge", "cwd": cwd, "projectId": "project-1",
            "source": "squash-source", "noVerify": false
        }),
    ))
    .await;
    assert_eq!(
        squashed.last().and_then(|event| event["_tag"].as_str()),
        Some("finished")
    );
    assert!(cwd.join("squash.txt").exists());

    fs::write(cwd.join("dirty.txt"), "dirty\n").expect("dirty file");
    let blocked = collect_events(fixture.operation(
        "45",
        json!({
            "_tag": "merge", "cwd": cwd, "projectId": "project-1",
            "source": "feature", "noVerify": false
        }),
    ))
    .await;
    assert_eq!(event_kinds(&blocked), ["started", "failed"]);
    assert_eq!(blocked[1]["code"], "dirty-working-tree");
}

#[tokio::test]
async fn conflicting_merge_reports_conflicts_and_leaves_the_operation_in_progress() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    git(&cwd, &["switch", "-q", "-c", "feature"]);
    fs::write(cwd.join("tracked.txt"), "feature\n").expect("feature content");
    git(&cwd, &["commit", "-qam", "feature"]);
    git(&cwd, &["switch", "-q", "main"]);
    fs::write(cwd.join("tracked.txt"), "main\n").expect("main content");
    git(&cwd, &["commit", "-qam", "main"]);

    let events = collect_events(fixture.operation(
        "46",
        json!({
            "_tag": "merge", "cwd": cwd, "projectId": "project-1",
            "source": "feature", "noVerify": false
        }),
    ))
    .await;

    assert_eq!(event_kinds(&events).first(), Some(&"started"));
    assert_eq!(event_kinds(&events).last(), Some(&"failed"));
    assert_eq!(events.last().expect("failed event")["code"], "conflicts");
    let merge_head =
        String::from_utf8(git_output(&cwd, &["rev-parse", "--git-path", "MERGE_HEAD"]).stdout)
            .expect("UTF-8 merge path");
    assert!(cwd.join(merge_head.trim()).exists() || Path::new(merge_head.trim()).exists());
}

#[tokio::test]
async fn cherry_pick_conflict_lifecycle_detects_resolves_continues_and_aborts() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    git(&cwd, &["switch", "-q", "-c", "conflict-source"]);
    fs::write(cwd.join("tracked.txt"), "theirs first\n").expect("source content");
    git(&cwd, &["commit", "-qam", "source conflict"]);
    let source_sha = git_stdout(&cwd, &["rev-parse", "HEAD"]);
    git(&cwd, &["switch", "-q", "main"]);
    fs::write(cwd.join("tracked.txt"), "ours first\n").expect("main content");
    git(&cwd, &["commit", "-qam", "main conflict"]);

    let started = collect_events(fixture.operation(
        "60",
        json!({
            "_tag": "cherry-pick", "cwd": cwd, "projectId": "project-1",
            "shas": [source_sha]
        }),
    ))
    .await;
    assert_eq!(event_kinds(&started).first(), Some(&"started"));
    assert_eq!(event_kinds(&started).last(), Some(&"failed"));
    assert_eq!(
        started.last().expect("conflict failure")["code"],
        "conflicts-encountered"
    );

    let conflicts = GitRepository::default()
        .git_manager_conflict_states(&cwd, &CancellationToken::new())
        .await
        .expect("conflict state");
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].path, "tracked.txt");
    assert_eq!(conflicts[0].marker_count, 3);

    let theirs = collect_events(fixture.operation(
        "61",
        json!({
            "_tag": "resolve-conflict", "cwd": cwd, "projectId": "project-1",
            "path": "tracked.txt", "side": "theirs"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&theirs).last(), Some(&"finished"));
    assert_eq!(
        fs::read_to_string(cwd.join("tracked.txt")).expect("theirs resolution"),
        "theirs first\n"
    );

    let continued = collect_events(fixture.operation(
        "62",
        json!({
            "_tag": "continue", "cwd": cwd, "projectId": "project-1",
            "operation": "cherry-pick"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&continued).last(), Some(&"finished"));
    let continued_tip = git_stdout(&cwd, &["rev-parse", "HEAD"]);

    git(&cwd, &["switch", "-q", "-c", "abort-source"]);
    fs::write(cwd.join("tracked.txt"), "theirs second\n").expect("second source content");
    git(&cwd, &["commit", "-qam", "second source conflict"]);
    let abort_source_sha = git_stdout(&cwd, &["rev-parse", "HEAD"]);
    git(&cwd, &["switch", "-q", "main"]);
    assert_eq!(git_stdout(&cwd, &["rev-parse", "HEAD"]), continued_tip);
    fs::write(cwd.join("tracked.txt"), "ours second\n").expect("second main content");
    git(&cwd, &["commit", "-qam", "second main conflict"]);
    let pre_abort_tip = git_stdout(&cwd, &["rev-parse", "HEAD"]);

    let second = collect_events(fixture.operation(
        "63",
        json!({
            "_tag": "cherry-pick", "cwd": cwd, "projectId": "project-1",
            "shas": [abort_source_sha]
        }),
    ))
    .await;
    assert_eq!(event_kinds(&second).last(), Some(&"failed"));

    let ours = collect_events(fixture.operation(
        "64",
        json!({
            "_tag": "resolve-conflict", "cwd": cwd, "projectId": "project-1",
            "path": "tracked.txt", "side": "ours"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&ours).last(), Some(&"finished"));
    assert_eq!(
        fs::read_to_string(cwd.join("tracked.txt")).expect("ours resolution"),
        "ours second\n"
    );

    let aborted = collect_events(fixture.operation(
        "65",
        json!({
            "_tag": "abort", "cwd": cwd, "projectId": "project-1",
            "operation": "cherry-pick"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&aborted).last(), Some(&"finished"));
    assert_eq!(git_stdout(&cwd, &["rev-parse", "HEAD"]), pre_abort_tip);
    assert_eq!(
        fs::read_to_string(cwd.join("tracked.txt")).expect("abort restoration"),
        "ours second\n"
    );
    assert!(
        GitRepository::default()
            .git_manager_conflict_states(&cwd, &CancellationToken::new())
            .await
            .expect("clean conflict state")
            .is_empty()
    );
}

#[tokio::test]
async fn squash_can_rewrite_through_the_initial_commit_with_root() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    let initial = git_stdout(&cwd, &["rev-parse", "HEAD"]);
    fs::write(cwd.join("second.txt"), "second\n").expect("second file");
    git(&cwd, &["add", "second.txt"]);
    git(&cwd, &["commit", "-q", "-m", "second"]);
    let second = git_stdout(&cwd, &["rev-parse", "HEAD"]);
    fs::write(cwd.join("third.txt"), "third\n").expect("third file");
    git(&cwd, &["add", "third.txt"]);
    git(&cwd, &["commit", "-q", "-m", "third"]);
    let third = git_stdout(&cwd, &["rev-parse", "HEAD"]);

    let events = collect_events(fixture.operation(
        "66",
        json!({
            "_tag": "squash", "cwd": cwd, "projectId": "project-1",
            "shas": [third, second, initial], "message": "combined root history"
        }),
    ))
    .await;

    assert_eq!(event_kinds(&events).last(), Some(&"finished"));
    assert_eq!(git_stdout(&cwd, &["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(
        git_stdout(&cwd, &["show", "-s", "--format=%s", "HEAD"]),
        "combined root history"
    );
    assert!(cwd.join("tracked.txt").exists());
    assert!(cwd.join("second.txt").exists());
    assert!(cwd.join("third.txt").exists());
}

#[tokio::test]
async fn reorder_replays_the_touched_range_in_the_requested_order() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    fs::write(cwd.join("a.txt"), "a\n").expect("a file");
    git(&cwd, &["add", "a.txt"]);
    git(&cwd, &["commit", "-q", "-m", "commit A"]);
    let commit_a = git_stdout(&cwd, &["rev-parse", "HEAD"]);
    fs::write(cwd.join("b.txt"), "b\n").expect("b file");
    git(&cwd, &["add", "b.txt"]);
    git(&cwd, &["commit", "-q", "-m", "commit B"]);
    let commit_b = git_stdout(&cwd, &["rev-parse", "HEAD"]);

    let events = collect_events(fixture.operation(
        "67",
        json!({
            "_tag": "reorder", "cwd": cwd, "projectId": "project-1",
            "shas": [commit_a], "insertBeforeSha": commit_b
        }),
    ))
    .await;

    assert_eq!(event_kinds(&events).last(), Some(&"finished"));
    assert_eq!(
        git_stdout(&cwd, &["log", "-3", "--format=%s"]),
        "commit A\ncommit B\nbase"
    );
}

#[tokio::test]
async fn rebase_revert_and_all_reset_modes_execute_through_the_stream() {
    let fixture = Fixture::new().await;
    let cwd = fixture.repository_path.clone();
    git(&cwd, &["switch", "-q", "-c", "topic"]);
    fs::write(cwd.join("topic.txt"), "topic\n").expect("topic file");
    git(&cwd, &["add", "topic.txt"]);
    git(&cwd, &["commit", "-q", "-m", "topic"]);
    git(&cwd, &["switch", "-q", "main"]);
    fs::write(cwd.join("main.txt"), "main\n").expect("main file");
    git(&cwd, &["add", "main.txt"]);
    git(&cwd, &["commit", "-q", "-m", "main"]);

    let rebased = collect_events(fixture.operation(
        "68",
        json!({
            "_tag": "rebase", "cwd": cwd, "projectId": "project-1",
            "base": "main", "target": "topic"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&rebased).last(), Some(&"finished"));
    assert_eq!(git_stdout(&cwd, &["branch", "--show-current"]), "topic");
    git(&cwd, &["merge-base", "--is-ancestor", "main", "topic"]);
    git(&cwd, &["switch", "-q", "main"]);

    fs::write(cwd.join("revert-me.txt"), "revert\n").expect("revert file");
    git(&cwd, &["add", "revert-me.txt"]);
    git(&cwd, &["commit", "-q", "-m", "revert target"]);
    let revert_sha = git_stdout(&cwd, &["rev-parse", "HEAD"]);
    let reverted = collect_events(fixture.operation(
        "69",
        json!({
            "_tag": "revert", "cwd": cwd, "projectId": "project-1", "sha": revert_sha
        }),
    ))
    .await;
    assert_eq!(event_kinds(&reverted).last(), Some(&"finished"));
    assert!(!cwd.join("revert-me.txt").exists());

    let hard_target = git_stdout(&cwd, &["rev-parse", "HEAD"]);
    fs::write(cwd.join("hard.txt"), "hard\n").expect("hard file");
    git(&cwd, &["add", "hard.txt"]);
    git(&cwd, &["commit", "-q", "-m", "hard reset target"]);
    let hard = collect_events(fixture.operation(
        "70",
        json!({
            "_tag": "reset", "cwd": cwd, "projectId": "project-1",
            "sha": hard_target, "mode": "hard"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&hard).last(), Some(&"finished"));
    assert!(!cwd.join("hard.txt").exists());

    fs::write(cwd.join("soft.txt"), "soft\n").expect("soft file");
    git(&cwd, &["add", "soft.txt"]);
    git(&cwd, &["commit", "-q", "-m", "soft reset target"]);
    let soft_parent = git_stdout(&cwd, &["rev-parse", "HEAD^"]);
    let soft = collect_events(fixture.operation(
        "71",
        json!({
            "_tag": "reset", "cwd": cwd, "projectId": "project-1",
            "sha": soft_parent, "mode": "soft"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&soft).last(), Some(&"finished"));
    assert_eq!(
        git_stdout(&cwd, &["diff", "--cached", "--name-only"]),
        "soft.txt"
    );
    git(&cwd, &["reset", "--hard", "-q", "HEAD"]);

    fs::write(cwd.join("mixed.txt"), "mixed\n").expect("mixed file");
    git(&cwd, &["add", "mixed.txt"]);
    git(&cwd, &["commit", "-q", "-m", "mixed reset target"]);
    let mixed_parent = git_stdout(&cwd, &["rev-parse", "HEAD^"]);
    let mixed = collect_events(fixture.operation(
        "72",
        json!({
            "_tag": "reset", "cwd": cwd, "projectId": "project-1",
            "sha": mixed_parent, "mode": "mixed"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&mixed).last(), Some(&"finished"));
    assert!(cwd.join("mixed.txt").exists());
    assert!(git_stdout(&cwd, &["diff", "--cached", "--name-only"]).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn concurrent_operation_is_rejected_and_cancellation_terminates_the_child() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Stdio;
    use tokio::time::sleep;

    let fixture = Fixture::new().await;
    let marker = fixture._root.path().join("slow-fetch.pid");
    let helper = fixture._root.path().join("slow-remote.sh");
    fs::write(
        &helper,
        format!("#!/bin/sh\necho $$ > '{}'\nexec sleep 60\n", path(&marker)),
    )
    .expect("slow remote helper");
    let mut permissions = fs::metadata(&helper)
        .expect("helper metadata")
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&helper, permissions).expect("helper permissions");
    git(
        &fixture.repository_path,
        &["config", "protocol.ext.allow", "always"],
    );
    git(
        &fixture.repository_path,
        &[
            "remote",
            "add",
            "slow",
            &format!("ext::sh {}", path(&helper)),
        ],
    );

    let first_cancellation = CancellationToken::new();
    let mut first = fixture.services.operation_stream(
        operation_request(
            "3",
            json!({
                "_tag": "fetch",
                "cwd": fixture.repository_path,
                "projectId": "project-1",
                "remote": "slow"
            }),
        ),
        first_cancellation.clone(),
    );
    let started = next_event(&mut first).await;
    assert_eq!(started["_tag"], "started");
    wait_for_file(&marker).await;

    let second = collect_events(fixture.operation(
        "4",
        json!({
            "_tag": "fetch",
            "cwd": fixture.repository_path,
            "projectId": "project-1",
            "remote": "origin"
        }),
    ))
    .await;
    assert_eq!(event_kinds(&second), ["started", "failed"]);
    assert_eq!(second[1]["code"], "operation-in-flight");
    assert_eq!(second[1]["blocked"]["code"], "operation-in-flight");

    let pid = fs::read_to_string(&marker)
        .expect("slow helper pid")
        .trim()
        .to_owned();
    first_cancellation.cancel();
    let remaining = collect_events(first).await;
    assert_eq!(event_kinds(&remaining), ["failed"]);
    assert_eq!(remaining[0]["code"], "cancelled");
    let stopped = timeout(Duration::from_secs(5), async {
        loop {
            if !Command::new("kill")
                .args(["-0", &pid])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("inspect slow helper")
                .success()
            {
                break;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    assert!(stopped.is_ok(), "cancelled Git child remained alive");
}

#[cfg(unix)]
fn operation_request(id: &str, payload: Value) -> RpcRequest {
    rpc_request(id, "gitManager.runOperation", payload)
}

fn rpc_request(id: &str, tag: &str, payload: Value) -> RpcRequest {
    RpcRequest {
        id: RequestId::try_from(id).expect("request id"),
        tag: tag.to_owned(),
        payload,
        headers: Vec::new(),
        trace_id: None,
        span_id: None,
        sampled: None,
    }
}

async fn next_generation_after(
    receiver: &mut mpsc::Receiver<Result<Vec<Value>, Value>>,
    generation: u64,
) -> u64 {
    loop {
        let event = next_event(receiver).await;
        let observed = event["generation"].as_u64().expect("signal generation");
        if observed > generation {
            return observed;
        }
    }
}

async fn collect_events(mut receiver: mpsc::Receiver<Result<Vec<Value>, Value>>) -> Vec<Value> {
    let mut events = Vec::new();
    while let Some(chunk) = timeout(Duration::from_secs(15), receiver.recv())
        .await
        .expect("operation stream timeout")
    {
        events.extend(chunk.expect("operation stream chunk"));
    }
    events
}

async fn next_event(receiver: &mut mpsc::Receiver<Result<Vec<Value>, Value>>) -> Value {
    let chunk = timeout(Duration::from_secs(15), receiver.recv())
        .await
        .expect("operation event timeout")
        .expect("operation stream remains open")
        .expect("operation event chunk");
    let [event] = chunk.as_slice() else {
        panic!("expected one operation event, got {chunk:?}");
    };
    event.clone()
}

fn event_kinds(events: &[Value]) -> Vec<&str> {
    events
        .iter()
        .map(|event| event["_tag"].as_str().expect("event tag"))
        .collect()
}

#[cfg(unix)]
async fn wait_for_file(path: &Path) {
    use tokio::time::{Instant, sleep};

    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for helper start"
        );
        sleep(Duration::from_millis(25)).await;
    }
}

fn publish_remote_change(remote: &Path, root: &Path) {
    let publisher = root.join("publisher");
    git(
        root,
        &["clone", "-q", "-b", "main", path(remote), path(&publisher)],
    );
    configure_identity(&publisher);
    fs::write(publisher.join("remote.txt"), "remote change\n").expect("remote file");
    git(&publisher, &["add", "remote.txt"]);
    git(&publisher, &["commit", "-q", "-m", "remote change"]);
    git(&publisher, &["push", "-q", "origin", "main"]);
}

fn configure_identity(repository: &Path) {
    git(repository, &["config", "user.name", "Git Manager Test"]);
    git(
        repository,
        &["config", "user.email", "git-manager@example.test"],
    );
}

fn index_content(repository: &Path) -> String {
    index_file_content(repository, "tracked.txt")
}

fn index_file_content(repository: &Path, path: &str) -> String {
    let selector = format!(":{path}");
    let output = git_output(repository, &["show", &selector]);
    assert!(output.status.success(), "index blob is readable");
    String::from_utf8(output.stdout).expect("UTF-8 index content")
}

fn git_output(cwd: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git fixture starts")
}

fn git(cwd: &Path, args: &[&str]) {
    let output = git_output(cwd, args);
    assert!(
        output.status.success(),
        "git fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_stdout(cwd: &Path, args: &[&str]) -> String {
    let output = git_output(cwd, args);
    assert!(
        output.status.success(),
        "git fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn path(path: &Path) -> &str {
    path.to_str().expect("UTF-8 temporary path")
}
