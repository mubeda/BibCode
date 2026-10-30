//! The preview and device tools. Today only providers BiBCode launched hold them: their
//! credential is the operate grant (see `DeviceTools`), and [`run`] dispatches them for the
//! thread the credential names. Outside agents' twins arrive in slice D, beside these specs.

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    auth::SCOPE_ORCHESTRATION_OPERATE,
    mcp::control::{Family, ProgressSink, ToolCall, ToolFuture, ToolSpec},
    production::connect_mcp::{DeviceTools, PreviewInvoker, PreviewScope},
};

const OPERATE: &str = SCOPE_ORCHESTRATION_OPERATE;

/// A provider's preview tool. They wait on a page in the preview browser, so their duration
/// says little about the server.
const fn preview(name: &'static str) -> ToolSpec {
    ToolSpec::provider(name, OPERATE).runs_long()
}

/// A provider's device tool. They wait on an emulator (`device.open` is long-running too).
const fn device(name: &'static str) -> ToolSpec {
    ToolSpec::provider(name, OPERATE).runs_long()
}

/// Every provider tool, as a provider's `tools/list` shows them (the device tools only while
/// device previews are on).
pub(crate) const TOOLS: &[ToolSpec] = &[
    preview("preview_status").reads(),
    preview("preview_open"),
    preview("preview_navigate"),
    preview("preview_resize"),
    preview("preview_snapshot").reads(),
    preview("preview_click"),
    preview("preview_type"),
    preview("preview_press"),
    preview("preview_scroll"),
    preview("preview_evaluate"),
    preview("preview_wait_for").reads(),
    preview("preview_recording_start"),
    preview("preview_recording_stop"),
    device("device_list").reads(),
    device("device_open"),
    device("device_screenshot").reads(),
    device("device_close"),
];

pub(crate) const FAMILY: Family = Family {
    tools: TOOLS,
    text,
    call,
};

/// Provider descriptors come from [`preview_tool_descriptors`] and the device tools'.
fn text(_: &str) -> Option<(&'static str, Value)> {
    None
}

/// No outside-agent tool yet: the client twins arrive in slice D.
fn call<'a>(_: &'a ToolCall<'a>, _: &'a str, _: Option<(ProgressSink, Value)>) -> ToolFuture<'a> {
    Box::pin(async { Err(tool_failure("McpUnknownToolError", "Unknown tool.")) })
}

/// Runs provider tool `name` for the thread `scope` names. A valid provider MCP credential is
/// the operate grant here, for `preview_*` as for `device_*`: see `DeviceTools`.
pub(crate) async fn run(
    scope: PreviewScope,
    name: &str,
    arguments: Value,
    cancellation: CancellationToken,
    invoker: &PreviewInvoker,
    devices: Option<&DeviceTools>,
) -> Value {
    if let Some(operation) = name.strip_prefix("device_") {
        return match devices {
            Some(devices) => {
                devices
                    .call(&scope, operation, arguments, cancellation)
                    .await
            }
            None => tool_failure("McpUnknownToolError", "Unknown tool."),
        };
    }
    let Some(operation) = name.strip_prefix("preview_") else {
        return tool_failure("McpUnknownToolError", "Unknown preview tool.");
    };
    if !TOOL_OPERATIONS.contains(&operation) {
        return tool_failure("McpUnknownToolError", "Unknown preview tool.");
    }
    let mut arguments = arguments;
    let tab_id = arguments
        .get("tabId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(object) = arguments.as_object_mut() {
        object.remove("tabId");
    }
    match invoker
        .invoke(
            scope,
            operation_wire_name(operation).into(),
            arguments,
            tab_id,
            cancellation,
        )
        .await
    {
        Ok(value) if operation == "snapshot" => snapshot_tool_result(value),
        Ok(value) => json!({
            "isError":false,
            "structuredContent":value,
            "content":[{"type":"text","text":value.to_string()}]
        }),
        Err(message) => tool_failure("PreviewAutomationExecutionError", &message),
    }
}

pub(crate) fn tool_failure(tag: &str, message: &str) -> Value {
    json!({
        "isError":true,
        "structuredContent":{"error":{"_tag":tag,"message":message}},
        "content":[{"type":"text","text":message}]
    })
}

pub(crate) fn snapshot_tool_result(mut value: Value) -> Value {
    let screenshot = value
        .as_object_mut()
        .and_then(|object| object.remove("screenshot"));
    let Some(screenshot) = screenshot else {
        return tool_failure(
            "PreviewAutomationMalformedResponseError",
            "Preview snapshot response did not include a screenshot.",
        );
    };
    let data = screenshot
        .get("data")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mime_type = screenshot
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    let metadata = json!({
        "mimeType": mime_type,
        "width": screenshot.get("width").cloned().unwrap_or(Value::Null),
        "height": screenshot.get("height").cloned().unwrap_or(Value::Null)
    });
    if let Some(object) = value.as_object_mut() {
        object.insert("screenshot".into(), metadata);
    }
    json!({
        "isError":false,
        "structuredContent":value,
        "content":[
            {"type":"text","text":value.to_string()},
            {"type":"image","data":data,"mimeType":mime_type}
        ]
    })
}

pub(crate) const TOOL_OPERATIONS: &[&str] = &[
    "status",
    "open",
    "navigate",
    "resize",
    "snapshot",
    "click",
    "type",
    "press",
    "scroll",
    "evaluate",
    "wait_for",
    "recording_start",
    "recording_stop",
];

pub(crate) fn operation_wire_name(operation: &str) -> &str {
    match operation {
        "wait_for" => "waitFor",
        "recording_start" => "recordingStart",
        "recording_stop" => "recordingStop",
        other => other,
    }
}

pub(crate) fn preview_tool_descriptors() -> Vec<Value> {
    TOOL_OPERATIONS
        .iter()
        .map(|operation| {
            let name = format!("preview_{operation}");
            let read_only = matches!(*operation, "status" | "snapshot" | "wait_for");
            json!({
                "name":name,
                "description":format!("Control the collaborative browser preview ({operation})."),
                "inputSchema":{"type":"object","additionalProperties":true},
                "annotations":{
                    "title":format!("Preview {operation}"),
                    "readOnlyHint":read_only,
                    "destructiveHint":!read_only,
                    "idempotentHint":read_only,
                    "openWorldHint":true
                }
            })
        })
        .collect()
}
