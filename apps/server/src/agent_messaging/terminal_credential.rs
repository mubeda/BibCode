//! The credential of one AI Terminal process: issued at launch into that terminal's own
//! environment, bound to its generation, and refused once another process holds the terminal.
//! It names the terminal for agent messaging calls and grants nothing else.

use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsString,
    fmt,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, OnceLock},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use tokio::{
    sync::{Mutex, broadcast::error::RecvError},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::terminal::{
    TerminalEvent, TerminalEventReceiver, TerminalGeneration, TerminalManager,
    TerminalSessionLaunch,
};

/// Not `*_TOKEN`: Codex's default `shell_environment_policy` drops variables whose names
/// contain `KEY`, `SECRET`, or `TOKEN` from the commands it runs.
pub const AUTH_ENV: &str = "BIBCODE_AGENT_AUTH";
pub const ENDPOINT_ENV: &str = "BIBCODE_AGENT_ENDPOINT";
const PATH_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// Which process holds a terminal now.
pub trait LiveGenerations: Send + Sync {
    fn live_generation<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Option<TerminalGeneration>> + Send + 'a>>;
}

impl LiveGenerations for TerminalManager {
    fn live_generation<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Option<TerminalGeneration>> + Send + 'a>> {
        Box::pin(TerminalManager::live_generation(
            self,
            thread_id,
            terminal_id,
        ))
    }
}

/// The terminal process a credential names. `thread_id` is the terminal's owner thread.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalIdentity {
    pub environment_id: String,
    pub thread_id: String,
    pub terminal_id: String,
    pub generation: TerminalGeneration,
}

impl TerminalIdentity {
    #[must_use]
    pub fn address(&self) -> String {
        format!("terminal:{}/{}", self.thread_id, self.terminal_id)
    }

    /// The form stored in `agent_messages.recipient_terminal_generation`.
    #[must_use]
    pub fn generation_key(&self) -> String {
        generation_key(&self.generation)
    }
}

fn generation_key(generation: &TerminalGeneration) -> String {
    format!("{}:{}", generation.boot, generation.process)
}

/// `terminal:{thread}/{terminal}` into its two ids; anything else, a chat address included,
/// is `None`.
#[must_use]
pub fn parse_terminal_address(text: &str) -> Option<(String, String)> {
    let (thread_id, terminal_id) = text.strip_prefix("terminal:")?.split_once('/')?;
    (!thread_id.is_empty() && !terminal_id.is_empty() && !terminal_id.contains('/'))
        .then(|| (thread_id.to_owned(), terminal_id.to_owned()))
}

/// Issues, verifies and revokes terminal credentials. Stores only token hashes. Clones share
/// one store.
#[derive(Clone)]
pub struct TerminalCredentials {
    environment_id: String,
    shim_dir: PathBuf,
    bound: Arc<OnceLock<(String, Arc<dyn LiveGenerations>)>>,
    tokens: Arc<Mutex<HashMap<String, TerminalIdentity>>>,
}

impl fmt::Debug for TerminalCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalCredentials")
            .field("environment_id", &self.environment_id)
            .field("shim_dir", &self.shim_dir)
            .field("bound", &self.bound.get().is_some())
            .field("tokens", &"[redacted]")
            .finish()
    }
}

