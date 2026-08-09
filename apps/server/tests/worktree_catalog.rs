use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use bibcode_server::{
    git::GitRepository,
    persistence::{Database, ProjectionProject, ProjectionThread, Repositories, run_migrations},
    worktree_catalog::{
        AdoptedWorktreeAvailability, CatalogRefreshTrigger, CatalogScanStatus,
        WorktreeCatalogService, WorktreeDirectoryState,
    },
};
use serde_json::json;
use tempfile::TempDir;

const NOW: &str = "2026-08-09T00:00:00.000Z";

#[tokio::test]
async fn real_repository_tracks_external_create_delete_prune_and_exact_path_recovery() {
    let fixture = RepositoryFixture::new().await;
    let service = fixture.service();
    let mut subscription = service
        .subscribe("project-1")
        .await
        .expect("initial catalog");
    assert_eq!(subscription.latest().worktrees.len(), 1);

    git(
        &fixture.main,
        &["worktree", "add", "-b", "feature/external"],
        Some(&fixture.external),
    );
    let discovered = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let snapshot = subscription.changed().await.expect("catalog poll update");
            if snapshot.authoritative && snapshot.worktrees.len() == 2 {
                break snapshot;
            }
        }
    })
    .await
    .expect("external worktree appears within the discovery target");
    let external_path = canonical_string(&fixture.external);
    let discovered_external = discovered
        .worktrees
        .iter()
        .find(|worktree| worktree.path == external_path)
        .expect("external descriptor");
    assert!(discovered_external.eligible_for_adoption);

    fixture
        .repositories
        .upsert_thread(workspace_thread(&fixture.external))
        .await
        .expect("adopted workspace projection");
    let adopted = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("adopted join");
    assert_eq!(
        adopted_status(&adopted, "thread-external").availability,
        AdoptedWorktreeAvailability::Present
    );

    fs::remove_dir_all(&fixture.external).expect("delete external checkout directory");
    let missing_registered = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("missing registered refresh");
    assert_eq!(
        missing_registered
            .worktrees
            .iter()
            .find(|worktree| worktree.path == external_path)
            .expect("stale registered descriptor")
            .directory_state,
        WorktreeDirectoryState::Missing
    );
    assert_eq!(
        adopted_status(&missing_registered, "thread-external").availability,
        AdoptedWorktreeAvailability::MissingRegistered
    );

    git(
        &fixture.main,
        &["worktree", "prune", "--expire", "now"],
        None,
    );
    let missing_unregistered = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("pruned refresh");
    assert!(
        missing_unregistered
            .worktrees
            .iter()
            .all(|worktree| worktree.path != external_path)
    );
    assert_eq!(
        adopted_status(&missing_unregistered, "thread-external").availability,
        AdoptedWorktreeAvailability::MissingUnregistered
    );

    let external_argument = fixture.external.to_string_lossy().into_owned();
    git(
        &fixture.main,
        &["worktree", "add", &external_argument, "feature/external"],
        None,
    );
    let recovered = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("exact path recovery");
    assert_eq!(
        adopted_status(&recovered, "thread-external").availability,
        AdoptedWorktreeAvailability::Present
    );
}

#[tokio::test]
async fn primary_checkout_loss_never_publishes_an_authoritative_empty_catalog() {
    let fixture = RepositoryFixture::new().await;
    git(
        &fixture.main,
        &["worktree", "add", "-b", "feature/fallback"],
        Some(&fixture.external),
    );
    fixture
        .repositories
        .upsert_thread(workspace_thread(&fixture.external))
        .await
        .expect("adopted fallback workspace");
    let service = fixture.service();
    let subscription = service.subscribe("project-1").await.expect("catalog");
    let authoritative = subscription.latest();
    assert_eq!(authoritative.worktrees.len(), 2);

    let displaced = fixture.root.path().join("primary-displaced");
    fs::rename(&fixture.main, &displaced).expect("displace primary checkout and common Git dir");
    let degraded = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("primary loss degrades catalog");

    assert!(!degraded.authoritative);
    assert!(matches!(
        degraded.scan_status,
        CatalogScanStatus::Degraded { .. }
    ));
    assert_eq!(degraded.generation, authoritative.generation);
    assert_eq!(degraded.worktrees, authoritative.worktrees);
    assert_eq!(
        degraded.adopted_workspaces,
        authoritative.adopted_workspaces
    );
}

