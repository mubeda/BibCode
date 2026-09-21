//! Normalize GitLab project, vocabulary and merge request responses.

use serde_json::Value;

use crate::pull_requests::{
    error::PullRequestsOperationError,
    host::{HostContext, HostScope, HostVersion},
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
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(operation))
}

fn optional(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn actor(value: &Value, operation: &str) -> Result<Actor, PullRequestsOperationError> {
    Ok(Actor {
        login: string(value, "username", operation)?,
        name: optional(value, "name"),
        is_bot: value["bot"].as_bool().unwrap_or(false),
    })
}

pub(super) fn context(
    scope: &HostScope,
    user: &Value,
    project: &Value,
    raw_version: Option<&str>,
) -> Result<HostContext, PullRequestsOperationError> {
    let operation = "pullRequests.getContext";
    let access = ["project_access", "group_access"]
        .into_iter()
        .filter_map(|kind| project["permissions"][kind]["access_level"].as_u64())
        .max()
        .unwrap_or(0);
    let repository_permission = match access {
        50.. => RepositoryPermission::Admin,
        40..=49 => RepositoryPermission::Maintain,
        30..=39 => RepositoryPermission::Write,
        20..=29 => RepositoryPermission::Triage,
        5..=19 => RepositoryPermission::Read,
        _ => RepositoryPermission::None,
    };
    let squash = project["squash_option"].as_str();
    let methods = match project["merge_method"].as_str() {
        Some("merge") => {
            if squash.is_some_and(|s| s != "never") {
                vec![MergeMethod::Merge, MergeMethod::Squash]
            } else {
                vec![MergeMethod::Merge]
            }
        }
        Some("rebase_merge") => vec![MergeMethod::Merge],
        Some("ff") => vec![MergeMethod::Rebase],
        _ => return Err(invalid(operation)),
    };
    // A default must be selectable under the project's merge method.
    let default_method = if matches!(squash, Some("always" | "default_on"))
        && methods.contains(&MergeMethod::Squash)
    {
        Some(MergeMethod::Squash)
    } else {
        methods.first().copied()
    };
    let host_version = raw_version
        .filter(|version| HostVersion::parse(version).is_some())
        .map(str::to_owned);
    Ok(HostContext {
        provider: PullRequestsProvider::Gitlab,
        host: scope.host.clone(),
        repository: scope.repository.clone(),
        host_version,
        raw_host_version: raw_version.map(str::to_owned),
        gitlab_access_level: Some(u32::try_from(access).unwrap_or(u32::MAX)),
        default_branch: string(project, "default_branch", operation)?,
        account: actor(user, operation)?,
        repository_permission,
        merge_policy: MergePolicy {
            methods,
            default_method,
            delete_branch_default: project["remove_source_branch_after_merge"]
                .as_bool()
                .unwrap_or(false),
            auto_merge_allowed: true,
            requires_pipeline_success: project["only_allow_merge_if_pipeline_succeeds"]
                .as_bool()
                .unwrap_or(false),
            requires_resolved_discussions:
                project["only_allow_merge_if_all_discussions_are_resolved"]
                    .as_bool()
                    .unwrap_or(false),
        },
        web_url: string(project, "web_url", operation)?,
    })
}

pub(super) fn row(value: &Value) -> Result<ListRow, PullRequestsOperationError> {
    let operation = "pullRequests.list";
    let state = match value["state"].as_str() {
        Some("opened" | "locked") => PullRequestState::Open,
        Some("merged") => PullRequestState::Merged,
        Some("closed") => PullRequestState::Closed,
        _ => return Err(invalid(operation)),
    };
    let labels = value["labels"]
        .as_array()
        .ok_or_else(|| invalid(operation))?
        .iter()
        .map(|label| {
            let name = label
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid(operation))?
                .to_owned();
            Ok(Label {
                name,
                color: None,
                description: None,
            })
        })
        .collect::<Result<_, PullRequestsOperationError>>()?;
    Ok(ListRow {
        number: value["iid"].as_u64().ok_or_else(|| invalid(operation))?,
        title: string(value, "title", operation)?,
        state,
        is_draft: value["draft"].as_bool().ok_or_else(|| invalid(operation))?,
        author: actor(&value["author"], operation)?,
        created_at: string(value, "created_at", operation)?,
        updated_at: string(value, "updated_at", operation)?,
        merged_at: optional(value, "merged_at"),
        closed_at: optional(value, "closed_at"),
        head_branch: string(value, "source_branch", operation)?,
        base_branch: string(value, "target_branch", operation)?,
        labels,
        review_decision: None,
        checks_summary: None,
        comment_count: value["user_notes_count"]
            .as_u64()
            .ok_or_else(|| invalid(operation))?,
        approvals: None,
        unresolved_threads: None,
        url: string(value, "web_url", operation)?,
    })
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
                value["id"]
                    .as_u64()
                    .ok_or_else(|| invalid(operation))?
                    .to_string(),
                string(value, "title", operation)?,
            ),
            VocabularyKind::Users => (
                value["id"]
                    .as_u64()
                    .ok_or_else(|| invalid(operation))?
                    .to_string(),
                string(value, "username", operation)?,
            ),
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
        if query.is_none_or(|query| {
            let query = query.to_lowercase();
            entry.label.to_lowercase().contains(&query)
                || entry
                    .description
                    .as_deref()
                    .is_some_and(|s| s.to_lowercase().contains(&query))
        }) {
            entries.push(entry);
        }
    }
    Ok(Vocabulary {
        kind,
        entries,
        truncated: values.len() >= 100,
    })
}

