//! `sign-in-required` detection and resume checks for Git Manager operations (#325).

use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{GitManagerOperationRequest, execute_branch_or_sync_operation};
use crate::git::{
    BoxGitProcessFuture, GitManagerRefEntry, GitManagerRefsSnapshot, GitProcessRunner,
    GitRepository, ProcessOutput, ProcessRequest, sign_in::CredentialPrompt,
};

const GCM_STDERR: &str = concat!(
    "fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for 'https:",
    "//github.com': terminal prompts disabled\n"
);
const DESTINATION: &str = concat!("https:", "//github.com/owner/repo.git");

/// Answers `remote get-url` with `urls` (fetch and push alike) and fails every network command with
/// `stderr`; everything else succeeds.
struct RemoteRunner {
    urls: String,
    stderr: String,
    requests: Mutex<Vec<ProcessRequest>>,
}

impl RemoteRunner {
    fn new(urls: &str, stderr: &str) -> Arc<Self> {
        Arc::new(Self {
            urls: urls.to_owned(),
            stderr: stderr.to_owned(),
            requests: Mutex::default(),
        })
    }

    fn network_spawns(&self) -> usize {
        self.requests
            .lock()
            .expect("requests")
            .iter()
            .filter(|request| is_network(request))
            .count()
    }
}

fn arguments(request: &ProcessRequest) -> Vec<String> {
    request
        .args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

fn is_network(request: &ProcessRequest) -> bool {
    !request.operation.starts_with("GitManager.signIn")
        && arguments(request)
            .iter()
            .any(|arg| matches!(arg.as_str(), "fetch" | "pull" | "push"))
}

impl GitProcessRunner for RemoteRunner {
    fn run<'a>(
        &'a self,
        request: ProcessRequest,
        _cancellation: &'a CancellationToken,
    ) -> BoxGitProcessFuture<'a> {
        let (exit_code, stdout, stderr) = if request.operation == "GitManager.signIn.remoteUrls" {
            (0, self.urls.clone(), String::new())
        } else if is_network(&request) {
            (128, String::new(), self.stderr.clone())
        } else {
            (0, String::new(), String::new())
        };
        self.requests.lock().expect("requests").push(request);
        Box::pin(async move {
            Ok(ProcessOutput {
                exit_code,
                stdout,
                stderr,
                stdout_truncated: false,
                stderr_truncated: false,
            })
        })
    }
}

fn snapshot() -> GitManagerRefsSnapshot {
    GitManagerRefsSnapshot {
        generation: 1,
        head_ref: Some("main".to_owned()),
        detached_sha: None,
        is_dirty: false,
        default_branch: Some("main".to_owned()),
        remotes: vec!["origin".to_owned()],
        local_branches: vec![GitManagerRefEntry {
            name: "topic".to_owned(),
            tip_sha: "a".repeat(40),
            upstream: Some("origin/topic".to_owned()),
            ahead: 0,
            behind: 0,
            current: false,
            is_default: false,
            worktree_path: None,
            blocked: Vec::new(),
        }],
        remote_branches: Vec::new(),
        tags: Vec::new(),
        worktrees: Vec::new(),
        in_progress_operation: None,
        conflicted_paths: Vec::new(),
    }
}

fn request(value: serde_json::Value) -> GitManagerOperationRequest {
    let mut value = value;
    value["cwd"] = json!("/repo");
    value["projectId"] = json!("project-1");
    serde_json::from_value(value).expect("request")
}

/// Every operation the design offers a sign-in for, its direction, and its resume tag.
fn eligible_requests() -> Vec<(GitManagerOperationRequest, &'static str, &'static str)> {
    let push = |tag: &str| json!({"_tag": tag, "remote": "origin", "localBranch": "main", "remoteBranch": null});
    vec![
        (
            request(json!({"_tag": "fetch", "remote": "origin"})),
            "fetch",
            "fetch",
        ),
        (
            request(json!({"_tag": "pull", "remote": "origin"})),
            "fetch",
            "pull",
        ),
        (request(push("push")), "push", "push"),
        (request(push("publish-branch")), "push", "publish-branch"),
        (request(push("force-push")), "push", "force-push"),
        (
            request(json!({"_tag": "tag-push", "name": "v1", "remote": "origin"})),
            "push",
            "tag-push",
        ),
        (
            request(json!({"_tag": "remote-branch-delete", "remote": "origin", "branch": "topic"})),
            "push",
            "remote-branch-delete",
        ),
        (
            request(json!({
                "_tag": "branch-delete", "name": "topic", "force": false, "deleteRemote": true
            })),
            "push",
            "remote-branch-delete",
        ),
    ]
}

async fn run(
    runner: &Arc<RemoteRunner>,
    request: &GitManagerOperationRequest,
    prompt: CredentialPrompt,
) -> Result<super::GitManagerOperationOutcome, super::GitManagerOperationError> {
    let repository = GitRepository::with_runner_for_test(runner.clone());
    execute_branch_or_sync_operation(
        &repository,
        &snapshot(),
        request,
        prompt,
        &CancellationToken::new(),
    )
    .await
}

