# CI Quality Gates

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`. It has
four job groups:

- **Check** runs `vp check`, workspace typechecking (`vpr typecheck`),
  `cargo fmt --all --check`, Clippy with warnings denied, and the complete
  desktop build pipeline on Ubuntu 24.04.
- **Test** runs every workspace package `test` script concurrently with
  `vp run test`, then runs `cargo test --workspace -j 2` explicitly on Ubuntu
  24.04. Its 45-minute job watchdog accommodates an uncached Rust workspace
  build plus the complete integration suite without changing any test-owned
  deadline. The `-j 2` bound limits concurrent Cargo compilation jobs; Rust
  test binaries use the default parallel harness threads. Exact subprocess
  tests may still select `--test-threads=1` inside an isolated child process
  that intentionally owns process-global state.
- **Release Smoke** runs `scripts/release-smoke.ts` to exercise release-only
  version rewriting, nightly metadata, and lockfile generation without
  publishing.
- **Native desktop** builds the web application, tests the desktop Rust host,
  and creates an unpublished native bundle on Linux ARM64/x64, Windows ARM64/x64,
  and macOS ARM64/x64 runners. The shared `scripts/run-msvc.mjs` launcher selects
  the requested MSVC architecture. After the Rust host tests,
  the Windows row alone runs
  `vp test run apps/desktop/e2e/support/test-project.test.ts`. That step is the
  supported native proof that the generated Cursor `.cmd` shim executes through
  the Windows command processor and writes its exact action record. Simulated
  target fixture assertions on other hosts are compatibility evidence, not a
  native Windows pass.
  The Windows rows then run
  `node scripts/run-msvc.mjs cargo check -p bibcode-server --all-targets` so
  Unix-only test helpers or imports that are unused on Windows fail there under
  `-D warnings` instead of surfacing only during native validation; Clippy's
  `--all-targets` pass otherwise runs on Linux alone.

The Check and Test jobs install the Linux libraries required by Tauri. The
native matrix installs them only on Linux and otherwise uses each platform's
native toolchain. Node.js and Vite+ are development/build dependencies; release
artifacts contain the Tauri/Rust application and built web assets, not a Node
runtime or TypeScript server.

All workflows use the repository's declared Node.js 26.8.1, pnpm 11.25.0,
Vite+ 0.3.0, and Rust 1.98.0 toolchains. External setup actions are immutable
SHA-pinned with audited tag comments: Checkout 7.0.1
(`3d3c42e5aac5ba805825da76410c181273ba90b1`), Rust Cache 2.9.2
(`6323deb102c322ba6fcbdcafc7e3dddab59af2b6`), setup-vp 1.18.0
(`1b32467adbe183473499fd9d5d372c3ed9641754`), action-gh-release 3.0.3
(`efb35369e0ad2afab669f228072c1b0d510eae64`), and Rust toolchain 1.98.0
(`62ae3a85dbdd2bedbb5819da8ce45635129289a1`). Reverify a tag before changing
its immutable SHA.

## Other Workflows

- `.github/workflows/desktop-ui-smoke.yml` is a manual or reusable packaged-app
  UI smoke matrix for all six supported native targets.
- `.github/workflows/desktop-upgrade-smoke.yml` runs real seeded updater flows on
  all six targets; its WSL-specific lane remains Windows x64.
- `.github/workflows/release.yml` runs the stable/nightly release pipeline. See
  the [Release Checklist](./release.md). Its separate server matrix builds six
  archives, four Linux packages, and native distribution evidence before release
  assembly can create a draft.
- `.github/workflows/deploy-relay.yml` deploys the BiBCode Connect relay from
  `main` only when the required Cloudflare repository configuration exists.
- `.github/workflows/issue-labels.yml`, `pr-size.yml`, and `pr-vouch.yml` enforce
  repository-maintenance policy independently of the application quality
  gates.

When changing a workflow, update its focused workflow-contract tests and run
the repository gates documented in [Scripts](../reference/scripts.md).
Repeatable native manual and packaged validation follows the
[shared cross-platform runbook](../testing/cross-platform-validation.md) plus
the matching Windows, Linux, or macOS page in the
[testing runbook index](../testing/README.md).
