//! Slice W: the worktree tools end to end, against a real repository, the real worktree
//! catalog and its creation and removal RPCs. The shared harness registers the worktree
//! methods before its engine exists, so they forward to a registry built on that engine once
//! it does; scope and admission still run on the harness's registry, as for any tool.

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, OnceLock},
    time::Duration,
};

use serde_json::{Value, json};
use tempfile::TempDir;

use tokio_util::sync::CancellationToken;

use super::{Harness, basic_start, command, error_tag, start, structured};
use crate::{
    git::GitRepository,
    mcp::control::{ClientPrincipal, McpAccess},
    production::worktree_catalog_rpc::{
        WorktreeCatalogRpcServices, WorktreeRemovalCleanupAdmission,
        WorktreeRemovalLiveSessionsFuture, WorktreeRemovalQuiesceFuture,
        WorktreeRemovalQuiesceLease, WorktreeRemovalQuiesceRequest, WorktreeRemovalQuiescer,
        register_worktree_catalog_rpc,
    },
    rpc::RpcRegistry,
    test_support::isolated_git_config::IsolatedGitConfig,
    worktree_catalog::{CatalogRefreshTrigger, WorktreeCatalogService},
};

const METHODS: &[&str] = &[
    "vcs.refreshWorktreeCatalog",
    "worktree.createManaged",
    "worktree.getRemovalPlan",
    "worktree.remove",
    "worktree.removeFromBibCode",
];
const PROJECT: &str = "pw";

struct Fixture {
    harness: Harness,
    services: WorktreeCatalogRpcServices,
    catalog: WorktreeCatalogService,
    git: IsolatedGitConfig,
    root: TempDir,
}

impl Fixture {
    async fn new() -> Self {
        Self::quiesced_by(None).await
    }

    /// A fixture whose removals call `quiescer` after Git work is prepared, just before it
    /// runs: the window after the catalog took the removal over.
    async fn quiesced_by(quiescer: Option<Arc<dyn WorktreeRemovalQuiescer>>) -> Self {
        let inner: Arc<OnceLock<RpcRegistry>> = Arc::default();
        let harness = Harness::with_methods(|registry| {
            for method in METHODS {
                let inner = inner.clone();
                registry.register_unary_with_context(*method, move |request, context, cancel| {
                    let inner = inner.clone();
                    async move {
                        inner
                            .get()
                            .expect("the worktree methods are bound")
                            .invoke_local(method, request.payload, context, cancel)
                            .await
                    }
                });
            }
        })
        .await;
        let git = IsolatedGitConfig::new();
        let root = tempfile::tempdir().expect("repository root");
        let main = root.path().join("main");
        std::fs::create_dir(&main).expect("primary directory");
        for args in [
            &["init", "--initial-branch=main"][..],
            &["config", "user.email", "mcp@example.invalid"],
            &["config", "user.name", "MCP Test"],
        ] {
            run_git(&git, &main, args);
        }
        std::fs::write(main.join("README.md"), "fixture\n").expect("fixture file");
        run_git(&git, &main, &["add", "README.md"]);
        run_git(&git, &main, &["commit", "-m", "initial"]);
        harness
            .engine
            .dispatch(command(json!({
                "type": "project.create",
                "commandId": "project-create-worktrees",
                "projectId": PROJECT,
                "title": "Worktrees",
                "workspaceRoot": main,
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": "2026-10-30T00:00:00.000Z",
            })))
            .await
            .expect("project created");
        let catalog = WorktreeCatalogService::new(
            Arc::new(harness.engine.repositories()),
            Arc::new(GitRepository::default()),
        );
        catalog
            .refresh(PROJECT, CatalogRefreshTrigger::Explicit)
            .await
            .expect("seed catalog");
        let mut services = WorktreeCatalogRpcServices::new(catalog.clone(), harness.engine.clone());
        if let Some(quiescer) = quiescer {
            services = services.with_removal_quiescer(quiescer);
        }
        let mut registry = RpcRegistry::empty();
        register_worktree_catalog_rpc(&mut registry, services.clone());
        assert!(inner.set(registry).is_ok());
        Self {
            harness,
            services,
            catalog,
            git,
            root,
        }
    }

