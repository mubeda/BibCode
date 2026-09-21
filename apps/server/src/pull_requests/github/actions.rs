use super::*;
use crate::pull_requests::{
    action::{self, OP},
    permissions::reasons,
};

impl GitHubHost {
    async fn mutation_output(
        &self,
        scope: &HostScope,
        method: &str,
        path: &str,
        body: Option<Value>,
        c: &CancellationToken,
    ) -> Result<(), ProcessFailure> {
        let input = body.map(|body| body.to_string().into_bytes());
        let mut args = vec!["api", "--method", method, path];
        if input.is_some() {
            args.extend(["--input", "-"]);
        }
        self.runner
            .gh(scope, &args, Budget::Mutation, input.as_deref(), c)
            .await
            .map(|_| ())
    }

    async fn mutate_api(
        &self,
        scope: &HostScope,
        method: &str,
        path: &str,
        body: Option<Value>,
        c: &CancellationToken,
    ) -> Result<(), PullRequestsOperationError> {
        self.mutation_output(scope, method, path, body, c)
            .await
            .map_err(|f| from_process_error(OP, "gh", &f.error, &f.stderr))
    }

    async fn action_graphql(
        &self,
        scope: &HostScope,
        document: &str,
        variables: Value,
        field: &str,
        c: &CancellationToken,
    ) -> Result<Value, PullRequestsOperationError> {
        let input = serde_json::to_vec(&json!({"query":document,"variables":variables}))
            .map_err(|_| parse::invalid(OP))?;
        let output = self
            .runner
            .gh(
                scope,
                &["api", "graphql", "--input", "-"],
                Budget::Mutation,
                Some(&input),
                c,
            )
            .await
            .map_err(|f| from_process_error(OP, "gh", &f.error, &f.stderr))?;
        let value: Value = serde_json::from_str(&output.stdout).map_err(|_| parse::invalid(OP))?;
        Ok(action::graphql_payload(&value, field)?.clone())
    }

