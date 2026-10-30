//! `bibcode thread` (and `<desktop exe> thread`): operate this data root's threads from a shell
//! (#139). A thin client of the outside-agent MCP tools on `/mcp`, in the modern protocol era.
//!
//! It connects as `bibcode mcp` does, through [`Connection`]: the MCP server setting, the
//! endpoint record and its proof, then a credential of its own, minted on the first call and
//! revoked on the way out, with the orphan sweep. It never logs or echoes message text.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use clap::{Args, Subcommand};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::relay::{Connection, RelayOptions};

/// The credential's row in Authorized clients.
const LABEL: &str = "MCP · bibcode thread";
/// One `wait_for_thread` call under `--wait`; a slice that times out is followed by another.
pub(crate) const WAIT_SLICE_MS: u64 = 30_000;
const STOPPED_WAITING: &str =
    "Stopped waiting; the work goes on in BiBCode. Run `bibcode thread show` to check on it.";
const INTERRUPTED: &str = "Interrupted; whatever BiBCode already accepted goes on.";
/// Store hiccups in a row that a wait repeats, a second apart, before it gives up.
const MOST_TRANSIENT: u32 = 3;

#[derive(Clone, Debug, Args)]
pub struct ThreadArgs {
    /// Print one JSON document. For start and send it is `{ threadId, messageId, status,
    /// reply, error }`, also on failure.
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: ThreadCommand,
}

#[derive(Clone, Debug, Subcommand)]
pub enum ThreadCommand {
    /// List projects, with their folders, and their threads, newest first.
    List,
    /// Start a thread in a project with a first message.
    Start {
        /// A project id, or `.` for the project whose folder holds the current directory.
        project: String,
        /// The first message, or `-` to read it from standard input.
        message: String,
        /// The thread's title; the message's first line by default.
        #[arg(long)]
        title: Option<String>,
        /// A provider instance id, such as `codex`; the project's default model, else the
        /// Default Agent's, unless set.
        #[arg(long, value_name = "INSTANCE")]
        provider: Option<String>,
        /// A model of that provider.
        #[arg(long)]
        model: Option<String>,
        /// Wait until the turn settles or needs a person, and print its reply.
        #[arg(long)]
        wait: bool,
    },
    /// Send a message to a thread. It queues behind a running turn and never interrupts it.
    Send {
        /// A thread id, as `list` prints it.
        thread: String,
        /// The message, or `-` to read it from standard input.
        message: String,
        /// Wait until its turn settles or needs a person, and print its reply.
        #[arg(long)]
        wait: bool,
    },
    /// Show a thread's status and its latest messages.
    Show {
        /// A thread id, as `list` prints it.
        thread: String,
    },
}

/// What a subcommand calls: one tool's `result`, a tool failure included, or why the call
/// never got one.
pub(crate) trait Tools {
    async fn call(&self, name: &str, arguments: Value) -> Result<Value, String>;
}

struct Remote {
    connection: Connection,
    next_id: AtomicU64,
}

impl Tools for Remote {
    async fn call(&self, name: &str, arguments: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.connection.call_tool(id, name, arguments, LABEL).await
    }
}

/// What a command did: its exit code, its `--json` document, and its text for a person.
#[derive(Debug, PartialEq)]
pub(crate) struct Report {
    pub(crate) code: i32,
    pub(crate) json: Value,
    /// For standard output.
    pub(crate) text: Vec<String>,
    /// For standard error.
    pub(crate) note: Option<String>,
}

/// Runs a `thread` command on this process's standard streams and returns its exit code:
/// 0 on success, 1 on failure or interruption, 2 when a person must answer in BiBCode.
pub async fn run_thread_cli(options: RelayOptions, args: ThreadArgs) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    run(
        options,
        args,
        &cwd,
        std::io::stdin(),
        &mut std::io::stdout(),
        &mut std::io::stderr(),
        super::relay::shutdown_signal(),
    )
    .await
}

/// [`run_thread_cli`] on given streams; `interrupt` is the person's Ctrl-C. It is armed only
/// after the message is read, so Ctrl-C while typing a `-` message still ends the process.
pub(crate) async fn run(
    options: RelayOptions,
    args: ThreadArgs,
    cwd: &Path,
    stdin: impl Read,
    out: &mut impl Write,
    err: &mut impl Write,
    interrupt: impl Future<Output = ()> + Send + 'static,
) -> i32 {
    let report = match message_of(&args.command, stdin) {
        Err(error) => failure(&args.command, error),
        Ok(message) => {
            let stop = CancellationToken::new();
            let watcher = tokio::spawn({
                let stop = stop.clone();
                async move {
                    interrupt.await;
                    stop.cancel();
                }
            });
            let report = connect_and_execute(options, &args.command, message, cwd, &stop).await;
            watcher.abort();
            report
        }
    };
    print(&report, args.json, out, err);
    report.code
}

