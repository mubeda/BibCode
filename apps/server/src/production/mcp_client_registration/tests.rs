use std::{os::unix::fs::PermissionsExt as _, path::Path, path::PathBuf};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{Host, cli, register, registrations, unregister};
use crate::test_support::TestSandbox;

/// A stand-in CLI that keeps one `bibcode` entry in a state file and logs its argv.
/// `add_overwrites` behaves like a tool whose `add` replaces an entry (Codex); otherwise a
/// second `add` is refused (Claude Code).
fn fake_cli(sandbox: &TestSandbox, name: &str, add_overwrites: bool, add_fails: bool) -> PathBuf {
    let state = sandbox.path(format!("{name}.state"));
    let log = sandbox.path(format!("{name}.log"));
    let add = if add_fails {
        "echo 'Error: could not write the config file' >&2; exit 1".to_owned()
    } else if add_overwrites {
        format!("echo \"$*\" > '{}'; exit 0", state.display())
    } else {
        format!(
            "if [ -f '{state}' ]; then echo 'MCP server bibcode already exists in user config' >&2; exit 1; fi; echo \"$*\" > '{state}'; exit 0",
            state = state.display()
        )
    };
    sandbox.executable_script(
        name,
        &format!(
            r#"echo "$*" >> '{log}'
case "$2" in
  get) if [ -f '{state}' ]; then cat '{state}'; exit 0; fi; echo 'No MCP server named "bibcode".' >&2; exit 1 ;;
  add) {add} ;;
  remove) if [ -f '{state}' ]; then rm '{state}'; exit 0; fi; echo 'No MCP server named "bibcode" found' >&2; exit 1 ;;
esac
exit 2"#,
            log = log.display(),
            state = state.display(),
        ),
        "",
    )
}

/// A CLI that only has to exist: Cursor's and OpenCode's are never run.
fn present_cli(sandbox: &TestSandbox, name: &str) -> PathBuf {
    sandbox.executable_script(name, "exit 0", "")
}

struct Clients {
    claude: PathBuf,
    codex: PathBuf,
    cursor: PathBuf,
    opencode: PathBuf,
}

impl Clients {
    fn installed(sandbox: &TestSandbox) -> Self {
        Self {
            claude: fake_cli(sandbox, "claude", false, false),
            codex: fake_cli(sandbox, "codex", true, false),
            cursor: present_cli(sandbox, "cursor-agent"),
            opencode: present_cli(sandbox, "opencode"),
        }
    }

    fn settings(&self) -> Value {
        json!({
            "providers": {
                "claudeAgent": { "binaryPath": self.claude },
                "codex": { "binaryPath": self.codex },
                "cursor": { "binaryPath": self.cursor },
                "opencode": { "binaryPath": self.opencode },
            }
        })
    }
}

fn home(sandbox: &TestSandbox) -> PathBuf {
    let home = sandbox.path("home");
    std::fs::create_dir_all(&home).unwrap();
    home
}

