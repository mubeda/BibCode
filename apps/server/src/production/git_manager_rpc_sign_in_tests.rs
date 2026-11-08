//! `git.signIn` refusals before any probe (#325).

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{ConfiguredGitManagerRpcServices, GitManagerRpcServices};
use crate::{
    RequestId,
    auth::{AuthService, Principal},
    config::ServerConfig,
    git::{BoxGitProcessFuture, GitProcessRunner, GitRepository, ProcessOutput, ProcessRequest},
    rpc::{RpcRequest, RpcSessionContext},
};

const DESTINATION: &str = "https://github.com/owner/repo.git";

/// Answers `remote get-url` with `urls`; records every request.
struct UrlRunner {
    urls: &'static str,
    requests: Mutex<Vec<String>>,
}

impl GitProcessRunner for UrlRunner {
    fn run<'a>(
        &'a self,
        request: ProcessRequest,
        _cancellation: &'a CancellationToken,
    ) -> BoxGitProcessFuture<'a> {
        let stdout = if request.operation == "GitManager.signIn.remoteUrls" {
            self.urls.to_owned()
        } else {
            String::new()
        };
        self.requests
            .lock()
            .expect("requests")
            .push(request.operation.clone());
        Box::pin(async move {
            Ok(ProcessOutput {
                exit_code: 0,
                stdout,
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
            })
        })
    }
}

fn context(subject: Option<&str>) -> RpcSessionContext {
    let Some(subject) = subject else {
        return RpcSessionContext::unauthenticated();
    };
    RpcSessionContext::authenticated(
        Principal {
            session_id: "session".to_owned(),
            subject: subject.to_owned(),
            method: "test".to_owned(),
            scopes: vec!["*".to_owned()],
            proof_key_thumbprint: None,
            expires_at_ms: i64::MAX,
        },
        AuthService::new(&ServerConfig::new("."), vec![7_u8; 32]),
    )
}

fn sign_in_request(destination: &str) -> RpcRequest {
    RpcRequest {
        id: RequestId::try_from("1").expect("request id"),
        tag: "git.signIn".to_owned(),
        payload: json!({
            "cwd": "/repo", "remote": "origin", "direction": "fetch", "destination": destination,
        }),
        headers: Vec::new(),
        trace_id: None,
        span_id: None,
        sampled: None,
    }
}

async fn sign_in(
    services: &ConfiguredGitManagerRpcServices,
    destination: &str,
    subject: Option<&str>,
) -> Result<Value, Value> {
    services
        .sign_in(
            sign_in_request(destination),
            context(subject),
            CancellationToken::new(),
        )
        .await
}

fn interactive(
    runner: &Arc<UrlRunner>,
    state: &std::path::Path,
) -> ConfiguredGitManagerRpcServices {
    let mut services = ConfiguredGitManagerRpcServices::from(GitManagerRpcServices)
        .with_interactive_git_sign_in(state);
    services.repository = Arc::new(GitRepository::with_runner_for_test(runner.clone()));
    services
}

#[tokio::test]
async fn an_ineligible_caller_is_refused_before_any_git_command() {
    let state = tempfile::tempdir().expect("state");
    let runner = Arc::new(UrlRunner {
        urls: DESTINATION,
        requests: Mutex::default(),
    });
    let desktop = Some(crate::auth::DESKTOP_BOOTSTRAP_SUBJECT);
    let flag_off = ConfiguredGitManagerRpcServices::from(GitManagerRpcServices);
    let error = sign_in(&flag_off, DESTINATION, desktop)
        .await
        .expect_err("server flag off");
    assert_eq!(error["_tag"], "GitSignInUnavailableError");

    let services = interactive(&runner, state.path());
    for subject in [
        Some("paired-device"),
        Some(crate::auth::MCP_CLIENT_SUBJECT),
        None,
    ] {
        let error = sign_in(&services, DESTINATION, subject)
            .await
            .expect_err("ineligible");
        assert_eq!(error["_tag"], "GitSignInUnavailableError", "{subject:?}");
    }
    assert!(runner.requests.lock().expect("requests").is_empty());
}

#[tokio::test]
async fn a_changed_or_doubled_remote_is_refused_before_the_probe() {
    let state = tempfile::tempdir().expect("state");
    let desktop = Some(crate::auth::DESKTOP_BOOTSTRAP_SUBJECT);
    for (urls, expected_destination) in [
        (
            "https://evil.example/owner/repo.git\n",
            json!("https://evil.example/owner/repo.git"),
        ),
        (
            "https://github.com/owner/repo.git\nhttps://mirror.example/repo.git\n",
            Value::Null,
        ),
    ] {
        let runner = Arc::new(UrlRunner {
            urls,
            requests: Mutex::default(),
        });
        let services = interactive(&runner, state.path());
        let error = sign_in(&services, DESTINATION, desktop)
            .await
            .expect_err("changed");
        assert_eq!(error["_tag"], "GitSignInDestinationChangedError", "{error}");
        assert_eq!(error["destination"], expected_destination);
        assert!(
            runner
                .requests
                .lock()
                .expect("requests")
                .iter()
                .all(|operation| operation == "GitManager.signIn.remoteUrls"),
            "no network spawn"
        );
    }
}

#[tokio::test]
async fn a_second_concurrent_sign_in_is_refused() {
    let state = tempfile::tempdir().expect("state");
    let runner = Arc::new(UrlRunner {
        urls: DESTINATION,
        requests: Mutex::default(),
    });
    let services = interactive(&runner, state.path());
    let held = services
        .sign_in
        .as_ref()
        .expect("sign-in state")
        .slot
        .try_acquire()
        .expect("first sign-in");
    let error = sign_in(
        &services,
        DESTINATION,
        Some(crate::auth::DESKTOP_BOOTSTRAP_SUBJECT),
    )
    .await
    .expect_err("busy");
    assert_eq!(error["_tag"], "GitSignInBusyError");
    assert_eq!(
        error["message"],
        "Another sign-in is open. Finish or cancel it first."
    );
    drop(held);
}
