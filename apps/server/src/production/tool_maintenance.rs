//! Version notices and self-updates for command-line tools that are not agent providers
//! (CodeGraph today). The installed-version probe, the latest-version lookup and the update
//! action come from [`ProviderMaintenance`]; this module owns what a provider does not need:
//! the update runs as a server-owned task that survives a client disconnect, and a marker file
//! survives a crash so a half-finished update is never mistaken for a healthy install.

use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{RwLock, broadcast, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use super::{
    control::{now_iso, provider_update_state},
    provider_inventory::probe_maintenance_target_version,
    provider_maintenance::{
        ProbeFields, ProviderMaintenance, ProviderMaintenanceTarget, ProviderUpdateCommand,
        provider_version_advanced, provider_version_regressed,
    },
    provider_runtime::{
        normalize_provider_environment, prepare_provider_launch,
        resolve_provider_executable_with_environment,
    },
};
use crate::{
    diagnostics::{
        AttributionKind, AttributionScope, NativeProcessSampler, ProcessAttributionRegistry,
        ProcessRegistration, ProcessRegistrationMetadata, RegistrationSource,
    },
    maintenance::RpcPermit,
    process::supervised::{
        SupervisedOverflow, SupervisedRunError, SupervisedRunRequest,
        run_supervised_with_spawn_observer,
    },
};

pub(crate) const CODEGRAPH_ID: &str = "codegraph";
const UPDATE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long shutdown waits for a running update. Killing an updater mid-replacement is what
/// corrupts an install, so it is never asked to stop earlier than this.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(30);
/// How long a host that stops this server on a deadline of its own must allow a running tool
/// update on top of that deadline.
pub const TOOL_UPDATE_SHUTDOWN_WAIT: Duration = SHUTDOWN_WAIT;
const OUTPUT_LIMIT: usize = 10_000;
const STILL_UPDATING_MESSAGE: &str =
    "CodeGraph is still being updated by an earlier BiBCode session.";
const DAMAGED_MESSAGE: &str = "CodeGraph may be damaged (the last update did not finish cleanly).";
const CHANGED_WHILE_WAITING: &str =
    "CodeGraph changed while this update waited. Refresh and try again.";
const MANUAL_REINSTALL: &str = "Reinstall CodeGraph with its installer, then refresh.";
const UNKNOWN_INSTALL: &str = "BiBCode cannot tell how CodeGraph was installed, so it will not update it. Run `codegraph upgrade` yourself.";

/// The updater would otherwise write Claude's prompt hook and run `codegraph install --refresh`,
/// rewriting agent configuration. Verified against CodeGraph 1.6.2.
const UPDATE_ENVIRONMENT: [(&str, &str); 2] = [
    ("CODEGRAPH_NO_PROMPT_HOOK", "1"),
    ("CODEGRAPH_NO_INSTALL_REFRESH", "1"),
];

#[derive(Clone, Debug)]
pub(crate) struct ToolDefinition {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) binary_path: String,
    pub(crate) environment: Vec<(OsString, OsString)>,
}

impl ToolDefinition {
    pub(crate) fn codegraph() -> Self {
        Self {
            id: CODEGRAPH_ID.to_owned(),
            display_name: "CodeGraph".to_owned(),
            binary_path: "codegraph".to_owned(),
            environment: Vec::new(),
        }
    }

