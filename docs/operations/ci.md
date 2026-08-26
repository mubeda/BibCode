# CI Quality Gates

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`. It has
four job groups:

- **Check** runs `vp check`, workspace typechecking (`vpr typecheck`),
  `cargo fmt --all --check`, Clippy with warnings denied, and the complete
  desktop build pipeline on Ubuntu 24.04.
- **Test** runs every workspace package `test` script concurrently with
  `vp run test`, then runs `cargo test --workspace -j 2` explicitly on Ubuntu
  24.04. The `-j 2` bound limits concurrent Cargo compilation jobs; Rust test
  binaries use the default parallel harness threads. Exact subprocess tests may
  still select `--test-threads=1` inside an isolated child process that
  intentionally owns process-global state.
- **Release Smoke** runs `scripts/release-smoke.ts` to exercise release-only
  version rewriting, nightly metadata, and lockfile generation without
  publishing.
- **Native desktop** builds the web application, tests the desktop Rust host,
  and creates an unpublished native bundle on Linux x64, Windows x64, macOS
  arm64, and macOS x64 runners. Windows ARM is intentionally excluded while
  `scripts/run-msvc-x64.mjs` remains x64-specific. After the Rust host tests,
  the Windows row alone runs
  `vp test run apps/desktop/e2e/support/test-project.test.ts`. That step is the
  supported native proof that the generated Cursor `.cmd` shim executes through
  the Windows command processor and writes its exact action record. Simulated
  target fixture assertions on other hosts are compatibility evidence, not a
  native Windows pass.

The Check and Test jobs install the Linux libraries required by Tauri. The
native matrix installs them only on Linux and otherwise uses each platform's
native toolchain. Node.js and Vite+ are development/build dependencies; release
artifacts contain the Tauri/Rust application and built web assets, not a Node
runtime or TypeScript server.

## Other Workflows

- `.github/workflows/desktop-ui-smoke.yml` is a manual or reusable packaged-app
  UI smoke matrix for the same four supported native targets.
- `.github/workflows/release.yml` runs the stable/nightly release pipeline. See
  the [Release Checklist](./release.md).
- `.github/workflows/issue-labels.yml`, `pr-size.yml`, and `pr-vouch.yml` enforce
  repository-maintenance policy independently of the application quality
  gates.

When changing a workflow, update its focused workflow-contract tests and run
the repository gates documented in [Scripts](../reference/scripts.md).
Repeatable native manual and packaged validation follows the
[shared cross-platform runbook](../testing/cross-platform-validation.md) plus
the matching Windows, Linux, or macOS page in the
[testing runbook index](../testing/README.md).
