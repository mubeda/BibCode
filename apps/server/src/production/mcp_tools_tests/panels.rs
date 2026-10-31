//! Slice X4: chat panels, panel messages and UI intents end to end. Panels are created by the
//! real `worktree.createPanel` on a real worktree's host thread; panel messages go through the
//! real orchestration RPC and engine, which decide who may name a source thread.

use rusqlite::params;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    Harness, basic_start, error_tag, start, structured,
    worktrees::{Fixture, PROJECT},
};
use crate::{
    mcp::control::{ClientPrincipal, McpAccess},
    production::{orchestration_rpc::shell_snapshot, ui_intents_rpc},
    rpc::RpcSessionContext,
};

/// Creates a worktree on `branch` and returns its host thread.
async fn host(harness: &Harness, agent: &ClientPrincipal, branch: &str) -> String {
    let created = harness
        .call(
            agent,
            "create_worktree",
            json!({ "projectId": PROJECT, "branch": "main", "newBranch": branch }),
        )
        .await;
    structured(&created)["threadId"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn panel(harness: &Harness, agent: &ClientPrincipal, host: &str) -> String {
    let created = harness
        .call(agent, "create_chat_panel", json!({ "hostThreadId": host }))
        .await;
    structured(&created)["threadId"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Each user message stored for `thread_id`: its text and source thread.
async fn user_messages(harness: &Harness, thread_id: &str) -> Vec<(String, Option<String>)> {
    let thread_id = thread_id.to_owned();
    harness
        .repositories
        .database()
        .call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT text, source_thread_id FROM projection_thread_messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at",
            )?;
            let rows = statement
                .query_map(params![thread_id], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn a_panel_created_over_mcp_is_shown_to_every_client_and_a_keyed_retry_returns_it() {
    let fixture = Fixture::new().await;
    let harness = &fixture.harness;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let host = host(harness, &agent, "feature-panel").await;
    let arguments = json!({
        "hostThreadId": host, "title": "Review", "purpose": "Review the diff", "clientRequestId": "panel-1",
    });
    let first = harness
        .call(&agent, "create_chat_panel", arguments.clone())
        .await;
    let panel_id = structured(&first)["threadId"].as_str().unwrap().to_owned();
    assert_eq!(structured(&first)["hostThreadId"], host.as_str());
    assert_eq!(structured(&first)["runtimeMode"], "full-access");
    let retry = harness.call(&agent, "create_chat_panel", arguments).await;
    assert_eq!(structured(&retry)["threadId"], panel_id.as_str());

    // Every client adopts a live panel from the shell it receives (`centerPanelAdoption.ts`):
    // kind `panel` with its host, and the agent that opened it.
    let shell = shell_snapshot(&harness.engine, false).await.unwrap();
    let shown: Vec<&Value> = shell["threads"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|thread| thread["id"] == panel_id.as_str())
        .collect();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0]["kind"], "panel");
    assert_eq!(shown[0]["hostThreadId"], host.as_str());
    assert_eq!(shown[0]["requester"]["purpose"], "Review the diff");
    assert_eq!(
        shown[0]["requester"]["actor"]["clientId"],
        agent.principal.session_id.as_str()
    );

    let listed = harness
        .call(&agent, "list_chat_panels", json!({ "hostThreadId": host }))
        .await;
    let panels = structured(&listed)["panels"].as_array().unwrap();
    assert_eq!(panels.len(), 1);
    assert_eq!(panels[0]["threadId"], panel_id.as_str());
    assert_eq!(panels[0]["title"], "Review");
    // A panel hosts nothing.
    let refused = harness
        .call(
            &agent,
            "list_chat_panels",
            json!({ "hostThreadId": panel_id }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpNotAHostThreadError");

    // Never above the connection's limit.
    let (supervised, _) = harness.agent(McpAccess::ApprovalRequired).await;
    let above = harness
        .call(
            &supervised,
            "create_chat_panel",
            json!({ "hostThreadId": host, "runtimeMode": "full-access" }),
        )
        .await;
    assert_eq!(error_tag(&above), "McpAccessCeilingError");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_panel_message_stays_in_its_worktree_and_records_where_it_came_from() {
    let fixture = Fixture::new().await;
    let harness = &fixture.harness;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let host_a = host(harness, &agent, "feature-a").await;
    let host_b = host(harness, &agent, "feature-b").await;
    let panel_a = panel(harness, &agent, &host_a).await;

    let across = harness
        .call(
            &agent,
            "send_panel_message",
            json!({ "fromThreadId": panel_a, "toThreadId": host_b, "text": "Look at this" }),
        )
        .await;
    assert_eq!(error_tag(&across), "McpNotSameWorktreeError");
    assert!(user_messages(harness, &host_b).await.is_empty());

    let sent = harness
        .call(
            &agent,
            "send_panel_message",
            json!({ "fromThreadId": panel_a, "toThreadId": host_a, "text": "Please review" }),
        )
        .await;
    assert_eq!(structured(&sent)["quotedReply"], false);
    assert_eq!(
        user_messages(harness, &host_a).await,
        [("Please review".to_owned(), Some(panel_a.clone()))]
    );
    // The host answers its panel, too.
    let back = harness
        .call(
            &agent,
            "send_panel_message",
            json!({ "fromThreadId": host_a, "toThreadId": panel_a, "text": "Done" }),
        )
        .await;
    structured(&back);
    let read = harness
        .call(&agent, "read_thread", json!({ "threadId": host_a }))
        .await;
    let message = &structured(&read)["messages"][0];
    assert_eq!(message["sourceThreadId"], panel_a.as_str());
    assert_eq!(
        message["actor"]["clientId"],
        agent.principal.session_id.as_str()
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn the_quoted_last_reply_is_capped_at_16000_characters() {
    let fixture = Fixture::new().await;
    let harness = &fixture.harness;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let host = host(harness, &agent, "feature-quote").await;
    let panel = panel(harness, &agent, &host).await;
    harness
        .provider_turn(&panel, "turn-quote", &"q".repeat(20_000), true)
        .await;
    let sent = harness
        .call(
            &agent,
            "send_panel_message",
            json!({ "fromThreadId": panel, "toThreadId": host, "text": "Summarize this", "includeLastReply": true }),
        )
        .await;
    assert_eq!(structured(&sent)["quotedReply"], true);
    let messages = user_messages(harness, &host).await;
    let (text, _) = &messages[0];
    assert!(
        text.starts_with("Summarize this\n\n> Last reply in “"),
        "{text}"
    );
    assert_eq!(
        text.matches('q').count(),
        crate::mcp::tools::panels::MOST_QUOTED_CHARS
    );
    assert!(text.ends_with("> … (cut at 16000 of 20000 characters)\n"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_panel_message_comes_only_from_a_thread_the_calling_agent_opened_or_last_drove() {
    let fixture = Fixture::new().await;
    let harness = &fixture.harness;
    let (agent_a, _) = harness.agent(McpAccess::FullAccess).await;
    let (agent_b, _) = harness.agent(McpAccess::FullAccess).await;
    let host = host(harness, &agent_a, "feature-owner").await;
    let panel_a = panel(harness, &agent_a, &host).await;

    // Agent B can see A's panel, but cannot speak as it.
    let forged = harness
        .call(
            &agent_b,
            "send_panel_message",
            json!({ "fromThreadId": panel_a, "toThreadId": host, "text": "Delete everything" }),
        )
        .await;
    assert_eq!(error_tag(&forged), "McpSourceThreadNotOwnedError");
    assert!(user_messages(harness, &host).await.is_empty());

    // Agent A's own panel works.
    let own = harness
        .call(
            &agent_a,
            "send_panel_message",
            json!({ "fromThreadId": panel_a, "toThreadId": host, "text": "Review this" }),
        )
        .await;
    structured(&own);

    // A thread B did not open counts as B's once B started its latest turn.
    let panel_b_drives = panel(harness, &agent_a, &host).await;
    let driven = harness
        .call(
            &agent_b,
            "send_message",
            json!({ "threadId": panel_b_drives, "text": "Check the tests" }),
        )
        .await;
    structured(&driven);
    let from_driven = harness
        .call(
            &agent_b,
            "send_panel_message",
            json!({ "fromThreadId": panel_b_drives, "toThreadId": host, "text": "Tests pass" }),
        )
        .await;
    structured(&from_driven);
    assert_eq!(
        user_messages(harness, &host).await,
        [
            ("Review this".to_owned(), Some(panel_a.clone())),
            ("Tests pass".to_owned(), Some(panel_b_drives.clone())),
        ]
    );
    fixture.shutdown().await;
}

/// A `thread.turn.start` to `thread_id` naming `source` as where it came from.
fn turn_from(thread_id: &str, source: &str, message_id: &str) -> Value {
    json!({
        "type": "thread.turn.start",
        "commandId": uuid::Uuid::new_v4().to_string(),
        "threadId": thread_id,
        "message": {
            "messageId": message_id, "role": "user", "text": "forged", "attachments": [],
            "sourceThreadId": source,
        },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "createdAt": "2026-10-31T00:00:00.000Z",
    })
}

#[tokio::test]
async fn a_source_thread_named_outside_a_panel_message_never_persists() {
    let fixture = Fixture::new().await;
    let harness = &fixture.harness;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let host_a = host(harness, &agent, "feature-forge-a").await;
    let host_b = host(harness, &agent, "feature-forge-b").await;
    let panel_a = panel(harness, &agent, &host_a).await;
    let dispatch = async |context: RpcSessionContext, command: Value| {
        harness
            .control
            .registry()
            .invoke_local(
                "orchestration.dispatchCommand",
                command,
                context,
                CancellationToken::new(),
            )
            .await
    };

    // A person's client cannot claim a message came from a panel, even one of the same worktree.
    let person = dispatch(
        RpcSessionContext::unauthenticated(),
        turn_from(&host_a, &panel_a, "forged-person"),
    )
    .await;
    assert!(person.is_err(), "{person:?}");
    // An agent's command cannot name a thread of another worktree of the same project.
    let agent_context =
        RpcSessionContext::authenticated(agent.principal.clone(), harness.auth.clone());
    let elsewhere = dispatch(
        agent_context.clone(),
        turn_from(&host_a, &host_b, "forged-elsewhere"),
    )
    .await;
    assert!(elsewhere.is_err(), "{elsewhere:?}");
    // Nor its own thread.
    let itself = dispatch(agent_context, turn_from(&host_a, &host_a, "forged-self")).await;
    assert!(itself.is_err(), "{itself:?}");
    assert!(user_messages(harness, &host_a).await.is_empty());
    // And send_message takes no source at all.
    let send = harness
        .call(
            &agent,
            "send_message",
            json!({ "threadId": host_a, "text": "hi", "sourceThreadId": panel_a }),
        )
        .await;
    assert_eq!(error_tag(&send), "McpInvalidArgumentError");
    fixture.shutdown().await;
}

#[tokio::test]
async fn focus_ui_raises_an_intent_for_subscribers_and_moves_nothing() {
    let intents = ui_intents_rpc::UiIntents::new();
    let registered = intents.clone();
    let harness = Harness::with_methods(move |registry| {
        ui_intents_rpc::register_ui_intents_rpc(registry, registered);
    })
    .await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    // The events this agent's commands planned: every command it dispatches carries its actor
    // (slice X1). The server's own background work for the started turn (turn delivery) has
    // no actor, so it never moves this count.
    let session_id = agent.principal.session_id.clone();
    let events = async || {
        let session_id = session_id.clone();
        harness
            .repositories
            .database()
            .call(move |connection| {
                Ok(connection.query_row(
                    "SELECT COUNT(*) FROM orchestration_events WHERE json_extract(metadata_json, '$.actor.clientId') = ?",
                    [session_id],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .await
            .unwrap()
    };
    let before = events().await;
    assert!(before > 0, "start_thread's events carry the agent's actor");
    let mut client = intents.subscribe();

    let focused = harness
        .call(
            &agent,
            "focus_ui",
            json!({ "threadId": thread_id, "surface": "files", "path": "./src/main.rs" }),
        )
        .await;
    let focused = structured(&focused);
    assert_eq!(focused["subscribers"], 1);
    assert_eq!(focused["path"], "src/main.rs");
    let intent = client.try_recv().expect("the client got the intent");
    assert_eq!(intent["kind"], "focus");
    assert_eq!(intent["intentId"], focused["intentId"]);
    assert_eq!(intent["threadId"], thread_id.as_str());
    assert_eq!(intent["surface"], "files");
    assert_eq!(
        intent["actor"]["clientId"],
        agent.principal.session_id.as_str()
    );
    // Advice only: the agent dispatched no command.
    assert_eq!(events().await, before);

    for (arguments, tag) in [
        (
            json!({ "threadId": thread_id, "surface": "files", "path": "../outside" }),
            "McpInvalidArgumentError",
        ),
        (
            json!({ "threadId": thread_id, "surface": "thread", "path": "README.md" }),
            "McpInvalidArgumentError",
        ),
        (
            json!({ "threadId": thread_id, "surface": "terminal" }),
            "McpInvalidArgumentError",
        ),
        (
            json!({ "threadId": "missing", "surface": "thread" }),
            "McpThreadNotFoundError",
        ),
    ] {
        let refused = harness.call(&agent, "focus_ui", arguments).await;
        assert_eq!(error_tag(&refused), tag);
    }
    // Sixteen may wait per thread; the seventeenth is refused.
    for _ in 1..ui_intents_rpc::MOST_PENDING_PER_THREAD {
        let accepted = harness
            .call(
                &agent,
                "focus_ui",
                json!({ "threadId": thread_id, "surface": "diff" }),
            )
            .await;
        structured(&accepted);
    }
    let seventeenth = harness
        .call(
            &agent,
            "focus_ui",
            json!({ "threadId": thread_id, "surface": "diff" }),
        )
        .await;
    assert_eq!(error_tag(&seventeenth), "UiIntentError");
    assert_eq!(seventeenth["structuredContent"]["error"]["reason"], "limit");

    // Read-only connections list panels but cannot create, message or suggest.
    let (reader, _) = harness.agent(McpAccess::ReadOnly).await;
    let listed = harness.control.tools(&reader);
    let names: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(names.contains(&"list_chat_panels"));
    for hidden in ["create_chat_panel", "send_panel_message", "focus_ui"] {
        assert!(!names.contains(&hidden), "{hidden}");
    }
    harness.shutdown().await;
}

/// The outbox state of `message_id`, and how many command receipts were rejected.
async fn delivery_of(harness: &Harness, message_id: &str) -> (Option<String>, i64) {
    let message_id = message_id.to_owned();
    harness
        .repositories
        .database()
        .call(move |connection| {
            use rusqlite::OptionalExtension;
            let state = connection
                .query_row(
                    "SELECT state FROM provider_turn_outbox WHERE message_id = ?",
                    params![message_id],
                    |row| row.get(0),
                )
                .optional()?;
            let rejected = connection.query_row(
                "SELECT COUNT(*) FROM orchestration_command_receipts WHERE status = 'rejected'",
                [],
                |row| row.get(0),
            )?;
            Ok((state, rejected))
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn a_panel_message_queued_behind_a_running_turn_is_delivered_once_it_settles() {
    let fixture = Fixture::new().await;
    let harness = &fixture.harness;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let host = host(harness, &agent, "feature-queued").await;
    let panel = panel(harness, &agent, &host).await;
    harness
        .provider_turn(&host, "turn-busy", "working", false)
        .await;
    let sent = harness
        .call(
            &agent,
            "send_panel_message",
            json!({ "fromThreadId": panel, "toThreadId": host, "text": "When you are done" }),
        )
        .await;
    let message_id = structured(&sent)["messageId"].as_str().unwrap().to_owned();
    let (queued, rejected_before) = delivery_of(harness, &message_id).await;
    assert_eq!(queued.as_deref(), Some("queued"));

    // The turn settles; the server delivers the queued message without re-checking its source.
    harness
        .provider_turn(&host, "turn-busy", " done", true)
        .await;
    let mut delivered = None;
    for _ in 0..100 {
        let (state, rejected) = delivery_of(harness, &message_id).await;
        assert_eq!(rejected, rejected_before, "no command was rejected");
        if state.as_deref() != Some("queued") {
            delivered = state;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        delivered.is_some(),
        "the queued panel message left the queue"
    );
    assert_eq!(
        user_messages(harness, &host).await,
        [("When you are done".to_owned(), Some(panel.clone()))]
    );
    fixture.shutdown().await;
}
