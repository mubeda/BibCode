use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use tokio::io::AsyncWriteExt;

use super::TransferError;

/// Distinguishes partial files written by this process, so two concurrent uploads of the same
/// name never share one.
static PARTIAL_COUNTER: AtomicU64 = AtomicU64::new(0);

/// How many bytes of the requested name a partial file may echo. The rest of the partial name
/// (process id, counter, nanoseconds, suffix) plus this budget stays well inside the 255-byte
/// component limit every supported filesystem enforces, so a long but valid upload name can
/// still be written.
const PARTIAL_NAME_BUDGET: usize = 96;

/// Validates that `name` is a plain file name suitable for joining onto an upload directory:
/// non-empty, not `.`/`..`, no path separators or NUL bytes, and no longer than 255 bytes.
pub fn validate_upload_file_name(name: &str) -> Result<(), TransferError> {
    let valid = !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0']);
    if valid {
        Ok(())
    } else {
        Err(TransferError::InvalidFileName {
            name: name.to_owned(),
        })
    }
}

/// Streams `body` into `directory/name`, writing to a uniquely named temporary `.part` sibling
/// first and renaming into place only once the whole body has been written successfully.
/// Rejects collisions with an existing directory unconditionally, and with an existing file
/// unless `overwrite` is set.
///
/// When `overwrite` is not set the target name is *reserved* with `create_new` before any
/// bytes are streamed, so two concurrent uploads of the same new name cannot both believe they
/// won: the loser is refused up front instead of silently losing its bytes to the other's
/// rename. The reservation is closed immediately and the completed partial is renamed over it.
///
/// Enforces `max_bytes`, and on any failure removes the partial file and — only when this call
/// created it — the reservation, so a failed upload never leaves a stray file behind. An
/// existing file the caller asked to overwrite is never removed on failure; it keeps its old
/// contents.
pub async fn write_upload<S>(
    directory: &Path,
    name: &str,
    overwrite: bool,
    max_bytes: u64,
    mut body: S,
) -> Result<PathBuf, TransferError>
where
    S: Stream<Item = Result<Bytes, axum::Error>> + Unpin,
{
    validate_upload_file_name(name)?;
    let target = directory.join(name);
    // The directory guard runs in both modes and before any reservation: a directory is never
    // replaced, whatever the token asked for.
    match tokio::fs::symlink_metadata(&target).await {
        Ok(metadata) if metadata.is_dir() || !overwrite => {
            return Err(TransferError::EntryExists { path: target });
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(TransferError::operation("stat", &target, error)),
    }
    let reserved = if overwrite {
        false
    } else {
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .await
        {
            // Closed at once: a rename over a handle this process still holds fails on Windows.
            Ok(file) => {
                drop(file);
                true
            }
            Err(error) => return Err(reservation_error(&target, error).await),
        }
    };
    let partial = directory.join(partial_file_name(name));
    let outcome: Result<(), TransferError> = async {
        let mut file = tokio::fs::File::create(&partial)
            .await
            .map_err(|error| TransferError::operation("create", &partial, error))?;
        let mut written: u64 = 0;
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|error| {
                TransferError::operation("read-body", &partial, std::io::Error::other(error))
            })?;
            written = written.saturating_add(chunk.len() as u64);
            if written > max_bytes {
                return Err(TransferError::UploadTooLarge { limit: max_bytes });
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| TransferError::operation("write", &partial, error))?;
        }
        file.flush()
            .await
            .map_err(|error| TransferError::operation("flush", &partial, error))?;
        drop(file);
        tokio::fs::rename(&partial, &target)
            .await
            .map_err(|error| TransferError::operation("rename", &partial, error))
    }
    .await;
    if let Err(error) = outcome {
        let _ = tokio::fs::remove_file(&partial).await;
        if reserved {
            // Only a reservation this call created is removed; an existing file the caller
            // asked to overwrite keeps its contents.
            let _ = tokio::fs::remove_file(&target).await;
        }
        return Err(error);
    }
    Ok(target)
}

/// A name collision the reservation lost. `create_new` reports an existing entry as
/// `AlreadyExists` on Unix, including an existing directory; Windows can instead refuse a
/// directory with a permission error, so a directory at the target is reported as a collision
/// rather than as an I/O fault on every platform.
async fn reservation_error(target: &Path, error: std::io::Error) -> TransferError {
    if error.kind() == std::io::ErrorKind::AlreadyExists
        || tokio::fs::symlink_metadata(target)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
    {
        return TransferError::EntryExists {
            path: target.to_path_buf(),
        };
    }
    TransferError::operation("reserve", target, error)
}

/// A partial file name unique to this process, this call, and this instant, so concurrent
/// uploads of the same name never stream into the same file.
fn partial_file_name(name: &str) -> String {
    let counter = PARTIAL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let stem = truncate_on_char_boundary(name, PARTIAL_NAME_BUDGET);
    let pid = std::process::id();
    format!(".{stem}.{pid}-{counter}-{nanos}.bibcode-upload.part")
}

