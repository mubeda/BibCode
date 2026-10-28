#![cfg_attr(not(unix), allow(dead_code))]
// Windows compiles the shared factory facade, while this authenticated hook
// observer intentionally remains Unix-only and returns pass-through there.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fmt,
    future::{Future, IntoFuture},
    io,
    net::TcpListener as StdTcpListener,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

#[cfg(unix)]
use std::net::{Ipv4Addr, SocketAddrV4};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, StatusCode, header::CONTENT_TYPE},
    response::IntoResponse,
    routing::post,
};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

#[cfg(all(test, unix))]
use super::TerminalObserverGeneration;
use super::model::{TerminalAgentState, TerminalObserverGenerationLease};
#[cfg(unix)]
use super::supervisor::create_owned_generation_directory;
use super::{
    PreparedTerminalLaunch, PreparedTerminalObserver, ProviderTerminalObserverFactory,
    ProviderTerminalObserverFactoryInput, TerminalAgentActivityAdmission,
    TerminalAgentActivityControl, TerminalAgentActivityObservation,
    TerminalAgentActivityObservationKind, TerminalAgentActivityTransition,
    TerminalGenerationActivityPublisher, TerminalObserverWorkerContext,
    supervisor::cleanup_owned_generation_directory,
};
#[cfg(test)]
use crate::process::supervised::run_supervised_with_spawn_observer_until;
use crate::{
    activity::{
        ActivityActorSummary, ActivityCapabilities, ActivityHistoryRecovery, ActivityLifecycle,
        ActivityObservationState, ActivityWorkItemSummary, ProviderActivityMutation,
    },
    diagnostics::{
        AttributionKind, AttributionScope, NativeProcessSampler, ProcessAttributionRegistry,
        ProcessRegistration, ProcessRegistrationMetadata, RegistrationSource,
    },
    process::supervised::{
        SupervisedOverflow, SupervisedRunRequest, run_supervised,
        run_supervised_with_spawn_observer,
    },
    provider::claude::{
        activity::{ClaudeActivityInputSource, ClaudeActivityTracker},
        transcript::{ClaudeTranscriptRecoveryRequest, recover_transcript},
    },
};

const CLAUDE_PROBE_OUTPUT_LIMIT: usize = 64 * 1024;
const CLAUDE_CAPABILITY_CACHE_CAPACITY: usize = 64;
const CLAUDE_CAPABILITY_PROBE_CONCURRENCY: usize = 8;
/// The probe runner's own 2 s timeout bounds the slowest step (the attestation's `codesign` is
/// capped at 500 ms and runs beside it), plus 250 ms to pin, write the overlay and bind the
/// listener. A healthy preparation takes 0.2-0.4 s, also under load. See "Preparation budgets"
/// in docs/architecture/activity-observation.md.
const CLAUDE_PREPARATION_BUDGET: Duration = Duration::from_millis(2_250);
const CLAUDE_HOOK_BODY_LIMIT: usize = 1024 * 1024;
const CLAUDE_HOOK_QUEUE_CAPACITY: usize = 128;
const CLAUDE_HOOK_REQUEST_CAPACITY: usize = 32;
const CLAUDE_HOOK_BODY_TIMEOUT: Duration = Duration::from_secs(2);
const CLAUDE_HOOK_RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);
const CLAUDE_HOOK_CORRELATION_HEADER: &str = "X-BiBCode-Launch-Correlation";
const CLAUDE_HOOK_PATH_LIMIT: usize = 4 * 1024;
const CLAUDE_HOOK_TEXT_LIMIT: usize = 16 * 1024;
const CLAUDE_HOOK_OBJECT_LIMIT: usize = 64 * 1024;
// Anthropic introduced HTTP hooks in Claude Code v2.1.63. Versions before
// that explicitly reported that HTTP hooks were unsupported.
const MIN_PROVEN_HTTP_HOOK_VERSION: (u64, u64, u64) = (2, 1, 63);
/// The Claude Code builds whose `--settings` hooks BiBCode has proven to be added to the user's
/// own hooks rather than replacing them. 2.1.220 is the build whose merge code was inspected
/// (markers "3. **Merge**: Add to existing hooks, don't replace" and "Failed to merge hooks
/// from "). The ceiling is the newest build the live proof passed on: a user `PreToolUse` guard
/// still blocks a tool call with BiBCode's overlay injected
/// (`tests::live_user_pre_tool_use_guard_still_blocks_with_the_bibcode_overlay`, a release step
/// in docs/operations/release.md). A newer build runs unhooked until a release raises it.
const MIN_ADDITIVE_HOOK_VERSION: (u64, u64, u64) = (2, 1, 220);
const MAX_ADDITIVE_HOOK_VERSION: (u64, u64, u64) = (2, 1, 312);
/// The `--version` line of a genuine build ends in this marker. A multi-call shim such as mise
/// answers with its own dotted version, which must never pass as a Claude version.
const CLAUDE_VERSION_MARKER: &str = "(Claude Code)";
/// Anthropic's code signature: Developer ID team Q6L2SF6YDW, identifier
/// com.anthropic.claude-code, anchored at Apple. `codesign --verify` hashes every page against
/// it, so one changed byte fails.
#[cfg(target_os = "macos")]
const ANTHROPIC_CODE_REQUIREMENT: &str = "anchor apple generic and identifier \"com.anthropic.claude-code\" and certificate leaf[subject.OU] = \"Q6L2SF6YDW\"";
/// Verifying a 276 MB build takes 0.4 to 0.8 s, once per build.
#[cfg(target_os = "macos")]
const CODESIGN_VERIFY_TIMEOUT: Duration = Duration::from_millis(1_250);
/// No Claude build is near this; a larger candidate is refused before it is pinned.
const CLAUDE_PIN_SIZE_LIMIT: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Eq, PartialEq)]
pub struct ClaudeProbeOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl fmt::Debug for ClaudeProbeOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeProbeOutput")
            .field("success", &self.success)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .finish()
    }
}

pub trait ClaudeCapabilityProbeRunner: Send + Sync {
    fn run(
        &self,
        executable: &Path,
        args: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<ClaudeProbeOutput, String>> + Send + '_>>;
}

/// Proves who published a build whose version is already in the approved range. It runs once
/// per build (source fingerprint); every launch then binds its pin to the proven bytes by
/// SHA-256.
pub trait ClaudeAdditiveHookAttestor: Send + Sync {
    fn prove(
        &self,
        executable: &Path,
        version: &str,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>>;

    /// `prove`, with the registry its child processes are attributed to.
    fn prove_attributed<'a>(
        &'a self,
        executable: &'a Path,
        version: &'a str,
        _process_attribution: Option<&'a ProcessAttributionRegistry>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        self.prove(executable, version)
    }
}

pub trait ClaudeExecutablePinner: Send + Sync {
    fn pin(&self, source: &Path, destination: &Path) -> io::Result<()>;

    /// `pin`, stopping early once `cancelled` is set. It runs off the async runtime, and a
    /// failed or cancelled pin leaves no destination file behind.
    fn pin_cancellable(
        &self,
        source: &Path,
        destination: &Path,
        _cancelled: &AtomicBool,
    ) -> io::Result<()> {
        self.pin(source, destination)
    }
}

/// What a shim's manager says it would run, before any of it is trusted.
#[derive(Clone)]
pub struct ClaudeShimResolution {
    /// The real install the shim hands off to; validated and attested before it is pinned.
    pub executable: PathBuf,
    /// The environment the shim's manager applies before it runs that install.
    pub env: BTreeMap<String, String>,
}

impl fmt::Debug for ClaudeShimResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeShimResolution")
            .field("executable", &self.executable)
            .field("env_keys", &self.env.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// A launch of a multi-call shim, as the terminal would start it.
#[derive(Clone, Copy, Debug)]
pub struct ClaudeShimRequest<'a> {
    /// The path the terminal invokes, such as `~/.local/share/mise/shims/claude`.
    pub invoked: &'a Path,
    /// The shim's canonical target, the manager binary, such as `mise`.
    pub manager: &'a Path,
    pub cwd: &'a Path,
    pub launch_env: &'a BTreeMap<String, String>,
    pub process_attribution: &'a ProcessAttributionRegistry,
}

/// Finds the real install behind a multi-call shim. Its answer is untrusted: preparation
/// validates the path and attests the pinned bytes, and validates the environment.
pub trait ClaudeInstallResolver: Send + Sync {
    fn resolve<'a>(
        &'a self,
        request: ClaudeShimRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Option<ClaudeShimResolution>> + Send + 'a>>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeCapabilities {
    pub version: String,
    pub additional_settings: bool,
    pub authenticated_http_hooks: bool,
    pub additive_hook_merge: bool,
}

pub struct CachedClaudeCapabilityProbe {
    runner: Arc<dyn ClaudeCapabilityProbeRunner>,
    attestor: Arc<dyn ClaudeAdditiveHookAttestor>,
    cache: tokio::sync::Mutex<ClaudeCapabilityCache>,
    probe_gates: Mutex<HashMap<ClaudeExecutableFingerprint, std::sync::Weak<ClaudeProbeGate>>>,
    approval_gates: Mutex<HashMap<ClaudeExecutableFingerprint, std::sync::Weak<ClaudeProbeGate>>>,
    probe_permits: Semaphore,
}

impl fmt::Debug for CachedClaudeCapabilityProbe {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CachedClaudeCapabilityProbe")
            .finish_non_exhaustive()
    }
}

impl CachedClaudeCapabilityProbe {
    #[must_use]
    pub fn new(runner: Arc<dyn ClaudeCapabilityProbeRunner>) -> Self {
        Self::with_attestor(runner, Arc::new(ApprovedClaudeAdditiveHookAttestor))
    }

    #[must_use]
    pub fn with_attestor(
        runner: Arc<dyn ClaudeCapabilityProbeRunner>,
        attestor: Arc<dyn ClaudeAdditiveHookAttestor>,
    ) -> Self {
        Self {
            runner,
            attestor,
            cache: tokio::sync::Mutex::new(ClaudeCapabilityCache::default()),
            probe_gates: Mutex::new(HashMap::new()),
            approval_gates: Mutex::new(HashMap::new()),
            probe_permits: Semaphore::new(CLAUDE_CAPABILITY_PROBE_CONCURRENCY),
        }
    }

    /// Probes `executable` as its own pin: what a launch of it would be granted.
    pub async fn probe(&self, executable: &Path) -> Option<ClaudeCapabilities> {
        let path = std::fs::canonicalize(executable).unwrap_or_else(|_| executable.to_path_buf());
        let fingerprint = ClaudeExecutableFingerprint::read(&path)?;
        self.probe_pinned(&path, &fingerprint, &path, None).await
    }

    /// Probes the build `source` was when `source_fingerprint` was read (before it was pinned),
    /// and grants additive hooks only when `pinned` holds exactly the bytes approved for it.
    async fn probe_pinned(
        &self,
        source: &Path,
        source_fingerprint: &ClaudeExecutableFingerprint,
        pinned: &Path,
        process_attribution: Option<&ProcessAttributionRegistry>,
    ) -> Option<ClaudeCapabilities> {
        let pinned_fingerprint = ClaudeExecutableFingerprint::read(pinned)?;
        let pinned_for_digest = pinned.to_path_buf();
        let (capabilities, digest) = tokio::join!(
            self.probe_cacheable(source, source_fingerprint.clone()),
            async move {
                tokio::task::spawn_blocking(move || sha256_file(&pinned_for_digest))
                    .await
                    .ok()
                    .and_then(Result::ok)
            },
        );
        let capabilities = capabilities?;
        // The source must still be the build that was pinned and probed.
        if ClaudeExecutableFingerprint::read(source).as_ref() != Some(source_fingerprint) {
            return None;
        }
        let additive_hook_merge = match digest {
            Some(digest)
                if capabilities.authenticated_http_hooks
                    && additive_hook_version(&capabilities.version) =>
            {
                self.approve_build(
                    source_fingerprint,
                    pinned,
                    &pinned_fingerprint,
                    digest,
                    &capabilities.version,
                    process_attribution,
                )
                .await
            }
            _ => false,
        };
        Some(ClaudeCapabilities {
            version: capabilities.version,
            additional_settings: capabilities.additional_settings,
            authenticated_http_hooks: capabilities.authenticated_http_hooks,
            additive_hook_merge,
        })
    }

    async fn probe_cacheable(
        &self,
        path: &Path,
        fingerprint: ClaudeExecutableFingerprint,
    ) -> Option<ClaudeCacheableCapabilities> {
        if let Some(capabilities) = self.cache.lock().await.get(&fingerprint) {
            return Some(capabilities);
        }
        let probe_gate = gate_for(&self.probe_gates, &fingerprint);
        let _probe_guard = probe_gate.lock.lock().await;
        if let Some(capabilities) = self.cache.lock().await.get(&fingerprint) {
            return Some(capabilities);
        }
        if probe_gate.failed.load(Ordering::Acquire) {
            return None;
        }
        let _probe_permit = self.probe_permits.acquire().await.ok()?;
        let capabilities = self.probe_uncached(path).await;
        if ClaudeExecutableFingerprint::read(path).as_ref() != Some(&fingerprint) {
            probe_gate.failed.store(true, Ordering::Release);
            return None;
        }
        if let Some(capabilities) = &capabilities {
            let mut cache = self.cache.lock().await;
            if let Some(cached) = cache.get(&fingerprint) {
                return Some(cached);
            }
            cache.insert(fingerprint, capabilities.clone());
        } else {
            probe_gate.failed.store(true, Ordering::Release);
        }
        capabilities
    }

    /// Whether `pinned` (whose bytes hash to `digest`) is an approved copy of the build with
    /// `source_fingerprint`. The publisher is proven once per build, single-flight across
    /// concurrent launches. Only a completed proof is cached, so a failed or cancelled one
    /// publishes nothing. Every launch compares its own pin's digest with the proven one.
    async fn approve_build(
        &self,
        source_fingerprint: &ClaudeExecutableFingerprint,
        pinned: &Path,
        pinned_fingerprint: &ClaudeExecutableFingerprint,
        digest: [u8; 32],
        version: &str,
        process_attribution: Option<&ProcessAttributionRegistry>,
    ) -> bool {
        if let Some(approved) = self.cache.lock().await.approved_digest(source_fingerprint) {
            return approved == digest;
        }
        let gate = gate_for(&self.approval_gates, source_fingerprint);
        let _guard = gate.lock.lock().await;
        if let Some(approved) = self.cache.lock().await.approved_digest(source_fingerprint) {
            return approved == digest;
        }
        if gate.failed.load(Ordering::Acquire) {
            return false;
        }
        if !self
            .attest_stable_build(pinned, pinned_fingerprint, version, process_attribution)
            .await
        {
            gate.failed.store(true, Ordering::Release);
            return false;
        }
        self.cache
            .lock()
            .await
            .set_approved_digest(source_fingerprint, digest)
    }

    async fn attest_stable_build(
        &self,
        executable: &Path,
        expected_fingerprint: &ClaudeExecutableFingerprint,
        version: &str,
        process_attribution: Option<&ProcessAttributionRegistry>,
    ) -> bool {
        let Ok(_attestation_permit) = self.probe_permits.acquire().await else {
            return false;
        };
        let Some(before) = ClaudeExecutableFingerprint::read(executable) else {
            return false;
        };
        if &before != expected_fingerprint {
            return false;
        }
        let approved = self
            .attestor
            .prove_attributed(executable, version, process_attribution)
            .await;
        approved
            && ClaudeExecutableFingerprint::read(executable)
                .is_some_and(|after| after == before && &after == expected_fingerprint)
    }

    async fn probe_uncached(&self, executable: &Path) -> Option<ClaudeCacheableCapabilities> {
        let (version, help) = tokio::join!(
            self.runner.run(executable, vec!["--version".to_owned()]),
            self.runner.run(executable, vec!["--help".to_owned()]),
        );
        let version = version.ok()?;
        let help = help.ok()?;
        if !version.success || !help.success {
            return None;
        }
        let version = parse_claude_version(&bounded_probe_text(&version.stdout, &version.stderr))?;
        let version_tuple = parse_version_tuple(&version)?;
        let help = bounded_probe_text(&help.stdout, &help.stderr);
        let additional_settings =
            help.contains("--settings <file-or-json>") && help.contains("--setting-sources");
        let authenticated_http_hooks = version_tuple >= MIN_PROVEN_HTTP_HOOK_VERSION;
        Some(ClaudeCacheableCapabilities {
            version,
            additional_settings,
            authenticated_http_hooks,
        })
    }
}

fn gate_for(
    gates: &Mutex<HashMap<ClaudeExecutableFingerprint, std::sync::Weak<ClaudeProbeGate>>>,
    fingerprint: &ClaudeExecutableFingerprint,
) -> Arc<ClaudeProbeGate> {
    let mut gates = gates
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = gates.get(fingerprint).and_then(std::sync::Weak::upgrade) {
        return gate;
    }
    let gate = Arc::new(ClaudeProbeGate::default());
    gates.insert(fingerprint.clone(), Arc::downgrade(&gate));
    gate
}

