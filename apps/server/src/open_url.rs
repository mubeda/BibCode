//! The open-URL hook. Agents and terminals get `BROWSER=bibcode-open-url` and a `PATH` entry
//! holding that shim; the shim runs `<exe> open-url <url>`, which hands the URL to the BiBCode
//! client showing the thread through `POST /api/preview/open-url`.

use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fmt, io,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};

use crate::production::connect_mcp::ConnectMcpService;

pub const SHIM_NAME: &str = "bibcode-open-url";
pub const TOKEN_ENV: &str = "BIBCODE_OPEN_URL_TOKEN";
pub const ENDPOINT_ENV: &str = "BIBCODE_OPEN_URL_ENDPOINT";
const POST_TIMEOUT: Duration = Duration::from_secs(5);
const PATH_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// Writes `bibcode-open-url` (POSIX sh, mode 0755) and `bibcode-open-url.cmd` into `dir`, each
/// pointing at `exe`. A shim whose content is already current is left alone.
pub fn write_shims(dir: &Path, exe: &Path) -> io::Result<()> {
    let exe = exe.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("executable path is not UTF-8: {}", exe.display()),
        )
    })?;
    std::fs::create_dir_all(dir)?;
    write_if_changed(&dir.join(SHIM_NAME), &posix_shim(exe))?;
    write_if_changed(&dir.join(format!("{SHIM_NAME}.cmd")), &windows_shim(exe))
}

fn posix_shim(exe: &str) -> String {
    // Single quotes keep every byte of the path literal; an embedded quote closes, escapes, reopens.
    let exe = format!("'{}'", exe.replace('\'', r"'\''"));
    format!(
        "#!/bin/sh\n# BiBCode open-url shim: hands one URL to the BiBCode client showing this thread.\nexec {exe} open-url \"$1\"\n"
    )
}

fn windows_shim(exe: &str) -> String {
    // A batch file expands `%…%` even inside quotes; Windows paths cannot contain `"`.
    // `"%~1"` drops the caller's quotes and quotes the URL itself, so an `&` or `|` that
    // reached the batch parser escaped (`^&`) stays inside the argument.
    // ponytail: a raw `"` in the argument still ends the quoting (the batch-file argument
    // problem every `.cmd` has); valid URLs percent-encode it. A `bibcode-open-url.exe` alias
    // would remove batch parsing entirely if Windows callers need that guarantee.
    format!(
        "@echo off\r\n\"{}\" open-url \"%~1\"\r\n",
        exe.replace('%', "%%")
    )
}

fn write_if_changed(path: &Path, contents: &str) -> io::Result<()> {
    if std::fs::read(path).is_ok_and(|current| current == contents.as_bytes()) {
        return set_executable(path);
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let temporary = path.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = std::fs::write(&temporary, contents)
        .and_then(|()| set_executable(&temporary))
        .and_then(|()| std::fs::rename(&temporary, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn set_executable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// The variables a provider or terminal session gets: the credential, the route, the two
/// browser hooks, and `PATH` with the shim directory first.
#[must_use]
pub fn session_env(
    endpoint: &str,
    token: &str,
    shim_dir: &Path,
    base_path: Option<&OsStr>,
) -> BTreeMap<String, String> {
    let shim_dir = shim_dir.to_string_lossy();
    let path = match base_path.filter(|base| !base.is_empty()) {
        Some(base) => format!("{shim_dir}{PATH_SEPARATOR}{}", base.to_string_lossy()),
        None => shim_dir.into_owned(),
    };
    BTreeMap::from([
        (TOKEN_ENV.to_owned(), token.to_owned()),
        (ENDPOINT_ENV.to_owned(), endpoint.to_owned()),
        ("BROWSER".to_owned(), SHIM_NAME.to_owned()),
        ("BRAINSTORM_OPEN_CMD".to_owned(), SHIM_NAME.to_owned()),
        ("PATH".to_owned(), path),
    ])
}

/// One issued open-url credential, ready to merge into a launch environment.
#[derive(Clone, Eq, PartialEq)]
pub struct OpenUrlSession {
    pub endpoint: String,
    pub token: String,
    pub shim_dir: PathBuf,
}

impl fmt::Debug for OpenUrlSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenUrlSession")
            .field("endpoint", &self.endpoint)
            .field("token", &"[redacted]")
            .field("shim_dir", &self.shim_dir)
            .finish()
    }
}

impl OpenUrlSession {
    /// Merges the session variables into `env`; they win over the caller's values. `PATH`
    /// prefixes the caller's own `PATH`, else the server's.
    pub fn apply(&self, env: &mut BTreeMap<String, String>) {
        let base_path = env
            .iter()
            .find(|(key, _)| same_env_key(key, "PATH"))
            .map(|(_, value)| OsString::from(value))
            .or_else(|| std::env::var_os("PATH"));
        for (key, value) in session_env(
            &self.endpoint,
            &self.token,
            &self.shim_dir,
            base_path.as_deref(),
        ) {
            env.retain(|existing, _| !same_env_key(existing, &key));
            env.insert(key, value);
        }
    }
}

/// Windows keys ignore case. `PATH` ignores case everywhere, as provider environment
/// normalization and PTY executable lookup already treat it.
fn same_env_key(left: &str, right: &str) -> bool {
    left == right || ((cfg!(windows) || right == "PATH") && left.eq_ignore_ascii_case(right))
}

/// Issues open-url sessions once the server's credential store is attached. Until then (and
/// in servers without one) sessions launch without the hook.
#[derive(Clone)]
pub struct OpenUrlEnvironment {
    shim_dir: PathBuf,
    connect: Arc<OnceLock<Arc<ConnectMcpService>>>,
}

impl fmt::Debug for OpenUrlEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenUrlEnvironment")
            .field("shim_dir", &self.shim_dir)
            .field("bound", &self.connect.get().is_some())
            .finish()
    }
}

