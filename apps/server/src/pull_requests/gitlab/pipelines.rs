//! GitLab's project pipelines: the list and pipeline reads through GraphQL,
//! the job and its trace through REST. Every link is built on the project's
//! web origin, never taken from response text.

use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio_util::sync::CancellationToken;

use super::{GitLabHost, encoded, parse, project_path};
use crate::pull_requests::{
    backoff,
    error::PullRequestsOperationError,
    host::{Budget, HostContext, HostFuture, HostScope, ProcessFailure},
    model::{Actor, PipelineStage, PipelineStatus},
    pipelines::{
        ACTION_OP, ListRead, PipelineHost, TraceRead,
        model::{
            ActionKind, ActionResult, ActionTarget, Artifact, Badge, Commit, Detail, DetailStage,
            Job, JobDetail, JobGroup, JobKind, JobPermissions, ListInput, ListScope, Permission,
            PipelineRef, Reason, RefKind, Row, RowPermissions, Runner, Total, is_terminal,
        },
        read_failure, unsupported_action,
    },
};

/// Rows per page, as GitLab's own Pipelines page: each row selects its stage
/// strip, which keeps the query under GraphQL's complexity cap.
pub(crate) const PAGE_SIZE: u64 = 15;

const PIPELINE_GID: &str = "gid://gitlab/Ci::Pipeline/";

fn invalid(operation: &str) -> PullRequestsOperationError {
    PullRequestsOperationError::new(operation, "invalid_response")
}

/// The status a detailed status names. GitLab spells "passed with warnings"
/// as its own name; the warning rides beside the status.
fn detailed_status(value: &Value) -> Option<(PipelineStatus, bool)> {
    let name = value["detailedStatus"]["name"].as_str()?;
    if name.eq_ignore_ascii_case("SUCCESS_WITH_WARNINGS") {
        return Some((PipelineStatus::Success, true));
    }
    Some((parse::pipeline_status(name), false))
}

fn warnings(value: &Value) -> bool {
    detailed_status(value).is_some_and(|(_, warnings)| warnings)
}