pub(super) fn total(output: &str) -> Option<u64> {
    output
        .lines()
        .take_while(|line| !line.trim().is_empty())
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("x-total")
                .then(|| value.trim().parse().ok())
                .flatten()
        })
}

pub(super) fn nodes(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

pub(super) fn reviewer_state(state: &str) -> ReviewerState {
    match state {
        "unreviewed" => ReviewerState::Unreviewed,
        "reviewed" | "unapproved" => ReviewerState::Commented,
        "approved" => ReviewerState::Approved,
        "requested_changes" => ReviewerState::ChangesRequested,
        "review_started" => ReviewerState::ReviewStarted,
        _ => ReviewerState::Unreviewed,
    }
}

pub(super) fn reactions(values: &Value, viewer: &str) -> ReactionSummary {
    let mut result: ReactionSummary = vec![];
    for v in nodes(values) {
        let content = match v["name"].as_str() {
            Some("thumbsup") => ReactionContent::ThumbsUp,
            Some("thumbsdown") => ReactionContent::ThumbsDown,
            Some("smile" | "laughing") => ReactionContent::Laugh,
            Some("confused") => ReactionContent::Confused,
            Some("heart") => ReactionContent::Heart,
            Some("tada") => ReactionContent::Hooray,
            Some("rocket") => ReactionContent::Rocket,
            Some("eyes") => ReactionContent::Eyes,
            _ => continue,
        };
        let viewer_reacted = v["user"]["username"].as_str() == Some(viewer);
        if let Some(r) = result.iter_mut().find(|r| r.content == content) {
            r.count += 1;
            r.viewer_reacted |= viewer_reacted;
        } else {
            result.push(Reaction {
                content,
                count: 1,
                viewer_reacted,
            });
        }
    }
    result
}

pub(super) struct DetailResponses<'a> {
    pub request: &'a Value,
    pub approvals: &'a Value,
    pub reviewers: &'a Value,
    pub approval_state: &'a Value,
    pub awards: &'a Value,
    pub metadata: &'a Value,
    pub issues: &'a Value,
}

pub(super) struct PermissionResponses<'a> {
    pub request: &'a Value,
    pub approvals: &'a Value,
    pub reviewers: &'a Value,
    pub metadata: &'a Value,
}

impl<'a> From<&DetailResponses<'a>> for PermissionResponses<'a> {
    fn from(value: &DetailResponses<'a>) -> Self {
        Self {
            request: value.request,
            approvals: value.approvals,
            reviewers: value.reviewers,
            metadata: value.metadata,
        }
    }
}

