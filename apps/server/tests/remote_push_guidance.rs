//! #343: a push that fails for missing credentials on a remote server says where Git ran and
//! how to recover, in Git Manager and in Source Control's stacked action, while the local
//! desktop keeps today's message and no caller is ever offered a sign-in it may not get.
//!
//! Every test re-runs itself in a child process whose global Git configuration is a throwaway
//! file, so the credential helper is the test's own and no real credential store is read.
#![cfg(unix)]

#[path = "support/git_http_auth_host.rs"]
mod git_http_auth_host;
#[path = "support/hermetic_providers.rs"]
mod hermetic_providers;
#[path = "support/isolated_git_config.rs"]
mod isolated_git_config;
#[path = "support/websocket_frames.rs"]
mod websocket_frames;

use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Duration,
};

use bibcode_server::{RpcExit, ServerConfig, ServerHandle, ServerMessage, ServerRuntime};
use futures_util::SinkExt;
use git_http_auth_host::GitHttpAuthHost;
use isolated_git_config::IsolatedGitConfig;
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
use websocket_frames::next_frame_past_heartbeat;

type TestSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const ISOLATED: &str = "BIBCODE_REMOTE_PUSH_GUIDANCE_ISOLATED";
static RELAUNCH: Mutex<()> = Mutex::new(());
const FRAME_BOUND: Duration = Duration::from_secs(60);
const BOOTSTRAP: &str = "remote-push-guidance-bootstrap";
const TOKEN_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const BOOTSTRAP_TOKEN_TYPE: &str = "urn:bibcode:params:oauth:token-type:environment-bootstrap";
const USER: &str = "test-user";
const PASSWORD: &str = "test-password";

const KNOWN_HOST_GUIDANCE: &str = "Push ran on the remote server example-server. In a terminal on example-server, open this repository as the user that runs BiBCode and run `git push` to sign in to Git. Then retry the push in BiBCode.";
const UNKNOWN_HOST_GUIDANCE: &str = "Push ran on the remote server. In a terminal on the remote server, open this repository as the user that runs BiBCode and run `git push` to sign in to Git. Then retry the push in BiBCode.";
const LOCAL_AUTHENTICATION_MESSAGE: &str =
    "Authentication failed. Check the configured credentials and try again.";
/// A credential helper that prints Git Credential Manager's refusal and answers nothing.
const GCM_REFUSING_HELPER: &str = "!f() { echo 'fatal: Cannot prompt because user interactivity has been disabled.' >&2; exit 1; }; f";
/// A credential helper that reports a timed-out lookup and answers nothing.
const TIMED_OUT_HELPER: &str = "!f() { echo 'credential lookup timed out' >&2; }; f";

