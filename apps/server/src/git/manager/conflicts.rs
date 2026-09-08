use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::git::PorcelainRecord;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictKind {
    Text,
    Binary,
    Submodule,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitManagerConflictState {
    pub path: String,
    pub kind: ConflictKind,
    pub marker_count: u32,
    pub resolution: Option<ConflictSide>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnmergedEntry {
    pub path: String,
    pub code: String,
    pub submodule: bool,
}

impl UnmergedEntry {
    #[must_use]
    pub fn new(path: impl Into<String>, code: impl Into<String>, submodule: bool) -> Self {
        Self {
            path: path.into(),
            code: code.into(),
            submodule,
        }
    }

    #[must_use]
    pub fn side_deleted(&self, side: ConflictSide) -> bool {
        match side {
            ConflictSide::Ours => matches!(self.code.as_str(), "DD" | "DU" | "UA"),
            ConflictSide::Theirs => matches!(self.code.as_str(), "DD" | "UD" | "AU"),
        }
    }
}

#[must_use]
pub fn count_conflict_markers(diff_check_output: &str) -> BTreeMap<String, u32> {
    let mut markers = BTreeMap::new();
    for line in diff_check_output.lines() {
        let Some((location, suffix)) = line.rsplit_once(": leftover conflict marker") else {
            continue;
        };
        if !suffix.is_empty() {
            continue;
        }
        let Some((path, line_number)) = location.rsplit_once(':') else {
            continue;
        };
        if path.is_empty() || line_number.parse::<u64>().is_err() {
            continue;
        }
        let count = markers.entry(path.to_owned()).or_insert(0_u32);
        *count = count.saturating_add(1);
    }
    markers
}

#[must_use]
pub const fn conflicts_from_markers(markers: u32) -> u32 {
    markers.div_ceil(3)
}

#[must_use]
pub fn plan_manual_resolution(
    path: &str,
    side: ConflictSide,
    selected_side_deleted: bool,
) -> Vec<Vec<String>> {
    let checkout_side = match side {
        ConflictSide::Ours => "--ours",
        ConflictSide::Theirs => "--theirs",
    };
    vec![
        vec![
            "checkout".to_owned(),
            checkout_side.to_owned(),
            "--".to_owned(),
            path.to_owned(),
        ],
        vec![
            if selected_side_deleted { "rm" } else { "add" }.to_owned(),
            "--".to_owned(),
            path.to_owned(),
        ],
    ]
}

#[must_use]
pub fn binary_conflict_paths(numstat: &str, merge_attributes: &str) -> BTreeSet<String> {
    let mut paths = numstat
        .split('\0')
        .filter_map(|row| {
            let mut fields = row.splitn(3, '\t');
            let insertions = fields.next()?;
            let deletions = fields.next()?;
            let path = fields.next()?;
            (insertions == "-" && deletions == "-" && !path.is_empty()).then(|| path.to_owned())
        })
        .collect::<BTreeSet<_>>();
    let fields = merge_attributes.split('\0').collect::<Vec<_>>();
    for record in fields.as_chunks::<3>().0 {
        if !record[0].is_empty() && record[1] == "merge" && record[2] == "binary" {
            paths.insert(record[0].to_owned());
        }
    }
    paths
}

#[must_use]
pub fn build_conflict_states(
    entries: &[UnmergedEntry],
    binary_paths: &BTreeSet<String>,
    markers: &BTreeMap<String, u32>,
) -> Vec<GitManagerConflictState> {
    entries
        .iter()
        .map(|entry| GitManagerConflictState {
            path: entry.path.clone(),
            kind: if entry.submodule {
                ConflictKind::Submodule
            } else if binary_paths.contains(&entry.path) {
                ConflictKind::Binary
            } else {
                ConflictKind::Text
            },
            marker_count: markers.get(&entry.path).copied().unwrap_or(0),
            resolution: None,
        })
        .collect()
}

#[must_use]
pub fn unmerged_entries(records: &[PorcelainRecord]) -> Vec<UnmergedEntry> {
    records
        .iter()
        .filter(|record| record.unmerged)
        .map(|record| UnmergedEntry::new(&record.path, &record.status_code, record.submodule))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;

    #[test]
    fn counts_only_leftover_conflict_marker_diagnostics_per_path() {
        let markers = count_conflict_markers(
            "src/a.txt:1: leftover conflict marker\n\
             +<<<<<<< HEAD\n\
             src/a.txt:3: leftover conflict marker\n\
             src/a.txt:5: leftover conflict marker\n\
             path:with:colon.txt:9: leftover conflict marker\n\
             src/clean.txt:4: trailing whitespace.\n",
        );

        assert_eq!(markers.get("src/a.txt"), Some(&3));
        assert_eq!(markers.get("path:with:colon.txt"), Some(&1));
        assert_eq!(markers.len(), 2);
        assert_eq!(conflicts_from_markers(0), 0);
        assert_eq!(conflicts_from_markers(1), 1);
        assert_eq!(conflicts_from_markers(3), 1);
        assert_eq!(conflicts_from_markers(4), 2);
    }

    #[test]
    fn resolution_plan_checks_out_the_side_then_stages_or_removes() {
        assert_eq!(
            plan_manual_resolution("nested/file.txt", ConflictSide::Ours, false),
            vec![
                vec!["checkout", "--ours", "--", "nested/file.txt"],
                vec!["add", "--", "nested/file.txt"],
            ]
        );
        assert_eq!(
            plan_manual_resolution("deleted.txt", ConflictSide::Theirs, true),
            vec![
                vec!["checkout", "--theirs", "--", "deleted.txt"],
                vec!["rm", "--", "deleted.txt"],
            ]
        );
    }

    #[test]
    fn builds_text_binary_and_submodule_conflict_states_from_unmerged_entries() {
        let entries = vec![
            UnmergedEntry::new("text.txt", "UU", false),
            UnmergedEntry::new("image.dat", "AA", false),
            UnmergedEntry::new("vendor/submodule", "UU", true),
        ];
        let numstat = "-\t-\timage.dat\0";
        let attributes = "image.dat\0merge\0binary\0";
        let binary_paths = binary_conflict_paths(numstat, attributes);
        let markers = BTreeMap::from([("text.txt".to_owned(), 4)]);

        let states = build_conflict_states(&entries, &binary_paths, &markers);

        assert_eq!(
            states,
            vec![
                GitManagerConflictState {
                    path: "text.txt".to_owned(),
                    kind: ConflictKind::Text,
                    marker_count: 4,
                    resolution: None,
                },
                GitManagerConflictState {
                    path: "image.dat".to_owned(),
                    kind: ConflictKind::Binary,
                    marker_count: 0,
                    resolution: None,
                },
                GitManagerConflictState {
                    path: "vendor/submodule".to_owned(),
                    kind: ConflictKind::Submodule,
                    marker_count: 0,
                    resolution: None,
                },
            ]
        );
        assert!(build_conflict_states(&[], &BTreeSet::new(), &BTreeMap::new()).is_empty());
    }

    #[test]
    fn selected_deleted_side_is_derived_from_the_unmerged_code() {
        let deleted_by_us = UnmergedEntry::new("ours-deleted.txt", "DU", false);
        let added_by_them = UnmergedEntry::new("theirs-added.txt", "UA", false);
        let deleted_by_them = UnmergedEntry::new("theirs-deleted.txt", "UD", false);
        let added_by_us = UnmergedEntry::new("ours-added.txt", "AU", false);

        assert!(deleted_by_us.side_deleted(ConflictSide::Ours));
        assert!(added_by_them.side_deleted(ConflictSide::Ours));
        assert!(deleted_by_them.side_deleted(ConflictSide::Theirs));
        assert!(added_by_us.side_deleted(ConflictSide::Theirs));
        assert!(!deleted_by_us.side_deleted(ConflictSide::Theirs));
    }

    #[test]
    fn converts_only_porcelain_unmerged_records_into_conflict_entries() {
        let records = [
            crate::git::parse_porcelain_v2_line(
                "u DU S... 160000 000000 160000 160000 aaaaaaa bbbbbbb ccccccc vendor/submodule",
            )
            .expect("unmerged record"),
            crate::git::parse_porcelain_v2_line(
                "1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb ordinary.txt",
            )
            .expect("ordinary record"),
        ];

        assert_eq!(
            unmerged_entries(&records),
            vec![UnmergedEntry::new("vendor/submodule", "DU", true)]
        );
    }
}
