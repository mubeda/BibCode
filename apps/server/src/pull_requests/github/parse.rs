//! Normalize the GitHub REST, GraphQL, and CLI JSON shapes.

use serde_json::Value;

use crate::pull_requests::{
    error::PullRequestsOperationError,
    host::{HostContext, HostScope},
    model::*,
};

pub(super) fn invalid(operation: &str) -> PullRequestsOperationError {
    PullRequestsOperationError::new(operation, "invalid_response")
}

pub(super) fn string(
    value: &Value,
    key: &str,
    operation: &str,
) -> Result<String, PullRequestsOperationError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(operation))
}

fn optional(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

pub(super) fn actor(value: &Value, operation: &str) -> Result<Actor, PullRequestsOperationError> {
    let login = if value.is_null() {
        "ghost".into()
    } else {
        string(value, "login", operation)?
    };
    let is_bot = login.ends_with("[bot]") || value["is_bot"].as_bool().unwrap_or(false);
    Ok(Actor {
        login,
        name: optional(value, "name"),
        is_bot,
    })
}

pub(super) fn context(
    scope: &HostScope,
    user: &Value,
    repository: &Value,
    viewer: &Value,
) -> Result<HostContext, PullRequestsOperationError> {
    let operation = "pullRequests.getContext";
    let permissions = &repository["permissions"];
    let viewer = viewer
        .pointer("/data/repository/viewerPermission")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(operation))?;
    let repository_permission = [
        ("admin", "ADMIN", RepositoryPermission::Admin),
        ("maintain", "MAINTAIN", RepositoryPermission::Maintain),
        ("push", "WRITE", RepositoryPermission::Write),
        ("triage", "TRIAGE", RepositoryPermission::Triage),
        ("pull", "READ", RepositoryPermission::Read),
    ]
    .into_iter()
    .find(|(flag, role, _)| permissions[*flag].as_bool() == Some(true) || viewer == *role)
    .map_or(RepositoryPermission::None, |(_, _, permission)| permission);
    let methods: Vec<MergeMethod> = [
        ("allow_merge_commit", MergeMethod::Merge),
        ("allow_squash_merge", MergeMethod::Squash),
        ("allow_rebase_merge", MergeMethod::Rebase),
    ]
    .into_iter()
    .filter(|(key, _)| repository[*key].as_bool() == Some(true))
    .map(|(_, method)| method)
    .collect();
    let merge_policy = MergePolicy {
        default_method: methods.first().copied(),
        methods,
        delete_branch_default: repository["delete_branch_on_merge"]
            .as_bool()
            .unwrap_or(false),
        auto_merge_allowed: repository["allow_auto_merge"].as_bool().unwrap_or(false),
        requires_pipeline_success: false,
        requires_resolved_discussions: false,
    };
    Ok(HostContext {
        provider: PullRequestsProvider::Github,
        host: scope.host.clone(),
        repository: scope.repository.clone(),
        host_version: None,
        raw_host_version: None,
        gitlab_access_level: None,
        default_branch: string(repository, "default_branch", operation)?,
        account: actor(user, operation)?,
        repository_permission,
        merge_policy,
        web_url: string(repository, "html_url", operation)?,
    })
}

