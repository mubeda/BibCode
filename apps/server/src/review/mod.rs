use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

pub type ReviewFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<ReviewDiffPreviewResult>, ReviewError>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffPreviewInput {
    pub cwd: String,
    pub base_ref: Option<String>,
    pub ignore_whitespace: Option<bool>,
    /// Lines of context around each change, passed to Git as `-U<N>`. Omitted, Git's own
    /// default (`diff.context`, or 3) applies.
    #[serde(default)]
    pub context_lines: Option<u8>,
}

/// The most context lines a client may ask a review diff for.
pub const MAX_REVIEW_CONTEXT_LINES: u8 = 99;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffPreviewResult {
    pub cwd: String,
    pub generated_at: u64,
    pub sources: Vec<ReviewSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSource {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub base_ref: Option<String>,
    pub head_ref: Option<String>,
    pub diff: String,
    pub diff_hash: String,
    pub truncated: bool,
    /// The `contextLines` this source was diffed with; omitted when Git's default applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_lines: Option<u8>,
}

#[derive(Debug, Error)]
pub enum ReviewError {
    #[allow(dead_code)]
    #[error("review backend failed: {0}")]
    Backend(String),
    /// A request the server refuses before it starts Git.
    #[error("{0}")]
    InvalidRequest(String),
}

/// Refuses review inputs that must never reach Git: a context count outside `0..=99`, and a
/// base ref Git would read as an option (`git check-ref-format --branch` forbids that form
/// for branch names, so no real branch is refused).
pub fn validate_review_diff_options(
    base_ref: Option<&str>,
    context_lines: Option<u8>,
) -> Result<(), ReviewError> {
    if context_lines.is_some_and(|lines| lines > MAX_REVIEW_CONTEXT_LINES) {
        return Err(ReviewError::InvalidRequest(format!(
            "contextLines must be an integer from 0 to {MAX_REVIEW_CONTEXT_LINES}."
        )));
    }
    if base_ref.is_some_and(|base_ref| base_ref.trim_start().starts_with('-')) {
        return Err(ReviewError::InvalidRequest(
            "baseRef must not start with \"-\".".to_owned(),
        ));
    }
    Ok(())
}

pub type ReviewFileVersionFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ReviewFileVersion, ReviewError>> + Send + 'a>>;

/// `review.readFileVersion`: one side of a changed file, named by the content it must have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReadFileVersionInput {
    pub cwd: String,
    pub version: ReviewFileVersionRequest,
}

/// A blob by its object ID, or the working-tree file whose current content the patch named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "_tag",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewFileVersionRequest {
    Blob { oid: String },
    Worktree { path: String, expected_oid: String },
}

/// Why a version has no text to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewFileVersionUnavailable {
    Missing,
    Binary,
    TooLarge,
    NotAFile,
    /// The working-tree file no longer has the content the patch named.
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "_tag",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewFileVersion {
    Text {
        contents: String,
        byte_length: u64,
    },
    Unavailable {
        reason: ReviewFileVersionUnavailable,
        byte_length: Option<u64>,
    },
}

/// Lowercase hex, 40 digits (SHA-1) or 64 (SHA-256). Such an ID can be neither an option nor
/// a path.
#[must_use]
pub fn is_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub trait ReviewBackend: Send + Sync {
    fn get_diff_preview<'a>(&'a self, input: &'a ReviewDiffPreviewInput) -> ReviewFuture<'a>;

    /// Reads one side of a changed file. `cancellation` is the request's: it stops Git.
    fn read_file_version<'a>(
        &'a self,
        _input: &'a ReviewReadFileVersionInput,
        _cancellation: &'a CancellationToken,
    ) -> ReviewFileVersionFuture<'a> {
        Box::pin(async {
            Err(ReviewError::Backend(
                "review.readFileVersion is not supported".to_owned(),
            ))
        })
    }
}

#[derive(Clone)]
pub struct ReviewService {
    backend: Arc<dyn ReviewBackend>,
}

impl ReviewService {
    pub fn new(backend: Arc<dyn ReviewBackend>) -> Self {
        Self { backend }
    }

    pub async fn get_diff_preview(
        &self,
        input: ReviewDiffPreviewInput,
    ) -> Result<ReviewDiffPreviewResult, ReviewError> {
        validate_review_diff_options(input.base_ref.as_deref(), input.context_lines)?;
        if let Some(result) = self.backend.get_diff_preview(&input).await? {
            return Ok(result);
        }
        Ok(ReviewDiffPreviewResult {
            cwd: input.cwd,
            generated_at: now_millis(),
            sources: Vec::new(),
        })
    }

    pub async fn read_file_version(
        &self,
        input: ReviewReadFileVersionInput,
        cancellation: &CancellationToken,
    ) -> Result<ReviewFileVersion, ReviewError> {
        let oid = match &input.version {
            ReviewFileVersionRequest::Blob { oid } => oid,
            ReviewFileVersionRequest::Worktree { expected_oid, .. } => expected_oid,
        };
        if !is_git_object_id(oid) {
            return Err(ReviewError::InvalidRequest(
                "An object ID must be 40 or 64 lowercase hexadecimal digits.".to_owned(),
            ));
        }
        self.backend.read_file_version(&input, cancellation).await
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
