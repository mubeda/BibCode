use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fmt,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::Duration,
};

use base64::Engine as _;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Child,
    task::JoinHandle,
};

use super::{
    PreparedTerminalLaunch, PreparedTerminalObserver, ProviderTerminalObserverFactory,
    ProviderTerminalObserverFactoryInput, TerminalAgentActivityAdmission,
    TerminalAgentActivityControl, TerminalAgentActivityObservation,
    TerminalAgentActivityObservationKind, TerminalAgentActivityState,
    TerminalAgentActivityTransition, TerminalGenerationActivityPublisher,
    TerminalObserverGeneration, TerminalObserverWorkerContext,
};
#[cfg(test)]
use crate::provider::opencode::sse::OPENCODE_SSE_EVENT_LIMIT;
use crate::{
    activity::{ActivityCapabilities, ActivityHistoryRecovery, ProviderActivityMutation},
    process::{
        configure_background_command,
        supervised::{SupervisedOverflow, SupervisedRunRequest, run_supervised},
    },
    provider::opencode::activity::{
        MAX_RECONCILED_CHILDREN, OpenCodeActivityOutput, OpenCodeActivityTracker,
    },
    provider::opencode::sse::OpenCodeSseDecoder,
};

const OPENCODE_PROBE_OUTPUT_LIMIT: usize = 128 * 1024;
const OPENCODE_CAPABILITY_CACHE_CAPACITY: usize = 64;
const OPENCODE_CONFIG_CONTENT_LIMIT: usize = 64 * 1024;
const OPENCODE_HTTP_BODY_LIMIT: usize = 1024 * 1024;
const OPENCODE_HELPER_READY_TIMEOUT: Duration = Duration::from_secs(3);
const OPENCODE_HELPER_TERM_GRACE: Duration = Duration::from_millis(100);
const OPENCODE_HELPER_REAP_TIMEOUT: Duration = Duration::from_millis(100);
#[cfg(unix)]
const OPENCODE_WAITID_EINTR_RETRY_LIMIT: usize = 8;
const OPENCODE_PRE_SPAWN_DELETE_TIMEOUT: Duration = Duration::from_millis(100);
const OPENCODE_PREPARATION_BUDGET: Duration = Duration::from_millis(850);
const OPENCODE_REQUEST_TIMEOUT: Duration = Duration::from_millis(500);
const OPENCODE_OBSERVATION_ACK_GRACE: Duration = Duration::from_millis(100);
const OPENCODE_REATTACH_REQUEST_LIMIT: u32 = (MAX_RECONCILED_CHILDREN as u32) * 2 + 2;
const OPENCODE_RECONCILIATION_INTERVAL: Duration = Duration::from_secs(2);
const OPENCODE_SSE_RETRY_MIN: Duration = Duration::from_millis(100);
const OPENCODE_SSE_RETRY_MAX: Duration = Duration::from_secs(2);
const OPENCODE_USERNAME: &str = "opencode";
const OPENCODE_CLEANUP_IDLE: u8 = 0;
const OPENCODE_CLEANUP_IN_PROGRESS: u8 = 1;
const OPENCODE_CLEANUP_REAPED: u8 = 2;
const OPENCODE_CLEANUP_FALLBACK_TERMINATED: u8 = 3;

fn complete_opencode_reattach_timeout(handshake_timeout: Duration) -> Duration {
    handshake_timeout
        .saturating_mul(2)
        .saturating_add(OPENCODE_REQUEST_TIMEOUT.saturating_mul(OPENCODE_REATTACH_REQUEST_LIMIT))
}

#[derive(Clone, Eq, PartialEq)]
pub struct OpenCodeProbeOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl fmt::Debug for OpenCodeProbeOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenCodeProbeOutput")
            .field("success", &self.success)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .finish()
    }
}

pub trait OpenCodeCapabilityProbeRunner: Send + Sync {
    fn run(
        &self,
        executable: &Path,
        args: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<OpenCodeProbeOutput, String>> + Send + '_>>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenCodeCapabilities {
    pub serve: bool,
    pub attach: bool,
}

pub struct CachedOpenCodeCapabilityProbe {
    runner: Arc<dyn OpenCodeCapabilityProbeRunner>,
    cache: tokio::sync::Mutex<OpenCodeCapabilityCache>,
}

impl fmt::Debug for CachedOpenCodeCapabilityProbe {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CachedOpenCodeCapabilityProbe")
            .finish_non_exhaustive()
    }
}

impl CachedOpenCodeCapabilityProbe {
    #[must_use]
    pub fn new(runner: Arc<dyn OpenCodeCapabilityProbeRunner>) -> Self {
        Self {
            runner,
            cache: tokio::sync::Mutex::new(OpenCodeCapabilityCache::default()),
        }
    }

    pub async fn probe(&self, executable: &Path) -> Option<OpenCodeCapabilities> {
        let path = std::fs::canonicalize(executable).unwrap_or_else(|_| executable.to_path_buf());
        let fingerprint = OpenCodeExecutableFingerprint::read(&path);
        let mut cache = self.cache.lock().await;
        if let Some(capabilities) = fingerprint
            .as_ref()
            .and_then(|fingerprint| cache.get(fingerprint))
        {
            return Some(capabilities);
        }
        let capabilities = self.probe_uncached(&path).await;
        if OpenCodeExecutableFingerprint::read(&path) != fingerprint {
            return None;
        }
        if let (Some(fingerprint), Some(capabilities)) = (fingerprint, &capabilities) {
            cache.insert(fingerprint, capabilities.clone());
        }
        capabilities
    }

    async fn probe_uncached(&self, executable: &Path) -> Option<OpenCodeCapabilities> {
        let attach = self
            .runner
            .run(executable, vec!["attach".to_owned(), "--help".to_owned()])
            .await
            .ok()?;
        if !attach.success {
            return None;
        }
        let attach_help = bounded_probe_text(&attach.stdout, &attach.stderr);
        Some(OpenCodeCapabilities {
            // `serve` is proven by the concurrently launched helper reaching
            // its post-bind readiness line and authenticated health endpoint.
            serve: true,
            attach: attach_help.contains("opencode attach <url>")
                && attach_help.contains("--dir")
                && attach_help.contains("--session"),
        })
    }
}

#[derive(Debug, Default)]
struct OpenCodeCapabilityCache {
    entries: HashMap<OpenCodeExecutableFingerprint, OpenCodeCapabilities>,
    recency: VecDeque<OpenCodeExecutableFingerprint>,
}

impl OpenCodeCapabilityCache {
    fn get(&mut self, fingerprint: &OpenCodeExecutableFingerprint) -> Option<OpenCodeCapabilities> {
        let capabilities = self.entries.get(fingerprint)?.clone();
        self.recency.retain(|cached| cached != fingerprint);
        self.recency.push_back(fingerprint.clone());
        Some(capabilities)
    }

    fn insert(
        &mut self,
        fingerprint: OpenCodeExecutableFingerprint,
        capabilities: OpenCodeCapabilities,
    ) {
        self.entries
            .retain(|cached, _| cached.path != fingerprint.path);
        self.recency
            .retain(|cached| cached.path != fingerprint.path);
        while self.entries.len() >= OPENCODE_CAPABILITY_CACHE_CAPACITY {
            let Some(oldest) = self.recency.pop_front() else {
                self.entries.clear();
                break;
            };
            self.entries.remove(&oldest);
        }
        self.entries.insert(fingerprint.clone(), capabilities);
        self.recency.push_back(fingerprint);
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct OpenCodeExecutableFingerprint {
    path: PathBuf,
    length: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

impl OpenCodeExecutableFingerprint {
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
            changed_seconds: metadata.ctime(),
            #[cfg(unix)]
            changed_nanoseconds: metadata.ctime_nsec(),
        })
    }
}

fn bounded_probe_text(stdout: &str, stderr: &str) -> String {
    let mut output = String::new();
    for value in [stdout, stderr] {
        let remaining = OPENCODE_PROBE_OUTPUT_LIMIT.saturating_sub(output.len());
        if remaining == 0 {
            break;
        }
        let end = value
            .char_indices()
            .map(|(index, _)| index)
            .take_while(|index| *index <= remaining)
            .last()
            .unwrap_or_default();
        output.push_str(if value.len() <= remaining {
            value
        } else {
            &value[..end]
        });
        output.push('\n');
    }
    output
}

fn parse_opencode_version(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|part| {
            let components = part.split('.').collect::<Vec<_>>();
            components.len() == 3
                && components.iter().all(|component| {
                    !component.is_empty()
                        && component
                            .chars()
                            .all(|character| character.is_ascii_digit())
                        && (component.len() == 1 || !component.starts_with('0'))
                })
        })
        .map(str::to_owned)
}

#[derive(Clone)]
pub struct OpenCodeHelperLaunch {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

impl fmt::Debug for OpenCodeHelperLaunch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenCodeHelperLaunch")
            .field("executable", &self.executable)
            .field("arg_count", &self.args.len())
            .field("cwd", &self.cwd)
            .field("env_keys", &self.env.keys())
            .finish()
    }
}

pub trait OpenCodeHelperProcess: Send + Sync + fmt::Debug {
    /// Returns true when the owned helper has already exited or its state can
    /// no longer be observed safely.
    fn has_exited(&self) -> bool {
        false
    }

    /// Emergency signal-only fallback for cancellation during synchronous
    /// teardown or process drop.
    fn terminate(&self);

    fn terminate_and_reap(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.terminate();
        Box::pin(std::future::ready(()))
    }
}

struct OpenCodeHelperGuard {
    process: Option<Arc<dyn OpenCodeHelperProcess>>,
}

impl OpenCodeHelperGuard {
    fn new(process: Arc<dyn OpenCodeHelperProcess>) -> Self {
        Self {
            process: Some(process),
        }
    }

    fn into_process(mut self) -> Arc<dyn OpenCodeHelperProcess> {
        self.process
            .take()
            .expect("OpenCode helper guard owns a process")
    }
}

impl Drop for OpenCodeHelperGuard {
    fn drop(&mut self) {
        if let Some(process) = self.process.take() {
            process.terminate();
        }
    }
}

pub struct OpenCodeHelperReady {
    pub endpoint: String,
    pub process: Arc<dyn OpenCodeHelperProcess>,
}

