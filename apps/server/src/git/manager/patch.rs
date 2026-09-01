//! Pure parsing and formatting for partial Git patches.

use std::collections::BTreeSet;

use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DiffLineKind {
    Context,
    Added,
    Deleted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DiffLine {
    kind: DiffLineKind,
    content: String,
    no_newline: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DiffHunk {
    old_start: usize,
    new_start: usize,
    lines: Vec<DiffLine>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedFileDiff {
    original: String,
    headers: Vec<String>,
    hunks: Vec<DiffHunk>,
}

pub fn parse_working_tree_diff(diff: &str) -> ParsedFileDiff {
    let diff = diff
        .find("diff --git ")
        .map_or(diff, |patch_start| &diff[patch_start..]);
    let mut headers = Vec::new();
    let mut hunks = Vec::new();
    let mut current_hunk: Option<DiffHunk> = None;

    for line in diff.lines() {
        if line.starts_with("@@ ") {
            if let Some(hunk) = current_hunk.take() {
                hunks.push(hunk);
            }
            let (old_start, new_start) = parse_hunk_starts(line).unwrap_or((0, 0));
            current_hunk = Some(DiffHunk {
                old_start,
                new_start,
                lines: Vec::new(),
            });
        } else if line == "\\ No newline at end of file" {
            if let Some(line) = current_hunk.as_mut().and_then(|hunk| hunk.lines.last_mut()) {
                line.no_newline = true;
            }
        } else if let Some(hunk) = current_hunk.as_mut() {
            let (kind, content) = match line.as_bytes().first() {
                Some(b'+') => (DiffLineKind::Added, &line[1..]),
                Some(b'-') => (DiffLineKind::Deleted, &line[1..]),
                Some(b' ') => (DiffLineKind::Context, &line[1..]),
                _ => continue,
            };
            hunk.lines.push(DiffLine {
                kind,
                content: content.to_owned(),
                no_newline: false,
            });
        } else {
            headers.push(line.to_owned());
        }
    }
    if let Some(hunk) = current_hunk {
        hunks.push(hunk);
    }

    ParsedFileDiff {
        original: diff.to_owned(),
        headers,
        hunks,
    }
}

#[must_use]
pub fn diff_generation(diff: &ParsedFileDiff) -> u64 {
    let mut digest = Sha256::new();
    for hunk in &diff.hunks {
        digest.update(hunk.old_start.to_be_bytes());
        digest.update(hunk.new_start.to_be_bytes());
        for line in &hunk.lines {
            digest.update([match line.kind {
                DiffLineKind::Context => b' ',
                DiffLineKind::Added => b'+',
                DiffLineKind::Deleted => b'-',
            }]);
            digest.update(line.content.len().to_be_bytes());
            digest.update(line.content.as_bytes());
            digest.update([u8::from(line.no_newline)]);
        }
    }
    let bytes: [u8; 8] = digest.finalize()[..8]
        .try_into()
        .expect("SHA-256 prefix has a fixed length");
    u64::from_be_bytes(bytes)
}

pub fn format_selection_patch(diff: &ParsedFileDiff, selected_lines: &[usize]) -> Option<String> {
    let selected = selected_lines.iter().copied().collect::<BTreeSet<_>>();
    if selected.is_empty() {
        return None;
    }
    let body_len: usize = diff.hunks.iter().map(|hunk| hunk.lines.len()).sum();
    if body_len > 0 && (0..body_len).all(|index| selected.contains(&index)) {
        return Some(diff.original.clone());
    }

    let mut patch = patch_headers(diff);
    let headers_len = patch.len();
    let mut body_offset = 0;
    let mut selected_delta = 0_isize;

    for hunk in &diff.hunks {
        let mut block_start = 0;
        while block_start < hunk.lines.len() {
            while block_start < hunk.lines.len()
                && hunk.lines[block_start].kind == DiffLineKind::Context
            {
                block_start += 1;
            }
            if block_start == hunk.lines.len() {
                break;
            }
            let mut block_end = block_start;
            while block_end < hunk.lines.len()
                && hunk.lines[block_end].kind != DiffLineKind::Context
            {
                block_end += 1;
            }

            let selected_in_block = (block_start..block_end).any(|index| {
                selected.contains(&(body_offset + index))
                    && hunk.lines[index].kind != DiffLineKind::Context
            });
            if selected_in_block {
                append_selected_block(
                    &mut patch,
                    hunk,
                    block_start,
                    block_end,
                    body_offset,
                    &selected,
                    &mut selected_delta,
                );
            }
            block_start = block_end;
        }
        body_offset += hunk.lines.len();
    }

    (patch.len() > headers_len).then_some(patch)
}

fn patch_headers(diff: &ParsedFileDiff) -> String {
    let old_header = diff.headers.iter().find(|line| line.starts_with("--- "));
    let new_header = diff.headers.iter().find(|line| line.starts_with("+++ "));
    let partial_new_or_deleted_file = old_header.is_some_and(|line| line == "--- /dev/null")
        || new_header.is_some_and(|line| line == "+++ /dev/null");
    let mut normalized = Vec::with_capacity(diff.headers.len());
    for header in &diff.headers {
        if partial_new_or_deleted_file
            && (header.starts_with("new file mode ") || header.starts_with("deleted file mode "))
        {
            continue;
        }
        if header == "--- /dev/null"
            && let Some(path) = new_header.and_then(|line| line.strip_prefix("+++ b/"))
        {
            normalized.push(format!("--- a/{path}"));
            continue;
        }
        if header == "+++ /dev/null"
            && let Some(path) = old_header.and_then(|line| line.strip_prefix("--- a/"))
        {
            normalized.push(format!("+++ b/{path}"));
            continue;
        }
        normalized.push(header.clone());
    }

    let mut patch = normalized.join("\n");
    if !patch.is_empty() {
        patch.push('\n');
    }
    patch
}

fn position_before(hunk: &DiffHunk, index: usize) -> (usize, usize) {
    let mut old_line = hunk.old_start;
    let mut new_line = hunk.new_start;
    for line in &hunk.lines[..index] {
        match line.kind {
            DiffLineKind::Context => {
                old_line += 1;
                new_line += 1;
            }
            DiffLineKind::Added => new_line += 1,
            DiffLineKind::Deleted => old_line += 1,
        }
    }
    (old_line, new_line)
}

fn append_selected_block(
    patch: &mut String,
    hunk: &DiffHunk,
    start: usize,
    end: usize,
    body_offset: usize,
    selected: &BTreeSet<usize>,
    selected_delta: &mut isize,
) {
    let mut output = Vec::new();
    let mut selected_additions = 0_usize;
    let mut selected_deletions = 0_usize;
    for (index, line) in hunk.lines[start..end].iter().enumerate() {
        let global_index = body_offset + start + index;
        let is_selected = selected.contains(&global_index);
        match (line.kind, is_selected) {
            (DiffLineKind::Added, true) => {
                output.push(('+', line));
                selected_additions += 1;
            }
            (DiffLineKind::Deleted, true) => {
                output.push(('-', line));
                selected_deletions += 1;
            }
            (DiffLineKind::Deleted, false) => output.push((' ', line)),
            (DiffLineKind::Added, false) | (DiffLineKind::Context, _) => {}
        }
    }
    if output.is_empty() {
        return;
    }

    let (old_position, _) = position_before(hunk, start);
    let old_count = output
        .iter()
        .filter(|(prefix, _)| matches!(prefix, ' ' | '-'))
        .count();
    let new_count = output
        .iter()
        .filter(|(prefix, _)| matches!(prefix, ' ' | '+'))
        .count();
    let old_start = if old_count == 0 {
        old_position.saturating_sub(1)
    } else {
        old_position
    };
    let new_start = shifted_line(old_position, *selected_delta).max(usize::from(new_count > 0));
    patch.push_str(&format!(
        "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"
    ));
    for (prefix, line) in output {
        patch.push(prefix);
        patch.push_str(&line.content);
        patch.push('\n');
        if line.no_newline {
            patch.push_str("\\ No newline at end of file\n");
        }
    }
    *selected_delta += selected_additions as isize - selected_deletions as isize;
}

fn shifted_line(line: usize, delta: isize) -> usize {
    if delta.is_negative() {
        line.saturating_sub(delta.unsigned_abs())
    } else {
        line.saturating_add(delta as usize)
    }
}

fn parse_hunk_starts(header: &str) -> Option<(usize, usize)> {
    let mut ranges = header.split_whitespace();
    (ranges.next()? == "@@").then_some(())?;
    let old = ranges.next()?.strip_prefix('-')?;
    let new = ranges.next()?.strip_prefix('+')?;
    Some((parse_range_start(old)?, parse_range_start(new)?))
}

fn parse_range_start(range: &str) -> Option<usize> {
    range.split(',').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::{diff_generation, format_selection_patch, parse_working_tree_diff};

    #[test]
    fn a_selection_of_one_added_line_produces_a_zero_context_patch_for_that_line_only() {
        let diff = concat!(
            "diff --git a/f.txt b/f.txt\n",
            "--- a/f.txt\n",
            "+++ b/f.txt\n",
            "@@ -1,1 +1,3 @@\n",
            " keep\n",
            "+one\n",
            "+two\n",
        );

        // Unified-diff line indices are 0-based over the body of the diff.
        let patch = format_selection_patch(&parse_working_tree_diff(diff), &[1]).expect("a patch");

        assert!(patch.contains("@@ -1,0 +2,1 @@"), "{patch:?}");
        assert!(patch.contains("+one"));
        assert!(!patch.contains("+two"));
    }

    #[test]
    fn a_selection_of_one_deleted_line_keeps_unselected_deletions_as_context() {
        let diff = concat!(
            "diff --git a/f.txt b/f.txt\n",
            "--- a/f.txt\n",
            "+++ b/f.txt\n",
            "@@ -1,3 +1,1 @@\n",
            " keep\n",
            "-one\n",
            "-two\n",
        );

        let patch = format_selection_patch(&parse_working_tree_diff(diff), &[1]).expect("a patch");

        assert!(patch.contains("@@ -2,2 +2,1 @@"), "{patch:?}");
        assert!(patch.contains("-one\n"));
        assert!(patch.contains(" two\n"));
        assert!(!patch.contains("-two\n"));
    }

    #[test]
    fn a_mixed_selection_across_two_hunks_emits_two_minimal_hunks() {
        let diff = concat!(
            "diff --git a/f.txt b/f.txt\n",
            "--- a/f.txt\n",
            "+++ b/f.txt\n",
            "@@ -1,2 +1,2 @@\n",
            "-old-a\n",
            "+new-a\n",
            " keep-a\n",
            "@@ -10,2 +10,2 @@\n",
            " keep-b\n",
            "-old-b\n",
            "+new-b\n",
        );

        let patch =
            format_selection_patch(&parse_working_tree_diff(diff), &[1, 4]).expect("a patch");

        assert_eq!(patch.matches("@@ -").count(), 2, "{patch:?}");
        assert!(patch.contains("+new-a\n"));
        assert!(patch.contains("-old-b\n"));
        assert!(!patch.contains("-old-a\n"));
        assert!(!patch.contains("+new-b\n"));
    }

    #[test]
    fn no_newline_markers_stay_attached_to_the_lines_they_describe() {
        let diff = concat!(
            "diff --git a/f.txt b/f.txt\n",
            "--- a/f.txt\n",
            "+++ b/f.txt\n",
            "@@ -1 +1 @@\n",
            "-old\n",
            "\\ No newline at end of file\n",
            "+new\n",
            "\\ No newline at end of file\n",
        );

        let patch = format_selection_patch(&parse_working_tree_diff(diff), &[1]).expect("a patch");

        assert_eq!(
            patch.matches("\\ No newline at end of file").count(),
            2,
            "{patch:?}"
        );
        assert!(patch.contains(" old\n\\ No newline at end of file\n"));
        assert!(patch.contains("+new\n\\ No newline at end of file\n"));
    }

    #[test]
    fn an_empty_selection_produces_no_patch() {
        let diff = concat!(
            "diff --git a/f.txt b/f.txt\n",
            "--- a/f.txt\n",
            "+++ b/f.txt\n",
            "@@ -1 +1 @@\n",
            "-old\n",
            "+new\n",
        );

        assert_eq!(
            format_selection_patch(&parse_working_tree_diff(diff), &[]),
            None
        );
    }

    #[test]
    fn selecting_every_body_line_reproduces_the_complete_diff() {
        let diff = concat!(
            "diff --git a/f.txt b/f.txt\n",
            "index 3367afd..3e75765 100644\n",
            "--- a/f.txt\n",
            "+++ b/f.txt\n",
            "@@ -1,3 +1,3 @@ heading\n",
            " keep\n",
            "-old\n",
            "+new\n",
            " tail\n",
        );

        assert_eq!(
            format_selection_patch(&parse_working_tree_diff(diff), &[0, 1, 2, 3]).as_deref(),
            Some(diff)
        );
    }

    #[test]
    fn diff_generation_tracks_selection_coordinates_not_transport_headers() {
        let no_index = concat!(
            "diff --git a/f.txt b/f.txt\n",
            "--- /dev/null\n",
            "+++ b/f.txt\n",
            "@@ -0,0 +1,1 @@\n",
            "+one\n",
        );
        let intent_to_add = concat!(
            ":000000 100644 0000000 0000000 A\0f.txt\0diff --git a/f.txt b/f.txt\n",
            "--- a/f.txt\n",
            "+++ b/f.txt\n",
            "@@ -0,0 +1,1 @@\n",
            "+one\n",
        );
        let changed = intent_to_add.replace("+one\n", "+two\n");

        assert_eq!(
            diff_generation(&parse_working_tree_diff(no_index)),
            diff_generation(&parse_working_tree_diff(intent_to_add))
        );
        assert_ne!(
            diff_generation(&parse_working_tree_diff(intent_to_add)),
            diff_generation(&parse_working_tree_diff(&changed))
        );
    }

    #[test]
    fn a_partial_new_file_patch_uses_ordinary_file_headers() {
        let diff = concat!(
            "diff --git a/f.txt b/f.txt\n",
            "new file mode 100644\n",
            "index 0000000..1234567\n",
            "--- /dev/null\n",
            "+++ b/f.txt\n",
            "@@ -0,0 +1,2 @@\n",
            "+one\n",
            "+two\n",
        );

        let patch = format_selection_patch(&parse_working_tree_diff(diff), &[0]).expect("a patch");

        assert!(!patch.contains("new file mode"), "{patch:?}");
        assert!(patch.contains("--- a/f.txt\n"), "{patch:?}");
        assert!(patch.contains("+++ b/f.txt\n"), "{patch:?}");
    }
}
