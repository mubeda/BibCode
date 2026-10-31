//! The preview and device tools. Providers BiBCode launched hold them through their
//! credential, which is the operate grant (see `DeviceTools`) and names their thread. Outside
//! agents get client twins of the same names (slice D), which take the thread as `threadId`
//! and are checked per call. Both kinds reach [`run`], so they share one implementation.

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    auth::SCOPE_ORCHESTRATION_OPERATE,
    device::DeviceOpError,
    mcp::{
        control::{
            Family, McpAccess, ProgressSink, ToolCall, ToolFuture, ToolResult, ToolSpec,
            object_schema,
        },
        protocol::typed_tool_failure,
    },
    production::connect_mcp::{DeviceTools, PreviewInvoker, PreviewScope, device_tool_descriptors},
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

/// An outside agent's twin of a provider tool, in the Workspace set. It waits on a page or an
/// emulator, so it is long-running, but it never holds a wait slot (C1).
const fn twin(name: &'static str) -> ToolSpec {
    ToolSpec::client(name, OPERATE, &[]).runs_long()
}

/// Every provider tool, as a provider's `tools/list` shows them (the device tools only while
/// device previews are on), then the outside agents' twins.
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
    twin("preview_status").reads(),
    twin("preview_open"),
    twin("preview_navigate"),
    twin("preview_resize"),
    twin("preview_snapshot").reads(),
    twin("preview_click"),
    twin("preview_type"),
    twin("preview_press"),
    twin("preview_scroll"),
    // It runs script in the user's preview page.
    twin("preview_evaluate").destroys(),
    twin("preview_wait_for"),
    twin("preview_recording_start"),
    twin("preview_recording_stop"),
    twin("device_list").reads(),
    twin("device_open"),
    twin("device_screenshot").reads(),
    twin("device_close").destroys(),
];

/// What the client twins run on: this environment's id, the preview host and the devices.
/// The Connect service that owns them attaches them to `McpControl`.
#[derive(Clone)]
pub(crate) struct PreviewServices {
    pub(crate) environment_id: String,
    pub(crate) invoker: PreviewInvoker,
    pub(crate) devices: Option<DeviceTools>,
}

pub(crate) const FAMILY: Family = Family {
    tools: TOOLS,
    text,
    call,
};

const NO_HOST_TAG: &str = "PreviewAutomationNoAvailableHostError";
const OPEN_BIBCODE: &str =
    "Open BiBCode (the desktop app or the web UI) on this environment, then try again.";

/// The description of a client `preview_*` twin.
macro_rules! preview_text {
    ($lead:literal) => {
        concat!(
            $lead,
            " threadId names the thread you act for. Each MCP connection gets its own preview tab per thread; pass tabId to act on another tab. The preview runs in an open BiBCode window for this environment: with none open the call fails with PreviewAutomationNoAvailableHostError. Open BiBCode (the desktop app or the web UI), then try again."
        )
    };
}

/// The description of a client `device_*` twin.
macro_rules! device_text {
    ($lead:literal) => {
        concat!(
            $lead,
            " threadId names the thread you act for; a chat panel's thread acts for its host thread. Android emulators and iOS simulators (macOS servers) run on the BiBCode server, not on this machine, and only while device previews are on in Settings."
        )
    };
}

