use super::*;
use crate::{pull_requests::permissions, test_support::TestSandbox};
use std::fs;

fn fixture() -> (TestSandbox, GitHubHost, HostScope) {
    let s = TestSandbox::new("pr-github-detail");
    fs::write(
        s.path("detail.json"),
        include_str!("../../../tests/fixtures/pull_requests/github_detail.json"),
    )
    .unwrap();
    fs::write(
        s.path("viewer.json"),
        include_str!("../../../tests/fixtures/pull_requests/github_detail_viewer.json"),
    )
    .unwrap();
    fs::write(s.path("repository.json"), r#"{"permissions":{"pull":true},"allow_merge_commit":true,"allow_squash_merge":true,"allow_rebase_merge":true,"default_branch":"main","html_url":"https://github.com/openai/codex"}"#).unwrap();
    let gh = s.executable_script("gh", r#"
printf '%s\n' "$*" >> calls
case "$1 $2" in
  'api user') echo '{"login":"viewer","name":null}' ;;
  'api repos/openai/codex') cat repository.json ;;
  'api graphql') cat > query.json
    if grep -q 'PullRequestsTimeline' query.json; then
      if [ -e cap ]; then n=0; if [ -e page ]; then n=$(cat page); fi; n=$((n+1)); echo "$n" > page; sed "s/\"endCursor\": \"next\"/\"endCursor\": \"next-$n\"/g" timeline.json
      else cat timeline.json; fi
    else cat viewer.json; fi ;;
  'pr view') case "$5" in
    commits) cat commits.json ;;
    statusCheckRollup) cat checks.json ;;
    files,baseRefOid,headRefOid) cat files.json ;;
    *) cat detail.json ;; esac ;;
  'pr diff') cat patch ;;
  *) exit 64 ;;
esac"#, "");
    let scope = HostScope {
        cwd: s.root().into(),
        host: "github.com".into(),
        repository: "openai/codex".into(),
        provider: ProviderKind::Github,
    };
    let host = GitHubHost::new(Arc::new(
        HostCommandRunner::new(s.path("state")).with_commands(gh, "missing-glab", "git"),
    ));
    (s, host, scope)
}

#[tokio::test]
async fn pull_requests_github_detail_read_viewer_normalizes_permissions_counts_and_reviewers() {
    let (s, host, scope) = fixture();
    let c = CancellationToken::new();
    let context = host.context(&scope, &c).await.unwrap();
    let raw = host.detail(&scope, 35882, &context, &c).await.unwrap();
    let (p, r) = permissions::compute(&raw.inputs);
    let d = raw.detail_without_permissions;
    assert_eq!(d.number, 35882);
    assert_eq!(d.commit_count, 1);
    assert_eq!(d.tab_counts.conversation, Some(3));
    assert_eq!(d.tab_counts.checks, Some(3));
    assert!(!p.merge.permission.allowed);
    assert!(p.approve.allowed);
    assert!(p.apply_suggestion.reason.unwrap().contains("no public API"));
    assert_eq!(r.status, ReadinessStatus::ReviewRequired);
    assert!(r.details.iter().any(|d| d.contains("1 approving review")));
    assert_eq!(d.reviewers[0].state, ReviewerState::Unreviewed);
    assert_eq!(d.reviewers[1].state, ReviewerState::Commented);
    assert_eq!(d.head_repository.as_deref(), Some("contributor/codex"));
    assert_eq!(d.reactions[0].content, ReactionContent::ThumbsUp);
    assert!(d.reactions[0].viewer_reacted);
    assert_eq!(d.linked_issues[0].reference, "#99");
    assert!(!serde_json::to_string(&d).unwrap().contains("avatar"));
    let query: Value =
        serde_json::from_str(&fs::read_to_string(s.path("query.json")).unwrap()).unwrap();
    assert_eq!(query["variables"]["number"], 35882);
    let calls = fs::read_to_string(s.path("calls")).unwrap();
    assert_eq!(calls.lines().filter(|l| *l == "api user").count(), 1);
    let detail_calls = calls
        .lines()
        .filter(|l| l.starts_with("pr view "))
        .collect::<Vec<_>>();
    assert_eq!(
        detail_calls.len(),
        1,
        "the rollup must come from the existing detail read"
    );
    assert!(
        detail_calls[0]
            .split_whitespace()
            .nth(4)
            .unwrap()
            .split(',')
            .any(|field| field == "statusCheckRollup")
    );
    assert!(calls.lines().any(
        |l| l.starts_with("pr view 35882 --json number,title,body,state")
            && l.ends_with("--repo github.com/openai/codex")
    ));
}

