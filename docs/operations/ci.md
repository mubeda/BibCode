# CI Quality Gates

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`. It has
four job groups:

- **Check** runs `vp check`, workspace typechecking (`vpr typecheck`),
  `cargo fmt --all --check`, Clippy with warnings denied, and the complete
  desktop build pipeline on Ubuntu 24.04.
- **Test** runs every workspace package `test` script with `vp run test`, then
  runs `cargo test --workspace -j 2` explicitly on Ubuntu 24.04.
- **Release Smoke** runs `scripts/release-smoke.ts` to exercise release-only
  version rewriting, nightly metadata, and lockfile generation without
  publishing.
- **Native desktop** builds the web application, tests the desktop Rust host,
  and creates an unpublished native bundle on Linux x64, Windows x64, macOS
  arm64, and macOS x64 runners. Windows ARM is intentionally excluded while
  `scripts/run-msvc-x64.mjs` remains x64-specific.

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
- `.github/workflows/deploy-relay.yml` deploys the BiBCode Connect relay from
  `main` only when the required Cloudflare repository configuration exists.
- `.github/workflows/issue-labels.yml`, `pr-size.yml`, and `pr-vouch.yml` enforce
  repository-maintenance policy independently of the application quality
  gates.

When changing a workflow, update its focused workflow-contract tests and run
the repository gates documented in [Scripts](../reference/scripts.md).
