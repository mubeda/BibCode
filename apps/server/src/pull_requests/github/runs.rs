//! GitHub Actions as pipelines: one workflow run per row, its jobs in one
//! "Jobs" column, a job's steps, and its log once it completes. Every read is
//! `gh api` REST pinned to the host and to API version 2022-11-28. Every link
//! is built on the repository's web URL, never taken from response text, and
//! no API URL (artifact downloads, log redirects) reaches the client.

use futures_util::future::{try_join, try_join_all, try_join3};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio_util::sync::CancellationToken;

use super::GitHubHost;
use crate::pull_requests::{
    backoff,
    error::PullRequestsOperationError,
    host::{Budget, HostContext, HostFuture, HostScope},
    model::{Actor, PipelineStatus, RepositoryPermission},
    pipelines::{
        ListRead, PipelineHost, TraceRead,
        model::{
            Artifact, Badge, Commit, Detail, DetailStage, Job, JobDetail, JobGroup, JobKind,
            JobPermissions, ListInput, ListScope, Permission, PipelineRef, Reason, RefKind, Row,
            RowPermissions, Runner, Step, Total, Workflow,
        },
        read_failure,
    },
};

/// Runs per list page. REST has no GraphQL cost, so a page holds more than
/// GitLab's 15; the difference is invisible behind "Load more".
pub(crate) const PAGE_SIZE: u64 = 20;
/// Jobs per page, and the most pages one detail read follows (1,000 jobs).
pub(crate) const JOBS_PAGE_SIZE: u64 = 100;
pub(crate) const MAX_JOB_PAGES: u64 = 10;
/// GitHub stops a filtered run list here.
const FILTERED_RESULTS_CAP: u64 = 1000;

/// A query value: everything but the unreserved characters is encoded.
const QUERY: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');
/// A path whose `/` separators stay (a branch in `tree/<branch>`).
const PATH: &AsciiSet = &QUERY.remove(b'/');

/// GitHub's copy for a 404 on the run list: it answers 404 both when Actions
/// is turned off and when the sign-in may not read Actions.
pub(crate) const RUNS_NOT_FOUND_MESSAGE: &str = "GitHub didn't return workflow runs for this \
     repository. Actions may be turned off, or your sign-in may not be allowed to read Actions.";

fn invalid(operation: &str) -> PullRequestsOperationError {
    PullRequestsOperationError::new(operation, "invalid_response")
}

fn text(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
}

fn positive(value: &Value) -> Option<u64> {
    value.as_u64().filter(|id| *id > 0)
}

fn timestamp(value: Option<&str>) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value?, &Rfc3339).ok()
}

/// Seconds between two RFC 3339 times, when both parse and run forwards.
fn seconds_between(start: Option<&str>, end: Option<&str>) -> Option<f64> {
    let seconds = (timestamp(end)? - timestamp(start)?).as_seconds_f64();
    (seconds >= 0.0).then_some(seconds)
}

/// The repository's web URL, when it is a plain http(s) URL to build on.
fn web_base(context: &HostContext) -> Option<&str> {
    let base = context.web_url.trim_end_matches('/');
    let (scheme, rest) = base.split_once("://")?;
    (matches!(scheme, "http" | "https")
        && !rest.is_empty()
        && !rest.starts_with('/')
        && !base.contains(['\n', '\r', '\\']))
    .then_some(base)
}

fn link(context: &HostContext, suffix: &str) -> Option<String> {
    web_base(context).map(|base| format!("{base}/{suffix}"))
}

/// The page of a run, or of one of its earlier attempts.
pub(crate) fn run_url(context: &HostContext, run: u64, attempt: Option<u64>) -> Option<String> {
    match attempt {
        Some(attempt) => link(context, &format!("actions/runs/{run}/attempts/{attempt}")),
        None => link(context, &format!("actions/runs/{run}")),
    }
}

/// GitHub's run and job `status`/`conclusion`: the status that picks the
/// icon, the reason that names it, and whether anything more will run.
pub(crate) fn status(
    status: Option<&str>,
    conclusion: Option<&str>,
) -> (PipelineStatus, Option<Reason>, bool) {
    match (status, conclusion) {
        (Some("queued" | "requested" | "pending"), _) => (PipelineStatus::Queued, None, false),
        (Some("waiting"), _) => (PipelineStatus::Waiting, Some(Reason::Approval), false),
        (Some("in_progress"), _) => (PipelineStatus::Running, None, false),
        (Some("completed"), conclusion) => match conclusion {
            Some("success") => (PipelineStatus::Success, None, true),
            Some("failure") => (PipelineStatus::Failed, None, true),
            Some("timed_out") => (PipelineStatus::Failed, Some(Reason::TimedOut), true),
            Some("startup_failure") => (PipelineStatus::Failed, Some(Reason::StartupFailure), true),
            Some("action_required") => (PipelineStatus::Manual, Some(Reason::ActionRequired), true),
            Some("cancelled") => (PipelineStatus::Canceled, None, true),
            Some("skipped") => (PipelineStatus::Skipped, None, true),
            Some("neutral") => (PipelineStatus::Skipped, Some(Reason::Neutral), true),
            Some("stale") => (PipelineStatus::Skipped, Some(Reason::Stale), true),
            _ => (PipelineStatus::Unknown, None, true),
        },
        _ => (PipelineStatus::Unknown, None, false),
    }
}

fn value_status(value: &Value) -> (PipelineStatus, Option<Reason>, bool) {
    status(value["status"].as_str(), value["conclusion"].as_str())
}

/// GitHub has no read that proves Actions write. Below repository write the
/// answer is no; at write or above it is only a hint, so the action stays
/// enabled and the host's refusal, if any, is shown at the button.
pub(crate) fn permission(context: &HostContext) -> Permission {
    match context.repository_permission {
        RepositoryPermission::Write
        | RepositoryPermission::Maintain
        | RepositoryPermission::Admin => Permission::Unknown,
        RepositoryPermission::None | RepositoryPermission::Read | RepositoryPermission::Triage => {
            Permission::Denied
        }
    }
}

