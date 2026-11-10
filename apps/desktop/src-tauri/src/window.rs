use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Runtime, Size,
    WebviewWindow,
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
};

use crate::config::{read_json_file, state_dir, write_json_file};
use crate::context_menu::NativeContextMenuManager;

pub const MENU_ACTION_EVENT: &str = "desktop:menu-action";
pub const MENU_ACTION_OPEN_SETTINGS: &str = "open-settings";
pub const MENU_ACTION_CHECK_FOR_UPDATES: &str = "check-for-updates";
pub const MENU_ACTION_CLOSE_SHORTCUT: &str = "close-shortcut";

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
const MENU_ID_OPEN_SETTINGS: &str = "bibcode:open-settings";
const MENU_ID_CHECK_FOR_UPDATES: &str = "bibcode:check-for-updates";
const MENU_ID_CLOSE_SHORTCUT: &str = "bibcode:close-shortcut";
const MENU_ID_CLOSE_WINDOW: &str = "bibcode:close-window";
const MENU_ID_QUIT: &str = "bibcode:quit";
const MIN_RESTORED_WINDOW_HEIGHT: u32 = 480;
const MIN_RESTORED_WINDOW_WIDTH: u32 = 640;
const MAX_RESTORED_WINDOW_HEIGHT: u32 = 10_000;
const MAX_RESTORED_WINDOW_WIDTH: u32 = 10_000;
const WINDOW_STATE_FILE_NAME: &str = "window-state.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MainWindowState {
    width: u32,
    height: u32,
    x: Option<i32>,
    y: Option<i32>,
    maximized: bool,
    fullscreen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApplicationMenuAction {
    Emit(&'static str),
    CloseWindow,
    Quit,
}

fn menu_action_for_id(id: &str) -> Option<ApplicationMenuAction> {
    match id {
        MENU_ID_OPEN_SETTINGS => Some(ApplicationMenuAction::Emit(MENU_ACTION_OPEN_SETTINGS)),
        MENU_ID_CHECK_FOR_UPDATES => {
            Some(ApplicationMenuAction::Emit(MENU_ACTION_CHECK_FOR_UPDATES))
        }
        MENU_ID_CLOSE_SHORTCUT => Some(ApplicationMenuAction::Emit(MENU_ACTION_CLOSE_SHORTCUT)),
        MENU_ID_CLOSE_WINDOW => Some(ApplicationMenuAction::CloseWindow),
        MENU_ID_QUIT => Some(ApplicationMenuAction::Quit),
        _ => None,
    }
}

pub fn configure_application_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_application_menu(app)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if app
            .state::<NativeContextMenuManager>()
            .complete_if_context_menu_event(event.id().0.as_str())
        {
            return;
        }
        match menu_action_for_id(event.id().0.as_str()) {
            Some(ApplicationMenuAction::Emit(action)) => {
                if action == MENU_ACTION_OPEN_SETTINGS
                    && let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL)
                {
                    let _ = window.set_focus();
                }
                let _ = app.emit(MENU_ACTION_EVENT, action);
            }
            Some(ApplicationMenuAction::CloseWindow) => {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.close();
                }
            }
            Some(ApplicationMenuAction::Quit) => match app.try_state::<CloseGuard>() {
                Some(guard) => guard.request(LeaveReason::Quit, Instant::now()),
                None => app.exit(0),
            },
            None => {}
        }
    });
    Ok(())
}

fn build_application_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let settings = MenuItemBuilder::with_id(MENU_ID_OPEN_SETTINGS, "Settings...")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let check_for_updates =
        MenuItemBuilder::with_id(MENU_ID_CHECK_FOR_UPDATES, "Check for Updates...").build(app)?;
    let close_shortcut = MenuItemBuilder::with_id(MENU_ID_CLOSE_SHORTCUT, "Close Active Surface")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let close_window = MenuItemBuilder::with_id(MENU_ID_CLOSE_WINDOW, "Close Window").build(app)?;
    let quit = quit_menu_item(app)?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&settings)
        .separator()
        .item(&close_shortcut)
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&close_window)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&check_for_updates)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &window, &help])
        .build()
}

