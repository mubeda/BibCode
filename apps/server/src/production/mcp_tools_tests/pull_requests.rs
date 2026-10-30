//! The pull request tools (#139 slice P) end to end, against a faked hosting service: the
//! `pullRequests.*` handlers and the `git.runStackedAction` stream are registered under their
//! real tags, so scope, admission, recorded outcomes and the live controls run as for the real
//! ones. One test reads through the real Pull Requests service with no provider CLI, to prove
//! an unavailable host is a typed failure.

use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

use super::*;
use crate::{mcp::tools::pull_requests::BODY_CHARS, rpc::RpcResult};

/// The fake host: every `pullRequests.*` request it saw, and how many create streams ran.
#[derive(Clone, Default)]
struct Host {
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    creates: Arc<AtomicUsize>,
}

const HEAD: &str = "head-1";

fn host_error(code: &str, message: &str) -> Value {
    json!({
        "_tag": "PullRequestsOperationError", "operation": "pullRequests.runAction",
        "code": code, "message": message, "hostDetail": null, "retryable": false,
    })
}

fn detail(number: u64, body: &str) -> Value {
    json!({
        "number": number, "title": "Add the thing", "body": body, "state": "open",
        "isDraft": false, "author": { "login": "octo", "name": null, "isBot": false },
        "headBranch": "feature", "baseBranch": "main", "headSha": HEAD, "baseSha": "base-1",
        "url": format!("https://example.test/pr/{number}"), "commitCount": 2,
        "changedFiles": 3, "additions": 10, "deletions": 1,
        "readiness": {
            "status": "mergeable", "summary": "Ready to merge", "details": [],
            "requiredApprovals": null, "autoMerge": null, "headSha": HEAD,
        },
        "permissions": { "merge": {
            "allowed": true, "reason": null, "methods": ["merge", "squash"],
            "defaultMethod": "squash", "deleteBranchDefault": false,
        } },
    })
}

fn checks() -> Value {
    json!({
        "summary": "failure", "pipelineUrl": null,
        "groups": [{ "name": "CI", "checks": [
            { "name": "build", "state": "success", "url": "https://example.test/c/1", "durationSeconds": 30.0 },
            { "name": "test", "state": "failure", "url": "https://example.test/c/2", "durationSeconds": 12.0 },
        ] }],
    })
}

/// The create stream the tool's title scripts: `ok` finishes, `fail` fails in the `pr`
/// phase, `cut` closes after it started.
fn create_events(payload: &Value) -> Vec<Value> {
    let started = json!({ "kind": "action_started", "phases": ["push", "pr"] });
    match payload["pullRequestTitle"].as_str().unwrap_or_default() {
        "fail" => vec![
            started,
            json!({ "kind": "action_failed", "phase": "pr", "message": "The host refused the pull request." }),
        ],
        "cut" => vec![started],
        _ => vec![
            started,
            json!({ "kind": "phase_started", "phase": "pr" }),
            json!({ "kind": "action_finished", "result": {
                "action": "create_pr",
                "branch": { "status": "skipped_not_requested" },
                "commit": { "status": "skipped_not_requested" },
                "push": { "status": "pushed", "branch": "feature" },
                "pr": {
                    "status": "created", "number": 42, "url": "https://example.test/pr/42",
                    "baseBranch": payload["pullRequestBaseBranch"],
                    "headBranch": "feature", "title": payload["pullRequestTitle"],
                },
                "toast": { "title": "Created", "cta": { "kind": "none" } },
            } }),
        ],
    }
}

impl Host {
    async fn harness(&self) -> Harness {
        let host = self.clone();
        Harness::with_methods(move |registry| {
            for tag in [
                "pullRequests.list",
                "pullRequests.get",
                "pullRequests.getChecks",
                "pullRequests.runAction",
            ] {
                let host = host.clone();
                registry.register_unary(tag, move |request, _| {
                    let host = host.clone();
                    async move { host.answer(&request.tag, request.payload) }
                });
            }
            let host = host.clone();
            registry.register_stream("git.runStackedAction", move |request, _| {
                host.creates.fetch_add(1, Ordering::SeqCst);
                let (sender, receiver) = tokio::sync::mpsc::channel(8);
                tokio::spawn(async move {
                    for event in create_events(&request.payload) {
                        if sender.send(Ok(vec![event])).await.is_err() {
                            return;
                        }
                    }
                });
                receiver
            });
        })
        .await
    }

