# ARM64 Desktop and Standalone Server Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and validate native desktop installers and self-contained standalone
server distributions for macOS, Linux, and Windows on x64 and ARM64.

**Architecture:** A shared release-target catalog owns the six native mappings. Separate
desktop and server matrices build native artifacts, while one release-assembly boundary
checks the complete contract, builds the six-target Tauri manifest, generates server
checksums, optionally signs server assets, and prevents partial publication. Packaged
servers include the production web build and discover it relative to the executable.

**Tech Stack:** TypeScript, Effect, Vite+, Rust 1.97.1, Tauri 2, GitHub Actions,
nFPM 2.47.0, Docker, WebdriverIO, NSIS, AppImage, DMG, Minisign.

**Spec:**
`docs/superpowers/specs/2026-08-31-arm64-desktop-server-release-design.md`

## Global Constraints

- Desktop and standalone server releases cover macOS, Linux, and Windows on x64 and
  ARM64; no architecture may silently fall back to x64 or emulation.
- Linux ARM64 AppImages build on `ubuntu-22.04-arm`; Windows ARM64 builds use
  `windows-11-vs2026-arm`.
- Stable Tauri updates require all six updater targets and the existing updater key.
- Server checksum generation is mandatory. Server Minisign signatures are optional and
  use a key distinct from the Tauri updater key.
- Server archives and packages include the version-matched production web build without
  adding a production Node.js runtime.
- Explicit `--static-dir` wins; an invalid explicit path fails instead of falling back.
- Linux packages install only package-owned executable, web, license, and documentation
  paths. They do not create services, accounts, configuration, firewall state, or user
  data.
- `.deb` and `.rpm` files are direct GitHub Release assets; no APT, DNF, or YUM repository
  is created.
- Headless server installation and updates remain manual; the desktop does not provision
  remote hosts.
- Preserve unrelated worktree changes. Never stage `.codegraph/` or edit `.repos/`.
- Follow repository naming, Effect, error, logging, test, and workflow pinning
  conventions.
- Every task uses a red-green-refactor cycle and ends in one focused commit.
- Final validation includes `vp check`, `vp run typecheck`, `vp run test`,
  `cargo fmt --all --check`, affected Rust tests, Clippy with warnings denied, workflow
  contract tests, `git diff --check`, and a final status review.

## Planned file structure

### Shared release policy

- Create `scripts/lib/release-targets.ts`: the six native target records and lookup
  functions.
- Create `scripts/lib/release-targets.test.ts`: exact target, runner, Rust triple, package
  architecture, and updater-key contract.
- Modify `scripts/build-desktop-artifact.ts`: consume the shared target catalog.
- Modify `scripts/build-tauri-update-manifest.ts`: require six updater targets.
- Modify `scripts/seeded-desktop-upgrade-smoke.ts`: use the same updater and Rust target
  mapping.

### Windows toolchain

- Create `scripts/run-msvc.mjs` and `scripts/run-msvc.test.mjs`: architecture-aware
  Visual Studio discovery and command launch.
- Delete `scripts/run-msvc-x64.mjs` and `scripts/run-msvc-x64.test.mjs` after all living
  callers move.
- Modify current package scripts, build helpers, coverage tooling, and measurements that
  invoke the Windows launcher. Historical plans remain unchanged.

### Packaged server runtime

- Create `apps/server/src/static_assets.rs`: explicit and executable-relative static web
  discovery.
- Modify `apps/server/src/config.rs`, `apps/server/src/lib.rs`, and
  `apps/server/src/lifecycle.rs`: apply and report the resolved source.
- Create `scripts/build-server-artifact.ts`: build/stage/archive the native server and web
  distribution.
- Create `scripts/build-server-artifact.test.ts`: staging, naming, safety, and command
  plans.
- Create `scripts/install-nfpm.ts` and `scripts/install-nfpm.test.ts`: pinned nFPM download
  with checksum verification.
- Create `apps/server/package/nfpm.yaml`: script-free `.deb` and `.rpm` metadata.

### Validation and release assembly

- Create `scripts/smoke-server-distribution.ts` and its test: start the staged server,
  serve web assets, pair, authenticate, and shut down.
- Create `scripts/test-linux-server-package.ts` and its test: native container install,
  startup, removal, and data-preservation matrix.
- Create `scripts/assemble-release-assets.ts` and its test: exact artifact-set validation,
  checksums, optional Minisign, and internal-descriptor cleanup.
- Modify `.github/workflows/release.yml`: separate six-target desktop and server matrices
  plus validated assembly.
- Modify `.github/workflows/ci.yml`, `.github/workflows/desktop-ui-smoke.yml`, and
  `.github/workflows/desktop-upgrade-smoke.yml`: Linux and Windows ARM64 native coverage.
- Modify `scripts/ci-platform-contract.test.ts` and `scripts/release-workflow.test.ts`:
  executable workflow contracts.

### Documentation and downloads

- Create `docs/user/server-installation.md`: living server installation guide and archive
  README source.
- Modify release, CI, script, Remote Access, testing, root README, and documentation index
  pages.
- Modify `apps/marketing/src/lib/releases.ts` and add its test: deterministic asset
  matching.
- Modify `apps/marketing/src/pages/download.astro` and
  `apps/marketing/src/pages/index.astro`: expose the full desktop and server matrix.

---

### Task 1: Establish the six-target release catalog and updater contract

**Files:**

- Create: `scripts/lib/release-targets.ts`
- Create: `scripts/lib/release-targets.test.ts`
- Modify: `scripts/build-desktop-artifact.ts`
- Modify: `scripts/build-desktop-artifact.test.ts`
- Modify: `scripts/build-tauri-update-manifest.ts`
- Modify: `scripts/build-tauri-update-manifest.test.ts`

**Interfaces:**

- Produces: `RELEASE_TARGETS`, `TAURI_UPDATE_TARGETS`, `ReleasePlatform`, `ReleaseArch`,
  `TauriUpdaterTarget`, `findReleaseTarget(platform, arch)`, and
  `requireReleaseTarget(platform, arch)`.
- Consumers: desktop packaging, server packaging, updater serialization, seeded upgrade
  testing, release assembly, and workflow contract tests.

- [ ] **Step 1: Write the failing target-catalog test**

