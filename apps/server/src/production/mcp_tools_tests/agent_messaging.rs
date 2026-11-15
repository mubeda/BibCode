//! The agent messaging tools a provider-hosted agent calls, on the harness's engine.

use serde_json::{Value, json};

use super::{CREATED_AT, Harness, command, command as command_value, error_tag, structured};
use crate::{
    agent_messaging::store::AgentMessageReason,
    mcp::{control::McpAccess, tools::agent_messaging::run},
    orchestration::{TurnDeliveryState, TurnDeliveryTransition},
    production::connect_mcp::PreviewScope,
};

/// The provider credential's scope of thread `thread_id`.
fn scope(thread_id: &str) -> PreviewScope {
    PreviewScope {
        environment_id: "local".to_owned(),
        thread_id: thread_id.to_owned(),
        owner_thread_id: thread_id.to_owned(),
        provider_session_id: format!("session-{thread_id}"),
        provider_instance_id: "codex".to_owned(),
    }
}

impl Harness {
    /// Project `p2` with thread `x`, and in project `p1` a Claude thread `a`, a Codex thread `b`
    /// that is mid-turn, and a chat panel `p` whose host is `a`.
    async fn messaging_threads(&self) {
        std::fs::create_dir_all(self.state_dir.join("p2")).expect("second project folder");
        self.engine
            .dispatch(command(json!({
                "type": "project.create", "commandId": "project-create-p2", "projectId": "p2",
                "title": "Other project", "workspaceRoot": self.state_dir.join("p2"),
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("second project");
        for (thread_id, project_id, title, instance, panel_host) in [
            ("a", "p1", "Claude thread", "claudeAgent", None),
            ("b", "p1", "Codex thread", "codex", None),
            ("p", "p1", "Review panel", "codex", Some("a")),
            ("x", "p2", "Other project thread", "codex", None),
        ] {
            let mut create = json!({
                "type": "thread.create", "commandId": format!("create-{thread_id}"),
                "threadId": thread_id, "projectId": project_id, "title": title,
                "modelSelection": { "instanceId": instance, "model": "model" },
                "runtimeMode": "full-access", "createdAt": CREATED_AT,
            });
            if let Some(host) = panel_host {
                create["kind"] = json!("panel");
                create["hostThreadId"] = json!(host);
            }
            self.engine
                .dispatch(command(create))
                .await
                .expect("thread created");
        }
        self.provider_turn("b", "turn-b", "working", false).await;
    }

    async fn agents_list(&self, caller: &str, enabled: bool) -> Value {
        run(
            scope(caller),
            "agents_list",
            json!({}),
            Some(&self.messaging(enabled)),
        )
        .await
    }
}

/// The listed agents among the threads `messaging_threads` made (a project also has its default
/// thread).
fn named(result: &Value) -> Vec<&Value> {
    structured(result)["agents"]
        .as_array()
        .expect("agents")
        .iter()
        .filter(|agent| {
            ["thread:a", "thread:b", "thread:p", "thread:x"]
                .contains(&agent["address"].as_str().expect("address"))
        })
        .collect()
}

fn addresses(result: &Value) -> Vec<&str> {
    named(result)
        .into_iter()
        .map(|agent| agent["address"].as_str().expect("address"))
        .collect()
}

#[tokio::test]
async fn lists_the_other_agents_of_the_project() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness.agents_list("a", true).await;

    assert_ne!(result["isError"], true, "{result}");
    assert_eq!(
        json!(named(&result)),
        json!([
            {"address": "thread:b", "title": "Codex thread", "provider": "codex", "kind": "chat", "status": "working", "canReceive": true},
            {"address": "thread:p", "title": "Review panel", "provider": "codex", "kind": "chat", "status": "ready", "canReceive": true},
        ])
    );
    // A panel lists its host.
    let from_panel = harness.agents_list("p", true).await;
    assert_eq!(addresses(&from_panel), ["thread:a", "thread:b"]);
    assert_eq!(named(&from_panel)[0]["provider"], "claudeAgent");
    harness.shutdown().await;
}

#[tokio::test]
async fn agents_list_names_the_projects_ai_terminals() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let terminals = crate::agent_messaging::pointer::tests::Scripted::new();
    terminals.add("a", "term-1", 1, true);
    terminals.add("x", "term-9", 1, true);
    let messaging = harness.messaging(true).with_terminals(
        crate::agent_messaging::pointer::TerminalPointer::new(
            harness.engine.repositories().database().clone(),
            terminals,
        ),
    );

    let result = run(scope("b"), "agents_list", json!({}), Some(&messaging)).await;

    assert_ne!(result["isError"], true, "{result}");
    let listed: Vec<&Value> = structured(&result)["agents"]
        .as_array()
        .expect("agents")
        .iter()
        .filter(|agent| agent["kind"] == "terminal")
        .collect();
    assert_eq!(
        json!(listed),
        json!([{
            "address": "terminal:a/term-1", "title": "Claude term-1", "provider": "claudeAgent",
            "kind": "terminal", "status": "working", "canReceive": true,
        }])
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn other_projects_stay_invisible() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness.agents_list("a", true).await;

    let listed: Vec<String> = structured(&result)["agents"]
        .as_array()
        .expect("agents")
        .iter()
        .map(|agent| agent["address"].as_str().expect("address").to_owned())
        .collect();
    let project_two: Vec<String> = harness
        .repositories
        .database()
        .call(|connection| {
            let mut statement = connection
                .prepare("SELECT thread_id FROM projection_threads WHERE project_id = 'p2'")?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
        .await
        .expect("project two threads");
    assert!(project_two.contains(&"x".to_owned()));
    for thread_id in project_two {
        assert!(
            !listed.contains(&format!("thread:{thread_id}")),
            "project two's thread {thread_id} is listed"
        );
    }
    let keys: Vec<&String> = structured(&result)
        .as_object()
        .expect("object")
        .keys()
        .collect();
    assert_eq!(
        keys,
        ["agents"],
        "no count or other field hints at project two"
    );
    assert!(!result.to_string().contains("Other project"));
    harness.shutdown().await;
}

#[tokio::test]
async fn a_deleted_or_archived_thread_is_not_listed() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness
        .engine
        .dispatch(command(
            json!({"type": "thread.archive", "commandId": "archive-p", "threadId": "p"}),
        ))
        .await
        .expect("archived");
    harness
        .engine
        .dispatch(command(
            json!({"type": "thread.delete", "commandId": "delete-b", "threadId": "b"}),
        ))
        .await
        .expect("deleted");

    let result = harness.agents_list("a", true).await;

    assert_eq!(addresses(&result), Vec::<&str>::new());
    harness.shutdown().await;
}

#[tokio::test]
async fn default_is_off() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness.agents_list("a", false).await;

    assert_eq!(result["isError"], true);
    assert_eq!(error_tag(&result), "AgentMessagingDisabledError");
    assert_eq!(
        result["structuredContent"]["error"]["message"],
        "Agent messaging is off. Turn it on in Settings → Agents → Agent integrations."
    );
    assert!(result["structuredContent"].get("agents").is_none());
    harness.shutdown().await;
}

#[tokio::test]
async fn agents_list_takes_no_arguments_and_quotes_none() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = run(
        scope("a"),
        "agents_list",
        json!({"project": "p2-secret-value"}),
        Some(&harness.messaging(true)),
    )
    .await;

    assert_eq!(error_tag(&result), "AgentMessagingInvalidArgumentError");
    assert!(!result.to_string().contains("p2-secret-value"));
    harness.shutdown().await;
}

#[tokio::test]
async fn a_caller_whose_thread_is_gone_reaches_nobody() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness.agents_list("missing", true).await;

    assert_eq!(error_tag(&result), "AgentMessagingUnknownRecipientError");
    assert_eq!(
        result["structuredContent"]["error"]["message"],
        "No agent with that address in this project. Call agents_list to see the agents you can reach."
    );
    harness.shutdown().await;
}

/// One stored agent message, as the tests read it back.
#[derive(Debug)]
struct StoredMessage {
    message_id: String,
    sender: String,
    recipient: String,
    status: String,
    delivery_command_id: String,
    delivery_message_id: String,
}

impl Harness {
    async fn agent_send(&self, caller: &str, arguments: Value) -> Value {
        run(
            scope(caller),
            "agent_message_send",
            arguments,
            Some(&self.messaging(true)),
        )
        .await
    }

    async fn agent_messages(&self) -> Vec<StoredMessage> {
        self.repositories
            .database()
            .call(|connection| {
                let mut statement = connection.prepare(
                    "SELECT message_id, sender_address, recipient_address, status, delivery_command_id, delivery_message_id FROM agent_messages ORDER BY rowid",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok(StoredMessage {
                            message_id: row.get(0)?,
                            sender: row.get(1)?,
                            recipient: row.get(2)?,
                            status: row.get(3)?,
                            delivery_command_id: row.get(4)?,
                            delivery_message_id: row.get(5)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await
            .expect("agent messages")
    }

    /// The states of every queue entry of `thread_id`.
    async fn outbox_states(&self, thread_id: &'static str) -> Vec<(String, String)> {
        self.repositories
            .database()
            .call(move |connection| {
                let mut statement = connection.prepare(
                    "SELECT command_id, state FROM provider_turn_outbox WHERE thread_id = ?1 ORDER BY rowid",
                )?;
                let rows = statement
                    .query_map([thread_id], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await
            .expect("outbox")
    }

    /// The text and actor of a projected message.
    async fn projected_message(&self, message_id: String) -> (String, Value) {
        self.repositories
            .database()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT text, actor_json FROM projection_thread_messages WHERE message_id = ?1",
                    [&message_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )?)
            })
            .await
            .map(|(text, actor)| {
                (
                    text,
                    actor.map_or(Value::Null, |actor| {
                        serde_json::from_str(&actor).expect("actor")
                    }),
                )
            })
            .expect("projected message")
    }

    async fn event_count(&self, event_type: &'static str) -> i64 {
        self.repositories
            .database()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT COUNT(*) FROM orchestration_events WHERE event_type = ?1",
                    [event_type],
                    |row| row.get(0),
                )?)
            })
            .await
            .expect("event count")
    }
}

fn send_arguments(to: &str, text: &str) -> Value {
    json!({ "to": to, "text": text })
}

#[tokio::test]
async fn accepted() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness
        .agent_send(
            "a",
            send_arguments("thread:b", "Which port does the dev server use?"),
        )
        .await;

    assert_ne!(result["isError"], true, "{result}");
    let receipt = structured(&result);
    assert_eq!(receipt["status"], "accepted");
    assert_eq!(receipt["hop"], 1);
    let message_id = receipt["messageId"].as_str().expect("message id");
    assert!(
        receipt["conversationId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );
    let stored = harness.agent_messages().await;
    assert_eq!(stored.len(), 1, "{stored:?}");
    assert_eq!(stored[0].message_id, message_id);
    assert_eq!(stored[0].sender, "thread:a");
    assert_eq!(stored[0].recipient, "thread:b");
    // The status tracker may already have read the queue entry behind B's running turn.
    assert!(
        ["accepted", "queued"].contains(&stored[0].status.as_str()),
        "{}",
        stored[0].status
    );
    assert_eq!(
        stored[0].delivery_command_id,
        format!("agent-message:{message_id}")
    );
    let queue = harness.outbox_states("b").await;
    assert_eq!(queue.len(), 1, "one queue entry: {queue:?}");
    assert_eq!(queue[0].0, stored[0].delivery_command_id);
    let (text, actor) = harness
        .projected_message(stored[0].delivery_message_id.clone())
        .await;
    assert!(
        text.starts_with("<bibcode_agent_message>\nfrom: Claude thread\n"),
        "{text}"
    );
    assert!(
        text.contains(&format!("message-id: {message_id}\n")),
        "{text}"
    );
    assert!(
        text.contains("\n  Which port does the dev server use?\n"),
        "{text}"
    );
    assert_eq!(
        actor,
        json!({ "kind": "hosted-agent", "address": "thread:a", "label": "Claude thread" })
    );
    harness.shutdown().await;
}

/// Codex expands a `$name` skill mention anywhere in its input, so the text a Codex recipient
/// is delivered carries none; the stored message keeps what the agent wrote, and a recipient on
/// another provider is delivered it unchanged.
#[tokio::test]
async fn a_codex_recipient_is_delivered_no_bare_skill_mention() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let text = "Use $deploy-skill for it.";
    for (from, to) in [("a", "thread:b"), ("b", "thread:a")] {
        let result = harness.agent_send(from, send_arguments(to, text)).await;
        assert_ne!(result["isError"], true, "{result}");
    }
    let stored = harness.agent_messages().await;
    let texts: Vec<String> = harness
        .repositories
        .database()
        .call(|connection| {
            let mut statement =
                connection.prepare("SELECT text FROM agent_messages ORDER BY rowid")?;
            let rows = statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(rows)
        })
        .await
        .unwrap();
    assert_eq!(texts, [text, text], "the stored messages keep the text");
    let (to_codex, _) = harness
        .projected_message(stored[0].delivery_message_id.clone())
        .await;
    assert!(
        to_codex.contains("\n  Use $\u{200B}deploy-skill for it.\n"),
        "{to_codex:?}"
    );
    assert!(!to_codex.contains("$deploy-skill"), "{to_codex:?}");
    let (to_claude, _) = harness
        .projected_message(stored[1].delivery_message_id.clone())
        .await;
    assert!(
        to_claude.contains("\n  Use $deploy-skill for it.\n"),
        "{to_claude:?}"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn no_spoofing() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    for extra in ["from", "sender", "unknown"] {
        let mut arguments = send_arguments("thread:b", "hello");
        arguments[extra] = json!("thread:x-secret");
        let result = harness.agent_send("a", arguments).await;
        assert_eq!(
            error_tag(&result),
            "AgentMessagingInvalidArgumentError",
            "{extra}"
        );
        assert!(!result.to_string().contains("x-secret"), "{result}");
    }
    assert!(harness.agent_messages().await.is_empty());
    assert!(harness.outbox_states("b").await.is_empty());

    // A panel sends as itself, never as its host.
    let result = harness
        .agent_send("p", send_arguments("thread:b", "hello"))
        .await;
    assert_ne!(result["isError"], true, "{result}");
    assert_eq!(harness.agent_messages().await[0].sender, "thread:p");
    harness.shutdown().await;
}

#[tokio::test]
async fn invalid_recipient() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    std::fs::create_dir_all(harness.state_dir.join("gone")).expect("folder");
    for (thread_id, command) in [("deleted", "thread.delete"), ("archived", "thread.archive")] {
        harness
            .engine
            .dispatch(command_value(json!({
                "type": "thread.create", "commandId": format!("create-{thread_id}"),
                "threadId": thread_id, "projectId": "p1", "title": thread_id,
                "modelSelection": { "instanceId": "codex", "model": "model" },
                "runtimeMode": "full-access", "createdAt": CREATED_AT,
            })))
            .await
            .expect("thread created");
        harness
            .engine
            .dispatch(command_value(json!({
                "type": command, "commandId": format!("{command}-{thread_id}"), "threadId": thread_id,
            })))
            .await
            .expect("thread retired");
    }

    for to in [
        "thread:missing",
        "thread:a",
        "thread:",
        "b",
        "terminal:b/1",
        "thread:deleted",
        "thread:archived",
    ] {
        let result = harness.agent_send("a", send_arguments(to, "hello")).await;
        assert_eq!(
            error_tag(&result),
            "AgentMessagingUnknownRecipientError",
            "{to}: {result}"
        );
    }
    for text in [String::new(), "  \n ".to_owned(), "é".repeat(16_001)] {
        let result = harness
            .agent_send("a", send_arguments("thread:b", &text))
            .await;
        assert_eq!(
            error_tag(&result),
            "AgentMessagingInvalidArgumentError",
            "{} characters",
            text.chars().count()
        );
    }
    assert!(harness.agent_messages().await.is_empty());

    let result = harness
        .agent_send("a", send_arguments("thread:b", &"é".repeat(16_000)))
        .await;
    assert_ne!(result["isError"], true, "16,000 characters are accepted");
    harness.shutdown().await;
}

#[tokio::test]
async fn cross_project_send() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let other_project = harness
        .agent_send("a", send_arguments("thread:x", "hello"))
        .await;
    let missing = harness
        .agent_send("a", send_arguments("thread:no-such-thread", "hello"))
        .await;

    assert_eq!(
        error_tag(&other_project),
        "AgentMessagingUnknownRecipientError"
    );
    assert_eq!(
        other_project, missing,
        "the error does not reveal that x exists"
    );
    assert!(harness.outbox_states("x").await.is_empty());
    assert!(harness.agent_messages().await.is_empty());
    harness.shutdown().await;
}

#[tokio::test]
async fn an_idle_recipient_is_started() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.provider_turn("a", "turn-a", "done", true).await;

    let result = harness
        .agent_send("b", send_arguments("thread:a", "hello"))
        .await;

    assert_ne!(result["isError"], true, "{result}");
    let queue = harness.outbox_states("a").await;
    assert_eq!(queue.len(), 1, "{queue:?}");
    assert_eq!(queue[0].1, "pending");
    harness.shutdown().await;
}

#[tokio::test]
async fn a_busy_recipient_is_queued_without_steering() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness
        .agent_send("a", send_arguments("thread:b", "hello"))
        .await;

    assert_ne!(result["isError"], true, "{result}");
    let queue = harness.outbox_states("b").await;
    assert_eq!(queue.len(), 1, "{queue:?}");
    assert_eq!(queue[0].1, "queued");
    assert_eq!(harness.event_count("thread.turn-steer-requested").await, 0);
    assert_eq!(
        harness.event_count("thread.turn-interrupt-requested").await,
        0
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn a_never_started_recipient_is_started() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness
        .agent_send("a", send_arguments("thread:p", "hello"))
        .await;

    assert_ne!(result["isError"], true, "{result}");
    let queue = harness.outbox_states("p").await;
    assert_eq!(queue.len(), 1, "{queue:?}");
    assert_eq!(queue[0].1, "pending", "not stranded in queued");
    harness.shutdown().await;
}

#[tokio::test]
async fn a_hosted_agents_running_turn_is_not_an_outside_agents() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let result = harness
        .agent_send("a", send_arguments("thread:p", "hello"))
        .await;
    assert_ne!(result["isError"], true, "{result}");

    harness.provider_turn("p", "turn-p", "working", false).await;

    let activity = crate::mcp::activity::McpActivity::new(harness.repositories.database().clone());
    assert!(activity.active_now().await.is_empty());
    harness
        .repositories
        .database()
        .call(|connection| crate::mcp::activity::attributed_running_turn_count(connection))
        .await
        .map(|count| assert_eq!(count, 0, "no outside agent's turn"))
        .expect("the running turns read without error");
    harness.shutdown().await;
}

