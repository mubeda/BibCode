use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex as StdMutex, Weak},
};

#[cfg(test)]
use tokio::sync::Notify;
use tokio::sync::{Mutex as AsyncMutex, broadcast};

use super::{
    ActivityDelta, ActivityDetailPage, ActivityRecordKind, ActivityRepository,
    ActivityRepositoryError, ActivityRosterBucket, ActivityRosterPage, ActivityScopeRef,
    ActivityScopeSeed, ActivitySection, ActivitySnapshot, AgentActivityAdmission,
    AgentActivityController, ProviderActivityMutation,
};

const DEFAULT_BROADCAST_CAPACITY: usize = 256;
const PUBLICATION_LOCK_PRUNE_THRESHOLD: usize = 256;
const RETENTION_PRUNE_PASSES_PER_TASK: usize = 4;

pub type ActivityError = ActivityRepositoryError;
pub type ActivityResult<T> = Result<T, ActivityError>;

pub(crate) struct ActivityAdmittedRead<T> {
    result: ActivityResult<T>,
    controller: AgentActivityController,
    admission: AgentActivityAdmission,
}

impl<T> ActivityAdmittedRead<T> {
    fn finish(self) -> ActivityResult<T> {
        if self.admission.is_current() {
            self.result
        } else {
            Err(ActivityRepositoryError::FeatureDisabled)
        }
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        ActivityResult<T>,
        AgentActivityController,
        AgentActivityAdmission,
    ) {
        (self.result, self.controller, self.admission)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivityProjectionEvent {
    Delta(ActivityDelta),
    ScopeReplaced {
        scope: ActivityScopeRef,
        scope_id: String,
    },
}

/// Records the ordered point at which an `apply` call has published its deltas and is ready to
/// return to its caller.
///
/// This is a deliberately narrow diagnostic for black-box concurrency integration tests. The
/// regular activity stream remains the product-facing publication mechanism.
#[doc(hidden)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityProjectionApplyCompletionForIntegrationTest {
    pub scope_id: String,
    pub previous_revision: u64,
    pub revision: u64,
}

#[derive(Clone, Debug)]
pub struct ActivityProjection {
    repository: ActivityRepository,
    controller: AgentActivityController,
    events: broadcast::Sender<ActivityProjectionEvent>,
    apply_completions: broadcast::Sender<ActivityProjectionApplyCompletionForIntegrationTest>,
    publication_locks: Arc<StdMutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
    retention_workers: Arc<StdMutex<HashSet<String>>>,
    #[cfg(test)]
    publish_pause: Arc<StdMutex<Option<TestPublishPause>>>,
}

#[cfg(test)]
#[derive(Clone, Debug)]
struct TestPublishPause {
    revision: u64,
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

#[derive(Debug)]
struct RetentionWorkerLease {
    workers: Arc<StdMutex<HashSet<String>>>,
    scope_id: String,
    _admission: AgentActivityAdmission,
    registered: bool,
}

impl RetentionWorkerLease {
    fn new(
        workers: Arc<StdMutex<HashSet<String>>>,
        scope_id: String,
        admission: AgentActivityAdmission,
    ) -> Self {
        Self {
            workers,
            scope_id,
            _admission: admission,
            registered: true,
        }
    }

    fn unregister(&mut self) {
        if !self.registered {
            return;
        }
        self.workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.scope_id);
        self.registered = false;
    }
}

impl Drop for RetentionWorkerLease {
    fn drop(&mut self) {
        self.unregister();
    }
}

impl ActivityProjection {
    #[must_use]
    pub fn new(repository: ActivityRepository) -> Self {
        Self::with_controller(repository, AgentActivityController::new(true))
    }

    #[must_use]
    pub fn with_controller(
        repository: ActivityRepository,
        controller: AgentActivityController,
    ) -> Self {
        Self::with_controller_and_capacity(repository, controller, DEFAULT_BROADCAST_CAPACITY)
    }

    #[must_use]
    pub(crate) fn agent_activity_controller(&self) -> AgentActivityController {
        self.controller.clone()
    }

    /// Returns the controller used by this projection for black-box integration diagnostics.
    #[doc(hidden)]
    #[must_use]
    pub fn agent_activity_controller_for_integration_test(&self) -> AgentActivityController {
        self.controller.clone()
    }

    #[doc(hidden)]
    #[must_use]
    pub fn with_capacity(repository: ActivityRepository, capacity: usize) -> Self {
        Self::with_controller_and_capacity(repository, AgentActivityController::new(true), capacity)
    }

    #[doc(hidden)]
    #[must_use]
    pub fn with_controller_and_capacity(
        repository: ActivityRepository,
        controller: AgentActivityController,
        capacity: usize,
    ) -> Self {
        let (events, _) = broadcast::channel(capacity.max(1));
        let (apply_completions, _) = broadcast::channel(capacity.max(1));
        Self {
            repository,
            controller,
            events,
            apply_completions,
            publication_locks: Arc::new(StdMutex::new(HashMap::new())),
            retention_workers: Arc::new(StdMutex::new(HashSet::new())),
            #[cfg(test)]
            publish_pause: Arc::new(StdMutex::new(None)),
        }
    }

