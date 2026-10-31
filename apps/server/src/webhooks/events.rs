//! The webhook event catalog, and how each event is made from its durable source: an entry of
//! X3's change feed (`changes_since`), a profiler finding, or a person's **Send test event**.
//!
//! A payload is `{ id, type, occurredAt, environmentId, threadId?, actor?, cursor?, kind?,
//! status?, requestId?, tool?, target?, finding? }`: ids, kinds, statuses and the feed cursor
//! only. Every event made from the feed carries that entry's `cursor`, so a receiver that
//! missed deliveries calls `changes_since { cursor }` from the last one it processed;
//! `profiler.finding` carries `finding: { id, count, lastSeen }` instead, and a receiver
//! catches up with `profiler_findings { since: lastSeen }`. No prompt, message, reply,
//! terminal output, file content, diff, token or secret is ever read into an event; the one
//! free-text field, an agent's label, goes through `redact_sensitive_text`.

use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

use crate::mcp::control::{McpCapability, PrincipalKind, tool_spec};

pub(crate) const THREAD_STATUS_CHANGED: &str = "thread.status_changed";
pub(crate) const WORKTREE_CREATED: &str = "worktree.created";
pub(crate) const PANEL_CREATED: &str = "panel.created";
pub(crate) const APPROVAL_REQUESTED: &str = "approval.requested";
pub(crate) const APPROVAL_RESOLVED: &str = "approval.resolved";
pub(crate) const CLONE_COMPLETED: &str = "clone.completed";
pub(crate) const SCM_OPERATION_COMPLETED: &str = "scm.operation_completed";
pub(crate) const TRANSFER_COMPLETED: &str = "transfer.completed";
pub(crate) const TRANSFER_FAILED: &str = "transfer.failed";
pub(crate) const PROFILER_FINDING: &str = "profiler.finding";
pub(crate) const WEBHOOK_TEST: &str = "webhook.test";

/// Every event an endpoint can subscribe to, with its category (`webhook.test` goes only to
/// the endpoint it is sent to, whatever its filters).
pub(crate) const EVENT_TYPES: &[(&str, &str)] = &[
    (THREAD_STATUS_CHANGED, "threads"),
    (WORKTREE_CREATED, "threads"),
    (PANEL_CREATED, "threads"),
    (APPROVAL_REQUESTED, "approvals"),
    (APPROVAL_RESOLVED, "approvals"),
    (CLONE_COMPLETED, "operations"),
    (SCM_OPERATION_COMPLETED, "operations"),
    (TRANSFER_COMPLETED, "operations"),
    (TRANSFER_FAILED, "operations"),
    (PROFILER_FINDING, "diagnostics"),
];

pub(crate) fn is_event_type(name: &str) -> bool {
    EVENT_TYPES.iter().any(|(event, _)| *event == name)
}

/// One event, before it is addressed to endpoints.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Event {
    pub(crate) event_type: &'static str,
    /// The same for every delivery and redelivery of this event, so a receiver drops repeats.
    pub(crate) id: String,
    pub(crate) occurred_at: String,
    pub(crate) thread_id: Option<String>,
    /// For an endpoint's project filter; not in the payload.
    pub(crate) project_id: Option<String>,
    /// The rest of the payload: `actor`, `cursor`, `kind`, `status`, `requestId`, `tool`,
    /// `target` or `finding`.
    pub(crate) fields: Map<String, Value>,
}

impl Event {
    /// The JSON body sent for this event.
    pub(crate) fn body(&self, environment_id: &str) -> String {
        let mut payload = Map::new();
        payload.insert("id".to_owned(), self.id.clone().into());
        payload.insert("type".to_owned(), self.event_type.into());
        payload.insert("occurredAt".to_owned(), self.occurred_at.clone().into());
        payload.insert("environmentId".to_owned(), environment_id.into());
        if let Some(thread_id) = &self.thread_id {
            payload.insert("threadId".to_owned(), thread_id.clone().into());
        }
        for (key, value) in &self.fields {
            payload.insert(key.clone(), value.clone());
        }
        Value::Object(payload).to_string()
    }
}

fn event_id(event_type: &str, source: &str) -> String {
    let digest = Sha256::digest(format!("{event_type}|{source}").as_bytes());
    format!("ev_{}", crate::mcp::endpoint::hex(&digest[..12]))
}

