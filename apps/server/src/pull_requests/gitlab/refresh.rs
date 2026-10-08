#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ListFingerprint {
    pub updated_at: String,
    pub state: String,
    pub checks_summary: Option<String>,
    pub review_decision: Option<String>,
    pub comment_count: u64,
    pub approvals: Option<(u64, u64)>,
    pub unresolved_threads: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ProbeFingerprint {
    pub updated_at: String,
    pub user_notes_count: u64,
    pub pipeline_id: Option<u64>,
    pub pipeline_status: Option<String>,
}

#[derive(Clone, Copy)]
pub(crate) struct ActiveTab {
    pub commits: bool,
    pub files: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct RefreshNames {
    pub detail: bool,
    pub timeline: bool,
    pub commits: bool,
    pub checks: bool,
    pub files: bool,
}

impl RefreshNames {
    fn none() -> Self {
        Self {
            detail: false,
            timeline: false,
            commits: false,
            checks: false,
            files: false,
        }
    }
}

pub(super) fn list_changed(previous: &[ListFingerprint], next: &[ListFingerprint]) -> bool {
    if previous.len() != next.len() {
        return true;
    }
    previous.iter().zip(next.iter()).any(|(a, b)| a != b)
}

pub(super) fn detail_refresh(
    previous: &ProbeFingerprint,
    next: &ProbeFingerprint,
    tab: ActiveTab,
) -> RefreshNames {
    let notes = previous.user_notes_count != next.user_notes_count;
    let updated = previous.updated_at != next.updated_at;
    let pipeline = previous.pipeline_id != next.pipeline_id
        || previous.pipeline_status != next.pipeline_status;
    let detail = notes || updated || pipeline;
    let timeline = notes || updated;
    let checks = pipeline;
    let commits = updated && tab.commits;
    let files = updated && tab.files;
    RefreshNames {
        detail,
        timeline,
        commits,
        checks,
        files,
    }
}

impl PartialEq for ListFingerprint {
    fn eq(&self, other: &Self) -> bool {
        self.updated_at == other.updated_at
            && self.state == other.state
            && self.checks_summary == other.checks_summary
            && self.review_decision == other.review_decision
            && self.comment_count == other.comment_count
            && self.approvals == other.approvals
            && self.unresolved_threads == other.unresolved_threads
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row() -> ListFingerprint {
        ListFingerprint {
            updated_at: "2026-10-08T00:00:00Z".into(),
            state: "opened".into(),
            checks_summary: Some("success".into()),
            review_decision: Some("approved".into()),
            comment_count: 3,
            approvals: Some((2, 1)),
            unresolved_threads: Some(0),
        }
    }

    #[test]
    fn unchanged_list_and_probe_request_nothing() {
        let row = sample_row();
        assert!(!list_changed(&[sample_row()], std::slice::from_ref(&row)));
        let probe = ProbeFingerprint {
            updated_at: "2026-10-08T00:00:00Z".into(),
            user_notes_count: 3,
            pipeline_id: None,
            pipeline_status: None,
        };
        assert_eq!(
            detail_refresh(
                &probe,
                &probe,
                ActiveTab {
                    commits: true,
                    files: true
                }
            ),
            RefreshNames::none()
        );
    }

    #[test]
    fn pipeline_change_with_the_same_updated_at_refreshes_detail_and_checks_only() {
        let previous = ProbeFingerprint {
            updated_at: "2026-10-08T00:00:00Z".into(),
            user_notes_count: 3,
            pipeline_id: Some(1),
            pipeline_status: Some("pending".into()),
        };
        let next = ProbeFingerprint {
            pipeline_id: Some(2),
            pipeline_status: Some("pending".into()),
            ..previous.clone()
        };
        assert_eq!(
            detail_refresh(
                &previous,
                &next,
                ActiveTab {
                    commits: true,
                    files: true
                }
            ),
            RefreshNames {
                detail: true,
                checks: true,
                ..RefreshNames::none()
            }
        );
    }

    #[test]
    fn note_count_change_refreshes_detail_and_timeline_only() {
        let previous = ProbeFingerprint {
            updated_at: "2026-10-08T00:00:00Z".into(),
            user_notes_count: 3,
            pipeline_id: None,
            pipeline_status: None,
        };
        let next = ProbeFingerprint {
            user_notes_count: 4,
            ..previous.clone()
        };
        assert_eq!(
            detail_refresh(
                &previous,
                &next,
                ActiveTab {
                    commits: true,
                    files: true
                }
            ),
            RefreshNames {
                detail: true,
                timeline: true,
                ..RefreshNames::none()
            }
        );
    }

    #[test]
    fn updated_at_change_refreshes_detail_timeline_and_the_active_heavy_tabs() {
        let previous = ProbeFingerprint {
            updated_at: "2026-10-08T00:00:00Z".into(),
            user_notes_count: 3,
            pipeline_id: None,
            pipeline_status: None,
        };
        let next = ProbeFingerprint {
            updated_at: "2026-10-08T00:01:00Z".into(),
            ..previous.clone()
        };
        assert_eq!(
            detail_refresh(
                &previous,
                &next,
                ActiveTab {
                    commits: false,
                    files: true
                }
            ),
            RefreshNames {
                detail: true,
                timeline: true,
                files: true,
                commits: false,
                checks: false,
            }
        );
    }
}
