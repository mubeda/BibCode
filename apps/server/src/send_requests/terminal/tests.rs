use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc, time::Duration};

use axum::http::{HeaderMap, HeaderValue, header};
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::{
    agent_messaging::{
        AgentCaller, AgentMessaging, AgentMessagingError,
        pointer::{POINTER_LINE, PointerTerminals, TerminalPointer, tests::Scripted},
        store::{self as mail, AgentMessageRow, AgentMessageStatus, NewAgentMessage, SenderKind},
        terminal_credential::{AUTH_ENV, LiveGenerations, TerminalCredentials},
    },
    mcp::{agent_cli::agent_call_http, control::McpAccess},
    production::{http_routes::RouteContext, mcp_tools_tests::Harness},
    rpc::{RpcRegistry, RpcSessionContext},
    send_requests::{
        rpc::register_send_requests_rpc,
        service::{SendRequestsSendInput, SendRequestsService},
        store::{SendRequestRow, SendRequestStore, SendState},
    },
    terminal::{TerminalGeneration, TerminalSessionLaunch},
};

const NOTE: &str = "Look at the parser.";

struct Live(Arc<Scripted>);

impl LiveGenerations for Live {
    fn live_generation<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Option<TerminalGeneration>> + Send + 'a>> {
        PointerTerminals::live_generation(&*self.0, thread_id, terminal_id)
    }
}

/// The real send requests service, agent messaging and pointer over scripted terminals: in
/// project `p1` the threads `a` (approval required), `b` (full access, the terminals' owner) and
/// `api` ("API refactor", approval required); in `p2` the thread `c`. Terminals of `b`: the
/// Claude AI Terminals `term-1` and `term-2`, a Cursor AI Terminal `cursor`, a plain `shell`;
/// of `c`: the Claude AI Terminal `term-x`. None is ready.
struct Fixture {
    harness: Harness,
    terminals: Arc<Scripted>,
    pointer: TerminalPointer,
    service: SendRequestsService,
    messaging: AgentMessaging,
    enabled: watch::Sender<bool>,
    credentials: TerminalCredentials,
    store: SendRequestStore,
    stop: CancellationToken,
}

async fn fixture(enabled: bool) -> Fixture {
    let harness = Harness::new().await;
    harness.send_request_threads().await;
    harness
        .engine
        .dispatch(
            serde_json::from_value(json!({
                "type": "thread.create", "commandId": "create-api",
                "threadId": "api", "projectId": "p1", "title": "API refactor",
                "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
                "runtimeMode": "approval-required", "interactionMode": "default",
                "branch": null, "worktreePath": null, "createdAt": "2026-11-14T00:00:00.000Z",
            }))
            .unwrap(),
        )
        .await
        .expect("thread created");
    let terminals = Scripted::new();
    for (thread_id, terminal_id, ai) in [
        ("b", "term-1", true),
        ("b", "term-2", true),
        ("b", "cursor", true),
        ("b", "shell", false),
        ("c", "term-x", true),
    ] {
        terminals.add(thread_id, terminal_id, 1, ai);
    }
    terminals.change("b", "cursor", |terminal| terminal.driver = "cursor");
    let database = harness.engine.repositories().database().clone();
    let pointer = TerminalPointer::new(database.clone(), terminals.clone());
    let service = harness.send_requests().with_terminal_mail(pointer.clone());
    let pointer = pointer
        .with_request_sink(request_state_sink(service.clone()))
        .with_generation_end_sink(generation_end_sink(service.clone()));
    let (enabled, receiver) = watch::channel(enabled);
    let messaging =
        AgentMessaging::new(harness.engine.clone(), receiver).with_terminals(pointer.clone());
    let credentials = TerminalCredentials::new("local".to_owned(), "/state/runtime/agent".into());
    credentials.bind(
        "http://127.0.0.1:3773/api/agent/call".to_owned(),
        Arc::new(Live(terminals.clone())),
    );
    Fixture {
        harness,
        terminals,
        pointer,
        service,
        messaging,
        enabled,
        credentials,
        store: SendRequestStore::new(database),
        stop: CancellationToken::new(),
    }
}

