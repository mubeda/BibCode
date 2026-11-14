//! `agents_list`: the other chat agents of the caller's project. It reads one project only, so
//! nothing of another project, not even a count, reaches the result.

use rusqlite::params;
use serde::Serialize;

use crate::persistence::Result;

/// One entry of `agents_list`, with the field names of the `AgentSummary` contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSummary {
    pub(crate) address: String,
    pub(crate) title: String,
    pub(crate) provider: String,
    pub(crate) kind: &'static str,
    pub(crate) status: &'static str,
    pub(crate) can_receive: bool,
}

/// The activity status of a chat agent from its session and its open requests.
fn activity_status(session_status: Option<&str>, open_requests: i64) -> &'static str {
    if open_requests > 0 {
        return "waiting";
    }
    match session_status {
        Some("running" | "starting") => "working",
        Some("error") => "error",
        Some("stopped") => "stopped",
        _ => "ready",
    }
}

/// The live chat threads of `project_id` except `caller_thread_id`, in creation order.
pub(crate) fn list_agents(
    connection: &rusqlite::Connection,
    project_id: &str,
    caller_thread_id: &str,
) -> Result<Vec<AgentSummary>> {
    let mut statement = connection.prepare(
        "SELECT thread.thread_id, thread.title,
                COALESCE(session.provider_name, json_extract(thread.model_selection_json, '$.instanceId'), ''),
                session.status,
                thread.pending_approval_count + thread.pending_user_input_count
         FROM projection_threads AS thread
         LEFT JOIN projection_thread_sessions AS session ON session.thread_id = thread.thread_id
         WHERE thread.project_id = ?1
           AND thread.deleted_at IS NULL
           AND thread.archived_at IS NULL
           AND thread.thread_id <> ?2
         ORDER BY thread.rowid",
    )?;
    let rows = statement.query_map(params![project_id, caller_thread_id], |row| {
        let session_status: Option<String> = row.get(3)?;
        Ok(AgentSummary {
            address: format!("thread:{}", row.get::<_, String>(0)?),
            title: row.get(1)?,
            provider: row.get(2)?,
            kind: "chat",
            status: activity_status(session_status.as_deref(), row.get(4)?),
            can_receive: true,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The project of a live (not deleted) thread.
pub(crate) fn project_of(
    connection: &rusqlite::Connection,
    thread_id: &str,
) -> Result<Option<String>> {
    use rusqlite::OptionalExtension as _;
    Ok(connection
        .query_row(
            "SELECT project_id FROM projection_threads WHERE thread_id = ?1 AND deleted_at IS NULL",
            params![thread_id],
            |row| row.get(0),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::activity_status;

    #[test]
    fn activity_status_follows_the_session_and_open_requests() {
        assert_eq!(activity_status(Some("running"), 0), "working");
        assert_eq!(activity_status(Some("starting"), 0), "working");
        assert_eq!(activity_status(Some("running"), 1), "waiting");
        assert_eq!(activity_status(Some("ready"), 2), "waiting");
        assert_eq!(activity_status(Some("ready"), 0), "ready");
        assert_eq!(activity_status(None, 0), "ready");
        assert_eq!(activity_status(Some("error"), 0), "error");
        assert_eq!(activity_status(Some("stopped"), 0), "stopped");
    }
}