pub(super) fn row(value: &Value) -> Result<ListRow, PullRequestsOperationError> {
    let operation = "pullRequests.list";
    let state = match value["state"].as_str() {
        Some("OPEN" | "open") => PullRequestState::Open,
        Some("CLOSED" | "closed") => PullRequestState::Closed,
        Some("MERGED" | "merged") => PullRequestState::Merged,
        _ => return Err(invalid(operation)),
    };
    let labels = value
        .pointer("/labels/nodes")
        .unwrap_or(&value["labels"])
        .as_array()
        .ok_or_else(|| invalid(operation))?
        .iter()
        .map(|label| {
            Ok(Label {
                name: string(label, "name", operation)?,
                color: optional(label, "color"),
                description: optional(label, "description"),
            })
        })
        .collect::<Result<_, PullRequestsOperationError>>()?;
    let review_decision = match value["reviewDecision"].as_str() {
        Some("REVIEW_REQUIRED") => Some(ReviewDecision::ReviewRequired),
        Some("APPROVED") => Some(ReviewDecision::Approved),
        Some("CHANGES_REQUESTED") => Some(ReviewDecision::ChangesRequested),
        _ => None,
    };
    let checks_summary = if let Some(state) = value
        .pointer("/commits/nodes/0/commit/statusCheckRollup/state")
        .and_then(Value::as_str)
    {
        Some(check_state(state))
    } else if let Some(state) = value
        .pointer("/statusCheckRollup/state")
        .and_then(Value::as_str)
    {
        Some(check_state(state))
    } else {
        value["statusCheckRollup"]
            .as_array()
            .filter(|checks| !checks.is_empty())
            .map(|checks| {
                let states: Vec<_> = checks
                    .iter()
                    .map(|check| {
                        let state = check["state"]
                            .as_str()
                            .or_else(|| {
                                if check["status"].as_str() == Some("COMPLETED") {
                                    check["conclusion"].as_str()
                                } else {
                                    Some("PENDING")
                                }
                            })
                            .unwrap_or("NEUTRAL");
                        individual_check_state(state)
                    })
                    .collect();
                [
                    ChecksSummary::Failure,
                    ChecksSummary::Pending,
                    ChecksSummary::Success,
                ]
                .into_iter()
                .find(|state| states.contains(state))
                .unwrap_or(ChecksSummary::Neutral)
            })
    };
    Ok(ListRow {
        number: value["number"].as_u64().ok_or_else(|| invalid(operation))?,
        title: string(value, "title", operation)?,
        state,
        is_draft: value["isDraft"]
            .as_bool()
            .ok_or_else(|| invalid(operation))?,
        author: actor(&value["author"], operation)?,
        created_at: string(value, "createdAt", operation)?,
        updated_at: string(value, "updatedAt", operation)?,
        merged_at: optional(value, "mergedAt"),
        closed_at: optional(value, "closedAt"),
        head_branch: string(value, "headRefName", operation)?,
        base_branch: string(value, "baseRefName", operation)?,
        labels,
        review_decision,
        checks_summary,
        comment_count: value["totalCommentsCount"].as_u64().unwrap_or(0),
        approvals: None,
        unresolved_threads: None,
        url: string(value, "url", operation)?,
    })
}

fn check_state(state: &str) -> ChecksSummary {
    match state {
        "SUCCESS" => ChecksSummary::Success,
        "FAILURE" | "ERROR" => ChecksSummary::Failure,
        "PENDING" | "EXPECTED" => ChecksSummary::Pending,
        _ => ChecksSummary::Neutral,
    }
}

// gh pr list exports individual CheckRun conclusions, not the aggregate
// GraphQL StatusState enum. Follow gh's checks/aggregate.go buckets here.
fn individual_check_state(state: &str) -> ChecksSummary {
    match state {
        "SUCCESS" => ChecksSummary::Success,
        "ERROR" | "FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" => ChecksSummary::Failure,
        "SKIPPED" | "NEUTRAL" | "CANCELLED" => ChecksSummary::Neutral,
        _ => ChecksSummary::Pending,
    }
}

pub(super) fn vocabulary(
    kind: VocabularyKind,
    value: &Value,
    query: Option<&str>,
) -> Result<Vocabulary, PullRequestsOperationError> {
    let operation = "pullRequests.getVocabulary";
    let values = value.as_array().ok_or_else(|| invalid(operation))?;
    let mut entries = Vec::new();
    for value in values.iter().take(100) {
        let (id, label) = match kind {
            VocabularyKind::Milestones => (
                value["number"]
                    .as_u64()
                    .ok_or_else(|| invalid(operation))?
                    .to_string(),
                string(value, "title", operation)?,
            ),
            VocabularyKind::Users => {
                let login = string(value, "login", operation)?;
                (login.clone(), login)
            }
            _ => {
                let name = string(value, "name", operation)?;
                (name.clone(), name)
            }
        };
        let entry = VocabularyEntry {
            id,
            label,
            color: optional(value, "color"),
            description: optional(
                value,
                if kind == VocabularyKind::Users {
                    "name"
                } else {
                    "description"
                },
            ),
        };
        let matches = query.is_none_or(|query| {
            let query = query.to_lowercase();
            entry.label.to_lowercase().contains(&query)
                || entry
                    .description
                    .as_deref()
                    .is_some_and(|s| s.to_lowercase().contains(&query))
        });
        if matches {
            entries.push(entry);
        }
    }
    Ok(Vocabulary {
        kind,
        entries,
        truncated: values.len() >= 100,
    })
}