/// Whether `version` is a build whose additive `--settings` hook merge BiBCode has proven.
fn additive_hook_version(version: &str) -> bool {
    parse_version_tuple(version).is_some_and(|version| {
        (MIN_ADDITIVE_HOOK_VERSION..=MAX_ADDITIVE_HOOK_VERSION).contains(&version)
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ClaudeCacheableCapabilities {
    version: String,
    additional_settings: bool,
    authenticated_http_hooks: bool,
}

#[derive(Debug, Default)]
struct ClaudeProbeGate {
    lock: tokio::sync::Mutex<()>,
    failed: AtomicBool,
}

#[derive(Debug)]
struct ClaudeCacheEntry {
    capabilities: ClaudeCacheableCapabilities,
    /// The SHA-256 of the bytes whose publisher was proven, once proven.
    approved_digest: Option<[u8; 32]>,
}

#[derive(Debug, Default)]
struct ClaudeCapabilityCache {
    entries: HashMap<ClaudeExecutableFingerprint, ClaudeCacheEntry>,
    recency: VecDeque<ClaudeExecutableFingerprint>,
}

impl ClaudeCapabilityCache {
    fn get(
        &mut self,
        fingerprint: &ClaudeExecutableFingerprint,
    ) -> Option<ClaudeCacheableCapabilities> {
        let value = self.entries.get(fingerprint)?.capabilities.clone();
        self.recency.retain(|cached| cached != fingerprint);
        self.recency.push_back(fingerprint.clone());
        Some(value)
    }

    fn approved_digest(&self, fingerprint: &ClaudeExecutableFingerprint) -> Option<[u8; 32]> {
        self.entries.get(fingerprint)?.approved_digest
    }

    /// Records the proven digest. False when the build's entry is gone (evicted or replaced),
    /// which then grants nothing: the next launch proves it again.
    fn set_approved_digest(
        &mut self,
        fingerprint: &ClaudeExecutableFingerprint,
        digest: [u8; 32],
    ) -> bool {
        let Some(entry) = self.entries.get_mut(fingerprint) else {
            return false;
        };
        entry.approved_digest = Some(digest);
        true
    }

    fn insert(
        &mut self,
        fingerprint: ClaudeExecutableFingerprint,
        capabilities: ClaudeCacheableCapabilities,
    ) {
        self.entries
            .retain(|cached, _| cached.path != fingerprint.path);
        self.recency
            .retain(|cached| cached.path != fingerprint.path);
        while self.entries.len() >= CLAUDE_CAPABILITY_CACHE_CAPACITY {
            let Some(oldest) = self.recency.pop_front() else {
                self.entries.clear();
                break;
            };
            self.entries.remove(&oldest);
        }
        self.entries.insert(
            fingerprint.clone(),
            ClaudeCacheEntry {
                capabilities,
                approved_digest: None,
            },
        );
        self.recency.push_back(fingerprint);
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ClaudeExecutableFingerprint {
    path: PathBuf,
    length: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    change_time_seconds: i64,
    #[cfg(unix)]
    change_time_nanoseconds: i64,
}

impl ClaudeExecutableFingerprint {
    fn read(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Some(Self {
            path: path.to_path_buf(),
            length: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(unix)]
            change_time_seconds: metadata.ctime(),
            #[cfg(unix)]
            change_time_nanoseconds: metadata.ctime_nsec(),
        })
    }
}

#[derive(Debug, Default)]
struct ClaudeListenerCounts {
    current: AtomicUsize,
    maximum: AtomicUsize,
}

impl ClaudeListenerCounts {
    fn acquire(self: &Arc<Self>) -> Option<ClaudeListenerLease> {
        let current = self
            .current
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                count.checked_add(1)
            })
            .ok()?
            + 1;
        self.maximum.fetch_max(current, Ordering::AcqRel);
        Some(ClaudeListenerLease {
            counts: self.clone(),
        })
    }
}

#[derive(Debug)]
struct ClaudeListenerLease {
    counts: Arc<ClaudeListenerCounts>,
}

impl Drop for ClaudeListenerLease {
    fn drop(&mut self) {
        let previous = self.counts.current.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "Claude listener count underflow");
    }
}

pub struct ClaudeTerminalObserverFactory {
    probe: Arc<CachedClaudeCapabilityProbe>,
    pinner: Arc<dyn ClaudeExecutablePinner>,
    resolver: Arc<dyn ClaudeInstallResolver>,
    listener_counts: Arc<ClaudeListenerCounts>,
}

impl fmt::Debug for ClaudeTerminalObserverFactory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeTerminalObserverFactory")
            .finish_non_exhaustive()
    }
}

impl ClaudeTerminalObserverFactory {
    #[must_use]
    pub fn new(probe: Arc<CachedClaudeCapabilityProbe>) -> Self {
        Self::with_pinner(probe, Arc::new(NativeClaudeExecutablePinner))
    }

    #[must_use]
    pub fn with_pinner(
        probe: Arc<CachedClaudeCapabilityProbe>,
        pinner: Arc<dyn ClaudeExecutablePinner>,
    ) -> Self {
        Self {
            probe,
            pinner,
            resolver: Arc::new(MiseClaudeInstallResolver),
            listener_counts: Arc::new(ClaudeListenerCounts::default()),
        }
    }

    /// Replaces how the real install behind a multi-call shim is found.
    #[must_use]
    pub fn with_resolver(mut self, resolver: Arc<dyn ClaudeInstallResolver>) -> Self {
        self.resolver = resolver;
        self
    }

    /// Returns current and maximum bound listener counts for black-box integration diagnostics.
    #[doc(hidden)]
    #[must_use]
    pub fn listener_counts_for_integration_test(&self) -> (usize, usize) {
        (
            self.listener_counts.current.load(Ordering::Acquire),
            self.listener_counts.maximum.load(Ordering::Acquire),
        )
    }

    #[must_use]
    pub fn system() -> Self {
        Self::new(Arc::new(CachedClaudeCapabilityProbe::new(Arc::new(
            SystemClaudeCapabilityProbeRunner::default(),
        ))))
    }

    async fn prepare_inner(
        &self,
        input: ProviderTerminalObserverFactoryInput,
    ) -> Option<PreparedTerminalLaunch> {
        #[cfg(not(unix))]
        {
            let _ = input;
            None
        }
        #[cfg(unix)]
        {
            tokio::time::timeout(CLAUDE_PREPARATION_BUDGET, self.prepare_unix(input))
                .await
                .ok()
                .flatten()
        }
    }

    /// The build the terminal will run, and the environment it runs with: the launch's own
    /// executable, or the validated install behind a multi-call shim with its manager's
    /// validated environment. `None` leaves the original command to run unobserved.
    #[cfg(unix)]
    async fn launch_source(
        &self,
        input: &ProviderTerminalObserverFactoryInput,
    ) -> Option<(PathBuf, BTreeMap<String, String>)> {
        let canonical = PathBuf::from(&input.launch.executable);
        if !is_multi_call_shim(&input.invoked_executable, &canonical) {
            return Some((canonical, BTreeMap::new()));
        }
        let resolution = self
            .resolver
            .resolve(ClaudeShimRequest {
                invoked: &input.invoked_executable,
                manager: &canonical,
                cwd: &input.launch.cwd,
                launch_env: &input.launch.launch_env,
                process_attribution: &input.process_attribution,
            })
            .await;
        let Some(resolution) = resolution else {
            note_pass_through("shim_unresolved");
            return None;
        };
        let Some(executable) = validated_install_candidate(&resolution.executable) else {
            note_pass_through("shim_unresolved");
            return None;
        };
        let Some(env) = validated_shim_environment(resolution.env) else {
            note_pass_through("shim_env_rejected");
            return None;
        };
        Some((executable, env))
    }

    #[cfg(unix)]
    async fn prepare_unix(
        &self,
        input: ProviderTerminalObserverFactoryInput,
    ) -> Option<PreparedTerminalLaunch> {
        if unsafe_interactive_settings_args(&input.launch.args) {
            return None;
        }
        let (source, env_overlay) = self.launch_source(&input).await?;
        let source_fingerprint = ClaudeExecutableFingerprint::read(&source)?;
        if source_fingerprint.length > CLAUDE_PIN_SIZE_LIMIT {
            return None;
        }
        let correlation = input.launch.generation.id().simple().to_string();
        let generation_key = input.launch.generation.id().simple().to_string();
        let generation_dir = create_owned_generation_directory(
            &input.runtime_dir,
            &format!("h{}", &generation_key[..16]),
        )
        .ok()?;
        let pinned_executable = generation_dir.join("claude");
        let overlay_path = generation_dir.join("settings.json");
        let preparation_resources = ClaudePreparationResources {
            runtime_dir: input.runtime_dir.clone(),
            generation_dir: generation_dir.clone(),
            armed: true,
        };
        // The pin is generation-scoped: provider self-updates may replace the source for future
        // terminals, while this terminal keeps executing the exact object attested below. It
        // runs off the async runtime and owns the generation's cleanup until it ends, so a
        // preparation that runs out of budget mid-copy stops the copy at its next chunk and
        // removes the partial pin only once nothing writes into it any more.
        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancel_pin_on_drop = CancelOnDrop(cancelled.clone());
        let pinner = self.pinner.clone();
        let pin_source = source.clone();
        let pin_destination = pinned_executable.clone();
        let (mut preparation_resources, pinned) = tokio::task::spawn_blocking(move || {
            let pinned = pinner
                .pin_cancellable(&pin_source, &pin_destination, &cancelled)
                .and_then(|()| restrict_pinned_executable(&pin_destination));
            (preparation_resources, pinned)
        })
        .await
        .ok()?;
        pinned.ok()?;
        let capabilities = self
            .probe
            .probe_pinned(
                &source,
                &source_fingerprint,
                &pinned_executable,
                Some(&input.process_attribution),
            )
            .await;
        if !capabilities.is_some_and(|capabilities| {
            capabilities.additional_settings
                && capabilities.authenticated_http_hooks
                && capabilities.additive_hook_merge
        }) {
            note_pass_through("build_unattested");
            return None;
        }
        let listener = match StdTcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)) {
            Ok(listener) => listener,
            Err(_) => return None,
        };
        if listener.set_nonblocking(true).is_err() {
            return None;
        }
        let address = listener.local_addr().ok()?;
        if !address.ip().is_loopback() {
            return None;
        }
        let token = match random_secret() {
            Some(token) => token,
            None => return None,
        };
        let endpoint = format!("http://{address}/claude-hook");
        let overlay = claude_hook_settings(&endpoint, &token, &correlation);
        if write_private_overlay(&overlay_path, &overlay).is_err() {
            return None;
        }
        let listener_lease = self.listener_counts.acquire()?;
        preparation_resources.armed = false;
        let resources = Arc::new(ClaudeObserverResources {
            listener: Mutex::new(Some((listener, listener_lease))),
            overlay_path: overlay_path.clone(),
            generation_dir,
            runtime_dir: input.runtime_dir.clone(),
            cleaned: AtomicBool::new(false),
        });
        let observer = ClaudePreparedTerminalObserver {
            inner: Arc::new(ClaudeObserverInner {
                resources,
                publisher: input.activity_publisher,
                provider_instance_id: input.launch.activity.provider_instance_id,
                token: Arc::new(token.clone()),
                correlation: Arc::new(correlation),
                spawned: AtomicBool::new(false),
                activity: Arc::new(TerminalAgentActivityControl::with_enabled(
                    input.activity_enabled,
                )),
                listener_lifecycle: AtomicU64::new(pack_claude_listener_lifecycle(
                    ClaudeListenerLifecycle {
                        ready: false,
                        epoch: 0,
                    },
                )),
            }),
        };
        let mut args = input.launch.args;
        args.push("--settings".to_owned());
        args.push(overlay_path.to_string_lossy().into_owned());
        Some(PreparedTerminalLaunch {
            executable: pinned_executable.to_string_lossy().into_owned(),
            args,
            env_overlay,
            private_env: BTreeMap::new(),
            observer: Box::new(observer),
        })
    }
}

/// Sets its flag when dropped, which tells a pin still running off the runtime to stop.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Logs why a Claude Terminal runs unobserved, once per reason. The reason is a fixed word:
/// never a path or an environment value.
fn note_pass_through(reason: &'static str) {
    static NOTED: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    let mut noted = NOTED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if noted.contains(&reason) {
        return;
    }
    noted.push(reason);
    tracing::debug!(status = reason, "Claude terminal runs without status hooks");
}

/// A launch through a multi-call shim: the invoked path is a link whose canonical target is a
/// version manager that dispatches on its invoked name (mise), not a Claude build.
fn is_multi_call_shim(invoked: &Path, canonical: &Path) -> bool {
    invoked != canonical
        && std::fs::symlink_metadata(invoked).is_ok_and(|metadata| metadata.is_symlink())
        && canonical
            .file_name()
            .is_some_and(|name| name == MISE_EXECUTABLE_NAME)
}

/// The real install a shim's manager named, if it is safe to pin: an absolute path to a regular,
/// executable file owned by this user or root, writable by nobody else, and not the manager
/// itself. Returns its canonical path.
#[cfg(unix)]
fn validated_install_candidate(path: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    if !path.is_absolute() || path.as_os_str().len() > SHIM_WHICH_OUTPUT_LIMIT {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    let metadata = std::fs::metadata(&canonical).ok()?;
    let mode = metadata.permissions().mode();
    // SAFETY: `geteuid` has no preconditions and does not dereference memory.
    let effective_user_id = unsafe { libc::geteuid() };
    let owner_trusted = metadata.uid() == effective_user_id || metadata.uid() == 0;
    let not_the_manager = canonical
        .file_name()
        .is_some_and(|name| name != MISE_EXECUTABLE_NAME);
    (metadata.is_file()
        && mode & 0o111 != 0
        && mode & 0o022 == 0
        && owner_trusted
        && not_the_manager
        && metadata.len() <= CLAUDE_PIN_SIZE_LIMIT)
        .then_some(canonical)
}

/// The variables a shim's manager may set for an observed launch: POSIX names and values
/// without NUL, within `SHIM_ENV_OUTPUT_LIMIT` in all. Any variable that changes how the dynamic
/// loader loads code refuses the whole environment, and the shim then runs as configured.
fn validated_shim_environment(env: BTreeMap<String, String>) -> Option<BTreeMap<String, String>> {
    let mut total = 0_usize;
    for (key, value) in &env {
        total = total.saturating_add(key.len()).saturating_add(value.len());
        let valid_name = key
            .bytes()
            .next()
            .is_some_and(|first| first == b'_' || first.is_ascii_alphabetic())
            && key
                .bytes()
                .all(|byte| byte == b'_' || byte.is_ascii_alphanumeric());
        if !valid_name
            || value.contains('\0')
            || loader_override_variable(key)
            || total > SHIM_ENV_OUTPUT_LIMIT
        {
            return None;
        }
    }
    Some(env)
}

fn loader_override_variable(key: &str) -> bool {
    matches!(key, "LD_PRELOAD" | "LD_LIBRARY_PATH" | "LD_AUDIT") || key.starts_with("DYLD_")
}

impl ProviderTerminalObserverFactory for ClaudeTerminalObserverFactory {
    fn requires_private_executable_pin(&self) -> bool {
        true
    }

    fn preparation_budget(&self) -> Duration {
        CLAUDE_PREPARATION_BUDGET
    }

    fn prepare(
        &self,
        input: ProviderTerminalObserverFactoryInput,
    ) -> Pin<Box<dyn Future<Output = Option<PreparedTerminalLaunch>> + Send + '_>> {
        Box::pin(self.prepare_inner(input))
    }
}

#[derive(Debug)]
struct ClaudePreparedTerminalObserver {
    inner: Arc<ClaudeObserverInner>,
}

impl PreparedTerminalObserver for ClaudePreparedTerminalObserver {
    fn on_spawned(
        &self,
        _pid: u32,
        generation: TerminalObserverGenerationLease,
        workers: TerminalObserverWorkerContext,
    ) {
        if self.inner.spawned.swap(true, Ordering::AcqRel) {
            return;
        }
        let listener = self
            .inner
            .resources
            .listener
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let Some((listener, listener_lease)) = listener else {
            publish_claude_listener_unavailable(&self.inner);
            return;
        };
        let inner = self.inner.clone();
        // A refused worker drops the listener and leaves the terminal unobserved. The running
        // process still executes its pinned copy with its settings overlay, so the
        // generation directory stays until the observer's drop when the generation ends.
        if workers
            .spawn(async move {
                run_claude_observer(inner, generation, listener, listener_lease).await;
            })
            .is_err()
        {
            publish_claude_listener_unavailable(&self.inner);
        }
    }

    fn set_agent_activity_enabled(
        &self,
        enabled: bool,
        _generation: TerminalObserverGenerationLease,
        _workers: TerminalObserverWorkerContext,
    ) -> Pin<Box<dyn Future<Output = TerminalAgentActivityTransition> + Send + '_>> {
        Box::pin(async move {
            let (state, mut transition) = self.inner.activity.transition_state(enabled);
            let lifecycle = self.inner.listener_lifecycle_snapshot();
            let kind = lifecycle.observation_kind(state.enabled);
            self.inner
                .activity
                .mark_observed(TerminalAgentActivityObservation {
                    state,
                    epoch: lifecycle.epoch,
                    kind,
                });
            transition.epochs.claude = lifecycle.epoch;
            if kind == TerminalAgentActivityObservationKind::Unavailable {
                transition.failed = transition.failed.saturating_add(1);
                transition.unavailable = transition.unavailable.saturating_add(1);
            }
            transition
        })
    }

    fn diagnostic_label(&self) -> &str {
        "claude-authenticated-http-hooks"
    }
}

struct ClaudeObserverResources {
    listener: Mutex<Option<(StdTcpListener, ClaudeListenerLease)>>,
    overlay_path: PathBuf,
    generation_dir: PathBuf,
    runtime_dir: PathBuf,
    cleaned: AtomicBool,
}

impl ClaudeObserverResources {
    fn cleanup(&self) {
        if self.cleaned.swap(true, Ordering::AcqRel) {
            return;
        }
        self.listener
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        cleanup_owned_generation_directory(&self.runtime_dir, &self.generation_dir);
    }
}

#[derive(Debug)]
struct NativeClaudeExecutablePinner;