#[tokio::test]
async fn an_outside_agent_cannot_call_agents_list() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;

    let result = harness.call(&agent, "agents_list", json!({})).await;

    assert_eq!(error_tag(&result), "McpScopeError", "{result}");
    harness.shutdown().await;
}

// ---- Task 5.5: delivery and status tracking ----

impl Harness {
    /// The message id of an accepted send from `caller` to `to`.
    async fn sent(&self, caller: &str, to: &str) -> String {
        let result = self.agent_send(caller, send_arguments(to, "hello")).await;
        assert_ne!(result["isError"], true, "{result}");
        structured(&result)["messageId"]
            .as_str()
            .expect("message id")
            .to_owned()
    }

    async fn message_row(
        &self,
        message_id: &str,
    ) -> crate::agent_messaging::store::AgentMessageRow {
        let message_id = message_id.to_owned();
        self.repositories
            .database()
            .call(move |connection| {
                crate::agent_messaging::store::get_message(connection, &message_id)
            })
            .await
            .expect("readable")
            .expect("stored")
    }

    /// Waits until the message reads `status`, and returns its row.
    async fn until_status(
        &self,
        message_id: &str,
        status: &str,
    ) -> crate::agent_messaging::store::AgentMessageRow {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let row = self.message_row(message_id).await;
            if row.status.as_str() == status {
                return row;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{message_id} reads {} ({:?}), not {status}",
                row.status.as_str(),
                row.reason
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    /// Moves the message's queue entry through `steps`, as the turn queue would. The harness's
    /// own queue service may promote or claim the entry first: a step waits until the entry
    /// is in its `from` state and is skipped when the entry already reached or passed its `to`
    /// state. A step out of `queued` only waits: promotion is the queue's own command, which
    /// also writes the turn marker that ties the message to the turn it starts.
    async fn delivery_moves(&self, message_id: &str, steps: &[(&str, &str)]) {
        let row = self.message_row(message_id).await;
        let command_id = row.delivery_command_id.expect("queue entry");
        for (from, to) in steps {
            let state = |name: &str| match name {
                "queued" => TurnDeliveryState::Queued,
                "pending" => TurnDeliveryState::Pending,
                "sending" => TurnDeliveryState::Sending,
                "delivered" => TurnDeliveryState::Delivered,
                "failed" => TurnDeliveryState::Failed,
                "uncertain" => TurnDeliveryState::Uncertain,
                other => panic!("no state {other}"),
            };
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let entry = self
                    .repositories
                    .get_provider_turn_delivery(command_id.clone())
                    .await
                    .expect("readable")
                    .expect("queue entry");
                let rank = |state: &TurnDeliveryState| {
                    [
                        TurnDeliveryState::Queued,
                        TurnDeliveryState::Pending,
                        TurnDeliveryState::Sending,
                        TurnDeliveryState::Delivered,
                    ]
                    .iter()
                    .position(|step| step == state)
                };
                let reached = match (rank(&entry.state), rank(&state(to))) {
                    (Some(now), Some(target)) => now >= target,
                    _ => entry.state == state(to),
                };
                if reached {
                    break;
                }
                if entry.state == state(from)
                    && *from != "queued"
                    && self
                        .engine
                        .transition_turn_delivery(TurnDeliveryTransition {
                            turn_id: None,
                            command_id: command_id.clone(),
                            expected_states: vec![state(from)],
                            expected_attempt: entry.attempts,
                            next_state: state(to),
                            detail: None,
                            updated_at: CREATED_AT.to_owned(),
                        })
                        .await
                        .expect("transition")
                {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "{from} to {to}: the entry is {:?}",
                    entry.state
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
    }

    async fn session_ends(&self, thread_id: &str, status: &str) {
        self.engine
            .dispatch(command(json!({
                "type": "thread.session.set",
                "commandId": format!("session-{thread_id}-{status}-{}", uuid::Uuid::new_v4()),
                "threadId": thread_id,
                "session": {
                    "threadId": thread_id, "status": status, "providerName": "codex",
                    "providerInstanceId": "codex", "runtimeMode": "full-access",
                    "activeTurnId": null, "lastError": null, "updatedAt": CREATED_AT,
                },
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("session ends");
    }

    async fn resolve_delivery(&self, message_id: &str, action: &str) {
        let row = self.message_row(message_id).await;
        let thread_id = row
            .recipient_address
            .trim_start_matches("thread:")
            .to_owned();
        self.engine
            .dispatch(command(json!({
                "type": "thread.turn-delivery.resolve",
                "commandId": format!("resolve-{action}-{message_id}"),
                "threadId": thread_id,
                "messageId": row.delivery_message_id.expect("delivery message"),
                "action": action,
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("resolved");
    }
}

#[tokio::test]
async fn idle_recipient() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.provider_turn("a", "turn-a", "done", true).await;
    let message_id = harness.sent("b", "thread:a").await;

    harness
        .delivery_moves(
            &message_id,
            &[("pending", "sending"), ("sending", "delivered")],
        )
        .await;
    harness.until_status(&message_id, "delivered").await;
    harness
        .provider_turn("a", "turn-a2", "Port 5173", false)
        .await;

    let row = harness.until_status(&message_id, "consumed").await;
    assert_eq!(row.recipient_turn_id.as_deref(), Some("turn-a2"));
    harness.shutdown().await;
}

#[tokio::test]
async fn busy_recipient() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let message_id = harness.sent("a", "thread:b").await;
    harness.until_status(&message_id, "queued").await;

    harness.provider_turn("b", "turn-b", "working", true).await;
    assert_eq!(
        harness.event_count("thread.turn-interrupt-requested").await,
        0
    );
    assert_eq!(harness.event_count("thread.turn-steer-requested").await, 0);
    harness
        .delivery_moves(
            &message_id,
            &[
                ("queued", "pending"),
                ("pending", "sending"),
                ("sending", "delivered"),
            ],
        )
        .await;
    harness.until_status(&message_id, "delivered").await;
    harness
        .provider_turn("b", "turn-b2", "Port 5173", false)
        .await;

    harness.until_status(&message_id, "consumed").await;
    harness.shutdown().await;
}

#[tokio::test]
async fn four_distinct_stages() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let message_id = harness.sent("a", "thread:b").await;

    let queued = harness.until_status(&message_id, "queued").await;
    harness.provider_turn("b", "turn-b", "working", true).await;
    // The queue hands the message to B's provider, which starts B's next turn with it.
    harness
        .delivery_moves(
            &message_id,
            &[
                ("queued", "pending"),
                ("pending", "sending"),
                ("sending", "delivered"),
            ],
        )
        .await;
    harness
        .provider_turn("b", "turn-b2", "Port 5173", false)
        .await;
    let consumed = harness.until_status(&message_id, "consumed").await;
    harness
        .provider_turn("b", "turn-b2", "Port 5173", true)
        .await;
    let completed = harness.until_status(&message_id, "completed").await;

    for row in [queued, consumed, completed] {
        assert_eq!(row.reason, None, "{}", row.status.as_str());
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn a_reply_still_streaming_keeps_the_message_consumed() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.provider_turn("a", "turn-a", "done", true).await;
    let message_id = harness.sent("b", "thread:a").await;
    harness.provider_turn("a", "turn-a2", "Port", false).await;
    harness.until_status(&message_id, "consumed").await;

    // The turn completes before its reply settles.
    harness.session_ends("a", "ready").await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(
        harness.message_row(&message_id).await.status.as_str(),
        "consumed"
    );
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.message.assistant.complete", "commandId": "complete-late",
            "threadId": "a", "messageId": "reply-turn-a2", "turnId": "turn-a2",
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("the last chunk settles");

    harness.until_status(&message_id, "completed").await;
    harness.shutdown().await;
}

#[tokio::test]
async fn a_turn_that_errors_fails_the_message() {
    for end in ["error", "interrupted"] {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.provider_turn("a", "turn-a", "done", true).await;
        let message_id = harness.sent("b", "thread:a").await;
        harness
            .provider_turn("a", "turn-a2", "working", false)
            .await;
        harness.until_status(&message_id, "consumed").await;

        harness.session_ends("a", end).await;

        let row = harness.until_status(&message_id, "failed").await;
        assert_eq!(
            row.reason,
            Some(AgentMessageReason::RecipientTurnFailed),
            "{end}"
        );
        harness.shutdown().await;
    }
}

#[tokio::test]
async fn a_deleted_recipient_fails_the_message() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let message_id = harness.sent("a", "thread:p").await;

    harness
        .engine
        .dispatch(command(
            json!({"type": "thread.delete", "commandId": "delete-p", "threadId": "p"}),
        ))
        .await
        .expect("deleted");

    let row = harness.until_status(&message_id, "failed").await;
    assert_eq!(row.reason, Some(AgentMessageReason::RecipientGone));
    harness.shutdown().await;
}

#[tokio::test]
async fn consumed_when_the_provider_reports_the_turn_before_the_marker_binds() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.provider_turn("a", "turn-a", "done", true).await;
    let message_id = harness.sent("b", "thread:a").await;
    harness
        .delivery_moves(
            &message_id,
            &[("pending", "sending"), ("sending", "delivered")],
        )
        .await;
    // The provider's first item names the turn before the session reports it running.
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.message.assistant.delta", "commandId": "early-delta",
            "threadId": "a", "messageId": "early-reply", "delta": "Port",
            "turnId": "turn-early", "createdAt": CREATED_AT,
        })))
        .await
        .expect("early item");
    harness
        .provider_turn("a", "turn-early", "Port", false)
        .await;

    let row = harness.until_status(&message_id, "consumed").await;
    assert_eq!(row.recipient_turn_id.as_deref(), Some("turn-early"));
    harness.shutdown().await;
}

#[tokio::test]
async fn a_status_is_never_recomputed_after_it_is_final() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.provider_turn("a", "turn-a", "done", true).await;
    let message_id = harness.sent("b", "thread:a").await;
    harness
        .provider_turn("a", "turn-a2", "Port 5173", true)
        .await;
    harness.until_status(&message_id, "completed").await;

    harness.provider_turn("a", "turn-a3", "again", false).await;
    harness.session_ends("a", "error").await;
    harness
        .repositories
        .database()
        .call(|connection| {
            connection.execute(
                "UPDATE projection_turns SET state = 'error' WHERE turn_id = 'turn-a2'",
                [],
            )?;
            Ok(())
        })
        .await
        .expect("a later failure");
    crate::agent_messaging::delivery::reconcile_all(&harness.engine, None)
        .await
        .expect("reconciled");

    assert_eq!(
        harness.message_row(&message_id).await.status.as_str(),
        "completed"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn a_definite_delivery_failure_is_readable() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let message_id = harness.sent("a", "thread:p").await;

    harness
        .delivery_moves(
            &message_id,
            &[("pending", "sending"), ("sending", "failed")],
        )
        .await;

    let row = harness.until_status(&message_id, "failed").await;
    assert_eq!(row.reason, Some(AgentMessageReason::DeliveryFailed));
    harness.shutdown().await;
}

#[tokio::test]
async fn an_uncertain_delivery_is_held_and_follows_the_persons_choice() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let retried = harness.sent("a", "thread:p").await;
    harness
        .delivery_moves(
            &retried,
            &[("pending", "sending"), ("sending", "uncertain")],
        )
        .await;
    let row = harness.until_status(&retried, "held").await;
    assert_eq!(row.reason, Some(AgentMessageReason::DeliveryUncertain));

    harness.resolve_delivery(&retried, "retry").await;
    harness
        .delivery_moves(
            &retried,
            &[("pending", "sending"), ("sending", "delivered")],
        )
        .await;
    harness.until_status(&retried, "delivered").await;
    harness.provider_turn("p", "turn-p", "ok", false).await;
    harness.until_status(&retried, "consumed").await;
    harness.shutdown().await;

    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let dismissed = harness.sent("a", "thread:p").await;
    harness
        .delivery_moves(
            &dismissed,
            &[("pending", "sending"), ("sending", "uncertain")],
        )
        .await;
    harness.until_status(&dismissed, "held").await;
    harness.resolve_delivery(&dismissed, "dismiss").await;
    let row = harness.until_status(&dismissed, "failed").await;
    assert_eq!(row.reason, Some(AgentMessageReason::DeliveryFailed));
    harness.shutdown().await;
}

#[tokio::test]
async fn a_promoted_message_never_reads_accepted_after_queued() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    // Untracked, so each reading below is one reconciliation of the entry's state.
    let result = run(
        scope("a"),
        "agent_message_send",
        send_arguments("thread:b", "hello"),
        Some(&harness.messaging_untracked(true)),
    )
    .await;
    let message_id = structured(&result)["messageId"]
        .as_str()
        .expect("id")
        .to_owned();
    let reconcile = || crate::agent_messaging::delivery::reconcile_all(&harness.engine, None);
    let entry_reads = |state: &'static str| {
        let command_id = format!("agent-message:{message_id}");
        harness.repositories.database().call(move |connection| {
            connection.execute(
                "UPDATE provider_turn_outbox SET state = ?1 WHERE command_id = ?2",
                [state, command_id.as_str()],
            )?;
            Ok(())
        })
    };
    assert_eq!(reconcile().await.expect("reconciled"), 1);
    assert_eq!(
        harness.message_row(&message_id).await.status.as_str(),
        "queued"
    );

    // Promoted behind the ended turn, the entry reads pending before it is sent.
    entry_reads("pending").await.expect("promoted");
    assert_eq!(reconcile().await.expect("reconciled"), 0);
    assert_eq!(
        harness.message_row(&message_id).await.status.as_str(),
        "queued"
    );
    entry_reads("delivered").await.expect("delivered");
    assert_eq!(reconcile().await.expect("reconciled"), 1);

    assert_eq!(
        harness.message_row(&message_id).await.status.as_str(),
        "delivered"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn startup_reconciliation_repairs_a_missed_event() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.provider_turn("a", "turn-a", "done", true).await;
    let result = run(
        scope("b"),
        "agent_message_send",
        send_arguments("thread:a", "hello"),
        Some(&harness.messaging_untracked(true)),
    )
    .await;
    let message_id = structured(&result)["messageId"]
        .as_str()
        .expect("id")
        .to_owned();
    harness
        .provider_turn("a", "turn-a2", "Port 5173", true)
        .await;
    assert_eq!(
        harness.message_row(&message_id).await.status.as_str(),
        "accepted"
    );

    let changed = crate::agent_messaging::delivery::reconcile_all(&harness.engine, None)
        .await
        .expect("reconciled");

    assert_eq!(changed, 1);
    assert_eq!(
        harness.message_row(&message_id).await.status.as_str(),
        "completed"
    );
    harness.shutdown().await;
}

// ---- Task 5.6: reply, correlation and status ----

impl Harness {
    async fn agent_tool(&self, caller: &str, tool: &str, arguments: Value) -> Value {
        run(scope(caller), tool, arguments, Some(&self.messaging(true))).await
    }

    async fn reply(&self, caller: &str, in_reply_to: &str, text: &str) -> Value {
        self.agent_tool(
            caller,
            "agent_message_reply",
            json!({ "inReplyTo": in_reply_to, "text": text }),
        )
        .await
    }

    async fn status_of(&self, caller: &str, message_id: &str) -> Value {
        self.agent_tool(
            caller,
            "agent_message_status",
            json!({ "messageId": message_id }),
        )
        .await
    }
}

#[tokio::test]
async fn round_trip_across_two_providers() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    // B (Codex) finishes its own turn first, so A's message starts B's next one.
    harness.provider_turn("b", "turn-b", "working", true).await;
    let m1 = harness.sent("a", "thread:b").await;
    harness
        .provider_turn("b", "turn-b2", "Looking", false)
        .await;
    harness.until_status(&m1, "consumed").await;

    let started = std::time::Instant::now();
    let reply = harness.reply("b", &m1, "Port 5173").await;
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "the reply call returns at once"
    );
    assert_ne!(reply["isError"], true, "{reply}");
    let reply_id = structured(&reply)["messageId"]
        .as_str()
        .expect("reply id")
        .to_owned();
    let original = harness.message_row(&m1).await;
    assert_eq!(
        structured(&reply)["conversationId"],
        original.conversation_id
    );
    assert_ne!(reply_id, m1);

    let stored = harness.message_row(&reply_id).await;
    assert_eq!(stored.sender_address, "thread:b");
    assert_eq!(stored.recipient_address, "thread:a");
    assert_eq!(stored.in_reply_to.as_deref(), Some(m1.as_str()));
    assert_eq!(stored.conversation_id, original.conversation_id);
    let (text, _) = harness
        .projected_message(stored.delivery_message_id.clone().expect("queued"))
        .await;
    assert!(text.contains("\n  Port 5173\n"), "{text}");
    assert!(text.contains(&format!("in-reply-to: {m1}\n")), "{text}");
    assert!(
        text.contains(&format!("conversation-id: {}\n", original.conversation_id)),
        "{text}"
    );
    assert!(
        text.contains(&format!("message-id: {reply_id}\n")),
        "{text}"
    );
    assert!(text.contains("address: thread:b\n"), "{text}");
    // A's thread starts a turn with the reply.
    harness.provider_turn("a", "turn-a", "Thanks", false).await;
    let consumed = harness.until_status(&reply_id, "consumed").await;
    assert_eq!(consumed.recipient_turn_id.as_deref(), Some("turn-a"));

    harness.provider_turn("b", "turn-b2", "Looking", true).await;
    harness.until_status(&m1, "completed").await;
    let status = harness.status_of("a", &m1).await;
    assert_eq!(structured(&status)["status"], "completed", "{status}");
    assert_eq!(structured(&status)["replyMessageId"], reply_id.as_str());
    harness.shutdown().await;
}

#[tokio::test]
async fn reply_to_a_message_that_was_not_yours() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let m1 = harness.sent("a", "thread:b").await;

    let result = harness.reply("p", &m1, "I am not b").await;

    assert_eq!(error_tag(&result), "AgentMessagingUnknownMessageError");
    assert_eq!(
        result["structuredContent"]["error"]["message"],
        "No message with that id that you may use."
    );
    assert_eq!(harness.agent_messages().await.len(), 1);
    assert!(harness.outbox_states("a").await.is_empty());
    harness.shutdown().await;
}

#[tokio::test]
async fn only_the_sender_may_ask() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let m1 = harness.sent("a", "thread:b").await;

    let not_sender = harness.status_of("p", &m1).await;
    let made_up = harness.status_of("p", "no-such-message").await;
    let recipient = harness.status_of("b", &m1).await;

    assert_eq!(error_tag(&not_sender), "AgentMessagingUnknownMessageError");
    assert_eq!(not_sender, made_up, "C learns nothing about m1");
    assert_eq!(recipient, made_up, "the recipient may not read it either");
    let sender = harness.status_of("a", &m1).await;
    assert_ne!(sender["isError"], true, "{sender}");
    assert!(structured(&sender)["updatedAt"].is_string());
    assert!(structured(&sender).get("replyMessageId").is_none());
    harness.shutdown().await;
}