#[tokio::test]
async fn pull_requests_github_detail_distinguishes_absent_and_empty_check_rollup() {
    let (s, host, scope) = fixture();
    let c = CancellationToken::new();
    let context = host.context(&scope, &c).await.unwrap();
    let mut detail: Value =
        serde_json::from_str(&fs::read_to_string(s.path("detail.json")).unwrap()).unwrap();
    for (rollup, expected) in [
        (None, None),
        (Some(Value::Null), None),
        (Some(json!([])), Some(0)),
    ] {
        match rollup {
            Some(value) => {
                detail["statusCheckRollup"] = value;
            }
            None => {
                detail.as_object_mut().unwrap().remove("statusCheckRollup");
            }
        }
        fs::write(s.path("detail.json"), detail.to_string()).unwrap();
        let raw = host.detail(&scope, 35882, &context, &c).await.unwrap();
        assert_eq!(raw.detail_without_permissions.tab_counts.checks, expected);
    }
}

#[tokio::test]
async fn pull_requests_github_detail_rejects_a_malformed_check_rollup() {
    let (s, host, scope) = fixture();
    let c = CancellationToken::new();
    let context = host.context(&scope, &c).await.unwrap();
    let mut detail: Value =
        serde_json::from_str(&fs::read_to_string(s.path("detail.json")).unwrap()).unwrap();
    detail["statusCheckRollup"] = json!({"unexpected": true});
    fs::write(s.path("detail.json"), detail.to_string()).unwrap();
    let error = host
        .detail(&scope, 35882, &context, &c)
        .await
        .expect_err("malformed rollup must fail the detail read");
    assert_eq!(error.code, "invalid_response");
    assert_eq!(error.operation, "pullRequests.get");
}

#[tokio::test]
async fn pull_requests_github_detail_merged_admin_can_revert_known_merge_commit() {
    let (s, host, scope) = fixture();
    let c = CancellationToken::new();
    let mut detail: Value =
        serde_json::from_str(&fs::read_to_string(s.path("detail.json")).unwrap()).unwrap();
    detail["number"] = json!(14);
    detail["state"] = json!("MERGED");
    detail["mergeStateStatus"] = json!("UNKNOWN");
    detail["mergeable"] = json!("UNKNOWN");
    detail["mergedAt"] = json!("2026-09-20T00:00:00Z");
    detail["mergedBy"] = json!({"login":"mubeda"});
    fs::write(s.path("detail.json"), detail.to_string()).unwrap();
    let mut viewer: Value =
        serde_json::from_str(&fs::read_to_string(s.path("viewer.json")).unwrap()).unwrap();
    viewer["data"]["repository"]["viewerPermission"] = json!("ADMIN");
    viewer["data"]["repository"]["pullRequest"]["mergeCommit"] = json!({"oid":"merge-sha"});
    fs::write(s.path("viewer.json"), viewer.to_string()).unwrap();
    let context = host.context(&scope, &c).await.unwrap();
    let raw = host.detail(&scope, 14, &context, &c).await.unwrap();
    let (p, r) = permissions::compute(&raw.inputs);
    assert_eq!(r.status, ReadinessStatus::Merged);
    assert!(p.revert.allowed);
    assert!(!p.merge.permission.allowed);
    assert_eq!(
        raw.detail_without_permissions.merged_by.unwrap().login,
        "mubeda"
    );
}

#[tokio::test]
async fn pull_requests_github_timeline_preserves_ids_inline_positions_suggestions_and_order() {
    let (s, host, scope) = fixture();
    fs::write(
        s.path("timeline.json"),
        include_str!("../../../tests/fixtures/pull_requests/github_timeline.json"),
    )
    .unwrap();
    let timeline = host
        .timeline(&scope, 35882, &CancellationToken::new())
        .await
        .unwrap();
    assert!(!timeline.truncated);
    assert_eq!(timeline.items.len(), 4);
    let v = serde_json::to_value(timeline).unwrap();
    assert_eq!(v["items"][0]["id"], "ic:1:IC_1");
    assert_eq!(v["items"][0]["minimized"], true);
    assert_eq!(v["items"][1]["id"], "rv:2:RV_2");
    assert_eq!(v["items"][1]["canDismiss"], false);
    let t = &v["items"][2];
    assert_eq!(t["id"], "th:TH_3:3");
    assert_eq!(t["path"], "codex-rs/rust-toolchain.toml");
    assert_eq!(t["line"], 2);
    assert_eq!(t["side"], "right");
    assert_eq!(t["isResolved"], false);
    assert_eq!(t["canResolve"], false);
    assert_eq!(t["comments"][0]["id"], "rc:3:RC_3");
    assert_eq!(t["comments"][0]["minimized"], true);
    assert!(super::graphql::TIMELINE_THREADS_QUERY.contains("isMinimized"));
    assert!(super::graphql::TIMELINE_THREAD_COMMENTS_QUERY.contains("isMinimized"));
    assert_eq!(t["comments"][0]["suggestion"]["id"], Value::Null);
    assert_eq!(t["comments"][0]["suggestion"]["applicable"], false);
    assert_eq!(t["comments"][0]["suggestion"]["toContent"], "new");
    assert_eq!(v["items"][3]["event"], "labeled");
    assert_eq!(v["items"][3]["detail"], "rust");
}