    fn answer(&self, tag: &str, payload: Value) -> RpcResult {
        self.requests
            .lock()
            .unwrap()
            .push((tag.to_owned(), payload.clone()));
        // The real handlers decode these shapes; a payload they would refuse fails here too.
        use crate::pull_requests::model::{ActionRequest, ListQuery};
        let decodes = match tag {
            "pullRequests.list" => serde_json::from_value::<ListQuery>(payload.clone()).is_ok(),
            "pullRequests.runAction" => {
                serde_json::from_value::<ActionRequest>(payload.clone()).is_ok()
            }
            _ => payload["cwd"].is_string() && payload["number"].is_u64(),
        };
        if !decodes {
            return Err(host_error(
                "host_rejected",
                "The Pull Requests request is invalid.",
            ));
        }
        let number = payload["number"].as_u64().unwrap_or_default();
        match tag {
            "pullRequests.list" => Ok(json!({
                "rows": [{
                    "number": 7, "title": "Add the thing", "state": "open", "isDraft": false,
                    "author": { "login": "octo", "name": null, "isBot": false },
                    "createdAt": "2026-10-30T00:00:00Z", "updatedAt": "2026-10-30T01:00:00Z",
                    "mergedAt": null, "closedAt": null, "headBranch": "feature",
                    "baseBranch": "main", "labels": [], "reviewDecision": null,
                    "checksSummary": "pending", "commentCount": 0, "approvals": null,
                    "unresolvedThreads": null, "url": "https://example.test/pr/7",
                }],
                "nextCursor": "page-2", "totalCount": 31, "counts": null,
            })),
            "pullRequests.get" if number == 8 => Ok(detail(8, &"b".repeat(BODY_CHARS + 500))),
            "pullRequests.get" => Ok(detail(number, "A short body.")),
            "pullRequests.getChecks" => Ok(checks()),
            _ => match payload["action"].as_str().unwrap_or_default() {
                "merge" if payload["headSha"] != HEAD => Err(host_error(
                    "stale_head",
                    "The head commit changed. Refresh before trying again.",
                )),
                "merge" => Ok(
                    json!({ "kind": "merged", "mergedSha": "merged-1", "autoMergeEnabled": false }),
                ),
                "setDraft" if number == 9 => Err(host_error(
                    "forbidden",
                    "This account does not have permission for this operation.",
                )),
                _ => Ok(json!({ "kind": "done" })),
            },
        }
    }

    fn requests(&self, tag: &str) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(seen, _)| seen == tag)
            .map(|(_, payload)| payload.clone())
            .collect()
    }

    fn creates(&self) -> usize {
        self.creates.load(Ordering::SeqCst)
    }
}

async fn setup(host: &Host) -> (Harness, ClientPrincipal, String) {
    let harness = host.harness().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    (harness, agent, thread_id)
}