/// Re-runs `test_name` alone in a child with an isolated global Git configuration; true in the
/// parent, which then returns.
fn relaunched(test_name: &str) -> bool {
    if std::env::var_os(ISOLATED).is_some() {
        return false;
    }
    let _guard = RELAUNCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let config = IsolatedGitConfig::new();
    let home = TempDir::new().expect("isolated home");
    let mut command = Command::new(std::env::current_exe().expect("test executable"));
    config.apply_to_command(&mut command);
    isolate_network_environment(&mut command, home.path());
    let output = command
        .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
        .env(ISOLATED, "1")
        .output()
        .expect("run the isolated test");
    assert!(
        output.status.success(),
        "isolated test {test_name} failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

fn is_proxy_or_netrc(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    name == "netrc" || name.ends_with("_proxy")
}

/// Keeps Git from authenticating with the developer's `.netrc` or reaching a proxy: a throwaway
/// `HOME`, no `NETRC` and no proxy variable, inherited or already set on `command`.
fn isolate_network_environment(command: &mut Command, home: &Path) {
    let names: Vec<OsString> = std::env::vars_os()
        .map(|(name, _)| name)
        .chain(command.get_envs().map(|(name, _)| name.to_owned()))
        .filter(|name| is_proxy_or_netrc(name))
        .collect();
    for name in names {
        command.env_remove(name);
    }
    command
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("NO_PROXY", "*")
        .env("no_proxy", "*");
}

#[test]
fn the_child_gets_a_throwaway_home_and_no_netrc_or_proxy() {
    let home = TempDir::new().expect("isolated home");
    let mut command = Command::new("true");
    command
        .env("NETRC", "/nonexistent/netrc")
        .env("https_proxy", "http://127.0.0.1:9")
        .env("HTTP_PROXY", "http://127.0.0.1:9")
        .env("ALL_PROXY", "http://127.0.0.1:9");
    isolate_network_environment(&mut command, home.path());
    let envs: Vec<(String, Option<String>)> = command
        .get_envs()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect();
    let value = |key: &str| {
        envs.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };
    for removed in ["NETRC", "https_proxy", "HTTP_PROXY", "ALL_PROXY"] {
        assert_eq!(value(removed), Some(None), "{removed} is removed");
    }
    for (name, _) in std::env::vars_os() {
        let name = name.to_string_lossy().into_owned();
        if is_proxy_or_netrc(OsStr::new(&name)) && !name.eq_ignore_ascii_case("no_proxy") {
            assert_eq!(value(&name), Some(None), "inherited {name} is removed");
        }
    }
    let home_path = home.path().to_string_lossy().into_owned();
    assert_eq!(value("HOME"), Some(Some(home_path.clone())));
    assert_eq!(
        value("XDG_CONFIG_HOME"),
        Some(Some(
            home.path().join(".config").to_string_lossy().into_owned()
        ))
    );
    assert_eq!(value("NO_PROXY"), Some(Some("*".to_owned())));
    assert_eq!(value("no_proxy"), Some(Some("*".to_owned())));
}

#[tokio::test]
async fn the_relaunched_child_runs_in_the_isolated_environment() {
    if relaunched("the_relaunched_child_runs_in_the_isolated_environment") {
        return;
    }
    let home = PathBuf::from(std::env::var_os("HOME").expect("child HOME"));
    assert!(home.is_dir(), "the throwaway home exists");
    assert!(
        home.starts_with(std::env::temp_dir()),
        "HOME is a temporary directory: {home:?}"
    );
    assert!(
        !home.join(".netrc").exists(),
        "no .netrc in the throwaway home"
    );
    assert_eq!(
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        Some(home.join(".config"))
    );
    for (name, value) in std::env::vars_os() {
        if name.eq_ignore_ascii_case("no_proxy") {
            assert_eq!(value, "*");
        } else {
            assert!(!is_proxy_or_netrc(&name), "{name:?} reached the child");
        }
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Replaces every inherited credential helper with `helper` in the isolated global config.
fn use_credential_helper(cwd: &Path, helper: &str) {
    let _ = Command::new("git")
        .current_dir(cwd)
        .args(["config", "--global", "--unset-all", "credential.helper"])
        .status();
    // An empty value clears helpers from every lower-priority file, the system one included.
    git(
        cwd,
        &["config", "--global", "--add", "credential.helper", ""],
    );
    git(
        cwd,
        &["config", "--global", "--add", "credential.helper", helper],
    );
    let helpers = git(cwd, &["config", "--get-all", "credential.helper"]);
    assert_eq!(
        helpers, helper,
        "only the test's helper after the empty reset"
    );
}

enum Mode {
    /// The desktop's in-process server, with the desktop app's own session.
    Local,
    /// A server the desktop did not start, named by `label`, with a paired session.
    Remote { label: &'static str },
}

struct Fixture {
    root: TempDir,
    _state: TempDir,
    _handle: ServerHandle,
    socket: TestSocket,
    checkout: PathBuf,
    bare: PathBuf,
    credentials: PathBuf,
    host: GitHttpAuthHost,
    next_id: usize,
}

impl Fixture {
    async fn start(mode: Mode) -> Self {
        let root = TempDir::new().expect("fixture root");
        let bare = root.path().join("served.git");
        let checkout = root.path().join("checkout");
        fs::create_dir(&checkout).expect("checkout directory");
        git(
            root.path(),
            &["init", "-q", "--bare", "-b", "main", "served.git"],
        );
        git(&checkout, &["init", "-q", "-b", "main"]);
        git(&checkout, &["config", "user.name", "Test User"]);
        git(&checkout, &["config", "user.email", "user@example.test"]);
        fs::write(checkout.join("tracked.txt"), "base\n").expect("base file");
        git(&checkout, &["add", "tracked.txt"]);
        git(&checkout, &["commit", "-q", "-m", "base"]);
        let bare_path = bare.to_string_lossy().into_owned();
        git(&checkout, &["remote", "add", "origin", &bare_path]);
        git(&checkout, &["push", "-q", "-u", "origin", "main"]);
        let host = GitHttpAuthHost::start(&bare, USER, PASSWORD);
        git(&checkout, &["remote", "set-url", "origin", &host.url()]);
        fs::write(checkout.join("tracked.txt"), "change to push\n").expect("change");
        git(&checkout, &["commit", "-q", "-am", "change to push"]);
        let credentials = root.path().join("credentials");
        fs::write(&credentials, "").expect("empty credential store");
        use_credential_helper(
            &checkout,
            &format!("store --file {}", credentials.to_string_lossy()),
        );

        let state = TempDir::new().expect("server state");
        let mut config = ServerConfig::new(state.path())
            .with_bind("127.0.0.1", 0)
            .with_desktop(BOOTSTRAP)
            .expect("desktop configuration");
        match mode {
            Mode::Local => config.interactive_git_sign_in = true,
            Mode::Remote { label } => {
                config.interactive_git_sign_in = false;
                config.environment_label = label.to_owned();
            }
        }
        hermetic_providers::ensure_hermetic_settings(&config.state_dir());
        let handle = ServerRuntime::start(config).await.expect("server starts");
        let client = Client::new();
        let administrator = exchange_token(&client, &handle, BOOTSTRAP).await;
        let mut admin_socket = authenticated_socket(&client, &handle, &administrator).await;
        request(
            &mut admin_socket,
            "1",
            "orchestration.dispatchCommand",
            json!({
                "type": "project.create",
                "commandId": "create-project",
                "projectId": "project-1",
                "title": "Remote push guidance",
                "workspaceRoot": checkout,
                "defaultModelSelection": null,
                "createdAt": "2026-11-09T00:00:00Z"
            }),
        )
        .await;
        drain(&mut admin_socket, "1").await;
        let socket = match mode {
            Mode::Local => admin_socket,
            Mode::Remote { .. } => {
                let pairing = response_json(
                    client
                        .post(http_url(&handle, "/api/auth/pairing-token"))
                        .bearer_auth(access_token(&administrator))
                        .json(&json!({
                            "label": "Paired client",
                            "scopes": ["orchestration:read", "orchestration:operate"]
                        }))
                        .send()
                        .await
                        .expect("pairing request"),
                    StatusCode::OK,
                )
                .await;
                let paired = exchange_token(
                    &client,
                    &handle,
                    pairing["credential"].as_str().expect("pairing credential"),
                )
                .await;
                authenticated_socket(&client, &handle, &paired).await
            }
        };
        Self {
            root,
            _state: state,
            _handle: handle,
            socket,
            checkout,
            bare,
            credentials,
            host,
            next_id: 0,
        }
    }

    fn id(&mut self) -> String {
        self.next_id += 1;
        (self.next_id + 1).to_string()
    }

    /// The terminal event of a Git Manager push: `finished` or `failed`.
    async fn git_manager_push(&mut self) -> Value {
        let payload = json!({
            "_tag": "push", "cwd": self.checkout, "projectId": "project-1",
            "remote": "origin", "localBranch": "main", "remoteBranch": null
        });
        self.git_manager(payload).await
    }

    /// The terminal event of a Git Manager tag create that pushes the tag to `origin`.
    async fn git_manager_tag_create_and_push(&mut self) -> Value {
        let payload = json!({
            "_tag": "tag-create", "cwd": self.checkout, "projectId": "project-1",
            "name": "v1", "sha": self.local_head(), "pushRemote": "origin"
        });
        self.git_manager(payload).await
    }

    async fn git_manager(&mut self, payload: Value) -> Value {
        let id = self.id();
        self.send_claiming_sign_in(&id, "gitManager.runOperation", payload)
            .await;
        let events = drain(&mut self.socket, &id).await;
        events
            .into_iter()
            .rfind(|event| matches!(event["_tag"].as_str(), Some("finished" | "failed")))
            .expect("terminal Git Manager event")
    }

    /// The terminal event of a Source Control stacked push.
    async fn stacked_push(&mut self) -> Value {
        let id = self.id();
        let payload =
            json!({ "actionId": format!("action-{id}"), "cwd": self.checkout, "action": "push" });
        self.send_claiming_sign_in(&id, "git.runStackedAction", payload)
            .await;
        let events = drain(&mut self.socket, &id).await;
        events
            .into_iter()
            .rfind(|event| {
                matches!(
                    event["kind"].as_str(),
                    Some("action_finished" | "action_failed")
                )
            })
            .expect("terminal stacked action event")
    }

    /// A header claiming sign-in eligibility, which the server must ignore (R10).
    async fn send_claiming_sign_in(&mut self, id: &str, tag: &str, payload: Value) {
        send(
            &mut self.socket,
            json!({
                "_tag": "Request", "id": id, "tag": tag, "payload": payload,
                "headers": [["x-bibcode-interactive-git-sign-in", "true"]]
            }),
        )
        .await;
    }

    fn store_matching_credential(&self) {
        let url = self.host.url();
        let authority = url
            .strip_prefix("http://")
            .and_then(|rest| rest.split('/').next())
            .expect("host authority");
        fs::write(
            &self.credentials,
            format!("http://{USER}:{PASSWORD}@{authority}\n"),
        )
        .expect("stored credential");
    }

    fn served_head(&self) -> String {
        git(&self.bare, &["rev-parse", "main"])
    }

    fn local_head(&self) -> String {
        git(&self.checkout, &["rev-parse", "HEAD"])
    }
}

fn message(event: &Value) -> &str {
    event["message"].as_str().expect("failure message")
}

fn assert_guidance(event: &Value, guidance: &str) {
    let message = message(event);
    assert!(
        message.starts_with(&format!("{guidance}\n\n")),
        "guidance, a blank line, then Git's text: {message}"
    );
    let last = message.trim_end().lines().last().unwrap_or_default();
    assert!(
        last.starts_with("fatal: could not read Username"),
        "ends with Git's own line: {message}"
    );
    assert!(event.get("signIn").is_none(), "no sign-in offer: {event}");
}

#[tokio::test]
async fn remote_push_guidance_known_host_git_manager() {
    if relaunched("remote_push_guidance_known_host_git_manager") {
        return;
    }
    let mut fixture = Fixture::start(Mode::Remote {
        label: "example-server",
    })
    .await;
    let failed = fixture.git_manager_push().await;
    assert_eq!(failed["_tag"], "failed", "{failed}");
    assert_eq!(failed["code"], "authentication", "{failed}");
    assert_guidance(&failed, KNOWN_HOST_GUIDANCE);
}

#[tokio::test]
async fn remote_push_guidance_after_a_timed_out_helper() {
    if relaunched("remote_push_guidance_after_a_timed_out_helper") {
        return;
    }
    let mut fixture = Fixture::start(Mode::Remote {
        label: "example-server",
    })
    .await;
    use_credential_helper(&fixture.checkout, TIMED_OUT_HELPER);
    let git_manager = fixture.git_manager_push().await;
    assert_eq!(git_manager["code"], "authentication", "{git_manager}");
    let stacked = fixture.stacked_push().await;
    for failed in [&git_manager, &stacked] {
        assert_guidance(failed, KNOWN_HOST_GUIDANCE);
        assert!(
            message(failed).contains("credential lookup timed out"),
            "{failed}"
        );
    }
}

#[tokio::test]
async fn remote_tag_push_guidance_keeps_the_created_tag_message() {
    if relaunched("remote_tag_push_guidance_keeps_the_created_tag_message") {
        return;
    }
    let mut fixture = Fixture::start(Mode::Remote {
        label: "example-server",
    })
    .await;
    let failed = fixture.git_manager_tag_create_and_push().await;
    assert_eq!(failed["_tag"], "failed", "{failed}");
    assert_eq!(failed["code"], "tag-push-failed", "{failed}");
    let message = message(&failed);
    let rest = message
        .strip_prefix("Created tag v1 locally, but pushing it to origin failed.\n\n")
        .unwrap_or_else(|| panic!("the partial-success line comes first: {message}"));
    assert!(
        rest.starts_with(&format!("{KNOWN_HOST_GUIDANCE}\n\n")),
        "{message}"
    );
    assert!(
        rest.trim_end()
            .lines()
            .last()
            .is_some_and(|line| line.starts_with("fatal: could not read Username")),
        "{message}"
    );
    assert_eq!(git(&fixture.checkout, &["tag", "--list", "v1"]), "v1");
}

#[tokio::test]
async fn remote_push_guidance_known_host_stacked_action() {
    if relaunched("remote_push_guidance_known_host_stacked_action") {
        return;
    }
    let mut fixture = Fixture::start(Mode::Remote {
        label: "example-server",
    })
    .await;
    let failed = fixture.stacked_push().await;
    assert_eq!(failed["kind"], "action_failed", "{failed}");
    assert_eq!(failed["phase"], "push", "{failed}");
    assert_guidance(&failed, KNOWN_HOST_GUIDANCE);
}

#[tokio::test]
async fn remote_push_guidance_unknown_host() {
    if relaunched("remote_push_guidance_unknown_host") {
        return;
    }
    let mut fixture = Fixture::start(Mode::Remote { label: "Local" }).await;
    for failed in [
        fixture.git_manager_push().await,
        fixture.stacked_push().await,
    ] {
        assert_guidance(&failed, UNKNOWN_HOST_GUIDANCE);
        let (guidance, git_text) = message(&failed).split_once("\n\n").expect("two parts");
        assert_eq!(guidance, UNKNOWN_HOST_GUIDANCE, "no invented name or path");
        assert!(!git_text.contains("Local"), "{git_text}");
        assert!(!message(&failed).contains("example-server"), "{failed}");
    }
}

#[tokio::test]
async fn remote_push_never_offers_sign_in() {
    if relaunched("remote_push_never_offers_sign_in") {
        return;
    }
    let mut fixture = Fixture::start(Mode::Remote {
        label: "example-server",
    })
    .await;
    let credential_store = format!("store --file {}", fixture.credentials.to_string_lossy());
    for helper in [credential_store.as_str(), GCM_REFUSING_HELPER] {
        use_credential_helper(&fixture.checkout, helper);
        for surface in ["git-manager", "stacked"] {
            let before = fixture.host.receive_pack_requests();
            let failed = if surface == "git-manager" {
                fixture.git_manager_push().await
            } else {
                fixture.stacked_push().await
            };
            assert!(
                failed.get("signIn").is_none(),
                "{helper} {surface}: {failed}"
            );
            assert_guidance(&failed, KNOWN_HOST_GUIDANCE);
            assert_eq!(
                fixture.host.receive_pack_requests(),
                before + 1,
                "{helper} {surface}: the push ran once"
            );
        }
    }
    assert_ne!(
        fixture.served_head(),
        fixture.local_head(),
        "nothing pushed"
    );
}

#[tokio::test]
async fn local_missing_username_keeps_todays_message() {
    if relaunched("local_missing_username_keeps_todays_message") {
        return;
    }
    let mut fixture = Fixture::start(Mode::Local).await;
    let git_manager = fixture.git_manager_push().await;
    assert_eq!(git_manager["code"], "authentication", "{git_manager}");
    assert_eq!(message(&git_manager), LOCAL_AUTHENTICATION_MESSAGE);
    let stacked = fixture.stacked_push().await;
    assert_eq!(stacked["kind"], "action_failed", "{stacked}");
    for failed in [&git_manager, &stacked] {
        assert!(!message(failed).contains("remote server"), "{failed}");
        assert!(failed.get("signIn").is_none(), "{failed}");
    }
}

#[tokio::test]
async fn plain_http_never_offers_sign_in() {
    if relaunched("plain_http_never_offers_sign_in") {
        return;
    }
    // The desktop's own session with GCM's refusal: only an HTTPS remote gets an offer.
    let mut fixture = Fixture::start(Mode::Local).await;
    use_credential_helper(&fixture.checkout, GCM_REFUSING_HELPER);
    let git_manager = fixture.git_manager_push().await;
    assert_eq!(git_manager["code"], "authentication", "{git_manager}");
    let stacked = fixture.stacked_push().await;
    for failed in [&git_manager, &stacked] {
        assert!(failed.get("signIn").is_none(), "{failed}");
        assert!(!message(failed).contains("remote server"), "{failed}");
    }
}

#[tokio::test]
async fn stored_credential_push_succeeds_in_both_modes() {
    if relaunched("stored_credential_push_succeeds_in_both_modes") {
        return;
    }
    for mode in [
        Mode::Remote {
            label: "example-server",
        },
        Mode::Local,
    ] {
        let mut fixture = Fixture::start(mode).await;
        fixture.store_matching_credential();
        let finished = fixture.git_manager_push().await;
        assert_eq!(finished["_tag"], "finished", "{finished}");
        assert_eq!(fixture.served_head(), fixture.local_head());

        fs::write(fixture.checkout.join("tracked.txt"), "stacked change\n").expect("change");
        git(
            &fixture.checkout,
            &["commit", "-q", "-am", "stacked change"],
        );
        let finished = fixture.stacked_push().await;
        assert_eq!(finished["kind"], "action_finished", "{finished}");
        assert_eq!(fixture.served_head(), fixture.local_head());
    }
}

#[tokio::test]
async fn unrelated_push_failures_keep_their_message() {
    if relaunched("unrelated_push_failures_keep_their_message") {
        return;
    }
    let mut fixture = Fixture::start(Mode::Remote {
        label: "example-server",
    })
    .await;
    fixture.store_matching_credential();

    // Non-fast-forward: another clone moves the served branch first.
    let other = fixture.root.path().join("other");
    let bare = fixture.bare.to_string_lossy().into_owned();
    git(fixture.root.path(), &["clone", "-q", &bare, "other"]);
    git(&other, &["config", "user.name", "Test User"]);
    git(&other, &["config", "user.email", "user@example.test"]);
    fs::write(other.join("other.txt"), "elsewhere\n").expect("other change");
    git(&other, &["add", "other.txt"]);
    git(&other, &["commit", "-q", "-m", "elsewhere"]);
    git(&other, &["push", "-q", "origin", "main"]);
    let rejected = fixture.git_manager_push().await;
    assert_eq!(rejected["code"], "non-fast-forward", "{rejected}");
    let stacked = fixture.stacked_push().await;
    assert_eq!(stacked["kind"], "action_failed", "{stacked}");
    for failed in [&rejected, &stacked] {
        assert!(!message(failed).contains("Push ran on"), "{failed}");
    }

    // Refused connection: a port nothing listens on.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").expect("free port");
    let address = closed.local_addr().expect("free address");
    drop(closed);
    let url = format!("http://{address}/served.git");
    git(&fixture.checkout, &["remote", "set-url", "origin", &url]);
    let refused = fixture.git_manager_push().await;
    assert_eq!(refused["_tag"], "failed", "{refused}");
    let stacked = fixture.stacked_push().await;
    assert_eq!(stacked["kind"], "action_failed", "{stacked}");
    for failed in [&refused, &stacked] {
        assert!(!message(failed).contains("Push ran on"), "{failed}");
    }
}

fn http_url(handle: &ServerHandle, path: &str) -> String {
    format!("http://{}{}", handle.local_addr(), path)
}

async fn exchange_token(client: &Client, handle: &ServerHandle, credential: &str) -> Value {
    response_json(
        client
            .post(http_url(handle, "/oauth/token"))
            .form(&[
                ("grant_type", TOKEN_GRANT_TYPE),
                ("subject_token", credential),
                ("subject_token_type", BOOTSTRAP_TOKEN_TYPE),
                ("requested_token_type", ACCESS_TOKEN_TYPE),
            ])
            .send()
            .await
            .expect("token exchange"),
        StatusCode::OK,
    )
    .await
}

fn access_token(response: &Value) -> &str {
    response["access_token"].as_str().expect("access token")
}

async fn authenticated_socket(client: &Client, handle: &ServerHandle, token: &Value) -> TestSocket {
    let ticket = response_json(
        client
            .post(http_url(handle, "/api/auth/websocket-ticket"))
            .bearer_auth(access_token(token))
            .send()
            .await
            .expect("WebSocket ticket"),
        StatusCode::OK,
    )
    .await["ticket"]
        .as_str()
        .expect("ticket")
        .to_owned();
    connect_async(format!("ws://{}/ws?wsTicket={ticket}", handle.local_addr()))
        .await
        .expect("WebSocket connects")
        .0
}

async fn response_json(response: reqwest::Response, expected: StatusCode) -> Value {
    let status = response.status();
    let body = response.text().await.expect("response body");
    assert_eq!(status, expected, "unexpected response: {body}");
    serde_json::from_str(&body).expect("JSON response")
}

async fn send(socket: &mut TestSocket, frame: Value) {
    socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .expect("send frame");
}

async fn request(socket: &mut TestSocket, id: &str, tag: &str, payload: Value) {
    send(
        socket,
        json!({"_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": []}),
    )
    .await;
}

/// Every value `id` streams, acknowledging each chunk, until it exits successfully.
async fn drain(socket: &mut TestSocket, id: &str) -> Vec<Value> {
    let mut values = Vec::new();
    loop {
        let frame = timeout(FRAME_BOUND, next_frame_past_heartbeat(socket))
            .await
            .expect("bounded RPC frame")
            .expect("WebSocket open")
            .expect("valid frame");
        let Message::Text(text) = frame else {
            panic!("expected a text frame: {frame:?}");
        };
        match serde_json::from_str::<ServerMessage>(&text).expect("server message") {
            ServerMessage::Chunk {
                request_id,
                values: chunk,
            } => {
                if request_id.as_str() == id {
                    values.extend(chunk);
                }
                send(
                    socket,
                    json!({"_tag": "Ack", "requestId": request_id.as_str()}),
                )
                .await;
            }
            ServerMessage::Exit {
                request_id,
                exit: RpcExit::Success { .. },
            } if request_id.as_str() == id => return values,
            ServerMessage::Exit { request_id, exit } if request_id.as_str() == id => {
                panic!("{id} failed: {exit:?}");
            }
            ServerMessage::Exit { .. } => {}
            other => panic!("unexpected frame while waiting for {id}: {other:?}"),
        }
    }
}
