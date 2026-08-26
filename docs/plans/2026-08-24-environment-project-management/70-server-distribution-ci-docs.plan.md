# Server Distribution, CI, Documentation, And Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship independently installable BiBCode Server artifacts for Windows, macOS, and Linux, connect to them securely after installation, preserve the working desktop release pipeline, and update every living installation/usage/administration/testing document for the approved environment model.

**Architecture:** A deterministic server staging layout contains one native `bibcode` executable, one compiled web asset tree, service/package metadata, and notices—never a production Node runtime or desktop shell. Native runners turn that layout into portable archives and OS installers. A typed, signed artifact manifest is the sole discovery source for WSL/SSH provisioning. Separate release jobs build, sign, smoke, attest, aggregate, and only then publish the complete desktop-plus-server release.

**Tech Stack:** Rust 2024/Cargo, React/Vite static assets, TypeScript 7 repository tooling, WiX Toolset 7, macOS `lipo`/`pkgbuild`/`productbuild`/`codesign`/`notarytool`, `cargo-deb`, `cargo-generate-rpm`, Minisign-compatible detached signatures, CycloneDX, GitHub Actions artifact attestations, native OS service managers from Plan 30.

**Spec:** [Distribution, documentation, and verification specification](./05-distribution-docs-and-verification.spec.md)

## Global Constraints

- Start after Plan 60. No server or desktop artifact may contain BiBCode Connect, Clerk, Cloudflare relay, managed-endpoint, telemetry, analytics, or automated crash-upload code/configuration.
- The server product includes `bibcode` plus compiled `apps/web` assets. It includes no Tauri/WebView shell, Node executable, TypeScript runtime, production package manager, or privileged helper sidecar.
- Release artifact discovery uses the signed machine-readable manifest from this plan. Neither Plan 40 nor release smoke may guess filenames.
- Stable Windows MSI files and their contained executable are Authenticode signed. A clearly marked local `unsigned-test` output may exist but cannot enter a stable release job or manifest as signed.
- macOS Developer ID signing and notarization remain optional. The existing desktop `signingIdentity: "-"` baseline and its mounted-DMG `codesign` verification remain unchanged and required.
- A credential-free server build succeeds on macOS and records binary/package signing and notarization honestly as `adhoc`/`none`/`false`; it does not pretend an unsigned PKG is signed.
- Tauri updater signatures remain a separate desktop integrity system. Do not reuse their manifest or call an Apple/Windows signature an updater signature.
- Linux direct-download DEB/RPM artifacts rely on the common detached signature/checksum/provenance in this phase; no package repository or repository-signing key is implied.
- Default installation is per-user workstation mode on loopback. Headless/system mode is a separate explicit elevated command using a dedicated least-privileged account.
- Uninstall stops and removes package-owned binary/service files but preserves data and backups. Purge is a separate identity-verified operation and never an installer checkbox/property.
- Portable archives never register or start a service silently.
- Cross-built/static inspection is not native support evidence. Every stable architecture must execute its packaged binary and installer behavior on the matching architecture before publication.
- CI/release network access is limited to source/dependency, signing/timestamp, GitHub artifact/release, and attestation endpoints documented in operations guidance. Installed runtime performs no telemetry or unexpected outbound call.

---

## File Structure

- Create: `apps/server/src/install_layout.rs`, tests; modify config/CLI/runtime to resolve a verified packaged web root.
- Create: `packages/contracts/src/serverArtifact.ts`, test/export updates (initial shape may arrive in Plan 40).
- Create: `tools/server-packager/**` — deterministic layout/archive/manifest verifier CLI.
- Create: `scripts/build-server-artifact.ts`, test; `scripts/verify-server-artifacts.ts`, test.
- Create: `packaging/server/common/**`, `windows/**`, `macos/**`, `linux/**`.
- Modify: `Cargo.toml`, `Cargo.lock`, `apps/server/Cargo.toml`, root/apps package scripts.
- Create: server package lifecycle/install-smoke coverage under `apps/server/tests/**` and `scripts/server-install-smoke.ts`.
- Create: `.github/workflows/server-native-smoke.yml`; modify `ci.yml` and `release.yml` without replacing desktop jobs.
- Modify: `scripts/release-smoke.ts`, release/workflow/platform/privacy tests.
- Create/update: getting-started, environment usage, server administration, release, architecture, reference, privacy, and all affected native/testing runbooks.

### Task 1: Define and verify the installed server layout

**Files:**

- Create: `apps/server/src/install_layout.rs`
- Modify: `apps/server/src/lib.rs`, `config.rs`, `http.rs`, `lifecycle.rs`
- Test: `apps/server/tests/install_layout.rs`, `server_runtime.rs`, `cli_smoke.rs`
- Create: `packaging/server/common/install-layout.json`
- Create: `packaging/server/common/THIRD-PARTY-NOTICES.md` generation input/README

**Canonical staged layout:**

```text
bibcode-server/
├── README.md
├── bin/bibcode[.exe]
├── share/bibcode/web/index.html
├── share/bibcode/web/assets/**
├── share/bibcode/web-assets.json
├── share/bibcode/install-layout.json
├── share/bibcode/build-metadata.json
├── share/bibcode/LICENSE
└── share/bibcode/THIRD-PARTY-NOTICES.md
```

- [x] **Step 1: Write failing path, integrity, and runtime tests**

