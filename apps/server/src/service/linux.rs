use std::path::PathBuf;

use super::model::{
    CommandOutput, CommandSpec, CommandStep, ServiceError, ServiceMode, ServicePlatform,
    ServiceState, ServiceStatus, ServiceTarget,
};

const SERVICE_NAME: &str = "bibcode.service";
const HEADLESS_ACCOUNT: &str = "bibcode";

#[derive(Clone, Debug)]
pub(crate) struct LinuxAdapter {
    target: ServiceTarget,
    unit_path: PathBuf,
    definition: String,
}

impl LinuxAdapter {
    pub(crate) fn new(target: ServiceTarget) -> Result<Self, ServiceError> {
        target.validate(ServicePlatform::Linux)?;
        let unit_path = match target.mode {
            ServiceMode::Workstation => target
                .current_user
                .home_dir
                .join(".config/systemd/user")
                .join(SERVICE_NAME),
            ServiceMode::Headless => PathBuf::from("/etc/systemd/system").join(SERVICE_NAME),
        };
        let definition = render_unit(&target);
        Ok(Self {
            target,
            unit_path,
            definition,
        })
    }

    pub(crate) fn target(&self) -> &ServiceTarget {
        &self.target
    }

    pub(crate) fn definition(&self) -> &str {
        &self.definition
    }

