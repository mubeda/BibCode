use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard},
};

use serde::Serialize;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::{
    git::{host_path_platform, normalize_worktree_path_key},
    persistence::CommitFence,
};

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
    admission_changed: Arc<Notify>,
    #[cfg(test)]
    finalization_rejection_pause: Arc<Mutex<Option<FinalizationRejectionPause>>>,
    #[cfg(test)]
    terminal_signal_before_permit_pause: Arc<Mutex<Option<TerminalSignalPermitPause>>>,
    #[cfg(test)]
    terminal_signal_after_permit_pause: Arc<Mutex<Option<TerminalSignalPermitPause>>>,
}

#[derive(Default)]
struct RegistryState {
    entries: HashMap<String, GuardEntry>,
    latest_loss: HashMap<String, LossWatermark>,
    orphan_cleanups: HashMap<u64, CleanupRecord>,
    next_cleanup_id: u64,
    active_admissions: HashMap<u64, ActiveAdmission>,
    next_admission_id: u64,
    next_removal_id: u64,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum AdmissionScope {
    Thread(String),
    Path(String),
}

#[derive(Clone)]
struct GuardEntry {
    thread_id: String,
    repository_key: String,
    path_key: String,
    path: String,
    state: WorkspaceGuardState,
    terminal_signal: WorkspaceTerminalSignalGate,
    pending_missing: Option<PendingMissing>,
    removal_ids: HashSet<u64>,
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

pub struct WorkspaceAdmissionLease {
    registry: WorkspaceAvailabilityRegistry,
    admission_id: u64,
    loss_cancellation: WorkspaceAdmissionCancellation,
    finalization: WorkspaceFinalizationGate,
}

#[derive(Clone)]
pub struct WorkspaceAdmissionCancellation {
    token: CancellationToken,
    unavailable: Arc<Mutex<Option<WorkspaceUnavailable>>>,
}

struct ActiveAdmission {
    scopes: Vec<AdmissionScope>,
    loss_cancellation: WorkspaceAdmissionCancellation,
    finalization: WorkspaceFinalizationGate,
}

#[derive(Clone)]
struct WorkspaceFinalizationGate {
    inner: Arc<(Mutex<WorkspaceFinalizationState>, Condvar)>,
    loss_cancellation: WorkspaceAdmissionCancellation,
}

#[derive(Default)]
enum WorkspaceFinalizationState {
    #[default]
    Open,
    Finalizing,
    Finalized,
    Rejected,
}

struct WorkspaceFinalizationPermit {
    gate: WorkspaceFinalizationGate,
}

#[derive(Clone, Default)]
struct WorkspaceTerminalSignalGate {
    inner: Arc<(Mutex<WorkspaceTerminalSignalState>, Condvar)>,
    #[cfg(test)]
    invalidation_started: Arc<Notify>,
}

#[derive(Default)]
struct WorkspaceTerminalSignalState {
    active_permits: usize,
    invalidated: bool,
}

pub(crate) struct WorkspaceTerminalSignalPermit {
    gate: WorkspaceTerminalSignalGate,
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct FinalizationRejectionPause {
    entered: Arc<Notify>,
    release: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TerminalSignalPermitPause {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CleanupTransitionKey {
    thread_id: String,
    repository_key: String,
    generation: u64,
    path_key: String,
    state: WorkspaceGuardState,
}

struct CleanupRecord {
    transition: CleanupTransitionKey,
    cancellation: CancellationToken,
}

#[derive(Clone)]
pub struct WorkspaceCleanupOwnership {
    id: u64,
    transition: CleanupTransitionKey,
    cancellation: CancellationToken,
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

    pub async fn acquire_admission<'a>(
        &self,
        thread_id: &str,
        paths: impl IntoIterator<Item = &'a Path>,
    ) -> Result<WorkspaceAdmissionLease, WorkspaceUnavailable> {
        self.acquire_admission_inner(Some(thread_id), paths).await
    }

    pub async fn acquire_path_admission<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a Path>,
    ) -> Result<WorkspaceAdmissionLease, WorkspaceUnavailable> {
        self.acquire_admission_inner(None, paths).await
    }

    async fn acquire_admission_inner<'a>(
        &self,
        thread_id: Option<&str>,
        paths: impl IntoIterator<Item = &'a Path>,
    ) -> Result<WorkspaceAdmissionLease, WorkspaceUnavailable> {
        let mut path_keys = HashSet::new();
        for path in paths {
            path_keys.insert(normalized_path(path));
            if let Ok(canonical) = tokio::fs::canonicalize(path).await {
                path_keys.insert(normalized_path(&canonical));
            }
        }
        let mut state = lock(&self.inner);
        if let Some(thread_id) = thread_id
            && let Some(entry) = state.entries.get(thread_id)
        {
            return Err(unavailable(entry));
        }
        if let Some(entry) = state.entries.values().find(|entry| {
            path_keys
                .iter()
                .any(|path| path_is_within(path, &entry.path_key))
        }) {
            return Err(unavailable(entry));
        }

        let mut scopes = Vec::with_capacity(path_keys.len() + usize::from(thread_id.is_some()));
        scopes.extend(thread_id.map(|thread_id| AdmissionScope::Thread(thread_id.to_owned())));
        scopes.extend(path_keys.into_iter().map(AdmissionScope::Path));
        state.next_admission_id = state.next_admission_id.wrapping_add(1).max(1);
        let admission_id = state.next_admission_id;
        let loss_cancellation = WorkspaceAdmissionCancellation {
            token: CancellationToken::new(),
            unavailable: Arc::new(Mutex::new(None)),
        };
        let finalization = WorkspaceFinalizationGate::new(loss_cancellation.clone());
        state.active_admissions.insert(
            admission_id,
            ActiveAdmission {
                scopes: scopes.clone(),
                loss_cancellation: loss_cancellation.clone(),
                finalization: finalization.clone(),
            },
        );
        drop(state);
        Ok(WorkspaceAdmissionLease {
            registry: self.clone(),
            admission_id,
            loss_cancellation,
            finalization,
        })
    }

