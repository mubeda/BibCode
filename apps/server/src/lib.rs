//! Reusable BiBCode server runtime.

pub mod activity;
pub mod assets;
mod auth;
pub mod checkpointing;
pub mod cloud;
mod config;
mod crypto;
pub mod data_root;
pub mod diagnostic_bundle;
pub mod diagnostics;
mod environment_identity;
pub mod git;
mod http;
mod lifecycle;
pub mod logging;
mod maintenance;
pub mod mcp;
pub mod orchestration;
pub mod persistence;
pub mod preview;
pub mod process;
pub mod production;
pub mod project;
pub mod provider;
pub mod provider_terminal;
pub mod provider_usage;
pub mod remote_update;
pub mod review;
mod rpc;
pub mod server_settings;
pub mod source_control;
pub mod terminal;
pub mod text_generation;
pub mod vcs;
pub mod workspace;
pub mod worktree_catalog;

#[cfg(test)]
pub(crate) mod test_support;

use clap::Parser;
use serde::Serialize;
use serde_json::json;
use thiserror::Error;

pub use auth::pairing_code as auth_pairing_code;
pub use config::{
    Cli, CliAction, ConfigError, PairingCommand, ServerConfig, ServerMode, StorageCommand,
};
pub use data_root::{
    DataRootError, DataRootRequest, DataRootSource, ResolvedDataRoot, resolve_data_root,
};
pub use http::{
    DESKTOP_SHUTDOWN_PATH, DESKTOP_SHUTDOWN_TOKEN_HEADER, ENVIRONMENT_DESCRIPTOR_PATH,
    ROUTE_INVENTORY, RouteMethod, RouteSpec,
};
pub use lifecycle::{ServerError, ServerHandle, ServerRuntime, StartupAccess};
pub use maintenance::{
    DESKTOP_MAINTENANCE_TOKEN_HEADER, MAINTENANCE_UPDATE_CANCEL_PATH,
    MAINTENANCE_UPDATE_COMMIT_PATH, MAINTENANCE_UPDATE_PREPARE_PATH,
    MAINTENANCE_UPDATE_STATUS_PATH, PrepareForUpdateResult, RpcAdmissionGate, RpcMutability,
    http_mutability, rpc_mutability,
};
pub use remote_update::{
    HostUpdaterFuture, HostUpdaterStatus, RemoteUpdateDelegate, RemoteUpdateInstallMode,
    RemoteUpdateService, RemoteUpdateSnapshot, RemoteUpdateState, RemoteUpdateSupport,
    RemoteUpdateSupportReason, remote_update_manual_required_error,
};
pub use rpc::{
    ACTIVE_RPC_METHODS, CauseItem, ClientMessage, InvalidRequestId, MethodMode, RequestId, RpcExit,
    RpcMethodSpec, RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk, ServerMessage, WireMessage,
};

