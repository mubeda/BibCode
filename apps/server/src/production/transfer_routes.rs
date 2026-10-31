//! Production handlers for the signed file-transfer routes.
//!
//! The signed token is the authority these handlers trust for the target: it carries the
//! canonical workspace root plus the relative path the RPC layer already validated -- and, for
//! an upload, the single file name it authorises -- so a client can never widen the scope of a
//! download or steer an upload at another name or folder.
//!
//! A token an outside agent minted over MCP (#139 X5) also names the agent's session, and is
//! served only while that session's access lasts: the route checks it when the transfer
//! starts, runs the transfer under the session's live controls, and an upload checks once more
//! just before its final rename. An ended access answers like an expired token. Such a
//! transfer, once started, writes one content-free activity row when it ends. The UI's tokens
//! carry no session and behave as before.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::StatusCode;
use futures_util::StreamExt;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::mcp::control::McpControl;
use crate::mcp::outcome::{TransferControls, TransferUse};
use crate::production::http_routes::{
    BoxFuture, HttpRouteError, TransferArchiveLimitUnit, TransferDownloadHandler,
    TransferDownloadHttpOutcome, TransferDownloadHttpResponse, TransferUploadHandler,
    TransferUploadHttpOutcome,
};
use crate::transfer::{self, TransferAccess, TransferClaims};
use crate::workspace::PathLocks;
use crate::workspace::beneath::{Dir, Open, Root};
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

