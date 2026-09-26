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

`apps/web/src/reactCompiler.test.tsx` guards the compiled lane. It fails when
happy-dom files stop running through the compiler, or when the compiler stops
caching the fixture's read by its arguments, for example after an upgrade of
`babel-plugin-react-compiler`. The root configuration excludes it, so running
that file from the root reports that no test files were found.
