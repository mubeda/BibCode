use std::{future::Future, pin::Pin, sync::Arc, time::Instant};

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    activity::{
        ActivityProjection, ActivityProjections, AgentActivityController, AgentActivitySource,
    },
    diagnostics::TraceDiagnosticsStore,
    provider_terminal::{TerminalAgentActivityProviderEpochs, TerminalAgentActivityTransition},
    terminal::TerminalManager,
};

use super::provider_runtime::ProviderRuntimeSupervisor;

pub type BoxAgentActivityFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentActivityTransitionFailure {
    RecordFinalization,
    HardGateMismatch,
}

impl AgentActivityTransitionFailure {
    const fn as_trace_category(self) -> &'static str {
        match self {
            Self::RecordFinalization => "record_finalization",
            Self::HardGateMismatch => "hard_gate_mismatch",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct AgentActivityTransitionReport {
    pub enabled: bool,
    pub settings_generation: u64,
    pub observation_generation: u64,
    pub closed_subscriptions: usize,
    pub stopped_observers: usize,
    pub dormant_observers: usize,
    pub resumed_observers: usize,
    pub failed_observers: usize,
    pub unavailable_observers: usize,
    pub terminal_observation_epochs: TerminalAgentActivityProviderEpochs,
    pub finalized_records: usize,
    pub duration_ms: u64,
    pub failure: Option<AgentActivityTransitionFailure>,
}

pub trait AgentActivitySettingsHandler: Send + Sync {
    fn transition(
        &self,
        source: AgentActivitySource,
        enabled: bool,
        settings_generation: u64,
    ) -> Pin<Box<dyn Future<Output = AgentActivityTransitionReport> + Send + '_>>;
}

pub(crate) trait AgentActivityTransitionRuntime: Send + Sync {
    fn finalize_disabled_activity(
        &self,
        source: AgentActivitySource,
    ) -> BoxAgentActivityFuture<'_, Result<usize, ()>>;

    fn set_provider_activity_enabled(
        &self,
        enabled: bool,
    ) -> BoxAgentActivityFuture<'_, Result<usize, ()>>;

    fn set_terminal_activity_enabled(
        &self,
        enabled: bool,
    ) -> BoxAgentActivityFuture<'_, TerminalAgentActivityTransition>;
}

#[derive(Clone)]
pub(crate) struct AgentActivityCoordinator {
    source: AgentActivitySource,
    controller: AgentActivityController,
    trace_diagnostics: TraceDiagnosticsStore,
    environment_id: Arc<str>,
    transition_lock: Arc<Mutex<()>>,
}

impl AgentActivityCoordinator {
    #[must_use]
    pub(crate) fn new(
        source: AgentActivitySource,
        controller: AgentActivityController,
        trace_diagnostics: TraceDiagnosticsStore,
        environment_id: String,
    ) -> Self {
        Self {
            source,
            controller,
            trace_diagnostics,
            environment_id: Arc::from(bound_identifier(&environment_id)),
            transition_lock: Arc::new(Mutex::new(())),
        }
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) fn controller(&self) -> AgentActivityController {
        self.controller.clone()
    }

    pub(crate) async fn record_startup(&self, settings_generation: u64) {
        let state = self.controller.snapshot();
        let report = AgentActivityTransitionReport {
            enabled: state.enabled,
            settings_generation,
            observation_generation: state.generation,
            ..AgentActivityTransitionReport::default()
        };
        self.record_report(
            if state.enabled {
                "agent_activity_enabled"
            } else {
                "agent_activity_disabled"
            },
            "startup",
            report,
        )
        .await;
    }

    pub(crate) async fn transition(
        &self,
        runtime: &dyn AgentActivityTransitionRuntime,
        enabled: bool,
        settings_generation: u64,
    ) -> AgentActivityTransitionReport {
        let _transition = self.transition_lock.lock().await;
        let before = self.controller.snapshot();
        if before.enabled == enabled {
            return AgentActivityTransitionReport {
                enabled,
                settings_generation,
                observation_generation: before.generation,
                ..AgentActivityTransitionReport::default()
            };
        }

        let started = Instant::now();
        self.record_trace(
            "agent_activity_change_requested",
            json!({
                "cause": "settings",
                "environmentId": self.environment_id.as_ref(),
                "source": self.source.trace_label(),
                "enabled": enabled,
                "settingsGeneration": settings_generation,
                "observationGeneration": before.generation,
            }),
        )
        .await;

        let mut report = AgentActivityTransitionReport {
            enabled,
            settings_generation,
            ..AgentActivityTransitionReport::default()
        };
        if enabled {
            let state = self.controller.enable();
            report.observation_generation = state.generation;
            match self.source {
                AgentActivitySource::Chat => {
                    match runtime.set_provider_activity_enabled(true).await {
                        Ok(resumed) => {
                            report.resumed_observers =
                                report.resumed_observers.saturating_add(resumed);
                        }
                        Err(()) => {
                            report.failed_observers = report.failed_observers.saturating_add(1);
                        }
                    }
                }
                AgentActivitySource::Terminal => {
                    let terminal = runtime.set_terminal_activity_enabled(true).await;
                    merge_terminal_transition(&mut report, terminal);
                }
            }
        } else {
            let disabled = self.controller.disable().await;
            report.observation_generation = disabled.state.generation;
            report.closed_subscriptions = disabled.closed_subscriptions;
            match runtime.finalize_disabled_activity(self.source).await {
                Ok(finalized) => report.finalized_records = finalized,
                Err(()) => {
                    report.failure = Some(AgentActivityTransitionFailure::RecordFinalization);
                }
            }
            match self.source {
                AgentActivitySource::Chat => {
                    match runtime.set_provider_activity_enabled(false).await {
                        Ok(stopped) => {
                            report.stopped_observers =
                                report.stopped_observers.saturating_add(stopped);
                        }
                        Err(()) => {
                            report.failed_observers = report.failed_observers.saturating_add(1);
                        }
                    }
                }
                AgentActivitySource::Terminal => {
                    let terminal = runtime.set_terminal_activity_enabled(false).await;
                    merge_terminal_transition(&mut report, terminal);
                }
            }
        }

        let effective = self.controller.snapshot();
        report.enabled = effective.enabled;
        report.observation_generation = effective.generation;
        report.duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        if effective.enabled != enabled && report.failure.is_none() {
            report.failure = Some(AgentActivityTransitionFailure::HardGateMismatch);
        }
        if report.failed_observers > 0 {
            tracing::warn!(
                source = self.source.trace_label(),
                enabled,
                failed_observers = report.failed_observers,
                "agent activity observer transition completed with bounded failures"
            );
        }

        if let Some(failure) = report.failure {
            self.record_trace(
                "agent_activity_transition_failed",
                json!({
                    "cause": "settings",
                    "environmentId": self.environment_id.as_ref(),
                    "source": self.source.trace_label(),
                    "enabled": enabled,
                    "settingsGeneration": settings_generation,
                    "observationGeneration": report.observation_generation,
                    "errorCategory": failure.as_trace_category(),
                    "durationMs": report.duration_ms,
                }),
            )
            .await;
        } else {
            self.record_report(
                if enabled {
                    "agent_activity_enabled"
                } else {
                    "agent_activity_disabled"
                },
                "settings",
                report,
            )
            .await;
        }
        report
    }

    async fn record_report(
        &self,
        name: &'static str,
        cause: &'static str,
        report: AgentActivityTransitionReport,
    ) {
        self.record_trace(
            name,
            json!({
                "cause": cause,
                "environmentId": self.environment_id.as_ref(),
                "source": self.source.trace_label(),
                "enabled": report.enabled,
                "settingsGeneration": report.settings_generation,
                "observationGeneration": report.observation_generation,
                "closedSubscriptions": report.closed_subscriptions,
                "stoppedObservers": report.stopped_observers,
                "dormantObservers": report.dormant_observers,
                "resumedObservers": report.resumed_observers,
                "failedObservers": report.failed_observers,
                "unavailableObservers": report.unavailable_observers,
                "terminalObservationEpochs": {
                    "claude": report.terminal_observation_epochs.claude,
                    "codex": report.terminal_observation_epochs.codex,
                    "opencode": report.terminal_observation_epochs.opencode,
                },
                "finalizedRecords": report.finalized_records,
                "durationMs": report.duration_ms,
            }),
        )
        .await;
    }

    async fn record_trace(&self, name: &'static str, attributes: Value) {
        let store = self.trace_diagnostics.clone();
        let result =
            tokio::task::spawn_blocking(move || store.record_event(name, attributes)).await;
        if !matches!(result, Ok(Ok(()))) {
            tracing::warn!(
                event_name = name,
                "agent activity trace event could not be persisted"
            );
        }
    }
}

#[derive(Clone)]
pub struct ProductionAgentActivity {
    chat_coordinator: AgentActivityCoordinator,
    terminal_coordinator: AgentActivityCoordinator,
    projections: ActivityProjections,
    provider_runtime: Arc<ProviderRuntimeSupervisor>,
    terminal_manager: TerminalManager,
}

impl ProductionAgentActivity {
    #[must_use]
    pub fn new(
        controller: AgentActivityController,
        projection: ActivityProjection,
        provider_runtime: Arc<ProviderRuntimeSupervisor>,
        terminal_manager: TerminalManager,
        trace_diagnostics: TraceDiagnosticsStore,
        environment_id: String,
    ) -> Self {
        let projections = ActivityProjections::from_shared_projection(projection);
        Self {
            chat_coordinator: AgentActivityCoordinator::new(
                AgentActivitySource::Chat,
                controller.clone(),
                trace_diagnostics.clone(),
                environment_id.clone(),
            ),
            terminal_coordinator: AgentActivityCoordinator::new(
                AgentActivitySource::Terminal,
                controller,
                trace_diagnostics,
                environment_id,
            ),
            projections,
            provider_runtime,
            terminal_manager,
        }
    }

    pub async fn record_startup(&self, settings_generation: u64) {
        self.chat_coordinator
            .record_startup(settings_generation)
            .await;
        self.terminal_coordinator
            .record_startup(settings_generation)
            .await;
    }

    pub async fn transition(
        &self,
        source: AgentActivitySource,
        enabled: bool,
        settings_generation: u64,
    ) -> AgentActivityTransitionReport {
        self.coordinator(source)
            .transition(self, enabled, settings_generation)
            .await
    }

    fn coordinator(&self, source: AgentActivitySource) -> &AgentActivityCoordinator {
        match source {
            AgentActivitySource::Chat => &self.chat_coordinator,
            AgentActivitySource::Terminal => &self.terminal_coordinator,
        }
    }
}

impl AgentActivityTransitionRuntime for ProductionAgentActivity {
    fn finalize_disabled_activity(
        &self,
        source: AgentActivitySource,
    ) -> BoxAgentActivityFuture<'_, Result<usize, ()>> {
        Box::pin(async move {
            self.projections
                .for_source(source)
                .interrupt_for_monitoring_disabled(source)
                .await
                .map_err(|_| ())
        })
    }

    fn set_provider_activity_enabled(
        &self,
        enabled: bool,
    ) -> BoxAgentActivityFuture<'_, Result<usize, ()>> {
        Box::pin(async move {
            self.provider_runtime
                .set_agent_activity_enabled(enabled)
                .await
                .map_err(|_| ())
        })
    }

