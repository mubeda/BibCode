//! `bibcode diagnostics pair | remotes | forget | download --remote` (#202): this command pairs
//! with a remote BiBCode server as its own device and downloads that server's diagnostic bundle
//! itself, with no BiBCode app running here.
//!
//! The credential it keeps grants `diagnostics:read` and nothing else: the pairing reply names
//! the minted credential's scopes, and anything else is refused before it is saved (the remote
//! is then left with a pending credential that closing the channel revokes). One record per
//! remote lives in `<state dir>/diagnostics-remotes/<name>.bin`, written through the same
//! secret store (0600 files in a 0700 directory, ACL-locked on Windows) as the server's own
//! keys. The credential is never printed.
//!
//! A download checks what the app's download checks: the pinned host key (Noise NK), the
//! store and environment recorded at pairing against the announced manifest, every size bound
//! before decoding, and the archive's own manifest; the remote applies its own redaction, size
//! limit and crash-dump scope check, unchanged. See `docs/architecture/remote.md`.

use std::{
    fmt,
    io::{self, BufRead as _, Read as _, Write as _},
    path::Path,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{
    archive::{ArchiveReceiver, Outcome, printable},
    relay_cli::report,
};
use crate::{
    auth::{SCOPE_DIAGNOSTICS_READ, SecretStore, pairing_code::decode_pairing_code},
    rpc::e2ee_client::{
        E2eeAuth, E2eeClient, E2eeClientError, RpcCallError, ServerTrust, StreamWaits,
        handshake_deadline,
    },
};

/// Where the records live, under the state directory every `bibcode` command resolves.
pub const REMOTES_DIRECTORY: &str = "diagnostics-remotes";
const RECORD_VERSION: u32 = 1;
const MAX_NAME_LENGTH: usize = 63;
/// The longest offer read from standard input.
const MAX_OFFER_BYTES: u64 = 64 * 1024;
/// How long the remote may take to build its bundle before the first item.
const WAIT_FOR_START: Duration = Duration::from_secs(120);
/// How long each item after the first may take.
const WAIT_BETWEEN_ITEMS: Duration = Duration::from_secs(90);
const CONFIRM_WAIT: Duration = Duration::from_secs(30);
/// How long a paired credential lasts on the remote (`SESSION_TTL_MS`); it is not renewed.
const SESSION_DAYS: i64 = 30;
const DOWNLOAD_METHOD: &str = "server.downloadDiagnosticLogs";

/// One paired remote. `Debug` leaves the credential out.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredRemote {
    v: u32,
    name: String,
    endpoint: String,
    host_key: String,
    environment_id: String,
    storage_instance_id: String,
    /// The name the remote gave itself in its offer.
    remote_name: String,
    paired_at: String,
    /// Random per pairing attempt: a rollback removes only the record its own attempt wrote,
    /// never one a concurrent `forget` and re-pair put under the same name.
    pairing_id: String,
    credential: String,
}

impl fmt::Debug for StoredRemote {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoredRemote")
            .field("name", &self.name)
            .field("endpoint", &self.endpoint)
            .field("storage_instance_id", &self.storage_instance_id)
            .finish_non_exhaustive()
    }
}

impl StoredRemote {
    fn summary(&self) -> Value {
        json!({
            "name": self.name,
            "remoteName": self.remote_name,
            "endpoint": self.endpoint,
            "environmentId": self.environment_id,
            "storageInstanceId": self.storage_instance_id,
            "pairedAt": self.paired_at,
        })
    }
}

struct RemoteStore {
    store: SecretStore,
    root: std::path::PathBuf,
}

/// Exclusive use of one remote name: held by `pair` from its name check through writing,
/// confirming and any rollback, and by `forget`. It is an advisory OS lock on
/// `<name>.lock` in the store directory (`flock` on Unix, `LockFileEx` on Windows), which
/// the system releases when the holder exits, crashed or not, so a dead holder never
/// strands it. The lock file itself stays; it is not a record.
struct RemoteLock {
    file: std::fs::File,
}

impl Drop for RemoteLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// How long `pair` or `forget` waits for another command using the same name.
const LOCK_WAIT: Duration = Duration::from_secs(90);
const LOCK_RETRY: Duration = Duration::from_millis(50);

