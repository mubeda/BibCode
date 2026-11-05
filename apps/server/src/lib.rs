//! Reusable BiBCode server runtime.

pub mod activity;
mod agent_sessions;
pub mod allocator;
mod ansi;
pub mod assets;
mod auth;
pub mod checkpointing;
pub mod cloud;
mod config;
mod crypto;
pub mod data_root;
pub mod device;
pub mod diagnostic_bundle;
pub mod diagnostics;
mod ecmascript;
mod environment_identity;
pub mod git;
#[cfg(feature = "hermetic-test-guard")]
mod hermetic_guard;
mod http;
mod json_size;
mod lifecycle;
pub mod logging;
mod maintenance;
pub mod mcp;
pub mod open_url;
pub mod orchestration;
pub mod persistence;
pub mod preview;
pub mod process;
pub mod production;
pub mod project;
pub mod provider;
pub mod provider_terminal;
pub mod provider_usage;
pub mod pull_requests;
pub mod remote_update;
pub mod review;
mod rpc;
pub mod server_settings;
mod service_manager;
pub mod signed_token;
pub mod source_control;
mod static_assets;
pub mod terminal;
pub mod text_generation;
pub mod transfer;
pub mod vcs;
pub(crate) mod webhooks;
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
    Cli, CliAction, ConfigError, PairingAccess, PairingCommand, ServerConfig, ServerMode,
    ServiceCommand, StorageCommand,
};
pub use data_root::{
    DataRootError, DataRootRequest, DataRootSource, ResolvedDataRoot, resolve_data_root,
};
pub use diagnostics::profiler::cli::{ProfilerArgs, run_profiler_cli};
pub use http::{
    DESKTOP_SHUTDOWN_PATH, DESKTOP_SHUTDOWN_TOKEN_HEADER, ENVIRONMENT_DESCRIPTOR_PATH,
    ROUTE_INVENTORY, RequestClass, RequestOrigin, RouteMethod, RouteSpec,
};
pub use lifecycle::{ServerError, ServerHandle, ServerRuntime, StartupAccess};
pub use maintenance::{
    DESKTOP_MAINTENANCE_TOKEN_HEADER, MAINTENANCE_UPDATE_CANCEL_PATH,
    MAINTENANCE_UPDATE_COMMIT_PATH, MAINTENANCE_UPDATE_PREPARE_PATH,
    MAINTENANCE_UPDATE_STATUS_PATH, MaintenanceError, PrepareForUpdateResult, RpcAdmissionGate,
    RpcMutability, UpdateMaintenance, http_mutability, rpc_mutability,
};
pub use production::TOOL_UPDATE_SHUTDOWN_WAIT;
pub use remote_update::{
    HostUpdaterFuture, HostUpdaterStatus, RemoteUpdateDelegate, RemoteUpdateInstallKind,
    RemoteUpdateInstallMode, RemoteUpdateRequester, RemoteUpdateService, RemoteUpdateSnapshot,
    RemoteUpdateState, RemoteUpdateSupport, RemoteUpdateSupportReason,
    remote_update_manual_required_error,
};
pub use rpc::{
    ACTIVE_RPC_METHODS, CauseItem, ClientMessage, InvalidRequestId, MethodMode, RequestId, RpcExit,
    RpcMethodSpec, RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk, ServerMessage, WireMessage,
};
pub use service_manager::ServiceSpec;
pub use static_assets::{ResolvedStaticDir, StaticDirError, StaticDirSource, resolve_static_dir};

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
    #[error(
        "BiBCode is using this data root. Quit the BiBCode app, stop `bibcode serve` and any WSL backend, and stop the background service (`bibcode service status` shows it), then retry."
    )]
    StoreRunning,
    #[error("failed to encode storage command output")]
    StorageOutput(#[source] serde_json::Error),
    #[error("could not issue a pairing credential: {0}")]
    PairingIssue(String),
    #[error("failed to encode pairing command output")]
    PairingOutput(#[source] serde_json::Error),
    #[error(transparent)]
    Service(#[from] service_manager::ServiceError),
    #[error("failed to encode service command output")]
    ServiceOutput(#[source] serde_json::Error),
}

pub async fn run_cli() -> Result<(), RunError> {
    match Cli::try_parse()?.into_action()? {
        CliAction::Run(config) => run_server(*config).await,
        CliAction::Storage(command) => run_storage_command(command).await,
        CliAction::Pairing(command) => run_pairing_command(command).await,
        CliAction::Service(command) => run_service_command(command),
        CliAction::OpenUrl { url } => match open_url::run_open_url(&url).await {
            0 => Ok(()),
            code => std::process::exit(code),
        },
        // Stdout carries only JSON-RPC, so nothing here logs to it.
        CliAction::Mcp(options) => match mcp::relay::run_mcp_cli(options).await {
            0 => Ok(()),
            code => std::process::exit(code),
        },
        CliAction::McpAuthorize { options, args } => {
            match mcp::authorize_cli::run_mcp_authorize(options, args).await {
                0 => Ok(()),
                code => std::process::exit(code),
            }
        }
        CliAction::McpCall { options, args } => {
            match mcp::call_cli::run_mcp_call(options, args).await {
                0 => Ok(()),
                code => std::process::exit(code),
            }
        }
        CliAction::McpTools(options) => match mcp::call_cli::run_mcp_tools(options).await {
            0 => Ok(()),
            code => std::process::exit(code),
        },
        CliAction::Thread { options, args } => {
            match mcp::thread_cli::run_thread_cli(options, args).await {
                0 => Ok(()),
                code => std::process::exit(code),
            }
        }
        CliAction::Diagnostics { args, state_dir } => {
            match diagnostics::relay_cli::run_diagnostics_cli(args, state_dir).await {
                0 => Ok(()),
                code => std::process::exit(code),
            }
        }
        // Blocking file I/O, and `--follow` sleeps between polls.
        CliAction::Profiler { args, state_dir } => {
            match tokio::task::spawn_blocking(move || run_profiler_cli(args, state_dir))
                .await
                .unwrap_or(1)
            {
                0 => Ok(()),
                code => std::process::exit(code),
            }
        }
    }
}

async fn run_server(mut config: ServerConfig) -> Result<(), RunError> {
    let open_browser = !config.no_browser;
    // The absolute data root startup will use, not the requested (possibly relative) one.
    config.resolve_data_root().map_err(ServerError::from)?;
    git::system_line_endings::install_once(&config.state_dir()).await;
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
        if let Some(link) = &access.pairing_link {
            output.insert("pairingCode".to_owned(), json!(link));
        }
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
    let (value, json_output) =
        storage_command_output(command)
            .await
            .map_err(|error| match error {
                RunError::Recovery(persistence::RecoveryError::StoreRunning) => {
                    RunError::StoreRunning
                }
                other => other,
            })?;
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

async fn storage_command_output(
    command: StorageCommand,
) -> Result<(serde_json::Value, bool), RunError> {
    Ok(match command {
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
                    "database": inspection.database,
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
            serde_json::to_value(run_storage_restore(&root, backup_id).await?)
                .map_err(RunError::StorageOutput)?,
            json,
        ),
        StorageCommand::Resume { root, json } => (
            serde_json::to_value(persistence::resume_recovery(&root).await?)
                .map_err(RunError::StorageOutput)?,
            json,
        ),
        StorageCommand::StartEmpty { root, json } => (
            serde_json::to_value(persistence::preserve_and_start_empty(&root).await?)
                .map_err(RunError::StorageOutput)?,
            json,
        ),
        StorageCommand::Compact {
            root,
            dry_run,
            json,
        } => (
            serde_json::to_value(run_storage_compact(&root, dry_run).await?)
                .map_err(RunError::StorageOutput)?,
            json,
        ),
    })
}

/// How often a long storage command says it is still working.
const STILL_WORKING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

fn backup_progress_line(bytes: u64, budget: std::time::Duration) -> String {
    format!(
        "Backing up {} before compacting. This can take up to {}; press Ctrl-C to stop without changing the database.",
        persistence::format_bytes(bytes),
        persistence::format_duration_words(budget)
    )
}

fn restore_progress_line(backup_id: uuid::Uuid) -> String {
    format!(
        "Restoring backup {backup_id}. Press Ctrl-C to stop before the current database is replaced."
    )
}

fn still_working_line(activity: &str, elapsed: std::time::Duration) -> String {
    let seconds = elapsed.as_secs();
    let elapsed = if seconds < 60 {
        format!("{seconds} s")
    } else {
        format!("{} min", seconds / 60)
    };
    format!("Still {activity} ({elapsed} elapsed)…")
}

/// Runs `operation`, cancelling `cancellation` on Ctrl-C, and prints a "still working" line
/// for the current `activity` every [`STILL_WORKING_INTERVAL`].
async fn run_with_progress<T, E>(
    operation: impl std::future::Future<Output = Result<T, E>>,
    cancellation: &tokio_util::sync::CancellationToken,
    activity: &std::sync::Mutex<&'static str>,
) -> Result<T, E> {
    let started = std::time::Instant::now();
    tokio::pin!(operation);
    let mut ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + STILL_WORKING_INTERVAL,
        STILL_WORKING_INTERVAL,
    );
    let mut signalled = false;
    loop {
        tokio::select! {
            result = &mut operation => return result,
            _ = ticker.tick() => {
                let current = *activity.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if !current.is_empty() {
                    eprintln!("{}", still_working_line(current, started.elapsed()));
                }
            }
            signal = termination_signal(), if !signalled => {
                signalled = true;
                if signal.is_ok() {
                    eprintln!("Cancelling…");
                    cancellation.cancel();
                }
            }
        }
    }
}

/// Runs `bibcode storage restore --backup-id`, with Ctrl-C honored until the restore starts
/// replacing the current database.
async fn run_storage_restore(
    root: &ResolvedDataRoot,
    backup_id: uuid::Uuid,
) -> Result<persistence::RecoveryResult, RunError> {
    eprintln!("{}", restore_progress_line(backup_id));
    let cancellation = tokio_util::sync::CancellationToken::new();
    let activity = std::sync::Mutex::new("restoring");
    Ok(run_with_progress(
        persistence::restore_backup(root, backup_id, cancellation.clone()),
        &cancellation,
        &activity,
    )
    .await?)
}

/// Runs `bibcode storage compact`. Stdout carries only the JSON report; progress and the
/// summary go to stderr because a real run can take minutes.
async fn run_storage_compact(
    root: &ResolvedDataRoot,
    dry_run: bool,
) -> Result<persistence::CompactReport, RunError> {
    use persistence::{CompactProgress, format_bytes};

    let cancellation = tokio_util::sync::CancellationToken::new();
    let activity = std::sync::Arc::new(std::sync::Mutex::new(""));
    let options = persistence::CompactOptions {
        dry_run,
        cancellation: cancellation.clone(),
        on_progress: Some(std::sync::Arc::new({
            let activity = activity.clone();
            move |phase| {
                let (line, current) = match phase {
                    CompactProgress::BackingUp { bytes, budget } => {
                        (backup_progress_line(bytes, budget), "backing up")
                    }
                    CompactProgress::Compacting => ("Compacting…".to_owned(), "compacting"),
                    CompactProgress::CheckingIntegrity => {
                        ("Checking integrity…".to_owned(), "checking integrity")
                    }
                };
                eprintln!("{line}");
                *activity
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = current;
            }
        })),
    };
    let report = run_with_progress(
        persistence::compact_store(root, options),
        &cancellation,
        &activity,
    )
    .await?;
    let backup = format_bytes(report.plan.backup_bytes);
    if report.dry_run {
        match report.plan.estimated_reclaim_bytes {
            Some(reclaim) => eprintln!(
                "Compaction would reclaim about {} and first take a {backup} backup.",
                format_bytes(reclaim)
            ),
            None => eprintln!(
                "The real run first writes back the changes left in state.sqlite-wal, then takes a backup of at most {backup}."
            ),
        }
        eprintln!(
            "A dry run does not check whether another program has the database open. The real run refuses at once if one does, before taking the backup."
        );
    } else {
        let before = report.before.file_bytes + report.before.wal_bytes;
        let after = report
            .after
            .as_ref()
            .map_or(0, |after| after.file_bytes + after.wal_bytes);
        eprintln!(
            "Done: {} → {}. The pre-compact backup ({backup}) is kept until newer backups replace it.",
            format_bytes(before),
            format_bytes(after)
        );
    }
    Ok(report)
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingOfferOutput {
    id: String,
    code: String,
    link: String,
    reach: String,
    endpoint: String,
    name: String,
    expires_at: String,
}

/// Opens an existing data root beside a running server: shared runtime lock,
/// existing database only, never `prepare_store`.
async fn open_existing_data_root(
    root: &ResolvedDataRoot,
    dev_url: Option<url::Url>,
) -> Result<
    (
        persistence::StoreRuntimeGuard,
        persistence::StatePaths,
        persistence::Database,
    ),
    RunError,
> {
    let runtime_guard = persistence::StoreRuntimeGuard::acquire(&root.effective)
        .await
        .map_err(|error| RunError::PairingIssue(error.to_string()))?;
    let mut config = ServerConfig::new(&root.effective);
    config.dev_url = dev_url;
    let paths = persistence::StatePaths::from_config(&config);
    // Under the shared runtime lock, so a restore or `--resume` cannot start meanwhile.
    persistence::ensure_no_interrupted_recovery(&paths)
        .map_err(|error| RunError::PairingIssue(error.to_string()))?;
    if !paths.database.exists() {
        let (other_state, remedy) = match paths.state_kind {
            persistence::StateKind::Userdata => (
                "dev",
                "pass the same --dev-url as the server (or set VITE_DEV_SERVER_URL) to mint for that development store",
            ),
            persistence::StateKind::Dev => (
                "userdata",
                "drop --dev-url (and unset VITE_DEV_SERVER_URL) to mint for that userdata store",
            ),
        };
        let other_database = root.effective.join(other_state).join("state.sqlite");
        if other_database.exists() {
            return Err(RunError::PairingIssue(format!(
                "no BiBCode data store at {}; a data store exists at {}; {remedy}",
                paths.database.display(),
                other_database.display()
            )));
        }
        return Err(RunError::PairingIssue(format!(
            "no BiBCode data store at {}; start the server on this data root first",
            paths.database.display()
        )));
    }
    let database = persistence::Database::open_existing(&paths.database)
        .await
        .map_err(|error| RunError::PairingIssue(error.to_string()))?;
    Ok((runtime_guard, paths, database))
}

/// Issues pairing credentials against a data root.
///
/// Coexists with a running server on the same root: it takes the shared store
/// runtime lock (blocking only offline recovery) and writes through the WAL
/// database, and the server consumes pairing links from the database. Prints
/// exactly one JSON line to stdout in `--json` mode — the desktop SSH launcher
/// parses the last non-empty stdout line — and never initializes logging or
/// other stdout writers.
async fn run_pairing_command(command: PairingCommand) -> Result<(), RunError> {
    match command {
        PairingCommand::Issue {
            root,
            dev_url,
            label,
            json,
        } => {
            let (_runtime_guard, _paths, database) =
                open_existing_data_root(&root, dev_url).await?;
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
        PairingCommand::Offer {
            root,
            dev_url,
            endpoint,
            reach,
            name,
            label,
            access,
            json,
        } => {
            let name = name.unwrap_or_else(default_pairing_offer_name);
            // The authorized-clients row says what a diagnostics credential is.
            let label = match access {
                PairingAccess::Full => label,
                PairingAccess::Diagnostics => {
                    label.or_else(|| Some(format!("{} (diagnostics)", name.trim())))
                }
            };
            let scopes = match access {
                PairingAccess::Full => auth::default_standard_scopes(),
                PairingAccess::Diagnostics => auth::diagnostics_scopes(),
            };
            let input =
                auth::validate_pairing_offer_input(&name, &endpoint, &reach, label.as_deref())
                    .map_err(|error| RunError::PairingIssue(error.to_string()))?;
            let (_runtime_guard, paths, database) = open_existing_data_root(&root, dev_url).await?;
            let storage_instance_id = persistence::read_storage_instance_id(&paths)
                .map_err(|error| RunError::PairingIssue(error.to_string()))?;
            let secret_store = auth::SecretStore::new(paths.secrets_dir.clone())
                .await
                .map_err(|error| RunError::PairingIssue(error.to_string()))?;
            let repositories = persistence::Repositories::new(database.clone());
            let minted = auth::mint_offline_pairing_offer(
                &repositories,
                &secret_store,
                storage_instance_id,
                input,
                scopes,
            )
            .await
            .map_err(|error| RunError::PairingIssue(error.to_string()));
            database.close().await;
            let minted = minted?;
            let output = PairingOfferOutput {
                id: minted.id,
                code: minted.code,
                link: minted.link,
                reach: minted.reach,
                endpoint: minted.endpoint,
                name: minted.name,
                expires_at: minted.expires_at,
            };
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&output).map_err(RunError::PairingOutput)?
                );
            } else {
                println!("Pairing link: {}", output.link);
                println!("Expires at: {}", output.expires_at);
            }
            Ok(())
        }
    }
}

/// Installs, removes, or inspects the per-user background service. Runs the
/// platform's user-level service manager as the current user and prints one
/// report; nothing is printed on stdout when a step fails.
fn run_service_command(command: ServiceCommand) -> Result<(), RunError> {
    let platform = service_manager::ServicePlatform::current()
        .ok_or(service_manager::ServiceError::UnsupportedPlatform)?;
    let locations = service_manager::ServiceLocations::detect(platform)?;
    let runner = service_manager::ProcessCommandRunner;
    let (report, json) = match command {
        ServiceCommand::Install { spec, json } => (
            service_manager::install(&spec, platform, &locations, &runner)?,
            json,
        ),
        ServiceCommand::Uninstall { json } => (
            service_manager::uninstall(platform, &locations, &runner)?,
            json,
        ),
        ServiceCommand::Status { json } => (
            service_manager::status(platform, &locations, &runner)?,
            json,
        ),
    };
    if json {
        println!(
            "{}",
            serde_json::to_string(&report).map_err(RunError::ServiceOutput)?
        );
    } else {
        let state = serde_json::to_value(report.state).map_err(RunError::ServiceOutput)?;
        println!("Service: {}", report.definition);
        println!("State: {}", state.as_str().unwrap_or("unknown"));
        for note in &report.notes {
            println!("Note: {note}");
        }
    }
    Ok(())
}

/// Display name embedded in offers when the caller gives none.
pub(crate) fn default_pairing_offer_name() -> String {
    config::machine_host_name().unwrap_or_else(|| "BiBCode server".to_owned())
}

#[cfg(unix)]
async fn termination_signal() -> Result<(), std::io::Error> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate())?;
    let received = tokio::select! {
        result = tokio::signal::ctrl_c() => result,
        _ = terminate.recv() => Ok(()),
    };
    if received.is_ok() {
        // A logout or a service stop signals the providers too; their deaths are not crashes.
        diagnostics::profiler::exits::note_terminating();
    }
    received
}

