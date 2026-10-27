use std::{
    fs::{self, File},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use serde_json::{Value, json};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::{
    diagnostics::redact_sensitive_text,
    logging::{SERVER_LOG_MAX_BYTES, retained_server_log_paths},
};

const FRONTEND_LOG_MAX_BYTES: usize = 512 * 1024;
const SERVER_LOG_ENTRY: &str = "server.log";
const SERVER_TRACE_ENTRY: &str = "server.trace.ndjson";
const FRONTEND_LOG_ENTRY: &str = "frontend.log";
const EMPTY_SERVER_LOG: &str = "No retained server logs were found.\n";
const EMPTY_SERVER_TRACE: &str = "No retained server trace records were found.\n";
const EMPTY_FRONTEND_LOG: &str = "No frontend warnings or errors were captured.\n";
const PROFILER_ENTRY_DIR: &str = "profiler";
const PROFILER_CRASHES_DIR: &str = "crashes";
const PROFILER_OMITTED_ENTRY: &str = "profiler/OMITTED.txt";
const MANIFEST_ENTRY: &str = "manifest.json";
/// Archives one server holds at a time. A slot is taken before a build starts and released
/// when its [`DiagnosticBundle`] is dropped: an RPC download keeps it until the last item is
/// sent, the HTTP route until it hands the bytes to the response. Each archive is up to
/// [`MAX_DIAGNOSTIC_ARCHIVE_BYTES`] in memory and is compressed on a blocking thread, so a
/// burst of requests waits for a slot instead of multiplying that memory and CPU.
const MAX_ARCHIVES_IN_MEMORY: usize = 2;
/// The longest environment label the archive name carries.
const FILE_NAME_LABEL_MAX_CHARS: usize = 40;
/// The largest archive the desktop host will save. Profiler files are only added while the
/// archive, as built so far, leaves room for them.
pub const MAX_DIAGNOSTIC_ARCHIVE_BYTES: usize = 20 * 1024 * 1024;
/// Archive bytes held back for what the compressor has not written out yet, and for the
/// archive's own directory.
const ARCHIVE_SLACK_BYTES: u64 = 1024 * 1024;
/// Uncompressed bytes of profiler files, crash dumps included, one bundle may carry. It
/// bounds the work and memory of a bundle; the archive limit above bounds its size. The
/// newest files are taken first; whatever does not fit is listed in `profiler/OMITTED.txt`.
const PROFILER_BUNDLE_MAX_BYTES: u64 = 4 * SERVER_LOG_MAX_BYTES;
/// One text file is read up to the profiler's rotation size and marked when truncated.
const PROFILER_TEXT_FILE_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// The server a bundle comes from, as its `manifest.json` and file name state it.
#[derive(Clone, Debug)]
pub struct DiagnosticBundleIdentity {
    /// The id the server declares in its environment descriptor.
    pub environment_id: String,
    /// The persistent store's id, which clients key a remote environment by.
    pub storage_instance_id: Option<String>,
    pub label: String,
    pub server_version: String,
}

#[derive(Clone)]
pub struct DiagnosticBundleService {
    logs_dir: PathBuf,
    profiler_dir: Option<PathBuf>,
    identity: DiagnosticBundleIdentity,
    /// See [`MAX_ARCHIVES_IN_MEMORY`]. A caller that stops waiting (an interrupted RPC, a
    /// closed HTTP request) still holds its slot until the thread it started is done.
    build_permits: Arc<Semaphore>,
    #[cfg(test)]
    before_build: Option<Arc<dyn Fn() + Send + Sync>>,
}

pub struct DiagnosticBundle {
    pub filename: String,
    pub bytes: Vec<u8>,
    /// The archive's `manifest.json`, as JSON.
    pub manifest: Value,
    /// This archive's slot among [`MAX_ARCHIVES_IN_MEMORY`], released with the bundle.
    _slot: Option<OwnedSemaphorePermit>,
}

#[derive(Debug, Error)]
pub enum DiagnosticBundleError {
    #[error("failed to read a retained server log")]
    ReadServerLog(#[source] std::io::Error),
    #[error("failed to construct the diagnostic archive")]
    Zip(#[source] zip::result::ZipError),
    #[error("failed to write diagnostic archive contents")]
    Write(#[source] std::io::Error),
    #[error("diagnostic archive construction task failed")]
    Join(#[source] tokio::task::JoinError),
    #[error("diagnostic archive builds have stopped")]
    Closed,
}

impl DiagnosticBundleService {
    #[must_use]
    pub fn new(logs_dir: impl AsRef<Path>, identity: DiagnosticBundleIdentity) -> Self {
        Self {
            logs_dir: logs_dir.as_ref().to_path_buf(),
            profiler_dir: None,
            identity,
            build_permits: Arc::new(Semaphore::new(MAX_ARCHIVES_IN_MEMORY)),
            #[cfg(test)]
            before_build: None,
        }
    }

    /// Adds the profiler data directory to the bundle, under `profiler/`.
    #[must_use]
    pub fn with_profiler_dir(mut self, profiler_dir: impl AsRef<Path>) -> Self {
        self.profiler_dir = Some(profiler_dir.as_ref().to_path_buf());
        self
    }

    /// Free archive slots, for tests that check one is held or released.
    #[cfg(test)]
    pub(crate) fn free_slots_for_test(&self) -> usize {
        self.build_permits.available_permits()
    }

    /// Runs `hook` on the blocking thread before each build, while it holds its permit.
    #[cfg(test)]
    fn with_before_build(mut self, hook: impl Fn() + Send + Sync + 'static) -> Self {
        self.before_build = Some(Arc::new(hook));
        self
    }

    /// Crash dumps can hold fragments of process memory, so they are left out unless the
    /// caller asked for them.
    pub async fn build(
        &self,
        frontend_log: String,
        include_crash_dumps: bool,
        generated_at: OffsetDateTime,
    ) -> Result<DiagnosticBundle, DiagnosticBundleError> {
        let permit = Arc::clone(&self.build_permits)
            .acquire_owned()
            .await
            .map_err(|_| DiagnosticBundleError::Closed)?;
        let logs_dir = self.logs_dir.clone();
        let profiler_dir = self.profiler_dir.clone();
        let identity = self.identity.clone();
        #[cfg(test)]
        let before_build = self.before_build.clone();
        // The permit moves into the blocking closure and out with the bundle: dropping the
        // returned future (the caller went away) cannot release it while the thread still
        // compresses, and the caller holds it for as long as it holds the archive.
        tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            if let Some(hook) = before_build {
                hook();
            }
            build_bundle(
                &logs_dir,
                profiler_dir.as_deref(),
                &identity,
                &frontend_log,
                include_crash_dumps,
                generated_at,
            )
            .map(|bundle| DiagnosticBundle {
                _slot: Some(permit),
                ..bundle
            })
        })
        .await
        .map_err(DiagnosticBundleError::Join)?
    }
}

fn build_bundle(
    logs_dir: &Path,
    profiler_dir: Option<&Path>,
    identity: &DiagnosticBundleIdentity,
    frontend_log: &str,
    include_crash_dumps: bool,
    generated_at: OffsetDateTime,
) -> Result<DiagnosticBundle, DiagnosticBundleError> {
    let server_log = collect_server_logs(logs_dir)?;
    let server_trace =
        collect_retained_logs(&logs_dir.join(SERVER_TRACE_ENTRY), EMPTY_SERVER_TRACE)?;
    let mut frontend_log = if frontend_log.trim().is_empty() {
        EMPTY_FRONTEND_LOG.to_owned()
    } else {
        redact_sensitive_text(&bounded_frontend_log(frontend_log))
    };
    if !frontend_log.ends_with('\n') {
        frontend_log.push('\n');
    }
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    writer
        .start_file(SERVER_LOG_ENTRY, options)
        .map_err(DiagnosticBundleError::Zip)?;
    writer
        .write_all(server_log.as_bytes())
        .map_err(DiagnosticBundleError::Write)?;
    writer
        .start_file(SERVER_TRACE_ENTRY, options)
        .map_err(DiagnosticBundleError::Zip)?;
    writer
        .write_all(server_trace.as_bytes())
        .map_err(DiagnosticBundleError::Write)?;
    writer
        .start_file(FRONTEND_LOG_ENTRY, options)
        .map_err(DiagnosticBundleError::Zip)?;
    writer
        .write_all(frontend_log.as_bytes())
        .map_err(DiagnosticBundleError::Write)?;
    let crash_dumps_included = match profiler_dir {
        Some(profiler_dir) => {
            write_profiler_entries(&mut writer, options, profiler_dir, include_crash_dumps)?
        }
        None => 0,
    };
    let manifest = manifest(
        identity,
        generated_at,
        include_crash_dumps,
        crash_dumps_included,
    );
    let mut manifest_text = serde_json::to_string_pretty(&manifest).expect("JSON serializes");
    manifest_text.push('\n');
    writer
        .start_file(MANIFEST_ENTRY, options)
        .map_err(DiagnosticBundleError::Zip)?;
    writer
        .write_all(manifest_text.as_bytes())
        .map_err(DiagnosticBundleError::Write)?;
    let bytes = writer
        .finish()
        .map_err(DiagnosticBundleError::Zip)?
        .into_inner();
    Ok(DiagnosticBundle {
        filename: format!(
            "bibcode-diagnostics-{}-{:04}{:02}{:02}T{:02}{:02}{:02}Z.zip",
            file_name_label(&identity.label),
            generated_at.year(),
            u8::from(generated_at.month()),
            generated_at.day(),
            generated_at.hour(),
            generated_at.minute(),
            generated_at.second(),
        ),
        bytes,
        manifest,
        _slot: None,
    })
}

/// What `manifest.json` says. `crashDumps.included` counts the dumps actually written, which
/// can be fewer than were asked for when one does not fit or cannot be read.
fn manifest(
    identity: &DiagnosticBundleIdentity,
    generated_at: OffsetDateTime,
    crash_dumps_requested: bool,
    crash_dumps_included: usize,
) -> Value {
    json!({
        "schemaVersion": 1,
        "environmentId": identity.environment_id,
        "storageInstanceId": identity.storage_instance_id,
        "environmentLabel": identity.label,
        "serverVersion": identity.server_version,
        "platform": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "generatedAt": generated_at
            .format(&Rfc3339)
            .unwrap_or_else(|_| generated_at.unix_timestamp().to_string()),
        "crashDumps": {
            "requested": crash_dumps_requested,
            "included": crash_dumps_included,
        },
    })
}

/// The environment label as a file-name part: lowercase ASCII letters and digits, each other
/// run of characters one `-`, at most [`FILE_NAME_LABEL_MAX_CHARS`], and `server` when nothing
/// is left.
fn file_name_label(label: &str) -> String {
    let mut slug = String::new();
    for character in label.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let mut slug: String = slug
        .trim_matches('-')
        .chars()
        .take(FILE_NAME_LABEL_MAX_CHARS)
        .collect();
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "server".to_owned()
    } else {
        slug
    }
}

struct ProfilerFile {
    path: PathBuf,
    entry: String,
    len: u64,
    modified: SystemTime,
    is_dump: bool,
}

/// Adds the profiler directory's files, newest first, within `PROFILER_BUNDLE_MAX_BYTES`.
/// A file that cannot be read or does not fit is listed in `profiler/OMITTED.txt` instead
/// of failing the whole bundle. Symbolic links are never followed, not even to a linked
/// profiler or `crashes` directory. Returns how many crash dumps it wrote.
fn write_profiler_entries(
    writer: &mut ZipWriter<Cursor<Vec<u8>>>,
    options: SimpleFileOptions,
    profiler_dir: &Path,
    include_crash_dumps: bool,
) -> Result<usize, DiagnosticBundleError> {
    let mut dumps_written = 0;
    let mut omitted = Vec::new();
    let mut files = Vec::new();
    // `read_dir` follows a link, so a linked directory is skipped rather than listed.
    if is_real_directory(profiler_dir) {
        list_profiler_files(
            profiler_dir,
            PROFILER_ENTRY_DIR,
            include_crash_dumps,
            &mut files,
            &mut omitted,
        );
        let crashes_dir = profiler_dir.join(PROFILER_CRASHES_DIR);
        if is_real_directory(&crashes_dir) {
            list_profiler_files(
                &crashes_dir,
                &format!("{PROFILER_ENTRY_DIR}/{PROFILER_CRASHES_DIR}"),
                include_crash_dumps,
                &mut files,
                &mut omitted,
            );
        }
    }
    files.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.entry.cmp(&b.entry))
    });

    let mut remaining = PROFILER_BUNDLE_MAX_BYTES;
    for file in files {
        // Room left in the archive, counting a file as if it did not compress at all.
        let archive_room = (MAX_DIAGNOSTIC_ARCHIVE_BYTES as u64)
            .saturating_sub(ARCHIVE_SLACK_BYTES)
            .saturating_sub(
                writer
                    .get_ref()
                    .map_or(0, |archive| archive.get_ref().len()) as u64,
            );
        let budget = remaining.min(archive_room);
        // A dump is useless cut short, so it is bundled whole or not at all.
        let fits = if file.is_dump {
            file.len <= budget
        } else {
            budget > 0
        };
        if !fits {
            omitted.push(format!("{} (over the bundle size limit)", file.entry));
            continue;
        }
        let limit = if file.is_dump {
            file.len
        } else {
            budget.min(PROFILER_TEXT_FILE_MAX_BYTES)
        };
        let Some(contents) = read_profiler_file(&file, limit) else {
            omitted.push(format!("{} (could not be read)", file.entry));
            continue;
        };
        remaining = remaining.saturating_sub(contents.len() as u64);
        writer
            .start_file(&file.entry, options)
            .map_err(DiagnosticBundleError::Zip)?;
        writer
            .write_all(&contents)
            .map_err(DiagnosticBundleError::Write)?;
        if file.is_dump {
            dumps_written += 1;
        }
    }
    if !omitted.is_empty() {
        writer
            .start_file(PROFILER_OMITTED_ENTRY, options)
            .map_err(DiagnosticBundleError::Zip)?;
        writer
            .write_all(b"These profiler files were left out of this bundle:\n")
            .map_err(DiagnosticBundleError::Write)?;
        for line in omitted {
            writer
                .write_all(format!("{line}\n").as_bytes())
                .map_err(DiagnosticBundleError::Write)?;
        }
    }
    Ok(dumps_written)
}

