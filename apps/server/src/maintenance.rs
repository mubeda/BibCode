use std::{sync::Arc, time::Duration};

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
        BackupTrigger, Database, PreparedStore, StatePaths, StorageInstanceId, StoreClassification,
        StoreOperationGuard, create_verified_backup,
    },
    production::runtime::ProductionRuntime,
};

pub const MAINTENANCE_UPDATE_PREPARE_PATH: &str = "/api/maintenance/update/prepare";
pub const MAINTENANCE_UPDATE_COMMIT_PATH: &str = "/api/maintenance/update/commit";
pub const MAINTENANCE_UPDATE_CANCEL_PATH: &str = "/api/maintenance/update/cancel";
pub const MAINTENANCE_UPDATE_STATUS_PATH: &str = "/api/maintenance/update/status";
pub const DESKTOP_MAINTENANCE_TOKEN_HEADER: &str = "x-bibcode-desktop-bootstrap-token";

const SHUTDOWN_AFTER_RESPONSE_DELAY: Duration = Duration::from_millis(25);

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
        | "cloud.getRelayClientStatus"
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
        | "subscribePreviewEvents"
        | "subscribeServerConfig"
        | "subscribeServerLifecycle"
        | "subscribeTerminalEvents"
        | "subscribeTerminalMetadata"
        | "subscribeVcsStatus"
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
            return Ok(RpcPermit { gate: None });
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
            gate: Some(self.clone()),
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

pub struct RpcPermit {
    gate: Option<RpcAdmissionGate>,
}

impl Drop for RpcPermit {
    fn drop(&mut self) {
        if let Some(gate) = self.gate.take() {
            gate.permit_released();
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrepareForUpdateResult {
    pub operation_id: String,
    pub storage_instance_id: StorageInstanceId,
    pub backup_id: String,
    pub drained_operations: u64,
    pub expires_at: String,
}

#[derive(Clone, Debug)]
enum UpdatePhase {
    Idle,
    Preparing(Uuid),
    Prepared(PrepareForUpdateResult),
    Committed(Uuid),
    Cancelled(Uuid),
    Failed,
    Expired(Uuid),
}

pub struct UpdateMaintenance {
    admission: RpcAdmissionGate,
    state: Mutex<UpdatePhase>,
    changed: Notify,
    runtime: Arc<ProductionRuntime>,
    database: Database,
    paths: StatePaths,
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
            storage_instance_id,
            classification,
            app_version,
            shutdown,
            drain_timeout,
            lease,
        })
    }

    pub async fn prepare(self: &Arc<Self>) -> Result<PrepareForUpdateResult, MaintenanceError> {
        let operation_id = loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let mut state = self.state.lock().await;
            match &*state {
                UpdatePhase::Prepared(result) => return Ok(result.clone()),
                UpdatePhase::Preparing(_) => {
                    drop(state);
                    notified.await;
                }
                UpdatePhase::Idle => {
                    let operation_id = Uuid::new_v4();
                    *state = UpdatePhase::Preparing(operation_id);
                    break operation_id;
                }
                UpdatePhase::Committed(_)
                | UpdatePhase::Cancelled(_)
                | UpdatePhase::Failed
                | UpdatePhase::Expired(_) => return Err(MaintenanceError::NoPreparedOperation),
            }
        };

        let prepared = self.prepare_once(operation_id).await;
        match prepared {
            Ok(result) => {
                *self.state.lock().await = UpdatePhase::Prepared(result.clone());
                self.changed.notify_waiters();
                self.spawn_lease_expiry(operation_id);
                Ok(result)
            }
            Err(error) => {
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
            storage_instance_id: self.storage_instance_id,
            backup_id: backup.manifest.backup_id.to_string(),
            drained_operations,
            expires_at,
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
            if matches!(&*state, UpdatePhase::Prepared(result) if result.operation_id == operation_id.to_string())
            {
                *state = UpdatePhase::Expired(operation_id);
                drop(state);
                maintenance.changed.notify_waiters();
                maintenance.shutdown.cancel();
            }
        });
    }

    pub async fn commit(&self, operation_id: Uuid) -> Result<(), MaintenanceError> {
        let mut state = self.state.lock().await;
        match &*state {
            UpdatePhase::Prepared(result) if result.operation_id == operation_id.to_string() => {
                *state = UpdatePhase::Committed(operation_id);
                Ok(())
            }
            UpdatePhase::Prepared(_) => Err(MaintenanceError::OperationMismatch),
            _ => Err(MaintenanceError::NoPreparedOperation),
        }
    }

    pub async fn cancel(&self, operation_id: Uuid) -> Result<(), MaintenanceError> {
        let mut state = self.state.lock().await;
        match &*state {
            UpdatePhase::Prepared(result) if result.operation_id == operation_id.to_string() => {
                *state = UpdatePhase::Cancelled(operation_id);
                Ok(())
            }
            UpdatePhase::Prepared(_) => Err(MaintenanceError::OperationMismatch),
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
        match &*self.state.lock().await {
            UpdatePhase::Idle => json!({"phase":"idle","result":null}),
            UpdatePhase::Preparing(operation_id) => {
                json!({"phase":"preparing","operationId":operation_id.to_string(),"result":null})
            }
            UpdatePhase::Prepared(result) => json!({"phase":"prepared","result":result}),
            UpdatePhase::Committed(operation_id) => {
                json!({"phase":"committed","operationId":operation_id.to_string(),"result":null})
            }
            UpdatePhase::Cancelled(operation_id) => {
                json!({"phase":"cancelled","operationId":operation_id.to_string(),"result":null})
            }
            UpdatePhase::Failed => json!({"phase":"failed","result":null}),
            UpdatePhase::Expired(operation_id) => {
                json!({"phase":"expired","operationId":operation_id.to_string(),"result":null})
            }
        }
    }
}

#[must_use]
pub(crate) fn maintenance_routes_enabled(config: &ServerConfig) -> bool {
    if config.mode != ServerMode::Desktop || config.desktop_bootstrap_token.is_none() {
        return false;
    }
    let local_bind = config
        .host
        .parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback())
        || config.host.eq_ignore_ascii_case("localhost");
    let desktop_owned_wsl_bind =
        config.desktop_wsl_transport && matches!(config.host.as_str(), "0.0.0.0" | "::");
    local_bind || desktop_owned_wsl_bind
}
