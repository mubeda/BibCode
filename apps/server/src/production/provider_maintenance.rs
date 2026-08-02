#[cfg(test)]
mod tests {
    use std::{
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;
    use tokio_util::sync::CancellationToken;
    use url::Url;

    use super::*;

    #[test]
    fn resolves_cross_platform_installation_sources() {
        let cases = [
            (
                "codex",
                "codex",
                Some("C:/Users/me/AppData/Roaming/npm/codex.cmd"),
                None,
                "npm install -g @openai/codex@latest",
            ),
            (
                "codex",
                "codex",
                Some("C:/Users/me/.bun/bin/codex.exe"),
                None,
                "bun i -g @openai/codex@latest",
            ),
            (
                "claudeAgent",
                "claude",
                Some("/Users/me/.local/bin/claude"),
                None,
                "/Users/me/.local/bin/claude update",
            ),
            (
                "claudeAgent",
                "claude",
                Some("/opt/homebrew/bin/claude"),
                None,
                "brew upgrade claude-code",
            ),
            (
                "opencode",
                "opencode",
                Some("/home/me/.opencode/bin/opencode"),
                None,
                "/home/me/.opencode/bin/opencode upgrade",
            ),
            (
                "opencode",
                "opencode",
                Some("/home/linuxbrew/.linuxbrew/bin/opencode"),
                None,
                "brew upgrade anomalyco/tap/opencode",
            ),
            (
                "codex",
                "codex",
                Some("/home/me/.local/share/pnpm/codex"),
                None,
                "pnpm add -g @openai/codex@latest",
            ),
            (
                "codex",
                "codex",
                Some("/home/me/.vite-plus/bin/codex"),
                None,
                "vp i -g @openai/codex",
            ),
            (
                "codex",
                "codex",
                Some("/usr/local/bin/codex"),
                Some("/usr/local/lib/node_modules/@openai/codex/bin/codex.js"),
                "npm install -g @openai/codex@latest",
            ),
            (
                "codex",
                "codex",
                Some("/srv/project/node_modules/.bin/codex"),
                None,
                "npm install -g @openai/codex@latest",
            ),
            (
                "codex",
                "codex",
                Some("C:/npm/node_modules/@openai/codex/bin/codex.js"),
                None,
                "npm install -g @openai/codex@latest",
            ),
            (
                "codex",
                "codex",
                Some("/usr/local/bin/codex"),
                Some("/Users/me/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js"),
                "pnpm add -g @openai/codex@latest",
            ),
            (
                "codex",
                "codex",
                Some("/usr/bin/codex"),
                Some("/home/me/.local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex.js"),
                "pnpm add -g @openai/codex@latest",
            ),
            (
                "codex",
                "codex",
                Some("/srv/tools/codex"),
                None,
                "npm install -g @openai/codex@latest",
            ),
        ];
        for (driver, binary, resolved, canonical, expected) in cases {
            let capabilities = capabilities_for_paths(
                driver,
                binary,
                resolved.map(Path::new),
                canonical.map(Path::new),
            );
            assert_eq!(
                capabilities
                    .update
                    .as_ref()
                    .map(|value| value.display.as_str()),
                Some(expected)
            );
        }
    }

    #[test]
    fn native_installers_require_exact_paths() {
        let cases = [
            (
                "claudeAgent",
                "/srv/.local/bin/claude-wrapper",
                None,
            ),
            (
                "opencode",
                "/srv/.opencode/bin/opencode-backup",
                None,
            ),
            (
                "claudeAgent",
                "C:/Users/me/.local/bin/claude.exe",
                Some("C:/Users/me/.local/bin/claude.exe update"),
            ),
            (
                "opencode",
                "C:/Users/me/.opencode/bin/opencode.exe",
                Some("C:/Users/me/.opencode/bin/opencode.exe upgrade"),
            ),
        ];
        for (driver, binary, expected) in cases {
            let capabilities =
                capabilities_for_paths(driver, binary, Some(Path::new(binary)), None);
            assert_eq!(
                capabilities
                    .update
                    .as_ref()
                    .map(|value| value.display.as_str()),
                expected
            );
        }
    }

    #[test]
    fn unknown_explicit_path_is_manual_only() {
        let capabilities = capabilities_for_paths(
            "codex",
            "/srv/custom/codex",
            Some(Path::new("/srv/custom/codex")),
            None,
        );
        assert!(capabilities.update.is_none());
    }

    #[test]
    fn compares_release_and_prerelease_versions() {
        assert_eq!(
            advisory_status(Some("2.1.110"), Some("2.1.111")),
            "behind_latest"
        );
        assert_eq!(advisory_status(Some("2.1.111"), Some("2.1.111")), "current");
        assert_eq!(
            advisory_status(Some("2.1.111-beta.1"), Some("2.1.111")),
            "behind_latest"
        );
        assert_eq!(
            advisory_status(Some("Claude Code 2.1.111"), Some("2.1.111")),
            "current"
        );
        assert_eq!(advisory_status(None, Some("2.1.111")), "unknown");
    }

    fn target(driver: &str, binary_path: &str) -> ProviderMaintenanceTarget {
        ProviderMaintenanceTarget {
            instance_id: driver.to_owned(),
            driver: driver.to_owned(),
            binary_path: binary_path.to_owned(),
            environment: Vec::new(),
        }
    }

    fn installed_snapshot(driver: &str, version: &str) -> Value {
        json!({ "instanceId": driver, "driver": driver, "enabled": true, "installed": true, "version": version, "checkedAt": "2026-08-01T12:00:00Z" })
    }

    async fn npm_registry_fixture(version: &str) -> (Url, Arc<AtomicUsize>) {
        let requests = Arc::new(AtomicUsize::new(0));
        let state = (version.to_owned(), requests.clone());
        let app = Router::new()
            .route(
                "/{*path}",
                get(
                    |State((version, requests)): State<(String, Arc<AtomicUsize>)>| async move {
                        requests.fetch_add(1, Ordering::SeqCst);
                        Json(json!({ "version": version }))
                    },
                ),
            )
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("registry listener");
        let address = listener.local_addr().expect("registry address");
        tokio::spawn(async move { axum::serve(listener, app).await.expect("registry server") });
        (
            Url::parse(&format!("http://{address}/")).expect("registry URL"),
            requests,
        )
    }

    async fn delayed_npm_registry_fixture(version: &str) -> (Url, Arc<AtomicUsize>) {
        let concurrent_requests = Arc::new(AtomicUsize::new(0));
        let active_requests = Arc::new(AtomicUsize::new(0));
        let state = (
            version.to_owned(),
            concurrent_requests.clone(),
            active_requests,
        );
        let app = Router::new()
            .route(
                "/{*path}",
                get(
                    |State((version, concurrent_requests, active_requests)): State<(
                        String,
                        Arc<AtomicUsize>,
                        Arc<AtomicUsize>,
                    )>| async move {
                        let active = active_requests.fetch_add(1, Ordering::SeqCst) + 1;
                        concurrent_requests.fetch_max(active, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        active_requests.fetch_sub(1, Ordering::SeqCst);
                        Json(json!({ "version": version }))
                    },
                ),
            )
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("registry listener");
        let address = listener.local_addr().expect("registry address");
        tokio::spawn(async move { axum::serve(listener, app).await.expect("registry server") });
        (
            Url::parse(&format!("http://{address}/")).expect("registry URL"),
            concurrent_requests,
        )
    }

    #[tokio::test]
    async fn enriches_snapshot_and_caches_npm_latest_for_one_hour() {
        let (registry_url, requests) = npm_registry_fixture("9.9.9").await;
        let maintenance = ProviderMaintenance::with_registry_base_url(registry_url);
        let target = target("codex", "codex");
        let mut first = installed_snapshot("codex", "1.0.0");
        let mut second = installed_snapshot("codex", "1.0.0");
        maintenance.enrich_snapshot(&target, &mut first, true).await;
        maintenance
            .enrich_snapshot(&target, &mut second, true)
            .await;
        assert_eq!(first["versionAdvisory"]["status"], "behind_latest");
        assert_eq!(first["versionAdvisory"]["latestVersion"], "9.9.9");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn disabled_checks_do_not_contact_the_registry() {
        let (registry_url, requests) = npm_registry_fixture("9.9.9").await;
        let maintenance = ProviderMaintenance::with_registry_base_url(registry_url);
        let mut snapshot = installed_snapshot("codex", "1.0.0");
        maintenance
            .enrich_snapshot(&target("codex", "codex"), &mut snapshot, false)
            .await;
        assert_eq!(snapshot["versionAdvisory"]["status"], "unknown");
        assert_eq!(requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn registry_failure_keeps_provider_data_and_returns_unknown_advisory() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("registry listener");
        let address = listener.local_addr().expect("registry address");
        let app = Router::new().route(
            "/{*path}",
            get(|| async { StatusCode::SERVICE_UNAVAILABLE }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.expect("registry server") });
        let maintenance = ProviderMaintenance::with_registry_base_url(
            Url::parse(&format!("http://{address}/")).expect("registry URL"),
        );
        let mut snapshot = installed_snapshot("codex", "1.0.0");
        snapshot["models"] = json!([{ "slug": "existing" }]);
        maintenance
            .enrich_snapshot(&target("codex", "codex"), &mut snapshot, true)
            .await;
        assert_eq!(snapshot["versionAdvisory"]["status"], "unknown");
        assert_eq!(snapshot["models"][0]["slug"], "existing");
    }

    #[tokio::test]
    async fn expired_cache_entry_is_refetched() {
        let (registry_url, requests) = npm_registry_fixture("9.9.9").await;
        let maintenance = ProviderMaintenance::with_registry_base_url(registry_url);
        maintenance.inner.latest_versions.lock().await.insert(
            "@openai/codex",
            VersionCacheEntry {
                expires_at: tokio::time::Instant::now() - Duration::from_secs(1),
                version: Some("1.0.0".to_owned()),
            },
        );
        let mut snapshot = installed_snapshot("codex", "1.0.0");
        maintenance
            .enrich_snapshot(&target("codex", "codex"), &mut snapshot, true)
            .await;
        assert_eq!(snapshot["versionAdvisory"]["latestVersion"], "9.9.9");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn fetches_different_package_versions_concurrently() {
        let (registry_url, concurrent_requests) = delayed_npm_registry_fixture("9.9.9").await;
        let maintenance = ProviderMaintenance::with_registry_base_url(registry_url);
        let codex_target = target("codex", "codex");
        let claude_target = target("claudeAgent", "claude");
        let mut codex = installed_snapshot("codex", "1.0.0");
        let mut claude = installed_snapshot("claudeAgent", "1.0.0");

        tokio::join!(
            maintenance.enrich_snapshot(&codex_target, &mut codex, true),
            maintenance.enrich_snapshot(&claude_target, &mut claude, true),
        );

        assert!(concurrent_requests.load(Ordering::SeqCst) >= 2);
    }

    fn output_command(bytes: usize) -> ProviderUpdateCommand {
        if cfg!(windows) {
            ProviderUpdateCommand {
                display: "powershell test output".to_owned(),
                executable: "powershell.exe".to_owned(),
                args: vec![
                    "-NoProfile".to_owned(),
                    "-NonInteractive".to_owned(),
                    "-Command".to_owned(),
                    format!("[Console]::Out.Write('x' * {bytes})"),
                ],
                lock_key: "test-output",
            }
        } else {
            ProviderUpdateCommand {
                display: "sh test output".to_owned(),
                executable: "sh".to_owned(),
                args: vec![
                    "-c".to_owned(),
                    format!("head -c {bytes} /dev/zero | tr '\\0' x"),
                ],
                lock_key: "test-output",
            }
        }
    }

    fn exit_command(code: i32) -> ProviderUpdateCommand {
        if cfg!(windows) {
            ProviderUpdateCommand {
                display: format!("powershell exit {code}"),
                executable: "powershell.exe".to_owned(),
                args: vec![
                    "-NoProfile".to_owned(),
                    "-NonInteractive".to_owned(),
                    "-Command".to_owned(),
                    format!("exit {code}"),
                ],
                lock_key: "test-exit",
            }
        } else {
            ProviderUpdateCommand {
                display: format!("sh exit {code}"),
                executable: "sh".to_owned(),
                args: vec!["-c".to_owned(), format!("exit {code}")],
                lock_key: "test-exit",
            }
        }
    }

    fn sleep_command() -> ProviderUpdateCommand {
        if cfg!(windows) {
            ProviderUpdateCommand {
                display: "powershell sleep".to_owned(),
                executable: "powershell.exe".to_owned(),
                args: vec![
                    "-NoProfile".to_owned(),
                    "-NonInteractive".to_owned(),
                    "-Command".to_owned(),
                    "Start-Sleep -Seconds 2".to_owned(),
                ],
                lock_key: "test-sleep",
            }
        } else {
            ProviderUpdateCommand {
                display: "sleep 2".to_owned(),
                executable: "sleep".to_owned(),
                args: vec!["2".to_owned()],
                lock_key: "test-sleep",
            }
        }
    }

    #[tokio::test]
    async fn update_command_captures_bounded_output() {
        let command = output_command(12_000);
        let result = ProviderMaintenance::new()
            .run_update_command(
                &target("cursor", "cursor-agent"),
                &command,
                &CancellationToken::new(),
            )
            .await
            .expect("command result");
        assert_eq!(result.exit_code, 0);
        assert!(result
            .output
            .as_deref()
            .is_some_and(|value| value.chars().count() <= 10_000));
    }

    #[tokio::test]
    async fn update_command_preserves_non_zero_exit_code() {
        let result = ProviderMaintenance::new()
            .run_update_command(
                &target("cursor", "cursor-agent"),
                &exit_command(7),
                &CancellationToken::new(),
            )
            .await
            .expect("non-zero command result");
        assert_eq!(result.exit_code, 7);
    }

    #[tokio::test]
    async fn update_command_timeout_stops_the_child() {
        let error = ProviderMaintenance::new()
            .run_update_command_with_timeout(
                &target("cursor", "cursor-agent"),
                &sleep_command(),
                &CancellationToken::new(),
                Duration::from_millis(25),
            )
            .await
            .expect_err("sleep command must time out");
        assert!(error.contains("timed out"));
    }

    #[tokio::test]
    async fn rejects_a_second_update_for_the_same_instance() {
        let maintenance = ProviderMaintenance::new();
        let first = maintenance
            .reserve_target("codex-work")
            .expect("first reservation");
        assert_eq!(
            maintenance.reserve_target("codex-work").unwrap_err(),
            "An update is already running for this provider."
        );
        drop(first);
        assert!(maintenance.reserve_target("codex-work").is_ok());
    }

    #[tokio::test]
    async fn shared_package_manager_updates_queue() {
        let maintenance = ProviderMaintenance::new();
        let lock = maintenance.command_lock("npm-global");
        let first = lock.clone().lock_owned().await;
        assert!(lock.clone().try_lock_owned().is_err());
        drop(first);
        assert!(lock.try_lock_owned().is_ok());
    }
}
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use serde_json::{Value, json};
use url::Url;

use crate::git::{OutputPolicy, ProcessRequest, ProcessRunner};

use super::provider_runtime::{prepare_provider_launch, resolve_provider_executable_in_path};

const CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(4);
const UPDATE_MESSAGE: &str = "Install the update now or review provider settings.";
const UPDATE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const UPDATE_OUTPUT_LIMIT: usize = 10_000;

#[derive(Clone, Debug)]
pub(crate) struct ProviderMaintenanceTarget {
    #[allow(dead_code)] // Used by Task 2 for per-provider update state.
    pub(crate) instance_id: String,
    pub(crate) driver: String,
    pub(crate) binary_path: String,
    pub(crate) environment: Vec<(OsString, OsString)>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderUpdateCommand {
    pub(crate) display: String,
    pub(crate) executable: String,
    pub(crate) args: Vec<String>,
    pub(crate) lock_key: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderMaintenanceCapabilities {
    pub(crate) package_name: Option<&'static str>,
    pub(crate) update: Option<ProviderUpdateCommand>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderMaintenance {
    inner: Arc<ProviderMaintenanceInner>,
}

#[derive(Debug)]
pub(crate) struct ProviderUpdateReservation {
    instance_id: String,
    running_targets: Arc<Mutex<HashSet<String>>>,
}

impl Drop for ProviderUpdateReservation {
    fn drop(&mut self) {
        self.running_targets
            .lock()
            .expect("provider update reservations lock")
            .remove(&self.instance_id);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderUpdateCommandResult {
    pub(crate) exit_code: i32,
    pub(crate) output: Option<String>,
}

#[derive(Debug)]
struct ProviderMaintenanceInner {
    client: reqwest::Client,
    registry_base_url: Url,
    latest_versions: tokio::sync::Mutex<HashMap<&'static str, VersionCacheEntry>>,
    running_targets: Arc<Mutex<HashSet<String>>>,
    command_locks: Mutex<HashMap<&'static str, Arc<tokio::sync::Mutex<()>>>>,
    update_states: RwLock<HashMap<String, RetainedProviderUpdateState>>,
}

#[derive(Debug)]
struct RetainedProviderUpdateState {
    driver: String,
    state: Value,
}

#[derive(Clone, Copy)]
struct NativeUpdate {
    args: &'static [&'static str],
    lock_key: &'static str,
    path_matches: fn(&str) -> bool,
}

#[derive(Clone, Copy)]
struct PackageDefinition {
    package_name: &'static str,
    homebrew_formula: Option<&'static str>,
    native_update: Option<NativeUpdate>,
}

#[derive(Clone, Debug)]
struct VersionCacheEntry {
    expires_at: tokio::time::Instant,
    version: Option<String>,
}

impl ProviderMaintenance {
    pub(crate) fn new() -> Self {
        Self::with_registry_base_url(
            Url::parse("https://registry.npmjs.org/").expect("registry URL"),
        )
    }

    #[cfg(test)]
    fn with_registry_base_url(registry_base_url: Url) -> Self {
        Self::with_registry_base_url_inner(registry_base_url)
    }

    #[cfg(not(test))]
    fn with_registry_base_url(registry_base_url: Url) -> Self {
        Self::with_registry_base_url_inner(registry_base_url)
    }

    fn with_registry_base_url_inner(registry_base_url: Url) -> Self {
        Self {
            inner: Arc::new(ProviderMaintenanceInner {
                client: reqwest::Client::new(),
                registry_base_url,
                latest_versions: tokio::sync::Mutex::new(HashMap::new()),
                running_targets: Arc::new(Mutex::new(HashSet::new())),
                command_locks: Mutex::new(HashMap::new()),
                update_states: RwLock::new(HashMap::new()),
            }),
        }
    }

    pub(crate) fn reserve_target(
        &self,
        instance_id: &str,
    ) -> Result<ProviderUpdateReservation, &'static str> {
        let mut running = self
            .inner
            .running_targets
            .lock()
            .expect("provider update reservations lock");
        if !running.insert(instance_id.to_owned()) {
            return Err("An update is already running for this provider.");
        }
        Ok(ProviderUpdateReservation {
            instance_id: instance_id.to_owned(),
            running_targets: self.inner.running_targets.clone(),
        })
    }

    pub(crate) fn command_lock(&self, lock_key: &'static str) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .command_locks
            .lock()
            .expect("provider update command locks")
            .entry(lock_key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    pub(crate) fn set_update_state(&self, instance_id: &str, driver: &str, state: Value) {
        self.inner
            .update_states
            .write()
            .expect("provider update states lock")
            .insert(
                instance_id.to_owned(),
                RetainedProviderUpdateState {
                    driver: driver.to_owned(),
                    state,
                },
            );
    }

    pub(crate) fn remove_update_state(&self, instance_id: &str) {
        self.inner
            .update_states
            .write()
            .expect("provider update states lock")
            .remove(instance_id);
    }

    pub(crate) fn overlay_update_state(&self, snapshot: &mut Value) {
        let Some((instance_id, driver)) = snapshot
            .get("instanceId")
            .and_then(Value::as_str)
            .zip(snapshot.get("driver").and_then(Value::as_str))
        else {
            return;
        };
        let state = self
            .inner
            .update_states
            .read()
            .expect("provider update states lock")
            .get(instance_id)
            .filter(|retained| retained.driver == driver)
            .map(|retained| retained.state.clone());
        if let Some(state) = state {
            snapshot["updateState"] = state;
        } else if let Some(snapshot) = snapshot.as_object_mut() {
            snapshot.remove("updateState");
        }
    }

    pub(crate) fn prune_update_states<'a, I>(
        &self,
        identities: I,
    ) where
        I: IntoIterator<Item = (&'a str, &'a str)>,
    {
        let identities = identities.into_iter().collect::<HashSet<_>>();
        self.inner
            .update_states
            .write()
            .expect("provider update states lock")
            .retain(|instance_id, retained| {
                identities.contains(&(instance_id.as_str(), retained.driver.as_str()))
            });
    }

    pub(crate) async fn capabilities(
        &self,
        target: &ProviderMaintenanceTarget,
    ) -> ProviderMaintenanceCapabilities {
        let search_path = target
            .environment
            .iter()
            .find(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case("path"))
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var_os("PATH"));
        let resolved =
            resolve_provider_executable_in_path(&target.binary_path, search_path.as_deref());
        let canonical = match resolved.as_deref() {
            Some(path) => tokio::fs::canonicalize(path).await.ok(),
            None => None,
        };
        capabilities_for_paths(
            &target.driver,
            &target.binary_path,
            resolved.as_deref(),
            canonical.as_deref(),
        )
    }

    pub(crate) async fn run_update_command(
        &self,
        target: &ProviderMaintenanceTarget,
        update: &ProviderUpdateCommand,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<ProviderUpdateCommandResult, String> {
        self.run_update_command_with_timeout(target, update, cancellation, UPDATE_TIMEOUT)
            .await
    }

    async fn run_update_command_with_timeout(
        &self,
        target: &ProviderMaintenanceTarget,
        update: &ProviderUpdateCommand,
        cancellation: &tokio_util::sync::CancellationToken,
        timeout: Duration,
    ) -> Result<ProviderUpdateCommandResult, String> {
        let search_path = target
            .environment
            .iter()
            .find(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case("path"))
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var_os("PATH"));
        let executable = resolve_provider_executable_in_path(&update.executable, search_path.as_deref())
            .ok_or_else(|| format!("Could not resolve update command '{}'.", update.executable))?;
        let launch = prepare_provider_launch(&executable, &update.args)?;
        let cwd = std::env::current_dir()
            .map_err(|error| format!("Could not determine update working directory: {error}"))?;
        let process_output = ProcessRunner
            .run(
                ProcessRequest {
                    operation: "provider.maintenance.update".to_owned(),
                    command: launch.program,
                    args: launch.args,
                    cwd: PathBuf::from(cwd),
                    env: target.environment.clone(),
                    stdin: None,
                    timeout,
                    max_output_bytes: UPDATE_OUTPUT_LIMIT,
                    output_policy: OutputPolicy::Truncate,
                    append_truncation_marker: true,
                    allow_non_zero_exit: true,
                },
                cancellation,
            )
            .await
            .map_err(|error| error.to_string())?;
        let output = [process_output.stderr, process_output.stdout]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ProviderUpdateCommandResult {
            exit_code: process_output.exit_code,
            output: (!output.is_empty()).then(|| output.chars().take(UPDATE_OUTPUT_LIMIT).collect()),
        })
    }

    pub(crate) async fn enrich_snapshot(
        &self,
        target: &ProviderMaintenanceTarget,
        snapshot: &mut Value,
        checks_enabled: bool,
    ) {
        let capabilities = self.capabilities(target).await;
        let current = snapshot
            .get("version")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        let should_check = checks_enabled
            && snapshot.get("enabled").and_then(Value::as_bool) == Some(true)
            && snapshot.get("installed").and_then(Value::as_bool) == Some(true)
            && current.is_some();
        let latest = match (should_check, capabilities.package_name) {
            (true, Some(package_name)) => self.latest_version(package_name).await,
            _ => None,
        };
        let status = if should_check {
            advisory_status(current, latest.as_deref())
        } else {
            "unknown"
        };
        snapshot["versionAdvisory"] = json!({
            "status": status,
            "currentVersion": current,
            "latestVersion": latest,
            "updateCommand": capabilities.update.as_ref().map(|update| &update.display),
            "canUpdate": capabilities.update.is_some(),
            "checkedAt": snapshot.get("checkedAt").cloned().unwrap_or(Value::Null),
            "message": if status == "behind_latest" { Some(UPDATE_MESSAGE) } else { None::<&str> },
        });
    }

    async fn latest_version(&self, package_name: &'static str) -> Option<String> {
        let cache = self.inner.latest_versions.lock().await;
        if let Some(entry) = cache.get(package_name)
            && entry.expires_at > tokio::time::Instant::now()
        {
            return entry.version.clone();
        }
        drop(cache);
        let encoded: String =
            url::form_urlencoded::byte_serialize(package_name.as_bytes()).collect();
        let version = match self.inner.registry_base_url.join(&encoded) {
            Ok(url) => match self
                .inner
                .client
                .get(url)
                .timeout(REGISTRY_TIMEOUT)
                .send()
                .await
                .ok()
                .and_then(|response| response.error_for_status().ok())
            {
                Some(response) => response.json::<Value>().await.ok().and_then(|body| {
                    body.get("version")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_owned)
                }),
                None => None,
            },
            Err(_) => None,
        };
        self.inner.latest_versions.lock().await.insert(
            package_name,
            VersionCacheEntry {
                expires_at: tokio::time::Instant::now() + CACHE_TTL,
                version: version.clone(),
            },
        );
        version
    }
}

fn manual_capabilities(package_name: Option<&'static str>) -> ProviderMaintenanceCapabilities {
    ProviderMaintenanceCapabilities {
        package_name,
        update: None,
    }
}

fn capabilities_with_update<I, S>(
    package_name: Option<&'static str>,
    executable: impl Into<String>,
    args: I,
    lock_key: &'static str,
) -> ProviderMaintenanceCapabilities
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let executable = executable.into();
    let args = args.into_iter().map(Into::into).collect::<Vec<String>>();
    let display = std::iter::once(executable.as_str())
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    ProviderMaintenanceCapabilities {
        package_name,
        update: Some(ProviderUpdateCommand {
            display,
            executable,
            args,
            lock_key,
        }),
    }
}

fn capabilities_for_paths(
    driver: &str,
    binary_path: &str,
    resolved: Option<&Path>,
    canonical: Option<&Path>,
) -> ProviderMaintenanceCapabilities {
    let target = ProviderMaintenanceTarget {
        instance_id: driver.to_owned(),
        driver: driver.to_owned(),
        binary_path: binary_path.to_owned(),
        environment: Vec::new(),
    };
    match driver {
        "cursor" => capabilities_with_update(
            None,
            resolved_or_configured_binary(&target, resolved),
            ["update"],
            "cursor-agent",
        ),
        "grok" => manual_capabilities(None),
        _ => resolve_package_managed_capabilities(&target, resolved, canonical),
    }
}

fn advisory_status(current: Option<&str>, latest: Option<&str>) -> &'static str {
    match (
        current.and_then(parse_version),
        latest.and_then(parse_version),
    ) {
        (Some(current), Some(latest)) if current < latest => "behind_latest",
        (Some(_), Some(_)) => "current",
        _ => "unknown",
    }
}

fn parse_version(value: &str) -> Option<semver::Version> {
    value
        .split_whitespace()
        .map(|part| {
            part.trim_matches(|character: char| {
                !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'))
            })
        })
        .find_map(|candidate| semver::Version::parse(candidate.trim_start_matches('v')).ok())
}

fn resolved_or_configured_binary(
    target: &ProviderMaintenanceTarget,
    resolved: Option<&Path>,
) -> String {
    resolved
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| target.binary_path.clone())
}

fn is_claude_native_path(normalized_path: &str) -> bool {
    normalized_path.ends_with("/.local/bin/claude")
        || normalized_path.ends_with("/.local/bin/claude.exe")
}

fn is_opencode_native_path(normalized_path: &str) -> bool {
    normalized_path.ends_with("/.opencode/bin/opencode")
        || normalized_path.ends_with("/.opencode/bin/opencode.exe")
}

fn resolve_package_managed_capabilities(
    target: &ProviderMaintenanceTarget,
    resolved: Option<&Path>,
    canonical: Option<&Path>,
) -> ProviderMaintenanceCapabilities {
    let Some(definition) = package_definition(&target.driver) else {
        return manual_capabilities(None);
    };
    let paths = [resolved, canonical]
        .into_iter()
        .flatten()
        .map(|path| {
            path.to_string_lossy()
                .replace('\\', "/")
                .to_ascii_lowercase()
        })
        .collect::<Vec<_>>();
    if let Some(native) = definition.native_update
        && paths.iter().any(|path| (native.path_matches)(path))
    {
        return capabilities_with_update(
            Some(definition.package_name),
            resolved_or_configured_binary(target, resolved),
            native.args.iter().copied(),
            native.lock_key,
        );
    }
    if paths.iter().any(|path| path.contains("/.vite-plus/bin/")) {
        return capabilities_with_update(
            Some(definition.package_name),
            "vp",
            ["i", "-g", definition.package_name],
            "vite-plus",
        );
    }
    if paths.iter().any(|path| path.contains("/.bun/bin/")) {
        return capabilities_with_update(
            Some(definition.package_name),
            "bun",
            ["i", "-g", &format!("{}@latest", definition.package_name)],
            "bun",
        );
    }
    if paths.iter().any(|path| {
        path.contains("/.local/share/pnpm/")
            || path.contains("/local/share/pnpm/")
            || path.contains("/library/pnpm/")
            || path.contains("/appdata/local/pnpm/")
            || path.contains("/appdata/roaming/pnpm/")
    }) {
        return capabilities_with_update(
            Some(definition.package_name),
            "pnpm",
            ["add", "-g", &format!("{}@latest", definition.package_name)],
            "pnpm",
        );
    }
    if paths.iter().any(|path| {
        path.contains("/appdata/roaming/npm/")
            || path.contains("/.npm-global/")
            || path.contains("/lib/node_modules/")
            || path.contains("/node_modules/.bin/")
            || path.contains("/npm/node_modules/")
    }) {
        return capabilities_with_update(
            Some(definition.package_name),
            "npm",
            [
                "install",
                "-g",
                &format!("{}@latest", definition.package_name),
            ],
            "npm",
        );
    }
    if let Some(formula) = definition.homebrew_formula
        && paths.iter().any(|path| {
            path.contains("/opt/homebrew/bin/")
                || path.contains("/usr/local/bin/")
                || path.contains("/home/linuxbrew/.linuxbrew/bin/")
        })
    {
        return capabilities_with_update(
            Some(definition.package_name),
            "brew",
            ["upgrade", formula],
            "homebrew",
        );
    }
    if target.binary_path.contains(['/', '\\']) {
        return manual_capabilities(Some(definition.package_name));
    }
    capabilities_with_update(
        Some(definition.package_name),
        "npm",
        [
            "install",
            "-g",
            &format!("{}@latest", definition.package_name),
        ],
        "npm",
    )
}

fn package_definition(driver: &str) -> Option<PackageDefinition> {
    match driver {
        "codex" => Some(PackageDefinition {
            package_name: "@openai/codex",
            homebrew_formula: Some("codex"),
            native_update: None,
        }),
        "claudeAgent" => Some(PackageDefinition {
            package_name: "@anthropic-ai/claude-code",
            homebrew_formula: Some("claude-code"),
            native_update: Some(NativeUpdate {
                args: &["update"],
                lock_key: "claude-native",
                path_matches: is_claude_native_path,
            }),
        }),
        "opencode" => Some(PackageDefinition {
            package_name: "opencode-ai",
            homebrew_formula: Some("anomalyco/tap/opencode"),
            native_update: Some(NativeUpdate {
                args: &["upgrade"],
                lock_key: "opencode-native",
                path_matches: is_opencode_native_path,
            }),
        }),
        _ => None,
    }
}
