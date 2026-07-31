#![cfg_attr(not(unix), allow(dead_code, unused_imports))]
// Windows compile-checks shared provider fixtures whose integration tests are Unix-only.

use bibcode_server::production::provider_runtime;

use std::{
    collections::VecDeque,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    process::Command,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    response::sse::{Event, Sse},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt, stream};
use provider_runtime::{
    BoxRuntimeFuture, ClaudeActivitySupport, NativeProviderDriverFactory, ProviderDriver,
    ProviderDriverFactory, ProviderEvent, ProviderLaunchRequest, ProviderMcpConfig,
    ProviderNativeEventId, ProviderRuntimeError, ProviderRuntimeSupervisor, StartedSession,
    SupervisorOptions, build_claude_launch_arguments_for_test,
    claude_activity_probe_cache_len_for_test, claude_activity_probe_cache_paths_for_test,
    claude_output_shutdown_with_open_stream_for_test, probe_claude_activity_support_for_test,
    probe_claude_activity_support_with_resolution_delay_for_test,
    reconcile_abandoned_provider_sessions, reset_claude_activity_probe_cache_for_test,
    route_orchestration_command, seed_claude_activity_probe_cache_for_test,
};
use serde_json::{Value, json};
use bibcode_server::{
    RequestId, RpcExit, RpcRegistry, ServerConfig, ServerMessage, ServerRuntime,
    activity::{
        ActivityCapabilities, ActivityEntry, ActivityEntryKind, ActivityEntryTone,
        ActivityHistoryRecovery, ActivityLifecycle, ActivityObservationState, ActivityProjection,
        ActivityRecordKind, ActivityRepository, ActivityScopeRef, ActivityScopeSeed,
        ActivitySection, ActivitySectionHealth, ActivitySectionObservationState,
        ActivityWorkItemSummary, AgentActivityController, ProviderActivityMutation,
    },
    diagnostics::{NativeProcessSampler, ProcessAttributionRegistry, ProcessRow, ProcessSampler},
    git::GitRepository,
    orchestration::{
        engine::{
            EngineOptions, OrchestrationCommand, OrchestrationEngine, SessionInput,
            ThreadMessageInput,
        },
        load_snapshot,
    },
    persistence::{Database, ProviderSessionRuntime, run_migrations},
    production::{
        orchestration_effects::{
            self, BoxEffectFuture, EffectsOptions, OrchestrationEffectCallbacks,
            OrchestrationEffects,
        },
        orchestration_rpc::register_orchestration_rpc_with_provider,
    },
    provider::claude::ClaudeTranscriptReaderFixture,
};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{WebSocketStream, connect_async, tungstenite::Message};

const NOW: &str = "2026-07-10T10:00:00.000Z";
static CLAUDE_ACTIVITY_PROBE_TEST_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

const WINDOWS_CLAUDE_FIXTURE: &str = r#"
[Console]::Out.WriteLine("ignored non-json output")
[Console]::Error.WriteLine("fixture warning")
while ($null -ne [Console]::In.ReadLine()) {}
"#;

const WINDOWS_CODEX_FIXTURE: &str = r#"
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $request = $line | ConvertFrom-Json } catch { continue }
  $id = [string]$request.id
  $response = $null
  switch ([string]$request.method) {
    "initialize" { $response = '{"id":' + $id + ',"result":{"userAgent":"fixture"}}' }
    "thread/start" { $response = '{"id":' + $id + ',"result":{"cwd":"C:\\tmp","model":"gpt-5","thread":{"id":"native-codex-thread"}}}' }
    "thread/goal/set" { $response = '{"id":' + $id + ',"result":{"goal":{"status":"active"}}}' }
    "turn/start" { $response = '{"id":' + $id + ',"result":{"turn":{"id":"native-codex-turn"}}}' }
    "turn/interrupt" { $response = '{"id":' + $id + ',"result":{}}' }
    "thread/rollback" { $response = '{"id":' + $id + ',"result":{"thread":{"id":"native-codex-thread","turns":[]}}}' }
    "shutdown" { $response = '{"id":' + $id + ',"result":null}' }
  }
  if ($null -ne $response) {
    [Console]::Out.WriteLine($response)
    [Console]::Out.Flush()
  }
  if ([string]$request.method -eq "turn/start") {
    [Console]::Out.WriteLine('{"method":"item/started","emittedAtMs":1001,"params":{"threadId":"native-codex-thread","turnId":"native-codex-turn","item":{"id":"spawn-1","type":"collabAgentToolCall","tool":"spawnAgent","status":"inProgress","senderThreadId":"native-codex-thread","receiverThreadIds":["native-child"],"agentsStates":{"native-child":{"status":"running","message":null}}},"startedAtMs":1001}}')
    [Console]::Out.Flush()
  }
}
"#;

const WINDOWS_ACP_FIXTURE: &str = r#"
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $request = $line | ConvertFrom-Json } catch { continue }
  $id = [string]$request.id
  $response = $null
  switch ([string]$request.method) {
    "initialize" { $response = '{"jsonrpc":"2.0","id":' + $id + ',"result":{}}' }
    "authenticate" { $response = '{"jsonrpc":"2.0","id":' + $id + ',"result":{}}' }
    "session/new" { $response = '{"jsonrpc":"2.0","id":' + $id + ',"result":{"sessionId":"cursor-session","configOptions":[{"id":"model","category":"model"}],"modes":{"currentModeId":"ask","availableModes":[{"id":"ask","name":"Ask"},{"id":"code","name":"Agent"},{"id":"architect","name":"Plan"}]}}}' }
    "session/create" { $response = '{"jsonrpc":"2.0","id":' + $id + ',"result":{"sessionId":"grok-session","modes":{"currentModeId":"code","availableModes":[{"id":"code","name":"Agent"},{"id":"ask","name":"Ask"}]}}}' }
    "session/set_config_option" { $response = '{"jsonrpc":"2.0","id":' + $id + ',"result":{"configOptions":[]}}' }
    "session/set_mode" { $response = '{"jsonrpc":"2.0","id":' + $id + ',"result":{}}' }
    "session/set_model" { $response = '{"jsonrpc":"2.0","id":' + $id + ',"result":{}}' }
    "session/prompt" {
      Start-Sleep -Milliseconds 100
      $response = '{"jsonrpc":"2.0","id":' + $id + ',"result":{"stopReason":"end_turn"}}'
    }
  }
  if ($null -ne $response) {
    [Console]::Out.WriteLine($response)
    [Console]::Out.Flush()
  }
}
"#;

#[cfg(any(unix, windows))]
fn executable_fixture(
    temp: &TempDir,
    name: &str,
    unix_contents: &str,
    windows_contents: &str,
) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let _ = windows_contents;
        let executable = temp.path().join(format!("{name}.sh"));
        std::fs::write(&executable, unix_contents).expect("provider fixture should write");
        let mut permissions = std::fs::metadata(&executable)
            .expect("provider fixture metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&executable, permissions)
            .expect("provider fixture should be executable");
        executable
    }
    #[cfg(windows)]
    {
        let _ = unix_contents;
        let executable = temp.path().join(format!("{name}.ps1"));
        std::fs::write(&executable, windows_contents).expect("provider fixture should write");
        executable
    }
}

#[derive(Clone, Default)]
struct TraceCapture(Arc<StdMutex<Vec<u8>>>);

struct TraceCaptureWriter(Arc<StdMutex<Vec<u8>>>);

impl io::Write for TraceCaptureWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for TraceCapture {
    type Writer = TraceCaptureWriter;

    fn make_writer(&'writer self) -> Self::Writer {
        TraceCaptureWriter(self.0.clone())
    }
}

impl TraceCapture {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

#[derive(Default)]
struct DriverState {
    launches: Vec<ProviderLaunchRequest>,
    start_results: VecDeque<Result<StartedSession, ProviderRuntimeError>>,
    starts: usize,
    sends: Vec<String>,
    interrupts: Vec<Option<String>>,
    approvals: Vec<(String, String)>,
    answers: Vec<(String, Value)>,
    modes: Vec<String>,
    set_mode_results: VecDeque<Result<(), ProviderRuntimeError>>,
    interaction_modes: Vec<String>,
    set_interaction_mode_results: VecDeque<Result<(), ProviderRuntimeError>>,
    models: Vec<String>,
    set_model_results: VecDeque<Result<(), ProviderRuntimeError>>,
    rollbacks: Vec<i64>,
    rollback_observations: Vec<(i64, Option<String>)>,
    rollback_workspace: Option<PathBuf>,
    rollback_error: Option<String>,
    agent_activity_transitions: Vec<bool>,
    agent_activity_results: VecDeque<Result<(), ProviderRuntimeError>>,
    shutdowns: usize,
    stream_ended: Option<Arc<tokio::sync::Notify>>,
}

struct FakeDriver {
    state: Arc<StdMutex<DriverState>>,
    events: tokio::sync::Mutex<mpsc::Receiver<ProviderEvent>>,
}

fn started_session(session_id: &str) -> StartedSession {
    StartedSession {
        resume_cursor: Some(json!({ "sessionId": session_id })),
        runtime_payload: Some(json!({ "transport": "native" })),
        activity_capabilities: ActivityCapabilities::none(),
    }
}

impl ProviderDriver for FakeDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            {
                let mut state = self.state.lock().unwrap();
                state.starts += 1;
                state
                    .start_results
                    .pop_front()
                    .unwrap_or_else(|| Ok(started_session("provider-session-1")))
            }
        })
    }

    fn send(
        &self,
        text: String,
        _attachments: Vec<Value>,
        _interaction_mode: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().sends.push(text);
            Ok(Some("provider-turn-1".to_owned()))
        })
    }

    fn interrupt(
        &self,
        turn_id: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().interrupts.push(turn_id);
            Ok(())
        })
    }

    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.state
                .lock()
                .unwrap()
                .approvals
                .push((request_id, decision));
            Ok(())
        })
    }

    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.state
                .lock()
                .unwrap()
                .answers
                .push((request_id, answers));
            Ok(())
        })
    }

    fn set_mode(&self, mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            {
                let mut state = self.state.lock().unwrap();
                state.modes.push(mode);
                state.set_mode_results.pop_front().unwrap_or(Ok(()))
            }
        })
    }

    fn set_interaction_mode(
        &self,
        mode: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            {
                let mut state = self.state.lock().unwrap();
                state.interaction_modes.push(mode);
                state
                    .set_interaction_mode_results
                    .pop_front()
                    .unwrap_or(Ok(()))
            }
        })
    }

    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            {
                let mut state = self.state.lock().unwrap();
                state.models.push(model);
                state.set_model_results.pop_front().unwrap_or(Ok(()))
            }
        })
    }

    fn rollback(&self, turn_count: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let (workspace, error) = {
                let mut state = self.state.lock().unwrap();
                state.rollbacks.push(turn_count);
                (
                    state.rollback_workspace.clone(),
                    state.rollback_error.clone(),
                )
            };
            let restored = workspace.map(|workspace| {
                std::fs::read_to_string(workspace.join("tracked.txt"))
                    .expect("restored checkpoint is readable")
                    .replace("\r\n", "\n")
            });
            self.state
                .lock()
                .unwrap()
                .rollback_observations
                .push((turn_count, restored));
            if let Some(detail) = error {
                return Err(ProviderRuntimeError::Provider {
                    provider: "codex".to_owned(),
                    detail,
                });
            }
            Ok(())
        })
    }

    fn set_agent_activity_enabled(
        &self,
        enabled: bool,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            state.agent_activity_transitions.push(enabled);
            state.agent_activity_results.pop_front().unwrap_or(Ok(()))
        })
    }

    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            let event = self.events.lock().await.recv().await;
            if event.is_none()
                && let Some(stream_ended) = self.state.lock().unwrap().stream_ended.clone()
            {
                stream_ended.notify_one();
            }
            event
        })
    }

    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().shutdowns += 1;
            Ok(())
        })
    }
}

struct FakeFactory {
    state: Arc<StdMutex<DriverState>>,
    events: StdMutex<VecDeque<mpsc::Receiver<ProviderEvent>>>,
}

struct LaunchRaceFactory {
    state: Arc<StdMutex<DriverState>>,
    events: StdMutex<VecDeque<mpsc::Receiver<ProviderEvent>>>,
    controller: AgentActivityController,
}

impl ProviderDriverFactory for LaunchRaceFactory {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().launches.push(request);
            self.controller.disable().await;
            let events = self
                .events
                .lock()
                .unwrap()
                .pop_front()
                .expect("event receiver");
            Ok(Arc::new(FakeDriver {
                state: self.state.clone(),
                events: tokio::sync::Mutex::new(events),
            }) as Arc<dyn ProviderDriver>)
        })
    }
}

impl ProviderDriverFactory for FakeFactory {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().launches.push(request);
            let events = self
                .events
                .lock()
                .unwrap()
                .pop_front()
                .expect("event receiver");
            Ok(Arc::new(FakeDriver {
                state: self.state.clone(),
                events: tokio::sync::Mutex::new(events),
            }) as Arc<dyn ProviderDriver>)
        })
    }
}

async fn engine() -> OrchestrationEngine {
    engine_and_database().await.0
}

async fn engine_and_database() -> (OrchestrationEngine, Database) {
    let database = Database::open_in_memory().await.unwrap();
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .unwrap();
    let engine = OrchestrationEngine::start(database.clone(), EngineOptions::default())
        .await
        .unwrap();
    engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"project.create", "commandId":"project", "projectId":"p1", "title":"Project",
                "workspaceRoot":"C:/repo", "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"thread.create", "commandId":"thread", "threadId":"t1", "projectId":"p1",
                "title":"Thread", "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access", "branch":null, "worktreePath":null, "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    (engine, database)
}

fn activity_projection(engine: &OrchestrationEngine) -> ActivityProjection {
    ActivityProjection::new(ActivityRepository::new(
        engine.repositories().database().clone(),
    ))
}

fn native_event_id(value: &str) -> Option<ProviderNativeEventId> {
    Some(ProviderNativeEventId::new(value.to_owned()).expect("valid native event id"))
}

fn launch() -> ProviderLaunchRequest {
    ProviderLaunchRequest {
        thread_id: "t1".to_owned(),
        activity_causal_revision: 0,
        provider: "codex".to_owned(),
        provider_label: "codex".to_owned(),
        provider_instance_id: Some("codex".to_owned()),
        binary_path: "codex".to_owned(),
        cwd: "C:/repo".into(),
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        model: Some("gpt-5".to_owned()),
        service_tier: None,
        effort: None,
        agent: None,
        resume_cursor: None,
        environment: Default::default(),
        endpoint: None,
        server_password: None,
        mcp: None,
        codex_home: None,
    }
}

fn image_attachment(temp: &TempDir) -> Value {
    let directory = temp.path().join("attachments");
    std::fs::create_dir_all(&directory).expect("attachment directory");
    std::fs::write(directory.join("image-1"), b"image bytes").expect("attachment image");
    json!({
        "type":"image",
        "id":"image-1",
        "name":"screen.png",
        "mimeType":"image/png",
        "sizeBytes":11,
    })
}

fn persisted_runtime(thread_id: &str, status: &str, last_seen_at: &str) -> ProviderSessionRuntime {
    ProviderSessionRuntime {
        thread_id: thread_id.to_owned(),
        provider_name: "codex".to_owned(),
        provider_instance_id: Some("codex".to_owned()),
        adapter_key: "codex-app-server".to_owned(),
        runtime_mode: "full-access".to_owned(),
        status: status.to_owned(),
        last_seen_at: last_seen_at.to_owned(),
        resume_cursor: Some(json!({"threadId":format!("provider-{thread_id}")})),
        runtime_payload: None,
    }
}

async fn project_session(engine: &OrchestrationEngine, thread_id: &str, status: &str) {
    engine
        .dispatch(OrchestrationCommand::ThreadSessionSet {
            command_id: format!("{thread_id}-{status}-session"),
            thread_id: thread_id.to_owned(),
            session: SessionInput {
                thread_id: thread_id.to_owned(),
                status: status.to_owned(),
                provider_name: Some("codex".to_owned()),
                provider_instance_id: Some("codex".to_owned()),
                runtime_mode: "full-access".to_owned(),
                active_turn_id: None,
                last_error: None,
                updated_at: NOW.to_owned(),
            },
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
}

struct SupervisorEffectsCallbacks {
    supervisor: Arc<ProviderRuntimeSupervisor>,
    workspace: PathBuf,
}

impl OrchestrationEffectCallbacks for SupervisorEffectsCallbacks {
    fn workspace_for_thread<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<PathBuf>> {
        Box::pin(async move { Ok(Some(self.workspace.clone())) })
    }

    fn rollback_provider<'a>(&'a self, thread_id: &'a str, turns: i64) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.supervisor
                .handle_orchestration(OrchestrationCommand::ThreadCheckpointRevert {
                    command_id: format!("effects:provider-rollback:{thread_id}:{turns}"),
                    thread_id: thread_id.to_owned(),
                    turn_count: turns,
                    created_at: NOW.to_owned(),
                })
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn stop_provider<'a>(&'a self, _thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn close_terminals<'a>(&'a self, _thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn refresh_workspace<'a>(&'a self, _cwd: &'a Path) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git starts");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("git output is UTF-8")
        .trim()
        .to_owned()
}

fn git_succeeds(cwd: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .expect("git starts")
        .success()
}

fn initialize_repository() -> TempDir {
    let directory = TempDir::new().expect("temporary repository");
    git(directory.path(), &["init"]);
    git(directory.path(), &["config", "user.name", "BiBCode Test"]);
    git(
        directory.path(),
        &["config", "user.email", "bibcode@example.test"],
    );
    std::fs::write(directory.path().join("tracked.txt"), "baseline\n").unwrap();
    git(directory.path(), &["add", "."]);
    git(directory.path(), &["commit", "-m", "baseline"]);
    directory
}

async fn project_checkpoint(
    engine: &OrchestrationEngine,
    workspace: &Path,
    turn_count: i64,
    content: &str,
) {
    std::fs::write(workspace.join("tracked.txt"), content).unwrap();
    orchestration_effects::capture_checkpoint(workspace, "t1", turn_count)
        .await
        .unwrap();
    if turn_count > 0 {
        engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"thread.turn.diff.complete",
                    "commandId":format!("diff-{turn_count}"),
                    "threadId":"t1",
                    "turnId":format!("turn-{turn_count}"),
                    "checkpointTurnCount":turn_count,
                    "checkpointRef":orchestration_effects::checkpoint_ref("t1", turn_count),
                    "status":"ready",
                    "files":[],
                    "assistantMessageId":format!("assistant-{turn_count}"),
                    "completedAt":NOW,
                    "createdAt":NOW
                }))
                .unwrap(),
            )
            .await
            .unwrap();
    }
}

async fn wait_for_event(
    events: &mut tokio::sync::broadcast::Receiver<bibcode_server::persistence::OrchestrationEvent>,
    predicate: impl Fn(&bibcode_server::persistence::OrchestrationEvent) -> bool,
) {
    timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Ok(event) if predicate(&event) => return,
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    panic!("orchestration event stream closed")
                }
            }
        }
    })
    .await
    .expect("expected orchestration event");
}

fn test_config(temp: &TempDir) -> ServerConfig {
    ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_unsafe_no_auth()
}

