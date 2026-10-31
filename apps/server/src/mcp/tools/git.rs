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
//!
//! Slice X7 adds the reads (`git_diff`, `git_log`, `git_refs`), which return bounded,
//! untrusted text through the panel's `gitManager.*` reads, and the commit message tools:
//! `git_generate_commit_message` (the deterministic `vcs.generateCommitMessage` line) and
//! `git_set_commit_message`, which only suggests a message to the Source Control panel through
//! a `commitMessage` UI intent. A suggestion never replaces what a person typed and never
//! commits.

use serde_json::{Value, json};

use crate::{
    auth::{SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ},
    git::manager::operations::is_branch_name,
    mcp::{
        control::{
            CLIENT_REQUEST_ID, Family, McpCapability, ProgressSink, ToolCall, ToolFuture,
            ToolResult, ToolSpec, invalid_argument, object_schema,
        },
        outcome::{Owned, outcome_unknown},
        protocol::{Cut, fit_list, tool_result, typed_tool_failure},
        target::validate_paths,
        tools::threads::diff_page,
    },
    production::ui_intents_rpc::{MOST_COMMIT_MESSAGE_CHARS, check_commit_message},
};

const OPERATE: &str = SCOPE_ORCHESTRATION_OPERATE;
const READ: &str = SCOPE_ORCHESTRATION_READ;
/// The most patch characters one `git_diff` page returns.
const DIFF_PAGE_CHARS: usize = 16_000;
/// Commits `git_log` returns unless `limit` says otherwise, and the most it takes.
const DEFAULT_LOG_LIMIT: i64 = 20;
const MOST_LOG_LIMIT: i64 = 100;
/// The most characters of a commit's body, and of its changed files, `git_log` returns.
const MOST_BODY_CHARS: usize = 2_000;
const MOST_SUBJECT_CHARS: usize = 1_000;
const MOST_CHANGED_FILES: usize = 50;
const PUBLISH_INTENT: &str = "ui.publishIntent";
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
    // The reads (slice X7). `git_log` also reads `gitManager.getRefs` to resolve its ref.
    ToolSpec::client("git_diff", READ, &["gitManager.getDiff"])
        .reads()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client("git_log", READ, &["gitManager.getCommits"])
        .reads()
        .in_set(SOURCE_CONTROL),
    ToolSpec::client(
        "git_refs",
        READ,
        &["gitManager.getRefs", "gitManager.getStashes"],
    )
    .reads()
    .in_set(SOURCE_CONTROL),
    // Neither is idempotent: each acts on the file's state at call time.
    ToolSpec::client("git_stage", OPERATE, &["vcs.stageFiles"]).in_set(SOURCE_CONTROL),
    ToolSpec::client("git_unstage", OPERATE, &["vcs.unstageFiles"]).in_set(SOURCE_CONTROL),
    ToolSpec::client("git_commit", OPERATE, &["gitManager.commit"]).in_set(SOURCE_CONTROL),
    // Changes nothing, but its method is registered as a mutation, so it needs operate.
    ToolSpec::client(
        "git_generate_commit_message",
        OPERATE,
        &["vcs.generateCommitMessage"],
    )
    .repeats_safely()
    .in_set(SOURCE_CONTROL),
    // A suggestion to the Source Control panel; a repeat offers it again.
    ToolSpec::client("git_set_commit_message", OPERATE, &[PUBLISH_INTENT]).in_set(SOURCE_CONTROL),
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
            "git_diff" => diff(call).await,
            "git_log" => log(call).await,
            "git_refs" => list_refs(call).await,
            "git_stage" => index(call, Index::Stage).await,
            "git_unstage" => index(call, Index::Unstage).await,
            "git_commit" => commit(call).await,
            "git_generate_commit_message" => generate_commit_message(call).await,
            "git_set_commit_message" => set_commit_message(call).await,
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
        "git_diff" => (
            "One file's changes in the thread's folder against HEAD, as a patch, at most 16000 characters a page; nextCursor reads the next page. staged true shows only what is staged; otherwise the working tree, staged changes included. An untracked file reads as added. A file too large to show returns its kind (large-text or unrenderable) and byteLength without content. git_status lists the changed files.",
            object(
                json!({
                    "threadId": thread,
                    "path": { "type": "string", "description": "A literal file path relative to the thread's folder." },
                    "staged": { "type": "boolean", "description": "Only what is staged. Off unless set." },
                    "cursor": { "type": "string", "description": "nextCursor of the previous page." },
                }),
                &["threadId", "path"],
            ),
        ),
        "git_log" => (
            "Commits reachable from ref (HEAD unless set), newest first: sha, parents, branches and tags pointing at it, subject, body (cut at 2000 characters, with bodyChars), author, committer, times in milliseconds and up to 50 changed files (with changedFileCount). nextCursor reads older commits from the same tip, even after the branch moves.",
            object(
                json!({
                    "threadId": thread,
                    "ref": { "type": "string", "description": "HEAD, a local or remote branch (origin/main), a tag, or a full commit sha. HEAD unless set." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MOST_LOG_LIMIT, "description": "Commits per page; 20 unless set." },
                    "cursor": { "type": "string", "description": "nextCursor of the previous page." },
                }),
                &["threadId"],
            ),
        ),
        "git_refs" => (
            "The repository's refs in the thread's folder: the current branch (or detached sha), whether it is dirty, the default branch, remotes, local and remote branches with upstream, ahead and behind, tags, stashes with their changed files, an operation in progress, and conflicted paths.",
            object(json!({ "threadId": thread }), &["threadId"]),
        ),
        "git_generate_commit_message" => (
            "A plain commit message line for the thread's changes: \"Update <paths>\" for the paths named, else for the first changed file of what is staged (or of the working tree when nothing is staged). It is deterministic and reads no content into prose; a message you write from git_diff is usually better. Nothing is committed.",
            object(json!({ "threadId": thread, "paths": paths }), &["threadId"]),
        ),
        "git_set_commit_message" => (
            "Suggests a commit message to the person in the Source Control panel of the thread's folder. An empty message box is filled, labelled as yours; text the person typed is never replaced, and they are offered yours to use or dismiss. BiBCode keeps the last suggestion per folder for 24 hours. It never commits; use git_commit for that.",
            object(
                json!({
                    "threadId": thread,
                    "message": { "type": "string", "maxLength": MOST_COMMIT_MESSAGE_CHARS, "description": "The suggested message: the summary line, then a blank line and the body. Tabs and line breaks are the only control characters allowed." },
                }),
                &["threadId", "message"],
            ),
        ),
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
            "Destructive: deletes a local branch, and with deleteRemote its upstream branch on the remote too, in that order. If the remote deletion fails, or stops before it reports (remote: unknown; run git_fetch to check), the result is McpPartialOutcomeError naming the git_delete_remote_branch call that finishes it.",
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
            "Destructive: discards the changes of files or folders, restoring tracked files and removing untracked ones. Files go to the system trash; a file the trash cannot take is kept and listed in trashUnavailable, unless permanent is true. An ignored file that permanent deletion leaves in place is listed there too.",
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

