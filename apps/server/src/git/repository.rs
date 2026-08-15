use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fmt, fs,
    future::Future,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::diagnostics::redact_sensitive_text;

use super::worktree::{WorktreePruneDryRunRecord, parse_worktree_prune_dry_run};
use super::{
    ChangeRequest, CreateWorktreeInput, GitCommandDiagnostics, GitCommandError,
    GitPrunableWorktree, GitWorktreeInventory, GitWorktreeRecord, GitWorktreeRemovalInspection,
    ManagedWorktreeRollback, OutputPolicy, ProcessError, ProcessOutput, ProcessRequest,
    ProcessRunner, ProviderKind, PullStatus, SourceControlProviderInfo, VcsCommit,
    VcsCreateWorktreeResult, VcsListCommitsResult, VcsListRefsResult, VcsPullResult, VcsRef,
    VcsStagingArea, VcsStatusLocalResult, VcsStatusRemoteResult, VcsStatusResult, VcsWorkingTree,
    VcsWorkingTreeFile, VcsWorkingTreeFileStatus, VcsWorktree, canonical_worktree_path_key,
    git_worktree_prune_impact_digest, host_path_platform, normalize_worktree_path_key,
    parse_numstat, parse_porcelain_v2_line, parse_worktree_porcelain,
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OUTPUT_LIMIT: usize = 1_000_000;
const WORKTREE_INVENTORY_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const WORKTREE_REMOVAL_STATUS_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const WORKTREE_PRUNE_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const WORKTREE_PRUNE_GITDIR_LIMIT: u64 = 64 * 1024;
const COMMIT_FIELD_SEPARATOR: char = '\x1f';
const CLONE_OPERATION: &str = "GitVcsDriver.clone";
const MAX_AUTOMATIC_WORKTREE_SUFFIX_ATTEMPTS: usize = 100;
const WORKTREE_REMOVE_RETRY_ATTEMPTS: usize = 20;
const WORKTREE_REMOVE_RETRY_DELAY: Duration = Duration::from_millis(50);
const WORKTREE_REMOVAL_IDENTITY_FILE: &str = "bibcode-removal-identity";
const WORKTREE_REMOVAL_ROOT_IDENTITY_FILE: &str = ".bibcode-removal-identity";
const WORKTREE_REMOVAL_TOMBSTONE_FILE: &str = ".bibcode-removal-tombstone";

#[derive(Clone, Copy)]
struct GitExecutionOptions {
    allow_non_zero_exit: bool,
    max_output_bytes: usize,
    output_policy: OutputPolicy,
}

pub(crate) type BoxGitProcessFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ProcessOutput, ProcessError>> + Send + 'a>>;

pub(crate) trait GitProcessRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        request: ProcessRequest,
        cancellation: &'a CancellationToken,
    ) -> BoxGitProcessFuture<'a>;
}

impl GitProcessRunner for ProcessRunner {
    fn run<'a>(
        &'a self,
        request: ProcessRequest,
        cancellation: &'a CancellationToken,
    ) -> BoxGitProcessFuture<'a> {
        Box::pin(ProcessRunner::run(self, request, cancellation))
    }
}

pub type BoxWorktreeBaseDirectoryFuture<'a> =
    Pin<Box<dyn Future<Output = Option<PathBuf>> + Send + 'a>>;

pub trait WorktreeBaseDirectoryProvider: Send + Sync {
    fn worktree_base_directory<'a>(&'a self) -> BoxWorktreeBaseDirectoryFuture<'a>;
}

#[derive(Debug, Default)]
struct DefaultWorktreeBaseDirectory;

impl WorktreeBaseDirectoryProvider for DefaultWorktreeBaseDirectory {
    fn worktree_base_directory<'a>(&'a self) -> BoxWorktreeBaseDirectoryFuture<'a> {
        Box::pin(async { None })
    }
}

#[derive(Clone)]
pub struct GitRepository {
    runner: Arc<dyn GitProcessRunner>,
    worktree_settings: Arc<dyn WorktreeBaseDirectoryProvider>,
    worktree_porcelain_z_supported: Arc<Mutex<Option<bool>>>,
}

impl Default for GitRepository {
    fn default() -> Self {
        Self {
            runner: Arc::new(ProcessRunner),
            worktree_settings: Arc::new(DefaultWorktreeBaseDirectory),
            worktree_porcelain_z_supported: Arc::new(Mutex::new(None)),
        }
    }
}

impl fmt::Debug for GitRepository {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitRepository")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
struct WorktreePathPolicy {
    configured_base: Option<PathBuf>,
}

impl WorktreePathPolicy {
    fn path_for(&self, cwd: &Path, target_ref: &str) -> PathBuf {
        let repo = cwd
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("repository");
        let base = self
            .configured_base
            .clone()
            .unwrap_or_else(|| cwd.parent().unwrap_or(cwd).join(".bibcode-worktrees"));
        base.join(repo).join(target_ref.replace('/', "-"))
    }

    fn configured_base(&self) -> Option<&Path> {
        self.configured_base.as_deref()
    }
}

struct OwnedWorktreePath {
    path: PathBuf,
    identity: OwnedWorktreePathIdentity,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct OwnedWorktreePathIdentity {
    device: u64,
    inode: u64,
}

#[cfg(windows)]
type OwnedWorktreePathIdentity = WindowsFileIdentity;

impl fmt::Debug for OwnedWorktreePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OwnedWorktreePath")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorktreePathReservationStage {
    Parent,
    Destination,
}

#[derive(Debug)]
struct WorktreePathReservationError {
    stage: WorktreePathReservationStage,
    source: io::Error,
}

impl WorktreePathReservationError {
    fn kind(&self) -> io::ErrorKind {
        self.source.kind()
    }

    fn is_destination_collision(&self) -> bool {
        self.stage == WorktreePathReservationStage::Destination
            && self.kind() == io::ErrorKind::AlreadyExists
    }
}

impl OwnedWorktreePath {
    fn reserve(path: PathBuf) -> Result<Self, WorktreePathReservationError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|source| WorktreePathReservationError {
                stage: WorktreePathReservationStage::Parent,
                source,
            })?;
        }
        let lease = create_removal_directory_lease(&path).map_err(|source| {
            WorktreePathReservationError {
                stage: WorktreePathReservationStage::Destination,
                source,
            }
        })?;
        let identity = match owned_worktree_path_identity(&lease) {
            Ok(identity) => identity,
            Err(source) => {
                let _ = delete_bound_directory_root_blocking(lease, &path);
                return Err(WorktreePathReservationError {
                    stage: WorktreePathReservationStage::Destination,
                    source,
                });
            }
        };
        drop(lease);
        Ok(Self { path, identity })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn identity(&self) -> OwnedWorktreePathIdentity {
        self.identity
    }
}

