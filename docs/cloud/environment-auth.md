# Environment authentication profile

The environment server and the BiBCode Connect relay have separate issuers,
credentials, and trust boundaries. Both use OAuth-shaped tokens and scopes, but
an environment token is never valid at the relay and a relay token is never an
environment session.

## Environment scopes

Canonical scope constants are in
[`apps/server/src/auth/model.rs`](../../apps/server/src/auth/model.rs).

| Scope                   | Permission                                                                    |
| ----------------------- | ----------------------------------------------------------------------------- |
| `orchestration:read`    | Read configuration, snapshots, events, filesystem/VCS state, and diagnostics. |
| `orchestration:operate` | Dispatch operations and mutate environment-side workspace state.              |
| `terminal:operate`      | Create, attach, write, resize, clear, restart, and close terminals.           |
| `review:write`          | Read diff previews used to compose review feedback.                           |
| `access:read`           | Inspect pairing links and authorized client sessions.                         |
| `access:write`          | Create or revoke pairing links and client sessions.                           |
| `relay:read`            | Read the environment's persisted Connect link state.                          |
| `relay:write`           | Install/configure the relay client and link or unlink the environment.        |

Every user-created or host-local environment-administrator pairing grants the
same fixed, non-Relay scope set:

```text
orchestration:read orchestration:operate terminal:operate review:write access:read access:write
```

There are no pairing permission levels. The desktop bootstrap and the initial
authenticated-web startup bootstrap retain the legacy Relay administration
scopes while Connect remains executable, but newly created administrator
pairings never grant `relay:read` or `relay:write`. The current
`cloud.getRelayClientStatus` and `cloud.installRelayClient` RPC methods require
`relay:write`; environment-administrator sessions cannot invoke them. The exact RPC map is
[`required_scope`](../../apps/server/src/auth/scope.rs), and the Connect HTTP
route scopes are declared in
[`http_routes.rs`](../../apps/server/src/production/http_routes.rs).

The pairing-create JSON shape is strict. A legacy `scopes` field is rejected
instead of being ignored and accidentally presenting full-administrator access
as a limited grant.

## Bootstrap and session flows

### Browser session

`POST /api/auth/browser-session` accepts only the desktop bootstrap or the
initial authenticated-web startup pairing. It creates an HTTP-only, SameSite
browser session cookie. The response exposes the granted scopes and expiry, not
the session secret. Browser HTTP and WebSocket ticket requests authenticate
with this cookie. A user-created environment-administrator pairing cannot be
exchanged through this cookie adapter; remote/native clients use DPoP.

### Bearer or DPoP token exchange

Non-cookie clients exchange a bootstrap at `POST /oauth/token` using an
`application/x-www-form-urlencoded` OAuth token-exchange request:

```text
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<bootstrap credential>
subject_token_type=urn:bibcode:params:oauth:token-type:environment-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope=orchestration:read orchestration:operate terminal:operate review:write relay:read
```

Requested scopes must be a subset of the bootstrap grant. Optional
`client_label`, `client_device_type`, and `client_os` values are presentation
hints for the authorized-clients UI; the environment does not use them for
authorization.

The host-local desktop bootstrap may produce a bearer token when no proof is
supplied. Every network pairing credential requires a valid `DPoP` proof
header; proofless pairing exchange is rejected. The issued access token is
bound to the proof-key thumbprint and its response token type is `DPoP`.
Subsequent requests present both `Authorization: DPoP <token>` and a fresh proof
for the exact method and URL.

Pairing consumption, session creation, and the exchange receipt are one
immediate database transaction. A lost-response retry with the same credential
and proof key during the five-minute receipt window returns the same logical
session. A different proof key cannot claim or replay that pairing. Exchange
admission uses a bounded 64-attempt, one-minute server window; saturation does
not consume the code and has the same public shape as an invalid credential.

### WebSocket ticket

`POST /api/auth/websocket-ticket` accepts a valid cookie, bearer token, or DPoP
session and issues a short-lived, single-purpose ticket. The client opens
`/ws?wsTicket=<ticket>`; bearer and DPoP access tokens do not appear in the
WebSocket URL.

Each ticket has a unique ID and may open only one socket. The ticket carries the
session scopes, but each RPC still checks its own required scope. Revoking the
parent client session closes an already connected socket; expiry and a lost
revocation event stream also close it fail-safe. Tickets are bounded and
consumed by
`authenticate_websocket` in
[`auth/http.rs`](../../apps/server/src/auth/http.rs).