    pub(super) async fn review_action(
        &self,
        scope: &HostScope,
        request: &ActionRequest,
        c: &CancellationToken,
    ) -> Result<ActionResult, PullRequestsOperationError> {
        if !request.is_review_action() {
            return self.edit_action(scope, request, c).await;
        }
        use ActionRequest::*;
        let number = request.target().number;
        let repo = format!("repos/{}", scope.repository);
        match request {
            Comment { body, .. } => {
                self.runner
                    .gh(
                        scope,
                        &["pr", "comment", &number.to_string(), "--body-file", "-"],
                        Budget::Mutation,
                        Some(body.as_bytes()),
                        c,
                    )
                    .await
                    .map_err(|f| from_process_error(OP, "gh", &f.error, &f.stderr))?;
            }
            EditComment {
                comment_id, body, ..
            } => {
                let path = comment_path(&repo, comment_id)?;
                self.mutate_api(scope, "PATCH", &path, Some(json!({"body":body})), c)
                    .await?;
            }
            DeleteComment { comment_id, .. } => {
                let path = comment_path(&repo, comment_id)?;
                self.mutate_api(scope, "DELETE", &path, None, c).await?;
            }
            MinimizeComment {
                comment_id,
                minimized,
                ..
            } => {
                let id = parse::action_id(comment_id)?;
                if !matches!(id.kind, "ic" | "rc") {
                    return Err(action::invalid_request());
                }
                let (document, field) = if *minimized {
                    (graphql::MINIMIZE_COMMENT, "minimizeComment")
                } else {
                    (graphql::UNMINIMIZE_COMMENT, "unminimizeComment")
                };
                self.action_graphql(scope, document, json!({"subjectId":id.node_id}), field, c)
                    .await?;
            }
            React {
                target_id,
                content,
                on,
                ..
            } => {
                let path = match target_id {
                    None => format!("{repo}/issues/{number}"),
                    Some(id) => comment_path(&repo, id)?,
                };
                self.react(scope, &path, *content, *on, c).await?;
            }
            ReplyThread {
                thread_id, body, ..
            } => {
                let id = parse::action_id(thread_id)?;
                if id.kind != "th" {
                    return Err(action::invalid_request());
                }
                self.mutate_api(
                    scope,
                    "POST",
                    &format!("{repo}/pulls/{number}/comments/{}/replies", id.database_id),
                    Some(json!({"body":body})),
                    c,
                )
                .await?;
            }
            ResolveThread {
                thread_id,
                resolved,
                ..
            } => {
                let id = parse::action_id(thread_id)?;
                if id.kind != "th" {
                    return Err(action::invalid_request());
                }
                let state = self
                    .action_graphql(
                        scope,
                        graphql::REVIEW_THREAD_STATE,
                        json!({"id":id.node_id}),
                        "node",
                        c,
                    )
                    .await?;
                let current = state["isResolved"]
                    .as_bool()
                    .ok_or_else(|| parse::invalid(OP))?;
                if current != *resolved {
                    let (document, field) = if *resolved {
                        (graphql::RESOLVE_REVIEW_THREAD, "resolveReviewThread")
                    } else {
                        (graphql::UNRESOLVE_REVIEW_THREAD, "unresolveReviewThread")
                    };
                    self.action_graphql(scope, document, json!({"threadId":id.node_id}), field, c)
                        .await?;
                }
            }
            SubmitReview {
                event,
                body,
                head_sha,
                comments,
                ..
            } => {
                if body.as_deref().is_none_or(|body| body.trim().is_empty())
                    && (*event == ReviewEvent::RequestChanges
                        || (*event == ReviewEvent::Comment && comments.is_empty()))
                {
                    let mut error = PullRequestsOperationError::new(OP, "host_rejected");
                    error.message = if *event == ReviewEvent::RequestChanges {
                        "A comment is required when requesting changes."
                    } else {
                        "Write a review summary or add an inline comment."
                    }
                    .into();
                    return Err(error);
                }
                let mut inline = Vec::with_capacity(comments.len());
                for comment in comments {
                    let side = match comment.side {
                        DiffSide::Left => "LEFT",
                        DiffSide::Right => "RIGHT",
                    };
                    let mut value = json!({"path":comment.path,"line":comment.line,"side":side,"body":comment.body});
                    if let Some(start) = comment.start_line {
                        value["start_line"] = json!(start);
                        value["start_side"] = json!(side);
                    }
                    inline.push(value);
                }
                let event = match event {
                    ReviewEvent::Approve => "APPROVE",
                    ReviewEvent::RequestChanges => "REQUEST_CHANGES",
                    ReviewEvent::Comment => "COMMENT",
                };
                let body = json!({"commit_id":head_sha,"event":event,"body":body.as_deref().unwrap_or_default(),"comments":inline});
                match self
                    .mutation_output(
                        scope,
                        "POST",
                        &format!("{repo}/pulls/{number}/reviews"),
                        Some(body),
                        c,
                    )
                    .await
                {
                    Ok(()) => {
                        return Ok(ActionResult::ReviewSubmitted {
                            review_posted: true,
                            landed: comments.len() as u32,
                            failed: vec![],
                        });
                    }
                    Err(failure) => {
                        let comment_rejected = !comments.is_empty()
                            && failure.stderr.contains("422")
                            && (failure.stderr.contains("Pull request review comment")
                                || failure.stderr.contains("position"));
                        let error = from_process_error(OP, "gh", &failure.error, &failure.stderr);
                        if comment_rejected {
                            return Ok(ActionResult::ReviewSubmitted {
                                review_posted: false,
                                landed: 0,
                                failed: comments
                                    .iter()
                                    .map(|comment| action::failed_comment(comment, &error))
                                    .collect(),
                            });
                        }
                        return Err(error);
                    }
                }
            }
            DismissReview {
                review_id, message, ..
            } => {
                let id = parse::action_id(review_id)?;
                if id.kind != "rv" {
                    return Err(action::invalid_request());
                }
                self.mutate_api(
                    scope,
                    "PUT",
                    &format!(
                        "{repo}/pulls/{number}/reviews/{}/dismissals",
                        id.database_id
                    ),
                    Some(json!({"message":message})),
                    c,
                )
                .await?;
            }
            RerequestReview { login, .. } => {
                if login.trim().is_empty()
                    || login.starts_with('-')
                    || login.chars().any(char::is_control)
                {
                    return Err(action::invalid_request());
                }
                self.runner
                    .gh(
                        scope,
                        &["pr", "edit", &number.to_string(), "--add-reviewer", login],
                        Budget::Mutation,
                        None,
                        c,
                    )
                    .await
                    .map_err(|f| from_process_error(OP, "gh", &f.error, &f.stderr))?;
            }
            RevokeApproval { .. } | RemoveOwnChangeRequest { .. } => {
                return Err(action::unavailable(reasons::GH_REVOKE));
            }
            ApplySuggestions { .. } => return Err(action::unavailable(reasons::GH_SUGGESTION)),
            _ => return Err(PullRequestsOperationError::new(OP, "unavailable")),
        }
        Ok(ActionResult::Done)
    }

