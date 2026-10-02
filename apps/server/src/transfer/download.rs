//! Bounded workspace readers shared by signed HTTP and authenticated RPC downloads.
use super::{
    TransferError,
    archive::{ArchiveLimits, ArchivePlan, archive_reader},
    staging::UploadOwner,
};
use crate::{
    RpcRequest, RpcStreamChunk,
    workspace::{WorkspaceError, WorkspaceRpc, paths},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncSeekExt},
    sync::mpsc,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileVersion {
    pub size_bytes: u64,
    pub modified_at_ns: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReadDownloadInput {
    pub cwd: String,
    pub relative_path: String,
    pub offset: Option<u64>,
    pub expect: Option<ProjectFileVersion>,
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadKind {
    File,
    Archive,
}

enum PreparedSource {
    File {
        file: tokio::fs::File,
        version: ProjectFileVersion,
    },
    Archive(ArchivePlan),
}
pub struct PreparedDownload {
    root: PathBuf,
    path: PathBuf,
    relative: String,
    name: String,
    source: PreparedSource,
}
impl PreparedDownload {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn relative(&self) -> &str {
        &self.relative
    }
    pub fn file_name(&self) -> &str {
        &self.name
    }
    pub fn kind(&self) -> DownloadKind {
        match self.source {
            PreparedSource::File { .. } => DownloadKind::File,
            PreparedSource::Archive(_) => DownloadKind::Archive,
        }
    }
    pub fn size_bytes(&self) -> Option<u64> {
        self.version().map(|version| version.size_bytes)
    }
    pub fn version(&self) -> Option<&ProjectFileVersion> {
        match &self.source {
            PreparedSource::File { version, .. } => Some(version),
            PreparedSource::Archive(_) => None,
        }
    }
    pub fn into_http_body(self) -> axum::body::Body {
        match self.source {
            PreparedSource::File { file, .. } => {
                axum::body::Body::from_stream(tokio_util::io::ReaderStream::with_capacity(
                    file,
                    super::archive::DOWNLOAD_CHUNK_BYTES,
                ))
            }
            PreparedSource::Archive(plan) => super::archive::archive_body(plan, self.path),
        }
    }
    pub async fn reader(
        self,
        offset: u64,
        expect: Option<&ProjectFileVersion>,
    ) -> Result<DownloadReader, Value> {
        let cwd = self.root.to_string_lossy().into_owned();
        let mut reader = match self.source {
            PreparedSource::File { mut file, version } => {
                if offset > version.size_bytes || (offset > 0 && expect != Some(&version)) {
                    return Err(download_error(
                        "changed",
                        "The file changed. Download it again.",
                    ));
                }
                file.seek(std::io::SeekFrom::Start(offset))
                    .await
                    .map_err(|error| io_wire(&cwd, &self.relative, &self.path, "seek", error))?;
                DownloadReader {
                    reader: OwnedReadSource::File(file),
                    completion: None,
                    metadata: Some(version),
                    cwd,
                    relative: self.relative,
                    path: self.path,
                }
            }
            PreparedSource::Archive(plan) => {
                if offset > 0 {
                    return Err(download_error(
                        "not_resumable",
                        "Folder downloads must start again.",
                    ));
                }
                let (reader, completion) = archive_reader(plan, self.path.clone());
                DownloadReader {
                    reader: OwnedReadSource::Pipe(reader),
                    completion: Some(completion),
                    metadata: None,
                    cwd,
                    relative: self.relative,
                    path: self.path,
                }
            }
        };
        // Recheck opened metadata before emitting the first event, too.
        reader.verify_file(offset, false).await?;
        Ok(reader)
    }
}

pub struct DownloadReader {
    pub reader: OwnedReadSource,
    pub completion: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    metadata: Option<ProjectFileVersion>,
    cwd: String,
    relative: String,
    path: PathBuf,
}

/// Concrete ownership lets cleanup observe Tokio's Busy file operation before closing it.
pub enum OwnedReadSource {
    File(tokio::fs::File),
    Pipe(tokio::io::DuplexStream),
    Static(std::io::Cursor<&'static [u8]>),
    Closed,
    #[cfg(test)]
    Instrumented(Pin<Box<dyn AsyncRead + Send>>),
}
impl AsyncRead for OwnedReadSource {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::File(file) => Pin::new(file).poll_read(context, buffer),
            Self::Pipe(pipe) => Pin::new(pipe).poll_read(context, buffer),
            Self::Static(bytes) => Pin::new(bytes).poll_read(context, buffer),
            Self::Closed => std::task::Poll::Ready(Ok(())),
            #[cfg(test)]
            Self::Instrumented(reader) => reader.as_mut().poll_read(context, buffer),
        }
    }
}
impl OwnedReadSource {
    pub(crate) async fn close(&mut self) {
        let source = std::mem::replace(self, Self::Closed);
        if let Self::File(file) = source {
            // into_std awaits complete_inflight; dropping a Busy Tokio file would detach it.
            drop(file.into_std().await);
        }
        // Pipe is dropped here, before DownloadReader joins its ZIP worker.
    }
}
impl DownloadReader {
    async fn verify_file(&mut self, total: u64, finished: bool) -> Result<(), Value> {
        if let (Some(expected), OwnedReadSource::File(file)) = (&self.metadata, &self.reader) {
            let metadata = file.metadata().await.map_err(|error| {
                io_wire(
                    &self.cwd,
                    &self.relative,
                    &self.path,
                    "stat-download",
                    error,
                )
            })?;
            let current = file_version(&metadata).map_err(|error| {
                io_wire(
                    &self.cwd,
                    &self.relative,
                    &self.path,
                    "stat-download",
                    error,
                )
            })?;
            if &current != expected || (finished && total != expected.size_bytes) {
                return Err(download_error(
                    "changed",
                    "The file changed. Download it again.",
                ));
            }
        }
        Ok(())
    }
    pub async fn finish(&mut self, total: u64) -> Result<(), Value> {
        if let Some(completion) = self.completion.take() {
            completion
                .await
                .map_err(|error| {
                    io_wire(
                        &self.cwd,
                        &self.relative,
                        &self.path,
                        "archive",
                        std::io::Error::other(error),
                    )
                })?
                .map_err(|error| {
                    io_wire(&self.cwd, &self.relative, &self.path, "archive", error)
                })?;
        }
        self.verify_file(total, true).await
    }
    pub async fn cancel(&mut self) {
        // Close the duplex before joining: its blocking writer may be parked on backpressure.
        self.reader.close().await;
        if let Some(completion) = self.completion.take() {
            let _ = completion.await;
        }
    }
}

fn file_version(metadata: &std::fs::Metadata) -> std::io::Result<ProjectFileVersion> {
    Ok(ProjectFileVersion {
        size_bytes: metadata.len(),
        modified_at_ns: signed_unix_ns(metadata.modified()?),
    })
}
fn signed_unix_ns(time: SystemTime) -> String {
    match time.duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_nanos().to_string(),
        Err(error) => format!("-{}", error.duration().as_nanos()),
    }
}
pub async fn prepare_download(
    root: &Path,
    relative: &str,
    limits: ArchiveLimits,
) -> Result<PreparedDownload, TransferError> {
    prepare_download_cancellable(root, relative, limits, CancellationToken::new()).await
}
pub(crate) async fn prepare_download_cancellable(
    root: &Path,
    relative: &str,
    limits: ArchiveLimits,
    cancellation: CancellationToken,
) -> Result<PreparedDownload, TransferError> {
    if cancellation.is_cancelled() {
        return Err(WorkspaceError::Cancelled.into());
    }
    let root = paths::normalize_root(root, false).await?;
    if cancellation.is_cancelled() {
        return Err(WorkspaceError::Cancelled.into());
    }
    let (target, relative) = paths::resolve_relative(&root, relative)?;
    let (_, path) = paths::canonical_existing_within(&root, &target).await?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| TransferError::operation("stat", &path, error))?;
    let source = if metadata.is_dir() {
        PreparedSource::Archive(limits.plan_cancellable(&path, cancellation.clone()).await?)
    } else {
        if !metadata.is_file() {
            return Err(WorkspaceError::NotFile { path: path.clone() }.into());
        }
        if cancellation.is_cancelled() {
            return Err(WorkspaceError::Cancelled.into());
        }
        let file = open_regular_read_file(&path)
            .await
            .map_err(|error| TransferError::operation("open", &path, error))?;
        let metadata = file
            .metadata()
            .await
            .map_err(|error| TransferError::operation("stat", &path, error))?;
        if !metadata.is_file() {
            return Err(WorkspaceError::NotFile { path: path.clone() }.into());
        }
        let version = file_version(&metadata)
            .map_err(|error| TransferError::operation("stat", &path, error))?;
        PreparedSource::File { file, version }
    };
    let name = super::download_file_name(&path, matches!(source, PreparedSource::Archive(_)));
    Ok(PreparedDownload {
        root,
        path,
        relative,
        name,
        source,
    })
}