    pub async fn ensure_scope(&self, seed: ActivityScopeSeed) -> ActivityResult<()> {
        let Some(admission) = self.controller.admit() else {
            return Ok(());
        };
        let scope = seed.scope.clone();
        let scope_id = seed.scope_id.clone();
        let publication_lock = self.publication_lock(&logical_scope_key(&scope));
        let _publication_guard = publication_lock.lock().await;
        let prior_scope_id = self
            .repository
            .snapshot(&scope)
            .await
            .ok()
            .map(|snapshot| snapshot.scope_id);

        self.repository.ensure_scope(seed).await?;

        if prior_scope_id.as_deref() != Some(scope_id.as_str())
            && self
                .repository
                .snapshot(&scope)
                .await
                .is_ok_and(|snapshot| snapshot.scope_id == scope_id)
        {
            self.controller.publish_if_current(&admission, || {
                let _ = self
                    .events
                    .send(ActivityProjectionEvent::ScopeReplaced { scope, scope_id });
            });
        }
        Ok(())
    }

    pub async fn apply(
        &self,
        scope_id: &str,
        native_event_key: String,
        mutations: Vec<ProviderActivityMutation>,
        created_at: String,
    ) -> ActivityResult<Vec<ActivityDelta>> {
        let Some(admission) = self.controller.admit() else {
            return Ok(Vec::new());
        };
        let publication_lock = self.publication_lock(scope_id);
        let _publication_guard = publication_lock.lock().await;
        let deltas = self
            .repository
            .apply_batch(scope_id, &native_event_key, mutations, &created_at)
            .await?;
        self.publish_deltas(&admission, &deltas).await;
        if self
            .repository
            .retention_pending(scope_id)
            .await
            .unwrap_or(false)
        {
            self.schedule_retention(scope_id.to_owned());
        }
        self.publish_apply_completion(&admission, scope_id, &deltas);
        Ok(deltas)
    }

    pub async fn interrupt_unresolved_terminal_scopes(&self) -> ActivityResult<usize> {
        self.repository.interrupt_unresolved_terminal_scopes().await
    }

    pub async fn interrupt_for_monitoring_disabled(&self) -> ActivityResult<usize> {
        let Some(finalization) = self.controller.disable_for_finalization().await else {
            return Ok(0);
        };
        let disable_generation = finalization.report().state.generation;
        let interrupted = self
            .repository
            .interrupt_unresolved_activity_scopes_for_generation(
                "Agent activity monitoring disabled",
                disable_generation,
            )
            .await?;
        self.publication_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        let stale_retention_workers = {
            let mut workers = self
                .retention_workers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let stale_retention_workers = workers.len();
            workers.clear();
            stale_retention_workers
        };
        if stale_retention_workers > 0 {
            tracing::warn!(
                stale_retention_workers,
                "cleared stale activity retention worker registrations after drain"
            );
        }
        Ok(interrupted)
    }

    async fn publish_deltas(&self, admission: &AgentActivityAdmission, deltas: &[ActivityDelta]) {
        for delta in deltas {
            #[cfg(test)]
            self.pause_before_publish(delta.revision).await;
            if !self.controller.publish_if_current(admission, || {
                let _ = self
                    .events
                    .send(ActivityProjectionEvent::Delta(delta.clone()));
            }) {
                return;
            }
        }
    }

    fn publish_apply_completion(
        &self,
        admission: &AgentActivityAdmission,
        scope_id: &str,
        deltas: &[ActivityDelta],
    ) {
        // With no diagnostic subscribers, this is one receiver-count check and does not clone or
        // allocate per-apply state. A subscriber sees the event while the same-scope publication
        // lock is still held, making this a stronger ordering boundary than task scheduling.
        if self.apply_completions.receiver_count() == 0 {
            return;
        }
        let (Some(first), Some(last)) = (deltas.first(), deltas.last()) else {
            return;
        };
        self.controller.publish_if_current(admission, || {
            let _ =
                self.apply_completions
                    .send(ActivityProjectionApplyCompletionForIntegrationTest {
                        scope_id: scope_id.to_owned(),
                        previous_revision: first.previous_revision,
                        revision: last.revision,
                    });
        });
    }