fn log(sandbox: &TestSandbox, name: &str) -> Vec<String> {
    std::fs::read_to_string(sandbox.path(format!("{name}.log")))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn launch() -> Option<Vec<String>> {
    Some(vec![
        "/opt/BiBCode/bibcode".to_owned(),
        "mcp".to_owned(),
        "--base-dir".to_owned(),
        "/data root".to_owned(),
    ])
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn registered(read: &Value) -> Vec<(String, bool, bool)> {
    read["clients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|client| {
            (
                client["client"].as_str().unwrap().to_owned(),
                client["installed"].as_bool().unwrap(),
                client["registered"].as_bool().unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn adds_reads_and_removes_each_of_the_four_tools() {
    let sandbox = TestSandbox::new("mcp-client-registration");
    let clients = Clients::installed(&sandbox);
    let settings = clients.settings();
    let host = Host::for_home(&home(&sandbox));
    let none = CancellationToken::new();

    let before = registrations(&settings, &host, &none).await;
    assert_eq!(
        registered(&before),
        [
            ("claude".to_owned(), true, false),
            ("codex".to_owned(), true, false),
            ("cursor".to_owned(), true, false),
            ("opencode".to_owned(), true, false),
        ]
    );

    for client in ["claude", "codex", "cursor", "opencode"] {
        assert_eq!(
            register(&settings, launch(), json!({ "client": client }), &host)
                .await
                .unwrap(),
            json!({ "client": client, "installed": true, "registered": true, "error": null })
        );
    }
    assert_eq!(
        log(&sandbox, "claude").last().unwrap(),
        "mcp add --scope user bibcode -- /opt/BiBCode/bibcode mcp --base-dir /data root"
    );
    assert_eq!(
        log(&sandbox, "codex").last().unwrap(),
        "mcp add bibcode -- /opt/BiBCode/bibcode mcp --base-dir /data root"
    );
    assert_eq!(
        read_json(&host.home.join(".cursor/mcp.json")),
        json!({ "mcpServers": { "bibcode": {
            "command": "/opt/BiBCode/bibcode",
            "args": ["mcp", "--base-dir", "/data root"],
        }}})
    );
    assert_eq!(
        read_json(&host.home.join(".config/opencode/opencode.json")),
        json!({ "mcp": { "bibcode": {
            "type": "local",
            "command": ["/opt/BiBCode/bibcode", "mcp", "--base-dir", "/data root"],
            "enabled": true,
        }}})
    );
    let after = registrations(&settings, &host, &none).await;
    assert!(
        registered(&after)
            .iter()
            .all(|(_, _, registered)| *registered)
    );

    for client in ["claude", "codex", "cursor", "opencode"] {
        assert_eq!(
            unregister(&settings, json!({ "client": client }), &host)
                .await
                .unwrap()["registered"],
            false
        );
    }
    assert_eq!(
        log(&sandbox, "claude").last().unwrap(),
        "mcp remove bibcode"
    );
    assert_eq!(log(&sandbox, "codex").last().unwrap(), "mcp remove bibcode");
    let removed = registrations(&settings, &host, &none).await;
    assert!(
        registered(&removed)
            .iter()
            .all(|(_, _, registered)| !*registered)
    );
    // Removing what is already gone is not an error.
    for client in ["claude", "cursor"] {
        assert!(
            unregister(&settings, json!({ "client": client }), &host)
                .await
                .is_ok()
        );
    }
}

#[tokio::test]
async fn adding_again_replaces_the_entry_instead_of_failing() {
    let sandbox = TestSandbox::new("mcp-client-readd");
    let clients = Clients::installed(&sandbox);
    let settings = clients.settings();
    let host = Host::for_home(&home(&sandbox));
    for _ in 0..2 {
        for client in ["claude", "codex", "cursor", "opencode"] {
            register(&settings, launch(), json!({ "client": client }), &host)
                .await
                .unwrap_or_else(|error| panic!("{client}: {error}"));
        }
    }
    let claude_log = log(&sandbox, "claude");
    assert_eq!(
        claude_log[1..],
        [
            "mcp add --scope user bibcode -- /opt/BiBCode/bibcode mcp --base-dir /data root",
            "mcp get bibcode",
            "mcp remove --scope user bibcode",
            "mcp add --scope user bibcode -- /opt/BiBCode/bibcode mcp --base-dir /data root",
        ]
    );
    // Codex replaces on add, so it never removes.
    assert!(
        log(&sandbox, "codex")
            .iter()
            .all(|line| !line.contains("remove"))
    );
    let cursor = read_json(&host.home.join(".cursor/mcp.json"));
    assert_eq!(cursor["mcpServers"].as_object().unwrap().len(), 1);
}

#[tokio::test]
async fn config_edits_keep_every_other_entry_and_the_files_mode() {
    let sandbox = TestSandbox::new("mcp-client-config-keep");
    let clients = Clients::installed(&sandbox);
    let settings = clients.settings();
    let home = home(&sandbox);
    let host = Host::for_home(&home);
    let cursor = home.join(".cursor/mcp.json");
    let opencode = home.join(".config/opencode/opencode.json");
    write(
        &cursor,
        r#"{"zeta": 1, "mcpServers": {"github": {"command": "gh-mcp", "args": ["--x"], "env": {"Z": "1", "A": "2"}}}, "alpha": [true, null, 1.5]}"#,
    );
    std::fs::set_permissions(&cursor, std::fs::Permissions::from_mode(0o600)).unwrap();
    write(
        &opencode,
        r#"{"$schema": "https://opencode.ai/config.json", "theme": "dark", "mcp": {"sentry": {"type": "remote", "url": "https://mcp.sentry.dev/mcp"}}}"#,
    );

    for client in ["cursor", "opencode"] {
        register(&settings, launch(), json!({ "client": client }), &host)
            .await
            .unwrap();
    }
    let added = std::fs::read_to_string(&cursor).unwrap();
    // Keys stay in file order, nested ones included.
    let order = [
        "\"zeta\"",
        "\"mcpServers\"",
        "\"github\"",
        "\"Z\"",
        "\"A\"",
        "\"bibcode\"",
        "\"alpha\"",
    ]
    .map(|key| {
        added
            .find(key)
            .unwrap_or_else(|| panic!("{key} in {added}"))
    });
    assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "{added}");
    assert_eq!(
        std::fs::metadata(&cursor).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let opencode_added = read_json(&opencode);
    assert_eq!(opencode_added["theme"], "dark");
    assert_eq!(opencode_added["mcp"]["sentry"]["type"], "remote");
    assert_eq!(opencode_added["mcp"]["bibcode"]["type"], "local");

    for client in ["cursor", "opencode"] {
        unregister(&settings, json!({ "client": client }), &host)
            .await
            .unwrap();
    }
    assert_eq!(
        read_json(&cursor),
        json!({"zeta": 1, "mcpServers": {"github": {"command": "gh-mcp", "args": ["--x"], "env": {"Z": "1", "A": "2"}}}, "alpha": [true, null, 1.5]})
    );
    assert_eq!(
        read_json(&opencode),
        json!({"$schema": "https://opencode.ai/config.json", "theme": "dark", "mcp": {"sentry": {"type": "remote", "url": "https://mcp.sentry.dev/mcp"}}})
    );
    // No temporary file is left behind.
    let leftovers = std::fs::read_dir(home.join(".cursor"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(leftovers, ["mcp.json"]);
}

#[tokio::test]
async fn a_config_with_comments_or_a_broken_section_is_refused_and_untouched() {
    let sandbox = TestSandbox::new("mcp-client-config-malformed");
    let clients = Clients::installed(&sandbox);
    let settings = clients.settings();
    let home = home(&sandbox);
    let host = Host::for_home(&home);
    let opencode = home.join(".config/opencode/opencode.jsonc");
    let commented = "{\n  // my servers\n  \"mcp\": {}\n}\n";
    write(&opencode, commented);
    let cursor = home.join(".cursor/mcp.json");
    let broken = r#"{"mcpServers": ["not", "an", "object"]}"#;
    write(&cursor, broken);

    let error = register(&settings, launch(), json!({ "client": "opencode" }), &host)
        .await
        .unwrap_err();
    assert_eq!(error["reason"], "invalid_config");
    assert!(
        error["message"].as_str().unwrap().starts_with(
            "BiBCode left ~/.config/opencode/opencode.jsonc unchanged because it isn't plain JSON"
        ),
        "{error}"
    );
    assert_eq!(std::fs::read_to_string(&opencode).unwrap(), commented);
    assert!(!home.join(".config/opencode/opencode.json").exists());

    let error = unregister(&settings, json!({ "client": "cursor" }), &host)
        .await
        .unwrap_err();
    assert_eq!(
        error["message"],
        "BiBCode left ~/.cursor/mcp.json unchanged because its \"mcpServers\" isn't an object. Fix the file, or add BiBCode to Cursor by hand from Other MCP clients."
    );
    assert_eq!(std::fs::read_to_string(&cursor).unwrap(), broken);
    // The read reports the same problem for that tool only.
    let read = registrations(&settings, &host, &CancellationToken::new()).await;
    assert_eq!(read["clients"][2]["error"], error["message"]);
    assert_eq!(read["clients"][0]["error"], Value::Null);
}

#[tokio::test]
async fn a_tool_that_is_not_found_is_not_installed_and_nothing_is_created() {
    let sandbox = TestSandbox::new("mcp-client-missing");
    let missing = sandbox.path("no-such-cli");
    let settings = json!({
        "providers": {
            "claudeAgent": { "binaryPath": missing },
            "codex": { "binaryPath": missing },
            "cursor": { "binaryPath": missing },
            "opencode": { "binaryPath": missing },
        }
    });
    let home = home(&sandbox);
    let host = Host::for_home(&home);
    let read = registrations(&settings, &host, &CancellationToken::new()).await;
    assert!(
        registered(&read)
            .iter()
            .all(|(_, installed, _)| !*installed)
    );
    for client in ["claude", "cursor", "opencode"] {
        let error = register(&settings, launch(), json!({ "client": client }), &host)
            .await
            .unwrap_err();
        assert_eq!(error["reason"], "not_installed", "{client}");
    }
    assert_eq!(
        register(&settings, launch(), json!({ "client": "claude" }), &host)
            .await
            .unwrap_err()["message"],
        "Claude Code isn't installed where BiBCode runs. Install it, or set its path in its provider settings, then try again."
    );
    assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0);

    // Cursor's own folder is enough to find it without its CLI.
    std::fs::create_dir(home.join(".cursor")).unwrap();
    register(&settings, launch(), json!({ "client": "cursor" }), &host)
        .await
        .unwrap();
    assert_eq!(
        read_json(&home.join(".cursor/mcp.json"))["mcpServers"]["bibcode"]["command"],
        "/opt/BiBCode/bibcode"
    );
}

#[tokio::test]
async fn a_failing_add_says_what_the_cli_said_and_removes_nothing() {
    let sandbox = TestSandbox::new("mcp-client-failure");
    let mut clients = Clients::installed(&sandbox);
    clients.claude = fake_cli(&sandbox, "claude-failing", false, true);
    let error = register(
        &clients.settings(),
        launch(),
        json!({ "client": "claude" }),
        &Host::for_home(&home(&sandbox)),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error,
        json!({
            "_tag": "McpClientRegistrationError",
            "reason": "failed",
            "message": "Claude Code could not add BiBCode: Error: could not write the config file. Check that `claude mcp list` works in a terminal, then try again.",
        })
    );
    assert!(
        log(&sandbox, "claude-failing")
            .iter()
            .all(|line| !line.contains("remove"))
    );
}

#[tokio::test]
async fn an_unreadable_cli_reports_its_own_error_in_the_read() {
    let sandbox = TestSandbox::new("mcp-client-unreadable");
    let mut clients = Clients::installed(&sandbox);
    clients.claude = sandbox.executable_script(
        "claude-broken",
        "printf '\\033[31mconfig is corrupt\\033[0m\\n' >&2; exit 3",
        "",
    );
    let read = registrations(
        &clients.settings(),
        &Host::for_home(&home(&sandbox)),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(
        read["clients"][0]["error"],
        "Claude Code could not read its MCP servers: config is corrupt. Check that `claude mcp list` works in a terminal, then try again."
    );
    assert_eq!(read["clients"][1]["installed"], true);
}

#[tokio::test]
async fn without_a_launch_command_or_with_a_bad_payload_nothing_runs() {
    let sandbox = TestSandbox::new("mcp-client-unsupported");
    let clients = Clients::installed(&sandbox);
    let settings = clients.settings();
    let host = Host::for_home(&home(&sandbox));
    let unsupported = register(&settings, None, json!({ "client": "claude" }), &host)
        .await
        .unwrap_err();
    assert_eq!(unsupported["reason"], "unsupported");
    let invalid = register(&settings, launch(), json!({ "client": "gemini" }), &host)
        .await
        .unwrap_err();
    assert_eq!(invalid["reason"], "invalid");
    assert!(log(&sandbox, "claude").is_empty());
}

#[test]
fn a_summary_is_short_and_on_one_line() {
    assert_eq!(
        cli::summary("\n  first.\nsecond\nthird\nfourth\n"),
        "first. second third"
    );
    assert_eq!(
        cli::summary(&"x".repeat(400)).chars().count(),
        cli::SUMMARY_LIMIT + 1
    );
}