```ts
import { describe, expect, it } from "vite-plus/test";

import { RELEASE_TARGETS, TAURI_UPDATE_TARGETS, requireReleaseTarget } from "./release-targets.ts";

describe("native release targets", () => {
  it("defines the exact six-target public contract", () => {
    expect(RELEASE_TARGETS.map(({ platform, arch, runner, rustTarget, updaterTarget }) => ({
      platform,
      arch,
      runner,
      rustTarget,
      updaterTarget,
    }))).toEqual([
      { platform: "mac", arch: "arm64", runner: "macos-26", rustTarget: "aarch64-apple-darwin", updaterTarget: "darwin-aarch64" },
      { platform: "mac", arch: "x64", runner: "macos-26-intel", rustTarget: "x86_64-apple-darwin", updaterTarget: "darwin-x86_64" },
      { platform: "linux", arch: "arm64", runner: "ubuntu-22.04-arm", rustTarget: "aarch64-unknown-linux-gnu", updaterTarget: "linux-aarch64" },
      { platform: "linux", arch: "x64", runner: "ubuntu-22.04", rustTarget: "x86_64-unknown-linux-gnu", updaterTarget: "linux-x86_64" },
      { platform: "win", arch: "arm64", runner: "windows-11-vs2026-arm", rustTarget: "aarch64-pc-windows-msvc", updaterTarget: "windows-aarch64" },
      { platform: "win", arch: "x64", runner: "windows-2025", rustTarget: "x86_64-pc-windows-msvc", updaterTarget: "windows-x86_64" },
    ]);
    expect(TAURI_UPDATE_TARGETS).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-aarch64",
      "linux-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ]);
    expect(requireReleaseTarget("linux", "arm64").debArch).toBe("arm64");
    expect(requireReleaseTarget("win", "arm64").serverArchive).toBe("zip");
  });
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

```bash
vp test run scripts/lib/release-targets.test.ts
```

Expected: FAIL because `scripts/lib/release-targets.ts` does not exist.

- [ ] **Step 3: Implement the catalog and strict lookup**

Create records with these fields and literal values:

```ts
export type ReleasePlatform = "mac" | "linux" | "win";
export type ReleaseArch = "arm64" | "x64";
export type ServerArchiveKind = "tar.gz" | "zip";

export interface ReleaseTarget {
  readonly platform: ReleasePlatform;
  readonly arch: ReleaseArch;
  readonly runner: string;
  readonly rustTarget: string;
  readonly desktopBundle: "dmg" | "appimage" | "nsis";
  readonly updaterTarget:
    | "darwin-aarch64"
    | "darwin-x86_64"
    | "linux-aarch64"
    | "linux-x86_64"
    | "windows-aarch64"
    | "windows-x86_64";
  readonly serverArchive: ServerArchiveKind;
  readonly serverOs: "darwin" | "linux" | "windows";
  readonly serverArch: "aarch64" | "x86_64";
  readonly debArch?: "amd64" | "arm64";
  readonly rpmArch?: "x86_64" | "aarch64";
}
```

Export strict lookup functions. `requireReleaseTarget` throws an error containing both
rejected values. Export `TAURI_UPDATE_TARGETS` in the exact order asserted above.

- [ ] **Step 4: Replace duplicated desktop and updater mappings**

In `build-desktop-artifact.ts`, alias its public platform/arch types to the catalog and
resolve `rustTarget` and `updaterManifestTarget` through `requireReleaseTarget`. Remove
the x64-only updater rejection.

In `build-tauri-update-manifest.ts`, import `TAURI_UPDATE_TARGETS` and
`TauriUpdaterTarget`; accept `.AppImage` for both `linux-*` targets and `.exe` for both
`windows-*` targets. Expand its schema to all six literal keys.

- [ ] **Step 5: Extend desktop and manifest tests for both ARM64 targets**

Add updater-plan assertions for `linux-aarch64` and `windows-aarch64`. Add fixture
artifacts `BiBCode_0.4.3_arm64.AppImage` and `BiBCode_0.4.3_arm64-setup.exe`. Require
manifest serialization to contain exactly six entries and reject a five-descriptor
fixture.

- [ ] **Step 6: Run the focused release-policy tests**

```bash
vp test run scripts/lib/release-targets.test.ts scripts/build-desktop-artifact.test.ts scripts/build-tauri-update-manifest.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the shared release policy**

```bash
git add scripts/lib/release-targets.ts scripts/lib/release-targets.test.ts scripts/build-desktop-artifact.ts scripts/build-desktop-artifact.test.ts scripts/build-tauri-update-manifest.ts scripts/build-tauri-update-manifest.test.ts
git commit -m "feat(release): define six native release targets"
```

### Task 2: Make the Windows MSVC launcher architecture-aware

**Files:**

- Create: `scripts/run-msvc.mjs`
- Create: `scripts/run-msvc.test.mjs`
- Delete: `scripts/run-msvc-x64.mjs`
- Delete: `scripts/run-msvc-x64.test.mjs`
- Modify: `scripts/run-tauri-build.mjs`
- Modify: `scripts/run-tauri-build.test.mjs`
- Modify: `scripts/check-rust-coverage.ts`
- Modify: `scripts/check-rust-coverage.test.ts`
- Modify: `scripts/measure-vcs-runtime.ts`
- Modify: `scripts/measure-vcs-runtime.test.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/e2e/support/build-packaged-app.ts`
- Modify: `apps/desktop/e2e/support/build-packaged-app.test.ts`
- Modify: `package.json`
- Modify: `scripts/bibcode-identity.test.ts`

**Interfaces:**

- Produces: `resolveMsvcArchitecture(args, env)`, `msvcToolchain(arch)`, and
  `runMsvc(args, options)`.
- Preserves: Cargo test-target canonicalization and the custom Windows Cargo runner.

- [ ] **Step 1: Copy the existing tests to the generic filename and add failing ARM64 cases**

```js
it("selects the ARM64 MSVC environment from an explicit Rust target", () => {
  expect(
    resolveMsvcArchitecture(
      ["cargo", "build", "--target", "aarch64-pc-windows-msvc"],
      { PROCESSOR_ARCHITECTURE: "AMD64" },
    ),
  ).toBe("arm64");
  expect(msvcToolchain("arm64")).toEqual({
    cargoRunnerKey: "CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_RUNNER",
    vcvarsArgument: "arm64",
    vsComponent: "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
  });
});
```

