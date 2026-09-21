//! Pure server-owned policy. Host answers remain authoritative at mutation time.
use super::model::*;

/// All permission/readiness copy lives here, including parameterized templates.
pub mod reasons {
    pub const READ: &str = "Read access is required.";
    pub const LOCKED: &str = "This conversation is locked; write access is required.";
    pub const NOT_OPEN: &str = "This request is not open.";
    pub const NOT_CLOSED: &str = "Only a closed, unmerged request can be reopened.";
    pub const GH_AUTHOR: &str = "You cannot approve your own pull request.";
    pub const REVIEW_LOCKED: &str = "This pull request is locked. Unlock it before reviewing.";
    pub const GH_WRITE: &str = "Write access is required for this action.";
    pub const GH_UPDATE: &str = "GitHub does not allow your account to update this pull request.";
    pub const GH_TRIAGE: &str = "Triage access is required to edit labels or milestones.";
    pub const GH_SUGGESTION: &str =
        "GitHub has no public API for applying review suggestions. Apply it on GitHub.";
    pub const GH_REVOKE: &str = "GitHub does not support revoking your own submitted review.";
    pub const GH_DELETE: &str = "GitHub does not support deleting pull requests.";
    pub const GH_DISMISS: &str =
        "Write access or permission from the branch rule is required to dismiss a review.";
    pub const NO_DISMISSIBLE_REVIEW: &str = "There is no approval or change request to dismiss.";
    pub const NO_REVIEW: &str =
        "A reviewer must have reviewed before another review can be requested.";
    pub const NO_RESOLVE: &str = "The host does not allow you to resolve these threads.";
    pub const GL_MINIMIZE: &str = "GitLab does not support minimizing comments.";
    pub const GL_DISMISS: &str = "GitLab does not support dismissing reviews.";
    pub const GL_COMMENT: &str =
        "GitLab does not allow your account to comment on this merge request.";
    pub const GL_APPROVE: &str =
        "GitLab does not allow your account to approve this merge request.";
    pub const GL_REVIEWER: &str = "You must be a listed reviewer to request changes.";
    pub const GL_NO_APPROVAL: &str = "You have not approved this merge request.";
    pub const GL_NO_CHANGE_REQUEST: &str = "You have not requested changes on this merge request.";
    pub const GL_VERSION: &str =
        "This GitLab instance is {major}.{minor}; {action} needs {minimum}.";
    pub const GL_EDIT: &str = "Only the author or a Developer can edit this merge request.";
    pub const GL_DEVELOPER: &str = "Developer access or higher is required for this action.";
    pub const GL_REPORTER: &str =
        "Reporter access or higher is required to edit labels or milestones.";
    pub const GL_MERGE: &str = "GitLab does not allow your account to merge this merge request.";
    pub const GL_MERGE_ROLE: &str =
        "Your `glab` account has {role} access; merging needs Developer or higher.";
    pub const GL_DELETE: &str =
        "Only an Owner, or a Maintainer allowed by the project, can delete this merge request.";
    pub const ALREADY_LOCKED: &str = "This conversation is already locked.";
    pub const NOT_LOCKED: &str = "This conversation is not locked.";
    pub const NOT_DRAFT: &str = "This request is already ready for review.";
    pub const ALREADY_DRAFT: &str = "This request is already a draft.";
    pub const FORK_UPDATE: &str = "The fork does not allow maintainers to update its branch.";
    pub const NOT_BEHIND: &str = "The branch does not need an update.";
    pub const NO_SOURCE_PUSH: &str =
        "You cannot push to the source branch. Ask its author to rebase.";
    pub const NO_MERGE_METHOD: &str = "This repository does not allow any merge method.";
    pub const NO_BYPASS: &str = "The host does not allow bypassing these merge requirements.";
    pub const NO_AUTO_ENABLE: &str =
        "The host does not allow enabling auto-merge for this request.";
    pub const NO_AUTO_DISABLE: &str =
        "The host does not allow disabling auto-merge for this request.";
    pub const AUTO_ENABLED: &str = "Auto-merge is already enabled.";
    pub const AUTO_DISABLED: &str = "Auto-merge is not enabled.";
    pub const PIPELINE_REQUIRED: &str =
        "A running pipeline is required to enable merge when pipeline succeeds.";
    pub const NOT_MERGED: &str = "Only a merged request can be reverted.";
    pub const NO_MERGE_COMMIT: &str =
        "The merge commit is unavailable; open the request on the host.";
    pub const HOST_DATA: &str = "Host permission data is unavailable; refresh the request.";
    pub const MERGEABLE: &str = "Ready to merge";
    pub const MERGED: &str = "Already merged";
    pub const CLOSED: &str = "This request is closed";
    pub const DRAFT: &str = "Mark this draft ready for review before merging";
    pub const CHECKS_FAILING: &str = "Checks are failing";
    pub const CHECKS_PENDING: &str = "Checks are still pending";
    pub const CHANGES_REQUESTED: &str = "Changes have been requested";
    pub const CONFLICTS: &str = "Resolve conflicts locally before merging";
    pub const BRANCH_RULES: &str = "Blocked by branch rules";
    pub const DISCUSSIONS: &str = "Unresolved threads must be resolved";
    pub const GH_UNKNOWN: &str = "GitHub is still computing mergeability; refresh in a moment";
    pub const GL_UNKNOWN: &str = "GitLab is still computing mergeability; refresh in a moment";
    pub const STATUS_BLOCKED: &str = "GitLab reports {status}";
    pub const MERGE_BLOCKED: &str = "Merging is blocked: {reason}";
    pub const APPROVALS: &str = "{approved} of {required} required approvals";
    pub const GH_APPROVALS_NEEDED: &str = "{count} approving review{plural} required.";
    pub const GL_APPROVALS_NEEDED: &str = "{count} approval{plural} required.";
    pub const FAILING_CHECKS: &str = "{count} check{plural} failing";
    pub const BEHIND_COUNT: &str = "Branch is {count} commit{plural} behind {base}";
    pub const BEHIND: &str = "Branch is behind {base}";

    pub(super) fn count(template: &str, n: u64) -> String {
        template
            .replace("{count}", &n.to_string())
            .replace("{plural}", if n == 1 { "" } else { "s" })
    }
}
use reasons::*;

fn permission(allowed: bool, reason: &str) -> Permission {
    Permission {
        allowed,
        reason: (!allowed).then(|| reason.to_owned()),
    }
}

