//! The clone tools (#139 slice X6) end to end: the real `vcs.clone` handler and clone runtime,
//! the real orchestration RPC for registration, and a local dumb-HTTP fixture serving a bare
//! repository. Nothing reaches the network: the fixture's host name resolves only through the
//! test resolver, so Git can reach it only through the address the policy pins.

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
};
use tokio_util::sync::CancellationToken;

use super::{CREATED_AT, Harness, command, error_tag, structured};
use crate::{
    git::{
        GitRepository,
        clone_policy::{ClonePolicy, FixtureAllowance, tests::resolver},
    },
    mcp::{
        control::{ClientPrincipal, McpAccess, McpServerSettings},
        tools::clone::WAIT_FOR_TEST,
    },
    persistence::{Database, ProjectionProject, Repositories, run_migrations},
    production::git_vcs::{GitVcsRpcServices, register_git_vcs_rpc},
    rpc::RpcSessionContext,
};

/// Resolves only through the test resolver (RFC 6761 reserves `.invalid`).
const HOST: &str = "fixture.invalid";
const PROJECT: &str = "alpha";

/// An empty global Git configuration, so the setup never meets the person's filters.
fn empty_config() -> &'static Path {
    static EMPTY: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    &EMPTY
        .get_or_init(|| {
            let folder = tempfile::tempdir().expect("config folder");
            let path = folder.path().join("empty.gitconfig");
            std::fs::write(&path, "").expect("empty config");
            (folder, path)
        })
        .1
}

fn git(cwd: &Path, args: &[&str]) {
    let mut command = Command::new("git");
    // The setup is the test's own: a repository location a test process inherited is not.
    for name in INHERITED {
        command.env_remove(name);
    }
    let output = command
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", empty_config())
        .env("GIT_AUTHOR_NAME", "BiBCode Test")
        .env("GIT_AUTHOR_EMAIL", "bibcode@example.invalid")
        .env("GIT_COMMITTER_NAME", "BiBCode Test")
        .env("GIT_COMMITTER_EMAIL", "bibcode@example.invalid")
        .output()
        .expect("git starts");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[derive(Clone)]
enum Serve {
    /// Files under this folder; anything else is 404.
    Files(PathBuf),
    /// A 301 to this origin plus the requested path.
    RedirectTo(String),
}

/// A local HTTP server Git's dumb protocol can clone from. It counts connections, and a
/// closed gate holds every response until it opens.
struct HttpFixture {
    port: u16,
    connections: Arc<AtomicUsize>,
    gate: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl HttpFixture {
    async fn start(serve: Serve) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let port = listener.local_addr().expect("address").port();
        let connections = Arc::new(AtomicUsize::new(0));
        let (gate, open) = watch::channel(true);
        let task = tokio::spawn({
            let connections = Arc::clone(&connections);
            async move {
                while let Ok((stream, _)) = listener.accept().await {
                    connections.fetch_add(1, Ordering::SeqCst);
                    let (serve, mut open) = (serve.clone(), open.clone());
                    tokio::spawn(async move {
                        let _ = open.wait_for(|open| *open).await;
                        respond(stream, &serve).await;
                    });
                }
            }
        });
        Self {
            port,
            connections,
            gate,
            task,
        }
    }

    fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    fn stall(&self) {
        self.gate.send_replace(false);
    }

    fn release(&self) {
        self.gate.send_replace(true);
    }
}

async fn respond(mut stream: TcpStream, serve: &Serve) {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => request.extend_from_slice(&buffer[..read]),
        }
        if request.len() > 64 * 1024 {
            return;
        }
    }
    let head = String::from_utf8_lossy(&request);
    let target = head.split_whitespace().nth(1).unwrap_or("/");
    let path = target.split('?').next().unwrap_or("/");
    let response = match serve {
        Serve::RedirectTo(origin) => format!(
            "HTTP/1.1 301 Moved Permanently\r\nLocation: {origin}{target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .into_bytes(),
        Serve::Files(root) => match std::fs::read(root.join(path.trim_start_matches('/'))) {
            Ok(body) => {
                let mut response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .into_bytes();
                response.extend_from_slice(&body);
                response
            }
            Err(_) => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        },
    };
    let _ = stream.write_all(&response).await;
    let _ = stream.shutdown().await;
}

struct Fixture {
    harness: Harness,
    agent: ClientPrincipal,
    /// The folder that holds project `alpha`, where clones go.
    projects: PathBuf,
    /// The bare repository's folder, for a person's `file://` clone.
    bare: PathBuf,
    server: HttpFixture,
    _root: tempfile::TempDir,
}

struct Options {
    /// Admit the fixture's `http://` and loopback addresses.
    admit_local: bool,
    /// The person's global configuration: `~/.gitconfig` in a test `HOME` the server's Git
    /// commands inherit. `{PORT}` is the fixture server's port.
    home_config: String,
    /// More environment the server's Git commands inherit, such as a proxy.
    environment: Vec<(&'static str, String)>,
    /// Makes the folder that holds the project a repository with this local configuration.
    parent_repo_config: Option<String>,
    /// Adds files to the source repository before its one commit.
    source: Box<dyn FnOnce(&Path)>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            admit_local: true,
            home_config: String::new(),
            environment: Vec::new(),
            parent_repo_config: None,
            source: Box::new(|_| {}),
        }
    }
}

