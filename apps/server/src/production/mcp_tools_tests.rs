//! The outside-agent MCP thread tools (#139) end to end: the real tool registration, the real
//! orchestration RPC registry and engine on SQLite, and the real auth service. Only the
//! provider is faked: its events are dispatched to the engine as a provider runtime would.

use std::{sync::Arc, time::Duration};

use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{
    provider_runtime::{
        BoxRuntimeFuture, ProviderDriver, ProviderDriverFactory, ProviderLaunchRequest,
        ProviderRuntimeError, ProviderRuntimeSupervisor, SupervisorOptions,
    },
    turn_delivery::{DeliveryRouter, TurnDeliveryService},
};
use crate::{
    ServerConfig,
    activity::{ActivityProjection, ActivityRepository},
    auth::{AuthService, ClientMetadata, SecretStore, SessionTransport, issue_mcp_pairing_link},
    mcp::control::{ClientPrincipal, McpAccess, McpControl, McpServerSettings},
    orchestration::{OrchestrationEngine, engine::EngineOptions},
    persistence::{Database, Repositories, run_migrations},
    rpc::RpcRegistry,
};

const CREATED_AT: &str = "2026-10-30T00:00:00.000Z";

struct NeverFactory;

impl ProviderDriverFactory for NeverFactory {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
        Box::pin(async move {
            Err(ProviderRuntimeError::UnsupportedProvider {
                provider: request.provider,
            })
        })
    }
}

pub(crate) struct Harness {
    pub(crate) engine: OrchestrationEngine,
    pub(crate) control: McpControl,
    pub(crate) auth: AuthService,
    pub(crate) repositories: Repositories,
    pub(crate) settings: watch::Sender<McpServerSettings>,
    delivery: Arc<TurnDeliveryService>,
    provider: Arc<ProviderRuntimeSupervisor>,
    _state: tempfile::TempDir,
    _secrets: tempfile::TempDir,
}

