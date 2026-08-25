use std::path::PathBuf;

use super::model::{
    CommandOutput, CommandSpec, CommandStep, ServiceError, ServiceMode, ServicePlatform,
    ServiceState, ServiceStatus, ServiceTarget,
};

const LABEL: &str = "com.bibcode.server";
const HEADLESS_ACCOUNT: &str = "_bibcode";

#[derive(Clone, Debug)]
pub(crate) struct MacOsAdapter {
    target: ServiceTarget,
    plist_path: PathBuf,
    domain: String,
    definition: String,
}

impl MacOsAdapter {
    pub(crate) fn new(target: ServiceTarget) -> Result<Self, ServiceError> {
        target.validate(ServicePlatform::MacOs)?;
        let uid = target
            .current_user
            .numeric_id
            .expect("validated macOS numeric identity");
        let (plist_path, domain) = match target.mode {
            ServiceMode::Workstation => (
                target
                    .current_user
                    .home_dir
                    .join("Library/LaunchAgents")
                    .join(format!("{LABEL}.plist")),
                format!("gui/{uid}"),
            ),
            ServiceMode::Headless => (
                PathBuf::from("/Library/LaunchDaemons").join(format!("{LABEL}.plist")),
                "system".to_owned(),
            ),
        };
        let definition = render_plist(&target);
        Ok(Self {
            target,
            plist_path,
            domain,
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
            ServiceMode::Workstation => "launch-agent",
            ServiceMode::Headless => "launch-daemon",
        }
    }

    pub(crate) fn account(&self) -> &str {
        match self.target.mode {
            ServiceMode::Workstation => &self.target.current_user.name,
            ServiceMode::Headless => HEADLESS_ACCOUNT,
        }
    }

    pub(crate) fn status_commands(&self) -> Vec<CommandSpec> {
        vec![
            CommandSpec::new(
                "launchctl",
                ["print".to_owned(), format!("{}/{LABEL}", self.domain)],
            ),
            CommandSpec::new("cat", [self.plist_path.to_string_lossy().into_owned()]),
        ]
    }

    pub(crate) fn parse_status(
        &self,
        outputs: &[CommandOutput],
    ) -> Result<ServiceStatus, ServiceError> {
        if outputs.len() != 2 {
            return Err(ServiceError::InvalidManagerResponse(
                "launchd status returned an unexpected response count".to_owned(),
            ));
        }
        let missing = outputs[0].exit_code != 0
            && (outputs[0].stderr.contains("Could not find service")
                || outputs[0].stderr.contains("service not found")
                || outputs[0].exit_code == 113);
        let manager_error = outputs[0].stderr.to_ascii_lowercase();
        let stdout = &outputs[0].stdout;
        let state = if missing {
            ServiceState::NotInstalled
        } else if outputs[0].exit_code != 0 {
            if manager_error.contains("not permitted")
                || manager_error.contains("permission denied")
                || manager_error.contains("access denied")
            {
                return Err(ServiceError::InsufficientAuthority);
            }
            return Err(ServiceError::InvalidManagerResponse(
                "launchctl could not inspect the selected service".to_owned(),
            ));
        } else if stdout.lines().any(|line| line.trim() == "state = running") {
            ServiceState::Running
        } else if stdout.lines().any(|line| {
            let line = line.trim();
            line.starts_with("last exit code = ") && !line.ends_with(" = 0")
        }) {
            ServiceState::Failed
        } else {
            ServiceState::Stopped
        };
        if !missing && outputs[1].exit_code != 0 {
            let definition_error = outputs[1].stderr.to_ascii_lowercase();
            if definition_error.contains("not permitted")
                || definition_error.contains("permission denied")
                || definition_error.contains("access denied")
            {
                return Err(ServiceError::InsufficientAuthority);
            }
        }
        Ok(self.status(
            state,
            !missing,
            !missing && outputs[1].exit_code == 0 && outputs[1].stdout == self.definition,
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
            let script = concat!(
                "name='_bibcode'\n",
                "if /usr/bin/id -u \"$name\" >/dev/null 2>&1; then exit 0; fi\n",
                "uid=299\n",
                "while /usr/bin/dscl . -search /Users UniqueID \"$uid\" | /usr/bin/grep -q .; do uid=$((uid-1)); ",
                "if [ \"$uid\" -lt 200 ]; then exit 73; fi; done\n",
                "/usr/bin/dscl . -create /Users/\"$name\"\n",
                "/usr/bin/dscl . -create /Users/\"$name\" RealName 'BiBCode Service'\n",
                "/usr/bin/dscl . -create /Users/\"$name\" UniqueID \"$uid\"\n",
                "/usr/bin/dscl . -create /Users/\"$name\" PrimaryGroupID -2\n",
                "/usr/bin/dscl . -create /Users/\"$name\" NFSHomeDirectory /var/empty\n",
                "/usr/bin/dscl . -create /Users/\"$name\" UserShell /usr/bin/false\n",
                "/usr/bin/dscl . -create /Users/\"$name\" IsHidden 1\n",
                "/usr/bin/dscl . -create /Users/\"$name\" AuthenticationAuthority ';DisabledUser;'\n",
            );
            CommandStep::checked(CommandSpec::new("/bin/sh", ["-eu", "-c", script]))
                .with_rollback(CommandSpec::new(
                    "/usr/bin/dscl",
                    [".", "-delete", "/Users/_bibcode"],
                ))
        })
    }

    pub(crate) fn install_steps(&self, update: bool) -> Vec<CommandStep> {
        let plist_path = self.plist_path.to_string_lossy().into_owned();
        let temporary_path = format!("{plist_path}.new");
        let backup_path = format!("{plist_path}.bibcode-backup");
        let parent = self
            .plist_path
            .parent()
            .expect("plist has a parent")
            .to_string_lossy()
            .into_owned();
        let mut steps = Vec::new();
        if self.target.mode == ServiceMode::Workstation {
            steps.push(CommandStep::checked(CommandSpec::new(
                "mkdir",
                ["-p", parent.as_str()],
            )));
            steps.push(CommandStep::checked(CommandSpec::new(
                "mkdir",
                [
                    "-p".to_owned(),
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
        } else {
            steps.push(CommandStep::checked(CommandSpec::new(
                "install",
                [
                    "-d".to_owned(),
                    "-m".to_owned(),
                    "0700".to_owned(),
                    "-o".to_owned(),
                    HEADLESS_ACCOUNT.to_owned(),
                    "-g".to_owned(),
                    "wheel".to_owned(),
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
                    ["--", plist_path.as_str(), backup_path.as_str()],
                ))
                .with_rollback(CommandSpec::new("rm", ["-f", backup_path.as_str()])),
            );
            let service_target = format!("{}/{LABEL}", self.domain);
            steps.push(
                CommandStep::checked(CommandSpec::new(
                    "launchctl",
                    ["bootout", service_target.as_str()],
                ))
                .accepting([0, 3, 113])
                .with_rollbacks([
                    CommandSpec::new(
                        "launchctl",
                        ["bootstrap", self.domain.as_str(), plist_path.as_str()],
                    ),
                    CommandSpec::new("launchctl", ["enable", service_target.as_str()]),
                    CommandSpec::new("launchctl", ["kickstart", "-k", service_target.as_str()]),
                ]),
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
        steps.push(
            CommandStep::checked(CommandSpec::new(
                "mv",
                ["-f", temporary_path.as_str(), plist_path.as_str()],
            ))
            .with_rollback(if update {
                CommandSpec::new("cp", ["--", backup_path.as_str(), plist_path.as_str()])
            } else {
                CommandSpec::new("rm", ["-f", plist_path.as_str()])
            }),
        );
        steps.push(
            CommandStep::checked(CommandSpec::new(
                "launchctl",
                [
                    "bootstrap".to_owned(),
                    self.domain.clone(),
                    plist_path.clone(),
                ],
            ))
            .with_rollback(CommandSpec::new(
                "launchctl",
                ["bootout".to_owned(), format!("{}/{LABEL}", self.domain)],
            )),
        );
        steps.extend(self.start_steps());
        steps
    }

    pub(crate) fn finalize_install_steps(&self, update: bool) -> Vec<CommandStep> {
        if !update {
            return Vec::new();
        }
        let backup_path = format!("{}.bibcode-backup", self.plist_path.to_string_lossy());
        vec![CommandStep::checked(CommandSpec::new(
            "rm",
            ["-f", backup_path.as_str()],
        ))]
    }

    pub(crate) fn start_steps(&self) -> Vec<CommandStep> {
        let target = format!("{}/{LABEL}", self.domain);
        vec![
            CommandStep::checked(CommandSpec::new("launchctl", ["enable", target.as_str()])),
            CommandStep::checked(CommandSpec::new(
                "launchctl",
                ["kickstart", "-k", target.as_str()],
            )),
        ]
    }

    pub(crate) fn stop_steps(&self) -> Vec<CommandStep> {
        vec![
            CommandStep::checked(CommandSpec::new(
                "launchctl",
                [
                    "kill".to_owned(),
                    "SIGTERM".to_owned(),
                    format!("{}/{LABEL}", self.domain),
                ],
            ))
            .accepting([0, 3, 113]),
        ]
    }

    pub(crate) fn uninstall_steps(&self) -> Vec<CommandStep> {
        vec![
            CommandStep::checked(CommandSpec::new(
                "launchctl",
                ["bootout".to_owned(), format!("{}/{LABEL}", self.domain)],
            ))
            .accepting([0, 3, 113]),
            CommandStep::checked(CommandSpec::new(
                "rm",
                ["-f", self.plist_path.to_string_lossy().as_ref()],
            )),
        ]
    }

    fn status(
        &self,
        state: ServiceState,
        enabled: bool,
        definition_matches: bool,
    ) -> ServiceStatus {
        ServiceStatus {
            mode: self.target.mode,
            state,
            startup_owner: self.startup_owner().to_owned(),
            account: self.account().to_owned(),
            binary_path: self.target.binary_path.clone(),
            data_root: self.target.data_root.clone(),
            bind: self.target.bind,
            control_endpoint: self.target.control_endpoint(ServicePlatform::MacOs),
            enabled,
            definition_matches,
            linger_enabled: None,
        }
    }
}

fn render_plist(target: &ServiceTarget) -> String {
    let account = match target.mode {
        ServiceMode::Workstation => String::new(),
        ServiceMode::Headless => {
            format!("  <key>UserName</key>\n  <string>{HEADLESS_ACCOUNT}</string>\n")
        }
    };
    let arguments = [
        target.binary_path.to_string_lossy().into_owned(),
        "serve".to_owned(),
        "--host".to_owned(),
        target.bind.ip().to_string(),
        "--port".to_owned(),
        target.bind.port().to_string(),
        "--base-dir".to_owned(),
        target.data_root.to_string_lossy().into_owned(),
        "--no-browser".to_owned(),
    ]
    .iter()
    .map(|argument| format!("    <string>{}</string>", xml_escape(argument)))
    .collect::<Vec<_>>()
    .join("\n");
    let data_root = xml_escape(&target.data_root.to_string_lossy());
    let stdout = "/dev/null";
    let stderr = "/dev/null";
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n{arguments}\n  </array>\n{account}  <key>WorkingDirectory</key>\n  <string>{data_root}</string>\n  <key>StandardOutPath</key>\n  <string>{stdout}</string>\n  <key>StandardErrorPath</key>\n  <string>{stderr}</string>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <false/>\n  <key>ProcessType</key>\n  <string>Background</string>\n  <key>ThrottleInterval</key>\n  <integer>2</integer>\n  <key>Umask</key>\n  <integer>63</integer>\n</dict>\n</plist>\n"
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
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
    fn definition_update_boots_out_the_loaded_job_before_rebootstrap() {
        let adapter = MacOsAdapter::new(ServiceTarget {
            mode: ServiceMode::Workstation,
            binary_path: PathBuf::from("/Applications/BiBCode.app/Contents/MacOS/bibcode"),
            data_root: PathBuf::from("/Users/alice/.bibcode"),
            bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
            current_user: NativeUser {
                name: "alice".to_owned(),
                numeric_id: Some(501),
                home_dir: PathBuf::from("/Users/alice"),
            },
        })
        .expect("macOS adapter");

        let commands = adapter
            .install_steps(true)
            .into_iter()
            .map(|step| step.command)
            .collect::<Vec<_>>();
        let bootout = commands
            .iter()
            .position(|command| {
                command.program == "launchctl"
                    && command.args.first().map(String::as_str) == Some("bootout")
            })
            .expect("boot out old job");
        let bootstrap = commands
            .iter()
            .position(|command| {
                command.program == "launchctl"
                    && command.args.first().map(String::as_str) == Some("bootstrap")
            })
            .expect("bootstrap updated job");

        assert!(bootout < bootstrap);
    }
}
