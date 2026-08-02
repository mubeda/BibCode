use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
#[cfg(test)]
use tokio::sync::{Barrier, Notify};
use tokio::sync::{Mutex, RwLock, broadcast, mpsc, watch};
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use crate::{
    ServerConfig,
    diagnostics::TraceDiagnosticsStore,
    persistence::{read_json, write_bytes_atomically, write_json_atomically},
    production::{
        agent_activity::AgentActivitySettingsHandler,
        keybindings, local_servers, provider_inventory,
        provider_maintenance::{
            ProviderMaintenance, ProviderMaintenanceTarget, ProviderUpdateLifecycleToken,
        },
        server_terminal::{JsonFuture, JsonStream, ProductionServerControl},
    },
    server_settings::ProviderSettingsState,
};

const MAX_KEYBINDINGS: usize = 256;

fn provider_snapshot_identity(snapshot: &Value) -> Option<(&str, &str)> {
    Some((
        snapshot.get("instanceId")?.as_str()?,
        snapshot.get("driver")?.as_str()?,
    ))
}

fn merge_provider_snapshot(
    current: Option<&Value>,
    refreshed: provider_inventory::ProviderProbeResult,
) -> Value {
    let models_authoritative = refreshed.models_authoritative;
    let mut next = refreshed.snapshot;
    if refreshed.rich_metadata == provider_inventory::RichMetadataOutcome::Succeeded {
        return next;
    }
    let Some(current) = current else {
        return next;
    };
    let Some(current_identity) = provider_snapshot_identity(current) else {
        return next;
    };
    if provider_snapshot_identity(&next) != Some(current_identity) {
        return next;
    }
    if !models_authoritative && let Some(value) = current.get("models") {
        next["models"] = value.clone();
    }
    for field in ["slashCommands", "skills", "agents"] {
        if let Some(value) = current.get(field) {
            next[field] = value.clone();
        }
    }
    next
}

fn provider_update_state(
    status: &str,
    started_at: Option<&str>,
    finished_at: Option<&str>,
    message: &str,
    output: Option<&str>,
) -> Value {
    json!({
        "status": status,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "message": message,
        "output": output,
    })
}

fn post_update_status(providers: &[Value], instance_id: &str) -> &'static str {
    match providers
        .iter()
        .find(|provider| provider["instanceId"] == instance_id)
    {
        Some(provider) if provider["versionAdvisory"]["status"] == "current" => "succeeded",
        _ => "unchanged",
    }
}

fn provider_update_error(provider: &str, reason: impl Into<String>) -> Value {
    json!({
        "_tag": "ServerProviderUpdateError",
        "provider": provider,
        "reason": reason.into(),
    })
}

#[cfg(test)]
#[derive(Clone, Debug)]
struct ProviderProbePause {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

#[derive(Debug)]
pub(crate) struct ProviderUpdateCheckTask {
    cancellation: CancellationToken,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    refresh_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl ProviderUpdateCheckTask {
    pub(crate) async fn shutdown(&self) {
        self.cancellation.cancel();
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
        if let Some(task) = self.refresh_task.lock().await.take() {
            let _ = task.await;
        }
    }
}

impl Drop for ProviderUpdateCheckTask {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

#[cfg(test)]
impl ProviderProbePause {
    fn new() -> Self {
        Self {
            entered: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        }
    }

    async fn wait_until_entered(&self) {
        self.entered.notified().await;
    }

    fn release(&self) {
        self.release.notify_one();
    }
}

#[derive(Clone, Default)]
struct AgentActivityHandlerSlot {
    handler: Arc<RwLock<Option<Arc<dyn AgentActivitySettingsHandler>>>>,
}

impl fmt::Debug for AgentActivityHandlerSlot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentActivityHandlerSlot")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct NativeServerControl {
    config: ServerConfig,
    auth_descriptor: Value,
    state_directory: PathBuf,
    settings_path: PathBuf,
    keybindings_path: PathBuf,
    settings: Arc<RwLock<Value>>,
    automatic_git_fetch_interval: watch::Sender<Duration>,
    settings_update_lock: Arc<Mutex<()>>,
    settings_generation: Arc<AtomicU64>,
    agent_activity_handler: AgentActivityHandlerSlot,
    next_provider_probe_sequence: Arc<AtomicU64>,
    latest_published_provider_probe_sequence: Arc<AtomicU64>,
    #[cfg(test)]
    provider_update_refresh_attempts: Arc<AtomicU64>,
    #[cfg(test)]
    latest_full_provider_refresh_generation: Arc<AtomicU64>,
    settings_load_error: Option<Value>,
    #[cfg(test)]
    settings_update_barrier: Arc<RwLock<Option<Arc<Barrier>>>>,
    #[cfg(test)]
    next_quick_provider_probe_pause: Arc<Mutex<Option<ProviderProbePause>>>,
    #[cfg(test)]
    next_full_provider_probe_pause: Arc<Mutex<Option<ProviderProbePause>>>,
    #[cfg(test)]
    next_full_provider_refresh_handoff_pause: Arc<Mutex<Option<ProviderProbePause>>>,
    keybinding_rules: Arc<RwLock<Vec<Value>>>,
    keybinding_issues: Arc<RwLock<Vec<Value>>>,
    providers: Arc<RwLock<Vec<Value>>>,
    provider_maintenance: ProviderMaintenance,
    full_provider_refresh_running: Arc<AtomicBool>,
    activity_protocol_registered: Arc<AtomicBool>,
    config_events: broadcast::Sender<Value>,
    trace_diagnostics: TraceDiagnosticsStore,
}

impl crate::git::WorktreeBaseDirectoryProvider for NativeServerControl {
    fn worktree_base_directory<'a>(&'a self) -> crate::git::BoxWorktreeBaseDirectoryFuture<'a> {
        Box::pin(async move {
            self.settings
                .read()
                .await
                .get("worktreeBaseDirectory")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
    }
}

impl NativeServerControl {
    pub async fn new(config: ServerConfig, auth_descriptor: Value) -> Self {
        let trace_diagnostics =
            TraceDiagnosticsStore::new(config.state_dir().join("logs/server.trace.ndjson"));
        Self::with_trace_diagnostics(config, auth_descriptor, trace_diagnostics).await
    }

    pub async fn with_trace_diagnostics(
        config: ServerConfig,
        auth_descriptor: Value,
        trace_diagnostics: TraceDiagnosticsStore,
    ) -> Self {
        let state_directory = config.state_dir();
        let settings_path = state_directory.join("settings.json");
        let keybindings_path = state_directory.join("keybindings.json");
        let (mut settings, settings_load_error) = match read_json::<Value>(&settings_path).await {
            Ok(Some(settings)) => match validate_settings_document(&settings) {
                Ok(()) => (settings, None),
                Err(cause) => (
                    json!({}),
                    Some(settings_error(&settings_path, "normalize", &cause)),
                ),
            },
            Ok(None) => (json!({}), None),
            Err(error) => (
                json!({}),
                Some(settings_error(
                    &settings_path,
                    "read-file",
                    &error.to_string(),
                )),
            ),
        };
        apply_settings_defaults(&mut settings);
        redact_sensitive_environment(&mut settings);
        let (automatic_git_fetch_interval, _) =
            watch::channel(automatic_git_fetch_interval(&settings));
        let loaded_keybindings = keybindings::load(&keybindings_path).await;
        let cwd = std::env::current_dir().unwrap_or_else(|_| config.base_dir.clone());
        let provider_maintenance = ProviderMaintenance::new();
        let providers = provider_inventory::probe(&settings, None, &cwd, &provider_maintenance)
            .await
            .into_iter()
            .map(|result| result.snapshot)
            .collect();
        let (config_events, _) = broadcast::channel(32);
        Self {
            config,
            auth_descriptor,
            state_directory,
            settings_path,
            keybindings_path,
            settings: Arc::new(RwLock::new(settings.clone())),
            automatic_git_fetch_interval,
            settings_update_lock: Arc::new(Mutex::new(())),
            settings_generation: Arc::new(AtomicU64::new(0)),
            agent_activity_handler: AgentActivityHandlerSlot::default(),
            next_provider_probe_sequence: Arc::new(AtomicU64::new(0)),
            latest_published_provider_probe_sequence: Arc::new(AtomicU64::new(0)),
            #[cfg(test)]
            provider_update_refresh_attempts: Arc::new(AtomicU64::new(0)),
            #[cfg(test)]
            latest_full_provider_refresh_generation: Arc::new(AtomicU64::new(0)),
            settings_load_error,
            #[cfg(test)]
            settings_update_barrier: Arc::new(RwLock::new(None)),
            #[cfg(test)]
            next_quick_provider_probe_pause: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            next_full_provider_probe_pause: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            next_full_provider_refresh_handoff_pause: Arc::new(Mutex::new(None)),
            keybinding_rules: Arc::new(RwLock::new(loaded_keybindings.rules)),
            keybinding_issues: Arc::new(RwLock::new(loaded_keybindings.issues)),
            providers: Arc::new(RwLock::new(providers)),
            provider_maintenance,
            full_provider_refresh_running: Arc::new(AtomicBool::new(false)),
            activity_protocol_registered: Arc::new(AtomicBool::new(false)),
            config_events,
            trace_diagnostics,
        }
    }

    /// Marks the structured activity protocol ready after the production registry
    /// finalization boundary has validated every required RPC.
    pub(super) fn mark_activity_protocol_registered_after_validation(&self) {
        self.activity_protocol_registered
            .store(true, Ordering::Release);
    }

    pub async fn config_snapshot(&self) -> Value {
        let settings = self.settings.read().await.clone();
        let rules = self.keybinding_rules.read().await.clone();
        let issues = self.keybinding_issues.read().await.clone();
        let providers = self.providers.read().await.clone();
        let cwd = current_directory(&self.config);
        json!({
            "environment": environment_descriptor(
                &self.config,
                self.activity_protocol_registered.load(Ordering::Acquire),
            ),
            "auth": self.auth_descriptor,
            "cwd": cwd,
            "keybindingsConfigPath": self.keybindings_path.to_string_lossy(),
            "keybindings": keybindings::resolve(&rules),
            "issues": issues,
            "providers": providers,
            "availableEditors": available_editors(),
            "observability": observability_snapshot(&self.state_directory),
            "settings": settings,
        })
    }

    pub(crate) fn automatic_git_fetch_interval_signal(&self) -> watch::Sender<Duration> {
        self.automatic_git_fetch_interval.clone()
    }

    pub async fn attach_agent_activity_handler(
        &self,
        handler: Arc<dyn AgentActivitySettingsHandler>,
    ) {
        *self.agent_activity_handler.handler.write().await = Some(handler);
    }

