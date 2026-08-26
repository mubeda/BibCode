# Scripts

Run JavaScript/TypeScript workspace commands through Vite+ (`vp`). Run commands
from the repository root unless noted otherwise.

## Setup And Development

- `vp install`: install workspace dependencies.
- `vp run dev`: start the native server and React development graph.
- `vp run dev:server`: start only the Rust WebSocket/HTTP server.
- `vp run dev:web`: start only the Vite frontend.
- `vp run dev:desktop`: start the Tauri 2 desktop app with frontend HMR.
- `vp run dev:marketing`: start the Astro marketing site.
- `vp run start`: run the native `bibcode` CLI through its package script.
- `vp run start:desktop`: alias the Tauri development command.
- `vp run start:marketing`: preview the built marketing site.
- `vp run start:mock-update-server`: run the local desktop-updater fixture
  server.
- `cargo run -p bibcode-server -- serve`: run the native headless server
  directly from this checkout.

`scripts/dev-runner.ts` uses server/web ports `13773` and `5733` by default.
Set `BIBCODE_DEV_INSTANCE` to shift both deterministically, or set
`BIBCODE_PORT_OFFSET` to an explicit numeric offset. These are development-runner
defaults; the standalone native server's default port is `3773`.

The desktop development runner defaults `BIBCODE_HOME` to `~/.bibcode`. Debug
builds use its `dev` state kind while installed builds use `userdata`; a dev
launch does not make either store disposable. Desktop Rust tests use explicit
temporary roots and fail closed if a Tauri mock attempts to resolve the real
default user root, so `cargo test -p bibcode-desktop` must not mutate either
state kind.

## Server Administration

- `bibcode auth pairing create --client-label <label> --format human`: create
  one five-minute full-administrator pairing through protected local control.
- `bibcode service status --mode workstation --format json`: inspect the native
  registration, state, definition match, paths, bind, account, and Linux linger
  status from the server host.
- `bibcode service install --mode workstation`: install and start the
  current-user Task Scheduler, LaunchAgent, or systemd user definition.
- `bibcode service install --mode headless`: install and start the elevated
  SCM, LaunchDaemon, or systemd system definition with its dedicated identity.
- `bibcode service start|stop|restart --mode <workstation|headless>`: manage an
  installed service. Stop/restart first attempt bounded drain through local
  control.
- `bibcode service uninstall --mode <workstation|headless>`: remove native
  registration while preserving the selected data root. No purge flag exists.

Add the same explicit `--base-dir` to every command when the service does not
use its mode's default root. Managed services reject non-loopback `--host`
values. A changed definition requires the explicit `service install --update`
form after the administrator inspects the difference. That flag updates the
native definition, not standalone binary package bytes.

See [Server administration](../user/server-administration.md) for per-platform
authority, accounts, defaults, and recovery.

## Remote Environment Validation

The repository has no command that bypasses OpenSSH host-key policy, starts a
stopped WSL distro, or unregisters one. Use the focused owners documented in
[Remote environment validation](../testing/remote-environments.md):

```sh
cargo test -p bibcode-server process:: --lib -- --nocapture
cargo test -p bibcode-desktop remote_host:: --lib -- --nocapture
cargo test -p bibcode-desktop remote_operation::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop wsl:: --lib -- --nocapture
cargo test -p bibcode-desktop wsl_setup:: --lib -- --nocapture
cargo test -p bibcode-desktop wsl_transport::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop ssh::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop --test ssh_public_contract -- --nocapture
vp test apps/web/src/connection/platform.test.ts apps/web/src/connection/desktopLocal.test.ts apps/web/src/tauriDesktopBridge.test.ts packages/client-runtime/src/connection/registry.test.ts packages/contracts/src/ipc.test.ts
```

On native Windows, prefix Rust commands with
`node scripts/run-msvc-x64.mjs`. Native WSL, OpenSSH service-manager, PowerShell,
launchd, systemd, and Windows Job evidence cannot be replaced by a simulated
fixture on another host.

## Build And Quality

- `vp run build`: build application, package, lint-plugin, and script outputs.
- `vp run build:desktop`: build the React assets, Rust backend, and Tauri app.
  On Linux, the desktop build launcher scopes `NO_STRIP=1` to the Tauri child
  process so linuxdeploy does not invoke its older bundled `strip` against
  modern RELR-enabled system libraries; Windows and macOS inherit the caller's
  environment unchanged.
- `vp run build:marketing`: build the Astro marketing site.
- `vp run check:contracts`: typecheck the schema-only contracts package, verify
  deterministic RPC fixture export, regenerate the fixtures, and run the
  TypeScript/Rust RPC parity and Rust fixture round-trip checks. It does not
  create a distributable contracts build.
- `vp check`: run the Vite+ formatting and lint checks.
- `vp run fmt` / `vp run fmt:check`: write or verify Vite+ formatting.
- `vp run lint`: run Vite+ linting with unused-disable reporting.
- `vp run typecheck` (or `vp run tc`): run package TypeScript and Rust checks.
  Use `vp run --concurrency-limit 1 typecheck` when a constrained host cannot
  safely run all typecheck owners concurrently; this changes scheduling, not
  the selected graph.
- `vp test`: run the built-in Vite+ unit test command.
- `vp run test`: run every package `test` script, including Rust packages.
- `vp run test:desktop`: run the Tauri Rust test suite.
- `vp run test:ui:desktop`: run packaged desktop WebdriverIO tests.
- `vp run test:ui:desktop:build`: build the packaged app used by desktop UI
  tests.
