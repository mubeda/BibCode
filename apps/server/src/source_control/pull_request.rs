use std::{ffi::OsString, path::PathBuf, time::Duration};

use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder, Response};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio_util::sync::CancellationToken;

use crate::git::{OutputPolicy, ProcessRequest, ProcessRunner};

use super::ProviderKind;

const BITBUCKET_MAX_PAGES: usize = 100;
const BITBUCKET_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const BITBUCKET_RESPONSE_LIMIT: usize = 1024 * 1024;
const NO_OPEN_BITBUCKET_PULL_REQUEST: &str =
    "No open Bitbucket pull request was found for the current branch.";

#[derive(Clone, Debug)]
pub(crate) struct ProviderCommandSpec {
    executable: PathBuf,
    prefix_args: Vec<OsString>,
}

impl ProviderCommandSpec {
    pub(crate) fn new(
        executable: impl Into<PathBuf>,
        prefix_args: impl IntoIterator<Item = OsString>,
    ) -> Self {
        Self {
            executable: executable.into(),
            prefix_args: prefix_args.into_iter().collect(),
        }
    }

    fn plain(executable: impl Into<PathBuf>) -> Self {
        Self::new(executable, [])
    }

    fn label(&self) -> &str {
        self.executable.to_str().unwrap_or("provider")
    }

