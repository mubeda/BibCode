//! The chat panel and UI tools (#139 slice X4): open a chat panel on a worktree's host thread,
//! list a host's panels, pass a message from one thread of a worktree to another, and suggest
//! what a person might look at.
//!
//! A panel is created by `worktree.createPanel`, whose `commandId` replays by its receipt, so a
//! retry with the same `clientRequestId` returns the same panel. A panel message is a
//! `thread.turn.start` that names its source; the engine accepts that only from an outside
//! agent's command and only for another thread of the target's worktree, so no client can point
//! provenance at an unrelated thread. `focus_ui` publishes an advisory intent: clients raise a
//! toast and move nothing until a person clicks **Show**.

use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    auth::{SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ},
    mcp::{
        activity::PURPOSE,
        control::{
            CLIENT_REQUEST_ID, Family, McpAccess, ProgressSink, ToolCall, ToolFuture, ToolResult,
            ToolSpec, invalid_argument, now_iso, object_schema, rpc_failure, storage_failure,
        },
        protocol::{Cut, fit_list, tool_result, typed_tool_failure},
        target::validate_paths,
    },
    persistence::ProjectionThread,
    production::ui_intents_rpc::{PATH_SURFACES, SURFACES},
};

const READ: &str = SCOPE_ORCHESTRATION_READ;
const OPERATE: &str = SCOPE_ORCHESTRATION_OPERATE;
const CREATE_PANEL: &str = "worktree.createPanel";
const PUBLISH_INTENT: &str = "ui.publishIntent";
/// The longest message, as `send_message` takes, quote included.
const MOST_TEXT_CHARS: usize = 120_000;
/// The characters of the source's last reply a panel message quotes.
pub(crate) const MOST_QUOTED_CHARS: usize = 16_000;
const QUOTED_SQL_CHARS: i64 = 16_000;

/// The panel tools, in the order `tools/list` shows them.
pub(crate) const TOOLS: &[ToolSpec] = &[
    ToolSpec::client("create_chat_panel", OPERATE, &[CREATE_PANEL]),
    ToolSpec::client("list_chat_panels", READ, &["orchestration.subscribeShell"]).reads(),
    ToolSpec::client(
        "send_panel_message",
        OPERATE,
        &["orchestration.dispatchCommand"],
    ),
    ToolSpec::client("focus_ui", OPERATE, &[PUBLISH_INTENT]),
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
            "create_chat_panel" => call.create_chat_panel().await,
            "list_chat_panels" => call.list_chat_panels().await,
            "send_panel_message" => call.send_panel_message().await,
            "focus_ui" => call.focus_ui().await,
            _ => Err(typed_tool_failure("McpUnknownToolError", "Unknown tool.")),
        }
    })
}

fn text(name: &str) -> Option<(&'static str, Value)> {
    let host = json!({ "type": "string", "description": "A workspace thread that hosts panels: a worktree's host thread (list_worktrees names it) or any thread that is not itself a panel." });
    let thread = json!({ "type": "string", "description": "A thread id, as list_projects_and_threads or list_chat_panels returns it." });
    let request_id = json!({ "type": "string", "description": CLIENT_REQUEST_ID });
    Some(match name {
        "create_chat_panel" => (
            "Opens a chat panel: a second thread beside a host thread, in the same folder, which every BiBCode window shows as a tab. Returns its threadId; give it work with send_message or send_panel_message. It runs at runtimeMode, never above this connection's limit, with the project's default model unless providerInstanceId and model are set.",
            object_schema(
                json!({
                    "hostThreadId": host,
                    "title": { "type": "string", "description": "The panel's tab title; \"Panel — <provider>\" unless set." },
                    "providerInstanceId": { "type": "string", "description": "An instance id from list_providers_and_models." },
                    "model": { "type": "string", "description": "A model slug from list_providers_and_models." },
                    "runtimeMode": {
                        "type": "string",
                        "enum": ["approval-required", "auto-accept-edits", "full-access"],
                        "description": "The panel's mode; this connection's limit unless set, and never above it.",
                    },
                    "purpose": { "type": "string", "maxLength": 200, "description": PURPOSE },
                    "clientRequestId": request_id,
                }),
                &["hostThreadId"],
            ),
        ),
        "list_chat_panels" => (
            "The open chat panels of a host thread, with each one's status, model and mode.",
            object_schema(json!({ "hostThreadId": host }), &["hostThreadId"]),
        ),
        "send_panel_message" => (
            "Sends a message from one thread of a worktree to another (a host and its panels, or two panels of one host), and BiBCode shows which thread it came from, so fromThreadId must be a thread you opened or whose latest message you sent. It is queued behind a running turn; mode steer asks the running turn to take it now and falls back to queued. With includeLastReply, the source thread's last reply is quoted after text (at most 16000 characters of it). Returns the messageId to pass to wait_for_thread.",
            object_schema(
                json!({
                    "fromThreadId": thread,
                    "toThreadId": thread,
                    "text": { "type": "string" },
                    "mode": { "type": "string", "enum": ["queue", "steer"], "description": "queue unless set." },
                    "includeLastReply": { "type": "boolean", "description": "Quote the source thread's last reply. Off unless set." },
                    "clientRequestId": request_id,
                }),
                &["fromThreadId", "toThreadId", "text"],
            ),
        ),
        "focus_ui" => (
            "Suggests what the person might look at: a thread, its files (optionally one file), its Source Control panel, or its diff (optionally one file). Every BiBCode window raises a small notice naming you with a Show button; nothing moves until the person clicks it, and the notice goes away after 60 seconds. Returns how many windows were watching. At most 16 suggestions per thread may wait at once.",
            object_schema(
                json!({
                    "threadId": thread,
                    "surface": { "type": "string", "enum": SURFACES },
                    "path": { "type": "string", "description": "For files and diff: a file path relative to the thread's folder." },
                }),
                &["threadId", "surface"],
            ),
        ),
        _ => return None,
    })
}

