# Headless Pairing Offer CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless `bibcode` server can produce the `bibcode://pair?code=…` offer the desktop's Add Server dialog expects, from a `bibcode pairing offer` subcommand and once at `bibcode serve` startup, with the pairing surviving server restarts.

**Architecture:** The CLI mints the same grant shape the Share tab mints through `POST /api/auth/pairing-offer`, writing directly to `auth_pairing_links` under the shared store runtime lock (the pattern `bibcode pairing issue` already uses); the running server consumes grants from the database, so no control channel is needed. Endpoint/reach validation is extracted from the HTTP handler into one function both paths call. `serve` mints one extra share offer through the live `AuthService` when bound to a routable address and prints it in its single JSON startup line.

**Tech Stack:** Rust (clap, tokio, rusqlite via `persistence`, `snow` host identity, `serde_json`), Rust integration tests under `apps/server/tests`, React copy in `apps/web`.

**Spec:** `docs/plans/remote-servers/2026-09-03-headless-pairing-and-service-design.md` (decisions D1, D2, D4).

## Global Constraints

- The grant minted offline must have subject `one-time-token`, `STANDARD_SCOPES`, `reach: Some(..)`, `off_host: Some(reach == "another-device")`, TTL `PAIRING_TTL_MS`, and self-enforce `MAX_ACTIVE_PAIRINGS`. Never the administrative shape.
- The offline path never generates a host identity key; missing key or missing database fails with a message containing `start the server on this data root first`.
- The offline path never calls `inspect_store` or `prepare_store`; storage identity comes from the `environment-id` marker.
- `--json` output is exactly one JSON line on stdout; plain output is two lines; nothing is printed on stdout on failure; the pairing command never initializes logging.
- The startup line printed by `run_server` stays one JSON object; new fields are additive (`pairingCode`).
- The startup offer is never the startup token. It is minted with `issue_share_pairing(default_standard_scopes(), Some(label), "another-device".to_owned(), true)`.
- `apps/server/tests/cli_smoke.rs` help assertions (`--host --port --base-dir --bootstrap-fd --no-browser`) must keep passing.
- Every task ends with `cargo fmt --all --check`, the named focused tests, and `cargo clippy -p bibcode-server --all-targets -- -D warnings` before commit.
- Commit messages end with the session attribution lines already in use in this repo (see recent `git log`).

---

### Task 1: Bind errors name the address and the OS error

**Files:**
- Modify: `apps/server/src/lifecycle.rs:84-85` (the `Bind` variant) and `apps/server/src/lifecycle.rs:210-213` (its two construction sites)
- Test: `apps/server/src/lifecycle.rs` (existing `#[cfg(test)] mod tests` near the bottom of the file)

**Interfaces:**
- Produces: `ServerError::Bind { address: String, source: std::io::Error }` with Display `failed to bind the server listener on {address}: {source}`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `apps/server/src/lifecycle.rs`:

```rust
    #[tokio::test]
    async fn bind_failure_names_the_address_and_the_os_error() {
        let occupied = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("occupy a port");
        let port = occupied.local_addr().expect("occupied port").port();
        let temp = tempfile::tempdir().expect("temporary base directory");
        let error = ServerRuntime::start(
            ServerConfig::new(temp.path()).with_bind("127.0.0.1", port),
        )
        .await
        .expect_err("binding an occupied port fails");
        let message = error.to_string();
        assert!(matches!(error, ServerError::Bind { .. }), "{message}");
        assert!(message.contains(&format!("127.0.0.1:{port}")), "{message}");
        assert!(message.contains("failed to bind the server listener on"), "{message}");
        assert!(message.len() > "failed to bind the server listener on 127.0.0.1:65535: ".len(), "{message}");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bibcode-server --lib lifecycle::tests::bind_failure_names_the_address_and_the_os_error`
Expected: compile error, `ServerError::Bind` is a tuple variant.

- [ ] **Step 3: Change the variant and its construction sites**

In `apps/server/src/lifecycle.rs` replace lines 84-85:

```rust
    #[error("failed to bind the server listener on {address}: {source}")]
    Bind {
        address: String,
        #[source]
        source: std::io::Error,
    },
```

Replace lines 210-213:

```rust
        let bind_address = format!("{}:{}", config.host, config.port);
        let listener = TcpListener::bind((config.host.as_str(), config.port))
            .await
            .map_err(|source| ServerError::Bind {
                address: bind_address.clone(),
                source,
            })?;
        let local_addr = listener.local_addr().map_err(|source| ServerError::Bind {
            address: bind_address,
            source,
        })?;
```

Run `rg 'ServerError::Bind' apps/ --type rust` and update any other match arm (the research found only these two sites; `apps/desktop` has none).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p bibcode-server --lib lifecycle::tests::bind_failure_names_the_address_and_the_os_error`
Expected: PASS

- [ ] **Step 5: Verify and commit**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`

```bash
git add apps/server/src/lifecycle.rs
git commit -m "fix(server): name the address and OS error when the listener cannot bind"
```

---

### Task 2: Extract pairing-offer input validation shared by HTTP and CLI

**Files:**
- Create: `apps/server/src/auth/pairing_offer.rs`
- Modify: `apps/server/src/auth/mod.rs` (add `mod pairing_offer;` and re-exports)
- Modify: `apps/server/src/auth/http.rs:342-401` (replace inline validation)
- Test: `apps/server/src/auth/pairing_offer.rs` (unit tests), `apps/server/tests/auth_http.rs` (existing offer tests stay green)

**Interfaces:**
- Produces:
  ```rust
  pub(crate) struct ValidatedPairingOfferInput {
      pub(crate) name: String,       // trimmed, non-empty
      pub(crate) endpoint: String,   // trimmed, trailing '/' removed
      pub(crate) reach: String,      // one of PAIRING_REACH_VALUES
      pub(crate) off_host: bool,
      pub(crate) label: String,      // trimmed label, or name when absent/blank
  }
  pub(crate) enum PairingOfferInputError { Endpoint, Unconnectable, Reach }
  pub(crate) fn validate_pairing_offer_input(name: &str, endpoint: &str, reach: &str, label: Option<&str>) -> Result<ValidatedPairingOfferInput, PairingOfferInputError>
  ```
  `PairingOfferInputError` implements `Display` with the exact strings the handler returns today: `endpoint must be an http(s) URL`, `endpoint must be a connectable address (no wildcard host, no port 0)`, `reach does not match the offered endpoint`.

- [ ] **Step 1: Write the failing unit tests**

