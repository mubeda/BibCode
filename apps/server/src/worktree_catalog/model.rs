use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorktreeRegistrationState {
    Registered,
    Prunable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeDirectoryState {
    Present,
    Missing,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeAdoptionState {
    None,
    Active,
    Archived,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdoptedWorktreeAvailability {
    Present,
    VerificationUnavailable,
    MissingRegistered,
    MissingUnregistered,
    Removing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDescriptor {
    pub worktree_key: String,
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_primary: bool,
    pub is_bare: bool,
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
    pub registration_state: WorktreeRegistrationState,
    pub directory_state: WorktreeDirectoryState,
    pub adoption_state: WorktreeAdoptionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adopted_thread_id: Option<String>,
    pub eligible_for_adoption: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdoptionValidationErrorReason {
    WorktreeNotFound,
    Ineligible,
    WorkspaceMissing,
    RepositoryMismatch,
    CatalogUnavailable,
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("{message}")]
pub struct AdoptionValidationError {
    pub reason: AdoptionValidationErrorReason,
    pub message: String,
    pub current_generation: Option<u64>,
}

impl AdoptionValidationError {
    pub(crate) fn new(
        reason: AdoptionValidationErrorReason,
        message: impl Into<String>,
        current_generation: Option<u64>,
    ) -> Self {
        Self {
            reason,
            message: bounded_message(message.into()),
            current_generation,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedAdoptionCandidate {
    pub worktree_key: String,
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptedWorktreeStatus {
    pub thread_id: String,
    pub worktree_key: Option<String>,
    pub path: String,
    pub branch: Option<String>,
    pub availability: AdoptedWorktreeAvailability,
    pub registration_state: Option<WorktreeRegistrationState>,
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogDegradedReason {
    AnchorUnavailable,
    GitUnavailable,
    GitFailed,
    TimedOut,
    MalformedOutput,
    OutputLimit,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "_tag", rename_all = "lowercase")]
pub enum CatalogScanStatus {
    Ready,
    Refreshing,
    Degraded {
        reason: CatalogDegradedReason,
        message: String,
        #[serde(rename = "failedAt")]
        failed_at: String,
        #[serde(rename = "lastAuthoritativeAt")]
        last_authoritative_at: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCatalogSnapshot {
    pub repository_key: String,
    pub generation: u64,
    pub authoritative: bool,
    pub observed_at: String,
    pub scan_status: CatalogScanStatus,
    pub worktrees: Vec<WorktreeDescriptor>,
    pub adopted_workspaces: Vec<AdoptedWorktreeStatus>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogErrorReason {
    ProjectNotFound,
    EnvironmentUnsupported,
    RepositoryUnavailable,
    StaleGeneration,
    PolicyUpdateFailed,
    Internal,
}

#[derive(Clone, Debug, Eq, Error, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct CatalogError {
    #[serde(rename = "_tag")]
    pub tag: &'static str,
    pub reason: CatalogErrorReason,
    pub message: String,
}

impl CatalogError {
    pub(crate) fn new(reason: CatalogErrorReason, message: impl Into<String>) -> Self {
        Self {
            tag: "WorktreeCatalogError",
            reason,
            message: bounded_message(message.into()),
        }
    }
}

pub(crate) fn bounded_message(mut message: String) -> String {
    const MAX_MESSAGE_LENGTH: usize = 2_048;
    if message.len() <= MAX_MESSAGE_LENGTH {
        return message;
    }
    let mut boundary = MAX_MESSAGE_LENGTH;
    while !message.is_char_boundary(boundary) {
        boundary -= 1;
    }
    message.truncate(boundary);
    message
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogRefreshTrigger {
    FirstSubscriber,
    Focus,
    Explicit,
    MetadataChanged,
    AvailabilityChanged,
    Mutation,
}
