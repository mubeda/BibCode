use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, Weak};
#[cfg(test)]
use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

use crate::crypto::{lowercase_hex, sha256_hex};

use super::entries::{self, BrowseResult};
use super::paths::{canonical_existing_within, resolve_relative, safe_mutation_target};
use super::{EntryKind, WorkspaceError};

const READ_LIMIT_BYTES: usize = 1024 * 1024;
const VERSION_SCAN_CHUNK_BYTES: usize = 64 * 1024;
const DUPLICATE_LIMIT: usize = 1000;
const DEFAULT_MAX_CONCURRENT_OPERATIONS: usize = 32;

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
    },
}

/// Hashes a file's whole content in chunks, without holding it in memory.
///
/// `binary` matches `read_file`'s test: a NUL byte within the first read-limit bytes.
fn scan_file_blocking(path: &Path) -> Result<ScannedFile, WorkspaceError> {
    // Stat before opening, as `read_file` does: opening a named pipe with no writer for reading
    // blocks, so a pipe put in place of the file would stall every check and guarded save.
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => {
            return Err(WorkspaceError::NotFile {
                path: path.to_path_buf(),
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ScannedFile::Missing);
        }
        Err(error) => return Err(WorkspaceError::operation("stat", path, error)),
    }
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ScannedFile::Missing);
        }
        Err(error) => return Err(WorkspaceError::operation("open", path, error)),
    };
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; VERSION_SCAN_CHUNK_BYTES];
    let mut byte_length = 0_u64;
    let mut binary = false;
    loop {
        let read = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(WorkspaceError::operation("read", path, error)),
        };
        let chunk = &buffer[..read];
        if !binary && byte_length < READ_LIMIT_BYTES as u64 {
            let within_limit = (READ_LIMIT_BYTES as u64 - byte_length).min(read as u64) as usize;
            binary = chunk[..within_limit].contains(&0);
        }
        hasher.update(chunk);
        byte_length += read as u64;
    }
    Ok(ScannedFile::Present {
        version: lowercase_hex(&hasher.finalize()),
        byte_length,
        binary,
    })
}

async fn scan_file(path: PathBuf) -> Result<ScannedFile, WorkspaceError> {
    let path_for_error = path.clone();
    tokio::task::spawn_blocking(move || scan_file_blocking(&path))
        .await
        .map_err(|error| {
            WorkspaceError::operation("read", path_for_error, std::io::Error::other(error))
        })?
}

