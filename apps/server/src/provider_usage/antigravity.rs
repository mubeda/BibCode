//! Antigravity account usage, read from `agy -p "/usage" --output-format json`.
//!
//! The command answers without a model turn since CLI 1.1.11; an older CLI would send the text as
//! a prompt and spend quota, so nothing is run until `--version` proves a new enough CLI. The
//! CLI's free text (group names, descriptions, the response) is never read: a plan name can sit
//! there. Design: `docs/plans/2026-11-21-antigravity-usage-design.md`.

use std::{
    collections::BTreeMap,
    fmt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, SystemTime},
};

use serde::{
    Deserialize, Deserializer,
    de::{IgnoredAny, MapAccess, SeqAccess, Visitor},
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
/// The service's deadline for one attempt: the settings read, both runs and their cleanup.
pub(super) const ATTEMPT_DEADLINE: Duration = DEADLINE;
/// After the deadline cancels the runs, how long the supervisor gets to reap them.
pub(super) const CLEANUP_GRACE: Duration = Duration::from_secs(5);
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
                let unreadable =
                    || ProviderUsageFetchError::new("Antigravity settings could not be read.");
                let cancellation = super::attempt_cancellation();
                // The environment with its stored secrets, as the chat provider reads it: an
                // API-key instance is not read with the host's account.
                let read = async { serde_json::to_value(settings.get().await.ok()?).ok() };
                let document = tokio::select! {
                    document = read => document.ok_or_else(unreadable)?,
                    () = cancellation.cancelled() => {
                        return Err(ProviderUsageFetchError::new(MESSAGE_TRANSIENT));
                    }
                };
                fetch_for_document(&document, attribution.as_ref(), &verified, DEADLINE).await
            })
        }),
    }
}

/// Whether the default Antigravity instance is on, by the rule every launch uses.
pub(super) fn default_instance_enabled(document: &Value) -> bool {
    crate::server_settings::provider_instance_enabled(document, "antigravity")
}

