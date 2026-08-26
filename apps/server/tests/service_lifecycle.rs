use std::{
    collections::VecDeque,
    future::Future,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
};

use bibcode_server::service::{
    CommandFailure, CommandOutput, CommandRunner, CommandSpec, NativeUser, ServiceAdapter,
    ServiceManager, ServiceMode, ServiceState, ServiceTarget,
};

#[derive(Clone, Default)]
struct FakeCommandRunner {
    commands: Arc<Mutex<Vec<CommandSpec>>>,
    outcomes: Arc<Mutex<VecDeque<Result<CommandOutput, CommandFailure>>>>,
}

impl FakeCommandRunner {
    fn with_outcomes(
        outcomes: impl IntoIterator<Item = Result<CommandOutput, CommandFailure>>,
    ) -> Self {
        Self {
            commands: Arc::default(),
            outcomes: Arc::new(Mutex::new(outcomes.into_iter().collect())),
        }
    }

    fn commands(&self) -> Vec<CommandSpec> {
        self.commands.lock().expect("commands lock").clone()
    }
}

impl CommandRunner for FakeCommandRunner {
    fn run(
        &self,
        command: CommandSpec,
    ) -> Pin<Box<dyn Future<Output = Result<CommandOutput, CommandFailure>> + Send + 'static>> {
        self.commands.lock().expect("commands lock").push(command);
        let outcome = self
            .outcomes
            .lock()
            .expect("outcomes lock")
            .pop_front()
            .expect("scripted command outcome");
        Box::pin(async move { outcome })
    }
}

fn success(stdout: impl Into<String>) -> Result<CommandOutput, CommandFailure> {
    Ok(CommandOutput {
        exit_code: 0,
        stdout: stdout.into(),
        stderr: String::new(),
    })
}

fn exit(exit_code: i32, stderr: impl Into<String>) -> Result<CommandOutput, CommandFailure> {
    Ok(CommandOutput {
        exit_code,
        stdout: String::new(),
        stderr: stderr.into(),
    })
}

fn linux_workstation_target() -> ServiceTarget {
    ServiceTarget {
        mode: ServiceMode::Workstation,
        binary_path: PathBuf::from("/opt/bibcode/bin/bibcode"),
        data_root: PathBuf::from("/home/alice/.bibcode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "alice".to_owned(),
            numeric_id: Some(1000),
            home_dir: PathBuf::from("/home/alice"),
        },
    }
}

#[tokio::test]
async fn linux_workstation_status_reports_runtime_definition_and_linger_separately() {
    let target = linux_workstation_target();
    let adapter = ServiceAdapter::linux(target.clone()).expect("Linux adapter");
    let definition = adapter.rendered_definition();
    let runner = FakeCommandRunner::with_outcomes([
        success("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n"),
        success(definition),
        success("no\n"),
    ]);
    let manager = ServiceManager::new(runner.clone());

    let status = manager.status(&adapter).await.expect("service status");

    assert_eq!(status.mode, ServiceMode::Workstation);
    assert_eq!(status.state, ServiceState::Running);
    assert_eq!(status.startup_owner, "systemd-user");
    assert_eq!(status.account, "alice");
    assert_eq!(status.binary_path, target.binary_path);
    assert_eq!(status.data_root, target.data_root);
    assert_eq!(status.bind, target.bind);
    assert_eq!(
        status.control_endpoint,
        "/home/alice/.bibcode/userdata/run/control.sock"
    );
    assert_eq!(status.linger_enabled, Some(false));
    assert!(status.definition_matches);

    assert_eq!(
        runner.commands(),
        vec![
            CommandSpec::new(
                "systemctl",
                [
                    "--user",
                    "show",
                    "bibcode.service",
                    "--property=LoadState",
                    "--property=ActiveState",
                    "--property=SubState",
                    "--property=UnitFileState",
                    "--no-pager",
                ],
            ),
            CommandSpec::new("cat", ["/home/alice/.config/systemd/user/bibcode.service"],),
            CommandSpec::new(
                "loginctl",
                ["show-user", "alice", "--property=Linger", "--value"],
            ),
        ]
    );
}