impl fmt::Debug for OpenCodeHelperReady {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenCodeHelperReady")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

pub trait OpenCodeHelperLauncher: Send + Sync + fmt::Debug {
    fn start(
        &self,
        launch: OpenCodeHelperLaunch,
    ) -> Pin<Box<dyn Future<Output = Result<OpenCodeHelperReady, String>> + Send + '_>>;
}

pub trait OpenCodeEventStream: Send {
    fn discard_next(&mut self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>>;

    fn next_data(&mut self) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + '_>>;
}

pub trait OpenCodeRemoteClient: Send {
    fn create_root(
        &mut self,
        model: &str,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>>;

    fn cleanup_pre_spawn(
        &mut self,
        root_session_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>>;

    fn abort(
        &mut self,
        root_session_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>>;

    fn root(
        &mut self,
        root_session_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>>;

    fn statuses(&mut self) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>>;

    fn children(
        &mut self,
        session_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>>;

    fn messages(
        &mut self,
        session_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>>;

    fn open_event_stream(&mut self) -> OpenCodeEventStreamFuture<'_>;
}

type OpenCodeEventStreamFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Box<dyn OpenCodeEventStream>, String>> + Send + 'a>>;
type OpenCodeRemoteClientFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Box<dyn OpenCodeRemoteClient>, String>> + Send + 'a>>;

pub trait OpenCodeRemoteClientFactory: Send + Sync + fmt::Debug {
    fn connect(
        &self,
        endpoint: &str,
        username: &str,
        password: &str,
        directory: &Path,
    ) -> OpenCodeRemoteClientFuture<'_>;
}

pub struct OpenCodeTerminalObserverFactory {
    probe: Arc<CachedOpenCodeCapabilityProbe>,
    helper: Arc<dyn OpenCodeHelperLauncher>,
    remote: Arc<dyn OpenCodeRemoteClientFactory>,
    handshake_timeout: Duration,
    reattach_timeout: Duration,
}

impl fmt::Debug for OpenCodeTerminalObserverFactory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenCodeTerminalObserverFactory")
            .field("handshake_timeout", &self.handshake_timeout)
            .field("reattach_timeout", &self.reattach_timeout)
            .finish_non_exhaustive()
    }
}

impl OpenCodeTerminalObserverFactory {
    #[must_use]
    pub fn new(
        probe: Arc<CachedOpenCodeCapabilityProbe>,
        helper: Arc<dyn OpenCodeHelperLauncher>,
        remote: Arc<dyn OpenCodeRemoteClientFactory>,
        handshake_timeout: Duration,
    ) -> Self {
        let reattach_timeout = complete_opencode_reattach_timeout(handshake_timeout);
        Self::new_with_reattach_timeout(probe, helper, remote, handshake_timeout, reattach_timeout)
    }

    #[doc(hidden)]
    #[must_use]
    pub fn new_with_reattach_timeout(
        probe: Arc<CachedOpenCodeCapabilityProbe>,
        helper: Arc<dyn OpenCodeHelperLauncher>,
        remote: Arc<dyn OpenCodeRemoteClientFactory>,
        handshake_timeout: Duration,
        reattach_timeout: Duration,
    ) -> Self {
        Self {
            probe,
            helper,
            remote,
            handshake_timeout,
            reattach_timeout,
        }
    }

    #[must_use]
    pub fn system() -> Self {
        Self::new(
            Arc::new(CachedOpenCodeCapabilityProbe::new(Arc::new(
                SystemOpenCodeCapabilityProbeRunner,
            ))),
            Arc::new(SystemOpenCodeHelperLauncher),
            Arc::new(SystemOpenCodeRemoteClientFactory),
            Duration::from_secs(10),
        )
    }

    async fn prepare_inner(
        &self,
        input: ProviderTerminalObserverFactoryInput,
    ) -> Option<PreparedTerminalLaunch> {
        tokio::time::timeout(OPENCODE_PREPARATION_BUDGET, self.prepare_bounded(input))
            .await
            .ok()
            .flatten()
    }

    async fn prepare_bounded(
        &self,
        input: ProviderTerminalObserverFactoryInput,
    ) -> Option<PreparedTerminalLaunch> {
        let model = opencode_model_arg(&input.launch.args)?;
        validate_opencode_config(input.launch.launch_env.get("OPENCODE_CONFIG_CONTENT"))?;
        let password = random_secret()?;
        let mut helper_env = input.launch.launch_env.clone();
        helper_env.insert(
            "OPENCODE_SERVER_USERNAME".to_owned(),
            OPENCODE_USERNAME.to_owned(),
        );
        helper_env.insert("OPENCODE_SERVER_PASSWORD".to_owned(), password.clone());
        let helper_launch = OpenCodeHelperLaunch {
            executable: input.launch.executable.clone(),
            args: vec![
                "serve".to_owned(),
                "--hostname".to_owned(),
                "127.0.0.1".to_owned(),
                "--port".to_owned(),
                "0".to_owned(),
                "--print-logs".to_owned(),
                "--log-level".to_owned(),
                "INFO".to_owned(),
            ],
            cwd: input.launch.cwd.clone(),
            env: helper_env,
        };
        let cleanup_generation = input.launch.generation.clone();
        let helper = async {
            let ready = self.helper.start(helper_launch).await?;
            let resources = Arc::new(OpenCodeObserverResources {
                helper: OpenCodeHelperGuard::new(ready.process).into_process(),
                owned_root: Mutex::new(None),
                launched: AtomicBool::new(false),
                cleanup_state: AtomicU8::new(OPENCODE_CLEANUP_IDLE),
                ownership_transferred: tokio::sync::Notify::new(),
            });
            let cleanup_resources = resources.clone();
            let worker_generation = cleanup_generation.clone();
            if cleanup_generation
                .worker_context()
                .spawn(async move {
                    monitor_opencode_pre_spawn(cleanup_resources, worker_generation).await;
                })
                .is_err()
            {
                cleanup_opencode_pre_spawn(resources).await;
                return Err("OpenCode pre-launch cleanup worker was unavailable".to_owned());
            }
            Ok((ready.endpoint, resources))
        };
        let (capabilities, ready) = tokio::join!(
            self.probe.probe(Path::new(&input.launch.executable)),
            helper,
        );
        let (endpoint, resources) = ready.ok()?;
        let capabilities = capabilities?;
        if !capabilities.serve || !capabilities.attach {
            return None;
        };
        if !valid_loopback_endpoint(&endpoint) {
            return None;
        }
        let mut remote = match self
            .remote
            .connect(&endpoint, OPENCODE_USERNAME, &password, &input.launch.cwd)
            .await
        {
            Ok(remote) => remote,
            Err(_) => return None,
        };
        let root_session_id = match remote.create_root(&model).await {
            Ok(root_session_id) if valid_native_id(&root_session_id) => root_session_id,
            _ => return None,
        };
        *resources
            .owned_root
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(OpenCodeOwnedRoot {
            remote,
            root_session_id: root_session_id.clone(),
        });
        if resources.helper.has_exited() {
            cleanup_opencode_pre_spawn(resources).await;
            return None;
        }
        let observer = OpenCodePreparedTerminalObserver {
            inner: Arc::new(OpenCodeObserverInner {
                resources,
                endpoint: endpoint.clone(),
                password: password.clone(),
                directory: input.launch.cwd.clone(),
                remote: self.remote.clone(),
                root_session_id: root_session_id.clone(),
                publisher: input.activity_publisher,
                provider_instance_id: input.launch.activity.provider_instance_id,
                handshake_timeout: self.handshake_timeout,
                reattach_timeout: self.reattach_timeout,
                spawned: AtomicBool::new(false),
                activity: Arc::new(TerminalAgentActivityControl::enabled()),
            }),
        };
        Some(PreparedTerminalLaunch {
            executable: input.launch.executable,
            args: vec![
                "attach".to_owned(),
                endpoint,
                "--dir".to_owned(),
                input.launch.cwd.to_string_lossy().into_owned(),
                "--session".to_owned(),
                root_session_id,
            ],
            private_env: BTreeMap::from([
                (
                    "OPENCODE_SERVER_USERNAME".to_owned(),
                    OPENCODE_USERNAME.to_owned(),
                ),
                ("OPENCODE_SERVER_PASSWORD".to_owned(), password),
            ]),
            observer: Box::new(observer),
        })
    }
}

impl ProviderTerminalObserverFactory for OpenCodeTerminalObserverFactory {
    fn prepare(
        &self,
        input: ProviderTerminalObserverFactoryInput,
    ) -> Pin<Box<dyn Future<Output = Option<PreparedTerminalLaunch>> + Send + '_>> {
        Box::pin(self.prepare_inner(input))
    }
}

fn opencode_model_arg(args: &[String]) -> Option<String> {
    match args {
        [flag, model] if matches!(flag.as_str(), "--model" | "-m") && valid_model(model) => {
            Some(model.clone())
        }
        [argument] => argument
            .strip_prefix("--model=")
            .filter(|model| valid_model(model))
            .map(str::to_owned),
        _ => None,
    }
}

fn valid_model(model: &str) -> bool {
    model.len() <= 256
        && !model.chars().any(char::is_control)
        && model
            .split_once('/')
            .is_some_and(|(provider, id)| !provider.is_empty() && !id.is_empty())
}

fn validate_opencode_config(existing: Option<&String>) -> Option<()> {
    match existing {
        None => Some(()),
        Some(existing) if existing.len() <= OPENCODE_CONFIG_CONTENT_LIMIT => {
            serde_json::from_str::<Value>(existing).ok()?.as_object()?;
            Some(())
        }
        Some(_) => None,
    }
}

fn valid_native_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn valid_loopback_endpoint(endpoint: &str) -> bool {
    let Ok(url) = url::Url::parse(endpoint) else {
        return false;
    };
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some_and(|port| port != 0)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
}

fn random_secret() -> Option<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Debug)]
struct OpenCodePreparedTerminalObserver {
    inner: Arc<OpenCodeObserverInner>,
}

impl PreparedTerminalObserver for OpenCodePreparedTerminalObserver {
    fn is_ready_for_on_spawned(&self) -> bool {
        !self.inner.resources.helper.has_exited()
    }

    fn on_spawned(
        &self,
        _pid: u32,
        generation: TerminalObserverGeneration,
        workers: TerminalObserverWorkerContext,
    ) {
        if self.inner.spawned.swap(true, Ordering::AcqRel) {
            return;
        }
        let inner = self.inner.clone();
        if workers
            .spawn(async move {
                run_opencode_observer(inner, generation).await;
            })
            .is_ok()
        {
            self.inner.resources.transfer_ownership();
        }
    }

    fn set_agent_activity_enabled(
        &self,
        enabled: bool,
        _generation: TerminalObserverGeneration,
        _workers: TerminalObserverWorkerContext,
    ) -> Pin<Box<dyn Future<Output = TerminalAgentActivityTransition> + Send + '_>> {
        Box::pin(async move {
            let (mut transition, observed_epoch) = self
                .inner
                .activity
                .transition_observed_with_epoch(
                    enabled,
                    self.inner
                        .reattach_timeout
                        .saturating_add(OPENCODE_OBSERVATION_ACK_GRACE),
                )
                .await;
            transition.epochs.opencode = observed_epoch.unwrap_or_default();
            transition
        })
    }

    fn agent_activity_enable_ack_timeout(&self) -> Option<Duration> {
        Some(self.inner.reattach_timeout)
    }

    fn diagnostic_label(&self) -> &str {
        "opencode-authenticated-serve-attach"
    }
}

struct OpenCodeObserverInner {
    resources: Arc<OpenCodeObserverResources>,
    endpoint: String,
    password: String,
    directory: PathBuf,
    remote: Arc<dyn OpenCodeRemoteClientFactory>,
    root_session_id: String,
    publisher: TerminalGenerationActivityPublisher,
    provider_instance_id: String,
    handshake_timeout: Duration,
    reattach_timeout: Duration,
    spawned: AtomicBool,
    activity: Arc<TerminalAgentActivityControl>,
}

impl fmt::Debug for OpenCodeObserverInner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenCodeObserverInner")
            .field("scope_id", &self.publisher.scope_id())
            .finish_non_exhaustive()
    }
}

