//! Host failures have stable codes and server-authored, credential-free messages.

use serde::Serialize;

use crate::git::ProcessError;

pub const CODES: &[&str] = &[
    "not_authenticated",
    "not_found",
    "forbidden",
    "rate_limited",
    "cli_missing",
    "cli_too_old",
    "host_version_too_old",
    "timeout",
    "host_unreachable",
    "stale_head",
    "unavailable",
    "invalid_request",
    "invalid_response",
    "output_limit",
    "blocked",
    "host_rejected",
];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestsOperationError {
    #[serde(rename = "_tag")]
    pub tag: &'static str,
    pub operation: String,
    pub code: &'static str,
    pub message: String,
    pub host_detail: Option<String>,
    pub retryable: bool,
}

impl PullRequestsOperationError {
    #[must_use]
    pub fn new(operation: &str, code: &'static str) -> Self {
        let message = match code {
            "not_authenticated" => "Authenticate the provider CLI for this host, then rescan.",
            "not_found" => "The requested repository or pull request could not be found.",
            "forbidden" => "This account does not have permission for this operation.",
            "rate_limited" => "The host rate limit was reached. Try again later.",
            "cli_missing" => "The provider CLI is not installed on this environment.",
            "cli_too_old" => "Update the provider CLI on this environment, then rescan.",
            "host_version_too_old" => "This host version does not support the operation.",
            "timeout" => "The operation timed out or was cancelled. Try again.",
            "host_unreachable" => "The host could not be reached. Check the connection and retry.",
            "stale_head" => "The head commit changed. Refresh before trying again.",
            "unavailable" => "Not implemented in this server build.",
            "invalid_request" => "The Pull Requests request is invalid.",
            "invalid_response" => "The host returned an invalid response. Refresh and try again.",
            "output_limit" => "The host response is too large. Open the repository on the host.",
            "blocked" => "The operation is blocked by the current workspace state.",
            _ => "The host rejected this operation.",
        };
        Self {
            tag: "PullRequestsOperationError",
            operation: operation.into(),
            code,
            message: message.into(),
            host_detail: None,
            retryable: matches!(code, "timeout" | "rate_limited" | "host_unreachable"),
        }
    }
}

pub fn from_process_error(
    operation: &str,
    cli: &str,
    error: &ProcessError,
    stderr: &str,
) -> PullRequestsOperationError {
    let code = match error {
        ProcessError::Spawn { source, .. } if source.kind() == std::io::ErrorKind::NotFound => {
            "cli_missing"
        }
        ProcessError::Timeout { .. } | ProcessError::Cancelled { .. } => "timeout",
        ProcessError::OutputLimit { .. } => "output_limit",
        ProcessError::NonZeroExit { .. } => classify_stderr(stderr),
        _ => "host_rejected",
    };
    let mut result = PullRequestsOperationError::new(operation, code);
    if code == "cli_missing" {
        result.message = format!("`{cli}` is not installed on this environment");
    }
    // Inspect all stderr before retaining even its first line: credentials may
    // appear beyond the truncation boundary or on a following line.
    let lower = stderr.to_lowercase();
    if !["token", "ghp_", "glpat-", "bearer"]
        .iter()
        .any(|part| lower.contains(part))
    {
        result.host_detail = stderr
            .lines()
            .next()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| line.chars().take(240).collect());
    }
    result
}

