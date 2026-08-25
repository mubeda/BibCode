use super::model::{
    ArtifactFormat, DEFAULT_REMOTE_OUTPUT_LIMIT, REMOTE_INSTALL_COMMAND_TIMEOUT,
    REMOTE_SERVICE_COMMAND_TIMEOUT, REMOTE_TRANSFER_COMMAND_TIMEOUT, RemoteCommand,
    RemoteCommandOutput, RemoteCommandPurpose, RemoteHostAdapter, RemoteHostCapabilities,
    RemoteHostOs, RemoteHostProbe, RemoteInstallAuthority, RemoteServiceMode, RemoteServiceState,
    RemoteStdin, StagedArtifact, VerifiedArtifact, atomic_posix_tar_install_commands,
    command_succeeded, normalize_architecture, output_for, parent_path, parse_bibcode_version,
    parse_posix_free_bytes, select_service_status, successful_output, validate_posix_path,
};
use serde_json::json;

#[derive(Clone, Debug, Default)]
pub(crate) struct LinuxRemoteHostAdapter;

impl LinuxRemoteHostAdapter {
    fn command<I, S>(purpose: RemoteCommandPurpose, program: &str, arguments: I) -> RemoteCommand
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        RemoteCommand::standard(purpose, program, arguments)
            .expect("Linux adapter commands are repository-owned constants")
    }

    fn service_command(input: &StagedArtifact, action: &str) -> Result<RemoteCommand, String> {
        validate_posix_path(&input.installed_binary_path, "installed binary")?;
        validate_posix_path(&input.verified.data_root, "data root")?;
        let mut arguments = vec!["service".to_string(), action.to_string()];
        if input.update_existing_service {
            arguments.push("--update".to_string());
        }
        arguments.extend([
            "--mode".to_string(),
            input.service_mode.as_str().to_string(),
            "--format".to_string(),
            "json".to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            input.verified.remote_port.to_string(),
            "--base-dir".to_string(),
            input.verified.data_root.clone(),
        ]);
        if input.service_mode == RemoteServiceMode::Headless {
            if input.authority != RemoteInstallAuthority::NoninteractiveAdministrator {
                return Err(
                    "Linux headless service installation requires noninteractive administrator authority."
                        .to_string(),
                );
            }
            let mut elevated = vec!["-n".to_string(), input.installed_binary_path.clone()];
            elevated.extend(arguments);
            RemoteCommand::standard(RemoteCommandPurpose::Service, "sudo", elevated)?
                .with_timeout(REMOTE_SERVICE_COMMAND_TIMEOUT)
        } else {
            RemoteCommand::standard(
                RemoteCommandPurpose::Service,
                input.installed_binary_path.clone(),
                arguments,
            )?
            .with_timeout(REMOTE_SERVICE_COMMAND_TIMEOUT)
        }
    }
}

impl RemoteHostAdapter for LinuxRemoteHostAdapter {
    fn os(&self) -> RemoteHostOs {
        RemoteHostOs::Linux
    }

    fn probe_commands(&self) -> Vec<RemoteCommand> {
        vec![
            Self::command(RemoteCommandPurpose::Kernel, "uname", ["-s"]),
            Self::command(RemoteCommandPurpose::Architecture, "uname", ["-m"]),
            Self::command(RemoteCommandPurpose::Home, "printenv", ["HOME"]),
            Self::command(RemoteCommandPurpose::FreeSpace, "df", ["-Pk", "."]),
            Self::command(RemoteCommandPurpose::SystemFreeSpace, "df", ["-Pk", "/"]),
            Self::command(
                RemoteCommandPurpose::InstalledVersion,
                "bibcode",
                ["--version"],
            ),
            Self::command(
                RemoteCommandPurpose::WorkstationService,
                "bibcode",
                [
                    "service",
                    "status",
                    "--mode",
                    "workstation",
                    "--format",
                    "json",
                ],
            ),
            Self::command(
                RemoteCommandPurpose::HeadlessService,
                "bibcode",
                [
                    "service", "status", "--mode", "headless", "--format", "json",
                ],
            ),
            Self::command(
                RemoteCommandPurpose::AdministratorAuthority,
                "sudo",
                ["-n", "true"],
            ),
            Self::command(RemoteCommandPurpose::DebInstaller, "dpkg", ["--version"]),
            Self::command(RemoteCommandPurpose::RpmInstaller, "rpm", ["--version"]),
            Self::command(
                RemoteCommandPurpose::PortableExtractor,
                "tar",
                ["--version"],
            ),
            Self::command(RemoteCommandPurpose::Sha256, "sha256sum", ["--version"]),
        ]
    }