fn is_real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

fn is_real_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
}

fn list_profiler_files(
    dir: &Path,
    entry_prefix: &str,
    include_crash_dumps: bool,
    files: &mut Vec<ProfilerFile>,
    omitted: &mut Vec<String>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            omitted.push(format!("{entry_prefix}/ (directory could not be read)"));
            return;
        }
    };
    for item in entries.flatten() {
        // `DirEntry::file_type` does not follow links, so a symlink is never `is_file`.
        if !item.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_plain_file_name(&name) {
            continue;
        }
        let is_dump = name.to_ascii_lowercase().ends_with(".dmp");
        if is_dump && !include_crash_dumps {
            continue;
        }
        // The crash monitor creates a dump at its final name and writes its `.json` sidecar
        // only once the dump is complete, so a dump without one is still being written (or
        // was cut short) and is left out rather than bundled, and counted, half written.
        if is_dump && !is_real_file(&dir.join(Path::new(&name).with_extension("json"))) {
            omitted.push(format!(
                "{entry_prefix}/{name} (incomplete: no crash record yet)"
            ));
            continue;
        }
        let Ok(metadata) = item.metadata() else {
            omitted.push(format!("{entry_prefix}/{name} (could not be read)"));
            continue;
        };
        files.push(ProfilerFile {
            path: item.path(),
            entry: format!("{entry_prefix}/{name}"),
            len: metadata.len(),
            modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            is_dump,
        });
    }
}