pub(super) fn repository_permission(value: &str) -> RepositoryPermission {
    match value {
        "ADMIN" => RepositoryPermission::Admin,
        "MAINTAIN" => RepositoryPermission::Maintain,
        "WRITE" => RepositoryPermission::Write,
        "TRIAGE" => RepositoryPermission::Triage,
        "READ" => RepositoryPermission::Read,
        _ => RepositoryPermission::None,
    }
}

pub(super) fn reviewer_state(value: &str) -> ReviewerState {
    match value {
        "APPROVED" => ReviewerState::Approved,
        "CHANGES_REQUESTED" => ReviewerState::ChangesRequested,
        "DISMISSED" => ReviewerState::Dismissed,
        "PENDING" => ReviewerState::ReviewStarted,
        "COMMENTED" => ReviewerState::Commented,
        _ => ReviewerState::Unreviewed,
    }
}

pub(super) fn nodes(value: &Value) -> &[Value] {
    value
        .as_array()
        .or_else(|| value["nodes"].as_array())
        .map_or(&[], Vec::as_slice)
}

pub(super) fn reactions(value: &Value) -> ReactionSummary {
    nodes(value)
        .iter()
        .filter_map(|v| {
            let content = match v["content"].as_str()? {
                "THUMBS_UP" => ReactionContent::ThumbsUp,
                "THUMBS_DOWN" => ReactionContent::ThumbsDown,
                "LAUGH" => ReactionContent::Laugh,
                "CONFUSED" => ReactionContent::Confused,
                "HEART" => ReactionContent::Heart,
                "HOORAY" => ReactionContent::Hooray,
                "ROCKET" => ReactionContent::Rocket,
                "EYES" => ReactionContent::Eyes,
                _ => return None,
            };
            Some(Reaction {
                content,
                count: v["users"]["totalCount"].as_u64().unwrap_or(0),
                viewer_reacted: v["viewerHasReacted"].as_bool().unwrap_or(false),
            })
        })
        .collect()
}

