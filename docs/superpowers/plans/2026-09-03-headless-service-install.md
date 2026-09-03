# Headless Per-User Service Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bibcode service install | uninstall | status` keeps a headless `bibcode serve` running across reboots under the invoking user's identity, so provider CLIs keep finding their per-user credentials and paired devices keep working.

**Architecture:** A new `service_manager` module renders a per-platform service definition (systemd user unit, launchd LaunchAgent plist, Windows scheduled task) from a `ServiceSpec`, and drives the platform's user-level service manager through a `CommandRunner` trait so tests inject a fake and assert the exact command sequence. Nothing ships inside the `.deb`/`.rpm`; the definition is written at runtime into the user's own directories. The captured `PATH` of the installing process is written into the definition.

**Tech Stack:** Rust (clap, `dirs`, `libc` on unix, `std::process::Command`), Rust unit tests with a fake runner, `apps/server/tests/cli_smoke.rs` for help output.

**Spec:** `docs/plans/remote-servers/2026-09-03-headless-pairing-and-service-design.md` (decision D3). Depends on the `--no-startup-pairing-offer` flag from `docs/superpowers/plans/2026-09-03-headless-pairing-offer-cli.md` Task 6.

## Global Constraints

- Per-user only: `~/.config/systemd/user/bibcode.service`, `~/Library/LaunchAgents/com.bibcode.server.plist`, or a scheduled task named `BiBCode Server` running as the current user with `/RL LIMITED`. Never `sudo`, never `/etc/systemd/system`, never `LaunchDaemons`, never a stored password.
- `apps/server/package/nfpm.yaml` must not change; `scripts/server-package-contract.test.ts` forbids `systemd` in it.
- The rendered command line is the absolute current executable plus `serve --host <host> --port <port> [--base-dir <dir>] [--static-dir <dir>] --no-startup-pairing-offer`. `--mode` and `--bootstrap-fd` are never included even though they are global flags.
- `PATH` written into the definition is the installing process's `PATH`, verbatim.
- On Linux the install sequence is exactly: write unit, `loginctl enable-linger`, `systemctl --user daemon-reload`, `systemctl --user enable --now bibcode.service`. When `systemctl --user` fails, the error names the definition path and lists those three commands for the user to run after lingering takes effect.
- `--json` prints exactly one JSON object; plain mode prints a short report. Nothing is written to stdout on failure.
- Every task ends with `cargo fmt --all --check`, the named focused tests, and `cargo clippy -p bibcode-server --all-targets -- -D warnings` before commit.

---

### Task 1: Service definitions rendered from a spec

**Files:**
- Create: `apps/server/src/service_manager/mod.rs`
- Create: `apps/server/src/service_manager/definitions.rs`
- Modify: `apps/server/src/lib.rs` (add `mod service_manager;`)
- Test: `apps/server/src/service_manager/definitions.rs` unit tests

**Interfaces:**
- Produces:
  ```rust
  pub(crate) struct ServiceSpec {
      pub(crate) executable: PathBuf,
      pub(crate) host: String,
      pub(crate) port: u16,
      pub(crate) base_dir: Option<PathBuf>,
      pub(crate) static_dir: Option<PathBuf>,
      pub(crate) path_env: Option<OsString>,
  }
  impl ServiceSpec { pub(crate) fn serve_arguments(&self) -> Vec<OsString> }
  pub(crate) const SYSTEMD_UNIT_NAME: &str = "bibcode.service";
  pub(crate) const LAUNCHD_LABEL: &str = "com.bibcode.server";
  pub(crate) const WINDOWS_TASK_NAME: &str = "BiBCode Server";
  pub(crate) fn render_systemd_unit(spec: &ServiceSpec) -> String
  pub(crate) fn render_launchd_plist(spec: &ServiceSpec, log_path: &Path) -> String
  pub(crate) fn windows_task_command(spec: &ServiceSpec) -> String
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/service_manager/definitions.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    fn spec() -> ServiceSpec {
        ServiceSpec {
            executable: PathBuf::from("/usr/bin/bibcode"),
            host: "100.105.196.60".to_owned(),
            port: 3773,
            base_dir: Some(PathBuf::from("/home/me/.bibcode")),
            static_dir: None,
            path_env: Some("/home/me/.local/bin:/usr/bin".into()),
        }
    }

    #[test]
    fn serve_arguments_carry_only_the_service_flags() {
        let arguments = spec().serve_arguments();
        assert_eq!(
            arguments,
            vec![
                "serve",
                "--host",
                "100.105.196.60",
                "--port",
                "3773",
                "--base-dir",
                "/home/me/.bibcode",
                "--no-startup-pairing-offer",
            ]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>()
        );
        let mut with_static = spec();
        with_static.base_dir = None;
        with_static.static_dir = Some(PathBuf::from("/opt/bibcode/web"));
        let arguments = with_static.serve_arguments();
        assert!(arguments.iter().any(|argument| argument == "--static-dir"));
        assert!(!arguments.iter().any(|argument| argument == "--base-dir"));
    }

    #[test]
    fn renders_a_systemd_user_unit_with_quoted_exec_and_captured_path() {
        let unit = render_systemd_unit(&spec());
        assert_eq!(
            unit,
            "[Unit]\n\
             Description=BiBCode server\n\
             After=network-online.target\n\
             Wants=network-online.target\n\
             \n\
             [Service]\n\
             ExecStart=\"/usr/bin/bibcode\" serve --host 100.105.196.60 --port 3773 --base-dir \"/home/me/.bibcode\" --no-startup-pairing-offer\n\
             Environment=\"PATH=/home/me/.local/bin:/usr/bin\"\n\
             Restart=on-failure\n\
             RestartSec=2\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n"
        );
    }

    #[test]
    fn systemd_quoting_escapes_backslashes_and_quotes() {
        let mut spec = spec();
        spec.executable = PathBuf::from("/opt/my \"apps\"/bib\\code");
        spec.path_env = None;
        let unit = render_systemd_unit(&spec);
        assert!(unit.contains("ExecStart=\"/opt/my \\\"apps\\\"/bib\\\\code\" serve"), "{unit}");
        assert!(!unit.contains("Environment="), "{unit}");
    }

    #[test]
    fn renders_a_launch_agent_plist_with_escaped_values() {
        let mut spec = spec();
        spec.executable = PathBuf::from("/Applications/Bib&Code/bibcode");
        let plist = render_launchd_plist(&spec, Path::new("/Users/me/Library/Logs/bibcode-server.log"));
        assert!(plist.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"));
        assert!(plist.contains("<key>Label</key>\n\t<string>com.bibcode.server</string>"), "{plist}");
        assert!(plist.contains("<string>/Applications/Bib&amp;Code/bibcode</string>"), "{plist}");
        assert!(plist.contains("<string>--no-startup-pairing-offer</string>"), "{plist}");
        assert!(plist.contains("<key>PATH</key>\n\t\t<string>/home/me/.local/bin:/usr/bin</string>"), "{plist}");
        assert!(plist.contains("<key>RunAtLoad</key>\n\t<true/>"), "{plist}");
        assert!(plist.contains("<key>KeepAlive</key>\n\t<true/>"), "{plist}");
        assert!(plist.contains("<key>StandardOutPath</key>\n\t<string>/Users/me/Library/Logs/bibcode-server.log</string>"), "{plist}");
    }

    #[test]
    fn windows_task_command_quotes_the_executable_and_paths() {
        let mut spec = spec();
        spec.executable = PathBuf::from(r"C:\Program Files\BiBCode\bibcode.exe");
        spec.base_dir = Some(PathBuf::from(r"C:\Users\me\.bibcode"));
        assert_eq!(
            windows_task_command(&spec),
            r#""C:\Program Files\BiBCode\bibcode.exe" serve --host 100.105.196.60 --port 3773 --base-dir "C:\Users\me\.bibcode" --no-startup-pairing-offer"#
        );
    }
}
```

