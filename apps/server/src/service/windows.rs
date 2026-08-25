use serde::Deserialize;

use super::model::{
    CommandOutput, CommandSpec, CommandStep, ServiceError, ServiceMode, ServicePlatform,
    ServiceState, ServiceStatus, ServiceTarget,
};

const TASK_NAME: &str = "BiBCode";
const SERVICE_NAME: &str = "BiBCode";
const SERVICE_ACCOUNT: &str = r"NT SERVICE\BiBCode";

const TASK_STATUS_SCRIPT: &str = concat!(
    "$ErrorActionPreference='Stop';",
    "$task=Get-ScheduledTask -TaskName 'BiBCode' -ErrorAction SilentlyContinue;",
    "if($null -eq $task){[pscustomobject]@{installed=$false;state='NotInstalled';definition=''}|ConvertTo-Json -Compress;exit 0};",
    "$action=@($task.Actions)[0];",
    "$identity=[string]::Join([char]31,@([string]$action.Execute,[string]$action.Arguments,[string]$task.Principal.LogonType));",
    "[pscustomobject]@{installed=$true;state=[string]$task.State;definition=$identity;account=[string]$task.Principal.UserId;enabled=[bool]$task.Settings.Enabled}|ConvertTo-Json -Compress",
);

const SERVICE_STATUS_SCRIPT: &str = concat!(
    "$ErrorActionPreference='Stop';",
    "$service=Get-CimInstance Win32_Service -Filter \"Name='BiBCode'\" -ErrorAction SilentlyContinue;",
    "if($null -eq $service){[pscustomobject]@{installed=$false;state='NotInstalled';definition=''}|ConvertTo-Json -Compress;exit 0};",
    "[pscustomobject]@{installed=$true;state=[string]$service.State;definition=[string]$service.PathName;account=[string]$service.StartName;enabled=([string]$service.StartMode -eq 'Auto')}|ConvertTo-Json -Compress",
);

const REGISTER_TASK_SCRIPT: &str = concat!(
    "$ErrorActionPreference='Stop';",
    "$xml=[Console]::In.ReadToEnd();",
    "Register-ScheduledTask -TaskName 'BiBCode' -Xml $xml -Force | Out-Null",
);

const ADMIN_STATUS_SCRIPT: &str = concat!(
    "$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent());",
    "if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){'true'}else{'false'}",
);

#[derive(Clone, Debug)]
pub(crate) struct WindowsAdapter {
    target: ServiceTarget,
    definition: String,
    definition_identity: String,
}

impl WindowsAdapter {
    pub(crate) fn new(target: ServiceTarget) -> Result<Self, ServiceError> {
        target.validate(ServicePlatform::Windows)?;
        let (definition, definition_identity) = match target.mode {
            ServiceMode::Workstation => (render_task_xml(&target), render_task_identity(&target)),
            ServiceMode::Headless => {
                let definition = render_service_command_line(&target);
                (definition.clone(), definition)
            }
        };
        Ok(Self {
            target,
            definition,
            definition_identity,
        })
    }

    pub(crate) fn target(&self) -> &ServiceTarget {
        &self.target
    }

    pub(crate) fn definition(&self) -> &str {
        &self.definition
    }

    pub(crate) fn definition_identity(&self) -> &str {
        &self.definition_identity
    }

