//! Bounded GitHub list and repository queries.

pub const CONTEXT: &str = r#"query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) { viewerPermission }
}"#;

pub const LIST: &str = r#"query($owner:String!, $name:String!, $cursor:String, $states:[PullRequestState!]!, $field:IssueOrderField!, $dir:OrderDirection!) {
  repository(owner:$owner, name:$name) {
    pullRequests(first:30, after:$cursor, states:$states, orderBy:{field:$field, direction:$dir}) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes {
        number title state isDraft createdAt updatedAt mergedAt closedAt url
        headRefName baseRefName author { login }
        labels(first:20) { nodes { name color description } }
        reviewDecision totalCommentsCount
        commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    closed: pullRequests(states:[CLOSED,MERGED]) { totalCount }
  }
}"#;

pub const DETAIL_VIEWER_QUERY: &str = r#"query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    viewerPermission
    pullRequest(number:$number) {
      locked activeLockReason viewerCanUpdate viewerDidAuthor viewerCanMergeAsAdmin
      viewerCanEnableAutoMerge viewerCanDisableAutoMerge viewerCanApplySuggestion
      commits { totalCount } mergeCommit { oid }
      baseRef { refUpdateRule { requiredApprovingReviewCount viewerAllowedToDismissReviews } }
      reviewThreads(first:100) { totalCount nodes { viewerCanResolve } }
      comments { totalCount } reviews { totalCount }
      reactionGroups { content users { totalCount } viewerHasReacted }
    }
  }
}"#;

pub const TIMELINE_COMMENTS_QUERY: &str = r#"query PullRequestsTimelineComments($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$name) { pullRequest(number:$number) {
    comments(first:100, after:$cursor) { pageInfo { hasNextPage endCursor } nodes {
      id databaseId author { login } body createdAt updatedAt isMinimized viewerDidAuthor
      reactionGroups { content users { totalCount } viewerHasReacted }
    } }
  } }
}"#;

pub const TIMELINE_REVIEWS_QUERY: &str = r#"query PullRequestsTimelineReviews($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$name) { viewerPermission pullRequest(number:$number) {
    baseRef { refUpdateRule { viewerAllowedToDismissReviews } }
    reviews(first:100, after:$cursor) { pageInfo { hasNextPage endCursor } nodes {
      id databaseId author { login } state body submittedAt commit { oid } viewerDidAuthor
    } }
  } }
}"#;

pub const TIMELINE_THREADS_QUERY: &str = r#"query PullRequestsTimelineThreads($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$name) { pullRequest(number:$number) {
    reviewThreads(first:100, after:$cursor) { pageInfo { hasNextPage endCursor } nodes {
      id isResolved isOutdated viewerCanResolve path line startLine diffSide
      comments(first:100) { pageInfo { hasNextPage endCursor } nodes {
        id databaseId author { login } body createdAt updatedAt isMinimized viewerDidAuthor
        reactionGroups { content users { totalCount } viewerHasReacted }
        diffHunk path line startLine originalLine
      } }
    } }
  } }
}"#;

pub const TIMELINE_THREAD_COMMENTS_QUERY: &str = r#"query PullRequestsTimelineThreadComments($id:ID!, $cursor:String) {
  node(id:$id) { ... on PullRequestReviewThread {
    comments(first:100, after:$cursor) { pageInfo { hasNextPage endCursor } nodes {
      id databaseId author { login } body createdAt updatedAt isMinimized viewerDidAuthor
      reactionGroups { content users { totalCount } viewerHasReacted }
      diffHunk path line startLine originalLine
    } }
  } }
}"#;

pub const TIMELINE_EVENTS_QUERY: &str = r#"query PullRequestsTimelineEvents($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$name) { pullRequest(number:$number) {
    timelineItems(first:100, after:$cursor, itemTypes:[LABELED_EVENT,UNLABELED_EVENT,ASSIGNED_EVENT,UNASSIGNED_EVENT,REVIEW_REQUESTED_EVENT,CLOSED_EVENT,REOPENED_EVENT,READY_FOR_REVIEW_EVENT,CONVERT_TO_DRAFT_EVENT,MERGED_EVENT,HEAD_REF_FORCE_PUSHED_EVENT,MILESTONED_EVENT,DEMILESTONED_EVENT,RENAMED_TITLE_EVENT,LOCKED_EVENT,UNLOCKED_EVENT]) {
      pageInfo { hasNextPage endCursor } nodes {
        __typename
        ... on LabeledEvent { id actor { login } createdAt label { name } }
        ... on UnlabeledEvent { id actor { login } createdAt label { name } }
        ... on AssignedEvent { id actor { login } createdAt assignee { ... on User { login } } }
        ... on UnassignedEvent { id actor { login } createdAt assignee { ... on User { login } } }
        ... on ReviewRequestedEvent { id actor { login } createdAt requestedReviewer { ... on User { login } ... on Team { name slug } } }
        ... on ClosedEvent { id actor { login } createdAt }
        ... on ReopenedEvent { id actor { login } createdAt }
        ... on ReadyForReviewEvent { id actor { login } createdAt }
        ... on ConvertToDraftEvent { id actor { login } createdAt }
        ... on MergedEvent { id actor { login } createdAt }
        ... on HeadRefForcePushedEvent { id actor { login } createdAt }
        ... on MilestonedEvent { id actor { login } createdAt milestoneTitle }
        ... on DemilestonedEvent { id actor { login } createdAt milestoneTitle }
        ... on RenamedTitleEvent { id actor { login } createdAt previousTitle currentTitle }
        ... on LockedEvent { id actor { login } createdAt }
        ... on UnlockedEvent { id actor { login } createdAt }
      }
    }
  } }
}"#;

// gh pr view's file export ends at 100; explicit pages complete larger inventories.
pub const FILES_QUERY: &str = r#"query PullRequestsFiles($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$name) { pullRequest(number:$number) {
    files(first:100, after:$cursor) { pageInfo { hasNextPage endCursor }
      nodes { path additions deletions changeType }
    }
  } }
}"#;

pub const MINIMIZE_COMMENT: &str = r#"mutation PullRequestsMinimizeComment($subjectId: ID!) {
  minimizeComment(input: { subjectId: $subjectId, classifier: OUTDATED }) { minimizedComment { isMinimized } }
}"#;
pub const UNMINIMIZE_COMMENT: &str = r#"mutation PullRequestsUnminimizeComment($subjectId: ID!) {
  unminimizeComment(input: { subjectId: $subjectId }) { unminimizedComment { isMinimized } }
}"#;
pub const REVIEW_THREAD_STATE: &str = r#"query PullRequestsReviewThreadState($id: ID!) {
  node(id: $id) { ... on PullRequestReviewThread { isResolved } }
}"#;
pub const RESOLVE_REVIEW_THREAD: &str = r#"mutation PullRequestsResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}"#;
pub const UNRESOLVE_REVIEW_THREAD: &str = r#"mutation PullRequestsUnresolveReviewThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}"#;
