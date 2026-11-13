//! Git Credential Manager sign-in for a person on the desktop's in-process server (#325).
//!
//! Operations never prompt. When GCM refuses because interaction is disabled, an eligible
//! operation reports the remote's frozen `https://` destination; after the person approves it,
//! [`sign_in`] runs one probe against that destination in a neutral repository where no URL
//! rewrite applies, with GCM interaction allowed for that command only.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

use super::{GitRepository, ProcessOutput};

/// The maintainer's cap on a pending sign-in (M2).
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// GCM's refusal when interaction is disabled (`AuthenticationBase.cs`), lowercased.
const GCM_REFUSAL: &str = "fatal: cannot prompt because user interactivity has been disabled.";

/// Whether a failed operation may offer a sign-in. Callers outside the desktop's own session
/// pass `Never`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CredentialPrompt {
    #[default]
    Never,
    OfferSignIn,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignInDirection {
    Fetch,
    Push,
}

impl SignInDirection {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fetch => "fetch",
            Self::Push => "push",
        }
    }

    /// The several-URLs refusal for this direction.
    #[must_use]
    pub const fn several_urls_message(self) -> &'static str {
        match self {
            Self::Fetch => {
                "BiBCode offers a sign-in only for a remote with one fetch URL. Sign in with your own Git."
            }
            Self::Push => {
                "BiBCode offers a sign-in only for a remote with one push URL. Sign in with your own Git."
            }
        }
    }
}

/// The `signIn` object of a `sign-in-required` failure.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInRequired {
    pub remote: String,
    pub destination: String,
    pub host: String,
    pub direction: SignInDirection,
    /// The request the panel sends after a sign-in, already carrying `expectedDestination`.
    pub resume: Value,
}

/// The remote's effective URL in one direction, as detection and the checks see it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Destination {
    /// Exactly one `https://` URL BiBCode can pin.
    Offer { destination: String, host: String },
    /// More than one URL in this direction; one approval cannot cover them all.
    Several,
    /// No URL, an unreadable remote, or a URL BiBCode offers no sign-in for.
    None,
}

/// True when a line of `stderr` starts with GCM's refusal. Remote and hook text can forge it;
/// it only decides whether an approval is offered.
#[must_use]
pub fn has_gcm_refusal(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        line.trim_end_matches('\r')
            .get(..GCM_REFUSAL.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(GCM_REFUSAL))
    })
}

/// True when Git stopped for a missing username with prompts disabled (#343): a line that
/// starts with `fatal:` holds both phrases, so a commit message or hook output that quotes
/// them does not count (R23).
///
/// Neither caller joins lines: Git Manager passes the last Git output's raw stderr, and
/// Source Control the wire `detail`, which is that stderr trimmed and redacted. Git's progress
/// output separates updates with `\r`, so the fatal line can follow one after `\r`, not `\n`.
#[must_use]
pub fn has_missing_username_refusal(detail: &str) -> bool {
    detail.split(['\n', '\r']).any(|line| {
        let line = line.trim_start().to_ascii_lowercase();
        line.starts_with("fatal:")
            && line.contains("could not read username")
            && line.contains("terminal prompts disabled")
    })
}

/// Where this server's Git runs, as a failed push names it (#343): `remote` for every server
/// the desktop app did not start inside itself.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExecutionPlace {
    pub remote: bool,
    pub server_name: Option<String>,
}

#[must_use]
pub fn execution_place(config: &crate::ServerConfig) -> ExecutionPlace {
    let label = config.environment_label.trim();
    ExecutionPlace {
        remote: !config.interactive_git_sign_in,
        server_name: (!label.is_empty() && label != crate::config::LOCAL_ENVIRONMENT_LABEL)
            .then(|| label.to_owned()),
    }
}

