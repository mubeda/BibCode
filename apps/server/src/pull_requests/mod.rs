//! Repository-scoped hosted pull request reads and operations.

mod action;
mod cache;
pub mod checkout;
pub mod context;
pub mod error;
pub mod github;
pub mod gitlab;
pub mod host;
pub mod model;
pub mod permissions;
mod read;

use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use tokio_util::sync::CancellationToken;

use context::{DiscoveredHosts, build_context, resolve_scope};
use error::PullRequestsOperationError;
use host::{HostCommandRunner, PullRequestHost};
use model::{
    ActionRequest, ActionResult, Checks, Commits, Context, Detail, Files, ListPage, ListQuery,
    Permission, Permissions, ReviewEvent, Timeline, Vocabulary, VocabularyKind,
};

type ActionGateKey = (bool, String, String, u64);
type ActionGates = Mutex<HashMap<ActionGateKey, Weak<tokio::sync::Mutex<()>>>>;

#[derive(Clone)]
pub struct PullRequestsService {
    runner: Arc<HostCommandRunner>,
    github: Arc<dyn PullRequestHost>,
    gitlab: Arc<dyn PullRequestHost>,
    action_gates: Arc<ActionGates>,
}

impl PullRequestsService {
    pub fn new(state_dir: PathBuf) -> Self {
        Self::with_runner(HostCommandRunner::new(state_dir))
    }

    pub fn with_runner(runner: HostCommandRunner) -> Self {
        let runner = Arc::new(runner);
        Self {
            github: Arc::new(github::GitHubHost::new(runner.clone())),
            gitlab: Arc::new(gitlab::GitLabHost::new(runner.clone())),
            runner,
            action_gates: Arc::default(),
        }
    }

    fn host(&self, scope: &host::HostScope) -> &dyn PullRequestHost {
        if scope.provider == crate::source_control::ProviderKind::Github {
            self.github.as_ref()
        } else {
            self.gitlab.as_ref()
        }
    }

    pub async fn context(
        &self,
        cwd: &Path,
        c: &CancellationToken,
    ) -> Result<Context, PullRequestsOperationError> {
        // An explicit context read is also Rescan/auth-recovery: never serve it
        // from a prior account, CLI installation or repository-policy snapshot.
        self.invalidate_contexts();
        bounded_read(
            "pullRequests.getContext",
            Duration::from_secs(30),
            c,
            |c| async move {
                let scope =
                    match resolve_scope(&self.runner, cwd, &DiscoveredHosts::default(), &c).await {
                        Ok(scope) => scope,
                        Err(unavailable) => return unavailable.into_context(),
                    };
                build_context(self.host(&scope), &self.runner, &scope, &c).await
            },
        )
        .await
        .inspect(|context| {
            // Availability is data on this RPC; these failures never reach inspect_err.
            if matches!(
                context,
                Context::Unavailable {
                    code: model::UnavailableCode::NotAuthenticated
                        | model::UnavailableCode::RepositoryUnreachable
                        | model::UnavailableCode::CliMissing
                        | model::UnavailableCode::CliTooOld,
                    ..
                }
            ) {
                self.invalidate_contexts();
            }
        })
        .inspect_err(|error| self.invalidate_failed_context(error))
    }

    pub async fn vocabulary(
        &self,
        cwd: &Path,
        kind: VocabularyKind,
        query: Option<&str>,
        c: &CancellationToken,
    ) -> Result<Vocabulary, PullRequestsOperationError> {
        bounded_read(
            "pullRequests.getVocabulary",
            Duration::from_secs(30),
            c,
            |c| async move {
                let scope = resolve_scope(&self.runner, cwd, &DiscoveredHosts::default(), &c)
                    .await
                    .map_err(|u| u.operation_error("pullRequests.getVocabulary"))?;
                self.host(&scope).vocabulary(&scope, kind, query, &c).await
            },
        )
        .await
        .inspect_err(|error| self.invalidate_failed_context(error))
    }

    pub async fn list(
        &self,
        cwd: &Path,
        query: ListQuery,
        c: &CancellationToken,
    ) -> Result<ListPage, PullRequestsOperationError> {
        bounded_read(
            "pullRequests.list",
            Duration::from_secs(60),
            c,
            |c| async move {
                let scope = resolve_scope(&self.runner, cwd, &DiscoveredHosts::default(), &c)
                    .await
                    .map_err(|u| u.operation_error("pullRequests.list"))?;
                self.host(&scope).list(&scope, &query, &c).await
            },
        )
        .await
        .inspect_err(|error| self.invalidate_failed_context(error))
    }
    pub async fn get(
        &self,
        cwd: &Path,
        number: u64,
        c: &CancellationToken,
    ) -> Result<Detail, PullRequestsOperationError> {
        let operation = "pullRequests.get";
        bounded_read(operation, Duration::from_secs(60), c, |c| async move {
            let scope = resolve_scope(&self.runner, cwd, &DiscoveredHosts::default(), &c)
                .await
                .map_err(|u| u.operation_error(operation))?;
            let host = self.host(&scope);
            let context = host.context(&scope, &c).await.map_err(|mut e| {
                e.operation = operation.into();
                e
            })?;
            let raw = host.detail(&scope, number, &context, &c).await?;
            let (permissions, readiness) = permissions::compute(&raw.inputs);
            let mut detail = raw.detail_without_permissions;
            for reviewer in &mut detail.reviewers {
                reviewer.can_rerequest = permissions::can_rerequest(&permissions, reviewer.state);
            }
            detail.permissions = permissions;
            detail.readiness = readiness;
            Ok(detail)
        })
        .await
        .inspect_err(|error| self.invalidate_failed_context(error))
    }