impl GitRepository {
    pub fn with_worktree_settings(
        worktree_settings: Arc<dyn WorktreeBaseDirectoryProvider>,
    ) -> Self {
        Self {
            runner: Arc::new(ProcessRunner),
            worktree_settings,
            worktree_porcelain_z_supported: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_runner_for_test(runner: Arc<dyn GitProcessRunner>) -> Self {
        Self {
            runner,
            worktree_settings: Arc::new(DefaultWorktreeBaseDirectory),
            worktree_porcelain_z_supported: Arc::new(Mutex::new(None)),
        }
    }

    async fn worktree_path_policy(
        &self,
        cwd: &Path,
    ) -> Result<WorktreePathPolicy, GitCommandError> {
        let configured_base = self.worktree_settings.worktree_base_directory().await;
        if let Some(path) = configured_base.as_ref() {
            let available = tokio::fs::metadata(path)
                .await
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false);
            if !available {
                return Err(workspace_unavailable_error(cwd, path));
            }
        }
        Ok(WorktreePathPolicy { configured_base })
    }

    async fn execute(
        &self,
        operation: &str,
        cwd: &Path,
        args: &[String],
        allow_non_zero_exit: bool,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, GitCommandError> {
        self.execute_with_options(
            operation,
            cwd,
            args,
            GitExecutionOptions {
                allow_non_zero_exit,
                max_output_bytes: DEFAULT_OUTPUT_LIMIT,
                output_policy: OutputPolicy::Truncate,
            },
            cancellation,
        )
        .await
    }

    async fn execute_with_options(
        &self,
        operation: &str,
        cwd: &Path,
        args: &[String],
        options: GitExecutionOptions,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, GitCommandError> {
        self.runner
            .run(
                ProcessRequest {
                    operation: operation.to_owned(),
                    command: PathBuf::from("git"),
                    args: args.iter().map(OsString::from).collect(),
                    cwd: cwd.to_path_buf(),
                    env: git_environment(),
                    stdin: None,
                    timeout: DEFAULT_TIMEOUT,
                    max_output_bytes: options.max_output_bytes,
                    output_policy: options.output_policy,
                    append_truncation_marker: false,
                    allow_non_zero_exit: options.allow_non_zero_exit,
                },
                cancellation,
            )
            .await
            .map_err(|error| git_error(operation, cwd, args.len(), error))
    }

    async fn run(
        &self,
        operation: &str,
        cwd: &Path,
        args: &[String],
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, GitCommandError> {
        self.execute(operation, cwd, args, false, cancellation)
            .await
    }

    pub async fn is_repository(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<bool, GitCommandError> {
        let result = self
            .execute(
                "GitVcsDriver.detectRepository",
                cwd,
                &strings(&["rev-parse", "--is-inside-work-tree"]),
                true,
                cancellation,
            )
            .await?;
        Ok(result.exit_code == 0 && result.stdout.trim() == "true")
    }

    pub async fn repository_root(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<PathBuf>, GitCommandError> {
        if !self.is_repository(cwd, cancellation).await? {
            return Ok(None);
        }
        let output = self
            .run(
                "GitVcsDriver.repositoryRoot",
                cwd,
                &strings(&["rev-parse", "--show-toplevel"]),
                cancellation,
            )
            .await?;
        Ok(Some(PathBuf::from(output.stdout.trim())))
    }

    pub async fn worktree_inventory(
        &self,
        anchor: &Path,
        cancellation: &CancellationToken,
    ) -> Result<GitWorktreeInventory, GitCommandError> {
        let common_dir_output = self
            .execute_with_options(
                "GitVcsDriver.worktreeInventory.commonDir",
                anchor,
                &strings(&["rev-parse", "--git-common-dir"]),
                GitExecutionOptions {
                    allow_non_zero_exit: false,
                    max_output_bytes: WORKTREE_INVENTORY_OUTPUT_LIMIT,
                    output_policy: OutputPolicy::Error,
                },
                cancellation,
            )
            .await?;
        ensure_authoritative_inventory_output(
            "GitVcsDriver.worktreeInventory.commonDir",
            anchor,
            &common_dir_output,
        )?;
        let common_dir_value = git_output_line(&common_dir_output.stdout).ok_or_else(|| {
            simple_error(
                "GitVcsDriver.worktreeInventory.commonDir",
                anchor,
                "Git reported an invalid common Git directory.",
            )
        })?;
        if common_dir_value.is_empty() {
            return Err(simple_error(
                "GitVcsDriver.worktreeInventory.commonDir",
                anchor,
                "Git did not report a common Git directory.",
            ));
        }
        let common_dir_path = PathBuf::from(common_dir_value);
        let common_dir = if common_dir_path.is_absolute() {
            common_dir_path
        } else {
            normalize_path_lexically(&anchor.join(common_dir_path))
        };

        let (output, nul_delimited) = self.worktree_porcelain_output(anchor, cancellation).await?;
        ensure_authoritative_inventory_output(
            "GitVcsDriver.worktreeInventory.list",
            anchor,
            &output,
        )?;
        let records = parse_worktree_porcelain(&output.stdout, nul_delimited).map_err(|error| {
            simple_error(
                "GitVcsDriver.worktreeInventory.parse",
                anchor,
                &format!("Git worktree inventory is malformed: {error}"),
            )
        })?;
        Ok(GitWorktreeInventory {
            common_dir,
            records,
            nul_delimited,
        })
    }

    pub async fn inspect_worktree_removal(
        &self,
        anchor: &Path,
        record: &GitWorktreeRecord,
        cancellation: &CancellationToken,
    ) -> Result<GitWorktreeRemovalInspection, GitCommandError> {
        validate_removable_worktree(anchor, record)?;
        let inventory = self.worktree_inventory(anchor, cancellation).await?;
        let fresh = exact_worktree_record(&inventory, record).ok_or_else(|| {
            worktree_record_mismatch_error("GitVcsDriver.inspectWorktreeRemoval", anchor, record)
        })?;
        let inspection = match tokio::fs::symlink_metadata(&fresh.path).await {
            Ok(_) => {
                let target_inventory = self.worktree_inventory(&fresh.path, cancellation).await?;
                let expected_common_dir = canonical_common_dir(
                    "GitVcsDriver.inspectWorktreeRemoval",
                    anchor,
                    &inventory.common_dir,
                )
                .await?;
                let target_common_dir = canonical_common_dir(
                    "GitVcsDriver.inspectWorktreeRemoval",
                    anchor,
                    &target_inventory.common_dir,
                )
                .await?;
                if normalized_worktree_path(&target_common_dir)
                    != normalized_worktree_path(&expected_common_dir)
                    || exact_worktree_record(&target_inventory, record).is_none()
                {
                    return Err(simple_error(
                        "GitVcsDriver.inspectWorktreeRemoval",
                        anchor,
                        "The path currently belongs to a different repository than the registered worktree.",
                    ));
                }
                let output = self
                    .execute_with_options(
                        "GitVcsDriver.inspectWorktreeRemoval.status",
                        &fresh.path,
                        &strings(&[
                            "-c",
                            "core.quotePath=false",
                            "status",
                            "--porcelain=v2",
                            "-z",
                            "--untracked-files=all",
                            "--ignored=no",
                        ]),
                        GitExecutionOptions {
                            allow_non_zero_exit: false,
                            max_output_bytes: WORKTREE_REMOVAL_STATUS_OUTPUT_LIMIT,
                            output_policy: OutputPolicy::Error,
                        },
                        cancellation,
                    )
                    .await?;
                parse_worktree_removal_status(anchor, &output.stdout)?
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                GitWorktreeRemovalInspection::default()
            }
            Err(error) => {
                return Err(simple_error(
                    "GitVcsDriver.inspectWorktreeRemoval",
                    anchor,
                    &format!(
                        "The registered worktree path '{}' could not be inspected: {error}",
                        display_path(&fresh.path)
                    ),
                ));
            }
        };
        let verified = self.worktree_inventory(anchor, cancellation).await?;
        if exact_worktree_record(&verified, record).is_none() {
            return Err(worktree_record_mismatch_error(
                "GitVcsDriver.inspectWorktreeRemoval",
                anchor,
                record,
            ));
        }
        Ok(inspection)
    }

    pub async fn remove_worktree_verified(
        &self,
        anchor: &Path,
        record: &GitWorktreeRecord,
        force_dirty: bool,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        let inspection = self
            .inspect_worktree_removal(anchor, record, cancellation)
            .await?;
        if !force_dirty
            && (inspection.tracked_change_count != 0 || inspection.untracked_file_count != 0)
        {
            return Err(simple_error(
                "GitVcsDriver.removeWorktreeVerified",
                anchor,
                "The worktree is dirty; explicit dirty-worktree confirmation is required.",
            ));
        }

        let inventory = self.worktree_inventory(anchor, cancellation).await?;
        let fresh = exact_worktree_record(&inventory, record).ok_or_else(|| {
            worktree_record_mismatch_error("GitVcsDriver.removeWorktreeVerified", anchor, record)
        })?;
        let target_path = fresh.path.clone();
        match tokio::fs::symlink_metadata(&target_path).await {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let impact = self
                    .worktree_prune_impact(anchor, &inventory, cancellation)
                    .await?;
                let exact_target_only = matches!(
                    impact.as_slice(),
                    [entry]
                        if normalized_worktree_path(&entry.path)
                            == normalized_worktree_path(&target_path)
                );
                if !exact_target_only {
                    return Err(simple_error(
                        "GitVcsDriver.removeWorktreeVerified",
                        anchor,
                        "The missing worktree registration cannot be cleaned without pruning additional registrations.",
                    ));
                }
                let impact_digest = git_worktree_prune_impact_digest(&impact);
                return self
                    .prune_worktrees_verified(anchor, fresh, &impact_digest, cancellation)
                    .await;
            }
            Err(error) => {
                return Err(simple_error(
                    "GitVcsDriver.removeWorktreeVerified",
                    anchor,
                    &format!(
                        "The registered worktree path '{}' could not be inspected before protected removal: {error}",
                        display_path(&target_path)
                    ),
                ));
            }
        }
        self.remove_worktree(anchor, &target_path, true, cancellation)
            .await?;
        let verification = self
            .worktree_inventory(anchor, &CancellationToken::new())
            .await?;
        if !inventory_contains_path(&verification, &target_path) {
            return Ok(());
        }
        Err(simple_error(
            "GitVcsDriver.removeWorktreeVerified.verify",
            anchor,
            "Protected Git worktree removal completed, but the exact target registration survived verification.",
        ))
    }

    pub async fn preview_worktree_prune(
        &self,
        anchor: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Vec<GitPrunableWorktree>, GitCommandError> {
        let before = self.worktree_inventory(anchor, cancellation).await?;
        let impact = self
            .worktree_prune_impact(anchor, &before, cancellation)
            .await?;
        let after = self.worktree_inventory(anchor, cancellation).await?;
        if sorted_prunable_records(&before) != sorted_prunable_records(&after) {
            return Err(simple_error(
                "GitVcsDriver.previewWorktreePrune.verify",
                anchor,
                "Git worktree registrations changed while the prune impact was being inspected.",
            ));
        }
        Ok(impact)
    }

    pub async fn prune_worktrees_verified(
        &self,
        anchor: &Path,
        target: &GitWorktreeRecord,
        expected_impact_digest: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        validate_removable_worktree(anchor, target)?;
        let inventory = self.worktree_inventory(anchor, cancellation).await?;
        let impact = self
            .worktree_prune_impact(anchor, &inventory, cancellation)
            .await?;
        let fresh = exact_worktree_record(&inventory, target).ok_or_else(|| {
            worktree_record_mismatch_error("GitVcsDriver.pruneWorktreesVerified", anchor, target)
        })?;
        if !fresh.is_prunable
            || !impact.iter().any(|entry| {
                normalized_worktree_path(&entry.path) == normalized_worktree_path(&fresh.path)
            })
        {
            return Err(simple_error(
                "GitVcsDriver.pruneWorktreesVerified",
                anchor,
                "The exact target registration is not part of Git's current prune impact.",
            ));
        }
        if git_worktree_prune_impact_digest(&impact) != expected_impact_digest {
            return Err(simple_error(
                "GitVcsDriver.pruneWorktreesVerified",
                anchor,
                "Git's current prune impact does not match the caller-confirmed impact digest.",
            ));
        }

        let target_path = fresh.path.clone();
        let mutation = self
            .run(
                "GitVcsDriver.pruneWorktreesVerified",
                anchor,
                &strings(&["worktree", "prune", "--expire", "now"]),
                cancellation,
            )
            .await;
        let verification = self
            .worktree_inventory(anchor, &CancellationToken::new())
            .await?;
        if !inventory_contains_path(&verification, &target_path) {
            return Ok(());
        }
        match mutation {
            Ok(_) => Err(simple_error(
                "GitVcsDriver.pruneWorktreesVerified.verify",
                anchor,
                "Git reported successful worktree pruning, but the exact target registration survived verification.",
            )),
            Err(error) => Err(error),
        }
    }

    async fn worktree_prune_impact(
        &self,
        anchor: &Path,
        inventory: &GitWorktreeInventory,
        cancellation: &CancellationToken,
    ) -> Result<Vec<GitPrunableWorktree>, GitCommandError> {
        let common_dir = canonical_common_dir(
            "GitVcsDriver.previewWorktreePrune",
            anchor,
            &inventory.common_dir,
        )
        .await?;
        let output = self
            .execute_with_options(
                "GitVcsDriver.previewWorktreePrune",
                anchor,
                &strings(&[
                    "worktree",
                    "prune",
                    "--dry-run",
                    "--verbose",
                    "--expire",
                    "now",
                ]),
                GitExecutionOptions {
                    allow_non_zero_exit: false,
                    max_output_bytes: WORKTREE_PRUNE_OUTPUT_LIMIT,
                    output_policy: OutputPolicy::Error,
                },
                cancellation,
            )
            .await?;
        if !output.stdout.is_empty() {
            return Err(simple_error(
                "GitVcsDriver.previewWorktreePrune.parse",
                anchor,
                "Git worktree prune preview produced unexpected standard output.",
            ));
        }
        let dry_run_records = parse_worktree_prune_dry_run(&output.stderr).map_err(|error| {
            simple_error(
                "GitVcsDriver.previewWorktreePrune.parse",
                anchor,
                &format!("Git worktree prune preview is malformed: {error}"),
            )
        })?;
        let resolved =
            resolve_worktree_prune_paths(anchor, &common_dir, dry_run_records, cancellation)
                .await?;
        let mut records = sorted_prunable_records(inventory);
        if resolved.len() != records.len() {
            return Err(simple_error(
                "GitVcsDriver.previewWorktreePrune.verify",
                anchor,
                "Git's dry-run path and reason impact does not match the authoritative worktree inventory.",
            ));
        }
        let mut impact = Vec::with_capacity(resolved.len());
        for (dry_run, path) in resolved {
            let key = normalized_worktree_path(&path);
            let Some(index) = records.iter().position(|record| {
                normalized_worktree_path(&record.path) == key
                    && record.prunable_reason.as_deref() == Some(dry_run.reason.as_str())
            }) else {
                return Err(simple_error(
                    "GitVcsDriver.previewWorktreePrune.verify",
                    anchor,
                    "Git's dry-run path and reason impact does not match the authoritative worktree inventory.",
                ));
            };
            let record = records.remove(index);
            impact.push(GitPrunableWorktree {
                path: record.path,
                prune_reason: dry_run.reason,
                locked: record.locked,
                lock_reason: record.lock_reason,
            });
        }
        if !records.is_empty() {
            return Err(simple_error(
                "GitVcsDriver.previewWorktreePrune.verify",
                anchor,
                "Git's dry-run path and reason impact does not match the authoritative worktree inventory.",
            ));
        }
        impact.sort_by(|left, right| {
            normalized_worktree_path(&left.path)
                .cmp(&normalized_worktree_path(&right.path))
                .then_with(|| left.prune_reason.cmp(&right.prune_reason))
        });
        Ok(impact)
    }

    async fn worktree_porcelain_output(
        &self,
        anchor: &Path,
        cancellation: &CancellationToken,
    ) -> Result<(ProcessOutput, bool), GitCommandError> {
        if self.worktree_porcelain_z_support() != Some(false) {
            let args = strings(&["worktree", "list", "--porcelain", "-z"]);
            let output = self
                .execute_with_options(
                    "GitVcsDriver.worktreeInventory.listZ",
                    anchor,
                    &args,
                    GitExecutionOptions {
                        allow_non_zero_exit: true,
                        max_output_bytes: WORKTREE_INVENTORY_OUTPUT_LIMIT,
                        output_policy: OutputPolicy::Error,
                    },
                    cancellation,
                )
                .await?;
            if output.exit_code == 0 {
                self.set_worktree_porcelain_z_support(true);
                return Ok((output, true));
            }
            if !is_unsupported_porcelain_z_diagnostic(&output.stderr) {
                return Err(command_output_error(
                    "GitVcsDriver.worktreeInventory.listZ",
                    anchor,
                    args.len(),
                    &output,
                    &actionable_git_failure(&output.stderr, &output.stdout),
                ));
            }
            self.set_worktree_porcelain_z_support(false);
        }

        let args = strings(&["worktree", "list", "--porcelain"]);
        let output = self
            .execute_with_options(
                "GitVcsDriver.worktreeInventory.list",
                anchor,
                &args,
                GitExecutionOptions {
                    allow_non_zero_exit: false,
                    max_output_bytes: WORKTREE_INVENTORY_OUTPUT_LIMIT,
                    output_policy: OutputPolicy::Error,
                },
                cancellation,
            )
            .await?;
        Ok((output, false))
    }

    fn worktree_porcelain_z_support(&self) -> Option<bool> {
        self.worktree_porcelain_z_supported
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .to_owned()
    }

    fn set_worktree_porcelain_z_support(&self, supported: bool) {
        *self
            .worktree_porcelain_z_supported
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(supported);
    }

    pub async fn local_status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsStatusLocalResult, GitCommandError> {
        if !self.is_repository(cwd, cancellation).await? {
            return Ok(VcsStatusLocalResult::non_repository());
        }
        let status = self
            .run(
                "GitVcsDriver.statusDetailsLocal.status",
                cwd,
                &strings(&[
                    "-c",
                    "core.quotePath=false",
                    "status",
                    "--porcelain=2",
                    "--branch",
                    "--untracked-files=all",
                ]),
                cancellation,
            )
            .await?;
        let staged_numstat = self
            .run(
                "GitVcsDriver.statusDetailsLocal.stagedNumstat",
                cwd,
                &strings(&[
                    "-c",
                    "core.quotePath=false",
                    "diff",
                    "--cached",
                    "--numstat",
                ]),
                cancellation,
            )
            .await?;
        let unstaged_numstat = self
            .run(
                "GitVcsDriver.statusDetailsLocal.unstagedNumstat",
                cwd,
                &strings(&["-c", "core.quotePath=false", "diff", "--numstat"]),
                cancellation,
            )
            .await?;
        let remotes = self
            .execute(
                "GitVcsDriver.statusDetailsLocal.remotes",
                cwd,
                &strings(&["remote"]),
                true,
                cancellation,
            )
            .await?;
        let remote_names: Vec<&str> = remotes.stdout.lines().map(str::trim).collect();
        let has_primary_remote = remote_names.contains(&"origin");
        let (ref_name, upstream_ref, ahead_count, behind_count) =
            parse_branch_headers(&status.stdout);
        let default_ref_name = self
            .default_ref(cwd, ref_name.as_deref(), cancellation)
            .await?;
        let source_control_provider = if has_primary_remote {
            self.remote_provider(cwd, cancellation).await?
        } else {
            None
        };
        let staged_stats = parse_numstat(&staged_numstat.stdout);
        let unstaged_stats = parse_numstat(&unstaged_numstat.stdout);
        let mut files = Vec::new();
        for line in status.stdout.lines() {
            let Some(record) = parse_porcelain_v2_line(line) else {
                continue;
            };
            if record.untracked {
                let insertions = untracked_line_count(&cwd.join(&record.path)).await;
                files.push(VcsWorkingTreeFile {
                    path: record.path,
                    insertions,
                    deletions: 0,
                    status: Some(VcsWorkingTreeFileStatus::Untracked),
                    area: Some(VcsStagingArea::Untracked),
                });
                continue;
            }
            if record.index_changed {
                let (insertions, deletions) =
                    staged_stats.get(&record.path).copied().unwrap_or((0, 0));
                files.push(VcsWorkingTreeFile {
                    path: record.path.clone(),
                    insertions,
                    deletions,
                    status: Some(record.index_status),
                    area: Some(VcsStagingArea::Staged),
                });
            }
            if record.worktree_changed {
                let (insertions, deletions) =
                    unstaged_stats.get(&record.path).copied().unwrap_or((0, 0));
                files.push(VcsWorkingTreeFile {
                    path: record.path,
                    insertions,
                    deletions,
                    status: Some(record.worktree_status),
                    area: Some(VcsStagingArea::Unstaged),
                });
            }
        }
        files.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then(area_order(left.area).cmp(&area_order(right.area)))
        });
        let insertions = files.iter().map(|file| file.insertions).sum();
        let deletions = files.iter().map(|file| file.deletions).sum();
        let working_tree = VcsWorkingTree {
            files,
            insertions,
            deletions,
        };
        let _ = (upstream_ref, ahead_count, behind_count);
        Ok(VcsStatusLocalResult {
            is_repo: true,
            source_control_provider,
            has_primary_remote,
            is_default_ref: ref_name.is_some() && ref_name == default_ref_name,
            ref_name,
            default_ref_name,
            has_working_tree_changes: !working_tree.files.is_empty(),
            working_tree,
        })
    }

    pub async fn remote_status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<VcsStatusRemoteResult>, GitCommandError> {
        if !self.is_repository(cwd, cancellation).await? {
            return Ok(None);
        }
        let status = self
            .run(
                "GitVcsDriver.statusDetailsRemote.status",
                cwd,
                &strings(&[
                    "status",
                    "--porcelain=2",
                    "--branch",
                    "--untracked-files=no",
                ]),
                cancellation,
            )
            .await?;
        let (branch, upstream, ahead_count, behind_count) = parse_branch_headers(&status.stdout);
        let default_ref = self
            .default_ref(cwd, branch.as_deref(), cancellation)
            .await?;
        let ahead_of_default_count = match (branch.as_deref(), default_ref.as_deref()) {
            (Some(current), Some(default)) if current == default => Some(0),
            (Some(_), Some(default)) => {
                let range = format!("{default}..HEAD");
                let count = self
                    .execute(
                        "GitVcsDriver.statusDetailsRemote.defaultDelta",
                        cwd,
                        &["rev-list".into(), "--count".into(), range],
                        true,
                        cancellation,
                    )
                    .await?;
                (count.exit_code == 0).then(|| count.stdout.trim().parse::<u64>().unwrap_or(0))
            }
            _ => Some(ahead_count),
        };
        Ok(Some(VcsStatusRemoteResult {
            has_upstream: upstream.is_some(),
            ahead_count,
            behind_count,
            ahead_of_default_count,
            pr: None::<ChangeRequest>,
        }))
    }

    pub async fn refresh_remote_status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<VcsStatusRemoteResult>, GitCommandError> {
        if !self.is_repository(cwd, cancellation).await? {
            return Ok(None);
        }
        let upstream = self
            .execute(
                "GitVcsDriver.refreshRemoteStatus.upstream",
                cwd,
                &strings(&["rev-parse", "--abbrev-ref", "@{upstream}"]),
                true,
                cancellation,
            )
            .await?;
        if upstream.exit_code == 0 {
            let upstream = upstream.stdout.trim();
            let remotes = self
                .run(
                    "GitVcsDriver.refreshRemoteStatus.remotes",
                    cwd,
                    &strings(&["remote"]),
                    cancellation,
                )
                .await?;
            let mut remote_names: Vec<&str> = remotes
                .stdout
                .lines()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .collect();
            remote_names.sort_by_key(|name| std::cmp::Reverse(name.len()));
            if let Some(remote) = remote_names
                .into_iter()
                .find(|remote| upstream.starts_with(&format!("{remote}/")))
            {
                self.run(
                    "GitVcsDriver.refreshRemoteStatus.fetch",
                    cwd,
                    &["fetch".into(), "--quiet".into(), remote.into()],
                    cancellation,
                )
                .await?;
            }
        }
        self.remote_status(cwd, cancellation).await
    }

    pub async fn status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsStatusResult, GitCommandError> {
        let local = self.local_status(cwd, cancellation).await?;
        let remote =
            self.remote_status(cwd, cancellation)
                .await?
                .unwrap_or(VcsStatusRemoteResult {
                    has_upstream: false,
                    ahead_count: 0,
                    behind_count: 0,
                    ahead_of_default_count: Some(0),
                    pr: None,
                });
        Ok(VcsStatusResult { local, remote })
    }

    pub async fn stage_files(
        &self,
        cwd: &Path,
        paths: &[String],
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        if paths.is_empty() {
            return Ok(());
        }
        validate_pathspecs("GitVcsDriver.stageFiles", cwd, paths)?;
        let mut args = strings(&["add", "--"]);
        args.extend(paths.iter().cloned());
        self.run("GitVcsDriver.stageFiles", cwd, &args, cancellation)
            .await?;
        Ok(())
    }

    pub async fn unstage_files(
        &self,
        cwd: &Path,
        paths: &[String],
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        if paths.is_empty() {
            return Ok(());
        }
        validate_pathspecs("GitVcsDriver.unstageFiles", cwd, paths)?;
        let head = self
            .execute(
                "GitVcsDriver.unstageFiles.verifyHead",
                cwd,
                &strings(&["rev-parse", "--verify", "--quiet", "HEAD"]),
                true,
                cancellation,
            )
            .await?;
        let mut args = if head.exit_code == 0 {
            strings(&["restore", "--staged", "--"])
        } else {
            strings(&["rm", "--cached", "-r", "--ignore-unmatch", "--"])
        };
        args.extend(paths.iter().cloned());
        self.run("GitVcsDriver.unstageFiles", cwd, &args, cancellation)
            .await?;
        Ok(())
    }

    pub async fn discard_files(
        &self,
        cwd: &Path,
        paths: &[String],
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        if paths.is_empty() {
            return Ok(());
        }
        validate_pathspecs("GitVcsDriver.discardFiles", cwd, paths)?;
        let mut list_args = strings(&["-c", "core.quotePath=false", "ls-files", "-z", "--"]);
        list_args.extend(paths.iter().cloned());
        let tracked = self
            .run(
                "GitVcsDriver.discardFiles.listTracked",
                cwd,
                &list_args,
                cancellation,
            )
            .await?;
        let tracked_paths: Vec<String> = tracked
            .stdout
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect();
        if !tracked_paths.is_empty() {
            let mut restore_args = strings(&["restore", "--worktree", "--"]);
            restore_args.extend(tracked_paths);
            self.run(
                "GitVcsDriver.discardFiles.restore",
                cwd,
                &restore_args,
                cancellation,
            )
            .await?;
        }
        let status = self.local_status(cwd, cancellation).await?;
        let untracked: HashSet<&str> = status
            .working_tree
            .files
            .iter()
            .filter(|file| file.area == Some(VcsStagingArea::Untracked))
            .map(|file| file.path.as_str())
            .collect();
        let requested_untracked: Vec<String> = paths
            .iter()
            .filter(|path| {
                untracked.contains(path.as_str())
                    || untracked
                        .iter()
                        .any(|candidate| candidate.starts_with(&format!("{path}/")))
            })
            .cloned()
            .collect();
        if !requested_untracked.is_empty() {
            let mut clean_args = strings(&["clean", "-fd", "--"]);
            clean_args.extend(requested_untracked);
            self.run(
                "GitVcsDriver.discardFiles.clean",
                cwd,
                &clean_args,
                cancellation,
            )
            .await?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn list_refs(
        &self,
        cwd: &Path,
        query: Option<&str>,
        cursor: usize,
        limit: usize,
        include_matching_remote_refs: bool,
        ref_kind: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<VcsListRefsResult, GitCommandError> {
        if !self.is_repository(cwd, cancellation).await? {
            return Ok(VcsListRefsResult {
                refs: vec![],
                is_repo: false,
                has_primary_remote: false,
                next_cursor: None,
                total_count: 0,
            });
        }
        let branches = self
            .run(
                "GitVcsDriver.listRefs",
                cwd,
                &strings(&[
                    "for-each-ref",
                    "--format=%(refname:short)%09%(HEAD)%09%(committerdate:unix)",
                    "refs/heads",
                    "refs/remotes",
                ]),
                cancellation,
            )
            .await?;
        let remotes = self
            .run(
                "GitVcsDriver.listRefs.remoteNames",
                cwd,
                &strings(&["remote"]),
                cancellation,
            )
            .await?;
        let remote_names: Vec<String> = remotes
            .stdout
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect();
        let default_ref = self.default_ref(cwd, None, cancellation).await?;
        let worktrees = self.worktree_map(cwd, cancellation).await?;
        let mut refs_with_time = Vec::new();
        for line in branches.stdout.lines() {
            let mut fields = line.split('\t');
            let Some(name) = fields.next().map(str::trim).filter(|name| !name.is_empty()) else {
                continue;
            };
            if name.contains("HEAD ->") || name.ends_with("/HEAD") {
                continue;
            }
            let current = fields.next().is_some_and(|head| head.trim() == "*");
            let timestamp = fields
                .next()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .unwrap_or(0);
            let remote_name = remote_names
                .iter()
                .find(|remote| name.starts_with(&format!("{remote}/")))
                .cloned();
            let is_remote = remote_name.is_some();
            refs_with_time.push((
                VcsRef {
                    name: name.to_owned(),
                    is_remote: Some(is_remote),
                    remote_name,
                    current,
                    is_default: !is_remote && default_ref.as_deref() == Some(name),
                    worktree_path: (!is_remote).then(|| worktrees.get(name).cloned()).flatten(),
                },
                timestamp,
            ));
        }
        if !include_matching_remote_refs {
            let locals: HashSet<String> = refs_with_time
                .iter()
                .filter(|(reference, _)| reference.is_remote != Some(true))
                .map(|(reference, _)| reference.name.clone())
                .collect();
            refs_with_time.retain(|(reference, _)| {
                reference.is_remote != Some(true)
                    || reference
                        .remote_name
                        .as_ref()
                        .and_then(|remote| reference.name.strip_prefix(&format!("{remote}/")))
                        .is_none_or(|branch| !locals.contains(branch))
            });
        }
        refs_with_time.retain(|(reference, _)| match ref_kind {
            Some("local") => reference.is_remote != Some(true),
            Some("remote") => reference.is_remote == Some(true),
            _ => true,
        });
        if let Some(query) = query {
            let query = query.to_lowercase();
            refs_with_time.retain(|(reference, _)| reference.name.to_lowercase().contains(&query));
        }
        refs_with_time.sort_by(|(left, left_time), (right, right_time)| {
            ref_priority(left)
                .cmp(&ref_priority(right))
                .then(right_time.cmp(left_time))
                .then(left.name.cmp(&right.name))
        });
        let total_count = refs_with_time.len();
        let refs: Vec<VcsRef> = refs_with_time
            .into_iter()
            .skip(cursor)
            .take(limit.min(200))
            .map(|(reference, _)| reference)
            .collect();
        let next_cursor = (cursor + refs.len() < total_count).then_some(cursor + refs.len());
        Ok(VcsListRefsResult {
            refs,
            is_repo: true,
            has_primary_remote: remote_names.iter().any(|remote| remote == "origin"),
            next_cursor,
            total_count,
        })
    }

    pub async fn list_commits(
        &self,
        cwd: &Path,
        limit: usize,
        cursor: usize,
        cancellation: &CancellationToken,
    ) -> Result<VcsListCommitsResult, GitCommandError> {
        let format = format!(
            "--pretty=format:%H{COMMIT_FIELD_SEPARATOR}%h{COMMIT_FIELD_SEPARATOR}%s{COMMIT_FIELD_SEPARATOR}%an{COMMIT_FIELD_SEPARATOR}%at"
        );
        let args = vec![
            "log".into(),
            format!("--max-count={}", limit.min(200) + 1),
            format!("--skip={cursor}"),
            format,
        ];
        let result = self
            .execute("GitVcsDriver.listCommits", cwd, &args, true, cancellation)
            .await?;
        if result.exit_code != 0 {
            let stderr = result.stderr.to_lowercase();
            if stderr.contains("not a git repository")
                || stderr.contains("does not have any commits yet")
                || stderr.contains("bad default revision")
            {
                return Ok(VcsListCommitsResult {
                    commits: vec![],
                    next_cursor: None,
                });
            }
            return Err(command_output_error(
                "GitVcsDriver.listCommits",
                cwd,
                args.len(),
                &result,
                "Git log failed.",
            ));
        }
        let mut commits: Vec<VcsCommit> = result.stdout.lines().filter_map(parse_commit).collect();
        let has_more = commits.len() > limit;
        commits.truncate(limit);
        Ok(VcsListCommitsResult {
            commits,
            next_cursor: has_more.then_some(cursor + limit),
        })
    }

    pub async fn create_worktree(
        &self,
        input: CreateWorktreeInput,
        cancellation: &CancellationToken,
    ) -> Result<VcsCreateWorktreeResult, GitCommandError> {
        let target_ref = input
            .new_ref_name
            .as_deref()
            .unwrap_or(input.ref_name.as_str());
        let requested_path = match input.path.as_deref() {
            Some(path) => Some(resolve_explicit_worktree_path(&input.cwd, path).await),
            None => None,
        };
        let path_policy = if requested_path.is_none() {
            Some(self.worktree_path_policy(&input.cwd).await?)
        } else {
            None
        };
        let existing_ref_is_local = input.new_ref_name.is_none()
            && self
                .local_branch_exists(&input.cwd, &input.ref_name, cancellation)
                .await?;
        if existing_ref_is_local {
            let worktrees = self.worktree_map(&input.cwd, cancellation).await?;
            if worktrees.contains_key(&input.ref_name) {
                return self
                    .create_suffixed_worktree_from_occupied_branch(
                        &input.cwd,
                        &input.ref_name,
                        requested_path.as_ref(),
                        path_policy.as_ref(),
                        cancellation,
                    )
                    .await;
            }
        }

        let path = requested_path.clone().unwrap_or_else(|| {
            path_policy
                .as_ref()
                .expect("implicit worktree path has a policy")
                .path_for(&input.cwd, target_ref)
        });
        let path_string = display_path(&path);
        let new_ref_existed = if let Some(new_ref) = input.new_ref_name.as_deref() {
            self.local_branch_exists(&input.cwd, new_ref, cancellation)
                .await?
        } else {
            false
        };
        let owned_path = if requested_path.is_none()
            && path_policy
                .as_ref()
                .and_then(WorktreePathPolicy::configured_base)
                .is_some()
        {
            Some(reserve_implicit_worktree_path(
                &input.cwd,
                &path,
                path_policy.as_ref().expect("implicit path has a policy"),
            )?)
        } else {
            None
        };
        let mut args = strings(&["worktree", "add"]);
        if let Some(new_ref) = input.new_ref_name.as_deref() {
            args.extend(["-b".into(), new_ref.into()]);
        }
        args.extend([path_string, input.ref_name.clone()]);
        if let Err(mut error) = self
            .run(
                "GitVcsDriver.createWorktree",
                &input.cwd,
                &args,
                cancellation,
            )
            .await
        {
            if let Some(owned_path) = owned_path.as_ref()
                && let Err(cleanup_error) =
                    self.cleanup_owned_worktree(&input.cwd, owned_path).await
            {
                error.detail = format!(
                    "{}\nOwned worktree cleanup also failed: {}",
                    error.detail, cleanup_error.detail
                )
                .into();
            }
            if let Some(new_ref) = input.new_ref_name.as_deref()
                && !new_ref_existed
                && let Err(rollback_error) = self.rollback_created_branch(&input.cwd, new_ref).await
            {
                error.detail = format!(
                    "{}\nWorktree branch rollback also failed: {}",
                    error.detail, rollback_error.detail
                )
                .into();
            }
            if input.new_ref_name.is_none()
                && existing_ref_is_local
                && self
                    .worktree_map(&input.cwd, cancellation)
                    .await?
                    .contains_key(&input.ref_name)
            {
                return self
                    .create_suffixed_worktree_from_occupied_branch(
                        &input.cwd,
                        &input.ref_name,
                        requested_path.as_ref(),
                        path_policy.as_ref(),
                        cancellation,
                    )
                    .await;
            }
            return Err(error);
        }
        let canonical_path = tokio::fs::canonicalize(&path).await.unwrap_or(path);
        let path_string = display_path(&canonical_path);
        if let (Some(new_ref), Some(base_ref)) = (
            input.new_ref_name.as_deref(),
            input.base_ref_name.as_deref(),
        ) {
            self.run(
                "GitVcsDriver.createWorktree.configureBaseRef",
                &input.cwd,
                &[
                    "config".into(),
                    format!("branch.{new_ref}.bibcode-base-ref"),
                    base_ref.into(),
                ],
                cancellation,
            )
            .await?;
        }
        Ok(VcsCreateWorktreeResult {
            worktree: VcsWorktree {
                path: path_string,
                ref_name: target_ref.to_owned(),
            },
            rollback: Some(ManagedWorktreeRollback {
                created_path: canonical_path,
                created_branch: input.new_ref_name.filter(|_| !new_ref_existed),
            }),
        })
    }

    pub async fn ensure_worktree(
        &self,
        input: CreateWorktreeInput,
        cancellation: &CancellationToken,
    ) -> Result<VcsCreateWorktreeResult, GitCommandError> {
        let target_ref = input
            .new_ref_name
            .as_deref()
            .unwrap_or(input.ref_name.as_str());
        if let Some(path) = self
            .worktree_map(&input.cwd, cancellation)
            .await?
            .get(target_ref)
        {
            return Ok(VcsCreateWorktreeResult {
                worktree: VcsWorktree {
                    path: path.clone(),
                    ref_name: target_ref.to_owned(),
                },
                rollback: None,
            });
        }
        self.create_worktree(input, cancellation).await
    }

    async fn create_suffixed_worktree_from_occupied_branch(
        &self,
        cwd: &Path,
        base_ref: &str,
        requested_path: Option<&PathBuf>,
        path_policy: Option<&WorktreePathPolicy>,
        cancellation: &CancellationToken,
    ) -> Result<VcsCreateWorktreeResult, GitCommandError> {
        for suffix in 2..(2 + MAX_AUTOMATIC_WORKTREE_SUFFIX_ATTEMPTS) {
            let candidate = format!("{base_ref}-{suffix}");
            if self
                .local_branch_exists(cwd, &candidate, cancellation)
                .await?
            {
                continue;
            }

            let path = requested_path.cloned().unwrap_or_else(|| {
                path_policy
                    .expect("implicit worktree path has a policy")
                    .path_for(cwd, &candidate)
            });
            let owned_path = match OwnedWorktreePath::reserve(path.clone()) {
                Ok(owned_path) => owned_path,
                Err(error)
                    if requested_path.is_none()
                        && error.kind() == io::ErrorKind::AlreadyExists
                        && (path_policy
                            .and_then(WorktreePathPolicy::configured_base)
                            .is_none()
                            || error.is_destination_collision()) =>
                {
                    continue;
                }
                Err(error) => {
                    return Err(worktree_reservation_error(
                        cwd,
                        &path,
                        error,
                        path_policy.and_then(WorktreePathPolicy::configured_base),
                    ));
                }
            };
            self.prepare_detached_owned_worktree(cwd, base_ref, &owned_path, cancellation)
                .await?;

            match self
                .checkout_owned_suffixed_branch(cwd, &owned_path, &candidate, cancellation)
                .await
            {
                Ok(()) => {
                    let canonical_path = tokio::fs::canonicalize(owned_path.path())
                        .await
                        .unwrap_or(path);
                    return Ok(VcsCreateWorktreeResult {
                        worktree: VcsWorktree {
                            path: display_path(&canonical_path),
                            ref_name: candidate.clone(),
                        },
                        rollback: Some(ManagedWorktreeRollback {
                            created_path: canonical_path,
                            created_branch: Some(candidate),
                        }),
                    });
                }
                Err(error) => {
                    if cancellation.is_cancelled() {
                        return Err(error);
                    }
                    let cleanup_token = CancellationToken::new();
                    let candidate_was_claimed = self
                        .local_branch_exists(cwd, &candidate, &cleanup_token)
                        .await?;
                    if candidate_was_claimed {
                        continue;
                    }
                    return Err(error);
                }
            }
        }

        Err(simple_error(
            "GitVcsDriver.createWorktree",
            cwd,
            &format!(
                "No available worktree branch was found for '{base_ref}' after {MAX_AUTOMATIC_WORKTREE_SUFFIX_ATTEMPTS} attempts. Remove an unused suffixed branch or choose another base."
            ),
        ))
    }

    async fn prepare_detached_owned_worktree(
        &self,
        cwd: &Path,
        base_ref: &str,
        owned_path: &OwnedWorktreePath,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        let args = vec![
            "worktree".into(),
            "add".into(),
            "--detach".into(),
            display_path(owned_path.path()),
            base_ref.into(),
        ];
        if let Err(mut error) = self
            .run("GitVcsDriver.createWorktree", cwd, &args, cancellation)
            .await
        {
            if let Err(cleanup_error) = self.cleanup_owned_worktree(cwd, owned_path).await {
                error.detail = format!(
                    "{}\nOwned worktree cleanup also failed: {}",
                    error.detail, cleanup_error.detail
                )
                .into();
            }
            return Err(error);
        }
        Ok(())
    }

    async fn checkout_owned_suffixed_branch(
        &self,
        cwd: &Path,
        owned_path: &OwnedWorktreePath,
        candidate: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        if let Err(mut error) = self
            .run(
                "GitVcsDriver.createWorktree.createBranch",
                owned_path.path(),
                &["checkout".into(), "-b".into(), candidate.into()],
                cancellation,
            )
            .await
        {
            let cleanup_token = CancellationToken::new();
            let canonical_owned_path = tokio::fs::canonicalize(owned_path.path())
                .await
                .unwrap_or_else(|_| owned_path.path().to_path_buf());
            let candidate_is_owned = match self.worktree_map(cwd, &cleanup_token).await {
                Ok(worktrees) => worktrees.get(candidate).is_some_and(|registered| {
                    same_worktree_path(registered, &canonical_owned_path)
                }),
                Err(inspection_error) => {
                    error.detail = format!(
                        "{}\nOwned worktree branch inspection also failed: {}",
                        error.detail, inspection_error.detail
                    )
                    .into();
                    false
                }
            };
            if let Err(cleanup_error) = self.cleanup_owned_worktree(cwd, owned_path).await {
                error.detail = format!(
                    "{}\nOwned worktree cleanup also failed: {}",
                    error.detail, cleanup_error.detail
                )
                .into();
            }
            if candidate_is_owned
                && let Err(rollback_error) = self.rollback_created_branch(cwd, candidate).await
            {
                error.detail = format!(
                    "{}\nWorktree branch rollback also failed: {}",
                    error.detail, rollback_error.detail
                )
                .into();
            }
            return Err(error);
        }
        Ok(())
    }

    async fn cleanup_owned_worktree(
        &self,
        cwd: &Path,
        owned_path: &OwnedWorktreePath,
    ) -> Result<(), GitCommandError> {
        let cleanup_token = CancellationToken::new();
        let mut args = strings(&["worktree", "remove", "--force", "--"]);
        args.push(display_path(owned_path.path()));
        let removal_error = self
            .run(
                "GitVcsDriver.createWorktree.cleanup",
                cwd,
                &args,
                &cleanup_token,
            )
            .await
            .err();
        let still_registered = self
            .worktree_paths(cwd, &cleanup_token)
            .await?
            .iter()
            .any(|registered| same_worktree_path(registered, owned_path.path()));
        if still_registered {
            return Err(removal_error.unwrap_or_else(|| {
                simple_error(
                    "GitVcsDriver.createWorktree.cleanup",
                    cwd,
                    &format!(
                        "The owned worktree '{}' is still registered after cleanup.",
                        display_path(owned_path.path())
                    ),
                )
            }));
        }
        match tokio::fs::symlink_metadata(owned_path.path()).await {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(simple_error(
                    "GitVcsDriver.createWorktree.cleanup",
                    cwd,
                    &format!(
                        "The owned worktree path '{}' could not be inspected after Git cleanup: {error}",
                        display_path(owned_path.path())
                    ),
                ));
            }
            Ok(_) => {}
        }
        let lease = open_removal_directory_lease_async(owned_path.path())
            .await
            .map_err(|error| {
                simple_error(
                    "GitVcsDriver.createWorktree.cleanup",
                    cwd,
                    &format!(
                        "The owned worktree path '{}' could not be bound for cleanup: {error}",
                        display_path(owned_path.path())
                    ),
                )
            })?;
        verify_owned_worktree_path_identity(&lease, owned_path.identity()).map_err(|error| {
            simple_error(
                "GitVcsDriver.createWorktree.cleanup",
                cwd,
                &format!(
                    "The owned worktree path '{}' was replaced before cleanup: {error}",
                    display_path(owned_path.path())
                ),
            )
        })?;
        remove_bound_owned_directory_with_lease(owned_path.path(), lease)
            .await
            .map_err(|error| {
                simple_error(
                    "GitVcsDriver.createWorktree.cleanup",
                    cwd,
                    &format!(
                        "The owned worktree path '{}' could not be removed: {error}",
                        display_path(owned_path.path())
                    ),
                )
            })
    }

    pub(crate) async fn rollback_managed_worktree_creation(
        &self,
        cwd: &Path,
        rollback: &ManagedWorktreeRollback,
    ) -> Result<(), GitCommandError> {
        let cancellation = CancellationToken::new();
        let created_key = canonical_worktree_path_key(&rollback.created_path)
            .await
            .map_err(|error| {
                simple_error(
                    "GitVcsDriver.createWorktree.rollback",
                    cwd,
                    &format!("The created worktree identity could not be verified: {error}"),
                )
            })?;
        let inventory = self.worktree_inventory(cwd, &cancellation).await?;
        let mut created_record = None;
        for record in inventory.records {
            let record_key = canonical_worktree_path_key(&record.path)
                .await
                .map_err(|error| {
                    simple_error(
                        "GitVcsDriver.createWorktree.rollback",
                        cwd,
                        &format!("A registered worktree identity could not be verified: {error}"),
                    )
                })?;
            if record_key == created_key {
                created_record = Some(record);
                break;
            }
        }
        let record = created_record.ok_or_else(|| {
            simple_error(
                "GitVcsDriver.createWorktree.rollback",
                cwd,
                "The exact created worktree is no longer registered.",
            )
        })?;
        if record.is_primary || record.is_bare {
            return Err(simple_error(
                "GitVcsDriver.createWorktree.rollback",
                cwd,
                "The exact created worktree resolved to a protected checkout.",
            ));
        }
        self.remove_worktree_verified(cwd, &record, true, &cancellation)
            .await?;
        if let Some(branch) = rollback.created_branch.as_deref() {
            self.rollback_created_branch(cwd, branch).await?;
        }
        Ok(())
    }

    async fn local_branch_exists(
        &self,
        cwd: &Path,
        branch: &str,
        cancellation: &CancellationToken,
    ) -> Result<bool, GitCommandError> {
        let output = self
            .execute(
                "GitVcsDriver.createWorktree.branchExists",
                cwd,
                &[
                    "show-ref".into(),
                    "--verify".into(),
                    "--quiet".into(),
                    format!("refs/heads/{branch}"),
                ],
                true,
                cancellation,
            )
            .await?;
        match output.exit_code {
            0 => Ok(true),
            1 => Ok(false),
            _ => Err(command_output_error(
                "GitVcsDriver.createWorktree.branchExists",
                cwd,
                4,
                &output,
                &actionable_git_failure(&output.stderr, &output.stdout),
            )),
        }
    }

    async fn rollback_created_branch(
        &self,
        cwd: &Path,
        branch: &str,
    ) -> Result<(), GitCommandError> {
        let cancellation = CancellationToken::new();
        if !self.local_branch_exists(cwd, branch, &cancellation).await? {
            return Ok(());
        }
        self.run(
            "GitVcsDriver.createWorktree.rollbackBranch",
            cwd,
            &["branch".into(), "-D".into(), "--".into(), branch.into()],
            &cancellation,
        )
        .await?;
        Ok(())
    }

    pub async fn remove_worktree(
        &self,
        cwd: &Path,
        path: &Path,
        force: bool,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        let registered_paths = self.worktree_paths(cwd, cancellation).await?;
        let registered_index = registered_worktree_path_index(
            "GitVcsDriver.removeWorktree.identity",
            cwd,
            &registered_paths,
            path,
        )
        .await?;
        let was_registered = registered_index.is_some();
        if force && registered_index.is_some_and(|index| index > 0) {
            let nonce = self
                .prepare_worktree_removal_identity(cwd, path, cancellation)
                .await?;
            return self
                .remove_worktree_with_identity(cwd, path, true, &nonce, cancellation)
                .await;
        }
        if force && !was_registered && self.is_managed_orphaned_worktree_path(cwd, path).await {
            let nonce = self
                .prepare_worktree_removal_identity(cwd, path, cancellation)
                .await?;
            return self
                .remove_worktree_with_identity(cwd, path, true, &nonce, cancellation)
                .await;
        }
        let mut args = strings(&["worktree", "remove"]);
        if force {
            args.push("--force".into());
        }
        args.push(display_path(path));
        let error = match self
            .run("GitVcsDriver.removeWorktree", cwd, &args, cancellation)
            .await
        {
            Ok(_) => return Ok(()),
            Err(error) => error,
        };
        let Ok(paths) = self.worktree_paths(cwd, cancellation).await else {
            return Err(error);
        };
        if !matches!(
            registered_worktree_path_index(
                "GitVcsDriver.removeWorktree.verifyIdentity",
                cwd,
                &paths,
                path,
            )
            .await,
            Ok(None)
        ) {
            return Err(error);
        }
        if !path.exists() {
            return Ok(());
        }
        if !was_registered {
            return Err(error);
        }
        Err(with_filesystem_cleanup_deferred(error, path))
    }

    async fn is_managed_orphaned_worktree_path(&self, cwd: &Path, path: &Path) -> bool {
        let Ok(metadata) = tokio::fs::symlink_metadata(path).await else {
            return false;
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || tokio::fs::symlink_metadata(path.join(".git")).await.is_ok()
        {
            return false;
        }
        let Ok(path_policy) = self.worktree_path_policy(cwd).await else {
            return false;
        };
        let expected_path = path_policy.path_for(cwd, "managed-orphan-candidate");
        let Some(expected_parent) = expected_path.parent() else {
            return false;
        };
        let (Ok(canonical_expected_parent), Ok(canonical_path)) = (
            tokio::fs::canonicalize(expected_parent).await,
            tokio::fs::canonicalize(path).await,
        ) else {
            return false;
        };
        canonical_path.parent() == Some(canonical_expected_parent.as_path())
    }

    pub async fn prepare_worktree_removal_identity(
        &self,
        cwd: &Path,
        path: &Path,
        cancellation: &CancellationToken,
    ) -> Result<String, GitCommandError> {
        if cancellation.is_cancelled() {
            return Err(worktree_identity_marker_error(
                cwd,
                path,
                "removal was cancelled before identity preparation",
            ));
        }
        let admin_path = self
            .registered_linked_worktree_admin_path(cwd, path, cancellation)
            .await;
        if admin_path.is_none() && !self.is_managed_orphaned_worktree_path(cwd, path).await {
            return Err(registered_worktree_identity_error(cwd, path));
        }

        let admin_marker = admin_path
            .as_ref()
            .map(|admin_path| admin_path.join(WORKTREE_REMOVAL_IDENTITY_FILE));
        let root_marker = path.join(WORKTREE_REMOVAL_ROOT_IDENTITY_FILE);
        let admin_nonce = match &admin_marker {
            Some(marker) => read_optional_identity_marker(marker)
                .await
                .map_err(|error| worktree_identity_marker_error(cwd, path, &error.to_string()))?,
            None => None,
        };
        let root_nonce = read_optional_identity_marker(&root_marker)
            .await
            .map_err(|error| worktree_identity_marker_error(cwd, path, &error.to_string()))?;
        if let (Some(admin_nonce), Some(root_nonce)) = (&admin_nonce, &root_nonce)
            && admin_nonce != root_nonce
        {
            return Err(worktree_identity_marker_error(
                cwd,
                path,
                "the Git administration and worktree identity markers disagree",
            ));
        }
        let nonce = admin_nonce
            .or(root_nonce)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if Uuid::parse_str(&nonce).is_err() {
            return Err(worktree_identity_marker_error(
                cwd,
                path,
                "the existing identity marker is not a valid removal nonce",
            ));
        }
        if let Some(marker) = admin_marker
            && !tokio::fs::try_exists(&marker).await.unwrap_or(false)
        {
            write_durable_identity_marker(marker, nonce.clone())
                .await
                .map_err(|error| worktree_identity_marker_error(cwd, path, &error.to_string()))?;
        }
        if !tokio::fs::try_exists(&root_marker).await.unwrap_or(false) {
            write_durable_identity_marker(root_marker, nonce.clone())
                .await
                .map_err(|error| worktree_identity_marker_error(cwd, path, &error.to_string()))?;
        }
        Ok(nonce)
    }

    pub async fn verify_worktree_removal_identity(
        &self,
        cwd: &Path,
        path: &Path,
        expected_nonce: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        verify_identity_marker(
            cwd,
            path,
            &path.join(WORKTREE_REMOVAL_ROOT_IDENTITY_FILE),
            expected_nonce,
        )
        .await?;
        if let Some(admin_path) = self
            .registered_linked_worktree_admin_path(cwd, path, cancellation)
            .await
        {
            verify_identity_marker(
                cwd,
                path,
                &admin_path.join(WORKTREE_REMOVAL_IDENTITY_FILE),
                expected_nonce,
            )
            .await
        } else if self.is_managed_orphaned_worktree_path(cwd, path).await {
            Ok(())
        } else {
            Err(registered_worktree_identity_error(cwd, path))
        }
    }

    pub async fn remove_worktree_with_identity(
        &self,
        cwd: &Path,
        path: &Path,
        force: bool,
        expected_nonce: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        if !force {
            return Err(simple_error(
                "GitVcsDriver.removeWorktree",
                cwd,
                "Protected worktree removal requires explicit force confirmation.",
            ));
        }
        let quarantine = worktree_removal_quarantine_path(path, expected_nonce)
            .map_err(|error| worktree_identity_marker_error(cwd, path, &error.to_string()))?;
        let admin_quarantine = self
            .worktree_removal_admin_quarantine_path(cwd, expected_nonce, cancellation)
            .await?;
        let registered_paths = self.worktree_paths(cwd, cancellation).await?;
        let was_registered = registered_worktree_path_index(
            "GitVcsDriver.removeWorktree.identity",
            cwd,
            &registered_paths,
            path,
        )
        .await?
        .is_some();
        let path_exists = tokio::fs::symlink_metadata(path).await.is_ok();
        let quarantine_exists = tokio::fs::symlink_metadata(&quarantine).await.is_ok();

        if !quarantine_exists && !path_exists {
            if was_registered {
                return Err(worktree_identity_marker_error(
                    cwd,
                    path,
                    "Git still registers the worktree, but neither its directory nor its durable quarantine exists",
                ));
            }
            if tokio::fs::symlink_metadata(&admin_quarantine).await.is_ok() {
                let admin_lease = open_removal_directory_lease_async(&admin_quarantine)
                    .await
                    .map_err(|error| worktree_cleanup_error(cwd, &admin_quarantine, &error))?;
                remove_bound_identity_directory_with_lease(
                    &admin_quarantine,
                    WORKTREE_REMOVAL_IDENTITY_FILE,
                    expected_nonce,
                    cancellation,
                    admin_lease,
                )
                .await
                .map_err(|error| worktree_cleanup_error(cwd, &admin_quarantine, &error))?;
            }
            return Ok(());
        }

        if quarantine_exists
            && tokio::fs::symlink_metadata(quarantine.join(WORKTREE_REMOVAL_ROOT_IDENTITY_FILE))
                .await
                .is_err()
        {
            if was_registered {
                return Err(worktree_identity_marker_error(
                    cwd,
                    path,
                    "Git still registers the worktree, but its durable quarantine has no removal identity",
                ));
            }
            let quarantine_lease = open_removal_directory_lease_async(&quarantine)
                .await
                .map_err(|error| worktree_cleanup_error(cwd, &quarantine, &error))?;
            remove_bound_identity_directory_with_lease(
                &quarantine,
                WORKTREE_REMOVAL_ROOT_IDENTITY_FILE,
                expected_nonce,
                cancellation,
                quarantine_lease,
            )
            .await
            .map_err(|error| worktree_cleanup_error(cwd, &quarantine, &error))?;
            if tokio::fs::symlink_metadata(&admin_quarantine).await.is_ok() {
                let admin_lease = open_removal_directory_lease_async(&admin_quarantine)
                    .await
                    .map_err(|error| worktree_cleanup_error(cwd, &admin_quarantine, &error))?;
                remove_bound_identity_directory_with_lease(
                    &admin_quarantine,
                    WORKTREE_REMOVAL_IDENTITY_FILE,
                    expected_nonce,
                    cancellation,
                    admin_lease,
                )
                .await
                .map_err(|error| worktree_cleanup_error(cwd, &admin_quarantine, &error))?;
            }
            return Ok(());
        }

        let (quarantine_lease, tombstone_lease) = if !quarantine_exists {
            self.verify_worktree_removal_identity(cwd, path, expected_nonce, cancellation)
                .await?;
            quarantine_worktree_with_tombstone(path, &quarantine, expected_nonce, cancellation)
                .await
                .map_err(|error| worktree_removal_admission_error(cwd, path, &error))?
        } else {
            let quarantine_lease = open_removal_directory_lease_async(&quarantine)
                .await
                .map_err(|error| worktree_identity_marker_error(cwd, path, &error.to_string()))?;
            verify_identity_marker(
                cwd,
                path,
                &quarantine.join(WORKTREE_REMOVAL_ROOT_IDENTITY_FILE),
                expected_nonce,
            )
            .await?;
            let tombstone_lease =
                ensure_worktree_removal_tombstone(path, &quarantine, expected_nonce)
                    .await
                    .map_err(|error| {
                        worktree_identity_marker_error(cwd, path, &error.to_string())
                    })?;
            (quarantine_lease, tombstone_lease)
        };

        verify_identity_marker(
            cwd,
            path,
            &quarantine.join(WORKTREE_REMOVAL_ROOT_IDENTITY_FILE),
            expected_nonce,
        )
        .await?;
        let admin_quarantine_lease = if tokio::fs::symlink_metadata(&admin_quarantine).await.is_ok()
        {
            Some(
                open_removal_directory_lease_async(&admin_quarantine)
                    .await
                    .map_err(|error| {
                        worktree_identity_marker_error(cwd, path, &error.to_string())
                    })?,
            )
        } else {
            None
        };
        let admin_source = if admin_quarantine_lease.is_some() {
            None
        } else {
            self.linked_worktree_admin_path_from_quarantine(cwd, &quarantine, cancellation)
                .await
        };
        let admin_source_lease = if admin_quarantine_lease.is_none() && was_registered {
            let admin_source = admin_source
                .as_deref()
                .ok_or_else(|| registered_worktree_identity_error(cwd, path))?;
            Some(
                open_removal_directory_lease_async(admin_source)
                    .await
                    .map_err(|error| {
                        worktree_identity_marker_error(cwd, path, &error.to_string())
                    })?,
            )
        } else {
            None
        };
        let (quarantine_lease, admin_quarantine_lease) =
            deregister_worktree_admin_and_remove_tombstone(
                path,
                &quarantine,
                admin_source.as_deref(),
                &admin_quarantine,
                expected_nonce,
                WorktreeDeregistrationLeases {
                    quarantine: quarantine_lease,
                    tombstone: tombstone_lease,
                    admin_quarantine: admin_quarantine_lease,
                    admin_source: admin_source_lease,
                },
            )
            .await
            .map_err(|error| worktree_identity_marker_error(cwd, path, &error.to_string()))?;

        remove_bound_identity_directory_with_lease(
            &quarantine,
            WORKTREE_REMOVAL_ROOT_IDENTITY_FILE,
            expected_nonce,
            cancellation,
            quarantine_lease,
        )
        .await
        .map_err(|error| worktree_cleanup_error(cwd, &quarantine, &error))?;
        if let Some(admin_lease) = admin_quarantine_lease {
            remove_bound_identity_directory_with_lease(
                &admin_quarantine,
                WORKTREE_REMOVAL_IDENTITY_FILE,
                expected_nonce,
                cancellation,
                admin_lease,
            )
            .await
            .map_err(|error| worktree_cleanup_error(cwd, &admin_quarantine, &error))?;
        }
        Ok(())
    }

    async fn worktree_removal_admin_quarantine_path(
        &self,
        cwd: &Path,
        nonce: &str,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, GitCommandError> {
        let output = self
            .run(
                "GitVcsDriver.removeWorktree.commonDir",
                cwd,
                &strings(&["rev-parse", "--git-common-dir"]),
                cancellation,
            )
            .await?;
        let common_dir = resolve_git_metadata_path(cwd, output.stdout.trim());
        let common_dir = tokio::fs::canonicalize(&common_dir)
            .await
            .unwrap_or(common_dir);
        Ok(common_dir.join("bibcode-worktree-removals").join(nonce))
    }

    async fn linked_worktree_admin_path_from_quarantine(
        &self,
        cwd: &Path,
        quarantine: &Path,
        cancellation: &CancellationToken,
    ) -> Option<PathBuf> {
        let git_file = quarantine.join(".git");
        let metadata = tokio::fs::symlink_metadata(&git_file).await.ok()?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return None;
        }
        let contents = tokio::fs::read_to_string(&git_file).await.ok()?;
        let raw_admin_path = contents.trim().strip_prefix("gitdir: ")?;
        let canonical_admin_path =
            tokio::fs::canonicalize(resolve_git_metadata_path(quarantine, raw_admin_path))
                .await
                .ok()?;
        let output = self
            .run(
                "GitVcsDriver.removeWorktree.commonDir",
                cwd,
                &strings(&["rev-parse", "--git-common-dir"]),
                cancellation,
            )
            .await
            .ok()?;
        let common_dir = resolve_git_metadata_path(cwd, output.stdout.trim());
        let canonical_worktrees_dir = tokio::fs::canonicalize(common_dir.join("worktrees"))
            .await
            .ok()?;
        canonical_admin_path
            .parent()
            .is_some_and(|parent| same_path(parent, &canonical_worktrees_dir))
            .then_some(canonical_admin_path)
    }

    async fn registered_linked_worktree_admin_path(
        &self,
        cwd: &Path,
        path: &Path,
        cancellation: &CancellationToken,
    ) -> Option<PathBuf> {
        let git_file = path.join(".git");
        let Ok(metadata) = tokio::fs::symlink_metadata(&git_file).await else {
            return None;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return None;
        }
        let Ok(contents) = tokio::fs::read_to_string(&git_file).await else {
            return None;
        };
        let raw_admin_path = contents.trim().strip_prefix("gitdir: ")?;
        let admin_path = resolve_git_metadata_path(path, raw_admin_path);
        let Ok(canonical_admin_path) = tokio::fs::canonicalize(&admin_path).await else {
            return None;
        };
        let Ok(common_dir_output) = self
            .run(
                "GitVcsDriver.removeWorktree.commonDir",
                cwd,
                &strings(&["rev-parse", "--git-common-dir"]),
                cancellation,
            )
            .await
        else {
            return None;
        };
        let common_dir = resolve_git_metadata_path(cwd, common_dir_output.stdout.trim());
        let Ok(canonical_worktrees_dir) =
            tokio::fs::canonicalize(common_dir.join("worktrees")).await
        else {
            return None;
        };
        if !canonical_admin_path
            .parent()
            .is_some_and(|parent| same_path(parent, &canonical_worktrees_dir))
        {
            return None;
        }
        let Ok(backlink) = tokio::fs::read_to_string(canonical_admin_path.join("gitdir")).await
        else {
            return None;
        };
        let backlink_path = resolve_git_metadata_path(&canonical_admin_path, backlink.trim());
        let (Ok(canonical_backlink), Ok(canonical_git_file)) = (
            tokio::fs::canonicalize(backlink_path).await,
            tokio::fs::canonicalize(git_file).await,
        ) else {
            return None;
        };
        same_path(&canonical_backlink, &canonical_git_file).then_some(canonical_admin_path)
    }

    pub async fn create_ref(
        &self,
        cwd: &Path,
        ref_name: &str,
        switch_ref: bool,
        cancellation: &CancellationToken,
    ) -> Result<String, GitCommandError> {
        let args = if switch_ref {
            vec!["switch".into(), "-c".into(), ref_name.into()]
        } else {
            vec!["branch".into(), ref_name.into()]
        };
        self.run("GitVcsDriver.createRef", cwd, &args, cancellation)
            .await?;
        Ok(ref_name.to_owned())
    }

    pub async fn switch_ref(
        &self,
        cwd: &Path,
        ref_name: &str,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, GitCommandError> {
        self.run(
            "GitVcsDriver.switchRef",
            cwd,
            &["switch".into(), ref_name.into()],
            cancellation,
        )
        .await?;
        self.current_ref(cwd, cancellation).await
    }

    pub async fn rename_ref(
        &self,
        cwd: &Path,
        old_ref: &str,
        new_ref: &str,
        cancellation: &CancellationToken,
    ) -> Result<String, GitCommandError> {
        if old_ref == new_ref {
            return Ok(new_ref.to_owned());
        }
        self.run(
            "GitVcsDriver.renameBranch",
            cwd,
            &["branch".into(), "-m".into(), old_ref.into(), new_ref.into()],
            cancellation,
        )
        .await?;
        Ok(new_ref.to_owned())
    }

    pub async fn init(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        self.run(
            "GitVcsDriver.initRepo",
            cwd,
            &strings(&["init"]),
            cancellation,
        )
        .await?;
        Ok(())
    }

    pub async fn clone_repository(
        &self,
        url: &str,
        parent_dir: &Path,
        directory_name: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, GitCommandError> {
        let derived = directory_name.map_or_else(
            || {
                url.trim_end_matches(['/', '\\'])
                    .rsplit(['/', '\\', ':'])
                    .next()
                    .unwrap_or("repository")
                    .trim_end_matches(".git")
                    .to_owned()
            },
            str::to_owned,
        );
        let destination = parent_dir.join(&derived);
        match tokio::fs::symlink_metadata(&destination).await {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return Err(simple_error(
                        CLONE_OPERATION,
                        parent_dir,
                        "Existing clone destination is not a Git repository.",
                    ));
                }
                return self
                    .reuse_existing_clone(url, &destination, cancellation)
                    .await;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(simple_error(
                    CLONE_OPERATION,
                    parent_dir,
                    &format!("Failed to inspect the existing clone destination: {error}"),
                ));
            }
        }
        self.run(
            CLONE_OPERATION,
            parent_dir,
            &["clone".into(), "--".into(), url.into(), derived.clone()],
            cancellation,
        )
        .await?;
        Ok(destination)
    }

    async fn reuse_existing_clone(
        &self,
        url: &str,
        destination: &Path,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, GitCommandError> {
        let Some(repository_root) = self.repository_root(destination, cancellation).await? else {
            return Err(simple_error(
                CLONE_OPERATION,
                destination,
                "Existing clone destination is not a Git repository.",
            ));
        };
        let canonical_destination =
            tokio::fs::canonicalize(destination)
                .await
                .map_err(|error| {
                    simple_error(
                        CLONE_OPERATION,
                        destination,
                        &format!("Failed to inspect the existing clone destination: {error}"),
                    )
                })?;
        let canonical_repository_root =
            tokio::fs::canonicalize(&repository_root)
                .await
                .map_err(|error| {
                    simple_error(
                        CLONE_OPERATION,
                        destination,
                        &format!("Failed to inspect the existing Git repository root: {error}"),
                    )
                })?;
        if canonical_destination != canonical_repository_root {
            return Err(simple_error(
                CLONE_OPERATION,
                destination,
                "Existing clone destination is not a Git repository root.",
            ));
        }
        let origin = self
            .execute(
                "GitVcsDriver.clone.inspectOrigin",
                destination,
                &strings(&["config", "--get", "remote.origin.url"]),
                true,
                cancellation,
            )
            .await?;
        if origin.exit_code != 0 {
            return Err(simple_error(
                CLONE_OPERATION,
                destination,
                "Existing Git repository does not have an origin remote.",
            ));
        }
        if origin.stdout.trim() != url {
            return Err(simple_error(
                CLONE_OPERATION,
                destination,
                "Existing Git repository has a different origin.",
            ));
        }
        Ok(destination.to_path_buf())
    }

    pub async fn pull_current_branch(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsPullResult, GitCommandError> {
        let ref_name = self.current_ref(cwd, cancellation).await?.ok_or_else(|| {
            simple_error(
                "GitVcsDriver.pullCurrentBranch",
                cwd,
                "Cannot pull from detached HEAD.",
            )
        })?;
        let upstream = self
            .execute(
                "GitVcsDriver.pullCurrentBranch.upstream",
                cwd,
                &strings(&["rev-parse", "--abbrev-ref", "@{upstream}"]),
                true,
                cancellation,
            )
            .await?;
        let upstream_ref = (upstream.exit_code == 0)
            .then(|| upstream.stdout.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                simple_error(
                    "GitVcsDriver.pullCurrentBranch",
                    cwd,
                    "Current branch has no upstream.",
                )
            })?;
        let before = self
            .run(
                "GitVcsDriver.pullCurrentBranch.before",
                cwd,
                &strings(&["rev-parse", "HEAD"]),
                cancellation,
            )
            .await?;
        self.run(
            "GitVcsDriver.pullCurrentBranch",
            cwd,
            &strings(&["pull", "--ff-only"]),
            cancellation,
        )
        .await?;
        let after = self
            .run(
                "GitVcsDriver.pullCurrentBranch.after",
                cwd,
                &strings(&["rev-parse", "HEAD"]),
                cancellation,
            )
            .await?;
        Ok(VcsPullResult {
            status: if before.stdout.trim() == after.stdout.trim() {
                PullStatus::SkippedUpToDate
            } else {
                PullStatus::Pulled
            },
            ref_name,
            upstream_ref: Some(upstream_ref),
        })
    }

    pub async fn commit(
        &self,
        cwd: &Path,
        message: &str,
        file_paths: Option<&[String]>,
        preserve_index: bool,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, GitCommandError> {
        if !preserve_index {
            if let Some(paths) = file_paths.filter(|paths| !paths.is_empty()) {
                let _ = self
                    .execute(
                        "GitVcsDriver.prepareCommitContext.reset",
                        cwd,
                        &strings(&["reset"]),
                        true,
                        cancellation,
                    )
                    .await?;
                let mut args = strings(&["add", "-A", "--"]);
                args.extend(paths.iter().cloned());
                self.run(
                    "GitVcsDriver.prepareCommitContext.addSelected",
                    cwd,
                    &args,
                    cancellation,
                )
                .await?;
            } else {
                self.run(
                    "GitVcsDriver.prepareCommitContext.addAll",
                    cwd,
                    &strings(&["add", "-A"]),
                    cancellation,
                )
                .await?;
            }
        }
        let staged = self
            .run(
                "GitVcsDriver.prepareCommitContext.stagedSummary",
                cwd,
                &strings(&["diff", "--cached", "--name-status"]),
                cancellation,
            )
            .await?;
        if staged.stdout.trim().is_empty() {
            return Ok(None);
        }
        self.run(
            "GitVcsDriver.commit",
            cwd,
            &["commit".into(), "-m".into(), message.into()],
            cancellation,
        )
        .await?;
        let sha = self
            .run(
                "GitVcsDriver.commit.sha",
                cwd,
                &strings(&["rev-parse", "HEAD"]),
                cancellation,
            )
            .await?;
        Ok(Some(sha.stdout.trim().to_owned()))
    }

    pub async fn push_current_branch(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<String, GitCommandError> {
        let branch = self.current_ref(cwd, cancellation).await?.ok_or_else(|| {
            simple_error(
                "GitVcsDriver.pushCurrentBranch",
                cwd,
                "Cannot push from detached HEAD.",
            )
        })?;
        let upstream = self
            .execute(
                "GitVcsDriver.pushCurrentBranch.upstream",
                cwd,
                &strings(&["rev-parse", "--abbrev-ref", "@{upstream}"]),
                true,
                cancellation,
            )
            .await?;
        let args = if upstream.exit_code == 0 {
            strings(&["push"])
        } else {
            vec![
                "push".into(),
                "--set-upstream".into(),
                "origin".into(),
                branch.clone(),
            ]
        };
        self.run("GitVcsDriver.pushCurrentBranch", cwd, &args, cancellation)
            .await?;
        Ok(branch)
    }

    pub async fn commit_context(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<String, GitCommandError> {
        let staged = self
            .run(
                "GitVcsDriver.commitContext.staged",
                cwd,
                &strings(&["diff", "--cached", "--patch", "--stat"]),
                cancellation,
            )
            .await?;
        if !staged.stdout.trim().is_empty() {
            return Ok(staged.stdout);
        }
        let working = self
            .run(
                "GitVcsDriver.commitContext.working",
                cwd,
                &strings(&["diff", "--patch", "--stat"]),
                cancellation,
            )
            .await?;
        Ok(working.stdout)
    }

    pub(super) async fn current_ref(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, GitCommandError> {
        let result = self
            .execute(
                "GitVcsDriver.currentRef",
                cwd,
                &strings(&["symbolic-ref", "--quiet", "--short", "HEAD"]),
                true,
                cancellation,
            )
            .await?;
        Ok((result.exit_code == 0)
            .then(|| result.stdout.trim().to_owned())
            .filter(|value| !value.is_empty()))
    }

    async fn default_ref(
        &self,
        cwd: &Path,
        current: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, GitCommandError> {
        let origin_head = self
            .execute(
                "GitVcsDriver.defaultRef.originHead",
                cwd,
                &strings(&["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
                true,
                cancellation,
            )
            .await?;
        if origin_head.exit_code == 0 {
            let value = origin_head
                .stdout
                .trim()
                .trim_start_matches("refs/remotes/origin/")
                .to_owned();
            if !value.is_empty() {
                return Ok(Some(value));
            }
        }
        for candidate in ["main", "master"] {
            let result = self
                .execute(
                    "GitVcsDriver.defaultRef.candidate",
                    cwd,
                    &[
                        "show-ref".into(),
                        "--verify".into(),
                        "--quiet".into(),
                        format!("refs/heads/{candidate}"),
                    ],
                    true,
                    cancellation,
                )
                .await?;
            if result.exit_code == 0 || current == Some(candidate) {
                return Ok(Some(candidate.to_owned()));
            }
        }
        Ok(current.map(str::to_owned))
    }

    async fn remote_provider(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<SourceControlProviderInfo>, GitCommandError> {
        let remote = self
            .execute(
                "GitVcsDriver.remoteProvider",
                cwd,
                &strings(&["config", "--get", "remote.origin.url"]),
                true,
                cancellation,
            )
            .await?;
        Ok((remote.exit_code == 0)
            .then(|| provider_info(remote.stdout.trim()))
            .flatten())
    }

    async fn worktree_map(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<HashMap<String, String>, GitCommandError> {
        let output = self
            .run(
                "GitVcsDriver.listRefs.worktreeList",
                cwd,
                &strings(&["worktree", "list", "--porcelain"]),
                cancellation,
            )
            .await?;
        let mut map = HashMap::new();
        let mut path: Option<String> = None;
        for line in output.stdout.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                path = Some(value.to_owned());
            } else if let (Some(branch), Some(path)) =
                (line.strip_prefix("branch refs/heads/"), path.as_ref())
            {
                map.insert(branch.to_owned(), display_path(Path::new(path)));
            } else if line.is_empty() {
                path = None;
            }
        }
        Ok(map)
    }

    async fn worktree_paths(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Vec<String>, GitCommandError> {
        let output = self
            .run(
                "GitVcsDriver.worktreePaths",
                cwd,
                &strings(&["worktree", "list", "--porcelain"]),
                cancellation,
            )
            .await?;
        Ok(output
            .stdout
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .map(|path| display_path(Path::new(path)))
            .collect())
    }
}

async fn read_optional_identity_marker(path: &Path) -> Result<Option<String>, io::Error> {
    match tokio::fs::read_to_string(path).await {
        Ok(value) if value.trim().is_empty() => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the identity marker is empty",
        )),
        Ok(value) => Ok(Some(value.trim().to_owned())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

async fn verify_identity_marker(
    cwd: &Path,
    worktree_path: &Path,
    marker_path: &Path,
    expected_nonce: &str,
) -> Result<(), GitCommandError> {
    let marker = read_optional_identity_marker(marker_path)
        .await
        .map_err(|error| worktree_identity_marker_error(cwd, worktree_path, &error.to_string()))?;
    if marker.as_deref() != Some(expected_nonce) {
        return Err(worktree_identity_marker_error(
            cwd,
            worktree_path,
            "the current directory has a different removal identity",
        ));
    }
    Ok(())
}

async fn write_durable_identity_marker(path: PathBuf, nonce: String) -> Result<(), io::Error> {
    tokio::task::spawn_blocking(move || {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "identity marker has no parent")
        })?;
        let staged = parent.join(format!(
            ".{}.{}.tmp",
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("bibcode-removal-identity"),
            Uuid::new_v4()
        ));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)?;
            file.write_all(nonce.as_bytes())?;
            file.sync_all()?;
            drop(file);
            rename_path_blocking(&staged, &path)?;
            sync_directory_blocking(parent)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&staged);
        }
        result
    })
    .await
    .map_err(|error| io::Error::other(format!("identity marker task failed: {error}")))?
}

fn sync_directory_blocking(path: &Path) -> Result<(), io::Error> {
    #[cfg(windows)]
    {
        // Windows directory handles do not reliably support FlushFileBuffers. File contents are
        // synced before publication and every safety-critical rename uses MOVEFILE_WRITE_THROUGH.
        let _ = path;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::File::open(path)?.sync_all()
    }
}

#[cfg(windows)]
fn rename_path_blocking(source: &Path, destination: &Path) -> Result<(), io::Error> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: Both paths are valid NUL-terminated UTF-16 strings and remain alive for the call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } != 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
fn rename_path_blocking(source: &Path, destination: &Path) -> Result<(), io::Error> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn rename_bound_directory_blocking(
    lease: &RemovalDirectoryLease,
    source: &Path,
    destination: &Path,
) -> Result<(), io::Error> {
    use std::{
        mem::{offset_of, size_of},
        os::windows::{ffi::OsStrExt, io::AsRawHandle},
    };

    use windows_sys::Win32::Storage::FileSystem::{
        FILE_RENAME_INFO, FileRenameInfo, SetFileInformationByHandle,
    };

    verify_removal_directory_lease(lease, source)?;
    match fs::symlink_metadata(destination) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "the bound rename destination already exists",
            ));
        }
    }
    let destination = if destination.is_absolute() {
        destination.to_path_buf()
    } else {
        std::env::current_dir()?.join(destination)
    };
    let destination_name = destination.as_os_str().encode_wide().collect::<Vec<_>>();
    if destination_name.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "rename destination contains an interior NUL",
        ));
    }
    let header_size = offset_of!(FILE_RENAME_INFO, FileName);
    let information_size =
        size_of::<FILE_RENAME_INFO>() + destination_name.len() * size_of::<u16>();
    let mut information = vec![0usize; information_size.div_ceil(size_of::<usize>())];
    let information_ptr = information.as_mut_ptr().cast::<u8>();
    // SAFETY: information is pointer-aligned, sized for the FILE_RENAME_INFO header plus the
    // UTF-16 name, and all referenced handles and buffers remain alive through the system call.
    unsafe {
        let rename = information_ptr.cast::<FILE_RENAME_INFO>();
        (*rename).Anonymous.ReplaceIfExists = false;
        (*rename).RootDirectory = std::ptr::null_mut();
        (*rename).FileNameLength = (destination_name.len() * size_of::<u16>()) as u32;
        std::ptr::copy_nonoverlapping(
            destination_name.as_ptr(),
            information_ptr.add(header_size).cast::<u16>(),
            destination_name.len(),
        );
        if SetFileInformationByHandle(
            lease.handle.as_raw_handle(),
            FileRenameInfo,
            information_ptr.cast(),
            information_size as u32,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    verify_removal_directory_lease(lease, &destination)
}

#[cfg(not(windows))]
fn rename_bound_directory_blocking(
    lease: &RemovalDirectoryLease,
    source: &Path,
    destination: &Path,
) -> Result<(), io::Error> {
    verify_removal_directory_lease(lease, source)?;
    fs::rename(source, destination)?;
    verify_removal_directory_lease(lease, destination)
}

fn worktree_removal_quarantine_path(path: &Path, nonce: &str) -> Result<PathBuf, io::Error> {
    Uuid::parse_str(nonce).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the removal identity is not a valid UUID",
        )
    })?;
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "worktree path has no parent directory",
        )
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "worktree path has no file name",
        )
    })?;
    Ok(parent.join(format!(
        ".{}.bibcode-removal-{nonce}",
        file_name.to_string_lossy()
    )))
}