#[tokio::test]
async fn reads_list_a_page_view_one_with_its_head_and_list_its_checks() {
    let host = Host::default();
    let (harness, agent, thread) = setup(&host).await;

    let listed = harness
        .call(
            &agent,
            "list_pull_requests",
            json!({ "threadId": thread, "cursor": "page-1" }),
        )
        .await;
    let listed = structured(&listed);
    assert_eq!(listed["pullRequests"][0]["number"], 7);
    assert_eq!(listed["pullRequests"][0]["headBranch"], "feature");
    assert_eq!(listed["pullRequests"][0]["author"], "octo");
    assert_eq!(listed["nextCursor"], "page-2");
    let query = &host.requests("pullRequests.list")[0];
    assert_eq!(query["state"], "open");
    assert_eq!(query["cursor"], "page-1");
    // The real handler decodes a full `ListQuery`; these have no serde default.
    assert_eq!(query["labels"], json!([]));
    assert_eq!(query["sort"], "newest");
    let bad = harness
        .call(
            &agent,
            "list_pull_requests",
            json!({ "threadId": thread, "state": "draft" }),
        )
        .await;
    assert_eq!(error_tag(&bad), "McpInvalidArgumentError");

    let viewed = harness
        .call(
            &agent,
            "view_pull_request",
            json!({ "threadId": thread, "number": 7 }),
        )
        .await;
    let viewed = structured(&viewed);
    assert_eq!(viewed["headSha"], HEAD);
    assert_eq!(viewed["readiness"]["status"], "mergeable");
    assert_eq!(viewed["merge"]["methods"], json!(["merge", "squash"]));
    assert_eq!(viewed["checks"]["summary"], "failure");
    assert_eq!(viewed["checks"]["failing"], json!(["test"]));
    assert_eq!(viewed["body"], "A short body.");
    assert_eq!(viewed["bodyTruncated"], false);

    let checked = harness
        .call(
            &agent,
            "pull_request_checks",
            json!({ "threadId": thread, "number": 7 }),
        )
        .await;
    let checked = structured(&checked);
    assert_eq!(checked["summary"], "failure");
    assert_eq!(checked["checks"][1]["name"], "test");
    assert_eq!(checked["checks"][1]["state"], "failure");

    // A number that is no pull request number is refused before the host is asked.
    let before = host.requests("pullRequests.get").len();
    for number in [json!(0), json!(-3), json!("7")] {
        let refused = harness
            .call(
                &agent,
                "view_pull_request",
                json!({ "threadId": thread, "number": number }),
            )
            .await;
        assert_eq!(error_tag(&refused), "McpInvalidArgumentError");
    }
    assert_eq!(host.requests("pullRequests.get").len(), before);
    harness.shutdown().await;
}

#[tokio::test]
async fn view_cuts_a_long_body_and_reports_its_length() {
    let host = Host::default();
    let (harness, agent, thread) = setup(&host).await;
    let viewed = harness
        .call(
            &agent,
            "view_pull_request",
            json!({ "threadId": thread, "number": 8 }),
        )
        .await;
    let viewed = structured(&viewed);
    assert_eq!(viewed["body"].as_str().unwrap().chars().count(), BODY_CHARS);
    assert_eq!(viewed["bodyLength"], BODY_CHARS + 500);
    assert_eq!(viewed["bodyTruncated"], true);
    harness.shutdown().await;
}