#[tokio::test]
async fn a_later_reply_is_accepted() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let m1 = harness.sent("a", "thread:b").await;
    let first = harness.reply("b", &m1, "first").await;
    assert_ne!(first["isError"], true, "{first}");
    harness
        .repositories
        .database()
        .call(|connection| {
            connection.execute(
                "UPDATE agent_messages SET accepted_at = '2026-11-13T23:00:00Z'",
                [],
            )?;
            Ok(())
        })
        .await
        .expect("an hour earlier");

    let second = harness.reply("b", &m1, "second").await;

    assert_ne!(second["isError"], true, "{second}");
    let status = harness.status_of("a", &m1).await;
    assert_eq!(
        structured(&status)["replyMessageId"],
        structured(&second)["messageId"],
        "the newest reply"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn a_reply_to_a_deleted_sender_fails_with_recipient_gone() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let m1 = harness.sent("p", "thread:b").await;
    harness
        .engine
        .dispatch(command(
            json!({"type": "thread.delete", "commandId": "delete-p", "threadId": "p"}),
        ))
        .await
        .expect("deleted");

    let result = harness.reply("b", &m1, "too late").await;

    assert_eq!(error_tag(&result), "AgentMessagingRecipientGoneError");
    assert_eq!(harness.agent_messages().await.len(), 1);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_reply_has_its_own_text_limits() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let m1 = harness.sent("a", "thread:b").await;

    for text in [String::new(), "x".repeat(16_001)] {
        let result = harness.reply("b", &m1, &text).await;
        assert_eq!(
            error_tag(&result),
            "AgentMessagingInvalidArgumentError",
            "{} characters",
            text.len()
        );
    }
    let result = harness
        .agent_tool(
            "b",
            "agent_message_reply",
            json!({ "inReplyTo": m1, "text": "ok", "from": "thread:x" }),
        )
        .await;
    assert_eq!(error_tag(&result), "AgentMessagingInvalidArgumentError");
    assert_eq!(harness.agent_messages().await.len(), 1, "no reply stored");
    harness.shutdown().await;
}

#[tokio::test]
async fn an_outside_agent_cannot_call_reply_or_status() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;

    for (tool, arguments) in [
        (
            "agent_message_reply",
            json!({ "inReplyTo": "m1", "text": "hi" }),
        ),
        ("agent_message_status", json!({ "messageId": "m1" })),
        (
            "agent_message_send",
            json!({ "to": "thread:b", "text": "hi" }),
        ),
    ] {
        let result = harness.call(&agent, tool, arguments).await;
        assert_eq!(error_tag(&result), "McpScopeError", "{tool}: {result}");
    }
    harness.shutdown().await;
}

// ---- Review findings on phase 5 ----

impl Harness {
    /// Stops the harness's own queue service, so each queue step below is the test's.
    async fn stop_delivery(&self) {
        self.delivery.shutdown().await;
    }

    /// Whether `thread_id` has an unbound turn marker for `delivery_message_id`.
    async fn has_marker(&self, thread_id: &'static str, delivery_message_id: String) -> bool {
        self.repositories
            .database()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM projection_turns WHERE thread_id = ?1 AND pending_message_id = ?2 AND turn_id IS NULL)",
                    rusqlite::params![thread_id, delivery_message_id],
                    |row| row.get::<_, bool>(0),
                )?)
            })
            .await
            .expect("markers")
    }

    async fn early_delta(&self, thread_id: &str, turn_id: &str) {
        self.engine
            .dispatch(command(json!({
                "type": "thread.message.assistant.delta",
                "commandId": format!("early-delta-{turn_id}"),
                // The reply `provider_turn` streams and settles for the same turn.
                "threadId": thread_id, "messageId": format!("reply-{turn_id}"),
                "delta": "Port", "turnId": turn_id, "createdAt": CREATED_AT,
            })))
            .await
            .expect("early item");
    }

    /// The message's row after one full reconciliation, as at startup.
    async fn reconciled_status(
        &self,
        message_id: &str,
    ) -> crate::agent_messaging::store::AgentMessageRow {
        crate::agent_messaging::delivery::reconcile_all(&self.engine, None)
            .await
            .expect("reconciled");
        self.message_row(message_id).await
    }

    /// An accepted send from `caller` to `to` through an untracked service.
    async fn sent_untracked(&self, caller: &str, to: &str) -> String {
        let result = run(
            scope(caller),
            "agent_message_send",
            send_arguments(to, "hello"),
            Some(&self.messaging_untracked(true)),
        )
        .await;
        structured(&result)["messageId"]
            .as_str()
            .expect("id")
            .to_owned()
    }
}

#[tokio::test]
async fn a_person_cannot_steer_a_queued_agent_message_into_a_running_turn() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let message_id = harness.sent("a", "thread:b").await;
    let row = harness.message_row(&message_id).await;
    let delivery_message_id = row.delivery_message_id.expect("queue entry");
    assert_eq!(harness.outbox_states("b").await[0].1, "queued");

    let refused = harness
        .engine
        .dispatch(command(json!({
            "type": "thread.turn.steer", "commandId": "steer-agent-message", "threadId": "b",
            "messageId": delivery_message_id, "createdAt": CREATED_AT,
        })))
        .await
        .expect_err("an agent message never steers");

    let refusal = refused.to_string();
    assert!(
        refusal
            .contains("An agent message waits for the running turn to end, so it cannot steer it."),
        "{refusal}"
    );
    assert!(!refusal.contains("hello"), "{refusal}");
    assert_eq!(harness.outbox_states("b").await[0].1, "queued");
    assert_eq!(harness.event_count("thread.turn-steer-requested").await, 0);
    harness.shutdown().await;
}

#[tokio::test]
async fn an_early_provider_event_still_ties_the_message_to_its_own_turn() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.provider_turn("a", "turn-a", "done", true).await;
    harness.stop_delivery().await;
    let message_id = harness.sent_untracked("b", "thread:a").await;
    let delivery_message_id = harness
        .message_row(&message_id)
        .await
        .delivery_message_id
        .expect("queue entry");
    assert!(harness.has_marker("a", delivery_message_id).await);

    // The provider names the turn in an item before its session reports it running, and both
    // arrive before the delivery is recorded as complete.
    harness.early_delta("a", "turn-t").await;
    harness.provider_turn("a", "turn-t", "Port", false).await;
    harness
        .delivery_moves(
            &message_id,
            &[("pending", "sending"), ("sending", "delivered")],
        )
        .await;
    let consumed = harness.reconciled_status(&message_id).await;
    assert_eq!(consumed.status.as_str(), "consumed");
    assert_eq!(consumed.recipient_turn_id.as_deref(), Some("turn-t"));
    harness.provider_turn("a", "turn-t", "Port", true).await;
    assert_eq!(
        harness.reconciled_status(&message_id).await.status.as_str(),
        "completed"
    );

    // An unrelated later turn that fails changes nothing.
    harness.provider_turn("a", "turn-u", "other", false).await;
    harness.session_ends("a", "error").await;
    let row = harness.reconciled_status(&message_id).await;
    assert_eq!(row.status.as_str(), "completed");
    assert_eq!(row.recipient_turn_id.as_deref(), Some("turn-t"));
    harness.shutdown().await;
}

#[tokio::test]
async fn an_early_settled_item_still_ties_the_message_to_its_own_turn() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.provider_turn("a", "turn-a", "done", true).await;
    harness.stop_delivery().await;
    let message_id = harness.sent_untracked("b", "thread:a").await;
    harness
        .delivery_moves(&message_id, &[("pending", "sending")])
        .await;

    // The provider's first item for the turn arrives settled, before its running event.
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.message.assistant.complete", "commandId": "early-complete",
            "threadId": "a", "messageId": "early-settled", "turnId": "turn-t",
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("early settled item");
    harness.provider_turn("a", "turn-t", "Port", false).await;
    harness
        .delivery_moves(&message_id, &[("sending", "delivered")])
        .await;

    let row = harness.reconciled_status(&message_id).await;
    assert_eq!(row.recipient_turn_id.as_deref(), Some("turn-t"));
    assert_eq!(row.status.as_str(), "consumed");
    harness.shutdown().await;
}

#[tokio::test]
async fn a_message_whose_turn_is_unknown_is_never_given_another_turn() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.provider_turn("a", "turn-a", "done", true).await;
    harness.stop_delivery().await;
    let message_id = harness.sent_untracked("b", "thread:a").await;
    harness
        .delivery_moves(
            &message_id,
            &[("pending", "sending"), ("sending", "delivered")],
        )
        .await;
    assert_eq!(
        harness.reconciled_status(&message_id).await.status.as_str(),
        "delivered"
    );
    // The link to the message's own turn is lost: nothing ties a later turn to it.
    harness
        .repositories
        .database()
        .call(|connection| {
            connection.execute("DELETE FROM projection_turns WHERE turn_id IS NULL", [])?;
            Ok(())
        })
        .await
        .expect("marker removed");

    harness.provider_turn("a", "turn-u", "other", false).await;
    harness.session_ends("a", "error").await;

    let row = harness.reconciled_status(&message_id).await;
    assert_eq!(row.status.as_str(), "delivered", "{:?}", row.reason);
    assert_eq!(row.recipient_turn_id, None);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_reply_reports_its_outcome_like_a_send() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let m1 = harness.sent("a", "thread:b").await;
    let outcomes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = outcomes.clone();
    let messaging = harness
        .messaging_untracked(true)
        .with_outcomes(std::sync::Arc::new(
            move |outcome: crate::agent_messaging::MessageOutcome| {
                sink.lock().expect("outcomes").push(outcome);
            },
        ));
    let reply = |caller: &'static str, text: &str| {
        messaging.reply(
            caller,
            crate::agent_messaging::ReplyRequest {
                in_reply_to: m1.clone(),
                text: text.to_owned(),
                client_request_id: None,
            },
        )
    };

    let accepted = reply("b", "Port 5173").await.expect("reply accepted");
    assert!(reply("p", "not mine").await.is_err());

    let outcomes = outcomes.lock().expect("outcomes").clone();
    assert_eq!(outcomes.len(), 2, "{outcomes:?}");
    assert_eq!(outcomes[0].tool, "agent_message_reply");
    assert_eq!(outcomes[0].outcome, "accepted");
    assert_eq!(outcomes[0].sender_address, "thread:b");
    assert_eq!(outcomes[0].recipient_address, "thread:a");
    assert_eq!(
        outcomes[0].message_id.as_deref(),
        Some(accepted.message_id.as_str())
    );
    assert_eq!(outcomes[0].sender_title.as_deref(), Some("Codex thread"));
    assert_eq!(
        outcomes[0].recipient_title.as_deref(),
        Some("Claude thread")
    );
    assert_eq!(outcomes[1].tool, "agent_message_reply");
    assert_eq!(outcomes[1].outcome, "AgentMessagingUnknownMessageError");
    assert_eq!(outcomes[1].sender_address, "thread:p");
    assert!(!format!("{outcomes:?}").contains("Port 5173"));
    harness.shutdown().await;
}

// ---- Task 6.1: runtime-mode ceiling and the claim gate ----

impl Harness {
    async fn set_mode(&self, thread_id: &str, mode: &str) {
        self.engine
            .dispatch(command(json!({
                "type": "thread.runtime-mode.set",
                "commandId": format!("mode-{thread_id}-{mode}-{}", uuid::Uuid::new_v4()),
                "threadId": thread_id, "runtimeMode": mode, "createdAt": CREATED_AT,
            })))
            .await
            .expect("mode set");
    }

    /// A person's message queued (or started, when `thread_id` is idle) on `thread_id`; returns
    /// its queue entry's command id.
    async fn person_queues(&self, thread_id: &str) -> String {
        let command_id = format!("person-{}", uuid::Uuid::new_v4());
        super::super::orchestration_rpc::server_turn_starter(
            self.engine.clone(),
            self.provider.clone(),
            self.state_dir.clone(),
            self.delivery.clone(),
            None,
            self.uploads.clone(),
        )
        .queue_turn_start(
            command(json!({
                "type": "thread.turn.start", "commandId": command_id, "threadId": thread_id,
                "message": {
                    "messageId": uuid::Uuid::new_v4().to_string(), "role": "user",
                    "text": "From a person", "attachments": [],
                },
                "runtimeMode": "full-access", "interactionMode": "default",
                "queued": true, "createdAt": CREATED_AT,
            })),
            super::super::orchestration_rpc::ServerActor::Person,
            None,
        )
        .await
        .expect("the person's message is admitted");
        command_id
    }

    async fn entry_state(&self, command_id: &str) -> String {
        let command_id = command_id.to_owned();
        self.repositories
            .database()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT state FROM provider_turn_outbox WHERE command_id = ?1",
                    [&command_id],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .await
            .expect("queue entry")
    }

    /// Waits until queue entry `command_id` is in `state`.
    async fn until_entry(&self, command_id: &str, state: &str) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let now = self.entry_state(command_id).await;
            if now == state {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{command_id} is {now}, not {state}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    async fn claim(&self, message_id: &str) -> Option<crate::orchestration::ProviderTurnDelivery> {
        let command_id = self
            .message_row(message_id)
            .await
            .delivery_command_id
            .expect("queue entry");
        self.engine
            .repositories()
            .claim_provider_turn(command_id, CREATED_AT.to_owned())
            .await
            .expect("claim")
    }
}

fn ceiling_refusal(sender: &str, recipient: &str) -> String {
    format!(
        "The recipient runs with more access ({recipient}) than you ({sender}), so it cannot take your message."
    )
}

#[tokio::test]
async fn a_supervised_agent_cannot_drive_a_full_access_agent() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.set_mode("a", "approval-required").await;

    let result = harness
        .agent_send("a", send_arguments("thread:b", "hello"))
        .await;

    assert_eq!(error_tag(&result), "AgentMessagingModeCeilingError");
    assert_eq!(
        result["structuredContent"]["error"]["message"],
        ceiling_refusal("approval-required", "full-access")
    );
    assert!(harness.agent_messages().await.is_empty());
    assert!(harness.outbox_states("b").await.is_empty());
    let reply_to_b = harness.sent("b", "thread:a").await;
    let reply = harness.reply("a", &reply_to_b, "ok").await;
    assert_eq!(error_tag(&reply), "AgentMessagingModeCeilingError");
    harness.shutdown().await;
}

#[tokio::test]
async fn equal_or_lower_is_allowed() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.set_mode("b", "approval-required").await;

    let lower = harness
        .agent_send("a", send_arguments("thread:b", "hello"))
        .await;
    let equal = harness
        .agent_send("a", send_arguments("thread:p", "hello"))
        .await;

    assert_eq!(structured(&lower)["status"], "accepted", "{lower}");
    assert_eq!(structured(&equal)["status"], "accepted", "{equal}");
    let stored = harness
        .message_row(structured(&lower)["messageId"].as_str().expect("id"))
        .await;
    assert_eq!(stored.sender_runtime_mode.as_deref(), Some("full-access"));
    harness.shutdown().await;
}

#[tokio::test]
async fn the_recipients_mode_rises_while_the_message_waits() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.set_mode("a", "auto-accept-edits").await;
    harness.set_mode("b", "auto-accept-edits").await;
    let message_id = harness.sent("a", "thread:b").await;
    harness.until_status(&message_id, "queued").await;
    let command_id = harness
        .message_row(&message_id)
        .await
        .delivery_command_id
        .expect("queue entry");

    harness.set_mode("b", "full-access").await;

    let held = harness.until_status(&message_id, "held").await;
    assert_eq!(
        held.reason,
        Some(AgentMessageReason::RecipientModeAboveSender)
    );
    harness.until_entry(&command_id, "dismissed").await;
    harness.provider_turn("b", "turn-b", "working", true).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(harness.entry_state(&command_id).await, "dismissed");
    let row = harness.message_row(&message_id).await;
    assert_eq!(row.status.as_str(), "held");
    assert_eq!(
        row.reason,
        Some(AgentMessageReason::RecipientModeAboveSender)
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn a_held_message_leaves_the_turn_queue() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.set_mode("a", "auto-accept-edits").await;
    harness.set_mode("b", "auto-accept-edits").await;
    let message_id = harness.sent("a", "thread:b").await;
    let person = harness.person_queues("b").await;
    assert_eq!(harness.entry_state(&person).await, "queued");

    harness.set_mode("b", "full-access").await;
    harness.until_status(&message_id, "held").await;
    harness.provider_turn("b", "turn-b", "working", true).await;

    harness.until_entry(&person, "delivered").await;
    harness.shutdown().await;
}

#[tokio::test]
async fn a_candidate_that_passed_collection_is_stopped_at_the_claim_by_a_mode_change() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.stop_delivery().await;
    harness.set_mode("a", "auto-accept-edits").await;
    harness.set_mode("p", "auto-accept-edits").await;
    let message_id = harness.sent_untracked("a", "thread:p").await;
    assert_eq!(
        harness.outbox_states("p").await[0].1,
        "pending",
        "listed for delivery"
    );
    // No tracker runs, so only the claim can see the change.
    harness.set_mode("p", "full-access").await;

    assert!(harness.claim(&message_id).await.is_none());

    let row = harness.message_row(&message_id).await;
    assert_eq!(row.status.as_str(), "held");
    assert_eq!(
        row.reason,
        Some(AgentMessageReason::RecipientModeAboveSender)
    );
    assert_eq!(harness.outbox_states("p").await[0].1, "pending", "not sent");
    harness.shutdown().await;
}

#[tokio::test]
async fn a_delivery_claimed_after_messaging_was_switched_off_is_held() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.stop_delivery().await;
    let message_id = harness.sent_untracked("a", "thread:p").await;

    harness.messaging_enabled.send_replace(false);

    assert!(harness.claim(&message_id).await.is_none());
    let row = harness.message_row(&message_id).await;
    assert_eq!(row.status.as_str(), "held");
    assert_eq!(row.reason, Some(AgentMessageReason::MessagingOff));
    harness.shutdown().await;
}

#[tokio::test]
async fn a_held_row_is_never_claimed() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.stop_delivery().await;
    let message_id = harness.sent_untracked("a", "thread:p").await;
    let held_id = message_id.clone();
    harness
        .repositories
        .database()
        .call(move |connection| {
            crate::agent_messaging::store::set_status(
                connection,
                &held_id,
                crate::agent_messaging::store::AgentMessageStatus::Held,
                Some(AgentMessageReason::MessagingOff),
                CREATED_AT,
            )
        })
        .await
        .expect("held");
    let before = harness.message_row(&message_id).await;

    assert!(harness.claim(&message_id).await.is_none());

    assert_eq!(harness.message_row(&message_id).await, before);
    assert_eq!(harness.outbox_states("p").await[0].1, "pending");
    harness.shutdown().await;
}

