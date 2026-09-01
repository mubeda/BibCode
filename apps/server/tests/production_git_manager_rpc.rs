use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::Arc,
    time::Duration,
};

use bibcode_server::{
    RequestId, RpcRequest,
    git::{GitRepository, NativeFileTrash, StatusBroadcaster},
    persistence::{Database, ProjectionProject, Repositories, run_migrations},
    production::git_manager_rpc::{ConfiguredGitManagerRpcServices, GitManagerRpcServices},
    worktree_catalog::{WorkspaceAvailabilityRegistry, WorktreeCatalogService},
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep, timeout};
use tokio_util::sync::CancellationToken;

struct Fixture {
    _root: TempDir,
    repository_path: PathBuf,
    remote_path: PathBuf,
    services: ConfiguredGitManagerRpcServices,
}

impl Fixture {
    async fn new() -> Self {
        let root = TempDir::new().expect("temporary Git Manager fixture");
        let repository_path = root.path().join("main");
        let remote_path = root.path().join("remote.git");
        fs::create_dir(&repository_path).expect("main checkout directory");
        git(root.path(), &["init", "-q", "--bare", path(&remote_path)]);
        git(&repository_path, &["init", "-q", "-b", "main"]);
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

#[cfg(unix)]
#[tokio::test]
async fn concurrent_operation_is_rejected_and_cancellation_terminates_the_child() {
    use std::os::unix::fs::PermissionsExt;

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

async fn wait_for_file(path: &Path) {
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

fn path(path: &Path) -> &str {
    path.to_str().expect("UTF-8 temporary path")
}