impl ExecutionPlace {
    /// The guidance for a push that failed on a remote server for a missing username, or
    /// `None` when Git ran here or failed for another reason. Git Manager and Source Control
    /// both decide with this, so on a remote server the refusal outranks a helper's earlier
    /// "timed out" or "cancelled" line, while a local desktop keeps its classification.
    #[must_use]
    pub fn push_guidance(&self, git_detail: &str) -> Option<String> {
        (self.remote && has_missing_username_refusal(git_detail))
            .then(|| remote_push_guidance(self.server_name.as_deref(), git_detail))
    }
}

/// Where to sign in after a remote missing-credentials push, a blank line, then Git's text.
#[must_use]
pub fn remote_push_guidance(server_name: Option<&str>, git_detail: &str) -> String {
    let (server, there) = server_name.map_or_else(
        || ("".to_owned(), "the remote server".to_owned()),
        |name| (format!(" {name}"), name.to_owned()),
    );
    format!(
        "Push ran on the remote server{server}. In a terminal on {there}, open this repository as the user that runs BiBCode and run `git push` to sign in to Git. Then retry the push in BiBCode.\n\n{}",
        git_detail.trim()
    )
}

/// The pinned destination and its host for an `https://` URL, without user information.
/// A query, fragment or `=` (which `-c http.<url>.*` cannot carry) gets no sign-in.
#[must_use]
pub fn https_destination(url: &str) -> Option<(String, String)> {
    let mut parsed = url::Url::parse(url.trim()).ok()?;
    if parsed.scheme() != "https" || parsed.query().is_some() || parsed.fragment().is_some() {
        return None;
    }
    let host = parsed.host_str()?.to_owned();
    let host = parsed
        .port()
        .map_or(host.clone(), |port| format!("{host}:{port}"));
    parsed.set_username("").ok()?;
    parsed.set_password(None).ok()?;
    let destination = parsed.to_string();
    if destination.contains('=') || destination.chars().any(char::is_whitespace) {
        return None;
    }
    Some((destination, host))
}

/// Resolves `remote`'s effective URLs in `direction` with `git remote get-url --all`, which
/// applies `insteadOf`/`pushInsteadOf` exactly as the operation's own network step does.
pub async fn resolve_destination(
    repository: &GitRepository,
    cwd: &Path,
    remote: &str,
    direction: SignInDirection,
    cancellation: &CancellationToken,
) -> Destination {
    let mut args = vec![
        "remote".to_owned(),
        "get-url".to_owned(),
        "--all".to_owned(),
    ];
    if direction == SignInDirection::Push {
        args.push("--push".to_owned());
    }
    args.push(remote.to_owned());
    let Ok(output) = repository
        .run("GitManager.signIn.remoteUrls", cwd, &args, cancellation)
        .await
    else {
        return Destination::None;
    };
    let urls = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    match urls.as_slice() {
        [url] => https_destination(url).map_or(Destination::None, |(destination, host)| {
            Destination::Offer { destination, host }
        }),
        [] => Destination::None,
        _ => Destination::Several,
    }
}

/// The remote `vcs.pull`'s bare `git pull` contacts: the current branch's upstream remote
/// (`%(upstream:remotename)`), which `pull_current_branch` requires. A push picks its remote
/// with `GitRepository::plan_current_branch_push` instead.
pub async fn upstream_remote(
    repository: &GitRepository,
    cwd: &Path,
    cancellation: &CancellationToken,
) -> Option<String> {
    let head = repository
        .run(
            "GitManager.signIn.head",
            cwd,
            &[
                "symbolic-ref".to_owned(),
                "--quiet".to_owned(),
                "HEAD".to_owned(),
            ],
            cancellation,
        )
        .await
        .ok()?;
    let format = "--format=%(upstream:remotename)";
    let remote = repository
        .run(
            "GitManager.signIn.branchRemote",
            cwd,
            &[
                "for-each-ref".to_owned(),
                format.to_owned(),
                head.stdout.trim().to_owned(),
            ],
            cancellation,
        )
        .await
        .ok()?
        .stdout
        .trim()
        .to_owned();
    (!remote.is_empty()).then_some(remote)
}