async fn rpc_request<S>(socket: &mut WebSocketStream<S>, id: &str, payload: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(
            json!({
                "_tag":"Request",
                "id":id,
                "tag":"orchestration.dispatchCommand",
                "payload":payload,
                "headers":[]
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send orchestration RPC request");
}

async fn rpc_response<S>(socket: &mut WebSocketStream<S>, id: &str) -> Result<Value, Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = timeout(Duration::from_secs(10), socket.next())
        .await
        .expect("orchestration RPC response timeout")
        .expect("WebSocket remains open")
        .expect("valid WebSocket frame");
    let Message::Text(text) = frame else {
        panic!("expected text WebSocket message, got {frame:?}");
    };
    match serde_json::from_str::<ServerMessage>(&text).expect("valid server RPC message") {
        ServerMessage::Exit {
            request_id,
            exit: RpcExit::Success { value },
        } if request_id == RequestId::try_from(id).unwrap() => Ok(value.unwrap_or(Value::Null)),
        ServerMessage::Exit {
            request_id,
            exit: RpcExit::Failure { cause },
        } if request_id == RequestId::try_from(id).unwrap() => {
            Err(serde_json::to_value(cause).unwrap())
        }
        message => panic!("unexpected orchestration RPC response: {message:?}"),
    }
}

#[tokio::test]
async fn routes_orchestration_commands_and_persists_resume_state() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );

    supervisor.launch(launch()).await.unwrap();
    supervisor
        .handle_orchestration(OrchestrationCommand::ThreadTurnStart {
            command_id: "turn".to_owned(),
            thread_id: "t1".to_owned(),
            message: ThreadMessageInput {
                message_id: "m1".to_owned(),
                role: "user".to_owned(),
                text: "hello".to_owned(),
                attachments: vec![],
            },
            model_selection: None,
            title_seed: None,
            runtime_mode: "full-access".to_owned(),
            interaction_mode: "default".to_owned(),
            bootstrap: None,
            source_proposed_plan: None,
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    supervisor.handle_orchestration(serde_json::from_value(json!({"type":"thread.turn.interrupt","commandId":"interrupt","threadId":"t1","turnId":"provider-turn-1","createdAt":NOW})).unwrap()).await.unwrap();
    supervisor.handle_orchestration(serde_json::from_value(json!({"type":"thread.approval.respond","commandId":"approve","threadId":"t1","requestId":"r1","decision":"accept","createdAt":NOW})).unwrap()).await.unwrap();
    supervisor.handle_orchestration(serde_json::from_value(json!({"type":"thread.user-input.respond","commandId":"answer","threadId":"t1","requestId":"r2","answers":{"q":"a"},"createdAt":NOW})).unwrap()).await.unwrap();

    let persisted = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        persisted.resume_cursor,
        Some(json!({ "sessionId": "provider-session-1" }))
    );
    assert_eq!(persisted.status, "ready");
    {
        let state = state.lock().unwrap();
        assert_eq!(state.sends, ["hello"]);
        assert_eq!(state.interrupts, [Some("provider-turn-1".to_owned())]);
        assert_eq!(state.approvals, [("r1".to_owned(), "accept".to_owned())]);
        assert_eq!(state.answers, [("r2".to_owned(), json!({"q":"a"}))]);
    }
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn opencode_launch_uses_durable_activity_revision_as_reconciliation_seed() {
    let engine = engine().await;
    let activity = activity_projection(&engine);
    let scope = ActivityScopeSeed::thread(
        "thread:t1",
        "t1",
        "opencode",
        Some("opencode"),
        ActivityCapabilities::none(),
    )
    .expect("scope");
    activity
        .ensure_scope(scope.clone())
        .await
        .expect("ensure scope");
    activity
        .apply(
            &scope.scope_id,
            "test:opencode:stale-before-launch".to_owned(),
            vec![ProviderActivityMutation::SetScope {
                capabilities: ActivityCapabilities::none(),
                observation_state: ActivityObservationState::Stale,
            }],
            NOW.to_owned(),
        )
        .await
        .expect("stale durable scope");
    let durable_revision = activity
        .snapshot(&scope.scope)
        .await
        .expect("durable snapshot")
        .revision;

    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity,
        SupervisorOptions::default(),
    );
    let mut request = launch();
    request.provider = "opencode".to_owned();
    request.provider_instance_id = Some("opencode".to_owned());
    supervisor.launch(request).await.expect("launch");

    assert_eq!(
        state
            .lock()
            .unwrap()
            .launches
            .first()
            .expect("captured launch")
            .activity_causal_revision,
        durable_revision
    );
    supervisor.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn opencode_launch_does_not_reuse_initial_seed_when_activity_snapshot_is_invalid() {
    let (engine, database) = engine_and_database().await;
    let activity = activity_projection(&engine);
    let scope = ActivityScopeSeed::thread(
        "thread:t1",
        "t1",
        "opencode",
        Some("opencode"),
        ActivityCapabilities::none(),
    )
    .expect("scope");
    activity
        .ensure_scope(scope.clone())
        .await
        .expect("ensure scope");
    database
        .call(move |connection| {
            connection.execute(
                "UPDATE activity_scopes
                 SET capabilities_json = '{'
                 WHERE scope_id = ?",
                [&scope.scope_id],
            )?;
            Ok(())
        })
        .await
        .expect("corrupt activity snapshot fixture");

    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine, factory, activity, SupervisorOptions::default());
    let mut request = launch();
    request.provider = "opencode".to_owned();
    request.provider_instance_id = Some("opencode".to_owned());

    let error = supervisor
        .launch(request)
        .await
        .expect_err("invalid durable activity state must fail before driver creation");
    assert!(
        matches!(error, ProviderRuntimeError::Persistence(_)),
        "unexpected launch error: {error}"
    );
    assert!(
        state.lock().unwrap().launches.is_empty(),
        "the driver must not receive an unsafe initial reconciliation seed"
    );
    supervisor.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn activity_only_provider_events_project_graph_mutations_without_root_payloads() {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(StartedSession {
            resume_cursor: Some(json!({"sessionId":"native-1"})),
            runtime_payload: None,
            activity_capabilities: ActivityCapabilities::structured_full(false),
        })]),
        ..DriverState::default()
    }));
    let (events_tx, events_rx) = mpsc::channel(2);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );

    supervisor.launch(launch()).await.unwrap();

    let scope = ActivityScopeRef::Thread {
        thread_id: "t1".to_owned(),
    };
    let launched = activity
        .snapshot(&scope)
        .await
        .expect("launch creates the provider activity scope");
    assert_eq!(launched.scope_id, "thread:t1");
    assert_eq!(launched.revision, 0);
    assert_eq!(
        launched.capabilities,
        ActivityCapabilities::structured_full(false)
    );

    let event = ProviderEvent {
        native_event_id: native_event_id("native:event:1"),
        event_type: "activity.native".to_owned(),
        thread_id: "t1".to_owned(),
        turn_id: None,
        request_id: None,
        payload: json!({}),
        activity: vec![
            ProviderActivityMutation::upsert_actor("actor:child", None, "Child", "running")
                .expect("valid actor mutation"),
        ],
    };
    events_tx.send(event.clone()).await.unwrap();

    let first_revision = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = activity.snapshot(&scope).await.unwrap();
            if snapshot.revision == 1 && snapshot.actors.len() == 1 {
                break snapshot.revision;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("provider activity mutation is projected");

    events_tx.send(event).await.unwrap();
    events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("native:event:root-with-activity"),
            event_type: "pump.barrier".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({"visible":true}),
            activity: vec![
                ProviderActivityMutation::upsert_actor(
                    "actor:root-carried",
                    None,
                    "Root-carried mutation",
                    "running",
                )
                .expect("valid root-carried actor mutation"),
            ],
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
            if snapshot
                .activities
                .iter()
                .any(|entry| entry.thread_id == "t1" && entry.summary == "pump.barrier")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("pump processes the event after the activity-only replay");

    let replayed = activity.snapshot(&scope).await.unwrap();
    assert_eq!(replayed.revision, first_revision + 1);
    assert_eq!(replayed.actors.len(), 2);
    assert!(
        replayed
            .actors
            .iter()
            .any(|actor| actor.id == "actor:child")
    );
    assert!(
        replayed
            .actors
            .iter()
            .any(|actor| actor.id == "actor:root-carried")
    );
    let root = load_snapshot(&engine.repositories()).await.unwrap();
    assert!(
        root.activities
            .iter()
            .all(|entry| entry.summary != "activity.native"),
        "activity-only provider events must not append root thread activity"
    );
    assert!(root.messages.is_empty());
    assert!(root.turns.is_empty());
    assert!(root.approvals.is_empty());
    assert!(root.proposed_plans.is_empty());

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn agent_activity_toggle_keeps_session_ready_and_fences_native_event_generations() {
    let (engine, database) = engine_and_database().await;
    let controller = AgentActivityController::new(true);
    let activity_repository = ActivityRepository::new(database.clone());
    let activity =
        ActivityProjection::with_controller(ActivityRepository::new(database), controller.clone());
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(StartedSession {
            resume_cursor: Some(json!({"sessionId":"native-activity-toggle"})),
            runtime_payload: None,
            activity_capabilities: ActivityCapabilities::structured_full(false),
        })]),
        ..DriverState::default()
    }));
    let (events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.expect("launch");
    let scope = ActivityScopeRef::Thread {
        thread_id: "t1".to_owned(),
    };

    events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("native:reused-across-toggle"),
            event_type: "activity.native".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![
                ProviderActivityMutation::upsert_actor(
                    "actor:before-toggle",
                    None,
                    "Before toggle",
                    "running",
                )
                .expect("before mutation"),
            ],
        })
        .await
        .expect("initial activity");
    timeout(Duration::from_secs(2), async {
        loop {
            if activity
                .snapshot(&scope)
                .await
                .is_ok_and(|snapshot| snapshot.actors.len() == 1)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("initial activity projects");
    let before_disable = activity.snapshot(&scope).await.expect("before disable");

    controller.disable().await;
    assert_eq!(
        supervisor
            .set_agent_activity_enabled(false)
            .await
            .expect("disable live providers"),
        1
    );
    events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("native:disabled-only"),
            event_type: "activity.native".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![
                ProviderActivityMutation::upsert_actor(
                    "actor:disabled",
                    None,
                    "Disabled",
                    "running",
                )
                .expect("disabled mutation"),
            ],
        })
        .await
        .expect("disabled activity");
    events_tx
        .send(ProviderEvent {
            native_event_id: None,
            event_type: "pump.barrier".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({"visible":true}),
            activity: Vec::new(),
        })
        .await
        .expect("normal barrier");
    timeout(Duration::from_secs(2), async {
        loop {
            if load_snapshot(&engine.repositories())
                .await
                .expect("orchestration snapshot")
                .activities
                .iter()
                .any(|entry| entry.thread_id == "t1" && entry.summary == "pump.barrier")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("normal provider events continue");
    let disabled = activity_repository
        .snapshot(&scope)
        .await
        .expect("disabled durable snapshot");
    assert_eq!(disabled.revision, before_disable.revision);
    assert!(
        disabled
            .actors
            .iter()
            .all(|actor| actor.id != "actor:disabled")
    );
    assert_eq!(
        load_snapshot(&engine.repositories())
            .await
            .expect("session snapshot")
            .sessions
            .iter()
            .find(|session| session.thread_id == "t1")
            .expect("live session")
            .status,
        "ready"
    );

    controller.enable();
    assert_eq!(
        supervisor
            .set_agent_activity_enabled(true)
            .await
            .expect("enable live providers"),
        1
    );
    events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("native:reused-across-toggle"),
            event_type: "activity.native".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![
                ProviderActivityMutation::upsert_actor(
                    "actor:after-toggle",
                    None,
                    "After toggle",
                    "running",
                )
                .expect("resumed mutation"),
            ],
        })
        .await
        .expect("resumed activity");
    timeout(Duration::from_secs(2), async {
        loop {
            if activity.snapshot(&scope).await.is_ok_and(|snapshot| {
                snapshot
                    .actors
                    .iter()
                    .any(|actor| actor.id == "actor:after-toggle")
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("new-generation activity projects");
    let transitions = state.lock().unwrap().agent_activity_transitions.clone();
    assert_eq!(
        transitions.iter().filter(|enabled| !**enabled).count(),
        1,
        "disable reaches the live driver exactly once"
    );
    assert_eq!(transitions.last(), Some(&true));

    supervisor.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn agent_activity_toggle_continues_after_failure_and_bounds_the_first_error() {
    let (engine, database) = engine_and_database().await;
    engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"thread.create", "commandId":"thread-2", "threadId":"t2", "projectId":"p1",
                "title":"Thread 2", "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access", "branch":null, "worktreePath":null, "createdAt":NOW
            }))
            .expect("thread command"),
        )
        .await
        .expect("second thread");
    let controller = AgentActivityController::new(true);
    let activity =
        ActivityProjection::with_controller(ActivityRepository::new(database), controller.clone());
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([
            Ok(started_session("provider-t1")),
            Ok(started_session("provider-t2")),
        ]),
        ..DriverState::default()
    }));
    let (_first_tx, first_rx) = mpsc::channel(1);
    let (_second_tx, second_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([first_rx, second_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity,
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.expect("first launch");
    let mut second_launch = launch();
    second_launch.thread_id = "t2".to_owned();
    supervisor
        .launch(second_launch)
        .await
        .expect("second launch");

    let sensitive_payload = format!(
        "secret-token=\u{0007}{}",
        "provider-controlled-content".repeat(128)
    );
    {
        let mut state = state.lock().unwrap();
        state.agent_activity_transitions.clear();
        state.agent_activity_results = VecDeque::from([
            Err(ProviderRuntimeError::Provider {
                provider: "codex\ninjected".to_owned(),
                detail: sensitive_payload.clone(),
            }),
            Ok(()),
        ]);
    }
    controller.disable().await;
    let error = supervisor
        .set_agent_activity_enabled(false)
        .await
        .expect_err("first transition failure is returned");
    let rendered = error.to_string();
    assert!(
        rendered.len() <= 256,
        "transition errors stay bounded: {} bytes",
        rendered.len()
    );
    assert!(
        !rendered.contains("secret-token")
            && !rendered.contains("provider-controlled-content")
            && !rendered.chars().any(char::is_control),
        "provider-controlled error content must not escape: {rendered:?}"
    );
    assert_eq!(
        state.lock().unwrap().agent_activity_transitions,
        [false, false],
        "the second live driver transitions after the first one fails"
    );

    supervisor.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn launch_rechecks_activity_state_after_factory_creation_before_start() {
    let (engine, database) = engine_and_database().await;
    let controller = AgentActivityController::new(true);
    let activity =
        ActivityProjection::with_controller(ActivityRepository::new(database), controller.clone());
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(started_session("provider-launch-race"))]),
        ..DriverState::default()
    }));
    let (_events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(LaunchRaceFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
        controller: controller.clone(),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine,
        factory,
        activity,
        SupervisorOptions::default(),
    );

    supervisor.launch(launch()).await.expect("launch");
    let state = state.lock().unwrap();
    assert_eq!(
        state.agent_activity_transitions,
        [false],
        "the launch fence observes the state changed during factory creation"
    );
    assert_eq!(state.starts, 1, "the provider still starts normally");
    drop(state);

    supervisor.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn claude_transcript_recovery_event_persists_and_reloads_activity() {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database.clone()));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(StartedSession {
            resume_cursor: Some(json!({"sessionId":"claude-recovery-session"})),
            runtime_payload: None,
            activity_capabilities: ActivityCapabilities::structured_full(false),
        })]),
        ..DriverState::default()
    }));
    let (events_tx, events_rx) = mpsc::channel(2);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine,
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    let mut request = launch();
    request.provider = "claudeAgent".to_owned();
    request.provider_label = "Claude".to_owned();
    supervisor.launch(request).await.unwrap();

    events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("claude:hook:agent-reload:start"),
            event_type: "activity.native".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![
                ProviderActivityMutation::upsert_actor(
                    "claude:agent:agent-reload",
                    None,
                    "Explore",
                    "running",
                )
                .expect("valid recovered entry owner"),
            ],
        })
        .await
        .unwrap();
    events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("claude:recovery:durable-fixture"),
            event_type: "activity.native".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![
                ProviderActivityMutation::AppendEntry(
                    ActivityEntry::try_new(
                        "claude:event:commentary:durable-fixture",
                        ActivityRecordKind::Actor,
                        "claude:agent:agent-reload",
                        ActivityEntryKind::Commentary,
                        "Commentary",
                        Some("Recovered after restart"),
                        ActivityEntryTone::Info,
                        "2026-07-24T12:00:00Z",
                    )
                    .expect("valid recovered entry"),
                ),
                ProviderActivityMutation::SetScope {
                    capabilities: ActivityCapabilities {
                        actors: true,
                        attributed_activity: true,
                        background_work: true,
                        history_recovery: ActivityHistoryRecovery::Bounded,
                        terminal_observation: false,
                    },
                    observation_state: ActivityObservationState::Live,
                },
            ],
        })
        .await
        .unwrap();

    let scope = ActivityScopeRef::Thread {
        thread_id: "t1".to_owned(),
    };
    timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = activity.snapshot(&scope).await.unwrap();
            if snapshot.revision == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("recovered activity event is projected");

    let reloaded_repository = ActivityRepository::new(database);
    let reloaded = reloaded_repository
        .snapshot(&scope)
        .await
        .expect("recovered activity reloads from a fresh repository");
    let detail = reloaded_repository
        .list_detail(
            &scope,
            "thread:t1",
            ActivityRecordKind::Actor,
            "claude:agent:agent-reload",
            None,
            10,
        )
        .await
        .expect("recovered actor detail reloads");
    assert!(detail.entries.iter().any(|entry| {
        entry.id == "claude:event:commentary:durable-fixture"
            && entry.detail.as_deref() == Some("Recovered after restart")
    }));
    assert_eq!(
        reloaded.capabilities.history_recovery,
        ActivityHistoryRecovery::Bounded
    );

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn unexpected_provider_stream_end_marks_activity_scope_stale() {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(StartedSession {
            resume_cursor: Some(json!({"sessionId":"native-1"})),
            runtime_payload: None,
            activity_capabilities: ActivityCapabilities::structured_full(false),
        })]),
        ..DriverState::default()
    }));
    let (events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine,
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();

    drop(events_tx);

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = activity
                .snapshot(&ActivityScopeRef::Thread {
                    thread_id: "t1".to_owned(),
                })
                .await
                .unwrap();
            if snapshot.observation_state == ActivityObservationState::Stale {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("unexpected provider stream end marks the activity scope stale");

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn runtime_observed_capability_upgrade_survives_stream_end() {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(started_session("native-none"))]),
        ..DriverState::default()
    }));
    let (events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine,
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();

    events_tx
        .send(runtime_capability_upgrade_event("native:dynamic:end"))
        .await
        .unwrap();
    let scope = ActivityScopeRef::Thread {
        thread_id: "t1".to_owned(),
    };
    wait_for_dynamic_activity(&activity, &scope).await;
    events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("native:dynamic:end"),
            event_type: "activity.native".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![ProviderActivityMutation::SetScope {
                capabilities: ActivityCapabilities::none(),
                observation_state: ActivityObservationState::Live,
            }],
        })
        .await
        .unwrap();
    drop(events_tx);

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = activity.snapshot(&scope).await.unwrap();
            if snapshot.observation_state == ActivityObservationState::Stale {
                assert_eq!(
                    snapshot.capabilities,
                    ActivityCapabilities::structured_full(false)
                );
                assert_eq!(
                    snapshot.sections.subagents.state,
                    ActivitySectionObservationState::Live
                );
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("stream end uses the capability observed by the event pump");

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn runtime_observed_capability_upgrade_survives_restart_and_stop() {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([
            Ok(started_session("native-none-1")),
            Ok(started_session("native-none-2")),
        ]),
        set_mode_results: VecDeque::from([Err(ProviderRuntimeError::UnsupportedCapability {
            provider: "codex".to_owned(),
            capability: "post-start runtime mode changes",
        })]),
        ..DriverState::default()
    }));
    let (first_events_tx, first_events_rx) = mpsc::channel(1);
    let (_replacement_events_tx, replacement_events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([first_events_rx, replacement_events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine,
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();

    first_events_tx
        .send(runtime_capability_upgrade_event("native:dynamic:restart"))
        .await
        .unwrap();
    let scope = ActivityScopeRef::Thread {
        thread_id: "t1".to_owned(),
    };
    wait_for_dynamic_activity(&activity, &scope).await;

    supervisor
        .handle_orchestration(OrchestrationCommand::ThreadRuntimeModeSet {
            command_id: "restart-after-dynamic-upgrade".to_owned(),
            thread_id: "t1".to_owned(),
            runtime_mode: "approval-required".to_owned(),
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    let restarted = activity.snapshot(&scope).await.unwrap();
    assert_eq!(
        restarted.capabilities,
        ActivityCapabilities::structured_full(false),
        "a replacement startup-none result must not overwrite runtime-observed support"
    );
    assert_eq!(restarted.observation_state, ActivityObservationState::Live);

    supervisor
        .handle_orchestration(OrchestrationCommand::ThreadSessionStop {
            command_id: "stop-after-dynamic-upgrade".to_owned(),
            thread_id: "t1".to_owned(),
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    let stopped = activity.snapshot(&scope).await.unwrap();
    assert_eq!(
        stopped.capabilities,
        ActivityCapabilities::structured_full(false)
    );
    assert_eq!(stopped.observation_state, ActivityObservationState::Live);
    assert_eq!(
        stopped.sections.subagents.state,
        ActivitySectionObservationState::Live
    );

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn authoritative_startup_capabilities_replace_runtime_observation_and_reset_its_source() {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let reduced = ActivityCapabilities {
        actors: true,
        attributed_activity: true,
        background_work: false,
        history_recovery: ActivityHistoryRecovery::Bounded,
        terminal_observation: false,
    };
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([
            Ok(started_session("runtime-observed")),
            Ok(StartedSession {
                resume_cursor: Some(json!({"sessionId":"authoritative-reduced"})),
                runtime_payload: None,
                activity_capabilities: reduced.clone(),
            }),
            Ok(started_session("authoritative-none")),
        ]),
        set_mode_results: VecDeque::from([
            Err(ProviderRuntimeError::UnsupportedCapability {
                provider: "codex".to_owned(),
                capability: "post-start runtime mode changes",
            }),
            Err(ProviderRuntimeError::UnsupportedCapability {
                provider: "codex".to_owned(),
                capability: "post-start runtime mode changes",
            }),
        ]),
        ..DriverState::default()
    }));
    let (first_events_tx, first_events_rx) = mpsc::channel(1);
    let (_second_events_tx, second_events_rx) = mpsc::channel(1);
    let (_third_events_tx, third_events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([
            first_events_rx,
            second_events_rx,
            third_events_rx,
        ])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine,
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();

    first_events_tx
        .send(runtime_capability_upgrade_event(
            "native:dynamic:authoritative-restart",
        ))
        .await
        .unwrap();
    let scope = ActivityScopeRef::Thread {
        thread_id: "t1".to_owned(),
    };
    wait_for_dynamic_activity(&activity, &scope).await;

    supervisor
        .handle_orchestration(OrchestrationCommand::ThreadRuntimeModeSet {
            command_id: "restart-with-authoritative-reduced-capabilities".to_owned(),
            thread_id: "t1".to_owned(),
            runtime_mode: "approval-required".to_owned(),
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(
        activity.snapshot(&scope).await.unwrap().capabilities,
        reduced,
        "an authoritative non-none startup result must replace runtime-observed capabilities"
    );

    supervisor
        .handle_orchestration(OrchestrationCommand::ThreadRuntimeModeSet {
            command_id: "restart-with-authoritative-none-capabilities".to_owned(),
            thread_id: "t1".to_owned(),
            runtime_mode: "full-access".to_owned(),
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(
        activity.snapshot(&scope).await.unwrap().capabilities,
        ActivityCapabilities::none(),
        "accepting authoritative startup capabilities must reset the runtime-observed source"
    );

    supervisor.shutdown().await.unwrap();
}

fn runtime_capability_upgrade_event(native_id: &str) -> ProviderEvent {
    ProviderEvent {
        native_event_id: native_event_id(native_id),
        event_type: "activity.native".to_owned(),
        thread_id: "t1".to_owned(),
        turn_id: None,
        request_id: None,
        payload: json!({}),
        activity: vec![
            ProviderActivityMutation::SetScope {
                capabilities: ActivityCapabilities::structured_full(false),
                observation_state: ActivityObservationState::Live,
            },
            ProviderActivityMutation::SetSectionHealth {
                section: ActivitySection::Subagents,
                health: ActivitySectionHealth::live(),
            },
            ProviderActivityMutation::SetSectionHealth {
                section: ActivitySection::BackgroundTasks,
                health: ActivitySectionHealth::live(),
            },
            ProviderActivityMutation::upsert_actor(
                "actor:runtime-observed",
                None,
                "Runtime observed",
                "running",
            )
            .unwrap(),
        ],
    }
}

async fn wait_for_dynamic_activity(activity: &ActivityProjection, scope: &ActivityScopeRef) {
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = activity.snapshot(scope).await.unwrap();
            if snapshot.capabilities == ActivityCapabilities::structured_full(false)
                && snapshot
                    .actors
                    .iter()
                    .any(|actor| actor.id == "actor:runtime-observed")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    if result.is_err() {
        panic!(
            "runtime capability upgrade is projected; final snapshot: {:#?}",
            activity.snapshot(scope).await.unwrap()
        );
    }
}

#[tokio::test]
async fn intentional_provider_restart_does_not_mark_activity_scope_stale() {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let started = || StartedSession {
        resume_cursor: Some(json!({"sessionId":"native-1"})),
        runtime_payload: None,
        activity_capabilities: ActivityCapabilities::structured_full(false),
    };
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(started()), Ok(started())]),
        set_mode_results: VecDeque::from([Err(ProviderRuntimeError::UnsupportedCapability {
            provider: "codex".to_owned(),
            capability: "post-start runtime mode changes",
        })]),
        ..DriverState::default()
    }));
    let (_first_events_tx, first_events_rx) = mpsc::channel(1);
    let (_replacement_events_tx, replacement_events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([first_events_rx, replacement_events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine,
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();

    supervisor
        .handle_orchestration(OrchestrationCommand::ThreadRuntimeModeSet {
            command_id: "restart-runtime-mode".to_owned(),
            thread_id: "t1".to_owned(),
            runtime_mode: "approval-required".to_owned(),
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();

    let snapshot = activity
        .snapshot(&ActivityScopeRef::Thread {
            thread_id: "t1".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(snapshot.observation_state, ActivityObservationState::Live);
    assert_eq!(snapshot.revision, 0);

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn capable_relaunch_revives_stale_scope_before_accepting_activity() {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([
            Ok(StartedSession {
                resume_cursor: Some(json!({"sessionId":"native-1"})),
                runtime_payload: None,
                activity_capabilities: ActivityCapabilities::none(),
            }),
            Ok(StartedSession {
                resume_cursor: Some(json!({"sessionId":"native-2"})),
                runtime_payload: None,
                activity_capabilities: ActivityCapabilities::structured_full(false),
            }),
        ]),
        set_mode_results: VecDeque::from([Err(ProviderRuntimeError::UnsupportedCapability {
            provider: "codex".to_owned(),
            capability: "post-start runtime mode changes",
        })]),
        ..DriverState::default()
    }));
    let (first_events_tx, first_events_rx) = mpsc::channel(1);
    let (replacement_events_tx, replacement_events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([first_events_rx, replacement_events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine,
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();
    drop(first_events_tx);

    let scope = ActivityScopeRef::Thread {
        thread_id: "t1".to_owned(),
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if activity.snapshot(&scope).await.unwrap().observation_state
                == ActivityObservationState::Stale
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("first launch becomes genuinely stale");

    supervisor
        .handle_orchestration(OrchestrationCommand::ThreadRuntimeModeSet {
            command_id: "restart-capable-provider".to_owned(),
            thread_id: "t1".to_owned(),
            runtime_mode: "approval-required".to_owned(),
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    replacement_events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("native:event:after-relaunch"),
            event_type: "activity.native".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![
                ProviderActivityMutation::upsert_actor(
                    "actor:after-relaunch",
                    None,
                    "Relaunched child",
                    "running",
                )
                .unwrap(),
            ],
        })
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = activity.snapshot(&scope).await.unwrap();
            if snapshot.observation_state == ActivityObservationState::Live
                && snapshot.capabilities == ActivityCapabilities::structured_full(false)
                && snapshot.sections.subagents.state == ActivitySectionObservationState::Live
                && snapshot.sections.background_tasks.state
                    == ActivitySectionObservationState::Live
                && snapshot
                    .actors
                    .iter()
                    .any(|actor| actor.id == "actor:after-relaunch")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("capable relaunch revives scope before accepting its activity");

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn downgrade_to_none_preserves_actor_history_as_stale() {
    assert_capability_downgrade_preserves_history(RetainedActivityHistory::Actor).await;
}

#[tokio::test]
async fn downgrade_to_none_preserves_work_history_as_stale() {
    assert_capability_downgrade_preserves_history(RetainedActivityHistory::WorkItem).await;
}

#[derive(Clone, Copy)]
enum RetainedActivityHistory {
    Actor,
    WorkItem,
}

async fn assert_capability_downgrade_preserves_history(history: RetainedActivityHistory) {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([
            Ok(StartedSession {
                resume_cursor: Some(json!({"sessionId":"native-full"})),
                runtime_payload: None,
                activity_capabilities: ActivityCapabilities::structured_full(false),
            }),
            Ok(StartedSession {
                resume_cursor: Some(json!({"sessionId":"native-none"})),
                runtime_payload: None,
                activity_capabilities: ActivityCapabilities::none(),
            }),
        ]),
        set_mode_results: VecDeque::from([Err(ProviderRuntimeError::UnsupportedCapability {
            provider: "codex".to_owned(),
            capability: "post-start runtime mode changes",
        })]),
        ..DriverState::default()
    }));
    let (first_events_tx, first_events_rx) = mpsc::channel(1);
    let (_replacement_events_tx, replacement_events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([first_events_rx, replacement_events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine,
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();

    let (record_id, mutation) = match history {
        RetainedActivityHistory::Actor => (
            "actor:retained",
            ProviderActivityMutation::upsert_actor(
                "actor:retained",
                None,
                "Retained actor",
                "running",
            )
            .unwrap(),
        ),
        RetainedActivityHistory::WorkItem => (
            "work:retained",
            ProviderActivityMutation::UpsertWorkItem(
                ActivityWorkItemSummary::try_new(
                    "work:retained",
                    None,
                    "Retained work",
                    "background",
                    None,
                    None,
                    ActivityLifecycle::Running,
                    None,
                    NOW,
                    NOW,
                    None,
                )
                .unwrap(),
            ),
        ),
    };
    first_events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("native:event:retained"),
            event_type: "activity.native".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![mutation],
        })
        .await
        .unwrap();

    let scope = ActivityScopeRef::Thread {
        thread_id: "t1".to_owned(),
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = activity.snapshot(&scope).await.unwrap();
            let retained = match history {
                RetainedActivityHistory::Actor => {
                    snapshot.counts.subagents.active == 1
                        && snapshot.actors.iter().any(|actor| actor.id == record_id)
                }
                RetainedActivityHistory::WorkItem => {
                    snapshot.counts.background_tasks.active == 1
                        && snapshot
                            .work_items
                            .iter()
                            .any(|work_item| work_item.id == record_id)
                }
            };
            if retained {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("history is projected before restart");

    supervisor
        .handle_orchestration(OrchestrationCommand::ThreadRuntimeModeSet {
            command_id: "restart-without-activity".to_owned(),
            thread_id: "t1".to_owned(),
            runtime_mode: "approval-required".to_owned(),
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();

    let snapshot = activity.snapshot(&scope).await.unwrap();
    assert_eq!(snapshot.capabilities, ActivityCapabilities::none());
    assert_eq!(snapshot.observation_state, ActivityObservationState::Live);
    match history {
        RetainedActivityHistory::Actor => {
            assert_eq!(snapshot.counts.subagents.active, 1);
            assert!(
                snapshot
                    .actors
                    .iter()
                    .any(|actor| actor.id == record_id)
            );
            assert_eq!(
                snapshot.sections.subagents.state,
                ActivitySectionObservationState::Stale
            );
            assert_eq!(
                snapshot.sections.background_tasks.state,
                ActivitySectionObservationState::Unsupported
            );
        }
        RetainedActivityHistory::WorkItem => {
            assert_eq!(snapshot.counts.background_tasks.active, 1);
            assert!(
                snapshot
                    .work_items
                    .iter()
                    .any(|work_item| work_item.id == record_id)
            );
            assert_eq!(
                snapshot.sections.background_tasks.state,
                ActivitySectionObservationState::Stale
            );
            assert_eq!(
                snapshot.sections.subagents.state,
                ActivitySectionObservationState::Unsupported
            );
        }
    }

    supervisor.shutdown().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn shutdown_compensates_a_stale_write_already_queued_on_sqlite() {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database.clone()));
    let stream_ended = Arc::new(tokio::sync::Notify::new());
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(StartedSession {
            resume_cursor: Some(json!({"sessionId":"native-1"})),
            runtime_payload: None,
            activity_capabilities: ActivityCapabilities::structured_full(false),
        })]),
        stream_ended: Some(stream_ended.clone()),
        ..DriverState::default()
    }));
    let (events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine,
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();

    let (blocker_entered_tx, blocker_entered_rx) = tokio::sync::oneshot::channel();
    let (release_blocker_tx, release_blocker_rx) = std::sync::mpsc::sync_channel(1);
    let blocker_database = database.clone();
    let blocker = tokio::spawn(async move {
        blocker_database
            .call(move |_| {
                let _ = blocker_entered_tx.send(());
                release_blocker_rx.recv().expect("release SQLite blocker");
                Ok(())
            })
            .await
    });
    blocker_entered_rx.await.unwrap();

    drop(events_tx);
    stream_ended.notified().await;
    let shutdown = tokio::spawn(async move { supervisor.shutdown().await });
    tokio::task::yield_now().await;
    release_blocker_tx.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(2), shutdown)
        .await
        .expect("shutdown completes after queued stale work")
        .unwrap()
        .unwrap();

    let snapshot = activity
        .snapshot(&ActivityScopeRef::Thread {
            thread_id: "t1".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(snapshot.observation_state, ActivityObservationState::Live);
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_native_ids_drop_only_activity_without_leaking_sensitive_text() {
    let capture = TraceCapture::default();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_target(false)
        .with_writer(capture.clone())
        .finish();
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(StartedSession {
            resume_cursor: Some(json!({"sessionId":"native-1"})),
            runtime_payload: None,
            activity_capabilities: ActivityCapabilities::structured_full(false),
        })]),
        ..DriverState::default()
    }));
    let (events_tx, events_rx) = mpsc::channel(4);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();

    for (index, native_event_id) in [
        String::new(),
        "control\u{0007}SENSITIVE_CONTROL_ID".to_owned(),
        format!("SENSITIVE_OVERSIZED_ID{}", "x".repeat(5_000)),
    ]
    .into_iter()
    .enumerate()
    {
        events_tx
            .send(ProviderEvent {
                native_event_id: ProviderNativeEventId::new(native_event_id).ok(),
                event_type: "activity.invalid-native-id".to_owned(),
                thread_id: "t1".to_owned(),
                turn_id: None,
                request_id: None,
                payload: json!({"index":index}),
                activity: vec![
                    ProviderActivityMutation::upsert_actor(
                        format!("actor:invalid:{index}"),
                        None,
                        "Must not project",
                        "running",
                    )
                    .unwrap(),
                ],
            })
            .await
            .unwrap();
    }

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let ordinary_count = load_snapshot(&engine.repositories())
                .await
                .unwrap()
                .activities
                .iter()
                .filter(|event| event.summary == "activity.invalid-native-id")
                .count();
            if ordinary_count == 3 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("ordinary projection continues for invalid activity IDs");

    let snapshot = activity
        .snapshot(&ActivityScopeRef::Thread {
            thread_id: "t1".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(snapshot.revision, 0);
    assert!(snapshot.actors.is_empty());
    let traces = capture.text();
    assert!(!traces.contains("SENSITIVE_CONTROL_ID"));
    assert!(!traces.contains("SENSITIVE_OVERSIZED_ID"));

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn mismatched_event_thread_cannot_contaminate_launch_activity_scope() {
    let (engine, database) = engine_and_database().await;
    engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"thread.create", "commandId":"thread-2", "threadId":"t2", "projectId":"p1",
                "title":"Other thread", "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access", "branch":null, "worktreePath":null, "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(StartedSession {
            resume_cursor: Some(json!({"sessionId":"native-1"})),
            runtime_payload: None,
            activity_capabilities: ActivityCapabilities::structured_full(false),
        })]),
        ..DriverState::default()
    }));
    let (events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();
    events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("native:event:wrong-thread"),
            event_type: "activity.cross-thread".to_owned(),
            thread_id: "t2".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![
                ProviderActivityMutation::upsert_actor(
                    "actor:cross-thread",
                    None,
                    "Wrong thread",
                    "running",
                )
                .unwrap(),
            ],
        })
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if load_snapshot(&engine.repositories())
                .await
                .unwrap()
                .activities
                .iter()
                .any(|event| event.thread_id == "t2" && event.summary == "activity.cross-thread")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("ordinary mismatched-thread event follows existing projection semantics");

    let snapshot = activity
        .snapshot(&ActivityScopeRef::Thread {
            thread_id: "t1".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(snapshot.revision, 0);
    assert!(snapshot.actors.is_empty());
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn activity_scope_ensure_failure_is_diagnostic_only() {
    let (engine, database) = engine_and_database().await;
    database
        .call(|connection| {
            connection.execute_batch(
                "CREATE TRIGGER fail_activity_scope_ensure
                 BEFORE INSERT ON activity_scopes
                 BEGIN
                   SELECT RAISE(FAIL, 'injected activity scope failure');
                 END;",
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let activity = ActivityProjection::new(ActivityRepository::new(database));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(StartedSession {
            resume_cursor: Some(json!({"sessionId":"native-1"})),
            runtime_payload: None,
            activity_capabilities: ActivityCapabilities::structured_full(false),
        })]),
        ..DriverState::default()
    }));
    let (events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity,
        SupervisorOptions::default(),
    );

    supervisor
        .launch(launch())
        .await
        .expect("activity scope failure does not fail provider launch");
    events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("native:event:scope-unavailable"),
            event_type: "provider.scope-unavailable".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![
                ProviderActivityMutation::upsert_actor(
                    "actor:scope-unavailable",
                    None,
                    "Unavailable",
                    "running",
                )
                .unwrap(),
            ],
        })
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if load_snapshot(&engine.repositories())
                .await
                .unwrap()
                .activities
                .iter()
                .any(|event| event.summary == "provider.scope-unavailable")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("ordinary event projects despite unavailable activity scope");
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn activity_apply_failure_is_diagnostic_only() {
    let (engine, database) = engine_and_database().await;
    let activity = ActivityProjection::new(ActivityRepository::new(database.clone()));
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(StartedSession {
            resume_cursor: Some(json!({"sessionId":"native-1"})),
            runtime_payload: None,
            activity_capabilities: ActivityCapabilities::structured_full(false),
        })]),
        ..DriverState::default()
    }));
    let (events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity.clone(),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();
    database
        .call(|connection| {
            connection.execute_batch(
                "CREATE TRIGGER fail_activity_apply
                 BEFORE INSERT ON activity_journal
                 BEGIN
                   SELECT RAISE(FAIL, 'injected activity apply failure');
                 END;",
            )?;
            Ok(())
        })
        .await
        .unwrap();

    events_tx
        .send(ProviderEvent {
            native_event_id: native_event_id("native:event:apply-failure"),
            event_type: "provider.activity-apply-failed".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: vec![
                ProviderActivityMutation::upsert_actor(
                    "actor:apply-failure",
                    None,
                    "Apply failure",
                    "running",
                )
                .unwrap(),
            ],
        })
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if load_snapshot(&engine.repositories())
                .await
                .unwrap()
                .activities
                .iter()
                .any(|event| event.summary == "provider.activity-apply-failed")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("ordinary event projects despite activity apply failure");
    let snapshot = activity
        .snapshot(&ActivityScopeRef::Thread {
            thread_id: "t1".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(snapshot.revision, 0);
    assert!(snapshot.actors.is_empty());
    supervisor.shutdown().await.unwrap();
}

#[test]
fn activity_capabilities_default_to_no_activity() {
    assert_eq!(
        ActivityCapabilities::default(),
        ActivityCapabilities::none()
    );
    assert!(ProviderNativeEventId::new(String::new()).is_err());
    assert!(ProviderNativeEventId::new("control\u{0007}value".to_owned()).is_err());
    let sensitive_oversized = format!("SENSITIVE_VALIDATION_ID{}", "x".repeat(5_000));
    let error = ProviderNativeEventId::new(sensitive_oversized)
        .expect_err("oversized native IDs are rejected");
    assert!(!error.to_string().contains("SENSITIVE_VALIDATION_ID"));
}

#[tokio::test]
async fn routes_the_complete_live_session_lifecycle_and_stops_idempotently() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    let settings = TempDir::new().unwrap();

    supervisor.launch(launch()).await.unwrap();
    let duplicate = supervisor
        .launch(launch())
        .await
        .expect_err("a live thread must have exactly one provider session");
    assert!(matches!(
        duplicate,
        ProviderRuntimeError::SessionAlreadyExists { thread_id } if thread_id == "t1"
    ));

    for value in [
        json!({"type":"thread.runtime-mode.set","commandId":"mode","threadId":"t1","runtimeMode":"approval-required","createdAt":NOW}),
        json!({"type":"thread.interaction-mode.set","commandId":"interaction","threadId":"t1","interactionMode":"plan","createdAt":NOW}),
        json!({"type":"thread.meta.update","commandId":"model","threadId":"t1","modelSelection":{"instanceId":"codex","model":"gpt-5.1"}}),
    ] {
        route_orchestration_command(
            &supervisor,
            &engine,
            &settings.path().to_path_buf(),
            serde_json::from_value(value).unwrap(),
        )
        .await
        .unwrap();
    }

    {
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.modes, ["approval-required"]);
        assert_eq!(state.interaction_modes, ["plan"]);
        assert_eq!(state.models, ["gpt-5.1"]);
        assert!(state.rollbacks.is_empty());
    }

    let delete: OrchestrationCommand = serde_json::from_value(json!({
        "type":"thread.delete",
        "commandId":"delete",
        "threadId":"t1",
        "createdAt":NOW
    }))
    .unwrap();
    route_orchestration_command(
        &supervisor,
        &engine,
        &settings.path().to_path_buf(),
        delete.clone(),
    )
    .await
    .unwrap();
    route_orchestration_command(&supervisor, &engine, &settings.path().to_path_buf(), delete)
        .await
        .unwrap();
    assert_eq!(state.lock().unwrap().shutdowns, 1);
    assert!(
        engine
            .repositories()
            .get_provider_session_runtime("t1".to_owned())
            .await
            .unwrap()
            .is_none()
    );

    supervisor.shutdown().await.unwrap();
    supervisor.shutdown().await.unwrap();
    let error = supervisor
        .handle_orchestration(
            serde_json::from_value(json!({
                "type":"thread.session.stop",
                "commandId":"after-shutdown",
                "threadId":"t1",
                "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .expect_err("commands after shutdown must fail explicitly");
    assert!(matches!(error, ProviderRuntimeError::Shutdown));
}

#[tokio::test(flavor = "current_thread")]
async fn late_provider_events_after_thread_deletion_do_not_warn() {
    let capture = TraceCapture::default();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_target(false)
        .with_writer(capture.clone())
        .finish();
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    let settings = TempDir::new().unwrap();
    supervisor.launch(launch()).await.unwrap();

    let delete: OrchestrationCommand = serde_json::from_value(json!({
        "type":"thread.delete",
        "commandId":"delete-before-provider-stop",
        "threadId":"t1",
        "createdAt":NOW
    }))
    .unwrap();
    engine.dispatch(delete.clone()).await.unwrap();
    events_tx
        .send(ProviderEvent {
            native_event_id: None,
            event_type: "session.ready".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            activity: Vec::new(),
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    route_orchestration_command(&supervisor, &engine, &settings.path().to_path_buf(), delete)
        .await
        .unwrap();
    supervisor.shutdown().await.unwrap();

    assert!(
        !capture
            .text()
            .contains("failed to project provider runtime event"),
        "late shutdown events should not be reported as unexpected projection failures"
    );
}

#[tokio::test]
async fn launch_failure_persists_the_error_and_keeps_the_thread_relaunchable() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([
            Err(ProviderRuntimeError::Provider {
                provider: "codex".to_owned(),
                detail: "bootstrap failed".to_owned(),
            }),
            Ok(started_session("provider-session-2")),
        ]),
        ..DriverState::default()
    }));
    let (_events_tx1, events_rx1) = mpsc::channel(1);
    let (_events_tx2, events_rx2) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx1, events_rx2])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );

    let error = supervisor
        .launch(launch())
        .await
        .expect_err("a failed provider bootstrap must surface to the caller");
    assert!(matches!(
        error,
        ProviderRuntimeError::Provider { provider, detail }
            if provider == "codex" && detail == "bootstrap failed"
    ));

    let failed_runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed_runtime.status, "error");
    assert_eq!(
        failed_runtime.runtime_payload,
        Some(json!({"error":"codex provider operation failed: bootstrap failed"}))
    );
    {
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.shutdowns, 1);
        assert_eq!(state.launches.len(), 1);
    }

    supervisor
        .launch(launch())
        .await
        .expect("a failed bootstrap must not leave a ghost live session behind");

    let recovered_runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered_runtime.status, "ready");
    assert_eq!(
        recovered_runtime.resume_cursor,
        Some(json!({"sessionId":"provider-session-2"}))
    );
    assert_eq!(state.lock().unwrap().starts, 2);

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn unsupported_live_capabilities_restart_the_runtime_with_updated_launch_state() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([
            Ok(started_session("provider-session-1")),
            Ok(started_session("provider-session-2")),
            Ok(started_session("provider-session-3")),
        ]),
        set_mode_results: VecDeque::from([Err(ProviderRuntimeError::UnsupportedCapability {
            provider: "codex".to_owned(),
            capability: "runtime mode switch",
        })]),
        set_model_results: VecDeque::from([Err(ProviderRuntimeError::UnsupportedCapability {
            provider: "codex".to_owned(),
            capability: "model switch",
        })]),
        ..DriverState::default()
    }));
    let (_events_tx1, events_rx1) = mpsc::channel(1);
    let (_events_tx2, events_rx2) = mpsc::channel(1);
    let (_events_tx3, events_rx3) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx1, events_rx2, events_rx3])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );

    supervisor.launch(launch()).await.unwrap();
    supervisor
        .handle_orchestration(
            serde_json::from_value(json!({
                "type":"thread.runtime-mode.set",
                "commandId":"restart-mode",
                "threadId":"t1",
                "runtimeMode":"approval-required",
                "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    supervisor
        .handle_orchestration(
            serde_json::from_value(json!({
                "type":"thread.meta.update",
                "commandId":"restart-model",
                "threadId":"t1",
                "modelSelection":{"instanceId":"codex","model":"gpt-5.1"}
            }))
            .unwrap(),
        )
        .await
        .unwrap();

    let launches = state.lock().unwrap().launches.clone();
    assert_eq!(launches.len(), 3);
    assert_eq!(launches[1].runtime_mode, "approval-required");
    assert_eq!(
        launches[1].resume_cursor,
        Some(json!({"sessionId":"provider-session-1"}))
    );
    assert_eq!(launches[2].runtime_mode, "approval-required");
    assert_eq!(launches[2].interaction_mode, "default");
    assert_eq!(launches[2].model.as_deref(), Some("gpt-5.1"));
    assert_eq!(
        launches[2].resume_cursor,
        Some(json!({"sessionId":"provider-session-2"}))
    );
    {
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 3);
        assert_eq!(state.shutdowns, 2);
        assert_eq!(state.modes, ["approval-required"]);
        assert!(state.interaction_modes.is_empty());
        assert_eq!(state.models, ["gpt-5.1"]);
    }

    let runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "ready");
    assert_eq!(
        runtime.resume_cursor,
        Some(json!({"sessionId":"provider-session-3"}))
    );

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn interaction_mode_provider_failure_preserves_the_live_launch_state() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(started_session("provider-session-1"))]),
        set_interaction_mode_results: VecDeque::from([Err(ProviderRuntimeError::Provider {
            provider: "claude".to_owned(),
            detail: "set permission mode failed".to_owned(),
        })]),
        ..DriverState::default()
    }));
    let (_events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    let mut request = launch();
    request.provider = "claude".to_owned();
    request.provider_instance_id = Some("claude".to_owned());
    request.binary_path = "claude".to_owned();

    supervisor.launch(request).await.unwrap();
    let error = supervisor
        .handle_orchestration(
            serde_json::from_value(json!({
                "type":"thread.interaction-mode.set",
                "commandId":"failed-interaction",
                "threadId":"t1",
                "interactionMode":"plan",
                "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .expect_err("adapter interaction-mode failures must surface without restarting");
    assert!(matches!(
        error,
        ProviderRuntimeError::Provider { provider, detail }
            if provider == "claude" && detail == "set permission mode failed"
    ));

    {
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.shutdowns, 0);
        assert_eq!(state.launches.len(), 1);
        assert_eq!(state.launches[0].interaction_mode, "default");
        assert_eq!(state.interaction_modes, ["plan"]);
    }
    let runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "ready");
    assert_eq!(
        runtime.resume_cursor,
        Some(json!({"sessionId":"provider-session-1"}))
    );

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn projects_event_aliases_user_input_and_proposed_plans_with_request_context() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();

    for event in [
        ProviderEvent {
            native_event_id: None,
            event_type: "assistant.message.delta".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: None,
            payload: json!({"messageId":"assistant-explicit","text":"Plan incoming"}),
            activity: Vec::new(),
        },
        ProviderEvent {
            native_event_id: None,
            event_type: "assistant.message.completed".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: None,
            payload: json!({"messageId":"assistant-explicit"}),
            activity: Vec::new(),
        },
        ProviderEvent {
            native_event_id: None,
            event_type: "request.opened".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("approval-1".to_owned()),
            payload: json!({"requestType":"command_execution_approval","command":"cargo check"}),
            activity: Vec::new(),
        },
        ProviderEvent {
            native_event_id: None,
            event_type: "request.resolved".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("approval-1".to_owned()),
            payload: json!("accepted"),
            activity: Vec::new(),
        },
        ProviderEvent {
            native_event_id: None,
            event_type: "user-input.requested".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("input-1".to_owned()),
            payload: json!({
                "questions":[{
                    "id":"cwd",
                    "header":"Workspace",
                    "question":"Need a path",
                    "options":[
                        {"label":"repo","description":"Use the repository root"},
                        {"label":"worktree","description":"Use the current worktree"}
                    ]
                }]
            }),
            activity: Vec::new(),
        },
        ProviderEvent {
            native_event_id: None,
            event_type: "user-input.resolved".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("input-1".to_owned()),
            payload: json!("workspace chosen"),
            activity: Vec::new(),
        },
        ProviderEvent {
            native_event_id: None,
            event_type: "turn.proposed.completed".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: None,
            payload: json!({"planMarkdown":"1. Inspect\n2. Fix\n3. Verify"}),
            activity: Vec::new(),
        },
    ] {
        events_tx.send(event).await.unwrap();
    }

    match tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
            let assistant = snapshot
                .messages
                .iter()
                .find(|message| message.message_id == "assistant-explicit");
            let thread = snapshot
                .threads
                .iter()
                .find(|thread| thread.thread_id == "t1");
            let activities = snapshot
                .activities
                .iter()
                .filter(|activity| activity.thread_id == "t1")
                .collect::<Vec<_>>();
            let plan = snapshot
                .proposed_plans
                .iter()
                .find(|plan| plan.thread_id == "t1" && plan.turn_id.as_deref() == Some("turn-1"));
            let approvals = engine
                .repositories()
                .list_pending_approvals_by_thread("t1".to_owned())
                .await
                .unwrap();
            let approval = approvals
                .iter()
                .find(|approval| approval.request_id == "approval-1");
            let approval_resolved = activities.iter().find(|activity| {
                activity.kind == "approval.resolved"
                    && activity.payload["requestId"] == "approval-1"
                    && activity.payload["detail"] == "accepted"
            });
            let user_input_requested = activities.iter().find(|activity| {
                activity.kind == "user-input.requested"
                    && activity.payload["requestId"] == "input-1"
                    && activity.payload["questions"][0]["id"] == "cwd"
            });
            let user_input_resolved = activities.iter().find(|activity| {
                activity.kind == "user-input.resolved"
                    && activity.payload["requestId"] == "input-1"
                    && activity.payload["detail"] == "workspace chosen"
            });
            if assistant
                .is_some_and(|message| message.text == "Plan incoming" && !message.is_streaming)
                && thread.is_some_and(|thread| {
                    thread.pending_approval_count == 0 && thread.has_actionable_proposed_plan == 1
                })
                && plan.is_some_and(|plan| plan.plan_markdown.contains("Inspect"))
                && approval.is_some_and(|approval| approval.status == "resolved")
                && approval_resolved.is_some()
                && user_input_requested.is_some()
                && user_input_resolved.is_some()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    {
        Ok(()) => {}
        Err(error) => {
            let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
            let approvals = engine
                .repositories()
                .list_pending_approvals_by_thread("t1".to_owned())
                .await
                .unwrap();
            panic!(
                "provider event aliases must project into durable orchestration state: {error:?}\nassistant={:?}\nthread={:?}\nplan={:?}\napprovals={approvals:?}\nactivities={:?}",
                snapshot
                    .messages
                    .iter()
                    .find(|message| message.message_id == "assistant-explicit"),
                snapshot
                    .threads
                    .iter()
                    .find(|thread| thread.thread_id == "t1"),
                snapshot.proposed_plans.iter().find(
                    |plan| plan.thread_id == "t1" && plan.turn_id.as_deref() == Some("turn-1")
                ),
                snapshot
                    .activities
                    .iter()
                    .filter(|activity| activity.thread_id == "t1")
                    .collect::<Vec<_>>()
            );
        }
    }

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn checkpoint_rpc_rolls_back_once_after_restore_with_the_computed_delta() {
    let repository = initialize_repository();
    let engine = engine().await;
    for (turn_count, content) in [
        (0, "baseline\n"),
        (1, "one\n"),
        (2, "two\n"),
        (3, "three\n"),
    ] {
        project_checkpoint(&engine, repository.path(), turn_count, content).await;
    }

    let state = Arc::new(StdMutex::new(DriverState {
        rollback_workspace: Some(repository.path().to_path_buf()),
        ..DriverState::default()
    }));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let supervisor = Arc::new(ProviderRuntimeSupervisor::start(
        engine.clone(),
        Arc::new(FakeFactory {
            state: state.clone(),
            events: StdMutex::new(VecDeque::from([events_rx])),
        }),
        activity_projection(&engine),
        SupervisorOptions::default(),
    ));
    let mut provider_launch = launch();
    provider_launch.cwd = repository.path().to_path_buf();
    supervisor.launch(provider_launch).await.unwrap();
    let effects = OrchestrationEffects::start(
        engine.clone(),
        Arc::new(GitRepository::default()),
        Arc::new(SupervisorEffectsCallbacks {
            supervisor: supervisor.clone(),
            workspace: repository.path().to_path_buf(),
        }),
        EffectsOptions::default(),
    )
    .await
    .unwrap();
    let settings = TempDir::new().unwrap();
    let mut registry = RpcRegistry::empty();
    register_orchestration_rpc_with_provider(
        &mut registry,
        engine.clone(),
        supervisor.clone(),
        settings.path().to_path_buf(),
    );
    let handle = ServerRuntime::start_with_registry(test_config(&settings), registry)
        .await
        .unwrap();
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .unwrap();
    let mut events = engine.subscribe_events();

    rpc_request(
        &mut socket,
        "1",
        json!({
            "type":"thread.checkpoint.revert",
            "commandId":"rollback-success",
            "threadId":"t1",
            "turnCount":1,
            "createdAt":NOW
        }),
    )
    .await;
    rpc_response(&mut socket, "1")
        .await
        .expect("checkpoint RPC is accepted");
    wait_for_event(&mut events, |event| {
        event.event.event_type == "thread.reverted"
    })
    .await;

    effects.shutdown().await;
    assert_eq!(
        std::fs::read_to_string(repository.path().join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "one\n"
    );
    {
        let state = state.lock().unwrap();
        assert_eq!(state.rollbacks, [2]);
        assert_eq!(state.rollback_observations, [(2, Some("one\n".to_owned()))]);
    }
    for stale_turn in [2, 3] {
        assert!(!git_succeeds(
            repository.path(),
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &orchestration_effects::checkpoint_ref("t1", stale_turn),
            ]
        ));
    }

    socket.close(None).await.unwrap();
    handle.shutdown();
    handle.join().await.unwrap();
    supervisor.shutdown().await.unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn checkpoint_rpc_reports_effect_failure_without_a_direct_or_second_rollback() {
    let repository = initialize_repository();
    let engine = engine().await;
    for (turn_count, content) in [
        (0, "baseline\n"),
        (1, "one\n"),
        (2, "two\n"),
        (3, "three\n"),
    ] {
        project_checkpoint(&engine, repository.path(), turn_count, content).await;
    }

    let state = Arc::new(StdMutex::new(DriverState {
        rollback_workspace: Some(repository.path().to_path_buf()),
        rollback_error: Some("injected provider rollback failure".to_owned()),
        ..DriverState::default()
    }));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let supervisor = Arc::new(ProviderRuntimeSupervisor::start(
        engine.clone(),
        Arc::new(FakeFactory {
            state: state.clone(),
            events: StdMutex::new(VecDeque::from([events_rx])),
        }),
        activity_projection(&engine),
        SupervisorOptions::default(),
    ));
    let mut provider_launch = launch();
    provider_launch.cwd = repository.path().to_path_buf();
    supervisor.launch(provider_launch).await.unwrap();
    let effects = OrchestrationEffects::start(
        engine.clone(),
        Arc::new(GitRepository::default()),
        Arc::new(SupervisorEffectsCallbacks {
            supervisor: supervisor.clone(),
            workspace: repository.path().to_path_buf(),
        }),
        EffectsOptions::default(),
    )
    .await
    .unwrap();
    let settings = TempDir::new().unwrap();
    let mut registry = RpcRegistry::empty();
    register_orchestration_rpc_with_provider(
        &mut registry,
        engine.clone(),
        supervisor.clone(),
        settings.path().to_path_buf(),
    );
    let handle = ServerRuntime::start_with_registry(test_config(&settings), registry)
        .await
        .unwrap();
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .unwrap();
    let mut events = engine.subscribe_events();

    rpc_request(
        &mut socket,
        "2",
        json!({
            "type":"thread.checkpoint.revert",
            "commandId":"rollback-failure",
            "threadId":"t1",
            "turnCount":1,
            "createdAt":NOW
        }),
    )
    .await;
    rpc_response(&mut socket, "2")
        .await
        .expect("checkpoint command acceptance is independent of its asynchronous effect");
    wait_for_event(&mut events, |event| {
        event.event.event_type == "thread.activity-appended"
            && event.event.payload["activity"]["kind"] == "checkpoint.revert.failed"
    })
    .await;

    effects.shutdown().await;
    assert_eq!(
        std::fs::read_to_string(repository.path().join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "one\n"
    );
    {
        let state = state.lock().unwrap();
        assert_eq!(state.rollbacks, [2]);
        assert_eq!(state.rollback_observations, [(2, Some("one\n".to_owned()))]);
    }
    let events = engine.read_events(0).await.unwrap();
    assert!(
        !events
            .iter()
            .any(|event| event.event.event_type == "thread.reverted")
    );
    for preserved_turn in [2, 3] {
        assert!(git_succeeds(
            repository.path(),
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &orchestration_effects::checkpoint_ref("t1", preserved_turn),
            ]
        ));
    }

    socket.close(None).await.unwrap();
    handle.shutdown();
    handle.join().await.unwrap();
    supervisor.shutdown().await.unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn restart_reconciles_abandoned_running_provider_sessions() {
    let engine = engine().await;
    engine
        .dispatch(OrchestrationCommand::ThreadSessionSet {
            command_id: "running-session".to_owned(),
            thread_id: "t1".to_owned(),
            session: SessionInput {
                thread_id: "t1".to_owned(),
                status: "running".to_owned(),
                provider_name: Some("codex".to_owned()),
                provider_instance_id: Some("codex".to_owned()),
                runtime_mode: "full-access".to_owned(),
                active_turn_id: Some("provider-turn-1".to_owned()),
                last_error: None,
                updated_at: NOW.to_owned(),
            },
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    engine
        .repositories()
        .upsert_provider_session_runtime(ProviderSessionRuntime {
            thread_id: "t1".to_owned(),
            provider_name: "codex".to_owned(),
            provider_instance_id: Some("codex".to_owned()),
            adapter_key: "codex-app-server".to_owned(),
            runtime_mode: "full-access".to_owned(),
            status: "running".to_owned(),
            last_seen_at: NOW.to_owned(),
            resume_cursor: Some(json!({"threadId":"provider-thread-1"})),
            runtime_payload: None,
        })
        .await
        .unwrap();

    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();

    let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.thread_id == "t1")
        .unwrap();
    assert_eq!(session.status, "error");
    assert_eq!(session.active_turn_id, None);
    assert!(
        session
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("Start a new turn"))
    );
    let runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "error");
    assert_eq!(
        runtime.resume_cursor,
        Some(json!({"threadId":"provider-thread-1"}))
    );
}

#[tokio::test]
async fn restart_reconciles_abandoned_ready_provider_sessions() {
    let engine = engine().await;
    engine
        .dispatch(OrchestrationCommand::ThreadSessionSet {
            command_id: "ready-session".to_owned(),
            thread_id: "t1".to_owned(),
            session: SessionInput {
                thread_id: "t1".to_owned(),
                status: "ready".to_owned(),
                provider_name: Some("codex".to_owned()),
                provider_instance_id: Some("codex".to_owned()),
                runtime_mode: "full-access".to_owned(),
                active_turn_id: None,
                last_error: None,
                updated_at: NOW.to_owned(),
            },
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    engine
        .repositories()
        .upsert_provider_session_runtime(ProviderSessionRuntime {
            thread_id: "t1".to_owned(),
            provider_name: "codex".to_owned(),
            provider_instance_id: Some("codex".to_owned()),
            adapter_key: "codex-app-server".to_owned(),
            runtime_mode: "full-access".to_owned(),
            status: "ready".to_owned(),
            last_seen_at: NOW.to_owned(),
            resume_cursor: Some(json!({"threadId":"provider-thread-ready"})),
            runtime_payload: None,
        })
        .await
        .unwrap();

    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();

    let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.thread_id == "t1")
        .unwrap();
    assert_eq!(session.status, "error");
    assert_eq!(session.active_turn_id, None);
    assert!(
        session
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("Start a new turn"))
    );
    let runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "error");
    assert_eq!(
        runtime.resume_cursor,
        Some(json!({"threadId":"provider-thread-ready"}))
    );
}

#[tokio::test]
async fn reconciliation_keeps_projection_failures_retryable_and_continues_later_rows() {
    let engine = engine().await;
    engine
        .repositories()
        .upsert_provider_session_runtime(persisted_runtime(
            "missing-thread",
            "ready",
            "2026-07-10T09:59:00.000Z",
        ))
        .await
        .unwrap();
    project_session(&engine, "t1", "ready").await;
    engine
        .repositories()
        .upsert_provider_session_runtime(persisted_runtime("t1", "ready", NOW))
        .await
        .unwrap();

    reconcile_abandoned_provider_sessions(&engine)
        .await
        .expect("one malformed persisted row must not abort startup reconciliation");

    let missing = engine
        .repositories()
        .get_provider_session_runtime("missing-thread".to_owned())
        .await
        .unwrap()
        .unwrap();
    let valid = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        missing.status, "ready",
        "failed projection remains retryable"
    );
    assert_eq!(valid.status, "error", "later rows still reconcile");
    let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .find(|session| session.thread_id == "t1")
            .unwrap()
            .status,
        "error"
    );

    engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"thread.create",
                "commandId":"create-missing-thread",
                "threadId":"missing-thread",
                "projectId":"p1",
                "title":"Recovered thread",
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access",
                "branch":null,
                "worktreePath":null,
                "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();
    let event_count = engine.read_events(0).await.unwrap().len();
    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();

    let recovered = engine
        .repositories()
        .get_provider_session_runtime("missing-thread".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.status, "error");
    assert_eq!(engine.read_events(0).await.unwrap().len(), event_count);
}

#[tokio::test]
async fn reconciliation_retries_runtime_write_after_projection_without_duplicate_events() {
    let (engine, database) = engine_and_database().await;
    project_session(&engine, "t1", "ready").await;
    engine
        .repositories()
        .upsert_provider_session_runtime(persisted_runtime("t1", "ready", NOW))
        .await
        .unwrap();
    database
        .call(|connection| {
            connection.execute_batch(
                "CREATE TRIGGER fail_provider_runtime_reconciliation
                 BEFORE UPDATE ON provider_session_runtime
                 WHEN NEW.thread_id = 't1' AND NEW.status = 'error'
                 BEGIN
                   SELECT RAISE(FAIL, 'injected provider runtime write failure');
                 END;",
            )?;
            Ok(())
        })
        .await
        .unwrap();

    reconcile_abandoned_provider_sessions(&engine)
        .await
        .expect("runtime write failure is isolated and retried on restart");

    let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .find(|session| session.thread_id == "t1")
            .unwrap()
            .status,
        "error",
        "projection is committed before marking the runtime row reconciled"
    );
    assert_eq!(
        engine
            .repositories()
            .get_provider_session_runtime("t1".to_owned())
            .await
            .unwrap()
            .unwrap()
            .status,
        "ready",
        "failed runtime write leaves the row eligible for retry"
    );
    let projected_event_count = engine.read_events(0).await.unwrap().len();

    database
        .call(|connection| {
            connection.execute_batch("DROP TRIGGER fail_provider_runtime_reconciliation;")?;
            Ok(())
        })
        .await
        .unwrap();
    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();
    assert_eq!(
        engine
            .repositories()
            .get_provider_session_runtime("t1".to_owned())
            .await
            .unwrap()
            .unwrap()
            .status,
        "error"
    );
    assert_eq!(
        engine.read_events(0).await.unwrap().len(),
        projected_event_count,
        "retry reuses the same reconciliation command"
    );

    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();
    assert_eq!(
        engine.read_events(0).await.unwrap().len(),
        projected_event_count,
        "completed reconciliation is idempotent"
    );
}