/// Profiler file names are generated by the profiler itself; anything else, such as a name
/// that could act as a path inside the archive, is not bundled.
fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Dumps are copied byte for byte. Text files are read up to `limit`, marked when
/// truncated, and redacted like the logs.
fn read_profiler_file(file: &ProfilerFile, limit: u64) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(&file.path)
        .ok()?
        .take(limit.saturating_add(u64::from(!file.is_dump)))
        .read_to_end(&mut bytes)
        .ok()?;
    if file.is_dump {
        return Some(bytes);
    }
    let truncated = bytes.len() as u64 > limit;
    if truncated {
        bytes.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    }
    let mut text = redact_sensitive_text(&String::from_utf8_lossy(&bytes));
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    if truncated {
        text.push_str("[truncated]\n");
    }
    Some(text.into_bytes())
}

fn collect_server_logs(logs_dir: &Path) -> Result<String, DiagnosticBundleError> {
    collect_retained_logs(&logs_dir.join(SERVER_LOG_ENTRY), EMPTY_SERVER_LOG)
}

fn collect_retained_logs(
    active_log: &Path,
    empty_message: &str,
) -> Result<String, DiagnosticBundleError> {
    let mut combined = String::new();
    for path in retained_server_log_paths(active_log) {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(contents) = read_bounded_if_present(&path)? else {
            continue;
        };
        if contents.trim().is_empty() {
            continue;
        }
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&format!("===== {name} =====\n"));
        combined.push_str(&redact_sensitive_text(&contents));
        if !combined.ends_with('\n') {
            combined.push('\n');
        }
    }
    if combined.is_empty() {
        Ok(empty_message.to_owned())
    } else {
        Ok(combined)
    }
}