#[tokio::test]
async fn a_claim_time_hold_does_not_block_a_person_message_behind_it() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let message_id = harness.sent("a", "thread:b").await;
    let person = harness.person_queues("b").await;
    harness.messaging_enabled.send_replace(false);

    harness.provider_turn("b", "turn-b", "working", true).await;

    let row = harness.until_status(&message_id, "held").await;
    assert_eq!(row.reason, Some(AgentMessageReason::MessagingOff));
    harness
        .until_entry(&row.delivery_command_id.expect("entry"), "dismissed")
        .await;
    harness.until_entry(&person, "delivered").await;
    harness.shutdown().await;
}

#[tokio::test]
async fn a_held_message_has_no_live_queue_entry_after_a_restart_between_hold_and_withdrawal() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let message_id = harness.sent_untracked("a", "thread:b").await;
    let person = harness.person_queues("b").await;
    // The hold was written, then the server stopped before the entry was withdrawn.
    let held_id = message_id.clone();
    harness
        .repositories
        .database()
        .call(move |connection| {
            crate::agent_messaging::store::set_status(
                connection,
                &held_id,
                crate::agent_messaging::store::AgentMessageStatus::Held,
                Some(AgentMessageReason::MessagingOff),
                CREATED_AT,
            )
        })
        .await
        .expect("held");

    crate::agent_messaging::delivery::reconcile_all(&harness.engine, None)
        .await
        .expect("startup reconciliation");

    let row = harness.message_row(&message_id).await;
    assert_eq!(row.status.as_str(), "held");
    assert_eq!(
        harness
            .entry_state(&row.delivery_command_id.expect("entry"))
            .await,
        "dismissed"
    );
    harness.provider_turn("b", "turn-b", "working", true).await;
    harness.until_entry(&person, "delivered").await;
    harness.shutdown().await;
}

#[tokio::test]
async fn a_failed_delivery_leaves_nothing_for_a_person_to_retry() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let message_id = harness.sent("a", "thread:p").await;
    harness
        .delivery_moves(
            &message_id,
            &[("pending", "sending"), ("sending", "failed")],
        )
        .await;
    let row = harness.until_status(&message_id, "failed").await;
    let command_id = row.delivery_command_id.expect("entry");
    harness.until_entry(&command_id, "dismissed").await;

    let retry = harness
        .engine
        .dispatch(command(json!({
            "type": "thread.turn-delivery.resolve", "commandId": "person-retry", "threadId": "p",
            "messageId": row.delivery_message_id.expect("delivery message"), "action": "retry",
            "createdAt": CREATED_AT,
        })))
        .await;

    assert!(retry.is_err(), "nothing to retry");
    assert_eq!(harness.entry_state(&command_id).await, "dismissed");
    harness.shutdown().await;
}

#[tokio::test]
async fn the_directory_marks_a_higher_mode_recipient_as_not_receivable() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.set_mode("a", "auto-accept-edits").await;
    harness.set_mode("p", "approval-required").await;

    let result = harness.agents_list("a", true).await;

    let can_receive: Vec<(&str, bool)> = named(&result)
        .into_iter()
        .map(|agent| {
            (
                agent["address"].as_str().expect("address"),
                agent["canReceive"].as_bool().expect("canReceive"),
            )
        })
        .collect();
    assert_eq!(can_receive, [("thread:b", false), ("thread:p", true)]);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_mode_that_falls_holds_nothing() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let message_id = harness.sent("a", "thread:b").await;
    harness.until_status(&message_id, "queued").await;

    harness.set_mode("b", "approval-required").await;
    harness.provider_turn("b", "turn-b", "working", true).await;

    harness.until_status(&message_id, "delivered").await;
    harness.shutdown().await;
}