#[tokio::test]
async fn windows_workstation_status_uses_a_logon_task_without_a_stored_password() {
    let target = ServiceTarget {
        mode: ServiceMode::Workstation,
        binary_path: PathBuf::from(r"C:\Program Files\BiBCode\bibcode.exe"),
        data_root: PathBuf::from(r"C:\Users\Alice\.bibcode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "Alice".to_owned(),
            numeric_id: None,
            home_dir: PathBuf::from(r"C:\Users\Alice"),
        },
    };
    let adapter = ServiceAdapter::windows(target).expect("Windows adapter");
    let definition = adapter.rendered_definition();
    let identity = adapter.definition_identity();
    let runner = FakeCommandRunner::with_outcomes([success(format!(
        "{{\"installed\":true,\"state\":\"Running\",\"definition\":{},\"account\":\"WORKSTATION\\\\Alice\",\"enabled\":true}}",
        serde_json::to_string(&identity).expect("identity JSON")
    ))]);
    let manager = ServiceManager::new(runner.clone());

    let status = manager
        .status(&adapter)
        .await
        .expect("scheduled task status");

    assert_eq!(status.state, ServiceState::Running);
    assert_eq!(status.startup_owner, "task-scheduler-logon");
    assert_eq!(status.account, "Alice");
    assert!(status.definition_matches);
    assert!(definition.contains("<LogonType>InteractiveToken</LogonType>"));
    assert!(!definition.contains("<Password>"));
    let commands = runner.commands();
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].program, "powershell.exe");
    assert_eq!(
        commands[0].args[0..4],
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
    );
    assert!(commands[0].args[4].contains("Get-ScheduledTask"));
    assert!(commands[0].stdin.is_none());
}

#[tokio::test]
async fn macos_headless_install_rejects_insufficient_authority_before_mutation() {
    let target = ServiceTarget {
        mode: ServiceMode::Headless,
        binary_path: PathBuf::from("/usr/local/libexec/bibcode"),
        data_root: PathBuf::from("/var/lib/bibcode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "alice".to_owned(),
            numeric_id: Some(501),
            home_dir: PathBuf::from("/Users/alice"),
        },
    };
    let adapter = ServiceAdapter::macos(target).expect("macOS adapter");
    let runner = FakeCommandRunner::with_outcomes([
        Ok(CommandOutput {
            exit_code: 113,
            stdout: String::new(),
            stderr: "Could not find service".to_owned(),
        }),
        Ok(CommandOutput {
            exit_code: 1,
            stdout: String::new(),
            stderr: "No such file".to_owned(),
        }),
        success("501\n"),
    ]);
    let manager = ServiceManager::new(runner.clone());

    let error = manager
        .install(&adapter, false)
        .await
        .expect_err("headless install must require elevation");

    assert_eq!(error.code(), "insufficient_authority");
    let commands = runner.commands();
    assert_eq!(commands.len(), 3);
    assert_eq!(commands[2], CommandSpec::new("id", ["-u"]));
    assert!(
        commands.iter().all(|command| command.program != "launchctl"
            || command.args.first().map(String::as_str) == Some("print")),
        "no mutating launchctl command may run before authority succeeds"
    );
}

#[tokio::test]
async fn adapters_distinguish_missing_stopped_failed_and_running_services() {
    let linux_target = ServiceTarget {
        mode: ServiceMode::Headless,
        ..linux_workstation_target()
    };
    let linux = ServiceAdapter::linux(linux_target).expect("Linux adapter");
    let linux_definition = linux.rendered_definition();
    let stopped_runner = FakeCommandRunner::with_outcomes([
        success("LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n"),
        success(linux_definition.clone()),
    ]);
    let stopped = ServiceManager::new(stopped_runner)
        .status(&linux)
        .await
        .expect("stopped system unit");
    assert_eq!(stopped.state, ServiceState::Stopped);
    assert!(!stopped.enabled);

    let failed_runner = FakeCommandRunner::with_outcomes([
        success("LoadState=loaded\nActiveState=failed\nSubState=failed\nUnitFileState=enabled\n"),
        success(linux_definition),
    ]);
    let failed = ServiceManager::new(failed_runner)
        .status(&linux)
        .await
        .expect("failed system unit");
    assert_eq!(failed.state, ServiceState::Failed);

    let mac_target = ServiceTarget {
        mode: ServiceMode::Workstation,
        binary_path: PathBuf::from("/Applications/BiBCode.app/Contents/MacOS/bibcode"),
        data_root: PathBuf::from("/Users/alice/.bibcode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "alice".to_owned(),
            numeric_id: Some(501),
            home_dir: PathBuf::from("/Users/alice"),
        },
    };
    let mac = ServiceAdapter::macos(mac_target).expect("macOS adapter");
    let missing_runner = FakeCommandRunner::with_outcomes([
        exit(113, "Could not find service"),
        exit(1, "No such file"),
    ]);
    let missing = ServiceManager::new(missing_runner)
        .status(&mac)
        .await
        .expect("missing LaunchAgent");
    assert_eq!(missing.state, ServiceState::NotInstalled);

    let failed_runner = FakeCommandRunner::with_outcomes([
        success("state = waiting\nlast exit code = 78\n"),
        success(mac.rendered_definition()),
    ]);
    let failed = ServiceManager::new(failed_runner)
        .status(&mac)
        .await
        .expect("failed LaunchAgent");
    assert_eq!(failed.state, ServiceState::Failed);
}