    fn parse_probe(&self, outputs: &[RemoteCommandOutput]) -> Result<RemoteHostProbe, String> {
        if successful_output(outputs, RemoteCommandPurpose::Kernel)?.trim() != "Linux" {
            return Err("The selected SSH host is not Linux.".to_string());
        }
        let architecture = normalize_architecture(successful_output(
            outputs,
            RemoteCommandPurpose::Architecture,
        )?)?;
        let home = successful_output(outputs, RemoteCommandPurpose::Home)?
            .trim()
            .to_string();
        validate_posix_path(&home, "home directory")?;
        let free_bytes =
            parse_posix_free_bytes(successful_output(outputs, RemoteCommandPurpose::FreeSpace)?)?
                .min(parse_posix_free_bytes(successful_output(
                    outputs,
                    RemoteCommandPurpose::SystemFreeSpace,
                )?)?);
        if !command_succeeded(outputs, RemoteCommandPurpose::Sha256) {
            return Err(
                "Linux remote provisioning requires sha256sum for post-transfer verification."
                    .to_string(),
            );
        }
        let installed_version = output_for(outputs, RemoteCommandPurpose::InstalledVersion)
            .ok()
            .filter(|output| output.succeeded())
            .and_then(|output| output.stdout_text().ok())
            .and_then(parse_bibcode_version);
        let service = select_service_status(outputs);
        let service_mode = service.as_ref().map(|status| status.mode);
        let service_state = service
            .as_ref()
            .map_or(RemoteServiceState::NotInstalled, |status| status.state);
        let data_root = service
            .as_ref()
            .map(|status| status.data_root.clone())
            .or_else(|| Some(format!("{}/.bibcode", home.trim_end_matches('/'))));
        let binary_path = service.as_ref().map(|status| status.binary_path.clone());
        let bind_port = service.as_ref().map(|status| status.bind_port);
        let capabilities = RemoteHostCapabilities {
            deb_installer: command_succeeded(outputs, RemoteCommandPurpose::DebInstaller),
            rpm_installer: command_succeeded(outputs, RemoteCommandPurpose::RpmInstaller),
            package_installer: false,
            msi_installer: false,
            portable_extractor: command_succeeded(outputs, RemoteCommandPurpose::PortableExtractor),
            sha256: true,
        };
        let administrator =
            command_succeeded(outputs, RemoteCommandPurpose::AdministratorAuthority);
        let install_authority = if administrator {
            RemoteInstallAuthority::NoninteractiveAdministrator
        } else if capabilities.portable_extractor {
            RemoteInstallAuthority::User
        } else {
            RemoteInstallAuthority::AdministratorRequired
        };
        Ok(RemoteHostProbe {
            os: RemoteHostOs::Linux,
            architecture,
            installed_version,
            service_mode,
            service_state,
            data_root,
            control_available: service_state == RemoteServiceState::Running,
            free_bytes,
            install_authority,
            install_base: format!("{}/.local/share/bibcode/server", home.trim_end_matches('/')),
            system_install_base: "/opt/bibcode/server".to_string(),
            headless_data_root: "/var/lib/bibcode".to_string(),
            home,
            binary_path,
            bind_port,
            capabilities,
        })
    }

    fn preferred_formats(&self, probe: &RemoteHostProbe) -> Vec<ArtifactFormat> {
        if probe.installed_version.is_some() {
            if probe.capabilities.portable_extractor {
                vec![ArtifactFormat::TarGz]
            } else {
                Vec::new()
            }
        } else if probe.install_authority == RemoteInstallAuthority::NoninteractiveAdministrator
            && probe.capabilities.deb_installer
        {
            vec![ArtifactFormat::Deb]
        } else if probe.install_authority == RemoteInstallAuthority::NoninteractiveAdministrator
            && probe.capabilities.rpm_installer
        {
            vec![ArtifactFormat::Rpm]
        } else if probe.capabilities.portable_extractor {
            vec![ArtifactFormat::TarGz]
        } else {
            Vec::new()
        }
    }

    fn stage_commands(&self, input: &VerifiedArtifact) -> Result<Vec<RemoteCommand>, String> {
        if input.os != RemoteHostOs::Linux {
            return Err("The Linux adapter cannot stage a non-Linux artifact.".to_string());
        }
        validate_posix_path(&input.remote_path, "artifact staging path")?;
        let parent = parent_path(&input.remote_path, '/')?;
        let metadata = serde_json::to_vec(&json!({
            "remotePath": input.remote_path,
            "size": input.size,
            "sha256": input.sha256,
        }))
        .map_err(|error| format!("Could not encode Linux transfer metadata: {error}"))?;
        Ok(vec![
            RemoteCommand::standard(
                RemoteCommandPurpose::CreateStaging,
                "mkdir",
                ["-p".to_string(), "--".to_string(), parent.clone()],
            )?,
            RemoteCommand::standard(
                RemoteCommandPurpose::CreateStaging,
                "chmod",
                ["700".to_string(), "--".to_string(), parent],
            )?,
            RemoteCommand::new(
                RemoteCommandPurpose::Transfer,
                "dd",
                [
                    format!("of={}", input.remote_path),
                    "bs=65536".to_string(),
                    "conv=fsync".to_string(),
                ],
                RemoteStdin::Artifact {
                    local_path: input.local_path.clone(),
                    metadata,
                    expected_size: input.size,
                },
                REMOTE_TRANSFER_COMMAND_TIMEOUT,
                DEFAULT_REMOTE_OUTPUT_LIMIT,
            )?,
            RemoteCommand::standard(
                RemoteCommandPurpose::Transfer,
                "chmod",
                [
                    "600".to_string(),
                    "--".to_string(),
                    input.remote_path.clone(),
                ],
            )?,
            RemoteCommand::standard(
                RemoteCommandPurpose::VerifyTransfer,
                "sha256sum",
                ["--".to_string(), input.remote_path.clone()],
            )?,
            RemoteCommand::standard(
                RemoteCommandPurpose::VerifyTransferSize,
                "wc",
                ["-c".to_string(), input.remote_path.clone()],
            )?,
        ])
    }

