//! `bibcode agent` (and `<desktop exe> agent`): the agent of an AI Terminal lists, messages and
//! reads the agents of its project. The command talks only to `BIBCODE_AGENT_ENDPOINT` with
//! `BIBCODE_AGENT_AUTH`, both from its own environment, which BiBCode set when it started the
//! terminal. It never prints or logs the credential, and it prints message text from another
//! agent exactly as the inbox returns it, inside its envelope.
//!
//! The server side is `POST /api/agent/call`: only a live terminal generation's credential opens
//! it, and every operation runs as that terminal under every messaging rule.

use std::{
    io::{Read, Write},
    path::Path,
};

use clap::{Args, Subcommand};
use reqwest::StatusCode as ClientStatus;
use serde_json::{Value, json};

use crate::{
    agent_messaging::{
        AgentCaller, AgentMessaging, AgentMessagingError,
        terminal_credential::{AUTH_ENV, ENDPOINT_ENV, TerminalCredentials},
    },
    production::http_routes::{HttpRouteError, JsonRouteResponse, RouteContext},
};

/// How long the command waits for the server's answer. Every operation returns at once.
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Debug, Args)]
pub struct AgentArgs {
    /// Print one JSON document, `{ ok, result }` or `{ ok, error }`, also on failure.
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: AgentCommand,
}

#[derive(Clone, Debug, Subcommand)]
pub enum AgentCommand {
    /// List the other agents of this terminal's project that it can message.
    List,
    /// Send a message to another agent of this project.
    Send {
        /// An agent address, as `list` prints it.
        to: String,
        /// The message, or `-` to read it from standard input.
        message: String,
        /// An id for this message, 1 to 256 characters; one is made up unless set. The same
        /// command with the id it printed does not send twice.
        #[arg(long, value_name = "ID", value_parser = super::thread_cli::request_id)]
        request_id: Option<String>,
    },
    /// Reply to a message this terminal read with `inbox`; the reply goes to its sender.
    Reply {
        /// The message id from the envelope of the message replied to.
        message: String,
        /// The reply, or `-` to read it from standard input.
        text: String,
        /// An id for this reply, 1 to 256 characters; one is made up unless set.
        #[arg(long, value_name = "ID", value_parser = super::thread_cli::request_id)]
        request_id: Option<String>,
    },
    /// Show the status of a message this terminal sent.
    Status {
        /// The message id `send` printed.
        message: String,
    },
    /// Cancel a message this terminal sent that its recipient has not read.
    Cancel {
        /// The message id `send` printed.
        message: String,
    },
    /// Print this terminal's new messages, oldest first; each one printed is marked read.
    Inbox,
}

impl AgentCommand {
    /// This command with a request id of its own made up, unless it has one.
    fn with_request_id(mut self) -> Self {
        if let Self::Send { request_id, .. } | Self::Reply { request_id, .. } = &mut self {
            request_id.get_or_insert_with(|| uuid::Uuid::new_v4().to_string());
        }
        self
    }

    fn request_id(&self) -> Option<&str> {
        match self {
            Self::Send { request_id, .. } | Self::Reply { request_id, .. } => request_id.as_deref(),
            _ => None,
        }
    }

    /// The route's operation and arguments; a `-` text is read from `stdin`.
    fn call(&self, stdin: impl Read) -> Result<(&'static str, Value), String> {
        Ok(match self {
            Self::List => ("list", json!({})),
            Self::Inbox => ("inbox", json!({})),
            Self::Status { message } => ("status", json!({ "messageId": message })),
            Self::Cancel { message } => ("cancel", json!({ "messageId": message })),
            Self::Send {
                to,
                message,
                request_id,
            } => (
                "send",
                json!({ "to": to, "text": text_of(message, stdin)?, "clientRequestId": request_id }),
            ),
            Self::Reply {
                message,
                text,
                request_id,
            } => (
                "reply",
                json!({
                    "inReplyTo": message,
                    "text": text_of(text, stdin)?,
                    "clientRequestId": request_id,
                }),
            ),
        })
    }
}

