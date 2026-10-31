use std::{
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    Host, State, cli,
    config_file::{ConfigFile, Moment},
    register, registrations, unregister,
};
use crate::test_support::TestSandbox;

/// How a stand-in CLI behaves. It keeps one `bibcode` entry in a state file (command, then
/// the space-joined arguments, then the arguments as JSON strings) and logs its argv.
#[derive(Clone, Copy, Default)]
struct Fake {
    /// Codex: `get --json` prints JSON and `add` overwrites. Otherwise Claude Code: `get`
    /// prints lines and a second `add` is refused.
    codex: bool,
    /// Every `add` fails.
    add_fails: bool,
    /// An `add` whose arguments contain this fails.
    fail_adds_of: Option<&'static str>,
}

const ADD_ERROR: &str = "Error: could not write the config file";

fn fake_cli(sandbox: &TestSandbox, name: &str, fake: Fake) -> PathBuf {
    let state = sandbox.path(format!("{name}.state"));
    let log = sandbox.path(format!("{name}.log"));
    let state = state.display();
    let get = if fake.codex {
        format!(
            r#"printf '{{"name":"bibcode","enabled":true,"transport":{{"type":"stdio","command":"%s","args":[%s]}}}}\n' "$(sed -n 1p '{state}')" "$(sed -n 3p '{state}')""#
        )
    } else {
        format!(
            r#"printf 'bibcode:\n  Scope: User config\n  Type: stdio\n  Command: %s\n  Args: %s\n' "$(sed -n 1p '{state}')" "$(sed -n 2p '{state}')""#
        )
    };
    let mut refuse = String::new();
    if fake.add_fails {
        refuse.push_str(&format!("echo '{ADD_ERROR}' >&2; exit 1;"));
    }
    if let Some(pattern) = fake.fail_adds_of {
        refuse.push_str(&format!(
            r#"case "$*" in *'{pattern}'*) echo '{ADD_ERROR}' >&2; exit 1 ;; esac;"#
        ));
    }
    if !fake.codex {
        refuse.push_str(&format!(
            "if [ -f '{state}' ]; then echo 'MCP server bibcode already exists in user config' >&2; exit 1; fi;"
        ));
    }
    sandbox.executable_script(
        name,
        &format!(
            r#"echo "$*" >> '{log}'
case "$2" in
  get) if [ ! -f '{state}' ]; then echo 'No MCP server named "bibcode".' >&2; exit 1; fi; {get}; exit 0 ;;
  add) {refuse}
    while [ "$1" != "--" ]; do shift; done; shift
    printf '%s\n' "$1" > '{state}'; shift
    printf '%s\n' "$*" >> '{state}'
    json=""; for a in "$@"; do json="$json${{json:+,}}\"$a\""; done
    printf '%s\n' "$json" >> '{state}'; exit 0 ;;
  remove) if [ -f '{state}' ]; then rm '{state}'; exit 0; fi; echo 'No MCP server named "bibcode" found' >&2; exit 1 ;;
esac
exit 2"#,
            log = log.display(),
        ),
        "",
    )
}

