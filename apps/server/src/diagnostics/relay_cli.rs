//! `bibcode diagnostics download` (#201): saves a connected environment's diagnostic bundle
//! through the BiBCode desktop app on this computer, once the user approves the request
//! there. The app holds every remote connection, so this command never connects to the
//! environment itself: it asks this host's server (found through the endpoint file in the
//! state directory), which hands the request to the app and the archive back. See
//! `production::diagnostic_logs_relay` for the server's side.
//!
//! The archive is checked before anything is written: its name has the download's shape,
//! its length is the declared one within the 20 MiB bound, every item is at most 64 KiB, and
//! the `manifest.json` inside names the same environment and store as the manifest the app
//! sent. It is then written to a new file, never over an existing one.

use std::{
    io::{self, Cursor, Read as _, Write as _},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use clap::{Args, Subcommand};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    diagnostic_bundle::MAX_DIAGNOSTIC_ARCHIVE_BYTES,
    production::{
        diagnostic_logs_relay::{RELAY_ENDPOINT_FILE, RELAY_PATH, is_archive_name},
        diagnostic_logs_rpc::DIAGNOSTIC_LOGS_CHUNK_BYTES,
    },
};

/// The longest response line: a `Data` item's base64 plus its envelope, or a manifest.
const MAX_LINE_BYTES: usize = 256 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Args)]
pub struct DiagnosticsArgs {
    #[command(subcommand)]
    pub command: DiagnosticsSubcommand,
}

#[derive(Clone, Debug, Subcommand)]
pub enum DiagnosticsSubcommand {
    /// Save a connected environment's diagnostic logs through the BiBCode desktop app on this
    /// computer, after you approve the request there.
    Download {
        /// The environment: its id or its name in BiBCode. A name BiBCode does not know fails
        /// with the list of environments it can reach.
        #[arg(long)]
        environment: String,
        /// Also ask for crash dumps, which can hold fragments of memory.
        #[arg(long)]
        include_crash_dumps: bool,
        /// The directory to save the archive in; the current one by default. An existing
        /// file is never replaced.
        #[arg(long, value_name = "DIR")]
        output: Option<PathBuf>,
        /// Print one JSON document, whatever the outcome.
        #[arg(long)]
        json: bool,
    },
}

/// How the command ended, and its exit code.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Saved {
        path: PathBuf,
        file_name: String,
        byte_length: u64,
        manifest: Value,
    },
    /// The app or the relay refused or failed: `reason` and `message` from it.
    Failed {
        reason: String,
        message: String,
        environments: Option<Value>,
    },
    /// The user said no, or nobody answered.
    Denied { reason: String, message: String },
    /// No server, or no desktop app, to ask.
    Unavailable { reason: String, message: String },
}

impl Outcome {
    #[must_use]
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Saved { .. } => 0,
            Self::Failed { .. } => 1,
            Self::Denied { .. } => 2,
            Self::Unavailable { .. } => 3,
        }
    }

    fn failed(reason: &str, message: impl Into<String>) -> Self {
        Self::Failed {
            reason: reason.to_owned(),
            message: message.into(),
            environments: None,
        }
    }

    fn unavailable(reason: &str, message: impl Into<String>) -> Self {
        Self::Unavailable {
            reason: reason.to_owned(),
            message: message.into(),
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            Self::Saved {
                path,
                file_name,
                byte_length,
                manifest,
            } => json!({
                "status": "saved",
                "path": path,
                "fileName": file_name,
                "byteLength": byte_length,
                "manifest": manifest,
            }),
            Self::Failed {
                reason,
                message,
                environments,
            } => {
                let mut document =
                    json!({ "status": "failed", "reason": reason, "message": message });
                if let Some(environments) = environments {
                    document["environments"] = environments.clone();
                }
                document
            }
            Self::Denied { reason, message } => {
                json!({ "status": "denied", "reason": reason, "message": message })
            }
            Self::Unavailable { reason, message } => {
                json!({ "status": "unavailable", "reason": reason, "message": message })
            }
        }
    }
}

#[derive(Deserialize)]
struct EndpointFile {
    version: u32,
    url: String,
    token: String,
}