/// The predefined Quit item ends the app through `terminate:` or `PostQuitMessage`, which never
/// raises `ExitRequested`, so it cannot wait for the web. This one asks first. Label and shortcut
/// match the predefined item, with `CmdOrCtrl+Q` on macOS only.
fn quit_menu_item<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::MenuItem<R>> {
    #[cfg(target_os = "macos")]
    let item = MenuItemBuilder::with_id(MENU_ID_QUIT, format!("Quit {}", app.package_info().name))
        .accelerator("CmdOrCtrl+Q");
    #[cfg(windows)]
    let item = MenuItemBuilder::with_id(MENU_ID_QUIT, "&Exit");
    #[cfg(not(any(target_os = "macos", windows)))]
    let item = MenuItemBuilder::with_id(MENU_ID_QUIT, "&Quit");
    item.build(app)
}

fn window_state_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join(WINDOW_STATE_FILE_NAME))
}

fn normalize_main_window_state(state: MainWindowState) -> Option<MainWindowState> {
    if !(MIN_RESTORED_WINDOW_WIDTH..=MAX_RESTORED_WINDOW_WIDTH).contains(&state.width) {
        return None;
    }
    if !(MIN_RESTORED_WINDOW_HEIGHT..=MAX_RESTORED_WINDOW_HEIGHT).contains(&state.height) {
        return None;
    }
    match (state.x, state.y) {
        (Some(_), Some(_)) | (None, None) => Some(state),
        _ => None,
    }
}

fn main_window_state_to_value(state: &MainWindowState) -> Result<Value, String> {
    serde_json::to_value(state)
        .map_err(|error| format!("Could not encode Tauri main window state: {error}"))
}

fn decode_main_window_state(value: Value) -> Result<MainWindowState, String> {
    serde_json::from_value::<MainWindowState>(value)
        .map_err(|error| format!("Could not decode Tauri main window state: {error}"))
}

fn apply_main_window_state<R: Runtime>(window: &WebviewWindow<R>, state: &MainWindowState) {
    if let Err(error) = window.set_size(Size::Physical(PhysicalSize {
        width: state.width,
        height: state.height,
    })) {
        tracing::warn!("failed to restore Tauri main window size: {error}");
    }
    if let (Some(x), Some(y)) = (state.x, state.y)
        && let Err(error) = window.set_position(Position::Physical(PhysicalPosition { x, y }))
    {
        tracing::warn!("failed to restore Tauri main window position: {error}");
    }
    if state.fullscreen {
        if let Err(error) = window.set_fullscreen(true) {
            tracing::warn!("failed to restore Tauri main window fullscreen state: {error}");
        }
    } else if state.maximized
        && let Err(error) = window.maximize()
    {
        tracing::warn!("failed to restore Tauri main window maximized state: {error}");
    }
}

fn capture_main_window_state<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<Option<MainWindowState>, String> {
    let size = window
        .outer_size()
        .or_else(|_| window.inner_size())
        .map_err(|error| format!("Could not read the Tauri main window size: {error}"))?;
    let position = window.outer_position().ok();
    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    Ok(normalize_main_window_state(MainWindowState {
        width: size.width,
        height: size.height,
        x: position.as_ref().map(|position| position.x),
        y: position.as_ref().map(|position| position.y),
        maximized,
        fullscreen,
    }))
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MainNewWindowAction {
    OpenExternal,
    Ignore,
}

pub(crate) fn main_window_new_window_action(url: &tauri::Url) -> MainNewWindowAction {
    match url.scheme() {
        "http" | "https" | "mailto" => MainNewWindowAction::OpenExternal,
        _ => MainNewWindowAction::Ignore,
    }
}

/// Builds the main window from `tauri.conf.json` (`"create": false`) so it can
/// route `window.open` / `target=_blank` requests to the system browser.
pub(crate) fn build_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .cloned()
        .expect("tauri.conf.json defines the main window");
    let handle = app.clone();
    let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?.on_new_window(
        move |url, _features| {
            if main_window_new_window_action(&url) == MainNewWindowAction::OpenExternal
                && let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>)
            {
                tracing::warn!("failed to open link externally: {error}");
            }
            tauri::webview::NewWindowResponse::Deny
        },
    );
    // A loaded page runs in a web content process the profiler remembers for crash reports.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let builder = builder.on_page_load(|window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            crate::webview_exit::page_loaded(window.app_handle(), window.label());
        }
        // A reload starts a renderer that knows none of the old one's preview tunnels (#69).
        #[cfg(target_os = "linux")]
        if payload.event() == tauri::webview::PageLoadEvent::Started
            && let Some(tunnels) = window
                .app_handle()
                .try_state::<crate::preview::socks::PreviewTunnels>()
        {
            let tunnels = tunnels.inner().clone();
            tauri::async_runtime::spawn(async move { tunnels.close_all().await });
        }
    });
    let window = builder.build()?;
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    watch_web_content_process(&window);
    let guard_app = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event
            && let Some(guard) = guard_app.try_state::<CloseGuard>()
        {
            // Tauri reads the answer at once, so hold now and destroy the window once allowed.
            api.prevent_close();
            guard.request(LeaveReason::Close, Instant::now());
        }
    });
    Ok(())
}

