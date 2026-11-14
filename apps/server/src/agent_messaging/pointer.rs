//! Agent mail for an AI Terminal. A message is stored in the terminal generation's mailbox, never
//! typed: the server types only [`POINTER_LINE`], once per period in which the terminal's agent
//! waits for a prompt and no person typed, and the agent then fetches its mail itself.

use std::{pin::Pin, sync::Arc};

use tokio::{sync::Notify, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use super::{
    AgentMessaging, AgentMessagingError, MessageOutcome, policy,
    store::{
        self, AgentMessageReason, AgentMessageRow, AgentMessageStatus, NewAgentMessage, SenderKind,
    },
    terminal_credential::{TerminalIdentity, parse_terminal_address},
};
use crate::{
    persistence::Database,
    terminal::{
        TerminalError, TerminalGeneration, TerminalManager, TerminalMetadataAttachment,
        TerminalSummary, WriteWhenReady,
    },
};

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The terminal operations the pointer needs: the terminal manager, or a script in tests.
pub trait PointerTerminals: Send + Sync {
    fn write_when_ready<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
        generation: &'a TerminalGeneration,
        data: &'a str,
    ) -> BoxFuture<'a, Result<WriteWhenReady, TerminalError>>;
    fn live_generation<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> BoxFuture<'a, Option<TerminalGeneration>>;
    #[expect(dead_code, reason = "task 8.6's hop ledger reads it")]
    fn person_input_count<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> BoxFuture<'a, Option<u64>>;
    fn thread_sessions<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Vec<TerminalSummary>>;
    fn subscribe_metadata(&self) -> BoxFuture<'_, TerminalMetadataAttachment>;
}

impl PointerTerminals for TerminalManager {
    fn write_when_ready<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
        generation: &'a TerminalGeneration,
        data: &'a str,
    ) -> BoxFuture<'a, Result<WriteWhenReady, TerminalError>> {
        Box::pin(TerminalManager::write_when_ready(
            self,
            thread_id,
            terminal_id,
            generation,
            data,
        ))
    }

    fn live_generation<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> BoxFuture<'a, Option<TerminalGeneration>> {
        Box::pin(TerminalManager::live_generation(
            self,
            thread_id,
            terminal_id,
        ))
    }

    fn person_input_count<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> BoxFuture<'a, Option<u64>> {
        Box::pin(TerminalManager::person_input_count(
            self,
            thread_id,
            terminal_id,
        ))
    }

    fn thread_sessions<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Vec<TerminalSummary>> {
        Box::pin(TerminalManager::thread_sessions(self, thread_id))
    }

    fn subscribe_metadata(&self) -> BoxFuture<'_, TerminalMetadataAttachment> {
        Box::pin(TerminalManager::subscribe_metadata(self))
    }
}

/// The only text the server ever types into a terminal (R17): it names no message, title or
/// sender.
pub const POINTER_LINE: &str =
    "BiBCode: you have new messages. Run `bibcode agent inbox` to read them.";
pub const POINTER_PASTE_OPEN: &str = "\u{1b}[200~";
pub const POINTER_PASTE_CLOSE: &str = "\u{1b}[201~";
pub const POINTER_SUBMIT: &str = "\r";

/// A terminal agent receives as `full-access` (R6).
pub(crate) const TERMINAL_RECIPIENT_MODE: &str = "full-access";

fn pointer_input() -> String {
    format!("{POINTER_PASTE_OPEN}{POINTER_LINE}{POINTER_PASTE_CLOSE}{POINTER_SUBMIT}")
}

fn generation_key(generation: &TerminalGeneration) -> String {
    format!("{}:{}", generation.boot, generation.process)
}

fn storage(
    context: &'static str,
) -> impl Fn(crate::persistence::PersistenceError) -> AgentMessagingError {
    move |error| {
        tracing::warn!(error = %error, "{context}");
        AgentMessagingError::Storage
    }
}

/// Stores agent mail for AI Terminals and tells each terminal about it. Clones share one wake.
#[derive(Clone)]
pub struct TerminalPointer {
    database: Database,
    terminals: Arc<dyn PointerTerminals>,
    wake: Arc<Notify>,
}

