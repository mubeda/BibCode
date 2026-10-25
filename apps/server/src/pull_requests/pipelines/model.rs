//! Wire types mirror `packages/contracts/src/pipelines.ts`.

use serde::{Deserialize, Serialize};

use crate::pull_requests::model::{Actor, PipelineStage, PipelineStatus};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Refresh {
    User,
    Follow,
    Timer,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Approval,
    TimedOut,
    StartupFailure,
    ActionRequired,
    Neutral,
    Stale,
    YamlError,
    Stuck,
    FailureReason,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Badge {
    Latest,
    MergeRequest,
    MergedResults,
    MergeTrain,
    Scheduled,
    Branch,
    Tag,
    Api,
    Trigger,
    ManualRun,
    Retried,
    Child,
    YamlInvalid,
    Stuck,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    Branch,
    Tag,
    MergeRequest,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRef {
    pub kind: RefKind,
    pub name: String,
    pub number: Option<u64>,
    pub url: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Granted,
    Denied,
    Unknown,
}

impl Permission {
    pub(crate) fn from_host(allowed: bool) -> Self {
        if allowed { Self::Granted } else { Self::Denied }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowPermissions {
    pub retry: Permission,
    pub cancel: Permission,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: u64,
    pub label: String,
    pub title: Option<String>,
    pub status: PipelineStatus,
    pub warnings: bool,
    pub reason: Option<Reason>,
    pub terminal: bool,
    #[serde(rename = "ref")]
    pub git_ref: PipelineRef,
    pub sha: String,
    pub actor: Option<Actor>,
    pub badges: Vec<Badge>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_seconds: Option<f64>,
    pub queued_seconds: Option<f64>,
    pub stages: Option<Vec<PipelineStage>>,
    pub attempt: Option<u64>,
    pub permissions: Option<RowPermissions>,
    pub url: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ListScope {
    All,
    Running,
    Finished,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    pub cwd: String,
    pub scope: ListScope,
    #[serde(rename = "ref")]
    pub git_ref: Option<String>,
    pub workflow_id: Option<u64>,
    pub cursor: Option<String>,
    pub refresh: Refresh,
}

/// What a list key is made of: its filters, never its cursor or read kind.
#[derive(Serialize)]
struct ListKey<'a> {
    scope: ListScope,
    #[serde(rename = "ref")]
    git_ref: Option<&'a str>,
    workflow: Option<u64>,
}

impl ListInput {
    /// The stored first page's key, and the poller's.
    pub(crate) fn snapshot_key(&self) -> String {
        serde_json::to_string(&ListKey {
            scope: self.scope,
            git_ref: self.git_ref.as_deref(),
            workflow: self.workflow_id,
        })
        .unwrap_or_default()
    }

    pub(crate) fn first_page(&self) -> Self {
        Self {
            cursor: None,
            ..self.clone()
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Total {
    pub count: u64,
    pub capped: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: u64,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListPage {
    pub revision: i64,
    pub rows: Vec<Row>,
    pub next_cursor: Option<String>,
    pub total: Option<Total>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflows: Option<Vec<Workflow>>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Build,
    Trigger,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobPermissions {
    pub retry: Permission,
    pub cancel: Permission,
    pub play: Permission,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: u64,
    pub name: String,
    pub stage: String,
    pub kind: JobKind,
    pub status: PipelineStatus,
    pub warnings: bool,
    pub reason: Option<Reason>,
    pub terminal: bool,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_seconds: Option<f64>,
    pub queued_seconds: Option<f64>,
    pub permissions: JobPermissions,
    pub url: Option<String>,
    pub downstream_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GetInput {
    pub cwd: String,
    pub pipeline_id: u64,
    pub attempt: Option<u64>,
    pub refresh: Refresh,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub name: String,
    pub size_bytes: Option<u64>,
    pub expires_at: Option<String>,
    pub expired: bool,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobGroup {
    pub name: String,
    pub size: u64,
    pub status: PipelineStatus,
    pub jobs: Vec<Job>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetailStage {
    pub name: String,
    pub status: PipelineStatus,
    pub warnings: bool,
    pub groups: Vec<JobGroup>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub title: Option<String>,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub revision: i64,
    pub pipeline: Row,
    pub commit: Commit,
    pub total_jobs: Option<u64>,
    pub stages: Option<Vec<DetailStage>>,
    pub truncated: bool,
    pub uses_needs: bool,
    pub artifacts: Vec<Artifact>,
}

impl Detail {
    /// Every job, stage by stage.
    pub(crate) fn jobs(&self) -> impl Iterator<Item = &Job> {
        self.stages
            .iter()
            .flatten()
            .flat_map(|stage| &stage.groups)
            .flat_map(|group| &group.jobs)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobInput {
    pub cwd: String,
    pub job_id: u64,
    pub refresh: Refresh,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Runner {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub number: u64,
    pub name: String,
    pub status: PipelineStatus,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobDetail {
    pub revision: i64,
    pub job: Job,
    pub pipeline_id: u64,
    pub attempt: Option<u64>,
    pub runner: Option<Runner>,
    pub tags: Vec<String>,
    pub source: Option<String>,
    pub created_at: String,
    pub artifacts: Vec<Artifact>,
    pub steps: Vec<Step>,
    pub log_bytes: Option<u64>,
    pub erased: bool,
    pub raw_log_url: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "_tag", rename_all = "lowercase")]
pub enum LogFrom {
    Tail,
    Offset { offset: u64 },
    Before { offset: u64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobLogInput {
    pub cwd: String,
    pub job_id: u64,
    pub attempt: Option<u64>,
    pub from: LogFrom,
    pub refresh: Refresh,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub text: String,
    pub offset: u64,
    pub next_offset: u64,
    pub total_bytes: Option<u64>,
    pub complete: bool,
    pub truncated_head: bool,
    pub first_line: Option<u64>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogUnavailable {
    NotStarted,
    NoOutput,
    Erased,
    Expired,
    LiveOnHost,
    TooLargeLive,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogUnavailableAnswer {
    pub reason: LogUnavailable,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "_tag", rename_all = "lowercase")]
pub enum JobLog {
    Chunk(LogChunk),
    Unavailable(LogUnavailableAnswer),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeInput {
    #[serde(flatten)]
    pub list: ListInput,
    pub pipeline_id: Option<u64>,
    pub attempt: Option<u64>,
    pub job_id: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stored<T> {
    pub payload: T,
    pub observed_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub list: Option<Stored<ListPage>>,
    pub detail: Option<Stored<Detail>>,
    pub job: Option<Stored<JobDetail>>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    pub list: bool,
    pub pipeline: bool,
}

impl Changed {
    pub fn any(self) -> bool {
        self.list || self.pipeline
    }
}

/// What an action acts on: a pipeline (a GitHub workflow run) or one job.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "_tag", rename_all = "lowercase")]
pub enum ActionTarget {
    Pipeline { id: u64 },
    Job { id: u64 },
}

impl ActionTarget {
    pub(crate) fn id(self) -> u64 {
        match self {
            Self::Pipeline { id } | Self::Job { id } => id,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Retry,
    RetryFailed,
    Cancel,
    Play,
}

impl ActionKind {
    /// The permission an action needs, which a refusal turns `denied`.
    pub(crate) fn permission(self) -> PermissionKind {
        match self {
            Self::Retry | Self::RetryFailed => PermissionKind::Retry,
            Self::Cancel => PermissionKind::Cancel,
            Self::Play => PermissionKind::Play,
        }
    }
}

/// The permission fields of rows and jobs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum PermissionKind {
    Retry,
    Cancel,
    Play,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunActionInput {
    pub cwd: String,
    pub target: ActionTarget,
    pub action: ActionKind,
}

/// Where the action's result lives: GitLab returns the pipeline, or the job
/// (a retried job is a new one); a GitHub re-run is the run's next attempt.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub pipeline_id: Option<u64>,
    pub job_id: Option<u64>,
}

/// The terminal set both providers share for GitLab-shaped statuses: nothing
/// more will run. `manual` and `scheduled` wait for a person or a timer.
pub(crate) fn is_terminal(status: PipelineStatus) -> bool {
    matches!(
        status,
        PipelineStatus::Success
            | PipelineStatus::Failed
            | PipelineStatus::Canceled
            | PipelineStatus::Skipped
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pipelines_log_inputs_and_answers_round_trip_the_contract_shape() {
        for (value, from) in [
            (json!({"_tag":"tail"}), LogFrom::Tail),
            (
                json!({"_tag":"offset","offset":7}),
                LogFrom::Offset { offset: 7 },
            ),
            (
                json!({"_tag":"before","offset":9}),
                LogFrom::Before { offset: 9 },
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<LogFrom>(value.clone()).unwrap(),
                from
            );
            assert_eq!(serde_json::to_value(from).unwrap(), value);
        }
        let chunk = JobLog::Chunk(LogChunk {
            text: "a".into(),
            offset: 0,
            next_offset: 1,
            total_bytes: None,
            complete: false,
            truncated_head: false,
            first_line: Some(0),
        });
        assert_eq!(
            serde_json::to_value(&chunk).unwrap(),
            json!({"_tag":"chunk","text":"a","offset":0,"nextOffset":1,"totalBytes":null,
                "complete":false,"truncatedHead":false,"firstLine":0})
        );
        assert_eq!(
            serde_json::to_value(JobLog::Unavailable(LogUnavailableAnswer {
                reason: LogUnavailable::TooLargeLive,
                url: None
            }))
            .unwrap(),
            json!({"_tag":"unavailable","reason":"too_large_live","url":null})
        );
    }

    #[test]
    fn pipelines_action_inputs_and_results_round_trip_the_contract_shape() {
        let input: RunActionInput = serde_json::from_value(json!({"cwd":"/repo",
            "target":{"_tag":"job","id":998},"action":"retry_failed"}))
        .unwrap();
        assert_eq!(input.target, ActionTarget::Job { id: 998 });
        assert_eq!(input.action, ActionKind::RetryFailed);
        assert_eq!(
            serde_json::to_value(ActionTarget::Pipeline { id: 4821 }).unwrap(),
            json!({"_tag":"pipeline","id":4821})
        );
        assert!(
            serde_json::from_value::<RunActionInput>(json!({"cwd":"/repo",
                "target":{"_tag":"stage","id":1},"action":"retry"}))
            .is_err()
        );
        assert_eq!(
            serde_json::to_value(ActionResult {
                pipeline_id: Some(4821),
                job_id: None
            })
            .unwrap(),
            json!({"pipelineId":4821,"jobId":null})
        );
    }

    #[test]
    fn pipelines_list_key_ignores_the_cursor_and_read_kind() {
        let input: ListInput = serde_json::from_value(json!({"cwd":"/repo","scope":"running",
            "ref":"main","workflowId":null,"cursor":"abc","refresh":"timer"}))
        .unwrap();
        let mut other = input.clone();
        other.cursor = None;
        other.refresh = Refresh::User;
        assert_eq!(input.snapshot_key(), other.snapshot_key());
        other.git_ref = None;
        assert_ne!(input.snapshot_key(), other.snapshot_key());
    }
}
