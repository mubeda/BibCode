//! The thread fields the left panel's agent status reads (#187): the pending-question count,
//! request expiry when a session leaves `running`, and the provider-progress timestamp.

use serde_json::{Value, json};

use super::{EngineOptions, OrchestrationCommand, OrchestrationEngine};
use crate::orchestration::StartupProcessOwnership;
use crate::persistence::{Database, ProjectionThread, run_migrations};
use crate::provider::RequestScope;

const AT: &str = "2026-10-27T10:00:00.000Z";

async fn engine() -> (OrchestrationEngine, String) {
    let database = Database::open_in_memory().await.expect("database");
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .expect("migrations");
    let engine = OrchestrationEngine::start(database, EngineOptions::default())
        .await
        .expect("engine");
    engine
        .dispatch(command(json!({
            "type":"project.create", "commandId":"project", "projectId":"status-project",
            "title":"Project", "workspaceRoot":"C:/repo", "defaultModelSelection":null,
            "createdAt":AT
        })))
        .await
        .expect("project");
    let thread_id = engine
        .repositories()
        .list_threads_by_project("status-project".to_owned())
        .await
        .expect("threads")
        .into_iter()
        .find(|thread| thread.kind == "default")
        .expect("default thread")
        .thread_id;
    (engine, thread_id)
}

fn command(value: Value) -> OrchestrationCommand {
    serde_json::from_value(value).expect("command")
}

/// Dispatches a provider-attributed activity, as `project_provider_event` does.
async fn activity(engine: &OrchestrationEngine, thread_id: &str, kind: &str, payload: Value) {
    let id = uuid::Uuid::new_v4().to_string();
    engine
        .dispatch(command(json!({
            "type":"thread.activity.append", "commandId":format!("provider:{id}"),
            "threadId":thread_id, "createdAt":AT,
            "activity":{
                "id":id, "tone":"approval", "kind":kind, "summary":kind,
                "payload":payload, "turnId":"turn-1", "createdAt":AT
            }
        })))
        .await
        .expect("activity");
}

async fn session(engine: &OrchestrationEngine, thread_id: &str, status: &str, at: &str) {
    session_as(engine, thread_id, status, at, "codex").await;
}

async fn session_as(
    engine: &OrchestrationEngine,
    thread_id: &str,
    status: &str,
    at: &str,
    provider: &str,
) {
    engine
        .dispatch(command(json!({
            "type":"thread.session.set",
            "commandId":format!("provider-session:{}", uuid::Uuid::new_v4()),
            "threadId":thread_id, "createdAt":at,
            "session":{
                "threadId":thread_id, "status":status, "providerName":provider,
                "runtimeMode":"approval-required",
                "activeTurnId": if status == "running" { json!("turn-1") } else { Value::Null },
                "lastError":null, "updatedAt":at
            }
        })))
        .await
        .expect("session");
}

async fn thread(engine: &OrchestrationEngine, thread_id: &str) -> ProjectionThread {
    engine
        .repositories()
        .get_thread(thread_id.to_owned())
        .await
        .expect("thread")
        .expect("thread exists")
}

async fn activity_kinds(engine: &OrchestrationEngine, thread_id: &str) -> Vec<String> {
    let thread_id = thread_id.to_owned();
    engine
        .repositories()
        .database()
        .call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT kind FROM projection_thread_activities WHERE thread_id = ? ORDER BY sequence",
            )?;
            let kinds = statement
                .query_map([thread_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(kinds)
        })
        .await
        .expect("activities")
}

#[tokio::test]
async fn pending_question_count_follows_each_request_state() {
    let (engine, thread_id) = engine().await;
    session(&engine, &thread_id, "running", AT).await;
    activity(
        &engine,
        &thread_id,
        "user-input.requested",
        json!({"requestId":"q1","questions":[]}),
    )
    .await;
    assert_eq!(
        thread(&engine, &thread_id).await.pending_user_input_count,
        1
    );

    // A refused answer the provider does not call stale keeps the question open.
    activity(
        &engine,
        &thread_id,
        "provider.user-input.respond.failed",
        json!({"requestId":"q1","detail":"transport closed"}),
    )
    .await;
    assert_eq!(
        thread(&engine, &thread_id).await.pending_user_input_count,
        1
    );
    activity(
        &engine,
        &thread_id,
        "provider.user-input.respond.failed",
        json!({"requestId":"q1","detail":"Unknown pending user-input request q1"}),
    )
    .await;
    assert_eq!(
        thread(&engine, &thread_id).await.pending_user_input_count,
        0
    );

    activity(
        &engine,
        &thread_id,
        "user-input.requested",
        json!({"requestId":"q2","questions":[]}),
    )
    .await;
    activity(
        &engine,
        &thread_id,
        "user-input.resolved",
        json!({"requestId":"q2"}),
    )
    .await;
    assert_eq!(
        thread(&engine, &thread_id).await.pending_user_input_count,
        0
    );
}