pub(super) fn detail(
    value: &Value,
    viewer: &Value,
    context: &HostContext,
    capabilities: HostCapabilities,
) -> Result<DetailRaw, PullRequestsOperationError> {
    use crate::source_control::checks::aggregate_github_checks;

    let operation = "pullRequests.get";
    let check_count = value
        .get("statusCheckRollup")
        .filter(|rollup| !rollup.is_null())
        .map(|rollup| {
            let contexts =
                serde_json::from_value(rollup.clone()).map_err(|_| invalid(operation))?;
            aggregate_github_checks(contexts)
                .map(|checks| checks.len() as u64)
                .map_err(|_| invalid(operation))
        })
        .transpose()?;
    let repository = &viewer["data"]["repository"];
    let pr = &repository["pullRequest"];
    if !pr.is_object() {
        return Err(invalid(operation));
    }
    let row = row(value).map_err(|mut e| {
        e.operation = operation.into();
        e
    })?;
    let mut reviewers: Vec<Reviewer> = Vec::new();
    for request in nodes(&value["reviewRequests"]) {
        let actor_value = request.get("requestedReviewer").unwrap_or(request);
        let actor = if actor_value["login"].is_string() {
            actor(actor_value, operation)?
        } else {
            Actor {
                login: string(actor_value, "slug", operation)?,
                name: optional(actor_value, "name"),
                is_bot: false,
            }
        };
        if !reviewers.iter().any(|r| r.actor.login == actor.login) {
            reviewers.push(Reviewer {
                actor,
                state: ReviewerState::Unreviewed,
                can_rerequest: false,
            });
        }
    }
    for review in nodes(&value["latestReviews"]) {
        let actor = actor(&review["author"], operation)?;
        let state = reviewer_state(review["state"].as_str().unwrap_or_default());
        // An outstanding request means the latest review has already been re-requested.
        if !reviewers.iter().any(|r| r.actor.login == actor.login) {
            reviewers.push(Reviewer {
                actor,
                state,
                can_rerequest: false,
            });
        }
    }
    let rule = &pr["baseRef"]["refUpdateRule"];
    let approved = reviewers
        .iter()
        .filter(|r| r.state == ReviewerState::Approved)
        .count() as u64;
    let required_approvals = rule["requiredApprovingReviewCount"]
        .as_u64()
        .map(|required| Approvals { approved, required });
    let head_sha = string(value, "headRefOid", operation)?;
    let auto_merge_method = match value["autoMergeRequest"]["mergeMethod"].as_str() {
        Some("MERGE") => Some(MergeMethod::Merge),
        Some("SQUASH") => Some(MergeMethod::Squash),
        Some("REBASE") => Some(MergeMethod::Rebase),
        _ => None,
    };
    let inputs = PermissionInputs {
        viewer_login: context.account.login.clone(),
        viewer_can_comment: None,
        repository_permission: repository_permission(
            repository["viewerPermission"].as_str().unwrap_or_default(),
        ),
        state: row.state,
        is_draft: row.is_draft,
        locked: pr["locked"].as_bool().unwrap_or(false),
        viewer_is_author: pr["viewerDidAuthor"].as_bool().unwrap_or(false),
        is_cross_repository: value["isCrossRepository"].as_bool().unwrap_or(false),
        maintainer_can_modify: value["maintainerCanModify"].as_bool().unwrap_or(false),
        merged: row.state == PullRequestState::Merged,
        merge_commit_known: optional(&pr["mergeCommit"], "oid").is_some(),
        gh: Some(GitHubInputs {
            viewer_can_update: pr["viewerCanUpdate"].as_bool().unwrap_or(false),
            viewer_can_merge_as_admin: pr["viewerCanMergeAsAdmin"].as_bool().unwrap_or(false),
            viewer_can_enable_auto_merge: pr["viewerCanEnableAutoMerge"].as_bool().unwrap_or(false),
            viewer_can_disable_auto_merge: pr["viewerCanDisableAutoMerge"]
                .as_bool()
                .unwrap_or(false),
            viewer_can_apply_suggestion: pr["viewerCanApplySuggestion"].as_bool().unwrap_or(false),
            merge_state_status: optional(value, "mergeStateStatus")
                .unwrap_or_else(|| "UNKNOWN".into()),
            mergeable: optional(value, "mergeable").unwrap_or_else(|| "UNKNOWN".into()),
            review_decision: optional(value, "reviewDecision"),
            viewer_allowed_to_dismiss_reviews: rule["viewerAllowedToDismissReviews"].as_bool(),
            auto_merge_enabled: value["autoMergeRequest"].is_object(),
            behind_by: None,
        }),
        gl: None,
        merge_policy: context.merge_policy.clone(),
        capabilities,
        head_sha: head_sha.clone(),
        base_branch: row.base_branch.clone(),
        required_approvals,
        failing_checks: None,
        has_reviewed_reviewers: reviewers
            .iter()
            .any(|r| r.state != ReviewerState::Unreviewed),
        has_dismissible_reviews: nodes(&value["latestReviews"])
            .iter()
            .any(|r| matches!(r["state"].as_str(), Some("APPROVED" | "CHANGES_REQUESTED"))),
        can_resolve_threads: nodes(&pr["reviewThreads"])
            .iter()
            .any(|t| t["viewerCanResolve"].as_bool() == Some(true)),
        auto_merge_method,
        version_unavailable_reason: None,
    };
    let commit_count = pr["commits"]["totalCount"]
        .as_u64()
        .unwrap_or_else(|| nodes(&value["commits"]).len() as u64);
    let changed_files = value["changedFiles"].as_u64().unwrap_or(0);
    let conversation = pr["comments"]["totalCount"]
        .as_u64()
        .zip(pr["reviews"]["totalCount"].as_u64())
        .and_then(|(c, r)| c.checked_add(r));
    let head_repository = optional(&value["headRepository"], "nameWithOwner").or_else(|| {
        optional(&value["headRepositoryOwner"], "login")
            .zip(optional(&value["headRepository"], "name"))
            .map(|(o, n)| format!("{o}/{n}"))
    });
    let milestone = if value["milestone"].is_object() {
        Some(Milestone {
            id: value["milestone"]["number"]
                .as_u64()
                .ok_or_else(|| invalid(operation))?
                .to_string(),
            title: string(&value["milestone"], "title", operation)?,
            due_on: optional(&value["milestone"], "dueOn"),
        })
    } else {
        None
    };
    let linked_issues = nodes(&value["closingIssuesReferences"])
        .iter()
        .map(|v| {
            Ok(LinkedIssue {
                reference: format!(
                    "#{}",
                    v["number"].as_u64().ok_or_else(|| invalid(operation))?
                ),
                title: optional(v, "title"),
                url: string(v, "url", operation)?,
            })
        })
        .collect::<Result<_, PullRequestsOperationError>>()?;
    let detail = Detail {
        number: row.number,
        title: row.title,
        body: value["body"].as_str().unwrap_or_default().into(),
        state: row.state,
        is_draft: row.is_draft,
        locked: inputs.locked,
        lock_reason: optional(pr, "activeLockReason"),
        author: row.author,
        created_at: row.created_at,
        updated_at: row.updated_at,
        merged_at: row.merged_at,
        closed_at: row.closed_at,
        merged_by: (!value["mergedBy"].is_null())
            .then(|| actor(&value["mergedBy"], operation))
            .transpose()?,
        head_branch: row.head_branch,
        base_branch: row.base_branch,
        head_sha: head_sha.clone(),
        base_sha: string(value, "baseRefOid", operation)?,
        is_cross_repository: inputs.is_cross_repository,
        head_repository,
        maintainer_can_modify: inputs.maintainer_can_modify,
        commit_count,
        changed_files,
        additions: value["additions"].as_u64().unwrap_or(0),
        deletions: value["deletions"].as_u64().unwrap_or(0),
        labels: row.labels,
        milestone,
        assignees: nodes(&value["assignees"])
            .iter()
            .map(|v| actor(v, operation))
            .collect::<Result<_, _>>()?,
        reviewers,
        approval_rules: vec![],
        linked_issues,
        reactions: reactions(pr.get("reactionGroups").unwrap_or(&value["reactionGroups"])),
        readiness: MergeReadiness {
            status: ReadinessStatus::Unknown,
            summary: super::super::permissions::reasons::HOST_DATA.into(),
            details: vec![],
            required_approvals: None,
            auto_merge: None,
            head_sha,
        },
        permissions: super::super::permissions::pending_permissions(),
        url: row.url,
        tab_counts: TabCounts {
            conversation,
            commits: commit_count,
            checks: check_count,
            files: changed_files,
        },
    };
    Ok(DetailRaw {
        merge_commit_sha: optional(&pr["mergeCommit"], "oid"),
        detail_without_permissions: detail,
        inputs,
    })
}

