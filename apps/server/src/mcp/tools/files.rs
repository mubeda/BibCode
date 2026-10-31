//! The workspace file tools (#139 slice X5): list, search, read, write, create, rename,
//! delete, and short-lived download and upload URLs, in the folder a thread works in.
//!
//! Each tool reaches the handler the Files panel uses (`projects.*`) with the call's
//! credential. Paths are literal and relative, checked by [`validate_paths`] before any RPC;
//! the workspace service then binds every operation to a folder handle opened without
//! following a symlink (`workspace::beneath`), so a folder swapped for a symlink after the
//! check cannot route it outside. A write needs the `version` of a complete read, or
//! `createOnly`. A delete goes to the system trash unless `permanent` is set. Transfers move no
//! bytes through MCP: the URL they return names this connection's session, and the route
//! serves it only while that session's access lasts (`production::transfer_routes`).
//! Nothing a tool names (a path, file content) is logged.

use serde_json::{Value, json};

use crate::{
    auth::{SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ},
    diagnostics::profiler::cli::to_json,
    mcp::{
        control::{
            CLIENT_REQUEST_ID, Family, McpCapability, ProgressSink, ToolCall, ToolFuture,
            ToolResult, ToolSpec, invalid_argument, object_schema,
        },
        protocol::{Cut, MAX_RESULT_CHARS, chars, tool_result, typed_tool_failure},
        target::validate_paths,
    },
};

const READ: &str = SCOPE_ORCHESTRATION_READ;
const OPERATE: &str = SCOPE_ORCHESTRATION_OPERATE;
const FILES: Option<McpCapability> = Some(McpCapability::Files);
/// The most characters one `files_read` page holds; escaped control characters can halve it.
const PAGE_CHARS: usize = 16_000;
const LEAST_PAGE_CHARS: usize = 500;
/// The longest `content` `files_write` takes, in bytes: the read cap, so what is written can be
/// read back.
const MOST_WRITE_BYTES: usize = 1024 * 1024;
/// `projects.listEntries` and `projects.searchEntries` answer at most this many entries.
const MOST_ENTRIES: i64 = 200;
const DEFAULT_SEARCH_LIMIT: i64 = 50;

