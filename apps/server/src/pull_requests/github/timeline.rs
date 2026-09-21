use super::*;
use crate::pull_requests::read;

impl GitHubHost {
    pub(super) async fn read_timeline(
        &self,
        scope: &HostScope,
        number: u64,
        c: &CancellationToken,
    ) -> Result<Timeline, PullRequestsOperationError> {
        let operation = "pullRequests.getTimeline";
        let (owner, name) = scope
            .repository
            .split_once('/')
            .ok_or_else(|| parse::invalid(operation))?;
        let mut items = Vec::new();
        let mut truncated = false;
        for (key, query) in [
            ("comments", graphql::TIMELINE_COMMENTS_QUERY),
            ("reviews", graphql::TIMELINE_REVIEWS_QUERY),
            ("reviewThreads", graphql::TIMELINE_THREADS_QUERY),
            ("timelineItems", graphql::TIMELINE_EVENTS_QUERY),
        ] {
            let mut cursor = None;
            for page in 0..10 {
                let response = self
                    .graphql(
                        scope,
                        query,
                        json!({"owner":owner,"name":name,"number":number,"cursor":cursor}),
                        operation,
                        c,
                    )
                    .await?;
                let repository = &response["data"]["repository"];
                let pr = &repository["pullRequest"];
                let connection = &pr[key];
                let values = connection["nodes"]
                    .as_array()
                    .ok_or_else(|| parse::invalid(operation))?;
                let permission = parse::repository_permission(
                    repository["viewerPermission"].as_str().unwrap_or_default(),
                );
                let allowed =
                    pr["baseRef"]["refUpdateRule"]["viewerAllowedToDismissReviews"].as_bool();
                for value in values {
                    let mut value = value.clone();
                    if key == "reviewThreads" {
                        truncated |= self.thread_comments(scope, &mut value, c).await?;
                    }
                    items.push(parse::timeline_item(key, &value, permission, allowed)?);
                }
                cursor = page_cursor(connection, operation)?;
                if cursor.is_none() {
                    break;
                }
                if page == 9 {
                    truncated = true;
                }
            }
        }
        read::sort_timeline(&mut items);
        Ok(Timeline { items, truncated })
    }

    async fn thread_comments(
        &self,
        scope: &HostScope,
        thread: &mut Value,
        c: &CancellationToken,
    ) -> Result<bool, PullRequestsOperationError> {
        let operation = "pullRequests.getTimeline";
        let mut cursor = page_cursor(&thread["comments"], operation)?;
        let mut comments = thread["comments"]["nodes"]
            .as_array()
            .ok_or_else(|| parse::invalid(operation))?
            .clone();
        for _ in 1..10 {
            if cursor.is_none() {
                break;
            }
            let response = self
                .graphql(
                    scope,
                    graphql::TIMELINE_THREAD_COMMENTS_QUERY,
                    json!({"id":thread["id"],"cursor":cursor}),
                    operation,
                    c,
                )
                .await?;
            let connection = &response["data"]["node"]["comments"];
            comments.extend(
                connection["nodes"]
                    .as_array()
                    .ok_or_else(|| parse::invalid(operation))?
                    .iter()
                    .cloned(),
            );
            cursor = page_cursor(connection, operation)?;
        }
        thread["comments"]["nodes"] = Value::Array(comments);
        Ok(cursor.is_some())
    }
}

fn page_cursor(
    connection: &Value,
    operation: &str,
) -> Result<Option<String>, PullRequestsOperationError> {
    match connection["pageInfo"]["hasNextPage"].as_bool() {
        Some(false) => Ok(None),
        Some(true) => Ok(Some(parse::string(
            &connection["pageInfo"],
            "endCursor",
            operation,
        )?)),
        None => Err(parse::invalid(operation)),
    }
}
