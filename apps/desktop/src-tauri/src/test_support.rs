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

/// Writes an executable test fixture (a script the test then runs) from a
/// short-lived child process, with `mode` (for example `0o755`).
///
/// Written in this process with `fs::write`, the file would be open for
/// writing here for a moment, and a child that another test forks in that
/// moment keeps the descriptor until it `exec`s; running a file that is open
/// for writing fails with ETXTBSY ("Text file busy"). Writing from a child
/// keeps the descriptor out of the test process altogether.
#[cfg(unix)]
pub(crate) fn write_executable_fixture(path: &std::path::Path, contents: &str, mode: u32) {
    use std::io::Write as _;

    let mut writer = std::process::Command::new("/bin/sh")
        .args(["-c", "cat >\"$1\" && chmod \"$2\" \"$1\"", "sh"])
        .arg(path)
        .arg(format!("{mode:o}"))
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("start the fixture writer");
    writer
        .stdin
        .take()
        .expect("fixture writer stdin")
        .write_all(contents.as_bytes())
        .expect("write the fixture");
    assert!(
        writer.wait().expect("fixture writer status").success(),
        "could not write {}",
        path.display()
    );
}

/// A free port for tests that bind or restart onto it after releasing it.
/// Any socket another process binds there in between makes the restart fail
/// ("Address already in use"): with port 0 the port came from the kernel's
/// ephemeral range, and portpicker's 15000-25000 is where this suite's own
/// fixtures bind. A random free port from 25000-32767 sits below the ephemeral
/// ranges (32768 on Linux, 49152 on macOS and Windows) and above portpicker.
pub(crate) fn free_test_port() -> u16 {
    (0..64)
        .map(|_| 25_000 + (uuid::Uuid::new_v4().as_u128() % 7_768) as u16)
        .find(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok())
        .expect("a free port from 25000-32767")
}

/// Runs test `name` again in a process of its own, where no other test runs,
/// and returns false once it passed there; returns true in that process, which
/// then runs the scenario itself. `name` is the test's full path, as
/// `cargo test` prints it.
///
/// For tests that restart a backend on the port it has just released. In the
/// shared test process other tests fork children, and a child keeps a copy of
/// every open socket until it `exec`s, the old listener included; a restart in
/// that window fails with "Address already in use".
pub(crate) fn scenario_runs_in_this_process(name: &str) -> bool {
    const ISOLATED: &str = "BIBCODE_DESKTOP_ISOLATED_TEST";
    if std::env::var_os(ISOLATED).is_some() {
        return true;
    }
    let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args([name, "--exact", "--test-threads=1", "--nocapture"])
        .env(ISOLATED, name)
        .output()
        .expect("run the scenario in its own process");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("test result: ok. 1 passed"),
        "{name} did not pass in its own process:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    false
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