Create `apps/server/src/auth/pairing_offer.rs` with only the tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_an_off_host_endpoint_for_another_device() {
        let input = validate_pairing_offer_input(
            " ai-server ",
            "http://100.105.196.60:3773/",
            "another-device",
            None,
        )
        .expect("valid input");
        assert_eq!(input.name, "ai-server");
        assert_eq!(input.endpoint, "http://100.105.196.60:3773");
        assert_eq!(input.reach, "another-device");
        assert!(input.off_host);
        assert_eq!(input.label, "ai-server");
    }

    #[test]
    fn uses_a_trimmed_label_when_present() {
        let input = validate_pairing_offer_input(
            "ai-server",
            "http://100.105.196.60:3773",
            "another-device",
            Some("  laptop  "),
        )
        .expect("valid input");
        assert_eq!(input.label, "laptop");
    }

    #[test]
    fn rejects_loopback_for_another_device_and_off_host_for_this_computer() {
        let error = validate_pairing_offer_input("x", "http://127.0.0.1:3773", "another-device", None)
            .expect_err("loopback is not another device");
        assert_eq!(error.to_string(), "reach does not match the offered endpoint");
        let error = validate_pairing_offer_input("x", "http://10.0.0.5:3773", "this-computer", None)
            .expect_err("off-host is not this computer");
        assert_eq!(error.to_string(), "reach does not match the offered endpoint");
        let input = validate_pairing_offer_input("x", "http://127.0.0.1:3773", "this-computer", None)
            .expect("loopback this-computer is valid");
        assert!(!input.off_host);
        let input = validate_pairing_offer_input("x", "https://proxy.example.com", "custom", None)
            .expect("custom accepts any host");
        assert!(input.off_host);
    }

    #[test]
    fn rejects_bad_endpoints_and_names() {
        assert_eq!(
            validate_pairing_offer_input("x", "ftp://host:1", "custom", None)
                .expect_err("scheme")
                .to_string(),
            "endpoint must be an http(s) URL"
        );
        assert_eq!(
            validate_pairing_offer_input("x", "http://0.0.0.0:3773", "custom", None)
                .expect_err("wildcard")
                .to_string(),
            "endpoint must be a connectable address (no wildcard host, no port 0)"
        );
        assert_eq!(
            validate_pairing_offer_input("x", "http://10.0.0.5:0", "custom", None)
                .expect_err("port zero")
                .to_string(),
            "endpoint must be a connectable address (no wildcard host, no port 0)"
        );
        assert_eq!(
            validate_pairing_offer_input("   ", "http://10.0.0.5:3773", "custom", None)
                .expect_err("blank name")
                .to_string(),
            "reach does not match the offered endpoint"
        );
        assert_eq!(
            validate_pairing_offer_input("x", "http://10.0.0.5:3773", "everywhere", None)
                .expect_err("unknown reach")
                .to_string(),
            "reach does not match the offered endpoint"
        );
    }
}
```

Add `mod pairing_offer;` to `apps/server/src/auth/mod.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bibcode-server --lib auth::pairing_offer::tests`
Expected: compile error, `validate_pairing_offer_input` not found.

- [ ] **Step 3: Implement the validation above the tests**

Prepend to `apps/server/src/auth/pairing_offer.rs`:

```rust
//! Pairing-offer input rules shared by `POST /api/auth/pairing-offer` and the
//! `bibcode pairing offer` CLI, so the two paths cannot drift.

use thiserror::Error;