/// Seeds a stand-in CLI's entry, as an earlier install would have left it.
fn seed_cli_entry(sandbox: &TestSandbox, name: &str, launch: &[&str]) {
    let json = launch[1..]
        .iter()
        .map(|arg| format!("\"{arg}\""))
        .collect::<Vec<_>>()
        .join(",");
    std::fs::write(
        sandbox.path(format!("{name}.state")),
        format!("{}\n{}\n{json}\n", launch[0], launch[1..].join(" ")),
    )
    .unwrap();
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
            claude: fake_cli(sandbox, "claude", Fake::default()),
            codex: fake_cli(
                sandbox,
                "codex",
                Fake {
                    codex: true,
                    ..Fake::default()
                },
            ),
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

const LAUNCH: [&str; 4] = ["/opt/BiBCode/bibcode", "mcp", "--base-dir", "/data root"];
const OLD_LAUNCH: [&str; 4] = ["/old/BiBCode/bibcode", "mcp", "--base-dir", "/old root"];

fn launch() -> Option<Vec<String>> {
    Some(LAUNCH.map(str::to_owned).to_vec())
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

async fn read_all(settings: &Value, host: &Host) -> Value {
    registrations(
        settings,
        launch().as_deref(),
        host,
        &CancellationToken::new(),
    )
    .await
}

/// `(client, installed, registered, upToDate)` of every line.
fn lines(read: &Value) -> Vec<(String, bool, bool, Value)> {
    read["clients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|client| {
            (
                client["client"].as_str().unwrap().to_owned(),
                client["installed"].as_bool().unwrap(),
                client["registered"].as_bool().unwrap(),
                client["upToDate"].clone(),
            )
        })
        .collect()
}

const ALL: [&str; 4] = ["claude", "codex", "cursor", "opencode"];

#[tokio::test]
async fn adds_reads_and_removes_each_of_the_four_tools() {
    let sandbox = TestSandbox::new("mcp-client-registration");
    let clients = Clients::installed(&sandbox);
    let settings = clients.settings();
    let host = Host::for_home(&home(&sandbox));

    let before = read_all(&settings, &host).await;
    assert_eq!(
        lines(&before),
        ALL.map(|client| (client.to_owned(), true, false, Value::Null))
    );

    for client in ALL {
        assert_eq!(
            register(&settings, launch(), json!({ "client": client }), &host)
                .await
                .unwrap(),
            json!({ "client": client, "installed": true, "registered": true, "upToDate": true, "error": null })
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
    // Every tool's entry is read back and runs this server's command.
    let after = read_all(&settings, &host).await;
    assert_eq!(
        lines(&after),
        ALL.map(|client| (client.to_owned(), true, true, json!(true)))
    );
    assert!(log(&sandbox, "codex").contains(&"mcp get bibcode --json".to_owned()));

    for client in ALL {
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
    let removed = read_all(&settings, &host).await;
    assert!(
        lines(&removed)
            .iter()
            .all(|(_, _, registered, _)| !*registered)
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
async fn an_entry_for_another_command_is_out_of_date_until_updated() {
    let sandbox = TestSandbox::new("mcp-client-out-of-date");
    let clients = Clients::installed(&sandbox);
    let settings = clients.settings();
    let home = home(&sandbox);
    let host = Host::for_home(&home);
    seed_cli_entry(&sandbox, "claude", &OLD_LAUNCH);
    seed_cli_entry(&sandbox, "codex", &OLD_LAUNCH);
    write(
        &home.join(".cursor/mcp.json"),
        r#"{"mcpServers": {"bibcode": {"command": "/old/BiBCode/bibcode", "args": ["mcp"]}}}"#,
    );
    write(
        &home.join(".config/opencode/opencode.json"),
        r#"{"mcp": {"bibcode": {"type": "local", "command": ["/old/BiBCode/bibcode", "mcp"], "enabled": true}}}"#,
    );

    let stale = read_all(&settings, &host).await;
    assert_eq!(
        lines(&stale),
        ALL.map(|client| (client.to_owned(), true, true, json!(false)))
    );
    // Update is the same request as Add, and replaces each entry.
    for client in ALL {
        register(&settings, launch(), json!({ "client": client }), &host)
            .await
            .unwrap_or_else(|error| panic!("{client}: {error}"));
    }
    let updated = read_all(&settings, &host).await;
    assert_eq!(
        lines(&updated),
        ALL.map(|client| (client.to_owned(), true, true, json!(true)))
    );
    assert_eq!(
        log(&sandbox, "claude")[1..5],
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
}

#[tokio::test]
async fn an_entry_that_cannot_be_read_back_is_registered_with_an_unknown_command() {
    let sandbox = TestSandbox::new("mcp-client-unknown");
    let mut clients = Clients::installed(&sandbox);
    clients.claude = sandbox.executable_script(
        "claude-terse",
        "case \"$2\" in get) echo 'bibcode: connected'; exit 0 ;; esac; exit 2",
        "",
    );
    let read = read_all(&clients.settings(), &Host::for_home(&home(&sandbox))).await;
    assert_eq!(
        lines(&read)[0],
        ("claude".to_owned(), true, true, Value::Null)
    );
}

/// An old entry whose data root holds ` --`: Claude Code prints it joined with spaces, so
/// only its own JSON config gives the arguments back exactly.
const TRICKY_LAUNCH: [&str; 4] = [
    "/old/BiBCode/bibcode",
    "mcp",
    "--base-dir",
    "/work --archive",
];

/// Claude Code's user-scope `~/.claude.json` with BiBCode's entry, as `claude mcp add
/// --scope user` writes it.
fn seed_claude_json(home: &Path, launch: &[&str]) {
    write(
        &home.join(".claude.json"),
        &json!({
            "numStartups": 3,
            "mcpServers": {
                "bibcode": { "type": "stdio", "command": launch[0], "args": launch[1..] },
            },
        })
        .to_string(),
    );
}

fn failing_new_adds(sandbox: &TestSandbox, name: &str) -> Clients {
    let mut clients = Clients::installed(sandbox);
    clients.claude = fake_cli(
        sandbox,
        name,
        Fake {
            fail_adds_of: Some("/opt/BiBCode/bibcode"),
            ..Fake::default()
        },
    );
    seed_cli_entry(sandbox, name, &TRICKY_LAUNCH);
    clients
}

#[tokio::test]
async fn a_failed_claude_replacement_puts_back_the_exact_previous_arguments() {
    let sandbox = TestSandbox::new("mcp-client-restore");
    let clients = failing_new_adds(&sandbox, "claude-restore");
    let home = home(&sandbox);
    seed_claude_json(&home, &TRICKY_LAUNCH);
    let error = register(
        &clients.settings(),
        launch(),
        json!({ "client": "claude" }),
        &Host::for_home(&home),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error["message"],
        format!(
            "Claude Code could not add BiBCode: {ADD_ERROR}. Its previous BiBCode entry was put back. Check that `claude mcp list` works in a terminal, then try again."
        )
    );
    // The fake keeps each argument as a JSON string: `/work --archive` stays one argument.
    assert_eq!(
        std::fs::read_to_string(sandbox.path("claude-restore.state"))
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        [
            "/old/BiBCode/bibcode",
            "mcp --base-dir /work --archive",
            r#""mcp","--base-dir","/work --archive""#,
        ]
    );
}

#[tokio::test]
async fn without_the_exact_previous_arguments_nothing_is_claimed_restored() {
    let sandbox = TestSandbox::new("mcp-client-no-exact");
    let clients = failing_new_adds(&sandbox, "claude-no-exact");
    let home = home(&sandbox);
    let expected = format!(
        "Claude Code could not add BiBCode: {ADD_ERROR}. BiBCode had removed its previous entry (`/old/BiBCode/bibcode mcp --base-dir /work --archive`) and could not put it back. Fix the problem, then click Add to Claude Code, or run `claude mcp add --scope user bibcode --` followed by the command under Other MCP clients."
    );
    // No `~/.claude.json` entry: the printed line is never split into a guess.
    let error = register(
        &clients.settings(),
        launch(),
        json!({ "client": "claude" }),
        &Host::for_home(&home),
    )
    .await
    .unwrap_err();
    assert_eq!(error["message"], expected);
    let adds = |sandbox: &TestSandbox, name: &str| {
        log(sandbox, name)
            .iter()
            .filter(|line| line.starts_with("mcp add"))
            .count()
    };
    assert_eq!(adds(&sandbox, "claude-no-exact"), 2, "no restore was tried");

    // A JSON entry that is not the one `claude mcp get` showed is not trusted either.
    let sandbox = TestSandbox::new("mcp-client-mismatch");
    let clients = failing_new_adds(&sandbox, "claude-mismatch");
    let home = self::home(&sandbox);
    seed_claude_json(&home, &OLD_LAUNCH);
    let error = register(
        &clients.settings(),
        launch(),
        json!({ "client": "claude" }),
        &Host::for_home(&home),
    )
    .await
    .unwrap_err();
    assert_eq!(error["message"], expected);
    assert_eq!(adds(&sandbox, "claude-mismatch"), 2, "no restore was tried");
}

#[tokio::test]
async fn a_replacement_that_cannot_restore_says_what_was_removed_and_how_to_add_it() {
    let sandbox = TestSandbox::new("mcp-client-lost");
    let mut clients = Clients::installed(&sandbox);
    clients.claude = fake_cli(
        &sandbox,
        "claude-lost",
        Fake {
            fail_adds_of: Some("bibcode --"),
            ..Fake::default()
        },
    );
    seed_cli_entry(&sandbox, "claude-lost", &OLD_LAUNCH);
    let home = home(&sandbox);
    seed_claude_json(&home, &OLD_LAUNCH);
    let error = register(
        &clients.settings(),
        launch(),
        json!({ "client": "claude" }),
        &Host::for_home(&home),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error["message"],
        format!(
            "Claude Code could not add BiBCode: {ADD_ERROR}. BiBCode had removed its previous entry (`/old/BiBCode/bibcode mcp --base-dir /old root`) and could not put it back. Fix the problem, then click Add to Claude Code, or run `claude mcp add --scope user bibcode --` followed by the command under Other MCP clients."
        )
    );
}

#[tokio::test]
async fn an_entry_whose_health_check_fails_is_still_replaced() {
    let sandbox = TestSandbox::new("mcp-client-stale");
    let mut clients = Clients::installed(&sandbox);
    let state = sandbox.path("claude-stale.state");
    let log_path = sandbox.path("claude-stale.log");
    std::fs::write(&state, "old").unwrap();
    // A registered entry pointing at a build that no longer exists: `get` fails its check.
    clients.claude = sandbox.executable_script(
        "claude-stale",
        &format!(
            r#"echo "$*" >> '{log}'
case "$2" in
  get) echo 'bibcode: Failed to connect' >&2; exit 3 ;;
  add) if [ -f '{state}' ]; then echo 'MCP server bibcode already exists' >&2; exit 1; fi; echo new > '{state}'; exit 0 ;;
  remove) rm -f '{state}'; exit 0 ;;
esac"#,
            log = log_path.display(),
            state = state.display(),
        ),
        "",
    );
    register(
        &clients.settings(),
        launch(),
        json!({ "client": "claude" }),
        &Host::for_home(&home(&sandbox)),
    )
    .await
    .expect("replaces the stale entry");
    assert_eq!(std::fs::read_to_string(&state).unwrap().trim(), "new");
    assert!(
        log(&sandbox, "claude-stale")
            .iter()
            .any(|line| line == "mcp remove --scope user bibcode")
    );
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
    let cursor_before = r#"{"zeta": 1, "mcpServers": {"github": {"command": "gh-mcp", "args": ["--x"], "env": {"Z": "1", "A": "2"}}}, "alpha": [true, null, 1.5]}"#;
    write(&cursor, cursor_before);
    std::fs::set_permissions(&cursor, std::fs::Permissions::from_mode(0o600)).unwrap();
    let opencode_before = r#"{"$schema": "https://opencode.ai/config.json", "theme": "dark", "mcp": {"sentry": {"type": "remote", "url": "https://mcp.sentry.dev/mcp"}}}"#;
    write(&opencode, opencode_before);

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
        serde_json::from_str::<Value>(cursor_before).unwrap()
    );
    assert_eq!(
        read_json(&opencode),
        serde_json::from_str::<Value>(opencode_before).unwrap()
    );
    // No temporary file is left behind.
    let leftovers = std::fs::read_dir(home.join(".cursor"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(leftovers, ["mcp.json"]);
}

#[tokio::test]
async fn opencode_changes_the_file_that_holds_the_entry_and_refuses_one_with_comments() {
    let sandbox = TestSandbox::new("mcp-client-opencode-both");
    let clients = Clients::installed(&sandbox);
    let settings = clients.settings();
    let home = home(&sandbox);
    let host = Host::for_home(&home);
    let json_path = home.join(".config/opencode/opencode.json");
    let jsonc_path = home.join(".config/opencode/opencode.jsonc");
    write(&json_path, r#"{"theme": "dark"}"#);

    // An old entry in a plain-JSON `opencode.jsonc` is the one updated; `opencode.json`
    // gains no second entry.
    write(
        &jsonc_path,
        r#"{"mcp": {"bibcode": {"type": "local", "command": ["/old/BiBCode/bibcode", "mcp"], "enabled": true}}}"#,
    );
    let stale = read_all(&settings, &host).await;
    assert_eq!(lines(&stale)[3].3, json!(false));
    register(&settings, launch(), json!({ "client": "opencode" }), &host)
        .await
        .unwrap();
    assert_eq!(read_json(&json_path), json!({ "theme": "dark" }));
    assert_eq!(
        read_json(&jsonc_path)["mcp"]["bibcode"]["command"][0],
        "/opt/BiBCode/bibcode"
    );
    assert_eq!(lines(&read_all(&settings, &host).await)[3].3, json!(true));

    // The same old entry in a `.jsonc` with comments is read, but not rewritten.
    let commented = "{\n  // mine\n  \"mcp\": {\"bibcode\": {\"type\": \"local\", \"command\": [\"/old/BiBCode/bibcode\", \"mcp\"], \"enabled\": true},},\n}\n";
    write(&jsonc_path, commented);
    let read = read_all(&settings, &host).await;
    assert_eq!(
        lines(&read)[3],
        ("opencode".to_owned(), true, true, json!(false))
    );
    let error = register(&settings, launch(), json!({ "client": "opencode" }), &host)
        .await
        .unwrap_err();
    assert_eq!(
        error["message"],
        "BiBCode left ~/.config/opencode/opencode.jsonc unchanged because it has comments or trailing commas, which BiBCode would lose. Fix the file, or add BiBCode to OpenCode by hand from Other MCP clients."
    );
    assert_eq!(std::fs::read_to_string(&jsonc_path).unwrap(), commented);
    assert_eq!(read_json(&json_path), json!({ "theme": "dark" }));
}

#[tokio::test]
async fn a_config_saved_by_another_program_meanwhile_is_read_again_not_overwritten() {
    let sandbox = TestSandbox::new("mcp-client-concurrent");
    let home = home(&sandbox);
    let directory = home.join(".cursor");
    let path = directory.join("mcp.json");
    write(
        &path,
        r#"{"mcpServers": {"github": {"command": "gh-mcp"}}}"#,
    );
    // Cursor saves a second server once, between BiBCode's read and its rename.
    let saves = Arc::new(AtomicUsize::new(0));
    let counter = saves.clone();
    let file = ConfigFile::cursor(directory.clone(), &home).with_interference(Arc::new(
        move |destination: &Path, moment| {
            if moment == Moment::BeforeCheck && counter.fetch_add(1, Ordering::SeqCst) == 0 {
                std::fs::write(
                    destination,
                    r#"{"mcpServers": {"github": {"command": "gh-mcp"}, "linear": {"command": "linear-mcp"}}}"#,
                )
                .unwrap();
            }
        },
    ));
    file.add(&launch().unwrap()).await.unwrap();
    let saved = read_json(&path);
    assert_eq!(saved["mcpServers"]["linear"]["command"], "linear-mcp");
    assert_eq!(saved["mcpServers"]["github"]["command"], "gh-mcp");
    assert_eq!(
        saved["mcpServers"]["bibcode"]["command"],
        "/opt/BiBCode/bibcode"
    );
    assert_eq!(saves.load(Ordering::SeqCst), 2);

    // A file that changes on every attempt is left to its owner, with a message.
    let busy = ConfigFile::cursor(directory, &home).with_interference(Arc::new(
        |destination: &Path, moment| {
            if moment == Moment::BeforeCheck {
                let stamp = uuid::Uuid::new_v4();
                std::fs::write(
                    destination,
                    format!(r#"{{"mcpServers": {{}}, "stamp": "{stamp}"}}"#),
                )
                .unwrap();
            }
        },
    ));
    let error = busy.add(&launch().unwrap()).await.unwrap_err();
    assert_eq!(
        error["message"],
        "~/.cursor/mcp.json kept changing while BiBCode was saving it. Close the apps that edit it, then try again."
    );
    assert!(read_json(&path)["mcpServers"].get("bibcode").is_none());
}

#[tokio::test]
async fn a_save_that_lands_with_the_rename_is_reported_not_claimed_as_success() {
    let sandbox = TestSandbox::new("mcp-client-raced");
    let home = home(&sandbox);
    let directory = home.join(".cursor");
    let path = directory.join("mcp.json");
    write(
        &path,
        r#"{"mcpServers": {"github": {"command": "gh-mcp"}}}"#,
    );
    // Cursor saves its own copy right as BiBCode renames: no lock between the two apps.
    let raced =
        r#"{"mcpServers": {"github": {"command": "gh-mcp"}, "linear": {"command": "linear-mcp"}}}"#;
    let file = ConfigFile::cursor(directory.clone(), &home).with_interference(Arc::new(
        move |destination: &Path, moment| {
            if moment == Moment::AfterRename {
                std::fs::write(destination, raced).unwrap();
            }
        },
    ));
    let error = file.add(&launch().unwrap()).await.unwrap_err();
    assert_eq!(
        error["message"],
        "Another app changed ~/.cursor/mcp.json at the same time as BiBCode. Check the file, then try again."
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), raced);
    let read = ConfigFile::cursor(directory, &home)
        .read(launch().as_deref())
        .await
        .unwrap();
    assert_eq!(read, State::Absent);
}

#[tokio::test]
async fn a_disabled_opencode_entry_is_out_of_date_and_update_enables_it() {
    let sandbox = TestSandbox::new("mcp-client-opencode-disabled");
    let clients = Clients::installed(&sandbox);
    let settings = clients.settings();
    let home = home(&sandbox);
    let host = Host::for_home(&home);
    let path = home.join(".config/opencode/opencode.json");
    let entry = |extra: Value| {
        let mut entry = json!({ "type": "local", "command": LAUNCH, "enabled": true });
        entry
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({ "mcp": { "bibcode": entry } }).to_string()
    };
    for (stale, why) in [
        (json!({ "enabled": false }), "turned off"),
        (json!({ "type": "remote" }), "not local"),
    ] {
        write(&path, &entry(stale));
        assert_eq!(
            lines(&read_all(&settings, &host).await)[3].3,
            json!(false),
            "{why}"
        );
        register(&settings, launch(), json!({ "client": "opencode" }), &host)
            .await
            .unwrap();
        assert_eq!(
            read_json(&path)["mcp"]["bibcode"],
            json!({ "type": "local", "command": LAUNCH, "enabled": true })
        );
        assert_eq!(
            lines(&read_all(&settings, &host).await)[3].3,
            json!(true),
            "{why}"
        );
    }
    // Leaving out `enabled` is OpenCode's default: on.
    write(
        &path,
        &json!({ "mcp": { "bibcode": { "type": "local", "command": LAUNCH } } }).to_string(),
    );
    assert_eq!(lines(&read_all(&settings, &host).await)[3].3, json!(true));
}

#[tokio::test]
async fn concurrent_changes_by_bibcode_all_land() {
    let sandbox = TestSandbox::new("mcp-client-serial");
    let home = home(&sandbox);
    let directory = home.join(".cursor");
    let path = directory.join("mcp.json");
    write(
        &path,
        r#"{"mcpServers": {"github": {"command": "gh-mcp"}}}"#,
    );
    let file = ConfigFile::cursor(directory, &home);
    let launch = launch().unwrap();
    let changes = (0..8).map(|index| {
        let file = file.clone();
        let launch = launch.clone();
        async move {
            if index % 2 == 0 {
                file.add(&launch).await
            } else {
                file.remove().await
            }
        }
    });
    for result in futures_util::future::join_all(changes).await {
        result.expect("each change waits for the one before it");
    }
    let saved = read_json(&path);
    assert_eq!(saved["mcpServers"]["github"]["command"], "gh-mcp");
}

#[tokio::test]
async fn a_linked_config_is_changed_only_inside_the_tools_folder() {
    let sandbox = TestSandbox::new("mcp-client-symlink");
    let clients = Clients::installed(&sandbox);
    let settings = clients.settings();
    let home = home(&sandbox);
    let host = Host::for_home(&home);
    let cursor = home.join(".cursor");

    // Inside `~/.cursor`: the link stays a link, and its target keeps its mode.
    let inside = cursor.join("profiles/mcp.json");
    write(&inside, r#"{"mcpServers": {}}"#);
    std::fs::set_permissions(&inside, std::fs::Permissions::from_mode(0o640)).unwrap();
    std::os::unix::fs::symlink(&inside, cursor.join("mcp.json")).unwrap();
    register(&settings, launch(), json!({ "client": "cursor" }), &host)
        .await
        .unwrap();
    assert!(cursor.join("mcp.json").is_symlink());
    assert_eq!(
        read_json(&inside)["mcpServers"]["bibcode"]["args"][0],
        "mcp"
    );
    assert_eq!(
        std::fs::metadata(&inside).unwrap().permissions().mode() & 0o777,
        0o640
    );

    // Outside it (a dotfiles checkout): refused, and both the link and its target unchanged.
    let outside = home.join("dotfiles/cursor-mcp.json");
    let before = r#"{"mcpServers": {"github": {"command": "gh-mcp"}}}"#;
    write(&outside, before);
    std::fs::remove_file(cursor.join("mcp.json")).unwrap();
    std::os::unix::fs::symlink(&outside, cursor.join("mcp.json")).unwrap();
    let error = register(&settings, launch(), json!({ "client": "cursor" }), &host)
        .await
        .unwrap_err();
    assert_eq!(
        error["message"],
        "BiBCode left ~/.cursor/mcp.json unchanged because it is a link to ~/dotfiles/cursor-mcp.json, outside ~/.cursor. Fix the file, or add BiBCode to Cursor by hand from Other MCP clients."
    );
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), before);
    assert!(cursor.join("mcp.json").is_symlink());
}

#[tokio::test]
async fn a_malformed_config_is_refused_and_untouched() {
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
    write(&cursor, "{ not json");
    let error = register(&settings, launch(), json!({ "client": "cursor" }), &host)
        .await
        .unwrap_err();
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .starts_with("BiBCode left ~/.cursor/mcp.json unchanged because it isn't valid JSON ("),
        "{error}"
    );
    assert_eq!(std::fs::read_to_string(&cursor).unwrap(), "{ not json");
    // The read reports the problem for that tool only.
    let read = read_all(&settings, &host).await;
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
    let read = read_all(&settings, &host).await;
    assert!(lines(&read).iter().all(|(_, installed, _, _)| !*installed));
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
    clients.claude = fake_cli(
        &sandbox,
        "claude-failing",
        Fake {
            add_fails: true,
            ..Fake::default()
        },
    );
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
            "message": format!("Claude Code could not add BiBCode: {ADD_ERROR}. Check that `claude mcp list` works in a terminal, then try again."),
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
    let read = read_all(&clients.settings(), &Host::for_home(&home(&sandbox))).await;
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

#[test]
fn jsonc_is_read_without_its_comments_and_trailing_commas() {
    let read = super::ordered_json::parse_jsonc(
        "{\n  // a \"quoted\" comment\n  \"a\": \"// not a comment\", /* block */\n  \"b\": [1, 2,],\n}\n",
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&read).unwrap(),
        json!({ "a": "// not a comment", "b": [1, 2] })
    );
}
