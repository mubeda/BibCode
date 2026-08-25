# Runtime and Process Model

One BiBCode server process represents one execution environment. It owns the
environment and storage identities, database, project/thread state, provider
runtimes, terminals, Git work, transport admission, and every child process it
starts. A client route changes how that environment is reached; it does not
create a second owner.

## Runtime topology

| Runtime             | Host                                             | Listener                                                                   | Lifecycle owner                                                      |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Desktop             | Tauri starts the Rust server in-process          | Numeric loopback                                                           | Tauri desktop bridge and protected local control                     |
| Desktop WSL         | Tauri starts one Linux server per Running distro | Distro numeric loopback behind a distinct Windows numeric-loopback forward | Tauri backend supervisor plus supervised per-connection WSL children |
| Foreground web      | `bibcode start` or `bibcode serve`               | Loopback HTTP or direct HTTPS                                              | Invoking terminal/service supervisor and protected local control     |
| Workstation service | Current interactive user                         | Loopback HTTP                                                              | User Task Scheduler, LaunchAgent, or systemd user manager            |
| Headless service    | Dedicated service identity                       | Loopback HTTP                                                              | Windows SCM, LaunchDaemon, or systemd system manager                 |

Managed services never bind directly to a network interface. Remote access
reaches their loopback listener through SSH forwarding or a separately trusted
HTTPS terminator. A foreground server may use a direct HTTPS listener when it
has a validated certificate/private-key pair.

Managed services and desktop/SSH-managed launches keep authentication enabled
while suppressing reveal-once startup pairing output. A foreground supervisor
may select the same behavior with `serve --no-startup-pairing`; later pairing
must cross protected local control or the verified native SSH administration
flow.

For WSL, the desktop starts the Windows loopback listener before the distro
server, publishes it only after generation-fenced readiness, and keeps it alive
for authenticated soft shutdown. It then cancels the listener, joins active
forwards, and reaps the WSL server. Unexpected listener or server exit cleans
up its peer before the existing bounded restart policy runs. Per-connection
`wsl.exe` processes use Windows Job ownership and are never allowed to outlive
their accepted socket or the desktop-owned listener.

The Tauri host also owns WSL runtime provisioning. It probes only an already
Running distribution, verifies an exact signed portable artifact on Windows,
streams it to private per-user staging, verifies its hash again in WSL, and
atomically switches the managed `current` symlink. The old version stays
rollback-capable until the replacement process has returned a matching
loopback environment descriptor. Setup cancellation shuts down and joins its
child plus I/O tasks before the per-distribution concurrency slot is released;
desktop shutdown cancels every active or prepared setup.

## Service definitions

The platform-neutral service model records mode, state, startup owner, account,
binary path, data root, loopback bind, control endpoint, enablement, definition
match, and Linux linger status.

| Platform | Workstation                                                                 | Headless                                             |
| -------- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| Windows  | Per-user `BiBCode` logon task with interactive token and no stored password | `BiBCode` Windows Service using `NT SERVICE\BiBCode` |
| macOS    | `com.bibcode.server` LaunchAgent                                            | `com.bibcode.server` LaunchDaemon using `_bibcode`   |
| Linux    | `bibcode.service` systemd user unit                                         | `bibcode.service` system unit using `bibcode`        |

Exact matching installs are idempotent. A different installed definition fails
until the administrator uses `service install --update`. A fresh partial
install rolls back only artifacts and accounts created by that attempt. A
pre-existing service account is never deleted as rollback collateral.

Linux workstation status reports linger. BiBCode does not silently enable it;
the host administrator owns the policy for running user services after logout.

## Admission, children, and shutdown

The RPC admission gate distinguishes reads from mutations. Drain closes new
mutations, waits for admitted work within a deadline, and then reaps
server-owned terminals and provider/process roots. Unix uses retained process
group ownership; Windows uses retained process and Job ownership. Cancellation,
natural leader exit, and late descendants keep one bounded wait/reap owner.

Shutdown ordering is:

1. close new network and local-control admission;
2. acknowledge an accepted host-local stop/update request;
3. drain admitted mutations within the configured bound;
4. cancel and wait for server-owned child roots;
5. join transport/control tasks; and
6. release the database and store guard.

Independent runtimes must not signal, wait, or reap one another's process
roots. Force-stopping a native service manager is a bounded fallback after the
local-control drain attempt, not the normal first step.

## Update handoff

Update preparation persists a versioned `server-update.json` record atomically
under the selected state directory. The durable phases are `preparing`,
`prepared`, `restarting`, `succeeded`, `failed`, `cancelled`, `expired`, and
`recoveryRequired`.

Preparation validates the requested target version, closes mutation admission,
drains work, reaps children, creates a verified store backup, and returns an
operation ID and lease. Commit records `restarting` before shutdown. On startup,
the server verifies the same environment ID, storage-instance ID, and expected
version. A match becomes `succeeded`; an interrupted handoff, identity change,
or version mismatch becomes `recoveryRequired`.

Replacement package bytes and restoration of the prior service definition are
one signed distribution transaction owned by the server installer/updater.
They must not be duplicated inside the runtime maintenance module. Until that
distribution transaction is available, update preparation is not a standalone
server package installer.

## Network-visible service state

`server.getConfig` exposes only the service mode, startup mechanism, running
state, version, bind posture, account kind, update phase/result, and the
available host-authority channels. It omits native control endpoints,
credentials, environment variables, and sensitive host paths.

Network host actions always fail closed with `hostAuthorityRequired`.
Workstation/server administration must cross the desktop bridge, protected
local control, or an explicit SSH host-administration session.

See [Server administration](../user/server-administration.md),
[Authentication architecture](./authentication.md), and
[Cross-platform validation](../testing/cross-platform-validation.md).
