//! Explicit-only provider check reads through the existing pull-request CLI seam.
//!
//! Checks come from `gh pr view <number> --json statusCheckRollup`, whose contract
//! separates "the pull request exists and has no checks" (exit 0, empty rollup)
//! from every genuine failure (non-zero exit). `gh pr checks` cannot make that
//! distinction: it exits 1 with empty stdout for no checks, a missing pull request,
//! and rejected credentials alike, differing only in localized stderr text. The
//! rollup entries are folded exactly the way `gh pr checks` folds them
//! (`pkg/cmd/pr/checks/aggregate.go`), so the rendered rows match the CLI.

use std::{cmp::Ordering, collections::HashSet, ffi::OsString, path::Path};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::pull_request::ProviderCommandInvocation;
use super::{ProviderKind, PullRequestService, SourceControlProviderError};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCheck {
    pub name: String,
    pub state: String,
    pub link: Option<String>,
    pub workflow: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderChecksResult {
    Available(Vec<ProviderCheck>),
    Unavailable,
}

impl PullRequestService {
    pub async fn read_checks(
        &self,
        provider: ProviderKind,
        cwd: &Path,
        pull_request_number: u64,
        cancellation: &CancellationToken,
    ) -> Result<ProviderChecksResult, SourceControlProviderError> {
        if provider != ProviderKind::Github {
            return Ok(ProviderChecksResult::Unavailable);
        }
        let command = self
            .current_provider_command(provider)
            .expect("GitHub has a configured provider command");
        let output = self
            .run_provider_os_with_allowed_exit_codes(
                ProviderCommandInvocation {
                    provider,
                    cwd,
                    operation: "readPullRequestChecks",
                    command,
                    args: [
                        "pr".to_owned(),
                        "view".to_owned(),
                        pull_request_number.to_string(),
                        "--json".to_owned(),
                        "statusCheckRollup".to_owned(),
                    ]
                    .into_iter()
                    .map(OsString::from)
                    .collect(),
                    allowed_non_zero_exit_codes: &[],
                },
                cancellation,
            )
            .await?;
        let rollup = serde_json::from_str::<RawGitHubPullRequestRollup>(&output.stdout)
            .map_err(|_| checks_error(cwd, "GitHub returned malformed check data."))?;
        let checks = aggregate_github_checks(rollup.status_check_rollup)
            .map_err(|()| checks_error(cwd, "GitHub returned incomplete check data."))?;
        Ok(ProviderChecksResult::Available(checks))
    }
}

#[derive(Deserialize)]
struct RawGitHubPullRequestRollup {
    #[serde(rename = "statusCheckRollup")]
    status_check_rollup: Vec<RawGitHubCheckContext>,
}

/// One `statusCheckRollup` entry. GitHub reports either a `CheckRun` (name,
/// status/conclusion, detailsUrl, workflowName) or a legacy `StatusContext`
/// (context, state, targetUrl); every field is optional on the wire.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawGitHubCheckContext {
    name: Option<String>,
    context: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    state: Option<String>,
    details_url: Option<String>,
    target_url: Option<String>,
    workflow_name: Option<String>,
    started_at: Option<String>,
}

/// Folds rollup entries the way `gh pr checks` does: newest run first, one row per
/// status context or per check-run name within a workflow, state taken from the
/// context state, else the completed conclusion, else the run status. The rollup
/// export carries no workflow-run event, so the check-run key omits it.
fn aggregate_github_checks(
    mut contexts: Vec<RawGitHubCheckContext>,
) -> Result<Vec<ProviderCheck>, ()> {
    contexts.sort_by(|left, right| compare_started_at_desc(&left.started_at, &right.started_at));
    let mut seen_contexts = HashSet::new();
    let mut seen_check_runs = HashSet::new();
    let mut checks = Vec::with_capacity(contexts.len());
    for context in contexts {
        let workflow = context.workflow_name.and_then(non_empty);
        let is_duplicate = match context.context.as_deref().map(str::trim) {
            Some(status_context) if !status_context.is_empty() => {
                !seen_contexts.insert(status_context.to_owned())
            }
            _ => !seen_check_runs.insert((
                context
                    .name
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
                workflow.clone().unwrap_or_default(),
            )),
        };
        if is_duplicate {
            continue;
        }
        let state = match context.state.and_then(non_empty) {
            Some(state) => Some(state),
            None if context.status.as_deref() == Some("COMPLETED") => {
                context.conclusion.and_then(non_empty)
            }
            None => context.status.and_then(non_empty),
        };
        let name = context
            .name
            .and_then(non_empty)
            .or_else(|| context.context.and_then(non_empty));
        let link = context
            .details_url
            .and_then(non_empty)
            .or_else(|| context.target_url.and_then(non_empty));
        checks.push(ProviderCheck {
            name: name.ok_or(())?,
            state: state.ok_or(())?,
            link,
            workflow,
        });
    }
    Ok(checks)
}