pub(crate) const TOOLS: &[ToolSpec] = &[
    ToolSpec::client("files_list", READ, &["projects.listEntries"])
        .reads()
        .in_set(FILES),
    ToolSpec::client("files_search", READ, &["projects.searchEntries"])
        .reads()
        .in_set(FILES),
    ToolSpec::client("files_read", READ, &["projects.readFile"])
        .reads()
        .in_set(FILES),
    ToolSpec::client("files_write", OPERATE, &["projects.writeFileIfUnchanged"]).in_set(FILES),
    ToolSpec::client("files_create", OPERATE, &["projects.createEntry"]).in_set(FILES),
    ToolSpec::client("files_rename", OPERATE, &["projects.renameEntry"]).in_set(FILES),
    ToolSpec::client("files_delete", OPERATE, &["projects.deleteEntry"])
        .destroys()
        .in_set(FILES),
    ToolSpec::client("files_download", READ, &["projects.createDownloadUrl"])
        .reads()
        .in_set(FILES),
    // Destructive because `overwrite` can replace a file.
    ToolSpec::client("files_upload", OPERATE, &["projects.createUploadUrl"])
        .destroys()
        .in_set(FILES),
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
            "files_list" => list(call).await,
            "files_search" => search(call).await,
            "files_read" => read(call).await,
            "files_write" => write(call).await,
            "files_create" => create(call).await,
            "files_rename" => rename(call).await,
            "files_delete" => delete(call).await,
            "files_download" => download(call).await,
            "files_upload" => upload(call).await,
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
    let path = |description: &str| json!({ "type": "string", "description": format!("{description} A literal path relative to the thread's folder; globs and pathspec magic (a leading ':', or '*', '?', '[', '\\') are refused.") });
    let request_id = json!({ "type": "string", "description": CLIENT_REQUEST_ID });
    let object = object_schema;
    match name {
        "files_list" => (
            "Lists the files and folders in the thread's folder, at most limit of them (200 at most). truncated says more exist; files_search narrows them.",
            object(
                json!({
                    "threadId": thread,
                    "limit": { "type": "integer", "minimum": 1, "maximum": MOST_ENTRIES, "description": "At most this many entries; 200 unless set." },
                }),
                &["threadId"],
            ),
        ),
        "files_search" => (
            "Finds files and folders in the thread's folder whose path matches query, best first.",
            object(
                json!({
                    "threadId": thread,
                    "query": { "type": "string", "description": "Part of a path or file name." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MOST_ENTRIES, "description": "At most this many entries; 50 unless set." },
                }),
                &["threadId", "query"],
            ),
        ),
        "files_read" => (
            "Reads a text file in pages of at most 16,000 characters from offset. nextOffset reads the next page, with version set to the version this page returned; truncated says one remains. A file changed between pages is refused (McpFileChangedError): read it again from offset 0. version is the whole file's, for files_write. A file over 1 MiB, or a binary one, cannot be read here: files_download it.",
            object(
                json!({
                    "threadId": thread,
                    "path": path("The file."),
                    "offset": { "type": "integer", "minimum": 0, "description": "The character to start from; 0 unless set." },
                    "version": { "type": "string", "description": "Required past offset 0: the version the earlier page returned." },
                }),
                &["threadId", "path"],
            ),
        ),
        "files_write" => (
            "Replaces a text file's content, at most 1 MiB. Give expectedVersion, the version files_read returned, and the write is refused (file_changed_on_disk) if the file changed since; or createOnly to create a file that must not exist yet. Missing folders are created.",
            object(
                json!({
                    "threadId": thread,
                    "path": path("The file."),
                    "content": { "type": "string", "description": "The file's whole new content." },
                    "expectedVersion": { "type": "string", "description": "The version files_read returned for the file." },
                    "createOnly": { "type": "boolean", "description": "Create the file; refused when anything exists at path." },
                }),
                &["threadId", "path", "content"],
            ),
        ),
        "files_create" => (
            "Creates an empty file or a folder, and any missing folders above it. Refused when something exists at path.",
            object(
                json!({
                    "threadId": thread,
                    "path": path("The new file or folder."),
                    "kind": { "type": "string", "enum": ["file", "directory"], "description": "What to create." },
                }),
                &["threadId", "path", "kind"],
            ),
        ),
        "files_rename" => (
            "Renames or moves a file or folder inside the thread's folder. Refused when something exists at to.",
            object(
                json!({
                    "threadId": thread,
                    "from": path("The file or folder to move."),
                    "to": path("Its new path."),
                }),
                &["threadId", "from", "to"],
            ),
        ),
        "files_delete" => (
            "Destructive: deletes a file or a folder with everything in it. It goes to the system trash unless permanent is true; if the trash cannot take it, it is left in place (trash_unavailable), or, when its name was taken meanwhile, kept in BiBCode's staging folder (McpTrashStagedError says where).",
            object(
                json!({
                    "threadId": thread,
                    "path": path("The file or folder."),
                    "permanent": { "type": "boolean", "description": "Delete it permanently instead of moving it to the trash. Off unless set." },
                    "clientRequestId": request_id,
                }),
                &["threadId", "path"],
            ),
        ),
        "files_download" => (
            "Returns a URL that downloads a file, or a folder as a zip, with an HTTP GET. It works for 5 minutes and only while this connection's access lasts. Over ssh <host> bibcode mcp the URL is that host's loopback address, which you cannot reach: copy the file with scp instead.",
            object(
                json!({ "threadId": thread, "path": path("The file or folder.") }),
                &["threadId", "path"],
            ),
        ),
        "files_upload" => (
            "Destructive with overwrite: returns a URL that takes one file's bytes as an HTTP POST body and writes them to fileName in directory. It works for 5 minutes and only while this connection's access lasts. Without overwrite an existing file is refused (409). Over ssh <host> bibcode mcp the URL is that host's loopback address, which you cannot reach: copy the file with scp instead.",
            object(
                json!({
                    "threadId": thread,
                    "directory": { "type": "string", "description": "An existing folder relative to the thread's folder; \"\" or \".\" for the folder itself." },
                    "fileName": { "type": "string", "description": "A plain file name, without a path." },
                    "overwrite": { "type": "boolean", "description": "Replace a file of that name. Off unless set." },
                }),
                &["threadId", "directory", "fileName"],
            ),
        ),
        _ => ("", object(json!({}), &[])),
    }
}

/// Where a tool works: the thread and its folder.
struct Place {
    thread_id: String,
    cwd: String,
}

async fn place(call: &ToolCall<'_>, known: &[&str]) -> Result<Place, Value> {
    call.only(known)?;
    let thread_id = call.required("threadId")?.to_owned();
    let target = call.target(&thread_id).await?;
    Ok(Place {
        thread_id,
        cwd: target.cwd,
    })
}

