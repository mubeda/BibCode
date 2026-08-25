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
pub(crate) struct MacOsRemoteHostAdapter;

impl MacOsRemoteHostAdapter {
    fn command<I, S>(purpose: RemoteCommandPurpose, program: &str, arguments: I) -> RemoteCommand
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        RemoteCommand::standard(purpose, program, arguments)
            .expect("macOS adapter commands are repository-owned constants")
    }
}

impl RemoteHostAdapter for MacOsRemoteHostAdapter {
    fn os(&self) -> RemoteHostOs {
        RemoteHostOs::MacOs
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
            Self::command(
                RemoteCommandPurpose::PackageInstaller,
                "/usr/sbin/installer",
                ["-help"],
            ),
            Self::command(
                RemoteCommandPurpose::PortableExtractor,
                "tar",
                ["--version"],
            ),
            Self::command(RemoteCommandPurpose::Sha256, "shasum", ["--version"]),
        ]
    }

    fn parse_probe(&self, outputs: &[RemoteCommandOutput]) -> Result<RemoteHostProbe, String> {
        if successful_output(outputs, RemoteCommandPurpose::Kernel)?.trim() != "Darwin" {
            return Err("The selected SSH host is not macOS.".to_string());
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
                "macOS remote provisioning requires shasum for post-transfer verification."
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
            deb_installer: false,
            rpm_installer: false,
            package_installer: command_succeeded(outputs, RemoteCommandPurpose::PackageInstaller),
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
            os: RemoteHostOs::MacOs,
            architecture,
            installed_version,
            service_mode,
            service_state,
            data_root,
            control_available: service_state == RemoteServiceState::Running,
            free_bytes,
            install_authority,
            install_base: format!(
                "{}/Library/Application Support/BiBCode Server",
                home.trim_end_matches('/')
            ),
            system_install_base: "/Library/Application Support/BiBCode Server".to_string(),
            headless_data_root: "/Library/Application Support/BiBCode".to_string(),
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
            && probe.capabilities.package_installer
        {
            vec![ArtifactFormat::Pkg]
        } else if probe.capabilities.portable_extractor {
            vec![ArtifactFormat::TarGz]
        } else {
            Vec::new()
        }
    }

    fn stage_commands(&self, input: &VerifiedArtifact) -> Result<Vec<RemoteCommand>, String> {
        if input.os != RemoteHostOs::MacOs {
            return Err("The macOS adapter cannot stage a non-macOS artifact.".to_string());
        }
        validate_posix_path(&input.remote_path, "artifact staging path")?;
        let parent = parent_path(&input.remote_path, '/')?;
        let metadata = serde_json::to_vec(&json!({
            "remotePath": input.remote_path,
            "size": input.size,
            "sha256": input.sha256,
        }))
        .map_err(|error| format!("Could not encode macOS transfer metadata: {error}"))?;
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
                "shasum",
                [
                    "-a".to_string(),
                    "256".to_string(),
                    "--".to_string(),
                    input.remote_path.clone(),
                ],
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
            return Err("macOS headless setup requires a portable server artifact.".to_string());
        }
        match verified.format {
            ArtifactFormat::Pkg => {
                if input.authority != RemoteInstallAuthority::NoninteractiveAdministrator {
                    return Err(
                        "The selected macOS package requires noninteractive administrator authority."
                            .to_string(),
                    );
                }
                Ok(vec![
                    RemoteCommand::standard(
                        RemoteCommandPurpose::Install,
                        "sudo",
                        [
                            "-n".to_string(),
                            "/usr/sbin/installer".to_string(),
                            "-pkg".to_string(),
                            verified.remote_path.clone(),
                            "-target".to_string(),
                            "/".to_string(),
                        ],
                    )?
                    .with_timeout(REMOTE_INSTALL_COMMAND_TIMEOUT)?,
                ])
            }
            ArtifactFormat::TarGz => atomic_posix_tar_install_commands(input, "shasum"),
            _ => Err("The macOS adapter received an unsupported artifact format.".to_string()),
        }
    }

    fn service_commands(&self, input: &StagedArtifact) -> Result<Vec<RemoteCommand>, String> {
        validate_posix_path(&input.installed_binary_path, "installed binary")?;
        validate_posix_path(&input.verified.data_root, "data root")?;
        let mut arguments = vec!["service".to_string(), "install".to_string()];
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
                    "macOS headless service installation requires noninteractive administrator authority."
                        .to_string(),
                );
            }
            let mut elevated = vec!["-n".to_string(), input.installed_binary_path.clone()];
            elevated.extend(arguments);
            Ok(vec![
                RemoteCommand::standard(RemoteCommandPurpose::Service, "sudo", elevated)?
                    .with_timeout(REMOTE_SERVICE_COMMAND_TIMEOUT)?,
            ])
        } else {
            Ok(vec![
                RemoteCommand::standard(
                    RemoteCommandPurpose::Service,
                    input.installed_binary_path.clone(),
                    arguments,
                )?
                .with_timeout(REMOTE_SERVICE_COMMAND_TIMEOUT)?,
            ])
        }
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