struct OpenCodeObserverResources {
    helper: Arc<dyn OpenCodeHelperProcess>,
    owned_root: Mutex<Option<OpenCodeOwnedRoot>>,
    launched: AtomicBool,
    cleanup_state: AtomicU8,
    ownership_transferred: tokio::sync::Notify,
}

struct OpenCodeOwnedRoot {
    remote: Box<dyn OpenCodeRemoteClient>,
    root_session_id: String,
}

impl OpenCodeObserverResources {
    fn transfer_ownership(&self) {
        self.launched.store(true, Ordering::Release);
        self.ownership_transferred.notify_one();
    }

    async fn cleanup_helper(&self) {
        let Some(cleanup) = self.begin_cleanup() else {
            return;
        };
        self.helper.terminate_and_reap().await;
        cleanup.complete();
    }

    fn begin_cleanup(&self) -> Option<OpenCodeCleanupClaim<'_>> {
        self.cleanup_state
            .compare_exchange(
                OPENCODE_CLEANUP_IDLE,
                OPENCODE_CLEANUP_IN_PROGRESS,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .ok()
            .map(|_| OpenCodeCleanupClaim {
                resources: self,
                completed: false,
            })
    }
}

impl Drop for OpenCodeObserverResources {
    fn drop(&mut self) {
        if self
            .cleanup_state
            .compare_exchange(
                OPENCODE_CLEANUP_IDLE,
                OPENCODE_CLEANUP_FALLBACK_TERMINATED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
        {
            self.helper.terminate();
        }
    }
}

struct OpenCodeCleanupClaim<'a> {
    resources: &'a OpenCodeObserverResources,
    completed: bool,
}

impl OpenCodeCleanupClaim<'_> {
    fn complete(mut self) {
        self.resources
            .cleanup_state
            .store(OPENCODE_CLEANUP_REAPED, Ordering::Release);
        self.completed = true;
    }
}

impl Drop for OpenCodeCleanupClaim<'_> {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        self.resources.helper.terminate();
        self.resources
            .cleanup_state
            .store(OPENCODE_CLEANUP_FALLBACK_TERMINATED, Ordering::Release);
    }
}

async fn monitor_opencode_pre_spawn(
    resources: Arc<OpenCodeObserverResources>,
    generation: TerminalObserverGeneration,
) {
    if resources.launched.load(Ordering::Acquire) {
        return;
    }
    tokio::select! {
        _ = resources.ownership_transferred.notified() => {}
        _ = generation.cancelled() => {
            if !resources.launched.load(Ordering::Acquire) {
                cleanup_opencode_pre_spawn(resources).await;
            }
        }
    }
}

async fn cleanup_opencode_pre_spawn(resources: Arc<OpenCodeObserverResources>) {
    let Some(cleanup) = resources.begin_cleanup() else {
        return;
    };
    let owned_root = resources
        .owned_root
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some(mut owned_root) = owned_root {
        let _ = tokio::time::timeout(
            OPENCODE_PRE_SPAWN_DELETE_TIMEOUT,
            owned_root
                .remote
                .cleanup_pre_spawn(&owned_root.root_session_id),
        )
        .await;
    }
    resources.helper.terminate_and_reap().await;
    cleanup.complete();
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OpenCodeObserverMode {
    Live,
    Dormant,
    Unavailable,
}

enum OpenCodeReplacementOutcome {
    Connected(Box<dyn OpenCodeEventStream>),
    Failed { dormant_stream_healthy: bool },
    Superseded { dormant_stream_healthy: bool },
    Cancelled,
}

enum OpenCodeObserverEvent {
    Cancelled,
    ActivityChanged(bool),
    Reconcile,
    Data(Result<Vec<u8>, String>),
    Discard(Result<(), String>),
}

enum OpenCodeLiveWork<T> {
    Cancelled,
    ActivityChanged(bool),
    Completed(T),
}

enum OpenCodeLiveData {
    Stale,
    Malformed,
    Output {
        admission: TerminalAgentActivityAdmission,
        output: OpenCodeActivityOutput,
    },
}

#[derive(Clone, Copy)]
struct OpenCodeLiveFence<'a> {
    activity: &'a TerminalAgentActivityControl,
    generation: &'a TerminalObserverGeneration,
    state: TerminalAgentActivityState,
}

#[derive(Clone, Copy)]
struct OpenCodeLivePublication<'a> {
    fence: OpenCodeLiveFence<'a>,
    admission: TerminalAgentActivityAdmission,
}

impl OpenCodeLiveFence<'_> {
    fn is_current(self) -> bool {
        self.generation.cancellation_reason().is_none()
            && self.generation.is_current()
            && self.activity.snapshot() == self.state
    }
}

impl OpenCodeLivePublication<'_> {
    fn is_current(self) -> bool {
        opencode_live_work_is_current(self.fence, &self.admission)
    }
}

async fn wait_for_opencode_live_work<T>(
    activity: &mut tokio::sync::watch::Receiver<TerminalAgentActivityState>,
    generation: &TerminalObserverGeneration,
    work: impl Future<Output = T>,
) -> OpenCodeLiveWork<T> {
    tokio::pin!(work);
    tokio::select! {
        biased;
        _ = generation.cancelled() => OpenCodeLiveWork::Cancelled,
        changed = activity.changed() => OpenCodeLiveWork::ActivityChanged(changed.is_ok()),
        completed = &mut work => OpenCodeLiveWork::Completed(completed),
    }
}

fn admit_opencode_live_work(
    fence: OpenCodeLiveFence<'_>,
) -> Option<TerminalAgentActivityAdmission> {
    if !fence.is_current() {
        return None;
    }
    let admission = fence.activity.admit()?;
    (fence.activity.admission_is_current(&admission) && fence.is_current()).then_some(admission)
}

fn opencode_live_work_is_current(
    fence: OpenCodeLiveFence<'_>,
    admission: &TerminalAgentActivityAdmission,
) -> bool {
    fence.activity.admission_is_current(admission) && fence.is_current()
}

fn decode_and_track_opencode_live_data(
    fence: OpenCodeLiveFence<'_>,
    tracker: &mut OpenCodeActivityTracker,
    data: &[u8],
    received_at_ms: u64,
) -> OpenCodeLiveData {
    let Some(admission) = admit_opencode_live_work(fence) else {
        return OpenCodeLiveData::Stale;
    };
    let Ok(event) = serde_json::from_slice::<Value>(data) else {
        return OpenCodeLiveData::Malformed;
    };
    if !opencode_live_work_is_current(fence, &admission) {
        return OpenCodeLiveData::Stale;
    }
    let output = tracker.handle_observed_event_at(&event, received_at_ms);
    if !opencode_live_work_is_current(fence, &admission) {
        return OpenCodeLiveData::Stale;
    }
    OpenCodeLiveData::Output { admission, output }
}