    pub async fn timeline(
        &self,
        cwd: &Path,
        number: u64,
        c: &CancellationToken,
    ) -> Result<Timeline, PullRequestsOperationError> {
        let operation = "pullRequests.getTimeline";
        bounded_read(operation, Duration::from_secs(60), c, |c| async move {
            let scope = resolve_scope(&self.runner, cwd, &DiscoveredHosts::default(), &c)
                .await
                .map_err(|u| u.operation_error(operation))?;
            self.host(&scope).timeline(&scope, number, &c).await
        })
        .await
        .inspect_err(|error| self.invalidate_failed_context(error))
    }

    pub async fn commits(
        &self,
        cwd: &Path,
        number: u64,
        c: &CancellationToken,
    ) -> Result<Commits, PullRequestsOperationError> {
        let operation = "pullRequests.getCommits";
        bounded_read(operation, Duration::from_secs(60), c, |c| async move {
            let scope = resolve_scope(&self.runner, cwd, &DiscoveredHosts::default(), &c)
                .await
                .map_err(|u| u.operation_error(operation))?;
            self.host(&scope).commits(&scope, number, &c).await
        })
        .await
        .inspect_err(|error| self.invalidate_failed_context(error))
    }

    pub async fn checks(
        &self,
        cwd: &Path,
        number: u64,
        c: &CancellationToken,
    ) -> Result<Checks, PullRequestsOperationError> {
        let operation = "pullRequests.getChecks";
        bounded_read(operation, Duration::from_secs(60), c, |c| async move {
            let scope = resolve_scope(&self.runner, cwd, &DiscoveredHosts::default(), &c)
                .await
                .map_err(|u| u.operation_error(operation))?;
            self.host(&scope).checks(&scope, number, &c).await
        })
        .await
        .inspect_err(|error| self.invalidate_failed_context(error))
    }

    pub async fn files(
        &self,
        cwd: &Path,
        number: u64,
        c: &CancellationToken,
    ) -> Result<Files, PullRequestsOperationError> {
        let operation = "pullRequests.getFiles";
        bounded_read(operation, Duration::from_secs(60), c, |c| async move {
            let scope = resolve_scope(&self.runner, cwd, &DiscoveredHosts::default(), &c)
                .await
                .map_err(|u| u.operation_error(operation))?;
            self.host(&scope).files(&scope, number, &c).await
        })
        .await
        .inspect_err(|error| self.invalidate_failed_context(error))
    }

    pub async fn run_action(
        &self,
        action: &ActionRequest,
        c: &CancellationToken,
    ) -> Result<ActionResult, PullRequestsOperationError> {
        let operation = "pullRequests.runAction";
        action::validate(action)?;
        bounded_read(operation, Duration::from_secs(60), c, |c| async move {
            let scope = resolve_scope(
                &self.runner,
                Path::new(&action.target().cwd),
                &DiscoveredHosts::default(),
                &c,
            )
            .await
            .map_err(|u| u.operation_error(operation))?;
            self.run_scoped_action(&scope, action, &c).await
        })
        .await
        .inspect_err(|error| self.invalidate_failed_context(error))
        .map_err(|mut error| {
            error.operation = operation.into();
            error
        })
    }

    async fn acquire_action_gate(
        &self,
        scope: &host::HostScope,
        number: u64,
        operation: &str,
        c: &CancellationToken,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, PullRequestsOperationError> {
        let gate = {
            let mut gates = self.action_gates.lock().unwrap_or_else(|p| p.into_inner());
            gates.retain(|_, gate| gate.strong_count() > 0);
            let key = (
                scope.provider == crate::source_control::ProviderKind::Github,
                scope.host.to_ascii_lowercase(),
                scope.repository.to_ascii_lowercase(),
                number,
            );
            if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
                gate
            } else {
                let gate = Arc::new(tokio::sync::Mutex::new(()));
                gates.insert(key, Arc::downgrade(&gate));
                gate
            }
        };
        tokio::select! {
            biased;
            () = c.cancelled() => Err(PullRequestsOperationError::new(operation, "timeout")),
            permit = gate.lock_owned() => Ok(permit),
        }
    }