#[tokio::test]
async fn pull_requests_github_timeline_caps_each_connection_at_ten_pages() {
    let (s, host, scope) = fixture();
    let mut v: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/pull_requests/github_timeline.json"
    ))
    .unwrap();
    for key in ["comments", "reviews", "reviewThreads", "timelineItems"] {
        v["data"]["repository"]["pullRequest"][key]["pageInfo"] =
            json!({"hasNextPage":true,"endCursor":"next"});
    }
    fs::write(s.path("timeline.json"), v.to_string()).unwrap();
    fs::write(s.path("cap"), "").unwrap();
    let timeline = host
        .timeline(&scope, 35882, &CancellationToken::new())
        .await
        .unwrap();
    assert!(timeline.truncated);
    let calls = fs::read_to_string(s.path("calls")).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|l| l.starts_with("api graphql"))
            .count(),
        40
    );
}

#[tokio::test]
async fn pull_requests_github_timeline_dismisses_only_approval_or_changes_request() {
    let (s, host, scope) = fixture();
    let mut v: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/pull_requests/github_timeline.json"
    ))
    .unwrap();
    v["data"]["repository"]["viewerPermission"] = json!("WRITE");
    let reviews = v["data"]["repository"]["pullRequest"]["reviews"]["nodes"]
        .as_array_mut()
        .unwrap();
    let mut commented = reviews[0].clone();
    commented["state"] = json!("COMMENTED");
    commented["databaseId"] = json!(4);
    commented["id"] = json!("RV_4");
    reviews.push(commented);
    fs::write(s.path("timeline.json"), v.to_string()).unwrap();
    let timeline = host
        .timeline(&scope, 35882, &CancellationToken::new())
        .await
        .unwrap();
    let flags: Vec<_> = timeline
        .items
        .iter()
        .filter_map(|i| {
            if let TimelineItem::Review {
                state, can_dismiss, ..
            } = i
            {
                Some((*state, *can_dismiss))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        flags,
        vec![
            (ReviewState::Approved, true),
            (ReviewState::Commented, false)
        ]
    );
}

#[tokio::test]
async fn pull_requests_github_commits_map_subject_body_author_and_url() {
    let (s, host, scope) = fixture();
    fs::write(s.path("commits.json"),json!({"commits":[{"oid":"0123456789","messageHeadline":"Subject","messageBody":"Body","authors":[{"login":"author","name":"Author Name"}],"authoredDate":"2026-09-20T00:00:00Z"}]}).to_string()).unwrap();
    let result = host
        .commits(&scope, 35882, &CancellationToken::new())
        .await
        .unwrap();
    let commit = &result.commits[0];
    assert_eq!(commit.sha, "0123456789");
    assert_eq!(commit.short_sha, "0123456");
    assert_eq!(commit.subject, "Subject");
    assert_eq!(commit.body.as_deref(), Some("Body"));
    assert_eq!(commit.author.login, "author");
    assert_eq!(
        commit.url,
        "https://github.com/openai/codex/pull/35882/commits/0123456789"
    );
}

#[tokio::test]
async fn pull_requests_github_checks_fold_newest_runs_group_workflows_and_keep_nullable_times() {
    let (s, host, scope) = fixture();
    fs::write(s.path("checks.json"),json!({"statusCheckRollup":[
      {"name":"build","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-09-19T00:00:00Z"},
      {"name":"build","workflowName":"CI","status":"COMPLETED","conclusion":"TIMED_OUT","startedAt":"2026-09-20T00:00:00Z","completedAt":"2026-09-20T00:01:30Z","detailsUrl":"https://github.com/check/1"},
      {"context":"external","state":"PENDING","targetUrl":null},
      {"name":"future","workflowName":"CI","status":"COMPLETED","conclusion":"FUTURE"}
    ]}).to_string()).unwrap();
    let result = host
        .checks(&scope, 35882, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.summary, CheckSummary::Failure);
    assert_eq!(result.groups.len(), 2);
    assert_eq!(result.groups[0].name, "CI");
    assert_eq!(result.groups[0].checks.len(), 2);
    assert_eq!(result.groups[0].checks[0].state, CheckState::Failure);
    assert_eq!(result.groups[0].checks[0].duration_seconds, Some(90.0));
    assert_eq!(result.groups[0].checks[1].state, CheckState::Pending);
    assert_eq!(result.groups[1].name, "Status checks");
    assert_eq!(result.groups[1].checks[0].started_at, None);
    assert_eq!(result.groups[1].checks[0].completed_at, None);
    fs::write(s.path("checks.json"), r#"{"statusCheckRollup":[]}"#).unwrap();
    assert_eq!(
        host.checks(&scope, 35882, &CancellationToken::new())
            .await
            .unwrap()
            .summary,
        CheckSummary::None
    );
}

fn files_fixture(s: &TestSandbox) {
    fs::write(s.path("files.json"),json!({"files":[{"path":"text.rs","additions":1,"deletions":1,"changeType":"MODIFIED"},{"path":"image.png","additions":0,"deletions":0,"changeType":"ADDED"}],"baseRefOid":"base-sha","headRefOid":"head-sha"}).to_string()).unwrap();
}

#[tokio::test]
async fn pull_requests_github_files_split_patch_and_preserve_binary_row() {
    let (s, host, scope) = fixture();
    files_fixture(&s);
    fs::write(s.path("patch"),"diff --git a/text.rs b/text.rs\n--- a/text.rs\n+++ b/text.rs\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/image.png b/image.png\nBinary files /dev/null and b/image.png differ\n").unwrap();
    let files = host
        .files(&scope, 35882, &CancellationToken::new())
        .await
        .unwrap();
    assert!(!files.truncated);
    assert_eq!(files.files.len(), 2);
    assert!(files.files[0].patch.as_deref().unwrap().contains("+new"));
    assert!(
        !files.files[0]
            .patch
            .as_deref()
            .unwrap()
            .contains("image.png")
    );
    assert_eq!(files.files[1].change_type, ChangeType::Binary);
    assert!(files.files[1].patch.is_none());
    assert!(!files.files[1].too_large);
    assert_eq!(files.diff_refs.start_sha, "base-sha");
    assert_eq!(files.diff_refs.head_sha, "head-sha");
}

#[tokio::test]
async fn pull_requests_github_large_file_drops_patch_at_one_mib_but_keeps_row() {
    let (s, host, scope) = fixture();
    files_fixture(&s);
    let patch = format!(
        "diff --git a/text.rs b/text.rs\n--- a/text.rs\n+++ b/text.rs\n@@ -0,0 +1 @@\n+{}\n",
        "x".repeat(1024 * 1024)
    );
    fs::write(s.path("patch"), patch).unwrap();
    let files = host
        .files(&scope, 35882, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(files.files.len(), 2);
    assert!(files.files[0].too_large);
    assert!(files.files[0].patch.is_none());
    assert!(!files.truncated);
}

#[tokio::test]
async fn pull_requests_github_whole_patch_over_eight_mib_returns_truncated_file_list() {
    let (s, host, scope) = fixture();
    files_fixture(&s);
    fs::write(s.path("patch"), "x".repeat(9 * 1024 * 1024)).unwrap();
    let files = host
        .files(&scope, 35882, &CancellationToken::new())
        .await
        .unwrap();
    assert!(files.truncated);
    assert_eq!(files.files.len(), 2);
    assert!(files.files.iter().all(|f| f.patch.is_none() && f.too_large));
}

#[tokio::test]
async fn pull_requests_github_detail_retains_merge_commit_in_internal_action_context() {
    let (s, host, scope) = fixture();
    let mut viewer: Value =
        serde_json::from_str(&fs::read_to_string(s.path("viewer.json")).unwrap()).unwrap();
    viewer["data"]["repository"]["pullRequest"]["mergeCommit"] = json!({"oid":"abcdef0123456789"});
    fs::write(s.path("viewer.json"), viewer.to_string()).unwrap();
    let c = CancellationToken::new();
    let context = host.context(&scope, &c).await.unwrap();
    let raw = host.detail(&scope, 35882, &context, &c).await.unwrap();
    assert!(raw.inputs.merge_commit_known);
    assert_eq!(
        ActionContext::from(&raw).merge_commit_sha.as_deref(),
        Some("abcdef0123456789")
    );
    assert!(
        serde_json::to_value(raw.detail_without_permissions)
            .unwrap()
            .get("mergeCommitSha")
            .is_none()
    );
}
