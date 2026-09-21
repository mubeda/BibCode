mod actions;
mod files;
mod graphql;
mod parse;
mod timeline;

use std::sync::Arc;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    pull_requests::{
        error::{PullRequestsOperationError, from_process_error},
        host::*,
        model::*,
    },
    source_control::ProviderKind,
};

pub struct GitHubHost {
    runner: Arc<HostCommandRunner>,
}

impl GitHubHost {
    pub fn new(runner: Arc<HostCommandRunner>) -> Self {
        Self { runner }
    }

    async fn api(
        &self,
        scope: &HostScope,
        path: &str,
        operation: &str,
        c: &CancellationToken,
    ) -> Result<Value, PullRequestsOperationError> {
        let output = self
            .runner
            .gh(scope, &["api", path], Budget::Read, None, c)
            .await
            .map_err(|failure| {
                from_process_error(operation, "gh", &failure.error, &failure.stderr)
            })?;
        serde_json::from_str(&output.stdout).map_err(|_| parse::invalid(operation))
    }

    async fn graphql(
        &self,
        scope: &HostScope,
        document: &str,
        variables: Value,
        operation: &str,
        c: &CancellationToken,
    ) -> Result<Value, PullRequestsOperationError> {
        let input = serde_json::to_vec(&json!({"query":document,"variables":variables}))
            .map_err(|_| parse::invalid(operation))?;
        // JSON lists use the 60 s / 1 MiB budget; Large is reserved for patches.
        let budget = if matches!(
            operation,
            "pullRequests.getContext" | "pullRequests.getVocabulary"
        ) {
            Budget::Read
        } else {
            Budget::Mutation
        };
        let output = self
            .runner
            .gh(
                scope,
                &["api", "graphql", "--input", "-"],
                budget,
                Some(&input),
                c,
            )
            .await
            .map_err(|failure| {
                from_process_error(operation, "gh", &failure.error, &failure.stderr)
            })?;
        let value: Value =
            serde_json::from_str(&output.stdout).map_err(|_| parse::invalid(operation))?;
        if value["errors"]
            .as_array()
            .is_some_and(|errors| !errors.is_empty())
        {
            return Err(parse::invalid(operation));
        }
        Ok(value)
    }

    async fn view(
        &self,
        scope: &HostScope,
        number: u64,
        fields: &str,
        operation: &str,
        c: &CancellationToken,
    ) -> Result<Value, PullRequestsOperationError> {
        let output = self
            .runner
            .gh(
                scope,
                &["pr", "view", &number.to_string(), "--json", fields],
                Budget::Mutation,
                None,
                c,
            )
            .await
            .map_err(|failure| {
                from_process_error(operation, "gh", &failure.error, &failure.stderr)
            })?;
        serde_json::from_str(&output.stdout).map_err(|_| parse::invalid(operation))
    }

    async fn search(
        &self,
        scope: &HostScope,
        query: &ListQuery,
        c: &CancellationToken,
    ) -> Result<ListPage, PullRequestsOperationError> {
        let operation = "pullRequests.list";
        let needs_login = [&query.author, &query.assignee, &query.reviewer]
            .iter()
            .any(|value| value.as_deref() == Some("@me"));
        let login = if needs_login {
            Some(parse::string(
                &self.api(scope, "user", operation, c).await?,
                "login",
                operation,
            )?)
        } else {
            None
        };
        let qualifiers = search_qualifiers(query, login.as_deref());
        let state = match query.state {
            ListState::Open => "open",
            ListState::Merged => "merged",
            ListState::Closed | ListState::All => "all",
        };
        let args = [
            "pr",
            "list",
            "--state",
            state,
            "--limit",
            "30",
            "--search",
            &qualifiers,
            "--json",
            "number,title,state,isDraft,createdAt,updatedAt,mergedAt,closedAt,url,headRefName,baseRefName,author,labels,reviewDecision,statusCheckRollup",
        ];
        let output = self
            .runner
            .gh(scope, &args, Budget::Mutation, None, c)
            .await
            .map_err(|failure| {
                from_process_error(operation, "gh", &failure.error, &failure.stderr)
            })?;
        let value: Value =
            serde_json::from_str(&output.stdout).map_err(|_| parse::invalid(operation))?;
        let rows = value
            .as_array()
            .ok_or_else(|| parse::invalid(operation))?
            .iter()
            .take(30)
            .map(parse::row)
            .collect::<Result<_, _>>()?;
        Ok(ListPage {
            rows,
            next_cursor: None,
            total_count: None,
            counts: None,
        })
    }
}

