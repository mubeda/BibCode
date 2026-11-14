//! Harness helpers for a person's send requests (`crate::send_requests`): the server-only
//! dispatcher on the harness's own engine, provider runtime and delivery, and the threads the
//! send tests share.

use serde_json::json;

use super::{CREATED_AT, Harness, command};
use crate::{
    production::orchestration_rpc::{ServerCommandDispatcher, server_command_dispatcher},
    send_requests::service::SendRequestsService,
};

impl Harness {
    /// The server dispatcher production builds, over this harness's engine and delivery.
    pub(crate) fn server_dispatcher(&self) -> ServerCommandDispatcher {
        server_command_dispatcher(
            self.engine.clone(),
            self.provider.clone(),
            self.state_dir.clone(),
            self.delivery.clone(),
            None,
            self.uploads.clone(),
        )
    }

    pub(crate) fn send_requests(&self) -> SendRequestsService {
        SendRequestsService::new(
            self.repositories.database().clone(),
            self.repositories.clone(),
            self.server_dispatcher(),
        )
    }

    /// Threads `a` and `b` of project `p1` in different worktrees, and `c` of project `p2`.
    pub(crate) async fn send_request_threads(&self) {
        std::fs::create_dir_all(self.state_dir.join("p2")).expect("second project folder");
        self.engine
            .dispatch(command(json!({
                "type": "project.create",
                "commandId": "project-create-p2",
                "projectId": "p2",
                "title": "Other project",
                "workspaceRoot": self.state_dir.join("p2"),
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("second project");
        for (thread_id, project_id, runtime_mode, worktree) in [
            ("a", "p1", "approval-required", Some("worktree-a")),
            ("b", "p1", "full-access", Some("worktree-b")),
            ("c", "p2", "full-access", None),
        ] {
            let worktree_path = worktree.map(|name| self.state_dir.join(name));
            if let Some(path) = &worktree_path {
                std::fs::create_dir_all(path).expect("worktree folder");
            }
            self.engine
                .dispatch(command(json!({
                    "type": "thread.create", "commandId": format!("create-{thread_id}"),
                    "threadId": thread_id, "projectId": project_id, "title": thread_id,
                    "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
                    "runtimeMode": runtime_mode, "interactionMode": "default", "branch": null,
                    "worktreePath": worktree_path, "createdAt": CREATED_AT,
                })))
                .await
                .expect("thread created");
        }
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{OptionalExtension as _, params};
    use serde_json::json;

    use super::super::{
        structured,
        worktrees::{Fixture, PROJECT},
    };
    use crate::{
        mcp::control::McpAccess, rpc::RpcSessionContext,
        send_requests::service::SendRequestsSendInput,
    };

    /// `(actor_json, source_thread_id)` of a stored message.
    async fn provenance(
        harness: &super::Harness,
        message_id: String,
    ) -> Option<(Option<String>, Option<String>)> {
        harness
            .repositories
            .database()
            .call(move |connection| {
                Ok(connection
                    .query_row(
                        "SELECT actor_json, source_thread_id FROM projection_thread_messages WHERE message_id = ?",
                        params![message_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?)
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn an_outside_agent_panel_send_keeps_its_actor_after_the_extraction() {
        let fixture = Fixture::new().await;
        let harness = &fixture.harness;
        let (agent, _) = harness.agent(McpAccess::FullAccess).await;
        let created = harness
            .call(
                &agent,
                "create_worktree",
                json!({ "projectId": PROJECT, "branch": "main", "newBranch": "feature-send" }),
            )
            .await;
        let host = structured(&created)["threadId"]
            .as_str()
            .unwrap()
            .to_owned();
        let created = harness
            .call(&agent, "create_chat_panel", json!({ "hostThreadId": host }))
            .await;
        let panel = structured(&created)["threadId"]
            .as_str()
            .unwrap()
            .to_owned();

        let sent = harness
            .call(
                &agent,
                "send_panel_message",
                json!({ "fromThreadId": panel, "toThreadId": host, "text": "Please review" }),
            )
            .await;
        let message_id = structured(&sent)["messageId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| panic!("the panel message has an id: {sent}"));
        let (actor, source) = provenance(harness, message_id).await.expect("stored");
        let actor: serde_json::Value = serde_json::from_str(&actor.expect("an actor")).unwrap();
        assert_eq!(actor["kind"], "mcp-client");
        assert_eq!(actor["clientId"], agent.principal.session_id.as_str());
        assert_eq!(source.as_deref(), Some(panel.as_str()));

        harness
            .send_requests()
            .send(
                &RpcSessionContext::unauthenticated(),
                SendRequestsSendInput {
                    request_id: "person".to_owned(),
                    action: "review".to_owned(),
                    source: format!("thread:{host}"),
                    target: format!("thread:{panel}"),
                    taken_over: None,
                    lead_in: String::new(),
                    note: "Look again".to_owned(),
                    attachments: Vec::new(),
                },
            )
            .await
            .expect("a person's send is accepted");
        assert_eq!(
            provenance(harness, "person-send:person".to_owned()).await,
            Some((None, None)),
            "a person's send through the server dispatcher stores neither"
        );
        fixture.shutdown().await;
    }
}