#[tokio::test]
async fn a_message_already_delivered_is_not_held_by_a_later_mode_change() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.set_mode("a", "auto-accept-edits").await;
    harness.set_mode("p", "auto-accept-edits").await;
    let message_id = harness.sent("a", "thread:p").await;
    harness.until_status(&message_id, "delivered").await;

    harness.set_mode("p", "full-access").await;
    harness
        .provider_turn("p", "turn-p", "Port 5173", false)
        .await;

    let row = harness.until_status(&message_id, "consumed").await;
    assert_eq!(row.reason, None);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_persons_request_is_not_gated() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness.stop_delivery().await;
    harness.messaging_untracked(true);
    let person = harness.person_queues("p").await;
    assert_eq!(harness.entry_state(&person).await, "pending");
    let command_id = person.clone();
    harness
        .repositories
        .database()
        .call(move |connection| {
            let tx = connection.transaction()?;
            crate::agent_messaging::store::insert_message(
                &tx,
                &crate::agent_messaging::store::NewAgentMessage {
                    message_id: "person-request".to_owned(),
                    conversation_id: "c1".to_owned(),
                    sender_address: "thread:a".to_owned(),
                    sender_kind: crate::agent_messaging::store::SenderKind::Person,
                    recipient_address: "thread:p".to_owned(),
                    in_reply_to: None,
                    hop: 1,
                    text: "From a person".to_owned(),
                    status: crate::agent_messaging::store::AgentMessageStatus::Accepted,
                    reason: None,
                    accepted_at: CREATED_AT.to_owned(),
                    sender_runtime_mode: Some("approval-required".to_owned()),
                    recipient_terminal_generation: None,
                    send_request_id: None,
                    client_request_id: None,
                    delivery_command_id: Some(command_id),
                    delivery_message_id: None,
                },
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
        .expect("a person's row");
    harness.messaging_enabled.send_replace(false);

    let claimed = harness.claim("person-request").await;

    assert!(claimed.is_some(), "a person's request is claimed");
    harness.shutdown().await;
}

// ---- Task 6.2: no user authority ----

mod no_user_authority {
    use super::*;

    impl Harness {
        /// The provider of `thread_id` asks `kind` (`approval` or `user-input`) `request_id`.
        pub(super) async fn provider_asks(&self, thread_id: &str, kind: &str, request_id: &str) {
            let payload = match kind {
                "approval" => json!({ "requestId": request_id, "requestKind": "command" }),
                _ => {
                    json!({ "requestId": request_id, "questions": [{ "id": "color", "header": "Color", "question": "Which?", "options": [{ "label": "Red", "description": "" }] }] })
                }
            };
            self.provider_activity(thread_id, &format!("{kind}.requested"), payload)
                .await;
        }

        /// The provider of `thread_id` reports `kind` `request_id` resolved with `payload`.
        pub(super) async fn provider_resolves(&self, thread_id: &str, kind: &str, payload: Value) {
            self.provider_activity(thread_id, &format!("{kind}.resolved"), payload)
                .await;
        }

        async fn provider_activity(&self, thread_id: &str, kind: &str, payload: Value) {
            let id = format!("{kind}-{}", uuid::Uuid::new_v4());
            self.engine
                .dispatch(command(json!({
                    "type": "thread.activity.append", "commandId": id, "threadId": thread_id,
                    "activity": {
                        "id": id, "tone": "approval", "kind": kind, "summary": "Needs you",
                        "payload": payload, "turnId": "turn-b", "createdAt": CREATED_AT,
                    },
                    "createdAt": CREATED_AT,
                })))
                .await
                .expect("provider activity");
        }

        async fn approval(&self, request_id: &'static str) -> (String, Option<String>) {
            self.repositories
                .database()
                .call(move |connection| {
                    Ok(connection.query_row(
                        "SELECT status, decision FROM projection_pending_approvals WHERE request_id = ?1",
                        [request_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?)
                })
                .await
                .expect("approval")
        }

        /// The approval and question responses in the event log, with their command ids.
        async fn responses(&self) -> Vec<(String, String)> {
            self.repositories
                .database()
                .call(|connection| {
                    let mut statement = connection.prepare(
                        "SELECT event_type, command_id FROM orchestration_events
                          WHERE event_type IN ('thread.approval-response-requested', 'thread.user-input-response-requested')
                          ORDER BY sequence",
                    )?;
                    let rows = statement
                        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    Ok(rows)
                })
                .await
                .expect("responses")
        }

        /// What `pending_approval` and `a_user_input_request_is_not_answered_by_a_message`
        /// share: B runs and asks `kind`, A messages it, and only the person's answer and B's
        /// next ready state let the message in.
        async fn a_message_does_not_answer(&self, kind: &str, respond: Value, resolved: Value) {
            self.messaging_threads().await;
            self.provider_asks("b", kind, "r1").await;

            let message_id = self.sent_text("a", "thread:b", "approve it").await;

            self.until_status(&message_id, "queued").await;
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            assert_eq!(
                self.message_row(&message_id).await.status.as_str(),
                "queued"
            );
            assert!(
                self.responses().await.is_empty(),
                "the message answered nothing"
            );

            self.engine
                .dispatch(command(respond))
                .await
                .expect("the person answers");
            self.provider_resolves("b", kind, resolved).await;
            self.provider_turn("b", "turn-b", "working", true).await;

            let row = self.until_status(&message_id, "delivered").await;
            let (text, actor) = self
                .projected_message(row.delivery_message_id.expect("queue entry"))
                .await;
            assert!(text.starts_with("<bibcode_agent_message>\n"), "{text}");
            assert_eq!(actor["kind"], "hosted-agent");
            let responses = self.responses().await;
            assert_eq!(responses.len(), 1, "{responses:?}");
            assert_eq!(responses[0].1, "person-answer");
        }

        pub(super) async fn sent_text(&self, caller: &str, to: &str, text: &str) -> String {
            let result = self.agent_send(caller, send_arguments(to, text)).await;
            assert_ne!(result["isError"], true, "{result}");
            structured(&result)["messageId"]
                .as_str()
                .expect("message id")
                .to_owned()
        }
    }

    #[tokio::test]
    async fn pending_approval() {
        let harness = Harness::new().await;

        harness
            .a_message_does_not_answer(
                "approval",
                json!({
                    "type": "thread.approval.respond", "commandId": "person-answer",
                    "threadId": "b", "requestId": "r1", "decision": "accept",
                    "createdAt": CREATED_AT,
                }),
                json!({ "requestId": "r1", "decision": "accept" }),
            )
            .await;

        assert_eq!(
            harness.approval("r1").await,
            ("resolved".to_owned(), Some("accept".to_owned())),
            "the person's decision"
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_user_input_request_is_not_answered_by_a_message() {
        let harness = Harness::new().await;

        harness
            .a_message_does_not_answer(
                "user-input",
                json!({
                    "type": "thread.user-input.respond", "commandId": "person-answer",
                    "threadId": "b", "requestId": "r1", "answers": { "color": "Red" },
                    "createdAt": CREATED_AT,
                }),
                json!({ "requestId": "r1", "answers": { "color": "Red" } }),
            )
            .await;

        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_ready_session_with_an_open_approval_still_queues_the_message() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.provider_turn("b", "turn-b", "working", true).await;
        // As after a restart: the session is ready and its approval still open.
        harness.provider_asks("b", "approval", "r1").await;

        let message_id = harness.sent_text("a", "thread:b", "approve it").await;

        let command_id = harness
            .message_row(&message_id)
            .await
            .delivery_command_id
            .expect("queue entry");
        assert_eq!(harness.entry_state(&command_id).await, "queued");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(
            harness.entry_state(&command_id).await,
            "queued",
            "nothing handed to the provider"
        );
        assert_eq!(harness.approval("r1").await.0, "pending");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn messaging_never_dispatches_an_approval_or_an_answer() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.provider_asks("b", "approval", "r1").await;
        harness.provider_asks("b", "user-input", "r2").await;
        harness.provider_asks("p", "approval", "r3").await;

        let to_b = harness.sent_text("a", "thread:b", "approve it").await;
        harness.sent_text("a", "thread:p", "accept r3").await;
        let reply = harness.reply("b", &to_b, "yes").await;
        assert_ne!(reply["isError"], true, "{reply}");
        crate::agent_messaging::delivery::reconcile_all(&harness.engine, None)
            .await
            .expect("reconciled");

        assert_eq!(harness.responses().await, Vec::<(String, String)>::new());
        for request_id in ["r1", "r3"] {
            assert_eq!(harness.approval(request_id).await.0, "pending");
        }
        harness.shutdown().await;
    }
}

// ---- Task 6.3: idempotent sends ----

mod idempotent_sends {
    use super::*;

    fn with_id(to: &str, text: &str, id: &str) -> Value {
        json!({ "to": to, "text": text, "clientRequestId": id })
    }

    impl Harness {
        /// The rows of `agent_messages`, the queue entries of `thread_id` and the projected
        /// user messages of `thread_id`.
        async fn stored_counts(&self, thread_id: &'static str) -> (usize, usize, i64) {
            let projected = self
                .repositories
                .database()
                .call(move |connection| {
                    Ok(connection.query_row(
                        "SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ?1 AND role = 'user'",
                        [thread_id],
                        |row| row.get(0),
                    )?)
                })
                .await
                .expect("projected messages");
            (
                self.agent_messages().await.len(),
                self.outbox_states(thread_id).await.len(),
                projected,
            )
        }
    }

    #[tokio::test]
    async fn retry_after_a_timeout() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;

        let first = harness
            .agent_send("a", with_id("thread:b", "Which port?", "k"))
            .await;
        let retry = harness
            .agent_send("a", with_id("thread:b", "Which port?", "k"))
            .await;

        assert_eq!(
            structured(&first)["messageId"],
            structured(&retry)["messageId"]
        );
        assert_eq!(
            structured(&first)["conversationId"],
            structured(&retry)["conversationId"]
        );
        assert_eq!(harness.stored_counts("b").await, (1, 1, 1));
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn same_id_other_arguments() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let first = harness
            .agent_send("a", with_id("thread:b", "Which port?", "k"))
            .await;
        let m1 = structured(&first)["messageId"]
            .as_str()
            .expect("id")
            .to_owned();
        let to_a = harness.sent("b", "thread:a").await;

        for (label, result) in [
            (
                "other text",
                harness
                    .agent_send("a", with_id("thread:b", "Which host?", "k"))
                    .await,
            ),
            (
                "other recipient",
                harness
                    .agent_send("a", with_id("thread:p", "Which port?", "k"))
                    .await,
            ),
            (
                "a reply",
                harness
                    .agent_tool(
                        "a",
                        "agent_message_reply",
                        json!({ "inReplyTo": to_a, "text": "Which port?", "clientRequestId": "k" }),
                    )
                    .await,
            ),
        ] {
            assert_eq!(error_tag(&result), "AgentMessagingConflictError", "{label}");
            assert_eq!(
                result["structuredContent"]["error"]["message"],
                "This clientRequestId was already used for a different message. Use a new id.",
                "{label}"
            );
        }
        let stored = harness.agent_messages().await;
        assert_eq!(stored.len(), 2, "{stored:?}");
        assert_eq!(stored[0].message_id, m1);
        assert!(harness.outbox_states("p").await.is_empty());
        assert_eq!(harness.outbox_states("b").await.len(), 1);
        assert_eq!(harness.outbox_states("a").await.len(), 1);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_reply_retry_is_idempotent() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        let arguments = json!({ "inReplyTo": m1, "text": "Port 5173", "clientRequestId": "k" });

        let first = harness
            .agent_tool("b", "agent_message_reply", arguments.clone())
            .await;
        let retry = harness
            .agent_tool("b", "agent_message_reply", arguments)
            .await;

        assert_eq!(
            structured(&first)["messageId"],
            structured(&retry)["messageId"]
        );
        assert_eq!(harness.agent_messages().await.len(), 2, "m1 and one reply");
        assert_eq!(harness.outbox_states("a").await.len(), 1);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn an_id_belongs_to_one_sender() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;

        let from_a = harness
            .agent_send("a", with_id("thread:b", "Which port?", "k"))
            .await;
        let from_p = harness
            .agent_send("p", with_id("thread:b", "Which host?", "k"))
            .await;

        assert_ne!(from_p["isError"], true, "{from_p}");
        assert_ne!(
            structured(&from_a)["messageId"],
            structured(&from_p)["messageId"]
        );
        assert_eq!(harness.agent_messages().await.len(), 2);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn concurrent_sends_with_one_id_store_one_message() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let messaging = harness.messaging(true);

        let (first, second) = tokio::join!(
            run(
                scope("a"),
                "agent_message_send",
                with_id("thread:b", "Which port?", "k"),
                Some(&messaging)
            ),
            run(
                scope("a"),
                "agent_message_send",
                with_id("thread:b", "Which port?", "k"),
                Some(&messaging)
            ),
        );

        assert_eq!(
            structured(&first)["messageId"],
            structured(&second)["messageId"]
        );
        assert_eq!(
            harness.stored_counts("b").await,
            (1, 1, 1),
            "the losing call leaves no queue entry and no projected message"
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn no_id_means_no_deduplication() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;

        harness.sent("a", "thread:b").await;
        harness.sent("a", "thread:b").await;

        assert_eq!(harness.agent_messages().await.len(), 2);
        assert_eq!(harness.outbox_states("b").await.len(), 2);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_retry_while_messaging_is_off_is_refused() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let first = harness
            .agent_send("a", with_id("thread:b", "Which port?", "k"))
            .await;
        assert_ne!(first["isError"], true, "{first}");

        let retry = run(
            scope("a"),
            "agent_message_send",
            with_id("thread:b", "Which port?", "k"),
            Some(&harness.messaging(false)),
        )
        .await;

        assert_eq!(error_tag(&retry), "AgentMessagingDisabledError");
        harness.shutdown().await;
    }
}

// ---- Review findings on tasks 6.1 to 6.3 ----

mod safety_review {
    use super::*;
    use crate::orchestration::{OrchestrationCommand, engine::resend_command_id};

    impl Harness {
        /// The queue entry of `message_id` was delivered into the saved conversation of
        /// `thread_id`, its turn `turn_id` ran near the context limit and failed at it before any
        /// output, so the failure is recovered by a compaction; returns that compaction's id.
        async fn fails_at_the_context_limit(
            &self,
            thread_id: &str,
            message_id: &str,
            turn_id: &str,
        ) -> String {
            let command_id = self
                .message_row(message_id)
                .await
                .delivery_command_id
                .expect("queue entry");
            self.repositories
                .database()
                .call(move |connection| {
                    connection.execute(
                        "UPDATE provider_turn_outbox SET state = 'delivered', attempts = 1, provider_session_id = 'conversation' WHERE command_id = ?1",
                        [&command_id],
                    )?;
                    Ok(())
                })
                .await
                .expect("delivered");
            let session = |status: &str, active: Option<&str>| {
                json!({
                    "threadId": thread_id, "status": status, "providerName": "codex",
                    "providerInstanceId": "codex", "runtimeMode": "full-access",
                    "activeTurnId": active, "lastError": null, "updatedAt": CREATED_AT,
                })
            };
            let mut failed = session("error", None);
            failed["lastError"] = json!("The context window is full.");
            failed["lastErrorClass"] = json!("context_limit");
            for value in [
                json!({
                    "type": "thread.session.set", "commandId": format!("running-{turn_id}"),
                    "threadId": thread_id, "session": session("running", Some(turn_id)),
                    "createdAt": CREATED_AT,
                }),
                json!({
                    "type": "thread.activity.append", "commandId": format!("reading-{turn_id}"),
                    "threadId": thread_id,
                    "activity": {
                        "id": format!("reading-{turn_id}"), "tone": "info",
                        "kind": "context-window.updated", "summary": "Context window updated",
                        "payload": {
                            "usedTokens": 961_230, "maxTokens": 1_000_000,
                            "compactsAutomatically": true, "autoCompactTokens": 967_000,
                            "providerInstanceId": "codex", "conversationId": "conversation",
                        },
                        "turnId": turn_id, "createdAt": CREATED_AT,
                    },
                    "createdAt": CREATED_AT,
                }),
                json!({
                    "type": "thread.session.set", "commandId": format!("limit-{turn_id}"),
                    "threadId": thread_id, "session": failed,
                    "contextLimit": { "turnId": turn_id, "beforeOutput": true },
                    "createdAt": CREATED_AT,
                }),
            ] {
                self.engine
                    .dispatch(command(value))
                    .await
                    .expect("provider event");
            }
            let compactions = self
                .engine
                .unsettled_thread_compactions()
                .await
                .expect("compactions");
            assert_eq!(compactions.len(), 1, "one recovery: {compactions:?}");
            compactions[0].compaction_id.clone()
        }

        async fn settle(&self, thread_id: &str, compaction_id: &str, outcome: &str) {
            self.engine
                .dispatch(OrchestrationCommand::ThreadCompactionSettle {
                    command_id: format!("server:compaction-settle:{compaction_id}"),
                    thread_id: thread_id.to_owned(),
                    compaction_id: compaction_id.to_owned(),
                    outcome: outcome.to_owned(),
                    detail: None,
                    restarted: false,
                    created_at: CREATED_AT.to_owned(),
                })
                .await
                .expect("settled");
        }

        async fn is_agent_delivery(&self, command_id: String, message_id: String) -> bool {
            self.repositories
                .database()
                .call(move |connection| {
                    crate::agent_messaging::store::is_agent_message_delivery(
                        connection,
                        &command_id,
                        &message_id,
                    )
                })
                .await
                .expect("readable")
        }
    }

    /// N1: the copy a context-limit recovery sends is still the agent's message, so the claim
    /// gate holds it while messaging is off.
    #[tokio::test]
    async fn a_context_limit_resend_is_held_while_messaging_is_off() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.stop_delivery().await;
        let message_id = harness.sent("a", "thread:p").await;
        let failed = harness.message_row(&message_id).await;
        let compaction = harness
            .fails_at_the_context_limit("p", &message_id, "turn-p")
            .await;
        harness.messaging_enabled.send_replace(false);

        harness.settle("p", &compaction, "completed").await;

        let copy = resend_command_id(&failed.delivery_message_id.expect("delivery message"));
        let claimed = harness
            .engine
            .repositories()
            .claim_provider_turn(copy.clone(), CREATED_AT.to_owned())
            .await
            .expect("claim");
        assert!(claimed.is_none(), "the copy reached the provider");
        let row = harness.message_row(&message_id).await;
        assert_eq!(row.delivery_command_id.as_deref(), Some(copy.as_str()));
        assert_eq!(row.status.as_str(), "held");
        assert_eq!(row.reason, Some(AgentMessageReason::MessagingOff));
        harness.shutdown().await;
    }

    /// N1: the copy is delivered as an agent message (the envelope treatment) and the message's
    /// status follows the copy, not the failed turn.
    #[tokio::test]
    async fn a_context_limit_resend_is_delivered_as_the_agent_message() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.stop_delivery().await;
        let message_id = harness.sent("a", "thread:p").await;
        let failed = harness.message_row(&message_id).await;
        let compaction = harness
            .fails_at_the_context_limit("p", &message_id, "turn-p")
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_ne!(
            harness.message_row(&message_id).await.status.as_str(),
            "failed",
            "a recovered turn does not fail the message"
        );

        harness.settle("p", &compaction, "completed").await;

        let row = harness.message_row(&message_id).await;
        let (copy_command, copy_message) = (
            row.delivery_command_id.clone().expect("copy"),
            row.delivery_message_id.clone().expect("copy"),
        );
        assert_ne!(
            Some(copy_command.as_str()),
            failed.delivery_command_id.as_deref()
        );
        assert!(
            harness
                .is_agent_delivery(copy_command, copy_message.clone())
                .await
        );
        let (_, actor) = harness.projected_message(copy_message).await;
        assert_eq!(
            actor,
            json!({ "kind": "hosted-agent", "address": "thread:a", "label": "Claude thread" }),
            "the copy shows the agent that sent it"
        );
        assert_eq!(
            row.recipient_turn_id, None,
            "the failed turn is not its turn"
        );
        assert!(harness.claim(&message_id).await.is_some());
        harness.provider_turn("p", "turn-copy", "Port", true).await;
        harness.until_status(&message_id, "completed").await;
        harness.shutdown().await;
    }

    /// N1: a recovery that ends without a copy fails the message with its turn.
    #[tokio::test]
    async fn a_failed_recovery_fails_the_agent_message() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.stop_delivery().await;
        let message_id = harness.sent("a", "thread:p").await;
        let compaction = harness
            .fails_at_the_context_limit("p", &message_id, "turn-p")
            .await;

        harness.settle("p", &compaction, "failed").await;

        let row = harness.until_status(&message_id, "failed").await;
        assert_eq!(row.reason, Some(AgentMessageReason::RecipientTurnFailed));
        harness.shutdown().await;
    }

    impl Harness {
        /// B's turn ended with `kind` still open, as after a restart, and A's message waits in
        /// B's queue; returns its id.
        async fn queued_behind_an_open(&self, kind: &str) -> String {
            self.messaging_threads().await;
            self.provider_turn("b", "turn-b", "working", true).await;
            self.provider_asks("b", kind, "r1").await;
            let message_id = self.sent_text("a", "thread:b", "approve it").await;
            self.until_status(&message_id, "queued").await;
            message_id
        }

        async fn promote(&self, message_id: &str) -> Result<(), String> {
            let row = self.message_row(message_id).await;
            self.engine
                .dispatch(command(json!({
                    "type": "thread.turn.promote", "commandId": "person-send-now",
                    "threadId": "b", "messageId": row.delivery_message_id.expect("entry"),
                    "createdAt": CREATED_AT,
                })))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        }

        async fn force_pending(&self, message_id: &str) {
            let command_id = self
                .message_row(message_id)
                .await
                .delivery_command_id
                .expect("entry");
            self.repositories
                .database()
                .call(move |connection| {
                    connection.execute(
                        "UPDATE provider_turn_outbox SET state = 'pending' WHERE command_id = ?1",
                        [&command_id],
                    )?;
                    Ok(())
                })
                .await
                .expect("pending");
        }
    }

    const WAITS_FOR_AN_ANSWER: &str =
        "An agent message waits for the open approval or question to be answered.";

    /// N2: Send now does not take an agent message past an open approval or question.
    #[tokio::test]
    async fn send_now_does_not_take_an_agent_message_past_an_open_ask() {
        for kind in ["approval", "user-input"] {
            let harness = Harness::new().await;
            let message_id = harness.queued_behind_an_open(kind).await;

            let refused = harness.promote(&message_id).await.expect_err(kind);

            assert!(refused.contains(WAITS_FOR_AN_ANSWER), "{kind}: {refused}");
            assert!(!refused.contains("approve it"), "{refused}");
            let command_id = harness
                .message_row(&message_id)
                .await
                .delivery_command_id
                .expect("entry");
            assert_eq!(harness.entry_state(&command_id).await, "queued", "{kind}");
            harness.shutdown().await;
        }
    }

    /// N2: whatever made the entry pending, the claim does not hand an agent message to a
    /// recipient with an open approval or question; it does once the ask is answered.
    #[tokio::test]
    async fn the_claim_waits_for_an_open_ask() {
        for (kind, resolved) in [
            (
                "approval",
                json!({ "requestId": "r1", "decision": "accept" }),
            ),
            (
                "user-input",
                json!({ "requestId": "r1", "answers": { "color": "Red" } }),
            ),
        ] {
            let harness = Harness::new().await;
            let message_id = harness.queued_behind_an_open(kind).await;
            harness.stop_delivery().await;
            harness.force_pending(&message_id).await;

            assert!(harness.claim(&message_id).await.is_none(), "{kind}");
            let row = harness.message_row(&message_id).await;
            assert_ne!(row.status.as_str(), "held", "{kind}: waits, not held");

            harness.provider_resolves("b", kind, resolved).await;
            assert!(harness.claim(&message_id).await.is_some(), "{kind}");
            harness.shutdown().await;
        }
    }

    /// N2: a person's own message keeps Send now past an open ask.
    #[tokio::test]
    async fn a_persons_send_now_is_unchanged_by_an_open_ask() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.provider_asks("b", "approval", "r1").await;
        let person = harness.person_queues("b").await;
        harness.session_ends("b", "ready").await;
        assert_eq!(harness.entry_state(&person).await, "queued");
        let message_id = harness
            .repositories
            .get_provider_turn_delivery(person.clone())
            .await
            .expect("readable")
            .expect("entry")
            .message_id;

        harness
            .engine
            .dispatch(command(json!({
                "type": "thread.turn.promote", "commandId": "person-send-now",
                "threadId": "b", "messageId": message_id, "createdAt": CREATED_AT,
            })))
            .await
            .expect("a person's Send now");
        harness.until_entry(&person, "delivered").await;
        harness.shutdown().await;
    }

    /// N3: an early item that settles before the running event still ties the message to its
    /// own turn.
    #[tokio::test]
    async fn an_early_item_that_settles_keeps_the_message_on_its_turn() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.provider_turn("a", "turn-a", "done", true).await;
        harness.stop_delivery().await;
        let message_id = harness.sent_untracked("b", "thread:a").await;
        harness
            .delivery_moves(&message_id, &[("pending", "sending")])
            .await;

        harness.early_delta("a", "turn-t").await;
        harness
            .engine
            .dispatch(command(json!({
                "type": "thread.message.assistant.complete", "commandId": "early-complete",
                "threadId": "a", "messageId": "reply-turn-t", "turnId": "turn-t",
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("early settled item");
        harness.provider_turn("a", "turn-t", "Port", false).await;
        harness
            .delivery_moves(&message_id, &[("sending", "delivered")])
            .await;

        let row = harness.reconciled_status(&message_id).await;
        assert_eq!(row.recipient_turn_id.as_deref(), Some("turn-t"));
        assert_eq!(row.status.as_str(), "consumed");
        harness.shutdown().await;
    }

    /// N3: a running event that names a turn older than the message never takes its marker.
    #[tokio::test]
    async fn an_older_turn_never_takes_the_marker() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.provider_turn("a", "turn-old", "done", true).await;
        harness.stop_delivery().await;
        let message_id = harness.sent_untracked("b", "thread:a").await;
        harness
            .delivery_moves(
                &message_id,
                &[("pending", "sending"), ("sending", "delivered")],
            )
            .await;

        harness.provider_turn("a", "turn-old", "again", false).await;

        let row = harness.reconciled_status(&message_id).await;
        assert_ne!(row.recipient_turn_id.as_deref(), Some("turn-old"));
        assert_eq!(row.status.as_str(), "delivered");
        harness.shutdown().await;
    }

    /// N4: a person cannot retry a failed agent delivery, even before the tracker withdrew it.
    #[tokio::test]
    async fn a_failed_agent_delivery_cannot_be_retried_before_the_tracker_sees_it() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.stop_delivery().await;
        let message_id = harness.sent_untracked("a", "thread:p").await;
        harness
            .delivery_moves(
                &message_id,
                &[("pending", "sending"), ("sending", "failed")],
            )
            .await;
        let row = harness.message_row(&message_id).await;
        assert_eq!(row.status.as_str(), "accepted", "no tracker has seen it");

        let refused = harness
            .engine
            .dispatch(command(json!({
                "type": "thread.turn-delivery.resolve", "commandId": "person-retry",
                "threadId": "p", "messageId": row.delivery_message_id.clone().expect("entry"),
                "action": "retry", "createdAt": CREATED_AT,
            })))
            .await
            .expect_err("an agent message is not retried")
            .to_string();

        assert!(
            refused.contains(
                "A failed agent message is not sent again. Its sender can send it again."
            ),
            "{refused}"
        );
        assert!(!refused.contains("hello"), "{refused}");
        let command_id = row.delivery_command_id.expect("entry");
        assert_eq!(harness.entry_state(&command_id).await, "failed");
        assert!(harness.claim(&message_id).await.is_none());
        harness.shutdown().await;
    }

    /// N4: a person's own failed delivery is still retried.
    #[tokio::test]
    async fn a_persons_failed_delivery_is_still_retried() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.stop_delivery().await;
        let person = harness.person_queues("p").await;
        let entry = harness
            .repositories
            .get_provider_turn_delivery(person.clone())
            .await
            .expect("readable")
            .expect("entry");
        harness
            .engine
            .transition_turn_delivery(TurnDeliveryTransition {
                turn_id: None,
                command_id: person.clone(),
                expected_states: vec![TurnDeliveryState::Pending],
                expected_attempt: entry.attempts,
                next_state: TurnDeliveryState::Failed,
                detail: None,
                updated_at: CREATED_AT.to_owned(),
            })
            .await
            .expect("failed");

        harness
            .engine
            .dispatch(command(json!({
                "type": "thread.turn-delivery.resolve", "commandId": "person-retry",
                "threadId": "p", "messageId": entry.message_id, "action": "retry",
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("a person's retry");
        assert_eq!(harness.entry_state(&person).await, "pending");
        harness.shutdown().await;
    }

    /// N4 follow-up: a person's retry of an uncertain agent delivery waits for an open ask, as
    /// Send now does.
    #[tokio::test]
    async fn a_retry_does_not_take_an_agent_message_past_an_open_ask() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.stop_delivery().await;
        let message_id = harness.sent_untracked("a", "thread:p").await;
        harness
            .delivery_moves(
                &message_id,
                &[("pending", "sending"), ("sending", "uncertain")],
            )
            .await;
        harness.provider_asks("p", "approval", "r1").await;
        let row = harness.message_row(&message_id).await;

        let refused = harness
            .engine
            .dispatch(command(json!({
                "type": "thread.turn-delivery.resolve", "commandId": "person-retry",
                "threadId": "p", "messageId": row.delivery_message_id.clone().expect("entry"),
                "action": "retry", "createdAt": CREATED_AT,
            })))
            .await
            .expect_err("the ask is open")
            .to_string();

        assert!(refused.contains(WAITS_FOR_AN_ANSWER), "{refused}");
        assert_eq!(
            harness
                .entry_state(&row.delivery_command_id.expect("entry"))
                .await,
            "uncertain"
        );
        harness.shutdown().await;
    }

    /// Review follow-up: a released message runs in the recipient's current modes, not those
    /// of its first send.
    #[tokio::test]
    async fn a_released_message_takes_the_recipients_current_mode() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        harness.messaging_enabled.send_replace(false);
        harness
            .until_held_for(&m1, AgentMessageReason::MessagingOff)
            .await;
        harness.set_mode("b", "approval-required").await;

        harness.messaging_enabled.send_replace(true);

        harness.until_status(&m1, "queued").await;
        let entry = harness
            .repositories
            .get_provider_turn_delivery(harness.entry_of(&m1).await)
            .await
            .expect("readable")
            .expect("entry");
        assert_eq!(entry.payload["runtimeMode"], "approval-required");
        harness.shutdown().await;
    }

    /// N5: a retry with the same clientRequestId replays the stored receipt after its
    /// recipient was archived or deleted, for a send and for a reply.
    #[tokio::test]
    async fn a_replay_does_not_need_a_live_recipient() {
        for gone in ["thread.archive", "thread.delete"] {
            let harness = Harness::new().await;
            harness.messaging_threads().await;
            let arguments =
                json!({ "to": "thread:p", "text": "Which port?", "clientRequestId": "k" });
            let first = harness.agent_send("a", arguments.clone()).await;
            assert_ne!(first["isError"], true, "{first}");
            let m1 = harness.sent("b", "thread:a").await;
            let reply = json!({ "inReplyTo": m1, "text": "Port 5173", "clientRequestId": "r" });
            let first_reply = harness
                .agent_tool("a", "agent_message_reply", reply.clone())
                .await;
            assert_ne!(first_reply["isError"], true, "{first_reply}");
            for thread_id in ["p", "b"] {
                harness
                    .engine
                    .dispatch(command(json!({
                        "type": gone, "commandId": format!("{gone}-{thread_id}"),
                        "threadId": thread_id,
                    })))
                    .await
                    .expect("gone");
            }

            let retry = harness.agent_send("a", arguments).await;
            let reply_retry = harness.agent_tool("a", "agent_message_reply", reply).await;

            assert_ne!(retry["isError"], true, "{gone}: {retry}");
            assert_eq!(
                structured(&first)["messageId"],
                structured(&retry)["messageId"],
                "{gone}"
            );
            assert_ne!(reply_retry["isError"], true, "{gone}: {reply_retry}");
            assert_eq!(
                structured(&first_reply)["messageId"],
                structured(&reply_retry)["messageId"],
                "{gone}"
            );
            harness.shutdown().await;
        }
    }
}

// ---- Task 6.4: ordering and turning messaging off ----

impl Harness {
    async fn entry_of(&self, message_id: &str) -> String {
        self.message_row(message_id)
            .await
            .delivery_command_id
            .expect("queue entry")
    }

    /// Lets B's current turn end and the next one, which takes the promoted entry, end too.
    async fn b_takes_its_next_turn(&self, turn_id: &str) {
        self.provider_turn("b", turn_id, "ok", true).await;
    }

    /// Waits until the message is held for `reason`.
    async fn until_held_for(&self, message_id: &str, reason: AgentMessageReason) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let row = self.message_row(message_id).await;
            if row.status.as_str() == "held" && row.reason == Some(reason) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{message_id} reads {} ({:?})",
                row.status.as_str(),
                row.reason
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    /// The queue entries that ever carried `message_id` after its first one.
    async fn requeued_entries(&self, message_id: &str) -> Vec<String> {
        let prefix = format!("agent-message:{message_id}:%");
        self.repositories
            .database()
            .call(move |connection| {
                let mut statement = connection.prepare(
                    "SELECT command_id FROM provider_turn_outbox WHERE command_id LIKE ?1 ORDER BY rowid",
                )?;
                let rows = statement
                    .query_map([&prefix], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await
            .expect("entries")
    }

    async fn is_projected(&self, message_id: String) -> bool {
        self.repositories
            .database()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM projection_thread_messages WHERE message_id = ?1)",
                    [&message_id],
                    |row| row.get(0),
                )?)
            })
            .await
            .expect("projection")
    }

    /// Holds the message for `messaging_off` as the tracker would, with no tracker running.
    async fn hold_untracked(
        &self,
        message_id: &str,
    ) -> crate::agent_messaging::store::AgentMessageRow {
        let held_id = message_id.to_owned();
        self.repositories
            .database()
            .call(move |connection| {
                crate::agent_messaging::store::set_status(
                    connection,
                    &held_id,
                    crate::agent_messaging::store::AgentMessageStatus::Held,
                    Some(AgentMessageReason::MessagingOff),
                    CREATED_AT,
                )
            })
            .await
            .expect("held");
        self.message_row(message_id).await
    }
}

mod ordering {
    use super::*;

    #[tokio::test]
    async fn two_senders_one_recipient() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let from_a = harness.sent("a", "thread:b").await;
        let from_c = harness.sent("p", "thread:b").await;
        let (entry_a, entry_c) = (
            harness.entry_of(&from_a).await,
            harness.entry_of(&from_c).await,
        );

        harness.b_takes_its_next_turn("turn-b").await;
        harness.until_entry(&entry_a, "delivered").await;
        assert_eq!(harness.entry_state(&entry_c).await, "queued");
        harness.b_takes_its_next_turn("turn-b2").await;

        harness.until_entry(&entry_c, "delivered").await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_persons_queued_message_keeps_its_place() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let first = harness.person_queues("b").await;
        let agent = harness.sent("a", "thread:b").await;
        let agent = harness.entry_of(&agent).await;
        let last = harness.person_queues("b").await;

        harness.b_takes_its_next_turn("turn-b").await;
        harness.until_entry(&first, "delivered").await;
        assert_eq!(harness.entry_state(&agent).await, "queued");
        harness.b_takes_its_next_turn("turn-b2").await;
        harness.until_entry(&agent, "delivered").await;
        assert_eq!(harness.entry_state(&last).await, "queued");
        harness.b_takes_its_next_turn("turn-b3").await;

        harness.until_entry(&last, "delivered").await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn an_agent_message_never_overtakes_an_earlier_person_message() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let person = harness.person_queues("b").await;
        let agent = harness.sent("a", "thread:b").await;
        let agent = harness.entry_of(&agent).await;

        harness.b_takes_its_next_turn("turn-b").await;

        harness.until_entry(&person, "delivered").await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(harness.entry_state(&agent).await, "queued");
        harness.shutdown().await;
    }
}

mod messaging_off {
    use super::*;

    #[tokio::test]
    async fn turned_off_mid_conversation() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        let person = harness.person_queues("b").await;

        harness.messaging_enabled.send_replace(false);

        harness
            .until_held_for(&m1, AgentMessageReason::MessagingOff)
            .await;
        let row = harness.message_row(&m1).await;
        harness
            .until_entry(&row.delivery_command_id.expect("entry"), "dismissed")
            .await;
        assert!(
            !harness
                .is_projected(row.delivery_message_id.expect("entry"))
                .await
        );
        let off = harness.messaging(false);
        for (caller, tool, arguments) in [
            ("a", "agents_list", json!({})),
            (
                "a",
                "agent_message_send",
                send_arguments("thread:b", "again"),
            ),
            (
                "b",
                "agent_message_reply",
                json!({ "inReplyTo": m1, "text": "ok" }),
            ),
            ("a", "agent_message_status", json!({ "messageId": m1 })),
        ] {
            let result = run(scope(caller), tool, arguments, Some(&off)).await;
            assert_eq!(error_tag(&result), "AgentMessagingDisabledError", "{tool}");
        }
        harness.b_takes_its_next_turn("turn-b").await;
        harness.until_entry(&person, "delivered").await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn turned_on_again_rejoins_the_end_of_the_queue() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        let first_entry = harness.entry_of(&m1).await;
        harness.messaging_enabled.send_replace(false);
        harness
            .until_held_for(&m1, AgentMessageReason::MessagingOff)
            .await;
        harness.until_entry(&first_entry, "dismissed").await;
        let person = harness.person_queues("b").await;

        harness.messaging_enabled.send_replace(true);

        let row = harness.until_status(&m1, "queued").await;
        assert_eq!(row.message_id, m1);
        let requeued = format!("agent-message:{m1}:1");
        assert_eq!(row.delivery_command_id.as_deref(), Some(requeued.as_str()));
        assert_eq!(harness.entry_state(&first_entry).await, "dismissed");
        let (text, actor) = harness
            .projected_message(row.delivery_message_id.expect("entry"))
            .await;
        assert!(text.starts_with("<bibcode_agent_message>\n"), "{text}");
        assert_eq!(actor["kind"], "hosted-agent");
        assert_eq!(actor["address"], "thread:a");
        harness.b_takes_its_next_turn("turn-b").await;
        harness.until_entry(&person, "delivered").await;
        assert_eq!(harness.entry_state(&requeued).await, "queued");
        harness.b_takes_its_next_turn("turn-b2").await;
        harness.until_entry(&requeued, "delivered").await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn turning_it_on_rechecks_the_ceiling() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.set_mode("a", "auto-accept-edits").await;
        harness.set_mode("b", "auto-accept-edits").await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        harness.messaging_enabled.send_replace(false);
        harness
            .until_held_for(&m1, AgentMessageReason::MessagingOff)
            .await;
        harness.set_mode("b", "full-access").await;

        harness.messaging_enabled.send_replace(true);

        harness
            .until_held_for(&m1, AgentMessageReason::RecipientModeAboveSender)
            .await;
        assert!(harness.requeued_entries(&m1).await.is_empty());
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_deleted_recipient_fails_when_it_returns() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        harness.messaging_enabled.send_replace(false);
        harness
            .until_held_for(&m1, AgentMessageReason::MessagingOff)
            .await;
        harness
            .engine
            .dispatch(command(
                json!({"type": "thread.delete", "commandId": "delete-b", "threadId": "b"}),
            ))
            .await
            .expect("deleted");

        harness.messaging_enabled.send_replace(true);

        let row = harness.until_status(&m1, "failed").await;
        assert_eq!(row.reason, Some(AgentMessageReason::RecipientGone));
        assert!(harness.requeued_entries(&m1).await.is_empty());
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_delivered_message_is_untouched_by_turning_messaging_off() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:p").await;
        harness.until_status(&m1, "delivered").await;

        harness.messaging_enabled.send_replace(false);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let row = harness.message_row(&m1).await;
        assert_eq!(row.status.as_str(), "delivered");
        assert_eq!(
            harness
                .entry_state(&row.delivery_command_id.expect("entry"))
                .await,
            "delivered"
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_message_held_for_the_mode_ceiling_is_requeued_when_the_mode_falls() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.set_mode("a", "auto-accept-edits").await;
        harness.set_mode("b", "auto-accept-edits").await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        let first_entry = harness.entry_of(&m1).await;
        harness.set_mode("b", "full-access").await;
        harness
            .until_held_for(&m1, AgentMessageReason::RecipientModeAboveSender)
            .await;
        harness.until_entry(&first_entry, "dismissed").await;

        harness.set_mode("b", "auto-accept-edits").await;

        harness.until_status(&m1, "queued").await;
        assert_eq!(harness.requeued_entries(&m1).await.len(), 1);
        harness.b_takes_its_next_turn("turn-b").await;
        harness.until_status(&m1, "delivered").await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn two_releases_of_one_held_message_make_one_queue_entry() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let messaging = harness.messaging_untracked(true);
        let m1 = harness.sent_untracked("a", "thread:b").await;
        let held = harness.hold_untracked(&m1).await;

        let (first, second) = tokio::join!(messaging.requeue(&held), messaging.requeue(&held));

        assert_eq!(
            [first.expect("first"), second.expect("second")]
                .iter()
                .filter(|released| **released)
                .count(),
            1
        );
        let entries = harness.requeued_entries(&m1).await;
        assert_eq!(entries.len(), 1, "{entries:?}");
        let row = harness.message_row(&m1).await;
        assert_eq!(
            row.delivery_command_id.as_deref(),
            Some(entries[0].as_str())
        );
        assert_eq!(row.status.as_str(), "queued");
        assert_eq!(
            harness
                .entry_state(&held.delivery_command_id.expect("entry"))
                .await,
            "dismissed"
        );
        harness.shutdown().await;
    }

    /// Review P3: messages held for different reasons rejoin the queue in acceptance order.
    #[tokio::test]
    async fn held_messages_are_released_in_acceptance_order_across_reasons() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.set_mode("a", "auto-accept-edits").await;
        harness.set_mode("b", "auto-accept-edits").await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        harness.set_mode("b", "full-access").await;
        harness
            .until_held_for(&m1, AgentMessageReason::RecipientModeAboveSender)
            .await;
        let m2 = harness.sent("p", "thread:b").await;
        harness.until_status(&m2, "queued").await;
        harness.messaging_enabled.send_replace(false);
        harness
            .until_held_for(&m2, AgentMessageReason::MessagingOff)
            .await;
        harness.set_mode("b", "auto-accept-edits").await;

        harness.messaging_enabled.send_replace(true);

        harness.until_status(&m1, "queued").await;
        harness.until_status(&m2, "queued").await;
        let (first, second) = (harness.entry_of(&m1).await, harness.entry_of(&m2).await);
        harness.b_takes_its_next_turn("turn-b").await;
        harness.until_entry(&first, "delivered").await;
        assert_eq!(harness.entry_state(&second).await, "queued");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_stale_release_after_a_restart_does_nothing() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let messaging = harness.messaging_untracked(true);
        let m1 = harness.sent_untracked("a", "thread:b").await;
        let held = harness.hold_untracked(&m1).await;
        assert!(messaging.requeue(&held).await.expect("released"));
        let released = harness.message_row(&m1).await;

        assert!(!messaging.requeue(&held).await.expect("stale"));
        // A restart's tracker runs its startup reconciliation with messaging on.
        harness.messaging(true);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        assert_eq!(harness.requeued_entries(&m1).await.len(), 1);
        let row = harness.message_row(&m1).await;
        assert_eq!(row.delivery_command_id, released.delivery_command_id);
        assert_eq!(row.status.as_str(), "queued");
        harness.shutdown().await;
    }
}