    pub async fn agent_activity_enabled(&self) -> bool {
        self.settings
            .read()
            .await
            .get("enableAgentActivity")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    async fn update_settings(&self, payload: Value) -> Result<Value, Value> {
        let mut patch = payload.get("patch").cloned().ok_or_else(|| {
            settings_error(&self.settings_path, "normalize", "missing settings patch")
        })?;
        if !patch.is_object() {
            return Err(settings_error(
                &self.settings_path,
                "normalize",
                "settings patch must be an object",
            ));
        }
        if let Some(raw) = patch.get("worktreeBaseDirectory").and_then(Value::as_str) {
            let normalized = super::worktree_workspace::normalize_worktree_workspace(raw)
                .await
                .map_err(|error| error.to_wire())?;
            patch["worktreeBaseDirectory"] = json!(normalized);
        }

        #[cfg(test)]
        if let Some(barrier) = self.settings_update_barrier.read().await.clone() {
            barrier.wait().await;
        }
        let update_guard = Arc::clone(&self.settings_update_lock).lock_owned().await;
        if let Some(error) = &self.settings_load_error {
            return Err(error.clone());
        }
        let current = self.settings.read().await.clone();
        let previous_agent_activity = current
            .get("enableAgentActivity")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut next = current;
        apply_settings_patch(&mut next, patch);
        apply_settings_defaults(&mut next);
        validate_settings_document(&next)
            .map_err(|cause| settings_error(&self.settings_path, "normalize", &cause))?;
        persist_sensitive_environment(&self.state_directory, &mut next)
            .await
            .map_err(|message| settings_error(&self.settings_path, "write-secret", &message))?;
        write_json_atomically(&self.settings_path, &next)
            .await
            .map_err(|error| {
                settings_error(&self.settings_path, "write-file", &error.to_string())
            })?;
        redact_sensitive_environment(&mut next);
        let generation = self.settings_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let next_agent_activity = next
            .get("enableAgentActivity")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let commit_control = self.clone();
        let commit = tokio::spawn(async move {
            if next_agent_activity != previous_agent_activity
                && let Some(handler) = commit_control
                    .agent_activity_handler
                    .handler
                    .read()
                    .await
                    .clone()
            {
                let _ = handler.transition(next_agent_activity, generation).await;
            }
            commit_control
                .provider_maintenance
                .invalidate_update_lifecycles(|instance_id, driver| {
                    provider_inventory::maintenance_target(
                        &next,
                        driver,
                        Some(instance_id),
                    )
                    .is_some()
                });
            *commit_control.settings.write().await = next.clone();
            let next_fetch_interval = automatic_git_fetch_interval(&next);
            commit_control
                .automatic_git_fetch_interval
                .send_if_modified(|current| {
                    if *current == next_fetch_interval {
                        return false;
                    }
                    *current = next_fetch_interval;
                    true
                });
            commit_control.publish(json!({
                "version": 1,
                "type": "settingsUpdated",
                "payload": { "settings": next.clone() },
            }));
            drop(update_guard);
            next
        });
        let next = commit.await.map_err(|_| {
            settings_error(
                &self.settings_path,
                "commit",
                "persisted settings commit task stopped unexpectedly",
            )
        })?;

        let cwd = std::env::current_dir().unwrap_or_else(|_| self.config.base_dir.clone());
        let probe_sequence = self.begin_provider_probe();
        let providers = self.probe_provider_snapshots(&next, None, &cwd).await;
        self.publish_provider_snapshots_if_current(
            providers,
            false,
            generation,
            &next,
            probe_sequence,
        )
        .await;
        self.spawn_full_provider_refresh(generation, next.clone(), cwd);
        Ok(next)
    }

    #[cfg(test)]
    async fn install_settings_update_barrier(&self, parties: usize) {
        *self.settings_update_barrier.write().await = Some(Arc::new(Barrier::new(parties)));
    }

    #[cfg(test)]
    async fn install_next_quick_provider_probe_pause(&self) -> ProviderProbePause {
        let pause = ProviderProbePause::new();
        *self.next_quick_provider_probe_pause.lock().await = Some(pause.clone());
        pause
    }

    #[cfg(test)]
    async fn install_next_full_provider_probe_pause(&self) -> ProviderProbePause {
        let pause = ProviderProbePause::new();
        *self.next_full_provider_probe_pause.lock().await = Some(pause.clone());
        pause
    }

    #[cfg(test)]
    async fn install_next_full_provider_refresh_handoff_pause(&self) -> ProviderProbePause {
        let pause = ProviderProbePause::new();
        *self.next_full_provider_refresh_handoff_pause.lock().await = Some(pause.clone());
        pause
    }

    async fn refresh_providers(&self, payload: &Value) -> Value {
        let instance_id = payload.get("instanceId").and_then(Value::as_str);
        let (generation, settings) = self.settings_snapshot().await;
        let cwd = std::env::current_dir().unwrap_or_else(|_| self.config.base_dir.clone());
        let probe_sequence = self.begin_provider_probe();
        let refreshed = self
            .probe_full_provider_snapshots(&settings, instance_id, &cwd)
            .await;
        let providers = match self
            .publish_provider_snapshots_if_current(
                refreshed,
                instance_id.is_some(),
                generation,
                &settings,
                probe_sequence,
            )
            .await
        {
            Some(providers) => providers,
            None => self.providers.read().await.clone(),
        };
        json!({ "providers": providers })
    }

    async fn publish_provider_update_state(
        &self,
        target: &ProviderMaintenanceTarget,
        token: ProviderUpdateLifecycleToken,
        state: Value,
    ) -> Vec<Value> {
        let _update_guard = self.settings_update_lock.lock().await;
        let configured = provider_inventory::maintenance_target(
            &*self.settings.read().await,
            &target.driver,
            Some(&target.instance_id),
        )
        .is_some();
        if configured {
            self.provider_maintenance.set_update_state_if_current(
                &target.instance_id,
                &target.driver,
                token,
                state,
            );
        } else {
            self.provider_maintenance
                .invalidate_update_lifecycle_if_current(
                    &target.instance_id,
                    &target.driver,
                    token,
                );
        }
        let mut providers = self.providers.write().await;
        for provider in providers.iter_mut() {
            self.provider_maintenance.overlay_update_state(provider);
        }
        let snapshot = providers.clone();
        drop(providers);
        self.publish_provider_snapshots(&snapshot);
        snapshot
    }

    async fn update_provider(
        &self,
        payload: &Value,
        cancellation: CancellationToken,
    ) -> Result<Value, Value> {
        let provider = payload
            .get("provider")
            .and_then(Value::as_str)
            .ok_or_else(|| provider_update_error("unknown", "provider must be a valid provider slug"))?;
        validate_slug(provider, "provider").map_err(|reason| provider_update_error("unknown", reason))?;
        let instance_id = match payload.get("instanceId") {
            None => None,
            Some(Value::String(instance_id)) => {
                validate_slug(instance_id, "instanceId")
                    .map_err(|reason| provider_update_error(provider, reason))?;
                Some(instance_id.as_str())
            }
            Some(_) => {
                return Err(provider_update_error(
                    provider,
                    "instanceId must be a valid provider slug",
                ));
            }
        };
        let (_, settings) = self.settings_snapshot().await;
        let target = provider_inventory::maintenance_target(&settings, provider, instance_id)
            .ok_or_else(|| {
                provider_update_error(
                    provider,
                    "The requested provider instance does not match this provider.",
                )
            })?;
        let capabilities = self.provider_maintenance.capabilities(&target).await;
        let update = capabilities.update.ok_or_else(|| {
            provider_update_error(
                provider,
                "This provider does not expose a safe native self-update command.",
            )
        })?;
        let reservation = {
            let _update_guard = self.settings_update_lock.lock().await;
            if provider_inventory::maintenance_target(
                &*self.settings.read().await,
                &target.driver,
                Some(&target.instance_id),
            )
            .is_none()
            {
                return Err(provider_update_error(
                    provider,
                    "The requested provider instance does not match this provider.",
                ));
            }
            self.provider_maintenance
                .reserve_target(&target.instance_id, &target.driver)
        }
        .map_err(|reason| provider_update_error(provider, reason))?;
        let update_token = reservation.token();
        let lock = self.provider_maintenance.command_lock(update.lock_key);
        let command_guard = match lock.clone().try_lock_owned() {
            Ok(guard) => guard,
            Err(_) => {
                self.publish_provider_update_state(
                    &target,
                    update_token,
                    provider_update_state(
                        "queued",
                        None,
                        None,
                        "Waiting for another provider update to finish.",
                        None,
                    ),
                )
                .await;
                tokio::select! {
                    guard = lock.lock_owned() => guard,
                    () = cancellation.cancelled() => {
                        let finished_at = now_iso();
                        let providers = self.publish_provider_update_state(
                            &target,
                            update_token,
                            provider_update_state(
                                "failed",
                                None,
                                Some(&finished_at),
                                "Provider update was cancelled.",
                                Some("provider.maintenance.update was cancelled"),
                            ),
                        ).await;
                        return Ok(json!({ "providers": providers }));
                    }
                }
            }
        };
        let started_at = now_iso();
        self.publish_provider_update_state(
            &target,
            update_token,
            provider_update_state(
                "running",
                Some(&started_at),
                None,
                "Updating provider.",
                None,
            ),
        )
        .await;
        let command_result = match self
            .provider_maintenance
            .run_update_command(&target, &update, &cancellation)
            .await
        {
            Ok(result) => result,
            Err(error) => {
                drop(command_guard);
                let finished_at = now_iso();
                let providers = self
                    .publish_provider_update_state(
                        &target,
                        update_token,
                        provider_update_state(
                            "failed",
                            Some(&started_at),
                            Some(&finished_at),
                            "Provider update failed.",
                            Some(&error),
                        ),
                    )
                    .await;
                return Ok(json!({ "providers": providers }));
            }
        };
        if command_result.exit_code != 0 {
            drop(command_guard);
            let finished_at = now_iso();
            let message = format!(
                "Update command exited with code {}.",
                command_result.exit_code
            );
            let providers = self
                .publish_provider_update_state(
                    &target,
                    update_token,
                    provider_update_state(
                        "failed",
                        Some(&started_at),
                        Some(&finished_at),
                        &message,
                        command_result.output.as_deref(),
                    ),
                )
                .await;
            return Ok(json!({ "providers": providers }));
        }
        drop(command_guard);

        let (generation, settings) = self.settings_snapshot().await;
        let cwd = std::env::current_dir().unwrap_or_else(|_| self.config.base_dir.clone());
        let probe_sequence = self.begin_provider_probe();
        let refreshed = self
            .probe_full_provider_snapshots(&settings, Some(&target.instance_id), &cwd)
            .await;
        let verification = refreshed
            .iter()
            .map(|result| result.snapshot.clone())
            .collect::<Vec<_>>();
        let (status, message) = match self
            .publish_provider_snapshots_if_current(
                refreshed,
                true,
                generation,
                &settings,
                probe_sequence,
            )
            .await
        {
            Some(_) => {
                let status = post_update_status(&verification, &target.instance_id);
                let message = match status {
                    "succeeded" => "Provider updated.",
                    _ if verification.iter().any(|provider| {
                        provider["instanceId"] == target.instance_id
                            && provider["versionAdvisory"]["status"] == "behind_latest"
                    }) => {
                        "Update command completed, but BiBCode still detects an outdated provider version."
                    }
                    _ => "Update command completed, but BiBCode could not verify the provider version.",
                };
                (status, message)
            }
            None => (
                "unchanged",
                "Update command completed, but BiBCode could not verify the provider version.",
            ),
        };
        let finished_at = now_iso();
        let providers = self
            .publish_provider_update_state(
                &target,
                update_token,
                provider_update_state(
                    status,
                    Some(&started_at),
                    Some(&finished_at),
                    message,
                    command_result.output.as_deref(),
                ),
            )
            .await;
        Ok(json!({ "providers": providers }))
    }

    async fn settings_snapshot(&self) -> (u64, Value) {
        let _update_guard = self.settings_update_lock.lock().await;
        (
            self.settings_generation.load(Ordering::Acquire),
            self.settings.read().await.clone(),
        )
    }

    async fn request_full_provider_refresh(
        &self,
        cancellation: CancellationToken,
        refresh_task: &Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    ) {
        #[cfg(test)]
        self.provider_update_refresh_attempts
            .fetch_add(1, Ordering::AcqRel);
        let (generation, settings) = self.settings_snapshot().await;
        let cwd = std::env::current_dir().unwrap_or_else(|_| self.config.base_dir.clone());
        if cancellation.is_cancelled() {
            return;
        }
        if let Some(task) = self.start_full_provider_refresh(
            generation,
            settings,
            cwd,
            Some(cancellation),
        ) {
            if let Some(previous) = refresh_task.lock().await.replace(task) {
                let _ = previous.await;
            }
        }
    }

    pub(crate) fn start_provider_update_checks(&self) -> ProviderUpdateCheckTask {
        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let control = self.clone();
        let refresh_task = Arc::new(Mutex::new(None));
        let task_refresh = refresh_task.clone();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    () = task_cancellation.cancelled() => break,
                    _ = interval.tick() => {
                        if task_cancellation.is_cancelled() {
                            break;
                        }
                        control
                            .request_full_provider_refresh(task_cancellation.clone(), &task_refresh)
                            .await;
                    }
                }
            }
        });
        ProviderUpdateCheckTask {
            cancellation,
            task: Mutex::new(Some(task)),
            refresh_task,
        }
    }

    fn begin_provider_probe(&self) -> u64 {
        self.next_provider_probe_sequence
            .fetch_add(1, Ordering::AcqRel)
            + 1
    }

    async fn probe_provider_snapshots(
        &self,
        settings: &Value,
        instance_id: Option<&str>,
        cwd: &Path,
    ) -> Vec<provider_inventory::ProviderProbeResult> {
        #[cfg(test)]
        let pause = self.next_quick_provider_probe_pause.lock().await.take();
        #[cfg(test)]
        if let Some(pause) = pause {
            pause.entered.notify_one();
            pause.release.notified().await;
        }
        provider_inventory::probe(settings, instance_id, cwd, &self.provider_maintenance).await
    }

    async fn probe_full_provider_snapshots(
        &self,
        settings: &Value,
        instance_id: Option<&str>,
        cwd: &Path,
    ) -> Vec<provider_inventory::ProviderProbeResult> {
        #[cfg(test)]
        let pause = self.next_full_provider_probe_pause.lock().await.take();
        #[cfg(test)]
        if let Some(pause) = pause {
            pause.entered.notify_one();
            pause.release.notified().await;
        }
        provider_inventory::probe_full(settings, instance_id, cwd, &self.provider_maintenance).await
    }

    #[cfg(test)]
    async fn pause_full_provider_refresh_handoff(&self) {
        if let Some(pause) = self
            .next_full_provider_refresh_handoff_pause
            .lock()
            .await
            .take()
        {
            pause.entered.notify_one();
            pause.release.notified().await;
        }
    }

    async fn publish_provider_snapshots_if_current(
        &self,
        refreshed: Vec<provider_inventory::ProviderProbeResult>,
        partial: bool,
        generation: u64,
        expected_settings: &Value,
        probe_sequence: u64,
    ) -> Option<Vec<Value>> {
        let _update_guard = self.settings_update_lock.lock().await;
        let settings_are_current = self.settings.read().await.eq(expected_settings);
        if self.settings_generation.load(Ordering::Acquire) != generation
            || !settings_are_current
            || probe_sequence
                <= self
                    .latest_published_provider_probe_sequence
                    .load(Ordering::Acquire)
        {
            return None;
        }
        let providers = self.merge_provider_snapshots(refreshed, partial).await;
        self.latest_published_provider_probe_sequence
            .store(probe_sequence, Ordering::Release);
        self.publish_provider_snapshots(&providers);
        Some(providers)
    }

    async fn merge_provider_snapshots(
        &self,
        refreshed: Vec<provider_inventory::ProviderProbeResult>,
        partial: bool,
    ) -> Vec<Value> {
        let mut current = self.providers.write().await;
        if partial {
            for result in refreshed {
                let Some(id) = result
                    .snapshot
                    .get("instanceId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    continue;
                };
                let position = current.iter().position(|row| {
                    row.get("instanceId").and_then(Value::as_str) == Some(id.as_str())
                });
                let merged = merge_provider_snapshot(position.map(|index| &current[index]), result);
                if let Some(position) = position {
                    current[position] = merged;
                } else {
                    current.push(merged);
                }
            }
        } else {
            let previous = current.clone();
            *current = refreshed
                .into_iter()
                .map(|result| {
                    let id = result.snapshot.get("instanceId").and_then(Value::as_str);
                    let previous = previous
                        .iter()
                        .find(|row| row.get("instanceId").and_then(Value::as_str) == id);
                    merge_provider_snapshot(previous, result)
                })
                .collect();
        }
        if !partial {
            self.provider_maintenance.prune_update_states(
                current.iter().filter_map(provider_snapshot_identity),
            );
        }
        for provider in current.iter_mut() {
            self.provider_maintenance.overlay_update_state(provider);
        }
        current.clone()
    }

    fn publish_provider_snapshots(&self, providers: &[Value]) {
        self.publish(json!({
            "version": 1,
            "type": "providerStatuses",
            "payload": { "providers": providers },
        }));
    }

    fn spawn_full_provider_refresh(&self, generation: u64, settings: Value, cwd: PathBuf) {
        let _ = self.start_full_provider_refresh(generation, settings, cwd, None);
    }

    fn start_full_provider_refresh(
        &self,
        mut generation: u64,
        mut settings: Value,
        cwd: PathBuf,
        cancellation: Option<CancellationToken>,
    ) -> Option<tokio::task::JoinHandle<()>> {
        if self
            .full_provider_refresh_running
            .swap(true, Ordering::AcqRel)
        {
            return None;
        }
        let control = self.clone();
        Some(tokio::spawn(async move {
            let mut owns_refresh = true;
            'refresh: loop {
                loop {
                    let probe_sequence = control.begin_provider_probe();
                    let providers = if let Some(cancellation) = cancellation.as_ref() {
                        tokio::select! {
                            () = cancellation.cancelled() => break 'refresh,
                            providers = control.probe_full_provider_snapshots(&settings, None, &cwd) => providers,
                        }
                    } else {
                        control
                            .probe_full_provider_snapshots(&settings, None, &cwd)
                            .await
                    };
                    if control
                        .publish_provider_snapshots_if_current(
                            providers,
                            false,
                            generation,
                            &settings,
                            probe_sequence,
                        )
                        .await
                        .is_some()
                    {
                        #[cfg(test)]
                        control
                            .latest_full_provider_refresh_generation
                            .store(generation, Ordering::Release);
                        break;
                    }
                    (generation, settings) = control.settings_snapshot().await;
                }
                control
                    .full_provider_refresh_running
                    .store(false, Ordering::Release);
                owns_refresh = false;
                let (latest_generation, latest_settings) = control.settings_snapshot().await;
                #[cfg(test)]
                control.pause_full_provider_refresh_handoff().await;
                if latest_generation == generation && latest_settings == settings {
                    break;
                }
                if control
                    .full_provider_refresh_running
                    .swap(true, Ordering::AcqRel)
                {
                    break;
                }
                owns_refresh = true;
                (generation, settings) = (latest_generation, latest_settings);
            }
            if owns_refresh {
                control
                    .full_provider_refresh_running
                    .store(false, Ordering::Release);
            }
        }))
    }

    async fn update_keybinding(&self, method: &str, payload: Value) -> Result<Value, Value> {
        keybindings::validate(&payload, method == "server.upsertKeybinding")
            .map_err(|detail| keybindings_error(&self.keybindings_path, &detail))?;
        let mut rules = self.keybinding_rules.write().await;
        if method == "server.removeKeybinding" {
            rules.retain(|rule| !keybindings::same_rule(rule, &payload));
        } else {
            let target = payload.get("replace").unwrap_or(&payload);
            rules.retain(|rule| !keybindings::same_rule(rule, target));
            let mut rule = payload;
            rule.as_object_mut()
                .expect("validated object")
                .remove("replace");
            rules.push(rule);
            if rules.len() > MAX_KEYBINDINGS {
                let excess = rules.len() - MAX_KEYBINDINGS;
                rules.drain(..excess);
            }
        }
        write_json_atomically(&self.keybindings_path, &*rules)
            .await
            .map_err(|error| keybindings_error(&self.keybindings_path, &error.to_string()))?;
        self.keybinding_issues.write().await.clear();
        let result = json!({ "keybindings": keybindings::resolve(&rules), "issues": [] });
        self.publish(json!({
            "version": 1,
            "type": "keybindingsUpdated",
            "payload": result.clone(),
        }));
        Ok(result)
    }

    fn publish(&self, event: Value) {
        let _ = self.config_events.send(event);
    }

    fn trace_diagnostics(&self) -> Value {
        self.trace_diagnostics.read()
    }
}

