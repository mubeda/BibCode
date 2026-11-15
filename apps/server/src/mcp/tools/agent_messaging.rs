//! The agent messaging tools a provider-hosted agent calls. They have no
//! outside-agent twin. The caller is the thread of the provider credential (`PreviewScope`),
//! never an argument, and every refusal is content free.

use serde_json::{Value, json};

use crate::{
    agent_messaging::{AgentCaller, AgentMessaging, AgentMessagingError},
    agent_messaging::{MessageReceipt, ReplyRequest, SendRequest, StatusReport},
    auth::{SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ},
    mcp::{
        control::{Family, ProgressSink, ToolCall, ToolFuture, ToolSpec, object_schema},
        protocol::{Cut, tool_descriptor, tool_result, typed_tool_failure},
    },
    production::connect_mcp::PreviewScope,
};

pub(crate) const TOOLS: &[ToolSpec] = &[
    ToolSpec::provider("agents_list", SCOPE_ORCHESTRATION_READ).reads(),
    ToolSpec::provider("agent_message_send", SCOPE_ORCHESTRATION_OPERATE),
    ToolSpec::provider("agent_message_reply", SCOPE_ORCHESTRATION_OPERATE),
    ToolSpec::provider("agent_message_status", SCOPE_ORCHESTRATION_OPERATE).reads(),
    ToolSpec::provider("agent_message_cancel", SCOPE_ORCHESTRATION_OPERATE),
];

pub(crate) const FAMILY: Family = Family {
    tools: TOOLS,
    text,
    call,
};

/// No client tool exists in this family.
fn text(_name: &str) -> Option<(&'static str, Value)> {
    None
}

fn call<'a>(
    _call: &'a ToolCall<'a>,
    _name: &'a str,
    _progress: Option<(ProgressSink, Value)>,
) -> ToolFuture<'a> {
    Box::pin(async { Err(typed_tool_failure("McpUnknownToolError", "Unknown tool.")) })
}

const AGENTS_LIST: &str = "List the other agents of your project that you can message, chat agents and AI Terminals: each with its address (thread:<id> or terminal:<threadId>/<terminalId>), title, provider, kind (chat or terminal), activity status (working, waiting, blocked, ready, done, error, stopped, unavailable) and canReceive. Your own address is not listed. Takes no arguments.";

const AGENT_MESSAGE_SEND: &str = "Send a message to another agent of your project (an address from agents_list). It is delivered in an envelope that names you as the sender, after the recipient's running turn ends. Returns at once with messageId, conversationId, status accepted and hop; check progress with agent_message_status. Text of 1 to 16000 characters; clientRequestId is optional.";

const AGENT_MESSAGE_REPLY: &str = "Reply to an agent message you received (inReplyTo is its message-id from the envelope). The reply goes to its sender in the same conversation and returns at once with messageId, conversationId, status and hop. Text of 1 to 16000 characters; clientRequestId is optional.";

const AGENT_MESSAGE_STATUS: &str = "Read the status of a message you sent: accepted, queued, held, delivered, consumed, completed, cancelled or failed, with reason for held and failed, updatedAt, and replyMessageId once the recipient replied. It never waits.";

const AGENT_MESSAGE_CANCEL: &str = "Cancel a message you sent that is still queued or held, so it is never delivered. Returns status cancelled, also when it was already cancelled. A message already handed to its recipient cannot be cancelled. Works while agent messaging is off.";

/// The descriptors a provider's `tools/list` adds for this family.
pub(crate) fn tool_descriptors() -> Vec<Value> {
    vec![
        tool_descriptor(
            "agents_list",
            AGENTS_LIST,
            object_schema(json!({}), &[]),
            json!({
                "title": "List agents",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false,
            }),
        ),
        tool_descriptor(
            "agent_message_send",
            AGENT_MESSAGE_SEND,
            object_schema(
                json!({
                    "to": { "type": "string", "description": "thread:<id> or terminal:<threadId>/<terminalId>" },
                    "text": { "type": "string", "minLength": 1, "maxLength": 16000 },
                    "clientRequestId": { "type": "string", "minLength": 1 },
                }),
                &["to", "text"],
            ),
            json!({
                "title": "Message an agent",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false,
            }),
        ),
        tool_descriptor(
            "agent_message_reply",
            AGENT_MESSAGE_REPLY,
            object_schema(
                json!({
                    "inReplyTo": { "type": "string", "minLength": 1 },
                    "text": { "type": "string", "minLength": 1, "maxLength": 16000 },
                    "clientRequestId": { "type": "string", "minLength": 1 },
                }),
                &["inReplyTo", "text"],
            ),
            json!({
                "title": "Reply to an agent",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false,
            }),
        ),
        tool_descriptor(
            "agent_message_status",
            AGENT_MESSAGE_STATUS,
            object_schema(
                json!({ "messageId": { "type": "string", "minLength": 1 } }),
                &["messageId"],
            ),
            json!({
                "title": "Agent message status",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false,
            }),
        ),
        tool_descriptor(
            "agent_message_cancel",
            AGENT_MESSAGE_CANCEL,
            object_schema(
                json!({ "messageId": { "type": "string", "minLength": 1 } }),
                &["messageId"],
            ),
            json!({
                "title": "Cancel an agent message",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false,
            }),
        ),
    ]
}