async fn connect_and_execute(
    options: RelayOptions,
    command: &ThreadCommand,
    message: Option<String>,
    cwd: &Path,
    stop: &CancellationToken,
) -> Report {
    let opened = tokio::select! {
        biased;
        opened = Connection::open(options) => opened,
        () = stop.cancelled() => return failure(command, INTERRUPTED.to_owned()),
    };
    let remote = match opened {
        Ok(connection) => Remote {
            connection,
            next_id: AtomicU64::new(1),
        },
        Err(error) => return failure(command, error),
    };
    let report = tokio::select! {
        biased;
        report = execute(command, message, &remote, cwd, stop) => report,
        () = stop.cancelled() => failure(command, INTERRUPTED.to_owned()),
    };
    remote.connection.revoke().await;
    report
}

fn print(report: &Report, json: bool, out: &mut impl Write, err: &mut impl Write) {
    if json {
        let _ = writeln!(out, "{}", report.json);
    } else {
        for line in &report.text {
            let _ = writeln!(out, "{line}");
        }
    }
    if let Some(note) = &report.note {
        let _ = writeln!(err, "bibcode: {note}");
    }
    let _ = out.flush();
}

/// The message a `start` or `send` names: its argument, or standard input for `-`.
pub(crate) fn message_of(
    command: &ThreadCommand,
    mut stdin: impl Read,
) -> Result<Option<String>, String> {
    let (ThreadCommand::Start { message, .. } | ThreadCommand::Send { message, .. }) = command
    else {
        return Ok(None);
    };
    let text = if message == "-" {
        let mut text = String::new();
        stdin
            .read_to_string(&mut text)
            .map_err(|error| format!("Could not read the message from standard input: {error}"))?;
        text.trim_end_matches(['\n', '\r']).to_owned()
    } else {
        message.clone()
    };
    if text.trim().is_empty() {
        return Err("The message is empty.".to_owned());
    }
    Ok(Some(text))
}

/// The project whose folder holds `cwd`: the deepest one, when folders nest.
pub(crate) fn project_for(cwd: &Path, projects: &[Value]) -> Result<String, String> {
    let canonical = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    let cwd = canonical(cwd);
    let mut found: Vec<(usize, &str)> = projects
        .iter()
        .filter_map(|project| {
            let root = canonical(Path::new(project["workspaceRoot"].as_str()?));
            let id = project["projectId"].as_str()?;
            cwd.starts_with(&root)
                .then(|| (root.components().count(), id))
        })
        .collect();
    found.sort_by_key(|(depth, _)| std::cmp::Reverse(*depth));
    match found.as_slice() {
        [] => Err(format!(
            "No BiBCode project holds {}. `bibcode thread list` lists the projects and their folders.",
            cwd.display()
        )),
        [(depth, _), (next, _), ..] if depth == next => {
            let ids: Vec<&str> = found
                .iter()
                .filter(|(other, _)| other == depth)
                .map(|(_, id)| *id)
                .collect();
            Err(format!(
                "Several projects use this folder ({}); name one by its id.",
                ids.join(", ")
            ))
        }
        [(_, id), ..] => Ok((*id).to_owned()),
    }
}

/// The failure report before or instead of any thread result.
fn failure(command: &ThreadCommand, error: String) -> Report {
    let json = match command {
        ThreadCommand::Start { .. } | ThreadCommand::Send { .. } => turn_json(
            &Value::Null,
            &Value::Null,
            &Value::Null,
            &Value::Null,
            Some(&error),
        ),
        ThreadCommand::List | ThreadCommand::Show { .. } => json!({ "error": error }),
    };
    Report {
        code: 1,
        json,
        text: Vec::new(),
        note: Some(error),
    }
}

fn turn_json(
    thread_id: &Value,
    message_id: &Value,
    status: &Value,
    reply: &Value,
    error: Option<&str>,
) -> Value {
    json!({
        "threadId": thread_id,
        "messageId": message_id,
        "status": status,
        "reply": reply,
        "error": error,
    })
}

/// A tool's structured result, or its failure's message.
fn structured(result: Value) -> Result<Value, String> {
    if result["isError"] == true {
        let message = result["structuredContent"]["error"]["message"]
            .as_str()
            .or_else(|| result["content"][0]["text"].as_str())
            .unwrap_or("BiBCode refused the request.");
        return Err(message.to_owned());
    }
    Ok(result["structuredContent"].clone())
}

/// Whether a tool failure is a store hiccup that a wait just repeats.
fn transient(result: &Value) -> bool {
    result["isError"] == true && result["structuredContent"]["error"]["_tag"] == "McpStorageError"
}

