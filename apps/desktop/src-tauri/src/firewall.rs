//! Windows Defender Firewall integration for grant-driven server exposure.
//!
//! The desktop backend port is picked dynamically, so the inbound allow rule is
//! program-scoped rather than port-scoped. Non-Windows platforms have no managed
//! firewall here and every call is a successful no-op.

#[cfg(windows)]
use bibcode_server::diagnostics::profiler::exits::{self, Exited, Watch};
#[cfg(windows)]
use bibcode_server::process::ProcessRunner;
#[cfg(any(windows, test))]
use bibcode_server::process::{OutputMode, ProcessRunInput};
#[cfg(windows)]
use std::sync::OnceLock;
#[cfg(any(windows, test))]
use std::sync::{Arc, Mutex};
#[cfg(any(windows, test))]
use std::time::Duration;
#[cfg(any(windows, test))]
use tokio::sync::{mpsc, oneshot};

#[cfg(any(windows, test))]
const FIREWALL_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(any(windows, test))]
const FIREWALL_CALLER_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(any(windows, test))]
const FIREWALL_COMMAND_MAX_OUTPUT_BYTES: usize = 64 * 1024;
#[cfg(any(windows, test))]
const FIREWALL_WORKER_WAKE_CAPACITY: usize = 1;

#[cfg_attr(
    all(not(windows), not(test)),
    expect(dead_code, reason = "Windows-only firewall command")
)]
const REMOTE_ACCESS_RULE_NAME: &str = "BiBCode Remote Access";

#[must_use]
#[cfg_attr(
    all(not(windows), not(test)),
    expect(dead_code, reason = "Windows-only firewall command")
)]
pub(crate) fn remote_access_rule_add_args(program: &str) -> Vec<String> {
    vec![
        "advfirewall".to_owned(),
        "firewall".to_owned(),
        "add".to_owned(),
        "rule".to_owned(),
        format!("name={REMOTE_ACCESS_RULE_NAME}"),
        "dir=in".to_owned(),
        "action=allow".to_owned(),
        format!("program={program}"),
        "protocol=TCP".to_owned(),
        "profile=domain,private".to_owned(),
        "enable=yes".to_owned(),
    ]
}

#[cfg_attr(
    all(not(windows), not(test)),
    expect(dead_code, reason = "Windows-only firewall command")
)]
const FIREWALL_RULE_ABSENT_MARKER: &str = "No rules match the specified criteria.";

#[must_use]
#[cfg_attr(
    all(not(windows), not(test)),
    expect(dead_code, reason = "Windows-only firewall command")
)]
pub(crate) fn remote_access_rule_show_args() -> Vec<String> {
    vec![
        "advfirewall".to_owned(),
        "firewall".to_owned(),
        "show".to_owned(),
        "rule".to_owned(),
        format!("name={REMOTE_ACCESS_RULE_NAME}"),
        "verbose".to_owned(),
    ]
}

#[must_use]
#[cfg_attr(
    all(not(windows), not(test)),
    expect(dead_code, reason = "Windows-only firewall command")
)]
pub(crate) fn remote_access_rule_delete_args() -> Vec<String> {
    vec![
        "advfirewall".to_owned(),
        "firewall".to_owned(),
        "delete".to_owned(),
        "rule".to_owned(),
        format!("name={REMOTE_ACCESS_RULE_NAME}"),
    ]
}

/// Locale-independent read of the firewall policy. Exit status alone is the
/// signal: the profile text is translated, and a successful exit means the
/// store was read.
#[must_use]
#[cfg_attr(
    all(not(windows), not(test)),
    expect(dead_code, reason = "Windows-only firewall command")
)]
pub(crate) fn remote_access_store_probe_args() -> Vec<String> {
    vec![
        "advfirewall".to_owned(),
        "show".to_owned(),
        "allprofiles".to_owned(),
        "state".to_owned(),
    ]
}

/// Reads the stored form of the rule. Its fields are fixed tokens (`Active=TRUE`), unlike
/// the localized netsh listing, and standard users can read the key.
#[must_use]
#[cfg_attr(
    all(not(windows), not(test)),
    expect(dead_code, reason = "Windows-only firewall command")
)]
pub(crate) fn remote_access_rule_store_args() -> Vec<String> {
    vec![
        "query".to_owned(),
        r"HKLM\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules"
            .to_owned(),
        "/f".to_owned(),
        format!("Name={REMOTE_ACCESS_RULE_NAME}|"),
        "/d".to_owned(),
    ]
}

/// The reason token narrowing reports when Windows refused to delete the rule for lack of
/// administrator permission. Recovery tolerates it: the listener is verified loopback-only
/// on its own, and the rule is scoped to this program.
pub(crate) const FIREWALL_RULE_LEFT_TOKEN: &str = "firewall-rule-left";

/// Why a firewall change failed. Only the token leaves this module: netsh output is
/// localized and can name paths.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FirewallFailure {
    /// Adding or replacing the rule needs administrator permission this process lacks,
    /// or the person declined, dismissed or let the Windows prompt time out.
    ElevationRequired,
    /// Narrowing could not delete the rule for lack of administrator permission.
    RuleLeft,
    ReadFailed,
    RemoveFailed,
    AddFailed,
    TimedOut,
    Unavailable,
    /// An earlier Windows prompt is still on screen; no second one is raised.
    PromptOpen,
    /// The person approved removing a rule for another program path but not adding the
    /// new one: the old rule is gone and none was added.
    RuleRemovedNotAdded,
}

#[cfg(any(windows, test))]
impl FirewallFailure {
    pub(crate) const fn token(self) -> &'static str {
        match self {
            Self::PromptOpen => "firewall-prompt-open",
            Self::RuleRemovedNotAdded => "firewall-rule-removed-not-added",
            Self::ElevationRequired => "firewall-elevation-required",
            Self::RuleLeft => FIREWALL_RULE_LEFT_TOKEN,
            Self::ReadFailed => "firewall-read-failed",
            Self::RemoveFailed => "firewall-remove-failed",
            Self::AddFailed => "firewall-add-failed",
            Self::TimedOut => "firewall-timed-out",
            Self::Unavailable => "firewall-unavailable",
        }
    }
}

/// How long the person has to answer the Windows elevation prompt. The 5-second caller
/// deadline still covers every non-interactive command around it.
#[cfg(any(windows, test))]
const ELEVATION_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Mandatory-label SIDs in `whoami /groups`. SIDs are not localized, unlike netsh text.
#[cfg(any(windows, test))]
const UNELEVATED_INTEGRITY_SIDS: [&str; 3] = ["S-1-16-4096", "S-1-16-8192", "S-1-16-8448"];
#[cfg(any(windows, test))]
const ELEVATED_INTEGRITY_SIDS: [&str; 2] = ["S-1-16-12288", "S-1-16-16384"];

/// The only programs this module starts. Each runs from the system directory Windows
/// reports, never from `PATH` or an environment variable.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FirewallProgram {
    Netsh,
    Whoami,
    Reg,
}

#[cfg(any(windows, test))]
impl FirewallProgram {
    const fn name(self) -> &'static str {
        match self {
            Self::Netsh => "netsh",
            Self::Whoami => "whoami",
            Self::Reg => "reg",
        }
    }
}

#[cfg(any(windows, test))]
fn system_program_path(
    system_directory: &std::path::Path,
    program: FirewallProgram,
) -> std::path::PathBuf {
    system_directory.join(format!("{}.exe", program.name()))
}

/// The system directory from `GetSystemDirectoryW`.
#[cfg(windows)]
fn system_directory() -> Result<std::path::PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = vec![0u16; 1024];
    // SAFETY: the buffer holds `buffer.len()` UTF-16 units.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("could not resolve the Windows system directory".to_owned());
    }
    buffer.truncate(length);
    Ok(std::path::PathBuf::from(std::ffi::OsString::from_wide(
        &buffer,
    )))
}

/// Joins arguments by the Windows command-line rules (`CommandLineToArgvW`) that netsh
/// parses: an argument with a space or tab, or an empty one, is wrapped in double quotes,
/// with the backslashes before the closing quote doubled. Nothing else is special, so
/// quotes of any other kind, `$`, `` ` ``, `&`, `%` and non-ASCII letters pass through
/// as data. A double quote or NUL cannot occur in a Windows path and is refused.
#[cfg(any(windows, test))]
fn windows_command_line(args: &[String]) -> Result<String, FirewallFailure> {
    let mut line = String::new();
    for arg in args {
        if arg.contains(['"', '\0']) {
            return Err(FirewallFailure::Unavailable);
        }
        if !line.is_empty() {
            line.push(' ');
        }
        if !arg.is_empty() && !arg.contains([' ', '\t']) {
            line.push_str(arg);
            continue;
        }
        let trailing = arg.len() - arg.trim_end_matches('\\').len();
        line.push('"');
        line.push_str(arg);
        line.push_str(&"\\".repeat(trailing));
        line.push('"');
    }
    Ok(line)
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct FirewallCommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

/// How an elevated netsh run ended, as far as this process can tell. Whether the rule
/// exists afterwards is read separately and decides success.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ElevatedRun {
    /// Approved; netsh ran and exited with this code.
    Exited(u32),
    /// Declined, dismissed, timed out, or Windows could not show the prompt.
    Refused,
}

#[cfg(any(windows, test))]
trait FirewallCommandRunner: Sync {
    fn run(
        &self,
        program: FirewallProgram,
        args: Vec<String>,
    ) -> impl std::future::Future<Output = Result<FirewallCommandOutput, String>> + Send;

    /// Runs the system netsh with `args` elevated, behind one Windows prompt. `prompt` must
    /// live until the prompt is really gone, which can be after this future returns.
    fn run_elevated(
        &self,
        netsh_args: Vec<String>,
        prompt: PromptGuard,
    ) -> impl std::future::Future<Output = ElevatedRun> + Send;
}