Create `apps/server/src/service_manager/mod.rs` with:

```rust
//! Per-user background service management for the headless server
//! (`bibcode service install | uninstall | status`). Definitions are rendered
//! from a [`ServiceSpec`]; platform service managers are driven through
//! [`CommandRunner`] so tests can assert the exact command sequence.

mod definitions;

pub(crate) use definitions::{
    LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, ServiceSpec, WINDOWS_TASK_NAME, render_launchd_plist,
    render_systemd_unit, windows_task_command,
};
```

Add `mod service_manager;` to `apps/server/src/lib.rs` next to the other module declarations.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bibcode-server --lib service_manager::definitions::tests`
Expected: compile error, `ServiceSpec` not found.

- [ ] **Step 3: Implement the definitions**

Prepend to `apps/server/src/service_manager/definitions.rs`:

```rust
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub(crate) const SYSTEMD_UNIT_NAME: &str = "bibcode.service";
pub(crate) const LAUNCHD_LABEL: &str = "com.bibcode.server";
pub(crate) const WINDOWS_TASK_NAME: &str = "BiBCode Server";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ServiceSpec {
    pub(crate) executable: PathBuf,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) base_dir: Option<PathBuf>,
    pub(crate) static_dir: Option<PathBuf>,
    pub(crate) path_env: Option<OsString>,
}

impl ServiceSpec {
    /// Arguments after the executable. Only the flags a service needs are
    /// included; `--mode` and `--bootstrap-fd` are desktop-host concerns.
    pub(crate) fn serve_arguments(&self) -> Vec<OsString> {
        let mut arguments: Vec<OsString> = vec![
            "serve".into(),
            "--host".into(),
            self.host.clone().into(),
            "--port".into(),
            self.port.to_string().into(),
        ];
        if let Some(base_dir) = &self.base_dir {
            arguments.push("--base-dir".into());
            arguments.push(base_dir.clone().into_os_string());
        }
        if let Some(static_dir) = &self.static_dir {
            arguments.push("--static-dir".into());
            arguments.push(static_dir.clone().into_os_string());
        }
        arguments.push("--no-startup-pairing-offer".into());
        arguments
    }
}

/// systemd quoting: double-quote every word that is a path (may contain
/// spaces), escaping backslashes and double quotes.
fn systemd_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted
}

fn is_path_word(argument: &OsString, previous: Option<&OsString>) -> bool {
    previous.is_some_and(|flag| flag == "--base-dir" || flag == "--static-dir")
        || argument.to_string_lossy().contains(' ')
}

pub(crate) fn render_systemd_unit(spec: &ServiceSpec) -> String {
    let mut exec_start = systemd_quote(&spec.executable.to_string_lossy());
    let arguments = spec.serve_arguments();
    for (index, argument) in arguments.iter().enumerate() {
        exec_start.push(' ');
        let text = argument.to_string_lossy();
        if is_path_word(argument, index.checked_sub(1).and_then(|previous| arguments.get(previous))) {
            exec_start.push_str(&systemd_quote(&text));
        } else {
            exec_start.push_str(&text);
        }
    }
    let mut unit = String::new();
    unit.push_str("[Unit]\n");
    unit.push_str("Description=BiBCode server\n");
    unit.push_str("After=network-online.target\n");
    unit.push_str("Wants=network-online.target\n\n");
    unit.push_str("[Service]\n");
    unit.push_str(&format!("ExecStart={exec_start}\n"));
    if let Some(path) = &spec.path_env {
        unit.push_str(&format!(
            "Environment={}\n",
            systemd_quote(&format!("PATH={}", path.to_string_lossy()))
        ));
    }
    unit.push_str("Restart=on-failure\n");
    unit.push_str("RestartSec=2\n\n");
    unit.push_str("[Install]\n");
    unit.push_str("WantedBy=default.target\n");
    unit
}

fn xml_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            other => escaped.push(other),
        }
    }
    escaped
}

pub(crate) fn render_launchd_plist(spec: &ServiceSpec, log_path: &Path) -> String {
    let mut plist = String::new();
    plist.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    plist.push_str("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n");
    plist.push_str("<plist version=\"1.0\">\n<dict>\n");
    plist.push_str(&format!("\t<key>Label</key>\n\t<string>{LAUNCHD_LABEL}</string>\n"));
    plist.push_str("\t<key>ProgramArguments</key>\n\t<array>\n");
    plist.push_str(&format!(
        "\t\t<string>{}</string>\n",
        xml_escape(&spec.executable.to_string_lossy())
    ));
    for argument in spec.serve_arguments() {
        plist.push_str(&format!(
            "\t\t<string>{}</string>\n",
            xml_escape(&argument.to_string_lossy())
        ));
    }
    plist.push_str("\t</array>\n");
    if let Some(path) = &spec.path_env {
        plist.push_str("\t<key>EnvironmentVariables</key>\n\t<dict>\n");
        plist.push_str(&format!(
            "\t\t<key>PATH</key>\n\t\t<string>{}</string>\n",
            xml_escape(&path.to_string_lossy())
        ));
        plist.push_str("\t</dict>\n");
    }
    plist.push_str("\t<key>RunAtLoad</key>\n\t<true/>\n");
    plist.push_str("\t<key>KeepAlive</key>\n\t<true/>\n");
    let log = xml_escape(&log_path.to_string_lossy());
    plist.push_str(&format!("\t<key>StandardOutPath</key>\n\t<string>{log}</string>\n"));
    plist.push_str(&format!("\t<key>StandardErrorPath</key>\n\t<string>{log}</string>\n"));
    plist.push_str("</dict>\n</plist>\n");
    plist
}

