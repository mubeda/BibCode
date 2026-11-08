//! Source Control's pull and stacked push: Cancel and the Git Credential Manager sign-in (#325).

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::GitVcsRpcServices;
use crate::{
    RequestId,
    auth::{AuthService, Principal},
    config::ServerConfig,
    git::{
        BoxGitProcessFuture, GitProcessRunner, GitRepository, ProcessError, ProcessOutput,
        ProcessRequest, ProcessRunner,
    },
    rpc::{RpcRequest, RpcSessionContext},
};

const GCM_STDERR: &str = "fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
const DESTINATION: &str = "https://github.com/owner/repo.git";

/// A checkout on `main` tracking `origin/main`, whose network step (`pull`, or `push` for the
/// stacked action) fails with `stderr`, or waits for Cancel when `hang` is set.
struct NetworkRunner {
    stderr: &'static str,
    hang: bool,
    urls: Mutex<&'static str>,
    killed: AtomicBool,
    network_spawns: Mutex<usize>,
    /// Runs every other command with real Git and this global configuration.
    real_git_global: Option<PathBuf>,
}

impl NetworkRunner {
    fn new(stderr: &'static str, hang: bool) -> Arc<Self> {
        Arc::new(Self {
            stderr,
            hang,
            urls: Mutex::new(DESTINATION),
            killed: AtomicBool::new(false),
            network_spawns: Mutex::new(0),
            real_git_global: None,
        })
    }

    fn real(stderr: &'static str, hang: bool, checkout: &RealCheckout) -> Arc<Self> {
        Arc::new(Self {
            stderr,
            hang,
            urls: Mutex::new(DESTINATION),
            killed: AtomicBool::new(false),
            network_spawns: Mutex::new(0),
            real_git_global: Some(checkout.global.clone()),
        })
    }
}

/// A real checkout on `main` tracking `origin/main`, with `origin` at [`DESTINATION`] and an
/// empty global configuration, so a developer's own URL rules cannot change it.
struct RealCheckout {
    _root: tempfile::TempDir,
    path: PathBuf,
    global: PathBuf,
}

fn real_checkout() -> RealCheckout {
    let root = tempfile::tempdir().expect("root");
    let global = root.path().join("global.gitconfig");
    std::fs::write(&global, "").expect("global config");
    let path = root.path().join("repo");
    std::fs::create_dir_all(&path).expect("repo");
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.name", "Test"],
        vec!["config", "user.email", "test@example.com"],
        vec!["commit", "-q", "--allow-empty", "-m", "init"],
        vec!["remote", "add", "origin", DESTINATION],
        vec!["update-ref", "refs/remotes/origin/main", "HEAD"],
        vec!["config", "branch.main.remote", "origin"],
        vec!["config", "branch.main.merge", "refs/heads/main"],
    ] {
        let status = std::process::Command::new("git")
            .args(&args)
            .current_dir(&path)
            .env("GIT_CONFIG_GLOBAL", &global)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    }
    RealCheckout {
        _root: root,
        path,
        global,
    }
}