async fn quarantine_worktree_with_tombstone(
    source: &Path,
    quarantine: &Path,
    nonce: &str,
    cancellation: &CancellationToken,
) -> Result<(RemovalDirectoryLease, RemovalDirectoryLease), io::Error> {
    if cancellation.is_cancelled() {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "worktree removal was cancelled",
        ));
    }
    let source = source.to_path_buf();
    let quarantine = quarantine.to_path_buf();
    let nonce = nonce.to_owned();
    let cancellation = cancellation.clone();
    tokio::task::spawn_blocking(move || {
        let lease = open_removal_directory_lease(&source)?;
        verify_identity_marker_blocking(
            &source,
            WORKTREE_REMOVAL_ROOT_IDENTITY_FILE,
            &nonce,
        )?;
        verify_removal_directory_lease(&lease, &source)?;
        if cancellation.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "worktree removal was cancelled",
            ));
        }
        rename_bound_directory_blocking(&lease, &source, &quarantine)?;
        let parent = source.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "worktree path has no parent")
        })?;
        if let Err(error) = verify_identity_marker_blocking(
            &quarantine,
            WORKTREE_REMOVAL_ROOT_IDENTITY_FILE,
            &nonce,
        ) {
            let rollback = rename_bound_directory_blocking(&lease, &quarantine, &source);
            let _ = sync_directory_blocking(parent);
            return match rollback {
                Ok(()) => Err(io::Error::new(
                    error.kind(),
                    format!(
                        "the directory moved into worktree quarantine did not have the admitted identity: {error}"
                    ),
                )),
                Err(rollback_error) => Err(io::Error::new(
                    error.kind(),
                    format!(
                        "the directory moved into worktree quarantine did not have the admitted identity: {error}; rollback retained it at '{}': {rollback_error}",
                        display_path(&quarantine)
                    ),
                )),
            };
        }
        let tombstone_lease = match sync_directory_blocking(parent).and_then(|()| {
            create_worktree_removal_tombstone_blocking(&source, &quarantine, &nonce)
        }) {
            Ok(lease) => lease,
            Err(error) => {
            let rollback = rename_bound_directory_blocking(&lease, &quarantine, &source);
            return match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(io::Error::new(
                    error.kind(),
                    format!(
                        "worktree quarantine admission failed: {error}; rollback retained the worktree at '{}': {rollback_error}",
                        display_path(&quarantine)
                    ),
                )),
            };
            }
        };
        sync_directory_blocking(parent)?;
        Ok((lease, tombstone_lease))
    })
    .await
    .map_err(|error| io::Error::other(format!("worktree quarantine task failed: {error}")))?
}

