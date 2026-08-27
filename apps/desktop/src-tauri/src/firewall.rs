//! Windows Defender Firewall integration for grant-driven server exposure.
//!
//! The desktop backend port is picked dynamically, so the inbound allow rule is
//! program-scoped rather than port-scoped. Non-Windows platforms have no managed
//! firewall here and every call is a successful no-op.

#[cfg_attr(
    not(windows),
    expect(dead_code, reason = "Windows-only firewall command")
)]
const REMOTE_ACCESS_RULE_NAME: &str = "BiBCode Remote Access";

#[must_use]
#[cfg_attr(
    not(windows),
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
    not(windows),
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

#[cfg(windows)]
#[expect(
    dead_code,
    reason = "used by the exposure bridge in the next implementation task"
)]
pub(crate) async fn sync_remote_access_rule(enabled: bool) -> Result<(), String> {
    let _ = run_netsh(remote_access_rule_delete_args()).await;
    if !enabled {
        return Ok(());
    }
    let program = std::env::current_exe()
        .map_err(|error| format!("failed to resolve desktop executable: {error}"))?
        .to_string_lossy()
        .into_owned();
    let output = run_netsh(remote_access_rule_add_args(&program)).await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "netsh failed to add the remote access firewall rule: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

#[cfg(windows)]
async fn run_netsh(args: Vec<String>) -> Result<std::process::Output, String> {
    let mut command = tokio::process::Command::new("netsh");
    command.args(args);
    bibcode_server::process::configure_background_command(&mut command);
    command
        .output()
        .await
        .map_err(|error| format!("failed to run netsh: {error}"))
}

#[cfg(not(windows))]
#[expect(
    dead_code,
    reason = "used by the exposure bridge in the next implementation task"
)]
pub(crate) async fn sync_remote_access_rule(_enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn delete_rule_arguments_target_the_rule_by_name() {
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
}
