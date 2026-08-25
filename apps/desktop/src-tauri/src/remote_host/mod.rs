pub(crate) mod linux;
pub(crate) mod macos;
pub(crate) mod model;
pub(crate) mod windows;

use model::RemoteCommand;

pub(crate) fn render_posix_remote_command(command: &RemoteCommand) -> Result<String, String> {
    if command.program == "sh"
        || command.program == "bash"
        || command
            .arguments
            .first()
            .is_some_and(|argument| argument == "-c")
    {
        return Err("Remote host adapters cannot submit opaque shell scripts.".to_string());
    }
    let mut tokens = Vec::with_capacity(command.arguments.len() + 1);
    tokens.push(quote_posix_token(&command.program));
    tokens.extend(
        command
            .arguments
            .iter()
            .map(|argument| quote_posix_token(argument)),
    );
    Ok(tokens.join(" "))
}

fn quote_posix_token(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::{
        linux::LinuxRemoteHostAdapter,
        macos::MacOsRemoteHostAdapter,
        model::{
            ArtifactFormat, CleanupStatus, MutationStatus, REMOTE_INSTALL_COMMAND_TIMEOUT,
            REMOTE_TRANSFER_COMMAND_TIMEOUT, RemoteCommand, RemoteCommandOutput,
            RemoteCommandPurpose, RemoteHostAdapter, RemoteHostArchitecture, RemoteHostOs,
            RemoteInstallAuthority, RemoteInstallFailure, RemoteInstallStage, RemoteServiceMode,
            RemoteServiceState, RemoteStdin, StagedArtifact, VerifiedArtifact,
        },
        render_posix_remote_command,
        windows::{WindowsRemoteHostAdapter, decode_powershell_command},
    };
    use std::{path::PathBuf, process::Command, time::Duration};

    fn success(purpose: RemoteCommandPurpose, stdout: &str) -> RemoteCommandOutput {
        RemoteCommandOutput::success(purpose, stdout.as_bytes().to_vec())
    }

    fn missing(purpose: RemoteCommandPurpose) -> RemoteCommandOutput {
        RemoteCommandOutput::failure(purpose, 127, b"utility unavailable".to_vec())
    }

    fn service_status(mode: &str, state: &str, binary: &str, root: &str) -> String {
        format!(
            r#"{{"operation":"status","status":{{"mode":"{mode}","state":"{state}","startupOwner":"fixture","account":"dev","binaryPath":"{binary}","dataRoot":"{root}","bind":"127.0.0.1:3773","controlEndpoint":"protected","enabled":true,"definitionMatches":true}},"accountCreated":false,"dataRootPreserved":false,"accountRemovalPerformed":false}}"#
        )
    }

    fn linux_outputs() -> Vec<RemoteCommandOutput> {
        vec![
            success(RemoteCommandPurpose::Kernel, "Linux\n"),
            success(RemoteCommandPurpose::Architecture, "x86_64\n"),
            success(RemoteCommandPurpose::Home, "/home/dev\n"),
            success(
                RemoteCommandPurpose::FreeSpace,
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 100000 1000 99000 1% /home/dev\n",
            ),
            success(
                RemoteCommandPurpose::SystemFreeSpace,
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 100000 2000 98000 2% /\n",
            ),
            success(RemoteCommandPurpose::InstalledVersion, "bibcode 0.4.1\n"),
            success(
                RemoteCommandPurpose::WorkstationService,
                &service_status(
                    "workstation",
                    "running",
                    "/usr/bin/bibcode",
                    "/home/dev/.bibcode",
                ),
            ),
            missing(RemoteCommandPurpose::HeadlessService),
            success(RemoteCommandPurpose::AdministratorAuthority, "ok\n"),
            success(RemoteCommandPurpose::DebInstaller, "Debian dpkg 1.22\n"),
            missing(RemoteCommandPurpose::RpmInstaller),
            success(RemoteCommandPurpose::PortableExtractor, "tar 1.35\n"),
            success(RemoteCommandPurpose::Sha256, "sha256sum 9.5\n"),
        ]
    }

    fn verified_artifact(
        os: RemoteHostOs,
        architecture: RemoteHostArchitecture,
        format: ArtifactFormat,
        remote_path: &str,
        install_root: &str,
        data_root: &str,
    ) -> VerifiedArtifact {
        VerifiedArtifact {
            local_path: PathBuf::from("/tmp/verified-server-artifact"),
            version: "0.4.2".to_string(),
            os,
            architecture,
            format,
            size: 4_096,
            sha256: "a".repeat(64),
            remote_path: remote_path.to_string(),
            install_root: install_root.to_string(),
            data_root: data_root.to_string(),
            service_mode: RemoteServiceMode::Workstation,
            remote_port: 3773,
        }
    }

    #[test]
    fn posix_renderer_round_trips_hostile_values_without_shell_interpolation() {
        let hostile = "space ' quote ; $(printf injected) `printf injected` & value";
        let command = RemoteCommand::new(
            RemoteCommandPurpose::Probe,
            "printf",
            ["%s", hostile],
            RemoteStdin::None,
            Duration::from_secs(5),
            1024,
        )
        .expect("valid command");
        let rendered = render_posix_remote_command(&command).expect("render command");
        let output = Command::new("sh")
            .args(["-c", &rendered])
            .output()
            .expect("run rendered fixture");
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), hostile);
    }

    #[test]
    fn linux_probe_covers_gnu_service_and_noninteractive_authority() {
        let adapter = LinuxRemoteHostAdapter;
        let probe = adapter.parse_probe(&linux_outputs()).expect("Linux probe");
        assert_eq!(adapter.os(), RemoteHostOs::Linux);
        assert_eq!(probe.os, RemoteHostOs::Linux);
        assert_eq!(probe.os.as_manifest_value(), "linux");
        assert_eq!(probe.architecture, RemoteHostArchitecture::X86_64);
        assert_eq!(probe.architecture.as_manifest_value(), "x86_64");
        assert_eq!(probe.installed_version.as_deref(), Some("0.4.1"));
        assert_eq!(probe.service_mode, Some(RemoteServiceMode::Workstation));
        assert_eq!(probe.service_state, RemoteServiceState::Running);
        assert_eq!(probe.data_root.as_deref(), Some("/home/dev/.bibcode"));
        assert!(probe.control_available);
        assert_eq!(probe.free_bytes, 98_000 * 1024);
        assert_eq!(
            probe.install_authority,
            RemoteInstallAuthority::NoninteractiveAdministrator
        );
        assert_eq!(
            adapter.preferred_formats(&probe),
            vec![ArtifactFormat::TarGz]
        );
        let mut clean_install = probe.clone();
        clean_install.installed_version = None;
        assert_eq!(
            adapter.preferred_formats(&clean_install),
            vec![ArtifactFormat::Deb]
        );
        assert_eq!(ArtifactFormat::Deb.as_str(), "deb");

        let staged = StagedArtifact::from_verified(
            verified_artifact(
                RemoteHostOs::Linux,
                RemoteHostArchitecture::X86_64,
                ArtifactFormat::Deb,
                "/home/dev/staging/server.deb",
                "/usr/lib/bibcode-server",
                "/home/dev/.bibcode",
            ),
            "/usr/bin/bibcode",
            RemoteInstallAuthority::NoninteractiveAdministrator,
        );
        let clean_service = adapter.service_commands(&staged).unwrap();
        assert_eq!(clean_service.len(), 1);
        assert!(
            !clean_service[0]
                .arguments
                .iter()
                .any(|argument| argument == "--update")
        );
        let update_service = adapter
            .service_commands(&staged.clone().with_service_update(true))
            .unwrap();
        assert!(
            update_service[0]
                .arguments
                .iter()
                .any(|argument| argument == "--update")
        );
    }

    #[test]
    fn linux_minimal_posix_host_selects_portable_and_missing_hash_fails_closed() {
        let adapter = LinuxRemoteHostAdapter;
        let mut outputs = linux_outputs();
        for output in &mut outputs {
            if matches!(
                output.purpose,
                RemoteCommandPurpose::DebInstaller | RemoteCommandPurpose::AdministratorAuthority
            ) {
                *output = missing(output.purpose);
            }
        }
        let probe = adapter.parse_probe(&outputs).expect("minimal POSIX probe");
        assert_eq!(probe.install_authority, RemoteInstallAuthority::User);
        assert_eq!(
            adapter.preferred_formats(&probe),
            vec![ArtifactFormat::TarGz]
        );

        for output in &mut outputs {
            if output.purpose == RemoteCommandPurpose::Sha256 {
                *output = missing(RemoteCommandPurpose::Sha256);
            }
        }
        assert!(adapter.parse_probe(&outputs).is_err());
    }

    #[test]
    fn macos_probe_normalizes_arm64_and_reports_headless_authority_denial() {
        let adapter = MacOsRemoteHostAdapter;
        let outputs = vec![
            success(RemoteCommandPurpose::Kernel, "Darwin\n"),
            success(RemoteCommandPurpose::Architecture, "arm64\n"),
            success(RemoteCommandPurpose::Home, "/Users/dev\n"),
            success(
                RemoteCommandPurpose::FreeSpace,
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 100000 2000 98000 2% /System/Volumes/Data\n",
            ),
            success(
                RemoteCommandPurpose::SystemFreeSpace,
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 100000 3000 97000 3% /\n",
            ),
            success(RemoteCommandPurpose::InstalledVersion, "bibcode 0.4.1\n"),
            success(
                RemoteCommandPurpose::WorkstationService,
                &service_status(
                    "workstation",
                    "stopped",
                    "/usr/local/bin/bibcode",
                    "/Users/dev/.bibcode",
                ),
            ),
            missing(RemoteCommandPurpose::HeadlessService),
            missing(RemoteCommandPurpose::AdministratorAuthority),
            success(RemoteCommandPurpose::PackageInstaller, "installer help\n"),
            success(RemoteCommandPurpose::PortableExtractor, "bsdtar 3.7\n"),
            success(RemoteCommandPurpose::Sha256, "shasum 6.02\n"),
        ];
        let probe = adapter.parse_probe(&outputs).expect("macOS probe");
        assert_eq!(probe.os, RemoteHostOs::MacOs);
        assert_eq!(probe.architecture, RemoteHostArchitecture::Aarch64);
        assert_eq!(probe.service_state, RemoteServiceState::Stopped);
        assert_eq!(probe.install_authority, RemoteInstallAuthority::User);
        assert_eq!(
            adapter.preferred_formats(&probe),
            vec![ArtifactFormat::TarGz]
        );

        let mut staged = StagedArtifact::from_verified(
            verified_artifact(
                RemoteHostOs::MacOs,
                RemoteHostArchitecture::Aarch64,
                ArtifactFormat::Pkg,
                "/Users/dev/staging/server.pkg",
                "/Applications/BiBCode Server",
                "/Library/Application Support/BiBCode",
            ),
            "/usr/local/bin/bibcode",
            RemoteInstallAuthority::AdministratorRequired,
        );
        staged.service_mode = RemoteServiceMode::Headless;
        assert!(adapter.install_commands(&staged).is_err());
    }

    #[test]
    fn windows_probe_uses_only_constant_encoded_powershell_and_normalizes_x64() {
        let adapter = WindowsRemoteHostAdapter;
        for command in adapter.probe_commands() {
            assert_eq!(command.program, "powershell.exe");
            let script = decode_powershell_command(&command).expect("owned encoded command");
            assert!(script.contains("ConvertTo-Json"));
            assert!(!script.contains("build-host"));
        }
        let output = success(
            RemoteCommandPurpose::WindowsProbe,
            r#"{"os":"windows","architecture":"X64","home":"C:\\Users\\dev","localAppData":"C:\\Users\\dev\\AppData\\Local","freeBytes":123456789,"isAdministrator":true,"msiAvailable":true,"portableAvailable":true,"sha256Available":true,"installedVersion":"0.4.1","serviceMode":"workstation","serviceState":"running","dataRoot":"C:\\Users\\dev\\.bibcode","controlAvailable":true,"binaryPath":"C:\\Program Files\\BiBCode Server\\bibcode.exe","bind":"127.0.0.1:3773"}"#,
        );
        let probe = adapter.parse_probe(&[output]).expect("Windows probe");
        assert_eq!(probe.os, RemoteHostOs::Windows);
        assert_eq!(probe.architecture, RemoteHostArchitecture::X86_64);
        assert_eq!(
            probe.install_authority,
            RemoteInstallAuthority::NoninteractiveAdministrator
        );
        assert_eq!(adapter.preferred_formats(&probe), vec![ArtifactFormat::Zip]);
        let mut clean_install = probe.clone();
        clean_install.installed_version = None;
        assert_eq!(
            adapter.preferred_formats(&clean_install),
            vec![ArtifactFormat::Msi]
        );
    }

    #[test]
    fn windows_hostile_paths_are_encoded_input_not_command_text() {
        let adapter = WindowsRemoteHostAdapter;
        let hostile = r#"C:\Users\dev & whoami\'; $(Write-Error injected)\server.msi"#;
        let verified = verified_artifact(
            RemoteHostOs::Windows,
            RemoteHostArchitecture::Aarch64,
            ArtifactFormat::Msi,
            hostile,
            r#"C:\Users\dev\AppData\Local\Programs\BiBCode Server"#,
            r#"C:\Users\dev\.bibcode"#,
        );
        let mut saw_exact_path_in_input = false;
        for command in adapter.stage_commands(&verified).expect("stage commands") {
            let rendered = command
                .render_for_windows_openssh()
                .expect("render command");
            assert!(!rendered.contains(hostile));
            assert!(
                !decode_powershell_command(&command)
                    .unwrap()
                    .contains(hostile)
            );
            if let RemoteStdin::Json(bytes) = &command.stdin {
                let value: serde_json::Value = serde_json::from_slice(bytes).unwrap();
                saw_exact_path_in_input |= value.as_object().is_some_and(|object| {
                    object.values().any(|value| value.as_str() == Some(hostile))
                });
            }
            if let RemoteStdin::Artifact { metadata, .. } = &command.stdin {
                let value: serde_json::Value = serde_json::from_slice(metadata).unwrap();
                saw_exact_path_in_input |=
                    value.get("remotePath").and_then(serde_json::Value::as_str) == Some(hostile);
            }
        }
        assert!(saw_exact_path_in_input);
        let staged = StagedArtifact::from_verified(
            verified,
            r#"C:\Users\dev\AppData\Local\Programs\BiBCode Server\bin\bibcode.exe"#,
            RemoteInstallAuthority::User,
        );
        assert_eq!(adapter.service_commands(&staged).unwrap().len(), 1);
    }

    #[test]
    fn windows_headless_portable_install_reverifies_and_protects_system_files() {
        let adapter = WindowsRemoteHostAdapter;
        let mut verified = verified_artifact(
            RemoteHostOs::Windows,
            RemoteHostArchitecture::X86_64,
            ArtifactFormat::Zip,
            r"C:\Users\dev\AppData\Local\BiBCode\Server\staging\server.zip",
            r"C:\ProgramData\BiBCode\Server\versions\version-1",
            r"C:\ProgramData\BiBCode",
        );
        verified.service_mode = RemoteServiceMode::Headless;
        let staged = StagedArtifact::from_verified(
            verified.clone(),
            r"C:\ProgramData\BiBCode\Server\versions\version-1\bibcode-server\bin\bibcode.exe",
            RemoteInstallAuthority::NoninteractiveAdministrator,
        );
        let command = adapter
            .install_commands(&staged)
            .expect("Windows headless portable command")
            .into_iter()
            .next()
            .expect("Windows portable install command");
        let script = decode_powershell_command(&command).expect("fixed Windows install script");
        assert!(script.contains("expectedSha256"));
        assert!(script.contains("expectedSize"));
        assert!(script.contains("/setowner"));
        assert!(script.contains("S-1-5-18"));
        assert!(script.contains("S-1-5-32-544"));
        assert!(script.contains("S-1-5-11"));
        assert!(!script.contains(&verified.install_root));
        let RemoteStdin::Json(bytes) = command.stdin else {
            panic!("Windows headless install values must use JSON stdin");
        };
        let document: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            document
                .get("headless")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            document
                .get("expectedSha256")
                .and_then(serde_json::Value::as_str),
            Some(verified.sha256.as_str())
        );

        let cleanup = adapter
            .cleanup_commands(&verified, false)
            .expect("Windows headless cleanup command");
        assert!(
            decode_powershell_command(&cleanup[0])
                .expect("fixed Windows cleanup script")
                .contains(".staging")
        );
    }

    #[test]
    fn posix_staging_verifies_both_manifest_hash_and_byte_count() {
        for (adapter, verified) in [
            (
                Box::new(LinuxRemoteHostAdapter) as Box<dyn RemoteHostAdapter>,
                verified_artifact(
                    RemoteHostOs::Linux,
                    RemoteHostArchitecture::X86_64,
                    ArtifactFormat::TarGz,
                    "/home/dev/staging/server.tar.gz",
                    "/home/dev/server",
                    "/home/dev/.bibcode",
                ),
            ),
            (
                Box::new(MacOsRemoteHostAdapter) as Box<dyn RemoteHostAdapter>,
                verified_artifact(
                    RemoteHostOs::MacOs,
                    RemoteHostArchitecture::Aarch64,
                    ArtifactFormat::TarGz,
                    "/Users/dev/staging/server.tar.gz",
                    "/Users/dev/server",
                    "/Users/dev/.bibcode",
                ),
            ),
        ] {
            let commands = adapter
                .stage_commands(&verified)
                .expect("POSIX stage commands");
            let purposes = commands
                .iter()
                .map(|command| command.purpose)
                .collect::<Vec<_>>();
            assert!(purposes.contains(&RemoteCommandPurpose::VerifyTransfer));
            assert!(purposes.contains(&RemoteCommandPurpose::VerifyTransferSize));
            assert!(commands.iter().any(|command| {
                command.program == "chmod"
                    && command.arguments.first().is_some_and(|mode| mode == "700")
            }));
            assert!(commands.iter().any(|command| {
                command.program == "chmod"
                    && command.arguments.first().is_some_and(|mode| mode == "600")
            }));
            assert!(commands.iter().any(|command| {
                matches!(command.stdin, RemoteStdin::Artifact { .. })
                    && command.timeout == REMOTE_TRANSFER_COMMAND_TIMEOUT
            }));
        }
    }

    #[test]
    fn posix_portable_install_extracts_privately_then_atomically_renames() {
        for (adapter, verified) in [
            (
                Box::new(LinuxRemoteHostAdapter) as Box<dyn RemoteHostAdapter>,
                verified_artifact(
                    RemoteHostOs::Linux,
                    RemoteHostArchitecture::X86_64,
                    ArtifactFormat::TarGz,
                    "/home/dev/staging/server.tar.gz",
                    "/home/dev/versions/version-1",
                    "/home/dev/.bibcode",
                ),
            ),
            (
                Box::new(MacOsRemoteHostAdapter) as Box<dyn RemoteHostAdapter>,
                verified_artifact(
                    RemoteHostOs::MacOs,
                    RemoteHostArchitecture::Aarch64,
                    ArtifactFormat::TarGz,
                    "/Users/dev/staging/server.tar.gz",
                    "/Users/dev/versions/version-1",
                    "/Users/dev/.bibcode",
                ),
            ),
        ] {
            let staged = StagedArtifact::from_verified(
                verified.clone(),
                format!("{}/bibcode-server/bin/bibcode", verified.install_root),
                RemoteInstallAuthority::User,
            );
            let commands = adapter
                .install_commands(&staged)
                .expect("portable install commands");
            assert_eq!(
                commands
                    .iter()
                    .map(|command| command.program.as_str())
                    .collect::<Vec<_>>(),
                vec!["test", "mkdir", "mkdir", "chmod", "tar", "mv"]
            );
            let extraction_root = format!("{}.staging", verified.install_root);
            let tar = commands
                .iter()
                .find(|command| command.program == "tar")
                .expect("tar extraction command");
            assert_eq!(tar.arguments.last(), Some(&extraction_root));
            assert_eq!(tar.timeout, REMOTE_INSTALL_COMMAND_TIMEOUT);
            let rename = commands.last().expect("atomic rename command");
            assert_eq!(
                rename.arguments,
                vec![
                    "--",
                    extraction_root.as_str(),
                    verified.install_root.as_str()
                ]
            );

            let cleanup = adapter
                .cleanup_commands(&verified, true)
                .expect("portable cleanup commands");
            assert!(cleanup.iter().any(|command| {
                command.program == "rm" && command.arguments.last() == Some(&extraction_root)
            }));
            assert!(cleanup.iter().any(|command| {
                command.program == "rm" && command.arguments.last() == Some(&verified.install_root)
            }));
            let partial_cleanup = adapter
                .cleanup_commands(&verified, false)
                .expect("partial portable cleanup commands");
            assert!(partial_cleanup.iter().any(|command| {
                command.program == "rm" && command.arguments.last() == Some(&extraction_root)
            }));
            assert!(!partial_cleanup.iter().any(|command| {
                command.program == "rm" && command.arguments.last() == Some(&verified.install_root)
            }));
        }
    }

    #[test]
    fn posix_headless_portable_install_reverifies_in_admin_owned_staging() {
        for (adapter, mut verified) in [
            (
                Box::new(LinuxRemoteHostAdapter) as Box<dyn RemoteHostAdapter>,
                verified_artifact(
                    RemoteHostOs::Linux,
                    RemoteHostArchitecture::X86_64,
                    ArtifactFormat::TarGz,
                    "/home/dev/staging/server.tar.gz",
                    "/opt/bibcode/server/versions/version-1",
                    "/var/lib/bibcode",
                ),
            ),
            (
                Box::new(MacOsRemoteHostAdapter) as Box<dyn RemoteHostAdapter>,
                verified_artifact(
                    RemoteHostOs::MacOs,
                    RemoteHostArchitecture::Aarch64,
                    ArtifactFormat::TarGz,
                    "/Users/dev/staging/server.tar.gz",
                    "/Library/Application Support/BiBCode Server/versions/version-1",
                    "/Library/Application Support/BiBCode",
                ),
            ),
        ] {
            verified.service_mode = RemoteServiceMode::Headless;
            let staged = StagedArtifact::from_verified(
                verified.clone(),
                format!("{}/bibcode-server/bin/bibcode", verified.install_root),
                RemoteInstallAuthority::NoninteractiveAdministrator,
            );
            let commands = adapter
                .install_commands(&staged)
                .expect("headless portable install commands");
            assert!(commands.iter().all(|command| command.program == "sudo"));
            assert!(commands.iter().any(|command| {
                command.purpose == RemoteCommandPurpose::VerifyTransfer
                    && command.arguments.iter().any(|argument| {
                        argument == &format!("{}.staging/artifact.tar.gz", verified.install_root)
                    })
            }));
            assert!(
                commands
                    .iter()
                    .any(|command| { command.purpose == RemoteCommandPurpose::VerifyTransferSize })
            );
            assert!(commands.iter().any(|command| {
                command
                    .arguments
                    .windows(2)
                    .any(|arguments| arguments == ["-R", "a+rX,go-w"])
            }));
            let promotion = commands.last().expect("headless atomic promotion");
            assert_eq!(promotion.arguments.get(1).map(String::as_str), Some("mv"));

            let cleanup = adapter
                .cleanup_commands(&verified, false)
                .expect("headless cleanup commands");
            assert!(cleanup.iter().any(|command| {
                command.program == "sudo"
                    && command
                        .arguments
                        .last()
                        .is_some_and(|path| path.ends_with(".staging"))
            }));
        }
    }

    #[test]
    fn command_output_and_probe_parsers_reject_unbounded_noise() {
        let output = RemoteCommandOutput::new(
            RemoteCommandPurpose::Kernel,
            0,
            vec![b'x'; 4097],
            Vec::new(),
            false,
            4096,
        );
        assert!(output.is_err());
    }

    #[test]
    fn partial_failure_preserves_previous_version_and_fixed_recovery_command() {
        let failure = RemoteInstallFailure::new(
            RemoteInstallStage::Install,
            MutationStatus::Partial,
            CleanupStatus::Failed,
            Some("0.4.1".to_string()),
            "Remote installation failed after staging.".to_string(),
            "'/opt/bibcode/bin/bibcode' 'service' 'status' '--mode' 'workstation' '--format' 'json'"
                .to_string(),
        );
        assert_eq!(failure.previous_version.as_deref(), Some("0.4.1"));
        assert_eq!(
            failure.recovery_command,
            "'/opt/bibcode/bin/bibcode' 'service' 'status' '--mode' 'workstation' '--format' 'json'"
        );
        assert!(!failure.recovery_command.contains("0.4.1"));
    }
}