pub(super) fn timeline_item(
    kind: &str,
    v: &Value,
    repository_permission: RepositoryPermission,
    allowed_to_dismiss: Option<bool>,
) -> Result<TimelineItem, PullRequestsOperationError> {
    use crate::pull_requests::{permissions, read};
    let op = "pullRequests.getTimeline";
    let node = string(v, "id", op)?;
    let database = || v["databaseId"].as_u64().ok_or_else(|| invalid(op));
    Ok(match kind {
        "comments" => TimelineItem::Comment {
            id: format!("ic:{}:{node}", database()?),
            author: actor(&v["author"], op)?,
            body: v["body"].as_str().unwrap_or_default().into(),
            created_at: string(v, "createdAt", op)?,
            updated_at: string(v, "updatedAt", op)?,
            viewer_is_author: v["viewerDidAuthor"].as_bool().unwrap_or(false),
            minimized: v["isMinimized"].as_bool().unwrap_or(false),
            reactions: reactions(&v["reactionGroups"]),
        },
        "reviews" => {
            let state = match v["state"].as_str() {
                Some("APPROVED") => ReviewState::Approved,
                Some("CHANGES_REQUESTED") => ReviewState::ChangesRequested,
                Some("DISMISSED") => ReviewState::Dismissed,
                Some("COMMENTED") => ReviewState::Commented,
                _ => ReviewState::Pending,
            };
            TimelineItem::Review {
                id: format!("rv:{}:{node}", database()?),
                author: actor(&v["author"], op)?,
                state,
                body: v["body"].as_str().unwrap_or_default().into(),
                submitted_at: optional(v, "submittedAt").unwrap_or_default(),
                commit_sha: optional(&v["commit"], "oid"),
                viewer_is_author: v["viewerDidAuthor"].as_bool().unwrap_or(false),
                can_dismiss: permissions::dismissal_permission(
                    repository_permission,
                    allowed_to_dismiss,
                    matches!(state, ReviewState::Approved | ReviewState::ChangesRequested),
                )
                .allowed,
            }
        }
        "reviewThreads" => {
            let first = nodes(&v["comments"]).first().ok_or_else(|| invalid(op))?;
            let line = v["line"].as_u64();
            let start = v["startLine"].as_u64();
            let mut seen = std::collections::HashSet::new();
            let comments = nodes(&v["comments"])
                .iter()
                .filter(|n| seen.insert(n["id"].clone()))
                .map(|n| {
                    let body = n["body"].as_str().unwrap_or_default().to_owned();
                    Ok(ThreadComment {
                        id: format!(
                            "rc:{}:{}",
                            n["databaseId"].as_u64().ok_or_else(|| invalid(op))?,
                            string(n, "id", op)?
                        ),
                        author: actor(&n["author"], op)?,
                        suggestion: read::suggestion(
                            &body,
                            n["line"].as_u64().or(line).unwrap_or(0),
                            n["startLine"].as_u64().or(start),
                            n["diffHunk"].as_str().unwrap_or_default(),
                        ),
                        body,
                        created_at: string(n, "createdAt", op)?,
                        updated_at: string(n, "updatedAt", op)?,
                        viewer_is_author: n["viewerDidAuthor"].as_bool().unwrap_or(false),
                        minimized: n["isMinimized"].as_bool().unwrap_or(false),
                        reactions: reactions(&n["reactionGroups"]),
                    })
                })
                .collect::<Result<_, PullRequestsOperationError>>()?;
            TimelineItem::Thread {
                id: format!(
                    "th:{node}:{}",
                    first["databaseId"].as_u64().ok_or_else(|| invalid(op))?
                ),
                path: string(v, "path", op)?,
                line,
                start_line: start,
                side: if v["diffSide"].as_str() == Some("LEFT") {
                    DiffSide::Left
                } else {
                    DiffSide::Right
                },
                is_resolved: v["isResolved"].as_bool().unwrap_or(false),
                is_outdated: v["isOutdated"].as_bool().unwrap_or(false),
                can_resolve: v["viewerCanResolve"].as_bool().unwrap_or(false),
                diff_hunk: optional(first, "diffHunk"),
                comments,
            }
        }
        _ => {
            let (event, detail) = match v["__typename"].as_str().unwrap_or_default() {
                "LabeledEvent" => ("labeled", optional(&v["label"], "name")),
                "UnlabeledEvent" => ("unlabeled", optional(&v["label"], "name")),
                "AssignedEvent" => ("assigned", optional(&v["assignee"], "login")),
                "UnassignedEvent" => ("unassigned", optional(&v["assignee"], "login")),
                "ReviewRequestedEvent" => (
                    "review_requested",
                    optional(&v["requestedReviewer"], "login")
                        .or_else(|| optional(&v["requestedReviewer"], "slug")),
                ),
                "ClosedEvent" => ("closed", None),
                "ReopenedEvent" => ("reopened", None),
                "ReadyForReviewEvent" => ("ready_for_review", None),
                "ConvertToDraftEvent" => ("converted_to_draft", None),
                "MergedEvent" => ("merged", None),
                "HeadRefForcePushedEvent" => ("head_ref_force_pushed", None),
                "MilestonedEvent" => ("milestoned", optional(v, "milestoneTitle")),
                "DemilestonedEvent" => ("demilestoned", optional(v, "milestoneTitle")),
                "RenamedTitleEvent" => (
                    "renamed",
                    Some(format!(
                        "{} → {}",
                        v["previousTitle"].as_str().unwrap_or_default(),
                        v["currentTitle"].as_str().unwrap_or_default()
                    )),
                ),
                "LockedEvent" => ("locked", None),
                "UnlockedEvent" => ("unlocked", None),
                _ => ("unknown", optional(v, "__typename")),
            };
            TimelineItem::Event {
                id: format!("ev:{node}"),
                actor: (!v["actor"].is_null())
                    .then(|| actor(&v["actor"], op))
                    .transpose()?,
                event: event.into(),
                detail,
                created_at: optional(v, "createdAt").unwrap_or_default(),
            }
        }
    })
}