/// Opens the resolved leaf without following a link substituted after containment checks.
/// Nonblocking admission also prevents a substituted FIFO from parking a filesystem worker.
pub(crate) async fn open_regular_read_file(path: &Path) -> std::io::Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options.open(path).await?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Download source is not a regular file.",
        ));
    }
    Ok(file)
}
fn io_wire(
    cwd: &str,
    relative: &str,
    path: &Path,
    operation: &'static str,
    error: std::io::Error,
) -> Value {
    crate::workspace::WorkspaceRpc::download_failure(
        cwd,
        relative,
        &TransferError::operation(operation, path, error),
    )
}
pub(crate) fn download_error(reason: &str, message: &str) -> Value {
    json!({"_tag":"ProjectDownloadError","reason":reason,"message":message})
}

#[derive(Clone, Default)]
pub struct DownloadSlots {
    counts: Arc<Mutex<HashMap<UploadOwner, usize>>>,
}
pub struct DownloadPermit {
    slots: DownloadSlots,
    owner: UploadOwner,
}
impl DownloadSlots {
    pub fn acquire(&self, owner: &UploadOwner) -> Result<DownloadPermit, Value> {
        let mut counts = self.counts.lock().expect("download slots");
        let count = counts.entry(owner.clone()).or_default();
        if *count >= 4 {
            return Err(download_error(
                "capacity",
                "Wait for another download to finish, then try again.",
            ));
        }
        *count += 1;
        Ok(DownloadPermit {
            slots: self.clone(),
            owner: owner.clone(),
        })
    }
}
impl Drop for DownloadPermit {
    fn drop(&mut self) {
        let mut counts = self.slots.counts.lock().expect("download slots");
        if let Some(count) = counts.get_mut(&self.owner) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.owner);
            }
        }
    }
}