// ---- Task 6.5: hop limit for chat senders ----

mod hop_limit {
    use super::*;

    const HOP_LIMIT: &str = "This exchange has reached the limit of 8 agent-to-agent hops. A person has to write in a thread before agents can continue.";

    impl Harness {
        /// `thread_id` runs turn `turn_id`, which an agent message of hop `hop` started, linked
        /// by the turn the message recorded, by the turn's marker, or by both.
        async fn turn_started_by(
            &self,
            thread_id: &'static str,
            turn_id: &'static str,
            hop: u32,
            recorded: bool,
            marker: bool,
        ) -> String {
            self.provider_turn(thread_id, turn_id, "working", false)
                .await;
            let message_id = format!("trigger-{turn_id}");
            let stored_id = message_id.clone();
            self.repositories
                .database()
                .call(move |connection| {
                    let delivery_message_id = format!("delivery-{turn_id}");
                    let tx = connection.transaction()?;
                    crate::agent_messaging::store::insert_message(
                        &tx,
                        &crate::agent_messaging::store::NewAgentMessage {
                            message_id: stored_id.clone(),
                            conversation_id: "c1".to_owned(),
                            sender_address: "thread:p".to_owned(),
                            sender_kind: crate::agent_messaging::store::SenderKind::Agent,
                            recipient_address: format!("thread:{thread_id}"),
                            in_reply_to: None,
                            hop,
                            text: "hello".to_owned(),
                            status: crate::agent_messaging::store::AgentMessageStatus::Consumed,
                            reason: None,
                            accepted_at: CREATED_AT.to_owned(),
                            sender_runtime_mode: Some("full-access".to_owned()),
                            recipient_terminal_generation: None,
                            send_request_id: None,
                            client_request_id: None,
                            delivery_command_id: None,
                            delivery_message_id: Some(delivery_message_id.clone()),
                        },
                    )?;
                    if recorded {
                        crate::agent_messaging::store::set_recipient_turn(
                            &tx, &stored_id, turn_id,
                        )?;
                    }
                    if marker {
                        tx.execute(
                            "UPDATE projection_turns SET pending_message_id = ?3 WHERE thread_id = ?1 AND turn_id = ?2",
                            [thread_id, turn_id, delivery_message_id.as_str()],
                        )?;
                    }
                    tx.commit()?;
                    Ok(())
                })
                .await
                .expect("the trigger");
            message_id
        }

        async fn message_count(&self) -> i64 {
            self.repositories
                .database()
                .call(|connection| {
                    Ok(connection
                        .query_row("SELECT COUNT(*) FROM agent_messages", [], |row| row.get(0))?)
                })
                .await
                .expect("count")
        }

        async fn hop_of(&self, result: &Value) -> u64 {
            assert_ne!(result["isError"], true, "{result}");
            structured(result)["hop"].as_u64().expect("hop")
        }
    }

    fn assert_hop_limit(result: &Value) {
        assert_eq!(error_tag(result), "AgentMessagingHopLimitError", "{result}");
        assert_eq!(result["structuredContent"]["error"]["message"], HOP_LIMIT);
    }

    #[tokio::test]
    async fn ping_pong_stops() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.provider_turn("b", "turn-b", "done", true).await;
        let first = harness
            .agent_send("a", send_arguments("thread:b", "ping"))
            .await;
        assert_eq!(harness.hop_of(&first).await, 1);
        let mut last = structured(&first)["messageId"]
            .as_str()
            .expect("id")
            .to_owned();
        for hop in 2..=9_u64 {
            let (from, to) = if hop % 2 == 0 { ("b", "a") } else { ("a", "b") };
            let turn = format!("turn-{from}-{hop}");
            harness.until_status(&last, "delivered").await;
            harness.provider_turn(from, &turn, "working", false).await;
            harness.until_status(&last, "consumed").await;
            if hop == 9 {
                let stored = harness.agent_messages().await.len();
                let outbox = harness.outbox_states("b").await.len();

                assert_hop_limit(&harness.reply(from, &last, "pong").await);
                assert_hop_limit(
                    &harness
                        .agent_send(from, send_arguments(&format!("thread:{to}"), "ping"))
                        .await,
                );
                assert_eq!(harness.agent_messages().await.len(), stored);
                assert_eq!(harness.outbox_states("b").await.len(), outbox);
                break;
            }
            let reply = harness.reply(from, &last, "pong").await;
            assert_eq!(harness.hop_of(&reply).await, hop, "{from} to {to}");
            last = structured(&reply)["messageId"]
                .as_str()
                .expect("id")
                .to_owned();
            harness.provider_turn(from, &turn, "working", true).await;
        }
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_person_resets_the_chain() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.turn_started_by("a", "turn-a", 8, true, true).await;
        assert_hop_limit(
            &harness
                .agent_send("a", send_arguments("thread:b", "ping"))
                .await,
        );
        harness.provider_turn("a", "turn-a", "done", true).await;

        let person = harness.person_queues("a").await;
        harness.until_entry(&person, "delivered").await;
        harness
            .provider_turn("a", "turn-person", "working", false)
            .await;

        let result = harness
            .agent_send("a", send_arguments("thread:b", "ping"))
            .await;
        assert_eq!(harness.hop_of(&result).await, 1);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_slow_exchange_does_not_reset_itself() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let trigger = harness.turn_started_by("a", "turn-a", 8, true, true).await;
        harness
            .repositories
            .database()
            .call(move |connection| {
                connection.execute(
                    "UPDATE agent_messages SET accepted_at = '2026-11-13T23:00:00.000Z', updated_at = '2026-11-13T23:00:00.000Z' WHERE message_id = ?1",
                    [&trigger],
                )?;
                Ok(())
            })
            .await
            .expect("an hour ago");

        assert_hop_limit(
            &harness
                .agent_send("a", send_arguments("thread:b", "ping"))
                .await,
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_first_message_in_a_turn_a_person_started_is_hop_one() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let person = harness.person_queues("a").await;
        harness.until_entry(&person, "delivered").await;
        harness
            .provider_turn("a", "turn-person", "working", false)
            .await;

        let result = harness
            .agent_send("a", send_arguments("thread:b", "ping"))
            .await;

        assert_eq!(harness.hop_of(&result).await, 1);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_reply_counts_one_more_than_the_message_it_answers() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.provider_turn("b", "turn-b", "done", true).await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "delivered").await;
        harness
            .provider_turn("b", "turn-b2", "working", false)
            .await;
        harness.until_status(&m1, "consumed").await;

        let reply = harness.reply("b", &m1, "pong").await;

        assert_eq!(harness.hop_of(&reply).await, 2);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn hop_8_is_accepted_and_hop_9_is_refused() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.turn_started_by("a", "turn-a7", 7, true, true).await;
        let eighth = harness
            .agent_send("a", send_arguments("thread:b", "ping"))
            .await;
        assert_eq!(harness.hop_of(&eighth).await, 8);

        harness.turn_started_by("a", "turn-a8", 8, true, true).await;
        let stored = harness.message_count().await;

        assert_hop_limit(
            &harness
                .agent_send("a", send_arguments("thread:b", "ping"))
                .await,
        );
        assert_eq!(harness.message_count().await, stored);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn the_hop_is_found_when_the_turn_marker_never_bound() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;

