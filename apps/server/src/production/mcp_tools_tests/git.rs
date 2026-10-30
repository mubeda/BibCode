//! The Git write tools (#139 slice G) end to end: the real `vcs.*` and `gitManager.*`
//! handlers on a real temporary repository whose `origin` is a bare repository on disk. Only
//! the trash is faked, so a discard never reaches the system trash.

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{CREATED_AT, Harness, command, error_tag, structured};
use crate::{
    git::{FileTrash, FileTrashFuture, GitRepository, StatusBroadcaster, TrashUnavailable},
    mcp::control::{ClientPrincipal, McpAccess},
    persistence::{Database, ProjectionProject, Repositories, run_migrations},
    production::{
        git_manager_rpc::{GitManagerRpcServices, register_git_manager_rpc},
        git_vcs::{GitVcsRpcServices, register_git_vcs_rpc},
    },
    rpc::RpcSessionContext,
    worktree_catalog::{WorkspaceAvailabilityRegistry, WorktreeCatalogService},
};

const THREAD: &str = "git-thread";

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "BiBCode Test")
        .env("GIT_AUTHOR_EMAIL", "bibcode@example.invalid")
        .env("GIT_COMMITTER_NAME", "BiBCode Test")
        .env("GIT_COMMITTER_EMAIL", "bibcode@example.invalid")
        .output()
        .expect("git starts");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Moves a discarded file into a folder of its own, or refuses while switched off.
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
    /// The thread's folder: a clone whose `origin` is `remote`.
    repo: PathBuf,
    remote: PathBuf,
    trash: Arc<TestTrash>,
    _folders: [tempfile::TempDir; 3],
}

/// A thread whose worktree is a repository with one pushed commit (`a.txt`) on `main`.
async fn fixture() -> Fixture {
    let folders = [
        tempfile::tempdir().expect("repository"),
        tempfile::tempdir().expect("remote"),
        tempfile::tempdir().expect("trash"),
    ];
    let repo = folders[0].path().canonicalize().unwrap();
    let remote = folders[1].path().canonicalize().unwrap();
    git(&remote, &["init", "-q", "--bare", "-b", "main"]);
    git(&repo, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "BiBCode Test"),
        ("user.email", "bibcode@example.invalid"),
        ("core.autocrlf", "false"),
        ("commit.gpgsign", "false"),
    ] {
        git(&repo, &["config", key, value]);
    }
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-q", "-m", "base"]);
    git(
        &repo,
        &["remote", "add", "origin", &remote.to_string_lossy()],
    );
    git(&repo, &["push", "-q", "-u", "origin", "main"]);

    // The Git handlers resolve a folder's project from their own store.
    let database = Database::open_in_memory().await.expect("database");
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .expect("migrations");
    let projects = Repositories::new(database);
    projects
        .upsert_project(ProjectionProject {
            project_id: "p1".to_owned(),
            title: "Project".to_owned(),
            workspace_root: repo.to_string_lossy().into_owned(),
            default_model_selection: None,
            scripts: json!([]),
            worktree_discovery: json!({}),
            worktree_repository_key: None,
            created_at: CREATED_AT.to_owned(),
            updated_at: CREATED_AT.to_owned(),
            deleted_at: None,
            repository_identity: None,
        })
        .await
        .expect("project");
    let repository = Arc::new(GitRepository::default());
    let availability = WorkspaceAvailabilityRegistry::new();
    let catalog = WorktreeCatalogService::new_with_availability_registry(
        Arc::new(projects.clone()),
        repository.clone(),
        availability.clone(),
    );
    let trash = Arc::new(TestTrash {
        folder: folders[2].path().to_path_buf(),
        available: AtomicBool::new(true),
        count: AtomicUsize::new(0),
    });
    let manager = GitManagerRpcServices::with_dependencies(
        repository.clone(),
        StatusBroadcaster::new(repository.clone(), Duration::from_secs(3_600), 8),
        catalog,
        projects,
        availability,
        trash.clone(),
    );
    let vcs = GitVcsRpcServices::with_repository(repository, Arc::default());
    let harness = Harness::with_methods(move |registry| {
        register_git_vcs_rpc(registry, vcs);
        register_git_manager_rpc(registry, manager);
    })
    .await;
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.create", "commandId": "create-git-thread", "threadId": THREAD,
            "projectId": "p1", "title": "Git",
            "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "approval-required", "interactionMode": "default", "branch": "main",
            "worktreePath": repo, "createdAt": CREATED_AT,
        })))
        .await
        .expect("thread created");
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
    Fixture {
        harness,
        agent,
        repo,
        remote,
        trash,
        _folders: folders,
    }
}