Cover a valid relocated layout, Windows/POSIX separators, executable symlink, missing `index.html`, escaped/static-root symlink, asset manifest mismatch, read-only installation, hostile current working directory, portable foreground invocation, service invocation, and development `--static-dir` override.

```rust
assert_eq!(resolve_installed_web_root(&exe)?, root.join("share/bibcode/web"));
assert!(resolve_installed_web_root(&escaped_exe).is_err());
```

- [x] **Step 2: Run the focused server tests and confirm RED**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test install_layout -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test server_runtime static -- --nocapture
```

- [x] **Step 3: Resolve assets from signed package metadata, not CWD**

`install-layout.json` contains schema version, product, binary-relative web path, web asset manifest path, and package version. Canonicalize the executable/layout/root, reject path escape, then feed the verified root into the existing static handler. `--static-dir` remains an explicit development/admin override and is recorded in diagnostics.

- [x] **Step 4: Fail packaged startup when required assets are absent or altered**

In installed/service mode, do not silently start an API-only server if the packaged UI is missing. Return a redacted repair error naming the installation root and reinstall command. Portable `serve --no-browser` can opt into API-only behavior only with an explicit `--without-web-ui`; service definitions never set it.

- [x] **Step 5: Keep same-origin browser behavior and CSP**

Serve compiled assets and API/WebSocket from the same loopback origin, preserve traversal/symlink defenses and cache policy, and verify no external runtime CDN/font/script is required. Opening the browser is explicit/interactive; service startup never launches one.

- [x] **Step 6: Run tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test install_layout -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test server_runtime -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test cli_smoke -- --nocapture
git add apps/server/src apps/server/tests/install_layout.rs apps/server/tests/server_runtime.rs apps/server/tests/cli_smoke.rs packaging/server/common
git commit -m "feat(server): run from a verified packaged web layout"
```

### Task 2: Make the server artifact manifest the only discovery source

**Files:**

- Create or complete: `packages/contracts/src/serverArtifact.ts`, `serverArtifact.test.ts`
- Modify: `packages/contracts/src/index.ts`, `package.json`
- Create: `tools/server-packager/Cargo.toml`, `src/main.rs`, `src/model.rs`, `src/verify.rs`
- Test: `tools/server-packager/tests/manifest.rs`, `archive.rs`
- Modify: root `Cargo.toml`, `Cargo.lock`
- Create: `scripts/verify-server-artifacts.ts`, `verify-server-artifacts.test.ts`
- Modify: `apps/desktop/src-tauri/src/server_artifacts.rs`, WSL/SSH artifact fixtures
- Create: `apps/desktop/src-tauri/fixtures/server-artifacts/**`
- Modify: `packaging/server/server-release.pub` (pre-release fixture key; production rotation remains Task 6)

- [x] **Step 1: Expand Plan 40's fixture schema into the release schema**

```ts
export const ServerArtifactRecordSchema = Schema.Struct({
  product: Schema.Literal("bibcode-server"),
  version: Schema.String,
  sourceSha: Schema.String,
  targetTriple: Schema.String,
  os: Schema.Literals(["windows", "macos", "linux"]),
  architecture: Schema.Literals(["x86_64", "aarch64", "universal"]),
  format: Schema.Literals(["zip", "tar.gz", "msi", "pkg", "deb", "rpm"]),
  downloadName: SafeArtifactBasename,
  size: Schema.Number,
  sha256: Sha256Hex,
  signatureName: SafeArtifactBasename,
  sbomName: SafeArtifactBasename,
  nativeSigning: NativeSigningStateSchema,
  notarized: Schema.Boolean,
});
```

The top-level manifest has `schemaVersion: 1`, release version/channel, source SHA, generated-at timestamp derived from release metadata, required matrix, records, and detached manifest signature name.

- [x] **Step 2: Write rejection tests before the verifier**

Cover duplicate tuple, missing required tuple, extra product, filename traversal/Unicode confusable separator, bad size/hash/signature/SBOM link, wrong source/version, mismatched target triple, unsupported signing state, universal PKG without both slices, and stable Windows record not marked verified.

- [x] **Step 3: Add deterministic archive/manifest tooling**

Add `server-packager stage|archive|manifest|verify`. Sort paths by UTF-8 byte order, normalize archive separators/modes, reject links/devices, set all archive timestamps from `SOURCE_DATE_EPOCH`, hash streaming bytes, and write JSON with stable key/record ordering. ZIP and tar.gz creation must produce identical hashes from two fresh staging directories with the same inputs.

- [x] **Step 4: Make resolution tuple-based**

Plan 40 requests `{ product, version, os, architecture, preferredFormats }`. Selection fails on zero or multiple matches and verifies the signed manifest before reading a record. It never constructs a download URL from `version-os-arch` string interpolation.

- [x] **Step 5: Run schema/tool tests and commit**

```sh
vp test packages/contracts/src/serverArtifact.test.ts scripts/verify-server-artifacts.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server-packager -- --nocapture
vp run check:contracts
git add packages/contracts/src/serverArtifact.ts packages/contracts/src/serverArtifact.test.ts packages/contracts/src/index.ts packages/contracts/package.json tools/server-packager scripts/verify-server-artifacts.ts scripts/verify-server-artifacts.test.ts apps/desktop/src-tauri/src/server_artifacts.rs apps/desktop/src-tauri/src/wsl_setup.rs apps/desktop/src-tauri/src/ssh.rs apps/desktop/src-tauri/fixtures/server-artifacts packaging/server/server-release.pub Cargo.toml Cargo.lock
git commit -m "feat(release): define signed server artifact discovery"
```

