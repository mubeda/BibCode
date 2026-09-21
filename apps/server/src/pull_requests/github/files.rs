//! Split bounded host patch output without letting an oversized file hide its row.
use crate::pull_requests::{model::*, read};
use std::collections::HashMap;

pub(super) fn attach_patches(files: &mut Files, patch: &str) {
    let indices: HashMap<_, _> = files
        .files
        .iter()
        .enumerate()
        .map(|(i, f)| (f.path.clone(), i))
        .collect();
    let mut starts = patch
        .match_indices("diff --git ")
        .filter(|(i, _)| *i == 0 || patch.as_bytes()[i - 1] == b'\n')
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    starts.push(patch.len());
    for range in starts.windows(2) {
        let part = &patch[range[0]..range[1]];
        let headers = part
            .lines()
            .take_while(|line| !line.starts_with("@@ "))
            .collect::<Vec<_>>();
        let old = headers
            .iter()
            .find_map(|l| l.strip_prefix("--- "))
            .map(git_path)
            .filter(|p| p != "/dev/null");
        let new = headers
            .iter()
            .find_map(|l| l.strip_prefix("+++ "))
            .map(git_path)
            .filter(|p| p != "/dev/null")
            .or_else(|| {
                headers
                    .iter()
                    .find_map(|l| {
                        l.strip_prefix("rename to ")
                            .or_else(|| l.strip_prefix("copy to "))
                    })
                    .map(unquote)
            })
            .or_else(|| old.clone())
            .or_else(|| header_destination(headers.first().copied().unwrap_or_default()));
        let Some(index) = new.as_ref().and_then(|p| indices.get(p)).copied() else {
            continue;
        };
        let file = &mut files.files[index];
        file.previous_path = headers
            .iter()
            .find_map(|l| {
                l.strip_prefix("rename from ")
                    .or_else(|| l.strip_prefix("copy from "))
            })
            .map(unquote)
            .or_else(|| old.filter(|p| p != &file.path));
        if file.too_large || file.change_type == ChangeType::Binary {
            continue;
        }
        let prior = file.patch.take().unwrap_or_default();
        read::set_patch(file, format!("{prior}{part}"));
    }
}

fn header_destination(header: &str) -> Option<String> {
    if let Some((_, new)) = header.rsplit_once(" b/") {
        return Some(new.to_owned());
    }
    let (_, new) = header.rsplit_once(" \"b/")?;
    Some(git_path(&format!("\"b/{new}")))
}

fn git_path(value: &str) -> String {
    let path = unquote(value.trim_end_matches('\t'));
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(&path)
        .to_owned()
}

fn unquote(value: &str) -> String {
    let Some(value) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) else {
        return value.to_owned();
    };
    let mut result = Vec::new();
    let mut bytes = value.bytes();
    while let Some(b) = bytes.next() {
        if b != b'\\' {
            result.push(b);
            continue;
        }
        let Some(escaped) = bytes.next() else {
            break;
        };
        result.push(match escaped {
            b'n' => b'\n',
            b't' => b'\t',
            b'r' => b'\r',
            b'a' => 7,
            b'b' => 8,
            b'v' => 11,
            b'f' => 12,
            b'0'..=b'7' => {
                let mut n = escaped - b'0';
                for _ in 0..2 {
                    if let Some(digit) = bytes.clone().next().filter(|d| (b'0'..=b'7').contains(d))
                    {
                        bytes.next();
                        n = n.wrapping_mul(8).wrapping_add(digit - b'0');
                    } else {
                        break;
                    }
                }
                n
            }
            _ => escaped,
        });
    }
    String::from_utf8_lossy(&result).into_owned()
}

impl super::GitHubHost {
    pub(super) async fn complete_file_list(
        &self,
        scope: &crate::pull_requests::host::HostScope,
        number: u64,
        files: &mut Files,
        c: &tokio_util::sync::CancellationToken,
    ) -> Result<(), crate::pull_requests::error::PullRequestsOperationError> {
        use super::{graphql, parse};
        use serde_json::json;
        let op = "pullRequests.getFiles";
        let (owner, name) = scope
            .repository
            .split_once('/')
            .ok_or_else(|| parse::invalid(op))?;
        let mut cursor = None;
        let mut rows = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for page in 0..10 {
            let value = self
                .graphql(
                    scope,
                    graphql::FILES_QUERY,
                    json!({"owner":owner,"name":name,"number":number,"cursor":cursor}),
                    op,
                    c,
                )
                .await?;
            let connection = &value["data"]["repository"]["pullRequest"]["files"];
            for file in parse::file_rows(&connection["nodes"])? {
                if seen.insert(file.path.clone()) {
                    rows.push(file);
                }
            }
            match connection["pageInfo"]["hasNextPage"].as_bool() {
                Some(false) => break,
                Some(true) => {
                    cursor = Some(parse::string(&connection["pageInfo"], "endCursor", op)?);
                    if page == 9 {
                        files.truncated = true;
                    }
                }
                None => return Err(parse::invalid(op)),
            }
        }
        files.files = rows;
        Ok(())
    }
}
