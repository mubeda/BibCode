use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use tokio::io::AsyncWriteExt;

use tokio_util::sync::CancellationToken;

use super::TransferError;
use crate::workspace::WorkspaceError;
use crate::workspace::beneath::{self, Dir, Identity, Kind, Open, Replace, Root};

/// Distinguishes partial files written by this process, so two concurrent uploads of the same
/// name never share one.
static PARTIAL_COUNTER: AtomicU64 = AtomicU64::new(0);

/// One path component may hold 255 bytes on every filesystem BiBCode supports.
pub const MAX_PATH_COMPONENT_BYTES: usize = 255;

/// The tail `write_upload` gives its partial files.
pub const UPLOAD_PARTIAL_SUFFIX: &str = "bibcode-upload.part";

/// Path separators, refused wherever the file lands: they would change which entry is addressed
/// rather than merely how it is spelled. Control characters (NUL included) are refused with them.
const UNIVERSAL_FORBIDDEN_CHARACTERS: [char; 2] = ['/', '\\'];

/// Characters Windows forbids in a file name. They are ordinary bytes on Linux and macOS, where
/// `report:v2.txt` is a perfectly good name, so they are only refused when the filesystem that
/// will store the file is a Windows one.
pub const WINDOWS_FORBIDDEN_CHARACTERS: [char; 7] = ['<', '>', ':', '"', '|', '?', '*'];

/// The bytes a partial name adds around the stem it echoes, with every counter at its widest.
/// Derived from the same formatter the partial name uses, so the budget cannot drift away from
/// the format it is protecting.
#[must_use]
pub fn partial_name_overhead(suffix: &str) -> usize {
    partial_name("", suffix, u32::MAX, u64::MAX, u128::MAX).len()
}

/// How much of a file name its partial sibling may echo. This is a budget for the *partial*,
/// not a cap on the name: a partial is a temporary file nobody reads, so it echoes as much of
/// the name as fits and drops the rest. The name itself is only held to
/// [`MAX_PATH_COMPONENT_BYTES`].
#[must_use]
pub fn max_transfer_stem_bytes(suffix: &str) -> usize {
    MAX_PATH_COMPONENT_BYTES.saturating_sub(partial_name_overhead(suffix))
}

/// The file-name policy a BiBCode transfer applies.
///
/// The rules that hold everywhere always apply: a non-empty name, not `.` or `..`, no path
/// separator, no control character, and short enough that its partial sibling still fits one
/// path component.
///
/// `windows_rules` adds what only Windows forbids -- `< > : " | ? *`, a trailing dot or space
/// (Windows strips those, so the entry written would not be the entry named), and the reserved
/// device names. The caller passes it for the filesystem that will actually store the file, not
/// for the host that happens to be asking: `report:v2.txt`, `nul`, and `notes.` are legal names
/// on Linux and macOS, and refusing them there would make files a workspace already holds
/// untransferable for no reason.
#[must_use]
pub fn is_plain_transfer_file_name(name: &str, max_bytes: usize, windows_rules: bool) -> bool {
    if name.is_empty() || name.len() > max_bytes || name == "." || name == ".." {
        return false;
    }
    if name.chars().any(|character| {
        UNIVERSAL_FORBIDDEN_CHARACTERS.contains(&character) || character.is_control()
    }) {
        return false;
    }
    if !windows_rules {
        return true;
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    if name
        .chars()
        .any(|character| WINDOWS_FORBIDDEN_CHARACTERS.contains(&character))
    {
        return false;
    }
    !is_windows_device_name(name)
}

/// `CON`, `con.txt`, and `CON.tar.gz` all address the console device on Windows, so the stem
/// before the first dot is what is compared, without regard to case.
#[must_use]
pub fn is_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    if ["CON", "PRN", "AUX", "NUL"]
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device))
    {
        return true;
    }
    let Some(port) = stem.chars().next_back() else {
        return false;
    };
    if !matches!(port, '1'..='9') {
        return false;
    }
    let head = &stem[..stem.len() - port.len_utf8()];
    head.eq_ignore_ascii_case("COM") || head.eq_ignore_ascii_case("LPT")
}

