//! A scripted [`DeviceBackend`] for the platform-neutral manager's tests.

use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use futures_util::{future::BoxFuture, stream::BoxStream};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

use super::{
    DeviceError, DeviceManager, DeviceManagerConfig, DeviceOpError,
    backend::{
        DeviceBackend, ErasedVideoSource, JpegStream, LaunchFailure, PlatformDiscovery, Png,
        RunningDevice,
    },
    catalog::{
        Availability, AvailabilityKind, DeviceSnapshot, DeviceState, Image, Orientation, Platform,
    },
    input::DeviceInputEvent,
};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The native size every fake device reports.
pub(crate) const FAKE_SIZE: (u32, u32) = (1170, 2532);

/// A call the test holds: `reached` fires once the call waits, and the call goes on once
/// `release` fires or is dropped.
pub(crate) struct Held {
    pub reached: oneshot::Receiver<()>,
    pub release: oneshot::Sender<()>,
}

impl Held {
    /// Waits until the call is held.
    pub(crate) async fn reached(&mut self) {
        tokio::time::timeout(Duration::from_secs(20), &mut self.reached)
            .await
            .expect("the held call is reached")
            .expect("the hold is still set");
    }

    pub(crate) fn release(self) {
        let _ = self.release.send(());
    }
}

/// The next call of one kind waits here, once.
#[derive(Default)]
struct Hold(Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>);

impl Hold {
    fn set(&self) -> Held {
        let (reached, reached_rx) = oneshot::channel();
        let (release, go) = oneshot::channel();
        *lock(&self.0) = Some((reached, go));
        Held {
            reached: reached_rx,
            release,
        }
    }

    /// The hold for the call starting now, if one is set; await it with [`wait`].
    fn take(&self) -> Option<(oneshot::Sender<()>, oneshot::Receiver<()>)> {
        lock(&self.0).take()
    }
}

async fn wait(hold: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>) {
    if let Some((reached, go)) = hold {
        let _ = reached.send(());
        let _ = go.await;
    }
}

/// One platform's scripted images, launches, and counters.
pub(crate) struct FakeBackend {
    platform: Platform,
    images: Mutex<Vec<String>>,
    /// Images `check_available` refuses.
    busy: Mutex<HashSet<String>>,
    /// Images whose launch fails late with `LaunchFailure::Busy`.
    busy_on_launch: Mutex<HashSet<String>>,
    never_boots: AtomicBool,
    can_rotate: AtomicBool,
    /// Every launched device, in launch order.
    launched: Mutex<Vec<Arc<FakeDeviceState>>>,
    stops: Arc<AtomicUsize>,
    discover_calls: AtomicUsize,
    check_calls: AtomicUsize,
    /// Set by `reports_orientation`: launched devices report turns through it.
    orientation: Mutex<Option<watch::Sender<Orientation>>>,
    /// Set by `boot_orientation`: the orientation launched devices show once they run.
    boot_orientation: Mutex<Orientation>,
    /// Set by `without_video`: why launched devices have no video.
    no_video: Mutex<Option<String>>,
    discover_hold: Hold,
    check_hold: Hold,
    launch_hold: Hold,
    /// Shared with the running devices, whose `stop` takes it.
    stop_hold: Arc<Hold>,
}

struct FakeDeviceState {
    exit: Mutex<Option<String>>,
}

impl FakeBackend {
    pub(crate) fn new(platform: Platform, images: &[&str]) -> Arc<Self> {
        Arc::new(Self {
            platform,
            images: Mutex::new(images.iter().map(|image| (*image).to_owned()).collect()),
            busy: Mutex::default(),
            busy_on_launch: Mutex::default(),
            never_boots: AtomicBool::new(false),
            can_rotate: AtomicBool::new(true),
            launched: Mutex::default(),
            stops: Arc::default(),
            discover_calls: AtomicUsize::new(0),
            check_calls: AtomicUsize::new(0),
            orientation: Mutex::new(None),
            boot_orientation: Mutex::new(Orientation::Portrait),
            no_video: Mutex::new(None),
            discover_hold: Hold::default(),
            check_hold: Hold::default(),
            launch_hold: Hold::default(),
            stop_hold: Arc::default(),
        })
    }

    /// The next discovery lists `image` too, as if it was created since the last one.
    pub(crate) fn add_image(&self, image: &str) {
        lock(&self.images).push(image.to_owned());
    }

    /// The next `discover` waits until released.
    pub(crate) fn hold_next_discover(&self) -> Held {
        self.discover_hold.set()
    }

    /// The next `check_available` waits until released, then answers as the fake is then.
    pub(crate) fn hold_next_check(&self) -> Held {
        self.check_hold.set()
    }

    /// The next launch waits until released, before it reports `Booting`: its device stays
    /// `Starting` meanwhile.
    pub(crate) fn hold_next_launch(&self) -> Held {
        self.launch_hold.set()
    }

    /// The next running device to stop waits until released: it stays `Stopping` meanwhile.
    pub(crate) fn hold_next_stop(&self) -> Held {
        self.stop_hold.set()
    }