async fn run_opencode_observer(
    inner: Arc<OpenCodeObserverInner>,
    generation: TerminalObserverGeneration,
) {
    let mut activity = inner.activity.subscribe();
    let owned_root = inner
        .resources
        .owned_root
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    let mut remote = if let Some(owned_root) = owned_root {
        owned_root.remote
    } else {
        let Ok(remote) = inner
            .remote
            .connect(
                &inner.endpoint,
                OPENCODE_USERNAME,
                &inner.password,
                &inner.directory,
            )
            .await
        else {
            generation.cancelled().await;
            inner.resources.cleanup_helper().await;
            return;
        };
        remote
    };
    let root_session_id = inner.root_session_id.clone();
    let correlated = tokio::time::timeout(
        inner.handshake_timeout,
        wait_for_owned_root(&mut *remote, &root_session_id, &generation),
    )
    .await
    .ok()
    .flatten()
    .unwrap_or(false);
    if !correlated {
        keep_attach_until_cancellation(
            &inner.resources,
            &generation,
            &mut *remote,
            &root_session_id,
        )
        .await;
        return;
    }
    let capabilities = ActivityCapabilities {
        actors: true,
        attributed_activity: true,
        background_work: false,
        history_recovery: ActivityHistoryRecovery::Full,
        terminal_observation: true,
        targeted_actor_cancellation: false,
    };
    if !inner
        .publisher
        .publish_correlated("opencode", Some(&inner.provider_instance_id), capabilities)
        .await
        .unwrap_or(false)
    {
        keep_attach_until_cancellation(
            &inner.resources,
            &generation,
            &mut *remote,
            &root_session_id,
        )
        .await;
        return;
    }

    let mut tracker = OpenCodeActivityTracker::new(&root_session_id);
    let mut sequence = 0_u64;
    reconcile_opencode(
        &inner.publisher,
        &mut *remote,
        &mut tracker,
        &root_session_id,
        &mut sequence,
        None,
    )
    .await;

    let mut epoch = 0_u64;
    let mut stream =
        establish_opencode_event_stream(&mut *remote, &generation, inner.handshake_timeout).await;
    let (mut mode, mut live_state) = if stream.is_some() {
        let state = inner.activity.snapshot();
        let mode = if state.enabled {
            OpenCodeObserverMode::Live
        } else {
            OpenCodeObserverMode::Dormant
        };
        mark_opencode_observation(&inner, state, epoch, mode);
        (mode, (mode == OpenCodeObserverMode::Live).then_some(state))
    } else {
        let state = inner.activity.snapshot();
        mark_opencode_observation(&inner, state, epoch, OpenCodeObserverMode::Unavailable);
        (OpenCodeObserverMode::Unavailable, None)
    };
    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + OPENCODE_RECONCILIATION_INTERVAL,
        OPENCODE_RECONCILIATION_INTERVAL,
    );
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        if stream.is_none() {
            stream =
                establish_opencode_event_stream(&mut *remote, &generation, inner.handshake_timeout)
                    .await;
            if generation.cancellation_reason().is_some() {
                stop_opencode_observer(&inner, &mut *remote, &root_session_id).await;
                return;
            }
            if stream.is_some() {
                tracker = OpenCodeActivityTracker::new(&root_session_id);
                let state = inner.activity.snapshot();
                mode = if state.enabled {
                    interval
                        .reset_at(tokio::time::Instant::now() + OPENCODE_RECONCILIATION_INTERVAL);
                    live_state = Some(state);
                    OpenCodeObserverMode::Live
                } else {
                    live_state = None;
                    OpenCodeObserverMode::Dormant
                };
                mark_opencode_observation(&inner, state, epoch, mode);
                continue;
            }

            let state = inner.activity.snapshot();
            mode = OpenCodeObserverMode::Unavailable;
            mark_opencode_observation(&inner, state, epoch, mode);
            tokio::select! {
                biased;
                _ = generation.cancelled() => {
                    stop_opencode_observer(&inner, &mut *remote, &root_session_id).await;
                    return;
                }
                changed = activity.changed() => {
                    if changed.is_err() {
                        stop_opencode_observer(&inner, &mut *remote, &root_session_id).await;
                        return;
                    }
                }
                _ = tokio::time::sleep(OPENCODE_SSE_RETRY_MAX) => {}
            }
            continue;
        }

        let event = {
            let current_stream = stream.as_mut().expect("OpenCode stream is present");
            match mode {
                OpenCodeObserverMode::Live => tokio::select! {
                    biased;
                    _ = generation.cancelled() => OpenCodeObserverEvent::Cancelled,
                    changed = activity.changed() => {
                        OpenCodeObserverEvent::ActivityChanged(changed.is_ok())
                    }
                    _ = interval.tick() => OpenCodeObserverEvent::Reconcile,
                    data = current_stream.next_data() => OpenCodeObserverEvent::Data(data),
                },
                OpenCodeObserverMode::Dormant | OpenCodeObserverMode::Unavailable => {
                    tokio::select! {
                        biased;
                        _ = generation.cancelled() => OpenCodeObserverEvent::Cancelled,
                        changed = activity.changed() => {
                            OpenCodeObserverEvent::ActivityChanged(changed.is_ok())
                        }
                        discarded = current_stream.discard_next() => {
                            OpenCodeObserverEvent::Discard(discarded)
                        }
                    }
                }
            }
        };

        let event = match event {
            OpenCodeObserverEvent::Reconcile => {
                let Some(state) = live_state else {
                    continue;
                };
                let fence = OpenCodeLiveFence {
                    activity: &inner.activity,
                    generation: &generation,
                    state,
                };
                let Some(admission) = admit_opencode_live_work(fence) else {
                    continue;
                };
                let publication = OpenCodeLivePublication { fence, admission };
                let reconciliation = reconcile_opencode(
                    &inner.publisher,
                    &mut *remote,
                    &mut tracker,
                    &root_session_id,
                    &mut sequence,
                    Some(publication),
                );
                match wait_for_opencode_live_work(&mut activity, &generation, reconciliation).await
                {
                    OpenCodeLiveWork::Cancelled => OpenCodeObserverEvent::Cancelled,
                    OpenCodeLiveWork::ActivityChanged(changed) => {
                        OpenCodeObserverEvent::ActivityChanged(changed)
                    }
                    OpenCodeLiveWork::Completed(()) => continue,
                }
            }
            event => event,
        };

        match event {
            OpenCodeObserverEvent::Cancelled => {
                stop_opencode_observer(&inner, &mut *remote, &root_session_id).await;
                return;
            }
            OpenCodeObserverEvent::ActivityChanged(false) => {
                stop_opencode_observer(&inner, &mut *remote, &root_session_id).await;
                return;
            }
            OpenCodeObserverEvent::ActivityChanged(true) => {
                let mut state = *activity.borrow();
                loop {
                    if !state.enabled {
                        live_state = None;
                        mode = OpenCodeObserverMode::Dormant;
                        mark_opencode_observation(&inner, state, epoch, mode);
                        break;
                    }
                    if mode == OpenCodeObserverMode::Live && live_state == Some(state) {
                        mark_opencode_observation(&inner, state, epoch, mode);
                        break;
                    }

                    live_state = None;
                    mode = OpenCodeObserverMode::Dormant;
                    let deadline = tokio::time::Instant::now() + inner.reattach_timeout;
                    let outcome = {
                        let dormant_stream =
                            stream.as_mut().expect("dormant OpenCode stream is present");
                        prepare_opencode_replacement(
                            &mut *remote,
                            &mut **dormant_stream,
                            &mut activity,
                            state,
                            &generation,
                            deadline,
                        )
                        .await
                    };
                    match outcome {
                        OpenCodeReplacementOutcome::Connected(replacement) => {
                            let next_epoch = epoch.saturating_add(1);
                            let promoted = commit_opencode_observation(
                                &inner,
                                state,
                                next_epoch,
                                OpenCodeObserverMode::Live,
                                || {
                                    stream = Some(replacement);
                                    epoch = next_epoch;
                                    tracker = OpenCodeActivityTracker::new(&root_session_id);
                                    live_state = Some(state);
                                    mode = OpenCodeObserverMode::Live;
                                    interval.reset_at(
                                        tokio::time::Instant::now()
                                            + OPENCODE_RECONCILIATION_INTERVAL,
                                    );
                                },
                            );
                            if promoted {
                                break;
                            }
                            state = inner.activity.snapshot();
                        }
                        OpenCodeReplacementOutcome::Failed {
                            dormant_stream_healthy,
                        } => {
                            if !dormant_stream_healthy {
                                stream = None;
                                epoch = epoch.saturating_add(1);
                            }
                            mode = OpenCodeObserverMode::Unavailable;
                            mark_opencode_observation(
                                &inner,
                                inner.activity.snapshot(),
                                epoch,
                                mode,
                            );
                            break;
                        }
                        OpenCodeReplacementOutcome::Superseded {
                            dormant_stream_healthy,
                        } => {
                            let current = inner.activity.snapshot();
                            if !dormant_stream_healthy {
                                stream = None;
                                epoch = epoch.saturating_add(1);
                                mode = OpenCodeObserverMode::Unavailable;
                                mark_opencode_observation(&inner, current, epoch, mode);
                                break;
                            }
                            state = current;
                        }
                        OpenCodeReplacementOutcome::Cancelled => {
                            stop_opencode_observer(&inner, &mut *remote, &root_session_id).await;
                            return;
                        }
                    }
                }
            }
            OpenCodeObserverEvent::Data(Ok(data)) => {
                let Some(state) = live_state else {
                    continue;
                };
                let fence = OpenCodeLiveFence {
                    activity: &inner.activity,
                    generation: &generation,
                    state,
                };
                let (admission, output) = match decode_and_track_opencode_live_data(
                    fence,
                    &mut tracker,
                    &data,
                    now_millis(),
                ) {
                    OpenCodeLiveData::Stale => continue,
                    OpenCodeLiveData::Malformed => {
                        stream = None;
                        epoch = epoch.saturating_add(1);
                        live_state = None;
                        mode = OpenCodeObserverMode::Unavailable;
                        mark_opencode_observation(&inner, inner.activity.snapshot(), epoch, mode);
                        continue;
                    }
                    OpenCodeLiveData::Output { admission, output } => (admission, output),
                };
                if !opencode_live_work_is_current(fence, &admission) {
                    continue;
                }
                apply_opencode_output(
                    &inner.publisher,
                    &format!("opencode:terminal:sse:{sequence}"),
                    output.mutations,
                    Some(OpenCodeLivePublication { fence, admission }),
                )
                .await;
                sequence = sequence.saturating_add(1);
            }
            OpenCodeObserverEvent::Reconcile => unreachable!("reconciliation is resolved above"),
            OpenCodeObserverEvent::Data(Err(_)) | OpenCodeObserverEvent::Discard(Err(_)) => {
                stream = None;
                epoch = epoch.saturating_add(1);
                live_state = None;
                mode = OpenCodeObserverMode::Unavailable;
                mark_opencode_observation(&inner, inner.activity.snapshot(), epoch, mode);
            }
            OpenCodeObserverEvent::Discard(Ok(())) => {}
        }
    }
}

fn mark_opencode_observation(
    inner: &OpenCodeObserverInner,
    state: TerminalAgentActivityState,
    epoch: u64,
    mode: OpenCodeObserverMode,
) -> bool {
    commit_opencode_observation(inner, state, epoch, mode, || {})
}

fn commit_opencode_observation(
    inner: &OpenCodeObserverInner,
    state: TerminalAgentActivityState,
    epoch: u64,
    mode: OpenCodeObserverMode,
    commit: impl FnOnce(),
) -> bool {
    let kind = match mode {
        OpenCodeObserverMode::Live => TerminalAgentActivityObservationKind::Live,
        OpenCodeObserverMode::Dormant => TerminalAgentActivityObservationKind::Dormant,
        OpenCodeObserverMode::Unavailable => TerminalAgentActivityObservationKind::Unavailable,
    };
    inner.activity.commit_observed(
        TerminalAgentActivityObservation { state, epoch, kind },
        || {
            commit();
        },
    )
}

async fn stop_opencode_observer(
    inner: &OpenCodeObserverInner,
    remote: &mut dyn OpenCodeRemoteClient,
    root_session_id: &str,
) {
    let _ = remote.abort(root_session_id).await;
    inner.resources.cleanup_helper().await;
}

async fn establish_opencode_event_stream(
    remote: &mut dyn OpenCodeRemoteClient,
    generation: &TerminalObserverGeneration,
    timeout: Duration,
) -> Option<Box<dyn OpenCodeEventStream>> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut retry = OPENCODE_SSE_RETRY_MIN;
    loop {
        let opened = tokio::select! {
            biased;
            _ = generation.cancelled() => return None,
            opened = tokio::time::timeout_at(deadline, remote.open_event_stream()) => opened,
        };
        if let Ok(Ok(mut stream)) = opened
            && wait_for_opencode_connected(&mut *stream, generation, deadline).await
        {
            return Some(stream);
        }

        let retry_at = tokio::time::Instant::now() + retry;
        if retry_at >= deadline {
            return None;
        }
        tokio::select! {
            biased;
            _ = generation.cancelled() => return None,
            _ = tokio::time::sleep_until(retry_at) => {}
        }
        retry = retry.saturating_mul(2).min(OPENCODE_SSE_RETRY_MAX);
    }
}

async fn wait_for_opencode_connected(
    stream: &mut dyn OpenCodeEventStream,
    generation: &TerminalObserverGeneration,
    deadline: tokio::time::Instant,
) -> bool {
    loop {
        let data = tokio::select! {
            biased;
            _ = generation.cancelled() => return false,
            data = tokio::time::timeout_at(deadline, stream.next_data()) => data,
        };
        let Ok(Ok(data)) = data else {
            return false;
        };
        let Ok(event) = serde_json::from_slice::<Value>(&data) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) == Some("server.connected") {
            return true;
        }
    }
}