impl ClaudeExecutablePinner for NativeClaudeExecutablePinner {
    fn pin(&self, source: &Path, destination: &Path) -> io::Result<()> {
        self.pin_cancellable(source, destination, &AtomicBool::new(false))
    }

    fn pin_cancellable(
        &self,
        source: &Path,
        destination: &Path,
        cancelled: &AtomicBool,
    ) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        {
            let _ = cancelled;
            clone_executable(source, destination)
        }
        #[cfg(target_os = "linux")]
        {
            copy_executable(source, destination, cancelled)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (source, destination, cancelled);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Claude executable pinning is unavailable on this platform",
            ))
        }
    }
}

#[cfg(target_os = "macos")]
fn clone_executable(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source contains NUL"))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "destination contains NUL"))?;
    // SAFETY: both C strings are NUL-terminated and remain alive for the call.
    let result = unsafe { libc::clonefile(source.as_ptr(), destination.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// One step of a pin copy: small enough that a cancelled preparation stops promptly.
#[cfg(any(target_os = "linux", all(test, unix)))]
const CLAUDE_PIN_COPY_CHUNK: usize = 16 * 1024 * 1024;

/// Copies `source` into a new private `destination` (created here, never replaced), chunk by
/// chunk until `cancelled` is set. On Linux each chunk is `copy_file_range`, which reflinks on
/// btrfs, XFS and bcachefs and copies in the kernel elsewhere. The source must keep its identity
/// for the whole copy. Any failure removes the destination.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn copy_executable(source: &Path, destination: &Path, cancelled: &AtomicBool) -> io::Result<()> {
    copy_executable_until(source, destination, &|_copied| {
        cancelled.load(Ordering::Acquire)
    })
}

/// `copy_executable`, asking `stop` with the bytes copied so far before every chunk.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn copy_executable_until(
    source: &Path,
    destination: &Path,
    stop: &dyn Fn(u64) -> bool,
) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut source_file = std::fs::File::open(source)?;
    let before = source_file.metadata()?;
    if !before.is_file() || before.len() > CLAUDE_PIN_SIZE_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Claude pin source is not a bounded regular file",
        ));
    }
    let mut destination_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(destination)?;
    let copied = copy_file_chunks(&mut source_file, &mut destination_file, before.len(), stop)
        .and_then(|()| destination_file.sync_all())
        .and_then(|()| {
            let after = source_file.metadata()?;
            let path_after = std::fs::metadata(source)?;
            if same_file_state(&before, &after) && same_file_state(&before, &path_after) {
                Ok(())
            } else {
                Err(io::Error::other(
                    "Claude pin source changed while it was copied",
                ))
            }
        });
    drop(destination_file);
    if copied.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    copied
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn same_file_state(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn copy_file_chunks(
    source: &mut std::fs::File,
    destination: &mut std::fs::File,
    length: u64,
    stop: &dyn Fn(u64) -> bool,
) -> io::Result<()> {
    let mut remaining = length;
    #[cfg(target_os = "linux")]
    let mut kernel_copy = true;
    let mut buffer = Vec::new();
    while remaining > 0 {
        if stop(length - remaining) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Claude pin cancelled",
            ));
        }
        let chunk = usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(CLAUDE_PIN_COPY_CHUNK);
        #[cfg(target_os = "linux")]
        if kernel_copy {
            use std::os::fd::AsRawFd as _;
            // SAFETY: both descriptors are open for the call; null offsets use and advance each
            // file's own position, as the read/write fallback below does.
            let copied = unsafe {
                libc::copy_file_range(
                    source.as_raw_fd(),
                    std::ptr::null_mut(),
                    destination.as_raw_fd(),
                    std::ptr::null_mut(),
                    chunk,
                    0,
                )
            };
            if copied > 0 {
                remaining -= copied as u64;
                continue;
            }
            if copied == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Claude pin source ended early",
                ));
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EXDEV | libc::ENOSYS | libc::EOPNOTSUPP | libc::EINVAL)
                    if remaining == length =>
                {
                    kernel_copy = false;
                }
                _ => return Err(error),
            }
        }
        use std::io::{Read as _, Write as _};
        buffer.resize(chunk.min(1024 * 1024), 0);
        let read = source.read(&mut buffer)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Claude pin source ended early",
            ));
        }
        destination.write_all(&buffer[..read])?;
        remaining = remaining.saturating_sub(read as u64);
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_pinned_executable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o500))
}

struct ClaudePreparationResources {
    runtime_dir: PathBuf,
    generation_dir: PathBuf,
    armed: bool,
}

impl Drop for ClaudePreparationResources {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        cleanup_owned_generation_directory(&self.runtime_dir, &self.generation_dir);
    }
}

impl fmt::Debug for ClaudeObserverResources {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeObserverResources")
            .field("overlay_path", &self.overlay_path)
            .finish_non_exhaustive()
    }
}

struct ClaudeObserverInner {
    resources: Arc<ClaudeObserverResources>,
    publisher: TerminalGenerationActivityPublisher,
    provider_instance_id: String,
    token: Arc<String>,
    correlation: Arc<String>,
    spawned: AtomicBool,
    activity: Arc<TerminalAgentActivityControl>,
    listener_lifecycle: AtomicU64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ClaudeListenerLifecycle {
    ready: bool,
    epoch: u64,
}

const CLAUDE_LISTENER_READY_BIT: u64 = 1;

fn pack_claude_listener_lifecycle(lifecycle: ClaudeListenerLifecycle) -> u64 {
    (lifecycle.epoch << 1) | u64::from(lifecycle.ready)
}

fn unpack_claude_listener_lifecycle(value: u64) -> ClaudeListenerLifecycle {
    ClaudeListenerLifecycle {
        ready: value & CLAUDE_LISTENER_READY_BIT != 0,
        epoch: value >> 1,
    }
}

impl ClaudeListenerLifecycle {
    fn observation_kind(self, activity_enabled: bool) -> TerminalAgentActivityObservationKind {
        if !self.ready {
            TerminalAgentActivityObservationKind::Unavailable
        } else if activity_enabled {
            TerminalAgentActivityObservationKind::Live
        } else {
            TerminalAgentActivityObservationKind::Dormant
        }
    }
}

impl ClaudeObserverInner {
    fn listener_lifecycle_snapshot(&self) -> ClaudeListenerLifecycle {
        unpack_claude_listener_lifecycle(self.listener_lifecycle.load(Ordering::Acquire))
    }

    fn mark_listener_ready(&self) -> ClaudeListenerLifecycle {
        let mut current = self.listener_lifecycle.load(Ordering::Acquire);
        loop {
            let previous = unpack_claude_listener_lifecycle(current);
            let lifecycle = ClaudeListenerLifecycle {
                ready: true,
                epoch: previous.epoch.wrapping_add(1) & (u64::MAX >> 1),
            };
            match self.listener_lifecycle.compare_exchange_weak(
                current,
                pack_claude_listener_lifecycle(lifecycle),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return lifecycle,
                Err(observed) => current = observed,
            }
        }
    }

    fn mark_listener_unavailable(&self) -> ClaudeListenerLifecycle {
        let previous = self
            .listener_lifecycle
            .fetch_and(!CLAUDE_LISTENER_READY_BIT, Ordering::AcqRel);
        let lifecycle = unpack_claude_listener_lifecycle(previous);
        ClaudeListenerLifecycle {
            ready: false,
            epoch: lifecycle.epoch,
        }
    }
}

impl fmt::Debug for ClaudeObserverInner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeObserverInner")
            .field("resources", &self.resources)
            .field("provider_instance_id", &self.provider_instance_id)
            .finish_non_exhaustive()
    }
}

impl Drop for ClaudeObserverInner {
    fn drop(&mut self) {
        publish_claude_listener_unavailable(self);
        self.resources.cleanup();
    }
}

struct ClaudeHookRequest {
    value: Value,
    admission: TerminalAgentActivityAdmission,
    response: oneshot::Sender<StatusCode>,
}

#[derive(Clone)]
struct ClaudeHookState {
    token: Arc<String>,
    correlation: Arc<String>,
    activity: Arc<TerminalAgentActivityControl>,
    requests: mpsc::Sender<ClaudeHookRequest>,
    request_permits: Arc<Semaphore>,
    /// Where the main agent's state goes, whatever the activity setting says (#187).
    status: TerminalObserverGenerationLease,
    /// The main session the state follows: the first one heard, then each new `SessionStart`
    /// (`/clear` and resume begin a new session).
    status_session: Arc<Mutex<Option<String>>>,
}

async fn run_claude_observer(
    inner: Arc<ClaudeObserverInner>,
    generation: TerminalObserverGenerationLease,
    listener: StdTcpListener,
    _listener_lease: ClaudeListenerLease,
) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        // The process still runs its pinned copy: the observer's drop removes the generation.
        publish_claude_listener_unavailable(&inner);
        return;
    };
    let lifecycle = inner.mark_listener_ready();
    let state = inner.activity.snapshot();
    inner
        .activity
        .mark_observed(TerminalAgentActivityObservation {
            state,
            epoch: lifecycle.epoch,
            kind: lifecycle.observation_kind(state.enabled),
        });
    let (request_sender, request_receiver) = mpsc::channel(CLAUDE_HOOK_QUEUE_CAPACITY);
    let state = ClaudeHookState {
        token: inner.token.clone(),
        correlation: inner.correlation.clone(),
        activity: inner.activity.clone(),
        requests: request_sender,
        request_permits: Arc::new(Semaphore::new(CLAUDE_HOOK_REQUEST_CAPACITY)),
        status: generation.clone(),
        status_session: Arc::new(Mutex::new(None)),
    };
    let router = Router::new()
        .route("/claude-hook", post(capture_claude_hook))
        .with_state(state);
    let server = Box::pin(async move {
        let _ = axum::serve(listener, router).into_future().await;
    });
    drive_claude_observer(inner, generation, request_receiver, server).await;
}

async fn drive_claude_observer(
    inner: Arc<ClaudeObserverInner>,
    generation: TerminalObserverGenerationLease,
    mut request_receiver: mpsc::Receiver<ClaudeHookRequest>,
    mut server: Pin<Box<dyn Future<Output = ()> + Send>>,
) {
    let mut root_session_id: Option<String> = None;
    let mut tracker: Option<ClaudeActivityTracker> = None;
    let mut event_sequence = 0_u64;
    let mut active_actors = HashMap::<String, ActivityActorSummary>::new();
    let mut active_work_items = HashMap::<String, ActivityWorkItemSummary>::new();
    loop {
        tokio::select! {
            biased;
            _ = generation.cancelled() => {
                break;
            },
            request = request_receiver.recv() => {
                let Some(request) = request else { break; };
                let ClaudeHookRequest {
                    value,
                    admission,
                    response,
                } = request;
                let status = process_claude_hook(
                    &inner,
                    &generation,
                    &mut root_session_id,
                    &mut tracker,
                    &mut event_sequence,
                    &mut active_actors,
                    &mut active_work_items,
                    value,
                    admission,
                ).await;
                let _ = response.send(status);
            }
            () = &mut server => {
                break;
            }
        }
    }
    publish_claude_listener_unavailable(&inner);
    interrupt_claude_activity(&inner, &active_actors, &active_work_items, event_sequence).await;
    // A hook server that ended on its own leaves the process running its pinned copy with its
    // settings overlay: only an ended generation removes them now, otherwise the observer's
    // drop does when the generation ends.
    if generation.cancellation_reason().is_some() {
        inner.resources.cleanup();
    }
}

fn publish_claude_listener_unavailable(inner: &ClaudeObserverInner) {
    let lifecycle = inner.mark_listener_unavailable();
    let state = inner.activity.snapshot();
    inner
        .activity
        .mark_observed(TerminalAgentActivityObservation {
            state,
            epoch: lifecycle.epoch,
            kind: lifecycle.observation_kind(state.enabled),
        });
}

#[allow(clippy::too_many_arguments)]
async fn process_claude_hook(
    inner: &ClaudeObserverInner,
    generation: &TerminalObserverGenerationLease,
    root_session_id: &mut Option<String>,
    tracker: &mut Option<ClaudeActivityTracker>,
    event_sequence: &mut u64,
    active_actors: &mut HashMap<String, ActivityActorSummary>,
    active_work_items: &mut HashMap<String, ActivityWorkItemSummary>,
    value: Value,
    admission: TerminalAgentActivityAdmission,
) -> StatusCode {
    if !inner.activity.admission_is_current(&admission) {
        return StatusCode::NO_CONTENT;
    }
    let Some(session_id) = validate_claude_hook(&value) else {
        return StatusCode::BAD_REQUEST;
    };
    if let Some(root) = root_session_id.as_deref() {
        if root != session_id {
            return StatusCode::CONFLICT;
        }
    } else {
        let capabilities = ActivityCapabilities {
            actors: true,
            attributed_activity: true,
            background_work: false,
            history_recovery: ActivityHistoryRecovery::None,
            terminal_observation: true,
            targeted_actor_cancellation: false,
        };
        if !inner.activity.admission_is_current(&admission) {
            return StatusCode::NO_CONTENT;
        }
        let published = inner
            .publisher
            .publish_correlated("claude", Some(&inner.provider_instance_id), capabilities)
            .await
            .unwrap_or(false);
        if !inner.activity.admission_is_current(&admission) {
            return StatusCode::NO_CONTENT;
        }
        if !published {
            return StatusCode::GONE;
        }
        if !inner.activity.admission_is_current(&admission) {
            return StatusCode::NO_CONTENT;
        }
        *root_session_id = Some(session_id.to_owned());
        *tracker = Some(ClaudeActivityTracker::new(session_id));
    }
    let recovery_request = value
        .get("agent_id")
        .and_then(Value::as_str)
        .and_then(|agent_id| {
            let tracker = tracker
                .as_ref()
                .expect("tracker is installed with root correlation");
            ClaudeTranscriptRecoveryRequest::from_authenticated_hook(
                &value,
                tracker.is_correlated_actor(session_id, agent_id),
            )
        });
    let mut staged_tracker = tracker
        .as_ref()
        .expect("tracker is installed with root correlation")
        .clone();
    let output = staged_tracker.handle_value(
        ClaudeActivityInputSource::HookInput,
        &value,
        current_unix_millis(),
    );
    if !output.mutations.is_empty() {
        let native_event_key = format!("claude:terminal-hook:{event_sequence}");
        if !inner.activity.admission_is_current(&admission) {
            return StatusCode::NO_CONTENT;
        }
        let applied = inner
            .publisher
            .apply(
                &native_event_key,
                output.mutations.clone(),
                &current_timestamp(),
            )
            .await;
        if !inner.activity.admission_is_current(&admission) {
            return StatusCode::NO_CONTENT;
        }
        if !matches!(applied, Ok(ref deltas) if !deltas.is_empty()) {
            return StatusCode::GONE;
        }
        if !inner.activity.admission_is_current(&admission) {
            return StatusCode::NO_CONTENT;
        }
        retain_active_claude_activity(&output.mutations, active_actors, active_work_items);
        *event_sequence = event_sequence.saturating_add(1);
    }
    if !inner.activity.admission_is_current(&admission) {
        return StatusCode::NO_CONTENT;
    }
    *tracker = Some(staged_tracker);
    if let Some(request) = recovery_request {
        let cancellation = CancellationToken::new();
        let recovered = match await_claude_recovery_while_current(
            &inner.activity,
            generation,
            cancellation.clone(),
            recover_transcript(request, cancellation),
        )
        .await
        {
            Ok(recovered) => recovered,
            Err(status) => return status,
        };
        if let Some(recovered) = recovered {
            if !inner.activity.admission_is_current(&admission) {
                return StatusCode::NO_CONTENT;
            }
            let mut staged_tracker = tracker
                .as_ref()
                .expect("tracker is installed with root correlation")
                .clone();
            let output = staged_tracker.handle_recovered_records(
                &recovered.agent_id,
                &recovered.agent_type,
                &recovered.records,
            );
            let mut mutations = output.mutations;
            mutations.push(ProviderActivityMutation::SetScope {
                capabilities: ActivityCapabilities {
                    actors: true,
                    attributed_activity: true,
                    background_work: false,
                    history_recovery: ActivityHistoryRecovery::Bounded,
                    terminal_observation: true,
                    targeted_actor_cancellation: false,
                },
                observation_state: ActivityObservationState::Live,
            });
            if !inner.activity.admission_is_current(&admission) {
                return StatusCode::NO_CONTENT;
            }
            let applied = inner
                .publisher
                .apply(
                    &recovered.native_event_id,
                    mutations.clone(),
                    &current_timestamp(),
                )
                .await;
            if !inner.activity.admission_is_current(&admission) {
                return StatusCode::NO_CONTENT;
            }
            if !matches!(applied, Ok(ref deltas) if !deltas.is_empty()) {
                return StatusCode::GONE;
            }
            if !inner.activity.admission_is_current(&admission) {
                return StatusCode::NO_CONTENT;
            }
            retain_active_claude_activity(&mutations, active_actors, active_work_items);
            if !inner.activity.admission_is_current(&admission) {
                return StatusCode::NO_CONTENT;
            }
            *tracker = Some(staged_tracker);
        }
    }
    StatusCode::NO_CONTENT
}

async fn await_claude_recovery_while_current<T>(
    activity: &TerminalAgentActivityControl,
    generation: &TerminalObserverGenerationLease,
    cancellation: CancellationToken,
    recovery: impl Future<Output = T>,
) -> Result<T, StatusCode> {
    let mut activity_changes = activity.subscribe();
    tokio::select! {
        recovered = recovery => Ok(recovered),
        _ = activity_changes.changed() => {
            cancellation.cancel();
            Err(StatusCode::NO_CONTENT)
        }
        _ = generation.cancelled() => {
            cancellation.cancel();
            Err(StatusCode::GONE)
        }
    }
}

