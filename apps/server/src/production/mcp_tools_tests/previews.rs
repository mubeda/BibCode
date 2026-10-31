//! The preview and device twins for outside agents (#139 slice D): the client-kind
//! `preview_*` and `device_*` tools, which run through the providers' dispatch for the thread
//! the call names. The preview host is a real `PreviewAutomationBroker` (with a fake UI host
//! where one is needed) or a recording invoker; the devices are the fake SDK's emulators.

use std::sync::Mutex;

use super::*;
use crate::{
    mcp::{
        control::McpCapabilities,
        preview_automation::{
            PreviewAutomationBroker, PreviewAutomationHost, PreviewAutomationInvokeInput,
            PreviewAutomationOperation, PreviewAutomationRequest, PreviewAutomationResponse,
            PreviewAutomationStreamEvent,
        },
        tools::previews::PreviewServices,
    },
    production::connect_mcp::{PreviewInvoker, PreviewScope},
};

const ENVIRONMENT: &str = "environment";
const THREAD: &str = "preview-thread";
const OTHER: &str = "other-thread";
const PANEL: &str = "panel-thread";

const PREVIEWS: &[&str] = &[
    "preview_status",
    "preview_open",
    "preview_navigate",
    "preview_resize",
    "preview_snapshot",
    "preview_click",
    "preview_type",
    "preview_press",
    "preview_scroll",
    "preview_evaluate",
    "preview_wait_for",
    "preview_recording_start",
    "preview_recording_stop",
];
const DEVICES: &[&str] = &[
    "device_list",
    "device_open",
    "device_screenshot",
    "device_close",
];

async fn create_thread(harness: &Harness, thread_id: &str, host: Option<&str>) {
    let mut create = json!({
        "type": "thread.create", "commandId": format!("create-{thread_id}"),
        "threadId": thread_id, "projectId": "p1", "title": thread_id,
        "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
        "runtimeMode": "approval-required", "interactionMode": "default", "branch": null,
        "worktreePath": null, "createdAt": CREATED_AT,
    });
    if let Some(host) = host {
        create["kind"] = json!("panel");
        create["hostThreadId"] = json!(host);
    }
    harness
        .engine
        .dispatch(command(create))
        .await
        .expect("thread created");
}

/// A harness with the threads `THREAD` and `OTHER`, and `PANEL`, a chat panel on `THREAD`.
async fn harness() -> Harness {
    let harness = Harness::new().await;
    create_thread(&harness, THREAD, None).await;
    create_thread(&harness, OTHER, None).await;
    create_thread(&harness, PANEL, Some(THREAD)).await;
    harness
}

/// The invoker production builds over the broker (`lifecycle.rs`).
fn broker_invoker(broker: PreviewAutomationBroker) -> PreviewInvoker {
    PreviewInvoker::new(move |scope, operation, input, tab_id, _cancellation| {
        let broker = broker.clone();
        async move {
            let operation = PreviewAutomationOperation::from_wire(&operation)
                .ok_or_else(|| format!("unsupported preview operation: {operation}"))?;
            broker
                .invoke(PreviewAutomationInvokeInput {
                    environment_id: scope.environment_id,
                    thread_id: scope.thread_id,
                    provider_session_id: scope.provider_session_id,
                    provider_instance_id: scope.provider_instance_id,
                    operation,
                    input,
                    tab_id,
                    timeout_ms: None,
                })
                .await
                .map_err(|error| format!("{}: {}", error.tag(), error.message()))
        }
    })
}

type Recorded = Arc<Mutex<Vec<(PreviewScope, String, Value, Option<String>)>>>;

/// An invoker that records each call and answers `{ "ok": true }`.
fn recording_invoker() -> (PreviewInvoker, Recorded) {
    let calls: Recorded = Arc::default();
    let seen = calls.clone();
    let invoker = PreviewInvoker::new(move |scope, operation, input, tab_id, _cancellation| {
        seen.lock().unwrap().push((scope, operation, input, tab_id));
        async { Ok(json!({ "ok": true })) }
    });
    (invoker, calls)
}