        harness.turn_started_by("a", "turn-a", 8, true, false).await;
        assert_hop_limit(
            &harness
                .agent_send("a", send_arguments("thread:b", "ping"))
                .await,
        );
        harness
            .turn_started_by("a", "turn-a2", 8, false, true)
            .await;
        assert_hop_limit(
            &harness
                .agent_send("a", send_arguments("thread:b", "ping"))
                .await,
        );
        harness.shutdown().await;
    }

    impl Harness {
        /// A real send from B to the idle A, delivered, whose stored hop is then 8.
        async fn hop_8_delivered_to_a(&self) -> String {
            self.provider_turn("a", "turn-a", "done", true).await;
            let message_id = self.sent("b", "thread:a").await;
            let stored = message_id.clone();
            self.repositories
                .database()
                .call(move |connection| {
                    connection.execute(
                        "UPDATE agent_messages SET hop = 8 WHERE message_id = ?1",
                        [&stored],
                    )?;
                    Ok(())
                })
                .await
                .expect("hop 8");
            self.until_status(&message_id, "delivered").await;
            message_id
        }
    }

    /// Review P2: the turn a hop-8 message started has ended and no person wrote since.
    #[tokio::test]
    async fn a_send_between_turns_continues_the_chain() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let trigger = harness.hop_8_delivered_to_a().await;
        harness.provider_turn("a", "turn-a2", "Port", true).await;
        harness.until_status(&trigger, "completed").await;

        assert_hop_limit(
            &harness
                .agent_send("a", send_arguments("thread:b", "ping"))
                .await,
        );
        assert_hop_limit(&harness.reply("a", &trigger, "pong").await);
        harness.shutdown().await;
    }

    /// Review P2: the turn marker of a message withdrawn while messaging was off, and requeued
    /// under a new thread message, is not a person's turn.
    #[tokio::test]
    async fn a_withdrawn_agent_message_does_not_reset_the_chain() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let trigger = harness.hop_8_delivered_to_a().await;
        harness.provider_turn("a", "turn-a2", "Port", true).await;
        harness.until_status(&trigger, "completed").await;
        harness.stop_delivery().await;
        let withdrawn = harness.sent("b", "thread:a").await;
        let first_entry = harness.entry_of(&withdrawn).await;
        assert_eq!(harness.entry_state(&first_entry).await, "pending");
        harness.messaging_enabled.send_replace(false);
        harness
            .until_held_for(&withdrawn, AgentMessageReason::MessagingOff)
            .await;
        harness.until_entry(&first_entry, "dismissed").await;
        harness.provider_asks("a", "approval", "r1").await;
        harness.messaging_enabled.send_replace(true);
        harness.until_status(&withdrawn, "queued").await;

        assert_hop_limit(
            &harness
                .agent_send("a", send_arguments("thread:b", "ping"))
                .await,
        );
        harness.shutdown().await;
    }

    /// Review P2: the hop-8 message was handed to A's provider, which has not reported the
    /// turn running yet.
    #[tokio::test]
    async fn a_send_before_the_turn_is_reported_running_continues_the_chain() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.hop_8_delivered_to_a().await;

        assert_hop_limit(
            &harness
                .agent_send("a", send_arguments("thread:b", "ping"))
                .await,
        );
        harness.shutdown().await;
    }

    /// Review W2: a hosted agent with full access runs `bibcode thread send` on its own thread,
    /// which sends through an outside client's credential. That turn is not a person's.
    #[tokio::test]
    async fn an_outside_clients_message_does_not_reset_the_chain() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.turn_started_by("a", "turn-a", 8, true, true).await;
        harness.provider_turn("a", "turn-a", "done", true).await;
        let (client, _) = harness.agent(McpAccess::FullAccess).await;

        let sent = harness
            .call(
                &client,
                "send_message",
                json!({ "threadId": "a", "text": "keep going" }),
            )
            .await;
        let message_id = structured(&sent)["messageId"]
            .as_str()
            .expect("message id")
            .to_owned();
        let (_, actor) = harness.projected_message(message_id.clone()).await;
        assert_eq!(actor["kind"], "mcp-client", "{actor}");
        let entry = harness
            .repositories
            .database()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT command_id FROM provider_turn_outbox WHERE thread_id = 'a' AND message_id = ?1",
                    [&message_id],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .await
            .expect("queue entry");
        harness.until_entry(&entry, "delivered").await;
        harness
            .provider_turn("a", "turn-cli", "working", false)
            .await;

        assert_hop_limit(
            &harness
                .agent_send("a", send_arguments("thread:b", "ping"))
                .await,
        );
        harness.shutdown().await;
    }
}

// ---- Review findings on tasks 6.1 to 6.5 (lane 6C) ----

mod claim_review {
    use super::*;

    impl Harness {
        /// Send now on `thread_id`'s queued entry `command_id`, as a person clicks it.
        pub(super) async fn send_now(&self, thread_id: &str, command_id: &str) {
            let message_id = self
                .repositories
                .get_provider_turn_delivery(command_id.to_owned())
                .await
                .expect("readable")
                .expect("entry")
                .message_id;
            self.engine
                .dispatch(command(json!({
                    "type": "thread.turn.promote",
                    "commandId": format!("send-now-{}", uuid::Uuid::new_v4()),
                    "threadId": thread_id, "messageId": message_id, "createdAt": CREATED_AT,
                })))
                .await
                .expect("Send now");
        }

        /// B's provider session stops with the queue paused for the test's own steps; then a
        /// person presses Send now on `command_id` and the claim takes it.
        async fn stopped_then_claimed(
            &self,
            command_id: &str,
        ) -> crate::orchestration::ProviderTurnDelivery {
            self.stop_delivery().await;
            self.session_ends("b", "stopped").await;
            self.send_now("b", command_id).await;
            self.engine
                .repositories()
                .claim_provider_turn(command_id.to_owned(), CREATED_AT.to_owned())
                .await
                .expect("claim")
                .expect("claimed")
        }
    }

    /// P1: a message requeued while B ran in full-access launches in B's lower mode of now.
    #[tokio::test]
    async fn a_requeued_message_launches_in_the_recipients_current_mode() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        harness.messaging_enabled.send_replace(false);
        harness
            .until_held_for(&m1, AgentMessageReason::MessagingOff)
            .await;
        harness.messaging_enabled.send_replace(true);
        harness.until_status(&m1, "queued").await;
        let entry = harness.entry_of(&m1).await;
        assert_ne!(entry, format!("agent-message:{m1}"), "requeued");

        harness.set_mode("b", "approval-required").await;
        let claimed = harness.stopped_then_claimed(&entry).await;

        assert_eq!(claimed.payload["runtimeMode"], "approval-required");
        harness.shutdown().await;
    }

    /// P1: a message queued in full-access and never held launches in B's lower mode of now.
    #[tokio::test]
    async fn a_queued_message_launches_in_the_recipients_current_mode() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        let entry = harness.entry_of(&m1).await;

        harness.set_mode("b", "approval-required").await;
        let claimed = harness.stopped_then_claimed(&entry).await;

        assert_eq!(claimed.payload["runtimeMode"], "approval-required");
        harness.shutdown().await;
    }

    /// P1: a person's own queued message keeps the mode it was sent with, as before.
    #[tokio::test]
    async fn a_persons_queued_message_keeps_its_own_mode() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let person = harness.person_queues("b").await;
        assert_eq!(harness.entry_state(&person).await, "queued");

        harness.set_mode("b", "approval-required").await;
        let claimed = harness.stopped_then_claimed(&person).await;

        assert_eq!(claimed.payload["runtimeMode"], "full-access");
        harness.shutdown().await;
    }

    /// P5: an agent entry waiting for an open approval is not claimed again and again, a
    /// person's message behind it is delivered meanwhile, and the answer lets it through.
    #[tokio::test]
    async fn a_waiting_agent_entry_neither_spins_nor_blocks_a_person() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.provider_turn("b", "turn-b", "working", true).await;
        harness.provider_asks("b", "approval", "r1").await;
        let message_id = harness.sent_text("a", "thread:b", "approve it").await;
        harness.until_status(&message_id, "queued").await;
        let entry = harness.entry_of(&message_id).await;
        // Made pending as Send now, a retry or a recovery copy would.
        let pending = entry.clone();
        harness
            .repositories
            .database()
            .call(move |connection| {
                connection.execute(
                    "UPDATE provider_turn_outbox SET state = 'pending' WHERE command_id = ?1",
                    [&pending],
                )?;
                Ok(())
            })
            .await
            .expect("pending");
        harness.delivery.wake();

        let before = harness
            .engine
            .repositories()
            .provider_turn_claims_for_test();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let claims = harness
            .engine
            .repositories()
            .provider_turn_claims_for_test()
            - before;
        assert!(
            claims <= 3,
            "{claims} claims in 500 ms while the ask is open"
        );
        assert_eq!(harness.entry_state(&entry).await, "pending");

        let person = harness.person_queues("b").await;
        harness.until_entry(&person, "delivered").await;
        assert_eq!(harness.entry_state(&entry).await, "pending");

        harness
            .provider_resolves(
                "b",
                "approval",
                json!({ "requestId": "r1", "decision": "accept" }),
            )
            .await;
        harness.until_entry(&entry, "delivered").await;
        harness.shutdown().await;
    }
}

// ---- Task 6.6: rate and backlog limits ----

mod limits {
    use super::*;

    const RATE_LIMIT: &str = "You have sent 30 agent messages in the last 60 seconds, which is the limit. Wait before sending more.";
    const BACKLOG_LIMIT: &str = "The recipient already has 20 agent messages it has not read, which is the limit. Try again after it has read some.";

    fn is_rate_limit(result: &Value) -> bool {
        result["isError"] == true
            && result["structuredContent"]["error"]["_tag"] == "AgentMessagingRateLimitError"
            && result["structuredContent"]["error"]["message"] == RATE_LIMIT
    }

    fn is_backlog_limit(result: &Value) -> bool {
        result["isError"] == true
            && result["structuredContent"]["error"]["_tag"] == "AgentMessagingBacklogLimitError"
            && result["structuredContent"]["error"]["message"] == BACKLOG_LIMIT
    }

    fn accepted(result: &Value) -> bool {
        result["isError"] != true && result["structuredContent"]["status"].is_string()
    }

    impl Harness {
        /// `count` more agents `s0`, `s1`, ... in project `p1`, in full-access.
        async fn more_agents(&self, count: usize) -> Vec<String> {
            let mut threads = Vec::new();
            for index in 0..count {
                let thread_id = format!("s{index}");
                self.engine
                    .dispatch(command(json!({
                        "type": "thread.create", "commandId": format!("create-{thread_id}"),
                        "threadId": thread_id, "projectId": "p1", "title": format!("Agent {index}"),
                        "modelSelection": { "instanceId": "codex", "model": "model" },
                        "runtimeMode": "full-access", "createdAt": CREATED_AT,
                    })))
                    .await
                    .expect("thread created");
                threads.push(thread_id);
            }
            threads
        }

        async fn send_to(&self, caller: &str, to: &str) -> Value {
            self.agent_send(caller, send_arguments(to, "hello")).await
        }

        /// `count` sends from `caller`, alternating between B and P so no backlog fills.
        async fn sends_from(&self, caller: &str, count: usize) {
            for index in 0..count {
                let to = if index % 2 == 0 {
                    "thread:b"
                } else {
                    "thread:p"
                };
                let result = self.send_to(caller, to).await;
                assert!(accepted(&result), "send {index}: {result}");
            }
        }

        /// Rewrites the acceptance time of every message `sender` sent to `seconds` ago.
        async fn sent_ago(&self, sender: &str, seconds: i64) {
            let at = (time::OffsetDateTime::now_utc() - time::Duration::seconds(seconds))
                .format(&time::format_description::well_known::Rfc3339)
                .expect("time");
            let sender = format!("thread:{sender}");
            self.repositories
                .database()
                .call(move |connection| {
                    connection.execute(
                        "UPDATE agent_messages SET accepted_at = ?1 WHERE sender_address = ?2",
                        [&at, &sender],
                    )?;
                    Ok(())
                })
                .await
                .expect("rewritten");
        }

        async fn rows_from(&self, sender: &str) -> i64 {
            let sender = format!("thread:{sender}");
            self.repositories
                .database()
                .call(move |connection| {
                    Ok(connection.query_row(
                        "SELECT COUNT(*) FROM agent_messages WHERE sender_address = ?1",
                        [&sender],
                        |row| row.get(0),
                    )?)
                })
                .await
                .expect("count")
        }

        async fn all_outbox_rows(&self) -> i64 {
            self.repositories
                .database()
                .call(|connection| {
                    Ok(connection.query_row(
                        "SELECT COUNT(*) FROM provider_turn_outbox WHERE command_id LIKE 'agent-message:%'",
                        [],
                        |row| row.get(0),
                    )?)
                })
                .await
                .expect("count")
        }

        /// `count` rows of sender kind person from `sender` to `recipient`, inserted directly.
        async fn person_rows(&self, sender: &str, recipient: &str, count: usize) {
            let (sender, recipient) = (sender.to_owned(), recipient.to_owned());
            self.repositories
                .database()
                .call(move |connection| {
                    let tx = connection.transaction()?;
                    for index in 0..count {
                        crate::agent_messaging::store::insert_message(
                            &tx,
                            &crate::agent_messaging::store::NewAgentMessage {
                                message_id: format!("person-{index}"),
                                conversation_id: "c1".to_owned(),
                                sender_address: sender.clone(),
                                sender_kind: crate::agent_messaging::store::SenderKind::Person,
                                recipient_address: recipient.clone(),
                                in_reply_to: None,
                                hop: 1,
                                text: "From a person".to_owned(),
                                status: crate::agent_messaging::store::AgentMessageStatus::Queued,
                                reason: None,
                                accepted_at: crate::mcp::control::now_iso(),
                                sender_runtime_mode: None,
                                recipient_terminal_generation: None,
                                send_request_id: None,
                                client_request_id: None,
                                delivery_command_id: None,
                                delivery_message_id: None,
                            },
                        )?;
                    }
                    tx.commit()?;
                    Ok(())
                })
                .await
                .expect("person rows");
        }
    }

    #[tokio::test]
    async fn flooding_one_recipient() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        for sender in harness.more_agents(20).await {
            assert!(accepted(&harness.send_to(&sender, "thread:b").await));
        }
        assert_eq!(harness.outbox_states("b").await.len(), 20);

        let result = harness.send_to("a", "thread:b").await;

        assert!(is_backlog_limit(&result), "{result}");
        assert_eq!(harness.outbox_states("b").await.len(), 20);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn thirty_in_sixty_seconds() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.sends_from("a", 30).await;

        let refused = harness.send_to("a", "thread:p").await;
        assert!(is_rate_limit(&refused), "{refused}");

        harness.sent_ago("a", 61).await;
        let after = harness.send_to("a", "thread:p").await;
        assert!(accepted(&after), "{after}");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_refused_send_does_not_count() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.sends_from("a", 30).await;
        let outbox = harness.all_outbox_rows().await;

        for _ in 0..30 {
            assert!(is_rate_limit(&harness.send_to("a", "thread:b").await));
        }

        assert_eq!(harness.rows_from("a").await, 30);
        assert_eq!(harness.all_outbox_rows().await, outbox);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn another_senders_rate_is_separate() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.sends_from("a", 30).await;
        assert!(is_rate_limit(&harness.send_to("a", "thread:b").await));

        let other = harness.send_to("p", "thread:a").await;

        assert!(accepted(&other), "{other}");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn consumed_messages_free_the_backlog() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let senders = harness.more_agents(20).await;
        let mut sent = Vec::new();
        for sender in &senders {
            let result = harness.send_to(sender, "thread:b").await;
            sent.push(
                structured(&result)["messageId"]
                    .as_str()
                    .expect("id")
                    .to_owned(),
            );
        }
        assert!(is_backlog_limit(&harness.send_to("a", "thread:b").await));
        let consumed = sent[..5].to_vec();
        harness
            .repositories
            .database()
            .call(move |connection| {
                for message_id in &consumed {
                    connection.execute(
                        "UPDATE agent_messages SET status = 'consumed' WHERE message_id = ?1",
                        [message_id],
                    )?;
                }
                Ok(())
            })
            .await
            .expect("consumed");

        let result = harness.send_to("a", "thread:b").await;

        assert!(accepted(&result), "{result}");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn the_error_names_the_limit_that_applied() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        for _ in 0..20 {
            assert!(accepted(&harness.send_to("a", "thread:b").await));
        }
        for _ in 0..10 {
            assert!(accepted(&harness.send_to("a", "thread:p").await));
        }

        let result = harness.send_to("a", "thread:b").await;

        assert!(is_rate_limit(&result), "{result}");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn simultaneous_sends_from_one_sender_admit_exactly_thirty() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let sends = (0..32).map(|index| {
            let to = if index % 2 == 0 {
                "thread:b"
            } else {
                "thread:p"
            };
            harness.send_to("a", to)
        });

        let results = futures_util::future::join_all(sends).await;

        assert_eq!(results.iter().filter(|result| accepted(result)).count(), 30);
        assert_eq!(
            results
                .iter()
                .filter(|result| is_rate_limit(result))
                .count(),
            2
        );
        assert_eq!(harness.rows_from("a").await, 30);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn simultaneous_sends_from_many_senders_admit_exactly_twenty() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let senders = harness.more_agents(25).await;
        let sends = senders
            .iter()
            .map(|sender| harness.send_to(sender, "thread:b"));

        let results = futures_util::future::join_all(sends).await;

        assert_eq!(results.iter().filter(|result| accepted(result)).count(), 20);
        assert_eq!(
            results
                .iter()
                .filter(|result| is_backlog_limit(result))
                .count(),
            5
        );
        assert_eq!(harness.outbox_states("b").await.len(), 20);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_persons_requests_do_not_use_the_agent_backlog() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.person_rows("thread:p", "thread:b", 20).await;

        let result = harness.send_to("a", "thread:b").await;

        assert!(accepted(&result), "{result}");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_persons_sends_do_not_use_the_agent_rate() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.person_rows("thread:a", "thread:p", 30).await;

        let result = harness.send_to("a", "thread:b").await;

        assert!(accepted(&result), "{result}");
        harness.shutdown().await;
    }

    /// Two calls with one `clientRequestId` race for the last slot: both get the receipt of
    /// the one that took it.
    async fn a_retry_takes_the_last_slot(harness: &Harness, to: &str) {
        let arguments = json!({ "to": to, "text": "hello", "clientRequestId": "k" });
        let (first, second) = tokio::join!(
            harness.agent_send("a", arguments.clone()),
            harness.agent_send("a", arguments.clone())
        );
        assert!(accepted(&first), "{first}");
        assert!(accepted(&second), "{second}");
        assert_eq!(
            structured(&first)["messageId"],
            structured(&second)["messageId"]
        );
    }

    /// Review W3.
    #[tokio::test]
    async fn concurrent_retries_at_the_rate_limit_share_one_receipt() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.sends_from("a", 29).await;

        a_retry_takes_the_last_slot(&harness, "thread:p").await;

        assert_eq!(harness.rows_from("a").await, 30);
        harness.shutdown().await;
    }

    /// Review W3.
    #[tokio::test]
    async fn concurrent_retries_at_the_backlog_limit_share_one_receipt() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        for sender in harness.more_agents(19).await {
            assert!(accepted(&harness.send_to(&sender, "thread:b").await));
        }

        a_retry_takes_the_last_slot(&harness, "thread:b").await;

        assert_eq!(harness.outbox_states("b").await.len(), 20);
        harness.shutdown().await;
    }
}

// ---- Task 6.7: held, failed, restart and cancel ----

mod recovery {
    use super::*;

    const NOT_CANCELLABLE: &str = "That message was already delivered, so it cannot be cancelled.";

