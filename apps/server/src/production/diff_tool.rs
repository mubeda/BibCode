//! Diff apps through `git difftool`: `review.listDiffTools` lists the ones Git finds on this
//! computer, and `review.openDiffTool` opens one on a file or on every file of a scope.
//!
//! A diff app holds the user's work: the working-tree side is the real file, and in
//! `--dir-diff` Git copies an edited temporary file back only when the tool exits. So a launched
//! app outlives BiBCode. Its `git difftool` is registered with `survives_shutdown`, which keeps
//! it and the app below it out of both shutdown cleanups, and nothing kills it on drop.

use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use tokio::process::{Child, Command};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{
    diagnostics::{
        AttributionKind, AttributionScope, NativeProcessSampler, ProcessAttributionRegistry,
        ProcessRegistration, ProcessRegistrationError, ProcessRegistrationMetadata,
        RegistrationSource,
        profiler::exits::{self, Exited, Watch},
    },
    git::{OutputPolicy, ProcessRequest, ProcessRunner},
    review::{
        DiffToolBackend, ReviewDiffTool, ReviewDiffToolDefaultSource, ReviewDiffToolFailure,
        ReviewDiffToolFailureReason, ReviewDiffToolKind, ReviewDiffToolList,
        ReviewDiffToolListFuture, ReviewDiffToolOpenFuture, ReviewDiffToolScope,
        ReviewDiffToolTarget, ReviewError, ReviewListDiffToolsInput, ReviewOpenDiffToolInput,
    },
};

/// At most this many launched `git difftool` processes run at once.
pub(crate) const MAX_RUNNING_DIFF_TOOLS: usize = 16;
/// How long a launch waits to see the tool fail before it reports the tool as open.
const LAUNCH_WINDOW: Duration = Duration::from_secs(1);
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_OUTPUT_LIMIT: usize = 256 * 1024;
const STDERR_TAIL_BYTES: usize = 2048;
const MAX_TOOL_ID_LEN: usize = 64;
/// What profiler records call the launched process. It counts signals only.
const DIFFTOOL_LABEL: &str = "git-difftool";
/// What the process sampler attributes the app's memory to.
const DIFF_APP_LABEL: &str = "diff app";
/// Numbers launches across every launcher in the process, so two runtimes in one process
/// never share a log.
static NEXT_LAUNCH: AtomicU64 = AtomicU64::new(1);

/// A tool ID Git accepts as `--tool=<id>`: never an option, a path or shell.
#[must_use]
pub(crate) fn is_valid_tool_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    id.len() <= MAX_TOOL_ID_LEN
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

const GRAPHICAL: &str = "(requires a graphical session)";
const UNAVAILABLE_HEADING: &str = "The following tools are valid, but not currently available";

/// Parses `git difftool --tool-help` run with `LC_ALL=C`. Only the first section lists tools
/// available here. Built-ins are kept when they need a graphical session, so terminal tools
/// such as `vimdiff` are left out, and `user-defined:` entries (`<name>.cmd …`) are kept once.
pub(crate) fn parse_tool_help(output: &str) -> Vec<ReviewDiffTool> {
    let mut tools = Vec::new();
    let mut seen = HashSet::new();
    let mut labels = HashSet::new();
    let mut user_defined = false;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(UNAVAILABLE_HEADING) {
            break;
        }
        if trimmed == "user-defined:" {
            user_defined = true;
            continue;
        }
        // Headings start at the margin; entries are indented.
        if trimmed.is_empty() || !line.starts_with(char::is_whitespace) {
            continue;
        }
        let (name, rest) = trimmed
            .split_once(char::is_whitespace)
            .map_or((trimmed, ""), |(name, rest)| (name, rest.trim()));
        if user_defined {
            // Git 2.54 prints `<name>.cmd <command>`; an older Git may print the name alone.
            let id = name.strip_suffix(".cmd").unwrap_or(name);
            if is_valid_tool_id(id) && seen.insert(id.to_owned()) {
                labels.insert(id.to_owned());
                tools.push(ReviewDiffTool {
                    id: id.to_owned(),
                    label: id.to_owned(),
                    kind: ReviewDiffToolKind::Custom,
                });
            }
            continue;
        }
        if !rest.contains(GRAPHICAL) || !is_valid_tool_id(name) || !seen.insert(name.to_owned()) {
            continue;
        }
        let description = rest.replace(GRAPHICAL, "");
        let description = description.trim();
        let base = description
            .strip_prefix("Use ")
            .unwrap_or(description)
            .trim();
        let base = if base.is_empty() { name } else { base };
        // `bc`, `bc3` and `bc4` all say Beyond Compare; the later ones name their ID.
        let label = if labels.insert(base.to_owned()) {
            base.to_owned()
        } else {
            format!("{base} ({name})")
        };
        tools.push(ReviewDiffTool {
            id: name.to_owned(),
            label,
            kind: ReviewDiffToolKind::Builtin,
        });
    }
    tools
}

const DEFAULT_SOURCES: [(&str, ReviewDiffToolDefaultSource); 4] = [
    ("diff.guitool", ReviewDiffToolDefaultSource::DiffGuiTool),
    ("merge.guitool", ReviewDiffToolDefaultSource::MergeGuiTool),
    ("diff.tool", ReviewDiffToolDefaultSource::DiffTool),
    ("merge.tool", ReviewDiffToolDefaultSource::MergeTool),
];

/// Parses `git config --get-regexp` output: one `key value` pair per line, keys lowercased.
pub(crate) fn parse_tool_config(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| {
            let (key, value) = line.trim().split_once(char::is_whitespace)?;
            Some((key.to_ascii_lowercase(), value.trim().to_owned()))
        })
        .collect()
}

/// The first of `diff.guitool`, `merge.guitool`, `diff.tool` and `merge.tool` whose value is a
/// listed tool: Git's own order for `--gui`.
pub(crate) fn resolve_default_tool(
    tools: &[ReviewDiffTool],
    config: &HashMap<String, String>,
) -> Option<(String, ReviewDiffToolDefaultSource)> {
    DEFAULT_SOURCES.iter().find_map(|(key, source)| {
        let value = config.get(*key)?;
        tools
            .iter()
            .any(|tool| &tool.id == value)
            .then(|| (value.clone(), *source))
    })
}

