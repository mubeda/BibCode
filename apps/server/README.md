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

Installed and portable server packages resolve their compiled browser UI from
the verified `share/bibcode/install-layout.json` beside `bin/bibcode`; they do
not depend on the current working directory. Missing, escaped, symlinked, or
hash-mismatched web assets fail packaged startup with a reinstall error. An
explicit `--static-dir` remains available for development and administration.
Portable foreground use may deliberately omit the UI with
`--without-web-ui`; managed services reject that flag.

```sh
cargo run -p bibcode-server -- serve \
  --host 0.0.0.0 \
  --tls-certificate-chain /absolute/path/server-chain.pem \
  --tls-private-key /absolute/path/server-key.pem
```

The server fails before durable initialization when a TLS pair is incomplete,
invalid, mismatched, expired, or not yet valid.

Foreground web mode normally prints one reveal-once startup pairing. Use
`--no-startup-pairing` (or `BIBCODE_NO_STARTUP_PAIRING=1`) when a supervisor or
SSH-managed launch must not mint or log that credential. This does not disable
authentication: create access later with `bibcode auth pairing create` through
the protected local-control socket or named pipe. Desktop, SSH-managed, and
installed-service launches suppress startup pairing automatically.

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

Native installers coordinate replacement through the internal
`package prepare|activate|rollback` surface. The old binary drains through
protected local control, creates a verified backup, stops, and writes an
identity-bound receipt before the package manager may replace files. The new
binary must verify the same environment/storage identities, expected version,
local-control protocol, loopback listener, web assets, and service definition.
Rollback starts an older binary only after its path and SHA-256 match the
receipt and the database schema still matches the pre-update backup.

Destructive storage removal is deliberately separate and two-step:

```sh
bibcode storage purge plan --environment-name "Build Mac" --json
bibcode storage purge execute \
  --plan-id <uuid> \
  --confirm-environment-name "Build Mac" \
  --json
```

Both commands use the same `--base-dir` when it is not the default. Planning
requires the running server's protected local-control endpoint. Execution
requires the exact name, fresh plan, environment/storage markers, an offline
runtime, and no project, worktree, or owned-process guard. It removes only the
canonical selected data root; no package or service command has a purge flag.

## Validation

Run focused owners from the repository root:

```sh
cargo test -p bibcode-server --test network_admission -- --nocapture
cargo test -p bibcode-server --test auth_http -- --nocapture
cargo test -p bibcode-server --test local_control -- --nocapture
cargo test -p bibcode-server --test service_lifecycle -- --nocapture
cargo test -p bibcode-server --test production_control -- --nocapture
cargo test -p bibcode-server --test production_maintenance -- --nocapture
cargo test -p bibcode-server --test package_lifecycle -- --nocapture
```

On native Windows, use `node scripts/run-msvc-x64.mjs cargo ...`. Follow the
[cross-platform validation runbook](../../docs/testing/cross-platform-validation.md)
and the page for the native operating system before claiming platform support.
