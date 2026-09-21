//! Guarded checkout and managed worktree creation for hosted pull requests.
use super::{
    PullRequestsService, bounded_read,
    context::{DiscoveredHosts, resolve_scope},
    error::{PullRequestsOperationError, from_process_error},
    host::{Budget, CommandOutput, HostCommandRunner, HostScope, ProcessFailure},
};
use crate::{
    git::{
        canonical_worktree_path_key, host_path_platform,
        manager::{
            guards::{GuardInput, GuardedRef, Occupancy, evaluate_guards},
            in_progress::detect_in_progress_operation,
            refs::{
                GitManagerBlockedReason, GitManagerRefEntry, GitManagerRefsSnapshot,
                GitManagerWorktreeEntry, build_refs_snapshot,
            },
        },
        worktree_repository_key,
    },
    persistence::Repositories,
    production::{
        git_manager_rpc::resolve_project_id, worktree_catalog_rpc::WorktreeCatalogRpcServices,
    },
    source_control::ProviderKind,
    worktree_catalog::{CatalogRefreshTrigger, CatalogScanStatus, ProjectMutationAttempt},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub(crate) const OP: &str = "pullRequests.checkout";
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckoutInput {
    pub cwd: PathBuf,
    pub number: u64,
    pub target: CheckoutTarget,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum CheckoutTarget {
    Checkout {
        cwd: PathBuf,
    },
    Worktree {
        #[serde(rename = "branchName")]
        branch_name: Option<String>,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckoutResult {
    CheckedOut {
        cwd: PathBuf,
        branch: String,
    },
    WorktreeCreated {
        cwd: PathBuf,
        branch: String,
        #[serde(rename = "worktreeId")]
        worktree_id: String,
    },
    Blocked {
        reason: GitManagerBlockedReason,
    },
}
fn blocked(code: &str, message: &str) -> CheckoutResult {
    CheckoutResult::Blocked {
        reason: GitManagerBlockedReason {
            operation: "checkout".into(),
            code: code.into(),
            message: message.into(),
        },
    }
}
fn mismatch() -> CheckoutResult {
    blocked(
        "project-mismatch",
        "The selected checkout does not belong to the requested project.",
    )
}
fn error(code: &'static str) -> PullRequestsOperationError {
    PullRequestsOperationError::new(OP, code)
}
fn git_output(
    result: Result<CommandOutput, ProcessFailure>,
) -> Result<CommandOutput, PullRequestsOperationError> {
    result.map_err(|failure| from_process_error(OP, "git", &failure.error, &failure.stderr))
}

impl PullRequestsService {
    pub(crate) async fn checkout(
        &self,
        worktrees: &WorktreeCatalogRpcServices,
        repositories: &Repositories,
        input: CheckoutInput,
        c: &CancellationToken,
        write_started: &CancellationToken,
        wait_cancelled: &CancellationToken,
    ) -> Result<CheckoutResult, PullRequestsOperationError> {
        if input.number == 0
            || input.number > 9_007_199_254_740_991
            || input.cwd.as_os_str().is_empty()
        {
            return Err(error("invalid_request"));
        }
        bounded_read(OP, Duration::from_secs(60), c, |c| async move {
            let operation = self.checkout_inner(worktrees, repositories, input, &c, write_started);
            tokio::pin!(operation);
            // This observer lives inside the bounded closure. The read token's
            // normal drop cleanup must never turn a successful receipt into a timeout.
            tokio::select! {
                biased;
                result = &mut operation => result,
                () = c.cancelled() => {
                    wait_cancelled.cancel();
                    operation.await
                }
            }
        })
        .await
        .inspect_err(|failure| self.invalidate_failed_context(failure))
        .map_err(|mut failure| {
            failure.operation = OP.into();
            failure
        })
    }

    async fn checkout_inner(
        &self,
        worktrees: &WorktreeCatalogRpcServices,
        repositories: &Repositories,
        input: CheckoutInput,
        c: &CancellationToken,
        write_started: &CancellationToken,
    ) -> Result<CheckoutResult, PullRequestsOperationError> {
        let catalog = worktrees.catalog();
        let project_id = match resolve_project_id(repositories, &input.cwd).await {
            Ok(id) => id,
            Err(_) => return Ok(mismatch()),
        };
        // Establish/verify the durable repository pin before acquiring its shared lock.
        let inventory = catalog
            .refresh(&project_id, CatalogRefreshTrigger::Explicit)
            .await
            .map_err(|_| error("blocked"))?;
        if !inventory.authoritative || inventory.scan_status != CatalogScanStatus::Ready {
            return Err(error("blocked"));
        }
        let target_cwd = match &input.target {
            CheckoutTarget::Checkout { cwd } => cwd,
            CheckoutTarget::Worktree { .. } => &input.cwd,
        };
        let availability = catalog.availability_registry();
        let admission = availability
            .acquire_path_admission([input.cwd.as_path(), target_cwd.as_path()])
            .await
            .map_err(|_| error("blocked"))?;
        let loss = admission.loss_cancellation();
        let operation = async {
            let scope = resolve_scope(&self.runner, &input.cwd, &DiscoveredHosts::default(), c)
                .await
                .map_err(|u| u.operation_error(OP))?;
            let _gate = self
                .acquire_action_gate(&scope, input.number, OP, c)
                .await?;
            let repository = catalog
                .git_repository()
                .ok_or_else(|| error("unavailable"))?;
            let context = LockedCheckout {
                service: self,
                worktrees,
                repositories,
                input: &input,
                project_id: &project_id,
                repository_key: &inventory.repository_key,
                scope: &scope,
                repository: &repository,
                write_started,
            };
            let outcome = catalog
                .try_with_project_mutation_lock_cancellation(&project_id, c, || context.run(c))
                .await;
            match outcome {
                ProjectMutationAttempt::Acquired(result) => result,
                ProjectMutationAttempt::InFlight => Ok(blocked(
                    "operation-in-flight",
                    "Blocked: another Git Manager operation is already running.",
                )),
                ProjectMutationAttempt::Cancelled => Err(error("timeout")),
            }
        };
        tokio::pin!(operation);
        tokio::select! { biased; () = loss.cancelled() => { c.cancel(); operation.await }, result = &mut operation => result }
    }
}

/// The repository lock covers identity proof, guard reads, Git writes and durable creation.
struct LockedCheckout<'a> {
    service: &'a PullRequestsService,
    worktrees: &'a WorktreeCatalogRpcServices,
    repositories: &'a Repositories,
    input: &'a CheckoutInput,
    project_id: &'a str,
    repository_key: &'a str,
    scope: &'a HostScope,
    repository: &'a crate::git::GitRepository,
    write_started: &'a CancellationToken,
}
impl LockedCheckout<'_> {
    async fn run(
        self,
        c: &CancellationToken,
    ) -> Result<CheckoutResult, PullRequestsOperationError> {
        let Self {
            service,
            worktrees,
            repositories,
            input,
            project_id,
            repository_key,
            scope,
            repository,
            write_started,
        } = self;
        let catalog = worktrees.catalog();
        let target_cwd = match &input.target {
            CheckoutTarget::Checkout { cwd } => cwd,
            CheckoutTarget::Worktree { .. } => &input.cwd,
        };

        // Resolve ownership again under the lock; paths and projections can change.
        if resolve_project_id(repositories, &input.cwd)
            .await
            .ok()
            .as_deref()
            != Some(project_id)
        {
            return Ok(mismatch());
        }
        if let CheckoutTarget::Checkout { cwd } = &input.target {
            match resolve_project_id(repositories, cwd).await {
                Ok(id) if id != project_id => return Ok(mismatch()),
                Err(code) if code != "project-not-found" => return Ok(mismatch()),
                _ => {}
            }
        }
        // A persisted or registered path can be replaced with another repository.
        // Prove both physical common directories match the catalog pin under its lock.
        for cwd in [&input.cwd, target_cwd] {
            let common = repository
                .resolve_common_dir(cwd, c)
                .await
                .map_err(|_| error("blocked"))?;
            let common = tokio::fs::canonicalize(common)
                .await
                .map_err(|_| error("blocked"))?;
            if worktree_repository_key(&common, host_path_platform()).as_str() != repository_key {
                return Ok(mismatch());
            }
        }
        let mut snapshot = build_refs_snapshot(repository, target_cwd, c)
            .await
            .map_err(|_| error("blocked"))?;
        let target_key = canonical_worktree_path_key(target_cwd)
            .await
            .map_err(|_| error("blocked"))?;
        let mut member = false;
        for worktree in &snapshot.worktrees {
            if !worktree.is_bare
                && canonical_worktree_path_key(Path::new(&worktree.path))
                    .await
                    .is_ok_and(|key| key == target_key)
            {
                member = true;
                break;
            }
        }
        if !member {
            return Ok(mismatch());
        }
        let head_branch = service
            .host(scope)
            .head_branch(scope, input.number, c)
            .await?;
        validate_branch(&service.runner, &input.cwd, &head_branch, c).await?;
        snapshot.in_progress_operation = detect_in_progress_operation(repository, target_cwd, c)
            .await
            .map_err(|_| error("blocked"))?;
        let guard_operation = match input.target {
            CheckoutTarget::Checkout { .. } => "checkout",
            CheckoutTarget::Worktree { .. } => "fetch",
        };
        let guard_branch = match &input.target {
            CheckoutTarget::Worktree {
                branch_name: Some(name),
            } => name,
            _ => &head_branch,
        };
        // Worktree creation does not alter an occupied branch. Planning below applies
        // the PR suffix to both occupied names and divergent tips before creation.
        if let Some(reason) = guard(&snapshot, guard_branch, guard_operation) {
            return Ok(CheckoutResult::Blocked { reason });
        }
        // All branch planning is read-only and remains cancellable before handoff.
        let prepared = match &input.target {
            CheckoutTarget::Worktree { branch_name } => Some(
                prepare_branch(
                    &service.runner,
                    scope,
                    input.number,
                    &service.host(scope).head_ref_spec(input.number),
                    branch_name.as_deref().unwrap_or(&head_branch),
                    &snapshot.worktrees,
                    c,
                )
                .await?,
            ),
            CheckoutTarget::Checkout { .. } => None,
        };
        if c.is_cancelled() {
            return Err(error("timeout"));
        }
        let mut mutation = if let Some(broadcaster) = worktrees.status_broadcaster() {
            Some(
                tokio::select! { biased; () = c.cancelled() => return Err(error("timeout")), mutation = broadcaster.begin_mutation(target_cwd) => mutation },
            )
        } else {
            None
        };
        if c.is_cancelled() {
            if let Some(mutation) = mutation {
                mutation.finish().await;
            }
            return Err(error("timeout"));
        }
        // The operation runtime owns this entire future and all leases. From this
        // point request/deadline/admission cancellation may end only the RPC wait.
        let write_cancellation = CancellationToken::new();
        write_started.cancel();
        let result = match &input.target {
            CheckoutTarget::Checkout { cwd } => {
                local_checkout(
                    &service.runner,
                    scope,
                    cwd,
                    input.number,
                    &head_branch,
                    &write_cancellation,
                )
                .await
            }
            CheckoutTarget::Worktree { .. } => {
                let prepared = prepared.expect("worktree branch was prepared before handoff");
                let fetched = if let Some(ref_spec) = prepared.fetch_ref_spec {
                    git_output(
                        service
                            .runner
                            .git_with_budget(
                                &scope.cwd,
                                &["fetch", "--no-tags", "origin", &ref_spec],
                                Budget::CheckoutWrite.timeout(),
                                &write_cancellation,
                            )
                            .await,
                    )
                    .map(|_| ())
                } else {
                    Ok(())
                };
                // Managed creation sends its own status notifications; do not
                // recursively acquire the source checkout's VCS mutation fence.
                if let Some(mutation) = mutation.take() {
                    mutation.finish().await;
                }
                match fetched {
                    Err(failure) => Err(failure),
                    Ok(()) => worktrees.create_managed_from_ref_locked(project_id, &prepared.name, &write_cancellation).await
                        .map_err(|_| {
                            let mut failure = error("blocked");
                            failure.message = format!("Could not create the worktree. Run git status in {} and inspect the fetched branch in Git Manager before retrying.", input.cwd.display());
                            failure
                        })
                        .and_then(|value| Ok(CheckoutResult::WorktreeCreated {
                            cwd: value["path"].as_str().ok_or_else(|| error("invalid_response"))?.into(),
                            branch: value["refName"].as_str().ok_or_else(|| error("invalid_response"))?.into(),
                            worktree_id: value["threadId"].as_str().ok_or_else(|| error("invalid_response"))?.into(),
                        })),
                }
            }
        };
        if let Some(mutation) = mutation {
            mutation.finish().await;
        }
        // Git itself may have changed refs even when it reports failure.
        catalog
            .invalidate_repository_after_mutation(project_id)
            .await;
        result
    }
}

fn guard(
    snapshot: &GitManagerRefsSnapshot,
    branch: &str,
    operation: &str,
) -> Option<GitManagerBlockedReason> {
    let mut input = GuardInput::from_snapshot(snapshot, false);
    if !input.refs.iter().any(|r| r.reference.name == branch) {
        input.refs.push(GuardedRef {
            reference: GitManagerRefEntry {
                name: branch.into(),
                tip_sha: String::new(),
                upstream: None,
                ahead: 0,
                behind: 0,
                current: false,
                is_default: false,
                worktree_path: None,
                blocked: vec![],
            },
            occupancy: Occupancy::Free,
            remote_configured: !snapshot.remotes.is_empty(),
        });
    }
    let reasons = evaluate_guards(&input).remove(branch).unwrap_or_default();
    // Checkout refreshes the PR even when its branch is current; its tip may be stale.
    reasons.into_iter().find(|reason| {
        reason.operation == operation
            && reason.code != "current-branch"
            && !(operation == "fetch" && reason.code == "worktree-checked-out")
    })
}
async fn validate_branch(
    runner: &HostCommandRunner,
    cwd: &Path,
    branch: &str,
    c: &CancellationToken,
) -> Result<(), PullRequestsOperationError> {
    // Reject revision expressions/options, including check-ref-format's @{-1} expansion.
    if branch.trim() != branch
        || branch.is_empty()
        || branch.starts_with('-')
        || branch.contains("@{")
    {
        return Err(error("invalid_request"));
    }
    git_output(
        runner
            .git(cwd, &["check-ref-format", "--branch", branch], c)
            .await,
    )?;
    Ok(())
}
async fn local_checkout(
    runner: &HostCommandRunner,
    scope: &HostScope,
    cwd: &Path,
    number: u64,
    branch: &str,
    c: &CancellationToken,
) -> Result<CheckoutResult, PullRequestsOperationError> {
    let target_scope = HostScope {
        cwd: cwd.into(),
        ..scope.clone()
    };
    let number = number.to_string();
    let (cli, result) = if scope.provider == ProviderKind::Github {
        (
            "gh",
            runner
                .gh(
                    &target_scope,
                    &["pr", "checkout", &number, "--branch", branch],
                    Budget::CheckoutWrite,
                    None,
                    c,
                )
                .await,
        )
    } else {
        (
            "glab",
            runner
                .glab(
                    &target_scope,
                    &["mr", "checkout", &number, "-b", branch],
                    Budget::CheckoutWrite,
                    None,
                    c,
                )
                .await,
        )
    };
    result.map_err(|failure| from_process_error(OP, cli, &failure.error, &failure.stderr))?;
    let actual = git_output(runner.git(cwd, &["branch", "--show-current"], c).await)?
        .stdout
        .trim()
        .to_owned();
    if actual.is_empty() {
        return Err(error("invalid_response"));
    }
    Ok(CheckoutResult::CheckedOut {
        cwd: cwd.into(),
        branch: actual,
    })
}
struct PreparedBranch {
    name: String,
    fetch_ref_spec: Option<String>,
}

async fn prepare_branch(
    runner: &HostCommandRunner,
    scope: &HostScope,
    number: u64,
    ref_spec: &str,
    branch: &str,
    worktrees: &[GitManagerWorktreeEntry],
    c: &CancellationToken,
) -> Result<PreparedBranch, PullRequestsOperationError> {
    validate_branch(runner, &scope.cwd, branch, c).await?;
    // Inspect the advertised head before choosing a destination. FETCH_HEAD is shared
    // scratch state that another fetch can replace, even outside the app's lock.
    let advertised = git_output(
        runner
            .git_with_budget(
                &scope.cwd,
                &["ls-remote", "--exit-code", "origin", ref_spec],
                Duration::from_secs(60),
                c,
            )
            .await,
    )?;
    let mut fields = advertised.stdout.split_whitespace();
    let sha = fields.next().ok_or_else(|| error("invalid_response"))?;
    if !matches!(sha.len(), 40 | 64)
        || !sha.bytes().all(|b| b.is_ascii_hexdigit())
        || fields.next() != Some(ref_spec)
        || fields.next().is_some()
    {
        return Err(error("invalid_response"));
    }
    let mut candidate = branch.to_owned();
    for suffix in 0..100 {
        let existing = runner
            .git(
                &scope.cwd,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{candidate}"),
                ],
                c,
            )
            .await
            .or_else(ProcessFailure::into_output)
            .map_err(|failure| from_process_error(OP, "git", &failure.error, &failure.stderr))?;
        // Registered worktrees retain occupancy even when their directory is missing.
        // Include the current checkout: a branch can belong to only one worktree.
        let occupied = worktrees
            .iter()
            .any(|worktree| worktree.branch.as_deref() == Some(candidate.as_str()));
        if !occupied && existing.exit_code == 0 && existing.stdout.trim() == sha {
            return Ok(PreparedBranch {
                name: candidate,
                fetch_ref_spec: None,
            });
        }
        if !occupied && existing.exit_code == 1 {
            // The destination is only written after the non-cancellable handoff.
            return Ok(PreparedBranch {
                fetch_ref_spec: Some(format!("{ref_spec}:refs/heads/{candidate}")),
                name: candidate,
            });
        }
        if !matches!(existing.exit_code, 0 | 1) {
            return Err(error("blocked"));
        }
        candidate = if suffix == 0 {
            format!("{branch}-pr-{number}")
        } else {
            format!("{branch}-pr-{number}-{}", suffix + 1)
        };
    }
    let mut failure = error("blocked");
    failure.message =
        "No free branch name is available. Choose a different worktree branch name.".into();
    Err(failure)
}
