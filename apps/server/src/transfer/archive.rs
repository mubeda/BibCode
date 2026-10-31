use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use axum::body::Body;
use futures_util::{StreamExt, stream};
use tokio_util::io::{ReaderStream, SyncIoBridge};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::TransferError;
use crate::workspace::beneath::{Dir, Kind, Open, Root, is_escape};

/// Maximum number of filesystem entries a single folder download may contain.
pub const MAX_ARCHIVE_ENTRIES: usize = 200_000;
/// Maximum total uncompressed byte size a single folder download may contain.
pub const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Chunk size for every streamed download body, archive or single file.
pub const DOWNLOAD_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchivePlan {
    pub entries: usize,
    pub bytes: u64,
}

/// The budgets a folder download is planned against. [`Default`] is the production limit; a
/// caller -- or a test -- can bind a tighter one without rebuilding an oversized workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveLimits {
    pub max_entries: usize,
    pub max_bytes: u64,
}

impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_ARCHIVE_ENTRIES,
            max_bytes: MAX_ARCHIVE_BYTES,
        }
    }
}

impl ArchiveLimits {
    /// Walks `root` to size the archive, refusing a tree that exceeds these budgets.
    pub async fn plan(&self, root: &Path) -> Result<ArchivePlan, TransferError> {
        plan_archive_with_limits(root, self.max_entries, self.max_bytes).await
    }
}

/// Walks `root` to size the archive before streaming it, enforcing the default limits.
pub async fn plan_archive(root: &Path) -> Result<ArchivePlan, TransferError> {
    ArchiveLimits::default().plan(root).await
}

/// Walks `root` to size the archive before streaming it, enforcing the given limits.
pub async fn plan_archive_with_limits(
    root: &Path,
    max_entries: usize,
    max_bytes: u64,
) -> Result<ArchivePlan, TransferError> {
    let root = root.to_path_buf();
    let root_for_join_error = root.clone();
    tokio::task::spawn_blocking(move || {
        let mut plan = ArchivePlan {
            entries: 0,
            bytes: 0,
        };
        let mut stack = vec![root.clone()];
        while let Some(directory) = stack.pop() {
            let read = std::fs::read_dir(&directory)
                .map_err(|error| TransferError::operation("read-dir", &directory, error))?;
            for entry in read {
                let entry = entry.map_err(|error| {
                    TransferError::operation("read-dir-entry", &directory, error)
                })?;
                let path = entry.path();
                let metadata = std::fs::symlink_metadata(&path)
                    .map_err(|error| TransferError::operation("stat", &path, error))?;
                let file_type = metadata.file_type();
                if !file_type.is_file() && !file_type.is_dir() {
                    // Skips symlinks (never followed) and any other non-regular entry
                    // (sockets, FIFOs, device nodes, ...): opening those for reading can
                    // block forever (FIFO) or fail unpredictably (socket), and none of
                    // them belong in a folder download.
                    continue;
                }
                plan.entries += 1;
                if plan.entries > max_entries {
                    return Err(TransferError::TooManyEntries { limit: max_entries });
                }
                if metadata.is_dir() {
                    stack.push(path);
                } else {
                    plan.bytes = plan.bytes.saturating_add(metadata.len());
                    if plan.bytes > max_bytes {
                        return Err(TransferError::TooManyBytes { limit: max_bytes });
                    }
                }
            }
        }
        Ok(plan)
    })
    .await
    .map_err(|error| {
        TransferError::operation(
            "archive-plan",
            &root_for_join_error,
            io::Error::other(error),
        )
    })?
}

/// Streams a zip of `root`'s contents. `plan` is a proof token: callers must have already
/// obtained a successful `ArchivePlan` (via `plan_archive`/`plan_archive_with_limits`) for
/// `root` before starting the response, so this signature makes it impossible to stream an
/// archive whose limits were never checked. I/O failures during streaming fail the response
/// body and are logged since the HTTP response has already begun.
pub fn archive_body(plan: ArchivePlan, root: PathBuf) -> Body {
    archive_body_with(plan, root.clone(), ArchiveLimits::default(), move || {
        Root::new(&root).and_then(|validated| Dir::open(&validated, &root, false))
    })
}