/// The path argument `key`, checked against the thread's folder off the runtime (it reads the
/// file system) and normalized.
async fn checked_path(call: &ToolCall<'_>, cwd: &str, key: &str) -> Result<String, Value> {
    let path = call.required(key)?.to_owned();
    let cwd = std::path::PathBuf::from(cwd);
    let mut checked = tokio::task::spawn_blocking(move || validate_paths(&cwd, &[path]))
        .await
        .map_err(|_| invalid_argument("the path could not be checked; try again"))??;
    Ok(checked.remove(0))
}

/// A workspace RPC failure as the agent can act on it, naming `path` as the agent gave it and
/// never the host's absolute path.
fn file_failure(mut failure: Value, path: &str) -> Value {
    let error = &failure["structuredContent"]["error"];
    let message = match error["failure"].as_str() {
        Some("file_changed_on_disk") => format!(
            "{path} changed since it was read (or exists, with createOnly). Read it again with files_read and write with its version."
        ),
        Some("file_missing_on_disk") => {
            format!("{path} no longer exists. Write it with createOnly to create it.")
        }
        Some("path_not_found" | "not_found") => format!("Nothing exists at {path}."),
        Some("entry_already_exists") => format!("Something already exists at {path}."),
        Some("binary_file") => format!("{path} is binary; files_download it instead."),
        Some("path_not_file") => format!("{path} is not a file."),
        Some("workspace_path_outside_root" | "resolved_path_outside_root" | "outside_root") => {
            format!("{path} leaves the thread's folder.")
        }
        Some("trash_unavailable") => format!(
            "The system trash could not take {path}; it was left in place. Delete it with permanent: true only if the person asked for that."
        ),
        Some("kept_in_staging") => {
            let staged_at = error["stagedAt"].as_str().unwrap_or("bibcode-discard");
            let place = if error["stagedIn"] == "git-dir" {
                format!("in the repository's Git directory, at {staged_at}")
            } else {
                format!(
                    "in BiBCode's data folder on the server, at {staged_at} in the trash holder for this folder"
                )
            };
            format!(
                "The system trash could not take {path}, and it could not be put back because something else now has its name. It is not deleted: it is {place}. Tell the person; they can move it back by hand, and BiBCode moves it back itself on the next delete or discard in this folder once {path} is free."
            )
        }
        Some("hard_linked") => format!(
            "{path} has more than one hard link, so writing it could change a file outside the thread's folder. Ask the person to change it in BiBCode."
        ),
        Some("write_failed") => {
            if error["restored"] == true {
                format!("Writing {path} failed; its old content was put back.")
            } else {
                format!(
                    "Writing {path} failed after it was emptied, and its old content could not be put back. Tell the person."
                )
            }
        }
        Some("path_busy") => format!(
            "{path} is being written or uploaded by someone else through BiBCode right now. Try again when that ends."
        ),
        Some("partially_removed") => {
            let left_at = error["leftAt"].as_str().map_or_else(
                || path.to_owned(),
                |name| match path.rsplit_once('/') {
                    Some((folder, _)) => format!("{folder}/{name}"),
                    None => name.to_owned(),
                },
            );
            format!(
                "Deleting {path} stopped part-way; what is left is at {left_at}. Tell the person rather than retrying."
            )
        }
        // Not a workspace error, and naming no path: kept as the operation answered it.
        None if !error["message"]
            .as_str()
            .is_some_and(|message| message.contains(['/', '\\'])) =>
        {
            return failure;
        }
        // Anything else (permission denied, a full disk): the operating system's reason
        // without the host path it named.
        _ => {
            let reason = error["message"]
                .as_str()
                .and_then(|message| message.rsplit(": ").next())
                .filter(|reason| !reason.contains(['/', '\\']))
                .unwrap_or("the operation failed");
            format!("BiBCode could not complete this on {path}: {reason}.")
        }
    };
    if let Some(error) = failure["structuredContent"]["error"].as_object_mut() {
        // Only the tag, the failure and the message: nothing else that could name a host path.
        error.retain(|key, _| {
            matches!(
                key.as_str(),
                "_tag"
                    | "failure"
                    | "message"
                    | "outcome"
                    | "leftAt"
                    | "restored"
                    | "stagedAt"
                    | "stagedIn"
            )
        });
    }
    if failure["structuredContent"]["error"]["failure"] == "path_busy" {
        failure["structuredContent"]["error"]["_tag"] = BUSY_TAG.into();
    }
    if failure["structuredContent"]["error"]["failure"] == "hard_linked" {
        failure["structuredContent"]["error"]["_tag"] = HARD_LINKED_TAG.into();
    }
    if failure["structuredContent"]["error"]["failure"] == "kept_in_staging" {
        failure["structuredContent"]["error"]["_tag"] = TRASH_STAGED_TAG.into();
    }
    failure["structuredContent"]["error"]["message"] = message.clone().into();
    failure["content"] = json!([{ "type": "text", "text": message }]);
    failure
}