/// Each client twin's description and input schema. A preview tool's other arguments go to
/// the preview host as they are, as a provider's do; a device tool takes the provider tool's
/// arguments.
fn text(name: &str) -> Option<(&'static str, Value)> {
    let description = match name {
        "preview_status" => preview_text!(
            "Report the collaborative browser preview's state: whether it is available and visible, its tab, URL, title and viewport."
        ),
        "preview_open" => preview_text!(
            "Open the collaborative browser preview, optionally at url (show, reuseExistingTab)."
        ),
        "preview_navigate" => preview_text!(
            "Navigate the preview tab to url, or to target ({kind: \"environment-port\", port, protocol, path}), and wait for readiness."
        ),
        "preview_resize" => preview_text!(
            "Resize the preview viewport: mode fill, freeform (width, height) or preset (preset, orientation)."
        ),
        "preview_snapshot" => preview_text!(
            "Snapshot the preview tab: its visible elements and a screenshot as image content."
        ),
        "preview_click" => {
            preview_text!("Click in the preview page, at a locator or selector, or at x and y.")
        }
        "preview_type" => preview_text!(
            "Type text into the preview page, into a locator or selector (clear replaces its value)."
        ),
        "preview_press" => {
            preview_text!("Press key in the preview page, with optional modifiers.")
        }
        "preview_scroll" => preview_text!(
            "Scroll the preview page by deltaX and deltaY, or a locator or selector into view."
        ),
        "preview_evaluate" => preview_text!(
            "Run the JavaScript expression in the preview page and return its value (awaitPromise, returnByValue). It runs as the page, in the user's preview."
        ),
        "preview_wait_for" => preview_text!(
            "Wait until the preview page shows a locator or selector, text, or a URL containing urlIncludes."
        ),
        "preview_recording_start" => preview_text!("Start recording the preview tab."),
        "preview_recording_stop" => {
            preview_text!("Stop recording the preview tab and return the recording.")
        }
        "device_list" => device_text!(
            "List the devices: per platform, whether it can run devices and the images it can start, and the devices, each with thisThread saying whether the thread started it."
        ),
        "device_open" => device_text!(
            "Start a device and wait until it has booted. Up to four run at once on this server, one per image; opening an image the thread already runs returns that device, and one another thread runs is refused. platform defaults to android. Omit imageId when the platform has exactly one image; device_list shows the ids."
        ),
        "device_screenshot" => device_text!(
            "Take a screenshot of a running device: a PNG at most 1080 px wide, or a full-size JPEG for a view-only iOS simulator. Omit deviceId to take the thread's device when it runs one, or the only running device."
        ),
        "device_close" => device_text!(
            "Stop a running device. A device another thread started is refused; ask the user to stop it."
        ),
        _ => return None,
    };
    let thread = json!({
        "type": "string",
        "description": "The thread you act for; list_projects_and_threads lists them.",
    });
    let input = if name.starts_with("device_") {
        // The provider tool's arguments, so the two stay the same.
        let mut input = device_tool_descriptors()
            .into_iter()
            .find(|tool| tool["name"] == name)?["inputSchema"]
            .take();
        input["properties"]["threadId"] = thread;
        let required = input["required"].as_array().cloned().unwrap_or_default();
        input["required"] = std::iter::once(json!("threadId")).chain(required).collect();
        input
    } else {
        let mut input = object_schema(
            json!({
                "threadId": thread,
                "tabId": {
                    "type": "string",
                    "description": "A tab other than this connection's own.",
                },
            }),
            &["threadId"],
        );
        input["additionalProperties"] = json!(true);
        input
    };
    Some((description, input))
}

fn call<'a>(
    call: &'a ToolCall<'a>,
    name: &'a str,
    _: Option<(ProgressSink, Value)>,
) -> ToolFuture<'a> {
    Box::pin(twin_call(call, name))
}

/// Runs client twin `name` for the thread `threadId` names, as the provider tool runs for a
/// provider's thread: with the agent's own tab assignment, and the thread's devices.
async fn twin_call(call: &ToolCall<'_>, name: &str) -> ToolResult {
    // Every twin acts in the user's preview or on a device, so the read-only ones need an
    // operate level too.
    if call.control.effective_ceiling(call.principal) == McpAccess::ReadOnly {
        return Err(typed_tool_failure(
            "McpAccessCeilingError",
            "This MCP connection is read-only (Settings → Agents → Agent integrations → Agents may).",
        ));
    }
    let thread_id = call.required("threadId")?;
    let thread = call.thread(thread_id).await?;
    let device = name.starts_with("device_");
    let services = call
        .control
        .previews()
        .filter(|services| !device || services.devices.is_some());
    let Some(services) = services else {
        return Err(if device {
            let error = DeviceOpError::Disabled;
            typed_tool_failure(
                error.to_rpc_error()["_tag"]
                    .as_str()
                    .unwrap_or("DeviceError"),
                &error.to_string(),
            )
        } else {
            typed_tool_failure(
                NO_HOST_TAG,
                &format!("No preview automation host is available. {OPEN_BIBCODE}"),
            )
        });
    };
    let mut arguments = call.arguments.clone();
    arguments.remove("threadId");
    let scope = PreviewScope {
        environment_id: services.environment_id.clone(),
        thread_id: thread_id.to_owned(),
        owner_thread_id: thread
            .host_thread_id
            .unwrap_or_else(|| thread_id.to_owned()),
        provider_session_id: format!("mcp:{}:{thread_id}", call.principal.principal.session_id),
        provider_instance_id: "mcp-client".to_owned(),
    };
    let result = run(
        scope,
        name,
        Value::Object(arguments),
        call.cancellation.clone(),
        &services.invoker,
        services.devices.as_ref(),
    )
    .await;
    if result["isError"] == true {
        Err(host_failure(result))
    } else {
        Ok(result)
    }
}

/// A preview host's failure keeps its own tag, which the provider result folds into its
/// message (`"<tag>: <message>"`), and a missing host says how to get one.
fn host_failure(result: Value) -> Value {
    let error = &result["structuredContent"]["error"];
    if error["_tag"] != "PreviewAutomationExecutionError" {
        return result;
    }
    let Some((tag, message)) = error["message"]
        .as_str()
        .and_then(|text| text.split_once(": "))
    else {
        return result;
    };
    if !(tag.starts_with("PreviewAutomation")
        && tag.ends_with("Error")
        && tag.chars().all(|c| c.is_ascii_alphanumeric()))
    {
        return result;
    }
    if tag == NO_HOST_TAG {
        typed_tool_failure(tag, &format!("{message} {OPEN_BIBCODE}"))
    } else {
        typed_tool_failure(tag, message)
    }
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