fn retain_active_claude_activity(
    mutations: &[ProviderActivityMutation],
    active_actors: &mut HashMap<String, ActivityActorSummary>,
    active_work_items: &mut HashMap<String, ActivityWorkItemSummary>,
) {
    for mutation in mutations {
        match mutation {
            ProviderActivityMutation::UpsertActor(actor) => {
                if actor.status.is_terminal() {
                    active_actors.remove(&actor.id);
                } else {
                    active_actors.insert(actor.id.clone(), actor.clone());
                }
            }
            ProviderActivityMutation::RemoveActor { actor_id } => {
                active_actors.remove(actor_id);
            }
            ProviderActivityMutation::UpsertWorkItem(work_item) => {
                if work_item.status.is_terminal() {
                    active_work_items.remove(&work_item.id);
                } else {
                    active_work_items.insert(work_item.id.clone(), work_item.clone());
                }
            }
            ProviderActivityMutation::RemoveWorkItem { work_item_id } => {
                active_work_items.remove(work_item_id);
            }
            ProviderActivityMutation::SetScope { .. }
            | ProviderActivityMutation::SetSectionHealth { .. }
            | ProviderActivityMutation::AppendEntry(_) => {}
        }
    }
}

async fn interrupt_claude_activity(
    inner: &ClaudeObserverInner,
    active_actors: &HashMap<String, ActivityActorSummary>,
    active_work_items: &HashMap<String, ActivityWorkItemSummary>,
    event_sequence: u64,
) {
    let Some(admission) = inner.activity.admit() else {
        return;
    };
    let mut mutations = active_actors
        .keys()
        .filter_map(|actor_id| {
            ProviderActivityMutation::set_actor_status(actor_id.clone(), "interrupted").ok()
        })
        .collect::<Vec<_>>();
    let now = current_timestamp();
    mutations.extend(active_work_items.values().cloned().map(|mut work_item| {
        work_item.status = ActivityLifecycle::Interrupted;
        work_item.updated_at = now.clone();
        work_item.terminal_at = Some(now.clone());
        ProviderActivityMutation::UpsertWorkItem(work_item)
    }));
    if mutations.is_empty() {
        return;
    }
    if !inner.activity.admission_is_current(&admission) {
        return;
    }
    let _ = inner
        .publisher
        .apply(
            &format!("claude:terminal-interrupted:{event_sequence}"),
            mutations,
            &now,
        )
        .await;
}

async fn capture_claude_hook(
    State(state): State<ClaudeHookState>,
    headers: HeaderMap,
    body: Body,
) -> impl IntoResponse {
    let Ok(_permit) = state.request_permits.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    if !authorized(&headers, &state.token, &state.correlation) {
        return StatusCode::FORBIDDEN;
    }
    // Activity admission is taken before the body arrives, so a body that spans a disable and
    // re-enable never creates activity under the new admission.
    let admission = state.activity.admit();
    if !headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE;
    }
    let Ok(Ok(bytes)) = tokio::time::timeout(
        CLAUDE_HOOK_BODY_TIMEOUT,
        to_bytes(body, CLAUDE_HOOK_BODY_LIMIT),
    )
    .await
    else {
        return StatusCode::PAYLOAD_TOO_LARGE;
    };
    // Only live activity reports malformed input; a dormant observer acknowledges it, as it did
    // before it read bodies for the agent's status.
    let rejected = || {
        if admission
            .as_ref()
            .is_some_and(|admission| state.activity.admission_is_current(admission))
        {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::NO_CONTENT
        }
    };
    // The main agent's state is published whatever the activity setting says (#187). It reads
    // only the fields that state needs: a hook only activity would read is decoded whole only
    // while activity is live, so status alone never reads prompt or tool content.
    let Ok(hook) = serde_json::from_slice::<ClaudeStatusHook>(&bytes) else {
        return rejected();
    };
    publish_claude_hook_status(&state, &hook);
    if hook
        .hook_event_name
        .as_deref()
        .is_some_and(|event| CLAUDE_STATUS_HOOK_EVENTS.contains(&event))
    {
        return StatusCode::NO_CONTENT;
    }
    let Some(admission) = admission else {
        return StatusCode::NO_CONTENT;
    };
    if !state.activity.admission_is_current(&admission) {
        return StatusCode::NO_CONTENT;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return StatusCode::BAD_REQUEST;
    };
    let (response, receiver) = oneshot::channel();
    if state
        .requests
        .try_send(ClaudeHookRequest {
            value,
            admission,
            response,
        })
        .is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE;
    }
    tokio::time::timeout(CLAUDE_HOOK_RESPONSE_TIMEOUT, receiver)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(StatusCode::SERVICE_UNAVAILABLE)
}

fn authorized(headers: &HeaderMap, expected_token: &str, expected_correlation: &str) -> bool {
    let Some(token) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    let Some(correlation) = headers
        .get(CLAUDE_HOOK_CORRELATION_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    constant_time_equal(token, expected_token)
        && constant_time_equal(correlation, expected_correlation)
}

fn constant_time_equal(provided: &str, expected: &str) -> bool {
    provided.len() == expected.len() && bool::from(provided.as_bytes().ct_eq(expected.as_bytes()))
}

fn claude_hook_settings(endpoint: &str, token: &str, correlation: &str) -> Value {
    let handler = json!({
        "type": "http",
        "url": endpoint,
        "timeout": 1,
        "headers": {
            "Authorization": format!("Bearer {token}"),
            CLAUDE_HOOK_CORRELATION_HEADER: correlation,
        },
    });
    let hook = || json!([{ "hooks": [handler.clone()] }]);
    json!({
        "hooks": {
            "SubagentStart": hook(),
            "SubagentStop": hook(),
            "PreToolUse": hook(),
            "PostToolUse": hook(),
            "PostToolUseFailure": hook(),
            // The main agent's state for the left panel (#187): read only, never answered.
            "SessionStart": hook(),
            "UserPromptSubmit": hook(),
            "PermissionRequest": hook(),
            "Notification": hook(),
            "Elicitation": hook(),
            "ElicitationResult": hook(),
            "Stop": hook(),
            "StopFailure": hook(),
            "SessionEnd": hook(),
        }
    })
}

/// The hooks registered only for the main agent's state: the activity worker never sees them.
const CLAUDE_STATUS_HOOK_EVENTS: [&str; 9] = [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "Elicitation",
    "ElicitationResult",
    "Stop",
    "StopFailure",
    "SessionEnd",
];

/// The few fields of a Claude hook the main agent's state reads (#187); serde skips the rest,
/// prompt, message and tool content included.
#[derive(Debug, Default, serde::Deserialize)]
struct ClaudeStatusHook {
    #[serde(default)]
    hook_event_name: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    /// Present on a subagent's own hooks.
    #[serde(default)]
    agent_id: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    notification_type: Option<String>,
}

/// What one Claude hook says about the main agent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClaudeAgentReport {
    Set(TerminalAgentState, bool),
    /// A subagent's tool finished: an approval it waited on was answered.
    ToolFinished,
}

/// Publishes the main agent's state a hook reports, for the main session only.
fn publish_claude_hook_status(state: &ClaudeHookState, hook: &ClaudeStatusHook) {
    let Some(report) = claude_hook_agent_status(hook) else {
        return;
    };
    let Some(session_id) = safe_text(hook.session_id.as_deref()) else {
        return;
    };
    {
        let mut bound = state
            .status_session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match bound.as_deref() {
            Some(root) if root == session_id => {}
            Some(_) if hook.hook_event_name.as_deref() != Some("SessionStart") => return,
            _ => *bound = Some(session_id.to_owned()),
        }
    }
    match report {
        ClaudeAgentReport::Set(agent_state, failed) => {
            state.status.publish_agent_status(agent_state, failed);
        }
        ClaudeAgentReport::ToolFinished => {
            state
                .status
                .publish_agent_status_if(TerminalAgentState::Working, false, |current| {
                    current == Some(TerminalAgentState::Blocked)
                })
        }
    }
}

/// The main agent's state a Claude hook reports, for the left panel (#187). A subagent's own
/// tool hooks carry its `agent_id` and leave the main state alone, except that its finished
/// tool ends an approval prompt; a permission prompt blocks the user whoever asks. Only the
/// event name, the tool name and the notification type are read.
fn claude_hook_agent_status(hook: &ClaudeStatusHook) -> Option<ClaudeAgentReport> {
    let event = safe_text(hook.hook_event_name.as_deref())?;
    safe_text(hook.session_id.as_deref())?;
    let main_agent = hook.agent_id.is_none();
    let set = |state, failed| Some(ClaudeAgentReport::Set(state, failed));
    match event {
        "SessionStart" | "Stop" | "SessionEnd" => set(TerminalAgentState::Done, false),
        "StopFailure" => set(TerminalAgentState::Done, true),
        "UserPromptSubmit" | "ElicitationResult" => set(TerminalAgentState::Working, false),
        "PermissionRequest" => set(TerminalAgentState::Blocked, false),
        "Elicitation" => set(TerminalAgentState::Waiting, false),
        "PreToolUse" if main_agent => {
            if safe_text(hook.tool_name.as_deref())? == "AskUserQuestion" {
                set(TerminalAgentState::Waiting, false)
            } else {
                set(TerminalAgentState::Working, false)
            }
        }
        "PostToolUse" | "PostToolUseFailure" if main_agent => {
            set(TerminalAgentState::Working, false)
        }
        "PostToolUse" | "PostToolUseFailure" => Some(ClaudeAgentReport::ToolFinished),
        "Notification" => match safe_text(hook.notification_type.as_deref())? {
            "permission_prompt" => set(TerminalAgentState::Blocked, false),
            "elicitation_dialog" => set(TerminalAgentState::Waiting, false),
            // Claude has waited on the user's next prompt for a while.
            "idle_prompt" => set(TerminalAgentState::Done, false),
            _ => None,
        },
        _ => None,
    }
}

fn unsafe_interactive_settings_args(args: &[String]) -> bool {
    args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--settings" | "--setting-sources" | "--safe-mode" | "--bare"
        ) || arg.starts_with("--settings=")
            || arg.starts_with("--setting-sources=")
    })
}

fn safe_identity_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    safe_text(value.get(field).and_then(Value::as_str))
}

fn safe_text(value: Option<&str>) -> Option<&str> {
    value.filter(|value| {
        !value.is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
    })
}

fn validate_claude_hook(value: &Value) -> Option<&str> {
    let event = safe_identity_field(value, "hook_event_name")?;
    let session_id = safe_identity_field(value, "session_id")?;
    let transcript_path = safe_absolute_path_field(value, "transcript_path")?;
    if transcript_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("jsonl")
    {
        return None;
    }
    safe_absolute_path_field(value, "cwd")?;
    match event {
        "SubagentStart" => {
            safe_identity_field(value, "agent_id")?;
            safe_identity_field(value, "agent_type")?;
        }
        "SubagentStop" => {
            safe_identity_field(value, "agent_id")?;
            safe_identity_field(value, "agent_type")?;
            value.get("stop_hook_active")?.as_bool()?;
            let agent_transcript_path = safe_absolute_path_field(value, "agent_transcript_path")?;
            if agent_transcript_path
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("jsonl")
            {
                return None;
            }
            bounded_text_field(value, "last_assistant_message")?;
        }
        "PreToolUse" => {
            validate_tool_hook(value)?;
            bounded_object_field(value, "tool_input")?;
        }
        "PostToolUse" => {
            validate_tool_hook(value)?;
            bounded_object_field(value, "tool_input")?;
            bounded_json_field(value, "tool_response")?;
            validate_optional_duration(value)?;
        }
        "PostToolUseFailure" => {
            validate_tool_hook(value)?;
            bounded_object_field(value, "tool_input")?;
            bounded_text_field(value, "error")?;
            if value
                .get("is_interrupt")
                .is_some_and(|value| !value.is_boolean())
            {
                return None;
            }
            validate_optional_duration(value)?;
        }
        _ => return None,
    }
    Some(session_id)
}

fn validate_tool_hook(value: &Value) -> Option<()> {
    safe_identity_field(value, "tool_name")?;
    safe_identity_field(value, "tool_use_id")?;
    validate_optional_identity(value, "agent_id")?;
    validate_optional_identity(value, "agent_type")?;
    Some(())
}

fn validate_optional_identity(value: &Value, field: &str) -> Option<()> {
    if value.get(field).is_some() {
        safe_identity_field(value, field)?;
    }
    Some(())
}

fn validate_optional_duration(value: &Value) -> Option<()> {
    if value.get("duration_ms").is_some_and(|value| {
        !value
            .as_u64()
            .is_some_and(|duration| duration <= 86_400_000)
    }) {
        return None;
    }
    Some(())
}

fn safe_absolute_path_field(value: &Value, field: &str) -> Option<PathBuf> {
    let path = value.get(field)?.as_str()?;
    if path.is_empty() || path.len() > CLAUDE_HOOK_PATH_LIMIT || path.chars().any(char::is_control)
    {
        return None;
    }
    let path = PathBuf::from(path);
    path.is_absolute().then_some(path)
}

fn bounded_text_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)?
        .as_str()
        .filter(|text| text.len() <= CLAUDE_HOOK_TEXT_LIMIT)
}

fn bounded_object_field<'a>(
    value: &'a Value,
    field: &str,
) -> Option<&'a serde_json::Map<String, Value>> {
    let object = value.get(field)?.as_object()?;
    (serde_json::to_vec(object).ok()?.len() <= CLAUDE_HOOK_OBJECT_LIMIT).then_some(object)
}

fn bounded_json_field<'a>(value: &'a Value, field: &str) -> Option<&'a Value> {
    let field = value.get(field)?;
    (serde_json::to_vec(field).ok()?.len() <= CLAUDE_HOOK_OBJECT_LIMIT).then_some(field)
}

fn random_secret() -> Option<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Debug)]
struct ApprovedClaudeAdditiveHookAttestor;

impl ClaudeAdditiveHookAttestor for ApprovedClaudeAdditiveHookAttestor {
    fn prove(
        &self,
        executable: &Path,
        version: &str,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        let executable = executable.to_path_buf();
        let version = version.to_owned();
        Box::pin(async move { approved_additive_hook_build(&executable, &version, None).await })
    }

    fn prove_attributed<'a>(
        &'a self,
        executable: &'a Path,
        version: &'a str,
        process_attribution: Option<&'a ProcessAttributionRegistry>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(approved_additive_hook_build(
            executable,
            version,
            process_attribution,
        ))
    }
}

/// A build in the approved range and, on macOS, signed by Anthropic. Linux builds carry no
/// signature of their own (Anthropic signs a release manifest instead), so on Linux the build's
/// own `(Claude Code)` version line is trusted, as the chat path trusts it. Every other platform
/// fails closed.
async fn approved_additive_hook_build(
    executable: &Path,
    version: &str,
    process_attribution: Option<&ProcessAttributionRegistry>,
) -> bool {
    if !additive_hook_version(version)
        || !std::fs::metadata(executable).is_ok_and(|metadata| metadata.is_file())
    {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        anthropic_signed_build(executable, process_attribution).await
    }
    #[cfg(target_os = "linux")]
    {
        let _ = process_attribution;
        true
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = process_attribution;
        false
    }
}

#[cfg(target_os = "macos")]
async fn anthropic_signed_build(
    executable: &Path,
    process_attribution: Option<&ProcessAttributionRegistry>,
) -> bool {
    let mut command = tokio::process::Command::new("/usr/bin/codesign");
    command
        .arg("--verify")
        .arg("--strict")
        .arg(format!("-R={ANTHROPIC_CODE_REQUIREMENT}"))
        .arg(executable);
    run_attributed_helper(
        command,
        "claude-codesign-verify",
        CODESIGN_VERIFY_TIMEOUT,
        16 * 1024,
        process_attribution,
    )
    .await
    .is_some_and(|output| output.success)
}

/// Runs a short helper (codesign, mise) under supervision: bounded output, a timeout, and the
/// process group killed and reaped. While it runs it is attributed to BiBCode, so the Profiler
/// samples it as BiBCode's own child.
async fn run_attributed_helper(
    mut command: tokio::process::Command,
    label: &'static str,
    timeout: Duration,
    max_output_bytes: usize,
    process_attribution: Option<&ProcessAttributionRegistry>,
) -> Option<ClaudeProbeOutput> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let registration: Arc<Mutex<Option<ProcessRegistration>>> = Arc::default();
    let slot = registration.clone();
    let registry = process_attribution.cloned();
    let output = run_supervised_with_spawn_observer(
        SupervisedRunRequest {
            command,
            stdin: None,
            timeout,
            cleanup_timeout: Duration::from_millis(500),
            max_output_bytes,
            overflow: SupervisedOverflow::Error,
        },
        &CancellationToken::new(),
        move |process_id| {
            let Some(registry) = registry else {
                return;
            };
            let Some(identity) =
                process_id.and_then(|pid| NativeProcessSampler::process_identity(pid).ok())
            else {
                return;
            };
            if let Ok(registered) = registry.register_identity(
                identity,
                ProcessRegistrationMetadata {
                    scope: AttributionScope::External,
                    kind: AttributionKind::Helper,
                    label: label.to_owned(),
                    source: RegistrationSource::Helper,
                    driver: None,
                    survives_shutdown: false,
                },
            ) {
                *slot
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(registered);
            }
        },
    )
    .await;
    // The child is reaped by now: its attribution ends with it.
    drop(registration);
    let output = output.ok()?;
    Some(ClaudeProbeOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr.bytes).into_owned(),
    })
}

