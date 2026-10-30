//! `bibcode thread` against scripted tools, and end to end against a real BiBCode server on
//! this data root whose provider is faked: its events are dispatched to the engine as a
//! provider runtime would.

use std::{collections::VecDeque, sync::Mutex, time::Duration};

use clap::Parser as _;
use serde_json::{Value, json};

use super::*;
use crate::{CliAction, ServerConfig, ServerHandle, ServerRuntime};

/// Tools that answer from a script and record every call.
struct Scripted {
    answers: Mutex<VecDeque<(&'static str, Result<Value, String>)>>,
    calls: Mutex<Vec<(String, Value)>>,
}

impl Scripted {
    fn new(answers: Vec<(&'static str, Result<Value, String>)>) -> Self {
        Self {
            answers: Mutex::new(answers.into()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().unwrap().clone()
    }

    fn names(&self) -> Vec<String> {
        self.calls().into_iter().map(|(name, _)| name).collect()
    }
}

impl Tools for Scripted {
    async fn call(&self, name: &str, arguments: Value) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push((name.to_owned(), arguments));
        let (expected, answer) = self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("no answer scripted for {name}"));
        assert_eq!(name, expected, "the tool called");
        answer
    }
}

fn ok(content: Value) -> Result<Value, String> {
    Ok(json!({ "content": [], "structuredContent": content }))
}

fn tool_error(tag: &str, message: &str) -> Result<Value, String> {
    Ok(json!({
        "isError": true,
        "structuredContent": { "error": { "_tag": tag, "message": message } },
        "content": [{ "type": "text", "text": message }],
    }))
}

fn waited(status: &str, timed_out: bool, reply: Option<&str>) -> Result<Value, String> {
    ok(json!({
        "threadId": "thread-1", "status": status, "turnId": "turn-1", "timedOut": timed_out,
        "settled": !timed_out, "error": null,
        "reply": reply.map(|text| json!({
            "messageId": "reply-1", "text": text, "textLength": text.chars().count(), "streaming": false,
        })),
    }))
}

fn started() -> Result<Value, String> {
    ok(
        json!({ "threadId": "thread-1", "messageId": "message-1", "runtimeMode": "approval-required" }),
    )
}

fn start(project: &str, wait: bool) -> ThreadCommand {
    ThreadCommand::Start {
        project: project.to_owned(),
        message: "Say hello".to_owned(),
        title: None,
        provider: None,
        model: None,
        wait,
        request_id: Some("req-1".into()),
    }
}

async fn execute_now(command: &ThreadCommand, tools: &Scripted) -> Report {
    let message = message_of(command, std::io::empty()).expect("a message");
    execute(
        command,
        message,
        tools,
        Path::new("."),
        &CancellationToken::new(),
    )
    .await
}

fn parse(args: &[&str]) -> (RelayOptions, ThreadArgs) {
    match crate::Cli::try_parse_from(args)
        .expect("parses")
        .into_action()
        .expect("an action")
    {
        CliAction::Thread { options, args } => (options, args),
        other => panic!("not a thread action: {other:?}"),
    }
}

#[test]
fn every_subcommand_and_flag_parses() {
    let root = tempfile::tempdir().expect("root");
    let base = root.path().to_str().unwrap();
    let (options, args) = parse(&[
        "bibcode",
        "--base-dir",
        base,
        "thread",
        "start",
        ".",
        "-",
        "--title",
        "Docs",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
        "--wait",
        "--request-id",
        "req-9",
        "--json",
    ]);
    assert_eq!(options.root.requested, root.path());
    assert!(options.url.is_none() && options.access.is_none());
    assert!(args.json);
    let ThreadCommand::Start {
        project,
        message,
        title,
        provider,
        model,
        wait,
        request_id,
    } = args.command
    else {
        panic!("a start");
    };
    assert_eq!((project.as_str(), message.as_str()), (".", "-"));
    assert_eq!(title.as_deref(), Some("Docs"));
    assert_eq!(provider.as_deref(), Some("codex"));
    assert_eq!(model.as_deref(), Some("gpt-5"));
    assert!(wait);
    assert_eq!(request_id.as_deref(), Some("req-9"));

    let (_, args) = parse(&["bibcode", "thread", "--json", "send", "thread-1", "hi"]);
    assert!(args.json, "--json before the subcommand");
    assert!(matches!(
        args.command,
        ThreadCommand::Send { ref thread, ref message, wait: false, request_id: None } if thread == "thread-1" && message == "hi"
    ));
    let (_, args) = parse(&["bibcode", "thread", "list"]);
    assert!(!args.json && matches!(args.command, ThreadCommand::List));
    let (_, args) = parse(&["bibcode", "thread", "show", "thread-1"]);
    assert!(matches!(args.command, ThreadCommand::Show { ref thread } if thread == "thread-1"));

    for missing in [
        &["bibcode", "thread"][..],
        &["bibcode", "thread", "start", "."],
        &["bibcode", "thread", "send", "thread-1"],
        &["bibcode", "thread", "show"],
        &[
            "bibcode", "thread", "send", "thread-1", "hi", "--title", "x",
        ],
    ] {
        assert!(crate::Cli::try_parse_from(missing).is_err(), "{missing:?}");
    }
}

#[test]
fn dot_is_the_deepest_project_holding_the_current_folder() {
    let root = tempfile::tempdir().expect("root");
    let outer = root.path().join("outer");
    let inner = outer.join("inner");
    let deeper = inner.join("src");
    let elsewhere = root.path().join("elsewhere");
    for dir in [&deeper, &elsewhere] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let projects = vec![
        json!({ "projectId": "outer", "workspaceRoot": outer }),
        json!({ "projectId": "inner", "workspaceRoot": inner }),
        json!({ "projectId": "remote", "workspaceRoot": "C:/repo" }),
        json!({ "projectId": "no-folder" }),
    ];
    // The current directory is canonical (macOS reports /private/var for /var).
    let canonical = |path: &Path| std::fs::canonicalize(path).unwrap();
    assert_eq!(
        project_for(&canonical(&deeper), &projects).unwrap(),
        "inner"
    );
    assert_eq!(project_for(&canonical(&inner), &projects).unwrap(), "inner");
    assert_eq!(project_for(&canonical(&outer), &projects).unwrap(), "outer");
    let none = project_for(&canonical(&elsewhere), &projects).unwrap_err();
    assert!(none.contains("bibcode thread list"), "{none}");
    // A sibling whose name extends the root's is not inside it.
    let sibling = root.path().join("outer-two");
    std::fs::create_dir_all(&sibling).unwrap();
    assert!(project_for(&canonical(&sibling), &projects).is_err());

    let twice = vec![
        json!({ "projectId": "a", "workspaceRoot": inner }),
        json!({ "projectId": "b", "workspaceRoot": inner }),
    ];
    let ambiguous = project_for(&canonical(&deeper), &twice).unwrap_err();
    assert!(
        ambiguous.contains("a, b") || ambiguous.contains("b, a"),
        "{ambiguous}"
    );
}

#[tokio::test]
async fn start_dot_starts_in_the_project_that_holds_the_current_folder() {
    let root = tempfile::tempdir().expect("root");
    let tools = Scripted::new(vec![
        (
            "list_projects_and_threads",
            ok(
                json!({ "projects": [{ "projectId": "p1", "workspaceRoot": root.path() }], "threads": [] }),
            ),
        ),
        ("start_thread", started()),
    ]);
    let command = start(".", false);
    let report = execute(
        &command,
        Some("Say hello".into()),
        &tools,
        root.path(),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(report.code, 0, "{report:?}");
    let calls = tools.calls();
    assert_eq!(calls[1].1["projectId"], "p1");
    assert_eq!(calls[1].1["prompt"], "Say hello");
    assert!(
        calls[1].1["clientRequestId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "a retried start is idempotent: {}",
        calls[1].1
    );
}

#[tokio::test]
async fn json_has_one_shape_on_success_and_on_failure() {
    let tools = Scripted::new(vec![
        ("start_thread", started()),
        (
            "wait_for_thread",
            waited("completed", false, Some("Hello.")),
        ),
    ]);
    let report = execute_now(&start("p1", true), &tools).await;
    assert_eq!(report.code, 0);
    assert_eq!(
        report.json,
        json!({ "threadId": "thread-1", "messageId": "message-1", "status": "completed", "reply": "Hello.", "requestId": "req-1", "error": null })
    );
    assert_eq!(report.text, vec!["Hello."]);

    let tools = Scripted::new(vec![(
        "start_thread",
        tool_error("McpProjectNotFoundError", "No project nope."),
    )]);
    let report = execute_now(&start("nope", true), &tools).await;
    assert_eq!(report.code, 1);
    assert_eq!(
        report.json,
        json!({ "threadId": null, "messageId": null, "status": null, "reply": null, "requestId": "req-1", "error": "No project nope." })
    );

    let tools = Scripted::new(vec![
        ("start_thread", started()),
        ("wait_for_thread", Err("BiBCode is not reachable.".into())),
    ]);
    let report = execute_now(&start("p1", true), &tools).await;
    assert_eq!(report.code, 1);
    assert_eq!(
        report.json,
        json!({ "threadId": "thread-1", "messageId": "message-1", "status": null, "reply": null, "requestId": "req-1", "error": "BiBCode is not reachable." }),
        "a failure after the start keeps its ids"
    );

    let tools = Scripted::new(vec![("start_thread", started())]);
    let report = execute_now(&start("p1", false), &tools).await;
    assert_eq!(report.code, 0);
    assert_eq!(
        report.json,
        json!({ "threadId": "thread-1", "messageId": "message-1", "status": "started", "reply": null, "requestId": "req-1", "error": null })
    );
}

#[tokio::test]
async fn exit_codes_say_success_failure_or_a_person_must_answer() {
    for (status, code) in [
        ("completed", 0),
        ("awaiting_approval", 2),
        ("awaiting_input", 2),
        ("interrupted", 1),
        ("error", 1),
        ("delivery_failed", 1),
    ] {
        let tools = Scripted::new(vec![
            (
                "send_message",
                ok(json!({ "threadId": "thread-1", "messageId": "message-1", "queued": true })),
            ),
            ("wait_for_thread", waited(status, false, None)),
        ]);
        let command = ThreadCommand::Send {
            thread: "thread-1".into(),
            message: "next".into(),
            wait: true,
            request_id: Some("req-1".into()),
        };
        let report = execute_now(&command, &tools).await;
        assert_eq!(report.code, code, "{status}: {report:?}");
        assert_eq!(report.json["status"], status);
        assert_eq!(report.json["error"].is_null(), code != 1, "{status}");
        if code == 2 {
            assert!(
                report.note.as_deref().unwrap().contains("in BiBCode"),
                "{report:?}"
            );
        }
    }
}

#[tokio::test]
async fn wait_calls_the_tool_in_30_second_slices_and_never_interrupts() {
    let tools = Scripted::new(vec![
        (
            "send_message",
            ok(json!({ "threadId": "thread-1", "messageId": "message-1", "queued": true })),
        ),
        ("wait_for_thread", waited("queued", true, None)),
        ("wait_for_thread", waited("running", true, None)),
        (
            "wait_for_thread",
            tool_error("McpStorageError", "the work goes on. Wait again."),
        ),
        ("wait_for_thread", waited("completed", false, Some("Done."))),
    ]);
    let command = ThreadCommand::Send {
        thread: "thread-1".into(),
        message: "next".into(),
        wait: true,
        request_id: Some("req-1".into()),
    };
    tokio::time::pause();
    let report = execute_now(&command, &tools).await;
    assert_eq!(report.code, 0, "{report:?}");
    assert_eq!(report.json["reply"], "Done.");
    let waits: Vec<Value> = tools
        .calls()
        .into_iter()
        .filter(|(name, _)| name == "wait_for_thread")
        .map(|(_, arguments)| arguments)
        .collect();
    assert_eq!(waits.len(), 4);
    for arguments in &waits {
        assert_eq!(
            arguments,
            &json!({ "threadId": "thread-1", "messageId": "message-1", "timeoutMs": 30_000 })
        );
    }
    assert!(!tools.names().iter().any(|name| name == "interrupt_turn"));
}

/// A wait that answers only after a long while.
struct Slow;

impl Tools for Slow {
    async fn call(&self, name: &str, _arguments: Value) -> Result<Value, String> {
        assert_eq!(name, "wait_for_thread", "a stopped wait calls nothing else");
        tokio::time::sleep(Duration::from_secs(3600)).await;
        waited("running", true, None)
    }
}

#[tokio::test]
async fn stopping_a_wait_leaves_the_work_running_and_exits_1() {
    let stop = CancellationToken::new();
    let waiting = wait_for(&Slow, "thread-1", "message-1", "req-1", &stop);
    let stopper = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        stop.cancel();
    };
    let (report, ()) = tokio::join!(waiting, stopper);
    assert_eq!(report.code, 1);
    assert_eq!(report.json["threadId"], "thread-1");
    assert_eq!(report.json["messageId"], "message-1");
    assert!(
        report.json["error"]
            .as_str()
            .unwrap()
            .contains("the work goes on"),
        "{report:?}"
    );
}

#[tokio::test]
async fn a_long_reply_is_read_in_full() {
    let first = "a".repeat(16_000);
    let tools = Scripted::new(vec![
        ("start_thread", started()),
        (
            "wait_for_thread",
            ok(json!({
                "threadId": "thread-1", "status": "completed", "timedOut": false,
                "reply": { "messageId": "reply-1", "text": first, "textLength": 16_005, "streaming": false },
            })),
        ),
        (
            "read_thread",
            ok(
                json!({ "message": { "messageId": "reply-1", "textOffset": 16_000, "text": "bcdef", "textLength": 16_005 } }),
            ),
        ),
    ]);
    let report = execute_now(&start("p1", true), &tools).await;
    assert_eq!(report.code, 0);
    let reply = report.json["reply"].as_str().unwrap();
    assert_eq!(reply.len(), 16_005);
    assert!(reply.ends_with("abcdef"));
    assert_eq!(tools.calls()[2].1["textOffset"], 16_000);
}

#[test]
fn a_dash_reads_the_message_from_standard_input() {
    let send = |message: &str| ThreadCommand::Send {
        thread: "thread-1".into(),
        message: message.into(),
        wait: false,
        request_id: None,
    };
    assert_eq!(
        message_of(&send("-"), std::io::Cursor::new("line one\nline two\n")).unwrap(),
        Some("line one\nline two".into())
    );
    assert_eq!(
        message_of(&send("literal"), std::io::Cursor::new("ignored")).unwrap(),
        Some("literal".into())
    );
    assert!(message_of(&send("-"), std::io::Cursor::new("\n\n")).is_err());
    assert!(message_of(&send(""), std::io::empty()).is_err());
    assert_eq!(
        message_of(&ThreadCommand::List, std::io::empty()).unwrap(),
        None
    );
}

fn options(root: &Path) -> RelayOptions {
    RelayOptions {
        root: crate::data_root::resolve_data_root(crate::data_root::DataRootRequest::explicit(
            crate::data_root::DataRootSource::Cli,
            root.to_path_buf(),
            root.to_path_buf(),
        ))
        .expect("data root"),
        dev_url: None,
        url: None,
        access: None,
    }
}

struct Ran {
    code: i32,
    out: String,
    err: String,
}

impl Ran {
    fn json(&self) -> Value {
        serde_json::from_str(self.out.trim()).unwrap_or_else(|_| panic!("JSON: {}", self.out))
    }
}

async fn run_in(root: &Path, cwd: &Path, args: &[&str], stdin: &str) -> Ran {
    let mut argv = vec!["bibcode", "thread"];
    argv.extend_from_slice(args);
    let (_, args) = parse(&argv);
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = run(
        options(root),
        args,
        cwd,
        std::io::Cursor::new(stdin.to_owned()),
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

#[tokio::test]
async fn the_setting_off_exits_1_naming_it_before_any_credential() {
    let root = tempfile::tempdir().expect("root");
    let paths = crate::persistence::StatePaths::from_config(&ServerConfig::new(root.path()));
    std::fs::create_dir_all(&paths.state_dir).unwrap();
    std::fs::write(
        &paths.settings,
        json!({ "enableMcpServer": false }).to_string(),
    )
    .unwrap();
    for args in [&["list", "--json"][..], &["start", "p1", "hi", "--json"]] {
        let ran = run_in(root.path(), root.path(), args, "").await;
        assert_eq!(ran.code, 1, "{args:?}");
        assert_eq!(
            ran.json()["error"],
            crate::mcp::relay::DISABLED_EXIT_MESSAGE,
            "{args:?}"
        );
        assert!(ran.err.contains("MCP server"), "{}", ran.err);
    }
    let ran = run_in(root.path(), root.path(), &["list"], "").await;
    assert_eq!((ran.code, ran.out.as_str()), (1, ""));
    assert!(ran.err.contains("Agent integrations"), "{}", ran.err);
}

/// A server on `root` whose only provider is Codex at `codex`; every other one is off.
async fn start_server(root: &Path, codex: &Path) -> ServerHandle {
    let mut providers = crate::test_support::hermetic_providers::BUILTIN_PROVIDER_DRIVERS
        .iter()
        .map(|driver| ((*driver).to_owned(), json!({ "enabled": false })))
        .collect::<serde_json::Map<String, Value>>();
    providers.insert(
        "codex".into(),
        json!({ "enabled": true, "binaryPath": codex }),
    );
    crate::test_support::hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(root).state_dir(),
        json!({ "providers": providers }),
    );
    ServerRuntime::start(ServerConfig::new(root).with_bind("127.0.0.1", 0))
        .await
        .expect("server starts")
}

/// Project `p1` in `<root>/workspace`, and the canonical `src` folder inside it to run from.
async fn project(server: &ServerHandle, root: &Path) -> PathBuf {
    let workspace = root.join("workspace");
    std::fs::create_dir_all(workspace.join("src")).unwrap();
    server
        .orchestration_for_test()
        .expect("engine")
        .dispatch(
            serde_json::from_value(json!({
                "type": "project.create", "commandId": "project", "projectId": "p1", "title": "P",
                "workspaceRoot": workspace,
                "defaultModelSelection": { "instanceId": "codex", "model": "gpt-5" },
                "createdAt": "2026-10-30T00:00:00.000Z",
            }))
            .expect("command"),
        )
        .await
        .expect("project");
    std::fs::canonicalize(workspace.join("src")).unwrap()
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

/// A delivery that fails (no Codex binary) ends the wait with exit 1 and the thread's ids, and
/// every run's credential is revoked.
#[tokio::test]
async fn an_undeliverable_start_waits_to_delivery_failed_and_exits_1() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path(), &root.path().join("no-such-codex")).await;
    let cwd = project(&server, root.path()).await;

    let listed = run_in(root.path(), &cwd, &["list", "--json"], "").await;
    assert_eq!(listed.code, 0, "{}", listed.err);
    assert_eq!(listed.json()["projects"][0]["projectId"], "p1");

    let started = run_in(
        root.path(),
        &cwd,
        &["start", ".", "-", "--wait", "--json"],
        "Say hello\n",
    )
    .await;
    assert_eq!(started.code, 1, "{} {}", started.out, started.err);
    let report = started.json();
    assert_eq!(report["status"], "delivery_failed", "{report}");
    assert!(report["threadId"].is_string() && report["messageId"].is_string());
    assert!(report["error"].is_string(), "{report}");
    assert!(
        !started.err.contains("Say hello"),
        "never echoes the message"
    );

    let refused = run_in(
        root.path(),
        &cwd,
        &["start", "p1", "hi", "--provider", "claude", "--json"],
        "",
    )
    .await;
    assert_eq!(refused.code, 1);
    assert!(refused.json()["error"].is_string(), "{}", refused.out);

    let credentials = credentials(root.path()).await;
    assert_eq!(
        credentials.len(),
        3,
        "one credential per run: {credentials:?}"
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

/// A Codex app-server that answers each turn with one reply, or, for a message that says
/// `needs-approval`, asks to run a command and waits.
#[cfg(unix)]
const FAKE_CODEX: &str = r#"#!/bin/sh
turn=0
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fake"}}\n' "$id" ;;
    *'"method":"thread/start"'*|*'"method":"thread/resume"'*)
      printf '{"id":%s,"result":{"cwd":"/tmp","model":"gpt-5","thread":{"id":"fake-thread"}}}\n' "$id" ;;
    *'"method":"turn/start"'*)
      turn=$((turn + 1))
      printf '{"id":%s,"result":{"turn":{"id":"fake-turn-%s"}}}\n' "$id" "$turn"
      printf '{"method":"turn/started","params":{"threadId":"fake-thread","turn":{"id":"fake-turn-%s"}}}\n' "$turn"
      case "$line" in
        *needs-approval*)
          printf '{"id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":"fake-thread","turnId":"fake-turn-%s","itemId":"command-%s","command":"ls","reason":"List the files"}}\n' "$turn" "$turn" ;;
        *)
          printf '{"method":"item/agentMessage/delta","params":{"threadId":"fake-thread","turnId":"fake-turn-%s","itemId":"reply-%s","delta":"Hello from the fake provider."}}\n' "$turn" "$turn"
          printf '{"method":"item/completed","params":{"threadId":"fake-thread","turnId":"fake-turn-%s","item":{"id":"reply-%s","type":"agentMessage","text":"Hello from the fake provider."}}}\n' "$turn" "$turn"
          printf '{"method":"turn/completed","params":{"threadId":"fake-thread","turn":{"id":"fake-turn-%s","status":"completed"}}}\n' "$turn" ;;
      esac ;;
    *'"method":"mcpServerStatus/list"'*|*'"method":"model/list"'*|*'"method":"thread/turns/list"'*)
      printf '{"id":%s,"result":{"data":[],"nextCursor":null}}\n' "$id" ;;
    *'"method":"thread/read"'*) printf '{"id":%s,"result":{"thread":{"id":"fake-thread","turns":[]}}}\n' "$id" ;;
    *'"method":'*) [ -n "$id" ] && printf '{"id":%s,"result":{}}\n' "$id" ;;
  esac