fn run_ref(run: &Value, context: &HostContext) -> PipelineRef {
    let request = run["pull_requests"]
        .as_array()
        .and_then(|requests| requests.first());
    if let Some(number) = request.and_then(|request| positive(&request["number"])) {
        return PipelineRef {
            kind: RefKind::MergeRequest,
            name: format!("#{number}"),
            number: Some(number),
            url: link(context, &format!("pull/{number}")),
        };
    }
    let Some(name) = text(run, "head_branch") else {
        return PipelineRef {
            kind: RefKind::Other,
            name: String::new(),
            number: None,
            url: None,
        };
    };
    // A release run's head is its tag; a pushed tag reads as a branch, which
    // the run object cannot tell apart.
    let tag = run["event"].as_str() == Some("release");
    PipelineRef {
        url: link(
            context,
            &format!("tree/{}", utf8_percent_encode(&name, PATH)),
        ),
        kind: if tag { RefKind::Tag } else { RefKind::Branch },
        name,
        number: None,
    }
}

fn badges(run: &Value, git_ref: &PipelineRef) -> Vec<Badge> {
    let mut badges = Vec::new();
    match run["event"].as_str() {
        Some("schedule") => badges.push(Badge::Scheduled),
        Some(
            "pull_request"
            | "pull_request_target"
            | "pull_request_review"
            | "pull_request_review_comment",
        ) => badges.push(Badge::MergeRequest),
        Some("merge_group") => badges.push(Badge::MergeTrain),
        Some("workflow_dispatch") => badges.push(Badge::ManualRun),
        Some("repository_dispatch") => badges.push(Badge::Api),
        Some("workflow_run") => badges.push(Badge::Trigger),
        _ => {}
    }
    match git_ref.kind {
        RefKind::Tag => badges.push(Badge::Tag),
        RefKind::Branch if run["event"].as_str() == Some("push") => badges.push(Badge::Branch),
        _ => {}
    }
    if run["run_attempt"]
        .as_u64()
        .is_some_and(|attempt| attempt > 1)
    {
        badges.push(Badge::Retried);
    }
    badges
}

fn actor(run: &Value) -> Option<Actor> {
    let person = if run["triggering_actor"].is_object() {
        &run["triggering_actor"]
    } else {
        &run["actor"]
    };
    let login = text(person, "login")?;
    Some(Actor {
        is_bot: person["type"].as_str() == Some("Bot") || login.ends_with("[bot]"),
        login,
        name: None,
    })
}

/// One workflow run: "`<workflow>` #`<run_number>`", titled with GitHub's
/// `display_title`. `attempt` names an earlier attempt's page.
pub(crate) fn parse_run(
    run: &Value,
    context: &HostContext,
    attempt: Option<u64>,
    operation: &str,
) -> Result<Row, PullRequestsOperationError> {
    let id = positive(&run["id"]).ok_or_else(|| invalid(operation))?;
    let (status, reason, terminal) = value_status(run);
    let git_ref = run_ref(run, context);
    let badges = badges(run, &git_ref);
    let workflow = text(run, "name").unwrap_or_else(|| "Workflow".into());
    let label = match run["run_number"].as_u64() {
        Some(number) => format!("{workflow} #{number}"),
        None => workflow,
    };
    let started_at = text(run, "run_started_at");
    // GitHub's own duration for a finished run: last update less its start.
    let finished_at = terminal.then(|| text(run, "updated_at")).flatten();
    let permission = permission(context);
    Ok(Row {
        id,
        label,
        title: text(run, "display_title"),
        status,
        warnings: false,
        reason,
        terminal,
        git_ref,
        sha: text(run, "head_sha").unwrap_or_default(),
        actor: actor(run),
        badges,
        created_at: text(run, "created_at").ok_or_else(|| invalid(operation))?,
        duration_seconds: seconds_between(started_at.as_deref(), finished_at.as_deref()),
        started_at,
        finished_at,
        queued_seconds: None,
        stages: None,
        attempt: run["run_attempt"].as_u64(),
        permissions: Some(RowPermissions {
            retry: permission,
            cancel: permission,
        }),
        url: run_url(context, id, attempt),
    })
}

pub(crate) struct ParsedRuns {
    pub rows: Vec<Row>,
    pub next_cursor: Option<String>,
    pub total: Total,
}

/// A page of `actions/runs`. A filtered list stops at GitHub's 1,000
/// results, so its last cursor is the page that reaches them.
pub(crate) fn parse_runs(
    value: &Value,
    context: &HostContext,
    page: u64,
    filtered: bool,
    operation: &str,
) -> Result<ParsedRuns, PullRequestsOperationError> {
    let runs = value["workflow_runs"]
        .as_array()
        .ok_or_else(|| invalid(operation))?;
    let rows = runs
        .iter()
        .map(|run| parse_run(run, context, None, operation))
        .collect::<Result<Vec<_>, _>>()?;
    let count = value["total_count"].as_u64().unwrap_or(rows.len() as u64);
    let reachable = if filtered {
        count.min(FILTERED_RESULTS_CAP)
    } else {
        count
    };
    let next_cursor =
        (!rows.is_empty() && page * PAGE_SIZE < reachable).then(|| (page + 1).to_string());
    Ok(ParsedRuns {
        rows,
        next_cursor,
        total: Total {
            count: reachable,
            capped: filtered && count > FILTERED_RESULTS_CAP,
        },
    })
}

pub(crate) fn parse_workflows(
    value: &Value,
    operation: &str,
) -> Result<Vec<Workflow>, PullRequestsOperationError> {
    let workflows = value["workflows"]
        .as_array()
        .ok_or_else(|| invalid(operation))?;
    Ok(workflows
        .iter()
        .filter_map(|workflow| {
            Some(Workflow {
                id: positive(&workflow["id"])?,
                name: text(workflow, "name")?,
            })
        })
        .collect())
}

/// One job of a run. GitHub cancels runs, not jobs, and has no manual jobs.
pub(crate) fn parse_job(
    job: &Value,
    context: &HostContext,
    operation: &str,
) -> Result<Job, PullRequestsOperationError> {
    let id = positive(&job["id"]).ok_or_else(|| invalid(operation))?;
    let run = positive(&job["run_id"]).ok_or_else(|| invalid(operation))?;
    let (status, reason, terminal) = value_status(job);
    let started_at = text(job, "started_at");
    let finished_at = text(job, "completed_at").filter(|_| terminal);
    Ok(Job {
        id,
        name: text(job, "name").ok_or_else(|| invalid(operation))?,
        // GitHub has no stages; the page shows one "Jobs" column.
        stage: String::new(),
        kind: JobKind::Build,
        status,
        warnings: false,
        reason,
        terminal,
        duration_seconds: seconds_between(started_at.as_deref(), finished_at.as_deref()),
        queued_seconds: seconds_between(job["created_at"].as_str(), started_at.as_deref()),
        started_at,
        finished_at,
        permissions: JobPermissions {
            retry: permission(context),
            cancel: Permission::Denied,
            play: Permission::Denied,
        },
        url: link(context, &format!("actions/runs/{run}/job/{id}")),
        downstream_url: None,
    })
}

