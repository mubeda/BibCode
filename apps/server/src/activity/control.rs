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
    async fn oversized_runtime_replacement_is_rejected_without_mutating_state_or_revision() {
        // Mutation caught: publishing an over-256 control delta while replacing a runtime.
        let registry = ActivityControlRegistry::new();
        let mut events = registry.subscribe();
        let first = registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);
        {
            let mut state = registry.lock();
            let scope = state.scopes.get_mut("scope-control").expect("scope");
            for index in 0..=ACTIVITY_DELTA_MAX_CHANGES {
                scope.actors.insert(
                    format!("actor-{index}"),
                    ActivityControlActor {
                        parent_actor_id: None,
                        status: ActivityLifecycle::Running,
                        target: Some(ProviderActivityNativeTarget::ClaudeTask {
                            task_id: format!("native-{index}"),
                        }),
                        control_revision: 1,
                    },
                );
            }
        }
        let before = registry.snapshot("scope-control").await;

        let replacement =
            registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);

        assert!(!replacement.active);
        assert_eq!(registry.snapshot("scope-control").await, before);
        assert_eq!(
            registry.lock().scopes["scope-control"].generation,
            first.generation
        );
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn oversized_control_batch_is_rejected_without_a_partial_overlay_update() {
        // Mutation caught: accepting the prefix of an oversized provider control batch.
        let registry = ActivityControlRegistry::new();
        let registration =
            registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);
        registry
            .observe_provider_batch(&registration, &[running_actor("actor-a", None)], &[])
            .await;
        let before = registry.snapshot("scope-control").await;
        let controls = (0..=ACTIVITY_DELTA_MAX_CHANGES)
            .map(|index| ProviderActivityControlUpdate::ActorTarget {
                actor_id: "actor-a".to_owned(),
                target: Some(ProviderActivityNativeTarget::ClaudeTask {
                    task_id: format!("native-{index}"),
                }),
            })
            .collect::<Vec<_>>();

        registry
            .observe_provider_batch(&registration, &[], &controls)
            .await;

        assert_eq!(registry.snapshot("scope-control").await, before);
    }

    #[tokio::test]
    async fn dropping_current_registration_removes_its_scope_with_one_bounded_delta() {
        // Mutation caught: retaining a completed runtime's native handles after its registration drops.
        let registry = ActivityControlRegistry::new();
        let mut events = registry.subscribe();
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
        let _ = events.recv().await.expect("upsert delta");

        drop(registration);

        let ActivityControlEvent::Delta(delta) = events.recv().await.expect("removal delta");
        assert!(delta.changes.len() <= ACTIVITY_DELTA_MAX_CHANGES);
        assert_eq!(delta.changes.len(), 1);
        assert_eq!(
            registry.snapshot("scope-control").await,
            ActivityControlSnapshot::empty("scope-control")
        );
    }

    #[tokio::test]
    async fn dropping_a_superseded_registration_cannot_remove_its_replacement() {
        // Mutation caught: an old runtime teardown deleting a newer runtime's overlay.
        let registry = ActivityControlRegistry::new();
        let first = registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);
        registry
            .observe_provider_batch(&first, &[running_actor("actor-a", None)], &[])
            .await;
        let replacement =
            registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);

        drop(first);

        assert_eq!(registry.snapshot("scope-control").await.actors.len(), 1);
        drop(replacement);
        assert_eq!(
            registry.snapshot("scope-control").await,
            ActivityControlSnapshot::empty("scope-control")
        );
    }

    #[test]
    fn repeated_registration_churn_releases_every_scope() {
        // Mutation caught: growing the registry's scope map for every completed runtime.
        let registry = ActivityControlRegistry::new();
        for index in 0..ACTIVITY_DELTA_MAX_CHANGES * 2 {
            let registration =
                registry.register_runtime(thread_scope(), format!("scope-control-{index}"), None);
            drop(registration);
        }

        assert!(registry.lock().scopes.is_empty());
    }

    #[tokio::test]
    async fn bounded_four_level_tree_emits_one_delta_and_cleans_up_replaced_generations() {
        // Mutation caught: keeping the 201st actor, splitting one batch, or letting stale teardown
        // erase its replacement.
        let registry = ActivityControlRegistry::new();
        let mut events = registry.subscribe();
        let first = registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);
        let mutations = (0..=ACTIVITY_PAGE_MAX_LENGTH)
            .map(|index| {
                let actor_id = format!("actor-{index}");
                let parent_id = (index % 4 != 0).then(|| format!("actor-{}", index - 1));
                running_actor(&actor_id, parent_id.as_deref())
            })
            .collect::<Vec<_>>();

        registry
            .observe_provider_batch(&first, &mutations, &[])
            .await;

        let snapshot = registry.snapshot("scope-control").await;
        assert_eq!(snapshot.actors.len(), ACTIVITY_PAGE_MAX_LENGTH);
        assert!(
            !snapshot
                .actors
                .iter()
                .any(|actor| actor.actor_id == "actor-200")
        );
        for (actor_id, descendant_count) in [
            ("actor-0", 3),
            ("actor-1", 2),
            ("actor-2", 1),
            ("actor-3", 0),
        ] {
            assert_eq!(
                actor(&snapshot, actor_id).active_descendant_count,
                descendant_count
            );
        }
        let ActivityControlEvent::Delta(delta) = events.recv().await.expect("batch delta");
        assert!(delta.changes.len() <= ACTIVITY_DELTA_MAX_CHANGES);
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));

        let replacement =
            registry.register_runtime(thread_scope(), "scope-control".to_owned(), None);
        registry
            .observe_provider_batch(&first, &[mutations[0].clone()], &[])
            .await;
        drop(first);
        assert_eq!(
            registry.snapshot("scope-control").await.actors.len(),
            ACTIVITY_PAGE_MAX_LENGTH
        );
        drop(replacement);
        let ActivityControlEvent::Delta(removal) = events.recv().await.expect("removal delta");
        assert!(removal.changes.len() <= ACTIVITY_DELTA_MAX_CHANGES);
        assert_eq!(
            registry.snapshot("scope-control").await,
            ActivityControlSnapshot::empty("scope-control")
        );
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
        let controls = (0..ACTIVITY_DELTA_MAX_CHANGES)
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
    sync::{Arc, Mutex, Weak},
};

