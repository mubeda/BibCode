//! Change detection for the GitLab poller: what a tick's observations name,
//! and the per-name revisions every subscriber catches up from.

use serde::{Deserialize, Serialize};

use crate::pull_requests::{
    model::{Changed, Pipeline, PipelineCopy, SubscribeTab},
    permissions::ci_must_pass_bucket,
};

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

/// The probe row's fingerprint. The fields after `pipeline_status` came with
/// the live pipeline: a row an older build stored decodes them as defaults
/// and raises `detail` once.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ProbeFingerprint {
    pub updated_at: String,
    pub user_notes_count: u64,
    pub pipeline_id: Option<u64>,
    pub pipeline_status: Option<String>,
    #[serde(default)]
    pub sha: String,
    #[serde(default)]
    pub detailed_merge_status: String,
    #[serde(default)]
    pub merge_when_pipeline_succeeds: bool,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub pipeline_warnings: bool,
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
    #[cfg(test)]
    fn none() -> Self {
        Self {
            detail: false,
            timeline: false,
            commits: false,
            checks: false,
            files: false,
        }
    }

    /// A number nothing has probed yet: everything is named once, so a change
    /// between the client's open and the first probe is re-read.
    pub(super) fn all() -> Self {
        Self {
            detail: true,
            timeline: true,
            commits: true,
            checks: true,
            files: true,
        }
    }
}

pub(super) fn list_changed(previous: &[ListFingerprint], next: &[ListFingerprint]) -> bool {
    if previous.len() != next.len() {
        return true;
    }
    previous.iter().zip(next.iter()).any(|(a, b)| a != b)
}

/// Pipeline changes never run the detail join on their own: a `head_pipeline`
/// id or status change names `checks`, and `detail` only when it moves the
/// pipeline between the "Pipelines must succeed" reason buckets while
/// `detailed_merge_status` stayed the same. Stage and job progress is the
/// `pipeline` row's business.
pub(super) fn detail_refresh(previous: &ProbeFingerprint, next: &ProbeFingerprint) -> RefreshNames {
    let notes = previous.user_notes_count != next.user_notes_count;
    let updated = previous.updated_at != next.updated_at;
    let metadata = previous.sha != next.sha
        || previous.state != next.state
        || previous.detailed_merge_status != next.detailed_merge_status
        || previous.merge_when_pipeline_succeeds != next.merge_when_pipeline_succeeds;
    let pipeline = previous.pipeline_id != next.pipeline_id
        || previous.pipeline_status != next.pipeline_status;
    let bucket = pipeline
        && previous.detailed_merge_status == next.detailed_merge_status
        && ci_must_pass_bucket(previous.pipeline_status.as_deref())
            != ci_must_pass_bucket(next.pipeline_status.as_deref());
    RefreshNames {
        detail: notes || updated || metadata || bucket,
        timeline: notes || updated,
        commits: updated,
        checks: pipeline,
        files: updated,
    }
}

/// For each name, the generation of the tick that last raised it: the probe
/// row's payload. Revisions are cumulative, so a subscriber that missed ticks
/// (a full stream, a lagged receiver, or a change another list key's poller
/// saw first) catches up from the next one it receives.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Raised {
    pub detail: i64,
    pub timeline: i64,
    pub commits: i64,
    pub checks: i64,
    pub files: i64,
    pub pipeline: i64,
}

impl Raised {
    /// An empty or older payload decodes as zeros.
    pub(super) fn decode(payload: &[u8]) -> Self {
        serde_json::from_slice(payload).unwrap_or_default()
    }

    pub(super) fn raise(&mut self, names: &RefreshNames, generation: i64) {
        for (raised, name) in [
            (&mut self.detail, names.detail),
            (&mut self.timeline, names.timeline),
            (&mut self.commits, names.commits),
            (&mut self.checks, names.checks),
            (&mut self.files, names.files),
        ] {
            if name {
                *raised = (*raised).max(generation);
            }
        }
    }

    pub(super) fn merge(&mut self, other: &Raised) {
        self.detail = self.detail.max(other.detail);
        self.timeline = self.timeline.max(other.timeline);
        self.commits = self.commits.max(other.commits);
        self.checks = self.checks.max(other.checks);
        self.files = self.files.max(other.files);
        self.pipeline = self.pipeline.max(other.pipeline);
    }

    /// The names newer than what this subscriber was sent; `commits` and
    /// `files` only for a subscriber on that tab.
    pub(super) fn newer_than(&self, delivered: &Raised, tab: Option<SubscribeTab>) -> Changed {
        Changed {
            list: false,
            detail: self.detail > delivered.detail,
            timeline: self.timeline > delivered.timeline,
            commits: tab == Some(SubscribeTab::Commits) && self.commits > delivered.commits,
            checks: self.checks > delivered.checks,
            files: tab == Some(SubscribeTab::Files) && self.files > delivered.files,
            pipeline: self.pipeline > delivered.pipeline,
        }
    }
}