/// A run's artifacts, each opening the run's page, where GitHub offers the
/// download: `archive_download_url` needs a token and expires in a minute.
pub(crate) fn parse_artifacts(
    value: &Value,
    context: &HostContext,
    run: u64,
    operation: &str,
) -> Result<Vec<Artifact>, PullRequestsOperationError> {
    let artifacts = value["artifacts"]
        .as_array()
        .ok_or_else(|| invalid(operation))?;
    let page = run_url(context, run, None);
    Ok(artifacts
        .iter()
        .filter_map(|artifact| {
            Some(Artifact {
                name: text(artifact, "name")?,
                size_bytes: artifact["size_in_bytes"].as_u64(),
                expires_at: text(artifact, "expires_at"),
                expired: artifact["expired"].as_bool() == Some(true),
                url: page.clone(),
            })
        })
        .collect())
}

/// One run with every jobs page read and its artifacts. Past 1,000 jobs the
/// first 1,000 are shown with `truncated`; no job is dropped without it.
pub(crate) fn parse_detail(
    run: &Value,
    job_pages: &[Value],
    artifacts: &Value,
    context: &HostContext,
    attempt: Option<u64>,
    operation: &str,
) -> Result<Detail, PullRequestsOperationError> {
    let pipeline = parse_run(run, context, attempt, operation)?;
    let mut jobs = Vec::new();
    for page in job_pages {
        for job in page["jobs"].as_array().ok_or_else(|| invalid(operation))? {
            jobs.push(parse_job(job, context, operation)?);
        }
    }
    let total = job_pages
        .first()
        .and_then(|page| page["total_count"].as_u64())
        .unwrap_or(jobs.len() as u64);
    jobs.truncate((MAX_JOB_PAGES * JOBS_PAGE_SIZE) as usize);
    let truncated = total > jobs.len() as u64;
    let groups = jobs
        .into_iter()
        .map(|job| JobGroup {
            name: job.name.clone(),
            size: 1,
            status: job.status,
            jobs: vec![job],
        })
        .collect();
    let message = run["head_commit"]["message"].as_str().unwrap_or_default();
    Ok(Detail {
        revision: 0,
        commit: Commit {
            title: message
                .lines()
                .next()
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_owned),
            url: (!pipeline.sha.is_empty())
                .then(|| link(context, &format!("commit/{}", pipeline.sha)))
                .flatten(),
            sha: pipeline.sha.clone(),
        },
        stages: Some(vec![DetailStage {
            name: "Jobs".into(),
            status: pipeline.status,
            warnings: false,
            groups,
        }]),
        artifacts: parse_artifacts(artifacts, context, pipeline.id, operation)?,
        pipeline,
        total_jobs: Some(total),
        truncated,
        uses_needs: false,
    })
}

/// `actions/jobs/:id`: the job, its steps, labels and runner.
pub(crate) fn parse_job_detail(
    value: &Value,
    context: &HostContext,
    operation: &str,
) -> Result<JobDetail, PullRequestsOperationError> {
    let job = parse_job(value, context, operation)?;
    let steps = value["steps"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|step| {
            Some(Step {
                number: step["number"].as_u64()?,
                name: text(step, "name")?,
                status: value_status(step).0,
                started_at: text(step, "started_at"),
                completed_at: text(step, "completed_at"),
            })
        })
        .collect();
    let runner = text(value, "runner_name").map(|name| Runner {
        name,
        description: text(value, "runner_group_name"),
    });
    Ok(JobDetail {
        revision: 0,
        pipeline_id: positive(&value["run_id"]).ok_or_else(|| invalid(operation))?,
        attempt: value["run_attempt"].as_u64(),
        runner,
        tags: value["labels"]
            .as_array()
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        source: None,
        created_at: text(value, "created_at")
            .or_else(|| job.started_at.clone())
            .ok_or_else(|| invalid(operation))?,
        // The run's artifacts ride in its pipeline detail, which the job page reads.
        artifacts: Vec::new(),
        steps,
        log_bytes: None,
        erased: false,
        // GitHub's job page is its raw log's home; the log API redirects to a
        // pre-signed URL that expires in a minute.
        raw_log_url: job.url.clone(),
        job,
    })
}

/// The cursor is a page number, opaque to the client.
fn page_number(cursor: Option<&str>, operation: &str) -> Result<u64, PullRequestsOperationError> {
    match cursor {
        None => Ok(1),
        Some(cursor) => cursor
            .parse::<u64>()
            .ok()
            .filter(|page| *page >= 1 && page.checked_mul(PAGE_SIZE).is_some())
            .ok_or_else(|| PullRequestsOperationError::new(operation, "invalid_request")),
    }
}

/// The run list's path and whether GitHub caps it at 1,000 results.
pub(crate) fn runs_path(scope: &HostScope, input: &ListInput, page: u64) -> (String, bool) {
    let base = match input.workflow_id {
        Some(workflow) => format!(
            "repos/{}/actions/workflows/{workflow}/runs",
            scope.repository
        ),
        None => format!("repos/{}/actions/runs", scope.repository),
    };
    let mut path = format!("{base}?per_page={PAGE_SIZE}&page={page}&exclude_pull_requests=false");
    if let Some(branch) = &input.git_ref {
        path.push_str(&format!("&branch={}", utf8_percent_encode(branch, QUERY)));
    }
    match input.scope {
        ListScope::All => {}
        ListScope::Running => path.push_str("&status=in_progress"),
        ListScope::Finished => path.push_str("&status=completed"),
    }
    let filtered = input.git_ref.is_some() || input.scope != ListScope::All;
    (path, filtered)
}

fn jobs_path(scope: &HostScope, run: u64, attempt: Option<u64>, page: u64) -> String {
    let repository = &scope.repository;
    match attempt {
        Some(attempt) => format!(
            "repos/{repository}/actions/runs/{run}/attempts/{attempt}/jobs?per_page={JOBS_PAGE_SIZE}&page={page}"
        ),
        None => format!(
            "repos/{repository}/actions/runs/{run}/jobs?filter=latest&per_page={JOBS_PAGE_SIZE}&page={page}"
        ),
    }
}

