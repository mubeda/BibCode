# Authentication Architecture

BiBCode separates transport trust, client authentication, and host-control
authority. Proving one does not grant the others. Every paired client currently
receives full environment-administrator access; permission levels are not yet
part of the model.

## Authority classes

| Authority          | Purpose                                                                              | Where it is accepted                                                  |
| ------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Desktop bootstrap  | Starts and enrolls the desktop-owned local runtime                                   | Host-local desktop startup only                                       |
| Pairing credential | One-time bootstrap for a DPoP-bound administrator session                            | Exact token exchange endpoint for at most five minutes                |
| DPoP access token  | Authorizes HTTP requests while binding the token to one client key and exact request | Authenticated HTTP APIs                                               |
| WebSocket ticket   | One-use, short-lived admission to one WebSocket                                      | WebSocket upgrade only                                                |
| Local control      | Creates pairing credentials and coordinates drain/stop/update on the host            | Protected Unix socket or Windows named pipe                           |
| Host administrator | Installs and changes services or package bytes                                       | Desktop bridge, local shell/control, or an SSH administrative session |

Network administrator access is intentionally not host authority. A network
client calling `server.requestHostAction` receives
`ServerHostAuthorityRequiredError` with only the applicable trusted channels.

## Transport trust matrix

| Route             | Listener and encryption                                                      | Trust decision                                                              |
| ----------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Desktop loopback  | HTTP/WebSocket on numeric loopback                                           | Desktop-owned process/bootstrap and local socket boundary                   |
| WSL or SSH tunnel | Remote server listens on loopback; the desktop owns a local loopback forward | SSH host/key policy plus the environment identity verified after forwarding |
| Direct HTTPS      | HTTPS/WSS on a non-loopback address                                          | Operating-system certificate trust or the configured SPKI SHA-256 pin       |

Plain non-loopback HTTP/WebSocket is rejected and has no packaged override.
Credentials in direct route URLs, query strings, and fragments are rejected.
Descriptor fingerprints are diagnostic metadata, not certificate trust.

## Pairing and token exchange

1. An authorized host user creates a five-minute pairing through local control,
   or a foreground authenticated web startup emits the initial owner pairing.
2. The server persists only a SHA-256 hash and a short fingerprint. The raw
   credential is returned once and never appears in list or stream records.
3. The client creates a DPoP key and proves possession for the exact token
   method and URL.
4. Pairing consumption, client-session creation, and a bounded exchange receipt
   commit atomically.
5. A lost response may be retried with the same key during the receipt window;
   another key or a proofless request fails.
6. Normal HTTP requests carry the DPoP-bound access token and a fresh proof.
   WebSocket admission first mints a separate one-use ticket.

Direct TLS listeners verify DPoP against an `https` request URL. The trusted
loopback proxy boundary may supply the external HTTPS scheme for a loopback
backend. Method, URL, timestamp, token hash, and proof replay are all checked.

Pairing links place the secret in the URL fragment so it is not sent with the
initial page request. The fragment can still leak through screenshots, copied
text, or browser history; treat the entire link as a password until exchange.

`serve --no-startup-pairing` and `BIBCODE_NO_STARTUP_PAIRING=1` suppress that
foreground startup credential without changing authentication. Managed
services and desktop/SSH-managed launches always use this mode, so their logs
remain credential-free; an authorized host user or native SSH administration
flow creates pairing later through protected local control.

For desktop-managed SSH, OpenSSH host trust and the forwarded environment and
storage descriptor are verified before pairing creation. The native desktop
opens each launch, stop, and pairing connection with the user's normal OpenSSH
policy, but withholds the fixed remote script from stdin until that exact
connection reports and matches the probed SHA-256 host-key fingerprint. It
refetches and compares the descriptor immediately before it releases the
protected-control pairing script, then redeems the credential through the
active numeric-loopback tunnel. The raw pairing credential stays inside the
native operation and never crosses into JavaScript; only the resulting
administrator session reaches the normalized OS-secret persistence boundary.

## Revocation and restart behavior

Pairings, receipts, sessions, replay state, and WebSocket tickets are bounded.
Revoking a client invalidates its session and closes its active socket
immediately. One-use WebSocket tickets cannot be replayed. Restart does not
turn an expired or consumed pairing into a valid one.

The access stream contains pairing fingerprints, client labels, timestamps,
and session metadata only. It never contains raw pairing credentials.

## Protected local control

Local control is a bounded, versioned request/response protocol with maximum
frame sizes and deadlines. It has no TCP listener and no HTTP fallback.

- Linux and macOS use a service-owned `0700` parent directory and `0600` Unix
  socket, verify the peer UID before reading frames, replace only a verified
  stale owned socket, and unlink only the current process's endpoint.
- Windows uses a remote-rejecting named pipe with an explicit DACL for the
  effective service identity and enabled Builtin Administrators. It validates
  the impersonated client token and reverts impersonation before any await.

Responses are acknowledged before stop/update cancellation begins. Admission
closes first, accepted work drains within a bound, and shutdown joins both
network and control tasks before releasing the durable store guard.

## Secret storage and logging

Desktop catalog rows contain opaque secret references. macOS and Linux use the
native keyring; Windows uses DPAPI-protected per-user storage. If the provider
is unavailable or locked, enrollment fails closed. Renderer storage is never a
credential fallback.

Do not log pairing credentials, access tokens, DPoP private keys, WebSocket
tickets, service credentials, or secret-provider values. Public service views
exclude control endpoints, binary/data/backup paths, raw environment variables,
and credentials. Administrative CLI JSON may include host paths because it is
host-local output and must still be handled as sensitive operational data.

## Safe troubleshooting

- Confirm the route uses loopback or HTTPS before inspecting authentication.
- Verify system certificate trust or the exact configured SPKI pin; never add
  an insecure transport bypass.
- Create a new pairing from the server host when a pairing expired. Do not try
  to recover the old raw value from storage.
- Check client time when DPoP timestamp validation fails.
- Revoke an uncertain client and create a new session rather than sharing its
  token or key.
- Use the host-local CLI for service and update actions. A network
  `hostAuthorityRequired` result is expected, not an authentication failure.

See [Remote architecture](./remote.md),
[Runtime and process model](./runtime-process-model.md), and
[Server administration](../operations/server-administration.md).
