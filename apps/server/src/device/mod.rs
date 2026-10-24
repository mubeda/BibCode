//! Server-hosted device previews: up to four live devices per environment, of either platform,
//! one per image, each labelled with the thread that started it; see
//! docs/architecture/overview.md#device-previews.
pub(crate) mod android;
pub(crate) mod backend;
pub mod catalog;
#[cfg(test)]
pub(crate) mod fake_backend;
pub mod frames;
pub mod input;
#[cfg(target_os = "macos")]
pub(crate) mod ios;
#[cfg(target_os = "macos")]
#[doc(hidden)]
pub use ios::encoder::sps_dimensions as h264_sps_dimensions_for_tests;
#[cfg(target_os = "macos")]
#[doc(hidden)]
pub use ios::host_manager_for_tests as ios_host_manager_for_tests;
pub mod media;
pub(crate) mod media_socket;
pub(crate) mod stderr_tail;
pub mod video;

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard, PoisonError, Weak},
    time::{Duration, Instant},
};

use tokio::sync::watch;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use self::{
    backend::{DeviceBackend, LaunchFailure, PlatformDiscovery, Png, RunningDevice},
    catalog::{
        Availability, AvailabilityKind, DeviceCatalog, DeviceSnapshot, DeviceState, Orientation,
        Platform, PlatformCatalog,
    },
    frames::FrameHub,
    input::oriented_size,
    media::{MediaHub, TicketBook},
};

/// How long a discovery result serves `refresh` before it reruns.
const DISCOVERY_TTL: Duration = Duration::from_secs(30);
/// How often a running emulator is checked for an exit nobody asked for.
const EXIT_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Stopped and failed devices the catalog keeps, newest first, so their reason stays visible.
const RETAINED_ENDED_DEVICES: usize = 4;
/// The most devices one environment runs at once, of either platform. A `stopping` device
/// counts until it has stopped.
pub(crate) const MAX_RUNNING_DEVICES: usize = 4;
const _: () = assert!(MAX_RUNNING_DEVICES == 4, "the limit's messages say four");
/// How many thread deletions the manager remembers, so an open for a deleted thread is
/// refused; the oldest is dropped first.
const RECENT_DELETIONS: usize = 256;
/// How long a stop waits for in-flight calls to let go of a device before stopping it anyway.
const STOP_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_RELEASE_POLL: Duration = Duration::from_millis(50);

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum DeviceError {
    #[error("emulator gRPC: {0}")]
    Grpc(String),
    #[error("{0}")]
    Io(String),
    #[error("protocol: {0}")]
    Protocol(String),
}

/// Why a device operation was refused. Each maps to a typed contract error.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum DeviceOpError {
    #[error("Device previews are off. Turn on Device previews in Settings to start a device.")]
    Disabled,
    #[error("{}", .0.message)]
    Sdk(Availability),
    /// `running` names the first live device on the requested platform in catalog order,
    /// else the first live device: the one an older client's **Stop** button stops.
    #[error(
        "Four devices are already running, the most this server runs at once. Stop one to start another."
    )]
    Limit { running: String },
    #[error("This device is no longer running. Start it again from the device list.")]
    NotFound,
    /// The thread that would own the device was deleted.
    #[error("This thread was deleted, so its device was not started.")]
    OwnerDeleted,
    /// An agent's `device_open` of an image whose device another thread started.
    #[error(
        "{name} is in use by another thread. Start a different image, or look at it with device_screenshot."
    )]
    InUseByAnotherThread { image_id: String, name: String },
    /// An agent's `device_close` of a device another thread started.
    #[error("{name} was started by another thread. Ask the user to stop it.")]
    StartedByAnotherThread { image_id: String, name: String },
    #[error("{}", not_ready_message(*.0))]
    NotReady(DeviceState),
    #[error("{}", unknown_image_message(*platform, image_id))]
    UnknownImage {
        platform: Platform,
        image_id: String,
    },
    /// The image is already running outside BiBCode.
    #[error(
        "This simulator is already running outside BiBCode. Shut it down in Simulator, then open it here."
    )]
    Busy { image_id: String },
    #[error("{0}")]
    InvalidInput(String),
    /// An emulator call failed on a `Ready` device; the message says what to do.
    #[error("{0}")]
    Emulator(String),
    /// Media tickets need a signed-in session, which a server without auth never has.
    #[error(
        "Video needs a signed-in session, and this server runs with --unsafe-no-auth, so the screen updates as still images. Restart the server without --unsafe-no-auth to show video."
    )]
    MediaUnavailable,
    /// The device has no video; the message says why.
    #[error("{0}")]
    NoVideo(String),
}

fn unknown_image_message(platform: Platform, image_id: &str) -> String {
    match platform {
        Platform::Android => format!(
            "No virtual device named \"{image_id}\" exists on the server. Choose one from the device list, or create it in Android Studio's Device Manager."
        ),
        Platform::Ios => format!(
            "No simulator with id \"{image_id}\" exists on the server. Choose one from the device list."
        ),
    }
}

/// Whether a platform's devices can open: ready, or view-only (screenshots without input).
fn opens(kind: AvailabilityKind) -> bool {
    matches!(
        kind,
        AvailabilityKind::Ready
            | AvailabilityKind::XcodeUnsupported
            | AvailabilityKind::ViewOnlyHeadless
    )
}

fn not_ready_message(state: DeviceState) -> &'static str {
    match state {
        DeviceState::Starting | DeviceState::Booting => {
            "The device is still starting. Wait until it is ready, then try again."
        }
        DeviceState::Ready => "The device is not ready yet. Try again in a moment.",
        DeviceState::Stopping => {
            "This device is still stopping. Start it again once it has stopped."
        }
        DeviceState::Stopped => "The device has stopped. Start it again from the device list.",
        DeviceState::Failed => {
            "The device failed. Check its reason in the device list, then start it again."
        }
    }
}

impl DeviceOpError {
    /// The typed RPC failure for this error.
    pub fn to_rpc_error(&self) -> serde_json::Value {
        let message = self.to_string();
        match self {
            Self::Disabled => serde_json::json!({
                "_tag": "DevicePreviewsDisabledError",
                "message": message,
            }),
            Self::Sdk(availability) => serde_json::json!({
                "_tag": "DeviceSdkUnavailableError",
                "kind": availability.kind,
                "message": message,
            }),
            Self::Limit { running } => serde_json::json!({
                "_tag": "DeviceLimitError",
                "running": running,
                "message": message,
            }),
            Self::Busy { image_id }
            | Self::InUseByAnotherThread { image_id, .. }
            | Self::StartedByAnotherThread { image_id, .. } => serde_json::json!({
                "_tag": "DeviceBusyError",
                "imageId": image_id,
                "message": message,
            }),
            Self::NotFound | Self::UnknownImage { .. } | Self::OwnerDeleted => serde_json::json!({
                "_tag": "DeviceNotFoundError",
                "message": message,
            }),
            Self::NotReady(state) => serde_json::json!({
                "_tag": "DeviceNotReadyError",
                "state": state,
                "message": message,
            }),
            Self::InvalidInput(_) => serde_json::json!({
                "_tag": "DeviceInputError",
                "message": message,
            }),
            Self::Emulator(_) => serde_json::json!({
                "_tag": "DeviceEmulatorError",
                "message": message,
            }),
            Self::MediaUnavailable | Self::NoVideo(_) => serde_json::json!({
                "_tag": "DeviceMediaUnavailableError",
                "message": message,
            }),
        }
    }
}

pub(crate) struct DeviceManagerConfig {
    /// The platforms whose devices this manager runs, at most one backend per platform, in
    /// the order the catalog lists them.
    pub backends: Vec<Arc<dyn DeviceBackend>>,
    /// The committed `enableDevicePreviews` setting.
    pub enabled: watch::Receiver<bool>,
}

/// A running device as its slot holds it: the slot is the only lasting owner, and frame,
/// input, and media tasks clone it for one call at a time.
type SharedDevice = Arc<Box<dyn RunningDevice>>;

/// Owns every device of this environment and the catalog that describes them: at most
/// [`MAX_RUNNING_DEVICES`] live devices, one per image, stopped when the setting turns off, when
/// the thread that started them is deleted, and on shutdown.
#[derive(Clone)]
pub struct DeviceManager {
    inner: Arc<Inner>,
}

struct Inner {
    catalog: watch::Sender<DeviceCatalog>,
    devices: Mutex<DeviceTable>,
    enabled: watch::Receiver<bool>,
    backends: Vec<PlatformBackend>,
    shutdown: CancellationToken,
    tasks: TaskTracker,
    /// Outstanding media-socket tickets.
    tickets: TicketBook,
    /// Tests only: device ids counting down from this, so id order is the reverse of open order.
    #[cfg(test)]
    descending_ids: Mutex<Option<u32>>,
}

/// A backend and its own discovery cache, so a slow listing on one platform never holds up
/// another's.
struct PlatformBackend {
    backend: Arc<dyn DeviceBackend>,
    discovery: tokio::sync::Mutex<Option<Discovery>>,
}

#[derive(Default)]
struct DeviceTable {
    slots: HashMap<String, Slot>,
    next_seq: u64,
    /// The last [`RECENT_DELETIONS`] deleted threads, oldest first. Only the `thread.deleted`
    /// effect adds to it ([`DeviceManager::stop_thread`]); `open` refuses them as owners.
    deleted_threads: VecDeque<String>,
}

/// What `open` does with an image, by the image's slots.
enum Admission {
    /// The image already has a device starting, booting, or ready: its id.
    Attach(String),
    /// The image has no live device and a place is free.
    Start,
}

struct Slot {
    snapshot: DeviceSnapshot,
    /// Set while the device is `Ready`; taken by whoever stops it.
    running: Option<SharedDevice>,
    /// Cancels the launch and the exit watcher.
    cancel: CancellationToken,
    /// Cancelled once the device has ended and its emulator process is gone.
    reaped: CancellationToken,
    started: Instant,
    /// The image's name as the device list shows it, for the limit error.
    display_name: String,
    /// Open order: the catalog lists devices in it, and it decides which ended devices the
    /// catalog keeps.
    seq: u64,
    /// The JPEG frame producer while anyone subscribes.
    frames: Option<Arc<FrameHub>>,
    /// The H.264 fan-out while any media socket watches the device.
    media: Option<Arc<MediaHub>>,
}

impl Slot {
    /// Stops the frame producer and the media hub of a device that stops running; its
    /// input stream ends with the device.
    fn end_streams(&mut self) {
        if let Some(frames) = self.frames.take() {
            frames.stop();
        }
        // Closes every media socket and stops the video source.
        if let Some(media) = self.media.take() {
            media.stop_device_ended();
        }
    }
}