/// The SHA-256 of a whole file, with CommonCrypto over a read-only mapping (0.1 s for a 276 MB
/// build, in debug builds too). Runs on a blocking thread.
#[cfg(target_os = "macos")]
fn sha256_file(path: &Path) -> io::Result<[u8; 32]> {
    use std::os::fd::AsRawFd as _;

    let file = std::fs::File::open(path)?;
    let length = file.metadata()?.len();
    let length = u32::try_from(length)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "executable is too large"))?;
    if length == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "executable is empty",
        ));
    }
    // SAFETY: the file remains open for the mapping lifetime; the mapping is read-only,
    // private, and bounded by the inspected file length.
    let mapping = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            length as usize,
            libc::PROT_READ,
            libc::MAP_PRIVATE,
            file.as_raw_fd(),
            0,
        )
    };
    if mapping == libc::MAP_FAILED {
        return Err(io::Error::last_os_error());
    }
    struct Mapping {
        address: *mut libc::c_void,
        length: usize,
    }
    impl Drop for Mapping {
        fn drop(&mut self) {
            // SAFETY: this is the exact live mapping created above.
            let _ = unsafe { libc::munmap(self.address, self.length) };
        }
    }
    let mapping = Mapping {
        address: mapping,
        length: length as usize,
    };
    let mut digest = [0_u8; 32];
    // SAFETY: CommonCrypto reads `length` bytes of the live mapping and writes the 32-byte
    // digest output. Both remain live for the call.
    let result = unsafe { CC_SHA256(mapping.address.cast_const(), length, digest.as_mut_ptr()) };
    if result.is_null() {
        return Err(io::Error::other("CommonCrypto SHA-256 failed"));
    }
    Ok(digest)
}

#[cfg(target_os = "macos")]
#[link(name = "System")]
unsafe extern "C" {
    fn CC_SHA256(
        data: *const libc::c_void,
        length: u32,
        digest: *mut libc::c_uchar,
    ) -> *mut libc::c_uchar;
}

/// The SHA-256 of a whole file, read in 4 MiB steps. Runs on a blocking thread.
#[cfg(not(target_os = "macos"))]
fn sha256_file(path: &Path) -> io::Result<[u8; 32]> {
    use sha2::{Digest as _, Sha256};
    use std::io::Read as _;

    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

/// mise's multi-call binary: a shim links to it and it dispatches on the invoked name.
const MISE_EXECUTABLE_NAME: &str = "mise";
const SHIM_WHICH_OUTPUT_LIMIT: usize = 4 * 1024;
const SHIM_ENV_OUTPUT_LIMIT: usize = 64 * 1024;
/// Each mise answer takes 5 to 70 ms on a cold Linux lab disk.
const SHIM_COMMAND_TIMEOUT: Duration = Duration::from_millis(750);

/// Asks mise, with the launch's directory and environment, what its shim would run and with
/// which environment. mise resolves both per directory. `which` and `env` run one after the
/// other between two readings of the mise configuration files that can apply to the
/// directory, and the pair is retried once if a file changed in between.
#[derive(Debug, Default)]
pub struct MiseClaudeInstallResolver;

impl ClaudeInstallResolver for MiseClaudeInstallResolver {
    fn resolve<'a>(
        &'a self,
        request: ClaudeShimRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Option<ClaudeShimResolution>> + Send + 'a>> {
        #[cfg(unix)]
        {
            Box::pin(resolve_through_mise(request))
        }
        #[cfg(not(unix))]
        {
            let _ = request;
            Box::pin(std::future::ready(None))
        }
    }
}

#[cfg(unix)]
async fn resolve_through_mise(request: ClaudeShimRequest<'_>) -> Option<ClaudeShimResolution> {
    let bin = request.invoked.file_name()?.to_str()?.to_owned();
    for _attempt in 0..2 {
        let before = mise_config_fingerprint(request.cwd, request.launch_env);
        let which = run_mise(&request, &["which", &bin], SHIM_WHICH_OUTPUT_LIMIT).await?;
        let env = run_mise(&request, &["env", "--json"], SHIM_ENV_OUTPUT_LIMIT).await?;
        if mise_config_fingerprint(request.cwd, request.launch_env) != before {
            continue;
        }
        return Some(ClaudeShimResolution {
            executable: parse_mise_which(&which)?,
            env: parse_mise_env(&env)?,
        });
    }
    None
}

#[cfg(unix)]
async fn run_mise(
    request: &ClaudeShimRequest<'_>,
    args: &[&str],
    max_output_bytes: usize,
) -> Option<String> {
    let mut command = tokio::process::Command::new(request.manager);
    command.args(args).current_dir(request.cwd);
    crate::provider::environment::sanitize_provider_subprocess_environment(&mut command);
    command.envs(request.launch_env);
    let output = run_attributed_helper(
        command,
        "mise-shim-resolution",
        SHIM_COMMAND_TIMEOUT,
        max_output_bytes,
        Some(request.process_attribution),
    )
    .await?;
    output.success.then_some(output.stdout)
}

fn parse_mise_which(output: &str) -> Option<PathBuf> {
    let line = output.strip_suffix('\n').unwrap_or(output);
    if line.is_empty() || line.contains(['\n', '\r', '\0']) || line.len() > SHIM_WHICH_OUTPUT_LIMIT
    {
        return None;
    }
    let path = PathBuf::from(line);
    path.is_absolute().then_some(path)
}

fn parse_mise_env(output: &str) -> Option<BTreeMap<String, String>> {
    if output.len() > SHIM_ENV_OUTPUT_LIMIT {
        return None;
    }
    serde_json::from_str(output).ok()
}

/// A configuration file's device, inode, and modification and change times (s, ns).
#[cfg(unix)]
type MiseConfigStamp = (u64, u64, i64, i64, i64, i64);

/// The identity of every mise configuration file that can apply to `cwd`: the project files in
/// `cwd` and each parent, the global files, and the system file. A missing file is part of the
/// reading too, so creating one counts as a change. Files mise reads from elsewhere (an
/// `MISE_ENV` profile, an include) are not covered; see "Claude Terminal behind a shim" in
/// docs/providers/claude.md.
#[cfg(unix)]
fn mise_config_fingerprint(
    cwd: &Path,
    launch_env: &BTreeMap<String, String>,
) -> Vec<Option<MiseConfigStamp>> {
    use std::os::unix::fs::MetadataExt;

    const PROJECT_FILES: [&str; 10] = [
        "mise.toml",
        "mise.local.toml",
        ".mise.toml",
        ".mise.local.toml",
        ".mise/config.toml",
        "mise/config.toml",
        ".config/mise.toml",
        ".config/mise/config.toml",
        ".config/mise/config.local.toml",
        ".tool-versions",
    ];
    let variable = |key: &str| {
        launch_env
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    let mut files: Vec<PathBuf> = cwd
        .ancestors()
        .flat_map(|directory| PROJECT_FILES.iter().map(|file| directory.join(file)))
        .collect();
    let config_dir = variable("MISE_CONFIG_DIR")
        .or_else(|| variable("XDG_CONFIG_HOME").map(|base| base.join("mise")))
        .or_else(|| variable("HOME").map(|home| home.join(".config/mise")));
    if let Some(config_dir) = config_dir {
        files.push(config_dir.join("config.toml"));
        files.push(config_dir.join("config.local.toml"));
    }
    files.extend(variable("MISE_GLOBAL_CONFIG_FILE"));
    files.push(PathBuf::from("/etc/mise/config.toml"));
    files
        .iter()
        .map(|file| {
            std::fs::metadata(file).ok().map(|metadata| {
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.mtime(),
                    metadata.mtime_nsec(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            })
        })
        .collect()
}

#[cfg(unix)]
fn write_private_overlay(path: &Path, value: &Value) -> io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    serde_json::to_writer(&mut file, value).map_err(io::Error::other)?;
    file.flush()?;
    file.sync_all()
}

/// The version on the line that ends in Claude Code's `(Claude Code)` marker, such as
/// `2.1.312 (Claude Code)`. Output without the marker, such as mise's
/// `2026.10.19 macos-arm64 (2026-10-19)`, is not a Claude version.
fn parse_claude_version(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (before, _) = line.split_once(CLAUDE_VERSION_MARKER)?;
        let candidate = before.split_whitespace().last()?.trim_start_matches('v');
        parse_version_tuple(candidate).map(|_| candidate.to_owned())
    })
}

fn parse_version_tuple(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    (parts.next().is_none()).then_some((major, minor, patch))
}

fn bounded_probe_text(stdout: &str, stderr: &str) -> String {
    let mut output = String::with_capacity(
        stdout
            .len()
            .saturating_add(stderr.len())
            .min(CLAUDE_PROBE_OUTPUT_LIMIT),
    );
    for value in [stdout, stderr] {
        let remaining = CLAUDE_PROBE_OUTPUT_LIMIT.saturating_sub(output.len());
        if remaining == 0 {
            break;
        }
        let boundary = value
            .char_indices()
            .map(|(index, _)| index)
            .take_while(|index| *index <= remaining)
            .last()
            .unwrap_or(0);
        let end = if value.len() <= remaining {
            value.len()
        } else {
            boundary
        };
        output.push_str(&value[..end]);
        if output.len() < CLAUDE_PROBE_OUTPUT_LIMIT {
            output.push('\n');
        }
    }
    output
}

fn current_unix_millis() -> u64 {
    OffsetDateTime::now_utc()
        .unix_timestamp_nanos()
        .checked_div(1_000_000)
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or_default()
}

fn current_timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

#[derive(Debug)]
struct SystemClaudeCapabilityProbeRunner {
    timeout: Duration,
    #[cfg(test)]
    integration_deadline: Option<tokio::time::Instant>,
    #[cfg(test)]
    fixture_spawned: Option<ClaudeProbeSpawnFixture>,
    #[cfg(test)]
    fixture_cancellation: Option<CancellationToken>,
}

#[cfg(test)]
#[derive(Clone, Debug)]
struct ClaudeProbeSpawnFixture {
    spawned: Arc<crate::test_support::FixtureEvent>,
    pid_path: PathBuf,
}

#[cfg(test)]
impl ClaudeProbeSpawnFixture {
    fn publish(&self, process_id: Option<u32>) {
        let process_id = process_id.expect("Claude probe PID is available after spawn");
        let mut temporary_name = self.pid_path.as_os_str().to_owned();
        temporary_name.push(".tmp");
        let temporary_path = PathBuf::from(temporary_name);
        std::fs::write(&temporary_path, process_id.to_string())
            .expect("stage Claude probe PID after spawn");
        std::fs::rename(&temporary_path, &self.pid_path)
            .expect("publish Claude probe PID after spawn");
        self.spawned.publish();
    }
}

impl SystemClaudeCapabilityProbeRunner {
    const fn with_timeout(timeout: Duration) -> Self {
        Self {
            timeout,
            #[cfg(test)]
            integration_deadline: None,
            #[cfg(test)]
            fixture_spawned: None,
            #[cfg(test)]
            fixture_cancellation: None,
        }
    }

    #[cfg(test)]
    const fn with_integration_deadline(deadline: tokio::time::Instant) -> Self {
        Self {
            timeout: Duration::from_secs(2),
            integration_deadline: Some(deadline),
            fixture_spawned: None,
            fixture_cancellation: None,
        }
    }

    #[cfg(test)]
    fn with_spawn_fixture(mut self, fixture_spawned: ClaudeProbeSpawnFixture) -> Self {
        self.fixture_spawned = Some(fixture_spawned);
        self
    }

    #[cfg(test)]
    fn with_fixture_cancellation(mut self, cancellation: CancellationToken) -> Self {
        self.fixture_cancellation = Some(cancellation);
        self
    }
}

impl Default for SystemClaudeCapabilityProbeRunner {
    fn default() -> Self {
        Self::with_timeout(Duration::from_secs(2))
    }
}

impl ClaudeCapabilityProbeRunner for SystemClaudeCapabilityProbeRunner {
    fn run(
        &self,
        executable: &Path,
        args: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<ClaudeProbeOutput, String>> + Send + '_>> {
        let executable = executable.to_path_buf();
        Box::pin(async move {
            #[cfg(feature = "hermetic-test-guard")]
            let executable = crate::hermetic_guard::checked_provider_executable(
                &executable,
                std::env::current_dir().ok().as_deref(),
                std::env::var_os("PATH").as_deref(),
            )
            .ok_or_else(|| {
                "Spawn: probe executable was not found or was refused by the hermetic test guard"
                    .to_owned()
            })?;
            let mut command = tokio::process::Command::new(executable);
            command
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            crate::provider::environment::sanitize_provider_subprocess_environment(&mut command);
            let request = SupervisedRunRequest {
                command,
                stdin: None,
                timeout: self.timeout,
                cleanup_timeout: Duration::from_secs(1),
                max_output_bytes: CLAUDE_PROBE_OUTPUT_LIMIT,
                overflow: SupervisedOverflow::Truncate,
            };
            #[cfg(test)]
            let cancellation = self.fixture_cancellation.clone().unwrap_or_default();
            #[cfg(not(test))]
            let cancellation = CancellationToken::new();
            #[cfg(test)]
            let output = match (self.integration_deadline, self.fixture_spawned.clone()) {
                (Some(deadline), Some(fixture_spawned)) => {
                    run_supervised_with_spawn_observer_until(
                        request,
                        &cancellation,
                        deadline,
                        move |process_id| fixture_spawned.publish(process_id),
                    )
                    .await
                }
                (Some(deadline), None) => {
                    run_supervised_with_spawn_observer_until(
                        request,
                        &cancellation,
                        deadline,
                        |_| {},
                    )
                    .await
                }
                (None, Some(fixture_spawned)) => {
                    run_supervised_with_spawn_observer(request, &cancellation, move |process_id| {
                        fixture_spawned.publish(process_id)
                    })
                    .await
                }
                (None, None) => run_supervised(request, &cancellation).await,
            };
            #[cfg(not(test))]
            let output = run_supervised(request, &cancellation).await;
            let output =
                output.map_err(|error| format!("Claude capability probe failed: {error:?}"))?;
            Ok(ClaudeProbeOutput {
                success: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout.bytes).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr.bytes).into_owned(),
            })
        })
    }
}

#[cfg(all(test, unix))]
mod tests {

    #[cfg(all(feature = "hermetic-test-guard", unix))]
    #[tokio::test]
    async fn hermetic_guard_refuses_direct_claude_probe_before_spawn() {
        let Some(executable) = crate::hermetic_guard::refusal_fixture(
            "provider_terminal::claude::tests::hermetic_guard_refuses_direct_claude_probe_before_spawn",
            "2.1.220",
        ) else {
            return;
        };
        assert!(
            SystemClaudeCapabilityProbeRunner::default()
                .run(&executable, vec![])
                .await
                .is_err()
        );
    }
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::{
        activity::{ActivityProjection, ActivityRepository, ActivityScopeRef},
        persistence::{Database, run_migrations},
        test_support::TestSandbox,
    };

    #[cfg(target_os = "linux")]
    #[test]
    fn system_capability_probe_ignores_appimage_environment() {
        crate::test_support::check_capability_probe_appimage_environment(
            "provider_terminal::claude::tests::system_capability_probe_ignores_appimage_environment",
            |executable, args| async move {
                let output = SystemClaudeCapabilityProbeRunner::default()
                    .run(&executable, args)
                    .await?;
                Ok((output.success, output.stdout))
            },
        );
    }

