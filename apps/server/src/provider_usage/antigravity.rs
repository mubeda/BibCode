//! Antigravity account usage, read from `agy -p "/usage" --output-format json`.
//!
//! The command answers without a model turn since CLI 1.1.11; an older CLI would send the text as
//! a prompt and spend quota, so nothing is run until `--version` proves a new enough CLI. The
//! CLI's free text (group names, descriptions, the response) is never read: a plan name can sit
//! there. Design: `docs/plans/2026-11-21-antigravity-usage-design.md`.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, SystemTime},
};

use serde_json::Value;
use time::OffsetDateTime;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::{
    FetchFuture, ProviderUsageFetchError, ProviderUsageFetcher, ProviderUsageProvider,
    ProviderUsageSnapshot, ProviderUsageStatus, ProviderUsageWindow, ProviderUsageWindowGroup,
    unavailable_snapshot,
};
use crate::{
    diagnostics::{
        AttributionKind, AttributionScope, NativeProcessSampler, ProcessAttributionRegistry,
        ProcessRegistration, ProcessRegistrationMetadata, RegistrationSource,
    },
    process::{
        configure_background_command,
        supervised::{
            StopPolicy, SupervisedOverflow, SupervisedRunError, SupervisedRunOutput,
            SupervisedRunRequest, run_supervised_with_spawn_observer,
        },
    },
    production::{
        provider_inventory::maintenance_target,
        provider_runtime::{prepare_provider_launch, resolve_provider_executable_with_environment},
    },
    provider::environment::sanitize_provider_subprocess_environment,
    server_settings::ProviderSettingsStore,
};

/// Automatic refreshes run the CLI at most this often; a forced refresh bypasses it.
pub(super) const MIN_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// The service's timeout for this provider: above `DEADLINE` plus both cleanup windows.
pub(super) const SERVICE_TIMEOUT: Duration = Duration::from_secs(25);
/// One deadline for the version probe and the usage read together.
const DEADLINE: Duration = Duration::from_secs(20);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const OUTPUT_LIMIT: usize = 64 * 1024;
const MINIMUM_VERSION: (u64, u64, u64) = (1, 1, 11);
/// The documented exit code of `-p "/usage"` for a Gemini API key sign-in (no account quota).
const API_KEY_EXIT_CODE: i32 = 2;

pub(super) const MESSAGE_DISABLED: &str =
    "Antigravity is turned off. Turn it on in Settings, Providers.";
pub(super) const MESSAGE_NOT_STARTED: &str = "The Antigravity CLI could not be started.";
pub(super) const MESSAGE_VERSION: &str =
    "Antigravity usage needs CLI 1.1.11 or newer, and its version could not be confirmed.";
pub(super) const MESSAGE_API_KEY: &str =
    "This Antigravity sign-in uses an API key, which has no account quota.";
pub(super) const MESSAGE_TRANSIENT: &str =
    "Antigravity usage could not be read. It will be tried again.";
pub(super) const MESSAGE_FORMAT: &str =
    "Antigravity reported usage in a format this version of BiBCode does not read.";

/// What identifies the executable whose version was verified.
type VerifiedExecutable = (PathBuf, SystemTime, u64);

pub(super) fn fetcher(
    settings: ProviderSettingsStore,
    attribution: Option<ProcessAttributionRegistry>,
) -> ProviderUsageFetcher {
    let verified: Arc<StdMutex<Option<VerifiedExecutable>>> = Arc::default();
    ProviderUsageFetcher {
        provider: ProviderUsageProvider::Antigravity,
        fetch: Arc::new(move || -> FetchFuture {
            let settings = settings.clone();
            let attribution = attribution.clone();
            let verified = verified.clone();
            Box::pin(async move {
                let document = settings.get_document().await.map_err(|_| {
                    ProviderUsageFetchError::new("Antigravity settings could not be read.")
                })?;
                fetch_for_document(&document, attribution.as_ref(), &verified).await
            })
        }),
    }
}

