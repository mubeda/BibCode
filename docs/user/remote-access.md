# Remote Access

Remote access connects a browser or another desktop app to the BiBCode server
running on a different machine. That server owns projects, files, Git state,
terminals, provider CLIs, credentials, and agent sessions.

Plain HTTP/WebSocket is restricted to loopback. This rule also applies on a
trusted LAN or tailnet: BiBCode has no packaged switch or override that binds an
unencrypted server to another interface.

For service installation, host authority, local-control pairing, and recovery,
use [Server administration](../operations/server-administration.md).

## Supported routes

- **Same machine:** loopback HTTP/WebSocket.
- **WSL or SSH:** a desktop-owned loopback forwarder to the server's remote
  loopback listener.
- **Direct network:** HTTPS/WSS with a valid certificate and private key.
- **Tailscale:** a MagicDNS HTTPS endpoint provided by Tailscale Serve in front
  of the loopback backend.

The desktop's **Remote transport** setting explains this boundary and does not
offer a plaintext LAN toggle. Pairing links are presented for an available
secure route; legacy LAN and Tailnet-IP HTTP candidates are ignored.

### Tailscale HTTPS

When the desktop app can read `tailscale status --json`, it can discover the
machine's MagicDNS name. Raw Tailnet IPv4 HTTP endpoints are not advertised.

An HTTPS MagicDNS endpoint is shown as available only after its well-known
BiBCode endpoint responds successfully. Configure Tailscale Serve separately to
proxy the chosen HTTPS address to the local BiBCode backend, then let the desktop
app rescan it. The native `bibcode` CLI does not currently provide Tailscale
Serve setup flags.

## Headless server

`bibcode start` and `bibcode serve` run the same native server. `start` opens the
startup URL in a browser by default; `serve` does not.

For example, bind with TLS and serve built web assets:

```bash
bibcode serve \
  --host 0.0.0.0 \
  --tls-certificate-chain /etc/bibcode/server-chain.pem \
  --tls-private-key /etc/bibcode/server-key.pem \
  --static-dir /path/to/BibCode/apps/web/dist
```

The certificate and key flags are an atomic pair. Startup fails before durable
server initialization if either file is missing, unusable, mismatched, expired,
or not yet valid. A non-loopback bind without this pair is rejected; there is no
insecure override.

The client must validate that listener through its operating-system trust store
or an explicitly accepted SPKI SHA-256 pin. The environment descriptor's
fingerprint is diagnostic metadata and is not a trust bypass. Do not switch to
HTTP to diagnose a certificate problem.

The server prints one JSON object to stdout. In authenticated web mode it has
this shape:

```json
{
  "address": "100.64.0.10:3773",
  "httpBaseUrl": "https://server.example:3773",
  "token": "one-time-pairing-credential",
  "pairingUrl": "https://server.example:3773/pair#token=one-time-pairing-credential"
}
```

`httpBaseUrl` is the existing output key; its value uses `https://` for a TLS
listener.

The CLI does not print a QR code. It has no `project` subcommand, positional
working-directory argument, or `--tailscale-serve` flags. Its `auth` command is
limited to host-local pairing issuance through the protected control endpoint;
it is not a network administration API. Use `bibcode --help` for the
implemented options.

`--static-dir` is needed only when this server should deliver the web client.
A separately hosted HTTPS web app can connect directly to an HTTPS/WSS backend
without the backend serving static files.

### Managed workstation or headless service

For a server that should survive the invoking terminal, register the native
loopback-only service instead of backgrounding `serve` manually:

```bash
bibcode service install --mode workstation
bibcode service status --mode workstation --format json
```

Use `--mode headless` with elevated host authority for a machine service.
Windows uses Task Scheduler or SCM, macOS uses a LaunchAgent or LaunchDaemon,
and Linux uses a systemd user or system unit. Stop/restart first drain through
protected local control. Uninstall preserves the data root and has no purge
option. Exact commands and platform accounts are in
[Server administration](../operations/server-administration.md).