Also assert that `CARGO_BUILD_TARGET`, `TAURI_DESKTOP_ARCH`,
`PROCESSOR_ARCHITEW6432`, and `PROCESSOR_ARCHITECTURE` are checked in that order, and
that x64 remains the fallback on an x64 host.

- [ ] **Step 2: Run the new test and verify the exports are absent**

```bash
vp test run scripts/run-msvc.test.mjs
```

Expected: FAIL because `run-msvc.mjs` and its generic exports do not exist.

- [ ] **Step 3: Implement target parsing and architecture-specific Visual Studio setup**

Keep existing quoting, spawning, target-directory canonicalization, and temporary script
cleanup. Replace hard-coded x64 values with the returned toolchain record. Use
`vcvarsall.bat arm64` and `Microsoft.VisualStudio.Component.VC.Tools.ARM64` for ARM64;
retain `x64` and `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` for x64. The usage
string becomes `node scripts/run-msvc.mjs <command> <arguments>`.

- [ ] **Step 4: Move every living caller to the generic launcher**

Update current source, manifests, workflow comments, test expectations, and living docs.
Do not rewrite historical `docs/superpowers/` or `docs/plans/` artifacts. Rename injected
test variables from `runMsvcX64` to `runMsvc`.

```bash
rg -n "run-msvc-x64|runMsvcX64" package.json apps packages scripts .github docs/operations docs/reference docs/testing docs/user README.md
```

Expected after edits: no matches.

- [ ] **Step 5: Run affected launcher and contract tests**

```bash
vp test run scripts/run-msvc.test.mjs scripts/run-tauri-build.test.mjs scripts/check-rust-coverage.test.ts scripts/measure-vcs-runtime.test.ts apps/desktop/e2e/support/build-packaged-app.test.ts scripts/ci-platform-contract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the Windows toolchain boundary**

```bash
git add package.json apps/server/package.json apps/desktop/package.json apps/desktop/e2e/support/build-packaged-app.ts apps/desktop/e2e/support/build-packaged-app.test.ts scripts/run-msvc.mjs scripts/run-msvc.test.mjs scripts/run-msvc-x64.mjs scripts/run-msvc-x64.test.mjs scripts/run-tauri-build.mjs scripts/run-tauri-build.test.mjs scripts/check-rust-coverage.ts scripts/check-rust-coverage.test.ts scripts/measure-vcs-runtime.ts scripts/measure-vcs-runtime.test.ts scripts/bibcode-identity.test.ts scripts/ci-platform-contract.test.ts
git commit -m "refactor(windows): select the native MSVC architecture"
```

### Task 3: Discover packaged web assets in the standalone server

**Files:**

- Create: `apps/server/src/static_assets.rs`
- Modify: `apps/server/src/lib.rs`
- Modify: `apps/server/src/config.rs`
- Modify: `apps/server/src/lifecycle.rs`
- Modify: `apps/server/tests/cli_smoke.rs`

**Interfaces:**

- Produces: `StaticDirSource`, `ResolvedStaticDir`, `StaticDirError`, and
  `resolve_static_dir(explicit, executable)`.
- Consumes: the archive layout from Task 4 and `/usr/share/bibcode/web` from Task 5.

- [ ] **Step 1: Write failing resolution tests in the new Rust module**

```rust
#[test]
fn packaged_web_is_resolved_beside_the_executable() {
    let root = tempfile::tempdir().expect("distribution root");
    let executable = root.path().join("bibcode");
    std::fs::write(&executable, b"binary").expect("binary fixture");
    std::fs::create_dir(root.path().join("web")).expect("web directory");
    std::fs::write(root.path().join("web/index.html"), b"<main>BiBCode</main>")
        .expect("web entry point");

    let resolved = resolve_static_dir(None, &executable)
        .expect("resolve packaged web")
        .expect("packaged static directory");
    assert_eq!(resolved.source, StaticDirSource::Packaged);
    assert_eq!(resolved.path, root.path().join("web"));
}

#[test]
fn invalid_explicit_web_does_not_fall_back_to_packaged_assets() {
    let root = tempfile::tempdir().expect("distribution root");
    let executable = root.path().join("bibcode");
    std::fs::write(&executable, b"binary").expect("binary fixture");
    std::fs::create_dir(root.path().join("web")).expect("web directory");
    std::fs::write(root.path().join("web/index.html"), b"packaged")
        .expect("packaged entry point");

    let error = resolve_static_dir(Some(&root.path().join("missing")), &executable)
        .expect_err("invalid explicit static directory");
    assert!(matches!(error, StaticDirError::ExplicitInvalid { .. }));
}
```

Add a third test for an executable under `prefix/bin/bibcode` discovering
`prefix/share/bibcode/web/index.html` in a temporary equivalent layout.

- [ ] **Step 2: Run the focused Rust test and verify failure**

```bash
cargo test -p bibcode-server static_assets -- --nocapture
```

Expected: FAIL because the module and types do not exist.

- [ ] **Step 3: Implement the resolver with explicit precedence**

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StaticDirSource {
    Explicit,
    Packaged,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedStaticDir {
    pub path: std::path::PathBuf,
    pub source: StaticDirSource,
}

pub fn resolve_static_dir(
    explicit: Option<&std::path::Path>,
    executable: &std::path::Path,
) -> Result<Option<ResolvedStaticDir>, StaticDirError>;
```

Accept a directory only when `index.html` is a regular file. Check the executable's
sibling `web` first, then `<executable-parent>/../share/bibcode/web`. Do not inspect the
process working directory.

- [ ] **Step 4: Apply discovery only to CLI `start` and `serve`**

In `Cli::into_action`, resolve `std::env::current_exe()` and pass `args.static_dir` to the
helper before returning `ServerConfig`. Add `static_dir_source: Option<StaticDirSource>`
to `ServerConfig`; `with_static_dir` sets `Explicit`. Programmatic desktop configs remain
unchanged unless they explicitly set a static directory.

Add concrete `ConfigError` variants for current-executable resolution and static asset
resolution. After logging is initialized in `lifecycle.rs`, log the selected path and
source once.

- [ ] **Step 5: Add CLI coverage for explicit failure and packaged success**

Refactor only enough to inject an executable path into a package-private CLI conversion
helper. Test that `bibcode serve` uses packaged assets and that an explicit missing path
returns `ConfigError` before binding a listener.

- [ ] **Step 6: Run Rust tests, format, and Clippy**

