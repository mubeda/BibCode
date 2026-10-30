# Unattended CLI diagnostics: the CLI pairs as its own device (#202) — design

Status: approved (scope option C, crash dumps refused, `wss` committed, `forget`
local-only, 30-day expiry documented), with the amendments at the end. Follows
#201 (relay through the app,
`docs/superpowers/specs/2026-10-27-diag-thread-cli-design.md`, whose Option C this
is) and #194 (`server.downloadDiagnosticLogs`).

## Acceptance (from the issue)

1. With the app closed, an agent fetches a reachable remote's diagnostic bundle
   with a revocable, diagnostics-scoped credential.
2. Same redaction, size bounds, crash-dump scope check and identity check as the
   in-app download.

## Facts that constrain the design

- **No production Rust client exists for the remote protocol.** The only Noise
  initiators are test code: `apps/server/src/rpc/e2ee.rs:2004-2042`
  (`SnowInitiator`) and `apps/server/tests/e2ee_ws.rs:99-260` (`initiator`,
  `noise_connect_on`, `encrypt_record`, `send_encrypted`, `recv_encrypted`,
  `pair_inside_channel`, `confirm_pairing`, `download_diagnostic_logs`). The
  production responder is `run_e2ee_session` (`e2ee.rs:1000`); record framing is
  `PlaintextRecords`/`plaintext_records` (`e2ee.rs:88-147`), limits are the
  `MAX_E2EE_*` constants (`e2ee.rs:47-54`). The wire contract is
  `docs/architecture/remote.md` "Direct-connection E2EE".
- **The download is already a plain RPC stream** that a non-web client can drive:
  `{_tag:"Request", tag:"server.downloadDiagnosticLogs", payload:{frontendLog,
  includeCrashDumps}}`, then `Chunk` items `Started{fileName, byteLength,
  manifest}` and `Data{data}` (base64, ≤ 64 KiB), each released by an `Ack`, then
  `Exit` (`production/diagnostic_logs_rpc.rs`; types in `rpc/message.rs:66-205`).
  `tests/e2ee_ws.rs:1531-1716` drives exactly this over a pinned channel.
- **Redaction and the archive bound are server-side** (`DiagnosticBundleService::build`,
  `diagnostic_logs_rpc.rs:146-175`, 20 MiB `MAX_DIAGNOSTIC_ARCHIVE_BYTES`). Crash
  dumps need `orchestration:operate` of the same credential
  (`diagnostic_logs_rpc.rs:117-121`). Any client of this RPC gets the same
  redaction and dump check by construction.
- **The client-side checks** live in `DiagnosticLogsAssembler`
  (`packages/client-runtime/src/diagnostics/logs.ts:107-178`): `byteLength` ≤ 20 MiB,
  archive name shape, `manifest.storageInstanceId` equals the connection's verified
  store, each item ≤ 64 KiB and within the bytes still expected, total equals
  `byteLength`. #201's CLI already has a Rust port of the same checks plus the
  archive's inner `manifest.json` check and a no-overwrite publish
  (`diagnostics/relay_cli.rs:240-460`: `save_new`, `archive_matches_manifest`,
  `accept_line`, `printable`).
- **Scopes are exact-match strings.** `required_scope` maps each method to one
  scope (`auth/scope.rs:11`); the session check is
  `session.scopes.iter().any(|scope| scope == required_scope)`
  (`auth/service.rs:1030`); `Principal::has_scope` likewise (`auth/model.rs:245`);
  the pairing-offer route requires requested scopes ⊆ caller scopes by exact match
  (`auth/http.rs:355-367`). `server.downloadDiagnosticLogs` needs
  `orchestration:read` (`scope.rs:65`), which also grants `projects.readFile`,
  `orchestration.subscribeThread` (conversation content), diffs and the rest of
  the read list (`scope.rs:21-90`).
- **Pairing offers already carry scopes** over HTTP (`CreatePairingOfferRequest.scopes`,
  `auth/model.rs:110`, checked at `auth/http.rs:355`), but `bibcode pairing offer`
  always mints `STANDARD_SCOPES` (`issue_offline_share_pairing`,
  `auth/service.rs:2763-2806`; `mint_offline_pairing_offer`,
  `auth/pairing_offer.rs:113`).
