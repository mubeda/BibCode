//! The terminal tools for outside agents (#139 slice T) through the real terminal RPCs and
//! `TerminalManager`: three gates (the Terminals set, the `terminal:operate` scope minted with
//! the credential, and a Full access ceiling), bounded reads with a cursor, and writes that
//! never reach a log or the profiler. Most tests use an echoing fake PTY; the shell test runs
//! a real `/bin/sh`.

use std::sync::{
    Mutex,
    atomic::{AtomicU32, Ordering},
};

use tokio::sync::broadcast;

use super::*;
use crate::{
    auth::SCOPE_TERMINAL_OPERATE,
    cloud::{RelayClientInstallEvent, RelayClientService, RelayClientStatus},
    diagnostics::{
        DiagnosticsMonitor, NativeProcessSampler, NativeResourceSampler,
        NotApplicableUiProcessObserver, ProcessAttributionRegistry, ProcessIdentity,
    },
    production::server_terminal::{
        JsonFuture, JsonStream, ProductionServerControl, ServerTerminalServices,
        register_server_terminal_rpc,
    },
    provider_usage::ProviderUsageService,
    terminal::{
        PtyBackend, PtyExit, PtyProcess, PtySpawnInput, TerminalManager, TerminalManagerOptions,
    },
};

const THREAD: &str = "terminal-thread";
const TOOLS: &[&str] = &[
    "terminal_list",
    "terminal_open",
    "terminal_write",
    "terminal_read",
    "terminal_resize",
    "terminal_close",
];

/// A PTY that echoes what is written, as a terminal's line discipline does, and emits
/// whatever a test asks.
#[derive(Debug)]
struct EchoPty {
    identity: ProcessIdentity,
    writes: Mutex<Vec<String>>,
    output: broadcast::Sender<String>,
    exit: watch::Sender<Option<PtyExit>>,
    /// While set, a write blocks, as a PTY write does when the child reads no input.
    stuck: Mutex<bool>,
    unstuck: std::sync::Condvar,
}

impl EchoPty {
    fn emit(&self, data: &str) {
        let _ = self.output.send(data.to_owned());
    }

    fn set_stuck(&self, stuck: bool) {
        *self.stuck.lock().unwrap() = stuck;
        self.unstuck.notify_all();
    }
}

/// Lets a held write go when the test ends, so a failed test fails instead of waiting for
/// the blocking thread.
struct Unstick(Arc<EchoPty>);

impl Drop for Unstick {
    fn drop(&mut self) {
        self.0.set_stuck(false);
    }
}

impl PtyProcess for EchoPty {
    fn pid(&self) -> u32 {
        self.identity.pid
    }

    fn process_identity(&self) -> Option<ProcessIdentity> {
        Some(self.identity)
    }

    fn write(&self, data: &str) -> Result<(), String> {
        drop(
            self.unstuck
                .wait_while(self.stuck.lock().unwrap(), |stuck| *stuck)
                .unwrap(),
        );
        self.writes.lock().unwrap().push(data.to_owned());
        self.emit(data);
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), String> {
        Ok(())
    }

    fn kill(&self) -> Result<(), String> {
        self.exit.send_replace(Some(PtyExit {
            exit_code: None,
            signal: None,
        }));
        Ok(())
    }

    fn wait_for_process_tree_exit(&self, _timeout: Duration) -> Result<Option<bool>, String> {
        Ok(Some(true))
    }

    fn subscribe_output(&self) -> broadcast::Receiver<String> {
        self.output.subscribe()
    }

    fn subscribe_exit(&self) -> watch::Receiver<Option<PtyExit>> {
        self.exit.subscribe()
    }
}

#[derive(Debug, Default)]
struct EchoBackend {
    processes: Mutex<Vec<Arc<EchoPty>>>,
}

impl EchoBackend {
    fn latest(&self) -> Arc<EchoPty> {
        self.processes
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("spawned")
    }

    fn writes(&self) -> Vec<String> {
        self.processes
            .lock()
            .unwrap()
            .iter()
            .flat_map(|process| process.writes.lock().unwrap().clone())
            .collect()
    }
}

