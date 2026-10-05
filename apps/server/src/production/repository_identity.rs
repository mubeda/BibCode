//! Keeps each project's server-authored repository identity in step with its `origin`.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    git::{GitCommandError, GitRepository},
    orchestration::{OrchestrationCommand, OrchestrationEngine},
    source_control::repository_identity::repository_identity,
};

/// Serializes reconciles so a slow `origin` read cannot overwrite a newer one for the same
/// project: each reconcile reads the project and the checkout under the lock, and a workspace move
/// queues its own reconcile behind any stale one.
/// ponytail: one global lock; shard per project if a reconcile ever blocks others noticeably.
static RECONCILE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    let _serialized = RECONCILE.lock().await;
    let Ok(Some(project)) = engine
        .repositories()
        .get_project(project_id.to_owned())
        .await
    else {
        return false;
    };
    let workspace_root = Path::new(&project.workspace_root);
    if project.deleted_at.is_some() || !tokio::fs::try_exists(workspace_root).await.unwrap_or(false)
    {
        return false;
    }
    let observed = match read_repository_identity(repository, workspace_root, cancellation).await {
        Ok(Some(observed)) => observed,
        Ok(None) => return false,
        Err(error) => {
            tracing::debug!(project_id, %error, "repository identity read failed; keeping the stored value");
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
    let Ok(projects) = engine.repositories().list_projects().await else {
        return;
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

/// ponytail: one global map, fine for hundreds of projects; prune it if projects ever churn heavily.
#[derive(Clone, Default)]
pub(crate) struct RepositoryIdentityThrottle(Arc<Mutex<HashMap<String, Instant>>>);

impl RepositoryIdentityThrottle {
    pub(crate) const INTERVAL: Duration = Duration::from_secs(300);

    pub(crate) fn admit(&self, project_id: &str, now: Instant) -> bool {
        let mut checked = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if checked
            .get(project_id)
            .is_some_and(|last| now.duration_since(*last) < Self::INTERVAL)
        {
            return false;
        }
        checked.insert(project_id.to_owned(), now);
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

    #[test]
    fn throttle_admits_each_project_once_per_interval() {
        let throttle = RepositoryIdentityThrottle::default();
        let start = Instant::now();
        assert!(throttle.admit("p", start));
        assert!(!throttle.admit("p", start + Duration::from_secs(10)));
        assert!(throttle.admit("q", start));
        assert!(throttle.admit("p", start + RepositoryIdentityThrottle::INTERVAL));
    }
}
