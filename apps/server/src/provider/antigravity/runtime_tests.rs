//! Fixture-peer tests: the runtime talks to a scripted ACP agent over in-memory pipes. The
//! shapes follow `agy` 1.5.13 as measured on 2026-11-20, with placeholder ids, models and paths.

use super::*;
use crate::provider::antigravity::{AcpConnectionConfig, AcpJsonRpcConnection};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, duplex};
use tokio::task::JoinHandle;
use tokio::time::{Duration, timeout};

const SESSION: &str = "session-a";
const SAVED: &str = "saved-session";
const CWD: &str = "/workspace/checkout";
const MARKER: &str = "SYNTHETIC-SECRET-7f3a";

struct Peer {
    requests: Lines<BufReader<DuplexStream>>,
    output: DuplexStream,
    stderr: DuplexStream,
}

impl Peer {
    async fn next(&mut self) -> Value {
        let line = timeout(Duration::from_secs(5), self.requests.next_line())
            .await
            .expect("the client wrote nothing in time")
            .expect("peer read")
            .expect("client stream open");
        serde_json::from_str(&line).expect("the client writes JSON")
    }

    async fn expect(&mut self, method: &str) -> Value {
        let message = self.next().await;
        assert_eq!(message["method"], method, "{message}");
        message
    }

    async fn send(&mut self, message: Value) {
        let mut line = message.to_string();
        line.push('\n');
        self.output
            .write_all(line.as_bytes())
            .await
            .expect("peer write");
    }

    async fn reply(&mut self, request: &Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": request["id"], "result": result }))
            .await;
    }

    async fn fail(&mut self, request: &Value, code: i64, message: &str) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": { "code": code, "message": message },
        }))
        .await;
    }

    async fn update(&mut self, session: &str, update: Value) {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": session, "update": update },
        }))
        .await;
    }

    async fn permission(&mut self, options: Value) {
        self.permission_as(json!("1"), SESSION, "edit", options)
            .await;
    }

    async fn permission_as(&mut self, id: Value, session: &str, kind: &str, options: Value) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/request_permission",
            "params": {
                "sessionId": session,
                "toolCall": {
                    "toolCallId": "call-1",
                    "status": "pending",
                    "kind": kind,
                    "title": "File notes.txt",
                    "_meta": { "marker": MARKER },
                },
                "options": options,
            },
        }))
        .await;
    }

    async fn silent(&mut self) -> bool {
        timeout(Duration::from_millis(200), self.requests.next_line())
            .await
            .is_err()
    }
}

