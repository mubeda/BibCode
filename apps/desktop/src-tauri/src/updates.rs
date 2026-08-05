use std::{sync::Mutex, time::Duration};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::config::{app_version, runtime_info};

const UPDATE_STATE_EVENT: &str = "desktop:update-state";
const STATUS_DISABLED: &str = "disabled";
const STATUS_IDLE: &str = "idle";
const STATUS_CHECKING: &str = "checking";
const STATUS_UP_TO_DATE: &str = "up-to-date";
const STATUS_AVAILABLE: &str = "available";
const STATUS_DOWNLOADING: &str = "downloading";
const STATUS_DOWNLOADED: &str = "downloaded";
const STATUS_ERROR: &str = "error";
const STARTUP_UPDATE_CHECK_DELAY: Duration = Duration::from_secs(15);
const BACKGROUND_UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);

struct DownloadedUpdate {
    update: Update,
    version: String,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct DesktopUpdateInner {
    available_update: Option<Update>,
    available_version: Option<String>,
    downloaded_update: Option<DownloadedUpdate>,
    downloaded_version: Option<String>,
    status: Option<String>,
    download_percent: Option<f64>,
    checked_at: Option<String>,
    message: Option<String>,
    error_context: Option<&'static str>,
    can_retry: bool,
    check_in_flight: bool,
    download_in_flight: bool,
}

#[derive(Default)]
pub struct DesktopUpdateManager {
    inner: Mutex<DesktopUpdateInner>,
    #[cfg(test)]
    check_attempts: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    background_check_completions: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    background_check_completion: tokio::sync::Notify,
}

#[derive(Clone, Copy)]
enum UpdateOperation {
    Check,
    Download,
}

struct UpdateOperationGuard<'a, R: Runtime> {
    manager: &'a DesktopUpdateManager,
    app: AppHandle<R>,
    operation: UpdateOperation,
    prior_state: DesktopUpdateInner,
    armed: bool,
}

impl<R: Runtime> UpdateOperationGuard<'_, R> {
    fn finish(mut self, update: impl FnOnce(&mut DesktopUpdateInner)) -> DesktopUpdateInner {
        let state = {
            let mut inner = self
                .manager
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            update(&mut inner);
            self.operation.clear_in_flight(&mut inner);
            inner.clone_without_updates()
        };
        self.armed = false;
        state
    }
}

impl<R: Runtime> Drop for UpdateOperationGuard<'_, R> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let state = {
            let mut inner = self
                .manager
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.operation.clear_in_flight(&mut inner);
            inner.restore_visible_state(&self.prior_state);
            inner.clone_without_updates()
        };
        state.emit(&self.app);
    }
}

impl UpdateOperation {
    fn clear_in_flight(self, inner: &mut DesktopUpdateInner) {
        match self {
            Self::Check => inner.check_in_flight = false,
            Self::Download => inner.download_in_flight = false,
        }
    }
}

