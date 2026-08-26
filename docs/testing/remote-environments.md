# Remote Environment Validation

Use this runbook for WSL discovery/setup and desktop-managed SSH enrollment.
Read [Cross-platform validation](./cross-platform-validation.md) and the native
[Windows](./windows-desktop.md), [Linux](./linux-desktop.md), or
[macOS](./macos-desktop.md) page first. Record results in the
[execution report](./execution-report-template.md).

This is a native integration runbook. Host-independent contracts prove schema,
ordering, and failure behavior, but they do not prove `wsl.exe`, OpenSSH,
PowerShell, launchd, systemd, Windows services, sockets, Jobs, or process groups
on another operating system.

## Safety boundary

- Use disposable distributions, SSH targets, service registrations, data roots,
  repositories, projects, and credentials.
- Never change system SSH trust, install a service, elevate, start a stopped WSL
  distro, or remove a remote environment without explicit authority.
- BiBCode must never invoke `wsl --unregister`,
  `StrictHostKeyChecking=no`, a private empty `known_hosts`, or a plaintext
  non-loopback listener.
- Do not record passwords, private keys, pairing credentials, access tokens,
  raw secret-provider values, or unbounded command output.
- Resolve exact PID/process-group/Job, service, distro, path, environment UUID,
  and storage UUID ownership before cleanup.

## Source and focused-contract preflight

Verify the current contracts and owners before native work:

```sh
vp test packages/contracts/src/ipc.test.ts packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/platform/storageDocument.test.ts apps/web/src/tauriDesktopBridge.test.ts apps/web/src/connection/desktopLocal.test.ts apps/web/src/connection/platform.test.ts apps/web/src/connection/storage.test.ts apps/web/src/state/desktopWslState.test.ts
cargo test -p bibcode-desktop remote_host:: --lib -- --nocapture
cargo test -p bibcode-desktop remote_operation::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop server_artifacts::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop wsl:: --lib -- --nocapture
cargo test -p bibcode-desktop wsl_setup:: --lib -- --nocapture
cargo test -p bibcode-desktop ssh::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop --test bridge_public_contract -- --nocapture
cargo test -p bibcode-desktop --test ssh_public_contract -- --nocapture
```

On Windows, prefix Rust commands with
`node scripts/run-msvc-x64.mjs`. Run broad Cargo owners sequentially.

## Required native matrix

| Desktop host          | Target            | Required evidence                                                                                                           |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Windows               | Real WSL 2 distro | UTF/state discovery, visibility, consent, signed install, loopback forward, identity, cancellation, reaping                 |
| Windows               | Windows OpenSSH   | PowerShell probe/install/service, tunnel, identity, pairing, cancellation, recovery                                         |
| Any supported desktop | Linux OpenSSH     | POSIX probe/install, workstation and authorized headless modes, tunnel, identity, pairing, cancellation, recovery           |
| Any supported desktop | macOS OpenSSH     | POSIX/macOS probe/install, LaunchAgent and authorized LaunchDaemon modes, tunnel, identity, pairing, cancellation, recovery |

Use a real host for each named target. An unavailable row remains unavailable
evidence; do not substitute a parser fixture and call it native.

## WSL discovery and visibility

On native Windows, capture without changing state:

```powershell
wsl.exe --status
wsl.exe --list --verbose
```

Include distro names containing spaces and non-ASCII characters when a
disposable fixture is available. Compare BiBCode's structured snapshot with
`wsl.exe --list --verbose` and record the default marker, WSL version, exact
Running/Stopped state, discovery generation, health, and observation time.

Prove all of these presentation rules:

1. every Running distro appears;
2. a Running distro without a compatible server appears as **Setup required**;
3. an accepted Stopped distro remains in the environment hierarchy as
   stopped/unavailable;
4. an unaccepted stopped distro appears only in **Add Environment**;
5. no observation or setup action automatically starts a stopped distro;
6. a failed or timed-out refresh retains accepted bindings and last verified
   identities;
