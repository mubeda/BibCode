use super::*;
use crate::pull_requests::read;
use futures_util::future::join_all;

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
        let approvals_path = format!("{path}/approvals");
        let reviewers_path = format!("{path}/reviewers");
        let labels_path = format!("{path}/resource_label_events?per_page=100");
        let milestones_path = format!("{path}/resource_milestone_events?per_page=100");
        let states_path = format!("{path}/resource_state_events?per_page=100");
        let (viewer, detail, approvals, reviewers, labels, milestones, states, discussions) = tokio::join!(
            self.viewer(scope, op, c),
            self.api(scope, &path, op, c),
            self.api(scope, &approvals_path, op, c),
            self.api(scope, &reviewers_path, op, c),
            self.api(scope, &labels_path, op, c),
            self.api(scope, &milestones_path, op, c),
            self.api(scope, &states_path, op, c),
            self.read_discussions(scope, number, &path, op, c),
        );
        let viewer = viewer?;
        let detail = detail?;
        let approvals = approvals?;
        let reviewers = reviewers?;
        let (discussions, mut truncated) = discussions?;
        let mut items = Vec::new();
        for (discussion, can_create_note) in discussions {
            items.extend(parse::discussion(&discussion, &viewer, can_create_note)?);
        }
        items.extend(parse::synthetic_reviews(
            &approvals, &reviewers, &detail, &viewer,
        )?);
        for (events, kind) in [
            (labels, "label"),
            (milestones, "milestone"),
            (states, "state"),
        ] {
            let events = events?;
            let values = events.as_array().ok_or_else(|| parse::invalid(op))?;
            truncated |= values.len() >= 100;
            for event in values.iter().take(100) {
                items.push(parse::resource_event(event, kind)?);
            }
        }
        read::sort_timeline(&mut items);
        Ok(Timeline { items, truncated })
    }

    async fn read_discussions(
        &self,
        scope: &HostScope,
        number: u64,
        path: &str,
        op: &str,
        c: &CancellationToken,
    ) -> Result<(Vec<(Value, bool)>, bool), PullRequestsOperationError> {
        let mut discussions = Vec::new();
        let mut truncated = false;
        let mut cursor = None;
        let mut suggestion_reads = 0;
        for page in 0..DISCUSSION_PAGE_LIMIT {
            let response = self
                .graphql_with_variables(
                    scope,
                    graphql::TIMELINE_QUERY,
                    json!({"projectPath":scope.repository,"iid":number.to_string(),"cursor":cursor}),
                    op,
                    c,
                )
                .await?;
            let request = &response["data"]["project"]["mergeRequest"];
            let can_create_note = request["userPermissions"]["createNote"]
                .as_bool()
                .unwrap_or(false);
            let connection = &request["discussions"];
            let values = connection["nodes"]
                .as_array()
                .ok_or_else(|| parse::invalid(op))?;
            truncated |= values.len() > 100;
            let mut page_discussions = Vec::new();
            let mut jobs = Vec::new();
            for value in values.iter().take(100) {
                let (discussion, nested_truncated) = parse::graphql_discussion(value)?;
                truncated |= nested_truncated;
                let notes = discussion["notes"]
                    .as_array()
                    .ok_or_else(|| parse::invalid(op))?;
                for (note_index, note) in notes.iter().enumerate() {
                    if !suggestion_note(note) {
                        continue;
                    }
                    if suggestion_reads == SUGGESTION_READ_LIMIT {
                        truncated = true;
                        continue;
                    }
                    suggestion_reads += 1;
                    let id = note["id"].as_u64().ok_or_else(|| parse::invalid(op))?;
                    jobs.push((page_discussions.len(), note_index, id));
                }
                page_discussions.push((discussion, can_create_note));
            }
            let paths: Vec<String> = jobs
                .iter()
                .map(|(_, _, id)| format!("{path}/notes/{id}"))
                .collect();
            let fetched = join_all(
                paths
                    .iter()
                    .map(|note_path| self.api(scope, note_path, op, c)),
            )
            .await;
            for ((discussion_index, note_index, _), suggestion) in jobs.into_iter().zip(fetched) {
                let suggestion = suggestion?;
                page_discussions[discussion_index].0["notes"][note_index]["suggestions"] =
                    suggestion["suggestions"].clone();
            }
            discussions.extend(page_discussions);
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
        Ok((discussions, truncated))
    }
}

fn suggestion_note(note: &Value) -> bool {
    note["system"].as_bool() != Some(true)
        && note["position"].is_object()
        && note["body"].as_str().is_some_and(|body| {
            body.lines().any(|line| {
                let line = line.trim();
                line == "```suggestion" || line.starts_with("```suggestion:")
            })
        })
}