/// [`download_handler`] that also serves the tokens outside agents mint, under `mcp`'s live
/// controls.
#[must_use]
pub fn download_handler_with_mcp(
    access: TransferAccess,
    mcp: McpControl,
) -> TransferDownloadHandler {
    downloads(
        access,
        transfer::archive::MAX_ARCHIVE_ENTRIES,
        transfer::archive::MAX_ARCHIVE_BYTES,
        Some(mcp),
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
    downloads(access, max_entries, max_bytes, None)
}

/// The live controls of a session-bound token, or `None` for a UI token; an ended access, or a
/// server without the MCP service, is a missing transfer.
async fn controls_for(
    mcp: Option<&McpControl>,
    session_id: Option<&str>,
    transfer: TransferUse,
) -> Result<Option<(TransferControls, Finish)>, HttpRouteError> {
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    let Some(mcp) = mcp else {
        return Err(not_found());
    };
    let Some(controls) = mcp.transfer_controls(session_id, transfer).await else {
        tracing::debug!("transfer refused: the minting agent's access ended");
        return Err(not_found());
    };
    Ok(Some((
        controls,
        Finish {
            mcp: mcp.clone(),
            session_id: session_id.to_owned(),
            transfer,
            transfer_id: String::new(),
            recorded: false,
            pending: NOT_FOUND_TAG,
        },
    )))
}

fn downloads(
    access: TransferAccess,
    max_entries: usize,
    max_bytes: u64,
    mcp: Option<McpControl>,
) -> TransferDownloadHandler {
    Arc::new(move |token, _context| {
        let access = access.clone();
        let mcp = mcp.clone();
        Box::pin(async move {
            let Some(TransferClaims::Download {
                root,
                relative,
                mcp_session_id,
                ..
            }) = access.verify(&token)
            else {
                tracing::warn!("download rejected: transfer capability is invalid or expired");
                return Err(not_found());
            };
            let mut watched = controls_for(
                mcp.as_ref(),
                mcp_session_id.as_deref(),
                TransferUse::Download,
            )
            .await?
            .map(|(controls, mut finish)| {
                finish.transfer_id = transfer::transfer_id(&token);
                (controls, finish)
            });
            let (target, _) = paths::resolve_relative(&root, &relative).map_err(|error| {
                tracing::warn!(%error, "download path resolution failed");
                not_found()
            })?;
            let (canonical_root, canonical) = paths::canonical_existing_within(&root, &target)
                .await
                .map_err(|error| {
                    tracing::warn!(%error, "download path validation failed");
                    not_found()
                })?;
            let metadata = tokio::fs::metadata(&canonical)
                .await
                .map_err(|error| {
                    tracing::warn!(path = %canonical.display(), %error, "download metadata read failed");
                    not_found()
                })?;
            let file_name = transfer::download_file_name(&canonical, metadata.is_dir());
            let outcome = if metadata.is_dir() {
                // The folder is held open from here; the plan and the archive both walk it
                // through no-follow handles, so a swap after the check above is never followed.
                let limits = transfer::archive::ArchiveLimits {
                    max_entries,
                    max_bytes,
                };
                let label = canonical.clone();
                let opened = tokio::task::spawn_blocking(move || {
                    let folder = Root::new(&canonical_root)
                        .and_then(|root| Dir::open(&root, &canonical, false))
                        .map_err(|error| {
                            tracing::warn!(%error, "folder download open failed");
                            None
                        })?;
                    // The plan both enforces the archive limits and proves to `archive_body`
                    // that they were enforced, so an oversized folder fails before the
                    // response starts.
                    transfer::archive::plan_dir(&folder, limits)
                        .map(|plan| (plan, folder))
                        .map_err(Some)
                })
                .await
                .map_err(|_| not_found())?;
                let (plan, folder) = match opened {
                    Ok(opened) => opened,
                    Err(None) => return Err(not_found()),
                    Err(Some(error)) => {
                        let (limit, unit) = match error {
                            transfer::TransferError::TooManyEntries { limit } => (
                                u64::try_from(limit).unwrap_or(u64::MAX),
                                TransferArchiveLimitUnit::Entries,
                            ),
                            transfer::TransferError::TooManyBytes { limit } => {
                                (limit, TransferArchiveLimitUnit::Bytes)
                            }
                            error => {
                                tracing::warn!(%error, "folder download preparation failed");
                                return Err(not_found());
                            }
                        };
                        if let Some((_, finish)) = watched.as_mut() {
                            finish.pending = "TransferArchiveTooLargeError";
                        }
                        return Ok(TransferDownloadHttpOutcome::ArchiveTooLarge { limit, unit });
                    }
                };
                TransferDownloadHttpResponse {
                    file_name,
                    content_type: "application/zip",
                    // A zip is produced as it streams, so its length is unknown until the
                    // last entry: the archive response stays chunked.
                    content_length: None,
                    body: transfer::archive::archive_body_from(plan, folder, label, limits),
                }
            } else {
                // Opened through a handle on its folder, never by a path that could have
                // changed since the check above.
                let file = tokio::task::spawn_blocking(move || {
                    let folder = canonical.parent().ok_or_else(not_found)?;
                    let name = canonical.file_name().ok_or_else(not_found)?;
                    let file = Root::new(&canonical_root)
                        .and_then(|root| Dir::open(&root, folder, false))
                        .and_then(|dir| dir.open_file(name, Open::Read))
                        .map_err(|error| {
                            tracing::warn!(%error, "download file open failed");
                            not_found()
                        })?;
                    let regular = file.metadata().is_ok_and(|metadata| metadata.is_file());
                    regular.then_some(file).ok_or_else(not_found)
                })
                .await
                .map_err(|_| not_found())??;
                let file = tokio::fs::File::from_std(file);
                // The length comes from the opened handle, not the earlier stat, so the header
                // describes the bytes this response will actually read.
                let content_length = file.metadata().await.map(|metadata| metadata.len()).ok();
                TransferDownloadHttpResponse {
                    file_name,
                    content_type: "application/octet-stream",
                    content_length,
                    body: Body::from_stream(tokio_util::io::ReaderStream::with_capacity(
                        file,
                        transfer::archive::DOWNLOAD_CHUNK_BYTES,
                    )),
                }
            };
            Ok(TransferDownloadHttpOutcome::Stream(match watched {
                Some((controls, finish)) => TransferDownloadHttpResponse {
                    body: watched_body(outcome.body, controls, finish),
                    ..outcome
                },
                None => outcome,
            }))
        }) as BoxFuture<_>
    })
}

/// The tag a transfer whose access ended mid-way records, and answers with.
const ACCESS_ENDED_TAG: &str = "McpAccessEndedError";

/// `body`, ended with an error as soon as the agent's access ends, so a client sees a broken
/// transfer, never a short one that looks complete. Its activity row is written when it ends.
fn watched_body(body: Body, controls: TransferControls, mut finish: Finish) -> Body {
    // Once the body streams, ending without a result means the client went away.
    finish.pending = "McpCancelledError";
    let token = controls.token();
    let state = Some((body.into_data_stream(), controls, finish));
    Body::from_stream(futures_util::stream::unfold(state, move |state| {
        let token = token.clone();
        async move {
            let (mut stream, controls, mut finish) = state?;
            tokio::select! {
                biased;
                () = token.cancelled() => {
                    finish.record(ACCESS_ENDED_TAG).await;
                    Some((Err(std::io::Error::other("the transfer's access ended")), None))
                }
                next = stream.next() => match next {
                    Some(Ok(bytes)) => Some((Ok(bytes), Some((stream, controls, finish)))),
                    Some(Err(error)) => {
                        finish.record("TransferFailedError").await;
                        Some((Err(std::io::Error::other(error)), None))
                    }
                    None => {
                        finish.record("success").await;
                        None
                    }
                },
            }
        }
    }))
}

/// The tag of a transfer refused after it was admitted (its path is gone): the route's 404.
const NOT_FOUND_TAG: &str = "TransferNotFoundError";

/// One activity row for an agent's transfer, written once when it ends. One that returns
/// before recording records `pending`: the refusal it answered, or, once a download's body
/// streams, `McpCancelledError` (the client went away).
struct Finish {
    mcp: McpControl,
    session_id: String,
    transfer: TransferUse,
    transfer_id: String,
    recorded: bool,
    pending: &'static str,
}

impl Finish {
    fn row(&self, outcome: &str) -> crate::mcp::activity::NewActivity {
        crate::mcp::activity::NewActivity {
            session_id: self.session_id.clone(),
            label: None,
            tool: match self.transfer {
                TransferUse::Download => "files_download",
                TransferUse::Upload => "files_upload",
            }
            .to_owned(),
            thread_id: None,
            outcome: outcome.to_owned(),
            target: json!({ "transferId": self.transfer_id }),
        }
    }

    async fn record(&mut self, outcome: &str) {
        self.recorded = true;
        let mut row = self.row(outcome);
        row.label = self.mcp.auth().client_label(&self.session_id).await;
        self.mcp.activity().record(row).await;
    }
}

impl Drop for Finish {
    fn drop(&mut self) {
        if self.recorded {
            return;
        }
        let row = self.row(self.pending);
        let mcp = self.mcp.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let mut row = row;
                row.label = mcp.auth().client_label(&row.session_id).await;
                mcp.activity().record(row).await;
            });
        }
    }
}