    fn schedule_retention(&self, scope_id: String) {
        let Some(admission) = self.controller.admit() else {
            return;
        };
        let scheduled = self
            .retention_workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(scope_id.clone());
        if !scheduled {
            return;
        }
        let lease = RetentionWorkerLease::new(
            Arc::clone(&self.retention_workers),
            scope_id.clone(),
            admission,
        );
        let projection = self.clone();
        tokio::spawn(async move {
            let mut lease = lease;
            loop {
                for _ in 0..RETENTION_PRUNE_PASSES_PER_TASK {
                    let pending = {
                        let publication_lock = projection.publication_lock(&scope_id);
                        let _publication_guard = publication_lock.lock().await;
                        let deltas =
                            match projection.repository.prune_retention_pass(&scope_id).await {
                                Ok(deltas) => deltas,
                                Err(_) => {
                                    projection
                                        .finish_retention_worker(&scope_id, &mut lease)
                                        .await;
                                    return;
                                }
                            };
                        projection.publish_deltas(&lease._admission, &deltas).await;
                        projection.repository.retention_pending(&scope_id).await
                    };
                    match pending {
                        Ok(false) => {
                            projection
                                .finish_retention_worker(&scope_id, &mut lease)
                                .await;
                            return;
                        }
                        Err(_) => {
                            projection
                                .finish_retention_worker(&scope_id, &mut lease)
                                .await;
                            return;
                        }
                        Ok(true) => tokio::task::yield_now().await,
                    }
                }
                tokio::task::yield_now().await;
            }
        });
    }

    async fn finish_retention_worker(&self, scope_id: &str, lease: &mut RetentionWorkerLease) {
        lease.unregister();
        if self
            .repository
            .retention_pending(scope_id)
            .await
            .unwrap_or(false)
        {
            self.schedule_retention(scope_id.to_owned());
        }
    }

    fn publication_lock(&self, scope_id: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self
            .publication_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        if let Some(lock) = locks.get(scope_id).and_then(Weak::upgrade) {
            return lock;
        }

        if locks.len() >= PUBLICATION_LOCK_PRUNE_THRESHOLD {
            locks.retain(|_, lock| lock.strong_count() > 0);
        }

        let lock = Arc::new(AsyncMutex::new(()));
        locks.insert(scope_id.to_owned(), Arc::downgrade(&lock));
        lock
    }

    pub async fn snapshot(&self, scope: &ActivityScopeRef) -> ActivityResult<ActivitySnapshot> {
        self.snapshot_admitted(scope).await?.finish()
    }

    pub(crate) async fn snapshot_admitted(
        &self,
        scope: &ActivityScopeRef,
    ) -> ActivityResult<ActivityAdmittedRead<ActivitySnapshot>> {
        self.admit_read(self.repository.snapshot(scope)).await
    }

    pub async fn list_roster(
        &self,
        scope: &ActivityScopeRef,
        scope_id: &str,
        section: ActivitySection,
        bucket: ActivityRosterBucket,
        cursor: Option<&str>,
        limit: usize,
    ) -> ActivityResult<ActivityRosterPage> {
        self.list_roster_admitted(scope, scope_id, section, bucket, cursor, limit)
            .await?
            .finish()
    }

    pub(crate) async fn list_roster_admitted(
        &self,
        scope: &ActivityScopeRef,
        scope_id: &str,
        section: ActivitySection,
        bucket: ActivityRosterBucket,
        cursor: Option<&str>,
        limit: usize,
    ) -> ActivityResult<ActivityAdmittedRead<ActivityRosterPage>> {
        self.admit_read(
            self.repository
                .list_roster(scope, scope_id, section, bucket, cursor, limit),
        )
        .await
    }

