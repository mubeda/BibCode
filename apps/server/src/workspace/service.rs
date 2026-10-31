use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Seek as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, Weak};
#[cfg(test)]
use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

use crate::crypto::{lowercase_hex, sha256_hex};

use super::beneath::{self, Dir, Identity, Kind, Open, Removal, Replace, Root};
use super::entries::{self, BrowseResult};
use super::paths::{
    canonical_existing_within, normalize_root, resolve_relative, safe_mutation_target,
};
use super::{EntryKind, WorkspaceError};

const READ_LIMIT_BYTES: usize = 1024 * 1024;
/// How much of a file's old content an in-place write keeps to put back if the write fails
/// after truncating it. Agents write only files within the read limit; a larger file (a
/// person's save) is written without that safety net and the failure says so.
const KEPT_FOR_RESTORE_BYTES: usize = 16 * 1024 * 1024;
const VERSION_SCAN_CHUNK_BYTES: usize = 64 * 1024;
const DUPLICATE_LIMIT: usize = 1000;
const DEFAULT_MAX_CONCURRENT_OPERATIONS: usize = 32;
/// How [`WorkspaceService::write_target`] writes. Every mode writes the file in place, so it
/// keeps its inode, links, owner, permissions, ACLs and extended attributes.
enum WriteMode {
    /// Truncate and write (`projects.writeFile`, which has no precondition).
    InPlace,
    /// The file must not exist: created exclusively.
    CreateNew,
    /// The file must still be the one hashed (`id`) with content `version`, checked through
    /// the very descriptor that then truncates and writes it.
    Unchanged {
        version: String,
        id: Option<Identity>,
        /// Refuse a file with more than one hard link (an outside agent's write).
        single_link_only: bool,
        /// A test's injected write failure right after the truncation.
        fail_after_truncate: bool,
    },
}

#[cfg(test)]
pub(crate) type WorkspaceWriteHookFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), WorkspaceError>> + Send + 'a>>;

#[cfg(test)]
pub(crate) trait WorkspaceWriteHook: Send + Sync {
    fn after_write<'a>(&'a self, target: &'a Path) -> WorkspaceWriteHookFuture<'a>;

    /// Runs after a guarded write's precondition held and before it writes.
    fn after_precondition_check<'a>(&'a self, _target: &'a Path) -> WorkspaceWriteHookFuture<'a> {
        Box::pin(async { Ok(()) })
    }

    /// Runs after an operation's paths were checked against the root and before it touches
    /// the file system: the window a folder swapped for a symlink would exploit.
    fn after_containment_check<'a>(&'a self, _target: &'a Path) -> WorkspaceWriteHookFuture<'a> {
        Box::pin(async { Ok(()) })
    }

    /// Whether an in-place write fails right after it truncated the file.
    fn fail_after_truncate(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    pub relative_path: String,
    pub contents: String,
    pub byte_length: usize,
    pub truncated: bool,
    /// Lowercase hex SHA-256 of the exact bytes returned, before lossy UTF-8 decoding.
    pub version: String,
}

/// Why a file that exists can no longer be opened in the editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnreadableFileFailure {
    BinaryFile,
    FileTooLarge,
}

/// What is on disk at a path now, as `projects.getFileVersion` reports it.
///
/// A file within the read limit has the version `read_file` returns for it. An unreadable one is
/// hashed whole, so a save can still be guarded against exactly the state the user was shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "_tag", rename_all = "camelCase")]
pub enum FileVersion {
    Present {
        version: String,
    },
    Missing,
    Unreadable {
        failure: UnreadableFileFailure,
        version: String,
    },
}

/// The disk state a guarded write was based on.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "_tag", rename_all = "camelCase")]
pub enum WritePrecondition {
    /// The file must exist and its whole content must hash to `version`.
    Version { version: String },
    /// Nothing may exist at the path.
    Missing,
}

pub struct WriteFileOutcome {
    pub(crate) relative_path: String,
    pub(crate) path_set_changed: bool,
    pub(crate) index_classification_may_have_changed: bool,
    /// Lowercase hex SHA-256 of the bytes written.
    pub(crate) version: String,
}

/// A file's whole content as hashed in place, or its absence.
enum ScannedFile {
    Missing,
    Present {
        version: String,
        byte_length: u64,
        binary: bool,
        /// The file that was hashed, so a write can tell it is still the same file.
        id: Option<Identity>,
    },
}

/// A canonical target under a canonical root: the folder that holds it and its name, so an
/// operation can reach it through a held folder handle ([`Dir`]) rather than by path.
#[derive(Clone)]
struct Place {
    root: Root,
    target: PathBuf,
    folder: PathBuf,
    name: OsString,
}

impl Place {
    /// `target` (canonical, under the canonical `root`), split into its folder and name. The
    /// root itself is not a file any operation here can address. The root's identity is
    /// recorded now, as part of the check, so a root replaced later is refused.
    fn new(root: PathBuf, target: PathBuf) -> Result<Self, WorkspaceError> {
        let split = (target != root)
            .then(|| target.parent().zip(target.file_name()))
            .flatten()
            .map(|(folder, name)| (folder.to_path_buf(), name.to_os_string()));
        let Some((folder, name)) = split else {
            return Err(WorkspaceError::NotFile { path: target });
        };
        let root = Root::new(&root).map_err(|error| {
            if beneath::is_escape(&error) {
                WorkspaceError::RootNotDirectory { path: root.clone() }
            } else {
                WorkspaceError::operation("stat", &root, error)
            }
        })?;
        Ok(Self {
            root,
            target,
            folder,
            name,
        })
    }

    /// An I/O failure as a workspace error: a folder found swapped for a symlink is the
    /// path resolving outside the root, anything else the operation that failed.
    fn fault(&self, operation: &'static str, error: std::io::Error) -> WorkspaceError {
        if beneath::is_escape(&error) {
            WorkspaceError::ResolvedPathOutsideRoot {
                root: self.root.path().to_path_buf(),
                resolved_path: self.target.clone(),
            }
        } else {
            WorkspaceError::operation(operation, &self.target, error)
        }
    }

    /// The target's folder, held open. With `create`, missing folders are made.
    fn folder(&self, create: bool) -> Result<Dir, WorkspaceError> {
        Dir::open(&self.root, &self.folder, create).map_err(|error| self.fault("open", error))
    }

    /// The target's folder when it exists, `None` when it does not.
    fn existing_folder(&self) -> Result<Option<Dir>, WorkspaceError> {
        match Dir::open(&self.root, &self.folder, false) {
            Ok(dir) => Ok(Some(dir)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(self.fault("open", error)),
        }
    }

    /// What is at the target now, without following a symlink at it.
    fn kind(&self) -> Result<Kind, WorkspaceError> {
        match self.existing_folder()? {
            Some(dir) => dir
                .kind(&self.name)
                .map_err(|error| self.fault("stat", error)),
            None => Ok(Kind::Missing),
        }
    }

    /// The target opened for reading, refused unless it is a regular file.
    fn open_regular(&self) -> Result<std::fs::File, WorkspaceError> {
        let file = self
            .folder(false)?
            .open_file(&self.name, Open::Read)
            .map_err(|error| self.fault("open", error))?;
        let metadata = file.metadata().map_err(|error| self.fault("stat", error))?;
        if !metadata.is_file() {
            return Err(WorkspaceError::NotFile {
                path: self.target.clone(),
            });
        }
        Ok(file)
    }
}

/// Runs blocking file work off the runtime.
async fn blocking<T: Send + 'static>(
    path: &Path,
    work: impl FnOnce() -> Result<T, WorkspaceError> + Send + 'static,
) -> Result<T, WorkspaceError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| WorkspaceError::operation("read", path, std::io::Error::other(error)))?
}

/// Hashes a file's whole content in chunks, without holding it in memory.
///
/// `binary` matches `read_file`'s test: a NUL byte within the first read-limit bytes. A named
/// pipe put in place of the file is opened without blocking and refused as not a file.
fn scan_file_blocking(place: &Place) -> Result<ScannedFile, WorkspaceError> {
    match place.kind()? {
        Kind::Missing => return Ok(ScannedFile::Missing),
        Kind::File => {}
        _ => {
            return Err(WorkspaceError::NotFile {
                path: place.target.clone(),
            });
        }
    }
    let mut file = match place.open_regular() {
        Ok(file) => file,
        Err(WorkspaceError::Operation { source, .. })
            if source.kind() == std::io::ErrorKind::NotFound =>
        {
            return Ok(ScannedFile::Missing);
        }
        Err(error) => return Err(error),
    };
    let id = Identity::of(&file).map_err(|error| place.fault("stat", error))?;
    let (version, byte_length, binary) = hash_open(&mut file, place)?;
    Ok(ScannedFile::Present {
        version,
        byte_length,
        binary,
        id,
    })
}