impl Fixture {
    async fn call(&self, tool: &str, mut arguments: Value) -> Value {
        arguments["threadId"] = THREAD.into();
        self.harness.call(&self.agent, tool, arguments).await
    }

    /// Runs `tool` with `arguments` on its own task under `token`.
    fn spawn(
        &self,
        tool: &'static str,
        mut arguments: Value,
        token: CancellationToken,
    ) -> tokio::task::JoinHandle<Value> {
        arguments["threadId"] = THREAD.into();
        let Value::Object(arguments) = arguments else {
            unreachable!("arguments are an object");
        };
        let (control, agent) = (self.harness.control.clone(), self.agent.clone());
        tokio::spawn(async move { control.call(&agent, tool, &arguments, None, token).await })
    }

    fn write(&self, path: &str, text: &str) {
        let path = self.repo.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.repo.join(path)).ok()
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.repo, args)
    }

    fn remote_git(&self, args: &[&str]) -> String {
        git(&self.remote, args)
    }

    /// A second clone that pushes a commit `subject` to `main`, as another person would.
    fn push_from_elsewhere(&self, subject: &str) -> String {
        let other = tempfile::tempdir().expect("other clone");
        git(
            other.path(),
            &["clone", "-q", &self.remote.to_string_lossy(), "."],
        );
        std::fs::write(other.path().join(format!("{subject}.txt")), subject).unwrap();
        git(other.path(), &["add", "."]);
        git(other.path(), &["commit", "-q", "-m", subject]);
        git(other.path(), &["push", "-q", "origin", "main"]);
        git(other.path(), &["rev-parse", "HEAD"])
    }

    fn context(&self) -> RpcSessionContext {
        RpcSessionContext::authenticated(self.agent.principal.clone(), self.harness.auth.clone())
    }
}

fn error(result: &Value) -> &Value {
    &result["structuredContent"]["error"]
}