async fn tool(tools: &impl Tools, name: &str, arguments: Value) -> Result<Value, String> {
    structured(tools.call(name, arguments).await?)
}

pub(crate) async fn execute(
    command: &ThreadCommand,
    message: Option<String>,
    tools: &impl Tools,
    cwd: &Path,
    stop: &CancellationToken,
) -> Report {
    let outcome = match command {
        ThreadCommand::List => list(tools).await,
        ThreadCommand::Show { thread } => show(tools, thread).await,
        ThreadCommand::Start {
            project,
            title,
            provider,
            model,
            wait,
            ..
        } => {
            let started = start(
                tools,
                cwd,
                project,
                message.unwrap_or_default(),
                title.as_deref(),
                provider.as_deref(),
                model.as_deref(),
            )
            .await;
            return match started {
                Err(error) => failure(command, error),
                Ok((thread_id, message_id)) if *wait => {
                    wait_for(tools, &thread_id, &message_id, stop).await
                }
                Ok((thread_id, message_id)) => Report {
                    code: 0,
                    json: turn_json(
                        &thread_id.as_str().into(),
                        &message_id.as_str().into(),
                        &"started".into(),
                        &Value::Null,
                        None,
                    ),
                    text: vec![format!(
                        "Started thread {thread_id} (message {message_id})."
                    )],
                    note: None,
                },
            };
        }
        ThreadCommand::Send { thread, wait, .. } => {
            let sent = tool(
                tools,
                "send_message",
                json!({
                    "threadId": thread,
                    "text": message.unwrap_or_default(),
                    "clientRequestId": uuid::Uuid::new_v4().to_string(),
                }),
            )
            .await;
            return match sent {
                Err(error) => failure(command, error),
                Ok(sent) => {
                    let message_id = sent["messageId"].as_str().unwrap_or_default().to_owned();
                    if *wait {
                        wait_for(tools, thread, &message_id, stop).await
                    } else {
                        let status = if sent["queued"] == true {
                            "queued"
                        } else {
                            "started"
                        };
                        Report {
                            code: 0,
                            json: turn_json(
                                &thread.as_str().into(),
                                &message_id.as_str().into(),
                                &status.into(),
                                &Value::Null,
                                None,
                            ),
                            text: vec![format!(
                                "Sent message {message_id} to thread {thread} ({status})."
                            )],
                            note: None,
                        }
                    }
                }
            };
        }
    };
    outcome.unwrap_or_else(|error| failure(command, error))
}

async fn list(tools: &impl Tools) -> Result<Report, String> {
    let listed = tool(tools, "list_projects_and_threads", json!({ "limit": 200 })).await?;
    let mut text = Vec::new();
    let threads = listed["threads"].as_array().cloned().unwrap_or_default();
    for project in listed["projects"].as_array().into_iter().flatten() {
        text.push(format!(
            "{}  {}  {}",
            field(&project["projectId"]),
            field(&project["title"]),
            field(&project["workspaceRoot"])
        ));
        for thread in threads
            .iter()
            .filter(|thread| thread["projectId"] == project["projectId"])
        {
            text.push(format!(
                "  {}  {}  {}",
                field(&thread["threadId"]),
                field(&thread["status"]),
                field(&thread["title"])
            ));
        }
    }
    if text.is_empty() {
        text.push("No projects.".to_owned());
    }
    let shown = threads.len();
    let total = listed["threadCount"].as_u64().unwrap_or(shown as u64);
    if (shown as u64) < total {
        text.push(format!("{shown} of {total} threads shown."));
    }
    Ok(Report {
        code: 0,
        json: listed,
        text,
        note: None,
    })
}

async fn show(tools: &impl Tools, thread: &str) -> Result<Report, String> {
    let read = tool(tools, "read_thread", json!({ "threadId": thread })).await?;
    let mut text = vec![format!(
        "{} ({})  {}",
        field(&read["title"]),
        field(&read["threadId"]),
        field(&read["status"])
    )];
    for message in read["messages"].as_array().into_iter().flatten() {
        text.push(String::new());
        text.push(format!("{}:", field(&message["role"])));
        text.push(field(&message["text"]).to_owned());
    }
    if let Some(queued) = read["queuedCount"].as_u64().filter(|count| *count > 0) {
        text.push(String::new());
        text.push(format!("{queued} queued."));
    }
    Ok(Report {
        code: 0,
        json: read,
        text,
        note: None,
    })
}

fn field(value: &Value) -> &str {
    value.as_str().unwrap_or("-")
}