    /// No longer in use outside BiBCode.
    pub(crate) fn not_busy(&self, image: &str) {
        lock(&self.busy).remove(image);
    }

    /// Launched devices report orientation on their own, starting in portrait; returns the
    /// sender that turns them.
    pub(crate) fn reports_orientation(self: &Arc<Self>) -> watch::Sender<Orientation> {
        let sender = watch::Sender::new(Orientation::Portrait);
        *lock(&self.orientation) = Some(sender.clone());
        sender
    }

    /// Launched devices boot already turned to `orientation`, as an Android Quick Boot
    /// snapshot saved turned does. Without `reports_orientation` nothing follows the device
    /// afterwards, so only the launch can put that turn into the catalog's first `Ready` entry.
    pub(crate) fn boot_orientation(self: &Arc<Self>, orientation: Orientation) {
        *lock(&self.boot_orientation) = orientation;
    }

    /// Launched devices have no video, for `reason`.
    pub(crate) fn without_video(self: &Arc<Self>, reason: &str) {
        *lock(&self.no_video) = Some(reason.to_owned());
    }

    /// `image` is in use outside BiBCode: `check_available` refuses it.
    pub(crate) fn busy(self: &Arc<Self>, image: &str) {
        lock(&self.busy).insert(image.to_owned());
    }

    /// `image` passes `check_available` but its launch finds it in use.
    pub(crate) fn busy_on_launch(self: &Arc<Self>, image: &str) {
        lock(&self.busy_on_launch).insert(image.to_owned());
    }

    /// Launches report `Booting` and wait for their cancel.
    pub(crate) fn never_boots(self: &Arc<Self>) {
        self.never_boots.store(true, Ordering::SeqCst);
    }

    /// Launched devices report that they cannot rotate.
    pub(crate) fn without_rotation(self: &Arc<Self>) {
        self.can_rotate.store(false, Ordering::SeqCst);
    }

    /// Makes the `device_index`th launched device report an exit nobody asked for.
    pub(crate) fn exit_running(&self, device_index: usize, reason: &str) {
        let launched = lock(&self.launched);
        *lock(&launched[device_index].exit) = Some(reason.to_owned());
    }

    /// How many running devices were stopped.
    pub(crate) fn stops(&self) -> usize {
        self.stops.load(Ordering::SeqCst)
    }

    pub(crate) fn discover_calls(&self) -> usize {
        self.discover_calls.load(Ordering::SeqCst)
    }

    /// How many times `check_available` ran.
    pub(crate) fn check_calls(&self) -> usize {
        self.check_calls.load(Ordering::SeqCst)
    }

    /// How many launches started.
    pub(crate) fn launches(&self) -> usize {
        lock(&self.launched).len()
    }
}

impl DeviceBackend for FakeBackend {
    fn platform(&self) -> Platform {
        self.platform
    }

    fn looking(&self) -> Availability {
        Availability {
            kind: AvailabilityKind::SdkMissing,
            message: "Looking for fake devices.".to_owned(),
        }
    }

    fn discover(&self) -> BoxFuture<'_, PlatformDiscovery> {
        Box::pin(async move {
            self.discover_calls.fetch_add(1, Ordering::SeqCst);
            wait(self.discover_hold.take()).await;
            let images = lock(&self.images).clone();
            let availability = if images.is_empty() {
                Availability {
                    kind: AvailabilityKind::NoAvds,
                    message: "No fake devices exist.".to_owned(),
                }
            } else {
                Availability {
                    kind: AvailabilityKind::Ready,
                    message: String::new(),
                }
            };
            PlatformDiscovery {
                availability,
                images: images
                    .iter()
                    .map(|id| Image {
                        id: id.clone(),
                        display_name: format!("iPhone {id}"),
                        in_use_elsewhere: lock(&self.busy).contains(id),
                    })
                    .collect(),
            }
        })
    }

    fn check_available<'a>(
        &'a self,
        image_id: &'a str,
    ) -> BoxFuture<'a, Result<(), LaunchFailure>> {
        Box::pin(async move {
            self.check_calls.fetch_add(1, Ordering::SeqCst);
            wait(self.check_hold.take()).await;
            if lock(&self.busy).contains(image_id) {
                Err(LaunchFailure::Busy)
            } else {
                Ok(())
            }
        })
    }

    fn launch<'a>(
        &'a self,
        image_id: &'a str,
        on_phase: Box<dyn Fn(DeviceState) + Send + Sync>,
        cancel: &'a CancellationToken,
    ) -> BoxFuture<'a, Result<Box<dyn RunningDevice>, LaunchFailure>> {
        Box::pin(async move {
            let state = Arc::new(FakeDeviceState {
                exit: Mutex::new(None),
            });
            lock(&self.launched).push(state.clone());
            if lock(&self.busy_on_launch).contains(image_id) {
                return Err(LaunchFailure::Busy);
            }
            let hold = self.launch_hold.take();
            tokio::select! {
                () = wait(hold) => {}
                () = cancel.cancelled() => return Err(LaunchFailure::Cancelled),
            }
            on_phase(DeviceState::Booting);
            if self.never_boots.load(Ordering::SeqCst) {
                cancel.cancelled().await;
                return Err(LaunchFailure::Cancelled);
            }
            Ok(Box::new(FakeRunning {
                state,
                orientation: lock(&self.orientation)
                    .as_ref()
                    .map(watch::Sender::subscribe),
                boot_orientation: *lock(&self.boot_orientation),
                no_video: lock(&self.no_video).clone(),
                can_rotate: self.can_rotate.load(Ordering::SeqCst),
                stops: self.stops.clone(),
                stopped: AtomicBool::new(false),
                stop_hold: self.stop_hold.clone(),
            }) as Box<dyn RunningDevice>)
        })
    }
}