fn allow_or_deny() -> Value {
    json!([
        { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
        { "optionId": "deny", "name": "Deny", "kind": "reject_once" },
    ])
}

fn options(runtime_mode: &str) -> AntigravitySessionOptions {
    AntigravitySessionOptions {
        thread_id: "thread-a".to_owned(),
        cwd: CWD.to_owned(),
        runtime_mode: runtime_mode.to_owned(),
        interaction_mode: "default".to_owned(),
        model: None,
        resume_session_id: None,
        cancel_grace: Duration::from_secs(5),
        start_timeout: Duration::from_secs(3),
        control_timeout: Duration::from_secs(3),
        initial_options: Vec::new(),
    }
}

fn connect(options: AntigravitySessionOptions) -> (AntigravitySessionRuntime, Peer) {
    let (stdout, output) = duplex(1 << 16);
    let (requests, stdin) = duplex(1 << 16);
    let (stderr_reader, stderr) = duplex(4096);
    let (connection, incoming) =
        AcpJsonRpcConnection::spawn(stdout, stdin, stderr_reader, AcpConnectionConfig::default());
    (
        AntigravitySessionRuntime::new(options, connection, incoming),
        Peer {
            requests: BufReader::new(requests).lines(),
            output,
            stderr,
        },
    )
}

fn spawn_start(
    runtime: &AntigravitySessionRuntime,
) -> JoinHandle<Result<String, AntigravityRuntimeError>> {
    let runtime = runtime.clone();
    tokio::spawn(async move { runtime.start().await })
}

/// A start that ends in time; a hang fails the test instead of stalling the run.
async fn finish(
    start: JoinHandle<Result<String, AntigravityRuntimeError>>,
) -> Result<String, AntigravityRuntimeError> {
    timeout(Duration::from_secs(5), start)
        .await
        .expect("start ended in time")
        .expect("start task")
}

fn initialize_result(version: &str, protocol: u64, capabilities: Value) -> Value {
    json!({
        "protocolVersion": protocol,
        "agentCapabilities": capabilities,
        "agentInfo": { "name": "Antigravity ACP Server", "version": version },
        "authMethods": [{ "id": "oauth-personal", "name": "Log in" }],
    })
}

fn all_capabilities() -> Value {
    json!({
        "loadSession": true,
        "load_session": true,
        "sessionCapabilities": { "resume": {}, "close": {}, "load": {}, "list": {} },
        "session_capabilities": { "resume": {}, "close": {}, "load": {}, "list": {} },
        "_meta": { "antigravity": { "tier": MARKER } },
    })
}

fn config_options(model: &str, levels: &[&str], level: &str, mode: &str, modes: &[&str]) -> Value {
    json!([
        {
            "id": "model", "name": "Model", "category": "model", "type": "select",
            "currentValue": model,
            "options": [
                { "value": "test-model-a", "name": "Test Model A" },
                { "value": "test-model-b", "name": "Test Model B" },
            ],
        },
        {
            "id": "thought_level", "name": "Thinking Level", "category": "thought_level",
            "type": "select", "currentValue": level,
            "options": levels.iter().map(|level| json!({ "value": level, "name": level })).collect::<Vec<_>>(),
        },
        {
            "id": "mode", "name": "Mode", "category": "mode", "type": "select",
            "currentValue": mode,
            "options": modes.iter().map(|mode| json!({ "value": mode, "name": mode })).collect::<Vec<_>>(),
        },
    ])
}

const ALL_MODES: &[&str] = &["default", "accept-edits", "auto", "plan"];

fn standard_options(mode: &str) -> Value {
    config_options(
        "test-model-a",
        &["low", "medium", "high"],
        "high",
        mode,
        ALL_MODES,
    )
}

fn session_result(session: &str, config: Value) -> Value {
    json!({
        "sessionId": session,
        "models": {
            "availableModels": [{ "modelId": "test-model-a-high", "name": "Test Model A (High)" }],
            "currentModelId": "test-model-a-high",
        },
        "modes": { "currentModeId": "default", "availableModes": [{ "id": "default" }] },
        "configOptions": config,
        "_meta": { "antigravity": { "tier": { "name": MARKER } } },
    })
}

async fn answer_mode(peer: &mut Peer, expected: &str) {
    let request = peer.expect("session/set_config_option").await;
    assert_eq!(request["params"]["sessionId"], SESSION);
    assert_eq!(request["params"]["configId"], "mode");
    assert_eq!(request["params"]["value"], expected);
    peer.reply(
        &request,
        json!({ "configOptions": standard_options(expected) }),
    )
    .await;
}

/// A started runtime whose peer advertised every capability and acknowledged `mode`.
async fn started_with(
    options: AntigravitySessionOptions,
    mode: &str,
) -> (AntigravitySessionRuntime, Peer) {
    let (runtime, mut peer) = connect(options);
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let new = peer.expect("session/new").await;
    peer.reply(&new, session_result(SESSION, standard_options("default")))
        .await;
    answer_mode(&mut peer, mode).await;
    assert_eq!(finish(start).await.expect("start"), SESSION);
    (runtime, peer)
}

async fn started(runtime_mode: &str, mode: &str) -> (AntigravitySessionRuntime, Peer) {
    started_with(options(runtime_mode), mode).await
}

async fn next_event(runtime: &AntigravitySessionRuntime) -> AntigravityRuntimeEvent {
    timeout(Duration::from_secs(5), runtime.next_event())
        .await
        .expect("an event in time")
        .expect("event stream open")
}

/// Events up to and including the first of type `last`, without the session lifecycle ones.
async fn events_until(runtime: &AntigravitySessionRuntime, last: &str) -> Vec<(String, Value)> {
    let mut events = Vec::new();
    loop {
        let event = next_event(runtime).await;
        if matches!(
            event.event_type.as_str(),
            "session.started" | "thread.started"
        ) {
            continue;
        }
        let done = event.event_type == last;
        events.push((event.event_type, event.payload));
        if done {
            return events;
        }
    }
}

fn types(events: &[(String, Value)]) -> Vec<&str> {
    events.iter().map(|(kind, _)| kind.as_str()).collect()
}

async fn begin_turn(
    runtime: &AntigravitySessionRuntime,
    peer: &mut Peer,
) -> (AntigravityPromptReceipt, Value) {
    let receipt = runtime
        .send_turn_with_receipt(Some("hello"), Vec::new())
        .await
        .expect("prompt written");
    let prompt = peer.expect("session/prompt").await;
    assert_eq!(prompt["params"]["sessionId"], SESSION);
    (receipt, prompt)
}

async fn opened_request_id(runtime: &AntigravitySessionRuntime) -> String {
    loop {
        let event = next_event(runtime).await;
        if event.event_type == "request.opened" {
            return event.request_id.expect("an opened request has an id");
        }
    }
}

#[tokio::test]
async fn the_handshake_speaks_protocol_one_and_never_authenticates() {
    let (runtime, mut peer) = connect(options("full-access"));
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    assert_eq!(initialize["params"]["protocolVersion"], 1);
    assert_eq!(
        initialize["params"]["clientCapabilities"]["terminal"],
        false
    );
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    // The next request opens the session: no `authenticate` in between.
    let new = peer.expect("session/new").await;
    assert_eq!(
        new["params"],
        json!({ "cwd": CWD, "mcpServers": [] }),
        "a new session carries the checkout and no MCP servers"
    );
    peer.reply(&new, session_result(SESSION, standard_options("default")))
        .await;
    answer_mode(&mut peer, "auto").await;
    assert_eq!(finish(start).await.unwrap(), SESSION);
    assert!(peer.silent().await);
}

#[tokio::test]
async fn a_silent_peer_cannot_stall_the_start() {
    let mut options = options("full-access");
    options.start_timeout = Duration::from_millis(100);
    let (runtime, mut peer) = connect(options.clone());
    let start = spawn_start(&runtime);
    peer.expect("initialize").await;
    let error = finish(start).await.expect_err("an unanswered initialize");
    assert!(
        matches!(error, AntigravityRuntimeError::StartTimedOut),
        "{error:?}"
    );

    // The deadline covers the whole start, the session open included.
    let (runtime, mut peer) = connect(options);
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    peer.expect("session/new").await;
    let error = finish(start).await.expect_err("an unanswered session/new");
    assert!(
        matches!(error, AntigravityRuntimeError::StartTimedOut),
        "{error:?}"
    );
}

#[tokio::test]
async fn another_protocol_version_is_refused_before_a_session_opens() {
    let (runtime, mut peer) = connect(options("full-access"));
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 2, all_capabilities()),
    )
    .await;
    let error = finish(start).await.expect_err("protocol 2 is refused");
    assert!(
        matches!(error, AntigravityRuntimeError::UnsupportedVersion { .. }),
        "{error:?}"
    );
    assert!(error.to_string().contains("1.5.4"), "{error}");
    assert!(
        peer.silent().await,
        "no session opens on a refused handshake"
    );
}

#[tokio::test]
async fn the_cli_version_from_initialize_gates_the_chat_at_1_5_4() {
    let (runtime, mut peer) = connect(options("full-access"));
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.3", 1, all_capabilities()),
    )
    .await;
    let error = finish(start).await.expect_err("1.5.3 is refused");
    let message = error.to_string();
    assert!(
        message.contains("1.5.4")
            && message.contains("1.5.3")
            && message.contains("agy update")
            && message.contains("Antigravity Terminal still works"),
        "{message}"
    );
    assert!(peer.silent().await);

    // A version that cannot be established is refused too, naming the minimum.
    for version in [Some("unknown"), None] {
        let (runtime, mut peer) = connect(options("full-access"));
        let start = spawn_start(&runtime);
        let initialize = peer.expect("initialize").await;
        let mut result = initialize_result("1.5.13", 1, all_capabilities());
        match version {
            Some(version) => result["agentInfo"]["version"] = json!(version),
            None => {
                result["agentInfo"]
                    .as_object_mut()
                    .unwrap()
                    .remove("version");
            }
        }
        peer.reply(&initialize, result).await;
        let error = finish(start)
            .await
            .expect_err("an unverified version is refused");
        assert!(
            matches!(
                error,
                AntigravityRuntimeError::UnsupportedVersion { version: None }
            ),
            "{error:?}"
        );
        assert!(error.to_string().contains("1.5.4"), "{error}");
        assert!(peer.silent().await, "{version:?} opens no session");
    }

    for version in ["1.5.4", "1.6.0-preview"] {
        let (runtime, mut peer) = connect(options("full-access"));
        let _start = spawn_start(&runtime);
        let initialize = peer.expect("initialize").await;
        peer.reply(
            &initialize,
            initialize_result(version, 1, all_capabilities()),
        )
        .await;
        peer.expect("session/new").await;
    }
}