async fn ensure_worktree_removal_tombstone(
    path: &Path,
    quarantine: &Path,
    nonce: &str,
) -> Result<RemovalDirectoryLease, io::Error> {
    let path = path.to_path_buf();
    let quarantine = quarantine.to_path_buf();
    let nonce = nonce.to_owned();
    tokio::task::spawn_blocking(move || {
        match open_removal_directory_lease(&path) {
            Ok(lease) => {
                verify_or_repair_worktree_removal_tombstone_blocking(&path, &quarantine, &nonce)?;
                verify_removal_directory_lease(&lease, &path)?;
                return Ok(lease);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let lease = create_worktree_removal_tombstone_blocking(&path, &quarantine, &nonce)?;
        if let Some(parent) = path.parent() {
            sync_directory_blocking(parent)?;
        }
        Ok(lease)
    })
    .await
    .map_err(|error| io::Error::other(format!("worktree tombstone task failed: {error}")))?
}

fn create_worktree_removal_tombstone_blocking(
    path: &Path,
    quarantine: &Path,
    nonce: &str,
) -> Result<RemovalDirectoryLease, io::Error> {
    let lease = create_removal_directory_lease(path)?;
    let mut marker_created = false;
    let mut git_file_created = false;
    let result = (|| {
        let mut marker = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path.join(WORKTREE_REMOVAL_TOMBSTONE_FILE))?;
        marker_created = true;
        marker.write_all(nonce.as_bytes())?;
        marker.sync_all()?;
        drop(marker);
        let quarantined_git_file = quarantine.join(".git");
        if quarantined_git_file.is_file() {
            let contents = fs::read(&quarantined_git_file)?;
            let mut git_file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path.join(".git"))?;
            git_file_created = true;
            git_file.write_all(&contents)?;
            git_file.sync_all()?;
        }
        sync_directory_blocking(path)
    })();
    if let Err(error) = result {
        if git_file_created {
            let _ = remove_bound_regular_file(&lease, path, ".git", None);
        }
        if marker_created {
            let _ = remove_bound_regular_file(&lease, path, WORKTREE_REMOVAL_TOMBSTONE_FILE, None);
        }
        if bound_directory_is_empty(&lease, path).unwrap_or(false) {
            let _ = delete_bound_directory_root_blocking(lease, path);
        }
        return Err(error);
    }
    Ok(lease)
}

