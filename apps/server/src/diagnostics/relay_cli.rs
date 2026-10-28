//! `bibcode diagnostics download` (#201): saves a connected environment's diagnostic bundle
//! through the BiBCode desktop app on this computer, once the user approves the request
//! there. The app holds every remote connection, so this command never connects to the
//! environment itself: it asks this host's server (found through the endpoint file in the
//! state directory), which hands the request to the app and the archive back. See
//! `production::diagnostic_logs_relay` for the server's side.
//!
//! The command prints a short request code, which the app's prompt shows beside the
//! environment as typed and the directory the file goes to, so the user can tell their own
//! command from another program's. The archive is checked before anything is published: its
//! name has the download's shape, its length is the declared one within the 20 MiB bound,
//! every item is at most 64 KiB, and the `manifest.json` inside names the same non-empty
//! environment and store as the manifest the app sent. It is written and synced to a
//! temporary file beside the target, then published under its name without ever replacing
//! an existing file, so an interrupted run leaves no partial archive under that name.

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
        diagnostic_logs_relay::{
            APPROVAL_DEADLINE, RELAY_ENDPOINT_FILE, RELAY_PATH, START_DEADLINE, is_archive_name,
        },
        diagnostic_logs_rpc::DIAGNOSTIC_LOGS_CHUNK_BYTES,
    },
};

/// The longest response line: a `Data` item's base64 plus its envelope, or a manifest.
const MAX_LINE_BYTES: usize = 256 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the command waits for the archive to start: past the server's own approval
/// and start deadlines, so the server's answer normally arrives first.
const WAIT_FOR_START: Duration = APPROVAL_DEADLINE
    .saturating_add(START_DEADLINE)
    .saturating_add(Duration::from_secs(60));
/// How long the command waits for each line once the archive started.
const WAIT_BETWEEN_ITEMS: Duration = Duration::from_secs(90);
/// The request code alphabet: no 0/O or 1/I, so it reads back unambiguously.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

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
        /// The environment: its id or its name in BiBCode.
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
    Failed { reason: String, message: String },
    /// The user said no, nobody answered, or the last requests were turned down.
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
            Self::Failed { reason, message } => {
                json!({ "status": "failed", "reason": reason, "message": message })
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

/// `text` without control characters (escape sequences, carriage returns, bidi tricks
/// rendered as controls), which the app or a remote server could otherwise use to rewrite
/// what the terminal shows.
#[must_use]
pub fn printable(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_control())
        .collect()
}

/// A fresh request code, `XXX-XX`, from [`CODE_ALPHABET`].
pub fn new_request_code() -> io::Result<String> {
    let mut bytes = [0_u8; 5];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    let letters: Vec<char> = bytes
        .iter()
        .map(|byte| char::from(CODE_ALPHABET[usize::from(*byte) % CODE_ALPHABET.len()]))
        .collect();
    Ok(format!(
        "{}-{}",
        letters[..3].iter().collect::<String>(),
        letters[3..].iter().collect::<String>()
    ))
}

#[derive(Deserialize)]
struct EndpointFile {
    version: u32,
    url: String,
    token: String,
}

fn not_running(state_dir: &Path) -> String {
    format!(
        "BiBCode is not running for {}: start the desktop app, then try again. If BiBCode's \
         primary environment runs in WSL, run `bibcode diagnostics download` inside that \
         distro instead.",
        state_dir.display()
    )
}

/// The server's endpoint file under `state_dir`; `Err` names why the command cannot ask it.
/// Its URL must be a loopback address: the token is never sent anywhere else.
fn read_endpoint(state_dir: &Path) -> Result<(EndpointFile, reqwest::Url), Outcome> {
    let path = state_dir.join(RELAY_ENDPOINT_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(Outcome::unavailable("not-running", not_running(state_dir)));
        }
        Err(error) => {
            return Err(Outcome::unavailable(
                "not-running",
                format!("Could not read {}: {error}", path.display()),
            ));
        }
    };
    let Some(endpoint) = serde_json::from_slice::<EndpointFile>(&bytes)
        .ok()
        .filter(|endpoint| endpoint.version == 1)
    else {
        return Err(Outcome::unavailable(
            "not-running",
            format!("{} is not one this BiBCode understands.", path.display()),
        ));
    };
    let url = reqwest::Url::parse(&endpoint.url)
        .ok()
        .and_then(|url| url.join(RELAY_PATH).ok())
        .filter(|url| url.scheme() == "http" && is_loopback_host(url));
    match url {
        Some(url) => Ok((endpoint, url)),
        None => Err(Outcome::unavailable(
            "not-loopback",
            "This BiBCode server does not listen on this computer's loopback address, so the \
             command will not send it its token.",
        )),
    }
}

