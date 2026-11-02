const MAX_REPORTED_FAILURES: usize = 8;
const MAX_FAILURE_SCALARS: usize = 160;

pub(crate) fn bound_process_cleanup_failure(failure: impl std::fmt::Display) -> String {
    failure
        .to_string()
        .chars()
        .take(MAX_FAILURE_SCALARS)
        .collect()
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ProcessCleanupReport {
    pub(crate) attempted: usize,
    pub(crate) succeeded: usize,
    pub(crate) failure_count: usize,
    pub(crate) failures: Vec<String>,
}

impl ProcessCleanupReport {
    pub(crate) fn record_success(&mut self) {
        self.attempted = self.attempted.saturating_add(1);
        self.succeeded = self.succeeded.saturating_add(1);
    }

    pub(crate) fn record_failure(&mut self, failure: impl std::fmt::Display) {
        self.attempted = self.attempted.saturating_add(1);
        self.failure_count = self.failure_count.saturating_add(1);
        if self.failures.len() < MAX_REPORTED_FAILURES {
            self.failures.push(bound_process_cleanup_failure(failure));
        }
    }

    pub(crate) fn merge(&mut self, other: Self) {
        self.attempted = self.attempted.saturating_add(other.attempted);
        self.succeeded = self.succeeded.saturating_add(other.succeeded);
        self.failure_count = self.failure_count.saturating_add(other.failure_count);
        let remaining = MAX_REPORTED_FAILURES.saturating_sub(self.failures.len());
        self.failures
            .extend(other.failures.into_iter().take(remaining));
    }
}

/// `EPERM` on Linux and macOS, spelled out so the classification below is testable on Windows.
const EPERM: i32 = 1;
#[cfg(unix)]
const _: () = assert!(EPERM == libc::EPERM);

/// Whether a refused kill of an owned process group leaves nothing to stop. macOS refuses
/// (`EPERM`) a `killpg` whose members have all exited but are not yet reaped, where Linux
/// signals them, and a root that exited on its own and is still unreaped leaves its group just
/// so. `EPERM` means no member could be signalled, so once the root has exited the group counts
/// as stopped. While the root still runs, `EPERM` is a real failure.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn group_kill_refusal_is_stopped(errno: Option<i32>, root_exited: bool) -> bool {
    root_exited && errno == Some(EPERM)
}

#[cfg(test)]
mod tests {
    use super::{EPERM, group_kill_refusal_is_stopped};

    #[test]
    fn only_eperm_after_the_root_exited_counts_as_stopped() {
        assert!(group_kill_refusal_is_stopped(Some(EPERM), true));
        assert!(!group_kill_refusal_is_stopped(Some(EPERM), false));
        // ESRCH and other errors keep their own handling; no errno is not a refusal.
        for errno in [Some(3), Some(13), None] {
            assert!(!group_kill_refusal_is_stopped(errno, true), "{errno:?}");
            assert!(!group_kill_refusal_is_stopped(errno, false), "{errno:?}");
        }
    }
}