impl TerminalCredentials {
    #[must_use]
    pub fn new(environment_id: String, shim_dir: PathBuf) -> Self {
        Self {
            environment_id,
            shim_dir,
            bound: Arc::new(OnceLock::new()),
            tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Until bound, launches get no credential.
    pub fn bind(&self, endpoint: String, live: Arc<dyn LiveGenerations>) {
        let _ = self.bound.set((endpoint, live));
    }

    /// Gives an AI Terminal launch its own credential. Removes any supplied credential first,
    /// so a caller can never choose one.
    pub async fn issue(
        &self,
        launch: &TerminalSessionLaunch<'_>,
        env: &mut BTreeMap<String, String>,
    ) {
        env.retain(|key, _| {
            !key.eq_ignore_ascii_case(AUTH_ENV) && !key.eq_ignore_ascii_case(ENDPOINT_ENV)
        });
        if !launch.ai_terminal {
            return;
        }
        let Some((endpoint, _)) = self.bound.get() else {
            return;
        };
        let mut token_bytes = [0_u8; 32];
        if getrandom::fill(&mut token_bytes).is_err() {
            tracing::warn!("could not issue an AI Terminal credential: no randomness");
            return;
        }
        let token = URL_SAFE_NO_PAD.encode(token_bytes);
        self.tokens.lock().await.insert(
            hash_token(&token),
            TerminalIdentity {
                environment_id: self.environment_id.clone(),
                thread_id: launch.thread_id.to_owned(),
                terminal_id: launch.terminal_id.to_owned(),
                generation: launch.generation.clone(),
            },
        );
        let path_key = env
            .keys()
            .find(|key| key.eq_ignore_ascii_case("PATH"))
            .cloned();
        let base_path = path_key
            .as_ref()
            .and_then(|key| env.remove(key))
            .map(OsString::from)
            .or_else(|| std::env::var_os("PATH"))
            .filter(|base| !base.is_empty());
        let shim_dir = self.shim_dir.to_string_lossy();
        let path = match base_path {
            Some(base) => format!("{shim_dir}{PATH_SEPARATOR}{}", base.to_string_lossy()),
            None => shim_dir.into_owned(),
        };
        env.insert(path_key.unwrap_or_else(|| "PATH".to_owned()), path);
        env.insert(AUTH_ENV.to_owned(), token);
        env.insert(ENDPOINT_ENV.to_owned(), endpoint.clone());
    }

    /// The terminal a token names, while that terminal still runs the process it was issued to.
    pub async fn verify(&self, token: &str) -> Option<TerminalIdentity> {
        let (_, live) = self.bound.get()?;
        let identity = self.tokens.lock().await.get(&hash_token(token)).cloned()?;
        let current = live
            .live_generation(&identity.thread_id, &identity.terminal_id)
            .await?;
        (current == identity.generation).then_some(identity)
    }

    /// Revokes the tokens issued to one ended process, never those of a later one.
    pub async fn revoke_generation(&self, generation_key: &str) {
        self.tokens
            .lock()
            .await
            .retain(|_, identity| identity.generation_key() != generation_key);
    }

    /// Revokes every token of a terminal issued to a process older than the live one. A newer
    /// process's token, issued before that process is published, is kept.
    pub async fn sweep(&self, thread_id: &str, terminal_id: &str) {
        let Some((_, live)) = self.bound.get() else {
            return;
        };
        let Some(current) = live.live_generation(thread_id, terminal_id).await else {
            return;
        };
        self.tokens.lock().await.retain(|_, identity| {
            identity.thread_id != thread_id
                || identity.terminal_id != terminal_id
                || (identity.generation.boot == current.boot
                    && identity.generation.process >= current.process)
        });
    }

    /// Revokes on every ended process: `Exited` and `Closed` by their generation, `Restarted`
    /// by a sweep. A missed event leaves a token that `verify` already refuses.
    pub fn spawn_revoker(
        &self,
        mut events: TerminalEventReceiver,
        shutdown: CancellationToken,
    ) -> JoinHandle<()> {
        let credentials = self.clone();
        tokio::spawn(async move {
            loop {
                let event = tokio::select! {
                    () = shutdown.cancelled() => return,
                    event = events.recv() => event,
                };
                match event {
                    Ok(
                        TerminalEvent::Exited {
                            generation: Some(generation),
                            ..
                        }
                        | TerminalEvent::Closed {
                            generation: Some(generation),
                            ..
                        },
                    ) => {
                        credentials
                            .revoke_generation(&generation_key(&generation))
                            .await;
                    }
                    Ok(TerminalEvent::Restarted {
                        thread_id,
                        terminal_id,
                        ..
                    }) => credentials.sweep(&thread_id, &terminal_id).await,
                    Ok(_) | Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => return,
                }
            }
        })
    }
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENDPOINT: &str = "http://127.0.0.1:3773/api/agent/call";

    #[derive(Default)]
    struct FakeLive {
        live: std::sync::Mutex<HashMap<(String, String), TerminalGeneration>>,
    }

    impl FakeLive {
        fn set(&self, thread_id: &str, terminal_id: &str, generation: Option<TerminalGeneration>) {
            let mut live = self.live.lock().unwrap();
            let key = (thread_id.to_owned(), terminal_id.to_owned());
            match generation {
                Some(generation) => live.insert(key, generation),
                None => live.remove(&key),
            };
        }
    }

    impl LiveGenerations for FakeLive {
        fn live_generation<'a>(
            &'a self,
            thread_id: &'a str,
            terminal_id: &'a str,
        ) -> Pin<Box<dyn Future<Output = Option<TerminalGeneration>> + Send + 'a>> {
            let generation = self
                .live
                .lock()
                .unwrap()
                .get(&(thread_id.to_owned(), terminal_id.to_owned()))
                .cloned();
            Box::pin(async move { generation })
        }
    }