Implementation evidence (2026-08-26):

- The TypeScript contract, Rust packager, release verifier, and desktop resolver enforce the same exact matrix, target-triple, source/version, linked-name, signing, notarization, and universal-mac invariants.
- Desktop selection verifies the detached manifest signature before reading any record and joins only signed safe basenames to the manifest URL; no version/OS/architecture filename interpolation remains.
- Deterministic ZIP and tar.gz tests compare byte-identical output from independent staging roots. Staging rejects links, noncanonical binary names, dirty output, and removes unpublished temporary layouts after failure.
- The checked-in Minisign key and detached files are test fixtures only. Both signatures were verified after formatting; both generated private-key copies and their temporary directories were deleted. Task 6 still owns production release-key provisioning and rotation.
- Passed: 63 focused TypeScript tests, 10 `bibcode-server-packager` tests, 5 desktop artifact tests, `vp run check:contracts`, `vp check`, `vp run typecheck`, `cargo fmt --all --check`, and Clippy with warnings denied for the packager and desktop.

### Task 3: Build one deterministic portable layout per native target

**Files:**

- Create: `scripts/build-server-artifact.ts`, `build-server-artifact.test.ts`
- Modify: root `package.json`, `apps/server/package.json`, `scripts/package.json`
- Modify: `scripts/lib/build-target-arch.ts`, test if server target vocabulary differs
- Modify: `apps/web/package.json` only for a reproducible server-assets build entry
- Create: `packaging/server/common/generate-notices.ts`, test

**Target matrix:**

| Target triple               | Native runner      | Portable output |
| --------------------------- | ------------------ | --------------- |
| `x86_64-pc-windows-msvc`    | `windows-2025`     | ZIP             |
| `aarch64-pc-windows-msvc`   | `windows-11-arm`   | ZIP             |
| `x86_64-apple-darwin`       | `macos-26-intel`   | tar.gz          |
| `aarch64-apple-darwin`      | `macos-26`         | tar.gz          |
| `x86_64-unknown-linux-gnu`  | `ubuntu-22.04`     | tar.gz          |
| `aarch64-unknown-linux-gnu` | `ubuntu-22.04-arm` | tar.gz          |

- [x] **Step 1: Write argument/output/ownership tests first**

Cover unknown target/format, host/target mismatch, missing frozen dependencies, dirty output directory, stale web artifact SHA, wrong Rust executable kind, missing notices/license, symlink input, output overwrite, abort signal, child timeout, and cleanup after a failed stage.

- [x] **Step 2: Build and publish one immutable web-assets input**

Run the production web build once in the release preflight for the exact source SHA/lockfile. Apply the existing production brand assets, generate a sorted `web-assets.json` of relative path/size/SHA-256, and upload that directory as a workflow artifact named with the source SHA. Matrix jobs download and re-hash it; they do not rebuild divergent web bytes.

- [x] **Step 3: Compile the exact native server binary**

Use `cargo build --locked --release -p bibcode-server --bin bibcode --target <triple>` on the matching architecture. Consume Cargo JSON `compiler-artifact` output rather than assuming `target/<triple>/release/bibcode`. Record Rust version, target triple, package version, source SHA, and binary hash in staging metadata.

- [x] **Step 4: Stage only allowlisted production files**

Invoke `server-packager stage` with the compiler artifact, verified web-assets input, root license, generated notices, and install-layout template. Reject unexpected executables, `.map` files unless intentionally published, secrets, `.env`, logs, databases, developer paths, `node_modules`, Node binaries, desktop/Tauri libraries, and Connect/telemetry patterns.

- [x] **Step 5: Produce deterministic portable archives**

Windows creates ZIP; macOS/Linux create tar.gz. Portable README text gives foreground and explicit `bibcode service install --mode workstation` commands but the archive extraction itself changes no service, login item, firewall, data directory, or PATH.

- [x] **Step 6: Add root package commands and run reproducibility tests**

```sh
vp test scripts/build-server-artifact.test.ts packaging/server/common/generate-notices.test.ts
node scripts/build-server-artifact.ts --target "$(rustc -vV | sed -n 's/^host: //p')" --formats portable --output-dir release/server-local --unsigned-test
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server-packager zip_and_tar_archives_are_reproducible_across_fresh_staging_roots -- --nocapture
git add scripts/build-server-artifact.ts scripts/build-server-artifact.test.ts scripts/lib/build-target-arch.ts scripts/lib/build-target-arch.test.ts packaging/server/common package.json apps/server/package.json scripts/package.json apps/web/package.json
git commit -m "build(server): create deterministic portable artifacts"
```

Implementation evidence (2026-08-26):

- The builder accepts exactly the six approved native target tuples, refuses
  host/target and format drift, discovers the exact Cargo compiler artifact,
  bounds every child command, and cleans unpublished staging after failure or
  cancellation.
- The server-assets build is compile-time browser-only. An initial native
  integration build exposed five retained Tauri chunks; the dedicated mode now
  removes the desktop bridge/shortcut graph, while the ordinary web build
  retains its Tauri bridge. Content and path policy reject any Tauri runtime,
  Node runtime, link, source map, secret, log, database, Connect, or telemetry
  payload before staging.
- The native macOS ARM64 unsigned-test archive ran `bibcode --version`, matched
  its embedded executable hash and adjacent/embedded build metadata, contained
  560 re-hashed web assets and 231 generated dependency-notice rows, and had no
  forbidden path or content hit. The other target tuples remain native CI
  evidence for Task 7 rather than being misreported from cross-target fixtures.