fn verify_or_repair_worktree_removal_tombstone_blocking(
    path: &Path,
    quarantine: &Path,
    expected_nonce: &str,
) -> Result<(), io::Error> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::other(
            "the removal tombstone is not a real directory",
        ));
    }
    let marker = fs::read_to_string(path.join(WORKTREE_REMOVAL_TOMBSTONE_FILE))?;
    if marker.trim() != expected_nonce {
        return Err(io::Error::other(
            "the removal tombstone identity does not match",
        ));
    }
    let mut has_git_file = false;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        if name != WORKTREE_REMOVAL_TOMBSTONE_FILE && name != ".git" {
            return Err(io::Error::other(
                "the removal tombstone contains unexpected files",
            ));
        }
        let file_type = entry.file_type()?;
        if !file_type.is_file() || file_type.is_symlink() {
            return Err(io::Error::other(
                "the removal tombstone contains an unsafe entry",
            ));
        }
        has_git_file |= name == ".git";
    }
    let quarantined_git_file = quarantine.join(".git");
    let quarantine_has_git_file = quarantined_git_file.is_file();
    if has_git_file && !quarantine_has_git_file {
        return Err(io::Error::other(
            "an orphan-removal tombstone unexpectedly contains a Git link",
        ));
    }
    if quarantine_has_git_file && !has_git_file {
        let contents = fs::read(quarantined_git_file)?;
        let mut git_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path.join(".git"))?;
        git_file.write_all(&contents)?;
        git_file.sync_all()?;
        sync_directory_blocking(path)?;
    }
    Ok(())
}

struct RemovalDirectoryLease {
    handle: fs::File,
    #[cfg(windows)]
    _parent_handle: Option<fs::File>,
}

struct WorktreeDeregistrationLeases {
    quarantine: RemovalDirectoryLease,
    tombstone: RemovalDirectoryLease,
    admin_quarantine: Option<RemovalDirectoryLease>,
    admin_source: Option<RemovalDirectoryLease>,
}

#[cfg(windows)]
fn create_removal_directory_lease(path: &Path) -> Result<RemovalDirectoryLease, io::Error> {
    use std::{
        mem::size_of,
        os::windows::{
            ffi::OsStrExt,
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle},
        },
    };

    use windows_sys::Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_CREATE, FILE_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT,
            FILE_SYNCHRONOUS_IO_NONALERT, NtCreateFile,
        },
    };
    use windows_sys::Win32::{
        Foundation::{HANDLE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING},
        Storage::FileSystem::{
            DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    };

    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "removal directory has no parent",
        )
    })?;
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "removal directory has no file name",
        )
    })?;
    let parent = fs::OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(parent)?;
    let mut name = name.encode_wide().collect::<Vec<_>>();
    let name_bytes = name
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "directory name is too long"))?;
    if name.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "removal directory name contains an interior NUL",
        ));
    }
    let unicode_name = UNICODE_STRING {
        Length: name_bytes,
        MaximumLength: name_bytes,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: std::ptr::from_ref(&unicode_name),
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut status_block = IO_STATUS_BLOCK::default();
    let mut handle: HANDLE = std::ptr::null_mut();
    // SAFETY: every pointer references initialized storage that remains alive for the call;
    // NtCreateFile initializes handle on success and the returned handle is adopted exactly once.
    let status = unsafe {
        NtCreateFile(
            std::ptr::from_mut(&mut handle),
            DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            std::ptr::from_ref(&attributes),
            std::ptr::from_mut(&mut status_block),
            std::ptr::null(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_CREATE,
            FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        // SAFETY: status is the NTSTATUS returned directly by NtCreateFile.
        let windows_error = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(windows_error as i32));
    }
    // SAFETY: NtCreateFile succeeded and transferred one owned Windows handle.
    let handle = unsafe { fs::File::from_raw_handle(handle) };
    let lease = RemovalDirectoryLease {
        handle,
        _parent_handle: Some(parent),
    };
    verify_removal_directory_lease(&lease, path)?;
    Ok(lease)
}

#[cfg(not(windows))]
fn create_removal_directory_lease(path: &Path) -> Result<RemovalDirectoryLease, io::Error> {
    fs::create_dir(path)?;
    open_removal_directory_lease(path)
}

fn open_removal_directory_lease(path: &Path) -> Result<RemovalDirectoryLease, io::Error> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::other(
            "the removal target is not a real directory",
        ));
    }
    #[cfg(windows)]
    let handle = {
        use std::os::windows::fs::OpenOptionsExt;

        use windows_sys::Win32::Storage::FileSystem::{
            DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ, FILE_SHARE_WRITE,
        };

        fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES | DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?
    };
    #[cfg(not(windows))]
    let handle = fs::File::open(path)?;
    let lease = RemovalDirectoryLease {
        handle,
        #[cfg(windows)]
        _parent_handle: None,
    };
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        };

        let identity = windows_file_identity(&lease.handle)?;
        if identity.attributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(io::Error::other(
                "the removal target is a reparse point or not a directory",
            ));
        }
    }
    verify_removal_directory_lease(&lease, path)?;
    Ok(lease)
}

fn verify_removal_directory_lease(
    lease: &RemovalDirectoryLease,
    path: &Path,
) -> Result<(), io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let leased = lease.handle.metadata()?;
        let current = fs::symlink_metadata(path)?;
        if leased.dev() != current.dev() || leased.ino() != current.ino() {
            return Err(io::Error::other(
                "the removal directory was rebound during cleanup",
            ));
        }
    }
    #[cfg(windows)]
    {
        // The directory handle omits FILE_SHARE_DELETE, so Windows cannot rename, replace, or
        // delete this filesystem object until the lease is dropped.
        let _ = (&lease.handle, path);
    }
    Ok(())
}