    fn set_terminal_activity_enabled(
        &self,
        enabled: bool,
    ) -> BoxAgentActivityFuture<'_, TerminalAgentActivityTransition> {
        Box::pin(async move {
            self.terminal_manager
                .set_agent_activity_enabled(enabled)
                .await
        })
    }
}

impl AgentActivitySettingsHandler for ProductionAgentActivity {
    fn transition(
        &self,
        source: AgentActivitySource,
        enabled: bool,
        settings_generation: u64,
    ) -> Pin<Box<dyn Future<Output = AgentActivityTransitionReport> + Send + '_>> {
        Box::pin(async move {
            ProductionAgentActivity::transition(self, source, enabled, settings_generation).await
        })
    }
}

fn merge_terminal_transition(
    report: &mut AgentActivityTransitionReport,
    terminal: TerminalAgentActivityTransition,
) {
    report.stopped_observers = report.stopped_observers.saturating_add(terminal.stopped);
    report.dormant_observers = report.dormant_observers.saturating_add(terminal.dormant);
    report.resumed_observers = report.resumed_observers.saturating_add(terminal.resumed);
    report.failed_observers = report.failed_observers.saturating_add(terminal.failed);
    report.unavailable_observers = report
        .unavailable_observers
        .saturating_add(terminal.unavailable);
    report.terminal_observation_epochs.claude = report
        .terminal_observation_epochs
        .claude
        .max(terminal.epochs.claude);
    report.terminal_observation_epochs.codex = report
        .terminal_observation_epochs
        .codex
        .max(terminal.epochs.codex);
    report.terminal_observation_epochs.opencode = report
        .terminal_observation_epochs
        .opencode
        .max(terminal.epochs.opencode);
}

