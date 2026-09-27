//! Development-only live-check host for remote server updates. Not shipped.
//!
//! Usage: cargo run -p bibcode-server --example remote_update_fake_host -- \
//!   <base-dir> <port 4800-4899> <server-version> [label, default "Fake-host"]
//! Always binds 127.0.0.1. Pair separately with:
//!   bibcode pairing offer --base-dir <base-dir> --endpoint http://127.0.0.1:<port> \
//!     --reach this-computer --json
//! Prints {"event":"started","port":...,"serverVersion":...,"bootId":...} per start.
//! Commands on stdin, one JSON object per line:
//!   {"status":{"state":"downloading","latestVersion":"9.9.1","targetVersion":"9.9.1",
//!              "downloadPercent":42,"installStage":null,"error":null}}
//!   {"restart":{"serverVersion":"9.9.1","afterMs":2000}}
//!   {"stop":true}  // stop serving permanently, but keep reading stdin
//!   {"exit":true}  // shut down and exit; EOF does the same

use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, BufRead, Write},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use bibcode_server::{
    ENVIRONMENT_DESCRIPTOR_PATH, HostUpdaterFuture, HostUpdaterStatus, RemoteUpdateDelegate,
    RemoteUpdateInstallKind, RemoteUpdateInstallMode, RemoteUpdateRequester, RemoteUpdateState,
    RemoteUpdateSupport, RemoteUpdateSupportReason, ServerConfig, ServerHandle, ServerRuntime,
    diagnostics::UnavailableDesktopUiProcessObserver, resolve_data_root,
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScriptedStatus {
    state: Option<String>,
    latest_version: Option<String>,
    target_version: Option<String>,
    download_percent: Option<u8>,
    install_stage: Option<String>,
    error: Option<String>,
}

struct ScriptedDelegate(Arc<Mutex<ScriptedStatus>>);

impl ScriptedDelegate {
    fn current(&self) -> HostUpdaterStatus {
        let status = self.0.lock().expect("scripted status").clone();
        let state = match status.state.as_deref() {
            Some("checking") => RemoteUpdateState::Checking,
            Some("update-available") => RemoteUpdateState::UpdateAvailable,
            Some("downloading") => RemoteUpdateState::Downloading,
            Some("installing") => RemoteUpdateState::Installing,
            Some("up-to-date") => RemoteUpdateState::UpToDate,
            Some("error") => RemoteUpdateState::Error,
            _ => RemoteUpdateState::Idle,
        };
        HostUpdaterStatus {
            latest_version: status.latest_version,
            state,
            error: status.error,
            download_percent: status.download_percent,
            target_version: status.target_version,
            install_stage: status.install_stage,
        }
    }
}

impl RemoteUpdateDelegate for ScriptedDelegate {
    fn status(&self) -> HostUpdaterFuture {
        let status = self.current();
        Box::pin(async move { status })
    }

    fn check(&self) -> HostUpdaterFuture {
        self.status()
    }

    fn request_install(&self, requester: RemoteUpdateRequester) -> HostUpdaterFuture {
        eprintln!(
            "install requested label={} session={}",
            requester
                .label
                .as_deref()
                .unwrap_or("unknown")
                .replace(['\r', '\n'], " "),
            requester
                .session_id_prefix
                .as_deref()
                .unwrap_or("none")
                .replace(['\r', '\n'], " "),
        );
        self.status()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Status(ScriptedStatus),
    Restart(Restart),
    Stop(bool),
    Exit(bool),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Restart {
    server_version: String,
    #[serde(default = "default_restart_delay")]
    after_ms: u64,
}

fn default_restart_delay() -> u64 {
    2_000
}

fn read_commands() -> mpsc::Receiver<Command> {
    let (sender, receiver) = mpsc::channel(32);
    // Blocking stdin belongs to a plain thread, so exit does not leave a Tokio
    // blocking task waiting for input during runtime shutdown.
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    eprintln!("could not read stdin: {error}");
                    break;
                }
            };
            match serde_json::from_str(&line) {
                Ok(command) => {
                    if sender.blocking_send(command).is_err() {
                        break;
                    }
                }
                Err(error) => eprintln!(
                    "ignoring malformed stdin command at line {}, column {} ({:?})",
                    error.line(),
                    error.column(),
                    error.classify(),
                ),
            }
        }
        // Dropping the sender makes EOF follow the same cleanup path as exit.
    });
    receiver
}