/// The arguments after `git -C <cwd>`. `revisions` are already resolved; paths are checked
/// lexically only, because a deleted file, a rename's old side and a file that exists only in
/// a base or a checkpoint are all valid pathspecs that are not on disk.
pub(crate) fn difftool_args(
    cwd: &Path,
    tool_id: &str,
    target: &ReviewDiffToolTarget,
    revisions: &[String],
) -> Result<Vec<String>, String> {
    if !is_valid_tool_id(tool_id) {
        return Err(format!("\"{tool_id}\" is not a diff tool name."));
    }
    let mut args = vec![
        "difftool".to_owned(),
        "-y".to_owned(),
        // Without it Git exits 0 whatever the tool did.
        "--trust-exit-code".to_owned(),
    ];
    if matches!(target, ReviewDiffToolTarget::All) {
        args.push("--dir-diff".to_owned());
    }
    args.push(format!("--tool={tool_id}"));
    let mut paths = Vec::new();
    if let ReviewDiffToolTarget::File {
        path,
        previous_path,
    } = target
    {
        paths.push(lexical_path(cwd, path)?);
        if let Some(previous_path) = previous_path {
            args.push("-M".to_owned());
            paths.push(lexical_path(cwd, previous_path)?);
        }
    }
    args.extend(revisions.iter().cloned());
    args.push("--".to_owned());
    args.extend(paths);
    Ok(args)
}

fn lexical_path(cwd: &Path, path: &str) -> Result<String, String> {
    crate::workspace::paths::resolve_relative(cwd, path)
        .map(|(_, normalized)| normalized)
        .map_err(|error| error.to_string())
}

fn failure(
    reason: ReviewDiffToolFailureReason,
    message: impl Into<String>,
    command: Vec<String>,
) -> ReviewError {
    ReviewError::DiffTool(ReviewDiffToolFailure::new(reason, message, command))
}

