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

## Build And Quality

- `vp run build`: build application, package, lint-plugin, and script outputs.
- `vp run build:desktop`: build the React assets, Rust backend, and Tauri app.
- `vp run build:marketing`: build the Astro marketing site.
- `vp run build:contracts`: build the schema-only contracts package.
- `vp check`: run the Vite+ formatting and lint checks.
- `vp run fmt` / `vp run fmt:check`: write or verify Vite+ formatting.
- `vp run lint`: run Vite+ linting with unused-disable reporting.
- `vp run typecheck` (or `vp run tc`): run package TypeScript and Rust checks.
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

## Repository Maintenance

- `vp run sync:repos`: synchronize configured read-only reference repositories
  under `.repos`; pass `-- --repo <id>` to synchronize one entry.
- `vp run measure:desktop-runtime -- ...`: capture startup, memory, and
  process-tree measurements.
- `vp run clean`: remove generated dependency, build, target, and Vite+ cache
  directories. This is destructive to local build output.

See [CI Quality Gates](../operations/ci.md) for the commands enforced in CI.
