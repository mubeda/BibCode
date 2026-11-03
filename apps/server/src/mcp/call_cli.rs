//! `bibcode mcp call` and `bibcode mcp tools` (#271): one outside-agent tool call, or the tool
//! list, from a shell, over the relay's [`Connection`] with a credential of its own, revoked on
//! the way out.
//!
//! Revoking the credential ends whatever a call handed back: a transfer URL is bound to its
//! session, and owned work such as a clone stops. So `call` takes only read-only tools, which
//! finish within the call, and not `files_download`, whose URL would die with the run. Every
//! other tool is refused before any credential is minted.

use std::io::{Read, Write};

use clap::Args;
use serde_json::{Value, json};

use super::{
    control::{PrincipalKind, tool_spec},
    relay::{Connection, RelayOptions},
};

/// The credential's row in Authorized clients while a run lasts.
pub(crate) const LABEL: &str = "CLI · bibcode mcp";
const INTERRUPTED: &str = "Interrupted.";

#[derive(Clone, Debug, Args)]
pub struct CallArgs {
    /// The tool, as `bibcode mcp tools` lists it with `oneShot: true`.
    pub tool: String,
    /// Its arguments as a JSON object, or `-` to read them from standard input; none unless
    /// set.
    pub arguments: Option<String>,
}

/// Whether one run of `bibcode mcp call` may call `name`: a read-only tool, which finishes
/// within the call, other than `files_download`, whose URL dies with the run's credential.
pub(crate) fn one_shot(name: &str) -> bool {
    name != "files_download"
        && tool_spec(PrincipalKind::Client, name).is_some_and(|spec| spec.read_only)
}

/// What a run did: its exit code, its standard output, and its note for standard error.
#[derive(Debug, PartialEq)]
pub(crate) struct Report {
    pub(crate) code: i32,
    pub(crate) out: Option<Value>,
    pub(crate) note: Option<String>,
}

fn failure(note: String) -> Report {
    Report {
        code: 1,
        out: None,
        note: Some(note),
    }
}

/// The tool's arguments, or why the call is refused before anything connects: a tool that is
/// not one-shot, an unknown tool, or arguments that are not a JSON object.
pub(crate) fn checked(args: &CallArgs, mut stdin: impl Read) -> Result<Value, String> {
    if tool_spec(PrincipalKind::Client, &args.tool).is_none() {
        return Err(format!(
            "BiBCode has no tool {}. `bibcode mcp tools` lists them.",
            args.tool
        ));
    }
    if !one_shot(&args.tool) {
        return Err(format!(
            "{} needs a connection that stays open. Use it from `bibcode mcp` in your agent, or `bibcode thread` for messages, answers and approvals.",
            args.tool
        ));
    }
    let text = match args.arguments.as_deref() {
        None => return Ok(json!({})),
        Some("-") => {
            let mut text = String::new();
            stdin.read_to_string(&mut text).map_err(|error| {
                format!("Could not read the arguments from standard input: {error}")
            })?;
            text
        }
        Some(text) => text.to_owned(),
    };
    // The refusal names no part of the arguments.
    match serde_json::from_str::<Value>(&text) {
        Ok(arguments @ Value::Object(_)) => Ok(arguments),
        _ => {
            Err("The arguments must be a JSON object, such as {\"threadId\": \"...\"}.".to_owned())
        }
    }
}

/// The report of one tool call's outcome: 0 on success, 1 on a tool error or no answer, 2
/// when the result says a person must answer in BiBCode.
pub(crate) fn call_report(called: Result<Value, String>) -> Report {
    let result = match called {
        Ok(result) => result,
        Err(error) => return failure(error),
    };
    let structured = &result["structuredContent"];
    let (code, note) = if result["isError"] == true {
        let message = structured["error"]["message"]
            .as_str()
            .or_else(|| result["content"][0]["text"].as_str())
            .unwrap_or("BiBCode refused the request.");
        (1, Some(message.to_owned()))
    } else if matches!(
        structured["status"].as_str(),
        Some("awaiting_approval" | "awaiting_input")
    ) {
        (
            2,
            Some(
                "The thread waits on a person: answer it in BiBCode, or with `bibcode thread`."
                    .to_owned(),
            ),
        )
    } else {
        (0, None)
    };
    Report {
        code,
        out: Some(result),
        note,
    }
}