use tokio::sync::broadcast;
use uuid::Uuid;

use super::cancellation::CancellationOperation;
use super::model::{
    ACTIVITY_DELTA_MAX_CHANGES, ACTIVITY_ID_MAX_LENGTH, ACTIVITY_PAGE_MAX_LENGTH,
    ActivityActorControl, ActivityActorControlState, ActivityControlChange, ActivityControlDelta,
    ActivityControlSnapshot, ActivityLifecycle, ActivityScopeRef, ProviderActivityMutation,
    validate_text,
};

/// A provider-native cancellation handle. This value stays inside the Rust server and is never
/// encoded, persisted, or logged with its provider identifiers.
#[derive(Clone, Eq, Hash, PartialEq)]
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

pub(crate) struct ActivityRuntimeControlRegistration {
    scope_id: String,
    generation: ActivityRuntimeGeneration,
    active: bool,
    inner: Weak<Mutex<ActivityControlRegistryState>>,
    events: broadcast::Sender<ActivityControlEvent>,
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
#[derive(Clone)]
pub(crate) struct ActivityDispatchJob {
    pub(crate) scope_id: String,
    pub(crate) scope: ActivityScopeRef,
    pub(crate) generation: ActivityRuntimeGeneration,
    pub(crate) operation_root_actor_id: String,
    pub(crate) subject: ActivityDispatchSubject,
    pub(crate) target: ProviderActivityNativeTarget,
}

#[derive(Clone)]
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
    pub(super) events: broadcast::Sender<ActivityControlEvent>,
}

#[derive(Debug, Default)]
pub(super) struct ActivityControlRegistryState {
    pub(super) scopes: BTreeMap<String, ActivityControlScope>,
}

