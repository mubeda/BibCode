use std::{
    path::{Path, PathBuf},
    process::Command,
};

use bibcode_server::{
    orchestration::engine::{
        DispatchResult, EngineOptions, OrchestrationCommand, OrchestrationEngine,
    },
    persistence::{Database, PersistenceError, run_migrations},
    production::orchestration_effects::install_project_command_effects,
};
use serde_json::json;
use tempfile::TempDir;

const CREATED_AT: &str = "2026-08-24T12:00:00.000Z";

async fn migrated_database() -> Database {
    let database = Database::open_in_memory().await.expect("database opens");
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .expect("migrations run");
    database
}

async fn start_engine(database: Database) -> OrchestrationEngine {
    let engine = OrchestrationEngine::start(database, EngineOptions::default())
        .await
        .expect("engine starts");
    install_project_command_effects(&engine);
    engine
}

fn project_create(
    command_id: &str,
    project_id: &str,
    title: &str,
    workspace_root: &Path,
) -> OrchestrationCommand {
    serde_json::from_value(json!({
        "type": "project.create",
        "commandId": command_id,
        "projectId": project_id,
        "title": title,
        "workspaceRoot": workspace_root,
        "createWorkspaceRootIfMissing": false,
        "initializeGit": false,
        "createdAt": CREATED_AT,
    }))
    .expect("project command decodes")
}

fn project_delete(command_id: &str, project_id: &str) -> OrchestrationCommand {
    serde_json::from_value(json!({
        "type": "project.delete",
        "commandId": command_id,
        "projectId": project_id,
        "force": true,
    }))
    .expect("delete command decodes")
}

fn run_git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git starts");
    assert!(
        output.status.success(),
        "git {args:?} failed in {}: {}",
        cwd.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("git output is utf-8")
        .trim()
        .to_owned()
}

fn initialize_repository(parent: &Path, name: &str) -> PathBuf {
    let repository = parent.join(name);
    std::fs::create_dir(&repository).expect("repository directory creates");
    run_git(&repository, &["init"]);
    run_git(&repository, &["config", "user.name", "BiBCode Test"]);
    run_git(
        &repository,
        &["config", "user.email", "bibcode@example.test"],
    );
    std::fs::write(repository.join("tracked.txt"), "baseline\n").expect("fixture writes");
    run_git(&repository, &["add", "."]);
    run_git(&repository, &["commit", "-m", "baseline"]);
    repository
}

async fn count_active_projects(database: &Database) -> i64 {
    database
        .call(|connection| {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM projection_projects WHERE deleted_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
        })
        .await
        .expect("active projects count reads")
}

async fn count_active_main_threads(database: &Database) -> i64 {
    database
        .call(|connection| {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM projection_threads WHERE kind = 'default' AND deleted_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
        })
        .await
        .expect("active Main count reads")
}

fn assert_same_existing_project(left: &DispatchResult, right: &DispatchResult) {
    assert_eq!(left.project_id, right.project_id);
    assert_eq!(left.thread_id, right.thread_id);
    assert!(left.project_id.is_some());
    assert!(left.thread_id.is_some());
    assert_eq!(
        [left.disposition.as_deref(), right.disposition.as_deref()]
            .into_iter()
            .filter(|value| *value == Some("existing"))
            .count(),
        1,
        "one racing request creates and the other reuses the winner"
    );
}

#[tokio::test]
async fn racing_creates_for_one_common_dir_return_one_project_and_main() {
    let fixture = TempDir::new().expect("fixture creates");
    let repository = initialize_repository(fixture.path(), "repository");
    let database = migrated_database().await;
    let left_engine = start_engine(database.clone()).await;
    let right_engine = start_engine(database.clone()).await;

    let (left, right) = tokio::join!(
        left_engine.dispatch(project_create(
            "create-left",
            "project-left",
            "Left",
            &repository,
        )),
        right_engine.dispatch(project_create(
            "create-right",
            "project-right",
            "Right",
            &repository,
        )),
    );
    let left = left.expect("left create succeeds");
    let right = right.expect("right create succeeds");

    assert_same_existing_project(&left, &right);
    assert_eq!(count_active_projects(&database).await, 1);
    assert_eq!(count_active_main_threads(&database).await, 1);

    left_engine.shutdown().await;
    right_engine.shutdown().await;
}