/// Used only while constructing an internal DetailRaw; never sent before compute.
pub(crate) fn pending_permissions() -> Permissions {
    let denied = permission(false, HOST_DATA);
    Permissions {
        comment: denied.clone(),
        edit_own_comment: denied.clone(),
        delete_own_comment: denied.clone(),
        minimize_comment: denied.clone(),
        react: denied.clone(),
        resolve_threads: denied.clone(),
        review: denied.clone(),
        approve: denied.clone(),
        request_changes: denied.clone(),
        revoke_approval: denied.clone(),
        remove_own_change_request: denied.clone(),
        dismiss_review: denied.clone(),
        rerequest_review: denied.clone(),
        apply_suggestion: denied.clone(),
        edit_pull_request: denied.clone(),
        edit_reviewers: denied.clone(),
        edit_assignees: denied.clone(),
        edit_labels: denied.clone(),
        edit_milestone: denied.clone(),
        lock: denied.clone(),
        unlock: denied.clone(),
        update_branch: UpdateBranchPermission {
            permission: denied.clone(),
            methods: vec![],
        },
        merge: MergePermission {
            permission: denied.clone(),
            methods: vec![],
            default_method: None,
            delete_branch_default: false,
        },
        merge_bypass: denied.clone(),
        enable_auto_merge: denied.clone(),
        disable_auto_merge: denied.clone(),
        mark_ready: denied.clone(),
        convert_to_draft: denied.clone(),
        close: denied.clone(),
        reopen: denied.clone(),
        delete: denied.clone(),
        revert: denied.clone(),
        checkout: denied,
    }
}

pub fn compute(i: &PermissionInputs) -> (Permissions, MergeReadiness) {
    let r = readiness(i);
    let mut p = pending_permissions();
    p.checkout = permission(true, "");
    let (write, edit, edit_reason) = if let Some(gh) = &i.gh {
        (
            has_write(i.repository_permission),
            gh.viewer_can_update,
            GH_UPDATE,
        )
    } else if let Some(gl) = &i.gl {
        (
            gl.access_level >= 30,
            i.viewer_is_author || gl.access_level >= 30,
            GL_EDIT,
        )
    } else {
        return (p, r);
    };
    let locked = i.locked || i.gl.as_ref().is_some_and(|gl| gl.discussion_locked);
    let read = !i.viewer_login.is_empty()
        && (i.repository_permission != RepositoryPermission::None
            || i.viewer_can_comment.is_some());
    let open = i.state == PullRequestState::Open && !i.merged;
    p.comment = permission(
        read && i.viewer_can_comment.unwrap_or(true) && (!locked || write),
        if !read {
            READ
        } else if i.viewer_can_comment == Some(false) {
            GL_COMMENT
        } else {
            LOCKED
        },
    );
    p.react = p.comment.clone();
    p.edit_own_comment = p.comment.clone();
    p.delete_own_comment = p.comment.clone();
    p.review = if !open {
        permission(false, NOT_OPEN)
    } else {
        p.comment.clone()
    };
    p.resolve_threads = permission(i.can_resolve_threads, NO_RESOLVE);
    p.edit_pull_request = permission(edit, edit_reason);
    p.edit_reviewers = p.edit_pull_request.clone();
    p.edit_assignees = p.edit_pull_request.clone();
    let write_reason = if i.gh.is_some() {
        GH_WRITE
    } else {
        GL_DEVELOPER
    };
    p.lock = permission(
        write && !locked,
        if !write { write_reason } else { ALREADY_LOCKED },
    );
    p.unlock = permission(
        write && locked,
        if !write { write_reason } else { NOT_LOCKED },
    );
    p.rerequest_review = permission(
        edit && open && i.has_reviewed_reviewers,
        if !edit {
            edit_reason
        } else if !open {
            NOT_OPEN
        } else {
            NO_REVIEW
        },
    );
    p.mark_ready = permission(
        edit && open && i.is_draft,
        if !edit {
            edit_reason
        } else if !open {
            NOT_OPEN
        } else {
            NOT_DRAFT
        },
    );
    p.convert_to_draft = permission(
        edit && open && !i.is_draft,
        if !edit {
            edit_reason
        } else if !open {
            NOT_OPEN
        } else {
            ALREADY_DRAFT
        },
    );
    p.close = permission(edit && open, if !edit { edit_reason } else { NOT_OPEN });
    p.reopen = permission(
        edit && i.state == PullRequestState::Closed && !i.merged,
        if !edit { edit_reason } else { NOT_CLOSED },
    );
    p.revert = permission(
        write && (i.merged || i.state == PullRequestState::Merged) && i.merge_commit_known,
        if !write {
            write_reason
        } else if !i.merged && i.state != PullRequestState::Merged {
            NOT_MERGED
        } else {
            NO_MERGE_COMMIT
        },
    );

    let ready_state = open && !i.is_draft && r.status != ReadinessStatus::Draft;
    let methods = if ready_state {
        i.merge_policy.methods.clone()
    } else {
        vec![]
    };
    p.merge.default_method = i
        .merge_policy
        .default_method
        .filter(|m| methods.contains(m))
        .or_else(|| methods.first().copied());
    p.merge.methods = methods;
    p.merge.delete_branch_default = i.merge_policy.delete_branch_default;
    let mut can_merge = false;
    let mut merge_right_reason = GH_WRITE.to_owned();
    if let Some(gh) = &i.gh {
        p.minimize_comment = permission(write, GH_WRITE);
        p.approve = permission(
            read && !i.viewer_is_author && open && !locked,
            if i.viewer_is_author {
                GH_AUTHOR
            } else if !open {
                NOT_OPEN
            } else if locked {
                REVIEW_LOCKED
            } else {
                READ
            },
        );
        p.request_changes = p.approve.clone();
        p.revoke_approval = permission(false, GH_REVOKE);
        p.remove_own_change_request = p.revoke_approval.clone();
        p.dismiss_review = dismissal_permission(
            i.repository_permission,
            gh.viewer_allowed_to_dismiss_reviews,
            i.has_dismissible_reviews,
        );
        p.apply_suggestion = permission(false, GH_SUGGESTION);
        let triage = matches!(
            i.repository_permission,
            RepositoryPermission::Triage
                | RepositoryPermission::Write
                | RepositoryPermission::Maintain
                | RepositoryPermission::Admin
        );
        p.edit_labels = permission(edit && triage, if !edit { GH_UPDATE } else { GH_TRIAGE });
        p.edit_milestone = p.edit_labels.clone();
        let behind = gh.merge_state_status == "BEHIND"
            || (gh.mergeable == "MERGEABLE" && gh.behind_by.is_some_and(|n| n > 0));
        let fork = !i.is_cross_repository || i.maintainer_can_modify;
        p.update_branch.permission = permission(
            open && edit && behind && fork,
            if !open {
                NOT_OPEN
            } else if !edit {
                GH_UPDATE
            } else if !fork {
                FORK_UPDATE
            } else {
                NOT_BEHIND
            },
        );
        can_merge = write || gh.viewer_can_merge_as_admin;
        p.merge_bypass = permission(
            ready_state
                && gh.viewer_can_merge_as_admin
                && gh.merge_state_status == "BLOCKED"
                && !p.merge.methods.is_empty(),
            NO_BYPASS,
        );
        p.enable_auto_merge = permission(
            ready_state
                && i.merge_policy.auto_merge_allowed
                && gh.viewer_can_enable_auto_merge
                && !gh.auto_merge_enabled,
            if gh.auto_merge_enabled {
                AUTO_ENABLED
            } else {
                NO_AUTO_ENABLE
            },
        );
        p.disable_auto_merge = permission(
            gh.viewer_can_disable_auto_merge && gh.auto_merge_enabled,
            if !gh.auto_merge_enabled {
                AUTO_DISABLED
            } else {
                NO_AUTO_DISABLE
            },
        );
        p.delete = permission(false, GH_DELETE);
    } else if let Some(gl) = &i.gl {
        p.minimize_comment = permission(false, GL_MINIMIZE);
        p.dismiss_review = permission(false, GL_DISMISS);
        p.approve = permission(gl.user_can_approve, GL_APPROVE);
        p.request_changes =
            if let Some(reason) = version_reason(i, gl, (17, 2), "requesting changes") {
                permission(false, &reason)
            } else {
                permission(
                    gl.is_reviewer && open,
                    if !open { NOT_OPEN } else { GL_REVIEWER },
                )
            };
        p.revoke_approval = permission(gl.user_has_approved, GL_NO_APPROVAL);
        p.remove_own_change_request =
            if let Some(reason) = version_reason(i, gl, (17, 8), "removing your change request") {
                permission(false, &reason)
            } else {
                permission(
                    gl.viewer_reviewer_state.as_deref() == Some("requested_changes"),
                    GL_NO_CHANGE_REQUEST,
                )
            };
        p.apply_suggestion = permission(write, GL_DEVELOPER);
        p.edit_labels = permission(gl.access_level >= 20, GL_REPORTER);
        p.edit_milestone = p.edit_labels.clone();
        p.update_branch.permission = permission(
            open && gl.detailed_merge_status == "need_rebase" && gl.can_push_source_branch,
            if !open {
                NOT_OPEN
            } else if !gl.can_push_source_branch {
                NO_SOURCE_PUSH
            } else {
                NOT_BEHIND
            },
        );
        can_merge = gl.can_merge;
        merge_right_reason = if gl.access_level < 30 {
            GL_MERGE_ROLE.replace(
                "{role}",
                match gl.access_level {
                    20.. => "Reporter",
                    15.. => "Planner",
                    10.. => "Guest",
                    _ => "limited",
                },
            )
        } else {
            GL_MERGE.into()
        };
        p.merge_bypass = permission(
            ready_state
                && gl.can_merge
                && gl.detailed_merge_status == "requested_changes"
                && !p.merge.methods.is_empty(),
            NO_BYPASS,
        );
        let running = matches!(
            gl.pipeline_status.as_deref(),
            Some("running" | "pending" | "created" | "waiting_for_resource" | "preparing")
        );
        p.enable_auto_merge = permission(
            ready_state && gl.can_merge && running && !gl.merge_when_pipeline_succeeds,
            if gl.merge_when_pipeline_succeeds {
                AUTO_ENABLED
            } else if !running {
                PIPELINE_REQUIRED
            } else {
                NO_AUTO_ENABLE
            },
        );
        p.disable_auto_merge = permission(
            gl.can_merge && gl.merge_when_pipeline_succeeds,
            if !gl.merge_when_pipeline_succeeds {
                AUTO_DISABLED
            } else {
                NO_AUTO_DISABLE
            },
        );
        p.delete = permission(
            gl.access_level >= 50 || (gl.access_level >= 40 && gl.project_allows_maintainer_delete),
            GL_DELETE,
        );
    }
    if p.update_branch.permission.allowed {
        p.update_branch.methods = i.capabilities.update_branch_methods.clone();
    }
    // Readiness still describes the request; action reasons first explain missing access.
    if !can_merge {
        for action in [
            &mut p.merge_bypass,
            &mut p.enable_auto_merge,
            &mut p.disable_auto_merge,
        ] {
            *action = permission(false, &merge_right_reason);
        }
    }
    let mergeable = r.status == ReadinessStatus::Mergeable
        || (i.gh.is_some() && r.status == ReadinessStatus::ChecksFailing);
    let merge_reason = if !can_merge {
        merge_right_reason
    } else if !ready_state || !mergeable {
        if r.status == ReadinessStatus::Unknown {
            r.summary.clone()
        } else {
            MERGE_BLOCKED.replace("{reason}", &r.summary)
        }
    } else {
        NO_MERGE_METHOD.into()
    };
    p.merge.permission = permission(
        can_merge && ready_state && mergeable && !p.merge.methods.is_empty(),
        &merge_reason,
    );
    (p, r)
}

