//! Bridges the in-process server's remote-update seam (spec section 4.5) onto the
//! desktop host's real updater. `updater.install` triggers exactly the flow a local
//! user triggers — including the update-protection drain of the backend.

use std::sync::Arc;

use bibcode_server::remote_update::{
    HostUpdaterFuture, HostUpdaterStatus, RemoteUpdateDelegate, RemoteUpdateInstallMode,
    RemoteUpdateState, RemoteUpdateSupport, RemoteUpdateSupportReason,
};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::backend::BackendSupervisor;
use crate::updates::{DesktopUpdateInstallInput, DesktopUpdateManager};

/// The same facts feed `ServerConfig.remote_update_support` and this delegate, so the
/// descriptor and the RPC behavior cannot drift.
#[must_use]
pub fn derive_remote_update_support(updater_enabled: bool) -> RemoteUpdateSupport {
    if cfg!(debug_assertions) {
        RemoteUpdateSupport {
            install_mode: RemoteUpdateInstallMode::Manual,
            reason: RemoteUpdateSupportReason::UnpackagedBuild,
        }
    } else if updater_enabled {
        RemoteUpdateSupport {
            install_mode: RemoteUpdateInstallMode::Interactive,
            reason: RemoteUpdateSupportReason::Available,
        }
    } else {
        RemoteUpdateSupport {
            install_mode: RemoteUpdateInstallMode::Manual,
            reason: RemoteUpdateSupportReason::UpdaterUnavailable,
        }
    }
}

#[must_use]
pub fn map_desktop_update_state(state: &Value) -> HostUpdaterStatus {
    let phase = state["phase"].as_str().unwrap_or("idle");
    let status = state["status"].as_str().unwrap_or("idle");
    let latest_version = state["availableVersion"]
        .as_str()
        .or_else(|| state["downloadedVersion"].as_str())
        .map(str::to_owned);
    let mapped = match (phase, status) {
        ("protecting" | "installing", _) => RemoteUpdateState::Installing,
        ("failed", _) | (_, "error") => RemoteUpdateState::Error,
        (_, "checking") => RemoteUpdateState::Checking,
        (_, "downloading") => RemoteUpdateState::Downloading,
        (_, "available" | "downloaded") => RemoteUpdateState::UpdateAvailable,
        (_, "up-to-date") => RemoteUpdateState::UpToDate,
        _ => RemoteUpdateState::Idle,
    };
    let error = if mapped == RemoteUpdateState::Error {
        state["message"].as_str().map(str::to_owned)
    } else {
        None
    };
    HostUpdaterStatus {
        latest_version,
        state: mapped,
        error,
    }
}

pub struct DesktopRemoteUpdateDelegate<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> DesktopRemoteUpdateDelegate<R> {
    pub fn new(app: AppHandle<R>) -> Arc<Self> {
        Arc::new(Self { app })
    }
}

impl<R: Runtime> RemoteUpdateDelegate for DesktopRemoteUpdateDelegate<R> {
    fn status(&self) -> HostUpdaterFuture {
        let app = self.app.clone();
        Box::pin(async move {
            let state = app.state::<DesktopUpdateManager>().state(&app);
            map_desktop_update_state(&state)
        })
    }

    fn check(&self) -> HostUpdaterFuture {
        let app = self.app.clone();
        Box::pin(async move {
            let result = app
                .state::<DesktopUpdateManager>()
                .check_for_update(app.clone())
                .await;
            map_desktop_update_state(&result["state"])
        })
    }

    fn request_install(&self) -> HostUpdaterFuture {
        let app = self.app.clone();
        Box::pin(async move {
            // Kick off the full host flow in the background; the remote client polls
            // `updater.status` for progress. Install failures surface there as
            // state "error".
            tauri::async_runtime::spawn(run_remote_install(app.clone()));
            let state = app.state::<DesktopUpdateManager>().state(&app);
            let mut mapped = map_desktop_update_state(&state);
            if !matches!(
                mapped.state,
                RemoteUpdateState::Error | RemoteUpdateState::Installing
            ) {
                // The spawned flow is now driving; report forward motion immediately
                // so the caller's snapshot is not a stale "update-available".
                mapped.state = RemoteUpdateState::Installing;
            }
            mapped
        })
    }
}