pub(super) fn detail(
    responses: DetailResponses<'_>,
    context: &HostContext,
    capabilities: HostCapabilities,
) -> Result<DetailRaw, PullRequestsOperationError> {
    use crate::pull_requests::permissions;
    let DetailResponses {
        request: v,
        approvals,
        reviewers,
        approval_state,
        awards,
        metadata,
        issues,
    } = responses;
    let op = "pullRequests.get";
    let row = row(v).map_err(|mut e| {
        e.operation = op.into();
        e
    })?;
    let meta = &metadata["data"]["project"]["mergeRequest"];
    if !approvals.is_object()
        || !reviewers.is_array()
        || !meta.is_object()
        || !issues.is_array()
        || !awards.is_array()
    {
        return Err(invalid(op));
    }
    let reviewers = parse_reviewers(reviewers, op)?;
    let approved_by = nodes(&approvals["approved_by"]);
    let required = approvals["approvals_required"].as_u64().unwrap_or(0);
    let approval_rules = if let Some(rules) = approval_state["rules"].as_array() {
        rules
            .iter()
            .map(|r| {
                Ok(ApprovalRule {
                    name: string(r, "name", op)?,
                    approved: nodes(&r["approved_by"]).len() as u64,
                    required: r["approvals_required"].as_u64().unwrap_or(0),
                    approvers: nodes(&r["eligible_approvers"])
                        .iter()
                        .map(|a| actor(a.get("user").unwrap_or(a), op))
                        .collect::<Result<_, _>>()?,
                })
            })
            .collect::<Result<Vec<_>, PullRequestsOperationError>>()?
    } else {
        vec![ApprovalRule {
            name: "Required approvals".into(),
            approved: approved_by.len() as u64,
            required,
            approvers: approved_by
                .iter()
                .map(|a| actor(a.get("user").unwrap_or(a), op))
                .collect::<Result<_, _>>()?,
        }]
    };
    let inputs = permission_inputs(
        &PermissionResponses::from(&responses),
        context,
        capabilities,
        &row,
        &reviewers,
    )?;
    let head_sha = inputs.head_sha.clone();
    let commit_count = meta["commitCount"].as_u64().ok_or_else(|| invalid(op))?;
    let changed_files = v["changes_count"]
        .as_u64()
        .or_else(|| v["changes_count"].as_str().and_then(|n| n.parse().ok()))
        .or_else(|| meta["diffStatsSummary"]["fileCount"].as_u64())
        .ok_or_else(|| invalid(op))?;
    let milestone = if v["milestone"].is_object() {
        Some(Milestone {
            id: v["milestone"]["id"]
                .as_u64()
                .ok_or_else(|| invalid(op))?
                .to_string(),
            title: string(&v["milestone"], "title", op)?,
            due_on: optional(&v["milestone"], "due_date"),
        })
    } else {
        None
    };
    let linked_issues = nodes(issues)
        .iter()
        .map(|issue| {
            Ok(LinkedIssue {
                reference: optional(&issue["references"], "relative")
                    .or_else(|| issue["iid"].as_u64().map(|n| format!("#{n}")))
                    .ok_or_else(|| invalid(op))?,
                title: optional(issue, "title"),
                url: string(issue, "web_url", op)?,
            })
        })
        .collect::<Result<_, PullRequestsOperationError>>()?;
    let detail = Detail {
        number: row.number,
        title: row.title,
        body: v["description"].as_str().unwrap_or_default().into(),
        state: row.state,
        is_draft: row.is_draft,
        locked: inputs.locked,
        lock_reason: None,
        author: row.author,
        created_at: row.created_at,
        updated_at: row.updated_at,
        merged_at: row.merged_at,
        closed_at: row.closed_at,
        merged_by: (!v["merge_user"].is_null())
            .then(|| actor(&v["merge_user"], op))
            .transpose()?,
        head_branch: row.head_branch,
        base_branch: row.base_branch,
        head_sha: head_sha.clone(),
        base_sha: string(&v["diff_refs"], "base_sha", op)?,
        is_cross_repository: inputs.is_cross_repository,
        head_repository: optional(&meta["sourceProject"], "fullPath"),
        maintainer_can_modify: inputs.maintainer_can_modify,
        commit_count,
        changed_files,
        additions: meta["diffStatsSummary"]["additions"]
            .as_u64()
            .ok_or_else(|| invalid(op))?,
        deletions: meta["diffStatsSummary"]["deletions"]
            .as_u64()
            .ok_or_else(|| invalid(op))?,
        labels: row.labels,
        milestone,
        assignees: nodes(&v["assignees"])
            .iter()
            .map(|a| actor(a, op))
            .collect::<Result<_, _>>()?,
        reviewers,
        approval_rules,
        linked_issues,
        reactions: reactions(awards, &context.account.login),
        readiness: MergeReadiness {
            status: ReadinessStatus::Unknown,
            summary: permissions::reasons::HOST_DATA.into(),
            details: vec![],
            required_approvals: None,
            auto_merge: None,
            head_sha,
        },
        permissions: permissions::pending_permissions(),
        url: row.url,
        tab_counts: TabCounts {
            conversation: Some(row.comment_count),
            commits: commit_count,
            checks: None,
            files: changed_files,
        },
    };
    Ok(DetailRaw {
        merge_commit_sha: optional(v, "merge_commit_sha")
            .or_else(|| optional(v, "squash_commit_sha")),
        detail_without_permissions: detail,
        inputs,
    })
}

