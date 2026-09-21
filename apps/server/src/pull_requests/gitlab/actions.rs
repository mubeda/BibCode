use super::*;
use crate::pull_requests::{
    action::{self, OP},
    permissions::reasons,
};

impl GitLabHost {
    pub(super) async fn edit_action(
        &self,
        scope: &HostScope,
        request: &ActionRequest,
        context: &ActionContext,
        c: &CancellationToken,
    ) -> Result<ActionResult, PullRequestsOperationError> {
        use ActionRequest::*;
        let number = request.target().number.to_string();
        let path = format!("{}/merge_requests/{number}", project_path(scope));
        let mut body = json!({});
        let mut args = vec!["mr", "", &number];
        match request {
            EditPullRequest {
                title,
                body: description,
                base_branch,
                ..
            } => {
                if let Some(title) = title {
                    body["title"] = json!(title);
                }
                if let Some(description) = description {
                    body["description"] = json!(description);
                }
                if let Some(base) = base_branch {
                    body["target_branch"] = json!(base);
                }
            }
            SetReviewers { add, remove, .. } | SetAssignees { add, remove, .. } => {
                if add.is_empty() && remove.is_empty() {
                    return Ok(ActionResult::Done);
                }
                let reviewers = matches!(request, SetReviewers { .. });
                let current = if reviewers {
                    &context.reviewers
                } else {
                    &context.assignees
                };
                let ids = self.user_ids(scope, current, add, remove, c).await?;
                body[if reviewers {
                    "reviewer_ids"
                } else {
                    "assignee_ids"
                }] = json!(ids);
            }
            SetLabels { add, remove, .. } => {
                if add.is_empty() && remove.is_empty() {
                    return Ok(ActionResult::Done);
                }
                body = json!({"add_labels":add.join(","),"remove_labels":remove.join(",")});
            }
            SetMilestone { milestone_id, .. } => {
                body["milestone_id"] = json!(
                    milestone_id
                        .as_deref()
                        .map(action::numeric_id)
                        .transpose()?
                        .unwrap_or(0)
                );
            }
            Lock { .. } | Unlock { .. } => {
                body["discussion_locked"] = json!(matches!(request, Lock { .. }))
            }
            UpdateBranch { skip_ci, .. } => {
                args[1] = "rebase";
                if *skip_ci {
                    args.push("--skip-ci");
                }
            }
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
                if *bypass {
                    self.action_graphql(
                        scope,
                        &graphql::override_requested_changes(
                            &scope.repository,
                            request.target().number,
                        ),
                        "mergeRequestUpdate",
                        c,
                    )
                    .await?;
                }
                let result = async {
                    let merged_sha = if subject.is_some() || body.is_some() {
                        let message = match (subject.as_deref(), body.as_deref()) {
                            (Some(subject), Some(body)) if !subject.is_empty() && !body.is_empty() => format!("{subject}\n\n{body}"),
                            (Some(subject), _) if !subject.is_empty() => subject.into(),
                            (_, body) => body.unwrap_or_default().into(),
                        };
                        // GitLab 17.11 renamed this option; retain both names for older hosts.
                        let output = self.runner.glab_api_with_body(scope, "PUT", &format!("{path}/merge"), &json!({
                            "sha":head_sha,"squash":*method==MergeMethod::Squash,
                            "should_remove_source_branch":delete_branch,"auto_merge":auto,"merge_when_pipeline_succeeds":auto,
                            "merge_commit_message":message,"squash_commit_message":message,
                        }), c).await.map_err(|f| from_process_error(OP, "glab", &f.error, &f.stderr))?;
                        let value: Value = serde_json::from_str(&output.stdout).map_err(|_| parse::invalid(OP))?;
                        if !value.is_object() { return Err(parse::invalid(OP)); }
                        value.get("merge_commit_sha").filter(|sha| !sha.is_null())
                            .map(|_| parse::string(&value, "merge_commit_sha", OP)).transpose()?
                    } else {
                        args[1] = "merge";
                        args.extend(["--sha", head_sha, "-y"]);
                        if *method == MergeMethod::Squash { args.push("--squash"); }
                        if *delete_branch { args.push("--remove-source-branch"); }
                        args.push(if *auto { "--auto-merge" } else { "--auto-merge=false" });
                        if *method == MergeMethod::Rebase { args.push("--rebase"); }
                        self.runner.glab(scope, &args, Budget::Mutation, None, c).await
                            .map_err(|f| from_process_error(OP, "glab", &f.error, &f.stderr))?;
                        None
                    };
                    Ok(ActionResult::Merged { merged_sha, auto_merge_enabled: *auto })
                }.await;
                return result.map_err(|error| {
                    if *bypass {
                        partial_action(
                            error,
                            "Requested changes were overridden, but merging failed.",
                        )
                    } else {
                        error
                    }
                });
            }
            DisableAutoMerge { .. } => {
                self.mutate_api(
                    scope,
                    "POST",
                    &format!("{path}/cancel_merge_when_pipeline_succeeds"),
                    None,
                    c,
                )
                .await?;
                return Ok(ActionResult::Done);
            }
            SetDraft { draft, .. } => {
                args[1] = "update";
                args.push(if *draft { "--draft" } else { "--ready" });
            }
            Close { .. } => args[1] = "close",
            Reopen { .. } => args[1] = "reopen",
            Delete { .. } => args[1] = "delete",
            Revert { .. } => {
                return self
                    .revert(scope, request.target().number, context, c)
                    .await;
            }
            _ => return Err(action::invalid_request()),
        }
        if args[1].is_empty() {
            if body.as_object().is_some_and(|body| !body.is_empty()) {
                self.mutate_api(scope, "PUT", &path, Some(body), c).await?;
            }
        } else {
            self.runner
                .glab(scope, &args, Budget::Mutation, None, c)
                .await
                .map_err(|f| from_process_error(OP, "glab", &f.error, &f.stderr))?;
        }
        Ok(if matches!(request, Delete { .. }) {
            ActionResult::Deleted
        } else {
            ActionResult::Done
        })
    }

    async fn user_ids(
        &self,
        scope: &HostScope,
        current: &[String],
        add: &[String],
        remove: &[String],
        c: &CancellationToken,
    ) -> Result<Vec<u64>, PullRequestsOperationError> {
        let removed: std::collections::HashSet<_> = remove.iter().collect();
        let mut seen = std::collections::HashSet::new();
        let mut ids = Vec::new();
        // Resolve each retained login once per action, preserving host order.
        for login in current.iter().chain(add) {
            if removed.contains(login) || !seen.insert(login) {
                continue;
            }
            let users = self
                .api(scope, &format!("users?username={}", encoded(login)), OP, c)
                .await?;
            let user = users
                .as_array()
                .ok_or_else(|| parse::invalid(OP))?
                .iter()
                .find(|user| user["username"].as_str() == Some(login))
                .ok_or_else(|| PullRequestsOperationError::new(OP, "not_found"))?;
            let id = user["id"]
                .as_u64()
                .filter(|id| *id > 0)
                .ok_or_else(|| parse::invalid(OP))?;
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    async fn revert(
        &self,
        scope: &HostScope,
        number: u64,
        context: &ActionContext,
        c: &CancellationToken,
    ) -> Result<ActionResult, PullRequestsOperationError> {
        let sha = context
            .merge_commit_sha
            .as_deref()
            .filter(|sha| sha.len() >= 8 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| parse::invalid(OP))?;
        let branch = format!("revert-{number}-{}", &sha[..8]);
        self.mutate_api(
            scope,
            "POST",
            &format!("{}/repository/branches", project_path(scope)),
            Some(json!({"branch":branch,"ref":context.base_branch})),
            c,
        )
        .await?;
        self.mutate_api(
            scope,
            "POST",
            &format!("{}/repository/commits/{sha}/revert", project_path(scope)),
            Some(json!({"branch":branch})),
            c,
        )
        .await
        .map_err(|error| {
            partial_action(
                error,
                "The revert branch was created, but reverting the commit failed.",
            )
        })?;
        let service = crate::source_control::PullRequestService::with_gitlab_create_transport(
            Arc::new(RevertCreateTransport {
                runner: self.runner.clone(),
                scope: scope.clone(),
            }),
        );
        let created = service.create(crate::source_control::CreatePullRequestInput {
            cwd: scope.cwd.clone(), provider: ProviderKind::Gitlab, base_branch: context.base_branch.clone(),
            head_branch: branch, title: format!("Revert \"{}\"", context.title), body: format!("Reverts {}", context.url),
        }, c).await.map_err(|error| {
            let mut failure = PullRequestsOperationError::new(OP, "invalid_response");
            if let Some(command) = error.command_failure {
                failure.code = command.code;
                failure.message = error.detail.into();
                failure.host_detail = command.host_detail;
            }
            partial_action(failure, "The revert branch and commit were created, but creating the merge request failed.")
        })?;
        Ok(ActionResult::PullRequestCreated {
            number: created.number,
            url: created.url,
        })
    }

    async fn mutate_api(
        &self,
        scope: &HostScope,
        method: &str,
        path: &str,
        body: Option<Value>,
        c: &CancellationToken,
    ) -> Result<(), PullRequestsOperationError> {
        let result = if let Some(body) = body {
            self.runner
                .glab_api_with_body(scope, method, path, &body, c)
                .await
        } else {
            self.runner
                .glab(
                    scope,
                    &["api", "--method", method, path],
                    Budget::Mutation,
                    None,
                    c,
                )
                .await
        };
        result.map_err(|f| from_process_error(OP, "glab", &f.error, &f.stderr))?;
        Ok(())
    }

    async fn action_graphql(
        &self,
        scope: &HostScope,
        document: &str,
        field: &str,
        c: &CancellationToken,
    ) -> Result<(), PullRequestsOperationError> {
        let output = self
            .runner
            .glab(
                scope,
                &["api", "graphql", "-f", &format!("query={document}")],
                Budget::Mutation,
                None,
                c,
            )
            .await
            .map_err(|f| from_process_error(OP, "glab", &f.error, &f.stderr))?;
        let value: Value = serde_json::from_str(&output.stdout).map_err(|_| parse::invalid(OP))?;
        let payload = action::graphql_payload(&value, field)?;
        if !payload["errors"].is_array() {
            return Err(parse::invalid(OP));
        }
        Ok(())
    }

    pub(super) async fn review_action(
        &self,
        scope: &HostScope,
        request: &ActionRequest,
        context: &ActionContext,
        c: &CancellationToken,
    ) -> Result<ActionResult, PullRequestsOperationError> {
        use ActionRequest::*;
        let number = request.target().number;
        let path = format!("{}/merge_requests/{number}", project_path(scope));
        match request {
            Comment { body, .. } => {
                self.mutate_api(
                    scope,
                    "POST",
                    &format!("{path}/notes"),
                    Some(json!({"body":body})),
                    c,
                )
                .await?
            }
            EditComment {
                comment_id, body, ..
            } => {
                let endpoint = note_path(&path, comment_id)?;
                self.mutate_api(scope, "PUT", &endpoint, Some(json!({"body":body})), c)
                    .await?;
            }
            DeleteComment { comment_id, .. } => {
                let endpoint = note_path(&path, comment_id)?;
                self.mutate_api(scope, "DELETE", &endpoint, None, c).await?;
            }
            MinimizeComment { .. } => return Err(action::unavailable(reasons::GL_MINIMIZE)),
            DismissReview { .. } => return Err(action::unavailable(reasons::GL_DISMISS)),
            React {
                target_id,
                content,
                on,
                ..
            } => {
                let target = match target_id {
                    None => path,
                    Some(id) => {
                        let parse::ActionId::Note { note, .. } = parse::action_id(id)? else {
                            return Err(action::invalid_request());
                        };
                        format!("{path}/notes/{note}")
                    }
                };
                self.react(
                    scope,
                    &target,
                    *content,
                    *on,
                    context.viewer_login.as_deref(),
                    c,
                )
                .await?;
            }
            ReplyThread {
                thread_id, body, ..
            } => {
                let endpoint = discussion_path(&path, thread_id)?;
                self.mutate_api(
                    scope,
                    "POST",
                    &format!("{endpoint}/notes"),
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
                let endpoint = discussion_path(&path, thread_id)?;
                let discussion = self.api(scope, &endpoint, OP, c).await?;
                let notes = discussion["notes"]
                    .as_array()
                    .ok_or_else(|| parse::invalid(OP))?;
                let notes = notes
                    .iter()
                    .filter(|n| n["resolvable"].as_bool() == Some(true))
                    .collect::<Vec<_>>();
                if notes.is_empty() {
                    let mut error = PullRequestsOperationError::new(OP, "forbidden");
                    error.message = reasons::NO_RESOLVE.into();
                    return Err(error);
                }
                let states = notes
                    .iter()
                    .map(|n| n["resolved"].as_bool().ok_or_else(|| parse::invalid(OP)))
                    .collect::<Result<Vec<_>, _>>()?;
                if !states.iter().all(|state| state == resolved) {
                    self.mutate_api(
                        scope,
                        "PUT",
                        &format!("{endpoint}?resolved={resolved}"),
                        None,
                        c,
                    )
                    .await?;
                }
            }
            SubmitReview { .. } => return self.submit_review(scope, request, c).await,
            RevokeApproval { .. } => {
                self.runner
                    .glab(
                        scope,
                        &["mr", "revoke", &number.to_string()],
                        Budget::Mutation,
                        None,
                        c,
                    )
                    .await
                    .map_err(|f| from_process_error(OP, "glab", &f.error, &f.stderr))?;
            }
            RemoveOwnChangeRequest { .. } => {
                self.action_graphql(
                    scope,
                    &graphql::destroy_requested_changes(&scope.repository, number),
                    "mergeRequestDestroyRequestedChanges",
                    c,
                )
                .await?
            }
            RerequestReview { login, .. } => {
                if login.trim().is_empty() {
                    return Err(action::invalid_request());
                }
                let users = self
                    .api(scope, &format!("users?username={}", encoded(login)), OP, c)
                    .await?;
                let user = users
                    .as_array()
                    .ok_or_else(|| parse::invalid(OP))?
                    .iter()
                    .find(|u| u["username"].as_str() == Some(login))
                    .ok_or_else(|| PullRequestsOperationError::new(OP, "not_found"))?;
                let id = user["id"]
                    .as_u64()
                    .filter(|n| *n > 0)
                    .ok_or_else(|| parse::invalid(OP))?;
                self.action_graphql(
                    scope,
                    &graphql::reviewer_rereview(&scope.repository, number, id),
                    "mergeRequestReviewerRereview",
                    c,
                )
                .await?;
            }
            ApplySuggestions {
                suggestion_ids,
                commit_message,
                ..
            } => {
                if suggestion_ids.is_empty() {
                    return Err(action::invalid_request());
                }
                let ids = suggestion_ids
                    .iter()
                    .map(|id| action::numeric_id(id))
                    .collect::<Result<Vec<_>, _>>()?;
                let mut body = json!({});
                if let Some(message) = commit_message {
                    body["commit_message"] = json!(message);
                }
                let endpoint = if ids.len() == 1 {
                    format!("suggestions/{}/apply", ids[0])
                } else {
                    body["ids"] = json!(ids);
                    "suggestions/batch_apply".into()
                };
                self.mutate_api(scope, "PUT", &endpoint, Some(body), c)
                    .await?;
            }
            _ => return Err(PullRequestsOperationError::new(OP, "unavailable")),
        }
        Ok(ActionResult::Done)
    }

    async fn react(
        &self,
        scope: &HostScope,
        target: &str,
        content: ReactionContent,
        on: bool,
        viewer: Option<&str>,
        c: &CancellationToken,
    ) -> Result<(), PullRequestsOperationError> {
        let loaded;
        let viewer = if let Some(viewer) = viewer {
            viewer
        } else {
            loaded = self.viewer(scope, OP, c).await?;
            &loaded
        };
        let name = parse::reaction_name(content);
        let (awards, truncated) = self.awards(scope, target, OP, c).await?;
        let own = awards
            .as_array()
            .ok_or_else(|| parse::invalid(OP))?
            .iter()
            .find(|a| {
                a["name"].as_str() == Some(name) && a["user"]["username"].as_str() == Some(viewer)
            })
            .map(|a| {
                a["id"]
                    .as_u64()
                    .filter(|n| *n > 0)
                    .ok_or_else(|| parse::invalid(OP))
            })
            .transpose()?;
        if own.is_none() && truncated {
            return Err(PullRequestsOperationError::new(OP, "output_limit"));
        }
        let path = format!("{target}/award_emoji");
        match (on, own) {
            (true, None) => {
                self.mutate_api(scope, "POST", &path, Some(json!({"name":name})), c)
                    .await
            }
            (false, Some(id)) => {
                self.mutate_api(scope, "DELETE", &format!("{path}/{id}"), None, c)
                    .await
            }
            _ => Ok(()),
        }
    }

    async fn submit_review(
        &self,
        scope: &HostScope,
        request: &ActionRequest,
        c: &CancellationToken,
    ) -> Result<ActionResult, PullRequestsOperationError> {
        let ActionRequest::SubmitReview {
            target,
            event,
            body,
            head_sha,
            comments,
        } = request
        else {
            return Err(action::invalid_request());
        };
        let path = format!("{}/merge_requests/{}", project_path(scope), target.number);
        let positions = if comments.is_empty() {
            vec![]
        } else {
            let versions = self.api(scope, &format!("{path}/versions"), OP, c).await?;
            let version = versions
                .as_array()
                .and_then(|v| v.first())
                .ok_or_else(|| parse::invalid(OP))?;
            let refs = DiffRefs {
                base_sha: parse::string(version, "base_commit_sha", OP)?,
                start_sha: parse::string(version, "start_commit_sha", OP)?,
                head_sha: parse::string(version, "head_commit_sha", OP)?,
            };
            if refs.head_sha != *head_sha {
                return Err(PullRequestsOperationError::new(OP, "stale_head"));
            }
            let id = version["id"]
                .as_u64()
                .filter(|id| *id > 0)
                .ok_or_else(|| parse::invalid(OP))?;
            // Pin the diff to the same immutable version as the review SHAs.
            let output = self
                .runner
                .glab(
                    scope,
                    &["api", &format!("{path}/versions/{id}")],
                    Budget::Large,
                    None,
                    c,
                )
                .await
                .map_err(|f| from_process_error(OP, "glab", &f.error, &f.stderr))?;
            let version: Value =
                serde_json::from_str(&output.stdout).map_err(|_| parse::invalid(OP))?;
            if parse::string(&version, "head_commit_sha", OP)? != refs.head_sha
                || parse::string(&version, "base_commit_sha", OP)? != refs.base_sha
                || parse::string(&version, "start_commit_sha", OP)? != refs.start_sha
            {
                return Err(parse::invalid(OP));
            }
            let diffs = version["diffs"]
                .as_array()
                .ok_or_else(|| parse::invalid(OP))?;
            super::review_positions::positions(diffs, &refs, comments)
        };
        let mut landed = 0;
        let mut failed = Vec::new();
        for (comment, position) in comments.iter().zip(positions) {
            let position = match position {
                Ok(position) => position,
                Err(error) => {
                    failed.push(action::failed_comment(comment, &error));
                    continue;
                }
            };
            // sha1 is only transitive, not available to this crate. The approved
            // no-dependency fallback posts a multi-line draft at its end line.
            match self
                .mutate_api(
                    scope,
                    "POST",
                    &format!("{path}/discussions"),
                    Some(json!({"body":comment.body,"position":position})),
                    c,
                )
                .await
            {
                Ok(()) => landed += 1,
                Err(error) if error.code == "timeout" => {
                    return Err(partial_failure(landed, "inline review", error));
                }
                Err(error) => failed.push(action::failed_comment(comment, &error)),
            }
        }
        let mut posted = landed;
        if let Some(body) = body.as_deref().filter(|body| !body.is_empty()) {
            self.mutate_api(
                scope,
                "POST",
                &format!("{path}/notes"),
                Some(json!({"body":body})),
                c,
            )
            .await
            .map_err(|error| partial_failure(posted, "review summary", error))?;
            posted += 1;
        }
        let result = match event {
            ReviewEvent::Approve => self
                .runner
                .glab(
                    scope,
                    &[
                        "mr",
                        "approve",
                        &target.number.to_string(),
                        "--sha",
                        head_sha,
                    ],
                    Budget::Mutation,
                    None,
                    c,
                )
                .await
                .map(|_| ())
                .map_err(|f| from_process_error(OP, "glab", &f.error, &f.stderr)),
            ReviewEvent::RequestChanges => {
                self.action_graphql(
                    scope,
                    &graphql::request_changes(&scope.repository, target.number),
                    "mergeRequestRequestChanges",
                    c,
                )
                .await
            }
            ReviewEvent::Comment => Ok(()),
        };
        result.map_err(|error| {
            partial_failure(
                posted,
                if *event == ReviewEvent::Approve {
                    "approval"
                } else {
                    "request changes"
                },
                error,
            )
        })?;
        Ok(ActionResult::ReviewSubmitted {
            review_posted: true,
            landed,
            failed,
        })
    }
}

fn partial_failure(
    posted: u32,
    stage: &str,
    mut error: PullRequestsOperationError,
) -> PullRequestsOperationError {
    if posted > 0 {
        error.code = "host_rejected";
        error.retryable = false;
        error.message = format!(
            "{posted} comments were posted; {stage} failed: {} Refresh before retrying to avoid duplicates.",
            error.message
        );
    }
    error
}

fn note_path(base: &str, id: &str) -> Result<String, PullRequestsOperationError> {
    let parse::ActionId::Note { discussion, note } = parse::action_id(id)? else {
        return Err(action::invalid_request());
    };
    Ok(format!(
        "{base}/discussions/{}/notes/{note}",
        encoded(discussion)
    ))
}
fn discussion_path(base: &str, id: &str) -> Result<String, PullRequestsOperationError> {
    let parse::ActionId::Discussion(discussion) = parse::action_id(id)? else {
        return Err(action::invalid_request());
    };
    Ok(format!("{base}/discussions/{}", encoded(discussion)))
}

fn partial_action(
    mut error: PullRequestsOperationError,
    progress: &str,
) -> PullRequestsOperationError {
    error.message = format!(
        "{progress} Refresh and inspect the host before retrying. {}",
        error.message
    );
    error.retryable = false;
    error
}

#[derive(Debug)]
struct RevertCreateTransport {
    runner: Arc<HostCommandRunner>,
    scope: HostScope,
}

impl crate::source_control::GitLabCreateTransport for RevertCreateTransport {
    fn create<'a>(
        &'a self,
        body: Value,
        c: &'a CancellationToken,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<String, crate::source_control::SourceControlProviderError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.runner
                .glab_api_with_body(
                    &self.scope,
                    "POST",
                    &format!("{}/merge_requests", project_path(&self.scope)),
                    &body,
                    c,
                )
                .await
                .map(|output| output.stdout)
                .map_err(|failure| {
                    let error = from_process_error(OP, "glab", &failure.error, &failure.stderr);
                    crate::source_control::SourceControlProviderError {
                        tag: "SourceControlProviderError",
                        provider: ProviderKind::Gitlab,
                        operation: "createPullRequest".into(),
                        cwd: self.scope.cwd.to_string_lossy().into_owned().into(),
                        command: Some("glab".into()),
                        reference: None,
                        detail: error.message.into(),
                        command_failure: Some(Box::new(
                            crate::source_control::ProviderCommandFailure {
                                code: error.code,
                                host_detail: error.host_detail,
                            },
                        )),
                    }
                })
        })
    }
}