impl PullRequestHost for GitHubHost {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Github
    }

    fn capabilities(&self, _version: Option<&HostVersion>) -> HostCapabilities {
        HostCapabilities {
            vocabulary: HostVocabulary {
                pull_request: "pull request".into(),
                pull_requests: "pull requests".into(),
                checks: "Checks".into(),
                files_changed: "Files changed".into(),
                reviewer: "Reviewers".into(),
                approve: "Approve".into(),
                request_changes: "Request changes".into(),
            },
            request_changes: true,
            revoke_approval: false,
            remove_own_change_request: false,
            dismiss_review: true,
            apply_suggestion: false,
            minimize_comment: true,
            delete_pull_request: false,
            lock_reasons: ["off_topic", "resolved", "spam", "too_heated"]
                .map(str::to_owned)
                .to_vec(),
            update_branch_methods: vec![UpdateBranchMethod::Merge, UpdateBranchMethod::Rebase],
            merge_methods_source: MergeMethodsSource::PerPullRequest,
            auto_merge_label: "Enable auto-merge".into(),
            reviewer_states: true,
            closed_tab_includes_merged: true,
        }
    }

    fn context<'a>(
        &'a self,
        scope: &'a HostScope,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, HostContext> {
        Box::pin(async move {
            let operation = "pullRequests.getContext";
            let (owner, name) = scope
                .repository
                .split_once('/')
                .ok_or_else(|| parse::invalid(operation))?;
            let user = self.api(scope, "user", operation, c).await?;
            let repository = self
                .api(scope, &format!("repos/{}", scope.repository), operation, c)
                .await?;
            let viewer = self
                .graphql(
                    scope,
                    graphql::CONTEXT,
                    json!({"owner":owner,"name":name}),
                    operation,
                    c,
                )
                .await?;
            parse::context(scope, &user, &repository, &viewer)
        })
    }

    fn vocabulary<'a>(
        &'a self,
        scope: &'a HostScope,
        kind: VocabularyKind,
        query: Option<&'a str>,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, Vocabulary> {
        Box::pin(async move {
            let suffix = match kind {
                VocabularyKind::Labels => "labels?per_page=100",
                VocabularyKind::Milestones => "milestones?state=open&per_page=100",
                VocabularyKind::Users => "collaborators?per_page=100",
                VocabularyKind::Branches => "branches?per_page=100",
            };
            let value = self
                .api(
                    scope,
                    &format!("repos/{}/{suffix}", scope.repository),
                    "pullRequests.getVocabulary",
                    c,
                )
                .await?;
            parse::vocabulary(kind, &value, query)
        })
    }

    fn list<'a>(
        &'a self,
        scope: &'a HostScope,
        query: &'a ListQuery,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, ListPage> {
        Box::pin(async move {
            if query.has_filters() {
                return self.search(scope, query, c).await;
            }
            let operation = "pullRequests.list";
            let (owner, name) = scope
                .repository
                .split_once('/')
                .ok_or_else(|| parse::invalid(operation))?;
            let states = match query.state {
                ListState::Open => vec!["OPEN"],
                ListState::Closed => vec!["CLOSED", "MERGED"],
                ListState::Merged => vec!["MERGED"],
                ListState::All => vec!["OPEN", "CLOSED", "MERGED"],
            };
            let (field, direction) = match query.sort {
                ListSort::Newest => ("CREATED_AT", "DESC"),
                ListSort::Oldest => ("CREATED_AT", "ASC"),
                ListSort::RecentlyUpdated => ("UPDATED_AT", "DESC"),
                ListSort::MostCommented => ("COMMENTS", "DESC"),
            };
            let value = self.graphql(scope, graphql::LIST, json!({"owner":owner,"name":name,"cursor":query.cursor,"states":states,"field":field,"dir":direction}), operation, c).await?;
            let page = &value["data"]["repository"]["pullRequests"];
            let rows = page["nodes"]
                .as_array()
                .ok_or_else(|| parse::invalid(operation))?
                .iter()
                .take(30)
                .map(parse::row)
                .collect::<Result<_, _>>()?;
            let total = page["totalCount"]
                .as_u64()
                .ok_or_else(|| parse::invalid(operation))?;
            let next_cursor = match page["pageInfo"]["hasNextPage"].as_bool() {
                Some(true) => Some(parse::string(&page["pageInfo"], "endCursor", operation)?),
                Some(false) => None,
                None => return Err(parse::invalid(operation)),
            };
            Ok(ListPage {
                rows,
                next_cursor,
                total_count: Some(total),
                counts: Some(ListCounts {
                    open: (query.state == ListState::Open).then_some(total),
                    closed: value["data"]["repository"]["closed"]["totalCount"].as_u64(),
                    merged: None,
                }),
            })
        })
    }

    fn detail<'a>(
        &'a self,
        scope: &'a HostScope,
        number: u64,
        context: &'a HostContext,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, DetailRaw> {
        Box::pin(async move {
            let operation = "pullRequests.get";
            // Count commits with GraphQL, avoiding the potentially large commit-body array.
            let value=self.view(scope,number,"number,title,body,state,isDraft,createdAt,updatedAt,mergedAt,closedAt,mergedBy,author,headRefName,baseRefName,headRefOid,baseRefOid,isCrossRepository,headRepository,headRepositoryOwner,maintainerCanModify,additions,deletions,changedFiles,labels,milestone,assignees,reviewRequests,latestReviews,closingIssuesReferences,reactionGroups,autoMergeRequest,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup,url",operation,c).await?;
            let (owner, name) = scope
                .repository
                .split_once('/')
                .ok_or_else(|| parse::invalid(operation))?;
            let viewer = self
                .graphql(
                    scope,
                    graphql::DETAIL_VIEWER_QUERY,
                    json!({"owner":owner,"name":name,"number":number}),
                    operation,
                    c,
                )
                .await?;
            parse::detail(
                &value,
                &viewer,
                context,
                self.capabilities(context.version().as_ref()),
            )
        })
    }

    fn timeline<'a>(
        &'a self,
        scope: &'a HostScope,
        number: u64,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, Timeline> {
        Box::pin(self.read_timeline(scope, number, c))
    }

    fn commits<'a>(
        &'a self,
        scope: &'a HostScope,
        number: u64,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, Commits> {
        Box::pin(async move {
            let value = self
                .view(scope, number, "commits", "pullRequests.getCommits", c)
                .await?;
            parse::commits(&value, scope, number)
        })
    }
    fn checks<'a>(
        &'a self,
        scope: &'a HostScope,
        number: u64,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, Checks> {
        Box::pin(async move {
            let value = self
                .view(
                    scope,
                    number,
                    "statusCheckRollup",
                    "pullRequests.getChecks",
                    c,
                )
                .await?;
            parse::checks(&value)
        })
    }
    fn files<'a>(
        &'a self,
        scope: &'a HostScope,
        number: u64,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, Files> {
        Box::pin(async move {
            let operation = "pullRequests.getFiles";
            let value = self
                .view(scope, number, "files,baseRefOid,headRefOid", operation, c)
                .await?;
            let mut files = parse::file_list(&value)?;
            if files.files.len() >= 100 {
                self.complete_file_list(scope, number, &mut files, c)
                    .await?;
            }
            match self
                .runner
                .gh(
                    scope,
                    &["pr", "diff", &number.to_string(), "--patch"],
                    Budget::Large,
                    None,
                    c,
                )
                .await
            {
                Ok(output) => files::attach_patches(&mut files, &output.stdout),
                Err(failure) => {
                    let error =
                        from_process_error(operation, "gh", &failure.error, &failure.stderr);
                    if error.code != "output_limit" {
                        return Err(error);
                    }
                    files.truncated = true;
                    for file in &mut files.files {
                        file.patch = None;
                        file.too_large = true;
                    }
                }
            }
            Ok(files)
        })
    }

    fn run_action<'a>(
        &'a self,
        scope: &'a HostScope,
        action: &'a ActionRequest,
        _context: &'a ActionContext,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, ActionResult> {
        Box::pin(self.review_action(scope, action, c))
    }

    fn head_branch<'a>(
        &'a self,
        scope: &'a HostScope,
        number: u64,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, String> {
        Box::pin(async move {
            let value = self
                .view(scope, number, "headRefName", super::checkout::OP, c)
                .await?;
            value["headRefName"]
                .as_str()
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    PullRequestsOperationError::new(super::checkout::OP, "invalid_response")
                })
        })
    }

    fn head_ref_spec(&self, number: u64) -> String {
        format!("refs/pull/{number}/head")
    }
}

