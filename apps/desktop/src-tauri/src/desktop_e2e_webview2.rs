//! Test-only trace of the main window's WebView2 navigations, for the packaged desktop UI
//! harness. It logs each navigation's lifecycle, the runtime version, process failures and
//! every request the page makes (from DevTools' Network domain). When a navigation has not
//! completed after [`STALL_REPORTS`], it logs what is still pending, whether the UI thread and
//! the page still answer, and where the page's JavaScript is when DevTools pauses it.
//!
//! URLs are logged without their query, so WebSocket tokens stay out of the log.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{Runtime, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_REASON,
    COREWEBVIEW2_WEB_ERROR_STATUS, ICoreWebView2, ICoreWebView2_2,
    ICoreWebView2ProcessFailedEventArgs2,
};
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, ContentLoadingEventHandler,
    DOMContentLoadedEventHandler, DevToolsProtocolEventReceivedEventHandler,
    NavigationCompletedEventHandler, NavigationStartingEventHandler, ProcessFailedEventHandler,
};
use windows::core::{BOOL, HSTRING, Interface, PWSTR};

const TARGET: &str = "bibcode::desktop_e2e";
/// How long after it started an unfinished navigation is reported, once per entry.
const STALL_REPORTS: [Duration; 2] = [Duration::from_secs(12), Duration::from_secs(40)];
const CHECK_EVERY: Duration = Duration::from_secs(2);
/// How long the page gets to answer DevTools before the stall report says it did not.
const ANSWER_WITHIN: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Trace {
    navigation: Option<Navigation>,
    /// DevTools requests that have neither finished nor failed, by request id.
    requests: BTreeMap<String, Request>,
}

struct Navigation {
    id: u64,
    started: Instant,
    reports: usize,
}

struct Request {
    url: String,
    kind: String,
    started: Instant,
}

type Shared = Arc<Mutex<Trace>>;

fn lock(trace: &Shared) -> MutexGuard<'_, Trace> {
    trace.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Starts tracing the main window's webview; a failure is logged, never fatal.
pub(crate) fn install<R: Runtime>(window: &WebviewWindow<R>) {
    let trace = Shared::default();
    let handlers = trace.clone();
    let installed = window.with_webview(move |webview| {
        // SAFETY: Tauri runs this closure on the UI thread that owns the controller.
        let result = unsafe { webview.controller().CoreWebView2() }
            .and_then(|core| subscribe(&core, &handlers));
        if let Err(error) = result {
            tracing::warn!(target: TARGET, %error, "webview2_trace_unavailable");
        }
    });
    if let Err(error) = installed {
        tracing::warn!(target: TARGET, %error, "webview2_trace_unavailable");
        return;
    }
    let window = window.clone();
    let watchdog = std::thread::Builder::new()
        .name("bibcode-e2e-webview2-trace".into())
        .spawn(move || watch_for_stalls(&window, &trace));
    if let Err(error) = watchdog {
        tracing::warn!(target: TARGET, %error, "webview2_trace_watchdog_unavailable");
    }
}

fn watch_for_stalls<R: Runtime>(window: &WebviewWindow<R>, trace: &Shared) {
    loop {
        std::thread::sleep(CHECK_EVERY);
        if let Some(navigation) = due_stall_report(trace) {
            report_stall(window, trace, navigation);
        }
    }
}

/// The unfinished navigation whose next stall report is due, counting it as reported.
fn due_stall_report(trace: &Shared) -> Option<u64> {
    let mut trace = lock(trace);
    let navigation = trace.navigation.as_mut()?;
    let due = STALL_REPORTS.get(navigation.reports)?;
    if navigation.started.elapsed() < *due {
        return None;
    }
    navigation.reports += 1;
    Some(navigation.id)
}