fn store_failed(error: impl fmt::Display) -> Outcome {
    Outcome::failed(
        "store-failed",
        format!("Could not use this computer's remote credentials: {error}"),
    )
}

impl RemoteStore {
    async fn open(state_dir: &Path) -> Result<Self, Outcome> {
        let root = state_dir.join(REMOTES_DIRECTORY);
        SecretStore::new(&root)
            .await
            .map(|store| Self { store, root })
            .map_err(store_failed)
    }

    /// Takes `name`'s lock, waiting up to `wait` for another command holding it.
    async fn lock(&self, name: &str, wait: Duration) -> Result<RemoteLock, Outcome> {
        let path = self.root.join(format!("{name}.lock"));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(store_failed)?;
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(RemoteLock { file }),
                Err(std::fs::TryLockError::WouldBlock)
                    if tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(LOCK_RETRY).await;
                }
                Err(std::fs::TryLockError::WouldBlock) => {
                    return Err(Outcome::failed(
                        "busy",
                        format!(
                            "Another `bibcode diagnostics` command is pairing or forgetting \
                             {name}. Try again when it has finished."
                        ),
                    ));
                }
                Err(std::fs::TryLockError::Error(error)) => return Err(store_failed(error)),
            }
        }
    }

    /// Names with a record file; a directory or anything else under a record's name is not
    /// a record.
    async fn names(&self) -> Result<Vec<String>, Outcome> {
        self.store.names().await.map_err(store_failed)
    }

    async fn read(&self, name: &str) -> Result<Option<StoredRemote>, Outcome> {
        let Some(bytes) = self.store.get(name).await.map_err(store_failed)? else {
            return Ok(None);
        };
        serde_json::from_slice::<StoredRemote>(&bytes)
            .ok()
            .filter(|remote| remote.v == RECORD_VERSION && remote.name == name)
            .map(Some)
            .ok_or_else(|| {
                Outcome::failed(
                    "store-failed",
                    format!(
                        "The record for {name} is not one this BiBCode understands. Run \
                         `bibcode diagnostics forget {name}` and pair again."
                    ),
                )
            })
    }

    /// Writes a new record. `Ok(Some(warning))`: the record was stored, but its temporary
    /// link was left behind, which the caller reports and otherwise ignores.
    async fn create(&self, remote: &StoredRemote) -> Result<Option<String>, String> {
        let bytes = serde_json::to_vec(remote).map_err(|error| error.to_string())?;
        match self.store.create(&remote.name, &bytes).await {
            Ok(()) => Ok(None),
            Err(error) if error.is_published() => Ok(Some(format!(
                "The credential for {} was saved, but a temporary file was left beside it: {error}",
                remote.name
            ))),
            Err(error) => Err(error.to_string()),
        }
    }

    /// Removes `remote`'s record if it is still the one this pairing attempt wrote. The
    /// caller holds the name's lock, so nothing replaces the record between the read and the
    /// removal, and nothing is ever moved aside.
    async fn remove_own(&self, _lock: &RemoteLock, remote: &StoredRemote) -> Result<bool, String> {
        let stored = self
            .store
            .get(&remote.name)
            .await
            .map_err(|error| error.to_string())?;
        let ours = stored.is_some_and(|bytes| {
            serde_json::from_slice::<StoredRemote>(&bytes)
                .is_ok_and(|stored| stored.pairing_id == remote.pairing_id)
        });
        if !ours {
            return Ok(false);
        }
        self.store
            .remove(&remote.name)
            .await
            .map_err(|error| error.to_string())
    }

    async fn remove(&self, name: &str) -> Result<bool, Outcome> {
        self.store.remove(name).await.map_err(store_failed)
    }
}

/// The name a remote is known by: lowercase letters, digits and `-`, starting with a letter
/// or digit, at most 63 characters.
fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LENGTH
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !name.starts_with('-')
}

fn invalid_name(name: &str) -> Outcome {
    Outcome::failed(
        "invalid",
        format!(
            "{} is not a remote name: use lowercase letters, digits and -, at most 63.",
            printable(name)
        ),
    )
}