async fn start(
    tools: &impl Tools,
    cwd: &Path,
    project: &str,
    message: String,
    title: Option<&str>,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<(String, String), String> {
    let project_id = if project == "." {
        let listed = tool(tools, "list_projects_and_threads", json!({ "limit": 1 })).await?;
        project_for(
            cwd,
            listed["projects"].as_array().map_or(&[][..], Vec::as_slice),
        )?
    } else {
        project.to_owned()
    };
    let mut arguments = json!({
        "projectId": project_id,
        "prompt": message,
        "clientRequestId": uuid::Uuid::new_v4().to_string(),
    });
    for (key, value) in [
        ("title", title),
        ("providerInstanceId", provider),
        ("model", model),
    ] {
        if let Some(value) = value {
            arguments[key] = value.into();
        }
    }
    let started = tool(tools, "start_thread", arguments).await?;
    match (started["threadId"].as_str(), started["messageId"].as_str()) {
        (Some(thread_id), Some(message_id)) => Ok((thread_id.to_owned(), message_id.to_owned())),
        _ => Err("BiBCode started no thread.".to_owned()),
    }
}

/// `wait_for_thread` in [`WAIT_SLICE_MS`] slices until the message's turn settles or needs a
/// person. A slice that times out is followed by another and never cancels work; neither
/// does `stop`.
async fn wait_for(
    tools: &impl Tools,
    thread_id: &str,
    message_id: &str,
    stop: &CancellationToken,
) -> Report {
    let ids = (Value::from(thread_id), Value::from(message_id));
    let mut status = Value::Null;
    let ended = |status: &Value, error: String| Report {
        code: 1,
        json: turn_json(&ids.0, &ids.1, status, &Value::Null, Some(&error)),
        text: Vec::new(),
        note: Some(error),
    };
    let mut hiccups = 0;
    let waited = loop {
        let called = tokio::select! {
            biased;
            () = stop.cancelled() => return ended(&status, STOPPED_WAITING.to_owned()),
            called = tools.call(
                "wait_for_thread",
                json!({ "threadId": thread_id, "messageId": message_id, "timeoutMs": WAIT_SLICE_MS }),
            ) => called,
        };
        let result = match called {
            Ok(result) if transient(&result) && hiccups < MOST_TRANSIENT => {
                hiccups += 1;
                tokio::select! {
                    biased;
                    () = stop.cancelled() => return ended(&status, STOPPED_WAITING.to_owned()),
                    () = tokio::time::sleep(std::time::Duration::from_secs(1)) => continue,
                }
            }
            Ok(result) => result,
            Err(error) => return ended(&status, error),
        };
        hiccups = 0;
        let waited = match structured(result) {
            Ok(waited) => waited,
            Err(error) => return ended(&status, error),
        };
        status = waited["status"].clone();
        if waited["timedOut"] != true {
            break waited;
        }
    };
    let reply = match &waited["reply"] {
        Value::Null => Value::Null,
        reply => match full_text(tools, thread_id, reply).await {
            Ok(text) => text.into(),
            Err(error) => return ended(&status, error),
        },
    };
    let (code, note) = match status.as_str() {
        Some("completed") => (0, None),
        Some(waiting @ ("awaiting_approval" | "awaiting_input")) => (
            2,
            Some(format!(
                "Thread {thread_id} is {}; answer it in BiBCode.",
                if waiting == "awaiting_approval" {
                    "waiting for an approval"
                } else {
                    "waiting for an answer to its question"
                }
            )),
        ),
        _ => (
            1,
            Some(waited["error"].as_str().map_or_else(
                || format!("The turn ended with status {}.", field(&status)),
                |error| format!("The turn ended with status {}: {error}", field(&status)),
            )),
        ),
    };
    let error = (code == 1).then(|| note.clone()).flatten();
    Report {
        code,
        json: turn_json(&ids.0, &ids.1, &status, &reply, error.as_deref()),
        text: reply
            .as_str()
            .map(|text| vec![text.to_owned()])
            .unwrap_or_default(),
        note,
    }
}

/// A reply's whole text: `read_thread` slices after the first, which the wait cut.
async fn full_text(tools: &impl Tools, thread_id: &str, reply: &Value) -> Result<String, String> {
    let mut text = reply["text"].as_str().unwrap_or_default().to_owned();
    let length = reply["textLength"].as_u64().unwrap_or(0);
    while (text.chars().count() as u64) < length {
        let slice = tool(
            tools,
            "read_thread",
            json!({
                "threadId": thread_id,
                "messageId": reply["messageId"],
                "textOffset": text.chars().count(),
            }),
        )
        .await?;
        let more = slice["message"]["text"].as_str().unwrap_or_default();
        if more.is_empty() {
            break;
        }
        text.push_str(more);
    }
    Ok(text)
}

#[cfg(test)]
mod tests;
