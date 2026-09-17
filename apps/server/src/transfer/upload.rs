use std::path::{Path, PathBuf};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use tokio::io::AsyncWriteExt;

use super::TransferError;

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

/// Streams `body` into `directory/name`, writing to a temporary `.part` sibling first and
/// renaming into place only once the whole body has been written successfully. Rejects
/// collisions with an existing directory unconditionally, and with an existing file unless
/// `overwrite` is set. Enforces `max_bytes` and removes the partial file on any failure.
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
    match tokio::fs::symlink_metadata(&target).await {
        Ok(metadata) if metadata.is_dir() || !overwrite => {
            return Err(TransferError::EntryExists { path: target });
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(TransferError::operation("stat", &target, error)),
    }
    let partial = directory.join(format!(".{name}.bibcode-upload.part"));
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|error| TransferError::operation("create", &partial, error))?;
    let mut written: u64 = 0;
    let outcome: Result<(), TransferError> = async {
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
        Ok(())
    }
    .await;
    drop(file);
    if let Err(error) = outcome {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    tokio::fs::rename(&partial, &target)
        .await
        .map_err(|error| TransferError::operation("rename", &partial, error))?;
    Ok(target)
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
    async fn enforces_the_byte_limit_and_removes_partials() {
        let temp = tempfile::tempdir().unwrap();
        let error = write_upload(temp.path(), "big.bin", false, 4, body(&[b"12345"]))
            .await
            .unwrap_err();
        assert!(matches!(error, TransferError::UploadTooLarge { limit: 4 }));
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn never_replaces_a_directory() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("dir")).unwrap();
        let error = write_upload(temp.path(), "dir", true, 1024, body(&[b"x"]))
            .await
            .unwrap_err();
        assert!(matches!(error, TransferError::EntryExists { .. }));
    }
}