impl GitHubHost {
    /// A REST read with `-i`, so a refusal keeps its rate-limit headers.
    async fn runs_api(
        &self,
        scope: &HostScope,
        path: &str,
        budget: Budget,
        operation: &str,
        c: &CancellationToken,
    ) -> Result<Value, PullRequestsOperationError> {
        let output = self
            .runner
            .gh_api_raw(scope, path, true, budget, c)
            .await
            .map_err(|failure| read_failure(operation, "gh", &failure))?;
        if c.is_cancelled() {
            return Err(PullRequestsOperationError::new(operation, "timeout"));
        }
        let (_, body) = backoff::split_response(&output.stdout);
        serde_json::from_slice(body).map_err(|_| invalid(operation))
    }
}

impl PipelineHost for GitHubHost {
    fn live_logs(&self) -> bool {
        false
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
            let page = page_number(input.cursor.as_deref(), operation)?;
            let (path, filtered) = runs_path(scope, input, page);
            let runs = self.runs_api(scope, &path, Budget::Read, operation, c);
            // The Workflow filter's choices, read with the count: on opening a
            // list and on Refresh.
            let workflows = async {
                if !with_count {
                    return Ok(None);
                }
                let path = format!("repos/{}/actions/workflows?per_page=100", scope.repository);
                let value = self
                    .runs_api(scope, &path, Budget::Read, operation, c)
                    .await?;
                parse_workflows(&value, operation).map(Some)
            };
            let (runs, workflows) = try_join(runs, workflows).await.map_err(|mut error| {
                if error.code == "not_found" {
                    error.message = RUNS_NOT_FOUND_MESSAGE.into();
                }
                error
            })?;
            let parsed = parse_runs(&runs, context, page, filtered, operation)?;
            Ok(ListRead {
                rows: parsed.rows,
                next_cursor: parsed.next_cursor,
                total: Some(parsed.total),
                workflows,
            })
        })
    }

    fn detail<'a>(
        &'a self,
        scope: &'a HostScope,
        context: &'a HostContext,
        pipeline_id: u64,
        attempt: Option<u64>,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, Detail> {
        Box::pin(async move {
            let operation = "pipelines.get";
            let repository = &scope.repository;
            // An earlier attempt reads that attempt's run, so the header, status
            // and timing describe the jobs shown.
            let run_path = match attempt {
                Some(attempt) => {
                    format!("repos/{repository}/actions/runs/{pipeline_id}/attempts/{attempt}")
                }
                None => format!("repos/{repository}/actions/runs/{pipeline_id}"),
            };
            let artifacts_path =
                format!("repos/{repository}/actions/runs/{pipeline_id}/artifacts?per_page=100");
            let first_jobs = jobs_path(scope, pipeline_id, attempt, 1);
            let (run, first, artifacts) = try_join3(
                self.runs_api(scope, &run_path, Budget::Read, operation, c),
                self.runs_api(scope, &first_jobs, Budget::Large, operation, c),
                self.runs_api(scope, &artifacts_path, Budget::Read, operation, c),
            )
            .await?;
            let total = first["total_count"].as_u64().unwrap_or(0);
            let pages = total.div_ceil(JOBS_PAGE_SIZE).clamp(1, MAX_JOB_PAGES);
            let rest: Vec<String> = (2..=pages)
                .map(|page| jobs_path(scope, pipeline_id, attempt, page))
                .collect();
            let rest = try_join_all(
                rest.iter()
                    .map(|path| self.runs_api(scope, path, Budget::Large, operation, c)),
            )
            .await?;
            let mut job_pages = Vec::with_capacity(rest.len() + 1);
            job_pages.push(first);
            job_pages.extend(rest);
            let detail = parse_detail(&run, &job_pages, &artifacts, context, attempt, operation)?;
            let attempt_matches =
                attempt.is_none_or(|attempt| detail.pipeline.attempt == Some(attempt));
            if detail.pipeline.id != pipeline_id || !attempt_matches {
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
            let path = format!("repos/{}/actions/jobs/{job_id}", scope.repository);
            let value = self
                .runs_api(scope, &path, Budget::Read, operation, c)
                .await?;
            let job = parse_job_detail(&value, context, operation)?;
            if job.job.id != job_id {
                return Err(invalid(operation));
            }
            Ok(job)
        })
    }

    /// A completed job's whole log: `gh api` follows GitHub's redirect to the
    /// pre-signed download, which never leaves the server. A 410 is a log past
    /// its retention.
    fn trace<'a>(
        &'a self,
        scope: &'a HostScope,
        job_id: u64,
        _attempt: Option<u64>,
        _range: Option<(u64, u64)>,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, TraceRead> {
        Box::pin(async move {
            let operation = "pipelines.getJobLog";
            let path = format!("repos/{}/actions/jobs/{job_id}/logs", scope.repository);
            let output = self
                .runner
                .gh_api_raw(scope, &path, false, Budget::Log, c)
                .await
                .map_err(|failure| {
                    if failure.stderr.contains("HTTP 410") {
                        return PullRequestsOperationError::new(operation, "expired");
                    }
                    read_failure(operation, "gh", &failure)
                })?;
            if c.is_cancelled() {
                return Err(PullRequestsOperationError::new(operation, "timeout"));
            }
            Ok(TraceRead {
                bytes: output.stdout,
                dropped: output.dropped_bytes as u64,
            })
        })
    }
}