fn permission_inputs(
    responses: &PermissionResponses<'_>,
    context: &HostContext,
    capabilities: HostCapabilities,
    row: &ListRow,
    reviewers: &[Reviewer],
) -> Result<PermissionInputs, PullRequestsOperationError> {
    use crate::pull_requests::permissions;
    let op = "pullRequests.get";
    let v = responses.request;
    let approvals = responses.approvals;
    let meta = &responses.metadata["data"]["project"]["mergeRequest"];
    if !approvals.is_object() || !responses.reviewers.is_array() || !meta.is_object() {
        return Err(invalid(op));
    }
    let approved_by = nodes(&approvals["approved_by"]);
    let required = approvals["approvals_required"].as_u64().unwrap_or(0);
    let version = context
        .version()
        .map(|v| {
            (
                u32::try_from(v.major).unwrap_or(u32::MAX),
                u32::try_from(v.minor).unwrap_or(u32::MAX),
            )
        })
        .unwrap_or((0, 0));
    let viewer_reviewer_state = nodes(responses.reviewers)
        .iter()
        .find(|r| r["user"]["username"].as_str() == Some(&context.account.login))
        .and_then(|r| optional(r, "state"));
    let head_sha = string(v, "sha", op)?;
    let inputs = PermissionInputs {
        viewer_login: context.account.login.clone(),
        viewer_can_comment: meta["userPermissions"]["createNote"].as_bool(),
        repository_permission: context.repository_permission,
        state: row.state,
        is_draft: row.is_draft,
        locked: v["discussion_locked"].as_bool().unwrap_or(false),
        viewer_is_author: row.author.login == context.account.login,
        is_cross_repository: v["source_project_id"] != v["target_project_id"],
        maintainer_can_modify: v["allow_maintainer_to_push"].as_bool().unwrap_or(false),
        merged: row.state == PullRequestState::Merged,
        merge_commit_known: optional(v, "merge_commit_sha")
            .or_else(|| optional(v, "squash_commit_sha"))
            .is_some(),
        gh: None,
        gl: Some(GitLabInputs {
            can_merge: v["user"]["can_merge"].as_bool().unwrap_or(false),
            detailed_merge_status: optional(v, "detailed_merge_status")
                .unwrap_or_else(|| "unchecked".into()),
            has_conflicts: v["has_conflicts"].as_bool().unwrap_or(false),
            blocking_discussions_resolved: v["blocking_discussions_resolved"]
                .as_bool()
                .unwrap_or(false),
            discussion_locked: v["discussion_locked"].as_bool().unwrap_or(false),
            user_can_approve: approvals["user_can_approve"].as_bool().unwrap_or(false),
            user_has_approved: approvals["user_has_approved"].as_bool().unwrap_or(false),
            approvals_left: approvals["approvals_left"]
                .as_u64()
                .and_then(|n| n.try_into().ok())
                .unwrap_or(0),
            is_reviewer: reviewers
                .iter()
                .any(|r| r.actor.login == context.account.login),
            viewer_reviewer_state,
            merge_when_pipeline_succeeds: v["merge_when_pipeline_succeeds"]
                .as_bool()
                .unwrap_or(false),
            pipeline_status: optional(&v["head_pipeline"], "status"),
            host_version: version,
            access_level: context.gitlab_access_level.unwrap_or(0),
            // The public REST API exposes deletion to Owners/admins only. No documented
            // project-level maintainer grant is returned by these reads; fail closed.
            project_allows_maintainer_delete: false,
            can_push_source_branch: meta["userPermissions"]["pushToSourceBranch"]
                .as_bool()
                .unwrap_or(false),
        }),
        merge_policy: context.merge_policy.clone(),
        capabilities,
        head_sha: head_sha.clone(),
        base_branch: row.base_branch.clone(),
        required_approvals: Some(Approvals {
            approved: approved_by.len() as u64,
            required,
        }),
        failing_checks: None,
        has_reviewed_reviewers: reviewers
            .iter()
            .any(|r| r.state != ReviewerState::Unreviewed),
        has_dismissible_reviews: false,
        can_resolve_threads: permissions::gitlab_thread_resolution(
            meta["userPermissions"]["createNote"]
                .as_bool()
                .unwrap_or(false),
            meta["resolvableDiscussionsCount"]
                .as_u64()
                .is_some_and(|count| count > 0),
        ),
        // The REST auto-merge flag does not identify the selected method.
        // Repository defaults belong to merge permissions, not observed active state.
        auto_merge_method: None,
        version_unavailable_reason: context.version_unavailable_reason().map(str::to_owned),
    };
    Ok(inputs)
}

pub(super) fn action_detail(
    responses: PermissionResponses<'_>,
    context: &HostContext,
    capabilities: HostCapabilities,
) -> Result<ActionDetail, PullRequestsOperationError> {
    let op = "pullRequests.get";
    let request = responses.request;
    let row = row(request)?;
    let reviewers = parse_reviewers(responses.reviewers, op)?;
    let inputs = permission_inputs(&responses, context, capabilities, &row, &reviewers)?;
    Ok(ActionDetail {
        context: ActionContext {
            viewer_login: Some(context.account.login.clone()),
            title: row.title,
            url: row.url,
            base_branch: row.base_branch,
            merge_commit_sha: optional(request, "merge_commit_sha")
                .or_else(|| optional(request, "squash_commit_sha")),
            reviewers: reviewers.into_iter().map(|r| r.actor.login).collect(),
            assignees: nodes(&request["assignees"])
                .iter()
                .map(|a| actor(a, op).map(|actor| actor.login))
                .collect::<Result<_, _>>()?,
        },
        inputs,
    })
}

fn parse_reviewers(values: &Value, op: &str) -> Result<Vec<Reviewer>, PullRequestsOperationError> {
    nodes(values)
        .iter()
        .map(|r| {
            Ok(Reviewer {
                actor: actor(&r["user"], op)?,
                state: reviewer_state(r["state"].as_str().unwrap_or_default()),
                can_rerequest: false,
            })
        })
        .collect::<Result<Vec<_>, PullRequestsOperationError>>()
}

