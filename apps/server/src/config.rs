use std::{
    fmt,
    io::{self, BufRead},
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(unix)]
use std::{fs::File, io::BufReader, os::fd::FromRawFd};

use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::Deserialize;
use thiserror::Error;
use url::Url;

use crate::data_root::{DataRootError, DataRootRequest, DataRootSource, ResolvedDataRoot};
use crate::persistence::{EnvironmentId, StorageInstanceId};
use crate::service::ServiceMode;
use crate::transport::TransportIdentity;

pub const DEFAULT_PORT: u16 = 3773;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TlsFiles {
    pub certificate_chain: PathBuf,
    pub private_key: PathBuf,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum ServerMode {
    Desktop,
    #[default]
    Web,
}

impl fmt::Display for ServerMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Desktop => formatter.write_str("desktop"),
            Self::Web => formatter.write_str("web"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub mode: ServerMode,
    pub host: String,
    pub port: u16,
    pub base_dir: PathBuf,
    pub data_root_request: DataRootRequest,
    pub resolved_data_root: Option<ResolvedDataRoot>,
    pub tls: Option<TlsFiles>,
    pub static_dir: Option<PathBuf>,
    pub dev_url: Option<Url>,
    pub no_browser: bool,
    pub desktop_bootstrap_token: Option<String>,
    pub unsafe_no_auth: bool,
    pub environment_id: Option<EnvironmentId>,
    pub environment_label: String,
    pub server_version: String,
    pub storage_instance_id: Option<StorageInstanceId>,
    pub(crate) transport_identity: TransportIdentity,
    pub(crate) managed_service_launch: bool,
    pub(crate) service_stop_drain_timeout: Duration,
    pub(crate) update_maintenance_drain_timeout: Duration,
    pub(crate) update_maintenance_lease: Duration,
}

impl ServerConfig {
    pub fn new(base_dir: impl AsRef<Path>) -> Self {
        let base_dir = base_dir.as_ref().to_path_buf();
        Self {
            mode: ServerMode::Web,
            host: "127.0.0.1".to_owned(),
            port: DEFAULT_PORT,
            data_root_request: DataRootRequest::explicit(
                DataRootSource::Cli,
                base_dir.clone(),
                dirs::home_dir().unwrap_or_default(),
            ),
            resolved_data_root: None,
            base_dir,
            tls: None,
            static_dir: None,
            dev_url: None,
            no_browser: false,
            desktop_bootstrap_token: None,
            unsafe_no_auth: false,
            environment_id: None,
            environment_label: "Local".to_owned(),
            server_version: env!("CARGO_PKG_VERSION").to_owned(),
            storage_instance_id: None,
            transport_identity: TransportIdentity::LoopbackHttp,
            managed_service_launch: false,
            service_stop_drain_timeout: Duration::from_secs(40),
            update_maintenance_drain_timeout: Duration::from_secs(30),
            update_maintenance_lease: Duration::from_secs(90),
        }
    }

    #[must_use]
    pub fn with_bind(mut self, host: impl Into<String>, port: u16) -> Self {
        self.host = host.into();
        self.port = port;
        self
    }

    pub fn with_desktop(mut self, bootstrap_token: impl Into<String>) -> Result<Self, ConfigError> {
        let bootstrap_token = bootstrap_token.into();
        if bootstrap_token.trim().is_empty() {
            return Err(ConfigError::EmptyDesktopBootstrapToken);
        }
        self.mode = ServerMode::Desktop;
        self.no_browser = true;
        self.desktop_bootstrap_token = Some(bootstrap_token);
        Ok(self)
    }

    #[must_use]
    pub fn with_static_dir(mut self, static_dir: impl AsRef<Path>) -> Self {
        self.static_dir = Some(static_dir.as_ref().to_path_buf());
        self
    }

    #[must_use]
    pub fn with_tls_files(mut self, tls: TlsFiles) -> Self {
        self.tls = Some(tls);
        self
    }

    #[doc(hidden)]
    #[must_use]
    pub fn with_service_managed_launch(mut self) -> Self {
        self.managed_service_launch = true;
        self
    }

    /// Overrides service-stop drain timing for deterministic integration tests.
    #[doc(hidden)]
    #[must_use]
    pub fn with_service_stop_drain_timeout_for_integration_test(
        mut self,
        drain_timeout: Duration,
    ) -> Self {
        self.service_stop_drain_timeout = drain_timeout;
        self
    }

    #[must_use]
    pub fn with_dev_url(mut self, dev_url: Url) -> Self {
        self.dev_url = Some(dev_url);
        self
    }

    #[must_use]
    pub fn with_unsafe_no_auth(mut self) -> Self {
        self.unsafe_no_auth = true;
        self
    }

    /// Overrides maintenance timing for deterministic integration tests.
    #[doc(hidden)]
    #[must_use]
    pub fn with_update_maintenance_timing_for_integration_test(
        mut self,
        drain_timeout: Duration,
        lease: Duration,
    ) -> Self {
        self.update_maintenance_drain_timeout = drain_timeout;
        self.update_maintenance_lease = lease;
        self
    }

    #[must_use]
    pub fn state_dir(&self) -> PathBuf {
        self.base_dir.join(if self.dev_url.is_some() {
            "dev"
        } else {
            "userdata"
        })
    }

    #[must_use]
    pub fn database_path(&self) -> PathBuf {
        self.state_dir().join("state.sqlite")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_root::DataRootSource;
    use clap::Parser;

    #[test]
    fn owned_builder_inputs_cover_desktop_and_static_configuration() {
        let state_dir = "state".to_owned();
        let static_dir = "static".to_owned();
        let config = ServerConfig::new(state_dir)
            .with_static_dir(static_dir)
            .with_desktop("desktop-token".to_owned())
            .expect("desktop config should build");
        assert_eq!(config.mode, ServerMode::Desktop);
        assert_eq!(
            config.desktop_bootstrap_token.as_deref(),
            Some("desktop-token")
        );
        assert_eq!(config.static_dir, Some(PathBuf::from("static")));
        assert!(
            ServerConfig::new("state")
                .with_desktop(String::new())
                .is_err()
        );
    }

    #[test]
    fn cli_base_dir_preserves_the_raw_cli_data_root_request() {
        let config = Cli::try_parse_from(["bibcode", "serve", "--base-dir", "/var/lib/bibcode"])
            .expect("parse CLI")
            .into_server_config()
            .expect("build server config");

        assert_eq!(config.data_root_request.source, DataRootSource::Cli);
        assert_eq!(
            config.data_root_request.requested,
            Some(PathBuf::from("/var/lib/bibcode"))
        );
    }

    #[test]
    fn environment_base_dir_preserves_the_raw_environment_data_root_request() {
        let request = select_data_root_request(
            None,
            Some(std::ffi::OsString::from("/var/lib/bibcode")),
            None,
            PathBuf::from("/home/alice"),
        );

        assert_eq!(request.source, DataRootSource::Environment);
        assert_eq!(request.requested, Some(PathBuf::from("/var/lib/bibcode")));
    }
}

#[derive(Debug, Parser)]
#[command(name = "bibcode", version, about = "Run the BiBCode server.")]
pub struct Cli {
    #[command(subcommand)]
    command: Option<CliCommand>,

    #[command(flatten)]
    root: ServerArgs,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    #[command(about = "Run the BiBCode server without opening a browser.")]
    Serve,
    #[command(about = "Run the BiBCode server.")]
    Start,
    #[command(about = "Inspect or explicitly recover offline project data.")]
    Storage(StorageArgs),
    #[command(about = "Manage environment authentication through local control.")]
    Auth(AuthArgs),
    #[command(about = "Manage the workstation or headless server service.")]
    Service(ServiceArgs),
}

#[derive(Debug, Args)]
struct ServiceArgs {
    #[arg(long, value_enum, default_value_t, global = true)]
    format: ServiceOutputFormat,

    #[command(subcommand)]
    command: ServiceSubcommand,
}

#[derive(Debug, Subcommand)]
enum ServiceSubcommand {
    #[command(about = "Inspect service registration and runtime state.")]
    Status,
    #[command(about = "Install and start a loopback-only managed service.")]
    Install {
        #[arg(
            long,
            help = "Replace an installed definition only after an explicit comparison."
        )]
        update: bool,
    },
    #[command(about = "Start an installed service.")]
    Start,
    #[command(about = "Drain and stop an installed service.")]
    Stop,
    #[command(about = "Drain and restart an installed service.")]
    Restart,
    #[command(about = "Remove service registration while preserving all project data.")]
    Uninstall,
}