    pub(crate) fn startup_owner(&self) -> &'static str {
        match self.target.mode {
            ServiceMode::Workstation => "systemd-user",
            ServiceMode::Headless => "systemd-system",
        }
    }

    pub(crate) fn account(&self) -> &str {
        match self.target.mode {
            ServiceMode::Workstation => &self.target.current_user.name,
            ServiceMode::Headless => HEADLESS_ACCOUNT,
        }
    }

    pub(crate) fn status_commands(&self) -> Vec<CommandSpec> {
        let mut manager_args = self.systemctl_prefix();
        manager_args.extend([
            "show".to_owned(),
            SERVICE_NAME.to_owned(),
            "--property=LoadState".to_owned(),
            "--property=ActiveState".to_owned(),
            "--property=SubState".to_owned(),
            "--property=UnitFileState".to_owned(),
            "--no-pager".to_owned(),
        ]);
        let mut commands = vec![
            CommandSpec::new("systemctl", manager_args),
            CommandSpec::new("cat", [self.unit_path.to_string_lossy().into_owned()]),
        ];
        if self.target.mode == ServiceMode::Workstation {
            commands.push(CommandSpec::new(
                "loginctl",
                [
                    "show-user".to_owned(),
                    self.target.current_user.name.clone(),
                    "--property=Linger".to_owned(),
                    "--value".to_owned(),
                ],
            ));
        }
        commands
    }

    pub(crate) fn parse_status(
        &self,
        outputs: &[CommandOutput],
    ) -> Result<ServiceStatus, ServiceError> {
        let expected = if self.target.mode == ServiceMode::Workstation {
            3
        } else {
            2
        };
        if outputs.len() != expected {
            return Err(ServiceError::InvalidManagerResponse(
                "systemd status returned an unexpected response count".to_owned(),
            ));
        }
        let properties = parse_properties(&outputs[0].stdout);
        let load_state_missing = properties
            .iter()
            .any(|(key, value)| *key == "LoadState" && *value == "not-found");
        let manager_error = outputs[0].stderr.to_ascii_lowercase();
        let missing = load_state_missing
            || (outputs[0].exit_code == 4
                && (manager_error.contains("not found")
                    || manager_error.contains("could not be found")));
        if outputs[0].exit_code != 0 && !missing {
            if manager_error.contains("access denied")
                || manager_error.contains("permission denied")
                || manager_error.contains("interactive authentication required")
            {
                return Err(ServiceError::InsufficientAuthority);
            }
            return Err(ServiceError::InvalidManagerResponse(
                "systemctl could not inspect the selected service".to_owned(),
            ));
        }
        if !missing && outputs[1].exit_code != 0 {
            let definition_error = outputs[1].stderr.to_ascii_lowercase();
            if definition_error.contains("access denied")
                || definition_error.contains("permission denied")
            {
                return Err(ServiceError::InsufficientAuthority);
            }
        }
        let active = property(&properties, "ActiveState").unwrap_or_default();
        let sub = property(&properties, "SubState").unwrap_or_default();
        let state = if missing {
            ServiceState::NotInstalled
        } else {
            match (active, sub) {
                ("active", "running") => ServiceState::Running,
                ("activating", _) => ServiceState::Starting,
                ("deactivating", _) => ServiceState::Stopping,
                ("failed", _) => ServiceState::Failed,
                _ => ServiceState::Stopped,
            }
        };
        let enabled = !missing
            && matches!(
                property(&properties, "UnitFileState"),
                Some("enabled" | "enabled-runtime" | "static")
            );
        let linger_enabled = if self.target.mode == ServiceMode::Workstation {
            match outputs[2].stdout.trim() {
                "yes" => Some(true),
                "no" | "" => Some(false),
                _ if outputs[2].exit_code != 0 => None,
                _ => {
                    return Err(ServiceError::InvalidManagerResponse(
                        "loginctl returned an invalid linger state".to_owned(),
                    ));
                }
            }
        } else {
            None
        };
        Ok(self.status(
            state,
            enabled,
            !missing && outputs[1].exit_code == 0 && outputs[1].stdout == self.definition,
            linger_enabled,
        ))
    }

    pub(crate) fn authority_command(&self) -> Option<CommandSpec> {
        (self.target.mode == ServiceMode::Headless).then(|| CommandSpec::new("id", ["-u"]))
    }

    pub(crate) fn account_probe(&self) -> Option<CommandSpec> {
        (self.target.mode == ServiceMode::Headless)
            .then(|| CommandSpec::new("id", ["-u", HEADLESS_ACCOUNT]))
    }

    pub(crate) fn account_create_step(&self) -> Option<CommandStep> {
        (self.target.mode == ServiceMode::Headless).then(|| {
            CommandStep::checked(CommandSpec::new(
                "/usr/sbin/useradd",
                [
                    "--system".to_owned(),
                    "--user-group".to_owned(),
                    "--home-dir".to_owned(),
                    self.target.data_root.to_string_lossy().into_owned(),
                    "--shell".to_owned(),
                    "/usr/sbin/nologin".to_owned(),
                    HEADLESS_ACCOUNT.to_owned(),
                ],
            ))
            .with_rollback(CommandSpec::new("/usr/sbin/userdel", [HEADLESS_ACCOUNT]))
        })
    }

    pub(crate) fn install_steps(&self, update: bool) -> Vec<CommandStep> {
        let unit_path = self.unit_path.to_string_lossy().into_owned();
        let temporary_path = format!("{unit_path}.new");
        let backup_path = format!("{unit_path}.bibcode-backup");
        let parent = self
            .unit_path
            .parent()
            .expect("unit path has a parent")
            .to_string_lossy()
            .into_owned();
        let mut steps = Vec::new();
        if self.target.mode == ServiceMode::Workstation {
            steps.push(CommandStep::checked(CommandSpec::new(
                "mkdir",
                ["-p", parent.as_str()],
            )));
        } else {
            steps.push(CommandStep::checked(CommandSpec::new(
                "install",
                [
                    "-d".to_owned(),
                    "-m".to_owned(),
                    "0750".to_owned(),
                    "-o".to_owned(),
                    HEADLESS_ACCOUNT.to_owned(),
                    "-g".to_owned(),
                    HEADLESS_ACCOUNT.to_owned(),
                    self.target.data_root.to_string_lossy().into_owned(),
                    self.target
                        .data_root
                        .join("logs")
                        .to_string_lossy()
                        .into_owned(),
                    self.target
                        .data_root
                        .join("userdata/run")
                        .to_string_lossy()
                        .into_owned(),
                ],
            )));
        }
        if update {
            steps.push(
                CommandStep::checked(CommandSpec::new(
                    "cp",
                    ["--", unit_path.as_str(), backup_path.as_str()],
                ))
                .with_rollback(CommandSpec::new("rm", ["-f", backup_path.as_str()])),
            );
        }
        steps.push(
            CommandStep::checked(
                CommandSpec::new("tee", [temporary_path.as_str()])
                    .with_stdin(self.definition.as_bytes().to_vec()),
            )
            .with_rollback(CommandSpec::new("rm", ["-f", temporary_path.as_str()])),
        );
        steps.push(CommandStep::checked(CommandSpec::new(
            "chmod",
            ["0644", temporary_path.as_str()],
        )));
        let move_step = CommandStep::checked(CommandSpec::new(
            "mv",
            ["-f", temporary_path.as_str(), unit_path.as_str()],
        ));
        steps.push(if update {
            let mut rollback_reload = self.systemctl_prefix();
            rollback_reload.push("daemon-reload".to_owned());
            let mut rollback_restart = self.systemctl_prefix();
            rollback_restart.extend(["restart".to_owned(), SERVICE_NAME.to_owned()]);
            move_step.with_rollbacks([
                CommandSpec::new("cp", ["--", backup_path.as_str(), unit_path.as_str()]),
                CommandSpec::new("systemctl", rollback_reload),
                CommandSpec::new("systemctl", rollback_restart),
                CommandSpec::new("rm", ["-f", backup_path.as_str()]),
            ])
        } else {
            move_step.with_rollback(CommandSpec::new("rm", ["-f", unit_path.as_str()]))
        });
        let mut reload = self.systemctl_prefix();
        reload.push("daemon-reload".to_owned());
        steps.push(CommandStep::checked(CommandSpec::new("systemctl", reload)));
        if update {
            let mut enable = self.systemctl_prefix();
            enable.extend(["enable".to_owned(), SERVICE_NAME.to_owned()]);
            steps.push(CommandStep::checked(CommandSpec::new("systemctl", enable)));
            steps.push(CommandStep::checked(self.systemctl_command("restart")));
        } else {
            let mut enable = self.systemctl_prefix();
            enable.extend([
                "enable".to_owned(),
                "--now".to_owned(),
                SERVICE_NAME.to_owned(),
            ]);
            let mut disable = self.systemctl_prefix();
            disable.extend([
                "disable".to_owned(),
                "--now".to_owned(),
                SERVICE_NAME.to_owned(),
            ]);
            steps.push(
                CommandStep::checked(CommandSpec::new("systemctl", enable))
                    .with_rollback(CommandSpec::new("systemctl", disable)),
            );
        }
        steps
    }

    pub(crate) fn finalize_install_steps(&self, update: bool) -> Vec<CommandStep> {
        if !update {
            return Vec::new();
        }
        let backup_path = format!("{}.bibcode-backup", self.unit_path.to_string_lossy());
        vec![CommandStep::checked(CommandSpec::new(
            "rm",
            ["-f", backup_path.as_str()],
        ))]
    }

    pub(crate) fn start_steps(&self) -> Vec<CommandStep> {
        vec![CommandStep::checked(self.systemctl_command("start"))]
    }

    pub(crate) fn stop_steps(&self) -> Vec<CommandStep> {
        vec![CommandStep::checked(self.systemctl_command("stop"))]
    }

    pub(crate) fn uninstall_steps(&self) -> Vec<CommandStep> {
        let mut disable = self.systemctl_prefix();
        disable.extend([
            "disable".to_owned(),
            "--now".to_owned(),
            SERVICE_NAME.to_owned(),
        ]);
        let mut reload = self.systemctl_prefix();
        reload.push("daemon-reload".to_owned());
        vec![
            CommandStep::checked(CommandSpec::new("systemctl", disable)).accepting([0, 1, 5]),
            CommandStep::checked(CommandSpec::new(
                "rm",
                ["-f", self.unit_path.to_string_lossy().as_ref()],
            )),
            CommandStep::checked(CommandSpec::new("systemctl", reload)),
        ]
    }

    fn systemctl_prefix(&self) -> Vec<String> {
        match self.target.mode {
            ServiceMode::Workstation => vec!["--user".to_owned()],
            ServiceMode::Headless => Vec::new(),
        }
    }

    fn systemctl_command(&self, action: &str) -> CommandSpec {
        let mut args = self.systemctl_prefix();
        args.extend([action.to_owned(), SERVICE_NAME.to_owned()]);
        CommandSpec::new("systemctl", args)
    }

    fn status(
        &self,
        state: ServiceState,
        enabled: bool,
        definition_matches: bool,
        linger_enabled: Option<bool>,
    ) -> ServiceStatus {
        ServiceStatus {
            mode: self.target.mode,
            state,
            startup_owner: self.startup_owner().to_owned(),
            account: self.account().to_owned(),
            binary_path: self.target.binary_path.clone(),
            data_root: self.target.data_root.clone(),
            bind: self.target.bind,
            control_endpoint: self.target.control_endpoint(ServicePlatform::Linux),
            enabled,
            definition_matches,
            linger_enabled,
        }
    }
}