impl DesktopUpdateManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state<R: Runtime>(&self, app: &AppHandle<R>) -> Value {
        let inner = self.inner.lock().expect("desktop update mutex poisoned");
        match app.updater() {
            Ok(_) => update_state_value(app, true, &inner),
            Err(error) if is_updater_disabled(&error) => disabled_update_state(app),
            Err(error) => error_update_state(app, "check", error.to_string()),
        }
    }

    pub async fn check_for_update<R: Runtime>(&self, app: AppHandle<R>) -> Value {
        #[cfg(test)]
        self.check_attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        let busy_state = {
            let inner = self.inner.lock().expect("desktop update mutex poisoned");
            (!can_begin_check(&inner)).then(|| update_state_value(&app, true, &inner))
        };
        if let Some(state) = busy_state {
            return json!({
                "checked": false,
                "state": state,
            });
        }

        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(error) if is_updater_disabled(&error) => {
                return disabled_update_check_result(disabled_update_state(&app));
            }
            Err(error) => {
                let state = self.record_error_state(&app, "check", error.to_string());
                return json!({
                    "checked": false,
                    "state": state,
                });
            }
        };

        let (check_guard, state) = match self.begin_check(&app) {
            Some(admission) => admission,
            None => {
                return json!({
                    "checked": false,
                    "state": self.current_state(&app),
                });
            }
        };
        state.emit(&app);

        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let checked_at = now_rfc3339();
                let state = check_guard.finish(|inner| {
                    inner.available_version = Some(version.clone());
                    inner.available_update = Some(update);
                    inner.downloaded_update = None;
                    inner.downloaded_version = None;
                    inner.download_percent = None;
                    inner.status = Some(STATUS_AVAILABLE.to_string());
                    inner.checked_at = Some(checked_at);
                    inner.message = None;
                    inner.error_context = None;
                    inner.can_retry = false;
                });
                let update_state = state.emit(&app);
                json!({
                    "checked": true,
                    "state": update_state,
                })
            }
            Ok(None) => {
                let checked_at = now_rfc3339();
                let state = check_guard.finish(|inner| {
                    inner.available_update = None;
                    inner.available_version = None;
                    inner.downloaded_update = None;
                    inner.downloaded_version = None;
                    inner.download_percent = None;
                    inner.status = Some(STATUS_UP_TO_DATE.to_string());
                    inner.checked_at = Some(checked_at);
                    inner.message = None;
                    inner.error_context = None;
                    inner.can_retry = false;
                });
                let update_state = state.emit(&app);
                json!({
                    "checked": true,
                    "state": update_state,
                })
            }
            Err(error) => {
                let message = error.to_string();
                let state = check_guard.finish(|inner| {
                    inner.status = Some(STATUS_ERROR.to_string());
                    inner.message = Some(message);
                    inner.error_context = Some("check");
                    inner.can_retry = true;
                });
                let state = state.emit(&app);
                json!({
                    "checked": false,
                    "state": state,
                })
            }
        }
    }

    pub async fn download_update<R: Runtime>(&self, app: AppHandle<R>) -> Value {
        let busy_state = {
            let inner = self.inner.lock().expect("desktop update mutex poisoned");
            (!can_begin_download(&inner)).then(|| update_state_value(&app, true, &inner))
        };
        if let Some(state) = busy_state {
            return json!({
                "accepted": false,
                "completed": false,
                "state": state,
            });
        }

        if let Err(error) = app.updater() {
            if is_updater_disabled(&error) {
                return disabled_update_action_result(disabled_update_state(&app));
            }
            let state = self.record_error_state(&app, "download", error.to_string());
            return json!({
                "accepted": false,
                "completed": false,
                "state": state,
            });
        }

        let (update, download_guard, state) = {
            let mut inner = self.inner.lock().expect("desktop update mutex poisoned");
            if !can_begin_download(&inner) {
                return json!({
                    "accepted": false,
                    "completed": false,
                    "state": update_state_value(&app, true, &inner),
                });
            }
            let Some(update) = inner.available_update.clone() else {
                drop(inner);
                let state = self.record_error_state(
                    &app,
                    "download",
                    "No checked update is available to download.".to_string(),
                );
                return json!({
                    "accepted": false,
                    "completed": false,
                    "state": state,
                });
            };
            let prior_state = inner.clone_without_updates();
            inner.download_in_flight = true;
            inner.status = Some(STATUS_DOWNLOADING.to_string());
            inner.download_percent = Some(0.0);
            inner.message = None;
            inner.error_context = None;
            inner.can_retry = false;
            let state = inner.clone_without_updates();
            let guard = UpdateOperationGuard {
                manager: self,
                app: app.clone(),
                operation: UpdateOperation::Download,
                prior_state,
                armed: true,
            };
            (update, guard, state)
        };

        let version = update.version.clone();
        state.emit(&app);
        let mut downloaded_bytes = 0_u64;
        let progress_app = app.clone();
        let bytes = update
            .download(
                |chunk_length, content_length| {
                    downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
                    if let Some(total_bytes) = content_length.filter(|value| *value > 0) {
                        let percent = ((downloaded_bytes as f64 / total_bytes as f64) * 100.0)
                            .clamp(0.0, 100.0);
                        self.replace_inner(|inner| {
                            inner.download_percent = Some(percent);
                        })
                        .emit(&progress_app);
                    }
                },
                || {},
            )
            .await;

        match bytes {
            Ok(bytes) => {
                let state = download_guard.finish(|inner| {
                    inner.downloaded_update = Some(DownloadedUpdate {
                        update,
                        version: version.clone(),
                        bytes,
                    });
                    inner.downloaded_version = Some(version);
                    inner.status = Some(STATUS_DOWNLOADED.to_string());
                    inner.download_percent = Some(100.0);
                    inner.message = None;
                    inner.error_context = None;
                    inner.can_retry = false;
                });
                let update_state = state.emit(&app);
                json!({
                    "accepted": true,
                    "completed": true,
                    "state": update_state,
                })
            }
            Err(error) => {
                let message = error.to_string();
                let state = download_guard.finish(|inner| {
                    inner.status = Some(STATUS_ERROR.to_string());
                    inner.message = Some(message);
                    inner.error_context = Some("download");
                    inner.can_retry = true;
                });
                let state = state.emit(&app);
                json!({
                    "accepted": true,
                    "completed": false,
                    "state": state,
                })
            }
        }
    }

    pub fn install_update<R: Runtime>(&self, app: &AppHandle<R>) -> Value {
        if let Err(error) = app.updater() {
            if is_updater_disabled(&error) {
                return disabled_update_action_result(disabled_update_state(app));
            }
            let state = self.record_error_state(app, "install", error.to_string());
            return json!({
                "accepted": false,
                "completed": false,
                "state": state,
            });
        }

        let downloaded = self
            .inner
            .lock()
            .expect("desktop update mutex poisoned")
            .downloaded_update
            .take();

        let Some(downloaded) = downloaded else {
            let state = self.record_error_state(
                app,
                "install",
                "No downloaded update is available to install.".to_string(),
            );
            return json!({
                "accepted": false,
                "completed": false,
                "state": state,
            });
        };

        match downloaded.update.install(&downloaded.bytes) {
            Ok(()) => {
                let state = self.replace_inner(|inner| {
                    inner.status = Some(STATUS_DOWNLOADED.to_string());
                    inner.downloaded_version = Some(downloaded.version);
                    inner.download_percent = Some(100.0);
                    inner.message = None;
                    inner.error_context = None;
                    inner.can_retry = false;
                });
                let update_state = state.emit(app);
                let result = json!({
                    "accepted": true,
                    "completed": true,
                    "state": update_state,
                });
                if restart_required_after_install(std::env::consts::OS) {
                    app.restart();
                }
                result
            }
            Err(error) => {
                let state = self.record_error_state(app, "install", error.to_string());
                json!({
                    "accepted": true,
                    "completed": false,
                    "state": state,
                })
            }
        }
    }

    fn replace_inner(&self, update: impl FnOnce(&mut DesktopUpdateInner)) -> DesktopUpdateInner {
        let mut inner = self.inner.lock().expect("desktop update mutex poisoned");
        update(&mut inner);
        inner.clone_without_updates()
    }

    fn begin_check<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Option<(UpdateOperationGuard<'_, R>, DesktopUpdateInner)> {
        let mut inner = self.inner.lock().expect("desktop update mutex poisoned");
        if !can_begin_check(&inner) {
            return None;
        }
        let prior_state = inner.clone_without_updates();
        inner.check_in_flight = true;
        inner.status = Some(STATUS_CHECKING.to_string());
        inner.message = None;
        inner.error_context = None;
        inner.can_retry = false;
        let state = inner.clone_without_updates();
        Some((
            UpdateOperationGuard {
                manager: self,
                app: app.clone(),
                operation: UpdateOperation::Check,
                prior_state,
                armed: true,
            },
            state,
        ))
    }

    fn current_state<R: Runtime>(&self, app: &AppHandle<R>) -> Value {
        let inner = self.inner.lock().expect("desktop update mutex poisoned");
        update_state_value(app, true, &inner)
    }

    fn record_error_state<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        context: &'static str,
        message: String,
    ) -> Value {
        let state = self.replace_inner(|inner| {
            inner.status = Some(STATUS_ERROR.to_string());
            inner.message = Some(message);
            inner.error_context = Some(context);
            inner.can_retry = true;
        });
        state.emit(app)
    }
}

