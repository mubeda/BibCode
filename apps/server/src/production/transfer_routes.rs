//! Production handlers for the signed file-transfer routes.
//!
//! The signed token is the only authority these handlers trust: it carries the canonical
//! workspace root plus the relative path the RPC layer already validated, so a client can
//! never widen the scope of a download or steer an upload outside its folder.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::StatusCode;
use serde_json::json;

use crate::production::http_routes::{
    BoxFuture, HttpRouteError, TransferArchiveLimitUnit, TransferDownloadHandler,
    TransferDownloadHttpOutcome, TransferDownloadHttpResponse, TransferUploadHandler,
    TransferUploadHttpOutcome,
};
use crate::transfer::{self, TransferAccess, TransferClaims};
use crate::workspace::paths;

/// Invoked after a successful upload so the owner of the workspace entry index can drop its
/// now-stale snapshot for that root.
pub type UploadedCallback = Arc<dyn Fn(PathBuf) -> BoxFuture<()> + Send + Sync>;

/// Streams a single file, or a folder as a zip archive, for a valid download token.
#[must_use]
pub fn download_handler(access: TransferAccess) -> TransferDownloadHandler {
    download_handler_with_limits(
        access,
        transfer::archive::MAX_ARCHIVE_ENTRIES,
        transfer::archive::MAX_ARCHIVE_BYTES,
    )
}

/// [`download_handler`] with explicit archive budgets, so a caller -- or a test -- can prove the
/// oversized-folder path without building a workspace that exceeds the production limits.
#[must_use]
pub fn download_handler_with_limits(
    access: TransferAccess,
    max_entries: usize,
    max_bytes: u64,
) -> TransferDownloadHandler {
    Arc::new(move |token, _context| {
        let access = access.clone();
        Box::pin(async move {
            let Some(TransferClaims::Download { root, relative, .. }) = access.verify(&token)
            else {
                return Err(not_found());
            };
            let (target, _) = paths::resolve_relative(&root, &relative).map_err(|_| not_found())?;
            let (_, canonical) = paths::canonical_existing_within(&root, &target)
                .await
                .map_err(|_| not_found())?;
            let metadata = tokio::fs::metadata(&canonical)
                .await
                .map_err(|_| not_found())?;
            let name = canonical
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "download".to_owned());
            if metadata.is_dir() {
                // The plan both enforces the archive limits and proves to `archive_body` that
                // they were enforced, so an oversized folder fails before the response starts.
                let plan = match transfer::archive::plan_archive_with_limits(
                    &canonical,
                    max_entries,
                    max_bytes,
                )
                .await
                {
                    Ok(plan) => plan,
                    Err(transfer::TransferError::TooManyEntries { limit }) => {
                        return Ok(TransferDownloadHttpOutcome::ArchiveTooLarge {
                            limit: u64::try_from(limit).unwrap_or(u64::MAX),
                            unit: TransferArchiveLimitUnit::Entries,
                        });
                    }
                    Err(transfer::TransferError::TooManyBytes { limit }) => {
                        return Ok(TransferDownloadHttpOutcome::ArchiveTooLarge {
                            limit,
                            unit: TransferArchiveLimitUnit::Bytes,
                        });
                    }
                    Err(_) => return Err(not_found()),
                };
                Ok(TransferDownloadHttpOutcome::Stream(
                    TransferDownloadHttpResponse {
                        file_name: format!("{name}.zip"),
                        content_type: "application/zip",
                        body: transfer::archive::archive_body(plan, canonical),
                    },
                ))
            } else {
                let file = tokio::fs::File::open(&canonical)
                    .await
                    .map_err(|_| not_found())?;
                Ok(TransferDownloadHttpOutcome::Stream(
                    TransferDownloadHttpResponse {
                        file_name: name,
                        content_type: "application/octet-stream",
                        body: Body::from_stream(tokio_util::io::ReaderStream::new(file)),
                    },
                ))
            }
        }) as BoxFuture<_>
    })
}

/// Streams a request body into the folder a valid upload token names.
#[must_use]
pub fn upload_handler(
    access: TransferAccess,
    on_uploaded: UploadedCallback,
) -> TransferUploadHandler {
    Arc::new(move |token, name, overwrite, body, _context| {
        let access = access.clone();
        let on_uploaded = on_uploaded.clone();
        Box::pin(async move {
            let Some(TransferClaims::Upload {
                root,
                relative_dir,
                max_bytes,
                ..
            }) = access.verify(&token)
            else {
                return Err(not_found());
            };
            // Both branches canonicalize, so the written path always shares a prefix with the
            // root the relative result is reported against.
            let (canonical_root, directory) = if relative_dir.is_empty() {
                let canonical_root = paths::normalize_root(&root, false)
                    .await
                    .map_err(|_| not_found())?;
                (canonical_root.clone(), canonical_root)
            } else {
                let (target, _) =
                    paths::resolve_relative(&root, &relative_dir).map_err(|_| not_found())?;
                paths::canonical_existing_within(&root, &target)
                    .await
                    .map_err(|_| not_found())?
            };
            if transfer::upload::validate_upload_file_name(&name).is_err() {
                return Err(bad_request("Upload file name must be a plain file name."));
            }
            match transfer::upload::write_upload(
                &directory,
                &name,
                overwrite,
                max_bytes,
                body.into_data_stream(),
            )
            .await
            {
                Ok(written) => {
                    on_uploaded(canonical_root.clone()).await;
                    let relative = written
                        .strip_prefix(&canonical_root)
                        .map(paths::to_posix)
                        .unwrap_or_else(|_| name.clone());
                    Ok(TransferUploadHttpOutcome::Created {
                        relative_path: relative,
                    })
                }
                Err(transfer::TransferError::EntryExists { .. }) => {
                    Ok(TransferUploadHttpOutcome::Exists)
                }
                Err(transfer::TransferError::UploadTooLarge { limit }) => {
                    Ok(TransferUploadHttpOutcome::TooLarge { limit })
                }
                Err(error) => Err(internal(error.to_string())),
            }
        }) as BoxFuture<_>
    })
}

/// A missing, expired, tampered, or wrong-kind token is indistinguishable from a missing
/// resource on the wire: the route must not confirm that a path exists.
fn not_found() -> HttpRouteError {
    HttpRouteError::new(
        StatusCode::NOT_FOUND,
        json!({
            "_tag": "TransferNotFoundError",
            "message": "Transfer was not found or its access token expired."
        }),
    )
}

fn bad_request(message: &str) -> HttpRouteError {
    HttpRouteError::new(
        StatusCode::BAD_REQUEST,
        json!({
            "_tag": "EnvironmentHttpBadRequestError",
            "message": message,
        }),
    )
}

fn internal(message: impl std::fmt::Display) -> HttpRouteError {
    HttpRouteError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({
            "_tag": "EnvironmentHttpInternalServerError",
            "message": message.to_string(),
        }),
    )
}