pub(crate) fn dismissal_permission(
    repository_permission: RepositoryPermission,
    allowed: Option<bool>,
    dismissible: bool,
) -> Permission {
    let allowed = has_write(repository_permission) || allowed == Some(true);
    permission(
        allowed && dismissible,
        if !allowed {
            GH_DISMISS
        } else {
            NO_DISMISSIBLE_REVIEW
        },
    )
}

/// GitLab exposes comment eligibility and whether a discussion can be resolved.
/// Use the same conjunction for the detail gate and each individual thread.
pub(crate) fn gitlab_thread_resolution(can_create_note: bool, resolvable: bool) -> bool {
    can_create_note && resolvable
}

pub(crate) fn can_rerequest(permissions: &Permissions, state: ReviewerState) -> bool {
    permissions.rerequest_review.allowed && state != ReviewerState::Unreviewed
}

pub(crate) fn has_write(p: RepositoryPermission) -> bool {
    matches!(
        p,
        RepositoryPermission::Write | RepositoryPermission::Maintain | RepositoryPermission::Admin
    )
}

fn version_reason(
    i: &PermissionInputs,
    gl: &GitLabInputs,
    minimum: (u32, u32),
    action: &str,
) -> Option<String> {
    if let Some(reason) = &i.version_unavailable_reason {
        return Some(reason.clone());
    }
    (gl.host_version < minimum).then(|| {
        GL_VERSION
            .replace("{major}", &gl.host_version.0.to_string())
            .replace("{minor}", &gl.host_version.1.to_string())
            .replace("{action}", action)
            .replace("{minimum}", &format!("{}.{}", minimum.0, minimum.1))
    })
}

