use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use hmac::{Hmac, KeyInit as _, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;

use crate::workspace::WorkspaceError;

pub mod archive;
pub mod upload;

/// How long an issued transfer token remains valid.
pub const TRANSFER_TOKEN_TTL: Duration = Duration::from_secs(5 * 60);
/// Maximum number of bytes accepted for a single upload.
pub const MAX_UPLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const TRANSFER_URL_PREFIX: &str = "/api/transfers/";

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TransferClaims {
    Download {
        root: PathBuf,
        relative: String,
        expires_at: u64,
    },
    Upload {
        root: PathBuf,
        relative_dir: String,
        max_bytes: u64,
        expires_at: u64,
    },
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
        self.issue(TransferClaims::Download {
            root: root.to_path_buf(),
            relative: relative.to_owned(),
            expires_at: self.expiry(),
        })
    }

    pub fn issue_upload(
        &self,
        root: &Path,
        relative_dir: &str,
    ) -> Result<IssuedTransferUrl, TransferError> {
        self.issue(TransferClaims::Upload {
            root: root.to_path_buf(),
            relative_dir: relative_dir.to_owned(),
            max_bytes: MAX_UPLOAD_BYTES,
            expires_at: self.expiry(),
        })
    }

    pub fn verify(&self, token: &str) -> Option<TransferClaims> {
        let (payload, signature) = token.split_once('.')?;
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(signature)
            .ok()?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret).ok()?;
        mac.update(payload.as_bytes());
        mac.verify_slice(&signature).ok()?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .ok()?;
        let claims: TransferClaims = serde_json::from_slice(&bytes).ok()?;
        (claims.expires_at() > now_millis()).then_some(claims)
    }

    fn issue(&self, claims: TransferClaims) -> Result<IssuedTransferUrl, TransferError> {
        let expires_at = claims.expires_at();
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret)
            .expect("HMAC accepts arbitrary key lengths");
        mac.update(payload.as_bytes());
        let signature =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        Ok(IssuedTransferUrl {
            relative_url: format!("{TRANSFER_URL_PREFIX}{payload}.{signature}"),
            expires_at,
        })
    }

    fn expiry(&self) -> u64 {
        now_millis().saturating_add(u64::try_from(self.ttl.as_millis()).unwrap_or(u64::MAX))
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn upload_token_binds_directory_and_limit_and_rejects_tampering() {
        let access = TransferAccess::new(b"secret".to_vec());
        let issued = access.issue_upload(Path::new("/repo"), "").unwrap();
        let token = issued.relative_url.rsplit('/').next().unwrap().to_owned();
        match access.verify(&token) {
            Some(TransferClaims::Upload {
                relative_dir,
                max_bytes,
                ..
            }) => {
                assert_eq!(relative_dir, "");
                assert_eq!(max_bytes, MAX_UPLOAD_BYTES);
            }
            other => panic!("unexpected claims: {other:?}"),
        }
        let other = TransferAccess::new(b"other".to_vec());
        assert!(other.verify(&token).is_none());
        assert!(access.verify(&format!("{token}x")).is_none());
        assert!(issued.relative_url.starts_with("/api/transfers/"));
    }
}