fn report_stall<R: Runtime>(window: &WebviewWindow<R>, trace: &Shared, navigation: u64) {
    {
        let trace = lock(trace);
        let elapsed = trace
            .navigation
            .as_ref()
            .map_or(0, |navigation| navigation.started.elapsed().as_millis());
        tracing::warn!(
            target: TARGET,
            "webview2_stall navigation={navigation} elapsed_ms={elapsed} pending_requests={}",
            trace.requests.len()
        );
        for (id, request) in &trace.requests {
            tracing::warn!(
                target: TARGET,
                "webview2_stall_pending navigation={navigation} request={id} type={} age_ms={} url={}",
                request.kind,
                request.started.elapsed().as_millis(),
                request.url
            );
        }
    }
    let answered = Arc::new(AtomicBool::new(false));
    let page_answered = answered.clone();
    let probed = window.with_webview(move |webview| {
        tracing::warn!(target: TARGET, "webview2_stall_ui_thread_answered navigation={navigation}");
        // SAFETY: Tauri runs this closure on the UI thread that owns the controller.
        let probe = unsafe { webview.controller().CoreWebView2() }
            .and_then(|core| probe_page(&core, navigation, page_answered));
        if let Err(error) = probe {
            tracing::warn!(target: TARGET, %error, "webview2_stall_probe_failed navigation={navigation}");
        }
    });
    if let Err(error) = probed {
        tracing::warn!(target: TARGET, %error, "webview2_stall_ui_thread_unreachable navigation={navigation}");
        return;
    }
    std::thread::sleep(ANSWER_WITHIN);
    if !answered.load(Ordering::Relaxed) {
        tracing::warn!(
            target: TARGET,
            "webview2_stall_page_silent navigation={navigation} within_ms={}",
            ANSWER_WITHIN.as_millis()
        );
    }
}

/// Asks the page, through DevTools, for its document state, then pauses its JavaScript to
/// learn where it is. A page whose main thread is stuck answers neither.
fn probe_page(
    core: &ICoreWebView2,
    navigation: u64,
    answered: Arc<AtomicBool>,
) -> windows::core::Result<()> {
    let expression = "JSON.stringify({readyState: document.readyState, href: location.origin + location.pathname, scripts: document.scripts.length, visibility: document.visibilityState})";
    let parameters = serde_json::json!({
        "expression": expression,
        "returnByValue": true,
        "timeout": 3000,
    });
    call_devtools(core, "Runtime.evaluate", &parameters, move |result| {
        answered.store(true, Ordering::Relaxed);
        tracing::warn!(target: TARGET, "webview2_stall_page_state navigation={navigation} result={result}");
    })?;
    call_devtools(core, "Debugger.enable", &serde_json::json!({}), |_| {})?;
    call_devtools(core, "Debugger.pause", &serde_json::json!({}), |_| {})
}

/// Calls a DevTools method and hands its JSON result, or its error, to `answered`.
fn call_devtools(
    core: &ICoreWebView2,
    method: &'static str,
    parameters: &Value,
    answered: impl FnOnce(String) + 'static,
) -> windows::core::Result<()> {
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |status: windows::core::Result<()>, result: String| {
            answered(match status {
                Ok(()) => result,
                Err(error) => format!("error {method}: {error}"),
            });
            Ok(())
        },
    ));
    let parameters = HSTRING::from(parameters.to_string());
    // SAFETY: a COM call on the UI thread that owns `core`.
    unsafe { core.CallDevToolsProtocolMethod(&HSTRING::from(method), &parameters, &handler) }
}

/// Calls `received` with each `event`'s parameters, parsed.
fn on_devtools_event(
    core: &ICoreWebView2,
    event: &'static str,
    mut received: impl FnMut(&Value) + 'static,
) -> windows::core::Result<()> {
    // SAFETY: COM calls on the UI thread that owns `core`.
    let receiver = unsafe { core.GetDevToolsProtocolEventReceiver(&HSTRING::from(event)) }?;
    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut json = PWSTR::null();
        // SAFETY: the event's live arguments, on the UI thread that raised it.
        unsafe { args.ParameterObjectAsJson(&mut json) }?;
        match serde_json::from_str::<Value>(&webview2_com::take_pwstr(json)) {
            Ok(parameters) => received(&parameters),
            Err(error) => {
                tracing::warn!(target: TARGET, %error, "webview2_devtools_event_unreadable event={event}");
            }
        }
        Ok(())
    }));
    let mut token = 0;
    // SAFETY: a COM call on the UI thread that owns `receiver`.
    unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) }
}

fn without_query(url: &str) -> String {
    url.split(['?', '#']).next().unwrap_or_default().to_owned()
}

