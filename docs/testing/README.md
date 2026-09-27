# Testing Runbooks

These runbooks describe BiBCode's current repeatable validation contract. They
are living documentation, not execution history.

## Choose a runbook

Start with the shared procedure, then use the page for the native host:

- [Shared cross-platform validation](./cross-platform-validation.md)
- [Windows desktop](./windows-desktop.md)
- [Linux desktop](./linux-desktop.md)
- [macOS desktop](./macos-desktop.md)
- [Desktop-managed SSH environments](./ssh-environments.md) (all three desktops;
  its automated harness runs on Linux and macOS)
- [Execution report template](./execution-report-template.md)
- [Flaky-test diagnosis](./flaky-tests.md)

## Evidence classes

- **Native evidence:** the command or scenario executed on the named operating
  system.
- **Compatibility evidence:** source, contract, fixture, or cross-target checks
  for another operating system.
- **Unavailable evidence:** a command or capability that could not execute and
  is reported with its exact blocker.

Never describe compatibility or unavailable evidence as a native pass. A
complete report separates all three classes.

Native release reports also separate desktop-installer evidence from standalone-server
archive/package evidence. Each architecture requires its own native result; one
architecture never proves another.

## Living documentation and execution reports

The runbooks define current procedure and supported behavior. Branch names,
required commit SHAs, expected product versions, test counts, durations,
screenshots, logs, and machine paths are inputs or outputs of a particular run.
Record those values in a report created from the
[execution report template](./execution-report-template.md), not in these
pages.

Reports may live in CI artifacts, issue or pull-request attachments, or an
explicit local evidence directory. The runbooks do not prescribe one retention
owner. Never commit secrets, credentials, private user data, or unbounded logs.

## Operating rule

Read [Shared cross-platform validation](./cross-platform-validation.md) in full
before the native page. Source, manifests, scripts, tests, CI, and release
workflows remain executable evidence; if a runbook disagrees with them, stop,
classify the disagreement, and update the living documentation with the
behavior change.

Static lint evidence must be freshly re-derived rather than replayed from Cargo
cache. From the repository root, clean every workspace crate and then lint the
whole workspace with warnings denied:

```sh
cargo clean -p bibcode-server -p bibcode-desktop -p bibcode-updater-verifier
cargo clippy --workspace --all-targets -- -D warnings
```

## Hermetic Rust fixtures

Automated Rust tests must never execute the host's provider or hosting CLIs,
perform real provider update checks, or use the user's HOME, shell rc files,
or `~/.ssh`. Use test-owned executables, configuration, and temporary roots.
Real Git may operate on disposable repositories with isolated Git configuration.

Write executable fixtures with `tests/support/executable_fixture.rs` (lib tests:
`TestSandbox::write_executable`), never in-process `fs::write`/`fs::copy`, to prevent
fork-inherited writable descriptors from causing `ETXTBSY`.

Harnesses that start a production runtime or `NativeServerControl` with the
default provider registry use
[`tests/support/hermetic_providers.rs`](../../apps/server/tests/support/hermetic_providers.rs).
Harnesses with restricted registries or disabled providers are hermetic by
construction and need not use the helper.
Integration tests include it with `#[path = "support/hermetic_providers.rs"]`;
library tests use `crate::test_support::hermetic_providers`.
`write_hermetic_settings(&config.state_dir(), overlay)` disables update checks
and pins every built-in driver's legacy `binaryPath` to an absolute missing
path. It explicitly preserves the built-in enabled defaults in both settings
readers: Codex, Claude, Cursor, and OpenCode enabled; Grok disabled. It
deep-merges fixture overrides, including partial `providerInstances`, so
unspecified drivers stay pinned. `ensure_hermetic_settings` reads existing
settings as the overlay and writes the hermetic base beneath them; explicit
pinned-key overrides remain the fixture's responsibility. Read or parse errors
fail the test. Seed the same state directory before spawning `bibcode` with
`--base-dir`.