- ZIP and tar.gz output is byte-reproducible across fresh staging roots with
  normalized order, paths, modes, and `SOURCE_DATE_EPOCH`; the original stale
  sample filter was corrected to the exact discovered Rust test name.
- Passed: 29 focused script/web tests, all 10 server-packager tests, the exact
  reproducibility test, the ordinary and server-only web builds, `vp check`,
  `vp run typecheck`, `cargo fmt --all --check`, and packager Clippy with
  warnings denied. Living architecture, workspace, script, and cross-platform
  testing documentation now describes the portable boundary and procedure.

### Task 4: Build native MSI, PKG, DEB, and RPM installers

**Files:**

- Create: `packaging/server/windows/BiBCode.Server.wixproj`, `Product.wxs`, `variables.wxi`, `README.md`
- Create: `packaging/server/macos/Distribution.xml`, `scripts/preinstall`, `scripts/postinstall`, `README.md`
- Create: `packaging/server/linux/bibcode.service`, `deb/**`, `rpm/bibcode-server.spec`, `README.md`
- Modify: `scripts/build-server-artifact.ts`, test
- Modify: `apps/server/Cargo.toml` package metadata only where consumed by pinned native tools
- Test: package source/template policy in `scripts/server-packaging-contract.test.ts`

- [ ] **Step 1: Write package-template and dry-run tests**

Assert product/version/architecture/install root, loopback defaults, workstation mode, service owner, CLI path, data preservation, no firewall rule, no purge custom action, upgrade codes/package IDs, rollback actions, uninstall order, and no shell interpolation of user-provided paths.

- [ ] **Step 2: Implement Windows x64/ARM64 MSI with WiX 7**

Pin `WixToolset.Sdk/7.0.0` in `BiBCode.Server.wixproj`. Build a per-user MSI that installs the staged layout under `%LOCALAPPDATA%\Programs\BiBCode Server`, adds `bin` through an installer-owned user PATH entry, and calls the same versioned Plan 30 service operation used by CLI to create one logon-triggered task for the installing SID. Deferred actions receive no raw secret and have explicit rollback/uninstall counterparts.

Use one stable UpgradeCode across architectures and architecture-specific package identity/components. Major upgrade stops the owned task, preserves the data root, replaces files transactionally, recreates/starts the task, and verifies loopback health. Stable release output fails unless both `bibcode.exe` and MSI signature verification pass.

- [ ] **Step 3: Implement a universal macOS PKG plus per-arch tar files**

Build both native Mach-O slices, verify each reports the same version/protocol, then combine only the server executable with `lipo -create`. Verify `lipo -archs` returns exactly `x86_64 arm64`. The PKG installs the universal staged layout and CLI link, creates the installing user's LaunchAgent through Plan 30's service command, binds loopback, and preserves user data on uninstall.

Credential-free CI ad-hoc signs the universal executable with `codesign --sign -` and leaves the PKG unsigned/unnotarized; the manifest records those two facts separately. Optional Developer ID mode signs both slices/universal binary, signs the PKG with `productsign`, notarizes/staples, and verifies with `spctl`/`pkgutil`/`stapler`.

- [ ] **Step 4: Implement Linux x64/ARM64 DEB and RPM packages**

Pin `cargo-deb` 3.7.0 and `cargo-generate-rpm` 0.21.0. Install `bibcode`, compiled web assets, notices, and a systemd user-unit template under distro-standard locations. Package scripts reload user-unit metadata only for the invoking/explicit installation user, call the Plan 30 workstation service operation, and never enable linger, create a system account, open a firewall, or delete data.

Noninteractive package installation requires an explicit documented `workstation` or `files-only` choice; `files-only` is the safe behavior when there is no identifiable user session. The BiBCode desktop SSH flow supplies the already-approved mode/user and then verifies service health. Headless setup remains `bibcode service install --mode headless` after package installation and requires elevation.

- [ ] **Step 5: Inspect native package contents and scripts before execution**

Use `lessmsi`/WiX inspection on Windows, `pkgutil --expand-full` and `codesign` on macOS, `dpkg-deb --contents --control`, and `rpm -qpl --scripts`. Compare every installed path against the allowlist and reject any data-root delete, wildcard bind, firewall, telemetry, or Connect command.

- [ ] **Step 6: Build the host-native formats and commit**

```sh
vp test scripts/build-server-artifact.test.ts scripts/server-packaging-contract.test.ts
node scripts/build-server-artifact.ts --target "$(rustc -vV | sed -n 's/^host: //p')" --formats native,portable --output-dir release/server-local --unsigned-test
node scripts/verify-server-artifacts.ts --directory release/server-local --allow-unsigned-test
git add packaging/server scripts/build-server-artifact.ts scripts/build-server-artifact.test.ts scripts/server-packaging-contract.test.ts apps/server/Cargo.toml Cargo.lock
git commit -m "build(server): package native server installers"
```

### Task 5: Integrate service-safe install, upgrade, uninstall, and explicit purge

**Files:**

- Modify: `apps/server/src/service/mod.rs`, `model.rs`, platform adapters from Plan 30
- Create: `apps/server/src/package_lifecycle.rs`
- Modify: `apps/server/src/config.rs`, `lib.rs`, `local_control/**`
- Test: `apps/server/tests/package_lifecycle.rs`, `service_lifecycle.rs`, `cli_smoke.rs`
- Modify: all platform package scripts/templates from Task 4