#[tokio::test]
async fn pending_question_count_is_not_recounted_on_streamed_text() {
    let (engine, thread_id) = engine().await;
    session(&engine, &thread_id, "running", AT).await;
    let id = thread_id.clone();
    // A count only a recount would change: streamed text must leave it as it is.
    engine
        .repositories()
        .database()
        .call(move |connection| {
            connection.execute(
                "UPDATE projection_threads SET pending_user_input_count = 7 WHERE thread_id = ?",
                [id],
            )?;
            Ok(())
        })
        .await
        .expect("seed count");
    engine
        .dispatch(command(json!({
            "type":"thread.message.assistant.delta", "commandId":"provider:delta",
            "threadId":thread_id, "messageId":"m1", "delta":"Hello", "turnId":"turn-1",
            "createdAt":AT
        })))
        .await
        .expect("delta");
    assert_eq!(
        thread(&engine, &thread_id).await.pending_user_input_count,
        7
    );
}

#[tokio::test]
async fn a_stale_refused_approval_settles_while_the_session_runs() {
    let (engine, thread_id) = engine().await;
    session(&engine, &thread_id, "running", AT).await;
    activity(
        &engine,
        &thread_id,
        "approval.requested",
        json!({"requestId":"a1","requestKind":"command"}),
    )
    .await;
    assert_eq!(thread(&engine, &thread_id).await.pending_approval_count, 1);
    activity(
        &engine,
        &thread_id,
        "provider.approval.respond.failed",
        json!({"requestId":"a1","detail":"Stale pending approval request a1"}),
    )
    .await;
    let settled = thread(&engine, &thread_id).await;
    assert_eq!(settled.pending_approval_count, 0);
    assert_eq!(
        engine
            .repositories()
            .get_pending_approval("a1".to_owned())
            .await
            .expect("approval")
            .expect("row")
            .status,
        "resolved"
    );
}

#[tokio::test]
async fn leaving_running_expires_open_requests_once_and_a_new_ask_reopens_them() {
    let (engine, thread_id) = engine().await;
    session(&engine, &thread_id, "running", AT).await;
    activity(
        &engine,
        &thread_id,
        "approval.requested",
        json!({"requestId":"a1","requestKind":"command"}),
    )
    .await;
    activity(
        &engine,
        &thread_id,
        "user-input.requested",
        json!({"requestId":"q1","questions":[]}),
    )
    .await;

    // `starting` keeps the turn's requests.
    session(&engine, &thread_id, "starting", AT).await;
    let open = thread(&engine, &thread_id).await;
    assert_eq!(
        (open.pending_approval_count, open.pending_user_input_count),
        (1, 1)
    );

    for status in ["interrupted", "ready"] {
        session(&engine, &thread_id, status, "2026-10-27T10:05:00.000Z").await;
        let settled = thread(&engine, &thread_id).await;
        assert_eq!(
            (
                settled.pending_approval_count,
                settled.pending_user_input_count
            ),
            (0, 0),
            "{status} ends the turn's requests"
        );
    }
    let kinds = activity_kinds(&engine, &thread_id).await;
    assert_eq!(
        kinds
            .iter()
            .filter(|kind| kind.ends_with(".expired"))
            .collect::<Vec<_>>(),
        ["approval.expired", "user-input.expired"],
        "each open request expires once, not again on a repeated status"
    );
    assert_eq!(
        engine
            .repositories()
            .get_pending_approval("a1".to_owned())
            .await
            .expect("approval")
            .expect("row")
            .status,
        "expired"
    );
    // OpenCode lists an expired ask again on resume; it is shown again.
    assert!(
        !engine
            .repositories()
            .request_is_recorded(thread_id.clone(), "a1".to_owned())
            .await
            .expect("recorded")
    );

    activity(
        &engine,
        &thread_id,
        "approval.requested",
        json!({"requestId":"a1","requestKind":"command"}),
    )
    .await;
    activity(
        &engine,
        &thread_id,
        "user-input.requested",
        json!({"requestId":"q1","questions":[]}),
    )
    .await;
    let reopened = thread(&engine, &thread_id).await;
    assert_eq!(
        (
            reopened.pending_approval_count,
            reopened.pending_user_input_count
        ),
        (1, 1)
    );
    assert!(
        engine
            .repositories()
            .request_is_recorded(thread_id.clone(), "a1".to_owned())
            .await
            .expect("recorded")
    );
}