use super::service::{PAIRING_REACH_VALUES, is_loopback_host, is_unspecified_host};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedPairingOfferInput {
    pub(crate) name: String,
    pub(crate) endpoint: String,
    pub(crate) reach: String,
    pub(crate) off_host: bool,
    pub(crate) label: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub(crate) enum PairingOfferInputError {
    #[error("endpoint must be an http(s) URL")]
    Endpoint,
    #[error("endpoint must be a connectable address (no wildcard host, no port 0)")]
    Unconnectable,
    #[error("reach does not match the offered endpoint")]
    Reach,
}

pub(crate) fn validate_pairing_offer_input(
    name: &str,
    endpoint: &str,
    reach: &str,
    label: Option<&str>,
) -> Result<ValidatedPairingOfferInput, PairingOfferInputError> {
    let endpoint_raw = endpoint.trim();
    let parsed = match url::Url::parse(endpoint_raw) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url,
        _ => return Err(PairingOfferInputError::Endpoint),
    };
    let host = parsed.host_str().unwrap_or_default();
    if host.is_empty() || is_unspecified_host(host) || parsed.port() == Some(0) {
        return Err(PairingOfferInputError::Unconnectable);
    }
    let endpoint_is_loopback = is_loopback_host(host);
    if !PAIRING_REACH_VALUES.contains(&reach) {
        return Err(PairingOfferInputError::Reach);
    }
    let reach_ok = match reach {
        "this-computer" => endpoint_is_loopback,
        "another-device" => !endpoint_is_loopback,
        _ => true,
    };
    let name = name.trim();
    if !reach_ok || name.is_empty() {
        return Err(PairingOfferInputError::Reach);
    }
    let off_host = match reach {
        "another-device" => true,
        "this-computer" => false,
        _ => !endpoint_is_loopback,
    };
    let label = label
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or(name)
        .to_owned();
    Ok(ValidatedPairingOfferInput {
        name: name.to_owned(),
        endpoint: endpoint_raw.trim_end_matches('/').to_owned(),
        reach: reach.to_owned(),
        off_host,
        label,
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bibcode-server --lib auth::pairing_offer::tests`
Expected: 4 passed.

- [ ] **Step 5: Wire the HTTP handler to the shared function**

In `apps/server/src/auth/http.rs`, add to the `use super::{ ... }` block:

```rust
    pairing_offer::validate_pairing_offer_input,
```

and make `pairing_offer` reachable: in `apps/server/src/auth/mod.rs` keep `mod pairing_offer;` private (siblings can use `super::pairing_offer`). Replace lines 342-401 of the handler (from `let endpoint_raw = payload.endpoint.trim();` through the `off_host` computation) with:

```rust
    let validated = match validate_pairing_offer_input(
        &payload.name,
        &payload.endpoint,
        &payload.reach,
        payload.label.as_deref(),
    ) {
        Ok(validated) => validated,
        Err(error) => return invalid_pairing_offer_response(&error.to_string()),
    };
    let name = validated.name.clone();
    let label = validated.label.clone();
    let off_host = validated.off_host;
```

Then in the remaining handler body replace `endpoint_raw.trim_end_matches('/').to_owned()` with `validated.endpoint.clone()` and keep every other use of `name`, `label`, `off_host`, and `payload.reach` unchanged. Keep the `scopes` validation block (lines 367-382) exactly where it is; it is HTTP-only because it compares against the caller's grant. Remove the now-unused imports `PAIRING_REACH_VALUES`, `is_loopback_host`, `is_unspecified_host` from `http.rs` if clippy reports them unused.

- [ ] **Step 6: Run the HTTP offer tests**

Run: `cargo test -p bibcode-server --test auth_http pairing_offer`
Expected: all previously passing pairing-offer tests pass (validation messages are byte-identical).

- [ ] **Step 7: Verify and commit**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`

```bash
git add apps/server/src/auth/pairing_offer.rs apps/server/src/auth/mod.rs apps/server/src/auth/http.rs
git commit -m "refactor(auth): share pairing-offer input validation between HTTP and CLI"
```

---

### Task 3: Offline share-offer minting against a data root

**Files:**
- Modify: `apps/server/src/auth/service.rs` (new `issue_offline_share_pairing` beside `issue_administrative_pairing_link` at ~line 2655)
- Modify: `apps/server/src/persistence/store.rs` (crate-visible wrapper over `read_marker`) and `apps/server/src/persistence/mod.rs` (re-export)
- Modify: `apps/server/src/auth/host_identity.rs` (make `from_record` `pub(crate)`)
- Modify: `apps/server/src/auth/mod.rs` (re-exports)
- Modify: `apps/server/src/auth/pairing_offer.rs` (add `mint_offline_pairing_offer`)
- Test: `apps/server/src/auth/pairing_offer.rs` (unit test using a real temp data root)

**Interfaces:**
- Consumes: `ValidatedPairingOfferInput` from Task 2; `Repositories::create_auth_pairing_link`, `list_active_auth_pairing_links`; `SecretStore::get`; `encode_pairing_code`, `pairing_deep_link`.
- Produces:
  ```rust
  // service.rs
  pub(crate) async fn issue_offline_share_pairing(repositories: &Repositories, label: Option<String>, reach: String, off_host: bool) -> Result<PairingCredentialResult, AuthError>
  // persistence
  pub fn read_storage_instance_id(paths: &StatePaths) -> Result<StorageInstanceId, StoreStartupError>
  // pairing_offer.rs
  pub(crate) struct OfflinePairingOffer { pub(crate) id: String, pub(crate) code: String, pub(crate) link: String, pub(crate) reach: String, pub(crate) endpoint: String, pub(crate) name: String, pub(crate) expires_at: String }
  pub(crate) enum OfflinePairingOfferError { MissingHostIdentity, SecretStore(SecretStoreError), HostIdentity(HostIdentityError), Auth(AuthError), Encode(PairingCodeError) }
  pub(crate) async fn mint_offline_pairing_offer(repositories: &Repositories, secret_store: &SecretStore, storage_instance_id: StorageInstanceId, input: ValidatedPairingOfferInput) -> Result<OfflinePairingOffer, OfflinePairingOfferError>
  ```

- [ ] **Step 1: Write the failing test**

Append to the `tests` module of `apps/server/src/auth/pairing_offer.rs`:

```rust
    #[tokio::test]
    async fn mints_a_share_shaped_grant_against_a_prepared_root() {
        let temp = tempfile::tempdir().expect("temporary base directory");
        let config = crate::config::ServerConfig::new(temp.path());
        let prepared = crate::persistence::prepare_store(&config)
            .await
            .expect("prepare a fresh store");
        let repositories = crate::persistence::Repositories::new(prepared.database.clone());
        let secret_store = crate::auth::SecretStore::new(config.state_dir().join("secrets"))
            .await
            .expect("secret store");
        let missing = mint_offline_pairing_offer(
            &repositories,
            &secret_store,
            prepared.storage_instance_id,
            validate_pairing_offer_input("ai-server", "http://10.0.0.5:3773", "another-device", None)
                .expect("valid input"),
        )
        .await
        .expect_err("no host identity yet");
        assert!(matches!(missing, OfflinePairingOfferError::MissingHostIdentity));

        let identity = crate::auth::HostIdentity::load_or_generate(&secret_store)
            .await
            .expect("generate a host identity like the server does");
        let offer = mint_offline_pairing_offer(
            &repositories,
            &secret_store,
            prepared.storage_instance_id,
            validate_pairing_offer_input("ai-server", "http://10.0.0.5:3773", "another-device", Some("laptop"))
                .expect("valid input"),
        )
        .await
        .expect("mint offer");
        assert!(offer.link.starts_with("bibcode://pair?code="));
        let payload = crate::auth::pairing_code::decode_pairing_code(&offer.code).expect("decodes");
        assert_eq!(payload.endpoint, "http://10.0.0.5:3773");
        assert_eq!(payload.name, "ai-server");
        assert_eq!(payload.host_key, identity.public_key_base64url());
        assert_eq!(payload.storage_instance_id, prepared.storage_instance_id.to_string());
        assert_eq!(payload.reach, crate::auth::pairing_code::RemotePairingReach::AnotherDevice);

        let active = repositories
            .list_active_auth_pairing_links(crate::auth::service::format_iso(crate::auth::service::now_ms()))
            .await
            .expect("active links");
        let link = active.iter().find(|link| link.id == offer.id).expect("persisted grant");
        assert_eq!(link.subject, "one-time-token");
        assert_eq!(link.reach.as_deref(), Some("another-device"));
        assert_eq!(link.off_host, Some(true));
        assert_eq!(link.label.as_deref(), Some("laptop"));
        assert!(link.scopes.iter().any(|scope| scope == "orchestration:read"));
        assert!(!link.scopes.iter().any(|scope| scope == "access:write"));
        prepared.database.close().await;
    }
```

If `PersistedPairingLink` field names differ from `id`, `subject`, `reach`, `off_host`, `label`, `scopes` (check `apps/server/src/persistence/repositories.rs`, the struct returned by `list_active_auth_pairing_links`), use the actual names; the assertions are what matter.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p bibcode-server --lib auth::pairing_offer::tests::mints_a_share_shaped_grant_against_a_prepared_root`
Expected: compile error, `mint_offline_pairing_offer` not found.

- [ ] **Step 3: Add the persistence marker reader**

In `apps/server/src/persistence/store.rs`, directly below `fn read_marker`:

```rust
/// Reads the persisted storage identity of an existing store without preparing
/// or migrating it. Used by CLI commands that run beside a live server.
pub fn read_storage_instance_id(paths: &StatePaths) -> Result<StorageInstanceId, StoreStartupError> {
    read_marker(&paths.environment_id)
}
```

In `apps/server/src/persistence/mod.rs` extend the `store` re-export:

```rust
pub use store::{
    PreparedStore, StorageInstanceId, StoreClassification, StoreStartupError, prepare_store,
    read_storage_instance_id,
};
```

- [ ] **Step 4: Add the offline share-offer issuer in `service.rs`**

Directly below `issue_administrative_pairing_link` (around line 2699) add:

```rust
/// Issues a one-time share pairing grant directly against a data root's
/// repositories, without a full [`AuthService`]. Used by `bibcode pairing offer`
/// beside a running server: consumption reads `auth_pairing_links` from the
/// database, so the running server honors grants inserted here. Mirrors
/// `issue_share_pairing` (standard scopes, `one-time-token` subject, reach and
/// off-host recorded, five-minute TTL) rather than the administrative shape,
/// so the off-host confirmation guard and exposure accounting see it.
pub(crate) async fn issue_offline_share_pairing(
    repositories: &Repositories,
    label: Option<String>,
    reach: String,
    off_host: bool,
) -> Result<PairingCredentialResult, AuthError> {
    if !is_valid_pairing_reach(&reach) {
        return Err(AuthError::InvalidCredential);
    }
    let now = now_ms();
    let active = repositories
        .list_active_auth_pairing_links(format_iso(now))
        .await
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    if active.len() >= MAX_ACTIVE_PAIRINGS {
        return Err(AuthError::Internal(
            "active pairing capacity exceeded".to_owned(),
        ));
    }
    let record = PairingRecord {
        id: Uuid::new_v4().to_string(),
        credential: generate_pairing_credential()?,
        scopes: owned_scopes(STANDARD_SCOPES),
        subject: "one-time-token".to_owned(),
        label: label.clone(),
        proof_key_thumbprint: None,
        created_at_ms: now,
        expires_at_ms: now.saturating_add(PAIRING_TTL_MS),
        consumed_at_ms: None,
        revoked_at_ms: None,
        reach: Some(reach),
        off_host: Some(off_host),
    };
    repositories
        .create_auth_pairing_link(persisted_pairing_link(&record))
        .await
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    Ok(PairingCredentialResult {
        id: record.id,
        credential: record.credential,
        label,
        expires_at: format_iso(record.expires_at_ms),
    })
}
```

In `apps/server/src/auth/mod.rs` extend the `service` re-export and add the host identity re-exports:

```rust
pub(crate) use host_identity::{HOST_IDENTITY_SECRET_NAME, HostIdentity, HostIdentityError};
pub(crate) use secret_store::{SecretStore, SecretStoreError};
pub(crate) use service::{
    AuthError, AuthService, AuthenticatedConnectionGuard, SessionTransport,
    issue_administrative_pairing_link, issue_offline_share_pairing,
};
```

In `apps/server/src/auth/host_identity.rs` change `fn from_record(record: &[u8])` to `pub(crate) fn from_record(record: &[u8])`. If `SecretStoreError` is not already `pub` at the module level, keep its existing visibility and adjust the re-export accordingly.

- [ ] **Step 5: Add the orchestrating function in `pairing_offer.rs`**

Add below `validate_pairing_offer_input`:

```rust
use super::{
    HOST_IDENTITY_SECRET_NAME, HostIdentity, HostIdentityError, SecretStore, SecretStoreError,
    issue_offline_share_pairing,
    pairing_code::{
        PairingCodeError, REMOTE_PAIRING_CODE_VERSION, RemotePairingCodePayload,
        RemotePairingReach, encode_pairing_code, pairing_deep_link,
    },
    service::AuthError,
};
use crate::persistence::{Repositories, StorageInstanceId};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OfflinePairingOffer {
    pub(crate) id: String,
    pub(crate) code: String,
    pub(crate) link: String,
    pub(crate) reach: String,
    pub(crate) endpoint: String,
    pub(crate) name: String,
    pub(crate) expires_at: String,
}

#[derive(Debug, Error)]
pub(crate) enum OfflinePairingOfferError {
    #[error("no persisted host identity; start the server on this data root first")]
    MissingHostIdentity,
    #[error(transparent)]
    SecretStore(#[from] SecretStoreError),
    #[error(transparent)]
    HostIdentity(#[from] HostIdentityError),
    #[error("could not issue the pairing grant: {0:?}")]
    Auth(AuthError),
    #[error(transparent)]
    Encode(#[from] PairingCodeError),
}

/// Mints a share offer beside (or without) a running server. Reads the host
/// identity instead of generating it so the CLI can never create a key a live
/// server has not loaded.
pub(crate) async fn mint_offline_pairing_offer(
    repositories: &Repositories,
    secret_store: &SecretStore,
    storage_instance_id: StorageInstanceId,
    input: ValidatedPairingOfferInput,
) -> Result<OfflinePairingOffer, OfflinePairingOfferError> {
    let record = secret_store
        .get(HOST_IDENTITY_SECRET_NAME)
        .await?
        .ok_or(OfflinePairingOfferError::MissingHostIdentity)?;
    let host_identity = HostIdentity::from_record(&record)?;
    let issued = issue_offline_share_pairing(
        repositories,
        Some(input.label.clone()),
        input.reach.clone(),
        input.off_host,
    )
    .await
    .map_err(OfflinePairingOfferError::Auth)?;
    let payload = RemotePairingCodePayload {
        v: REMOTE_PAIRING_CODE_VERSION,
        endpoint: input.endpoint.clone(),
        name: input.name.clone(),
        token: issued.credential,
        host_key: host_identity.public_key_base64url(),
        reach: match input.reach.as_str() {
            "this-computer" => RemotePairingReach::ThisComputer,
            "another-device" => RemotePairingReach::AnotherDevice,
            _ => RemotePairingReach::Custom,
        },
        storage_instance_id: storage_instance_id.to_string(),
    };
    let code = encode_pairing_code(&payload)?;
    Ok(OfflinePairingOffer {
        id: issued.id,
        link: pairing_deep_link(&code),
        code,
        reach: input.reach,
        endpoint: input.endpoint,
        name: input.name,
        expires_at: issued.expires_at,
    })
}
```

If `SecretStore::get` returns a module-local `Result` alias whose error is not `SecretStoreError`, map it explicitly instead of `?`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test -p bibcode-server --lib auth::pairing_offer::tests`
Expected: 5 passed.

- [ ] **Step 7: Verify and commit**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`

```bash
git add apps/server/src/auth apps/server/src/persistence
git commit -m "feat(auth): mint share-shaped pairing offers against a data root offline"
```

---

### Task 4: `bibcode pairing offer` subcommand

**Files:**
- Modify: `apps/server/src/config.rs:375-400` (`PairingSubcommand`, `PairingCommand`), `apps/server/src/config.rs:541-556` (dispatch)
- Modify: `apps/server/src/lib.rs:201-256` (`run_pairing_command`)
- Test: `apps/server/src/config.rs` tests module (parse test), `apps/server/tests/cli_smoke.rs` (three process-level tests)
- Modify docs: `docs/user/remote-access.md`, `docs/architecture/remote.md`

**Interfaces:**
- Consumes: `validate_pairing_offer_input`, `mint_offline_pairing_offer`, `read_storage_instance_id` from Tasks 2-3.
- Produces: CLI `bibcode pairing offer --endpoint <URL> [--reach another-device|this-computer|custom] [--name <NAME>] [--label <LABEL>] [--json] [--base-dir <DIR>]`; JSON line `{"id","code","link","reach","endpoint","name","expiresAt"}`; plain output `Pairing link: <link>` and `Expires at: <iso>`.
- Produces: `PairingCommand::Offer { root: ResolvedDataRoot, endpoint: String, reach: String, name: Option<String>, label: Option<String>, json: bool }`.

- [ ] **Step 1: Write the failing parse test**

Add to the `tests` module in `apps/server/src/config.rs` (the module at lines 169-315):

```rust
    #[test]
    fn pairing_offer_resolves_the_data_root_and_defaults_reach_to_another_device() {
        let temp = tempfile::tempdir().expect("temporary base directory");
        let base_dir = temp.path().to_string_lossy().into_owned();

        let action = Cli::try_parse_from([
            "bibcode",
            "pairing",
            "offer",
            "--base-dir",
            base_dir.as_str(),
            "--endpoint",
            "http://100.105.196.60:3773",
            "--label",
            "laptop",
            "--json",
        ])
        .expect("parse pairing offer CLI")
        .into_action()
        .expect("build pairing action");
        let CliAction::Pairing(PairingCommand::Offer {
            root,
            endpoint,
            reach,
            name,
            label,
            json,
        }) = action
        else {
            panic!("pairing offer must produce an offer action");
        };
        assert_eq!(root.requested, PathBuf::from(base_dir.as_str()));
        assert_eq!(endpoint, "http://100.105.196.60:3773");
        assert_eq!(reach, "another-device");
        assert_eq!(name, None);
        assert_eq!(label.as_deref(), Some("laptop"));
        assert!(json);

        assert!(
            Cli::try_parse_from(["bibcode", "pairing", "offer", "--base-dir", base_dir.as_str()])
                .is_err(),
            "--endpoint is required"
        );
        assert!(
            Cli::try_parse_from([
                "bibcode", "pairing", "offer", "--endpoint", "http://10.0.0.5:3773",
                "--reach", "everywhere",
            ])
            .is_err(),
            "reach is an enumerated value"
        );
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bibcode-server --lib config::tests::pairing_offer_resolves_the_data_root_and_defaults_reach_to_another_device`
Expected: compile error, no `Offer` variant.

- [ ] **Step 3: Add the subcommand and action**

In `apps/server/src/config.rs` replace the `PairingSubcommand` enum (lines 375-384):

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum PairingReachArg {
    AnotherDevice,
    ThisComputer,
    Custom,
}

impl PairingReachArg {
    fn as_str(self) -> &'static str {
        match self {
            Self::AnotherDevice => "another-device",
            Self::ThisComputer => "this-computer",
            Self::Custom => "custom",
        }
    }
}

#[derive(Debug, Subcommand)]
enum PairingSubcommand {
    #[command(about = "Create a five-minute administrative pairing credential for this data root.")]
    Issue {
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Create a five-minute encrypted pairing offer (bibcode://pair?code=…) for another BiBCode client."
    )]
    Offer {
        /// The http(s) address the other device will connect to.
        #[arg(long)]
        endpoint: String,
        #[arg(long, value_enum, default_value_t = PairingReachArg::AnotherDevice)]
        reach: PairingReachArg,
        /// Display name shown on the other device; defaults to this machine's hostname.
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        json: bool,
    },
}
```

Replace `PairingCommand` (lines 393-400):

```rust
#[derive(Clone, Debug)]
pub enum PairingCommand {
    Issue {
        root: ResolvedDataRoot,
        label: Option<String>,
        json: bool,
    },
    Offer {
        root: ResolvedDataRoot,
        endpoint: String,
        reach: String,
        name: Option<String>,
        label: Option<String>,
        json: bool,
    },
}
```

Replace the dispatch arm (lines 541-556):

```rust
            Some(CliCommand::Pairing(pairing)) => {
                let home_dir = dirs::home_dir().ok_or(DataRootError::HomeDirectoryUnavailable)?;
                let request = select_data_root_request(
                    args.base_dir,
                    bibcode_env_var("BIBCODE_HOME"),
                    None,
                    home_dir,
                );
                let root = crate::data_root::resolve_data_root(request)?;
                return Ok(CliAction::Pairing(match pairing.command {
                    PairingSubcommand::Issue { label, json } => {
                        PairingCommand::Issue { root, label, json }
                    }
                    PairingSubcommand::Offer {
                        endpoint,
                        reach,
                        name,
                        label,
                        json,
                    } => PairingCommand::Offer {
                        root,
                        endpoint,
                        reach: reach.as_str().to_owned(),
                        name,
                        label,
                        json,
                    },
                }));
            }
```

- [ ] **Step 4: Run the parse test**

Run: `cargo test -p bibcode-server --lib config::tests::pairing_offer_resolves_the_data_root_and_defaults_reach_to_another_device`
Expected: PASS (the existing `pairing_issue_resolves_the_cli_data_root_and_is_not_a_server_command` also still passes).

- [ ] **Step 5: Write the failing process-level tests**

Append to `apps/server/tests/cli_smoke.rs`:

```rust
#[tokio::test]
async fn pairing_offer_prints_a_code_the_running_server_redeems() {
    let root = TempDir::new().expect("temporary storage root");
    let handle = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("start pairing storage owner");

    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["pairing", "offer", "--base-dir"])
        .arg(root.path())
        .args([
            "--endpoint",
            "http://192.168.1.20:3773",
            "--name",
            "ai-server",
            "--label",
            "laptop",
            "--json",
        ])
        .output()
        .expect("run pairing offer");
    assert!(
        output.status.success(),
        "pairing offer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("UTF-8 offer output");
    assert_eq!(stdout.trim().lines().count(), 1, "exactly one JSON line: {stdout}");
    let value: Value = serde_json::from_str(stdout.trim()).expect("offer JSON document");
    let code = value["code"].as_str().expect("code string");
    assert_eq!(value["link"], format!("bibcode://pair?code={code}"));
    assert_eq!(value["reach"], "another-device");
    assert_eq!(value["endpoint"], "http://192.168.1.20:3773");
    assert_eq!(value["name"], "ai-server");
    assert!(value["expiresAt"].as_str().is_some());
    let payload = bibcode_server::auth_pairing_code::decode_pairing_code(code)
        .expect("pairing code decodes");
    assert_eq!(payload.name, "ai-server");

    let links = reqwest::Client::new()
        .get(format!("http://{}/api/auth/pairing-links", handle.local_addr()))
        .bearer_auth(exchange_startup_admin(&handle).await)
        .send()
        .await
        .expect("pairing list request");
    assert_eq!(links.status(), reqwest::StatusCode::OK);
    let links: Value = links.json().await.expect("pairing list JSON");
    let listed = links
        .as_array()
        .expect("pairing list")
        .iter()
        .find(|link| link["id"] == value["id"])
        .expect("offline offer is visible to the running server");
    assert_eq!(listed["label"], "laptop");

    handle.shutdown();
    handle.join().await.expect("stop pairing storage owner");
}

#[test]
fn pairing_offer_fails_closed_without_a_data_store() {
    let root = TempDir::new().expect("temporary empty root");
    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["pairing", "offer", "--base-dir"])
        .arg(root.path())
        .args(["--endpoint", "http://192.168.1.20:3773", "--json"])
        .output()
        .expect("run pairing offer without a store");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("start the server on this data root first"), "{stderr}");
    assert!(output.stdout.is_empty(), "no code may be printed on failure");
}

#[tokio::test]
async fn pairing_offer_rejects_a_loopback_endpoint_for_another_device() {
    let root = TempDir::new().expect("temporary storage root");
    let handle = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("start pairing storage owner");
    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["pairing", "offer", "--base-dir"])
        .arg(root.path())
        .args(["--endpoint", "http://127.0.0.1:3773"])
        .output()
        .expect("run pairing offer with a loopback endpoint");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("reach does not match the offered endpoint"), "{stderr}");
    assert!(output.stdout.is_empty());
    handle.shutdown();
    handle.join().await.expect("stop pairing storage owner");
}
```

Add this helper next to the other helpers at the top of `cli_smoke.rs` (it exchanges the startup credential exactly like the existing `pairing_issue_prints_a_credential_the_running_server_exchanges` test does):

```rust
async fn exchange_startup_admin(handle: &bibcode_server::ServerHandle) -> String {
    let startup = handle.startup_access().expect("startup pairing");
    let exchange = reqwest::Client::new()
        .post(format!("http://{}/oauth/token", handle.local_addr()))
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"),
            ("subject_token", startup.credential.as_str()),
            ("subject_token_type", "urn:bibcode:params:oauth:token-type:environment-bootstrap"),
            ("requested_token_type", "urn:ietf:params:oauth:token-type:access_token"),
            ("client_label", "CLI offer smoke"),
            ("client_device_type", "desktop"),
        ])
        .send()
        .await
        .expect("startup token exchange");
    assert_eq!(exchange.status(), reqwest::StatusCode::OK);
    let token: Value = exchange.json().await.expect("token exchange JSON");
    token["access_token"].as_str().expect("access token").to_owned()
}
```

- [ ] **Step 6: Run the process tests to verify they fail**

Run: `cargo test -p bibcode-server --test cli_smoke pairing_offer`
Expected: the first and third fail because `run_cli` does not handle `PairingCommand::Offer` (compile error on the non-exhaustive match in `lib.rs`).

- [ ] **Step 7: Implement `run_pairing_command` for offers**

In `apps/server/src/lib.rs` replace `run_pairing_command` (lines 211-256) with:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingOfferOutput {
    id: String,
    code: String,
    link: String,
    reach: String,
    endpoint: String,
    name: String,
    expires_at: String,
}

/// Opens an existing data root beside a running server: shared runtime lock,
/// existing database only, never `prepare_store`.
async fn open_existing_data_root(
    root: &ResolvedDataRoot,
) -> Result<(persistence::StoreRuntimeGuard, persistence::StatePaths, persistence::Database), RunError> {
    let runtime_guard = persistence::StoreRuntimeGuard::acquire(&root.effective)
        .await
        .map_err(|error| RunError::PairingIssue(error.to_string()))?;
    let paths = persistence::StatePaths::from_config(&ServerConfig::new(&root.effective));
    if !paths.database.exists() {
        return Err(RunError::PairingIssue(format!(
            "no BiBCode data store at {}; start the server on this data root first",
            paths.database.display()
        )));
    }
    let database = persistence::Database::open_existing(&paths.database)
        .await
        .map_err(|error| RunError::PairingIssue(error.to_string()))?;
    Ok((runtime_guard, paths, database))
}

/// Issues pairing credentials against a data root.
///
/// Coexists with a running server on the same root: it takes the shared store
/// runtime lock (blocking only offline recovery) and writes through the WAL
/// database, and the server consumes pairing links from the database. Prints
/// exactly one JSON line to stdout in `--json` mode — the desktop SSH launcher
/// parses the last non-empty stdout line — and never initializes logging or
/// other stdout writers.
async fn run_pairing_command(command: PairingCommand) -> Result<(), RunError> {
    match command {
        PairingCommand::Issue { root, label, json } => {
            let (_runtime_guard, _paths, database) = open_existing_data_root(&root).await?;
            let repositories = persistence::Repositories::new(database.clone());
            let issued = auth::issue_administrative_pairing_link(&repositories, label)
                .await
                .map_err(|error| RunError::PairingIssue(format!("{error:?}")));
            database.close().await;
            let issued = issued?;
            let output = PairingIssueOutput {
                id: issued.id,
                credential: issued.credential,
                label: issued.label,
                expires_at: issued.expires_at,
            };
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&output).map_err(RunError::PairingOutput)?
                );
            } else {
                println!("Pairing credential: {}", output.credential);
                println!("Expires at: {}", output.expires_at);
            }
            Ok(())
        }
        PairingCommand::Offer {
            root,
            endpoint,
            reach,
            name,
            label,
            json,
        } => {
            let name = name.unwrap_or_else(default_pairing_offer_name);
            let input = auth::validate_pairing_offer_input(
                &name,
                &endpoint,
                &reach,
                label.as_deref(),
            )
            .map_err(|error| RunError::PairingIssue(error.to_string()))?;
            let (_runtime_guard, paths, database) = open_existing_data_root(&root).await?;
            let storage_instance_id = persistence::read_storage_instance_id(&paths)
                .map_err(|error| RunError::PairingIssue(error.to_string()))?;
            let secret_store = auth::SecretStore::new(paths.secrets_dir.clone())
                .await
                .map_err(|error| RunError::PairingIssue(error.to_string()))?;
            let repositories = persistence::Repositories::new(database.clone());
            let minted = auth::mint_offline_pairing_offer(
                &repositories,
                &secret_store,
                storage_instance_id,
                input,
            )
            .await
            .map_err(|error| RunError::PairingIssue(error.to_string()));
            database.close().await;
            let minted = minted?;
            let output = PairingOfferOutput {
                id: minted.id,
                code: minted.code,
                link: minted.link,
                reach: minted.reach,
                endpoint: minted.endpoint,
                name: minted.name,
                expires_at: minted.expires_at,
            };
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&output).map_err(RunError::PairingOutput)?
                );
            } else {
                println!("Pairing link: {}", output.link);
                println!("Expires at: {}", output.expires_at);
            }
            Ok(())
        }
    }
}

/// Display name embedded in offers when the caller gives none.
pub(crate) fn default_pairing_offer_name() -> String {
    sysinfo::System::host_name()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "BiBCode server".to_owned())
}
```

Add `pub(crate) use pairing_offer::{mint_offline_pairing_offer, validate_pairing_offer_input};` to `apps/server/src/auth/mod.rs`. `StatePaths` exposes `secrets_dir` (`apps/server/src/persistence/state_files.rs:78`); `ResolvedDataRoot` is already imported in `lib.rs` through `data_root::*`.

- [ ] **Step 8: Run the process tests to verify they pass**

Run: `cargo test -p bibcode-server --test cli_smoke pairing`
Expected: all `pairing_issue_*` and `pairing_offer_*` tests pass.

- [ ] **Step 9: Update the user and architecture docs for the subcommand**

In `docs/user/remote-access.md`:

Replace the sentence at line 82-84 ("The CLI does not print a QR code. It also has no `auth` or `project` subcommands, …") with:

```markdown
The CLI does not print a QR code and has no `project` subcommand. Pairing
credentials come from `bibcode pairing offer` (encrypted offers for the desktop
app) and `bibcode pairing issue` (the desktop SSH bootstrap). Use
`bibcode serve --help` for the implemented options.
```

Under `## Pairing`, replace the paragraph at lines 114-116 ("Create and revoke additional access from **Settings → Remote Servers**. There is no general CLI access-management surface; …") with:

```markdown
Create and revoke additional access from **Settings → Remote Servers**. On a
headless server, mint an encrypted offer for the desktop app from the CLI:

```sh
bibcode pairing offer --endpoint http://100.64.0.10:3773
```

It prints a `bibcode://pair?code=…` link that expires after five minutes. Paste
it into **Settings → Remote Servers → Connect → Add Server** on the other
device. `--reach this-computer` requires a loopback endpoint and is for tunnels;
`--name` sets the display name (default: this machine's hostname); `--json`
prints one JSON line. The command works while the server is running on the same
data root and refuses to run before the server has ever started there. Revoke
the resulting device from the Share tab like any other client. The focused
`bibcode pairing issue` command remains for desktop-managed SSH bootstrap.
```

In `docs/architecture/remote.md`, after the paragraph ending "…without a restart." (around line 682) add:

```markdown
`bibcode pairing offer` uses the same database-as-authority pattern for
encrypted offers: it writes a share-shaped grant (`one-time-token` subject,
standard scopes, reach and off-host recorded) into `auth_pairing_links`, reads
the persisted host identity key without generating one, reads the storage
identity marker, and encodes the same `RemotePairingCodePayload` the Share tab
mints. Endpoint and reach rules are shared with `POST /api/auth/pairing-offer`
through `auth::pairing_offer::validate_pairing_offer_input`. The command fails
closed when the data store or host key does not exist yet.
```

- [ ] **Step 10: Verify and commit**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings && cargo test -p bibcode-server --test cli_smoke && vp check`

```bash
git add apps/server/src/config.rs apps/server/src/lib.rs apps/server/src/auth/mod.rs apps/server/tests/cli_smoke.rs docs/user/remote-access.md docs/architecture/remote.md
git commit -m "feat(cli): add bibcode pairing offer for encrypted headless pairing"
```

---

### Task 5: Restart-survival integration test through the CLI offer

**Files:**
- Test: `apps/server/tests/e2ee_ws.rs` (new test next to `confirmed_pairing_session_survives_disconnect_and_restart_cleanup` at line 647)

**Interfaces:**
- Consumes: `pair_inside_channel`, `confirm_pairing`, `read_host_public_key`, `open_authenticated_bearer_socket`, `assert_get_config`, `start_server`, `TEST_PERMIT` (all existing in the file); the CLI from Task 4.

- [ ] **Step 1: Write the test**

```rust
#[tokio::test]
async fn cli_minted_offer_pairs_and_the_session_survives_a_restart() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["pairing", "offer", "--base-dir"])
        .arg(temp.path())
        .args(["--endpoint", "http://192.168.1.20:3773", "--json"])
        .output()
        .expect("run pairing offer");
    assert!(
        output.status.success(),
        "pairing offer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let offer: Value = serde_json::from_slice(&output.stdout).expect("offer JSON");
    let payload = bibcode_server::auth_pairing_code::decode_pairing_code(
        offer["code"].as_str().expect("code"),
    )
    .expect("pairing code decodes");
    assert_eq!(
        payload.host_key,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(read_host_public_key(temp.path()))
    );

    let (mut socket, mut transport, reply) =
        pair_inside_channel(&handle, temp.path(), &payload.token).await;
    assert_eq!(reply["pairingConfirmationRequired"], Value::Bool(true), "{reply}");
    let credential = reply["credential"].as_str().expect("minted credential").to_owned();
    confirm_pairing(&mut socket, &mut transport, "2").await;
    socket.close(None).await.expect("close confirmed socket");
    handle.shutdown();
    timeout(Duration::from_secs(2), handle.join())
        .await
        .expect("server shutdown timeout")
        .expect("server joins");

    let restarted = start_server(&temp).await;
    let host_key = read_host_public_key(temp.path());
    let (mut reconnect, mut reconnect_transport, reconnect_reply) =
        open_authenticated_bearer_socket(&restarted, &host_key, &credential).await;
    assert_eq!(reconnect_reply, json!({ "type": "e2ee_authenticated" }));
    assert_get_config(&mut reconnect, &mut reconnect_transport).await;
}
```

If `base64` is not already imported in the test file, add `use base64::Engine as _;` (the crate is a workspace dependency of `bibcode-server`; if it is not available to the test target, compare `payload.host_key` against the running server's descriptor instead, or drop that single assertion; the pairing itself proves the key matched).

- [ ] **Step 2: Run the test**

Run: `cargo test -p bibcode-server --test e2ee_ws cli_minted_offer_pairs_and_the_session_survives_a_restart`
Expected: PASS. `pairingConfirmationRequired` is `true` because the grant records `off_host: Some(true)`; that assertion is what proves the CLI minted the share shape, not the administrative shape.

- [ ] **Step 3: Commit**

```bash
git add apps/server/tests/e2ee_ws.rs
git commit -m "test(auth): CLI-minted offer pairs and survives a server restart"
```

---

### Task 6: `bibcode serve` prints a startup pairing offer for routable binds

**Files:**
- Modify: `apps/server/src/config.rs` (`ServerArgs` global flag, `ServerConfig` field, `into_action_with_optional_executable`)
- Modify: `apps/server/src/lifecycle.rs:67-72` (`StartupAccess`), `:238-247` (startup minting), `:554-582` (`build_startup_access`)
- Modify: `apps/server/src/lib.rs:116-126` (`run_server` output)
- Test: `apps/server/src/lifecycle.rs` tests module; `apps/server/tests/cli_smoke.rs`
- Modify docs: `docs/user/remote-access.md` (headless JSON example), `docs/user/server-installation.md`

**Interfaces:**
- Produces: `ServerConfig.startup_pairing_offer: bool` (default `true`); CLI flag `--no-startup-pairing-offer` (env `BIBCODE_NO_STARTUP_PAIRING_OFFER`, global); `StartupAccess.pairing_link: Option<String>`; startup JSON field `pairingCode` holding the full `bibcode://pair?code=…` link.
- Produces: `pub(crate) fn startup_offer_endpoint(local_addr: SocketAddr) -> Option<String>` in `lifecycle.rs`.

- [ ] **Step 1: Write the failing unit tests**

Add to the `tests` module in `apps/server/src/lifecycle.rs`:

```rust
    #[test]
    fn startup_offer_endpoint_requires_a_routable_bind() {
        use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
        assert_eq!(
            startup_offer_endpoint(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773)),
            None
        );
        assert_eq!(
            startup_offer_endpoint(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 3773)),
            None
        );
        assert_eq!(
            startup_offer_endpoint(SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 3773)),
            None
        );
        assert_eq!(
            startup_offer_endpoint(SocketAddr::new(IpAddr::V4(Ipv4Addr::new(100, 105, 196, 60)), 3773)),
            Some("http://100.105.196.60:3773".to_owned())
        );
        assert_eq!(
            startup_offer_endpoint(SocketAddr::new(
                IpAddr::V6(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 5)),
                3773
            )),
            Some("http://[fd00::5]:3773".to_owned())
        );
    }

    #[tokio::test]
    async fn loopback_serve_has_no_startup_pairing_link() {
        let temp = tempfile::tempdir().expect("temporary base directory");
        let handle = ServerRuntime::start(ServerConfig::new(temp.path()).with_bind("127.0.0.1", 0))
            .await
            .expect("server starts");
        let access = handle.startup_access().expect("web mode startup access");
        assert_eq!(access.pairing_link, None);
        handle.shutdown();
        handle.join().await.expect("server joins");
    }

    /// Uses the host's outbound interface address (no packets are sent by a
    /// connected UDP socket). Skips on hosts with no routable address.
    #[tokio::test]
    async fn routable_serve_prints_a_share_shaped_startup_offer() {
        let probe = std::net::UdpSocket::bind("0.0.0.0:0").expect("udp probe");
        let Ok(()) = probe.connect("192.0.2.1:9") else {
            return;
        };
        let ip = probe.local_addr().expect("probe address").ip();
        if ip.is_loopback() || ip.is_unspecified() {
            return;
        }
        let temp = tempfile::tempdir().expect("temporary base directory");
        let handle = ServerRuntime::start(
            ServerConfig::new(temp.path()).with_bind(ip.to_string(), 0),
        )
        .await
        .expect("server starts on the routable address");
        let access = handle.startup_access().expect("web mode startup access");
        let link = access.pairing_link.as_deref().expect("routable bind mints a startup offer");
        let code = link.strip_prefix("bibcode://pair?code=").expect("deep link shape");
        let payload = crate::auth::pairing_code::decode_pairing_code(code).expect("decodes");
        assert_eq!(payload.endpoint, format!("http://{}", handle.local_addr()));
        assert_eq!(payload.reach, crate::auth::pairing_code::RemotePairingReach::AnotherDevice);
        assert_ne!(payload.token, access.credential, "the startup token is never embedded");

        let disabled = {
            let mut config = ServerConfig::new(tempfile::tempdir().expect("second root").path())
                .with_bind(ip.to_string(), 0);
            config.startup_pairing_offer = false;
            ServerRuntime::start(config).await.expect("server starts without an offer")
        };
        assert_eq!(disabled.startup_access().expect("access").pairing_link, None);
        disabled.shutdown();
        disabled.join().await.expect("second server joins");
        handle.shutdown();
        handle.join().await.expect("server joins");
    }
```

The second temp dir in `disabled` must outlive the server: bind it to a named variable (`let second = tempfile::tempdir()…; ServerConfig::new(second.path())`) when writing the real test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bibcode-server --lib lifecycle::tests::startup_offer_endpoint_requires_a_routable_bind`
Expected: compile error, `startup_offer_endpoint` not found.

- [ ] **Step 3: Add the config flag**

In `apps/server/src/config.rs` `ServerArgs` (after `no_browser`):

```rust
    /// Do not mint the five-minute pairing offer printed as `pairingCode` at startup.
    #[arg(long, env = "BIBCODE_NO_STARTUP_PAIRING_OFFER", global = true)]
    no_startup_pairing_offer: bool,
```

In `ServerConfig` add `pub startup_pairing_offer: bool,` after `no_browser`, initialize it to `true` in `ServerConfig::new`, and in `into_action_with_optional_executable` after the `config.no_browser = …;` statement add:

```rust
        config.startup_pairing_offer = !args.no_startup_pairing_offer;
```

Search `apps/` for other `ServerConfig {` struct literals (`rg 'ServerConfig \{' apps --type rust`) and add the field where a literal is constructed rather than `ServerConfig::new`.

- [ ] **Step 4: Widen `StartupAccess` and mint the offer in `start_internal`**

In `apps/server/src/lifecycle.rs` change `StartupAccess`:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartupAccess {
    pub connection_string: String,
    pub credential: String,
    pub pairing_url: String,
    /// Full `bibcode://pair?code=…` link for the desktop Add Server dialog,
    /// present only when the bind address is routable from other devices.
    pub pairing_link: Option<String>,
}
```

Add `pairing_link: None,` to the `StartupAccess { … }` literal at the end of `build_startup_access`, and fix any other literal (`rg 'StartupAccess \{' apps --type rust`; the lifecycle tests around line 688 construct expectations).

Add this free function near `build_startup_access`:

```rust
/// Endpoint other devices can reach, derived from the bound socket address.
/// Loopback and unspecified binds have no usable advertised endpoint.
pub(crate) fn startup_offer_endpoint(local_addr: SocketAddr) -> Option<String> {
    let ip = local_addr.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    Some(format!("http://{local_addr}"))
}
```

(`SocketAddr` Display already brackets IPv6 addresses.)

Replace the startup block at lines 238-247 with:

```rust
        let startup_access =
            if config.mode == crate::config::ServerMode::Web && !config.unsafe_no_auth {
                let issued = auth
                    .issue_startup_pairing()
                    .await
                    .map_err(|error| ServerError::AuthInitialize(format!("{error:?}")))?;
                let mut access = build_startup_access(local_addr, issued.credential)?;
                if config.startup_pairing_offer
                    && let Some(endpoint) = startup_offer_endpoint(local_addr)
                {
                    access.pairing_link =
                        Some(mint_startup_pairing_link(&auth, storage_instance_id, endpoint).await?);
                }
                Some(access)
            } else {
                None
            };
```

and add the helper:

```rust
/// Mints one share-shaped off-host offer through the live auth service. This
/// is a second grant beside the startup token: the startup token is an
/// administrative bootstrap without reach and must never be embedded in a code.
async fn mint_startup_pairing_link(
    auth: &AuthService,
    storage_instance_id: StorageInstanceId,
    endpoint: String,
) -> Result<String, ServerError> {
    let name = crate::default_pairing_offer_name();
    let issued = auth
        .issue_share_pairing(
            crate::auth::default_standard_scopes(),
            Some(name.clone()),
            "another-device".to_owned(),
            true,
        )
        .await
        .map_err(|error| ServerError::AuthInitialize(format!("{error:?}")))?;
    let payload = RemotePairingCodePayload {
        v: REMOTE_PAIRING_CODE_VERSION,
        endpoint,
        name,
        token: issued.credential,
        host_key: auth.host_identity().public_key_base64url(),
        reach: RemotePairingReach::AnotherDevice,
        storage_instance_id: storage_instance_id.to_string(),
    };
    let code = encode_pairing_code(&payload)
        .map_err(|error| ServerError::AuthInitialize(error.to_string()))?;
    Ok(pairing_deep_link(&code))
}
```

Imports needed in `lifecycle.rs`: `crate::auth::pairing_code::{REMOTE_PAIRING_CODE_VERSION, RemotePairingCodePayload, RemotePairingReach, encode_pairing_code, pairing_deep_link}` and `crate::persistence::StorageInstanceId`. Add `pub(crate) use service::default_standard_scopes;` to `apps/server/src/auth/mod.rs`. `storage_instance_id` is already bound at line 207 of `start_internal`.

- [ ] **Step 5: Print the field in `run_server`**

In `apps/server/src/lib.rs` inside the `if let Some(access) = handle.startup_access() …` block add after the `pairingUrl` insert:

```rust
        if let Some(link) = &access.pairing_link {
            output.insert("pairingCode".to_owned(), json!(link));
        }
```

- [ ] **Step 6: Run the lifecycle tests**

Run: `cargo test -p bibcode-server --lib lifecycle::tests`
Expected: all pass (the routable test may skip silently on hosts without a routable address; on this machine it runs).

- [ ] **Step 7: Add the process-level assertion**

Append to `apps/server/tests/cli_smoke.rs` a test that starts the binary with `serve --host 127.0.0.1 --port 0 --base-dir <tmp>`, reads the first stdout line, parses it as JSON, and asserts `ready.get("pairingCode").is_none()` and `ready["pairingUrl"].as_str().is_some()`, then kills the child. Model the spawn and readiness read on the existing test at `cli_smoke.rs:480-530` (tokio `Command`, `BufReader::lines`, 30-second timeout, `child.kill()` on timeout). Name it `serve_on_loopback_prints_no_startup_pairing_code`.

Run: `cargo test -p bibcode-server --test cli_smoke serve_on_loopback_prints_no_startup_pairing_code`
Expected: PASS.

- [ ] **Step 8: Update the docs**

In `docs/user/remote-access.md`, replace the JSON example under "## Headless server" (lines 71-79) with:

```json
{
  "address": "100.64.0.10:3773",
  "httpBaseUrl": "http://100.64.0.10:3773",
  "token": "one-time-pairing-credential",
  "pairingUrl": "http://100.64.0.10:3773/pair#token=one-time-pairing-credential",
  "pairingCode": "bibcode://pair?code=…"
}
```

and add after it:

```markdown
`pairingCode` is a five-minute encrypted offer for the desktop app's
**Add Server** dialog; it is present only when the bound address is routable
(not loopback, not `0.0.0.0`). Pass `--no-startup-pairing-offer` (or set
`BIBCODE_NO_STARTUP_PAIRING_OFFER=1`) when stdout goes to a log, and mint
offers on demand with `bibcode pairing offer` instead. `pairingUrl` remains the
one-time owner bootstrap for a browser.
```

In `docs/user/server-installation.md`, after the `./bibcode serve --host 127.0.0.1` example add:

```markdown
To let another device pair, bind a private address other devices can reach and
paste the printed `pairingCode` into the desktop app, or mint one later:

```sh
./bibcode serve --host 100.64.0.10
./bibcode pairing offer --endpoint http://100.64.0.10:3773
```
```

- [ ] **Step 9: Verify and commit**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings && cargo test -p bibcode-server --lib lifecycle && cargo test -p bibcode-server --test cli_smoke && vp check`

```bash
git add apps/server/src/config.rs apps/server/src/lifecycle.rs apps/server/src/lib.rs apps/server/src/auth/mod.rs apps/server/tests/cli_smoke.rs docs/user/remote-access.md docs/user/server-installation.md
git commit -m "feat(server): print a startup pairing offer for routable headless binds"
```

---

### Task 7: Add Server dialog copy names the CLI source

**Files:**
- Modify: `apps/web/src/components/settings/remote-servers/ConnectTab.tsx:1373` and `:1543`
- Test: `apps/web/src/components/settings/remote-servers/ConnectTab.test.tsx` (existing suite stays green)

- [ ] **Step 1: Change the two strings**

Line 1543 (the Pairing code mode card description):

```tsx
                        description: "Paste a pairing code from the server's Share tab or from `bibcode pairing offer`.",
```

Line 1373 (Troubleshooting "Still stuck?" item), replace `then generate a fresh pairing code on the server's Share tab.` with:

```tsx
                then generate a fresh pairing code on the server&apos;s Share tab or with{" "}
                <code>bibcode pairing offer</code> on the server.
```

- [ ] **Step 2: Run the tests and reviews**

Run: `vp test apps/web/src/components/settings/remote-servers/ConnectTab.test.tsx && vp check && vp run typecheck`
Expected: PASS. Review the two strings against `UI.md` "Text and Copy" (say what to do next, no jargon beyond the command name a technical user needs) and confirm no hook or render path changed (`vercel-react-best-practices` review: copy-only).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/remote-servers/ConnectTab.tsx
git commit -m "docs(web): point the Add Server dialog at bibcode pairing offer"
```

---

### Task 8: Runbooks and final gates

**Files:**
- Modify: `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md` (the "Remote server updates" bullet each has at lines 201, 235, 450)

- [ ] **Step 1: Add the headless pairing check to each runbook**

Directly before the "Remote server updates" bullet in each of the three files insert:

```markdown
- Headless pairing: on a second machine or VM run `bibcode serve --host
  <routable address>`, confirm the startup line contains `pairingCode`, mint a
  second offer with `bibcode pairing offer --endpoint http://<address>:3773`,
  add each through **Add Server → Pairing code**, then restart the headless
  server and confirm the saved server reconnects without re-pairing.
```

- [ ] **Step 2: Run the full gate set**

Run:

```sh
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo test -p bibcode-server --lib auth::pairing_offer config::tests lifecycle::tests
cargo test -p bibcode-server --test cli_smoke
cargo test -p bibcode-server --test auth_http pairing_offer
cargo test -p bibcode-server --test e2ee_ws
vp check
vp run typecheck
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add docs/testing/linux-desktop.md docs/testing/macos-desktop.md docs/testing/windows-desktop.md
git commit -m "docs(testing): validate headless pairing offers and restart survival"
```