#[tokio::test]
async fn windows_headless_status_reports_the_dedicated_virtual_service_account() {
    let target = ServiceTarget {
        mode: ServiceMode::Headless,
        binary_path: PathBuf::from(r"C:\Program Files\BiBCode\bibcode.exe"),
        data_root: PathBuf::from(r"C:\ProgramData\BiBCode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "Administrator".to_owned(),
            numeric_id: None,
            home_dir: PathBuf::from(r"C:\Users\Administrator"),
        },
    };
    let adapter = ServiceAdapter::windows(target).expect("Windows adapter");
    let runner = FakeCommandRunner::with_outcomes([success(format!(
        "{{\"installed\":true,\"state\":\"Running\",\"definition\":{},\"account\":\"NT SERVICE\\\\BiBCode\",\"enabled\":true}}",
        serde_json::to_string(&adapter.rendered_definition()).expect("definition JSON")
    ))]);

    let status = ServiceManager::new(runner)
        .status(&adapter)
        .await
        .expect("Windows Service status");

    assert_eq!(status.state, ServiceState::Running);
    assert_eq!(status.startup_owner, "windows-service");
    assert_eq!(status.account, r"NT SERVICE\BiBCode");
    assert!(status.enabled);
    assert!(status.definition_matches);
}

#[tokio::test]
async fn windows_logon_task_reports_disabled_and_missing_without_guessing() {
    let target = ServiceTarget {
        mode: ServiceMode::Workstation,
        binary_path: PathBuf::from(r"C:\Program Files\BiBCode\bibcode.exe"),
        data_root: PathBuf::from(r"C:\Users\Alice\.bibcode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "Alice".to_owned(),
            numeric_id: None,
            home_dir: PathBuf::from(r"C:\Users\Alice"),
        },
    };
    let adapter = ServiceAdapter::windows(target).expect("Windows adapter");
    let disabled_runner = FakeCommandRunner::with_outcomes([success(format!(
        "{{\"installed\":true,\"state\":\"Disabled\",\"definition\":{},\"account\":\"Alice\",\"enabled\":false}}",
        serde_json::to_string(&adapter.definition_identity()).expect("identity JSON")
    ))]);
    let disabled = ServiceManager::new(disabled_runner)
        .status(&adapter)
        .await
        .expect("disabled task");
    assert_eq!(disabled.state, ServiceState::Stopped);
    assert!(!disabled.enabled);
    assert!(disabled.definition_matches);

    let missing_runner = FakeCommandRunner::with_outcomes([success(
        r#"{"installed":false,"state":"NotInstalled","definition":""}"#,
    )]);
    let missing = ServiceManager::new(missing_runner)
        .status(&adapter)
        .await
        .expect("missing task");
    assert_eq!(missing.state, ServiceState::NotInstalled);
    assert!(!missing.definition_matches);
}