fn search_qualifiers(query: &ListQuery, login: Option<&str>) -> String {
    let mut qualifiers = Vec::new();
    if let Some(search) = &query.search {
        qualifiers.push(search.clone());
    }
    if query.state == ListState::Closed {
        qualifiers.push("is:closed".into());
    }
    for (key, value) in [
        ("author", &query.author),
        ("assignee", &query.assignee),
        ("review-requested", &query.reviewer),
    ] {
        if let Some(value) = value {
            qualifiers.push(format!(
                "{key}:{}",
                if value == "@me" {
                    login.unwrap_or(value)
                } else {
                    value
                }
            ));
        }
    }
    for label in &query.labels {
        qualifiers.push(format!("label:{}", json!(label)));
    }
    if let Some(milestone) = &query.milestone {
        qualifiers.push(format!("milestone:{}", json!(milestone)));
    }
    if let Some(branch) = &query.target_branch {
        qualifiers.push(format!("base:{branch}"));
    }
    if let Some(draft) = query.draft {
        qualifiers.push(format!("draft:{}", draft == DraftFilter::Only));
    }
    if let Some(review) = query.review_status {
        qualifiers.push(
            match review {
                ReviewStatus::ReviewRequired => "review:required",
                ReviewStatus::Approved => "review:approved",
                ReviewStatus::ChangesRequested => "review:changes-requested",
                ReviewStatus::NotApproved => "-review:approved",
            }
            .into(),
        );
    }
    qualifiers.push(
        match query.sort {
            ListSort::Newest => "sort:created-desc",
            ListSort::Oldest => "sort:created-asc",
            ListSort::RecentlyUpdated => "sort:updated-desc",
            ListSort::MostCommented => "sort:comments-desc",
        }
        .into(),
    );
    qualifiers.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_requests_github_recorded_list_shape_normalizes_merged_review_and_checks() {
        let value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/pull_requests/github_row.json"
        ))
        .unwrap();
        let row = parse::row(&value).unwrap();
        assert_eq!(row.number, 14);
        assert_eq!(row.state, PullRequestState::Merged);
        assert_eq!(row.review_decision, None);
        assert_eq!(row.checks_summary, Some(ChecksSummary::Failure));
        assert_eq!(row.labels[0].color.as_deref(), Some("d73a4a"));
        assert_eq!(row.comment_count, 0);
        assert!(!serde_json::to_string(&row).unwrap().contains("avatar"));
    }

    #[test]
    fn pull_requests_github_search_does_not_report_timed_out_or_action_required_checks_as_success()
    {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/pull_requests/github_row.json"
        ))
        .unwrap();
        for conclusion in ["TIMED_OUT", "ACTION_REQUIRED"] {
            value["statusCheckRollup"] = json!([
                {"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},
                {"__typename":"CheckRun","status":"COMPLETED","conclusion":conclusion}
            ]);
            assert_eq!(
                parse::row(&value).unwrap().checks_summary,
                Some(ChecksSummary::Failure),
                "{conclusion}"
            );
        }
    }

    #[test]
    fn pull_requests_github_graphql_row_reads_count_and_rollup_without_bodies() {
        let mut value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/pull_requests/github_row.json"
        ))
        .unwrap();
        value["labels"] = json!({"nodes": [{"name":"bug","color":"d73a4a","description":null}]});
        value["totalCommentsCount"] = json!(3);
        value["commits"] = json!({"nodes":[{"commit":{"statusCheckRollup":{"state":"PENDING"}}}]});
        value.as_object_mut().unwrap().remove("statusCheckRollup");
        let row = parse::row(&value).unwrap();
        assert_eq!(row.comment_count, 3);
        assert_eq!(row.checks_summary, Some(ChecksSummary::Pending));
        value["title"] = json!(null);
        assert_eq!(parse::row(&value).unwrap_err().code, "invalid_response");
    }

    #[test]
    fn pull_requests_github_capabilities_and_head_ref_match_contract() {
        let host = GitHubHost::new(std::sync::Arc::new(HostCommandRunner::new(
            std::path::PathBuf::new(),
        )));
        let c = serde_json::to_value(host.capabilities(None)).unwrap();
        assert_eq!(
            c,
            json!({
                "vocabulary":{"pullRequest":"pull request","pullRequests":"pull requests","checks":"Checks","filesChanged":"Files changed","reviewer":"Reviewers","approve":"Approve","requestChanges":"Request changes"},
                "requestChanges":true,"revokeApproval":false,"removeOwnChangeRequest":false,"dismissReview":true,"applySuggestion":false,"minimizeComment":true,"deletePullRequest":false,
                "lockReasons":["off_topic","resolved","spam","too_heated"],"updateBranchMethods":["merge","rebase"],"mergeMethodsSource":"per_pull_request","autoMergeLabel":"Enable auto-merge","reviewerStates":true,"closedTabIncludesMerged":true
            })
        );
        assert_eq!(host.head_ref_spec(14), "refs/pull/14/head");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pull_requests_github_context_vocabulary_and_both_list_routes() {
        use crate::{source_control::ProviderKind, test_support::TestSandbox};
        use std::{fs, sync::Arc};
        use tokio_util::sync::CancellationToken;
        let s = TestSandbox::new("pr-github-adapter");
        fs::write(
            s.path("repository.json"),
            include_str!("../../../tests/fixtures/pull_requests/github_repository.json"),
        )
        .unwrap();
        let mut row: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/pull_requests/github_row.json"
        ))
        .unwrap();
        row["totalCommentsCount"] = json!(4);
        fs::write(s.path("graphql.json"), json!({"data":{"repository":{"viewerPermission":"ADMIN","pullRequests":{"totalCount":7,"pageInfo":{"hasNextPage":true,"endCursor":"cursor-2"},"nodes":[row]},"closed":{"totalCount":5}}}}).to_string()).unwrap();
        fs::write(
            s.path("search.json"),
            format!(
                "[{}]",
                include_str!("../../../tests/fixtures/pull_requests/github_row.json")
            ),
        )
        .unwrap();
        fs::write(
            s.path("labels.json"),
            json!(
                (0..100)
                    .map(
                        |i| json!({"name":format!("label-{i}"),"color":"123456","description":null})
                    )
                    .collect::<Vec<_>>()
            )
            .to_string(),
        )
        .unwrap();
        let script = s.executable_script(
            "gh",
            r#"printf '%s\n' "$*" >> calls
case "$1 $2" in
  'api user') echo '{"login":"mubeda","name":""}' ;;
  'api repos/example/repository') cat repository.json ;;
  'api graphql') cat > graphql-input; cat graphql.json ;;
  'api repos/example/repository/labels?per_page=100') cat labels.json ;;
  'pr list') cat search.json ;;
  *) exit 64 ;;