#[derive(Debug, Args)]
struct AuthArgs {
    #[command(subcommand)]
    command: AuthSubcommand,
}

#[derive(Debug, Subcommand)]
enum AuthSubcommand {
    #[command(about = "Manage one-time pairing credentials.")]
    Pairing(PairingArgs),
}

#[derive(Debug, Args)]
struct PairingArgs {
    #[command(subcommand)]
    command: PairingSubcommand,
}

#[derive(Debug, Subcommand)]
enum PairingSubcommand {
    #[command(about = "Create a five-minute environment administrator pairing.")]
    Create {
        #[arg(long)]
        client_label: Option<String>,
        #[arg(long, value_enum, default_value_t)]
        format: PairingOutputFormat,
    },
}

#[derive(Debug, Args)]
struct StorageArgs {
    #[command(subcommand)]
    command: StorageSubcommand,
}

#[derive(Debug, Subcommand)]
enum StorageSubcommand {
    #[command(about = "Inspect an offline BiBCode project-data store.")]
    Inspect {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Restore a verified backup into an offline store.")]
    Restore {
        #[arg(long)]
        backup_id: uuid::Uuid,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "start-empty",
        about = "Preserve an offline store and start empty."
    )]
    StartEmpty {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Clone, Debug)]
pub enum CliAction {
    Run(Box<ServerConfig>),
    Storage(StorageCommand),
    Auth(AuthCommand),
    Service(ServiceCliCommand),
}