#[tokio::test]
async fn first_turn_autostarts_the_projected_native_provider() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    let command = OrchestrationCommand::ThreadTurnStart {
        command_id: "autostart-turn".to_owned(),
        thread_id: "t1".to_owned(),
        message: ThreadMessageInput {
            message_id: "autostart-message".to_owned(),
            role: "user".to_owned(),
            text: "start natively".to_owned(),
            attachments: vec![],
        },
        model_selection: None,
        title_seed: None,
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        bootstrap: None,
        source_proposed_plan: None,
        created_at: NOW.to_owned(),
    };
    engine.dispatch(command.clone()).await.unwrap();
    let settings = TempDir::new().unwrap();
    route_orchestration_command(
        &supervisor,
        &engine,
        &settings.path().to_path_buf(),
        command,
    )
    .await
    .unwrap();

    {
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.sends, ["start natively"]);
    }
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_runtime_accepts_durable_thread_settings_for_the_next_turn() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::new()),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    let settings = TempDir::new().unwrap();
    let commands = [
        json!({"type":"thread.runtime-mode.set","commandId":"runtime-mode","threadId":"t1","runtimeMode":"approval-required","createdAt":NOW}),
        json!({"type":"thread.interaction-mode.set","commandId":"interaction-mode","threadId":"t1","interactionMode":"plan","createdAt":NOW}),
        json!({"type":"thread.meta.update","commandId":"model","threadId":"t1","modelSelection":{"instanceId":"codex","model":"gpt-5.1"}}),
    ];

    for value in commands {
        let command: OrchestrationCommand = serde_json::from_value(value).unwrap();
        engine.dispatch(command.clone()).await.unwrap();
        route_orchestration_command(
            &supervisor,
            &engine,
            &settings.path().to_path_buf(),
            command,
        )
        .await
        .expect("durable settings remain valid without a live provider runtime");
    }

    assert_eq!(state.lock().unwrap().starts, 0);
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_runtime_rejects_ephemeral_commands_as_stale_session_actions() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::new()),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    let settings = TempDir::new().unwrap();
    let commands = [
        json!({"type":"thread.turn.interrupt","commandId":"interrupt","threadId":"t1","turnId":"turn-1","createdAt":NOW}),
        json!({"type":"thread.approval.respond","commandId":"approve","threadId":"t1","requestId":"r1","decision":"accept","createdAt":NOW}),
        json!({"type":"thread.user-input.respond","commandId":"answer","threadId":"t1","requestId":"r2","answers":{"q":"a"},"createdAt":NOW}),
        json!({"type":"thread.session.stop","commandId":"stop","threadId":"t1","createdAt":NOW}),
    ];

    for value in commands {
        let command: OrchestrationCommand = serde_json::from_value(value).unwrap();
        let action = command.command_type().to_owned();
        let error = route_orchestration_command(
            &supervisor,
            &engine,
            &settings.path().to_path_buf(),
            command,
        )
        .await
        .expect_err("missing runtime command must fail");
        let message = error.to_string();

        assert!(matches!(
            error,
            ProviderRuntimeError::StaleSession {
                thread_id,
                action: failed_action,
            } if thread_id == "t1" && failed_action == action
        ));
        assert!(message.contains("start a new turn"), "{message}");
    }

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn persisted_session_without_live_runtime_rejects_commands_until_next_turn_start() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let first_factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let first_supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        first_factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    first_supervisor.launch(launch()).await.unwrap();

    let replacement_factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::new()),
    });
    let replacement_supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        replacement_factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    let settings = TempDir::new().unwrap();
    let command: OrchestrationCommand = serde_json::from_value(json!({
        "type":"thread.approval.respond",
        "commandId":"stale-approval",
        "threadId":"t1",
        "requestId":"r1",
        "decision":"accept",
        "createdAt":NOW
    }))
    .unwrap();

    let error = route_orchestration_command(
        &replacement_supervisor,
        &engine,
        &settings.path().to_path_buf(),
        command,
    )
    .await
    .expect_err("lost live runtime must not acknowledge the command");

    assert!(matches!(
        error,
        ProviderRuntimeError::StaleSession { thread_id, action }
            if thread_id == "t1" && action == "thread.approval.respond"
    ));
    assert_eq!(state.lock().unwrap().starts, 1);

    replacement_supervisor.shutdown().await.unwrap();
    first_supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn normalizes_provider_approval_events_into_orchestration_projection() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();
    events_tx
        .send(ProviderEvent {
            native_event_id: None,
            event_type: "request.opened".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("approval-1".to_owned()),
            payload: json!({"requestType":"command_execution_approval","detail":"cargo test"}),
            activity: Vec::new(),
        })
        .await
        .unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let approvals = engine
                .repositories()
                .list_pending_approvals_by_thread("t1".to_owned())
                .await
                .unwrap();
            if approvals.len() == 1 {
                break approvals;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn projects_content_and_completion_into_a_settled_assistant_turn() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();
    let start = OrchestrationCommand::ThreadTurnStart {
        command_id: "turn".to_owned(),
        thread_id: "t1".to_owned(),
        message: ThreadMessageInput {
            message_id: "m1".to_owned(),
            role: "user".to_owned(),
            text: "hello".to_owned(),
            attachments: vec![],
        },
        model_selection: None,
        title_seed: None,
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        bootstrap: None,
        source_proposed_plan: None,
        created_at: NOW.to_owned(),
    };
    engine.dispatch(start.clone()).await.unwrap();
    supervisor.handle_orchestration(start).await.unwrap();

    for event in [
        ProviderEvent {
            native_event_id: None,
            event_type: "content.delta".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("provider-turn-1".to_owned()),
            request_id: None,
            payload: json!({"streamKind":"assistant_text","delta":"CODEX_OK"}),
            activity: Vec::new(),
        },
        ProviderEvent {
            native_event_id: None,
            event_type: "turn.completed".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("provider-turn-1".to_owned()),
            request_id: None,
            payload: json!({"state":"completed"}),
            activity: Vec::new(),
        },
    ] {
        events_tx.send(event).await.unwrap();
    }

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
            let assistant = snapshot
                .messages
                .iter()
                .find(|message| message.thread_id == "t1" && message.role == "assistant");
            let session = snapshot
                .sessions
                .iter()
                .find(|session| session.thread_id == "t1");
            let turn = snapshot.turns.iter().find(|turn| {
                turn.thread_id == "t1" && turn.turn_id.as_deref() == Some("provider-turn-1")
            });
            let runtime = engine
                .repositories()
                .get_provider_session_runtime("t1".to_owned())
                .await
                .unwrap();
            if assistant.is_some_and(|message| message.text == "CODEX_OK" && !message.is_streaming)
                && session.is_some_and(|session| {
                    session.status == "ready" && session.active_turn_id.is_none()
                })
                && turn.is_some_and(|turn| turn.state == "completed")
                && runtime.is_some_and(|runtime| runtime.status == "ready")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("provider completion must settle the projected turn");
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_provider_completion_clears_running_state_and_preserves_the_error() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (events_tx, events_rx) = mpsc::channel(4);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();
    let start = OrchestrationCommand::ThreadTurnStart {
        command_id: "failed-turn".to_owned(),
        thread_id: "t1".to_owned(),
        message: ThreadMessageInput {
            message_id: "m-failed".to_owned(),
            role: "user".to_owned(),
            text: "fail".to_owned(),
            attachments: vec![],
        },
        model_selection: None,
        title_seed: None,
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        bootstrap: None,
        source_proposed_plan: None,
        created_at: NOW.to_owned(),
    };
    engine.dispatch(start.clone()).await.unwrap();
    supervisor.handle_orchestration(start).await.unwrap();
    events_tx
        .send(ProviderEvent {
            native_event_id: None,
            event_type: "turn.completed".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("provider-turn-1".to_owned()),
            request_id: None,
            payload: json!({"state":"failed","error":{"message":"model unavailable"}}),
            activity: Vec::new(),
        })
        .await
        .unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
            let session = snapshot
                .sessions
                .iter()
                .find(|session| session.thread_id == "t1");
            let failure = snapshot
                .activities
                .iter()
                .find(|activity| activity.thread_id == "t1" && activity.kind == "provider.error");
            let assistant = snapshot
                .messages
                .iter()
                .find(|message| message.thread_id == "t1" && message.role == "assistant");
            let runtime = engine
                .repositories()
                .get_provider_session_runtime("t1".to_owned())
                .await
                .unwrap();
            if session.is_some_and(|session| {
                session.status == "error"
                    && session.active_turn_id.is_none()
                    && session.last_error.as_deref() == Some("model unavailable")
            }) && failure.is_some_and(|activity| {
                activity.tone == "error"
                    && activity.payload["error"]["message"] == "model unavailable"
            }) && assistant.is_none()
                && runtime.is_some_and(|runtime| runtime.status == "error")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("failed provider completion must be terminal and actionable");
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_stops_every_driver_and_removes_runtime_rows() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    supervisor.launch(launch()).await.unwrap();
    supervisor.shutdown().await.unwrap();
    assert_eq!(state.lock().unwrap().shutdowns, 1);
    assert!(
        engine
            .repositories()
            .get_provider_session_runtime("t1".to_owned())
            .await
            .unwrap()
            .is_none()
    );
}