    async fn run_scoped_action(
        &self,
        scope: &host::HostScope,
        action: &ActionRequest,
        c: &CancellationToken,
    ) -> Result<ActionResult, PullRequestsOperationError> {
        let operation = "pullRequests.runAction";
        // Serialize the entire read/modify/write sequence by remote identity,
        // including callers using a different checkout or a cloned service.
        let _permit = self
            .acquire_action_gate(scope, action.target().number, operation, c)
            .await?;
        let host = self.host(scope);
        let context = host.context(scope, c).await?;
        let raw = host
            .action_detail(scope, action.target().number, &context, c)
            .await?;
        if let ActionRequest::SubmitReview { head_sha, .. } | ActionRequest::Merge { head_sha, .. } =
            action
            && head_sha != &raw.inputs.head_sha
        {
            return Err(PullRequestsOperationError::new(operation, "stale_head"));
        }
        let (permissions, _) = permissions::compute(&raw.inputs);
        let caps = &raw.inputs.capabilities;
        let supported = match action {
            ActionRequest::MinimizeComment { .. } => caps.minimize_comment,
            ActionRequest::SubmitReview {
                event: ReviewEvent::RequestChanges,
                ..
            } => caps.request_changes,
            ActionRequest::RevokeApproval { .. } => caps.revoke_approval,
            ActionRequest::RemoveOwnChangeRequest { .. } => caps.remove_own_change_request,
            ActionRequest::DismissReview { .. } => caps.dismiss_review,
            ActionRequest::ApplySuggestions { .. } => caps.apply_suggestion,
            ActionRequest::Delete { .. } => caps.delete_pull_request,
            _ => true,
        };
        for permission in action_permissions(action, &permissions) {
            if !permission.allowed {
                let mut error = PullRequestsOperationError::new(
                    operation,
                    if supported {
                        "forbidden"
                    } else {
                        "unavailable"
                    },
                );
                error.message = permission
                    .reason
                    .clone()
                    .unwrap_or_else(|| permissions::reasons::HOST_DATA.into());
                return Err(error);
            }
        }
        let method_error = match action {
            ActionRequest::Merge { method, .. } if !permissions.merge.methods.contains(method) => {
                let label = match method {
                    model::MergeMethod::Merge => "Merge commit",
                    model::MergeMethod::Squash => "Squash",
                    model::MergeMethod::Rebase => "Rebase",
                };
                Some(format!("{label} merging is not allowed in this repository"))
            }
            ActionRequest::UpdateBranch { method, .. }
                if !permissions.update_branch.methods.contains(method) =>
            {
                Some("This branch update method is not allowed in this repository".into())
            }
            _ => None,
        };
        if let Some(message) = method_error {
            let mut error = PullRequestsOperationError::new(operation, "forbidden");
            error.message = message;
            return Err(error);
        }
        host.run_action(scope, action, &raw.context, c).await
    }

    fn invalidate_contexts(&self) {
        self.runner.clear_context_probes();
        self.github.invalidate_context();
        self.gitlab.invalidate_context();
    }

    fn invalidate_failed_context(&self, error: &PullRequestsOperationError) {
        if matches!(
            error.code,
            "not_authenticated" | "forbidden" | "not_found" | "cli_missing" | "cli_too_old"
        ) {
            self.invalidate_contexts();
        }
    }
}

fn action_permissions<'a>(action: &ActionRequest, p: &'a Permissions) -> Vec<&'a Permission> {
    use ActionRequest::*;
    match action {
        Comment { .. } | ReplyThread { .. } => vec![&p.comment],
        EditComment { .. } => vec![&p.edit_own_comment],
        DeleteComment { .. } => vec![&p.delete_own_comment],
        MinimizeComment { .. } => vec![&p.minimize_comment],
        React { .. } => vec![&p.react],
        ResolveThread { .. } => vec![&p.resolve_threads],
        SubmitReview { event, .. } => match event {
            ReviewEvent::Comment => vec![&p.review],
            ReviewEvent::Approve => vec![&p.review, &p.approve],
            ReviewEvent::RequestChanges => vec![&p.review, &p.request_changes],
        },
        RevokeApproval { .. } => vec![&p.revoke_approval],
        RemoveOwnChangeRequest { .. } => vec![&p.remove_own_change_request],
        DismissReview { .. } => vec![&p.dismiss_review],
        RerequestReview { .. } => vec![&p.rerequest_review],
        ApplySuggestions { .. } => vec![&p.apply_suggestion],
        EditPullRequest { .. } => vec![&p.edit_pull_request],
        SetReviewers { .. } => vec![&p.edit_reviewers],
        SetAssignees { .. } => vec![&p.edit_assignees],
        SetLabels { .. } => vec![&p.edit_labels],
        SetMilestone { .. } => vec![&p.edit_milestone],
        Lock { .. } => vec![&p.lock],
        Unlock { .. } => vec![&p.unlock],
        UpdateBranch { .. } => vec![&p.update_branch.permission],
        Merge { bypass, auto, .. } => {
            // These permissions include merge rights and their own readiness rules.
            // Requiring immediate merge readiness would make both paths unreachable.
            let mut required = Vec::new();
            if *bypass {
                required.push(&p.merge_bypass);
            }
            if *auto {
                required.push(&p.enable_auto_merge);
            }
            if required.is_empty() {
                required.push(&p.merge.permission);
            }
            required
        }
        DisableAutoMerge { .. } => vec![&p.disable_auto_merge],
        SetDraft { draft, .. } => vec![if *draft {
            &p.convert_to_draft
        } else {
            &p.mark_ready
        }],
        Close { .. } => vec![&p.close],
        Reopen { .. } => vec![&p.reopen],
        Delete { .. } => vec![&p.delete],
        Revert { .. } => vec![&p.revert],
    }
}