#[derive(Clone, Debug)]
pub(super) struct ActivityControlScope {
    scope_id: String,
    pub(super) scope: ActivityScopeRef,
    pub(super) generation: ActivityRuntimeGeneration,
    _provider_instance_id: Option<String>,
    revision: u64,
    pub(super) actors: BTreeMap<String, ActivityControlActor>,
    pub(super) work_items: BTreeMap<String, ActivityControlWorkItem>,
    pub(super) operations: BTreeMap<String, CancellationOperation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ActivityControlActor {
    pub(super) parent_actor_id: Option<String>,
    pub(super) status: ActivityLifecycle,
    pub(super) target: Option<ProviderActivityNativeTarget>,
    pub(super) control_revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ActivityControlWorkItem {
    pub(super) owner_actor_id: Option<String>,
    pub(super) status: ActivityLifecycle,
    pub(super) target: Option<ProviderActivityNativeTarget>,
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
        let mut active = true;
        let event = {
            let mut state = self.lock();
            if let Some(existing) = state.scopes.get_mut(&scope_id) {
                let mut staged = existing.clone();
                staged.generation = generation.clone();
                staged.scope = scope;
                staged._provider_instance_id = provider_instance_id;
                for actor in staged.actors.values_mut() {
                    if actor.target.take().is_some() {
                        actor.control_revision = actor.control_revision.saturating_add(1);
                    }
                }
                for work_item in staged.work_items.values_mut() {
                    work_item.target = None;
                }
                // Cancellation operations are generation-scoped and cannot outlive their targets.
                staged.operations.clear();
                let Ok(changes) = staged.pending_changes(existing) else {
                    active = false;
                    return ActivityRuntimeControlRegistration {
                        scope_id,
                        generation,
                        active,
                        inner: Arc::downgrade(&self.inner),
                        events: self.events.clone(),
                    };
                };
                *existing = staged;
                existing.publish_changes(changes)
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
                        work_items: BTreeMap::new(),
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
            active,
            inner: Arc::downgrade(&self.inner),
            events: self.events.clone(),
        }
    }

    pub(crate) async fn observe_provider_batch(
        &self,
        registration: &ActivityRuntimeControlRegistration,
        activity: &[ProviderActivityMutation],
        controls: &[ProviderActivityControlUpdate],
    ) -> Vec<ActivityDispatchJob> {
        if activity.len() > ACTIVITY_DELTA_MAX_CHANGES
            || controls.len() > ACTIVITY_DELTA_MAX_CHANGES
        {
            return Vec::new();
        }
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
            let jobs = staged.reconcile_operations();
            if !staged.validate_graph() || !staged.within_bounds() {
                return Vec::new();
            }
            let Ok(changes) = staged.pending_changes(scope) else {
                return Vec::new();
            };
            *scope = staged;
            (scope.publish_changes(changes), jobs)
        };
        if let Some(event) = event.0 {
            let _ = self.events.send(ActivityControlEvent::Delta(event));
        }
        event.1
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
        let target_count = state
            .scopes
            .values()
            .map(|scope| {
                scope
                    .actors
                    .values()
                    .filter(|actor| actor.target.is_some())
                    .count()
                    .saturating_add(
                        scope
                            .work_items
                            .values()
                            .filter(|work_item| work_item.target.is_some())
                            .count(),
                    )
            })
            .sum();
        (actor_count, operation_count, target_count)
    }

    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, ActivityControlRegistryState> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Drop for ActivityRuntimeControlRegistration {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let event = self.inner.upgrade().and_then(|inner| {
            let mut state = inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let is_current = state
                .scopes
                .get(&self.scope_id)
                .is_some_and(|scope| scope.generation == self.generation);
            if !is_current {
                return None;
            }
            let mut scope = state.scopes.remove(&self.scope_id)?;
            scope.removal_delta()
        });
        if let Some(event) = event {
            let _ = self.events.send(ActivityControlEvent::Delta(event));
        }
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
                ProviderActivityMutation::UpsertWorkItem(work_item) => {
                    if let Some(existing) = self.work_items.get_mut(&work_item.id) {
                        existing.owner_actor_id = work_item.owner_actor_id.clone();
                        existing.status = work_item.status;
                    } else if self.work_items.len() < ACTIVITY_PAGE_MAX_LENGTH {
                        self.work_items.insert(
                            work_item.id.clone(),
                            ActivityControlWorkItem {
                                owner_actor_id: work_item.owner_actor_id.clone(),
                                status: work_item.status,
                                target: None,
                            },
                        );
                    }
                }
                ProviderActivityMutation::RemoveWorkItem { work_item_id } => {
                    self.work_items.remove(work_item_id);
                }
                _ => {}
            }
        }
        true
    }

    fn apply_control_updates(&mut self, controls: &[ProviderActivityControlUpdate]) {
        for update in controls {
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
                    let Some(work_item) = self.work_items.get_mut(work_item_id) else {
                        continue;
                    };
                    work_item.target = if matches!(self.scope, ActivityScopeRef::Thread { .. })
                        && !work_item.status.is_terminal()
                        && work_item.owner_actor_id.is_some()
                    {
                        target.clone()
                    } else {
                        None
                    };
                }
            }
        }
        for actor in self.actors.values_mut() {
            if actor.status.is_terminal() && actor.target.take().is_some() {
                actor.control_revision = actor.control_revision.saturating_add(1);
            }
        }
        for work_item in self.work_items.values_mut() {
            if work_item.status.is_terminal() {
                work_item.target = None;
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
        }) && self.work_items.values().all(|work_item| {
            work_item
                .owner_actor_id
                .as_ref()
                .is_none_or(|owner| self.actors.contains_key(owner))
        })
    }

    pub(super) fn within_bounds(&self) -> bool {
        let target_count = self
            .actors
            .values()
            .filter(|actor| actor.target.is_some())
            .count()
            .saturating_add(
                self.work_items
                    .values()
                    .filter(|work_item| work_item.target.is_some())
                    .count(),
            );
        self.actors.len() <= ACTIVITY_PAGE_MAX_LENGTH
            && self.work_items.len() <= ACTIVITY_PAGE_MAX_LENGTH
            && self.operations.len() <= ACTIVITY_PAGE_MAX_LENGTH
            && target_count <= ACTIVITY_DELTA_MAX_CHANGES
            && self.actors.len().saturating_add(self.operations.len()) <= ACTIVITY_DELTA_MAX_CHANGES
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
                let state = if self
                    .operations
                    .values()
                    .any(|operation| operation.covered_actor_ids.contains(actor_id))
                    && !actor.status.is_terminal()
                {
                    ActivityActorControlState::Requested
                } else if matches!(self.scope, ActivityScopeRef::Thread { .. })
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

    pub(super) fn is_descendant_of(&self, actor_id: &str, ancestor_id: &str) -> bool {
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

    pub(super) fn jobs_for_operation(
        &self,
        root_actor_id: &str,
        residuals_only: bool,
    ) -> Vec<ActivityDispatchJob> {
        let Some(operation) = self.operations.get(root_actor_id) else {
            return Vec::new();
        };
        let mut jobs = Vec::new();
        let mut targets = std::collections::HashSet::new();
        let actor_ids = std::iter::once(root_actor_id)
            .chain(
                self.actors
                    .keys()
                    .map(String::as_str)
                    .filter(|actor_id| *actor_id != root_actor_id),
            )
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            let Some(actor) = self.actors.get(actor_id) else {
                continue;
            };
            let included = if residuals_only {
                operation.residual_actor_ids.contains(actor_id)
            } else {
                operation.covered_actor_ids.contains(actor_id)
            };
            let Some(target) = included
                .then_some(actor)
                .filter(|actor| !actor.status.is_terminal())
                .and_then(|actor| actor.target.clone())
            else {
                continue;
            };
            if operation.dispatched_targets.contains(&target) || !targets.insert(target.clone()) {
                continue;
            }
            jobs.push(ActivityDispatchJob {
                scope_id: self.scope_id.clone(),
                scope: self.scope.clone(),
                generation: self.generation.clone(),
                operation_root_actor_id: root_actor_id.to_owned(),
                subject: ActivityDispatchSubject::Actor {
                    actor_id: actor_id.to_owned(),
                },
                target,
            });
        }
        for (work_item_id, work_item) in &self.work_items {
            let included = if residuals_only {
                operation.residual_work_item_ids.contains(work_item_id)
            } else {
                operation.covered_work_item_ids.contains(work_item_id)
            };
            let Some(target) = included
                .then_some(work_item)
                .filter(|work_item| !work_item.status.is_terminal())
                .and_then(|work_item| work_item.target.clone())
            else {
                continue;
            };
            if operation.dispatched_targets.contains(&target) || !targets.insert(target.clone()) {
                continue;
            }
            jobs.push(ActivityDispatchJob {
                scope_id: self.scope_id.clone(),
                scope: self.scope.clone(),
                generation: self.generation.clone(),
                operation_root_actor_id: root_actor_id.to_owned(),
                subject: ActivityDispatchSubject::WorkItem {
                    work_item_id: work_item_id.clone(),
                },
                target,
            });
        }
        jobs
    }

    fn reconcile_operations(&mut self) -> Vec<ActivityDispatchJob> {
        let roots = self.operations.keys().cloned().collect::<Vec<_>>();
        let mut jobs = Vec::new();
        let mut completed = Vec::new();
        for root_actor_id in roots {
            let Some(mut operation) = self.operations.remove(&root_actor_id) else {
                continue;
            };
            let before_covered_actors = operation.covered_actor_ids.clone();
            let before_covered_work = operation.covered_work_item_ids.clone();
            let before_residual_actors = operation.residual_actor_ids.clone();
            let before_residual_work = operation.residual_work_item_ids.clone();

            operation.residual_actor_ids.retain(|actor_id| {
                self.actors
                    .get(actor_id)
                    .is_some_and(|actor| !actor.status.is_terminal())
            });
            operation.residual_work_item_ids.retain(|work_item_id| {
                self.work_items
                    .get(work_item_id)
                    .is_some_and(|work_item| !work_item.status.is_terminal())
            });

            loop {
                let newly_covered =
                    self.actors
                        .iter()
                        .filter(|(actor_id, actor)| {
                            !operation.covered_actor_ids.contains(*actor_id)
                                && actor.parent_actor_id.as_ref().is_some_and(|parent| {
                                    operation.covered_actor_ids.contains(parent)
                                })
                        })
                        .map(|(actor_id, _)| actor_id.clone())
                        .collect::<Vec<_>>();
                if newly_covered.is_empty() {
                    break;
                }
                for actor_id in newly_covered {
                    operation.covered_actor_ids.insert(actor_id.clone());
                    if self
                        .actors
                        .get(&actor_id)
                        .is_some_and(|actor| !actor.status.is_terminal())
                    {
                        operation.residual_actor_ids.insert(actor_id);
                    }
                }
            }
            for (work_item_id, work_item) in &self.work_items {
                if work_item
                    .owner_actor_id
                    .as_ref()
                    .is_some_and(|owner| operation.covered_actor_ids.contains(owner))
                    && work_item.target.is_some()
                {
                    operation.covered_work_item_ids.insert(work_item_id.clone());
                    if !work_item.status.is_terminal() {
                        operation
                            .residual_work_item_ids
                            .insert(work_item_id.clone());
                    }
                }
            }
            let changed = before_covered_actors != operation.covered_actor_ids
                || before_covered_work != operation.covered_work_item_ids
                || before_residual_actors != operation.residual_actor_ids
                || before_residual_work != operation.residual_work_item_ids;
            if changed {
                operation.operation_revision = operation.operation_revision.saturating_add(1);
            }
            if operation.residual_actor_ids.is_empty()
                && operation.residual_work_item_ids.is_empty()
            {
                completed.push(root_actor_id);
                continue;
            }
            self.operations.insert(root_actor_id.clone(), operation);
            jobs.extend(self.jobs_for_operation(&root_actor_id, true));
        }
        for root in completed {
            self.operations.remove(&root);
        }
        jobs
    }

    pub(super) fn pending_changes(
        &self,
        before: &ActivityControlScope,
    ) -> Result<Vec<ActivityControlChange>, ()> {
        let before_actors = before.actor_controls();
        let after = self.actor_controls();
        let mut changes = Vec::new();
        for actor_id in before_actors
            .keys()
            .chain(after.keys())
            .collect::<BTreeSet<_>>()
        {
            match (before_actors.get(actor_id), after.get(actor_id)) {
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
        for root_actor_id in before
            .operations
            .keys()
            .chain(self.operations.keys())
            .collect::<BTreeSet<_>>()
        {
            match (
                before
                    .operations
                    .get(root_actor_id)
                    .map(CancellationOperation::summary),
                self.operations
                    .get(root_actor_id)
                    .map(CancellationOperation::summary),
            ) {
                (Some(before), Some(after)) if before == after => {}
                (_, Some(operation)) => {
                    changes.push(ActivityControlChange::OperationUpserted { operation });
                }
                (Some(_), None) => changes.push(ActivityControlChange::OperationRemoved {
                    root_actor_id: (*root_actor_id).clone(),
                }),
                (None, None) => {}
            }
        }
        if changes.len() > ACTIVITY_DELTA_MAX_CHANGES {
            return Err(());
        }
        Ok(changes)
    }

    pub(super) fn publish_changes(
        &mut self,
        changes: Vec<ActivityControlChange>,
    ) -> Option<ActivityControlDelta> {
        if changes.is_empty() || changes.len() > ACTIVITY_DELTA_MAX_CHANGES {
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

    fn removal_delta(&mut self) -> Option<ActivityControlDelta> {
        let empty = ActivityControlScope {
            scope_id: self.scope_id.clone(),
            scope: self.scope.clone(),
            generation: self.generation.clone(),
            _provider_instance_id: None,
            revision: self.revision,
            actors: BTreeMap::new(),
            work_items: BTreeMap::new(),
            operations: BTreeMap::new(),
        };
        let changes = empty.pending_changes(self).ok()?;
        self.publish_changes(changes)
    }

    fn snapshot(&self) -> ActivityControlSnapshot {
        ActivityControlSnapshot {
            scope_id: self.scope_id(),
            revision: self.revision,
            actors: self.actor_controls().into_values().collect(),
            operations: self
                .operations
                .values()
                .map(CancellationOperation::summary)
                .collect(),
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