#[derive(Clone, Debug)]
pub struct ServiceCliCommand {
    pub operation: ServiceOperation,
    pub mode: ServiceMode,
    pub root: ResolvedDataRoot,
    pub bind: SocketAddr,
    pub format: ServiceOutputFormat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceOperation {
    Status,
    Install { update: bool },
    Start,
    Stop,
    Restart,
    Uninstall,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum ServiceOutputFormat {
    #[default]
    Human,
    Json,
}

#[derive(Clone, Debug)]
pub enum AuthCommand {
    CreatePairing {
        root: ResolvedDataRoot,
        client_label: Option<String>,
        format: PairingOutputFormat,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum PairingOutputFormat {
    #[default]
    Human,
    Json,
}

#[derive(Clone, Debug)]
pub enum StorageCommand {
    Inspect {
        root: ResolvedDataRoot,
        json: bool,
    },
    Restore {
        root: ResolvedDataRoot,
        backup_id: uuid::Uuid,
        json: bool,
    },
    StartEmpty {
        root: ResolvedDataRoot,
        json: bool,
    },
}

#[derive(Clone, Debug, Default, Args)]
struct ServerArgs {
    #[arg(long, env = "BIBCODE_MODE", global = true)]
    mode: Option<String>,

    #[arg(long, env = "BIBCODE_HOST", global = true)]
    host: Option<String>,

    #[arg(long, env = "BIBCODE_PORT", global = true)]
    port: Option<u16>,

    #[arg(long, global = true)]
    base_dir: Option<PathBuf>,

    #[arg(long, global = true)]
    static_dir: Option<PathBuf>,

    #[arg(long, requires = "tls_private_key", global = true)]
    tls_certificate_chain: Option<PathBuf>,

    #[arg(long, requires = "tls_certificate_chain", global = true)]
    tls_private_key: Option<PathBuf>,

    #[arg(long, env = "VITE_DEV_SERVER_URL", global = true)]
    dev_url: Option<Url>,

    #[arg(long, env = "BIBCODE_NO_BROWSER", global = true)]
    no_browser: bool,

    #[arg(long, env = "BIBCODE_BOOTSTRAP_FD", global = true)]
    bootstrap_fd: Option<i32>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("bootstrap file descriptor {0} is unsupported on this platform")]
    UnsupportedBootstrapFd(i32),
    #[error("failed to read the desktop bootstrap envelope")]
    BootstrapRead(#[source] io::Error),
    #[error("the desktop bootstrap envelope was empty")]
    EmptyBootstrap,
    #[error("failed to decode the desktop bootstrap envelope")]
    BootstrapDecode(#[source] serde_json::Error),
    #[error("desktop bootstrap token must not be empty")]
    EmptyDesktopBootstrapToken,
    #[error("storage commands cannot be converted into a server configuration")]
    StorageCommandIsNotServer,
    #[error("authentication commands cannot be converted into a server configuration")]
    AuthCommandIsNotServer,
    #[error("service commands cannot be converted into a server configuration")]
    ServiceCommandIsNotServer,
    #[error("invalid {command} mode {mode:?}; expected {expected}")]
    InvalidCommandMode {
        command: &'static str,
        mode: String,
        expected: &'static str,
    },
    #[error("managed services require a numeric loopback host, not {0:?}")]
    InvalidServiceHost(String),
    #[error(transparent)]
    DataRoot(#[from] DataRootError),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrap {
    mode: ServerModeWire,
    no_browser: bool,
    port: u16,
    bibcode_home: Option<PathBuf>,
    host: String,
    desktop_bootstrap_token: String,
    #[allow(dead_code)]
    tailscale_serve_enabled: bool,
    #[allow(dead_code)]
    tailscale_serve_port: u16,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ServerModeWire {
    Desktop,
}

impl Cli {
    pub fn into_server_config(self) -> Result<ServerConfig, ConfigError> {
        match self.into_action()? {
            CliAction::Run(config) => Ok(*config),
            CliAction::Storage(_) => Err(ConfigError::StorageCommandIsNotServer),
            CliAction::Auth(_) => Err(ConfigError::AuthCommandIsNotServer),
            CliAction::Service(_) => Err(ConfigError::ServiceCommandIsNotServer),
        }
    }

    pub fn into_action(self) -> Result<CliAction, ConfigError> {
        let Self {
            command,
            root: args,
        } = self;
        let command = match command {
            Some(CliCommand::Storage(storage)) => {
                let root = resolve_command_data_root(args.base_dir)?;
                return Ok(CliAction::Storage(match storage.command {
                    StorageSubcommand::Inspect { json } => StorageCommand::Inspect { root, json },
                    StorageSubcommand::Restore { backup_id, json } => StorageCommand::Restore {
                        root,
                        backup_id,
                        json,
                    },
                    StorageSubcommand::StartEmpty { json } => {
                        StorageCommand::StartEmpty { root, json }
                    }
                }));
            }
            Some(CliCommand::Auth(auth)) => {
                let root = resolve_command_data_root(args.base_dir)?;
                let AuthSubcommand::Pairing(pairing) = auth.command;
                let PairingSubcommand::Create {
                    client_label,
                    format,
                } = pairing.command;
                return Ok(CliAction::Auth(AuthCommand::CreatePairing {
                    root,
                    client_label,
                    format,
                }));
            }
            Some(CliCommand::Service(service)) => {
                let mode = parse_service_mode(args.mode.as_deref())?;
                let root = resolve_service_data_root(args.base_dir, mode)?;
                let host = args.host.unwrap_or_else(|| "127.0.0.1".to_owned());
                let ip = host
                    .parse::<IpAddr>()
                    .map_err(|_| ConfigError::InvalidServiceHost(host.clone()))?;
                if !ip.is_loopback() {
                    return Err(ConfigError::InvalidServiceHost(host));
                }
                let operation = match service.command {
                    ServiceSubcommand::Status => ServiceOperation::Status,
                    ServiceSubcommand::Install { update } => ServiceOperation::Install { update },
                    ServiceSubcommand::Start => ServiceOperation::Start,
                    ServiceSubcommand::Stop => ServiceOperation::Stop,
                    ServiceSubcommand::Restart => ServiceOperation::Restart,
                    ServiceSubcommand::Uninstall => ServiceOperation::Uninstall,
                };
                return Ok(CliAction::Service(ServiceCliCommand {
                    operation,
                    mode,
                    root,
                    bind: SocketAddr::new(ip, args.port.unwrap_or(DEFAULT_PORT)),
                    format: service.format,
                }));
            }
            command => command,
        };
        let headless = matches!(command, Some(CliCommand::Serve));
        let bootstrap = args.bootstrap_fd.map(read_bootstrap).transpose()?.flatten();

        let mode = args
            .mode
            .as_deref()
            .map(parse_server_mode)
            .transpose()?
            .or_else(|| {
                bootstrap.as_ref().map(|value| match value.mode {
                    ServerModeWire::Desktop => ServerMode::Desktop,
                })
            })
            .unwrap_or_default();
        let home_dir = dirs::home_dir().ok_or(DataRootError::HomeDirectoryUnavailable)?;
        let data_root_request = select_data_root_request(
            args.base_dir,
            bibcode_env_var("BIBCODE_HOME"),
            bootstrap
                .as_ref()
                .and_then(|value| value.bibcode_home.clone()),
            home_dir,
        );
        let host = args
            .host
            .or_else(|| bootstrap.as_ref().map(|value| value.host.clone()))
            .unwrap_or_else(|| "127.0.0.1".to_owned());
        let port = args
            .port
            .or_else(|| bootstrap.as_ref().map(|value| value.port))
            .unwrap_or(DEFAULT_PORT);

        let mut config = ServerConfig::new(
            data_root_request
                .requested
                .clone()
                .unwrap_or_else(|| data_root_request.home_dir.join(".bibcode")),
        )
        .with_bind(host, port);
        config.data_root_request = data_root_request;
        config.mode = mode;
        config.static_dir = args.static_dir;
        config.tls = args.tls_certificate_chain.zip(args.tls_private_key).map(
            |(certificate_chain, private_key)| TlsFiles {
                certificate_chain,
                private_key,
            },
        );
        config.dev_url = args.dev_url;
        config.no_browser = headless
            || args.no_browser
            || bootstrap.as_ref().is_some_and(|value| value.no_browser)
            || mode == ServerMode::Desktop;
        let desktop_bootstrap_token = bootstrap
            .as_ref()
            .map(|value| value.desktop_bootstrap_token.clone());
        if desktop_bootstrap_token
            .as_deref()
            .is_some_and(|token| token.trim().is_empty())
        {
            return Err(ConfigError::EmptyDesktopBootstrapToken);
        }
        config.desktop_bootstrap_token = desktop_bootstrap_token;
        Ok(CliAction::Run(Box::new(config)))
    }
}

fn resolve_command_data_root(
    cli_base_dir: Option<PathBuf>,
) -> Result<ResolvedDataRoot, ConfigError> {
    let home_dir = dirs::home_dir().ok_or(DataRootError::HomeDirectoryUnavailable)?;
    let request = select_data_root_request(
        cli_base_dir,
        bibcode_env_var("BIBCODE_HOME"),
        None,
        home_dir,
    );
    Ok(crate::data_root::resolve_data_root(request)?)
}

fn resolve_service_data_root(
    cli_base_dir: Option<PathBuf>,
    mode: ServiceMode,
) -> Result<ResolvedDataRoot, ConfigError> {
    if cli_base_dir.is_some() || bibcode_env_var("BIBCODE_HOME").is_some() {
        return resolve_command_data_root(cli_base_dir);
    }
    let home_dir = dirs::home_dir().ok_or(DataRootError::HomeDirectoryUnavailable)?;
    let requested = match mode {
        ServiceMode::Workstation => home_dir.join(".bibcode"),
        ServiceMode::Headless => default_headless_data_root(),
    };
    Ok(crate::data_root::resolve_data_root(
        DataRootRequest::explicit(DataRootSource::Default, requested, home_dir),
    )?)
}

#[cfg(target_os = "linux")]
fn default_headless_data_root() -> PathBuf {
    PathBuf::from("/var/lib/bibcode")
}

#[cfg(target_os = "macos")]
fn default_headless_data_root() -> PathBuf {
    PathBuf::from("/Library/Application Support/BiBCode")
}

#[cfg(windows)]
fn default_headless_data_root() -> PathBuf {
    std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("BiBCode")
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn default_headless_data_root() -> PathBuf {
    PathBuf::from("/var/lib/bibcode")
}

fn parse_service_mode(value: Option<&str>) -> Result<ServiceMode, ConfigError> {
    match value {
        None => Ok(ServiceMode::Workstation),
        Some(value) => {
            ServiceMode::from_str(value, true).map_err(|_| ConfigError::InvalidCommandMode {
                command: "service",
                mode: value.to_owned(),
                expected: "workstation or headless",
            })
        }
    }
}

fn parse_server_mode(value: &str) -> Result<ServerMode, ConfigError> {
    ServerMode::from_str(value, true).map_err(|_| ConfigError::InvalidCommandMode {
        command: "server",
        mode: value.to_owned(),
        expected: "desktop or web",
    })
}

fn bibcode_env_var(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name)
}

fn select_data_root_request(
    cli_base_dir: Option<PathBuf>,
    environment_base_dir: Option<std::ffi::OsString>,
    desktop_bootstrap_base_dir: Option<PathBuf>,
    home_dir: PathBuf,
) -> DataRootRequest {
    match (cli_base_dir, environment_base_dir) {
        (Some(path), _) => DataRootRequest::explicit(DataRootSource::Cli, path, home_dir),
        (None, Some(path)) => {
            DataRootRequest::explicit(DataRootSource::Environment, PathBuf::from(path), home_dir)
        }
        (None, None) => match desktop_bootstrap_base_dir {
            Some(path) => DataRootRequest::explicit(DataRootSource::Cli, path, home_dir),
            None => DataRootRequest::default(home_dir),
        },
    }
}

fn read_bootstrap(fd: i32) -> Result<Option<DesktopBootstrap>, ConfigError> {
    #[cfg(not(unix))]
    if fd != 0 {
        return Err(ConfigError::UnsupportedBootstrapFd(fd));
    }

    let mut line = String::new();
    let read = read_bootstrap_line(fd, &mut line).map_err(ConfigError::BootstrapRead)?;
    if read == 0 || line.trim().is_empty() {
        return Err(ConfigError::EmptyBootstrap);
    }
    let bootstrap = serde_json::from_str(&line).map_err(ConfigError::BootstrapDecode)?;
    Ok(Some(bootstrap))
}

#[cfg(unix)]
fn read_bootstrap_line(fd: i32, line: &mut String) -> Result<usize, io::Error> {
    if fd == 0 {
        return io::stdin().lock().read_line(line);
    }
    if fd < 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bootstrap file descriptor must be non-negative",
        ));
    }

    // SAFETY: the bootstrap fd is an inherited, one-shot descriptor whose
    // ownership is transferred to this process by the launcher contract.
    let file = unsafe { File::from_raw_fd(fd) };
    BufReader::new(file).read_line(line)
}

#[cfg(not(unix))]
fn read_bootstrap_line(fd: i32, line: &mut String) -> Result<usize, io::Error> {
    debug_assert_eq!(fd, 0);
    io::stdin().lock().read_line(line)
}