    impl Harness {
        async fn cancel(&self, caller: &str, message_id: &str) -> Value {
            self.agent_tool(
                caller,
                "agent_message_cancel",
                json!({ "messageId": message_id }),
            )
            .await
        }

        /// The queue entries of `message_id` that are still live: not delivered or dismissed.
        async fn live_entries(&self, message_id: &str) -> Vec<(String, String)> {
            let prefix = format!("agent-message:{message_id}%");
            self.repositories
                .database()
                .call(move |connection| {
                    let mut statement = connection.prepare(
                        "SELECT command_id, state FROM provider_turn_outbox
                          WHERE command_id LIKE ?1 AND state NOT IN ('dismissed', 'delivered')",
                    )?;
                    let rows = statement
                        .query_map([&prefix], |row| Ok((row.get(0)?, row.get(1)?)))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    Ok(rows)
                })
                .await
                .expect("entries")
        }

        async fn entry_held(&self, command_id: &str) -> bool {
            let command_id = command_id.to_owned();
            self.repositories
                .database()
                .call(move |connection| {
                    Ok(connection.query_row(
                        "SELECT held FROM provider_turn_outbox WHERE command_id = ?1",
                        [&command_id],
                        |row| row.get(0),
                    )?)
                })
                .await
                .expect("held flag")
        }
    }

    fn cancelled(result: &Value) -> bool {
        structured(result)["status"] == "cancelled"
    }

    #[tokio::test]
    async fn recipient_errored() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.session_ends("b", "error").await;

        let result = harness
            .agent_send("a", send_arguments("thread:b", "hello"))
            .await;

        assert_eq!(structured(&result)["status"], "held", "{result}");
        let m1 = structured(&result)["messageId"]
            .as_str()
            .expect("id")
            .to_owned();
        let status = harness.status_of("a", &m1).await;
        assert_eq!(structured(&status)["status"], "held");
        assert_eq!(structured(&status)["reason"], "recipient_queue_held");
        let entry = harness.entry_of(&m1).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(harness.entry_state(&entry).await, "queued", "not started");
        assert!(harness.entry_held(&entry).await);

        harness.send_now("b", &entry).await;

        harness.until_entry(&entry, "delivered").await;
        harness.until_status(&m1, "delivered").await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_release_into_a_paused_queue_stays_held() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        harness.messaging_enabled.send_replace(false);
        harness
            .until_held_for(&m1, AgentMessageReason::MessagingOff)
            .await;
        harness.session_ends("b", "error").await;

        harness.messaging_enabled.send_replace(true);

        harness
            .until_held_for(&m1, AgentMessageReason::RecipientQueueHeld)
            .await;
        let entry = harness.entry_of(&m1).await;
        assert_eq!(entry, format!("agent-message:{m1}:1"));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(harness.entry_state(&entry).await, "queued", "not started");
        assert!(harness.entry_held(&entry).await);
        harness.shutdown().await;
    }

    impl Harness {
        /// The held flag of `message_id`'s current entry as the outbox, the message
        /// projection, a thread snapshot and the entry's last published event each read it.
        async fn held_views(&self, message_id: &str) -> [Option<bool>; 4] {
            let row = self.message_row(message_id).await;
            let entry = row.delivery_command_id.expect("queue entry");
            let delivered = row.delivery_message_id.expect("thread message");
            let thread_id = row
                .recipient_address
                .trim_start_matches("thread:")
                .to_owned();
            let snapshot =
                crate::orchestration::load_thread_snapshot(&self.repositories, &thread_id)
                    .await
                    .expect("snapshot")
                    .messages
                    .into_iter()
                    .find(|message| message.message_id == delivered)
                    .expect("the message is in the snapshot")
                    .delivery_held;
            let lookup = delivered.clone();
            let (projected, published) = self
                .repositories
                .database()
                .call(move |connection| {
                    let projected: Option<bool> = connection.query_row(
                        "SELECT delivery_held FROM projection_thread_messages WHERE message_id = ?1",
                        [&lookup],
                        |row| row.get(0),
                    )?;
                    let published: String = connection.query_row(
                        "SELECT payload_json FROM orchestration_events
                          WHERE event_type = 'thread.turn-delivery-updated'
                            AND json_extract(payload_json, '$.messageId') = ?1
                          ORDER BY sequence DESC LIMIT 1",
                        [&lookup],
                        |row| row.get(0),
                    )?;
                    Ok((projected, published))
                })
                .await
                .expect("views");
            let published: Value = serde_json::from_str(&published).expect("payload");
            [
                Some(self.entry_held(&entry).await),
                projected,
                snapshot,
                published["delivery"]["held"].as_bool(),
            ]
        }
    }

    /// Review W4: the first admission into a paused queue.
    #[tokio::test]
    async fn a_message_admitted_into_a_paused_queue_reads_held_everywhere() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.session_ends("b", "error").await;

        let m1 = harness.sent("a", "thread:b").await;

        assert_eq!(harness.message_row(&m1).await.status.as_str(), "held");
        assert_eq!(harness.held_views(&m1).await, [Some(true); 4]);
        harness.shutdown().await;
    }

    /// Review W4: a release into a paused queue.
    #[tokio::test]
    async fn a_release_into_a_paused_queue_reads_held_everywhere() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        harness.messaging_enabled.send_replace(false);
        harness
            .until_held_for(&m1, AgentMessageReason::MessagingOff)
            .await;
        harness.session_ends("b", "error").await;

        harness.messaging_enabled.send_replace(true);

        harness
            .until_held_for(&m1, AgentMessageReason::RecipientQueueHeld)
            .await;
        assert_eq!(harness.held_views(&m1).await, [Some(true); 4]);
        harness.shutdown().await;
    }

    /// Review W1: B's queue was paused by `status` and B is `ready` again, but nobody released
    /// m1. A new message waits behind it, held, and m1 stays where it is.
    async fn a_message_waits_in_a_queue_paused_by(status: &str) {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        harness.session_ends("b", status).await;
        harness
            .until_held_for(&m1, AgentMessageReason::RecipientQueueHeld)
            .await;
        let first = harness.entry_of(&m1).await;
        assert!(harness.entry_held(&first).await);
        harness.session_ends("b", "ready").await;

        let m2 = harness.sent("a", "thread:b").await;

        let status = harness.status_of("a", &m2).await;
        assert_eq!(structured(&status)["status"], "held", "{status}");
        assert_eq!(structured(&status)["reason"], "recipient_queue_held");
        let second = harness.entry_of(&m2).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(harness.entry_state(&second).await, "queued", "not started");
        assert!(harness.entry_held(&second).await);
        assert_eq!(harness.entry_state(&first).await, "queued");
        assert_eq!(harness.message_row(&m1).await.status.as_str(), "held");
        assert_eq!(harness.held_views(&m2).await, [Some(true); 4]);
        harness.shutdown().await;
    }

    impl Harness {
        /// Admits an agent message from A to B straight through the turn starter, with the hold
        /// a sender decided from an earlier read of B's queue.
        async fn admit_decided(&self, message_id: &str, held: bool) -> Result<Value, Value> {
            use crate::agent_messaging::store::{
                AgentMessageCompanion, AgentMessageStatus, NewAgentMessage, SenderKind,
            };
            let command_id = format!("agent-message:{message_id}");
            let delivery_message_id = uuid::Uuid::new_v4().to_string();
            let (status, reason) = if held {
                (
                    AgentMessageStatus::Held,
                    Some(AgentMessageReason::RecipientQueueHeld),
                )
            } else {
                (AgentMessageStatus::Accepted, None)
            };
            super::super::super::orchestration_rpc::server_turn_starter(
                self.engine.clone(),
                self.provider.clone(),
                self.state_dir.clone(),
                self.delivery.clone(),
                None,
                self.uploads.clone(),
            )
            .queue_turn_start(
                command(json!({
                    "type": "thread.turn.start", "commandId": command_id, "threadId": "b",
                    "message": {
                        "messageId": delivery_message_id, "role": "user",
                        "text": "hello", "attachments": [],
                    },
                    "runtimeMode": "full-access", "interactionMode": "default",
                    "queued": true, "createdAt": CREATED_AT,
                })),
                super::super::super::orchestration_rpc::ServerActor::HostedAgent {
                    address: "thread:a".to_owned(),
                    label: "A".to_owned(),
                },
                Some(super::super::super::orchestration_rpc::AgentTurn {
                    companion: AgentMessageCompanion::Insert(
                        NewAgentMessage {
                            message_id: message_id.to_owned(),
                            conversation_id: "c1".to_owned(),
                            sender_address: "thread:a".to_owned(),
                            sender_kind: SenderKind::Agent,
                            recipient_address: "thread:b".to_owned(),
                            in_reply_to: None,
                            hop: 1,
                            text: "hello".to_owned(),
                            status,
                            reason,
                            accepted_at: CREATED_AT.to_owned(),
                            sender_runtime_mode: Some("full-access".to_owned()),
                            recipient_terminal_generation: None,
                            send_request_id: None,
                            client_request_id: None,
                            delivery_command_id: Some(command_id),
                            delivery_message_id: Some(delivery_message_id),
                        },
                        None,
                    ),
                    force_queue: held,
                }),
            )
            .await
        }
    }

    fn pause_changed(result: &Result<Value, Value>) -> bool {
        result.as_ref().is_err_and(|error| {
            error["message"]
                .as_str()
                .is_some_and(|detail| detail.ends_with("agent-message-queue-pause-changed"))
        })
    }

    /// Review W1: the queue paused after the sender read it. The admitting transaction refuses
    /// the stale decision, and nothing of it is stored.
    #[tokio::test]
    async fn a_start_decided_before_the_queue_paused_is_refused() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        harness.session_ends("b", "interrupted").await;
        harness
            .until_held_for(&m1, AgentMessageReason::RecipientQueueHeld)
            .await;
        harness.session_ends("b", "ready").await;
        let rows = harness.agent_messages().await.len();
        let entries = harness.outbox_states("b").await.len();

        let result = harness.admit_decided("stale-start", false).await;

        assert!(pause_changed(&result), "{result:?}");
        assert_eq!(harness.agent_messages().await.len(), rows);
        assert_eq!(harness.outbox_states("b").await.len(), entries);

        // The sender's one retry, under the same command id, is admitted held.
        let retried = harness.admit_decided("stale-start", true).await;

        assert!(retried.is_ok(), "{retried:?}");
        assert_eq!(harness.agent_messages().await.len(), rows + 1);
        assert_eq!(harness.held_views("stale-start").await, [Some(true); 4]);
        harness.shutdown().await;
    }

    /// Review W1: a person released the queue after the sender read it paused.
    #[tokio::test]
    async fn a_hold_decided_before_the_queue_was_released_is_refused() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;

        let result = harness.admit_decided("stale-hold", true).await;

        assert!(pause_changed(&result), "{result:?}");
        assert!(harness.agent_messages().await.is_empty());
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_queue_paused_by_an_interrupt_holds_a_new_message_after_ready() {
        a_message_waits_in_a_queue_paused_by("interrupted").await;
    }

    #[tokio::test]
    async fn a_queue_paused_by_an_error_holds_a_new_message_after_ready() {
        a_message_waits_in_a_queue_paused_by("error").await;
    }

    #[tokio::test]
    async fn restart_with_a_queued_message() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;

        crate::production::provider_runtime::reconcile_abandoned_provider_sessions(&harness.engine)
            .await
            .expect("abandoned sessions settled");
        crate::agent_messaging::delivery::reconcile_all(&harness.engine, None)
            .await
            .expect("reconciled");

        let status = harness.status_of("a", &m1).await;
        assert_eq!(structured(&status)["status"], "held", "{status}");
        assert_eq!(structured(&status)["reason"], "recipient_queue_held");
        assert_eq!(
            harness.entry_state(&harness.entry_of(&m1).await).await,
            "queued"
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn restart_with_an_idle_recipient() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        harness.provider_turn("b", "turn-b", "done", true).await;
        harness.stop_delivery().await;
        let m1 = harness.sent("a", "thread:b").await;
        let entry = harness.entry_of(&m1).await;
        assert_eq!(harness.entry_state(&entry).await, "pending");

        crate::production::provider_runtime::reconcile_abandoned_provider_sessions(&harness.engine)
            .await
            .expect("abandoned sessions settled");
        crate::agent_messaging::delivery::reconcile_all(&harness.engine, None)
            .await
            .expect("reconciled");

        assert_eq!(
            harness.entry_state(&entry).await,
            "pending",
            "keeps its place"
        );
        let router: crate::production::turn_delivery::DeliveryRouter =
            std::sync::Arc::new(|_| Box::pin(async { Ok(()) }));
        let restarted = crate::production::turn_delivery::TurnDeliveryService::start_with_router(
            harness.engine.clone(),
            1,
            router,
        );
        harness.until_status(&m1, "delivered").await;
        restarted.shutdown().await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_recipient_deleted_before_delivery_fails() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;

        harness
            .engine
            .dispatch(command(
                json!({"type": "thread.delete", "commandId": "delete-b", "threadId": "b"}),
            ))
            .await
            .expect("deleted");

        harness.until_status(&m1, "failed").await;
        let status = harness.status_of("a", &m1).await;
        assert_eq!(structured(&status)["reason"], "recipient_gone");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_held_message_has_no_live_queue_entry_after_a_restart_between_hold_and_withdrawal() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent_untracked("a", "thread:b").await;
        let person = harness.person_queues("b").await;
        // The failure was written, then the server stopped before the entry was withdrawn.
        let failed_id = m1.clone();
        harness
            .repositories
            .database()
            .call(move |connection| {
                crate::agent_messaging::store::set_status(
                    connection,
                    &failed_id,
                    crate::agent_messaging::store::AgentMessageStatus::Failed,
                    Some(AgentMessageReason::DeliveryFailed),
                    CREATED_AT,
                )
            })
            .await
            .expect("failed");

        crate::agent_messaging::delivery::reconcile_all(&harness.engine, None)
            .await
            .expect("startup reconciliation");

        assert!(harness.live_entries(&m1).await.is_empty());
        harness.provider_turn("b", "turn-b", "working", true).await;
        harness.until_entry(&person, "delivered").await;
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_release_racing_a_cancel_leaves_no_live_entry() {
        // The cancel wins: the release is stale and adds nothing.
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let messaging = harness.messaging_untracked(true);
        let m1 = harness.sent_untracked("a", "thread:b").await;
        let held = harness.hold_untracked(&m1).await;
        assert_eq!(
            messaging.cancel("a", &m1).await,
            Ok(crate::agent_messaging::store::AgentMessageStatus::Cancelled)
        );
        assert!(!messaging.requeue(&held).await.expect("stale"));
        assert!(harness.requeued_entries(&m1).await.is_empty());
        assert_eq!(harness.message_row(&m1).await.status.as_str(), "cancelled");
        assert!(harness.live_entries(&m1).await.is_empty());
        harness.shutdown().await;

        // The cancel loses: it withdraws the entry the release made.
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let messaging = harness.messaging_untracked(true);
        let m1 = harness.sent_untracked("a", "thread:b").await;
        let held = harness.hold_untracked(&m1).await;
        assert!(messaging.requeue(&held).await.expect("released"));
        assert_eq!(
            messaging.cancel("a", &m1).await,
            Ok(crate::agent_messaging::store::AgentMessageStatus::Cancelled)
        );
        assert_eq!(harness.requeued_entries(&m1).await.len(), 1);
        assert!(harness.live_entries(&m1).await.is_empty());
        harness.shutdown().await;

        // Both at once.
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let messaging = harness.messaging_untracked(true);
        let m1 = harness.sent_untracked("a", "thread:b").await;
        let held = harness.hold_untracked(&m1).await;
        let (_, cancel) = tokio::join!(messaging.requeue(&held), messaging.cancel("a", &m1));
        assert_eq!(
            cancel,
            Ok(crate::agent_messaging::store::AgentMessageStatus::Cancelled)
        );
        assert!(harness.live_entries(&m1).await.is_empty());
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn too_late_to_cancel() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:p").await;
        harness.until_status(&m1, "delivered").await;
        harness.provider_turn("p", "turn-p", "Port", false).await;
        harness.until_status(&m1, "consumed").await;

        let result = harness.cancel("a", &m1).await;

        assert_eq!(error_tag(&result), "AgentMessagingNotCancellableError");
        assert_eq!(
            result["structuredContent"]["error"]["message"],
            NOT_CANCELLABLE
        );
        assert_eq!(harness.message_row(&m1).await.status.as_str(), "consumed");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn cancel_a_queued_message() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        let entry = harness.entry_of(&m1).await;
        let person = harness.person_queues("b").await;

        let result = harness.cancel("a", &m1).await;

        assert!(cancelled(&result), "{result}");
        assert_eq!(harness.entry_state(&entry).await, "dismissed");
        harness.b_takes_its_next_turn("turn-b").await;
        harness.until_entry(&person, "delivered").await;
        assert_eq!(harness.entry_state(&entry).await, "dismissed");
        assert_eq!(harness.message_row(&m1).await.status.as_str(), "cancelled");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn cancel_a_held_message() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.until_status(&m1, "queued").await;
        harness.messaging_enabled.send_replace(false);
        harness
            .until_held_for(&m1, AgentMessageReason::MessagingOff)
            .await;

        assert!(cancelled(&harness.cancel("a", &m1).await));
        harness.messaging_enabled.send_replace(true);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        assert_eq!(harness.message_row(&m1).await.status.as_str(), "cancelled");
        assert!(harness.requeued_entries(&m1).await.is_empty());
        assert!(harness.live_entries(&m1).await.is_empty());
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn only_the_sender_may_cancel() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;

        let not_mine = harness.cancel("p", &m1).await;
        let made_up = harness.cancel("p", "no-such-message").await;

        assert_eq!(error_tag(&not_mine), "AgentMessagingUnknownMessageError");
        assert_eq!(not_mine, made_up);
        assert_ne!(harness.message_row(&m1).await.status.as_str(), "cancelled");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn cancel_still_works_while_messaging_is_off() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;
        harness.messaging_enabled.send_replace(false);

        let result = run(
            scope("a"),
            "agent_message_cancel",
            json!({ "messageId": m1 }),
            Some(&harness.messaging(false)),
        )
        .await;

        assert!(cancelled(&result), "{result}");
        assert_eq!(harness.message_row(&m1).await.status.as_str(), "cancelled");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn cancelling_twice_returns_cancelled() {
        let harness = Harness::new().await;
        harness.messaging_threads().await;
        let m1 = harness.sent("a", "thread:b").await;

        assert!(cancelled(&harness.cancel("a", &m1).await));
        let again = harness.cancel("a", &m1).await;

        assert!(cancelled(&again), "{again}");
        harness.shutdown().await;
    }
}