fn limit(call: &ToolCall<'_>, default: i64) -> Result<i64, Value> {
    match call.integer("limit")? {
        None => Ok(default),
        Some(limit) if (1..=MOST_ENTRIES).contains(&limit) => Ok(limit),
        Some(_) => Err(invalid_argument(&format!("limit is 1 to {MOST_ENTRIES}"))),
    }
}

/// An entries answer (`projects.listEntries`, `projects.searchEntries`) as the agent reads it.
fn entries(place: &Place, answer: &Value) -> ToolResult {
    Ok(tool_result(
        json!({
            "threadId": place.thread_id,
            "entries": answer.get("entries").cloned().unwrap_or_else(|| json!([])),
            "truncated": answer.get("truncated").cloned().unwrap_or(false.into()),
        }),
        &[("/entries", Cut::Back)],
    ))
}

async fn list(call: &ToolCall<'_>) -> ToolResult {
    let place = place(call, &["threadId", "limit"]).await?;
    let limit = limit(call, MOST_ENTRIES)?;
    let answer = call
        .invoke(
            "projects.listEntries",
            json!({ "cwd": place.cwd, "limit": limit }),
        )
        .await?;
    entries(&place, &answer)
}

async fn search(call: &ToolCall<'_>) -> ToolResult {
    let place = place(call, &["threadId", "query", "limit"]).await?;
    let query = call.required("query")?.to_owned();
    let limit = limit(call, DEFAULT_SEARCH_LIMIT)?;
    let answer = call
        .invoke(
            "projects.searchEntries",
            json!({ "cwd": place.cwd, "query": query, "limit": limit }),
        )
        .await?;
    entries(&place, &answer)
}

async fn read(call: &ToolCall<'_>) -> ToolResult {
    let place = place(call, &["threadId", "path", "offset", "version"]).await?;
    let path = checked_path(call, &place.cwd, "path").await?;
    let offset = usize::try_from(call.integer("offset")?.unwrap_or(0)).unwrap_or(usize::MAX);
    // A continuation page names the version it continues, so pages of two versions never mix.
    let continues = call.string("version")?.map(str::to_ascii_lowercase);
    if offset > 0 && continues.is_none() {
        return Err(invalid_argument(
            "a page after the first needs version, the version the first page returned",
        ));
    }
    let file = call
        .invoke(
            "projects.readFile",
            json!({ "cwd": place.cwd, "relativePath": path }),
        )
        .await
        .map_err(|failure| file_failure(failure, &path))?;
    if file["truncated"] == true {
        return Err(typed_tool_failure(
            "McpFileTooLargeError",
            &format!("{path} is larger than 1 MiB, too large to read here; files_download it."),
        ));
    }
    if continues.is_some_and(|version| file["version"] != version.as_str()) {
        return Err(typed_tool_failure(
            "McpFileChangedError",
            &format!(
                "{path} changed since the page you continue was read. Read it again from offset 0."
            ),
        ));
    }
    let contents = file["contents"].as_str().unwrap_or_default();
    let total = contents.chars().count();
    if offset > total {
        return Err(invalid_argument(&format!(
            "offset is past the end of {path}, which has {total} characters"
        )));
    }
    let rest = contents
        .char_indices()
        .nth(offset)
        .map_or("", |(at, _)| &contents[at..]);
    let mut page = PAGE_CHARS;
    loop {
        let text: String = rest.chars().take(page).collect();
        let taken = text.chars().count();
        let next = (offset + taken < total).then_some(offset + taken);
        let content = json!({
            "threadId": place.thread_id,
            "path": path,
            "text": text,
            "offset": offset,
            "nextOffset": next,
            "truncated": next.is_some(),
            "byteLength": file["byteLength"],
            "version": file["version"],
        });
        // Escaped control characters can make a full page too long for a result.
        if chars(&to_json(&content)) <= MAX_RESULT_CHARS || page <= LEAST_PAGE_CHARS {
            return Ok(tool_result(content, &[]));
        }
        page = (page / 2).max(LEAST_PAGE_CHARS);
    }
}

