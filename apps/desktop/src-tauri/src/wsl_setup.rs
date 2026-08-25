#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        server_artifacts::{ServerArtifactRecord, ServerArtifactRequest},
        wsl::{WslDiscoveryHealth, WslDiscoverySnapshot, WslDistro, WslDistroState},
    };
    use serde_json::json;
    use std::{
        collections::VecDeque,
        path::Path,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };
    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;

    #[derive(Clone)]
    struct FakeHost {
        probes: Arc<Mutex<VecDeque<WslHostProbe>>>,
        installs: Arc<AtomicUsize>,
        wait_for_cancellation: Arc<AtomicBool>,
        fail_atomic_switch: Arc<AtomicBool>,
        previous_preserved: Arc<AtomicBool>,
        block_rollback: Arc<AtomicBool>,
        rollback_started: Arc<Notify>,
        rollback_release: Arc<Notify>,
    }

    impl FakeHost {
        fn new(probes: impl IntoIterator<Item = WslHostProbe>) -> Arc<Self> {
            Arc::new(Self {
                probes: Arc::new(Mutex::new(probes.into_iter().collect())),
                installs: Arc::new(AtomicUsize::new(0)),
                wait_for_cancellation: Arc::new(AtomicBool::new(false)),
                fail_atomic_switch: Arc::new(AtomicBool::new(false)),
                previous_preserved: Arc::new(AtomicBool::new(true)),
                block_rollback: Arc::new(AtomicBool::new(false)),
                rollback_started: Arc::new(Notify::new()),
                rollback_release: Arc::new(Notify::new()),
            })
        }
    }

    impl WslSetupHost for FakeHost {
        fn probe<'a>(
            &'a self,
            _distro: &'a str,
            _cancellation: &'a CancellationToken,
        ) -> HostFuture<'a, WslHostProbe> {
            Box::pin(async move {
                self.probes
                    .lock()
                    .expect("fake host probes")
                    .pop_front()
                    .ok_or_else(|| "missing fake host probe".to_string())
            })
        }

        fn install<'a>(
            &'a self,
            _distro: &'a str,
            paths: &'a WslSetupPaths,
            _artifact: &'a WslVerifiedArtifact,
            cancellation: &'a CancellationToken,
            _progress: SetupProgressSink,
        ) -> HostFuture<'a, WslInstallReceipt> {
            Box::pin(async move {
                self.installs.fetch_add(1, Ordering::SeqCst);
                if self.wait_for_cancellation.load(Ordering::SeqCst) {
                    cancellation.cancelled().await;
                    return Err("cancelled during transfer".to_string());
                }
                if self.fail_atomic_switch.load(Ordering::SeqCst) {
                    self.previous_preserved.store(true, Ordering::SeqCst);
                    return Err("atomic current-link switch failed".to_string());
                }
                Ok(WslInstallReceipt {
                    previous_target: Some(
                        "/home/dev/.local/share/bibcode/server/versions/old/bibcode-server"
                            .to_string(),
                    ),
                    previous_version: Some("0.4.1".to_string()),
                    installed_target: paths.installed_package_root.clone(),
                })
            })
        }

        fn rollback<'a>(
            &'a self,
            _distro: &'a str,
            _paths: &'a WslSetupPaths,
            _receipt: &'a WslInstallReceipt,
            _cancellation: &'a CancellationToken,
        ) -> HostFuture<'a, ()> {
            Box::pin(async move {
                if self.block_rollback.load(Ordering::SeqCst) {
                    self.rollback_started.notify_one();
                    self.rollback_release.notified().await;
                }
                self.previous_preserved.store(true, Ordering::SeqCst);
                Ok(())
            })
        }

        fn cleanup<'a>(
            &'a self,
            _distro: &'a str,
            _paths: &'a WslSetupPaths,
        ) -> HostFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    #[derive(Clone)]
    struct FakeArtifacts {
        record: ServerArtifactRecord,
        downloads: Arc<AtomicUsize>,
    }

    impl FakeArtifacts {
        fn new(size: u64) -> Arc<Self> {
            Arc::new(Self {
                record: ServerArtifactRecord {
                    product: "bibcode-server".to_string(),
                    version: "0.4.2".to_string(),
                    os: "linux".to_string(),
                    architecture: "x86_64".to_string(),
                    format: "tar.gz".to_string(),
                    download_name: "bibcode-server-linux-x86_64.tar.gz".to_string(),
                    size,
                    sha256: "a".repeat(64),
                    signature_name: "bibcode-server-linux-x86_64.tar.gz.sig".to_string(),
                },
                downloads: Arc::new(AtomicUsize::new(0)),
            })
        }
    }

    impl WslArtifactProvider for FakeArtifacts {
        fn resolve<'a>(
            &'a self,
            request: &'a ServerArtifactRequest,
            _cancellation: &'a CancellationToken,
        ) -> ArtifactFuture<'a, WslResolvedArtifact> {
            Box::pin(async move {
                let mut record = self.record.clone();
                record.architecture.clone_from(&request.architecture);
                Ok(WslResolvedArtifact::fixture(
                    record,
                    "https://releases.example/artifacts.json",
                ))
            })
        }

        fn download<'a>(
            &'a self,
            resolved: WslResolvedArtifact,
            staging_root: &'a Path,
            cancellation: &'a CancellationToken,
            progress: SetupProgressSink,
        ) -> ArtifactFuture<'a, WslVerifiedArtifact> {
            Box::pin(async move {
                self.downloads.fetch_add(1, Ordering::SeqCst);
                if cancellation.is_cancelled() {
                    return Err("cancelled before download".to_string());
                }
                std::fs::create_dir_all(staging_root)
                    .map_err(|error| format!("fake staging root: {error}"))?;
                let path = staging_root.join("verified-fixture.tar.gz");
                std::fs::write(&path, vec![b'x'; resolved.record.size as usize])
                    .map_err(|error| format!("fake artifact: {error}"))?;
                progress(
                    RemoteSetupStage::Download,
                    resolved.record.size,
                    Some(resolved.record.size),
                );
                Ok(WslVerifiedArtifact::fixture(resolved.record, path))
            })
        }
    }

    fn running_snapshot(generation: u64, state: WslDistroState) -> WslDiscoverySnapshot {
        WslDiscoverySnapshot {
            generation,
            observed_at: "2036-08-25T12:00:00Z".to_string(),
            health: WslDiscoveryHealth::Available,
            detail: None,
            distros: vec![WslDistro {
                name: "Ubuntu".to_string(),
                is_default: true,
                state,
                version: 2,
            }],
        }
    }

    fn host_probe(
        architecture: &str,
        installed_version: Option<&str>,
        tar_available: bool,
        free_bytes: u64,
    ) -> WslHostProbe {
        WslHostProbe {
            architecture: architecture.to_string(),
            home: "/home/dev".to_string(),
            data_root: "/home/dev/.bibcode".to_string(),
            installed_binary_path: installed_version
                .map(|_| "/home/dev/.local/share/bibcode/server/current/bin/bibcode".to_string()),
            installed_version: installed_version.map(str::to_string),
            tar_available,
            free_bytes,
            control_available: false,
        }
    }

    fn progress_sink() -> SetupProgressSink {
        Arc::new(|_, _, _| {})
    }

    #[tokio::test]
    async fn setup_probe_distinguishes_absent_compatible_architecture_tar_and_disk_states() {
        let host = FakeHost::new([
            host_probe("x86_64", None, true, 1_000_000),
            host_probe("x86_64", Some("0.4.2"), true, 1_000_000),
            host_probe("mips64", None, true, 1_000_000),
            host_probe("x86_64", None, false, 1_000_000),
            host_probe("x86_64", None, true, 100),
        ]);
        let artifacts = FakeArtifacts::new(1024);
        let manager = WslSetupManager::with_dependencies(host, artifacts);
        let snapshot = running_snapshot(7, WslDistroState::Running);
        let input = WslSetupProbeInput {
            distro: "Ubuntu".to_string(),
            discovery_generation: 7,
        };

        let absent = manager
            .prepare(&snapshot, input.clone(), "0.4.2", None)
            .await
            .expect("absent binary should produce consent");
        assert_eq!(absent.compatibility, WslSetupCompatibility::SetupRequired);
        assert!(absent.consent.is_some());

        let compatible = manager
            .prepare(&snapshot, input.clone(), "0.4.2", None)
            .await
            .expect("compatible binary should probe");
        assert_eq!(compatible.compatibility, WslSetupCompatibility::Compatible);
        assert!(compatible.consent.is_none());

        assert!(
            manager
                .prepare(&snapshot, input.clone(), "0.4.2", None)
                .await
                .expect_err("unsupported architecture must block")
                .contains("architecture")
        );
        assert!(
            manager
                .prepare(&snapshot, input.clone(), "0.4.2", None)
                .await
                .expect_err("missing tar must block")
                .contains("tar")
        );
        assert!(
            manager
                .prepare(&snapshot, input, "0.4.2", None)
                .await
                .expect_err("insufficient disk must block")
                .contains("space")
        );
    }

    #[tokio::test]
    async fn stopped_distro_is_rejected_before_any_probe_or_install() {
        let host = FakeHost::new([host_probe("x86_64", None, true, 1_000_000)]);
        let artifacts = FakeArtifacts::new(1024);
        let manager = WslSetupManager::with_dependencies(host.clone(), artifacts);
        let error = manager
            .prepare(
                &running_snapshot(8, WslDistroState::Stopped),
                WslSetupProbeInput {
                    distro: "Ubuntu".to_string(),
                    discovery_generation: 8,
                },
                "0.4.2",
                None,
            )
            .await
            .expect_err("stopped distro must not be started");

        assert!(error.contains("Running"));
        assert_eq!(host.installs.load(Ordering::SeqCst), 0);
        assert_eq!(
            host.probes.lock().expect("fake host probes").len(),
            1,
            "the host probe must not run"
        );
    }

    #[tokio::test]
    async fn cancellation_and_concurrent_setup_preserve_the_previous_version() {
        let host = FakeHost::new([host_probe("x86_64", None, true, 1_000_000)]);
        host.wait_for_cancellation.store(true, Ordering::SeqCst);
        let artifacts = FakeArtifacts::new(1024);
        let manager = Arc::new(WslSetupManager::with_dependencies(host.clone(), artifacts));
        let snapshot = running_snapshot(9, WslDistroState::Running);
        let prepared = manager
            .prepare(
                &snapshot,
                WslSetupProbeInput {
                    distro: "Ubuntu".to_string(),
                    discovery_generation: 9,
                },
                "0.4.2",
                None,
            )
            .await
            .expect("setup consent");
        let consent = prepared.consent.expect("setup-required consent");
        let temporary = tempfile::tempdir().expect("desktop staging root");
        let install_manager = manager.clone();
        let install_snapshot = snapshot.clone();
        let install_root = temporary.path().to_path_buf();
        let request_id = consent.request_id.clone();
        let probe_generation = consent.probe_generation;
        let install = tokio::spawn(async move {
            install_manager
                .begin_install(
                    &install_snapshot,
                    RemoteSetupConsentDecision {
                        request_id,
                        probe_generation,
                        accepted: true,
                    },
                    &install_root,
                    progress_sink(),
                )
                .await
        });
        while host.installs.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        assert!(manager.is_active(&consent.request_id, consent.probe_generation));
        let concurrent = manager
            .prepare(
                &snapshot,
                WslSetupProbeInput {
                    distro: "Ubuntu".to_string(),
                    discovery_generation: 9,
                },
                "0.4.2",
                None,
            )
            .await
            .expect_err("concurrent setup must be rejected");
        assert!(concurrent.contains("already"));
        assert!(manager.cancel(&RemoteSetupCancelInput {
            request_id: consent.request_id.clone(),
            generation: consent.probe_generation,
        }));
        assert!(
            !manager.is_active(&consent.request_id, consent.probe_generation),
            "cancelled generations must stop publishing progress immediately"
        );
        let outcome = install
            .await
            .expect("install task joins")
            .expect("cancelled install has a terminal result");
        let WslInstallAttempt::Terminal(result) = outcome else {
            panic!("cancelled install must not remain pending");
        };
        assert_eq!(result.status, WslSetupStatus::Cancelled);
        assert!(host.previous_preserved.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn stale_generation_stops_publishing_after_a_newer_setup_begins() {
        let host = FakeHost::new([
            host_probe("x86_64", Some("0.4.1"), true, 1_000_000),
            host_probe("x86_64", Some("0.4.1"), true, 1_000_000),
        ]);
        let manager = WslSetupManager::with_dependencies(host, FakeArtifacts::new(1024));
        let snapshot = running_snapshot(10, WslDistroState::Running);
        let temporary = tempfile::tempdir().expect("desktop staging root");

        let first_probe = manager
            .prepare(
                &snapshot,
                WslSetupProbeInput {
                    distro: "Ubuntu".to_string(),
                    discovery_generation: 10,
                },
                "0.4.2",
                None,
            )
            .await
            .expect("first setup consent");
        let first_consent = first_probe.consent.expect("first setup-required consent");
        let first_request_id = first_consent.request_id.clone();
        let first_generation = first_consent.probe_generation;
        let WslInstallAttempt::Pending(first_pending) = manager
            .begin_install(
                &snapshot,
                RemoteSetupConsentDecision {
                    request_id: first_request_id.clone(),
                    probe_generation: first_generation,
                    accepted: true,
                },
                temporary.path(),
                progress_sink(),
            )
            .await
            .expect("first install starts")
        else {
            panic!("first install should remain pending for identity verification");
        };
        assert!(manager.is_active(&first_request_id, first_generation));
        let _ = manager
            .fail_and_rollback(*first_pending, "replace first generation".to_string())
            .await;

        let second_probe = manager
            .prepare(
                &snapshot,
                WslSetupProbeInput {
                    distro: "Ubuntu".to_string(),
                    discovery_generation: 10,
                },
                "0.4.2",
                None,
            )
            .await
            .expect("newer setup consent");
        let second_consent = second_probe.consent.expect("newer setup-required consent");
        let second_request_id = second_consent.request_id.clone();
        let second_generation = second_consent.probe_generation;
        assert!(second_generation > first_generation);
        let WslInstallAttempt::Pending(second_pending) = manager
            .begin_install(
                &snapshot,
                RemoteSetupConsentDecision {
                    request_id: second_request_id.clone(),
                    probe_generation: second_generation,
                    accepted: true,
                },
                temporary.path(),
                progress_sink(),
            )
            .await
            .expect("newer install starts")
        else {
            panic!("newer install should remain pending for identity verification");
        };

        assert!(!manager.is_active(&first_request_id, first_generation));
        assert!(manager.is_active(&second_request_id, second_generation));
        let terminal_publications = AtomicUsize::new(0);
        assert!(
            !manager.publish_terminal_if_latest(first_generation, || {
                terminal_publications.fetch_add(1, Ordering::SeqCst);
            }),
            "an older terminal event must not publish after a newer generation begins"
        );
        assert!(manager.publish_terminal_if_latest(second_generation, || {
            terminal_publications.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(terminal_publications.load(Ordering::SeqCst), 1);
        let _ = manager
            .fail_and_rollback(*second_pending, "test cleanup".to_string())
            .await;
    }

    #[tokio::test]
    async fn shutdown_waits_for_cancelled_setup_rollback_and_cleanup() {
        let host = FakeHost::new([host_probe("x86_64", Some("0.4.1"), true, 1_000_000)]);
        host.block_rollback.store(true, Ordering::SeqCst);
        let manager = Arc::new(WslSetupManager::with_dependencies(
            host.clone(),
            FakeArtifacts::new(1024),
        ));
        let snapshot = running_snapshot(11, WslDistroState::Running);
        let probe = manager
            .prepare(
                &snapshot,
                WslSetupProbeInput {
                    distro: "Ubuntu".to_string(),
                    discovery_generation: 11,
                },
                "0.4.2",
                None,
            )
            .await
            .expect("shutdown fixture setup consent");
        let consent = probe.consent.expect("shutdown fixture requires setup");
        let temporary = tempfile::tempdir().expect("desktop staging root");
        let WslInstallAttempt::Pending(pending) = manager
            .begin_install(
                &snapshot,
                RemoteSetupConsentDecision {
                    request_id: consent.request_id,
                    probe_generation: consent.probe_generation,
                    accepted: true,
                },
                temporary.path(),
                progress_sink(),
            )
            .await
            .expect("shutdown fixture reaches post-install verification")
        else {
            panic!("shutdown fixture must retain an active installed mutation");
        };
        let cancellation = pending.cancellation();
        let rollback_manager = manager.clone();
        let rollback = tokio::spawn(async move {
            cancellation.cancelled().await;
            rollback_manager
                .fail_and_rollback(*pending, "desktop shutdown cancelled setup".to_string())
                .await
        });
        let shutdown_manager = manager.clone();
        let shutdown = tokio::spawn(async move { shutdown_manager.shutdown().await });

        tokio::time::timeout(Duration::from_secs(1), host.rollback_started.notified())
            .await
            .expect("shutdown cancellation starts rollback");
        assert!(
            !shutdown.is_finished(),
            "desktop shutdown must wait while rollback owns the previous target"
        );
        host.rollback_release.notify_one();
        let result = rollback.await.expect("rollback task joins");
        assert_eq!(result.status, WslSetupStatus::Cancelled);
        tokio::time::timeout(Duration::from_secs(1), shutdown)
            .await
            .expect("shutdown drains rollback")
            .expect("shutdown task joins");
        assert!(host.previous_preserved.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn failed_atomic_switch_reports_failure_and_preserves_previous_version() {
        let host = FakeHost::new([host_probe("x86_64", Some("0.4.1"), true, 1_000_000)]);
        host.fail_atomic_switch.store(true, Ordering::SeqCst);
        let artifacts = FakeArtifacts::new(1024);
        let manager = WslSetupManager::with_dependencies(host.clone(), artifacts);
        let snapshot = running_snapshot(10, WslDistroState::Running);
        let prepared = manager
            .prepare(
                &snapshot,
                WslSetupProbeInput {
                    distro: "Ubuntu".to_string(),
                    discovery_generation: 10,
                },
                "0.4.2",
                None,
            )
            .await
            .expect("upgrade consent");
        let consent = prepared.consent.expect("upgrade consent");
        let temporary = tempfile::tempdir().expect("desktop staging root");
        let outcome = manager
            .begin_install(
                &snapshot,
                RemoteSetupConsentDecision {
                    request_id: consent.request_id,
                    probe_generation: consent.probe_generation,
                    accepted: true,
                },
                temporary.path(),
                progress_sink(),
            )
            .await
            .expect("atomic failure is represented");
        let WslInstallAttempt::Terminal(result) = outcome else {
            panic!("atomic switch failure must be terminal");
        };
        assert_eq!(result.status, WslSetupStatus::Failed);
        assert_eq!(result.previous_version.as_deref(), Some("0.4.1"));
        assert!(host.previous_preserved.load(Ordering::SeqCst));
    }

    #[test]
    fn descriptor_validation_rejects_wrong_version_architecture_protocol_and_identity() {
        let valid = json!({
            "environmentId": "019d2a2e-0d0e-7000-8000-000000000001",
            "label": "Ubuntu",
            "platform": {"os": "linux", "arch": "x64"},
            "serverVersion": "0.4.2",
            "storageInstanceId": "019d2a2e-0d0e-7000-8000-000000000002",
            "protocol": {"minimum": 1, "maximum": 1},
            "capabilities": {"repositoryIdentity": true},
            "transport": {"mode": "loopback-http"}
        });
        let expected_identity =
            WslExpectedIdentity::from_descriptor(&valid).expect("expected identity");
        validate_setup_descriptor(&valid, "0.4.2", "x86_64", Some(&expected_identity))
            .expect("matching descriptor should verify");
        let mut wrong_version = valid.clone();
        wrong_version["serverVersion"] = json!("0.4.1");
        assert!(validate_setup_descriptor(&wrong_version, "0.4.2", "x86_64", None).is_err());
        let mut wrong_protocol = valid.clone();
        wrong_protocol["protocol"] = json!({"minimum": 2, "maximum": 2});
        assert!(validate_setup_descriptor(&wrong_protocol, "0.4.2", "x86_64", None).is_err());
        assert!(validate_setup_descriptor(&valid, "0.4.2", "aarch64", None).is_err());
        let mut wrong_identity = valid.clone();
        wrong_identity["storageInstanceId"] = json!("019d2a2e-0d0e-7000-8000-000000000003");
        assert!(
            validate_setup_descriptor(
                &wrong_identity,
                "0.4.2",
                "x86_64",
                Some(&expected_identity),
            )
            .is_err()
        );
    }

    #[test]
    fn wsl_setup_commands_are_structured_argv_without_a_shell() {
        let command = WslExecCommand::new(
            "Ubuntu Dev",
            "tar",
            [
                "-xzf",
                "/home/dev/staging/artifact.tar.gz",
                "-C",
                "/home/dev/versions/new",
            ],
        )
        .expect("structured WSL command");
        assert_eq!(
            command.argv(),
            vec![
                "--distribution",
                "Ubuntu Dev",
                "--exec",
                "tar",
                "-xzf",
                "/home/dev/staging/artifact.tar.gz",
                "-C",
                "/home/dev/versions/new",
            ]
        );
        assert!(
            !command
                .argv()
                .iter()
                .any(|argument| matches!(*argument, "sh" | "bash" | "-c"))
        );
    }
}
use crate::{
    server_artifacts::{
        ResolvedServerArtifact, ServerArtifactProgress, ServerArtifactRecord,
        ServerArtifactRequest, ServerArtifactSource, VerifiedServerArtifact,
    },
    wsl::{WslDiscoveryHealth, WslDiscoverySnapshot, WslDistroState},
};
use bibcode_server::process::configure_background_command;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use time::{Duration as TimeDuration, OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _},
    process::{Child, Command},
    sync::Notify,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SETUP_CONSENT_LIFETIME: TimeDuration = TimeDuration::minutes(5);
const SETUP_REQUIRED_SPACE_MULTIPLIER: u64 = 3;
const WSL_SETUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const WSL_SETUP_TRANSFER_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const WSL_SETUP_MAX_OUTPUT_BYTES: usize = 1024 * 1024;

pub(crate) type HostFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;
pub(crate) type ArtifactFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteSetupStage {
    Probe,
    Download,
    Verify,
    Transfer,
    Install,
    Start,
    VerifyIdentity,
}

pub(crate) type SetupProgressSink = Arc<dyn Fn(RemoteSetupStage, u64, Option<u64>) + Send + Sync>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WslHostProbe {
    pub architecture: String,
    pub home: String,
    pub data_root: String,
    pub installed_binary_path: Option<String>,
    pub installed_version: Option<String>,
    pub tar_available: bool,
    pub free_bytes: u64,
    pub control_available: bool,
}

pub(crate) trait WslSetupHost: Send + Sync {
    fn probe<'a>(
        &'a self,
        distro: &'a str,
        cancellation: &'a CancellationToken,
    ) -> HostFuture<'a, WslHostProbe>;

    fn install<'a>(
        &'a self,
        distro: &'a str,
        paths: &'a WslSetupPaths,
        artifact: &'a WslVerifiedArtifact,
        cancellation: &'a CancellationToken,
        progress: SetupProgressSink,
    ) -> HostFuture<'a, WslInstallReceipt>;

    fn rollback<'a>(
        &'a self,
        distro: &'a str,
        paths: &'a WslSetupPaths,
        receipt: &'a WslInstallReceipt,
        cancellation: &'a CancellationToken,
    ) -> HostFuture<'a, ()>;

    fn cleanup<'a>(&'a self, distro: &'a str, paths: &'a WslSetupPaths) -> HostFuture<'a, ()>;
}

#[derive(Clone, Debug)]
pub(crate) struct WslResolvedArtifact {
    pub record: ServerArtifactRecord,
    pub source: String,
    system: Option<ResolvedServerArtifact>,
}

impl WslResolvedArtifact {
    #[cfg(test)]
    fn fixture(record: ServerArtifactRecord, source: &str) -> Self {
        Self {
            record,
            source: source.to_string(),
            system: None,
        }
    }
}

pub(crate) struct WslVerifiedArtifact {
    pub record: ServerArtifactRecord,
    pub path: PathBuf,
    system: Option<VerifiedServerArtifact>,
}

impl WslVerifiedArtifact {
    #[cfg(test)]
    fn fixture(record: ServerArtifactRecord, path: PathBuf) -> Self {
        Self {
            record,
            path,
            system: None,
        }
    }
}

impl Drop for WslVerifiedArtifact {
    fn drop(&mut self) {
        if self.system.is_none() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub(crate) trait WslArtifactProvider: Send + Sync {
    fn resolve<'a>(
        &'a self,
        request: &'a ServerArtifactRequest,
        cancellation: &'a CancellationToken,
    ) -> ArtifactFuture<'a, WslResolvedArtifact>;

    fn download<'a>(
        &'a self,
        resolved: WslResolvedArtifact,
        staging_root: &'a Path,
        cancellation: &'a CancellationToken,
        progress: SetupProgressSink,
    ) -> ArtifactFuture<'a, WslVerifiedArtifact>;
}

#[derive(Clone)]
struct SystemWslArtifactProvider {
    source: Result<ServerArtifactSource, String>,
}

impl SystemWslArtifactProvider {
    fn new() -> Self {
        Self {
            source: ServerArtifactSource::production(),
        }
    }

    fn source(&self) -> Result<&ServerArtifactSource, String> {
        self.source.as_ref().map_err(Clone::clone)
    }
}

impl WslArtifactProvider for SystemWslArtifactProvider {
    fn resolve<'a>(
        &'a self,
        request: &'a ServerArtifactRequest,
        cancellation: &'a CancellationToken,
    ) -> ArtifactFuture<'a, WslResolvedArtifact> {
        Box::pin(async move {
            let resolved = self.source()?.resolve(request, cancellation).await?;
            Ok(WslResolvedArtifact {
                record: resolved.record.clone(),
                source: resolved.manifest_url.to_string(),
                system: Some(resolved),
            })
        })
    }

    fn download<'a>(
        &'a self,
        mut resolved: WslResolvedArtifact,
        staging_root: &'a Path,
        cancellation: &'a CancellationToken,
        progress: SetupProgressSink,
    ) -> ArtifactFuture<'a, WslVerifiedArtifact> {
        Box::pin(async move {
            let system = resolved.system.take().ok_or_else(|| {
                "The selected server artifact did not retain its verified manifest record."
                    .to_string()
            })?;
            let artifact_progress: ServerArtifactProgress = Arc::new(move |completed, total| {
                progress(RemoteSetupStage::Download, completed, Some(total));
            });
            let verified = self
                .source()?
                .download(system, staging_root, cancellation, artifact_progress)
                .await?;
            Ok(WslVerifiedArtifact {
                record: verified.resolved.record.clone(),
                path: verified.path.clone(),
                system: Some(verified),
            })
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WslSetupProbeInput {
    pub distro: String,
    pub discovery_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteSetupConsentDecision {
    pub request_id: String,
    pub probe_generation: u64,
    pub accepted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteSetupCancelInput {
    pub request_id: String,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WslSetupCompatibility {
    Compatible,
    SetupRequired,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHostProbeWire {
    os: &'static str,
    architecture: String,
    installed_version: Option<String>,
    service_mode: Option<&'static str>,
    service_state: &'static str,
    data_root: Option<String>,
    control_available: bool,
    free_bytes: u64,
    install_authority: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupVerificationWire {
    manifest_signature: &'static str,
    artifact_signature: &'static str,
    checksum: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSetupConsent {
    pub request_id: String,
    pub probe_generation: u64,
    transport: &'static str,
    target_label: String,
    target_version: String,
    artifact_source: String,
    verification: SetupVerificationWire,
    artifact: ServerArtifactRecord,
    install_destination: String,
    data_root: String,
    service_mode: &'static str,
    required_commands: Vec<String>,
    expires_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslServerProbe {
    pub request_id: String,
    pub probe_generation: u64,
    pub discovery_generation: u64,
    pub distro: String,
    pub compatibility: WslSetupCompatibility,
    pub probe: RemoteHostProbeWire,
    pub installed_binary_path: Option<String>,
    pub consent: Option<RemoteSetupConsent>,
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WslSetupStatus {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslSetupResult {
    pub request_id: String,
    pub generation: u64,
    pub distro: String,
    pub status: WslSetupStatus,
    pub stage: RemoteSetupStage,
    pub mutation_status: &'static str,
    pub cleanup_status: &'static str,
    pub installed_version: Option<String>,
    pub previous_version: Option<String>,
    pub managed_binary_path: Option<String>,
    pub data_root: String,
    pub descriptor: Option<Value>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WslExpectedIdentity {
    environment_id: String,
    storage_instance_id: String,
}

impl WslExpectedIdentity {
    pub(crate) fn from_descriptor(descriptor: &Value) -> Result<Self, String> {
        let environment_id = descriptor
            .get("environmentId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "The running WSL environment descriptor has no environment identity.".to_string()
            })?;
        let storage_instance_id = descriptor
            .get("storageInstanceId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "The running WSL environment descriptor has no storage identity.".to_string()
            })?;
        Uuid::parse_str(environment_id)
            .map_err(|_| "The running WSL environment identity is invalid.".to_string())?;
        Uuid::parse_str(storage_instance_id)
            .map_err(|_| "The running WSL storage identity is invalid.".to_string())?;
        Ok(Self {
            environment_id: environment_id.to_string(),
            storage_instance_id: storage_instance_id.to_string(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WslSetupPaths {
    pub root: String,
    pub versions_root: String,
    pub staging_root: String,
    pub staged_archive: String,
    pub staged_extract_root: String,
    pub staged_package_root: String,
    pub installed_version_root: String,
    pub installed_package_root: String,
    pub current_package_root: String,
    pub current_binary: String,
    pub next_current_link: String,
    pub data_root: String,
}

impl WslSetupPaths {
    fn new(
        home: &str,
        data_root: &str,
        target_version: &str,
        request_id: &str,
    ) -> Result<Self, String> {
        validate_absolute_linux_path(home, "WSL home")?;
        validate_absolute_linux_path(data_root, "WSL data root")?;
        if Uuid::parse_str(request_id).is_err() {
            return Err("The WSL setup request identifier is invalid.".to_string());
        }
        let version_digest = Sha256::digest(target_version.as_bytes()).iter().fold(
            String::with_capacity(64),
            |mut encoded, byte| {
                use std::fmt::Write as _;
                let _ = write!(encoded, "{byte:02x}");
                encoded
            },
        );
        let current_binary = managed_wsl_server_binary(home)?;
        let root = format!("{}/.local/share/bibcode/server", home.trim_end_matches('/'));
        let versions_root = format!("{root}/versions");
        let staging_root = format!("{root}/staging");
        let staged_extract_root = format!("{versions_root}/.staging-{request_id}");
        let installed_version_root =
            format!("{versions_root}/version-{version_digest}-{request_id}");
        let installed_package_root = format!("{installed_version_root}/bibcode-server");
        let current_package_root = format!("{root}/current");
        Ok(Self {
            staged_archive: format!("{staging_root}/{request_id}.tar.gz"),
            staged_package_root: format!("{staged_extract_root}/bibcode-server"),
            current_binary,
            next_current_link: format!("{root}/.current-{request_id}"),
            root,
            versions_root,
            staging_root,
            staged_extract_root,
            installed_version_root,
            installed_package_root,
            current_package_root,
            data_root: data_root.to_string(),
        })
    }
}

pub(crate) fn managed_wsl_server_binary(home: &str) -> Result<String, String> {
    validate_absolute_linux_path(home, "WSL home")?;
    Ok(format!(
        "{}/.local/share/bibcode/server/current/bin/bibcode",
        home.trim_end_matches('/')
    ))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WslInstallReceipt {
    pub previous_target: Option<String>,
    pub previous_version: Option<String>,
    pub installed_target: String,
}

pub(crate) struct PendingWslInstallation {
    request_id: String,
    generation: u64,
    discovery_generation: u64,
    distro: String,
    architecture: String,
    target_version: String,
    expected_identity: Option<WslExpectedIdentity>,
    paths: WslSetupPaths,
    receipt: WslInstallReceipt,
    cancellation: CancellationToken,
}

impl PendingWslInstallation {
    pub(crate) fn distro(&self) -> &str {
        &self.distro
    }

    pub(crate) fn discovery_generation(&self) -> u64 {
        self.discovery_generation
    }

    pub(crate) fn architecture(&self) -> &str {
        &self.architecture
    }

    pub(crate) fn target_version(&self) -> &str {
        &self.target_version
    }

    pub(crate) fn expected_identity(&self) -> Option<&WslExpectedIdentity> {
        self.expected_identity.as_ref()
    }

    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }
}

pub(crate) enum WslInstallAttempt {
    Pending(Box<PendingWslInstallation>),
    Terminal(Box<WslSetupResult>),
}

#[derive(Clone)]
struct PreparedWslSetup {
    request_id: String,
    probe_generation: u64,
    discovery_generation: u64,
    distro: String,
    architecture: String,
    target_version: String,
    expected_identity: Option<WslExpectedIdentity>,
    resolved: WslResolvedArtifact,
    paths: WslSetupPaths,
    previous_version: Option<String>,
    expires_at: OffsetDateTime,
}

#[derive(Clone)]
struct ActiveWslSetup {
    generation: u64,
    distro: String,
    cancellation: CancellationToken,
}

#[derive(Default)]
struct WslSetupState {
    generation: u64,
    prepared: HashMap<String, PreparedWslSetup>,
    active: HashMap<String, ActiveWslSetup>,
}

#[derive(Clone)]
pub(crate) struct WslSetupManager {
    state: Arc<Mutex<WslSetupState>>,
    changed: Arc<Notify>,
    host: Arc<dyn WslSetupHost>,
    artifacts: Arc<dyn WslArtifactProvider>,
    cancellation: CancellationToken,
}

impl Default for WslSetupManager {
    fn default() -> Self {
        Self::new()
    }
}

impl WslSetupManager {
    pub(crate) fn new() -> Self {
        Self::with_dependencies(
            Arc::new(ProcessWslSetupHost),
            Arc::new(SystemWslArtifactProvider::new()),
        )
    }

    fn with_dependencies(
        host: Arc<dyn WslSetupHost>,
        artifacts: Arc<dyn WslArtifactProvider>,
    ) -> Self {
        Self {
            state: Arc::default(),
            changed: Arc::new(Notify::new()),
            host,
            artifacts,
            cancellation: CancellationToken::new(),
        }
    }

    pub(crate) fn cancel_all(&self) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.cancellation.cancel();
        for active in state.active.values() {
            active.cancellation.cancel();
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.cancel_all();
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let drained = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .active
                .is_empty();
            if drained {
                return;
            }
            notified.await;
        }
    }

    pub(crate) async fn prepare(
        &self,
        discovery: &WslDiscoverySnapshot,
        input: WslSetupProbeInput,
        target_version: &str,
        expected_identity: Option<WslExpectedIdentity>,
    ) -> Result<WslServerProbe, String> {
        validate_running_distro(discovery, input.discovery_generation, &input.distro)?;
        self.reject_active_distro(&input.distro)?;
        let probe_cancellation = self.cancellation.child_token();
        let host_probe = self.host.probe(&input.distro, &probe_cancellation).await?;
        let architecture = normalize_linux_architecture(&host_probe.architecture)?;
        let request_id = Uuid::new_v4().to_string();
        let probe_generation = self.next_generation();
        let probe_wire = remote_host_probe_wire(&host_probe, &architecture);
        if host_probe.installed_version.as_deref() == Some(target_version)
            && host_probe.installed_binary_path.is_some()
        {
            return Ok(WslServerProbe {
                request_id,
                probe_generation,
                discovery_generation: discovery.generation,
                distro: input.distro,
                compatibility: WslSetupCompatibility::Compatible,
                probe: probe_wire,
                installed_binary_path: host_probe.installed_binary_path,
                consent: None,
                detail: None,
            });
        }
        if !host_probe.tar_available {
            return Err(format!(
                "WSL distribution {} cannot install BiBCode Server because tar is unavailable.",
                input.distro
            ));
        }
        let resolved = self
            .artifacts
            .resolve(
                &ServerArtifactRequest {
                    version: target_version.to_string(),
                    os: "linux".to_string(),
                    architecture: architecture.clone(),
                    preferred_formats: vec!["tar.gz".to_string()],
                },
                &probe_cancellation,
            )
            .await?;
        let required_space = resolved
            .record
            .size
            .saturating_mul(SETUP_REQUIRED_SPACE_MULTIPLIER);
        if host_probe.free_bytes < required_space {
            return Err(format!(
                "WSL distribution {} does not have enough free space for verified staging and rollback.",
                input.distro
            ));
        }
        let paths = WslSetupPaths::new(
            &host_probe.home,
            &host_probe.data_root,
            target_version,
            &request_id,
        )?;
        let expires_at = OffsetDateTime::now_utc() + SETUP_CONSENT_LIFETIME;
        let consent = RemoteSetupConsent {
            request_id: request_id.clone(),
            probe_generation,
            transport: "wsl",
            target_label: input.distro.clone(),
            target_version: target_version.to_string(),
            artifact_source: resolved.source.clone(),
            verification: SetupVerificationWire {
                manifest_signature: "verified",
                artifact_signature: "pending",
                checksum: "pending",
            },
            artifact: resolved.record.clone(),
            install_destination: paths.installed_version_root.clone(),
            data_root: paths.data_root.clone(),
            service_mode: "workstation",
            required_commands: vec![
                "Create private per-user BiBCode Server staging and version directories."
                    .to_string(),
                "Transfer the selected signed artifact into the running distribution.".to_string(),
                "Verify SHA-256 again inside WSL and extract the versioned runtime.".to_string(),
                "Atomically switch the managed current link after binary validation.".to_string(),
                "Restart the desktop-owned WSL server and verify its identity descriptor."
                    .to_string(),
            ],
            expires_at: expires_at
                .format(&Rfc3339)
                .map_err(|error| format!("Could not format WSL setup consent expiry: {error}"))?,
        };
        let prepared = PreparedWslSetup {
            request_id: request_id.clone(),
            probe_generation,
            discovery_generation: discovery.generation,
            distro: input.distro.clone(),
            architecture,
            target_version: target_version.to_string(),
            expected_identity,
            resolved,
            paths,
            previous_version: host_probe.installed_version.clone(),
            expires_at,
        };
        self.store_prepared(prepared)?;
        Ok(WslServerProbe {
            request_id,
            probe_generation,
            discovery_generation: discovery.generation,
            distro: input.distro,
            compatibility: WslSetupCompatibility::SetupRequired,
            probe: probe_wire,
            installed_binary_path: host_probe.installed_binary_path,
            consent: Some(consent),
            detail: Some(match host_probe.installed_version {
                Some(version) => format!(
                    "BiBCode Server {version} is not compatible with required version {target_version}."
                ),
                None => "BiBCode Server is not installed in this running distribution.".to_string(),
            }),
        })
    }

    pub(crate) async fn begin_install(
        &self,
        discovery: &WslDiscoverySnapshot,
        decision: RemoteSetupConsentDecision,
        staging_root: &Path,
        progress: SetupProgressSink,
    ) -> Result<WslInstallAttempt, String> {
        let prepared = self.take_prepared(&decision)?;
        validate_running_distro(discovery, prepared.discovery_generation, &prepared.distro)?;
        if OffsetDateTime::now_utc() > prepared.expires_at {
            return Err(
                "The WSL setup consent expired; probe again before installing.".to_string(),
            );
        }
        if !decision.accepted {
            return Ok(WslInstallAttempt::Terminal(Box::new(terminal_result(
                &prepared,
                WslSetupStatus::Cancelled,
                RemoteSetupStage::Probe,
                "none",
                "notRequired",
                None,
                Some("WSL server installation was declined before mutation.".to_string()),
            ))));
        }
        let operation_cancellation = self.cancellation.child_token();
        self.begin_active(&prepared, operation_cancellation.clone())?;
        progress(
            RemoteSetupStage::Download,
            0,
            Some(prepared.resolved.record.size),
        );
        let artifact = match self
            .artifacts
            .download(
                prepared.resolved.clone(),
                staging_root,
                &operation_cancellation,
                progress.clone(),
            )
            .await
        {
            Ok(artifact) => artifact,
            Err(error) => {
                self.finish_active(&prepared.request_id);
                let cancelled = operation_cancellation.is_cancelled();
                return Ok(WslInstallAttempt::Terminal(Box::new(terminal_result(
                    &prepared,
                    if cancelled {
                        WslSetupStatus::Cancelled
                    } else {
                        WslSetupStatus::Failed
                    },
                    RemoteSetupStage::Download,
                    "none",
                    "notRequired",
                    None,
                    Some(error),
                ))));
            }
        };
        progress(
            RemoteSetupStage::Verify,
            artifact.record.size,
            Some(artifact.record.size),
        );
        let receipt = match self
            .host
            .install(
                &prepared.distro,
                &prepared.paths,
                &artifact,
                &operation_cancellation,
                progress,
            )
            .await
        {
            Ok(receipt) => receipt,
            Err(error) => {
                let cleanup = self.host.cleanup(&prepared.distro, &prepared.paths).await;
                self.finish_active(&prepared.request_id);
                let cancelled = operation_cancellation.is_cancelled()
                    || error.to_ascii_lowercase().contains("cancelled");
                return Ok(WslInstallAttempt::Terminal(Box::new(terminal_result(
                    &prepared,
                    if cancelled {
                        WslSetupStatus::Cancelled
                    } else {
                        WslSetupStatus::Failed
                    },
                    RemoteSetupStage::Install,
                    "partial",
                    if cleanup.is_ok() {
                        "completed"
                    } else {
                        "failed"
                    },
                    None,
                    Some(error),
                ))));
            }
        };
        Ok(WslInstallAttempt::Pending(Box::new(
            PendingWslInstallation {
                request_id: prepared.request_id,
                generation: prepared.probe_generation,
                discovery_generation: prepared.discovery_generation,
                distro: prepared.distro,
                architecture: prepared.architecture,
                target_version: prepared.target_version,
                expected_identity: prepared.expected_identity,
                paths: prepared.paths,
                receipt,
                cancellation: operation_cancellation,
            },
        )))
    }

    pub(crate) async fn complete(
        &self,
        pending: PendingWslInstallation,
        descriptor: Value,
    ) -> Result<WslSetupResult, String> {
        if pending.cancellation.is_cancelled() {
            return Ok(self
                .fail_and_rollback(
                    pending,
                    "WSL setup was cancelled before identity publication.".to_string(),
                )
                .await);
        }
        validate_setup_descriptor(
            &descriptor,
            &pending.target_version,
            &pending.architecture,
            pending.expected_identity.as_ref(),
        )?;
        let cleanup = self.host.cleanup(&pending.distro, &pending.paths).await;
        if !self.claim_active_completion(&pending.request_id, pending.generation) {
            return Ok(self
                .fail_and_rollback(
                    pending,
                    "WSL setup was cancelled or superseded during final cleanup.".to_string(),
                )
                .await);
        }
        Ok(WslSetupResult {
            request_id: pending.request_id,
            generation: pending.generation,
            distro: pending.distro,
            status: WslSetupStatus::Completed,
            stage: RemoteSetupStage::VerifyIdentity,
            mutation_status: "completed",
            cleanup_status: if cleanup.is_ok() {
                "completed"
            } else {
                "failed"
            },
            installed_version: Some(pending.target_version),
            previous_version: pending.receipt.previous_version,
            managed_binary_path: Some(pending.paths.current_binary),
            data_root: pending.paths.data_root,
            descriptor: Some(descriptor),
            message: cleanup.err(),
        })
    }

    pub(crate) async fn fail_and_rollback(
        &self,
        pending: PendingWslInstallation,
        message: String,
    ) -> WslSetupResult {
        let cleanup_cancellation = CancellationToken::new();
        let rollback = self
            .host
            .rollback(
                &pending.distro,
                &pending.paths,
                &pending.receipt,
                &cleanup_cancellation,
            )
            .await;
        let cleanup = self.host.cleanup(&pending.distro, &pending.paths).await;
        self.finish_active(&pending.request_id);
        let cleanup_status = if rollback.is_ok() && cleanup.is_ok() {
            "completed"
        } else {
            "failed"
        };
        let detail = match (rollback.err(), cleanup.err()) {
            (None, None) => message,
            (rollback, cleanup) => format!(
                "{message} Rollback: {} Cleanup: {}",
                rollback.as_deref().unwrap_or("completed"),
                cleanup.as_deref().unwrap_or("completed")
            ),
        };
        WslSetupResult {
            request_id: pending.request_id,
            generation: pending.generation,
            distro: pending.distro,
            status: if pending.cancellation.is_cancelled() {
                WslSetupStatus::Cancelled
            } else {
                WslSetupStatus::Failed
            },
            stage: RemoteSetupStage::VerifyIdentity,
            mutation_status: "partial",
            cleanup_status,
            installed_version: None,
            previous_version: pending.receipt.previous_version,
            managed_binary_path: Some(pending.paths.current_binary),
            data_root: pending.paths.data_root,
            descriptor: None,
            message: Some(detail),
        }
    }

    pub(crate) fn cancel(&self, input: &RemoteSetupCancelInput) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = state.active.get(&input.request_id)
            && active.generation == input.generation
        {
            active.cancellation.cancel();
            return true;
        }
        state
            .prepared
            .get(&input.request_id)
            .is_some_and(|prepared| prepared.probe_generation == input.generation)
            && state.prepared.remove(&input.request_id).is_some()
    }

    pub(crate) fn is_active(&self, request_id: &str, generation: u64) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active.get(request_id).is_some_and(|active| {
            active.generation == generation && !active.cancellation.is_cancelled()
        })
    }

    pub(crate) fn publish_terminal_if_latest(
        &self,
        generation: u64,
        publish: impl FnOnce(),
    ) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.generation != generation {
            return false;
        }
        publish();
        true
    }

    fn next_generation(&self) -> u64 {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.generation = state.generation.saturating_add(1);
        state.generation
    }

    fn reject_active_distro(&self, distro: &str) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.active.values().any(|active| active.distro == distro) {
            Err(format!(
                "WSL server setup is already active for distribution {distro}."
            ))
        } else {
            Ok(())
        }
    }

    fn store_prepared(&self, prepared: PreparedWslSetup) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.cancellation.is_cancelled() {
            return Err("WSL server setup owner is shutting down.".to_string());
        }
        if state
            .active
            .values()
            .any(|active| active.distro == prepared.distro)
        {
            return Err(format!(
                "WSL server setup is already active for distribution {}.",
                prepared.distro
            ));
        }
        state
            .prepared
            .retain(|_, current| current.distro != prepared.distro);
        state.prepared.insert(prepared.request_id.clone(), prepared);
        Ok(())
    }

    fn take_prepared(
        &self,
        decision: &RemoteSetupConsentDecision,
    ) -> Result<PreparedWslSetup, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let prepared = state.prepared.remove(&decision.request_id).ok_or_else(|| {
            "The WSL setup consent is missing, expired, or already used.".to_string()
        })?;
        if prepared.probe_generation != decision.probe_generation {
            return Err("The WSL setup consent does not match the probe generation.".to_string());
        }
        Ok(prepared)
    }

    fn begin_active(
        &self,
        prepared: &PreparedWslSetup,
        cancellation: CancellationToken,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.cancellation.is_cancelled() {
            return Err("WSL server setup owner is shutting down.".to_string());
        }
        if state
            .active
            .values()
            .any(|active| active.distro == prepared.distro)
        {
            return Err(format!(
                "WSL server setup is already active for distribution {}.",
                prepared.distro
            ));
        }
        state.active.insert(
            prepared.request_id.clone(),
            ActiveWslSetup {
                generation: prepared.probe_generation,
                distro: prepared.distro.clone(),
                cancellation,
            },
        );
        Ok(())
    }

    fn finish_active(&self, request_id: &str) {
        let removed = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .remove(request_id);
        if removed.is_some() {
            self.changed.notify_waiters();
        }
    }

    fn claim_active_completion(&self, request_id: &str, generation: u64) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = !self.cancellation.is_cancelled()
            && state.active.get(request_id).is_some_and(|active| {
                active.generation == generation && !active.cancellation.is_cancelled()
            });
        if current {
            state.active.remove(request_id);
        }
        drop(state);
        if current {
            self.changed.notify_waiters();
        }
        current
    }
}

fn terminal_result(
    prepared: &PreparedWslSetup,
    status: WslSetupStatus,
    stage: RemoteSetupStage,
    mutation_status: &'static str,
    cleanup_status: &'static str,
    descriptor: Option<Value>,
    message: Option<String>,
) -> WslSetupResult {
    WslSetupResult {
        request_id: prepared.request_id.clone(),
        generation: prepared.probe_generation,
        distro: prepared.distro.clone(),
        status,
        stage,
        mutation_status,
        cleanup_status,
        installed_version: None,
        previous_version: prepared.previous_version.clone(),
        managed_binary_path: Some(prepared.paths.current_binary.clone()),
        data_root: prepared.paths.data_root.clone(),
        descriptor,
        message,
    }
}

fn remote_host_probe_wire(probe: &WslHostProbe, architecture: &str) -> RemoteHostProbeWire {
    RemoteHostProbeWire {
        os: "linux",
        architecture: architecture.to_string(),
        installed_version: probe.installed_version.clone(),
        service_mode: None,
        service_state: if probe.installed_binary_path.is_some() {
            "stopped"
        } else {
            "notInstalled"
        },
        data_root: Some(probe.data_root.clone()),
        control_available: probe.control_available,
        free_bytes: probe.free_bytes,
        install_authority: "user",
    }
}

fn normalize_linux_architecture(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" => Ok("x86_64".to_string()),
        "aarch64" | "arm64" => Ok("aarch64".to_string()),
        other => Err(format!(
            "WSL distribution reported unsupported architecture {other}."
        )),
    }
}

fn validate_absolute_linux_path(value: &str, label: &str) -> Result<(), String> {
    if value.starts_with('/')
        && !value.contains('\0')
        && !value.contains('\r')
        && !value.contains('\n')
        && !value.split('/').any(|component| component == "..")
    {
        Ok(())
    } else {
        Err(format!("{label} must be a safe absolute Linux path."))
    }
}

fn validate_running_distro(
    discovery: &WslDiscoverySnapshot,
    expected_generation: u64,
    distro: &str,
) -> Result<(), String> {
    if discovery.generation != expected_generation
        || discovery.health != WslDiscoveryHealth::Available
    {
        return Err(
            "WSL discovery changed; refresh and probe the distribution again before setup."
                .to_string(),
        );
    }
    match discovery
        .distros
        .iter()
        .find(|candidate| candidate.name == distro)
    {
        Some(candidate) if candidate.state == WslDistroState::Running => Ok(()),
        Some(_) => Err(format!(
            "WSL distribution {distro} is not Running. BiBCode will not start it automatically."
        )),
        None => Err(format!(
            "WSL distribution {distro} is no longer present in authoritative discovery."
        )),
    }
}

pub(crate) fn validate_setup_descriptor(
    descriptor: &Value,
    target_version: &str,
    architecture: &str,
    expected_identity: Option<&WslExpectedIdentity>,
) -> Result<(), String> {
    let environment_id = descriptor
        .get("environmentId")
        .and_then(Value::as_str)
        .ok_or_else(|| "The WSL environment descriptor has no environment identity.".to_string())?;
    let storage_id = descriptor
        .get("storageInstanceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "The WSL environment descriptor has no storage identity.".to_string())?;
    Uuid::parse_str(environment_id)
        .map_err(|_| "The WSL environment descriptor identity is invalid.".to_string())?;
    Uuid::parse_str(storage_id)
        .map_err(|_| "The WSL storage descriptor identity is invalid.".to_string())?;
    if let Some(expected) = expected_identity {
        if environment_id != expected.environment_id {
            return Err(
                "The restarted WSL server environment identity changed during setup.".to_string(),
            );
        }
        if storage_id != expected.storage_instance_id {
            return Err(
                "The restarted WSL server storage identity changed during setup.".to_string(),
            );
        }
    }
    if descriptor.get("serverVersion").and_then(Value::as_str) != Some(target_version) {
        return Err(
            "The restarted WSL server version does not match the consented artifact.".to_string(),
        );
    }
    if descriptor.pointer("/platform/os").and_then(Value::as_str) != Some("linux") {
        return Err("The restarted WSL server did not report Linux.".to_string());
    }
    let expected_arch = match architecture {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return Err("The consented WSL architecture is unsupported.".to_string()),
    };
    if descriptor.pointer("/platform/arch").and_then(Value::as_str) != Some(expected_arch) {
        return Err("The restarted WSL server architecture does not match the probe.".to_string());
    }
    let minimum = descriptor
        .pointer("/protocol/minimum")
        .and_then(Value::as_u64)
        .ok_or_else(|| "The WSL environment descriptor protocol minimum is invalid.".to_string())?;
    let maximum = descriptor
        .pointer("/protocol/maximum")
        .and_then(Value::as_u64)
        .ok_or_else(|| "The WSL environment descriptor protocol maximum is invalid.".to_string())?;
    let supported = u64::from(bibcode_server::ENVIRONMENT_PROTOCOL_VERSION);
    if minimum > supported || maximum < supported {
        return Err(
            "The restarted WSL server protocol is incompatible with this desktop.".to_string(),
        );
    }
    if descriptor
        .pointer("/transport/mode")
        .and_then(Value::as_str)
        != Some("loopback-http")
    {
        return Err("The restarted WSL server descriptor is not loopback-only.".to_string());
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WslExecCommand {
    distro: String,
    program: String,
    arguments: Vec<String>,
}

impl WslExecCommand {
    pub(crate) fn new(
        distro: impl Into<String>,
        program: impl Into<String>,
        arguments: impl IntoIterator<Item = impl Into<String>>,
    ) -> Result<Self, String> {
        let distro = distro.into();
        let program = program.into();
        if distro.trim().is_empty()
            || distro.chars().count() > 256
            || distro.chars().any(char::is_control)
        {
            return Err("The WSL distribution locator is invalid.".to_string());
        }
        if program.is_empty() || program.chars().any(char::is_control) {
            return Err("The WSL setup program is invalid.".to_string());
        }
        let arguments = arguments.into_iter().map(Into::into).collect::<Vec<_>>();
        if arguments.iter().any(|argument| {
            argument.contains('\0') || argument.contains('\r') || argument.contains('\n')
        }) {
            return Err("A WSL setup argument is invalid.".to_string());
        }
        Ok(Self {
            distro,
            program,
            arguments,
        })
    }

    pub(crate) fn argv(&self) -> Vec<&str> {
        let mut argv = vec![
            "--distribution",
            self.distro.as_str(),
            "--exec",
            self.program.as_str(),
        ];
        argv.extend(self.arguments.iter().map(String::as_str));
        argv
    }
}

#[derive(Debug)]
struct ProcessWslSetupHost;

#[derive(Debug)]
struct WslExecOutput {
    stdout: Vec<u8>,
}

async fn read_command_output<R: AsyncRead + Unpin>(
    mut reader: R,
    total: Arc<AtomicUsize>,
) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            return Ok(output);
        }
        let previous = total.fetch_add(read, Ordering::AcqRel);
        if previous.saturating_add(read) > WSL_SETUP_MAX_OUTPUT_BYTES {
            return Err(io::Error::other("WSL setup command output limit exceeded"));
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

async fn terminate_setup_child(child: &mut Child) {
    if let Err(error) = child.kill().await
        && error.kind() != io::ErrorKind::InvalidInput
    {
        tracing::debug!("failed to terminate WSL setup child: {error}");
    }
}

async fn abort_setup_io_tasks(
    input: Option<tokio::task::JoinHandle<Result<(), String>>>,
    stdout: tokio::task::JoinHandle<io::Result<Vec<u8>>>,
    stderr: tokio::task::JoinHandle<io::Result<Vec<u8>>>,
) {
    if let Some(input) = &input {
        input.abort();
    }
    stdout.abort();
    stderr.abort();
    if let Some(input) = input {
        let _ = input.await;
    }
    let _ = tokio::join!(stdout, stderr);
}

fn decode_command_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let (chunks, _) = bytes[2..].as_chunks::<2>();
        let values = chunks
            .iter()
            .map(|chunk| u16::from_le_bytes(*chunk))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&values)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

async fn copy_setup_input(
    path: PathBuf,
    mut stdin: tokio::process::ChildStdin,
    total_bytes: u64,
    cancellation: CancellationToken,
    progress: SetupProgressSink,
) -> Result<(), String> {
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| format!("Could not open the verified server artifact: {error}"))?;
    let mut completed = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = tokio::select! {
            () = cancellation.cancelled() => return Err("WSL setup transfer was cancelled.".to_string()),
            read = file.read(&mut buffer) => read,
        }
        .map_err(|error| format!("Could not read the verified server artifact: {error}"))?;
        if read == 0 {
            break;
        }
        tokio::select! {
            () = cancellation.cancelled() => return Err("WSL setup transfer was cancelled.".to_string()),
            result = stdin.write_all(&buffer[..read]) => result,
        }
        .map_err(|error| format!("Could not transfer the verified server artifact: {error}"))?;
        completed = completed.saturating_add(read as u64);
        progress(RemoteSetupStage::Transfer, completed, Some(total_bytes));
    }
    stdin
        .shutdown()
        .await
        .map_err(|error| format!("Could not close the WSL artifact transfer: {error}"))
}

async fn run_wsl_exec(
    command: &WslExecCommand,
    input: Option<(&Path, u64, SetupProgressSink)>,
    timeout: Duration,
    cancellation: &CancellationToken,
) -> Result<WslExecOutput, String> {
    let mut process = Command::new("wsl.exe");
    configure_background_command(&mut process);
    process
        .args(command.argv())
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = process
        .spawn()
        .map_err(|error| format!("Could not start structured WSL setup command: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "WSL setup command stdout was not captured.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "WSL setup command stderr was not captured.".to_string())?;
    let total = Arc::new(AtomicUsize::new(0));
    let stdout_task = tokio::spawn(read_command_output(stdout, total.clone()));
    let stderr_task = tokio::spawn(read_command_output(stderr, total));
    let input_task = input.map(|(path, size, progress)| {
        let stdin = child
            .stdin
            .take()
            .expect("piped WSL setup stdin is present");
        tokio::spawn(copy_setup_input(
            path.to_path_buf(),
            stdin,
            size,
            cancellation.clone(),
            progress,
        ))
    });

    enum WaitOutcome {
        Exited(io::Result<std::process::ExitStatus>),
        Cancelled,
        TimedOut,
    }
    let outcome = tokio::select! {
        result = child.wait() => WaitOutcome::Exited(result),
        () = cancellation.cancelled() => WaitOutcome::Cancelled,
        () = tokio::time::sleep(timeout) => WaitOutcome::TimedOut,
    };
    let status = match outcome {
        WaitOutcome::Exited(Ok(status)) => status,
        WaitOutcome::Exited(Err(error)) => {
            terminate_setup_child(&mut child).await;
            abort_setup_io_tasks(input_task, stdout_task, stderr_task).await;
            return Err(format!("Could not wait for WSL setup command: {error}"));
        }
        WaitOutcome::Cancelled => {
            terminate_setup_child(&mut child).await;
            abort_setup_io_tasks(input_task, stdout_task, stderr_task).await;
            return Err("WSL setup command was cancelled.".to_string());
        }
        WaitOutcome::TimedOut => {
            terminate_setup_child(&mut child).await;
            abort_setup_io_tasks(input_task, stdout_task, stderr_task).await;
            return Err("WSL setup command exceeded its deadline.".to_string());
        }
    };
    if let Some(input_task) = input_task {
        input_task
            .await
            .map_err(|error| format!("WSL artifact transfer task failed: {error}"))??;
    }
    let stdout = stdout_task
        .await
        .map_err(|error| format!("WSL setup stdout task failed: {error}"))?
        .map_err(|error| format!("Could not read WSL setup stdout: {error}"))?;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("WSL setup stderr task failed: {error}"))?
        .map_err(|error| format!("Could not read WSL setup stderr: {error}"))?;
    if !status.success() {
        return Err(format!(
            "Structured WSL setup command {} exited with status {}: {}",
            command.program,
            status,
            decode_command_output(&stderr).trim()
        ));
    }
    Ok(WslExecOutput { stdout })
}

async fn run_simple_wsl_command(
    distro: &str,
    program: &str,
    arguments: impl IntoIterator<Item = impl Into<String>>,
    cancellation: &CancellationToken,
) -> Result<WslExecOutput, String> {
    let command = WslExecCommand::new(distro, program, arguments)?;
    run_wsl_exec(&command, None, WSL_SETUP_COMMAND_TIMEOUT, cancellation).await
}

fn environment_value(environment: &str, key: &str) -> Option<String> {
    environment
        .lines()
        .find_map(|line| line.strip_prefix(&format!("{key}=")))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_bibcode_version(output: &[u8]) -> Result<String, String> {
    decode_command_output(output)
        .split_whitespace()
        .last()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "The managed WSL bibcode binary did not report a version.".to_string())
}

fn parse_available_bytes(output: &[u8]) -> Result<u64, String> {
    let text = decode_command_output(output);
    let line = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "WSL disk-space probe returned no rows.".to_string())?;
    let fields = line.split_whitespace().collect::<Vec<_>>();
    let available_kib = fields
        .get(3)
        .ok_or_else(|| "WSL disk-space probe returned an incomplete row.".to_string())?
        .parse::<u64>()
        .map_err(|_| "WSL disk-space probe returned an invalid available size.".to_string())?;
    Ok(available_kib.saturating_mul(1024))
}

async fn command_succeeds(
    distro: &str,
    program: &str,
    arguments: impl IntoIterator<Item = impl Into<String>>,
    cancellation: &CancellationToken,
) -> bool {
    run_simple_wsl_command(distro, program, arguments, cancellation)
        .await
        .is_ok()
}

impl WslSetupHost for ProcessWslSetupHost {
    fn probe<'a>(
        &'a self,
        distro: &'a str,
        cancellation: &'a CancellationToken,
    ) -> HostFuture<'a, WslHostProbe> {
        Box::pin(async move {
            let environment =
                run_simple_wsl_command(distro, "env", std::iter::empty::<String>(), cancellation)
                    .await?;
            let environment = decode_command_output(&environment.stdout);
            let home = environment_value(&environment, "HOME")
                .ok_or_else(|| format!("WSL distribution {distro} did not report HOME."))?;
            validate_absolute_linux_path(&home, "WSL home")?;
            let data_root = environment_value(&environment, "BIBCODE_HOME")
                .unwrap_or_else(|| format!("{}/.bibcode", home.trim_end_matches('/')));
            validate_absolute_linux_path(&data_root, "WSL data root")?;
            let architecture =
                run_simple_wsl_command(distro, "uname", ["-m"], cancellation).await?;
            let architecture = decode_command_output(&architecture.stdout)
                .trim()
                .to_string();
            let current_binary = managed_wsl_server_binary(&home)?;
            let installed = command_succeeds(
                distro,
                "test",
                ["-x", current_binary.as_str()],
                cancellation,
            )
            .await;
            let installed_version = if installed {
                let output =
                    run_simple_wsl_command(distro, &current_binary, ["--version"], cancellation)
                        .await?;
                Some(parse_bibcode_version(&output.stdout)?)
            } else {
                None
            };
            let tar_available = command_succeeds(distro, "tar", ["--version"], cancellation).await;
            let disk =
                run_simple_wsl_command(distro, "df", ["-Pk", home.as_str()], cancellation).await?;
            Ok(WslHostProbe {
                architecture,
                home,
                data_root,
                installed_binary_path: installed.then_some(current_binary),
                installed_version,
                tar_available,
                free_bytes: parse_available_bytes(&disk.stdout)?,
                control_available: false,
            })
        })
    }

    fn install<'a>(
        &'a self,
        distro: &'a str,
        paths: &'a WslSetupPaths,
        artifact: &'a WslVerifiedArtifact,
        cancellation: &'a CancellationToken,
        progress: SetupProgressSink,
    ) -> HostFuture<'a, WslInstallReceipt> {
        Box::pin(async move {
            progress(RemoteSetupStage::Install, 0, None);
            run_simple_wsl_command(
                distro,
                "mkdir",
                [
                    "-p",
                    "--",
                    paths.root.as_str(),
                    paths.versions_root.as_str(),
                    paths.staging_root.as_str(),
                ],
                cancellation,
            )
            .await?;
            let previous_target = run_simple_wsl_command(
                distro,
                "readlink",
                ["-f", paths.current_package_root.as_str()],
                cancellation,
            )
            .await
            .ok()
            .and_then(|output| {
                decode_command_output(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .map(str::to_string)
            });
            let previous_version = if previous_target.is_some()
                && command_succeeds(
                    distro,
                    "test",
                    ["-x", paths.current_binary.as_str()],
                    cancellation,
                )
                .await
            {
                run_simple_wsl_command(distro, &paths.current_binary, ["--version"], cancellation)
                    .await
                    .ok()
                    .and_then(|output| parse_bibcode_version(&output.stdout).ok())
            } else {
                None
            };
            let transfer = WslExecCommand::new(
                distro,
                "dd",
                [
                    format!("of={}", paths.staged_archive),
                    "bs=65536".to_string(),
                    "status=none".to_string(),
                ],
            )?;
            run_wsl_exec(
                &transfer,
                Some((&artifact.path, artifact.record.size, progress.clone())),
                WSL_SETUP_TRANSFER_TIMEOUT,
                cancellation,
            )
            .await?;
            let remote_hash = run_simple_wsl_command(
                distro,
                "sha256sum",
                ["--", paths.staged_archive.as_str()],
                cancellation,
            )
            .await?;
            let remote_hash = decode_command_output(&remote_hash.stdout)
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if remote_hash != artifact.record.sha256 {
                return Err("The server artifact SHA-256 changed during WSL transfer.".to_string());
            }
            run_simple_wsl_command(
                distro,
                "mkdir",
                ["--", paths.staged_extract_root.as_str()],
                cancellation,
            )
            .await?;
            run_simple_wsl_command(
                distro,
                "tar",
                [
                    "-xzf",
                    paths.staged_archive.as_str(),
                    "-C",
                    paths.staged_extract_root.as_str(),
                ],
                cancellation,
            )
            .await?;
            let staged_binary = format!("{}/bin/bibcode", paths.staged_package_root);
            run_simple_wsl_command(distro, "test", ["-x", staged_binary.as_str()], cancellation)
                .await?;
            let staged_version =
                run_simple_wsl_command(distro, &staged_binary, ["--version"], cancellation).await?;
            if parse_bibcode_version(&staged_version.stdout)? != artifact.record.version {
                return Err(
                    "The extracted WSL server version does not match the signed artifact."
                        .to_string(),
                );
            }
            run_simple_wsl_command(
                distro,
                "mv",
                [
                    "--",
                    paths.staged_extract_root.as_str(),
                    paths.installed_version_root.as_str(),
                ],
                cancellation,
            )
            .await?;
            if let Err(error) = run_simple_wsl_command(
                distro,
                "ln",
                [
                    "-s",
                    "--",
                    paths.installed_package_root.as_str(),
                    paths.next_current_link.as_str(),
                ],
                cancellation,
            )
            .await
            {
                remove_new_install(distro, paths).await;
                return Err(error);
            }
            if let Err(error) = run_simple_wsl_command(
                distro,
                "mv",
                [
                    "-Tf",
                    "--",
                    paths.next_current_link.as_str(),
                    paths.current_package_root.as_str(),
                ],
                cancellation,
            )
            .await
            {
                remove_new_install(distro, paths).await;
                return Err(error);
            }
            let receipt = WslInstallReceipt {
                previous_target,
                previous_version,
                installed_target: paths.installed_package_root.clone(),
            };
            if cancellation.is_cancelled() {
                let cleanup_cancellation = CancellationToken::new();
                self.rollback(distro, paths, &receipt, &cleanup_cancellation)
                    .await?;
                return Err("WSL setup was cancelled after the atomic switch; the previous version was restored."
                    .to_string());
            }
            progress(
                RemoteSetupStage::Install,
                artifact.record.size,
                Some(artifact.record.size),
            );
            Ok(receipt)
        })
    }

    fn rollback<'a>(
        &'a self,
        distro: &'a str,
        paths: &'a WslSetupPaths,
        receipt: &'a WslInstallReceipt,
        cancellation: &'a CancellationToken,
    ) -> HostFuture<'a, ()> {
        Box::pin(async move {
            match &receipt.previous_target {
                Some(previous) => {
                    run_simple_wsl_command(
                        distro,
                        "ln",
                        [
                            "-s",
                            "--",
                            previous.as_str(),
                            paths.next_current_link.as_str(),
                        ],
                        cancellation,
                    )
                    .await?;
                    run_simple_wsl_command(
                        distro,
                        "mv",
                        [
                            "-Tf",
                            "--",
                            paths.next_current_link.as_str(),
                            paths.current_package_root.as_str(),
                        ],
                        cancellation,
                    )
                    .await?;
                }
                None => {
                    run_simple_wsl_command(
                        distro,
                        "rm",
                        ["-f", "--", paths.current_package_root.as_str()],
                        cancellation,
                    )
                    .await?;
                }
            }
            if receipt.installed_target == paths.installed_package_root {
                run_simple_wsl_command(
                    distro,
                    "rm",
                    ["-rf", "--", paths.installed_version_root.as_str()],
                    cancellation,
                )
                .await?;
            }
            Ok(())
        })
    }

    fn cleanup<'a>(&'a self, distro: &'a str, paths: &'a WslSetupPaths) -> HostFuture<'a, ()> {
        Box::pin(async move {
            let cleanup = CancellationToken::new();
            let first = run_simple_wsl_command(
                distro,
                "rm",
                [
                    "-f",
                    "--",
                    paths.staged_archive.as_str(),
                    paths.next_current_link.as_str(),
                ],
                &cleanup,
            )
            .await;
            let second = run_simple_wsl_command(
                distro,
                "rm",
                ["-rf", "--", paths.staged_extract_root.as_str()],
                &cleanup,
            )
            .await;
            match (first, second) {
                (Ok(_), Ok(_)) => Ok(()),
                (Err(first), Ok(_)) => Err(first),
                (Ok(_), Err(second)) => Err(second),
                (Err(first), Err(second)) => Err(format!("{first} {second}")),
            }
        })
    }
}

async fn remove_new_install(distro: &str, paths: &WslSetupPaths) {
    let cleanup = CancellationToken::new();
    let _ = run_simple_wsl_command(
        distro,
        "rm",
        ["-f", "--", paths.next_current_link.as_str()],
        &cleanup,
    )
    .await;
    let _ = run_simple_wsl_command(
        distro,
        "rm",
        ["-rf", "--", paths.installed_version_root.as_str()],
        &cleanup,
    )
    .await;
}