7. focus/manual refresh coalesces, native events update immediately, and the
   five-minute timer is only a missed-event safety wakeup; and
8. source and process evidence contain no WSL unregister operation.

Rename an accepted disposable distro without changing its server store and
prove the descriptor UUIDs move the binding without duplicating the environment.
Then present the old locator with a different environment or storage UUID and
prove BiBCode blocks it as an identity conflict. A stale generation and a failed
read must not replace, forget, or auto-adopt either identity.

## WSL setup and forwarding

Select an already Running disposable distro. Record the probe generation,
Linux architecture, home/data root, current version, `tar` availability, free
space, desired version, signed manifest tuple, exact size, per-user destination,
and bounded command summaries. Decline once and prove no mutation. Accept a new
one-use consent and prove replay and concurrent same-distro setup are rejected.

Exercise wrong architecture, manifest/artifact signature, byte size, SHA-256,
missing `tar`, and insufficient-space failures. A successful flow must verify
on Windows, transfer with bounded memory, verify again inside WSL, stage under
`$HOME/.local/share/bibcode/server/versions`, atomically change `current`, and
retain the previous target until a matching descriptor is returned.

Cancel separately during download/transfer, atomic install, backend restart,
and descriptor streaming. Record the exact terminal state (`cancelled`, not
`failed`), previous-target restoration, staging cleanup, joined child/I/O work,
and absence of stale progress in the next generation. Hold rollback at a test
barrier during desktop exit and prove shutdown waits for it.

Inspect both listeners and the child command. The Linux server and Windows
forward must bind distinct numeric `127.0.0.1` ports. Each accepted connection
uses structured `wsl.exe --distribution ... --exec ... transport
stdio-forward`; no WSL IP, wildcard bind, or shell-interpolated distro/path is
allowed. Leave an upgraded/WebSocket stream idle and prove the forward does not
apply the setup deadline to the established stream.

Finally prove the managed `current` binary wins ordinary selection while
`BIBCODE_WSL_SERVER_BINARY` and the cross-compiled worktree paths still support
explicit development workflows when no managed runtime is available.

## SSH trust and probe

For each Linux, macOS, and Windows OpenSSH target, record the desktop OpenSSH
version, effective `ssh -G` target, alias, host, port, username, configuration
source, authentication kind, and non-secret SHA-256 host-key fingerprint.

Prove known-key success and separate failures for unknown, changed/revoked, and
saved-pin-mismatched keys. A changed key blocks before password/userauth and
before any launch, stop, or pairing script byte is sent. A configured custom
`KnownHostsCommand` fails closed. The BiBCode destination checker compares
OpenSSH `%f`, emits no key, and does not weaken normal user/system
`known_hosts`. Reject internal-variable-matching `SendEnv` patterns. Test
ProxyJump/ProxyCommand with key or agent authentication and prove password
fallback is rejected before prompting.

The bounded probe must report only OS, architecture, installed version,
workstation/headless service mode and state, data root, protected control,
free bytes, and install authority. Test x86-64 and ARM64 normalization where the
native target supports them. Reject unsupported OS/architecture, insufficient
space/authority, malformed output, and incompatible service definitions.

## SSH consent, install, and pairing order

For compatible servers, skip mutation and continue to the tunnel. Otherwise,
show one-use consent with the exact target, signed portable artifact,
destination, data root, workstation/headless mode, and commands. Decline and
replay must not mutate the host.

Prove this order:

```text
OpenSSH trust -> bounded probe -> explicit consent -> local signed download
-> local signature/checksum/size verification -> bounded SSH transfer
-> remote checksum/size verification -> private extraction -> atomic promotion
-> requested loopback service -> local loopback tunnel -> bounded descriptor
-> environment/storage/protocol verification -> native pairing create
-> native pairing redeem -> OS-secret persistence -> route publication
```

