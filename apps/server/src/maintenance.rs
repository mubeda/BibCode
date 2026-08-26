use std::{path::Path, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    ServerConfig, ServerMode,
    persistence::{
        BackupTrigger, Database, EnvironmentId, PreparedStore, StatePaths, StorageInstanceId,
        StoreClassification, StoreOperationGuard, create_verified_backup, read_json,
        write_json_atomically,
    },
    production::runtime::ProductionRuntime,
};

pub const MAINTENANCE_UPDATE_PREPARE_PATH: &str = "/api/maintenance/update/prepare";
pub const MAINTENANCE_UPDATE_COMMIT_PATH: &str = "/api/maintenance/update/commit";
pub const MAINTENANCE_UPDATE_CANCEL_PATH: &str = "/api/maintenance/update/cancel";
pub const MAINTENANCE_UPDATE_STATUS_PATH: &str = "/api/maintenance/update/status";
pub const DESKTOP_MAINTENANCE_TOKEN_HEADER: &str = "x-bibcode-desktop-bootstrap-token";

const SHUTDOWN_AFTER_RESPONSE_DELAY: Duration = Duration::from_millis(25);
const UPDATE_STATUS_SCHEMA_VERSION: u16 = 1;
const UPDATE_STATUS_FILE: &str = "server-update.json";
const MAX_UPDATE_VERSION_SCALARS: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RpcMutability {
    Read,
    Mutation,
}

/// Central classification for the typed RPC inventory. Unknown methods fail safe as mutations.
#[must_use]
pub fn rpc_mutability(method: &str) -> RpcMutability {
    match method {
        "activity.getSnapshot"
        | "activity.listDetail"
        | "activity.listRoster"
        | "assets.createUrl"
        | "filesystem.browse"
        | "orchestration.getArchivedShellSnapshot"
        | "orchestration.getFullThreadDiff"
        | "orchestration.getTurnDiff"
        | "orchestration.replayEvents"
        | "orchestration.subscribeShell"
        | "orchestration.subscribeThread"
        | "preview.list"
        | "projects.listEntries"
        | "projects.readFile"
        | "projects.searchEntries"
        | "review.getDiffPreview"
        | "server.discoverSourceControl"
        | "server.getConfig"
        | "server.getProcessDiagnostics"
        | "server.getProcessResourceHistory"
        | "server.getProviderUsage"
        | "server.getSettings"
        | "server.getTraceDiagnostics"
        | "sourceControl.lookupRepository"
        | "subscribeActivity"
        | "subscribeAuthAccess"
        | "subscribeDiscoveredLocalServers"
        | "subscribeProjectEntries"
        | "subscribePreviewEvents"
        | "subscribeServerConfig"
        | "subscribeServerLifecycle"
        | "subscribeTerminalEvents"
        | "subscribeTerminalMetadata"
        | "subscribeVcsStatus"
        | "subscribeVcsStatusSummary"
        | "vcs.listCommits"
        | "vcs.listRefs"
        | "vcs.refreshStatus" => RpcMutability::Read,
        _ => RpcMutability::Mutation,
    }
}

/// Central HTTP classification. Maintenance controls and shutdown bypass mutation admission.
#[must_use]
pub fn http_mutability(method: &str, path: &str) -> RpcMutability {
    if matches!(
        path,
        MAINTENANCE_UPDATE_PREPARE_PATH
            | MAINTENANCE_UPDATE_COMMIT_PATH
            | MAINTENANCE_UPDATE_CANCEL_PATH
            | MAINTENANCE_UPDATE_STATUS_PATH
            | crate::DESKTOP_SHUTDOWN_PATH
    ) {
        return RpcMutability::Read;
    }
    match method {
        "GET" | "HEAD" | "OPTIONS" => RpcMutability::Read,
        _ => RpcMutability::Mutation,
    }
}

