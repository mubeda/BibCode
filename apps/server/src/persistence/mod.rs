mod backup;
mod database;
mod legacy_connect_cleanup;
mod migrations;
mod repositories;
mod state_files;
mod store;

pub use backup::{
    BackupError, BackupInventory, BackupInventoryIssue, BackupManifest, BackupTrigger,
    RecoveryAction, RecoveryError, RecoveryResult, StoreInspection, StoreInspectionStatus,
    StoreOfflineGuard, StoreOperationGuard, StoreRuntimeGuard, VerifiedBackup,
    create_verified_backup, inspect_store, inventory_verified_backups, preserve_and_start_empty,
    restore_backup,
};
pub(crate) use database::{CommitFence, CommitPermit};
pub use database::{Database, PersistenceError, Result};
pub use legacy_connect_cleanup::{
    LegacyConnectCleanupError, LegacyConnectCleanupFailpointForIntegrationTest,
    LegacyConnectCleanupReceipt, complete_legacy_connect_cleanup,
    complete_legacy_connect_cleanup_for_integration_test,
};
pub use migrations::{MIGRATIONS, Migration, apply_migrations, pending_migrations, run_migrations};
pub use repositories::*;
pub use state_files::{
    StateFileError, StateKind, StatePaths, read_json, write_bytes_atomically, write_json_atomically,
};
pub use store::{
    EnvironmentId, PreparedStore, StorageInstanceId, StoreClassification, StoreStartupError,
    prepare_store,
};
