//! Keeps each project's server-authored repository identity in step with its `origin`.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, LazyLock, Mutex, PoisonError},
    time::{Duration, Instant, SystemTime},
};

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    git::{GitCommandError, GitRepository},
    orchestration::{OrchestrationCommand, OrchestrationEngine},
    source_control::repository_identity::repository_identity,
};

/// One lock per project serializes its reconciles, so a slow `origin` read cannot overwrite a newer
/// one: each reconcile reads the project and the checkout under the lock, and a workspace move
/// queues its own reconcile behind any stale one. Entries nobody holds are pruned on each lookup.
static PROJECT_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Mutex::default);

/// Bounds the `git` children reconciles run at once across projects; a burst of creations or
/// workspace moves waits here instead of launching a process each.
static GIT_READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

fn project_lock(project_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = PROJECT_LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
    locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    locks.entry(project_id.to_owned()).or_default().clone()
}

/// `Some(identity)` only when the checkout is confirmed to be a repository, where `identity` is
/// `None` for an `origin` that names no hosted repository. `None` means the checkout could not be
/// read as a repository (missing, refused, or a Git failure), which says nothing about its origin.
async fn read_repository_identity(
    repository: &GitRepository,
    workspace_root: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<Option<Value>>, GitCommandError> {
    let Some(root) = repository
        .repository_root(workspace_root, cancellation)
        .await?
    else {
        return Ok(None);
    };
    let remote = repository.origin_url(workspace_root, cancellation).await?;
    Ok(Some(remote.and_then(|remote| {
        repository_identity(&remote, &root.to_string_lossy().replace('\\', "/"))
    })))
}

/// Dispatches an identity update when the checkout's `origin` no longer matches
/// the stored identity. An unreadable or missing checkout keeps the stored value.
pub(crate) async fn reconcile_repository_identity(
    engine: &OrchestrationEngine,
    repository: &GitRepository,
    project_id: &str,
    cancellation: &CancellationToken,
) -> bool {
    let project_lock = project_lock(project_id);
    // Biased so an already-cancelled reconcile never wins an uncontended race and dispatches.
    let _serialized = tokio::select! {
        biased;
        () = cancellation.cancelled() => return false,
        guard = project_lock.lock() => guard,
    };
    let Ok(Some(project)) = engine
        .repositories()
        .get_project(project_id.to_owned())
        .await
    else {
        return false;
    };
    if project.deleted_at.is_some() {
        return false;
    }
    let workspace_root = Path::new(&project.workspace_root);
    let _permit = tokio::select! {
        biased;
        () = cancellation.cancelled() => return false,
        permit = GIT_READS.acquire() => match permit {
            Ok(permit) => permit,
            Err(_) => return false,
        },
    };
    let observed = match read_repository_identity(repository, workspace_root, cancellation).await {
        Ok(Some(observed)) => observed,
        Ok(None) => return false,
        // The error text can include Git output such as the remote URL, so it is not logged.
        Err(_) => {
            tracing::debug!(
                project_id,
                "repository identity read failed; keeping the stored value"
            );
            return false;
        }
    };
    if observed == project.repository_identity {
        return false;
    }
    let command = OrchestrationCommand::ProjectRepositoryIdentitySet {
        command_id: format!("repository-identity:{}", Uuid::new_v4()),
        project_id: project_id.to_owned(),
        repository_identity: observed,
    };
    match engine.dispatch(command).await {
        Ok(_) => true,
        Err(error) => {
            let error = crate::diagnostics::redact_sensitive_text(&error.to_string());
            tracing::warn!(project_id, %error, "could not record the repository identity");
            false
        }
    }
}

/// One sequential startup pass so existing projects group without being re-added.
pub(crate) async fn backfill_repository_identities(
    engine: OrchestrationEngine,
    repository: Arc<GitRepository>,
    cancellation: CancellationToken,
) {
    let projects = match engine.repositories().list_projects().await {
        Ok(projects) => projects,
        Err(error) => {
            tracing::warn!(%error, "could not list projects for the repository identity backfill");
            return;
        }
    };
    for project in projects
        .into_iter()
        .filter(|project| project.deleted_at.is_none())
    {
        if cancellation.is_cancelled() {
            return;
        }
        reconcile_repository_identity(&engine, &repository, &project.project_id, &cancellation)
            .await;
    }
}

/// The `(modified, len)` of a checkout's `.git/config`, where `origin` lives. `None` when `.git` is
/// not a directory (a linked worktree's `.git` file, a bare repository) or the stat fails.
pub(crate) type GitConfigStamp = (SystemTime, u64);

/// One stat, no Git process: cheap enough to run on every healthy catalog snapshot.
pub(crate) async fn git_config_stamp(checkout: &Path) -> Option<GitConfigStamp> {
    let metadata = tokio::fs::metadata(checkout.join(".git").join("config"))
        .await
        .ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

/// ponytail: one global map, fine for hundreds of projects; prune it if projects ever churn heavily.
#[derive(Clone, Default)]
pub(crate) struct RepositoryIdentityThrottle(Arc<Mutex<HashMap<String, LastReconcile>>>);

/// When a project last reconciled, and its `.git/config` stamp then.
type LastReconcile = (Instant, Option<GitConfigStamp>);

impl RepositoryIdentityThrottle {
    pub(crate) const INTERVAL: Duration = Duration::from_secs(300);

    /// Admits a project once per interval, or at once when its `.git/config` stamp differs from the
    /// last one seen (for example after `git remote set-url`). An unknown stamp never bypasses.
    pub(crate) fn admit(
        &self,
        project_id: &str,
        now: Instant,
        config: Option<GitConfigStamp>,
    ) -> bool {
        let mut checked = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if checked.get(project_id).is_some_and(|(last, last_config)| {
            now.duration_since(*last) < Self::INTERVAL
                && (config.is_none() || config == *last_config)
        }) {
            return false;
        }
        checked.insert(project_id.to_owned(), (now, config));
        true
    }
}

#[cfg(test)]
mod tests {
    use std::{
        process::Command,
        time::{Duration, Instant},
    };

    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    use super::*;

    fn git(dir: &std::path::Path, args: &[&str]) {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(dir)
                .status()
                .unwrap()
                .success()
        );
    }

    async fn engine_with_project(root: &str) -> OrchestrationEngine {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .unwrap();
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .unwrap();
        let engine =
            OrchestrationEngine::start(database, crate::orchestration::EngineOptions::default())
                .await
                .unwrap();
        engine
            .dispatch(serde_json::from_value(serde_json::json!({
                "type":"project.create","commandId":"create","projectId":"p","title":"P",
                "workspaceRoot":root,"defaultModelSelection":null,"createdAt":"2026-10-05T00:00:00Z"
            })).unwrap())
            .await
            .unwrap();
        engine
    }

    async fn stored(engine: &OrchestrationEngine) -> Option<serde_json::Value> {
        engine
            .repositories()
            .get_project("p".into())
            .await
            .unwrap()
            .unwrap()
            .repository_identity
    }

    #[tokio::test]
    async fn sets_identity_once_and_follows_origin_changes() {
        let checkout = TempDir::new().unwrap();
        git(checkout.path(), &["init", "-q"]);
        git(
            checkout.path(),
            &["remote", "add", "origin", "git@github.com:acme/repo.git"],
        );
        let root = checkout.path().to_string_lossy().replace('\\', "/");
        let engine = engine_with_project(&root).await;
        let git_repository = GitRepository::default();
        let cancel = CancellationToken::new();

        assert!(reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        assert_eq!(
            stored(&engine).await.unwrap()["canonicalKey"],
            "github.com/acme/repo"
        );
        assert!(!reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);

        git(
            checkout.path(),
            &[
                "remote",
                "set-url",
                "origin",
                "https://gitlab.com/acme/other.git",
            ],
        );
        assert!(reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        assert_eq!(
            stored(&engine).await.unwrap()["canonicalKey"],
            "gitlab.com/acme/other"
        );

        git(checkout.path(), &["remote", "remove", "origin"]);
        assert!(reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        assert_eq!(stored(&engine).await, None);
    }

    #[tokio::test]
    async fn a_checkout_that_is_no_longer_a_repository_keeps_the_stored_identity() {
        let checkout = TempDir::new().unwrap();
        git(checkout.path(), &["init", "-q"]);
        git(
            checkout.path(),
            &["remote", "add", "origin", "git@github.com:acme/repo.git"],
        );
        let root = checkout.path().to_string_lossy().replace('\\', "/");
        let engine = engine_with_project(&root).await;
        let git_repository = GitRepository::default();
        let cancel = CancellationToken::new();
        assert!(reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        std::fs::remove_dir_all(checkout.path().join(".git")).unwrap();
        assert!(!reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        assert_eq!(
            stored(&engine).await.unwrap()["canonicalKey"],
            "github.com/acme/repo"
        );
    }

    #[tokio::test]
    async fn a_missing_checkout_keeps_the_stored_identity() {
        let checkout = TempDir::new().unwrap();
        git(checkout.path(), &["init", "-q"]);
        git(
            checkout.path(),
            &["remote", "add", "origin", "git@github.com:acme/repo.git"],
        );
        let root = checkout.path().to_string_lossy().replace('\\', "/");
        let engine = engine_with_project(&root).await;
        let git_repository = GitRepository::default();
        let cancel = CancellationToken::new();
        assert!(reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        drop(checkout);
        assert!(!reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        assert_eq!(
            stored(&engine).await.unwrap()["canonicalKey"],
            "github.com/acme/repo"
        );
    }

    #[tokio::test]
    async fn backfill_sets_a_missing_identity_and_a_second_run_dispatches_nothing() {
        let checkout = TempDir::new().unwrap();
        git(checkout.path(), &["init", "-q"]);
        git(
            checkout.path(),
            &["remote", "add", "origin", "git@github.com:acme/repo.git"],
        );
        let root = checkout.path().to_string_lossy().replace('\\', "/");
        let engine = engine_with_project(&root).await;
        let git_repository = Arc::new(GitRepository::default());
        let backfill = || {
            backfill_repository_identities(
                engine.clone(),
                git_repository.clone(),
                CancellationToken::new(),
            )
        };

        backfill().await;
        assert_eq!(
            stored(&engine).await.unwrap()["canonicalKey"],
            "github.com/acme/repo"
        );
        let events = engine.repositories().max_event_sequence().await.unwrap();
        backfill().await;
        assert_eq!(
            engine.repositories().max_event_sequence().await.unwrap(),
            events
        );
    }

    #[tokio::test]
    async fn the_stored_identity_never_contains_remote_credentials() {
        let checkout = TempDir::new().unwrap();
        git(checkout.path(), &["init", "-q"]);
        git(
            checkout.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://oauth2:glpat-secret@gitlab.example/g/r.git",
            ],
        );
        let root = checkout.path().to_string_lossy().replace('\\', "/");
        let engine = engine_with_project(&root).await;
        let cancel = CancellationToken::new();
        assert!(
            reconcile_repository_identity(&engine, &GitRepository::default(), "p", &cancel).await
        );
        let identity = stored(&engine).await.unwrap();
        assert_eq!(
            identity["locator"]["remoteUrl"],
            "https://gitlab.example/g/r.git"
        );
        assert!(!identity.to_string().contains("secret"));
    }

    #[test]
    fn project_locks_are_shared_while_held_and_pruned_after() {
        let held = project_lock("lock-test");
        assert!(Arc::ptr_eq(&held, &project_lock("lock-test")));
        drop(held);
        project_lock("other");
        assert!(!PROJECT_LOCKS.lock().unwrap().contains_key("lock-test"));
    }

    #[test]
    fn throttle_admits_each_project_once_per_interval() {
        let throttle = RepositoryIdentityThrottle::default();
        let start = Instant::now();
        assert!(throttle.admit("p", start, None));
        assert!(!throttle.admit("p", start + Duration::from_secs(10), None));
        assert!(throttle.admit("q", start, None));
        assert!(throttle.admit("p", start + RepositoryIdentityThrottle::INTERVAL, None));
    }

    #[test]
    fn a_changed_git_config_bypasses_the_throttle_and_an_unchanged_one_does_not() {
        let throttle = RepositoryIdentityThrottle::default();
        let start = Instant::now();
        let written = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let soon = start + Duration::from_secs(10);
        assert!(throttle.admit("p", start, Some((written, 100))));
        assert!(!throttle.admit("p", soon, Some((written, 100))));
        assert!(!throttle.admit("p", soon, None));
        assert!(throttle.admit("p", soon, Some((written, 101))));
        let rewritten = written + Duration::from_secs(1);
        assert!(throttle.admit("p", soon, Some((rewritten, 101))));
        assert!(!throttle.admit("p", soon, Some((rewritten, 101))));
    }

    #[tokio::test]
    async fn the_git_config_stamp_needs_a_git_directory() {
        let checkout = TempDir::new().unwrap();
        assert_eq!(git_config_stamp(checkout.path()).await, None);
        std::fs::write(checkout.path().join(".git"), "gitdir: /elsewhere\n").unwrap();
        assert_eq!(git_config_stamp(checkout.path()).await, None);
        std::fs::remove_file(checkout.path().join(".git")).unwrap();
        git(checkout.path(), &["init", "-q"]);
        let before = git_config_stamp(checkout.path()).await.unwrap();
        git(
            checkout.path(),
            &["remote", "add", "origin", "git@github.com:acme/repo.git"],
        );
        assert_ne!(git_config_stamp(checkout.path()).await.unwrap(), before);
    }

    #[tokio::test]
    async fn a_cancelled_reconcile_waiting_for_the_project_lock_dispatches_nothing() {
        let checkout = TempDir::new().unwrap();
        git(checkout.path(), &["init", "-q"]);
        git(
            checkout.path(),
            &["remote", "add", "origin", "git@github.com:acme/repo.git"],
        );
        let root = checkout.path().to_string_lossy().replace('\\', "/");
        let engine = engine_with_project(&root).await;
        let events = engine.repositories().max_event_sequence().await.unwrap();
        let cancel = CancellationToken::new();
        let lock = project_lock("p");
        let held = lock.lock().await;
        let reconcile = tokio::spawn({
            let engine = engine.clone();
            let cancel = cancel.clone();
            async move {
                reconcile_repository_identity(&engine, &GitRepository::default(), "p", &cancel)
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
        assert!(
            !tokio::time::timeout(Duration::from_secs(5), reconcile)
                .await
                .expect("cancellation ends the wait for the project lock")
                .unwrap()
        );
        drop(held);
        assert_eq!(
            engine.repositories().max_event_sequence().await.unwrap(),
            events
        );
        assert_eq!(stored(&engine).await, None);
    }
}
