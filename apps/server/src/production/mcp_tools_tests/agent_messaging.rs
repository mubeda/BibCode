//! The agent messaging tools a provider-hosted agent calls, on the harness's engine.

use serde_json::{Value, json};

use super::{CREATED_AT, Harness, command, error_tag, structured};
use crate::{
    mcp::{control::McpAccess, tools::agent_messaging::run},
    production::connect_mcp::PreviewScope,
};

/// The provider credential's scope of thread `thread_id`.
fn scope(thread_id: &str) -> PreviewScope {
    PreviewScope {
        environment_id: "local".to_owned(),
        thread_id: thread_id.to_owned(),
        owner_thread_id: thread_id.to_owned(),
        provider_session_id: format!("session-{thread_id}"),
        provider_instance_id: "codex".to_owned(),
    }
}

impl Harness {
    /// Project `p2` with thread `x`, and in project `p1` a Claude thread `a`, a Codex thread `b`
    /// that is mid-turn, and a chat panel `p` whose host is `a`.
    async fn messaging_threads(&self) {
        std::fs::create_dir_all(self.state_dir.join("p2")).expect("second project folder");
        self.engine
            .dispatch(command(json!({
                "type": "project.create", "commandId": "project-create-p2", "projectId": "p2",
                "title": "Other project", "workspaceRoot": self.state_dir.join("p2"),
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("second project");
        for (thread_id, project_id, title, instance, panel_host) in [
            ("a", "p1", "Claude thread", "claudeAgent", None),
            ("b", "p1", "Codex thread", "codex", None),
            ("p", "p1", "Review panel", "codex", Some("a")),
            ("x", "p2", "Other project thread", "codex", None),
        ] {
            let mut create = json!({
                "type": "thread.create", "commandId": format!("create-{thread_id}"),
                "threadId": thread_id, "projectId": project_id, "title": title,
                "modelSelection": { "instanceId": instance, "model": "model" },
                "runtimeMode": "full-access", "createdAt": CREATED_AT,
            });
            if let Some(host) = panel_host {
                create["kind"] = json!("panel");
                create["hostThreadId"] = json!(host);
            }
            self.engine
                .dispatch(command(create))
                .await
                .expect("thread created");
        }
        self.provider_turn("b", "turn-b", "working", false).await;
    }

    async fn agents_list(&self, caller: &str, enabled: bool) -> Value {
        run(
            scope(caller),
            "agents_list",
            json!({}),
            Some(&self.messaging(enabled)),
        )
        .await
    }
}

/// The listed agents among the threads `messaging_threads` made (a project also has its default
/// thread).
fn named(result: &Value) -> Vec<&Value> {
    structured(result)["agents"]
        .as_array()
        .expect("agents")
        .iter()
        .filter(|agent| {
            ["thread:a", "thread:b", "thread:p", "thread:x"]
                .contains(&agent["address"].as_str().expect("address"))
        })
        .collect()
}

fn addresses(result: &Value) -> Vec<&str> {
    named(result)
        .into_iter()
        .map(|agent| agent["address"].as_str().expect("address"))
        .collect()
}

#[tokio::test]
async fn lists_the_other_agents_of_the_project() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness.agents_list("a", true).await;

    assert_ne!(result["isError"], true, "{result}");
    assert_eq!(
        json!(named(&result)),
        json!([
            {"address": "thread:b", "title": "Codex thread", "provider": "codex", "kind": "chat", "status": "working", "canReceive": true},
            {"address": "thread:p", "title": "Review panel", "provider": "codex", "kind": "chat", "status": "ready", "canReceive": true},
        ])
    );
    // A panel lists its host.
    let from_panel = harness.agents_list("p", true).await;
    assert_eq!(addresses(&from_panel), ["thread:a", "thread:b"]);
    assert_eq!(named(&from_panel)[0]["provider"], "claudeAgent");
    harness.shutdown().await;
}

#[tokio::test]
async fn other_projects_stay_invisible() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness.agents_list("a", true).await;

    let listed: Vec<String> = structured(&result)["agents"]
        .as_array()
        .expect("agents")
        .iter()
        .map(|agent| agent["address"].as_str().expect("address").to_owned())
        .collect();
    let project_two: Vec<String> = harness
        .repositories
        .database()
        .call(|connection| {
            let mut statement = connection
                .prepare("SELECT thread_id FROM projection_threads WHERE project_id = 'p2'")?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
        .await
        .expect("project two threads");
    assert!(project_two.contains(&"x".to_owned()));
    for thread_id in project_two {
        assert!(
            !listed.contains(&format!("thread:{thread_id}")),
            "project two's thread {thread_id} is listed"
        );
    }
    let keys: Vec<&String> = structured(&result)
        .as_object()
        .expect("object")
        .keys()
        .collect();
    assert_eq!(
        keys,
        ["agents"],
        "no count or other field hints at project two"
    );
    assert!(!result.to_string().contains("Other project"));
    harness.shutdown().await;
}

#[tokio::test]
async fn a_deleted_or_archived_thread_is_not_listed() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    harness
        .engine
        .dispatch(command(
            json!({"type": "thread.archive", "commandId": "archive-p", "threadId": "p"}),
        ))
        .await
        .expect("archived");
    harness
        .engine
        .dispatch(command(
            json!({"type": "thread.delete", "commandId": "delete-b", "threadId": "b"}),
        ))
        .await
        .expect("deleted");

    let result = harness.agents_list("a", true).await;

    assert_eq!(addresses(&result), Vec::<&str>::new());
    harness.shutdown().await;
}

#[tokio::test]
async fn default_is_off() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness.agents_list("a", false).await;

    assert_eq!(result["isError"], true);
    assert_eq!(error_tag(&result), "AgentMessagingDisabledError");
    assert_eq!(
        result["structuredContent"]["error"]["message"],
        "Agent messaging is off. Turn it on in Settings → Agents → Agent integrations."
    );
    assert!(result["structuredContent"].get("agents").is_none());
    harness.shutdown().await;
}

#[tokio::test]
async fn agents_list_takes_no_arguments_and_quotes_none() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = run(
        scope("a"),
        "agents_list",
        json!({"project": "p2-secret-value"}),
        Some(&harness.messaging(true)),
    )
    .await;

    assert_eq!(error_tag(&result), "AgentMessagingInvalidArgumentError");
    assert!(!result.to_string().contains("p2-secret-value"));
    harness.shutdown().await;
}

#[tokio::test]
async fn a_caller_whose_thread_is_gone_reaches_nobody() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;

    let result = harness.agents_list("missing", true).await;

    assert_eq!(error_tag(&result), "AgentMessagingUnknownRecipientError");
    assert_eq!(
        result["structuredContent"]["error"]["message"],
        "No agent with that address in this project. Call agents_list to see the agents you can reach."
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn an_outside_agent_cannot_call_agents_list() {
    let harness = Harness::new().await;
    harness.messaging_threads().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;

    let result = harness.call(&agent, "agents_list", json!({})).await;

    assert_eq!(error_tag(&result), "McpScopeError", "{result}");
    harness.shutdown().await;
}
