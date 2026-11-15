use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use serde_json::{Value, json};

use super::*;
use crate::{
    agent_messaging::{
        AgentMessaging,
        pointer::{PointerTerminals, TerminalPointer},
        store::{AgentMessageStatus, NewAgentMessage, SenderKind},
        terminal_credential::{LiveGenerations, TerminalCredentials, TerminalIdentity},
    },
    orchestration::OrchestrationCommand,
    production::mcp_tools_tests::Harness,
    terminal::{TerminalGeneration, TerminalSessionLaunch},
};

const CREATED_AT: &str = "2026-11-14T00:00:00.000Z";
const BODY: &str = "zebra-text-of-a-terminal-message";

// ---- The command, over a scripted transport ----

/// Records every call and answers each with the next scripted answer.
#[derive(Default)]
struct Scripted {
    calls: Mutex<Vec<(String, Value)>>,
    answers: Mutex<Vec<Value>>,
}

impl Scripted {
    fn answering(answers: Vec<Value>) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            answers: Mutex::new(answers),
        }
    }
}

impl Transport for &Scripted {
    async fn call(&self, operation: &str, arguments: Value) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push((operation.to_owned(), arguments));
        let mut answers = self.answers.lock().unwrap();
        if answers.is_empty() {
            return Err("no scripted answer".to_owned());
        }
        Ok(answers.remove(0))
    }
}

fn parse(args: &[&str]) -> AgentArgs {
    let mut argv = vec!["agent"];
    argv.extend_from_slice(args);
    <AgentCli as clap::Parser>::try_parse_from(argv)
        .expect("arguments parse")
        .args
}

struct Ran {
    code: i32,
    out: String,
    err: String,
}

async fn run_with(args: &[&str], transport: Option<&Scripted>, stdin: &str) -> Ran {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = run(
        parse(args),
        transport,
        std::io::Cursor::new(stdin.to_owned()),
        &mut out,
        &mut err,
    )
    .await;
    Ran {
        code,
        out: String::from_utf8(out).unwrap(),
        err: String::from_utf8(err).unwrap(),
    }
}

fn receipt() -> Value {
    json!({ "ok": true, "result": {
        "messageId": "m-1", "conversationId": "c-1", "status": "queued", "hop": 1,
    }})
}