impl OpenUrlEnvironment {
    #[must_use]
    pub fn new(shim_dir: PathBuf) -> Self {
        Self {
            shim_dir,
            connect: Arc::new(OnceLock::new()),
        }
    }

    pub fn bind(&self, connect: Arc<ConnectMcpService>) {
        let _ = self.connect.set(connect);
    }

    /// A fresh credential for `thread_id`. Issuing never revokes another holder's token, so a
    /// provider and each terminal of one thread hold their own.
    pub async fn issue(&self, thread_id: &str) -> Option<OpenUrlSession> {
        let connect = self.connect.get()?;
        match connect.issue_open_url_credential(thread_id).await {
            Ok(credential) => Some(OpenUrlSession {
                endpoint: connect.open_url_endpoint().to_owned(),
                token: credential.token,
                shim_dir: self.shim_dir.clone(),
            }),
            Err(error) => {
                tracing::warn!(?error, thread_id, "could not issue an open-url credential");
                None
            }
        }
    }
}

/// `bibcode open-url <url>`: asks the BiBCode client showing this session's thread to open
/// `url`. Returns the process exit code. A tool calling `$BROWSER` must never fail because
/// BiBCode is unreachable, so every failure after validation prints the URL and exits 0.
pub async fn run_open_url(url: &str) -> i32 {
    let endpoint = std::env::var(ENDPOINT_ENV).ok();
    let token = std::env::var(TOKEN_ENV).ok();
    open_url(url, endpoint.as_deref(), token.as_deref()).await
}

async fn open_url(url: &str, endpoint: Option<&str>, token: Option<&str>) -> i32 {
    if !url::Url::parse(url).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https")) {
        eprintln!("bibcode open-url: expected an http(s) URL");
        return 2;
    }
    let (Some(endpoint), Some(token)) = (
        endpoint.filter(|value| !value.is_empty()),
        token.filter(|value| !value.is_empty()),
    ) else {
        println!("{url}");
        return 0;
    };
    if let Err(error) = post_open_request(url, endpoint, token).await {
        println!("{url}");
        eprintln!("bibcode open-url: {error}");
    }
    0
}