    fn target(&self) -> ProviderMaintenanceTarget {
        ProviderMaintenanceTarget {
            instance_id: self.id.clone(),
            driver: self.id.clone(),
            binary_path: self.binary_path.clone(),
            environment: self.environment.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ToolSetup {
    pub(crate) definitions: Vec<ToolDefinition>,
    pub(crate) maintenance: ProviderMaintenance,
    pub(crate) state_dir: PathBuf,
    pub(crate) shutdown_wait: Duration,
}

impl ToolSetup {
    pub(crate) fn production(maintenance: ProviderMaintenance, state_dir: PathBuf) -> Self {
        Self {
            // A bare `codegraph` would resolve on the host's PATH, which a hermetic test must
            // never touch; such tests install their own tools through `ToolSetup`.
            definitions: if cfg!(feature = "hermetic-test-guard") {
                Vec::new()
            } else {
                vec![ToolDefinition::codegraph()]
            },
            maintenance,
            state_dir,
            shutdown_wait: SHUTDOWN_WAIT,
        }
    }
}

/// Where a tool change is announced: the control's provider list and config stream.
#[derive(Clone, Debug)]
pub(crate) struct ToolPublisher {
    pub(crate) providers: Arc<RwLock<Vec<Value>>>,
    pub(crate) events: broadcast::Sender<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMarker {
    tool_id: String,
    install_path: String,
    version_before: Option<String>,
    started_at: String,
    pid: Option<u32>,
    process_started_at: Option<u64>,
}

enum Plan {
    /// An updater from an earlier session is still running.
    Updating,
    /// An update did not finish cleanly. `install_path` is where it was replacing files.
    Damaged {
        install_path: Option<String>,
        action: Option<ProviderUpdateCommand>,
    },
    Ready,
}

#[derive(Debug, Default)]
struct State {
    snapshots: Vec<Value>,
    running: HashMap<String, u64>,
    update_states: HashMap<String, Value>,
    next_run: u64,
}

struct Inner {
    setup: ToolSetup,
    publisher: ToolPublisher,
    state: Mutex<State>,
    tasks: TaskTracker,
    closed: AtomicBool,
    attribution: OnceLock<ProcessAttributionRegistry>,
    #[cfg(test)]
    fail_spawn: AtomicBool,
    /// Never cancelled: only a server shutdown that outlives its wait stops an updater, and
    /// then process cleanup, not this token, ends it.
    updater_cancellation: CancellationToken,
}

#[derive(Clone)]
pub(crate) struct ToolMaintenance {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for ToolMaintenance {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ToolMaintenance")
            .finish_non_exhaustive()
    }
}

fn tool_error(tool_id: &str, reason: impl Into<String>) -> Value {
    json!({
        "_tag": "ServerToolUpdateError",
        "toolId": tool_id,
        "reason": reason.into(),
    })
}

/// A snapshot without the fields that change on every probe, for "did anything change".
fn stable(snapshot: &Value) -> Value {
    let mut copy = snapshot.clone();
    if let Some(object) = copy.as_object_mut() {
        object.remove("checkedAt");
    }
    if let Some(advisory) = copy
        .get_mut("versionAdvisory")
        .and_then(Value::as_object_mut)
    {
        advisory.remove("checkedAt");
    }
    copy
}

/// The update command's environment: the target's, plus the variables that keep the updater
/// away from agent configuration.
pub(crate) fn update_environment(base: &[(OsString, OsString)]) -> Vec<(OsString, OsString)> {
    let mut environment = normalize_provider_environment(
        base.iter()
            .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
    );
    for (name, value) in UPDATE_ENVIRONMENT {
        environment.retain(|(existing, _)| existing != name);
        environment.push((OsString::from(name), OsString::from(value)));
    }
    environment
}

fn forced(mut update: ProviderUpdateCommand) -> ProviderUpdateCommand {
    if update.lock_key == "codegraph-standalone" {
        update.args.push("--force".to_owned());
        update.display.push_str(" --force");
    }
    update
}

fn update_outcome(before: Option<&str>, after: &Value) -> &'static str {
    let after_version = after["version"].as_str();
    if provider_version_regressed(CODEGRAPH_ID, before, after_version) {
        return "unchanged";
    }
    // A version that rose is a verified finish even when the registry already advertises a
    // newer release than the one the updater installed.
    if provider_version_advanced(CODEGRAPH_ID, before, after_version) {
        return "succeeded";
    }
    match after["versionAdvisory"]["status"].as_str() {
        Some("current") => "succeeded",
        _ => "unchanged",
    }
}

impl ToolMaintenance {
    pub(crate) fn new(setup: ToolSetup, publisher: ToolPublisher) -> Self {
        Self {
            inner: Arc::new(Inner {
                setup,
                publisher,
                state: Mutex::new(State::default()),
                tasks: TaskTracker::new(),
                closed: AtomicBool::new(false),
                #[cfg(test)]
                fail_spawn: AtomicBool::new(false),
                attribution: OnceLock::new(),
                updater_cancellation: CancellationToken::new(),
            }),
        }
    }

    /// Whether a tool update is running; a host with its own stop deadline extends it by
    /// [`TOOL_UPDATE_SHUTDOWN_WAIT`] while this is true.
    pub(crate) fn updates_running(&self) -> bool {
        !self.lock().running.is_empty()
    }

    pub(crate) fn attach_attribution(&self, registry: ProcessAttributionRegistry) {
        let _ = self.inner.attribution.set(registry);
    }

    /// The published tools: the last probe of each, with any update state on top.
    pub(crate) fn snapshots(&self) -> Vec<Value> {
        let state = self.lock();
        Self::overlay(&state)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn overlay(state: &State) -> Vec<Value> {
        state
            .snapshots
            .iter()
            .cloned()
            .map(|mut snapshot| {
                let update_state = snapshot["toolId"]
                    .as_str()
                    .and_then(|id| state.update_states.get(id))
                    .cloned();
                if let Some(update_state) = update_state {
                    snapshot["updateState"] = update_state;
                }
                snapshot
            })
            .collect()
    }

    async fn publish(&self) {
        let tools = self.snapshots();
        let providers = self.inner.publisher.providers.read().await.clone();
        let _ = self.inner.publisher.events.send(json!({
            "version": 1,
            "type": "providerStatuses",
            "payload": { "providers": providers, "tools": tools },
        }));
    }

    fn definition(&self, tool_id: &str) -> Option<&ToolDefinition> {
        self.inner
            .setup
            .definitions
            .iter()
            .find(|definition| definition.id == tool_id)
    }

    fn marker_path(&self, tool_id: &str) -> PathBuf {
        self.inner
            .setup
            .state_dir
            .join("tool-updates")
            .join(format!("{tool_id}.json"))
    }

    /// Re-probes every tool that is not being updated and publishes when something changed.
    pub(crate) async fn refresh(&self, checks_enabled: bool, cwd: &Path) {
        let mut next = Vec::new();
        for definition in &self.inner.setup.definitions {
            if self.lock().running.contains_key(&definition.id) {
                if let Some(previous) = self
                    .lock()
                    .snapshots
                    .iter()
                    .find(|snapshot| snapshot["toolId"] == definition.id.as_str())
                {
                    next.push(previous.clone());
                }
                continue;
            }
            next.push(self.probe(definition, checks_enabled, cwd).await);
        }
        let changed = {
            let mut state = self.lock();
            let changed = state.snapshots.len() != next.len()
                || state
                    .snapshots
                    .iter()
                    .zip(&next)
                    .any(|(left, right)| stable(left) != stable(right));
            // An update that started while probing keeps the snapshot it is working from.
            for snapshot in &mut next {
                if let Some(id) = snapshot["toolId"].as_str()
                    && state.running.contains_key(id)
                    && let Some(current) = state
                        .snapshots
                        .iter()
                        .find(|candidate| candidate["toolId"] == id)
                {
                    *snapshot = current.clone();
                }
            }
            state.snapshots = next;
            changed
        };
        if changed {
            self.publish().await;
        }
    }

    fn read_marker(&self, tool_id: &str) -> Option<Result<UpdateMarker, ()>> {
        let bytes = match std::fs::read(self.marker_path(tool_id)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(_) => return Some(Err(())),
        };
        Some(serde_json::from_slice(&bytes).map_err(|_| ()))
    }

    fn write_marker(&self, marker: &UpdateMarker) -> std::io::Result<()> {
        use std::io::Write;
        let path = self.marker_path(&marker.tool_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("json.tmp");
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(&serde_json::to_vec(marker).map_err(std::io::Error::other)?)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)
    }

    fn restore_marker(&self, tool_id: &str, bytes: &[u8]) {
        use std::io::Write;
        let path = self.marker_path(tool_id);
        let temporary = path.with_extension("json.tmp");
        let written = std::fs::File::create(&temporary).and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        });
        if let Err(error) = written.and_then(|()| std::fs::rename(&temporary, &path)) {
            tracing::warn!(tool = tool_id, %error, "could not restore the tool update marker");
        }
    }

    fn remove_marker(&self, tool_id: &str) {
        if let Err(error) = std::fs::remove_file(self.marker_path(tool_id))
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(tool = tool_id, %error, "could not remove the tool update marker");
        }
    }

    async fn reinstall_action(
        &self,
        definition: &ToolDefinition,
        install_path: &str,
        version: Option<&str>,
    ) -> Option<ProviderUpdateCommand> {
        if !Path::new(install_path).is_file() {
            return None;
        }
        let target = ProviderMaintenanceTarget {
            binary_path: install_path.to_owned(),
            ..definition.target()
        };
        self.inner
            .setup
            .maintenance
            .capabilities(&target)
            .await
            .for_installed_version(&definition.id, version)
            .update
            .map(forced)
    }

    async fn plan(&self, definition: &ToolDefinition, version: Option<&str>) -> Plan {
        let Some(marker) = self.read_marker(&definition.id) else {
            return Plan::Ready;
        };
        let marker = marker.ok();
        let alive = marker
            .as_ref()
            .and_then(|marker| marker.pid.zip(marker.process_started_at))
            .is_some_and(|(pid, started_at)| {
                NativeProcessSampler::process_identity(pid)
                    .is_ok_and(|identity| identity.started_at == started_at)
            });
        if alive {
            return Plan::Updating;
        }
        let resolved = resolve_provider_executable_with_environment(
            &definition.binary_path,
            definition
                .environment
                .iter()
                .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
        )
        .map(|path| path.to_string_lossy().into_owned());
        let install_path = marker
            .as_ref()
            .map(|marker| marker.install_path.clone())
            .or(resolved);
        let action = match install_path.as_deref() {
            Some(path) => self.reinstall_action(definition, path, version).await,
            None => None,
        };
        Plan::Damaged {
            install_path,
            action,
        }
    }

    fn snapshot_of(
        definition: &ToolDefinition,
        installed: bool,
        version: Option<&str>,
        checked_at: &str,
        advisory: Value,
    ) -> Value {
        json!({
            "toolId": definition.id,
            "displayName": definition.display_name,
            "installed": installed,
            "version": version,
            "checkedAt": checked_at,
            "versionAdvisory": advisory,
        })
    }

    /// The tool as installed now, ignoring any update marker.
    async fn probe_installation(
        &self,
        definition: &ToolDefinition,
        checks_enabled: bool,
        cwd: &Path,
    ) -> (Value, Option<String>) {
        let checked_at = now_iso();
        let target = definition.target();
        let resolved = resolve_provider_executable_with_environment(
            &definition.binary_path,
            definition
                .environment
                .iter()
                .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
        );
        let version = match resolved {
            Some(_) => probe_maintenance_target_version(&target, cwd).await,
            None => None,
        };
        let advisory = self
            .inner
            .setup
            .maintenance
            .enrich_advisory(
                &target,
                ProbeFields {
                    enabled: true,
                    installed: resolved.is_some(),
                    version: version.as_deref(),
                    checked_at: Some(&checked_at),
                },
                checks_enabled,
            )
            .await;
        (
            Self::snapshot_of(
                definition,
                resolved.is_some(),
                version.as_deref(),
                &checked_at,
                advisory,
            ),
            version,
        )
    }

    async fn probe(&self, definition: &ToolDefinition, checks_enabled: bool, cwd: &Path) -> Value {
        let (snapshot, version) = self
            .probe_installation(definition, checks_enabled, cwd)
            .await;
        let checked_at = snapshot["checkedAt"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let advisory = |message: &str, command: Option<&ProviderUpdateCommand>| {
            json!({
                "status": "unknown",
                "currentVersion": version,
                "latestVersion": null,
                "updateCommand": command.map(|command| command.display.clone()),
                "canUpdate": command.is_some(),
                "checkedAt": checked_at,
                "message": message,
            })
        };
        match self.plan(definition, version.as_deref()).await {
            Plan::Ready => {
                let mut snapshot = snapshot;
                // An install BiBCode will not touch says so, with the by-hand command.
                if snapshot["installed"] == true
                    && snapshot["versionAdvisory"]["canUpdate"] == false
                    && snapshot["versionAdvisory"]["message"].is_null()
                {
                    snapshot["versionAdvisory"]["message"] = json!(UNKNOWN_INSTALL);
                }
                snapshot
            }
            Plan::Updating => Self::snapshot_of(
                definition,
                true,
                version.as_deref(),
                &checked_at,
                advisory(STILL_UPDATING_MESSAGE, None),
            ),
            Plan::Damaged { action, .. } => {
                let message = if action.is_some() {
                    DAMAGED_MESSAGE.to_owned()
                } else {
                    format!("{DAMAGED_MESSAGE} {MANUAL_REINSTALL}")
                };
                Self::snapshot_of(
                    definition,
                    true,
                    version.as_deref(),
                    &checked_at,
                    advisory(&message, action.as_ref()),
                )
            }
        }
    }

    /// Starts a server-owned update and waits for it. The update keeps running if this call is
    /// dropped (the client disconnected), and keeps `admission` so a maintenance drain names it.
    pub(crate) async fn update(
        &self,
        payload: &Value,
        admission: Option<RpcPermit>,
        cwd: PathBuf,
    ) -> Result<Value, Value> {
        let tool_id = payload
            .get("toolId")
            .and_then(Value::as_str)
            .ok_or_else(|| tool_error("unknown", "toolId must be a valid tool id"))?;
        let definition = self
            .definition(tool_id)
            .ok_or_else(|| tool_error(tool_id, "BiBCode does not maintain this tool."))?
            .clone();
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(tool_error(tool_id, "BiBCode is shutting down."));
        }
        if self.lock().running.contains_key(tool_id) {
            return Err(tool_error(
                tool_id,
                "An update is already running for this tool.",
            ));
        }
        let (action, install_path, version_before) = self.update_action(&definition, &cwd).await?;
        let run = {
            let mut state = self.lock();
            if state.running.contains_key(tool_id) {
                return Err(tool_error(
                    tool_id,
                    "An update is already running for this tool.",
                ));
            }
            state.next_run += 1;
            let run = state.next_run;
            state.running.insert(tool_id.to_owned(), run);
            run
        };
        let (result, outcome) = oneshot::channel();
        let owner = self.clone();
        self.inner.tasks.spawn(async move {
            // Dropped last: the outcome is published before the permit is released, so a
            // maintenance drain names this update until it has settled.
            let _admission = admission;
            owner
                .run_update(definition, action, install_path, version_before, run, cwd)
                .await;
            let _ = result.send(());
        });
        let _ = outcome.await;
        Ok(json!({ "tools": self.snapshots() }))
    }

    async fn update_action(
        &self,
        definition: &ToolDefinition,
        cwd: &Path,
    ) -> Result<(ProviderUpdateCommand, String, Option<String>), Value> {
        let tool_id = definition.id.as_str();
        let resolved = resolve_provider_executable_with_environment(
            &definition.binary_path,
            definition
                .environment
                .iter()
                .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
        );
        let version = match resolved {
            Some(_) => probe_maintenance_target_version(&definition.target(), cwd).await,
            None => None,
        };
        match self.plan(definition, version.as_deref()).await {
            Plan::Updating => Err(tool_error(tool_id, STILL_UPDATING_MESSAGE)),
            Plan::Damaged {
                install_path,
                action,
            } => match (action, install_path) {
                (Some(action), Some(path)) => Ok((action, path, version)),
                _ => Err(tool_error(tool_id, MANUAL_REINSTALL)),
            },
            Plan::Ready => {
                let resolved =
                    resolved.ok_or_else(|| tool_error(tool_id, "CodeGraph is not installed."))?;
                let action = self
                    .inner
                    .setup
                    .maintenance
                    .capabilities(&definition.target())
                    .await
                    .for_installed_version(tool_id, version.as_deref())
                    .update
                    .ok_or_else(|| tool_error(tool_id, UNKNOWN_INSTALL))?;
                Ok((action, resolved.to_string_lossy().into_owned(), version))
            }
        }
    }

    async fn set_update_state(&self, tool_id: &str, state: Value) {
        self.lock().update_states.insert(tool_id.to_owned(), state);
        self.publish().await;
    }

    async fn run_update(
        &self,
        definition: ToolDefinition,
        action: ProviderUpdateCommand,
        install_path: String,
        version_before: Option<String>,
        run: u64,
        cwd: PathBuf,
    ) {
        let tool_id = definition.id.clone();
        let finish = |status: &str, started: &str, message: &str, output: Option<&str>| {
            provider_update_state(status, Some(started), Some(&now_iso()), message, output)
        };
        let started_at = now_iso();
        let lock = self.inner.setup.maintenance.command_lock(action.lock_key);
        let _command_guard = match lock.clone().try_lock_owned() {
            Ok(guard) => guard,
            Err(_) => {
                self.set_update_state(
                    &tool_id,
                    provider_update_state(
                        "queued",
                        None,
                        None,
                        "Waiting for another update to finish.",
                        None,
                    ),
                )
                .await;
                lock.lock_owned().await
            }
        };
        self.set_update_state(
            &tool_id,
            provider_update_state("running", Some(&started_at), None, "Updating tool.", None),
        )
        .await;

        // Kept so a failed start can put back the evidence of an earlier interrupted update.
        let previous_marker = std::fs::read(self.marker_path(&tool_id)).ok();
        // The installation may have changed while this update waited for the command lock: an
        // installer may have replaced it, so the action and its ownership are chosen again.
        let (install_path, version_before, stale) =
            match self.update_action(&definition, &cwd).await {
                Ok((fresh, path, version)) if fresh == action => (path, version, None),
                Ok(_) => (
                    install_path,
                    version_before,
                    Some(CHANGED_WHILE_WAITING.to_owned()),
                ),
                Err(error) => (
                    install_path,
                    version_before,
                    Some(
                        error["reason"]
                            .as_str()
                            .unwrap_or(CHANGED_WHILE_WAITING)
                            .to_owned(),
                    ),
                ),
            };
        let marker = UpdateMarker {
            tool_id: tool_id.clone(),
            install_path,
            version_before: version_before.clone(),
            started_at: started_at.clone(),
            pid: None,
            process_started_at: None,
        };
        let final_state = if let Some(reason) = stale {
            finish("failed", &started_at, &reason, None)
        } else if let Err(error) = self.write_marker(&marker) {
            tracing::warn!(tool = %tool_id, %error, "could not record the tool update");
            finish(
                "failed",
                &started_at,
                "Tool update was not started: BiBCode could not record it.",
                Some(&error.to_string()),
            )
        } else {
            let registration: Arc<Mutex<Option<ProcessRegistration>>> = Arc::default();
            let outcome = self
                .run_command(&definition, &action, &cwd, marker, registration.clone())
                .await;
            drop(
                registration
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take(),
            );
            match outcome {
                Err(SupervisedRunError::Spawn(error)) => {
                    // Nothing ran, so this attempt changed nothing; an earlier interrupted
                    // update's marker stays, because nothing was repaired.
                    match &previous_marker {
                        Some(bytes) => self.restore_marker(&tool_id, bytes),
                        None => self.remove_marker(&tool_id),
                    }
                    finish(
                        "failed",
                        &started_at,
                        "Tool update failed.",
                        Some(&error.to_string()),
                    )
                }
                Err(error) => finish(
                    "failed",
                    &started_at,
                    "Tool update failed.",
                    Some(&format!("{error:?}")),
                ),
                Ok((code, output)) if code != 0 => finish(
                    "failed",
                    &started_at,
                    &format!("Update command exited with code {code}."),
                    output.as_deref(),
                ),
                Ok((_, output)) => {
                    self.inner.setup.maintenance.begin_latest_version_refresh();
                    let (after, _) = self.probe_installation(&definition, true, &cwd).await;
                    let status = update_outcome(version_before.as_deref(), &after);
                    if status == "succeeded" {
                        self.remove_marker(&tool_id);
                    }
                    let message = if status == "succeeded" {
                        "Tool updated.".to_owned()
                    } else {
                        "Update command completed, but BiBCode could not verify the tool version."
                            .to_owned()
                    };
                    finish(status, &started_at, &message, output.as_deref())
                }
            }
        };
        // The next probe reads the marker, so an unverified finish is reported as damaged at once.
        let snapshot = self.probe(&definition, true, &cwd).await;
        {
            let mut state = self.lock();
            state.update_states.insert(tool_id.clone(), final_state);
            if let Some(slot) = state
                .snapshots
                .iter_mut()
                .find(|candidate| candidate["toolId"] == tool_id.as_str())
            {
                *slot = snapshot;
            } else {
                state.snapshots.push(snapshot);
            }
            if state.running.get(&tool_id) == Some(&run) {
                state.running.remove(&tool_id);
            }
        }
        self.publish().await;
    }

    async fn run_command(
        &self,
        definition: &ToolDefinition,
        action: &ProviderUpdateCommand,
        cwd: &Path,
        marker: UpdateMarker,
        registration: Arc<Mutex<Option<ProcessRegistration>>>,
    ) -> Result<(i32, Option<String>), SupervisedRunError> {
        #[cfg(test)]
        if self.inner.fail_spawn.load(Ordering::Acquire) {
            return Err(SupervisedRunError::Spawn(std::io::Error::other(
                "injected spawn failure",
            )));
        }
        let environment = update_environment(&definition.environment);
        let executable = resolve_provider_executable_with_environment(
            &action.executable,
            environment
                .iter()
                .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
        )
        .ok_or_else(|| {
            SupervisedRunError::Spawn(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("Could not resolve update command '{}'.", action.executable),
            ))
        })?;
        let launch = prepare_provider_launch(&executable, &action.args)
            .map_err(|error| SupervisedRunError::Spawn(std::io::Error::other(error)))?;
        let mut command = tokio::process::Command::new(&launch.program);
        command
            .args(&launch.args)
            .current_dir(cwd)
            .envs(environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let attribution = self.inner.attribution.get().cloned();
        let tool_id = definition.id.clone();
        let marker_owner = self.clone();
        let mut marker = marker;
        let output = run_supervised_with_spawn_observer(
            SupervisedRunRequest {
                command,
                stdin: None,
                timeout: UPDATE_TIMEOUT,
                cleanup_timeout: Duration::from_secs(2),
                max_output_bytes: OUTPUT_LIMIT,
                overflow: SupervisedOverflow::Truncate,
            },
            &self.inner.updater_cancellation,
            move |pid| {
                let Some(pid) = pid else { return };
                let Ok(identity) = NativeProcessSampler::process_identity(pid) else {
                    return;
                };
                // A server killed outright can leave this updater running; a restart reads the
                // pid and start time to refuse a reinstall beside it.
                marker.pid = Some(pid);
                marker.process_started_at = Some(identity.started_at);
                if let Err(error) = marker_owner.write_marker(&marker) {
                    tracing::warn!(tool = %tool_id, %error, "could not record the updater process");
                }
                if let Some(attribution) = attribution {
                    match attribution.register_identity(
                        identity,
                        ProcessRegistrationMetadata {
                            scope: AttributionScope::External,
                            kind: AttributionKind::Helper,
                            label: format!("{tool_id} update"),
                            source: RegistrationSource::Helper,
                            driver: None,
                            survives_shutdown: false,
                        },
                    ) {
                        Ok(held) => {
                            *registration
                                .lock()
                                .unwrap_or_else(|error| error.into_inner()) = Some(held);
                        }
                        Err(error) => {
                            tracing::warn!(tool = %tool_id, %error, "could not attribute the updater process");
                        }
                    }
                }
            },
        )
        .await?;
        let text = [output.stderr.bytes, output.stdout.bytes]
            .into_iter()
            .filter(|bytes| !bytes.is_empty())
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .collect::<Vec<_>>()
            .join("\n");
        Ok((
            output.status.code().unwrap_or(-1),
            (!text.is_empty()).then(|| text.chars().take(OUTPUT_LIMIT).collect()),
        ))
    }

    /// Refuses new updates, then waits for a running one. It is never asked to stop: killing
    /// an updater mid-replacement is what damages an install, and the marker covers the rest.
    pub(crate) async fn shutdown(&self) {
        self.inner.closed.store(true, Ordering::Release);
        self.inner.tasks.close();
        if tokio::time::timeout(self.inner.setup.shutdown_wait, self.inner.tasks.wait())
            .await
            .is_err()
        {
            let running = self.lock().running.keys().cloned().collect::<Vec<_>>();
            tracing::warn!(?running, "a tool update was still running at shutdown");
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::{sync::Arc, time::Duration};

    use axum::{Json, Router, extract::State, routing::get};
    use tokio::net::TcpListener;
    use url::Url;

    use super::*;
    use crate::{
        maintenance::{RpcAdmissionGate, RpcMutability},
        test_support::{TestSandbox, executable_fixture},
    };

    const LATEST: &str = "1.6.4";

    struct Fixture {
        sandbox: TestSandbox,
        stub: PathBuf,
        stub_state: PathBuf,
        marker: PathBuf,
        tools: ToolMaintenance,
        events: broadcast::Receiver<Value>,
    }

    impl Fixture {
        fn flag(&self, name: &str) -> PathBuf {
            self.stub_state.join(name)
        }

        fn set(&self, name: &str) {
            std::fs::write(self.flag(name), "x").expect("flag file");
        }

        fn version(&self) -> String {
            std::fs::read_to_string(self.flag("version")).expect("stub version")
        }

        fn tool(&self) -> Value {
            self.tools.snapshots().remove(0)
        }

        async fn update(&self) -> Result<Value, Value> {
            self.tools
                .update(
                    &json!({ "toolId": CODEGRAPH_ID }),
                    None,
                    self.sandbox.root().to_path_buf(),
                )
                .await
        }

        async fn refresh(&self) {
            self.tools.refresh(true, self.sandbox.root()).await;
        }
    }

    async fn registry() -> Url {
        let app =
            Router::new()
                .route(
                    "/{*path}",
                    get(|State(version): State<String>| async move {
                        Json(json!({ "version": version }))
                    }),
                )
                .with_state(LATEST.to_owned());
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("registry");
        let address = listener.local_addr().expect("registry address");
        tokio::spawn(async move { axum::serve(listener, app).await.expect("registry server") });
        Url::parse(&format!("http://{address}/")).expect("registry URL")
    }

    fn write_stub(path: &Path, state: &Path) {
        let state = state.display();
        let script = if cfg!(windows) {
            format!(
                "@echo off\r\nset \"S={state}\"\r\n\
                 if \"%~1\"==\"--version\" goto version\r\n\
                 if \"%~1\"==\"upgrade\" goto upgrade\r\n\
                 exit /b 2\r\n\
                 :version\r\ntype \"%S%\\version\"\r\nexit /b 0\r\n\
                 :upgrade\r\n\
                 echo %CODEGRAPH_NO_PROMPT_HOOK%,%CODEGRAPH_NO_INSTALL_REFRESH% >\"%S%\\env.log\"\r\n\
                 if not \"%CODEGRAPH_NO_PROMPT_HOOK%\"==\"1\" echo x>\"%S%\\agent-config-written\"\r\n\
                 if not \"%CODEGRAPH_NO_INSTALL_REFRESH%\"==\"1\" echo x>\"%S%\\agent-config-written\"\r\n\
                 echo %*>\"%S%\\args.log\"\r\n\
                 echo started>\"%S%\\started\"\r\n\
                 :wait\r\n\
                 if not exist \"%S%\\hold\" goto done\r\n\
                 if exist \"%S%\\release\" goto done\r\n\
                 ping -n 2 127.0.0.1 >nul\r\ngoto wait\r\n\
                 :done\r\n\
                 if exist \"%S%\\fail\" exit /b 1\r\n\
                 copy /y \"%S%\\next\" \"%S%\\version\" >nul\r\nexit /b 0\r\n"
            )
        } else {
            format!(
                "#!/bin/sh\nS='{state}'\n\
                 case \"$1\" in\n\
                 --version) cat \"$S/version\"; exit 0;;\n\
                 upgrade)\n\
                 echo \"$CODEGRAPH_NO_PROMPT_HOOK,$CODEGRAPH_NO_INSTALL_REFRESH\" > \"$S/env.log\"\n\
                 [ \"$CODEGRAPH_NO_PROMPT_HOOK\" = 1 ] || echo x > \"$S/agent-config-written\"\n\
                 [ \"$CODEGRAPH_NO_INSTALL_REFRESH\" = 1 ] || echo x > \"$S/agent-config-written\"\n\
                 echo \"$@\" > \"$S/args.log\"\n\
                 echo started > \"$S/started\"\n\
                 while [ -f \"$S/hold\" ] && [ ! -f \"$S/release\" ]; do sleep 0.1; done\n\
                 [ -f \"$S/fail\" ] && exit 1\n\
                 cp \"$S/next\" \"$S/version\"; exit 0;;\n\
                 esac\nexit 2\n"
            )
        };
        executable_fixture::write_executable(path, script);
    }

    fn stub_name() -> &'static str {
        if cfg!(windows) {
            "codegraph.cmd"
        } else {
            "codegraph"
        }
    }

    fn setup(sandbox: &TestSandbox, binary: &Path, registry: Url, wait: Duration) -> ToolSetup {
        ToolSetup {
            definitions: vec![ToolDefinition {
                binary_path: binary.display().to_string(),
                ..ToolDefinition::codegraph()
            }],
            maintenance: ProviderMaintenance::with_registry_base_url(registry),
            state_dir: sandbox.path("server-state"),
            shutdown_wait: wait,
        }
    }

    async fn fixture(name: &str) -> Fixture {
        fixture_with_wait(name, SHUTDOWN_WAIT).await
    }

    /// A stub `codegraph` in the standalone layout, its state directory and a setup that checks
    /// it against a local registry. Nothing here runs a real tool or touches a real config.
    pub(crate) async fn stub_setup(
        sandbox: &TestSandbox,
        shutdown_wait: Duration,
    ) -> (ToolSetup, PathBuf, PathBuf) {
        let stub_state = sandbox.path("stub-state");
        std::fs::create_dir_all(&stub_state).expect("stub state");
        std::fs::write(stub_state.join("version"), "1.6.2").expect("version");
        std::fs::write(stub_state.join("next"), LATEST).expect("next version");
        let bin = sandbox.path("codegraph/current/bin");
        std::fs::create_dir_all(&bin).expect("stub bin");
        let stub = bin.join(stub_name());
        write_stub(&stub, &stub_state);
        (
            setup(sandbox, &stub, registry().await, shutdown_wait),
            stub,
            stub_state,
        )
    }

    async fn fixture_with_wait(name: &str, shutdown_wait: Duration) -> Fixture {
        let sandbox = TestSandbox::new(name);
        let (setup, stub, stub_state) = stub_setup(&sandbox, shutdown_wait).await;
        let (events, receiver) = broadcast::channel(64);
        let tools = ToolMaintenance::new(
            setup,
            ToolPublisher {
                providers: Arc::new(RwLock::new(Vec::new())),
                events,
            },
        );
        Fixture {
            marker: sandbox.path("server-state/tool-updates/codegraph.json"),
            sandbox,
            stub,
            stub_state,
            tools,
            events: receiver,
        }
    }

    async fn until(what: &str, mut condition: impl FnMut() -> bool) {
        for _ in 0..600 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed out waiting for {what}");
    }

    fn update_status(tool: &Value) -> Option<String> {
        tool["updateState"]["status"].as_str().map(str::to_owned)
    }

    fn message_contains(tool: &Value, text: &str) -> bool {
        tool["versionAdvisory"]["message"]
            .as_str()
            .is_some_and(|message| message.contains(text))
    }

    fn reason_contains(error: &Value, text: &str) -> bool {
        error["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains(text))
    }

    fn spawn_update(
        fixture: &Fixture,
        permit: Option<RpcPermit>,
    ) -> tokio::task::JoinHandle<Result<Value, Value>> {
        let tools = fixture.tools.clone();
        let cwd = fixture.sandbox.root().to_path_buf();
        tokio::spawn(async move {
            tools
                .update(&json!({ "toolId": CODEGRAPH_ID }), permit, cwd)
                .await
        })
    }

    #[tokio::test]
    async fn an_installed_tool_behind_latest_is_offered_a_one_click_update() {
        let fixture = fixture("tool-advisory").await;
        fixture.refresh().await;
        let tool = fixture.tool();
        assert_eq!(tool["toolId"], "codegraph");
        assert_eq!(tool["installed"], true);
        assert_eq!(tool["version"], "1.6.2");
        assert_eq!(tool["versionAdvisory"]["status"], "behind_latest");
        assert_eq!(tool["versionAdvisory"]["latestVersion"], LATEST);
        assert_eq!(tool["versionAdvisory"]["canUpdate"], true);
        assert!(
            tool["versionAdvisory"]["updateCommand"]
                .as_str()
                .is_some_and(|command| command.ends_with(" upgrade"))
        );
    }

    #[tokio::test]
    async fn a_missing_tool_is_reported_as_not_installed_without_a_notice() {
        let fixture = fixture("tool-missing").await;
        std::fs::remove_file(&fixture.stub).expect("remove stub");
        fixture.refresh().await;
        let tool = fixture.tool();
        assert_eq!(tool["installed"], false);
        assert_eq!(tool["versionAdvisory"]["status"], "unknown");
        assert_eq!(tool["versionAdvisory"]["canUpdate"], false);
        let error = fixture.update().await.expect_err("nothing to update");
        assert_eq!(error["_tag"], "ServerToolUpdateError");
    }

    #[tokio::test]
    async fn an_unknown_install_method_is_manual_only_with_a_reason() {
        let fixture = fixture("tool-unknown").await;
        let other = fixture.sandbox.path("elsewhere");
        std::fs::create_dir_all(&other).expect("dir");
        let wrapper = other.join(stub_name());
        write_stub(&wrapper, &fixture.stub_state);
        let tools = ToolMaintenance::new(
            setup(&fixture.sandbox, &wrapper, registry().await, SHUTDOWN_WAIT),
            ToolPublisher {
                providers: Arc::default(),
                events: broadcast::channel(8).0,
            },
        );
        tools.refresh(true, fixture.sandbox.root()).await;
        let tool = tools.snapshots().remove(0);
        assert_eq!(tool["version"], "1.6.2");
        assert_eq!(tool["versionAdvisory"]["canUpdate"], false);
        assert_eq!(tool["versionAdvisory"]["status"], "unknown");
        assert!(message_contains(&tool, "Run `codegraph upgrade` yourself"));
        let error = tools
            .update(
                &json!({ "toolId": CODEGRAPH_ID }),
                None,
                fixture.sandbox.root().to_path_buf(),
            )
            .await
            .expect_err("manual only");
        assert!(reason_contains(&error, "will not update it"));
    }

    #[tokio::test]
    async fn an_update_publishes_progress_and_ends_current_without_touching_agent_config() {
        let mut fixture = fixture("tool-progress").await;
        fixture.refresh().await;
        while fixture.events.try_recv().is_ok() {}
        let result = fixture.update().await.expect("update");
        assert_eq!(result["tools"][0]["updateState"]["status"], "succeeded");
        assert_eq!(result["tools"][0]["version"], LATEST);
        assert_eq!(result["tools"][0]["versionAdvisory"]["status"], "current");
        let mut statuses = Vec::new();
        while let Ok(event) = fixture.events.try_recv() {
            assert_eq!(event["type"], "providerStatuses");
            assert!(event["payload"]["providers"].is_array());
            statuses.extend(update_status(&event["payload"]["tools"][0]));
        }
        assert!(statuses.contains(&"running".to_owned()), "{statuses:?}");
        assert_eq!(statuses.last().map(String::as_str), Some("succeeded"));
        // The updater saw both variables, and one that did not would have written here.
        let environment = std::fs::read_to_string(fixture.flag("env.log")).expect("env log");
        assert_eq!(environment.trim(), "1,1");
        assert!(!fixture.flag("agent-config-written").exists());
        assert!(
            !fixture.marker.exists(),
            "a verified finish clears the marker"
        );
    }

    #[test]
    fn the_update_environment_always_carries_the_agent_config_guards() {
        let environment = update_environment(&[
            (
                OsString::from("CODEGRAPH_NO_PROMPT_HOOK"),
                OsString::from("0"),
            ),
            (OsString::from("KEEP"), OsString::from("yes")),
        ]);
        let value = |name: &str| {
            environment
                .iter()
                .filter(|(key, _)| key == name)
                .map(|(_, value)| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(value("CODEGRAPH_NO_PROMPT_HOOK"), ["1"]);
        assert_eq!(value("CODEGRAPH_NO_INSTALL_REFRESH"), ["1"]);
        assert_eq!(value("KEEP"), ["yes"]);
    }

    #[tokio::test]
    async fn a_disconnected_caller_does_not_stop_the_update_or_its_cleanup() {
        let fixture = fixture("tool-disconnect").await;
        fixture.refresh().await;
        fixture.set("hold");
        let call = spawn_update(&fixture, None);
        until("the updater to start", || fixture.flag("started").exists()).await;
        call.abort();
        let _ = call.await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(fixture.version(), "1.6.2", "the updater has not finished");
        let marker: Value =
            serde_json::from_slice(&std::fs::read(&fixture.marker).expect("marker")).expect("json");
        assert!(marker["pid"].is_u64() && marker["processStartedAt"].is_u64());
        assert_eq!(update_status(&fixture.tool()).as_deref(), Some("running"));
        fixture.set("release");
        until("the update to settle", || {
            update_status(&fixture.tool()).as_deref() == Some("succeeded")
        })
        .await;
        assert_eq!(fixture.version(), LATEST);
        assert!(!fixture.marker.exists());
    }

    #[tokio::test]
    async fn a_second_update_for_the_same_tool_is_refused_while_one_runs() {
        let fixture = fixture("tool-single").await;
        fixture.refresh().await;
        fixture.set("hold");
        let first = spawn_update(&fixture, None);
        until("the updater to start", || fixture.flag("started").exists()).await;
        let refused = fixture.update().await.expect_err("already running");
        assert!(reason_contains(&refused, "already running"));
        fixture.set("release");
        first.await.expect("join").expect("first update");
    }

    #[tokio::test]
    async fn a_maintenance_drain_waits_for_a_detached_update() {
        let fixture = fixture("tool-drain").await;
        fixture.refresh().await;
        fixture.set("hold");
        let gate = RpcAdmissionGate::new();
        let permit = gate
            .admit_named(RpcMutability::Mutation, "server.updateTool")
            .expect("admitted");
        let call = spawn_update(&fixture, Some(permit));
        until("the updater to start", || fixture.flag("started").exists()).await;
        call.abort();
        let _ = call.await;
        let mut drain = tokio::spawn({
            let gate = gate.clone();
            async move {
                gate.close_and_drain(tokio::time::Instant::now() + Duration::from_secs(60))
                    .await
            }
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(500), &mut drain)
                .await
                .is_err(),
            "the drain must wait for the update"
        );
        assert!(
            gate.snapshot()
                .blockers
                .iter()
                .any(|blocker| blocker.operation == "server.updateTool")
        );
        fixture.set("release");
        drain
            .await
            .expect("join")
            .expect("drained once the update settled");
        assert_eq!(update_status(&fixture.tool()).as_deref(), Some("succeeded"));
    }

    #[tokio::test]
    async fn the_updater_is_attributed_while_it_runs_and_released_after() {
        let fixture = fixture("tool-attribution").await;
        let registry = ProcessAttributionRegistry::new();
        fixture.tools.attach_attribution(registry.clone());
        fixture.refresh().await;
        fixture.set("hold");
        let call = spawn_update(&fixture, None);
        until("the updater to start", || fixture.flag("started").exists()).await;
        let sources = registry.registered_sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].1, RegistrationSource::Helper);
        fixture.set("release");
        call.await.expect("join").expect("update");
        assert!(registry.registered_sources().is_empty());
    }

    #[tokio::test]
    async fn shutdown_waits_for_the_stated_budget_without_killing_the_updater() {
        let fixture = fixture_with_wait("tool-shutdown", Duration::from_millis(400)).await;
        fixture.refresh().await;
        fixture.set("hold");
        let call = spawn_update(&fixture, None);
        until("the updater to start", || fixture.flag("started").exists()).await;
        let began = std::time::Instant::now();
        fixture.tools.shutdown().await;
        assert!(began.elapsed() >= Duration::from_millis(350));
        assert_eq!(update_status(&fixture.tool()).as_deref(), Some("running"));
        let refused = fixture.update().await.expect_err("closed");
        assert!(reason_contains(&refused, "shutting down"));
        fixture.set("release");
        call.await
            .expect("join")
            .expect("the updater was left running");
        assert_eq!(fixture.version(), LATEST);
    }

    fn write_marker(fixture: &Fixture, pid: Option<u32>, started: Option<u64>, path: &Path) {
        std::fs::create_dir_all(fixture.marker.parent().expect("parent")).expect("dir");
        std::fs::write(
            &fixture.marker,
            serde_json::to_vec(&json!({
                "toolId": "codegraph",
                "installPath": path.display().to_string(),
                "versionBefore": "1.6.2",
                "startedAt": "2026-11-02T00:00:00Z",
                "pid": pid,
                "processStartedAt": started,
            }))
            .expect("marker json"),
        )
        .expect("marker");
    }

    #[tokio::test]
    async fn a_partial_swap_with_a_healthy_version_probe_is_reported_damaged_and_reinstallable() {
        let fixture = fixture("tool-partial-runtime").await;
        // `--version` reads package.json without loading the runtime, so it still works while
        // runtime files are missing; only the marker says the last update did not finish.
        write_marker(&fixture, None, None, &fixture.stub);
        fixture.refresh().await;
        let tool = fixture.tool();
        assert_eq!(tool["version"], "1.6.2");
        assert!(message_contains(&tool, "may be damaged"));
        assert_eq!(tool["versionAdvisory"]["canUpdate"], true);
        let result = fixture.update().await.expect("reinstall");
        assert_eq!(result["tools"][0]["updateState"]["status"], "succeeded");
        let arguments = std::fs::read_to_string(fixture.flag("args.log")).expect("args");
        assert!(
            arguments.contains("upgrade") && arguments.contains("--force"),
            "{arguments}"
        );
        assert!(!fixture.marker.exists());
        assert_eq!(fixture.tool()["versionAdvisory"]["status"], "current");
    }

    #[tokio::test]
    async fn a_missing_launcher_is_reported_installed_and_damaged_with_manual_steps() {
        let fixture = fixture("tool-partial-launcher").await;
        write_marker(&fixture, None, None, &fixture.stub);
        std::fs::remove_file(&fixture.stub).expect("remove launcher");
        fixture.refresh().await;
        let tool = fixture.tool();
        assert_eq!(
            tool["installed"], true,
            "PATH finding nothing must not hide the damage"
        );
        assert_eq!(tool["versionAdvisory"]["canUpdate"], false);
        assert!(message_contains(
            &tool,
            "Reinstall CodeGraph with its installer"
        ));
        let refused = fixture.update().await.expect_err("manual");
        assert!(reason_contains(&refused, "Reinstall"));
        // Reinstalling by hand and clearing the marker restores the normal notice.
        write_stub(&fixture.stub, &fixture.stub_state);
        std::fs::remove_file(&fixture.marker).expect("marker cleared");
        fixture.refresh().await;
        assert_eq!(fixture.tool()["versionAdvisory"]["status"], "behind_latest");
    }

    #[tokio::test]
    async fn a_version_advance_is_a_verified_finish_even_when_a_newer_release_exists() {
        let fixture = fixture("tool-advance").await;
        // The updater installs 1.6.3 while the registry already advertises 1.6.4.
        std::fs::write(fixture.flag("next"), "1.6.3").expect("next version");
        fixture.refresh().await;
        let result = fixture.update().await.expect("update");
        assert_eq!(result["tools"][0]["updateState"]["status"], "succeeded");
        assert_eq!(fixture.version(), "1.6.3");
        assert!(!fixture.marker.exists(), "an advance clears the marker");
        let tool = fixture.tool();
        assert_eq!(tool["versionAdvisory"]["status"], "behind_latest");
        assert!(!message_contains(&tool, "may be damaged"));
    }

    #[tokio::test]
    async fn a_reinstall_that_cannot_start_keeps_the_interrupted_updates_marker() {
        let fixture = fixture("tool-spawn-failure").await;
        write_marker(&fixture, None, None, &fixture.stub);
        let before = std::fs::read(&fixture.marker).expect("marker");
        fixture
            .tools
            .inner
            .fail_spawn
            .store(true, Ordering::Release);
        let result = fixture.update().await.expect("the call settles");
        assert_eq!(result["tools"][0]["updateState"]["status"], "failed");
        assert_eq!(
            std::fs::read(&fixture.marker).expect("the marker is still there"),
            before
        );
        assert!(message_contains(&fixture.tool(), "may be damaged"));
        // With no earlier marker the same failure leaves nothing behind.
        std::fs::remove_file(&fixture.marker).expect("clear");
        fixture.update().await.expect("the call settles");
        assert!(!fixture.marker.exists());
    }

    #[tokio::test]
    async fn a_queued_update_rechecks_the_install_after_waiting_for_the_command_lock() {
        let fixture = fixture("tool-queued-recheck").await;
        fixture.refresh().await;
        let lock = fixture
            .tools
            .inner
            .setup
            .maintenance
            .command_lock("codegraph-standalone");
        let held = lock.lock_owned().await;
        let call = spawn_update(&fixture, None);
        until("the update to queue", || {
            update_status(&fixture.tool()).as_deref() == Some("queued")
        })
        .await;
        // An installer replaces version 1 with a major BiBCode has not verified.
        std::fs::write(fixture.flag("version"), "2.0.0").expect("new major");
        drop(held);
        let result = call.await.expect("join").expect("the call settles");
        assert_eq!(result["tools"][0]["updateState"]["status"], "failed");
        assert!(!fixture.flag("started").exists(), "the updater never ran");
        assert!(!fixture.marker.exists());
    }

    #[tokio::test]
    async fn a_failed_update_leaves_the_install_flagged_until_a_verified_reinstall() {
        let fixture = fixture("tool-failed").await;
        fixture.refresh().await;
        fixture.set("fail");
        let result = fixture.update().await.expect("the call settles");
        assert_eq!(result["tools"][0]["updateState"]["status"], "failed");
        assert!(fixture.marker.exists());
        assert!(message_contains(&fixture.tool(), "may be damaged"));
        std::fs::remove_file(fixture.flag("fail")).expect("fixed");
        fixture.update().await.expect("reinstall");
        assert!(!fixture.marker.exists());
        assert_eq!(fixture.tool()["versionAdvisory"]["status"], "current");
    }

    #[tokio::test]
    async fn an_updater_that_outlived_a_killed_server_blocks_a_reinstall_until_it_exits() {
        let fixture = fixture("tool-orphan").await;
        // A stand-in for the updater of a server that was killed outright.
        let mut orphan = if cfg!(windows) {
            std::process::Command::new("ping")
                .args(["-n", "60", "127.0.0.1"])
                .stdout(Stdio::null())
                .spawn()
        } else {
            std::process::Command::new("sleep").arg("60").spawn()
        }
        .expect("long-lived child");
        let identity = NativeProcessSampler::process_identity(orphan.id()).expect("identity");
        write_marker(
            &fixture,
            Some(identity.pid),
            Some(identity.started_at),
            &fixture.stub,
        );

        // A restarted server probes the same state directory.
        fixture.refresh().await;
        let tool = fixture.tool();
        assert!(message_contains(&tool, "still being updated"));
        assert_eq!(tool["versionAdvisory"]["canUpdate"], false);
        let refused = fixture.update().await.expect_err("an updater is running");
        assert!(reason_contains(&refused, "still being updated"));

        // A reused pid with another start time is not the updater.
        write_marker(
            &fixture,
            Some(identity.pid),
            Some(identity.started_at + 1),
            &fixture.stub,
        );
        fixture.refresh().await;
        assert!(message_contains(&fixture.tool(), "may be damaged"));
        write_marker(
            &fixture,
            Some(identity.pid),
            Some(identity.started_at),
            &fixture.stub,
        );

        orphan.kill().expect("kill the orphan");
        orphan.wait().expect("reap the orphan");
        fixture.refresh().await;
        let tool = fixture.tool();
        assert!(message_contains(&tool, "may be damaged"));
        assert_eq!(tool["versionAdvisory"]["canUpdate"], true);
        fixture
            .update()
            .await
            .expect("the reinstall is offered once it exits");
        assert_eq!(fixture.tool()["versionAdvisory"]["status"], "current");
    }
}