fn invalid(message: impl Into<String>) -> ReviewError {
    failure(
        ReviewDiffToolFailureReason::InvalidRequest,
        message,
        Vec::new(),
    )
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Launches diff apps and owns their reapers until shutdown.
#[derive(Clone)]
pub(crate) struct DiffToolLauncher {
    state: Arc<LauncherState>,
}

struct LauncherState {
    registry: ProcessAttributionRegistry,
    shutdown: CancellationToken,
    reapers: TaskTracker,
    running: Mutex<usize>,
    /// Each running launch's registration, kept until its process exits. A shutdown leaves
    /// them here, so the survivors are still registered when ownership is frozen.
    registrations: Mutex<HashMap<u64, ProcessRegistration>>,
    /// `LAUNCH_WINDOW`, except in a test that must stay inside the window.
    launch_window: Duration,
}

impl DiffToolLauncher {
    pub(crate) fn new(registry: ProcessAttributionRegistry) -> Self {
        Self::with_launch_window(registry, LAUNCH_WINDOW)
    }

    fn with_launch_window(registry: ProcessAttributionRegistry, launch_window: Duration) -> Self {
        Self {
            state: Arc::new(LauncherState {
                registry,
                shutdown: CancellationToken::new(),
                reapers: TaskTracker::new(),
                running: Mutex::new(0),
                registrations: Mutex::new(HashMap::new()),
                launch_window,
            }),
        }
    }

    /// Stops accepting launches and cancels the reapers without signalling their processes.
    /// Runs before process ownership is frozen; the registrations stay until the runtime drops.
    pub(crate) async fn shutdown(&self) {
        self.state.shutdown.cancel();
        self.state.reapers.close();
        self.state.reapers.wait().await;
    }

    /// How many launched tools are running.
    #[cfg(all(test, unix))]
    pub(crate) fn running(&self) -> usize {
        *lock(&self.state.running)
    }

    async fn list(
        &self,
        input: &ReviewListDiffToolsInput,
        cancellation: &CancellationToken,
    ) -> Result<ReviewDiffToolList, ReviewError> {
        let cwd = PathBuf::from(&input.cwd);
        let help = run_git(
            &cwd,
            "Review.listDiffTools.toolHelp",
            &["difftool", "--tool-help"],
            false,
            cancellation,
        )
        .await?;
        let mut tools = parse_tool_help(&help);
        let config = run_git(
            &cwd,
            "Review.listDiffTools.config",
            &["config", "--get-regexp", r"^(diff|merge)\.(guitool|tool)$"],
            true,
            cancellation,
        )
        .await?;
        let config = parse_tool_config(&config);
        // The help is not a documented format. If nothing parses, still offer the tool the
        // user configured, which Git itself would run.
        if tools.is_empty()
            && let Some(id) = config
                .get("diff.guitool")
                .or_else(|| config.get("diff.tool"))
                .filter(|id| is_valid_tool_id(id))
        {
            tools.push(ReviewDiffTool {
                id: id.clone(),
                label: id.clone(),
                kind: ReviewDiffToolKind::Custom,
            });
        }
        let default = resolve_default_tool(&tools, &config);
        Ok(ReviewDiffToolList {
            tools,
            default_tool_id: default.as_ref().map(|(id, _)| id.clone()),
            default_source: default.map(|(_, source)| source),
        })
    }

    async fn open(&self, input: &ReviewOpenDiffToolInput) -> Result<(), ReviewError> {
        if self.state.shutdown.is_cancelled() {
            return Err(failure(
                ReviewDiffToolFailureReason::ShuttingDown,
                "BiBCode is shutting down.",
                Vec::new(),
            ));
        }
        // Git prints a patch's paths from the repository's top, also for a project in a
        // subdirectory of it, so Git runs there and the paths mean the same files.
        let top = run_git(
            Path::new(&input.cwd),
            "Review.openDiffTool.top",
            &["rev-parse", "--show-toplevel"],
            false,
            &CancellationToken::new(),
        )
        .await?;
        let top = top.trim();
        if top.is_empty() {
            return Err(invalid("This folder is not in a Git repository."));
        }
        let cwd = PathBuf::from(top);
        let revisions = self.revisions(&cwd, &input.scope).await?;
        let args =
            difftool_args(&cwd, &input.tool_id, &input.target, &revisions).map_err(invalid)?;
        let mut command = vec!["git".to_owned(), "-C".to_owned(), top.to_owned()];
        command.extend(args.iter().cloned());
        let Some(slot) = RunningSlot::reserve(&self.state) else {
            return Err(failure(
                ReviewDiffToolFailureReason::TooManyOpen,
                format!(
                    "{MAX_RUNNING_DIFF_TOOLS} diff apps are already open. Close one and try again."
                ),
                command,
            ));
        };
        let (launch, log) = LaunchLog::create().map_err(|error| {
            failure(
                ReviewDiffToolFailureReason::LaunchFailed,
                format!("Couldn't start git difftool: {error}"),
                command.clone(),
            )
        })?;
        let mut child = spawn_difftool(&cwd, &args, &log.file).map_err(|error| {
            failure(
                ReviewDiffToolFailureReason::LaunchFailed,
                format!("Couldn't start git difftool: {error}"),
                command.clone(),
            )
        })?;
        let started = Instant::now();
        let pid = child.id();
        // Registered so the sampler does not count the app as BiBCode's memory, and so
        // shutdown leaves it running. An app that already exited has no identity to register.
        let registration = pid
            .and_then(|pid| NativeProcessSampler::process_identity(pid).ok())
            .map(|identity| {
                self.state.registry.register_identity(
                    identity,
                    ProcessRegistrationMetadata {
                        scope: AttributionScope::External,
                        kind: AttributionKind::Helper,
                        label: DIFF_APP_LABEL.to_owned(),
                        source: RegistrationSource::Helper,
                        driver: None,
                        survives_shutdown: true,
                    },
                )
            });
        match registration {
            Some(Ok(registration)) => {
                lock(&self.state.registrations).insert(launch, registration);
            }
            // Ownership froze while the app started: unregistered, the standalone cleanup
            // would end it anyway, so end it now and say why.
            Some(Err(ProcessRegistrationError::Shutdown)) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(failure(
                    ReviewDiffToolFailureReason::ShuttingDown,
                    "BiBCode is shutting down.",
                    command,
                ));
            }
            Some(Err(ProcessRegistrationError::Capacity)) | None => {}
        }

        // The reaper owns the process from here, so a request dropped during the launch window
        // frees the slot, the registration and the log only when the tool exits.
        let (window, exited) = tokio::sync::oneshot::channel();
        let launcher = self.clone();
        let running = RunningLaunch {
            launch,
            child,
            pid,
            started,
            tool_id: input.tool_id.clone(),
            log,
            slot,
            window,
        };
        self.state
            .reapers
            .spawn(async move { launcher.reap(running).await });
        match tokio::time::timeout(self.state.launch_window, exited).await {
            // Some launchers hand the files to a running app and return at once.
            Ok(Ok(WindowExit::Exited { status, .. })) if status.success() => Ok(()),
            Ok(Ok(WindowExit::Exited { status, detail })) => {
                let code = status
                    .code()
                    .map_or_else(|| "a signal".to_owned(), |code| format!("exit {code}"));
                let message = if detail.is_empty() {
                    format!("git difftool failed ({code}).")
                } else {
                    format!("{detail} ({code})")
                };
                Err(failure(
                    ReviewDiffToolFailureReason::LaunchFailed,
                    message,
                    command,
                ))
            }
            Ok(Ok(WindowExit::WaitFailed(error))) => Err(failure(
                ReviewDiffToolFailureReason::LaunchFailed,
                format!("Couldn't follow git difftool: {error}"),
                command,
            )),
            // Still running, or shutdown began and left it running: the app is open.
            Ok(Err(_)) | Err(_) => Ok(()),
        }
    }

    async fn reap(&self, running: RunningLaunch) {
        let RunningLaunch {
            launch,
            mut child,
            pid,
            started,
            tool_id,
            log,
            slot,
            window,
        } = running;
        tokio::select! {
            status = child.wait() => {
                // Freed before the launch hears of the exit, so it never sees a stale count.
                drop(slot);
                let exit = match status {
                    Ok(status) => {
                        let detail = if status.success() { String::new() } else { log.tail() };
                        self.finish(launch, pid, started, &status, log);
                        WindowExit::Exited { status, detail }
                    }
                    Err(error) => {
                        tracing::warn!(tool = %tool_id, %error, "could not wait for a diff app");
                        lock(&self.state.registrations).remove(&launch);
                        WindowExit::WaitFailed(error)
                    }
                };
                // A launch still in its window reports the exit; a later failure is only logged.
                if let Err(WindowExit::Exited { status, .. }) = window.send(exit)
                    && !status.success()
                {
                    tracing::warn!(
                        tool = %tool_id,
                        exit_code = ?status.code(),
                        "diff app exited with a failure"
                    );
                }
            }
            // Shutdown: leave the app running, its registration a survivor, and its log in the
            // temporary directory, where Git's own temporary files also stay until it exits.
            () = self.state.shutdown.cancelled() => {
                log.keep();
                drop(slot);
            }
        }
    }

    /// Reports the exit and lets the launch go: its registration and its log.
    fn finish(
        &self,
        launch: u64,
        pid: Option<u32>,
        started: Instant,
        status: &ExitStatus,
        log: LaunchLog,
    ) {
        if let Some(pid) = pid
            && exits::watching()
        {
            exits::report_exit(
                Watch::Signals,
                &Exited {
                    kind: "command",
                    label: DIFFTOOL_LABEL,
                    exe: "git",
                    pid,
                    started,
                },
                status,
                false,
            );
        }
        lock(&self.state.registrations).remove(&launch);
        drop(log);
    }

    /// The revisions to compare, built on the server: the client never names a ref.
    async fn revisions(
        &self,
        cwd: &Path,
        scope: &ReviewDiffToolScope,
    ) -> Result<Vec<String>, ReviewError> {
        match scope {
            ReviewDiffToolScope::WorkingTree => Ok(vec!["HEAD".to_owned()]),
            ReviewDiffToolScope::Branch { base_ref } => {
                let base = match base_ref {
                    Some(base_ref) => base_ref.trim().to_owned(),
                    None => crate::git::GitRepository::default()
                        .local_status(cwd, &CancellationToken::new())
                        .await
                        .map_err(|error| ReviewError::Backend(error.to_string()))?
                        .default_ref_name
                        .ok_or_else(|| invalid("There is no base branch to compare against."))?,
                };
                crate::review::validate_review_diff_options(Some(&base), None)
                    .map_err(|error| invalid(error.to_string()))?;
                let commit = format!("{base}^{{commit}}");
                let oid = run_git(
                    cwd,
                    "Review.openDiffTool.base",
                    &[
                        "rev-parse",
                        "--verify",
                        "--quiet",
                        "--end-of-options",
                        &commit,
                    ],
                    true,
                    &CancellationToken::new(),
                )
                .await?;
                let oid = oid.trim();
                if !crate::review::is_git_object_id(oid) {
                    return Err(invalid(format!(
                        "The base branch {base} is not in the repository."
                    )));
                }
                Ok(vec![format!("{oid}...HEAD")])
            }
            ReviewDiffToolScope::Turn {
                thread_id,
                from_turn_count,
                to_turn_count,
            } => {
                if *from_turn_count < 0 || to_turn_count < from_turn_count {
                    return Err(invalid("Turn counts must be non-negative and ordered."));
                }
                Ok([*from_turn_count, *to_turn_count]
                    .into_iter()
                    .map(|count| {
                        format!(
                            "{}^{{commit}}",
                            super::orchestration_effects::checkpoint_ref(thread_id, count)
                        )
                    })
                    .collect())
            }
        }
    }
}