    pub(crate) fn startup_owner(&self) -> &'static str {
        match self.target.mode {
            ServiceMode::Workstation => "task-scheduler-logon",
            ServiceMode::Headless => "windows-service",
        }
    }

    pub(crate) fn account(&self) -> &str {
        match self.target.mode {
            ServiceMode::Workstation => &self.target.current_user.name,
            ServiceMode::Headless => SERVICE_ACCOUNT,
        }
    }

    pub(crate) fn status_commands(&self) -> Vec<CommandSpec> {
        vec![powershell(match self.target.mode {
            ServiceMode::Workstation => TASK_STATUS_SCRIPT,
            ServiceMode::Headless => SERVICE_STATUS_SCRIPT,
        })]
    }

    pub(crate) fn parse_status(
        &self,
        outputs: &[CommandOutput],
    ) -> Result<ServiceStatus, ServiceError> {
        if outputs.len() != 1 || outputs[0].exit_code != 0 {
            return Err(ServiceError::InvalidManagerResponse(
                "Windows service status could not be inspected".to_owned(),
            ));
        }
        let status: WindowsStatus =
            serde_json::from_str(outputs[0].stdout.trim()).map_err(|_| {
                ServiceError::InvalidManagerResponse(
                    "PowerShell returned an invalid service status document".to_owned(),
                )
            })?;
        let state = if !status.installed {
            ServiceState::NotInstalled
        } else {
            match status.state.to_ascii_lowercase().as_str() {
                "running" => ServiceState::Running,
                "start pending" | "queued" => ServiceState::Starting,
                "stop pending" => ServiceState::Stopping,
                "stopped" | "ready" | "disabled" => ServiceState::Stopped,
                _ => ServiceState::Failed,
            }
        };
        let account_matches = status.account.as_deref().is_some_and(|account| {
            if self.target.mode == ServiceMode::Workstation {
                windows_account_matches(account, &self.target.current_user.name)
            } else {
                account.eq_ignore_ascii_case(SERVICE_ACCOUNT)
            }
        });
        Ok(ServiceStatus {
            mode: self.target.mode,
            state,
            startup_owner: self.startup_owner().to_owned(),
            account: self.account().to_owned(),
            binary_path: self.target.binary_path.clone(),
            data_root: self.target.data_root.clone(),
            bind: self.target.bind,
            control_endpoint: self.target.control_endpoint(ServicePlatform::Windows),
            enabled: status.enabled.unwrap_or(status.installed),
            definition_matches: status.installed
                && account_matches
                && status.definition == self.definition_identity,
            linger_enabled: None,
        })
    }

    pub(crate) fn authority_command(&self) -> Option<CommandSpec> {
        (self.target.mode == ServiceMode::Headless).then(|| powershell(ADMIN_STATUS_SCRIPT))
    }

    pub(crate) fn account_probe(&self) -> Option<CommandSpec> {
        None
    }

    pub(crate) fn account_create_step(&self) -> Option<CommandStep> {
        None
    }

    pub(crate) fn install_steps(&self, update: bool) -> Vec<CommandStep> {
        match self.target.mode {
            ServiceMode::Workstation => {
                let mut command = powershell(REGISTER_TASK_SCRIPT);
                command.stdin = Some(self.definition.as_bytes().to_vec());
                vec![
                    CommandStep::checked(command).with_rollback(CommandSpec::new(
                        "schtasks.exe",
                        ["/Delete", "/TN", TASK_NAME, "/F"],
                    )),
                    CommandStep::checked(CommandSpec::new(
                        "schtasks.exe",
                        ["/Run", "/TN", TASK_NAME],
                    )),
                ]
            }
            ServiceMode::Headless => {
                let mut steps = Vec::new();
                if update {
                    steps.push(
                        CommandStep::checked(CommandSpec::new("sc.exe", ["stop", SERVICE_NAME]))
                            .accepting([0, 1062]),
                    );
                    steps.push(CommandStep::checked(CommandSpec::new(
                        "sc.exe",
                        ["config", SERVICE_NAME, "binPath=", self.definition.as_str()],
                    )));
                } else {
                    steps.push(
                        CommandStep::checked(CommandSpec::new(
                            "sc.exe",
                            [
                                "create",
                                SERVICE_NAME,
                                "binPath=",
                                self.definition.as_str(),
                                "start=",
                                "auto",
                                "obj=",
                                SERVICE_ACCOUNT,
                                "DisplayName=",
                                "BiBCode Server",
                            ],
                        ))
                        .with_rollback(CommandSpec::new("sc.exe", ["delete", SERVICE_NAME])),
                    );
                }
                steps.push(CommandStep::checked(CommandSpec::new(
                    "sc.exe",
                    [
                        "failure",
                        SERVICE_NAME,
                        "reset=",
                        "86400",
                        "actions=",
                        "restart/2000/restart/5000/\"\"/0",
                    ],
                )));
                steps.push(CommandStep::checked(CommandSpec::new(
                    "icacls.exe",
                    [
                        self.target.data_root.to_string_lossy().as_ref(),
                        "/inheritance:r",
                        "/grant:r",
                        r"NT SERVICE\BiBCode:(OI)(CI)M",
                        r"SYSTEM:(OI)(CI)F",
                        r"Administrators:(OI)(CI)F",
                    ],
                )));
                steps.push(CommandStep::checked(CommandSpec::new(
                    "sc.exe",
                    ["start", SERVICE_NAME],
                )));
                steps
            }
        }
    }

    pub(crate) fn start_steps(&self) -> Vec<CommandStep> {
        vec![CommandStep::checked(match self.target.mode {
            ServiceMode::Workstation => {
                CommandSpec::new("schtasks.exe", ["/Run", "/TN", TASK_NAME])
            }
            ServiceMode::Headless => CommandSpec::new("sc.exe", ["start", SERVICE_NAME]),
        })]
    }

    pub(crate) fn finalize_install_steps(&self, _update: bool) -> Vec<CommandStep> {
        Vec::new()
    }

    pub(crate) fn stop_steps(&self) -> Vec<CommandStep> {
        vec![
            CommandStep::checked(match self.target.mode {
                ServiceMode::Workstation => {
                    CommandSpec::new("schtasks.exe", ["/End", "/TN", TASK_NAME])
                }
                ServiceMode::Headless => CommandSpec::new("sc.exe", ["stop", SERVICE_NAME]),
            })
            .accepting([0, 1062, 267009]),
        ]
    }

    pub(crate) fn uninstall_steps(&self) -> Vec<CommandStep> {
        vec![
            CommandStep::checked(match self.target.mode {
                ServiceMode::Workstation => {
                    CommandSpec::new("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"])
                }
                ServiceMode::Headless => CommandSpec::new("sc.exe", ["delete", SERVICE_NAME]),
            })
            .accepting([0, 1060]),
        ]
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsStatus {
    installed: bool,
    state: String,
    definition: String,
    account: Option<String>,
    enabled: Option<bool>,
}

