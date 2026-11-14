//! The agent messaging tools a provider-hosted agent calls, on the harness's engine.

use serde_json::{Value, json};

use super::{CREATED_AT, Harness, command, command as command_value, error_tag, structured};
use crate::{
    mcp::{control::McpAccess, tools::agent_messaging::run},
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
    assert_eq!(stored[0].status, "accepted");
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
        .call(|connection| {
            Ok(crate::mcp::activity::attributed_running_turn_count(
                connection,
            )?)
        })
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
