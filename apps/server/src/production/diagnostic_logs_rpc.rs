//! `server.downloadDiagnosticLogs` (#194): this server's redacted diagnostic bundle over the
//! client's own RPC connection, so a remote environment's logs reach the client inside the
//! channel it already uses (E2EE included) instead of a primary-only HTTP route.
//!
//! The stream sends one `Started` item (file name, size, manifest), then the archive as
//! base64 `Data` items of at most [`DIAGNOSTIC_LOGS_CHUNK_BYTES`], then completes. A stream has
//! one chunk in flight until the client acknowledges it, so the client paces the download and
//! the connection's other traffic goes out between items.
//!
//! The archive keeps one of the server's few archive slots until the stream ends (see
//! `diagnostic_bundle`), and a client that takes no item for [`ITEM_ACK_DEADLINE`] ends its
//! request, so a client that stops acknowledging cannot pin archives in memory.

use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio::sync::mpsc::{self, error::SendTimeoutError};
use tokio_util::sync::CancellationToken;

use crate::{
    diagnostic_bundle::{DiagnosticBundleService, MAX_DIAGNOSTIC_ARCHIVE_BYTES},
    production::http_routes::MAX_DIAGNOSTIC_BODY_BYTES,
    rpc::{RpcRegistry, RpcSessionContext, RpcStreamChunk},
};

pub const DIAGNOSTIC_LOGS_METHOD: &str = "server.downloadDiagnosticLogs";
const OPERATE_SCOPE: &str = "orchestration:operate";
/// Archive bytes per `Data` item (about 87 KiB encoded, so each still rides alone in its
/// chunk). Small enough that a slow but working link moves an item well within
/// [`ITEM_ACK_DEADLINE`]: the deadline only ends links slower than about 1 KiB/s.
pub const DIAGNOSTIC_LOGS_CHUNK_BYTES: usize = 64 * 1024;
/// How long one item may wait for the client to take the one before it. The session sends the
/// next item only after the client acknowledges the last, so a wait this long means the client
/// stopped acknowledging (or its link carries under about 1 KiB/s); the request then ends and
/// its archive is released.
const ITEM_ACK_DEADLINE: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DownloadInput {
    frontend_log: String,
    #[serde(default)]
    include_crash_dumps: bool,
}

pub fn register_diagnostic_logs_rpc(registry: &mut RpcRegistry, bundles: DiagnosticBundleService) {
    registry.register_stream_with_context(
        DIAGNOSTIC_LOGS_METHOD,
        move |request, context, cancellation| {
            stream_bundle(
                bundles.clone(),
                request.payload,
                context,
                cancellation,
                MAX_DIAGNOSTIC_ARCHIVE_BYTES,
            )
        },
    );
}

/// Starts the producer. Capacity 1: the server holds the archive plus at most the item queued
/// here and the one the session is sending.
fn stream_bundle(
    bundles: DiagnosticBundleService,
    payload: Value,
    context: RpcSessionContext,
    cancellation: CancellationToken,
    max_archive_bytes: usize,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(1);
    tokio::spawn(async move {
        tokio::select! {
            biased;
            // An interrupt, a lost connection, or the request ending. A build already on its
            // blocking thread finishes there, holding its build permit until it does.
            () = cancellation.cancelled() => {}
            () = produce(
                &bundles,
                payload,
                &context,
                &sender,
                &cancellation,
                max_archive_bytes,
            ) => {}
        }
    });
    receiver
}

