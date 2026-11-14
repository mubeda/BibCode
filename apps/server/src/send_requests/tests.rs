use crate::persistence::Database;
use crate::send_requests::store::{
    SendAction, SendRequestRow, SendRequestStore, SendState, StateChange,
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