fn classify_stderr(stderr: &str) -> &'static str {
    let lower = stderr.to_lowercase();
    for (needles, code) in [
        (
            &["not logged in", "authentication", "401"][..],
            "not_authenticated",
        ),
        (&["rate limit", "429"][..], "rate_limited"),
        (&["could not resolve", "404", "not found"][..], "not_found"),
        (&["403", "forbidden", "permission"][..], "forbidden"),
        (
            &["head sha", "expected head", "sha does not match", "stale"][..],
            "stale_head",
        ),
        (&["unknown flag", "unknown command"][..], "cli_too_old"),
        (
            &["dial tcp", "no such host", "connection refused", "timeout"][..],
            "host_unreachable",
        ),
    ] {
        if needles.iter().any(|needle| lower.contains(needle)) {
            return code;
        }
    }
    "host_rejected"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::ProcessError;

    fn exited(stderr: &str) -> ProcessError {
        ProcessError::NonZeroExit {
            operation: "list".into(),
            exit_code: 1,
            stdout_length: 0,
            stderr_length: stderr.len(),
            stdout: "".into(),
            stderr: stderr.into(),
        }
    }

    macro_rules! classification {
        ($name:ident, $stderr:expr, $code:expr, $retryable:expr) => {
            #[test]
            fn $name() {
                let error = from_process_error("list", "gh", &exited($stderr), $stderr);
                assert_eq!(error.code, $code);
                assert_eq!(error.retryable, $retryable);
                assert_ne!(error.message, $stderr);
                assert_eq!(error.host_detail.as_deref(), Some($stderr));
            }
        };
    }

    classification!(
        not_authenticated,
        "You are not logged into any GitHub hosts",
        "not_authenticated",
        false
    );
    classification!(
        not_found,
        "Could not resolve to a PullRequest",
        "not_found",
        false
    );
    classification!(forbidden, "HTTP 403", "forbidden", false);
    classification!(
        rate_limited,
        "API rate limit exceeded (HTTP 403)",
        "rate_limited",
        true
    );
    classification!(stale_head, "head sha does not match", "stale_head", false);
    classification!(cli_too_old, "unknown flag: --json", "cli_too_old", false);
    classification!(
        host_unreachable,
        "dial tcp: connection refused",
        "host_unreachable",
        true
    );
    classification!(host_rejected, "not mergeable", "host_rejected", false);

    #[test]
    fn cli_missing() {
        let error = ProcessError::Spawn {
            operation: "context".into(),
            command: "gh".into(),
            source: std::io::ErrorKind::NotFound.into(),
        };
        let error = from_process_error("context", "gh", &error, "");
        assert_eq!(error.code, "cli_missing");
        assert_eq!(error.message, "`gh` is not installed on this environment");
    }

    #[test]
    fn timeout_and_cancellation() {
        for error in [
            ProcessError::Timeout {
                operation: "list".into(),
                timeout_ms: 30_000,
            },
            ProcessError::Cancelled {
                operation: "list".into(),
            },
        ] {
            let error = from_process_error("list", "glab", &error, "");
            assert_eq!(error.code, "timeout");
            assert!(error.retryable);
        }
    }

    #[test]
    fn output_limit() {
        let error = ProcessError::OutputLimit {
            operation: "list".into(),
            stream: "stdout",
            max_bytes: 1024,
            observed_bytes: 1025,
        };
        assert_eq!(
            from_process_error("list", "gh", &error, "").code,
            "output_limit"
        );
    }

    macro_rules! authored {
        ($name:ident, $code:expr) => {
            #[test]
            fn $name() {
                let error = PullRequestsOperationError::new("get", $code);
                assert_eq!(error.code, $code);
                assert!(!error.message.is_empty());
                let value = serde_json::to_value(error).unwrap();
                assert_eq!(value["_tag"], "PullRequestsOperationError");
                assert!(value["hostDetail"].is_null());
                assert_eq!(value["retryable"], false);
            }
        };
    }
    authored!(host_version_too_old, "host_version_too_old");
    authored!(unavailable, "unavailable");
    authored!(invalid_response, "invalid_response");
    authored!(blocked, "blocked");

    #[test]
    fn host_detail_redacts_tokens_and_bounds_unicode() {
        for stderr in [
            "HTTP 401 token SECRET",
            "ghp_secret",
            "GLPAT-secret",
            "Bearer secret",
            "safe line\nTOKEN secret",
        ] {
            assert!(
                from_process_error("list", "gh", &exited(stderr), stderr)
                    .host_detail
                    .is_none()
            );
        }
        let stderr = format!("  {}  \nother", "é".repeat(300));
        let error = from_process_error("list", "gh", &exited(&stderr), &stderr);
        assert_eq!(error.host_detail.unwrap(), "é".repeat(240));
    }

    #[test]
    fn taxonomy_and_precedence_are_stable() {
        assert_eq!(CODES.len(), 16);
        for (stderr, code) in [
            ("401 429", "not_authenticated"),
            ("429 404", "rate_limited"),
            ("404 forbidden", "not_found"),
            ("permission stale", "forbidden"),
            ("stale unknown flag", "stale_head"),
            ("unknown command timeout", "cli_too_old"),
            ("no such host", "host_unreachable"),
        ] {
            assert_eq!(
                from_process_error("list", "gh", &exited(stderr), stderr).code,
                code
            );
        }
    }
}
