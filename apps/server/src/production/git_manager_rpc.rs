//! Registers the Git Manager RPC contract surface.

use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    git::{
        GitCommandError, GitRepository, ProcessOutput,
        manager::{
            graph::{
                GitManagerGraphError, MAX_DIFF_BUFFER_SIZE, MAX_DIFF_LINE_CHARACTERS,
                MAX_REASONABLE_DIFF_SIZE, page,
            },
            refs::{GitManagerRefsError, build_refs_snapshot},
        },
        validate_pathspecs,
    },
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk},
};

static NEXT_DIFF_GENERATION: AtomicU64 = AtomicU64::new(1);

pub const GIT_MANAGER_UNARY_METHODS: &[&str] = &[
    "gitManager.commit",
    "gitManager.discard",
    "gitManager.discardPartial",
    "gitManager.getCommits",
    "gitManager.getDiff",
    "gitManager.getRefs",
    "gitManager.getStashes",
    "gitManager.listPullRequests",
    "gitManager.previewMerge",
    "gitManager.stagePartial",
    "gitManager.undoCommit",
    "gitManager.unstagePartial",
];

pub const GIT_MANAGER_STREAM_METHODS: &[&str] =
    &["gitManager.runOperation", "subscribeGitManagerSignal"];

#[derive(Clone, Copy, Debug, Default)]
pub struct GitManagerRpcServices;

impl GitManagerRpcServices {
    async fn not_implemented_unary(self, request: RpcRequest) -> RpcResult {
        Err(not_implemented_error(&request.tag))
    }

    fn not_implemented_stream(self, request: RpcRequest) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(1);
        sender
            .try_send(Err(not_implemented_error(&request.tag)))
            .expect("new Git Manager stub stream accepts its terminal failure");
        receiver
    }

    async fn handle_read_unary(
        self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> RpcResult {
        let repository = GitRepository::default();
        match request.tag.as_str() {
            "gitManager.getRefs" => {
                let input: GitManagerCwdInput = decode(request.payload, &request.tag)?;
                encode_result(
                    build_refs_snapshot(&repository, &input.cwd, &cancellation)
                        .await
                        .map_err(|error| refs_error(&request.tag, error)),
                )
            }
            "gitManager.getCommits" => {
                let input: GitManagerGetCommitsInput = decode(request.payload, &request.tag)?;
                encode_result(
                    page(
                        &repository,
                        &input.cwd,
                        input.pinned_tips.as_deref(),
                        input.offset.unwrap_or(0),
                        input.limit.unwrap_or(100),
                        &cancellation,
                    )
                    .await
                    .map_err(|error| graph_error(&request.tag, error)),
                )
            }
            "gitManager.getDiff" => {
                let input: GitManagerGetDiffInput = decode(request.payload, &request.tag)?;
                get_diff(&repository, input, &cancellation).await
            }
            _ => self.not_implemented_unary(request).await,
        }
    }
}

pub fn register_git_manager_rpc(registry: &mut RpcRegistry, services: GitManagerRpcServices) {
    for method in GIT_MANAGER_UNARY_METHODS.iter().filter(|method| {
        !matches!(
            **method,
            "gitManager.getRefs" | "gitManager.getCommits" | "gitManager.getDiff"
        )
    }) {
        registry.register_unary(*method, move |request, _cancellation| {
            services.not_implemented_unary(request)
        });
    }
    for method in [
        "gitManager.getRefs",
        "gitManager.getCommits",
        "gitManager.getDiff",
    ] {
        registry.register_unary(method, move |request, cancellation| {
            services.handle_read_unary(request, cancellation)
        });
    }

    for method in GIT_MANAGER_STREAM_METHODS {
        registry.register_stream(*method, move |request, _cancellation| {
            services.not_implemented_stream(request)
        });
    }
}

#[derive(Deserialize)]
struct GitManagerCwdInput {
    cwd: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitManagerGetCommitsInput {
    cwd: PathBuf,
    pinned_tips: Option<Vec<String>>,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "_tag", rename_all = "kebab-case")]
enum GitManagerDiffSource {
    WorkingTree { path: String, staged: bool },
    Commit { sha: String, path: String },
    Stash { sha: String, path: String },
}