pub(crate) struct ChunkPacer {
    size: usize,
    last: Option<Instant>,
}
impl Default for ChunkPacer {
    fn default() -> Self {
        Self {
            size: 64 * 1024,
            last: None,
        }
    }
}
impl ChunkPacer {
    pub(crate) fn size(&self) -> usize {
        self.size
    }
    pub(crate) fn handed_off(&mut self) {
        let now = Instant::now();
        if let Some(last) = self.last {
            let millis = now.duration_since(last).as_millis().max(1);
            let target = (self.size as u128 * 1000 / millis)
                .clamp((self.size / 2) as u128, (self.size * 2) as u128);
            self.size = usize::try_from(target)
                .unwrap_or(1024 * 1024)
                .clamp(16 * 1024, 1024 * 1024);
        }
        self.last = Some(now);
    }
}
pub(crate) async fn send_chunk(
    sender: &mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
    chunk: RpcStreamChunk,
) -> bool {
    tokio::select! {biased; ()=cancellation.cancelled()=>false,result=sender.send(chunk)=>result.is_ok()}
}
pub(crate) fn download_stream(
    workspace: WorkspaceRpc,
    slots: DownloadSlots,
    owner: UploadOwner,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(1);
    let owner_workspace = workspace.clone();
    let rejected = sender.clone();
    let rejected_input = request.payload.clone();
    if !owner_workspace.spawn_read_work(cancellation.clone(),async move {
        let input: ProjectReadDownloadInput = match serde_json::from_value(request.payload) {
            Ok(input) => input,
            Err(error) => {
                send_chunk(&sender,&cancellation,Err(json!({"_tag":"InvalidRequest","method":request.tag,"message":error.to_string()}))).await;
                return;
            }
        };
        let _permit = match slots.acquire(&owner) {
            Ok(permit) => permit,
            Err(error) => {
                send_chunk(&sender, &cancellation, Err(error)).await;
                return;
            }
        };
        let preparing=workspace.prepare_rpc_download_cancellable(&input,cancellation.clone());
        tokio::pin!(preparing);
        let prepared=tokio::select! {
            biased;
            ()=cancellation.cancelled()=>{let _=preparing.await;return;},
            ()=sender.closed()=>{cancellation.cancel();let _=preparing.await;return;},
            result=&mut preparing=>result,
        };
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                send_chunk(&sender, &cancellation, Err(error)).await;
                return;
            }
        };
        let start = json!({"_tag":"start","fileName":prepared.file_name(),"kind":prepared.kind(),"sizeBytes":prepared.size_bytes(),"version":prepared.version()});
        let total = input.offset.unwrap_or(0);
        let is_empty = prepared.size_bytes() == Some(0);
        let mut reader = match prepared.reader(total, input.expect.as_ref()).await {
            Ok(reader) => reader,
            Err(error) => {
                send_chunk(&sender, &cancellation, Err(error)).await;
                return;
            }
        };
        pump_download(&mut reader, start, total, is_empty, &sender, &cancellation).await;
    }) {
        let _=rejected.try_send(Err(json!({"_tag":"ProjectTransferError","cwd":rejected_input["cwd"],"relativePath":rejected_input["relativePath"],"failure":"operation_failed","message":"Server file readers are shutting down."})));
    }
    receiver
}

