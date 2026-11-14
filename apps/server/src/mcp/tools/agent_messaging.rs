//! The agent messaging tools a provider-hosted agent calls: `agents_list` so far. They have no
//! outside-agent twin. The caller is the thread of the provider credential (`PreviewScope`),
//! never an argument, and every refusal is content free.

use serde_json::{Value, json};

use crate::{
    agent_messaging::{AgentMessaging, AgentMessagingError},
    auth::SCOPE_ORCHESTRATION_READ,
    mcp::{
        control::{Family, ProgressSink, ToolCall, ToolFuture, ToolSpec, object_schema},
        protocol::{Cut, tool_descriptor, tool_result, typed_tool_failure},
    },
    production::connect_mcp::PreviewScope,
};

pub(crate) const TOOLS: &[ToolSpec] =
    &[ToolSpec::provider("agents_list", SCOPE_ORCHESTRATION_READ).reads()];

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

/// The descriptors a provider's `tools/list` adds for this family.
pub(crate) fn tool_descriptors() -> Vec<Value> {
    vec![tool_descriptor(
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
    )]
}

fn failure(error: &AgentMessagingError) -> Value {
    typed_tool_failure(error.tag(), &error.message())
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
        _ => typed_tool_failure("McpUnknownToolError", "Unknown tool."),
    }
}