/// Checks that only `known` arguments are given and returns the thread id. The thread's
/// folder is resolved inside the recorded work ([`folder`]), so a keyed retry returns its
/// stored outcome even after the thread is deleted.
fn thread_id(call: &ToolCall<'_>, known: &[&str]) -> Result<String, Value> {
    call.only(known)?;
    Ok(call.required("threadId")?.to_owned())
}

/// The folder thread `thread_id` works in and its project, resolved when the work runs.
async fn folder(owned: &Owned, thread_id: &str) -> Result<(String, String), Value> {
    let target = owned.target(thread_id).await?;
    Ok((target.cwd, target.project_id))
}

/// The tool result: the work's outcome, the thread, and a fresh Git status summary. The status
/// is read again on a retry that returns a stored outcome, so it is always current; it is
/// `null` when the thread no longer names a folder.
async fn finish(call: &ToolCall<'_>, thread_id: &str, result: ToolResult) -> ToolResult {
    let mut content = result?;
    content["threadId"] = thread_id.into();
    content["status"] = match call.target(thread_id).await {
        Ok(target) => status(call, &target.cwd).await,
        Err(_) => Value::Null,
    };
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
async fn checked_paths(paths: Vec<String>, cwd: &str) -> Result<Vec<String>, Value> {
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

/// Whether `remote` is a remote name Git reads as nothing else: a branch-name shape (no
/// leading '-', so never an option) without a '/'.
fn is_remote_name(remote: &str) -> bool {
    is_branch_name(remote) && !remote.contains('/')
}

/// A remote argument's shape; whether the repository has it is checked against its refs.
fn remote_name(call: &ToolCall<'_>, key: &str) -> Result<Option<String>, Value> {
    match call.string(key)? {
        None => Ok(None),
        Some(remote) if is_remote_name(remote) => Ok(Some(remote.to_owned())),
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
/// else `origin`, else the only remote. A remote chosen for the agent passes the same shape
/// check as a named one: Git accepts a configured remote such as `--all`, which a command
/// would read as an option.
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
    let chosen = upstream_remote
        .map(str::to_owned)
        .or_else(|| known.contains(&"origin").then(|| "origin".to_owned()))
        .or_else(|| (known.len() == 1).then(|| known[0].to_owned()))
        .ok_or_else(|| {
            invalid_argument(if known.is_empty() {
                "this repository has no remote"
            } else {
                "name the remote: this repository has several and none is origin"
            })
        })?;
    if is_remote_name(&chosen) {
        Ok(chosen)
    } else {
        Err(invalid_argument(
            "this repository's remote has a name a Git command could misread; rename it, or name another remote",
        ))
    }
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
    let thread_id = thread_id(call, &["threadId", "paths"])?;
    let paths = string_list(call, "paths")?;
    let (tool, method, key) = match which {
        Index::Stage => ("git_stage", "vcs.stageFiles", "staged"),
        Index::Unstage => ("git_unstage", "vcs.unstageFiles", "unstaged"),
    };
    let payload = json!({ "threadId": thread_id, "paths": paths });
    let thread = thread_id.clone();
    let result = call
        .recorded(tool, &payload, move |owned| async move {
            let (cwd, _) = folder(&owned, &thread).await?;
            let paths = checked_paths(paths, &cwd).await?;
            owned
                .invoke(method, json!({ "cwd": cwd, "filePaths": paths }))
                .await?;
            let mut done = json!({});
            done[key] = paths.into();
            Ok(done)
        })
        .await;
    finish(call, &thread_id, result).await
}

async fn commit(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(
        call,
        &["threadId", "summary", "description", "clientRequestId"],
    )?;
    let summary = call.required("summary")?.trim().to_owned();
    let description = call.string("description")?.unwrap_or_default().to_owned();
    let payload = json!({ "threadId": thread_id, "summary": summary, "description": description });
    let thread = thread_id.clone();
    let result = call
        .recorded("git_commit", &payload, move |owned| async move {
            let (cwd, _) = folder(&owned, &thread).await?;
            let sent = json!({
                "cwd": cwd, "summary": summary, "description": description,
                "amend": false, "noVerify": false, "signoff": false, "allowEmpty": false,
                "coAuthors": [],
            });
            let commit = owned.invoke("gitManager.commit", sent).await?;
            Ok(json!({ "sha": commit.get("sha"), "empty": commit.get("empty") }))
        })
        .await;
    finish(call, &thread_id, result).await
}

async fn undo_commit(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId", "clientRequestId"])?;
    let payload = json!({ "threadId": thread_id });
    let thread = thread_id.clone();
    let result = call
        .recorded("git_undo_commit", &payload, move |owned| async move {
            let (cwd, _) = folder(&owned, &thread).await?;
            let undone = owned
                .invoke("gitManager.undoCommit", json!({ "cwd": cwd }))
                .await?;
            Ok(json!({
                "summary": undone.get("summary"),
                "description": undone.get("description"),
                "coAuthors": undone.get("coAuthors"),
            }))
        })
        .await;
    finish(call, &thread_id, result).await
}

async fn revert_commit(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId", "sha", "clientRequestId"])?;
    let sha = revision(call, "sha")?.ok_or_else(|| invalid_argument("sha is required"))?;
    let payload = json!({ "threadId": thread_id, "sha": sha });
    let thread = thread_id.clone();
    let result = call
        .recorded("git_revert_commit", &payload, move |owned| async move {
            let (cwd, project_id) = folder(&owned, &thread).await?;
            operate(
                &owned,
                json!({ "_tag": "revert", "cwd": cwd, "projectId": project_id, "sha": sha }),
            )
            .await
        })
        .await;
    finish(call, &thread_id, result).await
}

async fn push(call: &ToolCall<'_>, force: bool) -> ToolResult {
    let thread_id = thread_id(
        call,
        &[
            "threadId",
            "remote",
            "branch",
            "remoteBranch",
            "pushTags",
            "clientRequestId",
        ],
    )?;
    let remote = remote_name(call, "remote")?;
    let branch = branch_name(call, "branch")?;
    let remote_branch = branch_name(call, "remoteBranch")?;
    let push_tags = call.boolean("pushTags")?.unwrap_or(false);
    let tool = if force { "git_force_push" } else { "git_push" };
    // The folder, branch, remote and kind of push are resolved when the work runs; the row
    // keeps what was asked.
    let payload = json!({
        "threadId": thread_id, "remote": remote, "branch": branch, "remoteBranch": remote_branch,
        "pushTags": push_tags, "force": force,
    });
    let thread = thread_id.clone();
    let result = call
        .recorded(tool, &payload, move |owned| async move {
            let (cwd, project_id) = folder(&owned, &thread).await?;
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
    finish(call, &thread_id, result).await
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
    let thread_id = thread_id(call, known)?;
    let remote = remote_name(call, "remote")?;
    let payload = json!({ "threadId": thread_id, "remote": remote, "operation": kind });
    let thread = thread_id.clone();
    let result = call
        .recorded(tool, &payload, move |owned| async move {
            let (cwd, project_id) = folder(&owned, &thread).await?;
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
    finish(call, &thread_id, result).await
}

async fn create_branch(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId", "name", "startPoint", "checkout"])?;
    let name = required_branch(call, "name")?;
    let start_point = revision(call, "startPoint")?;
    let checkout = call.boolean("checkout")?.unwrap_or(true);
    let payload = json!({
        "threadId": thread_id, "name": name, "startPoint": start_point, "checkout": checkout,
    });
    let thread = thread_id.clone();
    let result = call
        .recorded("git_create_branch", &payload, move |owned| async move {
            let (cwd, project_id) = folder(&owned, &thread).await?;
            let sent = json!({
                "_tag": "branch-create", "cwd": cwd, "projectId": project_id,
                "name": name, "startPoint": start_point, "checkout": checkout,
            });
            let mut done = operate(&owned, sent).await?;
            done["branch"] = name.into();
            Ok(done)
        })
        .await;
    finish(call, &thread_id, result).await
}

async fn switch_branch(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId", "name", "carryChanges"])?;
    let name = required_branch(call, "name")?;
    let carry = match call.string("carryChanges")? {
        None => None,
        Some(carry @ ("stash" | "bring")) => Some(carry.to_owned()),
        Some(_) => return Err(invalid_argument("carryChanges is stash or bring")),
    };
    let payload = json!({ "threadId": thread_id, "name": name, "carryChanges": carry });
    let thread = thread_id.clone();
    let result = call
        .recorded("git_switch_branch", &payload, move |owned| async move {
            let (cwd, project_id) = folder(&owned, &thread).await?;
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
    finish(call, &thread_id, result).await
}

async fn delete_branch(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(
        call,
        &[
            "threadId",
            "name",
            "force",
            "deleteRemote",
            "clientRequestId",
        ],
    )?;
    let name = required_branch(call, "name")?;
    let force = call.boolean("force")?.unwrap_or(false);
    let delete_remote = call.boolean("deleteRemote")?.unwrap_or(false);
    let payload = json!({
        "threadId": thread_id, "name": name, "force": force, "deleteRemote": delete_remote,
    });
    let thread = thread_id.clone();
    let result = call
        .recorded("git_delete_branch", &payload, move |owned| async move {
            let (cwd, project_id) = folder(&owned, &thread).await?;
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
                // recorded so, with the known local deletion and the remote target.
                Err(failure)
                    if failure["structuredContent"]["error"]["_tag"]
                        == crate::rpc::STREAM_ENDED_TAG =>
                {
                    Err(outcome_unknown(partial(
                        &remote,
                        &remote_branch,
                        &failure,
                        true,
                    )))
                }
                Err(failure) => Err(partial(&remote, &remote_branch, &failure, false)),
            }
        })
        .await;
    finish(call, &thread_id, result).await
}

/// The local branch is gone and the remote one is not, or may not be (`unknown`, when the
/// remote step stopped reporting): the truth, with the call that finishes it. A keyed retry
/// replays it.
fn partial(remote: &str, remote_branch: &str, failure: &Value, unknown: bool) -> Value {
    let error = &failure["structuredContent"]["error"];
    let reason = error["message"].as_str().unwrap_or("the remote refused it");
    let mut partial = typed_tool_failure(
        PARTIAL_TAG,
        &if unknown {
            format!(
                "The local branch was deleted, but whether the remote branch was deleted is unknown: {reason} Run git_fetch; if {remote}/{remote_branch} is still listed, call git_delete_remote_branch with this remote and branch to finish."
            )
        } else {
            format!(
                "The local branch was deleted, but deleting the remote branch failed: {reason} Call git_delete_remote_branch with this remote and branch to finish."
            )
        },
    );
    let fields = &mut partial["structuredContent"]["error"];
    fields["local"] = "deleted".into();
    fields["remote"] = if unknown { "unknown" } else { "failed" }.into();
    fields["remoteName"] = remote.into();
    fields["remoteBranch"] = remote_branch.into();
    fields["reason"] = error
        .get("code")
        .or_else(|| error.get("reason"))
        .cloned()
        .unwrap_or(Value::Null);
    fields["recovery"] = json!({
        "tool": "git_delete_remote_branch",
        "arguments": { "remote": remote, "branch": remote_branch },
    });
    partial
}

async fn delete_remote_branch(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId", "remote", "branch", "clientRequestId"])?;
    let remote =
        remote_name(call, "remote")?.ok_or_else(|| invalid_argument("remote is required"))?;
    let branch = required_branch(call, "branch")?;
    let payload = json!({ "threadId": thread_id, "remote": remote, "branch": branch });
    let thread = thread_id.clone();
    let result = call
        .recorded(
            "git_delete_remote_branch",
            &payload,
            move |owned| async move {
                let (cwd, project_id) = folder(&owned, &thread).await?;
                let sent = json!({
                    "_tag": "remote-branch-delete", "cwd": cwd, "projectId": project_id,
                    "remote": remote, "branch": branch,
                });
                let mut done = operate(&owned, sent).await?;
                done["remote"] = remote.into();
                done["branch"] = branch.into();
                Ok(done)
            },
        )
        .await;
    finish(call, &thread_id, result).await
}

async fn discard(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId", "paths", "permanent", "clientRequestId"])?;
    let paths = string_list(call, "paths")?;
    let permanent = call.boolean("permanent")?.unwrap_or(false);
    let payload = json!({ "threadId": thread_id, "paths": paths, "permitPermanent": permanent });
    let thread = thread_id.clone();
    let result = call
        .recorded("git_discard", &payload, move |owned| async move {
            let (cwd, _) = folder(&owned, &thread).await?;
            let paths = checked_paths(paths, &cwd).await?;
            let sent = json!({ "cwd": cwd, "paths": paths, "permitPermanent": permanent });
            let discarded = owned.invoke("gitManager.discard", sent).await?;
            Ok(json!({
                "trashed": discarded.get("trashed"),
                "permanentlyDiscarded": discarded.get("permanentlyDiscarded"),
                "trashUnavailable": discarded.get("trashUnavailable"),
            }))
        })
        .await;
    finish(call, &thread_id, result).await
}

/// The thread's folder for a read or a suggestion, resolved now: neither records anything.
async fn current_folder(call: &ToolCall<'_>, thread_id: &str) -> Result<String, Value> {
    Ok(call.target(thread_id).await?.cwd)
}

/// A `file:offset` cursor a paged patch returned.
fn patch_cursor(cursor: &str) -> Result<(usize, usize), Value> {
    cursor
        .split_once(':')
        .and_then(|(file, offset)| Some((file.parse().ok()?, offset.parse().ok()?)))
        .ok_or_else(|| invalid_argument("cursor is not one this tool returned"))
}

/// The patch of `getDiff`'s output: what follows Git's raw header (`--patch-with-raw -z`,
/// NUL-separated), from the first `diff --git` that starts a line.
fn patch_text(output: &str) -> &str {
    let mut from = 0;
    while let Some(found) = output[from..].find("diff --git ") {
        let at = from + found;
        if at == 0 || matches!(output.as_bytes()[at - 1], b'\n' | b'\0') {
            return &output[at..];
        }
        from = at + 1;
    }
    ""
}

async fn diff(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId", "path", "staged", "cursor"])?;
    let path = call.required("path")?.to_owned();
    let staged = call.boolean("staged")?.unwrap_or(false);
    let (file_index, offset) = match call.string("cursor")? {
        None => (0, 0),
        Some(cursor) => patch_cursor(cursor)?,
    };
    let cwd = current_folder(call, &thread_id).await?;
    let path = checked_paths(vec![path], &cwd)
        .await?
        .pop()
        .ok_or_else(|| invalid_argument("path is required"))?;
    let diff = call
        .invoke(
            "gitManager.getDiff",
            json!({
                "cwd": cwd,
                "source": { "_tag": "working-tree", "path": path, "staged": staged },
            }),
        )
        .await?;
    // Only a patch is returned. A file too large to show is named by its kind and size; an
    // image's bytes, which the panel draws, are never returned.
    let kind = diff["_tag"]
        .as_str()
        .filter(|kind| matches!(*kind, "patch" | "large-text"))
        .unwrap_or("unrenderable");
    let (patch, next_cursor) = if kind == "patch" {
        let page = diff_page(
            patch_text(diff["patch"].as_str().unwrap_or_default()),
            file_index,
            offset,
            DIFF_PAGE_CHARS,
        );
        (Value::String(page.patch), page.next_cursor.into())
    } else {
        (Value::Null, Value::Null)
    };
    Ok(tool_result(
        json!({
            "threadId": thread_id,
            "path": path,
            "staged": staged,
            "kind": kind,
            "byteLength": diff.get("byteLength"),
            "patch": patch,
            "nextCursor": next_cursor,
        }),
        &[],
    ))
}

/// Whether `value` is a full commit id, as `gitManager.getCommits` takes it.
fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A `sha:offset` cursor `git_log` returned.
fn log_cursor(cursor: &str) -> Result<(String, usize), Value> {
    cursor
        .split_once(':')
        .filter(|(tip, _)| is_object_id(tip))
        .and_then(|(tip, offset)| Some((tip.to_ascii_lowercase(), offset.parse().ok()?)))
        .ok_or_else(|| invalid_argument("cursor is not one this tool returned"))
}

/// The commit `reference` names in the folder's refs: HEAD, a local or remote branch, a tag
/// (peeled), or a full sha. `None` when HEAD names no commit yet.
async fn resolve_ref(
    call: &ToolCall<'_>,
    cwd: &str,
    reference: &str,
) -> Result<Option<String>, Value> {
    if is_object_id(reference) {
        return Ok(Some(reference.to_ascii_lowercase()));
    }
    let refs = call
        .invoke("gitManager.getRefs", json!({ "cwd": cwd }))
        .await?;
    let tip = |key: &str, name: &str| {
        refs[key].as_array().and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["name"].as_str() == Some(name))
                .and_then(|entry| entry["tipSha"].as_str())
                .map(str::to_owned)
        })
    };
    if reference == "HEAD" {
        return Ok(match refs["detachedSha"].as_str() {
            Some(sha) => Some(sha.to_owned()),
            None => refs["headRef"]
                .as_str()
                .and_then(|head| tip("localBranches", head)),
        });
    }
    ["localBranches", "remoteBranches", "tags"]
        .into_iter()
        .find_map(|key| tip(key, reference))
        .map(Some)
        .ok_or_else(|| {
            invalid_argument(&format!(
                "there is no branch, tag or full commit sha {reference}; git_refs lists them"
            ))
        })
}

/// The first `most` characters of `text`.
fn cut(text: &str, most: usize) -> String {
    text.chars().take(most).collect()
}

/// One commit as `git_log` returns it: the message and the file list bounded.
fn log_entry(commit: &Value) -> Value {
    let subject = commit["subject"].as_str().unwrap_or_default();
    let body = commit["body"].as_str().unwrap_or_default();
    let files = commit["changedFiles"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    json!({
        "sha": commit.get("sha"),
        "shortSha": commit.get("shortSha"),
        "parents": commit.get("parents"),
        "decorations": commit.get("decorations"),
        "subject": cut(subject, MOST_SUBJECT_CHARS),
        "body": cut(body, MOST_BODY_CHARS),
        "bodyChars": body.chars().count(),
        "authorName": commit.get("authorName"),
        "authorEmail": commit.get("authorEmail"),
        "authoredAtMs": commit.get("authoredAtMs"),
        "committerName": commit.get("committerName"),
        "committerEmail": commit.get("committerEmail"),
        "committedAtMs": commit.get("committedAtMs"),
        "changedFiles": &files[..files.len().min(MOST_CHANGED_FILES)],
        "changedFileCount": files.len(),
    })
}

async fn log(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId", "ref", "limit", "cursor"])?;
    let reference = revision(call, "ref")?.unwrap_or_else(|| "HEAD".to_owned());
    let limit = match call.integer("limit")? {
        None => DEFAULT_LOG_LIMIT,
        Some(limit) if (1..=MOST_LOG_LIMIT).contains(&limit) => limit,
        Some(_) => return Err(invalid_argument("limit is 1 to 100")),
    };
    let cursor = call.string("cursor")?.map(log_cursor).transpose()?;
    let cwd = current_folder(call, &thread_id).await?;
    // A cursor keeps paging from the tip the first page resolved, so a moved branch skips
    // nothing and repeats nothing.
    let (tip, offset) = match cursor {
        Some(cursor) => cursor,
        None => match resolve_ref(call, &cwd, &reference).await? {
            Some(tip) => (tip, 0),
            None => {
                return Ok(tool_result(
                    json!({ "threadId": thread_id, "ref": reference, "commits": [], "nextCursor": null }),
                    &[],
                ));
            }
        },
    };
    let page = call
        .invoke(
            "gitManager.getCommits",
            json!({ "cwd": cwd, "pinnedTips": [tip], "offset": offset, "limit": limit }),
        )
        .await?;
    let commits: Vec<Value> = page["commits"]
        .as_array()
        .map(|commits| commits.iter().map(log_entry).collect())
        .unwrap_or_default();
    let mut content = json!({
        "threadId": thread_id,
        "ref": reference,
        "tip": tip,
        "commits": commits,
        "nextCursor": null,
    });
    // Fit the page first, then point the cursor after the last commit kept.
    let dropped = fit_list(&mut content, "/commits", Cut::Back, 1);
    let kept = content["commits"].as_array().map_or(0, Vec::len);
    if dropped > 0 || !page["nextOffset"].is_null() {
        content["nextCursor"] = format!("{tip}:{}", offset + kept).into();
    }
    Ok(tool_result(content, &[]))
}

/// One branch or tag as `git_refs` returns it, without the panel's guard reasons.
fn ref_entry(entry: &Value) -> Value {
    json!({
        "name": entry.get("name"),
        "tipSha": entry.get("tipSha"),
        "upstream": entry.get("upstream"),
        "ahead": entry.get("ahead"),
        "behind": entry.get("behind"),
        "current": entry.get("current"),
        "isDefault": entry.get("isDefault"),
        "worktreePath": entry.get("worktreePath"),
    })
}

fn ref_entries(refs: &Value, key: &str) -> Vec<Value> {
    refs[key]
        .as_array()
        .map(|entries| entries.iter().map(ref_entry).collect())
        .unwrap_or_default()
}

async fn list_refs(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId"])?;
    let cwd = current_folder(call, &thread_id).await?;
    let refs = call
        .invoke("gitManager.getRefs", json!({ "cwd": cwd }))
        .await?;
    let stashes = call
        .invoke("gitManager.getStashes", json!({ "cwd": cwd }))
        .await?;
    let stashes: Vec<Value> = stashes
        .as_array()
        .map(|stashes| {
            stashes
                .iter()
                .map(|stash| {
                    json!({
                        "index": stash.get("index"),
                        "sha": stash.get("sha"),
                        "message": stash.get("message"),
                        "committedAtMs": stash.get("committedAtMs"),
                        "files": stash.get("files"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(tool_result(
        json!({
            "threadId": thread_id,
            "headRef": refs.get("headRef"),
            "detachedSha": refs.get("detachedSha"),
            "isDirty": refs.get("isDirty"),
            "defaultBranch": refs.get("defaultBranch"),
            "remotes": refs.get("remotes"),
            "localBranches": ref_entries(&refs, "localBranches"),
            "remoteBranches": ref_entries(&refs, "remoteBranches"),
            "tags": ref_entries(&refs, "tags"),
            "stashes": stashes,
            "inProgressOperation": refs.get("inProgressOperation"),
            "conflictedPaths": refs.get("conflictedPaths"),
        }),
        &[
            ("/tags", Cut::Back),
            ("/remoteBranches", Cut::Back),
            ("/stashes", Cut::Back),
            ("/localBranches", Cut::Back),
            ("/conflictedPaths", Cut::Back),
        ],
    ))
}

async fn generate_commit_message(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId", "paths"])?;
    let paths = match call.arguments.get("paths") {
        None | Some(Value::Null) => None,
        Some(_) => Some(string_list(call, "paths")?),
    };
    let cwd = current_folder(call, &thread_id).await?;
    let paths = match paths {
        Some(paths) => Some(checked_paths(paths, &cwd).await?),
        None => None,
    };
    let generated = call
        .invoke(
            "vcs.generateCommitMessage",
            json!({ "cwd": cwd, "filePaths": paths }),
        )
        .await?;
    Ok(tool_result(
        json!({ "threadId": thread_id, "message": generated.get("message") }),
        &[],
    ))
}

async fn set_commit_message(call: &ToolCall<'_>) -> ToolResult {
    let thread_id = thread_id(call, &["threadId", "message"])?;
    let message = call.required("message")?.to_owned();
    check_commit_message(&message).map_err(invalid_argument)?;
    let cwd = current_folder(call, &thread_id).await?;
    let published = call
        .invoke(
            PUBLISH_INTENT,
            json!({ "kind": "commitMessage", "threadId": thread_id, "cwd": cwd, "message": message }),
        )
        .await?;
    Ok(tool_result(
        json!({
            "threadId": thread_id,
            "intentId": published.get("intentId"),
            "subscribers": published.get("subscribers"),
        }),
        &[],
    ))
}