#[tokio::test]
async fn a_cli_without_a_working_acp_gets_the_version_message() {
    let (runtime, mut peer) = connect(options("full-access"));
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.fail(&initialize, -32601, "Method not found: initialize")
        .await;
    let error = finish(start).await.expect_err("no acp");
    assert!(
        matches!(
            error,
            AntigravityRuntimeError::UnsupportedVersion { version: None }
        ),
        "{error:?}"
    );

    let (runtime, mut peer) = connect(options("full-access"));
    let start = spawn_start(&runtime);
    peer.expect("initialize").await;
    drop(peer);
    let error = finish(start).await.expect_err("the child exited");
    assert!(
        matches!(
            error,
            AntigravityRuntimeError::UnsupportedVersion { version: None }
        ),
        "{error:?}"
    );
}

#[tokio::test]
async fn a_signed_out_cli_gets_the_sign_in_steps_and_other_server_errors_pass_through() {
    let (runtime, mut peer) = connect(options("full-access"));
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let new = peer.expect("session/new").await;
    peer.fail(&new, -32000, "Authentication required").await;
    let error = finish(start).await.expect_err("signed out");
    assert!(
        matches!(error, AntigravityRuntimeError::SignInRequired),
        "{error:?}"
    );
    assert!(error.to_string().contains("agy acp --login"), "{error}");

    let (runtime, mut peer) = connect(options("full-access"));
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let new = peer.expect("session/new").await;
    peer.fail(&new, -32000, "Quota exhausted").await;
    let error = finish(start).await.expect_err("a server error");
    assert!(
        matches!(error, AntigravityRuntimeError::Protocol(_)),
        "{error:?}"
    );
}

#[tokio::test]
async fn resume_reopens_the_saved_session_and_reapplies_model_thinking_level_and_mode() {
    let mut options = options("approval-required");
    options.resume_session_id = Some(SAVED.to_owned());
    options.model = Some("test-model-b".to_owned());
    let (runtime, mut peer) = connect(options);
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let resume = peer.expect("session/resume").await;
    assert_eq!(
        resume["params"],
        json!({ "sessionId": SAVED, "cwd": CWD, "mcpServers": [] })
    );
    // Measured: a resumed session is back at the CLI's default model and thinking level.
    peer.reply(&resume, session_result(SAVED, standard_options("default")))
        .await;
    let model = peer.expect("session/set_config_option").await;
    assert_eq!(
        model["params"],
        json!({ "sessionId": SAVED, "configId": "model", "value": "test-model-b" })
    );
    // The thinking levels depend on the model: this one offers `max` and no `medium`.
    let levels_of_b = config_options("test-model-b", &["low", "max"], "low", "default", ALL_MODES);
    peer.reply(&model, json!({ "configOptions": levels_of_b.clone() }))
        .await;
    let mode = peer.expect("session/set_config_option").await;
    assert_eq!(mode["params"]["configId"], "mode");
    assert_eq!(mode["params"]["value"], "default");
    peer.reply(&mode, json!({ "configOptions": levels_of_b.clone() }))
        .await;
    assert_eq!(finish(start).await.unwrap(), SAVED);

    let refused = runtime
        .set_options(vec![json!({ "id": "reasoning", "value": "medium" })])
        .await
        .expect_err("model B does not offer medium");
    assert!(
        refused.refused_option().is_some(),
        "an unadvertised level is a permanent refusal: {refused:?}"
    );
    assert!(peer.silent().await, "a refused level writes nothing");

    let set = tokio::spawn({
        let runtime = runtime.clone();
        async move {
            runtime
                .set_options(vec![json!({ "id": "reasoning", "value": "max" })])
                .await
        }
    });
    let level = peer.expect("session/set_config_option").await;
    assert_eq!(
        level["params"],
        json!({ "sessionId": SAVED, "configId": "thought_level", "value": "max" })
    );
    peer.reply(&level, json!({ "configOptions": levels_of_b }))
        .await;
    set.await.unwrap().expect("level applied");
}