async fn run_remote_install<R: Runtime>(app: AppHandle<R>) {
    let updates = app.state::<DesktopUpdateManager>();
    let state = updates.state(&app);
    let needs_download = state["downloadedVersion"].as_str().is_none();
    if needs_download {
        if state["availableVersion"].as_str().is_none() {
            let checked = updates.check_for_update(app.clone()).await;
            if checked["state"]["availableVersion"].as_str().is_none() {
                return;
            }
        }
        let downloaded = updates.download_update(app.clone()).await;
        if downloaded["state"]["downloadedVersion"].as_str().is_none() {
            return;
        }
    }
    let backend = app.state::<BackendSupervisor>();
    let _ = updates
        .install_update(&app, backend.inner(), DesktopUpdateInstallInput::default())
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn support_derivation_is_honest_about_the_updater() {
        if cfg!(debug_assertions) {
            let support = derive_remote_update_support(true);
            assert_eq!(support.install_mode, RemoteUpdateInstallMode::Manual);
            assert_eq!(support.reason, RemoteUpdateSupportReason::UnpackagedBuild);
        } else {
            let enabled = derive_remote_update_support(true);
            assert_eq!(enabled.install_mode, RemoteUpdateInstallMode::Interactive);
            assert_eq!(enabled.reason, RemoteUpdateSupportReason::Available);

            let disabled = derive_remote_update_support(false);
            assert_eq!(disabled.install_mode, RemoteUpdateInstallMode::Manual);
            assert_eq!(
                disabled.reason,
                RemoteUpdateSupportReason::UpdaterUnavailable
            );
        }
    }

    #[test]
    fn maps_every_desktop_updater_state_onto_the_wire_contract() {
        let cases = [
            (
                json!({"status": "idle", "phase": "idle"}),
                RemoteUpdateState::Idle,
            ),
            (
                json!({"status": "disabled", "phase": "idle"}),
                RemoteUpdateState::Idle,
            ),
            (
                json!({"status": "checking", "phase": "checking"}),
                RemoteUpdateState::Checking,
            ),
            (
                json!({"status": "up-to-date", "phase": "idle"}),
                RemoteUpdateState::UpToDate,
            ),
            (
                json!({"status": "available", "phase": "available", "availableVersion": "0.5.0"}),
                RemoteUpdateState::UpdateAvailable,
            ),
            (
                json!({"status": "downloading", "phase": "available", "availableVersion": "0.5.0"}),
                RemoteUpdateState::Downloading,
            ),
            (
                json!({"status": "downloaded", "phase": "available", "downloadedVersion": "0.5.0"}),
                RemoteUpdateState::UpdateAvailable,
            ),
            (
                json!({"status": "downloaded", "phase": "protecting", "downloadedVersion": "0.5.0"}),
                RemoteUpdateState::Installing,
            ),
            (
                json!({"status": "downloaded", "phase": "installing", "downloadedVersion": "0.5.0"}),
                RemoteUpdateState::Installing,
            ),
            (
                json!({"status": "error", "phase": "failed", "message": "boom"}),
                RemoteUpdateState::Error,
            ),
        ];
        for (state, expected) in cases {
            let mapped = map_desktop_update_state(&state);
            assert_eq!(mapped.state, expected, "for desktop state {state}");
        }

        let available = map_desktop_update_state(
            &json!({"status": "available", "phase": "available", "availableVersion": "0.5.0"}),
        );
        assert_eq!(available.latest_version.as_deref(), Some("0.5.0"));
        assert_eq!(available.error, None);

        let failed = map_desktop_update_state(
            &json!({"status": "error", "phase": "failed", "message": "boom"}),
        );
        assert_eq!(failed.error.as_deref(), Some("boom"));
    }
}
