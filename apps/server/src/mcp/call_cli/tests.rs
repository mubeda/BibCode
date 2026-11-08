//! `bibcode mcp call` and `bibcode mcp tools`: which tools one run takes, its exit codes, and
//! end to end against a real BiBCode server on this data root.

use std::path::Path;

use clap::Parser as _;
use serde_json::{Value, json};

use super::*;
use crate::{
    CliAction, ServerConfig, ServerRuntime,
    mcp::control::{McpAccess, PrincipalKind, tool_specs},
};

fn args(tool: &str, arguments: Option<&str>) -> CallArgs {
    CallArgs {
        tool: tool.to_owned(),
        arguments: arguments.map(str::to_owned),
    }
}

#[test]
fn call_and_tools_parse_under_mcp_with_its_access() {
    let parsed = |argv: &[&str]| {
        crate::Cli::try_parse_from(argv)
            .expect("parses")
            .into_action()
            .expect("an action")
    };
    let CliAction::McpCall { options, args } = parsed(&[
        "bibcode",
        "mcp",
        "--access",
        "read-only",
        "call",
        "read_thread",
        "{\"threadId\":\"t1\"}",
    ]) else {
        panic!("a call");
    };
    assert_eq!(options.access, Some(McpAccess::ReadOnly));
    assert_eq!(args.tool, "read_thread");
    assert_eq!(args.arguments.as_deref(), Some("{\"threadId\":\"t1\"}"));
    let CliAction::McpCall { args, .. } =
        parsed(&["bibcode", "mcp", "call", "server_capabilities"])
    else {
        panic!("a call");
    };
    assert!(args.arguments.is_none());
    assert!(matches!(
        parsed(&["bibcode", "mcp", "tools"]),
        CliAction::McpTools(_)
    ));
    assert!(crate::Cli::try_parse_from(["bibcode", "mcp", "call"]).is_err());
}

/// One run revokes its credential on exit, so it takes the read-only tools, which finish within
/// the call, except `files_download`, whose URL would die with it.
#[test]
fn one_shot_takes_every_read_only_tool_but_files_download() {
    for spec in tool_specs(PrincipalKind::Client) {
        assert_eq!(
            one_shot(spec.name),
            spec.read_only && spec.name != "files_download",
            "{}",
            spec.name
        );
    }
    for name in [
        "files_download",
        "files_upload",
        "clone_repository",
        "send_message",
        "answer_approval",
        "no_such_tool",
    ] {
        assert!(!one_shot(name), "{name}");
    }
    for name in [
        "list_projects_and_threads",
        "read_thread",
        "changes_since",
        "server_capabilities",
    ] {
        assert!(one_shot(name), "{name}");
    }
}

#[test]
fn arguments_are_a_json_object_from_the_argument_or_standard_input() {
    assert_eq!(
        checked(&args("read_thread", None), std::io::empty()).unwrap(),
        json!({})
    );
    assert_eq!(
        checked(
            &args("read_thread", Some("-")),
            std::io::Cursor::new("{\"threadId\":\"t1\"}\n")
        )
        .unwrap(),
        json!({ "threadId": "t1" })
    );
    for bad in ["[\"Mauve\"]", "Mauve", "{\"Mauve\":"] {
        let refusal = checked(&args("read_thread", Some(bad)), std::io::empty()).unwrap_err();
        assert!(!refusal.contains("Mauve"), "{refusal}");
    }
    let unknown = checked(&args("no_such_tool", None), std::io::empty()).unwrap_err();
    assert!(unknown.contains("bibcode mcp tools"), "{unknown}");
    for tool in ["files_download", "files_upload", "clone_repository"] {
        let refusal = checked(&args(tool, None), std::io::empty()).unwrap_err();
        assert!(
            refusal.contains("needs a connection that stays open"),
            "{refusal}"
        );
    }
}

#[test]
fn exit_codes_say_success_failure_or_a_person_must_answer() {
    let result = |content: Value| json!({ "content": [], "structuredContent": content });
    let ok = call_report(Ok(result(json!({ "threadId": "t1", "status": "idle" }))));
    assert_eq!((ok.code, ok.note), (0, None));
    assert_eq!(ok.out.unwrap()["structuredContent"]["status"], "idle");
    for status in ["awaiting_approval", "awaiting_input"] {
        let waiting = call_report(Ok(result(json!({ "status": status }))));
        assert_eq!(waiting.code, 2, "{status}");
        assert!(waiting.note.unwrap().contains("in BiBCode"));
    }
    let refused = call_report(Ok(json!({
        "isError": true,
        "structuredContent": { "error": { "_tag": "McpThreadNotFoundError", "message": "No thread t9." } },
        "content": [{ "type": "text", "text": "No thread t9." }],
    })));
    assert_eq!(refused.code, 1);
    assert_eq!(refused.note.as_deref(), Some("No thread t9."));
    assert!(
        refused.out.is_some(),
        "the result is printed on a tool error too"
    );
    let lost = call_report(Err("BiBCode is not reachable.".into()));
    assert_eq!((lost.code, lost.out), (1, None));
}

#[test]
fn tools_marks_each_tool_one_shot_or_not() {
    let report = tools_report(Ok(json!({
        "tools": [{ "name": "read_thread" }, { "name": "files_download" }, { "name": "send_message" }],
        "ttlMs": 1,
    })));
    assert_eq!(report.code, 0);
    assert_eq!(
        report.out.unwrap(),
        json!({ "tools": [
            { "name": "read_thread", "oneShot": true },
            { "name": "files_download", "oneShot": false },
            { "name": "send_message", "oneShot": false },
        ] })
    );
}