fn read_bounded_if_present(path: &Path) -> Result<Option<String>, DiagnosticBundleError> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(DiagnosticBundleError::ReadServerLog(error)),
    };
    let limit = SERVER_LOG_MAX_BYTES.saturating_add(1);
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(DiagnosticBundleError::ReadServerLog)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > SERVER_LOG_MAX_BYTES {
        bytes.truncate(usize::try_from(SERVER_LOG_MAX_BYTES).unwrap_or(usize::MAX));
        bytes.extend_from_slice(b"\n[truncated]\n");
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

fn bounded_frontend_log(input: &str) -> String {
    if input.len() <= FRONTEND_LOG_MAX_BYTES {
        return input.to_owned();
    }
    let mut output =
        String::from_utf8_lossy(&input.as_bytes()[..FRONTEND_LOG_MAX_BYTES]).into_owned();
    output.push_str("\n[truncated]\n");
    output
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Mutex, mpsc},
        time::Duration,
    };

    use super::*;

    fn identity(label: &str) -> DiagnosticBundleIdentity {
        DiagnosticBundleIdentity {
            environment_id: "local".to_owned(),
            storage_instance_id: Some("storage-1".to_owned()),
            label: label.to_owned(),
            server_version: "9.9.9".to_owned(),
        }
    }

    fn generated_at() -> OffsetDateTime {
        OffsetDateTime::parse("2026-07-15T12:34:56Z", &Rfc3339).expect("timestamp")
    }

    #[test]
    fn file_name_label_is_a_bounded_ascii_slug() {
        assert_eq!(file_name_label("Local"), "local");
        assert_eq!(file_name_label("ai-server"), "ai-server");
        assert_eq!(file_name_label("Mauro's Mac 🍎"), "mauro-s-mac");
        assert_eq!(file_name_label("  --  "), "server");
        assert_eq!(file_name_label("日本"), "server");
        let cut = file_name_label(&format!("{} tail", "x".repeat(39)));
        assert_eq!(cut, "x".repeat(39), "a slug never ends with a dash");
        assert!(file_name_label(&"y".repeat(60)).len() == FILE_NAME_LABEL_MAX_CHARS);
    }

    #[tokio::test]
    async fn bundle_names_its_server_in_the_file_name_and_manifest() {
        let logs = tempfile::tempdir().expect("logs");
        let bundle = DiagnosticBundleService::new(logs.path(), identity("Omarchy Box"))
            .build(String::new(), false, generated_at())
            .await
            .expect("bundle");
        assert_eq!(
            bundle.filename,
            "bibcode-diagnostics-omarchy-box-20260715T123456Z.zip"
        );
        let mut archive = zip::ZipArchive::new(Cursor::new(&bundle.bytes)).expect("zip");
        let mut text = String::new();
        archive
            .by_name(MANIFEST_ENTRY)
            .expect("manifest entry")
            .read_to_string(&mut text)
            .expect("manifest text");
        let written: Value = serde_json::from_str(&text).expect("manifest JSON");
        assert_eq!(written, bundle.manifest);
        assert_eq!(
            written,
            json!({
                "schemaVersion": 1,
                "environmentId": "local",
                "storageInstanceId": "storage-1",
                "environmentLabel": "Omarchy Box",
                "serverVersion": "9.9.9",
                "platform": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
                "generatedAt": "2026-07-15T12:34:56Z",
                "crashDumps": { "requested": false, "included": 0 },
            })
        );
    }

    #[tokio::test]
    async fn manifest_counts_only_the_crash_dumps_it_wrote() {
        let logs = tempfile::tempdir().expect("logs");
        let profiler = tempfile::tempdir().expect("profiler");
        let crashes = profiler.path().join(PROFILER_CRASHES_DIR);
        fs::create_dir_all(&crashes).expect("crashes dir");
        fs::write(crashes.join("small.dmp"), b"MDMP small").expect("small dump");
        fs::write(crashes.join("small.json"), b"{}").expect("small record");
        // Larger than the whole bundle budget, so it is listed as omitted, not written.
        let oversized = File::create(crashes.join("huge.dmp")).expect("huge dump");
        oversized
            .set_len(PROFILER_BUNDLE_MAX_BYTES + 1)
            .expect("sparse dump");
        fs::write(crashes.join("huge.json"), b"{}").expect("huge record");
        // The monitor is still writing it: no crash record yet.
        fs::write(crashes.join("partial.dmp"), b"MDMP part").expect("partial dump");
        let service = DiagnosticBundleService::new(logs.path(), identity("Local"))
            .with_profiler_dir(profiler.path());

        let requested = service
            .build(String::new(), true, generated_at())
            .await
            .expect("bundle with dumps");
        assert_eq!(
            requested.manifest["crashDumps"],
            json!({ "requested": true, "included": 1 })
        );
        let mut archive = zip::ZipArchive::new(Cursor::new(&requested.bytes)).expect("zip");
        assert!(archive.by_name("profiler/crashes/small.dmp").is_ok());
        assert!(archive.by_name("profiler/crashes/partial.dmp").is_err());
        let mut omitted = String::new();
        archive
            .by_name(PROFILER_OMITTED_ENTRY)
            .expect("omitted list")
            .read_to_string(&mut omitted)
            .expect("omitted text");
        assert!(omitted.contains("profiler/crashes/partial.dmp (incomplete: no crash record yet)"));
        assert!(omitted.contains("profiler/crashes/huge.dmp (over the bundle size limit)"));
        drop(requested);

        let declined = service
            .build(String::new(), false, generated_at())
            .await
            .expect("bundle without dumps");
        assert_eq!(
            declined.manifest["crashDumps"],
            json!({ "requested": false, "included": 0 })
        );
    }

    /// The archive keeps its slot for as long as the caller holds it, so archives waiting to
    /// be sent count against the limit as much as archives being built.
    #[tokio::test]
    async fn a_bundle_holds_its_slot_until_it_is_dropped() {
        let logs = tempfile::tempdir().expect("logs");
        let service = DiagnosticBundleService::new(logs.path(), identity("Local"));
        let first = service
            .build(String::new(), false, generated_at())
            .await
            .expect("first");
        let second = service
            .build(String::new(), false, generated_at())
            .await
            .expect("second");
        assert_eq!(service.free_slots_for_test(), 0);
        let third = tokio::spawn({
            let service = service.clone();
            async move { service.build(String::new(), false, generated_at()).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!third.is_finished(), "a third archive waits for a slot");
        drop(first);
        third.await.expect("third task").expect("third");
        drop(second);
        assert_eq!(service.free_slots_for_test(), MAX_ARCHIVES_IN_MEMORY);
    }

    /// A build whose caller stopped waiting keeps its permit until its blocking work returns,
    /// so the next build waits for the thread rather than running beside it.
    #[tokio::test]
    async fn an_abandoned_build_holds_its_permit_until_its_thread_finishes() {
        let logs = tempfile::tempdir().expect("logs");
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let entered_tx = Mutex::new(entered_tx);
        let release_rx = Mutex::new(release_rx);
        let first_call = std::sync::atomic::AtomicBool::new(true);
        let mut service = DiagnosticBundleService::new(logs.path(), identity("Local"))
            .with_before_build(move || {
                if first_call.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    entered_tx.lock().unwrap().send(()).unwrap();
                    release_rx.lock().unwrap().recv().unwrap();
                }
            });
        service.build_permits = Arc::new(Semaphore::new(1));

        let abandoned = tokio::spawn({
            let service = service.clone();
            async move { service.build(String::new(), false, generated_at()).await }
        });
        tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
            .await
            .expect("first build entered its thread");
        abandoned.abort();
        let _ = abandoned.await;
        assert_eq!(
            service.build_permits.available_permits(),
            0,
            "the aborted build's thread still holds the permit"
        );

        let next = tokio::spawn({
            let service = service.clone();
            async move { service.build(String::new(), false, generated_at()).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!next.is_finished(), "the next build waits for the permit");

        release_tx.send(()).unwrap();
        next.await
            .expect("next build task")
            .expect("next build succeeds once the permit is free");
        assert_eq!(service.build_permits.available_permits(), 1);
    }
}