## Pairing

By default, foreground authenticated web startup issues an owner pairing
credential. `serve --no-startup-pairing` and
`BIBCODE_NO_STARTUP_PAIRING=1` suppress it without disabling authentication;
managed services and desktop/SSH-managed launches always suppress it. Create
access later through `bibcode auth pairing create` on the server host. When a
startup pairing is issued, its credential is carried in the URL fragment so it
is not sent as part of the initial HTTP request:

```text
https://server.example:3773/pair#token=PAIRING_CREDENTIAL
```

The client generates a DPoP key and exchanges the credential with a fresh proof
for the exact token endpoint. The resulting session is bound to that key. Treat
the credential and pairing URL as passwords until the exchange completes.

For a configured hosted web app, use a URL shaped like:

```text
https://app.example.com/pair?host=https://backend.example.com#token=PAIRING_CREDENTIAL
```

The hosted app saves the backend address, but it does not proxy traffic. The
browser still connects directly to the backend, which must therefore be
reachable over HTTPS/WSS from that browser.

While the server is running, an authorized user on that server host can create
another five-minute administrator pairing in a separate terminal:

```bash
bibcode auth pairing create \
  --client-label "Administrator laptop" \
  --format human \
  --base-dir /absolute/path/to/bibcode-data
```

Omit `--base-dir` to use the same `BIBCODE_HOME`/default-root selection as
`serve`; use `--format json` for one machine-readable document. The command
reads the durable environment identity and uses only the protected Unix socket
or Windows named pipe. It does not try the HTTP pairing endpoint when the
server is stopped or the selected root is wrong. Human output prints the secret
only inside the URL fragment. JSON includes the explicitly documented
`credential` and `pairingUrl` fields, so treat the entire stdout document as a
secret.

The issued session is a full environment administrator for the current
feature: permission levels are not user-selectable, and a paired client can
operate projects and terminals and administer other client access. In the
browser/hosted UI, the environment's center **Security** tab shows this warning
before creation. The raw value is shown once in the creation result so it can be
copied; closing that result permanently leaves only a fingerprint, label, and
expiry. BiBCode stores a SHA-256 hash rather than a recoverable pairing value.

If the exchange response is lost, retry with the same DPoP key within five
minutes to recover the same logical session. Retrying with a different key or
without DPoP is rejected. WebSocket tickets are also one-use, and revoking a
client closes its active socket rather than waiting for its next request.

## Desktop-managed SSH

The desktop uses the local OpenSSH client to enroll Linux, macOS, and Windows
hosts, reuse or install a native BiBCode server, keep that server on remote
loopback, and expose it through a desktop-owned numeric-loopback tunnel. The
desktop machine needs `ssh` and its normal OpenSSH configuration. The remote
machine needs a reachable OpenSSH server, enough staging space, and the shell or
PowerShell capabilities reported by the probe. Provider CLIs and their
credentials remain installed on that remote environment.

The bounded, non-secret probe reports the operating system, architecture,
installed BiBCode version, selected workstation/headless service mode and
state, data root, protected-control availability, free bytes, and whether
installation has user, noninteractive-administrator, or
administrator-required authority. A compatible installation is reused. Setup
uses a portable package and transfers it from the desktop, so the remote host
does not need internet access, Node.js, npm, npx, or a package manager.

The desktop engine preserves the user's OpenSSH configuration and
`known_hosts` policy, distinguishes an unknown key from a changed key, records
the successfully observed fingerprint, establishes a numeric-loopback forward,
and verifies the environment UUID, storage UUID, and protocol before pairing.
The native host opens one retained TCP stream through the verified tunnel,
refetches the exact descriptor on that stream, then creates and redeems the
pairing over the same connection. A tunnel exit or local forwarding-port reuse
therefore fails rather than sending the raw one-time value to a replacement
listener, and the pairing value never enters the web UI. The resulting
administrator session is stored through the OS secret provider before the
normalized route is published.

