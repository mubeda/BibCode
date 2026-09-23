#[cfg(target_os = "linux")]
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::Notify;

// Share the server's re-execution harness.
#[cfg(target_os = "linux")]
#[path = "../../../server/tests/support/reexec.rs"]
mod reexec;

#[cfg(target_os = "linux")]
fn appimage_test_child(test_name: &str) -> Option<reexec::ChildPhase> {
    const PHASE: &str = "desktop-appimage";
    if let Some(child) = reexec::enter(test_name, PHASE) {
        return Some(child);
    }

    let directory = tempfile::tempdir().expect("AppImage fixture directory");
    let appdir = directory.path().join(".mount_BiBCode");
    let host_bin = directory.path().join("host-bin");
    std::fs::create_dir_all(&host_bin).expect("host executable fixture directory");
    reexec::run(test_name, PHASE, None, |command| {
        command
            .env("APPIMAGE", directory.path().join("BiBCode.AppImage"))
            .env("APPDIR", &appdir)
            .env("ARGV0", "BiBCode.AppImage")
            .env("OWD", directory.path())
            .env(
                "PATH",
                format!(
                    "{}:{}:/usr/bin:/bin",
                    appdir.join("usr/bin").display(),
                    host_bin.display()
                ),
            )
            .env(
                "LD_LIBRARY_PATH",
                format!("{}:/usr/lib", appdir.join("usr/lib").display()),
            )
            .env("PYTHONHOME", appdir.join("usr"))
            .env(
                "BIBCODE_FUTURE_PATH",
                format!("{}:/opt/host/future", appdir.join("future").display()),
            )
            .env("SSH_AUTH_SOCK", "/run/user/1000/bibcode-test-agent.sock")
            .env("GTK_THEME", "Adwaita")
            .env("GDK_BACKEND", "x11")
            .env("PYTHONDONTWRITEBYTECODE", "1");
    });
    None
}

/// Run assertions in an isolated harness with an AppImage launcher environment.
#[cfg(target_os = "linux")]
pub(crate) fn with_appimage_test_environment(test_name: &str, body: impl FnOnce()) {
    if let Some(child) = appimage_test_child(test_name) {
        let parent_environment = std::env::vars_os().collect::<BTreeMap<_, _>>();
        body();
        assert!(parent_environment == std::env::vars_os().collect::<BTreeMap<_, _>>());
        child.complete();
    }
}

#[cfg(target_os = "linux")]
pub(crate) async fn with_appimage_test_environment_async(
    test_name: &str,
    body: impl std::future::Future<Output = ()>,
) {
    if let Some(child) = appimage_test_child(test_name) {
        let parent_environment = std::env::vars_os().collect::<BTreeMap<_, _>>();
        body.await;
        assert!(parent_environment == std::env::vars_os().collect::<BTreeMap<_, _>>());
        child.complete();
    }
}

#[derive(Debug, Default)]
pub(crate) struct FixtureEvent {
    generation: AtomicU64,
    changed: Notify,
}

impl FixtureEvent {
    pub(crate) fn checkpoint(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub(crate) fn publish(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.changed.notify_waiters();
    }

    pub(crate) async fn wait_after(&self, checkpoint: u64) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.generation.load(Ordering::Acquire) > checkpoint {
                return;
            }
            notified.await;
        }
    }

    pub(crate) async fn wait_until_at_least(&self, expected: u64) {
        loop {
            let checkpoint = self.checkpoint();
            if checkpoint >= expected {
                return;
            }
            self.wait_after(checkpoint).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::FixtureEvent;

    #[tokio::test]
    async fn publication_before_wait_is_observed() {
        let event = FixtureEvent::default();
        let checkpoint = event.checkpoint();

        event.publish();
        event.wait_after(checkpoint).await;
    }

    #[tokio::test]
    async fn fixture_events_have_independent_generations() {
        let first = FixtureEvent::default();
        let second = FixtureEvent::default();
        let first_checkpoint = first.checkpoint();
        let second_checkpoint = second.checkpoint();

        first.publish();

        first.wait_after(first_checkpoint).await;
        assert_eq!(second.checkpoint(), second_checkpoint);
    }

    #[tokio::test]
    async fn waits_for_an_expected_generation_without_skipping_publication() {
        let event = FixtureEvent::default();

        event.publish();

        event.wait_until_at_least(1).await;
    }
}