impl TerminalPointer {
    pub fn new(database: Database, terminals: Arc<dyn PointerTerminals>) -> Self {
        Self {
            database,
            terminals,
            wake: Arc::new(Notify::new()),
        }
    }

    pub(crate) fn terminals(&self) -> &Arc<dyn PointerTerminals> {
        &self.terminals
    }

    /// Stores `new` in `recipient`'s mailbox: one row bound to its generation, with no turn
    /// queue entry. An agent's message obeys the mode ceiling (the terminal receives as
    /// `full-access`) and the rate and backlog limits, and is held while messaging is off; a
    /// person's request is exempt from all three.
    pub(crate) async fn accept(
        &self,
        messaging: &AgentMessaging,
        mut new: NewAgentMessage,
        recipient: &TerminalIdentity,
    ) -> Result<(), AgentMessagingError> {
        let agent = new.sender_kind == SenderKind::Agent;
        if agent {
            let sender_mode = new.sender_runtime_mode.clone().unwrap_or_default();
            if !policy::ceiling_allows(&sender_mode, TERMINAL_RECIPIENT_MODE) {
                return Err(AgentMessagingError::ModeCeiling {
                    sender: sender_mode,
                    recipient: TERMINAL_RECIPIENT_MODE.to_owned(),
                });
            }
        }
        new.recipient_address = recipient.address();
        new.recipient_terminal_generation = Some(recipient.generation_key());
        new.delivery_command_id = None;
        new.delivery_message_id = None;
        (new.status, new.reason) = if agent && !messaging.is_enabled() {
            (
                AgentMessageStatus::Held,
                Some(AgentMessageReason::MessagingOff),
            )
        } else {
            (AgentMessageStatus::Queued, None)
        };
        let limits = policy::AdmissionLimits::now();
        let refused = self
            .database
            .call(move |connection| {
                let tx = connection.transaction()?;
                if let Err(refusal) = policy::enforce_limits(&tx, &new, &limits)? {
                    return Ok(Some(refusal));
                }
                store::insert_message(&tx, &new)?;
                tx.commit()?;
                Ok(None)
            })
            .await
            .map_err(storage("a terminal's agent message was not stored"))?;
        match refused {
            Some(policy::LimitRefusal::Rate) => return Err(AgentMessagingError::RateLimit),
            Some(policy::LimitRefusal::Backlog) => return Err(AgentMessagingError::BacklogLimit),
            None => {}
        }
        self.wake.notify_one();
        Ok(())
    }