/// The server's endpoint file under `state_dir`; `Err` names why the command cannot ask it.
fn read_endpoint(state_dir: &Path) -> Result<EndpointFile, Outcome> {
    let path = state_dir.join(RELAY_ENDPOINT_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(Outcome::unavailable(
                "not-running",
                format!(
                    "BiBCode is not running for {}: start the desktop app, then try again.",
                    state_dir.display()
                ),
            ));
        }
        Err(error) => {
            return Err(Outcome::unavailable(
                "not-running",
                format!("Could not read {}: {error}", path.display()),
            ));
        }
    };
    match serde_json::from_slice::<EndpointFile>(&bytes) {
        Ok(endpoint) if endpoint.version == 1 && endpoint.url.starts_with("http://") => {
            Ok(endpoint)
        }
        _ => Err(Outcome::unavailable(
            "not-running",
            format!("{} is not one this BiBCode understands.", path.display()),
        )),
    }
}

/// The archive being received, checked line by line.
struct Receiving {
    file_name: String,
    manifest: Value,
    expected: usize,
    bytes: Vec<u8>,
}

/// Saves `bytes` as a new `directory/file_name`, never over an existing file; a failed write
/// leaves nothing behind.
fn save_new(directory: &Path, file_name: &str, bytes: &[u8]) -> Result<PathBuf, Outcome> {
    if !is_archive_name(file_name) {
        return Err(Outcome::failed(
            "invalid",
            "BiBCode sent an archive name that is not a diagnostics archive. Nothing was saved.",
        ));
    }
    let path = directory.join(file_name);
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err(Outcome::failed(
                "exists",
                format!(
                    "{} already exists. Nothing was replaced; move it or pass another --output.",
                    path.display()
                ),
            ));
        }
        Err(error) => {
            return Err(Outcome::failed(
                "write-failed",
                format!("Could not create {}: {error}", path.display()),
            ));
        }
    };
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(Outcome::failed(
            "write-failed",
            format!("Could not write {}: {error}", path.display()),
        ));
    }
    Ok(path)
}

/// The archive's own `manifest.json` names the environment and store the app's manifest
/// does: what was saved is what the app checked against its connection.
fn archive_matches_manifest(bytes: &[u8], manifest: &Value) -> bool {
    let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(bytes)) else {
        return false;
    };
    let Ok(entry) = archive.by_name("manifest.json") else {
        return false;
    };
    let mut text = String::new();
    if entry.take(64 * 1024).read_to_string(&mut text).is_err() {
        return false;
    }
    let Ok(inner) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    ["environmentId", "storageInstanceId", "serverVersion"]
        .iter()
        .all(|key| inner.get(key) == manifest.get(key))
}

