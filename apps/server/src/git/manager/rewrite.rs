use std::collections::BTreeSet;

#[must_use]
pub fn build_squash_todo(
    log_order: &[String],
    squashed_shas: &BTreeSet<String>,
    onto_sha: &str,
) -> String {
    let Some(onto_index) = log_order.iter().position(|sha| sha == onto_sha) else {
        return String::new();
    };
    let mut todo = String::new();
    for sha in log_order[..=onto_index].iter().rev() {
        let action = if squashed_shas.contains(sha) {
            "squash"
        } else {
            "pick"
        };
        todo.push_str(action);
        todo.push(' ');
        todo.push_str(sha);
        todo.push('\n');
    }
    todo
}

#[must_use]
pub fn build_reorder_todo(
    log_order: &[String],
    moved_shas: &[String],
    insert_before_sha: Option<&str>,
) -> String {
    let moved = moved_shas.iter().collect::<BTreeSet<_>>();
    let moved_in_log_order = log_order
        .iter()
        .filter(|sha| moved.contains(sha))
        .cloned()
        .collect::<Vec<_>>();
    let mut reordered = log_order
        .iter()
        .filter(|sha| !moved.contains(sha))
        .cloned()
        .collect::<Vec<_>>();
    let insert_at = insert_before_sha
        .and_then(|insert_before| reordered.iter().position(|sha| sha == insert_before))
        .unwrap_or(reordered.len());
    reordered.splice(insert_at..insert_at, moved_in_log_order);

    let mut todo = String::new();
    for sha in reordered.iter().rev() {
        todo.push_str("pick ");
        todo.push_str(sha);
        todo.push('\n');
    }
    todo
}

#[must_use]
pub fn resolve_last_retained_commit_ref(
    oldest_touched_sha: &str,
    parent_of_oldest: Option<&str>,
) -> Option<String> {
    parent_of_oldest.map(|_| format!("{oldest_touched_sha}^"))
}

#[must_use]
pub fn parse_rebase_progress(stderr: &str) -> Option<(u32, u32)> {
    stderr
        .split(['\r', '\n'])
        .filter_map(|line| {
            let progress = line.trim().strip_prefix("Rebasing (")?.strip_suffix(')')?;
            let (current, total) = progress.split_once('/')?;
            Some((current.parse().ok()?, total.parse().ok()?))
        })
        .next_back()
}

#[must_use]
pub fn parse_cherry_pick_progress(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .filter_map(|line| {
            let (header, summary) = line.strip_prefix('[')?.split_once("] ")?;
            if summary.is_empty() {
                return None;
            }
            let sha = header.split_whitespace().last()?;
            (sha.len() >= 4 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .then(|| sha.to_owned())
        })
        .next_back()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn squash_todo_replays_oldest_first_with_a_trailing_newline() {
        let log_order = vec![
            "cccccccc".to_owned(),
            "bbbbbbbb".to_owned(),
            "aaaaaaaa".to_owned(),
            "00000000".to_owned(),
        ];
        let squashed = BTreeSet::from(["bbbbbbbb".to_owned(), "cccccccc".to_owned()]);

        let todo = build_squash_todo(&log_order, &squashed, "aaaaaaaa");

        assert_eq!(todo, "pick aaaaaaaa\nsquash bbbbbbbb\nsquash cccccccc\n");
        assert!(todo.ends_with('\n'));
        assert!(!todo.contains("feature/topic"));
    }

    #[test]
    fn reorder_todo_moves_commits_before_the_requested_sha() {
        let log_order = vec![
            "dddddddd".to_owned(),
            "cccccccc".to_owned(),
            "bbbbbbbb".to_owned(),
            "aaaaaaaa".to_owned(),
        ];

        let todo = build_reorder_todo(&log_order, &["cccccccc".to_owned()], Some("aaaaaaaa"));

        assert_eq!(
            todo,
            "pick aaaaaaaa\npick cccccccc\npick bbbbbbbb\npick dddddddd\n"
        );
    }

    #[test]
    fn retained_ref_uses_the_oldest_touched_parent_or_root() {
        assert_eq!(
            resolve_last_retained_commit_ref("aaaaaaaa", Some("00000000")),
            Some("aaaaaaaa^".to_owned())
        );
        assert_eq!(resolve_last_retained_commit_ref("aaaaaaaa", None), None);
    }

    #[test]
    fn rebase_progress_uses_the_last_completed_progress_line_only() {
        assert_eq!(
            parse_rebase_progress("Rebasing (1/3)\rRebasing (2/3)\nCONFLICT (content): stopped\n"),
            Some((2, 3))
        );
        assert_eq!(
            parse_rebase_progress("Applying: Rebasing documentation\n"),
            None
        );
        assert_eq!(parse_rebase_progress("Rebasing (two/3)\n"), None);
    }

    #[test]
    fn cherry_pick_progress_extracts_only_the_commit_sha() {
        assert_eq!(
            parse_cherry_pick_progress(
                "[main abcdef1] first summary\n[main 0123456789abcdef] second summary\n"
            ),
            Some("0123456789abcdef".to_owned())
        );
        assert_eq!(
            parse_cherry_pick_progress("Auto-merging [main abcdef1] file\n"),
            None
        );
    }
}