#[tokio::test]
async fn without_the_credential_it_exits_non_zero_saying_no_agent_identity() {
    assert!(
        transport(None, None).unwrap().is_none()
            && transport(Some("http://127.0.0.1:1/api/agent/call".to_owned()), None)
                .unwrap()
                .is_none()
            && transport(None, Some("token".to_owned())).unwrap().is_none(),
        "a shell without both variables has no transport"
    );
    let scripted = Scripted::default();
    let ran = run_with(&["send", "thread:b", "hello"], None, "").await;
    assert_eq!(ran.code, 1);
    assert!(ran.err.contains("no agent identity"), "{}", ran.err);
    assert!(
        ran.err.contains("AI Terminal that BiBCode started"),
        "{}",
        ran.err
    );
    assert!(ran.out.is_empty());
    assert!(scripted.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn send_posts_the_operation_with_the_text_and_a_request_id() {
    let scripted = Scripted::answering(vec![receipt()]);
    let ran = run_with(
        &["send", "terminal:t/term-e", "hello there"],
        Some(&scripted),
        "",
    )
    .await;
    assert_eq!(ran.code, 0, "{}", ran.err);
    let calls = scripted.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "send");
    assert_eq!(calls[0].1["to"], "terminal:t/term-e");
    assert_eq!(calls[0].1["text"], "hello there");
    let request_id = calls[0].1["clientRequestId"]
        .as_str()
        .expect("a request id");
    assert!(!request_id.is_empty());
    assert!(
        ran.out.contains("Sent message m-1 (queued, hop 1)"),
        "{}",
        ran.out
    );
    assert!(ran.out.contains(request_id), "{}", ran.out);
}

#[tokio::test]
async fn a_dash_reads_the_message_from_standard_input() {
    let scripted = Scripted::answering(vec![receipt()]);
    let ran = run_with(
        &["reply", "m-0", "-", "--request-id", "r-7"],
        Some(&scripted),
        "line one\nline two\n",
    )
    .await;
    assert_eq!(ran.code, 0, "{}", ran.err);
    let calls = scripted.calls.lock().unwrap().clone();
    assert_eq!(
        calls[0],
        (
            "reply".to_owned(),
            json!({ "inReplyTo": "m-0", "text": "line one\nline two", "clientRequestId": "r-7" })
        )
    );
    let empty = run_with(&["send", "thread:b", "-"], Some(&scripted), "\n").await;
    assert_eq!(empty.code, 1);
    assert!(empty.err.contains("The message is empty."), "{}", empty.err);
    assert_eq!(
        scripted.calls.lock().unwrap().len(),
        1,
        "no call for an empty message"
    );
}

#[tokio::test]
async fn json_prints_one_document_also_on_failure() {
    let scripted = Scripted::answering(vec![
        receipt(),
        json!({ "ok": false, "error": { "kind": "AgentMessagingHopLimitError", "message": "limit" } }),
    ]);
    for expected_ok in [true, false] {
        let ran = run_with(
            &["send", "thread:b", "hi", "--request-id", "r-1", "--json"],
            Some(&scripted),
            "",
        )
        .await;
        let lines: Vec<&str> = ran.out.lines().collect();
        assert_eq!(lines.len(), 1, "{}", ran.out);
        let document: Value = serde_json::from_str(lines[0]).expect("one JSON document");
        assert_eq!(document["ok"], expected_ok);
        assert_eq!(document["requestId"], "r-1");
        assert_eq!(ran.code, if expected_ok { 0 } else { 1 });
    }
    let refused = run_with(&["list", "--json"], None, "").await;
    let document: Value = serde_json::from_str(refused.out.trim()).expect("one JSON document");
    assert_eq!(document["error"]["kind"], "AgentMessagingNoIdentityError");
}

#[tokio::test]
async fn a_typed_error_prints_its_kind_and_exits_1() {
    let scripted = Scripted::answering(vec![json!({ "ok": false, "error": {
        "kind": "AgentMessagingModeCeilingError", "message": "The recipient runs with more access.",
    }})]);
    let ran = run_with(&["send", "thread:b", "hi"], Some(&scripted), "").await;
    assert_eq!(ran.code, 1);
    assert!(ran.out.is_empty(), "{}", ran.out);
    assert!(
        ran.err.contains("AgentMessagingModeCeilingError")
            && ran.err.contains("The recipient runs with more access."),
        "{}",
        ran.err
    );
}

#[tokio::test]
async fn the_inbox_prints_each_envelope_exactly_as_returned() {
    let rendered = "<agent-message from=\"x\">\n  `$(rm -rf /)` text\n</agent-message>";
    let scripted = Scripted::answering(vec![
        json!({ "ok": true, "result": { "messages": [
            { "messageId": "m-1", "rendered": rendered },
            { "messageId": "m-2", "rendered": "second" },
        ]}}),
        json!({ "ok": true, "result": { "messages": [] } }),
    ]);
    let ran = run_with(&["inbox"], Some(&scripted), "").await;
    assert_eq!(ran.out, format!("{rendered}\n\nsecond\n"));
    let empty = run_with(&["inbox"], Some(&scripted), "").await;
    assert_eq!(empty.out, "No new messages.\n");
}

/// The credential reaches only the request's header: neither a failure nor `--help` shows it.
#[tokio::test]
async fn the_credential_is_never_printed() {
    let token = "credential-value-that-must-not-print";
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/api/agent/call", closed.local_addr().unwrap());
    drop(closed);
    let http = transport(Some(endpoint), Some(token.to_owned()))
        .unwrap()
        .expect("a transport");
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = run(
        parse(&["list"]),
        Some(http),
        std::io::empty(),
        &mut out,
        &mut err,
    )
    .await;
    assert_eq!(code, 1);
    let printed = format!(
        "{}{}",
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap()
    );
    assert!(printed.contains("BiBCode did not answer"), "{printed}");
    assert!(!printed.contains(token), "{printed}");
    let help = <AgentCli as clap::CommandFactory>::command()
        .render_long_help()
        .to_string();
    assert!(!help.contains(AUTH_ENV) && !help.contains(token), "{help}");
}

#[cfg(unix)]
#[test]
fn the_agent_shim_runs_the_executable_with_every_argument() {
    let temp = tempfile::tempdir().unwrap();
    let output = temp.path().join("argv");
    // A quote and a space in the executable path prove the shim's own quoting.
    let exe = temp.path().join("it's the exe");
    crate::test_support::TestSandbox::write_executable(
        &exe,
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$#\" > '{}'\nfor arg in \"$@\"; do printf '%s\\0' \"$arg\" >> '{}'; done\n",
            output.display(),
            output.display()
        ),
    );
    let shims = temp.path().join("agent");
    write_agent_shim(&shims, &exe).unwrap();
    write_agent_shim(&shims, &exe).unwrap();
    let status = std::process::Command::new(shims.join("bibcode"))
        .args(["agent", "send", "thread:b", "a b; $(x) 'q'"])
        .status()
        .unwrap();
    assert!(status.success());
    let recorded = std::fs::read(&output).unwrap();
    let (count, args) = recorded.split_at(recorded.iter().position(|b| *b == b'\n').unwrap());
    assert_eq!(count, b"4");
    let args: Vec<&[u8]> = args[1..]
        .split(|b| *b == 0)
        .filter(|a| !a.is_empty())
        .collect();
    assert_eq!(
        args,
        [&b"agent"[..], b"send", b"thread:b", b"a b; $(x) 'q'"]
    );
}

