use super::*;
use std::collections::{HashMap, HashSet};

impl GitLabHost {
    pub(super) async fn read_files(
        &self,
        scope: &HostScope,
        number: u64,
        c: &CancellationToken,
    ) -> Result<Files, PullRequestsOperationError> {
        let op = "pullRequests.getFiles";
        let path = format!("{}/merge_requests/{number}", project_path(scope));
        let versions = self.api(scope, &format!("{path}/versions"), op, c).await?;
        let diff_refs = parse::diff_refs(&versions)?;
        let mut result = Files {
            files: vec![],
            diff_refs,
            truncated: false,
        };
        let mut seen = HashSet::new();
        let mut bytes = 0_usize;
        for page in 1..=20 {
            // This JSON envelope carries patches, so it gets the 8 MiB patch budget.
            let output = self
                .runner
                .glab(
                    scope,
                    &["api", &format!("{path}/diffs?per_page=50&page={page}")],
                    Budget::Large,
                    None,
                    c,
                )
                .await;
            let value: Value = match output {
                Ok(output) => {
                    serde_json::from_str(&output.stdout).map_err(|_| parse::invalid(op))?
                }
                Err(failure) => {
                    let error = from_process_error(op, "glab", &failure.error, &failure.stderr);
                    if error.code != "output_limit" {
                        return Err(error);
                    }
                    return self.files_without_patches(scope, number, result, c).await;
                }
            };
            let values = value.as_array().ok_or_else(|| parse::invalid(op))?;
            for v in values {
                bytes = bytes.saturating_add(v["diff"].as_str().map_or(0, str::len));
                let file = parse::file(v)?;
                if seen.insert(file.path.clone()) {
                    result.files.push(file);
                }
            }
            if bytes > 8 * 1024 * 1024 {
                return self.files_without_patches(scope, number, result, c).await;
            }
            if values.len() < 50 {
                break;
            }
            if page == 20 {
                result.truncated = true;
            }
        }
        Ok(result)
    }

    async fn files_without_patches(
        &self,
        scope: &HostScope,
        number: u64,
        mut result: Files,
        c: &CancellationToken,
    ) -> Result<Files, PullRequestsOperationError> {
        let op = "pullRequests.getFiles";
        let metadata = self
            .graphql(scope, number, graphql::FILES_METADATA_QUERY, op, c)
            .await?;
        let values = metadata["data"]["project"]["mergeRequest"]["diffStats"]
            .as_array()
            .ok_or_else(|| parse::invalid(op))?;
        let mut known: HashMap<_, _> = result
            .files
            .drain(..)
            .map(|f| (f.path.clone(), f))
            .collect();
        for v in values {
            let path = parse::string(v, "path", op)?;
            let mut file = known.remove(&path).unwrap_or(File {
                path,
                previous_path: None,
                change_type: ChangeType::Modified,
                additions: v["additions"].as_u64().unwrap_or(0),
                deletions: v["deletions"].as_u64().unwrap_or(0),
                patch: None,
                too_large: true,
            });
            file.patch = None;
            file.too_large = true;
            result.files.push(file);
        }
        // Retain rows already observed even if the host changed during the fallback.
        let mut remaining = known.into_values().collect::<Vec<_>>();
        remaining.sort_by(|a, b| a.path.cmp(&b.path));
        for mut file in remaining {
            file.patch = None;
            file.too_large = true;
            result.files.push(file);
        }
        result.truncated = true;
        Ok(result)
    }
}