struct FakeRunning {
    state: Arc<FakeDeviceState>,
    orientation: Option<watch::Receiver<Orientation>>,
    boot_orientation: Orientation,
    no_video: Option<String>,
    can_rotate: bool,
    stops: Arc<AtomicUsize>,
    stopped: AtomicBool,
    stop_hold: Arc<Hold>,
}

impl FakeRunning {
    fn record_stop(&self) {
        if !self.stopped.swap(true, Ordering::SeqCst) {
            self.stops.fetch_add(1, Ordering::SeqCst);
        }
    }
}

fn unsupported() -> DeviceError {
    DeviceError::Io("the fake backend has no screen".to_owned())
}

impl RunningDevice for FakeRunning {
    fn native_size(&self) -> (u32, u32) {
        FAKE_SIZE
    }

    fn can_rotate(&self) -> bool {
        self.can_rotate
    }

    fn orientation(&self) -> Orientation {
        self.boot_orientation
    }

    fn jpeg_stream(&self, _max_width: u32) -> BoxFuture<'_, Result<JpegStream, DeviceError>> {
        Box::pin(async { Err(unsupported()) })
    }

    fn png(&self, _max_width: u32) -> BoxFuture<'_, Result<Png, DeviceError>> {
        Box::pin(async { Err(unsupported()) })
    }

    fn video(&self) -> BoxFuture<'_, Result<Box<dyn ErasedVideoSource>, DeviceError>> {
        Box::pin(async { Err(unsupported()) })
    }

    fn video_unavailable(&self) -> Option<String> {
        self.no_video.clone()
    }

    fn orientation_changes(&self) -> Option<BoxStream<'static, Orientation>> {
        let mut changes = self.orientation.clone()?;
        changes.mark_changed();
        Some(Box::pin(futures_util::stream::unfold(
            changes,
            |mut changes| async move {
                changes.changed().await.ok()?;
                let orientation = *changes.borrow_and_update();
                Some((orientation, changes))
            },
        )))
    }

    fn input(
        &self,
        _events: Vec<DeviceInputEvent>,
        _orientation: Orientation,
    ) -> BoxFuture<'_, Result<(), DeviceOpError>> {
        Box::pin(async { Ok(()) })
    }

    fn rotate<'a>(
        &'a self,
        to: Orientation,
        report: &'a (dyn Fn(Orientation, u32, u32) + Send + Sync),
    ) -> BoxFuture<'a, Result<Orientation, DeviceOpError>> {
        Box::pin(async move {
            let (width, height) = super::input::oriented_size(FAKE_SIZE.0, FAKE_SIZE.1, to);
            report(to, width, height);
            Ok(to)
        })
    }

    fn exited(&self) -> Option<String> {
        lock(&self.state.exit).clone()
    }

    fn report_unrequested_exit(&self, _reason: &str) {}

    fn stop(self: Box<Self>) -> BoxFuture<'static, ()> {
        self.record_stop();
        let hold = self.stop_hold.take();
        Box::pin(wait(hold))
    }

    fn stop_shared(&self) -> BoxFuture<'_, ()> {
        self.record_stop();
        Box::pin(async {})
    }
}

/// A manager over `backends` with device previews on.
pub(crate) fn fake_manager(
    backends: Vec<Arc<FakeBackend>>,
) -> (DeviceManager, watch::Sender<bool>) {
    let (enabled, signal) = watch::channel(true);
    let manager = DeviceManager::start(DeviceManagerConfig {
        backends: backends
            .into_iter()
            .map(|backend| backend as Arc<dyn DeviceBackend>)
            .collect(),
        enabled: signal,
    });
    (manager, enabled)
}

/// Waits up to 20 s for `device_id` to reach `state` and returns its snapshot.
pub(crate) async fn wait_state(
    manager: &DeviceManager,
    device_id: &str,
    state: DeviceState,
) -> DeviceSnapshot {
    let mut catalog = manager.catalog();
    tokio::time::timeout(
        Duration::from_secs(20),
        catalog.wait_for(|catalog| {
            catalog
                .devices
                .iter()
                .any(|device| device.device_id == device_id && device.state == state)
        }),
    )
    .await
    .unwrap_or_else(|_| {
        panic!(
            "{device_id} never reached {state:?}: {:?}",
            manager.catalog().borrow().devices
        )
    })
    .expect("catalog open")
    .devices
    .iter()
    .find(|device| device.device_id == device_id)
    .cloned()
    .expect("device in catalog")
}