impl GitManagerDiffSource {
    fn path(&self) -> &str {
        match self {
            Self::WorkingTree { path, .. }
            | Self::Commit { path, .. }
            | Self::Stash { path, .. } => path,
        }
    }
}

#[derive(Deserialize)]
struct GitManagerGetDiffInput {
    cwd: PathBuf,
    source: GitManagerDiffSource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DiffSizeClass {
    Patch,
    LargeText,
    Unrenderable,
}

async fn get_diff(
    repository: &GitRepository,
    input: GitManagerGetDiffInput,
    cancellation: &CancellationToken,
) -> RpcResult {
    let operation = "gitManager.getDiff";
    validate_pathspecs(
        "GitManager.getDiff",
        &input.cwd,
        &[input.source.path().to_owned()],
    )
    .map_err(|_| {
        operation_error(
            operation,
            "invalid-path",
            "The requested diff path is invalid.",
        )
    })?;
    let output = match &input.source {
        GitManagerDiffSource::WorkingTree { path, staged } => {
            let mut output = repository
                .git_manager_working_tree_diff(&input.cwd, path, *staged, cancellation)
                .await
                .map_err(|error| git_error(operation, error))?;
            if output.stdout.is_empty() && !*staged {
                let untracked = repository
                    .git_manager_untracked_paths(&input.cwd, path, cancellation)
                    .await
                    .map_err(|error| git_error(operation, error))?;
                if !untracked.stdout.is_empty() {
                    output = repository
                        .git_manager_untracked_diff(&input.cwd, path, cancellation)
                        .await
                        .map_err(|error| git_error(operation, error))?;
                    if !matches!(output.exit_code, 0 | 1) {
                        return Err(operation_error(
                            operation,
                            "git-command-failed",
                            "Git could not read the untracked file diff.",
                        ));
                    }
                }
            }
            output
        }
        GitManagerDiffSource::Commit { sha, path } => {
            if !valid_object_id(sha) {
                return Err(operation_error(
                    operation,
                    "invalid-commit",
                    "The requested commit identifier is invalid.",
                ));
            }
            repository
                .git_manager_commit_diff(&input.cwd, sha, path, cancellation)
                .await
                .map_err(|error| git_error(operation, error))?
        }
        GitManagerDiffSource::Stash { .. } => {
            return Err(operation_error(
                operation,
                "not-implemented-yet",
                "Stash diffs are not implemented until Git Manager PHASE-09.",
            ));
        }
    };
    Ok(render_diff(input.source, output))
}

fn render_diff(source: GitManagerDiffSource, output: ProcessOutput) -> Value {
    let truncated = output.stdout_truncated;
    let byte_length = if truncated {
        MAX_DIFF_BUFFER_SIZE + 1
    } else {
        output.stdout.len()
    };
    let longest_line_length = if byte_length <= MAX_REASONABLE_DIFF_SIZE {
        output
            .stdout
            .lines()
            .map(|line| line.chars().count())
            .max()
            .unwrap_or(0)
    } else {
        0
    };
    let metadata = json!({
        "generation": NEXT_DIFF_GENERATION.fetch_add(1, Ordering::Relaxed),
        "source": source,
        "byteLength": byte_length,
        "longestLineLength": longest_line_length,
    });
    let mut value = match classify_diff_size(byte_length, longest_line_length, truncated) {
        DiffSizeClass::Patch => json!({
            "_tag": "patch",
            "patch": output.stdout,
        }),
        DiffSizeClass::LargeText => json!({ "_tag": "large-text" }),
        DiffSizeClass::Unrenderable => json!({ "_tag": "unrenderable" }),
    };
    if let (Some(value), Some(metadata)) = (value.as_object_mut(), metadata.as_object()) {
        value.extend(metadata.clone());
    }
    value
}

fn classify_diff_size(
    byte_length: usize,
    longest_line_length: usize,
    truncated: bool,
) -> DiffSizeClass {
    if truncated || byte_length > MAX_DIFF_BUFFER_SIZE {
        DiffSizeClass::Unrenderable
    } else if byte_length > MAX_REASONABLE_DIFF_SIZE
        || longest_line_length > MAX_DIFF_LINE_CHARACTERS
    {
        DiffSizeClass::LargeText
    } else {
        DiffSizeClass::Patch
    }
}

fn valid_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn decode<T: for<'de> Deserialize<'de>>(payload: Value, operation: &str) -> Result<T, Value> {
    serde_json::from_value(payload).map_err(|_| {
        operation_error(
            operation,
            "invalid-request",
            "The Git Manager request is invalid.",
        )
    })
}

fn encode_result<T: Serialize>(result: Result<T, Value>) -> RpcResult {
    result.and_then(|value| {
        serde_json::to_value(value).map_err(|_| {
            operation_error(
                "gitManager.read",
                "serialization-failed",
                "The Git Manager result could not be encoded.",
            )
        })
    })
}

fn refs_error(operation: &str, error: GitManagerRefsError) -> Value {
    match error {
        GitManagerRefsError::Git(error) => git_error(operation, error),
        GitManagerRefsError::MalformedRefs | GitManagerRefsError::Worktrees(_) => operation_error(
            operation,
            "malformed-git-output",
            "Git returned malformed repository ref state.",
        ),
        GitManagerRefsError::RepositoryState(_) => operation_error(
            operation,
            "repository-state-unavailable",
            "Git repository operation state could not be inspected.",
        ),
    }
}

fn graph_error(operation: &str, error: GitManagerGraphError) -> Value {
    match error {
        GitManagerGraphError::TipsUnresolvable => operation_error(
            operation,
            "history-tips-unresolvable",
            "The pinned history snapshot is no longer available; refresh the history.",
        ),
        GitManagerGraphError::MalformedHistory => operation_error(
            operation,
            "malformed-git-output",
            "Git returned malformed commit history.",
        ),
        GitManagerGraphError::Git(error) => git_error(operation, error),
    }
}

fn git_error(operation: &str, _error: GitCommandError) -> Value {
    operation_error(
        operation,
        "git-command-failed",
        "Git could not complete the requested read.",
    )
}

fn operation_error(operation: &str, code: &str, message: &str) -> Value {
    json!({
        "_tag": "GitManagerOperationError",
        "operation": operation,
        "code": code,
        "message": message,
        "blocked": null,
    })
}

fn not_implemented_error(operation: &str) -> Value {
    json!({
        "_tag": "GitManagerOperationError",
        "operation": operation,
        "code": "not-implemented",
        "message": "This Git Manager operation is not implemented yet.",
        "blocked": null,
    })
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, process::Command};