fn powershell(script: &str) -> CommandSpec {
    CommandSpec::new(
        "powershell.exe",
        [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ],
    )
}

fn render_task_xml(target: &ServiceTarget) -> String {
    let executable = xml_escape(&target.binary_path.to_string_lossy());
    let arguments = xml_escape(&render_task_arguments(target));
    let user = xml_escape(&target.current_user.name);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n<Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\r\n  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>\r\n  <Principals><Principal id=\"Author\"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\r\n  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings>\r\n  <Actions Context=\"Author\"><Exec><Command>{executable}</Command><Arguments>{arguments}</Arguments></Exec></Actions>\r\n</Task>\r\n"
    )
}

fn render_task_identity(target: &ServiceTarget) -> String {
    [
        target.binary_path.to_string_lossy().into_owned(),
        render_task_arguments(target),
        "InteractiveToken".to_owned(),
    ]
    .join("\u{1f}")
}

fn render_task_arguments(target: &ServiceTarget) -> String {
    format!(
        "serve --host {} --port {} --base-dir {} --no-browser --managed-service-mode {}",
        windows_quote(&target.bind.ip().to_string()),
        target.bind.port(),
        windows_quote(&target.data_root.to_string_lossy()),
        target.mode,
    )
}

fn render_service_command_line(target: &ServiceTarget) -> String {
    [
        windows_quote(&target.binary_path.to_string_lossy()),
        "service-host".to_owned(),
        "--host".to_owned(),
        windows_quote(&target.bind.ip().to_string()),
        "--port".to_owned(),
        target.bind.port().to_string(),
        "--base-dir".to_owned(),
        windows_quote(&target.data_root.to_string_lossy()),
        "--no-browser".to_owned(),
        "--managed-service-mode".to_owned(),
        target.mode.to_string(),
    ]
    .join(" ")
}

#[cfg(windows)]
mod host {
    use std::{
        ffi::{OsStr, OsString, c_void},
        sync::{
            Mutex, OnceLock,
            atomic::{AtomicPtr, Ordering},
        },
    };

    use clap::Parser;
    use tokio_util::sync::CancellationToken;
    use windows_sys::Win32::System::Services::{
        RegisterServiceCtrlHandlerW, SERVICE_ACCEPT_SHUTDOWN, SERVICE_ACCEPT_STOP,
        SERVICE_CONTROL_SHUTDOWN, SERVICE_CONTROL_STOP, SERVICE_RUNNING, SERVICE_START_PENDING,
        SERVICE_STATUS, SERVICE_STATUS_HANDLE, SERVICE_STOP_PENDING, SERVICE_STOPPED,
        SERVICE_TABLE_ENTRYW, SERVICE_WIN32_OWN_PROCESS, SetServiceStatus,
        StartServiceCtrlDispatcherW,
    };

    use crate::{
        Cli, ServerRuntime,
        service::{ServiceError, ServiceMode},
    };

    const SERVICE_NAME: &str = "BiBCode";
    const SERVICE_WAIT_HINT_MS: u32 = 40_000;
    static STATUS_HANDLE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
    static STOP_TOKEN: OnceLock<Mutex<Option<CancellationToken>>> = OnceLock::new();

    pub(crate) fn requested() -> bool {
        std::env::args_os()
            .nth(1)
            .is_some_and(|argument| argument == OsStr::new("service-host"))
    }

    pub(crate) fn run() -> Result<(), ServiceError> {
        let mut service_name = SERVICE_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let entries = [
            SERVICE_TABLE_ENTRYW {
                lpServiceName: service_name.as_mut_ptr(),
                lpServiceProc: Some(service_main),
            },
            SERVICE_TABLE_ENTRYW::default(),
        ];
        // SAFETY: the table and its nul-terminated service name remain alive for the entire
        // blocking dispatcher call, and `service_main` uses the required system ABI.
        let started = unsafe { StartServiceCtrlDispatcherW(entries.as_ptr()) };
        if started == 0 {
            return Err(ServiceError::WindowsServiceHost(
                std::io::Error::last_os_error().to_string(),
            ));
        }
        Ok(())
    }