- [ ] **Step 1: Write state-machine tests before installer hooks**

Cover clean install, service already installed, one-process/data-root lock, active mutation drain, backup success/failure, stop timeout, binary replacement, service definition replacement, identity-preserving restart, health failure/rollback, irreversible DB migration, uninstall with data, reinstall adoption, explicit purge, and crash/retry at every durable boundary.

- [ ] **Step 2: Add a versioned package lifecycle receipt**

```rust
pub enum PackageLifecyclePhase {
    Prepared,
    ServiceStopped,
    FilesCommitted,
    ServiceStarted,
    Verified,
    RolledBack,
}
```

The receipt binds package version, environment/storage IDs, data-root identity, prior binary hash/path, service mode/owner, backup ID, and phase. It contains no credential. Package scripts pass an opaque nonce and cannot select a different data root after preparation.

- [ ] **Step 3: Prepare upgrade through local control**

Close mutation admission, drain bounded active work, cancel/reap owned provider/terminal/SSH children, checkpoint WAL, create/verify the pre-update backup, then stop the service. Abort before file mutation when any required preparation fails.

- [ ] **Step 4: Verify identity and roll back bytes, never schema**

After replacement, start and check descriptor health, environment UUID, storage UUID, version, protocol, control channel, web assets, and loopback bind. If the new binary cannot start before an irreversible migration, restore the previous package bytes/service definition and verify once. If an irreversible migration committed, leave the verified backup and recovery instructions; never run the older binary against the newer database.

- [ ] **Step 5: Separate uninstall and purge**

`bibcode service uninstall` and native uninstaller remove the service/task and package-owned files, preserve the verified data root/backups, and print their exact retained path. `bibcode storage purge` requires an online removal plan, full administrator session/local authority, exact typed environment name, resolved-root containment, and existing project/worktree removal guards. There is no MSI/PKG/DEB/RPM purge flag.

- [ ] **Step 6: Test headless account ownership and rollback**

Require explicit elevation, create/use the dedicated `bibcode` account without adopting a conflicting pre-existing account, set minimal ACLs, use no interactive provider secrets, and report account removal separately. Rollback never deletes a pre-existing user/account.