async fn prepare_opencode_replacement(
    remote: &mut dyn OpenCodeRemoteClient,
    dormant_stream: &mut dyn OpenCodeEventStream,
    activity: &mut tokio::sync::watch::Receiver<TerminalAgentActivityState>,
    expected_state: TerminalAgentActivityState,
    generation: &TerminalObserverGeneration,
    deadline: tokio::time::Instant,
) -> OpenCodeReplacementOutcome {
    let mut dormant_stream_healthy = true;
    let opening = remote.open_event_stream();
    tokio::pin!(opening);
    let mut replacement = loop {
        if tokio::time::Instant::now() >= deadline {
            return OpenCodeReplacementOutcome::Failed {
                dormant_stream_healthy,
            };
        }
        tokio::select! {
            biased;
            _ = generation.cancelled() => return OpenCodeReplacementOutcome::Cancelled,
            changed = activity.changed() => {
                if changed.is_err() || *activity.borrow() != expected_state {
                    return OpenCodeReplacementOutcome::Superseded {
                        dormant_stream_healthy,
                    };
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                return OpenCodeReplacementOutcome::Failed {
                    dormant_stream_healthy,
                };
            }
            opened = &mut opening => {
                match opened {
                    Ok(stream) => break stream,
                    Err(_) => {
                        return OpenCodeReplacementOutcome::Failed {
                            dormant_stream_healthy,
                        };
                    }
                }
            }
            discarded = dormant_stream.discard_next(), if dormant_stream_healthy => {
                if discarded.is_err() {
                    dormant_stream_healthy = false;
                }
            }
        }
    };

    let is_connected = {
        let connected = wait_for_opencode_connected(&mut *replacement, generation, deadline);
        tokio::pin!(connected);
        loop {
            if tokio::time::Instant::now() >= deadline {
                return OpenCodeReplacementOutcome::Failed {
                    dormant_stream_healthy,
                };
            }
            tokio::select! {
                biased;
                _ = generation.cancelled() => return OpenCodeReplacementOutcome::Cancelled,
                changed = activity.changed() => {
                    if changed.is_err() || *activity.borrow() != expected_state {
                        return OpenCodeReplacementOutcome::Superseded {
                            dormant_stream_healthy,
                        };
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    return OpenCodeReplacementOutcome::Failed {
                        dormant_stream_healthy,
                    };
                }
                is_connected = &mut connected => break is_connected,
                discarded = dormant_stream.discard_next(), if dormant_stream_healthy => {
                    if discarded.is_err() {
                        dormant_stream_healthy = false;
                    }
                }
            }
        }
    };
    let current = *activity.borrow();
    if current != expected_state {
        OpenCodeReplacementOutcome::Superseded {
            dormant_stream_healthy,
        }
    } else if is_connected {
        OpenCodeReplacementOutcome::Connected(replacement)
    } else {
        OpenCodeReplacementOutcome::Failed {
            dormant_stream_healthy,
        }
    }
}

async fn keep_attach_until_cancellation(
    resources: &OpenCodeObserverResources,
    generation: &TerminalObserverGeneration,
    remote: &mut dyn OpenCodeRemoteClient,
    root_session_id: &str,
) {
    generation.cancelled().await;
    let _ = remote.abort(root_session_id).await;
    resources.cleanup_helper().await;
}

async fn wait_for_owned_root(
    remote: &mut dyn OpenCodeRemoteClient,
    root_session_id: &str,
    generation: &TerminalObserverGeneration,
) -> Option<bool> {
    loop {
        if !generation.is_current() {
            return Some(false);
        }
        if let Ok(root) =
            tokio::time::timeout(OPENCODE_REQUEST_TIMEOUT, remote.root(root_session_id)).await
            && let Ok(root) = root
            && root.get("id").and_then(Value::as_str) == Some(root_session_id)
            && root.get("parentID").is_none_or(Value::is_null)
        {
            return Some(true);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn reconcile_opencode(
    publisher: &TerminalGenerationActivityPublisher,
    remote: &mut dyn OpenCodeRemoteClient,
    tracker: &mut OpenCodeActivityTracker,
    root_session_id: &str,
    sequence: &mut u64,
    live_publication: Option<OpenCodeLivePublication<'_>>,
) {
    let mut queue = VecDeque::from([root_session_id.to_owned()]);
    let mut children = Vec::new();
    while let Some(parent) = queue.pop_front() {
        if live_publication.is_some_and(|publication| !publication.is_current()) {
            return;
        }
        if children.len() >= MAX_RECONCILED_CHILDREN {
            break;
        }
        let Ok(Ok(response)) =
            tokio::time::timeout(OPENCODE_REQUEST_TIMEOUT, remote.children(&parent)).await
        else {
            continue;
        };
        if live_publication.is_some_and(|publication| !publication.is_current()) {
            return;
        }
        let remaining = MAX_RECONCILED_CHILDREN.saturating_sub(children.len());
        let (output, accepted) = tracker.reconcile_children_limited(&parent, &response, remaining);
        if live_publication.is_some_and(|publication| !publication.is_current()) {
            return;
        }
        apply_opencode_output(
            publisher,
            &format!("opencode:terminal:children:{sequence}"),
            output.mutations,
            live_publication,
        )
        .await;
        *sequence = sequence.saturating_add(1);
        for child_id in accepted {
            queue.push_back(child_id.clone());
            children.push(child_id);
        }
    }
    if let Ok(Ok(statuses)) =
        tokio::time::timeout(OPENCODE_REQUEST_TIMEOUT, remote.statuses()).await
    {
        if live_publication.is_some_and(|publication| !publication.is_current()) {
            return;
        }
        for session_id in &children {
            if live_publication.is_some_and(|publication| !publication.is_current()) {
                return;
            }
            let Some(status) = statuses.get(session_id) else {
                continue;
            };
            let output = tracker.handle_event(&json!({
                "type": "session.status",
                "properties": {
                    "sessionID": session_id,
                    "status": status,
                }
            }));
            if live_publication.is_some_and(|publication| !publication.is_current()) {
                return;
            }
            apply_opencode_output(
                publisher,
                &format!("opencode:terminal:status:{sequence}"),
                output.mutations,
                live_publication,
            )
            .await;
            *sequence = sequence.saturating_add(1);
        }
    }
    for session_id in children {
        if live_publication.is_some_and(|publication| !publication.is_current()) {
            return;
        }
        let Ok(Ok(messages)) =
            tokio::time::timeout(OPENCODE_REQUEST_TIMEOUT, remote.messages(&session_id)).await
        else {
            continue;
        };
        if live_publication.is_some_and(|publication| !publication.is_current()) {
            return;
        }
        let output = tracker.handle_history(&session_id, &messages);
        if live_publication.is_some_and(|publication| !publication.is_current()) {
            return;
        }
        apply_opencode_output(
            publisher,
            &format!("opencode:terminal:messages:{sequence}"),
            output.mutations,
            live_publication,
        )
        .await;
        *sequence = sequence.saturating_add(1);
    }
}

async fn apply_opencode_output(
    publisher: &TerminalGenerationActivityPublisher,
    native_event_id: &str,
    mutations: Vec<ProviderActivityMutation>,
    live_publication: Option<OpenCodeLivePublication<'_>>,
) {
    if mutations.is_empty() {
        return;
    }
    let created_at = now_iso();
    let _ = match live_publication {
        Some(publication) => {
            publisher
                .apply_admitted(
                    publication.fence.activity,
                    &publication.admission,
                    native_event_id,
                    mutations,
                    &created_at,
                )
                .await
        }
        None => {
            publisher
                .apply(native_event_id, mutations, &created_at)
                .await
        }
    };
}

fn now_millis() -> u64 {
    OffsetDateTime::now_utc()
        .unix_timestamp_nanos()
        .checked_div(1_000_000)
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or_default()
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

#[derive(Debug)]
struct SystemOpenCodeCapabilityProbeRunner;

impl OpenCodeCapabilityProbeRunner for SystemOpenCodeCapabilityProbeRunner {
    fn run(
        &self,
        executable: &Path,
        args: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<OpenCodeProbeOutput, String>> + Send + '_>> {
        let executable = executable.to_path_buf();
        Box::pin(async move {
            let mut command = tokio::process::Command::new(executable);
            command
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let output = run_supervised(
                SupervisedRunRequest {
                    command,
                    stdin: None,
                    timeout: Duration::from_millis(900),
                    cleanup_timeout: Duration::from_secs(2),
                    max_output_bytes: OPENCODE_PROBE_OUTPUT_LIMIT,
                    overflow: SupervisedOverflow::Truncate,
                },
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
            .map_err(|error| format!("OpenCode capability probe failed: {error:?}"))?;
            Ok(OpenCodeProbeOutput {
                success: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout.bytes).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr.bytes).into_owned(),
            })
        })
    }
}

#[derive(Debug)]
struct SystemOpenCodeHelperLauncher;

impl OpenCodeHelperLauncher for SystemOpenCodeHelperLauncher {
    fn start(
        &self,
        launch: OpenCodeHelperLaunch,
    ) -> Pin<Box<dyn Future<Output = Result<OpenCodeHelperReady, String>> + Send + '_>> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(&launch.executable);
            configure_background_command(&mut command);
            command
                .args(&launch.args)
                .current_dir(&launch.cwd)
                .envs(&launch.env)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            #[cfg(unix)]
            command.process_group(0);
            let mut child = command
                .spawn()
                .map_err(|error| format!("failed to start OpenCode helper: {error}"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "OpenCode helper stdout is unavailable".to_owned())?;
            let process = Arc::new(SystemOpenCodeHelperProcess {
                process_group_id: child.id().and_then(|pid| i32::try_from(pid).ok()),
                #[cfg(unix)]
                process_group_identity_reserved: AtomicBool::new(child.id().is_some()),
                child: Mutex::new(Some(child)),
                stdout_task: Mutex::new(None),
            });
            let mut stdout = BufReader::new(stdout);
            let endpoint = match tokio::time::timeout(
                OPENCODE_HELPER_READY_TIMEOUT,
                read_opencode_readiness(&mut stdout),
            )
            .await
            {
                Ok(Ok(endpoint)) => endpoint,
                Ok(Err(error)) => {
                    process.terminate();
                    return Err(error);
                }
                Err(_) => {
                    process.terminate();
                    return Err("OpenCode helper readiness timed out".to_owned());
                }
            };
            if !valid_loopback_endpoint(&endpoint) {
                process.terminate();
                return Err("OpenCode helper advertised an invalid endpoint".to_owned());
            }
            let stdout_task = tokio::spawn(drain_opencode_stdout(stdout));
            *process
                .stdout_task
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(stdout_task);
            Ok(OpenCodeHelperReady { endpoint, process })
        })
    }
}

async fn read_opencode_readiness(
    reader: &mut BufReader<tokio::process::ChildStdout>,
) -> Result<String, String> {
    let mut total = 0_usize;
    loop {
        let mut line = Vec::new();
        let bytes_read = reader
            .read_until(b'\n', &mut line)
            .await
            .map_err(|error| format!("failed reading OpenCode helper readiness: {error}"))?;
        if bytes_read == 0 {
            return Err("OpenCode helper exited before readiness".to_owned());
        }
        total = total.saturating_add(line.len());
        if total > OPENCODE_PROBE_OUTPUT_LIMIT {
            return Err("OpenCode helper readiness output exceeded its bound".to_owned());
        }
        let line = String::from_utf8_lossy(&line);
        if let Some(endpoint) = line
            .trim_end_matches(['\r', '\n'])
            .strip_prefix("opencode server listening on ")
        {
            return Ok(endpoint.trim().to_owned());
        }
    }
}

async fn drain_opencode_stdout(mut stdout: BufReader<tokio::process::ChildStdout>) {
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match stdout.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

struct SystemOpenCodeHelperProcess {
    process_group_id: Option<i32>,
    #[cfg(unix)]
    process_group_identity_reserved: AtomicBool,
    child: Mutex<Option<Child>>,
    stdout_task: Mutex<Option<JoinHandle<()>>>,
}

impl fmt::Debug for SystemOpenCodeHelperProcess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SystemOpenCodeHelperProcess")
            .finish_non_exhaustive()
    }
}

impl OpenCodeHelperProcess for SystemOpenCodeHelperProcess {
    fn has_exited(&self) -> bool {
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(child) = child.as_mut() else {
            return true;
        };
        #[cfg(unix)]
        {
            match child_has_exited_without_reaping(child) {
                Ok(exited) => exited,
                Err(_) => {
                    // An uncertain observation no longer proves that the
                    // original leader reserves its numeric PID/PGID. Fail open
                    // as exited, but permanently disable process-group signals.
                    self.process_group_identity_reserved
                        .store(false, Ordering::Release);
                    true
                }
            }
        }
        #[cfg(not(unix))]
        {
            child.try_wait().map_or(true, |status| status.is_some())
        }
    }

    fn terminate(&self) {
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let stdout_task = self
            .stdout_task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(stdout_task) = stdout_task {
            stdout_task.abort();
        }
        let Some(child) = child.as_mut() else {
            return;
        };
        #[cfg(unix)]
        if let Some(process_group_id) = self.reserved_process_group_id() {
            // SAFETY: the process-group ID was captured from this owned helper
            // and non-reaping observation still proves its leader identity is
            // reserved.
            unsafe {
                libc::kill(-process_group_id, libc::SIGKILL);
            }
        }
        let _ = child.start_kill();
    }

    fn terminate_and_reap(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let child = self
                .child
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            #[cfg(unix)]
            let process_group_id = self.reserved_process_group_id();
            #[cfg(not(unix))]
            let process_group_id = self.process_group_id;
            let mut cleanup = child.map(|child| SystemOpenCodeReapGuard {
                child: Some(child),
                #[cfg(unix)]
                process_group_id,
            });
            let stdout_task = self
                .stdout_task
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some(stdout_task) = stdout_task {
                stdout_task.abort();
                let _ = stdout_task.await;
            }
            let Some(cleanup) = cleanup.as_mut() else {
                return;
            };
            #[cfg(unix)]
            if let Some(process_group_id) = process_group_id {
                // SAFETY: the process-group ID was captured from this owned
                // helper and its leader identity is still reserved.
                unsafe {
                    libc::kill(-process_group_id, libc::SIGTERM);
                }
            }
            reap_opencode_helper(cleanup.child_mut(), process_group_id).await;
            cleanup.disarm();
        })
    }
}