    fn args(&self, args: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
        self.prefix_args.iter().cloned().chain(args).collect()
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum BitbucketResolutionMode {
    CurrentBranch,
    ExplicitReference,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeRequestState {
    Open,
    Closed,
    Merged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub base_branch: String,
    pub head_branch: String,
    pub state: ChangeRequestState,
}

#[derive(Clone, Debug)]
pub struct ResolvePullRequestInput {
    pub cwd: PathBuf,
    pub provider: ProviderKind,
    pub reference: String,
}

#[derive(Clone, Debug)]
pub struct CreatePullRequestInput {
    pub cwd: PathBuf,
    pub provider: ProviderKind,
    pub base_branch: String,
    pub head_branch: String,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlProviderError {
    #[serde(rename = "_tag")]
    pub tag: &'static str,
    pub provider: ProviderKind,
    pub operation: Box<str>,
    pub cwd: Box<str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<Box<str>>,
    pub detail: Box<str>,
}

impl std::fmt::Display for SourceControlProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Source control provider {:?} failed in {}: {}",
            self.provider, self.operation, self.detail
        )
    }
}

impl std::error::Error for SourceControlProviderError {}

#[derive(Clone, Debug)]
pub struct PullRequestService {
    runner: ProcessRunner,
    client: Client,
    bitbucket: BitbucketConfiguration,
    git_command: PathBuf,
    git_environment: Vec<(OsString, OsString)>,
    github_command: ProviderCommandSpec,
    gitlab_command: ProviderCommandSpec,
    azure_command: ProviderCommandSpec,
}

impl Default for PullRequestService {
    fn default() -> Self {
        Self {
            runner: ProcessRunner,
            client: Client::new(),
            bitbucket: BitbucketConfiguration::default(),
            git_command: PathBuf::from("git"),
            git_environment: Vec::new(),
            github_command: ProviderCommandSpec::plain("gh"),
            gitlab_command: ProviderCommandSpec::plain("glab"),
            azure_command: ProviderCommandSpec::plain("az"),
        }
    }
}

impl PullRequestService {
    #[must_use]
    pub fn with_provider_commands(
        github_command: impl Into<String>,
        gitlab_command: impl Into<String>,
        azure_command: impl Into<String>,
    ) -> Self {
        let github_command = github_command.into();
        let gitlab_command = gitlab_command.into();
        let azure_command = azure_command.into();
        Self {
            github_command: ProviderCommandSpec::plain(github_command),
            gitlab_command: ProviderCommandSpec::plain(gitlab_command),
            azure_command: ProviderCommandSpec::plain(azure_command),
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub(crate) fn with_provider_command_specs_for_test(
        github_command: ProviderCommandSpec,
        gitlab_command: ProviderCommandSpec,
        azure_command: ProviderCommandSpec,
    ) -> Self {
        Self {
            github_command,
            gitlab_command,
            azure_command,
            ..Self::default()
        }
    }

    #[cfg(test)]
    fn with_git_command_for_test(
        mut self,
        git_command: PathBuf,
        git_environment: Vec<(OsString, OsString)>,
    ) -> Self {
        self.git_command = git_command;
        self.git_environment = git_environment;
        self
    }

    #[cfg(test)]
    fn with_bitbucket_limits_for_test(mut self, timeout: Duration, response_limit: usize) -> Self {
        self.bitbucket.request_timeout = timeout;
        self.bitbucket.response_limit = response_limit;
        self
    }

    pub async fn resolve_current(
        &self,
        input: ResolvePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        let provider = input.provider;
        let cwd = input.cwd.clone();
        let reference = input.reference.clone();
        self.resolve_current_optional(input, cancellation)
            .await?
            .ok_or_else(|| {
                operation_error(
                    provider,
                    &cwd,
                    "resolveCurrentPullRequest",
                    self.current_provider_command(provider)
                        .map(ProviderCommandSpec::label),
                    Some(&reference),
                    "No open pull request was found for the current branch.",
                )
            })
    }

    pub async fn resolve_current_optional(
        &self,
        input: ResolvePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<Option<ResolvedPullRequest>, SourceControlProviderError> {
        if input.provider == ProviderKind::Bitbucket {
            return self
                .resolve_bitbucket_current_optional(&input, cancellation)
                .await;
        }
        let (command, args) = match input.provider {
            ProviderKind::Github => (
                &self.github_command,
                [
                    "pr",
                    "list",
                    "--head",
                    input.reference.as_str(),
                    "--state",
                    "open",
                    "--limit",
                    "1",
                    "--json",
                    "number,title,url,baseRefName,headRefName,state",
                ]
                .into_iter()
                .map(OsString::from)
                .collect(),
            ),
            ProviderKind::Gitlab => (
                &self.gitlab_command,
                [
                    "mr",
                    "list",
                    "--source-branch",
                    input.reference.as_str(),
                    "--state",
                    "opened",
                    "--output",
                    "json",
                ]
                .into_iter()
                .map(OsString::from)
                .collect(),
            ),
            ProviderKind::AzureDevops => {
                let source_branch = format!("refs/heads/{}", input.reference);
                (
                    &self.azure_command,
                    [
                        "repos",
                        "pr",
                        "list",
                        "--only-show-errors",
                        "--detect",
                        "true",
                        "--source-branch",
                        source_branch.as_str(),
                        "--status",
                        "active",
                        "--top",
                        "1",
                        "--output",
                        "json",
                    ]
                    .into_iter()
                    .map(OsString::from)
                    .collect(),
                )
            }
            ProviderKind::Unknown => return Ok(None),
            ProviderKind::Bitbucket => unreachable!(),
        };
        let output = self
            .run_provider_os(
                input.provider,
                &input.cwd,
                "resolveCurrentPullRequest",
                command,
                args,
                cancellation,
            )
            .await?;
        parse_current_provider_list(input.provider, &output.stdout).map_err(|detail| {
            operation_error(
                input.provider,
                &input.cwd,
                "resolveCurrentPullRequest",
                Some(command.label()),
                Some(&input.reference),
                &detail,
            )
        })
    }

    fn current_provider_command(&self, provider: ProviderKind) -> Option<&ProviderCommandSpec> {
        match provider {
            ProviderKind::Github => Some(&self.github_command),
            ProviderKind::Gitlab => Some(&self.gitlab_command),
            ProviderKind::AzureDevops => Some(&self.azure_command),
            ProviderKind::Bitbucket | ProviderKind::Unknown => None,
        }
    }

    async fn resolve_bitbucket_current_optional(
        &self,
        input: &ResolvePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<Option<ResolvedPullRequest>, SourceControlProviderError> {
        match self
            .resolve_bitbucket(input, BitbucketResolutionMode::CurrentBranch, cancellation)
            .await
        {
            Ok(pull_request) => Ok(Some(pull_request)),
            Err(error) if error.detail.as_ref() == NO_OPEN_BITBUCKET_PULL_REQUEST => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn create(
        &self,
        input: CreatePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        if input.provider == ProviderKind::Bitbucket {
            return self.create_bitbucket(&input, cancellation).await;
        }
        let (command, args): (&ProviderCommandSpec, Vec<OsString>) = match input.provider {
            ProviderKind::Github => (
                &self.github_command,
                [
                    "pr",
                    "create",
                    "--base",
                    input.base_branch.as_str(),
                    "--head",
                    input.head_branch.as_str(),
                    "--title",
                    input.title.as_str(),
                    "--body",
                    input.body.as_str(),
                ]
                .into_iter()
                .map(OsString::from)
                .collect(),
            ),
            ProviderKind::Gitlab => (
                &self.gitlab_command,
                vec![
                    "api".into(),
                    "--method".into(),
                    "POST".into(),
                    "projects/:fullpath/merge_requests".into(),
                    "--raw-field".into(),
                    format!("source_branch={}", input.head_branch).into(),
                    "--raw-field".into(),
                    format!("target_branch={}", input.base_branch).into(),
                    "--raw-field".into(),
                    format!("title={}", input.title).into(),
                    "--raw-field".into(),
                    format!("description={}", input.body).into(),
                ],
            ),
            ProviderKind::AzureDevops => (
                &self.azure_command,
                [
                    "repos",
                    "pr",
                    "create",
                    "--only-show-errors",
                    "--detect",
                    "true",
                    "--target-branch",
                    input.base_branch.as_str(),
                    "--source-branch",
                    input.head_branch.as_str(),
                    "--title",
                    input.title.as_str(),
                    "--description",
                    input.body.as_str(),
                    "--output",
                    "json",
                ]
                .into_iter()
                .map(OsString::from)
                .collect(),
            ),
            ProviderKind::Bitbucket | ProviderKind::Unknown => {
                return Err(operation_error(
                    input.provider,
                    &input.cwd,
                    "createPullRequest",
                    None,
                    Some(&input.head_branch),
                    "Pull-request creation is unavailable for this provider.",
                ));
            }
        };
        let output = self
            .run_provider_os(
                input.provider,
                &input.cwd,
                "createPullRequest",
                command,
                args,
                cancellation,
            )
            .await?;
        let parsed = match input.provider {
            ProviderKind::Github => parse_github_create_output(&output.stdout, &input),
            ProviderKind::Gitlab => parse_gitlab_merge_request(&output.stdout),
            ProviderKind::AzureDevops => parse_azure_pull_request(&output.stdout),
            ProviderKind::Bitbucket | ProviderKind::Unknown => None,
        };
        parsed.ok_or_else(|| {
            operation_error(
                input.provider,
                &input.cwd,
                "createPullRequest",
                Some(command.label()),
                Some(&input.head_branch),
                "Provider CLI returned an unrecognized pull-request payload.",
            )
        })
    }

    pub async fn resolve(
        &self,
        input: ResolvePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        if input.provider == ProviderKind::Bitbucket {
            return self
                .resolve_bitbucket(
                    &input,
                    BitbucketResolutionMode::ExplicitReference,
                    cancellation,
                )
                .await;
        }
        let (command, args): (&ProviderCommandSpec, Vec<OsString>) = match input.provider {
            ProviderKind::Github => (
                &self.github_command,
                [
                    "pr",
                    "view",
                    input.reference.as_str(),
                    "--json",
                    "number,title,url,baseRefName,headRefName,state",
                ]
                .into_iter()
                .map(OsString::from)
                .collect(),
            ),
            ProviderKind::Gitlab => (
                &self.gitlab_command,
                ["mr", "view", input.reference.as_str(), "--output", "json"]
                    .into_iter()
                    .map(OsString::from)
                    .collect(),
            ),
            ProviderKind::AzureDevops => (
                &self.azure_command,
                [
                    "repos",
                    "pr",
                    "show",
                    "--id",
                    input.reference.as_str(),
                    "--output",
                    "json",
                ]
                .into_iter()
                .map(OsString::from)
                .collect(),
            ),
            ProviderKind::Bitbucket | ProviderKind::Unknown => {
                return Err(provider_error(
                    input.provider,
                    &input.cwd,
                    None,
                    &input.reference,
                    "Pull-request resolution is unavailable for this provider.",
                ));
            }
        };
        let output = self
            .runner
            .run(
                ProcessRequest {
                    operation: "source-control.resolve-change-request".into(),
                    command: command.executable.clone(),
                    args: command.args(args),
                    cwd: input.cwd.clone(),
                    env: vec![],
                    stdin: None,
                    timeout: Duration::from_secs(30),
                    max_output_bytes: 128_000,
                    output_policy: OutputPolicy::Error,
                    append_truncation_marker: false,
                    allow_non_zero_exit: true,
                },
                cancellation,
            )
            .await
            .map_err(|_| {
                provider_error(
                    input.provider,
                    &input.cwd,
                    Some(command.label()),
                    &input.reference,
                    "Provider CLI execution failed.",
                )
            })?;
        if output.exit_code != 0 {
            return Err(provider_error(
                input.provider,
                &input.cwd,
                Some(command.label()),
                &input.reference,
                "Change request was not found or provider authentication failed.",
            ));
        }
        let parsed = match input.provider {
            ProviderKind::Github => parse_github_pull_request(&output.stdout),
            ProviderKind::Gitlab => parse_gitlab_merge_request(&output.stdout),
            ProviderKind::AzureDevops => parse_azure_pull_request(&output.stdout),
            ProviderKind::Bitbucket | ProviderKind::Unknown => None,
        };
        parsed.ok_or_else(|| {
            provider_error(
                input.provider,
                &input.cwd,
                Some(command.label()),
                &input.reference,
                "Provider CLI returned an unrecognized change-request payload.",
            )
        })
    }

    async fn resolve_bitbucket(
        &self,
        input: &ResolvePullRequestInput,
        mode: BitbucketResolutionMode,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        let locator = self.bitbucket_locator(&input.cwd, cancellation).await?;
        let base = &self.bitbucket.api_base_url;
        let repository_url = format!(
            "{base}/repositories/{}/{}",
            locator.workspace, locator.repository
        );
        if mode == BitbucketResolutionMode::ExplicitReference
            && let Some(number) = normalize_pull_request_number(&input.reference)
        {
            let pull_request: BitbucketPullRequest = self
                .send_bitbucket(
                    self.client
                        .get(format!("{repository_url}/pullrequests/{number}")),
                    &input.cwd,
                    "resolvePullRequest",
                    Some(&input.reference),
                    cancellation,
                )
                .await?;
            return normalize_bitbucket_pull_request(pull_request).ok_or_else(|| {
                operation_error(
                    ProviderKind::Bitbucket,
                    &input.cwd,
                    "resolvePullRequest",
                    None,
                    Some(&input.reference),
                    "Bitbucket returned an incomplete pull-request payload.",
                )
            });
        }
        let api_base_url = reqwest::Url::parse(base).map_err(|error| {
            operation_error(
                ProviderKind::Bitbucket,
                &input.cwd,
                "resolveCurrentPullRequest",
                None,
                Some(&input.reference),
                &error.to_string(),
            )
        })?;
        let escaped = input.reference.replace('"', "\\\"");
        let query = format!("source.branch.name = \"{escaped}\" AND state = \"OPEN\"");
        let mut list_url =
            reqwest::Url::parse(&format!("{repository_url}/pullrequests")).map_err(|error| {
                operation_error(
                    ProviderKind::Bitbucket,
                    &input.cwd,
                    "resolveCurrentPullRequest",
                    None,
                    Some(&input.reference),
                    &error.to_string(),
                )
            })?;
        list_url
            .query_pairs_mut()
            .append_pair("q", &query)
            .append_pair("pagelen", "1");
        let mut next_url = Some(list_url);
        for _ in 0..BITBUCKET_MAX_PAGES {
            let Some(page_url) = next_url.take() else {
                break;
            };
            let list: BitbucketPullRequestList = self
                .send_bitbucket(
                    self.client.get(page_url),
                    &input.cwd,
                    "resolveCurrentPullRequest",
                    Some(&input.reference),
                    cancellation,
                )
                .await?;
            if let Some(pull_request) = list
                .values
                .into_iter()
                .find_map(normalize_bitbucket_pull_request)
            {
                return Ok(pull_request);
            }
            next_url = list
                .next
                .map(|url| {
                    let next_url = reqwest::Url::parse(&url).map_err(|error| {
                        operation_error(
                            ProviderKind::Bitbucket,
                            &input.cwd,
                            "resolveCurrentPullRequest",
                            None,
                            Some(&input.reference),
                            &format!("Bitbucket returned an invalid pagination URL: {error}"),
                        )
                    })?;
                    if !urls_have_same_origin(&api_base_url, &next_url) {
                        return Err(operation_error(
                            ProviderKind::Bitbucket,
                            &input.cwd,
                            "resolveCurrentPullRequest",
                            None,
                            Some(&input.reference),
                            "Bitbucket pagination URL must use the configured API origin.",
                        ));
                    }
                    Ok(next_url)
                })
                .transpose()?;
        }
        let detail = if next_url.is_some() {
            "Bitbucket pull-request pagination exceeded the safety limit."
        } else {
            NO_OPEN_BITBUCKET_PULL_REQUEST
        };
        Err(operation_error(
            ProviderKind::Bitbucket,
            &input.cwd,
            "resolveCurrentPullRequest",
            None,
            Some(&input.reference),
            detail,
        ))
    }

    async fn create_bitbucket(
        &self,
        input: &CreatePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        let locator = self.bitbucket_locator(&input.cwd, cancellation).await?;
        let base = &self.bitbucket.api_base_url;
        let pull_request: BitbucketPullRequest = self
            .send_bitbucket(
                self.client
                    .post(format!(
                        "{base}/repositories/{}/{}/pullrequests",
                        locator.workspace, locator.repository
                    ))
                    .json(&serde_json::json!({
                        "title": input.title,
                        "description": input.body,
                        "source": { "branch": { "name": input.head_branch } },
                        "destination": { "branch": { "name": input.base_branch } },
                    })),
                &input.cwd,
                "createPullRequest",
                Some(&input.head_branch),
                cancellation,
            )
            .await?;
        normalize_bitbucket_pull_request(pull_request).ok_or_else(|| {
            operation_error(
                ProviderKind::Bitbucket,
                &input.cwd,
                "createPullRequest",
                None,
                Some(&input.head_branch),
                "Bitbucket returned an incomplete pull-request payload.",
            )
        })
    }

    async fn bitbucket_locator(
        &self,
        cwd: &std::path::Path,
        cancellation: &CancellationToken,
    ) -> Result<BitbucketRepositoryLocator, SourceControlProviderError> {
        let output = self
            .runner
            .run(
                ProcessRequest {
                    operation: "source-control.bitbucketRemote".into(),
                    command: self.git_command.clone(),
                    args: ["remote", "get-url", "origin"]
                        .into_iter()
                        .map(OsString::from)
                        .collect(),
                    cwd: cwd.to_path_buf(),
                    env: self.git_environment.clone(),
                    stdin: None,
                    timeout: Duration::from_secs(10),
                    max_output_bytes: 16_000,
                    output_policy: OutputPolicy::Error,
                    append_truncation_marker: false,
                    allow_non_zero_exit: false,
                },
                cancellation,
            )
            .await
            .map_err(|error| {
                operation_error(
                    ProviderKind::Bitbucket,
                    cwd,
                    "resolveRepository",
                    Some(self.git_command.to_string_lossy().as_ref()),
                    None,
                    &error.to_string(),
                )
            })?;
        parse_bitbucket_repository(&output.stdout).ok_or_else(|| {
            operation_error(
                ProviderKind::Bitbucket,
                cwd,
                "resolveRepository",
                Some(self.git_command.to_string_lossy().as_ref()),
                None,
                "The origin remote is not a recognizable Bitbucket repository URL.",
            )
        })
    }

    async fn send_bitbucket<T: DeserializeOwned>(
        &self,
        request: RequestBuilder,
        cwd: &std::path::Path,
        operation: &str,
        reference: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<T, SourceControlProviderError> {
        let deadline = tokio::time::Instant::now() + self.bitbucket.request_timeout;
        let request = self
            .bitbucket
            .credentials
            .clone()
            .map(|credentials| credentials.apply(request))
            .ok_or_else(|| {
                operation_error(
                    ProviderKind::Bitbucket,
                    cwd,
                    operation,
                    None,
                    reference,
                    "Set BIBCODE_BITBUCKET_EMAIL and BIBCODE_BITBUCKET_API_TOKEN, or BIBCODE_BITBUCKET_ACCESS_TOKEN.",
                )
            })?;
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                return Err(operation_error(
                    ProviderKind::Bitbucket,
                    cwd,
                    operation,
                    None,
                    reference,
                    "Bitbucket request was cancelled.",
                ));
            }
            response = tokio::time::timeout_at(deadline, request.send()) => {
                match response {
                    Ok(response) => response.map_err(|error| {
                        operation_error(
                            ProviderKind::Bitbucket,
                            cwd,
                            operation,
                            None,
                            reference,
                            &error.to_string(),
                        )
                    })?,
                    Err(_) => return Err(bitbucket_deadline_error(
                        cwd,
                        operation,
                        reference,
                        self.bitbucket.request_timeout,
                    )),
                }
            },
        };
        self.decode_bitbucket_response_at(
            response,
            cwd,
            operation,
            reference,
            cancellation,
            deadline,
        )
        .await
    }

    #[cfg(test)]
    async fn decode_bitbucket_response<T: DeserializeOwned>(
        &self,
        response: Response,
        cwd: &std::path::Path,
        operation: &str,
        reference: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<T, SourceControlProviderError> {
        let deadline = tokio::time::Instant::now() + self.bitbucket.request_timeout;
        self.decode_bitbucket_response_at(
            response,
            cwd,
            operation,
            reference,
            cancellation,
            deadline,
        )
        .await
    }

    async fn decode_bitbucket_response_at<T: DeserializeOwned>(
        &self,
        response: Response,
        cwd: &std::path::Path,
        operation: &str,
        reference: Option<&str>,
        cancellation: &CancellationToken,
        deadline: tokio::time::Instant,
    ) -> Result<T, SourceControlProviderError> {
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|length| length > self.bitbucket.response_limit as u64)
        {
            return Err(bitbucket_response_limit_error(
                cwd,
                operation,
                reference,
                self.bitbucket.response_limit,
            ));
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    return Err(operation_error(
                        ProviderKind::Bitbucket,
                        cwd,
                        operation,
                        None,
                        reference,
                        "Bitbucket request was cancelled.",
                    ));
                }
                chunk = tokio::time::timeout_at(deadline, stream.next()) => {
                    match chunk {
                        Ok(chunk) => chunk,
                        Err(_) => return Err(bitbucket_deadline_error(
                            cwd,
                            operation,
                            reference,
                            self.bitbucket.request_timeout,
                        )),
                    }
                }
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|error| {
                operation_error(
                    ProviderKind::Bitbucket,
                    cwd,
                    operation,
                    None,
                    reference,
                    &error.to_string(),
                )
            })?;
            let Some(length) = body.len().checked_add(chunk.len()) else {
                return Err(bitbucket_response_limit_error(
                    cwd,
                    operation,
                    reference,
                    self.bitbucket.response_limit,
                ));
            };
            if length > self.bitbucket.response_limit {
                return Err(bitbucket_response_limit_error(
                    cwd,
                    operation,
                    reference,
                    self.bitbucket.response_limit,
                ));
            }
            body.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            return Err(operation_error(
                ProviderKind::Bitbucket,
                cwd,
                operation,
                None,
                reference,
                &format!(
                    "Bitbucket returned HTTP {status}: {}",
                    truncate_detail(&String::from_utf8_lossy(&body))
                ),
            ));
        }
        serde_json::from_slice(&body).map_err(|error| {
            operation_error(
                ProviderKind::Bitbucket,
                cwd,
                operation,
                None,
                reference,
                &format!("Bitbucket returned invalid JSON: {error}"),
            )
        })
    }

    async fn run_provider_os(
        &self,
        provider: ProviderKind,
        cwd: &std::path::Path,
        operation: &str,
        command: &ProviderCommandSpec,
        args: Vec<OsString>,
        cancellation: &CancellationToken,
    ) -> Result<crate::git::ProcessOutput, SourceControlProviderError> {
        self.runner
            .run(
                ProcessRequest {
                    operation: format!("source-control.{operation}"),
                    command: command.executable.clone(),
                    args: command.args(args),
                    cwd: cwd.to_path_buf(),
                    env: vec![],
                    stdin: None,
                    timeout: Duration::from_secs(60),
                    max_output_bytes: 128_000,
                    output_policy: OutputPolicy::Error,
                    append_truncation_marker: false,
                    allow_non_zero_exit: false,
                },
                cancellation,
            )
            .await
            .map_err(|error| {
                operation_error(
                    provider,
                    cwd,
                    operation,
                    Some(command.label()),
                    None,
                    &error.to_string(),
                )
            })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubPullRequest {
    number: u64,
    title: String,
    url: String,
    base_ref_name: String,
    head_ref_name: String,
    state: String,
}

#[must_use]
pub fn parse_github_pull_request(text: &str) -> Option<ResolvedPullRequest> {
    let value = serde_json::from_str::<GitHubPullRequest>(text).ok()?;
    normalize_github_pull_request(value)
}

fn normalize_github_pull_request(value: GitHubPullRequest) -> Option<ResolvedPullRequest> {
    Some(ResolvedPullRequest {
        number: value.number,
        title: non_empty(value.title)?,
        url: value.url,
        base_branch: non_empty(value.base_ref_name)?,
        head_branch: non_empty(value.head_ref_name)?,
        state: parse_state(&value.state, false),
    })
}

#[derive(Deserialize)]
struct GitLabMergeRequest {
    iid: u64,
    title: String,
    web_url: String,
    target_branch: String,
    source_branch: String,
    state: String,
}

#[must_use]
pub fn parse_gitlab_merge_request(text: &str) -> Option<ResolvedPullRequest> {
    let value = serde_json::from_str::<GitLabMergeRequest>(text).ok()?;
    normalize_gitlab_merge_request(value)
}

fn normalize_gitlab_merge_request(value: GitLabMergeRequest) -> Option<ResolvedPullRequest> {
    Some(ResolvedPullRequest {
        number: value.iid,
        title: non_empty(value.title)?,
        url: value.web_url,
        base_branch: non_empty(value.target_branch)?,
        head_branch: non_empty(value.source_branch)?,
        state: parse_state(&value.state, false),
    })
}

fn parse_current_provider_list(
    provider: ProviderKind,
    text: &str,
) -> Result<Option<ResolvedPullRequest>, String> {
    match provider {
        ProviderKind::Github => serde_json::from_str::<Vec<GitHubPullRequest>>(text)
            .map_err(|error| format!("GitHub returned an invalid pull-request list: {error}"))
            .map(|values| values.into_iter().find_map(normalize_github_pull_request)),
        ProviderKind::Gitlab => serde_json::from_str::<Vec<GitLabMergeRequest>>(text)
            .map_err(|error| format!("GitLab returned an invalid merge-request list: {error}"))
            .map(|values| values.into_iter().find_map(normalize_gitlab_merge_request)),
        ProviderKind::AzureDevops => serde_json::from_str::<Vec<AzurePullRequest>>(text)
            .map_err(|error| format!("Azure DevOps returned an invalid pull-request list: {error}"))
            .map(|values| values.into_iter().find_map(normalize_azure_pull_request)),
        ProviderKind::Bitbucket | ProviderKind::Unknown => Ok(None),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzurePullRequest {
    pull_request_id: u64,
    title: String,
    #[serde(default)]
    url: String,
    target_ref_name: String,
    source_ref_name: String,
    status: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    repository: Option<AzureRepository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzureRepository {
    #[serde(default)]
    web_url: String,
}

#[derive(Deserialize)]
struct BitbucketPullRequestList {
    #[serde(default)]
    values: Vec<BitbucketPullRequest>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct BitbucketPullRequest {
    id: u64,
    title: String,
    state: String,
    links: BitbucketLinks,
    source: BitbucketRef,
    destination: BitbucketRef,
}

#[derive(Deserialize)]
struct BitbucketLinks {
    html: BitbucketLink,
}

#[derive(Deserialize)]
struct BitbucketLink {
    href: String,
}

#[derive(Deserialize)]
struct BitbucketRef {
    branch: BitbucketBranch,
}

#[derive(Deserialize)]
struct BitbucketBranch {
    name: String,
}

struct BitbucketRepositoryLocator {
    workspace: String,
    repository: String,
}

#[derive(Clone, Debug)]
enum BitbucketCredentials {
    Bearer(String),
    Basic { email: String, token: String },
}

#[derive(Clone, Debug)]
struct BitbucketConfiguration {
    api_base_url: String,
    credentials: Option<BitbucketCredentials>,
    request_timeout: Duration,
    response_limit: usize,
}

impl Default for BitbucketConfiguration {
    fn default() -> Self {
        Self {
            api_base_url: bitbucket_api_base_url(),
            credentials: bitbucket_credentials(),
            request_timeout: BITBUCKET_REQUEST_TIMEOUT,
            response_limit: BITBUCKET_RESPONSE_LIMIT,
        }
    }
}

impl BitbucketCredentials {
    fn apply(self, request: RequestBuilder) -> RequestBuilder {
        match self {
            Self::Bearer(token) => request.bearer_auth(token),
            Self::Basic { email, token } => request.basic_auth(email, Some(token)),
        }
    }
}

fn parse_azure_pull_request(text: &str) -> Option<ResolvedPullRequest> {
    let value = serde_json::from_str::<AzurePullRequest>(text).ok()?;
    normalize_azure_pull_request(value)
}

fn normalize_azure_pull_request(value: AzurePullRequest) -> Option<ResolvedPullRequest> {
    let _ = value.is_draft;
    let url = if value.url.trim().is_empty() {
        value.repository.and_then(|repository| {
            let base = repository.web_url.trim_end_matches('/');
            (!base.is_empty()).then(|| format!("{base}/pullrequest/{}", value.pull_request_id))
        })?
    } else {
        value.url
    };
    Some(ResolvedPullRequest {
        number: value.pull_request_id,
        title: non_empty(value.title)?,
        url,
        base_branch: strip_heads(value.target_ref_name)?,
        head_branch: strip_heads(value.source_ref_name)?,
        state: parse_state(&value.status, false),
    })
}

#[cfg(test)]
fn parse_azure_pull_request_list(text: &str) -> Option<ResolvedPullRequest> {
    let values = serde_json::from_str::<Vec<AzurePullRequest>>(text).ok()?;
    values
        .into_iter()
        .next()
        .and_then(normalize_azure_pull_request)
}

fn parse_github_create_output(
    text: &str,
    input: &CreatePullRequestInput,
) -> Option<ResolvedPullRequest> {
    let url = text
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("http://") || line.starts_with("https://"))?;
    let number = url.rsplit('/').next()?.parse().ok()?;
    Some(ResolvedPullRequest {
        number,
        title: input.title.clone(),
        url: url.to_owned(),
        base_branch: input.base_branch.clone(),
        head_branch: input.head_branch.clone(),
        state: ChangeRequestState::Open,
    })
}

fn normalize_bitbucket_pull_request(
    pull_request: BitbucketPullRequest,
) -> Option<ResolvedPullRequest> {
    Some(ResolvedPullRequest {
        number: pull_request.id,
        title: non_empty(pull_request.title)?,
        url: non_empty(pull_request.links.html.href)?,
        base_branch: non_empty(pull_request.destination.branch.name)?,
        head_branch: non_empty(pull_request.source.branch.name)?,
        state: parse_state(&pull_request.state, false),
    })
}

fn parse_bitbucket_repository(remote: &str) -> Option<BitbucketRepositoryLocator> {
    let normalized = remote
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .replace('\\', "/");
    let (authority, path) = if let Some((_, rest)) = normalized.split_once("://") {
        rest.split_once('/')?
    } else {
        normalized.split_once(':')?
    };
    let host_with_port = authority.rsplit('@').next()?;
    let host = host_with_port
        .split_once(':')
        .map_or(host_with_port, |(host, _)| host);
    if !host.eq_ignore_ascii_case("bitbucket.org") {
        return None;
    }
    let parts = path
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>();
    let repository = parts.last()?.trim();
    let workspace = parts.get(parts.len().checked_sub(2)?)?.trim();
    if workspace.is_empty() || repository.is_empty() {
        return None;
    }
    Some(BitbucketRepositoryLocator {
        workspace: workspace.to_owned(),
        repository: repository.to_owned(),
    })
}

fn normalize_pull_request_number(reference: &str) -> Option<u64> {
    let trimmed = reference.trim().trim_start_matches('#');
    trimmed.parse().ok().or_else(|| {
        trimmed
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .and_then(|value| value.parse().ok())
    })
}

fn urls_have_same_origin(configured: &reqwest::Url, candidate: &reqwest::Url) -> bool {
    configured.scheme() == candidate.scheme()
        && configured.host_str() == candidate.host_str()
        && configured.port_or_known_default() == candidate.port_or_known_default()
}

fn bitbucket_api_base_url() -> String {
    environment_value("BIBCODE_BITBUCKET_API_BASE_URL")
        .unwrap_or_else(|| "https://api.bitbucket.org/2.0".to_owned())
        .trim_end_matches('/')
        .to_owned()
}

fn bitbucket_credentials() -> Option<BitbucketCredentials> {
    if let Some(token) = environment_value("BIBCODE_BITBUCKET_ACCESS_TOKEN") {
        return Some(BitbucketCredentials::Bearer(token));
    }
    let email = environment_value("BIBCODE_BITBUCKET_EMAIL")?;
    let token = environment_value("BIBCODE_BITBUCKET_API_TOKEN")?;
    Some(BitbucketCredentials::Basic { email, token })
}

fn environment_value(name: &str) -> Option<String> {
    crate::environment_identity::bibcode_env_string(name)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn truncate_detail(value: &str) -> String {
    value.chars().take(2_000).collect()
}

fn parse_state(value: &str, merged: bool) -> ChangeRequestState {
    if merged || value.eq_ignore_ascii_case("merged") || value.eq_ignore_ascii_case("completed") {
        ChangeRequestState::Merged
    } else if value.eq_ignore_ascii_case("open") || value.eq_ignore_ascii_case("active") {
        ChangeRequestState::Open
    } else {
        ChangeRequestState::Closed
    }
}

fn strip_heads(value: String) -> Option<String> {
    non_empty(value.trim_start_matches("refs/heads/").to_owned())
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn provider_error(
    provider: ProviderKind,
    cwd: &std::path::Path,
    command: Option<&str>,
    reference: &str,
    detail: &str,
) -> SourceControlProviderError {
    SourceControlProviderError {
        tag: "SourceControlProviderError",
        provider,
        operation: "resolvePullRequest".into(),
        cwd: cwd.to_string_lossy().into_owned().into(),
        command: command.map(Into::into),
        reference: Some(reference.into()),
        detail: detail.into(),
    }
}

fn operation_error(
    provider: ProviderKind,
    cwd: &std::path::Path,
    operation: &str,
    command: Option<&str>,
    reference: Option<&str>,
    detail: &str,
) -> SourceControlProviderError {
    SourceControlProviderError {
        tag: "SourceControlProviderError",
        provider,
        operation: operation.into(),
        cwd: cwd.to_string_lossy().into_owned().into(),
        command: command.map(Into::into),
        reference: reference.map(Into::into),
        detail: detail.into(),
    }
}

fn bitbucket_deadline_error(
    cwd: &std::path::Path,
    operation: &str,
    reference: Option<&str>,
    timeout: Duration,
) -> SourceControlProviderError {
    operation_error(
        ProviderKind::Bitbucket,
        cwd,
        operation,
        None,
        reference,
        &format!(
            "Bitbucket request exceeded its {}ms deadline.",
            timeout.as_millis()
        ),
    )
}

fn bitbucket_response_limit_error(
    cwd: &std::path::Path,
    operation: &str,
    reference: Option<&str>,
    limit: usize,
) -> SourceControlProviderError {
    operation_error(
        ProviderKind::Bitbucket,
        cwd,
        operation,
        None,
        reference,
        &format!("Bitbucket response exceeded the {limit} bytes limit."),
    )
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, path::Path, time::Duration};

    use base64::Engine;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::{Semaphore, SemaphorePermit, oneshot},
        task::JoinHandle,
    };

    use crate::test_support::TestSandbox;

    use super::*;

    struct FakeHttpServer {
        base_url: String,
        requests: tokio::sync::mpsc::Receiver<String>,
        task: JoinHandle<()>,
    }

    struct StalledBodyServer {
        base_url: String,
        headers_sent: oneshot::Receiver<()>,
        connection_closed: oneshot::Receiver<()>,
        task: JoinHandle<()>,
    }

    static PULL_REQUEST_FIXTURE_PERMITS: Semaphore = Semaphore::const_new(4);

    async fn acquire_pull_request_fixture() -> SemaphorePermit<'static> {
        PULL_REQUEST_FIXTURE_PERMITS
            .acquire()
            .await
            .expect("pull-request fixture permit remains open")
    }

    fn http_request_is_complete(request: &[u8]) -> bool {
        let Some(header_end) = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| position + 4)
        else {
            return false;
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or_default();
        request.len() >= header_end + content_length
    }

    async fn spawn_http_server(responses: Vec<(u16, String)>) -> FakeHttpServer {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake Bitbucket server");
        let address = listener.local_addr().expect("fake server address");
        let base_url = format!("http://{address}/2.0");
        let responses = responses
            .into_iter()
            .map(|(status, body)| (status, body.replace("$BASE_URL", &base_url)))
            .collect::<Vec<_>>();
        let (request_tx, requests) = tokio::sync::mpsc::channel(responses.len().max(1));
        let task = tokio::spawn(async move {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().await.expect("accept request");
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let read = stream.read(&mut buffer).await.expect("read request");
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if http_request_is_complete(&request) {
                        break;
                    }
                }
                request_tx
                    .send(String::from_utf8_lossy(&request).into_owned())
                    .await
                    .expect("record request");
                let reason = if status == 200 { "OK" } else { "Error" };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("write response");
            }
        });
        FakeHttpServer {
            base_url,
            requests,
            task,
        }
    }

    async fn spawn_stalled_http_server() -> FakeHttpServer {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stalled Bitbucket server");
        let address = listener.local_addr().expect("stalled server address");
        let (request_tx, requests) = tokio::sync::mpsc::channel(1);
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept stalled request");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream
                    .read(&mut buffer)
                    .await
                    .expect("read stalled request");
                if read == 0 {
                    return;
                }
                request.extend_from_slice(&buffer[..read]);
                if http_request_is_complete(&request) {
                    break;
                }
            }
            request_tx
                .send(String::from_utf8_lossy(&request).into_owned())
                .await
                .expect("record stalled request");
            std::future::pending::<()>().await;
        });
        FakeHttpServer {
            base_url: format!("http://{address}/2.0"),
            requests,
            task,
        }
    }

    async fn spawn_stalled_body_server() -> StalledBodyServer {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stalled-body Bitbucket server");
        let address = listener.local_addr().expect("stalled-body server address");
        let (headers_tx, headers_sent) = oneshot::channel();
        let (closed_tx, connection_closed) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener
                .accept()
                .await
                .expect("accept stalled-body request");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream
                    .read(&mut buffer)
                    .await
                    .expect("read stalled-body request");
                if read == 0 {
                    return;
                }
                request.extend_from_slice(&buffer[..read]);
                if http_request_is_complete(&request) {
                    break;
                }
            }
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 128\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write stalled-body headers");
            headers_tx.send(()).expect("signal response headers");
            loop {
                let read = stream
                    .read(&mut buffer)
                    .await
                    .expect("observe stalled-body connection");
                if read == 0 {
                    break;
                }
            }
            closed_tx.send(()).expect("signal client disconnect");
        });
        StalledBodyServer {
            base_url: format!("http://{address}/2.0"),
            headers_sent,
            connection_closed,
            task,
        }
    }

