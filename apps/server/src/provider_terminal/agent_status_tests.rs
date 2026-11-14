//! How each AI Terminal observer maps its provider's events to the main agent's state for the
//! left panel (#187). The Claude hook mapping and its capture path are tested in `claude.rs`.

use serde_json::{Value, json};

use super::{
    TerminalAgentState::{Blocked, Done, Waiting, Working},
    claude::claude_hook_ready_for_prompt,
    codex::{
        codex_resumed_agent_status, codex_resumed_ready_for_prompt, codex_root_agent_status,
        codex_root_ready_for_prompt,
    },
    model::TerminalAgentReport,
    opencode::{opencode_root_agent_status, opencode_root_ready_for_prompt},
};
use crate::provider::codex::model::ReconciliationThreadStatus;

#[test]
fn codex_root_notifications_map_to_the_main_agent_state() {
    let status = |method: &str, params: Value| {
        codex_root_agent_status(&json!({ "method": method, "params": params }), "root")
    };
    let set = |state, failed| Some(TerminalAgentReport::Set(state, failed));
    let active = |flags: Value| {
        status(
            "thread/status/changed",
            json!({"threadId":"root","status":{"type":"active","activeFlags":flags}}),
        )
    };
    assert_eq!(active(json!([])), set(Working, false));
    assert_eq!(active(json!(["waitingOnApproval"])), set(Blocked, false));
    assert_eq!(active(json!(["waitingOnUserInput"])), set(Waiting, false));
    assert_eq!(
        status(
            "thread/status/changed",
            json!({"threadId":"root","status":{"type":"idle"}})
        ),
        set(Done, false)
    );
    assert_eq!(
        status(
            "thread/status/changed",
            json!({"threadId":"root","status":{"type":"systemError"}})
        ),
        set(Done, true)
    );
    assert_eq!(
        status("turn/started", json!({"threadId":"root"})),
        set(Working, false)
    );
    assert_eq!(
        status(
            "turn/completed",
            json!({"threadId":"root","turn":{"status":"failed"}})
        ),
        set(Done, true)
    );
    assert_eq!(
        status(
            "thread/status/changed",
            json!({"threadId":"child","status":{"type":"idle"}})
        ),
        None,
        "a subagent thread leaves the root state alone"
    );
    // The root's items stream while it works; a request it sends asks the user (#187).
    assert_eq!(
        status(
            "item/agentMessage/delta",
            json!({"threadId":"root","delta":"text"})
        ),
        Some(TerminalAgentReport::Progress)
    );
    assert_eq!(
        status("item/started", json!({"threadId":"root"})),
        Some(TerminalAgentReport::Progress)
    );
    assert_eq!(
        status("item/started", json!({"threadId":"child"})),
        None,
        "a subagent's items leave the root state alone"
    );
    let request = |method: &str| {
        codex_root_agent_status(
            &json!({ "id": 7, "method": method, "params": {"threadId":"root"} }),
            "root",
        )
    };
    assert_eq!(
        request("item/commandExecution/requestApproval"),
        set(Blocked, false)
    );
    assert_eq!(
        request("item/fileChange/requestApproval"),
        set(Blocked, false)
    );
    assert_eq!(request("item/tool/requestUserInput"), set(Waiting, false));
    assert_eq!(request("item/tool/call"), None);
}

#[test]
fn codex_resumed_thread_status_maps_to_the_main_agent_state() {
    let active = |flags: &[&str]| {
        codex_resumed_agent_status(Some(&ReconciliationThreadStatus::Active {
            active_flags: flags.iter().map(|flag| (*flag).to_owned()).collect(),
        }))
    };
    assert_eq!(active(&[]), Some((Working, false)));
    assert_eq!(active(&["waitingOnApproval"]), Some((Blocked, false)));
    assert_eq!(active(&["waitingOnUserInput"]), Some((Waiting, false)));
    assert_eq!(
        codex_resumed_agent_status(Some(&ReconciliationThreadStatus::Idle)),
        Some((Done, false))
    );
    assert_eq!(
        codex_resumed_agent_status(Some(&ReconciliationThreadStatus::SystemError)),
        Some((Done, true))
    );
    assert_eq!(
        codex_resumed_agent_status(Some(&ReconciliationThreadStatus::NotLoaded)),
        None
    );
    assert_eq!(codex_resumed_agent_status(None), None);
}

#[test]
fn opencode_root_events_map_to_the_main_agent_state() {
    let status = |event_type: &str, properties: Value| {
        opencode_root_agent_status(
            &json!({ "type": event_type, "properties": properties }),
            "root",
        )
    };
    let set = |state, failed| Some(TerminalAgentReport::Set(state, failed));
    assert_eq!(
        status(
            "session.status",
            json!({"sessionID":"root","status":{"type":"busy"}})
        ),
        set(Working, false)
    );
    assert_eq!(
        status(
            "session.status",
            json!({"sessionID":"root","status":{"type":"idle"}})
        ),
        set(Done, false)
    );
    assert_eq!(
        status("permission.asked", json!({"sessionID":"root"})),
        set(Blocked, false)
    );
    assert_eq!(
        status("question.asked", json!({"sessionID":"root"})),
        set(Waiting, false)
    );
    assert_eq!(
        status("session.error", json!({"sessionID":"root"})),
        set(Done, true)
    );
    assert_eq!(
        status(
            "session.status",
            json!({"sessionID":"child","status":{"type":"busy"}})
        ),
        None,
        "a child session leaves the root state alone"
    );
    // The root's message parts stream while it works (#187), whether the event names the
    // session itself or only through its part.
    assert_eq!(
        status(
            "message.part.delta",
            json!({"sessionID":"root","field":"text","delta":"x"})
        ),
        Some(TerminalAgentReport::Progress)
    );
    assert_eq!(
        status(
            "message.part.updated",
            json!({"part":{"sessionID":"root","type":"text","text":"x"}})
        ),
        Some(TerminalAgentReport::Progress)
    );
    assert_eq!(
        status(
            "message.part.updated",
            json!({"part":{"sessionID":"root","type":"step-finish"}})
        ),
        None,
        "a step's closing part reports no new work"
    );
    assert_eq!(
        status(
            "message.part.updated",
            json!({"part":{"sessionID":"child","type":"text"}})
        ),
        None
    );
}