fn render_unit(target: &ServiceTarget) -> String {
    let account = match target.mode {
        ServiceMode::Workstation => None,
        ServiceMode::Headless => Some(HEADLESS_ACCOUNT),
    };
    let mut service = String::new();
    if let Some(account) = account {
        service.push_str(&format!("User={account}\nGroup={account}\n"));
    }
    let executable = systemd_quote(&target.binary_path.to_string_lossy());
    let data_root = systemd_quote(&target.data_root.to_string_lossy());
    let host = target.bind.ip().to_string();
    service.push_str(&format!(
        "ExecStart={executable} serve --host {host} --port {} --base-dir {data_root} --no-browser --managed-service-mode {}\n",
        target.bind.port(),
        target.mode,
    ));
    service.push_str(&format!("WorkingDirectory={data_root}\n"));
    let install_target = match target.mode {
        ServiceMode::Workstation => "default.target",
        ServiceMode::Headless => "multi-user.target",
    };
    format!(
        "[Unit]\nDescription=BiBCode Server\nAfter=network.target\n\n[Service]\nType=simple\n{service}Restart=on-failure\nRestartSec=2s\nTimeoutStopSec=40s\nKillMode=mixed\nNoNewPrivileges=true\nUMask=0077\n\n[Install]\nWantedBy={install_target}\n"
    )
}