#[derive(Clone)]
struct Discovery {
    at: Instant,
    found: PlatformDiscovery,
}

fn ended(state: DeviceState) -> bool {
    matches!(state, DeviceState::Stopped | DeviceState::Failed)
}

impl DeviceManager {
    /// Starts the manager and the task that follows the setting: on, it discovers every
    /// platform; off, it stops every device.
    pub(crate) fn start(config: DeviceManagerConfig) -> Self {
        let (catalog, _) = watch::channel(DeviceCatalog {
            platforms: config
                .backends
                .iter()
                .map(|backend| PlatformCatalog {
                    platform: backend.platform(),
                    availability: backend.looking(),
                    images: Vec::new(),
                })
                .collect(),
            devices: Vec::new(),
        });
        let inner = Arc::new(Inner {
            catalog,
            devices: Mutex::default(),
            enabled: config.enabled,
            backends: config
                .backends
                .into_iter()
                .map(|backend| PlatformBackend {
                    backend,
                    discovery: tokio::sync::Mutex::new(None),
                })
                .collect(),
            shutdown: CancellationToken::new(),
            tasks: TaskTracker::new(),
            tickets: TicketBook::default(),
            #[cfg(test)]
            descending_ids: Mutex::new(None),
        });
        inner.tasks.spawn(Inner::follow_setting(
            Arc::downgrade(&inner),
            inner.enabled.clone(),
            inner.shutdown.clone(),
        ));
        Self { inner }
    }

    pub fn catalog(&self) -> watch::Receiver<DeviceCatalog> {
        self.inner.catalog.subscribe()
    }

    /// Reruns each platform's discovery unless its last run is under 30 s old, and
    /// publishes it.
    pub async fn refresh(&self) {
        self.inner.discover_all(false).await;
    }

    /// Reruns every platform's discovery now and publishes it.
    pub async fn refresh_now(&self) {
        self.inner.discover_all(true).await;
    }

    /// Starts `image_id` on `platform` for `owner` (a root thread id, trimmed; blank is refused)
    /// and returns its device id at `Starting`; boot progress is published in the catalog. An
    /// image that already has a device starting, booting, or ready returns that device's id and
    /// starts nothing, keeping its owner.
    pub async fn open(
        &self,
        platform: Platform,
        image_id: &str,
        owner: Option<&str>,
    ) -> Result<String, DeviceOpError> {
        if !self.inner.accepting() {
            return Err(DeviceOpError::Disabled);
        }
        let owner = normalize_owner(owner)?;
        if self.inner.table().owner_deleted(owner.as_deref()) {
            return Err(DeviceOpError::OwnerDeleted);
        }
        let unknown = || DeviceOpError::UnknownImage {
            platform,
            image_id: image_id.to_owned(),
        };
        // A platform this server has no backend for has no images.
        let entry = self.inner.backend(platform).ok_or_else(unknown)?;
        let mut found = self.inner.discover(entry, false).await;
        if !opens(found.found.availability.kind) || !found.lists(image_id) {
            found = self.inner.discover(entry, true).await;
        }
        if !opens(found.found.availability.kind) {
            return Err(DeviceOpError::Sdk(found.found.availability));
        }
        let Some(display_name) = found.display_name(image_id) else {
            return Err(unknown());
        };
        // Cheap and unlocked, so a doomed open never runs the backend's check, and an image
        // BiBCode already runs is attached before the check could call it busy; the admission
        // under the lock below stays authoritative.
        let admission = self.inner.table().admit(platform, image_id);
        if let Admission::Attach(device_id) = admission? {
            return Ok(device_id);
        }
        match entry.backend.check_available(image_id).await {
            Ok(()) => {}
            Err(LaunchFailure::Busy) => {
                // A concurrent open of this image may have started it meanwhile, which the
                // check sees as busy; no slot is reserved before the check, so look again.
                let table = self.inner.table();
                if table.owner_deleted(owner.as_deref()) {
                    return Err(DeviceOpError::OwnerDeleted);
                }
                return match table.admit(platform, image_id) {
                    Ok(Admission::Attach(device_id)) => Ok(device_id),
                    Err(stopping @ DeviceOpError::NotReady(_)) => Err(stopping),
                    _ => Err(DeviceOpError::Busy {
                        image_id: image_id.to_owned(),
                    }),
                };
            }
            Err(error) => {
                tracing::warn!(?error, "device availability check failed");
                return Err(DeviceOpError::Emulator(
                    "The server could not check whether this device can start. Try again in a moment."
                        .into(),
                ));
            }
        }
        let backend = entry.backend.clone();
        let started = Instant::now();
        let device_id = self.inner.new_device_id();
        let cancel = CancellationToken::new();
        {
            let mut table = self.inner.table();
            // Checked under the lock the setting follower and shutdown take, so neither can
            // miss a device opened while they stop the others.
            if !self.inner.accepting() {
                return Err(DeviceOpError::Disabled);
            }
            // And under the lock `stop_thread` takes, so a deletion that landed while this open
            // waited on discovery or the check starts nothing.
            if table.owner_deleted(owner.as_deref()) {
                return Err(DeviceOpError::OwnerDeleted);
            }
            if let Admission::Attach(device_id) = table.admit(platform, image_id)? {
                return Ok(device_id);
            }
            let seq = table.next_seq;
            table.next_seq += 1;
            table.slots.insert(
                device_id.clone(),
                Slot {
                    snapshot: DeviceSnapshot {
                        device_id: device_id.clone(),
                        platform,
                        image_id: image_id.to_owned(),
                        state: DeviceState::Starting,
                        failure: None,
                        width: None,
                        height: None,
                        orientation: Orientation::Portrait,
                        // Until the running device says otherwise.
                        can_rotate: true,
                        thread_id: owner,
                    },
                    running: None,
                    cancel: cancel.clone(),
                    reaped: CancellationToken::new(),
                    started,
                    display_name,
                    seq,
                    frames: None,
                    media: None,
                },
            );
            self.inner.publish(&mut table);
        }
        self.inner
            .record_lifecycle(platform, "start", started, None);
        self.inner.tasks.spawn(self.inner.clone().launch(
            device_id.clone(),
            backend,
            image_id.to_owned(),
            cancel,
        ));
        Ok(device_id)
    }

    /// Waits until `device_id` leaves `Starting`/`Booting`: its snapshot once `Ready`,
    /// otherwise `NotReady` with the state it reached, or still had after `timeout`.
    pub async fn wait_ready(
        &self,
        device_id: &str,
        timeout: Duration,
    ) -> Result<DeviceSnapshot, DeviceOpError> {
        let find = |catalog: &DeviceCatalog| {
            catalog
                .devices
                .iter()
                .find(|device| device.device_id == device_id)
                .cloned()
        };
        let mut catalog = self.catalog();
        let _ = tokio::time::timeout(
            timeout,
            catalog.wait_for(|catalog| {
                find(catalog).is_none_or(|device| {
                    !matches!(device.state, DeviceState::Starting | DeviceState::Booting)
                })
            }),
        )
        .await;
        let current = find(&catalog.borrow());
        match current {
            None => Err(DeviceOpError::NotFound),
            Some(device) if device.state == DeviceState::Ready => Ok(device),
            Some(device) => Err(DeviceOpError::NotReady(device.state)),
        }
    }

    /// Stops `device_id` and returns once it has ended and its emulator process is gone;
    /// closing an ended device succeeds. The stop runs on the manager's tasks, so dropping
    /// this future never leaves the device half-stopped.
    pub async fn close(&self, device_id: &str) -> Result<(), DeviceOpError> {
        self.inner.close(device_id).await
    }

    /// For a deleted thread: refuses it as an owner from now on, and starts stopping every
    /// device it started that is still starting, booting, or ready. Returns without waiting
    /// for the stops, which run on the manager's tasks and log as any stop does.
    pub fn stop_thread(&self, thread_id: &str) {
        let mut table = self.inner.table();
        table.record_deletion(thread_id);
        let owned: Vec<String> = table
            .slots
            .iter()
            .filter(|(_, slot)| {
                slot.snapshot.thread_id.as_deref() == Some(thread_id) && stoppable(&slot.snapshot)
            })
            .map(|(id, _)| id.clone())
            .collect();
        if owned.is_empty() {
            return;
        }
        for id in &owned {
            if let Some(slot) = table.slots.get_mut(id) {
                self.inner.begin_stop(id, slot);
            }
        }
        self.inner.publish(&mut table);
    }

    /// Tests only: later device ids count down, so id order is the reverse of open order.
    #[cfg(test)]
    pub(crate) fn issue_descending_ids(&self) {
        *self
            .inner
            .descending_ids
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(10_000);
    }

    /// A PNG of a `Ready` device's screen, at most `max_width` wide in its current
    /// orientation.
    pub(crate) async fn png(&self, device_id: &str, max_width: u32) -> Result<Png, DeviceOpError> {
        let (device, orientation) = self.inner.running(device_id)?;
        let (native_width, native_height) = device.native_size();
        let (width, _) = oriented_size(native_width, native_height, orientation);
        device.png(width.min(max_width)).await.map_err(|error| {
            tracing::warn!(%error, "device screenshot failed");
            DeviceOpError::Emulator(
                "The device did not return a screenshot. Try again in a moment.".into(),
            )
        })
    }

    /// [`png`](Self::png)'s bytes, MIME type, width and height, for the opt-in
    /// real-simulator tests (`tests/ios_simulator.rs`).
    #[doc(hidden)]
    pub async fn png_for_tests(
        &self,
        device_id: &str,
        max_width: u32,
    ) -> Result<(Vec<u8>, &'static str, u32, u32), DeviceOpError> {
        let png = self.png(device_id, max_width).await?;
        Ok((png.png, png.mime_type, png.width, png.height))
    }

    /// Records the orientation the device reported and the display size in it; never what
    /// a rotate command asked for. Only the unix manager tests set it directly.
    #[cfg(all(test, unix))]
    pub(crate) fn set_reported_orientation(
        &self,
        device_id: &str,
        orientation: Orientation,
        width: u32,
        height: u32,
    ) {
        self.inner
            .set_reported_orientation(device_id, orientation, width, height);
    }

    /// Whether `enableDevicePreviews` is on and the manager is not shutting down.
    pub fn enabled(&self) -> bool {
        self.inner.accepting()
    }

    /// Refuses new devices, stops every device, and waits for the manager's tasks.
    pub async fn shutdown(&self) {
        self.inner.shutdown.cancel();
        self.inner.close_all().await;
        self.inner.tasks.close();
        self.inner.tasks.wait().await;
    }