/// Marks a Windows prompt as open until dropped, so no second one is raised meanwhile.
#[cfg(any(windows, test))]
struct PromptGuard(Arc<Mutex<FirewallWorkerState>>);

#[cfg(any(windows, test))]
impl PromptGuard {
    fn open(state: &Arc<Mutex<FirewallWorkerState>>) -> Result<Self, FirewallFailure> {
        let mut locked = state.lock().expect("firewall worker state");
        if locked.prompt_open {
            return Err(FirewallFailure::PromptOpen);
        }
        locked.prompt_open = true;
        Ok(Self(Arc::clone(state)))
    }
}

#[cfg(any(windows, test))]
impl Drop for PromptGuard {
    fn drop(&mut self) {
        self.0.lock().expect("firewall worker state").prompt_open = false;
    }
}

#[cfg(windows)]
struct ProcessFirewallCommandRunner;

#[cfg(any(windows, test))]
struct FirewallJob {
    enabled: bool,
    allow_prompt: bool,
    program: Option<String>,
    deadline: tokio::time::Instant,
    completion: oneshot::Sender<Result<(), FirewallFailure>>,
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct FirewallWorkerState {
    pending: Option<FirewallJob>,
    prompt_open: bool,
    /// How the rule this process added or accepted read back. A rule is ours when its listing
    /// names this program or reads exactly as observed then, even if the listing does not
    /// echo a non-ASCII path byte for byte; a rule replaced for another program reads
    /// differently and is not ours. Both checks of a widen use this one rule.
    own_rule: Option<u64>,
}

#[cfg(any(windows, test))]
#[derive(Clone)]
struct FirewallWorker {
    state: Arc<Mutex<FirewallWorkerState>>,
    wake: mpsc::Sender<()>,
}

#[cfg(any(windows, test))]
impl FirewallWorker {
    fn start<Runner>(runner: Runner) -> Self
    where
        Runner: FirewallCommandRunner + Send + 'static,
    {
        let state = Arc::new(Mutex::new(FirewallWorkerState::default()));
        let (wake, receiver) = mpsc::channel(FIREWALL_WORKER_WAKE_CAPACITY);
        tokio::spawn(run_firewall_worker(runner, Arc::clone(&state), receiver));
        Self { state, wake }
    }

    /// `allow_prompt` lets an enable that Windows refuses for lack of administrator
    /// permission ask through the elevation prompt; the caller then also waits for it.
    async fn sync(
        &self,
        enabled: bool,
        allow_prompt: bool,
        program: Option<String>,
        caller_timeout: Duration,
    ) -> Result<(), FirewallFailure> {
        let deadline = tokio::time::Instant::now() + caller_timeout;
        let wait_until = if allow_prompt {
            // Up to two prompts when a rule for another path is replaced.
            deadline + 2 * (ELEVATION_PROMPT_TIMEOUT + caller_timeout)
        } else {
            deadline
        };
        let (completion, receiver) = oneshot::channel();
        let (superseded, worker_unavailable) = {
            let mut state = self.state.lock().expect("firewall worker state");
            let superseded = state.pending.replace(FirewallJob {
                enabled,
                allow_prompt,
                program,
                deadline,
                completion,
            });
            let worker_unavailable = match self.wake.try_send(()) {
                Ok(()) | Err(mpsc::error::TrySendError::Full(())) => false,
                Err(mpsc::error::TrySendError::Closed(())) => {
                    state.pending.take();
                    true
                }
            };
            (superseded, worker_unavailable)
        };
        if let Some(job) = superseded {
            let _ = job.completion.send(Err(FirewallFailure::Unavailable));
        }
        if worker_unavailable {
            return Err(FirewallFailure::Unavailable);
        }

        match tokio::time::timeout_at(wait_until, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(FirewallFailure::Unavailable),
            Err(_) => Err(FirewallFailure::TimedOut),
        }
    }
}

#[cfg(any(windows, test))]
async fn run_firewall_worker<Runner>(
    runner: Runner,
    state: Arc<Mutex<FirewallWorkerState>>,
    mut wake: mpsc::Receiver<()>,
) where
    Runner: FirewallCommandRunner + Send + 'static,
{
    while wake.recv().await.is_some() {
        loop {
            let job = { state.lock().expect("firewall worker state").pending.take() };
            let Some(job) = job else {
                break;
            };
            let mut deadline = job.deadline;
            let already_late = tokio::time::Instant::now() >= deadline;
            let own_rule = state.lock().expect("firewall worker state").own_rule;
            let enabled = job.enabled && !already_late;
            let mut result = if already_late {
                sync_rule(false, &runner, own_rule, || {
                    Err("expired firewall job must not add a rule".to_owned())
                })
                .await
            } else {
                let program = job.program.clone();
                sync_rule(job.enabled, &runner, own_rule, move || {
                    program.ok_or_else(|| "desktop executable was not provided".to_owned())
                })
                .await
            };

            if job.enabled
                && job.allow_prompt
                && result == Err(FirewallFailure::ElevationRequired)
                && tokio::time::Instant::now() < deadline
                && let Some(program) = job.program.as_deref()
            {
                // The wait for a person gets its own budget; the non-interactive steps
                // before it were held to the caller deadline.
                deadline = tokio::time::Instant::now()
                    + 2 * (ELEVATION_PROMPT_TIMEOUT + FIREWALL_CALLER_TIMEOUT);
                result = elevate_remote_access_rule(&runner, &state, program).await;
            }
            if let Ok(observed) = result {
                // An enable leaves this program's rule in place; a disable leaves none.
                state.lock().expect("firewall worker state").own_rule =
                    if enabled { observed } else { None };
            }
            let mut result = result.map(|_| ());

            let completed_late = already_late || tokio::time::Instant::now() >= deadline;
            if job.enabled && !already_late && completed_late {
                let own_rule = state.lock().expect("firewall worker state").own_rule;
                let cleanup = sync_rule(false, &runner, own_rule, || {
                    Err("firewall cleanup must not add a rule".to_owned())
                })
                .await;
                if cleanup.is_ok() {
                    state.lock().expect("firewall worker state").own_rule = None;
                }
                if let Err(cleanup) = cleanup {
                    tracing::warn!(
                        reason = cleanup.token(),
                        "late remote-access firewall enable could not be undone"
                    );
                }
                result = Err(FirewallFailure::TimedOut);
            } else if completed_late && result.is_ok() {
                result = Err(FirewallFailure::TimedOut);
            }

            if job.completion.send(result).is_err() {
                tracing::warn!(
                    result = ?result,
                    "firewall worker completed an operation after its caller stopped waiting"
                );
            }
        }
    }
}

#[cfg(any(windows, test))]
fn firewall_process_input(executable: String, args: Vec<String>) -> ProcessRunInput {
    ProcessRunInput::new(executable, args)
        .with_timeout(FIREWALL_COMMAND_TIMEOUT)
        .with_max_output_bytes(FIREWALL_COMMAND_MAX_OUTPUT_BYTES)
        .with_output_mode(OutputMode::Truncate)
}

/// How a `ShellExecuteExW` run ended.
#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShellRun {
    Exited(u32),
    /// The person declined or dismissed the prompt (`ERROR_CANCELLED`).
    Cancelled,
    TimedOut,
}

/// Starts `file` with `parameters` through the shell and waits for it. With the `runas`
/// verb Windows shows its elevation prompt and this call blocks until the person answers.
/// The waiting thread owns and closes every handle; a caller that stops waiting leaves
/// it to finish on its own, because Windows offers no way to withdraw a shown prompt.
#[cfg(windows)]
fn shell_execute_and_wait(
    verb: &str,
    file: &std::path::Path,
    parameters: &str,
    timeout: Duration,
) -> Result<ShellRun, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::ExitStatusExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_CANCELLED, GetLastError, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessId, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::Shell::{
        SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
    };

    let wide = |value: &std::ffi::OsStr| value.encode_wide().chain([0]).collect::<Vec<u16>>();
    let verb = wide(std::ffi::OsStr::new(verb));
    let file_wide = wide(file.as_os_str());
    let parameters = wide(std::ffi::OsStr::new(parameters));
    let started = std::time::Instant::now();
    // SAFETY: an all-zero SHELLEXECUTEINFOW is valid; the strings outlive the call.
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file_wide.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = 0; // SW_HIDE: netsh needs no console window.
    // SAFETY: `info` is fully initialized for ShellExecuteExW.
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        // SAFETY: reads this thread's last error right after the failed call.
        let error = unsafe { GetLastError() };
        if error == ERROR_CANCELLED {
            return Ok(ShellRun::Cancelled);
        }
        return Err(format!("ShellExecuteExW failed with error {error}"));
    }
    let process = info.hProcess;
    if process.is_null() {
        return Err("ShellExecuteExW returned no process".to_owned());
    }
    let remaining = timeout.saturating_sub(started.elapsed());
    let wait_ms = u32::try_from(remaining.as_millis()).unwrap_or(u32::MAX - 1);
    // SAFETY: `process` is the live handle ShellExecuteExW returned; closed below.
    let (pid, code) = unsafe {
        let pid = GetProcessId(process);
        let code = if WaitForSingleObject(process, wait_ms) == WAIT_OBJECT_0 {
            let mut code = 0u32;
            (GetExitCodeProcess(process, &mut code) != 0).then_some(code)
        } else {
            None
        };
        CloseHandle(process);
        (pid, code)
    };
    let Some(code) = code else {
        return Ok(ShellRun::TimedOut);
    };
    let exe = file.to_string_lossy();
    exits::report_exit(
        Watch::Signals,
        &Exited {
            kind: "command",
            label: "netsh",
            exe: &exe,
            pid,
            started,
        },
        &std::process::ExitStatus::from_raw(code),
        false,
    );
    Ok(ShellRun::Exited(code))
}