#[tokio::test]
async fn load_replays_are_dropped_and_so_are_updates_for_another_session() {
    let mut options = options("full-access");
    options.resume_session_id = Some(SESSION.to_owned());
    let (runtime, mut peer) = connect(options);
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, json!({ "loadSession": true })),
    )
    .await;
    let load = peer.expect("session/load").await;
    assert_eq!(
        load["params"],
        json!({ "sessionId": SESSION, "cwd": CWD, "mcpServers": [] })
    );
    peer.update(
        SESSION,
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "replayed" } }),
    )
    .await;
    peer.reply(&load, session_result(SESSION, standard_options("default")))
        .await;
    answer_mode(&mut peer, "auto").await;
    assert_eq!(finish(start).await.unwrap(), SESSION);

    let (_receipt, prompt) = begin_turn(&runtime, &mut peer).await;
    peer.update(
        "other-session",
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "stale" } }),
    )
    .await;
    peer.update(
        SESSION,
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "live" } }),
    )
    .await;
    peer.reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    let events = events_until(&runtime, "turn.completed").await;
    let deltas = events
        .iter()
        .filter(|(kind, _)| kind == "content.delta")
        .map(|(_, payload)| payload["delta"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    assert_eq!(deltas, ["live"]);
}

#[tokio::test]
async fn without_resume_or_load_a_saved_session_starts_a_new_one() {
    let mut options = options("full-access");
    options.resume_session_id = Some(SAVED.to_owned());
    let (runtime, mut peer) = connect(options);
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(&initialize, initialize_result("1.5.13", 1, json!({})))
        .await;
    let new = peer.expect("session/new").await;
    peer.reply(&new, session_result(SESSION, standard_options("default")))
        .await;
    answer_mode(&mut peer, "auto").await;
    assert_eq!(finish(start).await.unwrap(), SESSION);
}

#[tokio::test]
async fn only_a_missing_session_answer_starts_a_new_session() {
    let mut resuming = options("full-access");
    resuming.resume_session_id = Some(SAVED.to_owned());

    let (runtime, mut peer) = connect(resuming.clone());
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let resume = peer.expect("session/resume").await;
    peer.fail(
        &resume,
        -32603,
        "Failed to read session saved-session; retry, or load it with session/load",
    )
    .await;
    let new = peer.expect("session/new").await;
    peer.reply(&new, session_result(SESSION, standard_options("default")))
        .await;
    answer_mode(&mut peer, "auto").await;
    assert_eq!(finish(start).await.unwrap(), SESSION);

    for (code, message) in [
        (-32603, "Internal error"),
        (-32000, "Authentication required"),
    ] {
        let (runtime, mut peer) = connect(resuming.clone());
        let start = spawn_start(&runtime);
        let initialize = peer.expect("initialize").await;
        peer.reply(
            &initialize,
            initialize_result("1.5.13", 1, all_capabilities()),
        )
        .await;
        let resume = peer.expect("session/resume").await;
        peer.fail(&resume, code, message).await;
        assert!(finish(start).await.is_err(), "{message} keeps the saved id");
        assert!(peer.silent().await, "{message} opens no new session");
    }
}

#[tokio::test]
async fn approval_required_refuses_to_start_without_an_acknowledged_default_mode() {
    // `default` is not advertised: no write is tried.
    let (runtime, mut peer) = connect(options("approval-required"));
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let new = peer.expect("session/new").await;
    let without_default = config_options(
        "test-model-a",
        &["low"],
        "low",
        "auto",
        &["accept-edits", "auto", "plan"],
    );
    peer.reply(&new, session_result(SESSION, without_default))
        .await;
    let error = finish(start).await.expect_err("no default mode");
    assert!(
        matches!(error, AntigravityRuntimeError::ModeUnavailable { .. }),
        "{error:?}"
    );
    assert!(peer.silent().await);

    // `default` is rejected, or acknowledged as another mode.
    for acknowledgement in [None, Some("auto")] {
        let (runtime, mut peer) = connect(options("approval-required"));
        let start = spawn_start(&runtime);
        let initialize = peer.expect("initialize").await;
        peer.reply(
            &initialize,
            initialize_result("1.5.13", 1, all_capabilities()),
        )
        .await;
        let new = peer.expect("session/new").await;
        peer.reply(&new, session_result(SESSION, standard_options("auto")))
            .await;
        let mode = peer.expect("session/set_config_option").await;
        match acknowledgement {
            None => peer.fail(&mode, -32602, "Unknown mode: default").await,
            Some(other) => {
                peer.reply(&mode, json!({ "configOptions": standard_options(other) }))
                    .await;
            }
        }
        let error = finish(start).await.expect_err("unacknowledged default");
        assert!(
            matches!(error, AntigravityRuntimeError::ModeUnavailable { .. }),
            "{error:?}"
        );
        assert!(peer.silent().await, "no prompt follows a refused start");
    }
}

#[tokio::test]
async fn modes_follow_the_runtime_and_interaction_mode() {
    started("full-access", "auto").await;
    started("auto-accept-edits", "accept-edits").await;
    started("approval-required", "default").await;
    let mut planning = options("approval-required");
    planning.interaction_mode = "plan".to_owned();
    started_with(planning, "plan").await;
}

#[tokio::test]
async fn without_a_model_config_option_the_suffixed_model_id_goes_to_set_model() {
    let mut options = options("full-access");
    options.model = Some("test-model-a-high".to_owned());
    let (runtime, mut peer) = connect(options);
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let new = peer.expect("session/new").await;
    let only_modes = json!([standard_options("default")[2].clone()]);
    peer.reply(&new, session_result(SESSION, only_modes)).await;
    let model = peer.expect("session/set_model").await;
    assert_eq!(
        model["params"],
        json!({ "sessionId": SESSION, "modelId": "test-model-a-high" })
    );
    peer.reply(&model, json!({})).await;
    answer_mode(&mut peer, "auto").await;
    assert_eq!(finish(start).await.unwrap(), SESSION);
}

#[tokio::test]
async fn a_scripted_turn_projects_text_tool_activity_and_one_approval() {
    let (runtime, mut peer) = started("approval-required", "default").await;
    let (receipt, prompt) = begin_turn(&runtime, &mut peer).await;
    let tool = |status: &str| {
        json!({
            "sessionUpdate": if status == "in_progress" { "tool_call" } else { "tool_call_update" },
            "toolCallId": "call-1",
            "status": status,
            "kind": "edit",
            "title": "File notes.txt",
            "locations": [{ "path": "/workspace/checkout/notes.txt" }],
            "rawInput": { "Path": "/workspace/checkout/notes.txt" },
            "name": "write_file",
            "args": { "Content": MARKER },
            "_meta": { "marker": MARKER },
        })
    };
    peer.update(SESSION, tool("in_progress")).await;
    peer.update(SESSION, tool("pending")).await;
    peer.permission(allow_or_deny()).await;
    let mut events = events_until(&runtime, "request.opened").await;
    assert_eq!(
        events.last().unwrap().1["requestType"],
        "file_change_approval"
    );
    assert_eq!(events.last().unwrap().1["detail"], "File notes.txt");
    let request_id = runtime
        .pending_request_ids()
        .await
        .pop()
        .expect("one pending approval");
    runtime
        .respond_to_request(&request_id, "accept")
        .await
        .expect("answer forwarded");
    let answer = peer.next().await;
    assert_eq!(
        answer["id"],
        json!("1"),
        "the string id comes back as a string"
    );
    assert_eq!(
        answer["result"],
        json!({ "outcome": { "outcome": "selected", "optionId": "allow" } })
    );
    peer.update(SESSION, tool("completed")).await;
    peer.update(
        SESSION,
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "done" } }),
    )
    .await;
    peer.update(
        SESSION,
        json!({ "sessionUpdate": "usage_update", "used": 1, "size": 2 }),
    )
    .await;
    peer.reply(
        &prompt,
        json!({ "stopReason": "end_turn", "usage": { "totalTokens": 3 } }),
    )
    .await;
    events.extend(events_until(&runtime, "turn.completed").await);
    assert_eq!(
        types(&events),
        [
            "turn.started",
            "item.updated",
            "item.updated",
            "request.opened",
            "request.resolved",
            "item.completed",
            "content.delta",
            "thread.token-usage.updated",
            "turn.completed",
        ]
    );
    assert_eq!(
        events[7].1,
        json!({ "usage": { "usedTokens": 1, "maxTokens": 2 } }),
        "usage_update feeds the context window meter"
    );
    assert_eq!(
        events[4].1["requestType"], "file_change_approval",
        "the resolved event names the kind the opened one did"
    );
    assert_eq!(events[1].1["itemType"], "file_change");
    assert_eq!(events[1].1["itemId"], "call-1");
    assert_eq!(events[1].1["detail"], "File notes.txt");
    assert_eq!(events[5].1["status"], "completed");
    assert_eq!(events[6].1["delta"], "done");
    assert_eq!(events[8].1["state"], "completed");
    for (_, payload) in &events {
        assert!(!payload.to_string().contains(MARKER), "{payload}");
    }
    timeout(Duration::from_secs(2), receipt.completion())
        .await
        .unwrap()
        .expect("accepted");
}