#[tokio::test]
async fn matching_install_is_idempotent_and_mismatch_requires_explicit_update() {
    let adapter = ServiceAdapter::linux(linux_workstation_target()).expect("Linux adapter");
    let definition = adapter.rendered_definition();
    let idempotent_runner = FakeCommandRunner::with_outcomes([
        success("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n"),
        success(definition),
        success("no\n"),
    ]);
    let status = ServiceManager::new(idempotent_runner.clone())
        .install(&adapter, false)
        .await
        .expect("matching install is idempotent");
    assert_eq!(status.state, ServiceState::Running);
    assert_eq!(idempotent_runner.commands().len(), 3);

    let mismatch_runner = FakeCommandRunner::with_outcomes([
        success("LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=enabled\n"),
        success("[Unit]\nDescription=Some other service\n"),
        success("no\n"),
    ]);
    let error = ServiceManager::new(mismatch_runner.clone())
        .install(&adapter, false)
        .await
        .expect_err("mismatched install requires update");
    assert_eq!(error.code(), "definition_mismatch");
    assert_eq!(mismatch_runner.commands().len(), 3);
}

#[tokio::test]
async fn update_requested_for_a_missing_service_uses_the_clean_install_path() {
    let adapter = ServiceAdapter::linux(linux_workstation_target()).expect("Linux adapter");
    let definition = adapter.rendered_definition();
    let mut outcomes = Vec::from([
        Ok(CommandOutput {
            exit_code: 4,
            stdout:
                "LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n"
                    .to_owned(),
            stderr: "Unit bibcode.service could not be found".to_owned(),
        }),
        exit(1, "No such file"),
        success("no\n"),
    ]);
    outcomes.extend((0..6).map(|_| success("")));
    outcomes.extend([
        success("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n"),
        success(definition),
        success("no\n"),
    ]);
    let runner = FakeCommandRunner::with_outcomes(outcomes);

    let result = ServiceManager::new(runner.clone())
        .install_report(&adapter, true)
        .await
        .expect("missing service follows clean install semantics");

    assert!(result.changed);
    assert_eq!(result.status.state, ServiceState::Running);
    let commands = runner.commands();
    assert!(commands.iter().all(|command| command.program != "cp"));
    assert!(commands.iter().any(|command| {
        command.program == "systemctl"
            && command.args == ["--user", "enable", "--now", "bibcode.service"]
    }));
    assert!(commands.iter().all(|command| {
        !(command.program == "systemctl"
            && command.args == ["--user", "restart", "bibcode.service"])
    }));
}

#[tokio::test]
async fn partial_install_rolls_back_created_metadata_but_never_the_data_root() {
    let target = linux_workstation_target();
    let adapter = ServiceAdapter::linux(target.clone()).expect("Linux adapter");
    let runner = FakeCommandRunner::with_outcomes([
        Ok(CommandOutput {
            exit_code: 4,
            stdout:
                "LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n"
                    .to_owned(),
            stderr: "Unit bibcode.service could not be found".to_owned(),
        }),
        exit(1, "No such file"),
        success("no\n"),
        success(""),
        success(""),
        exit(13, "permission denied"),
        success(""),
        success(""),
    ]);
    let manager = ServiceManager::new(runner.clone());

    let error = manager
        .install(&adapter, false)
        .await
        .expect_err("partial install must fail");

    assert_eq!(error.code(), "command_failed");
    let commands = runner.commands();
    assert!(commands.iter().any(|command| {
        command.program == "rm"
            && command
                .args
                .iter()
                .any(|argument| argument.ends_with("bibcode.service.new"))
    }));
    assert!(commands.iter().all(|command| {
        !(command.program == "rm"
            && command
                .args
                .iter()
                .any(|argument| argument == target.data_root.to_string_lossy().as_ref()))
    }));
    assert!(commands.iter().all(|command| {
        command.program != "systemctl" || !command.args.iter().any(|argument| argument == "enable")
    }));
}

#[tokio::test]
async fn command_timeout_is_typed_and_bounded() {
    let adapter = ServiceAdapter::linux(linux_workstation_target()).expect("Linux adapter");
    let runner = FakeCommandRunner::with_outcomes([Err(CommandFailure::Timeout)]);

    let error = ServiceManager::new(runner)
        .status(&adapter)
        .await
        .expect_err("timed out status");

    assert_eq!(error.code(), "timeout");
}