/// Reports the main window's web content process dying to the profiler. macOS registers its
/// hook on the app builder instead.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn watch_web_content_process<R: Runtime>(window: &WebviewWindow<R>) {
    let installed = window.with_webview(|webview| {
        #[cfg(target_os = "linux")]
        crate::webview_exit::watch(&webview.inner());
        #[cfg(target_os = "windows")]
        // SAFETY: Tauri runs this closure on the UI thread that owns the controller.
        if let Err(error) = unsafe { webview.controller().CoreWebView2() }
            .and_then(|core| crate::webview_exit::watch(&core))
        {
            tracing::warn!(%error, "webview process failures are not watched");
        }
    });
    if let Err(error) = installed {
        tracing::warn!(%error, "webview process exits are not watched");
    }
}

pub fn restore_main_window_state<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let path = window_state_path(app)?;
    let Some(value) = read_json_file(&path)? else {
        return Ok(());
    };
    let state = match decode_main_window_state(value).and_then(|state| {
        normalize_main_window_state(state)
            .ok_or_else(|| "Ignored invalid Tauri main window state bounds".to_string())
    }) {
        Ok(state) => state,
        Err(error) => {
            tracing::warn!("{error}");
            return Ok(());
        }
    };
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };
    apply_main_window_state(&window, &state);
    Ok(())
}

pub fn persist_main_window_state<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };
    let Some(state) = capture_main_window_state(&window)? else {
        return Ok(());
    };
    let path = window_state_path(app)?;
    write_json_file(&path, &main_window_state_to_value(&state)?)
}

pub const CLOSE_REQUEST_EVENT: &str = "desktop:close-request";
/// How long the desktop waits for an acknowledge, and for each keepalive after one.
const CLOSE_ANSWER_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_WATCH_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LeaveReason {
    Close,
    Quit,
    /// An update install another device requested; it restarts the app once allowed.
    Update,
}

/// How a request ended: `allowed` by the web or the person, or not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CloseAnswer {
    reason: LeaveReason,
    allowed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CloseReply {
    Acknowledge,
    Keepalive,
    Allow,
    Stay,
}

#[derive(Debug, Clone, Copy)]
struct PendingClose {
    request_id: u64,
    reason: LeaveReason,
    deadline: Instant,
    prompting: bool,
}

/// One close or quit waiting for the web's answer (R62).
#[derive(Debug, Default)]
struct CloseRequests {
    next_id: u64,
    pending: Option<PendingClose>,
}

impl CloseRequests {
    /// The id to ask the web with, or `None` when a pending request already covers it.
    fn begin(&mut self, reason: LeaveReason, now: Instant) -> Option<u64> {
        if self.pending.is_some() {
            return None;
        }
        self.next_id += 1;
        self.pending = Some(PendingClose {
            request_id: self.next_id,
            reason,
            deadline: now + CLOSE_ANSWER_TIMEOUT,
            prompting: false,
        });
        Some(self.next_id)
    }

    /// How the request ended, once the web answered. A stale reply changes nothing.
    fn reply(&mut self, request_id: u64, reply: CloseReply, now: Instant) -> Option<CloseAnswer> {
        let pending = self
            .pending
            .as_mut()
            .filter(|pending| pending.request_id == request_id)?;
        match reply {
            CloseReply::Acknowledge | CloseReply::Keepalive => {
                pending.deadline = now + CLOSE_ANSWER_TIMEOUT;
                None
            }
            CloseReply::Allow | CloseReply::Stay => {
                self.pending.take().map(|pending| CloseAnswer {
                    reason: pending.reason,
                    allowed: reply == CloseReply::Allow,
                })
            }
        }
    }

    /// The request whose deadline passed, put to the person once.
    fn expired(&mut self, now: Instant) -> Option<u64> {
        let pending = self.pending.as_mut()?;
        if pending.prompting || now < pending.deadline {
            return None;
        }
        pending.prompting = true;
        Some(pending.request_id)
    }

