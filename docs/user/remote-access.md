# Remote Access

The macOS, Linux, and Windows desktop UI exposes saved remote environments and
host-sharing controls under **Settings → Remote Servers**. Windows also keeps
**Settings → Local environment** for WSL. Browser/hosted clients can connect to a
reachable server but cannot perform desktop-owned listener, firewall, or SSH operations.

Remote access connects a browser or another desktop app to the BiBCode server
running on a different machine. That server owns projects, files, Git state,
terminals, provider CLIs, credentials, and agent sessions.

Use a trusted private network such as a LAN or tailnet. Do not expose a plain
BiBCode HTTP endpoint directly to the public internet.

## Desktop and browser network access

Use the Share controls to create an address-specific pairing offer:

1. Open **Settings → Remote Servers → Share this host**.
2. Choose **Another device** for desktop-managed private-network access. The
   desktop app offers automatic LAN only after it observes a usable private
   default route; creating the offer then restarts the backend with native
   network access.
3. Choose **Custom address** for an SSH tunnel, reverse proxy, public hostname,
   or separately launched server. Custom addresses are externally managed and
   never change the desktop listener or firewall.
4. Inspect the selected endpoint and generate the pairing offer.

Native interface observations are visible to the Share flow before widening,
but report unavailable while the listener is loopback-only. Public-only and
non-default private topologies fail closed instead of attempting a native
widen. Use a custom address backed by an externally managed listener or reverse
proxy on those hosts.

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

Download the signed-release checksum set and the native archive or Linux package for
your host by following [Standalone server installation](./server-installation.md).
Published server distributions contain the matching built web client and discover it
automatically.

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
  "pairingUrl": "http://100.64.0.10:3773/pair#token=one-time-pairing-credential",
  "pairingCode": "bibcode://pair?code=…"
}
```

`pairingCode` is a five-minute encrypted offer for the desktop app's
**Add Server** dialog; it is present only when the bound address is routable
(not loopback, not `0.0.0.0`). Pass `--no-startup-pairing-offer` (or set
`BIBCODE_NO_STARTUP_PAIRING_OFFER=1`) when stdout goes to a log, and mint
offers on demand with `bibcode pairing offer` instead. `pairingUrl` remains the
one-time owner bootstrap for a browser.

To keep the server running across reboots, install it as a per-user service
with `bibcode service install --host <address>`; see
[Standalone server installation](./server-installation.md#run-as-a-per-user-service).

The CLI does not print a QR code and has no `project` subcommand. Pairing
credentials come from `bibcode pairing offer` (encrypted offers for the desktop
app) and `bibcode pairing issue` (the desktop SSH bootstrap). Use
`bibcode serve --help` for the implemented options.

`--static-dir` explicitly overrides packaged web discovery and must contain
`index.html`. A source-built or intentionally API-only server can omit static assets. A
separately hosted HTTPS web app can connect directly to an HTTPS/WSS backend without the
backend serving static files.

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

Create and revoke additional access from **Settings → Remote Servers**. On a
headless server, mint an encrypted offer for the desktop app from the CLI:

```sh
bibcode pairing offer --endpoint http://100.64.0.10:3773
```

It prints a `bibcode://pair?code=…` link that expires after five minutes. Paste
it into **Settings → Remote Servers → Connect → Add Server** on the other
device. `--reach this-computer` requires a loopback endpoint and is for tunnels;
`--name` sets the display name (default: this machine's hostname); `--json`
prints one JSON line. The command works while the server is running on the same
data root and refuses to run before the server has ever started there. Revoke
the resulting device from the Share tab like any other client. The focused
`bibcode pairing issue` command remains for desktop-managed SSH bootstrap.

## Desktop-managed SSH

The desktop contains an SSH launcher that can install a small runner under
`~/.bibcode-ssh-launch/<state-key>`, start or reuse `bibcode serve` on remote
loopback, and create a local port forward. The remote host must provide:

- a compatible native `bibcode` executable on non-interactive `sh`'s `PATH`;
- `curl` or `wget` for the readiness probe; and
- each provider CLI and its credentials.

The launcher does not install Node.js, npm, npx, package-manager shims, or a
BiBCode binary on the remote host. Install a matching standalone server release first.

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
