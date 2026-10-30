//! A subagent still open when its parent's turn ends (#206): closed only when Claude's complete
//! live set proves its task stopped, and completed by a stop hook that arrives late.

use serde_json::{Value, json};

use super::{ClaudeProviderRuntime, ClaudeRuntimeOutput, TurnInput};
use crate::activity::{ActivityLifecycle, ProviderActivityMutation};

const ACTOR_ID: &str = "claude:agent:agent-a";

fn runtime() -> ClaudeProviderRuntime {
    let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
    runtime.set_targeted_activity_control_supported(true);
    runtime.start_turn(TurnInput {
        turn_id: "turn".to_owned(),
        input: "delegate it".to_owned(),
    });
    runtime
}

/// The facts that map `agent-a` to `task-a`: the Agent call, its launch, Claude's task, and the
/// subagent's start hook.
fn launch_mapped_subagent(runtime: &mut ClaudeProviderRuntime) -> Vec<ClaudeRuntimeOutput> {
    vec![
        runtime.handle_raw_value(
            &json!({
                "type": "stream_event", "session_id": "session", "uuid": "tool-a",
                "parent_tool_use_id": null,
                "event": {
                    "type": "content_block_start", "index": 0,
                    "content_block": {
                        "type": "tool_use", "id": "tool-a", "name": "Agent",
                        "input": {"description": "review", "prompt": "review"}
                    }
                }
            }),
            1_000,
        ),
        runtime.handle_authenticated_hook_value(
            &json!({
                "hook_event_name": "PostToolUse", "session_id": "session",
                "tool_name": "Agent", "tool_use_id": "tool-a",
                "tool_response": {"status": "async_launched", "agentId": "agent-a"}
            }),
            1_001,
        ),
        runtime.handle_raw_value(
            &json!({
                "type": "system", "subtype": "task_started", "session_id": "session",
                "uuid": "started-a", "task_id": "task-a", "tool_use_id": "tool-a",
                "task_type": "local_agent", "description": "review"
            }),
            1_002,
        ),
        runtime.handle_authenticated_hook_value(
            &json!({
                "hook_event_name": "SubagentStart", "session_id": "session",
                "agent_id": "agent-a", "agent_type": "reviewer"
            }),
            1_003,
        ),
    ]
}

fn tasks_changed(tasks: Value) -> Value {
    json!({
        "type": "system", "subtype": "background_tasks_changed", "session_id": "session",
        "uuid": "tasks-changed", "tasks": tasks
    })
}

fn result() -> Value {
    json!({
        "type": "result", "subtype": "success", "is_error": false, "stop_reason": "end_turn",
        "session_id": "session", "uuid": "result"
    })
}

fn stop_hook() -> Value {
    json!({
        "hook_event_name": "SubagentStop", "session_id": "session", "agent_id": "agent-a",
        "last_assistant_message": "Reviewed."
    })
}

fn actor_statuses(outputs: &[ClaudeRuntimeOutput]) -> Vec<(ActivityLifecycle, Option<String>)> {
    outputs
        .iter()
        .flat_map(|output| &output.activity)
        .filter_map(|mutation| match mutation {
            ProviderActivityMutation::UpsertActor(actor) if actor.id == ACTOR_ID => {
                Some((actor.status, actor.summary.clone()))
            }
            _ => None,
        })
        .collect()
}

fn last_status(outputs: &[ClaudeRuntimeOutput]) -> Option<ActivityLifecycle> {
    actor_statuses(outputs).last().map(|(status, _)| *status)
}

#[test]
fn a_mapped_subagent_absent_from_the_complete_live_set_closes_at_turn_end() {
    let mut runtime = runtime();
    let mut outputs = launch_mapped_subagent(&mut runtime);
    assert_eq!(last_status(&outputs), Some(ActivityLifecycle::Running));
    outputs.push(runtime.handle_raw_value(&tasks_changed(json!([])), 2_000));
    outputs.push(runtime.handle_raw_value(&result(), 2_001));

    let (status, summary) = actor_statuses(&outputs).pop().expect("closure");
    assert_eq!(status, ActivityLifecycle::Interrupted);
    assert!(
        summary.as_deref().is_some_and(
            |summary| summary.starts_with("Claude stopped listing this subagent as running;")
        ),
        "{summary:?}"
    );

    // The stop hook arrives after all: the stop is the truth.
    let late = runtime.handle_authenticated_hook_value(&stop_hook(), 1_999);
    let (status, summary) = actor_statuses(&[late]).pop().expect("late stop");
    assert_eq!(status, ActivityLifecycle::Completed);
    assert_eq!(summary.as_deref(), Some("Reviewed."));
}