BiBCode resolves the effective target configuration with bounded `ssh -G`
before password-capable work. It keeps normal user/system `known_hosts`
authoritative and adds a no-key-emitting destination checker that compares
OpenSSH's SHA-256 fingerprint before user authentication. A configured custom
`KnownHostsCommand` is not composable safely and is rejected with guidance; use
ordinary `UserKnownHostsFile`/system host-key policy for this target. Broad or
matching `SendEnv` rules that could forward BiBCode's private password or
host-key control variables are also rejected. Narrow `SendEnv` to unrelated
values such as locale variables before retrying.

ProxyJump and ProxyCommand targets work only when the entire chain can use SSH
keys or an agent. BiBCode does not ask for or reuse a destination password on a
proxied route because the proxy process would inherit the password helper.
Direct, non-proxied SSH targets may still use the desktop password prompt.

An unknown host key requires the user to verify and accept the host through
their normal OpenSSH workflow. A changed or revoked host key is a security
event: stop, verify the remote host and expected key through a separate trusted
channel, and update `known_hosts` only after that verification. BiBCode offers
no bypass. A saved route also rejects a fingerprint that differs from the one
accepted during enrollment.

Desktop **Add environment > SSH** supports Linux, macOS, and Windows OpenSSH
targets on x86-64 and ARM64. After host-key verification, BiBCode probes only
the OS, architecture, free space, supported installers, managed service state,
and noninteractive install authority. If the exact server version and requested
service mode are not already healthy, the UI must show a one-use consent screen
with the target, signed artifact, destination, data root, service mode, and
commands before any download or remote mutation.

The desktop downloads the exact signed release artifact, verifies its signature
and checksum locally, transfers it through SSH, and verifies checksum and byte
count again on the host. Linux/macOS portable archives and Windows ZIP archives
are extracted privately and promoted atomically. Headless setup requires
noninteractive administrator authority and uses a portable artifact so a native
package cannot silently create a workstation service. It installs beneath the
platform system root (`/opt/bibcode/server`, `/Library/Application Support/BiBCode
Server`, or `ProgramData\\BiBCode\\Server`) and rechecks the signed hash and byte
count after copying into administrator-owned staging. Non-administrators cannot
replace the promoted server files. No remote internet access, Node.js, npm, npx,
or package-manager fallback is used. The installed server listens only on remote
loopback and the desktop exposes it only through its own numeric-loopback SSH
tunnel.

If setup stops after mutation, BiBCode reports the exact stage, whether mutation
was partial, whether cleanup completed, the preserved previous version, and a
quoted service-status command bound to the relevant managed binary, service
mode, port, and data root. A pre-v3 SSH entry without a saved host-key pin can
be removed locally, but BiBCode will not guess a pin or run a remote stop;
re-enroll it before remote administration.

**Disconnect** and ordinary **Forget** are local operations: they drain the
owned SSH work, close the tunnel, remove local authorization and catalog state,
and leave the remote service and data unchanged. The center removal workspace
can separately preview and run remote uninstall or purge while the SSH route is
online and its saved SHA-256 host-key pin still matches. Uninstall is optional
and preserves the data root; purge requires an exact-name plan and zero owned
projects, worktrees, or processes. Only the BiBCode-managed portable layout can
be removed this way. Use the OS uninstaller for a native package. When the host
is offline or remote cleanup cannot be proved, force local removal explicitly
warns that the server, projects, worktrees, credentials, and data may still be
present on the remote machine.

Use the environment's center removal workspace for these choices. Offline
force removal requires the exact alias plus an explicit unknown-outcome
acknowledgement and never queues remote cleanup. See
[Environment navigation](./environment-navigation.md) for the complete UI and
consequence model.

## Windows Subsystem for Linux

The optional WSL backend runs a native Linux `bibcode` binary. It does not invoke
WSL Node.js, npm, npx, or a JavaScript server package.

Prerequisites:

- Windows Subsystem for Linux and an installed distribution;
- `wsl.exe` available to the desktop process;
- a distribution that is already Running, with `tar` and sufficient free
  per-user disk space;
- access to the signed BiBCode Server release manifest over HTTPS; and
- provider CLIs and credentials installed inside the distribution.

Every Running distro is shown. If it does not yet have a compatible server it
is labeled **Setup required** and remains unchanged until you accept the exact
one-use setup prompt. A distro you have already accepted remains in the
environment list when it is Stopped, with a stopped/unavailable status. A
stopped distro you have never accepted appears only in **Add Environment**; start
it yourself before setup. BiBCode does not start stopped distros automatically
and never invokes `wsl --unregister`.

BiBCode never starts a stopped distribution merely to inspect or install it.
For an absent or mismatched managed server, the desktop first shows the exact
target version/architecture, verified artifact source and size, install and
data locations, process behavior, and command summaries. Nothing changes until
you accept that one-use prompt. The app verifies the signed manifest and
artifact on Windows, streams the package to WSL, verifies its hash again, and
atomically switches the per-user managed runtime at
`$HOME/.local/share/bibcode/server/current`.

The previous version remains available until the restarted server proves its
version, Linux architecture, supported protocol, environment/storage UUIDs,
and loopback-only transport. Cancelling or failing any later step restores the
previous version and reports whether cleanup completed. Setup does not modify
the distribution's system packages, system service manager, provider
credentials, projects, worktrees, or data root.

For source development and existing worktree workflows, the desktop still
searches
`target/x86_64-unknown-linux-gnu/(debug|release)/bibcode` and
`target/aarch64-unknown-linux-gnu/(debug|release)/bibcode`. Set
`BIBCODE_WSL_SERVER_BINARY` to a different Windows-side binary path when needed;
the desktop translates it with `wslpath` for the selected distribution. A
verified managed `current` runtime takes precedence over these development
fallbacks.

The WSL launcher uses a fixed system `PATH` and starts `bibcode serve` on
`127.0.0.1` inside the distribution. The desktop exposes a different
`127.0.0.1` port on Windows and forwards raw HTTP/WebSocket bytes through
short-lived, supervised `wsl.exe` children. It does not discover a WSL IP,
publish a wildcard listener, or offer an HTTP privacy override. Verify a custom
binary from Windows with:

```powershell
wsl.exe --distribution <distribution> --exec /path/to/bibcode --version
```

Refresh is event-driven after startup and after WSL topology changes. Focus and
manual refresh are coalesced, with a five-minute safety refresh for a missed
event. A failed refresh retains previously accepted environments and does not
silently treat a renamed distro or replacement UUID as the old server. A
verified rename follows the server identity; an identity conflict is blocked
for explicit recovery.

When **WSL only** is enabled, a missing distribution, binary, or failed WSL
startup leaves the local backend unavailable; the desktop does not silently
start the Windows backend. In **Settings → Environments**, open the WSL
environment's center **Platform** tab to choose another distribution or retry
after correcting the prerequisite. Use its **Diagnostics** tab to save
diagnostic logs. **Switch to Windows** is the explicit way to make the native
Windows backend primary; the normal restart and storage identity checks then
apply.

## Security notes

- Plain HTTP/WebSocket is loopback-only. Use HTTPS/WSS for every direct network
  listener, including private networks.
- Verify the certificate through system trust or an explicitly accepted pin;
  descriptor fingerprint metadata is not itself a trust decision.
- A `hostAuthorityRequired` response from a network session is expected for
  service/update mutations; run those operations on the host or through SSH.
- Treat pairing URLs and credentials as secrets.
- Copy a newly created pairing credential before closing its reveal-once
  result; BiBCode cannot display it again.
- In the browser/hosted UI, review and revoke sessions you no longer trust from
  the environment's center **Security** tab.
- Credentials can leak through browser history, screenshots, logs, or copied
  text even when they are placed in a URL fragment.