fn text_of(text: &str, mut stdin: impl Read) -> Result<String, String> {
    let text = if text == "-" {
        let mut read = String::new();
        stdin
            .read_to_string(&mut read)
            .map_err(|error| format!("Could not read the message from standard input: {error}"))?;
        read.trim_end_matches(['\n', '\r']).to_owned()
    } else {
        text.to_owned()
    };
    if text.trim().is_empty() {
        return Err("The message is empty.".to_owned());
    }
    Ok(text)
}

/// What the command calls: the route's answer, `{ ok, result }` or `{ ok, error }`, or why the
/// call never got one.
pub(crate) trait Transport {
    async fn call(&self, operation: &str, arguments: Value) -> Result<Value, String>;
}

/// The route of this machine's own server.
struct Http {
    client: reqwest::Client,
    endpoint: String,
    token: String,
}

impl Transport for Http {
    async fn call(&self, operation: &str, arguments: Value) -> Result<Value, String> {
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.token)
            .json(&json!({ "operation": operation, "arguments": arguments }))
            .send()
            .await
            .map_err(|error| format!("BiBCode did not answer: {}", error.without_url()))?;
        let status = response.status();
        if status == ClientStatus::PAYLOAD_TOO_LARGE {
            return Err("The message is too large.".to_owned());
        }
        let answer: Value = response
            .json()
            .await
            .map_err(|_| format!("BiBCode answered {status} with no result."))?;
        if answer.get("ok").and_then(Value::as_bool).is_none() {
            return Err(format!("BiBCode answered {status} with no result."));
        }
        Ok(answer)
    }
}

/// `agent …` on its own, for `bibcode` before the server's arguments and for the desktop
/// executable: no environment-backed option of the server is read.
#[derive(Debug, clap::Parser)]
#[command(
    name = "agent",
    about = "Inside an AI Terminal that BiBCode started: list, message and read the other agents of its project."
)]
pub(crate) struct AgentCli {
    #[command(flatten)]
    pub(crate) args: AgentArgs,
}

/// Parses `args` (from `agent` on) and runs the command; a usage error prints and exits 2.
pub async fn run_agent_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> i32 {
    match <AgentCli as clap::Parser>::try_parse_from(args) {
        Ok(cli) => run_agent_cli(cli.args).await,
        Err(error) => {
            let _ = error.print();
            error.exit_code()
        }
    }
}

/// Runs an `agent` command on this process's standard streams and returns its exit code: 0 on
/// success, 1 on any failure.
pub async fn run_agent_cli(args: AgentArgs) -> i32 {
    let transport = match transport(
        std::env::var(ENDPOINT_ENV).ok(),
        std::env::var(AUTH_ENV).ok(),
    ) {
        Ok(transport) => transport,
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "bibcode agent: {error}");
            return 1;
        }
    };
    run(
        args,
        transport,
        std::io::stdin(),
        &mut std::io::stdout(),
        &mut std::io::stderr(),
    )
    .await
}

/// The route of the AI Terminal's own server, from its endpoint and credential; `None` unless
/// both are set, as in a shell BiBCode did not start.
fn transport(endpoint: Option<String>, token: Option<String>) -> Result<Option<Http>, String> {
    let (Some(endpoint), Some(token)) = (
        endpoint.filter(|value| !value.is_empty()),
        token.filter(|value| !value.is_empty()),
    ) else {
        return Ok(None);
    };
    // The endpoint is this machine's own server: no proxy may see the credential, and no
    // redirect may carry it elsewhere.
    let client = reqwest::Client::builder()
        .timeout(CALL_TIMEOUT)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    Ok(Some(Http {
        client,
        endpoint,
        token,
    }))
}

/// [`run_agent_cli`] with a given transport, `None` when the environment holds no credential.
pub(crate) async fn run(
    args: AgentArgs,
    transport: Option<impl Transport>,
    stdin: impl Read,
    out: &mut impl Write,
    err: &mut impl Write,
) -> i32 {
    let command = args.command.with_request_id();
    let answer = match transport {
        None => refusal(&AgentMessagingError::NoIdentity),
        Some(transport) => match command.call(stdin) {
            Err(message) => refusal(&AgentMessagingError::InvalidArgument(message)),
            Ok((operation, arguments)) => match transport.call(operation, arguments).await {
                Ok(answer) => answer,
                Err(message) => json!({
                    "ok": false,
                    "error": { "kind": "AgentCommandTransportError", "message": message },
                }),
            },
        },
    };
    print(&command, answer, args.json, out, err)
}

