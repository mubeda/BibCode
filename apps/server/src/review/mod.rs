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
    /// A diff app that did not open, with the command for the user to run themselves.
    #[error("{}", .0.message)]
    DiffTool(ReviewDiffToolFailure),
}

/// Why `review.openDiffTool` did not open the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewDiffToolFailureReason {
    LaunchFailed,
    TooManyOpen,
    ShuttingDown,
    InvalidRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffToolFailure {
    pub reason: ReviewDiffToolFailureReason,
    pub message: String,
    /// The `git difftool` command, for **Copy command**; only the requesting client sees it.
    pub command: Vec<String>,
}

impl ReviewDiffToolFailure {
    #[must_use]
    pub fn new(
        reason: ReviewDiffToolFailureReason,
        message: impl Into<String>,
        command: Vec<String>,
    ) -> Self {
        Self {
            reason,
            message: message.into(),
            command,
        }
    }
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

/// `review.listDiffTools`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewListDiffToolsInput {
    pub cwd: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewDiffToolKind {
    /// One of Git's own tools, found on this computer.
    Builtin,
    /// A `difftool.<tool>.cmd` from the user's Git config.
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffTool {
    pub id: String,
    pub label: String,
    pub kind: ReviewDiffToolKind,
}

/// The Git config key a default tool came from, in Git's own `--gui` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReviewDiffToolDefaultSource {
    #[serde(rename = "diff.guitool")]
    DiffGuiTool,
    #[serde(rename = "merge.guitool")]
    MergeGuiTool,
    #[serde(rename = "diff.tool")]
    DiffTool,
    #[serde(rename = "merge.tool")]
    MergeTool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffToolList {
    pub tools: Vec<ReviewDiffTool>,
    pub default_tool_id: Option<String>,
    pub default_source: Option<ReviewDiffToolDefaultSource>,
}

/// `review.openDiffTool`: what to open, and the scope whose revisions to compare.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOpenDiffToolInput {
    pub cwd: String,
    pub tool_id: String,
    pub target: ReviewDiffToolTarget,
    pub scope: ReviewDiffToolScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "_tag",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewDiffToolTarget {
    File {
        path: String,
        #[serde(default)]
        previous_path: Option<String>,
    },
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "_tag",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewDiffToolScope {
    WorkingTree,
    Branch {
        #[serde(default)]
        base_ref: Option<String>,
    },
    Turn {
        thread_id: String,
        from_turn_count: i64,
        to_turn_count: i64,
    },
}

pub type ReviewDiffToolListFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ReviewDiffToolList, ReviewError>> + Send + 'a>>;
pub type ReviewDiffToolOpenFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), ReviewError>> + Send + 'a>>;

/// Lists and launches diff apps through `git difftool` on the server's computer.
pub trait DiffToolBackend: Send + Sync {
    fn list_diff_tools<'a>(
        &'a self,
        input: &'a ReviewListDiffToolsInput,
        cancellation: &'a CancellationToken,
    ) -> ReviewDiffToolListFuture<'a>;

    fn open_diff_tool<'a>(
        &'a self,
        input: &'a ReviewOpenDiffToolInput,
    ) -> ReviewDiffToolOpenFuture<'a>;
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
    diff_tools: Option<Arc<dyn DiffToolBackend>>,
}

impl ReviewService {
    pub fn new(backend: Arc<dyn ReviewBackend>) -> Self {
        Self {
            backend,
            diff_tools: None,
        }
    }

    /// Serves `review.listDiffTools` and `review.openDiffTool` from `diff_tools`.
    #[must_use]
    pub fn with_diff_tools(mut self, diff_tools: Arc<dyn DiffToolBackend>) -> Self {
        self.diff_tools = Some(diff_tools);
        self
    }

    pub async fn list_diff_tools(
        &self,
        input: ReviewListDiffToolsInput,
        cancellation: &CancellationToken,
    ) -> Result<ReviewDiffToolList, ReviewError> {
        let diff_tools = self.diff_tools.as_ref().ok_or_else(|| {
            ReviewError::Backend("review.listDiffTools is not configured".to_owned())
        })?;
        diff_tools.list_diff_tools(&input, cancellation).await
    }

    pub async fn open_diff_tool(&self, input: ReviewOpenDiffToolInput) -> Result<(), ReviewError> {
        let diff_tools = self.diff_tools.as_ref().ok_or_else(|| {
            ReviewError::Backend("review.openDiffTool is not configured".to_owned())
        })?;
        diff_tools.open_diff_tool(&input).await
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