- [ ] **Step 7: Run lifecycle tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test package_lifecycle -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test service_lifecycle -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test cli_smoke package -- --nocapture
git add apps/server/src/service apps/server/src/package_lifecycle.rs apps/server/src/config.rs apps/server/src/lib.rs apps/server/src/local_control apps/server/tests/package_lifecycle.rs apps/server/tests/service_lifecycle.rs apps/server/tests/cli_smoke.rs packaging/server
git commit -m "feat(server): make package lifecycle identity safe"
```

### Task 6: Sign, checksum, inventory, and attest final artifact bytes

**Files:**

- Create: `scripts/sign-server-artifacts.ts`, test
- Create: `scripts/generate-server-sbom.ts`, test
- Modify: `scripts/build-server-artifact.ts`, `verify-server-artifacts.ts`, tests
- Modify: `.github/workflows/server-native-smoke.yml`, `release.yml`
- Create: `.config/dotnet-tools.json` for the pinned development-only CycloneDX CLI
- Modify: package/tool manifests and lockfiles for pinned development-only SBOM tooling
- Modify: `packages/contracts/src/serverArtifact.ts`, test for signing/provenance fields

- [ ] **Step 1: Write signing-state and secret-redaction tests**

Cover unsigned-test, stable Windows missing credentials, invalid/expired certificate, timestamp failure, wrong signer subject/thumbprint, macOS no credentials, ad-hoc executable, optional Developer ID+notarization, Linux detached-only, bad detached signature, SBOM mismatch, manifest tampering, and command output containing seeded secret canaries.

- [ ] **Step 2: Add a dedicated server release signing key**

Use repository-environment secrets `BIBCODE_SERVER_SIGNING_PRIVATE_KEY` and `BIBCODE_SERVER_SIGNING_PRIVATE_KEY_PASSWORD` with a checked-in public verification key consumed by Plan 40. Sign every final installer/archive, SBOM, checksum file, and `artifacts.json` using the pinned Minisign-compatible repository command. Never reuse or expose the private Tauri updater key.

Plan 40 checks in a dedicated pre-release fixture public key whose private half
was deleted. Before any publication, replace that public key with the public
half of the newly provisioned repository-environment server signing secret and
prove that the desktop verifier accepts its signatures and rejects both the
pre-release fixture key and the Tauri updater key.

- [ ] **Step 3: Authenticode-sign stable Windows bytes**

Import the code-signing PFX from protected secrets `WINDOWS_SIGNING_CERTIFICATE_PFX` and `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` into an ephemeral runner store, sign `bibcode.exe` before MSI assembly, sign the final MSI with SHA-256 and the documented timestamp service, verify with `signtool verify /pa /all`, then remove the ephemeral certificate. Stable jobs fail closed when configuration or timestamping is absent.

- [ ] **Step 4: Keep macOS credential-free and Developer ID paths distinct**

Without Apple credentials, ad-hoc sign the server Mach-O only, leave PKG unsigned, skip notarization, and record `binary=adhoc`, `package=none`, `notarized=false`. With Developer ID Application/Installer credentials, validate identities, sign, notarize, staple, and record verified team/authority metadata without certificate secrets. Do not modify or weaken the existing desktop ad-hoc DMG job.

- [ ] **Step 5: Generate one CycloneDX SBOM per downloadable artifact**

Pin `cargo-cyclonedx` 0.5.9 and CycloneDX CLI 0.32.0. Generate the Rust BOM from the locked server crate; generate the web production BOM with repository-pinned pnpm 11.15.0's built-in `sbom` command and an exact `@bibcode/web` production filter. Merge those BOMs with the staged file inventory and bind the result to artifact SHA-256/source SHA. Policy tests fail if the web filter includes unrelated workspace development packages, require representative direct and transitive Rust/web components, and reject Node/Tauri/Connect/telemetry as production server components.

- [ ] **Step 6: Generate manifest/checksums after final bytes**

Finalization order is native signing/notarization, artifact hash/size, SBOM, SBOM signature, `SHA256SUMS`, checksums signature, `artifacts.json`, manifest signature. Avoid a checksum cycle by defining `SHA256SUMS` to cover downloadable product artifacts and SBOMs, while `artifacts.json.minisig` authenticates the manifest itself.

- [ ] **Step 7: Attach GitHub provenance and SBOM attestations**

Grant `id-token: write`, `attestations: write`, and minimal `contents: read` only to the aggregate attestation job. Attest each final artifact digest plus its SBOM using pinned official GitHub actions; include attestation availability/URL/digest in release evidence, not a mutable value inside the already-signed artifact manifest.

- [ ] **Step 8: Run local unsigned and verifier tests and commit**

```sh
vp test scripts/sign-server-artifacts.test.ts scripts/generate-server-sbom.test.ts scripts/verify-server-artifacts.test.ts
node scripts/verify-server-artifacts.ts --directory release/server-local --allow-unsigned-test
vp test scripts/privacy-contract.test.ts scripts/legacy-cloud-removal-contract.test.ts
git add scripts/sign-server-artifacts.ts scripts/sign-server-artifacts.test.ts scripts/generate-server-sbom.ts scripts/generate-server-sbom.test.ts scripts/build-server-artifact.ts scripts/verify-server-artifacts.ts scripts/verify-server-artifacts.test.ts packages/contracts/src/serverArtifact.ts packages/contracts/src/serverArtifact.test.ts .github/workflows/server-native-smoke.yml .github/workflows/release.yml .config/dotnet-tools.json package.json pnpm-workspace.yaml pnpm-lock.yaml Cargo.toml Cargo.lock
git commit -m "build(release): sign inventory and attest server artifacts"
```

### Task 7: Add native server CI and a complete release aggregation gate

**Files:**

- Create: `.github/workflows/server-native-smoke.yml`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `scripts/ci-platform-contract.test.ts`, `release-workflow.test.ts`, `workflow-dependencies.test.ts`
- Modify: `scripts/release-smoke.ts`, `release-smoke.test.ts`
- Modify: `scripts/update-release-package-versions.ts`, test to keep server version sources aligned

- [ ] **Step 1: Write workflow graph/matrix tests before YAML edits**

Require exactly every approved tuple, native runner/architecture match, frozen installs, locked Cargo, web-assets SHA input, artifact upload name, signing gates, smoke dependency, aggregate manifest verification, attestation permissions, and release dependency. Assert existing desktop matrix targets, ad-hoc macOS verification, updater-candidate signing check, draft inspection, and finalizer remain present.

- [ ] **Step 2: Add reusable native server smoke jobs**

The reusable workflow builds/packages on:

- Windows x64 `windows-2025` and Windows ARM64 `windows-11-arm`;
- macOS arm64 `macos-26`, macOS x64 `macos-26-intel`, plus universal assembly on macOS after both slices are available;
- Linux x64 on `ubuntu-22.04` and Linux ARM64 on `ubuntu-22.04-arm`, keeping the same documented glibc compatibility floor.

If a named runner is unavailable to the repository, that architecture remains experimental and cannot be emitted by the stable matrix; it is not cross-built and called supported.

- [ ] **Step 3: Extend CI without making desktop validation implicit**

Add host-native portable/package build plus install smoke lanes. Keep `native_desktop` as its own explicit job. Cache keys include target triple, lockfiles, Rust version, and web-assets hash; no matrix job shares mutable target/output directories.

- [ ] **Step 4: Add separated release jobs**

Use `server_web_assets`, `server_build`, `server_sign`, `server_smoke`, `server_aggregate`, and `server_attest`. Each upload is immutable and source-SHA named. `server_aggregate` downloads all records, verifies exact matrix/cardinality/hash/signature/SBOM/signing state, builds the final manifest, and uploads one `server-release-set`.

- [ ] **Step 5: Make publication all-or-nothing**

The existing `release` job needs `[preflight, build, server_aggregate, server_attest]`, downloads `desktop-*` and `server-release-set`, runs both Tauri updater verification and server artifact verification, then creates/validates the draft. A missing/duplicate/unsigned stable server artifact blocks the draft; a partial set is never published as complete.

- [ ] **Step 6: Keep existing desktop/macOS behavior working**

Do not remove `apps/desktop/src-tauri/tauri.conf.json` `signingIdentity: "-"`, the macOS DMG mount plus `codesign --verify`/`Signature=adhoc` checks, the stable updater secret gate, updater manifest/signature verification, or inspected-draft publication. Add regression assertions for all of them.

- [ ] **Step 7: Run workflow gates and commit**

```sh
vp test scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts scripts/release-smoke.test.ts scripts/update-release-package-versions.test.ts
vp run release:smoke
git add .github/workflows/server-native-smoke.yml .github/workflows/ci.yml .github/workflows/release.yml scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts scripts/release-smoke.ts scripts/release-smoke.test.ts scripts/update-release-package-versions.ts scripts/update-release-package-versions.test.ts
git commit -m "ci(release): publish verified server installers"
```

### Task 8: Prove install, pairing, restart, update, uninstall, purge, and cleanup natively

**Files:**

- Create: `scripts/server-install-smoke.ts`, `server-install-smoke.test.ts`
- Create: `apps/server/tests/packaged_server_smoke.rs`
- Modify: `.github/workflows/server-native-smoke.yml`
- Modify: `scripts/privacy-contract.test.ts`, `legacy-cloud-removal-contract.test.ts`
- Test evidence uses `docs/testing/execution-report-template.md`; it is not committed into living runbooks.

- [ ] **Step 1: Build a bounded manifest-driven smoke harness**

The harness accepts `--manifest`, `--artifact-root`, `--os`, `--architecture`, `--format`, a fresh absolute work root, and timeouts. It verifies manifest signature/hash before mutation, records redacted stage/evidence JSON, owns every process/service it starts, and refuses a nonempty/equivalent output root.

- [ ] **Step 2: Implement the twelve approved native scenarios**

1. Clean per-user workstation install.
2. Exactly one service process on loopback; no firewall rule.
3. Five-minute/single-use DPoP pairing and authenticated RPC/WebSocket.
4. Same-origin browser UI loads with Node absent from runtime PATH.
5. Restart preserves environment and storage IDs.
6. Upgrade preserves data/identity and makes verified pre-update backup.
7. Injected failed upgrade restores prior bytes or stops safely after irreversible migration.
8. Uninstall removes files/service and preserves data/backups.
9. Reinstall adopts the preserved identities/projects.
10. Explicit typed purge removes only the verified data root.
11. Explicit headless install uses dedicated account/ACL/service owner.
12. Stop/uninstall/failure leaves no owned service, provider, terminal, SSH, installer, or temporary child.

- [ ] **Step 3: Prove each connection-after-install path**

- Same host: open loopback UI, create pairing through local control/CLI, redeem with DPoP.
- SSH: trust/probe, local forward to remote loopback, descriptor identity verification, pairing creation over SSH, then redemption.
- HTTPS: reject HTTP non-loopback, verify system trust or enrolled pin, redeem explicit local/SSH-created pairing.
- WSL: resolve the Linux portable record from the signed manifest, install only in a Running distro, and never start/unregister a Stopped distro.

- [ ] **Step 4: Run on native architectures and classify evidence honestly**

Execute MSI on Windows x64/ARM64, PKG and per-arch portable files on both macOS architectures, and DEB/RPM/tar on Linux x64/ARM64. Format inspection on another host is compatibility evidence only. A missing native ARM runner blocks stable ARM support rather than becoming an automatic skip.

- [ ] **Step 5: Assert privacy and zero unexpected outbound traffic**

Use a deny-by-default network harness around service startup, UI load, pairing, RPC, restart, crash, diagnostics, uninstall, and purge. The intentional update scenario allowlists only the test update host. Seed token/path/user canaries and prove logs, process arguments, package logs, artifacts, SBOM, and evidence are redacted.

- [ ] **Step 6: Run focused local tests and commit**

```sh
vp test scripts/server-install-smoke.test.ts scripts/privacy-contract.test.ts scripts/legacy-cloud-removal-contract.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test packaged_server_smoke -- --nocapture
git add scripts/server-install-smoke.ts scripts/server-install-smoke.test.ts scripts/privacy-contract.test.ts scripts/legacy-cloud-removal-contract.test.ts apps/server/tests/packaged_server_smoke.rs .github/workflows/server-native-smoke.yml
git commit -m "test(server): exercise native installer lifecycle"
```

### Task 9: Rewrite all living install, usage, administration, architecture, and testing documentation

**Files:**

- Modify: root `README.md`, `docs/README.md`
- Modify: `docs/getting-started/quick-start.md`, `provider-setup.md`
- Create: `docs/getting-started/server-installation.md`
- Create: `docs/user/environments.md`
- Modify: `docs/user/remote-access.md`, `workspace-ui.md`, `keybindings.md` when navigation changes shortcuts
- Create: `docs/operations/server-administration.md`
- Modify: `docs/operations/ci.md`, `release.md`, `observability.md`
- Modify: `docs/architecture/overview.md`, `remote.md`, `connection-runtime.md`, `runtime-modes.md`, `rpc-and-orchestration.md`, `worktree-catalog.md`
- Modify: `docs/reference/workspace-layout.md`, `scripts.md`, `encyclopedia.md`
- Modify: `docs/guides/project-data-recovery.md`
- Modify: `docs/testing/README.md`, `cross-platform-validation.md`, `windows-desktop.md`, `macos-desktop.md`, `linux-desktop.md`, `execution-report-template.md`
- Create: `docs/testing/server-installers.md`, `remote-environments.md`
- Delete/rewrite remaining obsolete living cloud/Connect pages as required by Plan 60.

- [ ] **Step 1: Update entry points and complete installation matrix**

Root README and docs index link to desktop installation and server-only Windows x64/ARM64, macOS universal/per-arch, and Linux x64/ARM64 instructions. For every format document prerequisites, checksum/signature verification, native-signing state, install/binary/web/data/log/control paths, default loopback/service behavior, CLI PATH, upgrade, uninstall-preserves-data, explicit purge, and recovery.

- [ ] **Step 2: Document the approved application usage**

Explain `Environment -> Project -> Main/ordinary/worktree thread`, same repository in different environments as distinct projects, one repository family per environment, permanent Main, preserved server-owned worktree management, center workspace tabs/settings, status/search/offline read-only behavior, WSL visibility, and explicit removal consequences using the exact UI labels from Plan 50.

- [ ] **Step 3: Document environment enrollment and administration**

Provide exact local, WSL, SSH, and HTTPS sequences; pairing expiry/single use; full-administrator clients; revocation; route/identity/certificate mismatch; secret-store locked/session-only behavior; workstation/headless services; TLS; backup/restore; update rollback; logs/diagnostics; and force remove versus remote uninstall versus purge.

State clearly that non-loopback HTTP does not exist, WSL Stopped distros are never auto-started, no action unregisters WSL, and installer completion does not mean a desktop client is paired.

- [ ] **Step 4: Align architecture/reference/operations with source ownership**

Document server-authoritative domain/database/worktrees, client catalog/routes/cache/secrets, DesktopBridge privilege boundary, local-control authority, WSL byte-forwarding, SSH tunnel ordering, installed layout, artifact manifest, CI job graph, signing distinctions, release draft inspection, and no-telemetry/no-hosted-control-plane policy. Update package/workspace/script/CLI/environment-variable reference using actual implemented commands.

- [ ] **Step 5: Expand living runbooks and report schema**

Add repeatable native installer and remote-environment procedures. The execution report records exact source SHA, artifact manifest digest, installer/target/arch, native signature/notarization/detached signature, service mode/owner, data-root identity before/after, route/TLS/SSH/WSL evidence, no-unexpected-network result, process survivors, commands/exits/durations, screenshots/logs, and native versus compatibility versus unavailable classification.

- [ ] **Step 6: Verify every command/link against current source**

```sh
vp check
vp run typecheck
vp test scripts/release-workflow.test.ts scripts/server-install-smoke.test.ts scripts/privacy-contract.test.ts
rg -n -i "BiBCode Connect|BIBCODE_RELAY|BIBCODE_CLERK|non-loopback.*http" README.md docs --glob '!docs/plans/**' --glob '!docs/superpowers/**' --glob '!docs/dependency-upgrades/2026-07-17-ledger.json' --glob '!docs/operations/legacy-cloud-decommission.md'
git diff --check
```

The search may contain only explicit statements that non-loopback HTTP is forbidden; every Connect/config hit must be within the one manual decommission runbook.

- [ ] **Step 7: Commit living documentation together**

```sh
git add README.md docs
git commit -m "docs: publish environment and server operations guides"
```

### Task 10: Run the final repository, artifact, native, and privacy gates

**Files:**

- Review all changed source, schemas, manifests, workflows, packages, generated lockfiles/fixtures, docs, and runbooks.
- Record platform execution evidence from `docs/testing/execution-report-template.md` outside living docs.

- [ ] **Step 1: Run focused policy/release/contract tests**

```sh
vp test scripts/legacy-cloud-removal-contract.test.ts scripts/privacy-contract.test.ts scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts scripts/build-server-artifact.test.ts scripts/verify-server-artifacts.test.ts scripts/server-install-smoke.test.ts
vp run check:contracts
vp run release:smoke
```

- [ ] **Step 2: Run full TypeScript/workspace gates**

```sh
vp check
vp run typecheck
vp run test
```

- [ ] **Step 3: Run full Rust gates**

```sh
cargo fmt --all --check
node scripts/run-msvc-x64.mjs cargo test --workspace -j 2
node scripts/run-msvc-x64.mjs cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **Step 4: Build and verify the complete release set**