/// Streams a request body into the one file a valid upload token names.
///
/// `requested_name` is the `?name=` a client still sent, if any. It is never the authority: the
/// file name comes from the token. A value that disagrees with the token is refused outright, so
/// a stale or hostile client cannot steer a token at another name and then read the 201 as
/// confirmation that it did.
#[must_use]
pub fn upload_handler(
    access: TransferAccess,
    on_uploaded: UploadedCallback,
) -> TransferUploadHandler {
    uploads(access, on_uploaded, None, PathLocks::default())
}

/// [`upload_handler`] that also serves the tokens outside agents mint, under `mcp`'s live
/// controls, and takes each upload's path in `locks`, the workspace service's, so no other
/// BiBCode writer of that path runs while it does.
#[must_use]
pub(crate) fn upload_handler_with_mcp(
    access: TransferAccess,
    on_uploaded: UploadedCallback,
    mcp: McpControl,
    locks: PathLocks,
) -> TransferUploadHandler {
    uploads(access, on_uploaded, Some(mcp), locks)
}

/// The tag of an upload refused because another BiBCode writer holds its path.
const BUSY_TAG: &str = "TransferBusyError";

fn busy() -> HttpRouteError {
    HttpRouteError::new(
        StatusCode::CONFLICT,
        json!({
            "_tag": BUSY_TAG,
            "message": "Another BiBCode write or upload of this file is in progress; try again when it ends."
        }),
    )
}