pub(super) async fn fetch_for_document(
    document: &Value,
    attribution: Option<&ProcessAttributionRegistry>,
    verified: &StdMutex<Option<VerifiedExecutable>>,
    deadline: Duration,
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
    let ends_at = started + deadline;
    let workdir =
        ScratchDirectory::create().map_err(|_| ProviderUsageFetchError::new(MESSAGE_TRANSIENT))?;
    // Stopped by the service's attempt deadline and its shutdown, and by this fetch's deadline.
    let cancellation = super::attempt_cancellation();
    // Both runs launch the file whose version was verified (the canonical path), never a path a
    // symlink could retarget in between; the name it was called by stays its argv[0].
    let run = |arguments: &'static [&'static str], timeout: Duration| {
        until_deadline(
            run_cli(
                CliLaunch {
                    program: &identity.0,
                    called_as: &executable,
                },
                arguments,
                &target.environment,
                workdir.path(),
                timeout,
                &cancellation,
                attribution,
            ),
            ends_at,
            &cancellation,
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
        *verified.lock().unwrap_or_else(|error| error.into_inner()) = Some(identity.clone());
    }

    let remaining = deadline.saturating_sub(started.elapsed());
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

/// Cancels the runs through the supervisor's token at the deadline, then waits for the run to
/// settle: the supervisor stops the whole process group, a descendant that kept the output pipes
/// open included, before the run returns.
async fn until_deadline<F: std::future::Future>(
    run: F,
    ends_at: tokio::time::Instant,
    cancellation: &CancellationToken,
) -> F::Output {
    tokio::pin!(run);
    tokio::select! {
        output = &mut run => return output,
        () = tokio::time::sleep_until(ends_at) => cancellation.cancel(),
    }
    run.await
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
    // Without Windows' `\\?\` prefix, which a `.cmd` launched through `cmd.exe` does not accept.
    let path = crate::git::without_verbatim_prefix(std::fs::canonicalize(executable).ok()?);
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

/// The verified file to run, and the path it was configured as (its argv[0], which a
/// version-manager shim dispatches on).
#[derive(Clone, Copy)]
struct CliLaunch<'a> {
    program: &'a Path,
    called_as: &'a Path,
}

async fn run_cli(
    launch: CliLaunch<'_>,
    arguments: &[&str],
    environment: &[(std::ffi::OsString, std::ffi::OsString)],
    workdir: &Path,
    timeout: Duration,
    cancellation: &CancellationToken,
    attribution: Option<&ProcessAttributionRegistry>,
) -> Result<SupervisedRunOutput, SupervisedRunError> {
    let CliLaunch { program, called_as } = launch;
    // Only the usage command can spend quota: its spawn starts the cooldown.
    let usage_run = arguments.first() == Some(&"-p");
    let launch = prepare_provider_launch(program, arguments)
        .map_err(|error| SupervisedRunError::Spawn(std::io::Error::other(error)))?;
    let mut command = Command::new(&launch.program);
    #[cfg(unix)]
    if launch.program.as_path() == program {
        command.arg0(called_as);
    }
    #[cfg(not(unix))]
    let _ = called_as;
    configure_background_command(&mut command);
    command
        .args(&launch.args)
        .current_dir(workdir)
        .envs(environment.iter().map(|(name, value)| (name, value)))
        // Not the server's stdin: the CLI sees end-of-file at once if it ever reads.
        .stdin(Stdio::null())
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
            if usage_run {
                super::note_usage_spawned();
            }
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
        // A random name, as the codebase names its temporary files: never two alike.
        let path = std::env::temp_dir().join(format!("bibcode-agy-usage-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&path)?;
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

/// The only fields read. Every other field, free text included, is skipped by the decoder and
/// never stored. The guard fields and the containers are strict: a wrong type there is not the
/// shape BiBCode reads.
#[derive(Deserialize)]
struct UsageOutput {
    status: Option<String>,
    num_turns: Option<u64>,
    command: Option<Object<UsageCommand>>,
}

#[derive(Deserialize)]
struct UsageCommand {
    name: Option<String>,
    data: Option<Object<UsageData>>,
}

#[derive(Deserialize)]
struct UsageData {
    groups: Option<Vec<Object<UsageGroup>>>,
}

/// A JSON object, never an array: serde's derived decoder also accepts a positional array, which
/// would let a reply with no `name` field pass the guard.
struct Object<T>(T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Object<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(std::marker::PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjectVisitor<T> {
            type Value = Object<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                T::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(Object)
            }
        }

        deserializer.deserialize_map(ObjectVisitor(std::marker::PhantomData))
    }
}

#[derive(Deserialize)]
struct UsageGroup {
    #[serde(default)]
    buckets: Lenient<Vec<UsageBucket>>,
}

/// A bucket's fields are each optional: one of the wrong type drops the bucket, not the payload.
#[derive(Deserialize)]
struct UsageBucket {
    #[serde(default)]
    id: Lenient<String>,
    #[serde(default)]
    window: Lenient<String>,
    #[serde(default)]
    remaining_fraction: Lenient<f64>,
    #[serde(default)]
    reset_time: Lenient<String>,
}

/// A value of the expected kind, or `None` for anything else, skipped without being stored.
struct Lenient<T>(Option<T>);

impl<T> Default for Lenient<T> {
    fn default() -> Self {
        Self(None)
    }
}

/// What a lenient field accepts.
trait LenientKind: Sized {
    fn from_str(_: &str) -> Option<Self> {
        None
    }
    fn from_f64(_: f64) -> Option<Self> {
        None
    }
    fn from_seq<'de, A: SeqAccess<'de>>(seq: A) -> Result<Option<Self>, A::Error> {
        skip_seq(seq).map(|()| None)
    }
    fn from_map<'de, A: MapAccess<'de>>(mut map: A) -> Result<Option<Self>, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(None)
    }
}

impl LenientKind for UsageBucket {
    fn from_map<'de, A: MapAccess<'de>>(map: A) -> Result<Option<Self>, A::Error> {
        Self::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(Some)
    }
}

impl LenientKind for String {
    fn from_str(value: &str) -> Option<Self> {
        Some(value.to_owned())
    }
}

impl LenientKind for f64 {
    fn from_f64(value: f64) -> Option<Self> {
        Some(value)
    }
}

impl LenientKind for Vec<UsageBucket> {
    fn from_seq<'de, A: SeqAccess<'de>>(mut seq: A) -> Result<Option<Self>, A::Error> {
        // An entry that is not an object is skipped like a bucket with no usable field.
        let mut buckets = Vec::new();
        while let Some(Lenient(bucket)) = seq.next_element::<Lenient<UsageBucket>>()? {
            buckets.extend(bucket);
        }
        Ok(Some(buckets))
    }
}

fn skip_seq<'de, A: SeqAccess<'de>>(mut seq: A) -> Result<(), A::Error> {
    while seq.next_element::<IgnoredAny>()?.is_some() {}
    Ok(())
}

impl<'de, T: LenientKind> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct LenientVisitor<T>(std::marker::PhantomData<T>);

        impl<'de, T: LenientKind> Visitor<'de> for LenientVisitor<T> {
            type Value = Lenient<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("any JSON value")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(Lenient(T::from_str(value)))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
                Ok(Lenient(T::from_f64(value)))
            }

            #[allow(clippy::cast_precision_loss)] // a fraction: whole numbers are 0 and 1
            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(Lenient(T::from_f64(value as f64)))
            }

            #[allow(clippy::cast_precision_loss)]
            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(Lenient(T::from_f64(value as f64)))
            }

            fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
                Ok(Lenient(None))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(Lenient(None))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Self::Value, A::Error> {
                T::from_seq(seq).map(Lenient)
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                T::from_map(map).map(Lenient)
            }
        }

        deserializer.deserialize_any(LenientVisitor(std::marker::PhantomData))
    }
}