    async fn edit_action(
        &self,
        scope: &HostScope,
        request: &ActionRequest,
        c: &CancellationToken,
    ) -> Result<ActionResult, PullRequestsOperationError> {
        use ActionRequest::*;
        let command = match request {
            EditPullRequest { .. }
            | SetReviewers { .. }
            | SetAssignees { .. }
            | SetLabels { .. }
            | SetMilestone { .. } => "edit",
            Lock { .. } => "lock",
            Unlock { .. } => "unlock",
            UpdateBranch { .. } => "update-branch",
            Merge { .. } | DisableAutoMerge { .. } => "merge",
            SetDraft { .. } => "ready",
            Close { .. } => "close",
            Reopen { .. } => "reopen",
            Revert { .. } => "revert",
            Delete { .. } => return Err(action::unavailable(reasons::GH_DELETE)),
            _ => return Err(action::invalid_request()),
        };
        let mut args = vec![
            "pr".to_owned(),
            command.into(),
            request.target().number.to_string(),
        ];
        let mut stdin = None;
        match request {
            EditPullRequest {
                title,
                body,
                base_branch,
                ..
            } => {
                if let Some(title) = title {
                    args.extend(["--title".into(), title.clone()]);
                }
                if let Some(body) = body {
                    args.extend(["--body-file".into(), "-".into()]);
                    stdin = Some(body.as_bytes());
                }
                if let Some(base) = base_branch {
                    args.extend(["--base".into(), base.clone()]);
                }
            }
            SetReviewers { add, remove, .. }
            | SetAssignees { add, remove, .. }
            | SetLabels { add, remove, .. } => {
                let field = match request {
                    SetReviewers { .. } => "reviewer",
                    SetAssignees { .. } => "assignee",
                    _ => "label",
                };
                if !add.is_empty() {
                    args.extend([format!("--add-{field}"), add.join(",")]);
                }
                if !remove.is_empty() {
                    args.extend([format!("--remove-{field}"), remove.join(",")]);
                }
            }
            SetMilestone { milestone_id, .. } => {
                if let Some(id) = milestone_id {
                    let number = action::numeric_id(id)?;
                    let milestone = self
                        .api(
                            scope,
                            &format!("repos/{}/milestones/{number}", scope.repository),
                            OP,
                            c,
                        )
                        .await?;
                    args.extend([
                        "--milestone".into(),
                        parse::string(&milestone, "title", OP)?,
                    ]);
                } else {
                    args.push("--remove-milestone".into());
                }
            }
            Lock {
                reason: Some(reason),
                ..
            } => args.extend(["--reason".into(), reason.clone()]),
            UpdateBranch {
                method: UpdateBranchMethod::Rebase,
                ..
            } => args.push("--rebase".into()),
            Merge {
                method,
                head_sha,
                delete_branch,
                auto,
                bypass,
                subject,
                body,
                ..
            } => {
                if *auto && *bypass {
                    let mut error = PullRequestsOperationError::new(OP, "invalid_request");
                    error.message = "Auto-merge and bypass cannot be combined on GitHub.".into();
                    return Err(error);
                }
                args.push(
                    match method {
                        MergeMethod::Merge => "--merge",
                        MergeMethod::Squash => "--squash",
                        MergeMethod::Rebase => "--rebase",
                    }
                    .into(),
                );
                args.extend(["--match-head-commit".into(), head_sha.clone()]);
                if *delete_branch {
                    args.push("--delete-branch".into());
                }
                if *auto {
                    args.push("--auto".into());
                }
                if *bypass {
                    args.push("--admin".into());
                }
                if let Some(subject) = subject {
                    args.extend(["--subject".into(), subject.clone()]);
                }
                if let Some(body) = body {
                    args.extend(["--body-file".into(), "-".into()]);
                    stdin = Some(body.as_bytes());
                }
            }
            DisableAutoMerge { .. } => args.push("--disable-auto".into()),
            SetDraft { draft: true, .. } => args.push("--undo".into()),
            _ => {}
        }
        // Bare `pr edit` is interactive; an empty metadata change is a no-op.
        if command == "edit" && args.len() == 3 {
            return Ok(ActionResult::Done);
        }
        let output = self
            .runner
            .gh(scope, &args, Budget::Mutation, stdin, c)
            .await
            .map_err(|f| from_process_error(OP, "gh", &f.error, &f.stderr))?;
        match request {
            Merge { auto, .. } => Ok(ActionResult::Merged {
                merged_sha: None,
                auto_merge_enabled: *auto,
            }),
            Revert { .. } => {
                let (number, url) = crate::source_control::parse_github_create_url(&output.stdout)
                    .ok_or_else(|| parse::invalid(OP))?;
                Ok(ActionResult::PullRequestCreated { number, url })
            }
            _ => Ok(ActionResult::Done),
        }
    }