fn disable_provider_processes(base_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let settings_dir = base_dir.join("userdata");
    fs::create_dir_all(&settings_dir)?;
    let file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(settings_dir.join("settings.json"))
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    serde_json::to_writer(
        file,
        &json!({
            "providers": {
                "codex": {"enabled": false},
                "claudeAgent": {"enabled": false},
                "cursor": {"enabled": false},
                "grok": {"enabled": false},
                "opencode": {"enabled": false}
            }
        }),
    )?;
    Ok(())
}

async fn report_started(handle: &ServerHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Descriptor {
        server_version: String,
        boot_id: String,
    }

    let descriptor: Descriptor = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?
        .get(format!(
            "http://{}{ENVIRONMENT_DESCRIPTOR_PATH}",
            handle.local_addr()
        ))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let mut stdout = io::stdout().lock();
    writeln!(
        stdout,
        "{}",
        json!({
            "event": "started",
            "port": handle.local_addr().port(),
            "serverVersion": descriptor.server_version,
            "bootId": descriptor.boot_id,
        })
    )?;
    stdout.flush()?;
    Ok(())
}

async fn start_server(
    base_dir: &Path,
    port: u16,
    version: &str,
    label: &str,
    status: Arc<Mutex<ScriptedStatus>>,
) -> Result<ServerHandle, Box<dyn std::error::Error>> {
    let mut config = ServerConfig::new(base_dir)
        .with_bind("127.0.0.1", port)
        .with_remote_update_support(RemoteUpdateSupport {
            install_mode: RemoteUpdateInstallMode::Interactive,
            reason: RemoteUpdateSupportReason::Available,
            install_kind: RemoteUpdateInstallKind::Unknown,
        });
    config.server_version = version.to_owned();
    config.environment_label = label.to_owned();
    config.no_browser = true;
    config.startup_pairing_offer = false;
    let handle = ServerRuntime::start_with_desktop_integration(
        config,
        Arc::new(UnavailableDesktopUiProcessObserver),
        Arc::new(ScriptedDelegate(status)),
    )
    .await?;
    if let Err(error) = report_started(&handle).await {
        handle.shutdown();
        handle.join().await?;
        return Err(error);
    }
    Ok(handle)
}

async fn shutdown(handle: &mut Option<ServerHandle>) -> Result<(), bibcode_server::ServerError> {
    if let Some(handle) = handle.take() {
        handle.shutdown();
        handle.join().await?;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let base_dir = args.next().ok_or("missing base-dir argument")?;
    let port = args
        .next()
        .ok_or("missing port argument (expected 4800-4899)")?
        .parse::<u16>()
        .ok()
        .filter(|port| (4800..=4899).contains(port))
        .ok_or("port must be in 4800-4899; port 3773 is forbidden")?;
    let mut version = args.next().ok_or("missing server-version argument")?;
    let label = args.next().unwrap_or_else(|| "Fake-host".to_owned());
    if args.next().is_some() {
        return Err("unexpected extra argument".into());
    }
    let data_root = resolve_data_root(ServerConfig::new(base_dir).data_root_request)?;
    let base_dir = data_root.effective.as_path();
    disable_provider_processes(base_dir)?;

    let status = Arc::new(Mutex::new(ScriptedStatus {
        state: Some("update-available".to_owned()),
        latest_version: Some("9.9.1".to_owned()),
        target_version: Some("9.9.1".to_owned()),
        ..ScriptedStatus::default()
    }));
    let mut handle = Some(start_server(base_dir, port, &version, &label, status.clone()).await?);
    let mut commands = read_commands();
    let mut restart_at = None;
    loop {
        let command = if let Some(deadline) = restart_at {
            tokio::select! {
                biased;
                command = commands.recv() => command,
                () = tokio::time::sleep_until(deadline) => {
                    *status.lock().expect("scripted status") = ScriptedStatus::default();
                    handle = Some(start_server(base_dir, port, &version, &label, status.clone()).await?);
                    restart_at = None;
                    continue;
                }
            }
        } else {
            commands.recv().await
        };
        match command {
            None | Some(Command::Exit(true)) => break,
            Some(Command::Stop(false) | Command::Exit(false)) => {
                eprintln!("ignoring malformed stdin command: stop and exit require true");
            }
            Some(_) if handle.is_none() && restart_at.is_none() => {
                eprintln!("host is stopped; ignoring command");
            }
            Some(Command::Status(update)) => {
                *status.lock().expect("scripted status") = update;
            }
            Some(Command::Restart(restart)) => {
                shutdown(&mut handle).await?;
                version = restart.server_version;
                restart_at =
                    Some(tokio::time::Instant::now() + Duration::from_millis(restart.after_ms));
            }
            Some(Command::Stop(true)) => {
                shutdown(&mut handle).await?;
                restart_at = None;
            }
        }
    }
    shutdown(&mut handle).await?;
    Ok(())
}