impl DesktopUpdateInner {
    fn emit<R: Runtime>(&self, app: &AppHandle<R>) -> Value {
        let state = update_state_value(app, true, self);
        emit_update_state(app, &state);
        state
    }

    fn clone_without_updates(&self) -> DesktopUpdateInner {
        DesktopUpdateInner {
            available_update: None,
            available_version: self.available_version.clone(),
            downloaded_update: None,
            downloaded_version: self.downloaded_version.clone(),
            status: self.status.clone(),
            download_percent: self.download_percent,
            checked_at: self.checked_at.clone(),
            message: self.message.clone(),
            error_context: self.error_context,
            can_retry: self.can_retry,
            check_in_flight: false,
            download_in_flight: false,
        }
    }

    fn restore_visible_state(&mut self, prior_state: &DesktopUpdateInner) {
        self.available_version = prior_state.available_version.clone();
        self.downloaded_version = prior_state.downloaded_version.clone();
        self.status = prior_state.status.clone();
        self.download_percent = prior_state.download_percent;
        self.checked_at = prior_state.checked_at.clone();
        self.message = prior_state.message.clone();
        self.error_context = prior_state.error_context;
        self.can_retry = prior_state.can_retry;
    }
}

fn can_begin_check(inner: &DesktopUpdateInner) -> bool {
    !inner.check_in_flight
        && !inner.download_in_flight
        && !matches!(
            inner.status.as_deref(),
            Some(STATUS_DOWNLOADING | STATUS_DOWNLOADED)
        )
}

fn can_begin_download(inner: &DesktopUpdateInner) -> bool {
    !inner.check_in_flight
        && !inner.download_in_flight
        && !matches!(
            inner.status.as_deref(),
            Some(STATUS_DOWNLOADING | STATUS_DOWNLOADED)
        )
}

pub async fn run_background_update_checks<R: Runtime>(app: AppHandle<R>) {
    tokio::time::sleep(STARTUP_UPDATE_CHECK_DELAY).await;
    loop {
        match run_isolated_background_check(app.clone()).await {
            Ok(result) if result["state"]["errorContext"] == "check" => {
                tracing::warn!(
                    "background update check failed: {}",
                    result["state"]["message"]
                        .as_str()
                        .unwrap_or("unknown error")
                );
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!("background update check task failed: {error}");
            }
        }
        #[cfg(test)]
        app.state::<DesktopUpdateManager>()
            .background_check_completions
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        #[cfg(test)]
        app.state::<DesktopUpdateManager>()
            .background_check_completion
            .notify_one();
        tokio::time::sleep(BACKGROUND_UPDATE_CHECK_INTERVAL).await;
    }
}

async fn run_isolated_background_check<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Value, tauri::Error> {
    tauri::async_runtime::spawn(async move {
        app.state::<DesktopUpdateManager>()
            .check_for_update(app.clone())
            .await
    })
    .await
}

fn is_updater_disabled(error: &UpdaterError) -> bool {
    matches!(error, UpdaterError::EmptyEndpoints)
}

