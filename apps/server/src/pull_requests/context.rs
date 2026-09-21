//! Resolve each explicit read against its origin and the CLI's host configuration.

use std::{io::ErrorKind, path::Path};

use tokio_util::sync::CancellationToken;

use crate::{
    git::ProcessError,
    source_control::{
        ProviderKind, parse_github_auth_status, parse_gitlab_auth_status, provider_from_remote,
        provider_install_hint, remote_host, remote_repository_path,
    },
};

use super::{
    error::{CODES, PullRequestsOperationError, from_process_error},
    host::{HostCommandRunner, HostScope, ProcessFailure, PullRequestHost},
    model::{Context, UnavailableCode},
};

#[derive(Clone, Debug, Default)]
pub struct DiscoveredHosts {
    pub github: Vec<String>,
    pub gitlab: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Unavailable {
    pub code: &'static str,
    pub message: String,
    pub provider: Option<ProviderKind>,
    pub host: Option<String>,
    pub install_hint: Option<String>,
    pub auth_command: Option<String>,
}

impl Unavailable {
    fn new(code: &'static str, message: impl Into<String>, scope: Option<&HostScope>) -> Self {
        Self {
            code,
            message: message.into(),
            provider: scope.map(|s| s.provider),
            host: scope.map(|s| s.host.clone()),
            install_hint: None,
            auth_command: None,
        }
    }

    pub fn operation_error(&self, operation: &str) -> PullRequestsOperationError {
        let mut error = PullRequestsOperationError::new(
            operation,
            if CODES.contains(&self.code) {
                self.code
            } else {
                "unavailable"
            },
        );
        error.message = self.message.clone();
        error
    }

    pub fn into_context(self) -> Result<Context, PullRequestsOperationError> {
        let code = match self.code {
            "no_remote" => UnavailableCode::NoRemote,
            "unsupported_provider" => UnavailableCode::UnsupportedProvider,
            "unknown_host" => UnavailableCode::UnknownHost,
            "cli_missing" => UnavailableCode::CliMissing,
            "not_authenticated" => UnavailableCode::NotAuthenticated,
            "repository_unreachable" => UnavailableCode::RepositoryUnreachable,
            "cli_too_old" => UnavailableCode::CliTooOld,
            _ => return Err(self.operation_error("pullRequests.getContext")),
        };
        Ok(Context::Unavailable {
            code,
            message: self.message,
            provider: self.provider,
            host: self.host,
            install_hint: self.install_hint,
            auth_command: self.auth_command,
        })
    }
}

fn cli(provider: ProviderKind) -> &'static str {
    if provider == ProviderKind::Github {
        "gh"
    } else {
        "glab"
    }
}

fn process_unavailable(
    failure: &ProcessFailure,
    command: &str,
    scope: Option<&HostScope>,
) -> Unavailable {
    let error = from_process_error(
        "pullRequests.getContext",
        command,
        &failure.error,
        &failure.stderr,
    );
    Unavailable::new(error.code, error.message, scope)
}

pub async fn resolve_scope(
    runner: &HostCommandRunner,
    cwd: &Path,
    discovered_hosts: &DiscoveredHosts,
    c: &CancellationToken,
) -> Result<HostScope, Unavailable> {
    validate_checkout(cwd).await?;
    let result = resolve_existing_checkout_scope(runner, cwd, discovered_hosts, c).await;
    // ENOENT may mean the checkout disappeared between commands, not a missing CLI.
    if matches!(&result, Err(unavailable) if unavailable.code == "cli_missing") {
        validate_checkout(cwd).await?;
    }
    result
}