/// The `pipeline` row's change fingerprint: the pipeline's id, status,
/// warnings, `updated_at` and whether it ran for the head commit, each
/// stage's name, status and warnings, and each job's name and state. Timing
/// that moves every tick is left out.
pub(super) fn pipeline_fingerprint(copy: &PipelineCopy) -> String {
    let pipeline = match &copy.pipeline {
        Pipeline::None => serde_json::json!("none"),
        Pipeline::Hidden => serde_json::json!("hidden"),
        Pipeline::Present(p) => serde_json::json!([
            p.id,
            p.status,
            p.warnings,
            p.updated_at,
            p.is_for_head,
            p.stages.as_ref().map(|stages| stages
                .iter()
                .map(|s| serde_json::json!([s.name, s.status, s.warnings]))
                .collect::<Vec<_>>()),
        ]),
    };
    let jobs = copy.checks.as_ref().map(|checks| {
        checks
            .groups
            .iter()
            .flat_map(|group| {
                group
                    .checks
                    .iter()
                    .map(move |check| serde_json::json!([group.name, check.name, check.state]))
            })
            .collect::<Vec<_>>()
    });
    serde_json::json!([pipeline, jobs]).to_string()
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
    use crate::pull_requests::model::{
        Check, CheckGroup, CheckState, CheckSummary, Checks, PipelineKind, PipelineStage,
        PipelineStatus, PresentPipeline,
    };

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

    fn probe() -> ProbeFingerprint {
        ProbeFingerprint {
            updated_at: "2026-10-08T00:00:00Z".into(),
            user_notes_count: 3,
            pipeline_id: None,
            pipeline_status: None,
            sha: "head".into(),
            detailed_merge_status: "ci_must_pass".into(),
            merge_when_pipeline_succeeds: false,
            state: "opened".into(),
            pipeline_warnings: false,
        }
    }

    #[test]
    fn unchanged_list_and_probe_request_nothing() {
        let row = sample_row();
        assert!(!list_changed(&[sample_row()], std::slice::from_ref(&row)));
        assert_eq!(detail_refresh(&probe(), &probe()), RefreshNames::none());
    }

    #[test]
    fn a_changed_reordered_or_resized_list_page_is_a_list_change() {
        let row = sample_row();
        let commented = ListFingerprint {
            comment_count: 4,
            ..sample_row()
        };
        assert!(list_changed(
            std::slice::from_ref(&row),
            std::slice::from_ref(&commented)
        ));
        assert!(list_changed(
            &[row.clone(), commented.clone()],
            &[commented, row.clone()]
        ));
        assert!(list_changed(
            std::slice::from_ref(&row),
            &[row.clone(), row.clone()]
        ));
        assert!(list_changed(&[], std::slice::from_ref(&row)));
    }

    #[test]
    fn a_pipeline_appearing_or_going_away_moves_the_bucket_and_refreshes_detail_and_checks() {
        let without = probe();
        let with = ProbeFingerprint {
            pipeline_id: Some(7),
            pipeline_status: Some("running".into()),
            ..probe()
        };
        let expected = RefreshNames {
            detail: true,
            checks: true,
            ..RefreshNames::none()
        };
        assert_eq!(detail_refresh(&without, &with), expected);
        assert_eq!(detail_refresh(&with, &without), expected);
    }

    #[test]
    fn a_pipeline_status_change_in_one_bucket_refreshes_checks_not_detail() {
        let previous = ProbeFingerprint {
            pipeline_id: Some(1),
            pipeline_status: Some("pending".into()),
            ..probe()
        };
        for next in [
            ProbeFingerprint {
                pipeline_id: Some(2),
                ..previous.clone()
            },
            ProbeFingerprint {
                pipeline_status: Some("running".into()),
                ..previous.clone()
            },
            ProbeFingerprint {
                pipeline_status: Some("success".into()),
                ..previous.clone()
            },
        ] {
            assert_eq!(
                detail_refresh(&previous, &next),
                RefreshNames {
                    checks: true,
                    ..RefreshNames::none()
                },
                "{next:?}"
            );
        }
    }

    #[test]
    fn a_bucket_change_without_a_merge_status_change_refreshes_detail() {
        let failed = ProbeFingerprint {
            pipeline_id: Some(1),
            pipeline_status: Some("failed".into()),
            ..probe()
        };
        let canceled = ProbeFingerprint {
            pipeline_status: Some("canceled".into()),
            ..failed.clone()
        };
        assert_eq!(
            detail_refresh(&failed, &canceled),
            RefreshNames {
                detail: true,
                checks: true,
                ..RefreshNames::none()
            },
            "failed and canceled read differently under Pipelines must succeed"
        );
        // A merge status change already raises detail on its own.
        let running = ProbeFingerprint {
            pipeline_status: Some("running".into()),
            detailed_merge_status: "ci_still_running".into(),
            ..failed.clone()
        };
        assert_eq!(
            detail_refresh(&running, &failed),
            RefreshNames {
                detail: true,
                checks: true,
                ..RefreshNames::none()
            }
        );
    }

    #[test]
    fn merge_request_metadata_changes_refresh_detail_only() {
        for next in [
            ProbeFingerprint {
                sha: "new-head".into(),
                ..probe()
            },
            ProbeFingerprint {
                detailed_merge_status: "mergeable".into(),
                ..probe()
            },
            ProbeFingerprint {
                merge_when_pipeline_succeeds: true,
                ..probe()
            },
            ProbeFingerprint {
                state: "merged".into(),
                ..probe()
            },
        ] {
            assert_eq!(
                detail_refresh(&probe(), &next),
                RefreshNames {
                    detail: true,
                    ..RefreshNames::none()
                },
                "{next:?}"
            );
        }
    }

    #[test]
    fn a_warnings_only_change_names_nothing_here() {
        let next = ProbeFingerprint {
            pipeline_warnings: true,
            ..probe()
        };
        assert_eq!(detail_refresh(&probe(), &next), RefreshNames::none());
    }

    #[test]
    fn an_old_stored_fingerprint_and_an_empty_payload_decode_with_defaults() {
        let old: ProbeFingerprint = serde_json::from_str(
            r#"{"updated_at":"2026-10-08T00:00:00Z","user_notes_count":3,"pipeline_id":7,"pipeline_status":"running"}"#,
        )
        .unwrap();
        assert_eq!(old.sha, "");
        assert_eq!(old.detailed_merge_status, "");
        assert!(!old.merge_when_pipeline_succeeds && !old.pipeline_warnings);
        let next = ProbeFingerprint {
            pipeline_id: Some(7),
            pipeline_status: Some("running".into()),
            ..probe()
        };
        assert!(
            detail_refresh(&old, &next).detail,
            "an old row raises detail once"
        );
        assert_eq!(Raised::decode(b""), Raised::default());
        assert_eq!(Raised::decode(br#"{"detail":5}"#).detail, 5);
    }

    #[test]
    fn note_count_change_refreshes_detail_and_timeline_only() {
        let next = ProbeFingerprint {
            user_notes_count: 4,
            ..probe()
        };
        assert_eq!(
            detail_refresh(&probe(), &next),
            RefreshNames {
                detail: true,
                timeline: true,
                ..RefreshNames::none()
            }
        );
    }

    #[test]
    fn updated_at_change_refreshes_detail_timeline_and_the_heavy_tabs() {
        let next = ProbeFingerprint {
            updated_at: "2026-10-08T00:01:00Z".into(),
            ..probe()
        };
        assert_eq!(
            detail_refresh(&probe(), &next),
            RefreshNames {
                detail: true,
                timeline: true,
                files: true,
                commits: true,
                checks: false,
            }
        );
    }

    #[test]
    fn revisions_name_only_what_is_newer_and_mask_the_heavy_tabs() {
        let mut raised = Raised::default();
        raised.raise(&RefreshNames::all(), 10);
        raised.pipeline = 12;
        let delivered = Raised {
            detail: 10,
            ..Raised::default()
        };
        let changed = raised.newer_than(&delivered, Some(SubscribeTab::Files));
        assert!(!changed.detail && changed.timeline && changed.checks && changed.pipeline);
        assert!(changed.files && !changed.commits);
        let mut merged = delivered;
        merged.merge(&raised);
        assert_eq!(merged, raised);
        assert!(!raised.newer_than(&merged, None).any());
    }

    #[test]
    fn the_pipeline_fingerprint_follows_stages_and_jobs_but_not_timing() {
        let present =
            |stage: PipelineStatus, job: CheckState, duration: Option<f64>| PipelineCopy {
                revision: 1,
                pipeline: Pipeline::Present(PresentPipeline {
                    id: 9,
                    status: PipelineStatus::Running,
                    warnings: false,
                    kind: PipelineKind::MergeRequest,
                    git_ref: "refs/merge-requests/1/head".into(),
                    sha: "head".into(),
                    is_for_head: Some(true),
                    url: None,
                    updated_at: "t".into(),
                    started_at: None,
                    finished_at: None,
                    duration_seconds: duration,
                    stages: Some(vec![PipelineStage {
                        name: "test".into(),
                        status: stage,
                        warnings: false,
                    }]),
                }),
                checks: Some(Checks {
                    groups: vec![CheckGroup {
                        name: "test".into(),
                        checks: vec![Check {
                            name: "unit".into(),
                            state: job,
                            url: None,
                            started_at: None,
                            completed_at: None,
                            duration_seconds: duration,
                            pipeline_id: None,
                            job_id: None,
                        }],
                    }],
                    summary: CheckSummary::Pending,
                    pipeline_url: None,
                    revision: None,
                    truncated: false,
                }),
            };
        let base =
            pipeline_fingerprint(&present(PipelineStatus::Running, CheckState::Pending, None));
        assert_eq!(
            base,
            pipeline_fingerprint(&present(
                PipelineStatus::Running,
                CheckState::Pending,
                Some(3.0)
            ))
        );
        assert_ne!(
            base,
            pipeline_fingerprint(&present(PipelineStatus::Success, CheckState::Pending, None))
        );
        assert_ne!(
            base,
            pipeline_fingerprint(&present(PipelineStatus::Running, CheckState::Success, None))
        );
    }
}