impl ProductionServerControl for NativeServerControl {
    fn call(
        &self,
        method: &'static str,
        payload: Value,
        cancellation: CancellationToken,
    ) -> JsonFuture {
        let control = self.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(json!({ "_tag": "RequestCancelled", "method": method }));
            }
            match method {
                "server.getConfig" => match &control.settings_load_error {
                    Some(error) => Err(error.clone()),
                    None => Ok(control.config_snapshot().await),
                },
                "server.getSettings" => match &control.settings_load_error {
                    Some(error) => Err(error.clone()),
                    None => Ok(control.settings.read().await.clone()),
                },
                "server.updateSettings" => control.update_settings(payload).await,
                "server.refreshProviders" => Ok(control.refresh_providers(&payload).await),
                "server.updateProvider" => control.update_provider(&payload, cancellation).await,
                "server.upsertKeybinding" | "server.removeKeybinding" => {
                    control.update_keybinding(method, payload).await
                }
                "server.getTraceDiagnostics" => Ok(control.trace_diagnostics()),
                _ => Err(json!({
                    "_tag": "InvalidRequest",
                    "method": method,
                    "message": "Unsupported native server-control request.",
                })),
            }
        })
    }

    fn subscribe(&self, method: &'static str, cancellation: CancellationToken) -> JsonStream {
        let (sender, receiver) = mpsc::channel(8);
        let control = self.clone();
        tokio::spawn(async move {
            match method {
                "subscribeServerConfig" => {
                    if let Some(error) = &control.settings_load_error {
                        let _ = sender.send(Err(error.clone())).await;
                        return;
                    }
                    let (generation, settings) = control.settings_snapshot().await;
                    let cwd =
                        std::env::current_dir().unwrap_or_else(|_| control.config.base_dir.clone());
                    control.spawn_full_provider_refresh(generation, settings, cwd);
                    let mut updates = control.config_events.subscribe();
                    if send_event(
                        &sender,
                        json!({
                            "version": 1,
                            "type": "snapshot",
                            "config": control.config_snapshot().await,
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    loop {
                        tokio::select! {
                            () = cancellation.cancelled() => return,
                            event = updates.recv() => match event {
                                Ok(event) => {
                                    if send_event(&sender, event).await.is_err() {
                                        return;
                                    }
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => {}
                                Err(broadcast::error::RecvError::Closed) => return,
                            }
                        }
                    }
                }
                "subscribeDiscoveredLocalServers" => loop {
                    let servers = local_servers::discover(&cancellation).await;
                    if cancellation.is_cancelled()
                        || send_event(
                            &sender,
                            json!({ "servers": servers, "scannedAt": now_iso() }),
                        )
                        .await
                        .is_err()
                    {
                        return;
                    }
                    tokio::select! {
                        () = cancellation.cancelled() => return,
                        () = tokio::time::sleep(local_servers::SCAN_INTERVAL) => {}
                    }
                },
                "subscribeServerLifecycle" => {
                    let cwd = current_directory(&control.config);
                    let project_name = Path::new(&cwd)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .filter(|name| !name.is_empty())
                        .unwrap_or("BiBCode");
                    let activity_protocol_registered = control
                        .activity_protocol_registered
                        .load(Ordering::Acquire);
                    let environment = environment_descriptor(
                        &control.config,
                        activity_protocol_registered,
                    );
                    if send_event(
                        &sender,
                        json!({
                            "version": 1,
                            "sequence": 1,
                            "type": "welcome",
                            "payload": {
                                "environment": environment,
                                "cwd": cwd,
                                "projectName": project_name,
                            },
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    if send_event(
                        &sender,
                        json!({
                            "version": 1,
                            "sequence": 2,
                            "type": "ready",
                            "payload": {
                                "at": now_iso(),
                                "environment": environment_descriptor(
                                    &control.config,
                                    activity_protocol_registered,
                                ),
                            },
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    cancellation.cancelled().await;
                }
                _ => {}
            }
        });
        receiver
    }
}

async fn send_event(
    sender: &mpsc::Sender<Result<Vec<Value>, Value>>,
    event: Value,
) -> Result<(), ()> {
    sender.send(Ok(vec![event])).await.map_err(|_| ())
}

fn validate_settings_document(settings: &Value) -> Result<(), String> {
    let object = settings
        .as_object()
        .ok_or_else(|| "settings document must be an object".to_owned())?;
    let normalized = normalize_legacy_settings_for_validation(settings);
    serde_json::from_value::<ProviderSettingsState>(normalized)
        .map_err(|error| format!("invalid known provider settings shape: {error}"))?;

    validate_optional_bool(object, "enableAssistantStreaming")?;
    validate_optional_bool(object, "enableProviderUpdateChecks")?;
    validate_optional_bool(object, "enableAgentActivity")?;
    validate_optional_bool(object, "newWorktreesStartFromOrigin")?;
    validate_optional_string(object, "worktreeBaseDirectory")?;
    validate_optional_string(object, "addProjectBaseDirectory")?;
    validate_optional_duration_millis(object, "automaticGitFetchInterval")?;
    if let Some(mode) = object.get("defaultThreadEnvMode") {
        match mode.as_str() {
            Some("local" | "worktree") => {}
            _ => {
                return Err(
                    "defaultThreadEnvMode must be either \"local\" or \"worktree\"".to_owned(),
                );
            }
        }
    }
    if let Some(selection) = object.get("textGenerationModelSelection") {
        validate_model_selection(selection, "textGenerationModelSelection")?;
    }
    if let Some(default_agent) = object.get("defaultAgent") {
        validate_default_agent(default_agent)?;
    }
    if let Some(providers) = object.get("providers") {
        validate_legacy_provider_settings(providers)?;
    }
    if let Some(instances) = object.get("providerInstances") {
        validate_provider_instances(instances)?;
    }
    if let Some(defaults) = object.get("providerSessionDefaults") {
        validate_provider_session_defaults(defaults)?;
    }
    if let Some(terminal) = object.get("terminal") {
        let terminal = terminal
            .as_object()
            .ok_or_else(|| "terminal must be an object".to_owned())?;
        validate_optional_bool(terminal, "webglEnabled")?;
    }
    Ok(())
}

fn automatic_git_fetch_interval(settings: &Value) -> Duration {
    let Some(milliseconds) = settings
        .get("automaticGitFetchInterval")
        .and_then(Value::as_f64)
    else {
        return Duration::from_secs(30);
    };
    Duration::try_from_secs_f64(milliseconds / 1_000.0).unwrap_or(Duration::MAX)
}

fn normalize_legacy_settings_for_validation(settings: &Value) -> Value {
    let mut normalized = settings.clone();
    if let Some(object) = normalized.as_object_mut()
        && object.contains_key("automaticGitFetchInterval")
    {
        // The public contract accepts every nonnegative JSON number, including
        // fractional milliseconds. ProviderSettingsState predates that
        // contract and uses u64, so validate the real shape separately and
        // neutralize only the surrogate decode.
        object.insert("automaticGitFetchInterval".to_owned(), json!(0));
    }
    if let Some(instances) = normalized
        .get_mut("providerInstances")
        .and_then(Value::as_object_mut)
    {
        for instance in instances.values_mut().filter_map(Value::as_object_mut) {
            instance.entry("config").or_insert(Value::Null);
        }
    }
    if let Some(defaults) = normalized
        .get_mut("providerSessionDefaults")
        .and_then(Value::as_object_mut)
    {
        for options in defaults.values_mut().filter_map(|value| {
            value
                .as_object_mut()
                .and_then(|value| value.get_mut("options"))
        }) {
            let Some(legacy) = options.as_object() else {
                continue;
            };
            *options = Value::Array(
                legacy
                    .iter()
                    .filter_map(|(id, value)| match value {
                        Value::String(value)
                            if !id.trim().is_empty() && !value.trim().is_empty() =>
                        {
                            Some(json!({ "id": id.trim(), "value": value.trim() }))
                        }
                        Value::Bool(value) if !id.trim().is_empty() => {
                            Some(json!({ "id": id.trim(), "value": value }))
                        }
                        _ => None,
                    })
                    .collect(),
            );
        }
    }
    normalized
}

fn validate_optional_bool(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), String> {
    if object.get(field).is_some_and(|value| !value.is_boolean()) {
        return Err(format!("{field} must be a boolean"));
    }
    Ok(())
}

fn validate_optional_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), String> {
    if object.get(field).is_some_and(|value| !value.is_string()) {
        return Err(format!("{field} must be a string"));
    }
    Ok(())
}

fn validate_optional_duration_millis(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), String> {
    if let Some(value) = object.get(field)
        && value
            .as_f64()
            .is_none_or(|milliseconds| !milliseconds.is_finite() || milliseconds < 0.0)
    {
        return Err(format!("{field} must be a nonnegative number"));
    }
    Ok(())
}

fn validate_optional_string_array(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), String> {
    if let Some(value) = object.get(field)
        && !value
            .as_array()
            .is_some_and(|values| values.iter().all(Value::is_string))
    {
        return Err(format!("{field} must be an array of strings"));
    }
    Ok(())
}

fn validate_non_empty_string(value: &Value, field: &str) -> Result<(), String> {
    if value.as_str().is_none_or(|value| value.trim().is_empty()) {
        return Err(format!("{field} must be a non-empty string"));
    }
    Ok(())
}

fn validate_slug(value: &str, field: &str) -> Result<(), String> {
    let value = value.trim();
    let mut characters = value.chars();
    if value.len() > 64
        || characters
            .next()
            .is_none_or(|character| !character.is_ascii_alphabetic())
        || characters.any(|character| {
            !character.is_ascii_alphanumeric() && character != '-' && character != '_'
        })
    {
        return Err(format!("{field} must be a valid provider slug"));
    }
    Ok(())
}

fn validate_model_selection(selection: &Value, field: &str) -> Result<(), String> {
    let selection = selection
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    validate_non_empty_string(
        selection
            .get("model")
            .ok_or_else(|| format!("{field}.model is required"))?,
        &format!("{field}.model"),
    )?;
    let instance_id = selection
        .get("instanceId")
        .or_else(|| selection.get("provider"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.instanceId is required"))?;
    validate_slug(instance_id, &format!("{field}.instanceId"))?;
    if let Some(options) = selection.get("options") {
        validate_provider_options(options, &format!("{field}.options"))?;
    }
    Ok(())
}

fn validate_default_agent(value: &Value) -> Result<(), String> {
    let selection = value
        .as_object()
        .ok_or_else(|| "defaultAgent must be an object".to_owned())?;
    match selection.get("kind").and_then(Value::as_str) {
        Some("chat" | "terminal") => {}
        _ => return Err("defaultAgent.kind must be either \"chat\" or \"terminal\"".to_owned()),
    }
    validate_slug(
        selection
            .get("instanceId")
            .and_then(Value::as_str)
            .ok_or_else(|| "defaultAgent.instanceId is required".to_owned())?,
        "defaultAgent.instanceId",
    )
}

fn validate_legacy_provider_settings(providers: &Value) -> Result<(), String> {
    let providers = providers
        .as_object()
        .ok_or_else(|| "providers must be an object".to_owned())?;
    for (driver, string_fields) in [
        ("codex", &["binaryPath", "homePath", "shadowHomePath"][..]),
        ("claudeAgent", &["binaryPath", "homePath", "launchArgs"][..]),
        ("cursor", &["binaryPath", "apiEndpoint"][..]),
        ("grok", &["binaryPath"][..]),
        (
            "opencode",
            &["binaryPath", "serverUrl", "serverPassword"][..],
        ),
    ] {
        let Some(settings) = providers.get(driver) else {
            continue;
        };
        let settings = settings
            .as_object()
            .ok_or_else(|| format!("providers.{driver} must be an object"))?;
        validate_optional_bool(settings, "enabled")?;
        for field in string_fields {
            validate_optional_string(settings, field)?;
        }
        validate_optional_string_array(settings, "customModels")?;
    }
    Ok(())
}

fn validate_provider_instances(instances: &Value) -> Result<(), String> {
    let instances = instances
        .as_object()
        .ok_or_else(|| "providerInstances must be an object".to_owned())?;
    for (instance_id, instance) in instances {
        validate_slug(instance_id, "providerInstances key")?;
        let instance = instance
            .as_object()
            .ok_or_else(|| format!("providerInstances.{instance_id} must be an object"))?;
        let driver = instance
            .get("driver")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("providerInstances.{instance_id}.driver is required"))?;
        validate_slug(driver, &format!("providerInstances.{instance_id}.driver"))?;
        validate_optional_bool(instance, "enabled")?;
        for field in ["displayName", "accentColor"] {
            if let Some(value) = instance.get(field) {
                validate_non_empty_string(
                    value,
                    &format!("providerInstances.{instance_id}.{field}"),
                )?;
            }
        }
        if let Some(environment) = instance.get("environment") {
            let environment = environment.as_array().ok_or_else(|| {
                format!("providerInstances.{instance_id}.environment must be an array")
            })?;
            for (index, variable) in environment.iter().enumerate() {
                let variable = variable.as_object().ok_or_else(|| {
                    format!(
                        "providerInstances.{instance_id}.environment[{index}] must be an object"
                    )
                })?;
                let name = variable
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        format!(
                            "providerInstances.{instance_id}.environment[{index}].name is required"
                        )
                    })?;
                let mut characters = name.trim().chars();
                if name.trim().len() > 128
                    || characters.next().is_none_or(|character| {
                        !character.is_ascii_alphabetic() && character != '_'
                    })
                    || characters
                        .any(|character| !character.is_ascii_alphanumeric() && character != '_')
                {
                    return Err(format!(
                        "providerInstances.{instance_id}.environment[{index}].name is invalid"
                    ));
                }
                validate_optional_string(variable, "value")?;
                validate_optional_bool(variable, "sensitive")?;
                validate_optional_bool(variable, "valueRedacted")?;
            }
        }
    }
    Ok(())
}

fn validate_provider_session_defaults(defaults: &Value) -> Result<(), String> {
    let defaults = defaults
        .as_object()
        .ok_or_else(|| "providerSessionDefaults must be an object".to_owned())?;
    for (driver, value) in defaults {
        validate_slug(driver, "providerSessionDefaults key")?;
        let value = value
            .as_object()
            .ok_or_else(|| format!("providerSessionDefaults.{driver} must be an object"))?;
        validate_non_empty_string(
            value
                .get("model")
                .ok_or_else(|| format!("providerSessionDefaults.{driver}.model is required"))?,
            &format!("providerSessionDefaults.{driver}.model"),
        )?;
        if let Some(options) = value.get("options") {
            validate_provider_options(
                options,
                &format!("providerSessionDefaults.{driver}.options"),
            )?;
        }
    }
    Ok(())
}

fn validate_provider_options(options: &Value, field: &str) -> Result<(), String> {
    if options.is_object() {
        return Ok(());
    }
    let options = options
        .as_array()
        .ok_or_else(|| format!("{field} must be an array or legacy object"))?;
    for (index, option) in options.iter().enumerate() {
        let option = option
            .as_object()
            .ok_or_else(|| format!("{field}[{index}] must be an object"))?;
        validate_non_empty_string(
            option
                .get("id")
                .ok_or_else(|| format!("{field}[{index}].id is required"))?,
            &format!("{field}[{index}].id"),
        )?;
        let value = option
            .get("value")
            .ok_or_else(|| format!("{field}[{index}].value is required"))?;
        match value {
            Value::String(value) if !value.trim().is_empty() => {}
            Value::Bool(_) => {}
            _ => {
                return Err(format!(
                    "{field}[{index}].value must be a non-empty string or boolean"
                ));
            }
        }
    }
    Ok(())
}

fn apply_settings_defaults(settings: &mut Value) {
    if !settings.is_object() {
        *settings = json!({});
    }
    settings
        .as_object_mut()
        .expect("settings object")
        .remove("observability");
    merge_missing(
        settings,
        &json!({
            "enableAssistantStreaming": false,
            "enableProviderUpdateChecks": true,
            "enableAgentActivity": true,
            "automaticGitFetchInterval": 30_000,
            "defaultThreadEnvMode": "local",
            "newWorktreesStartFromOrigin": false,
            "worktreeBaseDirectory": "",
            "addProjectBaseDirectory": "",
            "textGenerationModelSelection": {
                "instanceId": "codex",
                "model": "gpt-5.4-mini",
            },
            "providers": {
                "codex": { "enabled": true, "binaryPath": "codex", "homePath": "", "shadowHomePath": "", "customModels": [] },
                "claudeAgent": { "enabled": true, "binaryPath": "claude", "homePath": "", "customModels": [], "launchArgs": "" },
                "cursor": { "enabled": false, "binaryPath": "cursor-agent", "apiEndpoint": "", "customModels": [] },
                "grok": { "enabled": false, "binaryPath": "grok", "customModels": [] },
                "opencode": { "enabled": true, "binaryPath": "opencode", "serverUrl": "", "serverPassword": "", "customModels": [] },
            },
            "providerInstances": {},
            "providerSessionDefaults": {},
            "terminal": { "webglEnabled": true },
        }),
    );
    settings
        .as_object_mut()
        .expect("settings object")
        .entry("defaultAgent")
        .or_insert_with(|| json!({ "kind": "chat", "instanceId": "codex" }));
}

fn merge_missing(target: &mut Value, defaults: &Value) {
    if let (Some(target), Some(defaults)) = (target.as_object_mut(), defaults.as_object()) {
        for (key, default) in defaults {
            match target.get_mut(key) {
                Some(value) if value.is_object() && default.is_object() => {
                    merge_missing(value, default)
                }
                Some(_) => {}
                None => {
                    target.insert(key.clone(), default.clone());
                }
            }
        }
    }
}

fn apply_settings_patch(target: &mut Value, patch: Value) {
    let Some(patch) = patch.as_object() else {
        return;
    };
    let target = target.as_object_mut().expect("settings object");
    for (key, value) in patch {
        if key == "providerInstances"
            || key == "providerSessionDefaults"
            || key == "automaticGitFetchInterval"
            || key == "defaultAgent"
        {
            target.insert(key.clone(), value.clone());
            continue;
        }
        if key == "textGenerationModelSelection"
            && value.as_object().is_some_and(|selection| {
                selection.contains_key("instanceId") || selection.contains_key("model")
            })
        {
            target.insert(key.clone(), value.clone());
            continue;
        }
        match target.get_mut(key) {
            Some(existing) if existing.is_object() && value.is_object() => {
                merge_patch(existing, value.clone());
            }
            _ => {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

fn merge_patch(target: &mut Value, patch: Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                match target.get_mut(&key) {
                    Some(existing) if existing.is_object() && value.is_object() => {
                        merge_patch(existing, value);
                    }
                    _ => {
                        target.insert(key, value);
                    }
                }
            }
        }
        (target, patch) => *target = patch,
    }
}

async fn persist_sensitive_environment(root: &Path, settings: &mut Value) -> Result<(), String> {
    let Some(instances) = settings
        .get_mut("providerInstances")
        .and_then(Value::as_object_mut)
    else {
        return Ok(());
    };
    for (instance_id, instance) in instances {
        let Some(environment) = instance
            .get_mut("environment")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for variable in environment {
            if variable.get("sensitive").and_then(Value::as_bool) != Some(true) {
                variable
                    .as_object_mut()
                    .map(|object| object.remove("valueRedacted"));
                continue;
            }
            let name = variable
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let value = variable
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !value.is_empty() {
                let path = secret_path(root, instance_id, name);
                write_bytes_atomically(path, value.as_bytes())
                    .await
                    .map_err(|error| error.to_string())?;
            }
            let variable = variable
                .as_object_mut()
                .expect("environment variable object");
            variable.insert("value".into(), json!(""));
            variable.insert("valueRedacted".into(), json!(true));
        }
    }
    Ok(())
}

fn redact_sensitive_environment(settings: &mut Value) {
    let Some(instances) = settings
        .get_mut("providerInstances")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    for instance in instances.values_mut() {
        let Some(environment) = instance
            .get_mut("environment")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for variable in environment {
            if variable.get("sensitive").and_then(Value::as_bool) == Some(true) {
                let object = variable
                    .as_object_mut()
                    .expect("environment variable object");
                object.insert("value".into(), json!(""));
                object.insert("valueRedacted".into(), json!(true));
            } else if let Some(object) = variable.as_object_mut() {
                object.remove("valueRedacted");
            }
        }
    }
}

fn secret_path(root: &Path, instance_id: &str, name: &str) -> PathBuf {
    root.join("secrets").join(format!(
        "provider-env-{}-{}",
        URL_SAFE_NO_PAD.encode(instance_id),
        URL_SAFE_NO_PAD.encode(name),
    ))
}

fn observability_snapshot(state_directory: &Path) -> Value {
    json!({
        "logsDirectoryPath": state_directory.join("logs").to_string_lossy(),
        "localTracingEnabled": true,
        "otlpTracesEnabled": false,
        "otlpMetricsEnabled": false,
    })
}

fn settings_error(path: &Path, operation: &str, cause: &str) -> Value {
    json!({
        "_tag": "ServerSettingsError",
        "settingsPath": path.to_string_lossy(),
        "operation": operation,
        "cause": cause,
    })
}

fn keybindings_error(path: &Path, detail: &str) -> Value {
    json!({
        "_tag": "KeybindingsConfigParseError",
        "configPath": path.to_string_lossy(),
        "detail": detail,
    })
}

fn current_directory(config: &ServerConfig) -> String {
    std::env::current_dir()
        .unwrap_or_else(|_| config.base_dir.clone())
        .to_string_lossy()
        .into_owned()
}

fn environment_descriptor(config: &ServerConfig, activity_protocol_registered: bool) -> Value {
    json!({
        "environmentId": config.environment_id,
        "label": config.environment_label,
        "platform": { "os": platform_os(), "arch": platform_arch() },
        "serverVersion": config.server_version,
        "capabilities": {
            "repositoryIdentity": true,
            "activityProtocolVersion": activity_protocol_registered.then_some(1),
        },
    })
}

fn available_editors() -> Vec<&'static str> {
    [
        ("code", "vscode"),
        ("cursor", "cursor"),
        ("idea", "intellij"),
        ("zed", "zed"),
    ]
    .into_iter()
    .filter_map(|(binary, id)| command_exists(binary).then_some(id))
    .collect()
}

fn command_exists(command: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|directory| {
            let direct = directory.join(command);
            direct.is_file()
                || (cfg!(windows)
                    && ["exe", "cmd", "bat"]
                        .into_iter()
                        .any(|extension| direct.with_extension(extension).is_file()))
        })
    })
}

const fn platform_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

const fn platform_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "other"
    }
}

pub(crate) fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Mutex as StdMutex,
            atomic::{AtomicBool, Ordering as AtomicOrdering},
        },
        time::Duration,
    };

    use crate::{
        activity::AgentActivityController,
        diagnostics::TraceDiagnosticsStore,
        production::{
            agent_activity::{
                AgentActivityCoordinator, AgentActivitySettingsHandler,
                AgentActivityTransitionReport, AgentActivityTransitionRuntime,
                BoxAgentActivityFuture,
            },
            server_terminal::ProductionServerControl,
        },
        provider_terminal::TerminalAgentActivityTransition,
    };

    use super::*;

    #[test]
    fn post_update_verification_distinguishes_success_and_unchanged() {
        let current = json!({
            "instanceId": "codex",
            "versionAdvisory": { "status": "current" }
        });
        let behind = json!({
            "instanceId": "codex",
            "versionAdvisory": { "status": "behind_latest" }
        });
        let unknown = json!({
            "instanceId": "codex",
            "versionAdvisory": { "status": "unknown" }
        });
        assert_eq!(post_update_status(&[current], "codex"), "succeeded");
        assert_eq!(post_update_status(&[behind], "codex"), "unchanged");
        assert_eq!(post_update_status(&[unknown], "codex"), "unchanged");
        assert_eq!(post_update_status(&[], "codex"), "unchanged");
    }

    async fn write_cursor_update_fixture(directory: &Path) -> PathBuf {
        #[cfg(windows)]
        let (name, contents) = (
            "cursor.cmd",
            "@echo off\r\nif \"%1\"==\"about\" (echo {\"cliVersion\":\"9.8.7\"}& exit /b 0)\r\necho cursor updated\r\n",
        );
        #[cfg(not(windows))]
        let (name, contents) = (
            "cursor",
            "#!/bin/sh\nif [ \"$1\" = \"about\" ]; then\n  echo '{\"cliVersion\":\"9.8.7\"}'\nelse\n  echo 'cursor updated'\nfi\n",
        );
        let path = directory.join(name);
        tokio::fs::write(&path, contents)
            .await
            .expect("write cursor fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mut permissions = tokio::fs::metadata(&path)
                .await
                .expect("cursor fixture metadata")
                .permissions();
            permissions.set_mode(0o755);
            tokio::fs::set_permissions(&path, permissions)
                .await
                .expect("make cursor fixture executable");
        }
        path
    }

    async fn write_slow_cursor_update_fixture(directory: &Path) -> PathBuf {
        #[cfg(windows)]
        let (name, contents) = (
            "slow-cursor.cmd",
            "@echo off\r\nif \"%1\"==\"about\" (echo {\"cliVersion\":\"9.8.7\"}& exit /b 0)\r\npowershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 2\"\r\n",
        );
        #[cfg(not(windows))]
        let (name, contents) = (
            "slow-cursor",
            "#!/bin/sh\nif [ \"$1\" = \"about\" ]; then\n  echo '{\"cliVersion\":\"9.8.7\"}'\nelse\n  sleep 2\nfi\n",
        );
        let path = directory.join(name);
        tokio::fs::write(&path, contents)
            .await
            .expect("write slow cursor fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mut permissions = tokio::fs::metadata(&path)
                .await
                .expect("slow cursor fixture metadata")
                .permissions();
            permissions.set_mode(0o755);
            tokio::fs::set_permissions(&path, permissions)
                .await
                .expect("make slow cursor fixture executable");
        }
        path
    }

    async fn control_with_cursor_update_fixture(executable: PathBuf) -> NativeServerControl {
        let directory = executable.parent().expect("fixture directory");
        let settings_path = ServerConfig::new(directory).state_dir().join("settings.json");
        tokio::fs::create_dir_all(settings_path.parent().expect("settings directory"))
            .await
            .expect("create settings directory");
        tokio::fs::write(
            &settings_path,
            serde_json::to_vec(&json!({
                "enableProviderUpdateChecks": false,
                "providerInstances": {
                    "cursor-work": {
                        "driver": "cursor",
                        "enabled": true,
                        "config": { "binaryPath": executable }
                    }
                }
            }))
            .expect("settings JSON"),
        )
        .await
        .expect("write settings");
        NativeServerControl::new(ServerConfig::new(directory), json!({})).await
    }

    async fn scheduler_control(temp: &tempfile::TempDir) -> NativeServerControl {
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        let missing_binary = temp
            .path()
            .join("missing-provider-executable")
            .to_string_lossy()
            .into_owned();
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(
            settings_path,
            serde_json::to_vec(&json!({
                "enableProviderUpdateChecks": false,
                "providerInstances": {
                    "codex": { "driver": "codex", "enabled": true, "config": { "binaryPath": missing_binary } },
                    "claude": { "driver": "claudeAgent", "enabled": true, "config": { "binaryPath": missing_binary } },
                    "cursor": { "driver": "cursor", "enabled": true, "config": { "binaryPath": missing_binary } },
                    "grok": { "driver": "grok", "enabled": true, "config": { "binaryPath": missing_binary } },
                    "opencode": { "driver": "opencode", "enabled": true, "config": { "binaryPath": missing_binary } }
                }
            }))
            .expect("settings JSON"),
        )
        .await
        .expect("write settings");
        NativeServerControl::new(config, json!({"policy":"test"})).await
    }

    async fn wait_for_probe_after(control: &NativeServerControl, previous: u64) -> u64 {
        for _ in 0..100 {
            let current = control.next_provider_probe_sequence.load(Ordering::Acquire);
            if current > previous {
                return current;
            }
            tokio::task::yield_now().await;
        }
        panic!("provider check did not start");
    }

    async fn wait_for_full_refresh_idle(control: &NativeServerControl) {
        for _ in 0..100 {
            if !control.full_provider_refresh_running.load(Ordering::Acquire) {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("provider check did not finish");
    }

    async fn wait_for_scheduler_request_after(control: &NativeServerControl, previous: u64) {
        for _ in 0..100 {
            if control
                .provider_update_refresh_attempts
                .load(Ordering::Acquire)
                > previous
            {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("provider update check did not request a refresh");
    }

    #[tokio::test(start_paused = true)]
    async fn provider_update_checks_run_immediately_and_every_hour() {
        let temp = tempfile::tempdir().expect("state directory");
        let control = scheduler_control(&temp).await;
        let before = control.next_provider_probe_sequence.load(Ordering::Acquire);
        let checks = control.start_provider_update_checks();

        let after_startup = wait_for_probe_after(&control, before).await;
        wait_for_full_refresh_idle(&control).await;

        tokio::time::advance(Duration::from_secs(60 * 60 - 1)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            control.next_provider_probe_sequence.load(Ordering::Acquire),
            after_startup
        );

        tokio::time::advance(Duration::from_secs(1)).await;
        wait_for_probe_after(&control, after_startup).await;
        checks.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn provider_update_check_shutdown_prevents_future_ticks() {
        let temp = tempfile::tempdir().expect("state directory");
        let control = scheduler_control(&temp).await;
        let checks = control.start_provider_update_checks();
        let before = control.next_provider_probe_sequence.load(Ordering::Acquire);
        wait_for_probe_after(&control, before).await;
        checks.shutdown().await;
        let stopped_at = control.next_provider_probe_sequence.load(Ordering::Acquire);
        tokio::time::advance(Duration::from_secs(2 * 60 * 60)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            control.next_provider_probe_sequence.load(Ordering::Acquire),
            stopped_at
        );
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_provider_update_checks_prevents_future_ticks() {
        let temp = tempfile::tempdir().expect("state directory");
        let control = scheduler_control(&temp).await;
        let checks = control.start_provider_update_checks();
        let before = control.next_provider_probe_sequence.load(Ordering::Acquire);
        wait_for_probe_after(&control, before).await;
        wait_for_full_refresh_idle(&control).await;
        drop(checks);
        let stopped_at = control.next_provider_probe_sequence.load(Ordering::Acquire);

        tokio::time::advance(Duration::from_secs(2 * 60 * 60)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            control.next_provider_probe_sequence.load(Ordering::Acquire),
            stopped_at
        );
    }

    #[tokio::test(start_paused = true)]
    async fn provider_update_check_shutdown_cancels_a_paused_full_refresh() {
        let temp = tempfile::tempdir().expect("state directory");
        let control = scheduler_control(&temp).await;
        let pause = control.install_next_full_provider_probe_pause().await;
        let checks = control.start_provider_update_checks();
        pause.wait_until_entered().await;

        checks.shutdown().await;

        assert!(
            !control.full_provider_refresh_running.load(Ordering::Acquire),
            "scheduled full refresh must finish before shutdown returns"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn provider_update_checks_coalesce_while_a_full_refresh_is_running() {
        let temp = tempfile::tempdir().expect("state directory");
        let control = scheduler_control(&temp).await;
        let pause = control.install_next_full_provider_probe_pause().await;
        let checks = control.start_provider_update_checks();
        pause.wait_until_entered().await;
        let running_sequence = control.next_provider_probe_sequence.load(Ordering::Acquire);
        let requested = control
            .provider_update_refresh_attempts
            .load(Ordering::Acquire);

        tokio::time::advance(Duration::from_secs(60 * 60)).await;
        wait_for_scheduler_request_after(&control, requested).await;
        assert_eq!(
            control.next_provider_probe_sequence.load(Ordering::Acquire),
            running_sequence,
        );

        pause.release();
        checks.shutdown().await;
    }

    #[tokio::test]
    async fn full_refresh_handoff_covers_settings_changed_after_its_final_snapshot() {
        let temp = tempfile::tempdir().expect("state directory");
        let control = scheduler_control(&temp).await;
        let pause = control
            .install_next_full_provider_refresh_handoff_pause()
            .await;
        let (generation, settings) = control.settings_snapshot().await;
        let cwd = std::env::current_dir().unwrap_or_else(|_| control.config.base_dir.clone());
        control.spawn_full_provider_refresh(generation, settings, cwd);
        pause.wait_until_entered().await;

        control
            .update_settings(json!({
                "patch": { "providers": { "codex": { "enabled": false } } }
            }))
            .await
            .expect("settings update succeeds");
        let expected_generation = control.settings_generation.load(Ordering::Acquire);
        pause.release();
        wait_for_full_refresh_idle(&control).await;

        assert_eq!(
            control
                .latest_full_provider_refresh_generation
                .load(Ordering::Acquire),
            expected_generation,
        );
    }

    #[tokio::test]
    async fn removed_provider_update_state_is_not_retained_or_reused() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let directory = tempfile::tempdir().expect("state directory");
        let executable = write_cursor_update_fixture(directory.path()).await;
        let control = control_with_cursor_update_fixture(executable.clone()).await;
        let pause = control.install_next_full_provider_probe_pause().await;
        let updating = {
            let control = control.clone();
            tokio::spawn(async move {
                control
                    .update_provider(
                        &json!({ "provider": "cursor", "instanceId": "cursor-work" }),
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        pause.wait_until_entered().await;

        control
            .update_settings(json!({
                "patch": {
                    "providerInstances": {
                        "replacement": {
                            "driver": "grok",
                            "enabled": false,
                            "config": {}
                        }
                    }
                }
            }))
            .await
            .expect("settings replace provider");
        assert!(control
            .providers
            .read()
            .await
            .iter()
            .all(|provider| provider["instanceId"] != "cursor-work"));

        let mut removed_snapshot = json!({
            "instanceId": "cursor-work",
            "driver": "cursor",
        });
        control
            .provider_maintenance
            .overlay_update_state(&mut removed_snapshot);
        assert!(removed_snapshot.get("updateState").is_none());

        control
            .update_settings(json!({
                "patch": {
                    "providerInstances": {
                        "cursor-work": {
                            "driver": "cursor",
                            "enabled": true,
                            "config": { "binaryPath": executable }
                        }
                    }
                }
            }))
            .await
            .expect("re-add cursor provider");
        let refreshed = control
            .refresh_providers(&json!({ "instanceId": "cursor-work" }))
            .await;
        let readded = refreshed["providers"]
            .as_array()
            .expect("providers")
            .iter()
            .find(|provider| provider["instanceId"] == "cursor-work")
            .expect("re-added cursor provider");
        assert!(readded.get("updateState").is_none());

        pause.release();
        let result = updating
            .await
            .expect("provider update joins")
            .expect("provider update returns snapshots");
        let readded = result["providers"]
            .as_array()
            .expect("providers")
            .iter()
            .find(|provider| provider["instanceId"] == "cursor-work")
            .expect("re-added cursor provider");
        assert!(readded.get("updateState").is_none());
        let providers = control.providers.read().await;
        let readded = providers
            .iter()
            .find(|provider| provider["instanceId"] == "cursor-work")
            .expect("stored re-added cursor provider");
        assert!(readded.get("updateState").is_none());
    }

    #[tokio::test]
    async fn absent_target_verification_removes_update_state_while_settings_refresh_is_paused(
    ) {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let directory = tempfile::tempdir().expect("state directory");
        let control = control_with_cursor_update_fixture(
            write_slow_cursor_update_fixture(directory.path()).await,
        )
        .await;
        let mut events = control.config_events.subscribe();
        let updating = {
            let control = control.clone();
            tokio::spawn(async move {
                control
                    .update_provider(
                        &json!({ "provider": "cursor", "instanceId": "cursor-work" }),
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = events.recv().await.expect("provider update event");
                if event["type"] == "providerStatuses"
                    && event["payload"]["providers"]
                        .as_array()
                        .is_some_and(|providers| providers.iter().any(|provider| {
                            provider["instanceId"] == "cursor-work"
                                && provider["updateState"]["status"] == "running"
                        }))
                {
                    break;
                }
            }
        })
        .await
        .expect("running state published");

        let quick_pause = control.install_next_quick_provider_probe_pause().await;
        let settings_update = {
            let control = control.clone();
            tokio::spawn(async move {
                control
                    .update_settings(json!({
                        "patch": {
                            "providerInstances": {
                                "replacement": {
                                    "driver": "grok",
                                    "enabled": false,
                                    "config": {}
                                }
                            }
                        }
                    }))
                    .await
            })
        };
        quick_pause.wait_until_entered().await;

        let result = updating
            .await
            .expect("provider update joins")
            .expect("provider update returns snapshots");
        quick_pause.release();
        settings_update
            .await
            .expect("settings update joins")
            .expect("settings update succeeds");
        let provider = result["providers"]
            .as_array()
            .expect("providers")
            .iter()
            .find(|provider| provider["instanceId"] == "cursor-work")
            .expect("cached cursor provider");
        assert!(provider.get("updateState").is_none());
    }

    #[tokio::test]
    async fn cancelled_provider_update_publishes_failed_state() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let directory = tempfile::tempdir().expect("state directory");
        let control = control_with_cursor_update_fixture(
            write_slow_cursor_update_fixture(directory.path()).await,
        )
        .await;
        let mut events = control.config_events.subscribe();
        let cancellation = CancellationToken::new();
        let updating = {
            let control = control.clone();
            let cancellation = cancellation.clone();
            tokio::spawn(async move {
                control
                    .update_provider(
                        &json!({ "provider": "cursor", "instanceId": "cursor-work" }),
                        cancellation,
                    )
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = events.recv().await.expect("provider update event");
                if event["type"] == "providerStatuses"
                    && event["payload"]["providers"]
                        .as_array()
                        .is_some_and(|providers| providers.iter().any(|provider| {
                            provider["instanceId"] == "cursor-work"
                                && provider["updateState"]["status"] == "running"
                        }))
                {
                    break;
                }
            }
        })
        .await
        .expect("running state published");
        cancellation.cancel();

        let result = updating
            .await
            .expect("provider update joins")
            .expect("cancelled update returns snapshots");
        let provider = result["providers"]
            .as_array()
            .expect("providers")
            .iter()
            .find(|provider| provider["instanceId"] == "cursor-work")
            .expect("cursor provider");
        assert_eq!(provider["updateState"]["status"], "failed");
        assert!(provider["updateState"]["finishedAt"].is_string());
    }

    #[derive(Clone)]
    struct TestAgentActivityHandler {
        calls: Arc<StdMutex<Vec<(bool, u64)>>>,
        pause: Option<Arc<Barrier>>,
    }

    impl AgentActivitySettingsHandler for TestAgentActivityHandler {
        fn transition(
            &self,
            enabled: bool,
            settings_generation: u64,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = AgentActivityTransitionReport> + Send + '_>,
        > {
            Box::pin(async move {
                self.calls
                    .lock()
                    .expect("handler calls")
                    .push((enabled, settings_generation));
                if let Some(pause) = &self.pause {
                    pause.wait().await;
                    pause.wait().await;
                }
                AgentActivityTransitionReport {
                    enabled,
                    settings_generation,
                    ..AgentActivityTransitionReport::default()
                }
            })
        }
    }

    #[derive(Clone)]
    struct TransitionPause {
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }

    impl TransitionPause {
        fn new() -> Self {
            Self {
                entered: Arc::new(Notify::new()),
                release: Arc::new(Notify::new()),
            }
        }
    }

    #[derive(Clone)]
    struct CancellationTestRuntime {
        provider_enabled: Arc<AtomicBool>,
        terminal_enabled: Arc<AtomicBool>,
        provider_pause: Arc<StdMutex<Option<TransitionPause>>>,
    }

    impl CancellationTestRuntime {
        fn new(enabled: bool) -> Self {
            Self {
                provider_enabled: Arc::new(AtomicBool::new(enabled)),
                terminal_enabled: Arc::new(AtomicBool::new(enabled)),
                provider_pause: Arc::default(),
            }
        }

        fn pause_next_provider_transition(&self) -> TransitionPause {
            let pause = TransitionPause::new();
            *self.provider_pause.lock().expect("provider pause") = Some(pause.clone());
            pause
        }
    }

    impl AgentActivityTransitionRuntime for CancellationTestRuntime {
        fn finalize_disabled_activity(&self) -> BoxAgentActivityFuture<'_, Result<usize, ()>> {
            Box::pin(async { Ok(0) })
        }

        fn set_provider_activity_enabled(
            &self,
            enabled: bool,
        ) -> BoxAgentActivityFuture<'_, Result<usize, ()>> {
            Box::pin(async move {
                let pause = self.provider_pause.lock().expect("provider pause").take();
                if let Some(pause) = pause {
                    pause.entered.notify_one();
                    pause.release.notified().await;
                }
                self.provider_enabled
                    .store(enabled, AtomicOrdering::Release);
                Ok(1)
            })
        }

        fn set_terminal_activity_enabled(
            &self,
            enabled: bool,
        ) -> BoxAgentActivityFuture<'_, TerminalAgentActivityTransition> {
            Box::pin(async move {
                self.terminal_enabled
                    .store(enabled, AtomicOrdering::Release);
                TerminalAgentActivityTransition::default()
            })
        }
    }

    #[derive(Clone)]
    struct CancellationTestHandler {
        coordinator: AgentActivityCoordinator,
        runtime: CancellationTestRuntime,
        calls: Arc<StdMutex<Vec<(bool, u64)>>>,
    }

    impl AgentActivitySettingsHandler for CancellationTestHandler {
        fn transition(
            &self,
            enabled: bool,
            settings_generation: u64,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = AgentActivityTransitionReport> + Send + '_>,
        > {
            Box::pin(async move {
                self.calls
                    .lock()
                    .expect("handler calls")
                    .push((enabled, settings_generation));
                self.coordinator
                    .transition(&self.runtime, enabled, settings_generation)
                    .await
            })
        }
    }

    #[test]
    fn native_settings_default_grok_to_disabled() {
        let mut settings = json!({});
        apply_settings_defaults(&mut settings);

        assert_eq!(settings["providers"]["grok"]["enabled"], false);
    }

    #[tokio::test]
    async fn agent_activity_setting_defaults_publishes_persists_and_rejects_strings() {
        let temp = tempfile::tempdir().expect("control root");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        let control = NativeServerControl::new(config, json!({"policy":"test"})).await;

        assert_eq!(control.settings.read().await["enableAgentActivity"], true);
        let mut events = control.config_events.subscribe();

        let updated = control
            .update_settings(json!({"patch":{"enableAgentActivity":false}}))
            .await
            .expect("disable agent activity");
        assert_eq!(updated["enableAgentActivity"], false);
        assert_eq!(control.settings.read().await["enableAgentActivity"], false);
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
            .await
            .expect("settings update publishes an event")
            .expect("settings update event");
        assert_eq!(event["type"], "settingsUpdated");
        assert_eq!(event["payload"]["settings"]["enableAgentActivity"], false);

        let persisted: Value = serde_json::from_slice(
            &tokio::fs::read(settings_path).await.expect("persisted settings"),
        )
        .expect("valid JSON");
        assert_eq!(persisted["enableAgentActivity"], false);

        assert!(
            control
                .update_settings(json!({"patch":{"enableAgentActivity":"false"}}))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn agent_activity_handler_runs_after_persistence_before_publication() {
        let temp = tempfile::tempdir().expect("control root");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        let control = NativeServerControl::new(config, json!({"policy":"test"})).await;
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let pause = Arc::new(Barrier::new(2));
        control
            .attach_agent_activity_handler(Arc::new(TestAgentActivityHandler {
                calls: calls.clone(),
                pause: Some(pause.clone()),
            }))
            .await;
        assert!(control.agent_activity_enabled().await);
        let mut events = control.config_events.subscribe();
        let update = tokio::spawn({
            let control = control.clone();
            async move {
                control
                    .update_settings(json!({"patch":{"enableAgentActivity":false}}))
                    .await
            }
        });

        pause.wait().await;
        let persisted: Value = serde_json::from_slice(
            &tokio::fs::read(&settings_path)
                .await
                .expect("settings persisted before transition"),
        )
        .expect("valid persisted settings");
        assert_eq!(persisted["enableAgentActivity"], false);
        assert_eq!(control.settings.read().await["enableAgentActivity"], true);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), events.recv())
                .await
                .is_err(),
            "settings publication waits for the effective transition"
        );
        pause.wait().await;

        let updated = update.await.expect("update task").expect("settings update");
        assert_eq!(updated["enableAgentActivity"], false);
        assert_eq!(&*calls.lock().expect("handler calls"), &[(false, 1)]);
        assert_eq!(
            events.recv().await.expect("settings event")["type"],
            "settingsUpdated"
        );
    }

    #[tokio::test]
    async fn failed_persistence_does_not_call_agent_activity_handler() {
        let temp = tempfile::tempdir().expect("control root");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        let control = NativeServerControl::new(config, json!({"policy":"test"})).await;
        tokio::fs::create_dir_all(&settings_path)
            .await
            .expect("directory blocks atomic settings rename");
        let calls = Arc::new(StdMutex::new(Vec::new()));
        control
            .attach_agent_activity_handler(Arc::new(TestAgentActivityHandler {
                calls: calls.clone(),
                pause: None,
            }))
            .await;

        assert!(
            control
                .update_settings(json!({"patch":{"enableAgentActivity":false}}))
                .await
                .is_err()
        );
        assert!(calls.lock().expect("handler calls").is_empty());
        assert!(control.agent_activity_enabled().await);
    }

    #[tokio::test]
    async fn persisted_activity_transitions_survive_cancellation_and_serialize_followups() {
        let temp = tempfile::tempdir().expect("control root");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        let control = NativeServerControl::new(config, json!({"policy":"test"})).await;
        let runtime = CancellationTestRuntime::new(true);
        let trace = TraceDiagnosticsStore::new(temp.path().join("activity.trace.ndjson"));
        let coordinator = AgentActivityCoordinator::new(
            AgentActivityController::new(true),
            trace,
            "cancellation-test".to_owned(),
        );
        let controller = coordinator.controller();
        let calls = Arc::new(StdMutex::new(Vec::new()));
        control
            .attach_agent_activity_handler(Arc::new(CancellationTestHandler {
                coordinator,
                runtime: runtime.clone(),
                calls: calls.clone(),
            }))
            .await;
        let mut events = control.config_events.subscribe();

        let disable_pause = runtime.pause_next_provider_transition();
        let disable = tokio::spawn({
            let control = control.clone();
            async move {
                control
                    .update_settings(json!({"patch":{"enableAgentActivity":false}}))
                    .await
            }
        });
        disable_pause.entered.notified().await;
        disable.abort();
        assert!(!controller.snapshot().enabled);

        let followup = tokio::spawn({
            let control = control.clone();
            async move {
                control
                    .update_settings(json!({"patch":{"terminalDefaultShell":"/bin/test-shell"}}))
                    .await
            }
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), events.recv())
                .await
                .is_err(),
            "publication waits for the disabled transition"
        );
        assert!(
            !followup.is_finished(),
            "a concurrent settings update waits for the committed transition"
        );
        disable_pause.release.notify_one();

        let disabled_event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .expect("disabled publication")
            .expect("settings event");
        assert_eq!(
            disabled_event["payload"]["settings"]["enableAgentActivity"],
            false
        );
        followup
            .await
            .expect("followup task")
            .expect("followup update");
        assert!(!control.agent_activity_enabled().await);
        assert!(!runtime.provider_enabled.load(AtomicOrdering::Acquire));
        assert!(!runtime.terminal_enabled.load(AtomicOrdering::Acquire));
        let persisted: Value = serde_json::from_slice(
            &tokio::fs::read(&settings_path)
                .await
                .expect("disabled settings"),
        )
        .expect("valid disabled settings");
        assert_eq!(persisted["enableAgentActivity"], false);

        while events.try_recv().is_ok() {}
        let enable_pause = runtime.pause_next_provider_transition();
        let enable = tokio::spawn({
            let control = control.clone();
            async move {
                control
                    .update_settings(json!({"patch":{"enableAgentActivity":true}}))
                    .await
            }
        });
        enable_pause.entered.notified().await;
        enable.abort();
        assert!(controller.snapshot().enabled);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), events.recv())
                .await
                .is_err(),
            "publication waits for the enabled transition"
        );
        enable_pause.release.notify_one();

        let enabled_event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .expect("enabled publication")
            .expect("settings event");
        assert_eq!(
            enabled_event["payload"]["settings"]["enableAgentActivity"],
            true
        );
        assert!(control.agent_activity_enabled().await);
        assert!(runtime.provider_enabled.load(AtomicOrdering::Acquire));
        assert!(runtime.terminal_enabled.load(AtomicOrdering::Acquire));
        let persisted: Value = serde_json::from_slice(
            &tokio::fs::read(settings_path)
                .await
                .expect("enabled settings"),
        )
        .expect("valid enabled settings");
        assert_eq!(persisted["enableAgentActivity"], true);
        assert_eq!(
            &*calls.lock().expect("handler calls"),
            &[(false, 1), (true, 3)]
        );
        assert_eq!(control.settings_generation.load(Ordering::Acquire), 3);
    }

    #[test]
    fn default_agent_is_defaulted_and_validated() {
        let mut settings = json!({});
        apply_settings_defaults(&mut settings);
        assert_eq!(
            settings["defaultAgent"],
            json!({"kind":"chat","instanceId":"codex"})
        );
        assert!(validate_settings_document(&settings).is_ok());

        settings["defaultAgent"] = json!({"kind":"terminal","instanceId":"claudeAgent"});
        assert!(validate_settings_document(&settings).is_ok());

        settings["defaultAgent"] = json!({"kind":"shell","instanceId":"codex"});
        assert!(validate_settings_document(&settings).is_err());
    }

    #[tokio::test]
    async fn default_agent_update_persists_as_a_whole_selection() {
        let temp = tempfile::tempdir().expect("control root");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        let control = NativeServerControl::new(config, json!({"policy":"test"})).await;

        let updated = control
            .update_settings(json!({
                "patch":{"defaultAgent":{"kind":"terminal","instanceId":"claudeAgent"}}
            }))
            .await
            .expect("default agent update");
        assert_eq!(
            updated["defaultAgent"],
            json!({"kind":"terminal","instanceId":"claudeAgent"})
        );
        assert!(
            control
                .update_settings(json!({"patch":{"defaultAgent":{"kind":"terminal"}}}))
                .await
                .is_err()
        );

        let persisted: Value = serde_json::from_slice(
            &tokio::fs::read(settings_path)
                .await
                .expect("persisted settings"),
        )
        .expect("valid JSON");
        assert_eq!(persisted["defaultAgent"], updated["defaultAgent"]);
    }

    #[tokio::test]
    async fn workspace_update_normalizes_existing_directories_and_rejects_invalid_targets() {
        let temp = tempfile::tempdir().expect("control root");
        let workspace = temp.path().join("workspace");
        tokio::fs::create_dir(&workspace).await.expect("workspace");
        let file = temp.path().join("file.txt");
        tokio::fs::write(&file, b"file").await.expect("file");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        let control = NativeServerControl::new(config, json!({"policy":"test"})).await;

        let updated = control
            .update_settings(json!({
                "patch": {"worktreeBaseDirectory": workspace.to_string_lossy()}
            }))
            .await
            .expect("valid workspace");
        assert_eq!(
            PathBuf::from(updated["worktreeBaseDirectory"].as_str().expect("path")),
            super::super::host_paths::process_compatible_path(
                tokio::fs::canonicalize(&workspace)
                    .await
                    .expect("canonical workspace"),
            )
        );

        for (path, failure) in [
            ("relative/worktrees".to_owned(), "relative_path"),
            (
                temp.path().join("missing").to_string_lossy().into_owned(),
                "missing",
            ),
            (file.to_string_lossy().into_owned(), "not_directory"),
        ] {
            let error = control
                .update_settings(json!({"patch":{"worktreeBaseDirectory":path}}))
                .await
                .expect_err("invalid workspace");
            assert_eq!(error["_tag"], "WorktreeWorkspaceError");
            assert_eq!(error["failure"], failure);
            assert_eq!(
                control.settings.read().await["worktreeBaseDirectory"],
                updated["worktreeBaseDirectory"]
            );
            let persisted: Value = serde_json::from_slice(
                &tokio::fs::read(&settings_path)
                    .await
                    .expect("persisted settings"),
            )
            .expect("valid persisted JSON");
            assert_eq!(
                persisted["worktreeBaseDirectory"],
                updated["worktreeBaseDirectory"]
            );
        }
    }

    #[test]
    fn quick_and_failed_probes_retain_rich_metadata_but_update_health() {
        let current = json!({
            "instanceId": "codex",
            "driver": "codex",
            "status": "ready",
            "checkedAt": "old",
            "models": [{ "slug": "gpt-rich" }],
            "slashCommands": [{ "name": "goal" }],
            "skills": [{ "name": "review" }],
            "agents": [{ "name": "builder" }]
        });
        let quick = provider_inventory::ProviderProbeResult {
            snapshot: json!({
                "instanceId": "codex",
                "driver": "codex",
                "status": "warning",
                "checkedAt": "new",
                "models": [{ "slug": "gpt-fallback" }],
                "slashCommands": [{ "name": "goal" }],
                "skills": [],
                "agents": []
            }),
            rich_metadata: provider_inventory::RichMetadataOutcome::NotRequested,
            models_authoritative: false,
        };
        let failed = provider_inventory::ProviderProbeResult {
            rich_metadata: provider_inventory::RichMetadataOutcome::Failed,
            ..quick.clone()
        };

        for result in [quick, failed] {
            let merged = merge_provider_snapshot(Some(&current), result);
            assert_eq!(merged["status"], "warning");
            assert_eq!(merged["checkedAt"], "new");
            assert_eq!(merged["models"], current["models"]);
            assert_eq!(merged["skills"], current["skills"]);
            assert_eq!(merged["agents"], current["agents"]);
        }
    }

    #[test]
    fn authoritative_models_survive_a_failed_capabilities_probe() {
        let current = json!({
            "instanceId": "claudeAgent",
            "driver": "claudeAgent",
            "models": [{ "slug": "claude-too-new" }],
            "slashCommands": [{ "name": "old-command" }],
            "skills": [{ "name": "old-skill" }],
            "agents": [{ "name": "old-agent" }]
        });
        let refreshed = provider_inventory::ProviderProbeResult {
            snapshot: json!({
                "instanceId": "claudeAgent",
                "driver": "claudeAgent",
                "models": [{ "slug": "claude-supported" }],
                "slashCommands": [],
                "skills": [],
                "agents": []
            }),
            rich_metadata: provider_inventory::RichMetadataOutcome::Failed,
            models_authoritative: true,
        };

        let merged = merge_provider_snapshot(Some(&current), refreshed);

        assert_eq!(merged["models"], json!([{ "slug": "claude-supported" }]));
        assert_eq!(merged["slashCommands"], current["slashCommands"]);
        assert_eq!(merged["skills"], current["skills"]);
        assert_eq!(merged["agents"], current["agents"]);
    }

    #[test]
    fn disabled_replacement_does_not_retain_metadata_from_another_driver() {
        let current = json!({
            "instanceId": "shared",
            "driver": "codex",
            "enabled": true,
            "models": [{ "slug": "gpt-rich" }],
            "slashCommands": [{ "name": "goal" }],
            "skills": [{ "name": "review" }],
            "agents": [{ "name": "builder" }]
        });
        let replacement = provider_inventory::ProviderProbeResult {
            snapshot: json!({
                "instanceId": "shared",
                "driver": "claudeAgent",
                "enabled": false,
                "models": [{ "slug": "claude-disabled" }],
                "slashCommands": [{ "name": "loop" }],
                "skills": [],
                "agents": []
            }),
            rich_metadata: provider_inventory::RichMetadataOutcome::NotRequested,
            models_authoritative: false,
        };

        let merged = merge_provider_snapshot(Some(&current), replacement);

        assert_eq!(merged["driver"], "claudeAgent");
        assert_eq!(merged["enabled"], false);
        assert_eq!(merged["models"], json!([{ "slug": "claude-disabled" }]));
        assert_eq!(merged["slashCommands"], json!([{ "name": "loop" }]));
        assert_eq!(merged["skills"], json!([]));
        assert_eq!(merged["agents"], json!([]));
    }

    #[test]
    fn successful_rich_probe_can_authoritatively_clear_metadata() {
        let current = json!({
            "instanceId": "codex",
            "models": [{ "slug": "retired" }],
            "slashCommands": [{ "name": "old" }],
            "skills": [{ "name": "old" }],
            "agents": [{ "name": "old" }]
        });
        let merged = merge_provider_snapshot(
            Some(&current),
            provider_inventory::ProviderProbeResult {
                snapshot: json!({
                    "instanceId": "codex",
                    "models": [],
                    "slashCommands": [],
                    "skills": [],
                    "agents": []
                }),
                rich_metadata: provider_inventory::RichMetadataOutcome::Succeeded,
                models_authoritative: true,
            },
        );

        assert_eq!(merged["models"], json!([]));
        assert_eq!(merged["skills"], json!([]));
        assert_eq!(merged["agents"], json!([]));
    }

    #[test]
    fn provider_session_defaults_are_defaulted_and_replaced_as_a_whole() {
        let mut settings = json!({
            "providers": {
                "codex": {
                    "enabled": false,
                    "binaryPath": "/opt/bin/codex"
                }
            },
            "providerInstances": {
                "work": {
                    "driver": "codex",
                    "displayName": "Work"
                }
            }
        });

        apply_settings_defaults(&mut settings);
        assert_eq!(settings["providerSessionDefaults"], json!({}));
        let providers = settings["providers"].clone();
        let provider_instances = settings["providerInstances"].clone();

        apply_settings_patch(
            &mut settings,
            json!({
                "providerSessionDefaults": {
                    "codex": {
                        "model": "gpt-5.4",
                        "options": [{"id": "reasoningEffort", "value": "medium"}]
                    },
                    "claudeAgent": {
                        "model": "claude-sonnet-4-6"
                    }
                }
            }),
        );
        assert_eq!(
            settings["providerSessionDefaults"],
            json!({
                "codex": {
                    "model": "gpt-5.4",
                    "options": [{"id": "reasoningEffort", "value": "medium"}]
                },
                "claudeAgent": {
                    "model": "claude-sonnet-4-6"
                }
            })
        );
        assert_eq!(settings["providers"], providers);
        assert_eq!(settings["providerInstances"], provider_instances);

        apply_settings_patch(
            &mut settings,
            json!({
                "providerSessionDefaults": {
                    "codex": {
                        "model": "gpt-5.4-mini",
                        "options": [{"id": "fastMode", "value": true}]
                    }
                }
            }),
        );
        assert_eq!(
            settings["providerSessionDefaults"],
            json!({
                "codex": {
                    "model": "gpt-5.4-mini",
                    "options": [{"id": "fastMode", "value": true}]
                }
            })
        );
        assert_eq!(settings["providers"], providers);
        assert_eq!(settings["providerInstances"], provider_instances);

        apply_settings_patch(&mut settings, json!({"observability":{"legacy":true}}));
        apply_settings_defaults(&mut settings);
        assert!(settings.get("observability").is_none());
    }

    #[tokio::test]
    async fn server_settings_expose_terminal_webgl_default_and_patch() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let mut config = ServerConfig::new(temp.path());
        config.environment_id = "environment-webgl".to_owned();
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;

        let settings = control
            .call("server.getSettings", json!({}), CancellationToken::new())
            .await
            .expect("settings");
        assert_eq!(settings["terminal"]["webglEnabled"], true);

        let updated = control
            .update_settings(json!({ "patch": { "terminal": { "webglEnabled": false } } }))
            .await
            .expect("patch applies");
        assert_eq!(updated["terminal"]["webglEnabled"], false);
        assert_eq!(updated["enableProviderUpdateChecks"], true);
    }

    #[tokio::test]
    async fn concurrent_settings_updates_preserve_every_committed_patch() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let mut config = ServerConfig::new(temp.path());
        config.environment_id = "environment-concurrent-settings".to_owned();
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;
        control.install_settings_update_barrier(24).await;

        let updates = (0..24)
            .map(|index| {
                let control = control.clone();
                tokio::spawn(async move {
                    control
                        .update_settings(json!({
                            "patch": {
                                "concurrentUpdates": {
                                    format!("update-{index}"): true
                                },
                                "providerInstances": {
                                    "concurrency-test": {
                                        "driver": "codex",
                                        "environment": [{
                                            "name": "TOKEN",
                                            "value": format!("secret-{index}"),
                                            "sensitive": true
                                        }]
                                    }
                                }
                            }
                        }))
                        .await
                })
            })
            .collect::<Vec<_>>();
        for update in updates {
            update
                .await
                .expect("settings task joins")
                .expect("settings update succeeds");
        }

        let settings = control
            .call("server.getSettings", json!({}), CancellationToken::new())
            .await
            .expect("settings remain readable");
        for index in 0..24 {
            assert_eq!(
                settings["concurrentUpdates"][format!("update-{index}")],
                true
            );
        }
        let persisted = read_json::<Value>(control.settings_path.clone())
            .await
            .expect("settings file reads")
            .expect("settings file exists");
        assert_eq!(
            persisted["concurrentUpdates"],
            settings["concurrentUpdates"]
        );
    }

    #[tokio::test]
    async fn older_probe_completion_cannot_overwrite_newer_same_generation_snapshot() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let mut config = ServerConfig::new(temp.path());
        config.environment_id = "environment-provider-probe-order".to_owned();
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(
            settings_path,
            br#"{
                "providers": {
                    "codex": {"enabled": false},
                    "claudeAgent": {"enabled": false},
                    "cursor": {"enabled": false},
                    "grok": {"enabled": false},
                    "opencode": {"enabled": false}
                }
            }"#,
        )
        .await
        .expect("disabled provider fixture");
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;
        let (generation, settings) = control.settings_snapshot().await;

        let older_sequence = control.begin_provider_probe();
        let newer_sequence = control.begin_provider_probe();
        let older_release = Arc::new(Notify::new());
        let older_entered = Arc::new(Notify::new());
        let older_completion = {
            let control = control.clone();
            let settings = settings.clone();
            let older_release = older_release.clone();
            let older_entered = older_entered.clone();
            tokio::spawn(async move {
                older_entered.notify_one();
                older_release.notified().await;
                control
                    .publish_provider_snapshots_if_current(
                        vec![provider_inventory::ProviderProbeResult {
                            snapshot: json!({
                                "instanceId": "codex",
                                "driver": "codex",
                                "checkedAt": "older-completion",
                                "models": [],
                                "slashCommands": [],
                                "skills": [],
                                "agents": []
                            }),
                            rich_metadata: provider_inventory::RichMetadataOutcome::Succeeded,
                            models_authoritative: true,
                        }],
                        false,
                        generation,
                        &settings,
                        older_sequence,
                    )
                    .await
            })
        };
        older_entered.notified().await;

        control
            .publish_provider_snapshots_if_current(
                vec![provider_inventory::ProviderProbeResult {
                    snapshot: json!({
                        "instanceId": "codex",
                        "driver": "codex",
                        "checkedAt": "newer-completion",
                        "models": [],
                        "slashCommands": [],
                        "skills": [],
                        "agents": []
                    }),
                    rich_metadata: provider_inventory::RichMetadataOutcome::Succeeded,
                    models_authoritative: true,
                }],
                false,
                generation,
                &settings,
                newer_sequence,
            )
            .await
            .expect("newer probe publishes");
        older_release.notify_one();

        assert!(
            older_completion
                .await
                .expect("older completion joins")
                .is_none(),
            "older probe request must not publish after a newer request"
        );
        assert_eq!(
            control.providers.read().await[0]["checkedAt"],
            "newer-completion"
        );
    }

    #[tokio::test]
    async fn concurrent_settings_stream_discards_stale_provider_probes_in_commit_order() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let mut config = ServerConfig::new(temp.path());
        config.environment_id = "environment-concurrent-stream".to_owned();
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(
            &settings_path,
            br#"{
                "providers": {
                    "codex": {"enabled": false},
                    "claudeAgent": {"enabled": false},
                    "cursor": {"enabled": false},
                    "grok": {"enabled": false},
                    "opencode": {"enabled": false}
                }
            }"#,
        )
        .await
        .expect("disabled provider fixture");
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;

        let initial_full_probe = control.install_next_full_provider_probe_pause().await;
        let cancellation = CancellationToken::new();
        let mut stream = control.subscribe("subscribeServerConfig", cancellation.clone());
        let snapshot = stream
            .recv()
            .await
            .expect("config stream")
            .expect("snapshot batch");
        assert_eq!(snapshot[0]["type"], "snapshot");
        initial_full_probe.wait_until_entered().await;

        let stale_quick_probe = control.install_next_quick_provider_probe_pause().await;
        let stale_control = control.clone();
        let stale_update = tokio::spawn(async move {
            stale_control
                .update_settings(json!({
                    "patch": {
                        "streamCommit": "first",
                        "providerInstances": {
                            "stale_instance": {
                                "driver": "codex",
                                "enabled": false,
                                "config": {}
                            }
                        }
                    }
                }))
                .await
        });
        stale_quick_probe.wait_until_entered().await;

        control
            .update_settings(json!({
                "patch": {
                    "streamCommit": "second",
                    "providerInstances": {
                        "current_instance": {
                            "driver": "codex",
                            "enabled": false,
                            "config": {}
                        }
                    }
                }
            }))
            .await
            .expect("current update succeeds");
        stale_quick_probe.release();
        stale_update
            .await
            .expect("stale update joins")
            .expect("stale update committed before it was delayed");
        initial_full_probe.release();

        tokio::time::timeout(tokio::time::Duration::from_secs(5), async {
            while control
                .full_provider_refresh_running
                .load(Ordering::Acquire)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("full provider refresh completes");

        let mut events = Vec::new();
        while let Ok(Some(batch)) =
            tokio::time::timeout(tokio::time::Duration::from_millis(50), stream.recv()).await
        {
            events.extend(batch.expect("config event batch"));
        }
        cancellation.cancel();

        let settings_events = events
            .iter()
            .filter(|event| event["type"] == "settingsUpdated")
            .collect::<Vec<_>>();
        assert_eq!(
            settings_events
                .iter()
                .map(|event| event["payload"]["settings"]["streamCommit"].as_str())
                .collect::<Vec<_>>(),
            vec![Some("first"), Some("second")]
        );
        let final_settings_index = events
            .iter()
            .rposition(|event| event["type"] == "settingsUpdated")
            .expect("final settings event");
        for event in events.iter().skip(final_settings_index + 1) {
            if event["type"] == "providerStatuses" {
                let providers = event["payload"]["providers"]
                    .as_array()
                    .expect("provider status payload");
                assert!(
                    providers
                        .iter()
                        .all(|provider| provider["instanceId"] != "stale_instance"),
                    "stale provider probe was published after the final settings event"
                );
            }
        }

        let memory_settings = control.settings.read().await.clone();
        let memory_providers = control.providers.read().await.clone();
        let persisted_settings = read_json::<Value>(&settings_path)
            .await
            .expect("settings file reads")
            .expect("settings file exists");
        assert_eq!(memory_settings, persisted_settings);
        assert_eq!(
            settings_events.last().expect("last settings event")["payload"]["settings"],
            memory_settings
        );
        assert_eq!(
            events
                .iter()
                .rev()
                .find(|event| event["type"] == "providerStatuses")
                .expect("last provider event")["payload"]["providers"],
            json!(memory_providers)
        );
    }

    #[tokio::test]
    async fn malformed_settings_surface_structured_errors_and_refuse_mutation() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(&settings_path, b"{not-json")
            .await
            .expect("malformed settings fixture");
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;

        let read_error = control
            .call("server.getSettings", json!({}), CancellationToken::new())
            .await
            .expect_err("malformed settings are not presented as defaults");
        assert_eq!(read_error["_tag"], "ServerSettingsError");
        assert_eq!(read_error["operation"], "read-file");
        assert_eq!(
            control
                .call("server.getConfig", json!({}), CancellationToken::new())
                .await
                .expect_err("malformed settings reject config reads"),
            read_error
        );
        let mut config_stream =
            control.subscribe("subscribeServerConfig", CancellationToken::new());
        assert_eq!(
            config_stream
                .recv()
                .await
                .expect("config stream reports its load failure")
                .expect_err("malformed settings reject config subscriptions"),
            read_error
        );

        let update_error = control
            .update_settings(json!({"patch":{"enableAssistantStreaming":true}}))
            .await
            .expect_err("malformed settings refuse mutation");
        assert_eq!(update_error, read_error);
        assert_eq!(
            tokio::fs::read(&settings_path)
                .await
                .expect("malformed file remains readable"),
            b"{not-json"
        );
    }

    #[tokio::test]
    async fn schema_invalid_settings_surface_structured_errors_and_preserve_original_bytes() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let cases = [
            ("top-level array", br#"[]"#.as_slice()),
            (
                "provider defaults array",
                br#"{"providerSessionDefaults":[]}"#.as_slice(),
            ),
            (
                "provider default model",
                br#"{"providerSessionDefaults":{"codex":{"model":42}}}"#.as_slice(),
            ),
            (
                "provider default option",
                br#"{"providerSessionDefaults":{"codex":{"model":"gpt-5.4","options":[{"id":"reasoningEffort","value":1}]}}}"#
                    .as_slice(),
            ),
            ("providers array", br#"{"providers":[]}"#.as_slice()),
            (
                "provider instances array",
                br#"{"providerInstances":[]}"#.as_slice(),
            ),
            (
                "provider instance null display name",
                br#"{"providerInstances":{"codex":{"driver":"codex","displayName":null}}}"#
                    .as_slice(),
            ),
            (
                "provider instance null accent color",
                br#"{"providerInstances":{"codex":{"driver":"codex","accentColor":null}}}"#
                    .as_slice(),
            ),
            (
                "model selection shape",
                br#"{"textGenerationModelSelection":{"instanceId":"codex","model":[]}}"#
                    .as_slice(),
            ),
            (
                "terminal shape",
                br#"{"terminal":{"webglEnabled":"yes"}}"#.as_slice(),
            ),
        ];

        for (name, original) in cases {
            let temp = tempfile::tempdir().expect("state directory");
            let mut config = ServerConfig::new(temp.path());
            config.environment_id = format!("environment-invalid-{name}");
            let settings_path = config.state_dir().join("settings.json");
            tokio::fs::create_dir_all(config.state_dir())
                .await
                .expect("state directory exists");
            tokio::fs::write(&settings_path, original)
                .await
                .expect("schema-invalid settings fixture");
            let control = NativeServerControl::new(config, json!({"policy": "test"})).await;

            let read_error = control
                .call("server.getSettings", json!({}), CancellationToken::new())
                .await
                .expect_err(name);
            assert_eq!(read_error["_tag"], "ServerSettingsError", "{name}");
            assert_eq!(read_error["operation"], "normalize", "{name}");
            assert_eq!(
                control
                    .call("server.getConfig", json!({}), CancellationToken::new())
                    .await
                    .expect_err(name),
                read_error,
                "{name}"
            );
            let mut config_stream =
                control.subscribe("subscribeServerConfig", CancellationToken::new());
            assert_eq!(
                config_stream
                    .recv()
                    .await
                    .expect("config stream reports its load failure")
                    .expect_err(name),
                read_error,
                "{name}"
            );
            assert_eq!(
                control
                    .update_settings(json!({"patch":{"enableAssistantStreaming":true}}))
                    .await
                    .expect_err(name),
                read_error,
                "{name}"
            );
            assert_eq!(
                tokio::fs::read(&settings_path)
                    .await
                    .expect("schema-invalid file remains readable"),
                original,
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_settings_patch_is_transactional_and_publishes_no_events() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        let original = br#"{"enableAssistantStreaming":false}"#;
        tokio::fs::write(&settings_path, original)
            .await
            .expect("valid settings fixture");
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;
        let before = control.settings.read().await.clone();
        let mut events = control.config_events.subscribe();

        let error = control
            .update_settings(json!({"patch":{"terminal":{"webglEnabled":"yes"}}}))
            .await
            .expect_err("invalid patch is rejected");

        assert_eq!(error["_tag"], "ServerSettingsError");
        assert_eq!(error["operation"], "normalize");
        assert_eq!(*control.settings.read().await, before);
        assert_eq!(
            tokio::fs::read(&settings_path)
                .await
                .expect("settings file remains readable"),
            original
        );
        assert!(
            tokio::time::timeout(tokio::time::Duration::from_millis(50), events.recv())
                .await
                .is_err(),
            "invalid update must not publish settings or provider events"
        );
    }

    #[tokio::test]
    async fn settings_validation_accepts_fractional_fetch_intervals() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(&settings_path, br#"{"automaticGitFetchInterval":0.1}"#)
            .await
            .expect("fractional interval fixture");
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;

        let settings = control
            .call("server.getSettings", json!({}), CancellationToken::new())
            .await
            .expect("fractional millisecond interval is contract-valid");

        assert_eq!(settings["automaticGitFetchInterval"], json!(0.1));
    }

    #[tokio::test]
    async fn settings_validation_preserves_open_unknown_keys_and_legacy_options() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(
            &settings_path,
            br#"{
                "futureSetting": {"nested": [1, true, null]},
                "providerInstances": {
                    "fork_one": {
                        "driver": "forkDriver",
                        "config": {"futureDriverField": {"kept": true}}
                    }
                },
                "providerSessionDefaults": {
                    "forkDriver": {
                        "model": "future-model",
                        "options": {"effort": "high", "futureNumericValue": 1}
                    }
                }
            }"#,
        )
        .await
        .expect("open settings fixture");

        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;
        let settings = control
            .call("server.getSettings", json!({}), CancellationToken::new())
            .await
            .expect("open settings remain readable");

        assert_eq!(
            settings["futureSetting"],
            json!({"nested": [1, true, null]})
        );
        assert_eq!(
            settings["providerInstances"]["fork_one"]["config"]["futureDriverField"],
            json!({"kept": true})
        );
        assert_eq!(
            settings["providerSessionDefaults"]["forkDriver"]["options"],
            json!({"effort": "high", "futureNumericValue": 1})
        );
    }

    #[tokio::test]
    async fn unit_build_covers_server_control_settings_keybindings_and_streams() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let mut config = ServerConfig::new(temp.path());
        config.environment_id = "environment-1".to_owned();
        config.environment_label = "Environment One".to_owned();
        let control = NativeServerControl::new(config.clone(), json!({"policy":"test"})).await;

        let snapshot = control.config_snapshot().await;
        assert_eq!(snapshot["environment"]["environmentId"], "environment-1");
        assert_eq!(snapshot["auth"]["policy"], "test");
        assert!(!current_directory(&config).is_empty());
        assert!(!platform_os().is_empty());
        assert!(!platform_arch().is_empty());
        assert!(
            environment_descriptor(&config, false)["capabilities"]["repositoryIdentity"] == true
        );
        let _ = available_editors();
        assert!(!command_exists("definitely-not-a-bibcode-editor"));

        let call = |method, payload, cancellation| control.call(method, payload, cancellation);
        assert!(
            call("server.getSettings", json!({}), CancellationToken::new())
                .await
                .expect("settings")
                .is_object()
        );
        assert!(
            call("server.getConfig", json!({}), CancellationToken::new())
                .await
                .expect("config")
                .is_object()
        );
        assert_eq!(
            call(
                "server.updateProvider",
                json!({"provider":"grok"}),
                CancellationToken::new(),
            )
            .await
            .expect_err("provider update unavailable")["_tag"],
            "ServerProviderUpdateError"
        );
        assert_eq!(
            call("server.unknown", json!({}), CancellationToken::new())
                .await
                .expect_err("unknown method")["_tag"],
            "InvalidRequest"
        );
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert_eq!(
            call("server.getConfig", json!({}), cancelled)
                .await
                .expect_err("cancelled call")["_tag"],
            "RequestCancelled"
        );
        assert_eq!(
            control
                .update_settings(json!({}))
                .await
                .expect_err("missing patch")["operation"],
            "normalize"
        );
        assert!(control.update_settings(json!({"patch":[]})).await.is_err());

        let updated = control
            .update_settings(json!({
                "patch":{
                    "enableAssistantStreaming":true,
                    "providerInstances":{
                        "work":{
                            "driver":"codex",
                            "environment":[
                                {"name":"TOKEN","value":"secret","sensitive":true},
                                {"name":"PLAIN","value":"visible","sensitive":false}
                            ]
                        }
                    }
                }
            }))
            .await
            .expect("settings update");
        assert_eq!(updated["enableAssistantStreaming"], true);
        assert_eq!(
            updated["providerInstances"]["work"]["environment"][0]["valueRedacted"],
            true
        );
        assert!(secret_path(&control.state_directory, "work", "TOKEN").is_file());
        let observability = observability_snapshot(&control.state_directory);
        assert_eq!(observability["localTracingEnabled"], true);
        assert_eq!(observability["otlpTracesEnabled"], false);
        assert_eq!(observability["otlpMetricsEnabled"], false);

        let mut merge_target = json!({"nested":{"left":1},"replace":1});
        merge_patch(
            &mut merge_target,
            json!({"nested":{"right":2},"replace":{"value":3}}),
        );
        assert_eq!(merge_target["nested"], json!({"left":1,"right":2}));
        assert_eq!(merge_target["replace"]["value"], 3);
        merge_patch(&mut merge_target, json!("scalar"));
        assert_eq!(merge_target, "scalar");
        let mut defaults = Value::Null;
        apply_settings_defaults(&mut defaults);
        apply_settings_patch(
            &mut defaults,
            json!({
                "automaticGitFetchInterval":5000,
                "textGenerationModelSelection":{"model":"custom"},
                "providers":{"codex":{"enabled":false}}
            }),
        );
        assert_eq!(defaults["providers"]["codex"]["enabled"], false);

        let added = control
            .update_keybinding(
                "server.upsertKeybinding",
                json!({"key":"ctrl+shift+k","command":"terminal.toggle"}),
            )
            .await
            .expect("keybinding adds");
        assert!(
            !added["keybindings"]
                .as_array()
                .expect("keybindings")
                .is_empty()
        );
        let removed = control
            .update_keybinding(
                "server.removeKeybinding",
                json!({"key":"ctrl+shift+k","command":"terminal.toggle"}),
            )
            .await
            .expect("keybinding removes");
        assert!(
            removed["keybindings"]
                .as_array()
                .expect("keybindings")
                .is_empty()
        );
        assert!(
            control
                .update_keybinding("server.upsertKeybinding", json!({"key":"bad"}))
                .await
                .is_err()
        );
        assert_eq!(
            settings_error(Path::new("settings.json"), "read", "bad")["_tag"],
            "ServerSettingsError"
        );
        assert_eq!(
            keybindings_error(Path::new("keys.json"), "bad")["_tag"],
            "KeybindingsConfigParseError"
        );

        let refreshed = control.refresh_providers(&json!({})).await;
        assert!(refreshed["providers"].is_array());
        let _ = control
            .merge_provider_snapshots(
                vec![provider_inventory::ProviderProbeResult {
                    snapshot: json!({"instanceId":"unit-provider","status":"disabled"}),
                    rich_metadata: provider_inventory::RichMetadataOutcome::Succeeded,
                    models_authoritative: true,
                }],
                true,
            )
            .await;
        control.publish_provider_snapshots(&[json!({"instanceId":"unit-provider"})]);
        control.publish(json!({"type":"unit"}));
        assert!(control.trace_diagnostics().is_object());

        let lifecycle_cancellation = CancellationToken::new();
        let mut lifecycle =
            control.subscribe("subscribeServerLifecycle", lifecycle_cancellation.clone());
        let welcome = lifecycle
            .recv()
            .await
            .expect("lifecycle stream")
            .expect("welcome batch");
        assert_eq!(welcome[0]["type"], "welcome");
        let ready = lifecycle
            .recv()
            .await
            .expect("lifecycle stream")
            .expect("ready batch");
        assert_eq!(ready[0]["type"], "ready");
        lifecycle_cancellation.cancel();

        let config_cancellation = CancellationToken::new();
        let mut config_stream =
            control.subscribe("subscribeServerConfig", config_cancellation.clone());
        let config_event = config_stream
            .recv()
            .await
            .expect("config stream")
            .expect("snapshot batch");
        assert_eq!(config_event[0]["type"], "snapshot");
        config_cancellation.cancel();

        let unknown_cancellation = CancellationToken::new();
        let mut unknown_stream = control.subscribe("unknown", unknown_cancellation);
        assert!(unknown_stream.recv().await.is_none());
        assert!(!now_iso().is_empty());
    }
}