fn restart_required_after_install(target_os: &str) -> bool {
    matches!(target_os, "linux" | "macos")
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn emit_update_state<R: Runtime>(app: &AppHandle<R>, state: &Value) {
    if let Err(error) = app.emit(UPDATE_STATE_EVENT, state.clone()) {
        tracing::debug!("failed to emit Tauri update state event: {error}");
    }
}

pub fn disabled_update_state<R: Runtime>(app: &AppHandle<R>) -> Value {
    let runtime = runtime_info();
    json!({
        "enabled": false,
        "status": STATUS_DISABLED,
        "currentVersion": app_version(app),
        "hostArch": runtime["hostArch"].clone(),
        "appArch": runtime["appArch"].clone(),
        "runningUnderArm64Translation": runtime["runningUnderArm64Translation"].clone(),
        "availableVersion": null,
        "downloadedVersion": null,
        "downloadPercent": null,
        "checkedAt": null,
        "message": null,
        "errorContext": null,
        "canRetry": false,
    })
}

fn error_update_state<R: Runtime>(
    app: &AppHandle<R>,
    context: &'static str,
    message: String,
) -> Value {
    let runtime = runtime_info();
    json!({
        "enabled": true,
        "status": STATUS_ERROR,
        "currentVersion": app_version(app),
        "hostArch": runtime["hostArch"].clone(),
        "appArch": runtime["appArch"].clone(),
        "runningUnderArm64Translation": runtime["runningUnderArm64Translation"].clone(),
        "availableVersion": null,
        "downloadedVersion": null,
        "downloadPercent": null,
        "checkedAt": null,
        "message": message,
        "errorContext": context,
        "canRetry": true,
    })
}

fn update_state_value<R: Runtime>(
    app: &AppHandle<R>,
    enabled: bool,
    inner: &DesktopUpdateInner,
) -> Value {
    let runtime = runtime_info();
    json!({
        "enabled": enabled,
        "status": inner.status.as_deref().unwrap_or(STATUS_IDLE),
        "currentVersion": app_version(app),
        "hostArch": runtime["hostArch"].clone(),
        "appArch": runtime["appArch"].clone(),
        "runningUnderArm64Translation": runtime["runningUnderArm64Translation"].clone(),
        "availableVersion": inner.available_version,
        "downloadedVersion": inner.downloaded_version,
        "downloadPercent": inner.download_percent,
        "checkedAt": inner.checked_at,
        "message": inner.message,
        "errorContext": inner.error_context,
        "canRetry": inner.can_retry,
    })
}

pub fn disabled_update_check_result(state: Value) -> Value {
    json!({
        "checked": false,
        "state": state,
    })
}

pub fn disabled_update_action_result(state: Value) -> Value {
    json!({
        "accepted": false,
        "completed": false,
        "state": state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        thread,
        time::Duration,
    };
    use tauri::{
        Manager,
        test::{MockRuntime, mock_builder, mock_context, noop_assets},
    };

    const TEST_PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const TEST_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

    fn assert_request_read(stream: &mut std::net::TcpStream, message: &str) {
        let mut request = [0_u8; 2048];
        assert!(stream.read(&mut request).expect(message) > 0, "{message}");
    }

    fn updater_test_app(endpoint: String) -> tauri::App<MockRuntime> {
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".to_owned(),
            serde_json::json!({
                "pubkey": STANDARD.encode(TEST_PUBLIC_KEY),
                "endpoints": [endpoint],
                "dangerousInsecureTransportProtocol": true,
                "windows": null,
            }),
        );
        mock_builder()
            .manage(DesktopUpdateManager::new())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .expect("mock Tauri app")
    }

    fn updater_test_app_with_request_counter(
        requests: Arc<AtomicUsize>,
    ) -> tauri::App<MockRuntime> {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("update request should arrive");
                let mut request = [0_u8; 2048];
                let request_len = stream
                    .read(&mut request)
                    .expect("update request should read");
                assert!(request_len > 0, "update request should not be empty");
                requests.fetch_add(1, Ordering::SeqCst);
                stream
                    .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                    .expect("update response should write");
            }
        });
        updater_test_app(format!("{base_url}/latest.json"))
    }

    fn spawn_update_server(payload: &'static str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let manifest = serde_json::json!({
            "version": "99.0.0",
            "notes": "Coverage update",
            "pub_date": "2026-07-16T00:00:00Z",
            "url": format!("{base_url}/artifact"),
            "signature": STANDARD.encode(TEST_SIGNATURE),
        })
        .to_string();
        let thread = thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("update request should arrive");
                let mut request = [0_u8; 2048];
                let read = stream
                    .read(&mut request)
                    .expect("update request should read");
                let request = String::from_utf8_lossy(&request[..read]);
                let (content_type, body) = if request.starts_with("GET /artifact ") {
                    ("application/octet-stream", payload.to_owned())
                } else {
                    ("application/json", manifest.clone())
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .expect("update response should write");
            }
        });
        (base_url, thread)
    }

    fn spawn_no_update_server() -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let thread = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("update request should arrive");
            let mut request = [0_u8; 2048];
            let request_len = stream
                .read(&mut request)
                .expect("update request should read");
            assert!(request_len > 0, "update request should not be empty");
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .expect("update response should write");
        });
        (base_url, thread)
    }

    async fn wait_for_test_signal(receiver: &mpsc::Receiver<()>, description: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match receiver.try_recv() {
                    Ok(()) => return,
                    Err(mpsc::TryRecvError::Empty) => tokio::task::yield_now().await,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        panic!("{description}: signal sender disconnected")
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {description}"));
    }

    async fn wait_for_background_check_completion(manager: &DesktopUpdateManager, expected: usize) {
        while manager.background_check_completions.load(Ordering::SeqCst) < expected {
            manager.background_check_completion.notified().await;
        }
    }

    #[test]
    fn disabled_update_results_preserve_bridge_shapes() {
        let state = serde_json::json!({
            "status": "disabled"
        });

        assert_eq!(
            disabled_update_check_result(state.clone()),
            serde_json::json!({
                "checked": false,
                "state": state.clone(),
            })
        );
        assert_eq!(
            disabled_update_action_result(state.clone()),
            serde_json::json!({
                "accepted": false,
                "completed": false,
                "state": state,
            })
        );
    }

    #[test]
    fn successful_install_restarts_only_non_windows_platforms() {
        assert!(restart_required_after_install("macos"));
        assert!(restart_required_after_install("linux"));
        assert!(!restart_required_after_install("windows"));
    }

    #[test]
    fn manager_state_helpers_clone_metadata_without_runtime_updates() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".to_owned(),
            serde_json::json!({"pubkey":"","windows":null}),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .expect("mock Tauri app");
        let handle = app.handle();
        let manager = DesktopUpdateManager::new();
        let snapshot = manager.replace_inner(|inner| {
            inner.available_version = Some("2.0.0".to_string());
            inner.downloaded_version = Some("1.9.0".to_string());
            inner.status = Some(STATUS_AVAILABLE.to_string());
            inner.download_percent = Some(25.0);
            inner.checked_at = Some(now_rfc3339());
        });

        assert_eq!(snapshot.available_version.as_deref(), Some("2.0.0"));
        assert_eq!(snapshot.downloaded_version.as_deref(), Some("1.9.0"));
        assert_eq!(snapshot.status.as_deref(), Some(STATUS_AVAILABLE));
        assert_eq!(snapshot.download_percent, Some(25.0));
        assert!(
            snapshot
                .checked_at
                .as_deref()
                .is_some_and(|value| value.contains('T'))
        );
        assert!(is_updater_disabled(&UpdaterError::EmptyEndpoints));
        assert_eq!(disabled_update_state(handle)["status"], STATUS_DISABLED);
        assert!(disabled_update_state(handle).get("channel").is_none());
        assert_eq!(
            error_update_state(handle, "check", "failed".to_owned())["errorContext"],
            "check"
        );
        assert_eq!(
            update_state_value(handle, true, &snapshot)["availableVersion"],
            "2.0.0"
        );
        assert_eq!(
            manager.record_error_state(handle, "install", "failed".to_owned())["errorContext"],
            "install"
        );
        assert_eq!(manager.state(handle)["status"], STATUS_DISABLED);

        tauri::async_runtime::block_on(async {
            assert_eq!(
                manager.check_for_update(handle.clone()).await["checked"],
                false
            );
            assert_eq!(
                manager.download_update(handle.clone()).await["accepted"],
                false
            );
        });
        assert_eq!(manager.install_update(handle)["accepted"], false);
    }

    #[tokio::test]
    async fn manager_checks_downloads_and_rejects_an_invalid_installer() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let (base_url, server) = spawn_update_server("test");
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".to_owned(),
            serde_json::json!({
                "pubkey": STANDARD.encode(TEST_PUBLIC_KEY),
                "endpoints": [format!("{base_url}/latest.json")],
                "dangerousInsecureTransportProtocol": true,
                "windows": null,
            }),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .expect("mock Tauri app");
        let handle = app.handle();
        let manager = DesktopUpdateManager::new();

        let check = manager.check_for_update(handle.clone()).await;
        assert_eq!(check["checked"], true);
        assert_eq!(check["state"]["status"], STATUS_AVAILABLE);
        assert_eq!(check["state"]["availableVersion"], "99.0.0");

        let download = manager.download_update(handle.clone()).await;
        assert_eq!(download["accepted"], true);
        assert_eq!(download["completed"], true);
        assert_eq!(download["state"]["status"], STATUS_DOWNLOADED);
        assert_eq!(download["state"]["downloadPercent"], 100.0);

        #[cfg(target_os = "macos")]
        {
            let install = manager.install_update(handle);
            assert_eq!(install["accepted"], true);
            assert_eq!(install["completed"], false);
            assert_eq!(install["state"]["status"], STATUS_ERROR);
            assert_eq!(install["state"]["errorContext"], "install");
        }

        server.join().expect("update server should stop");
    }

    #[tokio::test]
    async fn manager_handles_up_to_date_and_missing_update_actions() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let (base_url, server) = spawn_no_update_server();
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".to_owned(),
            serde_json::json!({
                "pubkey": STANDARD.encode(TEST_PUBLIC_KEY),
                "endpoints": [format!("{base_url}/latest.json")],
                "dangerousInsecureTransportProtocol": true,
                "windows": null,
            }),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .expect("mock Tauri app");
        let handle = app.handle();
        let manager = DesktopUpdateManager::new();

        let check = manager.check_for_update(handle.clone()).await;
        assert_eq!(check["checked"], true);
        assert_eq!(check["state"]["status"], STATUS_UP_TO_DATE);

        let download = manager.download_update(handle.clone()).await;
        assert_eq!(download["accepted"], false);
        assert_eq!(download["state"]["errorContext"], "download");

        let install = manager.install_update(handle);
        assert_eq!(install["accepted"], false);
        assert_eq!(install["state"]["errorContext"], "install");

        server.join().expect("update server should stop");
    }

    #[tokio::test]
    async fn manager_reports_download_signature_failures() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let (base_url, server) = spawn_update_server("tampered");
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".to_owned(),
            serde_json::json!({
                "pubkey": STANDARD.encode(TEST_PUBLIC_KEY),
                "endpoints": [format!("{base_url}/latest.json")],
                "dangerousInsecureTransportProtocol": true,
                "windows": null,
            }),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .expect("mock Tauri app");
        let handle = app.handle();
        let manager = DesktopUpdateManager::new();

        assert_eq!(
            manager.check_for_update(handle.clone()).await["checked"],
            true
        );
        let download = manager.download_update(handle.clone()).await;
        assert_eq!(download["accepted"], true);
        assert_eq!(download["completed"], false);
        assert_eq!(download["state"]["status"], STATUS_ERROR);
        assert_eq!(download["state"]["errorContext"], "download");

        server.join().expect("update server should stop");
    }

    #[tokio::test(start_paused = true)]
    async fn background_checks_wait_fifteen_seconds_then_thirty_minutes_after_completion() {
        let requests = Arc::new(AtomicUsize::new(0));
        let app = updater_test_app_with_request_counter(requests.clone());
        let task = tokio::spawn(run_background_update_checks(app.handle().clone()));

        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(14)).await;
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        tokio::time::advance(Duration::from_secs(1)).await;
        let manager = app.state::<DesktopUpdateManager>();
        wait_for_background_check_completion(&manager, 1).await;
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(manager.state(app.handle())["status"], STATUS_UP_TO_DATE);
        tokio::time::advance(Duration::from_secs(30 * 60 - 1)).await;
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        wait_for_background_check_completion(&manager, 2).await;
        assert_eq!(requests.load(Ordering::SeqCst), 2);

        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn background_scheduler_survives_a_panicking_check() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let requests = Arc::new(AtomicUsize::new(0));
        let server_requests = requests.clone();
        let (request_sender, request_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("retry check should arrive");
            assert_request_read(&mut stream, "retry check should read");
            server_requests.fetch_add(1, Ordering::SeqCst);
            request_sender
                .send(())
                .expect("test should observe the retry request");
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .expect("retry check should respond");
        });
        let app = updater_test_app(format!("{base_url}/latest.json"));
        let manager = app.state::<DesktopUpdateManager>();
        let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _inner = manager
                .inner
                .lock()
                .expect("desktop update mutex should initially lock");
            panic!("synthetic update-check panic");
        }));
        assert!(poison.is_err());
        assert!(manager.inner.is_poisoned());
        let task = tokio::spawn(run_background_update_checks(app.handle().clone()));
        tokio::task::yield_now().await;
        tokio::time::advance(STARTUP_UPDATE_CHECK_DELAY).await;
        let manager = app.state::<DesktopUpdateManager>();
        wait_for_background_check_completion(&manager, 1).await;
        assert_eq!(manager.check_attempts.load(Ordering::SeqCst), 1);
        assert_eq!(
            manager.background_check_completions.load(Ordering::SeqCst),
            1
        );
        manager.inner.clear_poison();
        tokio::task::yield_now().await;

        tokio::time::advance(BACKGROUND_UPDATE_CHECK_INTERVAL).await;
        let manager = app.state::<DesktopUpdateManager>();
        wait_for_background_check_completion(&manager, 2).await;
        assert_eq!(manager.check_attempts.load(Ordering::SeqCst), 2);
        request_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("surviving scheduler should issue a retry request");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        task.abort();
        server.join().expect("update server should stop");
    }

    #[tokio::test]
    async fn overlapping_manual_checks_share_one_request() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let requests = Arc::new(AtomicUsize::new(0));
        let server_requests = requests.clone();
        let (request_started_sender, request_started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("update request should arrive");
            assert_request_read(&mut stream, "update request should read");
            server_requests.fetch_add(1, Ordering::SeqCst);
            request_started_sender
                .send(())
                .expect("test should observe the update request");
            release_receiver
                .recv()
                .expect("test should release update response");
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .expect("update response should write");
        });
        let app = updater_test_app(format!("{base_url}/latest.json"));
        let manager = Arc::new(DesktopUpdateManager::new());
        let first_manager = manager.clone();
        let first_handle = app.handle().clone();
        let first = tokio::spawn(async move { first_manager.check_for_update(first_handle).await });

        wait_for_test_signal(
            &request_started_receiver,
            "update request should become active",
        )
        .await;
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let second = tokio::time::timeout(
            Duration::from_millis(100),
            manager.check_for_update(app.handle().clone()),
        )
        .await;
        release_sender
            .send(())
            .expect("server should still await its response");
        let first = first.await.expect("first check should complete");
        server.join().expect("update server should stop");

        let second = second.expect("overlapping check should return without another request");
        assert_eq!(first["checked"], true);
        assert_eq!(second["checked"], false);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn check_while_downloading_returns_current_state_without_checking() {
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".to_owned(),
            serde_json::json!({"pubkey":"","windows":null}),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .expect("mock Tauri app");
        let manager = DesktopUpdateManager::new();
        manager.replace_inner(|inner| {
            inner.available_version = Some("99.0.0".to_owned());
            inner.status = Some(STATUS_DOWNLOADING.to_owned());
            inner.download_percent = Some(50.0);
        });

        let check = manager.check_for_update(app.handle().clone()).await;

        assert_eq!(check["checked"], false);
        assert_eq!(check["state"]["status"], STATUS_DOWNLOADING);
        assert_eq!(check["state"]["availableVersion"], "99.0.0");
        assert_eq!(check["state"]["downloadPercent"], 50.0);
    }

    #[tokio::test]
    async fn check_while_downloaded_preserves_downloaded_version_and_bytes() {
        let (base_url, server) = spawn_update_server("test");
        let app = updater_test_app(format!("{base_url}/latest.json"));
        let manager = DesktopUpdateManager::new();

        assert_eq!(
            manager.check_for_update(app.handle().clone()).await["checked"],
            true
        );
        assert_eq!(
            manager.download_update(app.handle().clone()).await["completed"],
            true
        );
        let downloaded_bytes = manager
            .inner
            .lock()
            .expect("desktop update mutex should lock")
            .downloaded_update
            .as_ref()
            .expect("downloaded update should remain available")
            .bytes
            .clone();

        let check = manager.check_for_update(app.handle().clone()).await;

        let inner = manager
            .inner
            .lock()
            .expect("desktop update mutex should lock");
        assert_eq!(check["checked"], false);
        assert_eq!(check["state"]["status"], STATUS_DOWNLOADED);
        assert_eq!(check["state"]["downloadedVersion"], "99.0.0");
        assert_eq!(
            inner
                .downloaded_update
                .as_ref()
                .expect("skipped check must retain downloaded update")
                .bytes,
            downloaded_bytes
        );
        drop(inner);
        server.join().expect("update server should stop");
    }

    #[tokio::test]
    async fn failed_check_allows_an_immediate_manual_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let requests = Arc::new(AtomicUsize::new(0));
        let server_requests = requests.clone();
        let server = thread::spawn(move || {
            for response in [
                b"HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n".as_slice(),
                b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".as_slice(),
            ] {
                let (mut stream, _) = listener.accept().expect("update request should arrive");
                assert_request_read(&mut stream, "update request should read");
                server_requests.fetch_add(1, Ordering::SeqCst);
                stream
                    .write_all(response)
                    .expect("update response should write");
            }
        });
        let app = updater_test_app(format!("{base_url}/latest.json"));
        let manager = DesktopUpdateManager::new();

        let failed = manager.check_for_update(app.handle().clone()).await;
        let retry = manager.check_for_update(app.handle().clone()).await;

        assert_eq!(failed["checked"], false);
        assert_eq!(failed["state"]["status"], STATUS_ERROR);
        assert_eq!(retry["checked"], true);
        assert_eq!(retry["state"]["status"], STATUS_UP_TO_DATE);
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        server.join().expect("update server should stop");
    }

    #[tokio::test(start_paused = true)]
    async fn background_checks_only_inspect_available_updates() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let manifest = serde_json::json!({
            "version": "99.0.0",
            "notes": "Coverage update",
            "pub_date": "2026-07-16T00:00:00Z",
            "url": format!("{base_url}/artifact"),
            "signature": STANDARD.encode(TEST_SIGNATURE),
        })
        .to_string();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("update request should arrive");
            assert_request_read(&mut stream, "update request should read");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}",
                manifest.len()
            )
            .expect("update response should write");
        });
        let app = updater_test_app(format!("{base_url}/latest.json"));
        let task = tokio::spawn(run_background_update_checks(app.handle().clone()));

        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(15)).await;
        let manager = app.state::<DesktopUpdateManager>();
        wait_for_background_check_completion(&manager, 1).await;
        let state = manager.state(app.handle());

        assert_eq!(state["status"], STATUS_AVAILABLE);
        assert_eq!(state["downloadedVersion"], Value::Null);
        task.abort();
        server
            .join()
            .expect("background checks must not request the artifact");
    }

    #[tokio::test]
    async fn download_is_rejected_while_a_real_check_is_in_flight() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let manifest = serde_json::json!({
            "version": "99.0.0",
            "notes": "Coverage update",
            "pub_date": "2026-07-16T00:00:00Z",
            "url": format!("{base_url}/artifact"),
            "signature": STANDARD.encode(TEST_SIGNATURE),
        })
        .to_string();
        let (check_started_sender, check_started_receiver) = mpsc::channel();
        let (release_check_sender, release_check_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("initial check should arrive");
            assert_request_read(&mut stream, "initial check should read");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}",
                manifest.len()
            )
            .expect("initial check should respond");

            let (mut stream, _) = listener.accept().expect("overlapping check should arrive");
            assert_request_read(&mut stream, "overlapping check should read");
            check_started_sender
                .send(())
                .expect("test should observe the in-flight check");
            release_check_receiver
                .recv()
                .expect("test should release the check");
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .expect("overlapping check should respond");
        });
        let app = updater_test_app(format!("{base_url}/latest.json"));
        let manager = Arc::new(DesktopUpdateManager::new());

        assert_eq!(
            manager.check_for_update(app.handle().clone()).await["checked"],
            true
        );
        let check_manager = manager.clone();
        let check_handle = app.handle().clone();
        let check = tokio::spawn(async move { check_manager.check_for_update(check_handle).await });
        wait_for_test_signal(
            &check_started_receiver,
            "second check should become in flight",
        )
        .await;

        let download = tokio::time::timeout(
            Duration::from_millis(100),
            manager.download_update(app.handle().clone()),
        )
        .await;
        release_check_sender
            .send(())
            .expect("server should still await the check release");
        let check = check.await.expect("check should complete");
        server.join().expect("update server should stop");

        let download = download.expect("download should defer while a check is in flight");
        assert_eq!(download["accepted"], false);
        assert_eq!(download["completed"], false);
        assert_eq!(download["state"]["status"], STATUS_CHECKING);
        assert_eq!(check["checked"], true);
    }

    #[tokio::test]
    async fn real_download_admission_makes_an_overlapping_check_skip_network_io() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let manifest = serde_json::json!({
            "version": "99.0.0",
            "notes": "Coverage update",
            "pub_date": "2026-07-16T00:00:00Z",
            "url": format!("{base_url}/artifact"),
            "signature": STANDARD.encode(TEST_SIGNATURE),
        })
        .to_string();
        let (download_started_sender, download_started_receiver) = mpsc::channel();
        let (release_download_sender, release_download_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("initial check should arrive");
            assert_request_read(&mut stream, "initial check should read");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}",
                manifest.len()
            )
            .expect("initial check should respond");

            let (mut stream, _) = listener.accept().expect("download should request artifact");
            assert_request_read(&mut stream, "download should read");
            download_started_sender
                .send(())
                .expect("test should observe download admission");
            release_download_receiver
                .recv()
                .expect("test should release the artifact");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest")
                .expect("download should respond");
        });
        let app = updater_test_app(format!("{base_url}/latest.json"));
        let manager = Arc::new(DesktopUpdateManager::new());

        assert_eq!(
            manager.check_for_update(app.handle().clone()).await["checked"],
            true
        );
        let download_manager = manager.clone();
        let download_handle = app.handle().clone();
        let download =
            tokio::spawn(async move { download_manager.download_update(download_handle).await });
        wait_for_test_signal(&download_started_receiver, "download should become active").await;

        let check = manager.check_for_update(app.handle().clone()).await;
        release_download_sender
            .send(())
            .expect("server should still await the artifact release");
        let download = download.await.expect("download should complete");
        server.join().expect("update server should stop");

        assert_eq!(check["checked"], false);
        assert_eq!(check["state"]["status"], STATUS_DOWNLOADING);
        assert_eq!(download["accepted"], true);
        assert_eq!(download["completed"], true);
    }

    #[tokio::test]
    async fn overlapping_download_returns_busy_without_starting_another_request() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let manifest = serde_json::json!({
            "version": "99.0.0",
            "notes": "Coverage update",
            "pub_date": "2026-07-16T00:00:00Z",
            "url": format!("{base_url}/artifact"),
            "signature": STANDARD.encode(TEST_SIGNATURE),
        })
        .to_string();
        let artifact_requests = Arc::new(AtomicUsize::new(0));
        let server_artifact_requests = artifact_requests.clone();
        let (download_started_sender, download_started_receiver) = mpsc::channel();
        let (release_download_sender, release_download_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("initial check should arrive");
            assert_request_read(&mut stream, "initial check should read");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}",
                manifest.len()
            )
            .expect("initial check should respond");

            let (mut stream, _) = listener.accept().expect("download should request artifact");
            assert_request_read(&mut stream, "download should read");
            server_artifact_requests.fetch_add(1, Ordering::SeqCst);
            download_started_sender
                .send(())
                .expect("test should observe download admission");
            release_download_receiver
                .recv()
                .expect("test should release the artifact");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest")
                .expect("download should respond");
        });
        let app = updater_test_app(format!("{base_url}/latest.json"));
        let manager = Arc::new(DesktopUpdateManager::new());
        assert_eq!(
            manager.check_for_update(app.handle().clone()).await["checked"],
            true
        );

        let first_manager = manager.clone();
        let first_handle = app.handle().clone();
        let first = tokio::spawn(async move { first_manager.download_update(first_handle).await });
        wait_for_test_signal(&download_started_receiver, "download should become active").await;

        let second = tokio::time::timeout(
            Duration::from_millis(100),
            manager.download_update(app.handle().clone()),
        )
        .await;
        release_download_sender
            .send(())
            .expect("server should still await the artifact release");
        let first = first.await.expect("first download should complete");
        server.join().expect("update server should stop");

        let second = second.expect("overlapping download should return immediately");
        assert_eq!(second["accepted"], false);
        assert_eq!(second["completed"], false);
        assert_eq!(second["state"]["status"], STATUS_DOWNLOADING);
        assert_eq!(first["completed"], true);
        assert_eq!(artifact_requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn aborting_a_check_restores_idle_state_and_allows_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let (check_started_sender, check_started_receiver) = mpsc::channel();
        let (release_check_sender, release_check_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("first check should arrive");
            assert_request_read(&mut stream, "first check should read");
            check_started_sender
                .send(())
                .expect("test should observe the in-flight check");
            release_check_receiver
                .recv()
                .expect("test should release the first check");
            let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");

            let (mut stream, _) = listener.accept().expect("retry check should arrive");
            assert_request_read(&mut stream, "retry check should read");
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .expect("retry check should respond");
        });
        let app = updater_test_app(format!("{base_url}/latest.json"));
        let manager = Arc::new(DesktopUpdateManager::new());
        let check_manager = manager.clone();
        let check_handle = app.handle().clone();
        let check = tokio::spawn(async move { check_manager.check_for_update(check_handle).await });
        wait_for_test_signal(&check_started_receiver, "check should become active").await;

        check.abort();
        assert!(
            check
                .await
                .expect_err("check should be cancelled")
                .is_cancelled()
        );
        release_check_sender
            .send(())
            .expect("server should still await the check release");

        assert_eq!(manager.state(app.handle())["status"], STATUS_IDLE);
        let retry = manager.check_for_update(app.handle().clone()).await;
        assert_eq!(retry["checked"], true);
        assert_eq!(retry["state"]["status"], STATUS_UP_TO_DATE);
        server.join().expect("update server should stop");
    }

    #[tokio::test]
    async fn aborting_a_download_restores_available_state_and_allows_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("update server should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("update server address")
        );
        let manifest = serde_json::json!({
            "version": "99.0.0",
            "notes": "Coverage update",
            "pub_date": "2026-07-16T00:00:00Z",
            "url": format!("{base_url}/artifact"),
            "signature": STANDARD.encode(TEST_SIGNATURE),
        })
        .to_string();
        let (download_started_sender, download_started_receiver) = mpsc::channel();
        let (release_download_sender, release_download_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("initial check should arrive");
            assert_request_read(&mut stream, "initial check should read");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}",
                manifest.len()
            )
            .expect("initial check should respond");

            let (mut stream, _) = listener.accept().expect("first download should arrive");
            assert_request_read(&mut stream, "first download should read");
            download_started_sender
                .send(())
                .expect("test should observe download admission");
            release_download_receiver
                .recv()
                .expect("test should release the first download");
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest");

            let (mut stream, _) = listener.accept().expect("retry download should arrive");
            assert_request_read(&mut stream, "retry download should read");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest")
                .expect("retry download should respond");
        });
        let app = updater_test_app(format!("{base_url}/latest.json"));
        let manager = Arc::new(DesktopUpdateManager::new());
        assert_eq!(
            manager.check_for_update(app.handle().clone()).await["checked"],
            true
        );
        let download_manager = manager.clone();
        let download_handle = app.handle().clone();
        let download =
            tokio::spawn(async move { download_manager.download_update(download_handle).await });
        wait_for_test_signal(&download_started_receiver, "download should become active").await;

        download.abort();
        assert!(
            download
                .await
                .expect_err("download should be cancelled")
                .is_cancelled()
        );
        release_download_sender
            .send(())
            .expect("server should still await the download release");

        let restored = manager.state(app.handle());
        assert_eq!(restored["status"], STATUS_AVAILABLE);
        assert_eq!(restored["availableVersion"], "99.0.0");
        assert_eq!(restored["downloadPercent"], Value::Null);
        let retry = manager.download_update(app.handle().clone()).await;
        assert_eq!(retry["accepted"], true);
        assert_eq!(retry["completed"], true);
        server.join().expect("update server should stop");
    }
}