#[test]
fn provider_driver_trait_is_send_and_sync() {
    fn assert_future<T: Future + Send>(_: Pin<Box<T>>) {}
    let _ = assert_future::<std::future::Ready<()>>;
    fn assert_driver<T: ProviderDriver + Send + Sync>() {}
    assert_driver::<FakeDriver>();
}

#[tokio::test]
async fn native_factory_rejects_unknown_providers_without_a_fallback() {
    let factory = NativeProviderDriverFactory::new(TempDir::new().unwrap().path().to_path_buf());
    let mut request = launch();
    request.provider = "node-fallback".to_owned();
    let error = match factory.create(request).await {
        Ok(_) => panic!("unknown provider unexpectedly created"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        ProviderRuntimeError::UnsupportedProvider { provider } if provider == "node-fallback"
    ));
}

#[tokio::test]
async fn native_factory_routes_resume_to_the_native_adapter_without_a_fallback() {
    let factory = NativeProviderDriverFactory::new(TempDir::new().unwrap().path().to_path_buf());
    let mut request = launch();
    request.provider = "opencode".to_owned();
    request.binary_path = "bibcode-missing-opencode-resume-fixture".to_owned();
    request.resume_cursor = Some(json!({"sessionId":"old-session"}));
    let error = match factory.create(request).await {
        Ok(_) => panic!("missing native provider unexpectedly spawned"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        ProviderRuntimeError::Spawn { provider, .. } if provider == "opencode"
    ));
}

