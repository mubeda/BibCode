use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::signed_token;
use crate::workspace::WorkspaceError;

pub mod archive;
pub mod staging;
pub mod upload;

/// How long an issued transfer token remains valid.
pub const TRANSFER_TOKEN_TTL: Duration = Duration::from_secs(5 * 60);
/// Maximum number of bytes accepted for a single upload.
pub const MAX_UPLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const TRANSFER_URL_PREFIX: &str = "/api/transfers/";
/// Domain separation for [`crate::signed_token`]: transfer tokens share the server secret with
/// asset tokens, and only this purpose keeps an asset capability from verifying as a transfer
/// one (and so from becoming an upload).
const TRANSFER_TOKEN_PURPOSE: &str = "transfer";

#[derive(Debug, Error)]
pub enum TransferError {
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error("transfer token encoding failed: {0}")]
    Encoding(#[from] serde_json::Error),
    #[error("archive exceeds {limit} entries")]
    TooManyEntries { limit: usize },
    #[error("archive exceeds {limit} bytes")]
    TooManyBytes { limit: u64 },
    #[error("the transfer ended because its access ended")]
    Cancelled,
    #[error("upload exceeds {limit} bytes")]
    UploadTooLarge { limit: u64 },
    #[error("upload target already exists: {path}", path = .path.display())]
    EntryExists { path: PathBuf },
    #[error("invalid upload file name: {name}")]
    InvalidFileName { name: String },
    #[error("transfer operation '{operation}' failed at {path}: {source}", path = .path.display())]
    Operation {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl TransferError {
    pub(crate) fn operation(operation: &'static str, path: &Path, source: std::io::Error) -> Self {
        Self::Operation {
            operation,
            path: path.to_path_buf(),
            source,
        }
    }
}

/// The file name a download is presented under: the entry's own name, with `.zip` appended when
/// the entry is a folder streamed as an archive. One helper so the name the mint reports and the
/// name the route puts in `Content-Disposition` can never drift apart.
#[must_use]
pub fn download_file_name(canonical: &Path, is_directory: bool) -> String {
    let name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_owned());
    if is_directory {
        format!("{name}.zip")
    } else {
        name
    }
}

/// A byte budget as a person reads it: "2 GiB", "1.5 MiB", "900 bytes". Mirrors the Files
/// panel's `describeByteLimit`, so a limit the server names reads the same as one the UI names.
#[must_use]
pub fn describe_bytes(bytes: u64) -> String {
    const UNITS: &[(&str, u64)] = &[
        ("GiB", 1024 * 1024 * 1024),
        ("MiB", 1024 * 1024),
        ("KiB", 1024),
    ];
    for (label, size) in UNITS {
        if bytes >= *size {
            #[expect(
                clippy::cast_precision_loss,
                reason = "a human-readable size needs no more precision than an f64 carries"
            )]
            let value = bytes as f64 / *size as f64;
            return if (value.fract()).abs() < f64::EPSILON {
                format!("{value:.0} {label}")
            } else {
                format!("{value:.1} {label}")
            };
        }
    }
    format!("{bytes} bytes")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TransferClaims {
    Download {
        root: PathBuf,
        relative: String,
        expires_at: u64,
        /// The outside agent's session that minted it (#139 X5). The route serves it only
        /// while that session's access lasts. The UI's tokens leave it out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mcp_session_id: Option<String>,
    },
    Upload {
        root: PathBuf,
        relative_dir: String,
        /// The one file name this token authorises. The upload route writes this name and no
        /// other, so a leaked URL can overwrite only the file the mint named.
        file_name: String,
        max_bytes: u64,
        expires_at: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mcp_session_id: Option<String>,
        /// Whether the upload may replace an existing file, decided at the mint. `None` (the
        /// UI's tokens) leaves it to the route's `?overwrite=1`; a bound `false` refuses it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        overwrite: Option<bool>,
    },
}

/// What a mint binds into a token beyond its target: the minting agent's session, and for an
/// upload whether it may overwrite. [`Default`] is the UI's unbound token.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TransferBinding {
    pub mcp_session_id: Option<String>,
    pub overwrite: Option<bool>,
}

/// A short id of one transfer URL, the same at the mint and at the route, for the activity
/// rows that attribute it (#139 X5). It reveals nothing of the token.
#[must_use]
pub fn transfer_id(url_or_token: &str) -> String {
    let token = url_or_token.rsplit('/').next().unwrap_or(url_or_token);
    let mut id = crate::crypto::sha256_hex(token);
    id.truncate(24);
    format!("t-{id}")
}