- `vp run test:coverage`: run TypeScript and Rust coverage gates.
- `vp run test:coverage:ts` / `vp run test:coverage:rust`: run one coverage
  side independently.
- `vp run release:smoke`: exercise release versioning and lockfile generation.
- `vp run check:dependency-ledger`: validate the machine-consumed dependency
  upgrade ledger.

Use `vp test` for the built-in Vite+ test command. Use `vp run test` when the
workspace package-script graph is specifically required. The graph keeps
package test tasks concurrent, while server and desktop Rust test commands use
the default parallel harness threads with Cargo compilation bounded by `-j 2`.
When an explicit `CARGO_TARGET_DIR` is supplied to a Cargo test command, the
shared Cargo launcher resolves it from the launch directory, creates it, and
passes its native canonical filesystem path to Cargo. This gives each platform
one unambiguous test-binary identity and keeps Tauri's secured starting-binary
lookup valid when an isolated target was requested through an alias such as
macOS `/tmp`; non-test commands and implicit Cargo targets are unchanged.
Exact subprocess tests may use `--test-threads=1` only inside an isolated child
process that intentionally owns process-global state.

## Desktop Artifacts

- `vp run dist:desktop:artifact -- ...`: invoke the generic artifact wrapper.
- `vp run dist:desktop:dmg`: macOS DMG for the host architecture.
- `vp run dist:desktop:dmg:arm64`: macOS arm64 DMG.
- `vp run dist:desktop:dmg:x64`: macOS Intel DMG.
- `vp run dist:desktop:linux`: Linux x64 AppImage.
- `vp run dist:desktop:win`: Windows NSIS installer for the host architecture.
- `vp run dist:desktop:win:x64`: Windows x64 NSIS installer.

The root package contains a Windows ARM64 artifact command for development
experiments, but Windows ARM is not a supported release target. The wrapper,
`scripts/build-desktop-artifact.ts`, rejects cross-platform builds by default,
invokes the canonical `@bibcode/desktop` Tauri package, and copies bundle output
under `release/desktop/<platform>-<arch>` unless an output directory is supplied.

The desktop artifact contains the Tauri host, in-process Rust server, and built
web assets. It does not stage Node.js, a TypeScript server, or helper sidecars.

## Server Artifacts

- `vp run dist:server:artifact -- --target <native-target> --formats portable
--output-dir <new-directory>`: build the native `bibcode` executable, the
  browser-only production web assets, notices, build metadata, and the target's
  deterministic ZIP or tar.gz archive.
- `vp run dist:server:artifact -- --target <native-target> --formats portable
--output-dir <new-directory> --unsigned-test`: label a local validation build
  as `unsigned-test`; this does not make the artifact a signed release.
- `vp run dist:server:artifact -- --target <native-target> --formats native
--output-dir <new-directory> --unsigned-test`: build the matching native MSI,
  universal PKG, or DEB and RPM outputs.
- `--formats native,portable`: publish both requested format classes from one
  verified web/staging input. Unknown, empty, or duplicate format selections
  fail before publication.

The target must match the native host architecture. Supported target triples
are Windows x64/ARM64, macOS x64/ARM64, and Linux x64/ARM64. The output
directory must not already exist. The builder resolves Cargo and rustc through
the exact channel in `rust-toolchain.toml`, sets the selected compiler
explicitly, uses frozen Cargo and pnpm inputs, consumes Cargo's exact
compiler-artifact record, and refuses links,
source maps, secrets, logs, databases, `node_modules`, Node executables, Tauri
runtime bytes, and legacy Connect/telemetry content. The archive contains only
the native CLI/server, a browser-only static application, install-layout
metadata, build metadata, license, notices, and a README; extraction performs
no service, login-item, PATH, firewall, or data-root mutation.

Windows MSI uses pinned WiX 7 and a per-user install root. macOS PKG combines
both Rust slices, verifies exact universal membership, ad-hoc signs the local
credential-free binary, and keeps package signing/notarization distinct. Linux
requires exactly `cargo-deb` 3.7.0 and `cargo-generate-rpm` 0.21.0 and emits
both DEB and RPM. Every native package delegates service definitions to the
Rust `bibcode service` adapter, binds workstation service configuration to
loopback, and preserves data on uninstall. Package templates contain no
credential.

CI may supply an already built immutable web directory together with its
sorted `web-assets.json`; both options are required together and every path,
size, and SHA-256 is revalidated before staging. Adjacent `.build.json` files
record the target/compiler/binary digest; universal PKG metadata additionally
records both slice digests. Signing, SBOM, manifest, and stable-release gates
are later finalization steps and must not treat `unsigned-test` output as
publishable evidence.

## Repository Maintenance

- `vp run sync:repos`: synchronize configured read-only reference repositories
  under `.repos`; pass `-- --repo <id>` to synchronize one entry.
- `vp run measure:desktop-runtime -- ...`: capture startup, memory, and
  process-tree measurements.
- `node scripts/measure-vcs-runtime.ts`: on Windows, build and run the
  current-source server VCS idle-process measurement plus the production-Atom
  foreground queue benchmark. It defaults to 600 seconds and writes all
  machine-specific evidence and an isolated Cargo target to a unique temporary
  directory, selecting exact executables from Cargo artifact JSON even when a
  target triple is configured; use `--duration-ms` only for short harness
  validation.
- `vp run clean`: remove generated dependency, build, target, and Vite+ cache
  directories. This is destructive to local build output.

See [CI Quality Gates](../operations/ci.md) for the commands enforced in CI.