impl PtyBackend for EchoBackend {
    fn spawn(&self, _input: &PtySpawnInput) -> Result<Arc<dyn PtyProcess>, String> {
        // Above every platform's pid range, so no real process is ever named.
        static NEXT: AtomicU32 = AtomicU32::new(900_000_000);
        let (output, _) = broadcast::channel(1_024);
        let (exit, _) = watch::channel(None);
        let process = Arc::new(EchoPty {
            identity: ProcessIdentity {
                pid: NEXT.fetch_add(1, Ordering::Relaxed),
                started_at: 1,
            },
            writes: Mutex::new(Vec::new()),
            output,
            exit,
            stuck: Mutex::new(false),
            unstuck: std::sync::Condvar::new(),
        });
        self.processes.lock().unwrap().push(process.clone());
        Ok(process)
    }
}

#[derive(Debug)]
struct NullControl;

impl ProductionServerControl for NullControl {
    fn call(&self, _: &'static str, _: Value, _: CancellationToken) -> JsonFuture {
        Box::pin(async { Ok(Value::Null) })
    }

    fn subscribe(&self, _: &'static str, _: CancellationToken) -> JsonStream {
        tokio::sync::mpsc::channel(1).1
    }
}

fn terminal_services(manager: TerminalManager) -> ServerTerminalServices {
    let sampler = Arc::new(NativeProcessSampler::default());
    let resource_sampler = Arc::new(NativeResourceSampler::new(
        sampler.clone(),
        ProcessAttributionRegistry::new(),
        Arc::new(NotApplicableUiProcessObserver),
    ));
    let monitor = Arc::new(DiagnosticsMonitor::new(
        resource_sampler.clone(),
        Duration::from_secs(60),
    ));
    let relay = RelayClientService::new(
        || async {
            RelayClientStatus::Missing {
                version: "1.0.0".to_owned(),
            }
        },
        |_report: Arc<dyn Fn(RelayClientInstallEvent) -> _ + Send + Sync>| async {
            Ok(RelayClientStatus::Missing {
                version: "1.0.0".to_owned(),
            })
        },
    );
    ServerTerminalServices::new(
        manager,
        sampler,
        resource_sampler,
        monitor,
        ProviderUsageService::new(Vec::new(), Arc::new(time::OffsetDateTime::now_utc)),
        relay,
        Arc::new(NullControl),
    )
}

struct Fixture {
    harness: Harness,
    manager: TerminalManager,
}

