# Remote Access

The v0.3.14 macOS, Linux, and Windows desktop UI is presented as local-only.
Remote connection, pairing, SSH, Tailscale, network-exposure, and BiBCode
Connect controls are hidden without removing their underlying implementation.
Windows keeps **Settings → Local environment** for WSL. The browser/hosted UI
retains the full remote workflow described below.

Remote access connects a browser or another desktop app to the BiBCode server
running on a different machine. That server owns projects, files, Git state,
terminals, provider CLIs, credentials, and agent sessions.

Use a trusted private network such as a LAN or tailnet. Do not expose a plain
BiBCode HTTP endpoint directly to the public internet.

## Browser/hosted and future re-enabled desktop network access

In the browser/hosted UI, or when this desktop presentation is re-enabled, use
these controls to expose the backend embedded in the desktop app:

1. Open **Settings → Connections**.
2. Under **Manage Local Backend**, enable **Network access**. The desktop app
   restarts its backend bound to the network-accessible host.
3. Inspect the reachable endpoints. The list can include loopback, LAN, Tailnet
   IP, MagicDNS, or verified HTTPS endpoints.
4. Choose the endpoint you want to use and select **Create Link** to issue a
   pairing link.

The selected endpoint type becomes the default for later links. A LAN endpoint
can remain the default across ordinary IP address changes.

- A loopback URL works only on the server machine.
- A plain LAN or Tailnet HTTP URL can be used by a desktop client or by a page
  served over HTTP.
- An HTTPS-hosted web app cannot connect to an insecure HTTP/WS backend because
  browsers block mixed content. Use an HTTPS/WSS endpoint in that case.

### Tailscale endpoints

When the desktop app can read `tailscale status --json`, it can add the machine's
Tailnet IPv4 addresses and MagicDNS name to the endpoint list.

An HTTPS MagicDNS endpoint is shown as available only after its well-known
BiBCode endpoint responds successfully. Configure Tailscale Serve separately to
proxy the chosen HTTPS address to the local BiBCode backend, then let the desktop
app rescan it. The native `bibcode` CLI does not currently provide Tailscale
Serve setup flags.

## Headless server

`bibcode start` and `bibcode serve` run the same native server. `start` opens the
startup URL in a browser by default; `serve` does not.

For example, bind to a trusted Tailnet address and serve built web assets:

```bash
bibcode serve \
  --host "$(tailscale ip -4)" \
  --static-dir /path/to/BibCode/apps/web/dist
```

The server prints one JSON object to stdout. In authenticated web mode it has
this shape:

```json
{
  "address": "100.64.0.10:3773",
  "httpBaseUrl": "http://100.64.0.10:3773",
  "token": "one-time-pairing-credential",
  "pairingUrl": "http://100.64.0.10:3773/pair#token=one-time-pairing-credential"
}
```

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
http://server.example:3773/pair#token=PAIRING_CREDENTIAL
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

- Bind the server only to a trusted private address.
- Prefer HTTPS/WSS whenever the browser page itself is served over HTTPS.
- Treat pairing URLs and credentials as secrets.
- In the browser/hosted UI, review and revoke sessions you no longer trust in
  **Settings → Connections**.
- Credentials can leak through browser history, screenshots, logs, or copied
  text even when they are placed in a URL fragment.
