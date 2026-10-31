//! Claude Code and Codex: their own `mcp get`, `mcp add` and `mcp remove` commands, run
//! through the supervised process runner in the home directory, so a read and a change see the
//! same scopes.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{McpClient, SERVER_NAME, State, not_installed, refusal};
use crate::{
    git::{OutputPolicy, ProcessError, ProcessRequest, ProcessRunner},
    production::{
        provider_inventory,
        provider_runtime::{
            normalize_provider_environment, prepare_provider_launch,
            resolve_provider_executable_with_environment,
        },
    },
};

/// `claude mcp get` health-checks the entry it finds, which starts `bibcode mcp` and connects.
const READ_TIMEOUT: Duration = Duration::from_secs(45);
const CHANGE_TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_LIMIT: usize = 64 * 1024;
/// What both CLIs print when the name is not registered.
const NOT_REGISTERED: &str = "No MCP server named";
const SUMMARY_LINES: usize = 3;
const SUMMARY_CHARS: usize = 300;

/// Removing on request: for Claude without `--scope`, so an entry in any scope goes.
const REMOVE_ARGS: [&str; 3] = ["mcp", "remove", SERVER_NAME];

/// One tool's CLI as BiBCode found it on this host.
pub(super) struct Cli {
    client: McpClient,
    executable: PathBuf,
    environment: Vec<(OsString, OsString)>,
}

struct Output {
    code: i32,
    stdout: String,
    /// stderr, else stdout: what the tool said, for messages.
    text: String,
}

/// What the tool says about `bibcode`.
enum Entry {
    Absent,
    /// Registered; the command it runs when its output could be read back.
    Present(Option<Stored>),
}

/// A registered entry's command as the tool shows it.
struct Stored {
    /// The command line as the tool prints it (Claude Code joins the arguments with spaces).
    shown: String,
    /// The command split back into its parts, when that is unambiguous.
    argv: Option<Vec<String>>,
}

/// `<tool> mcp get bibcode`: Codex prints JSON on request; Claude Code prints lines.
fn get_args(client: McpClient) -> &'static [&'static str] {
    match client {
        McpClient::Claude => &["mcp", "get", SERVER_NAME],
        _ => &["mcp", "get", SERVER_NAME, "--json"],
    }
}

/// `claude mcp get` prints `  Command: <command>` and `  Args: <args joined by spaces>`.
fn parse_claude_get(stdout: &str) -> Option<Stored> {
    let field = |name: &str| {
        stdout
            .lines()
            .find_map(|line| line.trim_start().strip_prefix(name).map(str::trim_end))
    };
    let command = field("Command: ")?;
    let args = field("Args:").map(str::trim).unwrap_or_default();
    let shown = if args.is_empty() {
        command.to_owned()
    } else {
        format!("{command} {args}")
    };
    Some(Stored {
        shown,
        argv: split_launch_args(args).map(|args| {
            let mut argv = vec![command.to_owned()];
            argv.extend(args);
            argv
        }),
    })
}

/// `codex mcp get bibcode --json`: `{ "transport": { "type": "stdio", "command", "args" } }`.
fn parse_codex_get(stdout: &str) -> Option<Stored> {
    let value = serde_json::from_str::<Value>(stdout.trim()).ok()?;
    let transport = value.get("transport")?;
    if transport.get("type")?.as_str()? != "stdio" {
        return None;
    }
    let mut argv = vec![transport.get("command")?.as_str()?.to_owned()];
    for arg in transport
        .get("args")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        argv.push(arg.as_str()?.to_owned());
    }
    Some(Stored {
        shown: argv.join(" "),
        argv: Some(argv),
    })
}

/// Space-joined arguments of a `bibcode mcp` command split back: `mcp`, then each
/// `--flag value`, where a value may hold spaces (a data root) but not ` --`. `None` when the
/// split would not join back to the same text.
fn split_launch_args(joined: &str) -> Option<Vec<String>> {
    if joined.is_empty() {
        return Some(Vec::new());
    }
    let mut pieces = joined.split(" --");
    let mut args = pieces
        .next()?
        .split(' ')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for piece in pieces {
        match piece.split_once(' ') {
            Some((flag, value)) => {
                args.push(format!("--{flag}"));
                args.push(value.to_owned());
            }
            None => args.push(format!("--{piece}")),
        }
    }
    (args.join(" ") == joined).then_some(args)
}

/// The start of a hand-typed add, for a message: the command follows it.
fn add_prefix(client: McpClient) -> &'static str {
    match client {
        McpClient::Claude => "claude mcp add --scope user bibcode --",
        _ => "codex mcp add bibcode --",
    }
}