#[tokio::test]
async fn full_access_answers_with_allow_once_even_when_allow_always_is_offered() {
    let (runtime, mut peer) = started("full-access", "auto").await;
    let (_receipt, _prompt) = begin_turn(&runtime, &mut peer).await;
    peer.permission(json!([
        { "optionId": "always", "kind": "allow_always" },
        { "optionId": "once", "kind": "allow_once" },
        { "optionId": "deny", "kind": "reject_once" },
    ]))
    .await;
    let answer = peer.next().await;
    assert_eq!(answer["id"], json!("1"));
    assert_eq!(answer["result"]["outcome"]["optionId"], "once");
}

#[tokio::test]
async fn outside_full_access_bibcode_never_answers_a_permission_request() {
    let mut planning = options("approval-required");
    planning.interaction_mode = "plan".to_owned();
    for (options, mode) in [
        (options("auto-accept-edits"), "accept-edits"),
        (planning, "plan"),
    ] {
        let (runtime, mut peer) = started_with(options, mode).await;
        let (_receipt, _prompt) = begin_turn(&runtime, &mut peer).await;
        peer.permission(allow_or_deny()).await;
        opened_request_id(&runtime).await;
        assert!(peer.silent().await, "{mode} leaves the answer to the user");
    }
}

#[tokio::test]
async fn a_switch_to_approval_required_stops_auto_answers_before_the_cli_acknowledges() {
    let (runtime, mut peer) = started("full-access", "auto").await;
    let switch = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.set_runtime_mode("approval-required").await }
    });
    let mode = peer.expect("session/set_config_option").await;
    assert_eq!(mode["params"]["value"], "default");
    peer.fail(&mode, -32603, "Internal error").await;
    assert!(switch.await.unwrap().is_err());

    // The CLI may still run in `auto`, so the next prompt first writes the mode again, and is
    // refused if that fails too.
    let send = || {
        let runtime = runtime.clone();
        tokio::spawn(async move {
            runtime
                .send_turn_with_receipt(Some("hello"), Vec::new())
                .await
        })
    };
    let refused = send();
    let retry = peer.expect("session/set_config_option").await;
    assert_eq!(retry["params"]["value"], "default");
    peer.fail(&retry, -32603, "Internal error").await;
    assert!(refused.await.unwrap().is_err());
    assert!(
        peer.silent().await,
        "no prompt while the mode is unconfirmed"
    );

    let accepted = send();
    let retry = peer.expect("session/set_config_option").await;
    assert_eq!(retry["params"]["value"], "default");
    peer.reply(
        &retry,
        json!({ "configOptions": standard_options("default") }),
    )
    .await;
    let _receipt = accepted
        .await
        .unwrap()
        .expect("prompt written once confirmed");
    peer.expect("session/prompt").await;
    peer.permission(allow_or_deny()).await;
    opened_request_id(&runtime).await;
    assert!(peer.silent().await, "no auto answer after the switch");
}

#[tokio::test]
async fn cancel_answers_pending_approvals_and_drops_a_later_answer() {
    let (runtime, mut peer) = started("approval-required", "default").await;
    let (_receipt, prompt) = begin_turn(&runtime, &mut peer).await;
    peer.permission(allow_or_deny()).await;
    let request_id = opened_request_id(&runtime).await;
    runtime.interrupt_turn().await.expect("cancel sent");
    let answer = peer.next().await;
    assert_eq!(answer["id"], json!("1"));
    assert_eq!(
        answer["result"],
        json!({ "outcome": { "outcome": "cancelled" } })
    );
    let cancel = peer.expect("session/cancel").await;
    assert_eq!(cancel["params"]["sessionId"], SESSION);
    assert!(cancel.get("id").is_none(), "cancel is a notification");
    let stale = runtime
        .respond_to_request(&request_id, "accept")
        .await
        .expect_err("the approval was dropped on cancel");
    assert!(
        matches!(
            stale,
            AntigravityRuntimeError::PendingRequestNotFound { .. }
        ),
        "{stale:?}"
    );
    assert!(peer.silent().await, "a stale answer writes nothing");
    // Measured: the CLI ends the prompt with `cancelled` at once.
    peer.reply(&prompt, json!({ "stopReason": "cancelled" }))
        .await;
    let events = events_until(&runtime, "turn.completed").await;
    assert_eq!(events.last().unwrap().1["state"], "cancelled");
}

