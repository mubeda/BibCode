//! A task notification Claude replays into the running turn and answers there (#389). Frame order
//! as Claude Code 2.1.326 emits it in stream-JSON mode with `--replay-user-messages`: the replay
//! comes mid-turn, Claude writes its answer, and the turn's one `result` follows. No other turn
//! follows it, so none may open.

use serde_json::{Value, json};

use super::{CanonicalEvent, ClaudeProviderRuntime, Decision, TurnInput};

fn runtime() -> ClaudeProviderRuntime {
    let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
    runtime.start_turn(TurnInput {
        turn_id: "delivered".to_owned(),
        input: "start a background task".to_owned(),
    });
    runtime
}

fn kinds(runtime: &mut ClaudeProviderRuntime, value: &Value) -> Vec<(String, Option<String>)> {
    runtime
        .handle_raw_value(value, 1_000)
        .events
        .into_iter()
        .map(|event| (event.event_type, event.turn_id))
        .collect()
}

fn task(subtype: &str, task_id: &str) -> Value {
    let mut value = json!({"type":"system","subtype":subtype,"task_id":task_id,"session_id":"session","uuid":format!("{subtype}-{task_id}")});
    if subtype == "task_started" {
        value["task_type"] = json!("local_bash");
        value["is_backgrounded"] = json!(true);
    } else {
        value["status"] = json!("completed");
    }
    value
}

fn notification() -> Value {
    json!({"type":"user","message":{"role":"user","content":"<task-notification></task-notification>"},"origin":{"kind":"task-notification"},"parent_tool_use_id":null,"isReplay":true,"session_id":"session","uuid":"notification"})
}

fn text_delta() -> Value {
    json!({"type":"stream_event","parent_tool_use_id":null,"session_id":"session","uuid":"delta","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done."}}})
}

fn result() -> Value {
    json!({"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","session_id":"session","uuid":"result"})
}

fn assert_answered_in_its_turn(tasks: &[&str]) {
    let mut runtime = runtime();
    let mut frames = Vec::new();
    frames.extend(tasks.iter().map(|id| task("task_started", id)));
    frames.extend(tasks.iter().map(|id| task("task_notification", id)));
    frames.extend(tasks.iter().map(|_| notification()));
    frames.push(text_delta());
    for frame in frames {
        let output = kinds(&mut runtime, &frame);
        assert!(
            output.iter().all(|(kind, _)| kind != "turn.started"),
            "{output:?}"
        );
    }
    assert_eq!(
        kinds(&mut runtime, &result()),
        [("turn.completed".to_owned(), Some("delivered".to_owned()))],
        "the turn answered its notifications, so no other turn opens"
    );
}

/// (a) One notification answered in its turn.
#[test]
fn a_notification_answered_in_its_turn_opens_no_other() {
    assert_answered_in_its_turn(&["bg"]);
}

/// (b) Two notifications answered by the turn's one `result`.
#[test]
fn two_notifications_answered_by_one_result_open_no_turn() {
    assert_answered_in_its_turn(&["a", "b"]);
}

/// Two notifications the turn did not answer each keep their own turn: output in the first
/// follow-up answers only that one.
#[test]
fn two_unanswered_notifications_each_get_a_turn() {
    let mut runtime = runtime();
    for frame in [
        task("task_started", "a"),
        task("task_started", "b"),
        text_delta(),
        task("task_notification", "a"),
        task("task_notification", "b"),
        notification(),
        notification(),
    ] {
        kinds(&mut runtime, &frame);
    }
    let started = |output: Vec<(String, Option<String>)>| {
        output
            .iter()
            .filter(|(kind, _)| kind == "turn.started")
            .count()
    };
    assert_eq!(
        started(kinds(&mut runtime, &result())),
        1,
        "the first answer's turn"
    );
    kinds(&mut runtime, &text_delta());
    assert_eq!(
        started(kinds(&mut runtime, &result())),
        1,
        "the second answer's turn"
    );
    kinds(&mut runtime, &text_delta());
    assert_eq!(
        started(kinds(&mut runtime, &result())),
        0,
        "nothing is owed after both"
    );
}

