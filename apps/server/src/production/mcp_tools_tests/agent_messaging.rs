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
    /// state.
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
