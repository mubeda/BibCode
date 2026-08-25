# Remote Access

Remote access connects a browser or another desktop app to the BiBCode server
running on a different machine. That server owns projects, files, Git state,
terminals, provider CLIs, credentials, and agent sessions.

Plain HTTP/WebSocket is restricted to loopback. This rule also applies on a
trusted LAN or tailnet: BiBCode has no packaged switch or override that binds an
unencrypted server to another interface.

For service installation, host authority, local-control pairing, and recovery,
use [Server administration](./server-administration.md).

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
[Server administration](./server-administration.md).

## Pairing

On startup in authenticated web mode, the server issues an owner pairing
credential. The credential is carried in the URL fragment so it is not sent as
part of the initial HTTP request:

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
browser/hosted UI, **Settings → Connections** shows this warning before
creation. The raw value is shown once in the creation result so it can be
copied; closing that result permanently leaves only a fingerprint, label, and
expiry. BiBCode stores a SHA-256 hash rather than a recoverable pairing value.

If the exchange response is lost, retry with the same DPoP key within five
minutes to recover the same logical session. Retrying with a different key or
without DPoP is rejected. WebSocket tickets are also one-use, and revoking a
client closes its active socket rather than waiting for its next request.

## Browser/hosted and future re-enabled desktop-managed SSH status

The desktop contains an SSH launcher that can install a small runner under
`~/.bibcode-ssh-launch/<state-key>`, start or reuse `bibcode serve` on remote
loopback, and create a local port forward. The remote host must provide:

- a compatible native `bibcode` executable on non-interactive `sh`'s `PATH`;
- `curl` or `wget` for the readiness probe; and
- each provider CLI and its credentials.

The native pairing command now exists, but end-to-end setup of a new SSH
environment remains unavailable until the desktop provisioning and
loopback-forwarding work described in the current environment-management plan
lands. Do not rely on the SSH **Add environment** flow yet.

The launcher does not install Node.js, npm, npx, package-manager shims, or a
BiBCode binary on the remote host.

## Windows Subsystem for Linux

The optional WSL backend runs a native Linux `bibcode` binary. It does not invoke
WSL Node.js, npm, npx, or a JavaScript server package.

Prerequisites:

- Windows Subsystem for Linux and an installed distribution;
- `wsl.exe` available to the desktop process;
- a `bibcode` Linux binary matching the distribution architecture; and
- provider CLIs and credentials installed inside the distribution.

For source development, the desktop searches
`target/x86_64-unknown-linux-gnu/(debug|release)/bibcode` and
`target/aarch64-unknown-linux-gnu/(debug|release)/bibcode`. Set
`BIBCODE_WSL_SERVER_BINARY` to a different Windows-side binary path when needed;
the desktop translates it with `wslpath` for the selected distribution.

The WSL launcher uses a fixed system `PATH` and starts `bibcode serve` on
`127.0.0.1` inside the distribution. The desktop exposes a different
`127.0.0.1` port on Windows and forwards raw HTTP/WebSocket bytes through
short-lived, supervised `wsl.exe` children. It does not discover a WSL IP,
publish a wildcard listener, or offer an HTTP privacy override. Verify a custom
binary from Windows with:

```powershell
wsl.exe --distribution <distribution> --exec /path/to/bibcode --version
```

When **WSL only** is enabled, a missing distribution, binary, or failed WSL
startup leaves the local backend unavailable; the desktop does not silently
start the Windows backend. In **Settings → Local environment**, choose another
distribution or **Retry WSL** after correcting the prerequisite. Use
**Diagnostics** to save diagnostic logs. **Switch to Windows** is the explicit
way to make the native Windows backend primary; the normal restart and storage
identity checks then apply.

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
- In the browser/hosted UI, review and revoke sessions you no longer trust in
  **Settings → Connections**.
- Credentials can leak through browser history, screenshots, logs, or copied
  text even when they are placed in a URL fragment.