/// An object with no field outside `allowed`: a sender or any other unknown field is refused.
/// The refusal names no value.
fn strict_object<'a>(
    tool: &str,
    arguments: &'a Value,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, AgentMessagingError> {
    arguments
        .as_object()
        .filter(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
        .ok_or_else(|| {
            AgentMessagingError::InvalidArgument(format!(
                "{tool} takes only {}.",
                allowed.join(", ")
            ))
        })
}

fn string_field(
    object: &serde_json::Map<String, Value>,
    name: &str,
    required: bool,
) -> Result<Option<String>, AgentMessagingError> {
    match object.get(name) {
        None if !required => Ok(None),
        Some(Value::String(value)) if required || !value.trim().is_empty() => {
            Ok(Some(value.clone()))
        }
        _ => Err(AgentMessagingError::InvalidArgument(format!(
            "{name} must be a non-empty string."
        ))),
    }
}

fn receipt_value(receipt: &MessageReceipt) -> Value {
    json!({
        "messageId": receipt.message_id,
        "conversationId": receipt.conversation_id,
        "status": receipt.status.as_str(),
        "hop": receipt.hop,
    })
}

fn status_value(report: &StatusReport) -> Value {
    let mut result = json!({
        "status": report.status.as_str(),
        "updatedAt": report.updated_at,
    });
    if let Some(reason) = report.reason {
        result["reason"] = json!(reason.as_str());
    }
    if let Some(reply) = &report.reply_message_id {
        result["replyMessageId"] = json!(reply);
    }
    result
}

/// A send or reply request from `arguments`, or the refusal, reported for `caller`.
fn outgoing(
    messaging: &AgentMessaging,
    caller: &AgentCaller,
    tool: &'static str,
    arguments: &Value,
    target: &str,
) -> Result<(String, String, Option<String>), AgentMessagingError> {
    let request = (|| {
        if !messaging.is_enabled() {
            return Err(AgentMessagingError::Disabled);
        }
        let object = strict_object(tool, arguments, &[target, "text", "clientRequestId"])?;
        Ok((
            string_field(object, target, true)?.unwrap_or_default(),
            string_field(object, "text", true)?.unwrap_or_default(),
            string_field(object, "clientRequestId", false)?,
        ))
    })();
    request.map_err(|error| messaging.refused(tool, caller, error))
}

/// Runs messaging operation `tool` as `caller` and returns its result, unwrapped: the provider
/// tools and `bibcode agent` share it, so both obey every rule the same way.
pub(crate) async fn call_as(
    messaging: &AgentMessaging,
    caller: &AgentCaller,
    tool: &str,
    arguments: &Value,
) -> Result<Value, AgentMessagingError> {
    let message_id = |tool: &str| {
        let object = strict_object(tool, arguments, &["messageId"])?;
        Ok::<_, AgentMessagingError>(string_field(object, "messageId", true)?.unwrap_or_default())
    };
    match tool {
        "agents_list" => {
            if !messaging.is_enabled() {
                return Err(AgentMessagingError::Disabled);
            }
            if arguments
                .as_object()
                .is_none_or(|object| !object.is_empty())
            {
                return Err(AgentMessagingError::InvalidArgument(
                    "agents_list takes no arguments.".to_owned(),
                ));
            }
            let agents = messaging.agents_for(caller).await?;
            Ok(json!({ "agents": agents }))
        }
        "agent_message_send" => {
            let (to, text, client_request_id) =
                outgoing(messaging, caller, "agent_message_send", arguments, "to")?;
            let request = SendRequest {
                to,
                text,
                client_request_id,
            };
            Ok(receipt_value(&messaging.send_as(caller, request).await?))
        }
        "agent_message_reply" => {
            let (in_reply_to, text, client_request_id) = outgoing(
                messaging,
                caller,
                "agent_message_reply",
                arguments,
                "inReplyTo",
            )?;
            let request = ReplyRequest {
                in_reply_to,
                text,
                client_request_id,
            };
            Ok(receipt_value(&messaging.reply_as(caller, request).await?))
        }
        "agent_message_status" => {
            if !messaging.is_enabled() {
                return Err(AgentMessagingError::Disabled);
            }
            let message_id = message_id("agent_message_status")?;
            Ok(status_value(
                &messaging.status_as(caller, &message_id).await?,
            ))
        }
        // Cancel works while messaging is off, so a sender can still take a message back.
        "agent_message_cancel" => {
            let message_id = message_id("agent_message_cancel")?;
            let status = messaging.cancel_as(caller, &message_id).await?;
            Ok(json!({ "status": status.as_str() }))
        }
        _ => Err(AgentMessagingError::InvalidArgument(
            "Unknown operation.".to_owned(),
        )),
    }
}

/// Runs provider tool `name` for the thread of `scope`.
pub(crate) async fn run(
    scope: PreviewScope,
    name: &str,
    arguments: Value,
    messaging: Option<&AgentMessaging>,
) -> Value {
    let Some(messaging) = messaging else {
        return failure(&AgentMessagingError::Disabled);
    };
    if !TOOLS.iter().any(|spec| spec.name == name) {
        return typed_tool_failure("McpUnknownToolError", "Unknown tool.");
    }
    let caller = AgentCaller::Thread(scope.thread_id);
    match call_as(messaging, &caller, name, &arguments).await {
        Ok(result) if name == "agents_list" => tool_result(result, &[("/agents", Cut::Back)]),
        Ok(result) => tool_result(result, &[]),
        Err(error) => failure(&error),
    }
}

fn failure(error: &AgentMessagingError) -> Value {
    typed_tool_failure(error.tag(), &error.message())
}