async fn pump_download(
    reader: &mut DownloadReader,
    start: Value,
    mut total: u64,
    is_empty: bool,
    sender: &mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
) {
    if is_empty {
        match reader.finish(0).await {
            Ok(()) => {
                send_chunk(
                    sender,
                    cancellation,
                    Ok(vec![start, json!({"_tag":"end","totalBytes":0})]),
                )
                .await;
            }
            Err(error) => {
                send_chunk(sender, cancellation, Err(error)).await;
            }
        }
    } else if send_chunk(sender, cancellation, Ok(vec![start])).await {
        let mut pacer = ChunkPacer::default();
        loop {
            let mut buffer = vec![0; pacer.size()];
            let read = tokio::select! {biased; ()=cancellation.cancelled()=>break,()=sender.closed()=>break,result=reader.reader.read(&mut buffer)=>result};
            match read {
                Ok(0) => {
                    match reader.finish(total).await {
                        Ok(()) => {
                            send_chunk(
                                sender,
                                cancellation,
                                Ok(vec![json!({"_tag":"end","totalBytes":total})]),
                            )
                            .await;
                        }
                        Err(error) => {
                            send_chunk(sender, cancellation, Err(error)).await;
                        }
                    }
                    break;
                }
                Ok(size) => {
                    buffer.truncate(size);
                    let event =
                        json!({"_tag":"bytes","offset":total,"data":STANDARD.encode(&buffer)});
                    total += u64::try_from(size).expect("bounded chunk");
                    if !send_chunk(sender, cancellation, Ok(vec![event])).await {
                        break;
                    }
                    pacer.handed_off();
                }
                Err(error) => {
                    send_chunk(
                        sender,
                        cancellation,
                        Err(io_wire(
                            &reader.cwd,
                            &reader.relative,
                            &reader.path,
                            "read",
                            error,
                        )),
                    )
                    .await;
                    break;
                }
            }
        }
    }
    reader.cancel().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RequestId, workspace::WorkspaceService};
    use serde_json::json;
    use std::time::Duration;

    fn request(
        root: &Path,
        relative: &str,
        offset: u64,
        expect: Option<ProjectFileVersion>,
    ) -> RpcRequest {
        RpcRequest {
            id: RequestId::try_from("1").unwrap(),
            tag: "projects.readDownload".into(),
            payload: json!({"cwd":root,"relativePath":relative,"offset":offset,"expect":expect}),
            headers: vec![],
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }
    async fn collect(mut stream: mpsc::Receiver<RpcStreamChunk>) -> Vec<Result<Vec<Value>, Value>> {
        let mut chunks = Vec::new();
        while let Some(chunk) = stream.recv().await {
            chunks.push(chunk);
        }
        chunks
    }
    fn workspace() -> WorkspaceRpc {
        WorkspaceRpc::new(WorkspaceService::default())
    }
    fn owner() -> UploadOwner {
        UploadOwner::Session("owner-a".into())
    }
    #[tokio::test]
    async fn cancelled_archive_preparation_retains_capacity_until_the_real_scan_joins() {
        for drop_receiver in [false, true] {
            let root = tempfile::tempdir().unwrap();
            std::fs::create_dir(root.path().join("src")).unwrap();
            std::fs::write(root.path().join("src/a"), b"abc").unwrap();
            let mut pause = super::super::archive::pause_next_plan(&root.path().join("src"));
            let slots = DownloadSlots::default();
            let _held: Vec<_> = (0..3).map(|_| slots.acquire(&owner()).unwrap()).collect();
            let rpc = workspace();
            let cancellation = CancellationToken::new();
            let stream = download_stream(
                rpc.clone(),
                slots.clone(),
                owner(),
                request(root.path(), "src", 0, None),
                cancellation.clone(),
            );
            tokio::time::timeout(Duration::from_secs(2), pause.entered())
                .await
                .unwrap();
            let mut retained = Some(stream);
            if drop_receiver {
                retained.take();
            } else {
                cancellation.cancel();
            }
            for _ in 0..40 {
                tokio::task::yield_now().await;
            }
            assert!(
                slots.acquire(&owner()).is_err(),
                "cancellation must not release capacity while the real scan is blocked"
            );
            pause.release();
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if slots.acquire(&owner()).is_ok() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if let Some(mut stream) = retained {
                assert!(stream.recv().await.is_none());
            }
            rpc.shutdown().await;
        }
    }
    #[tokio::test]
    async fn workspace_shutdown_fences_read_admission_and_waits_for_actual_scan_cleanup() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("a"), b"abc").unwrap();
        let mut pause = super::super::archive::pause_next_plan(&root.path().join("src"));
        let rpc = workspace();
        let slots = DownloadSlots::default();
        let _held: Vec<_> = (0..3).map(|_| slots.acquire(&owner()).unwrap()).collect();
        let mut stream = download_stream(
            rpc.clone(),
            slots.clone(),
            owner(),
            request(root.path(), "src", 0, None),
            CancellationToken::new(),
        );
        tokio::time::timeout(Duration::from_secs(2), pause.entered())
            .await
            .unwrap();
        let closing = rpc.clone();
        let shutdown = tokio::spawn(async move {
            closing.shutdown().await;
        });
        for _ in 0..40 {
            tokio::task::yield_now().await;
        }
        assert!(
            !shutdown.is_finished(),
            "shutdown must observe the still-blocked real scan"
        );
        assert!(slots.acquire(&owner()).is_err());
        let mut refused = download_stream(
            rpc.clone(),
            slots.clone(),
            owner(),
            request(root.path(), "a", 0, None),
            CancellationToken::new(),
        );
        assert_eq!(
            refused.recv().await.unwrap().unwrap_err()["_tag"],
            "ProjectTransferError"
        );
        pause.release();
        tokio::time::timeout(Duration::from_secs(2), shutdown)
            .await
            .unwrap()
            .unwrap();
        assert!(stream.recv().await.is_none());
        assert!(slots.acquire(&owner()).is_ok());
    }
    struct BlockingGate(Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>);
    impl BlockingGate {
        fn new() -> Self {
            Self(Arc::new((
                std::sync::Mutex::new(false),
                std::sync::Condvar::new(),
            )))
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
    fn cancelled_real_file_read_retains_capacity_until_queued_io_finishes() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap()
            .block_on(async {
                let root = tempfile::tempdir().unwrap();
                std::fs::write(root.path().join("a"), vec![17; 128 * 1024]).unwrap();
                let mut reader = prepare_download(root.path(), "a", ArchiveLimits::default())
                    .await
                    .unwrap()
                    .reader(0, None)
                    .await
                    .unwrap();
                let gate = BlockingGate::new();
                let held_gate = gate.0.clone();
                let (entered, ready) = tokio::sync::oneshot::channel();
                let blocker = tokio::task::spawn_blocking(move || {
                    entered.send(()).unwrap();
                    let mut released = held_gate.0.lock().unwrap();
                    while !*released {
                        released = held_gate.1.wait(released).unwrap();
                    }
                });
                ready.await.unwrap();
                // Poll the actual Tokio file while its sole blocking worker is occupied.
                // This proves its real read is queued in Busy, rather than relying on a fake reader.
                {
                    let mut bytes = [0; 64];
                    let read = reader.reader.read(&mut bytes);
                    tokio::pin!(read);
                    assert!(futures_util::poll!(read).is_pending());
                }
                let slots = DownloadSlots::default();
                let _held: Vec<_> = (0..3).map(|_| slots.acquire(&owner()).unwrap()).collect();
                let permit = slots.acquire(&owner()).unwrap();
                let cancellation = CancellationToken::new();
                let worker_cancel = cancellation.clone();
                let (sender, _receiver) = mpsc::channel(1);
                let (began, started) = tokio::sync::oneshot::channel();
                let worker = tokio::spawn(async move {
                    let _permit = permit;
                    began.send(()).unwrap();
                    pump_download(
                        &mut reader,
                        json!({"_tag":"start"}),
                        0,
                        false,
                        &sender,
                        &worker_cancel,
                    )
                    .await;
                });
                started.await.unwrap();
                cancellation.cancel();
                for _ in 0..40 {
                    tokio::task::yield_now().await;
                }
                assert!(
                    slots.acquire(&owner()).is_err(),
                    "Busy file IO still owns its capacity after cancellation"
                );
                assert!(
                    !worker.is_finished(),
                    "cleanup must observe the actual queued read"
                );
                gate.release();
                blocker.await.unwrap();
                tokio::time::timeout(Duration::from_secs(2), worker)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(slots.acquire(&owner()).is_ok());
            });
    }
    struct CountingReader {
        reads: Arc<std::sync::atomic::AtomicUsize>,
        bytes: std::io::Cursor<Vec<u8>>,
    }
    impl AsyncRead for CountingReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            context: &mut std::task::Context<'_>,
            buffer: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Pin::new(&mut self.bytes).poll_read(context, buffer)
        }
    }
    #[tokio::test]
    async fn slow_sink_keeps_at_most_three_server_chunks() {
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let source = CountingReader {
            reads: reads.clone(),
            bytes: std::io::Cursor::new(vec![17; 4 * 1024 * 1024]),
        };
        let mut reader = DownloadReader {
            reader: OwnedReadSource::Instrumented(Box::pin(source)),
            completion: None,
            metadata: None,
            cwd: "/fixture".into(),
            relative: "file".into(),
            path: PathBuf::from("/fixture/file"),
        };
        let (sender, mut receiver) = mpsc::channel(1);
        let cancellation = CancellationToken::new();
        let worker_cancel = cancellation.clone();
        let worker = tokio::spawn(async move {
            pump_download(
                &mut reader,
                json!({"_tag":"start"}),
                0,
                false,
                &sender,
                &worker_cancel,
            )
            .await;
        });
        assert_eq!(receiver.recv().await.unwrap().unwrap()[0]["_tag"], "start");
        let inflight = receiver.recv().await.unwrap().unwrap();
        assert_eq!(inflight[0]["offset"], 0);
        assert_eq!(
            STANDARD
                .decode(inflight[0]["data"].as_str().unwrap())
                .unwrap()
                .len(),
            64 * 1024
        );
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        // One chunk removed to the wire, one queued, one read and blocked at send.
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 3);
        cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn download_from_zero_and_resume_return_exact_contiguous_bytes() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a"), b"abcdef").unwrap();
        let chunks = collect(download_stream(
            workspace(),
            DownloadSlots::default(),
            owner(),
            request(root.path(), "a", 0, None),
            CancellationToken::new(),
        ))
        .await;
        let values: Vec<Value> = chunks.into_iter().flat_map(Result::unwrap).collect();
        assert_eq!(values[0]["sizeBytes"], 6);
        assert_eq!(values[1]["offset"], 0);
        assert_eq!(
            STANDARD
                .decode(values[1]["data"].as_str().unwrap())
                .unwrap(),
            b"abcdef"
        );
        assert_eq!(values[2], json!({"_tag":"end","totalBytes":6}));
        let version = serde_json::from_value(values[0]["version"].clone()).unwrap();
        let values: Vec<Value> = collect(download_stream(
            workspace(),
            DownloadSlots::default(),
            owner(),
            request(root.path(), "a", 3, Some(version)),
            CancellationToken::new(),
        ))
        .await
        .into_iter()
        .flat_map(Result::unwrap)
        .collect();
        assert_eq!(values[1]["offset"], 3);
        assert_eq!(
            STANDARD
                .decode(values[1]["data"].as_str().unwrap())
                .unwrap(),
            b"def"
        );
        assert_eq!(values[2]["totalBytes"], 6);
    }
    #[tokio::test]
    async fn zero_byte_file_sends_start_and_end_in_one_chunk() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("empty"), b"").unwrap();
        let chunks = collect(download_stream(
            workspace(),
            DownloadSlots::default(),
            owner(),
            request(root.path(), "empty", 0, None),
            CancellationToken::new(),
        ))
        .await;
        assert_eq!(chunks.len(), 1);
        let values = chunks[0].as_ref().unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["_tag"], "start");
        assert_eq!(values[0]["sizeBytes"], 0);
        assert_eq!(values[1], json!({"_tag":"end","totalBytes":0}));
    }
    #[tokio::test]
    async fn changed_version_and_missing_expect_refuse_nonzero_offsets() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a"), b"abc").unwrap();
        let prepared = prepare_download(root.path(), "a", ArchiveLimits::default())
            .await
            .unwrap();
        let version = prepared.version().cloned().unwrap();
        for (offset, expected) in [(1, None), (4, Some(version.clone()))] {
            assert_eq!(
                prepare_download(root.path(), "a", ArchiveLimits::default())
                    .await
                    .unwrap()
                    .reader(offset, expected.as_ref())
                    .await
                    .err()
                    .unwrap()["reason"],
                "changed"
            );
        }
        std::fs::write(root.path().join("a"), b"changed").unwrap();
        assert_eq!(
            prepare_download(root.path(), "a", ArchiveLimits::default())
                .await
                .unwrap()
                .reader(1, Some(&version))
                .await
                .err()
                .unwrap()["reason"],
            "changed"
        );
    }
    #[tokio::test]
    async fn archive_is_streamed_and_cannot_resume_at_a_nonzero_offset() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/a"), b"abc").unwrap();
        let prepared = prepare_download(root.path(), "src", ArchiveLimits::default())
            .await
            .unwrap();
        assert_eq!(
            prepared.reader(1, None).await.err().unwrap()["reason"],
            "not_resumable"
        );
        let values: Vec<Value> = collect(download_stream(
            workspace(),
            DownloadSlots::default(),
            owner(),
            request(root.path(), "src", 0, None),
            CancellationToken::new(),
        ))
        .await
        .into_iter()
        .flat_map(Result::unwrap)
        .collect();
        assert_eq!(values[0]["kind"], "archive");
        assert!(values[0]["version"].is_null());
        let bytes: Vec<u8> = values
            .iter()
            .filter(|value| value["_tag"] == "bytes")
            .flat_map(|value| STANDARD.decode(value["data"].as_str().unwrap()).unwrap())
            .collect();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        use std::io::Read;
        let mut content = Vec::new();
        zip.by_name("a").unwrap().read_to_end(&mut content).unwrap();
        assert_eq!(content, b"abc");
        assert_eq!(values.last().unwrap()["_tag"], "end");
    }
    #[test]
    fn fifth_download_is_capacity_and_owners_have_separate_slots() {
        let slots = DownloadSlots::default();
        let permits: Vec<_> = (0..4).map(|_| slots.acquire(&owner()).unwrap()).collect();
        assert_eq!(slots.acquire(&owner()).err().unwrap()["reason"], "capacity");
        let other = slots
            .acquire(&UploadOwner::Session("other".into()))
            .unwrap();
        drop(permits);
        drop(other);
        assert!(slots.acquire(&owner()).is_ok());
    }
    #[tokio::test]
    async fn parent_and_symlink_escape_and_archive_limits_fail_before_start() {
        let root = tempfile::tempdir().unwrap();
        for path in ["", ".", "../outside"] {
            assert!(
                prepare_download(root.path(), path, ArchiveLimits::default())
                    .await
                    .is_err()
            );
        }
        std::fs::create_dir(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/a"), b"abc").unwrap();
        assert!(matches!(
            prepare_download(
                root.path(),
                "src",
                ArchiveLimits {
                    max_bytes: 2,
                    max_entries: 10
                }
            )
            .await,
            Err(TransferError::TooManyBytes { limit: 2 })
        ));
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("secret"), b"secret").unwrap();
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
            assert!(
                prepare_download(root.path(), "escape/secret", ArchiveLimits::default())
                    .await
                    .is_err()
            );
        }
    }
    #[tokio::test]
    async fn archive_writer_error_is_not_successful_completion() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        let prepared = prepare_download(root.path(), "src", ArchiveLimits::default())
            .await
            .unwrap();
        std::fs::remove_dir(root.path().join("src")).unwrap();
        let mut reader = prepared.reader(0, None).await.unwrap();
        let mut bytes = Vec::new();
        reader.reader.read_to_end(&mut bytes).await.unwrap();
        assert!(reader.finish(0).await.is_err());
    }
    #[tokio::test]
    async fn interrupt_or_receiver_drop_releases_owner_slot() {
        for interrupt in [false, true] {
            let root = tempfile::tempdir().unwrap();
            std::fs::write(root.path().join("a"), vec![7; 1024 * 1024]).unwrap();
            let slots = DownloadSlots::default();
            let permits: Vec<_> = (0..3).map(|_| slots.acquire(&owner()).unwrap()).collect();
            let cancel = CancellationToken::new();
            let mut stream = download_stream(
                workspace(),
                slots.clone(),
                owner(),
                request(root.path(), "a", 0, None),
                cancel.clone(),
            );
            assert_eq!(stream.recv().await.unwrap().unwrap()[0]["_tag"], "start");
            assert!(slots.acquire(&owner()).is_err());
            if interrupt {
                cancel.cancel();
                while stream.recv().await.is_some() {}
            } else {
                drop(stream);
            }
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if slots.acquire(&owner()).is_ok() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            drop(permits);
        }
    }
    #[tokio::test]
    async fn midstream_file_change_never_emits_end_and_admission_does_not_span_backpressure() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a");
        std::fs::write(&path, vec![7; 1024 * 1024]).unwrap();
        let registry = crate::worktree_catalog::WorkspaceAvailabilityRegistry::new();
        let rpc = workspace().with_availability_registry(registry.clone());
        let mut stream = download_stream(
            rpc,
            DownloadSlots::default(),
            owner(),
            request(root.path(), "a", 0, None),
            CancellationToken::new(),
        );
        assert_eq!(stream.recv().await.unwrap().unwrap()[0]["_tag"], "start");
        let guard = tokio::time::timeout(
            Duration::from_secs(2),
            registry.mark_removing("thread", root.path()),
        )
        .await
        .unwrap()
        .unwrap();
        std::fs::write(&path, b"truncated").unwrap();
        let mut failure = None;
        while let Some(chunk) = stream.recv().await {
            match chunk {
                Ok(events) => assert!(events.iter().all(|event| event["_tag"] != "end")),
                Err(error) => failure = Some(error),
            }
        }
        assert_eq!(failure.unwrap()["reason"], "changed");
        drop(guard);
    }
    #[tokio::test]
    async fn same_size_modified_file_refuses_resume_and_nonregular_leaves_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a");
        std::fs::write(&path, b"abc").unwrap();
        let original = prepare_download(root.path(), "a", ArchiveLimits::default())
            .await
            .unwrap()
            .version()
            .cloned()
            .unwrap();
        std::fs::File::open(&path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1)),
            )
            .unwrap();
        assert_eq!(
            prepare_download(root.path(), "a", ArchiveLimits::default())
                .await
                .unwrap()
                .reader(1, Some(&original))
                .await
                .err()
                .unwrap()["reason"],
            "changed"
        );
        #[cfg(unix)]
        {
            let _socket =
                std::os::unix::net::UnixListener::bind(root.path().join("socket")).unwrap();
            assert!(
                prepare_download(root.path(), "socket", ArchiveLimits::default())
                    .await
                    .is_err()
            );
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn opened_download_keeps_its_original_handle_after_a_leaf_replacement() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = root.path().join("a");
        std::fs::write(&path, b"original").unwrap();
        std::fs::write(outside.path().join("secret"), b"private").unwrap();
        let prepared = prepare_download(root.path(), "a", ArchiveLimits::default())
            .await
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), &path).unwrap();
        assert!(open_regular_read_file(&path).await.is_err());
        let mut source = prepared.reader(0, None).await.unwrap();
        let mut bytes = Vec::new();
        source.reader.read_to_end(&mut bytes).await.unwrap();
        source
            .finish(u64::try_from(bytes.len()).unwrap())
            .await
            .unwrap();
        assert_eq!(bytes, b"original");
    }
}