fn systemd_quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "$$")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

fn parse_properties(value: &str) -> Vec<(&str, &str)> {
    value
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect()
}

fn property<'a>(properties: &'a [(&str, &str)], key: &str) -> Option<&'a str> {
    properties
        .iter()
        .find_map(|(candidate, value)| (*candidate == key).then_some(*value))
}

#[cfg(test)]
mod tests {
    use std::{
        net::{IpAddr, Ipv4Addr, SocketAddr},
        path::PathBuf,
    };

    use super::*;
    use crate::service::NativeUser;

    #[test]
    fn definition_update_reloads_enables_and_restarts_the_running_unit() {
        let adapter = LinuxAdapter::new(ServiceTarget {
            mode: ServiceMode::Workstation,
            binary_path: PathBuf::from("/opt/bibcode/bin/bibcode"),
            data_root: PathBuf::from("/home/alice/.bibcode"),
            bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
            current_user: NativeUser {
                name: "alice".to_owned(),
                numeric_id: Some(1000),
                home_dir: PathBuf::from("/home/alice"),
            },
        })
        .expect("Linux adapter");

        let commands = adapter
            .install_steps(true)
            .into_iter()
            .map(|step| step.command)
            .collect::<Vec<_>>();

        assert!(commands.iter().any(|command| {
            command.program == "systemctl"
                && command.args == ["--user", "enable", "bibcode.service"]
        }));
        assert!(commands.iter().any(|command| {
            command.program == "systemctl"
                && command.args == ["--user", "restart", "bibcode.service"]
        }));
    }
}
