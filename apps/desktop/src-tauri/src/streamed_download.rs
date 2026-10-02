//! Main-page-owned streamed disk downloads. Native writes and cleanup remain owned if a caller leaves.
use crate::bridge::{DOWNLOAD_PARTIAL_SUFFIX, unique_destination, validate_download_file_name};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    sync::{OwnedMutexGuard, oneshot},
    time::Instant,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const MAX_CHUNK_BYTES: usize = 1024 * 1024;
const IDLE: Duration = Duration::from_secs(10 * 60);
#[derive(Clone, Debug, Serialize)]
pub struct BeginDownloadFileResult {
    pub handle: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct FinishDownloadFileResult {
    pub path: String,
}
#[derive(Clone)]
pub(crate) struct DownloadFileManager {
    inner: Arc<Manager>,
}
struct Manager {
    state: Mutex<ManagerState>,
    tasks: TaskTracker,
    stop: CancellationToken,
}
struct ManagerState {
    generation: u64,
    closed: bool,
    sweeper_started: bool,
    entries: HashMap<String, Arc<Entry>>,
}
struct Entry {
    terminal: AtomicU8,
    generation: u64,
    cancel: CancellationToken,
    activity: Mutex<Instant>,
    io: Arc<tokio::sync::Mutex<EntryIo>>,
}
#[derive(Default)]
struct EntryIo {
    file: Option<tokio::fs::File>,
    partial: Option<PathBuf>,
    identity: Option<FileIdentity>,
    directory: Option<PathBuf>,
    name: String,
    published: bool,
    reservation: Option<Arc<Mutex<Option<DownloadDestination>>>>,
    #[cfg(test)]
    destination_probe_failures: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(windows)]
    volume: u32,
    #[cfg(windows)]
    index: u64,
}
/// Created-file ownership exists before any fallible inspection. Both native
/// download paths retain this owner through publication or identity-safe rollback.
pub(crate) struct DownloadDestination {
    pub(crate) path: PathBuf,
    file: Option<std::fs::File>,
    identity: Option<FileIdentity>,
    released: bool,
    #[cfg(test)]
    probe_failures: u8,
}
impl DownloadDestination {
    pub(crate) fn new(path: PathBuf, file: std::fs::File) -> Self {
        Self {
            path,
            file: Some(file),
            identity: None,
            released: false,
            #[cfg(test)]
            probe_failures: 0,
        }
    }
    fn capture_identity(&mut self) -> Result<FileIdentity, String> {
        #[cfg(test)]
        if self.probe_failures > 0 {
            self.probe_failures -= 1;
            return Err("Injected destination identity probe failure.".into());
        }
        if let Some(identity) = self.identity {
            return Ok(identity);
        }
        let file = self.file.as_ref().ok_or_else(unavailable)?;
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            let metadata = file
                .metadata()
                .map_err(|error| format!("Could not verify the download destination: {error}"))?;
            FileIdentity {
                dev: metadata.dev(),
                ino: metadata.ino(),
            }
        };
        #[cfg(windows)]
        let identity = file_identity(file)
            .map_err(|error| format!("Could not verify the download destination: {error}"))?;
        self.identity = Some(identity);
        Ok(identity)
    }
    pub(crate) fn publish(&mut self, partial: &Path) -> Result<PathBuf, String> {
        let identity = self.capture_identity()?;
        if identity_at(&self.path)
            .map_err(|error| format!("Could not verify the download destination: {error}"))?
            != identity
        {
            return Err("Download destination identity changed.".into());
        }
        drop(self.file.take());
        std::fs::rename(partial, &self.path)
            .map_err(|error| format!("Could not place the download file: {error}"))?;
        self.released = true;
        Ok(self.path.clone())
    }
    pub(crate) fn rollback(&mut self) -> Result<(), String> {
        if self.released {
            return Ok(());
        }
        let identity = self.capture_identity()?;
        drop(self.file.take());
        remove_owned(&self.path, identity)
            .map_err(|error| format!("Could not remove the download reservation: {error}"))?;
        self.released = true;
        Ok(())
    }
}
impl Drop for DownloadDestination {
    fn drop(&mut self) {
        if let Err(error) = self.rollback() {
            tracing::warn!("failed to clean up download reservation: {error}");
        }
    }
}
#[cfg(unix)]
async fn opened_identity(file: &tokio::fs::File) -> std::io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().await?;
    Ok(FileIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    })
}
#[cfg(windows)]
async fn opened_identity(file: &tokio::fs::File) -> std::io::Result<FileIdentity> {
    file_identity(file)
}
#[cfg(windows)]
fn file_identity(file: &impl std::os::windows::io::AsRawHandle) -> std::io::Result<FileIdentity> {
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: the borrowed handle remains open and the information pointer is valid storage.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: GetFileInformationByHandle succeeded and initialized the structure.
    let information = unsafe { information.assume_init() };
    Ok(FileIdentity {
        volume: information.dwVolumeSerialNumber,
        index: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}
fn identity_at(path: &Path) -> std::io::Result<FileIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(std::io::Error::other("Download file identity changed."));
        }
        Ok(FileIdentity {
            dev: metadata.dev(),
            ino: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        let mut options = std::fs::OpenOptions::new();
        use std::os::windows::fs::OpenOptionsExt;
        options.access_mode(windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES);
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
        let file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(std::io::Error::other("Download file identity changed."));
        }
        file_identity(&file)
    }
}
fn remove_owned(path: &Path, identity: FileIdentity) -> std::io::Result<()> {
    match identity_at(path) {
        Ok(actual) if actual == identity => std::fs::remove_file(path),
        Ok(_) => Err(std::io::Error::other("Download file identity changed.")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
fn unavailable() -> String {
    "Download is no longer available. Start it again.".into()
}
impl DownloadFileManager {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Manager {
                state: Mutex::new(ManagerState {
                    generation: 1,
                    closed: false,
                    sweeper_started: false,
                    entries: HashMap::new(),
                }),
                tasks: TaskTracker::new(),
                stop: CancellationToken::new(),
            }),
        }
    }
    fn entry(&self, handle: &str) -> Result<Arc<Entry>, String> {
        let state = self.inner.state.lock().expect("download manager");
        let entry = state.entries.get(handle).ok_or_else(unavailable)?;
        if state.closed || entry.generation != state.generation || entry.cancel.is_cancelled() {
            return Err(unavailable());
        }
        Ok(entry.clone())
    }
    fn forget(&self, handle: &str, entry: &Arc<Entry>) {
        let mut state = self.inner.state.lock().expect("download manager");
        if state
            .entries
            .get(handle)
            .is_some_and(|known| Arc::ptr_eq(known, entry))
        {
            state.entries.remove(handle);
        }
    }
    fn owned<T: Send + 'static>(
        &self,
        work: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
    ) -> Result<oneshot::Receiver<Result<T, String>>, String> {
        let state = self.inner.state.lock().expect("download manager");
        if state.closed {
            return Err(unavailable());
        }
        let (sender, receiver) = oneshot::channel();
        self.inner.tasks.spawn(async move {
            let result = work.await;
            let _ = sender.send(result);
        });
        Ok(receiver)
    }
    async fn settle<T>(receiver: oneshot::Receiver<Result<T, String>>) -> Result<T, String> {
        receiver
            .await
            .map_err(|_| "Download operation could not finish. Try again.".to_owned())?
    }
    async fn cleanup(
        &self,
        handle: &str,
        entry: &Arc<Entry>,
        io: &mut EntryIo,
    ) -> Result<(), String> {
        if io.partial.is_some() && io.identity.is_none() {
            // Keep the open file and path owned if identity inspection fails again.
            // A later cleanup can retry without deleting a replacement by path.
            io.identity = Some(
                opened_identity(io.file.as_ref().ok_or_else(unavailable)?)
                    .await
                    .map_err(|error| format!("Could not verify the partial download: {error}"))?,
            );
        }
        if let Some(file) = io.file.take() {
            drop(file.into_std().await);
        }
        if let Some(reservation) = io.reservation.clone() {
            tokio::task::spawn_blocking(move || {
                let mut reservation = reservation.lock().expect("download reservation");
                if let Some(owner) = reservation.as_mut() {
                    owner.rollback()?;
                }
                reservation.take();
                Ok::<_, String>(())
            })
            .await
            .map_err(|_| "Download cleanup could not finish.".to_owned())??;
            io.reservation = None;
        }
        if let (Some(path), Some(identity)) = (io.partial.clone(), io.identity) {
            tokio::task::spawn_blocking(move || remove_owned(&path, identity))
                .await
                .map_err(|_| "Download cleanup could not finish.".to_owned())?
                .map_err(|error| format!("Could not remove the partial download: {error}"))?;
        }
        io.partial = None;
        self.forget(handle, entry);
        Ok(())
    }
    pub(crate) async fn begin(
        &self,
        directory: PathBuf,
        file_name: String,
    ) -> Result<BeginDownloadFileResult, String> {
        let name = validate_download_file_name(&file_name)?;
        let handle = uuid::Uuid::new_v4().to_string();
        let entry = {
            let mut state = self.inner.state.lock().expect("download manager");
            if state.closed {
                return Err(unavailable());
            }
            let entry = Arc::new(Entry {
                terminal: AtomicU8::new(0),
                generation: state.generation,
                cancel: CancellationToken::new(),
                activity: Mutex::new(Instant::now()),
                io: Arc::new(tokio::sync::Mutex::new(EntryIo::default())),
            });
            state.entries.insert(handle.clone(), entry.clone());
            entry
        };
        let owner = self.clone();
        let id = handle.clone();
        let worker_entry = entry.clone();
        let receiver = match self.owned(async move {
            let mut io = worker_entry.io.lock().await;
            let result: Result<(), String> = async {
                if worker_entry.cancel.is_cancelled() {
                    return Err(unavailable());
                }
                let directory = tokio::fs::canonicalize(directory)
                    .await
                    .map_err(|_| "Download folder does not exist.".to_owned())?;
                if !tokio::fs::metadata(&directory)
                    .await
                    .map_err(|error| format!("Could not inspect the download folder: {error}"))?
                    .is_dir()
                {
                    return Err("Download folder does not exist.".into());
                }
                let partial = directory.join(
                    bibcode_server::transfer::upload::partial_transfer_file_name(
                        &name,
                        DOWNLOAD_PARTIAL_SUFFIX,
                    ),
                );
                let file = tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&partial)
                    .await
                    .map_err(|error| format!("Could not create the partial download: {error}"))?;
                io.partial = Some(partial);
                io.file = Some(file);
                io.identity = Some(
                    opened_identity(io.file.as_ref().expect("owned partial file"))
                        .await
                        .map_err(|error| {
                            format!("Could not verify the partial download: {error}")
                        })?,
                );
                io.directory = Some(directory);
                io.name = name;
                if worker_entry.cancel.is_cancelled() {
                    return Err(unavailable());
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                worker_entry.cancel.cancel();
                if let Err(error) = owner.cleanup(&id, &worker_entry, &mut io).await {
                    tracing::warn!("failed to clean up streamed download: {error}");
                }
                return Err(error);
            }
            Ok(BeginDownloadFileResult { handle: id })
        }) {
            Ok(receiver) => receiver,
            Err(error) => {
                entry.cancel.cancel();
                self.forget(&handle, &entry);
                return Err(error);
            }
        };
        Self::settle(receiver).await
    }
    async fn locked(&self, handle: &str) -> Result<(Arc<Entry>, OwnedMutexGuard<EntryIo>), String> {
        let entry = self.entry(handle)?;
        let io = entry.io.clone().lock_owned().await;
        if entry.cancel.is_cancelled() || io.published {
            return Err(unavailable());
        }
        Ok((entry, io))
    }
    pub(crate) async fn append(&self, handle: &str, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err("Download chunk exceeds the 1 MiB limit.".into());
        }
        let (entry, mut io) = self.locked(handle).await?;
        let owner = self.clone();
        let id = handle.to_owned();
        let receiver = self.owned(async move {
            let result: Result<(), String> = async {
                if entry.cancel.is_cancelled() {
                    return Err(unavailable());
                }
                let file = io.file.as_mut().ok_or_else(unavailable)?;
                file.write_all(&bytes)
                    .await
                    .map_err(|error| format!("Could not write the download: {error}"))?;
                file.flush()
                    .await
                    .map_err(|error| format!("Could not write the download: {error}"))?;
                if entry.cancel.is_cancelled() {
                    return Err(unavailable());
                }
                *entry.activity.lock().expect("download activity") = Instant::now();
                Ok(())
            }
            .await;
            if result.is_err() {
                entry.cancel.cancel();
                if let Err(error) = owner.cleanup(&id, &entry, &mut io).await {
                    tracing::warn!("failed to clean up streamed download: {error}");
                }
            }
            result
        })?;
        Self::settle(receiver).await
    }
    pub(crate) async fn finish(&self, handle: &str) -> Result<FinishDownloadFileResult, String> {
        let (entry, mut io) = self.locked(handle).await?;
        let owner = self.clone();
        let id = handle.to_owned();
        let receiver = self.owned(async move {
            let result: Result<FinishDownloadFileResult, String> = async {
                if entry.cancel.is_cancelled() {
                    return Err(unavailable());
                }
                let mut file = io.file.take().ok_or_else(unavailable)?;
                let flushed = file
                    .flush()
                    .await
                    .map_err(|error| format!("Could not finish the download: {error}"));
                drop(file.into_std().await);
                flushed?;
                if entry.cancel.is_cancelled() {
                    return Err(unavailable());
                }
                {
                    let state = owner.inner.state.lock().expect("download manager");
                    if state.closed
                        || state.generation != entry.generation
                        || entry
                            .terminal
                            .compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst)
                            .is_err()
                    {
                        return Err(unavailable());
                    }
                }
                let directory = io.directory.clone().ok_or_else(unavailable)?;
                let partial = io.partial.clone().ok_or_else(unavailable)?;
                let name = io.name.clone();
                let identity = io.identity.ok_or_else(unavailable)?;
                let reservation = Arc::new(Mutex::new(None));
                io.reservation = Some(reservation.clone());
                #[cfg(test)]
                let destination_probe_failures = io.destination_probe_failures;
                let destination = tokio::task::spawn_blocking(move || {
                    if identity_at(&partial).map_err(|error| {
                        format!("Could not verify the partial download: {error}")
                    })? != identity
                    {
                        return Err("Partial download identity changed.".into());
                    }
                    let mut reservation = reservation.lock().expect("download reservation");
                    let destination = reservation.insert(unique_destination(&directory, &name)?);
                    #[cfg(test)]
                    {
                        destination.probe_failures = destination_probe_failures;
                    }
                    destination.publish(&partial)
                })
                .await
                .map_err(|_| "Could not finish the download.".to_owned())??;
                io.published = true;
                entry.terminal.store(3, Ordering::SeqCst);
                io.partial = None;
                io.reservation = None;
                owner.forget(&id, &entry);
                Ok(FinishDownloadFileResult {
                    path: destination.to_string_lossy().into_owned(),
                })
            }
            .await;
            if result.is_err() {
                entry.cancel.cancel();
                if let Err(error) = owner.cleanup(&id, &entry, &mut io).await {
                    tracing::warn!("failed to clean up streamed download: {error}");
                }
            }
            result
        })?;
        Self::settle(receiver).await
    }
    pub(crate) async fn abort(&self, handle: &str) -> Result<(), String> {
        let result = self.abort_active(handle).await;
        if self.inner.state.lock().expect("download manager").closed {
            self.inner.tasks.wait().await;
            Ok(())
        } else {
            result
        }
    }
    async fn abort_active(&self, handle: &str) -> Result<(), String> {
        let entry = {
            let state = self.inner.state.lock().expect("download manager");
            if state.closed {
                return Ok(());
            }
            state.entries.get(handle).cloned()
        };
        let Some(entry) = entry else {
            return Ok(());
        };
        if entry
            .terminal
            .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            entry.cancel.cancel();
        }
        let owner = self.clone();
        let id = handle.to_owned();
        let receiver = self.owned(async move {
            let mut io = entry.io.lock().await;
            if io.published {
                return Ok(());
            }
            owner.cleanup(&id, &entry, &mut io).await
        })?;
        Self::settle(receiver).await
    }
    pub(crate) fn advance_page_generation(&self) -> u64 {
        let mut state = self.inner.state.lock().expect("download manager");
        state.generation = state.generation.checked_add(1).expect("page generation");
        for entry in state.entries.values() {
            if entry.generation < state.generation
                && entry
                    .terminal
                    .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                entry.cancel.cancel();
            }
        }
        state.generation
    }
    pub(crate) async fn abort_before_generation(&self, generation: u64) {
        let ids = {
            let state = self.inner.state.lock().expect("download manager");
            state
                .entries
                .iter()
                .filter(|(_, entry)| entry.generation < generation)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>()
        };
        for id in ids {
            if let Err(error) = self.abort_active(&id).await {
                tracing::warn!("failed to clean up streamed download: {error}");
            }
        }
    }
    pub(crate) async fn sweep(&self) {
        let now = Instant::now();
        let ids = {
            let state = self.inner.state.lock().expect("download manager");
            state
                .entries
                .iter()
                .filter(|(_, entry)| {
                    now.duration_since(*entry.activity.lock().expect("download activity")) >= IDLE
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>()
        };
        for id in ids {
            if let Err(error) = self.expire_idle(&id).await {
                tracing::warn!("failed to clean up streamed download: {error}");
            }
        }
    }
    async fn expire_idle(&self, handle: &str) -> Result<(), String> {
        let entry = {
            let state = self.inner.state.lock().expect("download manager");
            if state.closed {
                return Ok(());
            }
            state.entries.get(handle).cloned()
        };
        let Some(entry) = entry else {
            return Ok(());
        };
        let owner = self.clone();
        let id = handle.to_owned();
        let receiver = self.owned(async move {
            let mut io = entry.io.lock().await;
            // Append updates activity under this same I/O guard. The candidate
            // snapshot cannot authorize cancellation after a completed refresh.
            if io.published
                || Instant::now().duration_since(*entry.activity.lock().expect("download activity"))
                    < IDLE
            {
                return Ok(());
            }
            if entry
                .terminal
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                entry.cancel.cancel();
            }
            if !entry.cancel.is_cancelled() {
                return Ok(());
            }
            owner.cleanup(&id, &entry, &mut io).await
        })?;
        Self::settle(receiver).await
    }
    pub(crate) fn start_sweeper(&self) {
        let mut state = self.inner.state.lock().expect("download manager");
        if state.closed || state.sweeper_started {
            return;
        }
        state.sweeper_started = true;
        let owner = self.clone();
        let stop = self.inner.stop.clone();
        self.inner.tasks.spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_secs(60));
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    () = stop.cancelled() => break,
                    _ = ticks.tick() => owner.sweep().await,
                }
            }
        });
    }
    pub(crate) fn schedule_generation_cleanup(&self, generation: u64) {
        let state = self.inner.state.lock().expect("download manager");
        if state.closed {
            return;
        }
        let token = self.inner.tasks.token();
        let owner = self.clone();
        tauri::async_runtime::spawn(async move {
            let _token = token;
            owner.abort_before_generation(generation).await;
        });
    }
    pub(crate) async fn shutdown(&self) {
        {
            let mut state = self.inner.state.lock().expect("download manager");
            if !state.closed {
                state.closed = true;
                self.inner.stop.cancel();
                let entries = state
                    .entries
                    .iter()
                    .map(|(id, entry)| (id.clone(), entry.clone()))
                    .collect::<Vec<_>>();
                for (_, entry) in &entries {
                    if entry
                        .terminal
                        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                    {
                        entry.cancel.cancel();
                    }
                }
                let owner = self.clone();
                self.inner.tasks.spawn(async move {
                    for (id, entry) in entries {
                        let mut io = entry.io.lock().await;
                        if !io.published
                            && let Err(error) = owner.cleanup(&id, &entry, &mut io).await
                        {
                            tracing::warn!("failed to clean up streamed download: {error}");
                        }
                    }
                });
                self.inner.tasks.close();
            }
        }
        self.inner.tasks.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn partials(root: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.to_string_lossy().ends_with(".bibcode-download.part"))
            .collect()
    }
    #[tokio::test]
    async fn streamed_download_preserves_order_and_uniquifies_the_final_name() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("report.zip"), b"old").unwrap();
        let manager = DownloadFileManager::new();
        let begun = manager
            .begin(root.path().into(), "report.zip".into())
            .await
            .unwrap();
        assert_eq!(partials(root.path()).len(), 1);
        assert!(!root.path().join("report (2).zip").exists());
        manager
            .append(&begun.handle, b"abc".to_vec())
            .await
            .unwrap();
        manager
            .append(&begun.handle, b"def".to_vec())
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(partials(root.path()).pop().unwrap()).unwrap(),
            b"abcdef"
        );
        let result = manager.finish(&begun.handle).await.unwrap();
        assert!(result.path.ends_with("report (2).zip"));
        assert_eq!(std::fs::read(&result.path).unwrap(), b"abcdef");
        assert_eq!(
            std::fs::read(root.path().join("report.zip")).unwrap(),
            b"old"
        );
        assert!(partials(root.path()).is_empty());
        manager.shutdown().await;
    }
    #[tokio::test]
    async fn abort_is_idempotent_and_removes_only_its_owned_partial() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("kept"), b"kept").unwrap();
        let manager = DownloadFileManager::new();
        let begun = manager
            .begin(root.path().into(), "a.bin".into())
            .await
            .unwrap();
        manager
            .append(&begun.handle, b"partial".to_vec())
            .await
            .unwrap();
        manager.abort(&begun.handle).await.unwrap();
        manager.abort(&begun.handle).await.unwrap();
        assert!(partials(root.path()).is_empty());
        assert_eq!(std::fs::read(root.path().join("kept")).unwrap(), b"kept");
        assert!(
            manager
                .append(&begun.handle, b"late".to_vec())
                .await
                .is_err()
        );
        manager.shutdown().await;
    }
    #[tokio::test]
    async fn abort_recovers_identity_from_the_owned_open_file_before_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let manager = DownloadFileManager::new();
        let begun = manager.begin(root.path().into(), "a".into()).await.unwrap();
        // Model a failed initial identity probe after creation was already owned.
        manager
            .entry(&begun.handle)
            .unwrap()
            .io
            .lock()
            .await
            .identity = None;
        manager.abort(&begun.handle).await.unwrap();
        assert!(partials(root.path()).is_empty());
        manager.shutdown().await;
    }
    #[tokio::test(start_paused = true)]
    async fn idle_and_page_load_abort_remove_only_old_handles() {
        let root = tempfile::tempdir().unwrap();
        let manager = DownloadFileManager::new();
        let active = manager
            .begin(root.path().into(), "active".into())
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(599)).await;
        manager.append(&active.handle, b"a".to_vec()).await.unwrap();
        tokio::time::advance(Duration::from_secs(599)).await;
        manager.sweep().await;
        assert_eq!(partials(root.path()).len(), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        manager.sweep().await;
        assert!(partials(root.path()).is_empty());
        let old = manager
            .begin(root.path().into(), "old".into())
            .await
            .unwrap();
        let generation = manager.advance_page_generation();
        let new = manager
            .begin(root.path().into(), "new".into())
            .await
            .unwrap();
        assert!(manager.append(&old.handle, b"late".to_vec()).await.is_err());
        manager.abort_before_generation(generation).await;
        manager.append(&new.handle, b"kept".to_vec()).await.unwrap();
        assert_eq!(partials(root.path()).len(), 1);
        let finished = manager.finish(&new.handle).await.unwrap();
        assert_eq!(std::fs::read(finished.path).unwrap(), b"kept");
        manager.shutdown().await;
    }
    #[tokio::test(start_paused = true)]
    async fn idle_sweep_keeps_a_later_download_refreshed_while_first_cleanup_waits() {
        let root = tempfile::tempdir().unwrap();
        let manager = DownloadFileManager::new();
        manager.begin(root.path().into(), "a".into()).await.unwrap();
        manager.begin(root.path().into(), "b".into()).await.unwrap();
        tokio::time::advance(IDLE).await;
        let entries = manager
            .inner
            .state
            .lock()
            .unwrap()
            .entries
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect::<Vec<_>>();
        // Use the real map's traversal order; no insertion-order assumption.
        let first_io = entries[0].1.io.lock().await;
        let later_handle = entries[1].0.clone();
        let sweeper = manager.clone();
        let sweep = tokio::spawn(async move { sweeper.sweep().await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while manager.inner.tasks.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        manager
            .append(&later_handle, b"refreshed".to_vec())
            .await
            .unwrap();
        drop(first_io);
        sweep.await.unwrap();
        let result = manager.finish(&later_handle).await.unwrap();
        assert_eq!(std::fs::read(result.path).unwrap(), b"refreshed");
        assert!(partials(root.path()).is_empty());
        manager.shutdown().await;
    }
    #[tokio::test]
    async fn shutdown_joins_sweeper_removes_partials_and_fences_new_work() {
        let root = tempfile::tempdir().unwrap();
        let manager = DownloadFileManager::new();
        manager.start_sweeper();
        let begun = manager.begin(root.path().into(), "a".into()).await.unwrap();
        manager.append(&begun.handle, b"a".to_vec()).await.unwrap();
        manager.shutdown().await;
        assert!(partials(root.path()).is_empty());
        assert!(manager.begin(root.path().into(), "b".into()).await.is_err());
        manager.shutdown().await;
    }
    #[tokio::test]
    async fn raw_appends_are_bounded_and_serialized() {
        let root = tempfile::tempdir().unwrap();
        let manager = DownloadFileManager::new();
        let begun = manager.begin(root.path().into(), "a".into()).await.unwrap();
        assert!(
            manager
                .append(&begun.handle, vec![0; 1024 * 1024 + 1])
                .await
                .is_err()
        );
        let first = manager.clone();
        let handle = begun.handle.clone();
        let a = tokio::spawn(async move { first.append(&handle, vec![1; 64 * 1024]).await });
        tokio::task::yield_now().await;
        manager
            .append(&begun.handle, vec![2; 64 * 1024])
            .await
            .unwrap();
        a.await.unwrap().unwrap();
        let finished = manager.finish(&begun.handle).await.unwrap();
        let bytes = std::fs::read(finished.path).unwrap();
        assert_eq!(bytes.len(), 128 * 1024);
        assert!(bytes[..64 * 1024].iter().all(|byte| *byte == 1));
        assert!(bytes[64 * 1024..].iter().all(|byte| *byte == 2));
        manager.shutdown().await;
    }
    struct BlockingGate(Arc<(Mutex<bool>, std::sync::Condvar)>);
    impl BlockingGate {
        fn new() -> Self {
            Self(Arc::new((Mutex::new(false), std::sync::Condvar::new())))
        }
        fn release(&self) {
            *self.0.0.lock().unwrap() = true;
            self.0.1.notify_all();
        }
    }
    impl Drop for BlockingGate {
        fn drop(&mut self) {
            self.release();
        }
    }
    #[test]
    fn dropped_append_waiter_and_abort_join_the_real_pending_disk_write() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap()
            .block_on(async {
                let root = tempfile::tempdir().unwrap();
                let manager = DownloadFileManager::new();
                let begun = manager.begin(root.path().into(), "a".into()).await.unwrap();
                let entry = manager.entry(&begun.handle).unwrap();
                let gate = BlockingGate::new();
                let held = gate.0.clone();
                let (entered, ready) = oneshot::channel();
                let blocker = tokio::task::spawn_blocking(move || {
                    entered.send(()).unwrap();
                    let mut released = held.0.lock().unwrap();
                    while !*released {
                        released = held.1.wait(released).unwrap();
                    }
                });
                ready.await.unwrap();
                let writer = manager.clone();
                let handle = begun.handle.clone();
                let append =
                    tokio::spawn(async move { writer.append(&handle, vec![7; 64 * 1024]).await });
                tokio::time::timeout(Duration::from_secs(2), async {
                    loop {
                        if entry.io.try_lock().is_err() {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                for _ in 0..20 {
                    tokio::task::yield_now().await;
                }
                append.abort();
                assert!(append.await.unwrap_err().is_cancelled());
                let aborter = manager.clone();
                let handle = begun.handle.clone();
                let abort = tokio::spawn(async move { aborter.abort(&handle).await });
                for _ in 0..20 {
                    tokio::task::yield_now().await;
                }
                assert!(
                    !abort.is_finished(),
                    "abort must join the started real disk write"
                );
                assert_eq!(partials(root.path()).len(), 1);
                gate.release();
                blocker.await.unwrap();
                tokio::time::timeout(Duration::from_secs(2), abort)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert!(partials(root.path()).is_empty());
                assert!(!root.path().join("a").exists());
                manager.shutdown().await;
            });
    }
    #[tokio::test]
    async fn finish_failure_preserves_existing_destination_and_cleans_its_partial() {
        let root = tempfile::tempdir().unwrap();
        let manager = DownloadFileManager::new();
        // A collision on a component already at its receiving filesystem limit
        // makes the existing suffix reservation policy fail without touching that file.
        let name = "a".repeat(255);
        std::fs::write(root.path().join(&name), b"old").unwrap();
        let begun = manager
            .begin(root.path().into(), name.clone())
            .await
            .unwrap();
        manager
            .append(&begun.handle, b"new".to_vec())
            .await
            .unwrap();
        assert!(manager.finish(&begun.handle).await.is_err());
        assert_eq!(std::fs::read(root.path().join(name)).unwrap(), b"old");
        assert!(partials(root.path()).is_empty());
        manager.shutdown().await;
    }
    #[tokio::test]
    async fn destination_probe_failure_cleans_or_retains_the_owned_reservation_for_retry() {
        for failures in [1, 2] {
            let root = tempfile::tempdir().unwrap();
            std::fs::write(root.path().join("report.zip"), b"user data").unwrap();
            let manager = DownloadFileManager::new();
            let begun = manager
                .begin(root.path().into(), "report.zip".into())
                .await
                .unwrap();
            manager
                .append(&begun.handle, b"incoming".to_vec())
                .await
                .unwrap();
            manager
                .entry(&begun.handle)
                .unwrap()
                .io
                .lock()
                .await
                .destination_probe_failures = failures;
            assert!(manager.finish(&begun.handle).await.is_err());
            assert_eq!(
                std::fs::read(root.path().join("report.zip")).unwrap(),
                b"user data"
            );
            if failures == 2 {
                assert!(
                    manager
                        .inner
                        .state
                        .lock()
                        .unwrap()
                        .entries
                        .contains_key(&begun.handle),
                    "failed cleanup must retain reservation ownership for retry"
                );
            }
            manager.abort(&begun.handle).await.unwrap();
            assert!(!root.path().join("report (2).zip").exists());
            assert!(partials(root.path()).is_empty());
            let retried = manager
                .begin(root.path().into(), "report.zip".into())
                .await
                .unwrap();
            manager
                .append(&retried.handle, b"retry".to_vec())
                .await
                .unwrap();
            let result = manager.finish(&retried.handle).await.unwrap();
            assert!(result.path.ends_with("report (2).zip"));
            assert_eq!(std::fs::read(result.path).unwrap(), b"retry");
            manager.shutdown().await;
        }
    }
    #[test]
    fn reservation_rename_failure_removes_only_its_created_destination() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a"), b"user data").unwrap();
        let mut reservation = unique_destination(root.path(), "a").unwrap();
        assert!(
            reservation
                .publish(&root.path().join("missing-partial"))
                .is_err()
        );
        reservation.rollback().unwrap();
        assert!(!root.path().join("a (2)").exists());
        assert_eq!(std::fs::read(root.path().join("a")).unwrap(), b"user data");
    }
    #[cfg(unix)]
    #[test]
    fn reservation_rollback_refuses_a_replacement_and_can_retry_the_original() {
        let root = tempfile::tempdir().unwrap();
        let mut reservation = unique_destination(root.path(), "a").unwrap();
        std::fs::write(root.path().join("partial"), b"incoming").unwrap();
        std::fs::rename(&reservation.path, root.path().join("original")).unwrap();
        std::fs::write(&reservation.path, b"replacement").unwrap();
        assert!(reservation.publish(&root.path().join("partial")).is_err());
        assert!(reservation.rollback().is_err());
        assert_eq!(std::fs::read(&reservation.path).unwrap(), b"replacement");
        assert_eq!(
            std::fs::read(root.path().join("partial")).unwrap(),
            b"incoming"
        );
        std::fs::remove_file(&reservation.path).unwrap();
        std::fs::rename(root.path().join("original"), &reservation.path).unwrap();
        reservation.rollback().unwrap();
        assert!(!reservation.path.exists());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cleanup_refuses_a_replaced_partial_instead_of_deleting_user_data() {
        let root = tempfile::tempdir().unwrap();
        let manager = DownloadFileManager::new();
        let begun = manager.begin(root.path().into(), "a".into()).await.unwrap();
        let partial = partials(root.path()).pop().unwrap();
        std::fs::rename(&partial, root.path().join("original-partial")).unwrap();
        std::fs::write(&partial, b"replacement").unwrap();
        assert!(manager.abort(&begun.handle).await.is_err());
        assert_eq!(std::fs::read(&partial).unwrap(), b"replacement");
        manager.shutdown().await;
    }
}