pub(super) fn commits(
    value: &Value,
    scope: &HostScope,
    number: u64,
) -> Result<Commits, PullRequestsOperationError> {
    let op = "pullRequests.getCommits";
    let values = value["commits"].as_array().ok_or_else(|| invalid(op))?;
    let commits = values
        .iter()
        .map(|v| {
            let sha = string(v, "oid", op)?;
            let first = nodes(&v["authors"]).first().unwrap_or(&Value::Null);
            let login = optional(first, "login")
                .or_else(|| optional(first, "name"))
                .unwrap_or_else(|| "ghost".into());
            Ok(Commit {
                short_sha: sha.chars().take(7).collect(),
                url: format!(
                    "https://{}/{}/pull/{number}/commits/{sha}",
                    scope.host, scope.repository
                ),
                sha,
                subject: v["messageHeadline"].as_str().unwrap_or_default().into(),
                body: optional(v, "messageBody"),
                author: Actor {
                    login,
                    name: optional(first, "name"),
                    is_bot: first["isBot"].as_bool().unwrap_or(false),
                },
                authored_at: string(v, "authoredDate", op)?,
            })
        })
        .collect::<Result<_, PullRequestsOperationError>>()?;
    Ok(Commits { commits })
}

pub(super) fn checks(value: &Value) -> Result<Checks, PullRequestsOperationError> {
    use crate::{pull_requests::read, source_control::checks::aggregate_github_checks};
    let op = "pullRequests.getChecks";
    let contexts =
        serde_json::from_value(value["statusCheckRollup"].clone()).map_err(|_| invalid(op))?;
    let folded = aggregate_github_checks(contexts).map_err(|_| invalid(op))?;
    let mut values = nodes(&value["statusCheckRollup"])
        .iter()
        .collect::<Vec<_>>();
    values.sort_by(|a, b| b["startedAt"].as_str().cmp(&a["startedAt"].as_str()));
    let mut metadata = std::collections::HashMap::new();
    for v in values {
        let text = |key| {
            v[key]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let name = text("name").or_else(|| text("context")).unwrap_or_default();
        let state = text("state")
            .or_else(|| {
                if v["status"].as_str() == Some("COMPLETED") {
                    text("conclusion")
                } else {
                    text("status")
                }
            })
            .unwrap_or_default();
        metadata
            .entry((
                name,
                text("workflowName"),
                text("detailsUrl").or_else(|| text("targetUrl")),
                state,
            ))
            .or_insert(v);
    }
    let rows = folded.into_iter().map(|c| {
        let meta = metadata
            .get(&(
                c.name.clone(),
                c.workflow.clone(),
                c.link.clone(),
                c.state.clone(),
            ))
            .copied()
            .unwrap_or(&Value::Null);
        let started_at = optional(meta, "startedAt");
        let completed_at = optional(meta, "completedAt");
        let duration_seconds = read::duration(started_at.as_deref(), completed_at.as_deref());
        let state = match c.state.as_str() {
            "SUCCESS" => CheckState::Success,
            "FAILURE" | "ERROR" | "TIMED_OUT" | "ACTION_REQUIRED" => CheckState::Failure,
            "CANCELLED" => CheckState::Cancelled,
            "SKIPPED" => CheckState::Skipped,
            "NEUTRAL" => CheckState::Neutral,
            _ => CheckState::Pending,
        };
        (
            c.workflow.unwrap_or_else(|| "Status checks".into()),
            Check {
                name: c.name,
                state,
                url: c.link,
                started_at,
                completed_at,
                duration_seconds,
            },
        )
    });
    Ok(read::grouped_checks(rows, None))
}

pub(super) fn file_rows(values: &Value) -> Result<Vec<File>, PullRequestsOperationError> {
    let op = "pullRequests.getFiles";
    values
        .as_array()
        .ok_or_else(|| invalid(op))?
        .iter()
        .map(|f| {
            Ok(File {
                path: string(f, "path", op)?,
                previous_path: None,
                change_type: match f["changeType"].as_str() {
                    Some("ADDED" | "added") => ChangeType::Added,
                    Some("DELETED" | "REMOVED" | "removed") => ChangeType::Removed,
                    Some("RENAMED" | "renamed") => ChangeType::Renamed,
                    Some("COPIED" | "copied") => ChangeType::Copied,
                    _ => ChangeType::Modified,
                },
                additions: f["additions"].as_u64().unwrap_or(0),
                deletions: f["deletions"].as_u64().unwrap_or(0),
                patch: None,
                too_large: false,
            })
        })
        .collect::<Result<_, PullRequestsOperationError>>()
}

pub(super) fn file_list(v: &Value) -> Result<Files, PullRequestsOperationError> {
    let op = "pullRequests.getFiles";
    let files = file_rows(&v["files"])?;
    let base = string(v, "baseRefOid", op)?;
    Ok(Files {
        files,
        diff_refs: DiffRefs {
            base_sha: base.clone(),
            start_sha: base,
            head_sha: string(v, "headRefOid", op)?,
        },
        truncated: false,
    })
}

/// Phase 03 emits database and node identifiers together; neither is optional.
pub(super) struct ActionId<'a> {
    pub kind: &'a str,
    pub database_id: u64,
    pub node_id: &'a str,
}

