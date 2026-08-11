#[cfg(test)]
mod tests {
    use crate::activity::{
        ActivityCapabilities, ActivityHistoryRecovery, ActivityObservationState,
    };

    use super::*;

    fn thread_scope() -> ActivityScopeRef {
        ActivityScopeRef::Thread {
            thread_id: "thread-control".to_owned(),
        }
    }

    fn terminal_scope() -> ActivityScopeRef {
        ActivityScopeRef::Terminal {
            thread_id: "thread-control".to_owned(),
            terminal_id: "terminal-control".to_owned(),
        }
    }

    fn running_actor(id: &str, parent: Option<&str>) -> ProviderActivityMutation {
        ProviderActivityMutation::upsert_actor(id, parent, id, "running").expect("actor")
    }

    fn actor<'a>(snapshot: &'a ActivityControlSnapshot, id: &str) -> &'a ActivityActorControl {
        snapshot
            .actors
            .iter()
            .find(|actor| actor.actor_id == id)
            .expect("actor control")
    }

    #[tokio::test]
    async fn registration_starts_at_revision_zero_without_available_actors() {
        // Mutation caught: initializing a new runtime with stale control state.
        let registry = ActivityControlRegistry::new();
        let _registration = registry.register_runtime(
            thread_scope(),
            "scope-control".to_owned(),
            Some("codex".to_owned()),
        );

        assert_eq!(
            registry.snapshot("scope-control").await,
            ActivityControlSnapshot::empty("scope-control")
        );
    }

    #[tokio::test]
    async fn active_actor_without_exact_native_target_is_unsupported() {
        // Mutation caught: marking a provider-observed actor cancellable without a native handle.
        let registry = ActivityControlRegistry::new();
        let registration = registry.register_runtime(
            thread_scope(),
            "scope-control".to_owned(),
            Some("codex".to_owned()),
        );

        let jobs = registry
            .observe_provider_batch(&registration, &[running_actor("actor-a", None)], &[])
            .await;

        assert!(jobs.is_empty());
        let snapshot = registry.snapshot("scope-control").await;
        assert_eq!(snapshot.revision, 1);
        assert_eq!(
            actor(&snapshot, "actor-a").state,
            ActivityActorControlState::Unsupported
        );
        assert_eq!(actor(&snapshot, "actor-a").control_revision, 0);
    }

    #[tokio::test]
    async fn invalid_canonical_batches_do_not_install_control_handles() {
        // Mutation caught: applying a target update before rejecting the batch's invalid graph data.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);

        registry
            .observe_provider_batch(
                &registration,
                &[
                    ProviderActivityMutation::SetScope {
                        capabilities: ActivityCapabilities {
                            actors: false,
                            attributed_activity: true,
                            background_work: false,
                            history_recovery: ActivityHistoryRecovery::None,
                            terminal_observation: false,
                            targeted_actor_cancellation: false,
                        },
                        observation_state: ActivityObservationState::Live,
                    },
                    running_actor("actor-a", None),
                ],
                &[ProviderActivityControlUpdate::ActorTarget {
                    actor_id: "actor-a".to_owned(),
                    target: Some(ProviderActivityNativeTarget::ClaudeTask {
                        task_id: "native-task".to_owned(),
                    }),
                }],
            )
            .await;

        assert_eq!(
            registry.snapshot("scope-control").await,
            ActivityControlSnapshot::empty("scope-control")
        );
    }

    #[tokio::test]
    async fn exact_target_becomes_available_without_changing_activity_revision() {
        // Mutation caught: coupling target fencing to the durable activity revision.
        let registry = ActivityControlRegistry::new();
        let registration = registry.register_runtime(
            thread_scope(),
            "scope-control".to_owned(),
            Some("codex".to_owned()),
        );
        registry
            .observe_provider_batch(&registration, &[running_actor("actor-a", None)], &[])
            .await;
        let activity_revision = registry.snapshot("scope-control").await.revision;

        registry
            .observe_provider_batch(
                &registration,
                &[],
                &[ProviderActivityControlUpdate::ActorTarget {
                    actor_id: "actor-a".to_owned(),
                    target: Some(ProviderActivityNativeTarget::CodexTurn {
                        thread_id: "native-thread".to_owned(),
                        turn_id: "native-turn".to_owned(),
                    }),
                }],
            )
            .await;

        let snapshot = registry.snapshot("scope-control").await;
        assert_eq!(snapshot.revision, activity_revision + 1);
        assert_eq!(
            actor(&snapshot, "actor-a").state,
            ActivityActorControlState::Available
        );
        assert_eq!(actor(&snapshot, "actor-a").control_revision, 1);
    }

    #[tokio::test]
    async fn replacing_or_removing_a_target_advances_its_fencing_revision() {
        // Mutation caught: dispatching against a replaced or removed native target with its old fence.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);
        registry
            .observe_provider_batch(&registration, &[running_actor("actor-a", None)], &[])
            .await;
        for target in [
            Some(ProviderActivityNativeTarget::CodexTurn {
                thread_id: "native-thread".to_owned(),
                turn_id: "turn-1".to_owned(),
            }),
            Some(ProviderActivityNativeTarget::CodexTurn {
                thread_id: "native-thread".to_owned(),
                turn_id: "turn-2".to_owned(),
            }),
            None,
        ] {
            registry
                .observe_provider_batch(
                    &registration,
                    &[],
                    &[ProviderActivityControlUpdate::ActorTarget {
                        actor_id: "actor-a".to_owned(),
                        target,
                    }],
                )
                .await;
        }

        let snapshot = registry.snapshot("scope-control").await;
        assert_eq!(actor(&snapshot, "actor-a").control_revision, 3);
        assert_eq!(
            actor(&snapshot, "actor-a").state,
            ActivityActorControlState::Unsupported
        );
    }

    #[tokio::test]
    async fn descendant_changes_advance_overlay_without_advancing_parent_target_fence() {
        // Mutation caught: invalidating a root target merely because its descendant count changed.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);
        registry
            .observe_provider_batch(&registration, &[running_actor("root", None)], &[])
            .await;
        registry
            .observe_provider_batch(
                &registration,
                &[],
                &[ProviderActivityControlUpdate::ActorTarget {
                    actor_id: "root".to_owned(),
                    target: Some(ProviderActivityNativeTarget::ClaudeTask {
                        task_id: "native-task".to_owned(),
                    }),
                }],
            )
            .await;
        let before = registry.snapshot("scope-control").await;

        registry
            .observe_provider_batch(&registration, &[running_actor("child", Some("root"))], &[])
            .await;

        let after = registry.snapshot("scope-control").await;
        assert_eq!(after.revision, before.revision + 1);
        assert_eq!(
            actor(&after, "root").control_revision,
            actor(&before, "root").control_revision
        );
        assert_eq!(actor(&after, "root").active_descendant_count, 1);
    }

    #[tokio::test]
    async fn terminal_actors_lose_target_availability() {
        // Mutation caught: retaining a cancellation target after the actor has reached a terminal state.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);
        registry
            .observe_provider_batch(
                &registration,
                &[running_actor("actor-a", None)],
                &[ProviderActivityControlUpdate::ActorTarget {
                    actor_id: "actor-a".to_owned(),
                    target: Some(ProviderActivityNativeTarget::ClaudeTask {
                        task_id: "native-task".to_owned(),
                    }),
                }],
            )
            .await;

        registry
            .observe_provider_batch(
                &registration,
                &[
                    ProviderActivityMutation::set_actor_status("actor-a", "completed")
                        .expect("terminal actor"),
                ],
                &[],
            )
            .await;

        let snapshot = registry.snapshot("scope-control").await;
        assert_eq!(
            actor(&snapshot, "actor-a").state,
            ActivityActorControlState::Unsupported
        );
        assert_eq!(actor(&snapshot, "actor-a").control_revision, 2);
    }

    #[tokio::test]
    async fn replacing_a_runtime_clears_old_targets_and_advances_their_fences() {
        // Mutation caught: allowing a new runtime generation to dispatch a previous generation's handle.
        let registry = ActivityControlRegistry::new();
        let first = registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);
        registry
            .observe_provider_batch(
                &first,
                &[running_actor("actor-a", None)],
                &[ProviderActivityControlUpdate::ActorTarget {
                    actor_id: "actor-a".to_owned(),
                    target: Some(ProviderActivityNativeTarget::ClaudeTask {
                        task_id: "native-task".to_owned(),
                    }),
                }],
            )
            .await;

        let _replacement =
            registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);

        let snapshot = registry.snapshot("scope-control").await;
        assert_eq!(
            actor(&snapshot, "actor-a").state,
            ActivityActorControlState::Unsupported
        );
        assert_eq!(actor(&snapshot, "actor-a").control_revision, 2);
    }

    #[tokio::test]
    async fn terminal_scopes_never_gain_control_capability() {
        // Mutation caught: accepting a native cancellation target from a provider-terminal observer.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(terminal_scope(), "scope-control".to_owned(), None);
        registry
            .observe_provider_batch(
                &registration,
                &[running_actor("actor-a", None)],
                &[ProviderActivityControlUpdate::ActorTarget {
                    actor_id: "actor-a".to_owned(),
                    target: Some(ProviderActivityNativeTarget::ClaudeTask {
                        task_id: "native-task".to_owned(),
                    }),
                }],
            )
            .await;

        assert_eq!(
            actor(&registry.snapshot("scope-control").await, "actor-a").state,
            ActivityActorControlState::Unsupported
        );
    }

    #[tokio::test]
    async fn retained_control_state_never_exceeds_protocol_bounds() {
        // Mutation caught: allocating one retained control record for every provider actor or update.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);
        let actors = (0..=ACTIVITY_PAGE_MAX_LENGTH)
            .map(|index| {
                let actor_id = format!("actor-{index}");
                let parent_id = (index % 4 != 0).then(|| format!("actor-{}", index - 1));
                running_actor(&actor_id, parent_id.as_deref())
            })
            .collect::<Vec<_>>();
        let controls = (0..=ACTIVITY_DELTA_MAX_CHANGES)
            .map(|index| ProviderActivityControlUpdate::ActorTarget {
                actor_id: format!("actor-{index}"),
                target: Some(ProviderActivityNativeTarget::ClaudeTask {
                    task_id: format!("native-{index}"),
                }),
            })
            .collect::<Vec<_>>();

        registry
            .observe_provider_batch(&registration, &actors, &controls)
            .await;

        let snapshot = registry.snapshot("scope-control").await;
        assert_eq!(snapshot.actors.len(), ACTIVITY_PAGE_MAX_LENGTH);
        assert_eq!(actor(&snapshot, "actor-0").active_descendant_count, 3);
        assert!(snapshot.operations.len() <= ACTIVITY_PAGE_MAX_LENGTH);
        assert!(registry.bounded_counts().2 <= ACTIVITY_DELTA_MAX_CHANGES);
    }

    #[test]
    fn native_target_debug_is_redacted() {
        // Mutation caught: logging a provider-native thread, turn, or task identifier.
        let codex = format!(
            "{:?}",
            ProviderActivityNativeTarget::CodexTurn {
                thread_id: "thread-secret".to_owned(),
                turn_id: "turn-secret".to_owned(),
            }
        );
        let claude = format!(
            "{:?}",
            ProviderActivityNativeTarget::ClaudeTask {
                task_id: "task-secret".to_owned(),
            }
        );

        assert_eq!(codex, "CodexTurn { .. }");
        assert_eq!(claude, "ClaudeTask { .. }");
    }
}
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::{Arc, Mutex},
};

