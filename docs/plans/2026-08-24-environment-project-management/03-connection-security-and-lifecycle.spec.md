# Connection, Security, And Lifecycle Specification

## Trust Boundaries

BiBCode crosses four distinct trust boundaries:

1. **Client UI to client runtime:** typed commands and scoped references; no raw
   host mutation.
2. **Client to environment server:** authenticated HTTP/WebSocket RPC over an
   allowed transport, with descriptor and storage identity verification.
3. **Desktop UI/runtime to host OS:** typed `DesktopBridge` commands/events for
   local processes, WSL, secret storage, and native service/install actions.
4. **Server/CLI to host administration:** protected local socket/named pipe or
   explicit SSH session, plus OS authorization for system-level actions.

No BiBCode cloud service participates in discovery, pairing, routing, updates,
diagnostics, or authentication.

## Allowed Route Types

### Desktop Local

- Primary in-process/loopback server owned by the desktop runtime.
- HTTP/WebSocket may be plaintext only on validated loopback addresses.
- Desktop bootstrap credentials remain short-lived and scoped to the local
  process boundary.

### Desktop-Managed WSL

- Discovery and bootstrap cross `DesktopBridge` and `wsl.exe`.
- Server communication uses a desktop-owned local transport/forward and
  environment authentication.
- The WSL distro locator cannot establish identity; descriptor UUIDs do.

### SSH Tunnel

- Default remote route for Linux, Windows OpenSSH, and macOS Remote Login.
- Server listens on remote loopback.
- Desktop chooses an unused local loopback port and owns the SSH forwarding
  process.
- Application HTTP/WebSocket traffic travels only inside the authenticated,
  encrypted SSH tunnel.
- Host-key verification follows OpenSSH known-host policy and is surfaced
  explicitly. Changed host keys block rather than auto-accept.

### Direct HTTPS/WSS

- Explicit opt-in for an administrator who configures a non-loopback bind.
- Server refuses non-loopback startup unless TLS key/certificate configuration
  validates.
- Trust is either normal system PKI or an exact certificate/public-key pin
  verified through the host-local/SSH enrollment channel.
- Expiry, name mismatch, changed pin, weak configuration, or downgrade blocks.

### Forbidden

- Non-loopback HTTP or WS.
- URL parameters containing long-lived credentials.
- Blind certificate trust-on-first-use.
- BiBCode Connect/cloud relay/managed endpoint.
- Silent SSH installation, host-key acceptance, server provisioning, upgrade,
  firewall change, service-account creation, or privilege escalation.

## Network Admission

Centralize bind validation in the server configuration owner so every launch
path—desktop, CLI, service, tests, and update restart—uses the same policy:

```text
loopback bind + HTTP/WS       allowed
loopback bind + HTTPS/WSS     allowed
non-loopback + HTTPS/WSS      allowed after TLS validation
non-loopback + HTTP/WS        startup failure
```

Do not expose an `--allow-insecure-http` escape hatch. Test-only listeners use
explicit loopback addresses. Advertised endpoints are derived from validated
configuration and never cause a weaker bind than the listener.

Authentication remains mandatory outside the narrowly owned desktop bootstrap
flow. Development unsafe-auth switches must be impossible in packaged release
and service configurations.

## Descriptor And Route Verification

Before pairing or ordinary session admission, the client retrieves a bounded
minimal descriptor containing:

- Durable environment UUID.
- Storage-instance UUID.
- Canonical label.
- Server and protocol/capability versions.
- OS/architecture.
- TLS identity metadata where applicable.

The descriptor contains no projects, paths, users, tokens, logs, or other
sensitive inventory.

Verification order:

1. Validate transport security/SSH host key/TLS trust.
2. Fetch and decode the descriptor under deadline and size limits.
3. Compare environment and accepted storage identities.
4. Check protocol/capability compatibility.
5. Only then consume a one-time pairing credential or load an existing secret.
6. Bind the verified route to the environment supervisor generation.

A failed earlier step does not burn a pairing code.

## Route Selection And Failover