#[derive(Debug, Error)]
pub enum RunError {
    #[error(transparent)]
    Cli(#[from] clap::Error),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Server(#[from] ServerError),
    #[error("failed to install the shutdown signal handler")]
    ShutdownSignal(#[source] std::io::Error),
    #[error("failed to open the BiBCode browser client")]
    OpenBrowser(#[source] std::io::Error),
    #[error(transparent)]
    Recovery(#[from] persistence::RecoveryError),
    #[error("failed to encode storage command output")]
    StorageOutput(#[source] serde_json::Error),
    #[error("could not issue a pairing credential: {0}")]
    PairingIssue(String),
    #[error("failed to encode pairing command output")]
    PairingOutput(#[source] serde_json::Error),
}

pub async fn run_cli() -> Result<(), RunError> {
    match Cli::try_parse()?.into_action()? {
        CliAction::Run(config) => run_server(*config).await,
        CliAction::Storage(command) => run_storage_command(command).await,
        CliAction::Pairing(command) => run_pairing_command(command).await,
    }
}

async fn run_server(config: ServerConfig) -> Result<(), RunError> {
    let open_browser = !config.no_browser;
    let handle = ServerRuntime::start_standalone(config).await?;
    let http_base_url = format!("http://{}", handle.local_addr());
    let browser_target = handle
        .startup_access()
        .map(|access| access.pairing_url.as_str())
        .unwrap_or(http_base_url.as_str());
    let mut startup_output = json!({
        "address": handle.local_addr().to_string(),
        "httpBaseUrl": http_base_url.as_str(),
    });
    if let Some(access) = handle.startup_access()
        && let Some(output) = startup_output.as_object_mut()
    {
        output.insert("token".to_owned(), json!(access.credential));
        output.insert("pairingUrl".to_owned(), json!(access.pairing_url));
    }
    println!("{startup_output}");
    if open_browser {
        open::that_detached(browser_target).map_err(RunError::OpenBrowser)?;
    }

    tokio::select! {
        signal = termination_signal() => {
            signal.map_err(RunError::ShutdownSignal)?;
            handle.shutdown();
        }
        () = handle.wait_for_shutdown() => {}
    }
    handle.join().await?;
    Ok(())
}

async fn run_storage_command(command: StorageCommand) -> Result<(), RunError> {
    let (value, json_output) = match command {
        StorageCommand::Inspect { root, json } => {
            let inspection = persistence::inspect_store(&root).await?;
            let backups = inspection
                .backups
                .iter()
                .map(|backup| &backup.manifest)
                .collect::<Vec<_>>();
            let issues = inspection
                .backup_issues
                .iter()
                .map(|issue| {
                    json!({
                        "entryName": issue.entry_name,
                        "message": issue.message,
                    })
                })
                .collect::<Vec<_>>();
            (
                json!({
                    "classification": inspection.classification,
                    "storageInstanceId": inspection.storage_instance_id,
                    "backups": backups,
                    "backupIssues": issues,
                    "requestedRoot": inspection.requested_root.to_string_lossy(),
                    "effectiveRoot": inspection.effective_root.to_string_lossy(),
                    "isFilesystemAlias": inspection.is_filesystem_alias,
                    "issue": inspection.issue,
                }),
                json,
            )
        }
        StorageCommand::Restore {
            root,
            backup_id,
            json,
        } => (
            serde_json::to_value(persistence::restore_backup(&root, backup_id).await?)
                .map_err(RunError::StorageOutput)?,
            json,
        ),
        StorageCommand::StartEmpty { root, json } => (
            serde_json::to_value(persistence::preserve_and_start_empty(&root).await?)
                .map_err(RunError::StorageOutput)?,
            json,
        ),
    };
    if json_output {
        println!("{value}");
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(RunError::StorageOutput)?
        );
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingIssueOutput {
    id: String,
    credential: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    expires_at: String,
}

/// Issues a one-time administrative pairing credential against a data root.
///
/// Coexists with a running server on the same root: it takes the shared store
/// runtime lock (blocking only offline recovery) and writes through the WAL
/// database, and the server consumes pairing links from the database. Prints
/// exactly one JSON line to stdout in `--json` mode — the desktop SSH launcher
/// parses the last non-empty stdout line — and never initializes logging or
/// other stdout writers.
async fn run_pairing_command(command: PairingCommand) -> Result<(), RunError> {
    let PairingCommand::Issue { root, label, json } = command;
    let _runtime_guard = persistence::StoreRuntimeGuard::acquire(&root.effective)
        .await
        .map_err(|error| RunError::PairingIssue(error.to_string()))?;
    let paths = persistence::StatePaths::from_config(&ServerConfig::new(&root.effective));
    if !paths.database.exists() {
        return Err(RunError::PairingIssue(format!(
            "no BiBCode data store at {}; start the server on this data root first",
            paths.database.display()
        )));
    }
    let database = persistence::Database::open_existing(&paths.database)
        .await
        .map_err(|error| RunError::PairingIssue(error.to_string()))?;
    let repositories = persistence::Repositories::new(database.clone());
    let issued = auth::issue_administrative_pairing_link(&repositories, label)
        .await
        .map_err(|error| RunError::PairingIssue(format!("{error:?}")));
    database.close().await;
    let issued = issued?;
    let output = PairingIssueOutput {
        id: issued.id,
        credential: issued.credential,
        label: issued.label,
        expires_at: issued.expires_at,
    };
    if json {
        println!(
            "{}",
            serde_json::to_string(&output).map_err(RunError::PairingOutput)?
        );
    } else {
        println!("Pairing credential: {}", output.credential);
        println!("Expires at: {}", output.expires_at);
    }
    Ok(())
}

#[cfg(unix)]
async fn termination_signal() -> Result<(), std::io::Error> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => result,
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn termination_signal() -> Result<(), std::io::Error> {
    tokio::signal::ctrl_c().await
}