    unsafe extern "system" fn service_main(_argc: u32, _argv: *mut *mut u16) {
        let mut service_name = SERVICE_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // SAFETY: the name is nul terminated and the handler has the required system ABI.
        let status_handle = unsafe {
            RegisterServiceCtrlHandlerW(service_name.as_mut_ptr(), Some(service_control_handler))
        };
        if status_handle.is_null() {
            return;
        }
        STATUS_HANDLE.store(status_handle, Ordering::Release);
        report_status(SERVICE_START_PENDING, 0, 1, SERVICE_WAIT_HINT_MS);

        let result = run_service_runtime();
        let exit_code = if result.is_ok() { 0 } else { 1 };
        report_status(SERVICE_STOPPED, exit_code, 0, 0);
        STATUS_HANDLE.store(std::ptr::null_mut(), Ordering::Release);
        if let Some(slot) = STOP_TOKEN.get() {
            *slot.lock().expect("Windows service stop token mutex") = None;
        }
    }

    unsafe extern "system" fn service_control_handler(control: u32) {
        if matches!(control, SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN) {
            report_status(SERVICE_STOP_PENDING, 0, 1, SERVICE_WAIT_HINT_MS);
            if let Some(slot) = STOP_TOKEN.get()
                && let Some(token) = slot
                    .lock()
                    .expect("Windows service stop token mutex")
                    .as_ref()
            {
                token.cancel();
            }
        }
    }

    fn run_service_runtime() -> Result<(), ServiceError> {
        let mut arguments = std::env::args_os().collect::<Vec<OsString>>();
        if arguments.get(1) != Some(&OsString::from("service-host")) {
            return Err(ServiceError::WindowsServiceHost(
                "the service host command line was invalid".to_owned(),
            ));
        }
        arguments[1] = OsString::from("serve");
        let config = Cli::try_parse_from(arguments)
            .map_err(|error| ServiceError::WindowsServiceHost(error.to_string()))?
            .into_server_config()
            .map_err(|error| ServiceError::WindowsServiceHost(error.to_string()))?
            .with_service_managed_launch(ServiceMode::Headless);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| ServiceError::WindowsServiceHost(error.to_string()))?;
        runtime.block_on(async move {
            let handle = ServerRuntime::start_standalone(config)
                .await
                .map_err(|error| ServiceError::WindowsServiceHost(error.to_string()))?;
            let stop = CancellationToken::new();
            *STOP_TOKEN
                .get_or_init(|| Mutex::new(None))
                .lock()
                .expect("Windows service stop token mutex") = Some(stop.clone());
            report_status(SERVICE_RUNNING, 0, 0, 0);
            tokio::select! {
                () = stop.cancelled() => handle.shutdown(),
                () = handle.wait_for_shutdown() => {}
            }
            report_status(SERVICE_STOP_PENDING, 0, 1, SERVICE_WAIT_HINT_MS);
            handle
                .join()
                .await
                .map_err(|error| ServiceError::WindowsServiceHost(error.to_string()))
        })
    }

    fn report_status(state: u32, exit_code: u32, checkpoint: u32, wait_hint: u32) {
        let handle: SERVICE_STATUS_HANDLE = STATUS_HANDLE.load(Ordering::Acquire);
        if handle.is_null() {
            return;
        }
        let status = SERVICE_STATUS {
            dwServiceType: SERVICE_WIN32_OWN_PROCESS,
            dwCurrentState: state,
            dwControlsAccepted: if state == SERVICE_RUNNING {
                SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
            } else {
                0
            },
            dwWin32ExitCode: exit_code,
            dwServiceSpecificExitCode: 0,
            dwCheckPoint: checkpoint,
            dwWaitHint: wait_hint,
        };
        // SAFETY: the handle was returned by RegisterServiceCtrlHandlerW and remains valid until
        // service_main returns; `status` is initialized for the duration of this call.
        unsafe {
            SetServiceStatus(handle, &status);
        }
    }
}

#[cfg(windows)]
pub(crate) use host::{
    requested as windows_service_host_requested, run as run_windows_service_host,
};

fn windows_quote(value: &str) -> String {
    if !value
        .chars()
        .any(|character| character.is_whitespace() || character == '"')
    {
        return value.to_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                quoted.push(character);
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn windows_account_matches(observed: &str, expected: &str) -> bool {
    observed.eq_ignore_ascii_case(expected)
        || observed
            .rsplit_once('\\')
            .is_some_and(|(_, account)| account.eq_ignore_ascii_case(expected))
}