#[tokio::test]
async fn git_failure_retains_the_preceding_snapshot_until_recovery() {
    let fixture = RepositoryFixture::new().await;
    let service = fixture.service();
    let subscription = service.subscribe("project-1").await.expect("catalog");
    let authoritative = subscription.latest();
    let common_dir = fixture.main.join(".git");
    let unavailable = fixture.main.join(".git-unavailable");
    fs::rename(&common_dir, &unavailable).expect("make Git metadata unavailable");

    let degraded = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("Git failure publishes degraded retention");
    assert!(!degraded.authoritative);
    assert_eq!(degraded.worktrees, authoritative.worktrees);
    fs::rename(&unavailable, &common_dir).expect("restore Git metadata");

    let recovered = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("Git recovery");
    assert!(recovered.authoritative);
    assert!(matches!(recovered.scan_status, CatalogScanStatus::Ready));
    assert_eq!(recovered.generation, authoritative.generation + 1);
}

struct RepositoryFixture {
    root: TempDir,
    main: PathBuf,
    external: PathBuf,
    repositories: Arc<Repositories>,
}

impl RepositoryFixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().expect("repository fixture root");
        let main = root.path().join("main");
        let external = root.path().join("external");
        fs::create_dir(&main).expect("primary checkout directory");
        git(&main, &["init", "--initial-branch", "main"], None);
        git(
            &main,
            &["config", "user.email", "catalog@example.invalid"],
            None,
        );
        git(&main, &["config", "user.name", "Catalog Test"], None);
        fs::write(main.join("README.md"), "catalog fixture\n").expect("fixture file");
        git(&main, &["add", "README.md"], None);
        git(&main, &["commit", "-m", "initial"], None);

        let database = Database::open_in_memory().await.expect("catalog database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("catalog migrations");
        let repositories = Arc::new(Repositories::new(database));
        repositories
            .upsert_project(project(&main))
            .await
            .expect("catalog project projection");
        Self {
            root,
            main,
            external,
            repositories,
        }
    }

    fn service(&self) -> WorktreeCatalogService {
        WorktreeCatalogService::new(
            Arc::clone(&self.repositories),
            Arc::new(GitRepository::default()),
        )
    }
}

fn project(main: &Path) -> ProjectionProject {
    ProjectionProject {
        project_id: "project-1".to_owned(),
        title: "Catalog fixture".to_owned(),
        workspace_root: main.to_string_lossy().into_owned(),
        default_model_selection: None,
        scripts: json!([]),
        worktree_discovery: json!({
            "visibility": "hidden",
            "initialPromptDismissedAt": null,
            "baselinePaths": []
        }),
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
        deleted_at: None,
    }
}

fn workspace_thread(path: &Path) -> ProjectionThread {
    ProjectionThread {
        thread_id: "thread-external".to_owned(),
        project_id: "project-1".to_owned(),
        title: "External".to_owned(),
        kind: "workspace".to_owned(),
        model_selection: json!({}),
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        branch: Some("feature/external".to_owned()),
        worktree_path: Some(canonical_string(path)),
        latest_turn_id: None,
        created_at: NOW.to_owned(),
        updated_at: NOW.to_owned(),
        archived_at: None,
        latest_user_message_at: None,
        pending_approval_count: 0,
        pending_user_input_count: 0,
        has_actionable_proposed_plan: 0,
        deleted_at: None,
    }
}

fn adopted_status<'a>(
    snapshot: &'a bibcode_server::worktree_catalog::WorktreeCatalogSnapshot,
    thread_id: &str,
) -> &'a bibcode_server::worktree_catalog::AdoptedWorktreeStatus {
    snapshot
        .adopted_workspaces
        .iter()
        .find(|workspace| workspace.thread_id == thread_id)
        .expect("adopted workspace status")
}

fn canonical_string(path: &Path) -> String {
    fs::canonicalize(path)
        .expect("canonical fixture path")
        .to_string_lossy()
        .into_owned()
}

fn git(cwd: &Path, args: &[&str], final_path: Option<&Path>) {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    if let Some(final_path) = final_path {
        command.arg(final_path);
    }
    let output = command.output().expect("run git fixture command");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        command,
        String::from_utf8_lossy(&output.stderr)
    );
}
