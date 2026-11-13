//! Windows Defender Firewall integration for grant-driven server exposure.
//!
//! The desktop backend port is picked dynamically, so the inbound allow rule is
//! program-scoped rather than port-scoped. Non-Windows platforms have no managed
//! firewall here and every call is a successful no-op.

#[cfg(windows)]
use bibcode_server::process::ProcessRunner;
#[cfg(any(windows, test))]
use bibcode_server::process::{OutputMode, ProcessRunInput, TimeoutBehavior};
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
}

#[cfg(any(windows, test))]
impl FirewallFailure {
    pub(crate) const fn token(self) -> &'static str {
        match self {
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
/// Exit code of the unelevated launcher when `Start-Process -Verb RunAs` throws, which it
/// does when the person declines or dismisses the prompt (`ERROR_CANCELLED`).
#[cfg(any(windows, test))]
const ELEVATION_REFUSED_EXIT_CODE: i32 = 1223;

/// Mandatory-label SIDs in `whoami /groups`. SIDs are not localized, unlike netsh text.
#[cfg(any(windows, test))]
const UNELEVATED_INTEGRITY_SIDS: [&str; 3] = ["S-1-16-4096", "S-1-16-8192", "S-1-16-8448"];
#[cfg(any(windows, test))]
const ELEVATED_INTEGRITY_SIDS: [&str; 2] = ["S-1-16-12288", "S-1-16-16384"];

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct FirewallCommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

/// How the elevated firewall change ended, as far as the unelevated launcher can tell.
/// Whether the rule exists afterwards is read separately and decides success.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ElevatedRun {
    Finished,
    /// Declined, dismissed, timed out, or the launcher could not start.
    Refused,
}

#[cfg(any(windows, test))]
trait FirewallCommandRunner: Sync {
    fn run(
        &self,
        executable: String,
        args: Vec<String>,
    ) -> impl std::future::Future<Output = Result<FirewallCommandOutput, String>> + Send;

