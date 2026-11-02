mod backup;
mod compaction;
mod database;
mod migrations;
mod repositories;
mod state_files;
mod store;

pub use backup::{
    BackupError, BackupInventory, BackupInventoryIssue, BackupManifest, BackupTrigger,
    DatabaseSpace, DatabaseStatsUnavailable, RecoveryAction, RecoveryError, RecoveryResult,
    StoreInspection, StoreInspectionStatus, StoreOperationGuard, StoreRuntimeGuard, VerifiedBackup,
    create_verified_backup, format_bytes, inspect_store, inspect_store_for_integration_test,
    inventory_verified_backups, preserve_and_start_empty, restore_backup,
};
pub use compaction::{
    AvailableFreeBytes, CompactOptions, CompactPlan, CompactProgress, CompactReport, CompactStats,
    CompactTestHook, RequiredFreeBytes, compact_store, compact_store_for_integration_test,
};
pub use database::{AutoVacuumMode, Database, PageStats, PersistenceError, Result};
pub(crate) use database::{CommitFence, CommitPermit};
pub(crate) use migrations::ensure_webhook_revisions;
pub use migrations::{MIGRATIONS, Migration, apply_migrations, pending_migrations, run_migrations};
pub use repositories::*;
pub use state_files::{
    StateFileError, StateKind, StatePaths, read_json, write_bytes_atomically, write_json_atomically,
};
pub use store::{
    PreparedStore, StorageInstanceId, StoreClassification, StoreStartupError, prepare_store,
    read_storage_instance_id,
};
