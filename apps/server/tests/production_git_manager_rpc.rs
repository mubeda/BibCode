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
        let broadcaster = StatusBroadcaster::new(repository.clone(), Duration::from_secs(3_600), 8);
        let availability = WorkspaceAvailabilityRegistry::new();
        let catalog = WorktreeCatalogService::new_with_availability_registry(
            Arc::new(repositories.clone()),
            repository.clone(),
            availability.clone(),
        );
        let services = GitManagerRpcServices::with_dependencies(
            repository,
            broadcaster,
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
    RpcRequest {
        id: RequestId::try_from(id).expect("request id"),
        tag: "gitManager.runOperation".to_owned(),
        payload,
        headers: Vec::new(),
        trace_id: None,
        span_id: None,
        sampled: None,
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