pub(super) fn discussion(
    v: &Value,
    viewer: &str,
    can_create_note: bool,
) -> Result<Vec<TimelineItem>, PullRequestsOperationError> {
    use crate::pull_requests::{permissions, read};
    let op = "pullRequests.getTimeline";
    let id = string(v, "id", op)?;
    let notes = v["notes"].as_array().ok_or_else(|| invalid(op))?;
    let mut items = Vec::new();
    for note in notes.iter().filter(|n| n["system"].as_bool() == Some(true)) {
        let body = note["body"].as_str().unwrap_or_default();
        let first = body.lines().next().unwrap_or_default();
        let event = system_event(first);
        let detail = if event == "labeled" {
            first.strip_prefix("added ~").unwrap_or(first)
        } else {
            first
        };
        items.push(TimelineItem::Event {
            id: format!(
                "nt:{id}:{}",
                note["id"].as_u64().ok_or_else(|| invalid(op))?
            ),
            actor: (!note["author"].is_null())
                .then(|| actor(&note["author"], op))
                .transpose()?,
            event: event.into(),
            detail: Some(detail.into()),
            created_at: string(note, "created_at", op)?,
        });
    }
    let regular = notes
        .iter()
        .filter(|n| n["system"].as_bool() != Some(true))
        .collect::<Vec<_>>();
    if let Some(first) = regular.iter().find(|n| n["position"].is_object()) {
        let position = &first["position"];
        let line = position["new_line"]
            .as_u64()
            .or_else(|| position["old_line"].as_u64());
        let start_line = position["line_range"]["start"]["new_line"]
            .as_u64()
            .or_else(|| position["line_range"]["start"]["old_line"].as_u64());
        let comments = regular
            .iter()
            .map(|note| {
                let body = note["body"].as_str().unwrap_or_default().to_owned();
                let suggestion = if let Some(s) = nodes(&note["suggestions"]).first() {
                    Some(Suggestion {
                        id: s["id"].as_u64().map(|n| n.to_string()),
                        applicable: s["appliable"].as_bool().unwrap_or(false)
                            && !s["applied"].as_bool().unwrap_or(false),
                        from_line: s["from_line"].as_u64().unwrap_or(line.unwrap_or(0)),
                        to_line: s["to_line"].as_u64().unwrap_or(line.unwrap_or(0)),
                        from_content: s["from_content"].as_str().unwrap_or_default().into(),
                        to_content: s["to_content"].as_str().unwrap_or_default().into(),
                    })
                } else {
                    read::suggestion(&body, line.unwrap_or(0), start_line, "")
                };
                Ok(ThreadComment {
                    id: format!(
                        "nt:{id}:{}",
                        note["id"].as_u64().ok_or_else(|| invalid(op))?
                    ),
                    author: actor(&note["author"], op)?,
                    body,
                    created_at: string(note, "created_at", op)?,
                    updated_at: optional(note, "updated_at").unwrap_or(string(
                        note,
                        "created_at",
                        op,
                    )?),
                    viewer_is_author: note["author"]["username"].as_str() == Some(viewer),
                    minimized: false,
                    reactions: reactions(&note["award_emoji"], viewer),
                    suggestion,
                })
            })
            .collect::<Result<_, PullRequestsOperationError>>()?;
        items.push(TimelineItem::Thread {
            id: format!("ds:{id}"),
            path: string(position, "new_path", op)?,
            line,
            start_line,
            side: if position["new_line"].as_u64().is_some() {
                DiffSide::Right
            } else {
                DiffSide::Left
            },
            is_resolved: v["resolved"].as_bool().unwrap_or_else(|| {
                regular
                    .iter()
                    .all(|n| n["resolved"].as_bool() == Some(true))
            }),
            is_outdated: first["outdated"].as_bool().unwrap_or(false),
            can_resolve: permissions::gitlab_thread_resolution(
                can_create_note,
                v["resolvable"].as_bool() == Some(true)
                    && first["resolvable"].as_bool() == Some(true),
            ),
            diff_hunk: optional(first, "diff_hunk"),
            comments,
        });
    } else {
        for note in regular {
            items.push(TimelineItem::Comment {
                id: format!(
                    "nt:{id}:{}",
                    note["id"].as_u64().ok_or_else(|| invalid(op))?
                ),
                author: actor(&note["author"], op)?,
                body: note["body"].as_str().unwrap_or_default().into(),
                created_at: string(note, "created_at", op)?,
                updated_at: optional(note, "updated_at").unwrap_or(string(note, "created_at", op)?),
                viewer_is_author: note["author"]["username"].as_str() == Some(viewer),
                minimized: false,
                reactions: reactions(&note["award_emoji"], viewer),
            });
        }
    }
    Ok(items)
}

pub(super) fn system_event(body: &str) -> &'static str {
    if body.starts_with("added ~") {
        "labeled"
    } else if body.starts_with("assigned to") {
        "assigned"
    } else if body.starts_with("requested review") {
        "review_requested"
    } else if body.starts_with("closed") {
        "closed"
    } else if body.starts_with("reopened") {
        "reopened"
    } else if body.starts_with("marked this merge request as ready") {
        "ready_for_review"
    } else if body.starts_with("marked this merge request as draft") {
        "converted_to_draft"
    } else if body.starts_with("merged") {
        "merged"
    } else if body.starts_with("changed title") {
        "renamed"
    } else if body
        .strip_prefix("added ")
        .and_then(|v| v.split_once(' '))
        .is_some_and(|(n, rest)| n.parse::<u64>().is_ok() && rest.starts_with("commit"))
    {
        "commits_added"
    } else {
        "unknown"
    }
}