/// What the dispatcher knows about an entry's thread: its project and whether it has a
/// worktree, read from the projection when the entry is mapped.
pub(crate) type ThreadRoute = Option<(String, bool)>;

/// The event an X3 change-feed entry makes, if any. `route` is the entry's thread's.
pub(crate) fn from_feed_entry(entry: &Value, route: ThreadRoute) -> Option<Event> {
    let kind = entry.get("kind")?.as_str()?;
    let cursor = entry.get("cursor")?.as_str()?;
    let thread_id = entry
        .get("threadId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let event_type = match kind {
        "turn.started" | "turn.completed" | "turn.interrupted" | "turn.failed"
        | "session.status" => THREAD_STATUS_CHANGED,
        "thread.created" if route.as_ref().is_some_and(|(_, worktree)| *worktree) => {
            WORKTREE_CREATED
        }
        "panel.created" => PANEL_CREATED,
        "approval.requested" => APPROVAL_REQUESTED,
        "approval.resolved" => APPROVAL_RESOLVED,
        "agent.call" => agent_call_event(entry)?,
        _ => return None,
    };
    let mut fields = Map::new();
    fields.insert("cursor".to_owned(), cursor.into());
    fields.insert("kind".to_owned(), kind.into());
    for key in ["status", "requestId", "tool", "target"] {
        if let Some(value) = entry.get(key).filter(|value| !value.is_null()) {
            fields.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(actor) = entry.get("actor").and_then(redacted_actor) {
        fields.insert("actor".to_owned(), actor);
    }
    Some(Event {
        event_type,
        id: event_id(event_type, cursor),
        occurred_at: entry
            .get("at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        thread_id,
        project_id: route.map(|(project, _)| project),
        fields,
    })
}

/// An outside agent's call as an operation event: a clone, a Source Control or pull request
/// change, or a transfer the transfer route served (the route's row names no thread; the
/// `files_upload` call that minted the URL does, and is not an event).
fn agent_call_event(entry: &Value) -> Option<&'static str> {
    let tool = entry.get("tool")?.as_str()?;
    let success = entry.get("status").and_then(Value::as_str) == Some("success");
    match tool {
        "clone_repository" => Some(CLONE_COMPLETED),
        "files_upload" | "files_download" if entry.get("threadId").is_none() => Some(if success {
            TRANSFER_COMPLETED
        } else {
            TRANSFER_FAILED
        }),
        _ => tool_spec(PrincipalKind::Client, tool)
            .filter(|spec| spec.capability == Some(McpCapability::SourceControl))
            .map(|_| SCM_OPERATION_COMPLETED),
    }
}

/// An actor with its label passed through `redact_sensitive_text`.
fn redacted_actor(actor: &Value) -> Option<Value> {
    let kind = actor.get("kind")?.as_str()?;
    let client_id = actor.get("clientId")?.as_str()?;
    let label = actor
        .get("label")
        .and_then(Value::as_str)
        .map(crate::diagnostics::redact_sensitive_text);
    Some(json!({ "kind": kind, "clientId": client_id, "label": label }))
}

/// A profiler finding that appeared or recurred: `finding: { id, count, lastSeen }`.
pub(crate) fn from_finding(id: &str, count: u64, last_seen: &str) -> Event {
    let mut fields = Map::new();
    fields.insert(
        "finding".to_owned(),
        json!({ "id": id, "count": count, "lastSeen": last_seen }),
    );
    Event {
        event_type: PROFILER_FINDING,
        id: event_id(PROFILER_FINDING, &format!("{id}|{count}")),
        occurred_at: last_seen.to_owned(),
        thread_id: None,
        project_id: None,
        fields,
    }
}

/// A person's **Send test event**.
pub(crate) fn test_event(occurred_at: String) -> Event {
    Event {
        event_type: WEBHOOK_TEST,
        id: format!("ev_{}", uuid::Uuid::new_v4().simple()),
        occurred_at,
        thread_id: None,
        project_id: None,
        fields: Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str) -> Value {
        json!({ "at": "2026-10-31T00:00:00Z", "kind": kind, "threadId": "t1", "cursor": "v1.7.2" })
    }

    #[test]
    fn feed_entries_map_to_the_catalog() {
        let route = Some(("p1".to_owned(), false));
        for (kind, expected) in [
            ("turn.started", Some(THREAD_STATUS_CHANGED)),
            ("turn.completed", Some(THREAD_STATUS_CHANGED)),
            ("turn.interrupted", Some(THREAD_STATUS_CHANGED)),
            ("turn.failed", Some(THREAD_STATUS_CHANGED)),
            ("session.status", Some(THREAD_STATUS_CHANGED)),
            ("panel.created", Some(PANEL_CREATED)),
            ("approval.requested", Some(APPROVAL_REQUESTED)),
            ("approval.resolved", Some(APPROVAL_RESOLVED)),
            ("thread.created", None),
            ("thread.archived", None),
            ("turn.requested", None),
            ("input.requested", None),
        ] {
            let event = from_feed_entry(&entry(kind), route.clone());
            assert_eq!(event.map(|event| event.event_type), expected, "{kind}");
        }
        let created = from_feed_entry(&entry("thread.created"), Some(("p1".to_owned(), true)))
            .expect("a worktree thread");
        assert_eq!(created.event_type, WORKTREE_CREATED);
        assert_eq!(created.project_id.as_deref(), Some("p1"));
        assert_eq!(created.fields["cursor"], "v1.7.2");
    }

    #[test]
    fn agent_calls_map_by_tool_and_set() {
        let call = |tool: &str, status: &str, thread: bool| {
            let mut entry = json!({ "at": "t", "kind": "agent.call", "cursor": "v1.1.1", "tool": tool, "status": status, "target": {}, "actor": { "kind": "mcp-client", "clientId": "s", "label": "Claude Code" } });
            if thread {
                entry["threadId"] = "t1".into();
            }
            from_feed_entry(&entry, None).map(|event| event.event_type)
        };
        assert_eq!(
            call("git_commit", "success", true),
            Some(SCM_OPERATION_COMPLETED)
        );
        assert_eq!(
            call("merge_pull_request", "McpBusyError", true),
            Some(SCM_OPERATION_COMPLETED)
        );
        assert_eq!(
            call("clone_repository", "success", false),
            Some(CLONE_COMPLETED)
        );
        assert_eq!(
            call("files_download", "success", false),
            Some(TRANSFER_COMPLETED)
        );
        assert_eq!(
            call("files_upload", "TransferTooLargeError", false),
            Some(TRANSFER_FAILED)
        );
        // The call that minted an upload URL names its thread; only the route's row counts.
        assert_eq!(call("files_upload", "success", true), None);
        assert_eq!(call("start_thread", "success", true), None);
        assert_eq!(call("files_write", "success", true), None);
    }

    #[test]
    fn a_payload_holds_ids_and_states_only() {
        let event = from_feed_entry(
            &json!({ "at": "2026-10-31T00:00:00Z", "kind": "approval.requested", "threadId": "t1", "cursor": "v1.9.0", "requestId": "req-1", "actor": { "kind": "mcp-client", "clientId": "s1", "label": "Agent token=hunter2" } }),
            Some(("p1".to_owned(), false)),
        )
        .expect("an event");
        let body: Value = serde_json::from_str(&event.body("env-1")).expect("json");
        assert_eq!(body["type"], APPROVAL_REQUESTED);
        assert_eq!(body["environmentId"], "env-1");
        assert_eq!(body["threadId"], "t1");
        assert_eq!(body["cursor"], "v1.9.0");
        assert_eq!(body["requestId"], "req-1");
        assert!(body.get("projectId").is_none());
        assert!(!body.to_string().contains("hunter2"), "{body}");
        // The same entry always makes the same event id.
        assert_eq!(
            event.id,
            from_feed_entry(
                &json!({ "kind": "approval.requested", "cursor": "v1.9.0" }),
                None
            )
            .unwrap()
            .id
        );
        let finding = from_finding("f1", 3, "2026-10-31T00:00:01Z");
        let body: Value = serde_json::from_str(&finding.body("env-1")).unwrap();
        assert_eq!(
            body["finding"],
            json!({ "id": "f1", "count": 3, "lastSeen": "2026-10-31T00:00:01Z" })
        );
        assert!(body.get("cursor").is_none());
    }
}