impl DiffToolBackend for DiffToolLauncher {
    fn list_diff_tools<'a>(
        &'a self,
        input: &'a ReviewListDiffToolsInput,
        cancellation: &'a CancellationToken,
    ) -> ReviewDiffToolListFuture<'a> {
        Box::pin(self.list(input, cancellation))
    }

    fn open_diff_tool<'a>(
        &'a self,
        input: &'a ReviewOpenDiffToolInput,
    ) -> ReviewDiffToolOpenFuture<'a> {
        Box::pin(self.open(input))
    }
}

/// A launched tool, handed to its reaper as soon as it starts.
struct RunningLaunch {
    launch: u64,
    child: Child,
    pid: Option<u32>,
    started: Instant,
    tool_id: String,
    log: LaunchLog,
    slot: RunningSlot,
    /// Tells a launch still in its window how the tool ended.
    window: tokio::sync::oneshot::Sender<WindowExit>,
}

/// How a launched tool ended, for a launch still waiting in its window.
enum WindowExit {
    Exited { status: ExitStatus, detail: String },
    WaitFailed(std::io::Error),
}

/// One of the at most 16 running launches; dropping it frees the slot.
struct RunningSlot(Arc<LauncherState>);

impl RunningSlot {
    fn reserve(state: &Arc<LauncherState>) -> Option<Self> {
        let mut running = lock(&state.running);
        if *running >= MAX_RUNNING_DIFF_TOOLS {
            return None;
        }
        *running += 1;
        Some(Self(Arc::clone(state)))
    }
}

impl Drop for RunningSlot {
    fn drop(&mut self) {
        let mut running = lock(&self.0.running);
        *running = running.saturating_sub(1);
    }
}

/// The launched `git difftool`'s stderr, in the temporary directory. Deleted when the launch
/// ends, and kept when BiBCode exits first.
struct LaunchLog {
    path: PathBuf,
    file: std::fs::File,
    keep: bool,
}

