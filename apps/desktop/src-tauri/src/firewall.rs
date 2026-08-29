//! Windows Defender Firewall integration for grant-driven server exposure.
//!
//! The desktop backend port is picked dynamically, so the inbound allow rule is
//! program-scoped rather than port-scoped. Non-Windows platforms have no managed
//! firewall here and every call is a successful no-op.

#[cfg(windows)]
use bibcode_server::process::ProcessRunner;
#[cfg(any(windows, test))]
use bibcode_server::process::{OutputMode, ProcessRunInput};
#[cfg(any(windows, test))]
use std::time::Duration;

#[cfg(any(windows, test))]
const FIREWALL_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(any(windows, test))]
const FIREWALL_COMMAND_MAX_OUTPUT_BYTES: usize = 64 * 1024;

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

#[must_use]
#[cfg_attr(
    all(not(windows), not(test)),
    expect(dead_code, reason = "Windows-only firewall command")
)]
pub(crate) fn remote_access_rule_delete_and_verify_args() -> Vec<String> {
    let script = format!(
        "$ErrorActionPreference = 'Stop'; \
         $name = '{REMOTE_ACCESS_RULE_NAME}'; \
         $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | \
           Where-Object {{ $_.DisplayName -eq $name }}); \
         if ($rules.Count -gt 0) {{ \
           $rules | Remove-NetFirewallRule -ErrorAction Stop \
         }}; \
         $remaining = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | \
           Where-Object {{ $_.DisplayName -eq $name }}); \
         if ($remaining.Count -ne 0) {{ \
           throw 'remote access firewall rule is still present after deletion' \
         }}"
    );
    vec![
        "-NoLogo".to_owned(),
        "-NoProfile".to_owned(),
        "-NonInteractive".to_owned(),
        "-Command".to_owned(),
        script,
    ]
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct FirewallCommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

#[cfg(any(windows, test))]
trait FirewallCommandRunner: Sync {
    fn run(
        &self,
        executable: String,
        args: Vec<String>,
    ) -> impl std::future::Future<Output = Result<FirewallCommandOutput, String>> + Send;
}

#[cfg(windows)]
struct ProcessFirewallCommandRunner;

#[cfg(any(windows, test))]
fn firewall_process_input(executable: String, args: Vec<String>) -> ProcessRunInput {
    ProcessRunInput::new(executable, args)
        .with_timeout(FIREWALL_COMMAND_TIMEOUT)
        .with_max_output_bytes(FIREWALL_COMMAND_MAX_OUTPUT_BYTES)
        .with_output_mode(OutputMode::Truncate)
}

#[cfg(windows)]
impl FirewallCommandRunner for ProcessFirewallCommandRunner {
    fn run(
        &self,
        executable: String,
        args: Vec<String>,
    ) -> impl std::future::Future<Output = Result<FirewallCommandOutput, String>> + Send {
        async move {
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
    }
}

#[cfg(any(windows, test))]
async fn sync_remote_access_rule_with_runner<Runner, ResolveProgram>(
    enabled: bool,
    runner: &Runner,
    resolve_program: ResolveProgram,
) -> Result<(), String>
where
    Runner: FirewallCommandRunner,
    ResolveProgram: FnOnce() -> Result<String, String>,
{
    let deletion = runner
        .run(
            "powershell.exe".to_owned(),
            remote_access_rule_delete_and_verify_args(),
        )
        .await?;
    require_firewall_command_success(
        "delete and verify the remote access firewall rule",
        deletion,
    )?;
    if !enabled {
        return Ok(());
    }

    let program = resolve_program()?;
    let addition = runner
        .run("netsh".to_owned(), remote_access_rule_add_args(&program))
        .await?;
    require_firewall_command_success("add the remote access firewall rule", addition)
}

#[cfg(any(windows, test))]
fn require_firewall_command_success(
    operation: &str,
    output: FirewallCommandOutput,
) -> Result<(), String> {
    if output.success {
        return Ok(());
    }
    let stderr = output.stderr.trim();
    let stdout = output.stdout.trim();
    let details = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "command exited unsuccessfully without output"
    };
    Err(format!("failed to {operation}: {details}"))
}

#[cfg(windows)]
pub(crate) async fn sync_remote_access_rule(enabled: bool) -> Result<(), String> {
    sync_remote_access_rule_with_runner(enabled, &ProcessFirewallCommandRunner, || {
        std::env::current_exe()
            .map_err(|error| format!("failed to resolve desktop executable: {error}"))
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
}

#[cfg(not(windows))]
pub(crate) async fn sync_remote_access_rule(_enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    type FirewallCall = (String, Vec<String>);

    #[derive(Clone, Default)]
    struct FakeFirewallCommandRunner {
        calls: Arc<Mutex<Vec<FirewallCall>>>,
        results: Arc<Mutex<VecDeque<Result<FirewallCommandOutput, String>>>>,
    }

    impl FakeFirewallCommandRunner {
        fn with_results(results: Vec<Result<FirewallCommandOutput, String>>) -> Self {
            Self {
                calls: Arc::default(),
                results: Arc::new(Mutex::new(results.into())),
            }
        }

        fn calls(&self) -> Vec<FirewallCall> {
            self.calls.lock().expect("firewall calls").clone()
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
    fn delete_script_removes_the_named_persistent_rule_and_verifies_absence() {
        let args = remote_access_rule_delete_and_verify_args();
        assert_eq!(
            &args[..4],
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
        );
        let script = &args[4];
        assert!(script.contains("Get-NetFirewallRule -PolicyStore PersistentStore"));
        assert!(script.contains("Remove-NetFirewallRule -ErrorAction Stop"));
        assert!(script.contains("BiBCode Remote Access"));
        assert!(script.contains("$remaining.Count -ne 0"));
    }

    #[tokio::test]
    async fn disabling_reports_firewall_process_launch_failure() {
        let runner = FakeFirewallCommandRunner::with_results(vec![Err("launch denied".to_owned())]);

        let error = sync_remote_access_rule_with_runner(false, &runner, || {
            panic!("disabled cleanup must not resolve the executable")
        })
        .await
        .expect_err("spawn failure must be reported");

        assert!(error.contains("launch denied"));
        assert_eq!(runner.calls().len(), 1);
        assert_eq!(runner.calls()[0].0, "powershell.exe");
    }

    #[tokio::test]
    async fn disabling_reports_policy_denial_instead_of_claiming_cleanup() {
        let runner =
            FakeFirewallCommandRunner::with_results(vec![Ok(failure("Access is denied."))]);

        let error = sync_remote_access_rule_with_runner(false, &runner, || {
            panic!("disabled cleanup must not resolve the executable")
        })
        .await
        .expect_err("policy denial must be reported");

        assert!(error.contains("delete and verify"));
        assert!(error.contains("Access is denied."));
        assert_eq!(runner.calls().len(), 1);
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
        assert_eq!(calls[0].0, "powershell.exe");
        assert_eq!(calls[1].0, "netsh");
        assert_eq!(
            calls[1].1,
            remote_access_rule_add_args(r"C:\Apps\BiBCode\bibcode-desktop.exe")
        );
    }
}