fn services(invoker: PreviewInvoker) -> PreviewServices {
    PreviewServices {
        environment_id: ENVIRONMENT.into(),
        invoker,
        devices: None,
    }
}

#[tokio::test]
async fn outside_agents_list_every_twin_with_a_required_thread_and_the_designed_hints() {
    let harness = harness().await;
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
    let listed = harness.control.tools(&agent);
    let tools = listed.as_array().unwrap();
    for name in PREVIEWS.iter().chain(DEVICES) {
        let tool = tools
            .iter()
            .find(|tool| tool["name"] == *name)
            .unwrap_or_else(|| panic!("{name} is listed"));
        let required = tool["inputSchema"]["required"].as_array().unwrap();
        assert!(required.contains(&json!("threadId")), "{name}");
        let read_only = matches!(
            *name,
            "device_list" | "device_screenshot" | "preview_status" | "preview_snapshot"
        );
        let destructive = matches!(*name, "preview_evaluate" | "device_close");
        let hints = &tool["annotations"];
        assert_eq!(hints["readOnlyHint"], read_only, "{name}");
        assert_eq!(hints["destructiveHint"], destructive, "{name}");
        assert_eq!(hints["idempotentHint"], read_only, "{name}");
        assert_eq!(hints["openWorldHint"], false, "{name}");
        let spec = crate::mcp::control::tool_spec(crate::mcp::control::PrincipalKind::Client, name)
            .unwrap();
        // Long-running by design, and never a wait slot (C1).
        assert!(spec.long_running && !spec.holds_wait_slot, "{name}");
        assert_eq!(
            spec.scope,
            crate::auth::SCOPE_ORCHESTRATION_OPERATE,
            "{name}"
        );
        assert_eq!(spec.audited, destructive, "{name}");
    }
    let open = tools
        .iter()
        .find(|tool| tool["name"] == "device_open")
        .unwrap();
    assert_eq!(
        open["inputSchema"]["properties"]["platform"]["enum"],
        json!(["android", "ios"])
    );
    let preview = tools
        .iter()
        .find(|tool| tool["name"] == "preview_open")
        .unwrap();
    assert!(
        preview["description"]
            .as_str()
            .unwrap()
            .contains("Open BiBCode"),
        "{preview}"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn a_twin_needs_a_thread_that_exists() {
    let harness = harness().await;
    let (invoker, calls) = recording_invoker();
    harness.control.attach_previews(services(invoker));
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
    let missing = harness.call(&agent, "preview_status", json!({})).await;
    assert_eq!(error_tag(&missing), "McpInvalidArgumentError");
    let unknown = harness
        .call(&agent, "device_list", json!({ "threadId": "nope" }))
        .await;
    assert_eq!(error_tag(&unknown), "McpThreadNotFoundError");
    assert!(calls.lock().unwrap().is_empty());
    harness.shutdown().await;
}

#[tokio::test]
async fn the_preview_scope_names_the_agent_the_thread_and_its_host() {
    let harness = harness().await;
    let (invoker, calls) = recording_invoker();
    harness.control.attach_previews(services(invoker));
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
    let result = harness
        .call(
            &agent,
            "preview_navigate",
            json!({ "threadId": PANEL, "url": "http://localhost:5173", "tabId": "tab-9" }),
        )
        .await;
    assert_eq!(structured(&result)["ok"], true);
    let calls = calls.lock().unwrap().clone();
    let (scope, operation, input, tab_id) = &calls[0];
    assert_eq!(
        scope,
        &PreviewScope {
            environment_id: ENVIRONMENT.into(),
            thread_id: PANEL.into(),
            owner_thread_id: THREAD.into(),
            provider_session_id: format!("mcp:{}:{PANEL}", agent.principal.session_id),
            provider_instance_id: "mcp-client".into(),
        }
    );
    assert_eq!(operation, "navigate");
    // `threadId` and `tabId` are the tool's own; the page sees only its arguments.
    assert_eq!(input, &json!({ "url": "http://localhost:5173" }));
    assert_eq!(tab_id.as_deref(), Some("tab-9"));
    harness.shutdown().await;
}

/// An invoker that answers each operation with its entry in `answers`.
fn answering_invoker(answers: Value) -> PreviewInvoker {
    PreviewInvoker::new(move |_scope, operation, _input, _tab_id, _cancellation| {
        let answer = answers[operation.as_str()].clone();
        async move { Ok(answer) }
    })
}

/// A twin's text follows the client result policy: a page result past 80,000 characters is
/// replaced by the standard truncation note, and hidden Unicode in the text is escaped while
/// `structuredContent` keeps it raw. The provider tool's result is untouched.
#[tokio::test]
async fn twin_text_is_capped_and_escapes_hidden_unicode_like_every_client_result() {
    let harness = harness().await;
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;

    let large = json!({ "result": "x".repeat(200_000) });
    let hidden = json!({ "title": "safe\u{202e}txt.exe", "tag": "a\u{e0041}b" });
    let answers = json!({ "evaluate": large, "status": hidden });
    harness
        .control
        .attach_previews(services(answering_invoker(answers.clone())));
    let capped = harness
        .call(
            &agent,
            "preview_evaluate",
            json!({ "threadId": THREAD, "expression": "document.body.innerHTML" }),
        )
        .await;
    let text = capped["content"][0]["text"].as_str().unwrap();
    assert!(
        crate::mcp::protocol::chars(text) <= crate::mcp::protocol::MAX_RESULT_CHARS,
        "{} characters",
        text.len()
    );
    assert_eq!(structured(&capped)["truncated"], true, "{capped}");
    // The provider path, the same dispatch, still returns the result unchanged.
    let scope = PreviewScope {
        environment_id: ENVIRONMENT.into(),
        thread_id: THREAD.into(),
        owner_thread_id: THREAD.into(),
        provider_session_id: "provider-session".into(),
        provider_instance_id: "codex".into(),
    };
    let provider = crate::mcp::tools::previews::run(
        scope.clone(),
        "preview_evaluate",
        json!({}),
        tokio_util::sync::CancellationToken::new(),
        &answering_invoker(answers),
        None,
    )
    .await;
    assert_eq!(
        provider,
        json!({
            "isError": false,
            "structuredContent": large,
            "content": [{ "type": "text", "text": large.to_string() }],
        })
    );

    let escaped = harness
        .call(&agent, "preview_status", json!({ "threadId": THREAD }))
        .await;
    let text = escaped["content"][0]["text"].as_str().unwrap();
    assert!(
        !text.contains('\u{202e}') && !text.contains('\u{e0041}'),
        "{text}"
    );
    assert!(text.contains("\\u202e"), "{text}");
    assert_eq!(structured(&escaped), &hidden);
    harness.shutdown().await;
}

/// A twin keeps a snapshot's image content as the provider returns it, beside policy text.
#[tokio::test]
async fn a_twin_snapshot_keeps_its_image() {
    let harness = harness().await;
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
    let image = "iVBORw0KGgo".repeat(10_000);
    harness
        .control
        .attach_previews(services(answering_invoker(json!({ "snapshot": {
            "url": "http://localhost:5173/\u{200b}",
            "screenshot": { "data": image, "mimeType": "image/png", "width": 800, "height": 600 },
        } }))));
    let snapshot = harness
        .call(&agent, "preview_snapshot", json!({ "threadId": THREAD }))
        .await;
    let content = snapshot["content"].as_array().unwrap();
    assert_eq!(content.len(), 2, "{snapshot}");
    assert!(content[0]["text"].as_str().unwrap().contains("\\u200b"));
    assert_eq!(
        content[1],
        json!({ "type": "image", "data": image, "mimeType": "image/png" })
    );
    assert_eq!(structured(&snapshot)["screenshot"]["width"], 800);
    harness.shutdown().await;
}

#[tokio::test]
async fn preview_open_with_no_automation_host_returns_the_typed_error() {
    let harness = harness().await;
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
    // No preview services at all (a server without the Connect service) answers the same.
    let unattached = harness
        .call(&agent, "preview_open", json!({ "threadId": THREAD }))
        .await;
    assert_eq!(
        error_tag(&unattached),
        "PreviewAutomationNoAvailableHostError"
    );
    harness
        .control
        .attach_previews(services(broker_invoker(PreviewAutomationBroker::new())));
    let result = harness
        .call(
            &agent,
            "preview_open",
            json!({ "threadId": THREAD, "url": "http://localhost:5173" }),
        )
        .await;
    assert_eq!(error_tag(&result), "PreviewAutomationNoAvailableHostError");
    let message = result["structuredContent"]["error"]["message"]
        .as_str()
        .unwrap();
    assert!(message.contains("Open BiBCode"), "{message}");
    assert!(
        !message.starts_with("PreviewAutomationNoAvailableHostError"),
        "{message}"
    );
    harness.shutdown().await;
}

/// A UI host that opens a new tab for each `open` and answers every other operation with the
/// tab it was sent; it records each request.
fn fake_host(broker: &PreviewAutomationBroker) -> Arc<Mutex<Vec<PreviewAutomationRequest>>> {
    let mut events = broker.connect(PreviewAutomationHost {
        client_id: "ui".into(),
        environment_id: ENVIRONMENT.into(),
        supported_operations: vec![
            PreviewAutomationOperation::Open,
            PreviewAutomationOperation::Status,
        ],
    });
    let seen: Arc<Mutex<Vec<PreviewAutomationRequest>>> = Arc::default();
    let requests = seen.clone();
    let host = broker.clone();
    tokio::spawn(async move {
        let mut opened = 0;
        while let Some(event) = events.recv().await {
            let PreviewAutomationStreamEvent::Request {
                connection_id,
                request,
            } = event
            else {
                continue;
            };
            requests.lock().unwrap().push(request.clone());
            let tab = if request.operation == PreviewAutomationOperation::Open {
                opened += 1;
                Some(format!("tab-{opened}"))
            } else {
                request.tab_id.clone()
            };
            host.respond(PreviewAutomationResponse {
                client_id: "ui".into(),
                connection_id,
                request_id: request.request_id,
                ok: true,
                result: Some(json!({ "tabId": tab })),
                error: None,
            })
            .await
            .unwrap();
        }
    });
    seen
}

#[tokio::test]
async fn two_outside_agents_get_separate_tab_assignments() {
    let harness = harness().await;
    let broker = PreviewAutomationBroker::new();
    let requests = fake_host(&broker);
    harness
        .control
        .attach_previews(services(broker_invoker(broker)));
    let (first, _) = harness.agent(McpAccess::ApprovalRequired).await;
    let (second, _) = harness.agent(McpAccess::ApprovalRequired).await;
    let thread = json!({ "threadId": THREAD });
    for (agent, tab) in [(&first, "tab-1"), (&second, "tab-2")] {
        let opened = harness.call(agent, "preview_open", thread.clone()).await;
        assert_eq!(structured(&opened)["tabId"], tab);
    }
    for (agent, tab) in [(&first, "tab-1"), (&second, "tab-2")] {
        let status = harness.call(agent, "preview_status", thread.clone()).await;
        assert_eq!(structured(&status)["tabId"], tab);
    }
    let requests = requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 4);
    assert!(requests.iter().all(|request| request.thread_id == THREAD));
    assert_eq!(requests[2].tab_id.as_deref(), Some("tab-1"));
    assert_eq!(requests[3].tab_id.as_deref(), Some("tab-2"));
    harness.shutdown().await;
}

#[tokio::test]
async fn a_read_only_connection_or_a_workspace_set_turned_off_refuses_every_twin() {
    let harness = harness().await;
    let (invoker, calls) = recording_invoker();
    harness.control.attach_previews(services(invoker));
    let (reader, _) = harness.agent(McpAccess::ReadOnly).await;
    for name in [
        "preview_status",
        "preview_open",
        "device_list",
        "device_close",
    ] {
        let refused = harness
            .call(&reader, name, json!({ "threadId": THREAD }))
            .await;
        assert_eq!(error_tag(&refused), "McpAccessCeilingError", "{name}");
    }
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
    harness.settings.send_modify(|settings| {
        settings.capabilities = McpCapabilities {
            workspace: false,
            ..McpCapabilities::default()
        };
    });
    let refused = harness
        .call(&agent, "preview_status", json!({ "threadId": THREAD }))
        .await;
    assert_eq!(error_tag(&refused), "McpCapabilityDisabledError");
    let listed = harness.control.tools(&agent);
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| !PREVIEWS.contains(&tool["name"].as_str().unwrap()))
    );
    assert!(calls.lock().unwrap().is_empty());
    harness.shutdown().await;
}