fn refusal(error: &AgentMessagingError) -> Value {
    json!({ "ok": false, "error": { "kind": error.tag(), "message": error.message() } })
}

pub(crate) fn print(
    command: &AgentCommand,
    mut answer: Value,
    json: bool,
    out: &mut impl Write,
    err: &mut impl Write,
) -> i32 {
    let ok = answer["ok"] == true;
    if let Some(request_id) = command.request_id() {
        answer["requestId"] = json!(request_id);
    }
    let written = if json {
        writeln!(out, "{answer}")
    } else if ok {
        text(command, &answer["result"])
            .iter()
            .try_for_each(|line| writeln!(out, "{line}"))
    } else {
        Ok(())
    }
    .and_then(|()| out.flush());
    if !ok {
        let error = &answer["error"];
        let _ = writeln!(
            err,
            "bibcode agent: {} ({})",
            error["message"].as_str().unwrap_or("The call failed."),
            error["kind"].as_str().unwrap_or("unknown"),
        );
        if let Some(request_id) = command.request_id() {
            let _ = writeln!(
                err,
                "bibcode agent: run it again with --request-id {request_id} to retry without sending twice."
            );
        }
    }
    match written {
        Ok(()) if ok => 0,
        Ok(()) => 1,
        Err(error) => {
            let _ = writeln!(err, "bibcode agent: could not write the result: {error}");
            1
        }
    }
}

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name].as_str().unwrap_or_default()
}

/// The lines an agent reads for a successful `result`.
fn text(command: &AgentCommand, result: &Value) -> Vec<String> {
    match command {
        AgentCommand::List => {
            let agents = result["agents"].as_array().cloned().unwrap_or_default();
            if agents.is_empty() {
                return vec!["No other agents in this project.".to_owned()];
            }
            agents
                .iter()
                .map(|agent| {
                    let receive = if agent["canReceive"] == true {
                        "can receive"
                    } else {
                        "cannot receive now"
                    };
                    format!(
                        "{}  {} {}  {}, {}  {}",
                        field(agent, "address"),
                        field(agent, "kind"),
                        field(agent, "provider"),
                        field(agent, "status"),
                        receive,
                        field(agent, "title"),
                    )
                })
                .collect()
        }
        AgentCommand::Send { .. } | AgentCommand::Reply { .. } => vec![
            format!(
                "Sent message {} ({}, hop {}) in conversation {}.",
                field(result, "messageId"),
                field(result, "status"),
                result["hop"],
                field(result, "conversationId"),
            ),
            format!(
                "Request id {}. Check it with: bibcode agent status {}",
                command.request_id().unwrap_or_default(),
                field(result, "messageId"),
            ),
        ],
        AgentCommand::Status { .. } => {
            let mut lines = vec![match result["reason"].as_str() {
                Some(reason) => format!("{} ({reason})", field(result, "status")),
                None => field(result, "status").to_owned(),
            }];
            lines.push(format!("Updated {}", field(result, "updatedAt")));
            if let Some(reply) = result["replyMessageId"].as_str() {
                lines.push(format!("Replied with message {reply}"));
            }
            lines
        }
        AgentCommand::Cancel { message } => vec![format!("Message {message} is cancelled.")],
        AgentCommand::Inbox => {
            let messages = result["messages"].as_array().cloned().unwrap_or_default();
            if messages.is_empty() {
                return vec!["No new messages.".to_owned()];
            }
            let mut lines = Vec::new();
            for (index, message) in messages.iter().enumerate() {
                if index > 0 {
                    lines.push(String::new());
                }
                lines.push(field(message, "rendered").to_owned());
            }
            lines
        }
    }
}

/// The most bytes `/api/agent/call` reads: a message of 16,000 characters with its JSON escaping.
pub(crate) const MAX_AGENT_CALL_BODY_BYTES: usize = 256 * 1024;