#[cfg(unix)]
fn owned_worktree_path_identity(
    lease: &RemovalDirectoryLease,
) -> Result<OwnedWorktreePathIdentity, io::Error> {
    use std::os::unix::fs::MetadataExt;

    let metadata = lease.handle.metadata()?;
    Ok(OwnedWorktreePathIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
fn owned_worktree_path_identity(
    lease: &RemovalDirectoryLease,
) -> Result<OwnedWorktreePathIdentity, io::Error> {
    windows_file_identity(&lease.handle)
}

fn verify_owned_worktree_path_identity(
    lease: &RemovalDirectoryLease,
    expected: OwnedWorktreePathIdentity,
) -> Result<(), io::Error> {
    if owned_worktree_path_identity(lease)? != expected {
        return Err(io::Error::other(
            "the reserved worktree directory identity changed",
        ));
    }
    Ok(())
}

fn verify_identity_marker_blocking(
    path: &Path,
    marker_name: &str,
    expected_nonce: &str,
) -> Result<(), io::Error> {
    let marker_path = path.join(marker_name);
    let metadata = fs::symlink_metadata(&marker_path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::other(
            "the bound removal directory identity marker is not a real file",
        ));
    }
    let marker = fs::read_to_string(marker_path)?;
    if marker.trim() != expected_nonce {
        return Err(io::Error::other(
            "the bound removal directory identity does not match",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn unix_directory_entry_names(
    directory_fd: std::os::fd::RawFd,
) -> Result<Vec<OsString>, io::Error> {
    use std::{ffi::CStr, os::unix::ffi::OsStringExt};

    // SAFETY: dup returns a new owned descriptor or -1. fdopendir takes ownership only on success.
    let duplicated = unsafe { libc::dup(directory_fd) };
    if duplicated < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: duplicated is a valid directory descriptor owned by this function.
    let directory = unsafe { libc::fdopendir(duplicated) };
    if directory.is_null() {
        // SAFETY: fdopendir failed and did not take ownership of duplicated.
        unsafe { libc::close(duplicated) };
        return Err(io::Error::last_os_error());
    }
    let mut names = Vec::new();
    loop {
        // SAFETY: directory remains valid until closed below.
        let entry = unsafe { libc::readdir(directory) };
        if entry.is_null() {
            break;
        }
        // SAFETY: d_name is NUL-terminated for the returned dirent.
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes != b"." && bytes != b".." {
            names.push(OsString::from_vec(bytes.to_vec()));
        }
    }
    // SAFETY: directory was returned by fdopendir and is closed exactly once.
    if unsafe { libc::closedir(directory) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(names)
}

#[cfg(unix)]
fn unix_name(name: &std::ffi::OsStr) -> Result<std::ffi::CString, io::Error> {
    use std::os::unix::ffi::OsStrExt;

    std::ffi::CString::new(name.as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "filesystem entry contains an interior NUL",
        )
    })
}

#[cfg(unix)]
fn clear_unix_directory_fd(
    directory_fd: std::os::fd::RawFd,
    preserved_name: Option<&std::ffi::OsStr>,
) -> Result<(), io::Error> {
    for name in unix_directory_entry_names(directory_fd)? {
        if preserved_name.is_some_and(|preserved| preserved == name) {
            continue;
        }
        let c_name = unix_name(&name)?;
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: directory_fd is open, c_name is NUL-terminated, and metadata is writable.
        if unsafe {
            libc::fstatat(
                directory_fd,
                c_name.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fstatat succeeded and initialized metadata.
        let metadata = unsafe { metadata.assume_init() };
        if metadata.st_mode & libc::S_IFMT == libc::S_IFDIR {
            // SAFETY: arguments are valid; O_NOFOLLOW prevents traversing a substituted symlink.
            let child_fd = unsafe {
                libc::openat(
                    directory_fd,
                    c_name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if child_fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let child_result = clear_unix_directory_fd(child_fd, None);
            // SAFETY: child_fd is owned by this scope and closed exactly once.
            let close_result = unsafe { libc::close(child_fd) };
            child_result?;
            if close_result != 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: directory_fd and c_name remain valid for unlinkat.
            if unsafe { libc::unlinkat(directory_fd, c_name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
                return Err(io::Error::last_os_error());
            }
        } else {
            // SAFETY: directory_fd and c_name remain valid for unlinkat.
            if unsafe { libc::unlinkat(directory_fd, c_name.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WindowsFileIdentity {
    volume: u64,
    file: u64,
    attributes: u32,
}

#[cfg(windows)]
fn windows_file_identity(file: &fs::File) -> Result<WindowsFileIdentity, io::Error> {
    use std::{mem::MaybeUninit, os::windows::io::AsRawHandle};

    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: information points to writable storage and the file handle remains valid.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetFileInformationByHandle succeeded and initialized information.
    let information = unsafe { information.assume_init() };
    Ok(WindowsFileIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        attributes: information.dwFileAttributes,
    })
}

#[cfg(windows)]
fn open_windows_removal_entry(path: &Path) -> Result<fs::File, io::Error> {
    use std::os::windows::fs::OpenOptionsExt;

    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

#[cfg(windows)]
fn delete_windows_entry_by_handle(file: &fs::File) -> Result<(), io::Error> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};

    use windows_sys::Win32::Storage::FileSystem::{
        FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO,
        FILE_DISPOSITION_INFO_EX, FileDispositionInfo, FileDispositionInfoEx,
        SetFileInformationByHandle,
    };

    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    // SAFETY: file is valid and disposition points to the declared structure for the call.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfoEx,
            std::ptr::from_ref(&disposition).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } != 0
    {
        return Ok(());
    }
    let fallback = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: file is valid and fallback points to the declared structure for the call.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            std::ptr::from_ref(&fallback).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } != 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
struct WindowsRemovalEntry {
    path: PathBuf,
    identity: WindowsFileIdentity,
}

#[cfg(windows)]
fn collect_windows_removal_entries(
    path: &Path,
    preserved_name: Option<&str>,
    entries: &mut Vec<WindowsRemovalEntry>,
) -> Result<(), io::Error> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    };

    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if preserved_name.is_some_and(|preserved| entry.file_name() == preserved) {
            continue;
        }
        let entry_path = entry.path();
        let handle = open_windows_removal_entry(&entry_path)?;
        let identity = windows_file_identity(&handle)?;
        let directory = identity.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        let traversable_directory =
            directory && identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0;
        if traversable_directory {
            collect_windows_removal_entries(&entry_path, None, entries)?;
        }
        entries.push(WindowsRemovalEntry {
            path: entry_path,
            identity,
        });
    }
    Ok(())
}

#[cfg(windows)]
fn clear_windows_directory_bound(
    path: &Path,
    preserved_name: Option<&str>,
) -> Result<(), io::Error> {
    clear_windows_directory_bound_after_snapshot(path, preserved_name, || {})
}

#[cfg(windows)]
fn clear_windows_directory_bound_after_snapshot(
    path: &Path,
    preserved_name: Option<&str>,
    after_snapshot: impl FnOnce(),
) -> Result<(), io::Error> {
    let mut entries = Vec::new();
    collect_windows_removal_entries(path, preserved_name, &mut entries)?;
    after_snapshot();
    for entry in entries {
        let handle = open_windows_removal_entry(&entry.path)?;
        if windows_file_identity(&handle)? != entry.identity {
            return Err(io::Error::other(
                "a removal descendant was rebound before deletion",
            ));
        }
        delete_windows_entry_by_handle(&handle)?;
        drop(handle);
    }
    Ok(())
}

fn clear_bound_directory_contents(
    lease: &RemovalDirectoryLease,
    path: &Path,
    preserved_name: Option<&str>,
) -> Result<(), io::Error> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;

        let _ = path;
        clear_unix_directory_fd(
            lease.handle.as_raw_fd(),
            preserved_name.map(std::ffi::OsStr::new),
        )
    }
    #[cfg(windows)]
    {
        verify_removal_directory_lease(lease, path)?;
        clear_windows_directory_bound(path, preserved_name)
    }
}

fn remove_bound_regular_file(
    lease: &RemovalDirectoryLease,
    path: &Path,
    name: &str,
    expected_contents: Option<&str>,
) -> Result<(), io::Error> {
    #[cfg(unix)]
    {
        use std::os::fd::{AsRawFd, FromRawFd};

        let _ = path;
        let name = unix_name(std::ffi::OsStr::new(name))?;
        // SAFETY: the leased directory fd is open and name is NUL-terminated. O_NOFOLLOW
        // prevents opening a substituted symlink.
        let file_fd = unsafe {
            libc::openat(
                lease.handle.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if file_fd < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(error)
            };
        }
        // SAFETY: file_fd is owned by this scope and transferred exactly once.
        let mut file = unsafe { fs::File::from_raw_fd(file_fd) };
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::other(
                "a protected removal file became an unsafe entry",
            ));
        }
        if let Some(expected) = expected_contents {
            use io::Read;

            let mut actual = String::new();
            file.read_to_string(&mut actual)?;
            if actual.trim() != expected {
                return Err(io::Error::other(
                    "a protected removal file identity does not match",
                ));
            }
        }
        // SAFETY: the leased directory fd and NUL-terminated name remain valid.
        if unsafe { libc::unlinkat(lease.handle.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        drop(file);
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::{io::Read, os::windows::fs::OpenOptionsExt};

        use windows_sys::Win32::Storage::FileSystem::{
            DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };

        verify_removal_directory_lease(lease, path)?;
        let entry_path = path.join(name);
        let mut file = match fs::OpenOptions::new()
            .access_mode(FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(entry_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let identity = windows_file_identity(&file)?;
        if identity.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Err(io::Error::other(
                "a protected removal file became an unsafe entry",
            ));
        }
        if let Some(expected) = expected_contents {
            let mut actual = String::new();
            file.read_to_string(&mut actual)?;
            if actual.trim() != expected {
                return Err(io::Error::other(
                    "a protected removal file identity does not match",
                ));
            }
        }
        delete_windows_entry_by_handle(&file)?;
        drop(file);
        Ok(())
    }
}

fn bound_directory_is_empty(lease: &RemovalDirectoryLease, path: &Path) -> Result<bool, io::Error> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;

        let _ = path;
        Ok(unix_directory_entry_names(lease.handle.as_raw_fd())?.is_empty())
    }
    #[cfg(windows)]
    {
        let _ = lease;
        Ok(fs::read_dir(path)?.next().transpose()?.is_none())
    }
}

fn delete_bound_directory_root_blocking(
    lease: RemovalDirectoryLease,
    path: &Path,
) -> Result<(), io::Error> {
    if !bound_directory_is_empty(&lease, path)? {
        return Err(io::Error::other(
            "a bound removal directory gained unexpected data before root deletion",
        ));
    }
    verify_removal_directory_lease(&lease, path)?;
    #[cfg(windows)]
    {
        delete_windows_entry_by_handle(&lease.handle)?;
        drop(lease);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::remove_dir(path)?;
        drop(lease);
        Ok(())
    }
}

async fn deregister_worktree_admin_and_remove_tombstone(
    path: &Path,
    quarantine: &Path,
    admin_source: Option<&Path>,
    admin_quarantine: &Path,
    nonce: &str,
    leases: WorktreeDeregistrationLeases,
) -> Result<(RemovalDirectoryLease, Option<RemovalDirectoryLease>), io::Error> {
    let path = path.to_path_buf();
    let quarantine = quarantine.to_path_buf();
    let admin_source = admin_source.map(Path::to_path_buf);
    let admin_quarantine = admin_quarantine.to_path_buf();
    let nonce = nonce.to_owned();
    tokio::task::spawn_blocking(move || {
        let WorktreeDeregistrationLeases {
            quarantine: quarantine_lease,
            tombstone: tombstone_lease,
            admin_quarantine: admin_quarantine_lease,
            admin_source: admin_source_lease,
        } = leases;
        verify_removal_directory_lease(&quarantine_lease, &quarantine)?;
        verify_or_repair_worktree_removal_tombstone_blocking(&path, &quarantine, &nonce)?;
        verify_removal_directory_lease(&tombstone_lease, &path)?;

        let mut admin_quarantine_lease = admin_quarantine_lease;
        if let Some(admin_lease) = admin_quarantine_lease.as_ref() {
            verify_removal_directory_lease(admin_lease, &admin_quarantine)?;
            verify_identity_marker_blocking(
                &admin_quarantine,
                WORKTREE_REMOVAL_IDENTITY_FILE,
                &nonce,
            )?;
        } else if let Some(admin_lease) = admin_source_lease {
            let admin_source = admin_source.as_deref().ok_or_else(|| {
                io::Error::other("the registered worktree admin path disappeared")
            })?;
            verify_identity_marker_blocking(admin_source, WORKTREE_REMOVAL_IDENTITY_FILE, &nonce)?;
            verify_removal_directory_lease(&admin_lease, admin_source)?;
            let admin_parent = admin_quarantine.parent().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "admin quarantine has no parent",
                )
            })?;
            fs::create_dir_all(admin_parent)?;
            sync_directory_blocking(admin_parent)?;
            rename_bound_directory_blocking(&admin_lease, admin_source, &admin_quarantine)?;
            if let Err(error) = verify_identity_marker_blocking(
                &admin_quarantine,
                WORKTREE_REMOVAL_IDENTITY_FILE,
                &nonce,
            ) {
                let _ =
                    rename_bound_directory_blocking(&admin_lease, &admin_quarantine, admin_source);
                return Err(error);
            }
            if let Some(source_parent) = admin_source.parent() {
                sync_directory_blocking(source_parent)?;
            }
            sync_directory_blocking(admin_parent)?;
            admin_quarantine_lease = Some(admin_lease);
        }

        verify_removal_directory_lease(&quarantine_lease, &quarantine)?;
        verify_or_repair_worktree_removal_tombstone_blocking(&path, &quarantine, &nonce)?;
        verify_removal_directory_lease(&tombstone_lease, &path)?;
        remove_bound_regular_file(&tombstone_lease, &path, ".git", None)?;
        remove_bound_regular_file(
            &tombstone_lease,
            &path,
            WORKTREE_REMOVAL_TOMBSTONE_FILE,
            Some(&nonce),
        )?;
        if !bound_directory_is_empty(&tombstone_lease, &path)? {
            return Err(io::Error::other(
                "the removal tombstone gained unexpected contents",
            ));
        }
        delete_bound_directory_root_blocking(tombstone_lease, &path)?;
        if let Some(parent) = path.parent() {
            sync_directory_blocking(parent)?;
        }
        Ok((quarantine_lease, admin_quarantine_lease))
    })
    .await
    .map_err(|error| io::Error::other(format!("worktree deregistration task failed: {error}")))?
}

async fn open_removal_directory_lease_async(
    path: &Path,
) -> Result<RemovalDirectoryLease, io::Error> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || open_removal_directory_lease(&path))
        .await
        .map_err(|error| io::Error::other(format!("directory lease task failed: {error}")))?
}

async fn remove_bound_identity_directory_with_lease(
    path: &Path,
    marker_name: &str,
    expected_nonce: &str,
    cancellation: &CancellationToken,
    lease: RemovalDirectoryLease,
) -> Result<(), io::Error> {
    let path = path.to_path_buf();
    let marker_name = marker_name.to_owned();
    let expected_nonce = expected_nonce.to_owned();
    let cancellation = cancellation.clone();
    tokio::task::spawn_blocking(move || {
        let mut last_error = None;
        for attempt in 0..WORKTREE_REMOVE_RETRY_ATTEMPTS {
            if cancellation.is_cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "worktree removal was cancelled",
                ));
            }
            match clear_bound_identity_directory_once(&lease, &path, &marker_name, &expected_nonce)
            {
                Ok(()) => return delete_bound_directory_root_blocking(lease, &path),
                Err(error) => last_error = Some(error),
            }
            if attempt + 1 < WORKTREE_REMOVE_RETRY_ATTEMPTS {
                std::thread::sleep(WORKTREE_REMOVE_RETRY_DELAY);
            }
        }
        Err(last_error.unwrap_or_else(|| io::Error::other("bound directory cleanup failed")))
    })
    .await
    .map_err(|error| io::Error::other(format!("bound directory cleanup task failed: {error}")))?
}

async fn remove_bound_owned_directory_with_lease(
    path: &Path,
    lease: RemovalDirectoryLease,
) -> Result<(), io::Error> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut last_error = None;
        for attempt in 0..WORKTREE_REMOVE_RETRY_ATTEMPTS {
            match clear_bound_directory_contents(&lease, &path, None) {
                Ok(()) => return delete_bound_directory_root_blocking(lease, &path),
                Err(error) => last_error = Some(error),
            }
            if attempt + 1 < WORKTREE_REMOVE_RETRY_ATTEMPTS {
                std::thread::sleep(WORKTREE_REMOVE_RETRY_DELAY);
            }
        }
        Err(last_error.unwrap_or_else(|| io::Error::other("owned directory cleanup failed")))
    })
    .await
    .map_err(|error| io::Error::other(format!("owned directory cleanup task failed: {error}")))?
}

fn clear_bound_identity_directory_once(
    lease: &RemovalDirectoryLease,
    path: &Path,
    marker_name: &str,
    expected_nonce: &str,
) -> Result<(), io::Error> {
    match verify_identity_marker_blocking(path, marker_name, expected_nonce) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if bound_directory_is_empty(lease, path)? {
                return Ok(());
            }
            return Err(io::Error::other(
                "the removal marker disappeared while the directory still contains data",
            ));
        }
        Err(error) => return Err(error),
    }
    verify_removal_directory_lease(lease, path)?;
    clear_bound_directory_contents(lease, path, Some(marker_name))?;
    verify_removal_directory_lease(lease, path)?;
    remove_bound_regular_file(lease, path, marker_name, Some(expected_nonce))?;
    if !bound_directory_is_empty(lease, path)? {
        return Err(io::Error::other(
            "the bound removal directory gained new contents during cleanup",
        ));
    }
    Ok(())
}

#[cfg(test)]
fn run_worktree_removal_probe_blocking(
    source: &Path,
    probe: &Path,
    cancellation: &CancellationToken,
    after_probe_rename: impl FnOnce(),
) -> Result<(), io::Error> {
    rename_worktree_path_with_retries_blocking(source, probe, Some(cancellation))?;
    after_probe_rename();
    rename_worktree_path_with_retries_blocking(probe, source, None).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "the safety probe retained the worktree at '{}': {error}",
                display_path(probe)
            ),
        )
    })
}

#[cfg(test)]
fn rename_worktree_path_with_retries_blocking(
    source: &Path,
    destination: &Path,
    cancellation: Option<&CancellationToken>,
) -> Result<(), io::Error> {
    let mut last_error = None;
    for attempt in 0..WORKTREE_REMOVE_RETRY_ATTEMPTS {
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "worktree removal was cancelled",
            ));
        }
        match rename_path_blocking(source, destination) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < WORKTREE_REMOVE_RETRY_ATTEMPTS {
            if cancellation.is_some_and(CancellationToken::is_cancelled) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "worktree removal was cancelled",
                ));
            }
            std::thread::sleep(WORKTREE_REMOVE_RETRY_DELAY);
        }
    }
    Err(last_error.unwrap_or_else(|| io::Error::other("worktree rename failed")))
}

fn git_environment() -> Vec<(OsString, OsString)> {
    [
        ("GCM_INTERACTIVE", "never"),
        ("GIT_ASKPASS", ""),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("LC_ALL", "C"),
        ("LANG", "C"),
        ("SSH_ASKPASS", ""),
        ("SSH_ASKPASS_REQUIRE", "never"),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value.into()))
    .collect()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

async fn resolve_explicit_worktree_path(cwd: &Path, requested_path: &Path) -> PathBuf {
    let repository_cwd = match tokio::fs::canonicalize(cwd).await {
        Ok(path) => path,
        Err(_) if cwd.is_absolute() => cwd.to_path_buf(),
        Err(_) => std::env::current_dir()
            .map(|current_dir| current_dir.join(cwd))
            .unwrap_or_else(|_| cwd.to_path_buf()),
    };
    let path = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        repository_cwd.join(requested_path)
    };
    normalize_path_lexically(&path)
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                );
                if can_pop {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn same_worktree_path(registered: &str, path: &Path) -> bool {
    let candidate = display_path(path);
    if cfg!(windows) {
        registered.eq_ignore_ascii_case(&candidate)
    } else {
        registered == candidate
    }
}

async fn registered_worktree_path_index(
    operation: &str,
    cwd: &Path,
    registered_paths: &[String],
    path: &Path,
) -> Result<Option<usize>, GitCommandError> {
    let expected = canonical_worktree_path_key(path).await.map_err(|error| {
        simple_error(
            operation,
            cwd,
            &format!(
                "The requested worktree path '{}' could not be resolved to a physical identity: {error}",
                display_path(path)
            ),
        )
    })?;
    for (index, registered) in registered_paths.iter().enumerate() {
        let registered_path = Path::new(registered);
        let candidate = canonical_worktree_path_key(registered_path)
            .await
            .map_err(|error| {
                simple_error(
                    operation,
                    cwd,
                    &format!(
                        "The registered worktree path '{}' could not be resolved to a physical identity: {error}",
                        display_path(registered_path)
                    ),
                )
            })?;
        if candidate == expected {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

fn exact_worktree_record<'a>(
    inventory: &'a GitWorktreeInventory,
    expected: &GitWorktreeRecord,
) -> Option<&'a GitWorktreeRecord> {
    inventory.records.iter().find(|candidate| {
        normalized_worktree_path(&candidate.path) == normalized_worktree_path(&expected.path)
            && candidate.head == expected.head
            && candidate.branch == expected.branch
            && candidate.is_primary == expected.is_primary
            && candidate.is_bare == expected.is_bare
            && candidate.locked == expected.locked
            && candidate.lock_reason == expected.lock_reason
            && candidate.is_prunable == expected.is_prunable
            && candidate.prunable_reason == expected.prunable_reason
    })
}

fn inventory_contains_path(inventory: &GitWorktreeInventory, path: &Path) -> bool {
    let expected = normalized_worktree_path(path);
    inventory
        .records
        .iter()
        .any(|candidate| normalized_worktree_path(&candidate.path) == expected)
}

fn sorted_prunable_records(inventory: &GitWorktreeInventory) -> Vec<GitWorktreeRecord> {
    let mut records = inventory
        .records
        .iter()
        .filter(|record| record.is_prunable && !record.locked)
        .cloned()
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        normalized_worktree_path(&left.path).cmp(&normalized_worktree_path(&right.path))
    });
    records
}

fn normalized_worktree_path(path: &Path) -> String {
    normalize_worktree_path_key(path, host_path_platform())
}

async fn canonical_common_dir(
    operation: &str,
    anchor: &Path,
    common_dir: &Path,
) -> Result<PathBuf, GitCommandError> {
    tokio::fs::canonicalize(common_dir).await.map_err(|error| {
        simple_error(
            operation,
            anchor,
            &format!(
                "The common Git directory '{}' could not be verified: {error}",
                display_path(common_dir)
            ),
        )
    })
}

async fn resolve_worktree_prune_paths(
    anchor: &Path,
    common_dir: &Path,
    dry_run_records: Vec<WorktreePruneDryRunRecord>,
    cancellation: &CancellationToken,
) -> Result<Vec<(WorktreePruneDryRunRecord, PathBuf)>, GitCommandError> {
    if dry_run_records.is_empty() {
        return Ok(Vec::new());
    }
    let worktrees_dir = common_dir.join("worktrees");
    verify_prune_directory(&worktrees_dir)
        .await
        .map_err(|error| {
            prune_identity_error(
                anchor,
                &format!("Git's worktree administration directory could not be verified: {error}"),
            )
        })?;

    let mut resolved = Vec::with_capacity(dry_run_records.len());
    let mut path_keys = HashSet::with_capacity(dry_run_records.len());
    for record in dry_run_records {
        if cancellation.is_cancelled() {
            return Err(prune_identity_error(
                anchor,
                "Git worktree prune impact verification was interrupted.",
            ));
        }
        let path = resolve_worktree_prune_path(&worktrees_dir, &record.admin_id, cancellation)
            .await
            .map_err(|error| {
                prune_identity_error(
                    anchor,
                    &format!(
                        "Git's dry-run administration identity '{}' could not be verified: {error}",
                        record.admin_id
                    ),
                )
            })?;
        if !path_keys.insert(normalized_worktree_path(&path)) {
            return Err(prune_identity_error(
                anchor,
                "Git's dry-run contains duplicate normalized worktree paths.",
            ));
        }
        resolved.push((record, path));
    }
    if cancellation.is_cancelled() {
        return Err(prune_identity_error(
            anchor,
            "Git worktree prune impact verification was interrupted.",
        ));
    }
    Ok(resolved)
}

async fn verify_prune_directory(path: &Path) -> io::Result<()> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected a non-symlink directory",
        ));
    }
    if tokio::fs::canonicalize(path).await? != path {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "directory identity does not match its canonical path",
        ));
    }
    Ok(())
}

async fn resolve_worktree_prune_path(
    worktrees_dir: &Path,
    admin_id: &str,
    cancellation: &CancellationToken,
) -> io::Result<PathBuf> {
    let admin_dir = worktrees_dir.join(admin_id);
    verify_prune_directory(&admin_dir).await?;
    let gitdir_path = admin_dir.join("gitdir");
    let before = tokio::fs::symlink_metadata(&gitdir_path).await?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected a non-symlink gitdir file",
        ));
    }

    let file = prune_gitdir_open_options().open(&gitdir_path).await?;
    let opened = file.metadata().await?;
    if !opened.is_file() || !same_prune_file_identity(&before, &opened) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "gitdir identity changed while it was opened",
        ));
    }
    let capacity = usize::try_from(opened.len())
        .unwrap_or(usize::MAX)
        .min(WORKTREE_PRUNE_GITDIR_LIMIT as usize);
    let mut bytes = Vec::with_capacity(capacity);
    let mut limited = file.take(WORKTREE_PRUNE_GITDIR_LIMIT + 1);
    let read = limited.read_to_end(&mut bytes);
    tokio::select! {
        result = read => result?,
        () = cancellation.cancelled() => {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "impact verification cancelled"));
        }
    };
    if bytes.len() as u64 > WORKTREE_PRUNE_GITDIR_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "gitdir identity exceeds its byte limit",
        ));
    }
    let after = tokio::fs::symlink_metadata(&gitdir_path).await?;
    if !after.is_file()
        || after.file_type().is_symlink()
        || !same_prune_file_identity(&opened, &after)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "gitdir identity changed while it was read",
        ));
    }
    verify_prune_directory(&admin_dir).await?;
    parse_prune_gitdir_path(bytes)
}

