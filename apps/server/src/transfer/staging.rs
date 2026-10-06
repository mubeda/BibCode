//! Session-owned, bounded chat attachment staging. Acknowledgements follow disk flush.
use crate::rpc::RpcSessionContext;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    sync::{OwnedMutexGuard, watch},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum UploadOwner {
    Session(String),
    Unauthenticated,
}
impl UploadOwner {
    pub(crate) fn from_context(context: &RpcSessionContext) -> Self {
        context
            .current_session_id()
            .map_or(Self::Unauthenticated, |id| Self::Session(id.into()))
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "_tag")]
pub enum UploadTarget {
    #[serde(rename = "chat-attachment", rename_all = "camelCase")]
    ChatAttachment {
        #[serde(rename = "type")]
        attachment_type: String,
        name: String,
        mime_type: String,
    },
}
#[derive(Clone, Debug)]
pub struct UploadLimits {
    pub chat_per_owner: usize,
    pub chat_max_bytes: u64,
    pub chat_server_bytes: u64,
    pub idle: Duration,
    pub gap_wait: Duration,
}
impl Default for UploadLimits {
    fn default() -> Self {
        Self {
            chat_per_owner: 16,
            chat_max_bytes: 10 * 1024 * 1024,
            chat_server_bytes: 256 * 1024 * 1024,
            idle: Duration::from_secs(600),
            gap_wait: Duration::from_secs(10),
        }
    }
}
pub type UploadClock = Arc<dyn Fn() -> Instant + Send + Sync>;
#[derive(Clone)]
pub struct UploadRegistry {
    inner: Arc<Registry>,
}
impl std::fmt::Debug for UploadRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UploadRegistry")
            .field("directory", &self.inner.directory)
            .finish_non_exhaustive()
    }
}
struct Registry {
    directory: PathBuf,
    limits: UploadLimits,
    now: UploadClock,
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    closed: Mutex<bool>,
    stop: CancellationToken,
    writers: tokio_util::task::TaskTracker,
    #[cfg(test)]
    after_write: Mutex<Option<Arc<WritePause>>>,
}
struct Entry {
    owner: UploadOwner,
    target: UploadTarget,
    size: u64,
    path: PathBuf,
    state: Arc<tokio::sync::Mutex<EntryState>>,
    changed: watch::Sender<u64>,
}
struct EntryState {
    file: Option<tokio::fs::File>,
    received: u64,
    hasher: Sha256,
    expected: Option<String>,
    complete: bool,
    retired: bool,
    activity: Instant,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBeginInput {
    pub target: UploadTarget,
    pub size_bytes: u64,
    pub sha256: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAppendInput {
    pub upload_id: String,
    pub offset: u64,
    pub data: String,
    pub sha256: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBeginResult {
    pub upload_id: String,
    pub exists: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAppendResult {
    pub received_bytes: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadGetResult {
    pub upload_id: String,
    pub size_bytes: u64,
    pub received_bytes: u64,
    pub complete: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadErrorReason {
    Quota,
    NotFound,
    Offset,
    Digest,
    Size,
    Invalid,
}
#[derive(Debug, thiserror::Error, Serialize)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct UploadError {
    #[serde(rename = "_tag")]
    tag: &'static str,
    pub reason: UploadErrorReason,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_bytes: Option<u64>,
}
impl UploadError {
    pub(crate) fn new(reason: UploadErrorReason, message: impl Into<String>) -> Self {
        Self {
            tag: "UploadError",
            reason,
            message: message.into(),
            received_bytes: None,
        }
    }
    fn missing() -> Self {
        Self::new(
            UploadErrorReason::NotFound,
            "Upload is unavailable; attach the file again",
        )
    }
    fn offset(received: u64) -> Self {
        let mut error = Self::new(
            UploadErrorReason::Offset,
            "Chunk does not start at the acknowledged offset",
        );
        error.received_bytes = Some(received);
        error
    }
    pub(crate) fn io(error: std::io::Error) -> Self {
        Self::new(
            UploadErrorReason::Invalid,
            format!("Upload storage failed: {error}"),
        )
    }
}
fn validate_digest(digest: Option<&str>) -> Result<(), UploadError> {
    if digest.is_some_and(|s| {
        s.len() != 64
            || !s
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err(UploadError::new(
            UploadErrorReason::Invalid,
            "SHA-256 must be lowercase hexadecimal",
        ));
    }
    Ok(())
}
impl UploadRegistry {
    pub fn new(directory: PathBuf, limits: UploadLimits, now: UploadClock) -> Self {
        Self {
            inner: Arc::new(Registry {
                directory,
                limits,
                now,
                entries: Mutex::new(HashMap::new()),
                closed: Mutex::new(false),
                stop: CancellationToken::new(),
                writers: tokio_util::task::TaskTracker::new(),
                #[cfg(test)]
                after_write: Mutex::new(None),
            }),
        }
    }
    fn admit_writer(
        &self,
    ) -> Result<tokio_util::task::task_tracker::TaskTrackerToken, UploadError> {
        let closed = self.inner.closed.lock().expect("upload admission poisoned");
        if *closed {
            return Err(UploadError::missing());
        }
        Ok(self.inner.writers.token())
    }
    pub async fn shutdown(&self) {
        *self.inner.closed.lock().expect("upload admission poisoned") = true;
        self.inner.stop.cancel();
        self.inner.writers.close();
        self.inner.writers.wait().await;
        let entries: Vec<_> = self
            .inner
            .entries
            .lock()
            .expect("upload registry poisoned")
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect();
        for (id, entry) in entries {
            let mut state = entry.state.lock().await;
            if let Err(error) = self.retire(&id, &entry, &mut state) {
                tracing::warn!(%error, "upload shutdown cleanup failed");
            }
        }
    }
    fn lookup(&self, owner: &UploadOwner, id: &str) -> Result<Arc<Entry>, UploadError> {
        self.inner
            .entries
            .lock()
            .expect("upload registry poisoned")
            .get(id)
            .filter(|e| &e.owner == owner)
            .cloned()
            .ok_or_else(UploadError::missing)
    }
    fn remove(&self, id: &str) {
        self.inner
            .entries
            .lock()
            .expect("upload registry poisoned")
            .remove(id);
    }
    fn retire(&self, id: &str, entry: &Entry, state: &mut EntryState) -> Result<(), UploadError> {
        state.retired = true;
        state.file.take();
        entry.changed.send_replace(state.received);
        match std::fs::remove_file(&entry.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(UploadError::io(e)),
        }
        self.remove(id);
        Ok(())
    }
    fn ensure_live(
        &self,
        id: &str,
        entry: &Entry,
        state: &mut EntryState,
    ) -> Result<(), UploadError> {
        if state.retired {
            return Err(UploadError::missing());
        }
        if (self.inner.now)().duration_since(state.activity) >= self.inner.limits.idle {
            self.retire(id, entry, state)?;
            return Err(UploadError::missing());
        }
        Ok(())
    }
    pub async fn begin(
        &self,
        owner: &UploadOwner,
        input: UploadBeginInput,
    ) -> Result<UploadBeginResult, UploadError> {
        let admission = self.admit_writer()?;
        let this = self.clone();
        let owner = owner.clone();
        // Admitted work owns its cleanup even if the RPC caller disconnects.
        tokio::spawn(async move {
            let _admission = admission;
            this.begin_owned(owner, input).await
        })
        .await
        .map_err(|e| UploadError::new(UploadErrorReason::Invalid, e.to_string()))?
    }
    async fn begin_owned(
        &self,
        owner: UploadOwner,
        input: UploadBeginInput,
    ) -> Result<UploadBeginResult, UploadError> {
        self.sweep().await?;
        if input.size_bytes > self.inner.limits.chat_max_bytes {
            return Err(UploadError::new(
                UploadErrorReason::Size,
                "Attachment exceeds upload size limit",
            ));
        }
        let UploadTarget::ChatAttachment {
            attachment_type,
            name,
            mime_type,
        } = &input.target;
        crate::provider::attachments::validate_upload_metadata(
            attachment_type,
            name,
            mime_type,
            input.size_bytes,
        )
        .map_err(|e| UploadError::new(UploadErrorReason::Invalid, e.to_string()))?;
        validate_digest(input.sha256.as_deref())?;
        let id = Uuid::new_v4().to_string();
        let (changed, _) = watch::channel(0);
        let entry = Arc::new(Entry {
            owner,
            target: input.target,
            size: input.size_bytes,
            path: self.inner.directory.join(format!("{id}.upload")),
            state: Arc::new(tokio::sync::Mutex::new(EntryState {
                file: None,
                received: 0,
                hasher: Sha256::new(),
                expected: input.sha256,
                complete: false,
                retired: false,
                activity: (self.inner.now)(),
            })),
            changed,
        });
        let mut state = entry.state.clone().lock_owned().await;
        {
            let mut entries = self.inner.entries.lock().expect("upload registry poisoned");
            let reserved = entries
                .values()
                .try_fold(0_u64, |sum, e| sum.checked_add(e.size))
                .unwrap_or(u64::MAX);
            if entries.values().filter(|e| e.owner == entry.owner).count()
                >= self.inner.limits.chat_per_owner
                || reserved
                    .checked_add(entry.size)
                    .is_none_or(|n| n > self.inner.limits.chat_server_bytes)
            {
                return Err(UploadError::new(
                    UploadErrorReason::Quota,
                    "Upload quota exceeded; cancel an upload or wait for expiry",
                ));
            }
            entries.insert(id.clone(), entry.clone());
        }
        let created = async {
            tokio::fs::create_dir_all(&self.inner.directory).await?;
            // Reject an aliased staging directory; generated leaves are create_new.
            let metadata = tokio::fs::symlink_metadata(&self.inner.directory).await?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(std::io::Error::other("invalid upload directory"));
            }
            tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&entry.path)
                .await
        }
        .await;
        match created {
            Ok(file) => state.file = Some(file),
            Err(error) => {
                self.remove(&id);
                return Err(UploadError::io(error));
            }
        }
        if entry.size == 0 && state.expected.is_some() {
            if state.expected.as_deref() != Some(crate::crypto::sha256_hex(b"").as_str()) {
                self.retire(&id, &entry, &mut state)?;
                return Err(UploadError::new(
                    UploadErrorReason::Digest,
                    "Upload digest does not match",
                ));
            }
            state.file.take();
            state.complete = true;
        }
        Ok(UploadBeginResult {
            upload_id: id,
            exists: false,
        })
    }
    pub async fn append(
        &self,
        owner: &UploadOwner,
        input: UploadAppendInput,
    ) -> Result<UploadAppendResult, UploadError> {
        let entry = self.lookup(owner, &input.upload_id)?;
        if input.data.len() > 1_398_104 {
            return Err(UploadError::new(
                UploadErrorReason::Invalid,
                "Chunk exceeds 1 MiB",
            ));
        }
        validate_digest(input.sha256.as_deref())?;
        let deadline = Instant::now() + self.inner.limits.gap_wait;
        let mut changed = entry.changed.subscribe();
        // Wait for earlier acknowledgements without holding a writer or decoded buffer.
        let state = loop {
            let mut state = entry.state.clone().lock_owned().await;
            self.ensure_live(&input.upload_id, &entry, &mut state)?;
            if input.offset <= state.received {
                break state;
            }
            drop(state);
            tokio::select! {
                () = self.inner.stop.cancelled() => return Err(UploadError::missing()),
                result = tokio::time::timeout_at(deadline, changed.changed()) => { if result.is_err() { let state = entry.state.lock().await; return Err(UploadError::offset(state.received)); } }
            }
        };
        let admission = self.admit_writer()?;
        let this = self.clone();
        tokio::spawn(async move {
            let _admission = admission;
            this.append_owned(entry, input, state).await
        })
        .await
        .map_err(|e| UploadError::new(UploadErrorReason::Invalid, e.to_string()))?
    }
    async fn append_owned(
        &self,
        entry: Arc<Entry>,
        input: UploadAppendInput,
        mut state: OwnedMutexGuard<EntryState>,
    ) -> Result<UploadAppendResult, UploadError> {
        self.ensure_live(&input.upload_id, &entry, &mut state)?;
        let bytes = STANDARD.decode(&input.data).map_err(|_| {
            UploadError::new(
                UploadErrorReason::Invalid,
                "Chunk must contain canonical base64",
            )
        })?;
        if bytes.len() > 1024 * 1024 || STANDARD.encode(&bytes) != input.data {
            return Err(UploadError::new(
                UploadErrorReason::Invalid,
                "Chunk must contain at most 1 MiB of canonical base64",
            ));
        }
        if let (Some(expected), Some(proposed)) = (state.expected.as_ref(), input.sha256.as_ref())
            && expected != proposed
        {
            return Err(UploadError::new(
                UploadErrorReason::Digest,
                "Conflicting upload digest",
            ));
        }
        let end = input
            .offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| UploadError::new(UploadErrorReason::Size, "Chunk size overflow"))?;
        if end > entry.size {
            self.retire(&input.upload_id, &entry, &mut state)?;
            return Err(UploadError::new(
                UploadErrorReason::Size,
                "Chunk exceeds declared upload size",
            ));
        }
        let zero_completion =
            entry.size == 0 && input.offset == 0 && bytes.is_empty() && !state.complete;
        if !zero_completion && end <= state.received {
            state.activity = (self.inner.now)();
            return Ok(UploadAppendResult {
                received_bytes: state.received,
            });
        }
        if input.offset != state.received || state.complete {
            return Err(UploadError::offset(state.received));
        }
        let expected = state.expected.clone().or(input.sha256);
        if end == entry.size && expected.is_none() {
            return Err(UploadError::new(
                UploadErrorReason::Invalid,
                "Completion requires a SHA-256 digest",
            ));
        }
        let file = state.file.as_mut().ok_or_else(UploadError::missing)?;
        if let Err(error) = async {
            file.write_all(&bytes).await?;
            #[cfg(test)]
            {
                let pause = self.inner.after_write.lock().unwrap().clone();
                if let Some(pause) = pause {
                    pause.reached.notify_one();
                    pause.resume.notified().await;
                }
            }
            file.flush().await
        }
        .await
        {
            self.retire(&input.upload_id, &entry, &mut state)?;
            return Err(UploadError::io(error));
        }
        state.hasher.update(&bytes);
        state.received = end;
        state.expected = expected;
        if end == entry.size {
            if state.expected.as_deref()
                != Some(
                    state
                        .hasher
                        .clone()
                        .finalize()
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                        .as_str(),
                )
            {
                self.retire(&input.upload_id, &entry, &mut state)?;
                return Err(UploadError::new(
                    UploadErrorReason::Digest,
                    "Upload digest does not match",
                ));
            }
            state.file.take();
            state.complete = true;
        }
        state.activity = (self.inner.now)();
        entry.changed.send_replace(state.received);
        Ok(UploadAppendResult {
            received_bytes: state.received,
        })
    }
    pub async fn get(&self, owner: &UploadOwner, id: &str) -> Result<UploadGetResult, UploadError> {
        let entry = self.lookup(owner, id)?;
        let mut state = entry.state.lock().await;
        self.ensure_live(id, &entry, &mut state)?;
        state.activity = (self.inner.now)();
        Ok(UploadGetResult {
            upload_id: id.into(),
            size_bytes: entry.size,
            received_bytes: state.received,
            complete: state.complete,
        })
    }
    pub async fn cancel(&self, owner: &UploadOwner, id: &str) -> Result<(), UploadError> {
        let Ok(entry) = self.lookup(owner, id) else {
            return Ok(());
        };
        let mut state = entry.state.lock().await;
        self.retire(id, &entry, &mut state)
    }
    pub async fn sweep(&self) -> Result<(), UploadError> {
        let entries: Vec<_> = self
            .inner
            .entries
            .lock()
            .expect("upload registry poisoned")
            .iter()
            .map(|(id, e)| (id.clone(), e.clone()))
            .collect();
        for (id, entry) in entries {
            if let Ok(mut state) = entry.state.try_lock()
                && (state.retired
                    || (self.inner.now)().duration_since(state.activity) >= self.inner.limits.idle)
            {
                self.retire(&id, &entry, &mut state)?;
            }
        }
        Ok(())
    }
    pub fn start_sweeper(&self) -> UploadSweepTask {
        let stop = CancellationToken::new();
        let cancellation = stop.clone();
        let registry = self.clone();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { () = cancellation.cancelled() => break, _ = interval.tick() => { if let Err(error) = registry.sweep().await { tracing::warn!(%error, "upload expiry cleanup failed"); } } }
            }
        });
        UploadSweepTask {
            stop,
            task: tokio::sync::Mutex::new(Some(task)),
        }
    }
    pub(crate) async fn bind(
        &self,
        owner: &UploadOwner,
        id: &str,
        target: &UploadTarget,
        size: u64,
    ) -> Result<UploadBinding, UploadError> {
        let entry = self.lookup(owner, id)?;
        let mut state = entry.state.clone().lock_owned().await;
        self.ensure_live(id, &entry, &mut state)?;
        if !state.complete || state.expected.is_none() {
            return Err(UploadError::new(
                UploadErrorReason::Invalid,
                "Upload is incomplete",
            ));
        }
        if &entry.target != target || entry.size != size {
            return Err(UploadError::new(
                UploadErrorReason::Invalid,
                "Attachment metadata does not match staged upload",
            ));
        }
        state.activity = (self.inner.now)();
        Ok(UploadBinding {
            registry: self.clone(),
            id: id.into(),
            entry,
            state,
        })
    }
}
pub(crate) struct UploadBinding {
    registry: UploadRegistry,
    id: String,
    entry: Arc<Entry>,
    state: OwnedMutexGuard<EntryState>,
}
impl std::fmt::Debug for UploadBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UploadBinding")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}
impl UploadBinding {
    pub(crate) fn path(&self) -> &Path {
        &self.entry.path
    }
    pub(crate) fn digest(&self) -> &str {
        self.state
            .expected
            .as_deref()
            .expect("completed upload has digest")
    }
    pub(crate) fn commit(mut self) {
        if let Err(error) = self.registry.retire(&self.id, &self.entry, &mut self.state) {
            tracing::warn!(%error, "accepted upload cleanup deferred to sweeper");
        }
    }
}
pub async fn wipe_chat_partials(directory: &Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(directory).await?;
    let metadata = tokio::fs::symlink_metadata(directory).await?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::other("invalid upload directory"));
    }
    let mut entries = tokio::fs::read_dir(directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".upload")) else {
            continue;
        };
        if Uuid::parse_str(id).is_ok() && entry.file_type().await?.is_file() {
            tokio::fs::remove_file(entry.path()).await?;
        }
    }
    Ok(())
}
pub struct UploadSweepTask {
    stop: CancellationToken,
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl UploadSweepTask {
    pub async fn shutdown(&self) {
        self.stop.cancel();
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}
impl Drop for UploadSweepTask {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
#[cfg(test)]
#[derive(Default)]
struct WritePause {
    reached: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, time::Duration};
    use tempfile::TempDir;
    fn digest(bytes: &[u8]) -> String {
        crate::crypto::sha256_hex(bytes)
    }
    fn owner() -> UploadOwner {
        UploadOwner::Session("owner-a".into())
    }
    fn target() -> UploadTarget {
        UploadTarget::ChatAttachment {
            attachment_type: "file".into(),
            name: "notes.txt".into(),
            mime_type: "text/plain".into(),
        }
    }
    fn fixture(limits: UploadLimits) -> (TempDir, UploadRegistry) {
        let temp = tempfile::tempdir().unwrap();
        let registry = UploadRegistry::new(
            temp.path().join("attachment-uploads"),
            limits,
            Arc::new(tokio::time::Instant::now),
        );
        (temp, registry)
    }
    async fn begin(r: &UploadRegistry, size: u64, hash: Option<String>) -> String {
        r.begin(
            &owner(),
            UploadBeginInput {
                target: target(),
                size_bytes: size,
                sha256: hash,
            },
        )
        .await
        .unwrap()
        .upload_id
    }
    fn chunk(id: &str, offset: u64, bytes: &[u8], hash: Option<String>) -> UploadAppendInput {
        UploadAppendInput {
            upload_id: id.into(),
            offset,
            data: STANDARD.encode(bytes),
            sha256: hash,
        }
    }
    fn partial(temp: &TempDir, id: &str) -> std::path::PathBuf {
        temp.path()
            .join("attachment-uploads")
            .join(format!("{id}.upload"))
    }
    #[tokio::test]
    async fn acknowledged_bytes_are_flushed_and_completion_requires_digest() {
        let (temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 6, None).await;
        assert_eq!(
            r.append(&owner(), chunk(&id, 0, b"abc", None))
                .await
                .unwrap()
                .received_bytes,
            3
        );
        assert_eq!(tokio::fs::read(partial(&temp, &id)).await.unwrap(), b"abc");
        let error = r
            .append(&owner(), chunk(&id, 3, b"def", None))
            .await
            .unwrap_err();
        assert_eq!(error.reason, UploadErrorReason::Invalid);
        assert!(!r.get(&owner(), &id).await.unwrap().complete);
        r.append(&owner(), chunk(&id, 3, b"def", Some(digest(b"abcdef"))))
            .await
            .unwrap();
        let status = r.get(&owner(), &id).await.unwrap();
        assert!(status.complete);
        assert_eq!(status.received_bytes, 6);
        assert_eq!(
            tokio::fs::read(partial(&temp, &id)).await.unwrap(),
            b"abcdef"
        );
    }
    #[tokio::test]
    async fn duplicate_does_not_write_and_overlap_reports_the_flushed_offset() {
        let (temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 6, Some(digest(b"abcdef"))).await;
        r.append(&owner(), chunk(&id, 0, b"abc", None))
            .await
            .unwrap();
        assert_eq!(
            r.append(&owner(), chunk(&id, 0, b"abc", None))
                .await
                .unwrap()
                .received_bytes,
            3
        );
        let error = r
            .append(&owner(), chunk(&id, 2, b"cd", None))
            .await
            .unwrap_err();
        assert_eq!(error.reason, UploadErrorReason::Offset);
        assert_eq!(error.received_bytes, Some(3));
        assert_eq!(tokio::fs::read(partial(&temp, &id)).await.unwrap(), b"abc");
    }
    #[tokio::test(start_paused = true)]
    async fn early_chunk_waits_without_holding_its_predecessors_write_lock() {
        let (_temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 6, Some(digest(b"abcdef"))).await;
        let later_r = r.clone();
        let later_id = id.clone();
        let later = tokio::spawn(async move {
            later_r
                .append(&owner(), chunk(&later_id, 3, b"def", None))
                .await
        });
        tokio::task::yield_now().await;
        assert!(!later.is_finished());
        r.append(&owner(), chunk(&id, 0, b"abc", None))
            .await
            .unwrap();
        assert_eq!(later.await.unwrap().unwrap().received_bytes, 6);
        assert!(r.get(&owner(), &id).await.unwrap().complete);
    }
    #[tokio::test(start_paused = true)]
    async fn a_gap_times_out_at_ten_seconds_with_the_actual_offset() {
        let (_temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 6, Some(digest(b"abcdef"))).await;
        let write =
            tokio::spawn(async move { r.append(&owner(), chunk(&id, 3, b"def", None)).await });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(9)).await;
        assert!(!write.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        let error = write.await.unwrap().unwrap_err();
        assert_eq!(error.reason, UploadErrorReason::Offset);
        assert_eq!(error.received_bytes, Some(0));
    }
    #[tokio::test]
    async fn digest_and_size_mismatches_forget_the_entry_and_remove_the_partial() {
        let (temp, r) = fixture(UploadLimits::default());
        for (size, bytes, expected) in [
            (3, b"bad".as_slice(), UploadErrorReason::Digest),
            (2, b"abc".as_slice(), UploadErrorReason::Size),
        ] {
            let id = begin(&r, size, Some(digest(b"abc"))).await;
            assert_eq!(
                r.append(&owner(), chunk(&id, 0, bytes, None))
                    .await
                    .unwrap_err()
                    .reason,
                expected
            );
            assert!(!partial(&temp, &id).exists());
            assert_eq!(
                r.get(&owner(), &id).await.unwrap_err().reason,
                UploadErrorReason::NotFound
            );
        }
    }
    #[tokio::test]
    async fn malformed_base64_and_oversized_chunks_are_typed_and_do_not_write() {
        let (temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 2 * 1024 * 1024, None).await;
        let mut bad = chunk(&id, 0, b"", None);
        bad.data = "%%%".into();
        assert_eq!(
            r.append(&owner(), bad).await.unwrap_err().reason,
            UploadErrorReason::Invalid
        );
        assert_eq!(
            tokio::fs::metadata(partial(&temp, &id))
                .await
                .unwrap()
                .len(),
            0
        );
        let too_big = vec![0; 1024 * 1024 + 1];
        assert!(
            r.append(&owner(), chunk(&id, 0, &too_big, None))
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn declared_byte_and_owner_quotas_are_released_by_cancel() {
        let limits = UploadLimits {
            chat_per_owner: 2,
            chat_max_bytes: 4,
            chat_server_bytes: 6,
            ..UploadLimits::default()
        };
        let (_temp, r) = fixture(limits);
        let first = begin(&r, 3, None).await;
        let _second = begin(&r, 3, None).await;
        let input = UploadBeginInput {
            target: target(),
            size_bytes: 1,
            sha256: None,
        };
        assert_eq!(
            r.begin(&owner(), input.clone()).await.unwrap_err().reason,
            UploadErrorReason::Quota
        );
        assert_eq!(
            r.begin(&UploadOwner::Session("b".into()), input.clone())
                .await
                .unwrap_err()
                .reason,
            UploadErrorReason::Quota
        );
        r.cancel(&owner(), &first).await.unwrap();
        assert!(r.begin(&owner(), input).await.is_ok());
        let oversized = UploadBeginInput {
            target: target(),
            size_bytes: 5,
            sha256: None,
        };
        assert_eq!(
            r.begin(&owner(), oversized).await.unwrap_err().reason,
            UploadErrorReason::Size
        );
    }
    #[tokio::test(start_paused = true)]
    async fn idle_and_finished_unbound_uploads_expire_and_get_refreshes_activity() {
        let (temp, r) = fixture(UploadLimits::default());
        let idle = begin(&r, 3, None).await;
        let done = begin(&r, 0, Some(digest(b""))).await;
        let active = begin(&r, 1, None).await;
        tokio::time::advance(Duration::from_secs(599)).await;
        r.get(&owner(), &active).await.unwrap();
        tokio::time::advance(Duration::from_secs(1)).await;
        r.sweep().await.unwrap();
        for id in [idle, done] {
            assert_eq!(
                r.get(&owner(), &id).await.unwrap_err().reason,
                UploadErrorReason::NotFound
            );
            assert!(!partial(&temp, &id).exists());
        }
        assert!(r.get(&owner(), &active).await.is_ok());
    }
    #[tokio::test]
    async fn empty_upload_completes_with_a_digest_at_begin_or_append() {
        let (_temp, r) = fixture(UploadLimits::default());
        let complete = begin(&r, 0, Some(digest(b""))).await;
        assert!(r.get(&owner(), &complete).await.unwrap().complete);
        let later = begin(&r, 0, None).await;
        assert!(!r.get(&owner(), &later).await.unwrap().complete);
        r.append(&owner(), chunk(&later, 0, b"", Some(digest(b""))))
            .await
            .unwrap();
        assert!(r.get(&owner(), &later).await.unwrap().complete);
    }
    #[tokio::test]
    async fn another_owner_is_indistinguishable_from_an_unknown_id_and_cancel_is_idempotent() {
        let (temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 3, None).await;
        let other = UploadOwner::Session("other".into());
        assert_eq!(
            r.get(&other, &id).await.unwrap_err().reason,
            UploadErrorReason::NotFound
        );
        assert_eq!(
            r.append(&other, chunk(&id, 0, b"abc", Some(digest(b"abc"))))
                .await
                .unwrap_err()
                .reason,
            UploadErrorReason::NotFound
        );
        r.cancel(&other, &id).await.unwrap(); // same no-op success as an unknown id
        assert!(partial(&temp, &id).exists());
        r.cancel(&owner(), &id).await.unwrap();
        r.cancel(&owner(), &id).await.unwrap();
        assert!(!partial(&temp, &id).exists());
    }
    #[tokio::test]
    async fn startup_wipe_removes_only_chat_partial_leaves() {
        let (temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 3, None).await;
        let attachment_dir = temp.path().join("attachments");
        tokio::fs::create_dir(&attachment_dir).await.unwrap();
        tokio::fs::write(attachment_dir.join("bound-id"), b"kept")
            .await
            .unwrap();
        drop(r);
        wipe_chat_partials(&temp.path().join("attachment-uploads"))
            .await
            .unwrap();
        assert!(!partial(&temp, &id).exists());
        assert_eq!(
            tokio::fs::read(attachment_dir.join("bound-id"))
                .await
                .unwrap(),
            b"kept"
        );
    }
    #[tokio::test]
    async fn canceled_caller_keeps_owned_writer_until_flush_and_cancel_fences_it() {
        let (temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 3, Some(digest(b"abc"))).await;
        let pause = Arc::new(WritePause::default());
        *r.inner.after_write.lock().unwrap() = Some(pause.clone());
        let writer_r = r.clone();
        let writer_id = id.clone();
        let caller = tokio::spawn(async move {
            writer_r
                .append(&owner(), chunk(&writer_id, 0, b"abc", None))
                .await
        });
        pause.reached.notified().await;
        caller.abort();
        let cancel_r = r.clone();
        let cancel_id = id.clone();
        let cancel = tokio::spawn(async move { cancel_r.cancel(&owner(), &cancel_id).await });
        tokio::task::yield_now().await;
        assert!(!cancel.is_finished());
        pause.resume.notify_one();
        cancel.await.unwrap().unwrap();
        assert!(!partial(&temp, &id).exists());
        assert_eq!(
            r.get(&owner(), &id).await.unwrap_err().reason,
            UploadErrorReason::NotFound
        );
        r.shutdown().await;
        assert_eq!(r.inner.writers.len(), 0);
    }
    #[tokio::test(start_paused = true)]
    async fn completed_upload_get_keeps_it_alive_until_the_last_activity_expires() {
        let (_temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 0, Some(digest(b""))).await;
        for _ in 0..4 {
            tokio::time::advance(Duration::from_secs(599)).await;
            assert!(r.get(&owner(), &id).await.unwrap().complete);
            r.sweep().await.unwrap();
        }
        tokio::time::advance(Duration::from_secs(600)).await;
        assert_eq!(
            r.get(&owner(), &id).await.unwrap_err().reason,
            UploadErrorReason::NotFound
        );
    }
    #[tokio::test]
    async fn cancel_wakes_a_waiting_gap_without_writing_or_revealing_owner() {
        let (temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 6, Some(digest(b"abcdef"))).await;
        let waiter_r = r.clone();
        let waiter_id = id.clone();
        let waiter = tokio::spawn(async move {
            waiter_r
                .append(&owner(), chunk(&waiter_id, 3, b"def", None))
                .await
        });
        tokio::task::yield_now().await;
        r.cancel(&owner(), &id).await.unwrap();
        let error = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.reason, UploadErrorReason::NotFound);
        assert!(!partial(&temp, &id).exists());
    }
    #[tokio::test]
    async fn failed_stage_creation_releases_the_declared_reservation() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("stages");
        std::fs::write(&directory, b"not a directory").unwrap();
        let r = UploadRegistry::new(
            directory.clone(),
            UploadLimits {
                chat_per_owner: 1,
                chat_server_bytes: 3,
                ..UploadLimits::default()
            },
            Arc::new(Instant::now),
        );
        let input = UploadBeginInput {
            target: target(),
            size_bytes: 3,
            sha256: None,
        };
        assert_eq!(
            r.begin(&owner(), input.clone()).await.unwrap_err().reason,
            UploadErrorReason::Invalid
        );
        std::fs::remove_file(directory).unwrap();
        assert!(r.begin(&owner(), input).await.is_ok());
    }
    #[tokio::test(start_paused = true)]
    async fn owned_sweeper_expires_idle_stages_and_shutdown_closes_writer_admission() {
        let (temp, r) = fixture(UploadLimits {
            idle: Duration::from_secs(60),
            ..UploadLimits::default()
        });
        let id = begin(&r, 3, None).await;
        let sweeper = r.start_sweeper();
        tokio::time::advance(Duration::from_secs(61)).await;
        tokio::task::yield_now().await;
        assert!(!partial(&temp, &id).exists());
        sweeper.shutdown().await;
        r.shutdown().await;
        assert_eq!(
            r.begin(
                &owner(),
                UploadBeginInput {
                    target: target(),
                    size_bytes: 3,
                    sha256: None
                }
            )
            .await
            .unwrap_err()
            .reason,
            UploadErrorReason::NotFound
        );
    }
    #[tokio::test]
    async fn conflicting_late_digest_is_refused_without_consuming_the_valid_stage() {
        let (_temp, r) = fixture(UploadLimits::default());
        let id = begin(&r, 3, Some(digest(b"abc"))).await;
        r.append(&owner(), chunk(&id, 0, b"abc", None))
            .await
            .unwrap();
        assert_eq!(
            r.append(&owner(), chunk(&id, 0, b"abc", Some(digest(b"def"))))
                .await
                .unwrap_err()
                .reason,
            UploadErrorReason::Digest
        );
        assert!(r.get(&owner(), &id).await.unwrap().complete);
    }
}
