use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    auth::Principal,
    mcp::control::McpAccess,
    persistence::Database,
    production::{mcp_tools_tests::Harness, orchestration_rpc::ServerActor},
    rpc::{RpcRegistry, RpcSessionContext},
    send_requests::{
        rpc::register_send_requests_rpc,
        service::{
            ANSWER_TEXT_MAX_CHARS, RequestChange, SendRequestAttachment, SendRequestsSendInput,
            SendRequestsService, compose_message_text, require_person,
        },
        store::{SendAction, SendRequestRow, SendRequestStore, SendState, StateChange},
    },
    transfer::staging::UploadOwner,
};

async fn migrated(database: Database) -> SendRequestStore {
    database
        .call(|connection| {
            crate::persistence::run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .unwrap();
    SendRequestStore::new(database)
}

async fn store() -> SendRequestStore {
    migrated(Database::open_in_memory().await.unwrap()).await
}

fn row(request_id: &str, source_thread_id: &str, created_at: &str) -> SendRequestRow {
    SendRequestRow {
        request_id: request_id.to_owned(),
        project_id: "p1".to_owned(),
        source_address: format!("thread:{source_thread_id}"),
        source_thread_id: source_thread_id.to_owned(),
        action: SendAction::Review,
        target_address: "thread:target".to_owned(),
        target_thread_id: "target".to_owned(),
        taken_over_address: None,
        args_digest: "digest".to_owned(),
        note_chars: 4,
        attachment_chars: 0,
        target_message_id: Some(format!("person-send:{request_id}")),
        command_id: Some(format!("person-send:{request_id}")),
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        answering_turn_id: None,
        answer_message_id: None,
        answer_text: None,
        answer_truncated: false,
        terminal_generation: None,
        state: SendState::Queued,
        reason: None,
        created_at: created_at.to_owned(),
        updated_at: created_at.to_owned(),
        dismissed_at: None,
    }
}

fn change(to: SendState) -> StateChange {
    StateChange {
        to,
        reason: None,
        answering_turn_id: None,
        answer_message_id: None,
        answer_text: None,
        answer_truncated: false,
        dismiss: false,
        at: "2026-11-13T01:00:00Z".to_owned(),
    }
}

async fn insert(store: &SendRequestStore, row: SendRequestRow) -> SendRequestRow {
    let (stored, created) = store.insert_if_absent(row).await.unwrap();
    assert!(created, "a fresh request id is created");
    stored
}

async fn set_state(store: &SendRequestStore, request_id: &str, state: SendState) {
    let from = [
        SendState::Queued,
        SendState::Waiting,
        SendState::Delivered,
        SendState::Read,
    ];
    store
        .transition(request_id, &from, change(state))
        .await
        .unwrap()
        .expect("an open request moves");
}

#[tokio::test]
async fn store_a_request_is_stored_once_per_request_id() {
    let store = store().await;
    let first = insert(&store, row("r1", "a", "2026-11-13T00:00:00Z")).await;
    let mut other = row("r1", "b", "2026-11-13T00:05:00Z");
    other.action = SendAction::Message;
    other.args_digest = "other".to_owned();

    let (stored, created) = store.insert_if_absent(other).await.unwrap();

    assert!(!created, "a repeated request id creates nothing");
    assert_eq!(stored, first, "the first row is kept and returned");
}

#[tokio::test]
async fn store_a_state_changes_only_from_an_allowed_state() {
    let store = store().await;
    insert(&store, row("r1", "a", "2026-11-13T00:00:00Z")).await;
    set_state(&store, "r1", SendState::Cancelled).await;
    let before = store.get("r1").await.unwrap();

    let moved = store
        .transition("r1", &[SendState::Queued], change(SendState::Read))
        .await
        .unwrap();

    assert_eq!(moved, None, "a cancelled request is not queued");
    assert_eq!(
        store.get("r1").await.unwrap(),
        before,
        "nothing was written"
    );
}

#[tokio::test]
async fn store_a_final_state_is_never_overwritten_by_a_late_event() {
    let store = store().await;
    insert(&store, row("r1", "a", "2026-11-13T00:00:00Z")).await;
    set_state(&store, "r1", SendState::Answered).await;

    let moved = store
        .transition(
            "r1",
            &[
                SendState::Queued,
                SendState::Waiting,
                SendState::Delivered,
                SendState::Read,
            ],
            change(SendState::NotAnswered),
        )
        .await
        .unwrap();

    assert_eq!(moved, None);
    assert_eq!(
        store.get("r1").await.unwrap().unwrap().state,
        SendState::Answered
    );
}

#[tokio::test]
async fn store_only_a_final_request_can_be_dismissed_by_a_person() {
    let store = store().await;
    insert(&store, row("open", "a", "2026-11-13T00:00:00Z")).await;
    insert(&store, row("done", "a", "2026-11-13T00:00:01Z")).await;
    set_state(&store, "done", SendState::NotAnswered).await;

    assert_eq!(
        store.dismiss("open", "2026-11-13T02:00:00Z").await.unwrap(),
        None,
        "a queued request is not final"
    );
    assert_eq!(store.get("open").await.unwrap().unwrap().dismissed_at, None);
    let dismissed = store
        .dismiss("done", "2026-11-13T02:00:00Z")
        .await
        .unwrap()
        .expect("a final request is dismissed");
    assert_eq!(
        dismissed.dismissed_at.as_deref(),
        Some("2026-11-13T02:00:00Z")
    );
    assert_eq!(dismissed.updated_at, "2026-11-13T02:00:00Z");
    assert_eq!(
        store
            .dismiss("missing", "2026-11-13T02:00:00Z")
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn store_a_transition_can_dismiss_a_non_final_request() {
    let store = store().await;
    insert(&store, row("r1", "a", "2026-11-13T00:00:00Z")).await;
    let mut read = change(SendState::Read);
    read.dismiss = true;

    let moved = store
        .transition("r1", &[SendState::Queued], read)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(moved.state, SendState::Read);
    assert_eq!(moved.dismissed_at.as_deref(), Some("2026-11-13T01:00:00Z"));
    assert!(store.list_undismissed(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn store_keeps_an_answer_text_and_its_truncation_flag() {
    let store = store().await;
    insert(&store, row("r1", "a", "2026-11-13T00:00:00Z")).await;
    let mut answered = change(SendState::Answered);
    answered.answering_turn_id = Some("turn-1".to_owned());
    answered.answer_message_id = Some("message-1".to_owned());
    answered.answer_text = Some("The answer.".to_owned());
    answered.answer_truncated = true;

    store
        .transition("r1", &[SendState::Queued], answered)
        .await
        .unwrap()
        .unwrap();

    let stored = store.get("r1").await.unwrap().unwrap();
    assert_eq!(stored.state, SendState::Answered);
    assert_eq!(stored.answering_turn_id.as_deref(), Some("turn-1"));
    assert_eq!(stored.answer_message_id.as_deref(), Some("message-1"));
    assert_eq!(stored.answer_text.as_deref(), Some("The answer."));
    assert!(stored.answer_truncated);
}

#[tokio::test]
async fn store_lists_undismissed_by_source_thread_newest_first() {
    let store = store().await;
    insert(&store, row("old", "a", "2026-11-13T00:00:00Z")).await;
    insert(&store, row("new", "a", "2026-11-13T00:00:02Z")).await;
    insert(&store, row("other", "b", "2026-11-13T00:00:01Z")).await;
    insert(&store, row("gone", "a", "2026-11-13T00:00:03Z")).await;
    set_state(&store, "gone", SendState::Cancelled).await;
    store
        .dismiss("gone", "2026-11-13T00:00:04Z")
        .await
        .unwrap()
        .unwrap();

    let ids = |rows: Vec<SendRequestRow>| {
        rows.into_iter()
            .map(|row| row.request_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids(store.list_undismissed(Some("a")).await.unwrap()),
        ["new", "old"]
    );
    assert_eq!(
        ids(store.list_undismissed(None).await.unwrap()),
        ["new", "other", "old"]
    );
}

#[tokio::test]
async fn store_lists_every_undismissed_request_without_a_cap() {
    let store = store().await;
    for index in 0..450 {
        insert(
            &store,
            row(
                &format!("r{index:03}"),
                "a",
                &format!("2026-11-13T00:{:02}:{:02}Z", index / 60, index % 60),
            ),
        )
        .await;
    }

    let rows = store.list_undismissed(Some("a")).await.unwrap();

    assert_eq!(rows.len(), 450);
    assert_eq!(rows[0].request_id, "r449");
    assert_eq!(rows[449].request_id, "r000");
}

#[tokio::test]
async fn store_deleting_a_source_thread_removes_only_its_requests() {
    let store = store().await;
    insert(&store, row("a1", "a", "2026-11-13T00:00:00Z")).await;
    insert(&store, row("a2", "a", "2026-11-13T00:00:01Z")).await;
    insert(&store, row("b1", "b", "2026-11-13T00:00:02Z")).await;

    let mut removed = store.delete_for_source_thread("a").await.unwrap();
    removed.sort();

    assert_eq!(removed, ["a1", "a2"]);
    assert_eq!(store.get("a1").await.unwrap(), None);
    assert!(store.get("b1").await.unwrap().is_some());
}

#[tokio::test]
async fn store_an_open_request_survives_reopening_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let database = Database::create_new(&path).await.unwrap();
    let store = migrated(database.clone()).await;
    insert(&store, row("open", "a", "2026-11-13T00:00:00Z")).await;
    insert(&store, row("done", "a", "2026-11-13T00:00:01Z")).await;
    set_state(&store, "done", SendState::Answered).await;
    database.checkpoint_wal().await.unwrap();
    drop(store);
    database.close().await;

    let reopened = migrated(Database::open_existing(&path).await.unwrap()).await;
    let open = reopened.list_open().await.unwrap();

    assert_eq!(
        open.iter()
            .map(|row| row.request_id.as_str())
            .collect::<Vec<_>>(),
        ["open"]
    );
    assert_eq!(open[0].state, SendState::Queued);
}

const AT: &str = "2026-10-30T00:00:00.000Z";

fn input(request_id: &str, action: &str, source: &str, target: &str) -> SendRequestsSendInput {
    SendRequestsSendInput {
        request_id: request_id.to_owned(),
        action: action.to_owned(),
        source: source.to_owned(),
        target: target.to_owned(),
        taken_over: None,
        lead_in: "Please review the work below.".to_owned(),
        note: "Look at the parser.".to_owned(),
        attachments: Vec::new(),
    }
}

fn person() -> RpcSessionContext {
    RpcSessionContext::unauthenticated()
}

async fn harness() -> Harness {
    let harness = Harness::new().await;
    harness.send_request_threads().await;
    harness
}

async fn dispatch(harness: &Harness, value: Value) {
    harness
        .engine
        .dispatch(serde_json::from_value(value).expect("command decodes"))
        .await
        .expect("dispatched");
}

async fn session(harness: &Harness, thread_id: &str, status: &str) {
    dispatch(
        harness,
        json!({
            "type": "thread.session.set",
            "commandId": format!("session-{thread_id}-{status}-{}", uuid::Uuid::new_v4()),
            "threadId": thread_id,
            "session": {
                "threadId": thread_id, "status": status, "providerName": "codex",
                "providerInstanceId": "codex", "runtimeMode": "full-access",
                "activeTurnId": if status == "running" { Some("turn-running") } else { None },
                "lastError": null, "updatedAt": AT,
            },
            "createdAt": AT,
        }),
    )
    .await;
}

async fn ask(harness: &Harness, thread_id: &str, kind: &str) {
    dispatch(
        harness,
        json!({
            "type": "thread.activity.append", "commandId": format!("ask-{kind}"),
            "threadId": thread_id,
            "activity": {
                "id": format!("ask-{kind}"), "tone": "approval", "kind": kind,
                "summary": "request", "payload": { "requestId": "request-open" },
                "turnId": null, "createdAt": AT,
            },
            "createdAt": AT,
        }),
    )
    .await;
}

async fn count(harness: &Harness, sql: &'static str) -> i64 {
    harness
        .repositories
        .database()
        .call(move |connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .await
        .unwrap()
}

/// The outbox row of a message: `(state, held)`.
async fn outbox(harness: &Harness, message_id: &str) -> Option<(String, bool)> {
    use rusqlite::OptionalExtension as _;
    let message_id = message_id.to_owned();
    harness
        .repositories
        .database()
        .call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT state, held FROM provider_turn_outbox WHERE message_id = ?",
                    [message_id],
                    |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
                )
                .optional()?)
        })
        .await
        .unwrap()
}

/// A stored message: `(thread_id, text, person_send_json, actor_json, source_thread_id)`.
type Message = (
    String,
    String,
    Option<Value>,
    Option<String>,
    Option<String>,
);

async fn message(harness: &Harness, message_id: &str) -> Option<Message> {
    use rusqlite::OptionalExtension as _;
    let message_id = message_id.to_owned();
    harness
        .repositories
        .database()
        .call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT thread_id, text, person_send_json, actor_json, source_thread_id \
                     FROM projection_thread_messages WHERE message_id = ?",
                    [message_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get::<_, Option<String>>(2)?
                                .map(|json| serde_json::from_str(&json).expect("person send json")),
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()?)
        })
        .await
        .unwrap()
}

/// How many requests, outbox rows and person-send messages exist.
async fn stored(harness: &Harness) -> (i64, i64, i64) {
    (
        count(harness, "SELECT COUNT(*) FROM send_requests").await,
        count(harness, "SELECT COUNT(*) FROM provider_turn_outbox").await,
        count(
            harness,
            "SELECT COUNT(*) FROM projection_thread_messages WHERE message_id LIKE 'person-send:%'",
        )
        .await,
    )
}

async fn refused(
    harness: &Harness,
    context: &RpcSessionContext,
    input: SendRequestsSendInput,
) -> String {
    let error = harness
        .send_requests()
        .send(context, input)
        .await
        .expect_err("the send is refused");
    assert_eq!(error["_tag"], "SendRequestError", "{error}");
    error["reason"].as_str().unwrap_or_default().to_owned()
}

async fn send_ok(harness: &Harness, input: SendRequestsSendInput) {
    let id = input.request_id.clone();
    harness
        .send_requests()
        .send(&person(), input)
        .await
        .unwrap_or_else(|error| panic!("{id} is accepted: {error}"));
}

async fn outbox_state(harness: &Harness, message_id: &str) -> Option<String> {
    outbox(harness, message_id).await.map(|row| row.0)
}

#[tokio::test]
async fn send_an_idle_target_starts_a_turn_with_the_note_and_the_attachment() {
    let harness = harness().await;
    let mut request = input("r1", "review", "thread:a", "thread:b");
    request.attachments = vec![SendRequestAttachment {
        label: "Diff".to_owned(),
        text: "+ a changed line".to_owned(),
    }];

    let sent = harness
        .send_requests()
        .send(&person(), request)
        .await
        .expect("the send is accepted");

    assert_eq!(sent.state, "queued");
    assert_eq!(sent.target_message_id.as_deref(), Some("person-send:r1"));
    let (thread_id, text, person_send, _, _) = message(&harness, "person-send:r1")
        .await
        .expect("the message is stored");
    assert_eq!(thread_id, "b");
    assert_eq!(
        text,
        "Please review the work below.\n\nLook at the parser.\n\n=== Diff ===\n+ a changed line"
    );
    assert_eq!(
        text,
        compose_message_text(
            "Please review the work below.",
            "Look at the parser.",
            &[("Diff".to_owned(), "+ a changed line".to_owned())]
        )
    );
    assert_eq!(
        person_send,
        Some(json!({ "requestId": "r1", "action": "review", "sourceAddress": "thread:a" }))
    );
    let state = outbox_state(&harness, "person-send:r1")
        .await
        .expect("an outbox row");
    assert_ne!(state, "queued", "an idle target starts the turn");
    harness.shutdown().await;
}

#[tokio::test]
async fn send_a_busy_target_queues_behind_the_running_turn() {
    let harness = harness().await;
    session(&harness, "b", "running").await;

    send_ok(&harness, input("r1", "review", "thread:a", "thread:b")).await;

    assert_eq!(
        outbox_state(&harness, "person-send:r1").await.as_deref(),
        Some("queued")
    );
    harness.shutdown().await;
}

async fn queued_behind_an_ask(kind: &str) {
    let harness = harness().await;
    session(&harness, "b", "running").await;
    ask(&harness, "b", kind).await;
    session(&harness, "b", "ready").await;

    send_ok(
        &harness,
        input("r1", "second-opinion", "thread:a", "thread:b"),
    )
    .await;

    assert_eq!(
        outbox_state(&harness, "person-send:r1").await.as_deref(),
        Some("queued"),
        "the session is ready but the {kind} holds the request"
    );
    let open = if kind == "approval.requested" {
        count(
            &harness,
            "SELECT COUNT(*) FROM projection_pending_approvals WHERE thread_id = 'b' AND status = 'pending'",
        )
        .await
    } else {
        count(
            &harness,
            "SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = 'b' AND kind = 'user-input.requested'",
        )
        .await
    };
    assert_eq!(open, 1, "the {kind} stays open");
    let answered = count(
        &harness,
        "SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = 'b' AND kind IN ('approval.resolved', 'user-input.resolved')",
    )
    .await;
    assert_eq!(answered, 0, "nothing answers the {kind}");
    harness.shutdown().await;
}

#[tokio::test]
async fn send_to_a_ready_target_with_a_pending_approval_queues_and_is_not_its_answer() {
    queued_behind_an_ask("approval.requested").await;
}

#[tokio::test]
async fn send_to_a_ready_target_with_a_pending_question_queues_and_is_not_its_answer() {
    queued_behind_an_ask("user-input.requested").await;
}

#[tokio::test]
async fn send_to_a_target_whose_last_turn_errored_is_queued_and_not_started() {
    let harness = harness().await;
    session(&harness, "b", "running").await;
    session(&harness, "b", "error").await;

    send_ok(&harness, input("r1", "review", "thread:a", "thread:b")).await;

    assert_eq!(
        outbox_state(&harness, "person-send:r1").await.as_deref(),
        Some("queued")
    );
    assert_eq!(
        count(
            &harness,
            "SELECT COUNT(*) FROM orchestration_events WHERE event_type = 'thread.turn-start-requested' AND stream_id = 'b'",
        )
        .await,
        0,
        "no turn starts"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn send_to_a_target_with_a_held_queue_is_queued_behind_it() {
    let harness = harness().await;
    session(&harness, "b", "running").await;
    send_ok(&harness, input("first", "review", "thread:a", "thread:b")).await;
    harness
        .repositories
        .database()
        .call(|connection| {
            connection.execute("UPDATE provider_turn_outbox SET held = 1", [])?;
            Ok(())
        })
        .await
        .unwrap();
    session(&harness, "b", "ready").await;

    send_ok(&harness, input("second", "review", "thread:a", "thread:b")).await;

    assert_eq!(
        outbox(&harness, "person-send:second").await,
        Some(("queued".to_owned(), false))
    );
    assert_eq!(
        outbox(&harness, "person-send:first").await,
        Some(("queued".to_owned(), true)),
        "the held head stays held"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn send_ignores_the_agent_messaging_rules() {
    // Target `b` is full-access, source `a` approval-required, and messaging is off.
    let harness = harness().await;

    send_ok(&harness, input("r1", "message", "thread:a", "thread:b")).await;

    let (_, _, _, actor, source_thread_id) =
        message(&harness, "person-send:r1").await.expect("stored");
    assert_eq!(actor, None, "a person's message has no actor");
    assert_eq!(source_thread_id, None);
    harness.shutdown().await;
}

#[tokio::test]
async fn send_across_worktrees_of_one_project_is_accepted_and_attributed() {
    let harness = harness().await;

    let sent = harness
        .send_requests()
        .send(&person(), input("r1", "hand-off", "thread:b", "thread:a"))
        .await
        .expect("accepted");

    assert_eq!(
        (sent.source.as_str(), sent.target.as_str()),
        ("thread:b", "thread:a")
    );
    assert_eq!(sent.project_id, "p1");
    let (thread_id, _, person_send, _, _) =
        message(&harness, "person-send:r1").await.expect("stored");
    assert_eq!(thread_id, "a");
    assert_eq!(person_send.unwrap()["sourceAddress"], "thread:b");
    harness.shutdown().await;
}

#[tokio::test]
async fn send_refuses_another_project_for_source_target_and_taken_over() {
    let harness = harness().await;
    let mut taken_over = input("r3", "take-over", "thread:a", "thread:a");
    taken_over.taken_over = Some("thread:c".to_owned());
    for request in [
        input("r1", "review", "thread:c", "thread:a"),
        input("r2", "review", "thread:a", "thread:c"),
        taken_over,
    ] {
        let id = request.request_id.clone();
        assert_eq!(
            refused(&harness, &person(), request).await,
            "other_project",
            "{id}"
        );
    }
    assert_eq!(stored(&harness).await, (0, 0, 0), "nothing is kept");
    harness.shutdown().await;
}

#[tokio::test]
async fn send_refuses_an_unknown_target_and_keeps_nothing() {
    let harness = harness().await;
    dispatch(
        &harness,
        json!({
            "type": "thread.create", "commandId": "create-gone", "threadId": "gone",
            "projectId": "p1", "title": "gone",
            "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "full-access", "interactionMode": "default", "branch": null,
            "worktreePath": null, "createdAt": AT,
        }),
    )
    .await;
    dispatch(
        &harness,
        json!({ "type": "thread.delete", "commandId": "delete-gone", "threadId": "gone" }),
    )
    .await;
    for target in ["thread:missing", "thread:gone"] {
        assert_eq!(
            refused(
                &harness,
                &person(),
                input("r1", "review", "thread:a", target)
            )
            .await,
            "unknown_thread",
            "{target}"
        );
    }
    assert_eq!(stored(&harness).await, (0, 0, 0));
    harness.shutdown().await;
}

#[tokio::test]
async fn send_refuses_a_terminal_target_until_it_can_be_notified() {
    let harness = harness().await;
    assert_eq!(
        refused(
            &harness,
            &person(),
            input("r1", "review", "thread:a", "terminal:b/term-1")
        )
        .await,
        "target_not_notifiable"
    );
    assert_eq!(stored(&harness).await, (0, 0, 0));
    harness.shutdown().await;
}

#[tokio::test]
async fn send_refuses_a_note_and_attachments_over_48000_characters() {
    let harness = harness().await;
    // A non-BMP character is one scalar value and two UTF-16 units.
    let wide = |count: usize| "\u{1F600}".repeat(count);
    let mut at_limit = input("fits", "review", "thread:a", "thread:b");
    at_limit.note = wide(40_000);
    at_limit.attachments = vec![SendRequestAttachment {
        label: "Log".to_owned(),
        text: wide(8_000),
    }];
    send_ok(&harness, at_limit.clone()).await;
    let mut over = at_limit;
    over.request_id = "over".to_owned();
    over.attachments[0].text = wide(8_001);
    assert_eq!(refused(&harness, &person(), over).await, "too_long");
    let mut lead_in = input("lead-in", "review", "thread:a", "thread:b");
    lead_in.lead_in = "x".repeat(16_001);
    assert_eq!(refused(&harness, &person(), lead_in).await, "too_long");
    assert_eq!(
        stored(&harness).await.0,
        1,
        "only the request that fits is kept"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn send_take_over_stores_the_taken_over_address_and_labels_the_message_from_it() {
    let harness = harness().await;
    let mut request = input("r1", "take-over", "thread:b", "thread:b");
    request.taken_over = Some("thread:a".to_owned());

    let sent = harness
        .send_requests()
        .send(&person(), request)
        .await
        .expect("accepted");

    assert_eq!(sent.taken_over.as_deref(), Some("thread:a"));
    let (thread_id, _, person_send, _, _) =
        message(&harness, "person-send:r1").await.expect("stored");
    assert_eq!(thread_id, "b", "queued on the agent that takes over");
    assert_eq!(person_send.unwrap()["sourceAddress"], "thread:a");
    assert_eq!(
        count(
            &harness,
            "SELECT COUNT(*) FROM provider_turn_outbox WHERE thread_id = 'a'"
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &harness,
            "SELECT COUNT(*) FROM orchestration_events WHERE stream_id = 'a' AND command_id LIKE 'person-send:%'",
        )
        .await,
        0,
        "thread a gets no event"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn send_take_over_refuses_a_missing_or_self_taken_over_thread() {
    let harness = harness().await;
    let missing = input("r1", "take-over", "thread:b", "thread:b");
    let mut itself = input("r2", "take-over", "thread:b", "thread:b");
    itself.taken_over = Some("thread:b".to_owned());
    let mut elsewhere = input("r3", "take-over", "thread:b", "thread:a");
    elsewhere.taken_over = Some("thread:a".to_owned());
    let mut not_a_take_over = input("r4", "review", "thread:b", "thread:a");
    not_a_take_over.taken_over = Some("thread:a".to_owned());
    for request in [missing, itself, elsewhere, not_a_take_over] {
        let id = request.request_id.clone();
        assert_eq!(
            refused(&harness, &person(), request).await,
            "invalid",
            "{id}"
        );
    }
    assert_eq!(stored(&harness).await, (0, 0, 0));
    harness.shutdown().await;
}

#[tokio::test]
async fn send_refuses_an_outside_agent_session() {
    let harness = harness().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    assert!(
        agent
            .principal
            .scopes
            .iter()
            .any(|scope| scope == "orchestration:operate"),
        "an outside agent holds the method's scope: {:?}",
        agent.principal.scopes
    );
    let context = RpcSessionContext::authenticated(agent.principal.clone(), harness.auth.clone());
    let mut registry = RpcRegistry::empty();
    register_send_requests_rpc(&mut registry, harness.send_requests());

    let error = registry
        .invoke_local(
            "sendRequests.send",
            serde_json::to_value(input("r1", "review", "thread:a", "thread:b")).unwrap(),
            context.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("an outside agent is refused");

    assert_eq!(error["_tag"], "SendRequestError");
    assert_eq!(error["reason"], "person_only");
    assert_eq!(
        require_person(&context).unwrap_err()["reason"],
        "person_only"
    );
    assert_eq!(stored(&harness).await, (0, 0, 0), "nothing is stored");
    harness.shutdown().await;
}

#[tokio::test]
async fn send_accepts_a_paired_person_session_and_an_unauthenticated_server() {
    let harness = harness().await;
    let mut registry = RpcRegistry::empty();
    register_send_requests_rpc(&mut registry, harness.send_requests());
    let paired = |subject: &str| {
        RpcSessionContext::authenticated(
            Principal {
                session_id: format!("session-{subject}"),
                subject: subject.to_owned(),
                method: "test".to_owned(),
                scopes: vec!["*".to_owned()],
                proof_key_thumbprint: None,
                expires_at_ms: i64::MAX,
            },
            harness.auth.clone(),
        )
    };
    // A paired session's principal is not a live auth session here, so the registry would
    // refuse it before the handler; the operation itself sees the principal.
    for (request_id, context) in [
        ("desktop", paired("desktop-bootstrap")),
        ("paired", paired("one-time-token")),
    ] {
        let sent = harness
            .send_requests()
            .send(
                &context,
                input(request_id, "review", "thread:a", "thread:b"),
            )
            .await
            .unwrap_or_else(|error| panic!("{request_id}: {error}"));
        assert_eq!(
            (sent.request_id.as_str(), sent.state),
            (request_id, "queued")
        );
    }
    let sent = registry
        .invoke_local(
            "sendRequests.send",
            serde_json::to_value(input("open", "review", "thread:a", "thread:b")).unwrap(),
            RpcSessionContext::unauthenticated(),
            CancellationToken::new(),
        )
        .await
        .unwrap_or_else(|error| panic!("open: {error}"));
    assert_eq!(sent["requestId"], "open");
    assert_eq!(sent["state"], "queued");
    harness.shutdown().await;
}

#[tokio::test]
async fn send_over_public_dispatch_is_refused() {
    let harness = harness().await;
    let error = harness
        .control
        .registry()
        .invoke_local(
            "orchestration.dispatchCommand",
            json!({
                "type": "thread.turn.start", "commandId": "person-send:forged", "threadId": "b",
                "message": {
                    "messageId": "person-send:forged", "role": "user", "text": "forged",
                    "attachments": [],
                    "personSend": { "requestId": "forged", "action": "review", "sourceAddress": "thread:a" },
                },
                "runtimeMode": "full-access", "interactionMode": "default", "createdAt": AT,
            }),
            person(),
            CancellationToken::new(),
        )
        .await
        .expect_err("public dispatch refuses personSend");
    assert!(
        error["message"].as_str().is_some_and(
            |message| message.contains("person-send requires a dedicated server-resolved RPC")
        ),
        "{error}"
    );
    assert_eq!(stored(&harness).await, (0, 0, 0));
    harness.shutdown().await;
}

#[tokio::test]
async fn send_dispatcher_refuses_person_send_for_a_hosted_agent_actor() {
    let harness = harness().await;
    let command = serde_json::from_value(json!({
        "type": "thread.turn.start", "commandId": "person-send:hosted", "threadId": "b",
        "message": {
            "messageId": "person-send:hosted", "role": "user", "text": "from an agent",
            "attachments": [],
            "personSend": { "requestId": "hosted", "action": "review", "sourceAddress": "thread:a" },
        },
        "runtimeMode": "full-access", "interactionMode": "default", "queued": true, "createdAt": AT,
    }))
    .unwrap();

    let error = (harness.server_dispatcher())(
        command,
        UploadOwner::from_context(&person()),
        ServerActor::HostedAgent {
            address: "thread:a".to_owned(),
            label: "Agent a".to_owned(),
        },
    )
    .await
    .expect_err("a hosted agent cannot carry personSend");

    assert_eq!(error["_tag"], "InvalidRequest", "{error}");
    assert_eq!(stored(&harness).await, (0, 0, 0));
    harness.shutdown().await;
}

/// Admits a person's `thread.turn.start` on `b` exactly as a send that passed the RPC-layer
/// check would reach the engine: a pending delivery and `queued` resolved to false. That is
/// what the race produces when the blocker appears after the RPC-layer check.
async fn admit_as_resolved_to_start(harness: &Harness, request_id: &str) {
    use crate::orchestration::{
        CommandAdmission, NewProviderTurnDelivery, OrchestrationCommand, TurnDeliveryMode,
        TurnDeliveryState, canonical_command_digest,
    };
    let message_id = format!("person-send:{request_id}");
    let command: OrchestrationCommand = serde_json::from_value(json!({
        "type": "thread.turn.start", "commandId": message_id, "threadId": "b",
        "message": {
            "messageId": message_id, "role": "user", "text": "Please review", "attachments": [],
            "personSend": { "requestId": request_id, "action": "review", "sourceAddress": "thread:a" },
        },
        "runtimeMode": "full-access", "interactionMode": "default", "queued": false,
        "createdAt": AT,
    }))
    .unwrap();
    let admission = CommandAdmission {
        payload_digest: canonical_command_digest(&command).unwrap(),
        attachment_refs: Vec::new(),
        provider_turn: Some(NewProviderTurnDelivery {
            state: TurnDeliveryState::Pending,
            mode: TurnDeliveryMode::Start,
            command_id: message_id.clone(),
            thread_id: "b".to_owned(),
            message_id: message_id.clone(),
            provider_instance_id: "codex".to_owned(),
            provider_kind: "codex".to_owned(),
            provider_session_id: None,
            delivery_key: uuid::Uuid::new_v4().to_string(),
            payload: serde_json::to_value(&command).unwrap(),
            created_at: AT.to_owned(),
        }),
    };
    harness
        .engine
        .dispatch_with_admission(command, admission, || {})
        .await
        .expect("admitted");
}

async fn assert_admitted_but_queued(harness: &Harness, message_id: &str) {
    assert_eq!(
        outbox_state(harness, message_id).await.as_deref(),
        Some("queued"),
        "the engine's admission rechecks the blocker"
    );
    assert_eq!(
        count(
            harness,
            "SELECT COUNT(*) FROM orchestration_events WHERE event_type = 'thread.turn-start-requested' AND stream_id = 'b'",
        )
        .await,
        0,
        "no turn starts"
    );
    let payload = harness
        .repositories
        .database()
        .call({
            let message_id = message_id.to_owned();
            move |connection| {
                Ok(connection.query_row(
                    "SELECT payload_json FROM provider_turn_outbox WHERE message_id = ?",
                    [message_id],
                    |row| row.get::<_, String>(0),
                )?)
            }
        })
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&payload).unwrap()["queued"],
        true,
        "the stored payload agrees with the outbox state"
    );
}

#[tokio::test]
async fn send_an_error_that_appears_before_admission_still_queues_the_request() {
    let harness = harness().await;
    session(&harness, "b", "running").await;
    session(&harness, "b", "error").await;

    admit_as_resolved_to_start(&harness, "raced").await;

    assert_admitted_but_queued(&harness, "person-send:raced").await;
    harness.shutdown().await;
}

#[tokio::test]
async fn send_an_approval_that_appears_before_admission_still_queues_the_request() {
    let harness = harness().await;
    session(&harness, "b", "running").await;
    ask(&harness, "b", "approval.requested").await;
    session(&harness, "b", "ready").await;

    admit_as_resolved_to_start(&harness, "raced").await;

    assert_admitted_but_queued(&harness, "person-send:raced").await;
    harness.shutdown().await;
}

#[tokio::test]
async fn send_a_malformed_input_is_refused_without_quoting_it() {
    let harness = harness().await;
    let mut registry = RpcRegistry::empty();
    register_send_requests_rpc(&mut registry, harness.send_requests());
    let mut malformed = serde_json::to_value(input("r1", "review", "thread:a", "thread:b")).unwrap();
    malformed["attachments"] = json!(["private marker text"]);

    let error = registry
        .invoke_local(
            "sendRequests.send",
            malformed,
            person(),
            CancellationToken::new(),
        )
        .await
        .expect_err("a malformed input is refused");

    assert_eq!(error["reason"], "invalid", "{error}");
    assert!(
        !error.to_string().contains("private marker text"),
        "the refusal quotes no input: {error}"
    );
    harness.shutdown().await;
}

// Request states from turn events (task 1.3).

/// A harness whose send requests service runs its follower.
async fn followed() -> (Harness, SendRequestsService, CancellationToken) {
    let harness = harness().await;
    let service = harness.send_requests();
    let stop = CancellationToken::new();
    service.start_follower(harness.engine.clone(), stop.clone());
    (harness, service, stop)
}

async fn request(harness: &Harness, request_id: &str) -> SendRequestRow {
    SendRequestStore::new(harness.repositories.database().clone())
        .get(request_id)
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("{request_id} is stored"))
}

/// Waits until the stored request passes `check`, reading it again after each change.
async fn until(
    harness: &Harness,
    service: &SendRequestsService,
    request_id: &str,
    check: impl Fn(&SendRequestRow) -> bool,
) -> SendRequestRow {
    let mut changes = service.subscribe_changes();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let row = request(harness, request_id).await;
        if check(&row) {
            return row;
        }
        if tokio::time::timeout_at(deadline, changes.recv())
            .await
            .is_err()
        {
            panic!(
                "{request_id} never reached the expected state: {:?} {:?}",
                row.state, row.reason
            );
        }
    }
}

async fn until_state(
    harness: &Harness,
    service: &SendRequestsService,
    request_id: &str,
    state: SendState,
) -> SendRequestRow {
    until(harness, service, request_id, |row| row.state == state).await
}

async fn send_with(service: &SendRequestsService, input: SendRequestsSendInput) {
    let id = input.request_id.clone();
    service
        .send(&person(), input)
        .await
        .unwrap_or_else(|error| panic!("{id} is accepted: {error}"));
}

/// The target's session: `running` on `turn_id`, or another status.
async fn turn_session(harness: &Harness, thread_id: &str, turn_id: &str, status: &str) {
    dispatch(
        harness,
        json!({
            "type": "thread.session.set",
            "commandId": format!("turn-session-{thread_id}-{turn_id}-{status}"),
            "threadId": thread_id,
            "session": {
                "threadId": thread_id, "status": status, "providerName": "codex",
                "providerInstanceId": "codex", "runtimeMode": "full-access",
                "activeTurnId": if status == "running" { Some(turn_id) } else { None },
                "lastError": null, "updatedAt": AT,
            },
            "createdAt": AT,
        }),
    )
    .await;
}

/// A person's ordinary message on `thread_id`, which starts a turn of its own.
async fn user_message(harness: &Harness, thread_id: &str, message_id: &str) {
    dispatch(
        harness,
        json!({
            "type": "thread.turn.start", "commandId": format!("start-{message_id}"),
            "threadId": thread_id,
            "message": { "messageId": message_id, "role": "user", "text": "next", "attachments": [] },
            "runtimeMode": "full-access", "interactionMode": "default", "createdAt": AT,
        }),
    )
    .await;
}

async fn proposed_plan(harness: &Harness, turn_id: &str, markdown: &str) {
    dispatch(
        harness,
        json!({
            "type": "thread.proposed-plan.upsert", "commandId": format!("plan-{turn_id}"),
            "threadId": "b",
            "proposedPlan": {
                "id": format!("plan-{turn_id}"), "turnId": turn_id, "planMarkdown": markdown,
                "createdAt": AT, "updatedAt": AT,
            },
            "createdAt": AT,
        }),
    )
    .await;
}

#[tokio::test]
async fn state_read_when_the_target_turn_starts() {
    let (harness, service, stop) = followed().await;
    send_with(&service, input("r1", "review", "thread:a", "thread:b")).await;
    assert_eq!(request(&harness, "r1").await.state, SendState::Queued);

    harness.provider_turn("b", "t1", "Working", false).await;

    let row = until_state(&harness, &service, "r1", SendState::Read).await;
    assert_eq!(row.dismissed_at, None, "a review stays shown once read");
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn a_review_that_ends_as_a_plan_card_is_answered_with_the_plan() {
    let (harness, service, stop) = followed().await;
    send_with(&service, input("plan-only", "review", "thread:a", "thread:b")).await;
    turn_session(&harness, "b", "t1", "running").await;
    proposed_plan(&harness, "t1", "# Plan\n\n1. Fix the parser.").await;
    turn_session(&harness, "b", "t1", "ready").await;

    let row = until_state(&harness, &service, "plan-only", SendState::Answered).await;
    assert_eq!(row.answer_text.as_deref(), Some("# Plan\n\n1. Fix the parser."));
    assert_eq!(row.answer_message_id, None, "a plan has no message");
    assert_eq!(row.answering_turn_id.as_deref(), Some("t1"));

    send_with(&service, input("both", "review", "thread:a", "thread:b")).await;
    harness.provider_turn("b", "t2", "A summary", false).await;
    proposed_plan(&harness, "t2", "# Second plan").await;
    turn_session(&harness, "b", "t2", "ready").await;

    let row = until_state(&harness, &service, "both", SendState::Answered).await;
    assert_eq!(
        row.answer_text.as_deref(),
        Some("# Second plan"),
        "the plan wins over the message"
    );
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn state_the_right_answer() {
    let harness = harness().await;
    let service = harness.send_requests();
    send_with(&service, input("r1", "review", "thread:a", "thread:b")).await;
    harness.provider_turn("b", "t1", "R1", true).await;
    user_message(&harness, "b", "later-2").await;
    harness.provider_turn("b", "t2", "R2", true).await;
    user_message(&harness, "b", "later-3").await;
    harness.provider_turn("b", "t3", "R3", true).await;

    // The follower starts after all three turns, so it must find the request's own turn.
    let stop = CancellationToken::new();
    service.start_follower(harness.engine.clone(), stop.clone());
    let row = until_state(&harness, &service, "r1", SendState::Answered).await;

    assert_eq!(row.answer_text.as_deref(), Some("R1"));
    assert_eq!(row.answer_message_id.as_deref(), Some("reply-t1"));
    assert_eq!(row.answering_turn_id.as_deref(), Some("t1"));
    assert!(!row.answer_truncated);
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn state_a_failed_or_interrupted_turn_is_not_answered_with_its_reason() {
    for (end, reason) in [
        ("error", "turn_failed"),
        ("interrupted", "turn_interrupted"),
        ("ready", "no_answer"),
    ] {
        let (harness, service, stop) = followed().await;
        send_with(&service, input("r1", "review", "thread:a", "thread:b")).await;
        turn_session(&harness, "b", "t1", "running").await;
        until_state(&harness, &service, "r1", SendState::Read).await;

        turn_session(&harness, "b", "t1", end).await;

        let row = until_state(&harness, &service, "r1", SendState::NotAnswered).await;
        assert_eq!(row.reason.as_deref(), Some(reason), "{end}");
        assert_eq!(row.answer_text, None);
        stop.cancel();
        harness.shutdown().await;
    }
}

#[tokio::test]
async fn state_the_targets_queue_is_paused() {
    let (harness, service, stop) = followed().await;
    session(&harness, "b", "running").await;
    session(&harness, "b", "error").await;

    send_with(&service, input("r1", "review", "thread:a", "thread:b")).await;

    let row = until_state(&harness, &service, "r1", SendState::Waiting).await;
    assert_eq!(row.reason.as_deref(), Some("queue_paused"));
    assert_eq!(
        outbox_state(&harness, "person-send:r1").await.as_deref(),
        Some("queued"),
        "the message is queued, not started"
    );
    dispatch(
        &harness,
        json!({
            "type": "thread.turn.promote", "commandId": "promote-r1", "threadId": "b",
            "messageId": "person-send:r1", "createdAt": AT,
        }),
    )
    .await;
    turn_session(&harness, "b", "t1", "running").await;

    let row = until_state(&harness, &service, "r1", SendState::Read).await;
    assert_eq!(row.reason, None);
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn state_a_queue_held_behind_a_running_turn_that_errors_waits() {
    let (harness, service, stop) = followed().await;
    session(&harness, "b", "running").await;
    send_with(&service, input("r1", "review", "thread:a", "thread:b")).await;
    service.sweep().await;
    assert_eq!(request(&harness, "r1").await.state, SendState::Queued);

    session(&harness, "b", "error").await;

    let row = until_state(&harness, &service, "r1", SendState::Waiting).await;
    assert_eq!(row.reason.as_deref(), Some("queue_paused"));
    stop.cancel();
    harness.shutdown().await;

    // An interrupt holds the queue although the session goes back to ready.
    let (harness, service, stop) = followed().await;
    turn_session(&harness, "b", "t1", "running").await;
    send_with(&service, input("r2", "review", "thread:a", "thread:b")).await;
    dispatch(
        &harness,
        json!({
            "type": "thread.turn.interrupt", "commandId": "interrupt-t1", "threadId": "b",
            "turnId": "t1", "createdAt": AT,
        }),
    )
    .await;
    turn_session(&harness, "b", "t1", "ready").await;

    let row = until_state(&harness, &service, "r2", SendState::Waiting).await;
    assert_eq!(row.reason.as_deref(), Some("queue_paused"));
    assert_eq!(
        outbox(&harness, "person-send:r2").await,
        Some(("queued".to_owned(), true))
    );
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn state_a_request_behind_an_open_approval_stays_queued() {
    let (harness, service, stop) = followed().await;
    session(&harness, "b", "running").await;
    ask(&harness, "b", "approval.requested").await;
    session(&harness, "b", "ready").await;
    send_with(&service, input("r1", "review", "thread:a", "thread:b")).await;

    service.sweep().await;
    let row = request(&harness, "r1").await;
    assert_eq!(
        (row.state, row.reason),
        (SendState::Queued, None),
        "an open approval is not a paused queue"
    );

    dispatch(
        &harness,
        json!({
            "type": "thread.activity.append", "commandId": "approval-resolved",
            "threadId": "b",
            "activity": {
                "id": "approval-resolved", "tone": "approval", "kind": "approval.resolved",
                "summary": "resolved", "payload": { "requestId": "request-open" },
                "turnId": null, "createdAt": AT,
            },
            "createdAt": AT,
        }),
    )
    .await;
    session(&harness, "b", "ready").await;
    let mut started = false;
    for _ in 0..200 {
        if outbox_state(&harness, "person-send:r1").await.as_deref() != Some("queued") {
            started = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(started, "answering the approval promotes the request");
    turn_session(&harness, "b", "t1", "running").await;

    until_state(&harness, &service, "r1", SendState::Read).await;
    stop.cancel();
    harness.shutdown().await;
}

/// Stores a delivery on `b` older than any send, in `state`.
async fn older_delivery(harness: &Harness, state: &'static str) {
    harness
        .repositories
        .database()
        .call(move |connection| {
            connection.execute(
                "INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error, payload_digest) \
                 VALUES ('older', 'thread', 'b', '2000-01-01T00:00:00.000Z', 0, 'accepted', NULL, NULL)",
                [],
            )?;
            connection.execute(
                "INSERT INTO provider_turn_outbox (command_id, thread_id, message_id, provider_instance_id, provider_kind, delivery_key, payload_json, state, created_at, updated_at) \
                 VALUES ('older', 'b', 'older-message', 'codex', 'codex', 'older-key', '{}', ?1, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')",
                [state],
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn state_a_pending_row_behind_a_failed_delivery_waits() {
    for head in ["failed", "uncertain"] {
        let (harness, service, stop) = followed().await;
        older_delivery(&harness, head).await;

        send_with(&service, input("r1", "review", "thread:a", "thread:b")).await;

        let row = until_state(&harness, &service, "r1", SendState::Waiting).await;
        assert_eq!(row.reason.as_deref(), Some("queue_paused"), "{head}");
        assert_eq!(
            outbox_state(&harness, "person-send:r1").await.as_deref(),
            Some("pending")
        );
        dispatch(
            &harness,
            json!({
                "type": "thread.turn-delivery.resolve", "commandId": "dismiss-older",
                "threadId": "b", "messageId": "older-message", "action": "dismiss",
                "createdAt": AT,
            }),
        )
        .await;

        let row = until_state(&harness, &service, "r1", SendState::Queued).await;
        assert_eq!(row.reason, None, "{head}: the request moves on");
        stop.cancel();
        harness.shutdown().await;
    }
}

/// Thread `d` of project `p1`, with no worktree of its own, so `thread.delete` removes it.
async fn deletable_thread(harness: &Harness) {
    dispatch(
        harness,
        json!({
            "type": "thread.create", "commandId": "create-d", "threadId": "d",
            "projectId": "p1", "title": "d",
            "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "full-access", "interactionMode": "default", "branch": null,
            "worktreePath": null, "createdAt": AT,
        }),
    )
    .await;
}

async fn delete_thread(harness: &Harness, thread_id: &str) {
    dispatch(
        harness,
        json!({
            "type": "thread.delete", "commandId": format!("delete-{thread_id}"),
            "threadId": thread_id,
        }),
    )
    .await;
}

#[tokio::test]
async fn state_the_target_is_deleted() {
    let (harness, service, stop) = followed().await;
    deletable_thread(&harness).await;
    send_with(&service, input("done", "review", "thread:a", "thread:d")).await;
    harness.provider_turn("d", "t1", "The answer", true).await;
    until_state(&harness, &service, "done", SendState::Answered).await;
    session(&harness, "d", "running").await;
    send_with(&service, input("open", "review", "thread:a", "thread:d")).await;

    delete_thread(&harness, "d").await;

    let row = until_state(&harness, &service, "open", SendState::NotAnswered).await;
    assert_eq!(row.reason.as_deref(), Some("target_deleted"));
    let done = request(&harness, "done").await;
    assert_eq!(done.state, SendState::Answered);
    assert_eq!(done.answer_text.as_deref(), Some("The answer"));
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn state_a_delivery_that_fails_is_not_answered() {
    let (harness, service, stop) = followed().await;
    session(&harness, "b", "running").await;
    send_with(&service, input("r1", "review", "thread:a", "thread:b")).await;
    harness
        .repositories
        .database()
        .call(|connection| {
            connection.execute(
                "UPDATE provider_turn_outbox SET state = 'failed' WHERE message_id = 'person-send:r1'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();

    service.sweep().await;

    let row = request(&harness, "r1").await;
    assert_eq!(row.state, SendState::NotAnswered);
    assert_eq!(row.reason.as_deref(), Some("delivery_failed"));
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn state_an_answer_is_stored_cut_at_48000_characters_with_a_flag() {
    let (harness, service, stop) = followed().await;
    let wide = "\u{1F600}";
    for (index, (reply, kept, truncated)) in [
        ("x".repeat(60_000), "x".repeat(ANSWER_TEXT_MAX_CHARS), true),
        ("y".repeat(48_000), "y".repeat(48_000), false),
        (wide.repeat(48_001), wide.repeat(48_000), true),
    ]
    .into_iter()
    .enumerate()
    {
        let id = format!("r{index}");
        send_with(&service, input(&id, "review", "thread:a", "thread:b")).await;
        harness
            .provider_turn("b", &format!("t{index}"), &reply, true)
            .await;

        let row = until_state(&harness, &service, &id, SendState::Answered).await;
        let text = row.answer_text.expect("an answer");
        assert_eq!(text.chars().count(), kept.chars().count(), "{id}");
        assert_eq!(text, kept, "{id}");
        assert_eq!(row.answer_truncated, truncated, "{id}");
    }
    assert_eq!(ANSWER_TEXT_MAX_CHARS, 48_000);
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn state_a_message_hand_off_or_take_over_is_dismissed_once_read() {
    let (harness, service, stop) = followed().await;
    let mut take_over = input("take-over", "take-over", "thread:b", "thread:b");
    take_over.taken_over = Some("thread:a".to_owned());
    for (index, (request_input, dismissed)) in [
        (input("message", "message", "thread:a", "thread:b"), true),
        (input("hand-off", "hand-off", "thread:a", "thread:b"), true),
        (take_over, true),
        (input("review", "review", "thread:a", "thread:b"), false),
        (input("second", "second-opinion", "thread:a", "thread:b"), false),
    ]
    .into_iter()
    .enumerate()
    {
        let id = request_input.request_id.clone();
        send_with(&service, request_input).await;
        let turn_id = format!("t{index}");
        turn_session(&harness, "b", &turn_id, "running").await;

        let row = until_state(&harness, &service, &id, SendState::Read).await;
        assert_eq!(row.dismissed_at.is_some(), dismissed, "{id}");
        turn_session(&harness, "b", &turn_id, "ready").await;
        until(&harness, &service, &id, |row| row.state.is_final()).await;
    }
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn state_deleting_the_source_drops_its_requests() {
    let (harness, service, stop) = followed().await;
    deletable_thread(&harness).await;
    session(&harness, "b", "running").await;
    send_with(&service, input("r1", "review", "thread:d", "thread:b")).await;
    send_with(&service, input("kept", "review", "thread:a", "thread:b")).await;
    let mut changes = service.subscribe_changes();

    delete_thread(&harness, "d").await;

    let removed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Ok(RequestChange::Remove(request_id)) = changes.recv().await {
                return request_id;
            }
        }
    })
    .await
    .expect("a remove change");
    assert_eq!(removed, "r1");
    assert_eq!(
        SendRequestStore::new(harness.repositories.database().clone())
            .get("r1")
            .await
            .unwrap(),
        None
    );
    assert_eq!(request(&harness, "kept").await.state, SendState::Queued);
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn state_survives_a_restart() {
    let harness = harness().await;
    let before = harness.send_requests();
    let stop = CancellationToken::new();
    before.start_follower(harness.engine.clone(), stop.clone());
    send_with(&before, input("r1", "review", "thread:a", "thread:b")).await;
    stop.cancel();
    drop(before);

    // The turn runs and ends while no follower runs.
    harness.provider_turn("b", "t1", "Answered while away", true).await;
    assert_eq!(request(&harness, "r1").await.state, SendState::Queued);

    let after = harness.send_requests();
    let stop = CancellationToken::new();
    after.start_follower(harness.engine.clone(), stop.clone());

    let row = until_state(&harness, &after, "r1", SendState::Answered).await;
    assert_eq!(row.answer_text.as_deref(), Some("Answered while away"));
    stop.cancel();
    harness.shutdown().await;
}

#[tokio::test]
async fn state_a_lagging_follower_resweeps() {
    let harness = harness().await;
    let service = harness.send_requests();
    let events = harness.engine.subscribe_events();
    send_with(&service, input("r1", "review", "thread:a", "thread:b")).await;
    harness.provider_turn("b", "t1", "R1", true).await;
    // More events on another thread than the broadcast keeps: the answer's events are lost.
    for index in 0..300 {
        dispatch(
            &harness,
            json!({
                "type": "thread.activity.append", "commandId": format!("note-{index}"),
                "threadId": "a",
                "activity": {
                    "id": format!("note-{index}"), "tone": "info", "kind": "note",
                    "summary": "note", "payload": {}, "turnId": null, "createdAt": AT,
                },
                "createdAt": AT,
            }),
        )
        .await;
    }

    let stop = CancellationToken::new();
    let follower = service.clone();
    let following = tokio::spawn({
        let stop = stop.clone();
        async move { follower.follow(events, stop).await }
    });

    let row = until_state(&harness, &service, "r1", SendState::Answered).await;
    assert_eq!(row.answer_text.as_deref(), Some("R1"));
    stop.cancel();
    following.await.unwrap();
    harness.shutdown().await;
}