    async fn spawn_chunked_response_server(chunks: Vec<Vec<u8>>) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind chunked Bitbucket server");
        let address = listener.local_addr().expect("chunked server address");
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept chunked request");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream
                    .read(&mut buffer)
                    .await
                    .expect("read chunked request");
                if read == 0 {
                    return;
                }
                request.extend_from_slice(&buffer[..read]);
                if http_request_is_complete(&request) {
                    break;
                }
            }
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write chunked headers");
            for chunk in chunks {
                stream
                    .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                    .await
                    .expect("write chunk length");
                stream.write_all(&chunk).await.expect("write chunk body");
                stream.write_all(b"\r\n").await.expect("write chunk end");
            }
            stream
                .write_all(b"0\r\n\r\n")
                .await
                .expect("finish chunked body");
        });
        (format!("http://{address}/2.0"), task)
    }

    fn bitbucket_service(
        api_base_url: &str,
        credentials: Option<BitbucketCredentials>,
    ) -> PullRequestService {
        PullRequestService {
            bitbucket: BitbucketConfiguration {
                api_base_url: api_base_url.into(),
                credentials,
                ..BitbucketConfiguration::default()
            },
            ..PullRequestService::default()
        }
    }

    fn bitbucket_service_for_repository(
        api_base_url: &str,
        credentials: Option<BitbucketCredentials>,
        repository: &TestSandbox,
    ) -> PullRequestService {
        bitbucket_service(api_base_url, credentials).with_git_command_for_test(
            repository.executable_on_path("git"),
            captured_git_environment(repository),
        )
    }

    fn captured_git_environment(sandbox: &TestSandbox) -> Vec<(OsString, OsString)> {
        sandbox
            .environment([("GIT_CONFIG_NOSYSTEM", "1")])
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect()
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn provider_cli_fixtures_are_instance_owned_in_parallel() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        async fn resolve(label: &str) -> ResolvedPullRequest {
            let sandbox = TestSandbox::new(label);
            let command = sandbox.executable_script(
                "gh",
                &format!("printf '%s\\n' '{{\"number\":42,\"title\":\"{label}\",\"url\":\"https://example.test/42\",\"baseRefName\":\"main\",\"headRefName\":\"feature\",\"state\":\"OPEN\"}}'"),
                "",
            );
            PullRequestService::with_provider_commands(
                command.to_string_lossy(),
                "unused-glab",
                "unused-az",
            )
            .resolve_current(
                ResolvePullRequestInput {
                    cwd: sandbox.root().to_path_buf(),
                    provider: ProviderKind::Github,
                    reference: "feature".to_owned(),
                },
                &CancellationToken::new(),
            )
            .await
            .expect("resolve fixture PR")
        }

        let (left, right) = tokio::join!(resolve("left"), resolve("right"));
        assert_eq!(left.title, "left");
        assert_eq!(right.title, "right");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provider_cli_flows_cover_github_gitlab_and_azure_resolution_and_creation() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let sandbox = TestSandbox::new("provider-cli");
        let script = r#"#!/bin/sh
case "$(basename "$0"):$*" in
  gh.sh:*create*) printf '%s\n' 'https://github.com/example/repo/pull/42' ;;
  gh.sh:*list*) printf '%s\n' '[{"number":42,"title":"GitHub PR","url":"https://github.test/42","baseRefName":"main","headRefName":"feature","state":"OPEN"}]' ;;
  gh.sh:*) printf '%s\n' '{"number":42,"title":"GitHub PR","url":"https://github.test/42","baseRefName":"main","headRefName":"feature","state":"OPEN"}' ;;
  glab.sh:*list*) printf '%s\n' '[{"iid":43,"title":"GitLab MR","web_url":"https://gitlab.test/43","target_branch":"main","source_branch":"feature","state":"opened"}]' ;;
  glab.sh:*) printf '%s\n' '{"iid":43,"title":"GitLab MR","web_url":"https://gitlab.test/43","target_branch":"main","source_branch":"feature","state":"opened"}' ;;
  az.sh:*list*) printf '%s\n' '[{"pullRequestId":44,"title":"Azure PR","url":"https://azure.test/44","targetRefName":"refs/heads/main","sourceRefName":"refs/heads/feature","status":"active"}]' ;;
  az.sh:*) printf '%s\n' '{"pullRequestId":44,"title":"Azure PR","url":"https://azure.test/44","targetRefName":"refs/heads/main","sourceRefName":"refs/heads/feature","status":"active"}' ;;
