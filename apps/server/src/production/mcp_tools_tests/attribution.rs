//! Slice X1: who acted. The server stamps an outside agent's actor from its authenticated
//! session on every event its commands plan, projects it onto the messages it sends and the
//! threads it creates, logs one content-free activity row per mutating call, and lets a
//! person Stop or Take over the agent.

use rusqlite::params;

use super::*;
use crate::{
    auth::McpAccessChange, mcp::control::ToolCall, production::orchestration_rpc::shell_snapshot,
    rpc::RpcSessionContext,
};

/// The events a command planned, with their metadata and stored actor kind.
async fn events_of(harness: &Harness, command_id: &str) -> Vec<(Value, String)> {
    let command_id = command_id.to_owned();
    harness
        .repositories
        .database()
        .call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT metadata_json, actor_kind FROM orchestration_events WHERE command_id = ? ORDER BY sequence",
            )?;
            let rows = statement
                .query_map([command_id], |row| {
                    Ok((
                        serde_json::from_str::<Value>(&row.get::<_, String>(0)?).unwrap(),
                        row.get::<_, String>(1)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
}

/// The command id of the turn start that created `thread_id`.
async fn creating_command(harness: &Harness, thread_id: &str) -> String {
    let thread_id = thread_id.to_owned();
    harness
        .repositories
        .database()
        .call(move |connection| {
            Ok(connection.query_row(
                "SELECT command_id FROM orchestration_events WHERE stream_id = ? AND event_type = 'thread.created'",
                [thread_id],
                |row| row.get::<_, String>(0),
            )?)
        })
        .await
        .unwrap()
}

/// A person's turn start, through the same dispatch RPC the UI uses.
async fn person_starts(harness: &Harness, extra: Value) -> String {
    let thread_id = uuid::Uuid::new_v4().to_string();
    let mut payload = json!({
        "type": "thread.turn.start",
        "commandId": uuid::Uuid::new_v4().to_string(),
        "threadId": thread_id,
        "message": { "messageId": uuid::Uuid::new_v4().to_string(), "role": "user", "text": "Hello", "attachments": [] },
        "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "bootstrap": { "createThread": {
            "projectId": "p1", "title": "Mine", "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "full-access", "interactionMode": "default", "branch": null, "worktreePath": null,
            "createdAt": CREATED_AT,
        } },
        "createdAt": CREATED_AT,
    });
    if let (Value::Object(payload), Value::Object(extra)) = (&mut payload, extra) {
        payload.extend(extra);
    }
    harness
        .control
        .registry()
        .invoke_local(
            "orchestration.dispatchCommand",
            payload,
            RpcSessionContext::unauthenticated(),
            CancellationToken::new(),
        )
        .await
        .expect("a person's turn starts");
    thread_id
}

#[tokio::test]
async fn an_agents_events_message_and_thread_carry_its_actor_and_a_persons_carry_none() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let session_id = agent.principal.session_id.clone();
    let label = harness.auth.client_label(&session_id).await;
    assert_eq!(label.as_deref(), Some("MCP · test"));
    let mut arguments = basic_start();
    arguments["purpose"] = "Fix the flaky test".into();
    let (thread_id, message_id) = start(&harness, &agent, arguments).await;

    let expected = json!({ "kind": "mcp-client", "clientId": session_id, "label": label });
    let events = events_of(&harness, &creating_command(&harness, &thread_id).await).await;
    assert!(!events.is_empty());
    for (metadata, actor_kind) in &events {
        assert_eq!(metadata["actor"], expected, "{metadata}");
        assert_eq!(actor_kind, "mcp-client");
    }
    let thread = harness
        .repositories
        .get_thread(thread_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        thread.requester,
        Some(json!({ "actor": expected, "purpose": "Fix the flaky test" }))
    );
    let read = harness
        .call(&agent, "read_thread", json!({ "threadId": thread_id }))
        .await;
    let read = structured(&read);
    assert_eq!(read["requester"]["purpose"], "Fix the flaky test");
    let sent = read["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["messageId"] == message_id.as_str())
        .unwrap();
    assert_eq!(sent["actor"], expected);
    let shell = shell_snapshot(&harness.engine, false).await.unwrap();
    let shown = shell["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|shown| shown["id"] == thread_id.as_str())
        .unwrap();
    assert_eq!(shown["requester"]["actor"], expected);

    // A person's commands carry no actor, even when the payload names one.
    let mine = person_starts(
        &harness,
        json!({ "actor": expected, "metadata": { "actor": expected } }),
    )
    .await;
    for (metadata, actor_kind) in
        events_of(&harness, &creating_command(&harness, &mine).await).await
    {
        assert!(metadata.get("actor").is_none(), "{metadata}");
        assert_eq!(actor_kind, "client");
    }
    let mine = harness
        .repositories
        .get_thread(mine)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(mine.requester, None);
    let shown = shell_snapshot(&harness.engine, false).await.unwrap();
    assert!(
        shown["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|shown| shown["id"] == mine.thread_id.as_str())
            .unwrap()
            .get("requester")
            .is_none()
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn a_purpose_over_two_hundred_characters_is_refused() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["purpose"] = "x".repeat(201).into();
    let refused = harness.call(&agent, "start_thread", arguments).await;
    assert_eq!(error_tag(&refused), "McpInvalidArgumentError");
    harness.shutdown().await;
}

async fn activity_rows(harness: &Harness) -> Vec<Value> {
    harness.control.activity().recent().await.unwrap()
}

#[tokio::test]
async fn one_activity_row_per_mutating_call_none_per_read_and_none_per_retry() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut keyed = basic_start();
    keyed["clientRequestId"] = "start-1".into();
    let (thread_id, _) = start(&harness, &agent, keyed.clone()).await;
    let rows = activity_rows(&harness).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["tool"], "start_thread");
    assert_eq!(rows[0]["outcome"], "success");
    assert_eq!(rows[0]["threadId"], thread_id.as_str());
    assert_eq!(rows[0]["clientId"], agent.principal.session_id.as_str());

    // A retry replays the first call: no second row.
    let (again, _) = start(&harness, &agent, keyed).await;
    assert_eq!(again, thread_id);
    // Reads write none.
    structured(
        &harness
            .call(&agent, "list_projects_and_threads", json!({}))
            .await,
    );
    structured(
        &harness
            .call(&agent, "read_thread", json!({ "threadId": thread_id }))
            .await,
    );
    assert_eq!(activity_rows(&harness).await.len(), 1);

    // A failure is a row too, with its tag and no content.
    let failed = harness
        .call(
            &agent,
            "send_message",
            json!({ "threadId": "missing", "text": "a secret message" }),
        )
        .await;
    let tag = error_tag(&failed).to_owned();
    let rows = activity_rows(&harness).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["tool"], "send_message");
    assert_eq!(rows[0]["outcome"], tag.as_str());
    assert!(!rows[0].to_string().contains("secret"));
    // The agent counts as active.
    let active = harness.control.activity().active();
    assert_eq!(active[0]["clientId"], agent.principal.session_id.as_str());
    harness.shutdown().await;
}

/// Owned work that runs until the live controls stop it.
async fn held(harness: &Harness, agent: &ClientPrincipal, key: &str) -> Value {
    let Value::Object(arguments) = json!({ "clientRequestId": key }) else {
        unreachable!()
    };
    let call = ToolCall {
        control: &harness.control,
        principal: agent,
        arguments: &arguments,
        cancellation: CancellationToken::new(),
    };
    call.recorded("git_push", &json!({}), move |owned| async move {
        owned.cancellation().cancelled().await;
        Ok(json!({}))
    })
    .await
    .unwrap_or_else(|failure| failure)
}

fn unknown_reason(result: &Value) -> &str {
    assert_eq!(error_tag(result), "McpOutcomeUnknownError", "{result}");
    result["structuredContent"]["error"]["reason"]
        .as_str()
        .unwrap_or_default()
}

/// Marks the thread's latest turn running, as the provider runtime's events do.
async fn turn_running(harness: &Harness, thread_id: &str, turn_id: &str) {
    harness.provider_turn(thread_id, turn_id, "", false).await;
    let (thread, turn) = (thread_id.to_owned(), turn_id.to_owned());
    harness
        .repositories
        .database()
        .call(move |connection| {
            connection.execute(
                "UPDATE projection_threads SET latest_turn_id = ?2 WHERE thread_id = ?1",
                params![thread, turn],
            )?;
            connection.execute(
                "INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json) VALUES (?1, ?2, 'running', '2026-10-30T00:00:00.000Z', '[]') ON CONFLICT (thread_id, turn_id) DO UPDATE SET state = 'running'",
                params![thread, turn],
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

async fn stop_interrupts(harness: &Harness, thread_id: &str) -> i64 {
    let thread_id = thread_id.to_owned();
    harness
        .repositories
        .database()
        .call(move |connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM orchestration_command_receipts WHERE command_id LIKE 'server:mcp-stop:%' AND aggregate_id = ?",
                [thread_id],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap()
}

async fn until_async<F, Fut>(mut done: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    tokio::time::timeout(Duration::from_secs(5), async {
        while !done().await {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("in time");
}

#[tokio::test]
async fn stop_revokes_the_agent_interrupts_its_running_turn_and_cancels_its_owned_work() {
    let harness = Harness::new().await;
    let (agent, token) = harness.agent(McpAccess::FullAccess).await;
    let (theirs, _) = start(&harness, &agent, basic_start()).await;
    let mine = person_starts(&harness, json!({})).await;
    turn_running(&harness, &theirs, "turn-agent").await;
    turn_running(&harness, &mine, "turn-person").await;

    let session_id = agent.principal.session_id.clone();
    let (outcome, ()) = tokio::join!(held(&harness, &agent, "push-1"), async {
        until_async(|| async {
            harness
                .auth
                .live_connection_count_for_test(&session_id)
                .await
                > 0
        })
        .await;
        let stopped = harness
            .auth
            .stop_client("person", &session_id)
            .await
            .unwrap();
        assert!(stopped.revoked);
        // Stop answers once the interrupt was tried: one turn, which this harness's
        // provider (no live session) refuses, so it counts as failed.
        assert_eq!((stopped.interrupted, stopped.failed), (0, 1), "{stopped:?}");
        assert!(!stopped.timed_out);
    });
    assert_eq!(unknown_reason(&outcome), "revoked");
    assert!(harness.control.authenticate(&token).await.is_none());
    assert_eq!(stop_interrupts(&harness, &theirs).await, 1);
    assert_eq!(
        stop_interrupts(&harness, &mine).await,
        0,
        "a person's turn is left alone"
    );

    // A plain revocation (the CLI revokes its own credential on the way out) interrupts
    // nothing.
    let (other, _) = harness.agent(McpAccess::FullAccess).await;
    let (cli, _) = start(&harness, &other, basic_start()).await;
    turn_running(&harness, &cli, "turn-cli").await;
    assert!(
        harness
            .auth
            .revoke_client("person", &other.principal.session_id)
            .await
            .unwrap()
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(stop_interrupts(&harness, &cli).await, 0);
    harness.shutdown().await;
}

/// Review round 2: Revoke first, then Stop while the agent's turn still runs.
#[tokio::test]
async fn stop_after_revoke_still_interrupts_the_agents_running_turn() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (theirs, _) = start(&harness, &agent, basic_start()).await;
    turn_running(&harness, &theirs, "turn-agent").await;
    let session_id = agent.principal.session_id.clone();
    assert!(
        harness
            .auth
            .revoke_client("person", &session_id)
            .await
            .unwrap()
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(stop_interrupts(&harness, &theirs).await, 0, "Revoke alone");

    // Stop on the already revoked agent still interrupts what it is running.
    let stopped = harness
        .auth
        .stop_client("person", &session_id)
        .await
        .unwrap();
    assert!(stopped.revoked);
    assert_eq!(stopped.interrupted + stopped.failed, 1);
    assert_eq!(stop_interrupts(&harness, &theirs).await, 1);

    // A session that was never an agent's, or never existed, is not stopped.
    let missing = harness.auth.stop_client("person", "missing").await.unwrap();
    assert!(!missing.revoked);
    assert_eq!(missing.interrupted + missing.failed, 0);
    harness.shutdown().await;
}

/// Review round 3: an interrupt that cannot be dispatched is reported, not hidden.
#[tokio::test]
async fn stop_reports_an_interrupt_it_could_not_dispatch() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (theirs, _) = start(&harness, &agent, basic_start()).await;
    turn_running(&harness, &theirs, "turn-agent").await;
    // Update maintenance holds RPC admission closed: the interrupt's dispatch is refused.
    let gate = harness.control.registry().admission_gate();
    gate.close_and_drain(tokio::time::Instant::now() + Duration::from_secs(5))
        .await
        .expect("drained");
    let stopped = harness
        .auth
        .stop_client("person", &agent.principal.session_id)
        .await
        .unwrap();
    gate.release().unwrap();
    assert!(stopped.revoked);
    assert_eq!((stopped.interrupted, stopped.failed), (0, 1), "{stopped:?}");
    assert_eq!(
        stop_interrupts(&harness, &theirs).await,
        0,
        "nothing reached the engine"
    );
    harness.shutdown().await;
}

/// Review round 3: a person's compaction after an agent's message is not the agent's turn.
#[tokio::test]
async fn a_compaction_after_an_agents_message_is_not_the_agents_turn() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (theirs, _) = start(&harness, &agent, basic_start()).await;
    turn_running(&harness, &theirs, "turn-agent").await;
    harness.provider_turn(&theirs, "turn-agent", "", true).await;
    // A compaction runs as a turn of its own, started by no user message.
    let thread = theirs.clone();
    harness
        .repositories
        .database()
        .call(move |connection| {
            connection.execute(
                "UPDATE projection_turns SET state = 'completed' WHERE thread_id = ?1",
                [&thread],
            )?;
            connection.execute(
                "INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json) VALUES (?1, 'turn-compaction', NULL, 'running', '2026-10-30T00:00:00.000Z', '[]')",
                [&thread],
            )?;
            connection.execute(
                "UPDATE projection_threads SET latest_turn_id = 'turn-compaction' WHERE thread_id = ?1",
                [&thread],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let activity = crate::mcp::activity::McpActivity::new(harness.repositories.database().clone());
    assert!(
        activity.active_now().await.is_empty(),
        "the compaction keeps no agent active"
    );
    let stopped = harness
        .auth
        .stop_client("person", &agent.principal.session_id)
        .await
        .unwrap();
    assert_eq!(stopped.interrupted + stopped.failed, 0, "{stopped:?}");
    assert_eq!(stop_interrupts(&harness, &theirs).await, 0);
    harness.shutdown().await;
}

/// Review round 2: an agent whose turn still runs stays active long after its last call.
#[tokio::test]
async fn an_agents_running_turn_keeps_it_active_without_recent_calls() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (theirs, _) = start(&harness, &agent, basic_start()).await;
    // A fresh activity service has no recent calls: only the turn can make it active.
    let activity = crate::mcp::activity::McpActivity::new(harness.repositories.database().clone());
    assert!(activity.active_now().await.is_empty());

    turn_running(&harness, &theirs, "turn-agent").await;
    let active = activity.active_now().await;
    assert_eq!(active.len(), 1, "{active:?}");
    assert_eq!(active[0]["clientId"], agent.principal.session_id.as_str());
    assert_eq!(active[0]["label"], "MCP · test");
    assert_eq!(active[0]["runningTurns"], 1);
    assert_eq!(active[0]["running"], true);

    // A person's running turn makes no agent active.
    let mine = person_starts(&harness, json!({})).await;
    turn_running(&harness, &mine, "turn-person").await;
    assert_eq!(activity.active_now().await.len(), 1);

    harness.provider_turn(&theirs, "turn-agent", "", true).await;
    harness
        .repositories
        .database()
        .call(|connection| {
            connection.execute(
                "UPDATE projection_turns SET state = 'completed' WHERE turn_id = 'turn-agent'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(activity.active_now().await.is_empty());
    harness.shutdown().await;
}

#[tokio::test]
async fn take_over_refuses_mutations_stops_owned_work_and_hand_back_restores_the_level() {
    let harness = Harness::new().await;
    let (agent, token) = harness.agent(McpAccess::FullAccess).await;
    let session_id = agent.principal.session_id.clone();

    let (outcome, ()) = tokio::join!(held(&harness, &agent, "push-1"), async {
        until_async(|| async {
            harness
                .auth
                .live_connection_count_for_test(&session_id)
                .await
                > 0
        })
        .await;
        assert_eq!(
            harness
                .auth
                .set_mcp_access(&session_id, "read-only")
                .await
                .unwrap(),
            McpAccessChange::Changed
        );
    });
    // The route cancels the session's live work, which reads as a revocation to it.
    assert_eq!(unknown_reason(&outcome), "revoked");
    until_async(|| async {
        harness
            .auth
            .live_connection_count_for_test(&session_id)
            .await
            == 0
    })
    .await;

    // Every request authenticates again: the agent can read but not act.
    let taken = harness.control.authenticate(&token).await.unwrap();
    assert_eq!(taken.ceiling, McpAccess::ReadOnly);
    structured(
        &harness
            .call(&taken, "list_projects_and_threads", json!({}))
            .await,
    );
    let refused = harness.call(&taken, "start_thread", basic_start()).await;
    assert_eq!(error_tag(&refused), "McpAccessCeilingError");
    let view = harness
        .auth
        .list_clients("person")
        .await
        .into_iter()
        .find(|client| client.session_id == session_id)
        .unwrap();
    assert_eq!(view.mcp_access.as_deref(), Some("read-only"));
    assert_eq!(view.mcp_access_hand_back.as_deref(), Some("full-access"));

    // Taking over twice keeps the level to hand back; only that level may be handed back.
    assert_eq!(
        harness
            .auth
            .set_mcp_access(&session_id, "read-only")
            .await
            .unwrap(),
        McpAccessChange::Changed
    );
    assert_eq!(
        harness
            .auth
            .set_mcp_access(&session_id, "approval-required")
            .await
            .unwrap(),
        McpAccessChange::NotTheHandBack
    );
    assert_eq!(
        harness
            .auth
            .set_mcp_access(&session_id, "full-access")
            .await
            .unwrap(),
        McpAccessChange::Changed
    );
    let back = harness.control.authenticate(&token).await.unwrap();
    assert_eq!(back.ceiling, McpAccess::FullAccess);
    structured(&harness.call(&back, "start_thread", basic_start()).await);

    // Nothing else can be raised, and only agents can be taken over.
    assert_eq!(
        harness
            .auth
            .set_mcp_access(&session_id, "full-access")
            .await
            .unwrap(),
        McpAccessChange::NotTheHandBack
    );
    assert_eq!(
        harness
            .auth
            .set_mcp_access(&session_id, "admin")
            .await
            .unwrap(),
        McpAccessChange::InvalidAccess
    );
    assert_eq!(
        harness
            .auth
            .set_mcp_access("missing", "read-only")
            .await
            .unwrap(),
        McpAccessChange::NotFound
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn create_worktree_and_a_panel_stamp_the_threads_they_create() {
    let fixture = super::worktrees::Fixture::new().await;
    let harness = &fixture.harness;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let created = harness
        .call(
            &agent,
            "create_worktree",
            json!({
                "projectId": super::worktrees::PROJECT, "branch": "main", "newBranch": "feature-x",
                "purpose": "Try the fix in isolation",
            }),
        )
        .await;
    let host_id = structured(&created)["threadId"]
        .as_str()
        .unwrap()
        .to_owned();
    let host = harness
        .repositories
        .get_thread(host_id.clone())
        .await
        .unwrap()
        .unwrap();
    let requester = host.requester.expect("an agent's worktree thread");
    assert_eq!(
        requester["actor"]["clientId"],
        agent.principal.session_id.as_str()
    );
    assert_eq!(requester["purpose"], "Try the fix in isolation");

    // A panel an agent opens on that host, through the same RPC the UI uses.
    let mut registry = RpcRegistry::empty();
    crate::production::worktree_catalog_rpc::register_worktree_catalog_rpc(
        &mut registry,
        fixture.services.clone(),
    );
    let panel_id = uuid::Uuid::new_v4().to_string();
    let panel = |thread_id: &str, purpose: Option<&str>| {
        json!({
            "commandId": uuid::Uuid::new_v4().to_string(),
            "hostThreadId": host_id,
            "threadId": thread_id,
            "title": "Review",
            "threadDefaults": { "modelSelection": {"instanceId": "codex", "model": "gpt-5"}, "runtimeMode": "full-access", "interactionMode": "default" },
            "purpose": purpose,
        })
    };
    registry
        .invoke_local(
            "worktree.createPanel",
            panel(&panel_id, Some("Review the diff")),
            RpcSessionContext::authenticated(agent.principal.clone(), harness.auth.clone()),
            CancellationToken::new(),
        )
        .await
        .expect("panel created");
    let stamped = harness
        .repositories
        .get_thread(panel_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stamped.kind, "panel");
    assert_eq!(
        stamped.requester.expect("an agent's panel")["purpose"],
        "Review the diff"
    );
    // A person's panel carries none.
    let mine = uuid::Uuid::new_v4().to_string();
    registry
        .invoke_local(
            "worktree.createPanel",
            panel(&mine, None),
            RpcSessionContext::unauthenticated(),
            CancellationToken::new(),
        )
        .await
        .expect("panel created");
    assert_eq!(
        harness
            .repositories
            .get_thread(mine)
            .await
            .unwrap()
            .unwrap()
            .requester,
        None
    );
    fixture.shutdown().await;
}