impl Fixture {
    /// A harness with the real terminal RPCs on `backend`, the thread `THREAD`, and the
    /// Terminals set on.
    async fn new(backend: Arc<dyn PtyBackend>, shell: Option<&str>) -> Self {
        let manager = TerminalManager::new(
            backend,
            TerminalManagerOptions {
                preferred_shell: shell.map(str::to_owned),
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let services = terminal_services(manager.clone());
        let harness =
            Harness::with_methods(|registry| register_server_terminal_rpc(registry, services))
                .await;
        harness.control.attach_terminals(manager.clone());
        harness
            .engine
            .dispatch(command(json!({
                "type": "thread.create", "commandId": "create-terminal-thread",
                "threadId": THREAD, "projectId": "p1", "title": "Terminals",
                "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
                "runtimeMode": "full-access", "interactionMode": "default", "branch": null,
                "worktreePath": null, "createdAt": CREATED_AT,
            })))
            .await
            .expect("thread created");
        harness
            .settings
            .send_modify(|settings| settings.capabilities.terminals = true);
        Self { harness, manager }
    }

    async fn echo() -> (Self, Arc<EchoBackend>) {
        let backend = Arc::new(EchoBackend::default());
        (Self::new(backend.clone(), None).await, backend)
    }

    /// An outside agent whose credential holds `terminal:operate`, as the relay mints one
    /// while Terminals is on at Full access.
    async fn agent(&self) -> ClientPrincipal {
        let link = issue_mcp_pairing_link(
            &self.harness.repositories,
            "MCP · terminal test".into(),
            McpAccess::FullAccess.as_str(),
            &[SCOPE_TERMINAL_OPERATE],
        )
        .await
        .expect("link");
        let session = self
            .harness
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
        self.harness
            .control
            .authenticate(&session.token)
            .await
            .expect("an MCP credential")
    }

    async fn call(&self, agent: &ClientPrincipal, tool: &str, arguments: Value) -> Value {
        self.harness.call(agent, tool, arguments).await
    }

    async fn open(&self, agent: &ClientPrincipal) -> String {
        let opened = self
            .call(agent, "terminal_open", json!({ "threadId": THREAD }))
            .await;
        structured(&opened)["terminalId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn read(&self, agent: &ClientPrincipal, arguments: Value) -> Value {
        let mut arguments = arguments;
        arguments["threadId"] = json!(THREAD);
        structured(&self.call(agent, "terminal_read", arguments).await).clone()
    }

    /// Reads until `wanted` shows up in the page, as an agent polls.
    async fn read_until(&self, agent: &ClientPrincipal, arguments: Value, wanted: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let page = self.read(agent, arguments.clone()).await;
                if page["text"].as_str().unwrap().contains(wanted) {
                    return page;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{wanted} never showed up"))
    }

    async fn listed(&self, agent: &ClientPrincipal) -> Vec<String> {
        self.harness
            .control
            .tools(agent)
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect()
    }

    async fn shutdown(self) {
        self.manager.shutdown().await;
        self.harness.shutdown().await;
    }
}

#[tokio::test]
async fn terminals_are_hidden_and_refused_until_the_setting_is_on() {
    let (fixture, _) = Fixture::echo().await;
    let agent = fixture.agent().await;
    fixture
        .harness
        .settings
        .send_modify(|settings| settings.capabilities.terminals = false);
    let listed = fixture.listed(&agent).await;
    assert!(
        TOOLS
            .iter()
            .all(|tool| !listed.contains(&(*tool).to_owned()))
    );
    for tool in TOOLS {
        let refused = fixture
            .call(&agent, tool, json!({ "threadId": THREAD }))
            .await;
        assert_eq!(error_tag(&refused), "McpCapabilityDisabledError", "{tool}");
        assert!(
            refused["structuredContent"]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Terminals")
        );
    }

    fixture
        .harness
        .settings
        .send_modify(|settings| settings.capabilities.terminals = true);
    let tools = fixture.harness.control.tools(&agent);
    let hints = |name: &str| {
        tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} is listed"))["annotations"]
            .clone()
    };
    assert_eq!(hints("terminal_list")["readOnlyHint"], true);
    assert_eq!(hints("terminal_read")["readOnlyHint"], true);
    assert_eq!(hints("terminal_write")["destructiveHint"], true);
    assert_eq!(hints("terminal_close")["destructiveHint"], true);
    assert_eq!(hints("terminal_resize")["idempotentHint"], true);
    assert_eq!(hints("terminal_open")["idempotentHint"], false);
    assert_eq!(hints("terminal_write")["idempotentHint"], false);
    fixture.shutdown().await;
}

#[tokio::test]
async fn below_full_access_the_terminal_tools_are_refused_naming_agents_may() {
    let (fixture, _) = Fixture::echo().await;
    let agent = fixture.agent().await;
    for access in [McpAccess::AutoAcceptEdits, McpAccess::ApprovalRequired] {
        fixture
            .harness
            .settings
            .send_modify(|settings| settings.access = access);
        for tool in TOOLS {
            let refused = fixture
                .call(&agent, tool, json!({ "threadId": THREAD }))
                .await;
            assert_eq!(error_tag(&refused), "McpAccessCeilingError", "{tool}");
            assert!(
                refused["structuredContent"]["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("Agents may"),
                "{refused}"
            );
        }
    }
    // Read only refuses the reads too.
    fixture
        .harness
        .settings
        .send_modify(|settings| settings.access = McpAccess::ReadOnly);
    let refused = fixture
        .call(&agent, "terminal_list", json!({ "threadId": THREAD }))
        .await;
    assert_eq!(error_tag(&refused), "McpAccessCeilingError");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_credential_minted_without_the_terminal_scope_is_refused() {
    let (fixture, _) = Fixture::echo().await;
    let (agent, _) = fixture.harness.agent(McpAccess::FullAccess).await;
    for tool in TOOLS {
        let refused = fixture
            .call(&agent, tool, json!({ "threadId": THREAD }))
            .await;
        assert_eq!(error_tag(&refused), "McpScopeError", "{tool}");
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn turning_terminals_off_mid_session_refuses_the_next_call() {
    let (fixture, _) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    fixture
        .harness
        .settings
        .send_modify(|settings| settings.capabilities.terminals = false);
    let refused = fixture
        .call(
            &agent,
            "terminal_write",
            json!({ "threadId": THREAD, "terminalId": terminal_id, "data": "ls\n" }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpCapabilityDisabledError");
    fixture
        .harness
        .settings
        .send_modify(|settings| settings.capabilities.terminals = true);
    fixture
        .harness
        .settings
        .send_modify(|settings| settings.access = McpAccess::ApprovalRequired);
    let refused = fixture
        .call(
            &agent,
            "terminal_read",
            json!({ "threadId": THREAD, "terminalId": terminal_id }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpAccessCeilingError");
    fixture.shutdown().await;
}

/// The whole loop on a real shell: open, write, read the tail, then read only what came after
/// the cursor; resize, close, and the closed terminal is gone.
#[cfg(unix)]
#[tokio::test]
async fn an_agent_runs_a_command_in_a_real_shell_and_reads_only_new_output_from_its_cursor() {
    let fixture = Fixture::new(
        Arc::new(crate::terminal::PortablePtyBackend),
        Some("/bin/sh"),
    )
    .await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    assert!(terminal_id.starts_with("mcp-"), "{terminal_id}");
    let listed = structured(
        &fixture
            .call(&agent, "terminal_list", json!({ "threadId": THREAD }))
            .await,
    )
    .clone();
    assert_eq!(listed["terminals"][0]["terminalId"], terminal_id);
    assert_eq!(listed["terminals"][0]["status"], "running");

    let write = |data: &str| {
        fixture.call(
            &agent,
            "terminal_write",
            json!({ "threadId": THREAD, "terminalId": terminal_id, "data": data }),
        )
    };
    // The echoed command reads `40+2`; only the shell's answer reads 42.
    structured(&write("echo $((40+2))\n").await);
    let first = fixture
        .read_until(&agent, json!({ "terminalId": terminal_id }), "42")
        .await;
    assert_eq!(first["dropped"], false);
    assert_eq!(first["status"], "running");
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    structured(&write("echo $((50+5))\n").await);
    let next = fixture
        .read_until(
            &agent,
            json!({ "terminalId": terminal_id, "cursor": cursor }),
            "55",
        )
        .await;
    let text = next["text"].as_str().unwrap();
    assert!(!text.contains("42"), "{text}");
    assert!(!text.contains('\u{1b}'), "escapes are stripped: {text:?}");

    let resized = fixture
        .call(
            &agent,
            "terminal_resize",
            json!({ "threadId": THREAD, "terminalId": terminal_id, "cols": 100, "rows": 40 }),
        )
        .await;
    structured(&resized);
    let closed = fixture
        .call(
            &agent,
            "terminal_close",
            json!({ "threadId": THREAD, "terminalId": terminal_id }),
        )
        .await;
    structured(&closed);
    let listed = structured(
        &fixture
            .call(&agent, "terminal_list", json!({ "threadId": THREAD }))
            .await,
    )
    .clone();
    assert_eq!(listed["terminals"], json!([]));
    let gone = fixture
        .call(
            &agent,
            "terminal_read",
            json!({ "threadId": THREAD, "terminalId": terminal_id }),
        )
        .await;
    assert_eq!(error_tag(&gone), "McpTerminalNotFoundError");
    fixture.shutdown().await;
}

/// The UI adopts only a center-panel terminal, on its host thread, so an agent's terminal
/// opens as one; a chat panel's thread uses its host's terminals.
#[tokio::test]
async fn an_agents_terminal_is_a_center_panel_of_the_host_thread() {
    let (fixture, _) = Fixture::echo().await;
    fixture
        .harness
        .engine
        .dispatch(command(json!({
            "type": "thread.create", "commandId": "create-terminal-panel",
            "threadId": "terminal-panel", "projectId": "p1", "title": "Panel",
            "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "full-access", "interactionMode": "default", "branch": null,
            "worktreePath": null, "kind": "panel", "hostThreadId": THREAD,
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("panel created");
    let agent = fixture.agent().await;
    let opened = fixture
        .call(
            &agent,
            "terminal_open",
            json!({ "threadId": "terminal-panel" }),
        )
        .await;
    assert_eq!(structured(&opened)["threadId"], "terminal-panel");
    let terminal_id = structured(&opened)["terminalId"]
        .as_str()
        .unwrap()
        .to_owned();
    let sessions = fixture.manager.thread_sessions(THREAD).await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].terminal_id, terminal_id);
    assert!(sessions[0].center_panel);
    // The host and the panel list the same terminal.
    for thread in [THREAD, "terminal-panel"] {
        let listed = fixture
            .call(&agent, "terminal_list", json!({ "threadId": thread }))
            .await;
        assert_eq!(
            structured(&listed)["terminals"][0]["terminalId"],
            terminal_id
        );
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn an_old_cursor_reports_dropped_after_more_than_a_mebibyte_of_output() {
    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    backend.latest().emit("start\n");
    let start = fixture
        .read_until(&agent, json!({ "terminalId": terminal_id }), "start")
        .await;
    let cursor = start["nextCursor"].as_str().unwrap().to_owned();
    let block = "y".repeat(64 * 1024);
    for _ in 0..17 {
        backend.latest().emit(&block);
    }
    backend.latest().emit("end\n");
    fixture
        .read_until(&agent, json!({ "terminalId": terminal_id }), "end")
        .await;
    let page = fixture
        .read(
            &agent,
            json!({ "terminalId": terminal_id, "cursor": cursor }),
        )
        .await;
    assert_eq!(page["dropped"], true);
    assert_eq!(page["more"], true);
    let text = page["text"].as_str().unwrap();
    assert!(!text.contains("start"));
    assert!(text.chars().count() <= 16_000, "{}", text.len());
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_write_over_16384_characters_is_refused() {
    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    let refused = fixture
        .call(
            &agent,
            "terminal_write",
            json!({ "threadId": THREAD, "terminalId": terminal_id, "data": "a".repeat(17_000) }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpInvalidArgumentError");
    assert!(backend.writes().is_empty());
    let accepted = fixture
        .call(
            &agent,
            "terminal_write",
            json!({ "threadId": THREAD, "terminalId": terminal_id, "data": "b".repeat(16_384) }),
        )
        .await;
    structured(&accepted);
    assert_eq!(backend.writes(), ["b".repeat(16_384)]);
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_writes_do_not_interleave_within_one_calls_data() {
    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    let calls = ['p', 'q', 'r', 's'].map(|letter| {
        fixture.call(
            &agent,
            "terminal_write",
            json!({
                "threadId": THREAD, "terminalId": terminal_id,
                "data": letter.to_string().repeat(16_384),
            }),
        )
    });
    for result in futures_util::future::join_all(calls).await {
        structured(&result);
    }
    let writes = backend.writes();
    assert_eq!(writes.len(), 4);
    for write in &writes {
        let first = write.chars().next().unwrap();
        assert!(write.chars().all(|letter| letter == first));
        assert_eq!(write.len(), 16_384);
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_keyed_open_and_a_keyed_write_run_once_across_retries() {
    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let open = json!({ "threadId": THREAD, "clientRequestId": "open-1" });
    let first = fixture.call(&agent, "terminal_open", open.clone()).await;
    let again = fixture.call(&agent, "terminal_open", open).await;
    assert_eq!(structured(&first), structured(&again));
    let terminal_id = structured(&first)["terminalId"]
        .as_str()
        .unwrap()
        .to_owned();
    let listed = structured(
        &fixture
            .call(&agent, "terminal_list", json!({ "threadId": THREAD }))
            .await,
    )["terminals"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(listed, 1);
    let write = json!({
        "threadId": THREAD, "terminalId": terminal_id, "data": "make\n",
        "clientRequestId": "write-1",
    });
    let first = fixture.call(&agent, "terminal_write", write.clone()).await;
    let again = fixture.call(&agent, "terminal_write", write).await;
    assert_eq!(structured(&first), structured(&again));
    assert_eq!(backend.writes(), ["make\n"]);
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_write_to_an_exited_terminal_says_so_and_its_output_stays_readable() {
    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    backend.latest().emit("bye\n");
    fixture
        .read_until(&agent, json!({ "terminalId": terminal_id }), "bye")
        .await;
    backend.latest().exit.send_replace(Some(PtyExit {
        exit_code: Some(3),
        signal: None,
    }));
    let exited = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let page = fixture
                .read(&agent, json!({ "terminalId": terminal_id }))
                .await;
            if page["status"] == "exited" {
                return page;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the terminal exits");
    assert_eq!(exited["exitCode"], 3);
    assert!(exited["text"].as_str().unwrap().contains("bye"));
    let refused = fixture
        .call(
            &agent,
            "terminal_write",
            json!({ "threadId": THREAD, "terminalId": terminal_id, "data": "ls\n" }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpTerminalExitedError");
    let unknown = fixture
        .call(
            &agent,
            "terminal_write",
            json!({ "threadId": THREAD, "terminalId": "nope", "data": "ls\n" }),
        )
        .await;
    assert_eq!(error_tag(&unknown), "McpTerminalNotFoundError");
    fixture.shutdown().await;
}

#[tokio::test]
async fn raw_reads_keep_escapes_and_plain_reads_strip_them() {
    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    backend
        .latest()
        .emit("\u{1b}[31mred\u{1b}[0m \u{1b}]0;title\u{7}done\n");
    let plain = fixture
        .read_until(&agent, json!({ "terminalId": terminal_id }), "done")
        .await;
    assert_eq!(plain["text"], "red done\n");
    let raw = fixture
        .read(&agent, json!({ "terminalId": terminal_id, "raw": true }))
        .await;
    assert_eq!(
        raw["text"],
        "\u{1b}[31mred\u{1b}[0m \u{1b}]0;title\u{7}done\n"
    );
    assert_eq!(raw["nextCursor"], plain["nextCursor"]);
    let both = fixture
        .call(
            &agent,
            "terminal_read",
            json!({ "threadId": THREAD, "terminalId": terminal_id, "cursor": "0", "tailChars": 10 }),
        )
        .await;
    assert_eq!(error_tag(&both), "McpInvalidArgumentError");
    fixture.shutdown().await;
}

/// A write the terminal does not take in time is an unknown outcome, never a success, and a
/// keyed retry answers the same without writing again (#139 slice T review).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_the_terminal_does_not_take_is_an_unknown_outcome() {
    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    let process = backend.latest();
    process.set_stuck(true);
    let _unstick = Unstick(process.clone());
    let write = json!({
        "threadId": THREAD, "terminalId": terminal_id, "data": "cat\n",
        "clientRequestId": "stuck-1",
    });
    for _ in 0..2 {
        let answered = tokio::time::timeout(
            Duration::from_secs(10),
            fixture.call(&agent, "terminal_write", write.clone()),
        )
        .await
        .expect("the write answers in bounded time");
        assert_eq!(error_tag(&answered), "McpOutcomeUnknownError");
        assert_eq!(
            answered["structuredContent"]["error"]["reason"],
            "no-answer"
        );
    }
    process.set_stuck(false);
    tokio::time::timeout(Duration::from_secs(5), async {
        while backend.writes().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the held write lands");
    assert_eq!(backend.writes(), ["cat\n"]);
    fixture.shutdown().await;
}

/// A restart keeps the terminal id but starts a new history, so a cursor from before it
/// reports dropped instead of skipping the new output.
#[tokio::test]
async fn a_cursor_from_before_a_restart_reports_dropped() {
    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    backend.latest().emit("before\n");
    let before = fixture
        .read_until(&agent, json!({ "terminalId": terminal_id }), "before")
        .await;
    let cursor = before["nextCursor"].as_str().unwrap().to_owned();
    let cwd = structured(
        &fixture
            .call(&agent, "terminal_list", json!({ "threadId": THREAD }))
            .await,
    )["terminals"][0]["cwd"]
        .as_str()
        .unwrap()
        .to_owned();
    fixture
        .manager
        .restart(crate::terminal::TerminalOpenInput::new(
            THREAD,
            &terminal_id,
            std::path::PathBuf::from(cwd),
            120,
            30,
        ))
        .await
        .expect("restart");
    backend
        .latest()
        .emit("after the restart, longer than before\n");
    fixture
        .read_until(&agent, json!({ "terminalId": terminal_id }), "longer")
        .await;
    let page = fixture
        .read(
            &agent,
            json!({ "terminalId": terminal_id, "cursor": cursor }),
        )
        .await;
    assert_eq!(page["dropped"], true, "{page}");
    assert_eq!(page["text"], "after the restart, longer than before\n");
    fixture.shutdown().await;
}

/// An escape sequence longer than a page is skipped whole: its continuation never shows as
/// text on the next page.
#[tokio::test]
async fn an_escape_longer_than_a_page_is_skipped_whole() {
    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    backend.latest().emit("x\n");
    let start = fixture
        .read_until(&agent, json!({ "terminalId": terminal_id }), "x")
        .await;
    let cursor = start["nextCursor"].as_str().unwrap().to_owned();
    backend
        .latest()
        .emit(&format!("\u{1b}]0;{}\u{7}after\n", "t".repeat(20_000)));
    fixture
        .read_until(&agent, json!({ "terminalId": terminal_id }), "after")
        .await;
    let first = fixture
        .read(
            &agent,
            json!({ "terminalId": terminal_id, "cursor": cursor }),
        )
        .await;
    assert_eq!(first["text"], "");
    assert_eq!(first["more"], true);
    let second = fixture
        .read(
            &agent,
            json!({ "terminalId": terminal_id, "cursor": first["nextCursor"] }),
        )
        .await;
    assert_eq!(second["text"], "after\n");
    fixture.shutdown().await;
}

/// An escape sequence still arriving keeps the cursor before it, so the next read gets it
/// whole and strips it.
#[tokio::test]
async fn an_escape_still_arriving_keeps_the_cursor_before_it() {
    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    backend.latest().emit("x\n");
    let start = fixture
        .read_until(&agent, json!({ "terminalId": terminal_id }), "x")
        .await;
    let cursor = start["nextCursor"].as_str().unwrap().to_owned();
    backend.latest().emit("\u{1b}[3");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let waiting = fixture
        .read(
            &agent,
            json!({ "terminalId": terminal_id, "cursor": cursor }),
        )
        .await;
    assert_eq!(waiting["text"], "");
    assert_eq!(waiting["nextCursor"], cursor.as_str());
    backend.latest().emit("1mred\n");
    let done = fixture
        .read_until(
            &agent,
            json!({ "terminalId": terminal_id, "cursor": waiting["nextCursor"] }),
            "red",
        )
        .await;
    assert_eq!(done["text"], "red\n");
    fixture.shutdown().await;
}

#[derive(Clone, Default)]
struct CapturedLog(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Terminal input and output never reach the log or the profiler. In a process of its own:
/// the tracing capture and the profiler handle are process-global.
#[tokio::test]
async fn the_log_and_the_profiler_never_see_terminal_input_or_output() {
    let Some(child) = crate::test_support::in_own_process(
        "production::mcp_tools_tests::terminals::the_log_and_the_profiler_never_see_terminal_input_or_output",
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
    let state = tempfile::tempdir().expect("profiler state");
    let (_enabled, enabled) = watch::channel(true);
    let runtime = crate::diagnostics::profiler::runtime::ProfilerRuntime::start(
        state.path(),
        enabled,
        vec![],
    );
    tokio::time::timeout(Duration::from_secs(30), async {
        while runtime.status()["enabled"] != true {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the profiler turns on");

    let (fixture, backend) = Fixture::echo().await;
    let agent = fixture.agent().await;
    let terminal_id = fixture.open(&agent).await;
    structured(
        &fixture
            .call(
                &agent,
                "terminal_write",
                json!({ "threadId": THREAD, "terminalId": terminal_id, "data": "INPUT-CANARY-31337\n" }),
            )
            .await,
    );
    backend.latest().emit("OUTPUT-CANARY-31337\n");
    fixture
        .read_until(
            &agent,
            json!({ "terminalId": terminal_id }),
            "OUTPUT-CANARY",
        )
        .await;
    // Refused calls are logged at the boundary too.
    fixture
        .call(
            &agent,
            "terminal_write",
            json!({ "threadId": THREAD, "terminalId": terminal_id, "data": format!("REFUSED-CANARY-{}", "x".repeat(17_000)) }),
        )
        .await;
    fixture
        .call(
            &agent,
            "terminal_write",
            json!({ "threadId": THREAD, "terminalId": "missing", "data": "MISSING-CANARY\n" }),
        )
        .await;
    fixture
        .call(
            &agent,
            "terminal_close",
            json!({ "threadId": THREAD, "terminalId": terminal_id }),
        )
        .await;
    fixture.shutdown().await;
    runtime.shutdown().await;

    let log = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(
        log.contains("MCP destructive tool"),
        "the capture saw the run:\n{log}"
    );
    assert!(
        !log.contains("CANARY"),
        "terminal content reached the log:\n{log}"
    );
    let profiler = std::fs::read_dir(crate::diagnostics::profiler::profiler_dir(state.path()))
        .expect("profiler directory")
        .filter_map(|entry| std::fs::read(entry.expect("entry").path()).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect::<String>();
    assert!(!profiler.is_empty(), "the profiler recorded the run");
    assert!(
        !profiler.contains("CANARY"),
        "terminal content reached the profiler"
    );
    child.complete();
}
