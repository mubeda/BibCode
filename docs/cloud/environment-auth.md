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
| `diagnostics:read`      | Download the redacted diagnostic bundle (`server.downloadDiagnosticLogs`).    |

`orchestration:read` satisfies `diagnostics:read` through one rule,
`scope_satisfies` in `auth/model.rs`. The RPC method check, session
authorization, the token exchange's requested-scope subset, the pairing-offer
subset check and `Principal::has_scope` all use it, so every ordinary credential
keeps the diagnostic download; `diagnostics:read` satisfies nothing else. No
standard or administrative grant lists it: only a diagnostics-only pairing
offer (`bibcode pairing offer --access diagnostics`, or `POST
/api/auth/pairing-offer` with `"scopes": ["diagnostics:read"]`) grants it alone,
for `bibcode diagnostics pair`. Crash dumps in the bundle still need
`orchestration:operate`, so such a credential cannot fetch them. Only
`orchestration:operate` itself passes that check: the RPC handler asks
`scope_satisfies`, which implies nothing for it, and the primary's HTTP route
compares exactly (`Authorized::has_scope` in `http_routes.rs`). The E2EE
pairing reply names the minted credential's `scopes`, so a client can refuse
a credential wider than it asked for (see
[Remote architecture](../architecture/remote.md#command-line-diagnostics-pairing)).

Ordinary pairing credentials grant:

```text
orchestration:read orchestration:operate terminal:operate review:write relay:read
```

Desktop and command-line administrative bootstraps additionally grant
`access:read`, `access:write`, and `relay:write`. The diagnostics relay methods
(`server.subscribeDiagnosticLogsRelay`, `server.claimDiagnosticLogsRelay`,
`server.sendDiagnosticLogsRelayItem`) require `access:write` and, beyond it, the
desktop app's own session (subject `desktop-bootstrap`): an administrative
credential minted for another device is refused. The current
`cloud.getRelayClientStatus` and `cloud.installRelayClient` RPC methods require
`relay:write`; ordinary paired clients cannot invoke them. The exact RPC map is
[`required_scope`](../../apps/server/src/auth/scope.rs), and the Connect HTTP
route scopes are declared in
[`http_routes.rs`](../../apps/server/src/production/http_routes.rs).

## Bootstrap and session flows

### Browser session

`POST /api/auth/browser-session` consumes a one-time bootstrap credential and
creates an HTTP-only, SameSite browser session cookie. The response exposes the
granted scopes and expiry, not the session secret. Browser HTTP and WebSocket
ticket requests authenticate with this cookie.

The web app uses this cookie session for its own origin only on a page the
server itself served for that host, which the server marks with
`<meta name="bibcode-served-host">`. Every other page is a remote client that
uses bearer credentials, and so is a served page whose own server is not paired
while other servers are. See
[A page a server served, or a remote client](../architecture/remote.md#a-page-a-server-served-or-a-remote-client).

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

Without a `DPoP` proof header the response token type is `Bearer`. With a valid
proof, the issued access token is bound to the proof-key thumbprint and the
response token type is `DPoP`. Subsequent DPoP requests present both
`Authorization: DPoP <token>` and a fresh proof for the method and URL.

### WebSocket ticket

`POST /api/auth/websocket-ticket` accepts a valid cookie, bearer token, or DPoP
session and issues a short-lived, single-purpose ticket. The client opens
`/ws?wsTicket=<ticket>`; bearer and DPoP access tokens do not appear in the
WebSocket URL.

The ticket carries the session scopes, but each RPC still checks its own
required scope. Authentication therefore does not imply permission to call
every method. Tickets are bounded and consumed by
`authenticate_websocket` in
[`auth/http.rs`](../../apps/server/src/auth/http.rs).

### Outside agents over MCP

`bibcode mcp` (and `<desktop exe> mcp`) mints its own credential from the data
root with `issue_mcp_pairing_link`: a 60-second one-time link with exactly
`orchestration:read orchestration:operate`, subject `mcp-client`, the label
`MCP · <agent name>`, and an access ceiling in the nullable `mcp_access` column
(migration 58). Because the link never holds more, exchange cannot widen it. The
relay exchanges it at `/oauth/token` over loopback, after proving the listener
(see [Remote environments](../architecture/remote.md)), and the exchange copies
`mcp_access` into the session.

- **Audience.** `authenticate_token`, which every cookie, bearer, DPoP, ticket
  and E2EE path uses, refuses the `mcp-client` subject. Only
  `authenticate_mcp_client`, which `/mcp` calls, accepts it. The credential
  therefore reaches the thread tools and nothing else, although its scopes would
  satisfy many RPC methods.
- **Ceiling.** Every call uses the lower of the session's `mcp_access` and the
  environment's `mcpServerAccess`. A session whose `mcp_access` is `NULL` is
  read-only.
- **Lifetime.** The token lives only in the relay's memory. The relay records
  `<state dir>/mcp-clients/<sid>.json` (`pid` and process start time, no
  secret), revokes the session through the data root when it exits, and revokes
  the sessions of records whose process is gone when it starts. Revoking the row
  in Authorized clients ends it on the next call; the relay never mints again
  after a 401.
- **Off switch.** With `enableMcpServer` off, `bibcode mcp` exits before minting,
  and `/mcp` answers outside agents with `McpServerDisabledError`. No session is
  revoked, so turning it back on needs no new pairing.

## Access administration

Administrative sessions use the `/api/auth/pairing-*` and
`/api/auth/clients*` routes to create, inspect, and revoke credentials. Pairing
links are one-time bootstraps; successful exchange creates a separate bounded
client session. Revoking a pairing link prevents future exchange, while
revoking a client ends that client's current access.

Migration `031_AuthAuthorizationScopes` is a deliberate hard cutover from
role-bearing records to scoped records. It removes existing pairing links and
sessions without changing unrelated environment state. Upgraded clients must
pair again; old roles are not silently promoted to scopes.

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