Each route stores a manual priority and optional explicit pin. The active route
is sticky while healthy to prevent needless reconnects and UI churn.

Selection policy:

1. Explicit pinned route when eligible.
2. Last verified active route while healthy.
3. Secure local/private direct route by configured priority.
4. SSH tunnel routes by configured priority.

Platform-local routes can be categorized ahead of remote routes without
changing the invariant that only verified identity joins an environment.

Failover is sequential by default to avoid unnecessary simultaneous SSH/TLS
connections. A bounded staggered race is permitted only where measurements show
it improves recovery and cancellation/reaping are proven. Every attempt has a
timeout, generation, and cancellation owner. Successful failover updates the
active route but never changes manual order/pin.

No route is tried after Forget begins. An authentication-required route does
not trigger repeated credential exchange. Version/certificate/identity failures
are blocked until explicit user action; network failures may back off/retry.

## Enrollment And Pairing

### Local Control Channel

The server owns an OS-protected administration channel:

- Windows named pipe with an ACL restricted to the service user/authorized
  administrators.
- macOS/Linux Unix-domain socket in a directory owned by the service account
  with restrictive mode and peer-credential validation where available.

Network listeners cannot invoke host-local administrative commands merely
because they have an application administrator session.

### CLI Flow

`bibcode auth pairing create` talks to the local control channel and returns a
machine-readable and human-readable five-minute, single-use code/link. It must
implement the currently expected SSH bootstrap command end to end.

The flow is device-authorization-inspired but remains BiBCode-local:

1. Administrator requests pairing locally or through an explicit SSH shell.
2. Server records a hashed one-time credential, expiry, intended scopes, and
   unconsumed status.
3. Client first verifies descriptor and transport.
4. Client submits the credential plus its DPoP public-key thumbprint and label.
5. Server atomically consumes the credential and issues a DPoP-bound session.
6. Client stores private/session material only through its secret provider.

The code is rate limited, never logged, never accepted twice, and cannot be
extended or refreshed before consumption. Polling/backoff is bounded if a UI
uses a separate-device verification interaction.

### Administrator Scopes

For this release, a paired client receives the complete existing environment
administrator scope set. The protocol should retain named scopes so a later
permission design can evolve without replacing credentials, but the UI and
server must not imply unsupported permission levels.

Host-level service install, service-account creation, bind/firewall changes, or
OS data deletion still requires the relevant OS authority. Application admin
does not bypass the host boundary.

## DPoP, Sessions, And Revocation

Preserve the current scoped sessions, one-time pairing, DPoP proof validation,
WebSocket tickets, and revocation architecture while removing cloud-specific
issuers/audiences.

- Each request uses a fresh proof with method/URL binding, nonce/timestamp, and
  replay cache according to the existing implementation/RFC 9449 constraints.
- Access/session tokens are sender constrained to the enrolled key.
- WebSocket admission consumes bounded tickets rather than putting reusable
  bearer material in URLs.
- Revoking a client invalidates sessions/tickets and closes active connections.
- Logs identify client/environment through non-secret IDs and never print
  credentials, proofs, cookies, private keys, codes, or full sensitive URLs.

## Secret Storage

Desktop implementations:

| Platform | Provider           | Required posture                                        |
| -------- | ------------------ | ------------------------------------------------------- |
| Windows  | User-scoped DPAPI  | Do not use machine scope; integrity failure blocks      |
| macOS    | Keychain Services  | Access restricted to BiBCode identity; delete on Forget |
| Linux    | Secret Service API | Locked/unavailable service yields session-only mode     |

Only opaque references and non-secret fingerprints/timestamps live in
IndexedDB. Secret APIs are typed `DesktopBridge` operations, redact their errors,
and never return inventories to arbitrary web content.

Same-origin browser sessions use secure HttpOnly cookies. Offline cache
encryption keys require an origin-bound non-exportable key or session-only
fallback. No platform stores a plaintext fallback “for convenience.”

## Offline Cache Privacy