fn is_loopback_host(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// The archive being received, checked line by line.
struct Receiving {
    file_name: String,
    manifest: Value,
    expected: usize,
    bytes: Vec<u8>,
}

/// Publishes `bytes` as a new `directory/file_name`, never over an existing file: written
/// and synced to a temporary file beside it, then hard-linked under the name (which fails
/// if the name exists). A filesystem without hard links gets an exclusive create instead.
/// Any failure removes what this call wrote.
fn save_new(directory: &Path, file_name: &str, bytes: &[u8]) -> Result<PathBuf, Outcome> {
    if !is_archive_name(file_name) {
        return Err(Outcome::failed(
            "invalid",
            "BiBCode sent an archive name that is not a diagnostics archive. Nothing was saved.",
        ));
    }
    let path = directory.join(file_name);
    let exists = || {
        Outcome::failed(
            "exists",
            format!(
                "{} already exists. Nothing was replaced; move it or pass another --output.",
                path.display()
            ),
        )
    };
    let write_failed = |target: &Path, error: io::Error| {
        Outcome::failed(
            "write-failed",
            format!("Could not write {}: {error}", target.display()),
        )
    };
    if path.symlink_metadata().is_ok() {
        return Err(exists());
    }
    let suffix = new_request_code().map_err(|error| write_failed(&path, error))?;
    let temporary = directory.join(format!(".{file_name}.{suffix}.partial"));
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .and_then(|mut file| file.write_all(bytes).and_then(|()| file.sync_all()));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(write_failed(&temporary, error));
    }
    let published = match std::fs::hard_link(&temporary, &path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(exists()),
        // No hard links here (some network and FAT filesystems): an exclusive create.
        Err(_) => publish_by_copy(&path, bytes).map_err(|error| match error.kind() {
            io::ErrorKind::AlreadyExists => exists(),
            _ => write_failed(&path, error),
        }),
    };
    let _ = std::fs::remove_file(&temporary);
    published.map(|()| path)
}

fn publish_by_copy(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    if written.is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
    written
}

/// The archive's own `manifest.json` names the environment and store the app's manifest
/// does, and both are present and non-empty: what is saved is what the app checked against
/// its connection.
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
    let present = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    };
    ["environmentId", "storageInstanceId"]
        .iter()
        .all(|key| present(&inner, key) && present(manifest, key))
        && ["environmentId", "storageInstanceId", "serverVersion"]
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
    let text = |key: &str| printable(line.get(key).and_then(Value::as_str).unwrap_or_default());
    match line.get("type").and_then(Value::as_str) {
        Some("waiting") => {
            on_waiting();
            Ok(None)
        }
        Some("started") if receiving.is_none() => {
            let file_name = line
                .get("fileName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
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
                    "The archive's manifest does not name the environment BiBCode checked. Nothing was saved.",
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
        })),
        Some("ended") => {
            let reason = text("reason");
            let message = text("message");
            Ok(Some(match reason.as_str() {
                "expired" | "cooling-down" => Outcome::Denied { reason, message },
                "no-app" | "busy" => Outcome::Unavailable { reason, message },
                _ => Outcome::Failed { reason, message },
            }))
        }
        _ => Err(protocol()),
    }
}

/// What the command asks for.
pub struct DownloadRequest<'a> {
    pub environment: &'a str,
    pub include_crash_dumps: bool,
    pub output: &'a Path,
    /// The code the command printed; the app shows it in its prompt.
    pub code: &'a str,
}