    pub async fn wait_for_transition_admissions(&self, transition: &WorkspaceLossTransition) {
        loop {
            let notified = self.admission_changed.notified();
            if !self.has_transition_admissions(transition) {
                return;
            }
            notified.await;
        }
    }

    #[must_use]
    pub fn has_transition_admissions(&self, transition: &WorkspaceLossTransition) -> bool {
        let thread = AdmissionScope::Thread(transition.thread_id.clone());
        let path = normalized_path(&transition.path);
        let state = lock(&self.inner);
        state.active_admissions.values().any(|admission| {
            admission.scopes.iter().any(|scope| {
                scope == &thread
                    || matches!(scope, AdmissionScope::Path(candidate) if path_is_within(candidate, &path))
            })
        })
    }

    pub async fn mark_unavailable(&self, transition: WorkspaceLossTransition) -> bool {
        self.mark_unavailable_sync(transition)
    }

    pub(crate) fn mark_unavailable_sync(&self, transition: WorkspaceLossTransition) -> bool {
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
        if let Some(entry) = state.entries.get(&transition.thread_id)
            && entry.state != WorkspaceGuardState::Removing
        {
            entry.terminal_signal.invalidate_and_wait();
        }
        invalidate_thread_cleanups(&mut state, &transition.thread_id);

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
                thread_id: transition.thread_id.clone(),
                repository_key: transition.repository_key.clone(),
                path_key: path_key.clone(),
                path: path.clone(),
                state: guard_state,
                terminal_signal: WorkspaceTerminalSignalGate::default(),
                pending_missing: None,
                removal_ids: HashSet::new(),
            },
        );
        let unavailable = state
            .entries
            .get(&transition.thread_id)
            .map(unavailable)
            .expect("inserted workspace guard");
        let thread_scope = AdmissionScope::Thread(transition.thread_id);
        let matching_admissions = state
            .active_admissions
            .values()
            .filter(|admission| {
                admission.scopes.iter().any(|scope| {
                    scope == &thread_scope
                        || matches!(scope, AdmissionScope::Path(candidate) if path_is_within(candidate, &path_key))
                })
            })
            .map(|admission| {
                (
                    admission.finalization.clone(),
                    admission.loss_cancellation.clone(),
                )
            })
            .collect::<Vec<_>>();
        for (finalization, _) in &matching_admissions {
            finalization.reject(unavailable.clone());
        }
        drop(state);
        #[cfg(test)]
        self.maybe_pause_after_finalization_rejection();
        for (_, loss_cancellation) in matching_admissions {
            loss_cancellation.cancel();
        }
        true
    }