#[tokio::test]
async fn native_factory_routes_every_supported_provider_to_its_native_adapter() {
    let factory = NativeProviderDriverFactory::new(TempDir::new().unwrap().path().to_path_buf());

    for provider in [
        "codex",
        "cursor",
        "grok",
        "opencode",
        "claude",
        "claudeAgent",
    ] {
        let mut request = launch();
        request.provider = provider.to_owned();
        request.binary_path = format!("bibcode-missing-{provider}-native-fixture");

        let error = match factory.create(request).await {
            Ok(_) => panic!("missing {provider} executable unexpectedly spawned"),
            Err(error) => error,
        };

        assert!(
            matches!(error, ProviderRuntimeError::Spawn { provider: ref actual, .. } if actual == provider),
            "unexpected native adapter error for {provider}: {error:?}"
        );
    }
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn supervisor_reaps_a_naturally_exited_native_provider_without_an_explicit_stop() {
    let engine = engine().await;
    let temp = TempDir::new().unwrap();
    let executable = executable_fixture(
        &temp,
        "naturally-exiting-claude",
        "#!/bin/sh\nsleep 1\n",
        "Start-Sleep -Seconds 1\n",
    );
    let registry = ProcessAttributionRegistry::new();
    let factory = Arc::new(NativeProviderDriverFactory::with_process_attribution(
        temp.path().join("attachments"),
        registry.clone(),
    ));
    let supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        factory,
        activity_projection(&engine),
        SupervisorOptions::default(),
    );
    let mut request = launch();
    request.provider = "claudeAgent".to_owned();
    request.provider_label = "Naturally Exiting Claude".to_owned();
    request.binary_path = executable.to_string_lossy().into_owned();
    request.cwd = temp.path().to_path_buf();

    supervisor.launch(request).await.unwrap();
    let rows = NativeProcessSampler::default().sample().await.unwrap();
    let claims = registry.bind_and_snapshot(&rows, Instant::now());
    let claim = claims
        .iter()
        .find(|claim| claim.label == "Naturally Exiting Claude")
        .expect("provider registration should bind while the child is alive");
    let bound_row = rows
        .into_iter()
        .find(|row| row.pid == claim.identity.pid && row.started_at == claim.identity.started_at)
        .expect("bound provider process row");

    timeout(Duration::from_secs(3), async {
        loop {
            if registry
                .bind_and_snapshot(
                    std::slice::from_ref::<ProcessRow>(&bound_row),
                    Instant::now(),
                )
                .is_empty()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("natural provider exit should release the registration lease");

    supervisor.shutdown().await.unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn native_claude_driver_supports_the_complete_live_command_surface() {
    let temp = TempDir::new().unwrap();
    let executable = executable_fixture(
        &temp,
        "claude-fixture",
        "#!/bin/sh\nprintf '%s\\n' 'ignored non-json output'\nprintf '%s\\n' 'fixture warning' >&2\ncat >/dev/null\n",
        WINDOWS_CLAUDE_FIXTURE,
    );

    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));
    let mut request = launch();
    request.provider = "claudeAgent".to_owned();
    request.binary_path = executable.to_string_lossy().into_owned();
    request.cwd = temp.path().to_path_buf();
    request.runtime_mode = "approval-required".to_owned();
    request.interaction_mode = "default".to_owned();
    request.model = Some("claude-sonnet".to_owned());
    request.agent = Some("reviewer".to_owned());
    request.resume_cursor = Some(json!({"sessionId":"claude-session"}));

    let driver = factory.create(request).await.unwrap();
    let started = driver.start().await.unwrap();
    assert_eq!(
        started.resume_cursor,
        Some(json!({"sessionId":"claude-session"}))
    );
    assert_eq!(
        started.runtime_payload,
        Some(json!({"transport":"stream-json"}))
    );
    assert_eq!(
        started.activity_capabilities,
        ActivityCapabilities::none(),
        "CLI flags and wrapper records alone must not claim attributed actors"
    );

    assert!(
        driver
            .send(
                "hello".to_owned(),
                vec![image_attachment(&temp)],
                "default".to_owned(),
            )
            .await
            .unwrap()
            .is_some()
    );
    driver.interrupt(None).await.unwrap();
    driver
        .approve("approval-1".to_owned(), "acceptForSession".to_owned())
        .await
        .unwrap();
    driver
        .approve("approval-2".to_owned(), "deny".to_owned())
        .await
        .unwrap();
    driver
        .set_mode("auto-accept-edits".to_owned())
        .await
        .unwrap();
    driver.set_mode("full-access".to_owned()).await.unwrap();
    driver
        .set_interaction_mode("plan".to_owned())
        .await
        .unwrap();
    driver
        .set_interaction_mode("default".to_owned())
        .await
        .unwrap();
    assert!(matches!(
        driver.set_model("other".to_owned()).await,
        Err(ProviderRuntimeError::UnsupportedCapability { provider, .. }) if provider == "claude"
    ));
    assert!(matches!(
        driver.rollback(1).await,
        Err(ProviderRuntimeError::UnsupportedCapability { provider, .. }) if provider == "claude"
    ));

    let event = timeout(Duration::from_secs(2), driver.next_event())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.event_type, "session.stderr");
    assert_eq!(event.payload, json!({"message":"fixture warning"}));
    driver.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn claude_transcript_recovery_safe_open_is_bounded_cancellable_and_replacement_safe() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let transcript = temp.path().join("child.jsonl");
    std::fs::write(&transcript, b"{\"record\":true}\n").unwrap();

    let opened = ClaudeTranscriptReaderFixture::read(&transcript, false).await;
    assert!(opened.opened);
    assert!(!opened.cancelled);
    assert_eq!(opened.bytes_read, 16);

    let missing =
        ClaudeTranscriptReaderFixture::read(&temp.path().join("missing.jsonl"), false).await;
    assert!(!missing.opened);
    assert!(!missing.cancelled);
    let directory = ClaudeTranscriptReaderFixture::read(temp.path(), false).await;
    assert!(!directory.opened);

    let cancelled = ClaudeTranscriptReaderFixture::read(&transcript, true).await;
    assert!(!cancelled.opened);
    assert!(cancelled.cancelled);

    let replacement_content = temp.path().join("replacement-content.jsonl");
    std::fs::write(&replacement_content, b"{\"replacement\":true}\n").unwrap();
    let replacement_link = temp.path().join("replacement-link.jsonl");
    symlink(&replacement_content, &replacement_link).unwrap();
    let replaced = ClaudeTranscriptReaderFixture::read_after_metadata_replacement(
        &transcript,
        &replacement_link,
    )
    .await;
    assert!(
        !replaced.opened,
        "a target replaced after canonical metadata must not be followed"
    );
}

#[test]
fn claude_transcript_recovery_windows_identity_requires_complete_metadata() {
    assert!(
        ClaudeTranscriptReaderFixture::windows_identity_matches(
            Some(7),
            Some(11),
            Some(7),
            Some(11)
        ),
        "complete matching file identities are accepted"
    );
    for identity in [
        (None, Some(11), None, Some(11)),
        (Some(7), None, Some(7), None),
        (None, None, None, None),
        (Some(7), Some(11), Some(8), Some(11)),
        (Some(7), Some(11), Some(7), Some(12)),
    ] {
        assert!(
            !ClaudeTranscriptReaderFixture::windows_identity_matches(
                identity.0, identity.1, identity.2, identity.3
            ),
            "missing or mismatched Windows metadata must be unavailable: {identity:?}"
        );
    }
}

#[tokio::test]
async fn claude_transcript_recovery_shutdown_cancels_idle_output_reads() {
    assert!(
        claude_output_shutdown_with_open_stream_for_test().await,
        "explicit shutdown must not wait for EOF from provider descendants that retain output pipes"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_transcript_recovery_shutdown_breaks_event_queue_backpressure() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let output_written_path = temp.path().join("output-written");
    let executable = executable_fixture(
        &temp,
        "claude-output-backpressure",
        r#"#!/bin/sh
case "$1" in
  --version) printf '%s\n' '2.1.218'; exit 0;;
  --help) printf '%s\n' '--include-hook-events --forward-subagent-text'; exit 0;;
esac
index=0
while [ "$index" -lt 512 ]; do
  printf 'queued stderr event %s\n' "$index" >&2
  index=$((index + 1))
done
: > "$BIBCODE_TEST_OUTPUT_WRITTEN"
cat >/dev/null
"#,
        "",
    );
    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));
    let mut request = launch();
    request.provider = "claudeAgent".to_owned();
    request.binary_path = executable.to_string_lossy().into_owned();
    request.cwd = temp.path().to_path_buf();
    request.environment.insert(
        "BIBCODE_TEST_OUTPUT_WRITTEN".to_owned(),
        output_written_path.to_string_lossy().into_owned(),
    );
    let driver = factory.create(request).await.unwrap();
    driver.start().await.unwrap();

    timeout(Duration::from_secs(2), async {
        while !output_written_path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture writes enough events to saturate the provider event queue");
    tokio::time::sleep(Duration::from_millis(50)).await;

    timeout(Duration::from_secs(1), driver.shutdown())
        .await
        .expect("shutdown must cancel producers blocked on a full event queue")
        .unwrap();
    loop {
        if timeout(Duration::from_secs(1), driver.next_event())
            .await
            .expect("event channel must close after queued events drain")
            .is_none()
        {
            break;
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn claude_transcript_recovery_worker_emits_bounded_activity_without_disclosing_paths() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let settings_path = temp.path().join("recovery-settings.json");
    let token_path = temp.path().join("recovery-token");
    let transcript_path = temp.path().join("child-agent.jsonl");
    std::fs::write(
        &transcript_path,
        [
            r#"{"type":"assistant","sessionId":"recovery-session","agentId":"agent-recovery","isSidechain":true,"uuid":"message-tool","timestamp":"2026-07-24T12:00:00Z","message":{"role":"assistant","content":[{"type":"text","text":"Recovered child work"},{"type":"tool_use","id":"tool-recovery","name":"Read","input":{"file_path":"/private/input"}}]}}"#,
            r#"{"type":"user","sessionId":"recovery-session","agentId":"agent-recovery","isSidechain":true,"uuid":"message-result","timestamp":"2026-07-24T12:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-recovery","content":"ok","is_error":false}]}}"#,
        ]
        .join("\n"),
    )
    .unwrap();
    let executable = executable_fixture(
        &temp,
        "claude-transcript-recovery",
        r#"#!/bin/sh
case "$1" in
  --version) printf '%s\n' '2.1.218'; exit 0;;
  --help) printf '%s\n' '--include-hook-events --forward-subagent-text'; exit 0;;
esac
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--settings" ]; then
    shift
    printf '%s' "$1" > "$BIBCODE_TEST_SETTINGS_CAPTURE"
    break
  fi
  shift
done
printf '%s' "$BIBCODE_CLAUDE_HOOK_TOKEN" > "$BIBCODE_TEST_TOKEN_CAPTURE"
cat >/dev/null
"#,
        "",
    );
    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));
    let mut request = launch();
    request.provider = "claudeAgent".to_owned();
    request.binary_path = executable.to_string_lossy().into_owned();
    request.cwd = temp.path().to_path_buf();
    request.resume_cursor = Some(json!({"sessionId":"recovery-session"}));
    request.environment.insert(
        "BIBCODE_TEST_SETTINGS_CAPTURE".to_owned(),
        settings_path.to_string_lossy().into_owned(),
    );
    request.environment.insert(
        "BIBCODE_TEST_TOKEN_CAPTURE".to_owned(),
        token_path.to_string_lossy().into_owned(),
    );
    let driver = factory.create(request).await.unwrap();
    driver.start().await.unwrap();
    timeout(Duration::from_secs(2), async {
        while !(settings_path.exists() && token_path.exists()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let settings: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
    let hook_url = settings["hooks"]["SubagentStart"][0]["hooks"][0]["url"]
        .as_str()
        .unwrap();
    let token = std::fs::read_to_string(&token_path).unwrap();
    let client = reqwest::Client::new();
    for hook in [
        json!({
            "hook_event_name":"SubagentStart",
            "session_id":"recovery-session",
            "agent_id":"agent-recovery",
            "agent_type":"Explore"
        }),
        json!({
            "hook_event_name":"SubagentStop",
            "session_id":"recovery-session",
            "agent_id":"agent-recovery",
            "agent_type":"Explore",
            "transcript_path":"/private/main-session-must-not-be-read.jsonl",
            "agent_transcript_path":transcript_path,
            "last_assistant_message":"done"
        }),
    ] {
        assert!(
            client
                .post(hook_url)
                .header("Authorization", format!("Bearer {token}"))
                .json(&hook)
                .send()
                .await
                .unwrap()
                .status()
                .is_success()
        );
    }

    let mut recovery_event = None;
    for _ in 0..3 {
        let event = timeout(Duration::from_secs(2), driver.next_event())
            .await
            .expect("worker must finish")
            .expect("provider event channel remains open");
        if event
            .native_event_id
            .as_ref()
            .is_some_and(|id| id.as_str().starts_with("claude:recovery:"))
        {
            recovery_event = Some(event);
            break;
        }
    }
    let recovery_event = recovery_event.expect("bounded recovery activity event");
    assert_eq!(recovery_event.event_type, "activity.native");
    assert!(matches!(
        recovery_event.activity.last(),
        Some(ProviderActivityMutation::SetScope {
            capabilities: ActivityCapabilities {
                actors: true,
                attributed_activity: true,
                history_recovery: ActivityHistoryRecovery::Bounded,
                ..
            },
            observation_state: ActivityObservationState::Live,
        })
    ));
    assert_eq!(
        recovery_event
            .activity
            .iter()
            .filter(|mutation| matches!(mutation, ProviderActivityMutation::AppendEntry(_)))
            .count(),
        3
    );
    let debug = format!("{recovery_event:?}");
    assert!(!debug.contains(transcript_path.to_string_lossy().as_ref()));
    assert!(!debug.contains("main-session-must-not-be-read"));

    let empty_supported_path = temp.path().join("child-empty-supported.jsonl");
    std::fs::write(
        &empty_supported_path,
        r#"{"type":"assistant","sessionId":"recovery-session","agentId":"agent-empty","isSidechain":true,"uuid":"thinking-only","timestamp":"2026-07-24T12:00:02Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"not activity"}]}}"#,
    )
    .unwrap();
    for hook in [
        json!({
            "hook_event_name":"SubagentStart",
            "session_id":"recovery-session",
            "agent_id":"agent-empty",
            "agent_type":"Explore"
        }),
        json!({
            "hook_event_name":"SubagentStop",
            "session_id":"recovery-session",
            "agent_id":"agent-empty",
            "agent_type":"Explore",
            "agent_transcript_path":empty_supported_path
        }),
    ] {
        client
            .post(hook_url)
            .header("Authorization", format!("Bearer {token}"))
            .json(&hook)
            .send()
            .await
            .unwrap();
    }
    let mut empty_recovery = None;
    for _ in 0..3 {
        let event = timeout(Duration::from_secs(2), driver.next_event())
            .await
            .unwrap()
            .unwrap();
        if event
            .native_event_id
            .as_ref()
            .is_some_and(|id| id.as_str().starts_with("claude:recovery:"))
        {
            empty_recovery = Some(event);
            break;
        }
    }
    assert!(matches!(
        empty_recovery
            .expect("correlation-valid scan with no supported entries")
            .activity
            .as_slice(),
        [ProviderActivityMutation::SetScope {
            capabilities: ActivityCapabilities {
                history_recovery: ActivityHistoryRecovery::Bounded,
                ..
            },
            ..
        }]
    ));

    for hook in [
        json!({
            "hook_event_name":"SubagentStart",
            "session_id":"recovery-session",
            "agent_id":"agent-missing",
            "agent_type":"Explore"
        }),
        json!({
            "hook_event_name":"SubagentStop",
            "session_id":"recovery-session",
            "agent_id":"agent-missing",
            "agent_type":"Explore",
            "agent_transcript_path":temp.path().join("missing-child.jsonl")
        }),
    ] {
        client
            .post(hook_url)
            .header("Authorization", format!("Bearer {token}"))
            .json(&hook)
            .send()
            .await
            .unwrap();
    }
    for _ in 0..2 {
        timeout(Duration::from_secs(2), driver.next_event())
            .await
            .expect("live hook activity remains functional")
            .expect("provider event");
    }
    assert!(
        timeout(Duration::from_millis(150), driver.next_event())
            .await
            .is_err(),
        "missing child transcript must not advertise a recovery handshake"
    );

    for index in 0..48 {
        let agent_id = format!("agent-cap-{index}");
        let path = temp.path().join(format!("child-cap-{index}.jsonl"));
        std::fs::write(
            &path,
            json!({
                "type":"system",
                "sessionId":"recovery-session",
                "agentId":agent_id,
                "isSidechain":true
            })
            .to_string(),
        )
        .unwrap();
        for hook in [
            json!({
                "hook_event_name":"SubagentStart",
                "session_id":"recovery-session",
                "agent_id":agent_id,
                "agent_type":"Explore"
            }),
            json!({
                "hook_event_name":"SubagentStop",
                "session_id":"recovery-session",
                "agent_id":agent_id,
                "agent_type":"Explore",
                "agent_transcript_path":path
            }),
        ] {
            client
                .post(hook_url)
                .header("Authorization", format!("Bearer {token}"))
                .json(&hook)
                .send()
                .await
                .unwrap();
        }
        for _ in 0..2 {
            timeout(Duration::from_secs(2), driver.next_event())
                .await
                .expect("live hook activity")
                .expect("provider event");
        }
        if index < 47 {
            let event = timeout(Duration::from_secs(2), driver.next_event())
                .await
                .expect("one bounded recovery per accepted target")
                .expect("provider event");
            assert!(
                event
                    .native_event_id
                    .as_ref()
                    .is_some_and(|id| id.as_str().starts_with("claude:recovery:"))
            );
        } else {
            assert!(
                timeout(Duration::from_millis(150), driver.next_event())
                    .await
                    .is_err(),
                "the 51st recovery target for one root must be ignored"
            );
        }
    }

    timeout(Duration::from_secs(2), driver.shutdown())
        .await
        .expect("shutdown cancels and joins transcript recovery")
        .unwrap();
    assert!(
        timeout(Duration::from_secs(2), driver.next_event())
            .await
            .expect("provider event channel closes after recovery shutdown")
            .is_none()
    );
}

#[test]
fn claude_launch_arguments_preserve_controls_and_gate_activity_flags() {
    let mut request = launch();
    request.provider = "claudeAgent".to_owned();
    request.runtime_mode = "approval-required".to_owned();
    request.interaction_mode = "default".to_owned();
    request.model = Some("claude-sonnet".to_owned());
    request.effort = Some("high".to_owned());
    request.agent = Some("reviewer".to_owned());
    request.resume_cursor = Some(json!({"sessionId":"resume-session"}));
    request.mcp = Some(ProviderMcpConfig {
        endpoint: "http://127.0.0.1:1234/mcp".to_owned(),
        authorization_header: "Bearer test".to_owned(),
        provider_session_id: "provider-session".to_owned(),
    });

    let supported = build_claude_launch_arguments_for_test(
        &request,
        "resume-session",
        ClaudeActivitySupport {
            include_hook_events: true,
            forward_subagent_text: true,
            transcript_recovery: false,
        },
    );
    assert_eq!(
        &supported[..9],
        [
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--include-hook-events",
            "--forward-subagent-text",
            "--verbose",
        ]
    );
    assert_eq!(
        supported
            .iter()
            .filter(|argument| argument.as_str() == "--include-hook-events")
            .count(),
        1
    );
    assert_eq!(
        supported
            .iter()
            .filter(|argument| argument.as_str() == "--forward-subagent-text")
            .count(),
        1
    );
    for pair in [
        ["--permission-mode", "default"],
        ["--resume", "resume-session"],
        ["--model", "claude-sonnet"],
        ["--effort", "high"],
        ["--agent", "reviewer"],
    ] {
        assert!(
            supported.windows(2).any(|window| window == pair),
            "missing preserved Claude launch pair {pair:?}: {supported:?}"
        );
    }
    assert!(supported.iter().any(|argument| argument == "--mcp-config"));

    let unsupported = build_claude_launch_arguments_for_test(
        &request,
        "resume-session",
        ClaudeActivitySupport::default(),
    );
    assert!(!unsupported.iter().any(|argument| {
        matches!(
            argument.as_str(),
            "--include-hook-events" | "--forward-subagent-text"
        )
    }));
    assert!(
        unsupported
            .windows(2)
            .any(|window| window == ["--effort", "high"])
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_activity_probe_is_cached_by_executable_identity() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let count_path = temp.path().join("probe-count");
    let script = format!(
        "#!/bin/sh\nprintf x >> '{}'\ncase \"$1\" in\n  --version) printf '%s\\n' '2.1.218';;\n  --help) printf '%s\\n' '--include-hook-events --forward-subagent-text';;\n  *) exit 1;;\nesac\n",
        count_path.display()
    );
    let executable = executable_fixture(&temp, "claude-probe", &script, "");

    let first = probe_claude_activity_support_for_test(executable.to_string_lossy().as_ref()).await;
    let second =
        probe_claude_activity_support_for_test(executable.to_string_lossy().as_ref()).await;

    assert_eq!(
        first,
        ClaudeActivitySupport {
            include_hook_events: true,
            forward_subagent_text: true,
            transcript_recovery: false,
        }
    );
    assert_eq!(second, first);
    assert_eq!(
        std::fs::read_to_string(count_path).expect("probe count"),
        "xx",
        "one version and one help invocation should serve repeated turns"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_activity_probe_singleflights_concurrent_misses() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let count_path = temp.path().join("probe-count");
    let script = format!(
        "#!/bin/sh\nprintf x >> '{}'\nsleep 0.1\ncase \"$1\" in\n  --version) printf '%s\\n' '2.1.218';;\n  --help) printf '%s\\n' '--include-hook-events --forward-subagent-text';;\n  *) exit 1;;\nesac\n",
        count_path.display()
    );
    let executable = executable_fixture(&temp, "claude-concurrent-probe", &script, "");
    let binary_path = executable.to_string_lossy().into_owned();
    let barrier = Arc::new(tokio::sync::Barrier::new(9));
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let barrier = barrier.clone();
        let binary_path = binary_path.clone();
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            probe_claude_activity_support_for_test(&binary_path).await
        }));
    }
    barrier.wait().await;
    for task in tasks {
        assert_eq!(
            task.await.unwrap(),
            ClaudeActivitySupport {
                include_hook_events: true,
                forward_subagent_text: true,
                transcript_recovery: false,
            }
        );
    }
    assert_eq!(
        std::fs::read_to_string(count_path).expect("probe count"),
        "xx",
        "concurrent misses must share one version/help probe"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_activity_probe_retries_transient_failures_without_poisoning_cache() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let marker_path = temp.path().join("failed-once");
    let count_path = temp.path().join("probe-count");
    let script = format!(
        "#!/bin/sh\nprintf x >> '{}'\nif [ \"$1\" = \"--version\" ] && [ ! -f '{}' ]; then touch '{}'; exit 1; fi\ncase \"$1\" in\n  --version) printf '%s\\n' '2.1.218';;\n  --help) printf '%s\\n' '--include-hook-events --forward-subagent-text';;\n  *) exit 1;;\nesac\n",
        count_path.display(),
        marker_path.display(),
        marker_path.display()
    );
    let executable = executable_fixture(&temp, "claude-retry-probe", &script, "");

    assert_eq!(
        probe_claude_activity_support_for_test(executable.to_string_lossy().as_ref()).await,
        ClaudeActivitySupport::default()
    );
    assert_eq!(
        probe_claude_activity_support_for_test(executable.to_string_lossy().as_ref()).await,
        ClaudeActivitySupport {
            include_hook_events: true,
            forward_subagent_text: true,
            transcript_recovery: false,
        }
    );
    assert_eq!(
        std::fs::read_to_string(count_path).expect("probe count"),
        "xxx",
        "a failed version probe must be retried, then cache the successful version/help pair"
    );
    assert_eq!(claude_activity_probe_cache_len_for_test().await, 1);
}

#[cfg(unix)]
#[tokio::test]
async fn claude_activity_probe_invalidates_on_executable_metadata_and_version_change() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let count_path = temp.path().join("probe-count");
    let first_script = format!(
        "#!/bin/sh\nprintf x >> '{}'\ncase \"$1\" in\n  --version) printf '%s\\n' '2.1.218';;\n  --help) printf '%s\\n' '--include-hook-events --forward-subagent-text';;\n  *) exit 1;;\nesac\n",
        count_path.display()
    );
    let executable = executable_fixture(&temp, "claude-changing-probe", &first_script, "");
    assert!(
        probe_claude_activity_support_for_test(executable.to_string_lossy().as_ref())
            .await
            .include_hook_events
    );

    let second_script = format!(
        "#!/bin/sh\nprintf x >> '{}'\n# changed executable metadata and output\ncase \"$1\" in\n  --version) printf '%s\\n' '2.1.219';;\n  --help) printf '%s\\n' '--unrelated-flag';;\n  *) exit 1;;\nesac\n",
        count_path.display()
    );
    std::fs::write(&executable, second_script).expect("changed probe fixture should write");
    let changed =
        probe_claude_activity_support_for_test(executable.to_string_lossy().as_ref()).await;

    assert_eq!(changed, ClaudeActivitySupport::default());
    assert_eq!(
        std::fs::read_to_string(count_path).expect("probe count"),
        "xxxx",
        "metadata/version changes must execute a new version/help probe"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_activity_probe_success_cache_is_lru_bounded() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    seed_claude_activity_probe_cache_for_test(65).await;

    assert_eq!(
        claude_activity_probe_cache_len_for_test().await,
        64,
        "the ready cache must prune its least recently used entry"
    );
    let cached_paths = claude_activity_probe_cache_paths_for_test().await;
    assert!(
        !cached_paths
            .iter()
            .any(|path| path == "/bibcode-test/claude-cache-0"),
        "the oldest executable must be evicted"
    );
    assert!(
        cached_paths
            .iter()
            .any(|path| path == "/bibcode-test/claude-cache-64"),
        "the newest executable must remain cached"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_activity_probe_timeout_downgrades_without_blocking_launch() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let executable = executable_fixture(
        &temp,
        "claude-slow-probe",
        "#!/bin/sh\ncase \"$1\" in\n  --version|--help) sleep 5; exit 0;;\n  *) cat >/dev/null;;\nesac\n",
        "",
    );
    let started_at = Instant::now();
    let support =
        probe_claude_activity_support_for_test(executable.to_string_lossy().as_ref()).await;

    assert_eq!(support, ClaudeActivitySupport::default());
    assert!(
        started_at.elapsed() < Duration::from_millis(2_750),
        "the complete probe must be bounded by its two-second timeout"
    );

    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));
    let mut request = launch();
    request.provider = "claudeAgent".to_owned();
    request.binary_path = executable.to_string_lossy().into_owned();
    request.cwd = temp.path().to_path_buf();
    let driver = factory.create(request).await.unwrap();
    assert_eq!(
        driver.start().await.unwrap().activity_capabilities,
        ActivityCapabilities::none()
    );
    driver.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn claude_activity_probe_deadline_covers_resolution_and_reaps_process_tree() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let descendant_pid_path = temp.path().join("descendant-pid");
    let script = format!(
        "#!/bin/sh\ncase \"$1\" in\n  --version|--help) sleep 30 & printf '%s' \"$!\" > '{}'; wait;;\n  *) cat >/dev/null;;\nesac\n",
        descendant_pid_path.display()
    );
    let executable = executable_fixture(&temp, "claude-probe-tree", &script, "");
    let binary_path = executable.to_string_lossy().into_owned();

    let resolution_started = Instant::now();
    assert_eq!(
        probe_claude_activity_support_with_resolution_delay_for_test(
            &binary_path,
            Duration::from_secs(5)
        )
        .await,
        ClaudeActivitySupport::default()
    );
    assert!(
        resolution_started.elapsed() < Duration::from_millis(2_250),
        "resolution, metadata, process work, and cleanup share one hard deadline"
    );

    let probe_started = Instant::now();
    assert_eq!(
        probe_claude_activity_support_for_test(&binary_path).await,
        ClaudeActivitySupport::default()
    );
    assert!(
        probe_started.elapsed() < Duration::from_millis(2_250),
        "a timed-out process tree must be terminated and reaped within the hard deadline"
    );
    let descendant_pid = std::fs::read_to_string(&descendant_pid_path)
        .expect("descendant pid")
        .parse::<u32>()
        .expect("numeric descendant pid");
    timeout(Duration::from_secs(1), async {
        loop {
            let alive = std::process::Command::new("kill")
                .args(["-0", &descendant_pid.to_string()])
                .status()
                .is_ok_and(|status| status.success());
            if !alive {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("probe descendant must not survive or remain zombie");
}

#[cfg(unix)]
#[tokio::test]
async fn native_claude_startup_capabilities_follow_hook_sink_availability() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let supported = executable_fixture(
        &temp,
        "claude-capabilities-supported",
        r#"#!/bin/sh
case "$1" in
  --version) printf '%s\n' '2.1.218'; exit 0;;
  --help) printf '%s\n' '--include-hook-events --forward-subagent-text'; exit 0;;
esac
cat >/dev/null
"#,
        "",
    );
    let unsupported = executable_fixture(
        &temp,
        "claude-capabilities-unsupported",
        "#!/bin/sh\ncase \"$1\" in\n  --version) printf '%s\\n' '2.1.218'; exit 0;;\n  --help) exit 0;;\nesac\ncat >/dev/null\n",
        "",
    );
    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));

    let mut supported_request = launch();
    supported_request.provider = "claudeAgent".to_owned();
    supported_request.binary_path = supported.to_string_lossy().into_owned();
    supported_request.cwd = temp.path().to_path_buf();
    let supported_driver = factory.create(supported_request).await.unwrap();
    assert_eq!(
        supported_driver
            .start()
            .await
            .unwrap()
            .activity_capabilities,
        ActivityCapabilities {
            actors: true,
            attributed_activity: true,
            background_work: false,
            history_recovery: ActivityHistoryRecovery::None,
            terminal_observation: false,
        }
    );
    supported_driver.shutdown().await.unwrap();

    let mut unsupported_request = launch();
    unsupported_request.provider = "claudeAgent".to_owned();
    unsupported_request.binary_path = unsupported.to_string_lossy().into_owned();
    unsupported_request.cwd = temp.path().to_path_buf();
    let unsupported_driver = factory.create(unsupported_request).await.unwrap();
    assert_eq!(
        unsupported_driver
            .start()
            .await
            .unwrap()
            .activity_capabilities,
        ActivityCapabilities::none()
    );
    unsupported_driver.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_claude_driver_routes_stable_hook_input_through_activity_plumbing() {
    let temp = TempDir::new().unwrap();
    let executable = executable_fixture(
        &temp,
        "claude-hook-input",
        r#"#!/bin/sh
case "$1" in
  --version) printf '%s\n' '2.1.218'; exit 0;;
  --help) printf '%s\n' '--include-hook-events --forward-subagent-text'; exit 0;;
