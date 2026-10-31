//! The worktree tools (#139 slice W): list a project's worktrees, create one with its host
//! thread, read a removal plan, and remove one.
//!
//! They reach the worktree catalog's own handlers, so a removal records its profiler outcome
//! there (`worktree_audit::record_removal_outcome`, once per real removal and never for a
//! replay) and finishes in the catalog's operation runtime even when the MCP call is
//! cancelled. Creation and removal carry a `commandId`, so a retry with the same
//! `clientRequestId` replays the stored request by its receipt ([`ToolCall::commands`]).

use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    auth::{SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ},
    mcp::{
        control::{
            CLIENT_REQUEST_ID, Family, McpAccess, ProgressSink, ToolCall, ToolFuture, ToolResult,
            ToolSpec, invalid_argument, object_schema, storage_failure,
        },
        protocol::{Cut, fit_list, tool_result, typed_tool_failure},
    },
    persistence::ProjectionThread,
};

const READ: &str = SCOPE_ORCHESTRATION_READ;
const OPERATE: &str = SCOPE_ORCHESTRATION_OPERATE;
const CREATE: &str = "worktree.createManaged";
const REMOVE: &str = "worktree.remove";
const DETACH: &str = "worktree.removeFromBibCode";
const DEFAULT_LIST_LIMIT: usize = 50;
const MOST_LIST_LIMIT: usize = 200;

/// The worktree tools, in the order `tools/list` shows them.
pub(crate) const TOOLS: &[ToolSpec] = &[
    ToolSpec::client("list_worktrees", READ, &["vcs.refreshWorktreeCatalog"]).reads(),
    ToolSpec::client("create_worktree", OPERATE, &[CREATE]),
    ToolSpec::client(
        "get_worktree_removal_plan",
        READ,
        &["worktree.getRemovalPlan"],
    )
    .reads(),
    ToolSpec::client("remove_worktree", OPERATE, &[REMOVE, DETACH]).destroys(),
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
            "list_worktrees" => call.list_worktrees().await,
            "create_worktree" => call.create_worktree().await,
            "get_worktree_removal_plan" => call.get_worktree_removal_plan().await,
            "remove_worktree" => call.remove_worktree().await,
            _ => Err(typed_tool_failure("McpUnknownToolError", "Unknown tool.")),
        }
    })
}

fn text(name: &str) -> Option<(&'static str, Value)> {
    let project = json!({ "type": "string", "description": "A project id, as list_projects_and_threads returns it." });
    let host = json!({ "type": "string", "description": "The worktree's host thread, as list_worktrees names it (hostThreadId)." });
    let request_id = json!({ "type": "string", "description": CLIENT_REQUEST_ID });
    let object = object_schema;
    Some(match name {
        "list_worktrees" => (
            "A project's Git worktrees: each one's path, branch, availability, whether it is the primary checkout or locked, and hostThreadId, the BiBCode thread that hosts it (null when BiBCode does not track it). scanStatus says when Git could not be read. Change counts come from get_worktree_removal_plan or git_status.",
            object(
                json!({
                    "projectId": project,
                    "limit": { "type": "integer", "minimum": 1, "maximum": MOST_LIST_LIMIT, "description": "Worktrees per page; 50 unless set." },
                    "cursor": { "type": "string", "description": "nextCursor of the previous page." },
                }),
                &["projectId"],
            ),
        ),
        "create_worktree" => (
            "Creates a Git worktree for a project and its host thread, and returns the threadId, path and branch. branch is the branch to check out; with newBranch, a new branch is created from it. Start work in it with send_message to the threadId. The thread runs at runtimeMode, never above this connection's limit, with the project's default model unless providerInstanceId and model are set.",
            object(
                json!({
                    "projectId": project,
                    "branch": { "type": "string", "description": "The branch to check out, or with newBranch the branch or commit to start from." },
                    "newBranch": { "type": "string", "description": "A branch to create for the worktree." },
                    "baseBranch": { "type": "string", "description": "The branch the new branch is compared against, when it differs from branch." },
                    "title": { "type": "string", "description": "The host thread's title; the branch name unless set." },
                    "providerInstanceId": { "type": "string", "description": "An instance id from list_providers_and_models." },
                    "model": { "type": "string", "description": "A model slug from list_providers_and_models." },
                    "runtimeMode": {
                        "type": "string",
                        "enum": ["approval-required", "auto-accept-edits", "full-access"],
                        "description": "The host thread's mode; this connection's limit unless set, and never above it.",
                    },
                    "clientRequestId": request_id,
                }),
                &["projectId", "branch"],
            ),
        ),
        "get_worktree_removal_plan" => (
            "What removing a worktree would do: trackedChangeCount and untrackedFileCount (removing the folder loses them), availability, whether Git has it locked, and the other stale worktrees a removal would prune. Pass its planToken and generation to remove_worktree, after telling the person what will be lost.",
            object(json!({ "threadId": host }), &["threadId"]),
        ),
        "remove_worktree" => (
            "Removes a worktree and its host thread. mode delete deletes the folder with git worktree remove, and cleanup clears Git's registration of a folder that is already gone (plan availability missing-registered); both need planToken and expectedGeneration exactly as get_worktree_removal_plan returned them, and refuse a worktree that changed since. delete refuses uncommitted changes unless discardChanges is true, which loses them for good. detach removes the worktree from BiBCode only and keeps the folder and its changes. Use it only when the person asked for this removal.",
            object(
                json!({
                    "threadId": host,
                    "mode": { "type": "string", "enum": ["delete", "cleanup", "detach"] },
                    "planToken": { "type": "string", "description": "From get_worktree_removal_plan; required for delete and cleanup." },
                    "expectedGeneration": { "type": "integer", "minimum": 0, "description": "The plan's generation; required for delete and cleanup." },
                    "discardChanges": { "type": "boolean", "description": "Delete even with uncommitted changes, losing them. Off unless set." },
                    "confirmRepositoryWidePrune": { "type": "boolean", "description": "Also prune the other stale worktrees the plan lists (pruneImpact). Off unless set." },
                    "clientRequestId": request_id,
                }),
                &["threadId", "mode"],
            ),
        ),
        _ => return None,
    })
}

