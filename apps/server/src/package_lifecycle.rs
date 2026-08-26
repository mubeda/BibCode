//! Durable coordination between native package managers and the server lifecycle.
//!
//! The package manager owns replacement and restoration of signed package bytes. This
//! module owns the identity-bound receipt that prevents a retry, another installer, or a
//! different data root from continuing an in-flight transaction.

use std::{
    path::{Component, Path, PathBuf},
    result::Result as StdResult,
    time::Duration as StdDuration,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    ServerConfig,
    persistence::{
        BackupError, Database, EnvironmentId, PersistenceError, RecoveryError, StateFileError,
        StatePaths, StorageInstanceId, StoreOfflineGuard, StoreOperationGuard, read_json,
        write_json_atomically,
    },
    service::ServiceMode,
};

pub const PACKAGE_LIFECYCLE_SCHEMA_VERSION: u16 = 1;
pub const PURGE_PLAN_SCHEMA_VERSION: u16 = 1;
const PACKAGE_LIFECYCLE_RECEIPT_FILE: &str = "package-lifecycle.json";
const PURGE_PLAN_FILE: &str = "purge-plan.json";
const PURGE_AUTHORIZATION_FILE: &str = "purge-authorization.json";
const MAX_PURGE_PLAN_LIFETIME: Duration = Duration::minutes(10);
const PURGE_LOCK_TIMEOUT: StdDuration = StdDuration::from_secs(15);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageLifecyclePhase {
    Prepared,
    ServiceStopped,
    FilesCommitted,
    ServiceStarted,
    Verified,
    RolledBack,
}