```bash
cargo test -p bibcode-server static_assets -- --nocapture
cargo test -p bibcode-server --test cli_smoke -- --nocapture
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 7: Commit packaged static discovery**

```bash
git add apps/server/src/static_assets.rs apps/server/src/lib.rs apps/server/src/config.rs apps/server/src/lifecycle.rs apps/server/tests/cli_smoke.rs
git commit -m "feat(server): discover packaged web assets"
```

### Task 4: Build portable standalone server distributions

**Files:**

- Create: `scripts/build-server-artifact.ts`
- Create: `scripts/build-server-artifact.test.ts`
- Create: `docs/user/server-installation.md`
- Modify: `package.json`
- Modify: `scripts/bibcode-identity.test.ts`

**Interfaces:**

- Produces: `ServerArtifactPlan`, `planServerArtifact(input, host)`,
  `stageServerDistribution(plan)`, and the `build-server-artifact.ts` CLI.
- Consumes: `requireReleaseTarget` from Task 1 and the runtime layout from Task 3.
- Produces for Task 5: a validated staging directory containing binary, `web/`, README,
  and license.

- [ ] **Step 1: Write failing planning and staging tests**

```ts
it("plans the Linux ARM64 server archive from the shared target", async () => {
  const plan = await Effect.runPromise(
    planServerArtifact(
      {
        platform: "linux",
        arch: "arm64",
        version: "0.4.3",
        outputDir: "/tmp/out",
        skipBuild: true,
      },
      { platform: "linux", arch: "arm64" },
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  assert.equal(plan.target.rustTarget, "aarch64-unknown-linux-gnu");
  assert.equal(plan.archiveName, "bibcode-server-v0.4.3-linux-aarch64.tar.gz");
  assert.equal(plan.distributionRootName, "bibcode-server-v0.4.3-linux-aarch64");
});
```

Add a filesystem-backed test that stages fixtures and asserts exactly:

```text
bibcode-server-v0.4.3-linux-aarch64/bibcode
bibcode-server-v0.4.3-linux-aarch64/web/index.html
bibcode-server-v0.4.3-linux-aarch64/README.md
bibcode-server-v0.4.3-linux-aarch64/LICENSE
```

Reject a web fixture without `index.html`, a binary outside the expected target tree, and
an output directory overlapping the staging root.

- [ ] **Step 2: Run the builder test and verify failure**

```bash
vp test run scripts/build-server-artifact.test.ts
```

Expected: FAIL because the builder does not exist.

- [ ] **Step 3: Implement the build plan and safe staging boundary**

The CLI accepts:

```text
--platform mac|linux|win
--arch arm64|x64
--version <semver>
--output-dir <path>
--skip-build
--binary-path <path>
--web-dir <path>
--verbose
```

Without `--skip-build`, run the production web build followed by:

```bash
cargo build -p bibcode-server --bin bibcode --release --target <rust-target>
```

On Windows, run `node scripts/run-msvc.mjs cargo build -p bibcode-server --bin bibcode
--release --target <rust-target>`. Resolve all paths, reject
overlapping source, staging, and output trees, stage into a unique temporary sibling,
validate the complete layout, then rename it into place.

- [ ] **Step 4: Create archives from the validated staging tree**

Spawn native archive commands without shell interpolation:

```text
tar -czf <output.tar.gz> -C <staging-parent> <distribution-root-name>
tar -a -cf <output.zip> -C <staging-parent> <distribution-root-name>
```

List the result and reject absolute paths, `..` components, duplicate entries, or entries
outside the one versioned root.

- [ ] **Step 5: Add root package scripts for all six targets**

Add `dist:server:artifact` plus explicit
`dist:server:{mac,linux,win}:{arm64,x64}` scripts. Each explicit script supplies platform
and architecture; none depends on host-architecture inference.

- [ ] **Step 6: Write the initial living server installation guide**

Create `docs/user/server-installation.md` with archive extraction, direct execution,
`bibcode --version`, `bibcode serve --help`, listener safety, packaged web discovery,
manual updates, and user-data location. Do not document `.deb`/`.rpm` until Task 5
creates them.

- [ ] **Step 7: Run builder tests and a local skip-build smoke**

```bash
vp test run scripts/build-server-artifact.test.ts scripts/bibcode-identity.test.ts
vp run --filter @bibcode/web build
server_version="$(node -p "require('./apps/server/package.json').version")"
node scripts/build-server-artifact.ts --platform mac --arch arm64 --version "$server_version" --skip-build --binary-path target/debug/bibcode --web-dir apps/web/dist --output-dir /tmp/bibcode-server-plan-smoke
```

Expected: PASS on a macOS ARM64 planning host. On another host, replace `platform`,
`arch`, and binary path with that host's exact catalog target.

- [ ] **Step 8: Commit portable server artifacts**

```bash
git add package.json scripts/build-server-artifact.ts scripts/build-server-artifact.test.ts scripts/bibcode-identity.test.ts docs/user/server-installation.md
git commit -m "feat(release): build portable server distributions"
```

### Task 5: Add direct-download DEB and RPM packages

**Files:**

- Create: `scripts/install-nfpm.ts`
- Create: `scripts/install-nfpm.test.ts`
- Create: `apps/server/package/nfpm.yaml`
- Create: `scripts/server-package-contract.test.ts`
- Modify: `scripts/build-server-artifact.ts`
- Modify: `scripts/build-server-artifact.test.ts`
- Modify: `docs/user/server-installation.md`

**Interfaces:**

- Produces: `NFPM_PIN`, `planNfpmInstall(platform, arch)`, and a verified nFPM executable.
- Extends: Linux server builder output with exact `.deb` and `.rpm` assets.

- [ ] **Step 1: Write failing nFPM pin tests**

```ts
it("pins verified Linux nFPM archives for both native architectures", () => {
  expect(planNfpmInstall("linux", "x64")).toEqual(expect.objectContaining({
    version: "2.47.0",
    asset: "nfpm_2.47.0_Linux_x86_64.tar.gz",
    sha256: "0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783",
  }));
  expect(planNfpmInstall("linux", "arm64")).toEqual(expect.objectContaining({
    version: "2.47.0",
    asset: "nfpm_2.47.0_Linux_arm64.tar.gz",
    sha256: "1c0f5f2999b9a974bfb04fdb0cc3306096de530ac5dbb25d739cc5f5219c919c",
  }));
});
```

- [ ] **Step 2: Run the installer test and verify failure**

```bash
vp test run scripts/install-nfpm.test.ts
```

Expected: FAIL because the installer does not exist.

- [ ] **Step 3: Implement verified, cached nFPM installation**

Follow the atomic-download and checksum-verification pattern in
`scripts/prepare-tauri-appimage-tools.ts`. Download only from
`https://github.com/goreleaser/nfpm/releases/download/v2.47.0/`, verify bytes before
extraction, and publish the executable under `target/tools/nfpm/2.47.0/<arch>/nfpm`.
Reject non-Linux platforms and unsupported architectures.

- [ ] **Step 4: Write the package configuration contract first**

`server-package-contract.test.ts` reads the YAML and asserts:

```ts
expect(source).toContain("name: bibcode-server");
expect(source).toContain("dst: /usr/bin/bibcode");
expect(source).toContain("dst: /usr/share/bibcode/web");
expect(source).toContain("dst: /usr/share/doc/bibcode-server/README.md");
expect(source).toContain("dst: /usr/share/doc/bibcode-server/LICENSE");
expect(source).not.toMatch(/scripts:|systemd|firewall|useradd|groupadd/);
```

- [ ] **Step 5: Create `nfpm.yaml` with environment-supplied source paths**

Use package name `bibcode-server`, release `1`, MIT license, homepage
`https://github.com/mubeda/BibCode`, and maintainer
`BiBCode Maintainers <mubeda@users.noreply.github.com>`. Consume:

```text
BIBCODE_SERVER_PACKAGE_ARCH
BIBCODE_SERVER_PACKAGE_ROOT
BIBCODE_SERVER_PACKAGE_VERSION
```

Map the staged binary, `web/`, README, and license to exact package destinations. Declare
no scripts, services, configuration files, Node dependency, or network side effects.

- [ ] **Step 6: Extend the Linux builder to run nFPM twice**

After portable staging validation, execute:

```bash
nfpm package --config apps/server/package/nfpm.yaml --packager deb --target <exact-deb-path>
nfpm package --config apps/server/package/nfpm.yaml --packager rpm --target <exact-rpm-path>
```

Use names `bibcode-server_VERSION_amd64.deb`, `bibcode-server_VERSION_arm64.deb`,
`bibcode-server-VERSION-1.x86_64.rpm`, and
`bibcode-server-VERSION-1.aarch64.rpm`. Inspect package metadata after creation and reject
a mismatched name, version, architecture, or owned path.

- [ ] **Step 7: Expand server installation documentation**

Add direct GitHub `.deb` and `.rpm` install/upgrade/removal commands, checksum
verification, package-owned paths, and the promise that removal leaves `~/.bibcode`
untouched. State that BiBCode does not host APT or RPM repositories.

- [ ] **Step 8: Run focused package tests**

```bash
vp test run scripts/install-nfpm.test.ts scripts/server-package-contract.test.ts scripts/build-server-artifact.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Linux server packages**

```bash
git add scripts/install-nfpm.ts scripts/install-nfpm.test.ts apps/server/package/nfpm.yaml scripts/server-package-contract.test.ts scripts/build-server-artifact.ts scripts/build-server-artifact.test.ts docs/user/server-installation.md
git commit -m "feat(release): package Linux servers as deb and rpm"
```

### Task 6: Exercise staged servers and installed Linux packages

**Files:**

- Create: `scripts/smoke-server-distribution.ts`
- Create: `scripts/smoke-server-distribution.test.ts`
- Create: `scripts/test-linux-server-package.ts`
- Create: `scripts/test-linux-server-package.test.ts`

**Interfaces:**

- Produces: `smokeServerDistribution(input, runtime)`,
  `LINUX_SERVER_PACKAGE_SMOKE_TARGETS`, and
  `buildLinuxPackageSmokePlan(target, input)`.
- Consumes: staged archive roots and Linux packages from Tasks 4 and 5.

- [ ] **Step 1: Write failing staged-distribution smoke tests with an injected runtime**

```ts
it("requires web, environment, pairing, token exchange, and clean exit", async () => {
  const events: string[] = [];
  await smokeServerDistribution(
    { binary: "/fixture/bibcode", expectedVersion: "0.4.3", timeoutMs: 30_000 },
    fakeDistributionRuntime(events),
  );
  expect(events).toEqual([
    "version:0.4.3",
    "spawn:serve",
    "get:/",
    "get:/.well-known/bibcode/environment",
    "pairing:issue",
    "post:/oauth/token",
    "terminate",
    "exit:0",
  ]);
});
```

Add timeout, invalid readiness JSON, missing web entry point, failed token exchange, and
nonzero-exit cases.

- [ ] **Step 2: Run smoke tests and verify failure**

```bash
vp test run scripts/smoke-server-distribution.test.ts
```

Expected: FAIL because the smoke harness does not exist.

- [ ] **Step 3: Implement the real staged-distribution smoke**

Run `bibcode --version`, then start:

```text
bibcode serve --host 127.0.0.1 --port 0 --base-dir <temporary-root>
```

Parse the first stdout JSON line, GET `/` and the environment descriptor, invoke
`bibcode pairing issue --base-dir <temporary-root> --label "Distribution smoke" --json`,
exchange the credential at `/oauth/token`, then terminate and await the owned process.
Keep stdout/stderr bounded and redact credentials from errors and evidence.

- [ ] **Step 4: Define the exact Linux container matrix in a failing test**

```ts
expect(LINUX_SERVER_PACKAGE_SMOKE_TARGETS).toEqual([
  { format: "deb", image: "ubuntu:22.04" },
  { format: "deb", image: "ubuntu:24.04" },
  { format: "deb", image: "debian:12" },
  { format: "rpm", image: "rockylinux:9" },
  { format: "rpm", image: "fedora:44" },
]);
```

For both host architectures, require the container script to verify `uname -m`, inspect
package metadata, install locally, run `bibcode --version`, start the server, GET `/`,
remove the package, assert `/usr/bin/bibcode` is absent, and assert a sentinel under an
isolated data root remains.

- [ ] **Step 5: Implement Docker planning and bounded execution**

Mount only the package and a generated smoke script read-only. Use `apt-get install -y
/artifacts/<file>` for `.deb`, `dnf install -y /artifacts/<file>` for `.rpm`, and the
matching package-manager removal command. Set a timeout and always stop a uniquely named
test-owned container after failure.

- [ ] **Step 6: Run focused smoke-planning tests**

```bash
vp test run scripts/smoke-server-distribution.test.ts scripts/test-linux-server-package.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit distribution validation**

```bash
git add scripts/smoke-server-distribution.ts scripts/smoke-server-distribution.test.ts scripts/test-linux-server-package.ts scripts/test-linux-server-package.test.ts
git commit -m "test(release): validate standalone server distributions"
```

### Task 7: Assemble and verify the complete release asset set

**Files:**

- Create: `scripts/assemble-release-assets.ts`
- Create: `scripts/assemble-release-assets.test.ts`
- Modify: `scripts/release-smoke.ts`
- Modify: `scripts/release-smoke.test.ts`

**Interfaces:**

- Produces: `assembleReleaseAssets(input)`, `expectedServerAssetNames(version)`,
  `writeServerChecksums(directory, assets)`, and `serverSigningPlan(input)`.
- Consumes: completed desktop/server assets and optional signing-key paths.
- Produces: the final publishable directory with internal updater descriptors removed.

- [ ] **Step 1: Write failing exact-set and checksum tests**

```ts
it("requires six archives and four Linux packages", () => {
  expect(expectedServerAssetNames("0.4.3")).toEqual([
    "bibcode-server-v0.4.3-darwin-aarch64.tar.gz",
    "bibcode-server-v0.4.3-darwin-x86_64.tar.gz",
    "bibcode-server-v0.4.3-linux-aarch64.tar.gz",
    "bibcode-server-v0.4.3-linux-x86_64.tar.gz",
    "bibcode-server-v0.4.3-windows-aarch64.zip",
    "bibcode-server-v0.4.3-windows-x86_64.zip",
    "bibcode-server_0.4.3_amd64.deb",
    "bibcode-server_0.4.3_arm64.deb",
    "bibcode-server-0.4.3-1.aarch64.rpm",
    "bibcode-server-0.4.3-1.x86_64.rpm",
  ]);
});
```

Build temporary fixtures and assert sorted `sha256  filename` lines, duplicate basename
rejection, unexpected file rejection, missing ARM64 rejection, and stale-version
rejection.

- [ ] **Step 2: Run the assembler test and verify failure**

```bash
vp test run scripts/assemble-release-assets.test.ts
```

Expected: FAIL because the assembler does not exist.

- [ ] **Step 3: Implement classification and mandatory checksums**

Validate desktop installers against target-specific suffix rules, updater descriptors
against all six stable targets, and server files against exact names. Stream SHA-256 over
the ten server artifacts and write `bibcode-server-SHA256SUMS` atomically in lexical
filename order.

- [ ] **Step 4: Implement optional Minisign planning**

Accept both `--server-signing-key` and `--server-signing-public-key`, or neither. One
without the other is fatal. When present, execute and check:

```text
minisign -S -s <private-key> -m <asset> -x <asset>.minisig
minisign -V -p <public-key> -m <asset> -x <asset>.minisig
```

Sign each server artifact and the checksum file. Do not print key material. When absent,
emit no `.minisig` files and write an unsigned notice to a caller-provided step-summary
path.

- [ ] **Step 5: Remove only internal updater descriptors**

After `latest.json` is built and verified, delete `updater-*.json` descriptors from the
publishable directory. Preserve `latest.json`, updater payloads, server assets,
checksums, and optional signatures.

- [ ] **Step 6: Extend release-smoke fixtures**

Keep version alignment for `apps/server/Cargo.toml`. Add an assembler fixture proving
nightly releases omit `latest.json` but retain all server artifacts and checksums.

- [ ] **Step 7: Run assembler and release-smoke tests**

```bash
vp test run scripts/assemble-release-assets.test.ts scripts/release-smoke.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit atomic asset assembly**

```bash
git add scripts/assemble-release-assets.ts scripts/assemble-release-assets.test.ts scripts/release-smoke.ts scripts/release-smoke.test.ts
git commit -m "feat(release): verify desktop and server asset sets"
```

### Task 8: Integrate separate native desktop and server release matrices

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `scripts/ci-platform-contract.test.ts`
- Modify: `scripts/release-workflow.test.ts`
- Modify: `scripts/workflow-dependencies.test.ts`

**Interfaces:**

- Consumes: all build, package, smoke, and assembly CLIs from Tasks 1 through 7.
- Produces: `build_desktop`, `build_server`, and release-assembly jobs with unique
  architecture-scoped artifacts.

- [ ] **Step 1: Change workflow tests to require both exact matrices**

Require `build_desktop.strategy.matrix.include` and
`build_server.strategy.matrix.include` to each cover:

```ts
[
  { label: "macOS arm64", runner: "macos-26", platform: "mac", arch: "arm64" },
  { label: "macOS x64", runner: "macos-26-intel", platform: "mac", arch: "x64" },
  { label: "Linux arm64", runner: "ubuntu-22.04-arm", platform: "linux", arch: "arm64" },
  { label: "Linux x64", runner: "ubuntu-22.04", platform: "linux", arch: "x64" },
  { label: "Windows arm64", runner: "windows-11-vs2026-arm", platform: "win", arch: "arm64" },
  { label: "Windows x64", runner: "windows-2025", platform: "win", arch: "x64" },
]
```

Desktop rows additionally require `target`; server rows require `serverOs` and
`serverArch`. Require the release job to depend on both matrix jobs.

- [ ] **Step 2: Run workflow tests and verify missing jobs/rows**

```bash
vp test run scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts
```

Expected: FAIL because the current workflow has four desktop rows and no server job.

- [ ] **Step 3: Expand and rename the desktop job**

Rename `build` to `build_desktop`, add Linux and Windows ARM64 rows, retain Linux
dependencies and stable updater signing, and upload
`desktop-${platform}-${arch}` artifacts.

- [ ] **Step 4: Add the six-target server job**

For every row: checkout the preflight ref, install Vite+ and Rust 1.97.1, align release
versions, build the web app, build the native server, package it, run distribution smoke,
run Linux package container smokes where applicable, and upload
`server-${platform}-${arch}`.

For Linux, compile inside a same-architecture `ubuntu:20.04` container so the glibc floor
is no newer than the documented package test systems. Assert container `uname -m`
matches the matrix architecture before compilation. Package and test on the native host
after the compatibility build.

- [ ] **Step 5: Replace shell asset collection with the assembler**

Download `desktop-*` and `server-*` into isolated directories, reject duplicate
basenames, build and verify `latest.json` for updater candidates, then run
`assemble-release-assets.ts`.

Materialize optional server signing secrets into permission-0600 files under
`RUNNER_TEMP`; pass both key paths or neither. Stable and nightly upload steps use only
the validated publishable directory.

- [ ] **Step 6: Preserve draft verification and manual publication**

Keep the existing stable draft, expected-versus-uploaded comparison, `publish=true`
rerun, latest marking, and finalize behavior. Extend expected assets to server files,
checksums, and optional signatures. Never combine files from an older workflow attempt.

- [ ] **Step 7: Run workflow contracts and release smoke**

```bash
vp test run scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts scripts/release-smoke.test.ts
node scripts/release-smoke.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the release workflow**

```bash
git add .github/workflows/release.yml scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts
git commit -m "ci(release): publish six desktop and server targets"
```

### Task 9: Expand native CI, packaged UI, and updater smoke to ARM64

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/desktop-ui-smoke.yml`
- Modify: `.github/workflows/desktop-upgrade-smoke.yml`
- Modify: `apps/desktop/e2e/support/build-packaged-app.ts`
- Modify: `apps/desktop/e2e/support/build-packaged-app.test.ts`
- Modify: `scripts/seeded-desktop-upgrade-smoke.ts`
- Modify: `scripts/seeded-desktop-upgrade-smoke.test.ts`
- Modify: `scripts/ci-platform-contract.test.ts`

**Interfaces:**

- Consumes: target catalog and architecture-aware MSVC launcher.
- Produces: native build, UI, screenshot/log, and real updater evidence for Linux and
  Windows ARM64.

- [ ] **Step 1: Write failing UI build-target tests**

Extend `PackagedDesktopUiBuildInput` with `arch`. Require:

```ts
expect(planPackagedDesktopUiBuild({ platform: "win", arch: "arm64" }).args).toContain(
  "aarch64-pc-windows-msvc",
);
expect(planPackagedDesktopUiBuild({ platform: "linux", arch: "arm64" }).args).toContain(
  "aarch64-unknown-linux-gnu",
);
```

The build command includes `--target <rust-target>` and the workflow exports
`BIBCODE_E2E_ARCH`.

- [ ] **Step 2: Write failing seeded-upgrade ARM64 tests**

Delete the Windows-x64-only parser expectation. Assert Windows ARM64 parses, maps to
`windows-aarch64`, and builds all three seeded applications with
`aarch64-pc-windows-msvc`. Add Linux ARM64 assertions for `linux-aarch64` and
`aarch64-unknown-linux-gnu`. Keep WSL coverage x64-only.

- [ ] **Step 3: Run focused tests and verify current ARM64 rejection**

```bash
vp test run apps/desktop/e2e/support/build-packaged-app.test.ts scripts/seeded-desktop-upgrade-smoke.test.ts scripts/ci-platform-contract.test.ts
```

Expected: FAIL on missing target arguments, Windows ARM64 rejection, and four-row
matrices.

- [ ] **Step 4: Use the target catalog in both harnesses**

Resolve Rust and updater targets through `requireReleaseTarget`. Pass `--target` into
packaged UI and seeded Tauri builds. Keep WSL's explicit
`x86_64-unknown-linux-gnu` server lane unchanged.

- [ ] **Step 5: Add Linux and Windows ARM64 workflow rows**

Add to native CI, packaged UI smoke, and seeded upgrade smoke:

```yaml
- label: Linux arm64
  runner: ubuntu-22.04-arm
  platform: linux
  arch: arm64
  bundle: appimage
- label: Windows arm64
  runner: windows-11-vs2026-arm
  platform: win
  arch: arm64
  bundle: nsis
```

Use `target` instead of `bundle` where that workflow schema uses `target`. Preserve
`fail-fast: false`, screenshots/logs, Linux Xvfb/AppImage checks, Windows silent install,
and bounded cleanup.

- [ ] **Step 6: Run the complete platform-contract group**

```bash
vp test run apps/desktop/e2e/support/build-packaged-app.test.ts scripts/seeded-desktop-upgrade-smoke.test.ts scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit native ARM64 validation**

```bash
git add .github/workflows/ci.yml .github/workflows/desktop-ui-smoke.yml .github/workflows/desktop-upgrade-smoke.yml apps/desktop/e2e/support/build-packaged-app.ts apps/desktop/e2e/support/build-packaged-app.test.ts scripts/seeded-desktop-upgrade-smoke.ts scripts/seeded-desktop-upgrade-smoke.test.ts scripts/ci-platform-contract.test.ts
git commit -m "ci: validate Linux and Windows ARM64 releases"
```

### Task 10: Publish accurate installation and download documentation

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/operations/release.md`
- Modify: `docs/operations/ci.md`
- Modify: `docs/reference/scripts.md`
- Modify: `docs/user/remote-access.md`
- Modify: `docs/user/server-installation.md`
- Modify: `docs/testing/README.md`
- Modify: `docs/testing/cross-platform-validation.md`
- Modify: `docs/testing/linux-desktop.md`
- Modify: `docs/testing/windows-desktop.md`
- Modify: `docs/testing/macos-desktop.md`
- Modify: `README.md`
- Modify: `apps/marketing/src/lib/releases.ts`
- Create: `apps/marketing/src/lib/releases.test.ts`
- Modify: `apps/marketing/src/pages/download.astro`
- Modify: `apps/marketing/src/pages/index.astro`

**Interfaces:**

- Produces: living support/runbook contract and deterministic release-asset resolver.
- Consumes: exact artifact names and support matrices implemented in earlier tasks.

- [ ] **Step 1: Add failing marketing asset-resolution tests**

```ts
it("resolves desktop and server ARM64 assets without matching signatures", () => {
  const assets = [
    { name: "BiBCode_0.4.3_arm64-setup.exe", browser_download_url: "desktop-win-arm" },
    { name: "BiBCode_0.4.3_arm64-setup.exe.sig", browser_download_url: "signature" },
    { name: "bibcode-server-v0.4.3-windows-aarch64.zip", browser_download_url: "server-win-arm" },
    { name: "bibcode-server_0.4.3_arm64.deb", browser_download_url: "server-deb-arm" },
  ];
  expect(findReleaseAsset(assets, "arm64-setup.exe")?.browser_download_url).toBe("desktop-win-arm");
  expect(findReleaseAsset(assets, "-windows-aarch64.zip")?.browser_download_url).toBe("server-win-arm");
  expect(findReleaseAsset(assets, "_arm64.deb")?.browser_download_url).toBe("server-deb-arm");
});
```

- [ ] **Step 2: Run the marketing test and verify the helper is missing**

```bash
vp test run apps/marketing/src/lib/releases.test.ts
```

Expected: FAIL because `findReleaseAsset` does not exist.

- [ ] **Step 3: Implement exact suffix matching and use it on both pages**

Export a pure helper excluding `.sig`, `.minisig`, `.sbom`, and checksum assets. Render
desktop cards for all six native installers and a Standalone Server section with six
archives plus Linux `.deb` and `.rpm` choices. Label format, architecture, and manual
installation honestly.

- [ ] **Step 4: Update living release and CI documentation**

Document both six-target runner matrices, updater keys, server asset names, checksums,
optional server signatures, direct-download packages, Ubuntu 20.04 server build baseline,
package test systems, current macOS/Windows trust limitations, and atomic drafts.

- [ ] **Step 5: Update Remote Access and installation guidance**

Link the server guide from the docs index and Remote Access guide. Document archive
extraction, package install/remove, automatic packaged-web discovery, explicit
`--static-dir` precedence, private-network safety, pairing, manual replacement updates,
checksums, optional Minisign, and preserved `~/.bibcode` data.

- [ ] **Step 6: Update all three native testing runbooks**

Add ARM64 support, server archive/package inventory, architecture inspection,
startup/pairing/web checks, Linux container matrix, UI and updater evidence, cleanup, and
execution-report fields. Keep machine-specific versions, paths, screenshots, and timings
out of living runbooks.

- [ ] **Step 7: Run docs/download contracts and marketing build**

```bash
vp test run apps/marketing/src/lib/releases.test.ts scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts
vp run build:marketing
rg -n "Windows ARM remains unsupported|supported release target is Linux x64|run-msvc-x64" docs/operations docs/reference docs/testing docs/user README.md
```

Expected: tests/build pass and the audit returns no stale support or launcher claims.

- [ ] **Step 8: Commit living documentation and downloads**

```bash
git add docs/README.md docs/operations/release.md docs/operations/ci.md docs/reference/scripts.md docs/user/remote-access.md docs/user/server-installation.md docs/testing/README.md docs/testing/cross-platform-validation.md docs/testing/linux-desktop.md docs/testing/windows-desktop.md docs/testing/macos-desktop.md README.md apps/marketing/src/lib/releases.ts apps/marketing/src/lib/releases.test.ts apps/marketing/src/pages/download.astro apps/marketing/src/pages/index.astro
git commit -m "docs: publish desktop and server installation matrix"
```

### Task 11: Run final local and native release verification

**Files:**

- Modify only files required to fix failures caused by Tasks 1 through 10.
- Do not add unrelated cleanup.

**Interfaces:**

- Consumes: every implementation and validation boundary in this plan.
- Produces: a clean branch ready for native GitHub Actions execution and review.

- [ ] **Step 1: Run the complete focused TypeScript and workflow group**

```bash
vp test run scripts/lib/release-targets.test.ts scripts/build-desktop-artifact.test.ts scripts/build-tauri-update-manifest.test.ts scripts/run-msvc.test.mjs scripts/run-tauri-build.test.mjs scripts/build-server-artifact.test.ts scripts/install-nfpm.test.ts scripts/server-package-contract.test.ts scripts/smoke-server-distribution.test.ts scripts/test-linux-server-package.test.ts scripts/assemble-release-assets.test.ts scripts/seeded-desktop-upgrade-smoke.test.ts scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts scripts/release-smoke.test.ts apps/desktop/e2e/support/build-packaged-app.test.ts apps/marketing/src/lib/releases.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Rust runtime and CLI validation**

```bash
cargo test -p bibcode-server static_assets -- --nocapture
cargo test -p bibcode-server --test cli_smoke -- --nocapture
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 3: Run mandatory repository gates sequentially**

```bash
vp check
vp run typecheck
vp run test
```

Expected: PASS. Do not run `vp run test` concurrently with another broad Cargo suite.

- [ ] **Step 4: Build and smoke the host-native server distribution**

On the current macOS ARM64 host, run:

```bash
vp run --filter @bibcode/web build
server_version="$(node -p "require('./apps/server/package.json').version")"
node scripts/build-server-artifact.ts --platform mac --arch arm64 --version "$server_version" --output-dir release/server-local --verbose
node scripts/smoke-server-distribution.ts --binary "release/server-local/staging/bibcode-server-v${server_version}-darwin-aarch64/bibcode" --expected-version "$server_version"
```

On another execution host, replace only platform, architecture, and staged binary path
with that host's exact catalog entry. Record the exact command and result.

- [ ] **Step 5: Inspect final changes and generated output**

```bash
git diff --check
git status --short
git diff --stat
git diff -- . ':!docs/superpowers/plans/2026-08-31-arm64-desktop-server-releases.md'
```

Use documented cleanup commands only for test-owned output. Confirm there are no secrets,
debug logs, accidental lockfile changes, `.codegraph/` entries, or `.repos/` edits.

- [ ] **Step 6: Commit validation-only corrections when present**

If validation required scoped corrections, stage their exact files and run:

```bash
git commit -m "fix(release): satisfy cross-platform distribution gates"
```

If no corrections were required, do not create an empty commit.

- [ ] **Step 7: Require native GitHub Actions evidence before completion**

After the implementation branch is published through the user-approved Git workflow,
require successful Linux ARM64 and Windows ARM64 rows in CI native desktop, packaged UI,
seeded upgrade, and release server matrices. Require the corresponding x64 and macOS rows
as regression evidence. Download bounded screenshots, logs, package inventories, and
server smoke evidence. Use a non-publishing validation path or inspected draft; do not
publish a stable release merely to test the workflow.

- [ ] **Step 8: Produce the completion report**

Report exact commands, local results, native workflow URLs/statuses, artifact names,
unavailable checks, and residual OS-signing risk. State that affected runbooks were
updated; if any reviewed runbook required no edit, state that it was reviewed and remains
accurate.