    async fn call(&self, agent: &ClientPrincipal, tool: &str, arguments: Value) -> Value {
        self.harness.call(agent, tool, arguments).await
    }

    /// Creates a worktree on a new branch and returns its host thread and folder.
    async fn create(&self, agent: &ClientPrincipal, branch: &str) -> (String, PathBuf) {
        let created = self
            .call(
                agent,
                "create_worktree",
                json!({ "projectId": PROJECT, "branch": "main", "newBranch": branch }),
            )
            .await;
        let created = structured(&created);
        (
            created["threadId"].as_str().unwrap().to_owned(),
            PathBuf::from(created["path"].as_str().unwrap()),
        )
    }

    async fn plan(&self, agent: &ClientPrincipal, thread_id: &str) -> Value {
        structured(
            &self
                .call(
                    agent,
                    "get_worktree_removal_plan",
                    json!({ "threadId": thread_id }),
                )
                .await,
        )
        .clone()
    }

    async fn shutdown(self) {
        self.services.operation_runtime().shutdown().await;
        self.catalog.shutdown().await;
        self.harness.shutdown().await;
    }
}

fn run_git(config: &IsolatedGitConfig, cwd: &Path, args: &[&str]) {
    let mut git = Command::new("git");
    config.apply_to_command(&mut git);
    let output = git.args(args).current_dir(cwd).output().expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn reason(result: &Value) -> &str {
    assert_eq!(result["isError"], true, "{result}");
    result["structuredContent"]["error"]["reason"]
        .as_str()
        .unwrap_or_default()
}

fn removal(plan: &Value, thread_id: &str, mode: &str) -> Value {
    json!({
        "threadId": thread_id,
        "planToken": plan["planToken"],
        "expectedGeneration": plan["generation"],
        "mode": mode,
    })
}

#[tokio::test]
async fn a_created_worktree_is_listed_and_a_retry_returns_the_same_thread() {
    let fixture = Fixture::new().await;
    let (agent, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    let arguments = json!({
        "projectId": PROJECT, "branch": "main", "newBranch": "feature-a", "clientRequestId": "create-1",
    });
    let created = fixture
        .call(&agent, "create_worktree", arguments.clone())
        .await;
    let created = structured(&created).clone();
    let thread_id = created["threadId"].as_str().unwrap();
    assert_eq!(created["branch"], "feature-a");
    assert!(Path::new(created["path"].as_str().unwrap()).is_dir());
    // The host thread runs at the ceiling, with the project's default model.
    let thread = fixture
        .harness
        .repositories
        .get_thread(thread_id.to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(thread.runtime_mode, "full-access");
    assert_eq!(thread.kind, "workspace");

    let retried = fixture.call(&agent, "create_worktree", arguments).await;
    assert_eq!(structured(&retried)["threadId"], thread_id);
    assert_eq!(structured(&retried)["path"], created["path"]);
    let conflict = fixture
        .call(
            &agent,
            "create_worktree",
            json!({ "projectId": PROJECT, "branch": "main", "newBranch": "feature-b", "clientRequestId": "create-1" }),
        )
        .await;
    assert_eq!(error_tag(&conflict), "idempotency_conflict");

    let listed = fixture
        .call(&agent, "list_worktrees", json!({ "projectId": PROJECT }))
        .await;
    let listed = structured(&listed);
    let worktrees = listed["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 2, "the primary checkout and the new one");
    let entry = worktrees
        .iter()
        .find(|entry| entry["hostThreadId"] == thread_id)
        .expect("the new worktree names its host thread");
    assert_eq!(entry["branch"], "feature-a");
    assert_eq!(entry["availability"], "present");
    assert!(worktrees.iter().any(|entry| entry["primary"] == true));

    let page = fixture
        .call(
            &agent,
            "list_worktrees",
            json!({ "projectId": PROJECT, "limit": 1 }),
        )
        .await;
    let page = structured(&page);
    assert_eq!(page["worktrees"].as_array().unwrap().len(), 1);
    let rest = fixture
        .call(
            &agent,
            "list_worktrees",
            json!({ "projectId": PROJECT, "limit": 1, "cursor": page["nextCursor"] }),
        )
        .await;
    let rest = structured(&rest);
    assert_eq!(rest["worktrees"].as_array().unwrap().len(), 1);
    assert_ne!(rest["worktrees"][0], page["worktrees"][0]);
    assert_eq!(rest["nextCursor"], Value::Null);

    let missing = fixture
        .call(
            &agent,
            "create_worktree",
            json!({ "projectId": "nope", "branch": "main", "newBranch": "x" }),
        )
        .await;
    assert_eq!(error_tag(&missing), "McpProjectNotFoundError");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_supervised_ceiling_caps_a_new_worktree_thread() {
    let fixture = Fixture::new().await;
    let (agent, _) = fixture.harness.agent(McpAccess::ApprovalRequired).await;
    let above = fixture
        .call(
            &agent,
            "create_worktree",
            json!({ "projectId": PROJECT, "branch": "main", "newBranch": "above", "runtimeMode": "full-access" }),
        )
        .await;
    assert_eq!(error_tag(&above), "McpAccessCeilingError");
    let (thread_id, _) = fixture.create(&agent, "capped").await;
    let thread = fixture
        .harness
        .repositories
        .get_thread(thread_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(thread.runtime_mode, "approval-required");
    fixture.shutdown().await;
}

#[tokio::test]
async fn read_only_hides_and_refuses_the_mutating_worktree_tools() {
    let fixture = Fixture::new().await;
    let (writer, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    let tools = fixture.harness.control.tools(&writer);
    let hints = |name: &str| {
        tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} is listed"))["annotations"]
            .clone()
    };
    for read in ["list_worktrees", "get_worktree_removal_plan"] {
        assert_eq!(hints(read)["readOnlyHint"], true, "{read}");
        assert_eq!(hints(read)["idempotentHint"], true, "{read}");
    }
    assert_eq!(hints("create_worktree")["destructiveHint"], false);
    assert_eq!(hints("create_worktree")["idempotentHint"], false);
    assert_eq!(hints("remove_worktree")["destructiveHint"], true);
    assert_eq!(hints("remove_worktree")["idempotentHint"], false);
    let (thread_id, _) = fixture.create(&writer, "kept").await;

    let (reader, _) = fixture.harness.agent(McpAccess::ReadOnly).await;
    let listed = fixture.harness.control.tools(&reader);
    let names: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"list_worktrees") && names.contains(&"get_worktree_removal_plan"));
    assert!(!names.contains(&"create_worktree") && !names.contains(&"remove_worktree"));
    let plan = fixture.plan(&reader, &thread_id).await;
    for (tool, arguments) in [
        (
            "create_worktree",
            json!({ "projectId": PROJECT, "branch": "main", "newBranch": "no" }),
        ),
        ("remove_worktree", removal(&plan, &thread_id, "delete")),
    ] {
        assert_eq!(
            error_tag(&fixture.call(&reader, tool, arguments).await),
            "McpAccessCeilingError",
            "{tool}"
        );
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_removal_needs_the_current_plan_and_consent_to_discard_changes() {
    let fixture = Fixture::new().await;
    let (agent, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    let (thread_id, path) = fixture.create(&agent, "dirty").await;
    std::fs::write(path.join("notes.txt"), "unsaved\n").expect("dirty file");
    let plan = fixture.plan(&agent, &thread_id).await;
    assert_eq!(plan["untrackedFileCount"], 1);
    assert_eq!(plan["availability"], "present");

    let mut stale = removal(&plan, &thread_id, "delete");
    stale["expectedGeneration"] = json!(plan["generation"].as_u64().unwrap() + 1);
    stale["discardChanges"] = json!(true);
    let refused = fixture.call(&agent, "remove_worktree", stale).await;
    assert_eq!(reason(&refused), "stale-generation", "{refused}");

    let refused = fixture
        .call(
            &agent,
            "remove_worktree",
            removal(&plan, &thread_id, "delete"),
        )
        .await;
    assert_eq!(reason(&refused), "dirty-confirmation-required");
    assert!(path.join("notes.txt").is_file(), "nothing was lost");

    let mut confirmed = removal(&plan, &thread_id, "delete");
    confirmed["discardChanges"] = json!(true);
    let removed = fixture.call(&agent, "remove_worktree", confirmed).await;
    let removed = structured(&removed);
    assert_eq!(removed["threadRemoved"], true);
    assert_eq!(removed["gitOutcome"], "removed");
    assert!(!path.exists());
    fixture.shutdown().await;
}

#[tokio::test]
async fn detach_keeps_the_folder_and_cleanup_clears_a_missing_one() {
    let fixture = Fixture::new().await;
    let (agent, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    let (thread_id, path) = fixture.create(&agent, "detached").await;
    let mut discard = json!({ "threadId": thread_id, "mode": "detach", "discardChanges": true });
    assert_eq!(
        error_tag(
            &fixture
                .call(&agent, "remove_worktree", discard.clone())
                .await
        ),
        "McpInvalidArgumentError"
    );
    discard["discardChanges"] = json!(false);
    let detached = fixture.call(&agent, "remove_worktree", discard).await;
    let detached = structured(&detached);
    assert_eq!(detached["threadRemoved"], true);
    assert_eq!(detached["gitOutcome"], "not-requested");
    assert!(path.is_dir(), "detach keeps the folder");

    let (thread_id, path) = fixture.create(&agent, "vanished").await;
    std::fs::remove_dir_all(&path).expect("folder removed outside BiBCode");
    let plan = fixture.plan(&agent, &thread_id).await;
    assert_eq!(plan["availability"], "missing-registered");
    let refused = fixture
        .call(
            &agent,
            "remove_worktree",
            removal(&plan, &thread_id, "delete"),
        )
        .await;
    assert_eq!(reason(&refused), "stale-plan");
    let cleaned = fixture
        .call(
            &agent,
            "remove_worktree",
            removal(&plan, &thread_id, "cleanup"),
        )
        .await;
    let cleaned = structured(&cleaned);
    assert_eq!(cleaned["threadRemoved"], true);
    assert_eq!(cleaned["gitOutcome"], "cleaned");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_thread_without_a_worktree_is_refused_before_any_rpc() {
    let fixture = Fixture::new().await;
    let (agent, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&fixture.harness, &agent, basic_start()).await;
    assert_eq!(
        error_tag(
            &fixture
                .call(
                    &agent,
                    "get_worktree_removal_plan",
                    json!({ "threadId": thread_id }),
                )
                .await
        ),
        "McpNotAWorktreeError"
    );
    assert_eq!(
        error_tag(
            &fixture
                .call(
                    &agent,
                    "remove_worktree",
                    json!({ "threadId": thread_id, "mode": "detach" }),
                )
                .await
        ),
        "McpNotAWorktreeError"
    );
    let missing_plan = fixture
        .call(
            &agent,
            "remove_worktree",
            json!({ "threadId": thread_id, "mode": "delete" }),
        )
        .await;
    assert_eq!(error_tag(&missing_plan), "McpInvalidArgumentError");
    fixture.shutdown().await;
}

/// One `worktree.removal` profiler event per real removal, none for a replayed retry. In a
/// process of its own: the profiler handle is process-global, and sibling tests remove
/// worktrees too.
#[tokio::test]
async fn a_removal_reaches_the_profiler_once_across_a_retry() {
    let Some(child) = crate::test_support::in_own_process(
        "production::mcp_tools_tests::worktrees::a_removal_reaches_the_profiler_once_across_a_retry",
    ) else {
        return;
    };
    let state = tempfile::tempdir().expect("profiler state");
    let (_enabled, enabled) = tokio::sync::watch::channel(true);
    let runtime = crate::diagnostics::profiler::runtime::ProfilerRuntime::start(
        state.path(),
        enabled,
        vec![],
    );
    tokio::time::timeout(Duration::from_secs(30), async {
        while runtime.status()["enabled"] != true {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the profiler turns on");

    let fixture = Fixture::new().await;
    let (agent, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    let (thread_id, path) = fixture.create(&agent, "audited").await;
    let plan = fixture.plan(&agent, &thread_id).await;
    let mut arguments = removal(&plan, &thread_id, "delete");
    arguments["clientRequestId"] = json!("remove-1");
    let first = fixture
        .call(&agent, "remove_worktree", arguments.clone())
        .await;
    assert_eq!(structured(&first)["gitOutcome"], "removed");
    assert!(!path.exists());
    let retried = fixture.call(&agent, "remove_worktree", arguments).await;
    assert_eq!(structured(&retried), structured(&first));
    fixture.shutdown().await;

    runtime.shutdown().await;
    let removals = std::fs::read_dir(crate::diagnostics::profiler::profiler_dir(state.path()))
        .expect("profiler directory")
        .filter_map(|entry| std::fs::read_to_string(entry.expect("entry").path()).ok())
        .flat_map(|text| text.lines().map(str::to_owned).collect::<Vec<_>>())
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter(|event| event["kind"] == "worktree.removal")
        .collect::<Vec<_>>();
    assert_eq!(removals.len(), 1, "{removals:?}");
    assert_eq!(removals[0]["ok"], true);
    child.complete();
}

/// Runs `0` when a removal quiesces its threads: after the catalog took the removal over and
/// prepared it, before Git runs.
struct OnQuiesce(Box<dyn Fn() + Send + Sync>);

impl WorktreeRemovalQuiescer for OnQuiesce {
    fn live_session_thread_ids(&self, _: Vec<String>) -> WorktreeRemovalLiveSessionsFuture {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn quiesce(
        &self,
        _: WorktreeRemovalCleanupAdmission,
        _: WorktreeRemovalQuiesceRequest,
    ) -> WorktreeRemovalQuiesceFuture {
        (self.0)();
        Box::pin(async { WorktreeRemovalQuiesceLease::complete() })
    }
}

/// A call cancelled after the catalog took the removal over still removes the worktree: the
/// handed-off operation runs under a server-owned token, not the call's.
#[tokio::test]
async fn a_removal_cancelled_after_handoff_still_finishes() {
    let cancel = CancellationToken::new();
    let fixture = Fixture::quiesced_by(Some(Arc::new(OnQuiesce(Box::new({
        let cancel = cancel.clone();
        move || cancel.cancel()
    })))))
    .await;
    let (agent, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    let (thread_id, path) = fixture.create(&agent, "cancelled").await;
    let plan = fixture.plan(&agent, &thread_id).await;
    let Value::Object(arguments) = removal(&plan, &thread_id, "delete") else {
        unreachable!()
    };
    let removed = fixture
        .harness
        .control
        .call(&agent, "remove_worktree", &arguments, None, cancel.clone())
        .await;
    assert!(cancel.is_cancelled(), "the call was cancelled mid-removal");
    let removed = structured(&removed);
    assert_eq!(removed["gitOutcome"], "removed", "{removed}");
    assert!(!path.exists());
    fixture.shutdown().await;
}

#[derive(Clone, Default)]
struct CapturedLog(Arc<std::sync::Mutex<Vec<u8>>>);

impl CapturedLog {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

impl std::io::Write for CapturedLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A removal whose caller stopped waiting after the catalog took it over still writes its one
/// `MCP destructive tool` line when it finishes (C7). In a process of its own: the log
/// capture is this thread's default subscriber, and sibling tests remove worktrees too.
#[tokio::test]
async fn a_removal_nobody_waits_for_still_writes_its_audit_line() {
    let Some(child) = crate::test_support::in_own_process(
        "production::mcp_tools_tests::worktrees::a_removal_nobody_waits_for_still_writes_its_audit_line",
    ) else {
        return;
    };
    let log = CapturedLog::default();
    let _logging = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .with_writer({
                let log = log.clone();
                move || log.clone()
            })
            .finish(),
    );
    let waiter: Arc<std::sync::Mutex<Option<tokio::task::AbortHandle>>> = Arc::default();
    let fixture = Fixture::quiesced_by(Some(Arc::new(OnQuiesce(Box::new({
        let waiter = waiter.clone();
        move || {
            if let Some(waiter) = waiter.lock().unwrap().take() {
                waiter.abort();
            }
        }
    })))))
    .await;
    let (agent, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    let (thread_id, path) = fixture.create(&agent, "unwatched").await;
    let plan = fixture.plan(&agent, &thread_id).await;
    let Value::Object(arguments) = removal(&plan, &thread_id, "delete") else {
        unreachable!()
    };
    let call = tokio::spawn({
        let (control, agent) = (fixture.harness.control.clone(), agent.clone());
        async move {
            control
                .call(
                    &agent,
                    "remove_worktree",
                    &arguments,
                    None,
                    CancellationToken::new(),
                )
                .await
        }
    });
    *waiter.lock().unwrap() = Some(call.abort_handle());
    assert!(
        call.await
            .expect_err("the caller stopped waiting")
            .is_cancelled()
    );
    tokio::time::timeout(Duration::from_secs(30), async {
        while !log.text().contains("MCP destructive tool") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no audit line:\n{}", log.text()));
    assert!(!path.exists(), "the removal finished");
    // A removal its caller waits for is logged once too, by the call.
    let (thread_id, _) = fixture.create(&agent, "watched").await;
    let plan = fixture.plan(&agent, &thread_id).await;
    let removed = fixture
        .call(
            &agent,
            "remove_worktree",
            removal(&plan, &thread_id, "delete"),
        )
        .await;
    assert_eq!(structured(&removed)["gitOutcome"], "removed");
    fixture.shutdown().await;
    let text = log.text();
    let audit: Vec<&str> = text
        .lines()
        .filter(|line| line.contains("MCP destructive tool"))
        .collect();
    assert_eq!(audit.len(), 2, "{text}");
    assert!(
        audit
            .iter()
            .all(|line| line.contains("remove_worktree") && line.contains("success")),
        "{text}"
    );
    child.complete();
}

/// A plan whose prune impact is too long to show in full cannot confirm the prune: it would
/// remove registrations the agent never saw. Unix only: the stale worktrees' long paths
/// exceed Windows' path limit.
#[cfg(unix)]
#[tokio::test]
async fn a_plan_too_long_to_show_in_full_refuses_a_repository_wide_prune() {
    let fixture = Fixture::new().await;
    let (agent, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    let (thread_id, path) = fixture.create(&agent, "gone").await;
    let main = fixture.root.path().join("main");
    // Stale registrations with long paths, so their prune impact outgrows one tool result.
    let top = fixture.root.path().join("s".repeat(200));
    let deep = top
        .join("t".repeat(200))
        .join("u".repeat(200))
        .join("v".repeat(200));
    for index in 0..100 {
        let stale = deep.join(format!("stale-{index}"));
        run_git(
            &fixture.git,
            &main,
            &["worktree", "add", "--detach", stale.to_str().unwrap()],
        );
    }
    std::fs::remove_dir_all(&top).expect("stale folders removed");
    std::fs::remove_dir_all(&path).expect("folder removed outside BiBCode");
    let plan = fixture.plan(&agent, &thread_id).await;
    assert_eq!(plan["availability"], "missing-registered");
    assert_eq!(plan["truncated"], true);
    assert_eq!(plan["pruneImpactCount"], 101);
    assert!(plan["pruneImpact"].as_array().unwrap().len() < 101);

    let mut prune = removal(&plan, &thread_id, "cleanup");
    prune["confirmRepositoryWidePrune"] = json!(true);
    let refused = fixture.call(&agent, "remove_worktree", prune).await;
    assert_eq!(
        error_tag(&refused),
        "McpPruneImpactTooLongError",
        "{refused}"
    );
    let registrations = || {
        std::fs::read_dir(main.join(".git/worktrees"))
            .unwrap()
            .count()
    };
    assert_eq!(registrations(), 101, "nothing was pruned");

    // The marked token still names the current plan: without the prune, the catalog takes the
    // removal and answers for itself (a missing folder among other stale ones needs a prune).
    let unconfirmed = fixture
        .call(
            &agent,
            "remove_worktree",
            removal(&plan, &thread_id, "cleanup"),
        )
        .await;
    assert_eq!(reason(&unconfirmed), "prune-confirmation-required");
    assert_eq!(registrations(), 101, "nothing was pruned");
    fixture.shutdown().await;
}
