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
pub mod local_control;
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
pub mod review;
mod rpc;
pub mod server_settings;
pub mod service;
pub mod source_control;
pub mod terminal;
pub mod text_generation;
pub mod transport;
pub mod vcs;
pub mod workspace;
pub mod worktree_catalog;

#[cfg(test)]
pub(crate) mod test_support;

use clap::Parser;
use serde::Serialize;
use serde_json::json;
use thiserror::Error;

pub use config::{
    AuthCommand, Cli, CliAction, ConfigError, PairingOutputFormat, ServerConfig, ServerMode,
    ServiceCliCommand, ServiceOperation, ServiceOutputFormat, StorageCommand, TlsFiles,
    TransportCommand,
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
    #[error("{0}")]
    LocalControl(String),
    #[error("failed to encode pairing command output")]
    PairingOutput(#[source] serde_json::Error),
    #[error(transparent)]
    Service(#[from] service::ServiceError),
    #[error("failed to resolve the running BiBCode executable for service installation")]
    ServiceBinary(#[source] std::io::Error),
    #[error("failed to encode service command output")]
    ServiceOutput(#[source] serde_json::Error),
    #[error("timed out connecting the standard-I/O transport to 127.0.0.1:{port}")]
    StdioForwardConnectTimeout { port: u16 },
    #[error("failed to connect the standard-I/O transport to 127.0.0.1:{port}")]
    StdioForwardConnect {
        port: u16,
        #[source]
        source: std::io::Error,
    },
    #[error("standard-I/O transport copy failed")]
    StdioForwardCopy(#[source] std::io::Error),
}

pub async fn run_cli() -> Result<(), RunError> {
    match Cli::try_parse()?.into_action()? {
        CliAction::Run(config) => run_server(*config).await,
        CliAction::Storage(command) => run_storage_command(command).await,
        CliAction::Auth(command) => run_auth_command(command).await,
        CliAction::Service(command) => run_service_command(command).await,
        CliAction::Transport(command) => run_transport_command(command).await,
    }
}

const STDIO_FORWARD_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

async fn run_transport_command(command: TransportCommand) -> Result<(), RunError> {
    match command {
        TransportCommand::StdioForward { loopback_port } => {
            let address =
                std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, loopback_port));
            let stream = tokio::time::timeout(
                STDIO_FORWARD_CONNECT_TIMEOUT,
                tokio::net::TcpStream::connect(address),
            )
            .await
            .map_err(|_| RunError::StdioForwardConnectTimeout {
                port: loopback_port,
            })?
            .map_err(|source| RunError::StdioForwardConnect {
                port: loopback_port,
                source,
            })?;
            let (mut server_read, mut server_write) = stream.into_split();
            let mut stdin = tokio::io::stdin();
            let mut stdout = tokio::io::stdout();

            tokio::select! {
                copied = tokio::io::copy(&mut stdin, &mut server_write) => {
                    copied.map_err(RunError::StdioForwardCopy)?;
                }
                copied = tokio::io::copy(&mut server_read, &mut stdout) => {
                    copied.map_err(RunError::StdioForwardCopy)?;
                    use tokio::io::AsyncWriteExt as _;
                    stdout.flush().await.map_err(RunError::StdioForwardCopy)?;
                }
            }
            Ok(())
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceCommandOutput {
    operation: &'static str,
    status: service::ServiceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    changed: Option<bool>,
    account_created: bool,
    data_root_preserved: bool,
    account_removal_performed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    drain_completed: Option<bool>,
}

async fn run_service_command(command: ServiceCliCommand) -> Result<(), RunError> {
    let binary_path = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(RunError::ServiceBinary)?;
    let target = service::ServiceTarget {
        mode: command.mode,
        binary_path,
        data_root: command.root.effective.clone(),
        bind: command.bind,
        current_user: service::current_native_user()?,
    };
    let adapter = service::ServiceAdapter::native(target)?;
    let manager = service::ServiceManager::new(service::SystemCommandRunner);
    let operation = match command.operation {
        ServiceOperation::Status => "status",
        ServiceOperation::Install { .. } => "install",
        ServiceOperation::Start => "start",
        ServiceOperation::Stop => "stop",
        ServiceOperation::Restart => "restart",
        ServiceOperation::Uninstall => "uninstall",
    };
    let mut drain_completed = None;
    let (status, changed, account_created, account_removal_performed, data_root_preserved) =
        match command.operation {
            ServiceOperation::Status => {
                (manager.status(&adapter).await?, None, false, false, false)
            }
            ServiceOperation::Install { update } => {
                if update {
                    let before = manager.status(&adapter).await?;
                    if before.state == service::ServiceState::Running && !before.definition_matches
                    {
                        drain_completed =
                            Some(drain_running_service(&manager, &adapter, &command.root).await);
                        manager.stop_without_drain(&adapter).await?;
                    }
                }
                let result = manager.install_report(&adapter, update).await?;
                (
                    result.status,
                    Some(result.changed),
                    result.account_created,
                    false,
                    false,
                )
            }
            ServiceOperation::Start => (manager.start(&adapter).await?, None, false, false, false),
            ServiceOperation::Stop => {
                drain_completed =
                    Some(drain_running_service(&manager, &adapter, &command.root).await);
                (
                    manager.stop_without_drain(&adapter).await?,
                    None,
                    false,
                    false,
                    false,
                )
            }
            ServiceOperation::Restart => {
                drain_completed =
                    Some(drain_running_service(&manager, &adapter, &command.root).await);
                (
                    manager.restart_without_drain(&adapter).await?,
                    None,
                    false,
                    false,
                    false,
                )
            }
            ServiceOperation::Uninstall => {
                let before = manager.status(&adapter).await?;
                if before.state == service::ServiceState::Running {
                    drain_completed =
                        Some(drain_running_service(&manager, &adapter, &command.root).await);
                    manager.stop_without_drain(&adapter).await?;
                }
                let result = manager.uninstall_report(&adapter).await?;
                (
                    result.status,
                    Some(result.changed),
                    false,
                    result.account_removed,
                    result.data_root_preserved,
                )
            }
        };
    let output = ServiceCommandOutput {
        operation,
        status,
        changed,
        account_created,
        data_root_preserved,
        account_removal_performed,
        drain_completed,
    };
    match command.format {
        ServiceOutputFormat::Json => println!(
            "{}",
            serde_json::to_string(&output).map_err(RunError::ServiceOutput)?
        ),
        ServiceOutputFormat::Human => print_service_output(&output),
    }
    Ok(())
}

async fn drain_running_service<R>(
    manager: &service::ServiceManager<R>,
    adapter: &service::ServiceAdapter,
    root: &ResolvedDataRoot,
) -> bool
where
    R: service::CommandRunner,
{
    let Ok(status) = manager.status(adapter).await else {
        return false;
    };
    if status.state != service::ServiceState::Running {
        return true;
    }
    match local_control::client::stop_service(root).await {
        Ok(_) => true,
        Err(error) => {
            eprintln!(
                "Warning: graceful local-control drain failed ({error}); forcing the requested service-manager stop after the bounded attempt."
            );
            false
        }
    }
}

fn print_service_output(output: &ServiceCommandOutput) {
    println!("Operation: {}", output.operation);
    println!("Mode: {}", output.status.mode);
    println!("State: {:?}", output.status.state);
    println!("Startup: {}", output.status.startup_owner);
    println!("Account: {}", output.status.account);
    println!("Binary: {}", output.status.binary_path.display());
    println!("Data root: {}", output.status.data_root.display());
    println!("Bind: {}", output.status.bind);
    println!(
        "Definition: {}",
        if output.status.definition_matches {
            "matches"
        } else {
            "missing or different"
        }
    );
    if let Some(linger_enabled) = output.status.linger_enabled {
        println!(
            "Linger: {} (never changed automatically)",
            if linger_enabled {
                "enabled"
            } else {
                "disabled"
            }
        );
    }
    if output.data_root_preserved {
        println!(
            "Project data preserved at: {}",
            output.status.data_root.display()
        );
        println!(
            "Dedicated service account removal: {}",
            if output.account_removal_performed {
                "performed for the Windows virtual service identity"
            } else {
                "not performed; any Unix service account is preserved"
            }
        );
    }
    if output.account_created {
        println!("Dedicated service account: created by this install");
    } else if output.operation == "install" && output.status.mode == service::ServiceMode::Headless
    {
        println!("Dedicated service account: pre-existing and preserved");
    }
    if let Some(drain_completed) = output.drain_completed {
        println!(
            "Graceful drain: {}",
            if drain_completed {
                "completed"
            } else {
                "failed; service-manager stop was forced after the bounded attempt"
            }
        );
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingCommandOutput {
    environment_id: persistence::EnvironmentId,
    credential: String,
    expires_at: String,
    pairing_url: String,
    control_protocol_version: u16,
}

async fn run_auth_command(command: AuthCommand) -> Result<(), RunError> {
    let AuthCommand::CreatePairing {
        root,
        client_label,
        format,
    } = command;
    let pairing = local_control::client::create_pairing(&root, client_label)
        .await
        .map_err(|error| RunError::LocalControl(error.to_string()))?;
    match format {
        PairingOutputFormat::Human => {
            println!("Pairing URL: {}", pairing.pairing_url);
            println!("Expires at: {}", pairing.expires_at);
        }
        PairingOutputFormat::Json => {
            let output = PairingCommandOutput {
                environment_id: pairing.environment_id,
                credential: pairing.credential,
                expires_at: pairing.expires_at,
                pairing_url: pairing.pairing_url,
                control_protocol_version: pairing.control_protocol_version,
            };
            println!(
                "{}",
                serde_json::to_string(&output).map_err(RunError::PairingOutput)?
            );
        }
    }
    Ok(())
}

async fn run_server(config: ServerConfig) -> Result<(), RunError> {
    let open_browser = !config.no_browser;
    let handle = ServerRuntime::start_standalone(config).await?;
    let http_base_url = handle.advertised_base_url();
    let browser_target = handle
        .startup_access()
        .map(|access| access.pairing_url.as_str())
        .unwrap_or(http_base_url);
    let mut startup_output = json!({
        "address": handle.local_addr().to_string(),
        "httpBaseUrl": http_base_url,
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