/// Applies one response line. `Ok(Some)` ends the command.
fn accept_line(
    line: &[u8],
    receiving: &mut Option<Receiving>,
    output: &Path,
    on_waiting: &mut (dyn FnMut() + Send),
) -> Result<Option<Outcome>, Outcome> {
    let protocol = || {
        Outcome::failed(
            "protocol",
            "BiBCode sent a reply this command does not understand. Nothing was saved.",
        )
    };
    let line: Value = serde_json::from_slice(line).map_err(|_| protocol())?;
    let text = |key: &str| {
        line.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    match line.get("type").and_then(Value::as_str) {
        Some("waiting") => {
            on_waiting();
            Ok(None)
        }
        Some("started") if receiving.is_none() => {
            let file_name = text("fileName");
            let byte_length = line
                .get("byteLength")
                .and_then(Value::as_u64)
                .and_then(|length| usize::try_from(length).ok())
                .ok_or_else(protocol)?;
            if !is_archive_name(&file_name) {
                return Err(Outcome::failed(
                    "invalid",
                    "BiBCode sent an archive name that is not a diagnostics archive. Nothing was saved.",
                ));
            }
            if byte_length > MAX_DIAGNOSTIC_ARCHIVE_BYTES {
                return Err(Outcome::failed(
                    "too-large",
                    "The archive is over the 20 MiB limit. Nothing was saved.",
                ));
            }
            let manifest = line
                .get("manifest")
                .cloned()
                .filter(Value::is_object)
                .ok_or_else(protocol)?;
            *receiving = Some(Receiving {
                file_name,
                manifest,
                expected: byte_length,
                bytes: Vec::with_capacity(byte_length),
            });
            Ok(None)
        }
        Some("data") => {
            let receiving = receiving.as_mut().ok_or_else(protocol)?;
            let data = STANDARD.decode(text("data")).map_err(|_| protocol())?;
            if data.is_empty()
                || data.len() > DIAGNOSTIC_LOGS_CHUNK_BYTES
                || receiving.bytes.len() + data.len() > receiving.expected
            {
                return Err(Outcome::failed(
                    "incomplete",
                    "BiBCode sent more than the archive it announced. Nothing was saved.",
                ));
            }
            receiving.bytes.extend_from_slice(&data);
            Ok(None)
        }
        Some("finished") => {
            let Some(received) = receiving.take() else {
                return Err(protocol());
            };
            if received.bytes.len() != received.expected {
                return Err(Outcome::failed(
                    "incomplete",
                    "The archive arrived incomplete. Nothing was saved.",
                ));
            }
            if !archive_matches_manifest(&received.bytes, &received.manifest) {
                return Err(Outcome::failed(
                    "wrong-environment",
                    "The archive's manifest does not match the environment BiBCode checked. Nothing was saved.",
                ));
            }
            let path = save_new(output, &received.file_name, &received.bytes)?;
            let path = std::fs::canonicalize(&path).unwrap_or(path);
            Ok(Some(Outcome::Saved {
                path,
                file_name: received.file_name,
                byte_length: received.expected as u64,
                manifest: received.manifest,
            }))
        }
        Some("denied") => Ok(Some(Outcome::Denied {
            reason: "denied".to_owned(),
            message: "The request was denied in BiBCode.".to_owned(),
        })),
        Some("failed") => Ok(Some(Outcome::Failed {
            reason: text("reason"),
            message: text("message"),
            environments: line.get("environments").cloned(),
        })),
        Some("ended") => {
            let reason = text("reason");
            let message = text("message");
            Ok(Some(match reason.as_str() {
                "expired" => Outcome::Denied { reason, message },
                "no-app" | "busy" => Outcome::Unavailable { reason, message },
                _ => Outcome::Failed {
                    reason,
                    message,
                    environments: None,
                },
            }))
        }
        _ => Err(protocol()),
    }
}

/// Asks the server named in `state_dir`'s endpoint file for `environment`'s logs and saves
/// them under `output`. `on_waiting` runs once the request waits for approval.
pub async fn download(
    state_dir: &Path,
    environment: &str,
    include_crash_dumps: bool,
    output: &Path,
    on_waiting: &mut (dyn FnMut() + Send),
) -> Outcome {
    if !output.is_dir() {
        return Outcome::failed(
            "invalid",
            format!("{} is not a directory.", output.display()),
        );
    }
    let endpoint = match read_endpoint(state_dir) {
        Ok(endpoint) => endpoint,
        Err(outcome) => return outcome,
    };
    let client = match reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return Outcome::failed("client", format!("Could not start an HTTP client: {error}"));
        }
    };
    let response = client
        .post(format!(
            "{}{RELAY_PATH}",
            endpoint.url.trim_end_matches('/')
        ))
        .bearer_auth(&endpoint.token)
        .json(&json!({ "environment": environment, "includeCrashDumps": include_crash_dumps }))
        .send()
        .await;
    let mut response = match response {
        Ok(response) => response,
        Err(error) if error.is_connect() => {
            return Outcome::unavailable(
                "not-running",
                "BiBCode is not running: its server did not answer. Start the desktop app, then try again.",
            );
        }
        Err(error) => {
            return Outcome::failed(
                "connection-lost",
                format!("Could not reach BiBCode: {error}"),
            );
        }
    };
    let status = response.status();
    if !status.is_success() {
        let message = response
            .json::<Value>()
            .await
            .ok()
            .and_then(|body| body["message"].as_str().map(str::to_owned))
            .unwrap_or_else(|| format!("BiBCode answered {status}."));
        return if status == reqwest::StatusCode::UNAUTHORIZED {
            Outcome::unavailable(
                "not-running",
                format!("{message} Is BiBCode running for {}?", state_dir.display()),
            )
        } else {
            Outcome::failed("refused", message)
        };
    }
    let mut buffer = Vec::new();
    let mut receiving = None;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => {
                return Outcome::failed(
                    "connection-lost",
                    "The connection to BiBCode ended before the logs arrived. Nothing was saved.",
                );
            }
            Err(error) => {
                return Outcome::failed(
                    "connection-lost",
                    format!("The connection to BiBCode was lost: {error}. Nothing was saved."),
                );
            }
        };
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            match accept_line(&line[..line.len() - 1], &mut receiving, output, on_waiting) {
                Ok(None) => {}
                Ok(Some(outcome)) | Err(outcome) => return outcome,
            }
        }
        if buffer.len() > MAX_LINE_BYTES {
            return Outcome::failed(
                "protocol",
                "BiBCode sent a reply line over the size limit. Nothing was saved.",
            );
        }
    }
}