struct SystemOpenCodeReapGuard {
    child: Option<Child>,
    #[cfg(unix)]
    process_group_id: Option<i32>,
}

impl SystemOpenCodeReapGuard {
    fn child_mut(&mut self) -> &mut Child {
        self.child
            .as_mut()
            .expect("OpenCode reap guard owns a child")
    }

    fn disarm(&mut self) {
        self.child.take();
    }
}

impl Drop for SystemOpenCodeReapGuard {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        #[cfg(unix)]
        if let Some(process_group_id) = self.process_group_id {
            // SAFETY: this guard receives a group ID only while the owned
            // leader identity remains reserved. Cancellation drops the guard
            // before that leader can be reaped.
            unsafe {
                libc::kill(-process_group_id, libc::SIGKILL);
            }
        }
        let _ = child.start_kill();
    }
}

#[cfg(unix)]
impl SystemOpenCodeHelperProcess {
    fn reserved_process_group_id(&self) -> Option<i32> {
        self.process_group_identity_reserved
            .load(Ordering::Acquire)
            .then_some(self.process_group_id)
            .flatten()
    }
}

#[cfg(unix)]
fn child_has_exited_without_reaping(child: &Child) -> std::io::Result<bool> {
    let Some(process_id) = child.id() else {
        return Err(std::io::Error::from_raw_os_error(libc::ECHILD));
    };
    observe_child_exit_with(process_id, || waitid_child_once(process_id))
}

#[cfg(unix)]
fn observe_child_exit_with(
    process_id: u32,
    mut waitid_child: impl FnMut() -> std::io::Result<Option<libc::pid_t>>,
) -> std::io::Result<bool> {
    let mut interrupted_retries = 0_usize;
    let observed_process_id = loop {
        match waitid_child() {
            Err(error)
                if error.kind() == std::io::ErrorKind::Interrupted
                    && interrupted_retries < OPENCODE_WAITID_EINTR_RETRY_LIMIT =>
            {
                interrupted_retries = interrupted_retries.saturating_add(1);
            }
            observation => break observation?,
        }
    };
    let Some(observed_process_id) = observed_process_id else {
        return Ok(false);
    };
    if observed_process_id != process_id as libc::pid_t {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "waitid returned a different child identity",
        ));
    }
    Ok(true)
}

#[cfg(unix)]
fn waitid_child_once(process_id: u32) -> std::io::Result<Option<libc::pid_t>> {
    let mut information = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: `information` points to writable siginfo storage and P_PID
    // limits observation to this owned child. WNOWAIT is essential: keeping
    // the exited leader waitable reserves its PID/PGID until group cleanup has
    // sent TERM/KILL and the final `Child::wait` reaps it.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            process_id as libc::id_t,
            information.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: successful `waitid` initialized the zeroed siginfo storage.
    let information = unsafe { information.assume_init() };
    // SAFETY: `si_pid` reads the process field of initialized siginfo. A zero
    // PID means WNOHANG found no exited state.
    let observed_process_id = unsafe { information.si_pid() };
    if observed_process_id == 0 {
        return Ok(None);
    }
    Ok(Some(observed_process_id))
}

async fn reap_opencode_helper(child: &mut Child, process_group_id: Option<i32>) {
    tokio::time::sleep(OPENCODE_HELPER_TERM_GRACE).await;
    #[cfg(not(unix))]
    let _ = process_group_id;
    #[cfg(unix)]
    if let Some(process_group_id) = process_group_id {
        // SAFETY: a negative PID addresses only the process group created for
        // this owned helper, captured before its parent could exit.
        unsafe {
            libc::kill(-process_group_id, libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
    if tokio::time::timeout(OPENCODE_HELPER_REAP_TIMEOUT, child.wait())
        .await
        .is_err()
    {
        let _ = child.wait().await;
    }
}

impl Drop for SystemOpenCodeHelperProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[derive(Debug)]
struct SystemOpenCodeRemoteClientFactory;

impl OpenCodeRemoteClientFactory for SystemOpenCodeRemoteClientFactory {
    fn connect(
        &self,
        endpoint: &str,
        username: &str,
        password: &str,
        directory: &Path,
    ) -> Pin<Box<dyn Future<Output = Result<Box<dyn OpenCodeRemoteClient>, String>> + Send + '_>>
    {
        let endpoint = endpoint.to_owned();
        let username = username.to_owned();
        let password = password.to_owned();
        let directory = directory.to_path_buf();
        Box::pin(async move {
            if !valid_loopback_endpoint(&endpoint) {
                return Err("OpenCode endpoint is not an authenticated loopback URL".to_owned());
            }
            let authorization = format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
            );
            let mut authorization = reqwest::header::HeaderValue::from_str(&authorization)
                .map_err(|_| "OpenCode authorization header is invalid".to_owned())?;
            authorization.set_sensitive(true);
            let mut directory_header =
                reqwest::header::HeaderValue::from_str(&directory.to_string_lossy())
                    .map_err(|_| "OpenCode directory header is invalid".to_owned())?;
            directory_header.set_sensitive(true);
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(reqwest::header::AUTHORIZATION, authorization);
            headers.insert("x-opencode-directory", directory_header);
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .default_headers(headers)
                .connect_timeout(OPENCODE_REQUEST_TIMEOUT)
                .build()
                .map_err(|error| format!("failed to build OpenCode client: {error}"))?;
            let remote = SystemOpenCodeRemoteClient {
                client,
                endpoint,
                directory,
            };
            let health = remote
                .request_json(reqwest::Method::GET, &["global", "health"], None)
                .await?;
            let version = health.get("version").and_then(Value::as_str);
            if health.get("healthy").and_then(Value::as_bool) != Some(true)
                || version.is_none_or(|version| {
                    parse_opencode_version(version).as_deref() != Some(version)
                })
            {
                return Err("OpenCode helper health was invalid".to_owned());
            }
            Ok(Box::new(remote) as Box<dyn OpenCodeRemoteClient>)
        })
    }
}

struct SystemOpenCodeRemoteClient {
    client: reqwest::Client,
    endpoint: String,
    directory: PathBuf,
}

struct SystemOpenCodeEventStream {
    response: reqwest::Response,
    sse_decoder: OpenCodeSseDecoder,
}

impl fmt::Debug for SystemOpenCodeRemoteClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SystemOpenCodeRemoteClient")
            .field("endpoint", &self.endpoint)
            .field("directory", &self.directory)
            .finish_non_exhaustive()
    }
}

impl SystemOpenCodeRemoteClient {
    fn url(&self, segments: &[&str]) -> Result<url::Url, String> {
        let mut url =
            url::Url::parse(&self.endpoint).map_err(|_| "invalid OpenCode endpoint".to_owned())?;
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|()| "invalid OpenCode endpoint path".to_owned())?;
            path.pop_if_empty();
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }

    async fn request_json(
        &self,
        method: reqwest::Method,
        segments: &[&str],
        body: Option<Value>,
    ) -> Result<Value, String> {
        tokio::time::timeout(OPENCODE_REQUEST_TIMEOUT, async {
            let mut request = self.client.request(method, self.url(segments)?);
            if let Some(body) = body {
                request = request.json(&body);
            }
            let response = request
                .send()
                .await
                .map_err(|_| "OpenCode request failed".to_owned())?;
            if !response.status().is_success() {
                return Err(format!(
                    "OpenCode request failed with {}",
                    response.status()
                ));
            }
            read_bounded_json(response).await
        })
        .await
        .map_err(|_| "OpenCode request timed out".to_owned())?
    }
}

impl SystemOpenCodeEventStream {
    async fn read_chunk(&mut self) -> Result<(), String> {
        let chunk = self
            .response
            .chunk()
            .await
            .map_err(|_| "OpenCode SSE read failed".to_owned())?
            .ok_or_else(|| "OpenCode SSE ended".to_owned())?;
        self.sse_decoder.push(&chunk)
    }
}

impl OpenCodeEventStream for SystemOpenCodeEventStream {
    fn discard_next(&mut self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            loop {
                match self.sse_decoder.discard_event() {
                    Ok(true) => return Ok(()),
                    Ok(false) => self.read_chunk().await?,
                    Err(error) => return Err(error),
                }
            }
        })
    }

    fn next_data(&mut self) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send + '_>> {
        Box::pin(async move {
            loop {
                let buffered_length = self.sse_decoder.buffered_len();
                match self.sse_decoder.take_data() {
                    Ok(Some(data)) => return Ok(data),
                    Ok(None) if self.sse_decoder.buffered_len() < buffered_length => continue,
                    Ok(None) => self.read_chunk().await?,
                    Err(error) => return Err(error),
                }
            }
        })
    }
}

impl OpenCodeRemoteClient for SystemOpenCodeRemoteClient {
    fn create_root(
        &mut self,
        model: &str,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>> {
        let model = model.to_owned();
        Box::pin(async move {
            let (provider_id, id) = model
                .split_once('/')
                .ok_or_else(|| "OpenCode model is not provider-qualified".to_owned())?;
            let response = self
                .request_json(
                    reqwest::Method::POST,
                    &["session"],
                    Some(json!({
                        "model": {
                            "providerID": provider_id,
                            "id": id,
                        }
                    })),
                )
                .await?;
            response
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_native_id(id))
                .map(str::to_owned)
                .ok_or_else(|| "OpenCode root response did not contain a valid ID".to_owned())
        })
    }