/// A name from the remote's own name: `Mauro's MacBook` becomes `mauro-s-macbook`.
fn slug(text: &str) -> String {
    let mut slug = String::new();
    for character in text.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            slug.push(character);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= MAX_NAME_LENGTH {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "remote".to_owned()
    } else {
        slug.to_owned()
    }
}

/// The pairing code inside `text`: a `bibcode://pair?code=…` link, an http(s) `/pair?code=…`
/// link, or the code itself.
fn offer_code(text: &str) -> String {
    let text = text.trim();
    url::Url::parse(text)
        .ok()
        .filter(|url| matches!(url.scheme(), "bibcode" | "http" | "https"))
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "code")
                .map(|(_, value)| value.into_owned())
        })
        .unwrap_or_else(|| text.to_owned())
}

fn read_offer_from_stdin() -> Result<String, Outcome> {
    let mut line = String::new();
    io::stdin()
        .lock()
        .take(MAX_OFFER_BYTES)
        .read_line(&mut line)
        .map_err(|error| {
            Outcome::failed("invalid", format!("Could not read the offer: {error}"))
        })?;
    Ok(line)
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown".to_owned())
}

/// The outcome of a client error while connecting or authenticating, for `label`.
fn connection_outcome(error: &E2eeClientError, label: &str) -> Outcome {
    let label = printable(label);
    match error {
        E2eeClientError::Endpoint(message) => Outcome::failed("invalid", printable(message)),
        E2eeClientError::Unreachable(detail) => Outcome::unavailable(
            "unreachable",
            format!("Could not reach {label}: {}", printable(detail)),
        ),
        E2eeClientError::Timeout(_) => {
            Outcome::unavailable("unreachable", format!("{label} did not answer in time."))
        }
        E2eeClientError::Tls(detail) => Outcome::unavailable(
            "tls",
            format!(
                "Could not verify {label}'s TLS certificate: {}. Nothing was sent.",
                printable(detail)
            ),
        ),
        E2eeClientError::HostIdentityMismatch => Outcome::failed(
            "host-identity-mismatch",
            format!(
                "The server at {label}'s address is not the one paired with: it could not \
                 prove the pinned host key. Nothing was sent. If {label} was reinstalled or \
                 its data reset, pair again."
            ),
        ),
        E2eeClientError::Unauthorized => Outcome::Denied {
            reason: "unauthorized".to_owned(),
            message: format!("{label} refused the credential."),
        },
        E2eeClientError::Protocol(detail) => Outcome::failed(
            "protocol",
            format!(
                "{label} sent something this command does not understand ({}). Nothing was saved.",
                printable(detail)
            ),
        ),
        E2eeClientError::ConnectionLost(detail) => Outcome::failed(
            "connection-lost",
            format!(
                "The connection to {label} was lost: {}. Nothing was saved.",
                printable(detail)
            ),
        ),
    }
}

/// A paired remote, as `pair` reports it.
#[derive(Debug)]
pub(crate) struct Paired {
    remote: StoredRemote,
    /// Set when the confirmation's answer was lost and could not be settled.
    note: Option<String>,
}