fn truncate_on_char_boundary(name: &str, budget: usize) -> &str {
    if name.len() <= budget {
        return name;
    }
    let mut end = budget;
    while end > 0 && !name.is_char_boundary(end) {
        end -= 1;
    }
    &name[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    fn body(
        chunks: &[&[u8]],
    ) -> impl futures_util::Stream<Item = Result<Bytes, axum::Error>> + Unpin {
        stream::iter(
            chunks
                .iter()
                .map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn validates_plain_file_names() {
        assert!(validate_upload_file_name("report.pdf").is_ok());
        for bad in ["", ".", "..", "a/b", "a\\b", &"x".repeat(256)] {
            assert!(
                matches!(
                    validate_upload_file_name(bad),
                    Err(TransferError::InvalidFileName { .. })
                ),
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn writes_atomically_refuses_collisions_and_overwrites_on_request() {
        let temp = tempfile::tempdir().unwrap();
        let written = write_upload(temp.path(), "a.txt", false, 1024, body(&[b"hel", b"lo"]))
            .await
            .unwrap();
        assert_eq!(std::fs::read(&written).unwrap(), b"hello");
        assert!(std::fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part")
        }));

        let error = write_upload(temp.path(), "a.txt", false, 1024, body(&[b"x"]))
            .await
            .unwrap_err();
        assert!(matches!(error, TransferError::EntryExists { .. }));
        assert_eq!(std::fs::read(&written).unwrap(), b"hello");

        write_upload(temp.path(), "a.txt", true, 1024, body(&[b"new"]))
            .await
            .unwrap();
        assert_eq!(std::fs::read(&written).unwrap(), b"new");
    }

    #[tokio::test]
    async fn enforces_the_byte_limit_and_removes_partials_and_the_reservation() {
        let temp = tempfile::tempdir().unwrap();
        // Two chunks: the first is written to the partial before the second blows the limit,
        // so this proves already-written bytes are cleaned up, not just an empty partial.
        let error = write_upload(temp.path(), "big.bin", false, 4, body(&[b"1234", b"5"]))
            .await
            .unwrap_err();
        assert!(matches!(error, TransferError::UploadTooLarge { limit: 4 }));
        assert_eq!(entry_names(temp.path()), Vec::<String>::new());
    }

    #[tokio::test]
    async fn removes_the_partial_and_the_reservation_when_the_body_stream_fails() {
        let temp = tempfile::tempdir().unwrap();
        let body = stream::iter(vec![
            Ok(Bytes::from_static(b"12")),
            Err(axum::Error::new(std::io::Error::other("boom"))),
        ]);
        let error = write_upload(temp.path(), "a.txt", false, 1024, body)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            TransferError::Operation {
                operation: "read-body",
                ..
            }
        ));
        assert_eq!(entry_names(temp.path()), Vec::<String>::new());
    }

    #[tokio::test]
    async fn an_overwrite_that_fails_leaves_the_existing_file_intact() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("a.txt"), b"original").unwrap();
        let body = stream::iter(vec![
            Ok(Bytes::from_static(b"12")),
            Err(axum::Error::new(std::io::Error::other("boom"))),
        ]);
        assert!(
            write_upload(temp.path(), "a.txt", true, 1024, body)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read(temp.path().join("a.txt")).unwrap(),
            b"original"
        );
        assert_eq!(entry_names(temp.path()), vec!["a.txt".to_owned()]);
    }

    #[tokio::test]
    async fn reserves_the_name_so_a_concurrent_upload_of_the_same_name_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        // The second call starts while the first is still streaming, so only the reservation
        // (not the final rename) can separate them.
        let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
        let slow = stream::once(async move {
            let _ = receiver.await;
            Ok(Bytes::from_static(b"first"))
        });
        let first = tokio::spawn({
            let directory = temp.path().to_path_buf();
            async move { write_upload(&directory, "a.txt", false, 1024, Box::pin(slow)).await }
        });
        // Give the first call time to reserve the name before the second one tries.
        tokio::task::yield_now().await;
        while !temp.path().join("a.txt").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        let second = write_upload(temp.path(), "a.txt", false, 1024, body(&[b"second"]))
            .await
            .unwrap_err();
        assert!(matches!(second, TransferError::EntryExists { .. }));
        sender.send(()).unwrap();
        first.await.unwrap().unwrap();
        assert_eq!(std::fs::read(temp.path().join("a.txt")).unwrap(), b"first");
        assert_eq!(entry_names(temp.path()), vec!["a.txt".to_owned()]);
    }

    #[test]
    fn partial_names_are_unique_per_call_and_stay_within_a_path_component() {
        let long = "x".repeat(255);
        let first = partial_file_name(&long);
        let second = partial_file_name(&long);
        assert_ne!(first, second);
        for name in [&first, &second] {
            assert!(name.len() <= 255, "{name}");
            assert!(name.ends_with(".bibcode-upload.part"));
            assert!(!name.contains('/'));
        }
        // A budget that lands mid-scalar backs off to a boundary: one ASCII byte then 3-byte
        // characters puts byte 96 inside a character, so the stem must stop at byte 94.
        let multi_byte = partial_file_name(&format!("a{}", "\u{2603}".repeat(100)));
        assert!(multi_byte.len() <= 255, "{multi_byte}");
        assert!(
            multi_byte.starts_with(&format!(".a{}.", "\u{2603}".repeat(31))),
            "{multi_byte}"
        );
    }

    #[tokio::test]
    async fn never_replaces_a_directory() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("dir")).unwrap();
        for overwrite in [true, false] {
            let error = write_upload(temp.path(), "dir", overwrite, 1024, body(&[b"x"]))
                .await
                .unwrap_err();
            assert!(
                matches!(error, TransferError::EntryExists { .. }),
                "{overwrite}"
            );
        }
        assert!(temp.path().join("dir").is_dir());
    }

    fn entry_names(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}
