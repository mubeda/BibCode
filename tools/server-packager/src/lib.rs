//! Deterministic BiBCode Server staging and release verification.

pub mod archive;
pub mod model;
pub mod stage;
pub mod verify;

use std::{io, path::PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum PackagerError {
    #[error("invalid server artifact manifest: {0}")]
    Manifest(String),
    #[error("server artifact path is unsafe: {0}")]
    UnsafePath(String),
    #[error("server artifact integrity verification failed: {0}")]
    Integrity(String),
    #[error("failed to {operation} {path}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to encode ZIP archive")]
    Zip(#[from] zip::result::ZipError),
}