esac"#,
            "",
        );
        let host = GitHubHost::new(Arc::new(
            HostCommandRunner::new(s.path("state")).with_commands(&script, &script, &script),
        ));
        let scope = HostScope {
            cwd: s.root().into(),
            host: "github.com".into(),
            repository: "example/repository".into(),
            provider: ProviderKind::Github,
        };
        let c = CancellationToken::new();
        let context = host.context(&scope, &c).await.unwrap();
        assert_eq!(context.repository_permission, RepositoryPermission::Admin);
        assert_eq!(
            context.merge_policy.methods,
            vec![MergeMethod::Merge, MergeMethod::Squash, MergeMethod::Rebase]
        );
        let vocab = host
            .vocabulary(&scope, VocabularyKind::Labels, Some("LABEL-99"), &c)
            .await
            .unwrap();
        assert_eq!(vocab.entries.len(), 1);
        assert_eq!(vocab.entries[0].id, "label-99");
        assert!(vocab.truncated);
        let mut query: ListQuery = serde_json::from_value(json!({"cwd":s.root(),"state":"open","search":null,"author":null,"assignee":null,"reviewer":null,"reviewStatus":null,"draft":null,"labels":[],"milestone":null,"targetBranch":null,"sort":"newest","cursor":"cursor-1"})).unwrap();
        let page = host.list(&scope, &query, &c).await.unwrap();
        assert_eq!(page.next_cursor.as_deref(), Some("cursor-2"));
        assert_eq!(page.counts.unwrap().open, Some(7));
        let input: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(s.path("graphql-input")).unwrap()).unwrap();
        assert_eq!(input["variables"]["cursor"], "cursor-1");
        assert_eq!(input["variables"]["states"], json!(["OPEN"]));
        query.author = Some("@me".into());
        query.labels = vec!["needs review".into()];
        query.sort = ListSort::MostCommented;
        let page = host.list(&scope, &query, &c).await.unwrap();
        assert!(page.next_cursor.is_none());
        assert!(page.total_count.is_none());
        assert_eq!(page.rows[0].comment_count, 0);
        let calls = fs::read_to_string(s.path("calls")).unwrap();
        let search = calls
            .lines()
            .find(|line| line.starts_with("pr list"))
            .unwrap();
        assert!(search.contains("--repo github.com/example/repository"));
        assert!(search.contains("author:mubeda"));
        assert!(search.contains("label:\"needs review\""));
        assert!(search.contains("sort:comments-desc"));
        assert!(
            !search
                .split("--json ")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap()
                .split(',')
                .any(|field| field == "comments")
        );
        assert!(
            calls
                .lines()
                .filter(|line| line.starts_with("api "))
                .all(|line| !line.contains("--repo"))
        );
    }
}

#[cfg(all(test, unix))]
mod detail_tests;