fn print_text(outcome: &Outcome) {
    match outcome {
        Outcome::Saved { path, manifest, .. } => {
            println!("Saved {}", path.display());
            let field = |key: &str| {
                manifest
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            };
            println!(
                "  {} (store {}), server {}",
                field("environmentLabel"),
                field("storageInstanceId"),
                field("serverVersion")
            );
        }
        Outcome::Failed {
            message,
            environments,
            ..
        } => {
            eprintln!("bibcode: {message}");
            if let Some(environments) = environments.as_ref().and_then(Value::as_array) {
                eprintln!("Environments BiBCode can reach:");
                for environment in environments {
                    let id = environment["environmentId"].as_str().unwrap_or_default();
                    let label = environment["label"].as_str().unwrap_or_default();
                    let state = if environment["connected"] == true {
                        ""
                    } else {
                        " (not connected)"
                    };
                    eprintln!("  {label}  --environment {id}{state}");
                }
            }
        }
        Outcome::Denied { message, .. } | Outcome::Unavailable { message, .. } => {
            eprintln!("bibcode: {message}");
        }
    }
}

/// Runs a `diagnostics` command against the server for `state_dir` and returns the exit code.
pub async fn run_diagnostics_cli(args: DiagnosticsArgs, state_dir: PathBuf) -> i32 {
    let DiagnosticsSubcommand::Download {
        environment,
        include_crash_dumps,
        output,
        json,
    } = args.command;
    let output = output.unwrap_or_else(|| PathBuf::from("."));
    let mut on_waiting = || {
        eprintln!("Waiting for approval in BiBCode…");
    };
    let outcome = download(
        &state_dir,
        &environment,
        include_crash_dumps,
        &output,
        &mut on_waiting,
    )
    .await;
    if json {
        println!("{}", outcome.to_json());
    } else {
        print_text(&outcome);
    }
    let _ = io::stdout().flush();
    outcome.exit_code()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_with_manifest(manifest: &Value) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(&mut cursor);
        writer
            .start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .expect("entry");
        writer
            .write_all(manifest.to_string().as_bytes())
            .expect("manifest");
        writer.finish().expect("zip");
        cursor.into_inner()
    }

    fn manifest() -> Value {
        json!({
            "schemaVersion": 1,
            "environmentId": "local",
            "storageInstanceId": "storage-omarchy",
            "environmentLabel": "Omarchy",
            "serverVersion": "0.12.0",
        })
    }

    fn lines_for(archive: &[u8], file_name: &str, manifest: &Value) -> Vec<Vec<u8>> {
        let mut lines = vec![
            json!({ "type": "waiting" }),
            json!({ "type": "started", "fileName": file_name, "byteLength": archive.len(), "manifest": manifest }),
        ];
        for chunk in archive.chunks(DIAGNOSTIC_LOGS_CHUNK_BYTES) {
            lines.push(json!({ "type": "data", "data": STANDARD.encode(chunk) }));
        }
        lines.push(json!({ "type": "finished" }));
        lines
            .into_iter()
            .map(|line| line.to_string().into_bytes())
            .collect()
    }

    fn run(lines: &[Vec<u8>], output: &Path) -> Result<Option<Outcome>, Outcome> {
        let mut receiving = None;
        let mut waited = false;
        for line in lines {
            if let Some(outcome) = accept_line(line, &mut receiving, output, &mut || waited = true)?
            {
                return Ok(Some(outcome));
            }
        }
        assert!(waited);
        Ok(None)
    }

    #[test]
    fn saves_a_checked_archive_as_a_new_file() {
        let output = tempfile::tempdir().expect("output");
        let archive = zip_with_manifest(&manifest());
        let outcome = run(
            &lines_for(&archive, "bibcode-diagnostics-omarchy.zip", &manifest()),
            output.path(),
        )
        .expect("saved")
        .expect("outcome");
        let Outcome::Saved { path, .. } = outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(std::fs::read(&path).expect("saved file"), archive);
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("bibcode-diagnostics-omarchy.zip")
        );
    }

    #[test]
    fn never_overwrites_an_existing_file() {
        let output = tempfile::tempdir().expect("output");
        let existing = output.path().join("bibcode-diagnostics-omarchy.zip");
        std::fs::write(&existing, b"keep me").expect("existing");
        let archive = zip_with_manifest(&manifest());
        let outcome = run(
            &lines_for(&archive, "bibcode-diagnostics-omarchy.zip", &manifest()),
            output.path(),
        )
        .expect_err("collision");
        assert!(
            matches!(&outcome, Outcome::Failed { reason, .. } if reason == "exists"),
            "{outcome:?}"
        );
        assert_eq!(std::fs::read(&existing).expect("existing"), b"keep me");
    }

    #[test]
    fn refuses_forged_archive_names_before_writing() {
        let output = tempfile::tempdir().expect("output");
        let archive = zip_with_manifest(&manifest());
        for forged in [
            "../escape.zip",
            "nested/escape.zip",
            "..\\escape.zip",
            "/tmp/escape.zip",
            ".hidden.zip",
            "logs.exe",
        ] {
            let outcome =
                run(&lines_for(&archive, forged, &manifest()), output.path()).expect_err(forged);
            assert!(
                matches!(&outcome, Outcome::Failed { reason, .. } if reason == "invalid"),
                "{forged}: {outcome:?}"
            );
        }
        assert_eq!(
            std::fs::read_dir(output.path()).expect("dir").count(),
            0,
            "nothing written"
        );
        assert!(
            !output
                .path()
                .parent()
                .expect("parent")
                .join("escape.zip")
                .exists()
        );
    }

    #[test]
    fn refuses_byte_counts_that_disagree_with_the_announcement() {
        let output = tempfile::tempdir().expect("output");
        let archive = zip_with_manifest(&manifest());
        // One byte fewer announced than sent.
        let mut lines = lines_for(&archive, "logs.zip", &manifest());
        lines[1] = json!({ "type": "started", "fileName": "logs.zip", "byteLength": archive.len() - 1, "manifest": manifest() }).to_string().into_bytes();
        let outcome = run(&lines, output.path()).expect_err("over");
        assert!(matches!(&outcome, Outcome::Failed { reason, .. } if reason == "incomplete"));
        // Finished before the last item.
        let mut lines = lines_for(&archive, "logs.zip", &manifest());
        lines.remove(lines.len() - 2);
        let outcome = run(&lines, output.path()).expect_err("short");
        assert!(matches!(&outcome, Outcome::Failed { reason, .. } if reason == "incomplete"));
        // Over the archive bound.
        let line = json!({ "type": "started", "fileName": "logs.zip", "byteLength": MAX_DIAGNOSTIC_ARCHIVE_BYTES + 1, "manifest": manifest() }).to_string().into_bytes();
        let outcome = run(
            &[json!({ "type": "waiting" }).to_string().into_bytes(), line],
            output.path(),
        )
        .expect_err("too large");
        assert!(matches!(&outcome, Outcome::Failed { reason, .. } if reason == "too-large"));
        assert_eq!(std::fs::read_dir(output.path()).expect("dir").count(), 0);
    }

    #[test]
    fn refuses_an_archive_whose_manifest_names_another_store() {
        let output = tempfile::tempdir().expect("output");
        let mut inner = manifest();
        inner["storageInstanceId"] = json!("storage-elsewhere");
        let archive = zip_with_manifest(&inner);
        let outcome = run(&lines_for(&archive, "logs.zip", &manifest()), output.path())
            .expect_err("mismatch");
        assert!(
            matches!(&outcome, Outcome::Failed { reason, .. } if reason == "wrong-environment")
        );
        assert_eq!(std::fs::read_dir(output.path()).expect("dir").count(), 0);
    }

    #[test]
    fn maps_answers_to_exit_codes() {
        let output = tempfile::tempdir().expect("output");
        let answer = |line: Value| {
            run(
                &[
                    json!({ "type": "waiting" }).to_string().into_bytes(),
                    line.to_string().into_bytes(),
                ],
                output.path(),
            )
            .expect("answer")
            .expect("outcome")
        };
        assert_eq!(answer(json!({ "type": "denied" })).exit_code(), 2);
        assert_eq!(
            answer(json!({ "type": "ended", "reason": "expired", "message": "m" })).exit_code(),
            2
        );
        assert_eq!(
            answer(json!({ "type": "ended", "reason": "no-app", "message": "m" })).exit_code(),
            3
        );
        assert_eq!(
            answer(json!({ "type": "ended", "reason": "connection-lost", "message": "m" }))
                .exit_code(),
            1
        );
        let failed = answer(json!({
            "type": "failed",
            "reason": "unknown-environment",
            "message": "No environment is named Mars.",
            "environments": [{ "environmentId": "remote:1", "label": "Omarchy", "connected": true }],
        }));
        assert_eq!(failed.exit_code(), 1);
        assert_eq!(failed.to_json()["environments"][0]["label"], "Omarchy");
    }

    #[tokio::test]
    async fn without_an_endpoint_file_it_says_bibcode_is_not_running() {
        let state = tempfile::tempdir().expect("state");
        let output = tempfile::tempdir().expect("output");
        let outcome = download(state.path(), "Omarchy", false, output.path(), &mut || {}).await;
        assert!(matches!(&outcome, Outcome::Unavailable { reason, .. } if reason == "not-running"));
        assert_eq!(outcome.exit_code(), 3);
    }
}