fn prune_gitdir_open_options() -> tokio::fs::OpenOptions {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    options
}

#[cfg(unix)]
fn same_prune_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_prune_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.file_type() == right.file_type()
        && left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
}

fn parse_prune_gitdir_path(mut bytes: Vec<u8>) -> io::Result<PathBuf> {
    if bytes.pop() != Some(b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "gitdir identity is unterminated",
        ));
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    if bytes.is_empty() || bytes.contains(&b'\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "gitdir identity is empty or malformed",
        ));
    }
    let value = String::from_utf8(bytes).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "gitdir identity is not valid UTF-8",
        )
    })?;
    let gitdir = PathBuf::from(value);
    if !gitdir.is_absolute() || gitdir.file_name().is_none_or(|name| name != ".git") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "gitdir identity is not an absolute worktree .git path",
        ));
    }
    gitdir.parent().map(Path::to_path_buf).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "gitdir identity has no worktree parent",
        )
    })
}

fn prune_identity_error(anchor: &Path, detail: &str) -> GitCommandError {
    simple_error("GitVcsDriver.previewWorktreePrune.verify", anchor, detail)
}

fn validate_removable_worktree(
    anchor: &Path,
    record: &GitWorktreeRecord,
) -> Result<(), GitCommandError> {
    if record.is_bare {
        return Err(simple_error(
            "GitVcsDriver.worktreeRemovalPreflight",
            anchor,
            "Bare worktrees are protected and cannot be removed.",
        ));
    }
    if record.is_primary {
        return Err(simple_error(
            "GitVcsDriver.worktreeRemovalPreflight",
            anchor,
            "The primary worktree is protected and cannot be removed.",
        ));
    }
    if record.locked {
        let reason = record
            .lock_reason
            .as_deref()
            .unwrap_or("Git did not provide a lock reason");
        return Err(simple_error(
            "GitVcsDriver.worktreeRemovalPreflight",
            anchor,
            &format!("The worktree registration is locked: {reason}"),
        ));
    }
    Ok(())
}

fn worktree_record_mismatch_error(
    operation: &str,
    anchor: &Path,
    record: &GitWorktreeRecord,
) -> GitCommandError {
    simple_error(
        operation,
        anchor,
        &format!(
            "The registered worktree record '{}' changed or does not belong to this repository.",
            display_path(&record.path)
        ),
    )
}

fn parse_worktree_removal_status(
    anchor: &Path,
    output: &str,
) -> Result<GitWorktreeRemovalInspection, GitCommandError> {
    if output.is_empty() {
        return Ok(GitWorktreeRemovalInspection::default());
    }
    if !output.ends_with('\0') {
        return Err(simple_error(
            "GitVcsDriver.inspectWorktreeRemoval.status",
            anchor,
            "Git returned an unterminated worktree status record.",
        ));
    }
    let mut inspection = GitWorktreeRemovalInspection::default();
    let mut records = output.split_terminator('\0');
    while let Some(record) = records.next() {
        if record.starts_with("? ") {
            if parse_porcelain_v2_line(record).is_none() {
                return Err(malformed_worktree_removal_status(anchor));
            }
            inspection.untracked_file_count = inspection
                .untracked_file_count
                .checked_add(1)
                .ok_or_else(|| malformed_worktree_removal_status(anchor))?;
            continue;
        }
        if record.starts_with("1 ") || record.starts_with("u ") {
            if parse_porcelain_v2_line(record).is_none() {
                return Err(malformed_worktree_removal_status(anchor));
            }
            inspection.tracked_change_count = inspection
                .tracked_change_count
                .checked_add(1)
                .ok_or_else(|| malformed_worktree_removal_status(anchor))?;
            continue;
        }
        if record.starts_with("2 ") {
            if parse_porcelain_v2_line(record).is_none() || records.next().is_none_or(str::is_empty)
            {
                return Err(malformed_worktree_removal_status(anchor));
            }
            inspection.tracked_change_count = inspection
                .tracked_change_count
                .checked_add(1)
                .ok_or_else(|| malformed_worktree_removal_status(anchor))?;
            continue;
        }
        if record.starts_with("! ") {
            continue;
        }
        return Err(malformed_worktree_removal_status(anchor));
    }
    Ok(inspection)
}

fn malformed_worktree_removal_status(anchor: &Path) -> GitCommandError {
    simple_error(
        "GitVcsDriver.inspectWorktreeRemoval.status",
        anchor,
        "Git returned a malformed worktree status record.",
    )
}

fn ensure_authoritative_inventory_output(
    operation: &str,
    cwd: &Path,
    output: &ProcessOutput,
) -> Result<(), GitCommandError> {
    if output.stdout_truncated || output.stderr_truncated {
        return Err(simple_error(
            operation,
            cwd,
            "Git worktree inventory output was truncated and is not authoritative.",
        ));
    }
    Ok(())
}

fn is_unsupported_porcelain_z_diagnostic(stderr: &str) -> bool {
    let diagnostic = stderr.to_ascii_lowercase();
    [
        "unknown option `z'",
        "unknown option 'z'",
        "unknown option: -z",
        "unknown switch `z'",
        "unknown switch 'z'",
        "unrecognized option '-z'",
    ]
    .into_iter()
    .any(|needle| diagnostic.contains(needle))
}

