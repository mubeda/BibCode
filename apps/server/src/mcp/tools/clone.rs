//! The clone tools (#139 slice X6): clone a public HTTPS repository next to a registered
//! project and register it, read how a clone went, and cancel one.
//!
//! `clone_repository` is always one owned mutation ([`ToolCall::recorded`]), keyed by the
//! agent's `clientRequestId` or, without one, by a key the server mints; that key is the
//! `cloneId`. The owned task runs `vcs.clone` without `detach`, then `project.create`, so
//! nothing is left for a caller that went away. The call waits up to 50 seconds and then
//! answers `{ state: "running", cloneId }`; `clone_status` reads the recorded outcome later.
//!
//! The live controls (off switch, read-only, revocation, Stop, Take over, shutdown) and
//! `cancel_clone` stop the clone by dropping the task's `vcs.clone` call: the clone runtime then
//! cancels a clone this task started and removes its folder, and leaves alone a clone it only
//! joined, such as one a person started. A clone stopped before Git finished is `unknown`,
//! because Git may have finished at the same instant.
//!
//! `vcs.clone` applies the agent clone policy itself (`git::clone_policy`): HTTPS only, public
//! hosts, the checked address pinned, redirects and LFS smudge off. A refusal is the clone's
//! recorded failure, a `GitCommandError` with its `reason`.

use std::{
    collections::HashMap,
    future::Future,
    path::Path,
    sync::{LazyLock, Mutex},
    time::Duration,
};

use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    auth::{SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ},
    git::clone_destination_leaf,
    mcp::{
        control::{
            CLIENT_REQUEST_ID, Family, ProgressSink, ToolCall, ToolFuture, ToolResult, ToolSpec,
            invalid_argument, now_iso, object_schema, rpc_failure, storage_failure,
        },
        outcome::{OUTCOME_UNKNOWN_TAG, Owned, outcome_unknown},
        protocol::{tool_result, typed_tool_failure},
    },
};

const READ: &str = SCOPE_ORCHESTRATION_READ;
const OPERATE: &str = SCOPE_ORCHESTRATION_OPERATE;
const TOOL: &str = "clone_repository";
const CLONE: &str = "vcs.clone";
const DISPATCH: &str = "orchestration.dispatchCommand";
/// How long `clone_repository` waits before it answers `running`.
const CLONE_WAIT: Duration = Duration::from_secs(50);
/// How long `cancel_clone` waits for the stopped clone's outcome.
const CANCEL_WAIT: Duration = Duration::from_secs(15);
const NOT_FOUND_TAG: &str = "McpCloneNotFoundError";
const CANCELLED_TAG: &str = "McpCancelledError";

/// The clone tools, in the order `tools/list` shows them.
pub(crate) const TOOLS: &[ToolSpec] = &[
    ToolSpec::client(TOOL, OPERATE, &[CLONE, DISPATCH]).open_world(),
    ToolSpec::client("clone_status", READ, &[]).reads(),
    ToolSpec::client("cancel_clone", OPERATE, &[]).runs_long(),
];

pub(crate) const FAMILY: Family = Family {
    tools: TOOLS,
    text,
    call,
};

#[cfg(test)]
tokio::task_local! {
    /// A shorter `clone_repository` wait for the calls a test makes on its own task.
    pub(crate) static WAIT_FOR_TEST: Duration;
}

fn clone_wait() -> Duration {
    #[cfg(test)]
    if let Ok(wait) = WAIT_FOR_TEST.try_with(|wait| *wait) {
        return wait;
    }
    CLONE_WAIT
}

/// The stop token of each clone whose owned task runs in this process, by session and
/// `cloneId`. `McpControl` has no slot for it, and session ids are unique, so one map serves
/// every control.
type LiveClones = Mutex<HashMap<(String, String), CancellationToken>>;
static LIVE: LazyLock<LiveClones> = LazyLock::new(LiveClones::default);

fn live() -> std::sync::MutexGuard<'static, HashMap<(String, String), CancellationToken>> {
    LIVE.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Lists a running clone's stop token until its task ends.
struct Running((String, String));

impl Running {
    fn start(key: (String, String), stop: CancellationToken) -> Self {
        live().insert(key.clone(), stop);
        Self(key)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        live().remove(&self.0);
    }
}