fn args(request: &ProcessRequest) -> Vec<String> {
    request
        .args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

impl GitProcessRunner for NetworkRunner {
    fn run<'a>(
        &'a self,
        request: ProcessRequest,
        cancellation: &'a CancellationToken,
    ) -> BoxGitProcessFuture<'a> {
        let operation = request.operation.clone();
        let network = matches!(
            operation.as_str(),
            "GitVcsDriver.pullCurrentBranch" | "GitVcsDriver.pushCurrentBranch"
        );
        if let (false, Some(global)) = (network, &self.real_git_global) {
            let mut request = request;
            request
                .env
                .push(("GIT_CONFIG_GLOBAL".into(), global.clone().into()));
            return Box::pin(async move { ProcessRunner.run(request, cancellation).await });
        }
        let stdout = match operation.as_str() {
            "GitVcsDriver.currentRef" => "main\n".to_owned(),
            "GitVcsDriver.pullCurrentBranch.upstream"
            | "GitVcsDriver.pushCurrentBranch.upstream" => "origin/main\n".to_owned(),
            "GitManager.signIn.head" => "refs/heads/main\n".to_owned(),
            "GitManager.signIn.branchRemote" => "origin\n".to_owned(),
            "GitManager.signIn.remoteUrls" => format!("{}\n", self.urls.lock().expect("urls")),
            _ if args(&request).iter().any(|arg| arg == "rev-parse") => "a".repeat(40),
            _ => String::new(),
        };
        Box::pin(async move {
            if !network {
                return Ok(ProcessOutput {
                    exit_code: 0,
                    stdout,
                    stderr: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                });
            }
            *self.network_spawns.lock().expect("spawns") += 1;
            if self.hang {
                cancellation.cancelled().await;
                // The real runner kills the process group or Job here.
                self.killed.store(true, Ordering::SeqCst);
                return Err(ProcessError::Cancelled { operation });
            }
            Err(ProcessError::NonZeroExit {
                operation,
                exit_code: 128,
                stdout_length: 0,
                stderr_length: self.stderr.len(),
                stdout: "".into(),
                stderr: self.stderr.into(),
            })
        })
    }
}

fn request(tag: &str, payload: Value) -> RpcRequest {
    RpcRequest {
        id: RequestId::try_from("1").expect("request id"),
        tag: tag.to_owned(),
        payload,
        headers: Vec::new(),
        trace_id: None,
        span_id: None,
        sampled: None,
    }
}

fn context(subject: Option<&str>) -> RpcSessionContext {
    let Some(subject) = subject else {
        return RpcSessionContext::unauthenticated();
    };
    let auth = AuthService::new(&ServerConfig::new("."), vec![7_u8; 32]);
    RpcSessionContext::authenticated(
        Principal {
            session_id: "session".to_owned(),
            subject: subject.to_owned(),
            method: "test".to_owned(),
            scopes: vec!["*".to_owned()],
            proof_key_thumbprint: None,
            expires_at_ms: i64::MAX,
        },
        auth,
    )
}

fn services(runner: &Arc<NetworkRunner>, interactive: bool) -> GitVcsRpcServices {
    GitVcsRpcServices::with_repository(
        Arc::new(GitRepository::with_runner_for_test(runner.clone())),
        Arc::default(),
    )
    .with_interactive_git_sign_in(interactive)
}

async fn pull(
    services: &GitVcsRpcServices,
    payload: Value,
    subject: Option<&str>,
) -> Result<Value, Value> {
    services
        .handle_unary_with_context(
            request("vcs.pull", payload),
            context(subject),
            CancellationToken::new(),
        )
        .await
}

#[tokio::test]
async fn an_interrupted_pull_kills_its_git_process() {
    let runner = NetworkRunner::new("", true);
    let services = services(&runner, true);
    let cancellation = CancellationToken::new();
    let cancel = cancellation.clone();
    let task_services = services.clone();
    let pending = tokio::spawn(async move {
        task_services
            .handle_unary_with_context(
                request("vcs.pull", json!({ "cwd": "/repo" })),
                RpcSessionContext::unauthenticated(),
                cancellation,
            )
            .await
    });
    while *runner.network_spawns.lock().expect("spawns") == 0 {
        tokio::task::yield_now().await;
    }
    cancel.cancel();
    let error = pending.await.expect("task").expect_err("cancelled");
    assert!(
        runner.killed.load(Ordering::SeqCst),
        "the pull's Git process is killed"
    );
    assert_eq!(error["_tag"], "GitCommandError", "{error}");
}

