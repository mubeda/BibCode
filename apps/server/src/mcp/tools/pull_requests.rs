//! The pull request tools (#139 slice P): list, view and read the checks of the pull requests
//! of the repository a thread works in, create one from its branch, edit it, and merge it.
//!
//! They reach the handlers the Pull Requests panel and the Source Control panel use:
//! `pullRequests.*`, and `git.runStackedAction` with `create_pr` for a create, so the host's
//! defaults and its warnings for options it could not apply are the UI's. Writes carry no
//! command receipt, so they run through [`ToolCall::recorded`]: at most once per
//! `clientRequestId`, under the live controls, and never recorded as success when the outcome
//! cannot be known. A merge always sends `bypass: false` and needs the `headSha` the agent
//! read, so the host refuses it when the head moved. Pull request bodies and check names are
//! untrusted output.

use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    auth::{SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ},
    mcp::{
        control::{
            CLIENT_REQUEST_ID, Family, McpCapability, ProgressSink, ToolCall, ToolFuture,
            ToolResult, ToolSpec, invalid_argument, object_schema,
        },
        protocol::{chars, tool_result, typed_tool_failure},
    },
};

/// The characters of a pull request body `view_pull_request` returns.
pub(crate) const BODY_CHARS: usize = 16_000;
/// `pullRequestTitle` and `pullRequestBody` limits of `git.runStackedAction`.
const MOST_TITLE_CHARS: usize = 256;
const MOST_BODY_CHARS: usize = 65_536;
/// JavaScript's largest safe integer, the hosts' and the contract's bound for a number.
const MOST_NUMBER: i64 = 9_007_199_254_740_991;
/// Failing check names `view_pull_request` lists.
const MOST_FAILING: usize = 20;

const READ: &str = SCOPE_ORCHESTRATION_READ;
const OPERATE: &str = SCOPE_ORCHESTRATION_OPERATE;
const SOURCE_CONTROL: Option<McpCapability> = Some(McpCapability::SourceControl);
const RUN_ACTION: &str = "pullRequests.runAction";
const STACKED_ACTION: &str = "git.runStackedAction";

/// The pull request tools, in the order `tools/list` shows them.
pub(crate) const TOOLS: &[ToolSpec] = &[
    ToolSpec::client("list_pull_requests", READ, &["pullRequests.list"])
        .reads()
        .open_world()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client(
        "view_pull_request",
        READ,
        &["pullRequests.get", "pullRequests.getChecks"],
    )
    .reads()
    .open_world()
    .in_set(SOURCE_CONTROL),
    ToolSpec::client("pull_request_checks", READ, &["pullRequests.getChecks"])
        .reads()
        .open_world()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("create_pull_request", OPERATE, &[STACKED_ACTION])
        .open_world()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("update_pull_request", OPERATE, &[RUN_ACTION])
        .open_world()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("merge_pull_request", OPERATE, &[RUN_ACTION])
        .destroys()
        .open_world()
        .in_set(SOURCE_CONTROL),
];

pub(crate) const FAMILY: Family = Family {
    tools: TOOLS,
    text,
    call,
};

fn call<'a>(
    call: &'a ToolCall<'a>,
    name: &'a str,
    _progress: Option<(ProgressSink, Value)>,
) -> ToolFuture<'a> {
    Box::pin(async move {
        match name {
            "list_pull_requests" => call.list_pull_requests().await,
            "view_pull_request" => call.view_pull_request().await,
            "pull_request_checks" => call.pull_request_checks().await,
            "create_pull_request" => call.create_pull_request().await,
            "update_pull_request" => call.update_pull_request().await,
            "merge_pull_request" => call.merge_pull_request().await,
            _ => Err(typed_tool_failure("McpUnknownToolError", "Unknown tool.")),
        }
    })
}