/// GitHub reports RFC 3339 UTC timestamps, so the newest run sorts first by
/// comparing the text; a missing timestamp sorts last like Go's zero time.
fn compare_started_at_desc(left: &Option<String>, right: &Option<String>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => right.cmp(left),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn checks_error(cwd: &Path, detail: &str) -> SourceControlProviderError {
    SourceControlProviderError {
        tag: "SourceControlProviderError",
        provider: ProviderKind::Github,
        operation: "readPullRequestChecks".into(),
        cwd: cwd.to_string_lossy().into_owned().into(),
        command: None,
        reference: None,
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::test_support::TestSandbox;

    const ROLLUP_COMMAND: &str = "pr view 42 --json statusCheckRollup";

    #[cfg(unix)]
    fn github_service(sandbox: &TestSandbox, script: &str) -> PullRequestService {
        let command = sandbox.executable_script("gh", script, "");
        PullRequestService::with_provider_commands(
            command.to_string_lossy(),
            "unused-glab",
            "unused-az",
        )
    }

    /// A `gh` stub that rejects any argv other than the exact rollup read and
    /// prints `stdout` for it.
    #[cfg(unix)]
    fn exact_rollup_script(stdout: &str) -> String {
        format!("test \"$*\" = \"{ROLLUP_COMMAND}\" || exit 64\nprintf '%s\\n' '{stdout}'")
    }

    #[cfg(unix)]
    async fn read_github_checks(
        sandbox: &TestSandbox,
        script: &str,
    ) -> Result<ProviderChecksResult, SourceControlProviderError> {
        github_service(sandbox, script)
            .read_checks(
                ProviderKind::Github,
                sandbox.root(),
                42,
                &CancellationToken::new(),
            )
            .await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn github_checks_use_the_exact_non_watching_rollup_command_and_parse_results() {
        let sandbox = TestSandbox::new("github-checks");
        let result = read_github_checks(
            &sandbox,
            &exact_rollup_script(
                r#"{"statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-09-02T13:09:09Z","conclusion":"SUCCESS","detailsUrl":"https://github.test/check/1","name":"build","startedAt":"2026-09-02T12:52:36Z","status":"COMPLETED","workflowName":"CI"}]}"#,
            ),
        )
        .await
        .expect("GitHub checks");

        assert_eq!(
            result,
            ProviderChecksResult::Available(vec![ProviderCheck {
                name: "build".to_owned(),
                state: "SUCCESS".to_owned(),
                link: Some("https://github.test/check/1".to_owned()),
                workflow: Some("CI".to_owned()),
            }])
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_pull_request_with_no_checks_is_available_with_an_empty_collection() {
        let sandbox = TestSandbox::new("github-no-checks");
        let result = read_github_checks(
            &sandbox,
            &exact_rollup_script(r#"{"statusCheckRollup":[]}"#),
        )
        .await
        .expect("a valid pull request without checks is not a provider failure");

        assert_eq!(result, ProviderChecksResult::Available(Vec::new()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pending_check_runs_and_status_contexts_keep_their_pending_states() {
        let sandbox = TestSandbox::new("github-pending-checks");
        let result = read_github_checks(
            &sandbox,
            &exact_rollup_script(
                r#"{"statusCheckRollup":[{"__typename":"CheckRun","conclusion":null,"detailsUrl":"https://github.test/check/2","name":"build","startedAt":"2026-09-02T12:52:36Z","status":"IN_PROGRESS","workflowName":"CI"},{"__typename":"CheckRun","conclusion":null,"detailsUrl":null,"name":"lint","startedAt":null,"status":"QUEUED","workflowName":"CI"},{"__typename":"StatusContext","context":"ci/circleci","state":"PENDING","startedAt":"2026-09-02T12:52:30Z","targetUrl":"https://circleci.test/1"}]}"#,
            ),
        )
        .await
        .expect("pending GitHub checks remain readable");

        assert_eq!(
            result,
            ProviderChecksResult::Available(vec![
                ProviderCheck {
                    name: "build".to_owned(),
                    state: "IN_PROGRESS".to_owned(),
                    link: Some("https://github.test/check/2".to_owned()),
                    workflow: Some("CI".to_owned()),
                },
                ProviderCheck {
                    name: "ci/circleci".to_owned(),
                    state: "PENDING".to_owned(),
                    link: Some("https://circleci.test/1".to_owned()),
                    workflow: None,
                },
                ProviderCheck {
                    name: "lint".to_owned(),
                    state: "QUEUED".to_owned(),
                    link: None,
                    workflow: Some("CI".to_owned()),
                },
            ])
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn repeated_runs_collapse_to_the_newest_per_check_and_status_context() {
        let sandbox = TestSandbox::new("github-duplicate-checks");
        let result = read_github_checks(
            &sandbox,
            &exact_rollup_script(
                r#"{"statusCheckRollup":[{"__typename":"CheckRun","conclusion":"FAILURE","detailsUrl":"https://github.test/check/old","name":"build","startedAt":"2026-09-01T10:00:00Z","status":"COMPLETED","workflowName":"CI"},{"__typename":"CheckRun","conclusion":"SUCCESS","detailsUrl":"https://github.test/check/new","name":"build","startedAt":"2026-09-02T10:00:00Z","status":"COMPLETED","workflowName":"CI"},{"__typename":"CheckRun","conclusion":"SUCCESS","detailsUrl":"https://github.test/check/other","name":"build","startedAt":"2026-09-02T09:00:00Z","status":"COMPLETED","workflowName":"Release"},{"__typename":"StatusContext","context":"ci/circleci","state":"FAILURE","startedAt":"2026-09-01T10:00:00Z","targetUrl":"https://circleci.test/old"},{"__typename":"StatusContext","context":"ci/circleci","state":"SUCCESS","startedAt":"2026-09-02T10:00:00Z","targetUrl":"https://circleci.test/new"}]}"#,
            ),
        )
        .await
        .expect("duplicate GitHub runs fold");

        assert_eq!(
            result,
            ProviderChecksResult::Available(vec![
                ProviderCheck {
                    name: "build".to_owned(),
                    state: "SUCCESS".to_owned(),
                    link: Some("https://github.test/check/new".to_owned()),
                    workflow: Some("CI".to_owned()),
                },
                ProviderCheck {
                    name: "ci/circleci".to_owned(),
                    state: "SUCCESS".to_owned(),
                    link: Some("https://circleci.test/new".to_owned()),
                    workflow: None,
                },
                ProviderCheck {
                    name: "build".to_owned(),
                    state: "SUCCESS".to_owned(),
                    link: Some("https://github.test/check/other".to_owned()),
                    workflow: Some("Release".to_owned()),
                },
            ])
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failing_provider_command_remains_a_provider_error() {
        let sandbox = TestSandbox::new("github-checks-failure");
        let error = read_github_checks(
            &sandbox,
            "printf '%s\\n' 'HTTP 401: Bad credentials (https://api.github.com/graphql)' >&2\nexit 1",
        )
        .await
        .expect_err("a non-zero provider exit is not an empty check collection");

        assert_eq!(error.operation.as_ref(), "readPullRequestChecks");
        assert_eq!(error.provider, ProviderKind::Github);
        assert!(error.command.is_some(), "the failing command is named");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn malformed_or_incomplete_rollup_payloads_are_provider_errors() {
        for (name, stdout, detail) in [
            (
                "legacy-array",
                r#"[{"name":"build","state":"SUCCESS"}]"#,
                "GitHub returned malformed check data.",
            ),
            (
                "missing-rollup",
                r#"{"number":42}"#,
                "GitHub returned malformed check data.",
            ),
            (
                "nameless-entry",
                r#"{"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}"#,
                "GitHub returned incomplete check data.",
            ),
            (
                "stateless-entry",
                r#"{"statusCheckRollup":[{"__typename":"CheckRun","name":"build","status":"","conclusion":null}]}"#,
                "GitHub returned incomplete check data.",
            ),
        ] {
            let sandbox = TestSandbox::new(&format!("github-checks-{name}"));
            let error = read_github_checks(&sandbox, &exact_rollup_script(stdout))
                .await
                .expect_err(name);
            assert_eq!(error.detail.as_ref(), detail, "{name}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn constructing_the_service_and_advancing_time_spawns_no_provider_process() {
        let sandbox = TestSandbox::new("checks-no-background");
        let marker = sandbox.root().join("spawned");
        let marker_text = marker.to_string_lossy();
        let command = sandbox.executable_script(
            "gh",
            &format!("printf spawned > '{marker_text}'"),
            &format!("@echo spawned>\"{marker_text}\"\r\n"),
        );

        let _service = PullRequestService::with_provider_commands(
            command.to_string_lossy(),
            "unused-glab",
            "unused-az",
        );
        tokio::time::advance(Duration::from_secs(3_600)).await;

        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn non_github_providers_report_checks_as_unavailable_without_spawning() {
        let sandbox = TestSandbox::new("checks-unavailable");
        let missing = sandbox
            .root()
            .join("must-not-run")
            .to_string_lossy()
            .into_owned();
        let service =
            PullRequestService::with_provider_commands(missing.clone(), missing.clone(), missing);
        for provider in [
            ProviderKind::Gitlab,
            ProviderKind::AzureDevops,
            ProviderKind::Bitbucket,
            ProviderKind::Unknown,
        ] {
            assert_eq!(
                service
                    .read_checks(provider, sandbox.root(), 42, &CancellationToken::new())
                    .await
                    .expect("unsupported check read"),
                ProviderChecksResult::Unavailable
            );
        }
    }
}
