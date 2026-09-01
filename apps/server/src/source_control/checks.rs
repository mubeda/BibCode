//! Explicit-only provider check reads through the existing pull-request CLI seam.

use std::{ffi::OsString, path::Path};

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
                        "checks".to_owned(),
                        pull_request_number.to_string(),
                        "--json".to_owned(),
                        "name,state,link,workflow".to_owned(),
                    ]
                    .into_iter()
                    .map(OsString::from)
                    .collect(),
                    allowed_non_zero_exit_codes: &[8],
                },
                cancellation,
            )
            .await?;
        let checks = serde_json::from_str::<Vec<RawGitHubCheck>>(&output.stdout)
            .map_err(|_| checks_error(cwd, "GitHub returned malformed check data."))?
            .into_iter()
            .map(ProviderCheck::try_from)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| checks_error(cwd, "GitHub returned incomplete check data."))?;
        Ok(ProviderChecksResult::Available(checks))
    }
}

#[derive(Deserialize)]
struct RawGitHubCheck {
    name: String,
    state: String,
    #[serde(default)]
    link: Option<String>,
    #[serde(default)]
    workflow: Option<String>,
}

impl TryFrom<RawGitHubCheck> for ProviderCheck {
    type Error = ();

    fn try_from(value: RawGitHubCheck) -> Result<Self, Self::Error> {
        let name = non_empty(value.name).ok_or(())?;
        let state = non_empty(value.state).ok_or(())?;
        Ok(Self {
            name,
            state,
            link: value.link.and_then(non_empty),
            workflow: value.workflow.and_then(non_empty),
        })
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

    #[cfg(unix)]
    #[tokio::test]
    async fn github_checks_use_the_exact_non_watching_json_command_and_parse_results() {
        let sandbox = TestSandbox::new("github-checks");
        let command = sandbox.executable_script(
            "gh",
            concat!(
                "test \"$*\" = \"pr checks 42 --json name,state,link,workflow\" || exit 64\n",
                "printf '%s\\n' '[{\"name\":\"build\",\"state\":\"SUCCESS\",\"link\":\"https://github.test/check/1\",\"workflow\":\"CI\"}]'",
            ),
            "",
        );
        let service = PullRequestService::with_provider_commands(
            command.to_string_lossy(),
            "unused-glab",
            "unused-az",
        );

        let result = service
            .read_checks(
                ProviderKind::Github,
                sandbox.root(),
                42,
                &CancellationToken::new(),
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
    async fn github_pending_exit_code_keeps_the_check_payload_available() {
        let sandbox = TestSandbox::new("github-pending-checks");
        let command = sandbox.executable_script(
            "gh",
            "printf '%s\\n' '[{\"name\":\"build\",\"state\":\"IN_PROGRESS\",\"link\":null,\"workflow\":\"CI\"}]'\nexit 8",
            "",
        );
        let service = PullRequestService::with_provider_commands(
            command.to_string_lossy(),
            "unused-glab",
            "unused-az",
        );

        let result = service
            .read_checks(
                ProviderKind::Github,
                sandbox.root(),
                42,
                &CancellationToken::new(),
            )
            .await
            .expect("pending GitHub checks remain readable");

        assert!(matches!(
            result,
            ProviderChecksResult::Available(checks)
                if checks.len() == 1 && checks[0].state == "IN_PROGRESS"
        ));
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