/// Whether the default Antigravity instance is on, read as the inventory reads it: the explicit
/// `providerInstances.antigravity` first, the legacy `providers.antigravity` entry as fallback.
pub(super) fn default_instance_enabled(document: &Value) -> bool {
    let legacy = document
        .pointer("/providers/antigravity/enabled")
        .and_then(Value::as_bool);
    match document.pointer("/providerInstances/antigravity") {
        Some(instance) => instance
            .get("enabled")
            .and_then(Value::as_bool)
            .or(legacy)
            .unwrap_or(true),
        None => legacy.unwrap_or(false),
    }
}

pub(super) async fn fetch_for_document(
    document: &Value,
    attribution: Option<&ProcessAttributionRegistry>,
    verified: &StdMutex<Option<VerifiedExecutable>>,
) -> Result<ProviderUsageSnapshot, ProviderUsageFetchError> {
    let now = OffsetDateTime::now_utc();
    let unavailable = |message: &str| -> Result<ProviderUsageSnapshot, ProviderUsageFetchError> {
        Ok(unavailable_snapshot(
            ProviderUsageProvider::Antigravity,
            now,
            message,
        ))
    };
    if !default_instance_enabled(document) {
        return unavailable(MESSAGE_DISABLED);
    }
    let Some(target) = maintenance_target(document, "antigravity", Some("antigravity")) else {
        return unavailable(MESSAGE_NOT_STARTED);
    };
    let Some(executable) = resolve_provider_executable_with_environment(
        &target.binary_path,
        target
            .environment
            .iter()
            .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
    ) else {
        return unavailable(MESSAGE_NOT_STARTED);
    };
    let Some(identity) = executable_identity(&executable) else {
        return unavailable(MESSAGE_NOT_STARTED);
    };
    let started = tokio::time::Instant::now();
    let workdir =
        ScratchDirectory::create().map_err(|_| ProviderUsageFetchError::new(MESSAGE_TRANSIENT))?;
    let cancellation = CancellationToken::new();
    let run = |arguments: &'static [&'static str], timeout: Duration| {
        run_cli(
            &executable,
            arguments,
            &target.environment,
            workdir.path(),
            timeout,
            &cancellation,
            attribution,
        )
    };

    let already_verified = verified
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        == Some(&identity);
    if !already_verified {
        let output = match run(&["--version"], PROBE_TIMEOUT).await {
            Ok(output) => output,
            Err(SupervisedRunError::Spawn(_)) => return unavailable(MESSAGE_NOT_STARTED),
            Err(_) => return unavailable(MESSAGE_VERSION),
        };
        if !output.status.success()
            || is_truncated(&output.stdout)
            || !version_is_supported(&output.stdout.bytes)
        {
            return unavailable(MESSAGE_VERSION);
        }
        *verified.lock().unwrap_or_else(|error| error.into_inner()) = Some(identity);
    }

    let remaining = DEADLINE.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return Err(ProviderUsageFetchError::new(MESSAGE_TRANSIENT));
    }
    let output = match run(&["-p", "/usage", "--output-format", "json"], remaining).await {
        Ok(output) => output,
        Err(SupervisedRunError::Spawn(_)) => return unavailable(MESSAGE_NOT_STARTED),
        Err(error) => {
            tracing::warn!(failure = %run_error_class(&error), "Antigravity usage run failed");
            return Err(ProviderUsageFetchError::new(MESSAGE_TRANSIENT));
        }
    };
    if output.status.code() == Some(API_KEY_EXIT_CODE) {
        return unavailable(MESSAGE_API_KEY);
    }
    if !output.status.success() {
        tracing::warn!(code = ?output.status.code(), "Antigravity usage exited unsuccessfully");
        return Err(ProviderUsageFetchError::new(MESSAGE_TRANSIENT));
    }
    if is_truncated(&output.stdout) {
        return unavailable(MESSAGE_FORMAT);
    }
    match parse_usage(&output.stdout.bytes, now) {
        Some(snapshot) => Ok(snapshot),
        None => unavailable(MESSAGE_FORMAT),
    }
}