#[cfg(windows)]
impl FirewallCommandRunner for ProcessFirewallCommandRunner {
    async fn run(
        &self,
        program: FirewallProgram,
        args: Vec<String>,
    ) -> Result<FirewallCommandOutput, String> {
        let executable = system_program_path(&system_directory()?, program)
            .to_string_lossy()
            .into_owned();
        let output = ProcessRunner
            .run(firewall_process_input(executable, args))
            .await
            .map_err(|error| format!("failed to run {}: {error}", program.name()))?;
        Ok(FirewallCommandOutput {
            success: output.code == Some(0),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }

    async fn run_elevated(&self, netsh_args: Vec<String>, prompt: PromptGuard) -> ElevatedRun {
        let Ok(parameters) = windows_command_line(&netsh_args) else {
            return ElevatedRun::Refused;
        };
        let Ok(system) = system_directory() else {
            return ElevatedRun::Refused;
        };
        let netsh = system_program_path(&system, FirewallProgram::Netsh);
        let waiting = tokio::task::spawn_blocking(move || {
            // Held until ShellExecuteExW returns, after the caller may have stopped waiting.
            let _prompt = prompt;
            shell_execute_and_wait("runas", &netsh, &parameters, ELEVATION_PROMPT_TIMEOUT)
        });
        match tokio::time::timeout(ELEVATION_PROMPT_TIMEOUT + FIREWALL_CALLER_TIMEOUT, waiting)
            .await
        {
            Ok(Ok(Ok(ShellRun::Exited(code)))) => ElevatedRun::Exited(code),
            Ok(Ok(Ok(ShellRun::Cancelled | ShellRun::TimedOut))) => ElevatedRun::Refused,
            Ok(Ok(Err(error))) => {
                tracing::warn!(%error, "the elevated firewall change could not start");
                ElevatedRun::Refused
            }
            Ok(Err(_)) | Err(_) => ElevatedRun::Refused,
        }
    }
}

#[cfg(any(windows, test))]
fn firewall_command_text(output: &FirewallCommandOutput) -> String {
    format!("{}\n{}", output.stdout, output.stderr)
}

/// `Ok(true)` when the named rule is confirmed absent. A query that neither
/// reports absence nor succeeds is an error, so a missing rule is accepted
/// only after the store was actually read.
#[cfg(any(windows, test))]
fn rule_listing_is_absent(output: &FirewallCommandOutput) -> Result<bool, FirewallFailure> {
    let text = firewall_command_text(output);
    if text.contains(FIREWALL_RULE_ABSENT_MARKER) {
        return Ok(true);
    }
    if !output.success {
        return Err(FirewallFailure::ReadFailed);
    }
    Ok(!text.contains(REMOTE_ACCESS_RULE_NAME))
}

/// A failed named query that does not include the English miss sentence.
/// Localized Windows translates that sentence, so the exit status alone cannot
/// separate "no rule" from "the policy could not be read" until the store
/// probe succeeds.
#[cfg(any(windows, test))]
fn listing_needs_store_probe(output: &FirewallCommandOutput) -> bool {
    if output.success {
        return false;
    }
    let text = firewall_command_text(output);
    !text.contains(FIREWALL_RULE_ABSENT_MARKER) && !text.contains(REMOTE_ACCESS_RULE_NAME)
}

#[cfg(any(windows, test))]
async fn confirm_rule_listing_is_absent<Runner>(
    runner: &Runner,
    output: &FirewallCommandOutput,
) -> Result<bool, FirewallFailure>
where
    Runner: FirewallCommandRunner,
{
    if !listing_needs_store_probe(output) {
        return rule_listing_is_absent(output);
    }
    let probe = runner
        .run(FirewallProgram::Netsh, remote_access_store_probe_args())
        .await
        .map_err(|_| FirewallFailure::ReadFailed)?;
    if probe.success {
        return Ok(true);
    }
    rule_listing_is_absent(output)
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuleListing {
    Absent,
    /// Present; `for_program` when the verbose listing names this program's path.
    Present {
        for_program: bool,
        /// A hash of the listing, so a later read can tell whether it is the same rule.
        observed: u64,
    },
}

#[cfg(any(windows, test))]
async fn read_remote_access_rule<Runner>(
    runner: &Runner,
    program: Option<&str>,
) -> Result<RuleListing, FirewallFailure>
where
    Runner: FirewallCommandRunner,
{
    let listing = runner
        .run(FirewallProgram::Netsh, remote_access_rule_show_args())
        .await
        .map_err(|_| FirewallFailure::ReadFailed)?;
    if confirm_rule_listing_is_absent(runner, &listing).await? {
        return Ok(RuleListing::Absent);
    }
    // The path is compared as text; only its field label is localized.
    let text = firewall_command_text(&listing).to_lowercase();
    let observed = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut hasher);
        hasher.finish()
    };
    Ok(RuleListing::Present {
        for_program: program.is_some_and(|program| text.contains(&program.to_lowercase())),
        observed,
    })
}

/// Whether a stored rule lets `program` receive connections: enabled, allowing, inbound and
/// for this path. A rule that was disabled or turned into a block still names the program
/// in the listing. When the store cannot be read the listing's word is taken, as before.
#[cfg(any(windows, test))]
async fn stored_rule_admits<Runner>(runner: &Runner, program: &str) -> bool
where
    Runner: FirewallCommandRunner,
{
    let stored = match runner
        .run(FirewallProgram::Reg, remote_access_rule_store_args())
        .await
    {
        Ok(output) if output.success => output.stdout.to_lowercase(),
        _ => {
            tracing::warn!(
                class = "firewall-store-unreadable",
                "firewall rule store not read"
            );
            return true;
        }
    };
    let name = format!("|name={}|", REMOTE_ACCESS_RULE_NAME.to_lowercase());
    let app = format!("|app={}|", program.to_lowercase());
    stored.lines().any(|line| {
        [
            name.as_str(),
            app.as_str(),
            "|action=allow|",
            "|active=true|",
            "|dir=in|",
        ]
        .iter()
        .all(|field| line.contains(field))
    })
}

/// True only on positive evidence that this process runs without elevation, so an elevated
/// desktop whose change failed is never sent round a Retry that cannot help.
#[cfg(any(windows, test))]
async fn runs_unelevated<Runner>(runner: &Runner) -> bool
where
    Runner: FirewallCommandRunner,
{
    match runner
        .run(FirewallProgram::Whoami, vec!["/groups".to_owned()])
        .await
    {
        Ok(output) if output.success => {
            !ELEVATED_INTEGRITY_SIDS
                .iter()
                .any(|sid| output.stdout.contains(sid))
                && UNELEVATED_INTEGRITY_SIDS
                    .iter()
                    .any(|sid| output.stdout.contains(sid))
        }
        _ => false,
    }
}

#[cfg(test)]
async fn sync_remote_access_rule_with_runner<Runner, ResolveProgram>(
    enabled: bool,
    runner: &Runner,
    resolve_program: ResolveProgram,
) -> Result<(), FirewallFailure>
where
    Runner: FirewallCommandRunner,
    ResolveProgram: FnOnce() -> Result<String, String>,
{
    sync_rule(enabled, runner, None, resolve_program)
        .await
        .map(|_| ())
}

/// `own_rule` is how this process's rule read back (see [`FirewallWorkerState`]). Returns
/// how a kept rule reads, or `None` when none was kept or the rule was added unread.
#[cfg(any(windows, test))]
async fn sync_rule<Runner, ResolveProgram>(
    enabled: bool,
    runner: &Runner,
    own_rule: Option<u64>,
    resolve_program: ResolveProgram,
) -> Result<Option<u64>, FirewallFailure>
where
    Runner: FirewallCommandRunner,
    ResolveProgram: FnOnce() -> Result<String, String>,
{
    let program = if enabled {
        Some(resolve_program().map_err(|_| FirewallFailure::Unavailable)?)
    } else {
        None
    };
    let listing = read_remote_access_rule(runner, program.as_deref()).await?;
    // A rule that already admits this program is kept rather than asked for again.
    if let (
        RuleListing::Present {
            for_program,
            observed,
        },
        Some(program),
    ) = (listing, &program)
        && (own_rule == Some(observed)
            || (for_program && stored_rule_admits(runner, program).await))
    {
        return Ok(Some(observed));
    }
    match listing {
        RuleListing::Absent => {}
        RuleListing::Present { .. } => {
            // A spawn failure or timeout is an Err here and stays a failed safeguard.
            let deletion = runner
                .run(FirewallProgram::Netsh, remote_access_rule_delete_args())
                .await
                .map_err(|_| FirewallFailure::RemoveFailed)?;
            let still_present = read_remote_access_rule(runner, None).await? != RuleListing::Absent;
            if !still_present {
                // The rule is gone, whatever the delete reported.
            } else if deletion.success {
                return Err(FirewallFailure::RemoveFailed);
            } else if runs_unelevated(runner).await {
                // The integrity level is reason enough: an unelevated process can never
                // change a firewall rule (the Windows lab refused even a delete of a
                // rule that did not exist for elevation), so this refusal needs elevation
                // whatever text netsh printed.
                return Err(if enabled {
                    FirewallFailure::ElevationRequired
                } else {
                    FirewallFailure::RuleLeft
                });
            } else {
                return Err(FirewallFailure::RemoveFailed);
            }
        }
    }
    let Some(program) = program else {
        return Ok(None);
    };
    let addition = runner
        .run(
            FirewallProgram::Netsh,
            remote_access_rule_add_args(&program),
        )
        .await
        .map_err(|_| FirewallFailure::AddFailed)?;
    if addition.success {
        Ok(None)
    } else if runs_unelevated(runner).await {
        Err(FirewallFailure::ElevationRequired)
    } else {
        Err(FirewallFailure::AddFailed)
    }
}

/// Asks Windows to run netsh elevated: one prompt to add the rule, or two when a rule for
/// another path must be deleted first. Success is read back from the rule store.
#[cfg(any(windows, test))]
async fn elevate_remote_access_rule<Runner>(
    runner: &Runner,
    state: &Arc<Mutex<FirewallWorkerState>>,
    program: &str,
) -> Result<Option<u64>, FirewallFailure>
where
    Runner: FirewallCommandRunner,
{
    let replacing = read_remote_access_rule(runner, Some(program)).await? != RuleListing::Absent;
    if replacing {
        let prompt = PromptGuard::open(state)?;
        match runner
            .run_elevated(remote_access_rule_delete_args(), prompt)
            .await
        {
            ElevatedRun::Refused => return Err(FirewallFailure::ElevationRequired),
            ElevatedRun::Exited(0) => {}
            ElevatedRun::Exited(_) => return Err(FirewallFailure::RemoveFailed),
        }
        if read_remote_access_rule(runner, None).await? != RuleListing::Absent {
            return Err(FirewallFailure::RemoveFailed);
        }
    }
    // A prompt still on screen from the delete keeps this one from opening.
    let prompt = match PromptGuard::open(state) {
        Err(_) if replacing => return Err(FirewallFailure::RuleRemovedNotAdded),
        prompt => prompt?,
    };
    let run = runner
        .run_elevated(remote_access_rule_add_args(program), prompt)
        .await;
    // The rule was absent before this add, so any rule now is the one it added, even if
    // the listing does not echo a non-ASCII path byte for byte.
    match (read_remote_access_rule(runner, Some(program)).await?, run) {
        (RuleListing::Present { observed, .. }, ElevatedRun::Exited(_)) => Ok(Some(observed)),
        (
            RuleListing::Present {
                for_program: true,
                observed,
            },
            ElevatedRun::Refused,
        ) => Ok(Some(observed)),
        // The old rule named another program path, so it is stale and not restored.
        (_, ElevatedRun::Refused) if replacing => Err(FirewallFailure::RuleRemovedNotAdded),
        (_, ElevatedRun::Refused) => Err(FirewallFailure::ElevationRequired),
        (RuleListing::Absent, ElevatedRun::Exited(_)) => Err(FirewallFailure::AddFailed),
    }
}

/// `allow_prompt` is true only for the widen step a person started in the Share this host
/// dialog, which runs before and outside the exposure lock; recovery and automatic
/// narrowing never raise the Windows prompt.
#[cfg(windows)]
pub(crate) async fn sync_remote_access_rule(
    enabled: bool,
    allow_prompt: bool,
) -> Result<(), String> {
    static WORKER: OnceLock<FirewallWorker> = OnceLock::new();

    let program = enabled
        .then(|| {
            std::env::current_exe()
                .map_err(|_| FirewallFailure::Unavailable.token().to_owned())
                .map(|path| path.to_string_lossy().into_owned())
        })
        .transpose()?;
    WORKER
        .get_or_init(|| FirewallWorker::start(ProcessFirewallCommandRunner))
        .sync(enabled, allow_prompt, program, FIREWALL_CALLER_TIMEOUT)
        .await
        .map_err(|failure| {
            tracing::warn!(
                reason = failure.token(),
                enabled,
                "remote-access firewall change failed"
            );
            failure.token().to_owned()
        })
}

#[cfg(not(windows))]
pub(crate) async fn sync_remote_access_rule(
    _enabled: bool,
    _allow_prompt: bool,
) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };
    use tokio::sync::Semaphore;

    type FirewallCall = (String, Vec<String>);

    #[derive(Clone, Default)]
    struct FakeFirewallCommandRunner {
        calls: Arc<Mutex<Vec<FirewallCall>>>,
        results: Arc<Mutex<VecDeque<Result<FirewallCommandOutput, String>>>>,
        elevated: Arc<Mutex<Vec<Vec<String>>>>,
        elevated_outcomes: Arc<Mutex<VecDeque<ElevatedRun>>>,
        hold_prompts: Arc<AtomicBool>,
        held_prompts: Arc<Mutex<Vec<PromptGuard>>>,
    }

    impl FakeFirewallCommandRunner {
        fn with_results(results: Vec<Result<FirewallCommandOutput, String>>) -> Self {
            Self {
                results: Arc::new(Mutex::new(results.into())),
                ..Self::default()
            }
        }

        /// Every elevated run (at most two) ends with `outcome`.
        fn with_elevation(
            results: Vec<Result<FirewallCommandOutput, String>>,
            outcome: ElevatedRun,
        ) -> Self {
            Self::with_elevations(results, vec![outcome, outcome])
        }

        fn with_elevations(
            results: Vec<Result<FirewallCommandOutput, String>>,
            outcomes: Vec<ElevatedRun>,
        ) -> Self {
            let runner = Self::with_results(results);
            *runner.elevated_outcomes.lock().expect("elevated outcomes") = outcomes.into();
            runner
        }

        fn release_held_prompts(&self) {
            self.held_prompts.lock().expect("held prompts").clear();
        }

        fn calls(&self) -> Vec<FirewallCall> {
            self.calls.lock().expect("firewall calls").clone()
        }

        fn elevated(&self) -> Vec<Vec<String>> {
            self.elevated.lock().expect("elevated calls").clone()
        }
    }

    impl FirewallCommandRunner for FakeFirewallCommandRunner {
        fn run(
            &self,
            program: FirewallProgram,
            args: Vec<String>,
        ) -> impl std::future::Future<Output = Result<FirewallCommandOutput, String>> + Send
        {
            self.calls
                .lock()
                .expect("firewall calls")
                .push((program.name().to_owned(), args));
            let result = self
                .results
                .lock()
                .expect("firewall results")
                .pop_front()
                .expect("configured firewall result");
            async move { result }
        }

        fn run_elevated(
            &self,
            netsh_args: Vec<String>,
            prompt: PromptGuard,
        ) -> impl std::future::Future<Output = ElevatedRun> + Send {
            self.elevated
                .lock()
                .expect("elevated calls")
                .push(netsh_args);
            let outcome = self
                .elevated_outcomes
                .lock()
                .expect("elevated outcomes")
                .pop_front()
                .expect("an elevated run was not expected");
            if self.hold_prompts.load(Ordering::SeqCst) {
                // Models a ShellExecuteExW call still blocked after its caller gave up.
                self.held_prompts.lock().expect("held prompts").push(prompt);
            }
            async move { outcome }
        }
    }

    const PROGRAM: &str = r"C:\Program Files\BiBCode\bibcode-desktop.exe";

    /// The netsh refusal recorded in the Windows 11 lab (en-US, UAC on, not elevated).
    fn elevation_refusal() -> FirewallCommandOutput {
        FirewallCommandOutput {
            success: false,
            stdout: "The requested operation requires elevation (Run as administrator).\r\n"
                .to_owned(),
            stderr: String::new(),
        }
    }

    fn whoami(integrity_sid: &str) -> FirewallCommandOutput {
        FirewallCommandOutput {
            success: true,
            stdout: format!(
                "\"Mandatory Label\\Medium Mandatory Level\",\"Label\",\"{integrity_sid}\",\"\"\r\n"
            ),
            stderr: String::new(),
        }
    }

    fn absent() -> FirewallCommandOutput {
        FirewallCommandOutput {
            success: false,
            stdout: super::FIREWALL_RULE_ABSENT_MARKER.to_owned(),
            stderr: String::new(),
        }
    }

    fn listed(program: &str) -> FirewallCommandOutput {
        FirewallCommandOutput {
            success: true,
            stdout: format!("Rule Name: BiBCode Remote Access\r\nProgram: {program}\r\n"),
            stderr: String::new(),
        }
    }

    /// A stored rule as `reg query` printed it in the Windows 11 lab.
    fn stored(fields: &str, program: &str) -> FirewallCommandOutput {
        FirewallCommandOutput {
            success: true,
            stdout: format!(
                "    {{250E3705-6B03-4619-9C93-2C5D06C5115A}}    REG_SZ    v2.33|{fields}|Profile=Domain|Profile=Private|App={program}|Name=BiBCode Remote Access|\r\n"
            ),
            stderr: String::new(),
        }
    }

    const ADMITTING: &str = "Action=Allow|Active=TRUE|Dir=In";

    fn success() -> FirewallCommandOutput {
        FirewallCommandOutput {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
        }
    }

    fn failure(stderr: &str) -> FirewallCommandOutput {
        FirewallCommandOutput {
            success: false,
            stdout: String::new(),
            stderr: stderr.to_owned(),
        }
    }

    #[test]
    fn add_rule_arguments_are_program_scoped() {
        let args = remote_access_rule_add_args(r"C:\Apps\BiBCode\bibcode-desktop.exe");
        assert_eq!(
            args,
            vec![
                "advfirewall".to_string(),
                "firewall".to_string(),
                "add".to_string(),
                "rule".to_string(),
                "name=BiBCode Remote Access".to_string(),
                "dir=in".to_string(),
                "action=allow".to_string(),
                r"program=C:\Apps\BiBCode\bibcode-desktop.exe".to_string(),
                "protocol=TCP".to_string(),
                "profile=domain,private".to_string(),
                "enable=yes".to_string(),
            ]
        );
    }

    #[test]
    fn firewall_processes_use_one_bounded_supervised_run() {
        let input = firewall_process_input("netsh".to_owned(), vec!["advfirewall".to_owned()]);

        assert_eq!(input.timeout, FIREWALL_COMMAND_TIMEOUT);
        assert_eq!(input.max_output_bytes, FIREWALL_COMMAND_MAX_OUTPUT_BYTES);
        assert_eq!(input.output_mode, OutputMode::Truncate);
        assert_eq!(input.command, "netsh");
        assert_eq!(input.args, ["advfirewall"]);
    }

    #[test]
    fn show_and_delete_arguments_name_the_persistent_rule() {
        assert_eq!(
            remote_access_rule_show_args(),
            vec![
                "advfirewall".to_string(),
                "firewall".to_string(),
                "show".to_string(),
                "rule".to_string(),
                "name=BiBCode Remote Access".to_string(),
                "verbose".to_string(),
            ]
        );
        assert_eq!(
            remote_access_rule_delete_args(),
            vec![
                "advfirewall".to_string(),
                "firewall".to_string(),
                "delete".to_string(),
                "rule".to_string(),
                "name=BiBCode Remote Access".to_string(),
            ]
        );
    }

    #[test]
    fn an_absent_listing_is_accepted_only_when_the_store_was_read() {
        assert!(super::rule_listing_is_absent(&success()).expect("empty success is absent"));
        assert!(
            super::rule_listing_is_absent(&FirewallCommandOutput {
                success: false,
                stdout: super::FIREWALL_RULE_ABSENT_MARKER.to_owned(),
                stderr: String::new(),
            })
            .expect("explicit absence")
        );
        assert!(
            !super::rule_listing_is_absent(&FirewallCommandOutput {
                success: true,
                stdout: "Rule Name: BiBCode Remote Access\n".to_owned(),
                stderr: String::new(),
            })
            .expect("present rule")
        );
        let error = super::rule_listing_is_absent(&failure("Access is denied."))
            .expect_err("query failure");
        assert_eq!(error, FirewallFailure::ReadFailed);
        assert!(super::listing_needs_store_probe(&failure(
            "Aucune règle ne correspond aux critères spécifiés."
        )));
        assert!(!super::listing_needs_store_probe(&FirewallCommandOutput {
            success: false,
            stdout: super::FIREWALL_RULE_ABSENT_MARKER.to_owned(),
            stderr: String::new(),
        }));
    }

    #[tokio::test]
    async fn a_localized_miss_is_absence_only_after_the_policy_store_is_readable() {
        let french_miss = FirewallCommandOutput {
            success: false,
            stdout: "Aucune règle ne correspond aux critères spécifiés.\n".to_owned(),
            stderr: String::new(),
        };
        let runner = FakeFirewallCommandRunner::with_results(vec![
            Ok(french_miss.clone()),
            Ok(FirewallCommandOutput {
                success: true,
                stdout: "Domain Profile Settings:\r\nState ON\r\n".to_owned(),
                stderr: String::new(),
            }),
            Ok(success()),
        ]);

        sync_remote_access_rule_with_runner(true, &runner, || {
            Ok(r"C:\Apps\BiBCode\bibcode-desktop.exe".to_owned())
        })
        .await
        .expect("localized miss still enables remote access");

        let calls = runner.calls();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].1, remote_access_rule_show_args());
        assert_eq!(calls[1].1, remote_access_store_probe_args());
        assert_eq!(
            calls[2].1,
            remote_access_rule_add_args(r"C:\Apps\BiBCode\bibcode-desktop.exe")
        );

        let denied = FakeFirewallCommandRunner::with_results(vec![
            Ok(french_miss),
            Ok(failure("Access is denied.")),
        ]);
        let error = sync_remote_access_rule_with_runner(false, &denied, || {
            panic!("a failed policy read must not resolve the executable")
        })
        .await
        .expect_err("unreadable store must not count as absence");
        assert_eq!(error, FirewallFailure::ReadFailed);
        assert_eq!(denied.calls().len(), 2);
        assert_eq!(denied.calls()[1].1, remote_access_store_probe_args());
    }

    #[tokio::test]
    async fn a_present_rule_is_deleted_and_absence_is_confirmed_before_add() {
        let runner = FakeFirewallCommandRunner::with_results(vec![
            Ok(FirewallCommandOutput {
                success: true,
                stdout: "Rule Name: BiBCode Remote Access\n".to_owned(),
                stderr: String::new(),
            }),
            Ok(success()),
            Ok(FirewallCommandOutput {
                success: false,
                stdout: super::FIREWALL_RULE_ABSENT_MARKER.to_owned(),
                stderr: String::new(),
            }),
            Ok(success()),
        ]);

        sync_remote_access_rule_with_runner(true, &runner, || {
            Ok(r"C:\Apps\BiBCode\bibcode-desktop.exe".to_owned())
        })
        .await
        .expect("replace a present rule");

        let calls = runner.calls();
        assert_eq!(calls.len(), 4);
        assert_eq!(calls[0].1, remote_access_rule_show_args());
        assert_eq!(calls[1].1, remote_access_rule_delete_args());
        assert_eq!(calls[2].1, remote_access_rule_show_args());
        assert_eq!(
            calls[3].1,
            remote_access_rule_add_args(r"C:\Apps\BiBCode\bibcode-desktop.exe")
        );
    }

    #[tokio::test]
    async fn disabling_reports_firewall_process_launch_failure() {
        let runner = FakeFirewallCommandRunner::with_results(vec![Err("launch denied".to_owned())]);

        let error = sync_remote_access_rule_with_runner(false, &runner, || {
            panic!("disabled cleanup must not resolve the executable")
        })
        .await
        .expect_err("spawn failure must be reported");

        assert_eq!(error, FirewallFailure::ReadFailed);
        assert_eq!(runner.calls().len(), 1);
        assert_eq!(runner.calls()[0].0, "netsh");
    }

    #[tokio::test]
    async fn disabling_reports_policy_denial_instead_of_claiming_cleanup() {
        let runner = FakeFirewallCommandRunner::with_results(vec![
            Ok(failure("Access is denied.")),
            Ok(failure("Access is denied.")),
        ]);

        let error = sync_remote_access_rule_with_runner(false, &runner, || {
            panic!("disabled cleanup must not resolve the executable")
        })
        .await
        .expect_err("policy denial must be reported");

        assert_eq!(error, FirewallFailure::ReadFailed);
        assert_eq!(runner.calls().len(), 2);
        assert_eq!(runner.calls()[0].1, remote_access_rule_show_args());
        assert_eq!(runner.calls()[1].1, remote_access_store_probe_args());
    }

    #[tokio::test]
    async fn enabling_verifies_deletion_before_adding_the_program_rule() {
        let runner = FakeFirewallCommandRunner::with_results(vec![Ok(success()), Ok(success())]);

        sync_remote_access_rule_with_runner(true, &runner, || {
            Ok(r"C:\Apps\BiBCode\bibcode-desktop.exe".to_owned())
        })
        .await
        .expect("verified replacement");

        let calls = runner.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].1, remote_access_rule_show_args());
        assert_eq!(calls[1].0, "netsh");
        assert_eq!(
            calls[1].1,
            remote_access_rule_add_args(r"C:\Apps\BiBCode\bibcode-desktop.exe")
        );
    }

    #[tokio::test]
    async fn worker_replaces_idempotent_enables_and_verifies_disable() {
        let runner = FakeFirewallCommandRunner::with_results(vec![
            Ok(success()),
            Ok(success()),
            Ok(success()),
            Ok(success()),
            Ok(success()),
        ]);
        let worker = FirewallWorker::start(runner.clone());
        let program = Some(r"C:\Apps\BiBCode\bibcode-desktop.exe".to_owned());

        worker
            .sync(true, false, program.clone(), FIREWALL_CALLER_TIMEOUT)
            .await
            .expect("first enable");
        worker
            .sync(true, false, program, FIREWALL_CALLER_TIMEOUT)
            .await
            .expect("idempotent replacement");
        worker
            .sync(false, false, None, FIREWALL_CALLER_TIMEOUT)
            .await
            .expect("verified disable");

        assert_eq!(
            runner
                .calls()
                .iter()
                .map(|(executable, _)| executable.as_str())
                .collect::<Vec<_>>(),
            ["netsh", "netsh", "netsh", "netsh", "netsh"]
        );
    }

    #[tokio::test]
    async fn worker_does_not_add_after_failed_delete_verification() {
        let runner = FakeFirewallCommandRunner::with_results(vec![
            Ok(failure("rule is still present")),
            Ok(failure("Access is denied.")),
        ]);
        let worker = FirewallWorker::start(runner.clone());

        let error = worker
            .sync(
                true,
                false,
                Some(r"C:\Apps\BiBCode\bibcode-desktop.exe".to_owned()),
                FIREWALL_CALLER_TIMEOUT,
            )
            .await
            .expect_err("failed deletion must fail closed");

        assert_eq!(error, FirewallFailure::ReadFailed);
        assert_eq!(runner.calls().len(), 2);
        assert_eq!(runner.calls()[0].1, remote_access_rule_show_args());
        assert_eq!(runner.calls()[1].1, remote_access_store_probe_args());
    }

    #[derive(Clone)]
    struct LateSpawnFirewallCommandRunner {
        calls: Arc<Mutex<Vec<FirewallCall>>>,
        block_next_add: Arc<AtomicBool>,
        release_add: Arc<Semaphore>,
    }

    impl Default for LateSpawnFirewallCommandRunner {
        fn default() -> Self {
            Self {
                calls: Arc::default(),
                block_next_add: Arc::default(),
                release_add: Arc::new(Semaphore::new(0)),
            }
        }
    }

    impl LateSpawnFirewallCommandRunner {
        fn block_next_add(&self) {
            self.block_next_add.store(true, Ordering::SeqCst);
        }

        fn calls(&self) -> Vec<FirewallCall> {
            self.calls.lock().expect("firewall calls").clone()
        }

        fn release_add(&self) {
            self.release_add.add_permits(1);
        }
    }

    impl FirewallCommandRunner for LateSpawnFirewallCommandRunner {
        fn run(
            &self,
            program: FirewallProgram,
            args: Vec<String>,
        ) -> impl std::future::Future<Output = Result<FirewallCommandOutput, String>> + Send
        {
            let should_block = args.iter().any(|arg| arg == "add")
                && self.block_next_add.swap(false, Ordering::SeqCst);
            self.calls
                .lock()
                .expect("firewall calls")
                .push((program.name().to_owned(), args));
            let release_add = self.release_add.clone();
            async move {
                if should_block {
                    release_add
                        .acquire()
                        .await
                        .expect("release semaphore")
                        .forget();
                }
                Ok(success())
            }
        }

        async fn run_elevated(
            &self,
            _netsh_args: Vec<String>,
            _prompt: PromptGuard,
        ) -> ElevatedRun {
            panic!("no elevation is expected here")
        }
    }

    async fn wait_for_firewall_calls(runner: &LateSpawnFirewallCommandRunner, expected: usize) {
        for _ in 0..1_000 {
            if runner.calls().len() >= expected {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!(
            "expected at least {expected} firewall calls, got {:?}",
            runner.calls()
        );
    }

    async fn wait_for_pending_firewall_job(worker: &FirewallWorker) {
        for _ in 0..1_000 {
            let has_pending = worker
                .state
                .lock()
                .expect("firewall worker state")
                .pending
                .is_some();
            if has_pending {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("expected a pending firewall job");
    }

    #[tokio::test(start_paused = true)]
    async fn caller_deadline_covers_late_spawn_and_worker_cleans_up_before_later_enable() {
        let runner = LateSpawnFirewallCommandRunner::default();
        runner.block_next_add();
        let worker = FirewallWorker::start(runner.clone());
        let first_worker = worker.clone();
        let first = tokio::spawn(async move {
            first_worker
                .sync(
                    true,
                    false,
                    Some(r"C:\Apps\BiBCode\bibcode-desktop.exe".to_owned()),
                    FIREWALL_CALLER_TIMEOUT,
                )
                .await
        });
        wait_for_firewall_calls(&runner, 2).await;

        tokio::time::advance(FIREWALL_CALLER_TIMEOUT).await;
        let error = first
            .await
            .expect("caller task")
            .expect_err("caller deadline should expire while command spawn is outstanding");
        assert_eq!(error, FirewallFailure::TimedOut);

        let later_worker = worker.clone();
        let later = tokio::spawn(async move {
            later_worker
                .sync(
                    true,
                    false,
                    Some(r"C:\Apps\BiBCode\bibcode-desktop.exe".to_owned()),
                    FIREWALL_CALLER_TIMEOUT,
                )
                .await
        });
        tokio::task::yield_now().await;
        assert_eq!(runner.calls().len(), 2, "later enable must remain queued");

        runner.release_add();
        wait_for_firewall_calls(&runner, 5).await;
        assert_eq!(
            runner
                .calls()
                .iter()
                .map(|(executable, _)| executable.as_str())
                .collect::<Vec<_>>(),
            ["netsh", "netsh", "netsh", "netsh", "netsh"]
        );
        later
            .await
            .expect("later caller task")
            .expect("later enable should succeed after cleanup");
    }

    #[tokio::test]
    async fn worker_coalesces_queued_jobs_to_the_latest_desired_state() {
        let runner = LateSpawnFirewallCommandRunner::default();
        runner.block_next_add();
        let worker = FirewallWorker::start(runner.clone());
        let program = Some(r"C:\Apps\BiBCode\bibcode-desktop.exe".to_owned());

        let active_worker = worker.clone();
        let active_program = program.clone();
        let active = tokio::spawn(async move {
            active_worker
                .sync(true, false, active_program, Duration::from_secs(30))
                .await
        });
        wait_for_firewall_calls(&runner, 2).await;

        let superseded_worker = worker.clone();
        let superseded = tokio::spawn(async move {
            superseded_worker
                .sync(true, false, program, Duration::from_secs(30))
                .await
        });
        wait_for_pending_firewall_job(&worker).await;

        let final_worker = worker.clone();
        let final_job = tokio::spawn(async move {
            final_worker
                .sync(false, false, None, Duration::from_secs(30))
                .await
        });

        let superseded_error = tokio::time::timeout(Duration::from_secs(1), superseded)
            .await
            .expect("a replaced queued caller must be released promptly")
            .expect("superseded caller task")
            .expect_err("the replaced job must report explicit overload");
        assert_eq!(superseded_error, FirewallFailure::Unavailable);

        runner.release_add();
        active
            .await
            .expect("active caller task")
            .expect("active enable");
        final_job
            .await
            .expect("final caller task")
            .expect("final disable");

        assert_eq!(
            runner
                .calls()
                .iter()
                .map(|(executable, _)| executable.as_str())
                .collect::<Vec<_>>(),
            ["netsh", "netsh", "netsh"],
            "only the in-flight operation and latest queued state should execute"
        );
    }

    fn resolve_program() -> Result<String, String> {
        Ok(PROGRAM.to_owned())
    }

    #[tokio::test]
    async fn a_refused_add_is_elevation_required_only_when_this_process_is_unelevated() {
        // German netsh text: the classification never reads the sentence.
        let localized = FirewallCommandOutput {
            success: false,
            stdout: "Für den angeforderten Vorgang sind erhöhte Rechte erforderlich.\r\n"
                .to_owned(),
            stderr: String::new(),
        };
        for refusal in [elevation_refusal(), localized] {
            let runner = FakeFirewallCommandRunner::with_results(vec![
                Ok(absent()),
                Ok(refusal.clone()),
                Ok(whoami("S-1-16-8192")),
            ]);
            let error = sync_remote_access_rule_with_runner(true, &runner, resolve_program)
                .await
                .expect_err("an unelevated add is refused");
            assert_eq!(error, FirewallFailure::ElevationRequired);
            assert_eq!(error.token(), "firewall-elevation-required");
            assert_eq!(
                runner.calls()[2],
                ("whoami".to_owned(), vec!["/groups".to_owned()])
            );

            // An elevated desktop whose add fails gets the plain failure, never Retry advice.
            let elevated = FakeFirewallCommandRunner::with_results(vec![
                Ok(absent()),
                Ok(refusal),
                Ok(whoami("S-1-16-12288")),
            ]);
            assert_eq!(
                sync_remote_access_rule_with_runner(true, &elevated, resolve_program).await,
                Err(FirewallFailure::AddFailed)
            );
        }

        let unknown = FakeFirewallCommandRunner::with_results(vec![
            Ok(absent()),
            Ok(elevation_refusal()),
            Err("whoami missing".to_owned()),
        ]);
        assert_eq!(
            sync_remote_access_rule_with_runner(true, &unknown, resolve_program).await,
            Err(FirewallFailure::AddFailed)
        );
    }

    #[tokio::test]
    async fn an_existing_rule_for_this_program_is_kept_without_any_change() {
        // An unreadable store leaves the listing's word standing.
        for store in [
            Ok(stored(ADMITTING, PROGRAM)),
            Err("reg missing".to_owned()),
        ] {
            let runner = FakeFirewallCommandRunner::with_results(vec![
                Ok(listed(&PROGRAM.to_uppercase())),
                store,
            ]);

            sync_remote_access_rule_with_runner(true, &runner, resolve_program)
                .await
                .expect("the program's rule already admits it");

            assert_eq!(
                runner.calls()[1],
                ("reg".to_owned(), remote_access_rule_store_args())
            );
            assert_eq!(runner.calls().len(), 2);
        }
    }

    #[tokio::test]
    async fn a_rule_that_does_not_admit_this_program_is_replaced() {
        for fields in [
            "Action=Allow|Active=FALSE|Dir=In",
            "Action=Block|Active=TRUE|Dir=In",
            "Action=Allow|Active=TRUE|Dir=Out",
        ] {
            let runner = FakeFirewallCommandRunner::with_results(vec![
                Ok(listed(PROGRAM)),
                Ok(stored(fields, PROGRAM)),
                Ok(success()),
                Ok(absent()),
                Ok(success()),
            ]);

            sync_remote_access_rule_with_runner(true, &runner, resolve_program)
                .await
                .expect("the rule is replaced");

            let calls = runner.calls();
            assert_eq!(calls[2].1, remote_access_rule_delete_args(), "{fields}");
            assert_eq!(calls[4].1, remote_access_rule_add_args(PROGRAM), "{fields}");
        }
        // Another program's enabled rule under this name does not admit this one.
        let other = FakeFirewallCommandRunner::with_results(vec![
            Ok(listed(PROGRAM)),
            Ok(stored(ADMITTING, r"C:\Old\bibcode-desktop.exe")),
            Ok(success()),
            Ok(absent()),
            Ok(success()),
        ]);
        sync_remote_access_rule_with_runner(true, &other, resolve_program)
            .await
            .expect("the rule is replaced");
        assert_eq!(other.calls().len(), 5);
    }

    fn narrowing() -> Result<String, String> {
        panic!("narrowing must not resolve the executable")
    }

    #[tokio::test]
    async fn narrowing_without_administrator_permission_reports_the_rule_left_in_place() {
        let unelevated = FakeFirewallCommandRunner::with_results(vec![
            Ok(listed(PROGRAM)),
            Ok(elevation_refusal()),
            Ok(listed(PROGRAM)),
            Ok(whoami("S-1-16-8192")),
        ]);
        let error = sync_remote_access_rule_with_runner(false, &unelevated, narrowing)
            .await
            .expect_err("the delete is refused");
        assert_eq!(error, FirewallFailure::RuleLeft);
        assert_eq!(error.token(), FIREWALL_RULE_LEFT_TOKEN);

        // An unelevated process can never change a rule, so any refused delete whose
        // rule is still present is the tolerated case, whatever netsh printed.
        let other_text = FakeFirewallCommandRunner::with_results(vec![
            Ok(listed(PROGRAM)),
            Ok(failure("The object is in use.")),
            Ok(listed(PROGRAM)),
            Ok(whoami("S-1-16-8192")),
        ]);
        assert_eq!(
            sync_remote_access_rule_with_runner(false, &other_text, narrowing).await,
            Err(FirewallFailure::RuleLeft)
        );

        // An elevated desktop's failed delete stays a failed safeguard.
        let elevated = FakeFirewallCommandRunner::with_results(vec![
            Ok(listed(PROGRAM)),
            Ok(failure("The object is in use.")),
            Ok(listed(PROGRAM)),
            Ok(whoami("S-1-16-12288")),
        ]);
        assert_eq!(
            sync_remote_access_rule_with_runner(false, &elevated, narrowing).await,
            Err(FirewallFailure::RemoveFailed)
        );
    }

    #[tokio::test]
    async fn only_a_delete_that_ran_and_left_a_readable_rule_is_tolerated() {
        // The delete did not run (spawn failure or the runner's timeout).
        let not_run = FakeFirewallCommandRunner::with_results(vec![
            Ok(listed(PROGRAM)),
            Err("timed out".to_owned()),
        ]);
        assert_eq!(
            sync_remote_access_rule_with_runner(false, &not_run, narrowing).await,
            Err(FirewallFailure::RemoveFailed)
        );
        assert_eq!(not_run.calls().len(), 2, "no integrity check without a run");

        // The read-back failed.
        let unread = FakeFirewallCommandRunner::with_results(vec![
            Ok(listed(PROGRAM)),
            Ok(elevation_refusal()),
            Ok(failure("Access is denied.")),
            Ok(failure("Access is denied.")),
        ]);
        assert_eq!(
            sync_remote_access_rule_with_runner(false, &unread, narrowing).await,
            Err(FirewallFailure::ReadFailed)
        );

        // The rule is gone after all: narrowing succeeded.
        let gone = FakeFirewallCommandRunner::with_results(vec![
            Ok(listed(PROGRAM)),
            Ok(elevation_refusal()),
            Ok(absent()),
        ]);
        assert_eq!(
            sync_remote_access_rule_with_runner(false, &gone, narrowing).await,
            Ok(())
        );
    }

    #[tokio::test]
    async fn a_prompted_enable_runs_one_elevated_add_and_reads_the_rule_back() {
        let runner = FakeFirewallCommandRunner::with_elevation(
            vec![
                Ok(absent()),
                Ok(elevation_refusal()),
                Ok(whoami("S-1-16-8192")),
                Ok(absent()),
                Ok(listed(PROGRAM)),
            ],
            ElevatedRun::Exited(0),
        );
        let worker = FirewallWorker::start(runner.clone());

        worker
            .sync(
                true,
                true,
                Some(PROGRAM.to_owned()),
                FIREWALL_CALLER_TIMEOUT,
            )
            .await
            .expect("the approved prompt adds the rule");

        assert_eq!(
            runner.elevated(),
            vec![remote_access_rule_add_args(PROGRAM)]
        );
    }

    #[tokio::test]
    async fn a_declined_or_timed_out_prompt_is_one_refusal_and_is_not_retried() {
        let runner = FakeFirewallCommandRunner::with_elevation(
            vec![
                Ok(absent()),
                Ok(elevation_refusal()),
                Ok(whoami("S-1-16-8192")),
                Ok(absent()),
                Ok(absent()),
            ],
            ElevatedRun::Refused,
        );
        let worker = FirewallWorker::start(runner.clone());

        let error = worker
            .sync(
                true,
                true,
                Some(PROGRAM.to_owned()),
                FIREWALL_CALLER_TIMEOUT,
            )
            .await
            .expect_err("a declined prompt is a refusal");

        assert_eq!(error, FirewallFailure::ElevationRequired);
        assert_eq!(runner.elevated().len(), 1);
        assert_eq!(runner.calls().len(), 5, "nothing runs after the refusal");
    }

    #[tokio::test]
    async fn the_read_back_trusts_a_new_rule_but_not_an_old_one_left_by_a_failed_replace() {
        // A listing that does not echo the path (a non-ASCII profile name, say).
        let unmatched = || listed(r"C:\Users\?????\bibcode-desktop.exe");
        let added = FakeFirewallCommandRunner::with_elevation(
            vec![Ok(absent()), Ok(unmatched())],
            ElevatedRun::Exited(0),
        );
        let state = Arc::new(Mutex::new(FirewallWorkerState::default()));
        assert!(
            elevate_remote_access_rule(&added, &state, PROGRAM)
                .await
                .is_ok_and(|observed| observed.is_some())
        );

        let old = r"C:\Old\bibcode-desktop.exe";
        let replaced = FakeFirewallCommandRunner::with_elevation(
            vec![Ok(listed(old)), Ok(listed(old))],
            ElevatedRun::Exited(0),
        );
        assert_eq!(
            elevate_remote_access_rule(&replaced, &state, PROGRAM).await,
            Err(FirewallFailure::RemoveFailed)
        );
        assert_eq!(replaced.elevated().len(), 1, "no add after a failed delete");
    }

    #[tokio::test]
    async fn a_rule_for_another_program_is_replaced_with_one_prompt_per_netsh_run() {
        let other = r"C:\Old\bibcode-desktop.exe";
        let runner = FakeFirewallCommandRunner::with_elevation(
            vec![
                Ok(listed(other)),
                Ok(elevation_refusal()),
                Ok(listed(other)),
                Ok(whoami("S-1-16-8192")),
                Ok(listed(other)),
                Ok(absent()),
                Ok(listed(PROGRAM)),
            ],
            ElevatedRun::Exited(0),
        );
        let worker = FirewallWorker::start(runner.clone());

        worker
            .sync(
                true,
                true,
                Some(PROGRAM.to_owned()),
                FIREWALL_CALLER_TIMEOUT,
            )
            .await
            .expect("two prompts replace the rule");

        assert_eq!(
            runner.elevated(),
            vec![
                remote_access_rule_delete_args(),
                remote_access_rule_add_args(PROGRAM)
            ]
        );
    }

    #[tokio::test]
    async fn only_a_permitted_enable_with_no_prompt_open_may_elevate() {
        let refused = || {
            vec![
                Ok(absent()),
                Ok(elevation_refusal()),
                Ok(whoami("S-1-16-8192")),
            ]
        };
        let not_permitted = FakeFirewallCommandRunner::with_results(refused());
        let worker = FirewallWorker::start(not_permitted.clone());
        assert_eq!(
            worker
                .sync(
                    true,
                    false,
                    Some(PROGRAM.to_owned()),
                    FIREWALL_CALLER_TIMEOUT
                )
                .await,
            Err(FirewallFailure::ElevationRequired)
        );
        assert!(not_permitted.elevated().is_empty());

        let mut second_results = refused();
        second_results.push(Ok(absent()));
        let second = FakeFirewallCommandRunner::with_results(second_results);
        let worker = FirewallWorker::start(second.clone());
        worker
            .state
            .lock()
            .expect("firewall worker state")
            .prompt_open = true;
        assert_eq!(
            worker
                .sync(
                    true,
                    true,
                    Some(PROGRAM.to_owned()),
                    FIREWALL_CALLER_TIMEOUT
                )
                .await,
            Err(FirewallFailure::PromptOpen)
        );
        assert_eq!(FirewallFailure::PromptOpen.token(), "firewall-prompt-open");
        assert!(
            second.elevated().is_empty(),
            "a widen queued while a prompt is open must not open a second one"
        );
    }

    #[tokio::test]
    async fn a_prompt_still_on_screen_after_its_caller_gave_up_blocks_a_second_one() {
        let refused_then_prompt = || {
            vec![
                Ok(absent()),
                Ok(elevation_refusal()),
                Ok(whoami("S-1-16-8192")),
                Ok(absent()),
                Ok(absent()),
            ]
        };
        let mut results = refused_then_prompt();
        results.extend(refused_then_prompt());
        let runner = FakeFirewallCommandRunner::with_elevations(
            results,
            vec![ElevatedRun::Refused, ElevatedRun::Exited(0)],
        );
        runner.hold_prompts.store(true, Ordering::SeqCst);
        let worker = FirewallWorker::start(runner.clone());
        let widen = || {
            worker.sync(
                true,
                true,
                Some(PROGRAM.to_owned()),
                FIREWALL_CALLER_TIMEOUT,
            )
        };

        // The caller is released with the refusal while the prompt is still up.
        assert_eq!(widen().await, Err(FirewallFailure::ElevationRequired));
        assert_eq!(widen().await, Err(FirewallFailure::PromptOpen));
        assert_eq!(
            runner.elevated().len(),
            1,
            "no second prompt while one is open"
        );

        runner.release_held_prompts();
        assert!(
            !worker
                .state
                .lock()
                .expect("firewall worker state")
                .prompt_open
        );
    }

    #[tokio::test]
    async fn a_declined_add_after_an_approved_delete_reports_the_partial_change() {
        let other = r"C:\Old\bibcode-desktop.exe";
        let runner = FakeFirewallCommandRunner::with_elevations(
            vec![
                Ok(listed(other)),
                Ok(elevation_refusal()),
                Ok(listed(other)),
                Ok(whoami("S-1-16-8192")),
                Ok(listed(other)),
                Ok(absent()),
                Ok(absent()),
            ],
            vec![ElevatedRun::Exited(0), ElevatedRun::Refused],
        );
        let worker = FirewallWorker::start(runner.clone());

        let error = worker
            .sync(
                true,
                true,
                Some(PROGRAM.to_owned()),
                FIREWALL_CALLER_TIMEOUT,
            )
            .await
            .expect_err("the add was declined");

        assert_eq!(error, FirewallFailure::RuleRemovedNotAdded);
        assert_eq!(error.token(), "firewall-rule-removed-not-added");
        assert_eq!(runner.elevated().len(), 2, "the stale rule is not restored");
    }

    #[tokio::test]
    async fn a_prompted_widen_and_its_locked_check_agree_on_a_non_ascii_path() {
        let program = "C:\\Users\\T\u{e9}st \u{30e6}\u{30fc}\u{30b6}\\bibcode-desktop.exe";
        // netsh output read back through another code page loses the non-ASCII letters.
        let mangled = || listed(r"C:\Users\T?st ???\bibcode-desktop.exe");
        let runner = FakeFirewallCommandRunner::with_elevation(
            vec![
                // The prompted step before the lock: refused add, one approved prompt.
                Ok(absent()),
                Ok(elevation_refusal()),
                Ok(whoami("S-1-16-8192")),
                Ok(absent()),
                Ok(mangled()),
                // The check under the exposure lock, before the restart.
                Ok(mangled()),
            ],
            ElevatedRun::Exited(0),
        );
        let worker = FirewallWorker::start(runner.clone());

        worker
            .sync(
                true,
                true,
                Some(program.to_owned()),
                FIREWALL_CALLER_TIMEOUT,
            )
            .await
            .expect("the approved prompt adds the rule");
        worker
            .sync(
                true,
                false,
                Some(program.to_owned()),
                FIREWALL_CALLER_TIMEOUT,
            )
            .await
            .expect("the locked check keeps the rule this process added");

        assert_eq!(runner.calls().len(), 6, "no delete of its own rule");
        assert_eq!(runner.elevated().len(), 1);
    }

    #[tokio::test]
    async fn a_same_name_rule_replaced_for_another_program_is_not_taken_for_ours() {
        let program = "C:\\Users\\T\u{e9}st \u{30e6}\u{30fc}\u{30b6}\\bibcode-desktop.exe";
        let mangled = || listed(r"C:\Users\T?st ???\bibcode-desktop.exe");
        let other = || listed(r"C:\Other\tool.exe");
        let runner = FakeFirewallCommandRunner::with_elevation(
            vec![
                // The prompted add, read back as the mangled listing.
                Ok(absent()),
                Ok(elevation_refusal()),
                Ok(whoami("S-1-16-8192")),
                Ok(absent()),
                Ok(mangled()),
                // Someone replaced the rule for another program before the locked check.
                Ok(other()),
                Ok(elevation_refusal()),
                Ok(other()),
                Ok(whoami("S-1-16-8192")),
            ],
            ElevatedRun::Exited(0),
        );
        let worker = FirewallWorker::start(runner.clone());

        worker
            .sync(
                true,
                true,
                Some(program.to_owned()),
                FIREWALL_CALLER_TIMEOUT,
            )
            .await
            .expect("the approved prompt adds the rule");
        assert_eq!(
            worker
                .sync(
                    true,
                    false,
                    Some(program.to_owned()),
                    FIREWALL_CALLER_TIMEOUT
                )
                .await,
            Err(FirewallFailure::ElevationRequired),
            "another program's rule under the same name is not ours"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_prompt_permitted_job_keeps_the_caller_deadline_for_non_interactive_steps() {
        let runner = LateSpawnFirewallCommandRunner::default();
        runner.block_next_add();
        let worker = FirewallWorker::start(runner.clone());
        let caller = worker.clone();
        let job = tokio::spawn(async move {
            caller
                .sync(
                    true,
                    true,
                    Some(PROGRAM.to_owned()),
                    FIREWALL_CALLER_TIMEOUT,
                )
                .await
        });
        wait_for_firewall_calls(&runner, 2).await;

        tokio::time::advance(FIREWALL_CALLER_TIMEOUT + Duration::from_secs(1)).await;
        runner.release_add();

        assert_eq!(
            job.await.expect("caller task"),
            Err(FirewallFailure::TimedOut),
            "an add that finishes after 5 seconds is late even when a prompt was allowed"
        );
        wait_for_firewall_calls(&runner, 3).await;
        assert_eq!(runner.calls()[2].1, remote_access_rule_show_args());
    }

    /// Hostile install paths: each must reach netsh as one unchanged argument.
    const HOSTILE_PATHS: [&str; 6] = [
        r"C:\Program Files\Test User's App\bibcode-desktop.exe",
        "C:\\Program Files\\Test User\u{2019}; Write-Output 1; #\\bibcode-desktop.exe",
        "C:\\Apps\\\u{2018}a\u{201a}b\u{201b}c\\bibcode-desktop.exe",
        r"C:\Apps\$env:x `y & (z) 100%\bibcode-desktop.exe",
        "C:\\Users\\T\u{e9}st \u{30e6}\u{30fc}\u{30b6}\\bibcode-desktop.exe",
        r"C:\Apps\Trailing Space\\bibcode-desktop.exe",
    ];

    #[test]
    fn netsh_arguments_follow_the_windows_command_line_rules_and_carry_any_path_as_data() {
        let quoted = |path: &str| {
            windows_command_line(&remote_access_rule_add_args(path)).expect("valid path")
        };
        let prefix =
            "advfirewall firewall add rule \"name=BiBCode Remote Access\" dir=in action=allow ";
        let suffix = " protocol=TCP profile=domain,private enable=yes";
        for path in HOSTILE_PATHS {
            let expected = if path.contains(' ') {
                format!("{prefix}\"program={path}\"{suffix}")
            } else {
                format!("{prefix}program={path}{suffix}")
            };
            assert_eq!(quoted(path), expected);
        }
        assert_eq!(
            quoted("C:\\Apps\\\u{2018}a\u{201a}b\u{201b}c\\bibcode-desktop.exe"),
            format!(
                "{prefix}program=C:\\Apps\\\u{2018}a\u{201a}b\u{201b}c\\bibcode-desktop.exe{suffix}"
            )
        );
        // Backslashes before a closing quote are doubled; others stay as they are.
        assert_eq!(
            windows_command_line(&["a b\\".to_owned(), String::new(), "c\\d".to_owned()]),
            Ok("\"a b\\\\\" \"\" c\\d".to_owned())
        );
        assert_eq!(
            windows_command_line(&remote_access_rule_add_args("C:\\a\"b\\x.exe")),
            Err(FirewallFailure::Unavailable)
        );
        assert_eq!(
            windows_command_line(&["a\0b".to_owned()]),
            Err(FirewallFailure::Unavailable)
        );
    }

    #[test]
    fn every_program_runs_from_the_given_system_directory() {
        let system = std::path::Path::new(r"C:\Windows\System32");
        assert_eq!(
            system_program_path(system, FirewallProgram::Netsh),
            system.join("netsh.exe")
        );
        assert_eq!(
            system_program_path(system, FirewallProgram::Whoami),
            system.join("whoami.exe")
        );
        assert_eq!(ELEVATION_PROMPT_TIMEOUT, Duration::from_secs(120));
    }

    #[cfg(windows)]
    #[test]
    fn every_spawned_program_is_absolute_and_under_the_api_system_directory() {
        let system = system_directory().expect("GetSystemDirectoryW");
        assert!(system.is_absolute());
        for program in [
            FirewallProgram::Netsh,
            FirewallProgram::Whoami,
            FirewallProgram::Reg,
        ] {
            let path = system_program_path(&system, program);
            assert!(path.is_absolute());
            assert_eq!(path.parent(), Some(system.as_path()));
            assert!(path.is_file(), "{}", path.display());
        }
    }

    /// Unelevated, no prompt: starts the `firewall_argv_echo` example through the same
    /// `ShellExecuteExW` path with the `open` verb, and compares the arguments it received
    /// with the ones built for netsh, UTF-16 unit for unit.
    #[cfg(windows)]
    #[test]
    #[ignore = "Windows VM probe; build the firewall_argv_echo example first"]
    fn elevation_arguments_reach_a_stand_in_program_byte_for_byte() {
        let echo = std::env::current_exe()
            .expect("test executable")
            .parent()
            .and_then(std::path::Path::parent)
            .expect("target directory")
            .join("examples")
            .join("firewall_argv_echo.exe");
        assert!(echo.is_file(), "missing {}", echo.display());
        let directory = tempfile::tempdir().expect("temporary directory");
        for (index, path) in HOSTILE_PATHS.iter().enumerate() {
            let args = remote_access_rule_add_args(path);
            let output = directory.path().join(format!("argv-{index}.json"));
            // SAFETY: the probe runs alone; the child inherits this variable.
            unsafe { std::env::set_var("BIBCODE_ARGV_ECHO_OUT", &output) };
            let run = shell_execute_and_wait(
                "open",
                &echo,
                &windows_command_line(&args).expect("valid path"),
                Duration::from_secs(30),
            )
            .expect("stand-in started");
            assert_eq!(run, ShellRun::Exited(0));
            let received: Vec<Vec<u16>> =
                serde_json::from_slice(&std::fs::read(&output).expect("echo output"))
                    .expect("echo JSON");
            let expected: Vec<Vec<u16>> = args
                .iter()
                .map(|arg| arg.encode_utf16().collect())
                .collect();
            assert_eq!(received, expected, "{path}");
        }
    }
}