- Encrypt thread/shell cache with authenticated encryption and per-client key.
- Bind environment/storage/entity/schema values as associated data.
- Enforce size and age limits plus LRU eviction.
- Redact cache metrics to counts/bytes; do not inspect content for analytics.
- Clear keys and records on Forget/Force remove/revoke-this-client as selected.
- Cache is local-only and never uploaded.
- Diagnostics export excludes message content by default; a separate explicit
  content-inclusive export, if ever added, requires an additional warning and
  is outside this design.

## WSL Discovery And Lifecycle

### Enumeration

The Windows desktop bridge invokes `wsl.exe --list --verbose` using bounded
process supervision and correctly decodes its Windows output. Preserve:

- Distro name.
- Default marker.
- Running/Stopped state.
- WSL version.

Enumeration is triggered on desktop startup/focus, explicit refresh, and
relevant bridge lifecycle changes. A bounded low-frequency reconciliation with
backoff may cover missed events; constant polling is forbidden.

One malformed distro line does not discard valid entries. Enumeration timeout,
missing WSL, disabled feature, or command failure becomes explicit discovery
health without hiding previously accepted environments.

### Reconciliation

- Every currently Running distro gets a platform binding and visible row.
- Previously accepted Stopped distro bindings remain visible as Stopped.
- Unaccepted stopped distros appear only in Add Environment discovery.
- A running distro with no compatible binary shows Setup required.
- If a known distro reports its persisted server environment UUID, reconcile it
  to the same environment despite locator/name change.
- The desktop may launch BiBCode Server in a running distro under current
  process-ownership rules.
- It never starts a stopped distro automatically and never invokes unregister.

Discovery results have a generation; late/missing snapshots cannot remove a
newer platform binding. A distro disappearance becomes unavailable/stopped
until an authoritative later reconciliation or explicit Hide/Forget.

## SSH Probe And Provisioning

Add Environment → SSH collects or imports an OpenSSH target, then:

1. Test SSH and host-key trust.
2. Probe remote OS, architecture, shell/command capabilities, existing binary,
   version, service mode/state, data root, and local control availability.
3. If compatible, invoke local pairing creation and establish the tunnel.
4. If missing/incompatible, show the exact target/version/install destination,
   service mode, privilege needs, download size, and signature/checksum status.
5. Only after consent, transfer the exact signed/checksummed release artifact,
   verify on the remote, install atomically, start, and verify descriptor.

Do not require remote internet access; the desktop may download and transfer the
artifact. Do not execute arbitrary client-provided install scripts. Commands
use a structured OS-specific implementation with quoted arguments and bounded
stdout/stderr. Cancellation terminates/reaps owned SSH and transfer processes.

Support:

- Linux POSIX/OpenSSH hosts.
- macOS Remote Login/OpenSSH hosts.
- Windows OpenSSH/PowerShell hosts without assuming POSIX paths or shell syntax.

Provisioning failure leaves the previous compatible binary/service/data intact
or reports the exact partial state and recovery command. It never silently
falls through to another installation target.

## Server Service Modes

The server-only package contains the Rust `bibcode` server/CLI and compiled web
assets. It has no desktop shell, Electron/Node runtime, or helper sidecar.

### Workstation Mode (Default)

| Platform | Startup owner                | Security context                                                             |
| -------- | ---------------------------- | ---------------------------------------------------------------------------- |
| Windows  | Task Scheduler logon trigger | Installing user; no stored password when platform supports interactive token |
| macOS    | LaunchAgent                  | Installing user session                                                      |
| Linux    | systemd user service         | Installing user; linger is explicit if operation after logout is desired     |

Loopback bind and per-user data directories are the defaults. Installers explain
when logout stops the service and when linger/background approval changes that.

### Headless Mode (Explicit)

| Platform | Startup owner       | Security context                                       |
| -------- | ------------------- | ------------------------------------------------------ |
| Windows  | Windows Service     | Dedicated least-privileged `bibcode` account           |
| macOS    | LaunchDaemon        | Dedicated least-privileged account with admin approval |
| Linux    | system systemd unit | Dedicated `bibcode` account                            |

Headless installation is a separate explicit choice, not an automatic elevation
from workstation mode. It creates only required directories/ACLs, uses no
interactive user secrets, and documents provider credential configuration.

