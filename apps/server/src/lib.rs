//! Reusable BiBCode server runtime.

pub mod activity;
pub mod assets;
mod auth;
pub mod checkpointing;
mod config;
mod crypto;
pub mod data_root;
pub mod diagnostic_bundle;
pub mod diagnostics;
mod environment_identity;
pub mod git;
mod http;
pub mod install_layout;
mod lifecycle;
pub mod local_control;
pub mod logging;
mod maintenance;
pub mod mcp;
pub mod orchestration;
pub mod package_lifecycle;
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
use sha2::{Digest, Sha256};
use thiserror::Error;

pub use config::{
    AuthCommand, Cli, CliAction, ConfigError, PackageCliCommand, PackageOperation,
    PairingOutputFormat, ServerConfig, ServerMode, ServiceCliCommand, ServiceOperation,
    ServiceOutputFormat, StorageCommand, TlsFiles, TransportCommand,
};
pub use data_root::{
    DataRootError, DataRootRequest, DataRootSource, ResolvedDataRoot, resolve_data_root,
};
pub use http::{
    DESKTOP_SHUTDOWN_PATH, DESKTOP_SHUTDOWN_TOKEN_HEADER, ENVIRONMENT_DESCRIPTOR_PATH,
    ENVIRONMENT_PROTOCOL_VERSION, ROUTE_INVENTORY, RouteMethod, RouteSpec,
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
    #[error(transparent)]
    PackageLifecycle(#[from] package_lifecycle::PackageLifecycleError),
    #[error("failed to read the running package binary")]
    PackageBinary(#[source] std::io::Error),
    #[error("the package lifecycle local-control operation failed: {0}")]
    PackageControl(String),
    #[error("the package lifecycle service is not in a safe state: {0}")]
    PackageServiceState(String),
    #[error("the installed package version is {actual}, not the requested target {expected}")]
    PackageVersionMismatch { expected: String, actual: String },
    #[error("timed out while verifying the restarted package through protected local control")]
    PackageVerificationTimeout,
    #[error("failed to encode package lifecycle output")]
    PackageOutput(#[source] serde_json::Error),
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
        CliAction::Package(command) => run_package_command(command).await,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageCommandOutput {
    operation: &'static str,
    target_version: String,
    clean_install: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<package_lifecycle::PackageLifecyclePhase>,
    service_state: service::ServiceState,
    definition_matches: bool,
}

#[cfg(test)]
mod package_command_output_tests {
    use serde_json::json;

    use super::{PackageCommandOutput, package_lifecycle, service};

    #[test]
    fn package_manager_output_is_bounded_and_receipt_redacted() {
        let output = PackageCommandOutput {
            operation: "activate",
            target_version: "0.5.0".to_owned(),
            clean_install: false,
            phase: Some(package_lifecycle::PackageLifecyclePhase::Verified),
            service_state: service::ServiceState::Running,
            definition_matches: true,
        };

        assert_eq!(
            serde_json::to_value(output).unwrap(),
            json!({
                "operation": "activate",
                "targetVersion": "0.5.0",
                "cleanInstall": false,
                "phase": "verified",
                "serviceState": "running",
                "definitionMatches": true
            })
        );
    }
}

async fn run_package_command(command: PackageCliCommand) -> Result<(), RunError> {
    package_lifecycle::validate_installer_arguments(&command.nonce, &command.target_version)?;
    let binary_path = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(RunError::ServiceBinary)?;
    let target = service::ServiceTarget {
        mode: command.mode,
        binary_path: binary_path.clone(),
        data_root: command.root.effective.clone(),
        bind: command.bind,
        current_user: service::current_native_user()?,
    };
    let adapter = service::ServiceAdapter::native(target)?;
    let manager = service::ServiceManager::new(service::SystemCommandRunner);
    let store = package_lifecycle::PackageLifecycleReceiptStore::new(&command.root.effective);
    let (operation, clean_install, receipt, status) = match command.operation {
        PackageOperation::Prepare => {
            if let Some((receipt, stopped)) =
                resume_package_preparation(&command, &binary_path, &manager, &adapter, &store)
                    .await?
            {
                ("prepare", false, Some(receipt), stopped)
            } else {
                let status = manager.status(&adapter).await?;
                if status.state != service::ServiceState::Running || !status.definition_matches {
                    return Err(RunError::PackageServiceState(
                        "update preparation requires the matching installed service to be running"
                            .to_owned(),
                    ));
                }
                let prepared = local_control::client::prepare_update(
                    &command.root,
                    command.target_version.clone(),
                )
                .await
                .map_err(|error| RunError::PackageControl(error.to_string()))?;
                let prior_binary_sha256 = sha256_file(&binary_path).await?;
                store
                    .prepare(package_lifecycle::PackagePrepareInput {
                        nonce: command.nonce.clone(),
                        operation_id: prepared.operation_id,
                        source_version: prepared.current_version,
                        target_version: command.target_version.clone(),
                        environment_id: prepared.environment_id,
                        storage_instance_id: prepared.storage_instance_id,
                        data_root: command.root.effective.clone(),
                        prior_binary_path: binary_path,
                        prior_binary_sha256,
                        service_mode: command.mode,
                        service_owner: status.account.clone(),
                        backup_id: prepared.backup_id,
                        backup_schema_version: prepared.backup_schema_version,
                    })
                    .await?;
                local_control::client::commit_update(&command.root, prepared.operation_id)
                    .await
                    .map_err(|error| RunError::PackageControl(error.to_string()))?;
                let stopped = manager.stop_without_drain(&adapter).await?;
                let receipt = store
                    .advance(
                        &command.nonce,
                        &command.target_version,
                        package_lifecycle::PackageLifecyclePhase::ServiceStopped,
                    )
                    .await?;
                ("prepare", false, Some(receipt), stopped)
            }
        }
        PackageOperation::Activate => {
            require_running_package_version(&command.target_version)?;
            let existing = store.load().await?;
            let clean_install = existing.is_none();
            let mut receipt = existing;
            if let Some(current) = &receipt {
                current.validate_for_installer(&command.nonce, &command.target_version)?;
                if current.phase == package_lifecycle::PackageLifecyclePhase::Prepared {
                    let service_status = manager.status(&adapter).await?;
                    if !matches!(
                        service_status.state,
                        service::ServiceState::Stopped | service::ServiceState::NotInstalled
                    ) {
                        return Err(RunError::PackageServiceState(
                            "prepared update service did not stop before file commit".to_owned(),
                        ));
                    }
                    receipt = Some(
                        store
                            .advance(
                                &command.nonce,
                                &command.target_version,
                                package_lifecycle::PackageLifecyclePhase::ServiceStopped,
                            )
                            .await?,
                    );
                }
                if receipt.as_ref().is_some_and(|value| {
                    value.phase == package_lifecycle::PackageLifecyclePhase::ServiceStopped
                }) {
                    receipt = Some(
                        store
                            .advance(
                                &command.nonce,
                                &command.target_version,
                                package_lifecycle::PackageLifecyclePhase::FilesCommitted,
                            )
                            .await?,
                    );
                }
            }
            let installed_status = match install_and_start_package_service(&manager, &adapter).await
            {
                Ok(status) => status,
                Err(error) => {
                    stop_failed_package_activation(&manager, &adapter, &command.root).await;
                    return Err(error);
                }
            };
            let verification = async {
                if receipt.as_ref().is_some_and(|value| {
                    value.phase == package_lifecycle::PackageLifecyclePhase::FilesCommitted
                }) {
                    receipt = Some(
                        store
                            .advance(
                                &command.nonce,
                                &command.target_version,
                                package_lifecycle::PackageLifecyclePhase::ServiceStarted,
                            )
                            .await?,
                    );
                }
                let control = wait_for_package_control_status(&command.root).await?;
                if let Some(current) = &receipt {
                    current.verify_runtime(&package_lifecycle::PackageRuntimeVerification {
                        environment_id: control.environment_id,
                        storage_instance_id: control.storage_instance_id,
                        server_version: control.server_version,
                        control_protocol_version: control.control_protocol_version,
                        expected_control_protocol_version:
                            local_control::protocol::CONTROL_PROTOCOL_VERSION,
                        bind: control.bind,
                        web_assets_verified: control.web_assets_verified,
                        service_definition_matches: installed_status.definition_matches,
                    })?;
                    receipt = Some(
                        store
                            .advance(
                                &command.nonce,
                                &command.target_version,
                                package_lifecycle::PackageLifecyclePhase::Verified,
                            )
                            .await?,
                    );
                } else {
                    verify_clean_install_runtime(
                        &command.target_version,
                        &control,
                        &installed_status,
                    )?;
                }
                Ok::<(), RunError>(())
            }
            .await;
            if let Err(error) = verification {
                stop_failed_package_activation(&manager, &adapter, &command.root).await;
                return Err(error);
            }
            ("activate", clean_install, receipt, installed_status)
        }
        PackageOperation::Rollback => {
            let receipt = store
                .load()
                .await?
                .ok_or(package_lifecycle::PackageLifecycleError::ReceiptMissing)?;
            receipt.validate_for_installer(&command.nonce, &command.target_version)?;
            if let Err(error) =
                receipt.verify_restored_binary(&binary_path, &sha256_file(&binary_path).await?)
            {
                disable_unsafe_package_rollback(&manager, &adapter, &command.root).await;
                return Err(error.into());
            }
            let database =
                persistence::StatePaths::from_config(&ServerConfig::new(&command.root.effective))
                    .database;
            let current_schema = match package_lifecycle::read_store_schema_version(&database) {
                Ok(schema) => schema,
                Err(error) => {
                    disable_unsafe_package_rollback(&manager, &adapter, &command.root).await;
                    return Err(error.into());
                }
            };
            if current_schema != receipt.backup_schema_version {
                disable_unsafe_package_rollback(&manager, &adapter, &command.root).await;
                return Err(
                    package_lifecycle::PackageLifecycleError::IrreversibleMigration {
                        backup_schema_version: receipt.backup_schema_version,
                        current_schema_version: current_schema,
                    }
                    .into(),
                );
            }
            let restoration = async {
                let installed_status =
                    install_and_start_package_service(&manager, &adapter).await?;
                let control = wait_for_package_control_status(&command.root).await?;
                verify_rollback_runtime(&receipt, &control, &installed_status)?;
                let receipt = store
                    .roll_back(&command.nonce, &command.target_version, current_schema)
                    .await?;
                Ok::<_, RunError>((receipt, installed_status))
            }
            .await;
            match restoration {
                Ok((receipt, installed_status)) => {
                    ("rollback", false, Some(receipt), installed_status)
                }
                Err(error) => {
                    stop_failed_package_activation(&manager, &adapter, &command.root).await;
                    return Err(error);
                }
            }
        }
    };
    let output = PackageCommandOutput {
        operation,
        target_version: command.target_version,
        clean_install,
        phase: receipt.map(|receipt| receipt.phase),
        service_state: status.state,
        definition_matches: status.definition_matches,
    };
    match command.format {
        ServiceOutputFormat::Json => println!(
            "{}",
            serde_json::to_string(&output).map_err(RunError::PackageOutput)?
        ),
        ServiceOutputFormat::Human => {
            println!("Package operation: {}", output.operation);
            println!("Target version: {}", output.target_version);
            println!("Service state: {:?}", output.service_state);
            if let Some(phase) = output.phase {
                println!("Durable phase: {phase:?}");
            }
        }
    }
    Ok(())
}

async fn resume_package_preparation<R>(
    command: &PackageCliCommand,
    binary_path: &std::path::Path,
    manager: &service::ServiceManager<R>,
    adapter: &service::ServiceAdapter,
    store: &package_lifecycle::PackageLifecycleReceiptStore,
) -> Result<
    Option<(
        package_lifecycle::PackageLifecycleReceipt,
        service::ServiceStatus,
    )>,
    RunError,
>
where
    R: service::CommandRunner,
{
    let Some(receipt) = store.load().await? else {
        return Ok(None);
    };
    if matches!(
        receipt.phase,
        package_lifecycle::PackageLifecyclePhase::Verified
            | package_lifecycle::PackageLifecyclePhase::RolledBack
    ) {
        return Ok(None);
    }
    receipt.validate_for_installer(&command.nonce, &command.target_version)?;
    if receipt.service_mode != command.mode {
        return Err(RunError::PackageServiceState(
            "prepared package service mode changed before retry".to_owned(),
        ));
    }
    receipt.verify_restored_binary(binary_path, &sha256_file(binary_path).await?)?;
    let status = manager.status(adapter).await?;
    if status.account != receipt.service_owner {
        return Err(RunError::PackageServiceState(
            "prepared package service owner changed before retry".to_owned(),
        ));
    }
    let committed_handoff_matches = || async {
        let paths =
            persistence::StatePaths::from_config(&ServerConfig::new(&command.root.effective));
        maintenance::committed_update_handoff_matches(
            &paths.state_dir,
            receipt.operation_id,
            &command.target_version,
        )
        .await
        .map_err(|error| RunError::PackageServiceState(error.to_string()))
    };
    let stopped = match receipt.phase {
        package_lifecycle::PackageLifecyclePhase::Prepared => {
            if status.state == service::ServiceState::Running && status.definition_matches {
                local_control::client::commit_update(&command.root, receipt.operation_id)
                    .await
                    .map_err(|error| RunError::PackageControl(error.to_string()))?;
                manager.stop_without_drain(adapter).await?
            } else if matches!(
                status.state,
                service::ServiceState::Stopped | service::ServiceState::NotInstalled
            ) {
                if !committed_handoff_matches().await? {
                    return Err(RunError::PackageServiceState(
                        "prepared package retry has no matching committed update handoff"
                            .to_owned(),
                    ));
                }
                status
            } else {
                return Err(RunError::PackageServiceState(
                    "prepared package retry found an unsafe service state".to_owned(),
                ));
            }
        }
        package_lifecycle::PackageLifecyclePhase::ServiceStopped => {
            if !matches!(
                status.state,
                service::ServiceState::Stopped | service::ServiceState::NotInstalled
            ) {
                return Err(RunError::PackageServiceState(
                    "stopped package retry found a running or failed service".to_owned(),
                ));
            }
            if !committed_handoff_matches().await? {
                return Err(RunError::PackageServiceState(
                    "stopped package retry has no matching committed update handoff".to_owned(),
                ));
            }
            status
        }
        _ => {
            return Err(RunError::PackageServiceState(
                "package preparation cannot resume after package files were committed".to_owned(),
            ));
        }
    };
    let receipt = store
        .advance(
            &command.nonce,
            &command.target_version,
            package_lifecycle::PackageLifecyclePhase::ServiceStopped,
        )
        .await?;
    Ok(Some((receipt, stopped)))
}

async fn install_and_start_package_service<R>(
    manager: &service::ServiceManager<R>,
    adapter: &service::ServiceAdapter,
) -> Result<service::ServiceStatus, RunError>
where
    R: service::CommandRunner,
{
    let installed = manager.install_report(adapter, true).await?;
    if installed.status.state == service::ServiceState::Running {
        return Ok(installed.status);
    }
    Ok(manager.start(adapter).await?)
}

fn require_running_package_version(expected: &str) -> Result<(), RunError> {
    let actual = env!("CARGO_PKG_VERSION");
    if actual != expected {
        return Err(RunError::PackageVersionMismatch {
            expected: expected.to_owned(),
            actual: actual.to_owned(),
        });
    }
    Ok(())
}

async fn sha256_file(path: &std::path::Path) -> Result<String, RunError> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(RunError::PackageBinary)?;
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Ok(encoded)
}

async fn wait_for_package_control_status(
    root: &ResolvedDataRoot,
) -> Result<local_control::client::ControlStatus, RunError> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        match local_control::client::status(root).await {
            Ok(status) => return Ok(status),
            Err(_) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Err(_) => return Err(RunError::PackageVerificationTimeout),
        }
    }
}

async fn stop_failed_package_activation<R>(
    manager: &service::ServiceManager<R>,
    adapter: &service::ServiceAdapter,
    root: &ResolvedDataRoot,
) where
    R: service::CommandRunner,
{
    let _ = local_control::client::stop_service(root).await;
    let _ = manager.stop_without_drain(adapter).await;
}

async fn disable_unsafe_package_rollback<R>(
    manager: &service::ServiceManager<R>,
    adapter: &service::ServiceAdapter,
    root: &ResolvedDataRoot,
) where
    R: service::CommandRunner,
{
    stop_failed_package_activation(manager, adapter, root).await;
    let _ = manager.uninstall_report(adapter).await;
}

fn verify_clean_install_runtime(
    target_version: &str,
    control: &local_control::client::ControlStatus,
    status: &service::ServiceStatus,
) -> Result<(), RunError> {
    if control.server_version != target_version
        || control.control_protocol_version != local_control::protocol::CONTROL_PROTOCOL_VERSION
        || !control.bind.ip().is_loopback()
        || !control.web_assets_verified
        || !status.definition_matches
    {
        return Err(RunError::PackageServiceState(
            "clean install failed version, protocol, asset, service, or loopback verification"
                .to_owned(),
        ));
    }
    Ok(())
}

fn verify_rollback_runtime(
    receipt: &package_lifecycle::PackageLifecycleReceipt,
    control: &local_control::client::ControlStatus,
    status: &service::ServiceStatus,
) -> Result<(), RunError> {
    if control.environment_id != receipt.environment_id
        || control.storage_instance_id != receipt.storage_instance_id
        || control.server_version != receipt.source_version
        || control.control_protocol_version != local_control::protocol::CONTROL_PROTOCOL_VERSION
        || !control.bind.ip().is_loopback()
        || !control.web_assets_verified
        || !status.definition_matches
    {
        return Err(RunError::PackageServiceState(
            "restored package failed identity, version, protocol, asset, service, or loopback verification"
                .to_owned(),
        ));
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
        StorageCommand::PlanPurge {
            root,
            environment_name,
            json,
        } => {
            let plan = local_control::client::plan_purge(&root, environment_name)
                .await
                .map_err(|error| RunError::LocalControl(error.to_string()))?;
            (
                serde_json::to_value(plan).map_err(RunError::StorageOutput)?,
                json,
            )
        }
        StorageCommand::ExecutePurge {
            root,
            plan_id,
            confirm_environment_name,
            json,
        } => {
            if let Err(control_error) = local_control::client::authorize_purge(
                &root,
                plan_id,
                confirm_environment_name.clone(),
            )
            .await
            {
                package_lifecycle::PurgePlanStore::new(&root.effective)
                    .validate_authorized_retry(plan_id, &confirm_environment_name)
                    .await
                    .map_err(|_| RunError::LocalControl(control_error.to_string()))?;
            }
            let result =
                package_lifecycle::execute_authorized_purge(&root.effective, plan_id).await?;
            (
                serde_json::to_value(result).map_err(RunError::StorageOutput)?,
                json,
            )
        }
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