#[tokio::test]
async fn only_the_desktop_session_on_an_interactive_server_is_offered_a_pull_sign_in() {
    let desktop = Some(crate::auth::DESKTOP_BOOTSTRAP_SUBJECT);
    let runner = NetworkRunner::new(GCM_STDERR, false);
    let error = pull(&services(&runner, true), json!({ "cwd": "/repo" }), desktop)
        .await
        .expect_err("refused");
    assert_eq!(error["_tag"], "GitSignInRequiredError", "{error}");
    assert_eq!(error["remote"], "origin");
    assert_eq!(error["destination"], DESTINATION);
    assert_eq!(error["host"], "github.com");
    assert_eq!(error["direction"], "fetch");
    assert_eq!(
        error["resume"],
        json!({ "cwd": "/repo", "expectedDestination": DESTINATION })
    );

    for (interactive, subject) in [
        (false, desktop),
        (true, Some("paired-device")),
        (true, Some(crate::auth::MCP_CLIENT_SUBJECT)),
        (true, None),
    ] {
        let runner = NetworkRunner::new(GCM_STDERR, false);
        let error = pull(
            &services(&runner, interactive),
            json!({ "cwd": "/repo" }),
            subject,
        )
        .await
        .expect_err("refused");
        assert_eq!(
            error["_tag"], "GitCommandError",
            "{interactive} {subject:?}"
        );
    }
}

#[tokio::test]
async fn a_resumed_pull_refuses_a_destination_that_changed_before_any_network_spawn() {
    let runner = NetworkRunner::new("fatal: unrelated\n", false);
    *runner.urls.lock().expect("urls") = "https://evil.example/owner/repo.git";
    let error = pull(
        &services(&runner, true),
        json!({ "cwd": "/repo", "expectedDestination": DESTINATION }),
        None,
    )
    .await
    .expect_err("refused");
    assert_eq!(error["_tag"], "GitSignInDestinationChangedError", "{error}");
    assert_eq!(error["destination"], "https://evil.example/owner/repo.git");
    assert_eq!(*runner.network_spawns.lock().expect("spawns"), 0);

    *runner.urls.lock().expect("urls") = DESTINATION;
    let _ = pull(
        &services(&runner, true),
        json!({ "cwd": "/repo", "expectedDestination": DESTINATION }),
        None,
    )
    .await;
    assert_eq!(*runner.network_spawns.lock().expect("spawns"), 1);
}

async fn stacked_events(
    services: &GitVcsRpcServices,
    payload: Value,
    subject: Option<&str>,
    cancellation: CancellationToken,
) -> Vec<Value> {
    let mut stream = services.stacked_action_stream(
        request("git.runStackedAction", payload),
        context(subject),
        cancellation,
    );
    let mut events = Vec::new();
    while let Some(chunk) = stream.recv().await {
        events.extend(chunk.expect("stream item"));
    }
    events
}

#[tokio::test]
async fn a_stacked_push_refused_by_gcm_offers_its_resume_on_the_desktop_session_only() {
    let desktop = Some(crate::auth::DESKTOP_BOOTSTRAP_SUBJECT);
    let checkout = real_checkout();
    let payload = json!({ "actionId": "a1", "cwd": checkout.path, "action": "push" });
    let runner = NetworkRunner::real(GCM_STDERR, false, &checkout);
    let events = stacked_events(
        &services(&runner, true),
        payload.clone(),
        desktop,
        CancellationToken::new(),
    )
    .await;
    let failed = events.last().expect("terminal event");
    assert_eq!(failed["kind"], "action_failed", "{failed}");
    assert_eq!(failed["phase"], "push", "{failed}");
    let sign_in = &failed["signIn"];
    assert_eq!(sign_in["destination"], DESTINATION, "{failed}");
    assert_eq!(sign_in["direction"], "push");
    assert_eq!(sign_in["resume"]["action"], "push");
    assert_eq!(sign_in["resume"]["expectedDestination"], DESTINATION);
    assert_eq!(
        *runner.network_spawns.lock().expect("spawns"),
        1,
        "no retry"
    );

    let runner = NetworkRunner::real(GCM_STDERR, false, &checkout);
    let events = stacked_events(
        &services(&runner, true),
        payload,
        None,
        CancellationToken::new(),
    )
    .await;
    assert!(
        events.last().expect("terminal")["signIn"].is_null(),
        "ineligible"
    );
}