    use tempfile::TempDir;

    use super::*;
    use crate::rpc::{ACTIVE_RPC_METHODS, MethodMode, RequestId};

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git test fixture starts");
        assert!(
            output.status.success(),
            "git fixture command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repository_with_change() -> TempDir {
        let repository = TempDir::new().expect("temporary repository");
        git(repository.path(), &["init", "-q", "-b", "main"]);
        git(
            repository.path(),
            &["config", "user.name", "Git Manager Test"],
        );
        git(
            repository.path(),
            &["config", "user.email", "git-manager@example.test"],
        );
        fs::write(repository.path().join("tracked.txt"), "base\n").expect("base file");
        git(repository.path(), &["add", "tracked.txt"]);
        git(repository.path(), &["commit", "-q", "-m", "base"]);
        fs::write(repository.path().join("tracked.txt"), "changed\n").expect("changed file");
        repository
    }

    fn request(tag: &str, payload: Value) -> RpcRequest {
        RpcRequest {
            id: RequestId::try_from("1").expect("request id"),
            tag: tag.to_owned(),
            payload,
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }

    fn registry_with_non_git_manager_methods() -> RpcRegistry {
        let mut registry = RpcRegistry::empty();
        for method in ACTIVE_RPC_METHODS
            .iter()
            .filter(|method| !method.name.starts_with("gitManager."))
            .filter(|method| method.name != "subscribeGitManagerSignal")
        {
            match method.mode {
                MethodMode::Unary => registry
                    .register_unary(method.name, |_request, _cancellation| async {
                        Ok(json!({}))
                    }),
                MethodMode::Stream => {
                    registry.register_stream(method.name, |_request, _cancellation| {
                        let (_sender, receiver) = mpsc::channel(1);
                        receiver
                    });
                }
            }
        }
        registry
    }

    #[test]
    fn registers_every_git_manager_method_needed_by_production_startup() {
        let mut registry = registry_with_non_git_manager_methods();
        register_git_manager_rpc(&mut registry, GitManagerRpcServices);
        registry
            .validate_complete()
            .expect("the production Git Manager registry is complete");
    }

    #[test]
    fn registry_validation_fails_when_git_manager_registration_is_omitted() {
        let registry = registry_with_non_git_manager_methods();
        let error = registry
            .validate_complete()
            .expect_err("Git Manager methods are required at startup");
        assert!(error.contains("gitManager.commit"));
        assert!(error.contains("subscribeGitManagerSignal"));
    }

    #[test]
    fn diff_size_ladder_uses_the_server_side_contract_boundaries() {
        assert_eq!(
            classify_diff_size(MAX_REASONABLE_DIFF_SIZE, 5_000, false),
            DiffSizeClass::Patch
        );
        assert_eq!(
            classify_diff_size(MAX_REASONABLE_DIFF_SIZE + 1, 0, false),
            DiffSizeClass::LargeText
        );
        assert_eq!(
            classify_diff_size(128, 5_001, false),
            DiffSizeClass::LargeText
        );
        assert_eq!(
            classify_diff_size(MAX_DIFF_BUFFER_SIZE + 1, 0, true),
            DiffSizeClass::Unrenderable
        );
    }

    #[test]
    fn all_three_read_handlers_require_only_the_read_scope() {
        for method in [
            "gitManager.getRefs",
            "gitManager.getCommits",
            "gitManager.getDiff",
        ] {
            assert_eq!(
                crate::auth::required_scope(method),
                Some("orchestration:read")
            );
        }
    }

    #[tokio::test]
    async fn read_handler_returns_working_tree_and_commit_patches() {
        let repository = repository_with_change();
        let cwd = repository.path().to_string_lossy().into_owned();
        let working = GitManagerRpcServices
            .handle_read_unary(
                request(
                    "gitManager.getDiff",
                    json!({
                        "cwd": cwd,
                        "source": {
                            "_tag": "working-tree",
                            "path": "tracked.txt",
                            "staged": false
                        }
                    }),
                ),
                CancellationToken::new(),
            )
            .await
            .expect("working-tree diff");
        assert_eq!(working["_tag"], "patch");
        assert!(
            working["patch"]
                .as_str()
                .is_some_and(|patch| patch.contains("changed"))
        );

        let sha = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repository.path())
            .output()
            .expect("read commit sha");
        let sha = String::from_utf8(sha.stdout)
            .expect("UTF-8 sha")
            .trim()
            .to_owned();
        let commit = GitManagerRpcServices
            .handle_read_unary(
                request(
                    "gitManager.getDiff",
                    json!({
                        "cwd": cwd,
                        "source": { "_tag": "commit", "sha": sha, "path": "tracked.txt" }
                    }),
                ),
                CancellationToken::new(),
            )
            .await
            .expect("commit diff");
        assert_eq!(commit["_tag"], "patch");
        assert!(
            commit["patch"]
                .as_str()
                .is_some_and(|patch| patch.contains("base"))
        );
    }

    #[tokio::test]
    async fn stash_diff_is_a_clear_later_phase_error() {
        let repository = repository_with_change();
        let error = GitManagerRpcServices
            .handle_read_unary(
                request(
                    "gitManager.getDiff",
                    json!({
                        "cwd": repository.path(),
                        "source": {
                            "_tag": "stash",
                            "sha": "0123456789012345678901234567890123456789",
                            "path": "tracked.txt"
                        }
                    }),
                ),
                CancellationToken::new(),
            )
            .await
            .expect_err("stash diff remains deferred");
        assert_eq!(error["_tag"], "GitManagerOperationError");
        assert_eq!(error["code"], "not-implemented-yet");
    }
}
