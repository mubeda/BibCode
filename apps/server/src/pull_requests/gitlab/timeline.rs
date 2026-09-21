use super::*;
use crate::pull_requests::read;

const DISCUSSION_PAGE_LIMIT: usize = 10;
const SUGGESTION_READ_LIMIT: usize = 20;

impl GitLabHost {
    pub(super) async fn read_timeline(
        &self,
        scope: &HostScope,
        number: u64,
        c: &CancellationToken,
    ) -> Result<Timeline, PullRequestsOperationError> {
        let op = "pullRequests.getTimeline";
        let path = format!("{}/merge_requests/{number}", project_path(scope));
        let viewer = self.viewer(scope, op, c).await?;
        let detail = self.api(scope, &path, op, c).await?;
        let approvals = self.api(scope, &format!("{path}/approvals"), op, c).await?;
        let reviewers = self.api(scope, &format!("{path}/reviewers"), op, c).await?;
        let mut items = Vec::new();
        let mut truncated = false;
        let mut cursor = None;
        let mut suggestion_reads = 0;

        // Hard bound independent of note count: 7 fixed REST reads, <=10 GraphQL
        // discussion pages, and <=20 REST suggestion reads = <=37 adapter CLI
        // processes. Service scope adds <=5 probes, so an RPC starts at most 42.
        // Each page includes <=100 notes/discussion and <=100 awards/note. More
        // nested data marks truncation; it never creates a per-note paging loop.
        // Every call is awaited with the RPC cancellation token and its deadline.
        for page in 0..DISCUSSION_PAGE_LIMIT {
            let response = self.graphql_with_variables(
                scope, graphql::TIMELINE_QUERY,
                json!({"projectPath":scope.repository,"iid":number.to_string(),"cursor":cursor}),
                op, c,
            ).await?;
            let request = &response["data"]["project"]["mergeRequest"];
            let can_create_note = request["userPermissions"]["createNote"]
                .as_bool()
                .unwrap_or(false);
            let connection = &request["discussions"];
            let values = connection["nodes"]
                .as_array()
                .ok_or_else(|| parse::invalid(op))?;
            truncated |= values.len() > 100;
            for value in values.iter().take(100) {
                let (mut discussion, nested_truncated) = parse::graphql_discussion(value)?;
                truncated |= nested_truncated;
                // The normalizer constructs this array only from validated nodes.
                let notes = discussion["notes"]
                    .as_array_mut()
                    .ok_or_else(|| parse::invalid(op))?;
                for note in notes {
                    if note["system"].as_bool() == Some(true)
                        || !note["position"].is_object()
                        || !note["body"].as_str().is_some_and(|body| {
                            body.lines().any(|line| {
                                let line = line.trim();
                                line == "```suggestion" || line.starts_with("```suggestion:")
                            })
                        })
                    {
                        continue;
                    }
                    if suggestion_reads == SUGGESTION_READ_LIMIT {
                        truncated = true;
                        continue;
                    }
                    suggestion_reads += 1;
                    let id = note["id"].as_u64().ok_or_else(|| parse::invalid(op))?;
                    let suggestion = self
                        .api(scope, &format!("{path}/notes/{id}"), op, c)
                        .await?;
                    note["suggestions"] = suggestion["suggestions"].clone();
                }
                items.extend(parse::discussion(&discussion, &viewer, can_create_note)?);
            }
            match connection["pageInfo"]["hasNextPage"].as_bool() {
                Some(false) => break,
                Some(true) => {
                    cursor = Some(parse::string(&connection["pageInfo"], "endCursor", op)?);
                    if page + 1 == DISCUSSION_PAGE_LIMIT {
                        truncated = true;
                    }
                }
                None => return Err(parse::invalid(op)),
            }
        }
        items.extend(parse::synthetic_reviews(
            &approvals, &reviewers, &detail, &viewer,
        )?);
        for (suffix, kind) in [
            ("resource_label_events", "label"),
            ("resource_milestone_events", "milestone"),
            ("resource_state_events", "state"),
        ] {
            let events = self
                .api(scope, &format!("{path}/{suffix}?per_page=100"), op, c)
                .await?;
            let values = events.as_array().ok_or_else(|| parse::invalid(op))?;
            truncated |= values.len() >= 100;
            for event in values.iter().take(100) {
                items.push(parse::resource_event(event, kind)?);
            }
        }
        read::sort_timeline(&mut items);
        Ok(Timeline { items, truncated })
    }
}