## Access administration

Administrative sessions use the `/api/auth/pairing-*` and
`/api/auth/clients*` routes to create, inspect, and revoke access. The raw
pairing credential appears only in the successful creation response and cannot
be recovered afterward. Pairing-list and access-event payloads contain only the
ID, a short SHA-256 fingerprint, optional client label, creation time, and
expiry. Successful exchange creates a separate bounded client session.
Revoking an unconsumed pairing prevents exchange; revoking a client ends its
current HTTP and WebSocket access.

Migration `048_HashedPairingCredentials` hashes legacy pairing values with
SHA-256, rebuilds the table without a plaintext column, checkpoints/truncates
the WAL, and deliberately skips the normal pre-migration backup so the upgrade
does not create a new plaintext-bearing copy. Existing backups created by an
older version are not rewritten automatically and must continue to be handled
as secrets. Existing-store startup repeats the truncating checkpoint after this
migration so an interruption between commit and the first checkpoint cannot
leave legacy bytes admitted on the next run.

Migration `031_AuthAuthorizationScopes` is a deliberate hard cutover from
role-bearing records to scoped records. It removes existing pairing links and
sessions without changing unrelated environment state. Upgraded clients must
pair again; old roles are not silently promoted to scopes.

### Protected local control

Host-local administration does not cross the HTTP/WebSocket authentication
boundary. Every native server owns a separate versioned control endpoint after
its persistent identity and authentication state are ready:

- macOS and Linux use `<state>/run/control.sock`. The existing or newly created
  parent must be owned by the service user with mode `0700`, the socket has mode
  `0600`, and the server checks peer credentials before reading a frame. A root
  peer is accepted for a non-root service only during an explicit managed
  service launch.
- Windows uses `\\.\pipe\bibcode-<environment-id>`. Each instance is created
  with an explicit protected DACL for the effective service-account SID and
  Builtin Administrators, a deny entry for network logons, and remote-client
  rejection. The server also validates the impersonated client token and
  fail-stops if it cannot revert impersonation.

The v1 protocol accepts one JSON request and one JSON response per connection,
framed by a four-byte big-endian length and capped at 64 KiB with a five-second
frame deadline. Its closed command inventory is `Status`, `CreatePairing`,
`ServicePrepareUpdate`, and `ServiceStop`; it is not a general RPC, SQL, shell,
filesystem, account, firewall, or purge channel. Public failures contain only a
stable code and safe message. Pairing values and pairing URLs are redacted from
debug output.

`Status`, `CreatePairing`, and `ServiceStop` are active. Update preparation is
active only when the desktop maintenance owner exists. `CreatePairing` issues a
five-minute, single-use `environment-administrator` credential with the fixed
orchestration read/operate, terminal operate, review write, and access
read/write scopes. It has no caller-selected permission list and does not grant
legacy Relay scopes. Server shutdown stops control admission, drains accepted
requests, and removes a Unix socket only while its device/inode ownership still
matches this process; the database and runtime lock remain live until that
drain completes.

Run the issuance command as an authorized host user while the server is
running:

```sh
bibcode auth pairing create \
  --client-label "Administrator laptop" \
  --format human \
  --base-dir /absolute/path/to/bibcode-data
```

`--format json` emits exactly one JSON document with `environmentId`,
`credential`, `expiresAt`, `pairingUrl`, and `controlProtocolVersion`. Human
mode prints the pairing URL and expiry without printing the raw credential a
second time. The client resolves `--base-dir` with the same rules as `serve`,
reads the durable environment marker, validates the expiry and URL fragment,
and never falls back to an HTTP administration endpoint.

## Standards profile

- Bearer use follows the RFC 6750 authorization scheme.
- Token exchange uses the RFC 8693 request and response vocabulary.
- Scope strings use the RFC 6749 space-delimited subset model.
- DPoP-bound sessions verify the proof method, URL, key thumbprint, nonce when
  required, and access-token hash.

This is not a general-purpose OAuth authorization server. The environment
bootstrap token type, browser-session adapter, and WebSocket ticket are
product-specific, and API failures use BiBCode's typed HTTP/RPC error schemas.

## Relay boundary

The relay uses Clerk bearer tokens to identify cloud users and relay-issued
DPoP tokens for status/connect operations. It sends separately signed,
nonce-bound requests to an environment's public health and mint endpoints. The
environment validates those proofs and returns signed results before the relay
passes a bootstrap to the client. See
[BiBCode Connect auth flow](./bibcode-connect-auth-flow.md).