/// A carried count does not outlive a stream failure: afterwards an answered notification
/// opens no turn.
#[test]
fn a_stream_failure_forgets_the_carried_follow_ups() {
    let mut runtime = runtime();
    for frame in [text_delta(), notification(), notification()] {
        kinds(&mut runtime, &frame);
    }
    kinds(&mut runtime, &result());
    runtime.handle_stream_failure("the stream ended");
    runtime.start_turn(TurnInput {
        turn_id: "next".to_owned(),
        input: "again".to_owned(),
    });
    kinds(&mut runtime, &notification());
    kinds(&mut runtime, &text_delta());
    let output = kinds(&mut runtime, &result());
    assert!(
        output.iter().all(|(kind, _)| kind != "turn.started"),
        "{output:?}"
    );
}

fn assistant_text() -> Value {
    json!({"type":"assistant","parent_tool_use_id":null,"session_id":"session","uuid":"answer","message":{"id":"answer-message","role":"assistant","content":[{"type":"text","text":"Done."}]}})
}

fn init() -> Value {
    json!({"type":"system","subtype":"init","session_id":"session","uuid":"init"})
}

fn idle_result(is_error: bool) -> Value {
    json!({"type":"result","subtype":if is_error {"error_during_execution"} else {"success"},"is_error":is_error,"stop_reason":"end_turn","origin":{"kind":"task-notification"},"session_id":"session","uuid":"idle-result"})
}

/// Claude Code 2.1.326 answering a background agent that finished while no turn ran: no
/// replay, so no turn opens. The answer's `result` still ends its text, and completes no turn:
/// the delivered turn already ended.
#[test]
fn an_answer_with_no_turn_ends_its_text_and_completes_no_turn() {
    let mut runtime = runtime();
    kinds(&mut runtime, &task("task_started", "bg"));
    kinds(&mut runtime, &result());
    let mut events = Vec::new();
    for frame in [
        task("task_notification", "bg"),
        init(),
        text_delta(),
        assistant_text(),
        idle_result(false),
    ] {
        events.extend(runtime.handle_raw_value(&frame, 1_000).events);
    }
    let names: Vec<_> = events
        .iter()
        .map(|event| event.event_type.as_str())
        .collect();
    assert!(!names.contains(&"turn.started"), "{names:?}");
    assert!(!names.contains(&"turn.completed"), "{names:?}");
    let delta = events
        .iter()
        .find(|event| event.event_type == "content.delta")
        .expect("the answer's text");
    let completed = events
        .iter()
        .find(|event| event.event_type == "assistant.message.completed")
        .unwrap_or_else(|| panic!("the answer's text ends: {names:?}"));
    assert_eq!(completed.item_id, delta.item_id);
    assert_eq!(completed.turn_id, delta.turn_id);
}

/// An answer with no turn that streams text, calls a tool, then streams more text under a second
/// message: its `result` ends both texts under the ids each was stored with, and only the last
/// completion ends the answer, so one context query follows it.
#[test]
fn an_answer_with_no_turn_ends_every_text_it_streamed() {
    let mut runtime = runtime();
    let message_start = |id: &str| stream(json!({"type":"message_start","message":{"id":id}}));
    let events = idle_answer_events(
        &mut runtime,
        vec![
            message_start("answer-a"),
            text_delta(),
            tool_start(),
            tool_stop(),
            tool_result(),
            message_start("answer-b"),
            text_delta(),
            idle_result(false),
        ],
    );
    let streamed: Vec<_> = events
        .iter()
        .filter(|event| event.event_type == "content.delta")
        .map(|event| (event.turn_id.clone(), event.item_id.clone()))
        .collect();
    let completed: Vec<_> = events
        .iter()
        .filter(|event| event.event_type == "assistant.message.completed")
        .collect();
    assert_eq!(
        completed
            .iter()
            .map(|event| (event.turn_id.clone(), event.item_id.clone()))
            .collect::<Vec<_>>(),
        streamed,
        "each streamed text completes under its own ids"
    );
    assert_eq!(completed[0].payload["answerContinues"], true);
    assert_eq!(completed[1].payload, json!({}), "the last ends the answer");
}

