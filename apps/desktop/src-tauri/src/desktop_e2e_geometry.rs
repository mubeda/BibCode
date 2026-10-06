//! Feature-gated qualification geometry. GTK objects never leave their main-thread callback.

use serde::{Deserialize, Serialize};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU8, Ordering},
};
use std::time::{Duration, Instant};

const OPERATION_LIMIT: Duration = Duration::from_millis(2000);
const PENDING: u8 = 0;
const STARTED: u8 = 1;
const COMPLETE: u8 = 2;
const CANCELLED: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum GeometryError {
    WrongMain,
    LeaseRefused,
    FrameUnavailable,
    ScaleRefused,
    GeometryRefused,
    StateRefused,
    DispatchRefused,
    OperationTimeout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GeometryRectangle {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}
impl GeometryRectangle {
    fn validate(self) -> Result<(), GeometryError> {
        if self.x < 0
            || self.y < 0
            || self.width <= 0
            || self.height <= 0
            || self
                .x
                .checked_add(self.width)
                .is_none_or(|edge| edge > 1920)
            || self
                .y
                .checked_add(self.height)
                .is_none_or(|edge| edge > 1440)
        {
            return Err(GeometryError::GeometryRefused);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GeometrySnapshot {
    rectangle: GeometryRectangle,
    resize_width: i32,
    resize_height: i32,
    scale_factor: i32,
}
impl GeometrySnapshot {
    fn validate(&self) -> Result<(), GeometryError> {
        if self.scale_factor != 1 {
            return Err(GeometryError::ScaleRefused);
        }
        self.rectangle.validate()?;
        if self.resize_width <= 0
            || self.resize_height <= 0
            || self
                .rectangle
                .width
                .checked_sub(self.resize_width)
                .is_none_or(|chrome| !(0..=256).contains(&chrome))
            || self
                .rectangle
                .height
                .checked_sub(self.resize_height)
                .is_none_or(|chrome| !(0..=256).contains(&chrome))
        {
            return Err(GeometryError::GeometryRefused);
        }
        Ok(())
    }
    fn resize_for(&self, target: GeometryRectangle) -> Result<(i32, i32), GeometryError> {
        self.validate()?;
        target.validate()?;
        let width = self
            .resize_width
            .checked_add(target.width - self.rectangle.width)
            .ok_or(GeometryError::GeometryRefused)?;
        let height = self
            .resize_height
            .checked_add(target.height - self.rectangle.height)
            .ok_or(GeometryError::GeometryRefused)?;
        if width <= 0 || height <= 0 {
            return Err(GeometryError::GeometryRefused);
        }
        Ok((width, height))
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum GeometryRequest {
    Acquire,
    Read {
        lease: String,
    },
    Set {
        lease: String,
        expected: GeometrySnapshot,
        target: GeometryRectangle,
    },
    Restore {
        lease: String,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum GeometryResponse {
    Acquired {
        lease: String,
        snapshot: GeometrySnapshot,
    },
    Snapshot(GeometrySnapshot),
    Requested {
        requested: bool,
    },
}
type Outcome = Result<GeometryResponse, GeometryError>;
trait GeometryPlatform {
    fn snapshot(&self) -> Result<GeometrySnapshot, GeometryError>;
    fn request(
        &self,
        rectangle: GeometryRectangle,
        width: i32,
        height: i32,
    ) -> Result<(), GeometryError>;
}
type MainCallback = Box<dyn FnOnce(Result<&dyn GeometryPlatform, GeometryError>) + Send>;
trait GeometryDispatch: Send + Sync {
    fn dispatch(&self, callback: MainCallback) -> Result<(), GeometryError>;
}
struct Operation {
    deadline: Instant,
    state: AtomicU8,
    result: Mutex<Option<Outcome>>,
    completed: tokio::sync::Notify,
}
impl Operation {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            deadline: Instant::now() + OPERATION_LIMIT,
            state: AtomicU8::new(PENDING),
            result: Mutex::new(None),
            completed: tokio::sync::Notify::new(),
        })
    }
    fn result(&self) -> Result<Option<Outcome>, GeometryError> {
        Ok(self
            .result
            .lock()
            .map_err(|_| GeometryError::StateRefused)?
            .clone())
    }
    fn finish(&self, result: Outcome) {
        if let Ok(mut value) = self.result.lock()
            && value.is_none()
        {
            *value = Some(result);
            self.state.store(COMPLETE, Ordering::SeqCst);
            self.completed.notify_waiters();
        }
    }
    fn fail_pending(&self, error: GeometryError) {
        if self
            .state
            .compare_exchange(PENDING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.finish(Err(error));
        }
    }
    fn cancel_pending(&self) {
        self.fail_pending(GeometryError::OperationTimeout);
    }
    fn begin(&self) -> bool {
        if Instant::now() >= self.deadline {
            self.cancel_pending();
            return false;
        }
        self.state
            .compare_exchange(PENDING, STARTED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    async fn joined(&self, deadline: Instant) -> Result<Outcome, GeometryError> {
        loop {
            let notified = self.completed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(result) = self.result()? {
                return Ok(result);
            }
            tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), notified)
                .await
                .map_err(|_| GeometryError::OperationTimeout)?;
        }
    }
}
struct Lease {
    id: String,
    original: GeometrySnapshot,
    corrections: u8,
}
enum LeaseState {
    Empty,
    Active(Lease),
    Restoring(Lease),
}
pub(crate) struct GeometryOwner {
    lease: Mutex<LeaseState>,
    dispatcher: Mutex<Option<Arc<dyn GeometryDispatch>>>,
    pending: Mutex<Option<Arc<Operation>>>,
    restoration: Mutex<Option<Arc<Operation>>>,
    serial: tokio::sync::Mutex<()>,
    closed: AtomicBool,
    unsafe_cleanup: AtomicBool,
}
impl GeometryOwner {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            lease: Mutex::new(LeaseState::Empty),
            dispatcher: Mutex::new(None),
            pending: Mutex::new(None),
            restoration: Mutex::new(None),
            serial: tokio::sync::Mutex::new(()),
            closed: AtomicBool::new(false),
            unsafe_cleanup: AtomicBool::new(false),
        })
    }
    fn validate_lease(&self, id: &str) -> Result<(), GeometryError> {
        let lease = self.lease.lock().map_err(|_| GeometryError::StateRefused)?;
        match &*lease {
            LeaseState::Active(value) | LeaseState::Restoring(value) if value.id == id => Ok(()),
            _ => Err(GeometryError::LeaseRefused),
        }
    }
    fn perform(&self, request: &GeometryRequest, platform: &dyn GeometryPlatform) -> Outcome {
        if self.closed.load(Ordering::SeqCst) {
            return Err(GeometryError::StateRefused);
        }
        match request {
            GeometryRequest::Acquire => {
                if self.unsafe_cleanup.load(Ordering::SeqCst) {
                    return Err(GeometryError::StateRefused);
                }
                let snapshot = platform.snapshot()?;
                snapshot.validate()?;
                let mut state = self.lease.lock().map_err(|_| GeometryError::StateRefused)?;
                if !matches!(*state, LeaseState::Empty) {
                    return Err(GeometryError::LeaseRefused);
                }
                let id = uuid::Uuid::new_v4().to_string();
                *state = LeaseState::Active(Lease {
                    id: id.clone(),
                    original: snapshot.clone(),
                    corrections: 0,
                });
                Ok(GeometryResponse::Acquired {
                    lease: id,
                    snapshot,
                })
            }
            GeometryRequest::Read { lease } => {
                self.validate_lease(lease)?;
                let snapshot = platform.snapshot()?;
                snapshot.validate()?;
                Ok(GeometryResponse::Snapshot(snapshot))
            }
            GeometryRequest::Set {
                lease,
                expected,
                target,
            } => {
                self.validate_lease(lease)?;
                if self.unsafe_cleanup.load(Ordering::SeqCst) {
                    return Err(GeometryError::StateRefused);
                }
                let snapshot = platform.snapshot()?;
                if &snapshot != expected {
                    return Err(GeometryError::GeometryRefused);
                }
                let (width, height) = snapshot.resize_for(*target)?;
                {
                    let mut state = self.lease.lock().map_err(|_| GeometryError::StateRefused)?;
                    match &mut *state {
                        LeaseState::Active(value)
                            if value.id == *lease && value.corrections < 3 =>
                        {
                            value.corrections += 1
                        }
                        _ => return Err(GeometryError::StateRefused),
                    }
                }
                if self.closed.load(Ordering::SeqCst) {
                    return Err(GeometryError::StateRefused);
                }
                platform.request(*target, width, height)?;
                Ok(GeometryResponse::Requested { requested: true })
            }
            GeometryRequest::Restore { lease } => {
                let original = {
                    let state = self.lease.lock().map_err(|_| GeometryError::StateRefused)?;
                    match &*state {
                        LeaseState::Restoring(value) if value.id == *lease => {
                            value.original.clone()
                        }
                        _ => return Err(GeometryError::LeaseRefused),
                    }
                };
                let current = platform.snapshot()?;
                current.validate()?;
                if current.scale_factor != original.scale_factor {
                    return Err(GeometryError::ScaleRefused);
                }
                platform.request(
                    original.rectangle,
                    original.resize_width,
                    original.resize_height,
                )?;
                Ok(GeometryResponse::Requested { requested: true })
            }
        }
    }
    async fn drive(
        self: Arc<Self>,
        operation: Arc<Operation>,
        request: GeometryRequest,
        dispatcher: Arc<dyn GeometryDispatch>,
        previous: Option<Arc<Operation>>,
    ) {
        let run = async {
            let _serial = tokio::time::timeout_at(
                tokio::time::Instant::from_std(operation.deadline),
                self.serial.lock(),
            )
            .await
            .map_err(|_| GeometryError::OperationTimeout)?;
            if let Some(previous) = previous {
                let _previous_outcome = previous.joined(operation.deadline).await?;
            }
            let owner = Arc::clone(&self);
            let callback_operation = Arc::clone(&operation);
            dispatcher.dispatch(Box::new(move |platform| {
                if !callback_operation.begin() {
                    return;
                }
                let result = platform.and_then(|platform| owner.perform(&request, platform));
                if result.is_err() {
                    owner.unsafe_cleanup.store(true, Ordering::SeqCst);
                }
                callback_operation.finish(result);
            }))?;
            let _outcome = operation.joined(operation.deadline).await?;
            Ok::<(), GeometryError>(())
        }
        .await;
        if let Err(error) = run {
            self.unsafe_cleanup.store(true, Ordering::SeqCst);
            operation.fail_pending(error);
        }
    }
    async fn request(
        self: &Arc<Self>,
        request: GeometryRequest,
        dispatcher: Arc<dyn GeometryDispatch>,
    ) -> Outcome {
        let outcome = self.request_inner(request, dispatcher).await;
        if outcome.is_err() {
            self.unsafe_cleanup.store(true, Ordering::SeqCst);
        }
        outcome
    }
    async fn request_inner(
        self: &Arc<Self>,
        request: GeometryRequest,
        dispatcher: Arc<dyn GeometryDispatch>,
    ) -> Outcome {
        if self.closed.load(Ordering::SeqCst) {
            return Err(GeometryError::StateRefused);
        }
        let mut newly_created = true;
        let operation = if let GeometryRequest::Restore { lease } = &request {
            self.validate_lease(lease)?;
            let mut restoration = self
                .restoration
                .lock()
                .map_err(|_| GeometryError::StateRefused)?;
            if let Some(value) = &*restoration {
                newly_created = false;
                Arc::clone(value)
            } else {
                let mut state = self.lease.lock().map_err(|_| GeometryError::StateRefused)?;
                let prior = std::mem::replace(&mut *state, LeaseState::Empty);
                match prior {
                    LeaseState::Active(value) => *state = LeaseState::Restoring(value),
                    other => {
                        *state = other;
                        return Err(GeometryError::StateRefused);
                    }
                }
                let value = Operation::new();
                *restoration = Some(Arc::clone(&value));
                value
            }
        } else {
            Operation::new()
        };
        if newly_created {
            let previous = {
                let mut pending = self
                    .pending
                    .lock()
                    .map_err(|_| GeometryError::StateRefused)?;
                let previous = pending
                    .as_ref()
                    .filter(|value| value.result().is_ok_and(|result| result.is_none()))
                    .cloned();
                if previous.is_some() && !matches!(request, GeometryRequest::Restore { .. }) {
                    return Err(GeometryError::StateRefused);
                }
                *pending = Some(Arc::clone(&operation));
                previous
            };
            let dispatcher = {
                let mut original = self
                    .dispatcher
                    .lock()
                    .map_err(|_| GeometryError::StateRefused)?;
                if original.is_none() {
                    *original = Some(dispatcher);
                }
                original
                    .as_ref()
                    .cloned()
                    .ok_or(GeometryError::StateRefused)?
            };
            let owner = Arc::clone(self);
            let work = Arc::clone(&operation);
            tokio::spawn(async move {
                owner.drive(work, request, dispatcher, previous).await;
            });
        }
        match operation.joined(Instant::now() + OPERATION_LIMIT).await {
            Ok(outcome) => outcome,
            Err(error) => {
                self.unsafe_cleanup.store(true, Ordering::SeqCst);
                operation.cancel_pending();
                Err(error)
            }
        }
    }
    pub(crate) async fn close(&self) -> Result<(), GeometryError> {
        self.closed.store(true, Ordering::SeqCst);
        let pending = self
            .pending
            .lock()
            .map_err(|_| GeometryError::StateRefused)?
            .clone();
        let restore = self
            .restoration
            .lock()
            .map_err(|_| GeometryError::StateRefused)?
            .clone();
        let deadline = Instant::now() + OPERATION_LIMIT;
        for operation in [pending, restore].into_iter().flatten() {
            operation.cancel_pending();
            match operation.joined(deadline).await {
                Ok(outcome) if outcome.is_err() => {
                    self.unsafe_cleanup.store(true, Ordering::SeqCst)
                }
                Err(error) => {
                    self.unsafe_cleanup.store(true, Ordering::SeqCst);
                    return Err(error);
                }
                _ => {}
            }
        }
        if self.unsafe_cleanup.load(Ordering::SeqCst) {
            return Err(GeometryError::StateRefused);
        }
        Ok(())
    }
}

#[cfg(all(feature = "desktop-e2e", target_os = "linux", not(test)))]
pub(crate) mod linux {
    use super::*;
    use gtk::prelude::*;
    use tauri::Manager;

    struct MainWindow {
        app: tauri::AppHandle<crate::bridge::DesktopRuntime>,
        original: tauri::WebviewWindow<crate::bridge::DesktopRuntime>,
    }
    struct GtkFrame {
        window: gtk::ApplicationWindow,
    }
    impl GtkFrame {
        fn native(&self) -> Result<gtk::gdk::Window, GeometryError> {
            if !self.window.is_realized()
                || !self.window.is_mapped()
                || self.window.is_maximized()
                || self.window.gravity() != gtk::gdk::Gravity::NorthWest
            {
                return Err(GeometryError::FrameUnavailable);
            }
            let native = self
                .window
                .window()
                .ok_or(GeometryError::FrameUnavailable)?;
            if native.is_destroyed()
                || native.display().type_().name() != "GdkX11Display"
                || native.state().intersects(
                    gtk::gdk::WindowState::FULLSCREEN | gtk::gdk::WindowState::ICONIFIED,
                )
            {
                return Err(GeometryError::FrameUnavailable);
            }
            Ok(native)
        }
    }
    impl GeometryPlatform for GtkFrame {
        fn snapshot(&self) -> Result<GeometrySnapshot, GeometryError> {
            let native = self.native()?;
            let scale_factor = native.scale_factor();
            if scale_factor != 1 {
                return Err(GeometryError::ScaleRefused);
            }
            let frame = native.frame_extents();
            let (resize_width, resize_height) = self.window.size();
            let value = GeometrySnapshot {
                rectangle: GeometryRectangle {
                    x: frame.x(),
                    y: frame.y(),
                    width: frame.width(),
                    height: frame.height(),
                },
                resize_width,
                resize_height,
                scale_factor,
            };
            value.validate()?;
            Ok(value)
        }
        fn request(
            &self,
            rectangle: GeometryRectangle,
            width: i32,
            height: i32,
        ) -> Result<(), GeometryError> {
            self.native()?;
            self.window.move_(rectangle.x, rectangle.y);
            self.window.resize(width, height);
            Ok(())
        }
    }
    impl GeometryDispatch for MainWindow {
        fn dispatch(&self, callback: MainCallback) -> Result<(), GeometryError> {
            let app = self.app.clone();
            let original = self.original.clone();
            self.app
                .run_on_main_thread(move || {
                    let frame = (|| {
                        let current = app
                            .get_webview_window("main")
                            .ok_or(GeometryError::WrongMain)?;
                        let window = original
                            .gtk_window()
                            .map_err(|_| GeometryError::FrameUnavailable)?;
                        if current
                            .gtk_window()
                            .map_err(|_| GeometryError::FrameUnavailable)?
                            != window
                        {
                            return Err(GeometryError::WrongMain);
                        }
                        Ok(GtkFrame { window })
                    })();
                    match frame {
                        Ok(frame) => callback(Ok(&frame)),
                        Err(error) => callback(Err(error)),
                    }
                })
                .map_err(|_| GeometryError::DispatchRefused)
        }
    }
    #[tauri::command]
    pub(crate) async fn desktop_e2e_main_window_geometry(
        app: tauri::AppHandle<crate::bridge::DesktopRuntime>,
        webview: tauri::Webview<crate::bridge::DesktopRuntime>,
        owner: tauri::State<'_, Arc<GeometryOwner>>,
        request: GeometryRequest,
    ) -> Outcome {
        if webview.label() != "main" || webview.window().label() != "main" {
            return Err(GeometryError::WrongMain);
        }
        let original = app
            .get_webview_window("main")
            .ok_or(GeometryError::WrongMain)?;
        owner
            .request(request, Arc::new(MainWindow { app, original }))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn original() -> GeometrySnapshot {
        GeometrySnapshot {
            rectangle: GeometryRectangle {
                x: 40,
                y: 50,
                width: 1024,
                height: 768,
            },
            resize_width: 1008,
            resize_height: 728,
            scale_factor: 1,
        }
    }

    #[test]
    fn genuine_frame_dimensions_and_offset_are_not_position_or_configured_dimensions() {
        let value = original();
        assert_eq!(value.validate(), Ok(()));
        assert_eq!(
            value.resize_for(GeometryRectangle {
                x: 40,
                y: 50,
                width: 1296,
                height: 1000
            }),
            Ok((1280, 960))
        );
        assert_eq!(
            GeometrySnapshot {
                rectangle: GeometryRectangle {
                    x: 0,
                    y: 0,
                    ..value.rectangle
                },
                ..value
            }
            .validate(),
            Ok(())
        );
    }

    #[test]
    fn unavailable_scale_dimensions_edges_and_chrome_are_refused_before_a_request() {
        let value = original();
        for changed in [
            GeometrySnapshot {
                scale_factor: 2,
                ..value.clone()
            },
            GeometrySnapshot {
                rectangle: GeometryRectangle {
                    width: 0,
                    ..value.rectangle
                },
                ..value.clone()
            },
            GeometrySnapshot {
                rectangle: GeometryRectangle {
                    x: -1,
                    ..value.rectangle
                },
                ..value.clone()
            },
            GeometrySnapshot {
                rectangle: GeometryRectangle {
                    x: 1000,
                    ..value.rectangle
                },
                ..value.clone()
            },
            GeometrySnapshot {
                resize_width: 0,
                ..value.clone()
            },
            GeometrySnapshot {
                resize_height: 100,
                ..value
            },
        ] {
            assert!(changed.validate().is_err());
        }
    }

    #[test]
    fn unknown_command_fields_and_noninteger_native_values_are_not_contracts() {
        assert!(
            serde_json::from_value::<GeometryRequest>(
                serde_json::json!({"operation":"acquire","window":"preview"})
            )
            .is_err()
        );
        assert!(serde_json::from_value::<GeometrySnapshot>(serde_json::json!({"rectangle":{"x":0,"y":0,"width":1.5,"height":2},"resizeWidth":1,"resizeHeight":2,"scaleFactor":1})).is_err());
    }

    struct NativePort {
        current: Mutex<GeometrySnapshot>,
        reads: AtomicUsize,
        writes: Mutex<Vec<(GeometryRectangle, i32, i32)>>,
        refused: AtomicBool,
    }
    impl NativePort {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                current: Mutex::new(original()),
                reads: AtomicUsize::new(0),
                writes: Mutex::new(Vec::new()),
                refused: AtomicBool::new(false),
            })
        }
    }
    impl GeometryPlatform for NativePort {
        fn snapshot(&self) -> Result<GeometrySnapshot, GeometryError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.current.lock().expect("fixture snapshot").clone())
        }
        fn request(
            &self,
            rectangle: GeometryRectangle,
            width: i32,
            height: i32,
        ) -> Result<(), GeometryError> {
            self.writes
                .lock()
                .expect("fixture writes")
                .push((rectangle, width, height));
            if self.refused.load(Ordering::SeqCst) {
                return Err(GeometryError::FrameUnavailable);
            }
            *self.current.lock().expect("fixture snapshot") = GeometrySnapshot {
                rectangle,
                resize_width: width,
                resize_height: height,
                scale_factor: 1,
            };
            Ok(())
        }
    }
    struct Immediate(Arc<NativePort>);
    impl GeometryDispatch for Immediate {
        fn dispatch(&self, callback: MainCallback) -> Result<(), GeometryError> {
            callback(Ok(self.0.as_ref()));
            Ok(())
        }
    }
    async fn acquire(owner: &Arc<GeometryOwner>, native: &Arc<NativePort>) -> String {
        match owner
            .request(
                GeometryRequest::Acquire,
                Arc::new(Immediate(Arc::clone(native))),
            )
            .await
            .expect("acquire native original")
        {
            GeometryResponse::Acquired { lease, snapshot } => {
                assert_eq!(snapshot, original());
                lease
            }
            _ => panic!("unexpected native response"),
        }
    }
    #[tokio::test]
    async fn writes_require_an_acquired_original_and_an_exact_current_snapshot() {
        let owner = GeometryOwner::new();
        let native = NativePort::new();
        assert!(
            owner
                .request(
                    GeometryRequest::Set {
                        lease: "foreign".into(),
                        expected: original(),
                        target: original().rectangle
                    },
                    Arc::new(Immediate(Arc::clone(&native)))
                )
                .await
                .is_err()
        );
        assert!(native.writes.lock().expect("fixture writes").is_empty());
        assert_eq!(native.reads.load(Ordering::SeqCst), 0);
        let owner = GeometryOwner::new();
        let lease = acquire(&owner, &native).await;
        native.current.lock().expect("fixture snapshot").rectangle.x = 41;
        assert!(matches!(
            owner
                .request(
                    GeometryRequest::Set {
                        lease,
                        expected: original(),
                        target: original().rectangle
                    },
                    Arc::new(Immediate(Arc::clone(&native)))
                )
                .await,
            Err(GeometryError::GeometryRefused)
        ));
        assert!(native.writes.lock().expect("fixture writes").is_empty());
    }
    #[tokio::test]
    async fn real_basis_drives_three_requests_then_one_exact_original_restore() {
        let owner = GeometryOwner::new();
        let native = NativePort::new();
        let lease = acquire(&owner, &native).await;
        for width in [1296, 1300, 1304] {
            let expected = native.current.lock().expect("fixture snapshot").clone();
            let result = owner
                .request(
                    GeometryRequest::Set {
                        lease: lease.clone(),
                        expected,
                        target: GeometryRectangle {
                            x: 40,
                            y: 50,
                            width,
                            height: 1000,
                        },
                    },
                    Arc::new(Immediate(Arc::clone(&native))),
                )
                .await;
            assert!(matches!(
                result,
                Ok(GeometryResponse::Requested { requested: true })
            ));
        }
        assert_eq!(
            native.writes.lock().expect("fixture writes")[0],
            (
                GeometryRectangle {
                    x: 40,
                    y: 50,
                    width: 1296,
                    height: 1000
                },
                1280,
                960
            )
        );
        let expected = native.current.lock().expect("fixture snapshot").clone();
        assert!(
            owner
                .request(
                    GeometryRequest::Set {
                        lease: lease.clone(),
                        expected,
                        target: original().rectangle
                    },
                    Arc::new(Immediate(Arc::clone(&native)))
                )
                .await
                .is_err()
        );
        for _ in 0..2 {
            assert!(
                owner
                    .request(
                        GeometryRequest::Restore {
                            lease: lease.clone()
                        },
                        Arc::new(Immediate(Arc::clone(&native)))
                    )
                    .await
                    .is_ok()
            );
        }
        assert_eq!(native.writes.lock().expect("fixture writes").len(), 4);
        assert_eq!(
            *native.current.lock().expect("fixture snapshot"),
            original()
        );
        match owner
            .request(
                GeometryRequest::Read { lease },
                Arc::new(Immediate(Arc::clone(&native))),
            )
            .await
            .expect("read restored native original")
        {
            GeometryResponse::Snapshot(value) => assert_eq!(value, original()),
            _ => panic!("unexpected read response"),
        }
        assert!(matches!(
            owner.close().await,
            Err(GeometryError::StateRefused)
        ));
    }
    #[tokio::test]
    async fn partial_request_failure_still_allows_original_restore_without_erasing_unsafe() {
        let owner = GeometryOwner::new();
        let native = NativePort::new();
        let lease = acquire(&owner, &native).await;
        native.refused.store(true, Ordering::SeqCst);
        assert!(matches!(
            owner
                .request(
                    GeometryRequest::Set {
                        lease: lease.clone(),
                        expected: original(),
                        target: GeometryRectangle {
                            x: 0,
                            y: 0,
                            width: 1296,
                            height: 1000
                        }
                    },
                    Arc::new(Immediate(Arc::clone(&native)))
                )
                .await,
            Err(GeometryError::FrameUnavailable)
        ));
        native.refused.store(false, Ordering::SeqCst);
        assert!(
            owner
                .request(
                    GeometryRequest::Restore { lease },
                    Arc::new(Immediate(Arc::clone(&native)))
                )
                .await
                .is_ok()
        );
        assert_eq!(
            *native.current.lock().expect("fixture snapshot"),
            original()
        );
        assert!(owner.close().await.is_err());
    }
    struct Delayed(Mutex<Option<MainCallback>>);
    impl GeometryDispatch for Delayed {
        fn dispatch(&self, callback: MainCallback) -> Result<(), GeometryError> {
            *self.0.lock().expect("queued callback") = Some(callback);
            Ok(())
        }
    }
    #[tokio::test]
    async fn shutdown_cancels_a_queued_callback_before_native_reads_or_writes() {
        let owner = GeometryOwner::new();
        let native = NativePort::new();
        let delayed = Arc::new(Delayed(Mutex::new(None)));
        let request_owner = Arc::clone(&owner);
        let dispatch: Arc<dyn GeometryDispatch> = delayed.clone();
        let pending = tokio::spawn(async move {
            request_owner
                .request(GeometryRequest::Acquire, dispatch)
                .await
        });
        for _ in 0..8 {
            if delayed.0.lock().expect("queued callback").is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(delayed.0.lock().expect("queued callback").is_some());
        assert!(owner.close().await.is_err());
        delayed
            .0
            .lock()
            .expect("queued callback")
            .take()
            .expect("late callback")(Ok(native.as_ref()));
        assert!(pending.await.expect("joined requester").is_err());
        assert_eq!(native.reads.load(Ordering::SeqCst), 0);
        assert!(native.writes.lock().expect("fixture writes").is_empty());
    }
    struct Refused;
    impl GeometryDispatch for Refused {
        fn dispatch(&self, _callback: MainCallback) -> Result<(), GeometryError> {
            Err(GeometryError::DispatchRefused)
        }
    }
    #[tokio::test]
    async fn dispatch_refusal_is_not_replaced_by_a_timeout() {
        assert!(matches!(
            GeometryOwner::new()
                .request(GeometryRequest::Acquire, Arc::new(Refused))
                .await,
            Err(GeometryError::DispatchRefused)
        ));
    }

    #[tokio::test]
    async fn a_started_operation_timeout_stays_unsafe_after_its_late_completion() {
        let owner = GeometryOwner::new();
        let operation = Operation::new();
        assert!(operation.begin());
        *owner.pending.lock().expect("pending operation") = Some(Arc::clone(&operation));
        assert_eq!(owner.close().await, Err(GeometryError::OperationTimeout));
        operation.finish(Ok(GeometryResponse::Requested { requested: true }));
        assert_eq!(owner.close().await, Err(GeometryError::StateRefused));
    }
    #[test]
    fn a_callback_past_its_fixed_deadline_cannot_start() {
        let operation = Operation {
            deadline: Instant::now() - Duration::from_millis(1),
            state: AtomicU8::new(PENDING),
            result: Mutex::new(None),
            completed: tokio::sync::Notify::new(),
        };
        assert!(!operation.begin());
        assert!(matches!(
            operation.result().expect("result"),
            Some(Err(GeometryError::OperationTimeout))
        ));
        let wrong_main = GeometryError::WrongMain;
        assert_eq!(
            serde_json::to_value(wrong_main).expect("closed error"),
            serde_json::json!("wrong-main")
        );
    }
}
