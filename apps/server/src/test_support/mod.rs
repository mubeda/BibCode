#[cfg(target_os = "linux")]
#[path = "../../tests/support/appimage_environment.rs"]
pub(crate) mod appimage_environment;
#[cfg(target_os = "linux")]
mod capability_probe;
mod event;
#[cfg(target_os = "linux")]
#[path = "../../tests/support/reexec.rs"]
pub(crate) mod reexec;
mod sandbox;
#[path = "../../tests/support/websocket_frames.rs"]
pub(crate) mod websocket_frames;

#[cfg(target_os = "linux")]
pub(crate) use capability_probe::check_capability_probe_appimage_environment;
pub(crate) use event::{FixtureEvent, within_fixture_deadline};
pub(crate) use sandbox::{FixtureLease, TestSandbox};

#[cfg(target_os = "linux")]
pub(crate) const ISOLATING_AND_NO_OP_CASES: &[&str] = &["mixed", "unset-appimage"];

#[cfg(target_os = "linux")]
pub(crate) fn run_on_current_thread<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime")
        .block_on(future)
}

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

    /// Runs once here rather than in every integration binary that includes
    /// `tests/support/websocket_frames.rs`.
    #[tokio::test]
    async fn next_frame_past_heartbeat_skips_only_ping_and_pong() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{
            WebSocketStream,
            tungstenite::{
                Error, Message,
                error::ProtocolError,
                protocol::{CloseFrame, Role, frame::coding::CloseCode},
            },
        };

        use super::websocket_frames::next_frame_past_heartbeat;

        // Ping and Pong are skipped, the data frames behind them arrive
        // unchanged, and skipping the Ping sent tungstenite's queued Pong.
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let mut client = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let mut server = WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;
        for frame in [
            Message::Ping("heartbeat".into()),
            Message::Pong("unsolicited".into()),
            Message::Text("data".into()),
            Message::Binary(vec![1, 2, 3].into()),
        ] {
            server.send(frame).await.expect("peer sends a frame");
        }
        assert_eq!(
            next_frame_past_heartbeat(&mut client)
                .await
                .expect("a frame")
                .expect("a valid frame"),
            Message::Text("data".into())
        );
        assert_eq!(
            next_frame_past_heartbeat(&mut client)
                .await
                .expect("a frame")
                .expect("a valid frame"),
            Message::Binary(vec![1, 2, 3].into())
        );
        assert_eq!(
            server
                .next()
                .await
                .expect("the client's reply")
                .expect("a valid reply"),
            Message::Pong("heartbeat".into())
        );

        // A Close frame passes through, then the end of the stream once the
        // closing handshake completes.
        let close = CloseFrame {
            code: CloseCode::Away,
            reason: "done".into(),
        };
        server
            .send(Message::Close(Some(close.clone())))
            .await
            .expect("peer closes");
        assert_eq!(
            next_frame_past_heartbeat(&mut client)
                .await
                .expect("a frame")
                .expect("a valid frame"),
            Message::Close(Some(close))
        );
        let (end, _) = tokio::join!(next_frame_past_heartbeat(&mut client), async move {
            // The peer reads the client's close reply, then drops the socket.
            let reply = server.next().await;
            drop(server);
            reply
        });
        assert!(
            end.is_none(),
            "the end of the stream passes through: {end:?}"
        );

        // An error passes through: the peer vanishes without a closing handshake.
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let mut client = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        drop(server_io);
        let reset = next_frame_past_heartbeat(&mut client).await;
        assert!(
            matches!(
                reset,
                Some(Err(Error::Protocol(
                    ProtocolError::ResetWithoutClosingHandshake
                )))
            ),
            "{reset:?}"
        );
    }
}