/// A registered project `alpha` in `<root>/projects/alpha`, and a bare repository with one
/// commit served over dumb HTTP at `http://fixture.invalid:<port>/repo.git`.
async fn fixture(options: Options) -> Fixture {
    let root = tempfile::tempdir().expect("root");
    let base = root.path().canonicalize().expect("canonical root");
    let projects = base.join("projects");
    let alpha = projects.join(PROJECT);
    std::fs::create_dir_all(&alpha).expect("project folder");

    let source = base.join("source");
    std::fs::create_dir_all(&source).expect("source");
    git(&source, &["init", "-q", "-b", "main"]);
    std::fs::write(source.join("README.md"), "hello\n").expect("readme");
    (options.source)(&source);
    git(&source, &["add", "-A"]);
    git(
        &source,
        &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"],
    );
    let served = base.join("served");
    std::fs::create_dir_all(&served).expect("served");
    git(
        &served,
        &[
            "clone",
            "-q",
            "--bare",
            &source.to_string_lossy(),
            "repo.git",
        ],
    );
    let bare = served.join("repo.git");
    git(&bare, &["update-server-info"]);
    let server = HttpFixture::start(Serve::Files(served)).await;

    let home = base.join("home");
    std::fs::create_dir_all(home.join(".config")).expect("home");
    std::fs::write(
        home.join(".gitconfig"),
        options
            .home_config
            .replace("{PORT}", &server.port.to_string()),
    )
    .expect("global config");
    if let Some(config) = &options.parent_repo_config {
        git(&projects, &["init", "-q"]);
        let local = projects.join(".git/config");
        let mut text = std::fs::read_to_string(&local).expect("local config");
        text.push_str(config);
        std::fs::write(&local, text).expect("local config");
    }
    let mut environment = vec![
        ("HOME".into(), home.clone().into_os_string()),
        (
            "XDG_CONFIG_HOME".into(),
            home.join(".config").into_os_string(),
        ),
    ];
    environment.extend(
        options
            .environment
            .iter()
            .map(|(key, value)| ((*key).into(), value.into())),
    );
    let policy = ClonePolicy::admitting_fixture(
        resolver(&[
            (HOST, "127.0.0.1"),
            ("loopback.example.com", "::1"),
            ("public.example.com", "93.184.215.14"),
        ]),
        FixtureAllowance {
            environment,
            admit_local: options.admit_local,
        },
    );

    // The Git handlers find the projects in a store of their own.
    let database = Database::open_in_memory().await.expect("database");
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .expect("migrations");
    let store = Repositories::new(database);
    store
        .upsert_project(ProjectionProject {
            project_id: PROJECT.to_owned(),
            title: "Alpha".to_owned(),
            workspace_root: alpha.to_string_lossy().into_owned(),
            default_model_selection: None,
            scripts: json!([]),
            worktree_discovery: json!({}),
            worktree_repository_key: None,
            created_at: CREATED_AT.to_owned(),
            updated_at: CREATED_AT.to_owned(),
            deleted_at: None,
            repository_identity: None,
        })
        .await
        .expect("project");
    let vcs =
        GitVcsRpcServices::for_agent_clones(Arc::new(GitRepository::default()), store, policy);
    let harness = Harness::with_methods(move |registry| register_git_vcs_rpc(registry, vcs)).await;
    harness
        .engine
        .dispatch(command(json!({
            "type": "project.create", "commandId": "create-alpha", "projectId": PROJECT,
            "title": "Alpha", "workspaceRoot": alpha, "createdAt": CREATED_AT,
        })))
        .await
        .expect("project created");
    let (agent, _) = harness.agent(McpAccess::ApprovalRequired).await;
    Fixture {
        harness,
        agent,
        projects,
        bare,
        server,
        _root: root,
    }
}

impl Fixture {
    fn url(&self) -> String {
        format!("http://{HOST}:{}/repo.git", self.server.port)
    }

    async fn clone(&self, agent: &ClientPrincipal, arguments: Value) -> Value {
        let mut arguments = arguments;
        arguments["parentProjectId"] = PROJECT.into();
        self.harness
            .call(agent, "clone_repository", arguments)
            .await
    }

    /// `clone_repository` with a 300 ms wait, so a stalled clone answers `running`.
    async fn clone_briefly(&self, agent: &ClientPrincipal, arguments: Value) -> Value {
        WAIT_FOR_TEST
            .scope(Duration::from_millis(300), self.clone(agent, arguments))
            .await
    }

    async fn status(&self, agent: &ClientPrincipal, clone_id: &str) -> Value {
        self.harness
            .call(agent, "clone_status", json!({ "cloneId": clone_id }))
            .await
    }