fn run_error_class(error: &SupervisedRunError) -> &'static str {
    match error {
        SupervisedRunError::Spawn(_) => "spawn",
        _ => "run",
    }
}

fn is_truncated(stream: &crate::process::supervised::SupervisedStreamOutput) -> bool {
    stream.observed_bytes > stream.bytes.len()
}

fn executable_identity(executable: &Path) -> Option<VerifiedExecutable> {
    let path = std::fs::canonicalize(executable).ok()?;
    let metadata = std::fs::metadata(&path).ok()?;
    Some((path, metadata.modified().ok()?, metadata.len()))
}

/// The probe passes only for one `major.minor.patch` token at or above 1.1.11.
fn version_is_supported(stdout: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(stdout) else {
        return false;
    };
    let token = text.trim();
    if token.is_empty() || token.split_whitespace().count() != 1 {
        return false;
    }
    let Ok(version) = semver::Version::parse(token) else {
        return false;
    };
    (version.major, version.minor, version.patch) >= MINIMUM_VERSION && version.pre.is_empty()
}

async fn run_cli(
    executable: &Path,
    arguments: &[&str],
    environment: &[(std::ffi::OsString, std::ffi::OsString)],
    workdir: &Path,
    timeout: Duration,
    cancellation: &CancellationToken,
    attribution: Option<&ProcessAttributionRegistry>,
) -> Result<SupervisedRunOutput, SupervisedRunError> {
    let launch = prepare_provider_launch(executable, arguments)
        .map_err(|error| SupervisedRunError::Spawn(std::io::Error::other(error)))?;
    let mut command = Command::new(&launch.program);
    configure_background_command(&mut command);
    command
        .args(&launch.args)
        .current_dir(workdir)
        .envs(environment.iter().map(|(name, value)| (name, value)))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sanitize_provider_subprocess_environment(&mut command);
    let registration: Arc<StdMutex<Option<ProcessRegistration>>> = Arc::default();
    let observed = registration.clone();
    let attribution = attribution.cloned();
    let output = run_supervised_with_spawn_observer(
        SupervisedRunRequest {
            command,
            stdin: None,
            timeout,
            cleanup_timeout: CLEANUP_TIMEOUT,
            max_output_bytes: OUTPUT_LIMIT,
            stop_policy: StopPolicy::Force,
            overflow: SupervisedOverflow::Truncate,
        },
        cancellation,
        move |pid| {
            let (Some(pid), Some(attribution)) = (pid, attribution) else {
                return;
            };
            let Ok(identity) = NativeProcessSampler::process_identity(pid) else {
                return;
            };
            match attribution.register_identity(
                identity,
                ProcessRegistrationMetadata {
                    scope: AttributionScope::External,
                    kind: AttributionKind::Helper,
                    label: "antigravity usage".to_owned(),
                    source: RegistrationSource::Helper,
                    driver: None,
                    survives_shutdown: false,
                },
            ) {
                Ok(held) => {
                    *observed.lock().unwrap_or_else(|error| error.into_inner()) = Some(held);
                }
                Err(error) => {
                    tracing::warn!(%error, "could not attribute the Antigravity usage process");
                }
            }
        },
    )
    .await;
    drop(registration);
    output
}

/// A scratch working directory, removed when dropped. Not the data root: that can sit inside a
/// checkout, and the CLI reads project files from its working directory.
struct ScratchDirectory(PathBuf);

