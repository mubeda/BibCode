//! Settings → Agent integrations → Connect an agent (#139): adds BiBCode's stdio relay to
//! Claude Code, Codex, Cursor or OpenCode on the server's own host, reads whether it is there,
//! and removes it.
//!
//! Claude Code and Codex are changed through their own `mcp get`, `add` and `remove`
//! commands. Cursor's CLI cannot add a server and OpenCode's asks interactively, so for them
//! BiBCode edits the documented user config (`~/.cursor/mcp.json`,
//! `~/.config/opencode/opencode.json`): it changes only the `bibcode` entry, keeps every other
//! key in order, refuses a file that is not plain JSON, and replaces the file atomically.
//!
//! `mcpClients.getRegistrations` (`access:read`), `mcpClients.register` and
//! `mcpClients.unregister` (`access:write`): an outside agent's `mcp-client` session holds no
//! `access:*` scope, so no agent can change a person's tool configuration.

mod cli;
mod config_file;
#[cfg(all(test, unix))]
mod tests;

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::production::{
    provider_inventory, provider_runtime::resolve_provider_executable_with_environment,
};

/// The name BiBCode registers under in every tool.
const SERVER_NAME: &str = "bibcode";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum McpClient {
    Claude,
    Codex,
    Cursor,
    Opencode,
}

impl McpClient {
    const ALL: [Self; 4] = [Self::Claude, Self::Codex, Self::Cursor, Self::Opencode];

    const fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Opencode => "opencode",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
            Self::Opencode => "OpenCode",
        }
    }

    /// The provider driver whose `binaryPath` and environment locate this tool's CLI.
    const fn driver(self) -> &'static str {
        match self {
            Self::Claude => "claudeAgent",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Opencode => "opencode",
        }
    }
}

/// Where this host keeps its people's tool settings.
pub(crate) struct Host {
    home: PathBuf,
    /// `$XDG_CONFIG_HOME`, else `~/.config`: where OpenCode keeps `opencode/opencode.json`.
    config_home: PathBuf,
}

impl Host {
    /// The server's own user. `fallback` stands in for a home directory that cannot be found.
    pub(crate) fn current(fallback: &Path) -> Self {
        let home = dirs::home_dir()
            .filter(|home| home.is_dir())
            .unwrap_or_else(|| fallback.to_path_buf());
        let config_home = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        Self { home, config_home }
    }

    #[cfg(all(test, unix))]
    fn for_home(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            config_home: home.join(".config"),
        }
    }
}

/// How BiBCode changes one tool on this host.
enum Target {
    Cli(cli::Cli),
    File(config_file::ConfigFile),
}

/// Whether the provider settings' CLI for this driver is on this host.
fn provider_cli_found(settings: &Value, driver: &str) -> bool {
    provider_inventory::maintenance_target(settings, driver, None).is_some_and(|target| {
        resolve_provider_executable_with_environment(
            &target.binary_path,
            target
                .environment
                .iter()
                .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
        )
        .is_some()
    })
}

/// The tool on this host, or `None` when it is not installed. Cursor counts as installed when
/// its CLI is found or `~/.cursor` exists; BiBCode never creates a folder for a tool it did not
/// find.
fn locate(settings: &Value, client: McpClient, host: &Host) -> Option<Target> {
    match client {
        McpClient::Claude | McpClient::Codex => cli::locate(settings, client).map(Target::Cli),
        McpClient::Cursor => {
            let directory = host.home.join(".cursor");
            (provider_cli_found(settings, client.driver()) || directory.is_dir())
                .then(|| Target::File(config_file::ConfigFile::cursor(directory, &host.home)))
        }
        McpClient::Opencode => provider_cli_found(settings, client.driver()).then(|| {
            Target::File(config_file::ConfigFile::opencode(
                host.config_home.join("opencode"),
                &host.home,
            ))
        }),
    }
}

impl Target {
    async fn is_registered(
        &self,
        host: &Host,
        cancellation: &CancellationToken,
    ) -> Result<bool, Value> {
        match self {
            Self::Cli(cli) => cli.is_registered(&host.home, cancellation).await,
            Self::File(file) => file.is_registered().await,
        }
    }

    async fn add(&self, launch: &[String], host: &Host) -> Result<(), Value> {
        match self {
            Self::Cli(cli) => cli.add(launch, &host.home).await,
            Self::File(file) => file.add(launch).await,
        }
    }

    async fn remove(&self, host: &Host) -> Result<(), Value> {
        match self {
            Self::Cli(cli) => cli.remove(&host.home).await,
            Self::File(file) => file.remove().await,
        }
    }
}

fn refusal(reason: &str, message: &str) -> Value {
    json!({ "_tag": "McpClientRegistrationError", "reason": reason, "message": message })
}

fn not_installed(client: McpClient) -> Value {
    refusal(
        "not_installed",
        &format!(
            "{} isn't installed where BiBCode runs. Install it, or set its path in its provider settings, then try again.",
            client.label()
        ),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientInput {
    client: McpClient,
}

fn decode(payload: Value) -> Result<McpClient, Value> {
    serde_json::from_value::<ClientInput>(payload)
        .map(|input| input.client)
        .map_err(|error| refusal("invalid", &format!("Invalid request: {error}")))
}

fn status(client: McpClient, installed: bool, registered: bool, error: Option<&Value>) -> Value {
    json!({
        "client": client.id(),
        "installed": installed,
        "registered": registered,
        "error": error.and_then(|error| error.get("message")).cloned().unwrap_or(Value::Null),
    })
}

/// `mcpClients.getRegistrations`: each tool's state, read in parallel. A tool that cannot be
/// read reports its own `error` instead of failing the whole read.
pub(crate) async fn registrations(
    settings: &Value,
    host: &Host,
    cancellation: &CancellationToken,
) -> Value {
    let reads = McpClient::ALL.map(|client| async move {
        let Some(target) = locate(settings, client, host) else {
            return status(client, false, false, None);
        };
        match target.is_registered(host, cancellation).await {
            Ok(registered) => status(client, true, registered, None),
            Err(error) => status(client, true, false, Some(&error)),
        }
    });
    let [claude, codex, cursor, opencode] = reads;
    let (claude, codex, cursor, opencode) = tokio::join!(claude, codex, cursor, opencode);
    json!({ "clients": [claude, codex, cursor, opencode] })
}

/// `mcpClients.register`: adds `bibcode` with this server's launch command, replacing an
/// entry by that name.
pub(crate) async fn register(
    settings: &Value,
    launch: Option<Vec<String>>,
    payload: Value,
    host: &Host,
) -> Result<Value, Value> {
    let client = decode(payload)?;
    let Some(launch) = launch.filter(|launch| !launch.is_empty()) else {
        return Err(refusal(
            "unsupported",
            "This server cannot name its own executable, so it cannot add itself. Use Other MCP clients instead.",
        ));
    };
    let target = locate(settings, client, host).ok_or_else(|| not_installed(client))?;
    target.add(&launch, host).await?;
    tracing::info!(client = client.id(), "added BiBCode to an MCP client");
    Ok(status(client, true, true, None))
}

/// `mcpClients.unregister`: removes `bibcode` and nothing else. An entry that is already
/// gone is success.
pub(crate) async fn unregister(
    settings: &Value,
    payload: Value,
    host: &Host,
) -> Result<Value, Value> {
    let client = decode(payload)?;
    let target = locate(settings, client, host).ok_or_else(|| not_installed(client))?;
    target.remove(host).await?;
    tracing::info!(client = client.id(), "removed BiBCode from an MCP client");
    Ok(status(client, true, false, None))
}