fn person() -> RpcSessionContext {
    RpcSessionContext::unauthenticated()
}

fn input(request_id: &str, action: &str, source: &str, target: &str) -> SendRequestsSendInput {
    SendRequestsSendInput {
        request_id: request_id.to_owned(),
        action: action.to_owned(),
        source: source.to_owned(),
        target: target.to_owned(),
        taken_over: None,
        lead_in: "Please review the work below.".to_owned(),
        note: NOTE.to_owned(),
        attachments: Vec::new(),
    }
}

fn review(request_id: &str) -> SendRequestsSendInput {
    input(request_id, "review", "thread:api", "terminal:b/term-1")
}

impl Fixture {
    fn start(&self) {
        self.pointer
            .start(self.messaging.clone(), self.stop.clone());
    }

    async fn send(&self, input: SendRequestsSendInput) -> Result<String, Value> {
        self.service
            .send(&person(), input)
            .await
            .map(|request| request.state.to_owned())
    }

    async fn refused(&self, input: SendRequestsSendInput) -> String {
        let error = self.send(input).await.expect_err("refused");
        error["reason"].as_str().unwrap_or_default().to_owned()
    }

    async fn request(&self, request_id: &str) -> SendRequestRow {
        self.store
            .get(request_id)
            .await
            .unwrap()
            .expect("the request is stored")
    }

    async fn state(&self, request_id: &str) -> SendState {
        self.request(request_id).await.state
    }

    async fn until_state(&self, request_id: &str, state: SendState) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.state(request_id).await != state {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{request_id} reaches {state:?}"));
    }

    async fn mail(&self, message_id: &str) -> AgentMessageRow {
        let message_id = message_id.to_owned();
        self.harness
            .engine
            .repositories()
            .database()
            .call(move |connection| mail::get_message(connection, &message_id))
            .await
            .unwrap()
            .expect("the mail row is stored")
    }

    async fn count(&self, sql: &'static str) -> i64 {
        self.harness
            .engine
            .repositories()
            .database()
            .call(move |connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .await
            .unwrap()
    }

    /// Stores an agent's message to `terminal_id` directly, as task 8.4's accept would.
    async fn agent_mail(&self, message_id: &str, terminal_id: &str, hop: u32, sender_mode: &str) {
        let new = NewAgentMessage {
            message_id: message_id.to_owned(),
            conversation_id: format!("conversation-{message_id}"),
            sender_address: "thread:b".to_owned(),
            sender_kind: SenderKind::Agent,
            recipient_address: format!("terminal:b/{terminal_id}"),
            in_reply_to: None,
            hop,
            text: "an agent's message".to_owned(),
            status: AgentMessageStatus::Queued,
            reason: None,
            accepted_at: crate::mcp::control::now_iso(),
            sender_runtime_mode: Some(sender_mode.to_owned()),
            recipient_terminal_generation: Some("boot-1:1".to_owned()),
            send_request_id: None,
            client_request_id: None,
            delivery_command_id: None,
            delivery_message_id: None,
        };
        self.harness
            .engine
            .repositories()
            .database()
            .call(move |connection| {
                let tx = connection.transaction()?;
                mail::insert_message(&tx, &new)?;
                tx.commit()?;
                Ok(())
            })
            .await
            .unwrap();
    }

    /// A credential issued as the launch of `b/terminal_id`'s live process.
    async fn token(&self, terminal_id: &str) -> String {
        let generation = self
            .terminals
            .live_generation("b", terminal_id)
            .await
            .expect("a live terminal");
        let mut env = BTreeMap::new();
        self.credentials
            .issue(
                &TerminalSessionLaunch {
                    thread_id: "b",
                    terminal_id,
                    generation: &generation,
                    ai_terminal: true,
                },
                &mut env,
            )
            .await;
        env.remove(AUTH_ENV).expect("a credential")
    }

    /// `bibcode agent <operation>` run in `b/terminal_id`, through `POST /api/agent/call`.
    async fn cli(&self, terminal_id: &str, operation: &str, arguments: Value) -> Value {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", self.token(terminal_id).await)).unwrap(),
        );
        agent_call_http(
            &self.credentials,
            Some(&self.messaging),
            serde_json::to_vec(&json!({ "operation": operation, "arguments": arguments })).unwrap(),
            RouteContext {
                headers,
                uri: "/api/agent/call".parse().unwrap(),
                cancellation: CancellationToken::new(),
                origin: crate::RequestOrigin::default(),
            },
        )
        .await
        .map(|response| response.body)
        .expect("the credential is accepted")
    }