#[test]
fn a_subagent_still_in_the_live_set_stays_open_at_turn_end() {
    let mut runtime = runtime();
    let mut outputs = launch_mapped_subagent(&mut runtime);
    outputs.push(runtime.handle_raw_value(
        &tasks_changed(json!([{"task_id": "task-a", "task_type": "local_agent"}])),
        2_000,
    ));
    outputs.push(runtime.handle_raw_value(&result(), 2_001));
    assert_eq!(last_status(&outputs), Some(ActivityLifecycle::Running));
}

#[test]
fn an_overflowed_live_set_proves_nothing_and_a_late_stop_still_completes() {
    let mut runtime = runtime();
    let mut outputs = launch_mapped_subagent(&mut runtime);
    let crowded = (0..crate::activity::ACTIVITY_PAGE_MAX_LENGTH + 1)
        .map(|index| json!({"task_id": format!("other-{index}"), "task_type": "local_bash"}))
        .collect::<Vec<_>>();
    outputs.push(runtime.handle_raw_value(&tasks_changed(Value::Array(crowded)), 2_000));
    outputs.push(runtime.handle_raw_value(&result(), 2_001));
    assert_eq!(
        last_status(&outputs),
        Some(ActivityLifecycle::Running),
        "an overflowed set cannot prove the subagent's task stopped"
    );

    let late = runtime.handle_authenticated_hook_value(&stop_hook(), 2_002);
    assert_eq!(last_status(&[late]), Some(ActivityLifecycle::Completed));
}

#[test]
fn a_live_set_with_an_unnamed_task_proves_nothing_at_turn_end() {
    let mut runtime = runtime();
    let mut outputs = launch_mapped_subagent(&mut runtime);
    // The unnamed task could be the subagent's own.
    outputs.push(runtime.handle_raw_value(
        &tasks_changed(json!([{"task_type": "local_agent", "description": "review"}])),
        2_000,
    ));
    outputs.push(runtime.handle_raw_value(&result(), 2_001));
    assert_eq!(last_status(&outputs), Some(ActivityLifecycle::Running));
}

#[test]
fn without_a_complete_live_set_turn_end_closes_nothing() {
    let mut runtime = runtime();
    let mut outputs = launch_mapped_subagent(&mut runtime);
    // Claude Code before 2.1.203 never sends the complete set.
    outputs.push(runtime.handle_raw_value(&result(), 2_001));
    assert_eq!(last_status(&outputs), Some(ActivityLifecycle::Running));
}

#[test]
fn an_unmapped_subagent_waits_for_its_stop_or_its_process() {
    let mut runtime = runtime();
    let start = runtime.handle_authenticated_hook_value(
        &json!({
            "hook_event_name": "SubagentStart", "session_id": "session",
            "agent_id": "agent-a", "agent_type": "reviewer"
        }),
        1_000,
    );
    let changed = runtime.handle_raw_value(&tasks_changed(json!([])), 2_000);
    let ended = runtime.handle_raw_value(&result(), 2_001);
    assert_eq!(
        last_status(&[start, changed, ended]),
        Some(ActivityLifecycle::Running)
    );
}

#[test]
fn a_stopped_notification_before_the_task_mapping_applies_once_the_mapping_arrives() {
    let mut runtime = runtime();
    let stopped = runtime.handle_raw_value(
        &json!({
            "type": "system", "subtype": "task_notification", "session_id": "session",
            "uuid": "stopped-a", "task_id": "task-a", "status": "stopped"
        }),
        900,
    );
    let mut outputs = vec![stopped];
    outputs.extend(launch_mapped_subagent(&mut runtime));
    assert_eq!(last_status(&outputs), Some(ActivityLifecycle::Cancelled));
}