use tokio::sync::broadcast;
use uuid::Uuid;

use super::model::{
    ACTIVITY_DELTA_MAX_CHANGES, ACTIVITY_ID_MAX_LENGTH, ACTIVITY_PAGE_MAX_LENGTH,
    ActivityActorControl, ActivityActorControlState, ActivityCancellationOperationSummary,
    ActivityControlChange, ActivityControlDelta, ActivityControlSnapshot, ActivityLifecycle,
    ActivityScopeRef, ProviderActivityMutation, validate_text,
};

/// A provider-native cancellation handle. This value stays inside the Rust server and is never
/// encoded, persisted, or logged with its provider identifiers.
#[derive(Clone, Eq, PartialEq)]
pub(crate) enum ProviderActivityNativeTarget {
    CodexTurn { thread_id: String, turn_id: String },
    ClaudeTask { task_id: String },
}

impl fmt::Debug for ProviderActivityNativeTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CodexTurn { .. } => formatter.write_str("CodexTurn { .. }"),
            Self::ClaudeTask { .. } => formatter.write_str("ClaudeTask { .. }"),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ActivityRuntimeGeneration(Uuid);

#[derive(Clone)]
pub(crate) struct ActivityRuntimeControlRegistration {
    scope_id: String,
    generation: ActivityRuntimeGeneration,
}