/// Reads the allowlisted fields of the CLI's JSON. `None` means "not the shape BiBCode reads".
/// A group with no usable bucket is skipped. When two buckets land on the same group and window
/// (two unknown prefixes both become "Other models"), the tighter one is kept: it is the limit
/// that stops work first.
pub(super) fn parse_usage(stdout: &[u8], now: OffsetDateTime) -> Option<ProviderUsageSnapshot> {
    let Object(output) = serde_json::from_slice::<Object<UsageOutput>>(stdout).ok()?;
    let Object(command) = output.command?;
    // The guard: a CLI that answered the text as a prompt has no command and spent a turn.
    if command.name.as_deref() != Some("usage")
        || output.num_turns != Some(0)
        || output.status.as_deref() != Some("SUCCESS")
    {
        return None;
    }
    let Object(data) = command.data?;
    let groups = data.groups?;
    let mut by_class: BTreeMap<usize, ProviderUsageWindowGroup> = BTreeMap::new();
    for bucket in groups
        .into_iter()
        .flat_map(|Object(group)| group.buckets.0.unwrap_or_default())
    {
        let Some((rank, id, label)) = bucket.id.0.as_deref().map(classify_bucket) else {
            continue;
        };
        let Some((is_session, minutes)) =
            bucket.window.0.as_deref().and_then(|window| match window {
                "5h" => Some((true, 300)),
                "weekly" => Some((false, 10_080)),
                _ => None,
            })
        else {
            continue;
        };
        let Some(remaining) = bucket
            .remaining_fraction
            .0
            .filter(|fraction| fraction.is_finite())
        else {
            continue;
        };
        let window = ProviderUsageWindow {
            used_percent: ((1.0 - remaining) * 100.0).round().clamp(0.0, 100.0) as u32,
            window_minutes: minutes,
            resets_at: bucket.reset_time.0.as_deref().and_then(|text| {
                OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()
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
        if slot
            .as_ref()
            .is_none_or(|kept| window.used_percent > kept.used_percent)
        {
            *slot = Some(window);
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
    fn a_group_without_usable_buckets_is_skipped_not_the_payload() {
        for extra in [
            json!({"name": MARKER}),
            json!({"name": MARKER, "buckets": "none"}),
            json!({"buckets": {"id": "gemini-5h"}}),
            json!({"buckets": [{"id": 7, "window": ["5h"], "remaining_fraction": {"v": 1}}]}),
            json!({"buckets": [7, "gemini-5h", null, [MARKER]]}),
        ] {
            let mut value = payload();
            value
                .pointer_mut("/command/data/groups")
                .unwrap()
                .as_array_mut()
                .unwrap()
                .push(extra.clone());
            let snapshot = parse(&value).unwrap_or_else(|| panic!("{extra} rejected the payload"));
            assert_eq!(snapshot.window_groups.len(), 2, "{extra}");
        }
    }

    #[test]
    fn positional_arrays_never_stand_in_for_the_guard_objects() {
        let groups = payload().pointer("/command/data/groups").unwrap().clone();
        for value in [
            json!({"status": "SUCCESS", "num_turns": 0, "command": ["usage", {"groups": groups}]}),
            json!(["SUCCESS", 0, {"name": "usage", "data": {"groups": groups}}]),
            json!({"status": "SUCCESS", "num_turns": 0, "command": {"name": "usage", "data": [groups]}}),
        ] {
            assert!(parse(&value).is_none(), "{value}");
        }
    }

    #[test]
    fn two_buckets_on_one_group_and_window_keep_the_tighter() {
        let mut value = payload();
        let buckets = value
            .pointer_mut("/command/data/groups/1/buckets")
            .unwrap()
            .as_array_mut()
            .unwrap();
        buckets.push(json!({"id": "new-5h", "window": "5h", "remaining_fraction": 0.9}));
        buckets.push(json!({"id": "other-5h", "window": "5h", "remaining_fraction": 0.2}));
        buckets.push(json!({"id": "late-5h", "window": "5h", "remaining_fraction": 0.6}));
        let snapshot = parse(&value).expect("shape");
        let other = snapshot.window_groups.last().unwrap();
        assert_eq!(other.label, "Other models");
        assert_eq!(other.session.as_ref().unwrap().used_percent, 80);
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
            fetch_for_document(document, None, verified, DEADLINE).await
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

        fn document_for(path: &Path) -> Value {
            json!({
                "providerInstances": {"antigravity": {
                    "driver": "antigravity",
                    "enabled": true,
                    "config": {"binaryPath": path.to_string_lossy()}
                }}
            })
        }

        /// A fake `agy` that logs `$1` and answers `--version` with 1.5.14 unless `version`
        /// replaces that branch, and the usage run with `usage`.
        fn script(fixture: &Fixture, name: &str, version: &str, usage: &str) -> PathBuf {
            let body = format!(
                "echo \"$1\" >> '{log}'\nif [ \"$1\" = \"--version\" ]; then {version}; fi\n{usage}",
                log = fixture.log.display(),
            );
            fixture.sandbox.executable_script(name, &body, "")
        }

        const VERSION_OK: &str = "printf 1.5.14; exit 0";
        fn usage_ok() -> String {
            format!("printf '%s' '{USAGE_JSON}'")
        }

        #[tokio::test]
        async fn both_runs_launch_the_verified_file_even_when_its_symlink_is_retargeted() {
            let fixture = Fixture::new();
            let old_log = fixture.sandbox.path("old.log");
            // The newer CLI holds its version answer while the link is switched to an older one.
            let newer = script(
                &fixture,
                "agy-new",
                "sleep 1; printf 1.5.14; exit 0",
                &usage_ok(),
            );
            let older = fixture.sandbox.executable_script(
                "agy-old",
                &format!(
                    "echo \"$1\" >> '{}'\nif [ \"$1\" = \"--version\" ]; then printf 1.1.10; exit 0; fi\nexit 0",
                    old_log.display()
                ),
                "",
            );
            let link = fixture.sandbox.path("agy");
            std::os::unix::fs::symlink(&newer, &link).expect("link");
            let document = document_for(&link);
            let fetch = tokio::spawn(async move {
                fetch_for_document(&document, None, &StdMutex::default(), DEADLINE).await
            });
            tokio::time::sleep(Duration::from_millis(300)).await;
            std::fs::remove_file(&link).expect("unlink");
            std::os::unix::fs::symlink(&older, &link).expect("relink");
            let snapshot = fetch.await.expect("task").expect("fetch");
            assert_eq!(snapshot.status, ProviderUsageStatus::Ok);
            assert_eq!(fixture.calls(), ["--version", "-p"]);
            assert!(
                std::fs::read_to_string(&old_log)
                    .unwrap_or_default()
                    .is_empty(),
                "the unverified CLI ran"
            );
        }

        #[tokio::test]
        async fn both_runs_see_end_of_file_on_stdin() {
            let fixture = Fixture::new();
            let body = format!(
                "if [ /dev/stdin -ef /dev/null ]; then s=closed; else s=open; fi\necho \"$1:$s\" >> '{log}'\nif [ \"$1\" = \"--version\" ]; then {VERSION_OK}; fi\n{usage}",
                log = fixture.log.display(),
                usage = usage_ok(),
            );
            let path = fixture.sandbox.executable_script("agy", &body, "");
            let snapshot = fetch(&document_for(&path), &StdMutex::default())
                .await
                .expect("fetch");
            assert_eq!(snapshot.status, ProviderUsageStatus::Ok);
            assert_eq!(fixture.calls(), ["--version:closed", "-p:closed"]);
        }

        #[tokio::test]
        async fn the_instance_environment_includes_its_stored_secret() {
            use crate::server_settings::{
                ProviderEnvironmentVariableInput, ProviderInstanceInput, ServerSettingsPatch,
            };
            let fixture = Fixture::new();
            let body = format!(
                "echo \"$1:$GEMINI_API_KEY\" >> '{log}'\nif [ \"$1\" = \"--version\" ]; then {VERSION_OK}; fi\nexit 2",
                log = fixture.log.display(),
            );
            let path = fixture.sandbox.executable_script("agy", &body, "");
            let root = fixture.sandbox.path("settings");
            let store = ProviderSettingsStore::new(&root);
            store
                .update(ServerSettingsPatch {
                    provider_instances: Some(BTreeMap::from([(
                        "antigravity".to_owned(),
                        ProviderInstanceInput {
                            driver: "antigravity".to_owned(),
                            enabled: true,
                            display_name: None,
                            environment: vec![ProviderEnvironmentVariableInput {
                                name: "GEMINI_API_KEY".to_owned(),
                                value: "test-key-value".to_owned(),
                                sensitive: true,
                                value_redacted: false,
                            }],
                            config: json!({"binaryPath": path.to_string_lossy()}),
                        },
                    )])),
                    ..ServerSettingsPatch::default()
                })
                .await
                .expect("save");
            let persisted = std::fs::read_to_string(root.join("settings.json")).expect("saved");
            assert!(
                !persisted.contains("test-key-value"),
                "the secret is stored apart"
            );
            let snapshot = (fetcher(store, None).fetch)().await.expect("fetch");
            assert_eq!(snapshot.error.as_deref(), Some(MESSAGE_API_KEY));
            assert_eq!(
                fixture.calls(),
                ["--version:test-key-value", "-p:test-key-value"]
            );
        }

        #[tokio::test]
        async fn a_saved_legacy_disable_still_wins_over_an_instance_without_enabled() {
            let fixture = Fixture::new();
            let path = script(&fixture, "agy", VERSION_OK, &usage_ok());
            let root = fixture.sandbox.path("settings");
            std::fs::create_dir_all(&root).expect("settings root");
            let instance = json!({
                "driver": "antigravity",
                "config": {"binaryPath": path.to_string_lossy()}
            });
            // Without a legacy entry the built-in default (off) decides, as for the inventory.
            for document in [
                json!({
                    "providers": {"antigravity": {"enabled": false}},
                    "providerInstances": {"antigravity": instance.clone()}
                }),
                json!({ "providerInstances": {"antigravity": instance.clone()} }),
            ] {
                std::fs::write(root.join("settings.json"), document.to_string()).expect("settings");
                let snapshot = (fetcher(ProviderSettingsStore::new(&root), None).fetch)()
                    .await
                    .expect("fetch");
                assert_eq!(
                    snapshot.error.as_deref(),
                    Some(MESSAGE_DISABLED),
                    "{document}"
                );
                assert!(fixture.calls().is_empty());
            }
        }

        #[tokio::test]
        async fn a_descendant_holding_stdout_open_is_stopped_at_the_deadline() {
            let fixture = Fixture::new();
            let pid_file = fixture.sandbox.path("descendant.pid");
            let path = script(
                &fixture,
                "agy",
                VERSION_OK,
                &format!(
                    "sleep 30 &\necho $! > '{}'\nprintf partial\nexit 0",
                    pid_file.display()
                ),
            );
            let started = std::time::Instant::now();
            let error = fetch_for_document(
                &document_for(&path),
                None,
                &StdMutex::default(),
                Duration::from_secs(1),
            )
            .await
            .expect_err("the deadline cancels the run");
            assert_eq!(error.message, MESSAGE_TRANSIENT);
            assert!(started.elapsed() < Duration::from_secs(10));
            let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
                .expect("pid")
                .trim()
                .parse()
                .expect("pid");
            let mut alive = true;
            for _ in 0..50 {
                // SAFETY: signal 0 only checks whether the process exists.
                alive = unsafe { libc::kill(pid, 0) } == 0;
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(!alive, "the descendant survived the deadline");
        }

        #[tokio::test]
        async fn truncated_version_or_usage_output_is_never_trusted() {
            let fixture = Fixture::new();
            let path = script(
                &fixture,
                "agy",
                "printf 1.5.14; head -c 70000 /dev/zero | tr '\\0' ' '; exit 0",
                &usage_ok(),
            );
            let snapshot = fetch(&document_for(&path), &StdMutex::default())
                .await
                .expect("fetch");
            assert_eq!(snapshot.error.as_deref(), Some(MESSAGE_VERSION));
            assert_eq!(fixture.calls(), ["--version"]);

            let fixture = Fixture::new();
            let path = script(
                &fixture,
                "agy",
                VERSION_OK,
                &format!("{}; head -c 70000 /dev/zero | tr '\\0' ' '", usage_ok()),
            );
            let snapshot = fetch(&document_for(&path), &StdMutex::default())
                .await
                .expect("fetch");
            assert_eq!(snapshot.error.as_deref(), Some(MESSAGE_FORMAT));
        }

        #[tokio::test]
        async fn failures_log_a_class_never_the_cli_text() {
            let Some(child) = crate::test_support::in_own_process(
                "provider_usage::antigravity::tests::fake_cli::failures_log_a_class_never_the_cli_text",
            ) else {
                return;
            };
            let log = CapturedLog::default();
            let _logging = tracing::subscriber::set_default(
                tracing_subscriber::fmt()
                    .with_ansi(false)
                    .with_max_level(tracing::Level::TRACE)
                    .with_writer({
                        let log = log.clone();
                        move || log.clone()
                    })
                    .finish(),
            );
            // A non-zero exit, then a run cut off by the deadline, both with the marker on
            // stdout and stderr.
            for (usage, deadline) in [
                (
                    format!("{}; echo {MARKER} >&2; exit 1", usage_ok()),
                    DEADLINE,
                ),
                (
                    format!("echo {MARKER}; echo {MARKER} >&2; sleep 30"),
                    Duration::from_secs(1),
                ),
            ] {
                let fixture = Fixture::new();
                let path = script(&fixture, "agy", VERSION_OK, &usage);
                let error =
                    fetch_for_document(&document_for(&path), None, &StdMutex::default(), deadline)
                        .await
                        .expect_err("failure");
                assert!(!error.message.contains(MARKER));
            }
            let log = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
            assert!(
                log.contains("Antigravity usage exited unsuccessfully"),
                "{log}"
            );
            assert!(log.contains("Antigravity usage run failed"), "{log}");
            assert!(
                !log.contains(MARKER),
                "the CLI's text reached the log:\n{log}"
            );
            child.complete();
        }

        #[derive(Clone, Default)]
        struct CapturedLog(Arc<StdMutex<Vec<u8>>>);

        impl std::io::Write for CapturedLog {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
    }
}