fn git_output_line(output: &str) -> Option<&str> {
    let line = output.strip_suffix('\n').unwrap_or(output);
    let line = line.strip_suffix('\r').unwrap_or(line);
    (!line.contains(['\n', '\r'])).then_some(line)
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = display_path(left);
    let right = display_path(right);
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

fn resolve_git_metadata_path(base: &Path, value: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

fn parse_branch_headers(stdout: &str) -> (Option<String>, Option<String>, u64, u64) {
    let mut branch = None;
    let mut upstream = None;
    let mut has_upstream_comparison = false;
    let mut ahead = 0;
    let mut behind = 0;
    for line in stdout.lines() {
        if let Some(value) = line.strip_prefix("# branch.head ") {
            if value != "(detached)" {
                branch = Some(value.to_owned());
            }
        } else if let Some(value) = line.strip_prefix("# branch.upstream ") {
            upstream = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("# branch.ab ") {
            has_upstream_comparison = true;
            for part in value.split_whitespace() {
                if let Some(value) = part.strip_prefix('+') {
                    ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix('-') {
                    behind = value.parse().unwrap_or(0);
                }
            }
        }
    }
    if !has_upstream_comparison {
        upstream = None;
    }
    (branch, upstream, ahead, behind)
}

async fn untracked_line_count(path: &Path) -> u64 {
    let Ok(bytes) = tokio::fs::read(path).await else {
        return 0;
    };
    if bytes.is_empty() {
        0
    } else {
        bytes.iter().filter(|byte| **byte == b'\n').count() as u64
            + u64::from(bytes.last() != Some(&b'\n'))
    }
}

fn area_order(area: Option<VcsStagingArea>) -> u8 {
    match area {
        Some(VcsStagingArea::Staged) => 0,
        Some(VcsStagingArea::Unstaged) => 1,
        Some(VcsStagingArea::Untracked) => 2,
        None => 3,
    }
}

fn validate_pathspecs(
    operation: &str,
    cwd: &Path,
    paths: &[String],
) -> Result<(), GitCommandError> {
    for path in paths {
        let parsed = Path::new(path);
        if path.trim().is_empty()
            || parsed.is_absolute()
            || parsed
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(simple_error(
                operation,
                cwd,
                "File pathspec must be a non-empty repository-relative path without traversal.",
            ));
        }
    }
    Ok(())
}

fn parse_commit(line: &str) -> Option<VcsCommit> {
    let mut fields = line.split(COMMIT_FIELD_SEPARATOR);
    let sha = fields.next()?.to_owned();
    let short_sha = fields.next()?.to_owned();
    if sha.is_empty() || short_sha.is_empty() {
        return None;
    }
    Some(VcsCommit {
        sha,
        short_sha,
        subject: fields.next().unwrap_or_default().to_owned(),
        author_name: fields.next().unwrap_or_default().to_owned(),
        authored_at_ms: fields
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_mul(1000),
    })
}

fn ref_priority(reference: &VcsRef) -> u8 {
    if reference.current {
        0
    } else if reference.is_default {
        1
    } else {
        2
    }
}

fn provider_info(remote: &str) -> Option<SourceControlProviderInfo> {
    let normalized = remote.to_lowercase();
    let (kind, name, base_url) = if normalized.contains("github.com") {
        (ProviderKind::Github, "GitHub", "https://github.com")
    } else if normalized.contains("gitlab") {
        (ProviderKind::Gitlab, "GitLab", "https://gitlab.com")
    } else if normalized.contains("dev.azure.com") || normalized.contains("visualstudio.com") {
        (
            ProviderKind::AzureDevops,
            "Azure DevOps",
            "https://dev.azure.com",
        )
    } else if normalized.contains("bitbucket") {
        (
            ProviderKind::Bitbucket,
            "Bitbucket",
            "https://bitbucket.org",
        )
    } else {
        return None;
    };
    Some(SourceControlProviderInfo {
        kind,
        name: name.into(),
        base_url: base_url.into(),
    })
}

fn git_error(
    operation: &str,
    cwd: &Path,
    argument_count: usize,
    error: ProcessError,
) -> GitCommandError {
    let (exit_code, stdout_length, stderr_length, detail) = match error {
        ProcessError::NonZeroExit {
            exit_code,
            stdout_length,
            stderr_length,
            stdout,
            stderr,
            ..
        } => (
            Some(exit_code),
            Some(stdout_length),
            Some(stderr_length),
            actionable_git_failure(&stderr, &stdout),
        ),
        ProcessError::Cancelled { .. } => (None, None, None, "Git command was interrupted.".into()),
        ProcessError::Timeout { .. } => (None, None, None, "Git command timed out.".into()),
        ProcessError::OutputLimit { .. } => (
            None,
            None,
            None,
            "Git command output exceeded its limit.".into(),
        ),
        other => (None, None, None, other.to_string()),
    };
    GitCommandError {
        tag: "GitCommandError",
        operation: operation.into(),
        command: "git".into(),
        cwd: display_path(cwd).into(),
        diagnostics: Some(Box::new(GitCommandDiagnostics {
            argument_count: Some(argument_count),
            exit_code,
            stdout_length,
            stderr_length,
        })),
        detail: detail.into(),
    }
}

fn actionable_git_failure(stderr: &str, stdout: &str) -> String {
    let output = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    if output.trim().is_empty() {
        return "Git process exited with a non-zero status.".to_owned();
    }
    redact_sensitive_text(output.trim())
}

fn simple_error(operation: &str, cwd: &Path, detail: &str) -> GitCommandError {
    GitCommandError {
        tag: "GitCommandError",
        operation: operation.into(),
        command: "git".into(),
        cwd: display_path(cwd).into(),
        diagnostics: None,
        detail: detail.into(),
    }
}

fn worktree_cleanup_error(cwd: &Path, path: &Path, error: &io::Error) -> GitCommandError {
    simple_error(
        "GitVcsDriver.removeWorktree",
        cwd,
        &format!(
            "The registered worktree path '{}' could not be cleaned before Git removal: {error}",
            display_path(path)
        ),
    )
}

fn worktree_removal_admission_error(cwd: &Path, path: &Path, error: &io::Error) -> GitCommandError {
    simple_error(
        "GitVcsDriver.removeWorktree",
        cwd,
        &format!(
            "The registered worktree path '{}' is still in use, so removal stopped before deleting any files: {error}",
            display_path(path)
        ),
    )
}

fn registered_worktree_identity_error(cwd: &Path, path: &Path) -> GitCommandError {
    simple_error(
        "GitVcsDriver.removeWorktree",
        cwd,
        &format!(
            "The registered worktree path '{}' no longer has a verifiable linked-worktree identity, so it was not deleted.",
            display_path(path)
        ),
    )
}

fn worktree_identity_marker_error(cwd: &Path, path: &Path, detail: &str) -> GitCommandError {
    simple_error(
        "GitVcsDriver.removeWorktree",
        cwd,
        &format!(
            "The registered worktree path '{}' does not match the durable removal identity, so it was not deleted: {detail}",
            display_path(path)
        ),
    )
}

fn with_filesystem_cleanup_deferred(mut error: GitCommandError, path: &Path) -> GitCommandError {
    error.detail = format!(
        "{}\nGit deregistered the worktree, but the remaining directory '{}' was preserved because it no longer has a transaction-bound removal identity.",
        error.detail,
        display_path(path),
    )
    .into();
    error
}

fn reserve_implicit_worktree_path(
    cwd: &Path,
    path: &Path,
    path_policy: &WorktreePathPolicy,
) -> Result<OwnedWorktreePath, GitCommandError> {
    OwnedWorktreePath::reserve(path.to_path_buf()).map_err(|error| {
        worktree_reservation_error(cwd, path, error, path_policy.configured_base())
    })
}

fn worktree_reservation_error(
    cwd: &Path,
    path: &Path,
    error: WorktreePathReservationError,
    configured_base: Option<&Path>,
) -> GitCommandError {
    if !error.is_destination_collision()
        && let Some(configured_base) = configured_base
    {
        return workspace_unavailable_error(cwd, configured_base);
    }

    let detail = if error.kind() == io::ErrorKind::AlreadyExists {
        format!(
            "The requested worktree path '{}' already exists. Choose an absent path so BiBCode can safely own its cleanup.",
            display_path(path)
        )
    } else {
        format!(
            "The worktree path '{}' could not be reserved: {}",
            display_path(path),
            error.source
        )
    };
    simple_error("GitVcsDriver.createWorktree", cwd, &detail)
}

fn workspace_unavailable_error(cwd: &Path, workspace: &Path) -> GitCommandError {
    simple_error(
        "GitVcsDriver.createWorktree",
        cwd,
        &format!(
            "Workspace {} is unavailable. Choose another folder in Settings → General.",
            display_path(workspace)
        ),
    )
}

fn command_output_error(
    operation: &str,
    cwd: &Path,
    argument_count: usize,
    output: &ProcessOutput,
    detail: &str,
) -> GitCommandError {
    GitCommandError {
        tag: "GitCommandError",
        operation: operation.into(),
        command: "git".into(),
        cwd: display_path(cwd).into(),
        diagnostics: Some(Box::new(GitCommandDiagnostics {
            argument_count: Some(argument_count),
            exit_code: Some(output.exit_code),
            stdout_length: Some(output.stdout.len()),
            stderr_length: Some(output.stderr.len()),
        })),
        detail: detail.into(),
    }
}

fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(unc_path) = raw.strip_prefix(r"\\?\UNC\") {
        return format!("//{}", unc_path.replace('\\', "/"));
    }
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).replace('\\', "/")
}

#[cfg(test)]
mod worktree_ownership_tests {
    use std::{
        collections::VecDeque,
        fs,
        path::Path,
        process::Command,
        sync::{Arc, Mutex},
    };

    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    use super::{
        CreateWorktreeInput, GitProcessRunner, GitPrunableWorktree, GitRepository,
        GitWorktreeRecord, OutputPolicy, OwnedWorktreePath, ProcessOutput, ProcessRequest,
        WORKTREE_INVENTORY_OUTPUT_LIMIT, display_path, ensure_authoritative_inventory_output,
        git_output_line, is_unsupported_porcelain_z_diagnostic, parse_branch_headers,
        run_worktree_removal_probe_blocking,
    };
    #[cfg(unix)]
    use super::{
        WORKTREE_PRUNE_GITDIR_LIMIT, WorktreePruneDryRunRecord, resolve_worktree_prune_paths,
    };
    use crate::git::git_worktree_prune_impact_digest;

    #[cfg(windows)]
    use super::{
        clear_windows_directory_bound_after_snapshot, create_removal_directory_lease,
        delete_bound_directory_root_blocking, open_removal_directory_lease,
        rename_bound_directory_blocking,
    };

    #[test]
    fn cancellation_after_probe_rename_still_restores_the_original_path() {
        let parent = tempfile::tempdir().expect("probe parent");
        let source = parent.path().join("worktree");
        let probe = parent.path().join(".worktree.probe");
        fs::create_dir(&source).expect("source worktree");
        fs::write(source.join("sentinel.txt"), "preserve\n").expect("sentinel");
        let cancellation = CancellationToken::new();

        run_worktree_removal_probe_blocking(&source, &probe, &cancellation, || {
            assert!(probe.exists(), "probe owns the directory between renames");
            cancellation.cancel();
        })
        .expect("rollback ignores cancellation after the first rename");

        assert!(source.join("sentinel.txt").exists());
        assert!(!probe.exists());
    }

    #[cfg(windows)]
    #[test]
    fn removal_directory_lease_prevents_windows_path_rebinding() {
        let parent = tempfile::tempdir().expect("lease parent");
        let source = parent.path().join("quarantine");
        let replacement_name = parent.path().join("quarantine-moved");
        fs::create_dir(&source).expect("quarantine fixture");
        let lease = open_removal_directory_lease(&source).expect("bind quarantine object");

        fs::rename(&source, &replacement_name)
            .expect_err("a bound removal object must not be renamed or replaced");
        assert!(source.exists());

        drop(lease);
        fs::rename(&source, &replacement_name).expect("dropping the lease releases the object");
    }

    #[cfg(windows)]
    #[test]
    fn removal_renames_and_deletes_the_bound_windows_directory_object() {
        let parent = tempfile::tempdir().expect("lease parent");
        let source = parent.path().join("source");
        let destination = parent.path().join("destination");
        let lease = create_removal_directory_lease(&source)
            .expect("atomically create and bind source object");

        rename_bound_directory_blocking(&lease, &source, &destination)
            .expect("rename the exact leased object by handle");
        assert!(!source.exists());
        assert!(destination.exists());

        delete_bound_directory_root_blocking(lease, &destination)
            .expect("delete the exact leased root by handle");
        assert!(!destination.exists());
    }

    #[cfg(windows)]
    #[test]
    fn removal_rejects_a_child_rebound_after_its_identity_snapshot() {
        let parent = tempfile::tempdir().expect("cleanup parent");
        let quarantine = parent.path().join("quarantine");
        let child = quarantine.join("child");
        let moved_child = quarantine.join("original-child");
        let sibling = parent.path().join("sibling");
        fs::create_dir_all(&child).expect("quarantined child");
        fs::write(child.join("original.txt"), "original\n").expect("original file");
        fs::create_dir(&sibling).expect("sibling directory");
        fs::write(sibling.join("sibling.txt"), "must survive\n").expect("sibling sentinel");

        clear_windows_directory_bound_after_snapshot(&quarantine, None, || {
            fs::rename(&child, &moved_child).expect("move snapshotted child aside");
            fs::rename(&sibling, &child).expect("rebind child name to sibling");
        })
        .expect_err("the rebound child identity must stop cleanup");

        assert_eq!(
            fs::read_to_string(child.join("sibling.txt")).expect("sibling survives"),
            "must survive\n"
        );
        assert!(moved_child.join("original.txt").exists());
    }

    #[cfg(windows)]
    #[test]
    fn removal_deletes_a_junction_without_traversing_its_target() {
        let parent = tempfile::tempdir().expect("cleanup parent");
        let quarantine = parent.path().join("quarantine");
        let outside = parent.path().join("outside");
        let linked = quarantine.join("linked-outside");
        fs::create_dir(&quarantine).expect("quarantine directory");
        fs::create_dir(&outside).expect("outside directory");
        fs::write(outside.join("sentinel.txt"), "must survive\n").expect("outside sentinel");
        junction::create(&outside, &linked).expect("junction fixture");

        clear_windows_directory_bound_after_snapshot(&quarantine, None, || {})
            .expect("cleanup deletes only the junction object");

        assert_eq!(
            fs::read_to_string(outside.join("sentinel.txt")).expect("outside target survives"),
            "must survive\n"
        );
        assert!(!linked.exists());
    }

    #[cfg(windows)]
    #[test]
    fn removal_rejects_a_root_junction_without_traversing_its_target() {
        let parent = tempfile::tempdir().expect("cleanup parent");
        let outside = parent.path().join("outside");
        let quarantine = parent.path().join("quarantine-junction");
        fs::create_dir(&outside).expect("outside directory");
        fs::write(outside.join("sentinel.txt"), "must survive\n").expect("outside sentinel");
        junction::create(&outside, &quarantine).expect("root junction fixture");

        assert!(
            open_removal_directory_lease(&quarantine).is_err(),
            "a root reparse point must never be admitted for recursive cleanup"
        );

        assert_eq!(
            fs::read_to_string(outside.join("sentinel.txt")).expect("outside target survives"),
            "must survive\n"
        );
    }

    #[test]
    fn branch_headers_require_an_actual_upstream_comparison() {
        assert_eq!(
            parse_branch_headers("# branch.head main\n# branch.upstream origin/main\n"),
            (Some("main".into()), None, 0, 0)
        );
        assert_eq!(
            parse_branch_headers(
                "# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n"
            ),
            (Some("main".into()), Some("origin/main".into()), 0, 0)
        );
    }

    #[test]
    fn inventory_rejects_truncated_output_and_only_falls_back_for_explicit_z_diagnostics() {
        let output = ProcessOutput {
            exit_code: 0,
            stdout: "worktree /repo\0\0".to_owned(),
            stderr: String::new(),
            stdout_truncated: true,
            stderr_truncated: false,
        };
        assert!(
            ensure_authoritative_inventory_output(
                "GitVcsDriver.worktreeInventory.list",
                Path::new("/repo"),
                &output,
            )
            .is_err()
        );
        assert!(is_unsupported_porcelain_z_diagnostic(
            "error: unknown option `z'\nusage: git worktree list"
        ));
        assert!(!is_unsupported_porcelain_z_diagnostic(
            "fatal: not a git repository"
        ));
        assert_eq!(
            git_output_line(" /repo with space \n"),
            Some(" /repo with space ")
        );
        assert_eq!(git_output_line("/one\n/two\n"), None);
    }

    #[tokio::test]
    async fn inventory_executes_legacy_fallback_once_and_caches_it_per_repository() {
        let runner = Arc::new(FakeGitRunner::new([
            process_output(0, ".git\n", ""),
            process_output(129, "", "error: unknown switch `z'"),
            process_output(
                0,
                "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n",
                "",
            ),
            process_output(0, ".git\n", ""),
            process_output(
                0,
                "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n",
                "",
            ),
        ]));
        let repository = GitRepository::with_runner_for_test(runner.clone());
        let anchor = tempfile::tempdir().expect("inventory anchor");
        let token = CancellationToken::new();

        for _ in 0..2 {
            let inventory = repository
                .worktree_inventory(anchor.path(), &token)
                .await
                .expect("legacy inventory");
            assert!(!inventory.nul_delimited);
        }

        let requests = runner.requests();
        let nul_request = requests
            .iter()
            .find(|request| request.args.iter().any(|argument| argument == "-z"))
            .expect("one capability probe");
        assert!(nul_request.allow_non_zero_exit);
        assert_eq!(nul_request.output_policy, OutputPolicy::Error);
        assert_eq!(
            nul_request.max_output_bytes,
            WORKTREE_INVENTORY_OUTPUT_LIMIT
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.args.iter().any(|argument| argument == "-z"))
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| {
                    request
                        .args
                        .iter()
                        .any(|argument| argument == "--porcelain")
                        && !request.args.iter().any(|argument| argument == "-z")
                })
                .count(),
            2
        );
        assert!(
            requests
                .iter()
                .filter(|request| {
                    request
                        .args
                        .iter()
                        .any(|argument| argument == "--porcelain")
                        && !request.args.iter().any(|argument| argument == "-z")
                })
                .all(|request| !request.allow_non_zero_exit)
        );
    }

    #[tokio::test]
    async fn verified_prune_rejects_a_successful_exit_when_the_target_registration_survives() {
        let fixture = tempfile::tempdir().expect("surviving target fixture");
        let admin_dir = fixture.path().join(".git/worktrees/target");
        fs::create_dir_all(&admin_dir).expect("worktree admin fixture");
        let target_path = fixture.path().join("target");
        fs::write(
            admin_dir.join("gitdir"),
            format!("{}/.git\n", display_path(&target_path)),
        )
        .expect("target admin identity");
        let inventory = format!(
            "worktree {}\0HEAD aaa\0branch refs/heads/main\0\0worktree {}\0HEAD bbb\0branch refs/heads/feature\0prunable stale\0\0",
            display_path(fixture.path()),
            display_path(&target_path),
        );
        let runner = Arc::new(FakeGitRunner::new([
            process_output(0, ".git\n", ""),
            process_output(0, &inventory, ""),
            process_output(0, "", "Removing worktrees/target: stale\n"),
            process_output(0, ".git\n", ""),
            process_output(0, &inventory, ""),
            process_output(0, ".git\n", ""),
            process_output(0, &inventory, ""),
            process_output(0, "", "Removing worktrees/target: stale\n"),
            process_output(0, "", ""),
            process_output(0, ".git\n", ""),
            process_output(0, &inventory, ""),
        ]));
        let repository = GitRepository::with_runner_for_test(runner.clone());
        let target = GitWorktreeRecord {
            path: target_path,
            head: Some("bbb".into()),
            branch: Some("feature".into()),
            is_primary: false,
            is_bare: false,
            locked: false,
            lock_reason: None,
            is_prunable: true,
            prunable_reason: Some("stale".into()),
        };
        let expected = repository
            .preview_worktree_prune(fixture.path(), &CancellationToken::new())
            .await
            .expect("preview");
        let digest = git_worktree_prune_impact_digest(&expected);

        let error = repository
            .prune_worktrees_verified(fixture.path(), &target, &digest, &CancellationToken::new())
            .await
            .expect_err("surviving target invalidates successful prune exit");
        assert!(error.detail.to_ascii_lowercase().contains("survived"));
        assert_eq!(
            runner
                .requests()
                .iter()
                .filter(|request| {
                    request.args.iter().any(|argument| argument == "prune")
                        && !request.args.iter().any(|argument| argument == "--dry-run")
                })
                .count(),
            1
        );
        let requests = runner.requests();
        let mutation_index = requests
            .iter()
            .position(|request| {
                request.args.iter().any(|argument| argument == "prune")
                    && !request.args.iter().any(|argument| argument == "--dry-run")
            })
            .expect("prune mutation request");
        assert!(
            mutation_index > 0
                && requests[mutation_index - 1]
                    .args
                    .iter()
                    .any(|argument| argument == "--dry-run"),
            "the confirmed dry-run is the final Git command before prune mutation"
        );
    }

    #[tokio::test]
    async fn verified_prune_rejects_a_same_reason_admin_identity_swap_before_mutation() {
        let fixture = tempfile::tempdir().expect("prune identity fixture");
        let common_dir = fixture.path().join(".git");
        let admin_dir = common_dir.join("worktrees/target");
        fs::create_dir_all(&admin_dir).expect("worktree admin fixture");
        let old_path = fixture.path().join("old-target");
        let new_path = fixture.path().join("new-target");
        fs::write(
            admin_dir.join("gitdir"),
            format!("{}/.git\n", display_path(&old_path)),
        )
        .expect("old admin identity");
        let inventory = format!(
            "worktree {}\0HEAD aaa\0branch refs/heads/main\0\0worktree {}\0HEAD bbb\0branch refs/heads/feature\0prunable stale\0\0",
            display_path(fixture.path()),
            display_path(&old_path),
        );
        let after_prune = format!(
            "worktree {}\0HEAD aaa\0branch refs/heads/main\0\0",
            display_path(fixture.path()),
        );
        let replacement_gitdir = admin_dir.join("gitdir");
        let replacement_path = new_path.clone();
        let runner = Arc::new(FakeGitRunner::with_dry_run_action(
            [
                process_output(0, ".git\n", ""),
                process_output(0, &inventory, ""),
                process_output(0, "", "Removing worktrees/target: stale\n"),
                process_output(0, "", ""),
                process_output(0, ".git\n", ""),
                process_output(0, &after_prune, ""),
            ],
            Arc::new(move || {
                fs::write(
                    &replacement_gitdir,
                    format!("{}/.git\n", display_path(&replacement_path)),
                )
                .expect("swap admin identity");
            }),
        ));
        let repository = GitRepository::with_runner_for_test(runner.clone());
        let target = GitWorktreeRecord {
            path: old_path.clone(),
            head: Some("bbb".into()),
            branch: Some("feature".into()),
            is_primary: false,
            is_bare: false,
            locked: false,
            lock_reason: None,
            is_prunable: true,
            prunable_reason: Some("stale".into()),
        };
        let confirmed = [GitPrunableWorktree {
            path: old_path,
            prune_reason: "stale".into(),
            locked: false,
            lock_reason: None,
        }];

        repository
            .prune_worktrees_verified(
                fixture.path(),
                &target,
                &git_worktree_prune_impact_digest(&confirmed),
                &CancellationToken::new(),
            )
            .await
            .expect_err("same-reason replacement cannot inherit confirmed impact");
        assert_eq!(
            runner
                .requests()
                .iter()
                .filter(|request| {
                    request.args.iter().any(|argument| argument == "prune")
                        && !request.args.iter().any(|argument| argument == "--dry-run")
                })
                .count(),
            0,
            "identity drift is rejected before repository-wide prune"
        );
    }

    #[tokio::test]
    async fn verified_prune_rejects_same_path_reason_drift_before_mutation() {
        let fixture = tempfile::tempdir().expect("prune reason fixture");
        let common_dir = fixture.path().join(".git");
        let target_admin = common_dir.join("worktrees/target");
        let other_admin = common_dir.join("worktrees/other");
        fs::create_dir_all(&target_admin).expect("target admin fixture");
        fs::create_dir_all(&other_admin).expect("other admin fixture");
        let target_path = fixture.path().join("target");
        let other_path = fixture.path().join("other");
        fs::write(
            target_admin.join("gitdir"),
            format!("{}/.git\n", display_path(&target_path)),
        )
        .expect("target admin identity");
        fs::write(
            other_admin.join("gitdir"),
            format!("{}/.git\n", display_path(&other_path)),
        )
        .expect("other admin identity");
        let inventory = format!(
            "worktree {}\0HEAD aaa\0branch refs/heads/main\0\0worktree {}\0HEAD bbb\0branch refs/heads/target\0prunable stale\0\0worktree {}\0HEAD ccc\0branch refs/heads/other\0prunable reason-after-preview\0\0",
            display_path(fixture.path()),
            display_path(&target_path),
            display_path(&other_path),
        );
        let after_prune = format!(
            "worktree {}\0HEAD aaa\0branch refs/heads/main\0\0",
            display_path(fixture.path()),
        );
        let runner = Arc::new(FakeGitRunner::new([
            process_output(0, ".git\n", ""),
            process_output(0, &inventory, ""),
            process_output(
                0,
                "",
                "Removing worktrees/target: stale\nRemoving worktrees/other: reason-after-preview\n",
            ),
            process_output(0, "", ""),
            process_output(0, ".git\n", ""),
            process_output(0, &after_prune, ""),
        ]));
        let repository = GitRepository::with_runner_for_test(runner.clone());
        let target = GitWorktreeRecord {
            path: target_path.clone(),
            head: Some("bbb".into()),
            branch: Some("target".into()),
            is_primary: false,
            is_bare: false,
            locked: false,
            lock_reason: None,
            is_prunable: true,
            prunable_reason: Some("stale".into()),
        };
        let confirmed = [
            GitPrunableWorktree {
                path: target_path,
                prune_reason: "stale".into(),
                locked: false,
                lock_reason: None,
            },
            GitPrunableWorktree {
                path: other_path,
                prune_reason: "reason-before-preview".into(),
                locked: false,
                lock_reason: None,
            },
        ];

        repository
            .prune_worktrees_verified(
                fixture.path(),
                &target,
                &git_worktree_prune_impact_digest(&confirmed),
                &CancellationToken::new(),
            )
            .await
            .expect_err("same-path reason drift invalidates confirmed impact");
        assert_eq!(
            runner
                .requests()
                .iter()
                .filter(|request| {
                    request.args.iter().any(|argument| argument == "prune")
                        && !request.args.iter().any(|argument| argument == "--dry-run")
                })
                .count(),
            0,
            "reason drift is rejected before repository-wide prune"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn prune_admin_identity_resolution_rejects_symlinks_oversize_and_cancellation() {
        use std::os::unix::fs::symlink;

        let fixture = tempfile::tempdir().expect("admin identity fixture");
        let common_dir = fixture.path().join(".git");
        let worktrees_dir = common_dir.join("worktrees");
        let outside_admin = fixture.path().join("outside-admin");
        fs::create_dir_all(&outside_admin).expect("outside admin fixture");
        fs::create_dir_all(&worktrees_dir).expect("worktrees admin root");
        let common_dir = fs::canonicalize(&common_dir).expect("canonical common directory");
        fs::write(outside_admin.join("gitdir"), "/target/.git\n").expect("outside gitdir fixture");
        symlink(&outside_admin, worktrees_dir.join("linked")).expect("symlinked admin fixture");
        let record = |admin_id: &str| WorktreePruneDryRunRecord {
            admin_id: admin_id.to_owned(),
            reason: "stale".to_owned(),
        };

        resolve_worktree_prune_paths(
            fixture.path(),
            &common_dir,
            vec![record("linked")],
            &CancellationToken::new(),
        )
        .await
        .expect_err("symlinked admin directory is rejected");

        let oversized_admin = worktrees_dir.join("oversized");
        fs::create_dir(&oversized_admin).expect("oversized admin fixture");
        fs::write(
            oversized_admin.join("gitdir"),
            vec![b'x'; WORKTREE_PRUNE_GITDIR_LIMIT as usize + 1],
        )
        .expect("oversized gitdir fixture");
        resolve_worktree_prune_paths(
            fixture.path(),
            &common_dir,
            vec![record("oversized")],
            &CancellationToken::new(),
        )
        .await
        .expect_err("oversized gitdir identity is rejected");

        let cancellation = CancellationToken::new();
        cancellation.cancel();
        resolve_worktree_prune_paths(
            fixture.path(),
            &common_dir,
            vec![record("oversized")],
            &cancellation,
        )
        .await
        .expect_err("cancelled identity resolution cannot approach mutation");
    }

    struct FakeGitRunner {
        outputs: Mutex<VecDeque<ProcessOutput>>,
        requests: Mutex<Vec<ProcessRequest>>,
        dry_run_action: Option<Arc<dyn Fn() + Send + Sync>>,
    }

    impl FakeGitRunner {
        fn new(outputs: impl IntoIterator<Item = ProcessOutput>) -> Self {
            Self {
                outputs: Mutex::new(outputs.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
                dry_run_action: None,
            }
        }

        fn with_dry_run_action(
            outputs: impl IntoIterator<Item = ProcessOutput>,
            dry_run_action: Arc<dyn Fn() + Send + Sync>,
        ) -> Self {
            Self {
                outputs: Mutex::new(outputs.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
                dry_run_action: Some(dry_run_action),
            }
        }

        fn requests(&self) -> Vec<ProcessRequest> {
            self.requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }
    }

    impl GitProcessRunner for FakeGitRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            _cancellation: &'a CancellationToken,
        ) -> super::BoxGitProcessFuture<'a> {
            if request.args.iter().any(|argument| argument == "--dry-run")
                && let Some(action) = self.dry_run_action.as_ref()
            {
                action();
            }
            self.requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(request);
            let output = self
                .outputs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pop_front()
                .expect("fake output");
            Box::pin(async move { Ok(output) })
        }
    }

    fn process_output(exit_code: i32, stdout: &str, stderr: &str) -> ProcessOutput {
        ProcessOutput {
            exit_code,
            stdout: stdout.to_owned(),
            stderr: stderr.to_owned(),
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "BiBCode Test")
            .env("GIT_AUTHOR_EMAIL", "bibcode@example.invalid")
            .env("GIT_COMMITTER_NAME", "BiBCode Test")
            .env("GIT_COMMITTER_EMAIL", "bibcode@example.invalid")
            .output()
            .expect("git starts");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn repository() -> TempDir {
        let repo = tempfile::tempdir().expect("temporary repository");
        git(repo.path(), &["init", "-b", "main"]);
        fs::write(repo.path().join("README.md"), "base\n").expect("write fixture");
        git(repo.path(), &["add", "README.md"]);
        git(repo.path(), &["commit", "-m", "initial"]);
        repo
    }

    #[tokio::test]
    async fn ensure_worktree_reuses_the_canonical_path_for_an_existing_branch() {
        let repo = repository();
        let parent = tempfile::tempdir().expect("worktree parent");
        let path = parent.path().join("feature");
        let input = CreateWorktreeInput {
            cwd: repo.path().to_path_buf(),
            ref_name: "main".to_owned(),
            new_ref_name: Some("feature".to_owned()),
            base_ref_name: None,
            path: Some(path),
        };
        let repository = GitRepository::default();
        let created = repository
            .create_worktree(input.clone(), &CancellationToken::new())
            .await
            .expect("create worktree");
        let ensured = repository
            .ensure_worktree(input, &CancellationToken::new())
            .await
            .expect("ensure existing worktree");

        assert_eq!(ensured.worktree.path, created.worktree.path);
        assert_eq!(ensured.worktree.ref_name, "feature");
        let worktrees = git(repo.path(), &["worktree", "list", "--porcelain"]);
        assert_eq!(worktrees.matches("branch refs/heads/feature").count(), 1);
        assert!(!worktrees.contains("refs/heads/feature-2"));
    }

    #[tokio::test]
    async fn failed_detached_preparation_cleans_its_owned_reserved_path() {
        let repo = repository();
        let parent = tempfile::tempdir().expect("worktree parent");
        let path = parent.path().join("reserved");
        let owned = OwnedWorktreePath::reserve(path.clone()).expect("reserve absent path");

        GitRepository::default()
            .prepare_detached_owned_worktree(
                repo.path(),
                "missing-ref",
                &owned,
                &CancellationToken::new(),
            )
            .await
            .expect_err("missing base fails detached preparation");

        assert!(!path.exists());
        assert!(
            !git(repo.path(), &["worktree", "list", "--porcelain"])
                .replace('\\', "/")
                .contains(&display_path(&path))
        );
    }

    #[tokio::test]
    async fn cancelled_detached_preparation_cleans_its_owned_reserved_path() {
        let repo = repository();
        let parent = tempfile::tempdir().expect("worktree parent");
        let path = parent.path().join("reserved");
        let owned = OwnedWorktreePath::reserve(path.clone()).expect("reserve absent path");
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        GitRepository::default()
            .prepare_detached_owned_worktree(repo.path(), "main", &owned, &cancelled)
            .await
            .expect_err("cancelled detached preparation fails");

        assert!(!path.exists());
        assert!(
            !git(repo.path(), &["worktree", "list", "--porcelain"])
                .replace('\\', "/")
                .contains(&display_path(&path))
        );
    }

    #[tokio::test]
    async fn cancelled_branch_checkout_cleans_the_prepared_detached_worktree() {
        let repo = repository();
        let parent = tempfile::tempdir().expect("worktree parent");
        let path = parent.path().join("reserved");
        let owned = OwnedWorktreePath::reserve(path.clone()).expect("reserve absent path");
        let repository = GitRepository::default();
        repository
            .prepare_detached_owned_worktree(repo.path(), "main", &owned, &CancellationToken::new())
            .await
            .expect("Git accepts an atomically reserved empty directory");
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        repository
            .checkout_owned_suffixed_branch(repo.path(), &owned, "main-2", &cancelled)
            .await
            .expect_err("cancelled checkout fails");

        assert!(!path.exists());
        assert!(git(repo.path(), &["branch", "--list", "main-2"]).is_empty());
        assert!(
            !git(repo.path(), &["worktree", "list", "--porcelain"])
                .replace('\\', "/")
                .contains(&display_path(&path))
        );
    }

    #[tokio::test]
    async fn cancelled_branch_checkout_rolls_back_branch_claimed_by_owned_worktree() {
        let repo = repository();
        let parent = tempfile::tempdir().expect("worktree parent");
        let path = parent.path().join("reserved");
        let owned = OwnedWorktreePath::reserve(path.clone()).expect("reserve absent path");
        let repository = GitRepository::default();
        repository
            .prepare_detached_owned_worktree(repo.path(), "main", &owned, &CancellationToken::new())
            .await
            .expect("prepare detached worktree");
        git(&path, &["checkout", "-b", "main-2"]);
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        repository
            .checkout_owned_suffixed_branch(repo.path(), &owned, "main-2", &cancelled)
            .await
            .expect_err("cancelled checkout fails");

        assert!(!path.exists());
        assert!(git(repo.path(), &["branch", "--list", "main-2"]).is_empty());
    }

    #[tokio::test]
    async fn competing_branch_checkout_failure_cleans_only_the_owned_worktree() {
        let repo = repository();
        let parent = tempfile::tempdir().expect("worktree parent");
        let path = parent.path().join("reserved");
        let owned = OwnedWorktreePath::reserve(path.clone()).expect("reserve absent path");
        let repository = GitRepository::default();
        repository
            .prepare_detached_owned_worktree(repo.path(), "main", &owned, &CancellationToken::new())
            .await
            .expect("prepare detached worktree");
        git(repo.path(), &["branch", "main-2"]);

        repository
            .checkout_owned_suffixed_branch(
                repo.path(),
                &owned,
                "main-2",
                &CancellationToken::new(),
            )
            .await
            .expect_err("competing branch makes checkout fail");

        assert!(!path.exists());
        assert_eq!(git(repo.path(), &["branch", "--list", "main-2"]), "main-2");
        assert!(
            !git(repo.path(), &["worktree", "list", "--porcelain"])
                .replace('\\', "/")
                .contains(&display_path(&path))
        );
    }
}