    /// Runs the given netsh argument lists, in order, in one elevated process behind one
    /// Windows prompt.
    fn run_elevated(
        &self,
        netsh_commands: Vec<Vec<String>>,
    ) -> impl std::future::Future<Output = ElevatedRun> + Send;
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
    /// permission ask once through the elevation prompt; the caller then also waits for it.
    async fn sync(
        &self,
        enabled: bool,
        allow_prompt: bool,
        program: Option<String>,
        caller_timeout: Duration,
    ) -> Result<(), FirewallFailure> {
        let deadline = tokio::time::Instant::now() + caller_timeout;
        let wait_until = if allow_prompt {
            deadline + ELEVATION_PROMPT_TIMEOUT + caller_timeout
        } else {
            deadline
        };
        let (completion, receiver) = oneshot::channel();
        let (superseded, worker_unavailable) = {
            let mut state = self.state.lock().expect("firewall worker state");
            // A widen queued while a prompt is open never opens a second one.
            let allow_prompt = allow_prompt && !state.prompt_open;
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
            let mut result = if already_late {
                sync_remote_access_rule_with_runner(false, &runner, || {
                    Err("expired firewall job must not add a rule".to_owned())
                })
                .await
            } else {
                let program = job.program.clone();
                sync_remote_access_rule_with_runner(job.enabled, &runner, move || {
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
                    + ELEVATION_PROMPT_TIMEOUT
                    + FIREWALL_CALLER_TIMEOUT;
                state.lock().expect("firewall worker state").prompt_open = true;
                result = elevate_remote_access_rule(&runner, program).await;
                state.lock().expect("firewall worker state").prompt_open = false;
            }

            let completed_late = already_late || tokio::time::Instant::now() >= deadline;
            if job.enabled && !already_late && completed_late {
                let cleanup = sync_remote_access_rule_with_runner(false, &runner, || {
                    Err("firewall cleanup must not add a rule".to_owned())
                })
                .await;
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

/// A PowerShell single-quoted literal: nothing inside it is expanded.
#[cfg(any(windows, test))]
fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// `-EncodedCommand` takes UTF-16LE Base64, so no argument is ever re-quoted by a shell.
#[cfg(any(windows, test))]
fn powershell_encoded(script: &str) -> String {
    use base64::Engine as _;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The elevated script runs only the system netsh with the given argument lists and stops
/// at the first failure. The unelevated launcher asks Windows to run it with `-Verb RunAs`
/// and exits with [`ELEVATION_REFUSED_EXIT_CODE`] when the prompt is declined.
#[cfg(any(windows, test))]
fn elevation_launcher_args(netsh_commands: &[Vec<String>]) -> Vec<String> {
    let mut elevated = String::new();
    for args in netsh_commands {
        elevated.push_str("& \"$env:SystemRoot\\System32\\netsh.exe\"");
        for arg in args {
            elevated.push(' ');
            elevated.push_str(&powershell_literal(arg));
        }
        elevated.push_str("; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ");
    }
    elevated.push_str("exit 0");
    let launcher = format!(
        "try {{ $p = Start-Process -FilePath \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{}'; exit $p.ExitCode }} catch {{ exit {ELEVATION_REFUSED_EXIT_CODE} }}",
        powershell_encoded(&elevated)
    );
    vec![
        "-NoProfile".to_owned(),
        "-NonInteractive".to_owned(),
        "-EncodedCommand".to_owned(),
        powershell_encoded(&launcher),
    ]
}

#[cfg(any(windows, test))]
fn elevation_process_input(netsh_commands: &[Vec<String>]) -> ProcessRunInput {
    ProcessRunInput::new("powershell", elevation_launcher_args(netsh_commands))
        .with_timeout(ELEVATION_PROMPT_TIMEOUT)
        .with_timeout_behavior(TimeoutBehavior::TimedOutResult)
        .with_max_output_bytes(FIREWALL_COMMAND_MAX_OUTPUT_BYTES)
        .with_output_mode(OutputMode::Truncate)
}

#[cfg(windows)]
impl FirewallCommandRunner for ProcessFirewallCommandRunner {
    async fn run(
        &self,
        executable: String,
        args: Vec<String>,
    ) -> Result<FirewallCommandOutput, String> {
        let output = ProcessRunner
            .run(firewall_process_input(executable.clone(), args))
            .await
            .map_err(|error| format!("failed to run {executable}: {error}"))?;
        Ok(FirewallCommandOutput {
            success: output.code == Some(0),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }

    async fn run_elevated(&self, netsh_commands: Vec<Vec<String>>) -> ElevatedRun {
        // The supervised runner reports the launcher's exit to the Profiler. A prompt it
        // leaves behind on timeout belongs to Windows and cannot be closed from here.
        match ProcessRunner
            .run(elevation_process_input(&netsh_commands))
            .await
        {
            Ok(output) if !output.timed_out && output.code != Some(ELEVATION_REFUSED_EXIT_CODE) => {
                ElevatedRun::Finished
            }
            _ => ElevatedRun::Refused,
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
        .run("netsh".to_owned(), remote_access_store_probe_args())
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
        .run("netsh".to_owned(), remote_access_rule_show_args())
        .await
        .map_err(|_| FirewallFailure::ReadFailed)?;
    if confirm_rule_listing_is_absent(runner, &listing).await? {
        return Ok(RuleListing::Absent);
    }
    // The path is compared as text; only its field label is localized.
    let text = firewall_command_text(&listing).to_lowercase();
    Ok(RuleListing::Present {
        for_program: program.is_some_and(|program| text.contains(&program.to_lowercase())),
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
        .run("whoami".to_owned(), vec!["/groups".to_owned()])
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

#[cfg(any(windows, test))]
async fn sync_remote_access_rule_with_runner<Runner, ResolveProgram>(
    enabled: bool,
    runner: &Runner,
    resolve_program: ResolveProgram,
) -> Result<(), FirewallFailure>
where
    Runner: FirewallCommandRunner,
    ResolveProgram: FnOnce() -> Result<String, String>,
{
    let program = if enabled {
        Some(resolve_program().map_err(|_| FirewallFailure::Unavailable)?)
    } else {
        None
    };
    match read_remote_access_rule(runner, program.as_deref()).await? {
        // A rule for this program already admits it; keep it rather than ask again.
        RuleListing::Present { for_program: true } if enabled => return Ok(()),
        RuleListing::Absent => {}
        RuleListing::Present { .. } => {
            let deletion = runner
                .run("netsh".to_owned(), remote_access_rule_delete_args())
                .await
                .map_err(|_| FirewallFailure::RemoveFailed)?;
            if !deletion.success {
                return Err(match (runs_unelevated(runner).await, enabled) {
                    (true, true) => FirewallFailure::ElevationRequired,
                    (true, false) => FirewallFailure::RuleLeft,
                    (false, _) => FirewallFailure::RemoveFailed,
                });
            }
            if read_remote_access_rule(runner, None).await? != RuleListing::Absent {
                return Err(FirewallFailure::RemoveFailed);
            }
        }
    }
    let Some(program) = program else {
        return Ok(());
    };
    let addition = runner
        .run("netsh".to_owned(), remote_access_rule_add_args(&program))
        .await
        .map_err(|_| FirewallFailure::AddFailed)?;
    if addition.success {
        Ok(())
    } else if runs_unelevated(runner).await {
        Err(FirewallFailure::ElevationRequired)
    } else {
        Err(FirewallFailure::AddFailed)
    }
}

/// One elevated process replaces a rule for another program and adds this program's rule,
/// so the person answers one prompt. Success is read back from the rule store.
#[cfg(any(windows, test))]
async fn elevate_remote_access_rule<Runner>(
    runner: &Runner,
    program: &str,
) -> Result<(), FirewallFailure>
where
    Runner: FirewallCommandRunner,
{
    let mut netsh_commands = Vec::new();
    if read_remote_access_rule(runner, Some(program)).await? != RuleListing::Absent {
        netsh_commands.push(remote_access_rule_delete_args());
    }
    netsh_commands.push(remote_access_rule_add_args(program));
    let run = runner.run_elevated(netsh_commands).await;
    match (read_remote_access_rule(runner, Some(program)).await?, run) {
        (RuleListing::Present { for_program: true }, _) => Ok(()),
        (_, ElevatedRun::Refused) => Err(FirewallFailure::ElevationRequired),
        (_, ElevatedRun::Finished) => Err(FirewallFailure::AddFailed),
    }
}

/// `allow_prompt` is true only for a widen the person started in the Share this host
/// dialog; recovery and automatic narrowing never raise the Windows prompt.
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
        elevated: Arc<Mutex<Vec<Vec<Vec<String>>>>>,
        elevated_outcome: Arc<Mutex<Option<ElevatedRun>>>,
    }

    impl FakeFirewallCommandRunner {
        fn with_results(results: Vec<Result<FirewallCommandOutput, String>>) -> Self {
            Self {
                results: Arc::new(Mutex::new(results.into())),
                ..Self::default()
            }
        }

        fn with_elevation(
            results: Vec<Result<FirewallCommandOutput, String>>,
            outcome: ElevatedRun,
        ) -> Self {
            let runner = Self::with_results(results);
            *runner.elevated_outcome.lock().expect("elevated outcome") = Some(outcome);
            runner
        }

        fn calls(&self) -> Vec<FirewallCall> {
            self.calls.lock().expect("firewall calls").clone()
        }

        fn elevated(&self) -> Vec<Vec<Vec<String>>> {
            self.elevated.lock().expect("elevated calls").clone()
        }
    }

    impl FirewallCommandRunner for FakeFirewallCommandRunner {
        fn run(
            &self,
            executable: String,
            args: Vec<String>,
        ) -> impl std::future::Future<Output = Result<FirewallCommandOutput, String>> + Send
        {
            self.calls
                .lock()
                .expect("firewall calls")
                .push((executable, args));
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
            netsh_commands: Vec<Vec<String>>,
        ) -> impl std::future::Future<Output = ElevatedRun> + Send {
            self.elevated
                .lock()
                .expect("elevated calls")
                .push(netsh_commands);
            let outcome = self
                .elevated_outcome
                .lock()
                .expect("elevated outcome")
                .expect("an elevated run was not expected");
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
            executable: String,
            args: Vec<String>,
        ) -> impl std::future::Future<Output = Result<FirewallCommandOutput, String>> + Send
        {
            let should_block = args.iter().any(|arg| arg == "add")
                && self.block_next_add.swap(false, Ordering::SeqCst);
            self.calls
                .lock()
                .expect("firewall calls")
                .push((executable.clone(), args));
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

        async fn run_elevated(&self, _netsh_commands: Vec<Vec<String>>) -> ElevatedRun {
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
        let runner =
            FakeFirewallCommandRunner::with_results(vec![Ok(listed(&PROGRAM.to_uppercase()))]);

        sync_remote_access_rule_with_runner(true, &runner, resolve_program)
            .await
            .expect("the program's rule already admits it");

        assert_eq!(runner.calls().len(), 1);
    }

    #[tokio::test]
    async fn narrowing_without_administrator_permission_reports_the_rule_left_in_place() {
        let unelevated = FakeFirewallCommandRunner::with_results(vec![
            Ok(listed(PROGRAM)),
            Ok(elevation_refusal()),
            Ok(whoami("S-1-16-8192")),
        ]);
        let error = sync_remote_access_rule_with_runner(false, &unelevated, || {
            panic!("narrowing must not resolve the executable")
        })
        .await
        .expect_err("the delete is refused");
        assert_eq!(error, FirewallFailure::RuleLeft);
        assert_eq!(error.token(), FIREWALL_RULE_LEFT_TOKEN);

        // Any other delete failure stays a failed safeguard.
        let elevated = FakeFirewallCommandRunner::with_results(vec![
            Ok(listed(PROGRAM)),
            Ok(failure("The object is in use.")),
            Ok(whoami("S-1-16-12288")),
        ]);
        assert_eq!(
            sync_remote_access_rule_with_runner(false, &elevated, || {
                panic!("narrowing must not resolve the executable")
            })
            .await,
            Err(FirewallFailure::RemoveFailed)
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
            ElevatedRun::Finished,
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
            vec![vec![remote_access_rule_add_args(PROGRAM)]]
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
    async fn a_rule_for_another_program_is_replaced_behind_one_prompt() {
        let other = r"C:\Old\bibcode-desktop.exe";
        let runner = FakeFirewallCommandRunner::with_elevation(
            vec![
                Ok(listed(other)),
                Ok(elevation_refusal()),
                Ok(whoami("S-1-16-8192")),
                Ok(listed(other)),
                Ok(listed(PROGRAM)),
            ],
            ElevatedRun::Finished,
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
            .expect("one prompt replaces the rule");

        assert_eq!(
            runner.elevated(),
            vec![vec![
                remote_access_rule_delete_args(),
                remote_access_rule_add_args(PROGRAM)
            ]]
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

        let second = FakeFirewallCommandRunner::with_results(refused());
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
            Err(FirewallFailure::ElevationRequired)
        );
        assert!(
            second.elevated().is_empty(),
            "a widen queued while a prompt is open must not open a second one"
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

    fn decode_powershell(encoded: &str) -> String {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("Base64");
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        String::from_utf16(&units).expect("UTF-16LE")
    }

    #[test]
    fn the_elevated_command_line_runs_only_system_netsh_with_quoted_arguments() {
        let program = r"C:\Program Files\O'Brien & Co\bibcode-desktop.exe";
        let commands = vec![
            remote_access_rule_delete_args(),
            remote_access_rule_add_args(program),
        ];
        let input = elevation_process_input(&commands);
        assert_eq!(input.command, "powershell");
        assert_eq!(input.timeout, ELEVATION_PROMPT_TIMEOUT);
        assert_eq!(input.timeout, Duration::from_secs(120));
        assert_eq!(input.timeout_behavior, TimeoutBehavior::TimedOutResult);
        assert_eq!(
            input.args[..3],
            ["-NoProfile", "-NonInteractive", "-EncodedCommand"]
        );
        assert_eq!(input.args.len(), 4);

        let launcher = decode_powershell(&input.args[3]);
        let prefix = "try { $p = Start-Process -FilePath \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','";
        let suffix = "'; exit $p.ExitCode } catch { exit 1223 }";
        assert!(launcher.starts_with(prefix), "{launcher}");
        assert!(launcher.ends_with(suffix), "{launcher}");
        let elevated = decode_powershell(&launcher[prefix.len()..launcher.len() - suffix.len()]);

        assert_eq!(
            elevated,
            concat!(
                "& \"$env:SystemRoot\\System32\\netsh.exe\" 'advfirewall' 'firewall' 'delete' 'rule' 'name=BiBCode Remote Access'; ",
                "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ",
                "& \"$env:SystemRoot\\System32\\netsh.exe\" 'advfirewall' 'firewall' 'add' 'rule' 'name=BiBCode Remote Access' 'dir=in' 'action=allow' ",
                "'program=C:\\Program Files\\O''Brien & Co\\bibcode-desktop.exe' 'protocol=TCP' 'profile=domain,private' 'enable=yes'; ",
                "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0"
            )
        );
    }
}
