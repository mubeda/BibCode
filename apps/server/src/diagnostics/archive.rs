//! What both `bibcode diagnostics download` paths do with an archive once it arrives: the
//! relay through the desktop app (#201) and a remote this command paired with itself (#202).
//! Every bound is checked before anything is decoded or kept, as the app's
//! `DiagnosticLogsAssembler` (`packages/client-runtime/src/diagnostics/logs.ts`) checks them:
//! the announced size against the 20 MiB limit, each item's encoded length against the
//! 64 KiB item bound and the bytes still expected, and the total against the announcement.
//! The archive's own `manifest.json` must then name what its announcement named, and it is
//! published under its name without ever replacing a file.

use std::{
    io::{self, Cursor, Read as _, Write as _},
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

use crate::{
    diagnostic_bundle::MAX_DIAGNOSTIC_ARCHIVE_BYTES,
    production::{
        diagnostic_logs_relay::{is_archive_name, is_deceptive_char},
        diagnostic_logs_rpc::DIAGNOSTIC_LOGS_CHUNK_BYTES,
    },
};

/// The longest base64 text of one item: [`DIAGNOSTIC_LOGS_CHUNK_BYTES`] encoded, padded.
pub(crate) const MAX_ENCODED_ITEM_BYTES: usize = DIAGNOSTIC_LOGS_CHUNK_BYTES.div_ceil(3) * 4;

/// Fresh names tried for the temporary file before giving up.
const TEMPORARY_ATTEMPTS: usize = 8;

/// The request code alphabet: no 0/O or 1/I, so it reads back unambiguously.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

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

    pub(crate) fn failed(reason: &str, message: impl Into<String>) -> Self {
        Self::Failed {
            reason: reason.to_owned(),
            message: message.into(),
        }
    }

    pub(crate) fn unavailable(reason: &str, message: impl Into<String>) -> Self {
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
        .filter(|character| !is_deceptive_char(*character))
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

/// Publishes `bytes` as a new `directory/file_name`, never over an existing file: written
/// and synced to a temporary file beside it (a fresh name, retried if one is taken), then
/// hard-linked under the name, which fails if the name exists. Without hard links there is
/// no publish that cannot replace a file, so the command fails instead of risking a partial
/// archive under the name. Only the temporary file this call created is removed.
pub(crate) fn save_new(
    directory: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, Outcome> {
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
    if path.symlink_metadata().is_ok() {
        return Err(exists());
    }
    let temporary = write_temporary(directory, file_name, bytes)?;
    let published = match std::fs::hard_link(&temporary, &path) {
        Ok(()) => Ok(path.clone()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(exists()),
        Err(error) => Err(Outcome::failed(
            "no-safe-publish",
            format!(
                "{} cannot hold hard links ({error}), so the archive cannot be saved without \
                 risking a partial file. Nothing was saved; pass an --output on a local disk.",
                directory.display()
            ),
        )),
    };
    let _ = std::fs::remove_file(&temporary);
    published
}

/// Writes and syncs `bytes` to a new hidden file in `directory`, retrying with a fresh name
/// when one is taken. A name another process holds is never touched.
pub(crate) fn write_temporary(
    directory: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, Outcome> {
    write_temporary_named(directory, file_name, bytes, &mut new_request_code)
}

pub(crate) fn write_temporary_named(
    directory: &Path,
    file_name: &str,
    bytes: &[u8],
    next_suffix: &mut dyn FnMut() -> io::Result<String>,
) -> Result<PathBuf, Outcome> {
    let failed = |target: &Path, error: io::Error| {
        Outcome::failed(
            "write-failed",
            format!("Could not write {}: {error}", target.display()),
        )
    };
    for _ in 0..TEMPORARY_ATTEMPTS {
        let suffix = next_suffix().map_err(|error| failed(directory, error))?;
        let temporary = directory.join(format!(".{file_name}.{suffix}.partial"));
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(failed(&temporary, error)),
        };
        // From here the file is this call's own.
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(failed(&temporary, error));
        }
        return Ok(temporary);
    }
    Err(failed(
        directory,
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "every temporary name tried was taken",
        ),
    ))
}

/// The archive's own `manifest.json` names the environment and store the app's manifest
/// does, and both are present and non-empty: what is saved is what the app checked against
/// its connection.
pub(crate) fn archive_matches_manifest(bytes: &[u8], manifest: &Value) -> bool {
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

/// An archive being received: announced by `started`, filled by `data` items, then finished.
pub(crate) struct ArchiveReceiver {
    file_name: String,
    manifest: Value,
    expected: usize,
    bytes: Vec<u8>,
}

fn protocol() -> Outcome {
    Outcome::failed(
        "protocol",
        "BiBCode sent a reply this command does not understand. Nothing was saved.",
    )
}

fn incomplete_item() -> Outcome {
    Outcome::failed(
        "incomplete",
        "BiBCode sent more than the archive it announced. Nothing was saved.",
    )
}

impl ArchiveReceiver {
    /// Checks the announcement: a length, an archive name, the size bound, a manifest object.
    pub(crate) fn start(
        file_name: &str,
        byte_length: Option<u64>,
        manifest: Option<Value>,
    ) -> Result<Self, Outcome> {
        let byte_length = byte_length
            .and_then(|length| usize::try_from(length).ok())
            .ok_or_else(protocol)?;
        if !is_archive_name(file_name) {
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
        let manifest = manifest.filter(Value::is_object).ok_or_else(protocol)?;
        Ok(Self {
            file_name: file_name.to_owned(),
            manifest,
            expected: byte_length,
            bytes: Vec::with_capacity(byte_length),
        })
    }

    /// The manifest the announcement carried.
    pub(crate) fn manifest(&self) -> &Value {
        &self.manifest
    }

    /// Accepts one base64 item. Its length is checked against the item bound and the bytes
    /// still expected before it is decoded, so an oversized item costs no decoding.
    pub(crate) fn accept_encoded(&mut self, encoded: &str) -> Result<(), Outcome> {
        let text = encoded.as_bytes();
        if text.is_empty() || !text.len().is_multiple_of(4) || text.len() > MAX_ENCODED_ITEM_BYTES {
            return Err(incomplete_item());
        }
        let padding = text
            .iter()
            .rev()
            .take(2)
            .filter(|byte| **byte == b'=')
            .count();
        let decoded_length = text.len() / 4 * 3 - padding;
        let remaining = self.expected - self.bytes.len();
        if decoded_length > DIAGNOSTIC_LOGS_CHUNK_BYTES || decoded_length > remaining {
            return Err(incomplete_item());
        }
        let data = STANDARD.decode(text).map_err(|_| protocol())?;
        if data.len() != decoded_length {
            return Err(protocol());
        }
        self.bytes.extend_from_slice(&data);
        Ok(())
    }

    /// Checks the total and the inner manifest, then publishes the archive in `output`.
    pub(crate) fn finish(self, output: &Path) -> Result<Outcome, Outcome> {
        if self.bytes.len() != self.expected {
            return Err(Outcome::failed(
                "incomplete",
                "The archive arrived incomplete. Nothing was saved.",
            ));
        }
        if !archive_matches_manifest(&self.bytes, &self.manifest) {
            return Err(Outcome::failed(
                "wrong-environment",
                "The archive's manifest does not name the environment BiBCode checked. Nothing was saved.",
            ));
        }
        let path = save_new(output, &self.file_name, &self.bytes)?;
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        Ok(Outcome::Saved {
            path,
            file_name: self.file_name,
            byte_length: self.expected as u64,
            manifest: self.manifest,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receiver(byte_length: usize) -> ArchiveReceiver {
        ArchiveReceiver::start(
            "bibcode-diagnostics-box-20261028T000000Z.zip",
            Some(byte_length as u64),
            Some(json!({ "storageInstanceId": "s", "environmentId": "e" })),
        )
        .expect("announcement")
    }

    fn reason(outcome: &Outcome) -> &str {
        match outcome {
            Outcome::Failed { reason, .. }
            | Outcome::Denied { reason, .. }
            | Outcome::Unavailable { reason, .. } => reason,
            Outcome::Saved { .. } => "saved",
        }
    }

    #[test]
    fn the_encoded_item_bound_is_the_padded_base64_of_one_item() {
        assert_eq!(
            MAX_ENCODED_ITEM_BYTES,
            STANDARD
                .encode(vec![0_u8; DIAGNOSTIC_LOGS_CHUNK_BYTES])
                .len()
        );
    }

    #[test]
    fn an_item_over_the_encoded_bound_is_refused_before_it_is_decoded() {
        let mut receiving = receiver(MAX_DIAGNOSTIC_ARCHIVE_BYTES);
        // Not even valid base64: refused by its length alone, so it was never decoded.
        let oversized = "!".repeat(MAX_ENCODED_ITEM_BYTES + 4);
        assert_eq!(
            reason(&receiving.accept_encoded(&oversized).expect_err("too long")),
            "incomplete"
        );
        // An item at the bound that would exceed what is still expected is refused too.
        let mut small = receiver(10);
        let at_bound = STANDARD.encode(vec![7_u8; DIAGNOSTIC_LOGS_CHUNK_BYTES]);
        assert_eq!(
            reason(&small.accept_encoded(&at_bound).expect_err("over expected")),
            "incomplete"
        );
        // A full item within the expected length is accepted.
        let mut full = receiver(DIAGNOSTIC_LOGS_CHUNK_BYTES);
        full.accept_encoded(&at_bound).expect("full item");
    }

    #[test]
    fn malformed_items_are_refused() {
        let mut receiving = receiver(100);
        for item in ["", "abc", "a===", "@@@@"] {
            assert!(receiving.accept_encoded(item).is_err(), "{item:?}");
        }
    }
}
