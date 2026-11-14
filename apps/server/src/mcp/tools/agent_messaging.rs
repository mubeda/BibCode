//! The agent messaging tools a provider-hosted agent calls. They have no
//! outside-agent twin. The caller is the thread of the provider credential (`PreviewScope`),
//! never an argument, and every refusal is content free.

use serde_json::{Value, json};

use crate::{
    agent_messaging::{AgentMessaging, AgentMessagingError},
    agent_messaging::{MessageReceipt, SendRequest},
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

const AGENTS_LIST: &str = "List the other agents of your project that you can message: each with its address (thread:<id>), title, provider, kind (chat or terminal), activity status (working, waiting, ready, error, stopped) and canReceive. Your own thread is not listed. Takes no arguments.";

const AGENT_MESSAGE_SEND: &str = "Send a message to another agent of your project (an address from agents_list). It is delivered in an envelope that names you as the sender, after the recipient's running turn ends. Returns at once with messageId, conversationId, status accepted and hop; check progress with agent_message_status. Text of 1 to 16000 characters; clientRequestId is optional.";

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
                    "to": { "type": "string", "description": "thread:<id>" },
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
    ]
}

fn failure(error: &AgentMessagingError) -> Value {
    typed_tool_failure(error.tag(), &error.message())
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

fn receipt_result(receipt: &MessageReceipt) -> Value {
    tool_result(
        json!({
            "messageId": receipt.message_id,
            "conversationId": receipt.conversation_id,
            "status": receipt.status.as_str(),
            "hop": receipt.hop,
        }),
        &[],
    )
}

async fn send(
    scope: &PreviewScope,
    arguments: &Value,
    messaging: &AgentMessaging,
) -> Result<MessageReceipt, AgentMessagingError> {
    let object = strict_object(
        "agent_message_send",
        arguments,
        &["to", "text", "clientRequestId"],
    )?;
    let request = SendRequest {
        to: string_field(object, "to", true)?.unwrap_or_default(),
        text: string_field(object, "text", true)?.unwrap_or_default(),
        client_request_id: string_field(object, "clientRequestId", false)?,
    };
    messaging.send(&scope.thread_id, request).await
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
    match name {
        "agents_list" => {
            if !messaging.is_enabled() {
                return failure(&AgentMessagingError::Disabled);
            }
            if arguments
                .as_object()
                .is_none_or(|object| !object.is_empty())
            {
                return failure(&AgentMessagingError::InvalidArgument(
                    "agents_list takes no arguments.".to_owned(),
                ));
            }
            match messaging.agents(&scope.thread_id).await {
                Ok(agents) => tool_result(json!({ "agents": agents }), &[("/agents", Cut::Back)]),
                Err(error) => failure(&error),
            }
        }
        "agent_message_send" => {
            if !messaging.is_enabled() {
                return failure(&AgentMessagingError::Disabled);
            }
            match send(&scope, &arguments, messaging).await {
                Ok(receipt) => receipt_result(&receipt),
                Err(error) => failure(&error),
            }
        }
        _ => typed_tool_failure("McpUnknownToolError", "Unknown tool."),
    }
}
