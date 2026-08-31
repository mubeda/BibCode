//! Remote server update contract mirror and host-updater seam (spec section 4.5).
//!
//! The TypeScript source of truth is `packages/contracts/src/remoteUpdate.ts`;
//! serde attributes here must keep the wire shapes byte-identical.

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteUpdateInstallMode {
    Interactive,
    Manual,
    /// Schema-reserved (spec D10); no v1 implementation.
    Supervised,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteUpdateSupportReason {
    Available,
    ManualUpdateRequired,
    UnpackagedBuild,
    UpdaterUnavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUpdateSupport {
    pub install_mode: RemoteUpdateInstallMode,
    pub reason: RemoteUpdateSupportReason,
}

impl RemoteUpdateSupport {
    #[must_use]
    pub const fn manual() -> Self {
        Self {
            install_mode: RemoteUpdateInstallMode::Manual,
            reason: RemoteUpdateSupportReason::ManualUpdateRequired,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteUpdateState {
    Idle,
    Checking,
    UpdateAvailable,
    Downloading,
    Installing,
    UpToDate,
    Error,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUpdateSnapshot {
    pub server_version: String,
    pub latest_version: Option<String>,
    pub state: RemoteUpdateState,
    pub error: Option<String>,
    pub support: RemoteUpdateSupport,
}

/// What the hosting process's updater knows; the service adds `server_version`
/// and `support` to build the wire snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostUpdaterStatus {
    pub latest_version: Option<String>,
    pub state: RemoteUpdateState,
    pub error: Option<String>,
}

pub type HostUpdaterFuture = Pin<Box<dyn Future<Output = HostUpdaterStatus> + Send>>;

const REMOTE_UPDATE_DELEGATE_TIMEOUT: Duration = Duration::from_secs(30);
const REMOTE_UPDATE_DELEGATE_TIMEOUT_ERROR: &str =
    "Desktop updater did not respond within 30 seconds.";

/// Implemented by the desktop host (pattern: `DesktopUiProcessObserver`).
/// Consulted only when `RemoteUpdateSupport.install_mode` is `Interactive`.
pub trait RemoteUpdateDelegate: Send + Sync + 'static {
    fn status(&self) -> HostUpdaterFuture;
    fn check(&self) -> HostUpdaterFuture;
    /// Starts (or joins) the host install flow and returns the current status;
    /// callers poll `status` for progress. Install failures ride in
    /// `HostUpdaterStatus { state: Error, error: Some(..) }`.
    fn request_install(&self) -> HostUpdaterFuture;
}

/// Wire error for `updater.install` on servers that cannot install remotely.
/// Must stay byte-identical to `RemoteUpdateInstallError` in
/// `packages/contracts/src/remoteUpdate.ts`.
#[must_use]
pub fn remote_update_manual_required_error() -> Value {
    json!({
        "_tag": "RemoteUpdateInstallError",
        "code": "remote_update_manual_required",
    })
}

#[derive(Clone)]
pub struct RemoteUpdateService {
    server_version: String,
    support: RemoteUpdateSupport,
    delegate: Option<Arc<dyn RemoteUpdateDelegate>>,
    delegate_timeout: Duration,
}

impl RemoteUpdateService {
    #[must_use]
    pub fn new(
        server_version: String,
        support: RemoteUpdateSupport,
        delegate: Option<Arc<dyn RemoteUpdateDelegate>>,
    ) -> Self {
        Self {
            server_version,
            support,
            delegate,
            delegate_timeout: REMOTE_UPDATE_DELEGATE_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_delegate_timeout(mut self, delegate_timeout: Duration) -> Self {
        self.delegate_timeout = delegate_timeout;
        self
    }

    fn interactive_delegate(&self) -> Option<&Arc<dyn RemoteUpdateDelegate>> {
        if self.support.install_mode == RemoteUpdateInstallMode::Interactive {
            self.delegate.as_ref()
        } else {
            None
        }
    }

    fn manual_status() -> HostUpdaterStatus {
        HostUpdaterStatus {
            latest_version: None,
            state: RemoteUpdateState::Idle,
            error: None,
        }
    }

    fn snapshot(&self, status: HostUpdaterStatus) -> RemoteUpdateSnapshot {
        RemoteUpdateSnapshot {
            server_version: self.server_version.clone(),
            latest_version: status.latest_version,
            state: status.state,
            error: status.error,
            support: self.support,
        }
    }

    async fn await_delegate(&self, future: HostUpdaterFuture) -> HostUpdaterStatus {
        match tokio::time::timeout(self.delegate_timeout, future).await {
            Ok(status) => status,
            Err(_) => HostUpdaterStatus {
                latest_version: None,
                state: RemoteUpdateState::Error,
                error: Some(REMOTE_UPDATE_DELEGATE_TIMEOUT_ERROR.to_owned()),
            },
        }
    }

    pub async fn status(&self) -> RemoteUpdateSnapshot {
        let status = match self.interactive_delegate() {
            Some(delegate) => self.await_delegate(delegate.status()).await,
            None => Self::manual_status(),
        };
        self.snapshot(status)
    }

    pub async fn check(&self) -> RemoteUpdateSnapshot {
        let status = match self.interactive_delegate() {
            Some(delegate) => self.await_delegate(delegate.check()).await,
            None => Self::manual_status(),
        };
        self.snapshot(status)
    }

    pub async fn install(&self) -> Result<RemoteUpdateSnapshot, Value> {
        match self.interactive_delegate() {
            Some(delegate) => {
                Ok(self.snapshot(self.await_delegate(delegate.request_install()).await))
            }
            None => Err(remote_update_manual_required_error()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn manual_support() -> RemoteUpdateSupport {
        RemoteUpdateSupport {
            install_mode: RemoteUpdateInstallMode::Manual,
            reason: RemoteUpdateSupportReason::ManualUpdateRequired,
        }
    }

    fn interactive_support() -> RemoteUpdateSupport {
        RemoteUpdateSupport {
            install_mode: RemoteUpdateInstallMode::Interactive,
            reason: RemoteUpdateSupportReason::Available,
        }
    }

    struct FixtureDelegate;

    impl RemoteUpdateDelegate for FixtureDelegate {
        fn status(&self) -> HostUpdaterFuture {
            Box::pin(async {
                HostUpdaterStatus {
                    latest_version: Some("9.9.9".to_owned()),
                    state: RemoteUpdateState::UpdateAvailable,
                    error: None,
                }
            })
        }

        fn check(&self) -> HostUpdaterFuture {
            self.status()
        }

        fn request_install(&self) -> HostUpdaterFuture {
            Box::pin(async {
                HostUpdaterStatus {
                    latest_version: Some("9.9.9".to_owned()),
                    state: RemoteUpdateState::Installing,
                    error: None,
                }
            })
        }
    }

    struct PendingHostUpdater;

    impl RemoteUpdateDelegate for PendingHostUpdater {
        fn status(&self) -> HostUpdaterFuture {
            Box::pin(std::future::pending())
        }

        fn check(&self) -> HostUpdaterFuture {
            Box::pin(std::future::pending())
        }

        fn request_install(&self) -> HostUpdaterFuture {
            Box::pin(std::future::pending())
        }
    }

    #[test]
    fn snapshot_serializes_to_the_exact_contract_wire_shape() {
        let snapshot = RemoteUpdateSnapshot {
            server_version: "0.4.2".to_owned(),
            latest_version: None,
            state: RemoteUpdateState::Idle,
            error: None,
            support: manual_support(),
        };
        assert_eq!(
            serde_json::to_value(&snapshot).expect("snapshot serializes"),
            json!({
                "serverVersion": "0.4.2",
                "latestVersion": null,
                "state": "idle",
                "error": null,
                "support": { "installMode": "manual", "reason": "manual-update-required" }
            })
        );
    }

    #[test]
    fn manual_required_error_matches_the_typescript_tagged_error() {
        assert_eq!(
            remote_update_manual_required_error(),
            json!({
                "_tag": "RemoteUpdateInstallError",
                "code": "remote_update_manual_required"
            })
        );
    }

    #[tokio::test]
    async fn manual_service_reports_idle_null_latest_and_refuses_install() {
        let service = RemoteUpdateService::new("0.4.2".to_owned(), manual_support(), None);
        let snapshot = service.check().await;
        assert_eq!(snapshot.server_version, "0.4.2");
        assert_eq!(snapshot.latest_version, None);
        assert_eq!(snapshot.state, RemoteUpdateState::Idle);
        assert_eq!(snapshot.support, manual_support());

        let error = service
            .install()
            .await
            .expect_err("manual install must fail");
        assert_eq!(error, remote_update_manual_required_error());
    }

    #[tokio::test]
    async fn interactive_service_consults_the_delegate() {
        let service = RemoteUpdateService::new(
            "0.4.2".to_owned(),
            interactive_support(),
            Some(Arc::new(FixtureDelegate)),
        );
        let checked = service.check().await;
        assert_eq!(checked.latest_version.as_deref(), Some("9.9.9"));
        assert_eq!(checked.state, RemoteUpdateState::UpdateAvailable);

        let installing = service
            .install()
            .await
            .expect("interactive install accepted");
        assert_eq!(installing.state, RemoteUpdateState::Installing);
    }

    #[tokio::test]
    async fn hung_delegate_calls_return_typed_error_snapshots() {
        let service = RemoteUpdateService::new(
            "0.4.2".to_owned(),
            interactive_support(),
            Some(Arc::new(PendingHostUpdater)),
        )
        .with_delegate_timeout(std::time::Duration::from_millis(10));

        let status = service.status().await;
        assert_eq!(status.state, RemoteUpdateState::Error);
        assert_eq!(
            status.error.as_deref(),
            Some("Desktop updater did not respond within 30 seconds.")
        );
        let checked = service.check().await;
        assert_eq!(checked.state, RemoteUpdateState::Error);
        let installing = service
            .install()
            .await
            .expect("interactive timeout is a typed status");
        assert_eq!(installing.state, RemoteUpdateState::Error);
    }

    #[tokio::test]
    async fn interactive_support_without_a_delegate_degrades_to_manual_behavior() {
        // Defensive: never panic if wiring forgot the delegate.
        let service = RemoteUpdateService::new("0.4.2".to_owned(), interactive_support(), None);
        assert_eq!(service.status().await.state, RemoteUpdateState::Idle);
        assert!(service.install().await.is_err());
    }
}