- **A pending session confirms itself regardless of scope**:
  `has_pending_pairing_capability_for` bypasses the scope check for
  `auth.confirmPairing` only (`rpc/session.rs:451-452`, `:1195-1196`). A
  diagnostics-only pending session can therefore confirm.
- **Sessions are labelled from the grant**: `apply_grant_label`
  (`auth/service.rs:2675`, used at `:752`, `:865`) copies the offer's label onto
  the client record, so the CLI's session is identifiable in the remote's Share
  tab and revocable there (`/api/auth/clients/revoke`). Device type stays
  `unknown` (`e2ee.rs:1638`).
- **Sessions last 30 days, unrenewed** (`SESSION_TTL_MS`, `auth/service.rs:40`).
  A bearer reconnect answers only `{"type":"e2ee_authenticated"}`; revoked and
  expired both answer `e2ee_error/unauthorized`.
- **The E2EE credential cannot be downgraded**: its `transport:"e2ee"` claim is
  refused on plain `/ws` and HTTP (`remote.md` "Direct-connection E2EE").
- **Secrets on disk**: `auth::SecretStore` (`auth/secret_store.rs`) creates its
  directory 0700 and files 0600 on Unix and locks ACLs on Windows
  (`secure_windows_path`, `:494`). The server's own host-identity private key and
  signing key live this way in `<state dir>/secrets`.
- **WebSocket TLS**: `tokio-tungstenite` is built without a TLS feature
  (`Cargo.toml:113`); `rustls`, `tokio-rustls`, `rustls-native-certs` and
  `rustls-platform-verifier` are already in `Cargo.lock` through `reqwest`.
- **The contracts' scope union is closed**: `AuthEnvironmentScope`
  (`packages/contracts/src/auth.ts:85`) decodes `AuthClientSession.scopes`,
  `AuthPairingLink.scopes` and `EnvironmentAuthorizationError.requiredScope`. A
  session holding a scope the contracts do not list fails to decode, and with it
  the whole Authorized clients list.
- The desktop executable forwards every `diagnostics` subcommand to the server's
  CLI (`diagnostics/profiler/cli.rs:144-190`), so new subcommands need no desktop
  change.

## Decision 1: what credential the CLI holds

| Option | What the CLI holds | Verdict |
| --- | --- | --- |
| A. Standard pairing scopes | `orchestration:*`, `terminal:operate`, `review:write`, `relay:read` | Rejected: a stolen file runs commands and terminals on the remote. |
| B. `orchestration:read` only (no auth change; works today through `/api/auth/pairing-offer`) | every read method | Rejected: reads all source files, threads (prompt and reply content), diffs and settings. Far wider than diagnostics. |
| **C. New `diagnostics:read` scope (recommended)** | `server.downloadDiagnosticLogs` only | Least privilege; needs a scope, a contracts change and one satisfaction rule. |

**C in detail.**

- `SCOPE_DIAGNOSTICS_READ = "diagnostics:read"` joins `ALL_SCOPES` (so it is
  valid in requests) but not `STANDARD_SCOPES` or `ADMINISTRATIVE_SCOPES`.
- `required_scope("server.downloadDiagnosticLogs")` becomes `diagnostics:read`.
- One rule, `auth::model::scope_satisfies(granted, required)`:
  `orchestration:read` satisfies `diagnostics:read`; otherwise exact match. Every
  existing session keeps the in-app download without re-pairing (it already had
  it through `orchestration:read`). It replaces the three exact compares:
  `Principal::has_scope` (`model.rs:245`), `AuthService::authorize_session`
  (`service.rs:1030`) and the pairing-offer subset check (`http.rs:365-367`), so
  an existing administrative session may mint a `diagnostics:read` offer. The
  rule is one-way: `diagnostics:read` satisfies nothing else.
- Crash dumps stay behind `orchestration:operate`, unchanged
  (`diagnostic_logs_rpc.rs:117`). A diagnostics credential therefore cannot fetch
  dumps; `--include-crash-dumps` with `--remote` is refused by the remote with the
  same `EnvironmentAuthorizationError{requiredScope:"orchestration:operate"}` the
  app gets, and the CLI exits 2 with `crash-dumps-refused`. This is the
  identical check the issue asks for. (Alternative, not proposed: a
  `diagnostics:crash-dumps` scope that also satisfies the dump check. It would
  hand raw process memory, which can hold tokens and prompt fragments, to an
  unattended credential; it needs its own approval.)