fn windows_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

/// The `/TR` value for `schtasks`: the quoted executable followed by the
/// serve arguments, quoting path words.
pub(crate) fn windows_task_command(spec: &ServiceSpec) -> String {
    let mut command = windows_quote(&spec.executable.to_string_lossy());
    let arguments = spec.serve_arguments();
    for (index, argument) in arguments.iter().enumerate() {
        command.push(' ');
        let text = argument.to_string_lossy();
        if is_path_word(argument, index.checked_sub(1).and_then(|previous| arguments.get(previous))) {
            command.push_str(&windows_quote(&text));
        } else {
            command.push_str(&text);
        }
    }
    command
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bibcode-server --lib service_manager::definitions::tests`
Expected: 5 passed.

- [ ] **Step 5: Verify and commit**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`

```bash
git add apps/server/src/service_manager apps/server/src/lib.rs
git commit -m "feat(server): render per-user service definitions from a service spec"
```

---

### Task 2: Install, uninstall, and status orchestration through a command runner

**Files:**
- Create: `apps/server/src/service_manager/manager.rs`
- Modify: `apps/server/src/service_manager/mod.rs` (declare and re-export)
- Test: `apps/server/src/service_manager/manager.rs` unit tests with a fake runner

**Interfaces:**
- Consumes: Task 1 rendering functions and constants.
- Produces:
  ```rust
  pub(crate) enum ServicePlatform { Linux, MacOs, Windows }
  impl ServicePlatform { pub(crate) fn current() -> Option<Self> }
  pub(crate) struct ServiceLocations { pub(crate) definition_path: PathBuf, pub(crate) log_path: PathBuf, pub(crate) uid: Option<u32> }
  impl ServiceLocations { pub(crate) fn detect(platform: ServicePlatform) -> Result<Self, ServiceError> }
  pub(crate) struct CommandOutput { pub(crate) success: bool, pub(crate) stdout: String, pub(crate) stderr: String }
  pub(crate) trait CommandRunner { fn run(&self, program: &str, arguments: &[OsString]) -> std::io::Result<CommandOutput>; }
  pub(crate) struct ProcessCommandRunner;
  pub(crate) struct ServiceReport { pub(crate) platform: &'static str, pub(crate) definition: String, pub(crate) state: ServiceState, pub(crate) executed: Vec<String>, pub(crate) notes: Vec<String> }
  pub(crate) enum ServiceState { Active, Inactive, NotInstalled, Removed }
  pub(crate) enum ServiceError { UnsupportedPlatform, HomeDirectoryUnavailable, Write { path: PathBuf, source: io::Error }, Remove { path: PathBuf, source: io::Error }, Spawn { program: String, source: io::Error }, Command { program: String, arguments: String, stderr: String }, ManualStepsRequired { definition: PathBuf, steps: Vec<String>, stderr: String } }
  pub(crate) fn install(spec: &ServiceSpec, platform: ServicePlatform, locations: &ServiceLocations, runner: &dyn CommandRunner) -> Result<ServiceReport, ServiceError>
  pub(crate) fn uninstall(platform: ServicePlatform, locations: &ServiceLocations, runner: &dyn CommandRunner) -> Result<ServiceReport, ServiceError>
  pub(crate) fn status(platform: ServicePlatform, locations: &ServiceLocations, runner: &dyn CommandRunner) -> Result<ServiceReport, ServiceError>
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/service_manager/manager.rs` with only:

```rust
#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::path::PathBuf;

    use super::*;

    struct FakeRunner {
        calls: RefCell<Vec<String>>,
        failures: HashMap<String, String>,
        stdout: HashMap<String, String>,
    }

    impl FakeRunner {
        fn new() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                failures: HashMap::new(),
                stdout: HashMap::new(),
            }
        }
        fn failing(mut self, command: &str, stderr: &str) -> Self {
            self.failures.insert(command.to_owned(), stderr.to_owned());
            self
        }
        fn printing(mut self, command: &str, stdout: &str) -> Self {
            self.stdout.insert(command.to_owned(), stdout.to_owned());
            self
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl CommandRunner for FakeRunner {
        fn run(&self, program: &str, arguments: &[OsString]) -> std::io::Result<CommandOutput> {
            let rendered = std::iter::once(program.to_owned())
                .chain(arguments.iter().map(|argument| argument.to_string_lossy().into_owned()))
                .collect::<Vec<_>>()
                .join(" ");
            self.calls.borrow_mut().push(rendered.clone());
            if let Some(stderr) = self.failures.get(&rendered) {
                return Ok(CommandOutput { success: false, stdout: String::new(), stderr: stderr.clone() });
            }
            Ok(CommandOutput {
                success: true,
                stdout: self.stdout.get(&rendered).cloned().unwrap_or_default(),
                stderr: String::new(),
            })
        }
    }

    fn spec() -> ServiceSpec {
        ServiceSpec {
            executable: PathBuf::from("/usr/bin/bibcode"),
            host: "100.105.196.60".to_owned(),
            port: 3773,
            base_dir: None,
            static_dir: None,
            path_env: Some("/usr/bin".into()),
        }
    }

    fn locations(temp: &tempfile::TempDir, file: &str) -> ServiceLocations {
        ServiceLocations {
            definition_path: temp.path().join("nested").join(file),
            log_path: temp.path().join("bibcode-server.log"),
            uid: Some(1000),
        }
    }

    #[test]
    fn linux_install_writes_the_unit_then_lingers_reloads_and_enables() {
        let temp = tempfile::tempdir().expect("temp");
        let locations = locations(&temp, "bibcode.service");
        let runner = FakeRunner::new();
        let report = install(&spec(), ServicePlatform::Linux, &locations, &runner).expect("install");
        assert_eq!(
            runner.calls(),
            vec![
                "loginctl enable-linger",
                "systemctl --user daemon-reload",
                "systemctl --user enable --now bibcode.service",
            ]
        );
        let unit = std::fs::read_to_string(&locations.definition_path).expect("unit written");
        assert_eq!(unit, render_systemd_unit(&spec()));
        assert_eq!(report.state, ServiceState::Active);
        assert_eq!(report.platform, "linux");
        assert!(report.notes.is_empty(), "{:?}", report.notes);
    }

    #[test]
    fn linux_install_reports_manual_steps_when_the_user_bus_is_unreachable() {
        let temp = tempfile::tempdir().expect("temp");
        let locations = locations(&temp, "bibcode.service");
        let runner = FakeRunner::new().failing(
            "systemctl --user daemon-reload",
            "Failed to connect to bus: No medium found",
        );
        let error = install(&spec(), ServicePlatform::Linux, &locations, &runner).expect_err("no bus");
        let ServiceError::ManualStepsRequired { definition, steps, stderr } = error else {
            panic!("expected manual steps, got {error:?}");
        };
        assert_eq!(definition, locations.definition_path);
        assert_eq!(
            steps,
            vec![
                "loginctl enable-linger",
                "systemctl --user daemon-reload",
                "systemctl --user enable --now bibcode.service",
            ]
        );
        assert!(stderr.contains("Failed to connect to bus"));
        assert!(locations.definition_path.exists(), "the unit stays written for the manual steps");
    }

    #[test]
    fn linux_linger_failure_is_a_note_not_an_error() {
        let temp = tempfile::tempdir().expect("temp");
        let locations = locations(&temp, "bibcode.service");
        let runner = FakeRunner::new().failing("loginctl enable-linger", "Interactive authentication required.");
        let report = install(&spec(), ServicePlatform::Linux, &locations, &runner).expect("install");
        assert_eq!(report.state, ServiceState::Active);
        assert_eq!(report.notes.len(), 1);
        assert!(report.notes[0].contains("loginctl enable-linger"), "{:?}", report.notes);
    }

    #[test]
    fn linux_uninstall_disables_removes_and_reloads() {
        let temp = tempfile::tempdir().expect("temp");
        let locations = locations(&temp, "bibcode.service");
        std::fs::create_dir_all(locations.definition_path.parent().unwrap()).unwrap();
        std::fs::write(&locations.definition_path, "unit").unwrap();
        let runner = FakeRunner::new();
        let report = uninstall(ServicePlatform::Linux, &locations, &runner).expect("uninstall");
        assert_eq!(
            runner.calls(),
            vec![
                "systemctl --user disable --now bibcode.service",
                "systemctl --user daemon-reload",
            ]
        );
        assert!(!locations.definition_path.exists());
        assert_eq!(report.state, ServiceState::Removed);
    }

    #[test]
    fn linux_status_reads_is_active_and_reports_missing_definitions() {
        let temp = tempfile::tempdir().expect("temp");
        let locations = locations(&temp, "bibcode.service");
        let runner = FakeRunner::new().printing("systemctl --user is-active bibcode.service", "active\n");
        let report = status(ServicePlatform::Linux, &locations, &runner).expect("status");
        assert_eq!(report.state, ServiceState::NotInstalled);
        assert!(runner.calls().is_empty(), "no service manager call without a definition");

        std::fs::create_dir_all(locations.definition_path.parent().unwrap()).unwrap();
        std::fs::write(&locations.definition_path, "unit").unwrap();
        let report = status(ServicePlatform::Linux, &locations, &runner).expect("status");
        assert_eq!(report.state, ServiceState::Active);
        let inactive = FakeRunner::new().failing("systemctl --user is-active bibcode.service", "inactive");
        let report = status(ServicePlatform::Linux, &locations, &inactive).expect("status");
        assert_eq!(report.state, ServiceState::Inactive);
    }

    #[test]
    fn macos_install_bootstraps_the_launch_agent_for_the_gui_domain() {
        let temp = tempfile::tempdir().expect("temp");
        let locations = locations(&temp, "com.bibcode.server.plist");
        let runner = FakeRunner::new().failing(
            &format!("launchctl bootout gui/1000/com.bibcode.server"),
            "No such process",
        );
        let report = install(&spec(), ServicePlatform::MacOs, &locations, &runner).expect("install");
        assert_eq!(
            runner.calls(),
            vec![
                "launchctl bootout gui/1000/com.bibcode.server".to_owned(),
                format!("launchctl bootstrap gui/1000 {}", locations.definition_path.display()),
            ]
        );
        let plist = std::fs::read_to_string(&locations.definition_path).expect("plist written");
        assert_eq!(plist, render_launchd_plist(&spec(), &locations.log_path));
        assert_eq!(report.state, ServiceState::Active);
        let report = uninstall(ServicePlatform::MacOs, &locations, &runner).expect("uninstall");
        assert_eq!(report.state, ServiceState::Removed);
        assert!(!locations.definition_path.exists());
    }

    #[test]
    fn windows_install_creates_and_runs_the_logon_task() {
        let temp = tempfile::tempdir().expect("temp");
        let locations = locations(&temp, "unused");
        let runner = FakeRunner::new();
        let report = install(&spec(), ServicePlatform::Windows, &locations, &runner).expect("install");
        let calls = runner.calls();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert!(calls[0].starts_with("schtasks /Create /F /TN BiBCode Server /SC ONLOGON /RL LIMITED /TR "), "{}", calls[0]);
        assert!(calls[0].ends_with(&windows_task_command(&spec())), "{}", calls[0]);
        assert_eq!(calls[1], "schtasks /Run /TN BiBCode Server");
        assert_eq!(report.state, ServiceState::Active);
        assert!(report.notes.iter().any(|note| note.contains("logon")), "{:?}", report.notes);
        let report = uninstall(ServicePlatform::Windows, &locations, &runner).expect("uninstall");
        assert_eq!(runner.calls()[2], "schtasks /Delete /F /TN BiBCode Server");
        assert_eq!(report.state, ServiceState::Removed);
    }

    #[test]
    fn command_failures_other_than_the_bus_are_errors_with_context() {
        let temp = tempfile::tempdir().expect("temp");
        let locations = locations(&temp, "bibcode.service");
        let runner = FakeRunner::new().failing(
            "systemctl --user enable --now bibcode.service",
            "Failed to enable unit: Unit file bibcode.service does not exist.",
        );
        let error = install(&spec(), ServicePlatform::Linux, &locations, &runner).expect_err("enable failed");
        assert!(matches!(error, ServiceError::Command { .. }), "{error:?}");
        assert!(error.to_string().contains("does not exist"), "{error}");
    }
}
```

Add `mod manager;` and the re-export to `apps/server/src/service_manager/mod.rs`:

```rust
mod manager;

pub(crate) use manager::{
    CommandOutput, CommandRunner, ProcessCommandRunner, ServiceError, ServiceLocations,
    ServicePlatform, ServiceReport, ServiceState, install, status, uninstall,
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bibcode-server --lib service_manager::manager::tests`
Expected: compile error, `install` not found.

- [ ] **Step 3: Implement the manager**

Prepend to `apps/server/src/service_manager/manager.rs`:

```rust
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

use serde::Serialize;
use thiserror::Error;

use super::definitions::{
    LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, ServiceSpec, WINDOWS_TASK_NAME, render_launchd_plist,
    render_systemd_unit, windows_task_command,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ServicePlatform {
    Linux,
    MacOs,
    Windows,
}

impl ServicePlatform {
    pub(crate) fn current() -> Option<Self> {
        if cfg!(target_os = "linux") {
            Some(Self::Linux)
        } else if cfg!(target_os = "macos") {
            Some(Self::MacOs)
        } else if cfg!(windows) {
            Some(Self::Windows)
        } else {
            None
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Linux => "linux",
            Self::MacOs => "macos",
            Self::Windows => "windows",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ServiceLocations {
    pub(crate) definition_path: PathBuf,
    pub(crate) log_path: PathBuf,
    pub(crate) uid: Option<u32>,
}

impl ServiceLocations {
    pub(crate) fn detect(platform: ServicePlatform) -> Result<Self, ServiceError> {
        let home = dirs::home_dir().ok_or(ServiceError::HomeDirectoryUnavailable)?;
        Ok(match platform {
            ServicePlatform::Linux => Self {
                definition_path: dirs::config_dir()
                    .unwrap_or_else(|| home.join(".config"))
                    .join("systemd")
                    .join("user")
                    .join(SYSTEMD_UNIT_NAME),
                log_path: home.join(".bibcode").join("service.log"),
                uid: current_uid(),
            },
            ServicePlatform::MacOs => Self {
                definition_path: home
                    .join("Library")
                    .join("LaunchAgents")
                    .join(format!("{LAUNCHD_LABEL}.plist")),
                log_path: home.join("Library").join("Logs").join("bibcode-server.log"),
                uid: current_uid(),
            },
            ServicePlatform::Windows => Self {
                definition_path: PathBuf::from(WINDOWS_TASK_NAME),
                log_path: home.join(".bibcode").join("service.log"),
                uid: None,
            },
        })
    }
}

#[cfg(unix)]
fn current_uid() -> Option<u32> {
    // SAFETY: getuid has no preconditions and cannot fail.
    Some(unsafe { libc::getuid() })
}

#[cfg(not(unix))]
fn current_uid() -> Option<u32> {
    None
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CommandOutput {
    pub(crate) success: bool,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

pub(crate) trait CommandRunner {
    fn run(&self, program: &str, arguments: &[OsString]) -> io::Result<CommandOutput>;
}

pub(crate) struct ProcessCommandRunner;

impl CommandRunner for ProcessCommandRunner {
    fn run(&self, program: &str, arguments: &[OsString]) -> io::Result<CommandOutput> {
        let output = std::process::Command::new(program).args(arguments).output()?;
        Ok(CommandOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ServiceState {
    Active,
    Inactive,
    NotInstalled,
    Removed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceReport {
    pub(crate) platform: &'static str,
    pub(crate) definition: String,
    pub(crate) state: ServiceState,
    pub(crate) executed: Vec<String>,
    pub(crate) notes: Vec<String>,
}

#[derive(Debug, Error)]
pub(crate) enum ServiceError {
    #[error("per-user services are not supported on this platform")]
    UnsupportedPlatform,
    #[error("the home directory could not be determined")]
    HomeDirectoryUnavailable,
    #[error("failed to write the service definition {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to remove the service definition {path}: {source}")]
    Remove {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to run {program}: {source}")]
    Spawn {
        program: String,
        #[source]
        source: io::Error,
    },
    #[error("{program} {arguments} failed: {stderr}")]
    Command {
        program: String,
        arguments: String,
        stderr: String,
    },
    #[error(
        "the service definition was written to {definition} but the user service manager is not reachable ({stderr}); run these commands once lingering is enabled:\n{}",
        steps.join("\n")
    )]
    ManualStepsRequired {
        definition: PathBuf,
        steps: Vec<String>,
        stderr: String,
    },
}

struct Session<'a> {
    runner: &'a dyn CommandRunner,
    executed: Vec<String>,
}

impl<'a> Session<'a> {
    fn new(runner: &'a dyn CommandRunner) -> Self {
        Self {
            runner,
            executed: Vec::new(),
        }
    }

    fn rendered(program: &str, arguments: &[OsString]) -> String {
        std::iter::once(program.to_owned())
            .chain(
                arguments
                    .iter()
                    .map(|argument| argument.to_string_lossy().into_owned()),
            )
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Runs a command and returns its output, recording it; only spawn
    /// failures are errors here so callers decide what a non-zero exit means.
    fn run(&mut self, program: &str, arguments: &[&str]) -> Result<CommandOutput, ServiceError> {
        let arguments: Vec<OsString> = arguments.iter().map(OsString::from).collect();
        self.executed.push(Self::rendered(program, &arguments));
        self.runner
            .run(program, &arguments)
            .map_err(|source| ServiceError::Spawn {
                program: program.to_owned(),
                source,
            })
    }

    fn require(&mut self, program: &str, arguments: &[&str]) -> Result<CommandOutput, ServiceError> {
        let output = self.run(program, arguments)?;
        if output.success {
            Ok(output)
        } else {
            Err(ServiceError::Command {
                program: program.to_owned(),
                arguments: arguments.join(" "),
                stderr: output.stderr.trim().to_owned(),
            })
        }
    }
}

fn write_definition(path: &PathBuf, contents: &str) -> Result<(), ServiceError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|source| ServiceError::Write {
            path: path.clone(),
            source,
        })?;
    }
    std::fs::write(path, contents).map_err(|source| ServiceError::Write {
        path: path.clone(),
        source,
    })
}

fn remove_definition(path: &PathBuf) -> Result<(), ServiceError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(ServiceError::Remove {
            path: path.clone(),
            source,
        }),
    }
}

const LINUX_MANUAL_STEPS: [&str; 3] = [
    "loginctl enable-linger",
    "systemctl --user daemon-reload",
    "systemctl --user enable --now bibcode.service",
];

fn report(
    platform: ServicePlatform,
    locations: &ServiceLocations,
    state: ServiceState,
    session: Session<'_>,
    notes: Vec<String>,
) -> ServiceReport {
    ServiceReport {
        platform: platform.name(),
        definition: locations.definition_path.to_string_lossy().into_owned(),
        state,
        executed: session.executed,
        notes,
    }
}

fn gui_domain(locations: &ServiceLocations) -> String {
    format!("gui/{}", locations.uid.unwrap_or(0))
}

pub(crate) fn install(
    spec: &ServiceSpec,
    platform: ServicePlatform,
    locations: &ServiceLocations,
    runner: &dyn CommandRunner,
) -> Result<ServiceReport, ServiceError> {
    let mut session = Session::new(runner);
    let mut notes = Vec::new();
    match platform {
        ServicePlatform::Linux => {
            write_definition(&locations.definition_path, &render_systemd_unit(spec))?;
            let linger = session.run("loginctl", &["enable-linger"])?;
            if !linger.success {
                notes.push(format!(
                    "lingering could not be enabled ({}); run `loginctl enable-linger` yourself so the service starts at boot without a login",
                    linger.stderr.trim()
                ));
            }
            for arguments in [
                ["--user", "daemon-reload"].as_slice(),
                ["--user", "enable", "--now", SYSTEMD_UNIT_NAME].as_slice(),
            ] {
                let output = session.run("systemctl", arguments)?;
                if !output.success {
                    let stderr = output.stderr.trim().to_owned();
                    if stderr.contains("Failed to connect to bus") {
                        return Err(ServiceError::ManualStepsRequired {
                            definition: locations.definition_path.clone(),
                            steps: LINUX_MANUAL_STEPS.iter().map(|step| (*step).to_owned()).collect(),
                            stderr,
                        });
                    }
                    return Err(ServiceError::Command {
                        program: "systemctl".to_owned(),
                        arguments: arguments.join(" "),
                        stderr,
                    });
                }
            }
            Ok(report(platform, locations, ServiceState::Active, session, notes))
        }
        ServicePlatform::MacOs => {
            write_definition(
                &locations.definition_path,
                &render_launchd_plist(spec, &locations.log_path),
            )?;
            let domain = gui_domain(locations);
            let target = format!("{domain}/{LAUNCHD_LABEL}");
            // A previous agent may be loaded; unloading it is best-effort.
            session.run("launchctl", &["bootout", &target])?;
            let definition = locations.definition_path.to_string_lossy().into_owned();
            session.require("launchctl", &["bootstrap", &domain, &definition])?;
            notes.push("a LaunchAgent runs only inside a logged-in session; enable automatic login on a server Mac so it starts after a reboot".to_owned());
            Ok(report(platform, locations, ServiceState::Active, session, notes))
        }
        ServicePlatform::Windows => {
            let command = windows_task_command(spec);
            session.require(
                "schtasks",
                &["/Create", "/F", "/TN", WINDOWS_TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", &command],
            )?;
            session.require("schtasks", &["/Run", "/TN", WINDOWS_TASK_NAME])?;
            notes.push("the task starts at logon as the current user; running without a logged-on user is not configured".to_owned());
            Ok(report(platform, locations, ServiceState::Active, session, notes))
        }
    }
}

pub(crate) fn uninstall(
    platform: ServicePlatform,
    locations: &ServiceLocations,
    runner: &dyn CommandRunner,
) -> Result<ServiceReport, ServiceError> {
    let mut session = Session::new(runner);
    match platform {
        ServicePlatform::Linux => {
            session.run("systemctl", &["--user", "disable", "--now", SYSTEMD_UNIT_NAME])?;
            remove_definition(&locations.definition_path)?;
            session.run("systemctl", &["--user", "daemon-reload"])?;
        }
        ServicePlatform::MacOs => {
            let target = format!("{}/{LAUNCHD_LABEL}", gui_domain(locations));
            session.run("launchctl", &["bootout", &target])?;
            remove_definition(&locations.definition_path)?;
        }
        ServicePlatform::Windows => {
            session.run("schtasks", &["/Delete", "/F", "/TN", WINDOWS_TASK_NAME])?;
        }
    }
    Ok(report(platform, locations, ServiceState::Removed, session, Vec::new()))
}

pub(crate) fn status(
    platform: ServicePlatform,
    locations: &ServiceLocations,
    runner: &dyn CommandRunner,
) -> Result<ServiceReport, ServiceError> {
    let mut session = Session::new(runner);
    let state = match platform {
        ServicePlatform::Linux => {
            if !locations.definition_path.exists() {
                ServiceState::NotInstalled
            } else if session.run("systemctl", &["--user", "is-active", SYSTEMD_UNIT_NAME])?.success {
                ServiceState::Active
            } else {
                ServiceState::Inactive
            }
        }
        ServicePlatform::MacOs => {
            if !locations.definition_path.exists() {
                ServiceState::NotInstalled
            } else {
                let target = format!("{}/{LAUNCHD_LABEL}", gui_domain(locations));
                if session.run("launchctl", &["print", &target])?.success {
                    ServiceState::Active
                } else {
                    ServiceState::Inactive
                }
            }
        }
        ServicePlatform::Windows => {
            let output = session.run("schtasks", &["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST"])?;
            if !output.success {
                ServiceState::NotInstalled
            } else if output.stdout.contains("Running") {
                ServiceState::Active
            } else {
                ServiceState::Inactive
            }
        }
    };
    Ok(report(platform, locations, state, session, Vec::new()))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bibcode-server --lib service_manager::manager::tests`
Expected: 8 passed.

- [ ] **Step 5: Verify and commit**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`

```bash
git add apps/server/src/service_manager
git commit -m "feat(server): drive per-user service managers through an injectable command runner"
```

---

### Task 3: `bibcode service` subcommand and its output

**Files:**
- Modify: `apps/server/src/config.rs` (`CliCommand`, new `ServiceArgs`/`ServiceSubcommand`/`ServiceCommand`, `CliAction::Service`, `ConfigError::ServiceCommandIsNotServer`, dispatch before the fallthrough at line 557)
- Modify: `apps/server/src/lib.rs` (`run_cli` arm, `run_service_command`, `RunError` variants)
- Test: `apps/server/src/config.rs` tests module; `apps/server/tests/cli_smoke.rs`

**Interfaces:**
- Consumes: Task 1 `ServiceSpec`; Task 2 `install`/`uninstall`/`status`, `ServiceLocations::detect`, `ServicePlatform::current`, `ProcessCommandRunner`, `ServiceReport`.
- Produces: CLI `bibcode service install [--host H] [--port P] [--base-dir D] [--static-dir S] [--json]`, `bibcode service uninstall [--json]`, `bibcode service status [--json]`; `ServiceCommand::{Install { spec: ServiceSpec, json: bool }, Uninstall { json: bool }, Status { json: bool }}`.

- [ ] **Step 1: Write the failing parse test**

Add to the `tests` module in `apps/server/src/config.rs`:

```rust
    #[test]
    fn service_install_builds_a_spec_from_the_global_server_flags_only() {
        let executable = PathBuf::from("/usr/bin/bibcode");
        let action = Cli::try_parse_from([
            "bibcode",
            "service",
            "install",
            "--host",
            "100.105.196.60",
            "--port",
            "4000",
            "--base-dir",
            "/srv/bibcode",
            "--bootstrap-fd",
            "7",
            "--json",
        ])
        .expect("parse service install CLI")
        .into_action_with_executable(&executable)
        .expect("build service action");
        let CliAction::Service(ServiceCommand::Install { spec, json }) = action else {
            panic!("service install must produce a service action");
        };
        assert_eq!(spec.executable, executable);
        assert_eq!(spec.host, "100.105.196.60");
        assert_eq!(spec.port, 4000);
        assert_eq!(spec.base_dir, Some(PathBuf::from("/srv/bibcode")));
        assert_eq!(spec.static_dir, None);
        assert_eq!(spec.path_env, std::env::var_os("PATH"));
        assert!(json);
        assert!(!spec.serve_arguments().iter().any(|argument| argument == "--bootstrap-fd"));

        let action = Cli::try_parse_from(["bibcode", "service", "status"])
            .expect("parse service status")
            .into_action_with_executable(&executable)
            .expect("build status action");
        assert!(matches!(action, CliAction::Service(ServiceCommand::Status { json: false })));

        let error = Cli::try_parse_from(["bibcode", "service", "uninstall"])
            .expect("parse service uninstall")
            .into_server_config()
            .expect_err("service commands are not server commands");
        assert!(matches!(error, ConfigError::ServiceCommandIsNotServer));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bibcode-server --lib config::tests::service_install_builds_a_spec_from_the_global_server_flags_only`
Expected: compile error, no `Service` variant.

- [ ] **Step 3: Add the CLI types and dispatch**

In `apps/server/src/config.rs`:

Add the variant to `CliCommand`:

```rust
    #[command(about = "Install, remove, or inspect the per-user background service that keeps `bibcode serve` running.")]
    Service(ServiceArgs),
```

Add after `PairingSubcommand`:

```rust
#[derive(Debug, Args)]
struct ServiceArgs {
    #[command(subcommand)]
    command: ServiceSubcommand,
}

#[derive(Debug, Subcommand)]
enum ServiceSubcommand {
    #[command(
        about = "Install and start a per-user service running `bibcode serve` with the given --host, --port, --base-dir, and --static-dir."
    )]
    Install {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Stop and remove the per-user service.")]
    Uninstall {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Report whether the per-user service is installed and running.")]
    Status {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Clone, Debug)]
pub enum ServiceCommand {
    Install {
        spec: crate::service_manager::ServiceSpec,
        json: bool,
    },
    Uninstall {
        json: bool,
    },
    Status {
        json: bool,
    },
}
```

Add `Service(ServiceCommand),` to `CliAction`, add to `ConfigError`:

```rust
    #[error("service commands cannot be converted into a server configuration")]
    ServiceCommandIsNotServer,
```

and the arm in `into_server_config`:

```rust
            CliAction::Service(_) => Err(ConfigError::ServiceCommandIsNotServer),
```

In `into_action_with_optional_executable`, add this arm **before** `command => command,` (line 557):

```rust
            Some(CliCommand::Service(service)) => {
                return Ok(CliAction::Service(match service.command {
                    ServiceSubcommand::Install { json } => {
                        let current_executable = match executable {
                            Some(executable) => executable.to_path_buf(),
                            None => std::env::current_exe().map_err(ConfigError::CurrentExecutable)?,
                        };
                        ServiceCommand::Install {
                            spec: crate::service_manager::ServiceSpec {
                                executable: current_executable,
                                host: args.host.unwrap_or_else(|| "127.0.0.1".to_owned()),
                                port: args.port.unwrap_or(DEFAULT_PORT),
                                base_dir: args.base_dir,
                                static_dir: args.static_dir,
                                path_env: std::env::var_os("PATH"),
                            },
                            json,
                        }
                    }
                    ServiceSubcommand::Uninstall { json } => ServiceCommand::Uninstall { json },
                    ServiceSubcommand::Status { json } => ServiceCommand::Status { json },
                }));
            }
```

`ServiceSpec` needs to be `pub` for the public `ServiceCommand` enum: change its visibility in `definitions.rs` to `pub struct ServiceSpec` with `pub` fields, and re-export it from `lib.rs` as `pub use service_manager::ServiceSpec;`. Add `ServiceCommand` to the `pub use config::{…}` list in `lib.rs`.

- [ ] **Step 4: Run the parse test**

Run: `cargo test -p bibcode-server --lib config::tests::service_install_builds_a_spec_from_the_global_server_flags_only`
Expected: PASS.

- [ ] **Step 5: Add the run path**

In `apps/server/src/lib.rs` add `RunError` variants:

```rust
    #[error(transparent)]
    Service(#[from] service_manager::ServiceError),
    #[error("failed to encode service command output")]
    ServiceOutput(#[source] serde_json::Error),
```

Add the `run_cli` arm `CliAction::Service(command) => run_service_command(command),` (synchronous; wrap in `Ok(...)`/direct call as needed) and:

```rust
fn run_service_command(command: ServiceCommand) -> Result<(), RunError> {
    let platform = service_manager::ServicePlatform::current()
        .ok_or(service_manager::ServiceError::UnsupportedPlatform)?;
    let locations = service_manager::ServiceLocations::detect(platform)?;
    let runner = service_manager::ProcessCommandRunner;
    let (report, json) = match command {
        ServiceCommand::Install { spec, json } => (
            service_manager::install(&spec, platform, &locations, &runner)?,
            json,
        ),
        ServiceCommand::Uninstall { json } => (
            service_manager::uninstall(platform, &locations, &runner)?,
            json,
        ),
        ServiceCommand::Status { json } => (
            service_manager::status(platform, &locations, &runner)?,
            json,
        ),
    };
    if json {
        println!(
            "{}",
            serde_json::to_string(&report).map_err(RunError::ServiceOutput)?
        );
    } else {
        println!("Service: {}", report.definition);
        println!("State: {}", serde_json::to_value(report.state).map_err(RunError::ServiceOutput)?.as_str().unwrap_or("unknown"));
        for note in &report.notes {
            println!("Note: {note}");
        }
    }
    Ok(())
}
```

- [ ] **Step 6: Write and run the help smoke test**

Append to `apps/server/tests/cli_smoke.rs`:

```rust
#[test]
fn service_help_lists_install_uninstall_and_status() {
    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["service", "--help"])
        .output()
        .expect("run service help");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    for expected in ["install", "uninstall", "status"] {
        assert!(stdout.contains(expected), "missing {expected}: {stdout}");
    }
    let install = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["service", "install", "--help"])
        .output()
        .expect("run service install help");
    let stdout = String::from_utf8_lossy(&install.stdout);
    for expected in ["--host", "--port", "--base-dir", "--static-dir", "--json"] {
        assert!(stdout.contains(expected), "missing {expected}: {stdout}");
    }
}
```

Run: `cargo test -p bibcode-server --test cli_smoke service_help_lists_install_uninstall_and_status`
Expected: PASS. Also run `cargo test -p bibcode-server --test cli_smoke` to confirm the existing `serve --help` assertions still hold.

- [ ] **Step 7: Verify and commit**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings && cargo test -p bibcode-server --lib config::tests service_manager`

```bash
git add apps/server/src/config.rs apps/server/src/lib.rs apps/server/src/service_manager apps/server/tests/cli_smoke.rs
git commit -m "feat(cli): add bibcode service install, uninstall, and status"
```

---

### Task 4: Documentation for running the headless server as a user service

**Files:**
- Modify: `docs/user/server-installation.md`
- Modify: `docs/user/remote-access.md` (headless section)
- Modify: `docs/architecture/remote.md` (headless service paragraph)
- Modify: `docs/operations/observability.md:54-58`
- Modify: `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md`

- [ ] **Step 1: Server installation guide**

In `docs/user/server-installation.md`, replace the sentence "They do not contain Node.js and do not install a background service." with "They do not contain Node.js. Packages install no service; `bibcode service install` creates one per user on request." Replace the final sentence "They do not create a service, user, firewall rule, or machine-wide configuration." with "They do not create a user, firewall rule, or machine-wide configuration; the optional service is per user and created by `bibcode service install`."

Append a section:

````markdown
## Run as a per-user service

The server spawns provider CLIs and reads their credentials from your home
directory, so it must run as you, not as root or a service account.
`bibcode service install` creates a per-user service that starts `bibcode serve`
with the address you choose and restarts it after reboots:

```sh
bibcode service install --host 100.64.0.10
bibcode service status
bibcode service uninstall
```

The service definition records the `PATH` of the shell you ran the command
from, so provider CLIs installed there stay discoverable. Re-run
`bibcode service install` after installing a provider CLI in a new location.
The service passes `--no-startup-pairing-offer`; mint pairing codes with
`bibcode pairing offer`.

- **Linux** writes `~/.config/systemd/user/bibcode.service`, enables
  lingering so the service starts at boot without a login, and enables it.
  Over a plain SSH session the user service manager may not be reachable yet;
  the command then prints the three commands to run after lingering is on.
- **macOS** writes `~/Library/LaunchAgents/com.bibcode.server.plist`. A
  LaunchAgent runs only inside a logged-in session, so enable automatic login
  on a server Mac. A LaunchDaemon is not used because it cannot reach your
  keychain, where Claude Code stores its token.
- **Windows** creates a scheduled task named `BiBCode Server` that starts at
  your logon with limited privileges. Running without a logged-on user is not
  configured.
````

- [ ] **Step 2: Remote access guide**

In `docs/user/remote-access.md` under "## Headless server", after the paragraph beginning "`pairingCode` is a five-minute encrypted offer…" (added by the pairing plan) add:

```markdown
To keep the server running across reboots, install it as a per-user service
with `bibcode service install --host <address>`; see
[Standalone server installation](./server-installation.md#run-as-a-per-user-service).
```

- [ ] **Step 3: Architecture and observability**

In `docs/architecture/remote.md`, after the `bibcode pairing offer` paragraph added by the pairing plan, add:

```markdown
`bibcode service install` writes a per-user service definition (systemd user
unit, LaunchAgent, or logon scheduled task) that runs the absolute current
executable with `serve` and the captured `PATH`, and drives the platform's
user-level service manager. It never installs a system service or ships in the
Linux packages, because provider CLIs resolve from the process `PATH` and read
credentials from the user's home. The rendering and command sequence are
covered by unit tests through an injected command runner.
```

In `docs/operations/observability.md`, replace lines 54-58 with:

````markdown
In headless mode, run the native server from a terminal, or install the
per-user service (`bibcode service install`) whose stdout and stderr go to the
service manager's log (the journal on Linux, `~/Library/Logs/bibcode-server.log`
on macOS):

```bash
bibcode serve
```
````

- [ ] **Step 4: Runbooks**

Directly after the "Headless pairing" bullet added by the pairing plan in each of `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, and `docs/testing/windows-desktop.md` insert:

```markdown
- Headless service: on the second machine run `bibcode service install --host
  <routable address>`, confirm `bibcode service status` reports `active`,
  reboot that machine, and confirm the desktop's saved server reconnects
  without re-pairing. On Linux confirm `loginctl show-user $USER` reports
  `Linger=yes`; on macOS confirm automatic login is enabled; on Windows confirm
  the `BiBCode Server` task shows `Running` after logon. Finish with
  `bibcode service uninstall` and confirm the definition is gone.
```

- [ ] **Step 5: Verify and commit**

Run: `vp check`

```bash
git add docs/user/server-installation.md docs/user/remote-access.md docs/architecture/remote.md docs/operations/observability.md docs/testing/linux-desktop.md docs/testing/macos-desktop.md docs/testing/windows-desktop.md
git commit -m "docs: run the headless server as a per-user service"
```

---

### Task 5: Final gates

- [ ] **Step 1: Run the gate set**

```sh
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo test -p bibcode-server --lib service_manager config::tests
cargo test -p bibcode-server --test cli_smoke
vp check
vp run typecheck
vp test scripts/server-package-contract.test.ts
```

Expected: all pass; the package contract test proves `nfpm.yaml` is untouched.

- [ ] **Step 2: Real-machine check on this Linux host (runbook evidence, not CI)**

With no other `bibcode` running: `target/debug/bibcode service install --host 127.0.0.1 --port 3790 --base-dir /tmp/bibcode-service-check`, then `bibcode service status`, `systemctl --user is-active bibcode.service`, then `bibcode service uninstall` and confirm `~/.config/systemd/user/bibcode.service` is gone. Record the outcome in the final report; do not leave the service installed.
