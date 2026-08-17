mod event;
mod sandbox;

pub(crate) use event::FixtureEvent;
pub(crate) use sandbox::{FixtureLease, TestSandbox};

#[cfg(test)]
mod tests {
    use super::{FixtureEvent, FixtureLease, TestSandbox};

    #[tokio::test]
    async fn sandboxes_and_events_are_parallel_and_resource_distinct() {
        let first = TestSandbox::new("first");
        let second = TestSandbox::new("second");
        assert_ne!(first.root(), second.root());
        assert_ne!(first.path("child.pid"), second.path("child.pid"));

        let event = FixtureEvent::default();
        let checkpoint = event.checkpoint();
        event.publish();
        event.wait_after(checkpoint).await;
    }

    #[tokio::test]
    async fn fixture_lease_counts_concurrent_resources_and_releases_on_drop() {
        let sandbox = TestSandbox::new("leases");
        let first = sandbox.acquire_fixture();
        let second = sandbox.acquire_fixture();
        assert_eq!(sandbox.active_fixtures(), 2);
        assert_eq!(sandbox.maximum_active_fixtures(), 2);
        drop(first);
        drop(second);
        assert_eq!(sandbox.active_fixtures(), 0);
    }

    #[test]
    fn fixture_lease_releases_during_panic_unwind() {
        let sandbox = TestSandbox::new("panic-release");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _lease = sandbox.acquire_fixture();
            panic!("fixture panic");
        }));
        assert!(result.is_err());
        assert_eq!(sandbox.active_fixtures(), 0);
    }

    #[test]
    fn sandbox_environment_applies_overrides_without_mutating_its_snapshot() {
        let sandbox = TestSandbox::new("environment");
        let mut first = sandbox.environment([("BIBCODE_FIXTURE_LABEL", "first")]);
        first.insert("BIBCODE_FIXTURE_LABEL".to_owned(), "changed".to_owned());
        let second = sandbox.environment([("BIBCODE_FIXTURE_LABEL", "second")]);

        assert_eq!(
            second.get("BIBCODE_FIXTURE_LABEL"),
            Some(&"second".to_owned())
        );
    }

    #[test]
    fn sandbox_resolves_executables_from_its_captured_path() {
        let sandbox = TestSandbox::new("captured-executable");
        let executable = sandbox.executable_on_path("git");

        assert!(executable.is_absolute());
        assert!(executable.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn sandbox_writes_an_explicit_owner_executable_unix_script() {
        use std::os::unix::fs::PermissionsExt;

        let sandbox = TestSandbox::new("script");
        let script = sandbox.executable_script("fixture", "printf fixture", "@echo off");

        assert_eq!(script, sandbox.path("fixture.sh"));
        assert_eq!(
            std::fs::read_to_string(&script).expect("read fixture script"),
            "#!/bin/sh\nprintf fixture\n"
        );
        assert_eq!(
            std::fs::metadata(&script)
                .expect("fixture script metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[cfg(windows)]
    #[test]
    fn sandbox_writes_an_explicit_windows_command_script() {
        let sandbox = TestSandbox::new("script");
        let script = sandbox.executable_script("fixture", "printf fixture", "@echo off");

        assert_eq!(script, sandbox.path("fixture.cmd"));
        assert_eq!(
            std::fs::read_to_string(&script).expect("read fixture script"),
            "@echo off\r\n"
        );
    }

    #[test]
    fn fixture_lease_has_a_crate_private_name() {
        let sandbox = TestSandbox::new("lease-name");
        let _lease: FixtureLease = sandbox.acquire_fixture();
    }
}