### Common Service Requirements

- One active process per data root through an OS-appropriate lock.
- Explicit working directory, environment allowlist, PATH, log/data locations,
  restart policy, start timeout, stop timeout, and graceful signal/control call.
- Loopback listener by default.
- Protected local admin channel.
- Bounded local logs with rotation/redaction.
- Health/identity verification after start/restart.
- Stop/uninstall reaps child provider/terminal/SSH processes according to
  current supervision invariants.

## Updates And Rollback

Stable updates require an administrator action by default. Unattended stable
updates are a clearly labeled per-environment opt-in.

Update protocol:

1. Fetch signed metadata without telemetry or per-install identifiers.
2. Verify target OS/architecture/version, checksum, signature, and downgrade
   policy.
3. Acquire update/single-instance maintenance lease.
4. Stop new orchestration/terminal/provider admission.
5. Drain bounded in-flight work and publish cancellation/final states.
6. Create/verify a storage backup under the existing maintenance boundary.
7. Stage and atomically replace the binary, compiled web assets, and any
   service definition whose verified package digest changed.
8. Restart and verify environment ID, storage ID, version, protocol, and health.
9. On binary/start failure, restore the prior binary and retry once under the
   same bounded recovery policy.

Never automatically downgrade a migrated database. If the new binary committed
an irreversible migration and cannot start, stop with recovery instructions and
preserved backups rather than running an old binary against a new schema.

## Removal And Uninstall Protocol

### Online

Host mutations require a versioned removal plan describing reachability,
identity, service/binary/data paths, active work, dirty/locked worktrees,
projects, backups, other paired clients, and requested uninstall/purge effects.

The user confirms the exact plan. Before execution, the host revalidates its
token and facts. Stale facts return a new plan; they do not weaken deletion.

- Uninstall stops/reaps service and deletes package-owned binary/service files.
- Uninstall preserves data and backups by default.
- Purge is independent, requires typed environment name, verifies the data-root
  identity and refuses broad/unresolved paths.
- Project/worktree Git deletion keeps its existing dedicated removal plan; the
  environment purge may not bypass those safety boundaries by issuing arbitrary
  path deletion.

### Offline

Only local Force remove is possible. It closes client admission, cancels route
supervisors, deletes this client's secrets/cache/routes/preferences, and removes
the catalog entry after typed confirmation. It does not send or queue a remote
operation.

### WSL

Uninstall may remove BiBCode Server inside a reachable running distro after
confirmation. Purge may remove only the verified BiBCode data root. No action
calls `wsl --unregister` or deletes the distro.

## Telemetry Prohibition And Diagnostics

No runtime or build may add:

- Analytics SDKs/events.
- Usage counters sent off device.
- Installation/device fingerprints for reporting.
- Automated crash/minidump upload.
- Remote log drain or hosted observability endpoint.
- Hidden update “ping” parameters beyond ordinary artifact request metadata.

Allowed diagnostics are local health state, bounded redacted logs, and an
explicit user-initiated export to a chosen file. Export shows a manifest of
included data and excludes secrets, credentials, raw DPoP proofs, pairing codes,
cookies, unredacted command environments, and conversation content by default.

## Security Acceptance Criteria

- Packaged server startup rejects non-loopback HTTP/WS under every launch path.
- SSH and HTTPS routes verify host/certificate trust before consuming pairing.
- A changed host key, TLS pin, environment UUID, or storage UUID blocks.
- A pairing code expires, is single-use, rate-limited, unlogged, and DPoP-bound.
- Revocation closes active sessions and invalidates later tickets.
- Desktop persistent secrets use the required OS provider; unavailable provider
  produces session-only/fail-closed behavior.
- WSL enumeration presents all running distros and never starts/unregisters a
  stopped distro.
- SSH provisioning supports Linux, macOS, and Windows quoting/service paths and
  never installs without consent.
- Update/uninstall/purge are identity-verified, crash-safe, and process-reaping.
- Repository dependency/policy tests prove no telemetry or cloud relay SDK/path
  is present.