/// One sign-in at a time per server.
#[derive(Clone, Default)]
pub struct SignInSlot(Arc<Mutex<()>>);

impl SignInSlot {
    #[must_use]
    pub fn try_acquire(&self) -> Option<OwnedMutexGuard<()>> {
        Arc::clone(&self.0).try_lock_owned().ok()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SignInOutcome {
    SignedIn,
    Failed(&'static str),
    TimedOut,
    Cancelled,
}

impl SignInOutcome {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SignedIn => "signedIn",
            Self::Failed(_) => "failed",
            Self::TimedOut => "timedOut",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum SignInRefusal {
    /// A global `insteadOf` or `pushInsteadOf` value prefixes the destination.
    Rewritten,
    /// The neutral repository could not be prepared.
    Unavailable,
}

pub const SIGN_IN_FAILED: &str =
    "Git Credential Manager could not sign you in. Sign in with your own Git, then try again.";

/// Runs the sign-in probe against the approved `destination`. The neutral repository is
/// removed on every outcome, including when the caller drops this future.
pub async fn sign_in(
    repository: &GitRepository,
    neutral_parent: &Path,
    destination: &str,
    direction: SignInDirection,
    timeout: Duration,
    cancellation: &CancellationToken,
) -> Result<SignInOutcome, SignInRefusal> {
    let neutral = NeutralRepository::create(neutral_parent).map_err(|error| {
        tracing::warn!(error_kind = ?error.kind(), "could not create the Git sign-in repository");
        SignInRefusal::Unavailable
    })?;
    repository
        .run(
            "GitManager.signIn.init",
            neutral.path(),
            &["init".to_owned(), "-q".to_owned()],
            cancellation,
        )
        .await
        .map_err(|_| SignInRefusal::Unavailable)?;
    let rewrites = repository
        .git_sign_in_rewrite_values(neutral.path(), cancellation)
        .await
        .map_err(|_| SignInRefusal::Unavailable)?;
    if is_rewritten(&rewrites, destination) {
        return Err(SignInRefusal::Rewritten);
    }
    let result = repository
        .git_sign_in_probe(
            neutral.path(),
            &probe_arguments(destination, direction, &uuid::Uuid::new_v4().to_string()),
            timeout,
            cancellation,
        )
        .await;
    Ok(match result {
        _ if cancellation.is_cancelled() => SignInOutcome::Cancelled,
        Ok(output) if authenticated(&output, direction) => SignInOutcome::SignedIn,
        Ok(output) => SignInOutcome::Failed(
            super::manager::operations::classified_failure_message(
                output.exit_code,
                &output.stderr,
            )
            .unwrap_or(SIGN_IN_FAILED),
        ),
        Err(error) if error.timed_out() => SignInOutcome::TimedOut,
        Err(_) => SignInOutcome::Failed(SIGN_IN_FAILED),
    })
}

/// `-c` keys that pin redirects off for the destination, then the probe itself.
fn probe_arguments(destination: &str, direction: SignInDirection, id: &str) -> Vec<String> {
    let mut args = vec![
        "-c".to_owned(),
        "http.followRedirects=false".to_owned(),
        "-c".to_owned(),
        format!("http.{destination}.followRedirects=false"),
    ];
    match direction {
        SignInDirection::Fetch => {
            args.extend([
                "ls-remote".to_owned(),
                destination.to_owned(),
                "HEAD".to_owned(),
            ]);
        }
        SignInDirection::Push => args.extend([
            "push".to_owned(),
            "--dry-run".to_owned(),
            "--no-verify".to_owned(),
            "--porcelain".to_owned(),
            destination.to_owned(),
            format!(":refs/heads/bibcode-sign-in-{id}"),
        ]),
    }
    args
}

/// A push authenticates before it matches refspecs, so a refused delete of the probe branch
/// means the request authenticated.
fn authenticated(output: &ProcessOutput, direction: SignInDirection) -> bool {
    output.exit_code == 0
        || (direction == SignInDirection::Push
            && output
                .stderr
                .to_ascii_lowercase()
                .contains("remote ref does not exist"))
}

/// `git config -z --get-regexp` output is `key\nvalue\0` per entry.
fn is_rewritten(config: &ProcessOutput, destination: &str) -> bool {
    config
        .stdout
        .split('\0')
        .filter_map(|entry| entry.split_once('\n').map(|(_, value)| value))
        .any(|value| !value.is_empty() && destination.starts_with(value))
}

struct NeutralRepository(PathBuf);

impl NeutralRepository {
    fn create(parent: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(parent)?;
        let path = parent.join(format!("sign-in-{}", uuid::Uuid::new_v4()));
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = std::fs::DirBuilder::new();
            builder.mode(0o700);
            builder
        };
        #[cfg(not(unix))]
        let builder = std::fs::DirBuilder::new();
        builder.create(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for NeutralRepository {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            tracing::warn!(error_kind = ?error.kind(), "could not remove the Git sign-in repository");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::OsStr,
        sync::{Arc, Mutex},
    };

    use super::*;
    use crate::git::{BoxGitProcessFuture, GitProcessRunner, ProcessError, ProcessRequest};
    use crate::test_support::TestSandbox;

    const DESTINATION: &str = "https://github.com/owner/repo.git";

    type Reply = Box<dyn Fn(&ProcessRequest) -> Result<ProcessOutput, ProcessError> + Send + Sync>;

    struct ScriptedRunner {
        requests: Mutex<Vec<ProcessRequest>>,
        reply: Reply,
        hang: bool,
    }

    impl ScriptedRunner {
        fn new(reply: Reply) -> Arc<Self> {
            Arc::new(Self {
                requests: Mutex::default(),
                reply,
                hang: false,
            })
        }

        fn requests(&self) -> Vec<ProcessRequest> {
            self.requests.lock().expect("requests").clone()
        }
    }

    fn output(exit_code: i32, stdout: &str, stderr: &str) -> ProcessOutput {
        ProcessOutput {
            exit_code,
            stdout: stdout.to_owned(),
            stderr: stderr.to_owned(),
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }

    impl GitProcessRunner for ScriptedRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            self.requests
                .lock()
                .expect("requests")
                .push(request.clone());
            let probe = request.operation == "GitManager.signIn.probe";
            let reply = (self.reply)(&request);
            Box::pin(async move {
                if probe && self.hang {
                    // A runner that never exits: the real runner kills the group at either.
                    tokio::select! {
                        () = cancellation.cancelled() => {
                            return Err(ProcessError::Cancelled { operation: request.operation });
                        }
                        () = tokio::time::sleep(request.timeout) => {
                            return Err(ProcessError::Timeout {
                                operation: request.operation,
                                timeout_ms: request.timeout.as_millis(),
                            });
                        }
                    }
                }
                reply
            })
        }
    }

    fn env(request: &ProcessRequest, key: &str) -> Option<String> {
        request
            .env
            .iter()
            .rev()
            .find(|(name, _)| name == OsStr::new(key))
            .map(|(_, value)| value.to_string_lossy().into_owned())
    }

    fn args(request: &ProcessRequest) -> Vec<String> {
        request
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    fn ok_except_probe(probe: ProcessOutput) -> Reply {
        Box::new(move |request| {
            Ok(if request.operation == "GitManager.signIn.probe" {
                probe.clone()
            } else if request.operation == "GitManager.signIn.rewrites" {
                output(1, "", "")
            } else {
                output(0, "", "")
            })
        })
    }

    async fn run(
        runner: &Arc<ScriptedRunner>,
        sandbox: &TestSandbox,
        direction: SignInDirection,
        cancellation: &CancellationToken,
    ) -> Result<SignInOutcome, SignInRefusal> {
        let repository = GitRepository::with_runner_for_test(runner.clone());
        sign_in(
            &repository,
            &sandbox.root().join("sign-in"),
            DESTINATION,
            direction,
            Duration::from_millis(50),
            cancellation,
        )
        .await
    }

    fn neutral_entries(sandbox: &TestSandbox) -> usize {
        std::fs::read_dir(sandbox.root().join("sign-in")).map_or(0, Iterator::count)
    }

    #[test]
    fn detects_only_a_line_that_starts_with_the_gcm_refusal() {
        let refusal = "fatal: Cannot prompt because user interactivity has been disabled.";
        assert!(has_gcm_refusal(&format!(
            "{refusal}\r\nfatal: Authentication failed\n"
        )));
        assert!(has_gcm_refusal(
            "FATAL: CANNOT PROMPT because user interactivity has been disabled.\n"
        ));
        // A multiline band-3 payload puts the forged line at column 0; it still only offers.
        assert!(has_gcm_refusal(&format!("remote: error\n{refusal}\n")));
        assert!(!has_gcm_refusal(&format!("remote: {refusal}\n")));
        assert!(!has_gcm_refusal(
            "fatal: Authentication failed for 'https://x/'\n"
        ));
        assert!(!has_gcm_refusal(
            "git@github.com: Permission denied (publickey).\n"
        ));
    }

    const MISSING_USERNAME: &str = "fatal: could not read Username for 'https://gitlab.example.test': terminal prompts disabled";

    #[test]
    fn detects_the_missing_username_refusal_only_with_prompts_disabled() {
        assert!(has_missing_username_refusal(MISSING_USERNAME));
        assert!(has_missing_username_refusal(
            &MISSING_USERNAME.to_ascii_uppercase()
        ));
        assert!(!has_missing_username_refusal(
            "fatal: could not read Username for 'https://gitlab.example.test': No such device"
        ));
        assert!(!has_missing_username_refusal(
            "fatal: Authentication failed for 'https://gitlab.example.test/'"
        ));
    }

    const HOOK_ECHO: &str = "remote: checking\nhook: could not read username, terminal prompts disabled\nTo https://gitlab.example.test/example-group/sample-project.git";
    const AFTER_PROGRESS: &str = "Writing objects: 50%\rfatal: could not read Username for 'https://gitlab.example.test': terminal prompts disabled\n";

    #[test]
    fn the_missing_username_refusal_needs_a_fatal_line() {
        assert!(!has_missing_username_refusal(
            "fix: could not read Username and terminal prompts disabled"
        ));
        assert!(!has_missing_username_refusal(HOOK_ECHO));
        assert!(has_missing_username_refusal(AFTER_PROGRESS));
        assert!(has_missing_username_refusal(
            "   FATAL: Could not read Username for 'https://gitlab.example.test': Terminal Prompts Disabled\r\n"
        ));
        assert!(!has_missing_username_refusal(
            "fatal: could not read Username for 'https://gitlab.example.test'\nterminal prompts disabled"
        ));
        assert!(has_missing_username_refusal(MISSING_USERNAME));
    }

    #[test]
    fn push_guidance_ignores_both_phrases_outside_a_fatal_line() {
        let place = ExecutionPlace {
            remote: true,
            server_name: None,
        };
        assert_eq!(place.push_guidance(HOOK_ECHO), None);
        assert!(place.push_guidance(AFTER_PROGRESS).is_some());
    }

    #[test]
    fn names_a_known_server_and_keeps_gits_line_after_a_blank_line() {
        assert_eq!(
            remote_push_guidance(Some("example-server"), &format!("{MISSING_USERNAME}\n")),
            format!(
                "Push ran on the remote server example-server. In a terminal on example-server, open this repository as the user that runs BiBCode and run `git push` to sign in to Git. Then retry the push in BiBCode.\n\n{MISSING_USERNAME}"
            )
        );
        assert_eq!(
            remote_push_guidance(None, MISSING_USERNAME),
            format!(
                "Push ran on the remote server. In a terminal on the remote server, open this repository as the user that runs BiBCode and run `git push` to sign in to Git. Then retry the push in BiBCode.\n\n{MISSING_USERNAME}"
            )
        );
    }

    #[test]
    fn the_place_is_remote_unless_the_desktop_started_the_server() {
        let mut config = crate::ServerConfig::new(std::env::temp_dir());
        config.environment_label = " example-server ".to_owned();
        assert_eq!(
            execution_place(&config),
            ExecutionPlace {
                remote: true,
                server_name: Some("example-server".to_owned()),
            }
        );
        for label in ["Local", "  ", ""] {
            config.environment_label = label.to_owned();
            assert_eq!(execution_place(&config).server_name, None, "{label:?}");
        }
        config.interactive_git_sign_in = true;
        let local = execution_place(&config);
        assert!(!local.remote);
        assert_eq!(local.push_guidance(MISSING_USERNAME), None);
        config.interactive_git_sign_in = false;
        let remote = execution_place(&config);
        assert!(remote.push_guidance(MISSING_USERNAME).is_some());
        assert_eq!(
            remote.push_guidance("fatal: Authentication failed for 'https://gitlab.example.test/'"),
            None
        );
    }

    #[test]
    fn pins_only_https_destinations_without_user_information() {
        assert_eq!(
            https_destination("https://user:token@github.com/owner/repo.git"),
            Some((DESTINATION.to_owned(), "github.com".to_owned()))
        );
        assert_eq!(
            https_destination("https://git.example.com:8443/a/b"),
            Some((
                "https://git.example.com:8443/a/b".to_owned(),
                "git.example.com:8443".to_owned()
            ))
        );
        for refused in [
            "http://github.com/owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
            "file:///tmp/repo",
            "https://github.com/owner/repo.git?x=1",
            "https://github.com/owner/a=b.git",
        ] {
            assert_eq!(https_destination(refused), None, "{refused}");
        }
    }

    #[tokio::test]
    async fn fetch_probe_runs_ls_remote_on_the_destination_with_interaction_allowed() {
        let sandbox = TestSandbox::new("git-sign-in-fetch");
        let runner = ScriptedRunner::new(ok_except_probe(output(0, "sha\tHEAD\n", "")));
        let outcome = run(
            &runner,
            &sandbox,
            SignInDirection::Fetch,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(outcome, Ok(SignInOutcome::SignedIn));
        let requests = runner.requests();
        let probe = requests
            .iter()
            .find(|request| request.operation == "GitManager.signIn.probe")
            .expect("probe");
        assert_eq!(env(probe, "GCM_INTERACTIVE"), None);
        for (key, value) in [
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GIT_ASKPASS", ""),
            ("SSH_ASKPASS", ""),
            ("SSH_ASKPASS_REQUIRE", "never"),
            ("GIT_ALLOW_PROTOCOL", "https"),
        ] {
            assert_eq!(env(probe, key).as_deref(), Some(value), "{key}");
        }
        assert_eq!(probe.timeout, Duration::from_millis(50));
        let probe_args = args(probe);
        let tail = &probe_args[probe_args.len() - 7..];
        assert_eq!(
            tail,
            [
                "-c",
                "http.followRedirects=false",
                "-c",
                &format!("http.{DESTINATION}.followRedirects=false"),
                "ls-remote",
                DESTINATION,
                "HEAD",
            ]
        );
        // Every command runs in the neutral repository, never the checkout.
        let neutral = &requests[0].cwd;
        assert!(neutral.starts_with(sandbox.root().join("sign-in")));
        assert!(requests.iter().all(|request| &request.cwd == neutral));
        assert_eq!(neutral_entries(&sandbox), 0, "neutral repository removed");
    }

    #[tokio::test]
    async fn push_probe_is_a_dry_run_delete_and_a_missing_branch_means_signed_in() {
        let sandbox = TestSandbox::new("git-sign-in-push");
        let runner = ScriptedRunner::new(ok_except_probe(output(
            1,
            "",
            "error: unable to delete 'bibcode-sign-in-x': remote ref does not exist\n",
        )));
        let outcome = run(
            &runner,
            &sandbox,
            SignInDirection::Push,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(outcome, Ok(SignInOutcome::SignedIn));
        let probe = runner
            .requests()
            .into_iter()
            .find(|request| request.operation == "GitManager.signIn.probe")
            .expect("probe");
        let probe_args = args(&probe);
        let tail = &probe_args[probe_args.len() - 6..];
        assert_eq!(
            &tail[..5],
            [
                "push",
                "--dry-run",
                "--no-verify",
                "--porcelain",
                DESTINATION
            ]
        );
        assert!(
            tail[5].starts_with(":refs/heads/bibcode-sign-in-"),
            "{}",
            tail[5]
        );
        assert!(!probe_args.contains(&"origin".to_owned()));
        assert_eq!(neutral_entries(&sandbox), 0);
    }

    #[tokio::test]
    async fn an_authentication_failure_answers_failed() {
        let sandbox = TestSandbox::new("git-sign-in-failed");
        let runner = ScriptedRunner::new(ok_except_probe(output(
            128,
            "",
            "fatal: Authentication failed for 'https://github.com/owner/repo.git/'\n",
        )));
        let outcome = run(
            &runner,
            &sandbox,
            SignInDirection::Fetch,
            &CancellationToken::new(),
        )
        .await;
        assert!(
            matches!(outcome, Ok(SignInOutcome::Failed(message)) if message.starts_with("Authentication failed"))
        );
        assert_eq!(neutral_entries(&sandbox), 0);
    }

    #[tokio::test]
    async fn a_probe_that_never_exits_times_out_at_the_cap_or_is_cancelled() {
        let sandbox = TestSandbox::new("git-sign-in-hang");
        let mut runner = ScriptedRunner::new(ok_except_probe(output(0, "", "")));
        Arc::get_mut(&mut runner).expect("unique").hang = true;
        let outcome = run(
            &runner,
            &sandbox,
            SignInDirection::Fetch,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(outcome, Ok(SignInOutcome::TimedOut));
        assert_eq!(neutral_entries(&sandbox), 0);

        let cancellation = CancellationToken::new();
        let cancel = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancel.cancel();
        });
        let outcome = run(&runner, &sandbox, SignInDirection::Push, &cancellation).await;
        assert_eq!(outcome, Ok(SignInOutcome::Cancelled));
        assert_eq!(neutral_entries(&sandbox), 0);
    }

    #[tokio::test]
    async fn a_rewrite_that_prefixes_the_destination_is_refused_before_any_probe() {
        let sandbox = TestSandbox::new("git-sign-in-rewrite");
        let runner = ScriptedRunner::new(Box::new(|request| {
            Ok(if request.operation == "GitManager.signIn.rewrites" {
                output(
                    0,
                    "url.https://evil.example/.insteadof\nhttps://github.com/\0",
                    "",
                )
            } else {
                output(0, "", "")
            })
        }));
        let outcome = run(
            &runner,
            &sandbox,
            SignInDirection::Fetch,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(outcome, Err(SignInRefusal::Rewritten));
        assert!(
            runner
                .requests()
                .iter()
                .all(|request| request.operation != "GitManager.signIn.probe")
        );
        assert_eq!(neutral_entries(&sandbox), 0);
    }

    /// Real Git with `global` as the person's global configuration.
    struct GlobalConfigGit {
        global: std::path::PathBuf,
    }

    impl GitProcessRunner for GlobalConfigGit {
        fn run<'a>(
            &'a self,
            mut request: ProcessRequest,
            cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            request
                .env
                .push(("GIT_CONFIG_GLOBAL".into(), self.global.clone().into()));
            Box::pin(async move { crate::git::ProcessRunner.run(request, cancellation).await })
        }
    }

    async fn sign_in_with_global_config(
        sandbox: &TestSandbox,
        global: &str,
        destination: &str,
    ) -> Result<SignInOutcome, SignInRefusal> {
        let path = sandbox.root().join("global.gitconfig");
        std::fs::write(&path, global).expect("global config");
        let repository =
            GitRepository::with_runner_for_test(Arc::new(GlobalConfigGit { global: path }));
        sign_in(
            &repository,
            &sandbox.root().join("sign-in"),
            destination,
            SignInDirection::Fetch,
            Duration::from_secs(30),
            &CancellationToken::new(),
        )
        .await
    }

    #[tokio::test]
    async fn a_global_rewrite_chain_that_would_move_the_destination_is_refused() {
        let sandbox = TestSandbox::new("git-sign-in-real-rewrite");
        // `get-url` already applied A -> B and printed B; Git would rewrite B -> C again.
        for key in ["insteadOf", "pushInsteadOf"] {
            let global = format!(
                "[url \"https://b.example/\"]\n\t{key} = https://a.example/\n[url \"https://c.example/\"]\n\t{key} = https://b.example/\n"
            );
            let outcome =
                sign_in_with_global_config(&sandbox, &global, "https://b.example/owner/repo.git")
                    .await;
            assert_eq!(outcome, Err(SignInRefusal::Rewritten), "{key}");
        }
        assert_eq!(neutral_entries(&sandbox), 0);
    }

    #[tokio::test]
    async fn a_rewrite_in_the_checkouts_own_config_does_not_reach_the_neutral_repository() {
        let sandbox = TestSandbox::new("git-sign-in-real-checkout-rewrite");
        let checkout = sandbox.root().join("checkout");
        std::fs::create_dir_all(&checkout).expect("checkout");
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&checkout)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .expect("git")
        };
        git(&["init", "-q"]);
        git(&[
            "config",
            "url.https://evil.example/.insteadOf",
            "https://127.0.0.1:9/",
        ]);
        // Port 9 refuses the connection: the probe runs and fails, it is not refused.
        let outcome =
            sign_in_with_global_config(&sandbox, "", "https://127.0.0.1:9/owner/repo.git").await;
        assert!(
            matches!(outcome, Ok(SignInOutcome::Failed(_))),
            "{outcome:?}"
        );
        assert_eq!(neutral_entries(&sandbox), 0);
    }

    #[test]
    fn the_destinations_own_redirect_key_beats_a_global_url_specific_one() {
        let sandbox = TestSandbox::new("git-sign-in-real-redirects");
        let global = sandbox.root().join("global.gitconfig");
        std::fs::write(
            &global,
            "[http \"https://github.com\"]\n\tfollowRedirects = true\n[http]\n\tfollowRedirects = true\n",
        )
        .expect("global config");
        let mut args = probe_arguments(DESTINATION, SignInDirection::Fetch, "id")[..4].to_vec();
        args.extend([
            "config".to_owned(),
            "--get-urlmatch".to_owned(),
            "http.followRedirects".to_owned(),
            DESTINATION.to_owned(),
        ]);
        let output = std::process::Command::new("git")
            .args(&args)
            .current_dir(sandbox.root())
            .env("GIT_CONFIG_GLOBAL", &global)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git config");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "false");
    }

    #[test]
    fn the_slot_admits_one_sign_in_at_a_time() {
        let slot = SignInSlot::default();
        let held = slot.try_acquire().expect("first");
        assert!(slot.clone().try_acquire().is_none());
        drop(held);
        assert!(slot.try_acquire().is_some());
    }
}
