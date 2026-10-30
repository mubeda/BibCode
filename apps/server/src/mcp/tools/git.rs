//! The Git write tools (#139 slice G): stage, unstage, commit, undo and revert commits, push,
//! force-push, fetch, pull, create, switch and delete branches, delete a remote branch, and
//! discard changes, in the folder a thread works in.
//!
//! Each tool reaches the handler the Source Control panel uses (`vcs.*`, `gitManager.*`, and
//! the `gitManager.runOperation` stream) through [`ToolCall::recorded`], so it runs under the
//! live controls, and a `clientRequestId` makes it at most once: a retry returns the stored
//! outcome. Paths are literal, relative and checked by [`validate_paths`]; branch names and
//! revisions are checked here so none can be read as an option or a refspec, and a remote must
//! be one the repository has. Every result ends with a fresh summary of the folder's Git
//! status. Git output is never returned on success, and nothing a tool names (a path, a
//! branch, a message) is logged.

use serde_json::{Value, json};

use crate::{
    auth::SCOPE_ORCHESTRATION_OPERATE,
    git::manager::operations::is_branch_name,
    mcp::{
        control::{
            CLIENT_REQUEST_ID, Family, McpCapability, ProgressSink, ToolCall, ToolFuture,
            ToolResult, ToolSpec, invalid_argument, object_schema,
        },
        outcome::Owned,
        protocol::{Cut, tool_result, typed_tool_failure},
        target::validate_paths,
    },
};

const OPERATE: &str = SCOPE_ORCHESTRATION_OPERATE;
const SOURCE_CONTROL: Option<McpCapability> = Some(McpCapability::SourceControl);
const RUN_OPERATION: &str = "gitManager.runOperation";
const RUN: &[&str] = &[RUN_OPERATION];
/// The longest branch name or revision a tool takes.
const MOST_NAME_CHARS: usize = 255;
pub(crate) const PARTIAL_TAG: &str = "McpPartialOutcomeError";

/// The Git write tools, in the order `tools/list` shows them. Each lists only the mutating
/// method it runs; the reads it also makes (`gitManager.getRefs` to resolve a branch's
/// upstream, `vcs.refreshStatus` for the summary) need the read scope its credential holds.
pub(crate) const TOOLS: &[ToolSpec] = &[
    // Neither is idempotent: each acts on the file's state at call time.
    ToolSpec::client("git_stage", OPERATE, &["vcs.stageFiles"]).in_set(SOURCE_CONTROL),
    ToolSpec::client("git_unstage", OPERATE, &["vcs.unstageFiles"]).in_set(SOURCE_CONTROL),
    ToolSpec::client("git_commit", OPERATE, &["gitManager.commit"]).in_set(SOURCE_CONTROL),
    ToolSpec::client("git_undo_commit", OPERATE, &["gitManager.undoCommit"])
        .destroys()
        .in_set(SOURCE_CONTROL),
    // Adds a commit and loses nothing, but the user's set of operations logs it.
    ToolSpec::client("git_revert_commit", OPERATE, RUN)
        .audit()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("git_push", OPERATE, RUN)
        .open_world()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("git_force_push", OPERATE, RUN)
        .destroys()
        .open_world()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("git_fetch", OPERATE, RUN)
        .open_world()
        .repeats_safely()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("git_pull", OPERATE, RUN)
        .open_world()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("git_create_branch", OPERATE, RUN).in_set(SOURCE_CONTROL),
    ToolSpec::client("git_switch_branch", OPERATE, RUN).in_set(SOURCE_CONTROL),
    // With `deleteRemote` it reaches the remote too.
    ToolSpec::client("git_delete_branch", OPERATE, RUN)
        .destroys()
        .open_world()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("git_delete_remote_branch", OPERATE, RUN)
        .destroys()
        .open_world()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("git_discard", OPERATE, &["gitManager.discard"])
        .destroys()
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
            "git_stage" => index(call, Index::Stage).await,
            "git_unstage" => index(call, Index::Unstage).await,
            "git_commit" => commit(call).await,
            "git_undo_commit" => undo_commit(call).await,
            "git_revert_commit" => revert_commit(call).await,
            "git_push" => push(call, false).await,
            "git_force_push" => push(call, true).await,
            "git_fetch" => sync(call, Sync::Fetch).await,
            "git_pull" => sync(call, Sync::Pull).await,
            "git_create_branch" => create_branch(call).await,
            "git_switch_branch" => switch_branch(call).await,
            "git_delete_branch" => delete_branch(call).await,
            "git_delete_remote_branch" => delete_remote_branch(call).await,
            "git_discard" => discard(call).await,
            _ => Err(typed_tool_failure("McpUnknownToolError", "Unknown tool.")),
        }
    })
}