/// Asks the server named in `state_dir`'s endpoint file for the request's logs and saves
/// them under its output directory. `on_waiting` runs once the request waits for approval.
pub async fn download(
    state_dir: &Path,
    request: &DownloadRequest<'_>,
    on_waiting: &mut (dyn FnMut() + Send),
) -> Outcome {
    let Ok(output) = std::fs::canonicalize(request.output) else {
        return Outcome::failed(
            "invalid",
            format!("{} is not a directory.", request.output.display()),
        );
    };
    if !output.is_dir() {
        return Outcome::failed(
            "invalid",
            format!("{} is not a directory.", output.display()),
        );
    }
    let (endpoint, url) = match read_endpoint(state_dir) {
        Ok(endpoint) => endpoint,
        Err(outcome) => return outcome,
    };
    let client = match reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return Outcome::failed("client", format!("Could not start an HTTP client: {error}"));
        }
    };
    let response = client
        .post(url)
        .bearer_auth(&endpoint.token)
        .json(&json!({
            "environment": request.environment,
            "includeCrashDumps": request.include_crash_dumps,
            "code": request.code,
            "outputDirectory": output.display().to_string(),
        }))
        .send()
        .await;
    let mut response = match response {
        Ok(response) => response,
        Err(error) if error.is_connect() => {
            return Outcome::unavailable("not-running", not_running(state_dir));
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
            .and_then(|body| body["message"].as_str().map(printable))
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
        let wait = if receiving.is_some() {
            WAIT_BETWEEN_ITEMS
        } else {
            WAIT_FOR_START
        };
        let chunk = match tokio::time::timeout(wait, response.chunk()).await {
            Err(_) => {
                return Outcome::failed("stalled", "BiBCode stopped answering. Nothing was saved.");
            }
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => {
                return Outcome::failed(
                    "connection-lost",
                    "The connection to BiBCode ended before the logs arrived. Nothing was saved.",
                );
            }
            Ok(Err(error)) => {
                return Outcome::failed(
                    "connection-lost",
                    format!("The connection to BiBCode was lost: {error}. Nothing was saved."),
                );
            }
        };
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            match accept_line(&line[..line.len() - 1], &mut receiving, &output, on_waiting) {
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
                printable(
                    manifest
                        .get(key)
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                )
            };
            println!(
                "  {} (store {}), server {}",
                field("environmentLabel"),
                field("storageInstanceId"),
                field("serverVersion")
            );
        }
        Outcome::Failed { message, .. }
        | Outcome::Denied { message, .. }
        | Outcome::Unavailable { message, .. } => {
            eprintln!("bibcode: {}", printable(message));
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
    let code = match new_request_code() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("bibcode: could not create a request code: {error}");
            return 1;
        }
    };
    let waiting_code = code.clone();
    let mut on_waiting = move || {
        eprintln!("Approve request {waiting_code} in BiBCode…");
    };
    let outcome = download(
        &state_dir,
        &DownloadRequest {
            environment: &environment,
            include_crash_dumps,
            output: &output,
            code: &code,
        },
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
    use crate::production::diagnostic_logs_relay::is_request_code;

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

    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(directory)
            .expect("dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }

    #[test]
    fn request_codes_have_the_shape_the_server_accepts() {
        for _ in 0..50 {
            let code = new_request_code().expect("code");
            assert!(is_request_code(&code), "{code}");
            assert!(!code.contains(['0', 'O', '1', 'I']), "{code}");
        }
    }

    #[test]
    fn saves_a_checked_archive_as_a_new_file_and_no_temporary() {
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
        assert_eq!(entries(output.path()), ["bibcode-diagnostics-omarchy.zip"]);
    }

    #[test]
    fn never_overwrites_an_existing_file_and_cleans_its_temporary() {
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
        assert_eq!(entries(output.path()), ["bibcode-diagnostics-omarchy.zip"]);
    }

    #[test]
    fn a_name_taken_after_the_check_is_still_never_replaced() {
        // The publish step itself refuses an existing name: link and exclusive create both
        // fail on it, so a file appearing between the check and the publish survives.
        let output = tempfile::tempdir().expect("output");
        let path = output.path().join("logs.zip");
        std::fs::write(&path, b"raced").expect("raced");
        let error = publish_by_copy(&path, b"new").expect_err("exists");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&path).expect("raced"), b"raced");
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
        assert!(entries(output.path()).is_empty(), "nothing written");
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
        let mut lines = lines_for(&archive, "logs.zip", &manifest());
        lines[1] = json!({ "type": "started", "fileName": "logs.zip", "byteLength": archive.len() - 1, "manifest": manifest() }).to_string().into_bytes();
        let outcome = run(&lines, output.path()).expect_err("over");
        assert!(matches!(&outcome, Outcome::Failed { reason, .. } if reason == "incomplete"));
        let mut lines = lines_for(&archive, "logs.zip", &manifest());
        lines.remove(lines.len() - 2);
        let outcome = run(&lines, output.path()).expect_err("short");
        assert!(matches!(&outcome, Outcome::Failed { reason, .. } if reason == "incomplete"));
        let line = json!({ "type": "started", "fileName": "logs.zip", "byteLength": MAX_DIAGNOSTIC_ARCHIVE_BYTES + 1, "manifest": manifest() }).to_string().into_bytes();
        let outcome = run(
            &[json!({ "type": "waiting" }).to_string().into_bytes(), line],
            output.path(),
        )
        .expect_err("too large");
        assert!(matches!(&outcome, Outcome::Failed { reason, .. } if reason == "too-large"));
        assert!(entries(output.path()).is_empty());
    }

    #[test]
    fn refuses_an_archive_whose_manifest_names_another_or_no_store() {
        let output = tempfile::tempdir().expect("output");
        let mut other = manifest();
        other["storageInstanceId"] = json!("storage-elsewhere");
        let mut empty = manifest();
        empty["storageInstanceId"] = json!("");
        let mut missing = manifest();
        missing
            .as_object_mut()
            .expect("object")
            .remove("environmentId");
        for (inner, relayed) in [
            (other, manifest()),
            (empty.clone(), empty),
            (missing.clone(), missing),
        ] {
            let archive = zip_with_manifest(&inner);
            let outcome = run(&lines_for(&archive, "logs.zip", &relayed), output.path())
                .expect_err("mismatch");
            assert!(
                matches!(&outcome, Outcome::Failed { reason, .. } if reason == "wrong-environment"),
                "{outcome:?}"
            );
        }
        assert!(entries(output.path()).is_empty());
    }

    #[test]
    fn maps_answers_to_exit_codes_and_strips_control_characters() {
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
        for reason in ["expired", "cooling-down"] {
            assert_eq!(
                answer(json!({ "type": "ended", "reason": reason, "message": "m" })).exit_code(),
                2
            );
        }
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
            "message": "No \u{1b}[2J environment\r named Mars.\u{7}",
        }));
        assert_eq!(failed.exit_code(), 1);
        assert_eq!(
            failed.to_json()["message"],
            "No [2J environment named Mars."
        );
    }

    #[test]
    fn only_a_loopback_endpoint_gets_the_token() {
        let state = tempfile::tempdir().expect("state");
        for (url, accepted) in [
            ("http://127.0.0.1:3773", true),
            ("http://[::1]:3773", true),
            ("http://localhost:3773", true),
            ("http://100.64.0.10:3773", false),
            ("http://example.com", false),
            ("https://127.0.0.1:3773", false),
        ] {
            std::fs::write(
                state.path().join(RELAY_ENDPOINT_FILE),
                json!({ "version": 1, "url": url, "token": "t" }).to_string(),
            )
            .expect("endpoint");
            let result = read_endpoint(state.path());
            assert_eq!(result.is_ok(), accepted, "{url}");
            if let Err(outcome) = result {
                assert!(
                    matches!(&outcome, Outcome::Unavailable { reason, .. } if reason == "not-loopback")
                );
            }
        }
    }

    #[tokio::test]
    async fn without_an_endpoint_file_it_says_bibcode_is_not_running_and_names_wsl() {
        let state = tempfile::tempdir().expect("state");
        let output = tempfile::tempdir().expect("output");
        let outcome = download(
            state.path(),
            &DownloadRequest {
                environment: "Omarchy",
                include_crash_dumps: false,
                output: output.path(),
                code: "K7Q-4M",
            },
            &mut || {},
        )
        .await;
        let Outcome::Unavailable { reason, message } = &outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(reason, "not-running");
        assert!(message.contains("inside that distro"), "{message}");
        assert_eq!(outcome.exit_code(), 3);
    }
}