pub(super) fn synthetic_reviews(
    approvals: &Value,
    reviewers: &Value,
    detail: &Value,
    viewer: &str,
) -> Result<Vec<TimelineItem>, PullRequestsOperationError> {
    let op = "pullRequests.getTimeline";
    let mut items = Vec::new();
    let changed = nodes(reviewers)
        .iter()
        .filter(|r| r["state"].as_str() == Some("requested_changes"))
        .collect::<Vec<_>>();
    for user in nodes(&approvals["approved_by"])
        .iter()
        .map(|u| u.get("user").unwrap_or(u))
        .filter(|u| !changed.iter().any(|r| r["user"]["id"] == u["id"]))
    {
        items.push(synthetic_review(
            user,
            ReviewState::Approved,
            detail,
            viewer,
            op,
        )?);
    }
    for r in changed {
        items.push(synthetic_review(
            &r["user"],
            ReviewState::ChangesRequested,
            detail,
            viewer,
            op,
        )?);
    }
    Ok(items)
}
fn synthetic_review(
    user: &Value,
    state: ReviewState,
    detail: &Value,
    viewer: &str,
    op: &str,
) -> Result<TimelineItem, PullRequestsOperationError> {
    Ok(TimelineItem::Review {
        id: format!("ap:{}", user["id"].as_u64().ok_or_else(|| invalid(op))?),
        author: actor(user, op)?,
        state,
        body: String::new(),
        submitted_at: string(detail, "updated_at", op)?,
        commit_sha: optional(detail, "sha"),
        viewer_is_author: user["username"].as_str() == Some(viewer),
        can_dismiss: false,
    })
}

pub(super) fn resource_event(
    v: &Value,
    kind: &str,
) -> Result<TimelineItem, PullRequestsOperationError> {
    let op = "pullRequests.getTimeline";
    let (event, detail) = match kind {
        "label" => (
            if v["action"].as_str() == Some("remove") {
                "unlabeled"
            } else {
                "labeled"
            },
            optional(&v["label"], "name"),
        ),
        "milestone" => (
            if v["action"].as_str() == Some("remove") {
                "demilestoned"
            } else {
                "milestoned"
            },
            optional(&v["milestone"], "title"),
        ),
        _ => (
            match v["state"].as_str() {
                Some("closed") => "closed",
                Some("reopened" | "opened") => "reopened",
                Some("merged") => "merged",
                _ => "unknown",
            },
            optional(v, "state"),
        ),
    };
    Ok(TimelineItem::Event {
        id: format!("ev:{kind}:{}", v["id"].as_u64().ok_or_else(|| invalid(op))?),
        actor: (!v["user"].is_null())
            .then(|| actor(&v["user"], op))
            .transpose()?,
        event: event.into(),
        detail,
        created_at: string(v, "created_at", op)?,
    })
}

pub(super) fn commits(v: &Value) -> Result<Commits, PullRequestsOperationError> {
    let op = "pullRequests.getCommits";
    let values = v.as_array().ok_or_else(|| invalid(op))?;
    let commits = values
        .iter()
        .map(|v| {
            let sha = string(v, "id", op)?;
            let title = v["title"].as_str().unwrap_or_default();
            let message = v["message"].as_str().unwrap_or_default();
            let body = message
                .strip_prefix(title)
                .unwrap_or(message)
                .trim_start_matches(['\n', '\r']);
            Ok(Commit {
                short_sha: optional(v, "short_id").unwrap_or_else(|| sha.chars().take(7).collect()),
                sha,
                subject: title.into(),
                body: (!body.is_empty()).then(|| body.into()),
                author: Actor {
                    login: string(v, "author_name", op)?,
                    name: None,
                    is_bot: false,
                },
                authored_at: string(v, "authored_date", op)?,
                url: string(v, "web_url", op)?,
            })
        })
        .collect::<Result<_, PullRequestsOperationError>>()?;
    Ok(Commits { commits })
}

pub(super) fn checks(v: &Value, pipeline: &Value) -> Result<Checks, PullRequestsOperationError> {
    use crate::pull_requests::read;
    let op = "pullRequests.getChecks";
    let values = v.as_array().ok_or_else(|| invalid(op))?;
    let rows = values
        .iter()
        .map(|v| {
            let started_at = optional(v, "started_at");
            let completed_at = optional(v, "finished_at");
            let duration_seconds = v["duration"]
                .as_f64()
                .filter(|n| *n >= 0.0)
                .or_else(|| read::duration(started_at.as_deref(), completed_at.as_deref()));
            let state = match v["status"].as_str() {
                Some("success") => CheckState::Success,
                Some("failed") => CheckState::Failure,
                Some("canceled") => CheckState::Cancelled,
                Some("skipped" | "manual") => CheckState::Skipped,
                _ => CheckState::Pending,
            };
            Ok((
                optional(v, "stage").unwrap_or_else(|| "Jobs".into()),
                Check {
                    name: string(v, "name", op)?,
                    state,
                    url: optional(v, "web_url"),
                    started_at,
                    completed_at,
                    duration_seconds,
                },
            ))
        })
        .collect::<Result<Vec<_>, PullRequestsOperationError>>()?;
    Ok(read::grouped_checks(rows, optional(pipeline, "web_url")))
}