    /// `clone_status` once the clone has settled.
    async fn settled(&self, agent: &ClientPrincipal, clone_id: &str) -> Value {
        for _ in 0..300 {
            let status = self.status(agent, clone_id).await;
            if status["structuredContent"]["state"] != "running" {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("clone {clone_id} never settled");
    }

    /// The registered projects whose folder is `path`.
    async fn projects_at(&self, path: &str) -> Vec<String> {
        self.harness
            .repositories
            .list_projects()
            .await
            .expect("projects")
            .into_iter()
            .filter(|project| project.deleted_at.is_none() && project.workspace_root == path)
            .map(|project| project.project_id)
            .collect()
    }

    fn agent_context(&self, agent: &ClientPrincipal) -> RpcSessionContext {
        RpcSessionContext::authenticated(agent.principal.clone(), self.harness.auth.clone())
    }

    async fn rpc(
        &self,
        tag: &str,
        payload: Value,
        context: RpcSessionContext,
    ) -> Result<Value, Value> {
        self.harness
            .control
            .registry()
            .invoke_local(tag, payload, context, CancellationToken::new())
            .await
    }
}

async fn wait_until(mut condition: impl FnMut() -> bool, context: &str) {
    for _ in 0..300 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting until {context}");
}

fn reason(result: &Value) -> &str {
    result["structuredContent"]["error"]["reason"]
        .as_str()
        .unwrap_or_default()
}

#[tokio::test]
async fn an_agent_clones_beside_its_project_through_the_pinned_address_and_registers_it() {
    let fixture = fixture(Options::default()).await;
    let result = fixture
        .clone(&fixture.agent, json!({ "url": fixture.url() }))
        .await;
    let done = structured(&result);
    assert_eq!(done["state"], "done", "{result}");
    let destination = fixture.projects.join("repo");
    assert_eq!(done["path"], destination.to_string_lossy().as_ref());
    assert!(destination.join("README.md").is_file());
    // `fixture.invalid` resolves nowhere: Git reached the server through the pinned address.
    assert!(fixture.server.connections() > 0);
    let project_id = done["project"]["projectId"].as_str().expect("a project");
    assert_eq!(done["project"]["created"], true);
    assert_eq!(
        fixture.projects_at(&destination.to_string_lossy()).await,
        [project_id]
    );
    let clone_id = done["cloneId"].as_str().expect("a cloneId");
    assert!(clone_id.starts_with("clone-"));
    let status = fixture.status(&fixture.agent, clone_id).await;
    assert_eq!(structured(&status), done);
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn a_keyed_retry_replays_and_a_later_clone_registers_the_finished_folder_once() {
    let fixture = fixture(Options::default()).await;
    let arguments =
        json!({ "url": fixture.url(), "addAsProject": false, "clientRequestId": "first" });
    let first = fixture.clone(&fixture.agent, arguments.clone()).await;
    assert_eq!(structured(&first)["project"], Value::Null);
    assert_eq!(structured(&first)["cloneId"], "first");
    let connections = fixture.server.connections();
    let retried = fixture.clone(&fixture.agent, arguments).await;
    assert_eq!(structured(&retried), structured(&first));

    // As after a restart: a new request for the same URL reuses the finished clone, and
    // registration finds or creates its project, once.
    let path = structured(&first)["path"].as_str().unwrap().to_owned();
    let registered = fixture
        .clone(
            &fixture.agent,
            json!({ "url": fixture.url(), "clientRequestId": "second" }),
        )
        .await;
    let registered = structured(&registered);
    assert_eq!(registered["path"], path.as_str());
    assert_eq!(registered["project"]["created"], true);
    let again = fixture
        .clone(&fixture.agent, json!({ "url": fixture.url() }))
        .await;
    let again = structured(&again);
    assert_eq!(again["project"]["created"], false);
    assert_eq!(
        again["project"]["projectId"],
        registered["project"]["projectId"]
    );
    assert_eq!(fixture.projects_at(&path).await.len(), 1);
    assert_eq!(
        fixture.server.connections(),
        connections,
        "never cloned again"
    );
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn a_destination_holding_anything_else_is_refused() {
    let fixture = fixture(Options::default()).await;
    std::fs::create_dir_all(fixture.projects.join("repo")).unwrap();
    std::fs::write(fixture.projects.join("repo/notes.txt"), "mine").unwrap();
    let result = fixture
        .clone(&fixture.agent, json!({ "url": fixture.url() }))
        .await;
    assert_eq!(error_tag(&result), "GitCommandError");
    assert_eq!(
        std::fs::read_to_string(fixture.projects.join("repo/notes.txt")).unwrap(),
        "mine"
    );
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    let fixture = fixture(Options::default()).await;
    let moved = HttpFixture::start(Serve::RedirectTo(format!(
        // By address, so a followed redirect would reach it without a pin.
        "http://127.0.0.1:{}",
        fixture.server.port
    )))
    .await;
    let url = format!("http://{HOST}:{}/repo.git", moved.port);
    let result = fixture.clone(&fixture.agent, json!({ "url": url })).await;
    assert_eq!(error_tag(&result), "GitCommandError", "{result}");
    let message = result["structuredContent"]["error"]["message"]
        .as_str()
        .unwrap();
    assert!(message.contains("does not follow redirects"), "{message}");
    assert!(moved.connections() > 0);
    assert_eq!(fixture.server.connections(), 0, "the redirect was followed");
    assert!(!fixture.projects.join("repo").exists());
    fixture.harness.shutdown().await;
}

/// Revision 4: a repository's `.lfsconfig` can point `lfs.url` anywhere, and the smudge
/// filter would download from it outside Git's protocol and curl settings. The test's global
/// configuration installs a smudge filter that, like `git-lfs`, contacts that URL.
#[cfg(unix)]
#[tokio::test]
async fn lfs_smudge_never_contacts_the_lfsconfig_endpoint() {
    let lfs = HttpFixture::start(Serve::Files(PathBuf::from("/nonexistent"))).await;
    let scripts = tempfile::tempdir().unwrap();
    let smudge = scripts.path().join("smudge.sh");
    std::fs::write(
        &smudge,
        "#!/bin/sh\nurl=$(sed -n 's/^[[:space:]]*url = //p' .lfsconfig)\ncurl -s -m 5 -o /dev/null -X POST \"$url/objects/batch\"\ncat\n",
    )
    .unwrap();
    let pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";
    let lfs_port = lfs.port;
    let fixture = fixture(Options {
        home_config: format!(
            "[filter \"lfs\"]\n\tsmudge = sh {}\n\trequired = true\n",
            smudge.display()
        ),
        source: Box::new(move |source| {
            std::fs::write(
                source.join(".gitattributes"),
                "*.bin filter=lfs diff=lfs merge=lfs -text\n",
            )
            .unwrap();
            std::fs::write(source.join("model.bin"), pointer).unwrap();
            std::fs::write(
                source.join(".lfsconfig"),
                format!("[lfs]\n\turl = http://127.0.0.1:{lfs_port}/private\n"),
            )
            .unwrap();
        }),
        ..Options::default()
    })
    .await;
    let result = fixture
        .clone(&fixture.agent, json!({ "url": fixture.url() }))
        .await;
    assert_eq!(structured(&result)["state"], "done", "{result}");
    assert_eq!(lfs.connections(), 0, "the LFS endpoint was contacted");
    assert_eq!(
        std::fs::read_to_string(fixture.projects.join("repo/model.bin")).unwrap(),
        pointer
    );
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn agents_clone_over_https_from_public_hosts_only() {
    let fixture = fixture(Options {
        admit_local: false,
        // Rewrites the clone's own folder configures: the rewritten URL is checked again.
        parent_repo_config: Some("[url \"https://10.1.2.3/\"]\n\tinsteadOf = https://public.example.com/private/\n[url \"file:///srv/\"]\n\tinsteadOf = https://public.example.com/local/\n".to_owned()),
        ..Options::default()
    })
    .await;
    // A plain path, which Git clones from on every platform.
    let bare = fixture.bare.display().to_string();
    for (url, expected) in [
        // Revision 4: every transport but HTTPS, SSH included.
        (
            "ssh://public.example.com/owner/repo.git",
            "clone_url_refused",
        ),
        (
            "ssh://git@public.example.com/owner/repo.git",
            "clone_url_refused",
        ),
        ("git@public.example.com:owner/repo.git", "clone_url_refused"),
        (
            "git://public.example.com/owner/repo.git",
            "clone_url_refused",
        ),
        ("file:///srv/repo.git", "clone_url_refused"),
        (bare.as_str(), "clone_url_refused"),
        ("ext::sh -c touch% /tmp/bibcode-x6", "clone_url_refused"),
        (
            "http://public.example.com/owner/repo.git",
            "clone_url_refused",
        ),
        (
            "https://user:token@public.example.com/owner/repo.git",
            "clone_url_refused",
        ),
        ("--upload-pack=touch /tmp/bibcode-x6", "clone_url_refused"),
        // Hosts.
        ("https://127.0.0.1/owner/repo.git", "clone_host_refused"),
        ("https://10.0.0.1/owner/repo.git", "clone_host_refused"),
        (
            "https://loopback.example.com/owner/repo.git",
            "clone_host_refused",
        ),
        // Git's own rewrites are checked too.
        (
            "https://public.example.com/private/repo.git",
            "clone_host_refused",
        ),
        (
            "https://public.example.com/local/repo.git",
            "clone_url_refused",
        ),
    ] {
        let result = fixture
            .clone(&fixture.agent, json!({ "url": url, "directoryName": "x" }))
            .await;
        assert_eq!(error_tag(&result), "GitCommandError", "{url}: {result}");
        assert_eq!(reason(&result), expected, "{url}: {result}");
        // A transport other than HTTPS is refused for being one, not by a later rule.
        if !url.starts_with("https://") && !url.starts_with("--") {
            let message = result["structuredContent"]["error"]["message"]
                .as_str()
                .unwrap_or_default();
            assert!(message.contains("over HTTPS only"), "{url}: {message}");
        }
    }
    let result = fixture
        .clone(
            &fixture.agent,
            json!({ "url": "https://public.example.com/owner/repo.git", "directoryName": "-c" }),
        )
        .await;
    assert_eq!(reason(&result), "clone_url_refused", "{result}");
    // Nothing was created beside the project.
    let entries = std::fs::read_dir(&fixture.projects)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .filter(|name| name != ".git")
        .collect::<Vec<_>>();
    assert_eq!(entries, [PROJECT]);

    // Calling the RPCs directly meets the same policy, and the projects rule.
    let agent = fixture.agent_context(&fixture.agent);
    let direct = fixture
        .rpc(
            "vcs.clone",
            json!({ "url": bare, "parentDir": fixture.projects, "directoryName": "direct" }),
            agent.clone(),
        )
        .await
        .expect_err("refused");
    assert_eq!(direct["reason"], "clone_url_refused", "{direct}");
    let elsewhere = tempfile::tempdir().unwrap();
    let outside = fixture
        .rpc(
            "vcs.clone",
            json!({ "url": "https://public.example.com/owner/repo.git", "parentDir": elsewhere.path() }),
            agent.clone(),
        )
        .await
        .expect_err("refused");
    assert_eq!(outside["reason"], "clone_destination_refused", "{outside}");
    let source_control = fixture
        .rpc(
            "sourceControl.cloneRepository",
            json!({ "remoteUrl": bare, "destinationPath": fixture.projects.join("sc") }),
            agent,
        )
        .await
        .expect_err("refused");
    assert_eq!(source_control["_tag"], "SourceControlRepositoryError");
    assert_eq!(
        source_control["reason"], "clone_url_refused",
        "{source_control}"
    );

    // A person's clone is unchanged: a local repository, anywhere.
    let person = fixture
        .rpc(
            "vcs.clone",
            json!({ "url": bare, "parentDir": elsewhere.path(), "directoryName": "mine" }),
            RpcSessionContext::unauthenticated(),
        )
        .await
        .expect("a person's clone");
    assert!(
        elsewhere.path().join("mine/README.md").is_file(),
        "{person}"
    );
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn a_long_clone_answers_running_and_clone_status_later_returns_the_project() {
    let fixture = fixture(Options::default()).await;
    fixture.server.stall();
    let started = fixture
        .clone_briefly(&fixture.agent, json!({ "url": fixture.url() }))
        .await;
    let started = structured(&started);
    assert_eq!(started["state"], "running", "{started}");
    let clone_id = started["cloneId"].as_str().unwrap().to_owned();
    let status = fixture.status(&fixture.agent, &clone_id).await;
    assert_eq!(structured(&status)["state"], "running");
    fixture.server.release();
    let done = fixture.settled(&fixture.agent, &clone_id).await;
    let done = structured(&done);
    assert_eq!(done["state"], "done");
    assert_eq!(done["project"]["created"], true);
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn cancel_clone_revocation_and_the_off_switch_stop_an_agent_clone_and_remove_its_folder() {
    let fixture = fixture(Options::default()).await;
    fixture.server.stall();
    let start = |agent: ClientPrincipal, name: &'static str| {
        let fixture = &fixture;
        async move {
            let started = fixture
                .clone_briefly(
                    &agent,
                    json!({ "url": fixture.url(), "directoryName": name }),
                )
                .await;
            assert_eq!(structured(&started)["state"], "running", "{started}");
            let folder = fixture.projects.join(name);
            wait_until(|| folder.exists(), "the clone reserved its folder").await;
            (
                agent,
                structured(&started)["cloneId"].as_str().unwrap().to_owned(),
            )
        }
    };

    let (agent, clone_id) = start(fixture.agent.clone(), "cancelled").await;
    let cancelled = fixture
        .harness
        .call(&agent, "cancel_clone", json!({ "cloneId": clone_id }))
        .await;
    let cancelled = structured(&cancelled);
    assert_eq!(cancelled["cancelled"], true, "{cancelled}");
    assert_eq!(cancelled["state"], "unknown");
    assert_eq!(cancelled["error"]["reason"], "cancelled");
    let folder = fixture.projects.join("cancelled");
    wait_until(
        || !folder.exists(),
        "the cancelled clone's folder is removed",
    )
    .await;

    let (agent, clone_id) = start(
        fixture.harness.agent(McpAccess::ApprovalRequired).await.0,
        "revoked",
    )
    .await;
    assert!(
        fixture
            .harness
            .auth
            .revoke_client("someone-else", &agent.principal.session_id)
            .await
            .unwrap()
    );
    let status = fixture.settled(&agent, &clone_id).await;
    assert_eq!(error_tag(&status), "McpOutcomeUnknownError");
    assert_eq!(reason(&status), "revoked");
    let folder = fixture.projects.join("revoked");
    wait_until(|| !folder.exists(), "the revoked clone's folder is removed").await;

    let (agent, clone_id) = start(
        fixture.harness.agent(McpAccess::ApprovalRequired).await.0,
        "off",
    )
    .await;
    fixture.harness.settings.send_replace(McpServerSettings {
        enabled: false,
        ..McpServerSettings::default()
    });
    let folder = fixture.projects.join("off");
    wait_until(
        || !folder.exists(),
        "the clone's folder is removed when MCP is off",
    )
    .await;
    fixture.harness.settings.send_replace(McpServerSettings {
        enabled: true,
        access: McpAccess::FullAccess,
        ..McpServerSettings::default()
    });
    let status = fixture.settled(&agent, &clone_id).await;
    assert_eq!(reason(&status), "mcp-disabled", "{status}");

    let missing = fixture
        .harness
        .call(&fixture.agent, "cancel_clone", json!({ "cloneId": "nope" }))
        .await;
    assert_eq!(error_tag(&missing), "McpCloneNotFoundError");
    fixture.server.release();
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn cancelling_an_agent_clone_that_joined_a_persons_leaves_the_persons_running() {
    let fixture = fixture(Options::default()).await;
    fixture.server.stall();
    // The person's clone, unpinned, so by address.
    let url = format!("http://127.0.0.1:{}/repo.git", fixture.server.port);
    let registry = fixture.harness.control.registry().clone();
    let payload = json!({ "url": url, "parentDir": fixture.projects, "directoryName": "shared" });
    let person = tokio::spawn(async move {
        registry
            .invoke_local(
                "vcs.clone",
                payload,
                RpcSessionContext::unauthenticated(),
                CancellationToken::new(),
            )
            .await
    });
    let folder = fixture.projects.join("shared");
    wait_until(|| folder.exists(), "the person's clone reserved its folder").await;

    let joined = fixture
        .clone_briefly(
            &fixture.agent,
            json!({ "url": url, "directoryName": "shared" }),
        )
        .await;
    let clone_id = structured(&joined)["cloneId"].as_str().unwrap().to_owned();
    // Review round 2: an agent cannot cancel a person's clone through the RPC either.
    let refused = fixture
        .rpc(
            "vcs.cancelClone",
            json!({ "url": url, "parentDir": fixture.projects, "directoryName": "shared" }),
            fixture.agent_context(&fixture.agent),
        )
        .await
        .expect_err("not the agent's clone");
    assert_eq!(refused["reason"], "clone_not_owned", "{refused}");
    assert!(folder.exists(), "the person's clone was stopped");
    let cancelled = fixture
        .harness
        .call(
            &fixture.agent,
            "cancel_clone",
            json!({ "cloneId": clone_id }),
        )
        .await;
    assert_eq!(structured(&cancelled)["state"], "unknown", "{cancelled}");
    assert!(folder.exists(), "the person's clone was stopped");

    fixture.server.release();
    let path = person.await.unwrap().expect("the person's clone finishes");
    assert_eq!(path["path"], folder.to_string_lossy().as_ref());
    assert!(folder.join("README.md").is_file());
    fixture.harness.shutdown().await;
}

/// Review round 2: an agent clone runs with an isolated Git configuration, so programs the
/// person's global configuration names (a hooks folder with `post-checkout`, an fsmonitor, a
/// filter driver a repository's `.gitattributes` asks for) never run for it.
#[cfg(unix)]
#[tokio::test]
async fn the_persons_hooks_fsmonitor_and_filters_never_run_for_an_agent_clone() {
    use std::os::unix::fs::PermissionsExt;

    let programs = tempfile::tempdir().unwrap();
    let markers = programs.path().join("markers");
    std::fs::create_dir_all(&markers).unwrap();
    let touch = programs.path().join("touch.sh");
    std::fs::write(
        &touch,
        format!("#!/bin/sh\ntouch '{}'/\"$1\"\ncat\n", markers.display()),
    )
    .unwrap();
    let hooks = programs.path().join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("post-checkout");
    std::fs::write(
        &hook,
        format!("#!/bin/sh\ntouch '{}'/hook\n", markers.display()),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let touch = touch.display().to_string();
    let fixture = fixture(Options {
        home_config: format!(
            "[core]\n\thooksPath = {hooks}\n\tfsmonitor = sh {touch} fsmonitor\n\
             [filter \"evil\"]\n\tsmudge = sh {touch} filter\n\trequired = true\n",
            hooks = hooks.display(),
        ),
        source: Box::new(|source| {
            std::fs::write(source.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
            std::fs::write(source.join("notes.txt"), "notes\n").unwrap();
        }),
        ..Options::default()
    })
    .await;
    let result = fixture
        .clone(&fixture.agent, json!({ "url": fixture.url() }))
        .await;
    let fired = std::fs::read_dir(&markers)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(
        fired.is_empty(),
        "programs from the person's config ran: {fired:?}"
    );
    assert_eq!(structured(&result)["state"], "done", "{result}");
    assert_eq!(
        std::fs::read_to_string(fixture.projects.join("repo/notes.txt")).unwrap(),
        "notes\n"
    );
    fixture.harness.shutdown().await;
}

/// Review round 2: the person's URL-specific proxy and global rewrite, and an inherited
/// proxy, never reach an agent clone.
#[tokio::test]
async fn the_persons_proxy_and_rewrites_never_reach_an_agent_clone() {
    let config_proxy = HttpFixture::start(Serve::Files(PathBuf::from("/nonexistent"))).await;
    let env_proxy = HttpFixture::start(Serve::Files(PathBuf::from("/nonexistent"))).await;
    let fixture = fixture(Options {
        home_config: format!(
            "[http \"http://{HOST}:{{PORT}}/\"]\n\tproxy = http://127.0.0.1:{proxy}\n\
             [url \"http://{HOST}:{{PORT}}/missing.git\"]\n\tinsteadOf = http://{HOST}:{{PORT}}/repo.git\n",
            proxy = config_proxy.port,
        ),
        environment: vec![
            ("http_proxy", format!("http://127.0.0.1:{}", env_proxy.port)),
            ("all_proxy", format!("http://127.0.0.1:{}", env_proxy.port)),
        ],
        ..Options::default()
    })
    .await;
    let result = fixture
        .clone(&fixture.agent, json!({ "url": fixture.url() }))
        .await;
    assert_eq!(
        config_proxy.connections(),
        0,
        "the configured proxy was used"
    );
    assert_eq!(env_proxy.connections(), 0, "the inherited proxy was used");
    // Not rewritten to the missing repository.
    assert_eq!(structured(&result)["state"], "done", "{result}");
    fixture.harness.shutdown().await;
}
/// Review round 2: an inherited proxy alone is not used either.
#[tokio::test]
async fn an_inherited_proxy_never_carries_an_agent_clone() {
    let env_proxy = HttpFixture::start(Serve::Files(PathBuf::from("/nonexistent"))).await;
    let fixture = fixture(Options {
        environment: vec![("http_proxy", format!("http://127.0.0.1:{}", env_proxy.port))],
        ..Options::default()
    })
    .await;
    let result = fixture
        .clone(&fixture.agent, json!({ "url": fixture.url() }))
        .await;
    assert_eq!(env_proxy.connections(), 0, "the inherited proxy was used");
    assert_eq!(structured(&result)["state"], "done", "{result}");
    fixture.harness.shutdown().await;
}

/// Review round 2: a URL-specific `http.<url>.followRedirects` in the person's config does
/// not undo the agent clone's redirect ban.
#[tokio::test]
async fn a_url_specific_setting_cannot_turn_redirects_back_on() {
    let target = fixture(Options::default()).await;
    let moved = HttpFixture::start(Serve::RedirectTo(format!(
        "http://127.0.0.1:{}",
        target.server.port
    )))
    .await;
    let fixture = fixture(Options {
        home_config: format!(
            "[http \"http://{HOST}:{}/\"]\n\tfollowRedirects = true\n",
            moved.port
        ),
        ..Options::default()
    })
    .await;
    let url = format!("http://{HOST}:{}/repo.git", moved.port);
    let result = fixture.clone(&fixture.agent, json!({ "url": url })).await;
    assert_eq!(error_tag(&result), "GitCommandError", "{result}");
    assert_eq!(target.server.connections(), 0, "the redirect was followed");
    fixture.harness.shutdown().await;
    target.harness.shutdown().await;
}

/// Review round 2: through the RPC an agent cannot start a clone that outlives its call, and
/// cancels only a clone it started.
#[tokio::test]
async fn an_agent_may_not_detach_a_clone_and_cancels_only_its_own() {
    let fixture = fixture(Options::default()).await;
    let agent = fixture.agent_context(&fixture.agent);
    let detached = fixture
        .rpc(
            "vcs.clone",
            json!({ "url": fixture.url(), "parentDir": fixture.projects, "directoryName": "detached", "detach": true }),
            agent.clone(),
        )
        .await
        .expect_err("refused");
    assert_eq!(detached["reason"], "clone_detach_refused", "{detached}");
    assert!(!fixture.projects.join("detached").exists());

    fixture.server.stall();
    let registry = fixture.harness.control.registry().clone();
    let payload =
        json!({ "url": fixture.url(), "parentDir": fixture.projects, "directoryName": "own" });
    let started = tokio::spawn({
        let agent = agent.clone();
        async move {
            registry
                .invoke_local("vcs.clone", payload, agent, CancellationToken::new())
                .await
        }
    });
    let folder = fixture.projects.join("own");
    wait_until(|| folder.exists(), "the agent's clone reserved its folder").await;
    let cancelled = fixture
        .rpc(
            "vcs.cancelClone",
            json!({ "url": fixture.url(), "parentDir": fixture.projects, "directoryName": "own" }),
            agent,
        )
        .await
        .expect("an agent cancels its own clone");
    assert_eq!(cancelled["cancelled"], true);
    assert!(started.await.unwrap().is_err());
    assert!(!folder.exists());
    fixture.server.release();
    fixture.harness.shutdown().await;
}

/// Server variables an agent clone must not inherit, as the reviews named them.
const INHERITED: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_SSL_NO_VERIFY",
    "GIT_SSL_CAINFO",
    "GIT_SSL_CAPATH",
    "GIT_SSL_CERT",
    "GIT_SSL_KEY",
    "GIT_SSL_CIPHER_LIST",
    "GIT_SSL_VERSION",
    "CURL_CA_BUNDLE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "GIT_TEMPLATE_DIR",
    "GIT_EXEC_PATH",
    "GIT_TRACE",
    "GIT_TRACE2",
    "GIT_TRACE_PACKFILE",
];
const INHERITED_TEST: &str = "production::mcp_tools_tests::clone::an_inherited_server_environment_never_reaches_an_agent_clone";
const INHERITED_PHASE: &str = "inherited-environment";
/// The folder the inherited variables point into.
const OUTSIDE: &str = "BIBCODE_X6_OUTSIDE";
/// A variable outside the allowlist, which a person's commands keep inheriting.
const KEPT: &str = "BIBCODE_X6_KEPT";

/// Review round 2: an agent clone's commands inherit only an allowlist of the server's
/// variables. In a process of its own that inherits a repository location
/// (`GIT_WORK_TREE`, `GIT_DIR`, `GIT_INDEX_FILE`) outside the destination, the TLS trust
/// overrides (exported empty), a `GIT_TEMPLATE_DIR` with an active `pre-commit` hook, a
/// `GIT_EXEC_PATH` with fake `git-remote-http(s)` helpers that record being run, and
/// `GIT_TRACE`, `GIT_TRACE2` and `GIT_TRACE_PACKFILE` files: the clone lands in its folder with
/// no hooks, the helpers never run, no trace file appears, and nothing is written outside. A
/// person's commands keep the whole environment.
#[cfg(unix)]
#[tokio::test]
async fn an_inherited_server_environment_never_reaches_an_agent_clone() {
    use std::os::unix::fs::PermissionsExt;

    use crate::{
        git::{OutputPolicy, ProcessRequest, ProcessRunner, clone_policy::inherited_environment},
        test_support::reexec,
    };

    let executable = |path: &Path, text: &str| {
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    };
    let Some(child) = reexec::enter(INHERITED_TEST, INHERITED_PHASE) else {
        let outside = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let base = elsewhere.path();
        let templates = base.join("templates");
        std::fs::create_dir_all(templates.join("hooks")).unwrap();
        executable(
            &templates.join("hooks/pre-commit"),
            &format!("#!/bin/sh\ntouch '{}/pre-commit-ran'\n", base.display()),
        );
        let exec_path = base.join("exec-path");
        std::fs::create_dir_all(&exec_path).unwrap();
        for helper in ["git-remote-http", "git-remote-https"] {
            executable(
                &exec_path.join(helper),
                &format!("#!/bin/sh\ntouch '{}/helper-ran'\nexit 1\n", base.display()),
            );
        }
        reexec::run(INHERITED_TEST, INHERITED_PHASE, None, |command| {
            for name in INHERITED {
                command.env(name, "");
            }
            command
                .env("GIT_WORK_TREE", outside.path())
                .env("GIT_DIR", outside.path().join("git-dir"))
                .env("GIT_INDEX_FILE", outside.path().join("index"))
                .env("GIT_TEMPLATE_DIR", &templates)
                .env("GIT_EXEC_PATH", &exec_path)
                .env("GIT_TRACE", outside.path().join("trace"))
                .env("GIT_TRACE2", outside.path().join("trace2"))
                .env("GIT_TRACE_PACKFILE", outside.path().join("packfile"))
                .env(OUTSIDE, outside.path())
                .env(KEPT, "kept");
        });
        assert!(
            !base.join("helper-ran").exists(),
            "the fake remote helper ran"
        );
        let written = std::fs::read_dir(outside.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert!(written.is_empty(), "written outside the clone: {written:?}");
        return;
    };

    let outside = PathBuf::from(std::env::var_os(OUTSIDE).expect("the outside folder"));
    let fixture = fixture(Options::default()).await;
    // Only what the agent clone writes counts: clear what the setup's own Git left.
    for entry in std::fs::read_dir(&outside).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path).unwrap();
        } else {
            std::fs::remove_file(&path).unwrap();
        }
    }
    let result = fixture
        .clone(
            &fixture.agent,
            json!({ "url": fixture.url(), "addAsProject": false }),
        )
        .await;
    assert_eq!(structured(&result)["state"], "done", "{result}");
    let destination = fixture.projects.join("repo");
    assert!(destination.join("README.md").is_file());
    let hooks = destination.join(".git/hooks");
    let copied = std::fs::read_dir(&hooks)
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    assert!(
        copied.is_empty(),
        "hooks were copied into the clone: {copied:?}"
    );
    let written = std::fs::read_dir(&outside)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert!(written.is_empty(), "written outside the clone: {written:?}");
    fixture.harness.shutdown().await;

    let cwd = tempfile::tempdir().unwrap();
    let request = |env| ProcessRequest {
        operation: "test.environment".into(),
        command: PathBuf::from("env"),
        args: Vec::new(),
        cwd: cwd.path().to_path_buf(),
        env,
        stdin: None,
        timeout: Duration::from_secs(10),
        max_output_bytes: 1 << 20,
        output_policy: OutputPolicy::Truncate,
        append_truncation_marker: false,
        allow_non_zero_exit: false,
    };
    let names = |output: String| {
        output
            .lines()
            .filter_map(|line| line.split_once('=').map(|(name, _)| name.to_owned()))
            .collect::<std::collections::HashSet<_>>()
    };
    let token = CancellationToken::new();
    let isolated = names(
        ProcessRunner
            .run_cleared(request(inherited_environment()), &token)
            .await
            .expect("env runs")
            .stdout,
    );
    let inherited = names(
        ProcessRunner
            .run(request(Vec::new()), &token)
            .await
            .expect("env runs")
            .stdout,
    );
    for name in INHERITED.iter().chain(&[KEPT]) {
        assert!(!isolated.contains(*name), "an agent clone inherits {name}");
        assert!(inherited.contains(*name), "a person's command lost {name}");
    }
    assert!(isolated.contains("PATH"), "an agent clone lost PATH");

    child.complete();
}
