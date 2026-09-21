//! Map review drafts to the immutable version's paths and diff coordinates.
use std::collections::HashMap;

use serde_json::{Value, json};

use crate::pull_requests::{
    action::OP,
    error::PullRequestsOperationError,
    model::{DiffRefs, DiffSide, ReviewComment},
};

pub(super) fn positions(
    diffs: &[Value],
    refs: &DiffRefs,
    comments: &[ReviewComment],
) -> Vec<Result<Value, PullRequestsOperationError>> {
    let mut result = vec![Err(unavailable()); comments.len()];
    let mut new_paths = HashMap::new();
    let mut old_paths = HashMap::new();
    for (index, file) in diffs.iter().enumerate() {
        for (map, key) in [(&mut new_paths, "new_path"), (&mut old_paths, "old_path")] {
            if let Some(path) = file[key].as_str() {
                // Ambiguous host metadata must never choose a file arbitrarily.
                map.entry(path)
                    .and_modify(|v| *v = usize::MAX)
                    .or_insert(index);
            }
        }
    }
    let mut grouped = vec![Vec::new(); diffs.len()];
    for (index, comment) in comments.iter().enumerate() {
        let file = new_paths.get(comment.path.as_str()).or_else(|| {
            (comment.side == DiffSide::Left)
                .then(|| old_paths.get(comment.path.as_str()))
                .flatten()
        });
        if let Some(file) = file.and_then(|index| grouped.get_mut(*index)) {
            file.push(index);
        }
    }
    for (file, indices) in diffs.iter().zip(grouped) {
        if indices.is_empty() || file["too_large"] == true || file["collapsed"] == true {
            continue;
        }
        let (Some(old_path), Some(new_path), Some(diff)) = (
            file["old_path"].as_str(),
            file["new_path"].as_str(),
            file["diff"].as_str(),
        ) else {
            continue;
        };
        let mut wanted: HashMap<(bool, u64), Vec<usize>> = HashMap::new();
        for index in indices {
            let comment = &comments[index];
            wanted
                .entry((comment.side == DiffSide::Right, comment.line))
                .or_default()
                .push(index);
        }
        let mut hunk = None;
        // Each selected file is scanned once; memory grows with drafts, not diff lines.
        for line in diff.lines() {
            if line.starts_with("@@ ") {
                hunk = Hunk::parse(line);
                continue;
            }
            if line.starts_with('\\') {
                continue;
            }
            let Some(active) = hunk.as_mut() else {
                continue;
            };
            let Some((old, new)) = active.advance(line.as_bytes().first().copied()) else {
                hunk = None;
                continue;
            };
            for (side, coordinate) in [(false, old), (true, new)] {
                let Some(indices) = coordinate.and_then(|n| wanted.remove(&(side, n))) else {
                    continue;
                };
                for index in indices {
                    let mut position = json!({"base_sha":refs.base_sha,"start_sha":refs.start_sha,"head_sha":refs.head_sha,"position_type":"text","old_path":old_path,"new_path":new_path});
                    if let Some(old) = old {
                        position["old_line"] = json!(old);
                    }
                    if let Some(new) = new {
                        position["new_line"] = json!(new);
                    }
                    result[index] = Ok(position);
                }
            }
            if wanted.is_empty() {
                break;
            }
        }
    }
    result
}

fn unavailable() -> PullRequestsOperationError {
    let mut error = PullRequestsOperationError::new(OP, "host_rejected");
    error.message = "This line is not available in the selected diff. Refresh and choose a visible diff line before retrying.".into();
    error
}

struct Hunk {
    old: u64,
    new: u64,
    old_left: u64,
    new_left: u64,
}
impl Hunk {
    fn parse(header: &str) -> Option<Self> {
        let mut parts = header.strip_prefix("@@ ")?.split_whitespace();
        let (old, old_left) = range(parts.next()?.strip_prefix('-')?)?;
        let (new, new_left) = range(parts.next()?.strip_prefix('+')?)?;
        if parts.next()? != "@@" {
            return None;
        }
        Some(Self {
            old,
            new,
            old_left,
            new_left,
        })
    }
    fn advance(&mut self, prefix: Option<u8>) -> Option<(Option<u64>, Option<u64>)> {
        let (uses_old, uses_new) = match prefix {
            Some(b' ') => (true, true),
            Some(b'-') => (true, false),
            Some(b'+') => (false, true),
            _ => return None,
        };
        let old = uses_old.then_some(self.old);
        let new = uses_new.then_some(self.new);
        if uses_old {
            self.old_left = self.old_left.checked_sub(1)?;
            self.old = self.old.checked_add(1)?;
        }
        if uses_new {
            self.new_left = self.new_left.checked_sub(1)?;
            self.new = self.new.checked_add(1)?;
        }
        Some((old, new))
    }
}
fn range(value: &str) -> Option<(u64, u64)> {
    let (start, count) = value.split_once(',').unwrap_or((value, "1"));
    Some((start.parse().ok()?, count.parse().ok()?))
}