impl LaunchLog {
    /// A new log and its launch number. A name already taken, such as a log an earlier
    /// process with the same ID kept, is skipped, never reused or followed.
    fn create() -> std::io::Result<(u64, Self)> {
        let mut attempts = 0;
        loop {
            let launch = NEXT_LAUNCH.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "bibcode-difftool-{}-{launch}.log",
                std::process::id()
            ));
            match std::fs::OpenOptions::new()
                .append(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => {
                    return Ok((
                        launch,
                        Self {
                            path,
                            file,
                            keep: false,
                        },
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempts < 8 => {
                    attempts += 1;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// The last 2 KiB of what Git and the tool wrote, trimmed.
    fn tail(&self) -> String {
        let bytes = std::fs::read(&self.path).unwrap_or_default();
        let start = bytes.len().saturating_sub(STDERR_TAIL_BYTES);
        String::from_utf8_lossy(&bytes[start..]).trim().to_owned()
    }

    fn keep(mut self) {
        self.keep = true;
    }
}

impl Drop for LaunchLog {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn spawn_difftool(cwd: &Path, args: &[String], log: &std::fs::File) -> std::io::Result<Child> {
    #[cfg(windows)]
    {
        // A kill-on-close job would end the app with BiBCode. Break away from it, and retry
        // in it when the job forbids breakaway: the app then ends with BiBCode.
        const ERROR_ACCESS_DENIED: i32 = 5;
        match spawn_difftool_once(cwd, args, log, true) {
            Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
                spawn_difftool_once(cwd, args, log, false)
            }
            result => result,
        }
    }
    #[cfg(not(windows))]
    spawn_difftool_once(cwd, args, log)
}

fn spawn_difftool_once(
    cwd: &Path,
    args: &[String],
    log: &std::fs::File,
    #[cfg(windows)] breakaway: bool,
) -> std::io::Result<Child> {
    let stderr = log.try_clone()?;
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args(args)
        // Paths after `--` are literal: pathspec magic such as `:(top)` does not apply.
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr))
        // The app outlives the request, the reaper, and BiBCode itself.
        .kill_on_drop(false);
    crate::process::isolate_appimage_environment(&mut command);
    #[cfg(unix)]
    // Its own process group, so a terminal's Ctrl+C to a standalone server does not reach it.
    command.process_group(0);
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{
            CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
        };
        let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
        command.creation_flags(if breakaway {
            base | CREATE_BREAKAWAY_FROM_JOB
        } else {
            base
        });
    }
    command.spawn()
}

/// Runs a short Git read: C locale, so `--tool-help` headings are stable, and no prompts.
async fn run_git(
    cwd: &Path,
    operation: &str,
    args: &[&str],
    allow_non_zero_exit: bool,
    cancellation: &CancellationToken,
) -> Result<String, ReviewError> {
    let mut env = crate::git::git_read_environment();
    env.push(("LC_ALL".into(), "C".into()));
    env.push(("LANGUAGE".into(), OsString::new()));
    env.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
    ProcessRunner
        .run(
            ProcessRequest {
                operation: operation.to_owned(),
                command: PathBuf::from("git"),
                args: args.iter().map(OsString::from).collect(),
                cwd: cwd.to_path_buf(),
                env,
                stdin: None,
                timeout: GIT_TIMEOUT,
                max_output_bytes: GIT_OUTPUT_LIMIT,
                output_policy: OutputPolicy::Truncate,
                append_truncation_marker: false,
                allow_non_zero_exit,
            },
            cancellation,
        )
        .await
        .map(|output| output.stdout)
        .map_err(|error| ReviewError::Backend(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// `git difftool --tool-help` from Git 2.54 under `LC_ALL=C`, with Sourcetree's custom tool
    /// configured for both `difftool` and `mergetool`.
    const TOOL_HELP: &str = "\
'git difftool --tool=<tool>' may be set to one of the following:
\t\taraxis           Use Araxis Merge (requires a graphical session)
\t\tbc               Use Beyond Compare (requires a graphical session)
\t\tbc3              Use Beyond Compare (requires a graphical session)
\t\tbc4              Use Beyond Compare (requires a graphical session)
\t\topendiff         Use FileMerge (requires a graphical session)
\t\tvimdiff          Use Vim

\tuser-defined:
\t\tsourcetree.cmd /Applications/Sourcetree.app/Contents/Resources/opendiff-w.sh \"$LOCAL\" \"$REMOTE\"
\t\tsourcetree.cmd opendiff \"$LOCAL\" \"$REMOTE\"

The following tools are valid, but not currently available:
\t\tkdiff3           Use KDiff3 (requires a graphical session)
\t\tmeld             Use Meld (requires a graphical session)
\t\tnvimdiff         Use Neovim
\t\tvscode           Use Visual Studio Code (requires a graphical session)

Some of the tools listed above only work in a windowed
environment. If run in a terminal-only session, they will fail.
";

    fn tool(id: &str, label: &str, kind: ReviewDiffToolKind) -> ReviewDiffTool {
        ReviewDiffTool {
            id: id.to_owned(),
            label: label.to_owned(),
            kind,
        }
    }

    fn file(path: &str, previous_path: Option<&str>) -> ReviewDiffToolTarget {
        ReviewDiffToolTarget::File {
            path: path.to_owned(),
            previous_path: previous_path.map(str::to_owned),
        }
    }

    fn reason(error: ReviewError) -> (ReviewDiffToolFailureReason, ReviewDiffToolFailure) {
        match error {
            ReviewError::DiffTool(failure) => (failure.reason, failure),
            error => panic!("expected a diff tool failure, got {error:?}"),
        }
    }

    #[test]
    fn tool_help_keeps_the_available_graphical_and_custom_tools() {
        use ReviewDiffToolKind::{Builtin, Custom};
        assert_eq!(
            parse_tool_help(TOOL_HELP),
            [
                tool("araxis", "Araxis Merge", Builtin),
                tool("bc", "Beyond Compare", Builtin),
                tool("bc3", "Beyond Compare (bc3)", Builtin),
                tool("bc4", "Beyond Compare (bc4)", Builtin),
                tool("opendiff", "FileMerge", Builtin),
                tool("sourcetree", "sourcetree", Custom),
            ]
        );
        // An older Git names a custom tool without its command.
        assert_eq!(
            parse_tool_help(
                "No suitable tool for 'git difftool --tool=<tool>' found.\n\tuser-defined:\n\t\tmine\n"
            ),
            [tool("mine", "mine", Custom)]
        );
        assert!(parse_tool_help("").is_empty());
    }

    #[test]
    fn the_default_is_the_first_listed_tool_in_gits_gui_order() {
        let tools = parse_tool_help(TOOL_HELP);
        let resolve = |config: &str| resolve_default_tool(&tools, &parse_tool_config(config));
        assert_eq!(
            resolve("diff.tool bc\nmerge.guitool opendiff\ndiff.guitool bc4\n"),
            Some(("bc4".to_owned(), ReviewDiffToolDefaultSource::DiffGuiTool))
        );
        // Meld is not available here, so `diff.guitool` is passed over.
        assert_eq!(
            resolve("diff.tool bc\nmerge.guitool opendiff\ndiff.guitool meld\n"),
            Some((
                "opendiff".to_owned(),
                ReviewDiffToolDefaultSource::MergeGuiTool
            ))
        );
        assert_eq!(
            resolve("merge.tool sourcetree\ndiff.tool bc3\n"),
            Some(("bc3".to_owned(), ReviewDiffToolDefaultSource::DiffTool))
        );
        assert_eq!(
            resolve("merge.tool sourcetree\n"),
            Some((
                "sourcetree".to_owned(),
                ReviewDiffToolDefaultSource::MergeTool
            ))
        );
        assert_eq!(resolve("diff.tool vimdiff\n"), None);
        assert_eq!(resolve(""), None);
    }

    #[test]
    fn a_tool_id_is_a_name_never_an_option_or_a_path() {
        for id in ["bc3", "my.tool", "a_b-c", "Meld"] {
            assert!(is_valid_tool_id(id), "{id}");
        }
        for id in [
            "",
            "-x",
            "--extcmd=sh",
            ".x",
            "a/b",
            "a\\b",
            "a b",
            "x;y",
            "$(x)",
        ] {
            assert!(!is_valid_tool_id(id), "{id}");
        }
        assert!(!is_valid_tool_id(&"a".repeat(MAX_TOOL_ID_LEN + 1)));
    }

    #[test]
    fn difftool_args_name_the_tool_the_revisions_and_literal_paths() {
        let cwd = Path::new("repo");
        let head = ["HEAD".to_owned()];
        let args = |tool: &str, target: &ReviewDiffToolTarget, revisions: &[String]| {
            difftool_args(cwd, tool, target, revisions)
        };
        assert_eq!(
            args("bc", &file("./src//a.ts", None), &head).expect("file"),
            [
                "difftool",
                "-y",
                "--trust-exit-code",
                "--tool=bc",
                "HEAD",
                "--",
                "src/a.ts"
            ]
        );
        assert_eq!(
            args("bc", &file("new.ts", Some("old.ts")), &head).expect("rename"),
            [
                "difftool",
                "-y",
                "--trust-exit-code",
                "--tool=bc",
                "-M",
                "HEAD",
                "--",
                "new.ts",
                "old.ts"
            ]
        );
        let branch = [format!("{}...HEAD", "a".repeat(40))];
        assert_eq!(
            args("meld", &ReviewDiffToolTarget::All, &branch).expect("all"),
            [
                "difftool",
                "-y",
                "--trust-exit-code",
                "--dir-diff",
                "--tool=meld",
                branch[0].as_str(),
                "--"
            ]
        );
        let turn = [1, 2].map(|count| {
            format!(
                "{}^{{commit}}",
                super::super::orchestration_effects::checkpoint_ref("thread-1", count)
            )
        });
        // Pathspec magic stays literal: the launch sets `GIT_LITERAL_PATHSPECS`.
        let arguments = args("bc", &file(":(top)a", None), &turn).expect("turn");
        assert_eq!(arguments[4..], [&turn[0], &turn[1], "--", ":(top)a"]);

        for path in ["../x", "a/../../b", "/etc/passwd", "", "."] {
            assert!(args("bc", &file(path, None), &head).is_err(), "{path:?}");
            assert!(
                args("bc", &file("new.ts", Some(path)), &head).is_err(),
                "{path:?}"
            );
        }
        assert!(args("--extcmd=sh", &ReviewDiffToolTarget::All, &head).is_err());
    }

    /// A repository on `main` with one commit.
    struct Repository {
        directory: TempDir,
    }

    impl Repository {
        fn new() -> Self {
            let repository = Self {
                directory: TempDir::new().expect("temporary repository"),
            };
            repository.git(&["init", "--quiet", "-b", "main"]);
            repository.git(&["config", "user.email", "test@bibcode.local"]);
            repository.git(&["config", "user.name", "BiBCode Test"]);
            repository.write("tracked.txt", "before\n");
            repository.git(&["add", "."]);
            repository.git(&["commit", "--quiet", "-m", "base"]);
            repository
        }

        fn path(&self) -> &Path {
            self.directory.path()
        }

        #[cfg(unix)]
        fn cwd(&self) -> String {
            self.path().to_string_lossy().into_owned()
        }

        fn write(&self, name: &str, contents: &str) {
            std::fs::write(self.path().join(name), contents).expect("fixture file");
        }

        fn git(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(self.path())
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .expect("git starts");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        }

        #[cfg(unix)]
        fn open(
            &self,
            target: ReviewDiffToolTarget,
            scope: ReviewDiffToolScope,
        ) -> ReviewOpenDiffToolInput {
            ReviewOpenDiffToolInput {
                cwd: self.cwd(),
                tool_id: "fake".to_owned(),
                target,
                scope,
            }
        }
    }

    fn launcher() -> DiffToolLauncher {
        DiffToolLauncher::new(ProcessAttributionRegistry::new())
    }

    #[tokio::test]
    async fn scopes_resolve_to_revisions_on_the_server() {
        let repository = Repository::new();
        let base = repository.git(&["rev-parse", "HEAD"]);
        repository.git(&["switch", "--quiet", "-c", "feature"]);
        let launcher = launcher();
        let revisions = |scope: ReviewDiffToolScope| {
            let launcher = launcher.clone();
            let cwd = repository.path().to_path_buf();
            async move { launcher.revisions(&cwd, &scope).await }
        };

        assert_eq!(
            revisions(ReviewDiffToolScope::WorkingTree)
                .await
                .expect("working tree"),
            ["HEAD"]
        );
        for base_ref in [Some("main".to_owned()), None] {
            assert_eq!(
                revisions(ReviewDiffToolScope::Branch { base_ref })
                    .await
                    .expect("branch"),
                [format!("{base}...HEAD")]
            );
        }
        for base_ref in ["--output=x", "-x", "missing"] {
            let error = revisions(ReviewDiffToolScope::Branch {
                base_ref: Some(base_ref.to_owned()),
            })
            .await
            .expect_err(base_ref);
            assert_eq!(
                reason(error).0,
                ReviewDiffToolFailureReason::InvalidRequest,
                "{base_ref}"
            );
        }
        assert_eq!(
            revisions(ReviewDiffToolScope::Turn {
                thread_id: "thread-1".to_owned(),
                from_turn_count: 0,
                to_turn_count: 2,
            })
            .await
            .expect("turn"),
            [0, 2].map(|count| format!(
                "{}^{{commit}}",
                super::super::orchestration_effects::checkpoint_ref("thread-1", count)
            ))
        );
        for (from_turn_count, to_turn_count) in [(-1, 2), (2, 1)] {
            let error = revisions(ReviewDiffToolScope::Turn {
                thread_id: "thread-1".to_owned(),
                from_turn_count,
                to_turn_count,
            })
            .await
            .expect_err("unordered turns");
            assert_eq!(reason(error).0, ReviewDiffToolFailureReason::InvalidRequest);
        }
    }

    #[tokio::test]
    async fn a_launch_after_shutdown_is_refused_before_git_starts() {
        let launcher = launcher();
        launcher.shutdown().await;
        let error = launcher
            .open(&ReviewOpenDiffToolInput {
                cwd: "missing-repository".to_owned(),
                tool_id: "fake".to_owned(),
                target: ReviewDiffToolTarget::All,
                scope: ReviewDiffToolScope::WorkingTree,
            })
            .await
            .expect_err("shutting down");
        assert_eq!(reason(error).0, ReviewDiffToolFailureReason::ShuttingDown);
    }

    /// A fake tool `fake` in the repository's Git config. It appends its process group, which
    /// is its `git difftool`'s ID, to `pgids`, and the path and both sides' contents to
    /// `calls.log`, then runs `then`.
    #[cfg(unix)]
    struct FakeTool {
        directory: TempDir,
    }

    #[cfg(unix)]
    impl FakeTool {
        fn install(repository: &Repository, then: &str) -> Self {
            let directory = TempDir::new().expect("tool directory");
            let script = directory.path().join("tool.sh");
            std::fs::write(
                &script,
                format!(
                    r#"#!/bin/sh
dir=$(dirname "$0")
ps -o pgid= -p $$ | tr -d ' ' >> "$dir/pgids"
{{
  printf '%s\n' "$3"
  if [ -f "$1" ]; then cat "$1"; fi
  printf -- '--\n'
  if [ -f "$2" ]; then cat "$2"; fi
  printf '==\n'
}} >> "$dir/calls.log"
{then}
"#
                ),
            )
            .expect("tool script");
            repository.git(&[
                "config",
                "difftool.fake.cmd",
                &format!(
                    "sh '{}' \"$LOCAL\" \"$REMOTE\" \"$MERGED\"",
                    script.display()
                ),
            ]);
            Self { directory }
        }

        /// The calls so far, which it then forgets.
        fn take_calls(&self) -> String {
            let log = self.directory.path().join("calls.log");
            let calls = std::fs::read_to_string(&log).unwrap_or_default();
            let _ = std::fs::remove_file(log);
            calls
        }

        fn pgids(&self) -> Vec<i32> {
            std::fs::read_to_string(self.directory.path().join("pgids"))
                .unwrap_or_default()
                .lines()
                .filter_map(|line| line.trim().parse().ok())
                .collect()
        }

        /// Kills each launch's whole process group, as a crash or the user would end it.
        fn kill_all(&self) {
            for pgid in self.pgids() {
                // SAFETY: a negative ID names the process group the tool reported.
                unsafe { libc::kill(-pgid, libc::SIGKILL) };
            }
        }
    }

    #[cfg(unix)]
    impl Drop for FakeTool {
        fn drop(&mut self) {
            self.kill_all();
        }
    }

    #[cfg(unix)]
    async fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting until {what}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_tool_still_running_after_the_launch_window_is_open_and_a_shutdown_survivor() {
        let exits = exits::CapturedExits::start();
        let repository = Repository::new();
        repository.write("tracked.txt", "after\n");
        let tool = FakeTool::install(&repository, "exec sleep 30");
        let registry = ProcessAttributionRegistry::new();
        let launcher = DiffToolLauncher::new(registry.clone());

        launcher
            .open(&repository.open(file("tracked.txt", None), ReviewDiffToolScope::WorkingTree))
            .await
            .expect("opened");
        assert_eq!(launcher.running(), 1);
        assert_eq!(tool.take_calls(), "tracked.txt\nbefore\n--\nafter\n==\n");
        let ownership = registry.freeze_and_snapshot_ownership();
        assert!(ownership.roots.is_empty(), "{ownership:?}");
        assert_eq!(ownership.survivors.len(), 1, "{ownership:?}");

        // Ended from outside, as a crash would end it: the reaper reports the signal.
        tool.kill_all();
        wait_until("the reaper saw the exit", || launcher.running() == 0).await;
        let findings = exits.take();
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert!(
            findings[0].contains(&DIFFTOOL_LABEL.to_owned()),
            "{findings:?}"
        );
        assert!(registry.registered_sources().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_launch_dropped_in_its_window_keeps_its_slot_until_the_tool_exits() {
        let exits = exits::CapturedExits::start();
        let repository = Repository::new();
        repository.write("tracked.txt", "after\n");
        let tool = FakeTool::install(&repository, "exec sleep 30");
        let registry = ProcessAttributionRegistry::new();
        // A window long enough that a slow start never ends it before the tool runs.
        let launcher =
            DiffToolLauncher::with_launch_window(registry.clone(), Duration::from_secs(60));
        let input = repository.open(file("tracked.txt", None), ReviewDiffToolScope::WorkingTree);

        // The client goes away while the launch waits to see the tool fail.
        tokio::select! {
            result = launcher.open(&input) => panic!("the launch window ended first: {result:?}"),
            () = wait_until("the tool started", || !tool.pgids().is_empty()) => {}
        }
        assert_eq!(launcher.running(), 1, "the running tool keeps its slot");
        assert_eq!(registry.registered_sources().len(), 1);

        tool.kill_all();
        wait_until("the reaper saw the exit", || launcher.running() == 0).await;
        let findings = exits.take();
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert!(registry.registered_sources().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failing_tool_reports_gits_message_and_exit_code() {
        let exits = exits::CapturedExits::start();
        let repository = Repository::new();
        repository.write("tracked.txt", "after\n");
        let _tool = FakeTool::install(&repository, "echo 'tool failed' >&2; exit 3");
        let launcher = launcher();

        let (reason_for_file, failure) = reason(
            launcher
                .open(&repository.open(file("tracked.txt", None), ReviewDiffToolScope::WorkingTree))
                .await
                .expect_err("the tool fails"),
        );
        assert_eq!(reason_for_file, ReviewDiffToolFailureReason::LaunchFailed);
        assert!(
            failure.message.contains("tool failed"),
            "{}",
            failure.message
        );
        // Git stops at the file whose external diff failed.
        assert!(
            failure.message.ends_with("(exit 128)"),
            "{}",
            failure.message
        );
        assert_eq!(
            failure.command[..4],
            [
                "git",
                "-C",
                repository.git(&["rev-parse", "--show-toplevel"]).as_str(),
                "difftool"
            ]
        );
        assert!(failure.command.contains(&"--tool=fake".to_owned()));

        let (reason_for_all, failure) = reason(
            launcher
                .open(&repository.open(ReviewDiffToolTarget::All, ReviewDiffToolScope::WorkingTree))
                .await
                .expect_err("the tool fails"),
        );
        assert_eq!(reason_for_all, ReviewDiffToolFailureReason::LaunchFailed);
        // `--dir-diff` passes the tool's own code through.
        assert!(failure.message.ends_with("(exit 3)"), "{}", failure.message);
        assert_eq!(launcher.running(), 0);
        assert!(exits.take().is_empty(), "an exit code is not a crash");
    }

    /// Git prints a patch's paths from the repository's top, also for a project in a
    /// subdirectory of it, and the launch must name the same file.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_project_in_a_subdirectory_opens_the_patchs_repository_path() {
        let repository = Repository::new();
        std::fs::create_dir(repository.path().join("sub")).expect("subdirectory");
        repository.write("sub/inner.txt", "inner before\n");
        repository.git(&["add", "sub/inner.txt"]);
        repository.git(&["commit", "--quiet", "-m", "inner"]);
        repository.write("sub/inner.txt", "inner after\n");
        let tool = FakeTool::install(&repository, "exit 0");
        let mut input = repository.open(
            file("sub/inner.txt", None),
            ReviewDiffToolScope::WorkingTree,
        );
        input.cwd = repository.path().join("sub").to_string_lossy().into_owned();

        launcher().open(&input).await.expect("opened");
        assert_eq!(
            tool.take_calls(),
            "sub/inner.txt\ninner before\n--\ninner after\n==\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn each_scope_hands_the_tool_files_absent_from_the_checkout() {
        let repository = Repository::new();
        repository.write("deleted.txt", "deleted contents\n");
        repository.write("old.txt", "renamed contents\nsecond\nthird\nfourth\n");
        repository.write("base-only.txt", "only in the base\n");
        repository.git(&["add", "."]);
        repository.git(&["commit", "--quiet", "-m", "more"]);
        repository.git(&["switch", "--quiet", "-c", "feature"]);
        repository.git(&["rm", "--quiet", "base-only.txt"]);
        repository.git(&["commit", "--quiet", "-m", "remove base-only"]);
        // Two checkpoints of a file the checkout no longer has.
        let thread = "thread-1";
        for (count, contents) in [(1, "turn one\n"), (2, "turn two\n")] {
            repository.write("turn-only.txt", contents);
            repository.git(&["add", "turn-only.txt"]);
            repository.git(&["commit", "--quiet", "-m", "turn"]);
            repository.git(&[
                "update-ref",
                &super::super::orchestration_effects::checkpoint_ref(thread, count),
                "HEAD",
            ]);
        }
        repository.git(&["reset", "--quiet", "--hard", "HEAD~2"]);
        std::fs::remove_file(repository.path().join("deleted.txt")).expect("delete");
        repository.git(&["mv", "old.txt", "new.txt"]);
        repository.write("new.txt", "renamed contents\nsecond\nthird\nchanged\n");
        let tool = FakeTool::install(&repository, "exit 0");
        let launcher = launcher();
        let open = |target, scope| {
            let launcher = launcher.clone();
            let input = repository.open(target, scope);
            async move { launcher.open(&input).await }
        };

        open(file("deleted.txt", None), ReviewDiffToolScope::WorkingTree)
            .await
            .expect("deleted file");
        assert_eq!(tool.take_calls(), "deleted.txt\ndeleted contents\n--\n==\n");

        open(
            file("new.txt", Some("old.txt")),
            ReviewDiffToolScope::WorkingTree,
        )
        .await
        .expect("renamed file");
        let calls = tool.take_calls();
        assert_eq!(
            calls.matches("==\n").count(),
            1,
            "one pair, not a delete and an add: {calls}"
        );
        assert!(
            calls.ends_with(
                "renamed contents\nsecond\nthird\nfourth\n--\nrenamed contents\nsecond\nthird\nchanged\n==\n"
            ),
            "{calls}"
        );

        open(
            file("base-only.txt", None),
            ReviewDiffToolScope::Branch {
                base_ref: Some("main".to_owned()),
            },
        )
        .await
        .expect("base-only file");
        assert_eq!(
            tool.take_calls(),
            "base-only.txt\nonly in the base\n--\n==\n"
        );

        open(
            file("turn-only.txt", None),
            ReviewDiffToolScope::Turn {
                thread_id: thread.to_owned(),
                from_turn_count: 1,
                to_turn_count: 2,
            },
        )
        .await
        .expect("checkpoint-only file");
        assert_eq!(
            tool.take_calls(),
            "turn-only.txt\nturn one\n--\nturn two\n==\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_launch_past_the_running_cap_is_too_many_open() {
        let repository = Repository::new();
        repository.write("tracked.txt", "after\n");
        let tool = FakeTool::install(&repository, "exec sleep 30");
        let launcher = launcher();
        let input = repository.open(file("tracked.txt", None), ReviewDiffToolScope::WorkingTree);

        let launches = futures_util::future::join_all(
            (0..MAX_RUNNING_DIFF_TOOLS).map(|_| launcher.open(&input)),
        )
        .await;
        for launch in launches {
            launch.expect("opened");
        }
        assert_eq!(launcher.running(), MAX_RUNNING_DIFF_TOOLS);
        let (too_many, failure) = reason(launcher.open(&input).await.expect_err("one too many"));
        assert_eq!(too_many, ReviewDiffToolFailureReason::TooManyOpen);
        assert!(
            failure.message.starts_with("16 diff apps"),
            "{}",
            failure.message
        );
        assert_eq!(tool.pgids().len(), MAX_RUNNING_DIFF_TOOLS);

        // Each slot frees when its app exits.
        tool.kill_all();
        wait_until("every reaper saw its exit", || launcher.running() == 0).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listing_finds_a_custom_tool_and_the_configured_default() {
        let repository = Repository::new();
        let _tool = FakeTool::install(&repository, "exit 0");
        repository.git(&["config", "diff.guitool", "fake"]);
        let list = launcher()
            .list(
                &ReviewListDiffToolsInput {
                    cwd: repository.cwd(),
                },
                &CancellationToken::new(),
            )
            .await
            .expect("tools");
        assert!(
            list.tools
                .contains(&tool("fake", "fake", ReviewDiffToolKind::Custom)),
            "{list:?}"
        );
        assert_eq!(list.default_tool_id.as_deref(), Some("fake"));
        assert_eq!(
            list.default_source,
            Some(ReviewDiffToolDefaultSource::DiffGuiTool)
        );
    }
}