fn call<'a>(
    call: &'a ToolCall<'a>,
    name: &'a str,
    _progress: Option<(ProgressSink, Value)>,
) -> ToolFuture<'a> {
    Box::pin(async move {
        match name {
            "clone_repository" => call.clone_repository().await,
            "clone_status" => call.clone_status().await,
            "cancel_clone" => call.cancel_clone().await,
            _ => Err(typed_tool_failure("McpUnknownToolError", "Unknown tool.")),
        }
    })
}

fn text(name: &str) -> Option<(&'static str, Value)> {
    let clone_id =
        json!({ "type": "string", "description": "cloneId as clone_repository returned it." });
    Some(match name {
        "clone_repository" => (
            "Clones a repository into the folder that holds a registered project (beside it), then adds it as a project unless addAsProject is false. The URL must be https:// with no user name or token, and its host must be public: SSH, host:path, git://, file:// and local or private network addresses are refused (clone those in BiBCode yourself). Git LFS files stay pointer files, and redirects are not followed. Waits up to 50 seconds; a longer clone returns state running with its cloneId, and clone_status reads it later. A finished clone of the same URL already in the folder is reused, not cloned again.",
            object_schema(
                json!({
                    "url": { "type": "string", "description": "An https:// clone URL, such as https://github.com/owner/repo.git." },
                    "parentProjectId": { "type": "string", "description": "A project id, as list_projects_and_threads returns it. The clone goes into the folder that holds this project's folder." },
                    "directoryName": { "type": "string", "description": "The new folder's name; the URL's last part without .git unless set. One name: no slashes, and not starting with -." },
                    "addAsProject": { "type": "boolean", "description": "Add the clone as a project. true unless set." },
                    "title": { "type": "string", "description": "The new project's title; the folder name unless set." },
                    "clientRequestId": { "type": "string", "description": CLIENT_REQUEST_ID },
                }),
                &["url", "parentProjectId"],
            ),
        ),
        "clone_status" => (
            "How a clone this connection started is going: state running, or the finished clone's path and project. A clone that failed returns its error; McpOutcomeUnknownError means BiBCode cannot tell whether Git finished (it was stopped or BiBCode restarted): look for the folder, or clone the same URL again, which reuses a finished clone.",
            object_schema(json!({ "cloneId": clone_id }), &["cloneId"]),
        ),
        "cancel_clone" => (
            "Stops a clone this connection started and removes its folder, then returns its state. A clone a person started that yours joined keeps running. A clone stopped before Git finished is state unknown.",
            object_schema(json!({ "cloneId": clone_id }), &["cloneId"]),
        ),
        _ => return None,
    })
}

/// What the owned task clones and registers, frozen when the call is recorded.
#[derive(Clone)]
struct Intent {
    clone_id: String,
    url: String,
    parent_dir: String,
    directory_name: String,
    add_as_project: bool,
    title: String,
    project_id: String,
    command_id: String,
}

fn not_found() -> Value {
    typed_tool_failure(
        NOT_FOUND_TAG,
        "No clone with this cloneId was started on this MCP connection in the last 24 hours.",
    )
}

fn running(clone_id: &str) -> Value {
    tool_result(json!({ "state": "running", "cloneId": clone_id }), &[])
}

fn tag(failure: &Value) -> &str {
    failure["structuredContent"]["error"]["_tag"]
        .as_str()
        .unwrap_or_default()
}

/// A failed `vcs.clone` as a tool failure: its tag, its message or Git's detail, its reason.
fn clone_failure(error: &Value) -> Value {
    let message = error["message"]
        .as_str()
        .or_else(|| error["detail"].as_str())
        .unwrap_or("The clone failed.");
    let mut failure = typed_tool_failure(error["_tag"].as_str().unwrap_or("McpToolError"), message);
    if let Some(reason) = error.get("reason") {
        failure["structuredContent"]["error"]["reason"] = reason.clone();
    }
    failure
}

/// A clone stopped before it reported: `unknown`, since Git may have finished at that instant.
/// The live controls replace it with their own reason; `cancel_clone` keeps it.
fn stopped() -> Value {
    let mut failure = typed_tool_failure(
        OUTCOME_UNKNOWN_TAG,
        "The clone was stopped before BiBCode knew whether Git finished. Look for the folder, or clone the same URL again, which reuses a finished clone.",
    );
    failure["structuredContent"]["error"]["reason"] = "cancelled".into();
    outcome_unknown(failure)
}