On CI/native runners, build every artifact tuple, then aggregate:

```sh
node scripts/verify-server-artifacts.ts --manifest release/server/artifacts.json --directory release/server
vp run release:smoke
```

Verify exact cardinality, native signatures, detached signatures, checksums, SBOMs, provenance, no production Node/Tauri/Connect/telemetry contents, and the preserved desktop updater/ad-hoc macOS checks.

- [ ] **Step 5: Execute all living native procedures**

Run `docs/testing/server-installers.md`, `remote-environments.md`, each OS page, packaged visual validation of the approved left panel, WSL, SSH, HTTPS, worktree, process cleanup, update, uninstall/reinstall/purge, and no-unexpected-network scenarios. Report unavailable capabilities and residual risk without converting them to passes.

- [ ] **Step 6: Review final diff and release boundaries**

```sh
git diff --check
git diff --stat
git diff
git status --short
```

Inspect for secrets, generated debug/evidence files, dependency drift, stale Connect/telemetry strings outside the exact Plan 60 allowlist, missing living docs, modified historical plans, unintended `.repos` changes, or desktop release regressions.

- [ ] **Step 7: Commit integration verification metadata only when needed**

Do not commit machine-specific logs/screenshots/timings. If verification changes only stable fixtures/manifests required by source, commit those exact generated files:

```sh
git add packages/contracts apps/server/tests scripts docs/testing
git commit -m "test(release): finalize server distribution coverage"
```

Plan 70 is complete only when the stable release cannot publish a partial/unsigned required matrix, every supported architecture has native execution evidence, current desktop distribution still passes, living documentation matches source, and runtime/artifacts remain telemetry-free.