/// One deadline includes discovery, authentication, metadata, pages and mutations.
/// On expiry/cancellation, cancel and await the owned operation so ProcessRunner can
/// finish its bounded process-tree cleanup before reporting completion.
async fn bounded_read<T, F: Future<Output = Result<T, PullRequestsOperationError>>>(
    operation: &str,
    duration: Duration,
    parent: &CancellationToken,
    read: impl FnOnce(CancellationToken) -> F,
) -> Result<T, PullRequestsOperationError> {
    let cancellation = parent.child_token();
    let _guard = cancellation.clone().drop_guard();
    let future = read(cancellation.clone());
    tokio::pin!(future);
    tokio::select! {
        biased;
        _ = parent.cancelled() => {
            cancellation.cancel();
            interrupted_result(operation, future.await)
        }
        _ = tokio::time::sleep(duration) => {
            cancellation.cancel();
            interrupted_result(operation, future.await)
        }
        result = &mut future => result,
    }
}

fn interrupted_result<T>(
    operation: &str,
    result: Result<T, PullRequestsOperationError>,
) -> Result<T, PullRequestsOperationError> {
    // A mutation may already have posted comments. Preserve its settled result
    // after cleanup instead of replacing that receipt with an ambiguous timeout.
    if operation == action::OP || operation == checkout::OP {
        result
    } else {
        Err(PullRequestsOperationError::new(operation, "timeout"))
    }
}

