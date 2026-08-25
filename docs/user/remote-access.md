# Remote Access

Remote access connects a browser or another desktop app to the BiBCode server
running on a different machine. That server owns projects, files, Git state,
terminals, provider CLIs, credentials, and agent sessions.

Plain HTTP/WebSocket is restricted to loopback. This rule also applies on a
trusted LAN or tailnet: BiBCode has no packaged switch or override that binds an
unencrypted server to another interface.

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

The CLI does not print a QR code. It also has no `auth` or `project` subcommands,
no positional working-directory argument, and no `--tailscale-serve` flags. Use
`bibcode serve --help` for the implemented options.

`--static-dir` is needed only when this server should deliver the web client.
A separately hosted HTTPS web app can connect directly to an HTTPS/WSS backend
without the backend serving static files.

## Pairing

On startup in authenticated web mode, the server issues an owner pairing
credential. The credential is carried in the URL fragment so it is not sent as
part of the initial HTTP request:

```text
https://server.example:3773/pair#token=PAIRING_CREDENTIAL
```

The client exchanges the credential for a session. Treat the credential and
pairing URL as passwords until the exchange completes.

For a configured hosted web app, use a URL shaped like:

```text
https://app.example.com/pair?host=https://backend.example.com#token=PAIRING_CREDENTIAL
```

The hosted app saves the backend address, but it does not proxy traffic. The
browser still connects directly to the backend, which must therefore be
reachable over HTTPS/WSS from that browser.

In the browser/hosted UI, create and revoke additional access from
**Settings → Connections**. There is no current CLI access-management command.

## Browser/hosted and future re-enabled desktop-managed SSH status

The desktop contains an SSH launcher that can install a small runner under
`~/.bibcode-ssh-launch/<state-key>`, start or reuse `bibcode serve` on remote
loopback, and create a local port forward. The remote host must provide:

- a compatible native `bibcode` executable on non-interactive `sh`'s `PATH`;
- `curl` or `wget` for the readiness probe; and
- each provider CLI and its credentials.

However, end-to-end setup of a new SSH environment is **currently unavailable**.
The desktop pairing step invokes `bibcode auth pairing create`, while the native
CLI currently implements only `start` and `serve`. Do not rely on the SSH **Add
environment** flow until that CLI mismatch is resolved.

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

The WSL launcher uses a fixed system `PATH` and starts `bibcode serve` directly.
Verify a custom binary from Windows with:

```powershell
wsl.exe -d <distribution> -- /path/to/bibcode --version
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
- Treat pairing URLs and credentials as secrets.
- In the browser/hosted UI, review and revoke sessions you no longer trust in
  **Settings → Connections**.
- Credentials can leak through browser history, screenshots, logs, or copied
  text even when they are placed in a URL fragment.