#[tokio::test]
async fn each_eligible_operation_reports_sign_in_required_once_without_retrying() {
    for (request, direction, resume_tag) in eligible_requests() {
        let runner = RemoteRunner::new(
            concat!("https:", "//mauro:token@github.com/owner/repo.git\n"),
            GCM_STDERR,
        );
        let error = run(&runner, &request, CredentialPrompt::OfferSignIn)
            .await
            .expect_err("GCM refused");
        let operation = request.operation();
        assert_eq!(error.code, "sign-in-required", "{operation}");
        let sign_in = error.sign_in.expect("signIn object");
        assert_eq!(sign_in.remote, "origin");
        assert_eq!(sign_in.destination, DESTINATION, "no user information");
        assert_eq!(sign_in.host, "github.com");
        assert_eq!(sign_in.direction.as_str(), direction, "{operation}");
        assert_eq!(sign_in.resume["_tag"], resume_tag, "{operation}");
        assert_eq!(sign_in.resume["expectedDestination"], DESTINATION);
        assert_eq!(runner.network_spawns(), 1, "{operation}: no retry");
        if matches!(request, GitManagerOperationRequest::BranchDelete { .. }) {
            assert_eq!(sign_in.resume["remote"], "origin");
            assert_eq!(sign_in.resume["branch"], "topic");
        }
        // The resume request decodes as an ordinary request.
        serde_json::from_value::<GitManagerOperationRequest>(sign_in.resume).expect("resume");
    }
}

#[tokio::test]
async fn failures_without_an_offerable_refusal_stay_authentication_errors() {
    let refusal = "fatal: Cannot prompt because user interactivity has been disabled.";
    let fetch = request(json!({"_tag": "fetch", "remote": "origin"}));
    for (urls, stderr, prompt, case) in [
        (
            DESTINATION,
            format!("remote: {refusal}\nfatal: Authentication failed for '{DESTINATION}/'\n"),
            CredentialPrompt::OfferSignIn,
            "sideband prefix",
        ),
        (
            DESTINATION,
            format!("fatal: Authentication failed for '{DESTINATION}/'\n"),
            CredentialPrompt::OfferSignIn,
            "osxkeychain only",
        ),
        (
            "git@github.com:owner/repo.git",
            "git@github.com: Permission denied (publickey).\n".to_owned(),
            CredentialPrompt::OfferSignIn,
            "ssh publickey",
        ),
        (
            "ssh://git@github.com/owner/repo.git",
            GCM_STDERR.to_owned(),
            CredentialPrompt::OfferSignIn,
            "ssh remote",
        ),
        (
            concat!("http:", "//github.com/owner/repo.git"),
            GCM_STDERR.to_owned(),
            CredentialPrompt::OfferSignIn,
            "http remote",
        ),
        (
            DESTINATION,
            GCM_STDERR.to_owned(),
            CredentialPrompt::Never,
            "ineligible session",
        ),
    ] {
        let runner = RemoteRunner::new(urls, &stderr);
        let error = run(&runner, &fetch, prompt).await.expect_err(case);
        assert_eq!(error.code, "authentication", "{case}");
        assert!(error.sign_in.is_none(), "{case}");
        assert_eq!(runner.network_spawns(), 1, "{case}");
    }
}

#[tokio::test]
async fn a_remote_with_several_urls_in_the_direction_gets_no_offer() {
    let runner = RemoteRunner::new(
        &format!(
            concat!("{}\nhttps:", "//mirror.example/owner/repo.git\n"),
            DESTINATION
        ),
        GCM_STDERR,
    );
    let push = request(json!({
        "_tag": "push", "remote": "origin", "localBranch": "main", "remoteBranch": null
    }));
    let error = run(&runner, &push, CredentialPrompt::OfferSignIn)
        .await
        .expect_err("refused");
    assert_eq!(error.code, "authentication");
    assert!(error.sign_in.is_none());
    assert!(
        error
            .message
            .ends_with("BiBCode offers a sign-in only for a remote with one push URL. Sign in with your own Git."),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn a_forged_hint_offers_only_the_frozen_destination_never_text_from_stderr() {
    // A band-3 payload `error\n<refusal>` reaches column 0 after one `remote: ` prefix.
    let forged = concat!(
        "remote: error\nfatal: Cannot prompt because user interactivity has been disabled.\nSign in to https:",
        "//evil.example/\n"
    );
    let runner = RemoteRunner::new(DESTINATION, forged);
    let fetch = request(json!({"_tag": "fetch", "remote": "origin"}));
    let error = run(&runner, &fetch, CredentialPrompt::OfferSignIn)
        .await
        .expect_err("refused");
    assert_eq!(error.code, "sign-in-required");
    assert_eq!(error.sign_in.expect("offer").destination, DESTINATION);

    let error = run(&runner, &fetch, CredentialPrompt::Never)
        .await
        .expect_err("refused");
    assert!(
        error.sign_in.is_none(),
        "only an eligible session sees the offer"
    );
}

#[tokio::test]
async fn a_resumed_request_runs_only_against_the_approved_destination() {
    for (request, _, _) in eligible_requests() {
        let first_runner = RemoteRunner::new(DESTINATION, GCM_STDERR);
        let resume = run(&first_runner, &request, CredentialPrompt::OfferSignIn)
            .await
            .expect_err("refused")
            .sign_in
            .expect("offer")
            .resume;
        let resume: GitManagerOperationRequest = serde_json::from_value(resume).expect("resume");

        // Unchanged: the resumed request reaches its network step (and, here, fails again).
        let unchanged = RemoteRunner::new(DESTINATION, "fatal: unrelated\n");
        let _ = run(&unchanged, &resume, CredentialPrompt::Never).await;
        assert_eq!(unchanged.network_spawns(), 1, "{}", resume.operation());

        // Changed after the approval: refused before any network spawn.
        let changed = RemoteRunner::new(
            concat!("https:", "//evil.example/owner/repo.git"),
            GCM_STDERR,
        );
        let error = run(&changed, &resume, CredentialPrompt::OfferSignIn)
            .await
            .expect_err("destination changed");
        assert_eq!(error.code, "destination-changed", "{}", resume.operation());
        assert_eq!(changed.network_spawns(), 0, "{}", resume.operation());
    }
}