fn text(name: &str) -> Option<(&'static str, Value)> {
    let thread = json!({ "type": "string", "description": "A thread id, as list_projects_and_threads returns it. The tool works on the repository of the folder the thread works in." });
    let number =
        json!({ "type": "integer", "minimum": 1, "description": "The pull request's number." });
    let request_id = json!({ "type": "string", "description": CLIENT_REQUEST_ID });
    let object = object_schema;
    Some(match name {
        "list_pull_requests" => (
            "A page of the pull requests of the thread's repository, newest first: number, title, state, draft, author, head and base branch, checks and review summary, and URL. nextCursor reads the next page.",
            object(
                json!({
                    "threadId": thread,
                    "state": { "type": "string", "enum": ["open", "closed", "merged", "all"], "description": "open unless set." },
                    "cursor": { "type": "string", "description": "nextCursor of the previous page." },
                }),
                &["threadId"],
            ),
        ),
        "view_pull_request" => (
            "One pull request: its state, branches, headSha (merge_pull_request needs it), merge readiness, the merge methods this account may use, a checks summary, and its body cut at 16000 characters with its full length.",
            object(
                json!({ "threadId": thread, "number": number }),
                &["threadId", "number"],
            ),
        ),
        "pull_request_checks" => (
            "A pull request's checks: the overall summary and each check's name, state and URL.",
            object(
                json!({ "threadId": thread, "number": number }),
                &["threadId", "number"],
            ),
        ),
        "create_pull_request" => (
            "Opens a pull request from the thread's branch (or headBranch) into baseBranch, pushing the branch first when it has unpushed commits, as Source Control's Create pull request does. Commit the changes first. Returns its number and URL; when one is already open for the branch, it returns that one (status opened_existing). If it returns McpOutcomeUnknownError, call list_pull_requests and look for one whose headBranch is this branch before you create again.",
            object(
                json!({
                    "threadId": thread,
                    "title": { "type": "string", "maxLength": MOST_TITLE_CHARS },
                    "body": { "type": "string", "maxLength": MOST_BODY_CHARS },
                    "baseBranch": { "type": "string", "description": "The branch to merge into, such as main." },
                    "headBranch": { "type": "string", "description": "The branch to open it from; the thread's current branch unless set." },
                    "draft": { "type": "boolean", "description": "Open it as a draft. Off unless set." },
                    "clientRequestId": request_id,
                }),
                &["threadId", "title", "baseBranch"],
            ),
        ),
        "update_pull_request" => (
            "Changes a pull request's title, body or draft state. Give at least one.",
            object(
                json!({
                    "threadId": thread,
                    "number": number,
                    "title": { "type": "string", "maxLength": MOST_TITLE_CHARS },
                    "body": { "type": "string", "maxLength": MOST_BODY_CHARS },
                    "draft": { "type": "boolean", "description": "true marks it a draft, false ready for review." },
                    "clientRequestId": request_id,
                }),
                &["threadId", "number"],
            ),
        ),
        "merge_pull_request" => (
            "Merges a pull request, or with auto turns on auto-merge. It never bypasses branch protection. headSha must be the head view_pull_request returned: when the branch moved since, the host refuses the merge. Merge only when the person asked for it.",
            object(
                json!({
                    "threadId": thread,
                    "number": number,
                    "method": { "type": "string", "enum": ["merge", "squash", "rebase"] },
                    "headSha": { "type": "string", "description": "headSha from view_pull_request." },
                    "deleteBranch": { "type": "boolean", "description": "Delete the head branch after the merge. Off unless set." },
                    "auto": { "type": "boolean", "description": "Merge when the requirements are met instead of now. Off unless set." },
                    "clientRequestId": request_id,
                }),
                &["threadId", "number", "method", "headSha"],
            ),
        ),
        _ => return None,
    })
}