#[tokio::test]
async fn create_returns_its_number_and_url_and_a_keyed_retry_creates_none() {
    let host = Host::default();
    let (harness, agent, thread) = setup(&host).await;
    let arguments = json!({
        "threadId": thread, "title": "Add the thing", "body": "Why.", "baseBranch": "main",
        "draft": true, "clientRequestId": "create-1",
    });
    let created = harness
        .call(&agent, "create_pull_request", arguments.clone())
        .await;
    let first = structured(&created).clone();
    assert_eq!(first["status"], "created");
    assert_eq!(first["number"], 42);
    assert_eq!(first["url"], "https://example.test/pr/42");
    assert_eq!(first["push"], "pushed");
    let again = harness
        .call(&agent, "create_pull_request", arguments.clone())
        .await;
    assert_eq!(structured(&again), &first);
    assert_eq!(host.creates(), 1);

    // The same id with another title is a conflict and runs nothing.
    let mut other = arguments;
    other["title"] = json!("Something else");
    let conflict = harness.call(&agent, "create_pull_request", other).await;
    assert_eq!(error_tag(&conflict), "idempotency_conflict");
    assert_eq!(host.creates(), 1);

    // Without a base branch nothing is created.
    let refused = harness
        .call(
            &agent,
            "create_pull_request",
            json!({ "threadId": thread, "title": "No base" }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpInvalidArgumentError");
    assert_eq!(host.creates(), 1);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_create_that_fails_is_a_typed_failure_a_keyed_retry_replays() {
    let host = Host::default();
    let (harness, agent, thread) = setup(&host).await;
    let arguments = json!({
        "threadId": thread, "title": "fail", "baseBranch": "main", "clientRequestId": "create-fail",
    });
    let failed = harness
        .call(&agent, "create_pull_request", arguments.clone())
        .await;
    assert_eq!(error_tag(&failed), "GitActionFailedError");
    assert_eq!(failed["structuredContent"]["error"]["phase"], "pr");
    let again = harness.call(&agent, "create_pull_request", arguments).await;
    assert_eq!(again, failed);
    assert_eq!(host.creates(), 1);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_create_whose_stream_closes_early_is_unknown_never_success() {
    let host = Host::default();
    let (harness, agent, thread) = setup(&host).await;
    let arguments = json!({
        "threadId": thread, "title": "cut", "baseBranch": "main", "clientRequestId": "create-cut",
    });
    let cut = harness
        .call(&agent, "create_pull_request", arguments.clone())
        .await;
    assert_eq!(error_tag(&cut), "McpOutcomeUnknownError");
    assert_eq!(cut["structuredContent"]["error"]["reason"], "stream-ended");
    let again = harness.call(&agent, "create_pull_request", arguments).await;
    assert_eq!(again, cut);
    assert_eq!(host.creates(), 1);
    harness.shutdown().await;
}

#[tokio::test]
async fn merge_sends_the_head_never_bypass_and_a_stale_head_is_refused() {
    let host = Host::default();
    let (harness, agent, thread) = setup(&host).await;

    let merged = harness
        .call(
            &agent,
            "merge_pull_request",
            json!({ "threadId": thread, "number": 7, "method": "squash", "headSha": HEAD, "deleteBranch": true }),
        )
        .await;
    assert_eq!(structured(&merged)["mergedSha"], "merged-1");
    let sent = &host.requests("pullRequests.runAction")[0];
    assert_eq!(sent["action"], "merge");
    assert_eq!(sent["bypass"], false);
    assert_eq!(sent["headSha"], HEAD);
    assert_eq!(sent["method"], "squash");
    assert_eq!(sent["deleteBranch"], true);
    assert_eq!(sent["auto"], false);

    let stale = harness
        .call(
            &agent,
            "merge_pull_request",
            json!({ "threadId": thread, "number": 7, "method": "merge", "headSha": "old-head" }),
        )
        .await;
    assert_eq!(error_tag(&stale), "PullRequestsOperationError");
    assert_eq!(stale["structuredContent"]["error"]["code"], "stale_head");

    // An agent cannot ask for an admin bypass, and cannot merge without the head it read.
    let asked = harness
        .call(
            &agent,
            "merge_pull_request",
            json!({ "threadId": thread, "number": 7, "method": "merge", "headSha": HEAD, "bypass": true }),
        )
        .await;
    assert_eq!(error_tag(&asked), "McpInvalidArgumentError");
    let headless = harness
        .call(
            &agent,
            "merge_pull_request",
            json!({ "threadId": thread, "number": 7, "method": "merge" }),
        )
        .await;
    assert_eq!(error_tag(&headless), "McpInvalidArgumentError");
    let requests = host.requests("pullRequests.runAction");
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|sent| sent["bypass"] == false));

    // Merging is destructive: it is listed so, and never as safe to repeat.
    let tools = harness.control.tools(&agent);
    let merge = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "merge_pull_request")
        .unwrap();
    assert_eq!(merge["annotations"]["destructiveHint"], true);
    assert_eq!(merge["annotations"]["idempotentHint"], false);
    assert_eq!(merge["annotations"]["openWorldHint"], true);
    harness.shutdown().await;
}

#[tokio::test]
async fn update_edits_then_sets_draft_and_names_a_partial_change() {
    let host = Host::default();
    let (harness, agent, thread) = setup(&host).await;

    let updated = harness
        .call(
            &agent,
            "update_pull_request",
            json!({ "threadId": thread, "number": 7, "title": "Better title", "draft": false }),
        )
        .await;
    assert_eq!(structured(&updated)["updated"], json!(["title", "draft"]));
    let sent = host.requests("pullRequests.runAction");
    assert_eq!(sent[0]["action"], "editPullRequest");
    assert_eq!(sent[0]["title"], "Better title");
    assert_eq!(sent[0]["body"], Value::Null);
    assert_eq!(sent[1]["action"], "setDraft");
    assert_eq!(sent[1]["draft"], false);

    // The title changed but the draft state did not: a keyed retry replays that truth.
    let arguments = json!({
        "threadId": thread, "number": 9, "title": "Retitled", "draft": true,
        "clientRequestId": "update-partial",
    });
    let partial = harness
        .call(&agent, "update_pull_request", arguments.clone())
        .await;
    assert_eq!(error_tag(&partial), "McpPartialOutcomeError");
    assert_eq!(
        partial["structuredContent"]["error"]["updated"],
        json!(["title"])
    );
    assert_eq!(partial["structuredContent"]["error"]["code"], "forbidden");
    let calls = host.requests("pullRequests.runAction").len();
    let again = harness.call(&agent, "update_pull_request", arguments).await;
    assert_eq!(again, partial);
    assert_eq!(host.requests("pullRequests.runAction").len(), calls);

    let empty = harness
        .call(
            &agent,
            "update_pull_request",
            json!({ "threadId": thread, "number": 7 }),
        )
        .await;
    assert_eq!(error_tag(&empty), "McpInvalidArgumentError");
    harness.shutdown().await;
}

#[tokio::test]
async fn read_only_hides_the_writes_and_source_control_off_hides_every_tool() {
    let host = Host::default();
    let (harness, agent, thread) = setup(&host).await;
    let names = |harness: &Harness, agent: &ClientPrincipal| -> Vec<String> {
        harness
            .control
            .tools(agent)
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
            .filter(|name| name.contains("pull_request"))
            .collect()
    };
    assert_eq!(names(&harness, &agent).len(), 6);

    let (reader, _) = harness.agent(McpAccess::ReadOnly).await;
    assert_eq!(
        names(&harness, &reader),
        [
            "list_pull_requests",
            "view_pull_request",
            "pull_request_checks"
        ]
    );
    let refused = harness
        .call(
            &reader,
            "merge_pull_request",
            json!({ "threadId": thread, "number": 7, "method": "merge", "headSha": HEAD }),
        )
        .await;
    assert_eq!(refused["isError"], true);
    assert!(host.requests("pullRequests.runAction").is_empty());

    harness.settings.send_modify(|settings| {
        settings.capabilities.source_control = false;
    });
    assert!(names(&harness, &agent).is_empty());
    let refused = harness
        .call(&agent, "list_pull_requests", json!({ "threadId": thread }))
        .await;
    assert_eq!(error_tag(&refused), "McpCapabilityDisabledError");
    assert!(host.requests("pullRequests.list").is_empty());
    harness.shutdown().await;
}

#[tokio::test]
async fn an_unavailable_host_is_a_typed_failure_not_an_empty_list() {
    let runner_state = tempfile::tempdir().expect("runner state");
    let harness = Harness::with_methods(|registry| {
        let service = crate::pull_requests::PullRequestsService::with_runner(
            crate::pull_requests::host::HostCommandRunner::new(runner_state.path().to_path_buf())
                .with_commands(
                    runner_state.path().join("missing-gh"),
                    runner_state.path().join("missing-glab"),
                    runner_state.path().join("missing-git"),
                ),
        );
        crate::production::pull_requests_rpc::register_pull_requests_rpc(
            registry,
            crate::production::pull_requests_rpc::ConfiguredPullRequestsRpcServices {
                service,
                repositories: None,
                worktrees: None,
            },
        );
    })
    .await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread, _) = start(&harness, &agent, basic_start()).await;
    let listed = harness
        .call(&agent, "list_pull_requests", json!({ "threadId": thread }))
        .await;
    assert_eq!(error_tag(&listed), "PullRequestsOperationError", "{listed}");
    assert!(listed["structuredContent"].get("pullRequests").is_none());
    harness.shutdown().await;
}