/// `POST /api/agent/call`. Only an AI Terminal generation's credential opens it, as a bearer;
/// the caller is that terminal, never a field of the body. It logs nothing of the body.
pub(crate) async fn agent_call_http(
    credentials: &TerminalCredentials,
    messaging: Option<&AgentMessaging>,
    body: Vec<u8>,
    context: RouteContext,
) -> Result<JsonRouteResponse, HttpRouteError> {
    let token = context
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let identity = match token {
        Some(token) => credentials.verify(token).await,
        None => None,
    };
    let Some(identity) = identity else {
        return Err(HttpRouteError::new(
            axum::http::StatusCode::UNAUTHORIZED,
            refusal(&AgentMessagingError::NoIdentity),
        ));
    };
    let answer = match messaging {
        None => Err(AgentMessagingError::Disabled),
        Some(messaging) => {
            call_as(messaging, &AgentCaller::Terminal(identity.clone()), &body).await
        }
    };
    let (outcome, answer) = match answer {
        Ok(result) => ("ok", json!({ "ok": true, "result": result })),
        Err(error) => (error.tag(), refusal(&error)),
    };
    tracing::debug!(
        thread_id = %identity.thread_id,
        terminal_id = %identity.terminal_id,
        outcome,
        "an AI Terminal agent call answered"
    );
    Ok(JsonRouteResponse::ok(answer))
}

/// One operation of the route's body for `caller`. The body names an operation and its
/// arguments only; any other field, a sender included, is refused.
async fn call_as(
    messaging: &AgentMessaging,
    caller: &AgentCaller,
    body: &[u8],
) -> Result<Value, AgentMessagingError> {
    let invalid = || {
        AgentMessagingError::InvalidArgument(
            "The body takes only operation and arguments.".to_owned(),
        )
    };
    let body: Value = serde_json::from_slice(body).map_err(|_| invalid())?;
    let object = body
        .as_object()
        .filter(|object| {
            object
                .keys()
                .all(|key| key == "operation" || key == "arguments")
        })
        .ok_or_else(invalid)?;
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let arguments = object
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let tool = match operation {
        "list" => "agents_list",
        "send" => "agent_message_send",
        "reply" => "agent_message_reply",
        "status" => "agent_message_status",
        "cancel" => "agent_message_cancel",
        "inbox" => return inbox(messaging, caller, &arguments).await,
        _ => {
            return Err(AgentMessagingError::InvalidArgument(
                "operation is one of list, send, reply, status, cancel, inbox.".to_owned(),
            ));
        }
    };
    super::tools::agent_messaging::call_as(messaging, caller, tool, &arguments).await
}

async fn inbox(
    messaging: &AgentMessaging,
    caller: &AgentCaller,
    arguments: &Value,
) -> Result<Value, AgentMessagingError> {
    if arguments
        .as_object()
        .is_none_or(|object| !object.is_empty())
    {
        return Err(AgentMessagingError::InvalidArgument(
            "inbox takes no arguments.".to_owned(),
        ));
    }
    let entries = messaging.inbox_as(caller).await?;
    Ok(json!({
        "messages": entries
            .into_iter()
            .map(|entry| json!({ "messageId": entry.message_id, "rendered": entry.rendered }))
            .collect::<Vec<_>>(),
    }))
}

/// Writes the `bibcode` shim into `dir`, the folder BiBCode puts first on an AI Terminal's
/// `PATH` only, so a plain shell keeps its own `bibcode`. It runs `exe` with every argument.
pub fn write_agent_shim(dir: &Path, exe: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    if cfg!(windows) {
        let alias = dir.join("bibcode.exe");
        // shortcut: replaced on every start, never compared; compare like the open-url alias if
        // startup time ever shows it.
        let _ = std::fs::remove_file(&alias);
        return std::fs::hard_link(exe, &alias).or_else(|_| std::fs::copy(exe, &alias).map(drop));
    }
    let exe = exe.to_str().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("executable path is not UTF-8: {}", exe.display()),
        )
    })?;
    // Single quotes keep every byte of the path literal; an embedded quote closes, escapes, reopens.
    let quoted = format!("'{}'", exe.replace('\'', r"'\''"));
    let shim = format!(
        "#!/bin/sh\n# BiBCode agent shim: runs this BiBCode's `bibcode agent`.\nexec {quoted} \"$@\"\n"
    );
    let path = dir.join("bibcode");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(shim.as_str()) {
        let partial = dir.join(".bibcode.partial");
        std::fs::write(&partial, shim)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&partial, &path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
