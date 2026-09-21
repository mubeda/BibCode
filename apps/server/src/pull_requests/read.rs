//! Shared normalization helpers for bounded, explicit detail reads.
use super::model::*;
use std::collections::HashSet;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(super) fn sort_timeline(items: &mut Vec<TimelineItem>) {
    let mut ids = HashSet::new();
    items.retain(|item| {
        ids.insert(match item {
            TimelineItem::Comment { id, .. }
            | TimelineItem::Review { id, .. }
            | TimelineItem::Thread { id, .. }
            | TimelineItem::Event { id, .. } => id.clone(),
        })
    });
    items.sort_by_cached_key(|item| {
        let date = match item {
            TimelineItem::Comment { created_at, .. } | TimelineItem::Event { created_at, .. } => {
                created_at.as_str()
            }
            TimelineItem::Review { submitted_at, .. } => submitted_at.as_str(),
            TimelineItem::Thread { comments, .. } => {
                comments.first().map_or("", |c| c.created_at.as_str())
            }
        };
        (OffsetDateTime::parse(date, &Rfc3339).ok(), date.to_owned())
    });
}

pub(super) fn suggestion(
    body: &str,
    line: u64,
    start: Option<u64>,
    hunk: &str,
) -> Option<Suggestion> {
    let mut lines = body.lines();
    let fence = lines
        .find(|line| line.trim() == "```suggestion" || line.trim().starts_with("```suggestion:"))?;
    let mut from = start.unwrap_or(line);
    let mut to = line;
    if let Some(range) = fence.trim().strip_prefix("```suggestion:-")
        && let Some((before, after)) = range.split_once('+')
        && let (Ok(before), Ok(after)) = (before.parse::<u64>(), after.parse::<u64>())
    {
        from = line.saturating_sub(before);
        to = line.saturating_add(after);
    }
    let mut replacement = Vec::new();
    let mut closed = false;
    for line in lines {
        if line.trim() == "```" {
            closed = true;
            break;
        }
        replacement.push(line);
    }
    if !closed {
        return None;
    }
    let mut new_line = 0;
    let mut original = Vec::new();
    for row in hunk.lines() {
        if row.starts_with("@@ ") {
            new_line = row
                .split_whitespace()
                .nth(2)
                .and_then(|r| r.trim_start_matches('+').split(',').next())
                .and_then(|r| r.parse::<u64>().ok())
                .unwrap_or(0);
        } else if row.starts_with([' ', '+']) {
            if (from..=to).contains(&new_line) {
                original.push(&row[1..]);
            }
            new_line = new_line.saturating_add(1);
        }
    }
    Some(Suggestion {
        id: None,
        applicable: false,
        from_line: from,
        to_line: to,
        from_content: original.join("\n"),
        to_content: replacement.join("\n"),
    })
}

pub(super) const FILE_PATCH_LIMIT: usize = 1024 * 1024;

pub(super) fn set_patch(file: &mut File, patch: String) {
    if patch.len() > FILE_PATCH_LIMIT {
        file.patch = None;
        file.too_large = true;
    } else if patch
        .lines()
        .any(|line| line.starts_with("Binary files ") || line == "GIT binary patch")
    {
        file.patch = None;
        file.change_type = ChangeType::Binary;
    } else {
        file.patch = Some(patch);
    }
}

pub(super) fn duration(started: Option<&str>, completed: Option<&str>) -> Option<f64> {
    let started = OffsetDateTime::parse(started?, &Rfc3339).ok()?;
    let completed = OffsetDateTime::parse(completed?, &Rfc3339).ok()?;
    let seconds = (completed - started).as_seconds_f64();
    (seconds >= 0.0).then_some(seconds)
}

pub(super) fn grouped_checks(
    rows: impl IntoIterator<Item = (String, Check)>,
    pipeline_url: Option<String>,
) -> Checks {
    let mut groups: Vec<CheckGroup> = Vec::new();
    let mut indices = std::collections::HashMap::new();
    let mut summary = CheckSummary::None;
    for (name, check) in rows {
        summary = match (summary, check.state) {
            (CheckSummary::Failure, _) | (_, CheckState::Failure) => CheckSummary::Failure,
            (CheckSummary::Pending, _) | (_, CheckState::Pending) => CheckSummary::Pending,
            _ => CheckSummary::Success,
        };
        let index = *indices.entry(name.clone()).or_insert_with(|| {
            groups.push(CheckGroup {
                name,
                checks: vec![],
            });
            groups.len() - 1
        });
        groups[index].checks.push(check);
    }
    Checks {
        groups,
        summary,
        pipeline_url,
    }
}