#[cfg(test)]
mod service_tests {
    use super::*;
    use crate::pull_requests::{error::PullRequestsOperationError, model::*};
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };
    use tokio_util::sync::CancellationToken;

    struct ActionHost {
        inputs: PermissionInputs,
        calls: Arc<AtomicUsize>,
        context_calls: Option<Arc<AtomicUsize>>,
        block_first: Option<Arc<tokio::sync::Notify>>,
    }

    impl PullRequestHost for ActionHost {
        fn kind(&self) -> crate::source_control::ProviderKind {
            crate::source_control::ProviderKind::Github
        }
        fn capabilities(&self, _: Option<&host::HostVersion>) -> HostCapabilities {
            self.inputs.capabilities.clone()
        }
        fn context<'a>(
            &'a self,
            _: &'a host::HostScope,
            _: &'a CancellationToken,
        ) -> host::HostFuture<'a, host::HostContext> {
            Box::pin(async move {
                if let Some(calls) = &self.context_calls {
                    calls.fetch_add(1, Ordering::SeqCst);
                }
                Ok(host::HostContext {
                    provider: PullRequestsProvider::Github,
                    host: "github.com".into(),
                    repository: "owner/repo".into(),
                    host_version: None,
                    default_branch: "main".into(),
                    account: Actor {
                        login: self.inputs.viewer_login.clone(),
                        name: None,
                        is_bot: false,
                    },
                    repository_permission: self.inputs.repository_permission,
                    merge_policy: self.inputs.merge_policy.clone(),
                    web_url: "https://github.com/owner/repo".into(),
                    raw_host_version: None,
                    gitlab_access_level: None,
                })
            })
        }
        fn vocabulary<'a>(
            &'a self,
            _: &'a host::HostScope,
            _: VocabularyKind,
            _: Option<&'a str>,
            _: &'a CancellationToken,
        ) -> host::HostFuture<'a, Vocabulary> {
            unreachable!()
        }
        fn list<'a>(
            &'a self,
            _: &'a host::HostScope,
            _: &'a ListQuery,
            _: &'a CancellationToken,
        ) -> host::HostFuture<'a, ListPage> {
            unreachable!()
        }
        fn detail<'a>(
            &'a self,
            _: &'a host::HostScope,
            _: u64,
            _: &'a host::HostContext,
            _: &'a CancellationToken,
        ) -> host::HostFuture<'a, DetailRaw> {
            Box::pin(async move {
                let (permissions, readiness) = permissions::compute(&self.inputs);
                let value = serde_json::json!({
                    "number":14,"title":"Review","body":"","state":"open","isDraft":false,"locked":false,"lockReason":null,
                    "author":{"login":"author","name":null,"isBot":false},"createdAt":"now","updatedAt":"now","mergedAt":null,"closedAt":null,"mergedBy":null,
                    "headBranch":"feature","baseBranch":"main","headSha":self.inputs.head_sha,"baseSha":"base","isCrossRepository":false,"headRepository":null,"maintainerCanModify":true,
                    "commitCount":1,"changedFiles":1,"additions":1,"deletions":1,"labels":[],"milestone":null,"assignees":[],"reviewers":[],"approvalRules":[],"linkedIssues":[],"reactions":[],
                    "readiness":readiness,"permissions":permissions,"url":"https://github.com/owner/repo/pull/14","tabCounts":{"conversation":0,"commits":1,"checks":0,"files":1}
                });
                Ok(DetailRaw {
                    merge_commit_sha: None,
                    detail_without_permissions: serde_json::from_value(value).unwrap(),
                    inputs: self.inputs.clone(),
                })
            })
        }
        fn run_action<'a>(
            &'a self,
            _: &'a host::HostScope,
            _: &'a ActionRequest,
            _: &'a ActionContext,
            _: &'a CancellationToken,
        ) -> host::HostFuture<'a, ActionResult> {
            Box::pin(async move {
                let index = self.calls.fetch_add(1, Ordering::SeqCst);
                if index == 0
                    && let Some(release) = &self.block_first
                {
                    release.notified().await;
                }
                Ok(ActionResult::Done)
            })
        }
        fn head_ref_spec(&self, _: u64) -> String {
            unreachable!()
        }
    }

    async fn action_precheck(
        inputs: PermissionInputs,
        action: ActionRequest,
    ) -> (Result<ActionResult, PullRequestsOperationError>, usize) {
        let calls = Arc::new(AtomicUsize::new(0));
        let fake = Arc::new(ActionHost {
            inputs,
            calls: calls.clone(),
            context_calls: None,
            block_first: None,
        });
        let service = PullRequestsService {
            runner: Arc::new(HostCommandRunner::new(PathBuf::new())),
            github: fake.clone(),
            gitlab: fake,
            action_gates: Arc::default(),
        };
        let scope = host::HostScope {
            cwd: PathBuf::from("/repo"),
            host: "github.com".into(),
            repository: "owner/repo".into(),
            provider: crate::source_control::ProviderKind::Github,
        };
        let result = service
            .run_scoped_action(&scope, &action, &CancellationToken::new())
            .await;
        (result, calls.load(Ordering::SeqCst))
    }

    fn review_action(event: ReviewEvent, head: &str) -> ActionRequest {
        ActionRequest::SubmitReview {
            target: ActionTarget {
                cwd: "/repo".into(),
                number: 14,
            },
            event,
            head_sha: head.into(),
            body: Some("review".into()),
            comments: vec![],
        }
    }

    #[tokio::test]
    async fn pull_requests_actions_serialize_fresh_reads_across_checkouts_and_cancel_queued_work() {
        let calls = Arc::new(AtomicUsize::new(0));
        let contexts = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let fake = Arc::new(ActionHost {
            inputs: permissions::tests::github_inputs(),
            calls: calls.clone(),
            context_calls: Some(contexts.clone()),
            block_first: Some(release.clone()),
        });
        let service = PullRequestsService {
            runner: Arc::new(HostCommandRunner::new(PathBuf::new())),
            github: fake.clone(),
            gitlab: fake,
            action_gates: Arc::default(),
        };
        let scope = host::HostScope {
            cwd: "/checkout-a".into(),
            host: "github.com".into(),
            repository: "owner/repo".into(),
            provider: crate::source_control::ProviderKind::Github,
        };
        let mut other_checkout = scope.clone();
        other_checkout.cwd = "/checkout-b".into();
        other_checkout.repository = "Owner/Repo".into();
        let action =
            edit_action(serde_json::json!({"action":"setAssignees","add":["new"],"remove":[]}));
        let c = CancellationToken::new();
        let mut first = Box::pin(service.run_scoped_action(&scope, &action, &c));
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        let cloned = service.clone();
        let queued_c = CancellationToken::new();
        let mut second = Box::pin(cloned.run_scoped_action(&other_checkout, &action, &queued_c));
        assert!(
            futures_util::poll!(second.as_mut()).is_pending(),
            "a second edit must wait before reading a snapshot that could lose the first edit"
        );
        assert_eq!(contexts.load(Ordering::SeqCst), 1);
        queued_c.cancel();
        assert_eq!(second.await.unwrap_err().code, "timeout");
        assert_eq!(contexts.load(Ordering::SeqCst), 1);
        let mut other_action = action.clone();
        if let ActionRequest::SetAssignees { target, .. } = &mut other_action {
            target.number = 15;
        }
        assert_eq!(
            service
                .run_scoped_action(&scope, &other_action, &c)
                .await
                .unwrap(),
            ActionResult::Done
        );
        assert_eq!(
            contexts.load(Ordering::SeqCst),
            2,
            "a different PR stays independent"
        );
        release.notify_one();
        assert_eq!(first.await.unwrap(), ActionResult::Done);
        assert_eq!(
            cloned
                .run_scoped_action(&other_checkout, &action, &c)
                .await
                .unwrap(),
            ActionResult::Done
        );
        assert_eq!(
            contexts.load(Ordering::SeqCst),
            3,
            "the next edit gets a fresh snapshot after settlement"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    fn edit_action(mut value: serde_json::Value) -> ActionRequest {
        value["cwd"] = serde_json::json!("/repo");
        value["number"] = serde_json::json!(14);
        serde_json::from_value(value).unwrap()
    }

    fn merge_action() -> serde_json::Value {
        serde_json::json!({"action":"merge","method":"squash","deleteBranch":false,
            "auto":false,"bypass":false,"headSha":"head-sha","subject":null,"body":null})
    }

    #[tokio::test]
    async fn pull_requests_merge_bad_method_never_dispatches() {
        let mut inputs = permissions::tests::github_inputs();
        inputs.merge_policy.methods = vec![MergeMethod::Merge];
        let (result, calls) = action_precheck(inputs, edit_action(merge_action())).await;
        let error = result.unwrap_err();
        assert_eq!(error.code, "forbidden");
        assert_eq!(
            error.message,
            "Squash merging is not allowed in this repository"
        );
        assert_eq!(calls, 0);
    }

    #[tokio::test]
    async fn pull_requests_merge_stale_head_never_dispatches() {
        let mut action = merge_action();
        action["headSha"] = serde_json::json!("old-head");
        for inputs in [
            permissions::tests::github_inputs(),
            permissions::tests::gitlab_inputs(),
        ] {
            let (result, calls) = action_precheck(inputs, edit_action(action.clone())).await;
            assert_eq!(result.unwrap_err().code, "stale_head");
            assert_eq!(calls, 0);
        }
    }

    #[tokio::test]
    async fn pull_requests_merge_bypass_requires_its_permission() {
        let mut action = merge_action();
        action["bypass"] = serde_json::json!(true);
        let (result, calls) =
            action_precheck(permissions::tests::github_inputs(), edit_action(action)).await;
        assert_eq!(result.unwrap_err().code, "forbidden");
        assert_eq!(calls, 0);
    }

    #[tokio::test]
    async fn pull_requests_merge_bypass_and_auto_use_their_own_readiness_permissions() {
        for gitlab in [false, true] {
            for bypass in [false, true] {
                let mut inputs = if gitlab {
                    permissions::tests::gitlab_inputs()
                } else {
                    permissions::tests::github_inputs()
                };
                if let Some(gh) = &mut inputs.gh {
                    gh.merge_state_status = "BLOCKED".into();
                    gh.viewer_can_merge_as_admin = bypass;
                }
                if let Some(gl) = &mut inputs.gl {
                    gl.detailed_merge_status = if bypass {
                        "requested_changes"
                    } else {
                        "ci_still_running"
                    }
                    .into();
                }
                assert!(!permissions::compute(&inputs).0.merge.permission.allowed);
                let mut action = merge_action();
                action["bypass"] = serde_json::json!(bypass);
                action["auto"] = serde_json::json!(!bypass);
                let (result, calls) = action_precheck(inputs, edit_action(action)).await;
                assert_eq!(result.unwrap(), ActionResult::Done);
                assert_eq!(calls, 1);
            }
        }
    }

    #[tokio::test]
    async fn pull_requests_update_branch_rejects_disallowed_method() {
        let mut inputs = permissions::tests::gitlab_inputs();
        inputs.gl.as_mut().unwrap().detailed_merge_status = "need_rebase".into();
        let (result, calls) = action_precheck(
            inputs,
            edit_action(
                serde_json::json!({"action":"updateBranch","method":"merge","skipCi":false}),
            ),
        )
        .await;
        assert_eq!(result.unwrap_err().code, "forbidden");
        assert_eq!(calls, 0);
    }

    #[tokio::test]
    async fn pull_requests_edit_state_actions_enforce_permission_rows() {
        use serde_json::json;
        for value in [
            json!({"action":"editPullRequest","title":"updated"}),
            json!({"action":"setReviewers","add":["a"],"remove":[]}),
            json!({"action":"setAssignees","add":["a"],"remove":[]}),
            json!({"action":"setLabels","add":["a"],"remove":[]}),
            json!({"action":"setMilestone","milestoneId":"1"}),
            json!({"action":"lock","reason":null}),
            json!({"action":"unlock"}),
            json!({"action":"updateBranch","method":"merge","skipCi":false}),
            merge_action(),
            json!({"action":"disableAutoMerge"}),
            json!({"action":"setDraft","draft":true}),
            json!({"action":"setDraft","draft":false}),
            json!({"action":"close"}),
            json!({"action":"reopen"}),
            json!({"action":"revert"}),
        ] {
            let mut inputs = permissions::tests::github_inputs();
            inputs.repository_permission = RepositoryPermission::Read;
            inputs.gh.as_mut().unwrap().viewer_can_update = false;
            let (result, calls) = action_precheck(inputs, edit_action(value.clone())).await;
            assert_eq!(result.unwrap_err().code, "forbidden", "{value}");
            assert_eq!(calls, 0, "{value}");
        }
        let (result, calls) = action_precheck(
            permissions::tests::github_inputs(),
            edit_action(json!({"action":"delete"})),
        )
        .await;
        assert_eq!(result.unwrap_err().code, "unavailable");
        assert_eq!(calls, 0);
        let (result, calls) = action_precheck(
            permissions::tests::gitlab_inputs(),
            edit_action(json!({"action":"delete"})),
        )
        .await;
        assert_eq!(result.unwrap_err().code, "forbidden");
        assert_eq!(calls, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn pull_requests_action_deadline_retains_partial_failure_after_cleanup() {
        let cleaned = Arc::new(AtomicUsize::new(0));
        let observed = cleaned.clone();
        let result: Result<ActionResult, PullRequestsOperationError> = bounded_read(
            "pullRequests.runAction",
            Duration::from_secs(1),
            &CancellationToken::new(),
            |c| async move {
                c.cancelled().await;
                observed.fetch_add(1, Ordering::SeqCst);
                let mut error =
                    PullRequestsOperationError::new("pullRequests.runAction", "host_rejected");
                error.message = "2 comments were posted; approval failed.".into();
                Err(error)
            },
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, "host_rejected");
        assert!(error.message.contains("2 comments were posted"));
        assert_eq!(cleaned.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn pull_requests_action_precheck_denies_own_approval_without_host_action() {
        let mut inputs = permissions::tests::github_inputs();
        inputs.viewer_is_author = true;
        let (result, calls) =
            action_precheck(inputs, review_action(ReviewEvent::Approve, "head-sha")).await;
        let error = result.unwrap_err();
        assert_eq!(error.code, "forbidden");
        assert_eq!(error.message, "You cannot approve your own pull request.");
        assert_eq!(calls, 0);
    }

    #[tokio::test]
    async fn pull_requests_action_stale_head_denies_before_host_action() {
        let (result, calls) = action_precheck(
            permissions::tests::github_inputs(),
            review_action(ReviewEvent::Approve, "old-head"),
        )
        .await;
        assert_eq!(result.unwrap_err().code, "stale_head");
        assert_eq!(calls, 0);
    }

    #[tokio::test]
    async fn pull_requests_action_precheck_allows_review_once_and_checks_general_review_permission()
    {
        let inputs = permissions::tests::github_inputs();
        let (result, calls) = action_precheck(
            inputs.clone(),
            review_action(ReviewEvent::Approve, "head-sha"),
        )
        .await;
        assert_eq!(result.unwrap(), ActionResult::Done);
        assert_eq!(calls, 1);
        let mut inputs = inputs;
        inputs.state = PullRequestState::Closed;
        let (result, calls) =
            action_precheck(inputs, review_action(ReviewEvent::Comment, "head-sha")).await;
        assert_eq!(result.unwrap_err().message, permissions::reasons::NOT_OPEN);
        assert_eq!(calls, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn pull_requests_overall_deadline_covers_all_child_reads_and_awaits_cancellation() {
        let completed = Arc::new(AtomicUsize::new(0));
        let observed = completed.clone();
        let start = tokio::time::Instant::now();
        let result = bounded_read("pullRequests.list", Duration::from_secs(30), &CancellationToken::new(), |c| async move {
            for _ in 0..2 {
                tokio::select! {
                    _ = c.cancelled() => return Err(PullRequestsOperationError::new("pullRequests.list", "timeout")),
                    _ = tokio::time::sleep(Duration::from_secs(20)) => { observed.fetch_add(1, Ordering::SeqCst); }
                }
            }
            Ok(())
        }).await;
        assert_eq!(result.unwrap_err().code, "timeout");
        assert_eq!(completed.load(Ordering::SeqCst), 1);
        assert_eq!(start.elapsed(), Duration::from_secs(30));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pull_requests_service_scope_failure_is_context_data_and_other_reads_fail() {
        use crate::pull_requests::host::HostCommandRunner;
        use crate::test_support::TestSandbox;
        let s = TestSandbox::new("pr-service");
        let git = s.executable_script(
            "git",
            "echo \"error: No such remote 'origin'\" >&2; exit 2",
            "",
        );
        let service = PullRequestsService::with_runner(
            HostCommandRunner::new(s.path("state")).with_commands(
                "missing-gh",
                "missing-glab",
                git,
            ),
        );
        let c = CancellationToken::new();
        assert!(matches!(
            service.context(s.root(), &c).await.unwrap(),
            Context::Unavailable {
                code: UnavailableCode::NoRemote,
                ..
            }
        ));
        let error = service
            .vocabulary(s.root(), VocabularyKind::Labels, None, &c)
            .await
            .unwrap_err();
        assert_eq!(error.code, "unavailable");
        assert_eq!(error.operation, "pullRequests.getVocabulary");
        c.cancel();
        assert_eq!(
            service.context(s.root(), &c).await.unwrap_err().code,
            "timeout"
        );
    }
}

#[cfg(test)]
mod tripwires {
    fn violations(source: &str) -> Vec<&'static str> {
        let mut result = Vec::new();
        if [
            concat!("std::process", "::Command"),
            concat!("tokio::process", "::Command"),
        ]
        .iter()
        .any(|needle| source.contains(needle))
        {
            result.push("direct-process");
        }
        if [
            concat!("tokio::time", "::interval"),
            concat!("spawn_blocking(", "loop"),
            concat!("set", "Interval"),
        ]
        .iter()
        .any(|needle| source.contains(needle))
        {
            result.push("poller");
        }
        for (needle, violation) in [
            (concat!("reqwest", "::"), "direct-http"),
            (concat!("tokio", "::spawn("), "async-task"),
            (concat!("std::thread", "::spawn"), "thread-task"),
        ] {
            if source.contains(needle) {
                result.push(violation);
            }
        }
        for call in source.split(concat!("tracing", "::")).skip(1) {
            let call = call.split_once(");").map_or(call, |(call, _)| call);
            if [
                "host",
                "repository",
                "branch",
                "title",
                "body",
                "login",
                "url",
                "stderr",
            ]
            .iter()
            .any(|field| call.contains(field))
            {
                result.push("log-content");
            }
        }
        result
    }

    const SOURCES: &[(&str, &str)] = &[
        ("mod.rs", include_str!("mod.rs")),
        ("model.rs", include_str!("model.rs")),
        ("host.rs", include_str!("host.rs")),
        ("context.rs", include_str!("context.rs")),
        ("error.rs", include_str!("error.rs")),
        ("permissions.rs", include_str!("permissions.rs")),
        ("read.rs", include_str!("read.rs")),
        ("action.rs", include_str!("action.rs")),
        ("cache.rs", include_str!("cache.rs")),
        ("github/actions.rs", include_str!("github/actions.rs")),
        (
            "github/detail_tests.rs",
            include_str!("github/detail_tests.rs"),
        ),
        ("github/timeline.rs", include_str!("github/timeline.rs")),
        ("github/files.rs", include_str!("github/files.rs")),
        ("checkout.rs", include_str!("checkout.rs")),
        ("github/mod.rs", include_str!("github/mod.rs")),
        ("github/graphql.rs", include_str!("github/graphql.rs")),
        ("github/parse.rs", include_str!("github/parse.rs")),
        ("gitlab/mod.rs", include_str!("gitlab/mod.rs")),
        ("gitlab/actions.rs", include_str!("gitlab/actions.rs")),
        (
            "gitlab/detail_tests.rs",
            include_str!("gitlab/detail_tests.rs"),
        ),
        (
            "gitlab/review_positions.rs",
            include_str!("gitlab/review_positions.rs"),
        ),
        ("gitlab/parse.rs", include_str!("gitlab/parse.rs")),
        ("gitlab/graphql.rs", include_str!("gitlab/graphql.rs")),
        ("gitlab/timeline.rs", include_str!("gitlab/timeline.rs")),
        ("gitlab/files.rs", include_str!("gitlab/files.rs")),
        (
            "production/pull_requests_rpc.rs",
            include_str!("../production/pull_requests_rpc.rs"),
        ),
    ];

    #[test]
    fn pull_requests_tripwire_inventory_covers_every_module_file() {
        use std::{collections::BTreeSet, path::Path};

        fn visit(root: &Path, directory: &Path, files: &mut BTreeSet<String>) {
            for entry in std::fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    visit(root, &path, files);
                } else if path.extension().is_some_and(|extension| extension == "rs") {
                    files.insert(
                        path.strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }

        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/pull_requests");
        let mut files = BTreeSet::new();
        visit(&root, &root, &mut files);
        let scanned: BTreeSet<_> = SOURCES
            .iter()
            .filter(|(name, _)| !name.starts_with("production/"))
            .map(|(name, _)| (*name).to_owned())
            .collect();
        assert_eq!(files, scanned, "new modules must join the source tripwires");
    }

    #[test]
    fn pull_requests_default_runner_only_configures_gh_glab_and_git() {
        use super::host::{HostCommandRunner, command_specs_for_test};
        let runner = HostCommandRunner::new(std::path::PathBuf::from("unused-state"));
        let specs = command_specs_for_test(&runner);
        for (spec, expected) in specs.into_iter().zip(["gh", "glab", "git"]) {
            assert_eq!(spec.executable, std::path::Path::new(expected));
            assert!(
                spec.args(std::iter::empty()).is_empty(),
                "no wrapper commands"
            );
        }
    }

    #[test]
    fn pull_requests_log_hygiene_has_no_host_or_user_content() {
        for (name, source) in SOURCES {
            assert!(!violations(source).contains(&"log-content"), "{name}");
        }
    }

    #[test]
    fn pull_requests_process_surface_uses_only_the_existing_runner() {
        for (name, source) in SOURCES {
            assert!(!violations(source).contains(&"direct-process"), "{name}");
        }
    }

    #[test]
    fn pull_requests_module_has_no_background_pollers() {
        for (name, source) in SOURCES {
            assert!(!violations(source).contains(&"poller"), "{name}");
        }
    }

    #[test]
    fn pull_requests_tripwires_reject_http_and_background_tasks() {
        for (source, violation) in [
            (concat!("reqwest", "::Client::new()"), "direct-http"),
            (concat!("tokio", "::spawn(async {})"), "async-task"),
            (concat!("std::thread", "::spawn(|| {})"), "thread-task"),
        ] {
            assert!(violations(source).contains(&violation), "{violation}");
        }
    }

    #[test]
    fn pull_requests_module_has_no_http_or_detached_tasks() {
        for (name, source) in SOURCES {
            let found = violations(source);
            assert!(!found.contains(&"direct-http"), "{name}");
            assert!(!found.contains(&"thread-task"), "{name}");
            if *name != "production/pull_requests_rpc.rs" {
                assert!(!found.contains(&"async-task"), "{name}");
            }
        }
    }

    #[test]
    fn pull_requests_tripwires_allow_bounded_request_and_checkout_deadlines() {
        // These are one-shot safety deadlines, never background polling. Checkout's
        // write token is independent after handoff so a dropped caller cannot kill Git.
        for source in [
            "tokio::time::sleep(duration)",
            "tokio::time::timeout(deadline, request)",
            "Budget::CheckoutWrite => crate::git::CHECKOUT_WRITE_TIMEOUT",
            "Duration::from_secs(24 * 60 * 60)",
            "CancellationToken::new()",
        ] {
            assert!(violations(source).is_empty(), "{source}");
        }
    }

    #[test]
    fn pull_requests_tripwires_reject_sensitive_logs_direct_commands_and_pollers() {
        for prefix in [
            concat!("std::process", "::Command"),
            concat!("tokio::process", "::Command"),
        ] {
            assert!(violations(&format!("{prefix}::new(binary)")).contains(&"direct-process"));
        }
        for field in [
            "host",
            "repository",
            "branch",
            "title",
            "body",
            "login",
            "url",
            "stderr",
        ] {
            let source = format!(
                "{}info!(\n {field} = %{field},\n \"event\"\n);",
                concat!("tracing", "::")
            );
            assert!(violations(&source).contains(&"log-content"));
        }
        for poller in [
            concat!("tokio::time", "::interval"),
            concat!("spawn_blocking(", "loop"),
            concat!("set", "Interval"),
        ] {
            assert!(violations(poller).contains(&"poller"));
        }
        assert!(violations(concat!("tracing", "::info!(code, length);")).is_empty());
    }
}