#[cfg(not(unix))]
async fn termination_signal() -> Result<(), std::io::Error> {
    let received = tokio::signal::ctrl_c().await;
    if received.is_ok() {
        // The console's Ctrl-C reaches the providers too; their deaths are not crashes.
        diagnostics::profiler::exits::note_terminating();
    }
    received
}

#[cfg(test)]
mod storage_cli_tests {
    use super::*;
    use std::time::Duration;

    fn listing(root: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut entries = Vec::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(&directory).expect("listing") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    pending.push(path.clone());
                }
                entries.push(path);
            }
        }
        entries.sort();
        entries
    }

    #[test]
    fn long_operation_lines_name_the_size_and_limit() {
        let gib = 1024 * 1024 * 1024;
        assert_eq!(
            backup_progress_line(0, Duration::from_secs(30)),
            "Backing up 0 B before compacting. This can take up to 30 seconds; press Ctrl-C to stop without changing the database."
        );
        assert_eq!(
            backup_progress_line(
                7 * gib,
                persistence::StoreIoBudget::LARGE_STORE.for_bytes(7 * gib)
            ),
            "Backing up 7.5 GB before compacting. This can take up to 29 minutes; press Ctrl-C to stop without changing the database."
        );
        assert_eq!(
            still_working_line("backing up", Duration::from_secs(30)),
            "Still backing up (30 s elapsed)…"
        );
        assert_eq!(
            still_working_line("restoring", Duration::from_secs(125)),
            "Still restoring (2 min elapsed)…"
        );
        let backup_id = uuid::Uuid::nil();
        assert_eq!(
            restore_progress_line(backup_id),
            format!(
                "Restoring backup {backup_id}. Press Ctrl-C to stop before the current database is replaced."
            )
        );
        let deadline = persistence::RecoveryError::RestoreDeadline {
            budget: Duration::from_secs(1_710),
            bytes: 7 * gib,
        };
        assert!(
            deadline.to_string().starts_with(
                "The restore did not finish within 29 minutes, the limit for a 7.5 GB backup"
            ),
            "{deadline}"
        );
        let short = persistence::RecoveryError::RestoreDeadline {
            budget: Duration::from_secs(30),
            bytes: 0,
        };
        assert!(short.to_string().contains("within 30 seconds"), "{short}");
    }

    #[tokio::test]
    async fn pairing_refuses_to_open_a_store_during_an_interrupted_recovery() {
        for interrupted in ["journal", "staging"] {
            let temp = tempfile::tempdir().expect("data root");
            let root = data_root::resolve_data_root(data_root::DataRootRequest::explicit(
                data_root::DataRootSource::Cli,
                temp.path().to_path_buf(),
                temp.path().to_path_buf(),
            ))
            .expect("resolve root");
            let paths = persistence::StatePaths::from_config(&ServerConfig::new(&root.effective));
            std::fs::create_dir_all(&paths.state_dir).expect("state directory");
            std::fs::write(&paths.database, b"left by an interrupted restore").expect("database");
            std::fs::write(paths.runtime_lock(), b"").expect("runtime lock");
            if interrupted == "journal" {
                std::fs::write(paths.recovery_journal(), b"{}\n").expect("journal");
            } else {
                let staging = paths.recovery_staging_dir(uuid::Uuid::new_v4());
                std::fs::create_dir(&staging).expect("staging");
            }
            let before = listing(&root.effective);

            let Err(RunError::PairingIssue(message)) = open_existing_data_root(&root, None).await
            else {
                panic!("the pairing CLI must refuse an interrupted recovery");
            };

            assert!(
                message.contains(persistence::RESUME_COMMAND),
                "{interrupted}: {message}"
            );
            assert_eq!(
                listing(&root.effective),
                before,
                "{interrupted}: no file created"
            );
            assert_eq!(
                std::fs::read(&paths.database).expect("database"),
                b"left by an interrupted restore"
            );
        }
    }
}