fn text(name: &str) -> Option<(&'static str, Value)> {
    TOOLS
        .iter()
        .any(|spec| spec.name == name)
        .then(|| tool_text(name))
}

#[allow(
    clippy::too_many_lines,
    reason = "one description and schema per tool, side by side"
)]
fn tool_text(name: &str) -> (&'static str, Value) {
    let thread = json!({ "type": "string", "description": "A thread id; the tool works in the thread's worktree, else its project's folder." });
    let request_id = json!({ "type": "string", "description": CLIENT_REQUEST_ID });
    let paths = json!({
        "type": "array",
        "items": { "type": "string" },
        "minItems": 1,
        "maxItems": crate::mcp::target::MOST_PATHS,
        "description": "Literal file or folder paths relative to the thread's folder, at most 200. Globs and pathspec magic (a leading ':', or '*', '?', '[', '\\') are refused.",
    });
    let remote = json!({ "type": "string", "description": "A remote of this repository. The branch's upstream remote unless set, else origin." });
    let branch = |description: &str| json!({ "type": "string", "description": description });
    let object = object_schema;
    match name {
        "git_stage" => (
            "Stages files or folders in the thread's folder (git add) and returns the folder's Git status.",
            object(
                json!({ "threadId": thread, "paths": paths }),
                &["threadId", "paths"],
            ),
        ),
        "git_unstage" => (
            "Unstages files or folders in the thread's folder, keeping their changes, and returns the folder's Git status.",
            object(
                json!({ "threadId": thread, "paths": paths }),
                &["threadId", "paths"],
            ),
        ),
        "git_commit" => (
            "Commits what is staged in the thread's folder, running the repository's hooks, and returns the commit's sha. To amend, run git_undo_commit and commit again.",
            object(
                json!({
                    "threadId": thread,
                    "summary": { "type": "string", "description": "The commit's first line." },
                    "description": { "type": "string", "description": "The commit message's body." },
                    "clientRequestId": request_id,
                }),
                &["threadId", "summary"],
            ),
        ),
        "git_undo_commit" => (
            "Destructive: removes the last commit of the current branch when it was never pushed, keeping its changes in the working tree, and returns its message.",
            object(
                json!({ "threadId": thread, "clientRequestId": request_id }),
                &["threadId"],
            ),
        ),
        "git_revert_commit" => (
            "Adds a commit that reverts the commit sha on the current branch. Nothing is lost.",
            object(
                json!({
                    "threadId": thread,
                    "sha": { "type": "string", "description": "The commit to revert." },
                    "clientRequestId": request_id,
                }),
                &["threadId", "sha"],
            ),
        ),
        "git_push" => (
            "Pushes a branch (the current one unless set). A branch without an upstream is published and tracks it.",
            object(
                json!({
                    "threadId": thread,
                    "remote": remote,
                    "branch": branch("The local branch; the current one unless set."),
                    "remoteBranch": branch("The branch on the remote; the same name or the upstream unless set."),
                    "pushTags": { "type": "boolean", "description": "Also push every local tag, atomically. Off unless set." },
                    "clientRequestId": request_id,
                }),
                &["threadId"],
            ),
        ),
        "git_force_push" => (
            "Destructive: force-pushes a branch with --force-with-lease, replacing the remote branch. The push is refused if the remote moved since this repository last fetched it.",
            object(
                json!({
                    "threadId": thread,
                    "remote": remote,
                    "branch": branch("The local branch; the current one unless set."),
                    "remoteBranch": branch("The branch on the remote; the same name or the upstream unless set."),
                    "pushTags": { "type": "boolean", "description": "Also push every local tag, atomically. Off unless set." },
                    "clientRequestId": request_id,
                }),
                &["threadId"],
            ),
        ),
        "git_fetch" => (
            "Fetches a remote and prunes branches it deleted, and returns the folder's Git status with ahead and behind.",
            object(
                json!({ "threadId": thread, "remote": remote }),
                &["threadId"],
            ),
        ),
        "git_pull" => (
            "Pulls the current branch from a remote into the thread's folder.",
            object(
                json!({ "threadId": thread, "remote": remote, "clientRequestId": request_id }),
                &["threadId"],
            ),
        ),
        "git_create_branch" => (
            "Creates a branch, from startPoint or the current commit, and switches to it unless checkout is false. It tracks nothing until git_push publishes it.",
            object(
                json!({
                    "threadId": thread,
                    "name": branch("The new branch's name."),
                    "startPoint": branch("A branch, tag or commit to start from; the current commit unless set."),
                    "checkout": { "type": "boolean", "description": "Switch to the new branch. On unless set." },
                }),
                &["threadId", "name"],
            ),
        ),
        "git_switch_branch" => (
            "Switches the thread's folder to a local branch, or to a new local branch tracking a remote one (origin/name). With changes in the folder, carryChanges stash stashes them first and bring takes them along; without it a dirty folder is refused.",
            object(
                json!({
                    "threadId": thread,
                    "name": branch("A local branch, or a remote branch such as origin/feature."),
                    "carryChanges": { "type": "string", "enum": ["stash", "bring"], "description": "What happens to uncommitted changes: stash them, or bring them along." },
                }),
                &["threadId", "name"],
            ),
        ),
        "git_delete_branch" => (
            "Destructive: deletes a local branch, and with deleteRemote its upstream branch on the remote too, in that order. If the remote deletion fails, the result is McpPartialOutcomeError naming the git_delete_remote_branch call that finishes it.",
            object(
                json!({
                    "threadId": thread,
                    "name": branch("The local branch to delete."),
                    "force": { "type": "boolean", "description": "Delete it even if it is not merged. Off unless set." },
                    "deleteRemote": { "type": "boolean", "description": "Also delete its upstream branch on the remote. Off unless set; refused when it has no upstream." },
                    "clientRequestId": request_id,
                }),
                &["threadId", "name"],
            ),
        ),
        "git_delete_remote_branch" => (
            "Destructive: deletes a branch on a remote, leaving any local branch alone.",
            object(
                json!({
                    "threadId": thread,
                    "remote": { "type": "string", "description": "A remote of this repository." },
                    "branch": branch("The branch on the remote."),
                    "clientRequestId": request_id,
                }),
                &["threadId", "remote", "branch"],
            ),
        ),
        "git_discard" => (
            "Destructive: discards the changes of files or folders, restoring tracked files and removing untracked ones. Files go to the system trash; a file the trash cannot take is kept and listed in trashUnavailable, unless permanent is true.",
            object(
                json!({
                    "threadId": thread,
                    "paths": paths,
                    "permanent": { "type": "boolean", "description": "Delete what the trash cannot take, permanently. Off unless set." },
                    "clientRequestId": request_id,
                }),
                &["threadId", "paths"],
            ),
        ),
        _ => ("", object(json!({}), &[])),
    }
}