/// `text`'s first `limit` characters.
fn cut(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// A count of each check state, and the names of failing checks.
fn checks_summary(checks: &Value) -> Value {
    let mut counts = serde_json::Map::new();
    let mut failing = Vec::new();
    let mut failing_total = 0_usize;
    for check in checks_of(checks) {
        let state = check["state"].as_str().unwrap_or("neutral");
        let count = counts.entry(state.to_owned()).or_insert(json!(0));
        *count = json!(count.as_u64().unwrap_or(0) + 1);
        if state == "failure" {
            failing_total += 1;
            if failing.len() < MOST_FAILING {
                failing.push(check["name"].clone());
            }
        }
    }
    json!({
        "summary": checks["summary"],
        "counts": counts,
        "failing": failing,
        "failingTotal": failing_total,
    })
}

fn checks_of(checks: &Value) -> impl Iterator<Item = &Value> {
    checks["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|group| group["checks"].as_array().into_iter().flatten())
}

impl ToolCall<'_> {
    /// `number`, refused at the tool when it is no pull request number.
    fn number(&self) -> Result<i64, Value> {
        self.integer("number")?
            .filter(|number| (1..=MOST_NUMBER).contains(number))
            .ok_or_else(|| invalid_argument("number must be a pull request number, 1 or more"))
    }

    /// The optional text `key`, at most `limit` characters; a title may not be blank.
    fn bounded_text(&self, key: &str, limit: usize, blank: bool) -> Result<Option<String>, Value> {
        match self.string(key)? {
            None => Ok(None),
            Some(text) if !blank && text.trim().is_empty() => {
                Err(invalid_argument(&format!("{key} may not be empty")))
            }
            Some(text) if chars(text) > limit => Err(invalid_argument(&format!(
                "{key} is at most {limit} characters"
            ))),
            Some(text) => Ok(Some(if blank {
                text.to_owned()
            } else {
                text.trim().to_owned()
            })),
        }
    }

    async fn list_pull_requests(&self) -> ToolResult {
        self.only(&["threadId", "state", "cursor"])?;
        let thread_id = self.required("threadId")?;
        let state = self.string("state")?.unwrap_or("open");
        if !matches!(state, "open" | "closed" | "merged" | "all") {
            return Err(invalid_argument(
                "state is one of open, closed, merged and all",
            ));
        }
        let cursor = self.string("cursor")?;
        let target = self.target(thread_id).await?;
        let page = self
            .invoke(
                "pullRequests.list",
                json!({
                    "cwd": target.cwd, "state": state, "labels": [], "sort": "newest",
                    "cursor": cursor, "refreshTotals": false,
                }),
            )
            .await?;
        let rows: Vec<Value> = page["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|row| {
                json!({
                    "number": row["number"],
                    "title": row["title"],
                    "state": row["state"],
                    "isDraft": row["isDraft"],
                    "author": row["author"]["login"],
                    "headBranch": row["headBranch"],
                    "baseBranch": row["baseBranch"],
                    "checks": row["checksSummary"],
                    "reviewDecision": row["reviewDecision"],
                    "updatedAt": row["updatedAt"],
                    "url": row["url"],
                })
            })
            .collect();
        // The host's cursor is opaque, so no row is dropped to fit: a page of rows this
        // compact stays far below the result cap.
        Ok(tool_result(
            json!({
                "threadId": thread_id,
                "pullRequests": rows,
                "totalCount": page["totalCount"],
                "nextCursor": page["nextCursor"],
            }),
            &[],
        ))
    }

    async fn view_pull_request(&self) -> ToolResult {
        self.only(&["threadId", "number"])?;
        let thread_id = self.required("threadId")?;
        let number = self.number()?;
        let target = self.target(thread_id).await?;
        let payload = json!({ "cwd": target.cwd, "number": number });
        let (detail, checks) = tokio::join!(
            self.invoke("pullRequests.get", payload.clone()),
            self.invoke("pullRequests.getChecks", payload),
        );
        let detail = detail?;
        let body = detail["body"].as_str().unwrap_or_default();
        let body_length = chars(body);
        let merge = &detail["permissions"]["merge"];
        let checks = match checks {
            Ok(checks) => checks_summary(&checks),
            // The detail is still worth returning; say why the checks are missing.
            Err(failure) => json!({ "error": failure["structuredContent"]["error"] }),
        };
        Ok(tool_result(
            json!({
                "threadId": thread_id,
                "number": detail["number"],
                "title": detail["title"],
                "state": detail["state"],
                "isDraft": detail["isDraft"],
                "author": detail["author"]["login"],
                "headBranch": detail["headBranch"],
                "baseBranch": detail["baseBranch"],
                "headSha": detail["headSha"],
                "url": detail["url"],
                "commitCount": detail["commitCount"],
                "changedFiles": detail["changedFiles"],
                "additions": detail["additions"],
                "deletions": detail["deletions"],
                "readiness": {
                    "status": detail["readiness"]["status"],
                    "summary": detail["readiness"]["summary"],
                    "details": detail["readiness"]["details"],
                    "requiredApprovals": detail["readiness"]["requiredApprovals"],
                    "autoMerge": detail["readiness"]["autoMerge"],
                },
                "merge": {
                    "allowed": merge["allowed"],
                    "reason": merge["reason"],
                    "methods": merge["methods"],
                    "defaultMethod": merge["defaultMethod"],
                },
                "checks": checks,
                "body": cut(body, BODY_CHARS),
                "bodyLength": body_length,
                "bodyTruncated": body_length > BODY_CHARS,
            }),
            &[],
        ))
    }

    async fn pull_request_checks(&self) -> ToolResult {
        self.only(&["threadId", "number"])?;
        let thread_id = self.required("threadId")?;
        let number = self.number()?;
        let target = self.target(thread_id).await?;
        let checks = self
            .invoke(
                "pullRequests.getChecks",
                json!({ "cwd": target.cwd, "number": number }),
            )
            .await?;
        let listed: Vec<Value> = checks_of(&checks)
            .map(|check| {
                json!({
                    "name": check["name"],
                    "state": check["state"],
                    "url": check["url"],
                    "durationSeconds": check["durationSeconds"],
                })
            })
            .collect();
        Ok(tool_result(
            json!({
                "threadId": thread_id,
                "number": number,
                "summary": checks["summary"],
                "pipelineUrl": checks["pipelineUrl"],
                "hostTruncated": checks["truncated"],
                "checks": listed,
            }),
            &[("/checks", crate::mcp::protocol::Cut::Back)],
        ))
    }

    async fn create_pull_request(&self) -> ToolResult {
        self.only(&[
            "threadId",
            "title",
            "body",
            "baseBranch",
            "headBranch",
            "draft",
            "clientRequestId",
        ])?;
        let thread_id = self.required("threadId")?;
        let title = self
            .bounded_text("title", MOST_TITLE_CHARS, false)?
            .ok_or_else(|| invalid_argument("title is required"))?;
        let body = self.bounded_text("body", MOST_BODY_CHARS, true)?;
        let base = self.required("baseBranch")?.trim().to_owned();
        let head = self
            .string("headBranch")?
            .map(str::trim)
            .filter(|head| !head.is_empty());
        let draft = self.boolean("draft")?.unwrap_or(false);
        let target = self.target(thread_id).await?;
        let mut payload = json!({
            "actionId": format!("mcp-{}", Uuid::new_v4()),
            "cwd": target.cwd,
            "action": "create_pr",
            "pullRequestTitle": title,
            "pullRequestBaseBranch": base,
        });
        if let Some(body) = body {
            payload["pullRequestBody"] = body.into();
        }
        if let Some(head) = head {
            payload["pullRequestHeadBranch"] = head.into();
        }
        // Sent only for a draft, so every other create keeps the host's own defaults.
        if draft {
            payload["pullRequestOptions"] = json!({
                "draft": true, "assignees": [], "reviewers": [], "labels": [],
                "milestone": null, "removeSourceBranch": null, "squash": null,
            });
        }
        let stream = payload.clone();
        let thread_id = thread_id.to_owned();
        self.recorded("create_pull_request", &payload, move |owned| async move {
            let outcome = owned.invoke_stream(STACKED_ACTION, stream).await?;
            let result = &outcome.terminal["result"];
            let pr = &result["pr"];
            Ok(tool_result(
                json!({
                    "threadId": thread_id,
                    "status": pr["status"],
                    "number": pr["number"],
                    "url": pr["url"],
                    "title": pr["title"],
                    "baseBranch": pr["baseBranch"],
                    "headBranch": pr["headBranch"],
                    "push": result["push"]["status"],
                    "warning": pr["warning"],
                }),
                &[],
            ))
        })
        .await
    }

    async fn update_pull_request(&self) -> ToolResult {
        self.only(&[
            "threadId",
            "number",
            "title",
            "body",
            "draft",
            "clientRequestId",
        ])?;
        let thread_id = self.required("threadId")?;
        let number = self.number()?;
        let title = self.bounded_text("title", MOST_TITLE_CHARS, false)?;
        let body = self.bounded_text("body", MOST_BODY_CHARS, true)?;
        let draft = self.boolean("draft")?;
        if title.is_none() && body.is_none() && draft.is_none() {
            return Err(invalid_argument("give title, body or draft"));
        }
        let target = self.target(thread_id).await?;
        let mut updated = Vec::new();
        if title.is_some() {
            updated.push("title");
        }
        if body.is_some() {
            updated.push("body");
        }
        let edit = (!updated.is_empty()).then(|| {
            json!({
                "action": "editPullRequest", "cwd": target.cwd, "number": number,
                "title": title, "body": body, "baseBranch": null,
            })
        });
        let set_draft = draft.map(|draft| {
            json!({ "action": "setDraft", "cwd": target.cwd, "number": number, "draft": draft })
        });
        let payload = json!([edit, set_draft]);
        self.recorded("update_pull_request", &payload, move |owned| async move {
            if let Some(edit) = edit {
                owned.invoke(RUN_ACTION, edit).await?;
            }
            if let Some(set_draft) = set_draft {
                if let Err(failure) = owned.invoke(RUN_ACTION, set_draft).await {
                    if updated.is_empty() {
                        return Err(failure);
                    }
                    return Err(partial(&updated, &failure));
                }
                updated.push("draft");
            }
            Ok(tool_result(
                json!({ "number": number, "updated": updated }),
                &[],
            ))
        })
        .await
    }

    async fn merge_pull_request(&self) -> ToolResult {
        self.only(&[
            "threadId",
            "number",
            "method",
            "headSha",
            "deleteBranch",
            "auto",
            "clientRequestId",
        ])?;
        let thread_id = self.required("threadId")?;
        let number = self.number()?;
        let method = self.required("method")?;
        if !matches!(method, "merge" | "squash" | "rebase") {
            return Err(invalid_argument(
                "method is one of merge, squash and rebase",
            ));
        }
        let head_sha = self.required("headSha")?.trim().to_owned();
        let delete_branch = self.boolean("deleteBranch")?.unwrap_or(false);
        let auto = self.boolean("auto")?.unwrap_or(false);
        let target = self.target(thread_id).await?;
        // `bypass` (an admin merge past branch protection) is never sent.
        let payload = json!({
            "action": "merge", "cwd": target.cwd, "number": number, "method": method,
            "deleteBranch": delete_branch, "auto": auto, "bypass": false, "headSha": head_sha,
            "subject": null, "body": null,
        });
        let action = payload.clone();
        self.recorded("merge_pull_request", &payload, move |owned| async move {
            let merged = owned.invoke(RUN_ACTION, action).await?;
            Ok(tool_result(
                json!({
                    "number": number,
                    "mergedSha": merged["mergedSha"],
                    "autoMergeEnabled": merged["autoMergeEnabled"],
                }),
                &[],
            ))
        })
        .await
    }
}