Tests exercising probes or updates must explicitly overlay test-owned binaries
and local endpoints. Use the discovery and Git VCS
`*_for_integration_test` executable-directory seams for hosting commands;
`missing_hosting_executable_dir` keeps them absent while preserving the real
Git version probe. The Git VCS seam also pins pull-request commands and their
passive-summary clone. Pass `isolated_terminal_home` as both `"HOME"` and
`"USERPROFILE"` in each terminal open, attach-that-starts, restart, or
setup-script environment. Do not mutate
process-global PATH or HOME to isolate parallel tests. SSH fixtures must use
test-owned SSH configuration and hosts.

Desktop in-process test runtimes pin hosting executables to a missing directory
under their isolated data root through
`ServerConfig::with_hosting_executable_dir_for_integration_test`. Desktop SSH
unreachable-target tests use an empty temporary SSH config (`-F`) and a literal
loopback destination with an empty alias, avoiding user config and DNS.

The server harnesses, including the library's `control.rs` and lifecycle tests,
and the desktop harnesses follow these rules. The
[approved hermetic test guard](../superpowers/specs/2026-09-26-hermetic-test-guard-design.md)
will enforce the no-host-provider-or-hosting-CLI rule across tests; it is not
implemented yet.

## Static rendering and Zustand

`renderToStaticMarkup` reads Zustand's server snapshot, which uses
`getInitialState`, not the current `getState`. Calling `setState` or a store
action before that render does not change the snapshot selectors see. A
static-markup test can therefore keep rendering the default tab after the
test selects another one.

Use static markup for initial-state output. For a non-default state or a state
transition, render through `createRoot` inside `act` in a happy-dom test, or
verify the interaction in a live browser. Test pure selection logic directly
when DOM behavior is not the subject. `GitManagerPanel.test.tsx` contains
mounted tests that set the store before rendering. Follow the compiler-lane
guidance below when selecting the command.

## Web unit tests and the React Compiler

The web client build compiles components and hooks with the React Compiler.
Whether a web unit test runs compiled code depends on how it runs:

- **Web package (`vp run test`, which CI runs):** `apps/web/vite.config.ts`
  applies the compiler to Vite's client environment. Files marked
  `// @vitest-environment happy-dom` run through it exactly as the client build
  does. Node-environment files run in Vite's `ssr` environment, which the
  compiler preset skips, so they are uncompiled.
- **Repository root (`vp test`):** the root configuration runs no React
  plugins, so no web test is compiled there, and `vp run test:coverage:ts`
  measures source rather than the compiler's generated memoization code.

Node-environment tests that render mostly use `renderToStaticMarkup`, which
renders once, so they could not observe a stale memoized read anyway. Those
that render through `createRoot` on a hand-built happy-dom `Window` or stubbed
globals are still uncompiled, so they don't count as compiled coverage. A test
whose assertion depends on re-rendering, such as whether a hook reads state
again after an update, must render through React DOM in a happy-dom file. It
can pass from the root and still fail in CI, so verify it through the web
package: from `apps/web`, run `vp test run --project unit src/<path>.test.tsx`.
Where a global `vp` may shadow the workspace copy (native Windows, Parallels),
run `node ../../scripts/run-local-vp.mjs` with the same arguments.

`apps/web/src/reactEffectEventStaleness.test.tsx` pins the react-dom 19.2 defect
where Effect Events retain their first render's values in `memo(C)` without a
compare function, `forwardRef(C)`, and `memo(forwardRef(C), compare)`, despite a
committed prop update; plain functions and `memo(C, compare)` are controls.
The error rule `bibcode/no-effect-event-in-memo-or-forward-ref` refuses these
patterns in same-file components and hooks only; imported hooks and components
are not followed. Run the probe in the web package's compiled lane. If it fails
after a react-dom upgrade because a prohibited form starts returning the new
value, re-check every form and remove the rule only once all of them recover.

`apps/web/src/reactCompiler.test.tsx` guards the compiled lane. It fails when
happy-dom files stop running through the compiler, or when the compiler stops
caching the fixture's read by its arguments, for example after an upgrade of
`babel-plugin-react-compiler`. The root configuration excludes it, so running
that file from the root reports that no test files were found.