/// The upload-name rule as a person can act on it. It lives beside the rule so a refusal can
/// never describe a policy the code no longer applies: the byte cap comes from the same
/// derivation the validator uses, and the Windows clause appears only where it is enforced.
#[must_use]
pub fn upload_file_name_rule() -> String {
    upload_file_name_rule_for(cfg!(windows))
}

fn upload_file_name_rule_for(windows_rules: bool) -> String {
    let windows = if windows_rules {
        " This server stores files on Windows, so the name must also avoid < > : \" | ? *, a \
         trailing dot or space, and device names such as CON or COM1."
    } else {
        ""
    };
    format!(
        "Upload file name must be a plain file name: no / or \\, no control characters, and at \
         most {MAX_PATH_COMPONENT_BYTES} bytes.{windows}"
    )
}

/// Validates that `name` is a plain file name suitable for joining onto an upload directory.
///
/// The Windows rules apply only when this server is the one running on Windows, because this
/// server's filesystem is where the upload lands.
pub fn validate_upload_file_name(name: &str) -> Result<(), TransferError> {
    validate_upload_file_name_for(name, cfg!(windows))
}

/// [`validate_upload_file_name`] with the host decision made explicit, so both branches are
/// reachable from a test whatever the host running it.
fn validate_upload_file_name_for(name: &str, windows_rules: bool) -> Result<(), TransferError> {
    if is_plain_transfer_file_name(name, MAX_PATH_COMPONENT_BYTES, windows_rules) {
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
/// `directory` is `root` or below it, both canonical. Every step goes through a handle on
/// `directory` opened without following a symlink below `root` (`workspace::beneath`), so a
/// folder swapped for a symlink after the caller checked the path is refused, and one swapped
/// after the open cannot redirect the write.
///
/// When `overwrite` is not set the target name is *reserved* with `create_new` before any
/// bytes are streamed, so two concurrent uploads of the same new name cannot both believe they
/// won: the loser is refused up front instead of silently losing its bytes to the other's
/// rename. The reservation is closed immediately and the completed partial is renamed over it.
///
/// `cancellation` ends the upload (#139 X5: an outside agent's access ended). It is watched
/// while the body streams and checked once more just before the rename, so a fired token never
/// creates or replaces the target; the upload answers [`TransferError::Cancelled`].
///
/// Enforces `max_bytes`, and on any failure removes the partial file and — only when this call
/// created it — the reservation, so a failed upload never leaves a stray file behind. An
/// existing file the caller asked to overwrite is never removed on failure; it keeps its old
/// contents.
pub async fn write_upload<S>(
    root: &Path,
    directory: &Path,
    name: &str,
    overwrite: bool,
    max_bytes: u64,
    mut body: S,
    cancellation: &CancellationToken,
) -> Result<PathBuf, TransferError>
where
    S: Stream<Item = Result<Bytes, axum::Error>> + Unpin,
{
    validate_upload_file_name(name)?;
    let target = directory.join(name);
    let name_os = OsString::from(name);
    let dir = {
        let (root, folder, target) = (root.to_path_buf(), directory.to_path_buf(), target.clone());
        Arc::new(
            blocking(&target.clone(), move || {
                Root::new(&root)
                    .and_then(|validated| Dir::open(&validated, &folder, false))
                    .map_err(|error| fault("open", &root, &target, error))
            })
            .await?,
        )
    };
    // Removes only a file this upload created and nobody has replaced (or, for the
    // reservation, written to) since.
    let remove_own = |name: OsString, id: Option<Identity>, empty: bool| {
        let dir = Arc::clone(&dir);
        async move {
            let _ = tokio::task::spawn_blocking(move || dir.remove_own(&name, id, empty)).await;
        }
    };
    // The directory guard runs in both modes and before any reservation: a directory is never
    // replaced, whatever the token asked for.
    let kind = {
        let (dir, name, root, target) = (
            Arc::clone(&dir),
            name_os.clone(),
            root.to_path_buf(),
            target.clone(),
        );
        blocking(&target.clone(), move || {
            dir.kind(&name)
                .map_err(|error| fault("stat", &root, &target, error))
        })
        .await?
    };
    match kind {
        Kind::Directory => return Err(TransferError::EntryExists { path: target }),
        Kind::Missing => {}
        _ if !overwrite => return Err(TransferError::EntryExists { path: target }),
        _ => {}
    }
    // The reservation's identity, so the upload later replaces or removes it only while it is
    // still that empty file.
    let reservation: Option<Option<Identity>> = if overwrite {
        None
    } else {
        let (dir, name, root, path) = (
            Arc::clone(&dir),
            name_os.clone(),
            root.to_path_buf(),
            target.clone(),
        );
        // Closed at once: a rename over a handle this process still holds fails on Windows.
        let id = blocking(&target, move || {
            match dir.open_file(&name, Open::CreateNew) {
                Ok(file) => {
                    Identity::of(&file).map_err(|error| fault("reserve", &root, &path, error))
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::AlreadyExists
                        || matches!(dir.kind(&name), Ok(Kind::Directory)) =>
                {
                    Err(TransferError::EntryExists { path })
                }
                Err(error) => Err(fault("reserve", &root, &path, error)),
            }
        })
        .await?;
        Some(id)
    };
    let partial_name = OsString::from(partial_file_name(name));
    let partial = directory.join(&partial_name);
    let mut partial_id = None;
    let outcome: Result<(), TransferError> = async {
        let file = {
            let (dir, partial_name, root, partial) = (
                Arc::clone(&dir),
                partial_name.clone(),
                root.to_path_buf(),
                partial.clone(),
            );
            blocking(&partial.clone(), move || {
                dir.open_file(&partial_name, Open::CreateNew)
                    .map_err(|error| fault("create", &root, &partial, error))
            })
            .await?
        };
        partial_id = Identity::of(&file)
            .map_err(|error| TransferError::operation("create", &partial, error))?;
        let mut file = tokio::fs::File::from_std(file);
        let mut written: u64 = 0;
        loop {
            let chunk = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(TransferError::Cancelled),
                chunk = body.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
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
        // The last check: from here the only window is the rename itself.
        if cancellation.is_cancelled() {
            return Err(TransferError::Cancelled);
        }
        let (dir, partial_name, name, root, partial, target) = (
            Arc::clone(&dir),
            partial_name.clone(),
            name_os.clone(),
            root.to_path_buf(),
            partial.clone(),
            target.clone(),
        );
        blocking(&partial.clone(), move || {
            let exists = || TransferError::EntryExists {
                path: target.clone(),
            };
            let replace = match reservation {
                // Overwrite was asked for: replace whatever is there now.
                None => Replace::Allowed,
                // Only while the name is still this upload's empty reservation: anything a
                // person wrote there since stays, and the upload answers that it exists.
                Some(id) => {
                    if !dir.remove_own(&name, id, true) {
                        return Err(exists());
                    }
                    Replace::Never
                }
            };
            match dir.rename(&partial_name, &dir, &name, replace) {
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(exists()),
                other => other.map_err(|error| fault("rename", &root, &partial, error)),
            }
        })
        .await
    }
    .await;
    if let Err(error) = outcome {
        remove_own(partial_name, partial_id, false).await;
        if let Some(id) = reservation {
            // Only a reservation this call created, still empty and still the same file; an
            // existing file the caller asked to overwrite keeps its contents.
            remove_own(name_os, id, true).await;
        }
        return Err(error);
    }
    Ok(target)
}

/// An I/O failure of an upload step: a folder found swapped for a symlink is the path
/// resolving outside the root, which the route answers as a missing transfer.
fn fault(
    operation: &'static str,
    root: &Path,
    path: &Path,
    error: std::io::Error,
) -> TransferError {
    if beneath::is_escape(&error) {
        TransferError::Workspace(WorkspaceError::ResolvedPathOutsideRoot {
            root: root.to_path_buf(),
            resolved_path: path.to_path_buf(),
        })
    } else {
        TransferError::operation(operation, path, error)
    }
}

/// Runs a blocking step of an upload off the runtime.
async fn blocking<T: Send + 'static>(
    path: &Path,
    work: impl FnOnce() -> Result<T, TransferError> + Send + 'static,
) -> Result<T, TransferError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| TransferError::operation("upload", &path, std::io::Error::other(error)))?
}

/// A partial file name unique to this process, this call, and this instant, so concurrent
/// uploads of the same name never stream into the same file.
fn partial_file_name(name: &str) -> String {
    partial_transfer_file_name(name, UPLOAD_PARTIAL_SUFFIX)
}

/// The partial-file name a transfer streams into: `.{stem}.{unique}.{suffix}`, unique to this
/// process, this call, and this instant, and always inside one path component whatever name it
/// echoes -- the stem is truncated to whatever [`max_transfer_stem_bytes`] leaves.
///
/// The upload route and the desktop download host both call this, so neither can drift into
/// writing a different shape or a different budget from the one the other measures.
#[must_use]
pub fn partial_transfer_file_name(name: &str, suffix: &str) -> String {
    let counter = PARTIAL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let stem = truncate_on_char_boundary(name, max_transfer_stem_bytes(suffix));
    partial_name(stem, suffix, std::process::id(), counter, nanos)
}

/// The one place the partial-name shape is written down: the budget and the name are both
/// derived from it.
fn partial_name(stem: &str, suffix: &str, pid: u32, counter: u64, nanos: u128) -> String {
    format!(".{stem}.{pid}-{counter}-{nanos}.{suffix}")
}

/// Shortens `name` to at most `budget` bytes without splitting a character. Shared with the
/// desktop host, which has to fit a sanitised download name into the same component budget.
#[must_use]
pub fn truncate_on_char_boundary(name: &str, budget: usize) -> &str {
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

    /// An upload into `directory` as its own root, never cancelled.
    async fn write_upload_in<S>(
        directory: &Path,
        name: &str,
        overwrite: bool,
        max_bytes: u64,
        body: S,
    ) -> Result<PathBuf, TransferError>
    where
        S: Stream<Item = Result<Bytes, axum::Error>> + Unpin,
    {
        write_upload(
            directory,
            directory,
            name,
            overwrite,
            max_bytes,
            body,
            &CancellationToken::new(),
        )
        .await
    }

    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn a_cancelled_upload_leaves_neither_the_target_nor_a_partial() {
        let temp = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        // Cancelled while the body is still streaming.
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let receiver = tokio_stream::wrappers::UnboundedReceiverStream::new(receiver);
        sender.send(Ok(Bytes::from_static(b"half"))).unwrap();
        let upload = {
            let (directory, token) = (temp.path().to_path_buf(), token.clone());
            tokio::spawn(async move {
                write_upload(
                    &directory, &directory, "a.txt", false, 1024, receiver, &token,
                )
                .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        token.cancel();
        assert!(matches!(
            upload.await.unwrap(),
            Err(TransferError::Cancelled)
        ));
        drop(sender);
        assert!(
            entries(temp.path()).is_empty(),
            "{:?}",
            entries(temp.path())
        );

        // Cancelled as the last chunk arrives: the check before the rename refuses it, and an
        // existing file asked to be overwritten keeps its contents.
        std::fs::write(temp.path().join("b.txt"), "old").unwrap();
        let token = CancellationToken::new();
        let fired = token.clone();
        let body = stream::iter([Ok(Bytes::from_static(b"new"))]).chain(
            stream::once(async move {
                fired.cancel();
                Ok(Bytes::new())
            })
            .filter(|_| async { false }),
        );
        let result = write_upload(
            temp.path(),
            temp.path(),
            "b.txt",
            true,
            1024,
            Box::pin(body),
            &token,
        )
        .await;
        assert!(
            matches!(result, Err(TransferError::Cancelled)),
            "{result:?}"
        );
        assert_eq!(entries(temp.path()), ["b.txt"]);
        assert_eq!(
            std::fs::read_to_string(temp.path().join("b.txt")).unwrap(),
            "old"
        );
    }

    /// Starts a no-overwrite upload of `a.txt` whose body waits, lets `meanwhile` act on the
    /// name once the reservation exists, then ends the body (or cancels the upload).
    async fn upload_while(
        meanwhile: impl FnOnce(&Path),
        cancel: bool,
    ) -> (tempfile::TempDir, Result<PathBuf, TransferError>) {
        let temp = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        sender.send(Ok(Bytes::from_static(b"agent"))).unwrap();
        let receiver = tokio_stream::wrappers::UnboundedReceiverStream::new(receiver);
        let upload = {
            let (directory, token) = (temp.path().to_path_buf(), token.clone());
            tokio::spawn(async move {
                write_upload(
                    &directory, &directory, "a.txt", false, 1024, receiver, &token,
                )
                .await
            })
        };
        let target = temp.path().join("a.txt");
        while !target.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        meanwhile(&target);
        if cancel {
            token.cancel();
        }
        drop(sender);
        (temp, upload.await.unwrap())
    }

    #[tokio::test]
    async fn a_no_overwrite_upload_never_replaces_or_removes_a_file_written_during_it() {
        // Replaced by a new file of the same name while the body streamed.
        let replace = |target: &Path| {
            std::fs::remove_file(target).unwrap();
            std::fs::write(target, "person").unwrap();
        };
        let (temp, result) = upload_while(replace, false).await;
        assert!(
            matches!(result, Err(TransferError::EntryExists { .. })),
            "{result:?}"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("a.txt")).unwrap(),
            "person"
        );
        assert_eq!(entries(temp.path()), ["a.txt"]);
        // Written into the reservation itself.
        let fill = |target: &Path| std::fs::write(target, "person").unwrap();
        let (temp, result) = upload_while(fill, false).await;
        assert!(
            matches!(result, Err(TransferError::EntryExists { .. })),
            "{result:?}"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("a.txt")).unwrap(),
            "person"
        );
        // A cancelled upload never removes what someone else wrote.
        let (temp, result) = upload_while(replace, true).await;
        assert!(
            matches!(result, Err(TransferError::Cancelled)),
            "{result:?}"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("a.txt")).unwrap(),
            "person"
        );
        assert_eq!(entries(temp.path()), ["a.txt"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_upload_folder_swapped_for_an_outside_symlink_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        // The route checked `root/sub`; it became a symlink before the upload opened it.
        std::os::unix::fs::symlink(outside.path(), root.path().join("sub")).unwrap();
        let result = write_upload(
            root.path(),
            &root.path().join("sub"),
            "a.txt",
            false,
            1024,
            body(&[b"agent"]),
            &CancellationToken::new(),
        )
        .await;
        assert!(
            matches!(
                result,
                Err(TransferError::Workspace(
                    WorkspaceError::ResolvedPathOutsideRoot { .. }
                ))
            ),
            "{result:?}"
        );
        assert!(entries(outside.path()).is_empty());
    }

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

    /// Names that are not plain file names anywhere: refused whatever stores them.
    const UNIVERSALLY_INVALID: &[&str] =
        &["", ".", "..", "a/b", "a\\b", "a\0b", "a\nb", "a\u{7f}b"];

    /// Legal names on Linux and macOS that a Windows filesystem cannot store.
    const WINDOWS_ONLY_INVALID: &[&str] = &[
        "a<b",
        "a>b",
        "report:v2.txt",
        "a\"b",
        "a|b",
        "a?b",
        "a*b",
        "notes.",
        "notes ",
        "...",
        "CON",
        "con",
        "CON.txt",
        "nul.tar.gz",
        "PRN",
        "aux",
        "COM1",
        "com9.log",
        "LPT1",
        "lpt9.txt",
    ];

    #[test]
    fn validates_plain_file_names_on_every_host() {
        for good in [
            "report.pdf",
            ".gitignore",
            "a b.txt",
            "CONTACTS.txt",
            "COM0.txt",
            "COM10.txt",
            "console",
            // Well past the partial-name budget: a partial echoes what fits, the name itself
            // is only held to the path-component limit.
            &"x".repeat(200),
            &"x".repeat(MAX_PATH_COMPONENT_BYTES),
        ] {
            for windows_rules in [false, true] {
                assert!(
                    validate_upload_file_name_for(good, windows_rules).is_ok(),
                    "{good} ({windows_rules})"
                );
            }
        }
        let too_long = "x".repeat(MAX_PATH_COMPONENT_BYTES + 1);
        for windows_rules in [false, true] {
            for bad in UNIVERSALLY_INVALID
                .iter()
                .copied()
                .chain([too_long.as_str()])
            {
                assert!(
                    matches!(
                        validate_upload_file_name_for(bad, windows_rules),
                        Err(TransferError::InvalidFileName { .. })
                    ),
                    "{bad:?} ({windows_rules})"
                );
            }
        }
    }

    #[test]
    fn the_windows_rules_apply_only_where_the_upload_lands_on_windows() {
        // The upload is written to *this* server's filesystem, so a POSIX host must keep
        // accepting names a POSIX filesystem stores perfectly well.
        for name in WINDOWS_ONLY_INVALID {
            assert!(
                validate_upload_file_name_for(name, false).is_ok(),
                "{name:?} is a legal POSIX name"
            );
            assert!(
                matches!(
                    validate_upload_file_name_for(name, true),
                    Err(TransferError::InvalidFileName { .. })
                ),
                "{name:?} is not storable on Windows"
            );
        }
    }

    #[test]
    fn the_refusal_names_the_windows_rules_only_where_they_are_enforced() {
        let posix = upload_file_name_rule_for(false);
        assert!(posix.contains("plain file name"), "{posix}");
        assert!(
            posix.contains(&MAX_PATH_COMPONENT_BYTES.to_string()),
            "{posix}"
        );
        assert!(!posix.contains("CON"), "{posix}");
        let windows = upload_file_name_rule_for(true);
        assert!(windows.contains("CON"), "{windows}");
        assert!(windows.contains("trailing dot"), "{windows}");
    }

    #[test]
    fn the_partial_stem_budget_is_derived_from_the_partial_name_format() {
        // The budget exists only so the `.part` sibling fits one path component; a hard-coded
        // number would drift the moment the partial format changes.
        let budget = max_transfer_stem_bytes(UPLOAD_PARTIAL_SUFFIX);
        assert_eq!(
            partial_name(
                &"x".repeat(budget),
                UPLOAD_PARTIAL_SUFFIX,
                u32::MAX,
                u64::MAX,
                u128::MAX
            )
            .len(),
            MAX_PATH_COMPONENT_BYTES
        );
        // A longer suffix buys a shorter stem, and the two always add up to the component limit.
        assert!(max_transfer_stem_bytes("bibcode-download.part") < budget);
        // Any name the validator accepts still yields a partial inside one component, because
        // the partial echoes only what fits rather than the whole name.
        for name in [
            "a.txt",
            &"x".repeat(200),
            &"x".repeat(MAX_PATH_COMPONENT_BYTES),
        ] {
            let partial = partial_transfer_file_name(name, UPLOAD_PARTIAL_SUFFIX);
            assert!(partial.len() <= MAX_PATH_COMPONENT_BYTES, "{partial}");
            assert!(partial.ends_with(UPLOAD_PARTIAL_SUFFIX), "{partial}");
        }
    }

    #[tokio::test]
    async fn writes_atomically_refuses_collisions_and_overwrites_on_request() {
        let temp = tempfile::tempdir().unwrap();
        let written = write_upload_in(temp.path(), "a.txt", false, 1024, body(&[b"hel", b"lo"]))
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

        let error = write_upload_in(temp.path(), "a.txt", false, 1024, body(&[b"x"]))
            .await
            .unwrap_err();
        assert!(matches!(error, TransferError::EntryExists { .. }));
        assert_eq!(std::fs::read(&written).unwrap(), b"hello");

        write_upload_in(temp.path(), "a.txt", true, 1024, body(&[b"new"]))
            .await
            .unwrap();
        assert_eq!(std::fs::read(&written).unwrap(), b"new");
    }

    #[tokio::test]
    async fn writes_a_name_longer_than_the_partial_stem_budget() {
        // 200 bytes is past what a partial name can echo but well inside a path component, so
        // the upload must land: the budget shortens the partial, never the file.
        let temp = tempfile::tempdir().unwrap();
        let long = format!("{}.txt", "x".repeat(196));
        assert_eq!(long.len(), 200);
        assert!(long.len() > max_transfer_stem_bytes(UPLOAD_PARTIAL_SUFFIX));
        let written = write_upload_in(temp.path(), &long, false, 1024, body(&[b"hello"]))
            .await
            .unwrap();
        assert_eq!(written.file_name().unwrap().to_string_lossy(), long);
        assert_eq!(std::fs::read(&written).unwrap(), b"hello");
        assert_eq!(entry_names(temp.path()), vec![long]);

        // One byte past the component limit is still refused, before anything is opened.
        let over = "x".repeat(MAX_PATH_COMPONENT_BYTES + 1);
        assert!(matches!(
            write_upload_in(temp.path(), &over, false, 1024, body(&[b"x"])).await,
            Err(TransferError::InvalidFileName { .. })
        ));
    }

    #[tokio::test]
    async fn enforces_the_byte_limit_and_removes_partials_and_the_reservation() {
        let temp = tempfile::tempdir().unwrap();
        // Two chunks: the first is written to the partial before the second blows the limit,
        // so this proves already-written bytes are cleaned up, not just an empty partial.
        let error = write_upload_in(temp.path(), "big.bin", false, 4, body(&[b"1234", b"5"]))
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
        let error = write_upload_in(temp.path(), "a.txt", false, 1024, body)
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
            write_upload_in(temp.path(), "a.txt", true, 1024, body)
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
            async move { write_upload_in(&directory, "a.txt", false, 1024, Box::pin(slow)).await }
        });
        // Give the first call time to reserve the name before the second one tries.
        tokio::task::yield_now().await;
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !temp.path().join("a.txt").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("the first upload reserves the name");
        let second = write_upload_in(temp.path(), "a.txt", false, 1024, body(&[b"second"]))
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
        let long = "x".repeat(MAX_PATH_COMPONENT_BYTES);
        let first = partial_file_name(&long);
        let second = partial_file_name(&long);
        assert_ne!(first, second);
        for name in [&first, &second] {
            assert!(name.len() <= MAX_PATH_COMPONENT_BYTES, "{name}");
            assert!(name.ends_with(".bibcode-upload.part"));
            assert!(!name.contains('/'));
        }
        // A budget that lands mid-scalar backs off to a boundary: one ASCII byte then 3-byte
        // characters puts the budget inside a character, so the stem stops short of it.
        let budget = max_transfer_stem_bytes(UPLOAD_PARTIAL_SUFFIX);
        let multi_byte = partial_file_name(&format!("a{}", "\u{2603}".repeat(100)));
        assert!(multi_byte.len() <= MAX_PATH_COMPONENT_BYTES, "{multi_byte}");
        let snowmen = (budget - 1) / "\u{2603}".len();
        assert!(
            multi_byte.starts_with(&format!(".a{}.", "\u{2603}".repeat(snowmen))),
            "{multi_byte}"
        );
        // The prefix really is short of the budget, so the back-off was exercised.
        assert!(1 + snowmen * "\u{2603}".len() < budget);
    }

    #[tokio::test]
    async fn never_replaces_a_directory() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("dir")).unwrap();
        for overwrite in [true, false] {
            let error = write_upload_in(temp.path(), "dir", overwrite, 1024, body(&[b"x"]))
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