esac
printf '%s\n' '{"type":"system","subtype":"hook_response","session_id":"hook-session","hook_event":"SubagentStart","hook_id":"wrapper-only","uuid":"wrapper-1"}'
printf '%s\n' '{"hook_event_name":"SubagentStart","session_id":"hook-session","agent_id":"agent-stable-1","agent_type":"Explore","transcript_path":"/tmp/hook-session.jsonl","cwd":"/workspace"}'
cat >/dev/null
"#,
        "",
    );
    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));
    let mut request = launch();
    request.provider = "claudeAgent".to_owned();
    request.binary_path = executable.to_string_lossy().into_owned();
    request.cwd = temp.path().to_path_buf();
    request.resume_cursor = Some(json!({"sessionId":"hook-session"}));
    let driver = factory.create(request).await.unwrap();

    assert_eq!(
        driver.start().await.unwrap().activity_capabilities,
        ActivityCapabilities {
            actors: true,
            attributed_activity: true,
            background_work: false,
            history_recovery: ActivityHistoryRecovery::None,
            terminal_observation: false,
        }
    );
    let event = timeout(Duration::from_secs(2), driver.next_event())
        .await
        .unwrap()
        .expect("activity event");
    assert_eq!(event.event_type, "activity.native");
    assert!(
        event
            .native_event_id
            .as_ref()
            .is_some_and(|id| id.as_str().starts_with("claude:hook:"))
    );
    assert_eq!(event.activity.len(), 3);
    assert!(matches!(
        &event.activity[0],
        ProviderActivityMutation::SetScope {
            capabilities: ActivityCapabilities {
                actors: true,
                attributed_activity: true,
                background_work: false,
                terminal_observation: false,
                ..
            },
            observation_state: ActivityObservationState::Live,
        }
    ));
    driver.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_claude_driver_captures_authenticated_http_hook_input_from_launch_settings() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let settings_path = temp.path().join("launch-settings.json");
    let token_path = temp.path().join("hook-token");
    let args_path = temp.path().join("launch-args");
    let executable = executable_fixture(
        &temp,
        "claude-http-hook",
        r#"#!/bin/sh
case "$1" in
  --version) printf '%s\n' '2.1.218'; exit 0;;
  --help) printf '%s\n' '--include-hook-events --forward-subagent-text'; exit 0;;