fn text<'a>(value: &'a Value, path: &[&str]) -> &'a str {
    path.iter()
        .try_fold(value, |value, key| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn subscribe(core: &ICoreWebView2, trace: &Shared) -> windows::core::Result<()> {
    let mut token = 0;
    log_runtime_version(core);

    let starting = trace.clone();
    let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let (mut id, mut uri) = (0, PWSTR::null());
        // SAFETY: the event's live arguments, on the UI thread that raised it.
        unsafe {
            args.NavigationId(&mut id)?;
            args.Uri(&mut uri)?;
        }
        let uri = without_query(&webview2_com::take_pwstr(uri));
        let mut trace = lock(&starting);
        let pending = trace.requests.len();
        trace.navigation = Some(Navigation {
            id,
            started: Instant::now(),
            reports: 0,
        });
        tracing::info!(
            target: TARGET,
            "webview2_navigation_starting navigation={id} pending_requests={pending} uri={uri}"
        );
        Ok(())
    }));
    // SAFETY: COM calls on the UI thread that owns `core`.
    unsafe { core.add_NavigationStarting(&handler, &mut token) }?;

    let handler = ContentLoadingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let (mut id, mut error_page) = (0, BOOL::default());
        // SAFETY: the event's live arguments, on the UI thread that raised it.
        unsafe {
            args.NavigationId(&mut id)?;
            args.IsErrorPage(&mut error_page)?;
        }
        tracing::info!(
            target: TARGET,
            "webview2_content_loading navigation={id} error_page={}",
            error_page.as_bool()
        );
        Ok(())
    }));
    // SAFETY: COM calls on the UI thread that owns `core`.
    unsafe { core.add_ContentLoading(&handler, &mut token) }?;

    if let Ok(core2) = core.cast::<ICoreWebView2_2>() {
        let handler = DOMContentLoadedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut id = 0;
            // SAFETY: the event's live arguments, on the UI thread that raised it.
            unsafe { args.NavigationId(&mut id) }?;
            tracing::info!(target: TARGET, "webview2_dom_content_loaded navigation={id}");
            Ok(())
        }));
        // SAFETY: COM calls on the UI thread that owns `core`.
        unsafe { core2.add_DOMContentLoaded(&handler, &mut token) }?;
    }

    let completed = trace.clone();
    let handler = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let (mut id, mut success, mut status) =
            (0, BOOL::default(), COREWEBVIEW2_WEB_ERROR_STATUS::default());
        // SAFETY: the event's live arguments, on the UI thread that raised it.
        unsafe {
            args.NavigationId(&mut id)?;
            args.IsSuccess(&mut success)?;
            args.WebErrorStatus(&mut status)?;
        }
        let mut trace = lock(&completed);
        let elapsed = match &trace.navigation {
            Some(navigation) if navigation.id == id => {
                let elapsed = navigation.started.elapsed().as_millis();
                trace.navigation = None;
                elapsed
            }
            _ => 0,
        };
        tracing::info!(
            target: TARGET,
            "webview2_navigation_completed navigation={id} success={} web_error_status={} elapsed_ms={elapsed}",
            success.as_bool(),
            status.0
        );
        Ok(())
    }));
    // SAFETY: COM calls on the UI thread that owns `core`.
    unsafe { core.add_NavigationCompleted(&handler, &mut token) }?;

    let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
        // SAFETY: the event's live arguments, on the UI thread that raised it.
        unsafe {
            args.ProcessFailedKind(&mut kind)?;
            if let Ok(details) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                details.Reason(&mut reason)?;
            }
        }
        tracing::warn!(
            target: TARGET,
            "webview2_process_failed kind={} reason={}",
            kind.0,
            reason.0
        );
        Ok(())
    }));
    // SAFETY: COM calls on the UI thread that owns `core`.
    unsafe { core.add_ProcessFailed(&handler, &mut token) }?;

    subscribe_devtools(core, trace)
}