#[tokio::test(start_paused = true)]
async fn lifecycle_verification_waits_through_transitional_manager_state() {
    let adapter = ServiceAdapter::linux(linux_workstation_target()).expect("Linux adapter");
    let definition = adapter.rendered_definition();
    let runner = FakeCommandRunner::with_outcomes([
        success("LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=enabled\n"),
        success(definition.clone()),
        success("no\n"),
        success(""),
        success(
            "LoadState=loaded\nActiveState=activating\nSubState=start\nUnitFileState=enabled\n",
        ),
        success(definition.clone()),
        success("no\n"),
        success("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n"),
        success(definition),
        success("no\n"),
    ]);

    let status = ServiceManager::new(runner)
        .start(&adapter)
        .await
        .expect("start waits for running state");

    assert_eq!(status.state, ServiceState::Running);
}

#[tokio::test]
async fn manager_permission_errors_are_not_misreported_as_missing_services() {
    let target = ServiceTarget {
        mode: ServiceMode::Headless,
        ..linux_workstation_target()
    };
    let adapter = ServiceAdapter::linux(target).expect("Linux adapter");
    let runner = FakeCommandRunner::with_outcomes([
        exit(1, "Failed to connect to bus: Access denied"),
        exit(13, "Permission denied"),
    ]);

    let error = ServiceManager::new(runner)
        .status(&adapter)
        .await
        .expect_err("authority failure must stay explicit");

    assert_eq!(error.code(), "insufficient_authority");

    let mac_target = ServiceTarget {
        mode: ServiceMode::Headless,
        binary_path: PathBuf::from("/usr/local/libexec/bibcode"),
        data_root: PathBuf::from("/var/lib/bibcode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "alice".to_owned(),
            numeric_id: Some(501),
            home_dir: PathBuf::from("/Users/alice"),
        },
    };
    let mac = ServiceAdapter::macos(mac_target).expect("macOS adapter");
    let runner = FakeCommandRunner::with_outcomes([
        exit(1, "Operation not permitted"),
        exit(13, "Permission denied"),
    ]);
    let error = ServiceManager::new(runner)
        .status(&mac)
        .await
        .expect_err("launchd authority failure must stay explicit");
    assert_eq!(error.code(), "insufficient_authority");
}

#[tokio::test]
async fn uninstall_removes_only_registration_and_preserves_the_exact_data_root() {
    let target = linux_workstation_target();
    let adapter = ServiceAdapter::linux(target.clone()).expect("Linux adapter");
    let definition = adapter.rendered_definition();
    let runner = FakeCommandRunner::with_outcomes([
        success("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n"),
        success(definition),
        success("no\n"),
        success(""),
        success(""),
        success(""),
        Ok(CommandOutput {
            exit_code: 4,
            stdout: "LoadState=not-found\n".to_owned(),
            stderr: "Unit not found".to_owned(),
        }),
        exit(1, "No such file"),
        success("no\n"),
    ]);
    let manager = ServiceManager::new(runner.clone());

    let status = manager
        .uninstall(&adapter)
        .await
        .expect("uninstall service registration");

    assert_eq!(status.state, ServiceState::NotInstalled);
    assert_eq!(status.data_root, target.data_root);
    assert!(runner.commands().iter().all(|command| {
        !command.args.iter().any(|argument| {
            argument == target.data_root.to_string_lossy().as_ref()
                || argument.starts_with(&format!("{}/", target.data_root.to_string_lossy()))
        })
    }));
}

#[tokio::test]
async fn macos_workstation_install_writes_an_exact_launchagent_then_bootstraps_user_domain() {
    let target = ServiceTarget {
        mode: ServiceMode::Workstation,
        binary_path: PathBuf::from("/Applications/BiBCode.app/Contents/MacOS/bibcode"),
        data_root: PathBuf::from("/Users/alice/Library/Application Support/BiBCode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "alice".to_owned(),
            numeric_id: Some(501),
            home_dir: PathBuf::from("/Users/alice"),
        },
    };
    let adapter = ServiceAdapter::macos(target).expect("macOS adapter");
    let definition = adapter.rendered_definition();
    let mut outcomes = Vec::from([exit(113, "Could not find service"), exit(1, "No such file")]);
    outcomes.extend((0..8).map(|_| success("")));
    outcomes.extend([success("state = running\n"), success(definition.clone())]);
    let runner = FakeCommandRunner::with_outcomes(outcomes);

    let status = ServiceManager::new(runner.clone())
        .install(&adapter, false)
        .await
        .expect("install LaunchAgent");

    assert_eq!(status.state, ServiceState::Running);
    assert_eq!(status.startup_owner, "launch-agent");
    let commands = runner.commands();
    let write = commands
        .iter()
        .find(|command| command.program == "tee")
        .expect("atomic plist staging write");
    assert_eq!(write.stdin.as_deref(), Some(definition.as_bytes()));
    assert!(write.args[0].ends_with("Library/LaunchAgents/com.bibcode.server.plist.new"));
    assert!(commands.iter().any(|command| {
        command.program == "launchctl"
            && command.args
                == [
                    "bootstrap",
                    "gui/501",
                    "/Users/alice/Library/LaunchAgents/com.bibcode.server.plist",
                ]
    }));
    assert!(definition.contains("<key>RunAtLoad</key>"));
    assert!(definition.contains("<key>KeepAlive</key>\n  <false/>"));
}