/// Pairs with the remote named in `offer_text` and saves its diagnostics-only credential.
pub(crate) async fn pair(
    state_dir: &Path,
    offer_text: &str,
    name: Option<String>,
    trust: &ServerTrust,
) -> Result<Paired, Outcome> {
    let payload = decode_pairing_code(&offer_code(offer_text)).map_err(|error| {
        Outcome::failed(
            "invalid",
            format!("That is not a BiBCode pairing offer ({error})."),
        )
    })?;
    let host_key = URL_SAFE_NO_PAD
        .decode(payload.host_key.trim())
        .ok()
        .filter(|key| key.len() == 32)
        .ok_or_else(|| {
            Outcome::failed(
                "invalid",
                "The offer carries no host key, so the remote cannot be pinned. Create a new \
                 offer on the remote with `bibcode pairing offer --access diagnostics`.",
            )
        })?;
    let remote_name = payload.name.trim().to_owned();
    let name = name.unwrap_or_else(|| slug(&remote_name));
    if !is_valid_name(&name) {
        return Err(invalid_name(&name));
    }
    let store = RemoteStore::open(state_dir).await?;
    // Held until this attempt's record is confirmed or rolled back.
    let lock = store.lock(&name, LOCK_WAIT).await?;
    if store.names().await?.contains(&name) {
        return Err(Outcome::failed(
            "exists",
            format!(
                "A remote named {name} is already paired. Pass --name, or run `bibcode \
                 diagnostics forget {name}` first. The offer was not used."
            ),
        ));
    }

    let deadline = handshake_deadline();
    let mut client = E2eeClient::connect(&payload.endpoint, &host_key, trust, deadline)
        .await
        .map_err(|error| connection_outcome(&error, &remote_name))?;
    let reply = match client
        .authenticate(E2eeAuth::Pairing(&payload.token), deadline)
        .await
    {
        Ok(reply) => reply,
        Err(E2eeClientError::Unauthorized) => {
            return Err(Outcome::Denied {
                reason: "offer-refused".to_owned(),
                message: format!(
                    "{} refused the offer: it was used, cancelled, or is over five minutes \
                     old. Create a new one there.",
                    printable(&remote_name)
                ),
            });
        }
        Err(error) => return Err(connection_outcome(&error, &remote_name)),
    };
    let confirmation_required =
        reply.get("pairingConfirmationRequired") == Some(&Value::Bool(true));
    // An unconfirmed credential is revoked when this channel closes; a confirmed or legacy one
    // stays active on the remote, so the user is told to revoke it there.
    let left_on_remote = |message: String| {
        if confirmation_required {
            format!("{message} The remote revokes the unused credential.")
        } else {
            format!(
                "{message} Revoke the client named for this offer on {} (Share this host → \
                 Authorized clients).",
                printable(&remote_name)
            )
        }
    };

    let scopes = reply.get("scopes").and_then(Value::as_array).map(|scopes| {
        scopes
            .iter()
            .map(|scope| scope.as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>()
    });
    match scopes.as_deref() {
        Some([only]) if only == SCOPE_DIAGNOSTICS_READ => {}
        None => {
            client.close().await;
            return Err(Outcome::failed(
                "unsupported",
                left_on_remote(format!(
                    "{} runs a BiBCode server that does not say what an offer grants, so this \
                     command cannot tell the credential is diagnostics-only. Nothing was saved. \
                     Update that server, then create an offer with `bibcode pairing offer \
                     --access diagnostics`.",
                    printable(&remote_name)
                )),
            ));
        }
        Some(scopes) => {
            client.close().await;
            return Err(Outcome::failed(
                "not-diagnostics-only",
                left_on_remote(format!(
                    "The offer grants more than diagnostic logs ({}), so nothing was saved. On \
                     the remote, create one with `bibcode pairing offer --access diagnostics`.",
                    printable(&scopes.join(" "))
                )),
            ));
        }
    }
    let credential = reply
        .get("credential")
        .and_then(Value::as_str)
        .filter(|credential| !credential.trim().is_empty());
    let environment_id = reply
        .get("environmentId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty());
    let storage_instance_id = reply.get("storageInstanceId").and_then(Value::as_str);
    let (Some(credential), Some(environment_id)) = (credential, environment_id) else {
        client.close().await;
        return Err(Outcome::failed(
            "protocol",
            left_on_remote(
                "The remote's pairing reply carried no credential or environment.".to_owned(),
            ),
        ));
    };
    if storage_instance_id != Some(payload.storage_instance_id.as_str()) {
        client.close().await;
        return Err(Outcome::failed(
            "wrong-environment",
            left_on_remote(
                "The server that answered is not the store the offer names. Nothing was saved."
                    .to_owned(),
            ),
        ));
    }
    let remote = StoredRemote {
        v: RECORD_VERSION,
        name: name.clone(),
        endpoint: payload.endpoint.clone(),
        host_key: payload.host_key.trim().to_owned(),
        environment_id: environment_id.to_owned(),
        storage_instance_id: payload.storage_instance_id.clone(),
        remote_name: remote_name.clone(),
        paired_at: now_rfc3339(),
        pairing_id: uuid::Uuid::new_v4().to_string(),
        credential: credential.to_owned(),
    };
    // A record stored with a stray temporary file is still a stored record: confirm it.
    let stored_note = match store.create(&remote).await {
        Ok(note) => note,
        Err(error) => {
            client.close().await;
            return Err(Outcome::failed(
                "store-failed",
                left_on_remote(format!(
                    "Could not save the credential for {name}: {}. The offer is used up; create \
                     a new one.",
                    printable(&error)
                )),
            ));
        }
    };
    if !confirmation_required {
        client.close().await;
        return Ok(Paired {
            remote,
            note: stored_note,
        });
    }
    let confirmed = client
        .unary("auth.confirmPairing", json!({}), CONFIRM_WAIT)
        .await;
    match confirmed {
        Ok(_) => {
            client.close().await;
            Ok(Paired {
                remote,
                note: stored_note,
            })
        }
        // The server answered and refused: the credential never became active.
        Err(RpcCallError::Failed(_) | RpcCallError::Defect(_)) => {
            client.close().await;
            Err(roll_back(&store, &lock, &remote).await)
        }
        // The answer was lost: the confirmation may have committed. One reconnect settles it.
        Err(RpcCallError::Client(_) | RpcCallError::Ended | RpcCallError::Rejected(_)) => {
            drop(client);
            settle_unconfirmed(&store, &lock, remote, trust)
                .await
                .map(|paired| Paired {
                    note: paired.note.or(stored_note),
                    ..paired
                })
        }
    }
}

/// Removes the record this refused attempt wrote, and says what remains if that fails.
async fn roll_back(store: &RemoteStore, lock: &RemoteLock, remote: &StoredRemote) -> Outcome {
    match store.remove_own(lock, remote).await {
        Ok(_) => pairing_rejected(&remote.remote_name),
        Err(error) => Outcome::failed(
            "rollback-failed",
            format!(
                "{} did not accept the pairing, and its unusable credential could not be \
                 removed from this computer ({}). Remove it with `bibcode diagnostics forget {}`, \
                 then create a new offer there.",
                printable(&remote.remote_name),
                printable(&error),
                remote.name
            ),
        ),
    }
}

fn pairing_rejected(remote_name: &str) -> Outcome {
    Outcome::failed(
        "pairing-rejected",
        format!(
            "{} did not accept the pairing. Nothing was saved; create a new offer there.",
            printable(remote_name)
        ),
    )
}

/// After a lost confirmation answer: a credential that authenticates was confirmed; one the
/// remote refuses was not, and its record is deleted; anything else keeps the record.
async fn settle_unconfirmed(
    store: &RemoteStore,
    lock: &RemoteLock,
    remote: StoredRemote,
    trust: &ServerTrust,
) -> Result<Paired, Outcome> {
    match authenticated_client(&remote, trust).await {
        Ok(client) => {
            client.close().await;
            Ok(Paired { remote, note: None })
        }
        Err(E2eeClientError::Unauthorized) => Err(roll_back(store, lock, &remote).await),
        Err(_) => Ok(Paired {
            note: Some(format!(
                "The connection was lost while {} confirmed the pairing, so it may not have. \
                 The next download says which; if it is refused, forget {} and pair again.",
                printable(&remote.remote_name),
                remote.name
            )),
            remote,
        }),
    }
}

async fn authenticated_client(
    remote: &StoredRemote,
    trust: &ServerTrust,
) -> Result<E2eeClient, E2eeClientError> {
    let host_key = URL_SAFE_NO_PAD
        .decode(&remote.host_key)
        .map_err(|_| E2eeClientError::Endpoint("the stored host key is invalid".to_owned()))?;
    let deadline = handshake_deadline();
    let mut client = E2eeClient::connect(&remote.endpoint, &host_key, trust, deadline).await?;
    client
        .authenticate(E2eeAuth::Bearer(&remote.credential), deadline)
        .await?;
    Ok(client)
}

fn refused_credential(remote: &StoredRemote) -> Outcome {
    let paired_at = OffsetDateTime::parse(&remote.paired_at, &Rfc3339).ok();
    let expired_on = paired_at.map(|paired| paired + time::Duration::days(SESSION_DAYS));
    let label = printable(&remote.remote_name);
    let message = match expired_on {
        Some(expiry) if expiry <= OffsetDateTime::now_utc() => format!(
            "The credential for {label} expired: paired credentials last {SESSION_DAYS} days \
             (paired {}). Pair again with a new offer.",
            remote.paired_at
        ),
        _ => format!(
            "{label} refused the credential: it was revoked there, or expired ({SESSION_DAYS} \
             days from pairing on {}). Pair again with a new offer.",
            remote.paired_at
        ),
    };
    Outcome::Denied {
        reason: "unauthorized".to_owned(),
        message,
    }
}

fn typed_failure(error: &Value, remote: &StoredRemote) -> Outcome {
    let label = printable(&remote.remote_name);
    let text = |key: &str| printable(error.get(key).and_then(Value::as_str).unwrap_or_default());
    match error.get("_tag").and_then(Value::as_str) {
        Some("EnvironmentAuthorizationError")
            if text("requiredScope") == "orchestration:operate" =>
        {
            Outcome::Denied {
                reason: "crash-dumps-refused".to_owned(),
                message: format!(
                    "This diagnostics credential cannot read {label}'s crash dumps, which hold \
                     fragments of memory. Download without --include-crash-dumps."
                ),
            }
        }
        Some("EnvironmentAuthorizationError") => Outcome::Denied {
            reason: "not-permitted".to_owned(),
            message: format!("This credential cannot read {label}'s logs. Pair again."),
        },
        Some("DiagnosticLogsError") if text("reason") == "too-large" => Outcome::failed(
            "too-large",
            format!("{label}'s logs are over the 20 MiB download limit. Nothing was saved."),
        ),
        _ => Outcome::failed(
            "server-failed",
            format!("{label} could not prepare its logs: {}", text("message")),
        ),
    }
}

/// Downloads `name`'s bundle into `output` with its stored credential.
pub(crate) async fn download(
    state_dir: &Path,
    name: &str,
    include_crash_dumps: bool,
    output: &Path,
    trust: &ServerTrust,
) -> Outcome {
    if !is_valid_name(name) {
        return invalid_name(name);
    }
    let output = match std::fs::canonicalize(output) {
        Ok(output) if output.is_dir() => output,
        _ => {
            return Outcome::failed(
                "invalid",
                format!("{} is not a directory.", output.display()),
            );
        }
    };
    let store = match RemoteStore::open(state_dir).await {
        Ok(store) => store,
        Err(outcome) => return outcome,
    };
    let remote = match store.read(name).await {
        Ok(Some(remote)) => remote,
        Ok(None) => {
            return Outcome::unavailable(
                "not-paired",
                format!(
                    "No remote named {name} is paired here. `bibcode diagnostics remotes` lists \
                     them; `bibcode diagnostics pair` adds one."
                ),
            );
        }
        Err(outcome) => return outcome,
    };
    let mut client = match authenticated_client(&remote, trust).await {
        Ok(client) => client,
        Err(E2eeClientError::Unauthorized) => return refused_credential(&remote),
        Err(error) => return connection_outcome(&error, &remote.remote_name),
    };
    let mut receiving: Option<ArchiveReceiver> = None;
    let mut on_item = |item: &Value| -> Result<(), Outcome> {
        match item.get("_tag").and_then(Value::as_str) {
            Some("Started") if receiving.is_none() => {
                let receiver = ArchiveReceiver::start(
                    item.get("fileName")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    item.get("byteLength").and_then(Value::as_u64),
                    item.get("manifest").cloned(),
                )?;
                // The store and environment recorded at pairing, before any byte is kept.
                let names = |key: &str, expected: &str| {
                    receiver.manifest().get(key).and_then(Value::as_str) == Some(expected)
                };
                if !names("storageInstanceId", &remote.storage_instance_id)
                    || !names("environmentId", &remote.environment_id)
                {
                    return Err(Outcome::failed(
                        "wrong-environment",
                        format!(
                            "The logs that arrived are not from the {} store paired with. \
                             Nothing was saved. If it was reset, pair again.",
                            printable(&remote.remote_name)
                        ),
                    ));
                }
                receiving = Some(receiver);
                Ok(())
            }
            Some("Data") => receiving
                .as_mut()
                .ok_or_else(|| protocol_outcome(&remote))?
                .accept_encoded(item.get("data").and_then(Value::as_str).unwrap_or_default()),
            _ => Err(protocol_outcome(&remote)),
        }
    };
    let streamed = client
        .stream(
            DOWNLOAD_METHOD,
            json!({ "frontendLog": "", "includeCrashDumps": include_crash_dumps }),
            StreamWaits {
                first: WAIT_FOR_START,
                next: WAIT_BETWEEN_ITEMS,
            },
            &mut on_item,
        )
        .await;
    client.close().await;
    match streamed {
        Ok(()) => match receiving {
            Some(received) => received.finish(&output).unwrap_or_else(|outcome| outcome),
            None => protocol_outcome(&remote),
        },
        Err(RpcCallError::Rejected(outcome)) => outcome,
        Err(RpcCallError::Failed(error)) => typed_failure(&error, &remote),
        Err(RpcCallError::Defect(defect)) if defect.contains("Unknown request tag") => {
            Outcome::unavailable(
                "unsupported",
                format!(
                    "{} runs an older BiBCode server that cannot send its logs. Update it.",
                    printable(&remote.remote_name)
                ),
            )
        }
        Err(RpcCallError::Defect(defect)) => Outcome::failed(
            "protocol",
            format!(
                "{} ended the request: {}. Nothing was saved.",
                printable(&remote.remote_name),
                printable(&defect)
            ),
        ),
        Err(RpcCallError::Ended) => Outcome::failed(
            "server-failed",
            format!(
                "{} stopped sending its logs. Nothing was saved. Try again.",
                printable(&remote.remote_name)
            ),
        ),
        Err(RpcCallError::Client(E2eeClientError::Timeout(_))) => Outcome::failed(
            "stalled",
            format!(
                "{} stopped answering. Nothing was saved.",
                printable(&remote.remote_name)
            ),
        ),
        Err(RpcCallError::Client(error)) => connection_outcome(&error, &remote.remote_name),
    }
}

fn protocol_outcome(remote: &StoredRemote) -> Outcome {
    Outcome::failed(
        "protocol",
        format!(
            "{} sent a reply this command does not understand. Nothing was saved.",
            printable(&remote.remote_name)
        ),
    )
}

fn print_json(value: &Value) {
    println!("{value}");
    let _ = io::stdout().flush();
}

/// `bibcode diagnostics pair`.
pub(crate) async fn run_pair(
    state_dir: &Path,
    offer: Option<String>,
    name: Option<String>,
    json: bool,
) -> i32 {
    let offer = match offer.filter(|offer| offer != "-") {
        Some(offer) => offer,
        None => match read_offer_from_stdin() {
            Ok(offer) => offer,
            Err(outcome) => return report(&outcome, json),
        },
    };
    match pair(state_dir, &offer, name, &ServerTrust::Platform).await {
        Ok(paired) => {
            if json {
                let mut value = paired.remote.summary();
                value["status"] = json!("paired");
                if let Some(note) = &paired.note {
                    value["note"] = json!(note);
                }
                print_json(&value);
            } else {
                println!(
                    "Paired {} with {} (store {}) for its diagnostic logs only.",
                    paired.remote.name,
                    printable(&paired.remote.remote_name),
                    printable(&paired.remote.storage_instance_id)
                );
                println!(
                    "Download them with `bibcode diagnostics download --remote {}`.",
                    paired.remote.name
                );
                if let Some(note) = &paired.note {
                    eprintln!("bibcode: {note}");
                }
            }
            0
        }
        Err(outcome) => report(&outcome, json),
    }
}

/// `bibcode diagnostics remotes`.
pub(crate) async fn run_remotes(state_dir: &Path, json: bool) -> i32 {
    let listed = async {
        let store = RemoteStore::open(state_dir).await?;
        let mut remotes = Vec::new();
        for name in store.names().await? {
            if let Some(remote) = store.read(&name).await? {
                remotes.push(remote);
            }
        }
        Ok::<_, Outcome>(remotes)
    }
    .await;
    match listed {
        Ok(remotes) => {
            if json {
                print_json(&json!({
                    "status": "ok",
                    "remotes": remotes.iter().map(StoredRemote::summary).collect::<Vec<_>>(),
                }));
            } else if remotes.is_empty() {
                println!("No remotes are paired. `bibcode diagnostics pair` adds one.");
            } else {
                for remote in &remotes {
                    println!(
                        "{}  {}  {}  store {}  paired {}",
                        remote.name,
                        printable(&remote.remote_name),
                        printable(&remote.endpoint),
                        printable(&remote.storage_instance_id),
                        remote.paired_at
                    );
                }
            }
            0
        }
        Err(outcome) => report(&outcome, json),
    }
}

/// `bibcode diagnostics forget`.
pub(crate) async fn run_forget(state_dir: &Path, name: &str, json: bool) -> i32 {
    if !is_valid_name(name) {
        return report(&invalid_name(name), json);
    }
    let removed = async {
        let store = RemoteStore::open(state_dir).await?;
        let _lock = store.lock(name, LOCK_WAIT).await?;
        store.remove(name).await
    }
    .await;
    match removed {
        Ok(true) => {
            let message = format!(
                "Forgot {name}. The remote still lists this client until it is revoked there \
                 (Share this host → Authorized clients) or expires {SESSION_DAYS} days after \
                 pairing."
            );
            if json {
                print_json(&json!({ "status": "forgotten", "name": name, "message": message }));
            } else {
                println!("{message}");
            }
            0
        }
        Ok(false) => report(
            &Outcome::unavailable(
                "not-paired",
                format!("No remote named {name} is paired here."),
            ),
            json,
        ),
        Err(outcome) => report(&outcome, json),
    }
}

/// `bibcode diagnostics download --remote`.
pub(crate) async fn run_download(
    state_dir: &Path,
    name: &str,
    include_crash_dumps: bool,
    output: &Path,
    json: bool,
) -> i32 {
    let outcome = download(
        state_dir,
        name,
        include_crash_dumps,
        output,
        &ServerTrust::Platform,
    )
    .await;
    report(&outcome, json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_come_from_the_remote_and_stay_safe() {
        assert_eq!(slug("Mauro's MacBook Pro"), "mauro-s-macbook-pro");
        assert_eq!(slug("  ai-server  "), "ai-server");
        assert_eq!(slug("ééé"), "remote");
        assert_eq!(slug(&"x".repeat(200)).len(), MAX_NAME_LENGTH);
        for valid in ["omarchy", "a", "box-2"] {
            assert!(is_valid_name(valid), "{valid}");
        }
        for invalid in ["", "-x", "Box", "a/b", "a.b", &"x".repeat(64)] {
            assert!(!is_valid_name(invalid), "{invalid}");
        }
    }

    #[test]
    fn the_offer_code_is_found_in_each_form() {
        assert_eq!(offer_code(" bibcode://pair?code=abc \n"), "abc");
        assert_eq!(offer_code("https://box:3773/pair?code=abc"), "abc");
        assert_eq!(offer_code("abc"), "abc");
    }

    #[test]
    fn a_record_never_shows_its_credential() {
        let remote = StoredRemote {
            v: RECORD_VERSION,
            name: "box".to_owned(),
            endpoint: "http://10.0.0.5:3773".to_owned(),
            host_key: "key".to_owned(),
            environment_id: "local".to_owned(),
            storage_instance_id: "store".to_owned(),
            remote_name: "Box".to_owned(),
            paired_at: now_rfc3339(),
            pairing_id: "attempt".to_owned(),
            credential: "very-secret-credential".to_owned(),
        };
        assert!(!format!("{remote:?}").contains("very-secret-credential"));
        assert!(
            !remote
                .summary()
                .to_string()
                .contains("very-secret-credential")
        );
    }
}

#[cfg(test)]
#[path = "remote_cli_tests.rs"]
mod remote_tests;