fn subscribe_devtools(core: &ICoreWebView2, trace: &Shared) -> windows::core::Result<()> {
    let started = trace.clone();
    on_devtools_event(core, "Network.requestWillBeSent", move |event| {
        let id = text(event, &["requestId"]).to_owned();
        let url = without_query(text(event, &["request", "url"]));
        let kind = text(event, &["type"]).to_owned();
        tracing::info!(target: TARGET, "webview2_request_started request={id} type={kind} url={url}");
        lock(&started).requests.insert(
            id,
            Request {
                url,
                kind,
                started: Instant::now(),
            },
        );
    })?;
    let finished = trace.clone();
    on_devtools_event(core, "Network.loadingFinished", move |event| {
        let id = text(event, &["requestId"]);
        if let Some(request) = lock(&finished).requests.remove(id) {
            tracing::info!(
                target: TARGET,
                "webview2_request_finished request={id} elapsed_ms={} url={}",
                request.started.elapsed().as_millis(),
                request.url
            );
        }
    })?;
    let failed = trace.clone();
    on_devtools_event(core, "Network.loadingFailed", move |event| {
        let id = text(event, &["requestId"]);
        let error = text(event, &["errorText"]);
        let canceled = event
            .get("canceled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let Some(request) = lock(&failed).requests.remove(id) {
            tracing::info!(
                target: TARGET,
                "webview2_request_failed request={id} canceled={canceled} error={error} elapsed_ms={} url={}",
                request.started.elapsed().as_millis(),
                request.url
            );
        }
    })?;
    on_devtools_event(core, "Network.webSocketCreated", |event| {
        tracing::info!(
            target: TARGET,
            "webview2_websocket_created request={} url={}",
            text(event, &["requestId"]),
            without_query(text(event, &["url"]))
        );
    })?;
    on_devtools_event(core, "Network.webSocketClosed", |event| {
        tracing::info!(
            target: TARGET,
            "webview2_websocket_closed request={}",
            text(event, &["requestId"])
        );
    })?;
    on_devtools_event(core, "Page.lifecycleEvent", |event| {
        tracing::info!(
            target: TARGET,
            "webview2_page_lifecycle name={} frame={} loader={}",
            text(event, &["name"]),
            text(event, &["frameId"]),
            text(event, &["loaderId"])
        );
    })?;
    let resume = core.clone();
    on_devtools_event(core, "Debugger.paused", move |event| {
        let frames = event
            .get("callFrames")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        tracing::warn!(
            target: TARGET,
            "webview2_stall_paused reason={} frames={}",
            text(event, &["reason"]),
            frames.len()
        );
        for frame in frames.iter().take(12) {
            tracing::warn!(
                target: TARGET,
                "webview2_stall_frame function={} url={} line={} column={}",
                text(frame, &["functionName"]),
                without_query(text(frame, &["url"])),
                frame["location"]["lineNumber"],
                frame["location"]["columnNumber"]
            );
        }
        for method in ["Debugger.resume", "Debugger.disable"] {
            if let Err(error) = call_devtools(&resume, method, &serde_json::json!({}), |_| {}) {
                tracing::warn!(target: TARGET, %error, "webview2_stall_resume_failed method={method}");
            }
        }
    })?;

    for (method, parameters) in [
        ("Network.enable", serde_json::json!({})),
        ("Page.enable", serde_json::json!({})),
        (
            "Page.setLifecycleEventsEnabled",
            serde_json::json!({ "enabled": true }),
        ),
    ] {
        call_devtools(core, method, &parameters, move |result| {
            if result.starts_with("error ") {
                tracing::warn!(target: TARGET, "webview2_devtools_unavailable {result}");
            }
        })?;
    }
    Ok(())
}

fn runtime_version(core: &ICoreWebView2) -> windows::core::Result<String> {
    // SAFETY: COM calls on the UI thread that owns `core`.
    let environment = unsafe { core.cast::<ICoreWebView2_2>()?.Environment()? };
    let mut version = PWSTR::null();
    // SAFETY: `version` receives a CoTaskMem string, which `take_pwstr` frees.
    unsafe { environment.BrowserVersionString(&mut version) }?;
    Ok(webview2_com::take_pwstr(version))
}

fn log_runtime_version(core: &ICoreWebView2) {
    match runtime_version(core) {
        Ok(version) => tracing::info!(target: TARGET, "webview2_runtime version={version}"),
        Err(error) => tracing::warn!(target: TARGET, %error, "webview2_runtime_version_unknown"),
    }
}