#[tokio::test]
async fn an_unanswered_cancel_ends_the_turn_and_abandons_the_process() {
    let mut options = options("full-access");
    options.cancel_grace = Duration::from_millis(50);
    let (runtime, mut peer) = started_with(options, "auto").await;
    let (_receipt, prompt) = begin_turn(&runtime, &mut peer).await;
    runtime.interrupt_turn().await.expect("cancel sent");
    peer.expect("session/cancel").await;
    let events = events_until(&runtime, "turn.completed").await;
    assert_eq!(events.last().unwrap().1["state"], "cancelled");
    timeout(Duration::from_secs(2), runtime.abandoned())
        .await
        .expect("the driver is told to stop the process");
    // A late answer does not complete the turn twice.
    peer.reply(&prompt, json!({ "stopReason": "cancelled" }))
        .await;
    assert!(
        timeout(Duration::from_millis(200), runtime.next_event())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn an_answered_cancel_does_not_abandon_the_process() {
    let mut options = options("full-access");
    options.cancel_grace = Duration::from_millis(100);
    let (runtime, mut peer) = started_with(options, "auto").await;
    let (_receipt, prompt) = begin_turn(&runtime, &mut peer).await;
    runtime.interrupt_turn().await.expect("cancel sent");
    peer.expect("session/cancel").await;
    peer.reply(&prompt, json!({ "stopReason": "cancelled" }))
        .await;
    events_until(&runtime, "turn.completed").await;
    assert!(
        timeout(Duration::from_millis(300), runtime.abandoned())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn an_empty_end_turn_completes_with_no_reply() {
    let (runtime, mut peer) = started("full-access", "auto").await;
    let (receipt, prompt) = begin_turn(&runtime, &mut peer).await;
    peer.reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    let events = events_until(&runtime, "turn.completed").await;
    assert_eq!(types(&events), ["turn.started", "turn.completed"]);
    assert_eq!(events[1].1["state"], "completed");
    receipt.completion().await.expect("accepted");
}

#[tokio::test]
async fn secret_markers_stay_out_of_logs() {
    let Some(child) = crate::test_support::in_own_process(
        "provider::antigravity::runtime::tests::secret_markers_stay_out_of_logs",
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
    let mut options = options("full-access");
    options.cancel_grace = Duration::from_millis(50);
    let (runtime, mut peer) = started_with(options, "auto").await;
    peer.stderr
        .write_all(format!("stderr {MARKER}\n").as_bytes())
        .await
        .unwrap();
    peer.send(
        json!({ "jsonrpc": "2.0", "method": format!("x/{MARKER}"), "params": { "text": MARKER } }),
    )
    .await;
    peer.send(
        json!({ "jsonrpc": "2.0", "id": 9, "method": format!("x/ask-{MARKER}"), "params": { "text": MARKER } }),
    )
    .await;
    assert_eq!(peer.next().await["error"]["code"], -32601);
    let set = tokio::spawn({
        let runtime = runtime.clone();
        async move {
            runtime
                .set_options(vec![json!({ "id": "reasoning", "value": MARKER })])
                .await
        }
    });
    assert!(set.await.unwrap().is_err());
    let (_receipt, prompt) = begin_turn(&runtime, &mut peer).await;
    peer.update(
        SESSION,
        json!({ "sessionUpdate": MARKER, "title": MARKER, "_meta": { "x": MARKER } }),
    )
    .await;
    peer.fail(&prompt, -32603, &format!("provider failed {MARKER}"))
        .await;
    events_until(&runtime, "turn.completed").await;
    let (_receipt, _prompt) = begin_turn(&runtime, &mut peer).await;
    runtime.interrupt_turn().await.unwrap();
    runtime.abandoned().await;
    tracing::info!("the capture saw the run");

    let log = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("the capture saw the run"), "{log}");
    assert!(log.contains("antigravity"), "the runtime logged: {log}");
    assert!(!log.contains(MARKER), "a marker reached the log:\n{log}");
    child.complete();
}

#[derive(Clone, Default)]
struct CapturedLog(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn versions_parse_from_the_first_three_part_number() {
    assert_eq!(parse_version("1.5.13"), Some((1, 5, 13)));
    assert_eq!(parse_version("v1.5.4-beta"), Some((1, 5, 4)));
    assert_eq!(parse_version("1.5"), None);
    assert_eq!(parse_version(""), None);
}

async fn expect_refused_permission(peer: &mut Peer, id: Value) {
    let answer = peer.next().await;
    assert_eq!(answer["id"], id, "{answer}");
    assert_eq!(
        answer["result"],
        json!({ "outcome": { "outcome": "cancelled" } }),
        "BiBCode refuses instead of approving: {answer}"
    );
}

async fn spawn_send(
    runtime: &AntigravitySessionRuntime,
) -> JoinHandle<Result<AntigravityPromptReceipt, AntigravityRuntimeError>> {
    let runtime = runtime.clone();
    tokio::spawn(async move {
        runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
    })
}

#[tokio::test]
async fn full_access_answers_only_inside_an_active_turn_of_the_open_session() {
    // During the open, before the session is accepted.
    let mut resuming = options("full-access");
    resuming.resume_session_id = Some(SESSION.to_owned());
    let (runtime, mut peer) = connect(resuming);
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let resume = peer.expect("session/resume").await;
    peer.permission(allow_or_deny()).await;
    expect_refused_permission(&mut peer, json!("1")).await;
    peer.reply(
        &resume,
        session_result(SESSION, standard_options("default")),
    )
    .await;
    answer_mode(&mut peer, "auto").await;
    finish(start).await.expect("start");

    // Between turns.
    peer.permission(allow_or_deny()).await;
    expect_refused_permission(&mut peer, json!("1")).await;

    // For another session, during a turn.
    let (_receipt, prompt) = begin_turn(&runtime, &mut peer).await;
    peer.permission_as(json!("2"), "other-session", "edit", allow_or_deny())
        .await;
    expect_refused_permission(&mut peer, json!("2")).await;

    // After the turn ended.
    peer.reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    events_until(&runtime, "turn.completed").await;
    peer.permission(allow_or_deny()).await;
    expect_refused_permission(&mut peer, json!("1")).await;
}

#[tokio::test]
async fn full_access_refuses_after_a_cancel_even_once_the_turn_was_abandoned() {
    let mut options = options("full-access");
    options.cancel_grace = Duration::from_millis(50);
    let (runtime, mut peer) = started_with(options, "auto").await;
    let (_receipt, _prompt) = begin_turn(&runtime, &mut peer).await;
    runtime.interrupt_turn().await.expect("cancel sent");
    peer.expect("session/cancel").await;
    peer.permission(allow_or_deny()).await;
    expect_refused_permission(&mut peer, json!("1")).await;
    timeout(Duration::from_secs(2), runtime.abandoned())
        .await
        .expect("abandoned");
    peer.permission(allow_or_deny()).await;
    expect_refused_permission(&mut peer, json!("1")).await;
}

#[tokio::test]
async fn plan_mode_or_a_missing_allow_once_leaves_full_access_requests_to_the_user() {
    let mut planning = options("full-access");
    planning.interaction_mode = "plan".to_owned();
    let (runtime, mut peer) = started_with(planning, "plan").await;
    let (_receipt, _prompt) = begin_turn(&runtime, &mut peer).await;
    peer.permission(allow_or_deny()).await;
    opened_request_id(&runtime).await;
    assert!(peer.silent().await, "plan never answers by itself");

    let (runtime, mut peer) = started("full-access", "auto").await;
    let (_receipt, _prompt) = begin_turn(&runtime, &mut peer).await;
    peer.permission(json!([
        { "optionId": "always", "kind": "allow_always" },
        { "optionId": "deny", "kind": "reject_once" },
    ]))
    .await;
    opened_request_id(&runtime).await;
    assert!(peer.silent().await, "no allow_once, no automatic answer");
}

#[tokio::test]
async fn a_switch_out_of_plan_answers_by_itself_only_once_acknowledged() {
    let mut planning = options("full-access");
    planning.interaction_mode = "plan".to_owned();
    let (runtime, mut peer) = started_with(planning, "plan").await;
    let switch = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.set_interaction_mode("default").await }
    });
    let mode = peer.expect("session/set_config_option").await;
    assert_eq!(mode["params"]["value"], "auto");
    peer.fail(&mode, -32603, "Internal error").await;
    assert!(switch.await.unwrap().is_err());
    // A failed loosening keeps `plan`: the prompt rewrites it, and the request goes to the user.
    let send = spawn_send(&runtime).await;
    let retry = peer.expect("session/set_config_option").await;
    assert_eq!(retry["params"]["value"], "plan");
    peer.reply(&retry, json!({ "configOptions": standard_options("plan") }))
        .await;
    let _receipt = send.await.unwrap().expect("sent in plan");
    peer.expect("session/prompt").await;
    peer.permission(allow_or_deny()).await;
    opened_request_id(&runtime).await;
    assert!(peer.silent().await, "never answered by itself");
}

#[tokio::test]
async fn every_approval_gets_a_fresh_id_and_ends_with_its_turn() {
    let (runtime, mut peer) = started("approval-required", "default").await;
    let (_receipt, prompt) = begin_turn(&runtime, &mut peer).await;
    peer.permission(allow_or_deny()).await;
    let first = opened_request_id(&runtime).await;
    // The CLI ends the turn without waiting for the answer: the approval closes with it.
    peer.reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    let events = events_until(&runtime, "turn.completed").await;
    assert!(
        events
            .iter()
            .any(|(kind, payload)| kind == "request.resolved"
                && payload["requestType"] == "file_change_approval"),
        "{events:?}"
    );
    assert!(runtime.pending_request_ids().await.is_empty());

    // The next turn reuses wire id "1" for another tool: the old card cannot answer it.
    let (_receipt, _prompt) = begin_turn(&runtime, &mut peer).await;
    peer.permission_as(json!("1"), SESSION, "execute", allow_or_deny())
        .await;
    let second = opened_request_id(&runtime).await;
    assert_ne!(first, second);
    let stale = runtime
        .respond_to_request(&first, "accept")
        .await
        .expect_err("a closed approval answers nothing");
    assert!(
        matches!(
            stale,
            AntigravityRuntimeError::PendingRequestNotFound { .. }
        ),
        "{stale:?}"
    );
    assert!(peer.silent().await);
}

#[tokio::test]
async fn numeric_and_string_ids_stay_apart_and_a_duplicate_is_not_recorded() {
    let (runtime, mut peer) = started("approval-required", "default").await;
    let (_receipt, _prompt) = begin_turn(&runtime, &mut peer).await;
    peer.permission_as(json!(1), SESSION, "execute", allow_or_deny())
        .await;
    let numeric = opened_request_id(&runtime).await;
    peer.permission_as(json!("1"), SESSION, "edit", allow_or_deny())
        .await;
    let string = opened_request_id(&runtime).await;
    assert_ne!(numeric, string);
    // A second outstanding request with the same typed id is neither recorded nor answered.
    peer.permission_as(json!(1), SESSION, "delete", allow_or_deny())
        .await;
    assert!(peer.silent().await);
    assert_eq!(runtime.pending_request_ids().await.len(), 2);

    runtime
        .respond_to_request(&string, "decline")
        .await
        .unwrap();
    let answer = peer.next().await;
    assert_eq!(answer["id"], json!("1"));
    assert_eq!(answer["result"]["outcome"]["optionId"], "deny");
    runtime
        .respond_to_request(&numeric, "accept")
        .await
        .unwrap();
    let answer = peer.next().await;
    assert_eq!(answer["id"], json!(1));
    assert_eq!(answer["result"]["outcome"]["optionId"], "allow");
}

#[tokio::test]
async fn a_config_answer_showing_another_mode_blocks_the_next_prompt_until_reconfirmed() {
    let (runtime, mut peer) = started("approval-required", "default").await;
    let set = tokio::spawn({
        let runtime = runtime.clone();
        async move {
            runtime
                .set_options(vec![json!({ "id": "reasoning", "value": "low" })])
                .await
        }
    });
    let level = peer.expect("session/set_config_option").await;
    assert_eq!(level["params"]["configId"], "thought_level");
    peer.reply(&level, json!({ "configOptions": standard_options("auto") }))
        .await;
    set.await.unwrap().expect("level written");

    let send = spawn_send(&runtime).await;
    let mode = peer.expect("session/set_config_option").await;
    assert_eq!(
        mode["params"]["value"], "default",
        "the mode is written first"
    );
    peer.reply(
        &mode,
        json!({ "configOptions": standard_options("default") }),
    )
    .await;
    send.await.unwrap().expect("sent once reconfirmed");
    peer.expect("session/prompt").await;
}

#[tokio::test]
async fn a_failed_start_leaves_nothing_a_prompt_could_use() {
    let (runtime, mut peer) = connect(options("approval-required"));
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let new = peer.expect("session/new").await;
    peer.reply(&new, session_result(SESSION, standard_options("auto")))
        .await;
    let mode = peer.expect("session/set_config_option").await;
    peer.fail(&mode, -32602, "Unknown mode: default").await;
    finish(start).await.expect_err("refused");
    let refused = timeout(
        Duration::from_secs(2),
        runtime.send_turn_with_receipt(Some("hello"), Vec::new()),
    )
    .await
    .expect("refused in time");
    assert!(refused.is_err());
    assert!(peer.silent().await, "no prompt after a failed start");
}

#[tokio::test]
async fn a_reopen_answer_naming_another_session_is_a_failure() {
    for capabilities in [all_capabilities(), json!({ "loadSession": true })] {
        let mut resuming = options("full-access");
        resuming.resume_session_id = Some(SAVED.to_owned());
        let (runtime, mut peer) = connect(resuming);
        let start = spawn_start(&runtime);
        let initialize = peer.expect("initialize").await;
        peer.reply(&initialize, initialize_result("1.5.13", 1, capabilities))
            .await;
        let open = peer.next().await;
        peer.reply(
            &open,
            session_result("another-session", standard_options("default")),
        )
        .await;
        let error = finish(start).await.expect_err("a mismatched id");
        assert!(
            matches!(error, AntigravityRuntimeError::SessionMismatch),
            "{error:?}"
        );
        assert!(peer.silent().await, "no new session and no mode write");
    }
}

#[tokio::test]
async fn a_silent_control_request_ends_in_time_and_unconfirms_the_mode() {
    let mut options = options("approval-required");
    options.control_timeout = Duration::from_millis(100);
    let (runtime, mut peer) = started_with(options, "default").await;
    let set = timeout(
        Duration::from_secs(2),
        runtime.set_options(vec![json!({ "id": "reasoning", "value": "low" })]),
    );
    let (result, _) = tokio::join!(set, peer.expect("session/set_config_option"));
    let error = result.expect("bounded").expect_err("no answer");
    assert!(
        matches!(error, AntigravityRuntimeError::ControlTimedOut),
        "{error:?}"
    );
    // The CLI's configuration is unknown now: the next prompt writes the mode first.
    let _send = spawn_send(&runtime).await;
    let mode = peer.expect("session/set_config_option").await;
    assert_eq!(mode["params"]["configId"], "mode");
}

#[tokio::test]
async fn the_initial_thinking_level_is_written_inside_the_start_deadline() {
    let level_low = || vec![json!({ "id": "reasoning", "value": "low" })];
    let mut withheld = options("full-access");
    withheld.start_timeout = Duration::from_millis(300);
    withheld.initial_options = level_low();
    let (runtime, mut peer) = connect(withheld);
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let new = peer.expect("session/new").await;
    peer.reply(&new, session_result(SESSION, standard_options("default")))
        .await;
    let level = peer.expect("session/set_config_option").await;
    assert_eq!(level["params"]["configId"], "thought_level");
    // Withheld: the start deadline, not the supervisor, ends the wait.
    let error = finish(start).await.expect_err("a silent level write");
    assert!(
        matches!(error, AntigravityRuntimeError::StartTimedOut),
        "{error:?}"
    );

    // Acknowledged: the supervisor's later write of the same level writes nothing.
    let mut acknowledged = options("full-access");
    acknowledged.initial_options = level_low();
    let (runtime, mut peer) = connect(acknowledged);
    let start = spawn_start(&runtime);
    let initialize = peer.expect("initialize").await;
    peer.reply(
        &initialize,
        initialize_result("1.5.13", 1, all_capabilities()),
    )
    .await;
    let new = peer.expect("session/new").await;
    peer.reply(&new, session_result(SESSION, standard_options("default")))
        .await;
    let level = peer.expect("session/set_config_option").await;
    let low = config_options(
        "test-model-a",
        &["low", "medium", "high"],
        "low",
        "default",
        ALL_MODES,
    );
    peer.reply(&level, json!({ "configOptions": low })).await;
    let mode = peer.expect("session/set_config_option").await;
    assert_eq!(mode["params"]["configId"], "mode");
    let auto_at_low = config_options(
        "test-model-a",
        &["low", "medium", "high"],
        "low",
        "auto",
        ALL_MODES,
    );
    peer.reply(&mode, json!({ "configOptions": auto_at_low }))
        .await;
    finish(start).await.expect("start");
    timeout(Duration::from_secs(2), runtime.set_options(level_low()))
        .await
        .expect("in time")
        .expect("already applied");
    assert!(peer.silent().await);
}

#[tokio::test]
async fn a_prompt_that_was_never_written_ends_its_turn() {
    let (runtime, peer) = started("full-access", "auto").await;
    let Peer {
        requests,
        output: _output,
        stderr: _stderr,
    } = peer;
    // The CLI stopped reading but its stdout stays open: zero bytes of the prompt are written.
    drop(requests);
    let error = timeout(
        Duration::from_secs(2),
        runtime.send_turn_with_receipt(Some("hello"), Vec::new()),
    )
    .await
    .expect("in time")
    .expect_err("not written");
    assert!(
        matches!(error, AntigravityRuntimeError::Protocol(_)),
        "{error:?}"
    );
    let events = events_until(&runtime, "turn.completed").await;
    assert_eq!(events.last().unwrap().1["state"], "failed");
    timeout(Duration::from_secs(1), runtime.interrupt_turn())
        .await
        .expect("in time")
        .expect("nothing to cancel");
    assert!(
        timeout(Duration::from_millis(200), runtime.abandoned())
            .await
            .is_err(),
        "no active turn is left to cancel or abandon"
    );
}

#[tokio::test]
async fn the_reader_task_lets_go_of_the_runtime_once_the_connection_closes() {
    let (runtime, peer) = started("full-access", "auto").await;
    drop(peer);
    events_until(&runtime, "session.exited").await;
    timeout(Duration::from_secs(2), async {
        while Arc::strong_count(&runtime.inner) > 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("only the test holds the runtime");
}

#[tokio::test]
async fn a_revoke_holds_even_when_the_next_prompt_reconfirms_the_mode() {
    let (runtime, mut peer) = started("full-access", "auto").await;
    // The supervisor revokes ahead of a queued switch to approval-required.
    runtime
        .revoke_auto_answer(Some("approval-required"), None)
        .await;
    let send = spawn_send(&runtime).await;
    let mode = peer.expect("session/set_config_option").await;
    assert_eq!(mode["params"]["value"], "default", "never `auto` again");
    peer.reply(
        &mode,
        json!({ "configOptions": standard_options("default") }),
    )
    .await;
    let _receipt = send.await.unwrap().expect("sent in default");
    peer.expect("session/prompt").await;
    peer.permission(allow_or_deny()).await;
    opened_request_id(&runtime).await;
    assert!(peer.silent().await, "the request waits for the user");
}

#[tokio::test]
async fn a_partly_written_prompt_is_ambiguous_not_unsent() {
    let (runtime, peer) = started("full-access", "auto").await;
    let Peer {
        requests,
        output: _output,
        stderr: _stderr,
    } = peer;
    let mut reader = requests.into_inner();
    let large = "x".repeat(256 * 1024);
    let send = tokio::spawn({
        let runtime = runtime.clone();
        async move {
            runtime
                .send_turn_with_receipt(Some(&large), Vec::new())
                .await
        }
    });
    // The CLI reads part of the prompt, then stops reading.
    let mut start = vec![0_u8; 1024];
    timeout(
        Duration::from_secs(2),
        tokio::io::AsyncReadExt::read_exact(&mut reader, &mut start),
    )
    .await
    .expect("part of the prompt in time")
    .expect("read");
    drop(reader);
    let receipt = timeout(Duration::from_secs(2), send)
        .await
        .expect("in time")
        .unwrap()
        .expect("a partial write still returns a receipt");
    let outcome = timeout(Duration::from_secs(2), receipt.completion())
        .await
        .expect("in time");
    assert!(outcome.is_err(), "{outcome:?}");
}

#[tokio::test]
async fn a_string_id_response_does_not_complete_a_numeric_request() {
    let (runtime, mut peer) = started("full-access", "auto").await;
    let (receipt, prompt) = begin_turn(&runtime, &mut peer).await;
    let id = prompt["id"].as_u64().expect("numeric request id");
    // The string spelling of the prompt's id answers nothing: the turn is never accepted.
    peer.send(
        json!({ "jsonrpc": "2.0", "id": id.to_string(), "result": { "stopReason": "end_turn" } }),
    )
    .await;
    let events = events_until(&runtime, "turn.completed").await;
    assert_ne!(events.last().unwrap().1["state"], "completed");
    let outcome = timeout(Duration::from_secs(2), receipt.completion())
        .await
        .expect("in time");
    assert!(outcome.is_err(), "{outcome:?}");
}