/// Standard output that is full or closed.
struct Full;

impl std::io::Write for Full {
    fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
        Err(std::io::Error::other("no space left on device"))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Err(std::io::Error::other("no space left on device"))
    }
}

/// A result that cannot be written is a failure: `call ... > /dev/full` exits 1, not 0.
#[test]
fn a_result_that_cannot_be_written_exits_1() {
    let mut err = Vec::new();
    let report = call_report(Ok(json!({ "content": [], "structuredContent": {} })));
    assert_eq!(report.code, 0);
    assert_eq!(print(&report, &mut Full, &mut err), 1);
    let err = String::from_utf8(err).unwrap();
    assert!(err.contains("could not write"), "{err}");
    let listed = tools_report(Ok(json!({ "tools": [] })));
    assert_eq!(print(&listed, &mut Full, &mut Vec::new()), 1);
    assert_eq!(print(&listed, &mut Vec::new(), &mut Vec::new()), 0);
}

fn options(root: &Path, access: Option<McpAccess>) -> RelayOptions {
    RelayOptions {
        root: crate::data_root::resolve_data_root(crate::data_root::DataRootRequest::explicit(
            crate::data_root::DataRootSource::Cli,
            root.to_path_buf(),
            root.to_path_buf(),
        ))
        .expect("data root"),
        dev_url: None,
        url: None,
        access,
        client: None,
    }
}

struct Ran {
    code: i32,
    out: String,
    err: String,
}

async fn run_call(
    root: &Path,
    access: Option<McpAccess>,
    tool: &str,
    arguments: Option<&str>,
) -> Ran {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = call(
        options(root, access),
        args(tool, arguments),
        std::io::empty(),
        &mut out,
        &mut err,
        std::future::pending(),
    )
    .await;
    Ran {
        code,
        out: String::from_utf8(out).unwrap(),
        err: String::from_utf8(err).unwrap(),
    }
}

/// This command's credentials: `(label, revoked)` for each `mcp-client` session.
async fn credentials(root: &Path) -> Vec<(String, bool)> {
    let database =
        crate::persistence::Database::open_existing(ServerConfig::new(root).database_path())
            .await
            .expect("database");
    let rows = database
        .call(|connection| {
            let mut statement = connection.prepare(
                "SELECT client_label, revoked_at IS NOT NULL FROM auth_sessions WHERE subject = 'mcp-client'",
            )?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .expect("sessions");
    database.close().await;
    rows
}

/// Against a real server: a read tool prints its result and exits 0, `tools` marks what one
/// run takes, `files_download`, `files_upload`, `clone_repository` and an unknown tool are
/// refused with no credential minted, and `--access` above **Agents may** is refused before
/// one. Every credential a run minted is revoked.
#[tokio::test]
async fn a_read_tool_runs_and_every_other_is_refused_before_any_credential() {
    let root = tempfile::tempdir().expect("root");
    crate::test_support::hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(root.path()).state_dir(),
        json!({ "mcpServerAccess": "approval-required" }),
    );
    let server = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("server starts");

    let ran = run_call(root.path(), None, "list_projects_and_threads", Some("{}")).await;
    assert_eq!(ran.code, 0, "{} {}", ran.out, ran.err);
    let result: Value = serde_json::from_str(ran.out.trim()).expect("one JSON document");
    assert!(
        result["structuredContent"]["projects"].is_array(),
        "{result}"
    );

    let missing = run_call(
        root.path(),
        None,
        "read_thread",
        Some("{\"threadId\":\"t9\"}"),
    )
    .await;
    assert_eq!(missing.code, 1, "{}", missing.out);
    assert!(missing.err.starts_with("bibcode: "), "{}", missing.err);

    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = tools(
        options(root.path(), None),
        &mut out,
        &mut err,
        std::future::pending(),
    )
    .await;
    assert_eq!(code, 0, "{}", String::from_utf8_lossy(&err));
    let listed: Value = serde_json::from_slice(&out).expect("one JSON document");
    let one = |name: &str| {
        listed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .map(|tool| tool["oneShot"].clone())
    };
    assert_eq!(one("list_projects_and_threads"), Some(json!(true)));
    assert_eq!(one("files_download"), Some(json!(false)));
    assert_eq!(one("send_message"), Some(json!(false)));
    assert_eq!(credentials(root.path()).await.len(), 3);

    for tool in [
        "files_download",
        "files_upload",
        "clone_repository",
        "no_such_tool",
    ] {
        let refused = run_call(root.path(), None, tool, None).await;
        assert_eq!(refused.code, 1, "{tool}");
        assert!(refused.out.is_empty(), "{tool}: {}", refused.out);
    }
    let above = run_call(
        root.path(),
        Some(McpAccess::FullAccess),
        "server_capabilities",
        None,
    )
    .await;
    assert_eq!(above.code, 1);
    assert!(
        above.err.contains("above this environment's limit"),
        "{}",
        above.err
    );

    let credentials = credentials(root.path()).await;
    assert_eq!(
        credentials.len(),
        3,
        "no refused run minted one: {credentials:?}"
    );
    assert!(
        credentials
            .iter()
            .all(|(label, revoked)| label == LABEL && *revoked),
        "{credentials:?}"
    );
    server.shutdown();
    server.join().await.expect("server joins");
}