#[tokio::test]
async fn windows_workstation_install_registers_exact_interactive_task_xml_over_stdin() {
    let target = ServiceTarget {
        mode: ServiceMode::Workstation,
        binary_path: PathBuf::from(r"C:\Program Files\BiBCode\bibcode.exe"),
        data_root: PathBuf::from(r"C:\Users\Alice\.bibcode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "Alice".to_owned(),
            numeric_id: None,
            home_dir: PathBuf::from(r"C:\Users\Alice"),
        },
    };
    let adapter = ServiceAdapter::windows(target).expect("Windows adapter");
    let definition = adapter.rendered_definition();
    let identity = adapter.definition_identity();
    let runner = FakeCommandRunner::with_outcomes([
        success(r#"{"installed":false,"state":"NotInstalled","definition":""}"#),
        success(""),
        success(""),
        success(format!(
            "{{\"installed\":true,\"state\":\"Running\",\"definition\":{},\"account\":\"Alice\",\"enabled\":true}}",
            serde_json::to_string(&identity).expect("identity JSON")
        )),
    ]);

    let status = ServiceManager::new(runner.clone())
        .install(&adapter, false)
        .await
        .expect("install logon task");

    assert_eq!(status.state, ServiceState::Running);
    let commands = runner.commands();
    assert_eq!(commands[1].program, "powershell.exe");
    assert!(commands[1].args[4].contains("Register-ScheduledTask"));
    assert_eq!(commands[1].stdin.as_deref(), Some(definition.as_bytes()));
    assert_eq!(
        commands[2],
        CommandSpec::new("schtasks.exe", ["/Run", "/TN", "BiBCode"])
    );
    assert!(!definition.contains("<Password>"));
    assert!(definition.contains("<LogonType>InteractiveToken</LogonType>"));
}

#[tokio::test]
async fn linux_headless_install_creates_and_rolls_ownership_only_for_a_missing_account() {
    let target = ServiceTarget {
        mode: ServiceMode::Headless,
        binary_path: PathBuf::from("/usr/local/libexec/bibcode"),
        data_root: PathBuf::from("/var/lib/bibcode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "root".to_owned(),
            numeric_id: Some(0),
            home_dir: PathBuf::from("/root"),
        },
    };
    let adapter = ServiceAdapter::linux(target).expect("Linux adapter");
    let definition = adapter.rendered_definition();
    let mut outcomes = Vec::from([
        Ok(CommandOutput {
            exit_code: 4,
            stdout: "LoadState=not-found\n".to_owned(),
            stderr: "Unit not found".to_owned(),
        }),
        exit(1, "No such file"),
        success("0\n"),
        exit(1, "no such user"),
        success(""),
    ]);
    outcomes.extend((0..6).map(|_| success("")));
    outcomes.extend([
        success("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n"),
        success(definition.clone()),
    ]);
    let runner = FakeCommandRunner::with_outcomes(outcomes);

    let result = ServiceManager::new(runner.clone())
        .install_report(&adapter, false)
        .await
        .expect("install headless systemd service");

    assert!(result.changed);
    assert!(result.account_created);
    let status = result.status;
    assert_eq!(status.state, ServiceState::Running);
    assert_eq!(status.account, "bibcode");
    let commands = runner.commands();
    let useradd = commands
        .iter()
        .find(|command| command.program == "/usr/sbin/useradd")
        .expect("dedicated account creation");
    assert_eq!(
        useradd.args,
        [
            "--system",
            "--user-group",
            "--home-dir",
            "/var/lib/bibcode",
            "--shell",
            "/usr/sbin/nologin",
            "bibcode",
        ]
    );
    assert!(commands.iter().any(|command| {
        command.program == "systemctl" && command.args == ["enable", "--now", "bibcode.service"]
    }));
    assert!(definition.contains("User=bibcode\nGroup=bibcode\n"));
    assert!(definition.contains("WantedBy=multi-user.target"));
}

#[tokio::test]
async fn windows_headless_install_uses_a_virtual_service_identity_and_no_password() {
    let target = ServiceTarget {
        mode: ServiceMode::Headless,
        binary_path: PathBuf::from(r"C:\Program Files\BiBCode\bibcode.exe"),
        data_root: PathBuf::from(r"C:\ProgramData\BiBCode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "Administrator".to_owned(),
            numeric_id: None,
            home_dir: PathBuf::from(r"C:\Users\Administrator"),
        },
    };
    let adapter = ServiceAdapter::windows(target).expect("Windows adapter");
    let definition = adapter.rendered_definition();
    let mut outcomes = Vec::from([
        success(r#"{"installed":false,"state":"NotInstalled","definition":""}"#),
        success("true\n"),
    ]);
    outcomes.extend((0..4).map(|_| success("")));
    outcomes.push(success(format!(
        "{{\"installed\":true,\"state\":\"Running\",\"definition\":{},\"account\":\"NT SERVICE\\\\BiBCode\",\"enabled\":true}}",
        serde_json::to_string(&definition).expect("definition JSON")
    )));
    let runner = FakeCommandRunner::with_outcomes(outcomes);

    let status = ServiceManager::new(runner.clone())
        .install(&adapter, false)
        .await
        .expect("install Windows Service");

    assert_eq!(status.account, r"NT SERVICE\BiBCode");
    assert!(definition.contains(" service-host "));
    let commands = runner.commands();
    let create = commands
        .iter()
        .find(|command| {
            command.program == "sc.exe"
                && command.args.first().map(String::as_str) == Some("create")
        })
        .expect("SCM create command");
    assert!(
        create
            .args
            .windows(2)
            .any(|args| args == ["obj=", r"NT SERVICE\BiBCode"])
    );
    assert!(!create.args.iter().any(|argument| argument == "password="));
    assert!(commands.iter().any(|command| {
        command.program == "icacls.exe"
            && command
                .args
                .iter()
                .any(|argument| argument == r"NT SERVICE\BiBCode:(OI)(CI)M")
    }));
}

#[tokio::test]
async fn macos_headless_install_creates_a_disabled_service_account_and_launchdaemon() {
    let target = ServiceTarget {
        mode: ServiceMode::Headless,
        binary_path: PathBuf::from("/usr/local/libexec/bibcode"),
        data_root: PathBuf::from("/var/lib/bibcode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "root".to_owned(),
            numeric_id: Some(0),
            home_dir: PathBuf::from("/var/root"),
        },
    };
    let adapter = ServiceAdapter::macos(target).expect("macOS adapter");
    let definition = adapter.rendered_definition();
    let mut outcomes = Vec::from([
        exit(113, "Could not find service"),
        exit(1, "No such file"),
        success("0\n"),
        exit(1, "no such user"),
        success(""),
    ]);
    outcomes.extend((0..7).map(|_| success("")));
    outcomes.extend([success("state = running\n"), success(definition.clone())]);
    let runner = FakeCommandRunner::with_outcomes(outcomes);

    let status = ServiceManager::new(runner.clone())
        .install(&adapter, false)
        .await
        .expect("install LaunchDaemon");

    assert_eq!(status.startup_owner, "launch-daemon");
    assert_eq!(status.account, "_bibcode");
    let commands = runner.commands();
    let account = commands
        .iter()
        .find(|command| command.program == "/bin/sh")
        .expect("bounded account creation command");
    assert_eq!(account.args[0..2], ["-eu", "-c"]);
    assert!(account.args[2].contains("AuthenticationAuthority ';DisabledUser;'"));
    assert!(commands.iter().any(|command| {
        command.program == "launchctl"
            && command.args
                == [
                    "bootstrap",
                    "system",
                    "/Library/LaunchDaemons/com.bibcode.server.plist",
                ]
    }));
    assert!(definition.contains("<key>UserName</key>\n  <string>_bibcode</string>"));
    assert!(definition.matches("<string>/dev/null</string>").count() >= 2);
}

#[test]
fn service_targets_reject_definition_control_character_injection() {
    let mut target = linux_workstation_target();
    target.data_root = PathBuf::from("/home/alice/.bibcode\nExecStart=/tmp/attacker");
    let error = ServiceAdapter::linux(target).expect_err("unit directive injection must fail");
    assert_eq!(error.code(), "invalid_target");

    let mut target = linux_workstation_target();
    target.current_user.name = "alice\r\nUser=root".to_owned();
    let error = ServiceAdapter::linux(target).expect_err("account injection must fail");
    assert_eq!(error.code(), "invalid_target");
}

#[tokio::test]
async fn failed_headless_install_removes_only_an_account_created_by_that_attempt() {
    let target = ServiceTarget {
        mode: ServiceMode::Headless,
        binary_path: PathBuf::from("/usr/local/libexec/bibcode"),
        data_root: PathBuf::from("/var/lib/bibcode"),
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        current_user: NativeUser {
            name: "root".to_owned(),
            numeric_id: Some(0),
            home_dir: PathBuf::from("/root"),
        },
    };
    let adapter = ServiceAdapter::linux(target).expect("Linux adapter");
    let missing_status = Ok(CommandOutput {
        exit_code: 4,
        stdout: "LoadState=not-found\n".to_owned(),
        stderr: "Unit not found".to_owned(),
    });
    let created_runner = FakeCommandRunner::with_outcomes([
        missing_status.clone(),
        exit(1, "No such file"),
        success("0\n"),
        exit(1, "no such user"),
        success(""),
        success(""),
        exit(13, "write rejected"),
        success(""),
        success(""),
    ]);
    let error = ServiceManager::new(created_runner.clone())
        .install(&adapter, false)
        .await
        .expect_err("install failure");
    assert_eq!(error.code(), "command_failed");
    assert!(
        created_runner.commands().iter().any(|command| {
            command.program == "/usr/sbin/userdel" && command.args == ["bibcode"]
        })
    );

    let existing_runner = FakeCommandRunner::with_outcomes([
        missing_status,
        exit(1, "No such file"),
        success("0\n"),
        success("997\n"),
        success(""),
        exit(13, "write rejected"),
        success(""),
    ]);
    let error = ServiceManager::new(existing_runner.clone())
        .install(&adapter, false)
        .await
        .expect_err("install failure with pre-existing account");
    assert_eq!(error.code(), "command_failed");
    assert!(
        existing_runner
            .commands()
            .iter()
            .all(|command| command.program != "/usr/sbin/userdel"),
        "rollback must never delete an account it did not create"
    );
}

#[tokio::test]
async fn failed_definition_update_restores_reloads_and_restarts_the_previous_unit() {
    let adapter = ServiceAdapter::linux(linux_workstation_target()).expect("Linux adapter");
    let definition = adapter.rendered_definition();
    let mut outcomes = Vec::from([
        success("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n"),
        success("[Unit]\nDescription=previous definition\n"),
        success("no\n"),
    ]);
    outcomes.extend((0..8).map(|_| success("")));
    outcomes.extend([
        success("LoadState=loaded\nActiveState=failed\nSubState=failed\nUnitFileState=enabled\n"),
        success(definition),
        success("no\n"),
    ]);
    outcomes.extend((0..6).map(|_| success("")));
    let runner = FakeCommandRunner::with_outcomes(outcomes);

    let error = ServiceManager::new(runner.clone())
        .install(&adapter, true)
        .await
        .expect_err("failed updated unit must roll back");

    assert_eq!(error.code(), "verification_failed");
    let commands = runner.commands();
    let restore = commands
        .iter()
        .position(|command| {
            command.program == "cp"
                && command.args
                    == [
                        "--",
                        "/home/alice/.config/systemd/user/bibcode.service.bibcode-backup",
                        "/home/alice/.config/systemd/user/bibcode.service",
                    ]
        })
        .expect("restore previous definition");
    assert!(
        commands[restore + 1]
            .args
            .iter()
            .any(|argument| argument == "daemon-reload")
    );
    assert!(
        commands[restore + 2]
            .args
            .iter()
            .any(|argument| argument == "restart")
    );
    assert!(commands[restore + 3].args[1].ends_with(".bibcode-backup"));
}