    #[test]
    fn hook_authorization_accepts_canonical_and_legacy_correlation_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer token".parse().unwrap());
        headers.insert(
            CLAUDE_HOOK_CORRELATION_HEADER,
            "correlation".parse().unwrap(),
        );
        assert!(authorized(&headers, "token", "correlation"));
    }

    #[derive(Debug)]
    struct BarrierClaudeProbeRunner {
        version_barrier: Arc<tokio::sync::Barrier>,
    }

    impl ClaudeCapabilityProbeRunner for BarrierClaudeProbeRunner {
        fn run(
            &self,
            _executable: &Path,
            args: Vec<String>,
        ) -> Pin<Box<dyn Future<Output = Result<ClaudeProbeOutput, String>> + Send + '_>> {
            Box::pin(async move {
                if args == ["--version"] {
                    self.version_barrier.wait().await;
                    return Ok(ClaudeProbeOutput {
                        success: true,
                        stdout: "2.1.220 (Claude Code)\n".to_owned(),
                        stderr: String::new(),
                    });
                }
                Ok(ClaudeProbeOutput {
                    success: true,
                    stdout: "--settings <file-or-json>\n--setting-sources\n".to_owned(),
                    stderr: String::new(),
                })
            })
        }
    }

    #[derive(Debug)]
    struct ApprovedClaudeAttestorFixture;

    impl ClaudeAdditiveHookAttestor for ApprovedClaudeAttestorFixture {
        fn prove(
            &self,
            _executable: &Path,
            version: &str,
        ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
            let approved = version == "2.1.220";
            Box::pin(async move { approved })
        }
    }

    #[derive(Debug, Default)]
    struct ContentAwareClaudeAttestor {
        calls: AtomicUsize,
    }

    impl ClaudeAdditiveHookAttestor for ContentAwareClaudeAttestor {
        fn prove(
            &self,
            executable: &Path,
            version: &str,
        ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            let executable = executable.to_path_buf();
            let approved_version = version == "2.1.220";
            Box::pin(async move {
                approved_version
                    && std::fs::read(executable).is_ok_and(|bytes| bytes == b"approved")
            })
        }
    }

    #[derive(Debug)]
    struct ReplacingClaudeAttestor {
        replacement: PathBuf,
    }

    impl ClaudeAdditiveHookAttestor for ReplacingClaudeAttestor {
        fn prove(
            &self,
            executable: &Path,
            version: &str,
        ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
            let executable = executable.to_path_buf();
            let replacement = self.replacement.clone();
            let approved_version = version == "2.1.220";
            Box::pin(async move {
                std::fs::rename(replacement, executable).expect("replace during attestation");
                approved_version
            })
        }
    }

    #[derive(Debug, Default)]
    struct CountingClaudeProbeRunner {
        calls: AtomicUsize,
    }

    impl ClaudeCapabilityProbeRunner for CountingClaudeProbeRunner {
        fn run(
            &self,
            _executable: &Path,
            args: Vec<String>,
        ) -> Pin<Box<dyn Future<Output = Result<ClaudeProbeOutput, String>> + Send + '_>> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if args == ["--version"] {
                    Ok(ClaudeProbeOutput {
                        success: true,
                        stdout: "2.1.220 (Claude Code)\n".to_owned(),
                        stderr: String::new(),
                    })
                } else {
                    Ok(ClaudeProbeOutput {
                        success: true,
                        stdout: "--settings <file-or-json>\n--setting-sources\n".to_owned(),
                        stderr: String::new(),
                    })
                }
            })
        }
    }

    #[derive(Debug, Default)]
    struct FailingClaudeProbeRunner {
        calls: AtomicUsize,
    }

    impl ClaudeCapabilityProbeRunner for FailingClaudeProbeRunner {
        fn run(
            &self,
            _executable: &Path,
            _args: Vec<String>,
        ) -> Pin<Box<dyn Future<Output = Result<ClaudeProbeOutput, String>> + Send + '_>> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                Err("injected probe failure".to_owned())
            })
        }
    }

    #[derive(Debug)]
    struct ClaudeBoundedProbeFixture {
        _sandbox: TestSandbox,
        executable: PathBuf,
        spawned: Arc<crate::test_support::FixtureEvent>,
        pid_path: PathBuf,
        entered_path: PathBuf,
        stdout_complete_path: PathBuf,
        stderr_complete_path: PathBuf,
        completed_path: PathBuf,
        input_bytes: usize,
    }

    fn bounded_probe_fixture(sandbox: TestSandbox) -> ClaudeBoundedProbeFixture {
        let input_bytes = CLAUDE_PROBE_OUTPUT_LIMIT + 8 * 1024;
        let pid_path = sandbox.path("probe.pid");
        let entered_path = sandbox.path("probe.entered");
        let stdout_complete_path = sandbox.path("probe.stdout-complete");
        let stderr_complete_path = sandbox.path("probe.stderr-complete");
        let completed_path = sandbox.path("probe.completed");
        let executable = sandbox.executable_script(
            "large-claude-probe",
            &format!(
                "printf entered > \"$1\"\n\
                 dd if=/dev/zero bs={input_bytes} count=1 2>/dev/null || exit 70\n\
                 printf '{input_bytes}' > \"$2\"\n\
                 dd if=/dev/zero bs={input_bytes} count=1 1>&2 2>/dev/null || exit 71\n\
                 printf '{input_bytes}' > \"$3\"\n\
                 printf completed > \"$4\""
            ),
            "",
        );
        ClaudeBoundedProbeFixture {
            _sandbox: sandbox,
            executable,
            spawned: Arc::new(crate::test_support::FixtureEvent::default()),
            pid_path,
            entered_path,
            stdout_complete_path,
            stderr_complete_path,
            completed_path,
            input_bytes,
        }
    }

    impl ClaudeBoundedProbeFixture {
        async fn run_until(
            &self,
            deadline: tokio::time::Instant,
        ) -> Result<ClaudeProbeOutput, String> {
            SystemClaudeCapabilityProbeRunner::with_integration_deadline(deadline)
                .with_spawn_fixture(ClaudeProbeSpawnFixture {
                    spawned: self.spawned.clone(),
                    pid_path: self.pid_path.clone(),
                })
                .run(
                    &self.executable,
                    vec![
                        self.entered_path.to_string_lossy().into_owned(),
                        self.stdout_complete_path.to_string_lossy().into_owned(),
                        self.stderr_complete_path.to_string_lossy().into_owned(),
                        self.completed_path.to_string_lossy().into_owned(),
                    ],
                )
                .await
        }

        fn assert_completed_and_reaped(&self) -> i32 {
            assert!(
                self.spawned.checkpoint() > 0,
                "Claude probe owner did not publish child spawn"
            );
            assert_eq!(
                std::fs::read_to_string(&self.entered_path)
                    .expect("read Claude probe entry milestone"),
                "entered",
                "Claude probe fixture did not enter its body"
            );
            let expected_input_bytes = self.input_bytes.to_string();
            assert_eq!(
                std::fs::read_to_string(&self.stdout_complete_path)
                    .expect("read Claude probe stdout milestone"),
                expected_input_bytes,
                "Claude probe fixture did not publish its exact stdout input"
            );
            assert_eq!(
                std::fs::read_to_string(&self.stderr_complete_path)
                    .expect("read Claude probe stderr milestone"),
                expected_input_bytes,
                "Claude probe fixture did not publish its exact stderr input"
            );
            assert_eq!(
                std::fs::read_to_string(&self.completed_path)
                    .expect("read Claude probe completion milestone"),
                "completed",
                "Claude probe fixture body did not complete"
            );
            let pid = read_fixture_pid(&self.pid_path).expect("Claude probe fixture PID");
            assert!(
                !process_exists(pid),
                "Claude probe process survived owner completion"
            );
            assert_child_was_reaped(pid, "Claude probe");
            pid
        }
    }

    async fn await_probe_owner_with_observation_watchdog(
        mut owner: Pin<&mut (dyn Future<Output = Result<ClaudeProbeOutput, String>> + Send + '_)>,
        cancellation: CancellationToken,
        deadline: tokio::time::Instant,
    ) -> Result<ClaudeProbeOutput, String> {
        tokio::select! {
            biased;
            result = owner.as_mut() => result,
            () = tokio::time::sleep_until(deadline) => {
                cancellation.cancel();
                let owner_result = owner.await;
                match owner_result {
                    Ok(_) => Err("Claude probe observation deadline expired after owner success".to_owned()),
                    Err(error) => Err(format!(
                        "Claude probe observation deadline expired; owner failed: {error}"
                    )),
                }
            }
        }
    }

    fn read_fixture_pid(path: &Path) -> Result<i32, String> {
        std::fs::read_to_string(path)
            .map_err(|error| format!("failed reading fixture PID: {error}"))?
            .parse::<i32>()
            .map_err(|error| format!("fixture PID was not numeric: {error}"))
    }

    fn process_exists(pid: i32) -> bool {
        // SAFETY: signal zero checks existence and permission without
        // delivering a signal.
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    fn assert_child_was_reaped(pid: i32, label: &str) {
        let mut status = 0;
        // SAFETY: `status` is valid writable storage and WNOHANG does not
        // block.
        let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        let error = io::Error::last_os_error();
        assert_eq!(
            result, -1,
            "{label} PID {pid} remained waitable after its owner returned"
        );
        assert_eq!(
            error.raw_os_error(),
            Some(libc::ECHILD),
            "{label} PID {pid} was absent but not positively reaped by its owner"
        );
    }

    fn restore_modified_time(source: &Path, target: &Path) {
        let status = std::process::Command::new("touch")
            .arg("-r")
            .arg(source)
            .arg(target)
            .status()
            .expect("run touch");
        assert!(status.success(), "restore fixture modified time");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_claude_probes_bound_both_output_streams_in_parallel() {
        let left = bounded_probe_fixture(TestSandbox::new("claude-probe-left"));
        let right = bounded_probe_fixture(TestSandbox::new("claude-probe-right"));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);

        let (left_output, right_output) =
            tokio::join!(left.run_until(deadline), right.run_until(deadline));

        let mut probe_pids = Vec::new();
        for (fixture, output) in [(&left, left_output), (&right, right_output)] {
            let output = output.expect("large Claude probe");
            assert!(output.success);
            assert_eq!(output.stdout.len(), CLAUDE_PROBE_OUTPUT_LIMIT);
            assert_eq!(output.stderr.len(), CLAUDE_PROBE_OUTPUT_LIMIT);
            assert_eq!(fixture.input_bytes, 72 * 1024);
            probe_pids.push(fixture.assert_completed_and_reaped());
        }
        assert_ne!(probe_pids[0], probe_pids[1]);
    }

    #[tokio::test]
    async fn probe_fixture_reports_owner_failure_before_observation_watchdog() {
        let sandbox = TestSandbox::new("claude-probe-owner-error");
        let cancellation = CancellationToken::new();
        let runner = SystemClaudeCapabilityProbeRunner::with_integration_deadline(
            tokio::time::Instant::now() + Duration::from_secs(15),
        )
        .with_fixture_cancellation(cancellation.clone());
        let mut owner = runner.run(&sandbox.path("missing-claude-probe"), Vec::new());

        let error = await_probe_owner_with_observation_watchdog(
            owner.as_mut(),
            cancellation,
            tokio::time::Instant::now() + Duration::from_millis(250),
        )
        .await
        .expect_err("missing Claude probe must report its owned spawn error");

        assert!(
            error.contains("Spawn"),
            "unexpected Claude probe owner error: {error}"
        );
        assert!(
            !error.contains("observation deadline expired"),
            "the observation watchdog hid the immediate owner error: {error}"
        );
    }

    #[tokio::test]
    async fn probe_observation_watchdog_cancels_joins_and_reaps_the_owned_process() {
        let sandbox = TestSandbox::new("claude-probe-watchdog-cleanup");
        let pid_path = sandbox.path("probe.pid");
        let executable = sandbox.executable_script("hung-claude-probe", "exec sleep 3600", "");
        let spawned = Arc::new(crate::test_support::FixtureEvent::default());
        let cancellation = CancellationToken::new();
        let owner_deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let runner = SystemClaudeCapabilityProbeRunner::with_integration_deadline(owner_deadline)
            .with_spawn_fixture(ClaudeProbeSpawnFixture {
                spawned: spawned.clone(),
                pid_path: pid_path.clone(),
            })
            .with_fixture_cancellation(cancellation.clone());
        let spawn_checkpoint = spawned.checkpoint();
        let mut owner = runner.run(&executable, Vec::new());

        tokio::select! {
            biased;
            result = owner.as_mut() => {
                panic!("Claude probe owner returned before spawn publication: {result:?}");
            }
            result = tokio::time::timeout_at(
                owner_deadline,
                spawned.wait_after(spawn_checkpoint),
            ) => {
                result.expect("Claude probe did not publish its PID before the owner deadline");
            }
        }

        let error = await_probe_owner_with_observation_watchdog(
            owner.as_mut(),
            cancellation,
            tokio::time::Instant::now() + Duration::from_millis(100),
        )
        .await
        .expect_err("Claude probe observation watchdog must expire");

        assert!(
            error.contains("observation deadline expired"),
            "watchdog error omitted its boundary: {error}"
        );
        assert!(spawned.checkpoint() > 0, "watchdog probe did not spawn");
        let pid = read_fixture_pid(&pid_path).expect("watchdog Claude probe PID");
        assert!(
            !process_exists(pid),
            "watchdog Claude probe survived cleanup"
        );
        assert_child_was_reaped(pid, "watchdog Claude probe");
    }

    #[tokio::test]
    async fn default_system_probe_timeout_terminates_and_reaps_the_owned_process() {
        let sandbox = TestSandbox::new("claude-probe-default-timeout");
        let pid_path = sandbox.path("probe.pid");
        let executable = sandbox.executable_script("hung-claude-probe", "exec sleep 3600", "");
        let spawned = Arc::new(crate::test_support::FixtureEvent::default());
        let runner = SystemClaudeCapabilityProbeRunner::default().with_spawn_fixture(
            ClaudeProbeSpawnFixture {
                spawned: spawned.clone(),
                pid_path: pid_path.clone(),
            },
        );
        assert_eq!(runner.timeout, Duration::from_secs(2));

        let error = runner
            .run(&executable, Vec::new())
            .await
            .expect_err("hung Claude probe must fail closed");

        assert!(spawned.checkpoint() > 0, "hung Claude probe did not spawn");
        assert!(
            error.contains("Timeout"),
            "hung Claude probe failed outside the default timeout boundary: {error}"
        );
        let pid = read_fixture_pid(&pid_path).expect("default-timeout Claude probe PID");
        assert!(
            !process_exists(pid),
            "timed-out Claude probe process was not terminated and reaped"
        );
        assert_child_was_reaped(pid, "default-timeout Claude probe");
    }

    #[tokio::test]
    async fn capability_cache_does_not_serialize_external_probes_for_distinct_binaries() {
        let root = tempfile::tempdir().expect("probe directory");
        let first = root.path().join("claude-first");
        let second = root.path().join("claude-second");
        std::fs::write(&first, b"first").expect("first executable");
        std::fs::write(&second, b"second").expect("second executable");
        let probe = Arc::new(CachedClaudeCapabilityProbe::with_attestor(
            Arc::new(BarrierClaudeProbeRunner {
                version_barrier: Arc::new(tokio::sync::Barrier::new(2)),
            }),
            Arc::new(ApprovedClaudeAttestorFixture),
        ));

        let completed = tokio::time::timeout(Duration::from_millis(250), async {
            tokio::join!(probe.probe(&first), probe.probe(&second))
        })
        .await;

        assert!(
            completed.is_ok(),
            "the capability-cache mutex must not be held across external probes"
        );
    }

    #[tokio::test]
    async fn capability_cache_singleflights_concurrent_probes_for_the_same_binary() {
        let root = tempfile::tempdir().expect("probe directory");
        let executable = root.path().join("claude");
        std::fs::write(&executable, b"same").expect("executable");
        let runner = Arc::new(CountingClaudeProbeRunner::default());
        let probe = Arc::new(CachedClaudeCapabilityProbe::with_attestor(
            runner.clone(),
            Arc::new(ApprovedClaudeAttestorFixture),
        ));

        let (first, second) = tokio::time::timeout(Duration::from_millis(250), async {
            tokio::join!(probe.probe(&executable), probe.probe(&executable))
        })
        .await
        .expect("same-key probes must complete within the cache deadline");

        assert_eq!(first, second);
        assert!(first.is_some());
        assert_eq!(
            runner.calls.load(Ordering::Acquire),
            2,
            "one version/help pair must serve both same-key callers"
        );
    }

    #[tokio::test]
    async fn capability_cache_shares_concurrent_failures_but_allows_a_later_retry() {
        let root = tempfile::tempdir().expect("probe directory");
        let executable = root.path().join("claude");
        std::fs::write(&executable, b"same").expect("executable");
        let runner = Arc::new(FailingClaudeProbeRunner::default());
        let probe = Arc::new(CachedClaudeCapabilityProbe::with_attestor(
            runner.clone(),
            Arc::new(ApprovedClaudeAttestorFixture),
        ));

        let (first, second) = tokio::time::timeout(Duration::from_millis(250), async {
            tokio::join!(probe.probe(&executable), probe.probe(&executable))
        })
        .await
        .expect("same-key failures must complete within the cache deadline");

        assert!(first.is_none());
        assert!(second.is_none());
        assert_eq!(
            runner.calls.load(Ordering::Acquire),
            2,
            "concurrent callers must share the first failed version/help pair"
        );
        assert!(probe.probe(&executable).await.is_none());
        assert_eq!(
            runner.calls.load(Ordering::Acquire),
            4,
            "a later caller must be allowed to retry a transient version/help failure"
        );
    }

    #[tokio::test]
    async fn build_publisher_is_proven_once_and_every_launch_rehashes_its_pin() {
        let root = tempfile::tempdir().expect("probe directory");
        let executable = root.path().join("claude");
        std::fs::write(&executable, b"approved").expect("approved executable");
        let runner = Arc::new(CountingClaudeProbeRunner::default());
        let attestor = Arc::new(ContentAwareClaudeAttestor::default());
        let probe = CachedClaudeCapabilityProbe::with_attestor(runner.clone(), attestor.clone());

        assert!(
            probe
                .probe(&executable)
                .await
                .is_some_and(|capabilities| capabilities.additive_hook_merge)
        );
        assert!(
            probe
                .probe(&executable)
                .await
                .is_some_and(|capabilities| capabilities.additive_hook_merge)
        );
        assert_eq!(
            runner.calls.load(Ordering::Acquire),
            2,
            "version/help capabilities may be cached"
        );
        assert_eq!(
            attestor.calls.load(Ordering::Acquire),
            1,
            "a build's publisher is proven once; later launches only compare their pin's digest"
        );
    }

    #[tokio::test]
    async fn a_pin_whose_bytes_differ_from_the_proven_build_is_not_hooked() {
        let root = tempfile::tempdir().expect("probe directory");
        let source = root.path().join("claude");
        let first_pin = root.path().join("first-pin");
        let second_pin = root.path().join("second-pin");
        std::fs::write(&source, b"approved").expect("source");
        std::fs::write(&first_pin, b"approved").expect("first pin");
        std::fs::write(&second_pin, b"tampered").expect("second pin");
        let attestor = Arc::new(ContentAwareClaudeAttestor::default());
        let probe = CachedClaudeCapabilityProbe::with_attestor(
            Arc::new(CountingClaudeProbeRunner::default()),
            attestor.clone(),
        );
        let fingerprint = ClaudeExecutableFingerprint::read(&source).expect("fingerprint");

        assert!(
            probe
                .probe_pinned(&source, &fingerprint, &first_pin, None)
                .await
                .is_some_and(|capabilities| capabilities.additive_hook_merge)
        );
        assert!(
            probe
                .probe_pinned(&source, &fingerprint, &second_pin, None)
                .await
                .is_some_and(|capabilities| !capabilities.additive_hook_merge),
            "the proven digest, not the source fingerprint alone, grants hooks"
        );
        assert_eq!(attestor.calls.load(Ordering::Acquire), 1);
    }

    #[derive(Debug, Default)]
    struct SlowCountingAttestor {
        calls: AtomicUsize,
        hang_first: AtomicBool,
    }

    impl ClaudeAdditiveHookAttestor for SlowCountingAttestor {
        fn prove(
            &self,
            _executable: &Path,
            _version: &str,
        ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
            let call = self.calls.fetch_add(1, Ordering::AcqRel);
            let hang = call == 0 && self.hang_first.load(Ordering::Acquire);
            Box::pin(async move {
                if hang {
                    std::future::pending::<()>().await;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
                true
            })
        }
    }

    #[tokio::test]
    async fn concurrent_launches_of_a_new_build_share_one_publisher_proof() {
        let root = tempfile::tempdir().expect("probe directory");
        let executable = root.path().join("claude");
        std::fs::write(&executable, b"approved").expect("executable");
        let attestor = Arc::new(SlowCountingAttestor::default());
        let probe = CachedClaudeCapabilityProbe::with_attestor(
            Arc::new(CountingClaudeProbeRunner::default()),
            attestor.clone(),
        );

        let (first, second) = tokio::join!(probe.probe(&executable), probe.probe(&executable));

        assert!(first.is_some_and(|capabilities| capabilities.additive_hook_merge));
        assert!(second.is_some_and(|capabilities| capabilities.additive_hook_merge));
        assert_eq!(attestor.calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn a_cancelled_publisher_proof_publishes_nothing() {
        let root = tempfile::tempdir().expect("probe directory");
        let executable = root.path().join("claude");
        std::fs::write(&executable, b"approved").expect("executable");
        let attestor = Arc::new(SlowCountingAttestor {
            calls: AtomicUsize::new(0),
            hang_first: AtomicBool::new(true),
        });
        let probe = CachedClaudeCapabilityProbe::with_attestor(
            Arc::new(CountingClaudeProbeRunner::default()),
            attestor.clone(),
        );

        assert!(
            tokio::time::timeout(Duration::from_millis(200), probe.probe(&executable))
                .await
                .is_err(),
            "the first proof hangs until its preparation gives up"
        );
        assert!(
            probe
                .probe(&executable)
                .await
                .is_some_and(|capabilities| capabilities.additive_hook_merge),
            "a later launch proves the build again"
        );
        assert_eq!(attestor.calls.load(Ordering::Acquire), 2);
    }

    #[tokio::test]
    async fn same_length_rewrite_with_restored_mtime_cannot_reuse_build_approval() {
        let root = tempfile::tempdir().expect("probe directory");
        let executable = root.path().join("claude");
        let timestamp_source = root.path().join("approved-timestamp");
        std::fs::write(&executable, b"approved").expect("approved executable");
        std::fs::write(&timestamp_source, b"timestamp").expect("timestamp source");
        restore_modified_time(&executable, &timestamp_source);
        let original_modified = std::fs::metadata(&executable)
            .expect("approved metadata")
            .modified()
            .expect("approved modified time");
        let runner = Arc::new(CountingClaudeProbeRunner::default());
        let attestor = Arc::new(ContentAwareClaudeAttestor::default());
        let probe = CachedClaudeCapabilityProbe::with_attestor(runner, attestor.clone());

        assert!(
            probe
                .probe(&executable)
                .await
                .is_some_and(|capabilities| capabilities.additive_hook_merge)
        );
        std::fs::write(&executable, b"rejected").expect("same-length replacement");
        restore_modified_time(&timestamp_source, &executable);
        let replaced_metadata = std::fs::metadata(&executable).expect("replacement metadata");
        assert_eq!(replaced_metadata.len(), 8);
        assert_eq!(
            replaced_metadata
                .modified()
                .expect("replacement modified time"),
            original_modified,
            "the regression fixture must defeat length/mtime-only fingerprints"
        );

        assert!(
            probe
                .probe(&executable)
                .await
                .is_some_and(|capabilities| !capabilities.additive_hook_merge),
            "the rewritten executable must fail closed"
        );
        assert_eq!(
            attestor.calls.load(Ordering::Acquire),
            2,
            "the rewritten executable must be re-attested"
        );
    }

    #[tokio::test]
    async fn executable_replacement_during_attestation_fails_identity_stability_check() {
        let root = tempfile::tempdir().expect("probe directory");
        let executable = root.path().join("claude");
        let replacement = root.path().join("claude-replacement");
        std::fs::write(&executable, b"approved").expect("approved executable");
        std::fs::write(&replacement, b"replaced").expect("same-length replacement");
        restore_modified_time(&executable, &replacement);
        let probe = CachedClaudeCapabilityProbe::with_attestor(
            Arc::new(CountingClaudeProbeRunner::default()),
            Arc::new(ReplacingClaudeAttestor { replacement }),
        );

        let capabilities = probe.probe(&executable).await;

        assert!(
            !capabilities.is_some_and(|capabilities| capabilities.additive_hook_merge),
            "a path whose file identity changes during attestation must fail closed"
        );
    }

    #[test]
    fn claude_version_requires_the_claude_code_marker() {
        assert_eq!(
            parse_claude_version("2.1.312 (Claude Code)\n").as_deref(),
            Some("2.1.312")
        );
        assert_eq!(
            parse_claude_version("2026.10.19 macos-arm64 (2026-10-19)\n"),
            None,
            "mise's own version must never pass as a Claude version"
        );
        assert_eq!(parse_claude_version("claude 2.1.312\n"), None);
        assert_eq!(parse_claude_version("(Claude Code)\n"), None);
    }

    #[test]
    fn additive_hooks_cover_only_the_proven_version_range() {
        assert!(!additive_hook_version("2.1.219"));
        assert!(additive_hook_version("2.1.220"));
        assert!(additive_hook_version("2.1.312"));
        assert!(
            !additive_hook_version("2.1.313"),
            "a build newer than the last proven one runs unhooked until the ceiling is raised"
        );
        assert!(!additive_hook_version("2026.10.19.1"));
        assert!(!additive_hook_version("latest"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn the_code_requirement_rejects_a_build_not_signed_by_anthropic() {
        let root = tempfile::tempdir().expect("copy directory");
        let copy = root.path().join("claude");
        std::fs::copy("/bin/ls", &copy).expect("copy an Apple-signed binary");

        assert!(
            !anthropic_signed_build(&copy, None).await,
            "Apple's own signature is not Anthropic's"
        );
    }

    #[test]
    fn mise_which_output_must_be_one_absolute_path() {
        assert_eq!(
            parse_mise_which("/home/u/.local/share/mise/installs/claude/2.1.311/claude\n"),
            Some(PathBuf::from(
                "/home/u/.local/share/mise/installs/claude/2.1.311/claude"
            ))
        );
        for rejected in [
            "",
            "\n",
            "claude\n",
            "/a/claude\n/b/claude\n",
            "/a/claude\r\n",
        ] {
            assert_eq!(parse_mise_which(rejected), None, "{rejected:?}");
        }
        assert_eq!(
            parse_mise_which(&format!("/{}\n", "a".repeat(SHIM_WHICH_OUTPUT_LIMIT))),
            None
        );
    }

    #[test]
    fn mise_env_output_must_be_a_bounded_object_of_strings() {
        assert_eq!(
            parse_mise_env(r#"{"PATH":"/x:/y","ANTHROPIC_BASE_URL":"https://example.invalid"}"#),
            Some(BTreeMap::from([
                (
                    "ANTHROPIC_BASE_URL".to_owned(),
                    "https://example.invalid".to_owned()
                ),
                ("PATH".to_owned(), "/x:/y".to_owned()),
            ]))
        );
        assert_eq!(parse_mise_env(r#"{"A":1}"#), None);
        assert_eq!(parse_mise_env(r#"["A"]"#), None);
        assert_eq!(parse_mise_env("not json"), None);
        assert_eq!(
            parse_mise_env(&format!(
                r#"{{"A":"{}"}}"#,
                "x".repeat(SHIM_ENV_OUTPUT_LIMIT)
            )),
            None
        );
    }

    #[test]
    fn shim_environment_refuses_loader_overrides_and_invalid_names() {
        let accepted = BTreeMap::from([
            ("PATH".to_owned(), "/x".to_owned()),
            ("_PRIVATE_1".to_owned(), "value".to_owned()),
        ]);
        assert_eq!(
            validated_shim_environment(accepted.clone()),
            Some(accepted.clone())
        );
        for (key, value) in [
            ("LD_PRELOAD", "/tmp/x.so"),
            ("LD_LIBRARY_PATH", "/tmp"),
            ("LD_AUDIT", "/tmp/x.so"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/x.dylib"),
            ("DYLD_LIBRARY_PATH", "/tmp"),
            ("1ABC", "x"),
            ("A=B", "x"),
            ("", "x"),
            ("NUL", "a\0b"),
        ] {
            let mut env = accepted.clone();
            env.insert(key.to_owned(), value.to_owned());
            assert_eq!(validated_shim_environment(env), None, "{key}");
        }
    }

    #[test]
    fn install_candidate_must_be_a_private_executable_that_is_not_the_manager() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("candidate directory");
        let write = |name: &str, mode: u32| {
            let path = root.path().join(name);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("parent directory");
            std::fs::write(&path, b"claude").expect("candidate");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))
                .expect("candidate mode");
            path
        };
        let accepted = write("installs/claude/2.1.311/claude", 0o755);
        assert_eq!(
            validated_install_candidate(&accepted),
            Some(std::fs::canonicalize(&accepted).expect("canonical"))
        );
        let link = root.path().join("latest");
        std::os::unix::fs::symlink(&accepted, &link).expect("link");
        assert_eq!(
            validated_install_candidate(&link),
            Some(std::fs::canonicalize(&accepted).expect("canonical")),
            "a link such as installs/claude/latest is followed to its target"
        );
        for rejected in [
            write("group-writable", 0o775),
            write("world-writable", 0o757),
            write("not-executable", 0o644),
            write("bin/mise", 0o755),
            root.path().join("installs"),
            root.path().join("missing"),
        ] {
            assert_eq!(validated_install_candidate(&rejected), None, "{rejected:?}");
        }
        assert_eq!(validated_install_candidate(Path::new("claude")), None);
    }

    #[test]
    fn only_a_link_to_mise_is_a_multi_call_shim() {
        let root = tempfile::tempdir().expect("shim directory");
        let mise = root.path().join("bin/mise");
        let claude = root.path().join("versions/2.1.312");
        for target in [&mise, &claude] {
            std::fs::create_dir_all(target.parent().expect("parent")).expect("parent");
            std::fs::write(target, b"binary").expect("target");
        }
        let shim = root.path().join("shims/claude");
        let launcher = root.path().join("bin/claude");
        std::fs::create_dir_all(shim.parent().expect("parent")).expect("parent");
        std::os::unix::fs::symlink(&mise, &shim).expect("shim");
        std::os::unix::fs::symlink(&claude, &launcher).expect("launcher");
        let canonical = |path: &Path| std::fs::canonicalize(path).expect("canonical");

        assert!(is_multi_call_shim(&shim, &canonical(&shim)));
        assert!(!is_multi_call_shim(&launcher, &canonical(&launcher)));
        assert!(!is_multi_call_shim(&mise, &canonical(&mise)));
    }

    #[test]
    fn pin_copy_is_exact_private_and_leaves_nothing_when_cancelled() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("copy directory");
        let source = root.path().join("claude");
        let bytes: Vec<u8> = (0..(CLAUDE_PIN_COPY_CHUNK + 4096))
            .map(|index| (index % 251) as u8)
            .collect();
        std::fs::write(&source, &bytes).expect("source");

        let pinned = root.path().join("pinned");
        copy_executable(&source, &pinned, &AtomicBool::new(false)).expect("copy");
        assert_eq!(std::fs::read(&pinned).expect("pinned bytes"), bytes);
        assert_eq!(
            std::fs::metadata(&pinned)
                .expect("pinned metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(
            copy_executable(&source, &pinned, &AtomicBool::new(false)).is_err(),
            "an existing destination is never replaced"
        );
        assert_eq!(std::fs::read(&pinned).expect("pinned bytes"), bytes);

        let cancelled = root.path().join("cancelled-before");
        let error = copy_executable(&source, &cancelled, &AtomicBool::new(true))
            .expect_err("a cancelled pin fails");
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert!(!cancelled.exists());

        let partial = root.path().join("cancelled-mid-copy");
        let error = copy_executable_until(&source, &partial, &|copied| copied > 0)
            .expect_err("a pin cancelled after its first chunk fails");
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert!(
            !partial.exists(),
            "a pin cancelled mid-copy removes its partial file"
        );
    }

    fn attestation_fixture_executable() -> Option<PathBuf> {
        let executable = PathBuf::from(std::env::var_os("BIBCODE_CLAUDE_ATTESTATION_FIXTURE")?);
        if !executable.is_file() {
            return None;
        }
        #[cfg(feature = "hermetic-test-guard")]
        let executable =
            crate::hermetic_guard::checked_provider_executable(&executable, None, None)?;
        Some(executable)
    }

    #[cfg(feature = "hermetic-test-guard")]
    #[test]
    fn attestation_fixture_never_uses_an_ambient_home_installation() {
        const CASE: &str = "claude-attestation-owned-home";
        const TEST: &str = "provider_terminal::claude::tests::attestation_fixture_never_uses_an_ambient_home_installation";
        if TestSandbox::is_isolated_case(CASE, TEST) {
            assert!(attestation_fixture_executable().is_none());
            println!(
                "BIBCODE_ATTESTATION_FIXTURE_CHILD_PID={}",
                std::process::id()
            );
            return;
        }
        let sandbox = TestSandbox::new(CASE);
        let path = sandbox.path(".local/share/claude/versions/2.1.220");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"owned installation tripwire; never executed").unwrap();
        let output = sandbox.run_isolated_case_without_environment(
            CASE,
            TEST,
            &[
                ("HOME", sandbox.root().as_os_str()),
                ("USERPROFILE", sandbox.root().as_os_str()),
            ],
            &["BIBCODE_CLAUDE_ATTESTATION_FIXTURE"],
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout)
                .matches("BIBCODE_ATTESTATION_FIXTURE_CHILD_PID=")
                .count(),
            1,
            "exactly one owned child must complete and be reaped"
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        let child_pid = stdout
            .split("BIBCODE_ATTESTATION_FIXTURE_CHILD_PID=")
            .nth(1)
            .and_then(|value| value.split_whitespace().next())
            .expect("completed child PID marker");
        eprintln!("attestation fixture: exactly one child {child_pid} completed and reaped");
    }

    #[tokio::test]
    async fn installed_claude_build_is_approved_and_fits_the_preparation_budget() {
        let Some(executable) = attestation_fixture_executable() else {
            return;
        };
        let probe = CachedClaudeCapabilityProbe::new(Arc::new(
            SystemClaudeCapabilityProbeRunner::default(),
        ));
        let started = std::time::Instant::now();
        sha256_file(&executable).expect("installed digest");
        eprintln!("installed Claude SHA-256: {:?}", started.elapsed());

        for phase in ["cold", "proven-build"] {
            let started = std::time::Instant::now();
            let capabilities =
                tokio::time::timeout(CLAUDE_PREPARATION_BUDGET, probe.probe(&executable))
                    .await
                    .unwrap_or_else(|_| {
                        panic!("{phase} installed probe exceeded {CLAUDE_PREPARATION_BUDGET:?}")
                    })
                    .unwrap_or_else(|| panic!("{phase} installed probe failed"));
            assert!(
                capabilities.additive_hook_merge,
                "{phase}: the installed build {} must be approved",
                capabilities.version
            );
            let elapsed = started.elapsed();
            eprintln!("installed Claude {phase} preparation probe: {elapsed:?}");
            assert!(
                elapsed < CLAUDE_PREPARATION_BUDGET,
                "{phase} installed preparation exceeded {CLAUDE_PREPARATION_BUDGET:?}"
            );
        }
    }

    /// The release-time proof behind `MAX_ADDITIVE_HOOK_VERSION`: with BiBCode's real overlay
    /// injected through `--settings`, a project `PreToolUse` guard still blocks a tool call and
    /// BiBCode's own hooks still arrive. It runs the Claude build named by
    /// `BIBCODE_CLAUDE_MERGE_PROOF` once, signed in, and costs one short Haiku turn:
    ///
    /// `BIBCODE_CLAUDE_MERGE_PROOF=~/.local/share/claude/versions/<v> cargo test -p bibcode-server
    /// --lib live_user_pre_tool_use_guard -- --ignored --nocapture`
    #[ignore = "runs a signed-in Claude build; a release step in docs/operations/release.md"]
    #[tokio::test]
    async fn live_user_pre_tool_use_guard_still_blocks_with_the_bibcode_overlay() {
        use std::{
            io::{Read as _, Write as _},
            os::unix::fs::PermissionsExt,
        };

        let Some(executable) = std::env::var_os("BIBCODE_CLAUDE_MERGE_PROOF").map(PathBuf::from)
        else {
            panic!("set BIBCODE_CLAUDE_MERGE_PROOF to the Claude build to prove");
        };
        let project = tempfile::tempdir().expect("proof project");
        let project_path = std::fs::canonicalize(project.path()).expect("canonical project");
        let guard_marker = project_path.join("guard-ran");
        let tool_marker = project_path.join("tool-ran");
        let guard = project_path.join("guard.sh");
        std::fs::write(
            &guard,
            format!(
                "#!/bin/sh\ncat >/dev/null\ntouch '{}'\necho 'blocked by the merge proof guard' >&2\nexit 2\n",
                guard_marker.display()
            ),
        )
        .expect("guard script");
        std::fs::set_permissions(&guard, std::fs::Permissions::from_mode(0o700))
            .expect("guard mode");
        std::fs::create_dir_all(project_path.join(".claude")).expect("project settings dir");
        std::fs::write(
            project_path.join(".claude/settings.json"),
            serde_json::to_vec(&json!({
                "hooks": {
                    "PreToolUse": [{
                        "matcher": "Bash",
                        "hooks": [{ "type": "command", "command": guard }],
                    }],
                },
            }))
            .expect("project settings JSON"),
        )
        .expect("project settings");

        // BiBCode's side: its real overlay, pointed at a loopback sink that records event names.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("hook sink");
        listener.set_nonblocking(true).expect("nonblocking sink");
        let endpoint = format!(
            "http://{}/claude-hook",
            listener.local_addr().expect("sink address")
        );
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let sink = {
            let events = events.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    };
                    let _ = stream.set_nonblocking(false);
                    let mut request = Vec::new();
                    let mut buffer = [0_u8; 8192];
                    let body = loop {
                        let Ok(read) = stream.read(&mut buffer) else {
                            break None;
                        };
                        if read == 0 {
                            break None;
                        }
                        request.extend_from_slice(&buffer[..read]);
                        let text = String::from_utf8_lossy(&request).into_owned();
                        let Some((head, body)) = text.split_once("\r\n\r\n") else {
                            continue;
                        };
                        let length = head
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())?
                            })
                            .unwrap_or(0);
                        if body.len() >= length {
                            break Some(body.to_owned());
                        }
                    };
                    if let Some(event) = body
                        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
                        .and_then(|hook| hook["hook_event_name"].as_str().map(str::to_owned))
                    {
                        events.lock().expect("events lock").push(event);
                    }
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
            })
        };
        let overlay_path = project_path.join("bibcode-overlay.json");
        std::fs::write(
            &overlay_path,
            serde_json::to_vec(&claude_hook_settings(&endpoint, "proof-token", "proof"))
                .expect("overlay JSON"),
        )
        .expect("overlay");

        let mut command = tokio::process::Command::new(&executable);
        command
            .current_dir(&project_path)
            .arg("-p")
            .arg(format!(
                "Run exactly this shell command with the Bash tool: touch '{}'. Do not run anything else. Then reply DONE.",
                tool_marker.display()
            ))
            .arg("--model")
            .arg("haiku")
            .arg("--max-turns")
            .arg("3")
            .arg("--allowedTools")
            .arg("Bash")
            .arg("--settings")
            .arg(&overlay_path)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(180), command.output())
            .await
            .expect("the proof run finishes")
            .expect("the proof run starts");
        stop.store(true, Ordering::Release);
        sink.join().expect("hook sink");
        let events = events.lock().expect("events lock").clone();
        eprintln!(
            "proof run: status {:?}, BiBCode hook events {events:?}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout)
        );

        assert!(
            guard_marker.exists(),
            "the user's PreToolUse guard must run with BiBCode's overlay injected"
        );
        assert!(
            !tool_marker.exists(),
            "the user's guard must still block the tool call"
        );
        // A `-p` run delivers no HTTP `SessionStart` (2.1.312); the prompt and tool hooks
        // prove BiBCode's side of the merge.
        for expected in ["UserPromptSubmit", "PreToolUse"] {
            assert!(
                events.iter().any(|event| event == expected),
                "BiBCode's own {expected} hook must still arrive: {events:?}"
            );
        }
    }

    #[tokio::test]
    async fn disabling_activity_cancels_transcript_recovery_before_record_processing() {
        let activity = Arc::new(TerminalAgentActivityControl::enabled());
        let generation = TerminalObserverGeneration::new(
            "thread-recovery-cancel".to_owned(),
            "terminal-recovery-cancel".to_owned(),
        );
        let cancellation = CancellationToken::new();
        let recovery_cancellation = cancellation.clone();
        let (started, started_receiver) = oneshot::channel();
        let recovery_activity = activity.clone();
        let recovery_generation = generation.clone();
        let recovery = tokio::spawn(async move {
            await_claude_recovery_while_current(
                &recovery_activity,
                &recovery_generation.observation(),
                cancellation,
                async move {
                    let _ = started.send(());
                    recovery_cancellation.cancelled().await;
                },
            )
            .await
        });

        started_receiver.await.expect("transcript recovery started");
        let _ = activity.transition_state(false);

        assert_eq!(
            recovery.await.expect("recovery task"),
            Err(StatusCode::NO_CONTENT),
            "a dormant transition must cancel recovery before recovered records are normalized",
        );
    }

    #[tokio::test]
    async fn unexpected_server_exit_interrupts_correlated_activity() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection = ActivityProjection::new(ActivityRepository::new(database));
        let generation = TerminalObserverGeneration::new(
            "thread-server-exit".to_owned(),
            "terminal-server-exit".to_owned(),
        );
        let publisher = TerminalGenerationActivityPublisher::new(
            generation.clone(),
            projection.clone(),
            Arc::new(tokio::sync::Mutex::new(())),
        );
        let root = tempfile::tempdir().expect("observer resources");
        let generation_dir = root.path().join("generation");
        std::fs::create_dir(&generation_dir).expect("generation directory");
        let overlay_path = generation_dir.join("settings.json");
        std::fs::write(&overlay_path, b"{}").expect("overlay");
        let pinned_executable = generation_dir.join("claude");
        std::fs::write(&pinned_executable, b"approved").expect("pinned executable");
        let inner = Arc::new(ClaudeObserverInner {
            resources: Arc::new(ClaudeObserverResources {
                listener: Mutex::new(None),
                overlay_path,
                runtime_dir: root.path().to_path_buf(),
                generation_dir,
                cleaned: AtomicBool::new(false),
            }),
            publisher,
            provider_instance_id: "claudeAgent".to_owned(),
            token: Arc::new("unused".to_owned()),
            correlation: Arc::new("unused".to_owned()),
            spawned: AtomicBool::new(true),
            activity: Arc::new(TerminalAgentActivityControl::enabled()),
            listener_lifecycle: AtomicU64::new(pack_claude_listener_lifecycle(
                ClaudeListenerLifecycle {
                    ready: false,
                    epoch: 0,
                },
            )),
        });
        let (requests, receiver) = mpsc::channel(1);
        let (stop_server, server_stopped) = oneshot::channel();
        let activity = inner.activity.clone();
        let admission = inner.activity.admit().expect("root hook admission");
        let observer = tokio::spawn(drive_claude_observer(
            inner,
            generation.observation(),
            receiver,
            Box::pin(async move {
                let _ = server_stopped.await;
            }),
        ));
        let (response, response_receiver) = oneshot::channel();
        requests
            .send(ClaudeHookRequest {
                value: json!({
                    "hook_event_name": "SubagentStart",
                    "session_id": "root-session",
                    "agent_id": "agent-1",
                    "agent_type": "Explore",
                    "transcript_path": root.path().join("root-session.jsonl"),
                    "cwd": root.path(),
                }),
                admission,
                response,
            })
            .await
            .expect("root hook");
        assert_eq!(
            response_receiver.await.expect("root hook response"),
            StatusCode::NO_CONTENT
        );

        stop_server.send(()).expect("inject server exit");
        observer.await.expect("observer task");
        assert_eq!(
            activity.latest_observation(),
            Some(TerminalAgentActivityObservation {
                state: activity.snapshot(),
                epoch: 0,
                kind: TerminalAgentActivityObservationKind::Unavailable,
            }),
            "observer cleanup must publish unavailable before it awaits reconciliation",
        );
        let snapshot = projection
            .snapshot(&ActivityScopeRef::Terminal {
                thread_id: "thread-server-exit".to_owned(),
                terminal_id: "terminal-server-exit".to_owned(),
            })
            .await
            .expect("retained activity");
        assert_eq!(snapshot.actors.len(), 1);
        assert_eq!(
            snapshot.actors[0].status,
            ActivityLifecycle::Interrupted,
            "unexpected sink termination must not leave activity live"
        );
    }

    #[tokio::test]
    async fn dormant_shutdown_reconciliation_does_not_publish_interruptions() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection = ActivityProjection::new(ActivityRepository::new(database));
        let generation = TerminalObserverGeneration::new(
            "thread-dormant-shutdown".to_owned(),
            "terminal-dormant-shutdown".to_owned(),
        );
        let root = tempfile::tempdir().expect("observer resources");
        let generation_dir = root.path().join("generation");
        std::fs::create_dir(&generation_dir).expect("generation directory");
        let inner = ClaudeObserverInner {
            resources: Arc::new(ClaudeObserverResources {
                listener: Mutex::new(None),
                overlay_path: generation_dir.join("settings.json"),
                runtime_dir: root.path().to_path_buf(),
                generation_dir,
                cleaned: AtomicBool::new(false),
            }),
            publisher: TerminalGenerationActivityPublisher::new(
                generation,
                projection.clone(),
                Arc::new(tokio::sync::Mutex::new(())),
            ),
            provider_instance_id: "claudeAgent".to_owned(),
            token: Arc::new("unused".to_owned()),
            correlation: Arc::new("unused".to_owned()),
            spawned: AtomicBool::new(true),
            activity: Arc::new(TerminalAgentActivityControl::enabled()),
            listener_lifecycle: AtomicU64::new(pack_claude_listener_lifecycle(
                ClaudeListenerLifecycle {
                    ready: true,
                    epoch: 1,
                },
            )),
        };
        let mut actors = HashMap::new();
        let actor = ActivityActorSummary::try_new(
            "agent-1",
            None,
            "Explore",
            None,
            Some("claude"),
            ActivityLifecycle::Running,
            None,
            "2026-07-30T00:00:00Z",
            "2026-07-30T00:00:00Z",
            None,
        )
        .expect("activity actor");
        actors.insert(actor.id.clone(), actor);
        let _ = inner.activity.transition_state(false);

        interrupt_claude_activity(&inner, &actors, &HashMap::new(), 0).await;

        assert!(
            projection
                .snapshot(&ActivityScopeRef::Terminal {
                    thread_id: "thread-dormant-shutdown".to_owned(),
                    terminal_id: "terminal-dormant-shutdown".to_owned(),
                })
                .await
                .is_err(),
            "dormant shutdown reconciliation must not publish interruptions",
        );
    }

    #[test]
    fn claude_hooks_map_to_the_main_agent_state() {
        let hook = |event: &str, extra: Value| {
            let mut value = json!({ "hook_event_name": event, "session_id": "s" });
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            claude_hook_agent_status(&serde_json::from_value(value).expect("status hook"))
        };
        use ClaudeAgentReport::{Set, ToolFinished};
        use TerminalAgentState::{Blocked, Done, Waiting, Working};
        assert_eq!(hook("SessionStart", json!({})), Some(Set(Done, false)));
        assert_eq!(
            hook("UserPromptSubmit", json!({})),
            Some(Set(Working, false))
        );
        assert_eq!(
            hook("PreToolUse", json!({"tool_name":"Bash"})),
            Some(Set(Working, false))
        );
        assert_eq!(
            hook("PreToolUse", json!({"tool_name":"AskUserQuestion"})),
            Some(Set(Waiting, false))
        );
        assert_eq!(
            hook("PreToolUse", json!({"tool_name":"Bash","agent_id":"sub"})),
            None,
            "a subagent's tool leaves the main state alone"
        );
        assert_eq!(
            hook("PostToolUse", json!({"tool_name":"Bash"})),
            Some(Set(Working, false))
        );
        assert_eq!(
            hook(
                "PostToolUseFailure",
                json!({"tool_name":"Bash","agent_id":"sub"})
            ),
            Some(ToolFinished),
            "a subagent's finished tool may end an approval prompt"
        );
        assert_eq!(
            hook("PermissionRequest", json!({})),
            Some(Set(Blocked, false))
        );
        assert_eq!(
            hook(
                "Notification",
                json!({"notification_type":"permission_prompt"})
            ),
            Some(Set(Blocked, false))
        );
        assert_eq!(
            hook("Notification", json!({"notification_type":"idle_prompt"})),
            Some(Set(Done, false)),
            "Claude waiting on the next prompt is done"
        );
        assert_eq!(
            hook("Notification", json!({"notification_type":"auth_success"})),
            None
        );
        assert_eq!(hook("Elicitation", json!({})), Some(Set(Waiting, false)));
        assert_eq!(
            hook("ElicitationResult", json!({})),
            Some(Set(Working, false))
        );
        assert_eq!(hook("Stop", json!({})), Some(Set(Done, false)));
        assert_eq!(hook("StopFailure", json!({})), Some(Set(Done, true)));
        assert_eq!(hook("SubagentStart", json!({})), None);
        assert_eq!(
            claude_hook_agent_status(
                &serde_json::from_value(json!({"hook_event_name":"Stop"})).unwrap()
            ),
            None,
            "a hook without a session is not trusted"
        );
    }

    #[test]
    fn status_hooks_keep_no_prompt_or_tool_content() {
        // Mutation caught: the status path decoding a hook whole, so a prompt or tool output
        // is read and held while AI Terminal activity is off (#187).
        let hook: ClaudeStatusHook = serde_json::from_value(json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": "s",
            "prompt": "private prompt text",
            "tool_input": {"command": "private tool input"},
            "tool_response": "private tool output",
            "transcript_path": "/private/transcript.jsonl",
        }))
        .expect("status hook");
        let kept = format!("{hook:?}");
        for private in ["private prompt", "private tool", "transcript"] {
            assert!(!kept.contains(private), "{kept}");
        }
    }

    #[tokio::test]
    async fn status_hooks_publish_with_activity_off_and_never_reach_the_activity_worker() {
        let generation = TerminalObserverGeneration::new(
            "thread-status-only".to_owned(),
            "terminal-status-only".to_owned(),
        );
        let status = generation.observation().subscribe_agent_status();
        let (requests, mut request_receiver) = mpsc::channel(4);
        let state = ClaudeHookState {
            token: Arc::new("token".to_owned()),
            correlation: Arc::new("correlation".to_owned()),
            activity: Arc::new(TerminalAgentActivityControl::with_enabled(false)),
            requests,
            request_permits: Arc::new(Semaphore::new(4)),
            status: generation.observation(),
            status_session: Arc::new(Mutex::new(None)),
        };
        let send = |token: &str, body: Value| {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
            headers.insert(
                CLAUDE_HOOK_CORRELATION_HEADER,
                "correlation".parse().unwrap(),
            );
            headers.insert(CONTENT_TYPE, "application/json".parse().unwrap());
            let state = state.clone();
            async move {
                capture_claude_hook(State(state), headers, Body::from(body.to_string()))
                    .await
                    .into_response()
                    .status()
            }
        };

        let refused = send(
            "wrong",
            json!({"hook_event_name":"UserPromptSubmit","session_id":"s"}),
        )
        .await;
        assert_eq!(refused, StatusCode::FORBIDDEN);
        assert!(
            status.borrow().is_none(),
            "an unauthenticated hook reports nothing"
        );

        for (event, extra, expected) in [
            ("UserPromptSubmit", json!({}), TerminalAgentState::Working),
            ("PermissionRequest", json!({}), TerminalAgentState::Blocked),
            (
                "PreToolUse",
                json!({"tool_name":"Bash","tool_use_id":"t"}),
                TerminalAgentState::Working,
            ),
            ("Stop", json!({}), TerminalAgentState::Done),
        ] {
            let mut body = json!({"hook_event_name":event, "session_id":"s"});
            body.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert_eq!(send("token", body).await, StatusCode::NO_CONTENT);
            assert_eq!(
                status.borrow().map(|observation| observation.state),
                Some(expected),
                "{event}"
            );
        }
        assert!(
            request_receiver.try_recv().is_err(),
            "dormant activity forwards nothing to the activity worker"
        );
        let state_of = || status.borrow().map(|observation| observation.state);

        // A subagent's finished tool ends an approval prompt, and only that.
        let subagent_tool = json!({
            "hook_event_name":"PostToolUse", "session_id":"s", "agent_id":"sub", "tool_name":"Bash"
        });
        assert_eq!(
            send("token", subagent_tool.clone()).await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            state_of(),
            Some(TerminalAgentState::Done),
            "done stays done"
        );
        send(
            "token",
            json!({"hook_event_name":"PermissionRequest","session_id":"s"}),
        )
        .await;
        send("token", subagent_tool).await;
        assert_eq!(state_of(), Some(TerminalAgentState::Working));

        // Another session's hooks leave the main one alone until a new session starts.
        send(
            "token",
            json!({"hook_event_name":"Stop","session_id":"other"}),
        )
        .await;
        assert_eq!(state_of(), Some(TerminalAgentState::Working));
        send(
            "token",
            json!({"hook_event_name":"SessionStart","session_id":"cleared","source":"clear"}),
        )
        .await;
        assert_eq!(state_of(), Some(TerminalAgentState::Done));
        send(
            "token",
            json!({"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"old"}),
        )
        .await;
        assert_eq!(
            state_of(),
            Some(TerminalAgentState::Done),
            "the session before /clear no longer reports"
        );
        send(
            "token",
            json!({"hook_event_name":"UserPromptSubmit","session_id":"cleared","prompt":"new"}),
        )
        .await;
        assert_eq!(state_of(), Some(TerminalAgentState::Working));

        // A replaced generation's late hook is ignored.
        generation.invalidate().await;
        let late = send(
            "token",
            json!({"hook_event_name":"Stop","session_id":"cleared"}),
        )
        .await;
        assert_eq!(late, StatusCode::NO_CONTENT);
        assert_eq!(
            status.borrow().map(|observation| observation.state),
            Some(TerminalAgentState::Working)
        );
    }
}