fn readiness(i: &PermissionInputs) -> MergeReadiness {
    let mut details = Vec::new();
    if let Some(a) = &i.required_approvals {
        details.push(
            APPROVALS
                .replace("{approved}", &a.approved.to_string())
                .replace("{required}", &a.required.to_string()),
        );
    }
    if let Some(n) = i.failing_checks.filter(|n| *n > 0) {
        details.push(reasons::count(FAILING_CHECKS, n));
    }
    if let Some(gh) = &i.gh {
        if let Some(n) = gh.behind_by.filter(|n| *n > 0) {
            details.push(reasons::count(BEHIND_COUNT, n.into()).replace("{base}", &i.base_branch));
        } else if gh.merge_state_status == "BEHIND" {
            details.push(BEHIND.replace("{base}", &i.base_branch));
        }
    }
    let (status, summary) = if i.merged || i.state == PullRequestState::Merged {
        (ReadinessStatus::Merged, MERGED.into())
    } else if i.state == PullRequestState::Closed {
        (ReadinessStatus::Closed, CLOSED.into())
    } else if i.is_draft {
        (ReadinessStatus::Draft, DRAFT.into())
    } else if let Some(gh) = &i.gh {
        match gh.merge_state_status.as_str() {
            "CLEAN" | "HAS_HOOKS" => (ReadinessStatus::Mergeable, MERGEABLE.into()),
            "UNSTABLE" => {
                if i.failing_checks.is_none() {
                    details.push(CHECKS_FAILING.into());
                }
                (ReadinessStatus::ChecksFailing, CHECKS_FAILING.into())
            }
            "BLOCKED" if gh.review_decision.as_deref() == Some("REVIEW_REQUIRED") => {
                let remaining = i
                    .required_approvals
                    .as_ref()
                    .map_or(1, |a| a.required.saturating_sub(a.approved).max(1));
                let summary = reasons::count(GH_APPROVALS_NEEDED, remaining);
                details.push(summary.clone());
                (ReadinessStatus::ReviewRequired, summary)
            }
            "BLOCKED" if gh.review_decision.as_deref() == Some("CHANGES_REQUESTED") => {
                (ReadinessStatus::ChangesRequested, CHANGES_REQUESTED.into())
            }
            "BLOCKED" => (ReadinessStatus::Blocked, BRANCH_RULES.into()),
            "BEHIND" => (
                ReadinessStatus::Behind,
                BEHIND.replace("{base}", &i.base_branch),
            ),
            "DIRTY" => (ReadinessStatus::Conflicts, CONFLICTS.into()),
            "DRAFT" => (ReadinessStatus::Draft, DRAFT.into()),
            _ => (ReadinessStatus::Unknown, GH_UNKNOWN.into()),
        }
    } else if let Some(gl) = &i.gl {
        match gl.detailed_merge_status.as_str() {
            "mergeable" => (ReadinessStatus::Mergeable, MERGEABLE.into()),
            "not_approved" => {
                let summary = reasons::count(GL_APPROVALS_NEEDED, gl.approvals_left.into());
                details.push(summary.clone());
                (ReadinessStatus::ReviewRequired, summary)
            }
            "requested_changes" => (ReadinessStatus::ChangesRequested, CHANGES_REQUESTED.into()),
            "ci_must_pass" | "ci_still_running"
                if matches!(gl.pipeline_status.as_deref(), Some("failed" | "canceled")) =>
            {
                (ReadinessStatus::ChecksFailing, CHECKS_FAILING.into())
            }
            "ci_must_pass" | "ci_still_running" => {
                (ReadinessStatus::ChecksPending, CHECKS_PENDING.into())
            }
            "conflict" => (ReadinessStatus::Conflicts, CONFLICTS.into()),
            "need_rebase" => (
                ReadinessStatus::Behind,
                BEHIND.replace("{base}", &i.base_branch),
            ),
            "draft_status" => (ReadinessStatus::Draft, DRAFT.into()),
            "discussions_not_resolved" => (ReadinessStatus::Blocked, DISCUSSIONS.into()),
            "blocked_status"
            | "policies_denied"
            | "external_status_checks"
            | "jira_association_missing"
            | "broken_status" => (
                ReadinessStatus::Blocked,
                STATUS_BLOCKED.replace("{status}", &gl.detailed_merge_status),
            ),
            "not_open" => (ReadinessStatus::Closed, CLOSED.into()),
            _ => (ReadinessStatus::Unknown, GL_UNKNOWN.into()),
        }
    } else {
        (ReadinessStatus::Unknown, HOST_DATA.into())
    };
    MergeReadiness {
        status,
        summary,
        details,
        required_approvals: i.required_approvals.clone(),
        auto_merge: Some(AutoMerge {
            enabled: i.gh.as_ref().is_some_and(|gh| gh.auto_merge_enabled)
                || i.gl
                    .as_ref()
                    .is_some_and(|gl| gl.merge_when_pipeline_succeeds),
            method: i.auto_merge_method,
        }),
        head_sha: i.head_sha.clone(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::pull_requests::{
        github::GitHubHost,
        gitlab::GitLabHost,
        host::{HostCommandRunner, HostVersion, PullRequestHost},
    };
    use std::{path::PathBuf, sync::Arc};

    pub(crate) fn github_inputs() -> PermissionInputs {
        let host = GitHubHost::new(Arc::new(HostCommandRunner::new(PathBuf::new())));
        PermissionInputs {
            viewer_login: "viewer".into(),
            viewer_can_comment: None,
            repository_permission: RepositoryPermission::Write,
            state: PullRequestState::Open,
            is_draft: false,
            locked: false,
            viewer_is_author: false,
            is_cross_repository: false,
            maintainer_can_modify: true,
            merged: false,
            merge_commit_known: false,
            gh: Some(GitHubInputs {
                viewer_can_update: true,
                viewer_can_merge_as_admin: false,
                viewer_can_enable_auto_merge: true,
                viewer_can_disable_auto_merge: false,
                viewer_can_apply_suggestion: true,
                merge_state_status: "CLEAN".into(),
                mergeable: "MERGEABLE".into(),
                review_decision: None,
                viewer_allowed_to_dismiss_reviews: Some(false),
                auto_merge_enabled: false,
                behind_by: None,
            }),
            gl: None,
            merge_policy: MergePolicy {
                methods: vec![MergeMethod::Merge, MergeMethod::Squash, MergeMethod::Rebase],
                default_method: Some(MergeMethod::Squash),
                delete_branch_default: true,
                auto_merge_allowed: true,
                requires_pipeline_success: false,
                requires_resolved_discussions: false,
            },
            capabilities: host.capabilities(None),
            head_sha: "head-sha".into(),
            base_branch: "main".into(),
            required_approvals: None,
            failing_checks: None,
            has_reviewed_reviewers: true,
            has_dismissible_reviews: true,
            can_resolve_threads: true,
            auto_merge_method: None,
            version_unavailable_reason: None,
        }
    }
    pub(crate) fn gitlab_inputs() -> PermissionInputs {
        let mut i = github_inputs();
        i.gh = None;
        i.gl = Some(GitLabInputs {
            can_merge: true,
            detailed_merge_status: "mergeable".into(),
            has_conflicts: false,
            blocking_discussions_resolved: true,
            discussion_locked: false,
            user_can_approve: true,
            user_has_approved: false,
            approvals_left: 1,
            viewer_reviewer_state: Some("unreviewed".into()),
            is_reviewer: true,
            merge_when_pipeline_succeeds: false,
            pipeline_status: Some("running".into()),
            host_version: (17, 9),
            access_level: 30,
            project_allows_maintainer_delete: false,
            can_push_source_branch: true,
        });
        i.capabilities = GitLabHost::new(Arc::new(HostCommandRunner::new(PathBuf::new())))
            .capabilities(Some(&HostVersion {
                major: 17,
                minor: 9,
            }));
        i
    }
    fn assert_permission(p: &Permission, allowed: bool) {
        assert_eq!(p.allowed, allowed, "{p:?}");
        assert_eq!(p.reason.is_none(), allowed, "{p:?}");
        if let Some(reason) = &p.reason {
            assert!(!reason.trim().is_empty());
        }
    }

    #[test]
    fn github_comment_and_own_comment_require_read_or_write_when_locked() {
        let mut i = github_inputs();
        i.repository_permission = RepositoryPermission::Read;
        for locked in [false, true] {
            i.locked = locked;
            let (p, _) = compute(&i);
            for p in [
                &p.comment,
                &p.react,
                &p.edit_own_comment,
                &p.delete_own_comment,
            ] {
                assert_permission(p, !locked);
            }
        }
        i.repository_permission = RepositoryPermission::Write;
        assert_permission(&compute(&i).0.comment, true);
        i.repository_permission = RepositoryPermission::None;
        i.locked = false;
        assert_permission(&compute(&i).0.comment, false);
    }
    #[test]
    fn gitlab_comment_and_own_notes_respect_discussion_lock() {
        let mut i = gitlab_inputs();
        i.repository_permission = RepositoryPermission::Read;
        i.gl.as_mut().unwrap().access_level = 10;
        i.gl.as_mut().unwrap().discussion_locked = true;
        let (p, _) = compute(&i);
        for p in [
            &p.comment,
            &p.react,
            &p.edit_own_comment,
            &p.delete_own_comment,
        ] {
            assert_permission(p, false);
        }
        i.gl.as_mut().unwrap().access_level = 30;
        i.repository_permission = RepositoryPermission::Write;
        assert_permission(&compute(&i).0.comment, true);
    }
    #[test]
    fn github_minimize_comment_requires_write() {
        let mut i = github_inputs();
        assert_permission(&compute(&i).0.minimize_comment, true);
        i.repository_permission = RepositoryPermission::Triage;
        assert_permission(&compute(&i).0.minimize_comment, false);
    }
    #[test]
    fn gitlab_cannot_minimize_comment() {
        assert_permission(&compute(&gitlab_inputs()).0.minimize_comment, false);
    }
    #[test]
    fn github_author_cannot_approve_own_pull_request() {
        let mut i = github_inputs();
        i.viewer_is_author = true;
        let (p, _) = compute(&i);
        assert!(!p.approve.allowed);
        assert_eq!(
            p.approve.reason.as_deref(),
            Some("You cannot approve your own pull request.")
        );
        assert_permission(&p.request_changes, false);
        assert_permission(&p.review, true);
    }
    #[test]
    fn github_read_viewer_can_approve_and_request_changes_only_open_unlocked() {
        let mut i = github_inputs();
        i.repository_permission = RepositoryPermission::Read;
        assert_permission(&compute(&i).0.approve, true);
        assert_permission(&compute(&i).0.request_changes, true);
        i.locked = true;
        assert_permission(&compute(&i).0.approve, false);
        i.locked = false;
        i.state = PullRequestState::Closed;
        assert_permission(&compute(&i).0.approve, false);
    }
    #[test]
    fn gitlab_approval_follows_host_answer_including_author_policy() {
        let mut i = gitlab_inputs();
        i.viewer_is_author = true;
        assert_permission(&compute(&i).0.approve, true);
        i.gl.as_mut().unwrap().user_can_approve = false;
        assert_permission(&compute(&i).0.approve, false);
    }
    #[test]
    fn gitlab_request_changes_needs_17_2() {
        let mut i = gitlab_inputs();
        i.gl.as_mut().unwrap().host_version = (16, 11);
        let (p, _) = compute(&i);
        assert_eq!(
            p.request_changes.reason.as_deref(),
            Some("This GitLab instance is 16.11; requesting changes needs 17.2.")
        );
    }
    #[test]
    fn gitlab_request_changes_needs_listed_reviewer_and_open() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.request_changes, true);
        i.gl.as_mut().unwrap().is_reviewer = false;
        assert_permission(&compute(&i).0.request_changes, false);
        i.gl.as_mut().unwrap().is_reviewer = true;
        i.state = PullRequestState::Closed;
        assert_permission(&compute(&i).0.request_changes, false);
    }
    #[test]
    fn gitlab_version_unavailable_is_not_reported_as_zero() {
        let mut i = gitlab_inputs();
        i.gl.as_mut().unwrap().host_version = (0, 0);
        i.version_unavailable_reason = Some("GitLab version could not be read".into());
        let (p, _) = compute(&i);
        assert_eq!(
            p.request_changes.reason.as_deref(),
            Some("GitLab version could not be read")
        );
        assert_eq!(p.remove_own_change_request.reason, p.request_changes.reason);
    }
    #[test]
    fn github_has_no_self_revoke_or_remove_change_request() {
        let (p, _) = compute(&github_inputs());
        assert_permission(&p.revoke_approval, false);
        assert_permission(&p.remove_own_change_request, false);
    }
    #[test]
    fn gitlab_revoke_approval_follows_user_has_approved() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.revoke_approval, false);
        i.gl.as_mut().unwrap().user_has_approved = true;
        assert_permission(&compute(&i).0.revoke_approval, true);
    }
    #[test]
    fn gitlab_remove_own_change_request_needs_17_8_and_own_state() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.remove_own_change_request, false);
        i.gl.as_mut().unwrap().viewer_reviewer_state = Some("requested_changes".into());
        assert_permission(&compute(&i).0.remove_own_change_request, true);
        i.gl.as_mut().unwrap().host_version = (17, 7);
        assert_eq!(
            compute(&i).0.remove_own_change_request.reason.as_deref(),
            Some("This GitLab instance is 17.7; removing your change request needs 17.8.")
        );
    }
    #[test]
    fn github_dismiss_needs_write_or_branch_rule_and_dismissible_review() {
        let mut i = github_inputs();
        assert_permission(&compute(&i).0.dismiss_review, true);
        i.repository_permission = RepositoryPermission::Read;
        assert_permission(&compute(&i).0.dismiss_review, false);
        i.gh.as_mut().unwrap().viewer_allowed_to_dismiss_reviews = Some(true);
        assert_permission(&compute(&i).0.dismiss_review, true);
        i.has_dismissible_reviews = false;
        assert_permission(&compute(&i).0.dismiss_review, false);
    }
    #[test]
    fn gitlab_has_no_review_dismissal() {
        assert_permission(&compute(&gitlab_inputs()).0.dismiss_review, false);
    }
    #[test]
    fn github_rerequest_requires_update_and_existing_review() {
        let mut i = github_inputs();
        assert_permission(&compute(&i).0.rerequest_review, true);
        i.has_reviewed_reviewers = false;
        assert_permission(&compute(&i).0.rerequest_review, false);
        i.has_reviewed_reviewers = true;
        i.gh.as_mut().unwrap().viewer_can_update = false;
        assert_permission(&compute(&i).0.rerequest_review, false);
    }
    #[test]
    fn gitlab_rerequest_requires_author_or_developer_and_existing_review() {
        let mut i = gitlab_inputs();
        i.gl.as_mut().unwrap().access_level = 20;
        assert_permission(&compute(&i).0.rerequest_review, false);
        i.viewer_is_author = true;
        assert_permission(&compute(&i).0.rerequest_review, true);
        i.has_reviewed_reviewers = false;
        assert_permission(&compute(&i).0.rerequest_review, false);
    }
    #[test]
    fn github_suggestions_always_name_no_public_api() {
        let (p, _) = compute(&github_inputs());
        assert_permission(&p.apply_suggestion, false);
        assert!(p.apply_suggestion.reason.unwrap().contains("no public API"));
    }
    #[test]
    fn gitlab_suggestions_require_developer() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.apply_suggestion, true);
        i.gl.as_mut().unwrap().access_level = 20;
        assert_permission(&compute(&i).0.apply_suggestion, false);
    }
    #[test]
    fn github_editing_needs_update_and_labels_milestone_need_triage() {
        let mut i = github_inputs();
        i.repository_permission = RepositoryPermission::Read;
        let (p, _) = compute(&i);
        for p in [&p.edit_pull_request, &p.edit_reviewers, &p.edit_assignees] {
            assert_permission(p, true);
        }
        for p in [&p.edit_labels, &p.edit_milestone] {
            assert_permission(p, false);
        }
        i.repository_permission = RepositoryPermission::Triage;
        assert_permission(&compute(&i).0.edit_labels, true);
        i.gh.as_mut().unwrap().viewer_can_update = false;
        let (p, _) = compute(&i);
        for p in [
            &p.edit_pull_request,
            &p.edit_reviewers,
            &p.edit_assignees,
            &p.edit_labels,
            &p.edit_milestone,
        ] {
            assert_permission(p, false);
        }
    }
    #[test]
    fn gitlab_editing_needs_author_or_developer_labels_reporter() {
        let mut i = gitlab_inputs();
        i.gl.as_mut().unwrap().access_level = 20;
        let (p, _) = compute(&i);
        for p in [&p.edit_pull_request, &p.edit_reviewers, &p.edit_assignees] {
            assert_permission(p, false);
        }
        for p in [&p.edit_labels, &p.edit_milestone] {
            assert_permission(p, true);
        }
        i.viewer_is_author = true;
        assert_permission(&compute(&i).0.edit_pull_request, true);
        i.gl.as_mut().unwrap().access_level = 10;
        assert_permission(&compute(&i).0.edit_labels, false);
    }
    #[test]
    fn github_lock_and_unlock_require_write_and_current_lock_state() {
        let mut i = github_inputs();
        assert_permission(&compute(&i).0.lock, true);
        assert_permission(&compute(&i).0.unlock, false);
        i.locked = true;
        assert_permission(&compute(&i).0.unlock, true);
        assert_permission(&compute(&i).0.lock, false);
        i.repository_permission = RepositoryPermission::Triage;
        assert_permission(&compute(&i).0.unlock, false);
    }
    #[test]
    fn gitlab_lock_and_unlock_require_developer() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.lock, true);
        i.gl.as_mut().unwrap().discussion_locked = true;
        assert_permission(&compute(&i).0.unlock, true);
        i.gl.as_mut().unwrap().access_level = 20;
        assert_permission(&compute(&i).0.unlock, false);
    }
    #[test]
    fn github_update_branch_respects_behind_fork_and_methods() {
        let mut i = github_inputs();
        assert_permission(&compute(&i).0.update_branch.permission, false);
        i.gh.as_mut().unwrap().merge_state_status = "BEHIND".into();
        assert_eq!(
            compute(&i).0.update_branch.methods,
            vec![UpdateBranchMethod::Merge, UpdateBranchMethod::Rebase]
        );
        i.is_cross_repository = true;
        i.maintainer_can_modify = false;
        assert_permission(&compute(&i).0.update_branch.permission, false);
        i.maintainer_can_modify = true;
        i.gh.as_mut().unwrap().viewer_can_update = false;
        assert_permission(&compute(&i).0.update_branch.permission, false);
    }
    #[test]
    fn github_update_branch_accepts_known_behind_count_when_mergeable() {
        let mut i = github_inputs();
        i.gh.as_mut().unwrap().behind_by = Some(4);
        assert_permission(&compute(&i).0.update_branch.permission, true);
    }
    #[test]
    fn gitlab_update_branch_requires_rebase_and_source_push() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.update_branch.permission, false);
        i.gl.as_mut().unwrap().detailed_merge_status = "need_rebase".into();
        assert_eq!(
            compute(&i).0.update_branch.methods,
            vec![UpdateBranchMethod::Rebase]
        );
        i.gl.as_mut().unwrap().can_push_source_branch = false;
        assert_permission(&compute(&i).0.update_branch.permission, false);
    }
    #[test]
    fn github_merge_requires_write_or_admin_and_policy() {
        let mut i = github_inputs();
        let (p, _) = compute(&i);
        assert_permission(&p.merge.permission, true);
        assert_eq!(p.merge.default_method, Some(MergeMethod::Squash));
        assert!(p.merge.delete_branch_default);
        i.repository_permission = RepositoryPermission::Read;
        assert_permission(&compute(&i).0.merge.permission, false);
        i.gh.as_mut().unwrap().viewer_can_merge_as_admin = true;
        assert_permission(&compute(&i).0.merge.permission, true);
        i.merge_policy.methods = vec![MergeMethod::Rebase];
        assert_eq!(
            compute(&i).0.merge.default_method,
            Some(MergeMethod::Rebase)
        );
        i.merge_policy.methods.clear();
        assert_permission(&compute(&i).0.merge.permission, false);
    }
    #[test]
    fn gitlab_merge_requires_host_permission_and_project_methods() {
        let mut i = gitlab_inputs();
        i.merge_policy.methods = vec![MergeMethod::Rebase];
        let (p, _) = compute(&i);
        assert_permission(&p.merge.permission, true);
        assert_eq!(p.merge.methods, vec![MergeMethod::Rebase]);
        i.gl.as_mut().unwrap().can_merge = false;
        assert_permission(&compute(&i).0.merge.permission, false);
    }
    #[test]
    fn github_blocked_merge_names_required_reviews() {
        let mut i = github_inputs();
        i.gh.as_mut().unwrap().merge_state_status = "BLOCKED".into();
        i.gh.as_mut().unwrap().review_decision = Some("REVIEW_REQUIRED".into());
        i.required_approvals = Some(Approvals {
            approved: 0,
            required: 1,
        });
        let (p, r) = compute(&i);
        assert!(!p.merge.permission.allowed);
        assert_eq!(r.status, ReadinessStatus::ReviewRequired);
        assert!(
            p.merge
                .permission
                .reason
                .unwrap()
                .starts_with("Merging is blocked:")
        );
        assert!(r.details.iter().any(|d| d.contains("1 approving review")));
    }
    #[test]
    fn github_read_viewer_merge_actions_prioritize_access_over_state() {
        for (state, status, summary) in [
            ("UNKNOWN", ReadinessStatus::Unknown, GH_UNKNOWN),
            (
                "BLOCKED",
                ReadinessStatus::ReviewRequired,
                "1 approving review required.",
            ),
            ("CLEAN", ReadinessStatus::Mergeable, MERGEABLE),
        ] {
            for auto_enabled in [false, true] {
                let mut i = github_inputs();
                i.repository_permission = RepositoryPermission::Read;
                let gh = i.gh.as_mut().unwrap();
                gh.viewer_can_update = false;
                gh.viewer_can_enable_auto_merge = false;
                gh.viewer_can_disable_auto_merge = false;
                gh.auto_merge_enabled = auto_enabled;
                gh.merge_state_status = state.into();
                gh.review_decision = Some("REVIEW_REQUIRED".into());
                let (p, r) = compute(&i);
                for (name, permission) in [
                    ("merge", &p.merge.permission),
                    ("mergeBypass", &p.merge_bypass),
                    ("enableAutoMerge", &p.enable_auto_merge),
                    ("disableAutoMerge", &p.disable_auto_merge),
                ] {
                    assert_permission(permission, false);
                    assert_eq!(
                        permission.reason.as_deref(),
                        Some("Write access is required for this action."),
                        "{name}: {state}, auto={auto_enabled}"
                    );
                }
                assert_eq!(r.status, status);
                assert_eq!(r.summary, summary);
                assert_eq!(r.auto_merge.unwrap().enabled, auto_enabled);
            }
        }
    }
    #[test]
    fn gitlab_read_viewer_merge_actions_prioritize_access_over_state() {
        for (state, status, summary) in [
            ("checking", ReadinessStatus::Unknown, GL_UNKNOWN),
            (
                "not_approved",
                ReadinessStatus::ReviewRequired,
                "1 approval required.",
            ),
            ("mergeable", ReadinessStatus::Mergeable, MERGEABLE),
        ] {
            for auto_enabled in [false, true] {
                for pipeline in ["running", "success"] {
                    let mut i = gitlab_inputs();
                    i.repository_permission = RepositoryPermission::Read;
                    let gl = i.gl.as_mut().unwrap();
                    gl.access_level = 20;
                    gl.can_merge = false;
                    gl.detailed_merge_status = state.into();
                    gl.merge_when_pipeline_succeeds = auto_enabled;
                    gl.pipeline_status = Some(pipeline.into());
                    let (p, r) = compute(&i);
                    for (name, permission) in [
                        ("merge", &p.merge.permission),
                        ("mergeBypass", &p.merge_bypass),
                        ("enableAutoMerge", &p.enable_auto_merge),
                        ("disableAutoMerge", &p.disable_auto_merge),
                    ] {
                        assert_permission(permission, false);
                        assert_eq!(
                            permission.reason.as_deref(),
                            Some(
                                "Your `glab` account has Reporter access; merging needs Developer or higher."
                            ),
                            "{name}: {state}, auto={auto_enabled}, pipeline={pipeline}"
                        );
                    }
                    assert_eq!(r.status, status);
                    assert_eq!(r.summary, summary);
                    assert_eq!(r.auto_merge.unwrap().enabled, auto_enabled);
                }
            }
        }
    }
    #[test]
    fn gitlab_merge_reason_from_detailed_status() {
        let mut i = gitlab_inputs();
        i.gl.as_mut().unwrap().detailed_merge_status = "not_approved".into();
        let (p, r) = compute(&i);
        assert_eq!(r.status, ReadinessStatus::ReviewRequired);
        assert_eq!(
            p.merge.permission.reason.as_deref(),
            Some("Merging is blocked: 1 approval required.")
        );
    }
    #[test]
    fn github_every_merge_state_has_readiness_and_reason() {
        for (status, expected, allowed) in [
            ("CLEAN", ReadinessStatus::Mergeable, true),
            ("HAS_HOOKS", ReadinessStatus::Mergeable, true),
            ("UNSTABLE", ReadinessStatus::ChecksFailing, true),
            ("BLOCKED", ReadinessStatus::Blocked, false),
            ("BEHIND", ReadinessStatus::Behind, false),
            ("DIRTY", ReadinessStatus::Conflicts, false),
            ("DRAFT", ReadinessStatus::Draft, false),
            ("UNKNOWN", ReadinessStatus::Unknown, false),
            ("FUTURE", ReadinessStatus::Unknown, false),
        ] {
            let mut i = github_inputs();
            i.gh.as_mut().unwrap().merge_state_status = status.into();
            let (p, r) = compute(&i);
            assert_eq!(r.status, expected, "{status}");
            assert!(!r.summary.is_empty());
            assert_permission(&p.merge.permission, allowed);
        }
    }
    #[test]
    fn github_unknown_mergeability_has_exact_refresh_reason() {
        let mut i = github_inputs();
        i.gh.as_mut().unwrap().merge_state_status = "UNKNOWN".into();
        assert_eq!(
            compute(&i).0.merge.permission.reason.as_deref(),
            Some("GitHub is still computing mergeability; refresh in a moment")
        );
    }
    #[test]
    fn github_blocked_changes_requested_is_distinct() {
        let mut i = github_inputs();
        i.gh.as_mut().unwrap().merge_state_status = "BLOCKED".into();
        i.gh.as_mut().unwrap().review_decision = Some("CHANGES_REQUESTED".into());
        assert_eq!(compute(&i).1.status, ReadinessStatus::ChangesRequested);
    }
    #[test]
    fn gitlab_every_detailed_status_has_readiness_and_reason() {
        for (status, expected) in [
            ("mergeable", ReadinessStatus::Mergeable),
            ("not_approved", ReadinessStatus::ReviewRequired),
            ("requested_changes", ReadinessStatus::ChangesRequested),
            ("ci_must_pass", ReadinessStatus::ChecksPending),
            ("ci_still_running", ReadinessStatus::ChecksPending),
            ("conflict", ReadinessStatus::Conflicts),
            ("need_rebase", ReadinessStatus::Behind),
            ("draft_status", ReadinessStatus::Draft),
            ("discussions_not_resolved", ReadinessStatus::Blocked),
            ("blocked_status", ReadinessStatus::Blocked),
            ("policies_denied", ReadinessStatus::Blocked),
            ("external_status_checks", ReadinessStatus::Blocked),
            ("jira_association_missing", ReadinessStatus::Blocked),
            ("broken_status", ReadinessStatus::Blocked),
            ("checking", ReadinessStatus::Unknown),
            ("unchecked", ReadinessStatus::Unknown),
            ("preparing", ReadinessStatus::Unknown),
            ("future_status", ReadinessStatus::Unknown),
            ("not_open", ReadinessStatus::Closed),
        ] {
            let mut i = gitlab_inputs();
            i.gl.as_mut().unwrap().detailed_merge_status = status.into();
            let (p, r) = compute(&i);
            assert_eq!(r.status, expected, "{status}");
            assert!(!r.summary.is_empty());
            assert_permission(&p.merge.permission, status == "mergeable");
            if [
                "blocked_status",
                "policies_denied",
                "external_status_checks",
                "jira_association_missing",
                "broken_status",
            ]
            .contains(&status)
            {
                assert!(p.merge.permission.reason.unwrap().contains(status));
            }
        }
    }
    #[test]
    fn gitlab_failed_pipeline_is_checks_failing() {
        let mut i = gitlab_inputs();
        i.gl.as_mut().unwrap().detailed_merge_status = "ci_must_pass".into();
        i.gl.as_mut().unwrap().pipeline_status = Some("failed".into());
        assert_eq!(compute(&i).1.status, ReadinessStatus::ChecksFailing);
    }
    #[test]
    fn github_readiness_details_include_counts_and_base_branch() {
        let mut i = github_inputs();
        i.required_approvals = Some(Approvals {
            approved: 2,
            required: 3,
        });
        i.failing_checks = Some(3);
        i.gh.as_mut().unwrap().behind_by = Some(4);
        let (_, r) = compute(&i);
        for line in [
            "2 of 3 required approvals",
            "3 checks failing",
            "Branch is 4 commits behind main",
        ] {
            assert!(r.details.iter().any(|d| d == line), "{r:?}");
        }
        i.gh.as_mut().unwrap().behind_by = None;
        i.gh.as_mut().unwrap().merge_state_status = "BEHIND".into();
        assert!(
            compute(&i)
                .1
                .details
                .contains(&"Branch is behind main".to_string())
        );
    }
    #[test]
    fn github_merge_bypass_only_blocked_admin_and_open_ready() {
        let mut i = github_inputs();
        i.gh.as_mut().unwrap().viewer_can_merge_as_admin = true;
        assert_permission(&compute(&i).0.merge_bypass, false);
        i.gh.as_mut().unwrap().merge_state_status = "BLOCKED".into();
        assert_permission(&compute(&i).0.merge_bypass, true);
        i.is_draft = true;
        assert_permission(&compute(&i).0.merge_bypass, false);
    }
    #[test]
    fn gitlab_merge_bypass_only_requested_changes_with_merge_permission() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.merge_bypass, false);
        i.gl.as_mut().unwrap().detailed_merge_status = "requested_changes".into();
        assert_permission(&compute(&i).0.merge_bypass, true);
        i.gl.as_mut().unwrap().can_merge = false;
        assert_permission(&compute(&i).0.merge_bypass, false);
    }
    #[test]
    fn github_auto_merge_uses_host_answers_and_enabled_state() {
        let mut i = github_inputs();
        assert_permission(&compute(&i).0.enable_auto_merge, true);
        assert_permission(&compute(&i).0.disable_auto_merge, false);
        i.gh.as_mut().unwrap().auto_merge_enabled = true;
        i.gh.as_mut().unwrap().viewer_can_disable_auto_merge = true;
        let (p, r) = compute(&i);
        assert_permission(&p.disable_auto_merge, true);
        assert_permission(&p.enable_auto_merge, false);
        assert!(r.auto_merge.unwrap().enabled);
    }
    #[test]
    fn gitlab_auto_merge_needs_running_pipeline_and_merge_right() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.enable_auto_merge, true);
        i.gl.as_mut().unwrap().pipeline_status = Some("success".into());
        assert_permission(&compute(&i).0.enable_auto_merge, false);
        i.gl.as_mut().unwrap().merge_when_pipeline_succeeds = true;
        assert_permission(&compute(&i).0.disable_auto_merge, true);
        i.gl.as_mut().unwrap().can_merge = false;
        assert_permission(&compute(&i).0.disable_auto_merge, false);
    }
    #[test]
    fn github_state_changes_need_update_and_appropriate_state() {
        let mut i = github_inputs();
        let (p, _) = compute(&i);
        assert_permission(&p.mark_ready, false);
        assert_permission(&p.convert_to_draft, true);
        assert_permission(&p.close, true);
        assert_permission(&p.reopen, false);
        i.is_draft = true;
        assert_permission(&compute(&i).0.mark_ready, true);
        assert!(compute(&i).0.merge.methods.is_empty());
        i.state = PullRequestState::Closed;
        let (p, r) = compute(&i);
        assert_permission(&p.reopen, true);
        assert_permission(&p.close, false);
        assert_eq!(r.status, ReadinessStatus::Closed);
        i.gh.as_mut().unwrap().viewer_can_update = false;
        assert_permission(&compute(&i).0.reopen, false);
    }
    #[test]
    fn gitlab_state_changes_need_author_or_developer() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.convert_to_draft, true);
        i.is_draft = true;
        assert_permission(&compute(&i).0.mark_ready, true);
        i.gl.as_mut().unwrap().access_level = 20;
        assert_permission(&compute(&i).0.close, false);
        i.viewer_is_author = true;
        assert_permission(&compute(&i).0.close, true);
        i.state = PullRequestState::Closed;
        assert_permission(&compute(&i).0.reopen, true);
    }
    #[test]
    fn github_cannot_delete() {
        assert_permission(&compute(&github_inputs()).0.delete, false);
    }
    #[test]
    fn gitlab_delete_owner_or_allowed_maintainer() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.delete, false);
        i.gl.as_mut().unwrap().access_level = 40;
        assert_permission(&compute(&i).0.delete, false);
        i.gl.as_mut().unwrap().project_allows_maintainer_delete = true;
        assert_permission(&compute(&i).0.delete, true);
        i.gl.as_mut().unwrap().project_allows_maintainer_delete = false;
        i.gl.as_mut().unwrap().access_level = 50;
        assert_permission(&compute(&i).0.delete, true);
    }
    #[test]
    fn github_revert_requires_write_merged_and_known_commit() {
        let mut i = github_inputs();
        assert_permission(&compute(&i).0.revert, false);
        i.state = PullRequestState::Merged;
        i.merged = true;
        i.merge_commit_known = true;
        let (p, r) = compute(&i);
        assert_permission(&p.revert, true);
        assert_permission(&p.merge.permission, false);
        assert_permission(&p.reopen, false);
        assert_eq!(r.status, ReadinessStatus::Merged);
        i.repository_permission = RepositoryPermission::Read;
        assert_permission(&compute(&i).0.revert, false);
    }
    #[test]
    fn gitlab_revert_requires_developer_merged_and_known_commit() {
        let mut i = gitlab_inputs();
        i.state = PullRequestState::Merged;
        i.merged = true;
        assert_permission(&compute(&i).0.revert, false);
        i.merge_commit_known = true;
        assert_permission(&compute(&i).0.revert, true);
        i.gl.as_mut().unwrap().access_level = 20;
        assert_permission(&compute(&i).0.revert, false);
        assert_eq!(compute(&i).1.status, ReadinessStatus::Merged);
    }
    #[test]
    fn github_checkout_always_available() {
        let mut i = github_inputs();
        i.repository_permission = RepositoryPermission::None;
        i.state = PullRequestState::Closed;
        assert_permission(&compute(&i).0.checkout, true);
    }
    #[test]
    fn gitlab_checkout_always_available() {
        let mut i = gitlab_inputs();
        i.gl.as_mut().unwrap().access_level = 0;
        assert_permission(&compute(&i).0.checkout, true);
    }
    #[test]
    fn github_resolve_threads_respects_host_answer() {
        let mut i = github_inputs();
        assert_permission(&compute(&i).0.resolve_threads, true);
        i.can_resolve_threads = false;
        assert_permission(&compute(&i).0.resolve_threads, false);
    }
    #[test]
    fn gitlab_resolve_threads_respects_host_answer() {
        let mut i = gitlab_inputs();
        assert_permission(&compute(&i).0.resolve_threads, true);
        i.can_resolve_threads = false;
        assert_permission(&compute(&i).0.resolve_threads, false);
    }
}