async fn validate_checkout(cwd: &Path) -> Result<(), Unavailable> {
    let (problem, recovery) = match tokio::fs::metadata(cwd).await {
        Ok(metadata) if metadata.is_dir() => return Ok(()),
        Ok(_) => (
            "is not a directory",
            "Select another checkout, then rescan.",
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => (
            "no longer exists",
            "Select another checkout or restore this directory, then rescan.",
        ),
        Err(error) if error.kind() == ErrorKind::NotADirectory => (
            "is not a directory",
            "Select another checkout, then rescan.",
        ),
        Err(_) => (
            "cannot be accessed",
            "Check its availability and permissions, then rescan.",
        ),
    };
    Err(Unavailable::new(
        "repository_unreachable",
        format!(
            "The selected checkout `{}` {problem} on this environment. {recovery}",
            cwd.display()
        ),
        None,
    ))
}

async fn resolve_existing_checkout_scope(
    runner: &HostCommandRunner,
    cwd: &Path,
    discovered_hosts: &DiscoveredHosts,
    c: &CancellationToken,
) -> Result<HostScope, Unavailable> {
    let remote = match runner.git(cwd, &["remote", "get-url", "origin"], c).await {
        Ok(output) => output.stdout.trim().to_owned(),
        Err(failure)
            if matches!(&failure.error, ProcessError::NonZeroExit { .. })
                && (failure.stderr.contains("No such remote")
                    || failure.stderr.contains("not a git repository")) =>
        {
            return Err(Unavailable::new(
                "no_remote",
                "This checkout has no origin remote.",
                None,
            ));
        }
        Err(failure) => return Err(process_unavailable(&failure, "git", None)),
    };
    let Some(host) = remote_host(&remote) else {
        return Err(Unavailable::new(
            "no_remote",
            "This checkout has no hosted origin remote.",
            None,
        ));
    };
    let mut scope = HostScope {
        cwd: cwd.into(),
        host,
        repository: remote_repository_path(&remote).unwrap_or_default(),
        provider: provider_from_remote(&remote).kind,
    };
    if matches!(
        scope.provider,
        ProviderKind::AzureDevops | ProviderKind::Bitbucket
    ) {
        return Err(Unavailable::new(
            "unsupported_provider",
            "Pull Requests supports GitHub and GitLab repositories on this environment.",
            Some(&scope),
        ));
    }
    if scope.repository.is_empty() {
        return Err(Unavailable::new(
            "no_remote",
            "The origin remote has no repository path.",
            Some(&scope),
        ));
    }
    if scope.provider == ProviderKind::Unknown {
        let discovered;
        let hosts = if discovered_hosts.github.is_empty() && discovered_hosts.gitlab.is_empty() {
            discovered = discover_hosts(runner, &scope, c).await?;
            &discovered
        } else {
            discovered_hosts
        };
        scope.provider = if hosts
            .github
            .iter()
            .any(|host| host.eq_ignore_ascii_case(&scope.host))
        {
            ProviderKind::Github
        } else if hosts
            .gitlab
            .iter()
            .any(|host| host.eq_ignore_ascii_case(&scope.host))
        {
            ProviderKind::Gitlab
        } else {
            let mut unavailable = Unavailable::new(
                "unknown_host",
                format!(
                    "`{}` is not a configured GitHub or GitLab host on this environment. Run `gh auth login --hostname {}` or `glab auth login --hostname {}` there, then rescan.",
                    scope.host, scope.host, scope.host
                ),
                Some(&scope),
            );
            let command = if hosts.gitlab.is_empty() {
                "gh"
            } else {
                "glab"
            };
            unavailable.auth_command =
                Some(format!("{command} auth login --hostname {}", scope.host));
            return Err(unavailable);
        };
    }
    ensure_authenticated(runner, &scope, c).await?;
    Ok(scope)
}

async fn discover_hosts(
    runner: &HostCommandRunner,
    scope: &HostScope,
    c: &CancellationToken,
) -> Result<DiscoveredHosts, Unavailable> {
    let mut result = DiscoveredHosts::default();
    for provider in [ProviderKind::Github, ProviderKind::Gitlab] {
        let probe_scope = HostScope {
            provider,
            ..scope.clone()
        };
        let args = if provider == ProviderKind::Github {
            vec!["auth", "status", "--json", "hosts"]
        } else {
            vec!["auth", "status"]
        };
        let output = match runner
            .probe(&probe_scope, &args, c)
            .await
            .or_else(ProcessFailure::into_output)
        {
            Ok(output) => output,
            Err(failure) if c.is_cancelled() => {
                return Err(process_unavailable(&failure, cli(provider), Some(scope)));
            }
            Err(_) => continue,
        };
        if provider == ProviderKind::Github {
            result.github = parse_github_auth_status(&output.stdout)
                .accounts
                .into_iter()
                .map(|account| account.host)
                .collect();
        } else {
            let text = format!("{}\n{}", output.stdout, output.stderr);
            result.gitlab = parse_gitlab_auth_status(&text)
                .into_iter()
                .map(|host| host.host)
                .collect();
        }
    }
    Ok(result)
}

async fn ensure_authenticated(
    runner: &HostCommandRunner,
    scope: &HostScope,
    c: &CancellationToken,
) -> Result<(), Unavailable> {
    if let Err(failure) = runner.probe(scope, &["--version"], c).await {
        let missing = matches!(failure.error, ProcessError::NonZeroExit { .. })
            || matches!(&failure.error, ProcessError::Spawn { source, .. } if source.kind() == std::io::ErrorKind::NotFound);
        if !missing {
            return Err(process_unavailable(
                &failure,
                cli(scope.provider),
                Some(scope),
            ));
        }
        let mut unavailable = Unavailable::new(
            "cli_missing",
            format!(
                "`{}` is not installed on this environment",
                cli(scope.provider)
            ),
            Some(scope),
        );
        unavailable.install_hint = provider_install_hint(scope.provider).map(str::to_owned);
        return Err(unavailable);
    }
    let args = if scope.provider == ProviderKind::Github {
        vec![
            "auth",
            "status",
            "--hostname",
            scope.host.as_str(),
            "--json",
            "hosts",
        ]
    } else {
        vec!["auth", "status", "--hostname", scope.host.as_str()]
    };
    let output = runner
        .probe(scope, &args, c)
        .await
        .or_else(ProcessFailure::into_output)
        .map_err(|failure| process_unavailable(&failure, cli(scope.provider), Some(scope)))?;
    let text = format!("{}\n{}", output.stdout, output.stderr);
    let authenticated = if scope.provider == ProviderKind::Github {
        let status = parse_github_auth_status(&output.stdout);
        status.parsed
            && status.accounts.iter().any(|account| {
                account.host.eq_ignore_ascii_case(&scope.host)
                    && account.active
                    && account.authenticated
            })
    } else {
        gitlab_authenticated(&text, &scope.host)
    };
    if authenticated {
        return Ok(());
    }
    let lower = text.to_lowercase();
    if lower.contains("unknown flag") || lower.contains("unknown command") {
        return Err(Unavailable::new(
            "cli_too_old",
            "Update the provider CLI on this environment, then rescan.",
            Some(scope),
        ));
    }
    let mut unavailable = Unavailable::new(
        "not_authenticated",
        "Authenticate the provider CLI for this host, then rescan.",
        Some(scope),
    );
    unavailable.auth_command = Some(format!(
        "{} auth login --hostname {}",
        cli(scope.provider),
        scope.host
    ));
    Err(unavailable)
}

fn gitlab_authenticated(text: &str, host: &str) -> bool {
    let parsed = parse_gitlab_auth_status(text);
    if !parsed
        .iter()
        .any(|entry| entry.host.eq_ignore_ascii_case(host) && entry.account.is_some())
    {
        return false;
    }
    let mut in_host = false;
    for raw in text.lines() {
        let line = raw.trim();
        if parsed
            .iter()
            .any(|entry| entry.host.eq_ignore_ascii_case(line))
        {
            in_host = line.eq_ignore_ascii_case(host);
        }
        if in_host
            && (line.starts_with("x ")
                || line.starts_with("X ")
                || line.starts_with("✗ ")
                || line.starts_with("× ")
                || line.contains("401"))
        {
            return false;
        }
    }
    true
}

pub async fn build_context(
    host: &dyn PullRequestHost,
    _runner: &HostCommandRunner,
    scope: &HostScope,
    c: &CancellationToken,
) -> Result<Context, PullRequestsOperationError> {
    let context = match host.context(scope, c).await {
        Ok(context) => context,
        Err(error) if matches!(error.code, "not_found" | "forbidden") => {
            return Unavailable::new("repository_unreachable", "This repository cannot be reached with the authenticated account. Check repository access, then rescan.", Some(scope)).into_context();
        }
        Err(error)
            if matches!(
                error.code,
                "cli_too_old" | "not_authenticated" | "cli_missing"
            ) =>
        {
            if error.code == "cli_missing"
                && let Err(unavailable) = validate_checkout(&scope.cwd).await
            {
                return unavailable.into_context();
            }
            let mut unavailable = Unavailable::new(error.code, error.message, Some(scope));
            if error.code == "not_authenticated" {
                unavailable.auth_command = Some(format!(
                    "{} auth login --hostname {}",
                    cli(scope.provider),
                    scope.host
                ));
            }
            if error.code == "cli_missing" {
                unavailable.install_hint = provider_install_hint(scope.provider).map(str::to_owned);
            }
            return unavailable.into_context();
        }
        Err(error) => return Err(error),
    };
    let capabilities = host.capabilities(context.version().as_ref());
    Ok(Context::Available {
        provider: context.provider,
        host: context.host,
        host_version: context.host_version,
        repository: context.repository,
        default_branch: context.default_branch,
        account: context.account,
        repository_permission: context.repository_permission,
        merge_policy: context.merge_policy,
        capabilities: Box::new(capabilities),
        web_url: context.web_url,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::test_support::TestSandbox;

    const GH: &str = r#"case "$1 $2" in
      '--version ') echo 'gh version 2.97.0' ;;
      'auth status') echo '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"mubeda"}]}}' ;;
      *) exit 64 ;;
    esac"#;
    const GLAB: &str = r#"case "$1 $2" in
      '--version ') echo 'glab 1.114.0' ;;
      'auth status') printf 'gitlab.com\n  x HTTP 401\ngit.acme.example\n  ✓ Logged in to git.acme.example as alice\n' ;;
      *) exit 64 ;;
    esac"#;

    fn runner(s: &TestSandbox, remote: Option<&str>, gh: &str, glab: &str) -> HostCommandRunner {
        let git = s.executable_script(
            "git",
            &remote.map_or_else(
                || "echo \"error: No such remote 'origin'\" >&2; exit 2".into(),
                |r| format!("printf '%s' '{r}'"),
            ),
            "",
        );
        let gh = s.executable_script("gh", gh, "");
        let glab = s.executable_script("glab", glab, "");
        HostCommandRunner::new(s.path("state")).with_commands(gh, glab, git)
    }

    #[tokio::test]
    async fn pull_requests_resolves_known_and_discovered_hosts() {
        for (remote, provider, host, repository) in [
            (
                "https://github.com/example/repository.git",
                ProviderKind::Github,
                "github.com",
                "example/repository",
            ),
            (
                "ssh://git@git.acme.example/team/sub/repo.git",
                ProviderKind::Gitlab,
                "git.acme.example",
                "team/sub/repo",
            ),
        ] {
            let s = TestSandbox::new("pr-scope");
            let runner = runner(&s, Some(remote), GH, GLAB);
            let scope = resolve_scope(
                &runner,
                s.root(),
                &DiscoveredHosts::default(),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(scope.provider, provider);
            assert_eq!(scope.host, host);
            assert_eq!(scope.repository, repository);
        }
    }

    #[tokio::test]
    async fn pull_requests_scope_reports_no_remote_unsupported_and_unknown() {
        for (remote, code) in [
            (None, "no_remote"),
            (
                Some("https://dev.azure.com/org/repo"),
                "unsupported_provider",
            ),
            (
                Some("git@bitbucket.org:team/repo.git"),
                "unsupported_provider",
            ),
            (
                Some("ssh://git@git.acme.example/team/sub/repo.git"),
                "unknown_host",
            ),
        ] {
            let s = TestSandbox::new("pr-unavailable");
            let runner = runner(&s, remote, GH, "printf 'gitlab.com\\n  x HTTP 401\\n'");
            let unavailable = resolve_scope(
                &runner,
                s.root(),
                &DiscoveredHosts::default(),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(unavailable.code, code);
            if code == "unknown_host" {
                assert_eq!(
                    unavailable.auth_command.as_deref(),
                    Some("glab auth login --hostname git.acme.example")
                );
            }
            assert!(matches!(
                unavailable.into_context().unwrap(),
                Context::Unavailable { .. }
            ));
        }
    }

    #[tokio::test]
    async fn pull_requests_auth_failures_and_install_hints_are_actionable() {
        for (gh, code) in [
            (
                "if [ \"$1\" = --version ]; then exit 0; fi; echo 'You are not logged into any GitHub hosts' >&2; exit 1",
                "not_authenticated",
            ),
            ("exit 1", "cli_missing"),
            (
                "if [ \"$1\" = --version ]; then exit 0; fi; echo 'unknown flag: --json' >&2; exit 1",
                "cli_too_old",
            ),
        ] {
            let s = TestSandbox::new("pr-auth");
            let runner = runner(
                &s,
                Some("https://github.com/example/repository.git"),
                gh,
                GLAB,
            );
            let u = resolve_scope(
                &runner,
                s.root(),
                &DiscoveredHosts::default(),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(u.code, code);
            if code == "cli_missing" {
                assert_eq!(
                    u.install_hint.as_deref(),
                    Some("Install GitHub CLI from https://cli.github.com/.")
                );
            }
            if code == "not_authenticated" {
                assert_eq!(
                    u.auth_command.as_deref(),
                    Some("gh auth login --hostname github.com")
                );
            }
        }
    }

    #[test]
    fn pull_requests_gitlab_auth_checks_only_the_requested_host_block() {
        let text = "gitlab.com\n  x HTTP 401\ngit.acme.example\n  ✓ Logged in to git.acme.example as alice\n";
        assert!(gitlab_authenticated(text, "git.acme.example"));
        assert!(!gitlab_authenticated(text, "gitlab.com"));
        assert!(!gitlab_authenticated(
            "git.acme.example\n  Logged in to git.acme.example as alice\n  x Invalid credentials\n",
            "git.acme.example"
        ));
    }

    #[tokio::test]
    async fn pull_requests_cancelled_scope_is_a_typed_process_error() {
        let s = TestSandbox::new("pr-cancel");
        let runner = runner(
            &s,
            Some("https://github.com/example/repository.git"),
            GH,
            GLAB,
        );
        let c = CancellationToken::new();
        c.cancel();
        let u = resolve_scope(&runner, s.root(), &DiscoveredHosts::default(), &c)
            .await
            .unwrap_err();
        assert_eq!(u.into_context().unwrap_err().code, "timeout");
    }
}