/// The tool's CLI from its provider settings (`binaryPath`, else `claude`/`codex`, and the
/// provider's environment), as the provider probes find it. `None` when it is not installed.
pub(super) fn locate(settings: &Value, client: McpClient) -> Option<Cli> {
    let target = provider_inventory::maintenance_target(settings, client.driver(), None)?;
    let environment = || {
        target
            .environment
            .iter()
            .map(|(name, value)| (name.as_os_str(), value.as_os_str()))
    };
    let executable =
        resolve_provider_executable_with_environment(&target.binary_path, environment())?;
    Some(Cli {
        client,
        executable,
        environment: normalize_provider_environment(environment()),
    })
}

fn add_args(client: McpClient, launch: &[String]) -> Vec<String> {
    let mut args = match client {
        McpClient::Claude => vec!["mcp", "add", "--scope", "user", SERVER_NAME, "--"],
        _ => vec!["mcp", "add", SERVER_NAME, "--"],
    }
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    args.extend(launch.iter().cloned());
    args
}

/// Replacing BiBCode's own entry: Claude's user scope, where `add` put it.
fn replace_args(client: McpClient) -> &'static [&'static str] {
    match client {
        McpClient::Claude => &["mcp", "remove", "--scope", "user", SERVER_NAME],
        _ => &REMOVE_ARGS,
    }
}