    /// Whether the device has no open input stream.
    #[cfg(all(test, unix))]
    pub(crate) fn input_stream_closed(&self, device_id: &str) -> bool {
        let table = self.inner.table();
        table
            .slots
            .get(device_id)
            .and_then(|slot| slot.running.as_ref())
            .is_none_or(|device| device.input_stream_closed())
    }

    #[cfg(all(test, unix))]
    pub(crate) fn pid(&self, device_id: &str) -> Option<u32> {
        let table = self.inner.table();
        table.slots.get(device_id)?.running.as_ref()?.pid()
    }
}

impl Discovery {
    fn lists(&self, image_id: &str) -> bool {
        self.display_name(image_id).is_some()
    }

    fn display_name(&self, image_id: &str) -> Option<String> {
        self.found
            .images
            .iter()
            .find(|image| image.id == image_id)
            .map(|image| image.display_name.clone())
    }
}

/// Whether a device can still be stopped: it is starting, booting, or ready.
fn stoppable(device: &DeviceSnapshot) -> bool {
    matches!(
        device.state,
        DeviceState::Starting | DeviceState::Booting | DeviceState::Ready
    )
}

/// A device owner as `device.open` names it, trimmed as the client's `ThreadId` decode trims
/// (ECMAScript whitespace, not `str::trim`'s), so every published owner decodes unchanged;
/// blank is refused.
fn normalize_owner(owner: Option<&str>) -> Result<Option<String>, DeviceOpError> {
    match owner.map(crate::ecmascript::trim) {
        None => Ok(None),
        Some("") => Err(DeviceOpError::InvalidInput(
            "threadId must name a thread.".to_owned(),
        )),
        Some(owner) => Ok(Some(owner.to_owned())),
    }
}

impl DeviceTable {
    /// Devices that have not ended, a `stopping` one included, in open order.
    fn live(&self) -> Vec<&Slot> {
        let mut live: Vec<&Slot> = self
            .slots
            .values()
            .filter(|slot| !ended(slot.snapshot.state))
            .collect();
        live.sort_unstable_by_key(|slot| slot.seq);
        live
    }

    fn live_count(&self) -> usize {
        self.slots
            .values()
            .filter(|slot| !ended(slot.snapshot.state))
            .count()
    }

    /// One device per image and at most [`MAX_RUNNING_DEVICES`]: an image's live device is
    /// attached, a stopping one refuses the open until it has stopped, and otherwise a new
    /// device starts while a place is free.
    fn admit(&self, platform: Platform, image_id: &str) -> Result<Admission, DeviceOpError> {
        let live = self.live();
        if let Some(slot) = live
            .iter()
            .find(|slot| slot.snapshot.platform == platform && slot.snapshot.image_id == image_id)
        {
            return match slot.snapshot.state {
                DeviceState::Stopping => Err(DeviceOpError::NotReady(DeviceState::Stopping)),
                _ => Ok(Admission::Attach(slot.snapshot.device_id.clone())),
            };
        }
        if live.len() < MAX_RUNNING_DEVICES {
            return Ok(Admission::Start);
        }
        // The first live device on the platform in catalog order, which an older client's
        // limit banner stops, else the oldest live device.
        let running = live
            .iter()
            .find(|slot| slot.snapshot.platform == platform)
            .or(live.first())
            .map(|slot| slot.display_name.clone())
            .unwrap_or_default();
        Err(DeviceOpError::Limit { running })
    }

    fn owner_deleted(&self, owner: Option<&str>) -> bool {
        owner.is_some_and(|owner| self.deleted_threads.iter().any(|deleted| deleted == owner))
    }

    fn record_deletion(&mut self, thread_id: &str) {
        if self
            .deleted_threads
            .iter()
            .any(|deleted| deleted == thread_id)
        {
            return;
        }
        if self.deleted_threads.len() >= RECENT_DELETIONS {
            self.deleted_threads.pop_front();
        }
        self.deleted_threads.push_back(thread_id.to_owned());
    }
}

impl Inner {
    fn table(&self) -> MutexGuard<'_, DeviceTable> {
        self.devices.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A per-open id; it outlives nothing, so clients remember images, never device ids.
    fn new_device_id(&self) -> String {
        #[cfg(test)]
        if let Some(next) = self
            .descending_ids
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
        {
            *next -= 1;
            return format!("device-{next:05}");
        }
        uuid::Uuid::new_v4().to_string()
    }

    /// A `Ready` device, for one call, and the orientation the catalog shows for it.
    fn running(&self, device_id: &str) -> Result<(SharedDevice, Orientation), DeviceOpError> {
        let table = self.table();
        let slot = table.slots.get(device_id).ok_or(DeviceOpError::NotFound)?;
        match (&slot.running, slot.snapshot.state) {
            (Some(running), DeviceState::Ready) => Ok((running.clone(), slot.snapshot.orientation)),
            (_, state) => Err(DeviceOpError::NotReady(state)),
        }
    }

    /// The orientation the catalog shows for `device_id`.
    fn reported_orientation(&self, device_id: &str) -> Option<Orientation> {
        let table = self.table();
        table
            .slots
            .get(device_id)
            .map(|slot| slot.snapshot.orientation)
    }

    fn set_reported_orientation(
        &self,
        device_id: &str,
        orientation: Orientation,
        width: u32,
        height: u32,
    ) {
        let mut table = self.table();
        let Some(slot) = table.slots.get_mut(device_id) else {
            return;
        };
        // A late report must not touch a device that already stopped.
        if slot.snapshot.state != DeviceState::Ready {
            return;
        }
        let snapshot = &mut slot.snapshot;
        if (snapshot.orientation, snapshot.width, snapshot.height)
            != (orientation, Some(width), Some(height))
        {
            snapshot.orientation = orientation;
            snapshot.width = Some(width);
            snapshot.height = Some(height);
            self.publish(&mut table);
        }
    }

    fn accepting(&self) -> bool {
        *self.enabled.borrow() && !self.shutdown.is_cancelled()
    }

    /// Publishes the devices in open order, oldest first, after dropping all but the newest
    /// ended ones.
    fn publish(&self, table: &mut DeviceTable) {
        let mut ended_slots: Vec<(u64, String)> = table
            .slots
            .iter()
            .filter(|(_, slot)| ended(slot.snapshot.state))
            .map(|(id, slot)| (slot.seq, id.clone()))
            .collect();
        ended_slots.sort_unstable_by_key(|(seq, _)| std::cmp::Reverse(*seq));
        for (_, id) in ended_slots.into_iter().skip(RETAINED_ENDED_DEVICES) {
            table.slots.remove(&id);
        }
        let mut slots: Vec<&Slot> = table.slots.values().collect();
        slots.sort_unstable_by_key(|slot| slot.seq);
        let devices: Vec<DeviceSnapshot> = slots
            .into_iter()
            .map(|slot| slot.snapshot.clone())
            .collect();
        self.catalog.send_if_modified(|catalog| {
            let changed = catalog.devices != devices;
            if changed {
                catalog.devices = devices;
            }
            changed
        });
    }

    fn backend(&self, platform: Platform) -> Option<&PlatformBackend> {
        self.backends
            .iter()
            .find(|entry| entry.backend.platform() == platform)
    }

    /// Discovers every platform at once.
    async fn discover_all(&self, force: bool) {
        futures_util::future::join_all(
            self.backends
                .iter()
                .map(|entry| self.discover(entry, force)),
        )
        .await;
    }

    async fn discover(&self, entry: &PlatformBackend, force: bool) -> Discovery {
        let mut cached = entry.discovery.lock().await;
        if !force
            && let Some(discovery) = cached.as_ref()
            && discovery.at.elapsed() < DISCOVERY_TTL
        {
            return discovery.clone();
        }
        let mut found = entry.backend.discover().await;
        let platform = entry.backend.platform();
        catalog::distinguish_display_names(platform, &mut found.images);
        self.catalog.send_if_modified(|catalog| {
            let Some(listed) = catalog
                .platforms
                .iter_mut()
                .find(|listed| listed.platform == platform)
            else {
                return false;
            };
            let changed =
                listed.availability != found.availability || listed.images != found.images;
            if changed {
                listed.availability = found.availability.clone();
                listed.images = found.images.clone();
            }
            changed
        });
        let discovery = Discovery {
            at: Instant::now(),
            found,
        };
        *cached = Some(discovery.clone());
        discovery
    }

    fn update(&self, device_id: &str, change: impl FnOnce(&mut Slot)) {
        let mut table = self.table();
        if let Some(slot) = table.slots.get_mut(device_id) {
            change(slot);
            self.publish(&mut table);
        }
    }

    /// Ends a device whose emulator process is already gone in `state`.
    fn finish(&self, device_id: &str, state: DeviceState, failure: Option<String>) {
        let mut reaped = None;
        self.update(device_id, |slot| {
            slot.snapshot.state = state;
            slot.snapshot.failure = failure;
            reaped = Some(slot.reaped.clone());
        });
        // After the catalog shows the end, so a `close` that returns sees it there.
        if let Some(reaped) = reaped {
            reaped.cancel();
        }
    }

    async fn launch(
        self: Arc<Self>,
        device_id: String,
        backend: Arc<dyn DeviceBackend>,
        image_id: String,
        cancel: CancellationToken,
    ) {
        let phases = self.clone();
        let phase_device = device_id.clone();
        let on_phase = Box::new(move |phase: DeviceState| {
            phases.update(&phase_device, |slot| {
                if slot.snapshot.state == DeviceState::Starting {
                    slot.snapshot.state = phase;
                }
            });
        });
        let platform = backend.platform();
        let result = backend.launch(&image_id, on_phase, &cancel).await;
        let started = self.started(&device_id);
        let error = match result {
            Ok(running) => {
                let native = running.native_size();
                // A device that boots turned is shown turned from its first `Ready` entry.
                let orientation = running.orientation();
                let (width, height) = oriented_size(native.0, native.1, orientation);
                let can_rotate = running.can_rotate();
                let orientation_changes = running.orientation_changes();
                let unwanted = {
                    let mut table = self.table();
                    match table.slots.get_mut(&device_id) {
                        Some(slot)
                            if matches!(
                                slot.snapshot.state,
                                DeviceState::Starting | DeviceState::Booting
                            ) =>
                        {
                            slot.snapshot.state = DeviceState::Ready;
                            slot.snapshot.orientation = orientation;
                            slot.snapshot.width = Some(width);
                            slot.snapshot.height = Some(height);
                            slot.snapshot.can_rotate = can_rotate;
                            slot.running = Some(Arc::new(running));
                            self.publish(&mut table);
                            None
                        }
                        _ => Some(running),
                    }
                };
                match unwanted {
                    None => {
                        self.record_lifecycle(platform, "ready", started, None);
                        if let Some(changes) = orientation_changes {
                            self.tasks.spawn(self.clone().follow_orientation(
                                device_id.clone(),
                                native,
                                changes,
                                cancel.clone(),
                            ));
                        }
                        self.tasks
                            .spawn(self.clone().watch_exit(device_id, cancel.clone()));
                    }
                    // Closed while it booted: whoever closed it waits for this stop.
                    Some(running) => {
                        running.stop().await;
                        self.finish(&device_id, DeviceState::Stopped, None);
                        self.record_lifecycle(platform, "stop", started, None);
                    }
                }
                return;
            }
            Err(error) => error,
        };
        // The backend already stopped what it started.
        if matches!(error, LaunchFailure::Cancelled) || cancel.is_cancelled() {
            self.finish(&device_id, DeviceState::Stopped, None);
            self.record_lifecycle(platform, "stop", started, None);
            return;
        }
        let (failure_kind, failure) = launch_failure(&error);
        self.finish(&device_id, DeviceState::Failed, Some(failure));
        self.record_lifecycle(platform, "fail", started, Some(failure_kind));
    }