/// The owned task: clone, then register, under the live controls and `cancel_clone`.
async fn clone_and_register(
    owned: Owned,
    intent: Intent,
    session_id: String,
    context: crate::rpc::RpcSessionContext,
    registry: crate::rpc::RpcRegistry,
) -> ToolResult {
    let stop = owned.cancellation().child_token();
    let _running = Running::start((session_id, intent.clone_id.clone()), stop.clone());
    let payload = json!({
        "url": intent.url,
        "parentDir": intent.parent_dir,
        "directoryName": intent.directory_name,
        "attach": false,
        "detach": false,
    });
    // Dropping this call is what stops Git: without `detach`, the clone runtime cancels a clone
    // this task started and removes its folder, and a clone it joined goes on.
    let cloned = tokio::select! {
        biased;
        () = stop.cancelled() => return Err(stopped()),
        cloned = registry.invoke_local(CLONE, payload, context.clone(), stop.clone()) => cloned,
    };
    let path = match cloned {
        Ok(cloned) => cloned["path"].as_str().unwrap_or_default().to_owned(),
        Err(error) => return Err(clone_failure(&error)),
    };
    // Git has finished; registration is local and bounded, so it is not interrupted.
    let project = if intent.add_as_project {
        let dispatched = registry
            .invoke_local(
                DISPATCH,
                json!({
                    "type": "project.create",
                    "commandId": intent.command_id,
                    "projectId": intent.project_id,
                    "title": intent.title,
                    "workspaceRoot": path,
                    "createdAt": now_iso(),
                }),
                context,
                CancellationToken::new(),
            )
            .await
            .map_err(|error| rpc_failure(&error))?;
        // A folder already registered answers with that project, never a second one.
        let project_id = dispatched["projectId"]
            .as_str()
            .unwrap_or(&intent.project_id)
            .to_owned();
        json!({
            "projectId": project_id,
            "created": project_id == intent.project_id,
            "defaultThreadId": dispatched["threadId"],
        })
    } else {
        Value::Null
    };
    Ok(tool_result(
        json!({ "state": "done", "cloneId": intent.clone_id, "path": path, "project": project }),
        &[],
    ))
}