/// The version (SHA-256 of the whole content), length and binary flag of an open file, read
/// from its start.
fn hash_open(
    file: &mut std::fs::File,
    place: &Place,
) -> Result<(String, u64, bool), WorkspaceError> {
    hash_with(file, place, 0).map(|(version, length, binary, _)| (version, length, binary))
}

/// The version of an open file and, when it is at most `keep` bytes, its whole content.
fn hash_keeping(
    file: &mut std::fs::File,
    place: &Place,
    keep: usize,
) -> Result<(String, Option<Vec<u8>>), WorkspaceError> {
    hash_with(file, place, keep).map(|(version, _, _, kept)| (version, kept))
}

/// A file's version, length, binary flag and, when kept, its content.
type Hashed = (String, u64, bool, Option<Vec<u8>>);

/// [`hash_open`], also keeping the content read while it stays within `keep` bytes.
fn hash_with(
    file: &mut std::fs::File,
    place: &Place,
    keep: usize,
) -> Result<Hashed, WorkspaceError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; VERSION_SCAN_CHUNK_BYTES];
    let mut byte_length = 0_u64;
    let mut binary = false;
    let mut kept = (keep > 0).then(Vec::new);
    loop {
        let read = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(place.fault("read", error)),
        };
        let chunk = &buffer[..read];
        if !binary && byte_length < READ_LIMIT_BYTES as u64 {
            let within_limit = (READ_LIMIT_BYTES as u64 - byte_length).min(read as u64) as usize;
            binary = chunk[..within_limit].contains(&0);
        }
        hasher.update(chunk);
        byte_length += read as u64;
        kept = kept
            .filter(|kept| kept.len() + read <= keep)
            .map(|mut kept| {
                kept.extend_from_slice(chunk);
                kept
            });
    }
    Ok((lowercase_hex(&hasher.finalize()), byte_length, binary, kept))
}

/// How many hard links a file has; one where the platform reports none.
fn link_count(metadata: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        std::os::unix::fs::MetadataExt::nlink(metadata)
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        1
    }
}

async fn scan_file(place: Place) -> Result<ScannedFile, WorkspaceError> {
    let path = place.target.clone();
    blocking(&path, move || scan_file_blocking(&place)).await
}

/// One lock per canonical file path, so a guarded write's check and write are atomic against
/// every other write BiBCode makes to that file. Entries are dropped once nobody holds them.
///
/// Keys ignore case. An existing path canonicalizes to its on-disk spelling, but a missing one
/// keeps the caller's, and on a case-insensitive volume (the default on Windows and macOS) two
/// spellings name one file. Folding costs nothing on a case-sensitive volume beyond making
/// writes to names that differ only in case wait for each other.
///
/// The same locks serialize every BiBCode writer of a path (#139 X5): a guarded or plain write
/// from the Files panel or `files_write`, and an upload from its reservation to its install.
/// A write waits for another write at most [`PATH_LOCK_WAIT`]; it never waits for an upload,
/// which can stream for minutes, and is refused at once with [`PathBusy`] instead.
#[derive(Clone, Default)]
pub(crate) struct PathLocks {
    locks: Arc<StdMutex<HashMap<String, Weak<PathEntry>>>>,
}

/// One path's lock, and how many uploads hold or are waiting for it.
#[derive(Default)]
struct PathEntry {
    lock: Arc<Mutex<()>>,
    uploads: std::sync::atomic::AtomicUsize,
}

/// The longest a write or an upload waits for another BiBCode writer of the same path.
const PATH_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Another BiBCode writer holds the path: an upload, or a write that did not finish in time.
#[derive(Debug)]
pub(crate) struct PathBusy;

/// Holds a path for one writer; dropping it lets the next one in.
pub(crate) struct PathGuard {
    _guard: OwnedMutexGuard<()>,
    entry: Arc<PathEntry>,
    upload: bool,
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        if self.upload {
            self.entry
                .uploads
                .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        }
    }
}

impl PathLocks {
    fn entry(&self, path: &Path) -> Arc<PathEntry> {
        let key = path.to_string_lossy().to_lowercase();
        let mut locks = self
            .locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks.retain(|_, entry| entry.strong_count() > 0);
        match locks.get(&key).and_then(Weak::upgrade) {
            Some(entry) => entry,
            None => {
                let entry = Arc::new(PathEntry::default());
                locks.insert(key, Arc::downgrade(&entry));
                entry
            }
        }
    }

    /// The path for a write: refused at once while an upload holds or awaits it.
    pub(crate) async fn lock(&self, path: &Path) -> Result<PathGuard, PathBusy> {
        let entry = self.entry(path);
        if entry.uploads.load(std::sync::atomic::Ordering::Acquire) > 0 {
            return Err(PathBusy);
        }
        let guard = tokio::time::timeout(PATH_LOCK_WAIT, Arc::clone(&entry.lock).lock_owned())
            .await
            .map_err(|_| PathBusy)?;
        // An upload that arrived while this write waited goes first.
        if entry.uploads.load(std::sync::atomic::Ordering::Acquire) > 0 {
            return Err(PathBusy);
        }
        Ok(PathGuard {
            _guard: guard,
            entry,
            upload: false,
        })
    }

    /// The path for an upload, from its reservation to its install. Writes arriving meanwhile
    /// are refused; a write already in progress is waited for.
    pub(crate) async fn lock_upload(&self, path: &Path) -> Result<PathGuard, PathBusy> {
        let entry = self.entry(path);
        entry
            .uploads
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        match tokio::time::timeout(PATH_LOCK_WAIT, Arc::clone(&entry.lock).lock_owned()).await {
            Ok(guard) => Ok(PathGuard {
                _guard: guard,
                entry,
                upload: true,
            }),
            Err(_) => {
                entry
                    .uploads
                    .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                Err(PathBusy)
            }
        }
    }
}

fn write_may_change_index_classification(logical_path: &str, effective_target: &Path) -> bool {
    Path::new(logical_path)
        .components()
        .chain(effective_target.components())
        .any(|component| {
            component.as_os_str().to_str().is_some_and(|component| {
                component.eq_ignore_ascii_case(".git")
                    || component.eq_ignore_ascii_case(".gitignore")
            })
        })
}

#[derive(Clone)]
pub struct WorkspaceService {
    permits: Arc<Semaphore>,
    path_locks: PathLocks,
    /// The system trash `projects.deleteEntry { toTrash }` uses: the one Source Control's
    /// discard uses. Without it a trash request answers `trash_unavailable`.
    trash: Option<Arc<dyn crate::git::FileTrash>>,
    /// The server's state directory, under which a workspace that is no Git repository keeps
    /// its trash holder.
    #[cfg_attr(
        not(unix),
        allow(dead_code, reason = "only the Unix trash stages entries")
    )]
    trash_state: Option<PathBuf>,
    #[cfg(test)]
    write_hook: Option<Arc<dyn WorkspaceWriteHook>>,
}

impl Default for WorkspaceService {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_CONCURRENT_OPERATIONS)
    }
}