    /// Shows each orientation a running device reports, with its display size in it, until
    /// the device stops.
    async fn follow_orientation(
        self: Arc<Self>,
        device_id: String,
        native: (u32, u32),
        mut changes: futures_util::stream::BoxStream<'static, Orientation>,
        cancel: CancellationToken,
    ) {
        use futures_util::StreamExt as _;
        loop {
            let orientation = tokio::select! {
                () = cancel.cancelled() => return,
                next = changes.next() => match next {
                    Some(orientation) => orientation,
                    None => return,
                },
            };
            let (width, height) = oriented_size(native.0, native.1, orientation);
            self.set_reported_orientation(&device_id, orientation, width, height);
        }
    }

    /// Polls a `Ready` device; an exit nobody asked for fails the device.
    async fn watch_exit(self: Arc<Self>, device_id: String, cancel: CancellationToken) {
        loop {
            tokio::select! {
                () = cancel.cancelled() => return,
                () = tokio::time::sleep(EXIT_POLL_INTERVAL) => {}
            }
            let (running, reason, started, platform, reaped) = {
                let mut table = self.table();
                let Some(slot) = table.slots.get_mut(&device_id) else {
                    return;
                };
                let Some(reason) = slot.running.as_ref().map(|running| running.exited()) else {
                    return;
                };
                let Some(reason) = reason else {
                    continue;
                };
                let running = slot.running.take().expect("checked above");
                slot.end_streams();
                // Published before the cleanup below, so nobody sees a dead device as Ready.
                slot.snapshot.state = DeviceState::Failed;
                slot.snapshot.failure = Some(reason.clone());
                let started = slot.started;
                let platform = slot.snapshot.platform;
                let reaped = slot.reaped.clone();
                self.publish(&mut table);
                (running, reason, started, platform, reaped)
            };
            // Before `stop`, which marks the exit as requested.
            running.report_unrequested_exit(&reason);
            self.record_lifecycle(platform, "fail", started, Some("exited"));
            stop_device(running).await;
            // A close of the Failed device waits for this.
            reaped.cancel();
            return;
        }
    }

    fn started(&self, device_id: &str) -> Instant {
        self.table()
            .slots
            .get(device_id)
            .map_or_else(Instant::now, |slot| slot.started)
    }

    /// Starts stopping `device_id` and waits until it has ended and its process is gone. The
    /// stop itself runs on `tasks`, so dropping this future changes nothing.
    async fn close(self: &Arc<Self>, device_id: &str) -> Result<(), DeviceOpError> {
        let reaped = {
            let mut table = self.table();
            let slot = table
                .slots
                .get_mut(device_id)
                .ok_or(DeviceOpError::NotFound)?;
            // Stopping, or ended while the exit watcher may still reap the process, only waits.
            let stops = stoppable(&slot.snapshot);
            let reaped = self.begin_stop(device_id, slot);
            if stops {
                self.publish(&mut table);
            }
            reaped
        };
        reaped.cancelled().await;
        Ok(())
    }

    /// Starts stopping a device that is starting, booting, or ready, under the table lock: its
    /// streams end, it shows `Stopping` (the caller publishes), its launch is cancelled, and a
    /// running device is stopped on `tasks`. Returns the token cancelled once it has ended and
    /// its process is gone.
    fn begin_stop(self: &Arc<Self>, device_id: &str, slot: &mut Slot) -> CancellationToken {
        if stoppable(&slot.snapshot) {
            // The streams end before the token, so the media hub sees why it stops.
            slot.end_streams();
            slot.snapshot.state = DeviceState::Stopping;
            slot.cancel.cancel();
            // `None` while it boots: the launch stops it and finishes the slot.
            if let Some(running) = slot.running.take() {
                let started = slot.started;
                let platform = slot.snapshot.platform;
                let this = self.clone();
                let id = device_id.to_owned();
                self.tasks.spawn(async move {
                    stop_device(running).await;
                    this.finish(&id, DeviceState::Stopped, None);
                    this.record_lifecycle(platform, "stop", started, None);
                });
            }
        }
        slot.reaped.clone()
    }

    async fn close_all(self: &Arc<Self>) {
        let ids: Vec<String> = self
            .table()
            .slots
            .iter()
            .filter(|(_, slot)| !ended(slot.snapshot.state))
            .map(|(id, _)| id.clone())
            .collect();
        futures_util::future::join_all(ids.iter().map(|id| async move {
            let _ = self.close(id).await;
        }))
        .await;
    }

