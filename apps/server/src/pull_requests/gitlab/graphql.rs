//! Public GraphQL metadata absent from the REST merge-request record.
pub const DETAIL_METADATA_QUERY: &str = r#"query($projectPath:ID!, $iid:String!) {
  project(fullPath:$projectPath) { mergeRequest(iid:$iid) {
    commitCount resolvableDiscussionsCount diffStatsSummary { additions deletions fileCount }
    sourceProject { fullPath }
    userPermissions { createNote pushToSourceBranch }
  } }
}"#;

/// The diff-head pipeline's stages for the detail join: GitLab's stage order,
/// stage status and detailed status (`SUCCESS_WITH_WARNINGS`). A separate
/// document, so an older host's failure degrades only the stage strip.
pub const PIPELINE_STAGES_QUERY: &str = r#"query PullRequestsGitLabPipelineStages($projectPath:ID!, $iid:String!) {
  project(fullPath:$projectPath) { mergeRequest(iid:$iid) {
    headPipeline {
      id status
      stages { nodes { name status detailedStatus { name } } }
    }
  } }
}"#;

/// The same, plus up to 100 jobs per stage (trigger jobs included), for the
/// poller's active ticks and `getChecks`.
pub const PIPELINE_QUERY: &str = r#"query PullRequestsGitLabPipeline($projectPath:ID!, $iid:String!) {
  project(fullPath:$projectPath) { mergeRequest(iid:$iid) {
    headPipeline {
      id status
      stages { nodes {
        name status detailedStatus { name }
        jobs(first:100) {
          pageInfo { hasNextPage }
          nodes {
            id name status allowFailure webPath startedAt finishedAt duration
            downstreamPipeline { path }
          }
        }
      } }
    }
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

/// The fields a pipelines list row and a pipeline header read.
const PIPELINE_HEADER_FIELDS: &str = "id iid name ref sha status detailedStatus { name } source latest \
yamlErrors failureReason createdAt startedAt finishedAt duration queuedDuration path \
user { name username } commit { shortId title webPath } mergeRequest { iid title webPath } \
retryable cancelable userPermissions { updatePipeline cancelPipeline }";

/// Newer fields some GitLab versions lack: a "Field doesn't exist" answer
/// retries once with the baseline document, which leaves them out.
const PIPELINE_OPTIONAL_FIELDS: &str = "mergeRequestEventType type stuck refPath";

/// One pipelines page, fifteen rows as GitLab's own page, each with its stage
/// strip. `count` is selected only on a first page that needs it. A new
/// document, never merged into the merge request ones.
pub fn pipelines_list_query(baseline: bool) -> String {
    let optional = if baseline {
        ""
    } else {
        PIPELINE_OPTIONAL_FIELDS
    };
    format!(
        "query PipelinesGitLabList($projectPath:ID!, $first:Int!, $after:String, \
$scope:PipelineScopeEnum, $ref:String, $withCount:Boolean!) {{
  project(fullPath:$projectPath) {{
    pipelines(first:$first, after:$after, scope:$scope, ref:$ref) {{
      pageInfo {{ hasNextPage endCursor }}
      count(limit:1000) @include(if:$withCount)
      nodes {{
        {PIPELINE_HEADER_FIELDS} {optional}
        stages {{ nodes {{ name status detailedStatus {{ name }} }} }}
      }}
    }}
  }}
}}"
    )
}

/// One pipeline by its global id: the header, then stages, groups and up to
/// 100 jobs per group.
pub fn pipeline_detail_query(baseline: bool) -> String {
    let optional = if baseline {
        ""
    } else {
        PIPELINE_OPTIONAL_FIELDS
    };
    format!(
        "query PipelinesGitLabDetail($projectPath:ID!, $id:CiPipelineID!) {{
  project(fullPath:$projectPath) {{
    pipeline(id:$id) {{
      {PIPELINE_HEADER_FIELDS} {optional}
      totalJobs usesNeeds
      stages {{ nodes {{
        name status detailedStatus {{ name }}
        groups {{ nodes {{
          name size detailedStatus {{ name }}
          jobs(first:100) {{
            pageInfo {{ hasNextPage }}
            nodes {{
              id name kind status detailedStatus {{ name }} allowFailure
              startedAt finishedAt duration queuedDuration webPath
              retryable cancelable playable manualJob
              downstreamPipeline {{ id path detailedStatus {{ name }} }}
            }}
          }}
        }} }}
      }} }}
    }}
  }}
}}"
    )
}

pub fn override_requested_changes(project: &str, iid: u64) -> String {
    format!(
        "mutation PullRequestsOverrideRequestedChanges {{ mergeRequestUpdate(input: {{ projectPath: {}, iid: {}, overrideRequestedChanges: true }}) {{ errors }} }}",
        serde_json::json!(project),
        serde_json::json!(iid.to_string())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pipeline_query_selects_each_jobs_global_id_for_the_job_page() {
        let (_, jobs) = PIPELINE_QUERY.split_once("jobs(first:100)").unwrap();
        let (_, fields) = jobs.split_once("nodes {").unwrap();
        assert_eq!(fields.split_whitespace().next(), Some("id"));
    }
}