esac
printf '%s\n' "$@" > "$BIBCODE_TEST_ARGS_CAPTURE"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--settings" ]; then
    shift
    printf '%s' "$1" > "$BIBCODE_TEST_SETTINGS_CAPTURE"
    break
  fi
  shift
done
printf '%s' "$BIBCODE_CLAUDE_HOOK_TOKEN" > "$BIBCODE_TEST_TOKEN_CAPTURE"
cat >/dev/null
"#,
        "",
    );
    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));
    let mut request = launch();
    request.provider = "claudeAgent".to_owned();
    request.binary_path = executable.to_string_lossy().into_owned();
    request.cwd = temp.path().to_path_buf();
    request.resume_cursor = Some(json!({"sessionId":"http-hook-session"}));
    request.environment.insert(
        "BIBCODE_TEST_SETTINGS_CAPTURE".to_owned(),
        settings_path.to_string_lossy().into_owned(),
    );
    request.environment.insert(
        "BIBCODE_TEST_TOKEN_CAPTURE".to_owned(),
        token_path.to_string_lossy().into_owned(),
    );
    request.environment.insert(
        "BIBCODE_TEST_ARGS_CAPTURE".to_owned(),
        args_path.to_string_lossy().into_owned(),
    );
    let driver = factory.create(request).await.unwrap();
    assert_eq!(
        driver.start().await.unwrap().activity_capabilities,
        ActivityCapabilities {
            actors: true,
            attributed_activity: true,
            background_work: false,
            history_recovery: ActivityHistoryRecovery::None,
            terminal_observation: false,
        }
    );
    timeout(Duration::from_secs(2), async {
        while !(settings_path.exists() && token_path.exists() && args_path.exists()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture should capture launch settings");
    let settings: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
    let handler = &settings["hooks"]["SubagentStart"][0]["hooks"][0];
    assert_eq!(handler["type"], "http");
    assert_eq!(
        handler["allowedEnvVars"],
        json!(["BIBCODE_CLAUDE_HOOK_TOKEN"])
    );
    assert_eq!(
        handler["headers"]["Authorization"],
        "Bearer $BIBCODE_CLAUDE_HOOK_TOKEN"
    );
    let hook_url = handler["url"].as_str().expect("hook URL");
    assert!(hook_url.starts_with("http://127.0.0.1:"));
    for hook_name in [
        "SubagentStop",
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
    ] {
        assert_eq!(settings["hooks"][hook_name][0]["hooks"][0], *handler);
    }
    let token = std::fs::read_to_string(&token_path).unwrap();
    assert!(
        token.len() >= 64,
        "hook token must contain at least 256 bits"
    );
    assert!(
        !std::fs::read_to_string(&args_path)
            .unwrap()
            .contains(&token),
        "the secret must never appear in process arguments"
    );
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .post(hook_url)
            .header("Authorization", "Bearer wrong")
            .json(&json!({
                "hook_event_name":"SubagentStart",
                "session_id":"http-hook-session",
                "agent_id":"wrong-auth-agent",
                "agent_type":"Explore"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    assert_eq!(
        client
            .post(hook_url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .body(vec![b'x'; 70 * 1024])
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(
        timeout(Duration::from_millis(100), driver.next_event())
            .await
            .is_err(),
        "rejected requests must not enter the activity channel"
    );
    assert!(
        client
            .post(hook_url)
            .header("Authorization", format!("Bearer {token}"))
            .json(&json!({
                "hook_event_name":"SubagentStart",
                "session_id":"http-hook-session",
                "agent_id":"agent-http-1",
                "agent_type":"Explore",
                "transcript_path":"/tmp/http-hook-session.jsonl",
                "cwd":"/workspace"
            }))
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    let event = timeout(Duration::from_secs(2), driver.next_event())
        .await
        .unwrap()
        .expect("authenticated hook activity event");
    assert_eq!(event.event_type, "activity.native");
    assert_eq!(event.activity.len(), 3);

    driver.shutdown().await.unwrap();
    assert!(
        client
            .post(hook_url)
            .header("Authorization", format!("Bearer {token}"))
            .json(&json!({}))
            .send()
            .await
            .is_err(),
        "hook sink must stop with the driver"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn native_claude_driver_closes_hook_sink_and_event_channel_after_natural_exit() {
    let _probe_guard = CLAUDE_ACTIVITY_PROBE_TEST_LOCK.lock().await;
    reset_claude_activity_probe_cache_for_test().await;
    let temp = TempDir::new().unwrap();
    let settings_path = temp.path().join("natural-exit-settings.json");
    let token_path = temp.path().join("natural-exit-hook-token");
    let exit_release_path = temp.path().join("natural-exit-release");
    let executable = executable_fixture(
        &temp,
        "claude-http-hook-natural-exit",
        r#"#!/bin/sh
case "$1" in
  --version) printf '%s\n' '2.1.218'; exit 0;;
  --help) printf '%s\n' '--include-hook-events --forward-subagent-text'; exit 0;;
esac
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--settings" ]; then
    shift
    printf '%s' "$1" > "$BIBCODE_TEST_SETTINGS_CAPTURE"
    break
  fi
  shift
done
printf '%s' "$BIBCODE_CLAUDE_HOOK_TOKEN" > "$BIBCODE_TEST_TOKEN_CAPTURE"
while [ ! -f "$BIBCODE_TEST_EXIT_RELEASE" ]; do sleep 0.01; done
"#,
        "",
    );
    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));
    let mut request = launch();
    request.provider = "claudeAgent".to_owned();
    request.binary_path = executable.to_string_lossy().into_owned();
    request.cwd = temp.path().to_path_buf();
    request.resume_cursor = Some(json!({"sessionId":"natural-exit-hook-session"}));
    request.environment.insert(
        "BIBCODE_TEST_SETTINGS_CAPTURE".to_owned(),
        settings_path.to_string_lossy().into_owned(),
    );
    request.environment.insert(
        "BIBCODE_TEST_TOKEN_CAPTURE".to_owned(),
        token_path.to_string_lossy().into_owned(),
    );
    request.environment.insert(
        "BIBCODE_TEST_EXIT_RELEASE".to_owned(),
        exit_release_path.to_string_lossy().into_owned(),
    );
    let driver = factory.create(request).await.unwrap();
    driver.start().await.unwrap();

    timeout(Duration::from_secs(2), async {
        while !(settings_path.exists() && token_path.exists()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture should capture hook settings and token");
    let settings: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
    let hook_url = settings["hooks"]["SubagentStart"][0]["hooks"][0]["url"]
        .as_str()
        .expect("hook URL")
        .to_owned();
    let token = std::fs::read_to_string(&token_path).unwrap();
    let client = reqwest::Client::new();
    assert!(
        client
            .post(&hook_url)
            .header("Authorization", format!("Bearer {token}"))
            .json(&json!({
                "hook_event_name":"SubagentStart",
                "session_id":"natural-exit-hook-session",
                "agent_id":"agent-before-exit",
                "agent_type":"Explore"
            }))
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    let event = timeout(Duration::from_secs(2), driver.next_event())
        .await
        .unwrap()
        .expect("final accepted hook event");
    assert_eq!(event.event_type, "activity.native");

    std::fs::write(&exit_release_path, b"exit").unwrap();
    assert!(
        timeout(Duration::from_secs(2), driver.next_event())
            .await
            .expect("event channel must close after natural child exit")
            .is_none()
    );
    assert!(
        client
            .post(&hook_url)
            .header("Authorization", format!("Bearer {token}"))
            .json(&json!({}))
            .send()
            .await
            .is_err(),
        "hook endpoint must stop after natural child exit"
    );
}

#[tokio::test]
async fn native_opencode_driver_supports_session_turn_and_control_commands() {
    const CHILDREN_OBSERVED: usize = 1;
    const STATUS_OBSERVED: usize = 2;
    const HISTORY_OBSERVED: usize = 4;
    const LINEAGE_HANDSHAKE: usize = CHILDREN_OBSERVED | STATUS_OBSERVED | HISTORY_OBSERVED;
    let child_busy_release = Arc::new(tokio::sync::Notify::new());
    let reconciliation_observed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let event_release = child_busy_release.clone();
    let app = Router::new()
        .route(
            "/session",
            post(|| async { Json(json!({"id":"native-opencode-session"})) }),
        )
        .route(
            "/event",
            get(move || {
                let event_release = event_release.clone();
                async move {
                    let created = stream::once(async {
                        Ok::<Event, std::convert::Infallible>(
                            Event::default().data(
                                json!({
                                    "id": "native-child-created",
                                    "type": "session.created",
                                    "properties": {
                                        "sessionID": "native-opencode-child",
                                        "info": {
                                            "id": "native-opencode-child",
                                            "parentID": "native-opencode-session",
                                            "title": "Native child",
                                            "time": { "created": 1, "updated": 1 }
                                        }
                                    }
                                })
                                .to_string(),
                            ),
                        )
                    });
                    let busy = stream::once(async move {
                        event_release.notified().await;
                        Ok::<Event, std::convert::Infallible>(
                            Event::default().data(
                                json!({
                                    "id": "native-child-busy",
                                    "type": "session.status",
                                    "properties": {
                                        "sessionID": "native-opencode-child",
                                        "status": { "type": "busy" }
                                    }
                                })
                                .to_string(),
                            ),
                        )
                    });
                    Sse::new(created.chain(busy))
                }
            }),
        )
        .route(
            "/session/{session_id}/children",
            get({
                let reconciliation_observed = reconciliation_observed.clone();
                move |axum::extract::Path(session_id): axum::extract::Path<String>| {
                    let reconciliation_observed = reconciliation_observed.clone();
                    async move {
                        reconciliation_observed
                            .fetch_or(CHILDREN_OBSERVED, std::sync::atomic::Ordering::SeqCst);
                        Json(if session_id == "native-opencode-session" {
                            json!([{
                                "id": "native-opencode-child",
                                "parentID": "native-opencode-session",
                                "title": "Native child",
                                "time": { "created": 1, "updated": 1 }
                            }])
                        } else {
                            json!([])
                        })
                    }
                }
            }),
        )
        .route(
            "/session/status",
            get({
                let reconciliation_observed = reconciliation_observed.clone();
                move || {
                    let reconciliation_observed = reconciliation_observed.clone();
                    async move {
                        reconciliation_observed
                            .fetch_or(STATUS_OBSERVED, std::sync::atomic::Ordering::SeqCst);
                        Json(json!({
                            "native-opencode-session": { "type": "idle" },
                            "native-opencode-child": { "type": "idle" }
                        }))
                    }
                }
            }),
        )
        .route(
            "/session/{session_id}/prompt_async",
            post(|| async { Json(json!({})) }),
        )
        .route(
            "/session/{session_id}/command",
            post(|| async { Json(json!({})) }),
        )
        .route(
            "/session/{session_id}/abort",
            post(|| async { Json(json!({})) }),
        )
        .route(
            "/session/{session_id}/message",
            get({
                let reconciliation_observed = reconciliation_observed.clone();
                move |axum::extract::Path(session_id): axum::extract::Path<String>| {
                    let reconciliation_observed = reconciliation_observed.clone();
                    async move {
                        reconciliation_observed
                            .fetch_or(HISTORY_OBSERVED, std::sync::atomic::Ordering::SeqCst);
                        Json(if session_id == "native-opencode-child" {
                            json!([{
                                "info": {
                                    "id": "native-child-message",
                                    "sessionID": "native-opencode-child",
                                    "role": "assistant"
                                },
                                "parts": []
                            }])
                        } else {
                            json!([])
                        })
                    }
                }
            }),
        )
        .route(
            "/session/{session_id}/revert",
            post(|| async { Json(json!({})) }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let temp = TempDir::new().unwrap();
    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));
    let mut request = launch();
    request.provider = "opencode".to_owned();
    request.cwd = temp.path().to_path_buf();
    request.endpoint = Some(format!("http://{address}"));
    request.server_password = Some("secret".to_owned());
    request.agent = Some("reviewer".to_owned());
    request.model = Some("openai/gpt-5".to_owned());

    let driver = factory.create(request).await.unwrap();
    let activity_database = Database::open_in_memory().await.unwrap();
    activity_database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .unwrap();
    let activity_projection =
        ActivityProjection::new(ActivityRepository::new(activity_database));
    let activity_scope = ActivityScopeSeed::thread(
        "thread:native-opencode-driver",
        "native-opencode-driver",
        "opencode",
        Some("opencode"),
        ActivityCapabilities::none(),
    )
    .unwrap();
    activity_projection
        .ensure_scope(activity_scope.clone())
        .await
        .unwrap();
    let started = driver.start().await.unwrap();
    assert_eq!(
        started.resume_cursor,
        Some(json!({"sessionId":"native-opencode-session"}))
    );
    let event = timeout(Duration::from_secs(2), driver.next_event())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.event_type, "session.started");
    let admitted = timeout(Duration::from_secs(2), async {
        loop {
            let event = driver.next_event().await.expect("OpenCode provider event");
            if !event.activity.is_empty() {
                activity_projection
                    .apply(
                        &activity_scope.scope_id,
                        event
                            .native_event_id
                            .as_ref()
                            .expect("driver preserves reconciliation native ID")
                            .as_str()
                            .to_owned(),
                        event.activity.clone(),
                        "2026-07-25T12:20:00Z".to_owned(),
                    )
                    .await
                    .expect("driver reconciliation applies through the durable projection");
            }
            assert!(
                !event.activity.iter().any(|mutation| matches!(
                    mutation,
                    ProviderActivityMutation::UpsertActor(actor)
                        if actor.id == "opencode:session:native-opencode-child"
                            && actor.status.as_str() == "running"
                )),
                "child Busy must remain blocked until lineage admission"
            );
            if event.activity.iter().any(|mutation| {
                matches!(
                    mutation,
                    ProviderActivityMutation::UpsertActor(actor)
                        if actor.id == "opencode:session:native-opencode-child"
                            && actor.status.as_str() == "waiting"
                )
            }) {
                break;
            }
        }
    })
    .await
    .expect("OpenCode child lineage admission");
    assert_eq!(admitted, ());
    assert_eq!(
        reconciliation_observed.load(std::sync::atomic::Ordering::SeqCst) & LINEAGE_HANDSHAKE,
        LINEAGE_HANDSHAKE,
        "lineage admission requires children, status, and history reconciliation"
    );
    child_busy_release.notify_one();
    assert!(
        driver
            .send(
                "hello".to_owned(),
                vec![image_attachment(&temp)],
                "default".to_owned(),
            )
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        driver
            .send(
                "/review src/provider".to_owned(),
                Vec::new(),
                "default".to_owned(),
            )
            .await
            .unwrap()
            .is_some()
    );
    driver.interrupt(None).await.unwrap();
    driver.set_model("openai/gpt-5.4".to_owned()).await.unwrap();
    driver.rollback(0).await.unwrap();
    assert!(matches!(
        driver.rollback(-1).await,
        Err(ProviderRuntimeError::Provider { provider, .. }) if provider == "opencode"
    ));
    assert!(matches!(
        driver.set_mode("full-access".to_owned()).await,
        Err(ProviderRuntimeError::UnsupportedCapability { provider, .. }) if provider == "opencode"
    ));
    assert!(matches!(
        driver
            .approve("unknown".to_owned(), "accept".to_owned())
            .await,
        Err(ProviderRuntimeError::Provider { provider, .. }) if provider == "opencode"
    ));
    assert!(matches!(
        driver.answer("unknown".to_owned(), json!({})).await,
        Err(ProviderRuntimeError::Provider { provider, .. }) if provider == "opencode"
    ));
    let activity_event = timeout(Duration::from_secs(2), async {
        loop {
            let event = driver.next_event().await.expect("OpenCode provider event");
            if matches!(
                event.activity.as_slice(),
                [ProviderActivityMutation::UpsertActor(actor)]
                    if actor.id == "opencode:session:native-opencode-child"
                        && actor.status.as_str() == "running"
            ) {
                break event;
            }
        }
    })
    .await
    .expect("live OpenCode child activity");
    assert_eq!(activity_event.event_type, "activity.native");
    assert!(
        activity_event
            .native_event_id
            .as_ref()
            .is_some_and(|event_id| event_id.as_str().starts_with("opencode:activity:"))
    );
    activity_projection
        .apply(
            &activity_scope.scope_id,
            activity_event
                .native_event_id
                .as_ref()
                .expect("driver preserves live native ID")
                .as_str()
                .to_owned(),
            activity_event.activity.clone(),
            "2026-07-25T12:20:01Z".to_owned(),
        )
        .await
        .expect("driver live batch applies through the durable projection");
    let snapshot = activity_projection
        .snapshot(&activity_scope.scope)
        .await
        .expect("driver activity snapshot");
    assert!(snapshot.actors.iter().any(|actor| {
        actor.id == "opencode:session:native-opencode-child"
            && actor.status == ActivityLifecycle::Running
    }));
    driver.shutdown().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn native_codex_driver_supports_session_turn_and_control_commands() {
    let temp = TempDir::new().unwrap();
    let executable = executable_fixture(
        &temp,
        "codex-fixture",
        r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fixture"}}\n' "$id" ;;
    *'"method":"thread/start"'*) printf '{"id":%s,"result":{"cwd":"/tmp","model":"gpt-5","thread":{"id":"native-codex-thread"}}}\n' "$id" ;;
    *'"method":"thread/goal/set"'*) printf '{"id":%s,"result":{"goal":{"status":"active"}}}\n' "$id" ;;
    *'"method":"turn/start"'*) printf '{"id":%s,"result":{"turn":{"id":"native-codex-turn"}}}\n{"method":"item/started","emittedAtMs":1001,"params":{"threadId":"native-codex-thread","turnId":"native-codex-turn","item":{"id":"spawn-1","type":"collabAgentToolCall","tool":"spawnAgent","status":"inProgress","senderThreadId":"native-codex-thread","receiverThreadIds":["native-child"],"agentsStates":{"native-child":{"status":"running","message":null}}},"startedAtMs":1001}}\n' "$id" ;;
    *'"method":"turn/interrupt"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"thread/rollback"'*) printf '{"id":%s,"result":{"thread":{"id":"native-codex-thread","turns":[]}}}\n' "$id" ;;
    *'"method":"shutdown"'*) printf '{"id":%s,"result":null}\n' "$id" ;;
  esac
done
"#,
        WINDOWS_CODEX_FIXTURE,
    );

    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));
    let mut request = launch();
    request.provider = "codex".to_owned();
    request.binary_path = executable.to_string_lossy().into_owned();
    request.cwd = temp.path().to_path_buf();
    let driver = factory.create(request).await.unwrap();

    let started = timeout(Duration::from_secs(2), driver.start())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        started.resume_cursor,
        Some(json!({"threadId":"native-codex-thread"}))
    );
    assert_eq!(
        started.activity_capabilities,
        ActivityCapabilities {
            actors: true,
            attributed_activity: true,
            background_work: false,
            history_recovery: ActivityHistoryRecovery::None,
            terminal_observation: false,
        }
    );
    assert!(
        driver
            .send(
                "hello".to_owned(),
                vec![image_attachment(&temp)],
                "default".to_owned(),
            )
            .await
            .unwrap()
            .is_some()
    );
    let activity_event = timeout(Duration::from_secs(2), async {
        loop {
            let event = driver.next_event().await.expect("Codex provider event");
            if !event.activity.is_empty() {
                break event;
            }
        }
    })
    .await
    .expect("live Codex activity event");
    assert_eq!(
        activity_event
            .native_event_id
            .as_ref()
            .map(ProviderNativeEventId::as_str),
        Some("codex:activity:0")
    );
    assert_eq!(activity_event.event_type, "activity.native");
    assert!(matches!(
        activity_event.activity.as_slice(),
        [ProviderActivityMutation::UpsertActor(actor)]
            if actor.id == "codex:thread:native-child"
    ));
    assert!(
        driver
            .send(
                "/goal finish coverage".to_owned(),
                Vec::new(),
                "default".to_owned(),
            )
            .await
            .unwrap()
            .is_some()
    );
    driver.interrupt(None).await.unwrap();
    driver.rollback(0).await.unwrap();
    assert!(matches!(
        driver.rollback(-1).await,
        Err(ProviderRuntimeError::Provider { provider, .. }) if provider == "codex"
    ));
    assert!(matches!(
        driver.set_mode("approval-required".to_owned()).await,
        Err(ProviderRuntimeError::UnsupportedCapability { provider, .. }) if provider == "codex"
    ));
    assert!(matches!(
        driver.set_model("other".to_owned()).await,
        Err(ProviderRuntimeError::UnsupportedCapability { provider, .. }) if provider == "codex"
    ));
    assert!(matches!(
        driver
            .approve("unknown".to_owned(), "accept".to_owned())
            .await,
        Err(ProviderRuntimeError::Provider { provider, .. }) if provider == "codex"
    ));
    assert!(matches!(
        driver.answer("unknown".to_owned(), json!({})).await,
        Err(ProviderRuntimeError::Provider { provider, .. }) if provider == "codex"
    ));
    driver.shutdown().await.unwrap();
}

#[tokio::test]
async fn native_acp_drivers_support_session_turn_and_control_commands() {
    let temp = TempDir::new().unwrap();
    let executable = executable_fixture(
        &temp,
        "acp-fixture",
        r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*|*'"method":"authenticate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"session/new"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"cursor-session","configOptions":[{"id":"model","category":"model"}],"modes":{"currentModeId":"ask","availableModes":[{"id":"ask","name":"Ask"},{"id":"code","name":"Agent"},{"id":"architect","name":"Plan"}]}}}\n' "$id" ;;
    *'"method":"session/create"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"grok-session","modes":{"currentModeId":"code","availableModes":[{"id":"code","name":"Agent"},{"id":"ask","name":"Ask"}]}}}\n' "$id" ;;
    *'"method":"session/set_config_option"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"configOptions":[]}}\n' "$id" ;;
    *'"method":"session/set_mode"'*|*'"method":"session/set_model"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"session/prompt"'*) sleep 0.1; printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id" ;;
  esac
done
"#,
        WINDOWS_ACP_FIXTURE,
    );
    let factory = NativeProviderDriverFactory::new(temp.path().join("attachments"));

    let mut cursor_request = launch();
    cursor_request.provider = "cursor".to_owned();
    cursor_request.binary_path = executable.to_string_lossy().into_owned();
    cursor_request.cwd = temp.path().to_path_buf();
    cursor_request.model = Some("gpt-5.4".to_owned());
    cursor_request.runtime_mode = "approval-required".to_owned();
    let cursor = factory.create(cursor_request).await.unwrap();
    assert_eq!(
        cursor.start().await.unwrap().resume_cursor,
        Some(json!({"schemaVersion":1,"sessionId":"cursor-session"}))
    );
    let cursor_turn = cursor
        .send(
            "hello".to_owned(),
            vec![image_attachment(&temp)],
            "default".to_owned(),
        )
        .await
        .unwrap()
        .unwrap();
    cursor.interrupt(Some(cursor_turn)).await.unwrap();
    cursor.set_model("gpt-5.5".to_owned()).await.unwrap();
    cursor
        .set_mode("auto-accept-edits".to_owned())
        .await
        .unwrap();
    cursor
        .set_interaction_mode("plan".to_owned())
        .await
        .unwrap();
    assert!(matches!(
        cursor.rollback(1).await,
        Err(ProviderRuntimeError::UnsupportedCapability { provider, .. }) if provider == "cursor"
    ));
    assert!(matches!(
        cursor
            .approve("unknown".to_owned(), "accept".to_owned())
            .await,
        Err(ProviderRuntimeError::Provider { provider, .. }) if provider == "cursor"
    ));
    assert!(matches!(
        cursor.answer("unknown".to_owned(), json!({})).await,
        Err(ProviderRuntimeError::Provider { provider, .. }) if provider == "cursor"
    ));
    cursor.shutdown().await.unwrap();

    let mut grok_request = launch();
    grok_request.provider = "grok".to_owned();
    grok_request.binary_path = executable.to_string_lossy().into_owned();
    grok_request.cwd = temp.path().to_path_buf();
    grok_request.runtime_mode = "approval-required".to_owned();
    let grok = factory.create(grok_request).await.unwrap();
    assert_eq!(
        grok.start().await.unwrap().resume_cursor,
        Some(json!({"schemaVersion":1,"sessionId":"grok-session"}))
    );
    let grok_turn = grok
        .send(
            "hello".to_owned(),
            vec![image_attachment(&temp)],
            "default".to_owned(),
        )
        .await
        .unwrap()
        .unwrap();
    grok.interrupt(Some(grok_turn)).await.unwrap();
    grok.interrupt(None).await.unwrap();
    grok.set_model("grok-build".to_owned()).await.unwrap();
    grok.set_mode("full-access".to_owned()).await.unwrap();
    grok.set_interaction_mode("default".to_owned())
        .await
        .unwrap();
    assert!(matches!(
        grok.rollback(1).await,
        Err(ProviderRuntimeError::UnsupportedCapability { provider, .. }) if provider == "grok"
    ));
    assert!(matches!(
        grok.approve("unknown".to_owned(), "accept".to_owned()).await,
        Err(ProviderRuntimeError::Provider { provider, .. }) if provider == "grok"
    ));
    assert!(matches!(
        grok.answer("unknown".to_owned(), json!({})).await,
        Err(ProviderRuntimeError::Provider { provider, .. }) if provider == "grok"
    ));
    grok.shutdown().await.unwrap();
}