/// [`archive_body`] over a folder already held open (`workspace::beneath`): the archive reads
/// it, and every folder and file under it, through handles opened without following a
/// symlink, so a folder swapped for a symlink while the archive streams is skipped, never
/// followed. `limits` hold while it streams too: a tree that grew past them since it was
/// planned fails the stream. `label` names the folder in logs only.
pub(crate) fn archive_body_from(
    plan: ArchivePlan,
    folder: Dir,
    label: PathBuf,
    limits: ArchiveLimits,
) -> Body {
    archive_body_with(plan, label, limits, move || Ok(folder))
}

fn archive_body_with(
    plan: ArchivePlan,
    root: PathBuf,
    limits: ArchiveLimits,
    folder: impl FnOnce() -> io::Result<Dir> + Send + 'static,
) -> Body {
    tracing::debug!(root = %root.display(), entries = plan.entries, bytes = plan.bytes, "streaming folder download");
    let (writer, reader) = tokio::io::duplex(64 * 1024);
    let producer = tokio::task::spawn_blocking(move || {
        folder()
            .and_then(|folder| write_archive(&folder, limits, SyncIoBridge::new(writer)))
            .inspect_err(|error| {
                tracing::warn!(root = %root.display(), %error, "folder download stream failed");
            })
    });
    // 64 KiB chunks rather than the 4 KiB `ReaderStream` default: a folder download is bulk
    // I/O, and the smaller default costs sixteen times the per-chunk framing for the same bytes.
    // Dropping the writer reports EOF even when ZIP creation failed. Keep the producer's result
    // in the HTTP stream so clients discard an incomplete archive instead of saving it as success.
    let completion = stream::once(async move {
        producer
            .await
            .map_err(io::Error::other)?
            .map(|()| axum::body::Bytes::new())
    });
    Body::from_stream(ReaderStream::with_capacity(reader, DOWNLOAD_CHUNK_BYTES).chain(completion))
}

/// The stream's failure when the tree outgrew a limit after it was planned.
fn over_limit(limit: &str) -> io::Error {
    io::Error::other(format!(
        "the folder grew past the download's {limit} limit while it streamed"
    ))
}

