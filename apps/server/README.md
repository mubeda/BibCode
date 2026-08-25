# BiBCode Server

`apps/server` is the native Rust/Axum/Tokio application server and the
`bibcode` command-line program. One running server represents one execution
environment and owns that environment's durable identity, projects, threads,
repositories, worktrees, terminals, provider processes, authentication state,
and diagnostics.

The package does not require Node.js in production. TypeScript is used only by
the frontend, contracts, and repository tooling.

## Runtime boundaries

- Browser and desktop application traffic uses typed HTTP and WebSocket RPC.
- Privileged desktop operations cross the typed `DesktopBridge`; the web app
  does not spawn SSH, WSL, service-manager, or native credential-store work.
- Host-local pairing, drain, stop, and update preparation use the protected
  local-control socket or named pipe. There is no HTTP fallback.
- Network RPC can read the redacted service/update view. It cannot install,
  stop, restart, uninstall, or update a host service and receives the typed
  `hostAuthorityRequired` result instead.

See [Authentication architecture](../../docs/architecture/authentication.md)
and [Runtime and process model](../../docs/architecture/runtime-process-model.md)
for the trust and ownership rules.

## Listener matrix

| Listener                | Supported use                                             | Transport trust                                                                                                               | Host-control authority                                            |
| ----------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Numeric loopback        | Local desktop, local browser, WSL/SSH forward destination | HTTP is allowed because the socket is host-local; authentication remains enabled unless the trusted desktop bootstrap is used | Desktop bridge or protected local control                         |
| Non-loopback            | Direct browser or desktop route                           | HTTPS only, with a valid certificate/private-key pair and client system trust or an explicit SPKI pin                         | None through network RPC; use local control or SSH administration |
| Plain non-loopback HTTP | Never                                                     | Rejected before durable startup                                                                                               | None                                                              |

There is no insecure listener override. Direct HTTPS authentication uses the
TLS request scheme when verifying DPoP proofs. A trusted loopback reverse proxy
may continue to provide its HTTPS scheme through the existing proxy boundary.

## Running from source

From the repository root:

```sh
cargo run -p bibcode-server -- serve
```

`serve` does not open a browser. `start` runs the same server and opens its
startup URL unless `--no-browser` is present. A direct network listener must
provide both TLS files:

```sh
cargo run -p bibcode-server -- serve \
  --host 0.0.0.0 \
  --tls-certificate-chain /absolute/path/server-chain.pem \
  --tls-private-key /absolute/path/server-key.pem
```

The server fails before durable initialization when a TLS pair is incomplete,
invalid, mismatched, expired, or not yet valid.

## Service administration

The native CLI supports workstation and headless service definitions on
Windows, macOS, and Linux:

```sh
bibcode service status --mode workstation --format json
bibcode service install --mode workstation
bibcode service start --mode workstation
bibcode service stop --mode workstation
bibcode service restart --mode workstation
bibcode service uninstall --mode workstation
```

`workstation` is the default. `headless` requires elevated host authority and
uses a dedicated service identity. Managed services bind only to loopback.
Uninstall removes registration but preserves the data root; there is no purge
flag. See [Server administration](../../docs/user/server-administration.md) for
platform mechanisms, exact commands, pairing, recovery, and safety notes.

## Validation

Run focused owners from the repository root:

```sh
cargo test -p bibcode-server --test network_admission -- --nocapture
cargo test -p bibcode-server --test auth_http -- --nocapture
cargo test -p bibcode-server --test local_control -- --nocapture
cargo test -p bibcode-server --test service_lifecycle -- --nocapture
cargo test -p bibcode-server --test production_control -- --nocapture
cargo test -p bibcode-server --test production_maintenance -- --nocapture
```

On native Windows, use `node scripts/run-msvc-x64.mjs cargo ...`. Follow the
[cross-platform validation runbook](../../docs/testing/cross-platform-validation.md)
and the page for the native operating system before claiming platform support.