    pub async fn list_detail(
        &self,
        scope: &ActivityScopeRef,
        scope_id: &str,
        record_kind: ActivityRecordKind,
        record_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> ActivityResult<ActivityDetailPage> {
        self.list_detail_admitted(scope, scope_id, record_kind, record_id, cursor, limit)
            .await?
            .finish()
    }

    pub(crate) async fn list_detail_admitted(
        &self,
        scope: &ActivityScopeRef,
        scope_id: &str,
        record_kind: ActivityRecordKind,
        record_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> ActivityResult<ActivityAdmittedRead<ActivityDetailPage>> {
        self.admit_read(
            self.repository
                .list_detail(scope, scope_id, record_kind, record_id, cursor, limit),
        )
        .await
    }

    async fn admit_read<T>(
        &self,
        read: impl Future<Output = ActivityResult<T>>,
    ) -> ActivityResult<ActivityAdmittedRead<T>> {
        let Some(admission) = self.controller.admit() else {
            return Err(ActivityRepositoryError::FeatureDisabled);
        };
        let result = read.await;
        Ok(ActivityAdmittedRead {
            result,
            controller: self.controller.clone(),
            admission,
        })
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<ActivityProjectionEvent> {
        self.events.subscribe()
    }

    /// Internal completion-boundary diagnostic kept public because black-box integration tests
    /// link the server as a normal library, where `cfg(test)` helpers are unavailable.
    #[doc(hidden)]
    #[must_use]
    pub fn subscribe_apply_completions_for_integration_test(
        &self,
    ) -> broadcast::Receiver<ActivityProjectionApplyCompletionForIntegrationTest> {
        self.apply_completions.subscribe()
    }

    /// Internal stream-lifecycle diagnostic kept public because black-box integration tests link
    /// the server as a normal library, where `cfg(test)` helpers are unavailable.
    #[doc(hidden)]
    #[must_use]
    pub fn activity_stream_receiver_count_for_integration_test(&self) -> usize {
        self.events.receiver_count()
    }

    /// Returns publication-lock and retention-worker registry sizes for black-box lifecycle tests.
    #[doc(hidden)]
    #[must_use]
    pub fn registry_counts_for_integration_test(&self) -> (usize, usize) {
        let publication_locks = self
            .publication_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len();
        let retention_workers = self
            .retention_workers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len();
        (publication_locks, retention_workers)
    }

    #[cfg(test)]
    pub(crate) fn publish_delta_for_test(&self, delta: ActivityDelta) {
        let _ = self.events.send(ActivityProjectionEvent::Delta(delta));
    }

    #[cfg(test)]
    pub(crate) fn pause_before_publish_for_test(
        &self,
        revision: u64,
    ) -> (Arc<Notify>, Arc<Notify>) {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        *self
            .publish_pause
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(TestPublishPause {
            revision,
            entered: entered.clone(),
            release: release.clone(),
        });
        (entered, release)
    }

    #[cfg(test)]
    async fn pause_before_publish(&self, revision: u64) {
        let pause = self
            .publish_pause
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|pause| pause.revision == revision)
            .cloned();
        if let Some(pause) = pause {
            pause.entered.notify_one();
            pause.release.notified().await;
        }
    }
}

fn logical_scope_key(scope: &ActivityScopeRef) -> String {
    match scope {
        ActivityScopeRef::Thread { thread_id } => format!("thread:{thread_id}"),
        ActivityScopeRef::Terminal {
            thread_id,
            terminal_id,
        } => format!("terminal:{thread_id}:{terminal_id}"),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::{
        activity::{
            ActivityCapabilities, ActivityChange, ActivityEntry, ActivityEntryKind,
            ActivityEntryTone, ActivityRecordKind, ActivityRepository, ActivityScopeSeed,
            model::ACTIVITY_DELTA_MAX_CHANGES,
        },
        persistence::{Database, run_migrations},
    };

    use super::*;

    #[tokio::test]
    async fn cancelled_retention_worker_unregisters_before_releasing_admission() {
        // Mutation caught: manual-only retention cleanup that leaks the registry on task abort.
        let controller = AgentActivityController::new(true);
        let workers = Arc::new(StdMutex::new(HashSet::from(["scope:cancelled".to_owned()])));
        let admission = controller.admit().expect("admission");
        let entered = Arc::new(Notify::new());
        let worker = tokio::spawn({
            let workers = Arc::clone(&workers);
            let entered = Arc::clone(&entered);
            async move {
                let _lease =
                    RetentionWorkerLease::new(workers, "scope:cancelled".to_owned(), admission);
                entered.notify_one();
                std::future::pending::<()>().await;
            }
        });
        entered.notified().await;

        worker.abort();
        assert!(worker.await.expect_err("worker aborted").is_cancelled());
        assert!(
            workers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty()
        );
        tokio::time::timeout(Duration::from_secs(1), controller.disable())
            .await
            .expect("admission released after registry cleanup");
    }

    #[tokio::test]
    async fn maximum_mutation_batch_publishes_every_bounded_delta_once_in_revision_order() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection = ActivityProjection::with_capacity(ActivityRepository::new(database), 8);
        let scope = ActivityScopeSeed::thread(
            "thread:maximum",
            "maximum",
            "codex",
            Some("codex"),
            ActivityCapabilities::structured_full(false),
        )
        .expect("scope");
        projection
            .ensure_scope(scope.clone())
            .await
            .expect("scope persistence");
        let mutations: Vec<ProviderActivityMutation> = (0..ACTIVITY_DELTA_MAX_CHANGES)
            .map(|index| {
                ProviderActivityMutation::upsert_actor(
                    format!("actor:{index:03}"),
                    None,
                    format!("Actor {index:03}"),
                    "running",
                )
                .expect("valid actor")
            })
            .collect();
        let mut receiver = projection.subscribe();

        let applied = projection
            .apply(
                &scope.scope_id,
                "event:maximum".to_owned(),
                mutations.clone(),
                "2026-07-22T12:00:00Z".to_owned(),
            )
            .await
            .expect("maximum apply");

        assert_eq!(applied.len(), 2);
        assert_eq!(applied[0].changes.len(), ACTIVITY_DELTA_MAX_CHANGES);
        assert_eq!(applied[1].changes.len(), 1);
        assert_eq!(
            applied
                .iter()
                .map(|delta| (delta.previous_revision, delta.revision))
                .collect::<Vec<_>>(),
            [(0, 1), (1, 2)]
        );
        assert!(matches!(
            applied[0].changes.first(),
            Some(ActivityChange::ScopeUpdated { .. })
        ));
        assert!(matches!(
            applied[1].changes.first(),
            Some(ActivityChange::ActorUpserted { actor })
                if actor.id == "actor:255"
        ));
        assert_eq!(
            receiver.recv().await.expect("first publication"),
            ActivityProjectionEvent::Delta(applied[0].clone())
        );
        assert_eq!(
            receiver.recv().await.expect("second publication"),
            ActivityProjectionEvent::Delta(applied[1].clone())
        );

        let replay = projection
            .apply(
                &scope.scope_id,
                "event:maximum".to_owned(),
                mutations,
                "2026-07-22T12:00:00Z".to_owned(),
            )
            .await
            .expect("replay");
        assert!(replay.is_empty());
        assert!(matches!(
            receiver.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn concurrent_commits_publish_contiguous_revisions_in_commit_order() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection = ActivityProjection::with_capacity(ActivityRepository::new(database), 8);
        let scope = ActivityScopeSeed::thread(
            "thread:ordered",
            "ordered",
            "codex",
            Some("codex"),
            ActivityCapabilities::structured_full(false),
        )
        .expect("scope");
        projection
            .ensure_scope(scope.clone())
            .await
            .expect("scope persistence");
        let mut receiver = projection.subscribe();
        let (first_committed, release_first_publication) =
            projection.pause_before_publish_for_test(1);

        let first_projection = projection.clone();
        let first_scope_id = scope.scope_id.clone();
        let first = tokio::spawn(async move {
            first_projection
                .apply(
                    &first_scope_id,
                    "event:first".to_owned(),
                    vec![
                        ProviderActivityMutation::upsert_actor(
                            "actor:first",
                            None,
                            "First",
                            "running",
                        )
                        .expect("first actor"),
                    ],
                    "2026-07-22T12:00:00Z".to_owned(),
                )
                .await
        });
        first_committed.notified().await;

        let second_projection = projection.clone();
        let second_scope_id = scope.scope_id.clone();
        let mut second = tokio::spawn(async move {
            second_projection
                .apply(
                    &second_scope_id,
                    "event:second".to_owned(),
                    vec![
                        ProviderActivityMutation::upsert_actor(
                            "actor:second",
                            None,
                            "Second",
                            "running",
                        )
                        .expect("second actor"),
                    ],
                    "2026-07-22T12:00:01Z".to_owned(),
                )
                .await
        });
        let second_before_release =
            tokio::time::timeout(Duration::from_millis(200), &mut second).await;
        release_first_publication.notify_one();

        first.await.expect("first task").expect("first apply");
        match second_before_release {
            Ok(result) => {
                result.expect("second task").expect("second apply");
            }
            Err(_) => {
                second.await.expect("second task").expect("second apply");
            }
        }

        let ActivityProjectionEvent::Delta(first_delta) =
            receiver.recv().await.expect("first delivery")
        else {
            panic!("expected first delta");
        };
        let ActivityProjectionEvent::Delta(second_delta) =
            receiver.recv().await.expect("second delivery")
        else {
            panic!("expected second delta");
        };
        assert_eq!(
            [
                (first_delta.previous_revision, first_delta.revision),
                (second_delta.previous_revision, second_delta.revision),
            ],
            [(0, 1), (1, 2)]
        );
    }

    #[tokio::test]
    async fn paused_publication_does_not_block_a_different_scope() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection = ActivityProjection::with_capacity(ActivityRepository::new(database), 8);
        for (scope_id, thread_id) in [
            ("thread:paused", "paused"),
            ("thread:independent", "independent"),
        ] {
            projection
                .ensure_scope(
                    ActivityScopeSeed::thread(
                        scope_id,
                        thread_id,
                        "codex",
                        Some("codex"),
                        ActivityCapabilities::structured_full(false),
                    )
                    .expect("scope"),
                )
                .await
                .expect("scope persistence");
        }
        projection
            .apply(
                "thread:independent",
                "event:independent:first".to_owned(),
                vec![
                    ProviderActivityMutation::upsert_actor(
                        "actor:independent:first",
                        None,
                        "Independent first",
                        "running",
                    )
                    .expect("actor"),
                ],
                "2026-07-22T12:00:00Z".to_owned(),
            )
            .await
            .expect("first independent apply");

        let (paused, release) = projection.pause_before_publish_for_test(1);
        let paused_projection = projection.clone();
        let paused_apply = tokio::spawn(async move {
            paused_projection
                .apply(
                    "thread:paused",
                    "event:paused".to_owned(),
                    vec![
                        ProviderActivityMutation::upsert_actor(
                            "actor:paused",
                            None,
                            "Paused",
                            "running",
                        )
                        .expect("actor"),
                    ],
                    "2026-07-22T12:00:01Z".to_owned(),
                )
                .await
        });
        paused.notified().await;

        let independent_result = tokio::time::timeout(
            Duration::from_secs(1),
            projection.apply(
                "thread:independent",
                "event:independent:second".to_owned(),
                vec![
                    ProviderActivityMutation::upsert_actor(
                        "actor:independent:second",
                        None,
                        "Independent second",
                        "running",
                    )
                    .expect("actor"),
                ],
                "2026-07-22T12:00:02Z".to_owned(),
            ),
        )
        .await;

        release.notify_one();
        independent_result
            .expect("different scope must not wait")
            .expect("independent apply");
        paused_apply
            .await
            .expect("paused task")
            .expect("paused apply");
    }

    #[tokio::test]
    async fn maintenance_publication_cannot_be_overtaken_by_a_normal_apply() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection = ActivityProjection::with_capacity(ActivityRepository::new(database), 8);
        let scope = ActivityScopeSeed::thread(
            "thread:maintenance-order",
            "maintenance-order",
            "codex",
            Some("codex"),
            ActivityCapabilities::structured_full(false),
        )
        .expect("scope");
        projection
            .ensure_scope(scope.clone())
            .await
            .expect("scope persistence");
        let mut receiver = projection.subscribe();
        let owner = ProviderActivityMutation::upsert_actor(
            "actor:maintenance-owner",
            None,
            "Maintenance owner",
            "running",
        )
        .expect("owner");
        let seed_entries = std::iter::once(owner)
            .chain((0..200).map(|index| {
                ActivityEntry::try_new(
                    format!("entry:maintenance:{index:03}"),
                    ActivityRecordKind::Actor,
                    "actor:maintenance-owner",
                    ActivityEntryKind::Commentary,
                    "entry",
                    None,
                    ActivityEntryTone::Info,
                    format!("2026-07-22T12:{:02}:{:02}Z", index / 60, index % 60),
                )
                .map(ProviderActivityMutation::AppendEntry)
                .expect("seed entry")
            }))
            .collect();
        projection
            .apply(
                &scope.scope_id,
                "event:maintenance-seed".to_owned(),
                seed_entries,
                "2026-07-22T12:00:00Z".to_owned(),
            )
            .await
            .expect("seed entries");

        let (maintenance_paused, release_maintenance) = projection.pause_before_publish_for_test(3);
        projection
            .apply(
                &scope.scope_id,
                "event:maintenance-overflow".to_owned(),
                (200..456)
                    .map(|index| {
                        ActivityEntry::try_new(
                            format!("entry:maintenance:{index:03}"),
                            ActivityRecordKind::Actor,
                            "actor:maintenance-owner",
                            ActivityEntryKind::Commentary,
                            "entry",
                            None,
                            ActivityEntryTone::Info,
                            format!("2026-07-22T12:{:02}:{:02}Z", index / 60, index % 60),
                        )
                        .map(ProviderActivityMutation::AppendEntry)
                        .expect("overflow entry")
                    })
                    .collect(),
                "2026-07-22T12:10:00Z".to_owned(),
            )
            .await
            .expect("overflow entries");
        maintenance_paused.notified().await;

        let normal_projection = projection.clone();
        let normal_scope_id = scope.scope_id.clone();
        let mut normal_apply = tokio::spawn(async move {
            normal_projection
                .apply(
                    &normal_scope_id,
                    "event:normal-after-maintenance".to_owned(),
                    vec![
                        ProviderActivityMutation::upsert_actor(
                            "actor:normal-after-maintenance",
                            None,
                            "Normal after maintenance",
                            "running",
                        )
                        .expect("normal actor"),
                    ],
                    "2026-07-22T12:20:00Z".to_owned(),
                )
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut normal_apply)
                .await
                .is_err(),
            "a normal apply must wait until the maintenance delta is published"
        );
        release_maintenance.notify_one();
        normal_apply
            .await
            .expect("normal task")
            .expect("normal apply");

        let mut revisions = Vec::new();
        for _ in 0..4 {
            let ActivityProjectionEvent::Delta(delta) = receiver.recv().await.expect("delta")
            else {
                panic!("expected delta");
            };
            revisions.push((delta.previous_revision, delta.revision));
        }
        assert_eq!(revisions, vec![(0, 1), (1, 2), (2, 3), (3, 4)]);
    }

    #[tokio::test]
    async fn retention_prunes_128_129_and_200_entry_record_groups_and_stops() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection = ActivityProjection::new(ActivityRepository::new(database.clone()));
        let scope = ActivityScopeSeed::thread(
            "thread:record-retention-boundaries",
            "record-retention-boundaries",
            "codex",
            Some("codex"),
            ActivityCapabilities::structured_full(true),
        )
        .expect("scope");
        projection
            .ensure_scope(scope.clone())
            .await
            .expect("scope persistence");

        projection
            .apply(
                &scope.scope_id,
                "event:retention-lineage".to_owned(),
                vec![
                    ProviderActivityMutation::upsert_actor(
                        "actor:completed-parent",
                        None,
                        "Completed parent",
                        "completed",
                    )
                    .expect("parent"),
                    ProviderActivityMutation::upsert_actor(
                        "actor:active-child",
                        Some("actor:completed-parent"),
                        "Active child",
                        "running",
                    )
                    .expect("child"),
                ],
                "2099-01-01T00:00:00Z".to_owned(),
            )
            .await
            .expect("lineage");

        for (name, entry_count, timestamp) in [
            ("128", 128_usize, "2099-01-02T00:00:00Z"),
            ("129", 129_usize, "2099-01-03T00:00:00Z"),
            ("200", 200_usize, "2099-01-04T00:00:00Z"),
        ] {
            let actor_id = format!("actor:retained:{name}");
            let mutations = std::iter::once(
                ProviderActivityMutation::upsert_actor(
                    actor_id.clone(),
                    None,
                    format!("Retained entry group {name}"),
                    "completed",
                )
                .expect("completed actor"),
            )
            .chain((0..entry_count).map(|index| {
                ActivityEntry::try_new(
                    format!("entry:retained:{name}:{index:03}"),
                    ActivityRecordKind::Actor,
                    actor_id.clone(),
                    ActivityEntryKind::Commentary,
                    "entry",
                    None,
                    ActivityEntryTone::Info,
                    format!("2099-01-04T00:{:02}:{:02}Z", index / 60, index % 60),
                )
                .map(ProviderActivityMutation::AppendEntry)
                .expect("entry")
            }))
            .collect();
            projection
                .apply(
                    &scope.scope_id,
                    format!("event:retained:{name}"),
                    mutations,
                    timestamp.to_owned(),
                )
                .await
                .expect("retained entry group");
        }

        let initial_record_counts = database
            .call({
                let scope_id = scope.scope_id.clone();
                move |connection| {
                    Ok((
                        connection.query_row(
                            "SELECT record_count FROM activity_record_retention_counts WHERE scope_id = ?",
                            [&scope_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                        connection.query_row(
                            "SELECT COUNT(*) FROM activity_records WHERE scope_id = ?",
                            [&scope_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                    ))
                }
            })
            .await
            .expect("initial count inspection");
        assert_eq!(initial_record_counts, (5, 5));

        for (batch, mutations) in (0..2_000)
            .map(|index| {
                ProviderActivityMutation::upsert_actor(
                    format!("actor:completed:{index:04}"),
                    None,
                    format!("Completed {index}"),
                    "completed",
                )
                .expect("completed actor")
            })
            .collect::<Vec<_>>()
            .chunks(256)
            .enumerate()
        {
            projection
                .apply(
                    &scope.scope_id,
                    format!("event:completed:{batch}"),
                    mutations.to_vec(),
                    "2099-12-01T00:00:00Z".to_owned(),
                )
                .await
                .expect("completed records");
        }

        for _ in 0..200 {
            let pending = projection
                .repository
                .retention_pending(&scope.scope_id)
                .await
                .expect("retention pending");
            let worker_active = projection
                .retention_workers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(&scope.scope_id);
            if !pending && !worker_active {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert!(
            !projection
                .repository
                .retention_pending(&scope.scope_id)
                .await
                .expect("retention converged"),
            "the retention predicate must become false after the bounded record groups drain"
        );
        assert!(
            !projection
                .retention_workers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(&scope.scope_id),
            "the retention worker must exit once no bounded work remains"
        );

        let (record_count, completed_parent, active_child, retained_groups) = database
            .call(move |connection| {
                Ok((
                    connection.query_row(
                        "SELECT COUNT(*) FROM activity_records WHERE scope_id = ?",
                        [&scope.scope_id],
                        |row| row.get::<_, i64>(0),
                    )?,
                    connection.query_row(
                        "SELECT EXISTS(
                           SELECT 1 FROM activity_records
                           WHERE scope_id = ? AND record_id = 'actor:completed-parent'
                         )",
                        [&scope.scope_id],
                        |row| row.get::<_, bool>(0),
                    )?,
                    connection.query_row(
                        "SELECT EXISTS(
                           SELECT 1 FROM activity_records
                           WHERE scope_id = ? AND record_id = 'actor:active-child'
                         )",
                        [&scope.scope_id],
                        |row| row.get::<_, bool>(0),
                    )?,
                    connection.query_row(
                        "SELECT COUNT(*) FROM activity_records
                         WHERE scope_id = ? AND record_id IN (
                           'actor:retained:128', 'actor:retained:129', 'actor:retained:200'
                         )",
                        [&scope.scope_id],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .await
            .expect("retention inspection");
        assert_eq!(record_count, 2_000);
        assert!(
            completed_parent,
            "referenced completed records must survive"
        );
        assert!(active_child, "active records must survive");
        assert_eq!(
            retained_groups, 0,
            "each bounded record group must be removable"
        );
    }

    #[tokio::test]
    async fn retention_shrinks_the_oldest_oversized_group_before_removing_newer_records() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection =
            ActivityProjection::with_capacity(ActivityRepository::new(database.clone()), 16);
        let scope = ActivityScopeSeed::thread(
            "thread:oversized-oldest",
            "oversized-oldest",
            "codex",
            Some("codex"),
            ActivityCapabilities::structured_full(false),
        )
        .expect("scope");
        projection
            .ensure_scope(scope.clone())
            .await
            .expect("scope persistence");
        projection
            .apply(
                &scope.scope_id,
                "event:oversized-seed".to_owned(),
                vec![
                    ProviderActivityMutation::upsert_actor(
                        "actor:oldest-oversized",
                        None,
                        "Oldest oversized",
                        "completed",
                    )
                    .expect("oldest actor"),
                    ProviderActivityMutation::upsert_actor(
                        "actor:newer-completed",
                        None,
                        "Newer completed",
                        "completed",
                    )
                    .expect("newer actor"),
                    ProviderActivityMutation::upsert_actor(
                        "actor:retention-trigger",
                        None,
                        "Retention trigger",
                        "running",
                    )
                    .expect("trigger actor"),
                ],
                "2099-01-01T00:00:00Z".to_owned(),
            )
            .await
            .expect("seed records");

        let scope_id = scope.scope_id.clone();
        database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                transaction.execute(
                    "UPDATE activity_records
                     SET terminal_at = '2020-01-01T00:00:00.000000000Z',
                         updated_at = '2020-01-01T00:00:00.000000000Z'
                     WHERE scope_id = ? AND record_id = 'actor:oldest-oversized'",
                    [&scope_id],
                )?;
                transaction.execute(
                    "UPDATE activity_records
                     SET terminal_at = '2020-01-02T00:00:00.000000000Z',
                         updated_at = '2020-01-02T00:00:00.000000000Z'
                     WHERE scope_id = ? AND record_id = 'actor:newer-completed'",
                    [&scope_id],
                )?;
                for index in 0..202 {
                    let entry_id = format!("entry:oldest-oversized:{index:03}");
                    let created_at = format!(
                        "2020-01-01T00:{:02}:{:02}.000000000Z",
                        index / 60,
                        index % 60
                    );
                    transaction.execute(
                        "INSERT INTO activity_entries (
                           scope_id, entry_id, owner_kind, owner_id, native_sort_key,
                           entry_json, created_at
                         ) VALUES (?, ?, 'actor', 'actor:oldest-oversized', ?, '{}', ?)",
                        rusqlite::params![scope_id, entry_id, created_at, created_at],
                    )?;
                }
                transaction.execute(
                    "INSERT INTO activity_entry_owners (
                       scope_id, owner_kind, owner_id, entry_count
                     ) VALUES (?, 'actor', 'actor:oldest-oversized', 202)",
                    [&scope_id],
                )?;
                transaction.commit()?;
                Ok(())
            })
            .await
            .expect("oversized fixture");

        let mut receiver = projection.subscribe();
        projection
            .apply(
                &scope.scope_id,
                "event:oversized-trigger".to_owned(),
                vec![
                    ProviderActivityMutation::upsert_actor(
                        "actor:retention-trigger",
                        None,
                        "Retention trigger",
                        "running",
                    )
                    .expect("trigger actor"),
                ],
                "2099-01-01T00:00:01Z".to_owned(),
            )
            .await
            .expect("retention trigger");

        let mut removal_order = Vec::new();
        while removal_order.len() < 2 {
            let event = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .expect("retention worker must publish before timing out")
                .expect("retention event");
            let ActivityProjectionEvent::Delta(delta) = event else {
                continue;
            };
            removal_order.extend(delta.changes.into_iter().filter_map(|change| match change {
                ActivityChange::ActorRemoved { actor_id }
                    if actor_id == "actor:oldest-oversized"
                        || actor_id == "actor:newer-completed" =>
                {
                    Some(actor_id)
                }
                _ => None,
            }));
        }
        assert_eq!(
            removal_order,
            ["actor:oldest-oversized", "actor:newer-completed"],
            "the oldest eligible logical group must be made removable before newer records"
        );

        for _ in 0..200 {
            let pending = projection
                .repository
                .retention_pending(&scope.scope_id)
                .await
                .expect("retention pending");
            let worker_active = projection
                .retention_workers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(&scope.scope_id);
            if !pending && !worker_active {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            !projection
                .repository
                .retention_pending(&scope.scope_id)
                .await
                .expect("retention converged"),
            "oversized-owner retention must converge"
        );
        assert!(
            !projection
                .retention_workers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(&scope.scope_id),
            "the retention worker must terminate after convergence"
        );
    }

    #[tokio::test]
    async fn publication_lock_registry_prunes_retired_scopes() {
        let database = Database::open_in_memory().await.expect("database");
        let projection = ActivityProjection::new(ActivityRepository::new(database));

        for index in 0..PUBLICATION_LOCK_PRUNE_THRESHOLD {
            drop(projection.publication_lock(&format!("thread:retired:{index}")));
        }
        assert_eq!(
            projection
                .publication_locks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .len(),
            PUBLICATION_LOCK_PRUNE_THRESHOLD
        );

        drop(projection.publication_lock("thread:after-prune"));
        assert_eq!(
            projection
                .publication_locks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .len(),
            1
        );
    }
}