#[tokio::test]
async fn linked_worktree_reuses_the_project_that_claimed_its_common_directory() {
    let fixture = TempDir::new().expect("fixture creates");
    let repository = initialize_repository(fixture.path(), "repository");
    let linked = fixture.path().join("linked");
    run_git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            "linked-branch",
            linked.to_str().expect("fixture path is utf-8"),
        ],
    );
    let database = migrated_database().await;
    let engine = start_engine(database.clone()).await;

    let owner = engine
        .dispatch(project_create(
            "create-owner",
            "project-owner",
            "Owner",
            &repository,
        ))
        .await
        .expect("owner creates");
    let duplicate = engine
        .dispatch(project_create(
            "create-linked",
            "project-linked",
            "Linked",
            &linked,
        ))
        .await
        .expect("linked worktree resolves");

    assert_eq!(duplicate.project_id, owner.project_id);
    assert_eq!(duplicate.thread_id, owner.thread_id);
    assert_eq!(duplicate.disposition.as_deref(), Some("existing"));
    assert_eq!(count_active_projects(&database).await, 1);

    engine.shutdown().await;
}

#[tokio::test]
async fn independent_clones_of_one_remote_create_distinct_projects() {
    let fixture = TempDir::new().expect("fixture creates");
    let source = initialize_repository(fixture.path(), "source");
    let first = fixture.path().join("first-clone");
    let second = fixture.path().join("second-clone");
    run_git(
        fixture.path(),
        &[
            "clone",
            source.to_str().expect("fixture path is utf-8"),
            first.to_str().expect("fixture path is utf-8"),
        ],
    );
    run_git(
        fixture.path(),
        &[
            "clone",
            source.to_str().expect("fixture path is utf-8"),
            second.to_str().expect("fixture path is utf-8"),
        ],
    );
    let database = migrated_database().await;
    let engine = start_engine(database.clone()).await;

    let first_result = engine
        .dispatch(project_create(
            "create-first-clone",
            "project-first-clone",
            "First clone",
            &first,
        ))
        .await
        .expect("first clone creates");
    let second_result = engine
        .dispatch(project_create(
            "create-second-clone",
            "project-second-clone",
            "Second clone",
            &second,
        ))
        .await
        .expect("second clone creates");

    assert_ne!(first_result.project_id, second_result.project_id);
    assert_eq!(first_result.disposition.as_deref(), Some("created"));
    assert_eq!(second_result.disposition.as_deref(), Some("created"));
    assert_eq!(count_active_projects(&database).await, 2);

    engine.shutdown().await;
}

#[tokio::test]
async fn guarded_project_delete_releases_its_repository_claim() {
    let fixture = TempDir::new().expect("fixture creates");
    let repository = initialize_repository(fixture.path(), "repository");
    let database = migrated_database().await;
    let engine = start_engine(database.clone()).await;

    engine
        .dispatch(project_create(
            "create-original",
            "project-original",
            "Original",
            &repository,
        ))
        .await
        .expect("original creates");
    engine
        .dispatch(project_delete("delete-original", "project-original"))
        .await
        .expect("guarded project delete succeeds");
    let replacement = engine
        .dispatch(project_create(
            "create-replacement",
            "project-replacement",
            "Replacement",
            &repository,
        ))
        .await
        .expect("replacement creates");

    assert_eq!(
        replacement.project_id.as_deref(),
        Some("project-replacement")
    );
    assert_eq!(replacement.disposition.as_deref(), Some("created"));
    assert_eq!(count_active_projects(&database).await, 1);

    engine.shutdown().await;
}

#[tokio::test]
async fn migration_rejects_conflicting_active_legacy_repository_pins() {
    let database = Database::open_in_memory().await.expect("database opens");
    let error = database
        .call(|connection| {
            run_migrations(connection, Some(45))?;
            connection.execute_batch(
                r#"
                INSERT INTO projection_projects (
                  project_id, title, workspace_root, default_model_selection_json,
                  scripts_json, worktree_discovery_json, created_at, updated_at, deleted_at
                ) VALUES
                  ('project-a', 'A', '/repo/a', NULL, '[]', '{}', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', NULL),
                  ('project-b', 'B', '/repo/b', NULL, '[]', '{}', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', NULL);
                INSERT INTO project_worktree_repository_pins(project_id, repository_key) VALUES
                  ('project-a', 'shared-repository-key'),
                  ('project-b', 'shared-repository-key');
                "#,
            )?;
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .expect_err("conflicting active repository pins reject migration");

    let detail = match error {
        PersistenceError::Sql(source) => source.to_string(),
        other => panic!("unexpected migration error: {other:?}"),
    };
    assert!(
        detail.contains("project-a"),
        "missing first project: {detail}"
    );
    assert!(
        detail.contains("project-b"),
        "missing second project: {detail}"
    );
    assert!(
        detail.contains("shared-repository-key"),
        "missing repository key: {detail}"
    );
}