#[tokio::test]
async fn an_error_session_expires_requests_and_holds_the_queue_as_before() {
    let (engine, thread_id) = engine().await;
    session(&engine, &thread_id, "running", AT).await;
    activity(
        &engine,
        &thread_id,
        "approval.requested",
        json!({"requestId":"a1","requestKind":"command"}),
    )
    .await;
    session(&engine, &thread_id, "error", "2026-10-27T10:05:00.000Z").await;
    assert_eq!(thread(&engine, &thread_id).await.pending_approval_count, 0);
    assert!(
        activity_kinds(&engine, &thread_id)
            .await
            .contains(&"approval.expired".to_owned())
    );
}

#[tokio::test]
async fn last_activity_moves_only_on_provider_progress() {
    let (engine, thread_id) = engine().await;
    assert_eq!(thread(&engine, &thread_id).await.last_activity_at, None);

    session(&engine, &thread_id, "running", "2026-10-27T10:01:00.000Z").await;
    assert_eq!(
        thread(&engine, &thread_id)
            .await
            .last_activity_at
            .as_deref(),
        Some("2026-10-27T10:01:00.000Z")
    );

    engine
        .dispatch(command(json!({
            "type":"thread.message.assistant.delta", "commandId":"provider:delta",
            "threadId":thread_id, "messageId":"m1", "delta":"Hello", "turnId":"turn-1",
            "createdAt":"2026-10-27T10:02:00.000Z"
        })))
        .await
        .expect("delta");
    let after_delta = thread(&engine, &thread_id).await.last_activity_at;
    assert!(after_delta.is_some());
    assert_ne!(after_delta.as_deref(), Some("2026-10-27T10:01:00.000Z"));

    // A title edit and the session settling are not provider progress.
    engine
        .dispatch(command(json!({
            "type":"thread.meta.update", "commandId":"client-rename",
            "threadId":thread_id, "title":"Renamed"
        })))
        .await
        .expect("rename");
    session(&engine, &thread_id, "ready", "2026-10-27T11:00:00.000Z").await;
    assert_eq!(
        thread(&engine, &thread_id).await.last_activity_at,
        after_delta
    );
}

async fn open_requests(engine: &OrchestrationEngine, thread_id: &str) -> (i64, i64) {
    let row = thread(engine, thread_id).await;
    (row.pending_approval_count, row.pending_user_input_count)
}

async fn ask_both(engine: &OrchestrationEngine, thread_id: &str) {
    activity(
        engine,
        thread_id,
        "approval.requested",
        json!({"requestId":"a1","requestKind":"command"}),
    )
    .await;
    activity(
        engine,
        thread_id,
        "user-input.requested",
        json!({"requestId":"q1","questions":[]}),
    )
    .await;
}

#[tokio::test]
async fn startup_expires_the_requests_no_live_session_holds_once() {
    let (engine, settled) = engine().await;
    session(&engine, &settled, "ready", AT).await;
    ask_both(&engine, &settled).await;
    engine
        .dispatch(command(json!({
            "type":"thread.create", "commandId":"live-thread", "threadId":"live",
            "projectId":"status-project", "title":"Live",
            "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "runtimeMode":"full-access", "interactionMode":"default",
            "branch":null, "worktreePath":null, "createdAt":AT
        })))
        .await
        .expect("live thread");
    session(&engine, "live", "running", AT).await;
    activity(
        &engine,
        "live",
        "user-input.requested",
        json!({"requestId":"live-q","questions":[]}),
    )
    .await;

    assert_eq!(
        engine
            .expire_requests_of_settled_sessions(&StartupProcessOwnership::default())
            .await
            .unwrap(),
        2
    );
    assert_eq!(open_requests(&engine, &settled).await, (0, 0));
    assert_eq!(
        open_requests(&engine, "live").await,
        (0, 1),
        "a running session's question is left to its provider"
    );
    assert_eq!(
        engine
            .expire_requests_of_settled_sessions(&StartupProcessOwnership::default())
            .await
            .unwrap(),
        0,
        "a second startup expires nothing again"
    );
}