fn status(value: &Value) -> PipelineStatus {
    value["status"]
        .as_str()
        .map_or(PipelineStatus::Unknown, parse::pipeline_status)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn seconds(value: &Value, key: &str) -> Option<f64> {
    value[key].as_f64().filter(|seconds| *seconds >= 0.0)
}

/// The numeric tail of a global id (`gid://gitlab/Ci::Build/998`).
fn global_id(value: &Value) -> Option<u64> {
    value
        .as_str()?
        .strip_prefix("gid://gitlab/")?
        .rsplit_once('/')?
        .1
        .parse()
        .ok()
        .filter(|id| *id > 0)
}

fn nodes(value: &Value) -> &[Value] {
    value["nodes"].as_array().map_or(&[], Vec::as_slice)
}

/// A link under the project's web URL (`<project>/-/commits/<ref>`).
fn project_link(context: &HostContext, suffix: &str) -> Option<String> {
    parse::web_origin(&context.web_url)?;
    Some(format!(
        "{}/{suffix}",
        context.web_url.trim_end_matches('/')
    ))
}

fn merge_request_iid(git_ref: &str) -> Option<u64> {
    git_ref
        .strip_prefix("refs/merge-requests/")?
        .split_once('/')?
        .0
        .parse()
        .ok()
}

fn pipeline_ref(node: &Value, context: &HostContext, origin: Option<&str>) -> PipelineRef {
    let name = text(node, "ref").unwrap_or_default();
    let request = &node["mergeRequest"];
    let number = request["iid"]
        .as_str()
        .and_then(|iid| iid.parse().ok())
        .or_else(|| request["iid"].as_u64())
        .or_else(|| merge_request_iid(&name));
    if let Some(number) = number {
        return PipelineRef {
            kind: RefKind::MergeRequest,
            name: format!("!{number}"),
            number: Some(number),
            url: parse::host_link(origin, &request["webPath"])
                .or_else(|| project_link(context, &format!("-/merge_requests/{number}"))),
        };
    }
    let tag = node["refPath"]
        .as_str()
        .is_some_and(|path| path.starts_with("refs/tags/"))
        || node["type"]
            .as_str()
            .is_some_and(|kind| kind.to_ascii_lowercase().contains("tag"));
    let url = (!name.is_empty())
        .then(|| project_link(context, &format!("-/commits/{}", encoded(&name))))
        .flatten();
    PipelineRef {
        kind: if name.is_empty() {
            RefKind::Other
        } else if tag {
            RefKind::Tag
        } else {
            RefKind::Branch
        },
        name,
        number: None,
        url,
    }
}

fn badges(node: &Value, git_ref: &PipelineRef) -> Vec<Badge> {
    let mut badges = Vec::new();
    if node["latest"].as_bool() == Some(true) {
        badges.push(Badge::Latest);
    }
    match node["mergeRequestEventType"].as_str() {
        Some("MERGED_RESULT") => badges.push(Badge::MergedResults),
        Some("MERGE_TRAIN") => badges.push(Badge::MergeTrain),
        Some(_) => badges.push(Badge::MergeRequest),
        None if git_ref.kind == RefKind::MergeRequest => {
            let raw = node["ref"].as_str().unwrap_or_default();
            badges.push(match parse::pipeline_kind(raw, None) {
                crate::pull_requests::model::PipelineKind::MergedResults => Badge::MergedResults,
                crate::pull_requests::model::PipelineKind::MergeTrain => Badge::MergeTrain,
                _ => Badge::MergeRequest,
            });
        }
        None => {}
    }
    match git_ref.kind {
        RefKind::Branch => badges.push(Badge::Branch),
        RefKind::Tag => badges.push(Badge::Tag),
        RefKind::MergeRequest | RefKind::Other => {}
    }
    match node["source"].as_str() {
        Some("schedule") => badges.push(Badge::Scheduled),
        Some("api") => badges.push(Badge::Api),
        Some("trigger" | "pipeline") => badges.push(Badge::Trigger),
        Some("parent_pipeline") => badges.push(Badge::Child),
        _ => {}
    }
    if node["yamlErrors"].as_bool() == Some(true) {
        badges.push(Badge::YamlInvalid);
    }
    if node["stuck"].as_bool() == Some(true) {
        badges.push(Badge::Stuck);
    }
    badges
}

/// GitLab's own answers: `userPermissions` with `retryable` and `cancelable`.
/// Without `userPermissions` the host said nothing, and mutations stay off.
fn row_permissions(node: &Value) -> Option<RowPermissions> {
    let permissions = node["userPermissions"].as_object()?;
    let update = permissions.get("updatePipeline").and_then(Value::as_bool) == Some(true);
    let cancel = permissions
        .get("cancelPipeline")
        .and_then(Value::as_bool)
        .unwrap_or(update);
    Some(RowPermissions {
        retry: Permission::from_host(update && node["retryable"].as_bool() == Some(true)),
        cancel: Permission::from_host(cancel && node["cancelable"].as_bool() == Some(true)),
    })
}

fn reason(node: &Value) -> Option<Reason> {
    if node["yamlErrors"].as_bool() == Some(true) {
        Some(Reason::YamlError)
    } else if node["stuck"].as_bool() == Some(true) {
        Some(Reason::Stuck)
    } else if node["failureReason"]
        .as_str()
        .is_some_and(|r| !r.is_empty())
    {
        // The text never reaches the client: it can name internal causes.
        Some(Reason::FailureReason)
    } else {
        None
    }
}

fn stage_strip(
    node: &Value,
    operation: &str,
) -> Result<Option<Vec<PipelineStage>>, PullRequestsOperationError> {
    if node["stages"].is_null() {
        return Ok(None);
    }
    nodes(&node["stages"])
        .iter()
        .map(|stage| {
            Ok(PipelineStage {
                name: text(stage, "name").ok_or_else(|| invalid(operation))?,
                status: status(stage),
                warnings: warnings(stage),
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// One list row or pipeline header.
pub(crate) fn parse_row(
    node: &Value,
    context: &HostContext,
    operation: &str,
) -> Result<Row, PullRequestsOperationError> {
    let origin = parse::web_origin(&context.web_url);
    let id = global_id(&node["id"])
        .filter(|_| {
            node["id"]
                .as_str()
                .is_some_and(|id| id.starts_with(PIPELINE_GID))
        })
        .ok_or_else(|| invalid(operation))?;
    let status = status(node);
    let git_ref = pipeline_ref(node, context, origin);
    let badges = badges(node, &git_ref);
    let actor = node["user"]["username"]
        .as_str()
        .filter(|login| !login.trim().is_empty())
        .map(|login| Actor {
            login: login.to_owned(),
            name: text(&node["user"], "name"),
            is_bot: false,
        });
    Ok(Row {
        id,
        label: format!("#{id}"),
        title: text(node, "name").or_else(|| text(&node["commit"], "title")),
        status,
        warnings: warnings(node),
        reason: reason(node),
        terminal: is_terminal(status),
        git_ref,
        sha: text(node, "sha").unwrap_or_default(),
        actor,
        badges,
        created_at: text(node, "createdAt").ok_or_else(|| invalid(operation))?,
        started_at: text(node, "startedAt"),
        finished_at: text(node, "finishedAt"),
        duration_seconds: seconds(node, "duration"),
        queued_seconds: seconds(node, "queuedDuration"),
        stages: stage_strip(node, operation)?,
        attempt: None,
        permissions: row_permissions(node),
        url: parse::host_link(origin, &node["path"]),
    })
}

pub(crate) struct ParsedList {
    pub rows: Vec<Row>,
    pub next_cursor: Option<String>,
    pub total: Option<Total>,
}

pub(crate) fn parse_list(
    value: &Value,
    context: &HostContext,
    operation: &str,
) -> Result<ParsedList, PullRequestsOperationError> {
    let project = &value["data"]["project"];
    if project.is_null() {
        return Err(PullRequestsOperationError::new(operation, "not_found"));
    }
    let pipelines = &project["pipelines"];
    if pipelines.is_null() {
        // GitLab hides pipelines from an account below Reporter.
        return Err(PullRequestsOperationError::new(operation, "forbidden"));
    }
    let rows = nodes(pipelines)
        .iter()
        .map(|node| parse_row(node, context, operation))
        .collect::<Result<Vec<_>, _>>()?;
    let page = &pipelines["pageInfo"];
    let next_cursor = (page["hasNextPage"].as_bool() == Some(true))
        .then(|| text(page, "endCursor"))
        .flatten();
    // `count(limit: 1000)` answers 1001 past the limit.
    let total = pipelines["count"].as_u64().map(|count| Total {
        count: count.min(1000),
        capped: count > 1000,
    });
    Ok(ParsedList {
        rows,
        next_cursor,
        total,
    })
}

fn parse_job(
    node: &Value,
    stage: &str,
    can_update: bool,
    can_cancel: bool,
    origin: Option<&str>,
    operation: &str,
) -> Result<Job, PullRequestsOperationError> {
    let status = status(node);
    let failed_allowed =
        status == PipelineStatus::Failed && node["allowFailure"].as_bool() == Some(true);
    Ok(Job {
        id: global_id(&node["id"]).ok_or_else(|| invalid(operation))?,
        name: text(node, "name").ok_or_else(|| invalid(operation))?,
        stage: stage.to_owned(),
        kind: if node["kind"].as_str() == Some("BRIDGE") {
            JobKind::Trigger
        } else {
            JobKind::Build
        },
        status,
        warnings: failed_allowed,
        reason: None,
        terminal: is_terminal(status),
        started_at: text(node, "startedAt"),
        finished_at: text(node, "finishedAt"),
        duration_seconds: seconds(node, "duration"),
        queued_seconds: seconds(node, "queuedDuration"),
        permissions: JobPermissions {
            retry: Permission::from_host(can_update && node["retryable"].as_bool() == Some(true)),
            cancel: Permission::from_host(can_cancel && node["cancelable"].as_bool() == Some(true)),
            play: Permission::from_host(can_update && node["playable"].as_bool() == Some(true)),
        },
        url: parse::host_link(origin, &node["webPath"]),
        downstream_url: parse::host_link(origin, &node["downstreamPipeline"]["path"]),
    })
}

pub(crate) fn parse_detail(
    value: &Value,
    context: &HostContext,
    operation: &str,
) -> Result<Detail, PullRequestsOperationError> {
    let project = &value["data"]["project"];
    let node = &project["pipeline"];
    if project.is_null() || node.is_null() {
        return Err(PullRequestsOperationError::new(operation, "not_found"));
    }
    let origin = parse::web_origin(&context.web_url);
    let pipeline = parse_row(node, context, operation)?;
    let permissions = node["userPermissions"].as_object();
    let can_update = permissions
        .and_then(|p| p.get("updatePipeline"))
        .and_then(Value::as_bool)
        == Some(true);
    let can_cancel = permissions
        .and_then(|p| p.get("cancelPipeline"))
        .and_then(Value::as_bool)
        .unwrap_or(can_update);
    let mut truncated = false;
    // `null` stages: this account cannot read the jobs (`read_build`).
    let stages = if node["stages"].is_null() {
        None
    } else {
        let mut stages = Vec::new();
        for stage in nodes(&node["stages"]) {
            let name = text(stage, "name").ok_or_else(|| invalid(operation))?;
            let mut groups = Vec::new();
            for group in nodes(&stage["groups"]) {
                let jobs = &group["jobs"];
                truncated |= jobs["pageInfo"]["hasNextPage"].as_bool() == Some(true);
                let jobs = nodes(jobs)
                    .iter()
                    .map(|job| parse_job(job, &name, can_update, can_cancel, origin, operation))
                    .collect::<Result<Vec<_>, _>>()?;
                groups.push(JobGroup {
                    name: text(group, "name").ok_or_else(|| invalid(operation))?,
                    size: group["size"].as_u64().unwrap_or(jobs.len() as u64),
                    status: detailed_status(group).map_or_else(
                        || {
                            jobs.first()
                                .map_or(PipelineStatus::Unknown, |job| job.status)
                        },
                        |(status, _)| status,
                    ),
                    jobs,
                });
            }
            stages.push(DetailStage {
                name,
                status: status(stage),
                warnings: warnings(stage),
                groups,
            });
        }
        Some(stages)
    };
    Ok(Detail {
        revision: 0,
        commit: Commit {
            sha: pipeline.sha.clone(),
            title: text(&node["commit"], "title"),
            url: parse::host_link(origin, &node["commit"]["webPath"]),
        },
        pipeline,
        total_jobs: node["totalJobs"].as_u64(),
        stages,
        truncated,
        uses_needs: node["usesNeeds"].as_bool() == Some(true),
        artifacts: Vec::new(),
    })
}

/// A web URL is kept only on the project's own origin.
fn same_origin(url: Option<&str>, context: &HostContext) -> Option<String> {
    let url = url?;
    let origin = parse::web_origin(&context.web_url)?;
    (parse::web_origin(url) == Some(origin) && !url.contains(['\n', '\r', '\\']))
        .then(|| url.to_owned())
}

fn expired(expires_at: Option<&str>) -> bool {
    expires_at
        .and_then(|at| OffsetDateTime::parse(at, &Rfc3339).ok())
        .is_some_and(|at| at <= OffsetDateTime::now_utc())
}

/// `GET projects/:id/jobs/:job_id`.
pub(crate) fn parse_job_detail(
    value: &Value,
    context: &HostContext,
    operation: &str,
) -> Result<JobDetail, PullRequestsOperationError> {
    let id = value["id"].as_u64().ok_or_else(|| invalid(operation))?;
    let status = status(value);
    let web_url = same_origin(value["web_url"].as_str(), context);
    let failed = status == PipelineStatus::Failed;
    let expires_at = text(value, "artifacts_expire_at");
    let is_expired = expired(expires_at.as_deref());
    let artifacts_list = value["artifacts"].as_array().map_or(&[][..], Vec::as_slice);
    let trace_size = artifacts_list
        .iter()
        .find(|artifact| artifact["file_type"].as_str() == Some("trace"))
        .and_then(|artifact| artifact["size"].as_u64());
    let artifacts = artifacts_list
        .iter()
        .filter(|artifact| artifact["file_type"].as_str() != Some("trace"))
        .filter_map(|artifact| {
            Some(Artifact {
                name: text(artifact, "filename").or_else(|| text(artifact, "file_type"))?,
                size_bytes: artifact["size"].as_u64(),
                expires_at: expires_at.clone(),
                expired: is_expired,
                // The job's page lists its artifacts with their downloads.
                url: web_url.clone(),
            })
        })
        .collect();
    let runner = value["runner"].as_object().map(|runner| {
        let field = |key: &str| {
            runner
                .get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        Runner {
            name: field("name")
                .or_else(|| field("description"))
                .unwrap_or_else(|| {
                    runner
                        .get("id")
                        .and_then(Value::as_u64)
                        .map_or_else(String::new, |id| format!("#{id}"))
                }),
            description: field("description"),
        }
    });
    Ok(JobDetail {
        revision: 0,
        job: Job {
            id,
            name: text(value, "name").ok_or_else(|| invalid(operation))?,
            stage: text(value, "stage").unwrap_or_default(),
            kind: JobKind::Build,
            status,
            warnings: failed && value["allow_failure"].as_bool() == Some(true),
            reason: (failed && value["failure_reason"].as_str().is_some())
                .then_some(Reason::FailureReason),
            terminal: is_terminal(status),
            started_at: text(value, "started_at"),
            finished_at: text(value, "finished_at"),
            duration_seconds: seconds(value, "duration"),
            queued_seconds: seconds(value, "queued_duration"),
            // GitLab's answer for this account rides in the pipeline detail,
            // which the job page reads for its related jobs.
            permissions: JobPermissions {
                retry: Permission::Unknown,
                cancel: Permission::Unknown,
                play: Permission::Unknown,
            },
            url: web_url.clone(),
            downstream_url: None,
        },
        pipeline_id: value["pipeline"]["id"]
            .as_u64()
            .ok_or_else(|| invalid(operation))?,
        attempt: None,
        runner,
        tags: value["tag_list"]
            .as_array()
            .map(|tags| {
                tags.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        source: text(&value["pipeline"], "source"),
        created_at: text(value, "created_at").ok_or_else(|| invalid(operation))?,
        artifacts,
        steps: Vec::new(),
        log_bytes: trace_size,
        erased: !value["erased_at"].is_null(),
        raw_log_url: web_url.map(|url| format!("{}/raw", url.trim_end_matches('/'))),
    })
}

/// GraphQL errors that mean this GitLab lacks a field the full document
/// selects.
fn missing_field(value: &Value) -> bool {
    value["errors"].as_array().is_some_and(|errors| {
        errors.iter().any(|error| {
            error["message"]
                .as_str()
                .is_some_and(|message| message.contains("doesn't exist"))
        })
    })
}

impl GitLabHost {
    fn uses_baseline(&self, scope: &HostScope) -> bool {
        self.pipelines_baseline
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(&scope.host.to_ascii_lowercase())
    }

    /// One pipelines GraphQL read: the full document, or the baseline once
    /// GitLab said a newer field does not exist (remembered for the host).
    async fn pipelines_graphql(
        &self,
        scope: &HostScope,
        document: fn(bool) -> String,
        variables: Value,
        operation: &str,
        budget: Budget,
        c: &CancellationToken,
    ) -> Result<Value, PullRequestsOperationError> {
        let mut baseline = self.uses_baseline(scope);
        loop {
            let input = json!({"query": document(baseline), "variables": variables});
            let started = std::time::Instant::now();
            let output = self
                .runner
                .glab_api_raw(scope, "graphql", Some(&input), true, budget, c)
                .await;
            super::trace_gitlab_read(operation, "graphql", started);
            let output = output.map_err(|failure| read_failure(operation, "glab", &failure))?;
            let (_, body) = backoff::split_response(&output.stdout);
            let value: Value = serde_json::from_slice(body).map_err(|_| invalid(operation))?;
            if !baseline && missing_field(&value) {
                self.pipelines_baseline
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(scope.host.to_ascii_lowercase());
                baseline = true;
                continue;
            }
            if value["errors"]
                .as_array()
                .is_some_and(|errors| !errors.is_empty())
                && value["data"].is_null()
            {
                return Err(invalid(operation));
            }
            if c.is_cancelled() {
                return Err(PullRequestsOperationError::new(operation, "timeout"));
            }
            return Ok(value);
        }
    }

    /// A REST read with `-i`, so a refusal keeps its rate-limit headers.
    async fn pipelines_rest(
        &self,
        scope: &HostScope,
        path: &str,
        operation: &str,
        c: &CancellationToken,
    ) -> Result<Value, PullRequestsOperationError> {
        let started = std::time::Instant::now();
        let output = self
            .runner
            .glab_api_raw(scope, path, None, true, Budget::Read, c)
            .await;
        super::trace_gitlab_read(operation, "job", started);
        let output = output.map_err(|failure| read_failure(operation, "glab", &failure))?;
        let (_, body) = backoff::split_response(&output.stdout);
        serde_json::from_slice(body).map_err(|_| invalid(operation))
    }
}

/// The REST endpoint of an action. GitLab's pipeline Retry retries its failed
/// jobs, so "retry failed jobs" is the same call; a pipeline is never played.
pub(crate) fn action_path(
    scope: &HostScope,
    target: ActionTarget,
    action: ActionKind,
) -> Result<String, PullRequestsOperationError> {
    let base = project_path(scope);
    let (kind, id) = match target {
        ActionTarget::Pipeline { id } => ("pipelines", id),
        ActionTarget::Job { id } => ("jobs", id),
    };
    let verb = match (target, action) {
        (_, ActionKind::Retry) | (ActionTarget::Pipeline { .. }, ActionKind::RetryFailed) => {
            "retry"
        }
        (_, ActionKind::Cancel) => "cancel",
        (ActionTarget::Job { .. }, ActionKind::Play) => "play",
        (ActionTarget::Job { .. }, ActionKind::RetryFailed) => {
            return Err(unsupported_action("GitLab retries a job with Retry."));
        }
        (ActionTarget::Pipeline { .. }, ActionKind::Play) => {
            return Err(unsupported_action("GitLab runs manual jobs one at a time."));
        }
    };
    Ok(format!("{base}/{kind}/{id}/{verb}"))
}

/// GitLab answers an action with the pipeline, or with the job: a retried
/// job is a new one, whose id the client opens.
pub(crate) fn parse_action(
    value: &Value,
    target: ActionTarget,
) -> Result<ActionResult, PullRequestsOperationError> {
    let id = value["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or_else(|| invalid(ACTION_OP))?;
    Ok(match target {
        ActionTarget::Pipeline { .. } => ActionResult {
            pipeline_id: Some(id),
            job_id: None,
        },
        ActionTarget::Job { .. } => ActionResult {
            pipeline_id: value["pipeline"]["id"].as_u64().filter(|id| *id > 0),
            job_id: Some(id),
        },
    })
}

/// GitLab answers 403 both for a refused account and for a job whose state
/// moved on ("Job is not retryable", "not playable"): the latter is about the
/// job, so its copy says to refresh instead of claiming a missing permission.
fn action_failure(failure: &ProcessFailure) -> PullRequestsOperationError {
    let stderr = failure.stderr.to_lowercase();
    let state = if stderr.contains("not retryable") {
        Some("This job can't be retried now. Refresh to see its status.")
    } else if stderr.contains("not playable") {
        Some("This job can't be run now. Refresh to see its status.")
    } else {
        None
    };
    match state {
        Some(message) => {
            let mut error = PullRequestsOperationError::new(ACTION_OP, "host_rejected");
            error.message = message.into();
            error
        }
        None => read_failure(ACTION_OP, "glab", failure),
    }
}

fn list_scope(scope: ListScope) -> Value {
    match scope {
        ListScope::All => Value::Null,
        ListScope::Running => json!("RUNNING"),
        ListScope::Finished => json!("FINISHED"),
    }
}

impl PipelineHost for GitLabHost {
    fn ranged_logs(&self) -> bool {
        true
    }

    fn known_context(&self, scope: &HostScope) -> Option<HostContext> {
        GitLabHost::known_context(self, scope)
    }

    fn list<'a>(
        &'a self,
        scope: &'a HostScope,
        context: &'a HostContext,
        input: &'a ListInput,
        with_count: bool,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, ListRead> {
        Box::pin(async move {
            let operation = "pipelines.list";
            let value = self
                .pipelines_graphql(
                    scope,
                    super::graphql::pipelines_list_query,
                    json!({
                        "projectPath": scope.repository,
                        "first": PAGE_SIZE,
                        "after": input.cursor,
                        "scope": list_scope(input.scope),
                        "ref": input.git_ref,
                        "withCount": with_count,
                    }),
                    operation,
                    Budget::Read,
                    c,
                )
                .await?;
            let list = parse_list(&value, context, operation)?;
            Ok(ListRead {
                rows: list.rows,
                next_cursor: list.next_cursor,
                total: list.total,
                workflows: None,
            })
        })
    }

    fn detail<'a>(
        &'a self,
        scope: &'a HostScope,
        context: &'a HostContext,
        pipeline_id: u64,
        _attempt: Option<u64>,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, Detail> {
        Box::pin(async move {
            let operation = "pipelines.get";
            let value = self
                .pipelines_graphql(
                    scope,
                    super::graphql::pipeline_detail_query,
                    json!({
                        "projectPath": scope.repository,
                        "id": format!("{PIPELINE_GID}{pipeline_id}"),
                    }),
                    operation,
                    Budget::Large,
                    c,
                )
                .await?;
            let detail = parse_detail(&value, context, operation)?;
            if detail.pipeline.id != pipeline_id {
                return Err(invalid(operation));
            }
            Ok(detail)
        })
    }

    fn job<'a>(
        &'a self,
        scope: &'a HostScope,
        context: &'a HostContext,
        job_id: u64,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, JobDetail> {
        Box::pin(async move {
            let operation = "pipelines.getJob";
            let path = format!("{}/jobs/{job_id}", project_path(scope));
            let value = self.pipelines_rest(scope, &path, operation, c).await?;
            let job = parse_job_detail(&value, context, operation)?;
            if job.job.id != job_id {
                return Err(invalid(operation));
            }
            Ok(job)
        })
    }

    fn trace<'a>(
        &'a self,
        scope: &'a HostScope,
        job_id: u64,
        _attempt: Option<u64>,
        range: Option<(u64, u64)>,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, TraceRead> {
        Box::pin(async move {
            let operation = "pipelines.getJobLog";
            let mut path = format!("{}/jobs/{job_id}/trace", project_path(scope));
            // A range read keeps its headers (`-i`) for the rate-limit pause. A
            // whole download does not: its kept tail must be all log text.
            let (budget, include_headers) = match range {
                Some((offset, limit)) => {
                    path.push_str(&format!("?byte_offset={offset}&byte_limit={limit}"));
                    (Budget::Read, true)
                }
                None => (Budget::Log, false),
            };
            let started = std::time::Instant::now();
            let output = self
                .runner
                .glab_api_raw(scope, &path, None, include_headers, budget, c)
                .await;
            super::trace_gitlab_read(operation, "trace", started);
            let output = output.map_err(|failure| read_failure(operation, "glab", &failure))?;
            if c.is_cancelled() {
                return Err(PullRequestsOperationError::new(operation, "timeout"));
            }
            let bytes = if include_headers {
                backoff::split_response(&output.stdout).1.to_vec()
            } else {
                output.stdout
            };
            Ok(TraceRead {
                bytes,
                dropped: output.dropped_bytes as u64,
            })
        })
    }

    /// `POST pipelines/:id/retry|cancel` or `jobs/:id/retry|cancel|play`,
    /// with `-i` so a 429 keeps GitLab's own pause.
    fn run_action<'a>(
        &'a self,
        scope: &'a HostScope,
        _context: &'a HostContext,
        target: ActionTarget,
        action: ActionKind,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, ActionResult> {
        Box::pin(async move {
            let path = action_path(scope, target, action)?;
            let started = std::time::Instant::now();
            let output = self
                .runner
                .glab_api_raw(scope, &path, Some(&json!({})), true, Budget::Read, c)
                .await;
            super::trace_gitlab_read(ACTION_OP, "action", started);
            let output = output.map_err(|failure| action_failure(&failure))?;
            let (_, body) = backoff::split_response(&output.stdout);
            let value: Value = serde_json::from_slice(body).map_err(|_| invalid(ACTION_OP))?;
            parse_action(&value, target)
        })
    }
}

#[cfg(test)]
pub(crate) fn test_context() -> HostContext {
    use crate::pull_requests::model::{MergePolicy, PullRequestsProvider, RepositoryPermission};
    HostContext {
        provider: PullRequestsProvider::Gitlab,
        host: "gitlab.example".into(),
        host_version: None,
        repository: "team/repo".into(),
        default_branch: "main".into(),
        account: Actor {
            login: "ana".into(),
            name: None,
            is_bot: false,
        },
        repository_permission: RepositoryPermission::Write,
        merge_policy: MergePolicy {
            methods: vec![],
            default_method: None,
            delete_branch_default: false,
            auto_merge_allowed: false,
            requires_pipeline_success: false,
            requires_resolved_discussions: false,
        },
        web_url: "https://gitlab.example/team/repo".into(),
        raw_host_version: None,
        gitlab_access_level: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/pull_requests/gitlab_pipelines_list.json"
        ))
        .unwrap()
    }

    fn detail_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/pull_requests/gitlab_pipeline_detail.json"
        ))
        .unwrap()
    }

    #[test]
    fn gitlab_pipelines_list_parses_ids_labels_refs_badges_stages_permissions_and_reasons() {
        let list = parse_list(&list_fixture(), &test_context(), "pipelines.list").unwrap();
        assert_eq!(list.rows.len(), 4);
        assert_eq!(list.next_cursor.as_deref(), Some("eyJpZCI6NDgxOH0"));
        assert_eq!(
            list.total,
            Some(Total {
                count: 1000,
                capped: true
            })
        );

        let branch = &list.rows[0];
        assert_eq!((branch.id, branch.label.as_str()), (4821, "#4821"));
        assert_eq!(branch.title.as_deref(), Some("Fix the flaky login test"));
        assert_eq!(branch.status, PipelineStatus::Failed);
        assert!(branch.terminal);
        assert_eq!(branch.git_ref.kind, RefKind::Branch);
        assert_eq!(branch.git_ref.name, "main");
        assert_eq!(
            branch.git_ref.url.as_deref(),
            Some("https://gitlab.example/team/repo/-/commits/main")
        );
        assert_eq!(branch.badges, vec![Badge::Latest, Badge::Branch]);
        assert_eq!(branch.reason, Some(Reason::FailureReason));
        assert_eq!(
            branch
                .actor
                .as_ref()
                .map(|a| (a.login.as_str(), a.name.as_deref())),
            Some(("ana", Some("Ana Rossi")))
        );
        assert_eq!(
            branch.permissions,
            Some(RowPermissions {
                retry: Permission::Granted,
                cancel: Permission::Denied,
            })
        );
        assert_eq!(
            branch.url.as_deref(),
            Some("https://gitlab.example/team/repo/-/pipelines/4821")
        );
        let stages = branch.stages.as_ref().unwrap();
        assert_eq!(
            stages
                .iter()
                .map(|s| (s.name.as_str(), s.status, s.warnings))
                .collect::<Vec<_>>(),
            [
                ("build", PipelineStatus::Success, false),
                ("test", PipelineStatus::Failed, false),
                ("lint", PipelineStatus::Success, true),
            ]
        );

        let request = &list.rows[1];
        assert_eq!(request.git_ref.kind, RefKind::MergeRequest);
        assert_eq!(request.git_ref.number, Some(3941));
        assert_eq!(request.git_ref.name, "!3941");
        assert_eq!(
            request.git_ref.url.as_deref(),
            Some("https://gitlab.example/team/repo/-/merge_requests/3941")
        );
        assert_eq!(request.badges, vec![Badge::MergeRequest]);
        assert_eq!(request.status, PipelineStatus::Running);
        assert!(!request.terminal);
        assert_eq!(
            request.permissions.as_ref().unwrap().cancel,
            Permission::Granted
        );

        let tag = &list.rows[2];
        assert_eq!(tag.git_ref.kind, RefKind::Tag);
        assert_eq!(
            tag.badges,
            vec![
                Badge::Tag,
                Badge::Scheduled,
                Badge::YamlInvalid,
                Badge::Stuck
            ]
        );
        assert_eq!(tag.reason, Some(Reason::YamlError));
        assert_eq!(
            tag.title.as_deref(),
            Some("nightly"),
            "a pipeline name wins"
        );

        // A webPath off the project origin is never followed.
        let other = &list.rows[3];
        assert_eq!(other.url, None);
        assert_eq!(other.stages, None, "hidden stages");
        assert_eq!(other.permissions, None, "no host answer");
        assert_eq!(other.actor, None);
    }

    #[test]
    fn gitlab_pipelines_all_thirteen_statuses_map_and_unknown_is_unknown() {
        for (raw, expected) in [
            ("CREATED", PipelineStatus::Created),
            ("WAITING_FOR_RESOURCE", PipelineStatus::Queued),
            ("PREPARING", PipelineStatus::Queued),
            ("PENDING", PipelineStatus::Queued),
            ("RUNNING", PipelineStatus::Running),
            ("WAITING_FOR_CALLBACK", PipelineStatus::Waiting),
            ("MANUAL", PipelineStatus::Manual),
            ("SCHEDULED", PipelineStatus::Scheduled),
            ("CANCELING", PipelineStatus::Canceling),
            ("SUCCESS", PipelineStatus::Success),
            ("FAILED", PipelineStatus::Failed),
            ("CANCELED", PipelineStatus::Canceled),
            ("SKIPPED", PipelineStatus::Skipped),
            ("SOMETHING_NEW", PipelineStatus::Unknown),
        ] {
            let mut node = list_fixture()["data"]["project"]["pipelines"]["nodes"][0].clone();
            node["status"] = json!(raw);
            let row = parse_row(&node, &test_context(), "pipelines.list").unwrap();
            assert_eq!(row.status, expected, "{raw}");
            assert_eq!(
                row.terminal,
                matches!(
                    expected,
                    PipelineStatus::Success
                        | PipelineStatus::Failed
                        | PipelineStatus::Canceled
                        | PipelineStatus::Skipped
                ),
                "{raw}"
            );
        }
    }

    #[test]
    fn gitlab_pipeline_detail_keeps_stage_order_groups_triggers_and_truncation() {
        let detail = parse_detail(&detail_fixture(), &test_context(), "pipelines.get").unwrap();
        assert_eq!(detail.pipeline.id, 4821);
        assert_eq!(detail.total_jobs, Some(6));
        assert!(detail.uses_needs);
        assert!(detail.truncated, "a group's hasNextPage sets truncated");
        assert_eq!(detail.commit.sha, "abc1234def");
        assert_eq!(
            detail.commit.url.as_deref(),
            Some("https://gitlab.example/team/repo/-/commit/abc1234def")
        );
        let stages = detail.stages.as_ref().unwrap();
        assert_eq!(
            stages.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["build", "test", "deploy"]
        );
        let rspec = &stages[1].groups[0];
        assert_eq!(
            (rspec.name.as_str(), rspec.size, rspec.jobs.len()),
            ("rspec", 3, 3)
        );
        assert_eq!(rspec.status, PipelineStatus::Failed);
        let allowed = &stages[1].groups[1].jobs[0];
        assert_eq!(allowed.status, PipelineStatus::Failed);
        assert!(allowed.warnings, "an allowed failure is a warning");
        let trigger = &stages[2].groups[0].jobs[0];
        assert_eq!(trigger.kind, JobKind::Trigger);
        assert_eq!(
            trigger.downstream_url.as_deref(),
            Some("https://gitlab.example/team/downstream/-/pipelines/5000")
        );
        assert_eq!(trigger.id, 1004);
        let first = &stages[0].groups[0].jobs[0];
        assert_eq!(first.id, 998);
        assert_eq!(
            first.url.as_deref(),
            Some("https://gitlab.example/team/repo/-/jobs/998")
        );
        assert_eq!(first.permissions.retry, Permission::Granted);
        assert_eq!(first.permissions.play, Permission::Denied);
        let manual = &stages[2].groups[1].jobs[0];
        assert_eq!(manual.status, PipelineStatus::Manual);
        assert_eq!(manual.permissions.play, Permission::Granted);
    }

    #[test]
    fn gitlab_pipeline_detail_without_job_access_has_null_stages_and_a_missing_one_is_not_found() {
        let mut value = detail_fixture();
        value["data"]["project"]["pipeline"]["stages"] = Value::Null;
        let detail = parse_detail(&value, &test_context(), "pipelines.get").unwrap();
        assert_eq!(detail.stages, None);
        value["data"]["project"]["pipeline"] = Value::Null;
        assert_eq!(
            parse_detail(&value, &test_context(), "pipelines.get")
                .unwrap_err()
                .code,
            "not_found"
        );
    }

    #[test]
    fn gitlab_pipeline_global_ids_round_trip_and_other_kinds_are_refused() {
        assert_eq!(
            global_id(&json!("gid://gitlab/Ci::Pipeline/4821")),
            Some(4821)
        );
        assert_eq!(global_id(&json!("gid://gitlab/Ci::Bridge/7")), Some(7));
        assert_eq!(global_id(&json!("4821")), None);
        assert_eq!(global_id(&json!("gid://gitlab/Ci::Pipeline/0")), None);
        let mut node = list_fixture()["data"]["project"]["pipelines"]["nodes"][0].clone();
        node["id"] = json!("gid://gitlab/Ci::Build/4821");
        assert!(parse_row(&node, &test_context(), "pipelines.list").is_err());
    }

    #[test]
    fn gitlab_job_detail_reads_runner_tags_artifacts_trace_size_and_raw_link() {
        let value: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/pull_requests/gitlab_job.json"
        ))
        .unwrap();
        let job = parse_job_detail(&value, &test_context(), "pipelines.getJob").unwrap();
        assert_eq!(job.job.id, 998);
        assert_eq!(job.job.stage, "test");
        assert_eq!(job.pipeline_id, 4821);
        assert_eq!(job.log_bytes, Some(5321));
        assert_eq!(job.tags, ["docker", "linux"]);
        assert_eq!(job.source.as_deref(), Some("push"));
        assert_eq!(
            job.runner,
            Some(Runner {
                name: "shared-runner-1".into(),
                description: Some("shared-runner-1".into())
            })
        );
        assert_eq!(
            job.artifacts.len(),
            1,
            "the trace is the log, not an artifact"
        );
        assert_eq!(job.artifacts[0].name, "artifacts.zip");
        assert!(job.artifacts[0].expired);
        assert_eq!(
            job.raw_log_url.as_deref(),
            Some("https://gitlab.example/team/repo/-/jobs/998/raw")
        );
        assert_eq!(job.job.reason, Some(Reason::FailureReason));
        assert!(!job.erased);

        let mut off_origin = value.clone();
        off_origin["web_url"] = json!("https://evil.example/team/repo/-/jobs/998");
        let job = parse_job_detail(&off_origin, &test_context(), "pipelines.getJob").unwrap();
        assert_eq!((job.job.url, job.raw_log_url), (None, None));
    }

    #[test]
    fn gitlab_pipelines_missing_field_errors_are_recognised() {
        assert!(missing_field(
            &json!({"errors":[{"message":"Field 'stuck' doesn't exist on type 'Pipeline'"}]})
        ));
        assert!(!missing_field(
            &json!({"errors":[{"message":"Internal error"}]})
        ));
        assert!(!missing_field(&json!({"data":{}})));
    }
}

#[cfg(all(test, unix))]
mod process_tests {
    use super::*;
    use crate::{pull_requests::host::HostCommandRunner, test_support::TestSandbox};
    use std::sync::Arc;

    #[test]
    fn gitlab_pipeline_actions_map_to_their_endpoints_and_return_the_new_job() {
        let scope = HostScope {
            cwd: std::path::PathBuf::from("checkout"),
            host: "gitlab.example".into(),
            repository: "team/repo".into(),
            provider: crate::pull_requests::model::PullRequestsProvider::Gitlab,
        };
        let pipeline = ActionTarget::Pipeline { id: 4821 };
        let job = ActionTarget::Job { id: 998 };
        for (target, action, path) in [
            (pipeline, ActionKind::Retry, "pipelines/4821/retry"),
            (pipeline, ActionKind::RetryFailed, "pipelines/4821/retry"),
            (pipeline, ActionKind::Cancel, "pipelines/4821/cancel"),
            (job, ActionKind::Retry, "jobs/998/retry"),
            (job, ActionKind::Cancel, "jobs/998/cancel"),
            (job, ActionKind::Play, "jobs/998/play"),
        ] {
            assert_eq!(
                action_path(&scope, target, action).unwrap(),
                format!("projects/team%2Frepo/{path}"),
                "{target:?} {action:?}"
            );
        }
        for (target, action) in [(pipeline, ActionKind::Play), (job, ActionKind::RetryFailed)] {
            assert_eq!(
                action_path(&scope, target, action).unwrap_err().code,
                "unavailable"
            );
        }
        // A retried job is a new one in the same pipeline.
        assert_eq!(
            parse_action(&json!({"id": 1001, "pipeline": {"id": 4821}}), job).unwrap(),
            ActionResult {
                pipeline_id: Some(4821),
                job_id: Some(1001)
            }
        );
        assert_eq!(
            parse_action(&json!({"id": 4821, "status": "pending"}), pipeline).unwrap(),
            ActionResult {
                pipeline_id: Some(4821),
                job_id: None
            }
        );
        assert_eq!(
            parse_action(&json!({"message": "x"}), job)
                .unwrap_err()
                .code,
            "invalid_response"
        );
    }

    fn scope(s: &TestSandbox) -> HostScope {
        HostScope {
            cwd: s.root().into(),
            host: "gitlab.example".into(),
            repository: "team/repo".into(),
            provider: crate::pull_requests::model::PullRequestsProvider::Gitlab,
        }
    }

    fn input(s: &TestSandbox, cursor: Option<&str>) -> ListInput {
        serde_json::from_value(json!({"cwd": s.root(), "scope": "all", "ref": null,
            "workflowId": null, "cursor": cursor, "refresh": "user"}))
        .unwrap()
    }

    /// A "Field doesn't exist" answer retries once with the baseline
    /// document, and the host keeps the baseline afterwards.
    #[tokio::test]
    async fn gitlab_pipelines_list_falls_back_to_the_baseline_once_and_remembers_it() {
        let s = TestSandbox::new("pipelines-baseline");
        std::fs::write(
            s.path("list.json"),
            include_str!("../../../tests/fixtures/pull_requests/gitlab_pipelines_list.json"),
        )
        .unwrap();
        let glab = s.executable_script(
            "glab",
            r#"while [ "$1" != --input ]; do shift; done
cp "$2" query.json
if grep -q mergeRequestEventType query.json; then
  echo full >> calls
  printf 'HTTP/2 200 OK\r\n\r\n{"errors":[{"message":"Field '"'"'mergeRequestEventType'"'"' doesn'"'"'t exist on type '"'"'Pipeline'"'"'"}]}'
else
  echo baseline >> calls
  printf 'HTTP/2 200 OK\r\n\r\n'; cat list.json
fi"#,
            "",
        );
        let host = GitLabHost::new(Arc::new(
            HostCommandRunner::new(s.path("state")).with_commands("missing-gh", &glab, "git"),
        ));
        let c = CancellationToken::new();
        let input = input(&s, None);
        for _ in 0..2 {
            let read = host
                .list(&scope(&s), &test_context(), &input, true, &c)
                .await
                .unwrap();
            assert_eq!(read.rows.len(), 4);
        }
        assert_eq!(
            std::fs::read_to_string(s.path("calls")).unwrap(),
            "full\nbaseline\nbaseline\n"
        );
    }

    /// `count` rides only on the reads that ask for it, and a later page
    /// sends its cursor.
    #[tokio::test]
    async fn gitlab_pipelines_list_selects_count_only_when_asked() {
        let s = TestSandbox::new("pipelines-count");
        std::fs::write(
            s.path("list.json"),
            include_str!("../../../tests/fixtures/pull_requests/gitlab_pipelines_list.json"),
        )
        .unwrap();
        let glab = s.executable_script(
            "glab",
            r#"while [ "$1" != --input ]; do shift; done
cat "$2" >> bodies; echo >> bodies
printf 'HTTP/2 200 OK\r\n\r\n'; cat list.json"#,
            "",
        );
        let host = GitLabHost::new(Arc::new(
            HostCommandRunner::new(s.path("state")).with_commands("missing-gh", &glab, "git"),
        ));
        let c = CancellationToken::new();
        host.list(&scope(&s), &test_context(), &input(&s, None), true, &c)
            .await
            .unwrap();
        host.list(
            &scope(&s),
            &test_context(),
            &input(&s, Some("abc")),
            false,
            &c,
        )
        .await
        .unwrap();
        let bodies: Vec<Value> = std::fs::read_to_string(s.path("bodies"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(bodies[0]["variables"]["withCount"], true);
        assert_eq!(bodies[0]["variables"]["after"], Value::Null);
        assert_eq!(bodies[0]["variables"]["first"], 15);
        assert_eq!(bodies[1]["variables"]["withCount"], false);
        assert_eq!(bodies[1]["variables"]["after"], "abc");
    }

    /// A 429 keeps its `Retry-After` through a non-zero exit.
    #[tokio::test]
    async fn gitlab_pipelines_rate_limit_carries_the_provider_pause() {
        let s = TestSandbox::new("pipelines-429");
        let glab = s.executable_script(
            "glab",
            r#"printf 'HTTP/2 429 Too Many Requests\r\nRetry-After: 240\r\n\r\n{"message":"429 Too Many Requests"}'
echo 'glab: 429 Too Many Requests (HTTP 429)' >&2
exit 1"#,
            "",
        );
        let host = GitLabHost::new(Arc::new(
            HostCommandRunner::new(s.path("state")).with_commands("missing-gh", &glab, "git"),
        ));
        let error = host
            .job(&scope(&s), &test_context(), 998, &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code, "rate_limited");
        assert_eq!(error.retry_after_seconds, Some(240));
    }

    /// A range read asks for its window and drops the headers; a whole
    /// download asks for none and keeps the log's last bytes.
    #[tokio::test]
    async fn gitlab_trace_reads_ranges_with_headers_and_whole_logs_without() {
        let s = TestSandbox::new("pipelines-trace");
        let glab = s.executable_script(
            "glab",
            r#"printf '%s\n' "$*" >> calls
case "$*" in
  *-i*) printf 'HTTP/2 200 OK\r\nContent-Type: text/plain\r\n\r\nwindow' ;;
  *) printf 'whole log' ;;
esac"#,
            "",
        );
        let host = GitLabHost::new(Arc::new(
            HostCommandRunner::new(s.path("state")).with_commands("missing-gh", &glab, "git"),
        ));
        let c = CancellationToken::new();
        let range = host
            .trace(&scope(&s), 998, None, Some((512_000, 512_000)), &c)
            .await
            .unwrap();
        assert_eq!(range.bytes, b"window");
        let whole = host.trace(&scope(&s), 998, None, None, &c).await.unwrap();
        assert_eq!(
            (whole.bytes.as_slice(), whole.dropped),
            (&b"whole log"[..], 0)
        );
        let calls = std::fs::read_to_string(s.path("calls")).unwrap();
        let calls: Vec<_> = calls.lines().collect();
        assert_eq!(
            calls[0],
            "api -i projects/team%2Frepo/jobs/998/trace?byte_offset=512000&byte_limit=512000 --hostname gitlab.example"
        );
        assert_eq!(
            calls[1],
            "api projects/team%2Frepo/jobs/998/trace --hostname gitlab.example"
        );
    }

    #[tokio::test]
    async fn gitlab_actions_post_with_headers_and_a_429_keeps_gitlabs_pause() {
        let s = TestSandbox::new("pipelines-action");
        let glab = s.executable_script(
            "glab",
            r#"printf '%s\n' "$*" >> calls
case "$*" in
  *jobs/998/retry*) printf 'HTTP/2 201 Created\r\n\r\n{"id":1001,"pipeline":{"id":4821}}' ;;
  *jobs/999/retry*) printf 'HTTP/2 403 Forbidden\r\n\r\n{"message":"403 Forbidden - Job is not retryable"}'
     echo 'glab: 403 Forbidden - Job is not retryable (HTTP 403)' >&2; exit 1 ;;
  *) printf 'HTTP/2 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n{}'
     echo 'glab: 429 Too Many Requests (HTTP 429)' >&2; exit 1 ;;
esac"#,
            "",
        );
        let host = GitLabHost::new(Arc::new(
            HostCommandRunner::new(s.path("state")).with_commands("missing-gh", &glab, "git"),
        ));
        let c = CancellationToken::new();
        let retried = host
            .run_action(
                &scope(&s),
                &test_context(),
                ActionTarget::Job { id: 998 },
                ActionKind::Retry,
                &c,
            )
            .await
            .unwrap();
        assert_eq!(
            retried,
            ActionResult {
                pipeline_id: Some(4821),
                job_id: Some(1001)
            }
        );
        let error = host
            .run_action(
                &scope(&s),
                &test_context(),
                ActionTarget::Pipeline { id: 4821 },
                ActionKind::Cancel,
                &c,
            )
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.retry_after_seconds),
            ("rate_limited", Some(60))
        );
        let calls = std::fs::read_to_string(s.path("calls")).unwrap();
        let calls: Vec<_> = calls.lines().collect();
        assert!(
            calls[0].starts_with("api -i --method POST projects/team%2Frepo/jobs/998/retry "),
            "{}",
            calls[0]
        );
        assert!(
            calls[0].ends_with("--hostname gitlab.example"),
            "{}",
            calls[0]
        );
        assert!(calls[1].contains("projects/team%2Frepo/pipelines/4821/cancel"));

        // A job already retried is about its state, not the account.
        let moved_on = host
            .run_action(
                &scope(&s),
                &test_context(),
                ActionTarget::Job { id: 999 },
                ActionKind::Retry,
                &c,
            )
            .await
            .unwrap_err();
        assert_eq!(moved_on.code, "host_rejected");
        assert_eq!(
            moved_on.message,
            "This job can't be retried now. Refresh to see its status."
        );
    }
}