async fn write(call: &ToolCall<'_>) -> ToolResult {
    changes_files_here()?;
    let place = place(
        call,
        &[
            "threadId",
            "path",
            "content",
            "expectedVersion",
            "createOnly",
        ],
    )
    .await?;
    let path = checked_path(call, &place.cwd, "path").await?;
    let content = call
        .string("content")?
        .ok_or_else(|| invalid_argument("content is required"))?;
    if content.len() > MOST_WRITE_BYTES {
        return Err(invalid_argument("content is at most 1 MiB"));
    }
    let precondition = match (
        call.string("expectedVersion")?,
        call.boolean("createOnly")?.unwrap_or(false),
    ) {
        (Some(version), false)
            if version.len() == 64 && version.chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            json!({ "_tag": "version", "version": version.to_ascii_lowercase() })
        }
        (Some(_), false) => {
            return Err(invalid_argument(
                "expectedVersion is the version files_read returned",
            ));
        }
        (None, true) => json!({ "_tag": "missing" }),
        _ => {
            return Err(invalid_argument(
                "give exactly one of expectedVersion (from files_read) or createOnly: true",
            ));
        }
    };
    let written = call
        .invoke(
            "projects.writeFileIfUnchanged",
            json!({ "cwd": place.cwd, "relativePath": path, "contents": content, "precondition": precondition, "singleLinkOnly": true }),
        )
        .await
        .map_err(|failure| file_failure(failure, &path))?;
    Ok(tool_result(
        json!({ "threadId": place.thread_id, "path": path, "version": written["version"] }),
        &[],
    ))
}

async fn create(call: &ToolCall<'_>) -> ToolResult {
    changes_files_here()?;
    let place = place(call, &["threadId", "path", "kind"]).await?;
    let path = checked_path(call, &place.cwd, "path").await?;
    let kind = match call.required("kind")? {
        kind @ ("file" | "directory") => kind,
        _ => return Err(invalid_argument("kind is file or directory")),
    };
    call.invoke(
        "projects.createEntry",
        json!({ "cwd": place.cwd, "relativePath": path, "kind": kind }),
    )
    .await
    .map_err(|failure| file_failure(failure, &path))?;
    Ok(tool_result(
        json!({ "threadId": place.thread_id, "path": path, "kind": kind }),
        &[],
    ))
}

async fn rename(call: &ToolCall<'_>) -> ToolResult {
    changes_files_here()?;
    let place = place(call, &["threadId", "from", "to"]).await?;
    let from = checked_path(call, &place.cwd, "from").await?;
    let to = checked_path(call, &place.cwd, "to").await?;
    call.invoke(
        "projects.renameEntry",
        json!({ "cwd": place.cwd, "fromRelativePath": from, "toRelativePath": to }),
    )
    .await
    .map_err(|failure| {
        let named = if failure["structuredContent"]["error"]["failure"] == "entry_already_exists" {
            &to
        } else {
            &from
        };
        file_failure(failure, named)
    })?;
    Ok(tool_result(
        json!({ "threadId": place.thread_id, "from": from, "to": to }),
        &[],
    ))
}

async fn delete(call: &ToolCall<'_>) -> ToolResult {
    changes_files_here()?;
    let place = place(call, &["threadId", "path", "permanent", "clientRequestId"]).await?;
    let path = checked_path(call, &place.cwd, "path").await?;
    let permanent = call.boolean("permanent")?.unwrap_or(false);
    let payload = json!({ "cwd": place.cwd, "relativePath": path, "toTrash": !permanent });
    let sent = payload.clone();
    let (thread_id, named) = (place.thread_id.clone(), path.clone());
    call.recorded("files_delete", &payload, move |owned| async move {
        owned
            .invoke("projects.deleteEntry", sent)
            .await
            .map_err(|failure| file_failure(failure, &named))?;
        Ok(tool_result(
            json!({ "threadId": thread_id, "path": named, "trashed": !permanent }),
            &[],
        ))
    })
    .await
}

/// The tools that change files run only where every step is bound to a folder handle (Unix,
/// `workspace::beneath`). Elsewhere a folder another process swaps for a symlink between the
/// check and the call could still redirect them, so they are refused instead.
fn changes_files_here() -> Result<(), Value> {
    handle_bound(cfg!(unix))
}