#[cfg(test)]
pub(crate) fn test_context() -> HostContext {
    let mut context = crate::pull_requests::gitlab::pipelines::test_context();
    context.provider = crate::pull_requests::model::PullRequestsProvider::Github;
    context.host = "github.com".into();
    context.account.login = "viewer".into();
    context.web_url = "https://github.com/team/repo".into();
    context
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(name: &str) -> Value {
        let text = match name {
            "runs" => include_str!("../../../tests/fixtures/pull_requests/github_runs.json"),
            "run" => include_str!("../../../tests/fixtures/pull_requests/github_run.json"),
            "jobs" => include_str!("../../../tests/fixtures/pull_requests/github_run_jobs.json"),
            "job" => include_str!("../../../tests/fixtures/pull_requests/github_job.json"),
            "artifacts" => {
                include_str!("../../../tests/fixtures/pull_requests/github_run_artifacts.json")
            }
            _ => unreachable!(),
        };
        serde_json::from_str(text).unwrap()
    }

    fn context() -> HostContext {
        test_context()
    }

    #[test]
    fn github_runs_status_table_maps_every_row_with_its_reason_and_terminal_flag() {
        use PipelineStatus as S;
        for (raw_status, conclusion, expected) in [
            (Some("queued"), None, (S::Queued, None, false)),
            (Some("requested"), None, (S::Queued, None, false)),
            (Some("pending"), None, (S::Queued, None, false)),
            (
                Some("waiting"),
                None,
                (S::Waiting, Some(Reason::Approval), false),
            ),
            (Some("in_progress"), None, (S::Running, None, false)),
            (Some("completed"), Some("success"), (S::Success, None, true)),
            (Some("completed"), Some("failure"), (S::Failed, None, true)),
            (
                Some("completed"),
                Some("timed_out"),
                (S::Failed, Some(Reason::TimedOut), true),
            ),
            (
                Some("completed"),
                Some("startup_failure"),
                (S::Failed, Some(Reason::StartupFailure), true),
            ),
            (
                Some("completed"),
                Some("action_required"),
                (S::Manual, Some(Reason::ActionRequired), true),
            ),
            (
                Some("completed"),
                Some("cancelled"),
                (S::Canceled, None, true),
            ),
            (Some("completed"), Some("skipped"), (S::Skipped, None, true)),
            (
                Some("completed"),
                Some("neutral"),
                (S::Skipped, Some(Reason::Neutral), true),
            ),
            (
                Some("completed"),
                Some("stale"),
                (S::Skipped, Some(Reason::Stale), true),
            ),
            (
                Some("completed"),
                Some("brand_new"),
                (S::Unknown, None, true),
            ),
            (Some("completed"), None, (S::Unknown, None, true)),
            (Some("brand_new"), None, (S::Unknown, None, false)),
            (None, None, (S::Unknown, None, false)),
        ] {
            assert_eq!(
                status(raw_status, conclusion),
                expected,
                "{raw_status:?} {conclusion:?}"
            );
        }
    }

    #[test]
    fn github_runs_parse_labels_refs_badges_actor_duration_and_links() {
        let runs = parse_runs(&fixture("runs"), &context(), 1, false, "pipelines.list").unwrap();
        assert_eq!(runs.rows.len(), 3);
        assert_eq!(runs.next_cursor.as_deref(), Some("2"), "45 runs: page two");
        assert_eq!(
            runs.total,
            Total {
                count: 45,
                capped: false
            }
        );

        let push = &runs.rows[0];
        assert_eq!((push.id, push.label.as_str()), (9001, "CI #312"));
        assert_eq!(push.title.as_deref(), Some("Fix the flaky login test"));
        assert_eq!(
            (push.status, push.reason, push.terminal),
            (PipelineStatus::Failed, None, true)
        );
        assert_eq!(push.git_ref.kind, RefKind::Branch);
        assert_eq!(push.git_ref.name, "feature/login");
        assert_eq!(
            push.git_ref.url.as_deref(),
            Some("https://github.com/team/repo/tree/feature/login")
        );
        assert_eq!(push.badges, vec![Badge::Branch, Badge::Retried]);
        assert_eq!(push.attempt, Some(2));
        assert_eq!(push.sha, "abc1234def");
        assert_eq!(
            push.actor.as_ref().map(|a| (a.login.as_str(), a.is_bot)),
            Some(("ana", false)),
            "the triggering actor wins over the actor"
        );
        // `updated_at - run_started_at`, as `gh run view` reports it.
        assert_eq!(push.duration_seconds, Some(252.0));
        assert_eq!(push.finished_at.as_deref(), Some("2026-10-24T10:05:12Z"));
        assert_eq!(
            push.url.as_deref(),
            Some("https://github.com/team/repo/actions/runs/9001")
        );
        assert_eq!(push.stages, None, "GitHub lists have no stage strip");

        let request = &runs.rows[1];
        assert_eq!(request.git_ref.kind, RefKind::MergeRequest);
        assert_eq!(
            (request.git_ref.name.as_str(), request.git_ref.number),
            ("#14", Some(14))
        );
        assert_eq!(
            request.git_ref.url.as_deref(),
            Some("https://github.com/team/repo/pull/14")
        );
        assert_eq!(request.badges, vec![Badge::MergeRequest]);
        assert_eq!(
            (request.status, request.terminal),
            (PipelineStatus::Running, false)
        );
        assert_eq!(request.finished_at, None);
        assert_eq!(request.duration_seconds, None);
        assert!(request.actor.as_ref().unwrap().is_bot);

        let scheduled = &runs.rows[2];
        assert_eq!(scheduled.badges, vec![Badge::Scheduled]);
        assert_eq!(
            (scheduled.status, scheduled.reason),
            (PipelineStatus::Skipped, Some(Reason::Neutral))
        );
    }

    #[test]
    fn github_filtered_runs_stop_at_1000_results_and_say_so() {
        let mut value = fixture("runs");
        value["total_count"] = json!(1_240);
        let page = parse_runs(&value, &context(), 50, true, "pipelines.list").unwrap();
        assert_eq!(page.next_cursor, None, "page 50 reaches the 1,000th run");
        assert_eq!(
            page.total,
            Total {
                count: 1000,
                capped: true
            }
        );
        let page = parse_runs(&value, &context(), 49, true, "pipelines.list").unwrap();
        assert_eq!(page.next_cursor.as_deref(), Some("50"));
        // An unfiltered list pages to the end.
        let page = parse_runs(&value, &context(), 50, false, "pipelines.list").unwrap();
        assert_eq!(page.next_cursor.as_deref(), Some("51"));
        assert!(!page.total.capped);
    }

    #[test]
    fn github_runs_path_names_the_workflow_branch_and_status_filters() {
        let scope = HostScope {
            cwd: "/repo".into(),
            host: "github.com".into(),
            repository: "team/repo".into(),
            provider: crate::pull_requests::model::PullRequestsProvider::Github,
        };
        let input: ListInput = serde_json::from_value(json!({"cwd":"/repo","scope":"running",
            "ref":"feature/a b","workflowId":77,"cursor":null,"refresh":"user"}))
        .unwrap();
        assert_eq!(
            runs_path(&scope, &input, 3),
            (
                "repos/team/repo/actions/workflows/77/runs?per_page=20&page=3&exclude_pull_requests=false&branch=feature%2Fa%20b&status=in_progress".into(),
                true
            )
        );
        let input: ListInput = serde_json::from_value(json!({"cwd":"/repo","scope":"all",
            "ref":null,"workflowId":null,"cursor":null,"refresh":"user"}))
        .unwrap();
        assert_eq!(
            runs_path(&scope, &input, 1),
            (
                "repos/team/repo/actions/runs?per_page=20&page=1&exclude_pull_requests=false"
                    .into(),
                false
            )
        );
        assert_eq!(
            page_number(Some("x"), "op").unwrap_err().code,
            "invalid_request"
        );
        assert_eq!(
            page_number(Some("0"), "op").unwrap_err().code,
            "invalid_request"
        );
        assert_eq!(page_number(Some("4"), "op").unwrap(), 4);
    }

    #[test]
    fn github_permission_is_unknown_from_write_and_denied_below() {
        let mut context = context();
        for (repository, expected) in [
            (RepositoryPermission::Admin, Permission::Unknown),
            (RepositoryPermission::Maintain, Permission::Unknown),
            (RepositoryPermission::Write, Permission::Unknown),
            (RepositoryPermission::Triage, Permission::Denied),
            (RepositoryPermission::Read, Permission::Denied),
            (RepositoryPermission::None, Permission::Denied),
        ] {
            context.repository_permission = repository;
            assert_eq!(permission(&context), expected, "{repository:?}");
            let row = parse_run(&fixture("run"), &context, None, "op").unwrap();
            assert_eq!(
                row.permissions,
                Some(RowPermissions {
                    retry: expected,
                    cancel: expected
                })
            );
        }
    }

    #[test]
    fn github_detail_puts_every_job_in_one_column_with_artifacts_on_the_run_page() {
        let detail = parse_detail(
            &fixture("run"),
            &[fixture("jobs")],
            &fixture("artifacts"),
            &context(),
            None,
            "pipelines.get",
        )
        .unwrap();
        assert_eq!(detail.pipeline.id, 9001);
        assert_eq!(detail.total_jobs, Some(2));
        assert!(!detail.truncated);
        assert_eq!(
            detail.commit.title.as_deref(),
            Some("Fix the flaky login test")
        );
        assert_eq!(
            detail.commit.url.as_deref(),
            Some("https://github.com/team/repo/commit/abc1234def")
        );
        let stages = detail.stages.as_ref().unwrap();
        assert_eq!(stages.len(), 1);
        let jobs: Vec<_> = detail.jobs().collect();
        assert_eq!(
            jobs.iter()
                .map(|job| (job.id, job.name.as_str(), job.status))
                .collect::<Vec<_>>(),
            [
                (501, "build (ubuntu-latest)", PipelineStatus::Success),
                (502, "test", PipelineStatus::Failed),
            ]
        );
        let test = jobs[1];
        assert_eq!(test.duration_seconds, Some(90.0));
        assert_eq!(test.queued_seconds, Some(5.0));
        assert_eq!(
            test.url.as_deref(),
            Some("https://github.com/team/repo/actions/runs/9001/job/502")
        );
        assert_eq!(
            (test.permissions.cancel, test.permissions.play),
            (Permission::Denied, Permission::Denied)
        );
        assert_eq!(test.stage, "", "GitHub has no stages");
        assert_eq!(
            detail.artifacts,
            vec![
                Artifact {
                    name: "coverage".into(),
                    size_bytes: Some(20_480),
                    expires_at: Some("2027-01-22T10:00:00Z".into()),
                    expired: false,
                    url: Some("https://github.com/team/repo/actions/runs/9001".into()),
                },
                Artifact {
                    name: "old-build".into(),
                    size_bytes: Some(1_024),
                    expires_at: Some("2026-01-01T00:00:00Z".into()),
                    expired: true,
                    url: Some("https://github.com/team/repo/actions/runs/9001".into()),
                },
            ],
            "never the token-bearing archive_download_url"
        );
    }

    fn job_page(total: u64, ids: std::ops::Range<u64>) -> Value {
        let jobs: Vec<Value> = ids
            .map(|id| {
                json!({"id": id, "run_id": 9001, "name": format!("shard {id}"),
                    "status": "completed", "conclusion": "success"})
            })
            .collect();
        json!({"total_count": total, "jobs": jobs})
    }

    #[test]
    fn github_detail_past_1000_jobs_shows_the_first_1000_with_truncated() {
        let pages: Vec<Value> = (0..10)
            .map(|page| job_page(1_240, page * 100 + 1..page * 100 + 101))
            .collect();
        let detail = parse_detail(
            &fixture("run"),
            &pages,
            &json!({"artifacts": []}),
            &context(),
            None,
            "pipelines.get",
        )
        .unwrap();
        assert_eq!(detail.jobs().count(), 1000);
        assert_eq!(detail.total_jobs, Some(1_240));
        assert!(detail.truncated);
    }

    #[test]
    fn github_an_earlier_attempt_links_its_own_page() {
        let mut run = fixture("run");
        run["run_attempt"] = json!(1);
        run["conclusion"] = json!("failure");
        let detail = parse_detail(
            &run,
            &[fixture("jobs")],
            &fixture("artifacts"),
            &context(),
            Some(1),
            "pipelines.get",
        )
        .unwrap();
        assert_eq!(detail.pipeline.attempt, Some(1));
        assert_eq!(detail.pipeline.status, PipelineStatus::Failed);
        assert_eq!(
            detail.pipeline.url.as_deref(),
            Some("https://github.com/team/repo/actions/runs/9001/attempts/1")
        );
    }

    #[test]
    fn github_job_detail_reads_steps_labels_runner_and_its_page_as_the_raw_log() {
        let job = parse_job_detail(&fixture("job"), &context(), "pipelines.getJob").unwrap();
        assert_eq!(
            (job.job.id, job.pipeline_id, job.attempt),
            (502, 9001, Some(2))
        );
        assert_eq!(job.tags, ["ubuntu-latest"]);
        assert_eq!(
            job.runner,
            Some(Runner {
                name: "GitHub Actions 12".into(),
                description: Some("GitHub Actions".into())
            })
        );
        assert_eq!(
            job.steps
                .iter()
                .map(|step| (step.number, step.name.as_str(), step.status))
                .collect::<Vec<_>>(),
            [
                (1, "Set up job", PipelineStatus::Success),
                (2, "Run tests", PipelineStatus::Failed),
                (3, "Post checkout", PipelineStatus::Skipped),
            ]
        );
        assert_eq!(
            job.raw_log_url.as_deref(),
            Some("https://github.com/team/repo/actions/runs/9001/job/502")
        );
        assert!(
            job.artifacts.is_empty(),
            "the run's artifacts are on its detail"
        );
        assert_eq!(job.log_bytes, None);
    }

    #[test]
    fn github_links_are_built_on_the_repository_web_url_only() {
        let mut context = context();
        context.web_url = "javascript:alert(1)".into();
        let row = parse_run(&fixture("run"), &context, None, "op").unwrap();
        assert_eq!((row.url, row.git_ref.url), (None, None));
        let mut run = fixture("run");
        run["html_url"] = json!("https://evil.example/run");
        let row = parse_run(&run, &test_context(), None, "op").unwrap();
        assert_eq!(
            row.url.as_deref(),
            Some("https://github.com/team/repo/actions/runs/9001"),
            "html_url is never followed"
        );
    }

    #[test]
    fn github_workflows_parse_for_the_filter() {
        let workflows = parse_workflows(
            &json!({"total_count": 2, "workflows": [
                {"id": 77, "name": "CI", "path": ".github/workflows/ci.yml"},
                {"id": 78, "name": "", "path": "x"},
            ]}),
            "pipelines.list",
        )
        .unwrap();
        assert_eq!(
            workflows,
            vec![Workflow {
                id: 77,
                name: "CI".into()
            }]
        );
    }
}