    /// Close anyway leaves; Keep waiting starts a new wait on the same request.
    fn prompt_answered(
        &mut self,
        request_id: u64,
        close_anyway: bool,
        now: Instant,
    ) -> Option<CloseAnswer> {
        let pending = self
            .pending
            .as_mut()
            .filter(|pending| pending.request_id == request_id && pending.prompting)?;
        if close_anyway {
            return self.pending.take().map(|pending| CloseAnswer {
                reason: pending.reason,
                allowed: true,
            });
        }
        pending.prompting = false;
        pending.deadline = now + CLOSE_ANSWER_TIMEOUT;
        None
    }
}

type AskWeb = Box<dyn Fn(u64, LeaveReason) + Send + Sync>;
type PromptPerson = Box<dyn Fn(u64) + Send + Sync>;
type Leave = Box<dyn Fn(LeaveReason) + Send + Sync>;

/// Holds a close or quit until the web allows it. Nothing irreversible runs before `leave`.
/// Closing destroys the main window there, and quitting calls `app.exit(0)` there, whose
/// `ExitRequested` stops the embedded server.
pub(crate) struct CloseGuard {
    requests: Mutex<CloseRequests>,
    ask_web: AskWeb,
    prompt_person: PromptPerson,
    leave: Leave,
    /// Waits for the answer to a pending `Update` request.
    update_answer: Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
    /// Set only by the end-to-end teardown, so a session ends without a dialog nobody answers.
    disarmed: std::sync::atomic::AtomicBool,
}

impl CloseGuard {
    fn new(ask_web: AskWeb, prompt_person: PromptPerson, leave: Leave) -> Self {
        Self {
            requests: Mutex::new(CloseRequests::default()),
            ask_web,
            prompt_person,
            leave,
            update_answer: Mutex::new(None),
            disarmed: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, CloseRequests> {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Asks the web, or joins the request already pending.
    pub(crate) fn request(&self, reason: LeaveReason, now: Instant) {
        if self.disarmed.load(std::sync::atomic::Ordering::Relaxed) {
            (self.leave)(reason);
            return;
        }
        let request_id = self.lock().begin(reason, now);
        if let Some(request_id) = request_id {
            (self.ask_web)(request_id, reason);
        }
    }

    /// End-to-end builds only: every later close or quit leaves at once, as if allowed.
    #[cfg(any(feature = "desktop-e2e", test))]
    pub(crate) fn disarm(&self) {
        self.disarmed
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// Asks the web before a remote update install restarts the app. Resolves true once allowed,
    /// false on stay. `None` when another request is pending, so the install does not start.
    pub(crate) fn ask_before_update(
        &self,
        now: Instant,
    ) -> Option<tokio::sync::oneshot::Receiver<bool>> {
        let request_id = self.lock().begin(LeaveReason::Update, now)?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        *self
            .update_answer
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(sender);
        (self.ask_web)(request_id, LeaveReason::Update);
        Some(receiver)
    }

    fn finish(&self, answer: CloseAnswer) {
        if answer.reason == LeaveReason::Update {
            let sender = self
                .update_answer
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let Some(sender) = sender {
                let _ = sender.send(answer.allowed);
            }
        } else if answer.allowed {
            (self.leave)(answer.reason);
        }
    }

    pub(crate) fn reply(&self, request_id: u64, reply: CloseReply, now: Instant) {
        let answer = self.lock().reply(request_id, reply, now);
        if let Some(answer) = answer {
            self.finish(answer);
        }
    }

    /// Puts an expired request to the person, and returns whether a request is still pending.
    pub(crate) fn tick(&self, now: Instant) -> bool {
        let (expired, pending) = {
            let mut requests = self.lock();
            (requests.expired(now), requests.pending.is_some())
        };
        if let Some(request_id) = expired {
            tracing::warn!(
                request_id,
                "the window did not answer a close request in time"
            );
            (self.prompt_person)(request_id);
        }
        pending
    }

    pub(crate) fn prompt_answered(&self, request_id: u64, close_anyway: bool, now: Instant) {
        let answer = self.lock().prompt_answered(request_id, close_anyway, now);
        if let Some(answer) = answer {
            tracing::warn!(request_id, reason = ?answer.reason, "leaving without the window's answer");
            self.finish(answer);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseRequestPayload {
    request_id: u64,
    reason: LeaveReason,
}

pub(crate) fn close_guard_for_app<R: Runtime>(app: &AppHandle<R>) -> CloseGuard {
    let ask_app = app.clone();
    let prompt_app = app.clone();
    let leave_app = app.clone();
    CloseGuard::new(
        Box::new(move |request_id, reason| ask_web_to_leave(&ask_app, request_id, reason)),
        Box::new(move |request_id| prompt_close_anyway(&prompt_app, request_id)),
        Box::new(move |reason| leave_now(&leave_app, reason)),
    )
}

fn ask_web_to_leave<R: Runtime>(app: &AppHandle<R>, request_id: u64, reason: LeaveReason) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        // No page can hold an edit, so leaving loses nothing.
        if let Some(guard) = app.try_state::<CloseGuard>() {
            guard.reply(request_id, CloseReply::Allow, Instant::now());
        }
        return;
    };
    // The person must see the question, and a visible page is not throttled.
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if let Err(error) = app.emit_to(
        MAIN_WINDOW_LABEL,
        CLOSE_REQUEST_EVENT,
        CloseRequestPayload { request_id, reason },
    ) {
        tracing::warn!(%error, "failed to ask the window before closing");
    }
    let watch_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CLOSE_WATCH_INTERVAL).await;
            let Some(guard) = watch_app.try_state::<CloseGuard>() else {
                break;
            };
            if !guard.tick(Instant::now()) {
                break;
            }
        }
    });
}

fn prompt_close_anyway<R: Runtime>(app: &AppHandle<R>, request_id: u64) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let answer_app = app.clone();
    app.dialog()
        .message("BiBCode is not responding. Unsaved Files edits may be lost.")
        .title("BiBCode")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Close anyway".to_owned(),
            "Keep waiting".to_owned(),
        ))
        .show(move |close_anyway| {
            if let Some(guard) = answer_app.try_state::<CloseGuard>() {
                guard.prompt_answered(request_id, close_anyway, Instant::now());
            }
        });
}