pub(super) fn diff_refs(versions: &Value) -> Result<DiffRefs, PullRequestsOperationError> {
    let op = "pullRequests.getFiles";
    let v = &versions[0];
    Ok(DiffRefs {
        base_sha: string(v, "base_commit_sha", op)?,
        start_sha: string(v, "start_commit_sha", op)?,
        head_sha: string(v, "head_commit_sha", op)?,
    })
}

pub(super) fn file(v: &Value) -> Result<File, PullRequestsOperationError> {
    use crate::pull_requests::read;
    let op = "pullRequests.getFiles";
    let old = string(v, "old_path", op)?;
    let path = string(v, "new_path", op)?;
    let diff = v["diff"].as_str().unwrap_or_default();
    let too_large =
        v["too_large"].as_bool().unwrap_or(false) || v["collapsed"].as_bool().unwrap_or(false);
    let change_type = if v["binary"].as_bool() == Some(true) {
        ChangeType::Binary
    } else if v["new_file"].as_bool() == Some(true) {
        ChangeType::Added
    } else if v["renamed_file"].as_bool() == Some(true) {
        ChangeType::Renamed
    } else if v["deleted_file"].as_bool() == Some(true) {
        ChangeType::Removed
    } else {
        ChangeType::Modified
    };
    let additions = v["additions"].as_u64().unwrap_or_else(|| {
        diff.lines()
            .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
            .count() as u64
    });
    let deletions = v["deletions"].as_u64().unwrap_or_else(|| {
        diff.lines()
            .filter(|l| l.starts_with('-') && !l.starts_with("---"))
            .count() as u64
    });
    let mut file = File {
        previous_path: (old != path).then_some(old.clone()),
        path: path.clone(),
        change_type,
        additions,
        deletions,
        patch: None,
        too_large,
    };
    if !too_large && change_type != ChangeType::Binary {
        read::set_patch(&mut file, format!("--- a/{old}\n+++ b/{path}\n{diff}"));
    }
    Ok(file)
}

/// Convert the GraphQL host envelope into the same note observations consumed by
/// the existing wire normalizer. Note is a GitLab STI hierarchy (DiffNote,
/// DiscussionNote, LegacyDiffNote); other GlobalID kinds remain exact so
/// mutation ids retain the REST discussion hash and numeric note id verbatim.
pub(super) fn graphql_discussion(v: &Value) -> Result<(Value, bool), PullRequestsOperationError> {
    use serde_json::json;
    let op = "pullRequests.getTimeline";
    let id = graphql_id(v, "Discussion", op)?;
    let (raw_notes, mut truncated) = graphql_nodes(&v["notes"], op)?;
    let notes = raw_notes.iter().map(|note| {
        let id = graphql_id(note, "Note", op)?.parse::<u64>().map_err(|_| invalid(op))?;
        let system = note["system"].as_bool().ok_or_else(|| invalid(op))?;
        let (awards, more) = if note["awardEmoji"].is_null() { (&[][..], false) }
            else { graphql_nodes(&note["awardEmoji"], op)? };
        truncated |= more;
        let position = &note["position"];
        let position = if position.is_null() { Value::Null } else {
            let path = optional(position, "newPath").or_else(|| optional(position, "oldPath"))
                .or_else(|| optional(position, "filePath")).ok_or_else(|| invalid(op))?;
            json!({"new_path":path,"old_path":position["oldPath"],"new_line":position["newLine"],"old_line":position["oldLine"]})
        };
        let author = if note["author"].is_null() && !system {
            json!({"username":"ghost","name":null})
        } else { note["author"].clone() };
        Ok(json!({"id":id,"body":note["body"],"system":system,"resolvable":note["resolvable"],"resolved":note["resolved"],
            "created_at":note["createdAt"],"updated_at":note["updatedAt"],"author":author,"position":position,
            "award_emoji":awards}))
    }).collect::<Result<Vec<_>, PullRequestsOperationError>>()?;
    Ok((
        json!({"id":id,"resolvable":v["resolvable"],"resolved":v["resolved"],"notes":notes}),
        truncated,
    ))
}

fn graphql_id(v: &Value, kind: &str, op: &str) -> Result<String, PullRequestsOperationError> {
    let value = string(v, "id", op)?;
    let (actual_kind, id) = value
        .strip_prefix("gid://gitlab/")
        .and_then(|value| value.split_once('/'))
        .ok_or_else(|| invalid(op))?;
    let matches = actual_kind == kind || (kind == "Note" && actual_kind.ends_with("Note"));
    if !matches || id.is_empty() || id.contains(['/', ':']) {
        return Err(invalid(op));
    }
    Ok(id.to_owned())
}