    fn generation(boot: &str, process: u64) -> TerminalGeneration {
        TerminalGeneration {
            boot: boot.to_owned(),
            process,
        }
    }

    fn credentials(shim_dir: PathBuf) -> (Arc<TerminalCredentials>, Arc<FakeLive>) {
        let credentials = Arc::new(TerminalCredentials::new("env-1".to_owned(), shim_dir));
        let live = Arc::new(FakeLive::default());
        credentials.bind(ENDPOINT.to_owned(), live.clone());
        (credentials, live)
    }

    async fn launch(
        credentials: &TerminalCredentials,
        live: &FakeLive,
        terminal_id: &str,
        generation: &TerminalGeneration,
        ai_terminal: bool,
    ) -> BTreeMap<String, String> {
        let mut env = BTreeMap::from([("PATH".to_owned(), "/client/bin".to_owned())]);
        credentials
            .issue(
                &TerminalSessionLaunch {
                    thread_id: "thread-a",
                    terminal_id,
                    generation,
                    ai_terminal,
                },
                &mut env,
            )
            .await;
        live.set("thread-a", terminal_id, Some(generation.clone()));
        env
    }

    #[tokio::test]
    async fn an_ai_terminal_launch_gets_a_credential_bound_to_its_generation() {
        let shim = tempfile::tempdir().unwrap();
        let (credentials, live) = credentials(shim.path().to_path_buf());
        let env = launch(
            &credentials,
            &live,
            "term-1",
            &generation("boot-1", 1),
            true,
        )
        .await;

        let token = env.get(AUTH_ENV).expect("env contains BIBCODE_AGENT_AUTH");
        assert!(!token.is_empty());
        assert_eq!(env[ENDPOINT_ENV], ENDPOINT);
        assert_eq!(
            env["PATH"],
            format!("{}{PATH_SEPARATOR}/client/bin", shim.path().display())
        );
        let identity = credentials
            .verify(token)
            .await
            .expect("verify returned None, expected Some(terminal:thread-a/term-1)");
        assert_eq!(identity.address(), "terminal:thread-a/term-1");
        assert_eq!(identity.generation_key(), "boot-1:1");
        assert_eq!(identity.environment_id, "env-1");
    }