fn bound_identifier(value: &str) -> String {
    value.chars().take(128).collect()
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex as StdMutex},
        time::Duration,
    };

    use crate::{
        activity::{AgentActivityController, AgentActivitySource},
        diagnostics::TraceDiagnosticsStore,
        provider_terminal::{TerminalAgentActivityProviderEpochs, TerminalAgentActivityTransition},
    };
    use serde_json::Value;

    use super::{
        AgentActivityCoordinator, AgentActivityTransitionFailure, AgentActivityTransitionRuntime,
        BoxAgentActivityFuture,
    };

    #[derive(Clone)]
    struct TestTransitionRuntime {
        calls: Arc<StdMutex<Vec<&'static str>>>,
        finalize_result: Arc<StdMutex<Result<usize, &'static str>>>,
        provider_result: Arc<StdMutex<Result<usize, &'static str>>>,
        terminal_result: Arc<StdMutex<TerminalAgentActivityTransition>>,
    }

    impl Default for TestTransitionRuntime {
        fn default() -> Self {
            Self {
                calls: Arc::default(),
                finalize_result: Arc::new(StdMutex::new(Ok(0))),
                provider_result: Arc::new(StdMutex::new(Ok(0))),
                terminal_result: Arc::default(),
            }
        }
    }

    impl TestTransitionRuntime {
        fn take_calls(&self) -> Vec<&'static str> {
            std::mem::take(&mut *self.calls.lock().expect("calls lock"))
        }
    }

    impl AgentActivityTransitionRuntime for TestTransitionRuntime {
        fn finalize_disabled_activity(
            &self,
            source: AgentActivitySource,
        ) -> BoxAgentActivityFuture<'_, Result<usize, ()>> {
            Box::pin(async move {
                self.calls.lock().expect("calls lock").push(match source {
                    AgentActivitySource::Chat => "finalize:chat",
                    AgentActivitySource::Terminal => "finalize:terminal",
                });
                self.finalize_result
                    .lock()
                    .expect("finalize result")
                    .map_err(drop)
            })
        }

        fn set_provider_activity_enabled(
            &self,
            enabled: bool,
        ) -> BoxAgentActivityFuture<'_, Result<usize, ()>> {
            Box::pin(async move {
                self.calls.lock().expect("calls lock").push(if enabled {
                    "provider:true"
                } else {
                    "provider:false"
                });
                self.provider_result
                    .lock()
                    .expect("provider result")
                    .map_err(drop)
            })
        }

        fn set_terminal_activity_enabled(
            &self,
            enabled: bool,
        ) -> BoxAgentActivityFuture<'_, TerminalAgentActivityTransition> {
            Box::pin(async move {
                self.calls.lock().expect("calls lock").push(if enabled {
                    "terminal:true"
                } else {
                    "terminal:false"
                });
                *self.terminal_result.lock().expect("terminal result")
            })
        }
    }

    fn trace_records(store: &TraceDiagnosticsStore) -> Vec<Value> {
        std::fs::read_to_string(store.path())
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid trace record"))
            .collect()
    }

    fn test_coordinator(
        source: AgentActivitySource,
        enabled: bool,
    ) -> (
        AgentActivityCoordinator,
        TestTransitionRuntime,
        TraceDiagnosticsStore,
        tempfile::TempDir,
    ) {
        let temp = tempfile::tempdir().expect("trace directory");
        let path = temp.path().join("server.trace.ndjson");
        let trace = TraceDiagnosticsStore::new(path);
        let runtime = TestTransitionRuntime::default();
        let coordinator = AgentActivityCoordinator::new(
            source,
            AgentActivityController::new(enabled),
            trace.clone(),
            "environment-test".to_owned(),
        );
        (coordinator, runtime, trace, temp)
    }

    #[tokio::test]
    async fn disable_waits_for_stream_drain_then_finalizes_before_observer_shutdown() {
        let (coordinator, runtime, trace, _temp) =
            test_coordinator(AgentActivitySource::Chat, true);
        *runtime.terminal_result.lock().expect("terminal result") =
            TerminalAgentActivityTransition {
                stopped: 2,
                dormant: 1,
                resumed: 0,
                failed: 0,
                ..TerminalAgentActivityTransition::default()
            };
        let registration = coordinator
            .controller()
            .register_stream()
            .expect("enabled stream");
        let mut states = coordinator.controller().subscribe();
        let transition = tokio::spawn({
            let coordinator = coordinator.clone();
            let runtime = runtime.clone();
            async move { coordinator.transition(&runtime, false, 4).await }
        });
        tokio::time::timeout(Duration::from_secs(5), states.changed())
            .await
            .expect("disable transition timeout")
            .expect("activity state remains open");

        assert!(!transition.is_finished());
        let requested = trace_records(&trace);
        assert_eq!(requested.len(), 1);
        assert_eq!(requested[0]["name"], "agent_activity_change_requested");
        assert!(!coordinator.controller().snapshot().enabled);

        drop(registration);
        let report = transition.await.expect("transition task");

        assert_eq!(
            runtime.take_calls(),
            vec!["finalize:chat", "provider:false"]
        );
        assert_eq!(report.closed_subscriptions, 1);
        assert_eq!(report.finalized_records, 0);
        assert_eq!(report.stopped_observers, 0);
        assert_eq!(report.dormant_observers, 0);
        assert_eq!(
            report.terminal_observation_epochs,
            TerminalAgentActivityProviderEpochs::default()
        );
        assert_eq!(report.failure, None);
        let records = trace_records(&trace);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["events"][0]["attributes"]["source"], "chat");
        assert_eq!(records[1]["name"], "agent_activity_disabled");
        assert_eq!(records[1]["events"][0]["attributes"]["enabled"], false);
        assert_eq!(records[1]["events"][0]["attributes"]["source"], "chat");
    }

    #[tokio::test]
    async fn terminal_disable_finalizes_terminal_records_and_stops_only_terminal_observers() {
        let (coordinator, runtime, trace, _temp) =
            test_coordinator(AgentActivitySource::Terminal, true);
        *runtime.provider_result.lock().expect("provider result") = Ok(7);
        *runtime.terminal_result.lock().expect("terminal result") =
            TerminalAgentActivityTransition {
                stopped: 2,
                dormant: 1,
                epochs: TerminalAgentActivityProviderEpochs {
                    claude: 3,
                    codex: 5,
                    opencode: 4,
                },
                ..TerminalAgentActivityTransition::default()
            };

        let report = coordinator.transition(&runtime, false, 2).await;

        assert_eq!(
            runtime.take_calls(),
            vec!["finalize:terminal", "terminal:false"]
        );
        assert_eq!(report.stopped_observers, 2);
        assert_eq!(report.dormant_observers, 1);
        assert_eq!(
            report.terminal_observation_epochs,
            TerminalAgentActivityProviderEpochs {
                claude: 3,
                codex: 5,
                opencode: 4,
            }
        );
        let records = trace_records(&trace);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["events"][0]["attributes"]["source"], "terminal");
        assert_eq!(records[1]["events"][0]["attributes"]["source"], "terminal");
    }

    #[tokio::test]
    async fn repeated_requested_state_is_idempotent_without_trace_or_runtime_work() {
        let (coordinator, runtime, trace, _temp) =
            test_coordinator(AgentActivitySource::Chat, false);

        let report = coordinator.transition(&runtime, false, 5).await;

        assert!(!report.enabled);
        assert!(runtime.take_calls().is_empty());
        assert!(trace_records(&trace).is_empty());
    }

    #[tokio::test]
    async fn enabling_stays_effective_and_reports_bounded_observer_failures() {
        let (coordinator, runtime, trace, _temp) =
            test_coordinator(AgentActivitySource::Terminal, false);
        *runtime.provider_result.lock().expect("provider result") = Ok(2);
        *runtime.terminal_result.lock().expect("terminal result") =
            TerminalAgentActivityTransition {
                resumed: 3,
                failed: 1,
                unavailable: 1,
                epochs: TerminalAgentActivityProviderEpochs {
                    claude: 2,
                    codex: 4,
                    opencode: 3,
                },
                ..TerminalAgentActivityTransition::default()
            };

        let report = coordinator.transition(&runtime, true, 6).await;

        assert!(coordinator.controller().snapshot().enabled);
        assert!(report.enabled);
        assert_eq!(runtime.take_calls(), vec!["terminal:true"]);
        assert_eq!(report.resumed_observers, 3);
        assert_eq!(report.failed_observers, 1);
        assert_eq!(report.unavailable_observers, 1);
        assert_eq!(
            report.terminal_observation_epochs,
            TerminalAgentActivityProviderEpochs {
                claude: 2,
                codex: 4,
                opencode: 3,
            }
        );
        assert_eq!(report.failure, None);
        let records = trace_records(&trace);
        assert_eq!(
            records
                .iter()
                .filter(|record| record["name"] == "agent_activity_change_requested")
                .count(),
            1
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record["name"] == "agent_activity_enabled")
                .count(),
            1
        );
        assert_eq!(records[1]["name"], "agent_activity_enabled");
        assert_eq!(records[1]["events"][0]["attributes"]["failedObservers"], 1);
        assert_eq!(
            records[1]["events"][0]["attributes"]["unavailableObservers"],
            1
        );
        assert_eq!(
            records[1]["events"][0]["attributes"]["terminalObservationEpochs"],
            serde_json::json!({"claude": 2, "codex": 4, "opencode": 3}),
        );
    }

    #[tokio::test]
    async fn invariant_failure_emits_one_bounded_failure_event() {
        let (coordinator, runtime, trace, _temp) =
            test_coordinator(AgentActivitySource::Chat, true);
        *runtime.finalize_result.lock().expect("finalize result") = Err("secret payload");

        let report = coordinator.transition(&runtime, false, 7).await;

        assert!(!report.enabled);
        assert_eq!(report.failed_observers, 0);
        assert_eq!(
            report.failure,
            Some(AgentActivityTransitionFailure::RecordFinalization)
        );
        let records = trace_records(&trace);
        assert_eq!(records.len(), 2);
        assert_eq!(records[1]["name"], "agent_activity_transition_failed");
        assert_eq!(
            records[1]["events"][0]["attributes"]["errorCategory"],
            "record_finalization"
        );
        assert_eq!(records[1]["events"][0]["attributes"]["source"], "chat");
        assert!(!records[1].to_string().contains("secret payload"));
    }

    #[tokio::test]
    async fn chat_enable_resumes_only_provider_observers_without_terminal_epochs() {
        let (coordinator, runtime, _trace, _temp) =
            test_coordinator(AgentActivitySource::Chat, false);
        *runtime.provider_result.lock().expect("provider result") = Ok(2);
        *runtime.terminal_result.lock().expect("terminal result") =
            TerminalAgentActivityTransition {
                resumed: 9,
                epochs: TerminalAgentActivityProviderEpochs {
                    claude: 2,
                    codex: 4,
                    opencode: 3,
                },
                ..TerminalAgentActivityTransition::default()
            };

        let report = coordinator.transition(&runtime, true, 8).await;

        assert_eq!(runtime.take_calls(), vec!["provider:true"]);
        assert_eq!(report.resumed_observers, 2);
        assert_eq!(
            report.terminal_observation_epochs,
            TerminalAgentActivityProviderEpochs::default()
        );
    }

    #[tokio::test]
    async fn startup_trace_records_the_coordinator_source() {
        let (chat, _runtime, chat_trace, _chat_temp) =
            test_coordinator(AgentActivitySource::Chat, true);
        let (terminal, _runtime, terminal_trace, _terminal_temp) =
            test_coordinator(AgentActivitySource::Terminal, false);

        chat.record_startup(1).await;
        terminal.record_startup(2).await;

        assert_eq!(
            trace_records(&chat_trace)[0]["events"][0]["attributes"]["source"],
            "chat"
        );
        assert_eq!(
            trace_records(&terminal_trace)[0]["events"][0]["attributes"]["source"],
            "terminal"
        );
    }

    #[tokio::test]
    async fn rejected_event_volume_creates_no_trace_records() {
        let (coordinator, _runtime, trace, _temp) =
            test_coordinator(AgentActivitySource::Chat, false);

        for _ in 0..10_000 {
            assert!(coordinator.controller().admit().is_none());
        }

        assert!(trace_records(&trace).is_empty());
    }
}