// ---- The route, over the messaging service with scripted terminals ----

struct Live(Arc<Scripted2>);
type Scripted2 = crate::agent_messaging::pointer::tests::Scripted;

impl LiveGenerations for Live {
    fn live_generation<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> std::pin::Pin<Box<dyn Future<Output = Option<TerminalGeneration>> + Send + 'a>> {
        PointerTerminals::live_generation(&*self.0, thread_id, terminal_id)
    }
}

struct Route {
    harness: Harness,
    terminals: Arc<Scripted2>,
    pointer: TerminalPointer,
    credentials: TerminalCredentials,
    messaging: AgentMessaging,
}

/// In project `p1` the chat threads `a`, `b` (both full access) and the terminals' hosts `t`
/// (full access) and `q` (approval required); the Codex AI Terminals `t/term-c` and `t/term-e`,
/// and `q/term-q`.
async fn route() -> Route {
    let harness = Harness::new().await;
    for (thread_id, title, mode) in [
        ("a", "Thread A", "full-access"),
        ("b", "Thread B", "full-access"),
        ("t", "Terminal host", "full-access"),
        ("q", "Careful host", "approval-required"),
    ] {
        let command: OrchestrationCommand = serde_json::from_value(json!({
            "type": "thread.create", "commandId": format!("create-{thread_id}"),
            "threadId": thread_id, "projectId": "p1", "title": title,
            "modelSelection": { "instanceId": "codex", "model": "model" },
            "runtimeMode": mode, "createdAt": CREATED_AT,
        }))
        .expect("command");
        harness
            .engine
            .dispatch(command)
            .await
            .expect("thread created");
    }
    let terminals = Scripted2::new();
    for (thread_id, terminal_id) in [("t", "term-c"), ("t", "term-e"), ("q", "term-q")] {
        terminals.add(thread_id, terminal_id, 1, true);
        terminals.change(thread_id, terminal_id, |terminal| terminal.driver = "codex");
    }
    let pointer = TerminalPointer::new(
        harness.engine.repositories().database().clone(),
        terminals.clone(),
    );
    let credentials = TerminalCredentials::new("local".to_owned(), "/state/runtime/agent".into());
    credentials.bind(
        "http://127.0.0.1:3773/api/agent/call".to_owned(),
        Arc::new(Live(terminals.clone())),
    );
    let messaging = harness.messaging(true).with_terminals(pointer.clone());
    Route {
        harness,
        terminals,
        pointer,
        credentials,
        messaging,
    }
}

impl Route {
    /// A credential issued as the launch of `thread_id/terminal_id`'s live process.
    async fn token(&self, thread_id: &str, terminal_id: &str) -> String {
        let generation = self
            .terminals
            .live_generation(thread_id, terminal_id)
            .await
            .expect("a live terminal");
        let mut env = BTreeMap::new();
        self.credentials
            .issue(
                &TerminalSessionLaunch {
                    thread_id,
                    terminal_id,
                    generation: &generation,
                    ai_terminal: true,
                },
                &mut env,
            )
            .await;
        env.remove(AUTH_ENV).expect("a credential")
    }

    async fn call_raw(&self, headers: HeaderMap, body: Value) -> Result<Value, StatusCode> {
        agent_call_http(
            &self.credentials,
            Some(&self.messaging),
            serde_json::to_vec(&body).unwrap(),
            RouteContext {
                headers,
                uri: "/api/agent/call".parse().unwrap(),
                cancellation: tokio_util::sync::CancellationToken::new(),
                origin: crate::RequestOrigin::default(),
            },
        )
        .await
        .map(|response| response.body)
        .map_err(|error| error.status())
    }

    async fn call(&self, token: &str, operation: &str, arguments: Value) -> Value {
        self.call_raw(
            bearer(token),
            json!({ "operation": operation, "arguments": arguments }),
        )
        .await
        .expect("the credential is accepted")
    }

