# Server Administration

This guide administers the native `bibcode` server on the machine that owns an
environment. A paired network client is a full environment administrator, but
it is not a host administrator: service installation, restart, uninstall, and
package replacement must run through the desktop bridge, the protected local
control channel, or an explicit SSH/local shell on the server host.

## Safety rules

- Managed services listen on numeric loopback only.
- Direct non-loopback listeners require HTTPS. There is no insecure override.
- A new pairing is valid for five minutes and grants full administrator access;
  there are no permission levels yet.
- `service uninstall` preserves projects, repositories, worktrees, credentials,
  and the selected data root. It has no purge option.
- Native package removal also preserves the data root. Purge is a separate
  online plan and exact-confirmation command, never an installer checkbox.
- Never delete a data root, service account, socket, pipe, or process merely
  because its label looks familiar. Verify the exact service and environment
  identity first.

## Choose a runtime

| Choice              | Use it when                                          | Native mechanism                                               | Default data root                                                                                       |
| ------------------- | ---------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Foreground `serve`  | Testing, manual operation, or an external supervisor | Current terminal/process supervisor                            | `BIBCODE_HOME`, `--base-dir`, or `~/.bibcode`                                                           |
| Workstation service | The server belongs to the signed-in user             | Windows logon task, macOS LaunchAgent, Linux systemd user unit | `~/.bibcode` unless overridden                                                                          |
| Headless service    | The machine should run without an interactive login  | Windows Service, macOS LaunchDaemon, Linux systemd system unit | Windows `%ProgramData%\BiBCode`; macOS `/Library/Application Support/BiBCode`; Linux `/var/lib/bibcode` |

The service definition captures the absolute path of the current `bibcode`
binary. Install it in its intended permanent location before registering the
service. Use one explicit `--base-dir` consistently when the default is not
appropriate.

Managed services stay authenticated but never mint or print a startup pairing.
Create administrator access explicitly through the protected local-control
channel after startup. For a foreground or externally supervised server, pass
`--no-startup-pairing` (or set `BIBCODE_NO_STARTUP_PAIRING=1`) for the same
credential-free startup behavior. This flag is not an authentication bypass;
protected HTTP and WebSocket requests still require a valid session.

## Listener and connection choices

| Connection     | Server listener                                            | Client trust                                                    |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Same host      | `127.0.0.1`/`::1` HTTP                                     | Host-local boundary and normal BiBCode authentication           |
| WSL or SSH     | Remote loopback HTTP with a desktop/local loopback forward | SSH host/key policy, then verified environment/storage identity |
| Direct network | HTTPS/WSS                                                  | System certificate trust or an explicitly configured SPKI pin   |

Run a direct foreground HTTPS server with both TLS files:

```sh
bibcode serve \
  --host 0.0.0.0 \
  --tls-certificate-chain /absolute/path/server-chain.pem \
  --tls-private-key /absolute/path/server-key.pem \
  --static-dir /absolute/path/web-assets
```

Startup fails before durable initialization when the pair is incomplete,
unreadable, mismatched, expired, or not yet valid. Do not work around a trust
failure with HTTP. Install the correct CA in the system trust store or configure
the exact SPKI pin on that client route.

For an SSH-managed loopback server, a host administrator may verify the path
manually before using the desktop flow:

```sh
ssh -N -L 3773:127.0.0.1:3773 user@server.example
```

The server remains bound to remote loopback. The desktop-managed SSH route owns
its own forward and process cleanup; do not reuse this manual command as proof
that desktop provisioning succeeded.

## Create an administrator pairing

While the server is running, use a shell on that host:

```sh
bibcode auth pairing create \
  --client-label "Administrator laptop" \
  --format human \
  --base-dir /absolute/path/to/bibcode-data
```

Use `--format json` for one machine-readable document. The result contains the
raw credential and pairing URL exactly once, so treat all stdout as secret.
The command uses only the protected Unix socket or Windows named pipe and fails
when the selected root is wrong, the server is stopped, or peer authorization
fails. It never falls back to HTTP.

The client creates a DPoP key and exchanges the pairing for a key-bound
session. If the response is lost, retry with the same client key within the
receipt window. A different key or proofless retry is rejected. Revoke any
client you no longer trust; revocation closes its active socket.

## Common service commands

The command surface is identical on every supported host. `workstation` is the
default, but use the mode explicitly in automation:

