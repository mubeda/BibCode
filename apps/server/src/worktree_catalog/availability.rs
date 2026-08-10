use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use serde::Serialize;

use crate::git::{host_path_platform, normalize_worktree_path_key};

use super::{AdoptedWorktreeAvailability, WorktreeCatalogSnapshot};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceGuardState {
    MissingRegistered,
    MissingUnregistered,
    Removing,
}

impl WorkspaceGuardState {
    fn availability(self) -> AdoptedWorktreeAvailability {
        match self {
            Self::MissingRegistered => AdoptedWorktreeAvailability::MissingRegistered,
            Self::MissingUnregistered => AdoptedWorktreeAvailability::MissingUnregistered,
            Self::Removing => AdoptedWorktreeAvailability::Removing,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUnavailable {
    #[serde(rename = "_tag")]
    pub tag: &'static str,
    pub reason: &'static str,
    pub message: String,
    pub thread_id: String,
    pub path: String,
    pub availability: AdoptedWorktreeAvailability,
    #[serde(skip)]
    pub state: WorkspaceGuardState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceLossTransition {
    pub thread_id: String,
    pub repository_key: String,
    pub generation: u64,
    pub path: PathBuf,
    pub availability: AdoptedWorktreeAvailability,
}

impl WorkspaceLossTransition {
    fn guard_state(&self) -> Option<WorkspaceGuardState> {
        match self.availability {
            AdoptedWorktreeAvailability::MissingRegistered => {
                Some(WorkspaceGuardState::MissingRegistered)
            }
            AdoptedWorktreeAvailability::MissingUnregistered => {
                Some(WorkspaceGuardState::MissingUnregistered)
            }
            _ => None,
        }
    }
}

#[derive(Clone, Default)]
pub struct WorkspaceAvailabilityRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

#[derive(Default)]
struct RegistryState {
    entries: HashMap<String, GuardEntry>,
    latest_loss: HashMap<String, LossWatermark>,
    orphan_cleanups: HashMap<String, usize>,
    next_removal_id: u64,
}

#[derive(Clone)]
struct GuardEntry {
    thread_id: String,
    repository_key: String,
    path_key: String,
    path: String,
    state: WorkspaceGuardState,
    pending_missing: Option<PendingMissing>,
    removal_id: Option<u64>,
}

#[derive(Clone)]
struct PendingMissing {
    repository_key: String,
    path_key: String,
    path: String,
    state: WorkspaceGuardState,
}

#[derive(Clone, Copy)]
struct LossWatermark {
    generation: u64,
    missing_registered: bool,
    missing_unregistered: bool,
}

impl LossWatermark {
    fn new(generation: u64) -> Self {
        Self {
            generation,
            missing_registered: false,
            missing_unregistered: false,
        }
    }

    fn admit(&mut self, generation: u64, state: WorkspaceGuardState) -> bool {
        if generation < self.generation {
            return false;
        }
        if generation > self.generation {
            *self = Self::new(generation);
        }
        let admitted = match state {
            WorkspaceGuardState::MissingRegistered => &mut self.missing_registered,
            WorkspaceGuardState::MissingUnregistered => &mut self.missing_unregistered,
            WorkspaceGuardState::Removing => return false,
        };
        if *admitted {
            return false;
        }
        *admitted = true;
        true
    }
}

pub struct RemovalGuard {
    registry: WorkspaceAvailabilityRegistry,
    thread_id: String,
    removal_id: u64,
    released: bool,
}

impl WorkspaceAvailabilityRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn guard_thread(&self, thread_id: &str) -> Result<(), WorkspaceUnavailable> {
        let state = lock(&self.inner);
        state
            .entries
            .get(thread_id)
            .map_or(Ok(()), |entry| Err(unavailable(entry)))
    }

    pub async fn guard_path(&self, path: &Path) -> Result<(), WorkspaceUnavailable> {
        let lexical = normalized_path(path);
        let canonical = tokio::fs::canonicalize(path)
            .await
            .ok()
            .map(|path| normalized_path(&path));
        let state = lock(&self.inner);
        state
            .entries
            .values()
            .find(|entry| {
                path_is_within(&lexical, &entry.path_key)
                    || canonical
                        .as_deref()
                        .is_some_and(|path| path_is_within(path, &entry.path_key))
            })
            .map_or(Ok(()), |entry| Err(unavailable(entry)))
    }

    pub async fn mark_unavailable(&self, transition: WorkspaceLossTransition) -> bool {
        self.mark_unavailable_sync(transition)
    }

    fn mark_unavailable_sync(&self, transition: WorkspaceLossTransition) -> bool {
        let Some(guard_state) = transition.guard_state() else {
            return false;
        };
        let path_key = normalized_path(&transition.path);
        let path = path_key.clone();
        let mut state = lock(&self.inner);
        let watermark = state
            .latest_loss
            .entry(transition.thread_id.clone())
            .or_insert_with(|| LossWatermark::new(transition.generation));
        if !watermark.admit(transition.generation, guard_state) {
            return false;
        }

        if let Some(entry) = state.entries.get_mut(&transition.thread_id)
            && entry.state == WorkspaceGuardState::Removing
        {
            if (entry.repository_key.is_empty()
                || entry.repository_key == transition.repository_key)
                && entry.path_key == path_key
            {
                entry.repository_key = transition.repository_key.clone();
                entry.pending_missing = Some(PendingMissing {
                    repository_key: transition.repository_key,
                    path_key,
                    path,
                    state: guard_state,
                });
            }
            return false;
        }

        state.entries.insert(
            transition.thread_id.clone(),
            GuardEntry {
                thread_id: transition.thread_id,
                repository_key: transition.repository_key,
                path_key,
                path,
                state: guard_state,
                pending_missing: None,
                removal_id: None,
            },
        );
        true
    }

    pub async fn mark_removing(&self, thread_id: &str, path: &Path) -> RemovalGuard {
        let path_key = normalized_path(path);
        let mut state = lock(&self.inner);
        state.next_removal_id = state.next_removal_id.wrapping_add(1).max(1);
        let removal_id = state.next_removal_id;
        let previous = state.entries.remove(thread_id);
        let pending_missing = previous.as_ref().and_then(|entry| {
            (entry.state != WorkspaceGuardState::Removing).then(|| PendingMissing {
                repository_key: entry.repository_key.clone(),
                path_key: entry.path_key.clone(),
                path: entry.path.clone(),
                state: entry.state,
            })
        });
        let repository_key = previous
            .as_ref()
            .map(|entry| entry.repository_key.clone())
            .unwrap_or_default();
        state.entries.insert(
            thread_id.to_owned(),
            GuardEntry {
                thread_id: thread_id.to_owned(),
                repository_key,
                path: path_key.clone(),
                path_key,
                state: WorkspaceGuardState::Removing,
                pending_missing,
                removal_id: Some(removal_id),
            },
        );
        drop(state);
        RemovalGuard {
            registry: self.clone(),
            thread_id: thread_id.to_owned(),
            removal_id,
            released: false,
        }
    }

    pub async fn clear_recovered(&self, thread_id: &str, path: &Path) {
        self.clear_matching(thread_id, path, None);
    }

    pub async fn clear_recovered_in_repository(
        &self,
        thread_id: &str,
        path: &Path,
        repository_key: &str,
    ) {
        self.clear_matching(thread_id, path, Some(repository_key));
    }

    fn clear_matching(&self, thread_id: &str, path: &Path, repository_key: Option<&str>) {
        let path_key = normalized_path(path);
        let mut state = lock(&self.inner);
        let Some(entry) = state.entries.get_mut(thread_id) else {
            return;
        };
        if entry.path_key != path_key
            || repository_key.is_some_and(|repository_key| entry.repository_key != repository_key)
        {
            return;
        }
        if entry.state == WorkspaceGuardState::Removing {
            entry.pending_missing = None;
        } else {
            state.entries.remove(thread_id);
        }
    }

    pub async fn reconcile_snapshot(
        &self,
        snapshot: &WorktreeCatalogSnapshot,
    ) -> Vec<WorkspaceLossTransition> {
        self.reconcile_snapshot_sync(snapshot)
    }

    pub(crate) fn reconcile_snapshot_sync(
        &self,
        snapshot: &WorktreeCatalogSnapshot,
    ) -> Vec<WorkspaceLossTransition> {
        if !snapshot.authoritative {
            return Vec::new();
        }
        let mut admitted = Vec::new();
        for workspace in &snapshot.adopted_workspaces {
            match workspace.availability {
                AdoptedWorktreeAvailability::MissingRegistered
                | AdoptedWorktreeAvailability::MissingUnregistered => {
                    let guard_state = match workspace.availability {
                        AdoptedWorktreeAvailability::MissingRegistered => {
                            WorkspaceGuardState::MissingRegistered
                        }
                        AdoptedWorktreeAvailability::MissingUnregistered => {
                            WorkspaceGuardState::MissingUnregistered
                        }
                        _ => unreachable!(),
                    };
                    let path_key = normalized_path(Path::new(&workspace.path));
                    let already_guarded = lock(&self.inner)
                        .entries
                        .get(&workspace.thread_id)
                        .is_some_and(|entry| {
                            entry.repository_key == snapshot.repository_key
                                && entry.path_key == path_key
                                && (entry.state == guard_state
                                    || entry.state == WorkspaceGuardState::Removing)
                        });
                    if already_guarded {
                        continue;
                    }
                    let transition = WorkspaceLossTransition {
                        thread_id: workspace.thread_id.clone(),
                        repository_key: snapshot.repository_key.clone(),
                        generation: snapshot.generation,
                        path: PathBuf::from(&workspace.path),
                        availability: workspace.availability,
                    };
                    if self.mark_unavailable_sync(transition.clone()) {
                        admitted.push(transition);
                    }
                }
                AdoptedWorktreeAvailability::Present => self.clear_matching(
                    &workspace.thread_id,
                    Path::new(&workspace.path),
                    Some(&snapshot.repository_key),
                ),
                AdoptedWorktreeAvailability::VerificationUnavailable
                | AdoptedWorktreeAvailability::Removing => {}
            }
        }
        admitted
    }

    pub async fn set_orphan_cleanup_pending(&self, thread_id: &str, pending: bool) {
        let mut state = lock(&self.inner);
        if pending {
            let count = state
                .orphan_cleanups
                .entry(thread_id.to_owned())
                .or_default();
            *count = count.saturating_add(1);
        } else if let Some(count) = state.orphan_cleanups.get_mut(thread_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                state.orphan_cleanups.remove(thread_id);
            }
        }
    }

    #[must_use]
    pub fn orphan_cleanup_pending(&self, thread_id: &str) -> bool {
        let state = lock(&self.inner);
        state.entries.contains_key(thread_id)
            && state
                .orphan_cleanups
                .get(thread_id)
                .is_some_and(|count| *count > 0)
    }

    fn release_removal(&self, thread_id: &str, removal_id: u64) {
        let mut state = lock(&self.inner);
        let Some(mut entry) = state.entries.remove(thread_id) else {
            return;
        };
        if entry.removal_id != Some(removal_id) || entry.state != WorkspaceGuardState::Removing {
            state.entries.insert(thread_id.to_owned(), entry);
            return;
        }
        if let Some(pending) = entry.pending_missing.take() {
            entry.repository_key = pending.repository_key;
            entry.path_key = pending.path_key;
            entry.path = pending.path;
            entry.state = pending.state;
            entry.removal_id = None;
            state.entries.insert(thread_id.to_owned(), entry);
        }
    }
}

impl RemovalGuard {
    pub fn release(mut self) {
        self.registry
            .release_removal(&self.thread_id, self.removal_id);
        self.released = true;
    }
}

impl Drop for RemovalGuard {
    fn drop(&mut self) {
        if !self.released {
            self.registry
                .release_removal(&self.thread_id, self.removal_id);
        }
    }
}

fn unavailable(entry: &GuardEntry) -> WorkspaceUnavailable {
    WorkspaceUnavailable {
        tag: "WorkspaceUnavailableError",
        reason: "workspace-unavailable",
        message: match entry.state {
            WorkspaceGuardState::MissingRegistered => {
                "The workspace directory is missing while Git still registers the worktree."
                    .to_owned()
            }
            WorkspaceGuardState::MissingUnregistered => {
                "The workspace is no longer registered as a Git worktree.".to_owned()
            }
            WorkspaceGuardState::Removing => {
                "The workspace is being removed from BiBCode.".to_owned()
            }
        },
        thread_id: entry.thread_id.clone(),
        path: entry.path.clone(),
        availability: entry.state.availability(),
        state: entry.state,
    }
}

fn normalized_path(path: &Path) -> String {
    normalize_worktree_path_key(path, host_path_platform())
}

fn path_is_within(candidate: &str, root: &str) -> bool {
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|suffix| root.ends_with('/') || suffix.starts_with('/'))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use crate::worktree_catalog::{
        AdoptedWorktreeAvailability, AdoptedWorktreeStatus, CatalogScanStatus,
        WorktreeCatalogSnapshot,
    };

    use super::{WorkspaceAvailabilityRegistry, WorkspaceGuardState, WorkspaceLossTransition};

    fn transition(
        repository_key: &str,
        generation: u64,
        availability: AdoptedWorktreeAvailability,
    ) -> WorkspaceLossTransition {
        WorkspaceLossTransition {
            thread_id: "thread-1".to_owned(),
            repository_key: repository_key.to_owned(),
            generation,
            path: PathBuf::from("/repo/worktrees/missing"),
            availability,
        }
    }

    fn snapshot(
        authoritative: bool,
        repository_key: &str,
        generation: u64,
        availability: AdoptedWorktreeAvailability,
    ) -> WorktreeCatalogSnapshot {
        WorktreeCatalogSnapshot {
            repository_key: repository_key.to_owned(),
            generation,
            authoritative,
            observed_at: "2026-08-10T00:00:00Z".to_owned(),
            scan_status: if authoritative {
                CatalogScanStatus::Ready
            } else {
                CatalogScanStatus::Degraded {
                    reason: super::super::CatalogDegradedReason::GitFailed,
                    message: "offline".to_owned(),
                    failed_at: "2026-08-10T00:00:00Z".to_owned(),
                    last_authoritative_at: Some("2026-08-09T23:59:00Z".to_owned()),
                }
            },
            worktrees: Vec::new(),
            adopted_workspaces: vec![AdoptedWorktreeStatus {
                thread_id: "thread-1".to_owned(),
                worktree_key: None,
                path: "/repo/worktrees/missing".to_owned(),
                branch: Some("feature/missing".to_owned()),
                availability,
                registration_state: None,
                locked: false,
                lock_reason: None,
            }],
        }
    }

    #[tokio::test]
    async fn loss_token_is_admitted_once_and_guards_thread_root_and_descendants() {
        let registry = WorkspaceAvailabilityRegistry::new();
        let missing = transition(
            "repository-a",
            7,
            AdoptedWorktreeAvailability::MissingRegistered,
        );

        assert!(registry.mark_unavailable(missing.clone()).await);
        assert!(!registry.mark_unavailable(missing).await);
        let changed = transition(
            "repository-a",
            7,
            AdoptedWorktreeAvailability::MissingUnregistered,
        );
        assert!(registry.mark_unavailable(changed.clone()).await);
        assert!(!registry.mark_unavailable(changed).await);

        let thread_error = registry
            .guard_thread("thread-1")
            .await
            .expect_err("missing thread is guarded");
        assert_eq!(thread_error.state, WorkspaceGuardState::MissingUnregistered);
        assert_eq!(thread_error.thread_id, "thread-1");
        assert_eq!(thread_error.path, "/repo/worktrees/missing");
        assert_eq!(
            registry
                .guard_path(Path::new("/repo/worktrees/missing/src/lib.rs"))
                .await
                .expect_err("a nested cwd cannot bypass the workspace guard"),
            thread_error
        );
    }

    #[test]
    fn path_ancestry_handles_filesystem_roots_without_prefix_false_positives() {
        assert!(super::path_is_within("/repo/file", "/"));
        assert!(super::path_is_within("c:/repo/file", "c:/"));
        assert!(!super::path_is_within("/repository/file", "/repo"));
    }

    #[tokio::test]
    async fn recovery_requires_the_same_thread_path_and_repository() {
        let registry = WorkspaceAvailabilityRegistry::new();
        assert!(
            registry
                .mark_unavailable(transition(
                    "repository-a",
                    8,
                    AdoptedWorktreeAvailability::MissingUnregistered,
                ))
                .await
        );

        registry
            .clear_recovered_in_repository(
                "thread-1",
                Path::new("/repo/worktrees/other"),
                "repository-a",
            )
            .await;
        registry
            .clear_recovered_in_repository(
                "thread-1",
                Path::new("/repo/worktrees/missing"),
                "repository-b",
            )
            .await;
        assert!(registry.guard_thread("thread-1").await.is_err());

        registry
            .clear_recovered_in_repository(
                "thread-1",
                Path::new("/repo/worktrees/missing"),
                "repository-a",
            )
            .await;
        assert_eq!(registry.guard_thread("thread-1").await, Ok(()));
    }

    #[tokio::test]
    async fn removing_precedes_concurrent_loss_and_restores_latest_missing_state_on_release() {
        let registry = WorkspaceAvailabilityRegistry::new();
        assert!(
            registry
                .mark_unavailable(transition(
                    "repository-a",
                    9,
                    AdoptedWorktreeAvailability::MissingRegistered,
                ))
                .await
        );
        let removal = registry
            .mark_removing("thread-1", Path::new("/repo/worktrees/missing"))
            .await;
        let removing = registry
            .guard_thread("thread-1")
            .await
            .expect_err("removing workspace remains guarded");
        assert_eq!(removing.state, WorkspaceGuardState::Removing);

        assert!(
            !registry
                .mark_unavailable(transition(
                    "repository-a",
                    10,
                    AdoptedWorktreeAvailability::MissingUnregistered,
                ))
                .await
        );
        assert_eq!(
            registry
                .guard_thread("thread-1")
                .await
                .expect_err("loss cannot overwrite removing")
                .state,
            WorkspaceGuardState::Removing
        );

        drop(removal);
        assert_eq!(
            registry
                .guard_thread("thread-1")
                .await
                .expect_err("release restores the newest proven missing state")
                .state,
            WorkspaceGuardState::MissingUnregistered
        );
    }

    #[tokio::test]
    async fn degraded_snapshot_is_a_no_op_and_authoritative_recovery_clears_exact_guard() {
        let registry = WorkspaceAvailabilityRegistry::new();

        let degraded = snapshot(
            false,
            "repository-a",
            11,
            AdoptedWorktreeAvailability::MissingRegistered,
        );
        assert!(registry.reconcile_snapshot(&degraded).await.is_empty());
        assert_eq!(registry.guard_thread("thread-1").await, Ok(()));

        let missing = snapshot(
            true,
            "repository-a",
            12,
            AdoptedWorktreeAvailability::MissingRegistered,
        );
        assert_eq!(registry.reconcile_snapshot(&missing).await.len(), 1);
        assert!(registry.guard_thread("thread-1").await.is_err());

        let recovered = snapshot(
            true,
            "repository-a",
            13,
            AdoptedWorktreeAvailability::Present,
        );
        assert!(registry.reconcile_snapshot(&recovered).await.is_empty());
        assert_eq!(registry.guard_thread("thread-1").await, Ok(()));
    }

    #[tokio::test]
    async fn completing_one_reaper_job_does_not_clear_another_pending_cleanup() {
        let registry = WorkspaceAvailabilityRegistry::new();
        assert!(
            registry
                .mark_unavailable(transition(
                    "repository-a",
                    14,
                    AdoptedWorktreeAvailability::MissingRegistered,
                ))
                .await
        );
        registry.set_orphan_cleanup_pending("thread-1", true).await;
        registry.set_orphan_cleanup_pending("thread-1", true).await;

        registry.set_orphan_cleanup_pending("thread-1", false).await;
        assert!(registry.orphan_cleanup_pending("thread-1"));

        registry.set_orphan_cleanup_pending("thread-1", false).await;
        assert!(!registry.orphan_cleanup_pending("thread-1"));
    }
}