#[derive(Debug, Error)]
pub enum MaintenanceError {
    #[error("persistent mutations are closed for desktop update maintenance")]
    AdmissionClosed,
    #[error("timed out while draining {in_flight} admitted mutations")]
    DrainTimeout { in_flight: u64 },
    #[error("update preparation failed: {0}")]
    Preparation(String),
    #[error("the update maintenance operation does not match the active operation")]
    OperationMismatch,
    #[error("no prepared update maintenance operation is active")]
    NoPreparedOperation,
}

#[derive(Clone)]
pub struct RpcAdmissionGate {
    inner: Arc<AdmissionInner>,
}

struct AdmissionInner {
    state: std::sync::Mutex<AdmissionState>,
    drained: Notify,
}

#[derive(Debug)]
struct AdmissionState {
    closed: bool,
    in_flight: u64,
    drain_count: u64,
}

impl Default for RpcAdmissionGate {
    fn default() -> Self {
        Self::new()
    }
}

impl RpcAdmissionGate {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AdmissionInner {
                state: std::sync::Mutex::new(AdmissionState {
                    closed: false,
                    in_flight: 0,
                    drain_count: 0,
                }),
                drained: Notify::new(),
            }),
        }
    }

    pub fn admit(&self, mutability: RpcMutability) -> Result<RpcPermit, MaintenanceError> {
        if mutability == RpcMutability::Read {
            return Ok(RpcPermit { _lease: None });
        }
        let mut state = self
            .inner
            .state
            .lock()
            .expect("RPC admission mutex poisoned");
        if state.closed {
            return Err(MaintenanceError::AdmissionClosed);
        }
        state.in_flight = state.in_flight.saturating_add(1);
        Ok(RpcPermit {
            _lease: Some(Arc::new(RpcPermitLease { gate: self.clone() })),
        })
    }

    pub async fn close_and_drain(&self, deadline: Instant) -> Result<u64, MaintenanceError> {
        {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("RPC admission mutex poisoned");
            if !state.closed {
                state.closed = true;
                state.drain_count = state.in_flight;
            }
        }
        loop {
            let notified = self.inner.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let (in_flight, drain_count) = {
                let state = self
                    .inner
                    .state
                    .lock()
                    .expect("RPC admission mutex poisoned");
                (state.in_flight, state.drain_count)
            };
            if in_flight == 0 {
                return Ok(drain_count);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(MaintenanceError::DrainTimeout { in_flight });
            }
        }
    }

    pub fn release(&self) -> Result<(), MaintenanceError> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("RPC admission mutex poisoned");
        state.closed = false;
        state.drain_count = 0;
        Ok(())
    }

    fn permit_released(&self) {
        let notify = {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("RPC admission mutex poisoned");
            debug_assert!(state.in_flight > 0);
            state.in_flight = state.in_flight.saturating_sub(1);
            state.in_flight == 0
        };
        if notify {
            self.inner.drained.notify_waiters();
        }
    }
}

#[derive(Clone)]
pub struct RpcPermit {
    _lease: Option<Arc<RpcPermitLease>>,
}

struct RpcPermitLease {
    gate: RpcAdmissionGate,
}