- `server.getConfig` stays outside the scope (it returns settings, projects and
  provider state). The CLI needs no other method (see Decision 4).
- No schema migration: `auth_pairing_links.scopes` and `auth_sessions.scopes`
  are JSON text, so an added scope string needs no schema change (unlike the
  031 role cutover, which changed meaning, not vocabulary). It is not
  rollback-free, though: a server older than #202 fails to start on a persisted
  row naming `diagnostics:read`, because hydration treats an unknown scope as
  corrupt (review amendment 5). From #202 on, hydration skips such rows with a
  warning; rolling back past #202 requires revoking (or outliving) diagnostics
  clients first (`docs/operations/release.md`, "Rolling a server back").
- Contracts: add `AuthDiagnosticsReadScope` to the `AuthEnvironmentScope` union
  and regenerate `packages/contracts/fixtures/auth-http/scopes.json`
  (`scripts/export-rust-auth-fixtures.ts`, `authRustParity.test.ts`,
  `apps/server/tests/auth_http.rs`). This is mandatory, not polish: without it
  the remote's own Share tab fails to decode its client list once a diagnostics
  session exists.

**How the remote issues it.** `bibcode pairing offer --access diagnostics`
(new flag, values `full` (default, today's standard scopes) and `diagnostics`)
mints an encrypted offer whose grant carries only `diagnostics:read`. The label
defaults to `<name> (diagnostics)` so the Share tab row says what it is. The
HTTP route (`POST /api/auth/pairing-offer` with `scopes:["diagnostics:read"]`)
accepts it once the scope is valid; the app's Share tab gets no new control in
this change (see Out of scope). A closed `--access` enum is preferred to a free
`--scope` list: an operator cannot compose a credential nobody reviewed.

## Decision 2: a production Rust client for the pinned protocol

| Option | Verdict |
| --- | --- |
| **A. New `rpc::e2ee_client` module in `bibcode-server` (recommended)** | Lives next to the responder, reuses its constants and `plaintext_records`, compiled into the same `bibcode` binary the CLI is. |
| B. Make the test helpers in `tests/e2ee_ws.rs` public | Rejected: they panic on every error and deliberately build malformed frames; tests must keep that ability. |
| C. A separate crate | Rejected for now: one consumer, and it needs `pub(crate)` framing items. |

The module does only what this command needs, failing closed on anything else:

- `connect(endpoint, host_key)` → opens `ws(s)://<endpoint>/ws-e2ee` (path joined
  to the offer's endpoint, no proxy, no redirects), runs
  `Noise_NK_25519_ChaChaPoly_SHA256` as initiator pinned to the offer's 32-byte
  key with empty payloads, under the server's own 10 s handshake deadline. A close
  with 4403 (`E2EE_HOST_IDENTITY_CLOSE_CODE`) or a failure to read message B is
  `HostIdentityMismatch`; anything before the upgrade completes is
  `Unreachable`.
- Records: outbound logical messages split with `plaintext_records` (≤ 65,518
  bytes, `0x00`/`0x01`); inbound reassembly rejects empty continuations, any flag
  other than `0x00`/`0x01` (no features are offered, so `0x02` control and `0x10`
  deflate records are protocol errors), more than 2,048 records, and more than
  1 MiB per logical message (a `Chunk` carries one ~87 KiB item; the server's
  64 MiB cap is far above what this client needs). Nonce exhaustion or any AEAD
  error ends the connection.
- `authenticate_pairing(token)` / `authenticate_bearer(credential)` send
  `e2ee_auth` with no `features`, and parse `e2ee_authenticated` /
  `e2ee_error{code}` with the same 64 KiB pre-auth bound.
- `stream(tag, payload, on_item)` sends one `Request`, acknowledges each `Chunk`
  after `on_item` accepts it, returns on `Exit`; a `Defect` or
  `ClientProtocolError` ends with that reason (an unknown method is a connection
  `Defect`, reported as `unsupported`). `unary(tag, payload)` for
  `auth.confirmPairing`. It reuses `ClientMessage`/`ServerMessage` from
  `rpc/message.rs`, so the codec cannot drift from the server's.
- Heartbeat: the server pings every 15 s and reaps after 45 s without an inbound
  frame; the client is always reading while a request is open, and
  tokio-tungstenite answers pings while it reads. No idle connection is kept.
- TLS for `https` endpoints (Tailscale Serve on 443, reverse proxies): enable a
  rustls connector feature on `tokio-tungstenite` using the platform verifier the
  way `reqwest` does, if `Cargo.lock` gains no new crates; otherwise phase 2 ships
  `http` endpoints only and says so. Noise already gives confidentiality and
  host authentication, so TLS is for reachability, not security.

## Decision 3: where the CLI keeps the credential

| Option | Verdict |
| --- | --- |
| **A. `auth::SecretStore` under `<state dir>/diagnostics-remotes/` (recommended)** | Same 0700/0600 and Windows ACL handling as the server's own host key and signing key, which already sit in the state dir and are stronger than this credential. Works for a headless agent. |
| B. OS keychain (Keychain, Credential Manager, Secret Service) | Rejected: a new dependency per platform, no precedent in the server, and Secret Service is often locked or absent for a headless agent or service user. It would protect a narrow credential better than the admin-capable signing key next to it. |
| C. A plain JSON file | Rejected: re-implements A's permission handling. |

One record per remote, `<name>.bin`, JSON:
`{v:1, name, endpoint, hostKey, environmentId, storageInstanceId, label, pairedAt, credential}`.
`<state dir>` is the one every `bibcode` command resolves (`profiler_state_dir`,
`config.rs:1179`): `--base-dir`/`BIBCODE_HOME`/`~/.bibcode`. A separate directory
keeps these client records apart from the server's own `secrets/`, which only the
server writes. `SecretStore` gains `remove` and a name listing. Names are
`[a-z0-9][a-z0-9-]{0,62}`, defaulting to a slug of the offer's name. The
credential is never printed, logged, or put in `--json` output or an error.

## Decision 4: the identity check

The app checks the archive against the store its connection verified
(`DiagnosticLogsAssembler`, plus `server.getConfig`'s `storageInstanceId` on each
connect). The CLI has no `getConfig` (outside its scope), so it verifies the same
facts from what it pinned at pairing:

1. Pairing: the offer's host key pins Noise NK; the in-channel
   `e2ee_authenticated` reply's `storageInstanceId` must equal the offer's (and
   `environmentId` is recorded). A mismatch closes the channel before
   confirmation, which revokes the pending session.
2. Every download: the NK pin (a different host cannot complete the handshake),
   then `Started.manifest.storageInstanceId` and `environmentId` must equal the
   stored values before any byte is accepted (`wrong-environment`), then the
   archive's own `manifest.json` must name the same environment, store and
   version as `Started` (`archive_matches_manifest`, unchanged).

A remote that was reset (new store) or whose host key changed fails with a message
to pair again; nothing is saved.

## Decision 5: the archive checks are shared, not copied

#201's `Receiving`/`accept_line`/`save_new`/`archive_matches_manifest` move into a
small `diagnostics::archive` module used by both the relay command and the remote
command: the same 20 MiB, 64 KiB-per-item and exact-length checks, archive name
shape, inner-manifest check, hidden temporary file, hard-link publish that never
replaces a file, and `printable` for remote-provided text. The remote path adds
only the stored-identity comparison of Decision 4. `frontendLog` is `""`: the CLI
has no frontend.

## CLI

```
bibcode diagnostics pair [OFFER] [--name <name>] [--json]
bibcode diagnostics remotes [--json]
bibcode diagnostics forget <name> [--json]
bibcode diagnostics download (--environment <id|name> | --remote <name>)
                             [--include-crash-dumps] [--output DIR] [--json]
```

- `pair` takes `bibcode://pair?code=…`, a `/pair?code=…` URL, or the bare code;
  with no argument it reads one line from stdin, so the one-time token need not
  appear in `ps` or shell history. It refuses an offer without a host key (legacy
  bearer pairing) and an existing name. Order, as the app's add flow
  (`remote.md`, "The add flow…"): connect pinned → `e2ee_auth{pairing}` → check
  identity → write the record (create, never replace) → `auth.confirmPairing` on
  the same channel when `pairingConfirmationRequired`. A typed rejection deletes
  the record. An ambiguous confirmation (connection lost after sending) is
  settled by one bearer reconnect: authenticated keeps the record, `unauthorized`
  deletes it, unreachable keeps it and says the next download will tell. Output:
  name, the remote's name, store id; never the credential.
- `remotes` lists name, endpoint, remote name, store id and paired date.
- `forget` deletes the local record and says the remote still lists the client
  until it is revoked there (Share this host → Authorized clients) or expires 30
  days after pairing.
- `download --remote` writes exactly what `--environment` writes, with the same
  JSON document and exit codes: 0 saved; 1 failed (`host-identity-mismatch`,
  `wrong-environment`, `incomplete`, `too-large`, `exists`, `protocol`,
  `server-failed`); 2 refused (`unauthorized`: "revoked or expired; sessions
  last 30 days from <pairedAt>; pair again", `crash-dumps-refused`,
  `not-permitted`); 3 unavailable (`not-paired`, `unreachable`, `unsupported`).
  Timeouts: 10 s handshake, 120 s for `Started` (bundle build), 90 s between
  items; Ctrl-C closes the socket, which cancels the remote stream and frees its
  archive slot, and nothing is written before the archive is complete.
- `--environment` and `--remote` are mutually exclusive; one is required.

## Reachability

| Remote reached by | Works? | What happens |
| --- | --- | --- |
| Direct endpoint with a pinned offer (`http`) | Yes | The supported path. |
| Direct endpoint over `https` (Tailscale Serve, proxy) | Yes if the TLS feature lands (Decision 2), else no | Clear `unsupported` message naming `https`. |
| Legacy manual bearer (no host key) | No | `pair` refuses: "create a new pairing offer on the remote". |
| Desktop-managed SSH only | No | There is no endpoint to connect to without the app's tunnel. Use `ssh <host> bibcode profiler` / run the command on the host, or `download --environment` through the app (#201). An offer minted on the host for an address this machine can reach works like any direct remote. |
| BiBCode Connect only | No | Connect needs a Clerk sign-in and relay DPoP tokens the CLI does not have. Use `download --environment` through the app. |

## Security analysis

- **Blast radius of a stolen credential**: one method returning the redacted
  bundle (what `orchestration:read` already exposes in logs), no dumps, usable
  only over Noise to that one host (the `e2ee` transport claim is refused on
  plain surfaces), for at most 30 days, revocable on the remote.
- **At rest**: 0600 / ACL in the user's state dir, beside keys that are strictly
  more powerful; a process that can read it can already read those.
- **In transit**: Noise NK with the pinned key; a man in the middle cannot
  complete the handshake, and the one-time token is sent only inside the
  channel, so a wrong host never sees it.
- **Pairing token**: one-time, five minutes, consumed only by a successful
  exchange; stdin input keeps it out of argv.
- **Scope rule**: one-way and in one function, tested in both directions; no
  method other than the download names `diagnostics:read`.
- **Hostile remote**: every inbound size is bounded before allocation (record,
  message, item, archive), remote text is printed through `printable`, archive
  names are checked, and no existing file is replaced.
- **Exposure accounting**: an off-host diagnostics session counts like any
  off-host client, so it keeps the remote's desired exposure wide until revoked;
  documented.
- **Local attacker**: who can run `bibcode` as the user can already read the
  state dir; nothing new.

## Wire, scope and persisted-shape changes

- New scope string `diagnostics:read` (Rust `auth/model.rs`, contracts
  `auth.ts`, fixtures, docs table in `docs/cloud/environment-auth.md`).
- `server.downloadDiagnosticLogs` required scope → `diagnostics:read` (satisfied
  by `orchestration:read`).
- `bibcode pairing offer --access full|diagnostics`.
- New CLI subcommands and `download --remote`.
- New on-disk records under `<state dir>/diagnostics-remotes/` (CLI-owned, not
  read by the server).
- No change to `/ws-e2ee`, `e2ee_auth`, RPC framing, pairing-code payload or
  database schema.

Version skew: an older app listing the clients of a newer server that holds a
diagnostics session cannot decode them; in practice the Share tab lists its own
server's clients and ships with it. A newer CLI against an older remote cannot
pair with `--access diagnostics` (the old server rejects the scope).

## Tests (complete caller first)

Integration, `apps/server/tests/` with the real `bibcode` binary (pattern of
`cli_minted_offer_pairs_and_the_session_survives_a_restart`):

1. Server up → `bibcode pairing offer --access diagnostics --json` →
   `bibcode diagnostics pair` (offer on stdin, separate `--base-dir`) →
   `bibcode diagnostics download --remote <name> --json` exits 0, the ZIP's
   manifest names the server's store, `frontend.log` empty, record file 0600
   (Unix), no output contains the credential.
2. Same credential: `--include-crash-dumps` exits 2 `crash-dumps-refused`;
   over the channel `server.getConfig` and `projects.listEntries` are refused.
3. Admin revokes the session (`/api/auth/clients/revoke`) → download exits 2
   `unauthorized`.
4. Server restart → download still works.
5. Wrong host key (edited record) → exits 1 `host-identity-mismatch`; a record
   with another `storageInstanceId` → `wrong-environment`, nothing saved.
6. Existing ordinary (`orchestration:read`) sessions still download
   (`diagnostic_logs_download_over_a_pinned_channel_and_dumps_need_operate`
   unchanged).

Unit: `scope_satisfies` both directions and `required_scope` table; pairing-offer
route accepts `["diagnostics:read"]` from an administrative session; client
reassembly bounds (empty continuation, unknown flag, record and byte caps);
pairing rollback on identity mismatch and on typed confirm rejection; `pair`
parsing of the three offer forms; name validation; `SecretStore::remove`/list.

## Profiler, crash and trace coverage

No child process, no new RPC method, no removal path, no new binary mode: none
applies. The scope change keeps `server.downloadDiagnosticLogs` in the timed
`rpc/session.rs` wrappers. The CLI initializes no tracing; it never logs or prints
the credential or the pairing token.

## Out of scope (named, not built)

A Share-tab control to mint diagnostics-only offers (web, other owner; the CLI
flag and the HTTP route suffice); remote self-revocation from `forget` (needs a
new RPC); credential renewal past 30 days; `bibcode profiler --remote`;
`diagnostics:crash-dumps`; `clientDeviceType` hints on `e2ee_auth`.

## Open questions for approval

1. Scope option C (`diagnostics:read`), with crash dumps refused for it?
2. TLS feature on `tokio-tungstenite` for `https` remotes, or `http` only in v1?
3. `forget` local-only (as proposed), or also a self-revoke RPC now?

Answered at approval: 1 yes; 2 `wss` committed (no lockfile condition); 3
local-only, documented with the 30-day expiry.

## Approval amendments

1. **The saved credential is proven diagnostics-only.** Neither the pairing code
   nor the bearer reply says what a grant holds, so a full-access offer would
   otherwise be saved. The pairing reply (`e2ee_authenticated` with a credential)
   now carries the minted credential's `scopes`; `pair` saves nothing unless they
   are exactly `["diagnostics:read"]` (`not-diagnostics-only`), and a server that
   sends no `scopes` (older than #202) is refused (`unsupported`). Closing the
   unconfirmed channel revokes the pending session; an on-host grant, already
   active, is named for revocation on the Share tab. The contracts type gains an
   optional string array, which the web client ignores.
2. **TLS** uses rustls (aws-lc-rs provider) with `rustls-platform-verifier`, as
   `reqwest` does, passed to `tokio-tungstenite`'s rustls connector; no crate is
   added to `Cargo.lock`. Tests build a throwaway P-256 authority and server
   certificate at run time (`tests/support/tls_fixture.rs`, 30-day validity, so
   no fixture expires and Apple's validity limit holds) rather than adding
   `rcgen`, which would have re-resolved unrelated lockfile entries.
3. **Shared receiver** bounds each item's encoded length (the padded base64 of
   64 KiB) and its decoded length against the bytes still expected before
   decoding, as `DiagnosticLogsAssembler` does; the relay path now gets the same
   bound.
4. **Fault tests through the real command**: a record that cannot be written
   (the pending grant is revoked), a connection lost before confirmation
   (record deleted, grant revoked) and after it (record kept), expiry after a
   restart, and an interrupted download (both archive slots come back), plus a
   seeded secret redacted in `server.log` and the empty-frontend text.