done
"#;

/// The whole CLI against a real server whose Codex is [`FAKE_CODEX`]: `start .` with `--wait`
/// prints the reply and exits 0, `send --wait` exits 0, a turn that needs an approval exits 2,
/// and `show` and `list` read the thread.
#[cfg(unix)]
#[tokio::test]
async fn start_send_and_show_against_a_real_server() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = tempfile::tempdir().expect("root");
    let codex = root.path().join("fake-codex");
    std::fs::write(&codex, FAKE_CODEX).unwrap();
    std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    let server = start_server(root.path(), &codex).await;
    let cwd = project(&server, root.path()).await;

    let started = run_in(
        root.path(),
        &cwd,
        &["start", ".", "-", "--wait", "--json", "--title", "Greeting"],
        "Say hello\n",
    )
    .await;
    assert_eq!(started.code, 0, "{} {}", started.out, started.err);
    let report = started.json();
    assert_eq!(report["status"], "completed", "{report}");
    assert_eq!(report["reply"], "Hello from the fake provider.");
    assert!(report["error"].is_null());
    let thread = report["threadId"].as_str().unwrap().to_owned();

    let sent = run_in(
        root.path(),
        &cwd,
        &["send", &thread, "And again", "--wait"],
        "",
    )
    .await;
    assert_eq!(sent.code, 0, "{} {}", sent.out, sent.err);
    assert_eq!(sent.out.trim(), "Hello from the fake provider.");

    let shown = run_in(root.path(), &cwd, &["show", &thread, "--json"], "").await;
    assert_eq!(shown.code, 0, "{}", shown.err);
    let read = shown.json();
    assert_eq!(read["title"], "Greeting");
    assert_eq!(read["status"], "idle", "{read}");
    let roles: Vec<&str> = read["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["user", "assistant", "user", "assistant"], "{read}");
    let human = run_in(root.path(), &cwd, &["show", &thread], "").await;
    assert!(human.out.starts_with("Greeting ("), "{}", human.out);

    let asked = run_in(
        root.path(),
        &cwd,
        &["send", &thread, "This needs-approval", "--wait", "--json"],
        "",
    )
    .await;
    assert_eq!(asked.code, 2, "{} {}", asked.out, asked.err);
    assert_eq!(asked.json()["status"], "awaiting_approval");
    assert!(asked.err.contains("answer it in BiBCode"), "{}", asked.err);

    let listed = run_in(root.path(), &cwd, &["list"], "").await;
    assert!(
        listed
            .out
            .contains(&format!("{thread}  awaiting_approval  Greeting")),
        "{}",
        listed.out
    );
    assert!(
        credentials(root.path())
            .await
            .iter()
            .all(|(_, revoked)| *revoked)
    );
    server.shutdown();
    server.join().await.expect("server joins");
}