    fn install_commands(&self, input: &StagedArtifact) -> Result<Vec<RemoteCommand>, String> {
        let verified = &input.verified;
        validate_posix_path(&verified.remote_path, "artifact staging path")?;
        validate_posix_path(&verified.install_root, "install root")?;
        if input.service_mode == RemoteServiceMode::Headless
            && verified.format != ArtifactFormat::TarGz
        {
            return Err("Linux headless setup requires a portable server artifact.".to_string());
        }
        let command = match verified.format {
            ArtifactFormat::Deb => {
                if input.authority != RemoteInstallAuthority::NoninteractiveAdministrator {
                    return Err(
                        "The selected DEB requires noninteractive administrator authority."
                            .to_string(),
                    );
                }
                RemoteCommand::standard(
                    RemoteCommandPurpose::Install,
                    "sudo",
                    [
                        "-n".to_string(),
                        "dpkg".to_string(),
                        "-i".to_string(),
                        "--".to_string(),
                        verified.remote_path.clone(),
                    ],
                )?
                .with_timeout(REMOTE_INSTALL_COMMAND_TIMEOUT)?
            }
            ArtifactFormat::Rpm => {
                if input.authority != RemoteInstallAuthority::NoninteractiveAdministrator {
                    return Err(
                        "The selected RPM requires noninteractive administrator authority."
                            .to_string(),
                    );
                }
                RemoteCommand::standard(
                    RemoteCommandPurpose::Install,
                    "sudo",
                    [
                        "-n".to_string(),
                        "rpm".to_string(),
                        "-U".to_string(),
                        "--replacepkgs".to_string(),
                        "--".to_string(),
                        verified.remote_path.clone(),
                    ],
                )?
                .with_timeout(REMOTE_INSTALL_COMMAND_TIMEOUT)?
            }
            ArtifactFormat::TarGz => {
                return atomic_posix_tar_install_commands(input, "sha256sum");
            }
            _ => {
                return Err(
                    "The Linux adapter received an unsupported artifact format.".to_string()
                );
            }
        };
        Ok(vec![command])
    }

    fn service_commands(&self, input: &StagedArtifact) -> Result<Vec<RemoteCommand>, String> {
        Ok(vec![Self::service_command(input, "install")?])
    }

    fn cleanup_commands(
        &self,
        input: &VerifiedArtifact,
        remove_install_root: bool,
    ) -> Result<Vec<RemoteCommand>, String> {
        validate_posix_path(&input.remote_path, "artifact staging path")?;
        let mut commands = vec![RemoteCommand::standard(
            RemoteCommandPurpose::Cleanup,
            "rm",
            [
                "-f".to_string(),
                "--".to_string(),
                input.remote_path.clone(),
            ],
        )?];
        if input.format == ArtifactFormat::TarGz {
            validate_posix_path(&input.install_root, "install root")?;
            let cleanup = [
                "rm".to_string(),
                "-rf".to_string(),
                "--".to_string(),
                format!("{}.staging", input.install_root),
            ];
            commands.push(if input.service_mode == RemoteServiceMode::Headless {
                let mut arguments = vec!["-n".to_string()];
                arguments.extend(cleanup);
                RemoteCommand::standard(RemoteCommandPurpose::Cleanup, "sudo", arguments)?
            } else {
                RemoteCommand::standard(
                    RemoteCommandPurpose::Cleanup,
                    cleanup[0].clone(),
                    cleanup[1..].to_vec(),
                )?
            });
            if remove_install_root {
                let removal = [
                    "rm".to_string(),
                    "-rf".to_string(),
                    "--".to_string(),
                    input.install_root.clone(),
                ];
                commands.push(if input.service_mode == RemoteServiceMode::Headless {
                    let mut arguments = vec!["-n".to_string()];
                    arguments.extend(removal);
                    RemoteCommand::standard(RemoteCommandPurpose::Cleanup, "sudo", arguments)?
                } else {
                    RemoteCommand::standard(
                        RemoteCommandPurpose::Cleanup,
                        removal[0].clone(),
                        removal[1..].to_vec(),
                    )?
                });
            }
        }
        Ok(commands)
    }
}