impl ToolCall<'_> {
    async fn clone_repository(&self) -> ToolResult {
        self.only(&[
            "url",
            "parentProjectId",
            "directoryName",
            "addAsProject",
            "title",
            "clientRequestId",
        ])?;
        let url = self.required("url")?.to_owned();
        let parent_project_id = self.required("parentProjectId")?;
        let leaf = clone_destination_leaf(&url, self.string("directoryName")?)
            .map_err(|error| invalid_argument(&error.to_string()))?;
        let add_as_project = self.boolean("addAsProject")?.unwrap_or(true);
        let title = self
            .string("title")?
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(leaf.as_str())
            .to_owned();
        let project = self
            .control
            .repositories()
            .get_project(parent_project_id.to_owned())
            .await
            .map_err(storage_failure)?
            .filter(|project| project.deleted_at.is_none())
            .ok_or_else(|| {
                typed_tool_failure(
                    "McpProjectNotFoundError",
                    &format!(
                        "No project {parent_project_id}; list_projects_and_threads lists them."
                    ),
                )
            })?;
        let parent_dir = Path::new(&project.workspace_root)
            .parent()
            .ok_or_else(|| {
                typed_tool_failure(
                    "McpCloneRefusedError",
                    "This project's folder is a root folder, so there is no folder beside it to clone into.",
                )
            })?
            .to_string_lossy()
            .into_owned();
        // Always owned: without a clientRequestId the server mints the key, and the key is the
        // cloneId `clone_status` and `cancel_clone` take.
        let clone_id = match self.string("clientRequestId")? {
            Some(id) => id.to_owned(),
            None => format!("clone-{}", Uuid::new_v4()),
        };
        let mut arguments = self.arguments.clone();
        arguments.insert("clientRequestId".to_owned(), clone_id.clone().into());
        let intent = Intent {
            clone_id: clone_id.clone(),
            url,
            parent_dir,
            directory_name: leaf.as_str().to_owned(),
            add_as_project,
            title,
            project_id: Uuid::new_v4().to_string(),
            command_id: format!("mcp-clone-{}", Uuid::new_v4()),
        };
        // The recorded request is the durable registration intent, and holds the arguments
        // `clone_status` replays the key with.
        let payload = json!({
            "arguments": arguments,
            "url": intent.url,
            "parentDir": intent.parent_dir,
            "directoryName": intent.directory_name,
            "addAsProject": intent.add_as_project,
            "title": intent.title,
            "projectId": intent.project_id,
            "commandId": intent.command_id,
        });
        let (session_id, context, registry) = (
            self.principal.principal.session_id.clone(),
            self.context(),
            self.control.registry().clone(),
        );
        let result = self
            .wait_on_recorded(&arguments, &payload, clone_wait(), move |owned| {
                clone_and_register(owned, intent, session_id, context, registry)
            })
            .await;
        match result {
            Err(failure) if tag(&failure) == CANCELLED_TAG && !self.cancellation.is_cancelled() => {
                Ok(running(&clone_id))
            }
            other => other,
        }
    }

    /// Runs [`ToolCall::recorded`] under `arguments` and stops waiting after `wait`, which it
    /// answers as `McpCancelledError`; the owned work goes on.
    async fn wait_on_recorded<F, Fut>(
        &self,
        arguments: &Map<String, Value>,
        payload: &Value,
        wait: Duration,
        work: F,
    ) -> ToolResult
    where
        F: FnOnce(Owned) -> Fut + Send + 'static,
        Fut: Future<Output = ToolResult> + Send + 'static,
    {
        let waiting = self.cancellation.child_token();
        let keyed = ToolCall {
            control: self.control,
            principal: self.principal,
            arguments,
            cancellation: waiting.clone(),
        };
        let recorded = keyed.recorded(TOOL, payload, work);
        tokio::pin!(recorded);
        tokio::select! {
            biased;
            result = &mut recorded => result,
            () = tokio::time::sleep(wait) => {
                waiting.cancel();
                recorded.await
            }
        }
    }

    /// The recorded outcome of `clone_id`, waiting up to `wait` while it runs: the finished
    /// result, its failure, `running`, or `unknown` for a row no process owns.
    async fn clone_outcome(&self, clone_id: &str, wait: Duration) -> ToolResult {
        let (session_id, id) = (
            self.principal.principal.session_id.clone(),
            clone_id.to_owned(),
        );
        let stored: Option<(String, String)> = self
            .control
            .repositories()
            .database()
            .call(move |connection| {
                Ok(connection
                    .query_row(
                        "SELECT tool, commands_json FROM mcp_tool_requests WHERE session_id = ? AND client_request_id = ?",
                        params![session_id, id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?)
            })
            .await
            .map_err(storage_failure)?;
        let payload = stored
            .filter(|(tool, _)| tool == TOOL)
            .and_then(|(_, payload)| serde_json::from_str::<Value>(&payload).ok())
            .ok_or_else(not_found)?;
        let Some(arguments) = payload["arguments"].as_object() else {
            return Err(not_found());
        };
        // Replaying the key reads the row as a retry would, and never runs anything: the row
        // exists, so the work below is unreachable.
        let result = self
            .wait_on_recorded(arguments, &payload, wait, |_| async { Err(not_found()) })
            .await;
        match result {
            Err(failure) if tag(&failure) == CANCELLED_TAG && !self.cancellation.is_cancelled() => {
                Ok(running(clone_id))
            }
            other => other,
        }
    }

    async fn clone_status(&self) -> ToolResult {
        self.only(&["cloneId"])?;
        let clone_id = self.required("cloneId")?;
        self.clone_outcome(clone_id, Duration::ZERO).await
    }

    async fn cancel_clone(&self) -> ToolResult {
        self.only(&["cloneId"])?;
        let clone_id = self.required("cloneId")?;
        let key = (
            self.principal.principal.session_id.clone(),
            clone_id.to_owned(),
        );
        let stop = live().get(&key).cloned();
        let cancelled = stop.is_some();
        if let Some(stop) = stop {
            stop.cancel();
        }
        let outcome = self.clone_outcome(clone_id, CANCEL_WAIT).await;
        let (state, error) = match &outcome {
            Ok(result) => (
                result["structuredContent"]["state"]
                    .as_str()
                    .unwrap_or("done")
                    .to_owned(),
                Value::Null,
            ),
            Err(failure) if tag(failure) == NOT_FOUND_TAG => return outcome,
            Err(failure) => {
                let error = &failure["structuredContent"]["error"];
                let state = if error["outcome"] == "unknown" {
                    "unknown"
                } else {
                    "failed"
                };
                (
                    state.to_owned(),
                    json!({ "_tag": error["_tag"], "reason": error["reason"], "message": error["message"] }),
                )
            }
        };
        Ok(tool_result(
            json!({ "cloneId": clone_id, "cancelled": cancelled, "state": state, "error": error }),
            &[],
        ))
    }
}