/// Creates a project, `created` seconds into the test's day.
async fn create_project(server: &ServerHandle, id: &str, title: &str, root: &Path, created: u32) {
    server
        .orchestration_for_test()
        .expect("engine")
        .dispatch(
            serde_json::from_value(json!({
                "type": "project.create", "commandId": format!("project-{id}"), "projectId": id,
                "title": title, "workspaceRoot": root,
                "defaultModelSelection": { "instanceId": "codex", "model": "gpt-5" },
                "createdAt": format!("2026-10-30T00:{:02}:{:02}.000Z", created / 60, created % 60),
            }))
            .expect("command"),
        )
        .await
        .expect("project");
}

/// The project list is cut to fit one result, so the nested project that holds the current
/// folder is on a later page; `start .` and `list` read every page.
#[tokio::test]
async fn dot_and_list_read_every_page_of_projects() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path(), &root.path().join("no-such-codex")).await;
    let cwd = project(&server, root.path()).await;
    for index in 0..59 {
        let folder = root.path().join(format!("filler-{index:02}"));
        std::fs::create_dir_all(&folder).unwrap();
        let title = format!("{index:02} {}", "t".repeat(2_000));
        let id = format!("filler-{index:02}");
        create_project(&server, &id, &title, &folder, 60 + index).await;
    }
    create_project(&server, "nested", "Nested", &cwd, 200).await;

    let started = run_in(root.path(), &cwd, &["start", ".", "hi", "--json"], "").await;
    assert_eq!(started.code, 0, "{} {}", started.out, started.err);
    let thread = started.json()["threadId"].as_str().unwrap().to_owned();

    let listed = run_in(root.path(), &cwd, &["list", "--json"], "").await;
    assert_eq!(listed.code, 0, "{}", listed.err);
    let listed = listed.json();
    assert_eq!(
        listed["projects"].as_array().unwrap().len(),
        61,
        "every project, once"
    );
    assert!(listed["truncated"].is_null() && listed["nextCursor"].is_null());
    let thread = listed["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["threadId"] == thread.as_str())
        .expect("the started thread is listed");
    assert_eq!(
        thread["projectId"], "nested",
        "the deepest project holds src"
    );
    server.shutdown();
    server.join().await.expect("server joins");
}

