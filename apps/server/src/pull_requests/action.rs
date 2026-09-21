//! Shared validation and error handling for review mutations.
use super::{
    error::{PullRequestsOperationError, from_process_error},
    model::{ActionRequest, FailedComment, ReviewComment},
};
use serde_json::Value;

pub(super) const OP: &str = "pullRequests.runAction";

pub(super) fn validate(request: &ActionRequest) -> Result<(), PullRequestsOperationError> {
    let target = request.target();
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if target.cwd.trim().is_empty() || target.number == 0 || target.number > MAX_SAFE_INTEGER {
        return Err(invalid_request());
    }
    if let ActionRequest::Merge { head_sha, .. } = request
        && head_sha.trim().is_empty()
    {
        return Err(invalid_request());
    }
    if let ActionRequest::SubmitReview {
        head_sha, comments, ..
    } = request
        && (head_sha.trim().is_empty()
            || comments.iter().any(|comment| {
                comment.path.trim().is_empty()
                    || comment.line == 0
                    || comment.line > MAX_SAFE_INTEGER
                    || comment
                        .start_line
                        .is_some_and(|start| start == 0 || start > comment.line)
            }))
    {
        return Err(invalid_request());
    }
    Ok(())
}

pub(super) fn invalid_request() -> PullRequestsOperationError {
    let mut error = PullRequestsOperationError::new(OP, "host_rejected");
    error.message = "The Pull Requests request is invalid.".into();
    error
}

pub(super) fn unavailable(reason: &str) -> PullRequestsOperationError {
    let mut error = PullRequestsOperationError::new(OP, "unavailable");
    error.message = reason.into();
    error
}

pub(super) fn numeric_id(value: &str) -> Result<u64, PullRequestsOperationError> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid_request());
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(invalid_request)
}

pub(super) fn failed_comment(
    comment: &ReviewComment,
    error: &PullRequestsOperationError,
) -> FailedComment {
    FailedComment {
        path: comment.path.clone(),
        line: comment.line,
        body: comment.body.clone(),
        message: error
            .host_detail
            .clone()
            .unwrap_or_else(|| error.message.clone()),
    }
}

pub(super) fn graphql_payload<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a Value, PullRequestsOperationError> {
    for errors in [&value["errors"], &value["data"][field]["errors"]] {
        if let Some(errors) = errors.as_array().filter(|errors| !errors.is_empty()) {
            let sentence = errors
                .iter()
                .filter_map(|e| e.as_str().or_else(|| e["message"].as_str()))
                .collect::<Vec<_>>()
                .join("; ");
            // Reuse the common credential scrubber and bounded host-detail policy.
            let process_error = crate::git::ProcessError::NonZeroExit {
                operation: OP.into(),
                exit_code: 1,
                stdout_length: 0,
                stderr_length: sentence.len(),
                stdout: "".into(),
                stderr: sentence.clone().into(),
            };
            let mut error = from_process_error(OP, "api", &process_error, &sentence);
            error.code = "host_rejected";
            error.retryable = false;
            return Err(error);
        }
    }
    value["data"]
        .get(field)
        .filter(|p| p.is_object())
        .ok_or_else(|| PullRequestsOperationError::new(OP, "invalid_response"))
}
