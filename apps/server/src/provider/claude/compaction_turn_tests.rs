//! The turn a compaction BiBCode asked for runs in: tagged with its compaction id, started ahead of
//! Claude's first frame, kept open through a stale result, and ended only by the
//! `local_command: "compact"` result.

use serde_json::{Value, json};

use super::ClaudeProviderRuntime;

fn runtime() -> ClaudeProviderRuntime {
    let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
    runtime.begin_compaction_turn("compaction-turn".to_owned(), "compaction:1".to_owned());
    runtime.await_turn_input(7);
    runtime
}

fn events(runtime: &mut ClaudeProviderRuntime, value: &Value) -> Vec<(String, Value)> {
    runtime
        .handle_raw_value(value, 1_000)
        .events
        .into_iter()
        .map(|event| (event.event_type, event.payload))
        .collect()
}

fn stale_result() -> Value {
    json!({"type":"result","subtype":"success","is_error":false,"stop_reason":null,"session_id":"session","uuid":"stale"})
}

fn compact_result() -> Value {
    json!({"type":"result","subtype":"success","is_error":false,"num_turns":0,"stop_reason":null,"terminal_reason":"completed","local_command":"compact","result":"","session_id":"session","uuid":"compact-result"})
}

#[test]
fn the_compaction_turn_starts_ahead_of_claudes_first_frame_and_ignores_a_stale_result() {
    let mut runtime = runtime();
    let first = events(&mut runtime, &stale_result());
    assert_eq!(first.len(), 1, "{first:?}");
    assert_eq!(first[0].0, "turn.started");
    assert_eq!(first[0].1["compactionId"], "compaction:1");
    assert_eq!(runtime.current_turn_id(), Some("compaction-turn"));
    let compacting = events(
        &mut runtime,
        &json!({"type":"system","subtype":"status","status":"compacting","session_id":"session","uuid":"status-compacting"}),
    );
    assert_eq!(compacting[0].0, "item.started");
    let done = events(
        &mut runtime,
        &json!({"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"session","uuid":"status-done"}),
    );
    assert_eq!(done[0].0, "item.completed");
    assert_eq!(done[0].1["status"], "completed");
    // The `local_command` result acknowledges the write, which ends the wait, then the turn.
    runtime.stop_awaiting_turn_input(7);
    let ended = events(&mut runtime, &compact_result());
    let completed = ended
        .iter()
        .find(|(kind, _)| kind == "turn.completed")
        .expect("the compaction's result ends its turn");
    assert_eq!(completed.1["state"], "completed");
    assert_eq!(completed.1["compactionId"], "compaction:1");
}

#[test]
fn a_task_notification_in_the_window_follows_the_compaction_turn() {
    let mut runtime = runtime();
    let notification = json!({"type":"user","message":{"role":"user","content":"<task-notification><task-id>task-bg</task-id><status>completed</status></task-notification>"},"origin":{"kind":"task-notification"},"parent_tool_use_id":null,"session_id":"session","uuid":"follow-up-user"});
    let started = events(&mut runtime, &notification);
    assert_eq!(started[0].0, "turn.started");
    assert!(
        started.iter().all(|(kind, _)| kind != "turn.completed"),
        "{started:?}"
    );
    runtime.stop_awaiting_turn_input(7);
    let ended = events(&mut runtime, &compact_result());
    let kinds = ended
        .iter()
        .map(|(kind, _)| kind.as_str())
        .collect::<Vec<_>>();
    assert_eq!(kinds, ["turn.completed", "turn.started"], "{ended:?}");
    assert_eq!(ended[0].1["compactionId"], "compaction:1");
    // The follow-up is an ordinary turn of its own.
    assert!(ended[1].1.get("compactionId").is_none());
    assert_ne!(runtime.current_turn_id(), Some("compaction-turn"));
}

#[test]
fn a_compaction_claude_declines_ends_its_turn_without_a_compaction_item() {
    let mut runtime = runtime();
    let output = events(
        &mut runtime,
        &json!({"type":"user","message":{"role":"user","content":"<local-command-stderr>Not enough messages to compact.</local-command-stderr>"},"session_id":"session","parent_tool_use_id":null,"uuid":"local-output","isReplay":true}),
    );
    assert_eq!(output[0].0, "turn.started");
    runtime.stop_awaiting_turn_input(7);
    let ended = events(&mut runtime, &compact_result());
    assert!(
        ended.iter().all(|(kind, payload)| kind != "item.completed"
            || payload["itemType"] != "context_compaction")
    );
    let completed = ended
        .iter()
        .find(|(kind, _)| kind == "turn.completed")
        .unwrap();
    assert_eq!(completed.1["compactionId"], "compaction:1");
}

#[test]
fn an_unwritten_compaction_turn_is_abandoned_unseen() {
    let mut runtime = runtime();
    runtime.stop_awaiting_turn_input(7);
    runtime.abandon_compaction_turn();
    let output = events(&mut runtime, &stale_result());
    assert!(
        output.iter().all(|(kind, _)| kind != "turn.started"),
        "{output:?}"
    );
}
