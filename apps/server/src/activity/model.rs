use std::{cmp::Ordering, fmt, str::FromStr};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub const ACTIVITY_ID_MAX_LENGTH: usize = 256;
pub const ACTIVITY_LABEL_MAX_LENGTH: usize = 256;
pub const ACTIVITY_SUMMARY_MAX_LENGTH: usize = 2_048;
pub const ACTIVITY_DETAIL_MAX_LENGTH: usize = 16_384;
pub const ACTIVITY_CURSOR_MAX_LENGTH: usize = 512;
pub const ACTIVITY_PAGE_MAX_LENGTH: usize = 200;
const ACTIVITY_TIMESTAMP_MAX_LENGTH: usize = 64;
const PROVIDER_SLUG_MAX_LENGTH: usize = 64;
pub(crate) const ACTIVITY_DELTA_MAX_CHANGES: usize = 256;

#[derive(Debug, Error)]
pub enum ActivityModelError {
    #[error("{field} must not be empty")]
    Empty { field: &'static str },
    #[error("{field} exceeds its {maximum}-character bound")]
    TooLong { field: &'static str, maximum: usize },
    #[error("{field} is not a valid activity value: {value}")]
    InvalidValue { field: &'static str, value: String },
    #[error("{field} is not a valid RFC 3339 timestamp")]
    InvalidTimestamp { field: &'static str },
    #[error("an activity delta cannot contain more than {ACTIVITY_DELTA_MAX_CHANGES} changes")]
    TooManyChanges,
}

pub type ActivityModelResult<T> = Result<T, ActivityModelError>;

/// An opaque generation fence for one live provider runtime's Activity controls.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ActivityRuntimeGeneration(Uuid);

impl ActivityRuntimeGeneration {
    pub(crate) fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

/// An opaque provider-native cancellation handle.
///
/// The provider identifiers remain inaccessible outside the Rust server and this type deliberately
/// has no serialization implementation.
#[derive(Clone, Eq, Hash, PartialEq)]
pub struct ProviderActivityNativeTarget(ProviderActivityNativeTargetKind);

#[derive(Clone, Eq, Hash, PartialEq)]
#[allow(dead_code)] // Provider adapters install these exact handles in Tasks 6 and 8.
enum ProviderActivityNativeTargetKind {
    CodexTurn { thread_id: String, turn_id: String },
    ClaudeTask { task_id: String },
}

impl ProviderActivityNativeTarget {
    #[allow(dead_code)] // Used by the Codex adapter installed in Task 6.
    pub(crate) fn codex_turn(thread_id: String, turn_id: String) -> Self {
        Self(ProviderActivityNativeTargetKind::CodexTurn { thread_id, turn_id })
    }

    #[allow(dead_code)] // Used by the Claude adapter installed in Task 8.
    pub(crate) fn claude_task(task_id: String) -> Self {
        Self(ProviderActivityNativeTargetKind::ClaudeTask { task_id })
    }

    pub(crate) fn codex_turn_ids(&self) -> Option<(&str, &str)> {
        match &self.0 {
            ProviderActivityNativeTargetKind::CodexTurn { thread_id, turn_id } => {
                Some((thread_id, turn_id))
            }
            ProviderActivityNativeTargetKind::ClaudeTask { .. } => None,
        }
    }

    pub(crate) fn claude_task_id(&self) -> Option<&str> {
        match &self.0 {
            ProviderActivityNativeTargetKind::ClaudeTask { task_id } => Some(task_id),
            ProviderActivityNativeTargetKind::CodexTurn { .. } => None,
        }
    }
}

impl fmt::Debug for ProviderActivityNativeTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            ProviderActivityNativeTargetKind::CodexTurn { .. } => {
                formatter.write_str("CodexTurn { .. }")
            }
            ProviderActivityNativeTargetKind::ClaudeTask { .. } => {
                formatter.write_str("ClaudeTask { .. }")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivitySection {
    Subagents,
    BackgroundTasks,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityRecordKind {
    Actor,
    WorkItem,
}

impl ActivityRecordKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Actor => "actor",
            Self::WorkItem => "workItem",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityRosterBucket {
    Active,
    Done,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityLifecycle {
    Starting,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    Unknown,
}

impl ActivityLifecycle {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::Unknown => "unknown",
        }
    }

    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

impl FromStr for ActivityLifecycle {
    type Err = ActivityModelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "starting" => Ok(Self::Starting),
            "running" => Ok(Self::Running),
            "waiting" => Ok(Self::Waiting),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            "unknown" => Ok(Self::Unknown),
            _ => Err(ActivityModelError::InvalidValue {
                field: "status",
                value: value.to_owned(),
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityObservationState {
    Live,
    Reconnecting,
    Stale,
    Error,
}

impl ActivityObservationState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Reconnecting => "reconnecting",
            Self::Stale => "stale",
            Self::Error => "error",
        }
    }
}

impl FromStr for ActivityObservationState {
    type Err = ActivityModelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "live" => Ok(Self::Live),
            "reconnecting" => Ok(Self::Reconnecting),
            "stale" => Ok(Self::Stale),
            "error" => Ok(Self::Error),
            _ => Err(ActivityModelError::InvalidValue {
                field: "observationState",
                value: value.to_owned(),
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivitySectionObservationState {
    Unsupported,
    Live,
    Stale,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityHistoryRecovery {
    Full,
    Bounded,
    None,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySectionHealth {
    pub state: ActivitySectionObservationState,
    pub message: Option<String>,
    pub retryable: bool,
}

impl ActivitySectionHealth {
    pub fn live() -> Self {
        Self {
            state: ActivitySectionObservationState::Live,
            message: None,
            retryable: false,
        }
    }

    pub fn unsupported() -> Self {
        Self {
            state: ActivitySectionObservationState::Unsupported,
            message: None,
            retryable: false,
        }
    }

    pub fn try_stale(message: impl Into<String>, retryable: bool) -> ActivityModelResult<Self> {
        Ok(Self {
            state: ActivitySectionObservationState::Stale,
            message: Some(validate_text(
                message.into(),
                "section message",
                ACTIVITY_SUMMARY_MAX_LENGTH,
                false,
            )?),
            retryable,
        })
    }

    pub fn try_error(message: impl Into<String>, retryable: bool) -> ActivityModelResult<Self> {
        Ok(Self {
            state: ActivitySectionObservationState::Error,
            message: Some(validate_text(
                message.into(),
                "section message",
                ACTIVITY_SUMMARY_MAX_LENGTH,
                false,
            )?),
            retryable,
        })
    }

    pub(crate) fn validate(&self) -> ActivityModelResult<()> {
        if let Some(message) = &self.message {
            validate_text(
                message.clone(),
                "section message",
                ACTIVITY_SUMMARY_MAX_LENGTH,
                false,
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySectionHealthMap {
    pub subagents: ActivitySectionHealth,
    pub background_tasks: ActivitySectionHealth,
}

impl ActivitySectionHealthMap {
    fn from_capabilities(capabilities: &ActivityCapabilities) -> Self {
        Self {
            subagents: if capabilities.actors {
                ActivitySectionHealth::live()
            } else {
                ActivitySectionHealth::unsupported()
            },
            background_tasks: if capabilities.background_work {
                ActivitySectionHealth::live()
            } else {
                ActivitySectionHealth::unsupported()
            },
        }
    }

    pub(crate) fn get(&self, section: ActivitySection) -> &ActivitySectionHealth {
        match section {
            ActivitySection::Subagents => &self.subagents,
            ActivitySection::BackgroundTasks => &self.background_tasks,
        }
    }

    pub(crate) fn set(&mut self, section: ActivitySection, health: ActivitySectionHealth) {
        match section {
            ActivitySection::Subagents => self.subagents = health,
            ActivitySection::BackgroundTasks => self.background_tasks = health,
        }
    }

    pub(crate) fn validate(&self) -> ActivityModelResult<()> {
        self.subagents.validate()?;
        self.background_tasks.validate()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "_tag",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ActivityScopeRef {
    Thread {
        thread_id: String,
    },
    Terminal {
        thread_id: String,
        terminal_id: String,
    },
}

impl ActivityScopeRef {
    pub(crate) fn validate(&self) -> ActivityModelResult<()> {
        match self {
            Self::Thread { thread_id } => {
                validate_text(thread_id.clone(), "threadId", ACTIVITY_ID_MAX_LENGTH, true)?;
            }
            Self::Terminal {
                thread_id,
                terminal_id,
            } => {
                validate_text(thread_id.clone(), "threadId", ACTIVITY_ID_MAX_LENGTH, true)?;
                validate_text(
                    terminal_id.clone(),
                    "terminalId",
                    ACTIVITY_ID_MAX_LENGTH,
                    true,
                )?;
            }
        }
        Ok(())
    }

    pub(crate) const fn source_kind(&self) -> &'static str {
        match self {
            Self::Thread { .. } => "thread",
            Self::Terminal { .. } => "terminal",
        }
    }

    pub(crate) fn thread_id(&self) -> &str {
        match self {
            Self::Thread { thread_id } | Self::Terminal { thread_id, .. } => thread_id,
        }
    }

    pub(crate) fn terminal_id(&self) -> Option<&str> {
        match self {
            Self::Thread { .. } => None,
            Self::Terminal { terminal_id, .. } => Some(terminal_id),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCapabilities {
    pub actors: bool,
    pub attributed_activity: bool,
    pub background_work: bool,
    pub history_recovery: ActivityHistoryRecovery,
    pub terminal_observation: bool,
    pub targeted_actor_cancellation: bool,
}

impl ActivityCapabilities {
    pub const fn structured_full(terminal_observation: bool) -> Self {
        Self {
            actors: true,
            attributed_activity: true,
            background_work: true,
            history_recovery: ActivityHistoryRecovery::Full,
            terminal_observation,
            targeted_actor_cancellation: false,
        }
    }

    pub const fn none() -> Self {
        Self {
            actors: false,
            attributed_activity: false,
            background_work: false,
            history_recovery: ActivityHistoryRecovery::None,
            terminal_observation: false,
            targeted_actor_cancellation: false,
        }
    }

    pub(crate) fn validate(&self) -> ActivityModelResult<()> {
        if self.attributed_activity && !(self.actors || self.background_work) {
            return Err(ActivityModelError::InvalidValue {
                field: "capabilities",
                value: "attributedActivity requires actors or backgroundWork".to_owned(),
            });
        }
        Ok(())
    }
}

impl Default for ActivityCapabilities {
    fn default() -> Self {
        Self::none()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ActivityActorTag {
    Actor,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityActorSummary {
    #[serde(rename = "_tag")]
    tag: ActivityActorTag,
    pub id: String,
    pub parent_actor_id: Option<String>,
    pub name: String,
    pub role: Option<String>,
    pub provider_type: Option<String>,
    pub status: ActivityLifecycle,
    pub summary: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    pub terminal_at: Option<String>,
}

impl ActivityActorSummary {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        id: impl Into<String>,
        parent_actor_id: Option<&str>,
        name: impl Into<String>,
        role: Option<&str>,
        provider_type: Option<&str>,
        status: ActivityLifecycle,
        summary: Option<&str>,
        started_at: impl Into<String>,
        updated_at: impl Into<String>,
        terminal_at: Option<&str>,
    ) -> ActivityModelResult<Self> {
        let terminal_at = terminal_at.map(str::to_owned);
        let mut value = Self {
            tag: ActivityActorTag::Actor,
            id: validate_text(id.into(), "actor id", ACTIVITY_ID_MAX_LENGTH, true)?,
            parent_actor_id: validate_optional_text(
                parent_actor_id.map(str::to_owned),
                "parent actor id",
                ACTIVITY_ID_MAX_LENGTH,
                true,
            )?,
            name: validate_text(name.into(), "actor name", ACTIVITY_LABEL_MAX_LENGTH, true)?,
            role: validate_optional_text(
                role.map(str::to_owned),
                "actor role",
                ACTIVITY_LABEL_MAX_LENGTH,
                true,
            )?,
            provider_type: validate_optional_text(
                provider_type.map(str::to_owned),
                "provider type",
                ACTIVITY_LABEL_MAX_LENGTH,
                true,
            )?,
            status,
            summary: validate_optional_text(
                summary.map(str::to_owned),
                "actor summary",
                ACTIVITY_SUMMARY_MAX_LENGTH,
                false,
            )?,
            started_at: validate_timestamp(started_at.into(), "startedAt")?,
            updated_at: validate_timestamp(updated_at.into(), "updatedAt")?,
            terminal_at: terminal_at
                .map(|value| validate_timestamp(value, "terminalAt"))
                .transpose()?,
        };
        value.normalize_timestamps()?;
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn status_only(id: String, status: ActivityLifecycle) -> Self {
        Self {
            tag: ActivityActorTag::Actor,
            id,
            parent_actor_id: None,
            name: String::new(),
            role: None,
            provider_type: None,
            status,
            summary: None,
            started_at: String::new(),
            updated_at: String::new(),
            terminal_at: None,
        }
    }

    pub(crate) fn fill_batch_timestamp(&mut self, timestamp: &str) {
        if self.started_at.is_empty() {
            self.started_at = timestamp.to_owned();
        }
        if self.updated_at.is_empty() {
            self.updated_at = timestamp.to_owned();
        }
        if self.status.is_terminal() && self.terminal_at.is_none() {
            self.terminal_at = Some(timestamp.to_owned());
        }
    }

    pub(crate) fn normalize_timestamps(&mut self) -> ActivityModelResult<()> {
        self.started_at = validate_timestamp(self.started_at.clone(), "startedAt")?;
        self.updated_at = validate_timestamp(self.updated_at.clone(), "updatedAt")?;
        self.terminal_at = self
            .terminal_at
            .take()
            .map(|value| validate_timestamp(value, "terminalAt"))
            .transpose()?;
        Ok(())
    }

    pub(crate) fn validate(&self) -> ActivityModelResult<()> {
        validate_text(self.id.clone(), "actor id", ACTIVITY_ID_MAX_LENGTH, true)?;
        if let Some(parent_actor_id) = &self.parent_actor_id {
            validate_text(
                parent_actor_id.clone(),
                "parent actor id",
                ACTIVITY_ID_MAX_LENGTH,
                true,
            )?;
            if parent_actor_id == &self.id {
                return Err(ActivityModelError::InvalidValue {
                    field: "parentActorId",
                    value: parent_actor_id.clone(),
                });
            }
        }
        validate_text(
            self.name.clone(),
            "actor name",
            ACTIVITY_LABEL_MAX_LENGTH,
            true,
        )?;
        validate_optional_text(
            self.role.clone(),
            "actor role",
            ACTIVITY_LABEL_MAX_LENGTH,
            true,
        )?;
        validate_optional_text(
            self.provider_type.clone(),
            "provider type",
            ACTIVITY_LABEL_MAX_LENGTH,
            true,
        )?;
        validate_optional_text(
            self.summary.clone(),
            "actor summary",
            ACTIVITY_SUMMARY_MAX_LENGTH,
            false,
        )?;
        validate_timestamp(self.started_at.clone(), "startedAt")?;
        validate_timestamp(self.updated_at.clone(), "updatedAt")?;
        if let Some(terminal_at) = &self.terminal_at {
            validate_timestamp(terminal_at.clone(), "terminalAt")?;
        }
        if self.status.is_terminal() != self.terminal_at.is_some() {
            return Err(ActivityModelError::InvalidValue {
                field: "terminalAt",
                value: self.terminal_at.clone().unwrap_or_default(),
            });
        }
        validate_record_chronology(
            &self.started_at,
            &self.updated_at,
            self.terminal_at.as_deref(),
        )?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ActivityWorkItemTag {
    WorkItem,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityWorkItemSummary {
    #[serde(rename = "_tag")]
    tag: ActivityWorkItemTag,
    pub id: String,
    pub owner_actor_id: Option<String>,
    pub name: String,
    pub work_kind: String,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub status: ActivityLifecycle,
    pub summary: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    pub terminal_at: Option<String>,
}

impl ActivityWorkItemSummary {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        id: impl Into<String>,
        owner_actor_id: Option<&str>,
        name: impl Into<String>,
        work_kind: impl Into<String>,
        command: Option<&str>,
        cwd: Option<&str>,
        status: ActivityLifecycle,
        summary: Option<&str>,
        started_at: impl Into<String>,
        updated_at: impl Into<String>,
        terminal_at: Option<&str>,
    ) -> ActivityModelResult<Self> {
        let mut value = Self {
            tag: ActivityWorkItemTag::WorkItem,
            id: validate_text(id.into(), "work item id", ACTIVITY_ID_MAX_LENGTH, true)?,
            owner_actor_id: validate_optional_text(
                owner_actor_id.map(str::to_owned),
                "owner actor id",
                ACTIVITY_ID_MAX_LENGTH,
                true,
            )?,
            name: validate_text(
                name.into(),
                "work item name",
                ACTIVITY_LABEL_MAX_LENGTH,
                true,
            )?,
            work_kind: validate_text(
                work_kind.into(),
                "work kind",
                ACTIVITY_LABEL_MAX_LENGTH,
                true,
            )?,
            command: validate_optional_text(
                command.map(str::to_owned),
                "command",
                ACTIVITY_DETAIL_MAX_LENGTH,
                false,
            )?,
            cwd: validate_optional_text(
                cwd.map(str::to_owned),
                "cwd",
                ACTIVITY_DETAIL_MAX_LENGTH,
                false,
            )?,
            status,
            summary: validate_optional_text(
                summary.map(str::to_owned),
                "work item summary",
                ACTIVITY_SUMMARY_MAX_LENGTH,
                false,
            )?,
            started_at: validate_timestamp(started_at.into(), "startedAt")?,
            updated_at: validate_timestamp(updated_at.into(), "updatedAt")?,
            terminal_at: terminal_at
                .map(|value| validate_timestamp(value.to_owned(), "terminalAt"))
                .transpose()?,
        };
        value.normalize_timestamps()?;
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn fill_batch_timestamp(&mut self, timestamp: &str) {
        if self.started_at.is_empty() {
            self.started_at = timestamp.to_owned();
        }
        if self.updated_at.is_empty() {
            self.updated_at = timestamp.to_owned();
        }
        if self.status.is_terminal() && self.terminal_at.is_none() {
            self.terminal_at = Some(timestamp.to_owned());
        }
    }

    pub(crate) fn normalize_timestamps(&mut self) -> ActivityModelResult<()> {
        self.started_at = validate_timestamp(self.started_at.clone(), "startedAt")?;
        self.updated_at = validate_timestamp(self.updated_at.clone(), "updatedAt")?;
        self.terminal_at = self
            .terminal_at
            .take()
            .map(|value| validate_timestamp(value, "terminalAt"))
            .transpose()?;
        Ok(())
    }

    pub(crate) fn validate(&self) -> ActivityModelResult<()> {
        validate_text(
            self.id.clone(),
            "work item id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        validate_optional_text(
            self.owner_actor_id.clone(),
            "owner actor id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        validate_text(
            self.name.clone(),
            "work item name",
            ACTIVITY_LABEL_MAX_LENGTH,
            true,
        )?;
        validate_text(
            self.work_kind.clone(),
            "work kind",
            ACTIVITY_LABEL_MAX_LENGTH,
            true,
        )?;
        validate_optional_text(
            self.command.clone(),
            "command",
            ACTIVITY_DETAIL_MAX_LENGTH,
            false,
        )?;
        validate_optional_text(self.cwd.clone(), "cwd", ACTIVITY_DETAIL_MAX_LENGTH, false)?;
        validate_optional_text(
            self.summary.clone(),
            "work item summary",
            ACTIVITY_SUMMARY_MAX_LENGTH,
            false,
        )?;
        validate_timestamp(self.started_at.clone(), "startedAt")?;
        validate_timestamp(self.updated_at.clone(), "updatedAt")?;
        if let Some(terminal_at) = &self.terminal_at {
            validate_timestamp(terminal_at.clone(), "terminalAt")?;
        }
        if self.status.is_terminal() != self.terminal_at.is_some() {
            return Err(ActivityModelError::InvalidValue {
                field: "terminalAt",
                value: self.terminal_at.clone().unwrap_or_default(),
            });
        }
        validate_record_chronology(
            &self.started_at,
            &self.updated_at,
            self.terminal_at.as_deref(),
        )?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityEntryKind {
    Commentary,
    Tool,
    Command,
    Result,
    Error,
    State,
    Completion,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityEntryTone {
    Info,
    Tool,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    pub owner_kind: ActivityRecordKind,
    pub owner_id: String,
    pub kind: ActivityEntryKind,
    pub title: String,
    pub detail: Option<String>,
    pub tone: ActivityEntryTone,
    pub created_at: String,
}

impl ActivityEntry {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        id: impl Into<String>,
        owner_kind: ActivityRecordKind,
        owner_id: impl Into<String>,
        kind: ActivityEntryKind,
        title: impl Into<String>,
        detail: Option<&str>,
        tone: ActivityEntryTone,
        created_at: impl Into<String>,
    ) -> ActivityModelResult<Self> {
        let mut value = Self {
            id: validate_text(id.into(), "entry id", ACTIVITY_ID_MAX_LENGTH, true)?,
            owner_kind,
            owner_id: validate_text(
                owner_id.into(),
                "entry owner id",
                ACTIVITY_ID_MAX_LENGTH,
                true,
            )?,
            kind,
            title: validate_text(title.into(), "entry title", ACTIVITY_LABEL_MAX_LENGTH, true)?,
            detail: validate_optional_text(
                detail.map(str::to_owned),
                "entry detail",
                ACTIVITY_DETAIL_MAX_LENGTH,
                false,
            )?,
            tone,
            created_at: validate_timestamp(created_at.into(), "createdAt")?,
        };
        value.normalize_timestamp()?;
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn normalize_timestamp(&mut self) -> ActivityModelResult<()> {
        self.created_at = validate_timestamp(self.created_at.clone(), "createdAt")?;
        Ok(())
    }

    pub(crate) fn validate(&self) -> ActivityModelResult<()> {
        validate_text(self.id.clone(), "entry id", ACTIVITY_ID_MAX_LENGTH, true)?;
        validate_text(
            self.owner_id.clone(),
            "entry owner id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        validate_text(
            self.title.clone(),
            "entry title",
            ACTIVITY_LABEL_MAX_LENGTH,
            true,
        )?;
        validate_optional_text(
            self.detail.clone(),
            "entry detail",
            ACTIVITY_DETAIL_MAX_LENGTH,
            false,
        )?;
        validate_timestamp(self.created_at.clone(), "createdAt")?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ActivityRecordSummary {
    Actor(ActivityActorSummary),
    WorkItem(ActivityWorkItemSummary),
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCounts {
    pub active: u64,
    pub done: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySummaryCounts {
    pub subagents: ActivityCounts,
    pub background_tasks: ActivityCounts,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityActorControlState {
    Unsupported,
    Available,
    Requested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityActorControl {
    pub actor_id: String,
    pub state: ActivityActorControlState,
    pub control_revision: u64,
    pub active_descendant_count: u64,
}

impl ActivityActorControl {
    pub(crate) fn unsupported(actor_id: String) -> Self {
        Self {
            actor_id,
            state: ActivityActorControlState::Unsupported,
            control_revision: 0,
            active_descendant_count: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityCancellationOperationState {
    Requested,
    Partial,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCancellationOperationSummary {
    pub root_actor_id: String,
    pub state: ActivityCancellationOperationState,
    pub residual_count: u64,
    pub message: Option<String>,
    pub operation_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityControlSnapshot {
    pub scope_id: String,
    pub revision: u64,
    pub actors: Vec<ActivityActorControl>,
    pub operations: Vec<ActivityCancellationOperationSummary>,
}

impl ActivityControlSnapshot {
    pub(crate) fn empty(scope_id: impl Into<String>) -> Self {
        Self {
            scope_id: scope_id.into(),
            revision: 0,
            actors: Vec::new(),
            operations: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ActivityControlChange {
    ActorUpserted {
        actor: ActivityActorControl,
    },
    ActorRemoved {
        actor_id: String,
    },
    OperationUpserted {
        operation: ActivityCancellationOperationSummary,
    },
    OperationRemoved {
        root_actor_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityControlDelta {
    pub scope_id: String,
    pub previous_revision: u64,
    pub revision: u64,
    pub changes: Vec<ActivityControlChange>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ActivityChange {
    ScopeUpdated {
        capabilities: ActivityCapabilities,
        observation_state: ActivityObservationState,
        sections: ActivitySectionHealthMap,
        counts: ActivitySummaryCounts,
    },
    ActorUpserted {
        actor: ActivityActorSummary,
    },
    ActorRemoved {
        actor_id: String,
    },
    WorkItemUpserted {
        work_item: ActivityWorkItemSummary,
    },
    WorkItemRemoved {
        work_item_id: String,
    },
    EntryAppended {
        entry: ActivityEntry,
    },
    EntriesReplaced {
        owner_kind: ActivityRecordKind,
        owner_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDelta {
    pub scope_id: String,
    pub previous_revision: u64,
    pub revision: u64,
    pub changes: Vec<ActivityChange>,
    pub updated_at: String,
}

impl ActivityDelta {
    pub(crate) fn validate(&self) -> ActivityModelResult<()> {
        validate_text(
            self.scope_id.clone(),
            "scope id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        validate_timestamp(self.updated_at.clone(), "updatedAt")?;
        if self.changes.is_empty() {
            return Err(ActivityModelError::Empty { field: "changes" });
        }
        if self.changes.len() > ACTIVITY_DELTA_MAX_CHANGES {
            return Err(ActivityModelError::TooManyChanges);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub protocol_version: u8,
    pub scope_id: String,
    pub scope: ActivityScopeRef,
    pub revision: u64,
    pub provider: String,
    pub provider_instance_id: Option<String>,
    pub capabilities: ActivityCapabilities,
    pub observation_state: ActivityObservationState,
    pub sections: ActivitySectionHealthMap,
    pub counts: ActivitySummaryCounts,
    pub actors: Vec<ActivityActorSummary>,
    pub work_items: Vec<ActivityWorkItemSummary>,
    pub actors_has_more: bool,
    pub work_items_has_more: bool,
    pub control: ActivityControlSnapshot,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRosterPage {
    pub records: Vec<ActivityRecordSummary>,
    pub actor_controls: Vec<ActivityActorControl>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDetailPage {
    pub record: ActivityRecordSummary,
    pub actor_control: Option<ActivityActorControl>,
    pub entries: Vec<ActivityEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityScopeSeed {
    pub scope_id: String,
    pub generation_id: String,
    pub scope: ActivityScopeRef,
    pub provider: String,
    pub provider_instance_id: Option<String>,
    pub capabilities: ActivityCapabilities,
    pub sections: ActivitySectionHealthMap,
}

impl ActivityScopeSeed {
    pub fn thread(
        scope_id: impl Into<String>,
        thread_id: impl Into<String>,
        provider: impl Into<String>,
        provider_instance_id: Option<&str>,
        capabilities: ActivityCapabilities,
    ) -> ActivityModelResult<Self> {
        let scope_id = scope_id.into();
        Self::validated(
            scope_id.clone(),
            scope_id,
            ActivityScopeRef::Thread {
                thread_id: thread_id.into(),
            },
            provider.into(),
            provider_instance_id.map(str::to_owned),
            capabilities,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn terminal(
        scope_id: impl Into<String>,
        generation_id: impl Into<String>,
        thread_id: impl Into<String>,
        terminal_id: impl Into<String>,
        provider: impl Into<String>,
        provider_instance_id: Option<&str>,
        capabilities: ActivityCapabilities,
    ) -> ActivityModelResult<Self> {
        Self::validated(
            scope_id.into(),
            generation_id.into(),
            ActivityScopeRef::Terminal {
                thread_id: thread_id.into(),
                terminal_id: terminal_id.into(),
            },
            provider.into(),
            provider_instance_id.map(str::to_owned),
            capabilities,
        )
    }

    fn validated(
        scope_id: String,
        generation_id: String,
        scope: ActivityScopeRef,
        provider: String,
        provider_instance_id: Option<String>,
        capabilities: ActivityCapabilities,
    ) -> ActivityModelResult<Self> {
        let value = Self {
            scope_id: validate_text(scope_id, "scope id", ACTIVITY_ID_MAX_LENGTH, true)?,
            generation_id: validate_text(
                generation_id,
                "generation id",
                ACTIVITY_ID_MAX_LENGTH,
                true,
            )?,
            scope,
            provider: validate_provider_slug(provider, "provider")?,
            provider_instance_id: provider_instance_id
                .map(|value| validate_provider_slug(value, "providerInstanceId"))
                .transpose()?,
            sections: ActivitySectionHealthMap::from_capabilities(&capabilities),
            capabilities,
        };
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn validate(&self) -> ActivityModelResult<()> {
        validate_text(
            self.scope_id.clone(),
            "scope id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        validate_text(
            self.generation_id.clone(),
            "generation id",
            ACTIVITY_ID_MAX_LENGTH,
            true,
        )?;
        self.scope.validate()?;
        validate_provider_slug(self.provider.clone(), "provider")?;
        if let Some(provider_instance_id) = &self.provider_instance_id {
            validate_provider_slug(provider_instance_id.clone(), "providerInstanceId")?;
        }
        self.capabilities.validate()?;
        self.sections.validate()?;
        validate_initial_section(
            self.capabilities.actors,
            &self.sections.subagents,
            "subagents",
        )?;
        validate_initial_section(
            self.capabilities.background_work,
            &self.sections.background_tasks,
            "backgroundTasks",
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderActivityMutation {
    SetScope {
        capabilities: ActivityCapabilities,
        observation_state: ActivityObservationState,
    },
    SetSectionHealth {
        section: ActivitySection,
        health: ActivitySectionHealth,
    },
    UpsertActor(ActivityActorSummary),
    RemoveActor {
        actor_id: String,
    },
    UpsertWorkItem(ActivityWorkItemSummary),
    RemoveWorkItem {
        work_item_id: String,
    },
    AppendEntry(ActivityEntry),
}

impl ProviderActivityMutation {
    pub fn upsert_actor(
        actor_id: impl Into<String>,
        parent_actor_id: Option<&str>,
        name: impl Into<String>,
        status: &str,
    ) -> ActivityModelResult<Self> {
        Ok(Self::UpsertActor(ActivityActorSummary {
            tag: ActivityActorTag::Actor,
            id: validate_text(actor_id.into(), "actor id", ACTIVITY_ID_MAX_LENGTH, true)?,
            parent_actor_id: validate_optional_text(
                parent_actor_id.map(str::to_owned),
                "parent actor id",
                ACTIVITY_ID_MAX_LENGTH,
                true,
            )?,
            name: validate_text(name.into(), "actor name", ACTIVITY_LABEL_MAX_LENGTH, true)?,
            role: None,
            provider_type: None,
            status: status.parse()?,
            summary: None,
            started_at: String::new(),
            updated_at: String::new(),
            terminal_at: None,
        }))
    }

    pub fn set_actor_status(
        actor_id: impl Into<String>,
        status: &str,
    ) -> ActivityModelResult<Self> {
        let actor_id = validate_text(actor_id.into(), "actor id", ACTIVITY_ID_MAX_LENGTH, true)?;
        Ok(Self::UpsertActor(ActivityActorSummary::status_only(
            actor_id,
            status.parse()?,
        )))
    }

    pub fn remove_actor(actor_id: impl Into<String>) -> ActivityModelResult<Self> {
        Ok(Self::RemoveActor {
            actor_id: validate_text(actor_id.into(), "actor id", ACTIVITY_ID_MAX_LENGTH, true)?,
        })
    }

    pub fn remove_work_item(work_item_id: impl Into<String>) -> ActivityModelResult<Self> {
        Ok(Self::RemoveWorkItem {
            work_item_id: validate_text(
                work_item_id.into(),
                "work item id",
                ACTIVITY_ID_MAX_LENGTH,
                true,
            )?,
        })
    }
}

pub(crate) fn validate_timestamp(
    value: String,
    field: &'static str,
) -> ActivityModelResult<String> {
    if value.chars().count() > ACTIVITY_TIMESTAMP_MAX_LENGTH {
        return Err(ActivityModelError::InvalidTimestamp { field });
    }
    let parsed = parse_timestamp(&value, field)?;
    let parsed = parsed.to_offset(UtcOffset::UTC);
    if !(0..=9_999).contains(&parsed.year()) {
        return Err(ActivityModelError::InvalidTimestamp { field });
    }
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:09}Z",
        parsed.year(),
        u8::from(parsed.month()),
        parsed.day(),
        parsed.hour(),
        parsed.minute(),
        parsed.second(),
        parsed.nanosecond(),
    ))
}

pub(crate) fn compare_timestamps(left: &str, right: &str) -> ActivityModelResult<Ordering> {
    Ok(parse_timestamp(left, "timestamp")?.cmp(&parse_timestamp(right, "timestamp")?))
}

pub(crate) fn max_timestamp(left: &str, right: &str) -> ActivityModelResult<String> {
    let left = validate_timestamp(left.to_owned(), "timestamp")?;
    let right = validate_timestamp(right.to_owned(), "timestamp")?;
    Ok(if compare_timestamps(&left, &right)?.is_lt() {
        right
    } else {
        left
    })
}

pub(crate) fn validate_text(
    value: String,
    field: &'static str,
    maximum: usize,
    trim: bool,
) -> ActivityModelResult<String> {
    let value = if trim { value.trim().to_owned() } else { value };
    if value.is_empty() && trim {
        return Err(ActivityModelError::Empty { field });
    }
    if value.encode_utf16().count() > maximum {
        return Err(ActivityModelError::TooLong { field, maximum });
    }
    Ok(value)
}

fn validate_optional_text(
    value: Option<String>,
    field: &'static str,
    maximum: usize,
    trim: bool,
) -> ActivityModelResult<Option<String>> {
    value
        .map(|value| validate_text(value, field, maximum, trim))
        .transpose()
}

fn validate_provider_slug(value: String, field: &'static str) -> ActivityModelResult<String> {
    let value = validate_text(value, field, PROVIDER_SLUG_MAX_LENGTH, true)?;
    let mut chars = value.chars();
    let valid = chars
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
        && chars
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'));
    if !valid {
        return Err(ActivityModelError::InvalidValue { field, value });
    }
    Ok(value)
}

fn parse_timestamp(value: &str, field: &'static str) -> ActivityModelResult<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| ActivityModelError::InvalidTimestamp { field })
}

fn validate_record_chronology(
    started_at: &str,
    updated_at: &str,
    terminal_at: Option<&str>,
) -> ActivityModelResult<()> {
    let updated_after_terminal = terminal_at
        .map(|terminal_at| compare_timestamps(updated_at, terminal_at))
        .transpose()?
        .is_some_and(Ordering::is_gt);
    if compare_timestamps(started_at, updated_at)?.is_gt() || updated_after_terminal {
        return Err(ActivityModelError::InvalidValue {
            field: "timestamps",
            value: format!("{started_at}..{updated_at}..{}", terminal_at.unwrap_or("")),
        });
    }
    Ok(())
}

fn validate_initial_section(
    negotiated: bool,
    health: &ActivitySectionHealth,
    field: &'static str,
) -> ActivityModelResult<()> {
    if negotiated && health.state == ActivitySectionObservationState::Unsupported
        || !negotiated && health.state == ActivitySectionObservationState::Live
    {
        return Err(ActivityModelError::InvalidValue {
            field,
            value: format!("{:?}", health.state),
        });
    }
    Ok(())
}
