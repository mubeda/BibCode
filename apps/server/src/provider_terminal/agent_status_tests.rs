//! How each AI Terminal observer maps its provider's events to the main agent's state for the
//! left panel (#187). The Claude hook mapping and its capture path are tested in `claude.rs`.

use serde_json::{Value, json};

use super::{
    TerminalAgentState::{Blocked, Done, Waiting, Working},
    codex::codex_root_agent_status,
    opencode::opencode_root_agent_status,
};

#[test]
fn codex_root_notifications_map_to_the_main_agent_state() {
    let status = |method: &str, params: Value| {
        codex_root_agent_status(&json!({ "method": method, "params": params }), "root")
    };
    let active = |flags: Value| {
        status(
            "thread/status/changed",
            json!({"threadId":"root","status":{"type":"active","activeFlags":flags}}),
        )
    };
    assert_eq!(active(json!([])), Some((Working, false)));
    assert_eq!(active(json!(["waitingOnApproval"])), Some((Blocked, false)));
    assert_eq!(
        active(json!(["waitingOnUserInput"])),
        Some((Waiting, false))
    );
    assert_eq!(
        status(
            "thread/status/changed",
            json!({"threadId":"root","status":{"type":"idle"}})
        ),
        Some((Done, false))
    );
    assert_eq!(
        status(
            "thread/status/changed",
            json!({"threadId":"root","status":{"type":"systemError"}})
        ),
        Some((Done, true))
    );
    assert_eq!(
        status("turn/started", json!({"threadId":"root"})),
        Some((Working, false))
    );
    assert_eq!(
        status(
            "turn/completed",
            json!({"threadId":"root","turn":{"status":"failed"}})
        ),
        Some((Done, true))
    );
    assert_eq!(
        status(
            "thread/status/changed",
            json!({"threadId":"child","status":{"type":"idle"}})
        ),
        None,
        "a subagent thread leaves the root state alone"
    );
}

#[test]
fn opencode_root_events_map_to_the_main_agent_state() {
    let status = |event_type: &str, properties: Value| {
        opencode_root_agent_status(
            &json!({ "type": event_type, "properties": properties }),
            "root",
        )
    };
    assert_eq!(
        status(
            "session.status",
            json!({"sessionID":"root","status":{"type":"busy"}})
        ),
        Some((Working, false))
    );
    assert_eq!(
        status(
            "session.status",
            json!({"sessionID":"root","status":{"type":"idle"}})
        ),
        Some((Done, false))
    );
    assert_eq!(
        status("permission.asked", json!({"sessionID":"root"})),
        Some((Blocked, false))
    );
    assert_eq!(
        status("question.asked", json!({"sessionID":"root"})),
        Some((Waiting, false))
    );
    assert_eq!(
        status("session.error", json!({"sessionID":"root"})),
        Some((Done, true))
    );
    assert_eq!(
        status(
            "session.status",
            json!({"sessionID":"child","status":{"type":"busy"}})
        ),
        None,
        "a child session leaves the root state alone"
    );
}