impl Drop for RpcPermitLease {
    fn drop(&mut self) {
        self.gate.permit_released();
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrepareForUpdateResult {
    pub operation_id: String,
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub backup_id: String,
    pub drained_operations: u64,
    pub expires_at: String,
    pub current_version: String,
    pub target_version: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PersistedUpdatePhase {
    Preparing,
    Prepared,
    Restarting,
    Succeeded,
    Failed,
    Cancelled,
    Expired,
    RecoveryRequired,
}

impl PersistedUpdatePhase {
    const fn wire_name(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Prepared => "prepared",
            Self::Restarting => "restarting",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
            Self::RecoveryRequired => "recoveryRequired",
        }
    }

    const fn terminal_result(self) -> Option<&'static str> {
        match self {
            Self::Succeeded => Some("succeeded"),
            Self::Failed | Self::RecoveryRequired => Some("failed"),
            Self::Cancelled => Some("cancelled"),
            Self::Expired => Some("expired"),
            Self::Preparing | Self::Prepared | Self::Restarting => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedUpdateStatus {
    schema_version: u16,
    phase: PersistedUpdatePhase,
    operation_id: String,
    environment_id: EnvironmentId,
    storage_instance_id: StorageInstanceId,
    source_version: String,
    target_version: Option<String>,
    backup_id: Option<String>,
    updated_at: String,
    message: Option<String>,
}

#[derive(Clone, Debug)]
enum UpdatePhase {
    Idle,
    Preparing {
        operation_id: Uuid,
        target_version: Option<String>,
    },
    Prepared {
        result: PrepareForUpdateResult,
        target_version: Option<String>,
    },
    Committed(Uuid),
    Cancelled(Uuid),
    Failed,
    Expired(Uuid),
}

fn update_status_path(state_directory: &Path) -> std::path::PathBuf {
    state_directory.join(UPDATE_STATUS_FILE)
}

fn now_rfc3339() -> Result<String, MaintenanceError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| MaintenanceError::Preparation(error.to_string()))
}

fn validate_target_version(
    target_version: Option<String>,
) -> Result<Option<String>, MaintenanceError> {
    let Some(target_version) = target_version else {
        return Ok(None);
    };
    let target_version = target_version.trim().to_owned();
    if target_version.is_empty()
        || target_version.chars().count() > MAX_UPDATE_VERSION_SCALARS
        || target_version.chars().any(char::is_control)
    {
        return Err(MaintenanceError::Preparation(
            "the target version is invalid".to_owned(),
        ));
    }
    Ok(Some(target_version))
}

pub(crate) async fn reconcile_update_status(
    paths: &StatePaths,
    environment_id: EnvironmentId,
    storage_instance_id: StorageInstanceId,
    current_version: &str,
) -> Result<(), MaintenanceError> {
    let path = update_status_path(&paths.state_dir);
    let Some(mut status) = read_json::<PersistedUpdateStatus>(&path)
        .await
        .map_err(|error| MaintenanceError::Preparation(error.to_string()))?
    else {
        return Ok(());
    };
    if status.schema_version != UPDATE_STATUS_SCHEMA_VERSION {
        return Err(MaintenanceError::Preparation(
            "the persisted update status version is unsupported".to_owned(),
        ));
    }
    let identity_matches = status.environment_id == environment_id
        && status.storage_instance_id == storage_instance_id;
    let target_matches = status
        .target_version
        .as_deref()
        .is_none_or(|target| target == current_version);
    let reconciliation = if !identity_matches {
        Some((
            PersistedUpdatePhase::RecoveryRequired,
            "The restarted server identity differs from the prepared update environment.",
        ))
    } else {
        match status.phase {
            PersistedUpdatePhase::Restarting if target_matches => Some((
                PersistedUpdatePhase::Succeeded,
                "The restarted server preserved identity and reached the expected version.",
            )),
            PersistedUpdatePhase::Restarting => Some((
                PersistedUpdatePhase::RecoveryRequired,
                "The restarted server did not reach the expected version.",
            )),
            PersistedUpdatePhase::Preparing | PersistedUpdatePhase::Prepared => Some((
                PersistedUpdatePhase::RecoveryRequired,
                "The update handoff was interrupted before a verified restart.",
            )),
            PersistedUpdatePhase::Succeeded
            | PersistedUpdatePhase::Failed
            | PersistedUpdatePhase::Cancelled
            | PersistedUpdatePhase::Expired
            | PersistedUpdatePhase::RecoveryRequired => None,
        }
    };
    if let Some((phase, message)) = reconciliation {
        status.phase = phase;
        status.updated_at = now_rfc3339()?;
        status.message = Some(message.to_owned());
        write_json_atomically(path, &status)
            .await
            .map_err(|error| MaintenanceError::Preparation(error.to_string()))?;
    }
    Ok(())
}

pub(crate) async fn update_view(state_directory: &Path, current_version: &str) -> Value {
    let status = read_json::<PersistedUpdateStatus>(update_status_path(state_directory)).await;
    let Ok(Some(status)) = status else {
        if status.is_err() {
            let at = OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned());
            return json!({
                "phase": "failed",
                "currentVersion": current_version,
                "targetVersion": null,
                "lastResult": {
                    "status": "failed",
                    "at": at,
                    "message": "The local update status could not be read safely.",
                },
            });
        }
        return json!({
            "phase": "idle",
            "currentVersion": current_version,
            "targetVersion": null,
            "lastResult": null,
        });
    };
    let last_result = status.phase.terminal_result().map(|result| {
        json!({
            "status": result,
            "at": status.updated_at,
            "message": status.message,
        })
    });
    json!({
        "phase": status.phase.wire_name(),
        "currentVersion": current_version,
        "targetVersion": status.target_version,
        "lastResult": last_result,
    })
}

pub struct UpdateMaintenance {
    admission: RpcAdmissionGate,
    state: Mutex<UpdatePhase>,
    changed: Notify,
    runtime: Arc<ProductionRuntime>,
    database: Database,
    paths: StatePaths,
    environment_id: EnvironmentId,
    storage_instance_id: StorageInstanceId,
    classification: StoreClassification,
    app_version: String,
    shutdown: CancellationToken,
    drain_timeout: Duration,
    lease: Duration,
}

impl UpdateMaintenance {
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub(crate) fn new(
        admission: RpcAdmissionGate,
        runtime: Arc<ProductionRuntime>,
        database: Database,
        paths: StatePaths,
        environment_id: EnvironmentId,
        storage_instance_id: StorageInstanceId,
        classification: StoreClassification,
        app_version: String,
        shutdown: CancellationToken,
        drain_timeout: Duration,
        lease: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            admission,
            state: Mutex::new(UpdatePhase::Idle),
            changed: Notify::new(),
            runtime,
            database,
            paths,
            environment_id,
            storage_instance_id,
            classification,
            app_version,
            shutdown,
            drain_timeout,
            lease,
        })
    }

    async fn persist_status(
        &self,
        phase: PersistedUpdatePhase,
        operation_id: Uuid,
        target_version: Option<String>,
        backup_id: Option<String>,
        message: Option<String>,
    ) -> Result<(), MaintenanceError> {
        let status = PersistedUpdateStatus {
            schema_version: UPDATE_STATUS_SCHEMA_VERSION,
            phase,
            operation_id: operation_id.to_string(),
            environment_id: self.environment_id,
            storage_instance_id: self.storage_instance_id,
            source_version: self.app_version.clone(),
            target_version,
            backup_id,
            updated_at: now_rfc3339()?,
            message,
        };
        write_json_atomically(update_status_path(&self.paths.state_dir), &status)
            .await
            .map_err(|error| MaintenanceError::Preparation(error.to_string()))
    }

    pub async fn prepare(
        self: &Arc<Self>,
        target_version: Option<String>,
    ) -> Result<PrepareForUpdateResult, MaintenanceError> {
        let target_version = validate_target_version(target_version)?;
        let operation_id = loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let mut state = self.state.lock().await;
            match &*state {
                UpdatePhase::Prepared {
                    result,
                    target_version: prepared_target,
                } if prepared_target == &target_version => return Ok(result.clone()),
                UpdatePhase::Prepared { .. } => return Err(MaintenanceError::OperationMismatch),
                UpdatePhase::Preparing {
                    target_version: preparing_target,
                    ..
                } if preparing_target != &target_version => {
                    return Err(MaintenanceError::OperationMismatch);
                }
                UpdatePhase::Preparing { .. } => {
                    drop(state);
                    notified.await;
                }
                UpdatePhase::Idle => {
                    let operation_id = Uuid::new_v4();
                    *state = UpdatePhase::Preparing {
                        operation_id,
                        target_version: target_version.clone(),
                    };
                    break operation_id;
                }
                UpdatePhase::Committed(_)
                | UpdatePhase::Cancelled(_)
                | UpdatePhase::Failed
                | UpdatePhase::Expired(_) => return Err(MaintenanceError::NoPreparedOperation),
            }
        };

        if let Err(error) = self
            .persist_status(
                PersistedUpdatePhase::Preparing,
                operation_id,
                target_version.clone(),
                None,
                None,
            )
            .await
        {
            *self.state.lock().await = UpdatePhase::Failed;
            self.changed.notify_waiters();
            return Err(error);
        }

        let prepared = self
            .prepare_once(operation_id, target_version.clone())
            .await;
        match prepared {
            Ok(result) => {
                if let Err(error) = self
                    .persist_status(
                        PersistedUpdatePhase::Prepared,
                        operation_id,
                        target_version.clone(),
                        Some(result.backup_id.clone()),
                        None,
                    )
                    .await
                {
                    *self.state.lock().await = UpdatePhase::Failed;
                    self.changed.notify_waiters();
                    self.shutdown.cancel();
                    return Err(error);
                }
                *self.state.lock().await = UpdatePhase::Prepared {
                    result: result.clone(),
                    target_version,
                };
                self.changed.notify_waiters();
                self.spawn_lease_expiry(operation_id);
                Ok(result)
            }
            Err(error) => {
                let _ = self
                    .persist_status(
                        PersistedUpdatePhase::Failed,
                        operation_id,
                        target_version,
                        None,
                        Some("Update preparation failed before a safe handoff.".to_owned()),
                    )
                    .await;
                *self.state.lock().await = UpdatePhase::Failed;
                self.changed.notify_waiters();
                self.shutdown.cancel();
                Err(error)
            }
        }
    }

    async fn prepare_once(
        &self,
        operation_id: Uuid,
        target_version: Option<String>,
    ) -> Result<PrepareForUpdateResult, MaintenanceError> {
        let deadline = Instant::now()
            .checked_add(self.drain_timeout)
            .ok_or_else(|| MaintenanceError::Preparation("deadline overflow".to_owned()))?;
        let drained_operations = self.admission.close_and_drain(deadline).await?;
        tokio::time::timeout_at(deadline, self.runtime.quiesce_for_update())
            .await
            .map_err(|_| MaintenanceError::Preparation("runtime quiesce timed out".to_owned()))?
            .map_err(MaintenanceError::Preparation)?;

        let cancellation = CancellationToken::new();
        let remaining = deadline.saturating_duration_since(Instant::now());
        let _operation_guard =
            StoreOperationGuard::acquire(&self.paths.base_dir, cancellation.clone(), remaining)
                .await
                .map_err(|error| MaintenanceError::Preparation(error.to_string()))?;
        self.database
            .checkpoint_wal()
            .await
            .map_err(|error| MaintenanceError::Preparation(error.to_string()))?;
        let context = PreparedStore {
            database: self.database.clone(),
            environment_id: self.environment_id,
            storage_instance_id: self.storage_instance_id,
            classification: self.classification,
            paths: self.paths.clone(),
        };
        let backup = tokio::time::timeout_at(
            deadline,
            create_verified_backup(
                &self.database,
                &context,
                BackupTrigger::PreUpdate,
                &self.app_version,
            ),
        )
        .await
        .map_err(|_| MaintenanceError::Preparation("verified backup timed out".to_owned()))?
        .map_err(|error| MaintenanceError::Preparation(error.to_string()))?;
        let expires_at = (OffsetDateTime::now_utc()
            + time::Duration::try_from(self.lease)
                .map_err(|error| MaintenanceError::Preparation(error.to_string()))?)
        .format(&Rfc3339)
        .map_err(|error| MaintenanceError::Preparation(error.to_string()))?;
        Ok(PrepareForUpdateResult {
            operation_id: operation_id.to_string(),
            environment_id: self.environment_id,
            storage_instance_id: self.storage_instance_id,
            backup_id: backup.manifest.backup_id.to_string(),
            drained_operations,
            expires_at,
            current_version: self.app_version.clone(),
            target_version,
        })
    }

    fn spawn_lease_expiry(self: &Arc<Self>, operation_id: Uuid) {
        let maintenance = Arc::downgrade(self);
        let lease = self.lease;
        tokio::spawn(async move {
            tokio::time::sleep(lease).await;
            let Some(maintenance) = maintenance.upgrade() else {
                return;
            };
            let mut state = maintenance.state.lock().await;
            let prepared = match &*state {
                UpdatePhase::Prepared {
                    result,
                    target_version,
                } if result.operation_id == operation_id.to_string() => {
                    Some((target_version.clone(), Some(result.backup_id.clone())))
                }
                _ => None,
            };
            if let Some((target_version, backup_id)) = prepared {
                *state = UpdatePhase::Expired(operation_id);
                drop(state);
                if let Err(error) = maintenance
                    .persist_status(
                        PersistedUpdatePhase::Expired,
                        operation_id,
                        target_version,
                        backup_id,
                        Some("The prepared update lease expired before restart.".to_owned()),
                    )
                    .await
                {
                    tracing::warn!(%error, "failed to persist expired update status");
                }
                maintenance.changed.notify_waiters();
                maintenance.shutdown.cancel();
            }
        });
    }

    pub async fn commit(&self, operation_id: Uuid) -> Result<(), MaintenanceError> {
        let mut state = self.state.lock().await;
        match &*state {
            UpdatePhase::Prepared {
                result,
                target_version,
            } if result.operation_id == operation_id.to_string() => {
                self.persist_status(
                    PersistedUpdatePhase::Restarting,
                    operation_id,
                    target_version.clone(),
                    Some(result.backup_id.clone()),
                    None,
                )
                .await?;
                *state = UpdatePhase::Committed(operation_id);
                Ok(())
            }
            UpdatePhase::Prepared { .. } => Err(MaintenanceError::OperationMismatch),
            _ => Err(MaintenanceError::NoPreparedOperation),
        }
    }

    pub async fn cancel(&self, operation_id: Uuid) -> Result<(), MaintenanceError> {
        let mut state = self.state.lock().await;
        match &*state {
            UpdatePhase::Prepared {
                result,
                target_version,
            } if result.operation_id == operation_id.to_string() => {
                self.persist_status(
                    PersistedUpdatePhase::Cancelled,
                    operation_id,
                    target_version.clone(),
                    Some(result.backup_id.clone()),
                    Some("The prepared update was cancelled by its host authority.".to_owned()),
                )
                .await?;
                *state = UpdatePhase::Cancelled(operation_id);
                Ok(())
            }
            UpdatePhase::Prepared { .. } => Err(MaintenanceError::OperationMismatch),
            _ => Err(MaintenanceError::NoPreparedOperation),
        }
    }

    pub fn shutdown_after_response(&self) {
        let shutdown = self.shutdown.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SHUTDOWN_AFTER_RESPONSE_DELAY).await;
            shutdown.cancel();
        });
    }

    pub async fn status(&self) -> Value {
        let mut view = update_view(&self.paths.state_dir, &self.app_version).await;
        match &*self.state.lock().await {
            UpdatePhase::Idle | UpdatePhase::Failed => {
                view["result"] = Value::Null;
            }
            UpdatePhase::Preparing { operation_id, .. }
            | UpdatePhase::Committed(operation_id)
            | UpdatePhase::Cancelled(operation_id)
            | UpdatePhase::Expired(operation_id) => {
                view["operationId"] = json!(operation_id.to_string());
                view["result"] = Value::Null;
            }
            UpdatePhase::Prepared { result, .. } => {
                view["result"] = json!(result);
            }
        }
        view
    }
}

#[must_use]
pub(crate) fn maintenance_routes_enabled(config: &ServerConfig) -> bool {
    if config.mode != ServerMode::Desktop || config.desktop_bootstrap_token.is_none() {
        return false;
    }
    config
        .host
        .parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback())
        || config.host.eq_ignore_ascii_case("localhost")
}