/// The edit landed but the draft change did not: a partial outcome naming what changed, so a
/// keyed retry replays the truth and the agent retries only the draft change.
fn partial(updated: &[&str], failure: &Value) -> Value {
    let error = &failure["structuredContent"]["error"];
    let mut partial = typed_tool_failure(
        "McpPartialOutcomeError",
        &format!(
            "The pull request's {} changed, but its draft state did not: {} Call update_pull_request with draft alone to retry it.",
            updated.join(" and "),
            error["message"].as_str().unwrap_or("the host refused it.")
        ),
    );
    let fields = &mut partial["structuredContent"]["error"];
    fields["updated"] = json!(updated);
    fields["failed"] = "draft".into();
    fields["cause"] = error["_tag"].clone();
    fields["code"] = error["code"].clone();
    partial
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_checks_summary_counts_states_and_names_failures() {
        let summary = checks_summary(&json!({
            "summary": "failure",
            "groups": [
                { "name": "CI", "checks": [
                    { "name": "build", "state": "success" },
                    { "name": "test", "state": "failure" },
                ] },
                { "name": "Lint", "checks": [{ "name": "lint", "state": "failure" }] },
            ],
        }));
        assert_eq!(summary["summary"], "failure");
        assert_eq!(summary["counts"], json!({ "success": 1, "failure": 2 }));
        assert_eq!(summary["failing"], json!(["test", "lint"]));
        assert_eq!(summary["failingTotal"], 2);
    }

    #[test]
    fn every_tool_is_in_source_control_and_reaches_a_host() {
        for spec in TOOLS {
            assert_eq!(spec.capability, SOURCE_CONTROL, "{}", spec.name);
            assert!(spec.open_world && spec.long_running, "{}", spec.name);
            assert!(text(spec.name).is_some(), "{}", spec.name);
        }
        let merge = TOOLS.iter().find(|spec| spec.name == "merge_pull_request");
        assert!(merge.is_some_and(|spec| spec.destructive && spec.audited && !spec.idempotent));
        assert!(
            TOOLS
                .iter()
                .filter(|spec| !spec.read_only)
                .all(|spec| !spec.idempotent)
        );
    }
}