#[cfg(all(test, unix))]
mod process_tests {
    use super::*;
    use crate::{pull_requests::host::HostCommandRunner, test_support::TestSandbox};
    use std::sync::Arc;

    fn scope(s: &TestSandbox) -> HostScope {
        HostScope {
            cwd: s.root().into(),
            host: "github.com".into(),
            repository: "team/repo".into(),
            provider: crate::pull_requests::model::PullRequestsProvider::Github,
        }
    }

    fn host(s: &TestSandbox, script: &str) -> GitHubHost {
        let gh = s.executable_script("gh", script, "");
        GitHubHost::new(Arc::new(
            HostCommandRunner::new(s.path("state")).with_commands(&gh, "missing-glab", "git"),
        ))
    }

    fn write_jobs(s: &TestSandbox, total: u64) {
        for page in 1..=total.div_ceil(100) {
            let start = (page - 1) * 100 + 1;
            let end = (page * 100).min(total) + 1;
            let jobs: Vec<Value> = (start..end)
                .map(|id| {
                    serde_json::json!({"id": id, "run_id": 9001, "name": format!("shard {id}"),
                        "status": "completed", "conclusion": "success"})
                })
                .collect();
            std::fs::write(
                s.path(format!("jobs-{page}.json")),
                serde_json::json!({"total_count": total, "jobs": jobs}).to_string(),
            )
            .unwrap();
        }
    }