/// The descriptor fields an agent needs, joined with the host thread's status.
fn worktree_entry(worktree: &Value, host: Option<&Value>) -> Value {
    json!({
        "worktreeKey": worktree["worktreeKey"],
        "path": worktree["path"],
        "branch": worktree["branch"],
        "head": worktree["head"],
        "primary": worktree["isPrimary"],
        "locked": worktree["locked"],
        "registration": worktree["registrationState"],
        "availability": host.map_or(&worktree["directoryState"], |host| &host["availability"]),
        "hostThreadId": host.map_or(&worktree["adoptedThreadId"], |host| &host["threadId"]),
    })
}

impl ToolCall<'_> {
    async fn list_worktrees(&self) -> ToolResult {
        self.only(&["projectId", "limit", "cursor"])?;
        let project_id = self.required("projectId")?;
        let limit = self.integer("limit")?.map_or(DEFAULT_LIST_LIMIT, |limit| {
            usize::try_from(limit)
                .unwrap_or(MOST_LIST_LIMIT)
                .clamp(1, MOST_LIST_LIMIT)
        });
        let offset = match self.string("cursor")? {
            None => 0,
            Some(cursor) => cursor
                .strip_prefix("w:")
                .and_then(|offset| offset.parse::<usize>().ok())
                .ok_or_else(|| invalid_argument("cursor is not one this tool returned"))?,
        };
        let snapshot = self
            .invoke(
                "vcs.refreshWorktreeCatalog",
                json!({ "projectId": project_id }),
            )
            .await?;
        let hosts = snapshot["adoptedWorkspaces"]
            .as_array()
            .map_or(&[][..], Vec::as_slice);
        let worktrees = snapshot["worktrees"]
            .as_array()
            .map_or(&[][..], Vec::as_slice);
        let mut entries: Vec<Value> = worktrees
            .iter()
            .map(|worktree| {
                let host = hosts
                    .iter()
                    .find(|host| host["worktreeKey"] == worktree["worktreeKey"]);
                worktree_entry(worktree, host)
            })
            .collect();
        // A host whose folder Git no longer lists still names a worktree to clean up.
        entries.extend(
            hosts
                .iter()
                .filter(|host| {
                    !worktrees
                        .iter()
                        .any(|worktree| worktree["worktreeKey"] == host["worktreeKey"])
                })
                .map(|host| {
                    json!({
                        "worktreeKey": host["worktreeKey"],
                        "path": host["path"],
                        "branch": host["branch"],
                        "head": null,
                        "primary": false,
                        "locked": host["locked"],
                        "registration": host["registrationState"],
                        "availability": host["availability"],
                        "hostThreadId": host["threadId"],
                    })
                }),
        );
        let total = entries.len();
        let page: Vec<Value> = entries.into_iter().skip(offset).take(limit).collect();
        let mut next = offset + page.len();
        let mut content = json!({
            "projectId": project_id,
            "scanStatus": snapshot["scanStatus"],
            "worktrees": page,
            "worktreeCount": total,
            "nextCursor": null,
        });
        next -= fit_list(&mut content, "/worktrees", Cut::Back, 1);
        content["nextCursor"] = (next < total).then(|| format!("w:{next}")).into();
        Ok(tool_result(content, &[]))
    }

    async fn create_worktree(&self) -> ToolResult {
        self.only(&[
            "projectId",
            "branch",
            "newBranch",
            "baseBranch",
            "title",
            "providerInstanceId",
            "model",
            "runtimeMode",
            "clientRequestId",
        ])?;
        let project_id = self.required("projectId")?;
        let branch = self.required("branch")?.trim();
        let new_branch = self.trimmed("newBranch")?;
        let base_branch = self.trimmed("baseBranch")?;
        let asked_mode = match self.string("runtimeMode")? {
            None => None,
            Some(mode) => Some(
                McpAccess::parse(mode)
                    .filter(|level| *level != McpAccess::ReadOnly)
                    .ok_or_else(|| {
                        invalid_argument(
                            "runtimeMode is approval-required, auto-accept-edits or full-access",
                        )
                    })?,
            ),
        };
        // A retry with a known clientRequestId replays the stored request instead; its
        // top-level `runtimeMode` lets `commands` re-check the ceiling while the engine has not
        // accepted it.
        let fresh = async || {
            let ceiling = self.control.effective_ceiling(self.principal);
            let runtime_mode = asked_mode.unwrap_or(ceiling);
            if runtime_mode > ceiling {
                return Err(typed_tool_failure(
                    "McpAccessCeilingError",
                    &format!(
                        "runtimeMode {} is above this MCP connection's limit ({}). Raise Settings → Agents → Agent integrations → Agents may, then restart the MCP server in your agent.",
                        runtime_mode.as_str(),
                        ceiling.as_str()
                    ),
                ));
            }
            let project = self
                .control
                .repositories()
                .get_project(project_id.to_owned())
                .await
                .map_err(storage_failure)?
                .filter(|project| project.deleted_at.is_none())
                .ok_or_else(|| {
                    typed_tool_failure(
                        "McpProjectNotFoundError",
                        &format!("No project {project_id}; list_projects_and_threads lists them."),
                    )
                })?;
            let selection = self
                .default_model_selection(
                    &project,
                    self.string("providerInstanceId")?,
                    self.string("model")?,
                )
                .await?;
            let title = self
                .trimmed("title")?
                .or(new_branch)
                .unwrap_or(branch)
                .to_owned();
            let command_id = Uuid::new_v4().to_string();
            Ok(vec![json!({
                "commandId": command_id,
                "runtimeMode": runtime_mode.as_str(),
                "payload": {
                    "commandId": command_id,
                    "projectId": project_id,
                    "threadId": Uuid::new_v4().to_string(),
                    "title": title,
                    "refName": branch,
                    "newRefName": new_branch,
                    "baseRefName": base_branch,
                    "threadDefaults": {
                        "modelSelection": selection,
                        "runtimeMode": runtime_mode.as_str(),
                        "interactionMode": "default",
                    },
                },
            })])
        };
        let stored = self.stored("create_worktree", fresh).await?;
        let created = self.invoke(CREATE, stored["payload"].clone()).await?;
        Ok(tool_result(
            json!({
                "threadId": created["threadId"],
                "path": created["path"],
                "branch": created["refName"],
                "runtimeMode": stored["runtimeMode"],
                "modelSelection": stored["payload"]["threadDefaults"]["modelSelection"],
            }),
            &[],
        ))
    }

    async fn get_worktree_removal_plan(&self) -> ToolResult {
        self.only(&["threadId"])?;
        let thread_id = self.required("threadId")?;
        let host = self.worktree_host(thread_id).await?;
        let mut plan = self
            .invoke(
                "worktree.getRemovalPlan",
                json!({ "projectId": host.project_id, "threadId": thread_id }),
            )
            .await?;
        plan["threadId"] = thread_id.into();
        Ok(tool_result(plan, &[("/pruneImpact", Cut::Back)]))
    }

    async fn remove_worktree(&self) -> ToolResult {
        self.only(&[
            "threadId",
            "mode",
            "planToken",
            "expectedGeneration",
            "discardChanges",
            "confirmRepositoryWidePrune",
            "clientRequestId",
        ])?;
        let thread_id = self.required("threadId")?;
        let mode = self.required("mode")?;
        let git_mode = match mode {
            "delete" => Some("delete-git-worktree"),
            "cleanup" => Some("cleanup-stale-registration"),
            "detach" => None,
            _ => return Err(invalid_argument("mode is delete, cleanup or detach")),
        };
        let discard_changes = self.boolean("discardChanges")?.unwrap_or(false);
        let prune = self.boolean("confirmRepositoryWidePrune")?.unwrap_or(false);
        let plan = match git_mode {
            Some(_) => Some((
                self.required("planToken")?,
                self.integer("expectedGeneration")?.ok_or_else(|| {
                    invalid_argument(
                        "expectedGeneration is required: pass the generation get_worktree_removal_plan returned",
                    )
                })?,
            )),
            None if discard_changes || prune => {
                return Err(invalid_argument(
                    "detach keeps the folder and its changes; discardChanges and confirmRepositoryWidePrune apply to delete and cleanup",
                ));
            }
            None => None,
        };
        // Resolved only for a new request: after a removal the thread is gone, and a retry
        // replays the stored request by its receipt.
        let fresh = async || {
            let host = self.worktree_host(thread_id).await?;
            let command_id = Uuid::new_v4().to_string();
            let (method, payload) = match (git_mode, plan) {
                (Some(git_mode), Some((plan_token, generation))) => (
                    REMOVE,
                    json!({
                        "commandId": command_id,
                        "projectId": host.project_id,
                        "threadId": thread_id,
                        "mode": git_mode,
                        "expectedGeneration": generation,
                        "planToken": plan_token,
                        "forceDirty": discard_changes,
                        "confirmRepositoryWidePrune": prune,
                    }),
                ),
                _ => (
                    DETACH,
                    json!({
                        "commandId": command_id,
                        "projectId": host.project_id,
                        "threadId": thread_id,
                    }),
                ),
            };
            Ok(vec![
                json!({ "commandId": command_id, "method": method, "payload": payload }),
            ])
        };
        let stored = self.stored("remove_worktree", fresh).await?;
        let method = match stored["method"].as_str() {
            Some(method @ (REMOVE | DETACH)) => method,
            _ => {
                return Err(storage_failure(
                    "a stored remove_worktree request has no method",
                ));
            }
        };
        // A removal the catalog took over finishes even when this call is cancelled (C4: a
        // handler-owned operation), so it runs under the server's token, not the call's.
        let handed_off = ToolCall {
            cancellation: self.control.shutdown_token(),
            ..*self
        };
        let removed = handed_off.invoke(method, stored["payload"].clone()).await?;
        Ok(tool_result(
            json!({
                "threadId": thread_id,
                "mode": mode,
                "threadRemoved": removed["threadRemoved"],
                "gitOutcome": removed["gitOutcome"],
                "orphanCleanupPending": removed["orphanCleanupPending"],
                "detail": removed.get("detail"),
            }),
            &[],
        ))
    }

    /// The one request `tool` stores: a receipt-backed RPC payload under `payload`.
    async fn stored(
        &self,
        tool: &str,
        fresh: impl AsyncFnOnce() -> Result<Vec<Value>, Value>,
    ) -> Result<Value, Value> {
        self.commands(tool, None, fresh)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| storage_failure(format!("a stored {tool} request has no payload")))
    }

    /// The host thread of a worktree. A thread that works in its project's folder, or in a
    /// worktree another thread hosts, is refused before any RPC.
    async fn worktree_host(&self, thread_id: &str) -> Result<ProjectionThread, Value> {
        let thread = self.thread(thread_id).await?;
        if thread
            .worktree_path
            .as_deref()
            .is_none_or(|path| path.trim().is_empty())
        {
            return Err(typed_tool_failure(
                "McpNotAWorktreeError",
                "This thread works in its project's folder, not in a worktree.",
            ));
        }
        if thread.kind != "workspace" {
            return Err(typed_tool_failure(
                "McpNotAWorktreeError",
                &match &thread.host_thread_id {
                    Some(host) => format!(
                        "This thread works in a worktree that thread {host} hosts; pass that threadId."
                    ),
                    None => "This thread does not host its worktree; list_worktrees names each worktree's hostThreadId.".to_owned(),
                },
            ));
        }
        Ok(thread)
    }

    /// The trimmed string at `key`, or `None` when it is absent or blank.
    fn trimmed(&self, key: &str) -> Result<Option<&str>, Value> {
        Ok(self
            .string(key)?
            .map(str::trim)
            .filter(|value| !value.is_empty()))
    }
}
