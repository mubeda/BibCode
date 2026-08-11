use std::{collections::HashSet, fmt, sync::Arc, time::Duration};

use futures_util::{StreamExt, future::BoxFuture, stream::FuturesUnordered};
use tokio::{
    sync::Semaphore,
    time::{Instant, timeout, timeout_at},
};

use super::{
    ActivityCancellationOperationState, ActivityCancellationOperationSummary, ActivityControlEvent,
    ActivityControlRegistry, ActivityDispatchJob, ActivityDispatchSubject,
    ActivityRuntimeGeneration, ActivityScopeRef, ProviderActivityNativeTarget,
};

const TARGET_DISPATCH_TIMEOUT: Duration = Duration::from_secs(2);
const OPERATION_DEADLINE: Duration = Duration::from_secs(10);
const DESCENDANT_DISPATCH_CONCURRENCY: usize = 4;
const PARTIAL_CANCELLATION_MESSAGE: &str = "Some agents are still running.";

pub(crate) trait ActivityCancellationDispatcher: Send + Sync {
    fn cancel_target(
        &self,
        scope: ActivityScopeRef,
        generation: ActivityRuntimeGeneration,
        target: ProviderActivityNativeTarget,
    ) -> BoxFuture<'static, Result<ActivityTargetDispatchDisposition, ActivityDispatchError>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ActivityTargetDispatchDisposition {
    Delivered,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ActivityDispatchError {
    ProviderUnavailable,
    TargetUnavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ActivitySubtreeCancellationDisposition {
    Accepted,
    InProgress,
    AlreadyTerminal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ActivitySubtreeCancellationResult {
    pub(crate) disposition: ActivitySubtreeCancellationDisposition,
    pub(crate) root_actor_id: String,
    pub(crate) operation_revision: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ActivityCancellationError {
    NotFound,
    InvalidScope,
    StaleScope,
    StaleActor,
    StaleOperation,
    TargetUnavailable,
    CapacityExceeded,
}

#[derive(Clone)]
pub(crate) struct ActivityCancellationService {
    registry: ActivityControlRegistry,
    dispatcher: Arc<dyn ActivityCancellationDispatcher>,
}

#[derive(Clone)]
pub(super) struct CancellationOperation {
    pub(super) root_actor_id: String,
    pub(super) generation: ActivityRuntimeGeneration,
    pub(super) covered_actor_ids: HashSet<String>,
    pub(super) covered_work_item_ids: HashSet<String>,
    pub(super) dispatched_targets: HashSet<ProviderActivityNativeTarget>,
    pub(super) residual_actor_ids: HashSet<String>,
    pub(super) residual_work_item_ids: HashSet<String>,
    pub(super) state: ActivityCancellationOperationState,
    pub(super) operation_revision: u64,
}

impl fmt::Debug for CancellationOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CancellationOperation")
            .field("root_actor_id", &self.root_actor_id)
            .field("generation", &self.generation)
            .field("covered_actor_count", &self.covered_actor_ids.len())
            .field("covered_work_item_count", &self.covered_work_item_ids.len())
            .field("dispatched_target_count", &self.dispatched_targets.len())
            .field("residual_actor_count", &self.residual_actor_ids.len())
            .field(
                "residual_work_item_count",
                &self.residual_work_item_ids.len(),
            )
            .field("state", &self.state)
            .field("operation_revision", &self.operation_revision)
            .finish()
    }
}

impl CancellationOperation {
    pub(super) fn summary(&self) -> ActivityCancellationOperationSummary {
        ActivityCancellationOperationSummary {
            root_actor_id: self.root_actor_id.clone(),
            state: self.state,
            residual_count: self
                .residual_actor_ids
                .len()
                .saturating_add(self.residual_work_item_ids.len())
                as u64,
            message: (self.state == ActivityCancellationOperationState::Partial)
                .then(|| PARTIAL_CANCELLATION_MESSAGE.to_owned()),
            operation_revision: self.operation_revision,
        }
    }
}

struct CancellationAdmission {
    result: ActivitySubtreeCancellationResult,
    selected_job: Option<ActivityDispatchJob>,
    remaining_jobs: Vec<ActivityDispatchJob>,
}

impl ActivityCancellationService {
    pub(crate) fn new(
        registry: ActivityControlRegistry,
        dispatcher: Arc<dyn ActivityCancellationDispatcher>,
    ) -> Self {
        Self {
            registry,
            dispatcher,
        }
    }

    pub(crate) async fn cancel_subtree(
        &self,
        scope: ActivityScopeRef,
        scope_id: &str,
        actor_id: &str,
        expected_control_revision: u64,
    ) -> Result<ActivitySubtreeCancellationResult, ActivityCancellationError> {
        let admission =
            self.admit_cancellation(scope, scope_id, actor_id, expected_control_revision)?;
        if admission.result.disposition == ActivitySubtreeCancellationDisposition::Accepted {
            let failed = self
                .dispatch_operation(admission.selected_job, admission.remaining_jobs)
                .await;
            if failed {
                self.mark_partial(scope_id, &admission.result.root_actor_id);
            }
        }
        Ok(admission.result)
    }

    pub(crate) async fn retry_subtree_cancellation(
        &self,
        scope: ActivityScopeRef,
        scope_id: &str,
        root_actor_id: &str,
        expected_operation_revision: u64,
    ) -> Result<ActivitySubtreeCancellationResult, ActivityCancellationError> {
        let admission =
            self.admit_retry(scope, scope_id, root_actor_id, expected_operation_revision)?;
        let failed = self
            .dispatch_operation(admission.selected_job, admission.remaining_jobs)
            .await;
        if failed {
            self.mark_partial(scope_id, &admission.result.root_actor_id);
        }
        Ok(admission.result)
    }

    pub(crate) async fn dispatch_observed_jobs(&self, jobs: Vec<ActivityDispatchJob>) {
        if jobs.is_empty() {
            return;
        }
        let roots = jobs
            .iter()
            .map(|job| (job.scope_id.clone(), job.operation_root_actor_id.clone()))
            .collect::<HashSet<_>>();
        let failed = self.dispatch_operation(None, jobs).await;
        if failed {
            for (scope_id, root_actor_id) in roots {
                self.mark_partial(&scope_id, &root_actor_id);
            }
        }
    }

    fn admit_cancellation(
        &self,
        requested_scope: ActivityScopeRef,
        scope_id: &str,
        actor_id: &str,
        expected_control_revision: u64,
    ) -> Result<CancellationAdmission, ActivityCancellationError> {
        let (event, admission) = {
            let mut state = self.registry.lock();
            let scope = state
                .scopes
                .get_mut(scope_id)
                .ok_or(ActivityCancellationError::StaleScope)?;
            if scope.scope != requested_scope
                || !matches!(requested_scope, ActivityScopeRef::Thread { .. })
            {
                return Err(ActivityCancellationError::InvalidScope);
            }
            let actor = scope
                .actors
                .get(actor_id)
                .ok_or(ActivityCancellationError::NotFound)?;
            if actor.control_revision != expected_control_revision {
                return Err(ActivityCancellationError::StaleActor);
            }
            if actor.status.is_terminal() {
                return Ok(CancellationAdmission {
                    result: ActivitySubtreeCancellationResult {
                        disposition: ActivitySubtreeCancellationDisposition::AlreadyTerminal,
                        root_actor_id: actor_id.to_owned(),
                        operation_revision: None,
                    },
                    selected_job: None,
                    remaining_jobs: Vec::new(),
                });
            }
            if actor.target.is_none() {
                return Err(ActivityCancellationError::TargetUnavailable);
            }

            if let Some(existing) = scope
                .operations
                .values()
                .find(|operation| operation.covered_actor_ids.contains(actor_id))
            {
                return Ok(CancellationAdmission {
                    result: ActivitySubtreeCancellationResult {
                        disposition: ActivitySubtreeCancellationDisposition::InProgress,
                        root_actor_id: existing.root_actor_id.clone(),
                        operation_revision: Some(existing.operation_revision),
                    },
                    selected_job: None,
                    remaining_jobs: Vec::new(),
                });
            }

            let before = scope.clone();
            let covered_actor_ids = scope
                .actors
                .keys()
                .filter(|candidate| {
                    *candidate == actor_id || scope.is_descendant_of(candidate, actor_id)
                })
                .cloned()
                .collect::<HashSet<_>>();
            let covered_work_item_ids = scope
                .work_items
                .iter()
                .filter(|(_, work_item)| {
                    !work_item.status.is_terminal()
                        && work_item.target.is_some()
                        && work_item
                            .owner_actor_id
                            .as_ref()
                            .is_some_and(|owner| covered_actor_ids.contains(owner))
                })
                .map(|(id, _)| id.clone())
                .collect::<HashSet<_>>();
            let residual_actor_ids = covered_actor_ids
                .iter()
                .filter(|id| {
                    scope
                        .actors
                        .get(*id)
                        .is_some_and(|actor| !actor.status.is_terminal())
                })
                .cloned()
                .collect::<HashSet<_>>();
            let residual_work_item_ids = covered_work_item_ids.clone();
            let absorbed_roots = scope
                .operations
                .iter()
                .filter(|(_, operation)| covered_actor_ids.contains(&operation.root_actor_id))
                .map(|(root, _)| root.clone())
                .collect::<Vec<_>>();
            let mut operation = CancellationOperation {
                root_actor_id: actor_id.to_owned(),
                generation: scope.generation.clone(),
                covered_actor_ids,
                covered_work_item_ids,
                dispatched_targets: HashSet::new(),
                residual_actor_ids,
                residual_work_item_ids,
                state: ActivityCancellationOperationState::Requested,
                operation_revision: 1,
            };
            for absorbed_root in absorbed_roots {
                if let Some(absorbed) = scope.operations.remove(&absorbed_root) {
                    operation
                        .covered_actor_ids
                        .extend(absorbed.covered_actor_ids);
                    operation
                        .covered_work_item_ids
                        .extend(absorbed.covered_work_item_ids);
                    operation
                        .residual_actor_ids
                        .extend(absorbed.residual_actor_ids);
                    operation
                        .residual_work_item_ids
                        .extend(absorbed.residual_work_item_ids);
                    operation
                        .dispatched_targets
                        .extend(absorbed.dispatched_targets);
                }
            }
            if scope.operations.len() >= crate::activity::ACTIVITY_PAGE_MAX_LENGTH {
                return Err(ActivityCancellationError::CapacityExceeded);
            }
            scope.operations.insert(actor_id.to_owned(), operation);
            if !scope.within_bounds() {
                *scope = before;
                return Err(ActivityCancellationError::CapacityExceeded);
            }
            let jobs = scope.jobs_for_operation(actor_id, true);
            let selected_job = jobs
                .iter()
                .position(|job| matches!(&job.subject, ActivityDispatchSubject::Actor { actor_id: id } if id == actor_id))
                .map(|index| jobs[index].clone());
            let remaining_jobs = jobs
                .into_iter()
                .filter(|job| !matches!(&job.subject, ActivityDispatchSubject::Actor { actor_id: id } if id == actor_id))
                .collect();
            let changes = scope
                .pending_changes(&before)
                .map_err(|()| ActivityCancellationError::CapacityExceeded)?;
            let event = scope.publish_changes(changes);
            let operation_revision = scope.operations[actor_id].operation_revision;
            (
                event,
                CancellationAdmission {
                    result: ActivitySubtreeCancellationResult {
                        disposition: ActivitySubtreeCancellationDisposition::Accepted,
                        root_actor_id: actor_id.to_owned(),
                        operation_revision: Some(operation_revision),
                    },
                    selected_job,
                    remaining_jobs,
                },
            )
        };
        if let Some(event) = event {
            let _ = self
                .registry
                .events
                .send(ActivityControlEvent::Delta(event));
        }
        Ok(admission)
    }

    fn admit_retry(
        &self,
        requested_scope: ActivityScopeRef,
        scope_id: &str,
        root_actor_id: &str,
        expected_operation_revision: u64,
    ) -> Result<CancellationAdmission, ActivityCancellationError> {
        let (event, admission) = {
            let mut state = self.registry.lock();
            let scope = state
                .scopes
                .get_mut(scope_id)
                .ok_or(ActivityCancellationError::StaleScope)?;
            if scope.scope != requested_scope
                || !matches!(requested_scope, ActivityScopeRef::Thread { .. })
            {
                return Err(ActivityCancellationError::InvalidScope);
            }
            let before = scope.clone();
            let operation = scope
                .operations
                .get_mut(root_actor_id)
                .ok_or(ActivityCancellationError::StaleOperation)?;
            if operation.operation_revision != expected_operation_revision {
                return Err(ActivityCancellationError::StaleOperation);
            }
            operation.state = ActivityCancellationOperationState::Requested;
            operation.operation_revision = operation.operation_revision.saturating_add(1);
            operation.dispatched_targets.clear();
            let jobs = scope.jobs_for_operation(root_actor_id, true);
            let selected_job = jobs
                .iter()
                .position(|job| matches!(&job.subject, ActivityDispatchSubject::Actor { actor_id } if actor_id == root_actor_id))
                .map(|index| jobs[index].clone());
            let remaining_jobs = jobs
                .into_iter()
                .filter(|job| !matches!(&job.subject, ActivityDispatchSubject::Actor { actor_id } if actor_id == root_actor_id))
                .collect();
            let changes = scope
                .pending_changes(&before)
                .map_err(|()| ActivityCancellationError::CapacityExceeded)?;
            let event = scope.publish_changes(changes);
            let revision = scope.operations[root_actor_id].operation_revision;
            (
                event,
                CancellationAdmission {
                    result: ActivitySubtreeCancellationResult {
                        disposition: ActivitySubtreeCancellationDisposition::Accepted,
                        root_actor_id: root_actor_id.to_owned(),
                        operation_revision: Some(revision),
                    },
                    selected_job,
                    remaining_jobs,
                },
            )
        };
        if let Some(event) = event {
            let _ = self
                .registry
                .events
                .send(ActivityControlEvent::Delta(event));
        }
        Ok(admission)
    }

    async fn dispatch_operation(
        &self,
        selected_job: Option<ActivityDispatchJob>,
        remaining_jobs: Vec<ActivityDispatchJob>,
    ) -> bool {
        let deadline = Instant::now() + OPERATION_DEADLINE;
        let mut failed = false;
        if let Some(job) = selected_job {
            failed |= self.dispatch_one(job).await;
        }
        let semaphore = Arc::new(Semaphore::new(DESCENDANT_DISPATCH_CONCURRENCY));
        let mut pending = FuturesUnordered::new();
        for job in remaining_jobs {
            let service = self.clone();
            let semaphore = semaphore.clone();
            pending.push(async move {
                let Ok(_permit) = semaphore.acquire_owned().await else {
                    return true;
                };
                service.dispatch_one(job).await
            });
        }
        let drain = async {
            while let Some(job_failed) = pending.next().await {
                failed |= job_failed;
            }
        };
        if timeout_at(deadline, drain).await.is_err() {
            failed = true;
        }
        failed
    }

    async fn dispatch_one(&self, job: ActivityDispatchJob) -> bool {
        if !self.prepare_dispatch(&job) {
            return false;
        }
        !matches!(
            timeout(
                TARGET_DISPATCH_TIMEOUT,
                self.dispatcher
                    .cancel_target(job.scope, job.generation, job.target),
            )
            .await,
            Ok(Ok(ActivityTargetDispatchDisposition::Delivered))
        )
    }

    fn prepare_dispatch(&self, job: &ActivityDispatchJob) -> bool {
        let mut state = self.registry.lock();
        let Some(scope) = state.scopes.get_mut(&job.scope_id) else {
            return false;
        };
        if scope.generation != job.generation || scope.scope != job.scope {
            return false;
        }
        let Some(operation) = scope.operations.get_mut(&job.operation_root_actor_id) else {
            return false;
        };
        if operation.generation != job.generation
            || operation.dispatched_targets.contains(&job.target)
        {
            return false;
        }
        let current_target = match &job.subject {
            ActivityDispatchSubject::Actor { actor_id } => scope
                .actors
                .get(actor_id)
                .filter(|actor| {
                    !actor.status.is_terminal() && operation.residual_actor_ids.contains(actor_id)
                })
                .and_then(|actor| actor.target.as_ref()),
            ActivityDispatchSubject::WorkItem { work_item_id } => scope
                .work_items
                .get(work_item_id)
                .filter(|work| {
                    !work.status.is_terminal()
                        && operation.residual_work_item_ids.contains(work_item_id)
                })
                .and_then(|work| work.target.as_ref()),
        };
        if current_target != Some(&job.target) {
            return false;
        }
        operation.dispatched_targets.insert(job.target.clone())
    }

    fn mark_partial(&self, scope_id: &str, root_actor_id: &str) {
        let event = {
            let mut state = self.registry.lock();
            let Some(scope) = state.scopes.get_mut(scope_id) else {
                return;
            };
            let before = scope.clone();
            let Some(operation) = scope.operations.get_mut(root_actor_id) else {
                return;
            };
            if operation.state == ActivityCancellationOperationState::Partial {
                return;
            }
            operation.state = ActivityCancellationOperationState::Partial;
            operation.operation_revision = operation.operation_revision.saturating_add(1);
            let Ok(changes) = scope.pending_changes(&before) else {
                *scope = before;
                return;
            };
            scope.publish_changes(changes)
        };
        if let Some(event) = event {
            let _ = self
                .registry
                .events
                .send(ActivityControlEvent::Delta(event));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use futures_util::future::BoxFuture;
    use tokio::sync::{Notify, Semaphore};

    use super::*;
    use crate::activity::{
        ActivityActorControlState, ActivityCancellationOperationState, ActivityControlRegistry,
        ActivityDispatchError, ActivityLifecycle, ActivityRuntimeGeneration, ActivityScopeRef,
        ActivitySubtreeCancellationDisposition, ActivityTargetDispatchDisposition,
        ProviderActivityControlUpdate, ProviderActivityMutation, ProviderActivityNativeTarget,
    };

    const SCOPE_ID: &str = "scope-cancellation";

    fn thread_scope(thread_id: &str) -> ActivityScopeRef {
        ActivityScopeRef::Thread {
            thread_id: thread_id.to_owned(),
        }
    }

    fn running_actor(id: &str, parent: Option<&str>) -> ProviderActivityMutation {
        ProviderActivityMutation::upsert_actor(id, parent, id, "running").expect("actor")
    }

    fn actor_status(id: &str, status: &str) -> ProviderActivityMutation {
        ProviderActivityMutation::set_actor_status(id, status).expect("actor status")
    }

    fn work_item(
        id: &str,
        owner: Option<&str>,
        status: ActivityLifecycle,
    ) -> ProviderActivityMutation {
        ProviderActivityMutation::UpsertWorkItem(
            crate::activity::ActivityWorkItemSummary::try_new(
                id,
                owner,
                id,
                "task",
                None,
                None,
                status,
                None,
                "2026-08-11T12:00:00Z",
                "2026-08-11T12:00:00Z",
                status.is_terminal().then_some("2026-08-11T12:00:00Z"),
            )
            .expect("work item"),
        )
    }

    fn actor_target(actor_id: &str) -> ProviderActivityControlUpdate {
        ProviderActivityControlUpdate::ActorTarget {
            actor_id: actor_id.to_owned(),
            target: Some(ProviderActivityNativeTarget::ClaudeTask {
                task_id: format!("native-{actor_id}"),
            }),
        }
    }

    fn work_target(work_item_id: &str) -> ProviderActivityControlUpdate {
        ProviderActivityControlUpdate::WorkTarget {
            work_item_id: work_item_id.to_owned(),
            target: Some(ProviderActivityNativeTarget::ClaudeTask {
                task_id: format!("native-{work_item_id}"),
            }),
        }
    }

    fn target_label(target: &ProviderActivityNativeTarget) -> String {
        match target {
            ProviderActivityNativeTarget::CodexTurn { turn_id, .. } => turn_id.clone(),
            ProviderActivityNativeTarget::ClaudeTask { task_id } => task_id.clone(),
        }
    }

    struct FakeDispatcher {
        calls: Mutex<Vec<String>>,
        failures: Mutex<BTreeSet<String>>,
        held: Mutex<BTreeSet<String>>,
        started: Notify,
        release: Arc<Semaphore>,
        active: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        delay_millis: AtomicUsize,
    }

    impl Default for FakeDispatcher {
        fn default() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                failures: Mutex::new(BTreeSet::new()),
                held: Mutex::new(BTreeSet::new()),
                started: Notify::new(),
                release: Arc::new(Semaphore::new(0)),
                active: Arc::new(AtomicUsize::new(0)),
                peak: Arc::new(AtomicUsize::new(0)),
                delay_millis: AtomicUsize::new(0),
            }
        }
    }

    impl FakeDispatcher {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls").clone()
        }

        fn call_set(&self) -> BTreeSet<String> {
            self.calls().into_iter().collect()
        }

        fn fail(&self, target: &str) {
            self.failures
                .lock()
                .expect("failures")
                .insert(target.to_owned());
        }

        fn clear_failures(&self) {
            self.failures.lock().expect("failures").clear();
        }

        fn hold(&self, target: &str) {
            self.held.lock().expect("held").insert(target.to_owned());
        }

        async fn wait_for_calls(&self, count: usize) {
            loop {
                if self.calls.lock().expect("calls").len() >= count {
                    return;
                }
                self.started.notified().await;
            }
        }

        fn release_one(&self) {
            self.release.add_permits(1);
        }

        fn set_delay(&self, duration: Duration) {
            self.delay_millis
                .store(duration.as_millis() as usize, Ordering::Release);
        }

        fn peak(&self) -> usize {
            self.peak.load(Ordering::Acquire)
        }
    }

    impl ActivityCancellationDispatcher for FakeDispatcher {
        fn cancel_target(
            &self,
            _scope: ActivityScopeRef,
            _generation: ActivityRuntimeGeneration,
            target: ProviderActivityNativeTarget,
        ) -> BoxFuture<'static, Result<ActivityTargetDispatchDisposition, ActivityDispatchError>>
        {
            let label = target_label(&target);
            self.calls.lock().expect("calls").push(label.clone());
            self.started.notify_waiters();
            let held = self.held.lock().expect("held").contains(&label);
            let failed = self.failures.lock().expect("failures").contains(&label);
            let delay = self.delay_millis.load(Ordering::Acquire);
            let release = held.then(|| self.release.clone());
            let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
            self.peak.fetch_max(active, Ordering::AcqRel);
            let active_counter = self.active.clone();
            Box::pin(async move {
                struct ActiveGuard(Arc<AtomicUsize>);
                impl Drop for ActiveGuard {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::AcqRel);
                    }
                }
                let _guard = ActiveGuard(active_counter);
                if let Some(release) = release {
                    let permit = release.acquire().await.expect("release gate");
                    permit.forget();
                }
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay as u64)).await;
                }
                if failed {
                    Err(ActivityDispatchError::ProviderUnavailable)
                } else {
                    Ok(ActivityTargetDispatchDisposition::Delivered)
                }
            })
        }
    }

    async fn install_tree(
        registry: &ActivityControlRegistry,
        scope_id: &str,
        thread_id: &str,
    ) -> crate::activity::ActivityRuntimeControlRegistration {
        let registration =
            registry.register_runtime(thread_scope(thread_id), scope_id.to_owned(), None);
        let actors = [
            running_actor("root", None),
            running_actor("alpha", Some("root")),
            running_actor("alpha-one", Some("alpha")),
            running_actor("alpha-two", Some("alpha")),
            running_actor("alpha-two-child", Some("alpha-two")),
            running_actor("beta", Some("root")),
            running_actor("beta-one", Some("beta")),
        ];
        let controls = [
            actor_target("root"),
            actor_target("alpha"),
            actor_target("alpha-one"),
            actor_target("alpha-two"),
            actor_target("alpha-two-child"),
            actor_target("beta"),
            actor_target("beta-one"),
        ];
        registry
            .observe_provider_batch(&registration, &actors, &controls)
            .await;
        registration
    }

    fn actor_revision(snapshot: &crate::activity::ActivityControlSnapshot, actor_id: &str) -> u64 {
        snapshot
            .actors
            .iter()
            .find(|actor| actor.actor_id == actor_id)
            .expect("actor control")
            .control_revision
    }

    #[tokio::test]
    async fn selects_only_the_canonical_subtree_and_exact_attributed_work() {
        // Mutation caught: walking upward/outward, crossing scope identity, or dispatching unattributed work.
        let registry = ActivityControlRegistry::new();
        let registration = install_tree(&registry, SCOPE_ID, "thread-a").await;
        let second =
            registry.register_runtime(thread_scope("thread-b"), "scope-second".to_owned(), None);
        registry
            .observe_provider_batch(
                &second,
                &[
                    running_actor("alpha", None),
                    running_actor("alpha-one", Some("alpha")),
                ],
                &[actor_target("alpha"), actor_target("alpha-one")],
            )
            .await;
        registry
            .observe_provider_batch(
                &registration,
                &[
                    work_item("work-exact", Some("alpha-two"), ActivityLifecycle::Running),
                    work_item(
                        "work-without-target",
                        Some("alpha-two"),
                        ActivityLifecycle::Running,
                    ),
                    work_item("work-unattributed", None, ActivityLifecycle::Running),
                ],
                &[work_target("work-exact"), work_target("work-unattributed")],
            )
            .await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        let service = ActivityCancellationService::new(registry.clone(), dispatcher.clone());
        let revision = actor_revision(&registry.snapshot(SCOPE_ID).await, "alpha");

        service
            .cancel_subtree(thread_scope("thread-a"), SCOPE_ID, "alpha", revision)
            .await
            .expect("cancel alpha");

        assert_eq!(
            dispatcher.call_set(),
            BTreeSet::from([
                "native-alpha".to_owned(),
                "native-alpha-one".to_owned(),
                "native-alpha-two".to_owned(),
                "native-alpha-two-child".to_owned(),
                "native-work-exact".to_owned(),
            ])
        );
        assert!(!dispatcher.call_set().contains("native-root"));
        assert!(!dispatcher.call_set().contains("native-beta"));
        assert!(!dispatcher.call_set().contains("native-beta-one"));
        assert!(!dispatcher.call_set().contains("native-work-unattributed"));
        assert_eq!(
            registry.snapshot(SCOPE_ID).await.operations[0].residual_count,
            5
        );
    }

    #[tokio::test]
    async fn dispatches_selected_actor_first_and_bounds_descendant_concurrency_to_four() {
        // Mutation caught: spawning descendants before the selected actor or omitting the semaphore.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope("thread-a"), SCOPE_ID.to_owned(), None);
        let mut actors = vec![running_actor("root", None)];
        let mut controls = vec![actor_target("root")];
        for index in 0..12 {
            let id = format!("child-{index}");
            actors.push(running_actor(&id, Some("root")));
            controls.push(actor_target(&id));
        }
        registry
            .observe_provider_batch(&registration, &actors, &controls)
            .await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        dispatcher.set_delay(Duration::from_millis(20));
        let service = ActivityCancellationService::new(registry.clone(), dispatcher.clone());
        let revision = actor_revision(&registry.snapshot(SCOPE_ID).await, "root");

        service
            .cancel_subtree(thread_scope("thread-a"), SCOPE_ID, "root", revision)
            .await
            .expect("cancel root");

        assert_eq!(
            dispatcher.calls().first().map(String::as_str),
            Some("native-root")
        );
        assert!(
            dispatcher.peak() <= 4,
            "peak dispatches: {}",
            dispatcher.peak()
        );
        assert_eq!(dispatcher.calls().len(), 13);
    }

    #[tokio::test]
    async fn duplicate_and_covered_descendant_requests_join_the_existing_operation() {
        // Mutation caught: starting duplicate native dispatch for overlapping requests.
        let registry = ActivityControlRegistry::new();
        let _registration = install_tree(&registry, SCOPE_ID, "thread-a").await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        dispatcher.hold("native-alpha");
        let service = Arc::new(ActivityCancellationService::new(
            registry.clone(),
            dispatcher.clone(),
        ));
        let alpha_revision = actor_revision(&registry.snapshot(SCOPE_ID).await, "alpha");
        let first_service = service.clone();
        let first = tokio::spawn(async move {
            first_service
                .cancel_subtree(thread_scope("thread-a"), SCOPE_ID, "alpha", alpha_revision)
                .await
        });
        dispatcher.wait_for_calls(1).await;
        let snapshot = registry.snapshot(SCOPE_ID).await;

        let duplicate = service
            .cancel_subtree(
                thread_scope("thread-a"),
                SCOPE_ID,
                "alpha",
                actor_revision(&snapshot, "alpha"),
            )
            .await
            .expect("duplicate");
        let descendant = service
            .cancel_subtree(
                thread_scope("thread-a"),
                SCOPE_ID,
                "alpha-two",
                actor_revision(&snapshot, "alpha-two"),
            )
            .await
            .expect("covered descendant");

        assert_eq!(
            duplicate.disposition,
            ActivitySubtreeCancellationDisposition::InProgress
        );
        assert_eq!(
            descendant.disposition,
            ActivitySubtreeCancellationDisposition::InProgress
        );
        assert_eq!(duplicate.root_actor_id, "alpha");
        assert_eq!(descendant.root_actor_id, "alpha");
        assert_eq!(dispatcher.calls(), vec!["native-alpha"]);
        dispatcher.release_one();
        first.await.expect("join").expect("first cancellation");
        assert_eq!(dispatcher.calls().len(), dispatcher.call_set().len());
    }

    #[tokio::test]
    async fn ancestor_absorbs_descendant_operation_without_duplicate_dispatch() {
        // Mutation caught: retaining overlapping operations or redispatching an absorbed target.
        let registry = ActivityControlRegistry::new();
        let _registration = install_tree(&registry, SCOPE_ID, "thread-a").await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        dispatcher.hold("native-alpha-two");
        let service = Arc::new(ActivityCancellationService::new(
            registry.clone(),
            dispatcher.clone(),
        ));
        let snapshot = registry.snapshot(SCOPE_ID).await;
        let child_service = service.clone();
        let child_revision = actor_revision(&snapshot, "alpha-two");
        let child = tokio::spawn(async move {
            child_service
                .cancel_subtree(
                    thread_scope("thread-a"),
                    SCOPE_ID,
                    "alpha-two",
                    child_revision,
                )
                .await
        });
        dispatcher.wait_for_calls(1).await;

        let ancestor = service
            .cancel_subtree(
                thread_scope("thread-a"),
                SCOPE_ID,
                "alpha",
                actor_revision(&registry.snapshot(SCOPE_ID).await, "alpha"),
            )
            .await
            .expect("ancestor");
        dispatcher.release_one();
        child.await.expect("join").expect("child cancellation");

        assert_eq!(
            ancestor.disposition,
            ActivitySubtreeCancellationDisposition::Accepted
        );
        assert_eq!(
            dispatcher
                .calls()
                .iter()
                .filter(|call| *call == "native-alpha-two")
                .count(),
            1
        );
        let operations = registry.snapshot(SCOPE_ID).await.operations;
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].root_actor_id, "alpha");
    }

    #[tokio::test]
    async fn late_descendant_is_fenced_requested_and_dispatched_but_outward_actor_is_not() {
        // Mutation caught: admitting late work outside the original root fence or leaving it available.
        let registry = ActivityControlRegistry::new();
        let registration = install_tree(&registry, SCOPE_ID, "thread-a").await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        dispatcher.hold("native-alpha");
        let service = Arc::new(ActivityCancellationService::new(
            registry.clone(),
            dispatcher.clone(),
        ));
        let revision = actor_revision(&registry.snapshot(SCOPE_ID).await, "alpha");
        let running_service = service.clone();
        let running = tokio::spawn(async move {
            running_service
                .cancel_subtree(thread_scope("thread-a"), SCOPE_ID, "alpha", revision)
                .await
        });
        dispatcher.wait_for_calls(1).await;

        let jobs = registry
            .observe_provider_batch(
                &registration,
                &[
                    running_actor("late-child", Some("alpha-two-child")),
                    running_actor("late-outward", Some("beta")),
                ],
                &[actor_target("late-child"), actor_target("late-outward")],
            )
            .await;
        let snapshot = registry.snapshot(SCOPE_ID).await;
        assert_eq!(
            snapshot
                .actors
                .iter()
                .find(|actor| actor.actor_id == "late-child")
                .expect("late child")
                .state,
            ActivityActorControlState::Requested
        );
        assert_eq!(
            snapshot
                .actors
                .iter()
                .find(|actor| actor.actor_id == "late-outward")
                .expect("outward")
                .state,
            ActivityActorControlState::Available
        );

        service.dispatch_observed_jobs(jobs).await;
        assert!(dispatcher.call_set().contains("native-late-child"));
        assert!(!dispatcher.call_set().contains("native-late-outward"));
        dispatcher.release_one();
        running.await.expect("join").expect("cancel alpha");
    }

    #[tokio::test]
    async fn authoritative_terminal_observation_skips_pending_dispatch_and_removes_finished_fence()
    {
        // Mutation caught: treating request delivery as terminal or dispatching a naturally completed child.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope("thread-a"), SCOPE_ID.to_owned(), None);
        registry
            .observe_provider_batch(
                &registration,
                &[
                    running_actor("root", None),
                    running_actor("child", Some("root")),
                ],
                &[actor_target("root"), actor_target("child")],
            )
            .await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        dispatcher.hold("native-root");
        let service = Arc::new(ActivityCancellationService::new(
            registry.clone(),
            dispatcher.clone(),
        ));
        let revision = actor_revision(&registry.snapshot(SCOPE_ID).await, "root");
        let running_service = service.clone();
        let running = tokio::spawn(async move {
            running_service
                .cancel_subtree(thread_scope("thread-a"), SCOPE_ID, "root", revision)
                .await
        });
        dispatcher.wait_for_calls(1).await;
        registry
            .observe_provider_batch(&registration, &[actor_status("child", "completed")], &[])
            .await;
        dispatcher.release_one();
        running.await.expect("join").expect("cancel root");
        assert!(!dispatcher.call_set().contains("native-child"));
        assert_eq!(
            registry.snapshot(SCOPE_ID).await.operations[0].residual_count,
            1
        );

        registry
            .observe_provider_batch(&registration, &[actor_status("root", "completed")], &[])
            .await;
        assert!(registry.snapshot(SCOPE_ID).await.operations.is_empty());
        let jobs = registry
            .observe_provider_batch(
                &registration,
                &[running_actor("after-fence", Some("root"))],
                &[actor_target("after-fence")],
            )
            .await;
        assert!(jobs.is_empty());
    }

    #[tokio::test]
    async fn partial_failure_keeps_only_active_residuals_and_retry_stays_inside_fence() {
        // Mutation caught: retaining terminal members, recomputing outward closure, or retrying delivered targets.
        let registry = ActivityControlRegistry::new();
        let registration = install_tree(&registry, SCOPE_ID, "thread-a").await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        dispatcher.fail("native-alpha");
        dispatcher.hold("native-alpha");
        let service = Arc::new(ActivityCancellationService::new(
            registry.clone(),
            dispatcher.clone(),
        ));
        let revision = actor_revision(&registry.snapshot(SCOPE_ID).await, "alpha");
        let running_service = service.clone();
        let running = tokio::spawn(async move {
            running_service
                .cancel_subtree(thread_scope("thread-a"), SCOPE_ID, "alpha", revision)
                .await
        });
        dispatcher.wait_for_calls(1).await;
        registry
            .observe_provider_batch(
                &registration,
                &[
                    actor_status("alpha-one", "completed"),
                    actor_status("alpha-two", "completed"),
                    actor_status("alpha-two-child", "completed"),
                ],
                &[],
            )
            .await;
        dispatcher.release_one();
        running.await.expect("join").expect("initial cancellation");
        let partial = registry.snapshot(SCOPE_ID).await.operations[0].clone();
        assert_eq!(partial.state, ActivityCancellationOperationState::Partial);
        assert_eq!(partial.residual_count, 1);
        assert_eq!(
            partial.message.as_deref(),
            Some("Some agents are still running.")
        );

        let late_jobs = registry
            .observe_provider_batch(
                &registration,
                &[
                    running_actor("late-child", Some("alpha-two-child")),
                    running_actor("late-outward", Some("beta")),
                ],
                &[actor_target("late-child"), actor_target("late-outward")],
            )
            .await;
        assert_eq!(late_jobs.len(), 1);
        dispatcher.clear_failures();
        let before_retry = dispatcher.calls().len();
        service
            .retry_subtree_cancellation(
                thread_scope("thread-a"),
                SCOPE_ID,
                "alpha",
                registry.snapshot(SCOPE_ID).await.operations[0].operation_revision,
            )
            .await
            .expect("retry");
        let retried = &dispatcher.calls()[before_retry..];
        assert_eq!(
            retried.iter().cloned().collect::<BTreeSet<_>>(),
            BTreeSet::from(["native-alpha".to_owned(), "native-late-child".to_owned()])
        );
        assert!(!retried.contains(&"native-late-outward".to_owned()));
    }

    #[tokio::test]
    async fn stale_retry_revision_performs_no_provider_io() {
        // Mutation caught: accepting a retry against an obsolete operation summary.
        let registry = ActivityControlRegistry::new();
        let _registration = install_tree(&registry, SCOPE_ID, "thread-a").await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        dispatcher.fail("native-alpha");
        let service = ActivityCancellationService::new(registry.clone(), dispatcher.clone());
        let revision = actor_revision(&registry.snapshot(SCOPE_ID).await, "alpha");
        service
            .cancel_subtree(thread_scope("thread-a"), SCOPE_ID, "alpha", revision)
            .await
            .expect("initial cancellation");
        let before = dispatcher.calls().len();

        let error = service
            .retry_subtree_cancellation(thread_scope("thread-a"), SCOPE_ID, "alpha", 0)
            .await
            .expect_err("stale operation");

        assert_eq!(error, ActivityCancellationError::StaleOperation);
        assert_eq!(dispatcher.calls().len(), before);
    }

    #[tokio::test(start_paused = true)]
    async fn dispatch_timeout_marks_partial_without_terminalizing_observation() {
        // Mutation caught: converting a provider timeout into an invented terminal lifecycle.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope("thread-a"), SCOPE_ID.to_owned(), None);
        registry
            .observe_provider_batch(
                &registration,
                &[running_actor("root", None)],
                &[actor_target("root")],
            )
            .await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        dispatcher.hold("native-root");
        let service = ActivityCancellationService::new(registry.clone(), dispatcher);
        let revision = actor_revision(&registry.snapshot(SCOPE_ID).await, "root");

        service
            .cancel_subtree(thread_scope("thread-a"), SCOPE_ID, "root", revision)
            .await
            .expect("bounded timeout");

        let state = registry.lock().scopes[SCOPE_ID].actors["root"].status;
        assert_eq!(state, ActivityLifecycle::Running);
        let operation = &registry.snapshot(SCOPE_ID).await.operations[0];
        assert_eq!(operation.state, ActivityCancellationOperationState::Partial);
        assert_eq!(operation.residual_count, 1);
    }

    #[tokio::test]
    async fn runtime_replacement_and_drop_invalidate_queued_dispatch() {
        // Mutation caught: allowing stale work to dispatch after replacement, disablement, or shutdown.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope("thread-a"), SCOPE_ID.to_owned(), None);
        registry
            .observe_provider_batch(
                &registration,
                &[
                    running_actor("root", None),
                    running_actor("child", Some("root")),
                ],
                &[actor_target("root"), actor_target("child")],
            )
            .await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        dispatcher.hold("native-root");
        let service = Arc::new(ActivityCancellationService::new(
            registry.clone(),
            dispatcher.clone(),
        ));
        let revision = actor_revision(&registry.snapshot(SCOPE_ID).await, "root");
        let running_service = service.clone();
        let running = tokio::spawn(async move {
            running_service
                .cancel_subtree(thread_scope("thread-a"), SCOPE_ID, "root", revision)
                .await
        });
        dispatcher.wait_for_calls(1).await;
        let replacement =
            registry.register_runtime(thread_scope("thread-a"), SCOPE_ID.to_owned(), None);
        dispatcher.release_one();
        running
            .await
            .expect("join")
            .expect("stale cancellation finishes safely");
        assert!(!dispatcher.call_set().contains("native-child"));
        assert!(registry.snapshot(SCOPE_ID).await.operations.is_empty());

        drop(registration);
        assert_eq!(registry.snapshot(SCOPE_ID).await.scope_id, SCOPE_ID);
        drop(replacement);
        assert!(registry.snapshot(SCOPE_ID).await.operations.is_empty());
    }

    #[tokio::test]
    async fn terminal_selected_actor_returns_already_terminal_without_dispatch() {
        // Mutation caught: requiring a target or calling the provider for a terminal selected actor.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope("thread-a"), SCOPE_ID.to_owned(), None);
        registry
            .observe_provider_batch(
                &registration,
                &[
                    running_actor("root", None),
                    actor_status("root", "completed"),
                ],
                &[actor_target("root")],
            )
            .await;
        let dispatcher = Arc::new(FakeDispatcher::default());
        let service = ActivityCancellationService::new(registry.clone(), dispatcher.clone());

        let result = service
            .cancel_subtree(thread_scope("thread-a"), SCOPE_ID, "root", 0)
            .await
            .expect("already terminal");

        assert_eq!(
            result.disposition,
            ActivitySubtreeCancellationDisposition::AlreadyTerminal
        );
        assert_eq!(result.operation_revision, None);
        assert!(dispatcher.calls().is_empty());
    }
}