    /// `(sender, recipient, status, in_reply_to, delivery message id)` of every stored message.
    async fn stored(&self) -> Vec<(String, String, String, Option<String>, Option<String>)> {
        self.harness
            .repositories
            .database()
            .call(|connection| {
                let mut statement = connection.prepare(
                    "SELECT sender_address, recipient_address, status, in_reply_to, delivery_message_id FROM agent_messages ORDER BY rowid",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await
            .expect("stored messages")
    }

    async fn status_of(&self, message_id: &str) -> AgentMessageStatus {
        let id = message_id.to_owned();
        self.harness
            .repositories
            .database()
            .call(move |connection| crate::agent_messaging::store::get_message(connection, &id))
            .await
            .unwrap()
            .expect("stored")
            .status
    }

    /// Stores a message to `thread_id/terminal_id`'s live generation at `hop`.
    async fn mail(&self, from: &str, thread_id: &str, terminal_id: &str, hop: u32) -> String {
        let generation = self
            .terminals
            .live_generation(thread_id, terminal_id)
            .await
            .expect("a live terminal");
        let message_id = uuid::Uuid::new_v4().to_string();
        self.pointer
            .accept(
                &self.messaging,
                NewAgentMessage {
                    message_id: message_id.clone(),
                    conversation_id: uuid::Uuid::new_v4().to_string(),
                    sender_address: from.to_owned(),
                    sender_kind: SenderKind::Agent,
                    recipient_address: String::new(),
                    in_reply_to: None,
                    hop,
                    text: BODY.to_owned(),
                    status: AgentMessageStatus::Accepted,
                    reason: None,
                    accepted_at: crate::mcp::control::now_iso(),
                    sender_runtime_mode: Some("full-access".to_owned()),
                    recipient_terminal_generation: None,
                    sender_terminal_generation: None,
                    send_request_id: None,
                    client_request_id: None,
                    delivery_command_id: None,
                    delivery_message_id: None,
                },
                &TerminalIdentity {
                    environment_id: "local".to_owned(),
                    thread_id: thread_id.to_owned(),
                    terminal_id: terminal_id.to_owned(),
                    generation,
                },
            )
            .await
            .expect("stored");
        message_id
    }

    async fn shutdown(self) {
        self.harness.shutdown().await;
    }
}

fn bearer(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    headers
}

fn send(to: &str) -> Value {
    json!({ "to": to, "text": BODY })
}

fn kind(answer: &Value) -> &str {
    answer["error"]["kind"].as_str().unwrap_or("none")
}

#[tokio::test]
async fn a_missing_or_revoked_credential_is_refused_with_401() {
    let route = route().await;
    let list = json!({ "operation": "list", "arguments": {} });
    assert_eq!(
        route.call_raw(HeaderMap::new(), list.clone()).await,
        Err(StatusCode::UNAUTHORIZED)
    );
    let token = route.token("t", "term-c").await;
    let mut cookie = HeaderMap::new();
    cookie.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("bibcode_session={token}")).unwrap(),
    );
    assert_eq!(
        route.call_raw(cookie, list.clone()).await,
        Err(StatusCode::UNAUTHORIZED),
        "a cookie is no bearer"
    );
    assert!(route.call_raw(bearer(&token), list.clone()).await.is_ok());
    // A restart, then a close: the old process's credential opens nothing.
    route.terminals.set_generation("t", "term-c", Some(2));
    assert_eq!(
        route.call_raw(bearer(&token), list.clone()).await,
        Err(StatusCode::UNAUTHORIZED)
    );
    let restarted = route.token("t", "term-c").await;
    assert!(
        route
            .call_raw(bearer(&restarted), list.clone())
            .await
            .is_ok()
    );
    route.terminals.close("t", "term-c");
    assert_eq!(
        route.call_raw(bearer(&restarted), list).await,
        Err(StatusCode::UNAUTHORIZED)
    );
    route.shutdown().await;
}

#[tokio::test]
async fn a_body_that_names_a_sender_is_refused_as_invalid_argument() {
    let route = route().await;
    let token = route.token("t", "term-e").await;
    for body in [
        json!({ "operation": "send", "arguments": send("thread:b"), "from": "thread:a" }),
        json!({ "operation": "send", "arguments": {
            "to": "thread:b", "text": BODY, "from": "terminal:t/term-c",
        }}),
    ] {
        let answer = route.call_raw(bearer(&token), body).await.unwrap();
        assert_eq!(answer["ok"], false);
        assert_eq!(kind(&answer), "AgentMessagingInvalidArgumentError");
        assert!(!answer.to_string().contains(BODY), "{answer}");
    }
    assert!(route.stored().await.is_empty(), "nothing was stored");
    route.shutdown().await;
}

#[tokio::test]
async fn a_sibling_sends_from_its_own_address() {
    let route = route().await;
    let sibling = route.token("t", "term-c").await;
    let token = route.token("t", "term-e").await;
    assert_ne!(sibling, token);
    let answer = route.call(&token, "send", send("thread:b")).await;
    assert_eq!(answer["ok"], true, "{answer}");
    let stored = route.stored().await;
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].0, "terminal:t/term-e");
    assert_eq!(stored[0].1, "thread:b");
    route.shutdown().await;
}