pub(crate) enum ProviderActivityControlUpdate {
    ActorTarget {
        actor_id: String,
        target: Option<ProviderActivityNativeTarget>,
    },
    WorkTarget {
        work_item_id: String,
        target: Option<ProviderActivityNativeTarget>,
    },
}

/// A cancellation dispatch candidate. The cancellation layer owns populating these after it has
/// installed an operation fence; observation alone never dispatches provider cancellation.
pub(crate) struct ActivityDispatchJob {
    pub(crate) scope: ActivityScopeRef,
    pub(crate) generation: ActivityRuntimeGeneration,
    pub(crate) operation_root_actor_id: String,
    pub(crate) subject: ActivityDispatchSubject,
    pub(crate) target: ProviderActivityNativeTarget,
}

pub(crate) enum ActivityDispatchSubject {
    Actor { actor_id: String },
    WorkItem { work_item_id: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ActivityControlEvent {
    Delta(ActivityControlDelta),
}

#[derive(Clone, Debug)]
pub(crate) struct ActivityControlRegistry {
    inner: Arc<Mutex<ActivityControlRegistryState>>,
    events: broadcast::Sender<ActivityControlEvent>,
}

#[derive(Debug, Default)]
struct ActivityControlRegistryState {
    scopes: BTreeMap<String, ActivityControlScope>,
}

#[derive(Clone, Debug)]
struct ActivityControlScope {
    scope_id: String,
    scope: ActivityScopeRef,
    generation: ActivityRuntimeGeneration,
    _provider_instance_id: Option<String>,
    revision: u64,
    actors: BTreeMap<String, ActivityControlActor>,
    operations: BTreeMap<String, ActivityCancellationOperationSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ActivityControlActor {
    parent_actor_id: Option<String>,
    status: ActivityLifecycle,
    target: Option<ProviderActivityNativeTarget>,
    control_revision: u64,
}

impl ActivityControlRegistry {
    #[must_use]
    pub(crate) fn new() -> Self {
        let (events, _) = broadcast::channel(ACTIVITY_DELTA_MAX_CHANGES);
        Self {
            inner: Arc::new(Mutex::new(ActivityControlRegistryState::default())),
            events,
        }
    }

    #[must_use]
    pub(crate) fn register_runtime(
        &self,
        scope: ActivityScopeRef,
        scope_id: String,
        provider_instance_id: Option<String>,
    ) -> ActivityRuntimeControlRegistration {
        let generation = ActivityRuntimeGeneration(Uuid::new_v4());
        let event = {
            let mut state = self.lock();
            if let Some(existing) = state.scopes.get_mut(&scope_id) {
                let before = existing.actor_controls();
                existing.generation = generation.clone();
                existing.scope = scope;
                existing._provider_instance_id = provider_instance_id;
                for actor in existing.actors.values_mut() {
                    if actor.target.take().is_some() {
                        actor.control_revision = actor.control_revision.saturating_add(1);
                    }
                }
                existing.publish_delta(before)
            } else {
                state.scopes.insert(
                    scope_id.clone(),
                    ActivityControlScope {
                        scope_id: scope_id.clone(),
                        scope,
                        generation: generation.clone(),
                        _provider_instance_id: provider_instance_id,
                        revision: 0,
                        actors: BTreeMap::new(),
                        operations: BTreeMap::new(),
                    },
                );
                None
            }
        };
        if let Some(event) = event {
            let _ = self.events.send(ActivityControlEvent::Delta(event));
        }
        ActivityRuntimeControlRegistration {
            scope_id,
            generation,
        }
    }

    pub(crate) async fn observe_provider_batch(
        &self,
        registration: &ActivityRuntimeControlRegistration,
        activity: &[ProviderActivityMutation],
        controls: &[ProviderActivityControlUpdate],
    ) -> Vec<ActivityDispatchJob> {
        let event = {
            let mut state = self.lock();
            let Some(scope) = state.scopes.get_mut(&registration.scope_id) else {
                return Vec::new();
            };
            if scope.generation != registration.generation {
                return Vec::new();
            }
            let mut staged = scope.clone();
            if !staged.apply_activity(activity) {
                return Vec::new();
            }
            staged.apply_control_updates(controls);
            if !staged.validate_graph() {
                return Vec::new();
            }
            let before = scope.actor_controls();
            *scope = staged;
            scope.publish_delta(before)
        };
        if let Some(event) = event {
            let _ = self.events.send(ActivityControlEvent::Delta(event));
        }
        Vec::new()
    }

    pub(crate) async fn snapshot(&self, scope_id: &str) -> ActivityControlSnapshot {
        self.lock()
            .scopes
            .get(scope_id)
            .map(ActivityControlScope::snapshot)
            .unwrap_or_else(|| ActivityControlSnapshot::empty(scope_id))
    }

    pub(crate) async fn actor_controls_for(
        &self,
        scope_id: &str,
        actors: &[super::model::ActivityActorSummary],
    ) -> Vec<ActivityActorControl> {
        let state = self.lock();
        let Some(scope) = state.scopes.get(scope_id) else {
            return actors
                .iter()
                .map(|actor| ActivityActorControl::unsupported(actor.id.clone()))
                .collect();
        };
        let by_id = scope.actor_controls();
        actors
            .iter()
            .map(|actor| {
                by_id
                    .get(&actor.id)
                    .cloned()
                    .unwrap_or_else(|| ActivityActorControl::unsupported(actor.id.clone()))
            })
            .collect()
    }

    pub(crate) async fn actor_control_for(
        &self,
        scope_id: &str,
        actor_id: &str,
    ) -> Option<ActivityActorControl> {
        self.lock()
            .scopes
            .get(scope_id)
            .and_then(|scope| scope.actor_controls().remove(actor_id))
    }

    #[must_use]
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ActivityControlEvent> {
        self.events.subscribe()
    }

    #[doc(hidden)]
    #[must_use]
    pub(crate) fn bounded_counts(&self) -> (usize, usize, usize) {
        let state = self.lock();
        let actor_count = state.scopes.values().map(|scope| scope.actors.len()).sum();
        let operation_count = state
            .scopes
            .values()
            .map(|scope| scope.operations.len())
            .sum();
        (actor_count, operation_count, 0)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ActivityControlRegistryState> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for ActivityControlRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ActivityControlScope {
    fn apply_activity(&mut self, activity: &[ProviderActivityMutation]) -> bool {
        if !activity.iter().all(validate_canonical_mutation) {
            return false;
        }
        for mutation in activity {
            match mutation {
                ProviderActivityMutation::UpsertActor(actor) => {
                    if let Some(existing) = self.actors.get_mut(&actor.id) {
                        if actor.name.is_empty() {
                            existing.status = actor.status;
                        } else {
                            existing.parent_actor_id = actor.parent_actor_id.clone();
                            existing.status = actor.status;
                        }
                    } else if self.actors.len() < ACTIVITY_PAGE_MAX_LENGTH {
                        self.actors.insert(
                            actor.id.clone(),
                            ActivityControlActor {
                                parent_actor_id: actor.parent_actor_id.clone(),
                                status: actor.status,
                                target: None,
                                control_revision: 0,
                            },
                        );
                    }
                }
                ProviderActivityMutation::RemoveActor { actor_id } => {
                    self.actors.remove(actor_id);
                }
                _ => {}
            }
        }
        true
    }

    fn apply_control_updates(&mut self, controls: &[ProviderActivityControlUpdate]) {
        for update in controls.iter().take(ACTIVITY_DELTA_MAX_CHANGES) {
            match update {
                ProviderActivityControlUpdate::ActorTarget { actor_id, target } => {
                    let Some(actor) = self.actors.get_mut(actor_id) else {
                        continue;
                    };
                    let target = if matches!(self.scope, ActivityScopeRef::Thread { .. })
                        && !actor.status.is_terminal()
                    {
                        target.clone()
                    } else {
                        None
                    };
                    if actor.target != target {
                        actor.target = target;
                        actor.control_revision = actor.control_revision.saturating_add(1);
                    }
                }
                ProviderActivityControlUpdate::WorkTarget {
                    work_item_id,
                    target,
                } => {
                    let _ = (work_item_id, target);
                }
            }
        }
        for actor in self.actors.values_mut() {
            if actor.status.is_terminal() && actor.target.take().is_some() {
                actor.control_revision = actor.control_revision.saturating_add(1);
            }
        }
    }

    fn validate_graph(&self) -> bool {
        self.actors.iter().all(|(actor_id, actor)| {
            actor.parent_actor_id.as_ref().is_none_or(|parent_id| {
                parent_id != actor_id && self.actors.contains_key(parent_id)
            })
        }) && self.actors.keys().all(|actor_id| {
            let mut cursor = Some(actor_id.as_str());
            let mut visited = BTreeSet::new();
            while let Some(current) = cursor {
                if !visited.insert(current) {
                    return false;
                }
                cursor = self
                    .actors
                    .get(current)
                    .and_then(|actor| actor.parent_actor_id.as_deref());
            }
            true
        })
    }

    fn actor_controls(&self) -> BTreeMap<String, ActivityActorControl> {
        self.actors
            .iter()
            .map(|(actor_id, actor)| {
                let active_descendant_count = self
                    .actors
                    .iter()
                    .filter(|(candidate_id, candidate)| {
                        *candidate_id != actor_id
                            && !candidate.status.is_terminal()
                            && self.is_descendant_of(candidate_id, actor_id)
                    })
                    .count() as u64;
                let state = if matches!(self.scope, ActivityScopeRef::Thread { .. })
                    && !actor.status.is_terminal()
                    && actor.target.is_some()
                {
                    ActivityActorControlState::Available
                } else {
                    ActivityActorControlState::Unsupported
                };
                (
                    actor_id.clone(),
                    ActivityActorControl {
                        actor_id: actor_id.clone(),
                        state,
                        control_revision: actor.control_revision,
                        active_descendant_count,
                    },
                )
            })
            .collect()
    }

    fn is_descendant_of(&self, actor_id: &str, ancestor_id: &str) -> bool {
        let mut cursor = self
            .actors
            .get(actor_id)
            .and_then(|actor| actor.parent_actor_id.as_deref());
        while let Some(parent_id) = cursor {
            if parent_id == ancestor_id {
                return true;
            }
            cursor = self
                .actors
                .get(parent_id)
                .and_then(|actor| actor.parent_actor_id.as_deref());
        }
        false
    }

    fn publish_delta(
        &mut self,
        before: BTreeMap<String, ActivityActorControl>,
    ) -> Option<ActivityControlDelta> {
        let after = self.actor_controls();
        let mut changes = Vec::new();
        for actor_id in before.keys().chain(after.keys()).collect::<BTreeSet<_>>() {
            match (before.get(actor_id), after.get(actor_id)) {
                (Some(before), Some(after)) if before == after => {}
                (_, Some(actor)) => changes.push(ActivityControlChange::ActorUpserted {
                    actor: actor.clone(),
                }),
                (Some(_), None) => changes.push(ActivityControlChange::ActorRemoved {
                    actor_id: (*actor_id).clone(),
                }),
                (None, None) => {}
            }
        }
        if changes.is_empty() {
            return None;
        }
        let previous_revision = self.revision;
        self.revision = self.revision.saturating_add(1);
        Some(ActivityControlDelta {
            scope_id: self.scope_id(),
            previous_revision,
            revision: self.revision,
            changes,
        })
    }

    fn snapshot(&self) -> ActivityControlSnapshot {
        ActivityControlSnapshot {
            scope_id: self.scope_id(),
            revision: self.revision,
            actors: self.actor_controls().into_values().collect(),
            operations: self.operations.values().cloned().collect(),
        }
    }

    fn scope_id(&self) -> String {
        self.scope_id.clone()
    }
}

fn validate_canonical_mutation(mutation: &ProviderActivityMutation) -> bool {
    match mutation {
        ProviderActivityMutation::SetScope { capabilities, .. } => capabilities.validate().is_ok(),
        ProviderActivityMutation::SetSectionHealth { health, .. } => health.validate().is_ok(),
        ProviderActivityMutation::UpsertActor(actor)
            if actor.name.is_empty()
                || actor.started_at.is_empty()
                || actor.updated_at.is_empty() =>
        {
            validate_text(actor.id.clone(), "actor id", ACTIVITY_ID_MAX_LENGTH, true).is_ok()
        }
        ProviderActivityMutation::UpsertActor(actor) => actor.validate().is_ok(),
        ProviderActivityMutation::RemoveActor { actor_id } => {
            validate_text(actor_id.clone(), "actor id", ACTIVITY_ID_MAX_LENGTH, true).is_ok()
        }
        ProviderActivityMutation::UpsertWorkItem(work_item) => work_item.validate().is_ok(),
        ProviderActivityMutation::RemoveWorkItem { work_item_id } => validate_text(
            work_item_id.clone(),
            "work item id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )
        .is_ok(),
        ProviderActivityMutation::AppendEntry(entry) => entry.validate().is_ok(),
    }
}