    /// Answers `gh api -i …`: the run, its jobs pages and its artifacts.
    const DETAIL_SCRIPT: &str = r#"printf '%s\n' "$*" >> calls
path="$7"
case "$path" in
  */jobs\?*page=*) page="${path##*page=}"; printf 'HTTP/2 200 OK\r\n\r\n'; cat "jobs-$page.json" ;;
  */artifacts\?*) printf 'HTTP/2 200 OK\r\n\r\n{"total_count":0,"artifacts":[]}' ;;
  *) printf 'HTTP/2 200 OK\r\n\r\n'; cat run.json ;;
esac"#;

    #[tokio::test]
    async fn github_a_run_with_240_jobs_reads_three_pages_and_shows_all_of_them() {
        let s = TestSandbox::new("github-runs-240");
        std::fs::write(
            s.path("run.json"),
            include_str!("../../../tests/fixtures/pull_requests/github_run.json"),
        )
        .unwrap();
        write_jobs(&s, 240);
        let detail = host(&s, DETAIL_SCRIPT)
            .detail(
                &scope(&s),
                &test_context(),
                9001,
                None,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(detail.jobs().count(), 240);
        assert!(!detail.truncated);
        let calls = std::fs::read_to_string(s.path("calls")).unwrap();
        let mut jobs: Vec<_> = calls
            .lines()
            .filter(|call| call.contains("/jobs?"))
            .collect();
        jobs.sort_unstable();
        assert_eq!(
            jobs,
            [
                "api -i -H X-GitHub-Api-Version: 2022-11-28 --hostname github.com repos/team/repo/actions/runs/9001/jobs?filter=latest&per_page=100&page=1",
                "api -i -H X-GitHub-Api-Version: 2022-11-28 --hostname github.com repos/team/repo/actions/runs/9001/jobs?filter=latest&per_page=100&page=2",
                "api -i -H X-GitHub-Api-Version: 2022-11-28 --hostname github.com repos/team/repo/actions/runs/9001/jobs?filter=latest&per_page=100&page=3",
            ]
        );
        assert_eq!(
            calls.lines().count(),
            5,
            "run, artifacts and three jobs pages"
        );
    }

    #[tokio::test]
    async fn github_a_run_with_1240_jobs_reads_ten_pages_and_marks_the_rest_truncated() {
        let s = TestSandbox::new("github-runs-1240");
        std::fs::write(
            s.path("run.json"),
            include_str!("../../../tests/fixtures/pull_requests/github_run.json"),
        )
        .unwrap();
        write_jobs(&s, 1_240);
        let detail = host(&s, DETAIL_SCRIPT)
            .detail(
                &scope(&s),
                &test_context(),
                9001,
                None,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(detail.jobs().count(), 1000);
        assert_eq!(detail.total_jobs, Some(1_240));
        assert!(detail.truncated);
        let calls = std::fs::read_to_string(s.path("calls")).unwrap();
        assert_eq!(
            calls.lines().filter(|call| call.contains("/jobs?")).count(),
            10,
            "never past ten pages"
        );
    }

    /// Attempt 1 failed and attempt 2 passed: attempt 1's page reads that
    /// attempt's run and jobs, so it says "Failed".
    #[tokio::test]
    async fn github_an_earlier_attempt_reads_its_own_run_and_jobs() {
        let s = TestSandbox::new("github-runs-attempt");
        let mut run: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/pull_requests/github_run.json"
        ))
        .unwrap();
        std::fs::write(s.path("run.json"), run.to_string()).unwrap();
        run["run_attempt"] = serde_json::json!(1);
        run["conclusion"] = serde_json::json!("failure");
        std::fs::write(s.path("attempt-1.json"), run.to_string()).unwrap();
        write_jobs(&s, 2);
        let script = r#"printf '%s\n' "$7" >> calls
case "$7" in
  */attempts/1/jobs\?*) printf 'HTTP/2 200 OK\r\n\r\n'; cat jobs-1.json ;;
  */attempts/1) printf 'HTTP/2 200 OK\r\n\r\n'; cat attempt-1.json ;;
  */artifacts\?*) printf 'HTTP/2 200 OK\r\n\r\n{"total_count":0,"artifacts":[]}' ;;
  *) printf 'HTTP/2 200 OK\r\n\r\n'; cat run.json ;;