/// Where a tool works: the thread, its folder and its project.
struct Place {
    thread_id: String,
    cwd: String,
    project_id: String,
}

/// Checks that only `known` arguments are given and resolves the thread's folder.
async fn place(call: &ToolCall<'_>, known: &[&str]) -> Result<Place, Value> {
    call.only(known)?;
    let thread_id = call.required("threadId")?.to_owned();
    let target = call.target(&thread_id).await?;
    Ok(Place {
        thread_id,
        cwd: target.cwd,
        project_id: target.project_id,
    })
}

/// The tool result: the work's outcome, the thread, and a fresh Git status summary. The status
/// is read again on a retry that returns a stored outcome, so it is always current.
async fn finish(call: &ToolCall<'_>, place: &Place, result: ToolResult) -> ToolResult {
    let mut content = result?;
    content["threadId"] = place.thread_id.clone().into();
    content["status"] = status(call, &place.cwd).await;
    Ok(tool_result(content, &[("/status/files", Cut::Back)]))
}

/// The folder's branch, upstream, ahead/behind and changed files, as `git_status` returns
/// them; `null` when the status cannot be read, which never fails the work that ran.
async fn status(call: &ToolCall<'_>, cwd: &str) -> Value {
    match call
        .invoke("vcs.refreshStatus", json!({ "cwd": cwd }))
        .await
    {
        Ok(status) => json!({
            "branch": status.get("refName"),
            "hasUpstream": status.get("hasUpstream"),
            "ahead": status.get("aheadCount"),
            "behind": status.get("behindCount"),
            "hasWorkingTreeChanges": status.get("hasWorkingTreeChanges"),
            "files": status.pointer("/workingTree/files").cloned().unwrap_or_else(|| json!([])),
        }),
        Err(_) => Value::Null,
    }
}