    async fn react(
        &self,
        scope: &HostScope,
        target: &str,
        content: ReactionContent,
        on: bool,
        c: &CancellationToken,
    ) -> Result<(), PullRequestsOperationError> {
        let user = self.api(scope, "user", OP, c).await?;
        let viewer = parse::string(&user, "login", OP)?;
        let content_value = json!(content);
        let content = content_value.as_str().ok_or_else(|| parse::invalid(OP))?;
        let query_content = if content == "+1" { "%2B1" } else { content };
        let path = format!("{target}/reactions");
        let mut own = None;
        for page in 1..=10 {
            let suffix = if page == 1 {
                String::new()
            } else {
                format!("&page={page}")
            };
            let reactions = self
                .api(
                    scope,
                    &format!("{path}?content={query_content}&per_page=100{suffix}"),
                    OP,
                    c,
                )
                .await?;
            let reactions = reactions.as_array().ok_or_else(|| parse::invalid(OP))?;
            if let Some(reaction) = reactions.iter().find(|r| {
                r["user"]["login"].as_str() == Some(&viewer)
                    && r["content"].as_str() == Some(content)
            }) {
                own = Some(
                    reaction["id"]
                        .as_u64()
                        .filter(|n| *n > 0)
                        .ok_or_else(|| parse::invalid(OP))?,
                );
                break;
            }
            if reactions.len() < 100 {
                break;
            }
            if page == 10 {
                return Err(PullRequestsOperationError::new(OP, "output_limit"));
            }
        }
        match (on, own) {
            (true, None) => {
                self.mutate_api(scope, "POST", &path, Some(json!({"content":content})), c)
                    .await
            }
            (false, Some(id)) => {
                self.mutate_api(scope, "DELETE", &format!("{path}/{id}"), None, c)
                    .await
            }
            _ => Ok(()),
        }
    }
}

fn comment_path(repo: &str, value: &str) -> Result<String, PullRequestsOperationError> {
    let id = parse::action_id(value)?;
    let kind = match id.kind {
        "ic" => "issues",
        "rc" => "pulls",
        _ => return Err(action::invalid_request()),
    };
    Ok(format!("{repo}/{kind}/comments/{}", id.database_id))
}
