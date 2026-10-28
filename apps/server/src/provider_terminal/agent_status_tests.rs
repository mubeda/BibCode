//! How each AI Terminal observer maps its provider's events to the main agent's state for the
//! left panel (#187). The Claude hook mapping and its capture path are tested in `claude.rs`.

use serde_json::{Value, json};

use super::{
    TerminalAgentState::{Blocked, Done, Waiting, Working},
    codex::{codex_resumed_agent_status, codex_root_agent_status},
    model::TerminalAgentReport,
    opencode::opencode_root_agent_status,
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
