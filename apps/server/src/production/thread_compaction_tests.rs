//! Conversation compaction as the engine and the delivery worker see it: the turns projector's
//! tagged compaction turns, context-limit recovery, settlement, Stop, restart, manual
//! compaction's refusals and the guard. The compaction effect itself is driven by hand here
//! (`settle`), so each step's state can be checked.

use super::*;
use crate::{
    orchestration::{
        CommandAdmission, EngineOptions, NewProviderTurnDelivery, TurnDeliveryMode,
        canonical_command_digest,
        engine::{
            GUARD_WAITING_DETAIL, ThreadCompactionRow, guard_command_id, resend_command_id,
            resend_message_id,
        },
    },
    persistence::{Database, ProviderSessionRuntime, run_migrations},
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const TIME: &str = "2026-10-24T00:00:00Z";
const CLAUDE: &str = "claudeAgent";
const CONVERSATION: &str = "claude-session";
const FAILURE: &str = "Claude's context window is full. Compact the conversation, then send your message again. Claude reported: Prompt is too long.";
const RECOVERY: &str =
    "The context window is full. Compacting the conversation, then sending your message again.";

fn command(value: Value) -> OrchestrationCommand {
    serde_json::from_value(value).unwrap()
}

/// A Claude thread with a saved conversation.
async fn engine() -> OrchestrationEngine {
    let database = Database::open_in_memory().await.unwrap();
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .unwrap();
    let engine = OrchestrationEngine::start(database, EngineOptions::default())
        .await
        .unwrap();
    for value in [
        json!({"type":"project.create", "commandId":"project", "projectId":"p", "title":"Compaction", "workspaceRoot":"C:/repo", "createdAt":TIME}),
        json!({"type":"thread.create", "commandId":"thread", "threadId":"t", "projectId":"p", "title":"Compaction", "runtimeMode":"full-access", "modelSelection":{"instanceId":CLAUDE, "model":"claude-opus"}, "createdAt":TIME}),
    ] {
        engine.dispatch(command(value)).await.unwrap();
    }
    save_runtime(&engine, CLAUDE, CONVERSATION).await;
    engine
}

async fn save_runtime(engine: &OrchestrationEngine, provider: &str, conversation: &str) {
    engine
        .repositories()
        .upsert_provider_session_runtime(ProviderSessionRuntime {
            thread_id: "t".into(),
            provider_name: provider.into(),
            provider_instance_id: Some(provider.into()),
            adapter_key: "claude-stream-json".into(),
            runtime_mode: "full-access".into(),
            status: "ready".into(),
            last_seen_at: TIME.into(),
            resume_cursor: Some(json!({ "sessionId": conversation })),
            runtime_payload: None,
        })
        .await
        .unwrap();
}

async fn session(engine: &OrchestrationEngine, status: &str, id: &str, turn: Option<&str>) {
    engine.dispatch(command(json!({"type":"thread.session.set", "commandId":id, "threadId":"t", "session":{"threadId":"t", "status":status, "providerName":CLAUDE, "providerInstanceId":CLAUDE, "activeTurnId":turn, "lastError":null, "updatedAt":TIME}, "createdAt":TIME}))).await.unwrap();
}

async fn enqueue(engine: &OrchestrationEngine, id: &str, queued: bool) {
    enqueue_as(engine, id, queued, CLAUDE).await;
}

async fn enqueue_as(engine: &OrchestrationEngine, id: &str, queued: bool, provider: &str) {
    let mut value = json!({"type":"thread.turn.start", "commandId":id, "threadId":"t", "message":{"messageId":id, "role":"user", "text":format!("text of {id}"), "attachments":[]}, "modelSelection":{"instanceId":provider, "model":"claude-opus"}, "createdAt":TIME});
    if queued {
        value["queued"] = json!(true);
    }
    let command = command(value);
    engine
        .dispatch_with_admission(
            command.clone(),
            CommandAdmission {
                payload_digest: canonical_command_digest(&command).unwrap(),
                attachment_refs: Vec::new(),
                provider_turn: Some(NewProviderTurnDelivery {
                    command_id: id.into(),
                    thread_id: "t".into(),
                    message_id: id.into(),
                    provider_instance_id: provider.into(),
                    provider_kind: provider.into(),
                    provider_session_id: None,
                    delivery_key: format!("{id}-key"),
                    payload: serde_json::to_value(&command).unwrap(),
                    state: if queued {
                        TurnDeliveryState::Queued
                    } else {
                        TurnDeliveryState::Pending
                    },
                    mode: TurnDeliveryMode::Start,
                    created_at: TIME.into(),
                }),
            },
            || {},
        )
        .await
        .unwrap();
}

async fn sql(engine: &OrchestrationEngine, statement: &str) {
    let statement = statement.to_owned();
    engine
        .repositories()
        .database()
        .call(move |connection| {
            connection.execute_batch(&statement)?;
            Ok(())
        })
        .await
        .unwrap();
}

async fn count(engine: &OrchestrationEngine, query: &str) -> i64 {
    let query = query.to_owned();
    engine
        .repositories()
        .database()
        .call(move |connection| Ok(connection.query_row(&query, [], |row| row.get(0))?))
        .await
        .unwrap()
}

async fn reading(engine: &OrchestrationEngine, id: &str, turn: &str, payload: Value) {
    engine.dispatch(command(json!({"type":"thread.activity.append", "commandId":id, "threadId":"t", "activity":{"id":id, "tone":"info", "kind":"context-window.updated", "summary":"Context window updated", "payload":payload, "turnId":turn, "createdAt":TIME}, "createdAt":TIME}))).await.unwrap();
}

/// The reading of the #160 incident: 961K of 1M, auto-compacting at 967K.
fn near_full() -> Value {
    json!({"usedTokens":961_230, "maxTokens":1_000_000, "compactsAutomatically":true, "autoCompactTokens":967_000, "providerInstanceId":CLAUDE, "conversationId":CONVERSATION})
}

/// `message` was delivered to the saved conversation and its turn `turn` ran with `reading`.
async fn delivered_turn(
    engine: &OrchestrationEngine,
    message: &str,
    turn: &str,
    reading_payload: Value,
) {
    enqueue(engine, message, false).await;
    sql(engine, &format!("UPDATE provider_turn_outbox SET state = 'delivered', attempts = 1, provider_session_id = '{CONVERSATION}' WHERE command_id = '{message}'")).await;
    session(engine, "running", &format!("running-{turn}"), Some(turn)).await;
    reading(engine, &format!("reading-{turn}"), turn, reading_payload).await;
}

async fn fail_at_limit(engine: &OrchestrationEngine, id: &str, turn: &str, facts: Value) {
    engine.dispatch(command(json!({"type":"thread.session.set", "commandId":id, "threadId":"t", "session":{"threadId":"t", "status":"error", "providerName":CLAUDE, "providerInstanceId":CLAUDE, "activeTurnId":null, "lastError":FAILURE, "lastErrorClass":"context_limit", "updatedAt":TIME}, "contextLimit":{"turnId":turn, "beforeOutput":facts["beforeOutput"], "compactable":facts["compactable"]}, "createdAt":TIME}))).await.unwrap();
}

fn before_output() -> Value {
    json!({"beforeOutput": true})
}

async fn compactions(engine: &OrchestrationEngine) -> Vec<ThreadCompactionRow> {
    let mut rows = Vec::new();
    for row in engine.unsettled_thread_compactions().await.unwrap() {
        rows.push(row);
    }
    let settled = engine
        .repositories()
        .database()
        .call(|connection| {
            let mut statement = connection.prepare(
                "SELECT compaction_id FROM thread_compactions WHERE state NOT IN ('requested', 'running', 'unresolved') ORDER BY created_at, compaction_id",
            )?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
        .await
        .unwrap();
    for id in settled {
        rows.push(engine.thread_compaction(&id).await.unwrap().unwrap());
    }
    rows
}

async fn only_compaction(engine: &OrchestrationEngine) -> ThreadCompactionRow {
    let rows = compactions(engine).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    rows.into_iter().next().unwrap()
}

async fn the_session(engine: &OrchestrationEngine) -> crate::persistence::ProjectionThreadSession {
    engine
        .repositories()
        .get_thread_session("t".into())
        .await
        .unwrap()
        .unwrap()
}

async fn row(engine: &OrchestrationEngine, id: &str) -> ProviderTurnDelivery {
    engine
        .repositories()
        .get_provider_turn_delivery(id.into())
        .await
        .unwrap()
        .unwrap()
}

async fn settle(
    engine: &OrchestrationEngine,
    compaction_id: &str,
    outcome: &str,
    detail: Option<&str>,
) {
    engine
        .dispatch(OrchestrationCommand::ThreadCompactionSettle {
            command_id: format!("server:compaction-settle:{compaction_id}"),
            thread_id: "t".into(),
            compaction_id: compaction_id.into(),
            outcome: outcome.into(),
            detail: detail.map(str::to_owned),
            restarted: false,
            created_at: TIME.into(),
        })
        .await
        .unwrap();
    engine.wake_turn_delivery();
}

async fn interrupt(engine: &OrchestrationEngine, id: &str) {
    engine.dispatch(command(json!({"type":"thread.turn.interrupt", "commandId":id, "threadId":"t", "createdAt":TIME}))).await.unwrap();
}

fn start_delivery(
    engine: &OrchestrationEngine,
) -> (TurnDeliveryService, mpsc::UnboundedReceiver<String>) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let router: DeliveryRouter = Arc::new(move |command| {
        sender.send(command.command_id().to_owned()).unwrap();
        Box::pin(async { Ok(()) })
    });
    (
        TurnDeliveryService::start_with_router(engine.clone(), 1, router),
        receiver,
    )
}

async fn quiet(routes: &mut mpsc::UnboundedReceiver<String>) {
    assert!(
        timeout(Duration::from_millis(150), routes.recv())
            .await
            .is_err(),
        "no provider delivery expected"
    );
}

async fn received(routes: &mut mpsc::UnboundedReceiver<String>, id: &str) {
    assert_eq!(
        timeout(Duration::from_secs(3), routes.recv())
            .await
            .expect("delivery wakes")
            .as_deref(),
        Some(id)
    );
}

#[tokio::test]
async fn a_compaction_turn_keeps_the_marker_of_the_message_waiting_behind_it() {
    let engine = engine().await;
    enqueue(&engine, "waiting", false).await;
    let markers = "SELECT COUNT(*) FROM projection_turns WHERE thread_id = 't' AND turn_id IS NULL AND pending_message_id = 'waiting'";
    assert_eq!(count(&engine, markers).await, 1);
    for id in ["compaction-running", "compaction-running-again"] {
        engine.dispatch(command(json!({"type":"thread.session.set", "commandId":id, "threadId":"t", "session":{"threadId":"t", "status":"running", "providerName":CLAUDE, "providerInstanceId":CLAUDE, "activeTurnId":"compaction-turn", "lastError":null, "updatedAt":TIME}, "compactionId":"compaction:1", "createdAt":TIME}))).await.unwrap();
        assert_eq!(
            count(&engine, markers).await,
            1,
            "{id} must not bind or delete the marker"
        );
    }
    assert_eq!(
        count(&engine, "SELECT COUNT(*) FROM projection_turns WHERE turn_id = 'compaction-turn' AND pending_message_id IS NULL").await,
        1
    );
    session(&engine, "ready", "compaction-ready", None).await;
    // The waiting message's own turn binds its marker, as any untagged update does.
    session(&engine, "running", "waiting-running", Some("waiting-turn")).await;
    assert_eq!(count(&engine, markers).await, 0);
    assert_eq!(
        count(&engine, "SELECT COUNT(*) FROM projection_turns WHERE turn_id = 'waiting-turn' AND pending_message_id = 'waiting'").await,
        1
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn an_eligible_context_limit_failure_begins_one_recovery_and_holds_nothing() {
    let engine = engine().await;
    delivered_turn(&engine, "failed", "turn-1", near_full()).await;
    enqueue(&engine, "queued", true).await;
    fail_at_limit(&engine, "failure", "turn-1", before_output()).await;

    let recovery = only_compaction(&engine).await;
    assert_eq!(recovery.trigger, "contextRecovery");
    assert_eq!(recovery.state, "requested");
    assert_eq!(recovery.failed_message_id.as_deref(), Some("failed"));
    assert_eq!(recovery.provider_instance_id, CLAUDE);
    assert_eq!(recovery.provider_kind, CLAUDE);
    assert_eq!(recovery.conversation_id.as_deref(), Some(CONVERSATION));
    assert_eq!(recovery.detail.as_deref(), Some(FAILURE));
    let session = the_session(&engine).await;
    assert_eq!(session.status, "error");
    assert_eq!(session.last_error.as_deref(), Some(RECOVERY));
    assert_eq!(session.last_error_class.as_deref(), Some("context_limit"));
    assert!(
        !row(&engine, "queued").await.held,
        "the queue follows the copy"
    );
    let requested =
        "SELECT COUNT(*) FROM orchestration_events WHERE event_type = 'thread.compact-requested'";
    assert_eq!(count(&engine, requested).await, 1);
    assert_eq!(
        count(
            &engine,
            "SELECT COUNT(*) FROM projection_thread_messages WHERE role = 'user'"
        )
        .await,
        2,
        "no copy until the compaction succeeds"
    );
    let snapshot = crate::orchestration::load_thread_snapshot(&engine.repositories(), "t")
        .await
        .unwrap();
    let thread = snapshot
        .threads
        .iter()
        .find(|thread| thread.thread_id == "t")
        .unwrap();
    assert_eq!(
        thread.compaction.as_ref().unwrap()["failedMessageId"],
        "failed"
    );

    // The same failure again adds nothing and keeps the recovery's state.
    fail_at_limit(&engine, "failure-again", "turn-1", before_output()).await;
    assert_eq!(
        only_compaction(&engine).await.compaction_id,
        recovery.compaction_id
    );
    assert_eq!(count(&engine, requested).await, 1);
    assert_eq!(
        the_session(&engine).await.last_error.as_deref(),
        Some(RECOVERY)
    );
    assert!(!row(&engine, "queued").await.held);
    engine.shutdown().await;
}

#[tokio::test]
async fn an_ineligible_context_limit_failure_is_todays_error() {
    let mut other_conversation = near_full();
    other_conversation["conversationId"] = json!("another-session");
    let mut untagged = near_full();
    untagged
        .as_object_mut()
        .unwrap()
        .remove("providerInstanceId");
    untagged.as_object_mut().unwrap().remove("conversationId");
    let mut switched_off = near_full();
    switched_off["compactsAutomatically"] = json!(false);
    let cases: Vec<(&str, Value, Value)> = vec![
        ("auto-compact off", switched_off, before_output()),
        ("another conversation", other_conversation, before_output()),
        ("untagged reading", untagged, before_output()),
        ("after output", near_full(), json!({"beforeOutput": false})),
        ("unknown output", near_full(), json!({})),
        (
            "not compactable",
            near_full(),
            json!({"beforeOutput": true, "compactable": false}),
        ),
        ("steer still pending", near_full(), before_output()),
        ("failed guard", near_full(), before_output()),
    ];
    for (case, reading_payload, facts) in cases {
        let engine = engine().await;
        delivered_turn(&engine, "failed", "turn-1", reading_payload).await;
        enqueue(&engine, "queued", true).await;
        if case == "steer still pending" {
            sql(&engine, "INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status) VALUES ('steer', 'thread', 't', '2026-10-24T00:00:00Z', 1, 'accepted'); INSERT INTO provider_turn_outbox (command_id, thread_id, message_id, provider_instance_id, provider_kind, provider_session_id, delivery_key, payload_json, state, mode, attempts, last_error, created_at, updated_at) VALUES ('steer', 't', 'steer', 'claudeAgent', 'claudeAgent', NULL, 'steer-key', '{}', 'sending', 'steer', 1, NULL, '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')").await;
        }
        if case == "failed guard" {
            sql(&engine, "INSERT INTO thread_compactions (compaction_id, thread_id, trigger, state, provider_instance_id, provider_kind, guarded_delivery_command_id, created_at, updated_at) VALUES ('guard', 't', 'guard', 'failed', 'claudeAgent', 'claudeAgent', 'failed', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')").await;
        }
        fail_at_limit(&engine, "failure", "turn-1", facts).await;
        assert_eq!(
            count(
                &engine,
                "SELECT COUNT(*) FROM thread_compactions WHERE trigger = 'contextRecovery'"
            )
            .await,
            0,
            "{case}"
        );
        assert_eq!(
            the_session(&engine).await.last_error.as_deref(),
            Some(FAILURE),
            "{case}"
        );
        assert!(
            row(&engine, "queued").await.held,
            "{case}: the queue is held as today"
        );
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn a_provider_that_cannot_compact_is_not_recovered() {
    let engine = engine().await;
    save_runtime(&engine, "cursor", CONVERSATION).await;
    enqueue_as(&engine, "failed", false, "cursor").await;
    sql(&engine, &format!("UPDATE provider_turn_outbox SET state = 'delivered', attempts = 1, provider_session_id = '{CONVERSATION}' WHERE command_id = 'failed'")).await;
    session(&engine, "running", "running", Some("turn-1")).await;
    let mut cursor_reading = near_full();
    cursor_reading["providerInstanceId"] = json!("cursor");
    reading(&engine, "reading", "turn-1", cursor_reading).await;
    fail_at_limit(&engine, "failure", "turn-1", before_output()).await;
    assert_eq!(compactions(&engine).await.len(), 0);
    engine.shutdown().await;
}

#[tokio::test]
async fn a_completed_recovery_sends_the_copy_first_then_the_queue() {
    let engine = engine().await;
    delivered_turn(&engine, "failed", "turn-1", near_full()).await;
    enqueue(&engine, "queued", true).await;
    fail_at_limit(&engine, "failure", "turn-1", before_output()).await;
    let recovery = only_compaction(&engine).await;
    assert!(
        engine
            .start_thread_compaction(&recovery.compaction_id, TIME)
            .await
            .unwrap()
    );
    let (service, mut routes) = start_delivery(&engine);
    // Nothing is claimed while the compaction is unsettled.
    session(&engine, "ready", "compaction-ready", None).await;
    quiet(&mut routes).await;

    settle(&engine, &recovery.compaction_id, "completed", None).await;
    let copy_id = resend_command_id("failed");
    let copy = row(&engine, &copy_id).await;
    let original = row(&engine, "failed").await;
    assert_eq!(copy.message_id, resend_message_id("failed"));
    assert_eq!(copy.provider_instance_id, original.provider_instance_id);
    assert_eq!(copy.provider_session_id.as_deref(), Some(CONVERSATION));
    assert_ne!(copy.delivery_key, original.delivery_key);
    assert_eq!(copy.payload["resendOf"], "failed");
    assert_eq!(copy.payload["message"]["text"], "text of failed");
    assert_eq!(
        copy.payload["message"]["messageId"],
        json!(resend_message_id("failed"))
    );
    assert_eq!(
        count(&engine, &format!("SELECT COUNT(*) FROM orchestration_command_receipts WHERE command_id = '{copy_id}' AND status = 'accepted'")).await,
        1
    );
    let message = engine
        .repositories()
        .get_message(resend_message_id("failed"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(message.resend_of_message_id.as_deref(), Some("failed"));
    assert_eq!(the_session(&engine).await.last_error, None);

    received(&mut routes, &copy_id).await;
    quiet(&mut routes).await;
    session(&engine, "running", "copy-running", Some("copy-turn")).await;
    session(&engine, "ready", "copy-ready", None).await;
    received(&mut routes, "queued").await;
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn a_copy_that_fails_at_the_limit_again_is_not_recovered_twice() {
    let engine = engine().await;
    delivered_turn(&engine, "failed", "turn-1", near_full()).await;
    fail_at_limit(&engine, "failure", "turn-1", before_output()).await;
    let recovery = only_compaction(&engine).await;
    settle(&engine, &recovery.compaction_id, "completed", None).await;
    let copy_id = resend_command_id("failed");
    sql(&engine, &format!("UPDATE provider_turn_outbox SET state = 'delivered', attempts = 1 WHERE command_id = '{copy_id}'")).await;
    session(&engine, "running", "copy-running", Some("copy-turn")).await;
    reading(&engine, "copy-reading", "copy-turn", near_full()).await;
    fail_at_limit(&engine, "copy-failure", "copy-turn", before_output()).await;
    assert_eq!(
        compactions(&engine).await.len(),
        1,
        "one compaction per failed message"
    );
    let session = the_session(&engine).await;
    assert_eq!(
        session.last_error.as_deref(),
        Some(
            format!("{FAILURE} The conversation was already compacted once for this message.")
                .as_str()
        )
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn a_failed_recovery_holds_the_queue_with_the_failure() {
    let engine = engine().await;
    delivered_turn(&engine, "failed", "turn-1", near_full()).await;
    enqueue(&engine, "queued", true).await;
    fail_at_limit(&engine, "failure", "turn-1", before_output()).await;
    let recovery = only_compaction(&engine).await;
    engine
        .start_thread_compaction(&recovery.compaction_id, TIME)
        .await
        .unwrap();
    session(&engine, "ready", "compaction-ready", None).await;
    settle(
        &engine,
        &recovery.compaction_id,
        "failed",
        Some("Claude couldn't compact the conversation."),
    )
    .await;
    assert_eq!(only_compaction(&engine).await.state, "failed");
    let session = the_session(&engine).await;
    assert_eq!(session.status, "error");
    assert_eq!(
        session.last_error.as_deref(),
        Some("Claude couldn't compact the conversation.")
    );
    assert_eq!(session.last_error_class.as_deref(), Some("context_limit"));
    assert!(row(&engine, "queued").await.held);
    assert_eq!(
        count(&engine, "SELECT COUNT(*) FROM provider_turn_outbox WHERE command_id LIKE 'server:context-resend:%'").await,
        0
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn stop_before_the_compaction_starts_settles_it_and_sends_nothing() {
    let engine = engine().await;
    delivered_turn(&engine, "failed", "turn-1", near_full()).await;
    enqueue(&engine, "queued", true).await;
    fail_at_limit(&engine, "failure", "turn-1", before_output()).await;
    let recovery = only_compaction(&engine).await;
    interrupt(&engine, "stop").await;
    let stopped = engine
        .thread_compaction(&recovery.compaction_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stopped.state, "interrupted");
    // The effect's conditional start fails, so no write reaches the provider.
    assert!(
        !engine
            .start_thread_compaction(&recovery.compaction_id, TIME)
            .await
            .unwrap()
    );
    let session = the_session(&engine).await;
    assert_eq!(
        session.last_error.as_deref(),
        Some(FAILURE),
        "the manual action returns"
    );
    assert_eq!(session.last_error_class.as_deref(), Some("context_limit"));
    assert!(row(&engine, "queued").await.held);
    assert_eq!(
        count(&engine, "SELECT COUNT(*) FROM orchestration_events WHERE event_type = 'thread.compacted' AND json_extract(payload_json, '$.outcome') = 'interrupted'").await,
        1
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn stop_during_the_compaction_wins_even_if_it_completes() {
    let engine = engine().await;
    delivered_turn(&engine, "failed", "turn-1", near_full()).await;
    enqueue(&engine, "queued", true).await;
    fail_at_limit(&engine, "failure", "turn-1", before_output()).await;
    let recovery = only_compaction(&engine).await;
    engine
        .start_thread_compaction(&recovery.compaction_id, TIME)
        .await
        .unwrap();
    interrupt(&engine, "stop").await;
    let stopping = engine
        .thread_compaction(&recovery.compaction_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stopping.state, "running");
    assert!(stopping.stop_requested);
    session(&engine, "interrupted", "compaction-interrupted", None).await;
    settle(&engine, &recovery.compaction_id, "completed", None).await;
    assert_eq!(only_compaction(&engine).await.state, "interrupted");
    assert_eq!(
        count(&engine, "SELECT COUNT(*) FROM provider_turn_outbox WHERE command_id LIKE 'server:context-resend:%'").await,
        0,
        "no copy after a Stop"
    );
    assert_eq!(
        the_session(&engine).await.last_error.as_deref(),
        Some(FAILURE)
    );
    assert!(row(&engine, "queued").await.held);
    engine.shutdown().await;
}

#[tokio::test]
async fn an_unsettled_compaction_holds_claims_and_promotion() {
    let engine = engine().await;
    session(&engine, "ready", "ready", None).await;
    // Admitted just before the compaction was asked for, so it is a pending start.
    enqueue(&engine, "pending", false).await;
    engine.dispatch(command(json!({"type":"thread.compact", "commandId":"compact", "threadId":"t", "createdAt":TIME}))).await.unwrap();
    let manual = only_compaction(&engine).await;
    assert_eq!(manual.trigger, "manual");
    assert_eq!(manual.conversation_id.as_deref(), Some(CONVERSATION));
    assert_eq!(
        row(&engine, "pending").await.state,
        TurnDeliveryState::Pending
    );
    assert!(
        engine
            .repositories()
            .claim_provider_turn("pending".into(), TIME.into())
            .await
            .unwrap()
            .is_none(),
        "the claim refuses a compacting thread"
    );
    let (service, mut routes) = start_delivery(&engine);
    quiet(&mut routes).await;
    engine
        .mark_thread_compaction_unresolved(&manual.compaction_id, TIME)
        .await
        .unwrap();
    engine
        .start_thread_compaction(&manual.compaction_id, TIME)
        .await
        .unwrap();
    engine
        .mark_thread_compaction_unresolved(&manual.compaction_id, TIME)
        .await
        .unwrap();
    assert_eq!(only_compaction(&engine).await.state, "unresolved");
    engine.wake_turn_delivery();
    quiet(&mut routes).await;
    settle(&engine, &manual.compaction_id, "completed", None).await;
    received(&mut routes, "pending").await;
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn automatic_promotion_waits_for_the_compaction() {
    let engine = engine().await;
    session(&engine, "running", "running", Some("turn-1")).await;
    enqueue(&engine, "queued", true).await;
    session(&engine, "ready", "ready", None).await;
    let (service, mut routes) = start_delivery(&engine);
    received(&mut routes, "queued").await;
    service.shutdown().await;
    engine.shutdown().await;

    let engine = self::engine().await;
    session(&engine, "running", "running", Some("turn-1")).await;
    enqueue(&engine, "queued", true).await;
    sql(&engine, "INSERT INTO thread_compactions (compaction_id, thread_id, trigger, state, provider_instance_id, provider_kind, created_at, updated_at) VALUES ('manual', 't', 'manual', 'running', 'claudeAgent', 'claudeAgent', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')").await;
    session(&engine, "ready", "ready", None).await;
    let (service, mut routes) = start_delivery(&engine);
    quiet(&mut routes).await;
    assert_eq!(
        row(&engine, "queued").await.state,
        TurnDeliveryState::Queued
    );
    settle(&engine, "manual", "completed", None).await;
    session(&engine, "ready", "ready-again", None).await;
    received(&mut routes, "queued").await;
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn manual_compaction_is_refused_when_it_cannot_run() {
    let compact = |id: &str| {
        command(json!({"type":"thread.compact", "commandId":id, "threadId":"t", "createdAt":TIME}))
    };

    let engine = engine().await;
    session(&engine, "running", "running", Some("turn-1")).await;
    assert!(engine.dispatch(compact("while-running")).await.is_err());
    session(&engine, "ready", "ready", None).await;
    engine.dispatch(compact("first")).await.unwrap();
    assert!(engine.dispatch(compact("while-compacting")).await.is_err());
    assert_eq!(compactions(&engine).await.len(), 1);
    engine.shutdown().await;

    let engine = self::engine().await;
    engine
        .repositories()
        .delete_provider_session_runtime("t".into())
        .await
        .unwrap();
    assert!(
        engine.dispatch(compact("no-conversation")).await.is_err(),
        "nothing saved to compact"
    );
    save_runtime(&engine, "cursor", CONVERSATION).await;
    engine.dispatch(command(json!({"type":"thread.meta.update", "commandId":"to-cursor", "threadId":"t", "modelSelection":{"instanceId":"cursor", "model":"auto"}}))).await.unwrap();
    assert!(engine.dispatch(compact("unsupported")).await.is_err());
    assert_eq!(compactions(&engine).await.len(), 0);
    engine.shutdown().await;
}

#[tokio::test]
async fn the_guard_compacts_a_near_full_conversation_before_delivering() {
    let engine = engine().await;
    session(
        &engine,
        "running",
        "previous-running",
        Some("previous-turn"),
    )
    .await;
    reading(&engine, "previous-reading", "previous-turn", near_full()).await;
    session(&engine, "ready", "previous-ready", None).await;
    enqueue(&engine, "next", false).await;
    let (service, mut routes) = start_delivery(&engine);
    timeout(Duration::from_secs(3), async {
        while compactions(&engine).await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the guard asks for a compaction");
    quiet(&mut routes).await;
    let guard = only_compaction(&engine).await;
    assert_eq!(guard.trigger, "guard");
    assert_eq!(guard.guarded_delivery_command_id.as_deref(), Some("next"));
    assert_eq!(guard.conversation_id.as_deref(), Some(CONVERSATION));
    assert_eq!(
        count(
            &engine,
            &format!(
                "SELECT COUNT(*) FROM orchestration_command_receipts WHERE command_id = '{}'",
                guard_command_id("next")
            )
        )
        .await,
        1
    );
    assert_eq!(
        row(&engine, "next").await.last_error.as_deref(),
        Some(GUARD_WAITING_DETAIL)
    );
    assert_eq!(row(&engine, "next").await.state, TurnDeliveryState::Pending);
    settle(&engine, &guard.compaction_id, "completed", None).await;
    received(&mut routes, "next").await;
    assert_eq!(
        compactions(&engine).await.len(),
        1,
        "one guard per delivery"
    );
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn a_failed_guard_still_delivers() {
    let engine = engine().await;
    session(
        &engine,
        "running",
        "previous-running",
        Some("previous-turn"),
    )
    .await;
    reading(&engine, "previous-reading", "previous-turn", near_full()).await;
    session(&engine, "ready", "previous-ready", None).await;
    enqueue(&engine, "next", false).await;
    let (service, mut routes) = start_delivery(&engine);
    timeout(Duration::from_secs(3), async {
        while compactions(&engine).await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let guard = only_compaction(&engine).await;
    settle(
        &engine,
        &guard.compaction_id,
        "failed",
        Some("Claude couldn't compact the conversation."),
    )
    .await;
    received(&mut routes, "next").await;
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn the_guard_delivers_directly_below_its_threshold_or_without_a_compaction_point() {
    let mut below = near_full();
    below["usedTokens"] = json!(900_000);
    let mut without_point = near_full();
    without_point
        .as_object_mut()
        .unwrap()
        .remove("autoCompactTokens");
    let mut switched_off = near_full();
    switched_off["compactsAutomatically"] = json!(false);
    for (case, reading_payload) in [
        ("below", below),
        ("no compaction point", without_point),
        ("auto-compact off", switched_off),
    ] {
        let engine = engine().await;
        session(
            &engine,
            "running",
            "previous-running",
            Some("previous-turn"),
        )
        .await;
        reading(
            &engine,
            "previous-reading",
            "previous-turn",
            reading_payload,
        )
        .await;
        session(&engine, "ready", "previous-ready", None).await;
        enqueue(&engine, "next", false).await;
        let (service, mut routes) = start_delivery(&engine);
        received(&mut routes, "next").await;
        assert_eq!(compactions(&engine).await.len(), 0, "{case}");
        service.shutdown().await;
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn the_guard_does_not_compact_again_before_an_ordinary_turn() {
    let engine = engine().await;
    session(
        &engine,
        "running",
        "previous-running",
        Some("previous-turn"),
    )
    .await;
    reading(&engine, "previous-reading", "previous-turn", near_full()).await;
    session(&engine, "ready", "previous-ready", None).await;
    sql(&engine, "INSERT INTO thread_compactions (compaction_id, thread_id, trigger, state, provider_instance_id, provider_kind, turn_id, created_at, updated_at) VALUES ('earlier', 't', 'manual', 'completed', 'claudeAgent', 'claudeAgent', 'compaction-turn', '2026-10-24T00:00:01Z', '2026-10-24T00:00:01Z')").await;
    enqueue(&engine, "next", false).await;
    let (service, mut routes) = start_delivery(&engine);
    received(&mut routes, "next").await;
    assert_eq!(compactions(&engine).await.len(), 1);
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn stopping_a_guard_fails_its_message_and_retry_sends_it_without_compacting() {
    let engine = engine().await;
    session(
        &engine,
        "running",
        "previous-running",
        Some("previous-turn"),
    )
    .await;
    reading(&engine, "previous-reading", "previous-turn", near_full()).await;
    session(&engine, "ready", "previous-ready", None).await;
    enqueue(&engine, "next", false).await;
    let (service, mut routes) = start_delivery(&engine);
    timeout(Duration::from_secs(3), async {
        while compactions(&engine).await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let guard = only_compaction(&engine).await;
    engine
        .start_thread_compaction(&guard.compaction_id, TIME)
        .await
        .unwrap();
    interrupt(&engine, "stop").await;
    settle(&engine, &guard.compaction_id, "completed", None).await;
    assert_eq!(only_compaction(&engine).await.state, "interrupted");
    let failed = row(&engine, "next").await;
    assert_eq!(failed.state, TurnDeliveryState::Failed);
    assert_eq!(
        failed.last_error.as_deref(),
        Some("Not sent: you stopped the conversation compaction. Retry sends it.")
    );
    quiet(&mut routes).await;
    engine.dispatch(command(json!({"type":"thread.turn-delivery.resolve", "commandId":"retry", "threadId":"t", "messageId":"next", "action":"retry", "createdAt":TIME}))).await.unwrap();
    received(&mut routes, "next").await;
    assert_eq!(
        compactions(&engine).await.len(),
        1,
        "Retry does not compact again"
    );
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn restart_settles_every_unsettled_compaction_as_interrupted() {
    let engine = engine().await;
    // A recovery still requested on this thread.
    delivered_turn(&engine, "failed", "turn-1", near_full()).await;
    enqueue(&engine, "queued", true).await;
    fail_at_limit(&engine, "failure", "turn-1", before_output()).await;
    // A guard and a manual compaction on threads of their own.
    for (thread, trigger, state, guarded) in [
        ("guarded", "guard", "running", Some("guarded-message")),
        ("manual", "manual", "unresolved", None),
    ] {
        engine.dispatch(command(json!({"type":"thread.create", "commandId":format!("create-{thread}"), "threadId":thread, "projectId":"p", "title":thread, "runtimeMode":"full-access", "modelSelection":{"instanceId":CLAUDE, "model":"claude-opus"}, "createdAt":TIME}))).await.unwrap();
        if let Some(message) = guarded {
            let start = command(
                json!({"type":"thread.turn.start", "commandId":message, "threadId":thread, "message":{"messageId":message, "role":"user", "text":"guarded", "attachments":[]}, "createdAt":TIME}),
            );
            engine
                .dispatch_with_admission(
                    start.clone(),
                    CommandAdmission {
                        payload_digest: canonical_command_digest(&start).unwrap(),
                        attachment_refs: Vec::new(),
                        provider_turn: Some(NewProviderTurnDelivery {
                            command_id: message.into(),
                            thread_id: thread.into(),
                            message_id: message.into(),
                            provider_instance_id: CLAUDE.into(),
                            provider_kind: CLAUDE.into(),
                            provider_session_id: None,
                            delivery_key: "guarded-key".into(),
                            payload: serde_json::to_value(&start).unwrap(),
                            state: TurnDeliveryState::Pending,
                            mode: TurnDeliveryMode::Start,
                            created_at: TIME.into(),
                        }),
                    },
                    || {},
                )
                .await
                .unwrap();
        }
        sql(&engine, &format!("INSERT INTO thread_compactions (compaction_id, thread_id, trigger, state, provider_instance_id, provider_kind, guarded_delivery_command_id, created_at, updated_at) VALUES ('{thread}-compaction', '{thread}', '{trigger}', '{state}', 'claudeAgent', 'claudeAgent', {}, '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')", guarded.map_or_else(|| "NULL".to_owned(), |id| format!("'{id}'")))).await;
    }

    crate::production::provider_runtime::reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();

    let rows = compactions(&engine).await;
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter().all(|row| row.state == "interrupted"),
        "{rows:?}"
    );
    assert_eq!(
        count(&engine, "SELECT COUNT(*) FROM provider_turn_outbox WHERE command_id LIKE 'server:context-resend:%'").await,
        0
    );
    let guarded = row(&engine, "guarded-message").await;
    assert_eq!(guarded.state, TurnDeliveryState::Failed);
    assert_eq!(
        guarded.last_error.as_deref(),
        Some("BiBCode restarted before the conversation was compacted. Retry sends it.")
    );
    assert!(row(&engine, "queued").await.held);
    let session = the_session(&engine).await;
    assert_eq!(
        session.last_error.as_deref(),
        Some(FAILURE),
        "the original error returns"
    );
    assert_eq!(session.last_error_class.as_deref(), Some("context_limit"));
    engine.shutdown().await;
}

#[tokio::test]
async fn a_start_admitted_while_a_compaction_is_unsettled_is_queued_whatever_it_asked() {
    let engine = engine().await;
    session(&engine, "ready", "ready", None).await;
    engine.dispatch(command(json!({"type":"thread.compact", "commandId":"compact", "threadId":"t", "createdAt":TIME}))).await.unwrap();
    // The RPC checked for a compaction before this one began, so it asks for a pending start;
    // the admission transaction still queues it, with no marker the compaction turn could take.
    enqueue(&engine, "late", false).await;
    let late = row(&engine, "late").await;
    assert_eq!(late.state, TurnDeliveryState::Queued);
    assert_eq!(late.payload["queued"], true);
    assert_eq!(
        count(
            &engine,
            "SELECT COUNT(*) FROM projection_turns WHERE pending_message_id = 'late'"
        )
        .await,
        0
    );
    assert_eq!(
        count(&engine, "SELECT COUNT(*) FROM orchestration_events WHERE event_type = 'thread.turn-start-requested' AND json_extract(payload_json, '$.messageId') = 'late'").await,
        0
    );
    assert_eq!(
        count(&engine, "SELECT COUNT(*) FROM projection_thread_messages WHERE message_id = 'late' AND delivery_state = 'queued'").await,
        1
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn send_now_waits_for_an_unsettled_compaction() {
    let engine = engine().await;
    session(&engine, "running", "running", Some("turn-1")).await;
    enqueue(&engine, "queued", true).await;
    session(&engine, "error", "error", None).await;
    sql(&engine, "INSERT INTO thread_compactions (compaction_id, thread_id, trigger, state, provider_instance_id, provider_kind, created_at, updated_at) VALUES ('recovery', 't', 'contextRecovery', 'requested', 'claudeAgent', 'claudeAgent', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')").await;
    let send_now = |id: &str| {
        command(
            json!({"type":"thread.turn.promote", "commandId":id, "threadId":"t", "messageId":"queued", "createdAt":TIME}),
        )
    };
    assert!(
        engine.dispatch(send_now("send-now")).await.is_err(),
        "Send now cannot put a message ahead of the copy"
    );
    assert_eq!(
        row(&engine, "queued").await.state,
        TurnDeliveryState::Queued
    );
    settle(
        &engine,
        "recovery",
        "failed",
        Some("Claude couldn't compact the conversation."),
    )
    .await;
    engine.dispatch(send_now("send-now-after")).await.unwrap();
    assert_eq!(
        row(&engine, "queued").await.state,
        TurnDeliveryState::Pending
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn an_untagged_turn_during_a_compaction_keeps_the_guarded_marker() {
    let engine = engine().await;
    enqueue(&engine, "guarded", false).await;
    sql(&engine, "INSERT INTO thread_compactions (compaction_id, thread_id, trigger, state, provider_instance_id, provider_kind, guarded_delivery_command_id, created_at, updated_at) VALUES ('guard', 't', 'guard', 'running', 'claudeAgent', 'claudeAgent', 'guarded', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')").await;
    let markers = "SELECT COUNT(*) FROM projection_turns WHERE thread_id = 't' AND turn_id IS NULL AND pending_message_id = 'guarded'";
    // A turn the provider starts on its own (a background follow-up) while the compaction is
    // unsettled, reported twice: neither update binds or deletes the waiting marker.
    session(&engine, "running", "follow-up-running", Some("follow-up")).await;
    session(
        &engine,
        "running",
        "follow-up-running-again",
        Some("follow-up"),
    )
    .await;
    assert_eq!(count(&engine, markers).await, 1);
    assert_eq!(
        count(&engine, "SELECT COUNT(*) FROM projection_turns WHERE turn_id = 'follow-up' AND pending_message_id IS NULL").await,
        1
    );
    session(&engine, "ready", "follow-up-ready", None).await;
    settle(&engine, "guard", "completed", None).await;
    session(&engine, "running", "guarded-running", Some("guarded-turn")).await;
    assert_eq!(count(&engine, markers).await, 0);
    assert_eq!(
        count(&engine, "SELECT COUNT(*) FROM projection_turns WHERE turn_id = 'guarded-turn' AND pending_message_id = 'guarded'").await,
        1
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn a_failed_manual_compaction_keeps_the_compact_action_of_a_context_limit_error() {
    let engine = engine().await;
    session(&engine, "running", "running", Some("turn-1")).await;
    engine.dispatch(command(json!({"type":"thread.session.set", "commandId":"limit", "threadId":"t", "session":{"threadId":"t", "status":"error", "providerName":CLAUDE, "providerInstanceId":CLAUDE, "activeTurnId":null, "lastError":FAILURE, "lastErrorClass":"context_limit", "updatedAt":TIME}, "createdAt":TIME}))).await.unwrap();
    engine.dispatch(command(json!({"type":"thread.compact", "commandId":"compact", "threadId":"t", "createdAt":TIME}))).await.unwrap();
    let manual = only_compaction(&engine).await;
    // The compaction's own turn runs and ends ("Not enough messages to compact."), which
    // clears the session's error before the compaction settles.
    engine.dispatch(command(json!({"type":"thread.session.set", "commandId":"compaction-running", "threadId":"t", "session":{"threadId":"t", "status":"running", "providerName":CLAUDE, "providerInstanceId":CLAUDE, "activeTurnId":"compaction-turn", "lastError":null, "updatedAt":TIME}, "compactionId":manual.compaction_id, "createdAt":TIME}))).await.unwrap();
    session(&engine, "ready", "compaction-ready", None).await;
    settle(
        &engine,
        &manual.compaction_id,
        "failed",
        Some("Claude couldn't compact the conversation."),
    )
    .await;
    let failed = the_session(&engine).await;
    assert_eq!(
        failed.last_error.as_deref(),
        Some("Claude couldn't compact the conversation.")
    );
    assert_eq!(
        failed.last_error_class.as_deref(),
        Some("context_limit"),
        "the Compact action stays, so the user can try again"
    );
    engine.shutdown().await;

    // A compaction asked for outside a context-limit error fails as a provider error.
    let engine = self::engine().await;
    session(&engine, "ready", "ready", None).await;
    engine.dispatch(command(json!({"type":"thread.compact", "commandId":"compact", "threadId":"t", "createdAt":TIME}))).await.unwrap();
    let manual = only_compaction(&engine).await;
    settle(
        &engine,
        &manual.compaction_id,
        "failed",
        Some("Claude couldn't compact the conversation."),
    )
    .await;
    assert_eq!(
        the_session(&engine).await.last_error_class.as_deref(),
        Some("provider_error")
    );
    engine.shutdown().await;
}