fn page(projects: &[&str], threads: &[&str], cursor: Option<&str>, project: Option<&str>) -> Value {
    json!({
        "projects": projects.iter().map(|id| json!({ "projectId": id, "workspaceRoot": "/x" })).collect::<Vec<_>>(),
        "threads": threads.iter().map(|id| json!({ "threadId": id, "projectId": "a" })).collect::<Vec<_>>(),
        "threadCount": 3, "projectCount": 3, "truncated": true,
        "nextCursor": cursor, "nextProjectCursor": project,
    })
}

#[tokio::test]
async fn list_follows_both_cursors_into_one_document() {
    let tools = Scripted::new(vec![
        (
            "list_projects_and_threads",
            ok(page(&["a"], &["t1"], Some("t:1"), Some("p:1"))),
        ),
        (
            "list_projects_and_threads",
            ok(page(&["b"], &["t2"], Some("t:2"), Some("p:2"))),
        ),
        (
            "list_projects_and_threads",
            ok(page(&["c"], &["th3"], None, Some("p:3"))),
        ),
        (
            "list_projects_and_threads",
            ok(page(&["d"], &[], None, None)),
        ),
    ]);
    let report = list(&tools).await.expect("a listing");
    let ids = |key: &str, id: &str| -> Vec<String> {
        report.json[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry[id].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(ids("projects", "projectId"), ["a", "b", "c", "d"]);
    assert_eq!(ids("threads", "threadId"), ["t1", "t2", "th3"]);
    assert!(report.json["truncated"].is_null() && report.json["nextCursor"].is_null());
    let calls = tools.calls();
    assert_eq!(calls[0].1, json!({ "limit": 200 }));
    assert_eq!(
        calls[1].1,
        json!({ "limit": 200, "cursor": "t:1", "projectCursor": "p:1" })
    );
    // Once the threads are read, the projects continue alone.
    assert_eq!(calls[3].1, json!({ "limit": 200, "projectCursor": "p:3" }));
}

#[tokio::test]
async fn dot_reads_only_the_project_pages_and_stops_at_a_bound() {
    let tools = Scripted::new(vec![
        (
            "list_projects_and_threads",
            ok(page(&["outer"], &["t1"], Some("t:1"), Some("p:1"))),
        ),
        (
            "list_projects_and_threads",
            ok(page(&["inner"], &[], None, None)),
        ),
    ]);
    let listed = list_all(&tools, false).await.expect("projects");
    assert_eq!(listed["projects"].as_array().unwrap().len(), 2);
    assert_eq!(
        tools.calls()[1].1,
        json!({ "limit": 1, "projectCursor": "p:1" }),
        "the thread cursor is not followed"
    );

    let endless = (0..MOST_PAGES)
        .map(|_| {
            (
                "list_projects_and_threads",
                ok(page(&["a"], &[], None, Some("p:1"))),
            )
        })
        .collect();
    let tools = Scripted::new(endless);
    let error = list_all(&tools, false).await.unwrap_err();
    assert!(error.contains("more than 50 pages"), "{error}");
    assert_eq!(tools.calls().len(), MOST_PAGES);
}

fn send(request_id: Option<&str>) -> ThreadCommand {
    ThreadCommand::Send {
        thread: "thread-1".into(),
        message: "next".into(),
        wait: false,
        request_id: request_id.map(str::to_owned),
    }
}

#[tokio::test]
async fn the_request_id_is_the_client_request_id_and_is_reported() {
    let tools = Scripted::new(vec![("start_thread", started())]);
    let report = execute_now(&start("p1", false), &tools).await;
    assert_eq!(tools.calls()[0].1["clientRequestId"], "req-1");
    assert_eq!(report.json["requestId"], "req-1");

    // Without one, a request id is made up, and it is the one reported.
    let tools = Scripted::new(vec![(
        "send_message",
        ok(json!({ "threadId": "thread-1", "messageId": "message-1", "queued": false })),
    )]);
    let report = execute_now(&send(None), &tools).await;
    let made_up = tools.calls()[0].1["clientRequestId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(report.json["requestId"], made_up.as_str());
    assert!(!made_up.is_empty());
}

#[tokio::test]
async fn an_unknown_outcome_names_the_request_id_and_a_refusal_does_not() {
    for command in [start("p1", false), send(Some("req-1"))] {
        let name = if matches!(command, ThreadCommand::Start { .. }) {
            "start_thread"
        } else {
            "send_message"
        };
        let tools = Scripted::new(vec![(name, Err("BiBCode is not reachable.".into()))]);
        let report = execute_now(&command, &tools).await;
        assert_eq!(report.code, 1);
        assert_eq!(report.json["requestId"], "req-1");
        assert_eq!(report.json["error"], "BiBCode is not reachable.");
        let note = report.note.unwrap();
        assert!(
            note.ends_with(
                "Run the same command with --request-id req-1 to finish it without repeating it."
            ),
            "{note}"
        );

        let tools = Scripted::new(vec![(name, tool_error("McpProjectNotFoundError", "No."))]);
        let report = execute_now(&command, &tools).await;
        assert_eq!(report.json["requestId"], "req-1");
        assert_eq!(
            report.note.as_deref(),
            Some("No."),
            "a refusal changed nothing"
        );
    }
}

/// A start whose answer never comes.
struct Silent;

impl Tools for Silent {
    async fn call(&self, name: &str, _arguments: Value) -> Result<Value, String> {
        assert_eq!(name, "start_thread");
        std::future::pending().await
    }
}

#[tokio::test]
async fn an_interrupted_start_names_the_request_id() {
    let command = start("p1", false);
    let stop = CancellationToken::new();
    let work = execute(&command, Some("hi".into()), &Silent, Path::new("."), &stop);
    let stopper = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        stop.cancel();
    };
    let (report, ()) = tokio::join!(until_stopped(&command, &stop, work), stopper);
    assert_eq!(report.code, 1);
    assert_eq!(report.json["requestId"], "req-1");
    assert_eq!(report.json["threadId"], Value::Null);
    let note = report.note.unwrap();
    assert!(note.starts_with(INTERRUPTED), "{note}");
    assert!(note.contains("--request-id req-1"), "{note}");
}

#[test]
fn a_request_id_is_one_to_256_characters() {
    for bad in [String::new(), "x".repeat(257)] {
        let argv = [
            "bibcode",
            "thread",
            "send",
            "thread-1",
            "hi",
            "--request-id",
            &bad,
        ];
        assert!(
            crate::Cli::try_parse_from(argv).is_err(),
            "{} characters",
            bad.len()
        );
    }
    let longest = "x".repeat(256);
    let argv = [
        "bibcode",
        "thread",
        "send",
        "thread-1",
        "hi",
        "--request-id",
        &longest,
    ];
    assert!(crate::Cli::try_parse_from(argv).is_ok());
    let argv = [
        "bibcode",
        "thread",
        "start",
        "p1",
        "hi",
        "--request-id",
        "r",
    ];
    assert!(crate::Cli::try_parse_from(argv).is_ok());
    let argv = ["bibcode", "thread", "show", "thread-1", "--request-id", "r"];
    assert!(
        crate::Cli::try_parse_from(argv).is_err(),
        "only start and send take one"
    );
}

/// Running the same `start` again with the id the first run printed starts nothing: each run
/// has a credential of its own, and BiBCode replays the request by its id across them.
#[tokio::test]
async fn a_start_run_again_with_its_request_id_does_not_start_a_second_thread() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path(), &root.path().join("no-such-codex")).await;
    let cwd = project(&server, root.path()).await;

    let first = run_in(root.path(), &cwd, &["start", ".", "hi", "--json"], "").await;
    assert_eq!(first.code, 0, "{} {}", first.out, first.err);
    let first = first.json();
    let request_id = first["requestId"]
        .as_str()
        .expect("a request id")
        .to_owned();

    let again = run_in(
        root.path(),
        &cwd,
        &["start", ".", "hi", "--request-id", &request_id, "--json"],
        "",
    )
    .await;
    assert_eq!(again.code, 0, "{} {}", again.out, again.err);
    let again = again.json();
    assert_eq!(again["threadId"], first["threadId"], "{again}");
    assert_eq!(again["messageId"], first["messageId"], "{again}");
    assert_eq!(again["requestId"], request_id.as_str());

    let listed = run_in(root.path(), &cwd, &["list", "--json"], "").await;
    // (The project's own main thread is listed too.)
    let started_threads = listed.json()["threads"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|thread| thread["title"] == "hi")
        .count();
    assert_eq!(started_threads, 1, "{}", listed.out);

    // The same id for another message is refused, not started.
    let other = run_in(
        root.path(),
        &cwd,
        &[
            "start",
            ".",
            "something else",
            "--request-id",
            &request_id,
            "--json",
        ],
        "",
    )
    .await;
    assert_eq!(other.code, 1);
    assert!(
        other.json()["error"]
            .as_str()
            .unwrap()
            .contains("different call")
    );

    // So does a send.
    let thread = first["threadId"].as_str().unwrap();
    let args = ["send", thread, "again", "--request-id", "send-1", "--json"];
    let sent = run_in(root.path(), &cwd, &args, "").await;
    assert_eq!(sent.code, 0, "{} {}", sent.out, sent.err);
    let repeated = run_in(root.path(), &cwd, &args, "").await;
    assert_eq!(repeated.json()["messageId"], sent.json()["messageId"]);
    let shown = run_in(root.path(), &cwd, &["show", thread, "--json"], "").await;
    let shown = shown.json();
    let sends = shown["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["text"] == "again")
        .count();
    assert_eq!(sends, 1, "{shown}");
    server.shutdown();
    server.join().await.expect("server joins");
}