fn string_list(call: &ToolCall<'_>, key: &str) -> Result<Vec<String>, Value> {
    match call.arguments.get(key) {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| invalid_argument(&format!("{key} must be a list of strings")))
            })
            .collect(),
        None | Some(Value::Null) => Err(invalid_argument(&format!("{key} is required"))),
        Some(_) => Err(invalid_argument(&format!(
            "{key} must be a list of strings"
        ))),
    }
}

/// `paths`, checked against the thread's folder off the runtime (it reads the file system).
async fn checked_paths(call: &ToolCall<'_>, cwd: &str) -> Result<Vec<String>, Value> {
    let paths = string_list(call, "paths")?;
    let cwd = std::path::PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || validate_paths(&cwd, &paths))
        .await
        .map_err(|_| invalid_argument("the paths could not be checked; try again"))?
}

/// A branch name argument, refused unless Git would take it as a branch name and nothing else.
fn branch_name(call: &ToolCall<'_>, key: &str) -> Result<Option<String>, Value> {
    match call.string(key)? {
        None => Ok(None),
        Some(name) if is_branch_name(name) => Ok(Some(name.to_owned())),
        Some(_) => Err(invalid_argument(&format!(
            "{key} must be a branch name: no spaces, '..', ':', '~', '^', '?', '*', '[', '\\', and no leading '-' or '+'"
        ))),
    }
}

fn required_branch(call: &ToolCall<'_>, key: &str) -> Result<String, Value> {
    branch_name(call, key)?.ok_or_else(|| invalid_argument(&format!("{key} is required")))
}

/// A revision argument (a sha, branch or tag), refused when it could be read as an option.
fn revision(call: &ToolCall<'_>, key: &str) -> Result<Option<String>, Value> {
    match call.string(key)? {
        None => Ok(None),
        Some(value)
            if !value.is_empty()
                && value.chars().count() <= MOST_NAME_CHARS
                && !value.starts_with('-')
                && !value
                    .chars()
                    .any(|character| character.is_whitespace() || character.is_control()) =>
        {
            Ok(Some(value.to_owned()))
        }
        Some(_) => Err(invalid_argument(&format!(
            "{key} must be a commit, branch or tag, without spaces or a leading '-'"
        ))),
    }
}

/// A remote argument's shape; whether the repository has it is checked against its refs.
fn remote_name(call: &ToolCall<'_>, key: &str) -> Result<Option<String>, Value> {
    match call.string(key)? {
        None => Ok(None),
        Some(remote) if is_branch_name(remote) && !remote.contains('/') => {
            Ok(Some(remote.to_owned()))
        }
        Some(_) => Err(invalid_argument(&format!(
            "{key} must be the name of one of this repository's remotes"
        ))),
    }
}

/// The repository's refs: branches with their upstreams, remotes, HEAD and dirtiness.
async fn refs(owned: &Owned, cwd: &str) -> Result<Value, Value> {
    owned
        .invoke("gitManager.getRefs", json!({ "cwd": cwd }))
        .await
}