impl ToolCall<'_> {
    async fn create_chat_panel(&self) -> ToolResult {
        self.only(&[
            "hostThreadId",
            "title",
            "providerInstanceId",
            "model",
            "runtimeMode",
            "purpose",
            "clientRequestId",
        ])?;
        let host_thread_id = self.required("hostThreadId")?;
        let purpose = self.purpose()?;
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
        // A retry with a known clientRequestId replays the stored request, whose commandId and
        // threadId are frozen, so it returns the same panel.
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
            let host = self.panel_host(host_thread_id).await?;
            let project = self
                .control
                .repositories()
                .get_project(host.project_id.clone())
                .await
                .map_err(storage_failure)?
                .filter(|project| project.deleted_at.is_none())
                .ok_or_else(|| {
                    typed_tool_failure("McpProjectNotFoundError", "This thread's project is gone.")
                })?;
            let selection = self
                .default_model_selection(
                    &project,
                    self.string("providerInstanceId")?,
                    self.string("model")?,
                )
                .await?;
            let title = self
                .string("title")?
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map_or_else(
                    || {
                        format!(
                            "Panel — {}",
                            selection["instanceId"].as_str().unwrap_or("agent")
                        )
                    },
                    str::to_owned,
                );
            let command_id = Uuid::new_v4().to_string();
            Ok(vec![json!({
                "commandId": command_id,
                "runtimeMode": runtime_mode.as_str(),
                "payload": {
                    "commandId": command_id,
                    "hostThreadId": host_thread_id,
                    "threadId": Uuid::new_v4().to_string(),
                    "title": title,
                    "purpose": purpose,
                    "threadDefaults": {
                        "modelSelection": selection,
                        "runtimeMode": runtime_mode.as_str(),
                        "interactionMode": "default",
                    },
                },
            })])
        };
        let stored = self
            .commands("create_chat_panel", None, fresh)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| storage_failure("a stored create_chat_panel request has no payload"))?;
        let created = self.invoke(CREATE_PANEL, stored["payload"].clone()).await?;
        Ok(tool_result(
            json!({
                "threadId": created["threadId"],
                "hostThreadId": stored["payload"]["hostThreadId"],
                "title": stored["payload"]["title"],
                "runtimeMode": stored["runtimeMode"],
                "modelSelection": stored["payload"]["threadDefaults"]["modelSelection"],
            }),
            &[],
        ))
    }

    async fn list_chat_panels(&self) -> ToolResult {
        self.only(&["hostThreadId"])?;
        let host_thread_id = self.required("hostThreadId")?;
        self.panel_host(host_thread_id).await?;
        let shell =
            crate::production::orchestration_rpc::shell_snapshot(self.control.engine(), false)
                .await
                .map_err(|error| rpc_failure(&error))?;
        let panels: Vec<Value> = shell["threads"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|thread| thread["kind"] == "panel" && thread["hostThreadId"] == host_thread_id)
            .map(|thread| {
                let mut summary = super::threads::thread_summary(thread);
                summary["requester"] = thread.get("requester").cloned().unwrap_or(Value::Null);
                summary
            })
            .collect();
        let mut content = json!({ "hostThreadId": host_thread_id, "panels": panels });
        fit_list(&mut content, "/panels", Cut::Back, 1);
        Ok(tool_result(content, &[]))
    }

    async fn send_panel_message(&self) -> ToolResult {
        self.only(&[
            "fromThreadId",
            "toThreadId",
            "text",
            "mode",
            "includeLastReply",
            "clientRequestId",
        ])?;
        let from_thread_id = self.required("fromThreadId")?;
        let to_thread_id = self.required("toThreadId")?;
        let text = self.required("text")?;
        if text.chars().count() > MOST_TEXT_CHARS {
            return Err(invalid_argument("text is longer than 120000 characters"));
        }
        let steer = match self.string("mode")? {
            None | Some("queue") => false,
            Some("steer") => true,
            Some(_) => return Err(invalid_argument("mode is queue or steer")),
        };
        let include_last_reply = self.boolean("includeLastReply")?.unwrap_or(false);
        if from_thread_id == to_thread_id {
            return Err(invalid_argument(
                "fromThreadId and toThreadId name the same thread",
            ));
        }
        let fresh = async || {
            let source = self.thread(from_thread_id).await?;
            let target = self.thread(to_thread_id).await?;
            if host_of(&source) != host_of(&target) {
                return Err(typed_tool_failure(
                    "McpNotSameWorktreeError",
                    "These threads are not in one worktree: a panel message goes between a host thread and its panels, or between two panels of one host. Use send_message for any other thread.",
                ));
            }
            self.check_source_is_callers(&source).await?;
            self.check_thread_mode(&target.runtime_mode)?;
            let mut message = text.to_owned();
            if include_last_reply && let Some(quote) = self.last_reply_quote(&source).await? {
                message.push_str(&quote);
            }
            if message.chars().count() > MOST_TEXT_CHARS {
                return Err(invalid_argument(
                    "text with the quoted reply is longer than 120000 characters; shorten text or leave includeLastReply off",
                ));
            }
            let created_at = now_iso();
            let message_id = Uuid::new_v4().to_string();
            let mut commands = vec![json!({
                "type": "thread.turn.start",
                "commandId": Uuid::new_v4().to_string(),
                "threadId": to_thread_id,
                "message": {
                    "messageId": message_id,
                    "role": "user",
                    "text": message,
                    "attachments": [],
                    "sourceThreadId": from_thread_id,
                },
                "runtimeMode": target.runtime_mode,
                "interactionMode": target.interaction_mode,
                "queued": true,
                "createdAt": created_at,
            })];
            if steer {
                commands.push(json!({
                    "type": "thread.turn.steer",
                    "commandId": Uuid::new_v4().to_string(),
                    "threadId": to_thread_id,
                    "messageId": message_id,
                    "createdAt": created_at,
                }));
            }
            Ok(commands)
        };
        let mut commands = self
            .commands("send_panel_message", Some(to_thread_id), fresh)
            .await?
            .into_iter();
        let start = commands
            .next()
            .ok_or_else(|| storage_failure("a stored send_panel_message request has no command"))?;
        self.dispatch(start.clone()).await?;
        let mut result = json!({
            "threadId": to_thread_id,
            "fromThreadId": from_thread_id,
            "messageId": start["message"]["messageId"],
            "quotedReply": start["message"]["text"].as_str().map(str::len) != Some(text.len()),
        });
        if let Some(steer) = commands.next() {
            result["steer"] = match self.dispatch(steer).await {
                Ok(_) => json!({ "steered": true }),
                Err(failure) => json!({
                    "steered": false,
                    "reason": failure["structuredContent"]["error"]["message"],
                }),
            };
        }
        Ok(tool_result(result, &[]))
    }

    async fn focus_ui(&self) -> ToolResult {
        self.only(&["threadId", "surface", "path"])?;
        let thread_id = self.required("threadId")?;
        let surface = self.required("surface")?;
        if !SURFACES.contains(&surface) {
            return Err(invalid_argument(
                "surface is thread, files, sourceControl or diff",
            ));
        }
        let path = self.string("path")?.filter(|path| !path.is_empty());
        if path.is_some() && !PATH_SURFACES.contains(&surface) {
            return Err(invalid_argument("path applies to files and diff only"));
        }
        let target = self.target(thread_id).await?;
        let path = match path {
            None => None,
            Some(path) => {
                let cwd = std::path::PathBuf::from(&target.cwd);
                let paths = vec![path.to_owned()];
                tokio::task::spawn_blocking(move || validate_paths(&cwd, &paths))
                    .await
                    .map_err(storage_failure)??
                    .pop()
            }
        };
        let published = self
            .invoke(
                PUBLISH_INTENT,
                json!({ "threadId": thread_id, "surface": surface, "path": path }),
            )
            .await?;
        Ok(tool_result(
            json!({
                "intentId": published["intentId"],
                "threadId": thread_id,
                "surface": surface,
                "path": path,
                "subscribers": published["subscribers"],
            }),
            &[],
        ))
    }

    /// A panel message is labelled with its source, so the calling agent must own that thread:
    /// it opened it (its `requester`), or it sent the thread's latest user message. Another
    /// agent's panel, or a person's thread, is refused rather than named as the origin.
    async fn check_source_is_callers(&self, source: &ProjectionThread) -> Result<(), Value> {
        let caller = self.principal.principal.session_id.as_str();
        if source
            .requester
            .as_ref()
            .is_some_and(|requester| requester["actor"]["clientId"] == caller)
        {
            return Ok(());
        }
        let thread_id = source.thread_id.clone();
        let last_sender = self
            .control
            .repositories()
            .database()
            .call(move |connection| {
                use rusqlite::OptionalExtension;
                Ok(connection
                    .query_row(
                        "SELECT actor_json FROM projection_thread_messages
                          WHERE thread_id = ? AND role = 'user'
                          ORDER BY created_at DESC, message_id DESC LIMIT 1",
                        [thread_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()?
                    .flatten())
            })
            .await
            .map_err(storage_failure)?;
        if last_sender
            .and_then(|actor| serde_json::from_str::<Value>(&actor).ok())
            .is_some_and(|actor| actor["clientId"] == caller)
        {
            return Ok(());
        }
        Err(typed_tool_failure(
            "McpSourceThreadNotOwnedError",
            "fromThreadId names a thread you did not open and whose latest message you did not send; a panel message can only come from your own thread. Use send_message to write to the thread instead.",
        ))
    }

    /// A thread that may host panels: live, and not itself a panel.
    async fn panel_host(&self, thread_id: &str) -> Result<ProjectionThread, Value> {
        let thread = self.thread(thread_id).await?;
        if thread.kind == "panel" {
            return Err(typed_tool_failure(
                "McpNotAHostThreadError",
                &match &thread.host_thread_id {
                    Some(host) => {
                        format!("This thread is a chat panel of thread {host}; pass that threadId.")
                    }
                    None => "This thread is a chat panel; pass its host thread.".to_owned(),
                },
            ));
        }
        Ok(thread)
    }

    /// The source's last reply, quoted for the end of a panel message, or `None` when it has
    /// none. At most [`MOST_QUOTED_CHARS`] of it; a longer one says where it was cut.
    async fn last_reply_quote(&self, source: &ProjectionThread) -> Result<Option<String>, Value> {
        let thread_id = source.thread_id.clone();
        let reply = self
            .control
            .repositories()
            .database()
            .call(move |connection| {
                use rusqlite::OptionalExtension;
                Ok(connection
                    .query_row(
                        "SELECT substr(text, 1, ?), length(text) FROM projection_thread_messages
                          WHERE thread_id = ? AND role = 'assistant' AND text <> ''
                          ORDER BY created_at DESC, message_id DESC LIMIT 1",
                        rusqlite::params![QUOTED_SQL_CHARS, thread_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .optional()?)
            })
            .await
            .map_err(storage_failure)?;
        Ok(reply.map(|(reply, length)| quote(&source.title, &reply, length)))
    }
}

/// The host of a thread's worktree: a panel's host thread, else the thread itself.
fn host_of(thread: &ProjectionThread) -> &str {
    thread
        .host_thread_id
        .as_deref()
        .unwrap_or(&thread.thread_id)
}

/// `reply` as a Markdown quote naming its thread, after a blank line.
fn quote(title: &str, reply: &str, length: i64) -> String {
    let mut quoted = format!("\n\n> Last reply in “{title}”:\n");
    for line in reply.lines() {
        quoted.push_str("> ");
        quoted.push_str(line);
        quoted.push('\n');
    }
    if usize::try_from(length).unwrap_or(usize::MAX) > MOST_QUOTED_CHARS {
        quoted.push_str(&format!(
            "> … (cut at {MOST_QUOTED_CHARS} of {length} characters)\n"
        ));
    }
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_reply_is_quoted_with_where_it_was_cut() {
        let quoted = quote("Review", "line one\nline two", 20_000);
        assert_eq!(
            quoted,
            "\n\n> Last reply in “Review”:\n> line one\n> line two\n> … (cut at 16000 of 20000 characters)\n"
        );
        assert!(!quote("Review", "short", 5).contains("cut at"));
    }
}