    /// Holds the manager only while it acts, so dropping every handle (a failed runtime
    /// start) cancels `shutdown` through `Inner::drop` and ends the follower.
    async fn follow_setting(
        inner: Weak<Self>,
        mut enabled: watch::Receiver<bool>,
        shutdown: CancellationToken,
    ) {
        loop {
            let on = *enabled.borrow_and_update();
            {
                let Some(this) = inner.upgrade() else {
                    return;
                };
                if on {
                    // Dropping the discovery kills its tool's process group
                    // (`SupervisedChildGuard`), so shutdown never waits for a slow SDK.
                    tokio::select! {
                        () = shutdown.cancelled() => return,
                        () = this.discover_all(false) => {}
                    }
                } else {
                    this.close_all().await;
                }
            }
            tokio::select! {
                () = shutdown.cancelled() => return,
                changed = enabled.changed() => if changed.is_err() {
                    return;
                },
            }
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

/// Stops a device taken out of its slot once no call holds it any more; one still held
/// after [`STOP_RELEASE_TIMEOUT`] is stopped anyway. Runs on the manager's tasks, never on a
/// caller's future.
async fn stop_device(mut device: SharedDevice) {
    let deadline = Instant::now() + STOP_RELEASE_TIMEOUT;
    loop {
        match Arc::try_unwrap(device) {
            Ok(device) => return device.stop().await,
            Err(shared) if Instant::now() >= deadline => {
                tracing::warn!("a device call still held the device after 5 s; stopping it anyway");
                return shared.stop_shared().await;
            }
            Err(shared) => {
                device = shared;
                tokio::time::sleep(STOP_RELEASE_POLL).await;
            }
        }
    }
}

/// The profiler failure kind and the catalog's failure reason for a failed launch.
fn launch_failure(error: &LaunchFailure) -> (&'static str, String) {
    match error {
        LaunchFailure::Exited(message) => ("exited", format!("exited: {message}")),
        LaunchFailure::BootTimeout => (
            "bootTimeout",
            "did not finish booting within 3 minutes".to_owned(),
        ),
        LaunchFailure::Spawn(message) => ("spawn", format!("could not start: {message}")),
        LaunchFailure::Unresponsive(message) => (
            "unresponsive",
            format!("did not report its display: {message}"),
        ),
        LaunchFailure::Cancelled => ("cancelled", "cancelled".to_owned()),
        LaunchFailure::Busy => ("busy", "in use outside BiBCode".to_owned()),
    }
}

impl Inner {
    /// A `device.lifecycle` profiler event, recorded after the transition is published, with
    /// `running`, the count of live devices then. It names the platform, never the thread, the
    /// image, or its paths. Never called under the table lock, which it takes.
    fn record_lifecycle(
        &self,
        platform: Platform,
        phase: &'static str,
        started: Instant,
        failure_kind: Option<&'static str>,
    ) {
        let payload = || {
            serde_json::json!({
                "platform": platform,
                "phase": phase,
                "durationMs": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                "failureKind": failure_kind,
                "running": self.table().live_count(),
            })
        };
        #[cfg(test)]
        lifecycle_capture::record(payload);
        if !crate::diagnostics::profiler::is_enabled() {
            return;
        }
        crate::diagnostics::profiler::emit("device.lifecycle", payload());
    }
}

/// Tests only: the `device.lifecycle` payloads recorded on this thread, whether or not the
/// process-wide profiler is on. A `#[tokio::test]` runtime runs the manager's tasks on the
/// test's thread, so parallel tests never see each other's events.
#[cfg(test)]
pub(crate) mod lifecycle_capture {
    use std::cell::RefCell;

    thread_local! {
        static EVENTS: RefCell<Option<Vec<serde_json::Value>>> = const { RefCell::new(None) };
    }

    /// Records this thread's lifecycle payloads until the guard drops.
    pub(crate) fn start() -> Capture {
        EVENTS.with(|events| *events.borrow_mut() = Some(Vec::new()));
        Capture(())
    }

    pub(super) fn record(payload: impl FnOnce() -> serde_json::Value) {
        EVENTS.with(|events| {
            if let Some(events) = events.borrow_mut().as_mut() {
                events.push(payload());
            }
        });
    }

    pub(crate) struct Capture(());

    impl Capture {
        pub(crate) fn events(&self) -> Vec<serde_json::Value> {
            EVENTS.with(|events| events.borrow().clone().unwrap_or_default())
        }
    }

    impl Drop for Capture {
        fn drop(&mut self) {
            EVENTS.with(|events| events.borrow_mut().take());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::device::android::{
        emulator, emulator_failure,
        testing::{ManagerFixture, kill_process, process_alive},
    };

    #[tokio::test]
    async fn open_publishes_states_and_a_second_image_on_the_platform_opens() {
        let fixture = ManagerFixture::ready(&["Pixel", "Tablet"]).await;
        let id = fixture
            .manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        let ready = fixture.wait_state(&id, DeviceState::Ready).await;
        assert_eq!((ready.width, ready.height), (Some(1080), Some(2400)));
        let tablet = fixture
            .manager
            .open(Platform::Android, "Tablet", None)
            .await
            .expect("a second image on one platform opens");
        assert_ne!(tablet, id);
        fixture.wait_state(&tablet, DeviceState::Ready).await;
        assert_eq!(
            fixture.wait_state(&id, DeviceState::Ready).await.state,
            DeviceState::Ready
        );
        fixture.manager.shutdown().await;
        assert_eq!(fixture.sdk.launched_pids().len(), 2);
        assert!(
            fixture
                .sdk
                .launched_pids()
                .iter()
                .all(|pid| !process_alive(*pid))
        );
    }

    #[tokio::test]
    async fn disabled_manager_refuses_and_disabling_stops_devices() {
        let fixture = ManagerFixture::ready(&["Pixel"]).await;
        let id = fixture
            .manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        fixture.wait_state(&id, DeviceState::Ready).await;
        let pid = fixture.pid_of(&id);
        fixture.enabled.send(false).unwrap();
        fixture.wait_state(&id, DeviceState::Stopped).await;
        assert!(!process_alive(pid));
        assert!(matches!(
            fixture.manager.open(Platform::Android, "Pixel", None).await,
            Err(DeviceOpError::Disabled)
        ));
    }

    #[tokio::test]
    async fn crash_marks_failed_and_frees_the_slot() {
        let fixture = ManagerFixture::ready(&["Pixel"]).await;
        let id = fixture
            .manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        fixture.wait_state(&id, DeviceState::Ready).await;
        let pid = fixture.pid_of(&id);
        kill_process(pid);
        // The moment the manager stops serving the device, the catalog already says Failed.
        crate::device::android::testing::wait_until(|| fixture.manager.inner.running(&id).is_err())
            .await;
        assert!(matches!(
            fixture.manager.inner.running(&id),
            Err(DeviceOpError::NotReady(DeviceState::Failed))
        ));
        let state = |catalog: &DeviceCatalog| {
            catalog
                .devices
                .iter()
                .find(|device| device.device_id == id)
                .map(|device| device.state)
        };
        assert_eq!(
            state(&fixture.manager.catalog().borrow()),
            Some(DeviceState::Failed)
        );
        let snapshot = fixture.wait_state(&id, DeviceState::Failed).await;
        assert!(snapshot.failure.unwrap().contains("exited"));
        // Cleanup runs after the Failed publish and reaps the process.
        crate::device::android::testing::wait_until(|| !process_alive(pid)).await;
        assert!(
            fixture
                .manager
                .open(Platform::Android, "Pixel", None)
                .await
                .is_ok()
        );
        fixture.manager.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_reaps_running_emulators() {
        let fixture = ManagerFixture::ready(&["Pixel"]).await;
        let id = fixture
            .manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        fixture.wait_state(&id, DeviceState::Ready).await;
        let pid = fixture.pid_of(&id);
        fixture.manager.shutdown().await;
        assert!(!process_alive(pid));
        assert!(matches!(
            fixture.manager.open(Platform::Android, "Pixel", None).await,
            Err(DeviceOpError::Disabled)
        ));
    }

    #[tokio::test]
    async fn unknown_avd_is_rejected_before_spawning() {
        let fixture = ManagerFixture::ready(&["Pixel"]).await;
        assert!(matches!(
            fixture.manager.open(Platform::Android, "Nope", None).await,
            Err(DeviceOpError::UnknownImage {
                platform: Platform::Android,
                ..
            })
        ));
        assert!(fixture.sdk.launched_pids().is_empty());
    }

    #[tokio::test]
    async fn refresh_is_cached_for_30_seconds() {
        let fixture = ManagerFixture::ready(&["Pixel"]).await;
        fixture.manager.refresh().await;
        fixture.manager.refresh().await;
        assert_eq!(fixture.sdk.list_avds_calls(), 1);
        let catalog = fixture.manager.catalog().borrow().clone();
        assert_eq!(catalog.platforms[0].platform, Platform::Android);
        assert_eq!(
            catalog.platforms[0].availability.kind,
            AvailabilityKind::Ready
        );
        assert_eq!(catalog.platforms[0].images[0].id, "Pixel");
        fixture.manager.refresh_now().await;
        assert_eq!(fixture.sdk.list_avds_calls(), 2);
    }

    #[tokio::test]
    async fn closing_a_booting_device_stops_its_launch() {
        let fixture = ManagerFixture::with_sdk(|sdk| sdk.avds(&["Pixel"]).never_boots()).await;
        let id = fixture
            .manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        fixture.wait_state(&id, DeviceState::Booting).await;
        fixture.manager.close(&id).await.unwrap();
        let state = fixture.manager.catalog().borrow().devices[0].state;
        assert_eq!(state, DeviceState::Stopped);
        let launched = fixture.sdk.launched_pids();
        assert_eq!(launched.len(), 1);
        assert!(launched.iter().all(|pid| !process_alive(*pid)));
        assert!(
            fixture
                .manager
                .open(Platform::Android, "Pixel", None)
                .await
                .is_ok()
        );
        fixture.manager.shutdown().await;
    }

    #[tokio::test]
    async fn a_dropped_close_still_stops_the_device() {
        use futures_util::FutureExt as _;
        let fixture = ManagerFixture::ready(&["Pixel"]).await;
        let id = fixture
            .manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        fixture.wait_state(&id, DeviceState::Ready).await;
        let pid = fixture.pid_of(&id);
        // One poll starts the stop; the RPC or MCP request is then dropped mid-stop.
        assert!(fixture.manager.close(&id).now_or_never().is_none());
        tokio::time::timeout(
            Duration::from_secs(20),
            fixture.wait_state(&id, DeviceState::Stopped),
        )
        .await
        .expect("the stop finishes without its caller");
        crate::device::android::testing::wait_until(|| !process_alive(pid)).await;
        let next = fixture
            .manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        fixture.wait_state(&next, DeviceState::Ready).await;
        tokio::time::timeout(Duration::from_secs(20), fixture.manager.shutdown())
            .await
            .expect("shutdown ends");
    }

    #[tokio::test]
    async fn closing_a_crashed_device_waits_for_its_process() {
        let fixture = ManagerFixture::ready(&["Pixel"]).await;
        let id = fixture
            .manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        fixture.wait_state(&id, DeviceState::Ready).await;
        let pid = fixture.pid_of(&id);
        kill_process(pid);
        crate::device::android::testing::wait_until(|| fixture.manager.inner.running(&id).is_err())
            .await;
        tokio::time::timeout(Duration::from_secs(20), fixture.manager.close(&id))
            .await
            .expect("close ends")
            .unwrap();
        assert!(!process_alive(pid));
        fixture.manager.shutdown().await;
    }

    #[tokio::test]
    async fn wait_ready_returns_a_launch_failure_without_waiting() {
        let fixture = ManagerFixture::with_sdk(|sdk| {
            sdk.avds(&["Pixel"]).launch_stub(
                crate::device::android::testing::LaunchStub::ExitsWith(
                    1,
                    "PANIC: Missing emulator engine",
                ),
            )
        })
        .await;
        let id = fixture
            .manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        let started = Instant::now();
        let result = fixture
            .manager
            .wait_ready(&id, emulator::BOOT_TIMEOUT)
            .await;
        assert!(
            matches!(result, Err(DeviceOpError::NotReady(DeviceState::Failed))),
            "{result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        let snapshot = fixture.wait_state(&id, DeviceState::Failed).await;
        assert!(
            snapshot
                .failure
                .unwrap()
                .contains("Missing emulator engine")
        );
    }

    #[tokio::test]
    async fn ready_device_exposes_its_client_and_orientation() {
        let fixture = ManagerFixture::ready(&["Pixel"]).await;
        let id = fixture
            .manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        assert!(matches!(
            fixture.manager.inner.running(&id),
            Err(DeviceOpError::NotReady(_))
        ));
        let ready = fixture
            .manager
            .wait_ready(&id, emulator::BOOT_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(ready.state, DeviceState::Ready);
        fixture.wait_state(&id, DeviceState::Ready).await;
        let (running, orientation) = fixture.manager.inner.running(&id).unwrap();
        assert_eq!(running.native_size(), (1080, 2400));
        assert_eq!(orientation, Orientation::Portrait);
        drop(running);
        fixture
            .manager
            .set_reported_orientation(&id, Orientation::Landscape, 2400, 1080);
        let device = fixture.manager.catalog().borrow().devices[0].clone();
        assert_eq!(
            (device.orientation, device.width, device.height),
            (Orientation::Landscape, Some(2400), Some(1080))
        );
        // The native size stays what input maps against.
        let (running, orientation) = fixture.manager.inner.running(&id).unwrap();
        assert_eq!(
            (running.native_size(), orientation),
            ((1080, 2400), Orientation::Landscape)
        );
        drop(running);
        assert!(matches!(
            fixture.manager.inner.running("missing"),
            Err(DeviceOpError::NotFound)
        ));
        fixture.manager.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_does_not_wait_for_a_slow_sdk_listing() {
        let fixture =
            ManagerFixture::with_sdk(|sdk| sdk.avds(&["Pixel"]).list_avds_delay_secs(60)).await;
        // The setting is on, so the follower is already listing AVDs.
        crate::device::android::testing::wait_until(|| fixture.sdk.list_avds_calls() == 1).await;
        let started = Instant::now();
        fixture.manager.shutdown().await;
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn dropping_the_manager_ends_the_setting_follower() {
        let fixture = ManagerFixture::ready(&["Pixel"]).await;
        fixture.manager.refresh().await;
        let inner = Arc::downgrade(&fixture.manager.inner);
        let tasks = fixture.manager.inner.tasks.clone();
        drop(fixture.manager);
        tokio::time::timeout(Duration::from_secs(5), async {
            tasks.close();
            tasks.wait().await;
        })
        .await
        .expect("the follower ends once the manager is dropped");
        assert!(inner.upgrade().is_none());
        // The setting sender is still alive, so only the dropped manager ended the follower.
        drop(fixture.enabled);
    }

    #[test]
    fn errors_map_to_contract_tags() {
        assert_eq!(
            DeviceOpError::Limit {
                running: "Pixel".into()
            }
            .to_rpc_error(),
            serde_json::json!({
                "_tag": "DeviceLimitError",
                "running": "Pixel",
                "message": "Four devices are already running, the most this server runs at once. Stop one to start another.",
            })
        );
        let sdk = DeviceOpError::Sdk(Availability {
            kind: AvailabilityKind::NoAvds,
            message: "Create a virtual device.".into(),
        })
        .to_rpc_error();
        assert_eq!(sdk["_tag"], "DeviceSdkUnavailableError");
        assert_eq!(sdk["kind"], "noAvds");
        assert_eq!(sdk["message"], "Create a virtual device.");
        let unknown = DeviceOpError::UnknownImage {
            platform: Platform::Android,
            image_id: "Nope".into(),
        }
        .to_rpc_error();
        assert_eq!(unknown["_tag"], "DeviceNotFoundError");
        assert_eq!(
            unknown["message"],
            "No virtual device named \"Nope\" exists on the server. Choose one from the device list, or create it in Android Studio's Device Manager."
        );
        let not_ready = DeviceOpError::NotReady(DeviceState::Booting).to_rpc_error();
        assert_eq!(not_ready["_tag"], "DeviceNotReadyError");
        assert_eq!(not_ready["state"], "booting");
        assert_eq!(
            DeviceOpError::Disabled.to_rpc_error()["_tag"],
            "DevicePreviewsDisabledError"
        );
        assert_eq!(
            DeviceOpError::NotFound.to_rpc_error()["_tag"],
            "DeviceNotFoundError"
        );
        let media = DeviceOpError::MediaUnavailable.to_rpc_error();
        assert_eq!(media["_tag"], "DeviceMediaUnavailableError");
        assert!(
            media["message"]
                .as_str()
                .unwrap()
                .contains("--unsafe-no-auth")
        );
        assert_eq!(
            DeviceOpError::InvalidInput("Send at least one input event.".into()).to_rpc_error(),
            serde_json::json!({
                "_tag": "DeviceInputError",
                "message": "Send at least one input event.",
            })
        );
        let emulator = emulator_failure("input", &DeviceError::Grpc("unavailable".into()));
        assert_eq!(
            emulator.to_rpc_error(),
            serde_json::json!({
                "_tag": "DeviceEmulatorError",
                "message": "The emulator did not accept the input. Try again; if it keeps failing, stop the device and start it again.",
            })
        );
    }

    #[test]
    fn launch_failures_name_their_reason() {
        assert_eq!(
            launch_failure(&LaunchFailure::Exited("boom".into())),
            ("exited", "exited: boom".to_owned())
        );
        assert_eq!(
            launch_failure(&LaunchFailure::BootTimeout),
            (
                "bootTimeout",
                "did not finish booting within 3 minutes".to_owned()
            )
        );
        assert_eq!(launch_failure(&LaunchFailure::Spawn("x".into())).0, "spawn");
        assert_eq!(
            launch_failure(&LaunchFailure::Unresponsive("x".into())).0,
            "unresponsive"
        );
    }
}

#[cfg(test)]
mod platform_tests {
    use super::{
        fake_backend::{FakeBackend, fake_manager, wait_state},
        *,
    };
    use crate::device::catalog::Platform;

    /// The image ids of the catalog's devices, in catalog order.
    fn listed(manager: &DeviceManager) -> Vec<String> {
        manager
            .catalog()
            .borrow()
            .devices
            .iter()
            .map(|device| device.image_id.clone())
            .collect()
    }

    fn snapshot_of(manager: &DeviceManager, device_id: &str) -> DeviceSnapshot {
        manager
            .catalog()
            .borrow()
            .devices
            .iter()
            .find(|device| device.device_id == device_id)
            .cloned()
            .expect("device in catalog")
    }

    #[tokio::test]
    async fn devices_of_both_platforms_and_several_per_platform_run_side_by_side() {
        let android = FakeBackend::new(Platform::Android, &["Pixel"]);
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1", "UDID-2"]);
        let (manager, _enabled) = fake_manager(vec![android.clone(), ios.clone()]);
        let a = manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        let i = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        let j = manager.open(Platform::Ios, "UDID-2", None).await.unwrap();
        wait_state(&manager, &a, DeviceState::Ready).await;
        let ios_ready = wait_state(&manager, &i, DeviceState::Ready).await;
        assert_eq!(
            (ios_ready.platform, ios_ready.image_id.as_str()),
            (Platform::Ios, "UDID-1")
        );
        assert_eq!(
            wait_state(&manager, &j, DeviceState::Ready).await.image_id,
            "UDID-2"
        );
        assert_eq!(ios.check_calls(), 2);
        manager.shutdown().await;
        assert_eq!((android.stops(), ios.stops()), (1, 2));
    }

    #[tokio::test]
    async fn four_devices_run_at_once_and_a_stopping_one_counts() {
        let android = FakeBackend::new(Platform::Android, &["A", "B", "C", "D", "E"]);
        let (manager, _enabled) = fake_manager(vec![android.clone()]);
        let mut ids = Vec::new();
        for image in ["A", "B", "C", "D"] {
            let id = manager.open(Platform::Android, image, None).await.unwrap();
            wait_state(&manager, &id, DeviceState::Ready).await;
            ids.push(id);
        }
        let refused = manager.open(Platform::Android, "E", None).await;
        assert!(
            matches!(refused, Err(DeviceOpError::Limit { ref running }) if running == "iPhone A"),
            "{refused:?}"
        );
        // The doomed open never reached the backend's availability check.
        assert_eq!(android.check_calls(), 4);
        let held = android.hold_next_stop();
        {
            use futures_util::FutureExt as _;
            assert!(manager.close(&ids[0]).now_or_never().is_none());
        }
        wait_state(&manager, &ids[0], DeviceState::Stopping).await;
        assert!(matches!(
            manager.open(Platform::Android, "E", None).await,
            Err(DeviceOpError::Limit { .. })
        ));
        held.release();
        wait_state(&manager, &ids[0], DeviceState::Stopped).await;
        let fifth = manager.open(Platform::Android, "E", None).await.unwrap();
        wait_state(&manager, &fifth, DeviceState::Ready).await;
        assert_eq!(android.launches(), 5);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn the_catalog_lists_devices_in_open_order_and_the_limit_names_the_oldest() {
        let android = FakeBackend::new(Platform::Android, &["Pixel", "Tablet", "Fold"]);
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1", "UDID-2", "UDID-3"]);
        let (manager, _enabled) = fake_manager(vec![android, ios]);
        // Ids count down, so sorting by id would list the newest first.
        manager.issue_descending_ids();
        let first = manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        for (platform, image) in [
            (Platform::Ios, "UDID-1"),
            (Platform::Android, "Tablet"),
            (Platform::Ios, "UDID-2"),
        ] {
            manager.open(platform, image, None).await.unwrap();
        }
        let ids: Vec<String> = manager
            .catalog()
            .borrow()
            .devices
            .iter()
            .map(|device| device.device_id.clone())
            .collect();
        assert!(ids.windows(2).all(|pair| pair[0] > pair[1]), "{ids:?}");
        assert_eq!(listed(&manager), ["Pixel", "UDID-1", "Tablet", "UDID-2"]);
        // The first live device of the platform asked for, which an older client stops.
        assert!(matches!(
            manager.open(Platform::Ios, "UDID-3", None).await,
            Err(DeviceOpError::Limit { running }) if running == "iPhone UDID-1"
        ));
        assert!(matches!(
            manager.open(Platform::Android, "Fold", None).await,
            Err(DeviceOpError::Limit { running }) if running == "iPhone Pixel"
        ));
        manager.close(&first).await.unwrap();
        // The ended device keeps its place in open order.
        assert_eq!(listed(&manager), ["Pixel", "UDID-1", "Tablet", "UDID-2"]);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn opening_a_live_image_returns_its_device_and_keeps_its_owner() {
        // Starting: the launch is held before it reports booting.
        let android = FakeBackend::new(Platform::Android, &["Pixel"]);
        let (manager, _enabled) = fake_manager(vec![android.clone()]);
        let held = android.hold_next_launch();
        let id = manager
            .open(Platform::Android, "Pixel", Some("t1"))
            .await
            .unwrap();
        assert_eq!(snapshot_of(&manager, &id).state, DeviceState::Starting);
        let again = manager.open(Platform::Android, "Pixel", Some("t2")).await;
        assert_eq!(again.as_deref(), Ok(id.as_str()));
        held.release();
        // Ready.
        wait_state(&manager, &id, DeviceState::Ready).await;
        let again = manager.open(Platform::Android, "Pixel", None).await;
        assert_eq!(again.as_deref(), Ok(id.as_str()));
        assert_eq!(android.launches(), 1);
        assert_eq!(snapshot_of(&manager, &id).thread_id.as_deref(), Some("t1"));
        manager.shutdown().await;

        // Booting.
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        ios.never_boots();
        let (manager, _enabled) = fake_manager(vec![ios.clone()]);
        let id = manager
            .open(Platform::Ios, "UDID-1", Some("t1"))
            .await
            .unwrap();
        wait_state(&manager, &id, DeviceState::Booting).await;
        let again = manager.open(Platform::Ios, "UDID-1", Some("t2")).await;
        assert_eq!(again.as_deref(), Ok(id.as_str()));
        assert_eq!((ios.launches(), ios.check_calls()), (1, 1));
        assert_eq!(manager.catalog().borrow().devices.len(), 1);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn opening_a_stopping_image_is_refused_until_it_has_stopped() {
        let android = FakeBackend::new(Platform::Android, &["Pixel"]);
        let (manager, _enabled) = fake_manager(vec![android.clone()]);
        let id = manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        wait_state(&manager, &id, DeviceState::Ready).await;
        let held = android.hold_next_stop();
        {
            use futures_util::FutureExt as _;
            assert!(manager.close(&id).now_or_never().is_none());
        }
        wait_state(&manager, &id, DeviceState::Stopping).await;
        let refused = manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap_err();
        assert_eq!(refused, DeviceOpError::NotReady(DeviceState::Stopping));
        assert_eq!(
            refused.to_rpc_error()["message"],
            "This device is still stopping. Start it again once it has stopped."
        );
        assert_eq!(android.launches(), 1);
        held.release();
        wait_state(&manager, &id, DeviceState::Stopped).await;
        let next = manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        assert_ne!(next, id);
        wait_state(&manager, &next, DeviceState::Ready).await;
        assert_eq!(android.launches(), 2);
        manager.shutdown().await;
    }

    /// Two opens of one simulator race: the second waits in the availability check while the
    /// first starts the image, so the check then sees it booted and calls it busy.
    #[tokio::test]
    async fn opens_of_one_image_racing_through_a_busy_check_share_its_device() {
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        let (manager, _enabled) = fake_manager(vec![ios.clone()]);
        let mut held = ios.hold_next_check();
        let second = tokio::spawn({
            let manager = manager.clone();
            async move { manager.open(Platform::Ios, "UDID-1", Some("t2")).await }
        });
        held.reached().await;
        let first = manager
            .open(Platform::Ios, "UDID-1", Some("t1"))
            .await
            .unwrap();
        ios.busy("UDID-1");
        held.release();
        assert_eq!(second.await.unwrap().as_deref(), Ok(first.as_str()));
        assert_eq!(ios.launches(), 1);
        assert_eq!(
            snapshot_of(&manager, &first).thread_id.as_deref(),
            Some("t1")
        );
        ios.not_busy("UDID-1");
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn an_owner_is_published_trimmed_and_a_blank_one_is_refused() {
        let android = FakeBackend::new(Platform::Android, &["Pixel", "Tablet"]);
        let (manager, _enabled) = fake_manager(vec![android.clone()]);
        let owned = manager
            .open(Platform::Android, "Pixel", Some(" t1 "))
            .await
            .unwrap();
        assert_eq!(
            snapshot_of(&manager, &owned).thread_id.as_deref(),
            Some("t1")
        );
        let catalog = serde_json::to_value(&*manager.catalog().borrow()).unwrap();
        assert_eq!(catalog["devices"][0]["threadId"], "t1");
        let blank = manager
            .open(Platform::Android, "Tablet", Some("  "))
            .await
            .unwrap_err();
        assert_eq!(
            blank.to_rpc_error(),
            serde_json::json!({
                "_tag": "DeviceInputError",
                "message": "threadId must name a thread.",
            })
        );
        // The client's `ThreadId` trims as ECMAScript does, which takes U+FEFF and leaves
        // U+0085, unlike `str::trim`: a BOM-only owner would publish an id the client
        // cannot decode, failing the whole catalog.
        let bom = manager
            .open(Platform::Android, "Tablet", Some("\u{feff}"))
            .await
            .unwrap_err();
        assert_eq!(bom.to_rpc_error()["_tag"], "DeviceInputError");
        let unowned = manager
            .open(Platform::Android, "Tablet", None)
            .await
            .unwrap();
        let catalog = serde_json::to_value(&*manager.catalog().borrow()).unwrap();
        let entry = catalog["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|device| device["deviceId"] == unowned.as_str())
            .unwrap()
            .clone();
        assert!(entry.get("threadId").is_none(), "{entry}");
        wait_state(&manager, &owned, DeviceState::Ready).await;
        wait_state(&manager, &unowned, DeviceState::Ready).await;
        assert_eq!(android.launches(), 2);
        manager.shutdown().await;
    }

    /// The catalog the server publishes with owned, unowned, and ended devices, which the
    /// TypeScript contract decodes and encodes back unchanged (`device.test.ts`).
    /// Regenerate with `BIBCODE_UPDATE_DEVICE_FIXTURE=1`.
    #[tokio::test]
    async fn the_owned_catalog_fixture_matches_the_wire() {
        let android = FakeBackend::new(Platform::Android, &["Pixel", "Tablet", "Fold"]);
        let (manager, _enabled) = fake_manager(vec![android]);
        manager.issue_descending_ids();
        let owned = manager
            .open(Platform::Android, "Pixel", Some(" t1 "))
            .await
            .unwrap();
        let unowned = manager
            .open(Platform::Android, "Tablet", None)
            .await
            .unwrap();
        let ended = manager
            .open(Platform::Android, "Fold", Some("t2"))
            .await
            .unwrap();
        wait_state(&manager, &owned, DeviceState::Ready).await;
        wait_state(&manager, &unowned, DeviceState::Ready).await;
        wait_state(&manager, &ended, DeviceState::Ready).await;
        manager.close(&ended).await.unwrap();
        wait_state(&manager, &ended, DeviceState::Stopped).await;
        let catalog = serde_json::to_value(&*manager.catalog().borrow()).unwrap();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/fixtures/device/catalog.json");
        if std::env::var_os("BIBCODE_UPDATE_DEVICE_FIXTURE").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                &path,
                serde_json::to_string_pretty(&catalog).unwrap() + "\n",
            )
            .unwrap();
        }
        let committed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("committed fixture"))
                .expect("fixture JSON");
        assert_eq!(catalog, committed, "regenerate the device catalog fixture");
        manager.shutdown().await;
    }

    /// An owner is published as the client's `ThreadId` decode would leave it, so it
    /// round-trips unchanged: ECMAScript whitespace, U+FEFF included, is trimmed, and
    /// U+0085, which ECMAScript keeps, stays.
    #[test]
    fn an_owner_is_trimmed_as_the_clients_thread_id_is() {
        assert_eq!(
            super::normalize_owner(Some("\u{feff}\u{3000} t1\t\u{feff}")).unwrap(),
            Some("t1".to_owned())
        );
        assert_eq!(
            super::normalize_owner(Some("t1\u{85}")).unwrap(),
            Some("t1\u{85}".to_owned())
        );
        assert!(super::normalize_owner(Some("\u{feff} \u{2028}")).is_err());
        assert_eq!(super::normalize_owner(None).unwrap(), None);
    }

    #[tokio::test]
    async fn stop_thread_stops_only_its_live_devices_and_does_not_wait() {
        let android = FakeBackend::new(Platform::Android, &["Pixel", "Tablet"]);
        let (manager, _enabled) = fake_manager(vec![android.clone()]);
        let mine = manager
            .open(Platform::Android, "Pixel", Some("t1"))
            .await
            .unwrap();
        let theirs = manager
            .open(Platform::Android, "Tablet", Some("t2"))
            .await
            .unwrap();
        wait_state(&manager, &mine, DeviceState::Ready).await;
        wait_state(&manager, &theirs, DeviceState::Ready).await;
        let held = android.hold_next_stop();
        manager.stop_thread("t1");
        // Returned while the stop is still held.
        assert_eq!(snapshot_of(&manager, &mine).state, DeviceState::Stopping);
        assert_eq!(snapshot_of(&manager, &theirs).state, DeviceState::Ready);
        held.release();
        let stopped = wait_state(&manager, &mine, DeviceState::Stopped).await;
        assert_eq!(stopped.thread_id.as_deref(), Some("t1"));
        assert_eq!(snapshot_of(&manager, &theirs).state, DeviceState::Ready);
        assert_eq!(android.stops(), 1);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn a_deleted_threads_booting_device_ends_stopped() {
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        ios.never_boots();
        let (manager, _enabled) = fake_manager(vec![ios]);
        let id = manager
            .open(Platform::Ios, "UDID-1", Some("t1"))
            .await
            .unwrap();
        wait_state(&manager, &id, DeviceState::Booting).await;
        manager.stop_thread("t1");
        wait_state(&manager, &id, DeviceState::Stopped).await;
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn a_deletion_while_an_open_waits_on_discovery_refuses_it() {
        let android = FakeBackend::new(Platform::Android, &["Pixel"]);
        let (manager, _enabled) = fake_manager(vec![android.clone()]);
        manager.refresh().await;
        // Not in the cached discovery, so the open discovers again.
        android.add_image("Tablet");
        let mut held = android.hold_next_discover();
        let open = tokio::spawn({
            let manager = manager.clone();
            async move { manager.open(Platform::Android, "Tablet", Some("t1")).await }
        });
        held.reached().await;
        manager.stop_thread("t1");
        held.release();
        assert_eq!(open.await.unwrap(), Err(DeviceOpError::OwnerDeleted));
        assert!(manager.catalog().borrow().devices.is_empty());
        assert_eq!(android.launches(), 0);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn a_deletion_while_an_open_waits_on_the_check_refuses_it() {
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        let (manager, _enabled) = fake_manager(vec![ios.clone()]);
        let mut held = ios.hold_next_check();
        let open = tokio::spawn({
            let manager = manager.clone();
            async move { manager.open(Platform::Ios, "UDID-1", Some("t1")).await }
        });
        held.reached().await;
        manager.stop_thread("t1");
        held.release();
        assert_eq!(open.await.unwrap(), Err(DeviceOpError::OwnerDeleted));
        assert!(manager.catalog().borrow().devices.is_empty());
        assert_eq!(ios.launches(), 0);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn an_open_for_a_recently_deleted_thread_is_refused() {
        let android = FakeBackend::new(Platform::Android, &["Pixel"]);
        let (manager, _enabled) = fake_manager(vec![android.clone()]);
        manager.stop_thread("t1");
        let refused = manager
            .open(Platform::Android, "Pixel", Some("t1"))
            .await
            .unwrap_err();
        assert_eq!(
            refused.to_rpc_error(),
            serde_json::json!({
                "_tag": "DeviceNotFoundError",
                "message": "This thread was deleted, so its device was not started.",
            })
        );
        assert_eq!(android.launches(), 0);
        // The oldest of more than 256 deletions is forgotten.
        for index in 0..RECENT_DELETIONS {
            manager.stop_thread(&format!("later-{index}"));
        }
        let id = manager
            .open(Platform::Android, "Pixel", Some("t1"))
            .await
            .unwrap();
        wait_state(&manager, &id, DeviceState::Ready).await;
        assert!(matches!(
            manager
                .open(Platform::Android, "Pixel", Some("later-0"))
                .await,
            Err(DeviceOpError::OwnerDeleted)
        ));
        manager.shutdown().await;
    }

    #[test]
    fn thread_refusals_map_to_existing_contract_tags() {
        let busy = |error: DeviceOpError| error.to_rpc_error();
        assert_eq!(
            busy(DeviceOpError::InUseByAnotherThread {
                image_id: "Pixel_8".into(),
                name: "Pixel 8".into(),
            }),
            serde_json::json!({
                "_tag": "DeviceBusyError",
                "imageId": "Pixel_8",
                "message": "Pixel 8 is in use by another thread. Start a different image, or look at it with device_screenshot.",
            })
        );
        assert_eq!(
            busy(DeviceOpError::StartedByAnotherThread {
                image_id: "Pixel_8".into(),
                name: "Pixel 8".into(),
            }),
            serde_json::json!({
                "_tag": "DeviceBusyError",
                "imageId": "Pixel_8",
                "message": "Pixel 8 was started by another thread. Ask the user to stop it.",
            })
        );
        assert_eq!(
            DeviceOpError::NotReady(DeviceState::Stopped).to_string(),
            "The device has stopped. Start it again from the device list."
        );
    }

    #[tokio::test]
    async fn lifecycle_events_name_the_platform() {
        // The capture records whether or not the profiler is on; the gate is not covered here.
        let capture = lifecycle_capture::start();
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        let (manager, _enabled) = fake_manager(vec![ios]);
        let id = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        wait_state(&manager, &id, DeviceState::Ready).await;
        manager.close(&id).await.unwrap();
        let events = capture.events();
        let phases: Vec<_> = events.iter().map(|e| e["phase"].clone()).collect();
        assert_eq!(phases, ["start", "ready", "stop"]);
        let running: Vec<_> = events.iter().map(|e| e["running"].clone()).collect();
        assert_eq!(running, [1, 1, 0], "live devices after each transition");
        assert!(events.iter().all(|e| e["platform"] == "ios"), "{events:?}");
        assert!(
            events
                .iter()
                .all(|e| e.get("imageId").is_none() && !e.to_string().contains("UDID-1")),
            "never names the image: {events:?}"
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn a_busy_image_is_refused_and_leaves_no_slot() {
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        ios.busy("UDID-1");
        let (manager, _enabled) = fake_manager(vec![ios.clone()]);
        assert!(matches!(
            manager.open(Platform::Ios, "UDID-1", None).await,
            Err(DeviceOpError::Busy { image_id }) if image_id == "UDID-1"
        ));
        assert!(manager.catalog().borrow().devices.is_empty());
        assert_eq!(ios.launches(), 0);
    }

    #[tokio::test]
    async fn an_image_found_busy_at_launch_fails_its_slot() {
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        ios.busy_on_launch("UDID-1");
        let (manager, _enabled) = fake_manager(vec![ios.clone()]);
        let id = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        let failed = wait_state(&manager, &id, DeviceState::Failed).await;
        assert_eq!(failed.failure.as_deref(), Some("in use outside BiBCode"));
        assert_eq!(ios.stops(), 0);
    }

    #[tokio::test]
    async fn an_unrequested_exit_fails_only_that_device() {
        let capture = lifecycle_capture::start();
        let android = FakeBackend::new(Platform::Android, &["Pixel"]);
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        let (manager, _enabled) = fake_manager(vec![android.clone(), ios.clone()]);
        let a = manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        let i = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        wait_state(&manager, &i, DeviceState::Ready).await;
        ios.exit_running(0, "Shutdown outside BiBCode");
        let failed = wait_state(&manager, &i, DeviceState::Failed).await;
        assert_eq!(failed.failure.as_deref(), Some("Shutdown outside BiBCode"));
        assert_eq!(ios.stops(), 1);
        assert!(capture.events().iter().any(|e| e["phase"] == "fail"
            && e["failureKind"] == "exited"
            && e["platform"] == "ios"));
        assert_eq!(
            wait_state(&manager, &a, DeviceState::Ready).await.state,
            DeviceState::Ready
        );
        manager.shutdown().await;
        assert_eq!(android.stops(), 1);
    }

    #[tokio::test]
    async fn the_catalog_lists_each_platform_with_its_own_availability() {
        let android = FakeBackend::new(Platform::Android, &[]);
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        let (manager, _enabled) = fake_manager(vec![android.clone(), ios.clone()]);
        manager.refresh_now().await;
        let catalog = manager.catalog().borrow().clone();
        let kinds: Vec<_> = catalog
            .platforms
            .iter()
            .map(|p| (p.platform, p.availability.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (Platform::Android, AvailabilityKind::NoAvds),
                (Platform::Ios, AvailabilityKind::Ready)
            ]
        );
        assert_eq!(catalog.platforms[1].images[0].id, "UDID-1");
        assert!(ios.discover_calls() >= 1 && android.discover_calls() >= 1);
        let json = serde_json::to_value(&catalog).unwrap();
        assert_eq!(json["platforms"][0]["platform"], "android");
        assert_eq!(json["platforms"][1]["platform"], "ios");
        assert_eq!(
            json["platforms"][1]["images"][0],
            serde_json::json!({ "id": "UDID-1", "displayName": "iPhone UDID-1" })
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn the_catalog_starts_with_each_platform_looking() {
        let android = FakeBackend::new(Platform::Android, &["Pixel"]);
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        let (manager, enabled) = fake_manager(vec![android, ios]);
        // Off, so nothing discovers before the first look.
        enabled.send(false).unwrap();
        let catalog = manager.catalog().borrow().clone();
        assert_eq!(
            catalog
                .platforms
                .iter()
                .map(|p| (p.platform, p.availability.message.as_str(), p.images.len()))
                .collect::<Vec<_>>(),
            vec![
                (Platform::Android, "Looking for fake devices.", 0),
                (Platform::Ios, "Looking for fake devices.", 0)
            ]
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn a_snapshot_reports_whether_its_device_can_rotate() {
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        ios.without_rotation();
        ios.never_boots();
        let (manager, _enabled) = fake_manager(vec![ios.clone()]);
        let id = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        let booting = wait_state(&manager, &id, DeviceState::Booting).await;
        assert!(booting.can_rotate);
        manager.close(&id).await.unwrap();

        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        ios.without_rotation();
        let (manager, _enabled) = fake_manager(vec![ios]);
        let id = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        let ready = wait_state(&manager, &id, DeviceState::Ready).await;
        assert!(!ready.can_rotate);
        assert_eq!(
            serde_json::to_value(&ready).unwrap()["canRotate"],
            serde_json::json!(false)
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn an_unconfigured_or_unknown_image_is_refused() {
        let android = FakeBackend::new(Platform::Android, &["Pixel"]);
        let (manager, _enabled) = fake_manager(vec![android.clone()]);
        assert!(matches!(
            manager.open(Platform::Android, "Nope", None).await,
            Err(DeviceOpError::UnknownImage { platform: Platform::Android, ref image_id }) if image_id == "Nope"
        ));
        assert!(matches!(
            manager.open(Platform::Ios, "UDID-1", None).await,
            Err(DeviceOpError::UnknownImage {
                platform: Platform::Ios,
                ..
            })
        ));
        assert_eq!(android.launches(), 0);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn closing_a_booting_fake_device_cancels_its_launch() {
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        ios.never_boots();
        let (manager, _enabled) = fake_manager(vec![ios.clone()]);
        let id = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        wait_state(&manager, &id, DeviceState::Booting).await;
        manager.close(&id).await.unwrap();
        assert_eq!(
            manager.catalog().borrow().devices[0].state,
            DeviceState::Stopped
        );
        assert!(manager.open(Platform::Ios, "UDID-1", None).await.is_ok());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn turning_the_setting_off_stops_every_platform() {
        let android = FakeBackend::new(Platform::Android, &["Pixel"]);
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        let (manager, enabled) = fake_manager(vec![android.clone(), ios.clone()]);
        let a = manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        let i = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        wait_state(&manager, &a, DeviceState::Ready).await;
        wait_state(&manager, &i, DeviceState::Ready).await;
        enabled.send(false).unwrap();
        wait_state(&manager, &a, DeviceState::Stopped).await;
        wait_state(&manager, &i, DeviceState::Stopped).await;
        assert_eq!((android.stops(), ios.stops()), (1, 1));
        assert!(matches!(
            manager.open(Platform::Ios, "UDID-1", None).await,
            Err(DeviceOpError::Disabled)
        ));
    }

    #[tokio::test]
    async fn a_dropped_close_still_stops_a_fake_device() {
        use futures_util::FutureExt as _;
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        let (manager, _enabled) = fake_manager(vec![ios.clone()]);
        let id = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        wait_state(&manager, &id, DeviceState::Ready).await;
        assert!(manager.close(&id).now_or_never().is_none());
        wait_state(&manager, &id, DeviceState::Stopped).await;
        assert_eq!(ios.stops(), 1);
    }

    #[test]
    fn busy_and_unknown_image_errors_name_the_platform() {
        assert_eq!(
            DeviceOpError::Busy {
                image_id: "UDID-1".into()
            }
            .to_rpc_error(),
            serde_json::json!({
                "_tag": "DeviceBusyError",
                "imageId": "UDID-1",
                "message": "This simulator is already running outside BiBCode. Shut it down in Simulator, then open it here.",
            })
        );
        let ios = DeviceOpError::UnknownImage {
            platform: Platform::Ios,
            image_id: "X".into(),
        }
        .to_rpc_error();
        assert_eq!(ios["_tag"], "DeviceNotFoundError");
        assert_eq!(
            ios["message"],
            "No simulator with id \"X\" exists on the server. Choose one from the device list."
        );
        assert_eq!(
            launch_failure(&LaunchFailure::Busy),
            ("busy", "in use outside BiBCode".to_owned())
        );
    }

    #[tokio::test]
    async fn the_catalog_follows_an_orientation_the_device_reports_without_frames() {
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        let turn = ios.reports_orientation();
        let (manager, _enabled) = fake_manager(vec![ios]);
        let id = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        wait_state(&manager, &id, DeviceState::Ready).await;
        turn.send_replace(Orientation::Landscape);
        let mut catalog = manager.catalog();
        let landscape = tokio::time::timeout(
            Duration::from_secs(10),
            catalog.wait_for(|catalog| {
                catalog
                    .devices
                    .iter()
                    .any(|device| device.orientation == Orientation::Landscape)
            }),
        )
        .await
        .expect("the reported turn reaches the catalog")
        .unwrap()
        .devices[0]
            .clone();
        let (width, height) = crate::device::fake_backend::FAKE_SIZE;
        assert_eq!(
            (landscape.width, landscape.height),
            (Some(height), Some(width))
        );
        manager.shutdown().await;
    }

    /// An Android Quick Boot snapshot saved turned boots in landscape, and nothing follows
    /// the device after launch here. So the first `Ready` entry, which only the launch
    /// publishes, must already say landscape at the turned size.
    #[tokio::test]
    async fn a_device_that_boots_turned_is_first_ready_turned() {
        let android = FakeBackend::new(Platform::Android, &["Pixel"]);
        android.boot_orientation(Orientation::Landscape);
        let (manager, _enabled) = fake_manager(vec![android]);
        let id = manager
            .open(Platform::Android, "Pixel", None)
            .await
            .unwrap();
        let ready = wait_state(&manager, &id, DeviceState::Ready).await;
        let (width, height) = crate::device::fake_backend::FAKE_SIZE;
        assert_eq!(
            (ready.orientation, ready.width, ready.height),
            (Orientation::Landscape, Some(height), Some(width))
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn a_device_without_video_refuses_media_tickets_at_once() {
        let ios = FakeBackend::new(Platform::Ios, &["UDID-1"]);
        ios.without_video("Video is off: this simulator runs view-only.");
        let (manager, _enabled) = fake_manager(vec![ios]);
        let id = manager.open(Platform::Ios, "UDID-1", None).await.unwrap();
        wait_state(&manager, &id, DeviceState::Ready).await;
        let refused = manager
            .create_media_ticket(&id, "session", media::MediaChannel::Plain)
            .unwrap_err();
        assert_eq!(
            refused.to_rpc_error(),
            serde_json::json!({
                "_tag": "DeviceMediaUnavailableError",
                "message": "Video is off: this simulator runs view-only.",
            })
        );
        manager.shutdown().await;
    }

    #[test]
    fn view_only_platforms_open_and_others_do_not() {
        assert!(opens(AvailabilityKind::Ready));
        assert!(opens(AvailabilityKind::XcodeUnsupported));
        assert!(opens(AvailabilityKind::ViewOnlyHeadless));
        for kind in [
            AvailabilityKind::XcodeMissing,
            AvailabilityKind::XcodeSetupIncomplete,
            AvailabilityKind::NoSimulators,
            AvailabilityKind::SdkMissing,
        ] {
            assert!(!opens(kind), "{kind:?}");
        }
    }
}