#[tokio::test]
async fn startup_expires_the_same_provider_question_id_on_two_settled_threads() {
    let (engine, first) = engine().await;
    let second = "second-thread";
    engine
        .dispatch(command(json!({
            "type":"thread.create", "commandId":"second-thread", "threadId":second,
            "projectId":"status-project", "title":"Second",
            "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "runtimeMode":"full-access", "interactionMode":"default",
            "branch":null, "worktreePath":null, "createdAt":AT
        })))
        .await
        .expect("second thread");

    for thread_id in [&first[..], second] {
        session(&engine, thread_id, "ready", AT).await;
        activity(
            &engine,
            thread_id,
            "user-input.requested",
            json!({"requestId":"user-input:1","questions":[]}),
        )
        .await;
        assert_eq!(open_requests(&engine, thread_id).await, (0, 1));
    }
    engine
        .repositories()
        .database()
        .call(|connection| {
            connection.execute(
                "INSERT INTO orchestration_command_receipts
                 (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
                 VALUES ('queued-command', 'thread', 'second-thread', ?, 9999, 'accepted')",
                [AT],
            )?;
            connection.execute(
                "INSERT INTO provider_turn_outbox
                 (command_id, thread_id, message_id, provider_instance_id, provider_kind,
                  delivery_key, payload_json, state, created_at, updated_at)
                 VALUES ('queued-command', 'second-thread', 'queued-message', 'codex', 'codex',
                  'queued-key', '{}', 'queued', ?, ?)",
                [AT, AT],
            )?;
            Ok(())
        })
        .await
        .expect("queued follow-up");
    assert!(
        !engine
            .repositories()
            .can_promote_queued_provider_turn(second.to_owned(), "queued-message".to_owned(), true)
            .await
            .expect("question holds queue")
    );

    assert_eq!(
        engine
            .expire_requests_of_settled_sessions(&StartupProcessOwnership::default())
            .await
            .expect("startup expiry"),
        2
    );
    for thread_id in [&first[..], second] {
        assert_eq!(open_requests(&engine, thread_id).await, (0, 0));
        assert_eq!(
            activity_kinds(&engine, thread_id)
                .await
                .iter()
                .filter(|kind| kind.as_str() == "user-input.expired")
                .count(),
            1
        );
    }
    assert!(
        engine
            .repositories()
            .can_promote_queued_provider_turn(second.to_owned(), "queued-message".to_owned(), true)
            .await
            .expect("expired question releases queue")
    );
    assert_eq!(
        engine
            .expire_requests_of_settled_sessions(&StartupProcessOwnership::default())
            .await
            .expect("repeated startup"),
        0
    );
}

#[tokio::test]
async fn startup_expires_a_new_question_that_reuses_the_same_provider_id() {
    let (engine, thread_id) = engine().await;
    session(&engine, &thread_id, "ready", AT).await;
    for occurrence in 1..=2 {
        activity(
            &engine,
            &thread_id,
            "user-input.requested",
            json!({"requestId":"user-input:1","questions":[]}),
        )
        .await;
        assert_eq!(open_requests(&engine, &thread_id).await, (0, 1));
        assert_eq!(
            engine
                .expire_requests_of_settled_sessions(&StartupProcessOwnership::default())
                .await
                .expect("startup expiry"),
            1
        );
        assert_eq!(open_requests(&engine, &thread_id).await, (0, 0));
        assert_eq!(
            activity_kinds(&engine, &thread_id)
                .await
                .iter()
                .filter(|kind| kind.as_str() == "user-input.expired")
                .count(),
            occurrence
        );
    }
    assert_eq!(
        engine
            .expire_requests_of_settled_sessions(&StartupProcessOwnership::default())
            .await
            .expect("repeated startup"),
        0
    );
}

#[tokio::test]
async fn startup_repairs_an_open_question_after_a_legacy_expiry_receipt() {
    let (engine, first) = engine().await;
    session(&engine, &first, "ready", AT).await;
    activity(
        &engine,
        &first,
        "user-input.requested",
        json!({"requestId":"user-input:1","questions":[]}),
    )
    .await;
    engine
        .dispatch(command(json!({
            "type":"thread.activity.append",
            "commandId":"server:startup-expiry:user-input.expired:user-input:1",
            "threadId":first, "createdAt":AT,
            "activity":{
                "id":"user-input.expired:user-input:1:startup",
                "tone":"approval", "kind":"user-input.expired",
                "summary":"Question expired",
                "payload":{"requestId":"user-input:1","reason":"session-ended"},
                "turnId":null, "createdAt":AT
            }
        })))
        .await
        .expect("legacy accepted expiry");
    assert_eq!(open_requests(&engine, &first).await, (0, 0));

    let second = "legacy-second";
    engine
        .dispatch(command(json!({
            "type":"thread.create", "commandId":"legacy-second", "threadId":second,
            "projectId":"status-project", "title":"Second",
            "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "runtimeMode":"full-access", "interactionMode":"default",
            "branch":null, "worktreePath":null, "createdAt":AT
        })))
        .await
        .expect("second thread");
    session(&engine, second, "ready", AT).await;
    activity(
        &engine,
        second,
        "user-input.requested",
        json!({"requestId":"user-input:1","questions":[]}),
    )
    .await;
    assert_eq!(open_requests(&engine, second).await, (0, 1));
    assert_eq!(
        engine
            .expire_requests_of_settled_sessions(&StartupProcessOwnership::default())
            .await
            .expect("new startup expiry"),
        1
    );
    assert_eq!(open_requests(&engine, second).await, (0, 0));
    assert_eq!(
        activity_kinds(&engine, second)
            .await
            .iter()
            .filter(|kind| kind.as_str() == "user-input.expired")
            .count(),
        1
    );
}

#[tokio::test]
async fn startup_expires_a_legacy_pending_approval_without_an_ask_activity() {
    let (engine, thread_id) = engine().await;
    session(&engine, &thread_id, "ready", AT).await;
    let row_thread = thread_id.clone();
    engine
        .repositories()
        .database()
        .call(move |connection| {
            connection.execute(
                "INSERT INTO projection_pending_approvals
                 (request_id, thread_id, turn_id, status, decision, created_at, resolved_at)
                 VALUES ('approval:legacy', ?, NULL, 'pending', NULL, ?, NULL)",
                rusqlite::params![&row_thread, AT],
            )?;
            connection.execute(
                "UPDATE projection_threads SET pending_approval_count = 1 WHERE thread_id = ?",
                [&row_thread],
            )?;
            Ok(())
        })
        .await
        .expect("legacy pending approval");
    assert_eq!(open_requests(&engine, &thread_id).await, (1, 0));
    assert_eq!(
        engine
            .expire_requests_of_settled_sessions(&StartupProcessOwnership::default())
            .await
            .expect("startup expiry"),
        1
    );
    assert_eq!(open_requests(&engine, &thread_id).await, (0, 0));
    assert_eq!(
        engine
            .repositories()
            .get_pending_approval("approval:legacy".to_owned())
            .await
            .expect("approval")
            .expect("row")
            .status,
        "expired"
    );
}

#[tokio::test]
async fn two_scoped_approval_requests_keep_independent_pending_rows() {
    let (engine, first) = engine().await;
    let second = "approval-second";
    engine
        .dispatch(command(json!({
            "type":"thread.create", "commandId":"approval-second", "threadId":second,
            "projectId":"status-project", "title":"Second",
            "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "runtimeMode":"approval-required", "interactionMode":"default",
            "branch":null, "worktreePath":null, "createdAt":AT
        })))
        .await
        .expect("second thread");
    let first_id = RequestScope::new().approval_id("1");
    let second_id = RequestScope::new().approval_id("1");
    assert_ne!(first_id, second_id);
    for (thread_id, request_id) in [(&first[..], &first_id), (second, &second_id)] {
        session(&engine, thread_id, "running", AT).await;
        activity(
            &engine,
            thread_id,
            "approval.requested",
            json!({"requestId":request_id,"requestKind":"command"}),
        )
        .await;
        assert_eq!(open_requests(&engine, thread_id).await, (1, 0));
        let row = engine
            .repositories()
            .get_pending_approval(request_id.clone())
            .await
            .expect("approval")
            .expect("row");
        assert_eq!(row.thread_id, thread_id);
    }

    activity(
        &engine,
        &first,
        "approval.resolved",
        json!({"requestId":first_id,"decision":"accept"}),
    )
    .await;
    assert_eq!(open_requests(&engine, &first).await, (0, 0));
    assert_eq!(open_requests(&engine, second).await, (1, 0));
    assert_eq!(
        engine
            .repositories()
            .get_pending_approval(second_id)
            .await
            .expect("second approval")
            .expect("row")
            .status,
        "pending"
    );
}

#[tokio::test]
async fn a_turn_the_provider_completed_keeps_the_requests_it_left_open() {
    let (engine, thread_id) = engine().await;
    session(&engine, &thread_id, "running", AT).await;
    ask_both(&engine, &thread_id).await;
    session(&engine, &thread_id, "ready", AT).await;
    assert_eq!(open_requests(&engine, &thread_id).await, (1, 1));
}

#[tokio::test]
async fn stopping_a_turn_expires_its_requests() {
    let (engine, thread_id) = engine().await;
    session(&engine, &thread_id, "running", AT).await;
    ask_both(&engine, &thread_id).await;
    engine
        .dispatch(command(json!({
            "type":"thread.turn.interrupt", "commandId":"stop",
            "threadId":thread_id, "createdAt":AT
        })))
        .await
        .expect("interrupt");
    assert_eq!(open_requests(&engine, &thread_id).await, (0, 0));
}

#[tokio::test]
async fn a_settled_session_settling_again_or_relaunching_expires_nothing() {
    let (engine, thread_id) = engine().await;
    session(&engine, &thread_id, "running", AT).await;
    session(&engine, &thread_id, "ready", AT).await;
    // An ask OpenCode shows again on resume, while the session is not running.
    ask_both(&engine, &thread_id).await;
    for status in ["ready", "error", "stopped", "starting", "ready"] {
        session(&engine, &thread_id, status, AT).await;
        assert_eq!(
            open_requests(&engine, &thread_id).await,
            (1, 1),
            "{status} after a settled session ends no turn"
        );
    }
    assert!(
        !activity_kinds(&engine, &thread_id)
            .await
            .iter()
            .any(|kind| kind.ends_with(".expired"))
    );
}

#[tokio::test]
async fn an_opencode_session_ending_keeps_its_asks_until_the_user_stops_it() {
    // Mutation caught: expiring an OpenCode ask because its BiBCode session ended, while the
    // OpenCode server that holds it can still take its answer after a resume (#187).
    let (engine, thread_id) = engine().await;
    session_as(&engine, &thread_id, "running", AT, "opencode").await;
    ask_both(&engine, &thread_id).await;
    for status in ["error", "interrupted", "idle", "stopped"] {
        session_as(&engine, &thread_id, "running", AT, "opencode").await;
        session_as(&engine, &thread_id, status, AT, "opencode").await;
        assert_eq!(
            open_requests(&engine, &thread_id).await,
            (1, 1),
            "an OpenCode session ending {status} keeps its asks"
        );
    }
    engine
        .dispatch(command(json!({
            "type":"thread.session.stop", "commandId":"user-stop",
            "threadId":thread_id, "createdAt":AT
        })))
        .await
        .expect("stop");
    assert_eq!(
        open_requests(&engine, &thread_id).await,
        (0, 0),
        "the user stopping the session ends its asks"
    );
}

#[tokio::test]
async fn a_restart_keeps_opencode_asks_until_a_completed_read_drops_them() {
    // Mutation caught: the startup pass, or a failed resume read, hiding an ask the OpenCode
    // server that survived BiBCode's restart still holds (#187).
    let (engine, thread_id) = engine().await;
    session_as(&engine, &thread_id, "running", AT, "opencode").await;
    ask_both(&engine, &thread_id).await;
    // BiBCode restarts: reconciliation settles the abandoned session, then startup expiry runs.
    // Settings point OpenCode at a server the user runs, which survived the restart.
    session_as(&engine, &thread_id, "error", AT, "opencode").await;
    let user_server = StartupProcessOwnership::new([], ["opencode".to_owned()]);
    assert_eq!(
        engine
            .expire_requests_of_settled_sessions(&user_server)
            .await
            .unwrap(),
        0
    );
    assert_eq!(open_requests(&engine, &thread_id).await, (1, 1));

    // The resume's completed read still lists the question, not the approval.
    let listed = std::collections::HashSet::from(["q1".to_owned()]);
    assert_eq!(
        engine
            .expire_requests_unlisted_by_provider(&thread_id, &listed, "read-1")
            .await
            .unwrap(),
        1
    );
    assert_eq!(open_requests(&engine, &thread_id).await, (0, 1));
    assert!(
        activity_kinds(&engine, &thread_id)
            .await
            .contains(&"approval.expired".to_owned())
    );

    // An ask OpenCode shows again reopens.
    activity(
        &engine,
        &thread_id,
        "approval.requested",
        json!({"requestId":"a1","requestKind":"command","recovered":true}),
    )
    .await;
    assert_eq!(open_requests(&engine, &thread_id).await, (1, 1));
}

/// One ownership rule decides what a restart closes and what it expires (#206, #187): an OpenCode
/// thread whose server BiBCode ran (a row from before the owner was recorded, with no server URL
/// configured) has both its open subagent and its open requests settled; one on a server the
/// user runs keeps both.
#[tokio::test]
async fn a_restart_settles_or_keeps_an_opencode_threads_requests_and_subagents_together() {
    use crate::activity::{
        ActivityCapabilities, ActivityLifecycle, ActivityProjection, ActivityRepository,
        ActivityScopeRef, ActivityScopeSeed, ProviderActivityMutation,
    };
    for user_server_configured in [false, true] {
        let (engine, thread_id) = engine().await;
        session_as(&engine, &thread_id, "running", AT, "opencode").await;
        ask_both(&engine, &thread_id).await;
        let activity = ActivityProjection::new(ActivityRepository::new(
            engine.repositories().database().clone(),
        ));
        let scope_id = format!("thread:{thread_id}");
        activity
            .ensure_scope(
                ActivityScopeSeed::thread(
                    &scope_id,
                    &thread_id,
                    "opencode",
                    Some("opencode"),
                    ActivityCapabilities::structured_full(false),
                )
                .expect("scope"),
            )
            .await
            .expect("scope");
        activity
            .apply(
                &scope_id,
                "open-subagent".to_owned(),
                vec![
                    ProviderActivityMutation::upsert_actor("actor:sub", None, "Sub", "running")
                        .expect("actor"),
                ],
                AT.to_owned(),
            )
            .await
            .expect("open subagent");
        // A runtime row a build before #206 wrote: no recorded owner.
        let legacy_payload = json!({ "transport": "http" });
        let ownership = StartupProcessOwnership::new(
            [(thread_id.as_str(), Some("opencode"), Some(&legacy_payload))],
            user_server_configured.then(|| "opencode".to_owned()),
        );

        // The restart: close what ended, settle the session, expire what nobody holds.
        crate::production::provider_runtime::interrupt_activity_of_ended_sessions(
            &ownership, &activity,
        )
        .await;
        session_as(&engine, &thread_id, "error", AT, "opencode").await;
        engine
            .expire_requests_of_settled_sessions(&ownership)
            .await
            .expect("startup expiry");

        let subagent = activity
            .snapshot(&ScopeRef::thread(&thread_id))
            .await
            .expect("snapshot")
            .actors[0]
            .status;
        if user_server_configured {
            assert_eq!(subagent, ActivityLifecycle::Running);
            assert_eq!(open_requests(&engine, &thread_id).await, (1, 1));
        } else {
            assert_eq!(subagent, ActivityLifecycle::Interrupted);
            assert_eq!(open_requests(&engine, &thread_id).await, (0, 0));
        }
    }

    struct ScopeRef;
    impl ScopeRef {
        fn thread(thread_id: &str) -> ActivityScopeRef {
            ActivityScopeRef::Thread {
                thread_id: thread_id.to_owned(),
            }
        }
    }
}