/// The tool list with `oneShot` on each tool.
pub(crate) fn tools_report(listed: Result<Value, String>) -> Report {
    let mut listed = match listed {
        Ok(listed) => listed,
        Err(error) => return failure(error),
    };
    let mut tools = match listed["tools"].take() {
        Value::Array(tools) => tools,
        _ => return failure("BiBCode listed no tools.".to_owned()),
    };
    for tool in &mut tools {
        let one = tool["name"].as_str().is_some_and(one_shot);
        tool["oneShot"] = one.into();
    }
    Report {
        code: 0,
        out: Some(json!({ "tools": tools })),
        note: None,
    }
}

/// Prints `report` and returns its exit code; 1 when its result could not be written, since a
/// script reading standard output got nothing.
fn print(report: &Report, out: &mut impl Write, err: &mut impl Write) -> i32 {
    let written = match &report.out {
        Some(value) => writeln!(out, "{value}").and_then(|()| out.flush()),
        None => Ok(()),
    };
    for line in report.note.iter().flat_map(|note| note.lines()) {
        let _ = writeln!(err, "bibcode: {line}");
    }
    match written {
        Ok(()) => report.code,
        Err(error) => {
            let _ = writeln!(err, "bibcode: could not write the result: {error}");
            1
        }
    }
}

/// Opens the connection, runs `work` on it unless Ctrl-C comes first, and revokes the
/// credential whichever ends it.
async fn connected(
    options: RelayOptions,
    interrupt: impl Future<Output = ()>,
    work: impl AsyncFnOnce(&Connection) -> Report,
) -> Report {
    tokio::pin!(interrupt);
    let connection = tokio::select! {
        biased;
        opened = Connection::open(options) => match opened {
            Ok(connection) => connection,
            Err(error) => return failure(error),
        },
        () = &mut interrupt => return failure(INTERRUPTED.to_owned()),
    };
    let report = tokio::select! {
        biased;
        report = work(&connection) => report,
        () = &mut interrupt => failure(INTERRUPTED.to_owned()),
    };
    connection.revoke().await;
    report
}

/// `bibcode mcp call`, on this process's streams; returns its exit code.
pub async fn run_mcp_call(options: RelayOptions, args: CallArgs) -> i32 {
    call(
        options,
        args,
        std::io::stdin(),
        &mut std::io::stdout(),
        &mut std::io::stderr(),
        super::relay::shutdown_signal(),
    )
    .await
}

pub(crate) async fn call(
    options: RelayOptions,
    args: CallArgs,
    stdin: impl Read,
    out: &mut impl Write,
    err: &mut impl Write,
    interrupt: impl Future<Output = ()>,
) -> i32 {
    let report = match checked(&args, stdin) {
        Err(error) => failure(error),
        Ok(arguments) => {
            connected(options, interrupt, async |connection: &Connection| {
                call_report(connection.call_tool(1, &args.tool, arguments, LABEL).await)
            })
            .await
        }
    };
    print(&report, out, err)
}

/// `bibcode mcp tools`, on this process's streams; returns its exit code.
pub async fn run_mcp_tools(options: RelayOptions) -> i32 {
    tools(
        options,
        &mut std::io::stdout(),
        &mut std::io::stderr(),
        super::relay::shutdown_signal(),
    )
    .await
}

pub(crate) async fn tools(
    options: RelayOptions,
    out: &mut impl Write,
    err: &mut impl Write,
    interrupt: impl Future<Output = ()>,
) -> i32 {
    let report = connected(options, interrupt, async |connection: &Connection| {
        tools_report(connection.list_tools(1, LABEL).await)
    })
    .await;
    print(&report, out, err)
}

#[cfg(test)]
mod tests;