async fn post_open_request(url: &str, endpoint: &str, token: &str) -> Result<(), String> {
    // The endpoint is this machine's own server; a user's HTTP proxy must not intercept it.
    let client = reqwest::Client::builder()
        .timeout(POST_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(endpoint)
        .bearer_auth(token)
        .json(&serde_json::json!({ "url": url }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status() == reqwest::StatusCode::ACCEPTED {
        Ok(())
    } else {
        Err(format!("BiBCode answered {}", response.status()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn shim_passes_metacharacters_as_one_argument() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("argv");
        // A quote and a space in the executable path prove the shim's own quoting.
        let exe = temp.path().join("it's the exe");
        crate::test_support::TestSandbox::write_executable(
            &exe,
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$#\" > '{}'\nfor arg in \"$@\"; do printf '%s\\0' \"$arg\" >> '{}'; done\n",
                output.display(),
                output.display()
            ),
        );
        let shims = temp.path().join("shims");
        write_shims(&shims, &exe).unwrap();
        let shim = shims.join(SHIM_NAME);
        assert_eq!(
            std::fs::metadata(&shim).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let url = "http://h/?a=$(x)&b=`y`;c' \"d\" $HOME";

        // `sh <shim>` reads the script instead of exec'ing it, so a sibling test's fork can
        // never hold the freshly written shim busy (ETXTBSY).
        let status = std::process::Command::new("/bin/sh")
            .arg(&shim)
            .arg(url)
            .status()
            .unwrap();

        assert!(status.success());
        let recorded = std::fs::read(&output).unwrap();
        let (count, args) = recorded.split_at(recorded.iter().position(|b| *b == b'\n').unwrap());
        assert_eq!(count, b"2");
        let args = args[1..]
            .split(|b| *b == 0)
            .filter(|arg| !arg.is_empty())
            .map(|arg| String::from_utf8(arg.to_vec()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(args, vec!["open-url".to_owned(), url.to_owned()]);
    }

    #[test]
    fn shims_are_rewritten_only_when_their_content_changes() {
        let temp = tempfile::tempdir().unwrap();
        write_shims(temp.path(), Path::new("/opt/bibcode/bibcode")).unwrap();
        let shim = temp.path().join(SHIM_NAME);
        let first = std::fs::metadata(&shim).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        write_shims(temp.path(), Path::new("/opt/bibcode/bibcode")).unwrap();
        assert_eq!(std::fs::metadata(&shim).unwrap().modified().unwrap(), first);

        write_shims(temp.path(), Path::new("/opt/100%/bibcode")).unwrap();
        assert!(
            std::fs::read_to_string(&shim)
                .unwrap()
                .contains("exec '/opt/100%/bibcode' open-url \"$1\"")
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join(format!("{SHIM_NAME}.cmd"))).unwrap(),
            "@echo off\r\n\"/opt/100%%/bibcode\" open-url \"%~1\"\r\n"
        );
        // No temporary file survives.
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
    }

    #[test]
    fn session_env_prefixes_path_and_sets_browser() {
        let shim_dir = Path::new("/state/runtime/open-url");
        let env = session_env(
            "http://127.0.0.1:3773/api/preview/open-url",
            "token-1",
            shim_dir,
            Some(OsStr::new("/usr/bin")),
        );
        let separator = PATH_SEPARATOR;
        assert_eq!(
            env,
            BTreeMap::from([
                ("BIBCODE_OPEN_URL_TOKEN".to_owned(), "token-1".to_owned()),
                (
                    "BIBCODE_OPEN_URL_ENDPOINT".to_owned(),
                    "http://127.0.0.1:3773/api/preview/open-url".to_owned()
                ),
                ("BROWSER".to_owned(), "bibcode-open-url".to_owned()),
                (
                    "BRAINSTORM_OPEN_CMD".to_owned(),
                    "bibcode-open-url".to_owned()
                ),
                (
                    "PATH".to_owned(),
                    format!("/state/runtime/open-url{separator}/usr/bin")
                ),
            ])
        );
        assert_eq!(
            session_env("e", "t", shim_dir, None)["PATH"],
            "/state/runtime/open-url"
        );
    }

    #[test]
    fn session_apply_wins_over_the_callers_values_and_keeps_its_path() {
        let session = OpenUrlSession {
            endpoint: "http://127.0.0.1:1/api/preview/open-url".to_owned(),
            token: "secret-token-value".to_owned(),
            shim_dir: PathBuf::from("/shims"),
        };
        let mut env = BTreeMap::from([
            ("BROWSER".to_owned(), "firefox".to_owned()),
            ("Path".to_owned(), "/custom/bin".to_owned()),
            ("KEEP".to_owned(), "1".to_owned()),
        ]);
        session.apply(&mut env);
        assert_eq!(env["BROWSER"], "bibcode-open-url");
        assert_eq!(env["PATH"], format!("/shims{PATH_SEPARATOR}/custom/bin"));
        assert!(!env.contains_key("Path"));
        assert_eq!(env["KEEP"], "1");
        assert_eq!(env[TOKEN_ENV], "secret-token-value");
        assert!(!format!("{session:?}").contains("secret-token-value"));
    }

    #[tokio::test]
    async fn run_open_url_rejects_non_http() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "",
            "localhost:5173",
        ] {
            assert_eq!(run_open_url(url).await, 2, "{url}");
        }
    }

    #[tokio::test]
    async fn open_url_without_a_session_or_server_still_succeeds() {
        assert_eq!(open_url("http://localhost:5173/", None, None).await, 0);
        // Nothing listens on port 9 of loopback: the failure is reported, not returned.
        assert_eq!(
            open_url(
                "http://localhost:5173/",
                Some("http://127.0.0.1:9/api/preview/open-url"),
                Some("token")
            )
            .await,
            0
        );
    }
}