fn handle_bound(supported: bool) -> Result<(), Value> {
    if supported {
        return Ok(());
    }
    Err(typed_tool_failure(
        PLATFORM_UNSUPPORTED_TAG,
        "Changing files over MCP is not available on this server's operating system yet. Reading, listing, searching and downloading work; ask the person to make the change in BiBCode.",
    ))
}

pub(crate) const PLATFORM_UNSUPPORTED_TAG: &str = "McpPlatformUnsupportedError";
/// A write refused because another BiBCode writer (an upload, or a write that did not end in
/// time) holds the file.
const BUSY_TAG: &str = "McpFileBusyError";
/// A write refused because the file has more than one hard link.
const HARD_LINKED_TAG: &str = "McpHardLinkedFileError";
/// A trashed entry the trash refused that could not go back under its name: it is in
/// BiBCode's staging folder.
const TRASH_STAGED_TAG: &str = "McpTrashStagedError";

/// The base a transfer URL is built on: the address this server is bound to, which the local
/// relay and `bibcode thread` reach. A remote OAuth session (slice R) gets the origin its
/// grant is bound to, the only address its agent can reach.
fn transfer_base(call: &ToolCall<'_>) -> Result<String, Value> {
    if let Some(origin) = call
        .principal
        .resource
        .as_deref()
        .and_then(|resource| resource.strip_suffix("/mcp"))
    {
        return Ok(origin.to_owned());
    }
    call.control
        .transfer_base()
        .map(str::to_owned)
        .ok_or_else(|| {
            typed_tool_failure(
                "McpTransferUnavailableError",
                "This BiBCode server has no transfer address yet; try again in a moment.",
            )
        })
}

async fn download(call: &ToolCall<'_>) -> ToolResult {
    let place = place(call, &["threadId", "path"]).await?;
    let path = checked_path(call, &place.cwd, "path").await?;
    let base = transfer_base(call)?;
    let minted = call
        .invoke(
            "projects.createDownloadUrl",
            json!({ "cwd": place.cwd, "relativePath": path }),
        )
        .await
        .map_err(|failure| file_failure(failure, &path))?;
    let relative_url = minted["relativeUrl"].as_str().unwrap_or_default();
    Ok(tool_result(
        json!({
            "threadId": place.thread_id,
            "path": path,
            "url": format!("{base}{relative_url}"),
            "method": "GET",
            "expiresAt": minted["expiresAt"],
            "fileName": minted["fileName"],
            "kind": minted["kind"],
            "transferId": crate::transfer::transfer_id(relative_url),
        }),
        &[],
    ))
}

async fn upload(call: &ToolCall<'_>) -> ToolResult {
    changes_files_here()?;
    let place = place(call, &["threadId", "directory", "fileName", "overwrite"]).await?;
    let directory = match call
        .string("directory")?
        .ok_or_else(|| invalid_argument("directory is required"))?
    {
        "" | "." | "./" => String::new(),
        _ => checked_path(call, &place.cwd, "directory").await?,
    };
    let file_name = call.required("fileName")?.to_owned();
    if crate::transfer::upload::validate_upload_file_name(&file_name).is_err() {
        return Err(invalid_argument(
            &crate::transfer::upload::upload_file_name_rule(),
        ));
    }
    let overwrite = call.boolean("overwrite")?.unwrap_or(false);
    let base = transfer_base(call)?;
    let minted = call
        .invoke(
            "projects.createUploadUrl",
            json!({ "cwd": place.cwd, "relativeDirectory": directory, "fileName": file_name, "overwrite": overwrite }),
        )
        .await
        .map_err(|failure| {
            let shown = if directory.is_empty() { "." } else { &directory };
            file_failure(failure, shown)
        })?;
    let relative_url = minted["relativeUrl"].as_str().unwrap_or_default();
    Ok(tool_result(
        json!({
            "threadId": place.thread_id,
            "directory": directory,
            "fileName": file_name,
            "overwrite": overwrite,
            "url": format!("{base}{relative_url}"),
            "method": "POST",
            "expiresAt": minted["expiresAt"],
            "maxBytes": minted["maxBytes"],
            "transferId": crate::transfer::transfer_id(relative_url),
        }),
        &[],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_changing_tools_are_refused_where_operations_are_not_handle_bound() {
        assert!(handle_bound(true).is_ok());
        let refused = handle_bound(false).unwrap_err();
        assert_eq!(
            refused["structuredContent"]["error"]["_tag"],
            PLATFORM_UNSUPPORTED_TAG
        );
        assert_eq!(changes_files_here().is_ok(), cfg!(unix));
    }
}