/// The same answer failing before any output completes nothing and names no turn.
#[test]
fn a_failed_answer_with_no_turn_completes_nothing() {
    let mut runtime = runtime();
    kinds(&mut runtime, &task("task_started", "bg"));
    kinds(&mut runtime, &result());
    let mut events = Vec::new();
    for frame in [task("task_notification", "bg"), init(), idle_result(true)] {
        events.extend(runtime.handle_raw_value(&frame, 1_000).events);
    }
    let named: Vec<_> = events
        .iter()
        .map(|event| (event.event_type.clone(), event.turn_id.clone()))
        .collect();
    assert!(
        named
            .iter()
            .all(|(kind, turn)| turn.is_none() && !kind.ends_with(".completed")),
        "{named:?}"
    );
}

fn tool_start() -> Value {
    json!({"type":"stream_event","parent_tool_use_id":null,"session_id":"session","uuid":"tool-start","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"Bash","input":{}}}})
}

fn tool_stop() -> Value {
    json!({"type":"stream_event","parent_tool_use_id":null,"session_id":"session","uuid":"tool-stop","event":{"type":"content_block_stop","index":1}})
}

fn tool_result() -> Value {
    json!({"type":"user","parent_tool_use_id":null,"session_id":"session","uuid":"tool-result","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"ok"}]}})
}

/// The tool items an answer with no turn started, and those it completed.
fn idle_answer_tools(frames: Vec<Value>) -> (Vec<String>, Vec<String>) {
    let mut runtime = runtime();
    kinds(&mut runtime, &task("task_started", "bg"));
    kinds(&mut runtime, &result());
    let mut events = Vec::new();
    for frame in [task("task_notification", "bg"), init()]
        .into_iter()
        .chain(frames)
    {
        events.extend(runtime.handle_raw_value(&frame, 1_000).events);
    }
    assert!(
        events.iter().all(|event| event.event_type != "turn.started"
            && event.event_type != "turn.completed"),
        "no turn opens or completes"
    );
    let items = |kind: &str| {
        events
            .iter()
            .filter(|event| event.event_type == kind)
            .filter_map(|event| {
                event
                    .provider_refs
                    .as_ref()?
                    .get("providerItemId")?
                    .as_str()
            })
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    (items("item.started"), items("item.completed"))
}

/// A tool the answer called completes from its own result, with no turn open.
#[test]
fn a_tool_in_an_answer_with_no_turn_completes_from_its_result() {
    let (started, completed) = idle_answer_tools(vec![
        tool_start(),
        tool_stop(),
        tool_result(),
        text_delta(),
        idle_result(false),
    ]);
    assert_eq!(started, ["tool-1"]);
    assert_eq!(completed, ["tool-1"]);
}

/// A result that ends the answer while a tool is still open completes that tool, as a turn's
/// result does.
#[test]
fn a_result_mid_tool_in_an_answer_with_no_turn_completes_the_tool() {
    let (started, completed) =
        idle_answer_tools(vec![tool_start(), tool_stop(), idle_result(true)]);
    assert_eq!(started, ["tool-1"]);
    assert_eq!(completed, ["tool-1"]);
}

/// Every event an answer with no turn produced after the delivered turn ended.
fn idle_answer_events(
    runtime: &mut ClaudeProviderRuntime,
    frames: Vec<Value>,
) -> Vec<CanonicalEvent> {
    kinds(runtime, &task("task_started", "bg"));
    kinds(runtime, &result());
    let mut events = Vec::new();
    for frame in [task("task_notification", "bg"), init()]
        .into_iter()
        .chain(frames)
    {
        events.extend(runtime.handle_raw_value(&frame, 1_000).events);
    }
    assert!(
        events.iter().all(|event| event.event_type != "turn.started"
            && event.event_type != "turn.completed"),
        "no turn opens or completes"
    );
    events
}

fn stream(event: Value) -> Value {
    json!({"type":"stream_event","parent_tool_use_id":null,"session_id":"session","uuid":"stream","event":event})
}

/// Thinking the answer was still streaming when its result came is completed by that result,
/// as its block's own stop would.
#[test]
fn a_result_mid_thinking_in_an_answer_with_no_turn_completes_the_reasoning() {
    let mut runtime = runtime();
    let events = idle_answer_events(
        &mut runtime,
        vec![
            stream(json!({"type":"message_start","message":{"id":"answer-message"}})),
            stream(
                json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}),
            ),
            stream(
                json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Checking."}}),
            ),
            idle_result(true),
        ],
    );
    let reasoning = events
        .iter()
        .find(|event| event.payload["streamKind"] == "reasoning_text")
        .expect("the reasoning streamed");
    assert!(
        events
            .iter()
            .any(|event| event.event_type == "item.completed"
                && event.payload["itemType"] == "reasoning"
                && event.item_id == reasoning.item_id
                && event.turn_id == reasoning.turn_id),
        "{:?}",
        events
            .iter()
            .map(|event| &event.event_type)
            .collect::<Vec<_>>()
    );
}

fn can_use_tool() -> Value {
    json!({"type":"control_request","request_id":"approval-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"tool-1"}})
}

/// An approval the answer asked for and abandoned at its result is withdrawn, as a turn's
/// result withdraws one.
#[test]
fn an_approval_left_pending_at_an_idle_result_is_withdrawn() {
    let mut runtime = runtime();
    let events = idle_answer_events(&mut runtime, vec![can_use_tool(), idle_result(true)]);
    let opened = events
        .iter()
        .find(|event| event.event_type == "request.opened")
        .expect("the answer asks for approval");
    assert!(
        events
            .iter()
            .any(|event| event.event_type == "request.resolved"
                && event.request_id.as_deref() == Some("approval-1")
                && event.turn_id == opened.turn_id),
        "{:?}",
        events
            .iter()
            .map(|event| &event.event_type)
            .collect::<Vec<_>>()
    );
}

/// An approval answered during an answer with no turn resolves as in a turn.
#[test]
fn an_approval_answered_in_an_idle_answer_resolves() {
    let mut runtime = runtime();
    idle_answer_events(&mut runtime, vec![can_use_tool()]);
    let resolved = runtime
        .resolve_permission_request("approval-1", Decision::Accept)
        .expect("the approval is pending");
    assert_eq!(resolved.events[0].event_type, "request.resolved");
    let after = idle_answer_tail(&mut runtime);
    assert!(
        after.iter().all(|event| event != "request.resolved"),
        "an answered approval is not withdrawn again: {after:?}"
    );
}

fn idle_answer_tail(runtime: &mut ClaudeProviderRuntime) -> Vec<String> {
    runtime
        .handle_raw_value(&idle_result(false), 1_000)
        .events
        .into_iter()
        .map(|event| event.event_type)
        .collect()
}

/// After the answer's result nothing reads busy: no background task and no answer owed.
#[test]
fn an_idle_answer_result_leaves_no_background_work() {
    let mut runtime = runtime();
    idle_answer_events(&mut runtime, vec![text_delta()]);
    let output = runtime.handle_raw_value(&idle_result(false), 1_000);
    assert_eq!(output.background_tasks, Some(0));
}

/// A compaction still reported at the answer's result ends there, as at a turn's end, so the
/// session stops reading as compacting.
#[test]
fn a_compaction_open_at_an_idle_answer_result_ends_there() {
    let mut runtime = runtime();
    let compacting = runtime.compaction_watch();
    let events = idle_answer_events(
        &mut runtime,
        vec![
            json!({"type":"system","subtype":"status","status":"compacting","session_id":"session","uuid":"compacting"}),
            idle_result(true),
        ],
    );
    let started = events
        .iter()
        .find(|event| event.payload["itemType"] == "context_compaction")
        .expect("the compaction shows");
    assert!(
        events
            .iter()
            .any(|event| event.event_type == "item.completed"
                && event.provider_refs == started.provider_refs),
        "{:?}",
        events
            .iter()
            .map(|event| &event.event_type)
            .collect::<Vec<_>>()
    );
    assert!(!*compacting.borrow());
}