```sh
bibcode service status --mode workstation --format json
bibcode service install --mode workstation
bibcode service start --mode workstation
bibcode service stop --mode workstation
bibcode service restart --mode workstation
bibcode service uninstall --mode workstation
```

Add `--base-dir /absolute/path` to every command when using a non-default root.
Add `--host 127.0.0.1 --port 3773` when selecting a different loopback endpoint.
Any non-loopback host is rejected before service-manager mutation.

An exact existing definition makes install idempotent. When status reports a
definition mismatch, inspect the binary, root, bind, mode, and account, then
replace it explicitly:

```sh
bibcode service install --mode workstation --update
```

`install --update` changes the service definition; it is not a standalone
binary package updater.

## Windows

Workstation mode creates the current user's `BiBCode` Task Scheduler logon task
with an interactive token and no stored password. Run in a normal PowerShell:

```powershell
bibcode service status --mode workstation --format json
bibcode service install --mode workstation
bibcode service start --mode workstation
bibcode service stop --mode workstation
bibcode service restart --mode workstation
bibcode service uninstall --mode workstation
```

Headless mode uses the Windows SCM and the virtual
`NT SERVICE\BiBCode` identity. Open an Administrator PowerShell:

```powershell
bibcode service status --mode headless --format json
bibcode service install --mode headless
bibcode service start --mode headless
bibcode service stop --mode headless
bibcode service restart --mode headless
bibcode service uninstall --mode headless
```

The protected control pipe rejects remote clients and admits only the effective
service account or an enabled Builtin Administrator token.

## macOS

Workstation mode creates `com.bibcode.server` as the current user's LaunchAgent.
Run without `sudo`:

```sh
bibcode service status --mode workstation --format json
bibcode service install --mode workstation
bibcode service start --mode workstation
bibcode service stop --mode workstation
bibcode service restart --mode workstation
bibcode service uninstall --mode workstation
```

Headless mode creates a LaunchDaemon using `_bibcode`. Run all matching commands
with root authority:

```sh
sudo bibcode service status --mode headless --format json
sudo bibcode service install --mode headless
sudo bibcode service start --mode headless
sudo bibcode service stop --mode headless
sudo bibcode service restart --mode headless
sudo bibcode service uninstall --mode headless
```

## Linux

Workstation mode creates `bibcode.service` in the current user's systemd
manager. Run without root:

```sh
bibcode service status --mode workstation --format json
bibcode service install --mode workstation
bibcode service start --mode workstation
bibcode service stop --mode workstation
bibcode service restart --mode workstation
bibcode service uninstall --mode workstation
```

Status reports whether linger is enabled. BiBCode never enables linger
silently; without it, the user service may stop when the login session ends.
Choose any linger policy outside BiBCode according to the host's security
policy.

Headless mode creates the system `bibcode.service` unit using the dedicated
`bibcode` account. Run with root authority:

```sh
sudo bibcode service status --mode headless --format json
sudo bibcode service install --mode headless
sudo bibcode service start --mode headless
sudo bibcode service stop --mode headless
sudo bibcode service restart --mode headless
sudo bibcode service uninstall --mode headless
```

## Stop, uninstall, and data preservation

Stop and restart first ask the protected local-control endpoint to close new
mutations, drain accepted work, and reap server-owned children. After the
bounded deadline, the native manager is the fallback. Check the command's
nonzero result rather than assuming a stop succeeded.

Uninstall removes service registration and reports:

- whether anything changed;
- whether an adapter-created account was removed; and
- `dataRootPreserved: true`.

It does not delete the data root and exposes no `--purge` flag. Deleting server
data is a separate destructive decision and is not part of service uninstall,
client Forget, or route removal.

### Explicit storage purge

First remove every project through the normal environment UI so existing Git
worktree and process guards run. With the server still online, create a
short-lived plan from a shell authorized to use its protected local-control
endpoint:

```sh
bibcode storage purge plan \
  --environment-name "Build Mac" \
  --base-dir /absolute/path/to/bibcode-data \
  --json
```

Read the returned environment ID, storage ID, canonical root, expiry, and
project, worktree, process, and paired-client counts. Other paired clients are
a warning; any project, worktree, or owned process blocks authorization. If the
identity, root, or counts are unexpected, stop and investigate.

Execute only the same fresh plan and type the displayed alias exactly:

```sh
bibcode storage purge execute \
  --plan-id <uuid-from-plan> \
  --confirm-environment-name "Build Mac" \
  --base-dir /absolute/path/to/bibcode-data \
  --json
```