impl PackageLifecyclePhase {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Verified | Self::RolledBack)
    }

    fn can_advance_to(self, next: Self) -> bool {
        self == next
            || matches!(
                (self, next),
                (Self::Prepared, Self::ServiceStopped)
                    | (Self::ServiceStopped, Self::FilesCommitted)
                    | (Self::FilesCommitted, Self::ServiceStarted)
                    | (Self::ServiceStarted, Self::Verified)
            )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackagePrepareInput {
    pub nonce: String,
    pub operation_id: Uuid,
    pub source_version: String,
    pub target_version: String,
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub data_root: PathBuf,
    pub prior_binary_path: PathBuf,
    pub prior_binary_sha256: String,
    pub service_mode: ServiceMode,
    pub service_owner: String,
    pub backup_id: Uuid,
    pub backup_schema_version: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageLifecycleReceipt {
    pub schema_version: u16,
    #[serde(with = "uuid_string")]
    pub operation_id: Uuid,
    pub nonce_sha256: String,
    pub source_version: String,
    pub target_version: String,
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub data_root: PathBuf,
    pub prior_binary_path: PathBuf,
    pub prior_binary_sha256: String,
    pub service_mode: ServiceMode,
    pub service_owner: String,
    #[serde(with = "uuid_string")]
    pub backup_id: Uuid,
    pub backup_schema_version: i64,
    pub phase: PackageLifecyclePhase,
    pub updated_at: String,
}

impl PackageLifecycleReceipt {
    fn from_prepare(input: &PackagePrepareInput) -> Result<Self> {
        validate_prepare_input(input)?;
        Ok(Self {
            schema_version: PACKAGE_LIFECYCLE_SCHEMA_VERSION,
            operation_id: input.operation_id,
            nonce_sha256: hash_nonce(&input.nonce),
            source_version: input.source_version.clone(),
            target_version: input.target_version.clone(),
            environment_id: input.environment_id,
            storage_instance_id: input.storage_instance_id,
            data_root: input.data_root.clone(),
            prior_binary_path: input.prior_binary_path.clone(),
            prior_binary_sha256: input.prior_binary_sha256.clone(),
            service_mode: input.service_mode,
            service_owner: input.service_owner.clone(),
            backup_id: input.backup_id,
            backup_schema_version: input.backup_schema_version,
            phase: PackageLifecyclePhase::Prepared,
            updated_at: now_rfc3339()?,
        })
    }

    fn matches_prepare(&self, input: &PackagePrepareInput) -> bool {
        self.schema_version == PACKAGE_LIFECYCLE_SCHEMA_VERSION
            && self.operation_id == input.operation_id
            && self.nonce_sha256 == hash_nonce(&input.nonce)
            && self.source_version == input.source_version
            && self.target_version == input.target_version
            && self.environment_id == input.environment_id
            && self.storage_instance_id == input.storage_instance_id
            && self.data_root == input.data_root
            && self.prior_binary_path == input.prior_binary_path
            && self.prior_binary_sha256 == input.prior_binary_sha256
            && self.service_mode == input.service_mode
            && self.service_owner == input.service_owner
            && self.backup_id == input.backup_id
            && self.backup_schema_version == input.backup_schema_version
    }

    fn validate_operation(&self, nonce: &str, target_version: &str) -> Result<()> {
        if self.schema_version != PACKAGE_LIFECYCLE_SCHEMA_VERSION
            || self.nonce_sha256 != hash_nonce(nonce)
            || self.target_version != target_version
        {
            return Err(PackageLifecycleError::ReceiptMismatch);
        }
        Ok(())
    }

    pub fn validate_for_installer(&self, nonce: &str, target_version: &str) -> Result<()> {
        self.validate_operation(nonce, target_version)
    }

    pub fn verify_restored_binary(&self, path: &Path, sha256: &str) -> Result<()> {
        if path != self.prior_binary_path || sha256 != self.prior_binary_sha256 {
            return Err(PackageLifecycleError::RestoredPackageMismatch);
        }
        Ok(())
    }

    pub fn verify_runtime(&self, verification: &PackageRuntimeVerification) -> Result<()> {
        if verification.environment_id != self.environment_id {
            return Err(runtime_verification_error("environment identity changed"));
        }
        if verification.storage_instance_id != self.storage_instance_id {
            return Err(runtime_verification_error("storage identity changed"));
        }
        if verification.server_version != self.target_version {
            return Err(runtime_verification_error(
                "server version does not match the package",
            ));
        }
        if verification.control_protocol_version != verification.expected_control_protocol_version {
            return Err(runtime_verification_error(
                "local-control protocol is incompatible",
            ));
        }
        if !verification.bind.ip().is_loopback() {
            return Err(runtime_verification_error(
                "managed service is not loopback-only",
            ));
        }
        if !verification.web_assets_verified {
            return Err(runtime_verification_error(
                "installed web assets were not verified",
            ));
        }
        if !verification.service_definition_matches {
            return Err(runtime_verification_error(
                "native service definition does not match",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackageRuntimeVerification {
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub server_version: String,
    pub control_protocol_version: u16,
    pub expected_control_protocol_version: u16,
    pub bind: std::net::SocketAddr,
    pub web_assets_verified: bool,
    pub service_definition_matches: bool,
}

#[derive(Clone, Debug)]
pub struct PackageLifecycleReceiptStore {
    data_root: PathBuf,
    path: PathBuf,
}

impl PackageLifecycleReceiptStore {
    #[must_use]
    pub fn new(data_root: impl AsRef<Path>) -> Self {
        let requested = data_root.as_ref();
        let data_root =
            std::fs::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());
        let path = data_root
            .join("userdata")
            .join(PACKAGE_LIFECYCLE_RECEIPT_FILE);
        Self { data_root, path }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn load(&self) -> Result<Option<PackageLifecycleReceipt>> {
        let receipt = read_json::<PackageLifecycleReceipt>(&self.path).await?;
        if let Some(receipt) = &receipt {
            if receipt.schema_version != PACKAGE_LIFECYCLE_SCHEMA_VERSION {
                return Err(PackageLifecycleError::UnsupportedReceiptSchema(
                    receipt.schema_version,
                ));
            }
            if receipt.data_root != self.data_root {
                return Err(PackageLifecycleError::ReceiptMismatch);
            }
        }
        Ok(receipt)
    }

    pub async fn load_active(&self) -> Result<Option<PackageLifecycleReceipt>> {
        Ok(self
            .load()
            .await?
            .filter(|receipt| !receipt.phase.is_terminal()))
    }

    pub async fn prepare(&self, input: PackagePrepareInput) -> Result<PackageLifecycleReceipt> {
        let _guard = acquire_lifecycle_lock(&self.data_root).await?;
        if input.data_root != self.data_root {
            return Err(PackageLifecycleError::ReceiptMismatch);
        }
        if let Some(existing) = self.load().await?
            && !existing.phase.is_terminal()
        {
            if existing.matches_prepare(&input) {
                return Ok(existing);
            }
            return Err(PackageLifecycleError::OperationConflict);
        }
        let receipt = PackageLifecycleReceipt::from_prepare(&input)?;
        write_json_atomically(&self.path, &receipt).await?;
        Ok(receipt)
    }

    pub async fn advance(
        &self,
        nonce: &str,
        target_version: &str,
        next: PackageLifecyclePhase,
    ) -> Result<PackageLifecycleReceipt> {
        let _guard = acquire_lifecycle_lock(&self.data_root).await?;
        let mut receipt = self
            .load()
            .await?
            .ok_or(PackageLifecycleError::ReceiptMissing)?;
        receipt.validate_operation(nonce, target_version)?;
        if !receipt.phase.can_advance_to(next) {
            return Err(PackageLifecycleError::InvalidTransition {
                from: receipt.phase,
                to: next,
            });
        }
        if receipt.phase == next {
            return Ok(receipt);
        }
        receipt.phase = next;
        receipt.updated_at = now_rfc3339()?;
        write_json_atomically(&self.path, &receipt).await?;
        Ok(receipt)
    }

    pub async fn roll_back(
        &self,
        nonce: &str,
        target_version: &str,
        current_schema_version: i64,
    ) -> Result<PackageLifecycleReceipt> {
        let _guard = acquire_lifecycle_lock(&self.data_root).await?;
        let mut receipt = self
            .load()
            .await?
            .ok_or(PackageLifecycleError::ReceiptMissing)?;
        receipt.validate_operation(nonce, target_version)?;
        if receipt.phase == PackageLifecyclePhase::RolledBack {
            return Ok(receipt);
        }
        if receipt.phase == PackageLifecyclePhase::Verified {
            return Err(PackageLifecycleError::InvalidTransition {
                from: receipt.phase,
                to: PackageLifecyclePhase::RolledBack,
            });
        }
        if current_schema_version != receipt.backup_schema_version {
            return Err(PackageLifecycleError::IrreversibleMigration {
                backup_schema_version: receipt.backup_schema_version,
                current_schema_version,
            });
        }
        receipt.phase = PackageLifecyclePhase::RolledBack;
        receipt.updated_at = now_rfc3339()?;
        write_json_atomically(&self.path, &receipt).await?;
        Ok(receipt)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PurgePlanSnapshot {
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub environment_name: String,
    pub data_root: PathBuf,
    pub project_count: u64,
    pub worktree_count: u64,
    pub process_count: u64,
    pub other_paired_client_count: u64,
    pub now: OffsetDateTime,
    pub lifetime: Duration,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgePlan {
    pub schema_version: u16,
    #[serde(with = "uuid_string")]
    pub plan_id: Uuid,
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub environment_name: String,
    pub data_root: PathBuf,
    pub project_count: u64,
    pub worktree_count: u64,
    pub process_count: u64,
    pub other_paired_client_count: u64,
    #[serde(with = "rfc3339_time")]
    pub created_at: OffsetDateTime,
    #[serde(with = "rfc3339_time")]
    pub expires_at: OffsetDateTime,
}

impl PurgePlan {
    pub fn new(snapshot: PurgePlanSnapshot) -> Result<Self> {
        validate_environment_name(&snapshot.environment_name)?;
        validate_data_root(&snapshot.data_root)?;
        if snapshot.lifetime <= Duration::ZERO || snapshot.lifetime > MAX_PURGE_PLAN_LIFETIME {
            return Err(PackageLifecycleError::InvalidPurgePlan(
                "purge plan lifetime must be positive and at most ten minutes".to_owned(),
            ));
        }
        Ok(Self {
            schema_version: PURGE_PLAN_SCHEMA_VERSION,
            plan_id: Uuid::new_v4(),
            environment_id: snapshot.environment_id,
            storage_instance_id: snapshot.storage_instance_id,
            environment_name: snapshot.environment_name,
            data_root: snapshot.data_root,
            project_count: snapshot.project_count,
            worktree_count: snapshot.worktree_count,
            process_count: snapshot.process_count,
            other_paired_client_count: snapshot.other_paired_client_count,
            created_at: snapshot.now,
            expires_at: snapshot.now + snapshot.lifetime,
        })
    }

    pub fn authorize(
        &self,
        plan_id: Uuid,
        typed_environment_name: &str,
        selected_data_root: &Path,
        now: OffsetDateTime,
    ) -> Result<PurgeAuthorization> {
        if self.schema_version != PURGE_PLAN_SCHEMA_VERSION || self.plan_id != plan_id {
            return Err(PackageLifecycleError::PurgePlanMismatch);
        }
        if now > self.expires_at {
            return Err(PackageLifecycleError::PurgePlanExpired);
        }
        if typed_environment_name != self.environment_name {
            return Err(PackageLifecycleError::EnvironmentNameMismatch);
        }
        if selected_data_root != self.data_root {
            return Err(PackageLifecycleError::DataRootMismatch);
        }
        if self.project_count > 0 || self.worktree_count > 0 || self.process_count > 0 {
            return Err(PackageLifecycleError::RemovalGuardsActive {
                project_count: self.project_count,
                worktree_count: self.worktree_count,
                process_count: self.process_count,
            });
        }
        Ok(PurgeAuthorization {
            plan_id: self.plan_id,
            environment_id: self.environment_id,
            storage_instance_id: self.storage_instance_id,
            data_root: self.data_root.clone(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PurgeAuthorization {
    pub plan_id: Uuid,
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub data_root: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeAuthorizationReceipt {
    pub schema_version: u16,
    #[serde(with = "uuid_string")]
    pub plan_id: Uuid,
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub data_root: PathBuf,
    #[serde(with = "rfc3339_time")]
    pub authorized_at: OffsetDateTime,
}

#[derive(Clone, Debug)]
pub struct PurgePlanStore {
    data_root: PathBuf,
    plan_path: PathBuf,
    authorization_path: PathBuf,
}

impl PurgePlanStore {
    #[must_use]
    pub fn new(data_root: impl AsRef<Path>) -> Self {
        let requested = data_root.as_ref();
        let data_root =
            std::fs::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());
        let state_dir = data_root.join("userdata");
        Self {
            data_root,
            plan_path: state_dir.join(PURGE_PLAN_FILE),
            authorization_path: state_dir.join(PURGE_AUTHORIZATION_FILE),
        }
    }

    #[must_use]
    pub fn plan_path(&self) -> &Path {
        &self.plan_path
    }

    pub async fn persist_plan(&self, plan: &PurgePlan) -> Result<()> {
        let _guard = acquire_lifecycle_lock(&self.data_root).await?;
        if plan.data_root != self.data_root {
            return Err(PackageLifecycleError::DataRootMismatch);
        }
        write_json_atomically(&self.plan_path, plan).await?;
        match tokio::fs::remove_file(&self.authorization_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(PackageLifecycleError::Io {
                    path: self.authorization_path.clone(),
                    source,
                });
            }
        }
        Ok(())
    }

    pub async fn load_plan(&self) -> Result<Option<PurgePlan>> {
        let plan = read_json::<PurgePlan>(&self.plan_path).await?;
        if let Some(plan) = &plan
            && (plan.schema_version != PURGE_PLAN_SCHEMA_VERSION
                || plan.data_root != self.data_root)
        {
            return Err(PackageLifecycleError::PurgePlanMismatch);
        }
        Ok(plan)
    }

    pub async fn authorize(
        &self,
        plan_id: Uuid,
        typed_environment_name: &str,
        now: OffsetDateTime,
    ) -> Result<PurgeAuthorizationReceipt> {
        let _guard = acquire_lifecycle_lock(&self.data_root).await?;
        let plan = self
            .load_plan()
            .await?
            .ok_or(PackageLifecycleError::PurgePlanMismatch)?;
        let authorization =
            plan.authorize(plan_id, typed_environment_name, &self.data_root, now)?;
        let receipt = PurgeAuthorizationReceipt {
            schema_version: PURGE_PLAN_SCHEMA_VERSION,
            plan_id: authorization.plan_id,
            environment_id: authorization.environment_id,
            storage_instance_id: authorization.storage_instance_id,
            data_root: authorization.data_root,
            authorized_at: now,
        };
        write_json_atomically(&self.authorization_path, &receipt).await?;
        Ok(receipt)
    }

    pub async fn load_authorization(&self) -> Result<Option<PurgeAuthorizationReceipt>> {
        let receipt = read_json::<PurgeAuthorizationReceipt>(&self.authorization_path).await?;
        if let Some(receipt) = &receipt
            && (receipt.schema_version != PURGE_PLAN_SCHEMA_VERSION
                || receipt.data_root != self.data_root)
        {
            return Err(PackageLifecycleError::PurgePlanMismatch);
        }
        Ok(receipt)
    }

    pub async fn validate_authorized_retry(
        &self,
        plan_id: Uuid,
        typed_environment_name: &str,
    ) -> Result<PurgeAuthorizationReceipt> {
        let plan = self
            .load_plan()
            .await?
            .ok_or(PackageLifecycleError::PurgePlanMismatch)?;
        let authorization = self
            .load_authorization()
            .await?
            .ok_or(PackageLifecycleError::PurgePlanMismatch)?;
        if typed_environment_name != plan.environment_name {
            return Err(PackageLifecycleError::EnvironmentNameMismatch);
        }
        validate_authorization_pair(&plan, &authorization, plan_id)?;
        Ok(authorization)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PurgeCounts {
    pub project_count: u64,
    pub worktree_count: u64,
    pub other_paired_client_count: u64,
}

pub async fn inspect_purge_counts(database: &Database, now: OffsetDateTime) -> Result<PurgeCounts> {
    let now = now
        .format(&Rfc3339)
        .map_err(PackageLifecycleError::Timestamp)?;
    database
        .call(move |connection| {
            let project_count = connection.query_row(
                "SELECT COUNT(*) FROM projection_projects WHERE deleted_at IS NULL",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            let worktree_count = connection.query_row(
                "SELECT COUNT(*) FROM projection_threads \
                 WHERE deleted_at IS NULL AND worktree_path IS NOT NULL AND worktree_path <> ''",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            let other_paired_client_count = connection.query_row(
                "SELECT COUNT(*) FROM auth_sessions \
                 WHERE revoked_at IS NULL AND expires_at > ?",
                [&now],
                |row| row.get::<_, i64>(0),
            )?;
            Ok(PurgeCounts {
                project_count: checked_count(project_count)?,
                worktree_count: checked_count(worktree_count)?,
                other_paired_client_count: checked_count(other_paired_client_count)?,
            })
        })
        .await
        .map_err(PackageLifecycleError::Persistence)
}

fn checked_count(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, value))
}

async fn acquire_lifecycle_lock(data_root: &Path) -> Result<StoreOperationGuard> {
    StoreOperationGuard::acquire(data_root, CancellationToken::new(), PURGE_LOCK_TIMEOUT)
        .await
        .map_err(PackageLifecycleError::Backup)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub data_root: PathBuf,
    pub removed: bool,
}

pub async fn execute_authorized_purge(data_root: &Path, plan_id: Uuid) -> Result<PurgeResult> {
    validate_data_root(data_root)?;
    let effective_root =
        std::fs::canonicalize(data_root).map_err(|source| PackageLifecycleError::Io {
            path: data_root.to_path_buf(),
            source,
        })?;
    if effective_root != data_root {
        return Err(PackageLifecycleError::DataRootMismatch);
    }
    let store = PurgePlanStore::new(&effective_root);
    let plan = store
        .load_plan()
        .await?
        .ok_or(PackageLifecycleError::PurgePlanMismatch)?;
    let authorization = store
        .load_authorization()
        .await?
        .ok_or(PackageLifecycleError::PurgePlanMismatch)?;
    validate_authorization_pair(&plan, &authorization, plan_id)?;

    let paths = StatePaths::from_config(&ServerConfig::new(&effective_root));
    // Service-manager stop/drain is bounded at 40 seconds. Give a just-stopped
    // runtime a small cleanup margin before declaring the exact root busy.
    let offline_deadline = tokio::time::Instant::now() + StdDuration::from_secs(45);
    let offline = loop {
        match StoreOfflineGuard::acquire(&paths) {
            Ok(guard) => break guard,
            Err(RecoveryError::StoreRunning) if tokio::time::Instant::now() < offline_deadline => {
                tokio::time::sleep(StdDuration::from_millis(100)).await;
            }
            Err(error) => return Err(error.into()),
        }
    };
    let operation = StoreOperationGuard::acquire(
        &effective_root,
        CancellationToken::new(),
        PURGE_LOCK_TIMEOUT,
    )
    .await?;
    verify_identity_marker(&paths.environment_id, plan.environment_id.to_string()).await?;
    verify_identity_marker(
        &paths.storage_instance_id,
        plan.storage_instance_id.to_string(),
    )
    .await?;
    let database = Database::open_existing(&paths.database).await?;
    let counts = inspect_purge_counts(&database, OffsetDateTime::now_utc()).await?;
    database.close().await;
    if counts.project_count > 0 || counts.worktree_count > 0 {
        return Err(PackageLifecycleError::RemovalGuardsActive {
            project_count: counts.project_count,
            worktree_count: counts.worktree_count,
            process_count: 0,
        });
    }

    let runtime_lock = paths.runtime_lock();
    let operation_lock = paths.operation_lock.clone();
    remove_data_root_children(&effective_root, [&runtime_lock, &operation_lock]).await?;
    drop(operation);
    drop(offline);
    remove_path_if_present(&runtime_lock).await?;
    remove_path_if_present(&operation_lock).await?;
    tokio::fs::remove_dir(&effective_root)
        .await
        .map_err(|source| PackageLifecycleError::Io {
            path: effective_root.clone(),
            source,
        })?;
    Ok(PurgeResult {
        environment_id: plan.environment_id,
        storage_instance_id: plan.storage_instance_id,
        data_root: effective_root,
        removed: true,
    })
}

#[derive(Debug, Error)]
pub enum PackageLifecycleError {
    #[error(transparent)]
    State(#[from] StateFileError),
    #[error("the package lifecycle receipt schema {0} is unsupported")]
    UnsupportedReceiptSchema(u16),
    #[error("another package lifecycle operation already owns this data root")]
    OperationConflict,
    #[error("the package lifecycle receipt is missing")]
    ReceiptMissing,
    #[error("the package lifecycle receipt does not match this installer or data root")]
    ReceiptMismatch,
    #[error("the restored package binary path or SHA-256 does not match the prepared receipt")]
    RestoredPackageMismatch,
    #[error("invalid package lifecycle transition from {from:?} to {to:?}")]
    InvalidTransition {
        from: PackageLifecyclePhase,
        to: PackageLifecyclePhase,
    },
    #[error(
        "the store schema advanced from backup version {backup_schema_version} to {current_schema_version}; automatic old-binary rollback is forbidden"
    )]
    IrreversibleMigration {
        backup_schema_version: i64,
        current_schema_version: i64,
    },
    #[error("package runtime verification failed: {0}")]
    RuntimeVerification(String),
    #[error("invalid package lifecycle input: {0}")]
    InvalidInput(String),
    #[error("invalid purge plan: {0}")]
    InvalidPurgePlan(String),
    #[error("the purge plan does not match the requested operation")]
    PurgePlanMismatch,
    #[error("the purge plan expired; request a fresh online plan")]
    PurgePlanExpired,
    #[error("the typed environment name does not match exactly")]
    EnvironmentNameMismatch,
    #[error("the selected data root does not match the planned canonical root")]
    DataRootMismatch,
    #[error(
        "purge is blocked by existing removal guards ({project_count} projects, {worktree_count} worktrees, {process_count} processes)"
    )]
    RemovalGuardsActive {
        project_count: u64,
        worktree_count: u64,
        process_count: u64,
    },
    #[error("failed to format the package lifecycle timestamp")]
    Timestamp(#[source] time::error::Format),
    #[error("failed to inspect the package lifecycle store schema")]
    SchemaInspection(#[source] rusqlite::Error),
    #[error(transparent)]
    Persistence(#[from] PersistenceError),
    #[error(transparent)]
    Recovery(#[from] RecoveryError),
    #[error(transparent)]
    Backup(#[from] BackupError),
    #[error("package lifecycle I/O failed for {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub type Result<T> = StdResult<T, PackageLifecycleError>;

pub fn validate_installer_arguments(nonce: &str, target_version: &str) -> Result<()> {
    if nonce.is_empty()
        || nonce.len() > 256
        || nonce.trim() != nonce
        || nonce.chars().any(char::is_control)
    {
        return Err(PackageLifecycleError::InvalidInput(
            "installer nonce must be 1-256 trimmed non-control characters".to_owned(),
        ));
    }
    if target_version.is_empty()
        || target_version.len() > 128
        || target_version.trim() != target_version
        || target_version.chars().any(char::is_control)
    {
        return Err(PackageLifecycleError::InvalidInput(
            "target version must be 1-128 trimmed non-control characters".to_owned(),
        ));
    }
    Ok(())
}

fn validate_prepare_input(input: &PackagePrepareInput) -> Result<()> {
    validate_installer_arguments(&input.nonce, &input.target_version)?;
    for (label, value) in [
        ("source version", input.source_version.as_str()),
        ("service owner", input.service_owner.as_str()),
    ] {
        if value.trim().is_empty() || value.chars().any(char::is_control) {
            return Err(PackageLifecycleError::InvalidInput(format!(
                "{label} must be non-empty and contain no control characters"
            )));
        }
    }
    validate_data_root(&input.data_root)?;
    if !input.prior_binary_path.is_absolute() {
        return Err(PackageLifecycleError::InvalidInput(
            "prior binary path must be absolute".to_owned(),
        ));
    }
    if input.prior_binary_sha256.len() != 64
        || !input
            .prior_binary_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(PackageLifecycleError::InvalidInput(
            "prior binary SHA-256 must contain exactly 64 hexadecimal characters".to_owned(),
        ));
    }
    if input.backup_schema_version < 0 {
        return Err(PackageLifecycleError::InvalidInput(
            "backup schema version must not be negative".to_owned(),
        ));
    }
    Ok(())
}

fn validate_environment_name(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.chars().count() > 256 || value.chars().any(char::is_control)
    {
        return Err(PackageLifecycleError::InvalidPurgePlan(
            "environment name must be 1-256 characters and contain no control characters"
                .to_owned(),
        ));
    }
    Ok(())
}

fn validate_authorization_pair(
    plan: &PurgePlan,
    authorization: &PurgeAuthorizationReceipt,
    plan_id: Uuid,
) -> Result<()> {
    if plan.plan_id != plan_id
        || authorization.plan_id != plan_id
        || plan.environment_id != authorization.environment_id
        || plan.storage_instance_id != authorization.storage_instance_id
        || plan.data_root != authorization.data_root
        || authorization.authorized_at < plan.created_at
        || authorization.authorized_at > plan.expires_at
    {
        return Err(PackageLifecycleError::PurgePlanMismatch);
    }
    Ok(())
}

fn validate_data_root(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(PackageLifecycleError::InvalidInput(
            "data root must be absolute".to_owned(),
        ));
    }
    let ordinary_components = path
        .components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count();
    if ordinary_components < 2 {
        return Err(PackageLifecycleError::InvalidInput(
            "a filesystem root is never an eligible BiBCode data root".to_owned(),
        ));
    }
    Ok(())
}

async fn verify_identity_marker(path: &Path, expected: String) -> Result<()> {
    let actual =
        tokio::fs::read_to_string(path)
            .await
            .map_err(|source| PackageLifecycleError::Io {
                path: path.to_path_buf(),
                source,
            })?;
    if actual.trim() != expected {
        return Err(PackageLifecycleError::PurgePlanMismatch);
    }
    Ok(())
}

async fn remove_data_root_children<const N: usize>(
    data_root: &Path,
    preserved: [&Path; N],
) -> Result<()> {
    let mut entries =
        tokio::fs::read_dir(data_root)
            .await
            .map_err(|source| PackageLifecycleError::Io {
                path: data_root.to_path_buf(),
                source,
            })?;
    while let Some(entry) =
        entries
            .next_entry()
            .await
            .map_err(|source| PackageLifecycleError::Io {
                path: data_root.to_path_buf(),
                source,
            })?
    {
        let path = entry.path();
        if preserved.iter().any(|candidate| *candidate == path) {
            continue;
        }
        let metadata = tokio::fs::symlink_metadata(&path).await.map_err(|source| {
            PackageLifecycleError::Io {
                path: path.clone(),
                source,
            }
        })?;
        if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
            tokio::fs::remove_dir_all(&path)
                .await
                .map_err(|source| PackageLifecycleError::Io {
                    path: path.clone(),
                    source,
                })?;
        } else {
            tokio::fs::remove_file(&path)
                .await
                .map_err(|source| PackageLifecycleError::Io {
                    path: path.clone(),
                    source,
                })?;
        }
    }
    Ok(())
}

async fn remove_path_if_present(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(PackageLifecycleError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn hash_nonce(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn now_rfc3339() -> Result<String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(PackageLifecycleError::Timestamp)
}

fn runtime_verification_error(message: &str) -> PackageLifecycleError {
    PackageLifecycleError::RuntimeVerification(message.to_owned())
}

pub fn read_store_schema_version(database: &Path) -> Result<i64> {
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(PackageLifecycleError::SchemaInspection)?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(PackageLifecycleError::SchemaInspection)?
        .is_some();
    if !exists {
        return Ok(0);
    }
    connection
        .query_row(
            "SELECT COALESCE(MAX(migration_id), 0) FROM effect_sql_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(PackageLifecycleError::SchemaInspection)
}

mod rfc3339_time {
    use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
    use time::{OffsetDateTime, format_description::well_known::Rfc3339};

    pub fn serialize<S>(value: &OffsetDateTime, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        value
            .format(&Rfc3339)
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<OffsetDateTime, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        OffsetDateTime::parse(&value, &Rfc3339).map_err(de::Error::custom)
    }
}

mod uuid_string {
    use serde::{Deserialize, Deserializer, Serializer, de};
    use uuid::Uuid;

    pub fn serialize<S>(value: &Uuid, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Uuid, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Uuid::parse_str(&value).map_err(|_| de::Error::custom("identifier must be a UUID"))
    }
}