The remote host must not download the artifact or require Node.js, npm, npx, or
a package manager. Exercise workstation and, only with explicit elevation,
headless service modes on all three target operating systems. Linux/macOS use
portable archives and Windows uses a private ZIP extraction; administrator-owned
headless staging must be reverified after the privileged copy.

Close the forwarding listener after descriptor verification and prove pairing
redeems through the already retained stream. A replacement listener must never
receive the raw one-time credential. Reject redirects, system/environment proxy
redirection, wildcard/nonnumeric endpoints, descriptor oversize/malformed data,
and environment, storage, protocol, platform, version, or saved-pin mismatch
before route publication.

## Cancellation, recovery, and removal

Cancel exact operation IDs during password presentation, artifact resolution,
transfer, install, service start, tunnel readiness, descriptor verification,
and pairing. Replace an operation with a newer environment/route generation and
Forget while the older owner is paused. Acknowledgement must follow drain;
rollback uses an independent bound without another password prompt; no late
completion may publish a route. Record stage, mutation status, cleanup status,
previous version, and the exact quoted recovery/status command after partial
mutation.

Ordinary **Disconnect** and **Forget** are local-only. Prove they close
admission, cancel/drain owners, reap the local tunnel, clear local
authentication, and leave the remote service/data untouched. Then use a
disposable BiBCode-managed portable install to prove the separate online flow:

1. an unpinned SSH route, Direct HTTPS route, stale WSL discovery generation,
   wrong environment/storage identity, changed root, or expired plan fails
   before host mutation;
2. uninstall closes the local tunnel, removes the managed service/binary, proves
   the exact data root still exists, and only then permits local Forget;
3. purge is disabled while any project, worktree, or process count is nonzero,
   rejects wrong-case confirmation, and after guards clear removes only the
   approved root before local Forget;
4. a native MSI/PKG/DEB/RPM probe displays the OS-uninstaller limitation and
   runs no partial remote cleanup; and
5. any failed or unverifiable remote step retains the local catalog for retry.

If the host is offline or cleanup is unproved, force local removal must ask
again and warn that the remote service, projects, worktrees, credentials, and
data may remain. Never record force removal as remote cleanup success or queue
it for reconnect.

## Environment-owned project and worktree checks

On each native, WSL, and SSH environment, use disposable roots to:

1. pick a folder through that environment's own filesystem surface;
2. add a repository and receive one Project plus Main;
3. add its primary path and a linked worktree again and receive the existing
   Project/Main rather than a duplicate;
4. add an independent clone in the same environment and receive another
   project;
5. add the same repository family on another environment and keep it independent;
6. discover, adopt, hide, retarget, detach, and remove disposable worktrees with
   current worktree behavior unchanged; and
7. restart/reconnect and prove environment, project, Main, thread, repository
   claim, and physical worktree identity persist.

No filesystem, Git, terminal, or provider action may fall back to the desktop
host when the selected workspace belongs to WSL or SSH.

## Final network and process evidence

Inspect listener ownership and prove every plaintext listener is numeric
loopback. Search source and captured commands for `StrictHostKeyChecking=no`,
private empty `UserKnownHostsFile`, `wsl --unregister`, WSL-IP discovery,
wildcard plaintext binds, remote artifact downloads, telemetry, and unexpected
internet requests. Expected signed-artifact download occurs on the desktop; the
remote host receives only the verified transfer.

Run WSL and each Linux, macOS, and Windows SSH row through the shared
deny-by-default outbound harness. Cold startup, pairing, ordinary use,
diagnostics export, and intentional crash handling may contact only the
selected loopback/SSH/HTTPS environment endpoint; invoke and allow the updater
separately. Record zero unexpected destinations and the initiating process for
every permitted request.

Capture and revalidate every run-owned desktop, server, WSL, SSH, askpass,
tunnel, provider, terminal, and service process using the native identity fields
in [Process lifecycle](./process-lifecycle.md). Final shutdown must leave zero
run-owned survivors while unrelated WSL and SSH processes remain alive.