pub(super) fn action_id(value: &str) -> Result<ActionId<'_>, PullRequestsOperationError> {
    use crate::pull_requests::action::{invalid_request, numeric_id};
    let mut parts = value.split(':');
    let (kind, first, second) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    if parts.next().is_some() || !matches!(kind, "ic" | "rc" | "rv" | "th") {
        return Err(invalid_request());
    }
    let (database, node_id) = if kind == "th" {
        (second, first)
    } else {
        (first, second)
    };
    if node_id.is_empty() || node_id.chars().any(char::is_whitespace) {
        return Err(invalid_request());
    }
    Ok(ActionId {
        kind,
        database_id: numeric_id(database)?,
        node_id,
    })
}

#[cfg(test)]
mod mapping_tests {
    use super::*;
    #[test]
    fn pull_requests_github_reviewer_states_match_contract_and_unknown_is_unreviewed() {
        for (raw, state) in [
            ("COMMENTED", ReviewerState::Commented),
            ("APPROVED", ReviewerState::Approved),
            ("CHANGES_REQUESTED", ReviewerState::ChangesRequested),
            ("DISMISSED", ReviewerState::Dismissed),
            ("PENDING", ReviewerState::ReviewStarted),
            ("FUTURE_STATE", ReviewerState::Unreviewed),
        ] {
            assert_eq!(reviewer_state(raw), state, "{raw}");
        }
    }
}