#[tokio::test]
async fn terminal_to_panel() {
    let route = route().await;
    let token = route.token("t", "term-c").await;
    let answer = route.call(&token, "send", send("thread:b")).await;
    assert_eq!(answer["ok"], true, "{answer}");
    let delivery_message_id = route.stored().await[0].4.clone().expect("a queue entry");
    let (text, actor): (String, String) = route
        .harness
        .repositories
        .database()
        .call(move |connection| {
            Ok(connection.query_row(
                "SELECT text, actor_json FROM projection_thread_messages WHERE message_id = ?1",
                [&delivery_message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .await
        .expect("the queued turn's message");
    assert!(text.contains("terminal:t/term-c"), "{text}");
    assert!(text.contains(BODY), "{text}");
    let actor: Value = serde_json::from_str(&actor).unwrap();
    assert_eq!(actor["kind"], "hosted-agent");
    assert_eq!(actor["address"], "terminal:t/term-c");
    route.shutdown().await;
}

#[tokio::test]
async fn a_terminal_of_an_approval_required_thread_cannot_send_to_a_full_access_chat() {
    let route = route().await;
    let token = route.token("q", "term-q").await;
    let answer = route.call(&token, "send", send("thread:b")).await;
    assert_eq!(kind(&answer), "AgentMessagingModeCeilingError", "{answer}");
    assert!(route.stored().await.is_empty());
    route.shutdown().await;
}

#[tokio::test]
async fn a_terminal_sender_at_hop_8_is_refused_with_the_hop_limit_error() {
    let route = route().await;
    let token = route.token("t", "term-c").await;
    route.mail("thread:a", "t", "term-c", 8).await;
    let inbox = route.call(&token, "inbox", json!({})).await;
    assert_eq!(
        inbox["result"]["messages"].as_array().map(Vec::len),
        Some(1)
    );
    let answer = route.call(&token, "send", send("thread:b")).await;
    assert_eq!(kind(&answer), "AgentMessagingHopLimitError", "{answer}");
    // A person typing in the terminal starts the chain again.
    route.terminals.person_types("t", "term-c");
    let answer = route.call(&token, "send", send("thread:b")).await;
    assert_eq!(answer["result"]["hop"], 1, "{answer}");
    route.shutdown().await;
}

#[tokio::test]
async fn a_terminal_recipients_reply_completes_the_original() {
    let route = route().await;
    let token = route.token("t", "term-c").await;
    let original = route
        .messaging
        .send(
            "a",
            crate::agent_messaging::SendRequest {
                to: "terminal:t/term-c".to_owned(),
                text: BODY.to_owned(),
                client_request_id: None,
            },
        )
        .await
        .expect("sent to the terminal");
    let inbox = route.call(&token, "inbox", json!({})).await;
    assert_eq!(
        inbox["result"]["messages"][0]["messageId"],
        original.message_id.as_str()
    );
    // A sibling cannot reply to mail it never received.
    let answer = route
        .call(
            &route.token("t", "term-e").await,
            "reply",
            json!({ "inReplyTo": original.message_id, "text": "not mine" }),
        )
        .await;
    assert_eq!(kind(&answer), "AgentMessagingUnknownMessageError");
    let answer = route
        .call(
            &token,
            "reply",
            json!({ "inReplyTo": original.message_id, "text": "done" }),
        )
        .await;
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(
        route.status_of(&original.message_id).await,
        AgentMessageStatus::Completed
    );
    let reply = route
        .stored()
        .await
        .into_iter()
        .find(|row| row.3.as_deref() == Some(original.message_id.as_str()))
        .expect("the reply is stored");
    assert_eq!(
        (reply.0.as_str(), reply.1.as_str()),
        ("terminal:t/term-c", "thread:a")
    );
    // A retry with one request id replays its receipt; a new id is a second reply.
    let retry =
        json!({ "inReplyTo": original.message_id, "text": "later", "clientRequestId": "r-1" });
    let first = route.call(&token, "reply", retry.clone()).await;
    let again = route.call(&token, "reply", retry).await;
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(
        first["result"]["messageId"], again["result"]["messageId"],
        "{again}"
    );
    let second = route
        .call(
            &token,
            "reply",
            json!({ "inReplyTo": original.message_id, "text": "more", "clientRequestId": "r-2" }),
        )
        .await;
    assert_eq!(second["ok"], true, "{second}");
    assert_ne!(second["result"]["messageId"], first["result"]["messageId"]);
    // A restarted terminal cannot reply to its predecessor's mail.
    route.terminals.set_generation("t", "term-c", Some(2));
    let answer = route
        .call(
            &route.token("t", "term-c").await,
            "reply",
            json!({ "inReplyTo": original.message_id, "text": "again" }),
        )
        .await;
    assert_eq!(kind(&answer), "AgentMessagingUnknownMessageError");
    route.shutdown().await;
}

#[tokio::test]
async fn a_terminal_send_reaches_the_activity_log_as_the_terminal_without_text() {
    let route = route().await;
    let outcomes = Arc::new(Mutex::new(Vec::new()));
    let sink = outcomes.clone();
    let messaging = route
        .harness
        .messaging(true)
        .with_terminals(route.pointer.clone())
        .with_outcomes(Arc::new(move |outcome| sink.lock().unwrap().push(outcome)));
    let token = route.token("t", "term-e").await;
    let answer = agent_call_http(
        &route.credentials,
        Some(&messaging),
        serde_json::to_vec(&json!({ "operation": "send", "arguments": send("thread:b") })).unwrap(),
        RouteContext {
            headers: bearer(&token),
            uri: "/api/agent/call".parse().unwrap(),
            cancellation: tokio_util::sync::CancellationToken::new(),
            origin: crate::RequestOrigin::default(),
        },
    )
    .await
    .expect("accepted")
    .body;
    let outcomes = outcomes.lock().unwrap().clone();
    assert_eq!(outcomes.len(), 1, "{outcomes:?}");
    let outcome = &outcomes[0];
    assert_eq!(outcome.sender_address, "terminal:t/term-e");
    assert_eq!(outcome.recipient_address, "thread:b");
    assert_eq!(outcome.tool, "agent_message_send");
    assert_eq!(outcome.outcome, "accepted");
    assert_eq!(
        outcome.message_id.as_deref(),
        answer["result"]["messageId"].as_str()
    );
    assert_eq!(outcome.sender_title.as_deref(), Some("Claude term-e"));
    assert_eq!(outcome.recipient_title.as_deref(), Some("Thread B"));
    assert!(!format!("{outcome:?}").contains(BODY), "{outcome:?}");
    route.shutdown().await;
}

/// With the Profiler on, an authenticated route call records one timing under its operation
/// (`agent.send`), with no message text; a refused credential records none.
#[tokio::test]
async fn a_route_call_with_the_profiler_on_records_one_timing_without_its_text() {
    use crate::diagnostics::profiler::latency::{PinnedProfiling, global_latency};
    let _profiling = PinnedProfiling::new(true);
    let route = route().await;
    let token = route.token("t", "term-e").await;
    let agent_timings = || {
        global_latency()
            .histograms_for_test()
            .into_iter()
            .filter(|payload| {
                payload["method"]
                    .as_str()
                    .is_some_and(|method| method.starts_with("agent."))
            })
            .collect::<Vec<_>>()
    };
    let before = agent_timings();
    assert_eq!(
        route
            .call_raw(
                HeaderMap::new(),
                json!({ "operation": "send", "arguments": send("thread:b") })
            )
            .await
            .unwrap_err(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(agent_timings(), before, "a refused credential is not timed");
    let answer = route.call(&token, "send", send("thread:b")).await;
    assert_eq!(answer["ok"], true, "{answer}");
    let timings = agent_timings();
    let sends: Vec<&Value> = timings
        .iter()
        .filter(|payload| payload["method"] == "agent.send")
        .collect();
    let earlier = before
        .iter()
        .find(|payload| payload["method"] == "agent.send")
        .map_or(0, |payload| payload["samples"].as_u64().unwrap());
    assert_eq!(sends.len(), 1, "{timings:?}");
    assert_eq!(
        sends[0]["samples"].as_u64(),
        Some(earlier + 1),
        "{timings:?}"
    );
    assert_eq!(sends[0]["outcome"], "success");
    assert!(!format!("{timings:?}").contains(BODY), "{timings:?}");
    route.shutdown().await;
}

#[tokio::test]
async fn list_through_the_route_returns_the_projects_other_agents_and_terminals() {
    let route = route().await;
    let token = route.token("t", "term-c").await;
    let answer = route.call(&token, "list", json!({})).await;
    let addresses: Vec<&str> = answer["result"]["agents"]
        .as_array()
        .expect("agents")
        .iter()
        .map(|agent| agent["address"].as_str().unwrap())
        .filter(|address| *address != "thread:thread-1")
        .collect();
    for expected in [
        "thread:a",
        "thread:b",
        "thread:t",
        "thread:q",
        "terminal:t/term-e",
        "terminal:q/term-q",
    ] {
        assert!(addresses.contains(&expected), "{expected}: {addresses:?}");
    }
    assert!(!addresses.contains(&"terminal:t/term-c"), "{addresses:?}");
    route.shutdown().await;
}

#[tokio::test]
async fn inbox_through_the_route_returns_the_envelope_and_consumes() {
    let route = route().await;
    let token = route.token("t", "term-c").await;
    let message_id = route.mail("thread:a", "t", "term-c", 1).await;
    let inbox = route.call(&token, "inbox", json!({})).await;
    let messages = inbox["result"]["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 1);
    let rendered = messages[0]["rendered"].as_str().unwrap();
    assert!(
        rendered.contains(BODY) && rendered.contains("thread:a") && rendered.contains(&message_id),
        "{rendered}"
    );
    assert_eq!(
        route.status_of(&message_id).await,
        AgentMessageStatus::Consumed
    );
    let again = route.call(&token, "inbox", json!({})).await;
    assert_eq!(again["result"]["messages"], json!([]));
    // A sibling's inbox never holds another terminal's mail.
    let sibling = route.token("t", "term-e").await;
    route.mail("thread:a", "t", "term-c", 1).await;
    let other = route.call(&sibling, "inbox", json!({})).await;
    assert_eq!(other["result"]["messages"], json!([]));
    route.shutdown().await;
}

// ---- The route on a running server ----

/// A server on `root` with every provider off and agent messaging on, project `p1` and its
/// threads `a` and `t`.
async fn running_server(root: &std::path::Path) -> crate::ServerHandle {
    let providers = crate::test_support::hermetic_providers::BUILTIN_PROVIDER_DRIVERS
        .iter()
        .map(|driver| ((*driver).to_owned(), json!({ "enabled": false })))
        .collect::<serde_json::Map<String, Value>>();
    crate::test_support::hermetic_providers::write_hermetic_settings(
        &crate::ServerConfig::new(root).state_dir(),
        json!({ "providers": providers, "agentMessaging": { "enabled": true } }),
    );
    let server =
        crate::ServerRuntime::start(crate::ServerConfig::new(root).with_bind("127.0.0.1", 0))
            .await
            .expect("server starts");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let engine = server.orchestration_for_test().expect("engine");
    let mut commands = vec![json!({
        "type": "project.create", "commandId": "project", "projectId": "p1", "title": "P",
        "workspaceRoot": workspace,
        "defaultModelSelection": { "instanceId": "codex", "model": "gpt-5" },
        "createdAt": CREATED_AT,
    })];
    for thread_id in ["a", "t"] {
        commands.push(json!({
            "type": "thread.create", "commandId": format!("create-{thread_id}"),
            "threadId": thread_id, "projectId": "p1", "title": format!("Thread {thread_id}"),
            "modelSelection": { "instanceId": "codex", "model": "model" },
            "runtimeMode": "full-access", "createdAt": CREATED_AT,
        }));
    }
    for command in commands {
        let command: OrchestrationCommand = serde_json::from_value(command).expect("command");
        engine.dispatch(command).await.expect("dispatched");
    }
    server
}

async fn post(endpoint: &str, headers: &[(&str, String)]) -> (u16, Value) {
    let mut request = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(endpoint)
        .json(&json!({ "operation": "list", "arguments": {} }));
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    let response = request.send().await.expect("the server answers");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// The running server binds the credentials to its own route at startup, and only a live
/// terminal generation's credential opens that route: a person's session, an outside agent's
/// token, a provider MCP credential and an open-URL token are each refused, and the terminal
/// credential opens `/mcp` no more than any other route.
#[tokio::test]
async fn every_other_credential_kind_is_refused_on_the_agent_route() {
    let root = tempfile::tempdir().unwrap();
    let server = running_server(root.path()).await;
    let endpoint = format!("http://{}/api/agent/call", server.local_addr());
    let runtime = server.production_runtime_for_test().expect("runtime");
    let manager = runtime.terminal_manager_for_test();
    let mut input =
        crate::terminal::TerminalOpenInput::new("t", "term-1", root.path().to_path_buf(), 80, 24);
    input.command = None;
    manager.open(input).await.expect("a terminal runs");
    let generation = manager.live_generation("t", "term-1").await.expect("live");
    let mut env = BTreeMap::new();
    runtime
        .terminal_credentials()
        .issue(
            &TerminalSessionLaunch {
                thread_id: "t",
                terminal_id: "term-1",
                generation: &generation,
                ai_terminal: true,
            },
            &mut env,
        )
        .await;
    assert_eq!(
        env[ENDPOINT_ENV], endpoint,
        "bound to this listener's route"
    );
    let token = env[AUTH_ENV].clone();

    let (status, answer) = post(&endpoint, &[("authorization", format!("Bearer {token}"))]).await;
    assert_eq!(status, 200, "{answer}");
    assert!(answer.to_string().contains("thread:a"), "{answer}");
    // The command itself, end to end.
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = run(
        parse(&["list"]),
        transport(Some(endpoint.clone()), Some(token.clone())).unwrap(),
        std::io::empty(),
        &mut out,
        &mut err,
    )
    .await;
    let out = String::from_utf8(out).unwrap();
    assert_eq!(code, 0, "{}", String::from_utf8(err).unwrap());
    assert!(out.contains("thread:a"), "{out}");

    let auth = server.auth_for_test();
    let pairing = auth
        .issue_pairing(vec![crate::auth::SCOPE_ORCHESTRATION_READ.to_owned()], None)
        .await
        .expect("pairing");
    let person = auth
        .exchange_bootstrap(
            &pairing.credential,
            None,
            crate::auth::ClientMetadata::default(),
            None,
            crate::auth::SessionTransport::Plain,
        )
        .await
        .expect("a person's session")
        .token;
    let engine = server.orchestration_for_test().expect("engine");
    let link = crate::auth::issue_mcp_pairing_link(
        &engine.repositories(),
        "MCP · test".to_owned(),
        crate::mcp::control::McpAccess::FullAccess.as_str(),
        &[],
    )
    .await
    .expect("an outside agent's link");
    let outside_agent = auth
        .exchange_bootstrap(
            &link.credential,
            None,
            crate::auth::ClientMetadata::default(),
            None,
            crate::auth::SessionTransport::Plain,
        )
        .await
        .expect("an outside agent's token")
        .token;
    let connect = server.connect_for_test().expect("connect");
    let provider = connect
        .issue_mcp_credential("t", "t", "codex")
        .await
        .expect("a provider MCP credential")
        .authorization_header;
    let open_url = connect
        .issue_open_url_credential("t")
        .await
        .expect("an open-URL token")
        .token;
    for (kind, header) in [
        ("no credential", None),
        (
            "a person's session",
            Some(("authorization", format!("Bearer {person}"))),
        ),
        (
            "a person's session cookie",
            Some(("cookie", format!("{}={person}", auth.cookie_name()))),
        ),
        (
            "an outside agent's token",
            Some(("authorization", format!("Bearer {outside_agent}"))),
        ),
        (
            "a provider MCP credential",
            Some(("authorization", provider.clone())),
        ),
        (
            "an open-URL token",
            Some(("authorization", format!("Bearer {open_url}"))),
        ),
    ] {
        let headers: Vec<(&str, String)> = header.into_iter().collect();
        let (status, answer) = post(&endpoint, &headers).await;
        assert_eq!(status, 401, "{kind}: {answer}");
        assert_eq!(
            answer["error"]["kind"], "AgentMessagingNoIdentityError",
            "{kind}"
        );
    }
    let mcp = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("http://{}/mcp", server.local_addr()))
        .bearer_auth(&token)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .expect("the server answers");
    assert_eq!(
        mcp.status().as_u16(),
        401,
        "the terminal credential is no MCP bearer"
    );

    manager.close("t", Some("term-1")).await.expect("closed");
    let (status, _) = post(&endpoint, &[("authorization", format!("Bearer {token}"))]).await;
    assert_eq!(status, 401, "a closed terminal's credential");
    drop(runtime);
    server.shutdown();
    server.join().await.expect("server stops");
}