#[tokio::test]
async fn a_stacked_resume_drops_the_commit_it_already_made() {
    let checkout = real_checkout();
    let runner = NetworkRunner::real(GCM_STDERR, false, &checkout);
    let repository = GitRepository::with_runner_for_test(runner.clone());
    for (action, resume_action) in [
        ("push", "push"),
        ("commit_push", "push"),
        ("commit_push_pr", "create_pr"),
        ("create_pr", "create_pr"),
    ] {
        let payload = json!({
            "actionId": "a1", "cwd": checkout.path, "action": action, "commitMessage": "Change",
            "filePaths": ["a.txt"], "featureBranch": true, "pullRequestBaseBranch": "main",
            "pullRequestHeadBranch": "main",
        });
        let input: super::StackedActionInput =
            serde_json::from_value(payload.clone()).expect("input");
        let offer = super::stacked_sign_in_offer(
            &repository,
            &input,
            &payload,
            crate::git::sign_in::CredentialPrompt::OfferSignIn,
            GCM_STDERR,
            &CancellationToken::new(),
        )
        .await
        .expect("offer")
        .expect("one destination");
        let resume = &offer.resume;
        assert_eq!(resume["action"], resume_action, "{action}");
        assert_eq!(resume["expectedDestination"], DESTINATION);
        for key in ["commitMessage", "filePaths", "featureBranch"] {
            assert!(resume.get(key).is_none(), "{action}: {key}");
        }
        // A push keeps no pull request fields; a pull request resume keeps its target.
        assert_eq!(
            resume.get("pullRequestBaseBranch").is_some(),
            resume_action == "create_pr",
            "{action}"
        );
        // Commit and create a pull request pushes the current branch, not `origin`.
        assert_eq!(
            resume.get("pullRequestHeadBranch").is_some(),
            action == "create_pr",
            "{action}"
        );
    }
}

#[tokio::test]
async fn cancelling_a_stacked_push_reports_the_saved_commit() {
    let checkout = real_checkout();
    let runner = NetworkRunner::real("", true, &checkout);
    let services = services(&runner, true);
    let cancellation = CancellationToken::new();
    let cancel = cancellation.clone();
    let watcher = runner.clone();
    tokio::spawn(async move {
        while *watcher.network_spawns.lock().expect("spawns") == 0 {
            tokio::task::yield_now().await;
        }
        cancel.cancel();
    });
    let events = stacked_events(
        &services,
        json!({ "actionId": "a1", "cwd": checkout.path, "action": "push" }),
        None,
        cancellation,
    )
    .await;
    assert!(runner.killed.load(Ordering::SeqCst));
    let failed = events.last().expect("terminal event");
    assert_eq!(failed["kind"], "action_failed", "{failed}");
    assert_eq!(failed["phase"], "push", "{failed}");
    assert_eq!(
        failed["message"],
        "Push cancelled. Your commit is saved locally."
    );
}

#[test]
fn eligibility_needs_the_flag_and_the_desktop_subject() {
    use super::super::git_manager_rpc::sign_in_eligible;
    let desktop = Some(crate::auth::DESKTOP_BOOTSTRAP_SUBJECT);
    assert!(sign_in_eligible(true, &context(desktop)));
    assert!(!sign_in_eligible(false, &context(desktop)));
    assert!(!sign_in_eligible(true, &context(Some("paired-device"))));
    assert!(!sign_in_eligible(
        true,
        &context(Some(crate::auth::MCP_CLIENT_SUBJECT))
    ));
    assert!(!sign_in_eligible(true, &context(None)));
}