fn uploads(
    access: TransferAccess,
    on_uploaded: UploadedCallback,
    mcp: Option<McpControl>,
    locks: PathLocks,
) -> TransferUploadHandler {
    Arc::new(move |token, requested_name, overwrite, body, _context| {
        let access = access.clone();
        let on_uploaded = on_uploaded.clone();
        let mcp = mcp.clone();
        let locks = locks.clone();
        Box::pin(async move {
            let Some(TransferClaims::Upload {
                root,
                relative_dir,
                file_name,
                max_bytes,
                mcp_session_id,
                overwrite: bound_overwrite,
                ..
            }) = access.verify(&token)
            else {
                return Err(not_found());
            };
            if requested_name.is_some_and(|requested| requested != file_name) {
                return Err(bad_request(
                    "Query parameter 'name' does not match the upload token.",
                ));
            }
            // A token that binds `overwrite` decides it; `?overwrite=1` on one minted without
            // it is refused, so a URL can never replace a file its mint did not allow.
            let overwrite = match bound_overwrite {
                None => overwrite,
                Some(false) if overwrite => {
                    return Err(bad_request(
                        "This upload URL does not allow overwriting; mint one with overwrite.",
                    ));
                }
                Some(bound) => bound,
            };
            let watched =
                controls_for(mcp.as_ref(), mcp_session_id.as_deref(), TransferUse::Upload).await?;
            let (cancellation, mut finish) = match watched {
                Some((controls, mut finish)) => {
                    finish.transfer_id = transfer::transfer_id(&token);
                    (Some(controls), Some(finish))
                }
                None => (None, None),
            };
            let token = cancellation
                .as_ref()
                .map_or_else(CancellationToken::new, TransferControls::token);
            // Both branches canonicalize, so the written path always shares a prefix with the
            // root the relative result is reported against.
            let canonical_root = paths::normalize_root(&root, false)
                .await
                .map_err(|_| not_found())?;
            let directory = if relative_dir.is_empty() {
                canonical_root.clone()
            } else {
                let (target, _) =
                    paths::resolve_relative(&root, &relative_dir).map_err(|_| not_found())?;
                paths::canonical_existing_within(&root, &target)
                    .await
                    .map_err(|_| not_found())?
                    .1
            };
            // The path is this upload's from its reservation to its install: a Files-panel
            // save or `files_write` of it meanwhile is refused (`path_busy`).
            let Ok(_held) = locks.lock_upload(&directory.join(&file_name)).await else {
                if let Some(finish) = finish.as_mut() {
                    finish.pending = BUSY_TAG;
                }
                return Err(busy());
            };
            let written = transfer::upload::write_upload(
                &canonical_root,
                &directory,
                &file_name,
                overwrite,
                max_bytes,
                body.into_data_stream(),
                &token,
            )
            .await;
            if let Some(finish) = finish.as_mut() {
                let outcome = match &written {
                    Ok(_) => "success",
                    Err(transfer::TransferError::Cancelled) => ACCESS_ENDED_TAG,
                    Err(transfer::TransferError::EntryExists { .. }) => "TransferEntryExistsError",
                    Err(transfer::TransferError::UploadTooLarge { .. }) => "TransferTooLargeError",
                    Err(_) => "TransferFailedError",
                };
                finish.record(outcome).await;
            }
            drop(cancellation);
            match written {
                Ok(written) => {
                    on_uploaded(canonical_root.clone()).await;
                    let relative = written
                        .strip_prefix(&canonical_root)
                        .map(paths::to_posix)
                        .unwrap_or_else(|_| file_name.clone());
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
                // The agent's access ended, or a folder on the path changed into a symlink:
                // nothing was written, and the route confirms nothing about the path.
                Err(transfer::TransferError::Cancelled | transfer::TransferError::Workspace(_)) => {
                    Err(not_found())
                }
                // The mint validates the name, so this is only reachable if a token outlived a
                // change to the rules. It is still the client's name, not a server fault.
                Err(transfer::TransferError::InvalidFileName { .. }) => {
                    Err(bad_request(&transfer::upload::upload_file_name_rule()))
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
            "_tag": NOT_FOUND_TAG,
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