fn remotes(refs: &Value) -> Vec<&str> {
    refs["remotes"]
        .as_array()
        .map(|remotes| remotes.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// The current branch, or a typed refusal when HEAD is detached.
fn current_branch(refs: &Value) -> Result<String, Value> {
    refs["headRef"].as_str().map(str::to_owned).ok_or_else(|| {
        invalid_argument(
            "HEAD is detached; name the branch, or switch to one with git_switch_branch",
        )
    })
}

/// The upstream of local branch `branch` as (remote, remote branch), or `None` when it tracks
/// nothing. A branch the repository does not have is refused.
fn upstream(refs: &Value, branch: &str) -> Result<Option<(String, String)>, Value> {
    let entry = refs["localBranches"]
        .as_array()
        .and_then(|branches| {
            branches
                .iter()
                .find(|entry| entry["name"].as_str() == Some(branch))
        })
        .ok_or_else(|| {
            invalid_argument(&format!(
                "there is no local branch {branch}; git_status names the current one"
            ))
        })?;
    let Some(upstream) = entry["upstream"].as_str() else {
        return Ok(None);
    };
    // The longest remote name the upstream starts with, so a remote with a slash still splits.
    Ok(remotes(refs)
        .into_iter()
        .filter(|remote| upstream.starts_with(&format!("{remote}/")))
        .max_by_key(|remote| remote.len())
        .map(|remote| (remote.to_owned(), upstream[remote.len() + 1..].to_owned())))
}

/// The remote to use: the one named, which the repository must have, else the upstream's,
/// else `origin`, else the only remote.
fn choose_remote(
    refs: &Value,
    named: Option<String>,
    upstream_remote: Option<&str>,
) -> Result<String, Value> {
    let known = remotes(refs);
    if let Some(named) = named {
        return if known.contains(&named.as_str()) {
            Ok(named)
        } else {
            Err(invalid_argument(&format!(
                "this repository has no remote {named}; it has {}",
                if known.is_empty() {
                    "none".to_owned()
                } else {
                    known.join(", ")
                }
            )))
        };
    }
    upstream_remote
        .map(str::to_owned)
        .or_else(|| known.contains(&"origin").then(|| "origin".to_owned()))
        .or_else(|| (known.len() == 1).then(|| known[0].to_owned()))
        .ok_or_else(|| {
            invalid_argument(if known.is_empty() {
                "this repository has no remote"
            } else {
                "name the remote: this repository has several and none is origin"
            })
        })
}

/// Runs one `gitManager.runOperation` to its end and returns its operation and message.
async fn operate(owned: &Owned, payload: Value) -> Result<Value, Value> {
    let outcome = owned.invoke_stream(RUN_OPERATION, payload).await?;
    Ok(json!({
        "operation": outcome.terminal.get("operation"),
        "message": outcome.terminal.get("message"),
    }))
}

#[derive(Clone, Copy)]
enum Index {
    Stage,
    Unstage,
}

async fn index(call: &ToolCall<'_>, which: Index) -> ToolResult {
    let place = place(call, &["threadId", "paths"]).await?;
    let paths = checked_paths(call, &place.cwd).await?;
    let (tool, method, key) = match which {
        Index::Stage => ("git_stage", "vcs.stageFiles", "staged"),
        Index::Unstage => ("git_unstage", "vcs.unstageFiles", "unstaged"),
    };
    let payload = json!({ "cwd": place.cwd, "filePaths": paths });
    let sent = payload.clone();
    let result = call
        .recorded(tool, &payload, move |owned| async move {
            owned.invoke(method, sent).await?;
            let mut done = json!({});
            done[key] = paths.into();
            Ok(done)
        })
        .await;
    finish(call, &place, result).await
}

async fn commit(call: &ToolCall<'_>) -> ToolResult {
    let place = place(
        call,
        &["threadId", "summary", "description", "clientRequestId"],
    )
    .await?;
    let summary = call.required("summary")?.trim().to_owned();
    let description = call.string("description")?.unwrap_or_default().to_owned();
    let payload = json!({
        "cwd": place.cwd, "summary": summary, "description": description,
        "amend": false, "noVerify": false, "signoff": false, "allowEmpty": false, "coAuthors": [],
    });
    let sent = payload.clone();
    let result = call
        .recorded("git_commit", &payload, move |owned| async move {
            let commit = owned.invoke("gitManager.commit", sent).await?;
            Ok(json!({ "sha": commit.get("sha"), "empty": commit.get("empty") }))
        })
        .await;
    finish(call, &place, result).await
}

async fn undo_commit(call: &ToolCall<'_>) -> ToolResult {
    let place = place(call, &["threadId", "clientRequestId"]).await?;
    let payload = json!({ "cwd": place.cwd });
    let sent = payload.clone();
    let result = call
        .recorded("git_undo_commit", &payload, move |owned| async move {
            let undone = owned.invoke("gitManager.undoCommit", sent).await?;
            Ok(json!({
                "summary": undone.get("summary"),
                "description": undone.get("description"),
                "coAuthors": undone.get("coAuthors"),
            }))
        })
        .await;
    finish(call, &place, result).await
}

async fn revert_commit(call: &ToolCall<'_>) -> ToolResult {
    let place = place(call, &["threadId", "sha", "clientRequestId"]).await?;
    let sha = revision(call, "sha")?.ok_or_else(|| invalid_argument("sha is required"))?;
    let payload =
        json!({ "_tag": "revert", "cwd": place.cwd, "projectId": place.project_id, "sha": sha });
    let sent = payload.clone();
    let result = call
        .recorded("git_revert_commit", &payload, move |owned| async move {
            operate(&owned, sent).await
        })
        .await;
    finish(call, &place, result).await
}

async fn push(call: &ToolCall<'_>, force: bool) -> ToolResult {
    let place = place(
        call,
        &[
            "threadId",
            "remote",
            "branch",
            "remoteBranch",
            "pushTags",
            "clientRequestId",
        ],
    )
    .await?;
    let remote = remote_name(call, "remote")?;
    let branch = branch_name(call, "branch")?;
    let remote_branch = branch_name(call, "remoteBranch")?;
    let push_tags = call.boolean("pushTags")?.unwrap_or(false);
    let tool = if force { "git_force_push" } else { "git_push" };
    let (cwd, project_id) = (place.cwd.clone(), place.project_id.clone());
    // The branch, remote and kind of push are resolved when the work runs; the row keeps what
    // was asked.
    let payload = json!({
        "cwd": cwd, "remote": remote, "branch": branch, "remoteBranch": remote_branch,
        "pushTags": push_tags, "force": force,
    });
    let result = call
        .recorded(tool, &payload, move |owned| async move {
            let refs = refs(&owned, &cwd).await?;
            let branch = match branch {
                Some(branch) => branch,
                None => current_branch(&refs)?,
            };
            let upstream = upstream(&refs, &branch)?;
            let remote = choose_remote(&refs, remote, upstream.as_ref().map(|(r, _)| r.as_str()))?;
            // Pushed to its upstream's remote, a branch updates its upstream branch, whatever
            // its name there.
            let remote_branch = remote_branch.or_else(|| {
                upstream
                    .as_ref()
                    .filter(|(upstream_remote, _)| *upstream_remote == remote)
                    .map(|(_, upstream_branch)| upstream_branch.clone())
            });
            let kind = if force {
                "force-push"
            } else if upstream.is_none() {
                "publish-branch"
            } else {
                "push"
            };
            let mut done = operate(
                &owned,
                json!({
                    "_tag": kind, "cwd": cwd, "projectId": project_id, "remote": remote,
                    "localBranch": branch, "remoteBranch": remote_branch, "pushTags": push_tags,
                }),
            )
            .await?;
            done["remote"] = remote.into();
            done["branch"] = branch.into();
            Ok(done)
        })
        .await;
    finish(call, &place, result).await
}

#[derive(Clone, Copy)]
enum Sync {
    Fetch,
    Pull,
}

async fn sync(call: &ToolCall<'_>, which: Sync) -> ToolResult {
    let (tool, kind, known): (_, _, &[&str]) = match which {
        Sync::Fetch => ("git_fetch", "fetch", &["threadId", "remote"]),
        Sync::Pull => (
            "git_pull",
            "pull",
            &["threadId", "remote", "clientRequestId"],
        ),
    };
    let place = place(call, known).await?;
    let remote = remote_name(call, "remote")?;
    let (cwd, project_id) = (place.cwd.clone(), place.project_id.clone());
    let payload = json!({ "cwd": cwd, "remote": remote, "operation": kind });
    let result = call
        .recorded(tool, &payload, move |owned| async move {
            let refs = refs(&owned, &cwd).await?;
            let upstream = match refs["headRef"].as_str() {
                Some(branch) => upstream(&refs, branch)?,
                None => None,
            };
            let remote = choose_remote(&refs, remote, upstream.as_ref().map(|(r, _)| r.as_str()))?;
            let mut done = operate(
                &owned,
                json!({ "_tag": kind, "cwd": cwd, "projectId": project_id, "remote": remote }),
            )
            .await?;
            done["remote"] = remote.into();
            Ok(done)
        })
        .await;
    finish(call, &place, result).await
}

async fn create_branch(call: &ToolCall<'_>) -> ToolResult {
    let place = place(call, &["threadId", "name", "startPoint", "checkout"]).await?;
    let name = required_branch(call, "name")?;
    let start_point = revision(call, "startPoint")?;
    let checkout = call.boolean("checkout")?.unwrap_or(true);
    let payload = json!({
        "_tag": "branch-create", "cwd": place.cwd, "projectId": place.project_id,
        "name": name, "startPoint": start_point, "checkout": checkout,
    });
    let sent = payload.clone();
    let result = call
        .recorded("git_create_branch", &payload, move |owned| async move {
            let mut done = operate(&owned, sent).await?;
            done["branch"] = name.into();
            Ok(done)
        })
        .await;
    finish(call, &place, result).await
}

async fn switch_branch(call: &ToolCall<'_>) -> ToolResult {
    let place = place(call, &["threadId", "name", "carryChanges"]).await?;
    let name = required_branch(call, "name")?;
    let carry = match call.string("carryChanges")? {
        None => None,
        Some(carry @ ("stash" | "bring")) => Some(carry.to_owned()),
        Some(_) => return Err(invalid_argument("carryChanges is stash or bring")),
    };
    let (cwd, project_id) = (place.cwd.clone(), place.project_id.clone());
    let payload = json!({ "cwd": cwd, "name": name, "carryChanges": carry });
    let result = call
        .recorded("git_switch_branch", &payload, move |owned| async move {
            // As the Source Control panel does: stash with untracked files, then a plain
            // checkout. A clean folder has nothing to stash.
            let mut stashed = false;
            if carry.as_deref() == Some("stash") && refs(&owned, &cwd).await?["isDirty"] == true {
                operate(
                    &owned,
                    json!({
                        "_tag": "stash-push", "cwd": cwd, "projectId": project_id,
                        "message": format!("WIP before switching to {name}"),
                        "paths": [], "includeUntracked": true,
                    }),
                )
                .await?;
                stashed = true;
            }
            let strategy = carry.filter(|carry| carry == "bring");
            let checkout = operate(
                &owned,
                json!({
                    "_tag": "branch-checkout", "cwd": cwd, "projectId": project_id,
                    "name": name, "strategy": strategy,
                }),
            )
            .await;
            match checkout {
                Ok(mut done) => {
                    done["branch"] = name.into();
                    done["stashed"] = stashed.into();
                    Ok(done)
                }
                Err(mut failure) if stashed => {
                    failure["structuredContent"]["error"]["stashed"] = true.into();
                    Err(failure)
                }
                Err(failure) => Err(failure),
            }
        })
        .await;
    finish(call, &place, result).await
}

async fn delete_branch(call: &ToolCall<'_>) -> ToolResult {
    let place = place(
        call,
        &[
            "threadId",
            "name",
            "force",
            "deleteRemote",
            "clientRequestId",
        ],
    )
    .await?;
    let name = required_branch(call, "name")?;
    let force = call.boolean("force")?.unwrap_or(false);
    let delete_remote = call.boolean("deleteRemote")?.unwrap_or(false);
    let (cwd, project_id) = (place.cwd.clone(), place.project_id.clone());
    let payload =
        json!({ "cwd": cwd, "name": name, "force": force, "deleteRemote": delete_remote });
    let result = call
        .recorded("git_delete_branch", &payload, move |owned| async move {
            // The upstream is resolved before anything is deleted: afterwards it is gone.
            let target = if delete_remote {
                let refs = refs(&owned, &cwd).await?;
                Some(upstream(&refs, &name)?.ok_or_else(|| {
                    let mut refused = typed_tool_failure(
                        "GitOperationFailedError",
                        "Remote deletion is refused because this branch has no upstream; nothing was deleted.",
                    );
                    refused["structuredContent"]["error"]["code"] = "no-upstream".into();
                    refused
                })?)
            } else {
                None
            };
            operate(
                &owned,
                json!({
                    "_tag": "branch-delete", "cwd": cwd, "projectId": project_id,
                    "name": name, "force": force, "deleteRemote": false,
                }),
            )
            .await?;
            let Some((remote, remote_branch)) = target else {
                return Ok(json!({ "branch": name, "local": "deleted", "remote": "not-requested" }));
            };
            let deleted = operate(
                &owned,
                json!({
                    "_tag": "remote-branch-delete", "cwd": cwd, "projectId": project_id,
                    "remote": remote, "branch": remote_branch,
                }),
            )
            .await;
            match deleted {
                Ok(_) => Ok(json!({ "branch": name, "local": "deleted", "remote": "deleted" })),
                // Whether a stream that stopped reporting reached the remote is unknown, and is
                // recorded so.
                Err(failure)
                    if failure["structuredContent"]["error"]["_tag"]
                        == crate::rpc::STREAM_ENDED_TAG =>
                {
                    Err(failure)
                }
                Err(failure) => Err(partial(&remote, &remote_branch, &failure)),
            }
        })
        .await;
    finish(call, &place, result).await
}

/// The local branch is gone and the remote one is not: the truth, with the call that finishes
/// it. A keyed retry replays it.
fn partial(remote: &str, remote_branch: &str, failure: &Value) -> Value {
    let error = &failure["structuredContent"]["error"];
    let reason = error["message"].as_str().unwrap_or("the remote refused it");
    let mut partial = typed_tool_failure(
        PARTIAL_TAG,
        &format!(
            "The local branch was deleted, but deleting the remote branch failed: {reason} Call git_delete_remote_branch with this remote and branch to finish."
        ),
    );
    let fields = &mut partial["structuredContent"]["error"];
    fields["local"] = "deleted".into();
    fields["remote"] = "failed".into();
    fields["remoteName"] = remote.into();
    fields["remoteBranch"] = remote_branch.into();
    fields["reason"] = error.get("code").cloned().unwrap_or(Value::Null);
    fields["recovery"] = json!({
        "tool": "git_delete_remote_branch",
        "arguments": { "remote": remote, "branch": remote_branch },
    });
    partial
}

async fn delete_remote_branch(call: &ToolCall<'_>) -> ToolResult {
    let place = place(call, &["threadId", "remote", "branch", "clientRequestId"]).await?;
    let remote =
        remote_name(call, "remote")?.ok_or_else(|| invalid_argument("remote is required"))?;
    let branch = required_branch(call, "branch")?;
    let payload = json!({
        "_tag": "remote-branch-delete", "cwd": place.cwd, "projectId": place.project_id,
        "remote": remote, "branch": branch,
    });
    let sent = payload.clone();
    let result = call
        .recorded(
            "git_delete_remote_branch",
            &payload,
            move |owned| async move {
                let mut done = operate(&owned, sent).await?;
                done["remote"] = remote.into();
                done["branch"] = branch.into();
                Ok(done)
            },
        )
        .await;
    finish(call, &place, result).await
}

async fn discard(call: &ToolCall<'_>) -> ToolResult {
    let place = place(call, &["threadId", "paths", "permanent", "clientRequestId"]).await?;
    let paths = checked_paths(call, &place.cwd).await?;
    let permanent = call.boolean("permanent")?.unwrap_or(false);
    let payload = json!({ "cwd": place.cwd, "paths": paths, "permitPermanent": permanent });
    let sent = payload.clone();
    let result = call
        .recorded("git_discard", &payload, move |owned| async move {
            let discarded = owned.invoke("gitManager.discard", sent).await?;
            Ok(json!({
                "trashed": discarded.get("trashed"),
                "permanentlyDiscarded": discarded.get("permanentlyDiscarded"),
                "trashUnavailable": discarded.get("trashUnavailable"),
            }))
        })
        .await;
    finish(call, &place, result).await
}