esac
"#;
        let service = PullRequestService::with_provider_commands(
            sandbox
                .executable_script("gh", script, "")
                .to_string_lossy(),
            sandbox
                .executable_script("glab", script, "")
                .to_string_lossy(),
            sandbox
                .executable_script("az", script, "")
                .to_string_lossy(),
        );
        let cancellation = CancellationToken::new();

        let current = service
            .resolve_current(
                ResolvePullRequestInput {
                    cwd: sandbox.root().to_path_buf(),
                    provider: ProviderKind::AzureDevops,
                    reference: "feature".to_owned(),
                },
                &cancellation,
            )
            .await
            .expect("Azure current PR should resolve");
        assert_eq!(current.number, 44);

        for (provider, expected) in [(ProviderKind::Github, 42), (ProviderKind::Gitlab, 43)] {
            let current = service
                .resolve_current(
                    ResolvePullRequestInput {
                        cwd: sandbox.root().to_path_buf(),
                        provider,
                        reference: "feature".to_owned(),
                    },
                    &cancellation,
                )
                .await
                .expect("current provider PR should resolve");
            assert_eq!(current.number, expected);
        }

        for (provider, expected) in [
            (ProviderKind::Github, 42),
            (ProviderKind::Gitlab, 43),
            (ProviderKind::AzureDevops, 44),
        ] {
            let resolved = service
                .resolve(
                    ResolvePullRequestInput {
                        cwd: sandbox.root().to_path_buf(),
                        provider,
                        reference: expected.to_string(),
                    },
                    &cancellation,
                )
                .await
                .expect("provider PR should resolve");
            assert_eq!(resolved.number, expected);

            let created = service
                .create(
                    CreatePullRequestInput {
                        cwd: sandbox.root().to_path_buf(),
                        provider,
                        base_branch: "main".to_owned(),
                        head_branch: "feature".to_owned(),
                        title: "Fixture".to_owned(),
                        body: "Body".to_owned(),
                    },
                    &cancellation,
                )
                .await
                .expect("provider PR should create");
            assert_eq!(created.number, expected);
        }
    }

    #[tokio::test]
    async fn provider_cli_flows_report_spawn_exit_and_payload_failures() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let sandbox = TestSandbox::new("provider-cli-errors");
        let cancellation = CancellationToken::new();
        let missing = sandbox
            .root()
            .join("missing")
            .to_string_lossy()
            .into_owned();
        let missing_service =
            PullRequestService::with_provider_commands(missing.clone(), missing.clone(), missing);
        let resolve_input = |provider| ResolvePullRequestInput {
            cwd: sandbox.root().to_path_buf(),
            provider,
            reference: "feature".to_owned(),
        };
        assert!(
            missing_service
                .resolve(resolve_input(ProviderKind::Github), &cancellation)
                .await
                .unwrap_err()
                .detail
                .contains("execution failed")
        );

        let failed = provider_failure_fixture(
            sandbox.root(),
            "failed",
            "#!/bin/sh\nexit 7\n",
            "@echo off\r\nexit /b 7\r\n",
        );
        let failed_command = failed.to_string_lossy().into_owned();
        let failed_service = PullRequestService::with_provider_commands(
            failed_command.clone(),
            failed_command.clone(),
            failed_command,
        );
        assert!(
            failed_service
                .resolve(resolve_input(ProviderKind::Github), &cancellation)
                .await
                .unwrap_err()
                .detail
                .contains("not found or provider authentication failed")
        );

        let invalid = provider_failure_fixture(
            sandbox.root(),
            "invalid",
            "#!/bin/sh\nprintf invalid\n",
            "@echo off\r\necho invalid\r\n",
        );
        let invalid_command = invalid.to_string_lossy().into_owned();
        let invalid_service = PullRequestService::with_provider_commands(
            invalid_command.clone(),
            invalid_command.clone(),
            invalid_command,
        );
        assert!(
            invalid_service
                .resolve(resolve_input(ProviderKind::Github), &cancellation)
                .await
                .unwrap_err()
                .detail
                .contains("unrecognized change-request payload")
        );
        assert!(
            invalid_service
                .resolve_current(resolve_input(ProviderKind::AzureDevops), &cancellation)
                .await
                .unwrap_err()
                .detail
                .contains("invalid pull-request list")
        );
        assert!(
            invalid_service
                .create(
                    CreatePullRequestInput {
                        cwd: sandbox.root().to_path_buf(),
                        provider: ProviderKind::Github,
                        base_branch: "main".to_owned(),
                        head_branch: "feature".to_owned(),
                        title: "Invalid output".to_owned(),
                        body: String::new(),
                    },
                    &cancellation,
                )
                .await
                .unwrap_err()
                .detail
                .contains("unrecognized pull-request payload")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bitbucket_locator_uses_its_owned_git_command_and_environment() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let sandbox = TestSandbox::new("bitbucket-owned-git");
        let git_command = sandbox.executable_script(
            "git",
            "test \"$1:$2:$3:$FIXTURE_LABEL\" = \"remote:get-url:origin:owned\" || exit 64\nprintf '%s\\n' 'https://bitbucket.org/example/owned.git'",
            "",
        );
        let service = PullRequestService::default().with_git_command_for_test(
            git_command,
            sandbox
                .environment([("FIXTURE_LABEL", "owned")])
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        );

        let locator = service
            .bitbucket_locator(sandbox.root(), &CancellationToken::new())
            .await
            .expect("owned Git fixture resolves Bitbucket repository");

        assert_eq!(locator.workspace, "example");
        assert_eq!(locator.repository, "owned");
    }

    fn provider_failure_fixture(
        directory: &Path,
        name: &str,
        _unix_contents: &str,
        _windows_contents: &str,
    ) -> PathBuf {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let path = directory.join(name);
            std::fs::write(&path, _unix_contents).expect("provider fixture should write");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("provider fixture should be executable");
            path
        }
        #[cfg(windows)]
        {
            let path = directory.join(format!("{name}.cmd"));
            std::fs::write(&path, _windows_contents).expect("provider fixture should write");
            path
        }
    }

    fn provider_command_fixture(
        sandbox: &TestSandbox,
        name: &str,
        unix_contents: &str,
        windows_contents: &str,
    ) -> ProviderCommandSpec {
        let script = sandbox.executable_script(name, unix_contents, windows_contents);
        #[cfg(unix)]
        {
            ProviderCommandSpec::new("/bin/sh", [script.into_os_string()])
        }
        #[cfg(windows)]
        {
            ProviderCommandSpec::new(
                std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()),
                [
                    OsString::from("/D"),
                    OsString::from("/C"),
                    script.into_os_string(),
                ],
            )
        }
    }

    #[tokio::test]
    async fn current_provider_resolution_distinguishes_absence_success_and_operational_failure() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let sandbox = TestSandbox::new("provider-current-optional");
        let empty = provider_command_fixture(
            &sandbox,
            "empty",
            "printf '%s\\n' '[]'",
            "@echo off\r\necho []\r\n",
        );
        let service = PullRequestService::with_provider_command_specs_for_test(
            empty.clone(),
            empty.clone(),
            empty,
        );
        for provider in [
            ProviderKind::Github,
            ProviderKind::Gitlab,
            ProviderKind::AzureDevops,
        ] {
            assert_eq!(
                service
                    .resolve_current_optional(
                        ResolvePullRequestInput {
                            cwd: sandbox.root().to_path_buf(),
                            provider,
                            reference: "feature/test".to_owned(),
                        },
                        &CancellationToken::new(),
                    )
                    .await
                    .expect("empty provider list is successful absence"),
                None
            );
        }

        let failed =
            provider_command_fixture(&sandbox, "failed", "exit 7", "@echo off\r\nexit /b 7\r\n");
        let service = PullRequestService::with_provider_command_specs_for_test(
            failed.clone(),
            failed.clone(),
            failed,
        );
        for provider in [ProviderKind::Github, ProviderKind::Gitlab] {
            let error = service
                .resolve_current_optional(
                    ResolvePullRequestInput {
                        cwd: sandbox.root().to_path_buf(),
                        provider,
                        reference: "feature/test".to_owned(),
                    },
                    &CancellationToken::new(),
                )
                .await
                .expect_err("provider failure must not become no PR");
            assert_eq!(error.provider, provider);
        }
    }

    #[tokio::test]
    async fn current_provider_resolution_parses_github_gitlab_and_azure_lists() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let sandbox = TestSandbox::new("provider-current-values");
        let github = provider_command_fixture(
            &sandbox,
            "github",
            "printf '%s\\n' '[{\"number\":42,\"title\":\"GitHub PR\",\"url\":\"https://github.test/42\",\"baseRefName\":\"main\",\"headRefName\":\"feature/test\",\"state\":\"OPEN\"}]'",
            "@echo off\r\necho [{\"number\":42,\"title\":\"GitHub PR\",\"url\":\"https://github.test/42\",\"baseRefName\":\"main\",\"headRefName\":\"feature/test\",\"state\":\"OPEN\"}]\r\n",
        );
        let gitlab = provider_command_fixture(
            &sandbox,
            "gitlab",
            "printf '%s\\n' '[{\"iid\":43,\"title\":\"GitLab MR\",\"web_url\":\"https://gitlab.test/43\",\"target_branch\":\"main\",\"source_branch\":\"feature/test\",\"state\":\"opened\"}]'",
            "@echo off\r\necho [{\"iid\":43,\"title\":\"GitLab MR\",\"web_url\":\"https://gitlab.test/43\",\"target_branch\":\"main\",\"source_branch\":\"feature/test\",\"state\":\"opened\"}]\r\n",
        );
        let azure = provider_command_fixture(
            &sandbox,
            "azure",
            "printf '%s\\n' '[{\"pullRequestId\":44,\"title\":\"Azure PR\",\"url\":\"https://azure.test/44\",\"targetRefName\":\"refs/heads/main\",\"sourceRefName\":\"refs/heads/feature/test\",\"status\":\"active\"}]'",
            "@echo off\r\necho [{\"pullRequestId\":44,\"title\":\"Azure PR\",\"url\":\"https://azure.test/44\",\"targetRefName\":\"refs/heads/main\",\"sourceRefName\":\"refs/heads/feature/test\",\"status\":\"active\"}]\r\n",
        );
        let service =
            PullRequestService::with_provider_command_specs_for_test(github, gitlab, azure);

        for (provider, expected) in [
            (ProviderKind::Github, 42),
            (ProviderKind::Gitlab, 43),
            (ProviderKind::AzureDevops, 44),
        ] {
            let resolved = service
                .resolve_current_optional(
                    ResolvePullRequestInput {
                        cwd: sandbox.root().to_path_buf(),
                        provider,
                        reference: "feature/test".to_owned(),
                    },
                    &CancellationToken::new(),
                )
                .await
                .expect("provider list succeeds")
                .expect("matching PR");
            assert_eq!(resolved.number, expected);
            assert_eq!(resolved.head_branch, "feature/test");
        }
    }

    async fn bitbucket_repository() -> TestSandbox {
        let sandbox = TestSandbox::new("bitbucket-repository");
        let git_command = sandbox.executable_on_path("git");
        let git_environment = captured_git_environment(&sandbox);
        for args in [
            vec!["init"],
            vec![
                "remote",
                "add",
                "origin",
                "https://bitbucket.org/example/native-source-control.git",
            ],
        ] {
            ProcessRunner
                .run(
                    ProcessRequest {
                        operation: "test.bitbucketRepository.git".to_owned(),
                        command: git_command.clone(),
                        args: args.into_iter().map(OsString::from).collect(),
                        cwd: sandbox.root().to_path_buf(),
                        env: git_environment.clone(),
                        stdin: None,
                        timeout: Duration::from_secs(30),
                        max_output_bytes: 8_000,
                        output_policy: OutputPolicy::Error,
                        append_truncation_marker: false,
                        allow_non_zero_exit: false,
                    },
                    &CancellationToken::new(),
                )
                .await
                .expect("run Git fixture command");
        }
        sandbox
    }

    #[test]
    fn parses_azure_ref_prefixes() {
        let parsed = parse_azure_pull_request(
            r#"{"pullRequestId":3,"title":"Rust","url":"https://example.test/3","targetRefName":"refs/heads/main","sourceRefName":"refs/heads/rust","status":"completed"}"#,
        )
        .expect("Azure pull request");
        assert_eq!(parsed.base_branch, "main");
        assert_eq!(parsed.state, ChangeRequestState::Merged);
    }

    #[test]
    fn parses_azure_current_pull_request_lists_and_derives_a_web_url() {
        let parsed = parse_azure_pull_request_list(
            r#"[{"pullRequestId":7,"title":"Native source control","url":"","targetRefName":"refs/heads/main","sourceRefName":"refs/heads/feature/native","status":"active","repository":{"webUrl":"https://dev.azure.com/example/project/_git/repo"}}]"#,
        )
        .expect("Azure pull request list");
        assert_eq!(parsed.number, 7);
        assert_eq!(parsed.head_branch, "feature/native");
        assert_eq!(
            parsed.url,
            "https://dev.azure.com/example/project/_git/repo/pullrequest/7"
        );
    }

    #[test]
    fn parses_github_create_url_with_input_metadata() {
        let input = CreatePullRequestInput {
            cwd: PathBuf::from("repo"),
            provider: ProviderKind::Github,
            base_branch: "main".into(),
            head_branch: "feature/native".into(),
            title: "Native source control".into(),
            body: String::new(),
        };
        let parsed =
            parse_github_create_output("https://github.com/example/repo/pull/42\n", &input)
                .expect("GitHub create output");
        assert_eq!(parsed.number, 42);
        assert_eq!(parsed.base_branch, "main");
        assert_eq!(parsed.state, ChangeRequestState::Open);
    }

    #[test]
    fn parses_bitbucket_https_and_ssh_repository_remotes() {
        for remote in [
            "https://bitbucket.org/example/native-source-control.git",
            "git@bitbucket.org:example/native-source-control.git",
        ] {
            let parsed = parse_bitbucket_repository(remote).expect("Bitbucket repository");
            assert_eq!(parsed.workspace, "example");
            assert_eq!(parsed.repository, "native-source-control");
        }
    }

    #[test]
    fn rejects_non_bitbucket_repository_remotes() {
        assert!(
            parse_bitbucket_repository("https://github.com/example/native-source-control.git")
                .is_none()
        );
    }

    #[tokio::test]
    async fn bitbucket_branch_resolution_follows_pagination() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let repository = bitbucket_repository().await;
        let mut server = spawn_http_server(vec![
            (
                200,
                r#"{"values":[],"next":"$BASE_URL/repositories/example/native-source-control/pullrequests?page=2"}"#.to_owned(),
            ),
            (
                200,
                r#"{"values":[{"id":19,"title":"Native source control","state":"OPEN","links":{"html":{"href":"https://bitbucket.org/example/native-source-control/pull-requests/19"}},"source":{"branch":{"name":"feature/native"}},"destination":{"branch":{"name":"main"}}}]}"#.to_owned(),
            ),
        ])
        .await;
        let service = bitbucket_service_for_repository(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
            &repository,
        );

        let pull_request = service
            .resolve(
                ResolvePullRequestInput {
                    cwd: repository.root().to_path_buf(),
                    provider: ProviderKind::Bitbucket,
                    reference: "feature/native".into(),
                },
                &CancellationToken::new(),
            )
            .await
            .expect("resolve paginated Bitbucket pull request");

        assert_eq!(pull_request.number, 19);
        let first_request = server.requests.recv().await.expect("first request");
        let second_request = server.requests.recv().await.expect("second request");
        assert!(
            first_request
                .starts_with("GET /2.0/repositories/example/native-source-control/pullrequests?")
        );
        assert!(second_request.starts_with(
            "GET /2.0/repositories/example/native-source-control/pullrequests?page=2 "
        ));
        assert!(second_request.contains("authorization: Bearer test-token\r\n"));
        server.task.await.expect("fake server task");
    }

    #[tokio::test]
    async fn bitbucket_pagination_rejects_a_different_origin_before_sending_credentials() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let repository = bitbucket_repository().await;
        let mut second_server = spawn_http_server(vec![(
            200,
            r#"{"values":[{"id":20,"title":"Leaked request","state":"OPEN","links":{"html":{"href":"https://bitbucket.org/example/native-source-control/pull-requests/20"}},"source":{"branch":{"name":"feature/native"}},"destination":{"branch":{"name":"main"}}}]}"#.to_owned(),
        )])
        .await;
        let first_server = spawn_http_server(vec![(
            200,
            format!(
                r#"{{"values":[],"next":"{}/pullrequests?page=2"}}"#,
                second_server.base_url
            ),
        )])
        .await;
        let service = bitbucket_service_for_repository(
            &first_server.base_url,
            Some(BitbucketCredentials::Bearer("must-not-leak".into())),
            &repository,
        );

        let error = service
            .resolve_current(
                ResolvePullRequestInput {
                    cwd: repository.root().to_path_buf(),
                    provider: ProviderKind::Bitbucket,
                    reference: "feature/native".into(),
                },
                &CancellationToken::new(),
            )
            .await
            .expect_err("cross-origin pagination URL");

        assert_eq!(error.operation.as_ref(), "resolveCurrentPullRequest");
        assert_eq!(error.reference.as_deref(), Some("feature/native"));
        assert_eq!(
            error.detail.as_ref(),
            "Bitbucket pagination URL must use the configured API origin."
        );
        first_server.task.await.expect("first server task");
        assert!(second_server.requests.try_recv().is_err());
        second_server.task.abort();
        let _ = second_server.task.await;
    }

    #[tokio::test]
    async fn bitbucket_pagination_maps_a_malformed_next_url_to_a_structured_error() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let repository = bitbucket_repository().await;
        let server = spawn_http_server(vec![(
            200,
            r#"{"values":[],"next":"not a URL"}"#.to_owned(),
        )])
        .await;
        let service = bitbucket_service_for_repository(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
            &repository,
        );

        let error = service
            .resolve_current(
                ResolvePullRequestInput {
                    cwd: repository.root().to_path_buf(),
                    provider: ProviderKind::Bitbucket,
                    reference: "feature/native".into(),
                },
                &CancellationToken::new(),
            )
            .await
            .expect_err("malformed pagination URL");

        assert_eq!(error.operation.as_ref(), "resolveCurrentPullRequest");
        assert_eq!(error.reference.as_deref(), Some("feature/native"));
        assert!(
            error
                .detail
                .starts_with("Bitbucket returned an invalid pagination URL:")
        );
        server.task.await.expect("malformed URL server task");
    }

    #[test]
    fn bitbucket_pagination_origin_rejects_host_port_and_https_downgrade() {
        let configured =
            reqwest::Url::parse("https://api.bitbucket.test:443/2.0").expect("configured API URL");
        let same_origin =
            reqwest::Url::parse("https://api.bitbucket.test/2.0/page/2").expect("same-origin URL");
        assert!(urls_have_same_origin(&configured, &same_origin));

        for candidate in [
            "https://other.bitbucket.test/2.0/page/2",
            "https://api.bitbucket.test:444/2.0/page/2",
            "http://api.bitbucket.test/2.0/page/2",
        ] {
            let candidate = reqwest::Url::parse(candidate).expect("candidate URL");
            assert!(!urls_have_same_origin(&configured, &candidate));
        }
    }

    #[tokio::test]
    async fn bitbucket_explicit_references_use_the_direct_endpoint_and_bearer_auth() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let repository = bitbucket_repository().await;
        let response = r#"{"id":42,"title":"Merged work","state":"MERGED","links":{"html":{"href":"https://bitbucket.org/example/native-source-control/pull-requests/42"}},"source":{"branch":{"name":"feature/merged"}},"destination":{"branch":{"name":"main"}}}"#.to_owned();
        let mut server = spawn_http_server(vec![
            (200, response.clone()),
            (200, response.clone()),
            (200, response),
        ])
        .await;
        let service = bitbucket_service_for_repository(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("bearer-secret".into())),
            &repository,
        );

        for reference in [
            "42",
            "#42",
            "https://bitbucket.org/example/native-source-control/pull-requests/42/",
        ] {
            let pull_request = service
                .resolve(
                    ResolvePullRequestInput {
                        cwd: repository.root().to_path_buf(),
                        provider: ProviderKind::Bitbucket,
                        reference: reference.into(),
                    },
                    &CancellationToken::new(),
                )
                .await
                .expect("resolve explicit Bitbucket pull request");

            assert_eq!(pull_request.number, 42);
            assert_eq!(pull_request.state, ChangeRequestState::Merged);
            let request = server.requests.recv().await.expect("direct request");
            assert!(request.starts_with(
                "GET /2.0/repositories/example/native-source-control/pullrequests/42 HTTP/1.1"
            ));
            assert!(request.contains("authorization: Bearer bearer-secret\r\n"));
        }
        server.task.await.expect("fake server task");
    }

    #[tokio::test]
    async fn bitbucket_current_branch_preserves_numeric_path_segments_in_the_list_query() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let repository = bitbucket_repository().await;
        let mut server = spawn_http_server(vec![
            (
                200,
                r#"{"values":[{"id":61,"title":"Feature branch","state":"OPEN","links":{"html":{"href":"https://bitbucket.org/example/native-source-control/pull-requests/61"}},"source":{"branch":{"name":"feature/123"}},"destination":{"branch":{"name":"main"}}}]}"#.to_owned(),
            ),
            (
                200,
                r#"{"values":[{"id":62,"title":"Release branch","state":"OPEN","links":{"html":{"href":"https://bitbucket.org/example/native-source-control/pull-requests/62"}},"source":{"branch":{"name":"release/2026"}},"destination":{"branch":{"name":"main"}}}]}"#.to_owned(),
            ),
        ])
        .await;
        let service = bitbucket_service_for_repository(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
            &repository,
        );

        for (branch, number) in [("feature/123", 61), ("release/2026", 62)] {
            let pull_request = service
                .resolve_current(
                    ResolvePullRequestInput {
                        cwd: repository.root().to_path_buf(),
                        provider: ProviderKind::Bitbucket,
                        reference: branch.into(),
                    },
                    &CancellationToken::new(),
                )
                .await
                .expect("resolve numeric-suffixed branch");
            assert_eq!(pull_request.number, number);

            let request = server.requests.recv().await.expect("branch list request");
            let target = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .expect("request target");
            let target = reqwest::Url::parse(&format!("http://loopback{target}"))
                .expect("request target URL");
            assert!(target.path().ends_with("/pullrequests"));
            assert_eq!(
                target
                    .query_pairs()
                    .find(|(name, _)| name == "q")
                    .map(|(_, value)| value.into_owned()),
                Some(format!(
                    "source.branch.name = \"{branch}\" AND state = \"OPEN\""
                ))
            );
        }
        server.task.await.expect("branch server task");
    }

    #[tokio::test]
    async fn bitbucket_current_optional_distinguishes_no_pr_from_provider_error() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let repository = bitbucket_repository().await;
        let mut server = spawn_http_server(vec![
            (200, r#"{"values":[]}"#.to_owned()),
            (401, r#"{"error":{"message":"unauthorized"}}"#.to_owned()),
        ])
        .await;
        let service = bitbucket_service_for_repository(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
            &repository,
        );
        let input = || ResolvePullRequestInput {
            cwd: repository.root().to_path_buf(),
            provider: ProviderKind::Bitbucket,
            reference: "feature/test".into(),
        };

        assert_eq!(
            service
                .resolve_current_optional(input(), &CancellationToken::new())
                .await
                .expect("empty Bitbucket list is absence"),
            None
        );
        let error = service
            .resolve_current_optional(input(), &CancellationToken::new())
            .await
            .expect_err("Bitbucket authentication failure is operational");
        assert!(error.detail.contains("HTTP 401"));

        server.requests.recv().await.expect("empty-list request");
        server.requests.recv().await.expect("error request");
        server.task.await.expect("optional Bitbucket server task");
    }

    #[tokio::test]
    async fn bitbucket_current_optional_recovers_after_an_operational_error() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let repository = bitbucket_repository().await;
        let mut server = spawn_http_server(vec![
            (503, r#"{"error":{"message":"retry"}}"#.to_owned()),
            (
                200,
                r#"{"values":[{"id":79,"title":"Recovered","state":"OPEN","links":{"html":{"href":"https://bitbucket.test/79"}},"source":{"branch":{"name":"feature/test"}},"destination":{"branch":{"name":"main"}}}]}"#.to_owned(),
            ),
        ])
        .await;
        let service = bitbucket_service_for_repository(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
            &repository,
        );
        let input = || ResolvePullRequestInput {
            cwd: repository.root().to_path_buf(),
            provider: ProviderKind::Bitbucket,
            reference: "feature/test".into(),
        };

        assert!(
            service
                .resolve_current_optional(input(), &CancellationToken::new())
                .await
                .is_err()
        );
        let recovered = service
            .resolve_current_optional(input(), &CancellationToken::new())
            .await
            .expect("Bitbucket recovery request succeeds")
            .expect("Bitbucket recovery PR");
        assert_eq!(recovered.number, 79);

        server.requests.recv().await.expect("failed request");
        server.requests.recv().await.expect("recovery request");
        server.task.await.expect("recovery server task");
    }

    #[tokio::test]
    async fn bitbucket_creation_sends_branch_payload_with_basic_auth() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let repository = bitbucket_repository().await;
        let mut server = spawn_http_server(vec![(
            200,
            r#"{"id":51,"title":"Create native flow","state":"OPEN","links":{"html":{"href":"https://bitbucket.org/example/native-source-control/pull-requests/51"}},"source":{"branch":{"name":"feature/create"}},"destination":{"branch":{"name":"release"}}}"#.to_owned(),
        )])
        .await;
        let service = bitbucket_service_for_repository(
            &server.base_url,
            Some(BitbucketCredentials::Basic {
                email: "user@example.test".into(),
                token: "api-token".into(),
            }),
            &repository,
        );

        let pull_request = service
            .create(
                CreatePullRequestInput {
                    cwd: repository.root().to_path_buf(),
                    provider: ProviderKind::Bitbucket,
                    base_branch: "release".into(),
                    head_branch: "feature/create".into(),
                    title: "Create native flow".into(),
                    body: "A deterministic body".into(),
                },
                &CancellationToken::new(),
            )
            .await
            .expect("create Bitbucket pull request");

        assert_eq!(pull_request.number, 51);
        let request = server.requests.recv().await.expect("create request");
        assert!(request.starts_with(
            "POST /2.0/repositories/example/native-source-control/pullrequests HTTP/1.1"
        ));
        let credentials =
            base64::engine::general_purpose::STANDARD.encode("user@example.test:api-token");
        assert!(request.contains(&format!("authorization: Basic {credentials}\r\n")));
        let body = request
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .expect("request body");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).expect("JSON request body"),
            serde_json::json!({
                "title": "Create native flow",
                "description": "A deterministic body",
                "source": { "branch": { "name": "feature/create" } },
                "destination": { "branch": { "name": "release" } },
            })
        );
        server.task.await.expect("fake server task");
    }

    #[tokio::test]
    async fn bitbucket_cancellation_stops_an_in_flight_request() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let repository = bitbucket_repository().await;
        let mut server = spawn_stalled_http_server().await;
        let service = bitbucket_service_for_repository(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
            &repository,
        );
        let cancellation = CancellationToken::new();
        let request_cancellation = cancellation.clone();
        let cwd = repository.root().to_path_buf();
        let request_task = tokio::spawn(async move {
            service
                .resolve(
                    ResolvePullRequestInput {
                        cwd,
                        provider: ProviderKind::Bitbucket,
                        reference: "73".into(),
                    },
                    &request_cancellation,
                )
                .await
        });

        server.requests.recv().await.expect("in-flight request");
        cancellation.cancel();
        let error = request_task
            .await
            .expect("resolution task")
            .expect_err("cancelled Bitbucket request");

        assert_eq!(error.operation.as_ref(), "resolvePullRequest");
        assert_eq!(error.reference.as_deref(), Some("73"));
        assert_eq!(error.detail.as_ref(), "Bitbucket request was cancelled.");
        server.task.abort();
        let _ = server.task.await;
    }

    #[tokio::test]
    async fn bitbucket_cancellation_stops_a_stalled_response_body_read() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let server = spawn_stalled_body_server().await;
        let service = bitbucket_service(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
        );
        let response = service
            .client
            .get(format!("{}/stalled-body", server.base_url))
            .send()
            .await
            .expect("receive stalled response headers");
        server.headers_sent.await.expect("response headers sent");
        let cancellation = CancellationToken::new();
        let request_cancellation = cancellation.clone();
        let cwd = PathBuf::from("stalled-body-repository");
        let request_task = tokio::spawn(async move {
            service
                .decode_bitbucket_response::<BitbucketPullRequest>(
                    response,
                    &cwd,
                    "resolvePullRequest",
                    Some("74"),
                    &request_cancellation,
                )
                .await
        });

        cancellation.cancel();
        let result = tokio::time::timeout(Duration::from_secs(5), request_task)
            .await
            .expect("body cancellation completes promptly")
            .expect("resolution task");
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("stalled Bitbucket body read was not cancelled"),
        };

        assert_eq!(error.operation.as_ref(), "resolvePullRequest");
        assert_eq!(error.reference.as_deref(), Some("74"));
        assert_eq!(error.detail.as_ref(), "Bitbucket request was cancelled.");
        tokio::time::timeout(Duration::from_secs(5), server.connection_closed)
            .await
            .expect("client closes stalled response promptly")
            .expect("client disconnect signal");
        server.task.await.expect("stalled-body server task");
    }

    #[tokio::test]
    async fn bitbucket_response_deadline_covers_a_stalled_body_and_closes_the_request() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let server = spawn_stalled_body_server().await;
        let service = bitbucket_service(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
        )
        .with_bitbucket_limits_for_test(Duration::from_millis(50), 256);
        let response = service
            .client
            .get(format!("{}/deadline", server.base_url))
            .send()
            .await
            .expect("receive deadline response headers");
        server.headers_sent.await.expect("deadline headers sent");

        let result = service
            .decode_bitbucket_response::<BitbucketPullRequest>(
                response,
                Path::new("deadline-repository"),
                "resolvePullRequest",
                Some("75"),
                &CancellationToken::new(),
            )
            .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("stalled response did not hit the absolute deadline"),
        };

        assert!(error.detail.contains("deadline"));
        tokio::time::timeout(Duration::from_secs(5), server.connection_closed)
            .await
            .expect("deadline closes the request")
            .expect("deadline disconnect signal");
        server.task.await.expect("deadline server task");
    }

    #[tokio::test]
    async fn bitbucket_request_deadline_covers_stalled_response_headers() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let mut server = spawn_stalled_http_server().await;
        let service = bitbucket_service(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
        )
        .with_bitbucket_limits_for_test(Duration::from_millis(50), 1024);

        let result = service
            .send_bitbucket::<BitbucketPullRequest>(
                service
                    .client
                    .get(format!("{}/stalled-headers", server.base_url)),
                Path::new("stalled-headers-repository"),
                "resolvePullRequest",
                Some("80"),
                &CancellationToken::new(),
            )
            .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("stalled response headers did not hit the absolute deadline"),
        };

        assert!(error.detail.contains("deadline"));
        server
            .requests
            .recv()
            .await
            .expect("stalled request reached server");
        server.task.abort();
        let _ = server.task.await;
    }

    #[tokio::test]
    async fn bitbucket_rejects_oversized_content_length_before_reading_the_body() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let server = spawn_stalled_body_server().await;
        let service = bitbucket_service(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
        )
        .with_bitbucket_limits_for_test(Duration::from_secs(5), 64);
        let response = service
            .client
            .get(format!("{}/oversized-content-length", server.base_url))
            .send()
            .await
            .expect("receive oversized response headers");
        server.headers_sent.await.expect("oversized headers sent");

        let result = service
            .decode_bitbucket_response::<BitbucketPullRequest>(
                response,
                Path::new("oversized-repository"),
                "resolvePullRequest",
                Some("76"),
                &CancellationToken::new(),
            )
            .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("oversized Content-Length did not fail before body read"),
        };

        assert!(error.detail.contains("64 bytes"));
        tokio::time::timeout(Duration::from_secs(5), server.connection_closed)
            .await
            .expect("oversize rejection closes the request")
            .expect("oversize disconnect signal");
        server.task.await.expect("oversize server task");
    }

    #[tokio::test]
    async fn bitbucket_rejects_an_oversized_chunked_body_and_accepts_a_bounded_body() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let (base_url, oversized_task) =
            spawn_chunked_response_server(vec![vec![b' '; 24], vec![b' '; 24]]).await;
        let service = bitbucket_service(
            &base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
        )
        .with_bitbucket_limits_for_test(Duration::from_secs(5), 32);
        let response = service
            .client
            .get(format!("{base_url}/oversized-chunked"))
            .send()
            .await
            .expect("receive chunked response");
        let result = service
            .decode_bitbucket_response::<BitbucketPullRequest>(
                response,
                Path::new("chunked-repository"),
                "resolvePullRequest",
                Some("77"),
                &CancellationToken::new(),
            )
            .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("oversized chunked body was accepted"),
        };
        assert!(error.detail.contains("32 bytes"));
        oversized_task.await.expect("oversized chunked server task");

        let body = r#"{"id":78,"title":"Bounded","state":"OPEN","links":{"html":{"href":"https://bitbucket.test/78"}},"source":{"branch":{"name":"feature/test"}},"destination":{"branch":{"name":"main"}}}"#;
        let mut server = spawn_http_server(vec![(200, body.to_owned())]).await;
        let service = bitbucket_service(
            &server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
        )
        .with_bitbucket_limits_for_test(Duration::from_secs(5), 1024);
        let response = service
            .client
            .get(format!("{}/bounded", server.base_url))
            .send()
            .await
            .expect("receive bounded response");
        let decoded = service
            .decode_bitbucket_response::<BitbucketPullRequest>(
                response,
                Path::new("bounded-repository"),
                "resolvePullRequest",
                Some("78"),
                &CancellationToken::new(),
            )
            .await
            .expect("bounded valid response");
        assert_eq!(decoded.id, 78);
        server.requests.recv().await.expect("bounded request");
        server.task.await.expect("bounded server task");
    }

    #[tokio::test]
    async fn bitbucket_errors_map_credentials_http_status_and_invalid_json() {
        let _fixture_permit = acquire_pull_request_fixture().await;

        let repository = bitbucket_repository().await;
        let cancellation = CancellationToken::new();
        let error = bitbucket_service_for_repository("http://127.0.0.1:1/2.0", None, &repository)
            .resolve(
                ResolvePullRequestInput {
                    cwd: repository.root().to_path_buf(),
                    provider: ProviderKind::Bitbucket,
                    reference: "5".into(),
                },
                &cancellation,
            )
            .await
            .expect_err("missing Bitbucket credentials");
        assert!(error.detail.contains("BIBCODE_BITBUCKET_ACCESS_TOKEN"));

        let oversized_detail = "x".repeat(2_100);
        let status_server = spawn_http_server(vec![(503, oversized_detail)]).await;
        let error = bitbucket_service_for_repository(
            &status_server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
            &repository,
        )
        .resolve(
            ResolvePullRequestInput {
                cwd: repository.root().to_path_buf(),
                provider: ProviderKind::Bitbucket,
                reference: "6".into(),
            },
            &cancellation,
        )
        .await
        .expect_err("Bitbucket HTTP status error");
        assert!(error.detail.starts_with("Bitbucket returned HTTP 503"));
        assert_eq!(error.detail.matches('x').count(), 2_000);
        status_server.task.await.expect("status server task");

        let invalid_json_server = spawn_http_server(vec![(200, "not-json".into())]).await;
        let error = bitbucket_service_for_repository(
            &invalid_json_server.base_url,
            Some(BitbucketCredentials::Bearer("test-token".into())),
            &repository,
        )
        .resolve(
            ResolvePullRequestInput {
                cwd: repository.root().to_path_buf(),
                provider: ProviderKind::Bitbucket,
                reference: "7".into(),
            },
            &cancellation,
        )
        .await
        .expect_err("Bitbucket invalid JSON error");
        assert!(error.detail.starts_with("Bitbucket returned invalid JSON:"));
        invalid_json_server.task.await.expect("JSON server task");
    }

    #[tokio::test]
    async fn unknown_provider_rejects_resolution_and_creation_with_structured_errors() {
        let service = PullRequestService::default();
        let cancellation = CancellationToken::new();
        let cwd = PathBuf::from("unknown-provider-repository");
        let resolve_error = service
            .resolve(
                ResolvePullRequestInput {
                    cwd: cwd.clone(),
                    provider: ProviderKind::Unknown,
                    reference: "change-9".into(),
                },
                &cancellation,
            )
            .await
            .expect_err("unsupported resolution");
        assert_eq!(resolve_error.command, None);
        assert_eq!(resolve_error.reference.as_deref(), Some("change-9"));
        assert!(resolve_error.to_string().contains("resolvePullRequest"));

        let create_error = service
            .create(
                CreatePullRequestInput {
                    cwd,
                    provider: ProviderKind::Unknown,
                    base_branch: "main".into(),
                    head_branch: "feature/unknown".into(),
                    title: "Unknown provider".into(),
                    body: String::new(),
                },
                &cancellation,
            )
            .await
            .expect_err("unsupported creation");
        assert_eq!(create_error.operation.as_ref(), "createPullRequest");
        assert_eq!(create_error.reference.as_deref(), Some("feature/unknown"));
        assert_eq!(
            serde_json::to_value(&create_error).expect("serialize provider error")["_tag"],
            "SourceControlProviderError"
        );
    }

    #[test]
    fn normalizes_bitbucket_pull_request_payloads() {
        let raw = r#"{"id":19,"title":"Native source control","state":"OPEN","links":{"html":{"href":"https://bitbucket.org/example/repo/pull-requests/19"}},"source":{"branch":{"name":"feature/native"}},"destination":{"branch":{"name":"main"}}}"#;
        let parsed = normalize_bitbucket_pull_request(
            serde_json::from_str(raw).expect("Bitbucket pull request JSON"),
        )
        .expect("Bitbucket pull request");
        assert_eq!(parsed.number, 19);
        assert_eq!(parsed.base_branch, "main");
        assert_eq!(parsed.head_branch, "feature/native");
        assert_eq!(parsed.state, ChangeRequestState::Open);
    }
}
