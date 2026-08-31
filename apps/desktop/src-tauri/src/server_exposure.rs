use std::{future::Future, pin::Pin};

use crate::backend::BackendRunConfig;

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub(crate) trait ExposureOperations {
    fn native_exposure_available(&self) -> Result<bool, String>;
    fn persisted_mode(&self) -> Result<String, String>;
    fn persist_mode<'a>(&'a self, mode: &'a str) -> BoxFuture<'a, Result<(), String>>;
    fn current_config(&self) -> Option<BackendRunConfig>;
    fn restart_with_mode<'a>(
        &'a self,
        mode: &'a str,
    ) -> BoxFuture<'a, Result<Option<BackendRunConfig>, String>>;
    fn sync_firewall(&self, enabled: bool) -> BoxFuture<'_, Result<(), String>>;
    fn stop_backend(&self) -> BoxFuture<'_, Result<(), String>>;
}

#[derive(Clone, Default)]
pub(crate) struct ServerExposureCoordinator {
    apply_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
}

impl ServerExposureCoordinator {
    pub(crate) async fn run_exclusive<T>(&self, operation: impl Future<Output = T>) -> T {
        let _guard = self.apply_lock.lock().await;
        operation.await
    }
}

#[derive(Debug)]
pub(crate) struct ExposureTransition {
    pub(crate) current_config: Option<BackendRunConfig>,
}

pub(crate) async fn apply_exposure(
    coordinator: &ServerExposureCoordinator,
    operations: &impl ExposureOperations,
    desired: &str,
) -> Result<ExposureTransition, String> {
    if !matches!(desired, "local-only" | "network-accessible") {
        return Err(format!("Unsupported server exposure mode: {desired}"));
    }
    coordinator
        .run_exclusive(apply_exposure_locked(operations, desired))
        .await
}

pub(crate) async fn recover_local(
    operations: &impl ExposureOperations,
) -> Result<ExposureTransition, String> {
    let recovery = recover_local_steps(operations).await;
    if recovery.errors.is_empty() {
        Ok(ExposureTransition {
            current_config: recovery.current_config,
        })
    } else {
        Err(format!(
            "Could not restore local-only safeguards: {}.",
            recovery.errors.join("; ")
        ))
    }
}

async fn apply_exposure_locked(
    operations: &impl ExposureOperations,
    desired: &str,
) -> Result<ExposureTransition, String> {
    if !operations.native_exposure_available()? {
        return Err(
            "Native server exposure is unavailable while WSL-only primary mode is active."
                .to_owned(),
        );
    }
    let mut errors = Vec::new();
    if let Err(error) = operations.persisted_mode() {
        errors.push(format!("read persisted exposure mode: {error}"));
    }

    if desired == "network-accessible" {
        if errors.is_empty() {
            let restarted = match operations.restart_with_mode(desired).await {
                Ok(restarted) => restarted.or_else(|| operations.current_config()),
                Err(error) => {
                    errors.push(format!("restart network-accessible backend: {error}"));
                    None
                }
            };
            if errors.is_empty() && !is_verified_wide(restarted.as_ref()) {
                errors.push("restart did not produce a network-accessible endpoint".to_owned());
            }
            if errors.is_empty()
                && let Err(error) = operations.sync_firewall(true).await
            {
                errors.push(format!("open remote-access firewall rule: {error}"));
            }
            if errors.is_empty()
                && let Err(error) = operations.persist_mode(desired).await
            {
                errors.push(format!("persist network-accessible mode: {error}"));
            }
            if errors.is_empty() {
                return Ok(ExposureTransition {
                    current_config: restarted,
                });
            }
        }

        let recovery = recover_local_steps(operations).await;
        return Err(format_exposure_error(desired, errors, recovery.errors));
    }

    let recovery = recover_local_steps(operations).await;
    errors.extend(recovery.errors);

    if errors.is_empty() {
        Ok(ExposureTransition {
            current_config: recovery.current_config,
        })
    } else {
        Err(format_exposure_error(desired, errors, Vec::new()))
    }
}

fn is_verified_wide(config: Option<&BackendRunConfig>) -> bool {
    config.is_some_and(|config| {
        config.server_exposure_mode == "network-accessible"
            && config.endpoint_url.is_some()
            && config.advertised_host.is_some()
    })
}

