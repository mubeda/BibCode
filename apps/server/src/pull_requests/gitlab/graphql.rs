//! Public GraphQL metadata absent from the REST merge-request record.
pub const DETAIL_METADATA_QUERY: &str = r#"query($projectPath:ID!, $iid:String!) {
  project(fullPath:$projectPath) { mergeRequest(iid:$iid) {
    commitCount resolvableDiscussionsCount diffStatsSummary { additions deletions fileCount }
    sourceProject { fullPath }
    userPermissions { createNote pushToSourceBranch }
  } }
}"#;

// A bounded metadata-only fallback when REST diff output hits the patch cap.
pub const FILES_METADATA_QUERY: &str = r#"query($projectPath:ID!, $iid:String!) {
  project(fullPath:$projectPath) { mergeRequest(iid:$iid) { diffStats { path additions deletions } } }
}"#;

pub const TIMELINE_QUERY: &str = r#"query PullRequestsGitLabTimeline($projectPath:ID!, $iid:String!, $cursor:String) {
  project(fullPath:$projectPath) { mergeRequest(iid:$iid) {
    userPermissions { createNote }
    discussions(first:100, after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id resolvable resolved
        notes(first:100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id body system resolvable resolved createdAt updatedAt
            author { username name }
            position { filePath newPath oldPath newLine oldLine }
            awardEmoji(first:100) {
              pageInfo { hasNextPage endCursor }
              nodes { name user { username } }
            }
          }
        }
      }
    }
  } }
}"#;

// These review mutations contain only host identifiers, never comment bodies.
// JSON string encoding also quotes GraphQL string literals, so project paths
// and user ids cannot change the document. glab receives `-f query=<document>`.
pub fn request_changes(project: &str, iid: u64) -> String {
    format!(
        "mutation PullRequestsRequestChanges {{ mergeRequestRequestChanges(input: {{ projectPath: {}, iid: {} }}) {{ errors }} }}",
        serde_json::json!(project),
        serde_json::json!(iid.to_string())
    )
}
pub fn destroy_requested_changes(project: &str, iid: u64) -> String {
    format!(
        "mutation PullRequestsDestroyRequestedChanges {{ mergeRequestDestroyRequestedChanges(input: {{ projectPath: {}, iid: {} }}) {{ errors }} }}",
        serde_json::json!(project),
        serde_json::json!(iid.to_string())
    )
}
pub fn reviewer_rereview(project: &str, iid: u64, user_id: u64) -> String {
    format!(
        "mutation PullRequestsReviewerRereview {{ mergeRequestReviewerRereview(input: {{ projectPath: {}, iid: {}, userId: {} }}) {{ errors }} }}",
        serde_json::json!(project),
        serde_json::json!(iid.to_string()),
        serde_json::json!(format!("gid://gitlab/User/{user_id}"))
    )
}

pub fn override_requested_changes(project: &str, iid: u64) -> String {
    format!(
        "mutation PullRequestsOverrideRequestedChanges {{ mergeRequestUpdate(input: {{ projectPath: {}, iid: {}, overrideRequestedChanges: true }}) {{ errors }} }}",
        serde_json::json!(project),
        serde_json::json!(iid.to_string())
    )
}