fn write_archive<W: Write>(root: &Dir, limits: ArchiveLimits, sink: W) -> io::Result<()> {
    let mut zip = ZipWriter::new_stream(sink);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .large_file(true);
    // Counted as the plan counts them: every folder and file added.
    let (mut entries, mut bytes) = (0_usize, 0_u64);
    let mut count = || {
        entries += 1;
        if entries > limits.max_entries {
            return Err(over_limit("entry"));
        }
        Ok(())
    };
    // Each folder is held open and its children reached by name through it.
    let mut stack: Vec<(Option<Dir>, String)> = vec![(None, String::new())];
    while let Some((folder, prefix)) = stack.pop() {
        let folder = folder.as_ref().unwrap_or(root);
        let mut children = folder.names()?;
        children.sort();
        for child in children {
            let name = format!("{prefix}{}", child.to_string_lossy());
            match folder.kind(&child)? {
                Kind::Directory => match folder.open_dir(&child) {
                    Ok(inner) => {
                        count()?;
                        zip.add_directory(format!("{name}/"), options)?;
                        stack.push((Some(inner), format!("{name}/")));
                    }
                    // It became a symlink after it was listed: skipped, never followed.
                    Err(error) if is_escape(&error) => {}
                    Err(error) => return Err(error),
                },
                Kind::File => {
                    let file = match folder.open_file(&child, Open::Read) {
                        Ok(file) => file,
                        Err(error) if is_escape(&error) => continue,
                        Err(error) => return Err(error),
                    };
                    // A named pipe or device put in its place since it was listed.
                    if !file.metadata()?.is_file() {
                        continue;
                    }
                    count()?;
                    zip.start_file(name, options)?;
                    // At most one byte past what is left, so growth is caught without reading
                    // the rest of a file that grew.
                    let left = limits.max_bytes.saturating_sub(bytes);
                    let file: File = file;
                    bytes += io::copy(&mut io::Read::take(file, left.saturating_add(1)), &mut zip)?;
                    if bytes > limits.max_bytes {
                        return Err(over_limit("size"));
                    }
                }
                // Symlinks are never followed, and other entries (sockets, FIFOs, devices)
                // do not belong in a folder download; see `plan_archive_with_limits`.
                Kind::Symlink | Kind::Other | Kind::Missing => {}
            }
        }
    }
    zip.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[tokio::test]
    async fn plans_and_streams_a_zip_skipping_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("folder");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("a.txt"), b"hello").unwrap();
        std::fs::write(root.join("nested/b.bin"), [0u8, 1, 2]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("a.txt"), root.join("link.txt")).unwrap();
        #[cfg(unix)]
        std::os::unix::net::UnixListener::bind(root.join("x.sock")).unwrap();

        let plan = plan_archive(&root).await.unwrap();
        assert_eq!(plan.entries, 3); // a.txt, nested/, nested/b.bin
        assert_eq!(plan.bytes, 8);

        let body = archive_body(plan, root.clone());
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|index| {
                archive
                    .by_index(index)
                    .unwrap()
                    .name()
                    .unwrap()
                    .into_owned()
            })
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "nested/", "nested/b.bin"]);
        assert!(!names.iter().any(|name| name.contains("sock")));
        let mut content = String::new();
        archive
            .by_name("a.txt")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "hello");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_folder_swapped_for_an_outside_symlink_while_it_zips_is_never_followed() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::create_dir_all(root.join("folder/sub")).unwrap();
        std::fs::write(root.join("folder/sub/mine.txt"), b"mine").unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
        let validated = Root::new(&root).unwrap();
        let folder = Dir::open(&validated, &root.join("folder"), false).unwrap();
        let plan = plan_archive(&root.join("folder")).await.unwrap();
        // After the route opened the folder: the folder, and a folder inside it, each become
        // a symlink to somewhere outside.
        std::fs::rename(root.join("folder"), root.join("moved")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("folder")).unwrap();
        std::fs::rename(root.join("moved/sub"), root.join("moved/sub.real")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("moved/sub")).unwrap();

        let body = archive_body_from(plan, folder, root.join("folder"), ArchiveLimits::default());
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|index| {
                archive
                    .by_index(index)
                    .unwrap()
                    .name()
                    .unwrap()
                    .into_owned()
            })
            .collect();
        names.sort();
        assert_eq!(names, vec!["sub.real/", "sub.real/mine.txt"]);
    }

    #[tokio::test]
    async fn archive_read_failure_rejects_the_body_instead_of_completing_a_partial_zip() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("folder");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("file.txt"), b"content").unwrap();
        let plan = plan_archive(&root).await.unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        assert!(
            axum::body::to_bytes(archive_body(plan, root), usize::MAX)
                .await
                .is_err(),
            "an archive producer failure must not be reported as a successful HTTP body"
        );
    }

    #[tokio::test]
    async fn a_folder_that_outgrows_its_limits_after_planning_fails_the_stream() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::write(root.join("a.txt"), b"1234").unwrap();
        let limits = ArchiveLimits {
            max_entries: 2,
            max_bytes: 8,
        };
        let stream = |limits: ArchiveLimits| {
            let validated = Root::new(&root).unwrap();
            let folder = Dir::open(&validated, &root, false).unwrap();
            let plan = ArchivePlan {
                entries: 1,
                bytes: 4,
            };
            axum::body::to_bytes(
                archive_body_from(plan, folder, root.clone(), limits),
                usize::MAX,
            )
        };
        assert!(stream(limits).await.is_ok());
        // More bytes than planned: the file grew.
        std::fs::write(root.join("a.txt"), b"123456789").unwrap();
        assert!(
            stream(limits).await.is_err(),
            "the size limit holds while streaming"
        );
        // More entries than planned.
        std::fs::write(root.join("a.txt"), b"1").unwrap();
        for name in ["b.txt", "c.txt"] {
            std::fs::write(root.join(name), b"1").unwrap();
        }
        assert!(
            stream(limits).await.is_err(),
            "the entry limit holds while streaming"
        );
    }

    #[tokio::test]
    async fn plan_rejects_oversized_trees() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("big"), vec![0u8; 16]).unwrap();
        let error = plan_archive_with_limits(temp.path(), 10, 8)
            .await
            .unwrap_err();
        assert!(matches!(error, TransferError::TooManyBytes { limit: 8 }));
        for index in 0..3 {
            std::fs::write(temp.path().join(format!("f{index}")), b"").unwrap();
        }
        let error = plan_archive_with_limits(temp.path(), 2, u64::MAX)
            .await
            .unwrap_err();
        assert!(matches!(error, TransferError::TooManyEntries { limit: 2 }));
    }
}
