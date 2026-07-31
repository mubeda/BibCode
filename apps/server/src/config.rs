use std::{
    fmt,
    io::{self, BufRead},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::{fs::File, io::BufReader, os::fd::FromRawFd};

use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::Deserialize;
use thiserror::Error;
use url::Url;

pub const DEFAULT_PORT: u16 = 3773;

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
    pub static_dir: Option<PathBuf>,
    pub dev_url: Option<Url>,
    pub no_browser: bool,
    pub desktop_bootstrap_token: Option<String>,
    pub unsafe_no_auth: bool,
    pub environment_id: String,
    pub environment_label: String,
    pub server_version: String,
}

impl ServerConfig {
    pub fn new(base_dir: impl AsRef<Path>) -> Self {
        Self {
            mode: ServerMode::Web,
            host: "127.0.0.1".to_owned(),
            port: DEFAULT_PORT,
            base_dir: base_dir.as_ref().to_path_buf(),
            static_dir: None,
            dev_url: None,
            no_browser: false,
            desktop_bootstrap_token: None,
            unsafe_no_auth: false,
            environment_id: "local".to_owned(),
            environment_label: "Local".to_owned(),
            server_version: env!("CARGO_PKG_VERSION").to_owned(),
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
    pub fn with_dev_url(mut self, dev_url: Url) -> Self {
        self.dev_url = Some(dev_url);
        self
    }

    #[must_use]
    pub fn with_unsafe_no_auth(mut self) -> Self {
        self.unsafe_no_auth = true;
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
}

#[derive(Clone, Debug, Default, Args)]
struct ServerArgs {
    #[arg(long, value_enum, env = "BIBCODE_MODE", global = true)]
    mode: Option<ServerMode>,

    #[arg(long, env = "BIBCODE_HOST", global = true)]
    host: Option<String>,

    #[arg(long, env = "BIBCODE_PORT", global = true)]
    port: Option<u16>,

    #[arg(long, env = "BIBCODE_HOME", global = true)]
    base_dir: Option<PathBuf>,

    #[arg(long, global = true)]
    static_dir: Option<PathBuf>,

    #[arg(long, env = "VITE_DEV_SERVER_URL", global = true)]
    dev_url: Option<Url>,

    #[arg(long, env = "BIBCODE_NO_BROWSER", global = true)]
    no_browser: bool,

    #[arg(long, env = "BIBCODE_BOOTSTRAP_FD", global = true)]
    bootstrap_fd: Option<i32>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(transparent)]
    IdentityPath(#[from] crate::identity_paths::IdentityPathMigrationError),
    #[error("invalid value for legacy environment variable {name}: {value}")]
    InvalidLegacyEnvironment { name: &'static str, value: String },
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
    #[error("failed to resolve the default server base directory")]
    CurrentDirectory(#[source] io::Error),
    #[error("the current user's home directory is unavailable")]
    HomeDirectoryUnavailable,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrap {
    mode: ServerModeWire,
    no_browser: bool,
    port: u16,
    #[serde(alias = "t4codeHome")]
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
        let headless = matches!(self.command, Some(CliCommand::Serve));
        let args = self.root;
        let bootstrap = args.bootstrap_fd.map(read_bootstrap).transpose()?.flatten();

        let legacy_mode = if args.mode.is_none() {
            crate::environment_identity::bibcode_env_string("BIBCODE_MODE", "T4CODE_MODE")
                .map(|value| {
                    ServerMode::from_str(&value, true).map_err(|_| {
                        ConfigError::InvalidLegacyEnvironment {
                            name: "T4CODE_MODE",
                            value,
                        }
                    })
                })
                .transpose()?
        } else {
            None
        };
        let legacy_base_dir = args.base_dir.is_none().then(|| {
            crate::environment_identity::bibcode_env_var("BIBCODE_HOME", "T4CODE_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        }).flatten();
        let legacy_host = args.host.is_none().then(|| {
            crate::environment_identity::bibcode_env_string("BIBCODE_HOST", "T4CODE_HOST")
        }).flatten();
        let legacy_port = if args.port.is_none() {
            crate::environment_identity::bibcode_env_string("BIBCODE_PORT", "T4CODE_PORT")
                .map(|value| {
                    value.parse().map_err(|_| ConfigError::InvalidLegacyEnvironment {
                        name: "T4CODE_PORT",
                        value,
                    })
                })
                .transpose()?
        } else {
            None
        };

        let mode = args
            .mode
            .or(legacy_mode)
            .or_else(|| {
                bootstrap.as_ref().map(|value| match value.mode {
                    ServerModeWire::Desktop => ServerMode::Desktop,
                })
            })
            .unwrap_or_default();
        let raw_base_dir = args
            .base_dir
            .or(legacy_base_dir)
            .or_else(|| {
                bootstrap
                    .as_ref()
                    .and_then(|value| value.bibcode_home.clone())
            });
        let base_dir = match raw_base_dir {
            Some(path) => resolve_base_dir(path)?,
            None => default_base_dir()?,
        };
        let host = args
            .host
            .or(legacy_host)
            .or_else(|| bootstrap.as_ref().map(|value| value.host.clone()))
            .unwrap_or_else(|| "127.0.0.1".to_owned());
        let port = args
            .port
            .or(legacy_port)
            .or_else(|| bootstrap.as_ref().map(|value| value.port))
            .unwrap_or(DEFAULT_PORT);

        let mut config = ServerConfig::new(base_dir).with_bind(host, port);
        config.mode = mode;
        config.static_dir = args.static_dir;
        config.dev_url = args.dev_url;
        let legacy_no_browser = if args.no_browser {
            false
        } else {
            legacy_environment_bool("BIBCODE_NO_BROWSER", "T4CODE_NO_BROWSER")?
        };
        config.no_browser = headless
            || args.no_browser
            || legacy_no_browser
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
        Ok(config)
    }
}

fn legacy_environment_bool(
    canonical_name: &'static str,
    legacy_name: &'static str,
) -> Result<bool, ConfigError> {
    let Some(value) = crate::environment_identity::bibcode_env_string(canonical_name, legacy_name)
    else {
        return Ok(false);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(ConfigError::InvalidLegacyEnvironment {
            name: legacy_name,
            value,
        }),
    }
}

fn default_base_dir() -> Result<PathBuf, ConfigError> {
    let home = dirs::home_dir().ok_or(ConfigError::HomeDirectoryUnavailable)?;
    migrate_identity_base_dir(home.join(".bibcode"))
}

fn resolve_base_dir(path: PathBuf) -> Result<PathBuf, ConfigError> {
    let path = match path.strip_prefix("~") {
        Ok(relative) => dirs::home_dir()
            .map(|home| home.join(relative))
            .ok_or(ConfigError::HomeDirectoryUnavailable)?,
        Err(_) => path,
    };
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(ConfigError::CurrentDirectory)?
    };
    migrate_identity_base_dir(path)
}

fn migrate_identity_base_dir(path: PathBuf) -> Result<PathBuf, ConfigError> {
    if path.file_name().is_some_and(|name| name == ".bibcode") {
        let legacy_path = path.with_file_name(".t4code");
        return crate::identity_paths::resolve_bibcode_directory(&path, &legacy_path)
            .map_err(ConfigError::from);
    }
    Ok(path)
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