    /// Pastes the pointer into each terminal whose agent waits for a prompt while its live
    /// generation has `queued` mail, and marks that mail `delivered`; until `shutdown`. It
    /// rescans on every terminal metadata change, every new message and every change of the
    /// setting, so a lost event only delays the pointer. It never pastes for a `held` row.
    pub(crate) fn start(
        &self,
        messaging: AgentMessaging,
        shutdown: CancellationToken,
    ) -> JoinHandle<()> {
        let pointer = self.clone();
        tokio::spawn(async move {
            let mut metadata = pointer.terminals.subscribe_metadata().await;
            let mut enabled = messaging.enabled.clone();
            let (mut setting_open, mut metadata_open) = (true, true);
            pointer.follow_setting(&messaging).await;
            loop {
                pointer.paste_waiting(&messaging).await;
                tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    changed = enabled.changed(), if setting_open => {
                        setting_open = changed.is_ok();
                        pointer.follow_setting(&messaging).await;
                    }
                    () = pointer.wake.notified() => {}
                    event = metadata.recv(), if metadata_open => metadata_open = event.is_some(),
                }
            }
        })
    }

    /// Holds or releases the terminals' agent mail for the setting's current value.
    async fn follow_setting(&self, messaging: &AgentMessaging) {
        let enabled = messaging.is_enabled();
        if let Err(error) = self
            .database
            .call(move |connection| {
                super::delivery::follow_setting_for_terminals(
                    connection,
                    enabled,
                    &crate::mcp::control::now_iso(),
                )
            })
            .await
        {
            tracing::warn!(error = %error, "terminal agent messages did not follow the setting");
        }
    }

    /// One pass of [`Self::start`].
    async fn paste_waiting(&self, messaging: &AgentMessaging) {
        let enabled = messaging.is_enabled();
        let waiting = match self
            .database
            .call(move |connection| store::list_queued_terminal_mail(connection, enabled))
            .await
        {
            Ok(waiting) => waiting,
            Err(error) => {
                tracing::warn!(error = %error, "terminal mail could not be read");
                return;
            }
        };
        let mut addresses: Vec<&str> = Vec::new();
        for row in &waiting {
            if !addresses.contains(&row.recipient_address.as_str()) {
                addresses.push(&row.recipient_address);
            }
        }
        for address in addresses {
            let Some((thread_id, terminal_id)) = parse_terminal_address(address) else {
                continue;
            };
            let Some(generation) = self
                .terminals
                .live_generation(&thread_id, &terminal_id)
                .await
            else {
                continue;
            };
            let key = generation_key(&generation);
            let ids: Vec<String> = waiting
                .iter()
                .filter(|row| {
                    row.recipient_address == address
                        && row.recipient_terminal_generation.as_deref() == Some(key.as_str())
                })
                .map(|row| row.message_id.clone())
                .collect();
            if ids.is_empty() {
                continue;
            }
            match self
                .terminals
                .write_when_ready(&thread_id, &terminal_id, &generation, &pointer_input())
                .await
            {
                Ok(WriteWhenReady::Written) => {}
                Ok(WriteWhenReady::NotReady | WriteWhenReady::GenerationChanged) => continue,
                Err(error) => {
                    tracing::debug!(error = %error, "the pointer was not typed");
                    continue;
                }
            }
            let now = crate::mcp::control::now_iso();
            match self
                .database
                .call(move |connection| store::deliver_queued(connection, &ids, &now))
                .await
            {
                Ok(delivered) => self.report(messaging, &delivered, "delivered", None).await,
                Err(error) => {
                    tracing::warn!(error = %error, "terminal mail was not marked delivered")
                }
            }
        }
    }

    /// Tells the outcome sink, if any, of each message's `outcome`, with ids and titles only.
    pub(crate) async fn report(
        &self,
        messaging: &AgentMessaging,
        messages: &[AgentMessageRow],
        outcome: &str,
        reason: Option<AgentMessageReason>,
    ) {
        let Some(outcomes) = &messaging.outcomes else {
            return;
        };
        for message in messages {
            let title = |description: super::SenderDescription| {
                Some(description.title).filter(|title| !title.is_empty())
            };
            outcomes(MessageOutcome {
                sender_address: message.sender_address.clone(),
                recipient_address: message.recipient_address.clone(),
                tool: "agent_message_delivery",
                outcome: outcome.to_owned(),
                message_id: Some(message.message_id.clone()),
                conversation_id: Some(message.conversation_id.clone()),
                hop: Some(message.hop),
                reason: reason.map(|reason| reason.as_str().to_owned()),
                sender_title: title(messaging.sender_description(&message.sender_address).await),
                recipient_title: title(
                    messaging
                        .sender_description(&message.recipient_address)
                        .await,
                ),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex as StdMutex, time::Duration};

    use serde_json::json;
    use tokio::sync::{broadcast, watch};

    use super::*;
    use crate::{
        agent_messaging::{MessageReceipt, SendRequest, delivery::AgentMessageTracker},
        orchestration::OrchestrationCommand,
        production::mcp_tools_tests::Harness,
        terminal::{
            ProviderTerminalActivityLaunch, TerminalAgentStatus, TerminalAgentStatusState,
            TerminalLaunchCommand, TerminalMetadataEvent, TerminalStatus,
        },
    };

    struct FakeTerminal {
        generation: Option<TerminalGeneration>,
        ai: bool,
        state: TerminalAgentStatusState,
        ready: bool,
        #[expect(dead_code, reason = "task 8.6's hop ledger reads it")]
        person_inputs: u64,
        attempts: usize,
        writes: Vec<String>,
    }

    /// Terminals whose readiness and generation the test sets; every write is recorded.
    struct Scripted {
        terminals: StdMutex<HashMap<(String, String), FakeTerminal>>,
        metadata: broadcast::Sender<TerminalMetadataEvent>,
    }

    fn key(thread_id: &str, terminal_id: &str) -> (String, String) {
        (thread_id.to_owned(), terminal_id.to_owned())
    }

    fn generation(process: u64) -> TerminalGeneration {
        TerminalGeneration {
            boot: "boot-1".to_owned(),
            process,
        }
    }

    impl Scripted {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                terminals: StdMutex::new(HashMap::new()),
                metadata: broadcast::channel(256).0,
            })
        }

        /// A running Claude AI Terminal (a plain shell when `ai` is false), not ready.
        fn add(&self, thread_id: &str, terminal_id: &str, process: u64, ai: bool) {
            self.terminals.lock().unwrap().insert(
                key(thread_id, terminal_id),
                FakeTerminal {
                    generation: Some(generation(process)),
                    ai,
                    state: TerminalAgentStatusState::Working,
                    ready: false,
                    person_inputs: 0,
                    attempts: 0,
                    writes: Vec::new(),
                },
            );
        }

        fn summary(thread_id: &str, terminal_id: &str, terminal: &FakeTerminal) -> TerminalSummary {
            TerminalSummary {
                thread_id: thread_id.to_owned(),
                terminal_id: terminal_id.to_owned(),
                cwd: "/".to_owned(),
                worktree_path: None,
                status: if terminal.generation.is_some() {
                    TerminalStatus::Running
                } else {
                    TerminalStatus::Exited
                },
                pid: Some(1),
                exit_code: None,
                exit_signal: None,
                console_theme: None,
                has_running_subprocess: false,
                label: format!("Claude {terminal_id}"),
                updated_at: "2026-11-14T00:00:00Z".to_owned(),
                center_panel: false,
                command: terminal.ai.then(|| TerminalLaunchCommand {
                    executable: "claude".to_owned(),
                    args: Vec::new(),
                    label: None,
                    activity: Some(ProviderTerminalActivityLaunch {
                        driver_kind: "claudeAgent".to_owned(),
                        provider_instance_id: "claudeAgent".to_owned(),
                    }),
                    env: None,
                }),
                agent_status: terminal.ai.then_some(TerminalAgentStatus {
                    state: terminal.state,
                    failed: false,
                    age_ms: None,
                    observed_at: None,
                    ready_for_prompt: terminal.ready,
                }),
            }
        }

        fn change(
            &self,
            thread_id: &str,
            terminal_id: &str,
            change: impl FnOnce(&mut FakeTerminal),
        ) {
            let summary = {
                let mut terminals = self.terminals.lock().unwrap();
                let terminal = terminals.get_mut(&key(thread_id, terminal_id)).unwrap();
                change(terminal);
                Self::summary(thread_id, terminal_id, terminal)
            };
            let _ = self.metadata.send(TerminalMetadataEvent::Upsert {
                terminal: Box::new(summary),
            });
        }

        fn set_state(&self, thread_id: &str, terminal_id: &str, state: TerminalAgentStatusState) {
            self.change(thread_id, terminal_id, |terminal| {
                terminal.state = state;
                terminal.ready = state == TerminalAgentStatusState::Done;
            });
        }

        fn set_ready(&self, thread_id: &str, terminal_id: &str) {
            self.set_state(thread_id, terminal_id, TerminalAgentStatusState::Done);
        }

        fn read<T>(
            &self,
            thread_id: &str,
            terminal_id: &str,
            read: impl FnOnce(&FakeTerminal) -> T,
        ) -> T {
            read(&self.terminals.lock().unwrap()[&key(thread_id, terminal_id)])
        }

        fn writes(&self, thread_id: &str, terminal_id: &str) -> Vec<String> {
            self.read(thread_id, terminal_id, |terminal| terminal.writes.clone())
        }

        fn attempts(&self, thread_id: &str, terminal_id: &str) -> usize {
            self.read(thread_id, terminal_id, |terminal| terminal.attempts)
        }
    }

    impl PointerTerminals for Scripted {
        fn write_when_ready<'a>(
            &'a self,
            thread_id: &'a str,
            terminal_id: &'a str,
            generation: &'a TerminalGeneration,
            data: &'a str,
        ) -> BoxFuture<'a, Result<WriteWhenReady, TerminalError>> {
            let mut terminals = self.terminals.lock().unwrap();
            let terminal = terminals.get_mut(&key(thread_id, terminal_id)).unwrap();
            terminal.attempts += 1;
            let outcome = if terminal.generation.as_ref() != Some(generation) {
                WriteWhenReady::GenerationChanged
            } else if !terminal.ready {
                WriteWhenReady::NotReady
            } else {
                terminal.ready = false;
                terminal.writes.push(data.to_owned());
                WriteWhenReady::Written
            };
            Box::pin(std::future::ready(Ok(outcome)))
        }

        fn live_generation<'a>(
            &'a self,
            thread_id: &'a str,
            terminal_id: &'a str,
        ) -> BoxFuture<'a, Option<TerminalGeneration>> {
            let live = self
                .terminals
                .lock()
                .unwrap()
                .get(&key(thread_id, terminal_id))
                .and_then(|terminal| terminal.generation.clone());
            Box::pin(std::future::ready(live))
        }

        fn person_input_count<'a>(
            &'a self,
            thread_id: &'a str,
            terminal_id: &'a str,
        ) -> BoxFuture<'a, Option<u64>> {
            let count = self
                .terminals
                .lock()
                .unwrap()
                .get(&key(thread_id, terminal_id))
                .map(|terminal| terminal.person_inputs);
            Box::pin(std::future::ready(count))
        }

        fn thread_sessions<'a>(
            &'a self,
            thread_id: &'a str,
        ) -> BoxFuture<'a, Vec<TerminalSummary>> {
            let listed = self
                .terminals
                .lock()
                .unwrap()
                .iter()
                .filter(|((thread, _), _)| thread == thread_id)
                .map(|((thread, terminal_id), terminal)| {
                    Self::summary(thread, terminal_id, terminal)
                })
                .collect();
            Box::pin(std::future::ready(listed))
        }

        fn subscribe_metadata(&self) -> BoxFuture<'_, TerminalMetadataAttachment> {
            let attachment =
                TerminalMetadataAttachment::for_test(Vec::new(), self.metadata.subscribe());
            Box::pin(std::future::ready(attachment))
        }
    }

    const CREATED_AT: &str = "2026-11-14T00:00:00.000Z";
    const BODY: &str = "zebra-body-that-must-never-be-typed";

    struct Fixture {
        harness: Harness,
        terminals: Arc<Scripted>,
        pointer: TerminalPointer,
        enabled: watch::Sender<bool>,
        messaging: AgentMessaging,
        outcomes: Arc<StdMutex<Vec<MessageOutcome>>>,
        stop: CancellationToken,
        _other_project: tempfile::TempDir,
    }

    async fn dispatch(harness: &Harness, value: serde_json::Value) {
        let command: OrchestrationCommand = serde_json::from_value(value).expect("command");
        harness.engine.dispatch(command).await.expect("dispatched");
    }

    /// Threads `a`, `c` (full access), `q` (approval required) and the terminals' owner `t` in
    /// project `p1`, and `x` in project `p2`; the Claude AI Terminal `t/term-1` runs.
    async fn fixture() -> Fixture {
        let harness = Harness::new().await;
        let other_project = tempfile::tempdir().expect("second project folder");
        dispatch(
            &harness,
            json!({
                "type": "project.create", "commandId": "project-create-p2", "projectId": "p2",
                "title": "Other project", "workspaceRoot": other_project.path(),
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT,
            }),
        )
        .await;
        for (thread_id, project_id, title, mode) in [
            ("a", "p1", "Sender thread", "full-access"),
            ("c", "p1", "Second sender", "full-access"),
            ("q", "p1", "Careful thread", "approval-required"),
            ("t", "p1", "Terminal host", "full-access"),
            ("x", "p2", "Other project thread", "full-access"),
        ] {
            dispatch(
                &harness,
                json!({
                    "type": "thread.create", "commandId": format!("create-{thread_id}"),
                    "threadId": thread_id, "projectId": project_id, "title": title,
                    "modelSelection": { "instanceId": "codex", "model": "model" },
                    "runtimeMode": mode, "createdAt": CREATED_AT,
                }),
            )
            .await;
        }
        let terminals = Scripted::new();
        terminals.add("t", "term-1", 1, true);
        let pointer = TerminalPointer::new(
            harness.engine.repositories().database().clone(),
            terminals.clone(),
        );
        let (enabled, receiver) = watch::channel(true);
        let outcomes = Arc::new(StdMutex::new(Vec::new()));
        let sink = outcomes.clone();
        let messaging = AgentMessaging::new(harness.engine.clone(), receiver)
            .with_terminals(pointer.clone())
            .with_outcomes(Arc::new(move |outcome| sink.lock().unwrap().push(outcome)));
        Fixture {
            harness,
            terminals,
            pointer,
            enabled,
            messaging,
            outcomes,
            stop: CancellationToken::new(),
            _other_project: other_project,
        }
    }

    impl Fixture {
        fn start(&self) -> JoinHandle<()> {
            self.pointer
                .start(self.messaging.clone(), self.stop.clone())
        }

        async fn send(&self, from: &str, to: &str) -> Result<MessageReceipt, AgentMessagingError> {
            self.messaging
                .send(
                    from,
                    SendRequest {
                        to: to.to_owned(),
                        text: BODY.to_owned(),
                        client_request_id: None,
                    },
                )
                .await
        }

        async fn row(&self, message_id: &str) -> AgentMessageRow {
            let message_id = message_id.to_owned();
            self.harness
                .engine
                .repositories()
                .database()
                .call(move |connection| store::get_message(connection, &message_id))
                .await
                .unwrap()
                .expect("stored")
        }

        async fn until_status(
            &self,
            message_id: &str,
            status: AgentMessageStatus,
        ) -> AgentMessageRow {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let row = self.row(message_id).await;
                    if row.status == status {
                        return row;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("message reaches {}", status.as_str()))
        }

        /// Waits until the pointer asked `t/terminal_id` to be typed into `count` times.
        async fn until_attempts(&self, terminal_id: &str, count: usize) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.terminals.attempts("t", terminal_id) < count {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the pointer tried the terminal");
        }

        fn identity(&self, terminal_id: &str) -> TerminalIdentity {
            TerminalIdentity {
                environment_id: "local".to_owned(),
                thread_id: "t".to_owned(),
                terminal_id: terminal_id.to_owned(),
                generation: self
                    .terminals
                    .read("t", terminal_id, |terminal| terminal.generation.clone())
                    .unwrap(),
            }
        }

        /// Stores a message from `sender_address` straight through `accept`.
        async fn accept_from(
            &self,
            sender_address: &str,
            sender_kind: SenderKind,
            terminal_id: &str,
        ) -> Result<(), AgentMessagingError> {
            let identity = self.identity(terminal_id);
            self.pointer
                .accept(
                    &self.messaging,
                    NewAgentMessage {
                        message_id: uuid::Uuid::new_v4().to_string(),
                        conversation_id: uuid::Uuid::new_v4().to_string(),
                        sender_address: sender_address.to_owned(),
                        sender_kind,
                        recipient_address: String::new(),
                        in_reply_to: None,
                        hop: 1,
                        text: BODY.to_owned(),
                        status: AgentMessageStatus::Accepted,
                        reason: None,
                        accepted_at: crate::mcp::control::now_iso(),
                        sender_runtime_mode: (sender_kind == SenderKind::Agent)
                            .then(|| "full-access".to_owned()),
                        recipient_terminal_generation: None,
                        send_request_id: None,
                        client_request_id: None,
                        delivery_command_id: None,
                        delivery_message_id: None,
                    },
                    &identity,
                )
                .await
        }

        async fn shutdown(self) {
            self.stop.cancel();
            self.harness.shutdown().await;
        }
    }

    fn pointer_bytes() -> String {
        [
            POINTER_PASTE_OPEN,
            POINTER_LINE,
            POINTER_PASTE_CLOSE,
            POINTER_SUBMIT,
        ]
        .concat()
    }

    #[tokio::test]
    async fn a_ready_terminal_gets_one_pointer_line_and_the_message_becomes_delivered() {
        let fixture = fixture().await;
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        assert_eq!(receipt.status, AgentMessageStatus::Queued);
        let row = fixture.row(&receipt.message_id).await;
        assert_eq!(row.status, AgentMessageStatus::Queued);
        assert_eq!(row.recipient_address, "terminal:t/term-1");
        assert_eq!(
            row.recipient_terminal_generation.as_deref(),
            Some("boot-1:1")
        );
        assert_eq!(
            row.delivery_command_id, None,
            "a terminal row has no queue entry"
        );
        fixture.terminals.set_ready("t", "term-1");
        fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Delivered)
            .await;
        assert_eq!(fixture.terminals.writes("t", "term-1"), [pointer_bytes()]);
        assert_eq!(
            pointer_bytes(),
            "\u{1b}[200~BiBCode: you have new messages. Run `bibcode agent inbox` to read them.\u{1b}[201~\r"
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_busy_blocked_waiting_or_unobservable_terminal_gets_nothing_typed() {
        let fixture = fixture().await;
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        let mut attempts = fixture.terminals.attempts("t", "term-1");
        for state in [
            TerminalAgentStatusState::Working,
            TerminalAgentStatusState::Blocked,
            TerminalAgentStatusState::Waiting,
            TerminalAgentStatusState::Unavailable,
        ] {
            fixture.terminals.set_state("t", "term-1", state);
            attempts += 1;
            fixture.until_attempts("term-1", attempts).await;
            assert_eq!(
                fixture.row(&receipt.message_id).await.status,
                AgentMessageStatus::Queued,
                "{state:?}"
            );
        }
        assert!(fixture.terminals.writes("t", "term-1").is_empty());
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn two_messages_in_one_ready_period_share_one_pointer() {
        let fixture = fixture().await;
        fixture.start();
        let first = fixture.send("a", "terminal:t/term-1").await.unwrap();
        let second = fixture.send("c", "terminal:t/term-1").await.unwrap();
        fixture.terminals.set_ready("t", "term-1");
        fixture
            .until_status(&first.message_id, AgentMessageStatus::Delivered)
            .await;
        fixture
            .until_status(&second.message_id, AgentMessageStatus::Delivered)
            .await;
        assert_eq!(fixture.terminals.writes("t", "term-1").len(), 1);
        // The ready period ended with the pointer: the next message waits for the next one.
        let attempts = fixture.terminals.attempts("t", "term-1");
        let third = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.until_attempts("term-1", attempts + 1).await;
        assert_eq!(
            fixture.row(&third.message_id).await.status,
            AgentMessageStatus::Queued
        );
        fixture.terminals.set_ready("t", "term-1");
        fixture
            .until_status(&third.message_id, AgentMessageStatus::Delivered)
            .await;
        assert_eq!(fixture.terminals.writes("t", "term-1").len(), 2);
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_terminal_receives_as_full_access() {
        let fixture = fixture().await;
        assert_eq!(
            fixture.send("q", "terminal:t/term-1").await,
            Err(AgentMessagingError::ModeCeiling {
                sender: "approval-required".to_owned(),
                recipient: "full-access".to_owned(),
            })
        );
        assert_eq!(
            fixture.send("a", "terminal:t/term-1").await.unwrap().status,
            AgentMessageStatus::Queued
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_chat_agent_reaches_only_a_live_ai_terminal_of_its_project() {
        let fixture = fixture().await;
        fixture.terminals.add("t", "shell", 2, false);
        fixture.terminals.add("t", "ended", 3, true);
        fixture
            .terminals
            .change("t", "ended", |terminal| terminal.generation = None);
        for (from, to) in [
            ("x", "terminal:t/term-1"),
            ("a", "terminal:t/shell"),
            ("a", "terminal:t/ended"),
            ("a", "terminal:t/missing"),
            ("a", "terminal:nobody/term-1"),
        ] {
            assert_eq!(
                fixture.send(from, to).await,
                Err(AgentMessagingError::UnknownRecipient),
                "{from} to {to}"
            );
        }
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn the_chat_tracker_never_touches_terminal_rows_and_the_messaging_off_reconcile_holds_them()
     {
        let fixture = fixture().await;
        let tracker = CancellationToken::new();
        AgentMessageTracker::start(
            fixture.harness.engine.clone(),
            None,
            fixture.enabled.subscribe(),
            tracker.clone(),
        );
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.enabled.send(true).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            fixture.row(&receipt.message_id).await.status,
            AgentMessageStatus::Queued,
            "the tracker's reconciliation leaves a terminal row alone"
        );
        fixture.enabled.send(false).unwrap();
        let held = fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Held)
            .await;
        assert_eq!(held.reason, Some(AgentMessageReason::MessagingOff));
        fixture.terminals.set_ready("t", "term-1");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            fixture.terminals.writes("t", "term-1").is_empty(),
            "no pointer for a held row"
        );
        fixture.enabled.send(true).unwrap();
        let delivered = fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Delivered)
            .await;
        assert_eq!(delivered.reason, None);
        assert_eq!(fixture.terminals.writes("t", "term-1").len(), 1);
        tracker.cancel();
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_rows_obey_the_rate_and_backlog_limits() {
        let fixture = fixture().await;
        for terminal_id in ["term-2", "term-3", "term-4", "term-5"] {
            fixture.terminals.add("t", terminal_id, 1, true);
        }
        // A chat sender: 30 messages in the window, then the rate refuses the 31st.
        for index in 0..30 {
            let to = if index < 15 {
                "terminal:t/term-1"
            } else {
                "terminal:t/term-2"
            };
            fixture.send("a", to).await.unwrap();
        }
        assert_eq!(
            fixture.send("a", "terminal:t/term-3").await,
            Err(AgentMessagingError::RateLimit)
        );
        // term-1 holds 15 unread: five more fill its backlog.
        for _ in 0..5 {
            fixture.send("c", "terminal:t/term-1").await.unwrap();
        }
        assert_eq!(
            fixture.send("c", "terminal:t/term-1").await,
            Err(AgentMessagingError::BacklogLimit)
        );
        // A person's requests are never refused and never count.
        for _ in 0..25 {
            fixture
                .accept_from("thread:a", SenderKind::Person, "term-3")
                .await
                .unwrap();
        }
        fixture.send("c", "terminal:t/term-3").await.unwrap();
        // A terminal sender obeys the same limits.
        let sender = "terminal:t/term-9";
        for _ in 0..20 {
            fixture
                .accept_from(sender, SenderKind::Agent, "term-4")
                .await
                .unwrap();
        }
        assert_eq!(
            fixture
                .accept_from(sender, SenderKind::Agent, "term-4")
                .await,
            Err(AgentMessagingError::BacklogLimit)
        );
        for _ in 0..10 {
            fixture
                .accept_from(sender, SenderKind::Agent, "term-5")
                .await
                .unwrap();
        }
        assert_eq!(
            fixture
                .accept_from(sender, SenderKind::Agent, "term-5")
                .await,
            Err(AgentMessagingError::RateLimit)
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn the_pointer_task_stops_before_profiler_teardown() {
        let fixture = fixture().await;
        let task = fixture.start();
        // The quiesce sequence cancels this token before the profiler's teardown.
        fixture.stop.cancel();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("the pointer task stops on its token")
            .expect("the pointer task did not panic");
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_delivery_reaches_the_activity_log_without_text() {
        let fixture = fixture().await;
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.terminals.set_ready("t", "term-1");
        fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Delivered)
            .await;
        let outcomes = fixture.outcomes.lock().unwrap().clone();
        let delivered: Vec<_> = outcomes
            .iter()
            .filter(|outcome| outcome.outcome == "delivered")
            .collect();
        assert_eq!(
            delivered,
            [&MessageOutcome {
                sender_address: "thread:a".to_owned(),
                recipient_address: "terminal:t/term-1".to_owned(),
                tool: "agent_message_delivery",
                outcome: "delivered".to_owned(),
                message_id: Some(receipt.message_id.clone()),
                conversation_id: Some(receipt.conversation_id.clone()),
                hop: Some(1),
                reason: None,
                sender_title: Some("Sender thread".to_owned()),
                recipient_title: Some("Claude term-1".to_owned()),
            }]
        );
        assert!(!format!("{outcomes:?}").contains(BODY));
        fixture.shutdown().await;
    }
}