impl ScratchDirectory {
    fn create() -> std::io::Result<Self> {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let path =
            std::env::temp_dir().join(format!("bibcode-agy-usage-{}-{nanos}", std::process::id()));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Reads only `command.name`, `command.data.groups[].buckets[]` and, per bucket, `id`, `window`,
/// `remaining_fraction` and `reset_time`, plus `num_turns` and `status`. Anything else, including
/// every free-text field, is ignored. `None` means "not the shape BiBCode reads".
pub(super) fn parse_usage(stdout: &[u8], now: OffsetDateTime) -> Option<ProviderUsageSnapshot> {
    let value: Value = serde_json::from_slice(stdout).ok()?;
    // The guard: a CLI that answered the text as a prompt has no command and spent a turn.
    if value.pointer("/command/name")?.as_str()? != "usage"
        || value.get("num_turns")?.as_u64()? != 0
        || value.get("status")?.as_str()? != "SUCCESS"
    {
        return None;
    }
    let groups = value.pointer("/command/data/groups")?.as_array()?;
    let mut by_class: BTreeMap<usize, ProviderUsageWindowGroup> = BTreeMap::new();
    for group in groups {
        for bucket in group.get("buckets")?.as_array()? {
            let Some((rank, id, label)) = bucket
                .get("id")
                .and_then(Value::as_str)
                .map(classify_bucket)
            else {
                continue;
            };
            let Some((is_session, minutes)) = bucket
                .get("window")
                .and_then(Value::as_str)
                .and_then(|window| match window {
                    "5h" => Some((true, 300)),
                    "weekly" => Some((false, 10_080)),
                    _ => None,
                })
            else {
                continue;
            };
            let Some(remaining) = bucket
                .get("remaining_fraction")
                .and_then(Value::as_f64)
                .filter(|fraction| fraction.is_finite())
            else {
                continue;
            };
            let window = ProviderUsageWindow {
                used_percent: ((1.0 - remaining) * 100.0).round().clamp(0.0, 100.0) as u32,
                window_minutes: minutes,
                resets_at: bucket
                    .get("reset_time")
                    .and_then(Value::as_str)
                    .and_then(|text| {
                        OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
                            .ok()
                    }),
                reset_description: None,
            };
            let entry = by_class.entry(rank).or_insert(ProviderUsageWindowGroup {
                id,
                label,
                session: None,
                weekly: None,
            });
            let slot = if is_session {
                &mut entry.session
            } else {
                &mut entry.weekly
            };
            slot.get_or_insert(window);
        }
    }
    let window_groups: Vec<_> = by_class.into_values().collect();
    if window_groups.is_empty() {
        return None;
    }
    Some(ProviderUsageSnapshot {
        provider: ProviderUsageProvider::Antigravity,
        status: ProviderUsageStatus::Ok,
        session: None,
        weekly: None,
        fable_weekly: None,
        window_groups,
        plan_type: None,
        rate_limit_reset_credits: None,
        updated_at: now,
        error: None,
        metadata: BTreeMap::new(),
    })
}

/// The group a bucket belongs to, from its id prefix only (the CLI's group name is free text).
fn classify_bucket(id: &str) -> (usize, &'static str, &'static str) {
    if id.starts_with("gemini-") {
        (0, "gemini", "Gemini models")
    } else if id.starts_with("3p-") {
        (1, "third-party", "Claude and GPT models")
    } else {
        (2, "other", "Other models")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A private marker in every free-text field: none may reach the snapshot.
    const MARKER: &str = "PRIVATE-PLAN-MARKER";

    fn payload() -> Value {
        json!({
            "status": "SUCCESS",
            "num_turns": 0,
            "response": MARKER,
            "conversation_id": MARKER,
            "command": {
                "name": "usage",
                "data": {
                    "description": MARKER,
                    "groups": [
                        {
                            "name": MARKER,
                            "description": MARKER,
                            "buckets": [
                                {"id": "gemini-weekly", "name": MARKER, "description": MARKER, "window": "weekly", "remaining_fraction": 0.986, "reset_time": "2026-11-28T21:28:19Z"},
                                {"id": "gemini-5h", "name": MARKER, "window": "5h", "remaining_fraction": 0.5, "reset_time": "2026-11-22T02:28:19Z"}
                            ]
                        },
                        {
                            "name": MARKER,
                            "buckets": [
                                {"id": "3p-weekly", "window": "weekly", "remaining_fraction": 1, "reset_time": "2026-11-28T21:50:39Z"},
                                {"id": "3p-5h", "window": "5h", "remaining_fraction": 0, "reset_time": "2026-11-22T02:50:39Z"}
                            ]
                        }
                    ]
                }
            }
        })
    }

    fn parse(value: &Value) -> Option<ProviderUsageSnapshot> {
        parse_usage(value.to_string().as_bytes(), OffsetDateTime::UNIX_EPOCH)
    }

    #[test]
    fn the_measured_shape_maps_to_two_groups_with_used_percent_and_minutes() {
        let snapshot = parse(&payload()).expect("measured shape");
        assert_eq!(snapshot.status, ProviderUsageStatus::Ok);
        assert!(snapshot.session.is_none() && snapshot.weekly.is_none());
        let [gemini, third] = snapshot.window_groups.as_slice() else {
            panic!("two groups");
        };
        assert_eq!((gemini.id, gemini.label), ("gemini", "Gemini models"));
        assert_eq!(third.label, "Claude and GPT models");
        let weekly = gemini.weekly.as_ref().expect("weekly");
        assert_eq!((weekly.used_percent, weekly.window_minutes), (1, 10_080));
        assert!(weekly.resets_at.is_some());
        let session = gemini.session.as_ref().expect("session");
        assert_eq!((session.used_percent, session.window_minutes), (50, 300));
        assert_eq!(third.session.as_ref().expect("3p 5h").used_percent, 100);
        assert_eq!(third.weekly.as_ref().expect("3p weekly").used_percent, 0);
    }

    #[test]
    fn no_free_text_field_reaches_the_snapshot() {
        let snapshot = parse(&payload()).expect("measured shape");
        assert!(!format!("{snapshot:?}").contains(MARKER));
    }

    #[test]
    fn the_guard_rejects_another_command_a_turn_or_a_failed_status() {
        for (pointer, replacement) in [
            ("/command/name", json!("credits")),
            ("/num_turns", json!(1)),
            ("/status", json!("ERROR")),
        ] {
            let mut value = payload();
            *value.pointer_mut(pointer).expect("field") = replacement;
            assert!(parse(&value).is_none(), "{pointer}");
        }
        let mut missing_turns = payload();
        missing_turns.as_object_mut().unwrap().remove("num_turns");
        assert!(parse(&missing_turns).is_none());
        let mut no_command = payload();
        no_command.as_object_mut().unwrap().remove("command");
        assert!(parse(&no_command).is_none());
    }

    #[test]
    fn fraction_and_time_boundaries_are_handled() {
        let cases = [
            (json!(0), 100),
            (json!(1), 0),
            (json!(0.004), 100),
            (json!(0.996), 0),
            (json!(0.5), 50),
            (json!(-0.3), 100),
            (json!(1.7), 0),
        ];
        for (fraction, used) in cases {
            let mut value = payload();
            *value
                .pointer_mut("/command/data/groups/0/buckets/1/remaining_fraction")
                .unwrap() = fraction.clone();
            let snapshot = parse(&value).expect("shape");
            assert_eq!(
                snapshot.window_groups[0]
                    .session
                    .as_ref()
                    .unwrap()
                    .used_percent,
                used,
                "{fraction}"
            );
        }
        let mut value = payload();
        *value
            .pointer_mut("/command/data/groups/0/buckets/1/remaining_fraction")
            .unwrap() = json!("0.5");
        let snapshot = parse(&value).expect("the other buckets still parse");
        assert!(
            snapshot.window_groups[0].session.is_none(),
            "non-numeric fraction is dropped"
        );
        for reset in [
            json!(1_790_000_000),
            json!("1790000000"),
            json!("2026-11-22"),
            json!("soon"),
        ] {
            let mut value = payload();
            *value
                .pointer_mut("/command/data/groups/0/buckets/1/reset_time")
                .unwrap() = reset.clone();
            let snapshot = parse(&value).expect("shape");
            assert!(
                snapshot.window_groups[0]
                    .session
                    .as_ref()
                    .unwrap()
                    .resets_at
                    .is_none(),
                "{reset} is not RFC 3339"
            );
        }
    }

    #[test]
    fn an_unknown_window_or_prefix_is_dropped_or_grouped_as_other() {
        let mut value = payload();
        *value
            .pointer_mut("/command/data/groups/0/buckets/1/window")
            .unwrap() = json!("daily");
        value
            .pointer_mut("/command/data/groups/1/buckets")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .push(json!({"id": "new-5h", "window": "5h", "remaining_fraction": 0.9}));
        let snapshot = parse(&value).expect("shape");
        assert!(snapshot.window_groups[0].session.is_none());
        assert_eq!(snapshot.window_groups.last().unwrap().label, "Other models");
        let empty = json!({"status": "SUCCESS", "num_turns": 0, "command": {"name": "usage", "data": {"groups": []}}});
        assert!(parse(&empty).is_none());
    }

    #[test]
    fn only_one_version_token_at_or_above_the_minimum_passes() {
        for (text, ok) in [
            ("1.5.14\n", true),
            ("1.1.11", true),
            ("1.1.10", false),
            ("0.9.0", false),
            ("2.0.0", true),
            ("1.5.14\nextra", false),
            ("agy 1.5.14", false),
            ("1.5.14-beta.1", false),
            ("", false),
        ] {
            assert_eq!(version_is_supported(text.as_bytes()), ok, "{text:?}");
        }
    }

    #[test]
    fn the_default_instance_is_read_explicit_first_and_legacy_as_fallback() {
        assert!(!default_instance_enabled(&json!({})));
        assert!(default_instance_enabled(
            &json!({"providers": {"antigravity": {"enabled": true}}})
        ));
        // Saving the default card writes the explicit instance and resets the legacy entry.
        assert!(default_instance_enabled(&json!({
            "providers": {"antigravity": {"enabled": false}},
            "providerInstances": {"antigravity": {"driver": "antigravity", "enabled": true}}
        })));
        assert!(!default_instance_enabled(&json!({
            "providers": {"antigravity": {"enabled": true}},
            "providerInstances": {"antigravity": {"driver": "antigravity", "enabled": false}}
        })));
    }

    #[cfg(unix)]
    mod fake_cli {
        use super::*;
        use crate::test_support::TestSandbox;

        const USAGE_JSON: &str = r#"{"status":"SUCCESS","num_turns":0,"response":"PRIVATE-PLAN-MARKER","command":{"name":"usage","data":{"groups":[{"name":"PRIVATE-PLAN-MARKER","buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0.5,"reset_time":"2026-11-22T02:28:19Z"}]}]}}}"#;

        struct Fixture {
            sandbox: TestSandbox,
            log: PathBuf,
        }

        impl Fixture {
            fn new() -> Self {
                let sandbox = TestSandbox::new("agy-usage");
                let log = sandbox.path("calls.log");
                Self { sandbox, log }
            }

            /// Writes the fake `agy`; `version` is what `--version` prints, `exit_code` the
            /// usage run's exit status. Returns the settings document pointing at it.
            fn install(&self, version: &str, exit_code: i32, padding: &str) -> Value {
                let body = format!(
                    "# {padding}\necho \"$1\" >> '{log}'\nif [ \"$1\" = \"--version\" ]; then printf '%s' '{version}'; exit 0; fi\nprintf '%s' '{usage}'\necho PRIVATE-PLAN-MARKER >&2\nexit {exit_code}",
                    log = self.log.display(),
                    usage = USAGE_JSON,
                );
                let path = self.sandbox.executable_script("agy", &body, "");
                json!({
                    "providerInstances": {"antigravity": {
                        "driver": "antigravity",
                        "enabled": true,
                        "config": {"binaryPath": path.to_string_lossy()}
                    }}
                })
            }

            fn calls(&self) -> Vec<String> {
                std::fs::read_to_string(&self.log)
                    .unwrap_or_default()
                    .lines()
                    .map(str::to_owned)
                    .collect()
            }
        }

        async fn fetch(
            document: &Value,
            verified: &StdMutex<Option<VerifiedExecutable>>,
        ) -> Result<ProviderUsageSnapshot, ProviderUsageFetchError> {
            fetch_for_document(document, None, verified).await
        }

        #[tokio::test]
        async fn a_verified_cli_is_probed_once_and_never_leaks_its_free_text() {
            let fixture = Fixture::new();
            let document = fixture.install("1.5.14", 0, "a");
            let verified = StdMutex::default();
            let snapshot = fetch(&document, &verified).await.expect("fetch");
            assert_eq!(snapshot.status, ProviderUsageStatus::Ok);
            assert!(!format!("{snapshot:?}").contains(MARKER));
            fetch(&document, &verified).await.expect("second fetch");
            assert_eq!(fixture.calls(), ["--version", "-p", "-p"]);
        }

        #[tokio::test]
        async fn a_same_path_downgrade_is_probed_again_and_spawns_no_usage_run() {
            let fixture = Fixture::new();
            let document = fixture.install("1.5.14", 0, "a");
            let verified = StdMutex::default();
            fetch(&document, &verified).await.expect("fetch");
            // The executable at the same path is replaced by an older CLI.
            fixture.install("1.1.10", 0, "a longer padding changes the size");
            let snapshot = fetch(&document, &verified).await.expect("fetch");
            assert_eq!(snapshot.status, ProviderUsageStatus::Unavailable);
            assert_eq!(snapshot.error.as_deref(), Some(MESSAGE_VERSION));
            assert_eq!(fixture.calls(), ["--version", "-p", "--version"]);
        }

        #[tokio::test]
        async fn unconfirmable_versions_never_run_usage() {
            for version in ["agy 1.5.14", "1.5.14 extra", "", "1.1.10"] {
                let fixture = Fixture::new();
                let document = fixture.install(version, 0, "a");
                let snapshot = fetch(&document, &StdMutex::default()).await.expect("fetch");
                assert_eq!(
                    snapshot.error.as_deref(),
                    Some(MESSAGE_VERSION),
                    "{version:?}"
                );
                assert_eq!(fixture.calls(), ["--version"], "{version:?}");
            }
        }

        #[tokio::test]
        async fn exit_code_two_means_no_account_quota_and_other_failures_are_transient() {
            let fixture = Fixture::new();
            let document = fixture.install("1.5.14", 2, "a");
            let snapshot = fetch(&document, &StdMutex::default()).await.expect("fetch");
            assert_eq!(snapshot.status, ProviderUsageStatus::Unavailable);
            assert_eq!(snapshot.error.as_deref(), Some(MESSAGE_API_KEY));
            let fixture = Fixture::new();
            let document = fixture.install("1.5.14", 1, "a");
            let error = fetch(&document, &StdMutex::default())
                .await
                .expect_err("failure");
            assert_eq!(error.message, MESSAGE_TRANSIENT);
            assert!(!error.message.contains(MARKER));
        }

        #[tokio::test]
        async fn a_disabled_default_instance_spawns_nothing() {
            let fixture = Fixture::new();
            let mut document = fixture.install("1.5.14", 0, "a");
            document["providerInstances"]["antigravity"]["enabled"] = json!(false);
            let snapshot = fetch(&document, &StdMutex::default()).await.expect("fetch");
            assert_eq!(snapshot.error.as_deref(), Some(MESSAGE_DISABLED));
            assert!(fixture.calls().is_empty());
        }
    }
}