impl WorkspaceService {
    pub fn new(max_concurrent_operations: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(max_concurrent_operations.max(1))),
            path_locks: PathLocks::default(),
            trash: None,
            trash_state: None,
            #[cfg(test)]
            write_hook: None,
        }
    }

    #[must_use]
    pub fn with_trash(mut self, trash: Arc<dyn crate::git::FileTrash>, state: PathBuf) -> Self {
        self.trash = Some(trash);
        self.trash_state = Some(state);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_write_hook_for_test(mut self, hook: Arc<dyn WorkspaceWriteHook>) -> Self {
        self.write_hook = Some(hook);
        self
    }

    /// The per-path locks every BiBCode writer of a workspace file takes, uploads included.
    pub(crate) fn path_locks(&self) -> PathLocks {
        self.path_locks.clone()
    }

    pub(crate) async fn permit(&self) -> Result<OwnedSemaphorePermit, WorkspaceError> {
        self.permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| WorkspaceError::Cancelled)
    }

    /// The test hook between an operation's containment check and its first file system call.
    async fn containment_checked(&self, target: &Path) -> Result<(), WorkspaceError> {
        #[cfg(test)]
        if let Some(hook) = &self.write_hook {
            hook.after_containment_check(target).await?;
        }
        let _ = target;
        Ok(())
    }

    /// `relative_path` under `root`, resolved through every symlink and checked to stay
    /// inside: the place a read or write of an existing file acts on.
    async fn existing_place(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<(Place, String), WorkspaceError> {
        let (target, normalized) = resolve_relative(root, relative_path)?;
        let (canonical_root, canonical_target) = canonical_existing_within(root, &target).await?;
        self.containment_checked(&canonical_target).await?;
        Ok((Place::new(canonical_root, canonical_target)?, normalized))
    }

    /// `relative_path` under `root`, with its deepest existing folder resolved and checked to
    /// stay inside: the place a write or creation acts on.
    async fn mutation_place(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<(Place, String), WorkspaceError> {
        let (target, normalized) = resolve_relative(root, relative_path)?;
        let target = safe_mutation_target(root, &target).await?;
        let canonical_root = normalize_root(root, false).await?;
        Ok((Place::new(canonical_root, target)?, normalized))
    }

    /// The entry `relative_path` names itself (a symlink at it is the entry, not its target),
    /// in its folder resolved and checked to stay inside: the place a rename or delete acts on.
    /// The entry's own target must stay inside too, as before.
    async fn entry_place(&self, root: &Path, relative_path: &str) -> Result<Place, WorkspaceError> {
        let (target, _) = resolve_relative(root, relative_path)?;
        if !tokio::fs::try_exists(&target)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &target, error))?
        {
            return Err(WorkspaceError::NotFound { path: target });
        }
        canonical_existing_within(root, &target).await?;
        let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
            return Err(WorkspaceError::PathOutsideRoot {
                relative_path: relative_path.to_owned(),
            });
        };
        let (canonical_root, folder) = canonical_existing_within(root, parent).await?;
        Place::new(canonical_root, folder.join(name))
    }

    pub async fn read_file(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<ReadFileResult, WorkspaceError> {
        let _permit = self.permit().await?;
        let (place, normalized_relative) = self.existing_place(root, relative_path).await?;
        let target = place.target.clone();
        let (bytes, byte_length) = blocking(&target, move || {
            let file = place.open_regular()?;
            let byte_length = file
                .metadata()
                .map(|metadata| usize::try_from(metadata.len()).unwrap_or(usize::MAX))
                .map_err(|error| place.fault("stat", error))?;
            let mut bytes = Vec::with_capacity(byte_length.min(READ_LIMIT_BYTES));
            file.take(READ_LIMIT_BYTES as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| place.fault("read", error))?;
            Ok((bytes, byte_length))
        })
        .await?;
        if bytes.contains(&0) {
            return Err(WorkspaceError::BinaryFile { path: target });
        }
        Ok(ReadFileResult {
            relative_path: normalized_relative,
            version: sha256_hex(&bytes),
            contents: String::from_utf8_lossy(&bytes).into_owned(),
            byte_length,
            truncated: byte_length > READ_LIMIT_BYTES,
        })
    }

    /// Reports what is on disk at the path now without returning its contents.
    pub async fn file_version(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<FileVersion, WorkspaceError> {
        let _permit = self.permit().await?;
        let place = match self.existing_place(root, relative_path).await {
            Ok((place, _)) => place,
            Err(WorkspaceError::Operation { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                return Ok(FileVersion::Missing);
            }
            Err(error) => return Err(error),
        };
        Ok(match scan_file(place).await? {
            ScannedFile::Missing => FileVersion::Missing,
            ScannedFile::Present {
                version, binary, ..
            } if binary => FileVersion::Unreadable {
                failure: UnreadableFileFailure::BinaryFile,
                version,
            },
            ScannedFile::Present {
                version,
                byte_length,
                ..
            } if byte_length > READ_LIMIT_BYTES as u64 => FileVersion::Unreadable {
                failure: UnreadableFileFailure::FileTooLarge,
                version,
            },
            ScannedFile::Present { version, .. } => FileVersion::Present { version },
        })
    }

    pub async fn write_file(
        &self,
        root: &Path,
        relative_path: &str,
        contents: &str,
    ) -> Result<WriteFileOutcome, WorkspaceError> {
        let _permit = self.permit().await?;
        let (place, normalized) = self.mutation_place(root, relative_path).await?;
        let _path_lock = self
            .path_locks
            .lock(&place.target)
            .await
            .map_err(|PathBusy| WorkspaceError::PathBusy {
                path: place.target.clone(),
            })?;
        self.containment_checked(&place.target).await?;
        self.write_target(place, normalized, contents, WriteMode::InPlace)
            .await
    }

    /// Writes only when the file on disk is still the state the caller's contents were based on.
    ///
    /// The check and the write hold the path's lock, so two BiBCode clients cannot both pass the
    /// check. A writer outside BiBCode can still land between them; closing that window would need
    /// locking other tools do not honour.
    pub async fn write_file_if_unchanged(
        &self,
        root: &Path,
        relative_path: &str,
        contents: &str,
        precondition: &WritePrecondition,
    ) -> Result<WriteFileOutcome, WorkspaceError> {
        self.write_file_if_unchanged_with(root, relative_path, contents, precondition, false)
            .await
    }

    /// [`Self::write_file_if_unchanged`]; with `single_link_only` (an outside agent's
    /// `files_write`), a file with more than one hard link is refused (`hard_linked`): writing
    /// it in place would change every other name it has, which can be outside the workspace. A
    /// person's save of their own hard-linked file stays allowed.
    pub async fn write_file_if_unchanged_with(
        &self,
        root: &Path,
        relative_path: &str,
        contents: &str,
        precondition: &WritePrecondition,
        single_link_only: bool,
    ) -> Result<WriteFileOutcome, WorkspaceError> {
        let _permit = self.permit().await?;
        let (place, normalized) = self.mutation_place(root, relative_path).await?;
        let _path_lock = self
            .path_locks
            .lock(&place.target)
            .await
            .map_err(|PathBusy| WorkspaceError::PathBusy {
                path: place.target.clone(),
            })?;
        self.containment_checked(&place.target).await?;
        let target = place.target.clone();
        let mode = match (precondition, scan_file(place.clone()).await?) {
            (WritePrecondition::Version { .. }, ScannedFile::Missing) => {
                return Err(WorkspaceError::FileMissingOnDisk { path: target });
            }
            (
                WritePrecondition::Version { version: expected },
                ScannedFile::Present { version, .. },
            ) if version != *expected => {
                return Err(WorkspaceError::FileChangedOnDisk { path: target });
            }
            (WritePrecondition::Missing, ScannedFile::Present { .. }) => {
                return Err(WorkspaceError::FileChangedOnDisk { path: target });
            }
            (WritePrecondition::Missing, ScannedFile::Missing) => WriteMode::CreateNew,
            (WritePrecondition::Version { version }, ScannedFile::Present { id, .. }) => {
                WriteMode::Unchanged {
                    version: version.clone(),
                    id,
                    single_link_only,
                    fail_after_truncate: self.fails_after_truncate(),
                }
            }
        };
        #[cfg(test)]
        if let Some(hook) = &self.write_hook {
            hook.after_precondition_check(&target).await?;
        }
        self.write_target(place, normalized, contents, mode).await
    }

    /// Whether a test asked the next in-place write to fail right after truncating.
    fn fails_after_truncate(&self) -> bool {
        #[cfg(test)]
        if let Some(hook) = &self.write_hook {
            return hook.fail_after_truncate();
        }
        false
    }

    /// Writes through the folder's handle, creating missing folders. The target is canonical,
    /// so a write to a symlink inside the root writes the file it names, as before; a symlink
    /// found at the name now (a dangling one, or a swap) is refused.
    ///
    /// A guarded write never truncates a file another BiBCode writer changed after its check
    /// (the path's lock serializes them): `CreateNew` creates exclusively, and `Unchanged`
    /// re-checks identity and content through the descriptor it then writes.
    async fn write_target(
        &self,
        place: Place,
        normalized: String,
        contents: &str,
        mode: WriteMode,
    ) -> Result<WriteFileOutcome, WorkspaceError> {
        let target = place.target.clone();
        let bytes = contents.as_bytes().to_vec();
        let (target_existed, parent_existed) = blocking(&target, move || {
            let parent_existed = place.existing_folder()?.is_some();
            let dir = place.folder(true)?;
            let target_existed = dir
                .kind(&place.name)
                .map_err(|error| place.fault("exists", error))?
                != Kind::Missing;
            let changed = || WorkspaceError::FileChangedOnDisk {
                path: place.target.clone(),
            };
            match mode {
                WriteMode::InPlace => {
                    let mut file = dir
                        .open_file(&place.name, Open::Write)
                        .map_err(|error| place.fault("write-file", error))?;
                    file.write_all(&bytes)
                        .map_err(|error| place.fault("write-file", error))?;
                }
                WriteMode::CreateNew => {
                    let mut file = match dir.open_file(&place.name, Open::CreateNew) {
                        Ok(file) => file,
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            return Err(changed());
                        }
                        Err(error) => return Err(place.fault("write-file", error)),
                    };
                    file.write_all(&bytes)
                        .map_err(|error| place.fault("write-file", error))?;
                }
                WriteMode::Unchanged {
                    version,
                    id,
                    single_link_only,
                    fail_after_truncate,
                } => {
                    // Opened without creating or truncating; checked through this descriptor,
                    // then truncated and written through it. Other BiBCode writers of the path
                    // wait on its lock; an outside editor writing between the check and the
                    // write is the documented residual (POSIX has no compare-and-swap).
                    let mut file = match dir.open_file(&place.name, Open::Existing) {
                        Ok(file) => file,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            return Err(WorkspaceError::FileMissingOnDisk {
                                path: place.target.clone(),
                            });
                        }
                        Err(error) => return Err(place.fault("write-file", error)),
                    };
                    let metadata = file
                        .metadata()
                        .map_err(|error| place.fault("stat", error))?;
                    if !metadata.is_file() {
                        return Err(WorkspaceError::NotFile {
                            path: place.target.clone(),
                        });
                    }
                    if single_link_only && link_count(&metadata) > 1 {
                        return Err(WorkspaceError::HardLinked {
                            path: place.target.clone(),
                        });
                    }
                    let now_id = Identity::of(&file).map_err(|error| place.fault("stat", error))?;
                    // The old content is kept (up to a cap) so a write that fails after the
                    // truncation can put it back.
                    let (now, old) = hash_keeping(&mut file, &place, KEPT_FOR_RESTORE_BYTES)?;
                    if now_id != id || now != version {
                        return Err(changed());
                    }
                    file.set_len(0)
                        .map_err(|error| place.fault("write-file", error))?;
                    let written = if fail_after_truncate {
                        Err(std::io::Error::other("an injected write failure"))
                    } else {
                        file.seek(std::io::SeekFrom::Start(0))
                            .map(drop)
                            .and_then(|()| file.write_all(&bytes))
                    };
                    if let Err(error) = written {
                        let restored = old.is_some_and(|old| {
                            file.set_len(0)
                                .and_then(|()| file.seek(std::io::SeekFrom::Start(0)).map(drop))
                                .and_then(|()| file.write_all(&old))
                                .is_ok()
                        });
                        return Err(WorkspaceError::WriteFailed {
                            path: place.target.clone(),
                            reason: error.to_string(),
                            restored,
                        });
                    }
                }
            }
            Ok((target_existed, parent_existed))
        })
        .await?;
        #[cfg(test)]
        if let Some(hook) = &self.write_hook {
            hook.after_write(&target).await?;
        }
        Ok(WriteFileOutcome {
            index_classification_may_have_changed: write_may_change_index_classification(
                &normalized,
                &target,
            ),
            relative_path: normalized,
            path_set_changed: !target_existed || !parent_existed,
            version: sha256_hex(contents.as_bytes()),
        })
    }

    pub async fn create_entry(
        &self,
        root: &Path,
        relative_path: &str,
        kind: EntryKind,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (place, normalized) = self.mutation_place(root, relative_path).await?;
        self.containment_checked(&place.target).await?;
        let target = place.target.clone();
        blocking(&target, move || {
            if place.kind()? != Kind::Missing {
                return Err(WorkspaceError::AlreadyExists {
                    path: place.target.clone(),
                });
            }
            match kind {
                EntryKind::Directory => Dir::open(&place.root, &place.target, true)
                    .map(drop)
                    .map_err(|error| place.fault("make-directory", error)),
                EntryKind::File => place
                    .folder(true)?
                    .open_file(&place.name, Open::CreateNew)
                    .map(drop)
                    .map_err(|error| place.fault("write-file", error)),
            }
        })
        .await?;
        Ok(normalized)
    }

    pub async fn rename_entry(
        &self,
        root: &Path,
        from_relative_path: &str,
        to_relative_path: &str,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let from = self.entry_place(root, from_relative_path).await?;
        let (to, normalized) = self.mutation_place(root, to_relative_path).await?;
        // Both paths, always in the same order, so two renames never wait on each other.
        let _path_locks = self.lock_paths(&from.target, &to.target).await?;
        self.containment_checked(&to.target).await?;
        let target = from.target.clone();
        blocking(&target, move || {
            if to.kind()? != Kind::Missing {
                return Err(WorkspaceError::AlreadyExists {
                    path: to.target.clone(),
                });
            }
            let from_dir = from.folder(false)?;
            let to_dir = to.folder(true)?;
            // No-replace: a destination created after the check above is never overwritten.
            match from_dir.rename(&from.name, &to_dir, &to.name, Replace::Never) {
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Err(WorkspaceError::AlreadyExists {
                        path: to.target.clone(),
                    })
                }
                other => other.map_err(|error| from.fault("rename", error)),
            }
        })
        .await?;
        Ok(normalized)
    }

    /// Deletes the entry permanently: a folder with everything in it, or a file or symlink.
    pub async fn delete_entry(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (_, normalized) = resolve_relative(root, relative_path)?;
        let place = self.entry_place(root, relative_path).await?;
        let _path_lock = self.lock_path(&place.target).await?;
        self.containment_checked(&place.target).await?;
        let target = place.target.clone();
        blocking(&target, move || {
            let dir = place.folder(false)?;
            match dir
                .kind(&place.name)
                .map_err(|error| place.fault("stat", error))?
            {
                Kind::Missing => Err(WorkspaceError::NotFound {
                    path: place.target.clone(),
                }),
                Kind::Directory => match dir.remove_dir_all(&place.name) {
                    Ok(()) => Ok(()),
                    Err(Removal::Untouched(error)) => Err(place.fault("remove", error)),
                    Err(Removal::Partial { error, left_at }) => {
                        Err(WorkspaceError::PartiallyRemoved {
                            path: place.target.clone(),
                            left_at: place.folder.join(left_at),
                            reason: error.to_string(),
                        })
                    }
                },
                _ => dir
                    .remove_file(&place.name)
                    .map_err(|error| place.fault("remove", error)),
            }
        })
        .await?;
        Ok(normalized)
    }

    /// Moves the entry to the system trash (`projects.deleteEntry` with `toTrash`, #139 X5).
    /// A trash that cannot take it leaves it in place and answers `trash_unavailable`; this
    /// never falls back to deleting it.
    pub async fn trash_entry(
        &self,
        root: &Path,
        relative_path: &str,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (_, normalized) = resolve_relative(root, relative_path)?;
        let place = self.entry_place(root, relative_path).await?;
        let _path_lock = self.lock_path(&place.target).await?;
        let Some(trash) = self.trash.clone() else {
            return Err(WorkspaceError::TrashUnavailable { path: place.target });
        };
        self.containment_checked(&place.target).await?;
        self.move_to_trash(&*trash, place, cancellation).await?;
        Ok(normalized)
    }

    /// The entry moves into a private holder by handle (Source Control's discard staging, the
    /// Git directory's `bibcode-discard`, else a folder under the server's state directory)
    /// and only that staged path goes to the trash, so no workspace path another process could
    /// swap is ever handed to it. A holder on another file system stages nothing:
    /// `trash_unavailable`.
    #[cfg(unix)]
    async fn move_to_trash(
        &self,
        trash: &dyn crate::git::FileTrash,
        place: Place,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<(), WorkspaceError> {
        let target = place.target.clone();
        let unavailable = || WorkspaceError::TrashUnavailable {
            path: target.clone(),
        };
        let root = place.root.path().to_path_buf();
        let Some(holder_parent) = self.trash_holder(&root) else {
            return Err(unavailable());
        };
        let relative = place
            .folder
            .join(&place.name)
            .strip_prefix(&root)
            .ok()
            .and_then(|relative| relative.to_str())
            .map(str::to_owned)
            .ok_or_else(unavailable)?;
        match crate::git::trash_by_staging(trash, &root, &holder_parent, &relative, cancellation)
            .await
        {
            crate::git::Moved::Trashed => Ok(()),
            crate::git::Moved::NotTaken | crate::git::Moved::Kept => Err(unavailable()),
            // Not where it was any more: say where it is.
            crate::git::Moved::Stranded(staged) => Err(WorkspaceError::KeptInStaging {
                path: target.clone(),
                staged_at: staged
                    .strip_prefix(&holder_parent)
                    .map(super::paths::to_posix)
                    .unwrap_or_default(),
                in_git_dir: self
                    .trash_state
                    .as_ref()
                    .is_none_or(|state| !holder_parent.starts_with(state)),
                staged,
            }),
        }
    }

    /// Without `*at` calls the trash takes the folder's path after a re-check (the outside
    /// agents' tools that change files are refused on these platforms).
    #[cfg(not(unix))]
    async fn move_to_trash(
        &self,
        trash: &dyn crate::git::FileTrash,
        place: Place,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<(), WorkspaceError> {
        let target = place.target.clone();
        let checked = blocking(&target, move || {
            place
                .folder(false)?
                .checked_path(&place.name)
                .map_err(|error| place.fault("open", error))
        })
        .await?;
        trash
            .trash(checked, cancellation)
            .await
            .map_err(|_| WorkspaceError::TrashUnavailable { path: target })
    }

    /// The folder that holds `bibcode-discard` for a workspace: its Git directory (a `.git`
    /// folder, or the folder a `.git` file names), else a folder of its own, named by a hash
    /// of the root, under the server's state directory.
    #[cfg(unix)]
    fn trash_holder(&self, root: &Path) -> Option<PathBuf> {
        let dot_git = root.join(".git");
        match std::fs::symlink_metadata(&dot_git) {
            Ok(metadata) if metadata.is_dir() => return Some(dot_git),
            Ok(metadata) if metadata.is_file() => {
                let text = std::fs::read_to_string(&dot_git).ok()?;
                let named = text.strip_prefix("gitdir:")?.trim();
                return std::fs::canonicalize(root.join(named)).ok();
            }
            _ => {}
        }
        let state = self.trash_state.as_ref()?;
        let mut name = sha256_hex(root.as_os_str().as_encoded_bytes());
        name.truncate(24);
        let folder = state.join("workspace-trash").join(name);
        std::fs::create_dir_all(&folder).ok()?;
        Some(folder)
    }

    /// The locks of two paths (a rename's source and target), taken in the order of their
    /// keys so two renames of the same pair never wait on each other; one lock when both
    /// paths are one file.
    async fn lock_paths(
        &self,
        first: &Path,
        second: &Path,
    ) -> Result<(PathGuard, Option<PathGuard>), WorkspaceError> {
        let key = |path: &Path| path.to_string_lossy().to_lowercase();
        if key(first) == key(second) {
            return Ok((self.lock_path(first).await?, None));
        }
        let (low, high) = if key(first) < key(second) {
            (first, second)
        } else {
            (second, first)
        };
        let low = self.lock_path(low).await?;
        let high = self.lock_path(high).await?;
        Ok((low, Some(high)))
    }

    /// The path's lock (see [`PathLocks`]), or `path_busy`.
    async fn lock_path(&self, path: &Path) -> Result<PathGuard, WorkspaceError> {
        self.path_locks
            .lock(path)
            .await
            .map_err(|PathBusy| WorkspaceError::PathBusy {
                path: path.to_path_buf(),
            })
    }

    pub async fn duplicate_entry(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (source, normalized_source) = resolve_relative(root, relative_path)?;
        if !tokio::fs::try_exists(&source)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &source, error))?
        {
            return Err(WorkspaceError::NotFound { path: source });
        }
        let (source, _) = self.existing_place(root, relative_path).await?;
        let source_path = Path::new(&normalized_source);
        let extension = source_path.extension().map(OsString::from);
        let stem = source_path
            .file_stem()
            .map_or_else(OsString::new, OsString::from);
        let parent = source_path.parent().unwrap_or(Path::new(""));
        for attempt in 1..=DUPLICATE_LIMIT {
            let suffix = if attempt == 1 {
                "copy".to_owned()
            } else {
                format!("copy {attempt}")
            };
            let mut name = stem.clone();
            name.push(format!(" {suffix}"));
            if let Some(extension) = &extension {
                name.push(".");
                name.push(extension);
            }
            let relative = parent.join(name);
            let (candidate, normalized) = self
                .mutation_place(root, &relative.to_string_lossy())
                .await?;
            let source = source.clone();
            let target = candidate.target.clone();
            let copied = blocking(&target, move || {
                let mut reader = source.open_regular()?;
                let mut writer = match candidate
                    .folder(false)?
                    .open_file(&candidate.name, Open::CreateNew)
                {
                    Ok(writer) => writer,
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        return Ok(false);
                    }
                    Err(error) => return Err(candidate.fault("copy-file", error)),
                };
                std::io::copy(&mut reader, &mut writer)
                    .map_err(|error| source.fault("copy-file", error))?;
                Ok(true)
            })
            .await?;
            if copied {
                return Ok(normalized);
            }
        }
        Err(WorkspaceError::AlreadyExists {
            path: source.target,
        })
    }

    pub async fn browse(
        &self,
        partial_path: &str,
        cwd: Option<&Path>,
        directory_mode: bool,
    ) -> Result<BrowseResult, WorkspaceError> {
        let _permit = self.permit().await?;
        if directory_mode {
            entries::browse_directory(partial_path, cwd).await
        } else {
            entries::browse(partial_path, cwd).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Pauses every guarded write after its precondition held, until the test releases it.
    struct HoldAfterPreconditionCheck {
        entered: tokio::sync::mpsc::UnboundedSender<()>,
        release: Arc<Semaphore>,
    }

    impl WorkspaceWriteHook for HoldAfterPreconditionCheck {
        fn after_write<'a>(&'a self, _target: &'a Path) -> WorkspaceWriteHookFuture<'a> {
            Box::pin(async { Ok(()) })
        }

        fn after_precondition_check<'a>(
            &'a self,
            _target: &'a Path,
        ) -> WorkspaceWriteHookFuture<'a> {
            Box::pin(async move {
                let _ = self.entered.send(());
                self.release
                    .acquire()
                    .await
                    .expect("release gate open")
                    .forget();
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn guarded_write_holds_the_path_lock_from_its_check_to_its_write() {
        let root = TempDir::new().unwrap();
        std::fs::write(root.path().join("shared.txt"), "base\n").unwrap();
        let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(Semaphore::new(0));
        let service = WorkspaceService::default().with_write_hook_for_test(Arc::new(
            HoldAfterPreconditionCheck {
                entered,
                release: release.clone(),
            },
        ));
        let base = WritePrecondition::Version {
            version: sha256_hex(b"base\n"),
        };
        let guarded_write = |contents: &'static str| {
            let service = service.clone();
            let root = root.path().to_path_buf();
            let base = base.clone();
            tokio::spawn(async move {
                service
                    .write_file_if_unchanged(&root, "shared.txt", contents, &base)
                    .await
                    .map(|outcome| outcome.version)
            })
        };

        let first = guarded_write("first\n");
        entered_rx
            .recv()
            .await
            .expect("first write passed its check");
        let second = guarded_write("second\n");
        let plain = {
            let service = service.clone();
            let root = root.path().to_path_buf();
            tokio::spawn(async move { service.write_file(&root, "shared.txt", "plain\n").await })
        };
        // Without the lock the second write passes the same check while the first is paused.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), entered_rx.recv())
                .await
                .is_err(),
            "a second guarded write passed its check while the first held the path"
        );
        assert!(
            !plain.is_finished(),
            "a plain write landed between check and write"
        );

        release.add_permits(1);
        assert_eq!(first.await.unwrap().unwrap(), sha256_hex(b"first\n"));
        let second = second.await.unwrap();
        plain.await.unwrap().unwrap();
        // Whichever of the two waiters ran next, the second guarded write never saw "base".
        assert!(matches!(
            second,
            Err(WorkspaceError::FileChangedOnDisk { .. })
        ));
    }

    #[tokio::test]
    async fn guarded_writes_to_spellings_of_one_missing_file_share_its_lock() {
        // Only an existing path canonicalizes to its on-disk spelling; a missing one keeps the
        // caller's. On a case-insensitive volume both names below are one file, so the second
        // write must not pass its absence check while the first is between check and write.
        let root = TempDir::new().unwrap();
        let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(Semaphore::new(0));
        let service = WorkspaceService::default().with_write_hook_for_test(Arc::new(
            HoldAfterPreconditionCheck {
                entered,
                release: release.clone(),
            },
        ));
        let recreate = |relative_path: &'static str| {
            let service = service.clone();
            let root = root.path().to_path_buf();
            tokio::spawn(async move {
                service
                    .write_file_if_unchanged(
                        &root,
                        relative_path,
                        relative_path,
                        &WritePrecondition::Missing,
                    )
                    .await
                    .map(|outcome| outcome.version)
            })
        };

        let first = recreate("docs/Notes.txt");
        entered_rx
            .recv()
            .await
            .expect("first write passed its check");
        let second = recreate("docs/notes.txt");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), entered_rx.recv())
                .await
                .is_err(),
            "a second spelling of the missing file passed its check while the first held it"
        );

        release.add_permits(2);
        first.await.unwrap().unwrap();
        let second = second.await.unwrap();
        if root.path().join("docs/notes.txt").exists()
            && std::fs::read(root.path().join("docs/notes.txt")).unwrap() == b"docs/Notes.txt"
        {
            // Case-insensitive: the second write found the first one's file and was refused.
            assert!(matches!(
                second,
                Err(WorkspaceError::FileChangedOnDisk { .. })
            ));
        } else {
            // Case-sensitive: two distinct files, both created.
            second.unwrap();
        }
    }

    #[test]
    fn write_classification_controls_include_logical_and_effective_paths_case_insensitively() {
        assert!(write_may_change_index_classification(
            "nested/.GITIGNORE",
            Path::new("workspace/nested/.gitignore")
        ));
        assert!(write_may_change_index_classification(
            "ignore-control-alias",
            Path::new("workspace/nested/.GiTiGnOrE")
        ));
        assert!(write_may_change_index_classification(
            "git-control-alias/info/exclude",
            Path::new("workspace/.GiT/INFO/EXCLUDE")
        ));
        assert!(!write_may_change_index_classification(
            "nested/ordinary.txt",
            Path::new("workspace/nested/ordinary.txt")
        ));
    }

    #[tokio::test]
    async fn service_covers_file_and_directory_lifecycle_edges() {
        let root = TempDir::new().unwrap();
        let service = WorkspaceService::new(0);

        assert_eq!(
            service
                .write_file(root.path(), "nested/file.txt", "hello")
                .await
                .unwrap()
                .relative_path,
            "nested/file.txt"
        );
        let read = service
            .read_file(root.path(), "nested/file.txt")
            .await
            .unwrap();
        assert_eq!(read.contents, "hello");
        assert_eq!(read.byte_length, 5);
        assert!(!read.truncated);

        assert_eq!(
            service
                .create_entry(root.path(), "empty", EntryKind::Directory)
                .await
                .unwrap(),
            "empty"
        );
        assert_eq!(
            service
                .create_entry(root.path(), "new/file.rs", EntryKind::File)
                .await
                .unwrap(),
            "new/file.rs"
        );
        assert!(matches!(
            service
                .create_entry(root.path(), "new/file.rs", EntryKind::File)
                .await,
            Err(WorkspaceError::AlreadyExists { .. })
        ));
        assert!(matches!(
            service.read_file(root.path(), "empty").await,
            Err(WorkspaceError::NotFile { .. })
        ));

        assert_eq!(
            service
                .rename_entry(root.path(), "new/file.rs", "renamed/file.rs")
                .await
                .unwrap(),
            "renamed/file.rs"
        );
        assert!(matches!(
            service.rename_entry(root.path(), "missing", "unused").await,
            Err(WorkspaceError::NotFound { .. })
        ));
        service
            .write_file(root.path(), "occupied", "occupied")
            .await
            .unwrap();
        assert!(matches!(
            service
                .rename_entry(root.path(), "renamed/file.rs", "occupied")
                .await,
            Err(WorkspaceError::AlreadyExists { .. })
        ));

        assert_eq!(
            service
                .duplicate_entry(root.path(), "renamed/file.rs")
                .await
                .unwrap(),
            "renamed/file copy.rs"
        );
        assert_eq!(
            service
                .duplicate_entry(root.path(), "renamed/file.rs")
                .await
                .unwrap(),
            "renamed/file copy 2.rs"
        );
        assert!(matches!(
            service.duplicate_entry(root.path(), "empty").await,
            Err(WorkspaceError::NotFile { .. })
        ));
        assert!(matches!(
            service.duplicate_entry(root.path(), "missing").await,
            Err(WorkspaceError::NotFound { .. })
        ));

        std::fs::write(root.path().join("binary.dat"), b"binary\0payload").unwrap();
        assert!(matches!(
            service.read_file(root.path(), "binary.dat").await,
            Err(WorkspaceError::BinaryFile { .. })
        ));
        let browsed = service
            .browse("./r", Some(root.path()), false)
            .await
            .unwrap();
        assert!(!browsed.entries.is_empty());

        assert_eq!(
            service
                .delete_entry(root.path(), "renamed/file copy.rs")
                .await
                .unwrap(),
            "renamed/file copy.rs"
        );
        assert_eq!(
            service.delete_entry(root.path(), "empty").await.unwrap(),
            "empty"
        );
        assert!(matches!(
            service.delete_entry(root.path(), "missing").await,
            Err(WorkspaceError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn service_maps_concurrency_and_filesystem_failures_to_workspace_errors() {
        let root = TempDir::new().unwrap();
        let service = WorkspaceService::default();
        let blocker = root.path().join("blocker");
        std::fs::write(&blocker, "not a directory").unwrap();

        for result in [
            service
                .write_file(root.path(), "blocker/file.txt", "contents")
                .await
                .map(|outcome| outcome.relative_path),
            service
                .create_entry(root.path(), "blocker/directory", EntryKind::Directory)
                .await,
            service
                .create_entry(root.path(), "blocker/file.txt", EntryKind::File)
                .await,
            service
                .rename_entry(root.path(), "blocker", "blocker/renamed")
                .await,
        ] {
            assert!(matches!(result, Err(WorkspaceError::Operation { .. })));
        }

        std::fs::create_dir(root.path().join("write-target")).unwrap();
        assert!(matches!(
            service
                .write_file(root.path(), "write-target", "contents")
                .await,
            Err(WorkspaceError::Operation { .. })
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            std::fs::write(root.path().join("source.txt"), "copy source").unwrap();
            let mut source_permissions = std::fs::metadata(root.path().join("source.txt"))
                .unwrap()
                .permissions();
            source_permissions.set_mode(0o000);
            std::fs::set_permissions(root.path().join("source.txt"), source_permissions).unwrap();
            let copy_result = service.duplicate_entry(root.path(), "source.txt").await;
            let mut source_permissions = std::fs::metadata(root.path().join("source.txt"))
                .unwrap()
                .permissions();
            source_permissions.set_mode(0o600);
            std::fs::set_permissions(root.path().join("source.txt"), source_permissions).unwrap();
            assert!(matches!(copy_result, Err(WorkspaceError::Operation { .. })));

            let unreadable = root.path().join("unreadable.txt");
            std::fs::write(&unreadable, "private").unwrap();
            let mut unreadable_permissions = std::fs::metadata(&unreadable).unwrap().permissions();
            unreadable_permissions.set_mode(0o000);
            std::fs::set_permissions(&unreadable, unreadable_permissions).unwrap();
            let read_result = service.read_file(root.path(), "unreadable.txt").await;
            let mut unreadable_permissions = std::fs::metadata(&unreadable).unwrap().permissions();
            unreadable_permissions.set_mode(0o600);
            std::fs::set_permissions(&unreadable, unreadable_permissions).unwrap();
            assert!(matches!(read_result, Err(WorkspaceError::Operation { .. })));

            let locked = root.path().join("locked");
            std::fs::create_dir(&locked).unwrap();
            let mut locked_permissions = std::fs::metadata(&locked).unwrap().permissions();
            locked_permissions.set_mode(0o500);
            std::fs::set_permissions(&locked, locked_permissions).unwrap();
            for result in [
                service
                    .create_entry(root.path(), "locked/directory", EntryKind::Directory)
                    .await,
                service
                    .create_entry(root.path(), "locked/file.txt", EntryKind::File)
                    .await,
            ] {
                assert!(matches!(result, Err(WorkspaceError::Operation { .. })));
            }
            let mut locked_permissions = std::fs::metadata(&locked).unwrap().permissions();
            locked_permissions.set_mode(0o700);
            std::fs::set_permissions(&locked, locked_permissions).unwrap();

            for entry in ["rename-source", "delete-file"] {
                std::fs::write(root.path().join(entry), entry).unwrap();
            }
            std::fs::create_dir(root.path().join("delete-directory")).unwrap();
            let mut root_permissions = std::fs::metadata(root.path()).unwrap().permissions();
            root_permissions.set_mode(0o500);
            std::fs::set_permissions(root.path(), root_permissions).unwrap();
            for result in [
                service
                    .rename_entry(root.path(), "rename-source", "rename-target")
                    .await,
                service.delete_entry(root.path(), "delete-file").await,
                service.delete_entry(root.path(), "delete-directory").await,
            ] {
                assert!(matches!(result, Err(WorkspaceError::Operation { .. })));
            }
            let mut root_permissions = std::fs::metadata(root.path()).unwrap().permissions();
            root_permissions.set_mode(0o700);
            std::fs::set_permissions(root.path(), root_permissions).unwrap();
        }

        let closed = WorkspaceService::default();
        closed.permits.close();
        assert!(matches!(
            closed.browse(".", Some(root.path()), false).await,
            Err(WorkspaceError::Cancelled)
        ));
    }

    /// Swaps `parent` for a symlink to `outside` the first time an operation passes its
    /// containment check: the check-then-use race a handle-bound operation must survive.
    #[cfg(unix)]
    struct SwapAfterContainmentCheck {
        parent: PathBuf,
        outside: PathBuf,
        swapped: std::sync::atomic::AtomicBool,
    }

    #[cfg(unix)]
    impl SwapAfterContainmentCheck {
        fn service(parent: PathBuf, outside: PathBuf) -> WorkspaceService {
            WorkspaceService::default().with_write_hook_for_test(Arc::new(Self {
                parent,
                outside,
                swapped: std::sync::atomic::AtomicBool::new(false),
            }))
        }
    }

    #[cfg(unix)]
    impl WorkspaceWriteHook for SwapAfterContainmentCheck {
        fn after_write<'a>(&'a self, _target: &'a Path) -> WorkspaceWriteHookFuture<'a> {
            Box::pin(async { Ok(()) })
        }

        fn after_containment_check<'a>(
            &'a self,
            _target: &'a Path,
        ) -> WorkspaceWriteHookFuture<'a> {
            Box::pin(async move {
                if !self.swapped.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    std::fs::rename(&self.parent, self.parent.with_extension("moved")).unwrap();
                    std::os::unix::fs::symlink(&self.outside, &self.parent).unwrap();
                }
                Ok(())
            })
        }
    }

    /// Writes `contents` to the target the moment a guarded write's precondition held: a
    /// person saving the same file in that window.
    struct WriteAfterPreconditionCheck {
        contents: &'static str,
    }

    impl WorkspaceWriteHook for WriteAfterPreconditionCheck {
        fn after_write<'a>(&'a self, _target: &'a Path) -> WorkspaceWriteHookFuture<'a> {
            Box::pin(async { Ok(()) })
        }

        fn after_precondition_check<'a>(
            &'a self,
            target: &'a Path,
        ) -> WorkspaceWriteHookFuture<'a> {
            Box::pin(async move {
                std::fs::write(target, self.contents).unwrap();
                Ok(())
            })
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_guarded_save_writes_the_same_file_in_place_and_leaves_no_sibling() {
        use std::os::unix::fs::MetadataExt as _;
        let root = TempDir::new().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "base").unwrap();
        std::fs::hard_link(&file, root.path().join("linked.txt")).unwrap();
        let inode = std::fs::metadata(&file).unwrap().ino();
        WorkspaceService::default()
            .write_file_if_unchanged(
                root.path(),
                "notes.txt",
                "saved",
                &WritePrecondition::Version {
                    version: sha256_hex(b"base"),
                },
            )
            .await
            .map(|_| ())
            .unwrap();
        assert_eq!(std::fs::metadata(&file).unwrap().ino(), inode);
        assert_eq!(
            std::fs::read_to_string(root.path().join("linked.txt")).unwrap(),
            "saved"
        );
        let mut names: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["linked.txt", "notes.txt"]);
    }

    /// Fails every in-place write right after it truncated the file.
    struct FailAfterTruncate;

    impl WorkspaceWriteHook for FailAfterTruncate {
        fn after_write<'a>(&'a self, _target: &'a Path) -> WorkspaceWriteHookFuture<'a> {
            Box::pin(async { Ok(()) })
        }

        fn fail_after_truncate(&self) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn a_write_that_fails_after_emptying_the_file_puts_the_old_content_back() {
        let root = TempDir::new().unwrap();
        std::fs::write(root.path().join("notes.txt"), "the old content").unwrap();
        let failed = WorkspaceService::default()
            .with_write_hook_for_test(Arc::new(FailAfterTruncate))
            .write_file_if_unchanged(
                root.path(),
                "notes.txt",
                "new",
                &WritePrecondition::Version {
                    version: sha256_hex(b"the old content"),
                },
            )
            .await
            .map(|_| ());
        assert!(
            matches!(
                failed,
                Err(WorkspaceError::WriteFailed { restored: true, .. })
            ),
            "{failed:?}"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("notes.txt")).unwrap(),
            "the old content"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn only_a_single_link_write_refuses_a_hard_linked_file() {
        let root = TempDir::new().unwrap();
        std::fs::write(root.path().join("a.txt"), "base").unwrap();
        std::fs::hard_link(root.path().join("a.txt"), root.path().join("b.txt")).unwrap();
        let base = WritePrecondition::Version {
            version: sha256_hex(b"base"),
        };
        let service = WorkspaceService::default();
        let refused = service
            .write_file_if_unchanged_with(root.path(), "a.txt", "agent", &base, true)
            .await
            .map(|_| ());
        assert!(
            matches!(refused, Err(WorkspaceError::HardLinked { .. })),
            "{refused:?}"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("b.txt")).unwrap(),
            "base"
        );
        // A person's save of their own hard-linked file goes through.
        service
            .write_file_if_unchanged(root.path(), "a.txt", "person", &base)
            .await
            .map(|_| ())
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("b.txt")).unwrap(),
            "person"
        );
    }

    #[tokio::test]
    async fn a_delete_waits_for_a_save_of_the_same_file() {
        let root = TempDir::new().unwrap();
        std::fs::write(root.path().join("shared.txt"), "base").unwrap();
        let (entered, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(Semaphore::new(0));
        let service = WorkspaceService::default().with_write_hook_for_test(Arc::new(
            HoldAfterPreconditionCheck {
                entered,
                release: release.clone(),
            },
        ));
        let save = {
            let (service, root) = (service.clone(), root.path().to_path_buf());
            tokio::spawn(async move {
                service
                    .write_file_if_unchanged(
                        &root,
                        "shared.txt",
                        "saved",
                        &WritePrecondition::Version {
                            version: sha256_hex(b"base"),
                        },
                    )
                    .await
                    .map(|_| ())
            })
        };
        entered_rx.recv().await.expect("the save passed its check");
        let delete = {
            let (service, root) = (service.clone(), root.path().to_path_buf());
            tokio::spawn(async move { service.delete_entry(&root, "shared.txt").await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(!delete.is_finished(), "the delete ran during the save");
        assert!(root.path().join("shared.txt").exists());
        release.add_permits(1);
        save.await.unwrap().unwrap();
        delete.await.unwrap().unwrap();
        assert!(!root.path().join("shared.txt").exists());
    }

    /// Moves a trashed entry into a folder of its own and counts the calls.
    #[cfg(unix)]
    struct FolderTrash {
        folder: PathBuf,
        calls: std::sync::atomic::AtomicUsize,
    }

    #[cfg(unix)]
    impl crate::git::FileTrash for FolderTrash {
        fn trash<'a>(
            &'a self,
            path: PathBuf,
            _: &'a tokio_util::sync::CancellationToken,
        ) -> crate::git::FileTrashFuture<'a> {
            Box::pin(async move {
                let index = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::fs::rename(&path, self.folder.join(index.to_string()))
                    .await
                    .map_err(|_| crate::git::TrashUnavailable)
            })
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_trash_takes_a_staged_copy_never_a_swapped_workspace_path() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let state = TempDir::new().unwrap();
        let trashed = TempDir::new().unwrap();
        let trash = Arc::new(FolderTrash {
            folder: trashed.path().to_path_buf(),
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let parent = root.path().join("sub");
        std::fs::create_dir(&parent).unwrap();
        std::fs::write(parent.join("victim.txt"), "inside").unwrap();
        std::fs::write(outside.path().join("victim.txt"), "outside").unwrap();

        // A plain trash goes through the private holder.
        std::fs::write(root.path().join("plain.txt"), "plain").unwrap();
        WorkspaceService::default()
            .with_trash(trash.clone(), state.path().to_path_buf())
            .trash_entry(
                root.path(),
                "plain.txt",
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!root.path().join("plain.txt").exists());
        assert_eq!(
            std::fs::read_to_string(trashed.path().join("0")).unwrap(),
            "plain"
        );

        // The folder becomes an outside link after the check: nothing is trashed.
        let swapping = SwapAfterContainmentCheck::service(parent.clone(), outside.path().into())
            .with_trash(trash.clone(), state.path().to_path_buf());
        let refused = swapping
            .trash_entry(
                root.path(),
                "sub/victim.txt",
                &tokio_util::sync::CancellationToken::new(),
            )
            .await;
        assert!(refused.is_err(), "{refused:?}");
        assert_eq!(trash.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read_to_string(outside.path().join("victim.txt")).unwrap(),
            "outside"
        );
        assert_eq!(
            std::fs::read_to_string(parent.with_extension("moved").join("victim.txt")).unwrap(),
            "inside"
        );
    }

    /// Refuses every entry, after something else has taken the entry's original name.
    #[cfg(unix)]
    struct RefusingTrashAfterTheNameIsTaken {
        original: PathBuf,
    }

    #[cfg(unix)]
    impl crate::git::FileTrash for RefusingTrashAfterTheNameIsTaken {
        fn trash<'a>(
            &'a self,
            _: PathBuf,
            _: &'a tokio_util::sync::CancellationToken,
        ) -> crate::git::FileTrashFuture<'a> {
            Box::pin(async move {
                std::fs::write(&self.original, "new").unwrap();
                Err(crate::git::TrashUnavailable)
            })
        }
    }

    /// A trash that refuses an entry whose name was taken again meanwhile cannot put it back:
    /// the entry stays in the staging folder, and the error says where, never that it was left
    /// in place (#139 X5 round 5).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_trash_that_cannot_put_the_entry_back_says_where_it_is() {
        let root = TempDir::new().unwrap();
        let state = TempDir::new().unwrap();
        let canonical = std::fs::canonicalize(root.path()).unwrap();
        std::fs::write(canonical.join("victim.txt"), "old").unwrap();
        let service = WorkspaceService::default().with_trash(
            Arc::new(RefusingTrashAfterTheNameIsTaken {
                original: canonical.join("victim.txt"),
            }),
            state.path().to_path_buf(),
        );

        let refused = service
            .trash_entry(
                root.path(),
                "victim.txt",
                &tokio_util::sync::CancellationToken::new(),
            )
            .await;

        let Err(error) = refused else {
            panic!("expected kept_in_staging, got {refused:?}");
        };
        let WorkspaceError::KeptInStaging {
            staged,
            staged_at,
            in_git_dir,
            ..
        } = &error
        else {
            panic!("expected kept_in_staging, got {error:?}");
        };
        let in_git_dir = *in_git_dir;
        assert_eq!(std::fs::read_to_string(staged).unwrap(), "old");
        assert!(
            !in_git_dir,
            "a folder that is no repository stages in the state directory"
        );
        assert!(
            staged_at.starts_with("bibcode-discard/") && staged_at.ends_with("/victim.txt"),
            "{staged_at}"
        );
        assert!(staged.ends_with(staged_at), "{staged:?} {staged_at}");
        assert_eq!(
            std::fs::read_to_string(canonical.join("victim.txt")).unwrap(),
            "new",
            "the file that took the name is untouched"
        );
        assert!(
            error.to_string().contains(&staged.display().to_string()),
            "{error}"
        );
        let wire = error.to_project_wire("ProjectDeleteEntryError", "/w", "victim.txt");
        assert_eq!(wire["failure"], "kept_in_staging");
        assert_eq!(wire["stagedAt"], staged_at.as_str());
        assert_eq!(wire["stagedIn"], "state-dir");
    }

    #[tokio::test]
    async fn a_write_is_refused_while_an_upload_holds_its_path() {
        let root = TempDir::new().unwrap();
        let service = WorkspaceService::default();
        let target = std::fs::canonicalize(root.path()).unwrap().join("up.txt");
        let upload = service.path_locks().lock_upload(&target).await.unwrap();
        let refused = service
            .write_file(root.path(), "up.txt", "panel")
            .await
            .map(|_| ());
        assert!(
            matches!(refused, Err(WorkspaceError::PathBusy { .. })),
            "{refused:?}"
        );
        let refused = service
            .write_file_if_unchanged(root.path(), "up.txt", "agent", &WritePrecondition::Missing)
            .await
            .map(|_| ());
        assert!(
            matches!(refused, Err(WorkspaceError::PathBusy { .. })),
            "{refused:?}"
        );
        assert!(!target.exists());
        drop(upload);
        service
            .write_file(root.path(), "up.txt", "panel")
            .await
            .map(|_| ())
            .unwrap();
    }

    #[tokio::test]
    async fn a_guarded_write_never_replaces_a_save_that_lands_after_its_check() {
        let root = TempDir::new().unwrap();
        let service = || {
            WorkspaceService::default().with_write_hook_for_test(Arc::new(
                WriteAfterPreconditionCheck { contents: "person" },
            ))
        };
        // createOnly: the file appeared after the absence check.
        let created = service()
            .write_file_if_unchanged(root.path(), "new.txt", "agent", &WritePrecondition::Missing)
            .await;
        assert!(
            matches!(created, Err(WorkspaceError::FileChangedOnDisk { .. })),
            "{:?}",
            created.map(|_| ())
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("new.txt")).unwrap(),
            "person"
        );
        // A version-checked write: the file changed in place after the version matched.
        std::fs::write(root.path().join("base.txt"), "base").unwrap();
        let replaced = service()
            .write_file_if_unchanged(
                root.path(),
                "base.txt",
                "agent",
                &WritePrecondition::Version {
                    version: sha256_hex(b"base"),
                },
            )
            .await;
        assert!(
            matches!(replaced, Err(WorkspaceError::FileChangedOnDisk { .. })),
            "{:?}",
            replaced.map(|_| ())
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("base.txt")).unwrap(),
            "person"
        );
    }

    #[cfg(unix)]
    fn refused<T: std::fmt::Debug>(operation: &str, result: Result<T, WorkspaceError>) {
        assert!(
            matches!(result, Err(WorkspaceError::ResolvedPathOutsideRoot { .. })),
            "{operation}: {result:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_folder_swapped_for_an_outside_symlink_after_the_check_is_never_followed() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let parent = root.path().join("sub");
        std::fs::create_dir(&parent).unwrap();
        std::fs::create_dir(parent.join("victim-dir")).unwrap();
        std::fs::create_dir(outside.path().join("victim-dir")).unwrap();
        for name in ["secret.txt", "victim.txt", "a.txt"] {
            std::fs::write(parent.join(name), "inside").unwrap();
            std::fs::write(outside.path().join(name), "outside").unwrap();
        }
        std::fs::write(root.path().join("top.txt"), "top").unwrap();
        let swap = || SwapAfterContainmentCheck::service(parent.clone(), outside.path().into());
        let restore = || {
            std::fs::remove_file(&parent).unwrap();
            std::fs::rename(parent.with_extension("moved"), &parent).unwrap();
        };
        let root = root.path();

        refused("read", swap().read_file(root, "sub/secret.txt").await);
        restore();
        refused("version", swap().file_version(root, "sub/secret.txt").await);
        restore();
        refused(
            "write",
            swap()
                .write_file(root, "sub/a.txt", "agent")
                .await
                .map(|_| ()),
        );
        restore();
        let missing = WritePrecondition::Missing;
        refused(
            "guarded write",
            swap()
                .write_file_if_unchanged(root, "sub/new.txt", "agent", &missing)
                .await
                .map(|_| ()),
        );
        restore();
        refused(
            "create folder",
            swap()
                .create_entry(root, "sub/created", EntryKind::Directory)
                .await,
        );
        restore();
        refused(
            "create file",
            swap()
                .create_entry(root, "sub/created.txt", EntryKind::File)
                .await,
        );
        restore();
        refused(
            "rename from",
            swap().rename_entry(root, "sub/a.txt", "moved.txt").await,
        );
        restore();
        refused(
            "rename into",
            swap().rename_entry(root, "top.txt", "sub/top.txt").await,
        );
        restore();
        refused(
            "delete file",
            swap().delete_entry(root, "sub/victim.txt").await,
        );
        restore();
        refused(
            "delete folder",
            swap().delete_entry(root, "sub/victim-dir").await,
        );
        restore();
        refused("duplicate", swap().duplicate_entry(root, "sub/a.txt").await);
        restore();

        // Nothing outside was read, written, created, moved into or removed.
        let mut names: Vec<_> = std::fs::read_dir(outside.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["a.txt", "secret.txt", "victim-dir", "victim.txt"]);
        for name in ["a.txt", "secret.txt", "victim.txt"] {
            assert_eq!(
                std::fs::read_to_string(outside.path().join(name)).unwrap(),
                "outside"
            );
        }
        assert!(root.join("top.txt").exists());
    }
}