    pub async fn mark_removing(&self, thread_id: &str, path: &Path) -> RemovalGuard {
        let path_key = normalized_path(path);
        let mut state = lock(&self.inner);
        state.next_removal_id = state.next_removal_id.wrapping_add(1).max(1);
        let removal_id = state.next_removal_id;
        if let Some(entry) = state.entries.get_mut(thread_id)
            && entry.state == WorkspaceGuardState::Removing
        {
            entry.removal_ids.insert(removal_id);
            drop(state);
            return RemovalGuard {
                registry: self.clone(),
                thread_id: thread_id.to_owned(),
                removal_id,
                released: false,
            };
        }
        if let Some(entry) = state.entries.get(thread_id) {
            entry.terminal_signal.invalidate_and_wait();
        }
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
                path_key: path_key.clone(),
                state: WorkspaceGuardState::Removing,
                terminal_signal: WorkspaceTerminalSignalGate::default(),
                pending_missing,
                removal_ids: HashSet::from([removal_id]),
            },
        );
        let unavailable = state
            .entries
            .get(thread_id)
            .map(unavailable)
            .expect("inserted removing guard");
        let thread_scope = AdmissionScope::Thread(thread_id.to_owned());
        let matching_admissions = state
            .active_admissions
            .values()
            .filter(|admission| {
                admission.scopes.iter().any(|scope| {
                    scope == &thread_scope
                        || matches!(scope, AdmissionScope::Path(candidate) if path_is_within(candidate, &path_key))
                })
            })
            .map(|admission| {
                (
                    admission.finalization.clone(),
                    admission.loss_cancellation.clone(),
                )
            })
            .collect::<Vec<_>>();
        for (finalization, _) in &matching_admissions {
            finalization.reject(unavailable.clone());
        }
        drop(state);
        #[cfg(test)]
        self.maybe_pause_after_finalization_rejection();
        for (_, loss_cancellation) in matching_admissions {
            loss_cancellation.cancel();
        }
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
            entry.terminal_signal.invalidate_and_wait();
            state.entries.remove(thread_id);
        }
        invalidate_thread_cleanups(&mut state, thread_id);
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

    pub fn begin_orphan_cleanup(
        &self,
        transition: &WorkspaceLossTransition,
    ) -> Option<WorkspaceCleanupOwnership> {
        let state_key = transition.guard_state()?;
        let transition_key = CleanupTransitionKey {
            thread_id: transition.thread_id.clone(),
            repository_key: transition.repository_key.clone(),
            generation: transition.generation,
            path_key: normalized_path(&transition.path),
            state: state_key,
        };
        let mut state = lock(&self.inner);
        let current = state.entries.get(&transition.thread_id)?;
        let watermark = state.latest_loss.get(&transition.thread_id)?;
        if current.repository_key != transition.repository_key
            || current.path_key != transition_key.path_key
            || current.state != state_key
            || watermark.generation != transition.generation
        {
            return None;
        }
        state.next_cleanup_id = state.next_cleanup_id.wrapping_add(1).max(1);
        let id = state.next_cleanup_id;
        let cancellation = CancellationToken::new();
        state.orphan_cleanups.insert(
            id,
            CleanupRecord {
                transition: transition_key.clone(),
                cancellation: cancellation.clone(),
            },
        );
        Some(WorkspaceCleanupOwnership {
            id,
            transition: transition_key,
            cancellation,
        })
    }

    #[must_use]
    pub fn transition_is_current(&self, transition: &WorkspaceLossTransition) -> bool {
        let Some(guard_state) = transition.guard_state() else {
            return false;
        };
        let path_key = normalized_path(&transition.path);
        let state = lock(&self.inner);
        state
            .entries
            .get(&transition.thread_id)
            .is_some_and(|entry| {
                entry.repository_key == transition.repository_key
                    && entry.path_key == path_key
                    && entry.state == guard_state
            })
            && state
                .latest_loss
                .get(&transition.thread_id)
                .is_some_and(|watermark| watermark.generation == transition.generation)
    }

    pub(crate) async fn begin_terminal_signal(
        &self,
        transition: &WorkspaceLossTransition,
    ) -> Option<WorkspaceTerminalSignalPermit> {
        #[cfg(test)]
        self.maybe_pause_before_terminal_signal_permit().await;
        let guard_state = transition.guard_state()?;
        let path_key = normalized_path(&transition.path);
        let terminal_signal = {
            let state = lock(&self.inner);
            let entry = state.entries.get(&transition.thread_id)?;
            if entry.repository_key != transition.repository_key
                || entry.path_key != path_key
                || entry.state != guard_state
                || !state
                    .latest_loss
                    .get(&transition.thread_id)
                    .is_some_and(|watermark| watermark.generation == transition.generation)
            {
                return None;
            }
            entry.terminal_signal.clone()
        };
        let permit = terminal_signal.begin()?;
        #[cfg(test)]
        self.maybe_pause_after_terminal_signal_permit().await;
        Some(permit)
    }

    #[cfg(test)]
    pub(crate) fn pause_after_next_finalization_rejection(&self) -> FinalizationRejectionPause {
        let pause = FinalizationRejectionPause {
            entered: Arc::new(Notify::new()),
            release: Arc::new((Mutex::new(false), Condvar::new())),
        };
        *lock(&self.finalization_rejection_pause) = Some(pause.clone());
        pause
    }

    #[cfg(test)]
    fn maybe_pause_after_finalization_rejection(&self) {
        let pause = lock(&self.finalization_rejection_pause).take();
        if let Some(pause) = pause {
            pause.block_until_released();
        }
    }

    #[cfg(test)]
    pub(crate) fn pause_before_next_terminal_signal_permit(&self) -> TerminalSignalPermitPause {
        let pause = TerminalSignalPermitPause::new();
        *lock(&self.terminal_signal_before_permit_pause) = Some(pause.clone());
        pause
    }

    #[cfg(test)]
    pub(crate) fn pause_after_next_terminal_signal_permit(&self) -> TerminalSignalPermitPause {
        let pause = TerminalSignalPermitPause::new();
        *lock(&self.terminal_signal_after_permit_pause) = Some(pause.clone());
        pause
    }

    #[cfg(test)]
    pub(crate) fn terminal_signal_invalidation_notification(
        &self,
        transition: &WorkspaceLossTransition,
    ) -> Option<Arc<Notify>> {
        let guard_state = transition.guard_state()?;
        let path_key = normalized_path(&transition.path);
        let state = lock(&self.inner);
        let entry = state.entries.get(&transition.thread_id)?;
        (entry.repository_key == transition.repository_key
            && entry.path_key == path_key
            && entry.state == guard_state
            && state
                .latest_loss
                .get(&transition.thread_id)
                .is_some_and(|watermark| watermark.generation == transition.generation))
        .then(|| entry.terminal_signal.invalidation_started.clone())
    }

    #[cfg(test)]
    async fn maybe_pause_before_terminal_signal_permit(&self) {
        let pause = lock(&self.terminal_signal_before_permit_pause).take();
        if let Some(pause) = pause {
            pause.pause().await;
        }
    }

    #[cfg(test)]
    async fn maybe_pause_after_terminal_signal_permit(&self) {
        let pause = lock(&self.terminal_signal_after_permit_pause).take();
        if let Some(pause) = pause {
            pause.pause().await;
        }
    }

    pub fn complete_orphan_cleanup(&self, ownership: &WorkspaceCleanupOwnership) {
        let mut state = lock(&self.inner);
        if state
            .orphan_cleanups
            .get(&ownership.id)
            .is_some_and(|record| record.transition == ownership.transition)
        {
            state.orphan_cleanups.remove(&ownership.id);
        }
    }

    #[must_use]
    pub fn cleanup_is_current(&self, ownership: &WorkspaceCleanupOwnership) -> bool {
        let state = lock(&self.inner);
        !ownership.cancellation.is_cancelled()
            && state
                .orphan_cleanups
                .get(&ownership.id)
                .is_some_and(|record| record.transition == ownership.transition)
    }

    #[must_use]
    pub fn orphan_cleanup_pending(&self, thread_id: &str) -> bool {
        let state = lock(&self.inner);
        state.entries.contains_key(thread_id)
            && state
                .orphan_cleanups
                .values()
                .any(|record| record.transition.thread_id == thread_id)
    }

    fn release_removal(&self, thread_id: &str, removal_id: u64) {
        let mut state = lock(&self.inner);
        let Some(entry) = state.entries.get_mut(thread_id) else {
            return;
        };
        if entry.state != WorkspaceGuardState::Removing
            || !entry.removal_ids.remove(&removal_id)
            || !entry.removal_ids.is_empty()
        {
            return;
        }
        let Some(mut entry) = state.entries.remove(thread_id) else {
            return;
        };
        if let Some(pending) = entry.pending_missing.take() {
            entry.repository_key = pending.repository_key;
            entry.path_key = pending.path_key;
            entry.path = pending.path;
            entry.state = pending.state;
            entry.terminal_signal = WorkspaceTerminalSignalGate::default();
            entry.removal_ids.clear();
            state.entries.insert(thread_id.to_owned(), entry);
        }
    }

    fn release_admission(&self, admission_id: u64) {
        let mut state = lock(&self.inner);
        state.active_admissions.remove(&admission_id);
        drop(state);
        self.admission_changed.notify_waiters();
    }
}