impl TransferClaims {
    fn expires_at(&self) -> u64 {
        match self {
            Self::Download { expires_at, .. } | Self::Upload { expires_at, .. } => *expires_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedTransferUrl {
    pub relative_url: String,
    pub expires_at: u64,
}

#[derive(Clone)]
pub struct TransferAccess {
    secret: Vec<u8>,
    ttl: Duration,
}

impl TransferAccess {
    pub fn new(secret: Vec<u8>) -> Self {
        Self::with_ttl(secret, TRANSFER_TOKEN_TTL)
    }

    pub fn with_ttl(secret: Vec<u8>, ttl: Duration) -> Self {
        Self { secret, ttl }
    }

    pub fn issue_download(
        &self,
        root: &Path,
        relative: &str,
    ) -> Result<IssuedTransferUrl, TransferError> {
        self.issue_download_bound(root, relative, &TransferBinding::default())
    }

    /// [`Self::issue_download`] bound to `binding`'s session.
    pub fn issue_download_bound(
        &self,
        root: &Path,
        relative: &str,
        binding: &TransferBinding,
    ) -> Result<IssuedTransferUrl, TransferError> {
        self.issue(TransferClaims::Download {
            root: root.to_path_buf(),
            relative: relative.to_owned(),
            expires_at: self.expiry(),
            mcp_session_id: binding.mcp_session_id.clone(),
        })
    }

    /// Mints an upload capability for exactly one file name in one directory. The name is
    /// validated here so a token can never carry one the write would refuse.
    pub fn issue_upload(
        &self,
        root: &Path,
        relative_dir: &str,
        file_name: &str,
    ) -> Result<IssuedTransferUrl, TransferError> {
        self.issue_upload_with_limit(root, relative_dir, file_name, MAX_UPLOAD_BYTES)
    }

    /// [`Self::issue_upload`] with an explicit byte cap, so a caller -- or a test -- can bind a
    /// token to a tighter limit than the server-wide maximum.
    pub fn issue_upload_with_limit(
        &self,
        root: &Path,
        relative_dir: &str,
        file_name: &str,
        max_bytes: u64,
    ) -> Result<IssuedTransferUrl, TransferError> {
        self.issue_upload_bound(
            root,
            relative_dir,
            file_name,
            max_bytes,
            &TransferBinding::default(),
        )
    }

    /// [`Self::issue_upload_with_limit`] with `binding`.
    pub fn issue_upload_bound(
        &self,
        root: &Path,
        relative_dir: &str,
        file_name: &str,
        max_bytes: u64,
        binding: &TransferBinding,
    ) -> Result<IssuedTransferUrl, TransferError> {
        upload::validate_upload_file_name(file_name)?;
        self.issue(TransferClaims::Upload {
            root: root.to_path_buf(),
            relative_dir: relative_dir.to_owned(),
            file_name: file_name.to_owned(),
            max_bytes,
            expires_at: self.expiry(),
            mcp_session_id: binding.mcp_session_id.clone(),
            overwrite: binding.overwrite,
        })
    }

    pub fn verify(&self, token: &str) -> Option<TransferClaims> {
        let claims: TransferClaims =
            signed_token::verify(&self.secret, TRANSFER_TOKEN_PURPOSE, token)?;
        (claims.expires_at() > signed_token::now_millis()).then_some(claims)
    }

    fn issue(&self, claims: TransferClaims) -> Result<IssuedTransferUrl, TransferError> {
        let expires_at = claims.expires_at();
        let token = signed_token::sign(&self.secret, TRANSFER_TOKEN_PURPOSE, &claims)?;
        Ok(IssuedTransferUrl {
            relative_url: format!("{TRANSFER_URL_PREFIX}{token}"),
            expires_at,
        })
    }

    fn expiry(&self) -> u64 {
        signed_token::now_millis()
            .saturating_add(u64::try_from(self.ttl.as_millis()).unwrap_or(u64::MAX))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_downloads_after_the_entry_and_zips_folders() {
        assert_eq!(
            download_file_name(Path::new("/repo/src/app.ts"), false),
            "app.ts"
        );
        assert_eq!(download_file_name(Path::new("/repo/src"), true), "src.zip");
        assert_eq!(download_file_name(Path::new("/"), false), "download");
        assert_eq!(download_file_name(Path::new("/"), true), "download.zip");
    }

    #[test]
    fn describes_byte_budgets_the_way_a_person_reads_them() {
        assert_eq!(describe_bytes(2 * 1024 * 1024 * 1024), "2 GiB");
        assert_eq!(describe_bytes(1024 * 1024 * 3 / 2), "1.5 MiB");
        assert_eq!(describe_bytes(2048), "2 KiB");
        assert_eq!(describe_bytes(900), "900 bytes");
    }

    #[test]
    fn download_token_round_trips_and_expires() {
        let access = TransferAccess::with_ttl(b"secret".to_vec(), Duration::from_secs(60));
        let issued = access
            .issue_download(Path::new("/repo"), "src/app.ts")
            .unwrap();
        let token = issued.relative_url.rsplit('/').next().unwrap();
        match access.verify(token) {
            Some(TransferClaims::Download { root, relative, .. }) => {
                assert_eq!(root, PathBuf::from("/repo"));
                assert_eq!(relative, "src/app.ts");
            }
            other => panic!("unexpected claims: {other:?}"),
        }
        let expired = TransferAccess::with_ttl(b"secret".to_vec(), Duration::ZERO);
        let issued = expired.issue_download(Path::new("/repo"), "src").unwrap();
        std::thread::sleep(Duration::from_millis(2));
        assert!(
            expired
                .verify(issued.relative_url.rsplit('/').next().unwrap())
                .is_none()
        );
    }

    #[test]
    fn upload_token_binds_one_file_name_directory_and_limit_and_rejects_tampering() {
        let access = TransferAccess::new(b"secret".to_vec());
        let issued = access
            .issue_upload(Path::new("/repo"), "", "report.pdf")
            .unwrap();
        let token = issued.relative_url.rsplit('/').next().unwrap().to_owned();
        match access.verify(&token) {
            Some(TransferClaims::Upload {
                relative_dir,
                file_name,
                max_bytes,
                ..
            }) => {
                assert_eq!(relative_dir, "");
                assert_eq!(file_name, "report.pdf");
                assert_eq!(max_bytes, MAX_UPLOAD_BYTES);
            }
            other => panic!("unexpected claims: {other:?}"),
        }
        let other = TransferAccess::new(b"other".to_vec());
        assert!(other.verify(&token).is_none());
        assert!(access.verify(&format!("{token}x")).is_none());
        assert!(issued.relative_url.starts_with("/api/transfers/"));
    }

    #[test]
    fn a_token_is_never_minted_for_a_name_the_write_would_refuse() {
        let access = TransferAccess::new(b"secret".to_vec());
        for bad in ["", "..", "../escape", "a/b"] {
            assert!(
                matches!(
                    access.issue_upload(Path::new("/repo"), "", bad),
                    Err(TransferError::InvalidFileName { .. })
                ),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_token_signed_for_the_asset_purpose_is_not_a_transfer_token() {
        // Assets and transfers share one server secret, so the purpose in the MAC input is the
        // only thing stopping a read-only asset capability from redeeming as an upload.
        let access = TransferAccess::new(b"secret".to_vec());
        let claims = TransferClaims::Upload {
            root: PathBuf::from("/repo"),
            relative_dir: String::new(),
            file_name: "a.txt".to_owned(),
            max_bytes: MAX_UPLOAD_BYTES,
            expires_at: signed_token::now_millis().saturating_add(60_000),
            mcp_session_id: None,
            overwrite: None,
        };
        let as_asset = signed_token::sign(b"secret", "asset", &claims).unwrap();
        assert!(access.verify(&as_asset).is_none());
        let as_transfer = signed_token::sign(b"secret", TRANSFER_TOKEN_PURPOSE, &claims).unwrap();
        assert!(access.verify(&as_transfer).is_some());
    }

    fn claims_json(issued: &IssuedTransferUrl) -> serde_json::Value {
        use base64::Engine as _;
        let token = issued.relative_url.rsplit('/').next().unwrap();
        let payload = token.split('.').next().unwrap();
        serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn a_ui_token_carries_no_binding_and_an_agent_token_binds_its_session_and_overwrite() {
        let access = TransferAccess::new(b"secret".to_vec());
        let ui = access
            .issue_upload(Path::new("/repo"), "", "a.txt")
            .unwrap();
        let fields = claims_json(&ui);
        assert!(fields.get("mcp_session_id").is_none(), "{fields}");
        assert!(fields.get("overwrite").is_none(), "{fields}");
        let ui = access.issue_download(Path::new("/repo"), "a.txt").unwrap();
        assert!(claims_json(&ui).get("mcp_session_id").is_none());

        let binding = TransferBinding {
            mcp_session_id: Some("session-1".into()),
            overwrite: Some(false),
        };
        let bound = access
            .issue_upload_bound(Path::new("/repo"), "", "a.txt", 10, &binding)
            .unwrap();
        let token = bound.relative_url.rsplit('/').next().unwrap();
        match access.verify(token) {
            Some(TransferClaims::Upload {
                mcp_session_id,
                overwrite,
                ..
            }) => {
                assert_eq!(mcp_session_id.as_deref(), Some("session-1"));
                assert_eq!(overwrite, Some(false));
            }
            other => panic!("unexpected claims: {other:?}"),
        }
        let bound = access
            .issue_download_bound(Path::new("/repo"), "a.txt", &binding)
            .unwrap();
        let token = bound.relative_url.rsplit('/').next().unwrap();
        assert!(matches!(
            access.verify(token),
            Some(TransferClaims::Download { mcp_session_id: Some(id), .. }) if id == "session-1"
        ));
        // The id is the same from the URL and from its token, and differs per URL.
        assert_eq!(transfer_id(&bound.relative_url), transfer_id(token));
        assert_ne!(
            transfer_id(&bound.relative_url),
            transfer_id(&ui.relative_url)
        );
        assert!(!transfer_id(token).contains(token));
    }
}