Authorization closes mutation admission and asks the server to shut down. The
CLI then waits for the runtime lock, takes the store-operation lock, rechecks
the environment/storage markers and database guards, and deletes only that
canonical root. A stale plan, wrong case in the name, different root, running
server, new project/worktree, or identity mismatch fails closed. This action is
irreversible; backups inside the selected root are removed with it.

If the CLI is interrupted after the server acknowledges authorization, rerun
the same execute command. The durable authorization permits only the same plan
and exact typed name; it does not reopen planning while the server is offline.

For a desktop-managed SSH environment, **Disconnect** and **Forget** do not run
these service commands remotely. They close and reap local tunnels and remove
only that client's routes, secrets, bindings, caches, and presentation state.
The server registration, binary, projects, repositories, worktrees,
credentials, and data root remain on the remote host. The current UI has no
remote-uninstall action. Any future optional remote uninstall must first show
the exact host, mode, binary, service registration, and preserved data root,
then report its remote result separately from local removal.

If the destination is offline or remote cleanup fails, a force-local-removal
choice must ask again and state these consequences. Confirmation means only
"remove this client connection"; it must never be recorded as proof that the
remote service or data was removed.

The center removal workspace keeps these operations separate and shows the
exact consequences before confirmation. Offline force removal requires the
environment alias and an explicit unknown-remote-outcome acknowledgement; it
never schedules uninstall or purge for a later reconnect. See
[Environment navigation](./environment-navigation.md).

## Partial install and update recovery

On a fresh failed install, BiBCode rolls back only service files and accounts
created by that attempt. It will not delete a pre-existing account. If rollback
also fails, preserve the command output, inspect the exact native service by
its platform identity, and rerun `status`; do not recursively remove broad
system or data directories.

The public environment view reports a redacted update phase. Preparation closes
mutation admission, drains work, reaps owned children, creates a verified store
backup, and persists its operation, identities, versions, and bounded state.
After restart, a matching environment/storage identity and target version
becomes `succeeded`; interruption or mismatch becomes `recoveryRequired`.

Native package hooks drive the internal `package prepare`, `activate`, and
`rollback` transaction. Before file mutation, the old binary must persist the
verified backup and an identity-bound, nonce-hashed receipt, commit its update
handoff, and stop. Activation verifies the same environment/storage IDs,
target version, local-control protocol, loopback listener, web assets, and
native definition. If activation fails before a schema migration, the package
manager restores its exact byte snapshot and the old binary verifies its own
path/SHA-256 and the unchanged schema before starting. If the schema advanced,
old-binary rollback is forbidden. The rollback command removes the managed
registration so old bytes cannot auto-start. PKG/DEB/RPM restore the failed new
bytes; MSI may leave restored old package files but no runnable registration.
The verified backup/recovery state remains. On Windows, first retry the same
MSI so its bound transaction can finish; after verification a newer upgrade is
allowed. PKG/DEB/RPM reuse their retained private transaction on retry.

An interrupted package-manager retry reuses only a matching private
transaction, target version, owner, root, and opaque nonce. Mismatched or
incomplete recovery state fails closed instead of being overwritten. Internal
package command output is redacted to phase, service state, and version.

Do not invoke `package` commands manually or treat `service install --update`
as a binary updater. Safe in-place upgrade requires the already installed
package to contain this pre-install protocol. An older package without it
causes upgrade to abort before mutation. Preserve the existing data root,
uninstall only package/service files, install the new package, and let its
clean-install path adopt the existing root; verify identity before resuming
work.

## Troubleshooting checklist

1. Run `service status --format json` with the exact mode and data root.
2. Confirm the binary path still exists and the bind is numeric loopback.
3. Confirm `definitionMatches` before using start/restart.
4. On Linux workstation mode, record `lingerEnabled` without changing it
   silently.
5. For direct access, verify certificate dates, hostname, chain, and system
   trust or the exact pin. Never use plaintext as a diagnostic shortcut.
6. For pairing, check the selected data root, server state, five-minute expiry,
   client clock, and DPoP URL/method.
7. For `recoveryRequired`, preserve the package transaction directory, update
   status, failed/new bytes, and verified backup; do not start an older binary
   if the schema version differs from the receipt.
8. Verify no server-owned child process remains after stop before force-removing
   an exact native registration.

See [Environment navigation](./environment-navigation.md),
[Remote access](./remote-access.md),
[Authentication architecture](../architecture/authentication.md), and
[Runtime and process model](../architecture/runtime-process-model.md).