#[tokio::test]
async fn stage_commit_and_push_land_on_the_bare_remote() {
    let fixture = fixture().await;
    fixture.write("src/new.txt", "new\n");
    let staged = fixture.call("git_stage", json!({ "paths": ["src"] })).await;
    let staged = structured(&staged);
    assert_eq!(staged["staged"], json!(["src"]));
    assert_eq!(staged["threadId"], THREAD);
    assert_eq!(staged["status"]["branch"], "main");
    assert_eq!(
        fixture.git(&["diff", "--cached", "--name-only"]),
        "src/new.txt"
    );

    let committed = fixture
        .call(
            "git_commit",
            json!({ "summary": "Add new", "description": "With a body." }),
        )
        .await;
    let sha = structured(&committed)["sha"].as_str().unwrap().to_owned();
    assert_eq!(fixture.git(&["rev-parse", "HEAD"]), sha);
    assert_eq!(structured(&committed)["status"]["ahead"], 1);

    let pushed = fixture.call("git_push", json!({})).await;
    let pushed = structured(&pushed);
    assert_eq!(pushed["operation"], "push");
    assert_eq!(pushed["remote"], "origin");
    assert_eq!(pushed["branch"], "main");
    assert_eq!(pushed["status"]["ahead"], 0);
    assert_eq!(fixture.remote_git(&["rev-parse", "main"]), sha);
    assert_eq!(
        fixture.remote_git(&["log", "-1", "--format=%B", "main"]),
        "Add new\n\nWith a body."
    );

    // Unstaging takes the same literal paths.
    fixture.write("a.txt", "changed\n");
    structured(
        &fixture
            .call("git_stage", json!({ "paths": ["a.txt"] }))
            .await,
    );
    let unstaged = fixture
        .call("git_unstage", json!({ "paths": ["a.txt"] }))
        .await;
    assert_eq!(structured(&unstaged)["unstaged"], json!(["a.txt"]));
    assert_eq!(fixture.git(&["diff", "--cached", "--name-only"]), "");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn a_push_updates_the_upstream_branch_whatever_its_name_there() {
    let fixture = fixture().await;
    fixture.git(&["switch", "-q", "-c", "local-name"]);
    fixture.git(&["push", "-q", "origin", "local-name:remote-name"]);
    fixture.git(&["branch", "--set-upstream-to=origin/remote-name"]);
    fixture.git(&["commit", "-q", "--allow-empty", "-m", "more"]);
    let pushed = fixture.call("git_push", json!({})).await;
    assert_eq!(structured(&pushed)["operation"], "push");
    assert_eq!(
        fixture.remote_git(&["rev-parse", "remote-name"]),
        fixture.git(&["rev-parse", "HEAD"])
    );
    assert_eq!(branches(&fixture.remote), "main\nremote-name");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn one_key_makes_one_commit_and_another_call_under_it_is_a_conflict() {
    let fixture = fixture().await;
    fixture.write("b.txt", "b\n");
    structured(
        &fixture
            .call("git_stage", json!({ "paths": ["b.txt"] }))
            .await,
    );
    let arguments = json!({ "summary": "Add b", "clientRequestId": "commit-1" });
    let first = fixture.call("git_commit", arguments.clone()).await;
    let second = fixture.call("git_commit", arguments).await;
    assert_eq!(structured(&first)["sha"], structured(&second)["sha"]);
    assert_eq!(fixture.git(&["rev-list", "--count", "HEAD"]), "2");
    let other = fixture
        .call(
            "git_commit",
            json!({ "summary": "Something else", "clientRequestId": "commit-1" }),
        )
        .await;
    assert_eq!(error_tag(&other), "idempotency_conflict");
    // A tool without a key takes no key.
    let refused = fixture
        .call(
            "git_stage",
            json!({ "paths": ["b.txt"], "clientRequestId": "stage-1" }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpInvalidArgumentError");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn a_force_push_after_the_remote_moved_is_refused_until_a_fetch() {
    let fixture = fixture().await;
    let theirs = fixture.push_from_elsewhere("theirs");
    fixture.write("ours.txt", "ours\n");
    fixture.git(&["add", "ours.txt"]);
    fixture.git(&["commit", "-q", "-m", "ours"]);
    let ours = fixture.git(&["rev-parse", "HEAD"]);

    let refused = fixture.call("git_force_push", json!({})).await;
    assert_eq!(error_tag(&refused), "GitOperationFailedError");
    assert!(error(&refused)["code"].is_string(), "{refused}");
    assert_eq!(fixture.remote_git(&["rev-parse", "main"]), theirs);

    let fetched = fixture.call("git_fetch", json!({})).await;
    let fetched = structured(&fetched);
    assert_eq!(fetched["operation"], "fetch");
    assert_eq!(fetched["status"]["behind"], 1);
    let forced = fixture.call("git_force_push", json!({})).await;
    assert_eq!(structured(&forced)["operation"], "force-push");
    assert_eq!(fixture.remote_git(&["rev-parse", "main"]), ours);
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn fetch_pull_and_revert_follow_the_remote() {
    let fixture = fixture().await;
    let theirs = fixture.push_from_elsewhere("theirs");
    let pulled = fixture.call("git_pull", json!({})).await;
    let pulled = structured(&pulled);
    assert_eq!(pulled["operation"], "pull");
    assert_eq!(pulled["status"]["behind"], 0);
    assert_eq!(fixture.git(&["rev-parse", "HEAD"]), theirs);

    let reverted = fixture
        .call("git_revert_commit", json!({ "sha": theirs }))
        .await;
    assert_eq!(structured(&reverted)["operation"], "revert");
    assert!(
        fixture
            .git(&["log", "-1", "--format=%s"])
            .starts_with("Revert"),
    );
    assert!(fixture.read("theirs.txt").is_none());
    for sha in ["--hard", "a b"] {
        let refused = fixture
            .call("git_revert_commit", json!({ "sha": sha }))
            .await;
        assert_eq!(error_tag(&refused), "McpInvalidArgumentError", "{sha}");
    }
    let unknown_remote = fixture
        .call("git_fetch", json!({ "remote": "elsewhere" }))
        .await;
    assert_eq!(error_tag(&unknown_remote), "McpInvalidArgumentError");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn discard_trashes_files_or_reports_that_the_trash_cannot_take_them() {
    let fixture = fixture().await;
    fixture.write("a.txt", "changed\n");
    let discarded = fixture
        .call("git_discard", json!({ "paths": ["a.txt"] }))
        .await;
    let discarded = structured(&discarded);
    assert_eq!(discarded["trashed"], json!(["a.txt"]));
    assert_eq!(fixture.read("a.txt").as_deref(), Some("a\n"));
    assert_eq!(discarded["status"]["hasWorkingTreeChanges"], false);

    fixture.trash.available.store(false, Ordering::SeqCst);
    fixture.write("b.txt", "untracked\n");
    let kept = fixture
        .call("git_discard", json!({ "paths": ["b.txt"] }))
        .await;
    assert_eq!(structured(&kept)["trashUnavailable"], json!(["b.txt"]));
    assert!(fixture.read("b.txt").is_some());
    let gone = fixture
        .call(
            "git_discard",
            json!({ "paths": ["b.txt"], "permanent": true }),
        )
        .await;
    assert_eq!(structured(&gone)["permanentlyDiscarded"], json!(["b.txt"]));
    assert!(fixture.read("b.txt").is_none());
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn undo_commit_returns_the_message_and_keeps_the_changes() {
    let fixture = fixture().await;
    fixture.write("c.txt", "c\n");
    structured(
        &fixture
            .call("git_stage", json!({ "paths": ["c.txt"] }))
            .await,
    );
    structured(
        &fixture
            .call(
                "git_commit",
                json!({ "summary": "Undo me", "description": "The body." }),
            )
            .await,
    );
    let undone = fixture.call("git_undo_commit", json!({})).await;
    let undone = structured(&undone);
    assert_eq!(undone["summary"], "Undo me");
    assert_eq!(undone["description"], "The body.");
    assert_eq!(fixture.git(&["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(fixture.read("c.txt").as_deref(), Some("c\n"));
    // The base commit was pushed, so it is not undone.
    let refused = fixture.call("git_undo_commit", json!({})).await;
    assert_eq!(error(&refused)["code"], "commit-not-local");
    fixture.harness.shutdown().await;
}

/// Creates `feature` without switching to it and publishes it to `origin`.
async fn publish_feature(fixture: &Fixture) {
    let created = fixture
        .call(
            "git_create_branch",
            json!({ "name": "feature", "checkout": false }),
        )
        .await;
    assert_eq!(structured(&created)["operation"], "branch-create");
    let published = fixture
        .call("git_push", json!({ "branch": "feature" }))
        .await;
    assert_eq!(structured(&published)["operation"], "publish-branch");
    assert_eq!(
        fixture.git(&["rev-parse", "--abbrev-ref", "feature@{upstream}"]),
        "origin/feature"
    );
}

fn branches(cwd: &Path) -> String {
    git(cwd, &["branch", "--format=%(refname:short)"])
}

#[tokio::test]
async fn delete_branch_with_delete_remote_removes_both_branches() {
    let fixture = fixture().await;
    publish_feature(&fixture).await;
    assert_eq!(branches(&fixture.remote), "feature\nmain");
    let deleted = fixture
        .call(
            "git_delete_branch",
            json!({ "name": "feature", "deleteRemote": true }),
        )
        .await;
    let deleted = structured(&deleted);
    assert_eq!(deleted["local"], "deleted");
    assert_eq!(deleted["remote"], "deleted");
    assert_eq!(branches(&fixture.repo), "main");
    assert_eq!(branches(&fixture.remote), "main");

    // Without an upstream nothing is deleted.
    structured(
        &fixture
            .call(
                "git_create_branch",
                json!({ "name": "solo", "checkout": false }),
            )
            .await,
    );
    let refused = fixture
        .call(
            "git_delete_branch",
            json!({ "name": "solo", "deleteRemote": true }),
        )
        .await;
    assert_eq!(error(&refused)["code"], "no-upstream");
    assert_eq!(branches(&fixture.repo), "main\nsolo");
    let local_only = fixture
        .call("git_delete_branch", json!({ "name": "solo" }))
        .await;
    assert_eq!(structured(&local_only)["remote"], "not-requested");
    assert_eq!(branches(&fixture.repo), "main");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn a_refused_remote_delete_is_a_partial_outcome_that_replays_and_recovers() {
    let fixture = fixture().await;
    publish_feature(&fixture).await;
    fixture.remote_git(&["config", "receive.denyDeletes", "true"]);
    let arguments = json!({ "name": "feature", "deleteRemote": true, "clientRequestId": "del-1" });
    let partial = fixture.call("git_delete_branch", arguments.clone()).await;
    assert_eq!(error_tag(&partial), "McpPartialOutcomeError");
    let outcome = error(&partial);
    assert_eq!(outcome["local"], "deleted");
    assert_eq!(outcome["remote"], "failed");
    assert_eq!(outcome["remoteName"], "origin");
    assert_eq!(outcome["remoteBranch"], "feature");
    assert_eq!(outcome["recovery"]["tool"], "git_delete_remote_branch");
    assert_eq!(
        outcome["recovery"]["arguments"],
        json!({ "remote": "origin", "branch": "feature" })
    );
    assert_eq!(branches(&fixture.repo), "main");
    assert_eq!(branches(&fixture.remote), "feature\nmain");

    // A keyed retry replays the partial: the truth, not a second attempt.
    let replayed = fixture.call("git_delete_branch", arguments).await;
    assert_eq!(error(&replayed), outcome);

    fixture.remote_git(&["config", "receive.denyDeletes", "false"]);
    let recovered = fixture
        .call(
            "git_delete_remote_branch",
            outcome["recovery"]["arguments"].clone(),
        )
        .await;
    assert_eq!(structured(&recovered)["operation"], "remote-branch-delete");
    assert_eq!(branches(&fixture.remote), "main");
    for (remote, branch) in [("elsewhere", "main"), ("origin", "-x"), ("origin", "a:b")] {
        let refused = fixture
            .call(
                "git_delete_remote_branch",
                json!({ "remote": remote, "branch": branch }),
            )
            .await;
        assert!(refused["isError"] == true, "{remote} {branch}");
    }
    assert_eq!(branches(&fixture.remote), "main");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn a_dirty_switch_is_blocked_with_its_reason_and_stash_carries_the_changes() {
    let fixture = fixture().await;
    structured(
        &fixture
            .call(
                "git_create_branch",
                json!({ "name": "other", "startPoint": "main", "checkout": false }),
            )
            .await,
    );
    fixture.git(&["commit", "-q", "--allow-empty", "-m", "ahead"]);
    fixture.write("a.txt", "dirty\n");
    let blocked = fixture
        .call("git_switch_branch", json!({ "name": "other" }))
        .await;
    assert_eq!(error_tag(&blocked), "GitOperationFailedError", "{blocked}");
    assert!(error(&blocked)["code"].is_string(), "{blocked}");
    assert!(error(&blocked)["blocked"].is_object(), "{blocked}");
    assert_eq!(fixture.git(&["branch", "--show-current"]), "main");

    let switched = fixture
        .call(
            "git_switch_branch",
            json!({ "name": "other", "carryChanges": "stash" }),
        )
        .await;
    let switched = structured(&switched);
    assert_eq!(switched["stashed"], true);
    assert_eq!(switched["status"]["branch"], "other");
    assert_eq!(fixture.read("a.txt").as_deref(), Some("a\n"));
    assert_eq!(fixture.git(&["stash", "list"]).lines().count(), 1);

    // A clean folder has nothing to stash; the switch still happens.
    let back = fixture
        .call(
            "git_switch_branch",
            json!({ "name": "main", "carryChanges": "stash" }),
        )
        .await;
    assert_eq!(structured(&back)["stashed"], false);
    assert_eq!(fixture.git(&["branch", "--show-current"]), "main");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn paths_that_leave_the_folder_or_use_pathspec_magic_are_refused() {
    let fixture = fixture().await;
    fixture.write("src/b.txt", "b\n");
    fixture.write("a.txt", "changed\n");
    for path in [
        "../outside",
        "/etc/passwd",
        ":(glob)**",
        "*.txt",
        "src/[ab].txt",
    ] {
        let refused = fixture.call("git_stage", json!({ "paths": [path] })).await;
        assert_eq!(error_tag(&refused), "McpInvalidArgumentError", "{path}");
    }
    assert_eq!(fixture.git(&["diff", "--cached", "--name-only"]), "");

    // Called directly, as the Source Control panel does, the handler takes paths literally.
    let registry = fixture.harness.control.registry();
    let magic = registry
        .invoke_local(
            "vcs.stageFiles",
            json!({ "cwd": fixture.repo, "filePaths": [":(glob)**"] }),
            fixture.context(),
            CancellationToken::new(),
        )
        .await;
    assert!(magic.is_err(), "{magic:?}");
    assert_eq!(fixture.git(&["diff", "--cached", "--name-only"]), "");
    registry
        .invoke_local(
            "vcs.stageFiles",
            json!({ "cwd": fixture.repo, "filePaths": ["src"] }),
            fixture.context(),
            CancellationToken::new(),
        )
        .await
        .expect("a folder stages");
    assert_eq!(
        fixture.git(&["diff", "--cached", "--name-only"]),
        "src/b.txt"
    );
    fixture.harness.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_discard_through_a_symlinked_folder_that_leaves_the_worktree_is_refused() {
    let fixture = fixture().await;
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(outside.path().join("victim.txt"), "keep\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), fixture.repo.join("link")).unwrap();
    let refused = fixture
        .call(
            "git_discard",
            json!({ "paths": ["link/victim.txt"], "permanent": true }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpInvalidArgumentError");
    // The handler refuses it too, for any caller.
    let direct = fixture
        .harness
        .control
        .registry()
        .invoke_local(
            "gitManager.discard",
            json!({ "cwd": fixture.repo, "paths": ["link/victim.txt"], "permitPermanent": true }),
            fixture.context(),
            CancellationToken::new(),
        )
        .await;
    assert!(direct.is_err(), "{direct:?}");
    assert_eq!(
        std::fs::read_to_string(outside.path().join("victim.txt")).unwrap(),
        "keep\n"
    );
    assert_eq!(fixture.trash.count.load(Ordering::SeqCst), 0);
    fixture.harness.shutdown().await;
}

/// Installs a `pre-receive` hook on the remote that runs `script`.
#[cfg(unix)]
fn hook(fixture: &Fixture, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = fixture.remote.join("hooks/pre-receive");
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
async fn until(mut done: impl FnMut() -> bool) {
    for _ in 0..400 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the condition never held");
}

#[cfg(unix)]
#[tokio::test]
async fn a_cancelled_keyed_push_still_lands_and_its_retry_returns_the_outcome() {
    let fixture = fixture().await;
    let started = fixture.remote.join("push-started");
    hook(
        &fixture,
        &format!("touch '{}'\nsleep 2", started.to_string_lossy()),
    );
    fixture.git(&["commit", "-q", "--allow-empty", "-m", "slow"]);
    let head = fixture.git(&["rev-parse", "HEAD"]);
    let token = CancellationToken::new();
    let arguments = json!({ "clientRequestId": "push-1" });
    let call = fixture.spawn("git_push", arguments.clone(), token.clone());
    until(|| started.exists()).await;
    token.cancel();
    assert_eq!(error_tag(&call.await.unwrap()), "McpCancelledError");
    // The retry waits for the work it started, then reads its outcome.
    let retried = fixture.call("git_push", arguments.clone()).await;
    assert_eq!(structured(&retried)["operation"], "push");
    assert_eq!(fixture.remote_git(&["rev-parse", "main"]), head);
    let again = fixture.call("git_push", arguments).await;
    assert_eq!(structured(&again)["operation"], "push");
    fixture.harness.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn turning_mcp_off_mid_push_records_unknown() {
    let fixture = fixture().await;
    let started = fixture.remote.join("push-started");
    hook(
        &fixture,
        &format!("touch '{}'\nsleep 30", started.to_string_lossy()),
    );
    fixture.git(&["commit", "-q", "--allow-empty", "-m", "slow"]);
    let arguments = json!({ "clientRequestId": "push-off" });
    let call = fixture.spawn("git_push", arguments.clone(), CancellationToken::new());
    until(|| started.exists()).await;
    fixture
        .harness
        .settings
        .send_modify(|settings| settings.enabled = false);
    let interrupted = tokio::time::timeout(Duration::from_secs(20), call)
        .await
        .expect("the push stops")
        .unwrap();
    assert_eq!(error_tag(&interrupted), "McpOutcomeUnknownError");
    assert_eq!(error(&interrupted)["reason"], "mcp-disabled");
    fixture
        .harness
        .settings
        .send_modify(|settings| settings.enabled = true);
    let retried = fixture.call("git_push", arguments).await;
    assert_eq!(error_tag(&retried), "McpOutcomeUnknownError");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn tools_list_carries_each_tools_hints_and_source_control_off_hides_them() {
    let fixture = fixture().await;
    let listed = fixture.harness.control.tools(&fixture.agent);
    let hints = |name: &str| {
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} is listed"))["annotations"]
            .clone()
    };
    // (destructive, idempotent, open world)
    for (name, expected) in [
        ("git_stage", (false, false, false)),
        ("git_unstage", (false, false, false)),
        ("git_commit", (false, false, false)),
        ("git_undo_commit", (true, false, false)),
        ("git_revert_commit", (false, false, false)),
        ("git_push", (false, false, true)),
        ("git_force_push", (true, false, true)),
        ("git_fetch", (false, true, true)),
        ("git_pull", (false, false, true)),
        ("git_create_branch", (false, false, false)),
        ("git_switch_branch", (false, false, false)),
        ("git_delete_branch", (true, false, true)),
        ("git_delete_remote_branch", (true, false, true)),
        ("git_discard", (true, false, false)),
    ] {
        let hints = hints(name);
        assert_eq!(hints["readOnlyHint"], false, "{name}");
        assert_eq!(
            (
                hints["destructiveHint"].as_bool().unwrap(),
                hints["idempotentHint"].as_bool().unwrap(),
                hints["openWorldHint"].as_bool().unwrap(),
            ),
            expected,
            "{name}"
        );
    }
    fixture.harness.settings.send_modify(|settings| {
        settings.capabilities.source_control = false;
    });
    let listed = fixture.harness.control.tools(&fixture.agent);
    assert!(
        !listed
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"].as_str().unwrap().starts_with("git_")),
        "{listed}"
    );
    let refused = fixture.call("git_push", json!({})).await;
    assert_eq!(error_tag(&refused), "McpCapabilityDisabledError");
    fixture.harness.shutdown().await;
}

#[derive(Clone, Default)]
struct CapturedLog(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Logs carry tool names, ids and outcomes, and one line per destructive call, never a path,
/// a commit message or a branch name. In a process of its own, so no sibling test can turn a
/// callsite off for this capture.
#[tokio::test]
async fn the_log_never_sees_a_path_a_commit_message_or_a_branch_name() {
    let Some(child) = crate::test_support::in_own_process(
        "production::mcp_tools_tests::git::the_log_never_sees_a_path_a_commit_message_or_a_branch_name",
    ) else {
        return;
    };
    let log = CapturedLog::default();
    let _logging = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer({
                let log = log.clone();
                move || log.clone()
            })
            .finish(),
    );
    let fixture = fixture().await;
    fixture.write("pathcanary.txt", "x\n");
    structured(
        &fixture
            .call("git_stage", json!({ "paths": ["pathcanary.txt"] }))
            .await,
    );
    structured(
        &fixture
            .call("git_commit", json!({ "summary": "MESSAGECANARY" }))
            .await,
    );
    structured(
        &fixture
            .call(
                "git_create_branch",
                json!({ "name": "branchcanary", "checkout": false }),
            )
            .await,
    );
    structured(
        &fixture
            .call("git_delete_branch", json!({ "name": "branchcanary" }))
            .await,
    );
    fixture.write("discardcanary.txt", "x\n");
    structured(
        &fixture
            .call("git_discard", json!({ "paths": ["discardcanary.txt"] }))
            .await,
    );
    // A refused call is logged at the boundary too.
    fixture
        .call("git_switch_branch", json!({ "name": "missingcanary" }))
        .await;
    fixture.harness.shutdown().await;
    let log = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("MCP destructive tool"), "{log}");
    for canary in [
        "pathcanary",
        "MESSAGECANARY",
        "branchcanary",
        "discardcanary",
        "missingcanary",
    ] {
        assert!(!log.contains(canary), "{canary} reached the log:\n{log}");
    }
    child.complete();
}
