//! `agents_list`: the other chat agents and AI Terminals of the caller's project. It reads one
//! project only, so nothing of another project, not even a count, reaches the result.

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

/// The live chat threads of `project_id` except `excluded`, in creation order. `canReceive` is
/// false for a thread that runs with more access than `caller_mode`.
pub(crate) fn list_agents(
    connection: &rusqlite::Connection,
    project_id: &str,
    excluded: Option<&str>,
    caller_mode: &str,
) -> Result<Vec<AgentSummary>> {
    let mut statement = connection.prepare(
        "SELECT thread.thread_id, thread.title, thread.runtime_mode,
                COALESCE(session.provider_name, json_extract(thread.model_selection_json, '$.instanceId'), ''),
                session.status,
                thread.pending_approval_count + thread.pending_user_input_count
         FROM projection_threads AS thread
         LEFT JOIN projection_thread_sessions AS session ON session.thread_id = thread.thread_id
         WHERE thread.project_id = ?1
           AND thread.deleted_at IS NULL
           AND thread.archived_at IS NULL
           AND (?2 IS NULL OR thread.thread_id <> ?2)
         ORDER BY thread.rowid",
    )?;
    let rows = statement.query_map(params![project_id, excluded], |row| {
        let session_status: Option<String> = row.get(4)?;
        Ok(AgentSummary {
            address: format!("thread:{}", row.get::<_, String>(0)?),
            title: row.get(1)?,
            provider: row.get(3)?,
            kind: "chat",
            status: activity_status(session_status.as_deref(), row.get(5)?),
            can_receive: super::policy::ceiling_allows(caller_mode, &row.get::<_, String>(2)?),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The live threads of `project_id` that can own terminals, in creation order: a panel's
/// terminals belong to its host thread, which is one of them.
pub(crate) fn terminal_owner_threads(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> Result<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT thread_id FROM projection_threads
          WHERE project_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL
          ORDER BY rowid",
    )?;
    let rows = statement.query_map(params![project_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The providers whose AI Terminal readiness BiBCode observes, so the pointer can tell them
/// about mail. Another provider's terminal can still fetch with `bibcode agent inbox`.
const OBSERVED_TERMINAL_PROVIDERS: [&str; 3] = ["claudeAgent", "codex", "opencode"];

/// The directory entry of an AI Terminal whose process runs; `None` for a plain shell or an
/// ended process. `canReceive` is true while its readiness is observable, a busy agent included,
/// and the caller's mode reaches `full-access`, the mode a terminal receives as.
pub(crate) fn terminal_agent(
    summary: &crate::terminal::TerminalSummary,
    caller_mode: &str,
) -> Option<AgentSummary> {
    use crate::terminal::{TerminalAgentStatusState as State, TerminalStatus};

    let agent_status = summary.agent_status.as_ref()?;
    if summary.status != TerminalStatus::Running {
        return None;
    }
    let provider = summary
        .command
        .as_ref()
        .and_then(|command| command.activity.as_ref())
        .map(|activity| activity.driver_kind.clone())
        .unwrap_or_default();
    let status = match agent_status.state {
        State::Working => "working",
        State::Blocked => "blocked",
        State::Waiting => "waiting",
        State::Done if agent_status.ready_for_prompt => "ready",
        State::Done => "done",
        State::Unavailable => "unavailable",
    };
    let can_receive = OBSERVED_TERMINAL_PROVIDERS.contains(&provider.as_str())
        && agent_status.state != State::Unavailable
        && super::policy::ceiling_allows(caller_mode, super::pointer::TERMINAL_RECIPIENT_MODE);
    Some(AgentSummary {
        address: format!("terminal:{}/{}", summary.thread_id, summary.terminal_id),
        title: summary.label.clone(),
        provider,
        kind: "terminal",
        status,
        can_receive,
    })
}

/// The project and runtime mode of a live (not deleted) thread.
pub(crate) fn project_of(
    connection: &rusqlite::Connection,
    thread_id: &str,
) -> Result<Option<(String, String)>> {
    use rusqlite::OptionalExtension as _;
    Ok(connection
        .query_row(
            "SELECT project_id, runtime_mode FROM projection_threads WHERE thread_id = ?1 AND deleted_at IS NULL",
            params![thread_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::{AgentSummary, activity_status};
    use crate::{
        agent_messaging::{
            AgentCaller, AgentMessaging,
            pointer::{TerminalPointer, tests::Scripted},
            terminal_credential::TerminalIdentity,
        },
        orchestration::OrchestrationCommand,
        production::mcp_tools_tests::Harness,
        terminal::{TerminalAgentStatusState, TerminalGeneration},
    };

    const CREATED_AT: &str = "2026-11-14T00:00:00.000Z";

    struct Directory {
        harness: Harness,
        terminals: Arc<Scripted>,
        messaging: AgentMessaging,
        _other_project: tempfile::TempDir,
    }

    /// In project `p1` a Claude thread `c`, its Codex panel `d` and an approval-required thread
    /// `q`, and the Claude AI Terminal `c/term-1`; in project `p2` thread `x` with the Claude AI
    /// Terminal `x/term-9`.
    async fn directory() -> Directory {
        let harness = Harness::new().await;
        let other_project = tempfile::tempdir().expect("second project folder");
        let other = other_project.path();
        let mut commands = vec![json!({
            "type": "project.create", "commandId": "project-create-p2", "projectId": "p2",
            "title": "Other project", "workspaceRoot": other,
            "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
            "createdAt": CREATED_AT,
        })];
        for (thread_id, project_id, title, instance, mode, host) in [
            (
                "c",
                "p1",
                "Claude thread",
                "claudeAgent",
                "full-access",
                None,
            ),
            ("d", "p1", "Codex panel", "codex", "full-access", Some("c")),
            (
                "q",
                "p1",
                "Careful thread",
                "codex",
                "approval-required",
                None,
            ),
            (
                "x",
                "p2",
                "Other project thread",
                "codex",
                "full-access",
                None,
            ),
        ] {
            let mut create = json!({
                "type": "thread.create", "commandId": format!("create-{thread_id}"),
                "threadId": thread_id, "projectId": project_id, "title": title,
                "modelSelection": { "instanceId": instance, "model": "model" },
                "runtimeMode": mode, "createdAt": CREATED_AT,
            });
            if let Some(host) = host {
                create["kind"] = json!("panel");
                create["hostThreadId"] = json!(host);
            }
            commands.push(create);
        }
        for command in commands {
            let command: OrchestrationCommand = serde_json::from_value(command).expect("command");
            harness.engine.dispatch(command).await.expect("dispatched");
        }
        let terminals = Scripted::new();
        terminals.add("c", "term-1", 1, true);
        terminals.add("x", "term-9", 1, true);
        let pointer = TerminalPointer::new(
            harness.engine.repositories().database().clone(),
            terminals.clone(),
        );
        let messaging = harness.messaging(true).with_terminals(pointer);
        Directory {
            harness,
            terminals,
            messaging,
            _other_project: other_project,
        }
    }

    impl Directory {
        /// The listing of `caller`, without the project's default thread.
        async fn list(&self, caller: &AgentCaller) -> Vec<AgentSummary> {
            self.messaging
                .agents_for(caller)
                .await
                .expect("listed")
                .into_iter()
                .filter(|agent| {
                    agent.kind == "terminal"
                        || ["thread:c", "thread:d", "thread:q", "thread:x"]
                            .contains(&agent.address.as_str())
                })
                .collect()
        }

        async fn addresses(&self, caller: &AgentCaller) -> Vec<String> {
            self.list(caller)
                .await
                .into_iter()
                .map(|agent| agent.address)
                .collect()
        }
    }

    fn thread(thread_id: &str) -> AgentCaller {
        AgentCaller::Thread(thread_id.to_owned())
    }

    #[tokio::test]
    async fn two_panels_and_a_terminal() {
        let directory = directory().await;
        directory
            .terminals
            .set_state("c", "term-1", TerminalAgentStatusState::Working);
        let listed = directory.list(&thread("c")).await;
        assert_eq!(
            listed
                .iter()
                .map(|agent| (agent.address.as_str(), agent.kind))
                .collect::<Vec<_>>(),
            [
                ("thread:d", "chat"),
                ("thread:q", "chat"),
                ("terminal:c/term-1", "terminal")
            ]
        );
        assert_eq!(
            listed[2],
            AgentSummary {
                address: "terminal:c/term-1".to_owned(),
                title: "Claude term-1".to_owned(),
                provider: "claudeAgent".to_owned(),
                kind: "terminal",
                status: "working",
                can_receive: true,
            }
        );
        directory.harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_terminals_own_address_is_left_out() {
        let directory = directory().await;
        directory.terminals.add("c", "term-2", 1, true);
        let caller = AgentCaller::Terminal(TerminalIdentity {
            environment_id: "local".to_owned(),
            thread_id: "c".to_owned(),
            terminal_id: "term-1".to_owned(),
            generation: TerminalGeneration {
                boot: "boot-1".to_owned(),
                process: 1,
            },
        });
        assert_eq!(
            directory.addresses(&caller).await,
            ["thread:c", "thread:d", "thread:q", "terminal:c/term-2"]
        );
        directory.harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_plain_terminal_is_not_an_agent() {
        let directory = directory().await;
        directory.terminals.add("c", "shell", 1, false);
        assert_eq!(
            directory.addresses(&thread("d")).await,
            ["thread:c", "thread:q", "terminal:c/term-1"]
        );
        directory.harness.shutdown().await;
    }

    #[tokio::test]
    async fn a_terminal_of_another_project_stays_invisible_without_a_count() {
        let directory = directory().await;
        let listed = directory
            .messaging
            .agents_for(&thread("c"))
            .await
            .expect("listed");
        assert!(
            listed
                .iter()
                .all(|agent| agent.address != "terminal:x/term-9" && agent.address != "thread:x"),
            "{listed:?}"
        );
        assert_eq!(
            directory.addresses(&thread("x")).await,
            ["terminal:x/term-9"]
        );
        directory.harness.shutdown().await;
    }

    #[tokio::test]
    async fn can_receive_for_terminals() {
        let directory = directory().await;
        directory.terminals.add("c", "term-2", 1, true);
        directory.terminals.add("c", "term-3", 1, true);
        directory.terminals.add("c", "term-4", 1, true);
        directory
            .terminals
            .set_state("c", "term-1", TerminalAgentStatusState::Working);
        directory.terminals.set_ready("c", "term-2");
        directory
            .terminals
            .change("c", "term-3", |terminal| terminal.driver = "cursor");
        directory.terminals.set_generation("c", "term-4", None);
        let receive = |listed: &[AgentSummary]| {
            listed
                .iter()
                .filter(|agent| agent.kind == "terminal")
                .map(|agent| (agent.address.clone(), agent.status, agent.can_receive))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            receive(&directory.list(&thread("d")).await),
            [
                ("terminal:c/term-1".to_owned(), "working", true),
                ("terminal:c/term-2".to_owned(), "ready", true),
                ("terminal:c/term-3".to_owned(), "working", false),
            ],
            "an exited terminal is not listed"
        );
        // A terminal receives as full-access, which an approval-required caller does not reach.
        assert!(
            receive(&directory.list(&thread("q")).await)
                .iter()
                .all(|(_, _, can_receive)| !can_receive)
        );
        directory.harness.shutdown().await;
    }

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
