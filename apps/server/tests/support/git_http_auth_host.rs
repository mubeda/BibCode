//! A Git smart-HTTP host on `127.0.0.1` that requires HTTP Basic credentials and serves one
//! bare repository through `git http-backend`, so pushes exercise Git's real credential path.

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
};

use base64::Engine;

pub struct GitHttpAuthHost {
    address: SocketAddr,
    name: String,
    receive_pack_requests: Arc<AtomicUsize>,
}

struct Served {
    project_root: PathBuf,
    authorization: String,
    receive_pack_requests: Arc<AtomicUsize>,
}

impl GitHttpAuthHost {
    /// Serves the bare repository `repo` to `user`/`password` only, with `http.receivepack` on.
    // shortcut: the accept thread lives until the test process exits, fine for test binaries.
    pub fn start(repo: &Path, user: &str, password: &str) -> Self {
        let status = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["config", "http.receivepack", "true"])
            .status()
            .expect("configure the served repository");
        assert!(status.success(), "http.receivepack");
        let listener = TcpListener::bind("127.0.0.1:0").expect("Git host listener");
        let address = listener.local_addr().expect("Git host address");
        let receive_pack_requests = Arc::new(AtomicUsize::new(0));
        let served = Arc::new(Served {
            project_root: repo.parent().expect("repository parent").to_path_buf(),
            authorization: format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"))
            ),
            receive_pack_requests: receive_pack_requests.clone(),
        });
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let served = served.clone();
                thread::spawn(move || served.answer(stream));
            }
        });
        Self {
            address,
            name: repo
                .file_name()
                .expect("repository name")
                .to_string_lossy()
                .into_owned(),
            receive_pack_requests,
        }
    }

    pub fn url(&self) -> String {
        format!("http://{}/{}", self.address, self.name)
    }

    /// How many times Git asked to start a push (`info/refs?service=git-receive-pack`).
    pub fn receive_pack_requests(&self) -> usize {
        self.receive_pack_requests.load(Ordering::SeqCst)
    }
}

impl Served {
    /// One request per connection; `Connection: close` makes Git reconnect for the next.
    fn answer(&self, stream: TcpStream) {
        let mut reader = BufReader::new(stream.try_clone().expect("clone connection"));
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
            return;
        }
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_owned();
        let target = parts.next().unwrap_or_default().to_owned();
        let mut headers = Vec::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
            }
        }
        let header = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
        if path.ends_with("/info/refs") && query == "service=git-receive-pack" {
            self.receive_pack_requests.fetch_add(1, Ordering::SeqCst);
        }
        let mut stream = stream;
        if header("authorization").as_deref() != Some(self.authorization.as_str()) {
            let _ = stream.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
        // shortcut: reads a Content-Length body only; a push over http.postBuffer (1 MiB) is
        // chunked and would need chunked decoding here.
        let length = header("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = vec![0; length];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        let mut backend = Command::new("git")
            .arg("http-backend")
            .env("GIT_PROJECT_ROOT", &self.project_root)
            .env("GIT_HTTP_EXPORT_ALL", "1")
            .env("REQUEST_METHOD", &method)
            .env("PATH_INFO", path)
            .env("QUERY_STRING", query)
            .env("CONTENT_TYPE", header("content-type").unwrap_or_default())
            .env("CONTENT_LENGTH", length.to_string())
            .env(
                "HTTP_CONTENT_ENCODING",
                header("content-encoding").unwrap_or_default(),
            )
            .env("REMOTE_USER", "test-user")
            .env("REMOTE_ADDR", "127.0.0.1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start git http-backend");
        backend
            .stdin
            .take()
            .expect("backend stdin")
            .write_all(&body)
            .expect("request body");
        let output = backend.wait_with_output().expect("git http-backend output");
        let split = output
            .stdout
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|at| (at, 4))
            .or_else(|| {
                output
                    .stdout
                    .windows(2)
                    .position(|window| window == b"\n\n")
                    .map(|at| (at, 2))
            })
            .expect("CGI headers");
        let cgi_headers = String::from_utf8_lossy(&output.stdout[..split.0]).into_owned();
        let response_body = &output.stdout[split.0 + split.1..];
        let mut status = "200 OK".to_owned();
        let mut response = String::new();
        for line in cgi_headers.lines() {
            match line.split_once(':') {
                Some((name, value)) if name.eq_ignore_ascii_case("status") => {
                    status = value.trim().to_owned();
                }
                Some(_) => {
                    response.push_str(line.trim_end());
                    response.push_str("\r\n");
                }
                None => {}
            }
        }
        let head = format!(
            "HTTP/1.1 {status}\r\n{response}Content-Length: {}\r\nConnection: close\r\n\r\n",
            response_body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(response_body);
    }
}