fn graphql_nodes<'a>(
    v: &'a Value,
    op: &str,
) -> Result<(&'a [Value], bool), PullRequestsOperationError> {
    let rows = v["nodes"].as_array().ok_or_else(|| invalid(op))?;
    let more = v["pageInfo"]["hasNextPage"]
        .as_bool()
        .ok_or_else(|| invalid(op))?;
    Ok((&rows[..rows.len().min(100)], more || rows.len() > 100))
}

pub(super) enum ActionId<'a> {
    Note { discussion: &'a str, note: u64 },
    Discussion(&'a str),
}

pub(super) fn action_id(value: &str) -> Result<ActionId<'_>, PullRequestsOperationError> {
    use crate::pull_requests::action::{invalid_request, numeric_id};
    let mut parts = value.split(':');
    let kind = parts.next().unwrap_or_default();
    let discussion = parts.next().unwrap_or_default();
    if discussion.is_empty()
        || !discussion
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid_request());
    }
    match (kind, parts.next(), parts.next()) {
        ("nt", Some(note), None) => Ok(ActionId::Note {
            discussion,
            note: numeric_id(note)?,
        }),
        ("ds", None, None) => Ok(ActionId::Discussion(discussion)),
        _ => Err(invalid_request()),
    }
}

pub(super) fn reaction_name(content: ReactionContent) -> &'static str {
    match content {
        ReactionContent::ThumbsUp => "thumbsup",
        ReactionContent::ThumbsDown => "thumbsdown",
        ReactionContent::Laugh => "laughing",
        ReactionContent::Confused => "confused",
        ReactionContent::Heart => "heart",
        ReactionContent::Hooray => "tada",
        ReactionContent::Rocket => "rocket",
        ReactionContent::Eyes => "eyes",
    }
}

#[cfg(test)]
mod mapping_tests {
    use super::*;
    #[test]
    fn pull_requests_gitlab_note_global_ids_accept_note_subclasses_only() {
        for kind in [
            "Note",
            "DiffNote",
            "DiscussionNote",
            "LegacyDiffNote",
            "NewNote",
            "Notes::DiffNote",
        ] {
            let id = graphql_id(
                &serde_json::json!({"id":format!("gid://gitlab/{kind}/4042")}),
                "Note",
                "pullRequests.getTimeline",
            )
            .unwrap();
            assert_eq!(id, "4042");
            assert!(matches!(
                action_id(&format!("nt:discussion-hash:{id}")).unwrap(),
                ActionId::Note { note: 4042, .. }
            ));
        }
        for id in [
            "gid://gitlab/User/4042",
            "gid://gitlab/Noteworthy/4042",
            "gid://other/Note/4042",
            "gid://gitlab/Note/4042/extra",
            "gid://gitlab/Note/",
        ] {
            assert!(
                graphql_id(
                    &serde_json::json!({"id":id}),
                    "Note",
                    "pullRequests.getTimeline"
                )
                .is_err(),
                "{id}"
            );
        }
        // Discussions retain their opaque REST hash and do not share the Note hierarchy.
        assert_eq!(
            graphql_id(
                &serde_json::json!({"id":"gid://gitlab/Discussion/hash-123"}),
                "Discussion",
                "pullRequests.getTimeline"
            )
            .unwrap(),
            "hash-123"
        );
        assert!(
            graphql_id(
                &serde_json::json!({"id":"gid://gitlab/DiffNote/4042"}),
                "Discussion",
                "pullRequests.getTimeline"
            )
            .is_err()
        );
    }

    #[test]
    fn pull_requests_gitlab_reviewer_states_match_contract_and_unknown_is_unreviewed() {
        for (raw, state) in [
            ("unreviewed", ReviewerState::Unreviewed),
            ("reviewed", ReviewerState::Commented),
            ("approved", ReviewerState::Approved),
            ("requested_changes", ReviewerState::ChangesRequested),
            ("unapproved", ReviewerState::Commented),
            ("review_started", ReviewerState::ReviewStarted),
            ("future_state", ReviewerState::Unreviewed),
        ] {
            assert_eq!(reviewer_state(raw), state, "{raw}");
        }
    }
    #[test]
    fn pull_requests_gitlab_system_event_prefixes_preserve_commits_added() {
        for (body, event) in [
            ("added ~label", "labeled"),
            ("assigned to @viewer", "assigned"),
            ("requested review from @viewer", "review_requested"),
            ("closed", "closed"),
            ("reopened", "reopened"),
            ("marked this merge request as ready", "ready_for_review"),
            ("marked this merge request as draft", "converted_to_draft"),
            ("merged", "merged"),
            ("changed title from X to Y", "renamed"),
            ("added 3 commits", "commits_added"),
            ("added 1 commit", "commits_added"),
            ("future event", "unknown"),
        ] {
            assert_eq!(system_event(body), event, "{body}");
        }
    }
}