fn is_verified_local(config: Option<&BackendRunConfig>) -> bool {
    config.is_none_or(|config| {
        let bind_is_local = if config.running_distro.is_some() {
            // A WSL-backed run reaches Windows through WSL's own forwarding;
            // its bind address is governed by that platform layer (surfaced
            // as externally managed), so a benign WSL narrow must not be
            // escalated into a full backend stop over the bind host alone.
            true
        } else {
            config
                .bind_host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|host| host.is_loopback())
        };
        config.server_exposure_mode == "local-only"
            && bind_is_local
            && config.endpoint_url.is_none()
            && config.advertised_host.is_none()
    })
}

struct LocalRecovery {
    current_config: Option<BackendRunConfig>,
    errors: Vec<String>,
}

async fn recover_local_steps(operations: &impl ExposureOperations) -> LocalRecovery {
    let mut errors = Vec::new();
    let persisted_local = match operations.persist_mode("local-only").await {
        Ok(()) => true,
        Err(error) => {
            errors.push(format!("persist local-only mode: {error}"));
            false
        }
    };
    let restarted = match operations.restart_with_mode("local-only").await {
        Ok(restarted) => restarted,
        Err(error) => {
            errors.push(format!("restart local-only backend: {error}"));
            None
        }
    };
    if let Err(error) = operations.sync_firewall(false).await {
        errors.push(format!("close remote-access firewall rule: {error}"));
    }
    let current_config = operations.current_config().or(restarted);
    let verified_local = is_verified_local(current_config.as_ref());
    if !verified_local {
        errors.push("actual topology is not verified local-only".to_owned());
    }
    if (!verified_local || !persisted_local)
        && let Err(error) = operations.stop_backend().await
    {
        errors.push(format!("stop unverified backend: {error}"));
    }
    LocalRecovery {
        current_config,
        errors,
    }
}