#[tokio::test]
async fn device_twins_without_device_tools_say_device_previews_are_off() {
    let harness = harness().await;
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
    let refused = harness
        .call(&agent, "device_list", json!({ "threadId": THREAD }))
        .await;
    assert_eq!(error_tag(&refused), "DevicePreviewsDisabledError");
    harness.shutdown().await;
}

#[cfg(unix)]
mod devices {
    use super::*;
    use crate::{device::android::testing::ManagerFixture, production::connect_mcp::DeviceTools};

    async fn with_devices(harness: &Harness) -> ManagerFixture {
        let fixture = ManagerFixture::ready(&["Pixel"]).await;
        let (invoker, _) = recording_invoker();
        harness.control.attach_previews(PreviewServices {
            devices: Some(DeviceTools::new(fixture.manager.clone())),
            ..services(invoker)
        });
        fixture
    }

    #[tokio::test]
    async fn device_list_works_with_device_previews_on_and_is_refused_with_them_off() {
        let harness = harness().await;
        let fixture = with_devices(&harness).await;
        let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
        let listed = harness
            .call(&agent, "device_list", json!({ "threadId": THREAD }))
            .await;
        assert_eq!(
            structured(&listed)["platforms"][0]["images"][0]["id"],
            "Pixel"
        );
        fixture.enabled.send(false).unwrap();
        let refused = harness
            .call(&agent, "device_list", json!({ "threadId": THREAD }))
            .await;
        assert_eq!(error_tag(&refused), "DevicePreviewsDisabledError");
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn an_outside_agent_cannot_close_another_threads_device() {
        let harness = harness().await;
        let fixture = with_devices(&harness).await;
        let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
        // `threadId` is not passed on: `device_open` refuses arguments it does not know.
        let opened = harness
            .call(
                &agent,
                "device_open",
                json!({ "threadId": THREAD, "imageId": "Pixel" }),
            )
            .await;
        let device_id = structured(&opened)["deviceId"].as_str().unwrap().to_owned();
        // The thread's chat panel acts for its host, so the device is its thread's too.
        let listed = harness
            .call(&agent, "device_list", json!({ "threadId": PANEL }))
            .await;
        assert_eq!(structured(&listed)["devices"][0]["thisThread"], true);
        let refused = harness
            .call(
                &agent,
                "device_close",
                json!({ "threadId": OTHER, "deviceId": device_id }),
            )
            .await;
        assert_eq!(error_tag(&refused), "DeviceBusyError");
        // The image id is a safe catalog id, so an agent can act on it.
        assert_eq!(refused["structuredContent"]["error"]["imageId"], "Pixel");
        assert_eq!(
            fixture.manager.catalog().borrow().devices[0].state,
            crate::device::catalog::DeviceState::Ready
        );
        let closed = harness
            .call(
                &agent,
                "device_close",
                json!({ "threadId": THREAD, "deviceId": device_id }),
            )
            .await;
        assert_eq!(structured(&closed)["closed"], true);
        harness.shutdown().await;
    }
}