async fn produce(
    bundles: &DiagnosticBundleService,
    payload: Value,
    context: &RpcSessionContext,
    sender: &mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
    max_archive_bytes: usize,
) {
    let input: DownloadInput = match serde_json::from_value(payload) {
        Ok(input) => input,
        Err(error) => {
            let _ = sender
                .send(Err(diagnostic_logs_error("invalid", error.to_string())))
                .await;
            return;
        }
    };
    // The HTTP route's body bound: a client bounds its snapshot to it before sending.
    if input.frontend_log.len() > MAX_DIAGNOSTIC_BODY_BYTES {
        let _ = sender
            .send(Err(diagnostic_logs_error(
                "invalid",
                format!("frontendLog is over {MAX_DIAGNOSTIC_BODY_BYTES} bytes."),
            )))
            .await;
        return;
    }
    // Dumps are raw process memory, unlike the redacted logs `orchestration:read` covers, so
    // they take the scope of running commands, of the same credential, as on the HTTP route.
    if input.include_crash_dumps
        && let Err(refusal) = context.authorize_scope(OPERATE_SCOPE).await
    {
        let _ = sender.send(Err(refusal)).await;
        return;
    }
    let bundle = match bundles
        .build(
            input.frontend_log,
            input.include_crash_dumps,
            OffsetDateTime::now_utc(),
        )
        .await
    {
        Ok(bundle) => bundle,
        Err(error) => {
            tracing::warn!(%error, "diagnostic logs bundle failed");
            let _ = sender
                .send(Err(diagnostic_logs_error(
                    "build-failed",
                    "The server could not prepare its diagnostic logs.".to_owned(),
                )))
                .await;
            return;
        }
    };
    if bundle.bytes.len() > max_archive_bytes {
        let _ = sender
            .send(Err(diagnostic_logs_error(
                "too-large",
                format!(
                    "The diagnostic archive is {} bytes, over the {max_archive_bytes}-byte limit.",
                    bundle.bytes.len()
                ),
            )))
            .await;
        return;
    }
    let started = json!({
        "_tag": "Started",
        "fileName": bundle.filename,
        "byteLength": bundle.bytes.len(),
        "manifest": bundle.manifest,
    });
    if !send_item(sender, cancellation, started).await {
        return;
    }
    for chunk in bundle.bytes.chunks(DIAGNOSTIC_LOGS_CHUNK_BYTES) {
        let data = json!({ "_tag": "Data", "data": STANDARD.encode(chunk) });
        if !send_item(sender, cancellation, data).await {
            return;
        }
    }
    // `bundle`, and with it the archive's slot, is released here, after the last item.
}

/// Queues `item` behind the one the session is sending; `false` once the stream is over. An
/// item the session does not take within [`ITEM_ACK_DEADLINE`] ends the request: cancelling
/// it makes the session interrupt the stream and drop what it still holds.
async fn send_item(
    sender: &mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
    item: Value,
) -> bool {
    match sender.send_timeout(Ok(vec![item]), ITEM_ACK_DEADLINE).await {
        Ok(()) => true,
        Err(SendTimeoutError::Timeout(_)) => {
            tracing::warn!(
                method = DIAGNOSTIC_LOGS_METHOD,
                "diagnostic logs download stopped: the client acknowledged nothing for 60 s"
            );
            cancellation.cancel();
            false
        }
        Err(SendTimeoutError::Closed(_)) => false,
    }
}