/// One lock per canonical file path, so a guarded write's check and write are atomic against
/// every other write BiBCode makes to that file. Entries are dropped once nobody holds them.
///
/// Keys ignore case. An existing path canonicalizes to its on-disk spelling, but a missing one
/// keeps the caller's, and on a case-insensitive volume (the default on Windows and macOS) two
/// spellings name one file. Folding costs nothing on a case-sensitive volume beyond making
/// writes to names that differ only in case wait for each other.
#[derive(Clone, Default)]
struct PathLocks {
    locks: Arc<StdMutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl PathLocks {
    async fn lock(&self, path: &Path) -> OwnedMutexGuard<()> {
        let key = path.to_string_lossy().to_lowercase();
        let lock = {
            let mut locks = self
                .locks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(&key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(Mutex::new(()));
                    locks.insert(key, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
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
            #[cfg(test)]
            write_hook: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_write_hook_for_test(mut self, hook: Arc<dyn WorkspaceWriteHook>) -> Self {
        self.write_hook = Some(hook);
        self
    }

    async fn permit(&self) -> Result<OwnedSemaphorePermit, WorkspaceError> {
        self.permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| WorkspaceError::Cancelled)
    }

    pub async fn read_file(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<ReadFileResult, WorkspaceError> {
        let _permit = self.permit().await?;
        let (target, normalized_relative) = resolve_relative(root, relative_path)?;
        let (_, canonical_target) = canonical_existing_within(root, &target).await?;
        let path_for_error = canonical_target.clone();
        let (bytes, byte_length) = tokio::task::spawn_blocking(move || {
            let metadata = std::fs::metadata(&canonical_target)
                .map_err(|error| WorkspaceError::operation("stat", &canonical_target, error))?;
            if !metadata.is_file() {
                return Err(WorkspaceError::NotFile {
                    path: canonical_target,
                });
            }
            let byte_length = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
            let mut file = std::fs::File::open(&canonical_target)
                .map_err(|error| WorkspaceError::operation("open", &canonical_target, error))?;
            let mut bytes = Vec::with_capacity(byte_length.min(READ_LIMIT_BYTES));
            file.by_ref()
                .take(READ_LIMIT_BYTES as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| WorkspaceError::operation("read", &canonical_target, error))?;
            Ok::<_, WorkspaceError>((bytes, byte_length))
        })
        .await
        .map_err(|error| {
            WorkspaceError::operation("read", path_for_error, std::io::Error::other(error))
        })??;
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
        let (target, _) = resolve_relative(root, relative_path)?;
        let canonical_target = match canonical_existing_within(root, &target).await {
            Ok((_, canonical_target)) => canonical_target,
            Err(WorkspaceError::Operation { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                return Ok(FileVersion::Missing);
            }
            Err(error) => return Err(error),
        };
        Ok(match scan_file(canonical_target).await? {
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
        let (target, normalized) = resolve_relative(root, relative_path)?;
        let target = safe_mutation_target(root, &target).await?;
        let _path_lock = self.path_locks.lock(&target).await;
        self.write_target(target, normalized, contents).await
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
        let _permit = self.permit().await?;
        let (target, normalized) = resolve_relative(root, relative_path)?;
        let target = safe_mutation_target(root, &target).await?;
        let _path_lock = self.path_locks.lock(&target).await;
        match (precondition, scan_file(target.clone()).await?) {
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
            _ => {}
        }
        #[cfg(test)]
        if let Some(hook) = &self.write_hook {
            hook.after_precondition_check(&target).await?;
        }
        self.write_target(target, normalized, contents).await
    }

    /// Writes in place, creating missing parents, preserving today's symlink-target behaviour.
    async fn write_target(
        &self,
        target: PathBuf,
        normalized: String,
        contents: &str,
    ) -> Result<WriteFileOutcome, WorkspaceError> {
        let target_existed = tokio::fs::try_exists(&target)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &target, error))?;
        let parent_existed = match target.parent() {
            Some(parent) => tokio::fs::try_exists(parent)
                .await
                .map_err(|error| WorkspaceError::operation("exists", parent, error))?,
            None => true,
        };
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| WorkspaceError::operation("make-directory", parent, error))?;
        }
        tokio::fs::write(&target, contents)
            .await
            .map_err(|error| WorkspaceError::operation("write-file", &target, error))?;
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
        let (target, normalized) = resolve_relative(root, relative_path)?;
        let target = safe_mutation_target(root, &target).await?;
        if tokio::fs::try_exists(&target)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &target, error))?
        {
            return Err(WorkspaceError::AlreadyExists { path: target });
        }
        match kind {
            EntryKind::Directory => tokio::fs::create_dir_all(&target)
                .await
                .map_err(|error| WorkspaceError::operation("make-directory", &target, error))?,
            EntryKind::File => {
                if let Some(parent) = target.parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(|error| {
                        WorkspaceError::operation("make-directory", parent, error)
                    })?;
                }
                tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .await
                    .map_err(|error| WorkspaceError::operation("write-file", &target, error))?;
            }
        }
        Ok(normalized)
    }

    pub async fn rename_entry(
        &self,
        root: &Path,
        from_relative_path: &str,
        to_relative_path: &str,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (from, _) = resolve_relative(root, from_relative_path)?;
        if !tokio::fs::try_exists(&from)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &from, error))?
        {
            return Err(WorkspaceError::NotFound { path: from });
        }
        canonical_existing_within(root, &from).await?;
        let (to, normalized) = resolve_relative(root, to_relative_path)?;
        let to = safe_mutation_target(root, &to).await?;
        if tokio::fs::try_exists(&to)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &to, error))?
        {
            return Err(WorkspaceError::AlreadyExists { path: to });
        }
        if let Some(parent) = to.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| WorkspaceError::operation("make-directory", parent, error))?;
        }
        tokio::fs::rename(&from, &to)
            .await
            .map_err(|error| WorkspaceError::operation("rename", &from, error))?;
        Ok(normalized)
    }

    pub async fn delete_entry(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (target, normalized) = resolve_relative(root, relative_path)?;
        if !tokio::fs::try_exists(&target)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &target, error))?
        {
            return Err(WorkspaceError::NotFound { path: target });
        }
        let (_, canonical_target) = canonical_existing_within(root, &target).await?;
        let metadata = tokio::fs::metadata(&canonical_target)
            .await
            .map_err(|error| WorkspaceError::operation("stat", &canonical_target, error))?;
        if metadata.is_dir() {
            tokio::fs::remove_dir_all(&target)
                .await
                .map_err(|error| WorkspaceError::operation("remove", &target, error))?;
        } else {
            tokio::fs::remove_file(&target)
                .await
                .map_err(|error| WorkspaceError::operation("remove", &target, error))?;
        }
        Ok(normalized)
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
        let (_, canonical_source) = canonical_existing_within(root, &source).await?;
        let metadata = tokio::fs::metadata(&canonical_source)
            .await
            .map_err(|error| WorkspaceError::operation("stat", &canonical_source, error))?;
        if !metadata.is_file() {
            return Err(WorkspaceError::NotFile {
                path: canonical_source,
            });
        }
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
            let (candidate, normalized) = resolve_relative(root, &relative.to_string_lossy())?;
            let candidate = safe_mutation_target(root, &candidate).await?;
            if !tokio::fs::try_exists(&candidate)
                .await
                .map_err(|error| WorkspaceError::operation("exists", &candidate, error))?
            {
                tokio::fs::copy(&canonical_source, &candidate)
                    .await
                    .map_err(|error| {
                        WorkspaceError::operation("copy-file", &canonical_source, error)
                    })?;
                return Ok(normalized);
            }
        }
        Err(WorkspaceError::AlreadyExists { path: source })
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
}