fn leave_now<R: Runtime>(app: &AppHandle<R>, reason: LeaveReason) {
    match reason {
        LeaveReason::Close => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL)
                && let Err(error) = window.destroy()
            {
                tracing::warn!(%error, "failed to close the main window");
            }
        }
        LeaveReason::Quit => app.exit(0),
        // The remote install waits on `ask_before_update` and restarts the app itself.
        LeaveReason::Update => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A guard whose web, prompt and leave actions are recorded. `leave` is the only path to
    /// the window's destruction and, for a quit, to `ExitRequested`, which stops the server.
    struct RecordedGuard {
        guard: CloseGuard,
        asked: std::sync::Arc<Mutex<Vec<(u64, LeaveReason)>>>,
        prompted: std::sync::Arc<Mutex<Vec<u64>>>,
        left: std::sync::Arc<Mutex<Vec<LeaveReason>>>,
    }

    impl RecordedGuard {
        fn new() -> Self {
            let asked = std::sync::Arc::new(Mutex::new(Vec::new()));
            let prompted = std::sync::Arc::new(Mutex::new(Vec::new()));
            let left = std::sync::Arc::new(Mutex::new(Vec::new()));
            let (a, p, l) = (asked.clone(), prompted.clone(), left.clone());
            let guard = CloseGuard::new(
                Box::new(move |id, reason| a.lock().unwrap().push((id, reason))),
                Box::new(move |id| p.lock().unwrap().push(id)),
                Box::new(move |reason| l.lock().unwrap().push(reason)),
            );
            Self {
                guard,
                asked,
                prompted,
                left,
            }
        }

        fn request(&self, reason: LeaveReason, now: Instant) -> u64 {
            self.guard.request(reason, now);
            self.asked
                .lock()
                .unwrap()
                .last()
                .expect("the web was asked")
                .0
        }

        fn left(&self) -> Vec<LeaveReason> {
            self.left.lock().unwrap().clone()
        }

        fn prompted(&self) -> Vec<u64> {
            self.prompted.lock().unwrap().clone()
        }
    }

    fn later(start: Instant, seconds: u64) -> Instant {
        start + Duration::from_secs(seconds)
    }

    #[test]
    fn close_request_waits_for_the_web_answer() {
        let recorded = RecordedGuard::new();
        let start = Instant::now();
        let id = recorded.request(LeaveReason::Close, start);
        recorded.guard.reply(id, CloseReply::Acknowledge, start);
        for second in 1..=60 {
            recorded
                .guard
                .reply(id, CloseReply::Keepalive, later(start, second));
            assert!(recorded.guard.tick(later(start, second)));
        }
        assert!(recorded.left().is_empty());
        assert!(recorded.prompted().is_empty());
        // A second close joins the pending request instead of asking again.
        recorded.guard.request(LeaveReason::Close, later(start, 61));
        assert_eq!(recorded.asked.lock().unwrap().len(), 1);
    }

    #[test]
    fn close_request_closes_when_the_web_allows_it() {
        let recorded = RecordedGuard::new();
        let start = Instant::now();
        let id = recorded.request(LeaveReason::Close, start);
        recorded.guard.reply(id + 1, CloseReply::Allow, start);
        assert!(recorded.left().is_empty(), "a stale id must not close");
        recorded.guard.reply(id, CloseReply::Acknowledge, start);
        recorded.guard.reply(id, CloseReply::Allow, start);
        assert_eq!(recorded.left(), vec![LeaveReason::Close]);
        recorded.guard.reply(id, CloseReply::Allow, start);
        assert_eq!(
            recorded.left().len(),
            1,
            "an answer with no request pending is dropped"
        );
    }

    #[test]
    fn close_request_keeps_the_window_and_the_server_when_the_web_says_stay() {
        let recorded = RecordedGuard::new();
        let start = Instant::now();
        let id = recorded.request(LeaveReason::Close, start);
        recorded.guard.reply(id, CloseReply::Acknowledge, start);
        recorded.guard.reply(id, CloseReply::Stay, start);
        assert!(!recorded.guard.tick(later(start, 30)));
        assert!(recorded.left().is_empty());
        assert!(recorded.prompted().is_empty());
        // The next close asks again with a new id.
        let next = recorded.request(LeaveReason::Close, later(start, 31));
        assert_ne!(next, id);
    }

    #[test]
    fn close_request_escapes_when_the_web_never_acknowledges() {
        let recorded = RecordedGuard::new();
        let start = Instant::now();
        let id = recorded.request(LeaveReason::Close, start);
        assert!(recorded.guard.tick(later(start, 4)));
        assert!(recorded.prompted().is_empty());
        assert!(recorded.guard.tick(later(start, 5)));
        assert_eq!(recorded.prompted(), vec![id]);
        assert!(recorded.guard.tick(later(start, 6)));
        assert_eq!(recorded.prompted(), vec![id], "the prompt is shown once");
        // Keep waiting starts a new wait, then Close anyway leaves.
        recorded.guard.prompt_answered(id, false, later(start, 7));
        assert!(recorded.left().is_empty());
        assert!(recorded.guard.tick(later(start, 11)));
        assert_eq!(recorded.prompted(), vec![id]);
        assert!(recorded.guard.tick(later(start, 12)));
        assert_eq!(recorded.prompted(), vec![id, id]);
        recorded.guard.prompt_answered(id, true, later(start, 13));
        assert_eq!(recorded.left(), vec![LeaveReason::Close]);
    }

    #[test]
    fn close_request_escapes_when_keepalives_stop_after_an_acknowledge() {
        let recorded = RecordedGuard::new();
        let start = Instant::now();
        let id = recorded.request(LeaveReason::Close, start);
        recorded.guard.reply(id, CloseReply::Acknowledge, start);
        recorded
            .guard
            .reply(id, CloseReply::Keepalive, later(start, 3));
        assert!(recorded.guard.tick(later(start, 7)));
        assert!(recorded.prompted().is_empty());
        assert!(recorded.guard.tick(later(start, 8)));
        assert_eq!(recorded.prompted(), vec![id]);
        // An answer that arrives while the prompt is open still decides the request.
        recorded.guard.reply(id, CloseReply::Stay, later(start, 9));
        recorded.guard.prompt_answered(id, true, later(start, 10));
        assert!(recorded.left().is_empty());
    }

    #[test]
    fn close_request_on_quit_waits_for_the_web_before_the_server_stops() {
        let recorded = RecordedGuard::new();
        let start = Instant::now();
        let id = recorded.request(LeaveReason::Quit, start);
        recorded.guard.reply(id, CloseReply::Acknowledge, start);
        recorded
            .guard
            .reply(id, CloseReply::Keepalive, later(start, 1));
        assert!(
            recorded.left().is_empty(),
            "nothing stops before the web answers"
        );
        recorded.guard.reply(id, CloseReply::Allow, later(start, 2));
        assert_eq!(recorded.left(), vec![LeaveReason::Quit]);
    }

    #[test]
    fn close_request_on_quit_cancel_keeps_the_server_answering() {
        // Desktop unit tests cannot start the embedded server; the packaged run in Task 8.6
        // sends a server request after Cancel. Here: Cancel never reaches the teardown.
        let recorded = RecordedGuard::new();
        let start = Instant::now();
        let id = recorded.request(LeaveReason::Quit, start);
        recorded.guard.reply(id, CloseReply::Acknowledge, start);
        recorded.guard.reply(id, CloseReply::Stay, later(start, 1));
        assert!(!recorded.guard.tick(later(start, 30)));
        assert!(recorded.left().is_empty());
    }

    #[test]
    fn close_request_on_remote_update_proceeds_only_when_the_web_allows_it() {
        let recorded = RecordedGuard::new();
        let start = Instant::now();
        let mut allowed = recorded.guard.ask_before_update(start).expect("asked");
        let (id, reason) = *recorded.asked.lock().unwrap().last().unwrap();
        assert_eq!(reason, LeaveReason::Update);
        recorded.guard.reply(id, CloseReply::Acknowledge, start);
        assert!(
            allowed.try_recv().is_err(),
            "nothing is decided before the answer"
        );
        recorded.guard.reply(id, CloseReply::Allow, later(start, 1));
        assert_eq!(allowed.try_recv(), Ok(true));
        assert!(
            recorded.left().is_empty(),
            "an update never destroys the window or quits"
        );

        let mut stayed = recorded
            .guard
            .ask_before_update(later(start, 2))
            .expect("asked");
        let (id, _) = *recorded.asked.lock().unwrap().last().unwrap();
        recorded.guard.reply(id, CloseReply::Stay, later(start, 3));
        assert_eq!(stayed.try_recv(), Ok(false));

        // A close already pending means the install does not start.
        recorded.guard.request(LeaveReason::Close, later(start, 4));
        assert!(recorded.guard.ask_before_update(later(start, 5)).is_none());
    }

    #[test]
    fn close_request_disarmed_for_end_to_end_teardown_leaves_at_once() {
        let recorded = RecordedGuard::new();
        recorded.guard.disarm();
        recorded.guard.request(LeaveReason::Close, Instant::now());
        assert_eq!(recorded.left(), vec![LeaveReason::Close]);
        assert!(recorded.asked.lock().unwrap().is_empty());
    }

    #[test]
    fn close_request_quit_menu_item_replaces_the_predefined_quit() {
        assert_eq!(
            menu_action_for_id(MENU_ID_QUIT),
            Some(ApplicationMenuAction::Quit)
        );
    }

    #[test]
    fn close_request_payload_and_replies_match_the_web_contract() {
        assert_eq!(
            serde_json::to_value(CloseRequestPayload {
                request_id: 3,
                reason: LeaveReason::Quit
            })
            .unwrap(),
            json!({"requestId": 3, "reason": "quit"})
        );
        for (wire, reply) in [
            ("acknowledge", CloseReply::Acknowledge),
            ("keepalive", CloseReply::Keepalive),
            ("allow", CloseReply::Allow),
            ("stay", CloseReply::Stay),
        ] {
            assert_eq!(
                serde_json::from_value::<CloseReply>(json!(wire)).unwrap(),
                reply
            );
        }
    }

    #[test]
    fn main_window_new_windows_open_externally_for_web_and_mail_links() {
        use super::{MainNewWindowAction, main_window_new_window_action};
        for url in [
            "https://github.com/x/y/pull/1",
            "http://localhost:3000/",
            "mailto:a@b.c",
        ] {
            let url = tauri::Url::parse(url).unwrap();
            assert_eq!(
                main_window_new_window_action(&url),
                MainNewWindowAction::OpenExternal
            );
        }
        let file = tauri::Url::parse("file:///etc/passwd").unwrap();
        assert_eq!(
            main_window_new_window_action(&file),
            MainNewWindowAction::Ignore
        );
    }

    #[test]
    fn maps_known_application_menu_ids_to_actions() {
        assert_eq!(
            menu_action_for_id(MENU_ID_OPEN_SETTINGS),
            Some(ApplicationMenuAction::Emit(MENU_ACTION_OPEN_SETTINGS))
        );
        assert_eq!(
            menu_action_for_id(MENU_ID_CHECK_FOR_UPDATES),
            Some(ApplicationMenuAction::Emit(MENU_ACTION_CHECK_FOR_UPDATES))
        );
        assert_eq!(
            menu_action_for_id(MENU_ID_CLOSE_SHORTCUT),
            Some(ApplicationMenuAction::Emit(MENU_ACTION_CLOSE_SHORTCUT))
        );
        assert_eq!(
            menu_action_for_id(MENU_ID_CLOSE_WINDOW),
            Some(ApplicationMenuAction::CloseWindow)
        );
        assert_eq!(menu_action_for_id("copy"), None);
    }

    #[test]
    fn normalizes_main_window_state_bounds() {
        let valid = MainWindowState {
            width: 1280,
            height: 900,
            x: Some(100),
            y: Some(120),
            maximized: false,
            fullscreen: false,
        };

        assert_eq!(normalize_main_window_state(valid.clone()), Some(valid));
        assert_eq!(
            normalize_main_window_state(MainWindowState {
                width: MIN_RESTORED_WINDOW_WIDTH - 1,
                height: 900,
                x: Some(100),
                y: Some(120),
                maximized: false,
                fullscreen: false,
            }),
            None
        );
        assert_eq!(
            normalize_main_window_state(MainWindowState {
                width: 1280,
                height: MAX_RESTORED_WINDOW_HEIGHT + 1,
                x: Some(100),
                y: Some(120),
                maximized: false,
                fullscreen: false,
            }),
            None
        );
        assert_eq!(
            normalize_main_window_state(MainWindowState {
                width: 1280,
                height: 900,
                x: None,
                y: Some(120),
                maximized: false,
                fullscreen: false,
            }),
            None
        );
        assert_eq!(
            normalize_main_window_state(MainWindowState {
                width: 1280,
                height: 900,
                x: Some(100),
                y: None,
                maximized: false,
                fullscreen: false,
            }),
            None
        );
    }

    #[test]
    fn encodes_and_decodes_main_window_state_documents() {
        let state = MainWindowState {
            width: 1280,
            height: 900,
            x: None,
            y: None,
            maximized: true,
            fullscreen: false,
        };

        assert_eq!(
            decode_main_window_state(main_window_state_to_value(&state).expect("state encodes"))
                .expect("state decodes"),
            state
        );
        assert_eq!(
            main_window_state_to_value(&state).expect("state encodes"),
            json!({
                "width": 1280,
                "height": 900,
                "x": null,
                "y": null,
                "maximized": true,
                "fullscreen": false,
            })
        );
        assert!(decode_main_window_state(json!({ "width": "wide" })).is_err());
    }

    #[test]
    fn mock_window_exercises_menu_capture_and_restore_helpers() {
        use crate::config::IsolatedTestDataRoot;
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let temp = tempfile::tempdir().expect("isolated desktop data root");
        let mut context = mock_context(noop_assets());
        context.config_mut().identifier =
            format!("com.bibcode.window-tests-{}", std::process::id());
        let app = mock_builder()
            .manage(IsolatedTestDataRoot::new(temp.path().join("data-root")))
            .build(context)
            .expect("mock Tauri app");
        let handle = app.handle();
        let window = tauri::WebviewWindowBuilder::new(&app, MAIN_WINDOW_LABEL, Default::default())
            .build()
            .expect("mock webview");
        let state_path = window_state_path(handle).expect("window state path should resolve");

        persist_main_window_state(handle).expect("empty mock state should be ignored");
        restore_main_window_state(handle).expect("missing state should be ignored");
        write_json_file(
            &state_path,
            &json!({
                "width": 10,
                "height": 10,
                "x": null,
                "y": null,
                "maximized": false,
                "fullscreen": false,
            }),
        )
        .expect("invalid state fixture should write");
        restore_main_window_state(handle).expect("invalid state should be ignored");

        assert!(
            window_state_path(handle)
                .expect("window state path should resolve")
                .ends_with(WINDOW_STATE_FILE_NAME)
        );

        apply_main_window_state(
            &window,
            &MainWindowState {
                width: 900,
                height: 700,
                x: Some(25),
                y: Some(35),
                maximized: false,
                fullscreen: false,
            },
        );
        assert_eq!(
            capture_main_window_state(&window).expect("window state should read"),
            None
        );

        apply_main_window_state(
            &window,
            &MainWindowState {
                width: 1000,
                height: 800,
                x: None,
                y: None,
                maximized: true,
                fullscreen: false,
            },
        );

        apply_main_window_state(
            &window,
            &MainWindowState {
                width: 1000,
                height: 800,
                x: None,
                y: None,
                maximized: false,
                fullscreen: true,
            },
        );
        let _ = std::fs::remove_file(state_path);
    }
}