fn diagnostic_logs_error(reason: &'static str, message: String) -> Value {
    json!({ "_tag": "DiagnosticLogsError", "reason": reason, "message": message })
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

    use super::*;
    use crate::diagnostic_bundle::DiagnosticBundleIdentity;

    fn bundles(logs: &std::path::Path) -> DiagnosticBundleService {
        DiagnosticBundleService::new(
            logs,
            DiagnosticBundleIdentity {
                environment_id: "local".to_owned(),
                storage_instance_id: Some("storage-remote".to_owned()),
                label: "Remote Box".to_owned(),
                server_version: "1.2.3".to_owned(),
            },
        )
    }

    /// Random letters compress to about 60 %, so the archive spans several `Data` items.
    fn write_noisy_server_log(logs: &std::path::Path) {
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let text: String = (0..3 * DIAGNOSTIC_LOGS_CHUNK_BYTES)
            .map(|index| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                if index % 100 == 99 {
                    '\n'
                } else {
                    char::from(b'a' + (state % 26) as u8)
                }
            })
            .collect();
        std::fs::write(logs.join("server.log"), text).expect("server log");
    }

    async fn collect(mut receiver: mpsc::Receiver<RpcStreamChunk>) -> Result<Vec<Value>, Value> {
        let mut items = Vec::new();
        while let Some(chunk) = receiver.recv().await {
            items.extend(chunk?);
        }
        Ok(items)
    }

    #[tokio::test]
    async fn streams_the_archive_in_bounded_items_after_its_manifest() {
        let logs = tempfile::tempdir().expect("logs");
        write_noisy_server_log(logs.path());

        let items = collect(stream_bundle(
            bundles(logs.path()),
            json!({ "frontendLog": "client warning\n" }),
            RpcSessionContext::unauthenticated(),
            CancellationToken::new(),
            MAX_DIAGNOSTIC_ARCHIVE_BYTES,
        ))
        .await
        .expect("stream succeeds");

        let started = &items[0];
        assert_eq!(started["_tag"], "Started");
        assert!(
            started["fileName"]
                .as_str()
                .expect("file name")
                .starts_with("bibcode-diagnostics-remote-box-")
        );
        assert_eq!(started["manifest"]["storageInstanceId"], "storage-remote");
        assert_eq!(started["manifest"]["serverVersion"], "1.2.3");
        let mut archive = Vec::new();
        for item in &items[1..] {
            assert_eq!(item["_tag"], "Data");
            let bytes = STANDARD
                .decode(item["data"].as_str().expect("data"))
                .expect("base64");
            assert!(bytes.len() <= DIAGNOSTIC_LOGS_CHUNK_BYTES);
            archive.extend(bytes);
        }
        assert!(items.len() > 2, "the archive spans more than one item");
        assert_eq!(started["byteLength"].as_u64(), Some(archive.len() as u64));
        let mut zip = zip::ZipArchive::new(Cursor::new(archive)).expect("zip");
        let mut frontend = String::new();
        zip.by_name("frontend.log")
            .expect("frontend log")
            .read_to_string(&mut frontend)
            .expect("frontend text");
        assert_eq!(frontend, "client warning\n");
        assert!(zip.by_name("manifest.json").is_ok());
    }

    #[tokio::test]
    async fn an_archive_over_the_limit_fails_before_anything_is_sent() {
        let logs = tempfile::tempdir().expect("logs");
        let items = collect(stream_bundle(
            bundles(logs.path()),
            json!({ "frontendLog": "" }),
            RpcSessionContext::unauthenticated(),
            CancellationToken::new(),
            16,
        ))
        .await;
        let error = items.expect_err("too large");
        assert_eq!(error["_tag"], "DiagnosticLogsError");
        assert_eq!(error["reason"], "too-large");
    }

    #[tokio::test]
    async fn an_invalid_request_fails_with_a_typed_error() {
        let logs = tempfile::tempdir().expect("logs");
        let error = collect(stream_bundle(
            bundles(logs.path()),
            json!({ "frontendLog": "", "includeCrashDumps": "yes" }),
            RpcSessionContext::unauthenticated(),
            CancellationToken::new(),
            MAX_DIAGNOSTIC_ARCHIVE_BYTES,
        ))
        .await
        .expect_err("invalid");
        assert_eq!(error["reason"], "invalid");
    }

    #[tokio::test]
    async fn a_frontend_log_over_the_http_bound_is_invalid() {
        let logs = tempfile::tempdir().expect("logs");
        let error = collect(stream_bundle(
            bundles(logs.path()),
            json!({ "frontendLog": "x".repeat(MAX_DIAGNOSTIC_BODY_BYTES + 1) }),
            RpcSessionContext::unauthenticated(),
            CancellationToken::new(),
            MAX_DIAGNOSTIC_ARCHIVE_BYTES,
        ))
        .await
        .expect_err("too long");
        assert_eq!(error["reason"], "invalid");
    }

    /// The archive keeps its slot while it streams, and a client that stops acknowledging
    /// ends the request at the deadline, which gives the slot back.
    #[tokio::test(start_paused = true)]
    async fn a_client_that_stops_acknowledging_releases_the_archive_at_the_deadline() {
        let logs = tempfile::tempdir().expect("logs");
        write_noisy_server_log(logs.path());
        let service = bundles(logs.path());
        let cancellation = CancellationToken::new();
        let mut receiver = stream_bundle(
            service.clone(),
            json!({ "frontendLog": "" }),
            RpcSessionContext::unauthenticated(),
            cancellation.clone(),
            MAX_DIAGNOSTIC_ARCHIVE_BYTES,
        );
        // Started arrives; the client then never takes the next item.
        let started = receiver.recv().await.expect("started").expect("ok");
        assert_eq!(started[0]["_tag"], "Started");
        tokio::task::yield_now().await;
        assert_eq!(service.free_slots_for_test(), 1, "held while streaming");

        tokio::time::timeout(ITEM_ACK_DEADLINE * 2, cancellation.cancelled())
            .await
            .expect("the deadline ends the request");
        for _ in 0..10 {
            if service.free_slots_for_test() == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            service.free_slots_for_test(),
            2,
            "released after the deadline"
        );
        drop(receiver);
    }

    #[tokio::test]
    async fn cancellation_ends_the_stream_without_its_items() {
        let logs = tempfile::tempdir().expect("logs");
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let items = collect(stream_bundle(
            bundles(logs.path()),
            json!({ "frontendLog": "" }),
            RpcSessionContext::unauthenticated(),
            cancellation,
            MAX_DIAGNOSTIC_ARCHIVE_BYTES,
        ))
        .await
        .expect("a cancelled stream just ends");
        assert!(items.is_empty());
    }
}