    /// The `(message id, rendered text)` of each message `bibcode agent inbox` printed.
    async fn inbox(&self, terminal_id: &str) -> Vec<(String, String)> {
        let answer = self.cli(terminal_id, "inbox", json!({})).await;
        answer["result"]["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("an inbox: {answer}"))
            .iter()
            .map(|message| {
                (
                    message["messageId"].as_str().unwrap().to_owned(),
                    message["rendered"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    async fn reply(&self, terminal_id: &str, message_id: &str, text: &str) -> Value {
        self.cli(
            terminal_id,
            "reply",
            json!({ "inReplyTo": message_id, "text": text }),
        )
        .await
    }

    async fn shutdown(self) {
        self.stop.cancel();
        self.harness.shutdown().await;
    }
}

fn error_kind(answer: &Value) -> &str {
    answer["error"]["kind"].as_str().unwrap_or_default()
}

// ---- Step 1: the scenarios of R115 ----

#[tokio::test]
async fn agent_messaging_off_a_terminal_still_fetches_and_answers_a_request() {
    let fixture = fixture(false).await;
    fixture.start();
    fixture.terminals.set_ready("b", "term-1");
    assert_eq!(fixture.send(review("r1")).await.unwrap(), "queued");
    fixture.until_state("r1", SendState::Delivered).await;

    let fetched = fixture.inbox("term-1").await;
    assert_eq!(fetched.len(), 1, "{fetched:?}");
    assert_eq!(fetched[0].0, "person-send:r1");
    let replied = fixture
        .reply("term-1", "person-send:r1", "The parser is fine.")
        .await;
    assert_eq!(replied["ok"], true, "{replied}");

    let request = fixture.request("r1").await;
    assert_eq!(request.state, SendState::Answered);
    assert_eq!(request.answer_text.as_deref(), Some("The parser is fine."));
    assert!(fixture.inbox("term-1").await.is_empty(), "no agent message");
    let sent = fixture
        .cli(
            "term-1",
            "send",
            json!({ "to": "thread:a", "text": "hello" }),
        )
        .await;
    assert_eq!(error_kind(&sent), "AgentMessagingDisabledError", "{sent}");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_reply_starts_no_turn() {
    let fixture = fixture(true).await;
    fixture.send(review("r1")).await.unwrap();
    fixture.inbox("term-1").await;
    fixture.reply("term-1", "person-send:r1", "Done.").await;

    assert_eq!(fixture.state("r1").await, SendState::Answered);
    assert_eq!(
        fixture
            .count("SELECT COUNT(*) FROM provider_turn_outbox")
            .await,
        0
    );
    assert_eq!(
        fixture
            .count("SELECT COUNT(*) FROM agent_messages WHERE status IN ('queued', 'accepted')")
            .await,
        0
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn not_ready_the_request_is_queued_and_nothing_is_typed() {
    let fixture = fixture(true).await;
    fixture.start();
    fixture.send(review("r1")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fixture.state("r1").await, SendState::Queued);
    assert!(fixture.terminals.writes("b", "term-1").is_empty());

    fixture.terminals.set_ready("b", "term-1");
    fixture.until_state("r1", SendState::Delivered).await;
    let writes = fixture.terminals.writes("b", "term-1");
    assert_eq!(writes.len(), 1);
    assert!(writes[0].contains(POINTER_LINE));
    assert!(!writes[0].contains(NOTE), "the request is never typed");
    fixture.shutdown().await;
}

#[tokio::test]
async fn pasted_is_not_read() {
    let fixture = fixture(true).await;
    fixture.start();
    fixture.terminals.set_ready("b", "term-1");
    fixture.send(review("r1")).await.unwrap();
    fixture.until_state("r1", SendState::Delivered).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fixture.state("r1").await, SendState::Delivered);
    fixture.shutdown().await;
}

#[tokio::test]
async fn inbox_run_makes_the_request_read() {
    let fixture = fixture(true).await;
    fixture.send(review("r1")).await.unwrap();
    assert_eq!(fixture.inbox("term-1").await.len(), 1);
    assert_eq!(fixture.state("r1").await, SendState::Read);
    fixture.shutdown().await;
}

// ---- Step 2: the amendments of Part B "Constraints" ----

#[tokio::test]
async fn a_person_request_may_be_48000_characters_and_not_more() {
    let fixture = fixture(true).await;
    let mut longest = review("r1");
    longest.note = "x".repeat(48_000);
    assert_eq!(fixture.send(longest).await.unwrap(), "queued");
    let mut longer = review("r2");
    longer.note = "x".repeat(48_001);
    assert_eq!(fixture.refused(longer).await, "too_long");

    let agent = fixture
        .cli(
            "term-2",
            "send",
            json!({ "to": "terminal:b/term-1", "text": "x".repeat(16_001) }),
        )
        .await;
    assert_eq!(
        error_kind(&agent),
        "AgentMessagingInvalidArgumentError",
        "{agent}"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn inbox_and_reply_work_for_a_person_request_while_messaging_is_off() {
    let fixture = fixture(false).await;
    fixture.send(review("r1")).await.unwrap();
    assert_eq!(fixture.inbox("term-1").await.len(), 1);
    let replied = fixture.reply("term-1", "person-send:r1", "Answer.").await;
    assert_eq!(replied["ok"], true, "{replied}");
    assert_eq!(fixture.state("r1").await, SendState::Answered);
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_person_request_reaches_a_terminal_whatever_any_threads_mode_is() {
    let fixture = fixture(true).await;
    // `a` asks for approval; the terminal's owner `b` runs with full access.
    let sent = fixture
        .send(input("r1", "review", "thread:a", "terminal:b/term-1"))
        .await;
    assert_eq!(sent.unwrap(), "queued");
    assert_eq!(fixture.inbox("term-1").await.len(), 1);
    fixture.shutdown().await;
}

#[tokio::test]
async fn inbox_prints_a_person_request_as_from_the_user_not_in_the_agent_envelope() {
    let fixture = fixture(true).await;
    fixture.send(review("r1")).await.unwrap();
    let fetched = fixture.inbox("term-1").await;
    let rendered = &fetched[0].1;
    assert!(
        rendered.starts_with("From the user of this project: Review, sent from API refactor.\n\n"),
        "{rendered}"
    );
    assert!(rendered.contains(NOTE));
    assert!(!rendered.contains("from another agent, not from your user"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_reply_to_a_person_request_is_stored_as_the_answer_and_queues_nothing() {
    let fixture = fixture(true).await;
    fixture.send(review("r1")).await.unwrap();
    fixture.inbox("term-1").await;
    let replied = fixture
        .reply("term-1", "person-send:r1", "Looks right.")
        .await;
    let reply_id = replied["result"]["messageId"].as_str().unwrap().to_owned();

    let request = fixture.request("r1").await;
    assert_eq!(request.state, SendState::Answered);
    assert_eq!(
        request.answer_message_id.as_deref(),
        Some(reply_id.as_str())
    );
    assert_eq!(request.answer_text.as_deref(), Some("Looks right."));
    let reply = fixture.mail(&reply_id).await;
    assert_eq!(reply.status, AgentMessageStatus::Completed);
    assert_eq!(reply.recipient_address, "thread:api");
    assert_eq!(reply.delivery_command_id, None);
    assert_eq!(
        fixture.mail("person-send:r1").await.status,
        AgentMessageStatus::Completed
    );
    let again = fixture
        .reply("term-1", "person-send:r1", "A second answer.")
        .await;
    assert_eq!(
        error_kind(&again),
        "AgentMessagingInvalidArgumentError",
        "{again}"
    );
    assert_eq!(
        fixture
            .count("SELECT COUNT(*) FROM agent_messages WHERE in_reply_to = 'person-send:r1'")
            .await,
        1
    );
    assert_eq!(
        fixture
            .count("SELECT COUNT(*) FROM provider_turn_outbox")
            .await,
        0
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn fetching_a_person_request_resets_the_terminals_hop_to_1() {
    let fixture = fixture(true).await;
    fixture
        .agent_mail("hop-7", "term-1", 7, "full-access")
        .await;
    assert_eq!(fixture.inbox("term-1").await.len(), 1);
    let before = fixture
        .cli(
            "term-1",
            "send",
            json!({ "to": "terminal:b/term-2", "text": "first" }),
        )
        .await;
    assert_eq!(before["result"]["hop"], 8, "{before}");

    fixture.send(review("r1")).await.unwrap();
    assert_eq!(fixture.inbox("term-1").await.len(), 1);
    let after = fixture
        .cli(
            "term-1",
            "send",
            json!({ "to": "terminal:b/term-2", "text": "second" }),
        )
        .await;
    assert_eq!(after["result"]["hop"], 1, "{after}");
    fixture.shutdown().await;
}

#[tokio::test]
async fn the_inbox_returns_person_requests_with_agent_messages_oldest_first() {
    let fixture = fixture(true).await;
    fixture
        .agent_mail("agent-1", "term-1", 1, "full-access")
        .await;
    fixture.send(review("r1")).await.unwrap();
    let ids: Vec<String> = fixture
        .inbox("term-1")
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    assert_eq!(ids, ["agent-1", "person-send:r1"]);

    // The ceiling fails: an approval-required sender cannot reach a full-access terminal.
    fixture
        .agent_mail("agent-2", "term-1", 1, "approval-required")
        .await;
    fixture.send(review("r2")).await.unwrap();
    let ids: Vec<String> = fixture
        .inbox("term-1")
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    assert_eq!(ids, ["person-send:r2"]);

    fixture.enabled.send(false).unwrap();
    fixture
        .agent_mail("agent-3", "term-1", 1, "full-access")
        .await;
    fixture.send(review("r3")).await.unwrap();
    let ids: Vec<String> = fixture
        .inbox("term-1")
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    assert_eq!(ids, ["person-send:r3"]);
    fixture.shutdown().await;
}

// ---- Step 3: refusals, idempotency, cancel and the stream ----

#[tokio::test]
async fn a_hosted_agent_credential_cannot_send_a_person_request() {
    let fixture = fixture(false).await;
    let (agent, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    let context =
        RpcSessionContext::authenticated(agent.principal.clone(), fixture.harness.auth.clone());
    let error = fixture
        .service
        .send(&context, review("r1"))
        .await
        .expect_err("an outside agent is refused");
    assert_eq!(error["reason"], "person_only");
    let mut registry = RpcRegistry::empty();
    register_send_requests_rpc(&mut registry, fixture.service.clone());
    let error = registry
        .invoke_local(
            "sendRequests.send",
            serde_json::to_value(review("r1")).unwrap(),
            context,
            CancellationToken::new(),
        )
        .await
        .expect_err("refused over the registry too");
    assert_eq!(error["reason"], "person_only");

    // A terminal's credential reaches only the agent rules: off, its send is refused.
    let sent = fixture
        .cli(
            "term-2",
            "send",
            json!({ "to": "terminal:b/term-1", "text": "as a person?" }),
        )
        .await;
    assert_eq!(error_kind(&sent), "AgentMessagingDisabledError", "{sent}");
    fixture.enabled.send(true).unwrap();
    let sent = fixture
        .cli(
            "term-2",
            "send",
            json!({ "to": "terminal:b/term-1", "text": "as an agent" }),
        )
        .await;
    assert_eq!(sent["ok"], true, "{sent}");
    assert_eq!(
        fixture
            .count("SELECT COUNT(*) FROM agent_messages WHERE sender_kind = 'person'")
            .await,
        0
    );
    assert_eq!(fixture.count("SELECT COUNT(*) FROM send_requests").await, 0);
    fixture.shutdown().await;
}

#[tokio::test]
async fn the_source_agent_cannot_see_or_cancel_a_persons_request() {
    let fixture = fixture(true).await;
    fixture.send(review("r1")).await.unwrap();
    let source = AgentCaller::Thread("api".to_owned());
    assert_eq!(
        fixture
            .messaging
            .cancel_as(&source, "person-send:r1")
            .await
            .unwrap_err(),
        AgentMessagingError::UnknownMessage
    );
    assert_eq!(
        fixture
            .messaging
            .status_as(&source, "person-send:r1")
            .await
            .unwrap_err(),
        AgentMessagingError::UnknownMessage
    );
    assert_eq!(
        fixture.mail("person-send:r1").await.status,
        AgentMessageStatus::Queued
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_cursor_terminal_that_cannot_be_notified_is_refused_with_target_not_notifiable() {
    let fixture = fixture(true).await;
    for (request_id, target) in [
        ("r1", "terminal:b/cursor"),
        ("r2", "terminal:b/shell"),
        ("r3", "terminal:b/missing"),
    ] {
        assert_eq!(
            fixture
                .refused(input(request_id, "review", "thread:api", target))
                .await,
            "target_not_notifiable",
            "{target}"
        );
    }
    assert_eq!(fixture.count("SELECT COUNT(*) FROM send_requests").await, 0);
    assert_eq!(
        fixture.count("SELECT COUNT(*) FROM agent_messages").await,
        0
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_request_to_a_terminal_of_another_project_is_refused() {
    let fixture = fixture(true).await;
    assert_eq!(
        fixture
            .refused(input("r1", "review", "thread:api", "terminal:c/term-x"))
            .await,
        "other_project"
    );
    assert_eq!(
        fixture.count("SELECT COUNT(*) FROM agent_messages").await,
        0
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn an_idempotent_retry_stores_one_row() {
    let fixture = fixture(true).await;
    fixture.send(review("r1")).await.unwrap();
    fixture.send(review("r1")).await.unwrap();
    assert_eq!(fixture.count("SELECT COUNT(*) FROM send_requests").await, 1);
    assert_eq!(
        fixture.count("SELECT COUNT(*) FROM agent_messages").await,
        1
    );
    assert_eq!(
        fixture
            .count("SELECT COUNT(*) FROM provider_turn_outbox")
            .await,
        0
    );
    fixture.start();
    fixture.terminals.set_ready("b", "term-1");
    fixture.until_state("r1", SendState::Delivered).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fixture.terminals.writes("b", "term-1").len(), 1);
    fixture.shutdown().await;
}

#[tokio::test]
async fn cancelling_a_queued_terminal_request_cancels_its_mailbox_row_in_one_transaction() {
    let fixture = fixture(true).await;
    fixture.start();
    fixture.send(review("r1")).await.unwrap();
    let cancelled = fixture.service.cancel(&person(), "r1").await.unwrap();
    assert!(cancelled.cancelled);
    assert_eq!(fixture.state("r1").await, SendState::Cancelled);
    assert_eq!(
        fixture.mail("person-send:r1").await.status,
        AgentMessageStatus::Cancelled
    );
    assert!(fixture.inbox("term-1").await.is_empty());
    fixture.terminals.set_ready("b", "term-1");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        fixture.terminals.writes("b", "term-1").is_empty(),
        "no pointer"
    );
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_racing_an_inbox_fetch_has_exactly_one_winner() {
    let fixture = fixture(true).await;
    let context = person();
    let (mut cancels, mut fetches) = (0, 0);
    for run in 0..50 {
        let request_id = format!("race-{run}");
        fixture
            .send(input(
                &request_id,
                "review",
                "thread:api",
                "terminal:b/term-1",
            ))
            .await
            .unwrap();
        let (cancel, fetched) = tokio::join!(
            fixture.service.cancel(&context, &request_id),
            fixture.inbox("term-1")
        );
        let message_id = format!("person-send:{request_id}");
        let fetched = fetched.iter().any(|(id, _)| *id == message_id);
        match cancel {
            Ok(result) if result.cancelled => {
                cancels += 1;
                assert!(!fetched, "{request_id}: cancelled and fetched");
                assert_eq!(fixture.state(&request_id).await, SendState::Cancelled);
                assert_eq!(
                    fixture.mail(&message_id).await.status,
                    AgentMessageStatus::Cancelled
                );
            }
            other => {
                fetches += 1;
                let error = other.expect_err("a refused cancel");
                assert_eq!(error["reason"], "not_cancellable", "{error}");
                assert!(fetched, "{request_id}: refused but not fetched");
                assert_eq!(fixture.state(&request_id).await, SendState::Read);
            }
        }
    }
    assert_eq!(cancels + fetches, 50);
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_racing_a_pointer_paste_has_exactly_one_winner() {
    let fixture = fixture(true).await;
    fixture.start();
    let context = person();
    for run in 0..50 {
        let request_id = format!("race-{run}");
        fixture
            .send(input(
                &request_id,
                "review",
                "thread:api",
                "terminal:b/term-1",
            ))
            .await
            .unwrap();
        let before = fixture.terminals.writes("b", "term-1").len();
        let (cancel, ()) = tokio::join!(fixture.service.cancel(&context, &request_id), async {
            fixture.terminals.set_ready("b", "term-1");
        });
        match cancel {
            Ok(result) if result.cancelled => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                assert_eq!(
                    fixture.terminals.writes("b", "term-1").len(),
                    before,
                    "{request_id}: cancelled and pasted"
                );
                assert_eq!(fixture.state(&request_id).await, SendState::Cancelled);
            }
            other => {
                let error = other.expect_err("a refused cancel");
                assert_eq!(error["reason"], "not_cancellable", "{error}");
                fixture.until_state(&request_id, SendState::Delivered).await;
                assert_eq!(fixture.terminals.writes("b", "term-1").len(), before + 1);
            }
        }
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_subscribed_stream_sees_every_terminal_transition_without_a_reload() {
    let fixture = fixture(true).await;
    fixture.start();
    let mut stream =
        fixture
            .service
            .subscribe(&person(), Some("api".to_owned()), CancellationToken::new());
    let mut states = Vec::new();
    let mut next_state = async || loop {
        let chunk = tokio::time::timeout(Duration::from_secs(5), stream.recv())
            .await
            .expect("an event")
            .expect("the stream stays open")
            .expect("not an error");
        for event in chunk {
            if event["type"] == "upsert" && event["request"]["requestId"] == "r1" {
                return event["request"]["state"].as_str().unwrap().to_owned();
            }
        }
    };
    fixture.send(review("r1")).await.unwrap();
    states.push(next_state().await);
    fixture.terminals.set_ready("b", "term-1");
    states.push(next_state().await);
    fixture.inbox("term-1").await;
    states.push(next_state().await);
    fixture.reply("term-1", "person-send:r1", "Answer.").await;
    states.push(next_state().await);
    assert_eq!(states, ["queued", "delivered", "read", "answered"]);
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_terminal_requests_source_thread_is_its_owner_thread() {
    let fixture = fixture(true).await;
    let sent = fixture
        .service
        .send(
            &person(),
            input("r1", "message", "terminal:b/term-2", "terminal:b/term-1"),
        )
        .await
        .unwrap();
    assert_eq!(sent.source_thread_id, "b");
    assert_eq!(fixture.request("r1").await.source_thread_id, "b");
    fixture.shutdown().await;
}

// ---- Task 9.3: the end of a terminal generation ----

#[derive(Clone, Copy, Debug)]
enum End {
    Close,
    Exit,
    Restart,
    Replace,
}

impl Fixture {
    fn end(&self, terminal_id: &str, end: End) {
        match end {
            End::Close => self.terminals.close("b", terminal_id),
            End::Exit => self.terminals.set_generation("b", terminal_id, None),
            End::Restart => self.terminals.set_generation("b", terminal_id, Some(2)),
            End::Replace => {
                self.terminals.close("b", terminal_id);
                self.terminals.add("b", terminal_id, 3, true);
            }
        }
    }

    async fn until_reason(&self, request_id: &str, state: SendState, reason: &str) {
        self.until_state(request_id, state).await;
        assert_eq!(
            self.request(request_id).await.reason.as_deref(),
            Some(reason),
            "{request_id}"
        );
    }
}

#[tokio::test]
async fn a_request_to_a_terminal_whose_generation_ends_shows_not_answered() {
    let fixture = fixture(true).await;
    fixture.start();
    let mut run = 0;
    for end in [End::Close, End::Exit, End::Restart, End::Replace] {
        for start in [SendState::Queued, SendState::Delivered, SendState::Read] {
            run += 1;
            let (terminal_id, request_id) = (format!("g-{run}"), format!("end-{run}"));
            fixture.terminals.add("b", &terminal_id, 1, true);
            fixture
                .send(input(
                    &request_id,
                    "review",
                    "thread:api",
                    &format!("terminal:b/{terminal_id}"),
                ))
                .await
                .unwrap();
            if start != SendState::Queued {
                fixture.terminals.set_ready("b", &terminal_id);
                fixture.until_state(&request_id, SendState::Delivered).await;
            }
            if start == SendState::Read {
                assert_eq!(fixture.inbox(&terminal_id).await.len(), 1);
            }
            assert_eq!(fixture.state(&request_id).await, start, "{end:?}");
            fixture.end(&terminal_id, end);
            fixture
                .until_reason(&request_id, SendState::NotAnswered, "recipient_gone")
                .await;
        }
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_server_restart_fails_open_terminal_requests() {
    let fixture = fixture(true).await;
    fixture.send(review("r1")).await.unwrap();
    fixture.send(review("r2")).await.unwrap();
    fixture.inbox("term-1").await;
    assert_eq!(
        fail_open_terminal_requests(&fixture.service).await.unwrap(),
        2
    );
    fixture
        .until_reason("r1", SendState::NotAnswered, "recipient_gone")
        .await;
    fixture
        .until_reason("r2", SendState::NotAnswered, "recipient_gone")
        .await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn generation_end_is_published_to_a_subscribed_stream() {
    let fixture = fixture(true).await;
    fixture.start();
    let mut stream =
        fixture
            .service
            .subscribe(&person(), Some("api".to_owned()), CancellationToken::new());
    fixture.send(review("r1")).await.unwrap();
    fixture.end("term-1", End::Close);
    let state = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let chunk = stream.recv().await.expect("open").expect("not an error");
            for event in chunk {
                if event["type"] == "upsert"
                    && event["request"]["requestId"] == "r1"
                    && event["request"]["state"] == "not_answered"
                {
                    return event["request"]["reason"].as_str().unwrap().to_owned();
                }
            }
        }
    })
    .await
    .expect("the not answered upsert arrives");
    assert_eq!(state, "recipient_gone");
    fixture.shutdown().await;
}

#[tokio::test]
async fn an_answer_stored_before_the_generation_ended_is_kept() {
    let fixture = fixture(true).await;
    fixture.start();
    fixture.send(review("r1")).await.unwrap();
    fixture.inbox("term-1").await;
    fixture
        .reply("term-1", "person-send:r1", "Kept answer.")
        .await;
    // A second, unanswered request makes the generation end reach the sink.
    fixture.send(review("r2")).await.unwrap();
    fixture.end("term-1", End::Close);
    fixture
        .until_reason("r2", SendState::NotAnswered, "recipient_gone")
        .await;
    assert_eq!(fixture.state("r1").await, SendState::Answered);
    let answer = fixture.service.get_answer(&person(), "r1").await.unwrap();
    assert_eq!(answer.text, "Kept answer.");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_terminal_answer_is_returned_by_get_answer_cut_at_48000_characters() {
    let fixture = fixture(true).await;
    fixture.send(review("r1")).await.unwrap();
    fixture.inbox("term-1").await;
    let replied = fixture
        .reply("term-1", "person-send:r1", &"y".repeat(60_000))
        .await;
    assert_eq!(replied["ok"], true, "{}", replied["error"]);
    let answer = fixture.service.get_answer(&person(), "r1").await.unwrap();
    assert!(answer.truncated);
    assert_eq!(answer.text.chars().count(), 48_000);
    fixture.shutdown().await;
}