    fn cleanup_pre_spawn(
        &mut self,
        root_session_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        let root_session_id = root_session_id.to_owned();
        Box::pin(async move {
            self.request_json(
                reqwest::Method::DELETE,
                &["session", &root_session_id],
                None,
            )
            .await
            .map(|_| ())
        })
    }

    fn abort(
        &mut self,
        root_session_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        let root_session_id = root_session_id.to_owned();
        Box::pin(async move {
            self.request_json(
                reqwest::Method::POST,
                &["session", &root_session_id, "abort"],
                None,
            )
            .await
            .map(|_| ())
        })
    }

    fn root(
        &mut self,
        root_session_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>> {
        let root_session_id = root_session_id.to_owned();
        Box::pin(async move {
            self.request_json(reqwest::Method::GET, &["session", &root_session_id], None)
                .await
        })
    }

    fn statuses(&mut self) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>> {
        Box::pin(async move {
            self.request_json(reqwest::Method::GET, &["session", "status"], None)
                .await
        })
    }

    fn children(
        &mut self,
        session_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>> {
        let session_id = session_id.to_owned();
        Box::pin(async move {
            self.request_json(
                reqwest::Method::GET,
                &["session", &session_id, "children"],
                None,
            )
            .await
        })
    }

    fn messages(
        &mut self,
        session_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>> {
        let session_id = session_id.to_owned();
        Box::pin(async move {
            let mut url = self.url(&["session", &session_id, "message"])?;
            url.query_pairs_mut().append_pair("limit", "200");
            tokio::time::timeout(OPENCODE_REQUEST_TIMEOUT, async {
                let response = self
                    .client
                    .get(url)
                    .send()
                    .await
                    .map_err(|_| "OpenCode request failed".to_owned())?;
                if !response.status().is_success() {
                    return Err(format!(
                        "OpenCode request failed with {}",
                        response.status()
                    ));
                }
                read_bounded_json(response).await
            })
            .await
            .map_err(|_| "OpenCode request timed out".to_owned())?
        })
    }

    fn open_event_stream(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Box<dyn OpenCodeEventStream>, String>> + Send + '_>>
    {
        Box::pin(async move {
            let mut url = self.url(&["event"])?;
            url.query_pairs_mut()
                .append_pair("directory", &self.directory.to_string_lossy());
            let response = tokio::time::timeout(
                OPENCODE_REQUEST_TIMEOUT,
                self.client
                    .get(url)
                    .header(reqwest::header::ACCEPT, "text/event-stream")
                    .send(),
            )
            .await
            .map_err(|_| "OpenCode SSE connection timed out".to_owned())?
            .map_err(|_| "OpenCode SSE connection failed".to_owned())?;
            if !response.status().is_success()
                || !response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.starts_with("text/event-stream"))
            {
                return Err("OpenCode SSE endpoint rejected the observer".to_owned());
            }
            Ok(Box::new(SystemOpenCodeEventStream {
                response,
                sse_decoder: OpenCodeSseDecoder::default(),
            }) as Box<dyn OpenCodeEventStream>)
        })
    }
}

async fn read_bounded_json(mut response: reqwest::Response) -> Result<Value, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "OpenCode response read failed".to_owned())?
    {
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > OPENCODE_HTTP_BODY_LIMIT)
        {
            return Err("OpenCode response exceeded its bound".to_owned());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "OpenCode response was invalid JSON".to_owned())
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use axum::{
        Router,
        body::{Body, Bytes, to_bytes},
        extract::{Request, State},
        http::{Method, Response, StatusCode, header},
        routing::any,
    };
    use futures_util::{StreamExt, stream};

    use super::*;

    #[derive(Debug, Default)]
    struct RecordingOpenCodeHelper {
        terminated: AtomicBool,
    }

    impl OpenCodeHelperProcess for RecordingOpenCodeHelper {
        fn terminate(&self) {
            self.terminated.store(true, Ordering::Release);
        }
    }

    #[derive(Debug, Default)]
    struct PausingOpenCodeHelper {
        terminate_calls: std::sync::atomic::AtomicUsize,
        terminate_and_reap_started: tokio::sync::Notify,
    }

    #[tokio::test]
    async fn cancellation_after_reconciliation_selection_preempts_live_work() {
        #[derive(Debug)]
        struct DropSignal(Arc<AtomicBool>);

        impl Drop for DropSignal {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }

        let activity = TerminalAgentActivityControl::enabled();
        let mut changes = activity.subscribe();
        let generation = TerminalObserverGeneration::new(
            "thread-opencode-live-work".to_owned(),
            "terminal-opencode-live-work".to_owned(),
        );
        let work_dropped = Arc::new(AtomicBool::new(false));
        let reconciliation = {
            let signal = DropSignal(work_dropped.clone());
            async move {
                let _signal = signal;
                std::future::pending::<()>().await;
            }
        };
        let waiting = wait_for_opencode_live_work(&mut changes, &generation, reconciliation);
        tokio::pin!(waiting);
        let first_poll =
            std::future::poll_fn(|context| std::task::Poll::Ready(waiting.as_mut().poll(context)))
                .await;
        assert!(first_poll.is_pending());

        generation.request_cancellation(super::super::TerminalObserverCancellationReason::Closed);
        let outcome = tokio::time::timeout(Duration::from_millis(100), waiting)
            .await
            .expect("cancellation interrupts live reconciliation");

        assert!(matches!(outcome, OpenCodeLiveWork::Cancelled));
        assert!(
            work_dropped.load(Ordering::Acquire),
            "cancelled reconciliation future is dropped immediately"
        );
    }

    #[test]
    fn disable_after_data_selection_rejects_work_before_decode() {
        let activity = TerminalAgentActivityControl::enabled();
        let generation = TerminalObserverGeneration::new(
            "thread-opencode-live-data".to_owned(),
            "terminal-opencode-live-data".to_owned(),
        );
        let selected_state = activity.snapshot();
        let selected_data = serde_json::to_vec(&json!({
            "type": "session.created",
            "properties": {
                "sessionID": "post-select-child",
                "info": {
                    "id": "post-select-child",
                    "parentID": "root-tui-session",
                    "title": "Must remain unpublished",
                    "time": {"created": 1}
                }
            }
        }))
        .expect("selected OpenCode data");
        activity.transition(false);
        let mut tracker = OpenCodeActivityTracker::new("root-tui-session");

        let outcome = decode_and_track_opencode_live_data(
            OpenCodeLiveFence {
                activity: &activity,
                generation: &generation,
                state: selected_state,
            },
            &mut tracker,
            &selected_data,
            1,
        );

        assert!(
            matches!(outcome, OpenCodeLiveData::Stale),
            "data selected before disable must be rejected before decode or tracker mutation"
        );
    }

    impl OpenCodeHelperProcess for PausingOpenCodeHelper {
        fn terminate(&self) {
            self.terminate_calls.fetch_add(1, Ordering::AcqRel);
        }

        fn terminate_and_reap(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            Box::pin(async move {
                self.terminate_and_reap_started.notify_one();
                std::future::pending::<()>().await;
            })
        }
    }

    #[cfg(unix)]
    fn exited_child_remains_waitable(process_id: u32) -> std::io::Result<bool> {
        let mut information = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: `information` points to writable storage for `waitid`; P_PID
        // limits observation to the child owned by this test, and WNOWAIT keeps
        // its identity reserved until the helper performs group cleanup.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                process_id as libc::id_t,
                information.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: successful `waitid` initialized the siginfo storage. The
        // zeroed PID denotes that WNOHANG found no exited child yet.
        let information = unsafe { information.assume_init() };
        // SAFETY: `si_pid` reads the process field of initialized siginfo.
        Ok(unsafe { information.si_pid() } == process_id as libc::pid_t)
    }

    #[cfg(unix)]
    #[test]
    fn waitid_observation_retries_an_interrupted_system_call() {
        let process_id = 42_u32;
        let mut attempts = 0_u8;

        let exited = observe_child_exit_with(process_id, || {
            attempts = attempts.saturating_add(1);
            if attempts == 1 {
                Err(std::io::Error::from(std::io::ErrorKind::Interrupted))
            } else {
                Ok(Some(process_id as libc::pid_t))
            }
        })
        .expect("interrupted waitid observation is retried");

        assert!(exited, "the retried observation reports the child exit");
        assert_eq!(attempts, 2, "waitid must be retried exactly once here");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn system_helper_liveness_observes_an_actual_child_exit() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", "sleep 30 & exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        command.process_group(0);
        let child = command.spawn().expect("actual exited helper");
        let process_id = child.id().expect("actual helper process ID");
        let helper = SystemOpenCodeHelperProcess {
            process_group_id: i32::try_from(process_id).ok(),
            process_group_identity_reserved: AtomicBool::new(true),
            child: Mutex::new(Some(child)),
            stdout_task: Mutex::new(None),
        };

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !helper.has_exited() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("system helper exit becomes observable");

        let waitable_before_cleanup = exited_child_remains_waitable(process_id);
        helper.terminate_and_reap().await;
        let waitable_after_cleanup = exited_child_remains_waitable(process_id);

        assert!(
            matches!(waitable_before_cleanup, Ok(true)),
            "liveness observation must not reap the group leader before group cleanup: \
             {waitable_before_cleanup:?}"
        );
        assert_eq!(
            waitable_after_cleanup
                .expect_err("group cleanup must finally reap the helper")
                .raw_os_error(),
            Some(libc::ECHILD),
            "the helper must become non-waitable only after group cleanup"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn system_helper_disables_group_signal_after_child_identity_is_unobservable() {
        let mut sentinel_command = tokio::process::Command::new("/bin/sleep");
        sentinel_command
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        sentinel_command.process_group(0);
        let mut sentinel = sentinel_command.spawn().expect("sentinel process group");
        let sentinel_process_group = sentinel.id().expect("sentinel process group ID");

        let mut exited_command = tokio::process::Command::new("/bin/sh");
        exited_command
            .args(["-c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let exited_child = exited_command.spawn().expect("exited helper leader");
        let exited_process_id = exited_child.id().expect("exited helper process ID");
        let mut status = 0;
        loop {
            // SAFETY: the PID belongs to the direct child created immediately
            // above, and `status` points to writable wait-status storage.
            let result = unsafe {
                libc::waitpid(
                    exited_process_id as libc::pid_t,
                    std::ptr::addr_of_mut!(status),
                    0,
                )
            };
            if result == exited_process_id as libc::pid_t {
                break;
            }
            let error = std::io::Error::last_os_error();
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::Interrupted,
                "manual reap of the helper leader failed: {error}"
            );
        }

        let helper = SystemOpenCodeHelperProcess {
            process_group_id: i32::try_from(sentinel_process_group).ok(),
            process_group_identity_reserved: AtomicBool::new(true),
            child: Mutex::new(Some(exited_child)),
            stdout_task: Mutex::new(None),
        };
        let observed_exited = helper.has_exited();

        let mut replacement_command = tokio::process::Command::new("/bin/sleep");
        replacement_command
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let replacement = replacement_command
            .spawn()
            .expect("identity-safe replacement helper");
        *helper
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(replacement);
        helper.terminate();

        let sentinel_was_signaled =
            tokio::time::timeout(Duration::from_millis(250), sentinel.wait())
                .await
                .is_ok();
        if !sentinel_was_signaled {
            let _ = sentinel.start_kill();
            let _ = sentinel.wait().await;
        }

        assert!(
            observed_exited,
            "an unobservable owned child must fail open as exited"
        );
        assert!(
            !sentinel_was_signaled,
            "losing the leader identity must disable signaling the stored numeric process group"
        );
    }

    #[tokio::test]
    async fn cancelling_cleanup_before_reap_preserves_exactly_one_fallback_owner() {
        let helper = Arc::new(PausingOpenCodeHelper::default());
        let resources = Arc::new(OpenCodeObserverResources {
            helper: helper.clone(),
            owned_root: Mutex::new(None),
            launched: AtomicBool::new(false),
            cleanup_state: AtomicU8::new(OPENCODE_CLEANUP_IDLE),
            ownership_transferred: tokio::sync::Notify::new(),
        });
        let cleanup_started = helper.terminate_and_reap_started.notified();
        let cleanup_resources = resources.clone();
        let cleanup = tokio::spawn(async move {
            cleanup_resources.cleanup_helper().await;
        });
        cleanup_started.await;

        let completed_before_reap =
            resources.cleanup_state.load(Ordering::Acquire) == OPENCODE_CLEANUP_REAPED;
        cleanup.abort();
        let _ = cleanup.await;
        drop(resources);

        assert!(
            !completed_before_reap,
            "cleanup must not publish completion before terminate-and-reap returns"
        );
        assert_eq!(
            helper.terminate_calls.load(Ordering::Acquire),
            1,
            "cancellation must leave exactly one fallback owner to terminate the helper"
        );
    }

    #[tokio::test]
    async fn ownership_transfer_before_cleanup_worker_poll_does_not_stop_helper() {
        let helper = Arc::new(RecordingOpenCodeHelper::default());
        let resources = Arc::new(OpenCodeObserverResources {
            helper: helper.clone(),
            owned_root: Mutex::new(None),
            launched: AtomicBool::new(true),
            cleanup_state: AtomicU8::new(OPENCODE_CLEANUP_IDLE),
            ownership_transferred: tokio::sync::Notify::new(),
        });
        let generation = TerminalObserverGeneration::new(
            "thread-transfer-before-poll".to_owned(),
            "terminal-transfer-before-poll".to_owned(),
        );

        resources.transfer_ownership();
        generation.request_cancellation(
            super::super::TerminalObserverCancellationReason::PreparationRejected,
        );
        monitor_opencode_pre_spawn(resources.clone(), generation).await;

        assert!(
            !helper.terminated.load(Ordering::Acquire),
            "a transfer notification emitted before the cleanup worker polls must not be lost"
        );
        assert_eq!(
            resources.cleanup_state.load(Ordering::Acquire),
            OPENCODE_CLEANUP_IDLE
        );
    }

    type RecordedRequest = (Method, String, reqwest::header::HeaderMap, Vec<u8>);

    #[derive(Clone, Debug, Default)]
    struct RecordedRequests(Arc<Mutex<Vec<RecordedRequest>>>);

    async fn opencode_fixture_handler(
        State(recorded): State<RecordedRequests>,
        request: Request,
    ) -> Response<Body> {
        let method = request.method().clone();
        let uri = request.uri().to_string();
        let headers = request.headers().clone();
        let body = to_bytes(request.into_body(), OPENCODE_HTTP_BODY_LIMIT)
            .await
            .unwrap_or_default()
            .to_vec();
        recorded
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((method.clone(), uri.clone(), headers, body));
        match (method, uri.as_str()) {
            (Method::GET, "/global/health") => json_response(json!({
                "healthy": true,
                "version": "1.18.4",
            })),
            (Method::POST, "/session") => json_response(json!({
                "id": "root-tui-session",
            })),
            (Method::GET, "/session/root-tui-session") => json_response(json!({
                "id": "root-tui-session",
            })),
            (Method::GET, "/session/child-session/message?limit=200") => {
                json_response(Value::Array(Vec::new()))
            }
            (Method::GET, uri) if uri.starts_with("/event?") => {
                let body = Body::from_stream(
                    stream::once(async {
                        tokio::time::sleep(Duration::from_millis(650)).await;
                        Ok::<Bytes, Infallible>(Bytes::from(vec![
                            b'x';
                            OPENCODE_SSE_EVENT_LIMIT + 1
                        ]))
                    })
                    .chain(stream::once(async {
                        Ok::<Bytes, Infallible>(Bytes::from_static(
                            b"data: {\"type\":\"question.asked\"}\n\
                              \ndata: {\"type\":\"server.connected\",\"properties\":{}}\n\n",
                        ))
                    })),
                );
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(body)
                    .expect("SSE response")
            }
            _ => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .expect("not-found response"),
        }
    }

    fn json_response(value: Value) -> Response<Body> {
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(value.to_string()))
            .expect("JSON response")
    }

    #[tokio::test]
    async fn system_client_scopes_auth_bounds_history_and_does_not_timeout_sse_lifetime() {
        let recorded = RecordedRequests::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("OpenCode fixture listener");
        let address = listener.local_addr().expect("OpenCode fixture address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .fallback(any(opencode_fixture_handler))
                    .with_state(recorded.clone()),
            )
            .into_future(),
        );
        let directory = tempfile::tempdir().expect("OpenCode fixture directory");
        let factory = SystemOpenCodeRemoteClientFactory;
        let mut remote = factory
            .connect(
                &format!("http://127.0.0.1:{}", address.port()),
                OPENCODE_USERNAME,
                "fixture-secret",
                directory.path(),
            )
            .await
            .expect("authenticated OpenCode client");

        assert_eq!(
            remote
                .create_root("openai/gpt-5.2")
                .await
                .expect("owned OpenCode root"),
            "root-tui-session"
        );
        assert_eq!(
            remote
                .root("root-tui-session")
                .await
                .expect("exact OpenCode root")["id"],
            "root-tui-session"
        );
        assert_eq!(
            remote
                .messages("child-session")
                .await
                .expect("bounded OpenCode messages"),
            Value::Array(Vec::new())
        );
        let started = std::time::Instant::now();
        let mut stream = remote
            .open_event_stream()
            .await
            .expect("long-lived OpenCode SSE");
        assert_eq!(
            stream
                .next_data()
                .await
                .expect_err("oversized OpenCode SSE"),
            "OpenCode SSE event exceeded its bound"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(
                &stream.next_data().await.expect("long-lived OpenCode SSE"),
            )
            .expect("OpenCode SSE JSON")["type"],
            "server.connected"
        );
        assert!(
            started.elapsed() >= Duration::from_millis(600),
            "SSE body lifetime must not inherit the 500 ms unary timeout"
        );

        {
            let requests = recorded
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            assert!(requests.iter().all(|(_, _, headers, _)| {
                headers
                    .get(reqwest::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    == Some("Basic b3BlbmNvZGU6Zml4dHVyZS1zZWNyZXQ=")
            }));
            assert!(requests.iter().all(|(_, _, headers, _)| {
                headers
                    .get("x-opencode-directory")
                    .and_then(|value| value.to_str().ok())
                    == Some(directory.path().to_string_lossy().as_ref())
            }));
            let create = requests
                .iter()
                .find(|(method, uri, _, _)| *method == Method::POST && uri == "/session")
                .expect("OpenCode create-root request");
            assert_eq!(
                serde_json::from_slice::<Value>(&create.3).expect("create-root JSON")["model"],
                json!({
                    "providerID": "openai",
                    "id": "gpt-5.2",
                })
            );
        }
        server.abort();
        let _ = server.await;
    }

    #[test]
    fn sse_parser_accepts_lf_and_crlf_frames_and_rejects_oversized_events() {
        let mut decoder = OpenCodeSseDecoder::default();
        decoder
            .push(b"event: message\r\ndata: {\"type\":\"server.connected\"}\r\n\r\n")
            .expect("CRLF SSE chunk");
        assert_eq!(
            decoder
                .take_event()
                .expect("CRLF SSE frame")
                .expect("CRLF SSE event")["type"],
            "server.connected"
        );
        decoder
            .push(b"data: {\"type\":\"session.status\"}\n\n")
            .expect("LF SSE chunk");
        assert_eq!(
            decoder
                .take_event()
                .expect("LF SSE frame")
                .expect("LF SSE event")["type"],
            "session.status"
        );
        let mut buffer = vec![b'x'; OPENCODE_SSE_EVENT_LIMIT + 1];
        buffer.extend_from_slice(b"\n\n");
        decoder.push(&buffer).expect("oversized SSE chunk");
        assert!(decoder.take_event().is_err());
    }

    #[test]
    fn health_version_parser_accepts_only_three_numeric_semver_components() {
        assert_eq!(
            parse_opencode_version("opencode 1.18.4"),
            Some("1.18.4".to_owned())
        );
        for invalid in [
            "1..18.4",
            "1.18.",
            "1.18.4.1",
            "v1.18.4",
            "1.18.4-beta",
            "01.18.4",
        ] {
            assert_eq!(
                parse_opencode_version(invalid),
                None,
                "invalid health version {invalid:?} must fail closed"
            );
        }
    }

    #[test]
    fn loopback_endpoint_rejects_any_url_decoration() {
        assert!(valid_loopback_endpoint("http://127.0.0.1:43127"));
        assert!(valid_loopback_endpoint("http://127.0.0.1:43127/"));
        for invalid in [
            "http://127.0.0.1:43127/?directory=/tmp",
            "http://127.0.0.1:43127/#listener",
        ] {
            assert!(
                !valid_loopback_endpoint(invalid),
                "decorated helper endpoint {invalid:?} must fail closed"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_helper_readiness_is_killed_and_reaped_before_error_returns() {
        use std::os::unix::fs::PermissionsExt;

        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let root = tempfile::tempdir().expect("OpenCode helper process root");
        let executable = root.path().join("invalid-opencode-helper");
        let pid_path = root.path().join("helper.pid");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s' \"$$\" > \"$OPENCODE_TEST_PID_PATH\"\nprintf 'opencode server listening on http://0.0.0.0:43127\\n'\nsleep 60\n",
        )
        .expect("OpenCode helper script");
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
            .expect("OpenCode helper script permissions");
        let launcher = SystemOpenCodeHelperLauncher;
        let result = launcher
            .start(OpenCodeHelperLaunch {
                executable: executable.to_string_lossy().into_owned(),
                args: Vec::new(),
                cwd: root.path().to_path_buf(),
                env: BTreeMap::from([(
                    "OPENCODE_TEST_PID_PATH".to_owned(),
                    pid_path.to_string_lossy().into_owned(),
                )]),
            })
            .await;

        assert!(result.is_err());
        let pid = std::fs::read_to_string(&pid_path)
            .expect("OpenCode helper PID")
            .parse::<i32>()
            .expect("numeric OpenCode helper PID");
        tokio::time::timeout(Duration::from_millis(500), async {
            loop {
                // SAFETY: signal zero only checks the exact test-child PID and
                // does not change process state.
                if unsafe { libc::kill(pid, 0) } == -1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("failed OpenCode helper must be reaped before returning");
    }
}