/// Which provider events say the CLI waits for a prompt. A fresh agent sends none of these
/// before its first turn ends, so it reads not ready until then; its inbox still works.
#[test]
fn ready_for_prompt_follows_each_provider_event() {
    let claude = |event: &str, notification: Option<&str>| {
        let hook = serde_json::from_value(json!({
            "hook_event_name": event,
            "session_id": "session-1",
            "tool_name": "Bash",
            "notification_type": notification,
        }))
        .expect("a Claude status hook");
        claude_hook_ready_for_prompt(&hook)
    };
    for (event, notification, ready) in [
        ("SessionStart", None, false),
        ("UserPromptSubmit", None, false),
        ("PermissionRequest", None, false),
        ("Elicitation", None, false),
        ("PreToolUse", None, false),
        // A project's own Stop hook can block the stop, and Claude then continues without a
        // new prompt; only the idle notification proves the prompt waits.
        ("Stop", None, false),
        ("StopFailure", None, false),
        ("SessionEnd", None, false),
        ("Notification", Some("idle_prompt"), true),
        ("Notification", Some("permission_prompt"), false),
        ("Notification", Some("elicitation_dialog"), false),
    ] {
        assert_eq!(
            claude(event, notification),
            ready,
            "Claude {event} {notification:?}"
        );
    }

    let codex = |envelope: Value| codex_root_ready_for_prompt(&envelope, "root");
    let status = |status: Value| json!({"method":"thread/status/changed","params":{"threadId":"root","status":status}});
    let request = |method: &str| json!({"id":7,"method":method,"params":{"threadId":"root"}});
    for (row, envelope, ready) in [
        ("idle", status(json!({"type":"idle"})), true),
        ("systemError", status(json!({"type":"systemError"})), false),
        (
            "active",
            status(json!({"type":"active","activeFlags":[]})),
            false,
        ),
        (
            "waitingOnApproval",
            status(json!({"type":"active","activeFlags":["waitingOnApproval"]})),
            false,
        ),
        (
            "waitingOnUserInput",
            status(json!({"type":"active","activeFlags":["waitingOnUserInput"]})),
            false,
        ),
        (
            "turn/started",
            json!({"method":"turn/started","params":{"threadId":"root"}}),
            false,
        ),
        (
            "turn/completed completed",
            json!({"method":"turn/completed","params":{"threadId":"root","turn":{"status":"completed"}}}),
            true,
        ),
        (
            "turn/completed failed",
            json!({"method":"turn/completed","params":{"threadId":"root","turn":{"status":"failed"}}}),
            false,
        ),
        (
            "approval",
            request("item/commandExecution/requestApproval"),
            false,
        ),
        (
            "requestUserInput",
            request("item/tool/requestUserInput"),
            false,
        ),
        (
            "a subagent's idle",
            json!({"method":"thread/status/changed","params":{"threadId":"child","status":{"type":"idle"}}}),
            false,
        ),
    ] {
        assert_eq!(codex(envelope), ready, "Codex {row}");
    }
    assert!(codex_resumed_ready_for_prompt(Some(
        &ReconciliationThreadStatus::Idle
    )));
    assert!(!codex_resumed_ready_for_prompt(Some(
        &ReconciliationThreadStatus::SystemError
    )));
    assert!(!codex_resumed_ready_for_prompt(None));

    let opencode = |event_type: &str, properties: Value| {
        opencode_root_ready_for_prompt(
            &json!({ "type": event_type, "properties": properties }),
            "root",
        )
    };
    let session_status = |kind: &str| json!({"sessionID":"root","status":{"type":kind}});
    for (event_type, properties, ready) in [
        ("session.idle", json!({"sessionID":"root"}), true),
        ("session.status", session_status("idle"), true),
        ("session.status", session_status("busy"), false),
        ("session.status", session_status("retry"), false),
        ("session.error", json!({"sessionID":"root"}), false),
        ("permission.asked", json!({"sessionID":"root"}), false),
        ("question.asked", json!({"sessionID":"root"}), false),
        ("session.idle", json!({"sessionID":"child"}), false),
    ] {
        assert_eq!(
            opencode(event_type, properties.clone()),
            ready,
            "OpenCode {event_type} {properties}"
        );
    }
}

/// A lost Codex connection cannot see the agent's next turn or approval, so a terminal that was
/// idle stops reading ready while its state stays as last reported.
#[test]
fn a_lost_codex_connection_withdraws_readiness() {
    let generation = super::TerminalObserverGeneration::new("thread".to_owned(), "term".to_owned());
    let lease = generation.observation();
    lease.publish_agent_status(Done, false);
    lease.mark_ready_for_prompt();
    let activity = super::TerminalAgentActivityControl::enabled();

    super::codex::publish_codex_observation_lost(&activity, &lease, 3);

    let status = lease.subscribe_agent_status().borrow().expect("a status");
    assert_eq!(status.state, Done);
    assert!(
        !status.ready_for_prompt,
        "a lost connection still reads ready"
    );
    assert_eq!(
        activity
            .latest_observation()
            .map(|observation| observation.kind),
        Some(super::TerminalAgentActivityObservationKind::Unavailable)
    );
}