    #[tokio::test]
    async fn a_plain_terminal_gets_no_credential_and_loses_a_supplied_one() {
        let (credentials, _live) = credentials(PathBuf::from("/state/runtime/agent"));
        let mut env = BTreeMap::from([
            (AUTH_ENV.to_owned(), "supplied".to_owned()),
            (ENDPOINT_ENV.to_owned(), "http://example.test/".to_owned()),
            ("PATH".to_owned(), "/client/bin".to_owned()),
        ]);
        credentials
            .issue(
                &TerminalSessionLaunch {
                    thread_id: "thread-a",
                    terminal_id: "term-1",
                    generation: &generation("boot-1", 1),
                    ai_terminal: false,
                },
                &mut env,
            )
            .await;

        assert!(!env.contains_key(AUTH_ENV), "a supplied credential remains");
        assert!(
            !env.contains_key(ENDPOINT_ENV),
            "a supplied endpoint remains"
        );
        assert_eq!(env["PATH"], "/client/bin");
        assert!(credentials.tokens.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_sibling_terminal_never_receives_another_credential() {
        let shim = tempfile::tempdir().unwrap();
        std::fs::write(shim.path().join("bibcode"), "#!/bin/sh\n").unwrap();
        let (credentials, live) = credentials(shim.path().to_path_buf());
        let first = launch(
            &credentials,
            &live,
            "term-c",
            &generation("boot-1", 1),
            true,
        )
        .await;
        let second = launch(
            &credentials,
            &live,
            "term-e",
            &generation("boot-1", 2),
            true,
        )
        .await;

        let token = &first[AUTH_ENV];
        assert_ne!(token, &second[AUTH_ENV]);
        for value in second.values() {
            assert!(
                !value.contains(token.as_str()),
                "term-e's env holds term-c's token"
            );
        }
        for entry in std::fs::read_dir(shim.path()).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            assert!(
                !bytes
                    .windows(token.len())
                    .any(|window| window == token.as_bytes()),
                "a shim file holds a token"
            );
        }
        let identity = credentials.verify(token).await.unwrap();
        assert_eq!(identity.address(), "terminal:thread-a/term-c");
        let sibling = credentials.verify(&second[AUTH_ENV]).await.unwrap();
        assert_eq!(sibling.address(), "terminal:thread-a/term-e");
    }

    #[tokio::test]
    async fn the_debug_output_redacts_the_token() {
        let (credentials, live) = credentials(PathBuf::from("/state/runtime/agent"));
        let env = launch(
            &credentials,
            &live,
            "term-1",
            &generation("boot-1", 1),
            true,
        )
        .await;
        let token = env.get(AUTH_ENV).expect("a credential was issued");

        let debug = format!("{credentials:?}");
        assert!(!debug.contains(token.as_str()));
        assert!(debug.contains("[redacted]"));
    }

    #[tokio::test]
    async fn a_credential_is_refused_when_the_live_generation_differs() {
        let (credentials, live) = credentials(PathBuf::from("/state/runtime/agent"));
        let env = launch(
            &credentials,
            &live,
            "term-1",
            &generation("boot-1", 1),
            true,
        )
        .await;
        let sibling = launch(
            &credentials,
            &live,
            "term-2",
            &generation("boot-1", 5),
            true,
        )
        .await;
        let token = env.get(AUTH_ENV).expect("a credential was issued");

        for now in [
            Some(generation("boot-1", 2)),
            None,
            Some(generation("boot-2", 1)),
        ] {
            live.set("thread-a", "term-1", now.clone());
            assert_eq!(credentials.verify(token).await, None, "live {now:?}");
            assert!(credentials.verify(&sibling[AUTH_ENV]).await.is_some());
        }
    }

    #[tokio::test]
    async fn revoking_a_generation_leaves_a_later_one_of_the_same_terminal() {
        let (credentials, live) = credentials(PathBuf::from("/state/runtime/agent"));
        let old = launch(
            &credentials,
            &live,
            "term-1",
            &generation("boot-1", 1),
            true,
        )
        .await;
        let new = launch(
            &credentials,
            &live,
            "term-1",
            &generation("boot-1", 2),
            true,
        )
        .await;

        credentials.revoke_generation("boot-1:1").await;
        credentials.sweep("thread-a", "term-1").await;
        live.set("thread-a", "term-1", Some(generation("boot-1", 1)));
        assert_eq!(credentials.verify(&old[AUTH_ENV]).await, None, "revoked");
        live.set("thread-a", "term-1", Some(generation("boot-1", 2)));
        assert!(credentials.verify(&new[AUTH_ENV]).await.is_some());
    }

    #[test]
    fn parse_terminal_address_round_trips_and_refuses_a_thread_address() {
        let identity = TerminalIdentity {
            environment_id: "env-1".to_owned(),
            thread_id: "thread-a".to_owned(),
            terminal_id: "term-1".to_owned(),
            generation: generation("boot-1", 1),
        };
        assert_eq!(
            parse_terminal_address(&identity.address()),
            Some(("thread-a".to_owned(), "term-1".to_owned()))
        );
        for refused in [
            "thread:thread-a",
            "terminal:thread-a",
            "terminal:/term-1",
            "terminal:thread-a/",
            "terminal:thread-a/term-1/extra",
        ] {
            assert_eq!(parse_terminal_address(refused), None, "{refused}");
        }
    }
}