fn format_exposure_error(
    desired: &str,
    errors: Vec<String>,
    recovery_errors: Vec<String>,
) -> String {
    let initiating = if errors.is_empty() {
        "unknown transition failure".to_owned()
    } else {
        errors.join("; ")
    };
    if recovery_errors.is_empty() {
        format!(
            "Could not apply server exposure {desired}: {initiating}. Restored local-only safeguards."
        )
    } else {
        format!(
            "Could not apply server exposure {desired}: {initiating}. Local-only recovery also reported: {}.",
            recovery_errors.join("; ")
        )
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    use super::*;

    #[derive(Default)]
    struct FakeState {
        calls: Vec<String>,
        native_exposure_available: Option<bool>,
        persisted_mode: String,
        current_config: Option<BackendRunConfig>,
        persist_results: VecDeque<Result<(), String>>,
        restart_results: VecDeque<Result<Option<BackendRunConfig>, String>>,
        firewall_results: VecDeque<Result<(), String>>,
        stop_results: VecDeque<Result<(), String>>,
    }

    #[derive(Clone, Default)]
    struct FakeExposureOperations {
        state: Arc<Mutex<FakeState>>,
    }

    impl FakeExposureOperations {
        fn with_persisted_mode(mode: &str) -> Self {
            let operations = Self::default();
            operations.state.lock().expect("fake state").persisted_mode = mode.to_owned();
            operations
        }

        fn calls(&self) -> Vec<String> {
            self.state.lock().expect("fake state").calls.clone()
        }

        fn fail_next_persist(&self, detail: &str) {
            self.state
                .lock()
                .expect("fake state")
                .persist_results
                .push_back(Err(detail.to_owned()));
        }

        fn fail_next_restart(&self, detail: &str) {
            self.state
                .lock()
                .expect("fake state")
                .restart_results
                .push_back(Err(detail.to_owned()));
        }

        fn fail_next_firewall(&self, detail: &str) {
            self.state
                .lock()
                .expect("fake state")
                .firewall_results
                .push_back(Err(detail.to_owned()));
        }

        fn fail_next_stop(&self, detail: &str) {
            self.state
                .lock()
                .expect("fake state")
                .stop_results
                .push_back(Err(detail.to_owned()));
        }

        fn set_native_exposure_available(&self, available: bool) {
            self.state
                .lock()
                .expect("fake state")
                .native_exposure_available = Some(available);
        }

        fn return_next_restart(&self, result: Option<BackendRunConfig>) {
            self.state
                .lock()
                .expect("fake state")
                .restart_results
                .push_back(Ok(result));
        }

        fn set_current_config(&self, config: Option<BackendRunConfig>) {
            self.state.lock().expect("fake state").current_config = config;
        }
    }

    impl ExposureOperations for FakeExposureOperations {
        fn native_exposure_available(&self) -> Result<bool, String> {
            Ok(self
                .state
                .lock()
                .expect("fake state")
                .native_exposure_available
                .unwrap_or(true))
        }

        fn persisted_mode(&self) -> Result<String, String> {
            Ok(self
                .state
                .lock()
                .expect("fake state")
                .persisted_mode
                .clone())
        }

        fn persist_mode<'a>(&'a self, mode: &'a str) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                tokio::task::yield_now().await;
                let mut state = self.state.lock().expect("fake state");
                state.calls.push(format!("persist:{mode}"));
                let result = state.persist_results.pop_front().unwrap_or(Ok(()));
                if result.is_ok() {
                    state.persisted_mode = mode.to_owned();
                }
                result
            })
        }

        fn current_config(&self) -> Option<BackendRunConfig> {
            let mut state = self.state.lock().expect("fake state");
            state.calls.push("verify:local-only".to_owned());
            state.current_config.clone()
        }

        fn restart_with_mode<'a>(
            &'a self,
            mode: &'a str,
        ) -> BoxFuture<'a, Result<Option<BackendRunConfig>, String>> {
            Box::pin(async move {
                tokio::task::yield_now().await;
                let mut state = self.state.lock().expect("fake state");
                state.calls.push(format!("restart:{mode}"));
                let result = state
                    .restart_results
                    .pop_front()
                    .unwrap_or_else(|| Ok(Some(config_for_mode(mode))));
                if let Ok(config) = &result {
                    state.current_config = config.clone();
                }
                result
            })
        }

        fn sync_firewall(&self, enabled: bool) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                tokio::task::yield_now().await;
                let mut state = self.state.lock().expect("fake state");
                state.calls.push(format!("firewall:{enabled}"));
                state.firewall_results.pop_front().unwrap_or(Ok(()))
            })
        }

        fn stop_backend(&self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                tokio::task::yield_now().await;
                let mut state = self.state.lock().expect("fake state");
                state.calls.push("stop".to_owned());
                let result = state.stop_results.pop_front().unwrap_or(Ok(()));
                if result.is_ok() {
                    state.current_config = None;
                }
                result
            })
        }
    }

    fn config_for_mode(mode: &str) -> BackendRunConfig {
        let wide = mode == "network-accessible";
        BackendRunConfig {
            environment_id: "primary".to_owned(),
            label: "Local".to_owned(),
            running_distro: None,
            port: 3_773,
            bind_host: if wide { "0.0.0.0" } else { "127.0.0.1" }.to_owned(),
            local_host: "127.0.0.1".to_owned(),
            desktop_bootstrap_token: "desktop-token".to_owned(),
            server_exposure_mode: mode.to_owned(),
            endpoint_url: wide.then(|| "http://192.168.1.20:3773".to_owned()),
            advertised_host: wide.then(|| "192.168.1.20".to_owned()),
            tailscale_serve_enabled: false,
            tailscale_serve_port: 443,
        }
    }

    #[tokio::test]
    async fn wsl_only_topology_rejects_native_exposure_without_side_effects() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("local-only");
        operations.set_native_exposure_available(false);

        let error = apply_exposure(&coordinator, &operations, "local-only")
            .await
            .expect_err("WSL-only primary rejects native exposure");

        assert!(error.contains("WSL-only primary mode"));
        assert!(operations.calls().is_empty());
    }

    #[tokio::test]
    async fn widening_orders_restart_firewall_then_persistence() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("local-only");

        let transition = apply_exposure(&coordinator, &operations, "network-accessible")
            .await
            .expect("widening succeeds");
        assert_eq!(
            transition
                .current_config
                .expect("wide current config")
                .server_exposure_mode,
            "network-accessible"
        );

        assert_eq!(
            operations.calls(),
            [
                "restart:network-accessible",
                "firewall:true",
                "persist:network-accessible",
            ]
        );
    }

    #[tokio::test]
    async fn widening_persist_failure_runs_every_local_recovery_step() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("local-only");
        operations.fail_next_persist("settings write failed");

        let error = apply_exposure(&coordinator, &operations, "network-accessible")
            .await
            .expect_err("widening persistence failure is reported");

        assert!(error.contains("settings write failed"));
        assert_eq!(
            operations.calls(),
            [
                "restart:network-accessible",
                "firewall:true",
                "persist:network-accessible",
                "persist:local-only",
                "restart:local-only",
                "firewall:false",
                "verify:local-only",
            ]
        );
    }

    #[tokio::test]
    async fn failed_widening_attempts_every_local_safeguard_in_order_and_combines_errors() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("local-only");
        operations.return_next_restart(Some(config_for_mode("network-accessible")));
        operations.fail_next_firewall("wide firewall failed");
        operations.fail_next_persist("local persistence failed");
        operations.fail_next_restart("local restart failed");
        operations.fail_next_firewall("local firewall cleanup failed");
        operations.fail_next_stop("backend stop failed");

        let error = apply_exposure(&coordinator, &operations, "network-accessible")
            .await
            .expect_err("widening and every local safeguard failure are reported");

        for detail in [
            "wide firewall failed",
            "local persistence failed",
            "local restart failed",
            "local firewall cleanup failed",
            "backend stop failed",
        ] {
            assert!(
                error.contains(detail),
                "missing error detail {detail:?} from {error:?}"
            );
        }
        assert_eq!(
            operations.calls(),
            [
                "restart:network-accessible",
                "firewall:true",
                "persist:local-only",
                "restart:local-only",
                "firewall:false",
                "verify:local-only",
                "stop",
            ]
        );
    }

    #[tokio::test]
    async fn widening_without_an_advertised_endpoint_recovers_before_opening_the_firewall() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("local-only");
        let mut unadvertised = config_for_mode("network-accessible");
        unadvertised.endpoint_url = None;
        unadvertised.advertised_host = None;
        operations.return_next_restart(Some(unadvertised));

        let error = apply_exposure(&coordinator, &operations, "network-accessible")
            .await
            .expect_err("unadvertised wide listener is rejected");

        assert!(error.contains("did not produce a network-accessible endpoint"));
        assert_eq!(
            operations.calls(),
            [
                "restart:network-accessible",
                "persist:local-only",
                "restart:local-only",
                "firewall:false",
                "verify:local-only",
            ]
        );
    }

    #[tokio::test]
    async fn failed_recovery_persistence_still_verifies_and_stops_after_all_safeguards() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("local-only");
        operations.fail_next_persist("wide settings write failed");
        operations.fail_next_persist("local recovery settings write failed");

        let error = apply_exposure(&coordinator, &operations, "network-accessible")
            .await
            .expect_err("both persistence failures are reported");

        assert!(error.contains("wide settings write failed"));
        assert!(error.contains("local recovery settings write failed"));
        assert_eq!(
            operations.calls(),
            [
                "restart:network-accessible",
                "firewall:true",
                "persist:network-accessible",
                "persist:local-only",
                "restart:local-only",
                "firewall:false",
                "verify:local-only",
                "stop",
            ]
        );
    }

    #[tokio::test]
    async fn narrowing_persist_failure_still_restarts_local_and_closes_firewall() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("network-accessible");
        operations.fail_next_persist("settings write failed");

        let error = apply_exposure(&coordinator, &operations, "local-only")
            .await
            .expect_err("narrowing persistence failure is reported");

        assert!(error.contains("settings write failed"));
        assert_eq!(
            operations.calls(),
            [
                "persist:local-only",
                "restart:local-only",
                "firewall:false",
                "verify:local-only",
                "stop",
            ]
        );
    }

    #[tokio::test]
    async fn narrowing_stops_the_backend_when_local_persistence_fails() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("network-accessible");
        operations.fail_next_persist("first write failed");

        let error = apply_exposure(&coordinator, &operations, "local-only")
            .await
            .expect_err("persistent settings failure is reported");

        assert!(error.contains("first write failed"));
        assert_eq!(
            operations.calls(),
            [
                "persist:local-only",
                "restart:local-only",
                "firewall:false",
                "verify:local-only",
                "stop",
            ]
        );
    }

    #[tokio::test]
    async fn narrowing_rejects_a_mislabeled_wide_topology_and_stops_it() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("network-accessible");
        let mut mislabeled = config_for_mode("local-only");
        mislabeled.bind_host = "0.0.0.0".to_owned();
        mislabeled.endpoint_url = Some("http://192.168.1.20:3773".to_owned());
        mislabeled.advertised_host = Some("192.168.1.20".to_owned());
        operations.return_next_restart(Some(mislabeled));

        let error = apply_exposure(&coordinator, &operations, "local-only")
            .await
            .expect_err("mislabeled wide listener is rejected");

        assert!(error.contains("actual topology is not verified local-only"));
        assert_eq!(
            operations.calls(),
            [
                "persist:local-only",
                "restart:local-only",
                "firewall:false",
                "verify:local-only",
                "stop",
            ]
        );
    }

    #[tokio::test]
    async fn firewall_failures_are_reported_after_all_fail_closed_steps() {
        let coordinator = ServerExposureCoordinator::default();
        let widening = FakeExposureOperations::with_persisted_mode("local-only");
        widening
            .state
            .lock()
            .expect("fake state")
            .firewall_results
            .push_back(Err("open failed".to_owned()));
        let error = apply_exposure(&coordinator, &widening, "network-accessible")
            .await
            .expect_err("firewall-open failure recovers local");
        assert!(error.contains("open failed"));
        assert_eq!(
            widening.calls(),
            [
                "restart:network-accessible",
                "firewall:true",
                "persist:local-only",
                "restart:local-only",
                "firewall:false",
                "verify:local-only",
            ]
        );

        let narrowing = FakeExposureOperations::with_persisted_mode("network-accessible");
        narrowing
            .state
            .lock()
            .expect("fake state")
            .firewall_results
            .push_back(Err("close failed".to_owned()));
        let error = apply_exposure(&coordinator, &narrowing, "local-only")
            .await
            .expect_err("firewall-close failure is reported");
        assert!(error.contains("close failed"));
        assert_eq!(
            narrowing.calls(),
            [
                "persist:local-only",
                "restart:local-only",
                "firewall:false",
                "verify:local-only",
            ]
        );
    }

    #[tokio::test]
    async fn narrowing_restart_failure_closes_firewall_and_stops_the_backend() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("network-accessible");
        operations.set_current_config(Some(config_for_mode("network-accessible")));
        operations.fail_next_restart("restart failed");

        let error = apply_exposure(&coordinator, &operations, "local-only")
            .await
            .expect_err("narrowing restart failure is reported");

        assert!(error.contains("restart failed"));
        assert_eq!(
            operations.calls(),
            [
                "persist:local-only",
                "restart:local-only",
                "firewall:false",
                "verify:local-only",
                "stop",
            ]
        );
    }

    #[tokio::test]
    async fn concurrent_applies_never_interleave_side_effect_sequences() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("local-only");

        let (widen, narrow) = tokio::join!(
            apply_exposure(&coordinator, &operations, "network-accessible"),
            apply_exposure(&coordinator, &operations, "local-only"),
        );
        widen.expect("widening succeeds");
        narrow.expect("narrowing succeeds");

        let calls = operations.calls();
        let widen_then_narrow = [
            "restart:network-accessible",
            "firewall:true",
            "persist:network-accessible",
            "persist:local-only",
            "restart:local-only",
            "firewall:false",
            "verify:local-only",
        ];
        let narrow_then_widen = [
            "persist:local-only",
            "restart:local-only",
            "firewall:false",
            "verify:local-only",
            "restart:network-accessible",
            "firewall:true",
            "persist:network-accessible",
        ];
        assert!(calls == widen_then_narrow || calls == narrow_then_widen);
    }

    #[tokio::test]
    async fn exposure_apply_and_other_topology_mutation_share_one_coordinator() {
        let coordinator = ServerExposureCoordinator::default();
        let operations = FakeExposureOperations::with_persisted_mode("local-only");
        let settings_operations = operations.clone();

        let (apply, ()) = tokio::join!(
            apply_exposure(&coordinator, &operations, "network-accessible"),
            coordinator.run_exclusive(async move {
                tokio::task::yield_now().await;
                settings_operations
                    .state
                    .lock()
                    .expect("fake state")
                    .calls
                    .extend(["settings:write".to_owned(), "settings:restart".to_owned()]);
            }),
        );
        apply.expect("widening succeeds");

        let calls = operations.calls();
        assert!(
            calls
                == [
                    "restart:network-accessible",
                    "firewall:true",
                    "persist:network-accessible",
                    "settings:write",
                    "settings:restart",
                ]
                || calls
                    == [
                        "settings:write",
                        "settings:restart",
                        "restart:network-accessible",
                        "firewall:true",
                        "persist:network-accessible",
                    ]
        );
    }
}