esac"#;
        let detail = host(&s, script)
            .detail(
                &scope(&s),
                &test_context(),
                9001,
                Some(1),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(detail.pipeline.status, PipelineStatus::Failed);
        assert_eq!(detail.pipeline.attempt, Some(1));
        let mut calls: Vec<String> = std::fs::read_to_string(s.path("calls"))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        calls.sort_unstable();
        assert_eq!(
            calls,
            [
                "repos/team/repo/actions/runs/9001/artifacts?per_page=100",
                "repos/team/repo/actions/runs/9001/attempts/1",
                "repos/team/repo/actions/runs/9001/attempts/1/jobs?per_page=100&page=1",
            ]
        );
    }

    #[tokio::test]
    async fn github_a_404_on_the_run_list_names_both_causes() {
        let s = TestSandbox::new("github-runs-404");
        let host = host(
            &s,
            r#"printf 'HTTP/2 404 Not Found\r\n\r\n{"message":"Not Found"}'
echo 'gh: Not Found (HTTP 404)' >&2
exit 1"#,
        );
        let input: ListInput = serde_json::from_value(serde_json::json!({"cwd": s.root(),
            "scope": "all", "ref": null, "workflowId": null, "cursor": null, "refresh": "user"}))
        .unwrap();
        let error = host
            .list(
                &scope(&s),
                &test_context(),
                &input,
                true,
                &CancellationToken::new(),
            )
            .await
            .err()
            .expect("refused");
        assert_eq!(error.code, "not_found");
        assert_eq!(error.message, RUNS_NOT_FOUND_MESSAGE);
    }

    #[tokio::test]
    async fn github_a_403_with_no_requests_remaining_is_rate_limited_until_the_reset() {
        let s = TestSandbox::new("github-runs-403");
        let reset = backoff::now_epoch_seconds() + 600;
        let host = host(
            &s,
            &format!(
                r#"printf 'HTTP/2 403 Forbidden\r\nx-ratelimit-remaining: 0\r\nx-ratelimit-reset: {reset}\r\n\r\n{{"message":"API rate limit exceeded"}}'
echo 'gh: HTTP 403' >&2
exit 1"#
            ),
        );
        let error = host
            .job(&scope(&s), &test_context(), 502, &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code, "rate_limited");
        let seconds = error.retry_after_seconds.unwrap();
        assert!((590..=601).contains(&seconds), "{seconds}");
    }

    /// The list reads its workflows only with the count, and pages by number.
    #[tokio::test]
    async fn github_runs_list_reads_workflows_with_the_count_and_pages_by_number() {
        let s = TestSandbox::new("github-runs-list");
        std::fs::write(
            s.path("runs.json"),
            include_str!("../../../tests/fixtures/pull_requests/github_runs.json"),
        )
        .unwrap();
        let host = host(
            &s,
            r#"printf '%s\n' "$7" >> calls
case "$7" in
  */workflows\?*) printf 'HTTP/2 200 OK\r\n\r\n{"total_count":1,"workflows":[{"id":77,"name":"CI"}]}' ;;
  *) printf 'HTTP/2 200 OK\r\n\r\n'; cat runs.json ;;
esac"#,
        );
        let c = CancellationToken::new();
        let mut input: ListInput = serde_json::from_value(serde_json::json!({"cwd": s.root(),
            "scope": "all", "ref": null, "workflowId": null, "cursor": null, "refresh": "user"}))
        .unwrap();
        let first = host
            .list(&scope(&s), &test_context(), &input, true, &c)
            .await
            .unwrap();
        assert_eq!(
            first.workflows,
            Some(vec![Workflow {
                id: 77,
                name: "CI".into()
            }])
        );
        assert_eq!(first.next_cursor.as_deref(), Some("2"));
        input.cursor = first.next_cursor;
        let second = host
            .list(&scope(&s), &test_context(), &input, false, &c)
            .await
            .unwrap();
        assert_eq!(second.workflows, None);
        let calls = std::fs::read_to_string(s.path("calls")).unwrap();
        let mut calls: Vec<_> = calls.lines().collect();
        calls.sort_unstable();
        assert_eq!(
            calls,
            [
                "repos/team/repo/actions/runs?per_page=20&page=1&exclude_pull_requests=false",
                "repos/team/repo/actions/runs?per_page=20&page=2&exclude_pull_requests=false",
                "repos/team/repo/actions/workflows?per_page=100",
            ]
        );
    }

    /// A completed job's log downloads whole, without `-i`, so the kept tail
    /// is all log text; a 410 is a log past its retention.
    #[tokio::test]
    async fn github_job_logs_download_whole_and_a_410_is_expired() {
        let s = TestSandbox::new("github-runs-log");
        let host = host(
            &s,
            r#"printf '%s\n' "$*" >> calls
case "$*" in
  *jobs/503/logs*) echo 'gh: Gone (HTTP 410)' >&2; exit 1 ;;
  *) printf '2026-10-24T10:00:00.0000000Z ##[group]Run tests\n' ;;
esac"#,
        );
        let c = CancellationToken::new();
        let log = host.trace(&scope(&s), 502, None, None, &c).await.unwrap();
        assert_eq!(
            log.bytes,
            b"2026-10-24T10:00:00.0000000Z ##[group]Run tests\n"
        );
        let calls = std::fs::read_to_string(s.path("calls")).unwrap();
        assert_eq!(
            calls.lines().next(),
            Some(
                "api -H X-GitHub-Api-Version: 2022-11-28 --hostname github.com repos/team/repo/actions/jobs/502/logs"
            )
        );
        let expired = host
            .trace(&scope(&s), 503, None, None, &c)
            .await
            .err()
            .expect("expired");
        assert_eq!(expired.code, "expired");
    }
}