impl WorkspaceAdmissionCancellation {
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    pub async fn cancelled(&self) {
        self.token.cancelled().await;
    }

    #[must_use]
    pub fn cancellation_token(&self) -> CancellationToken {
        self.token.clone()
    }

    #[must_use]
    pub fn unavailable(&self) -> Option<WorkspaceUnavailable> {
        lock(&self.unavailable).clone()
    }

    fn publish_unavailable(&self, unavailable: WorkspaceUnavailable) {
        *lock(&self.unavailable) = Some(unavailable);
    }

    fn cancel(&self) {
        debug_assert!(lock(&self.unavailable).is_some());
        self.token.cancel();
    }
}

#[cfg(test)]
impl FinalizationRejectionPause {
    pub(crate) async fn wait_until_entered(&self) {
        self.entered.notified().await;
    }

    pub(crate) fn release(&self) {
        let (released, changed) = self.release.as_ref();
        *lock(released) = true;
        changed.notify_one();
    }

    fn block_until_released(&self) {
        self.entered.notify_one();
        let (released, changed) = self.release.as_ref();
        let mut released = lock(released);
        while !*released {
            released = changed
                .wait(released)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

#[cfg(test)]
impl TerminalSignalPermitPause {
    fn new() -> Self {
        Self {
            entered: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        }
    }

    pub(crate) async fn wait_until_entered(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(1), self.entered.notified())
            .await
            .expect("terminal signal permit pause is entered");
    }

    pub(crate) fn release(&self) {
        self.release.notify_one();
    }

    async fn pause(&self) {
        self.entered.notify_one();
        self.release.notified().await;
    }
}

impl WorkspaceAdmissionLease {
    #[must_use]
    pub fn loss_cancellation(&self) -> WorkspaceAdmissionCancellation {
        self.loss_cancellation.clone()
    }

    #[must_use]
    pub(crate) fn commit_fence(&self) -> CommitFence {
        self.finalization.commit_fence()
    }
}

impl WorkspaceFinalizationGate {
    fn new(loss_cancellation: WorkspaceAdmissionCancellation) -> Self {
        Self {
            inner: Arc::new((Mutex::new(WorkspaceFinalizationState::Open), Condvar::new())),
            loss_cancellation,
        }
    }

    fn commit_fence(&self) -> CommitFence {
        let gate = self.clone();
        CommitFence::new(move || {
            gate.begin_finalization()
                .map(|permit| Box::new(permit) as Box<dyn Send + 'static>)
        })
    }

    fn begin_finalization(&self) -> Result<WorkspaceFinalizationPermit, ()> {
        let (state, changed) = self.inner.as_ref();
        let mut state = lock(state);
        while matches!(*state, WorkspaceFinalizationState::Finalizing) {
            state = changed
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        if !matches!(*state, WorkspaceFinalizationState::Open) {
            return Err(());
        }
        *state = WorkspaceFinalizationState::Finalizing;
        Ok(WorkspaceFinalizationPermit { gate: self.clone() })
    }

    fn reject(&self, unavailable: WorkspaceUnavailable) {
        let (state, changed) = self.inner.as_ref();
        let mut state = lock(state);
        while matches!(*state, WorkspaceFinalizationState::Finalizing) {
            state = changed
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        self.loss_cancellation.publish_unavailable(unavailable);
        *state = WorkspaceFinalizationState::Rejected;
    }

    fn finish_finalization(&self) {
        let (state, changed) = self.inner.as_ref();
        let mut state = lock(state);
        if matches!(*state, WorkspaceFinalizationState::Finalizing) {
            *state = WorkspaceFinalizationState::Finalized;
        }
        drop(state);
        changed.notify_all();
    }
}

impl WorkspaceTerminalSignalGate {
    fn begin(&self) -> Option<WorkspaceTerminalSignalPermit> {
        let (state, _) = self.inner.as_ref();
        let mut state = lock(state);
        if state.invalidated {
            return None;
        }
        state.active_permits = state
            .active_permits
            .checked_add(1)
            .expect("workspace terminal signal permit count overflow");
        Some(WorkspaceTerminalSignalPermit { gate: self.clone() })
    }

    fn invalidate_and_wait(&self) {
        let (state, changed) = self.inner.as_ref();
        let mut state = lock(state);
        state.invalidated = true;
        #[cfg(test)]
        self.invalidation_started.notify_one();
        while state.active_permits > 0 {
            state = changed
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn finish_signal(&self) {
        let (state, changed) = self.inner.as_ref();
        let mut state = lock(state);
        state.active_permits = state
            .active_permits
            .checked_sub(1)
            .expect("workspace terminal signal permit underflow");
        let signal_drained = state.active_permits == 0;
        drop(state);
        if signal_drained {
            changed.notify_all();
        }
    }
}

impl Drop for WorkspaceFinalizationPermit {
    fn drop(&mut self) {
        self.gate.finish_finalization();
    }
}

impl Drop for WorkspaceTerminalSignalPermit {
    fn drop(&mut self) {
        self.gate.finish_signal();
    }
}

impl WorkspaceCleanupOwnership {
    pub async fn cancelled(&self) {
        self.cancellation.cancelled().await;
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
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

impl Drop for WorkspaceAdmissionLease {
    fn drop(&mut self) {
        self.registry.release_admission(self.admission_id);
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

fn invalidate_thread_cleanups(state: &mut RegistryState, thread_id: &str) {
    let ids = state
        .orphan_cleanups
        .iter()
        .filter_map(|(id, record)| (record.transition.thread_id == thread_id).then_some(*id))
        .collect::<Vec<_>>();
    for id in ids {
        if let Some(record) = state.orphan_cleanups.remove(&id) {
            record.cancellation.cancel();
        }
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
    async fn nested_removal_guards_preserve_missing_state_until_the_last_token_drops() {
        let registry = WorkspaceAvailabilityRegistry::new();
        assert!(
            registry
                .mark_unavailable(transition(
                    "repository-a",
                    10,
                    AdoptedWorktreeAvailability::MissingRegistered,
                ))
                .await
        );
        let outer = registry
            .mark_removing("thread-1", Path::new("/repo/worktrees/missing"))
            .await;
        let middle = registry
            .mark_removing("thread-1", Path::new("/repo/worktrees/missing"))
            .await;
        let inner = registry
            .mark_removing("thread-1", Path::new("/repo/worktrees/missing"))
            .await;

        drop(middle);
        drop(outer);
        assert_eq!(
            registry
                .guard_thread("thread-1")
                .await
                .expect_err("one live removal token retains removing precedence")
                .state,
            WorkspaceGuardState::Removing,
        );

        drop(inner);
        assert_eq!(
            registry
                .guard_thread("thread-1")
                .await
                .expect_err("the final removal token restores the pending loss")
                .state,
            WorkspaceGuardState::MissingRegistered,
        );
    }

    #[tokio::test]
    async fn removing_synchronously_cancels_an_existing_path_admission() {
        let registry = WorkspaceAvailabilityRegistry::new();
        let lease = registry
            .acquire_admission("panel-1", [Path::new("/repo/worktrees/missing/src")])
            .await
            .expect("panel admission");
        let cancellation = lease.loss_cancellation();

        let _removal = registry
            .mark_removing("thread-1", Path::new("/repo/worktrees/missing"))
            .await;

        assert!(cancellation.is_cancelled());
        assert_eq!(
            cancellation.unavailable().expect("removing error").state,
            WorkspaceGuardState::Removing
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
        let transition = transition(
            "repository-a",
            14,
            AdoptedWorktreeAvailability::MissingRegistered,
        );
        let first = registry
            .begin_orphan_cleanup(&transition)
            .expect("first cleanup ownership");
        let second = registry
            .begin_orphan_cleanup(&transition)
            .expect("second cleanup ownership");

        registry.complete_orphan_cleanup(&first);
        assert!(registry.orphan_cleanup_pending("thread-1"));

        registry.complete_orphan_cleanup(&second);
        assert!(!registry.orphan_cleanup_pending("thread-1"));
    }

    #[tokio::test]
    async fn newer_loss_invalidates_older_active_or_saturated_cleanup_ownership() {
        let registry = WorkspaceAvailabilityRegistry::new();
        let older = transition(
            "repository-a",
            15,
            AdoptedWorktreeAvailability::MissingRegistered,
        );
        assert!(registry.mark_unavailable(older.clone()).await);
        let active = registry
            .begin_orphan_cleanup(&older)
            .expect("active ownership");
        let saturated = registry
            .begin_orphan_cleanup(&older)
            .expect("saturated ownership remains registered without a job");

        let newer = transition(
            "repository-a",
            16,
            AdoptedWorktreeAvailability::MissingUnregistered,
        );
        assert!(registry.mark_unavailable(newer).await);

        assert!(active.is_cancelled());
        assert!(saturated.is_cancelled());
        assert!(!registry.cleanup_is_current(&active));
        assert!(!registry.cleanup_is_current(&saturated));
        assert!(!registry.orphan_cleanup_pending("thread-1"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn newer_loss_waits_for_all_current_terminal_signal_permits() {
        let registry = WorkspaceAvailabilityRegistry::new();
        let older = transition(
            "repository-a",
            16,
            AdoptedWorktreeAvailability::MissingRegistered,
        );
        assert!(registry.mark_unavailable(older.clone()).await);
        let first = registry
            .begin_terminal_signal(&older)
            .await
            .expect("first terminal signal permit");
        let second = registry
            .begin_terminal_signal(&older)
            .await
            .expect("second terminal signal permit");
        let invalidation_started = registry
            .terminal_signal_invalidation_notification(&older)
            .expect("current terminal signal gate");

        let newer = transition(
            "repository-a",
            17,
            AdoptedWorktreeAvailability::MissingUnregistered,
        );
        let newer_registry = registry.clone();
        let newer_transition = newer.clone();
        let newer_loss = tokio::task::spawn_blocking(move || {
            newer_registry.mark_unavailable_sync(newer_transition)
        });

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            invalidation_started.notified(),
        )
        .await
        .expect("the newer transition invalidates the old signal gate");
        drop(first);
        assert!(
            !newer_loss.is_finished(),
            "the newer transition waits for every current signal permit"
        );
        drop(second);
        assert!(
            newer_loss.await.expect("newer loss task"),
            "the newer transition installs after terminal signaling finishes"
        );
        assert!(registry.begin_terminal_signal(&older).await.is_none());
        drop(
            registry
                .begin_terminal_signal(&newer)
                .await
                .expect("new transition signal permit"),
        );
    }

    #[tokio::test]
    async fn loss_waits_for_an_earlier_path_admission_and_rejects_later_admission() {
        let registry = WorkspaceAvailabilityRegistry::new();
        let lease = registry
            .acquire_admission("panel-1", [Path::new("/repo/worktrees/missing/./src")])
            .await
            .expect("an available panel path is admitted");
        let loss = transition(
            "repository-a",
            15,
            AdoptedWorktreeAvailability::MissingRegistered,
        );
        assert!(registry.mark_unavailable(loss.clone()).await);

        let waiter_registry = registry.clone();
        let waiter_loss = loss.clone();
        let waiter = tokio::spawn(async move {
            waiter_registry
                .wait_for_transition_admissions(&waiter_loss)
                .await;
        });
        tokio::task::yield_now().await;
        assert!(
            !waiter.is_finished(),
            "loss cleanup cannot run before the earlier admission publishes"
        );

        drop(lease);
        waiter.await.expect("admission drain finishes");
        assert!(
            registry
                .acquire_admission("panel-1", [Path::new("/repo/worktrees/missing/src")],)
                .await
                .is_err(),
            "the synchronously installed path guard rejects later panel admission",
        );
    }

    #[tokio::test]
    async fn loss_synchronously_cancels_an_earlier_admission() {
        let registry = WorkspaceAvailabilityRegistry::new();
        let lease = registry
            .acquire_admission("panel-1", [Path::new("/repo/worktrees/missing/src")])
            .await
            .expect("an available panel path is admitted");
        let cancellation = lease.loss_cancellation();

        assert!(
            registry
                .mark_unavailable(transition(
                    "repository-a",
                    16,
                    AdoptedWorktreeAvailability::MissingRegistered,
                ))
                .await
        );

        assert!(
            cancellation.is_cancelled(),
            "guard installation must cancel the admitted operation before returning"
        );
        assert_eq!(
            cancellation
                .unavailable()
                .expect("loss cancellation retains the structured boundary error")
                .thread_id,
            "thread-1"
        );
    }

    #[tokio::test]
    async fn cancelled_admission_owner_releases_every_thread_and_path_scope() {
        let registry = WorkspaceAvailabilityRegistry::new();
        let task_registry = registry.clone();
        let (acquired_tx, acquired_rx) = tokio::sync::oneshot::channel();
        let owner = tokio::spawn(async move {
            let _lease = task_registry
                .acquire_admission("panel-1", [Path::new("/repo/worktrees/missing/src")])
                .await
                .expect("admission");
            acquired_tx.send(()).expect("announce admission");
            std::future::pending::<()>().await;
        });
        acquired_rx.await.expect("admission acquired");
        let loss = transition(
            "repository-a",
            16,
            AdoptedWorktreeAvailability::MissingRegistered,
        );
        assert!(registry.mark_unavailable(loss.clone()).await);
        let waiter_registry = registry.clone();
        let waiter = tokio::spawn(async move {
            waiter_registry.wait_for_transition_admissions(&loss).await;
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        owner.abort();
        assert!(owner.await.expect_err("owner was cancelled").is_cancelled());
        waiter
            .await
            .expect("cancellation drops the admission lease");
    }

    #[tokio::test]
    async fn dropping_a_finalization_permit_unblocks_loss_and_rejects_reuse() {
        let registry = WorkspaceAvailabilityRegistry::new();
        let lease = registry
            .acquire_admission("thread-1", [Path::new("/repo/worktrees/missing")])
            .await
            .expect("workspace admission");
        let fence = lease.commit_fence();
        let permit = fence.acquire().expect("finalization permit");
        let loss = transition(
            "repository-a",
            17,
            AdoptedWorktreeAvailability::MissingRegistered,
        );
        let loss_registry = registry.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let loss_task = tokio::task::spawn_blocking(move || {
            let _ = started_tx.send(());
            loss_registry.mark_unavailable_sync(loss)
        });
        started_rx.await.expect("loss task starts");
        tokio::task::yield_now().await;
        assert!(
            !loss_task.is_finished(),
            "loss waits while finalization owns the gate"
        );

        drop(permit);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), loss_task)
                .await
                .expect("loss unblocks after permit drop")
                .expect("loss task joins")
        );
        assert!(
            fence.acquire().is_err(),
            "a dropped/error finalization cannot be retried after loss"
        );
        assert!(lease.loss_cancellation().is_cancelled());
    }
}