impl Cli {
    async fn run<S: AsRef<str>>(
        &self,
        args: &[S],
        cwd: &Path,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<Output, Value> {
        let launch = prepare_provider_launch(
            &self.executable,
            args.iter().map(|arg| OsString::from(arg.as_ref())),
        )
        .map_err(|_| not_installed(self.client))?;
        let output = ProcessRunner
            .run(
                ProcessRequest {
                    operation: "mcp.clientRegistration".to_owned(),
                    command: launch.program,
                    args: launch.args,
                    cwd: cwd.to_path_buf(),
                    env: self.environment.clone(),
                    stdin: None,
                    timeout,
                    max_output_bytes: OUTPUT_LIMIT,
                    output_policy: OutputPolicy::Truncate,
                    append_truncation_marker: false,
                    allow_non_zero_exit: true,
                },
                cancellation,
            )
            .await
            .map_err(|error| self.process_error(&error))?;
        let text = if output.stderr.trim().is_empty() {
            output.stdout.clone()
        } else {
            output.stderr
        };
        Ok(Output {
            code: output.exit_code,
            stdout: output.stdout,
            text,
        })
    }

    /// The entry as `mcp get` shows it. Its command is read even when the exit code is not
    /// 0, as when `claude mcp get`'s health check of a stale entry fails.
    async fn entry(&self, cwd: &Path, cancellation: &CancellationToken) -> Result<Entry, Value> {
        let output = self
            .run(get_args(self.client), cwd, READ_TIMEOUT, cancellation)
            .await?;
        let stored = match self.client {
            McpClient::Claude => parse_claude_get(&output.stdout),
            _ => parse_codex_get(&output.stdout),
        };
        if stored.is_some() || output.code == 0 {
            Ok(Entry::Present(stored))
        } else if output.text.contains(NOT_REGISTERED) {
            Ok(Entry::Absent)
        } else {
            Err(self.failed("could not read its MCP servers", &output))
        }
    }

    pub(super) async fn read(
        &self,
        launch: Option<&[String]>,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<State, Value> {
        Ok(match self.entry(cwd, cancellation).await? {
            Entry::Absent => State::Absent,
            Entry::Present(stored) => State::Present {
                up_to_date: stored
                    .zip(launch)
                    .map(|(stored, launch)| stored.shown == launch.join(" ")),
            },
        })
    }

    /// Adds first, so a failing add never costs the person the entry they had. When the tool
    /// refuses because `bibcode` exists (Claude Code), the entry is read, removed and added
    /// again; if that add fails, the entry read is put back. A tool whose add overwrites
    /// (Codex) never gets that far.
    pub(super) async fn add(&self, launch: &[String], cwd: &Path) -> Result<(), Value> {
        // A configuration change runs to the end even if the page that asked for it goes away.
        let cancellation = CancellationToken::new();
        let add = add_args(self.client, launch);
        let added = self.run(&add, cwd, CHANGE_TIMEOUT, &cancellation).await?;
        if added.code == 0 {
            return Ok(());
        }
        // Only a read that says the entry is absent ends here. An entry whose read fails (a
        // stale path failing `claude mcp get`'s health check) is replaced like a healthy one,
        // or nothing the person clicks would get them out.
        let previous = match self.entry(cwd, &cancellation).await {
            Ok(Entry::Absent) => return Err(self.failed("could not add BiBCode", &added)),
            Ok(Entry::Present(stored)) => stored,
            Err(_) => None,
        };
        let removed = self
            .run(
                replace_args(self.client),
                cwd,
                CHANGE_TIMEOUT,
                &cancellation,
            )
            .await?;
        if removed.code != 0 {
            return Err(self.failed("could not replace its BiBCode entry", &removed));
        }
        let added = match self.run(&add, cwd, CHANGE_TIMEOUT, &cancellation).await {
            Ok(added) if added.code == 0 => return Ok(()),
            Ok(added) => summary(&added.text),
            Err(error) => error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim_end_matches('.')
                .to_owned(),
        };
        Err(self.restore(previous, &added, cwd, &cancellation).await)
    }

    /// After a failed replacement: puts the previous entry back, and says what happened.
    async fn restore(
        &self,
        previous: Option<Stored>,
        said: &str,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Value {
        let label = self.client.label();
        if let Some(argv) = previous.as_ref().and_then(|stored| stored.argv.as_ref()) {
            let restored = self
                .run(
                    &add_args(self.client, argv),
                    cwd,
                    CHANGE_TIMEOUT,
                    cancellation,
                )
                .await;
            if matches!(restored, Ok(Output { code: 0, .. })) {
                return refusal(
                    "failed",
                    &format!(
                        "{label} could not add BiBCode: {said}. Its previous BiBCode entry was put back. Check that `{}` works in a terminal, then try again.",
                        self.list_command()
                    ),
                );
            }
        }
        let what = previous.map_or_else(
            || "one BiBCode could not read".to_owned(),
            |stored| format!("`{}`", stored.shown),
        );
        tracing::warn!(
            client = self.client.id(),
            "removed an MCP client's BiBCode entry and could not add it again"
        );
        refusal(
            "failed",
            &format!(
                "{label} could not add BiBCode: {said}. BiBCode had removed its previous entry ({what}) and could not put it back. Fix the problem, then click Add to {label}, or run `{}` followed by the command under Other MCP clients.",
                add_prefix(self.client)
            ),
        )
    }

    pub(super) async fn remove(&self, cwd: &Path) -> Result<(), Value> {
        let cancellation = CancellationToken::new();
        let removed = self
            .run(&REMOVE_ARGS, cwd, CHANGE_TIMEOUT, &cancellation)
            .await?;
        if removed.code != 0 && !removed.text.contains(NOT_REGISTERED) {
            return Err(self.failed("could not remove BiBCode", &removed));
        }
        Ok(())
    }

    fn process_error(&self, error: &ProcessError) -> Value {
        let label = self.client.label();
        match error {
            ProcessError::Timeout { .. } => refusal(
                "timed_out",
                &format!(
                    "{label} did not answer in time. Check that `{}` works in a terminal, then try again.",
                    self.list_command()
                ),
            ),
            ProcessError::Spawn { .. } => not_installed(self.client),
            _ => {
                tracing::warn!(client = self.client.id(), %error, "an MCP client command failed");
                refusal(
                    "failed",
                    &format!("BiBCode could not run {label}'s command. Try again."),
                )
            }
        }
    }

    fn failed(&self, action: &str, output: &Output) -> Value {
        let said = summary(&output.text);
        let said = if said.is_empty() {
            format!("exit code {}", output.code)
        } else {
            said
        };
        refusal(
            "failed",
            &format!(
                "{} {action}: {said}. Check that `{}` works in a terminal, then try again.",
                self.client.label(),
                self.list_command()
            ),
        )
    }

    fn list_command(&self) -> &'static str {
        match self.client {
            McpClient::Claude => "claude mcp list",
            _ => "codex mcp list",
        }
    }
}

/// The first lines of what a CLI said, on one line, without colour codes.
pub(super) fn summary(text: &str) -> String {
    let lines = text
        .lines()
        .map(|line| strip_ansi(line).trim().to_owned())
        .filter(|line| !line.is_empty())
        .take(SUMMARY_LINES)
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = lines.trim_end_matches('.');
    if trimmed.chars().count() <= SUMMARY_CHARS {
        return trimmed.to_owned();
    }
    let mut cut = trimmed.chars().take(SUMMARY_CHARS).collect::<String>();
    cut.push('…');
    cut
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            // CSI: ESC [ … final byte in @..~
            if chars.next() == Some('[') {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(character);
    }
    out
}

#[cfg(all(test, unix))]
pub(super) const SUMMARY_LIMIT: usize = SUMMARY_CHARS;