impl Harness {
    pub(crate) async fn new() -> Self {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let engine = OrchestrationEngine::start(database.clone(), EngineOptions::default())
            .await
            .expect("engine starts");
        let state = tempfile::tempdir().expect("state");
        engine
            .dispatch(command(json!({
                "type": "project.create",
                "commandId": "project-create",
                "projectId": "p1",
                "title": "Project",
                "workspaceRoot": state.path(),
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("project created");
        let provider = Arc::new(ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(NeverFactory),
            ActivityProjection::new(ActivityRepository::new(database.clone())),
            SupervisorOptions::default(),
        ));
        let router: DeliveryRouter = Arc::new(|_| Box::pin(async { Ok(()) }));
        let delivery = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            router,
        ));
        let mut registry = RpcRegistry::empty();
        super::orchestration_rpc::register_orchestration_rpc_with_delivery(
            &mut registry,
            engine.clone(),
            provider.clone(),
            state.path().to_path_buf(),
            delivery.clone(),
            crate::transfer::staging::UploadRegistry::new(
                state.path().join("uploads"),
                crate::transfer::staging::UploadLimits::default(),
                Arc::new(tokio::time::Instant::now),
            ),
        );
        let repositories = Repositories::new(database);
        let secrets = tempfile::tempdir().expect("secrets");
        let auth = AuthService::new_with_persistence(
            &ServerConfig::new(".").with_bind("127.0.0.1", 3773),
            vec![7_u8; 32],
            SecretStore::new(secrets.path())
                .await
                .expect("secret store"),
            repositories.clone(),
        )
        .await
        .expect("auth");
        let (settings, receiver) = watch::channel(McpServerSettings {
            enabled: true,
            access: McpAccess::FullAccess,
        });
        let control = McpControl::new(registry, auth.clone(), engine.clone(), receiver);
        Self {
            engine,
            control,
            auth,
            repositories,
            settings,
            delivery,
            provider,
            _state: state,
            _secrets: secrets,
        }
    }

    /// An outside agent's credential with ceiling `access`, minted and exchanged as the relay
    /// does.
    pub(crate) async fn agent(&self, access: McpAccess) -> (ClientPrincipal, String) {
        let link = issue_mcp_pairing_link(&self.repositories, "MCP · test".into(), access.as_str())
            .await
            .expect("link");
        let session = self
            .auth
            .exchange_bootstrap(
                &link.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("exchange");
        let principal = self
            .control
            .authenticate(&session.token)
            .await
            .expect("an MCP credential");
        (principal, session.token)
    }

    async fn call(&self, agent: &ClientPrincipal, tool: &str, arguments: Value) -> Value {
        let Value::Object(arguments) = arguments else {
            panic!("arguments are an object");
        };
        self.control
            .call(agent, tool, &arguments, None, CancellationToken::new())
            .await
    }

    /// What the provider runtime would dispatch for one turn: it starts, streams a reply, and
    /// settles.
    async fn provider_turn(&self, thread_id: &str, turn_id: &str, reply: &str, settle: bool) {
        let session = |status: &str, active: Option<&str>| {
            json!({
                "type": "thread.session.set",
                "commandId": format!("session-{turn_id}-{status}"),
                "threadId": thread_id,
                "session": {
                    "threadId": thread_id, "status": status, "providerName": "codex",
                    "providerInstanceId": "codex", "runtimeMode": "full-access",
                    "activeTurnId": active, "lastError": null, "updatedAt": CREATED_AT,
                },
                "createdAt": CREATED_AT,
            })
        };
        let mut commands = vec![
            session("running", Some(turn_id)),
            json!({
                "type": "thread.message.assistant.delta", "commandId": format!("delta-{turn_id}"),
                "threadId": thread_id, "messageId": format!("reply-{turn_id}"), "delta": reply,
                "turnId": turn_id, "createdAt": CREATED_AT,
            }),
        ];
        if settle {
            commands.push(json!({
                "type": "thread.message.assistant.complete", "commandId": format!("complete-{turn_id}"),
                "threadId": thread_id, "messageId": format!("reply-{turn_id}"),
                "turnId": turn_id, "createdAt": CREATED_AT,
            }));
            commands.push(session("ready", None));
        }
        for value in commands {
            self.engine
                .dispatch(command(value))
                .await
                .expect("provider event");
        }
    }

    pub(crate) async fn shutdown(self) {
        self.delivery.shutdown().await;
        self.provider.shutdown().await.expect("provider shutdown");
        self.engine.shutdown().await;
    }
}

fn command(value: Value) -> crate::orchestration::engine::OrchestrationCommand {
    serde_json::from_value(value).expect("command decodes")
}

fn structured(result: &Value) -> &Value {
    assert_ne!(result["isError"], true, "{result}");
    &result["structuredContent"]
}

fn error_tag(result: &Value) -> &str {
    assert_eq!(result["isError"], true, "{result}");
    result["structuredContent"]["error"]["_tag"]
        .as_str()
        .unwrap_or_default()
}

async fn start(harness: &Harness, agent: &ClientPrincipal, arguments: Value) -> (String, String) {
    let started = harness.call(agent, "start_thread", arguments).await;
    let started = structured(&started);
    (
        started["threadId"].as_str().unwrap().to_owned(),
        started["messageId"].as_str().unwrap().to_owned(),
    )
}

fn basic_start() -> Value {
    json!({ "projectId": "p1", "prompt": "Summarize the README", "providerInstanceId": "codex", "model": "gpt-5" })
}

#[tokio::test]
async fn start_then_wait_returns_the_turns_reply() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, message_id) = start(&harness, &agent, basic_start()).await;
    let waiter = {
        let control = harness.control.clone();
        let agent = agent.clone();
        let mut arguments = Map::new();
        arguments.insert("threadId".into(), json!(thread_id));
        arguments.insert("messageId".into(), json!(message_id));
        arguments.insert("timeoutMs".into(), json!(20_000));
        tokio::spawn(async move {
            control
                .call(
                    &agent,
                    "wait_for_thread",
                    &arguments,
                    None,
                    CancellationToken::new(),
                )
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    harness
        .provider_turn(&thread_id, "turn-1", "The README says hello.", true)
        .await;
    let waited = waiter.await.unwrap();
    let waited = structured(&waited);
    assert_eq!(waited["status"], "completed", "{waited}");
    assert_eq!(waited["turnId"], "turn-1");
    assert_eq!(waited["timedOut"], false);
    assert_eq!(waited["reply"]["text"], "The README says hello.");

    let read = harness
        .call(&agent, "read_thread", json!({ "threadId": thread_id }))
        .await;
    let messages = structured(&read)["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert!(
        harness
            .call(&agent, "list_projects_and_threads", json!({}))
            .await["structuredContent"]["threads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|thread| thread["threadId"] == thread_id.as_str())
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn a_wait_on_an_older_message_returns_its_own_turn_and_reply() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, first) = start(&harness, &agent, basic_start()).await;
    harness
        .provider_turn(&thread_id, "turn-1", "first reply", true)
        .await;
    let sent = harness
        .call(
            &agent,
            "send_message",
            json!({ "threadId": thread_id, "text": "and then?" }),
        )
        .await;
    let second = structured(&sent)["messageId"].as_str().unwrap().to_owned();
    harness
        .provider_turn(&thread_id, "turn-2", "second reply", true)
        .await;
    for _ in 0..2 {
        let waited = harness
            .call(
                &agent,
                "wait_for_thread",
                json!({ "threadId": thread_id, "messageId": first, "timeoutMs": 1_000 }),
            )
            .await;
        let waited = structured(&waited);
        assert_eq!(waited["turnId"], "turn-1", "{waited}");
        assert_eq!(waited["reply"]["text"], "first reply");
    }
    let waited = harness
        .call(
            &agent,
            "wait_for_thread",
            json!({ "threadId": thread_id, "messageId": second, "timeoutMs": 1_000 }),
        )
        .await;
    assert_eq!(structured(&waited)["reply"]["text"], "second reply");
    // Without a message, the whole thread: idle, and the newest turn named.
    let waited = harness
        .call(
            &agent,
            "wait_for_thread",
            json!({ "threadId": thread_id, "timeoutMs": 300_000 }),
        )
        .await;
    let waited = structured(&waited);
    assert_eq!(waited["status"], "idle", "{waited}");
    assert_eq!(waited["turnId"], "turn-2");
    assert_eq!(
        waited["effectiveTimeoutMs"], 50_000,
        "a long wait is clamped"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn a_timed_out_or_cancelled_wait_leaves_work_running_and_releases_its_receiver() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, message_id) = start(&harness, &agent, basic_start()).await;
    harness
        .provider_turn(&thread_id, "turn-1", "partial", false)
        .await;
    let baseline = harness.engine.event_subscriber_count_for_test();
    let waited = harness
        .call(
            &agent,
            "wait_for_thread",
            json!({ "threadId": thread_id, "messageId": message_id, "timeoutMs": 200 }),
        )
        .await;
    let waited = structured(&waited);
    assert_eq!(waited["timedOut"], true);
    assert_eq!(waited["status"], "running", "{waited}");
    assert_eq!(harness.engine.event_subscriber_count_for_test(), baseline);

    let cancellation = CancellationToken::new();
    let waiter = {
        let control = harness.control.clone();
        let agent = agent.clone();
        let cancellation = cancellation.clone();
        let mut arguments = Map::new();
        arguments.insert("threadId".into(), json!(thread_id));
        tokio::spawn(async move {
            control
                .call(&agent, "wait_for_thread", &arguments, None, cancellation)
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        harness.engine.event_subscriber_count_for_test(),
        baseline + 1
    );
    cancellation.cancel();
    assert_eq!(error_tag(&waiter.await.unwrap()), "McpCancelledError");
    assert_eq!(harness.engine.event_subscriber_count_for_test(), baseline);
    let turn_state: String = harness
        .repositories
        .database()
        .call(|connection| {
            Ok(connection.query_row(
                "SELECT state FROM projection_turns WHERE turn_id = 'turn-1'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(turn_state, "running", "a timeout never cancels work");
    harness.shutdown().await;
}

#[tokio::test]
async fn progress_carries_the_token_and_status_never_text() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, message_id) = start(&harness, &agent, basic_start()).await;
    let (sink, mut notifications) = tokio::sync::mpsc::channel(16);
    let waiter = {
        let control = harness.control.clone();
        let agent = agent.clone();
        let mut arguments = Map::new();
        arguments.insert("threadId".into(), json!(thread_id));
        arguments.insert("messageId".into(), json!(message_id));
        tokio::spawn(async move {
            control
                .call(
                    &agent,
                    "wait_for_thread",
                    &arguments,
                    Some((sink, json!("token-7"))),
                    CancellationToken::new(),
                )
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    harness
        .provider_turn(&thread_id, "turn-1", "SECRET REPLY TEXT", true)
        .await;
    structured(&waiter.await.unwrap());
    let mut seen = Vec::new();
    while let Ok(notification) = notifications.try_recv() {
        seen.push(notification);
    }
    assert!(!seen.is_empty());
    for notification in &seen {
        assert_eq!(notification["method"], "notifications/progress");
        assert_eq!(notification["params"]["progressToken"], "token-7");
        assert!(!notification.to_string().contains("SECRET"));
        assert!(!notification.to_string().contains("README"));
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn retries_with_one_client_request_id_start_one_turn() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["clientRequestId"] = json!("retry-1");
    let first = start(&harness, &agent, arguments.clone()).await;
    let second = start(&harness, &agent, arguments.clone()).await;
    assert_eq!(first, second);
    // Concurrently, too.
    let mut concurrent = arguments.clone();
    concurrent["clientRequestId"] = json!("retry-2");
    let (left, right) = tokio::join!(
        start(&harness, &agent, concurrent.clone()),
        start(&harness, &agent, concurrent.clone())
    );
    assert_eq!(left, right);
    let rows: i64 = harness
        .repositories
        .database()
        .call(|connection| {
            Ok(
                connection.query_row("SELECT COUNT(*) FROM mcp_tool_requests", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .await
        .unwrap();
    assert_eq!(rows, 2);
    let threads: Vec<String> = harness
        .repositories
        .database()
        .call(|connection| {
            // The project's own first thread comes from the harness, not from a tool.
            let mut statement = connection
                .prepare("SELECT thread_id FROM projection_threads WHERE created_at <> ?")?;
            let ids = statement
                .query_map([CREATED_AT], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(ids)
        })
        .await
        .unwrap();
    assert_eq!(threads.len(), 2, "{threads:?}");

    // The same id with another model is a different call.
    let mut changed = arguments.clone();
    changed["model"] = json!("gpt-5-mini");
    assert_eq!(
        error_tag(&harness.call(&agent, "start_thread", changed).await),
        "idempotency_conflict"
    );
    // Without an id, every call is a new request.
    let third = start(&harness, &agent, basic_start()).await;
    let fourth = start(&harness, &agent, basic_start()).await;
    assert_ne!(third, fourth);
    harness.shutdown().await;
}

/// The provider asks `request_id` on `thread_id`.
async fn ask(harness: &Harness, thread_id: &str, request_id: &str) {
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.activity.append", "commandId": format!("ask-{request_id}"),
            "threadId": thread_id,
            "activity": {
                "id": format!("ask-{request_id}"), "tone": "approval", "kind": "user-input.requested",
                "summary": "Needs you",
                "payload": { "requestId": request_id, "questions": [{ "id": "color", "header": "Color", "question": "Which?", "options": [{ "label": "Red", "description": "" }] }] },
                "turnId": "turn-1", "createdAt": CREATED_AT,
            },
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("question asked");
}

fn lower_ceiling(harness: &Harness, access: McpAccess) {
    harness.settings.send_replace(McpServerSettings {
        enabled: true,
        access,
    });
}

/// A retry whose first answer was lost replays what was accepted, even when what the tool
/// checks before new work has changed since: the ceiling fell, or the question was answered.
#[tokio::test]
async fn a_retry_after_a_lost_response_replays_the_accepted_call() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["runtimeMode"] = json!("full-access");
    arguments["clientRequestId"] = json!("lost-start");
    let first = harness
        .call(&agent, "start_thread", arguments.clone())
        .await;
    let thread_id = structured(&first)["threadId"].as_str().unwrap().to_owned();
    harness.provider_turn(&thread_id, "turn-1", "", false).await;
    let send = json!({ "threadId": thread_id, "text": "more", "clientRequestId": "lost-send" });
    let sent = harness.call(&agent, "send_message", send.clone()).await;
    structured(&sent);
    ask(&harness, &thread_id, "q1").await;
    let answer = json!({ "threadId": thread_id, "requestId": "q1", "answers": { "color": "Red" }, "clientRequestId": "lost-answer" });
    // The engine accepts the answer; only the faked provider, which has no live session to
    // take it, fails afterwards. That failure stands in for the lost response.
    harness
        .call(&agent, "answer_question", answer.clone())
        .await;
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.activity.append", "commandId": "resolve-q1", "threadId": thread_id,
            "activity": {
                "id": "resolve-q1", "tone": "info", "kind": "user-input.resolved", "summary": "Answered",
                "payload": { "requestId": "q1" }, "turnId": "turn-1", "createdAt": CREATED_AT,
            },
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("question resolved");
    let open = harness
        .call(
            &agent,
            "list_pending_requests",
            json!({ "threadId": thread_id }),
        )
        .await;
    assert_eq!(structured(&open)["questions"], json!([]), "{open}");

    // The question is no longer open, and the ceiling is below the thread's mode.
    lower_ceiling(&harness, McpAccess::ApprovalRequired);
    let retried = harness.call(&agent, "start_thread", arguments).await;
    assert_eq!(structured(&retried), structured(&first));
    let retried = harness.call(&agent, "send_message", send).await;
    assert_eq!(
        structured(&retried)["messageId"],
        structured(&sent)["messageId"]
    );
    let retried = harness.call(&agent, "answer_question", answer).await;
    assert_eq!(
        structured(&retried),
        &json!({ "threadId": thread_id, "requestId": "q1", "answered": true })
    );
    harness.shutdown().await;
}

/// A stored request whose command the engine never accepted is new work: the current ceiling
/// applies to it before it is dispatched.
#[tokio::test]
async fn a_stored_request_not_yet_accepted_meets_the_current_ceiling() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["runtimeMode"] = json!("full-access");
    arguments["clientRequestId"] = json!("never-dispatched");
    store_request(&harness, &agent, "start_thread", &arguments, |command| {
        command["runtimeMode"] = json!("full-access");
    })
    .await;
    lower_ceiling(&harness, McpAccess::ApprovalRequired);
    assert_eq!(
        error_tag(
            &harness
                .call(&agent, "start_thread", arguments.clone())
                .await
        ),
        "McpAccessCeilingError"
    );
    // Raised again, the stored command is the one dispatched.
    lower_ceiling(&harness, McpAccess::FullAccess);
    let started = harness.call(&agent, "start_thread", arguments).await;
    assert_eq!(structured(&started)["threadId"], "stored-thread");
    harness.shutdown().await;
}

/// Writes the `mcp_tool_requests` row a call with `arguments` stores, holding one
/// `thread.turn.start` for thread `stored-thread`, as if the server stopped before dispatching
/// it. Returns the stored command.
async fn store_request(
    harness: &Harness,
    agent: &ClientPrincipal,
    tool: &str,
    arguments: &Value,
    adjust: impl FnOnce(&mut Value),
) -> Value {
    let mut start = json!({
        "type": "thread.turn.start",
        "commandId": "stored-command",
        "threadId": "stored-thread",
        "message": { "messageId": "stored-message", "role": "user", "text": arguments["prompt"], "attachments": [] },
        "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
        "titleSeed": "Stored",
        "runtimeMode": "approval-required",
        "interactionMode": "default",
        "bootstrap": { "createThread": {
            "projectId": "p1", "title": "Stored",
            "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "approval-required", "interactionMode": "default",
            "branch": null, "worktreePath": null, "createdAt": CREATED_AT,
        }},
        "createdAt": CREATED_AT,
    });
    adjust(&mut start);
    if let Some(mode) = start["runtimeMode"].as_str().map(str::to_owned) {
        start["bootstrap"]["createThread"]["runtimeMode"] = json!(mode);
    }
    insert_request(harness, agent, tool, arguments, &[start.clone()]).await;
    start
}

/// Writes the `mcp_tool_requests` row a call with `arguments` stores, holding `commands`.
async fn insert_request(
    harness: &Harness,
    agent: &ClientPrincipal,
    tool: &str,
    arguments: &Value,
    commands: &[Value],
) {
    let digest = crate::orchestration::delivery::canonical_command_digest(arguments).unwrap();
    let session_id = agent.principal.session_id.clone();
    let client_request_id = arguments["clientRequestId"].as_str().unwrap().to_owned();
    let tool = tool.to_owned();
    let commands = serde_json::to_string(commands).unwrap();
    harness
        .repositories
        .database()
        .call(move |connection| {
            connection.execute(
                "INSERT INTO mcp_tool_requests (session_id, client_request_id, tool, arguments_digest, commands_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                rusqlite::params![session_id, client_request_id, tool, digest, commands, "2099-10-30T00:00:00Z"],
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

/// A stored `send_message` whose turn start was accepted but whose steer was not (the server
/// stopped between them): the steer is new work on a thread now above the ceiling, so the
/// retry is refused before it is dispatched.
#[tokio::test]
async fn an_unaccepted_stored_command_meets_the_ceiling_of_the_thread_it_advances() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["runtimeMode"] = json!("full-access");
    let (thread_id, _) = start(&harness, &agent, arguments).await;
    let send = json!({ "threadId": thread_id, "text": "more", "mode": "steer", "clientRequestId": "half-sent" });
    let start_command = json!({
        "type": "thread.turn.start", "commandId": "half-start", "threadId": thread_id,
        "message": { "messageId": "half-message", "role": "user", "text": "more", "attachments": [] },
        "runtimeMode": "approval-required", "interactionMode": "default", "queued": true,
        "createdAt": CREATED_AT,
    });
    let steer_command = json!({
        "type": "thread.turn.steer", "commandId": "half-steer", "threadId": thread_id,
        "messageId": "half-message", "createdAt": CREATED_AT,
    });
    insert_request(
        &harness,
        &agent,
        "send_message",
        &send,
        &[start_command.clone(), steer_command],
    )
    .await;
    receipt(&harness, &start_command, "accepted", None).await;
    lower_ceiling(&harness, McpAccess::ApprovalRequired);
    assert_eq!(
        error_tag(&harness.call(&agent, "send_message", send).await),
        "McpAccessCeilingError"
    );
    harness.shutdown().await;
}

/// A receipt for `command` in `status`, written as the engine writes one.
async fn receipt(harness: &Harness, command: &Value, status: &str, error: Option<&str>) {
    harness
        .repositories
        .reserve_command_receipt(crate::persistence::CommandReceipt {
            command_id: command["commandId"].as_str().unwrap().to_owned(),
            aggregate_kind: "thread".to_owned(),
            aggregate_id: command["threadId"].as_str().unwrap().to_owned(),
            accepted_at: CREATED_AT.to_owned(),
            result_sequence: 0,
            status: status.to_owned(),
            error: error.map(str::to_owned),
            payload_digest: Some(
                crate::orchestration::delivery::canonical_command_digest(command).unwrap(),
            ),
        })
        .await
        .expect("receipt");
}

/// A server that stopped after it reserved the command's receipt but before it enqueued the
/// turn: the retry resumes the admission, and answers once the turn is admitted.
#[tokio::test]
async fn a_retry_after_a_crash_between_reservation_and_enqueue_resumes_delivery() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["clientRequestId"] = json!("crashed");
    let stored = store_request(&harness, &agent, "start_thread", &arguments, |_| {}).await;
    receipt(&harness, &stored, "reserved", None).await;
    let started = harness.call(&agent, "start_thread", arguments).await;
    let started = structured(&started);
    assert_eq!(started["threadId"], "stored-thread");
    assert_eq!(started["messageId"], "stored-message");
    let receipt = harness
        .repositories
        .get_command_receipt("stored-command".to_owned())
        .await
        .unwrap()
        .expect("receipt");
    assert_eq!(receipt.status, "accepted", "admitted before the answer");
    let admitted: (i64, i64) = harness
        .repositories
        .database()
        .call(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT COUNT(*) FROM projection_thread_messages WHERE message_id = 'stored-message'),
                        (SELECT COUNT(*) FROM projection_turns WHERE pending_message_id = 'stored-message')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(admitted, (1, 1), "the message and its turn exist");
    harness.shutdown().await;
}

/// A retry of a command the engine rejected answers with that rejection, never success.
#[tokio::test]
async fn a_retry_of_a_rejected_command_returns_its_original_error() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["clientRequestId"] = json!("rejected");
    let stored = store_request(&harness, &agent, "start_thread", &arguments, |_| {}).await;
    receipt(
        &harness,
        &stored,
        "rejected",
        Some("The original rejection."),
    )
    .await;
    for _ in 0..2 {
        let retried = harness
            .call(&agent, "start_thread", arguments.clone())
            .await;
        error_tag(&retried);
        assert!(
            retried["structuredContent"]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("The original rejection."),
            "{retried}"
        );
    }
    let threads: i64 = harness
        .repositories
        .database()
        .call(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM projection_threads WHERE thread_id = 'stored-thread'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(threads, 0, "nothing was started");
    harness.shutdown().await;
}

/// `mode: steer` on a running turn: the message is queued and promoted to steer it, by two
/// commands with their own ids, and a retry replays both.
#[tokio::test]
async fn steer_queues_the_message_and_steers_the_running_turn() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    harness
        .provider_turn(&thread_id, "turn-1", "working", false)
        .await;
    let arguments = json!({ "threadId": thread_id, "text": "use the other file", "mode": "steer", "clientRequestId": "steer-1" });
    let sent = harness
        .call(&agent, "send_message", arguments.clone())
        .await;
    let sent = structured(&sent).clone();
    assert!(sent["messageId"].is_string(), "{sent}");
    assert_eq!(sent["steer"]["steered"], true, "{sent}");
    let stored: String = harness
        .repositories
        .database()
        .call(|connection| {
            Ok(connection.query_row(
                "SELECT commands_json FROM mcp_tool_requests WHERE client_request_id = 'steer-1'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    let stored: Vec<Value> = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored.len(), 2);
    assert_eq!(stored[0]["type"], "thread.turn.start");
    assert_eq!(stored[1]["type"], "thread.turn.steer");
    assert_ne!(stored[0]["commandId"], stored[1]["commandId"]);
    assert_eq!(stored[1]["messageId"], sent["messageId"]);
    let retried = harness.call(&agent, "send_message", arguments).await;
    assert_eq!(structured(&retried)["messageId"], sent["messageId"]);
    harness.shutdown().await;
}

#[tokio::test]
async fn the_ceiling_caps_starts_and_refuses_driving_a_thread_above_it() {
    let harness = Harness::new().await;
    let (full, _) = harness.agent(McpAccess::FullAccess).await;
    let (full_thread, _) = start(
        &harness,
        &full,
        json!({ "projectId": "p1", "prompt": "go", "providerInstanceId": "codex", "model": "gpt-5", "runtimeMode": "full-access" }),
    )
    .await;
    let (supervised, _) = harness.agent(McpAccess::ApprovalRequired).await;
    let mut explicit = basic_start();
    explicit["runtimeMode"] = json!("full-access");
    assert_eq!(
        error_tag(&harness.call(&supervised, "start_thread", explicit).await),
        "McpAccessCeilingError"
    );
    let started = harness
        .call(&supervised, "start_thread", basic_start())
        .await;
    assert_eq!(structured(&started)["runtimeMode"], "approval-required");
    assert_eq!(
        error_tag(
            &harness
                .call(
                    &supervised,
                    "send_message",
                    json!({ "threadId": full_thread, "text": "more" })
                )
                .await
        ),
        "McpAccessCeilingError"
    );

    // Lowering the setting applies at once; raising it never raises a credential.
    harness.settings.send_replace(McpServerSettings {
        enabled: true,
        access: McpAccess::ApprovalRequired,
    });
    assert_eq!(
        harness.control.effective_ceiling(&full),
        McpAccess::ApprovalRequired
    );
    harness.settings.send_replace(McpServerSettings {
        enabled: true,
        access: McpAccess::FullAccess,
    });
    assert_eq!(
        harness.control.effective_ceiling(&supervised),
        McpAccess::ApprovalRequired
    );

    let (reader, _) = harness.agent(McpAccess::ReadOnly).await;
    let listed = harness.control.tools(&reader);
    let names: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(!names.contains(&"start_thread") && names.contains(&"read_thread"));
    assert_eq!(
        error_tag(&harness.call(&reader, "start_thread", basic_start()).await),
        "McpAccessCeilingError"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn questions_are_answered_and_approvals_are_not() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    harness.provider_turn(&thread_id, "turn-1", "", false).await;
    for (id, kind, payload) in [
        (
            "ask",
            "user-input.requested",
            json!({ "requestId": "q1", "questions": [{ "id": "color", "header": "Color", "question": "Which?", "options": [{ "label": "Red", "description": "" }] }] }),
        ),
        (
            "approve",
            "approval.requested",
            json!({ "requestId": "a1", "requestKind": "command" }),
        ),
    ] {
        harness
            .engine
            .dispatch(command(json!({
                "type": "thread.activity.append", "commandId": id, "threadId": thread_id,
                "activity": { "id": id, "tone": "approval", "kind": kind, "summary": "Needs you", "payload": payload, "turnId": "turn-1", "createdAt": CREATED_AT },
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("activity");
    }
    let pending = harness
        .call(
            &agent,
            "list_pending_requests",
            json!({ "threadId": thread_id }),
        )
        .await;
    let pending = structured(&pending);
    assert_eq!(pending["questions"][0]["requestId"], "q1", "{pending}");
    assert_eq!(pending["questions"][0]["questions"][0]["id"], "color");
    let waited = harness
        .call(
            &agent,
            "wait_for_thread",
            json!({ "threadId": thread_id, "timeoutMs": 1_000 }),
        )
        .await;
    assert!(
        matches!(
            structured(&waited)["status"].as_str(),
            Some("awaiting_approval" | "awaiting_input")
        ),
        "{waited}"
    );
    {
        let approval = &pending["approvals"][0];
        assert_eq!(approval["requestId"], "a1", "{pending}");
        assert_eq!(approval["answerWith"], "a person, in BiBCode");
        assert_eq!(
            error_tag(
                &harness
                    .call(
                        &agent,
                        "answer_question",
                        json!({ "threadId": thread_id, "requestId": approval["requestId"], "answers": {} }),
                    )
                    .await
            ),
            "McpApprovalNotAnswerableError"
        );
    }
    let answered = harness
        .call(
            &agent,
            "answer_question",
            json!({ "threadId": thread_id, "requestId": "q1", "answers": { "color": "Red" } }),
        )
        .await;
    // The faked provider has no live session to take the answer; what matters is that the
    // tool reached the RPC handler instead of refusing it.
    if answered["isError"] == true {
        assert_ne!(error_tag(&answered), "McpApprovalNotAnswerableError");
        assert_ne!(error_tag(&answered), "McpScopeError");
    }
    // The faked provider has no live session either, so the handler refuses the interrupt
    // itself; the tool layer let it through.
    let interrupted = harness
        .call(&agent, "interrupt_turn", json!({ "threadId": thread_id }))
        .await;
    if interrupted["isError"] == true {
        assert_eq!(error_tag(&interrupted), "OrchestrationDispatchCommandError");
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn turning_the_server_off_refuses_calls_and_ends_open_waits() {
    let harness = Harness::new().await;
    let (agent, token) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, message_id) = start(&harness, &agent, basic_start()).await;
    let waiter = {
        let control = harness.control.clone();
        let agent = agent.clone();
        let mut arguments = Map::new();
        arguments.insert("threadId".into(), json!(thread_id));
        arguments.insert("messageId".into(), json!(message_id));
        tokio::spawn(async move {
            control
                .call(
                    &agent,
                    "wait_for_thread",
                    &arguments,
                    None,
                    CancellationToken::new(),
                )
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    harness.settings.send_replace(McpServerSettings {
        enabled: false,
        access: McpAccess::FullAccess,
    });
    assert_eq!(error_tag(&waiter.await.unwrap()), "McpServerDisabledError");
    assert_eq!(
        error_tag(
            &harness
                .call(&agent, "read_thread", json!({ "threadId": thread_id }))
                .await
        ),
        "McpServerDisabledError"
    );
    harness.settings.send_replace(McpServerSettings {
        enabled: true,
        access: McpAccess::FullAccess,
    });
    // The same credential works again: nothing was revoked.
    let agent = harness
        .control
        .authenticate(&token)
        .await
        .expect("still valid");
    structured(
        &harness
            .call(&agent, "read_thread", json!({ "threadId": thread_id }))
            .await,
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn read_thread_reads_one_page_and_every_character_is_reachable() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    let long = "x".repeat(100_000);
    let thread = thread_id.clone();
    let long_text = long.clone();
    harness
        .repositories
        .database()
        .call(move |connection| {
            let transaction = connection.transaction()?;
            {
                let mut insert = transaction.prepare(
                    "INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES (?, ?, NULL, 'assistant', ?, 0, ?, ?)",
                )?;
                for index in 0..10_000 {
                    let at = format!("2099-10-30T01:{:02}:{:02}.{:03}Z", index / 6000, (index / 100) % 60, index % 100);
                    let text = if index == 9_999 { long_text.clone() } else { format!("message {index}") };
                    insert.execute(rusqlite::params![format!("bulk-{index:05}"), thread, text, at, at])?;
                }
            }
            transaction.commit()?;
            Ok(())
        })
        .await
        .unwrap();
    let page = crate::mcp::control::read_message_page(&harness.repositories, &thread_id, None, 20)
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 20);
    assert!(
        page.rows_read <= 21,
        "the SQL LIMIT bounds the rows read: {}",
        page.rows_read
    );
    let read = harness
        .call(
            &agent,
            "read_thread",
            json!({ "threadId": thread_id, "limit": 5 }),
        )
        .await;
    let read = structured(&read);
    let newest = read["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(newest["textLength"], 100_000);
    assert!(read["nextCursor"].is_string());
    let mut recovered = String::new();
    while recovered.len() < 100_000 {
        let slice = harness
            .call(
                &agent,
                "read_thread",
                json!({ "threadId": thread_id, "messageId": newest["messageId"], "textOffset": recovered.len() }),
            )
            .await;
        let text = structured(&slice)["message"]["text"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(!text.is_empty());
        recovered.push_str(&text);
    }
    assert_eq!(recovered, long);
    let older = harness
        .call(
            &agent,
            "read_thread",
            json!({ "threadId": thread_id, "limit": 5, "cursor": read["nextCursor"] }),
        )
        .await;
    let older = structured(&older)["messages"].as_array().unwrap().clone();
    assert_eq!(older.len(), 5);
    assert!(
        older
            .iter()
            .all(|message| message["messageId"] != newest["messageId"])
    );
    harness.shutdown().await;
}

/// Holds the store's one worker until the returned sender is dropped or sent to (at most 10 s).
async fn stall_the_store(harness: &Harness) -> std::sync::mpsc::Sender<()> {
    let (release, held) = std::sync::mpsc::channel::<()>();
    let (started, running) = tokio::sync::oneshot::channel();
    let database = harness.repositories.database().clone();
    tokio::spawn(async move {
        database
            .call(move |_| {
                let _ = started.send(());
                let _ = held.recv_timeout(Duration::from_secs(10));
                Ok(())
            })
            .await
    });
    running.await.expect("the stall runs");
    release
}

/// The wait's deadline, its cancellation and the off switch hold while a read of the store is
/// still pending, including the first one.
#[tokio::test]
async fn a_stalled_store_never_holds_a_wait_past_its_deadline_or_a_stop() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, message_id) = start(&harness, &agent, basic_start()).await;
    let wait = |timeout_ms: u64, cancellation: CancellationToken| {
        let control = harness.control.clone();
        let agent = agent.clone();
        let mut arguments = Map::new();
        arguments.insert("threadId".into(), json!(thread_id));
        arguments.insert("messageId".into(), json!(message_id));
        arguments.insert("timeoutMs".into(), json!(timeout_ms));
        tokio::spawn(async move {
            control
                .call(&agent, "wait_for_thread", &arguments, None, cancellation)
                .await
        })
    };
    let in_time = Duration::from_secs(3);

    // The deadline.
    let release = stall_the_store(&harness).await;
    let started = std::time::Instant::now();
    let waited = tokio::time::timeout(in_time, wait(300, CancellationToken::new()))
        .await
        .expect("the wait ends at its deadline")
        .unwrap();
    assert!(started.elapsed() < in_time);
    assert_eq!(error_tag(&waited), "McpStorageError", "{waited}");
    drop(release);

    // A cancelled call.
    let release = stall_the_store(&harness).await;
    let cancellation = CancellationToken::new();
    let waiter = wait(20_000, cancellation.clone());
    tokio::time::sleep(Duration::from_millis(100)).await;
    cancellation.cancel();
    let waited = tokio::time::timeout(in_time, waiter)
        .await
        .expect("a cancelled wait ends")
        .unwrap();
    assert_eq!(error_tag(&waited), "McpCancelledError");
    drop(release);

    // The off switch, while a later read stalls: the first read saw a running turn.
    harness
        .provider_turn(&thread_id, "turn-1", "partial", false)
        .await;
    let waiter = wait(20_000, CancellationToken::new());
    tokio::time::sleep(Duration::from_millis(200)).await;
    // An event makes the wait read again 100 ms later; the store stalls before then.
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.message.assistant.delta", "commandId": "delta-more",
            "threadId": thread_id, "messageId": "reply-turn-1", "delta": " more",
            "turnId": "turn-1", "createdAt": CREATED_AT,
        })))
        .await
        .expect("provider event");
    let release = stall_the_store(&harness).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    harness.settings.send_replace(McpServerSettings {
        enabled: false,
        access: McpAccess::FullAccess,
    });
    let waited = tokio::time::timeout(in_time, waiter)
        .await
        .expect("turning the server off ends the wait")
        .unwrap();
    assert_eq!(error_tag(&waited), "McpServerDisabledError");
    drop(release);
    harness.shutdown().await;
}

/// A page cut to fit the 80 000-character cap names, as its cursor, the oldest message it
/// returns, so following `nextCursor` reads every message.
#[tokio::test]
async fn a_page_cut_to_fit_continues_from_the_oldest_message_it_returns() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, prompt_id) = start(&harness, &agent, basic_start()).await;
    let thread = thread_id.clone();
    harness
        .repositories
        .database()
        .call(move |connection| {
            for index in 0..5 {
                let at = format!("2099-10-30T01:00:0{index}.000Z");
                connection.execute(
                    "INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES (?, ?, NULL, 'assistant', ?, 0, ?, ?)",
                    rusqlite::params![format!("long-{index}"), thread, "y".repeat(16_000), at, at],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let mut seen = Vec::new();
    let mut cursor = Value::Null;
    let mut pages = 0;
    loop {
        let read = harness
            .call(
                &agent,
                "read_thread",
                json!({ "threadId": thread_id, "cursor": cursor }),
            )
            .await;
        assert!(
            read["content"][0]["text"].as_str().unwrap().chars().count()
                <= crate::mcp::protocol::MAX_RESULT_CHARS
        );
        let read = structured(&read).clone();
        let messages = read["messages"].as_array().unwrap();
        assert!(!messages.is_empty(), "{read}");
        // Newest last, and every page older than the one before it.
        let ids: Vec<String> = messages
            .iter()
            .map(|message| message["messageId"].as_str().unwrap().to_owned())
            .collect();
        seen.splice(0..0, ids);
        pages += 1;
        if read["nextCursor"].is_null() {
            break;
        }
        cursor = read["nextCursor"].clone();
        assert!(pages < 10, "the cursor moves");
    }
    assert!(pages > 1, "the first page was cut");
    let mut expected = vec![prompt_id];
    expected.extend((0..5).map(|index| format!("long-{index}")));
    assert_eq!(seen, expected);
    harness.shutdown().await;
}

/// The same for the thread list: a page cut to fit continues after the last thread it
/// returns.
#[tokio::test]
async fn a_thread_list_cut_to_fit_continues_after_the_last_thread_it_returns() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    for index in 0..60 {
        harness
            .engine
            .dispatch(command(json!({
                "type": "thread.create", "commandId": format!("create-{index}"),
                "threadId": format!("wide-{index:02}"), "projectId": "p1",
                "title": format!("{index:02} {}", "t".repeat(2_000)),
                "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
                "runtimeMode": "approval-required", "interactionMode": "default", "branch": null,
                "worktreePath": null, "createdAt": CREATED_AT,
            })))
            .await
            .expect("thread created");
    }
    let mut seen = Vec::new();
    let mut cursor = Value::Null;
    let mut pages = 0;
    let total = loop {
        let listed = harness
            .call(
                &agent,
                "list_projects_and_threads",
                json!({ "limit": 200, "cursor": cursor }),
            )
            .await;
        let listed = structured(&listed).clone();
        seen.extend(
            listed["threads"]
                .as_array()
                .unwrap()
                .iter()
                .map(|thread| thread["threadId"].as_str().unwrap().to_owned()),
        );
        pages += 1;
        if listed["nextCursor"].is_null() {
            break listed["threadCount"].as_u64().unwrap();
        }
        cursor = listed["nextCursor"].clone();
        assert!(pages < 10, "the cursor moves");
    };
    assert!(pages > 1, "the first page was cut");
    assert_eq!(seen.len() as u64, total);
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len() as u64, total, "no thread is returned twice");
    assert!((0..60).all(|index| seen.contains(&format!("wide-{index:02}"))));
    harness.shutdown().await;
}

#[derive(Clone, Default)]
struct CapturedLog(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Logs carry tool names, ids and outcomes, never prompts or replies. In a process of its own,
/// so no sibling test can turn a callsite off for this capture.
#[tokio::test]
async fn the_log_never_sees_a_prompt_or_a_reply() {
    let Some(child) = crate::test_support::in_own_process(
        "production::mcp_tools_tests::the_log_never_sees_a_prompt_or_a_reply",
    ) else {
        return;
    };
    let log = CapturedLog::default();
    let _logging = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer({
                let log = log.clone();
                move || log.clone()
            })
            .finish(),
    );
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["prompt"] = json!("PROMPT-CANARY-31337");
    let (thread_id, message_id) = start(&harness, &agent, arguments).await;
    harness
        .provider_turn(&thread_id, "turn-1", "REPLY-CANARY-31337", true)
        .await;
    structured(
        &harness
            .call(
                &agent,
                "wait_for_thread",
                json!({ "threadId": thread_id, "messageId": message_id }),
            )
            .await,
    );
    // A refused call is logged at the boundary too.
    harness
        .call(
            &agent,
            "send_message",
            json!({ "threadId": thread_id, "text": "TEXT-CANARY-31337", "mode": "sideways" }),
        )
        .await;
    harness.shutdown().await;
    let log = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(!log.is_empty(), "the capture saw the run");
    for canary in ["PROMPT-CANARY", "REPLY-CANARY", "TEXT-CANARY"] {
        assert!(!log.contains(canary), "{canary} reached the log:\n{log}");
    }
    child.complete();
}
