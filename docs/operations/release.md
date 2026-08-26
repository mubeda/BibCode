# Release Checklist

This document describes the Tauri 2 desktop and native server release workflow.
The repository does not package or publish Electron artifacts, a production
Node.js runtime, or a hosted control service.

## Release Workflow

`.github/workflows/release.yml` supports:

- stable releases from tags matching `v*.*.*`; and
- manual stable or nightly releases through `workflow_dispatch`.

The preflight job runs `vp check`, `vp run typecheck`, and `vp run test`. The
build matrix then creates native Tauri installers on the matching operating
system:

| Platform | Runner           | Architecture | Installer       |
| -------- | ---------------- | ------------ | --------------- |
| macOS    | `macos-26`       | arm64        | DMG             |
| macOS    | `macos-26-intel` | x64          | DMG             |
| Linux    | `ubuntu-22.04`   | x64          | AppImage        |
| Windows  | `windows-2025`   | x64          | NSIS executable |

Each matrix job installs the frontend build toolchain and Rust, restores Cargo
caches, and runs `scripts/build-desktop-artifact.ts`. Tauri compiles the native
host and in-process server and embeds the built React assets. No Node runtime or
TypeScript server is packaged.

Numeric stable versions are updater candidates and are marked latest only after
manual publication approval. Stable prerelease versions and manual nightly
releases are GitHub prereleases, are never marked latest, and remain
installer-only.

### Server-only release set

The same release also publishes server-only packages built by the reusable
`.github/workflows/server-native-smoke.yml` matrix:

| Platform | Native runners          | Native package    | Portable package          |
| -------- | ----------------------- | ----------------- | ------------------------- |
| Windows  | x64 and ARM64           | MSI               | ZIP                       |
| macOS    | Intel and Apple Silicon | one universal PKG | per-architecture `tar.gz` |
| Linux    | x64 and ARM64           | DEB and RPM       | `tar.gz`                  |

The server pipeline has one explicit source of truth and these gates:

1. `server_web_assets` freezes one production web tree and its source identity.
2. `server_build` builds and natively exercises every target/format without
   publishing mutable candidates.
3. `server_sign` generates one CycloneDX 1.7 SBOM per artifact, checksum
   inventory, signed `artifacts.json`, and detached Minisign signatures.
4. `server_smoke` re-verifies the complete signed set plus privacy and removed
   hosted-runtime policy.
5. `server_aggregate` requires exact matrix cardinality before creating
   `server-release-set`; `server_attest` then emits GitHub artifact provenance.
6. The publish job downloads that exact aggregate and repeats complete-matrix
   signature verification before it can enter a draft release.

`artifacts.json` is authoritative for OS, architecture, format, version, source
SHA, byte count, SHA-256, SBOM, native signing, notarization, and channel.
Candidates are immutable between native execution and final signing. The
public server Minisign key is `packaging/server/server-release.pub`; release
secrets are never embedded in artifacts or logs.

## Supported Platforms

- macOS 11 or newer on Apple Silicon (`arm64`) and Intel (`x64`);
- Windows 10 or 11 on `x64`;
- Linux `x64` AppImages built on Ubuntu 22.04 and exercised on Ubuntu 22.04,
  Ubuntu 24.04, and Debian 12.

Windows on ARM remains unsupported until `scripts/run-msvc-x64.mjs` is made
architecture-aware. Linux release artifacts use Ubuntu 22.04 to keep the
runtime glibc compatibility floor below the portable Ubuntu 24.04 CI jobs.

## Version Source

`apps/desktop/package.json` is the desktop version source.
`apps/desktop/src-tauri/tauri.conf.json` reads that version by path. The release
workflow aligns versioned application packages before building. After a
successful stable release, the finalize job updates the versioned package files
on `main` when branch protection permits the workflow token to push.

## Network and privacy posture

Release builds have no hosted account or connection-control configuration.
Ordinary startup, local use, pairing, diagnostics export, and crash handling do
not require or contact a vendor service. A client connects only to its selected
local/WSL loopback route, desktop-owned SSH forward, or explicitly enrolled
HTTPS environment. The updater endpoint is contacted only by an intentional
update check. Telemetry and crash upload are forbidden.

The workflow intentionally does not publish an npm package or deploy a hosted
web application.

## Signing And OS Trust

Desktop and server signing policies are separate.

macOS application bundles are signed with Tauri's ad-hoc `-` identity. This
seals the complete bundle so Gatekeeper can verify that it is intact, but it
does not associate the app with an Apple Developer team or notarize it. Users
must approve a browser-downloaded build through Settings > Privacy & Security.
Release CI mounts both macOS DMGs and verifies their recursive bundle
signatures before upload.

Windows artifacts remain without Authenticode. macOS remains ad-hoc
signed/unnotarized. Tauri updater signatures verify update payloads; they do
not replace Apple Developer ID signing, macOS notarization, or Windows
Authenticode.

Stable Windows **server** executables and MSIs, unlike the current desktop NSIS
artifact, must be timestamped Authenticode-signed and must pass both embedded
signature verification and the declared certificate subject/thumbprint policy.
The server release is rejected if the dedicated certificate configuration is
missing or inconsistent.

macOS server Developer ID signing and notarization remain optional. A
credential-free server build has an ad-hoc-signed executable and an unsigned,
unnotarized PKG; the manifest states that condition explicitly. When optional
credentials are supplied, the workflow verifies the package signature and
notarization result rather than silently changing the policy. Every server
artifact on every platform still requires its dedicated Minisign signature,
checksum entry, and signed SBOM inventory.

Keep a password-protected backup of the updater private key in an approved
offline recovery location, with access restricted to release maintainers. Keep
its passphrase in a separate approved secret store.
Release CI receives the key only through the GitHub secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; never add
the key or passphrase to the repository, a release asset, or a log.

> **Recovery warning:** losing both the updater private key and its separate
> passphrase breaks the trusted update chain. Existing installations cannot
> trust payloads signed by a replacement key.

## Stable Updater

Numeric, non-prerelease stable release builds apply
`apps/desktop/src-tauri/tauri.release.conf.json` as a release-only overlay. The
base configuration intentionally has no updater endpoint or public key, so
development, E2E, stable prerelease, and ordinary local builds never perform
updater I/O. The workflow passes `--updater` only for updater candidates.

The stable updater endpoint is:

`https://github.com/mubeda/BibCode/releases/latest/download/latest.json`

Every stable `latest.json` has exactly these signed manifest targets:

- `darwin-aarch64`
- `darwin-x86_64`
- `linux-x86_64`
- `windows-x86_64`

The payload URLs inside the manifest must be tag-specific HTTPS GitHub Release
URLs, not the moving `latest/download` endpoint. The moving endpoint is used
only to fetch `latest.json`. Before creating a draft, release CI verifies every
manifest payload with the public key from the release overlay and requires each
manifest signature to match its adjacent `.sig` asset.

Stable-channel and nightly prereleases are installer-only. They never receive
the updater signing overlay, updater signatures, descriptors, or `latest.json`,
and never feed the app updater.

### Update installation safety

The signed stable updater uses the same project-store protection protocol on
macOS, Windows, and Linux. Before the platform installer runs, the desktop host
protects the native primary and every included running secondary with a
verified `PreUpdate` backup, then waits for those backends to stop. Windows WSL
primary and secondary runtimes participate through their authenticated desktop
bootstrap transport. A configured secondary that is not running is shown as
unprotected; the user must name that exact secondary to exclude it. The primary
is never excludable.

If preparation, cancellation, commit, backend stop, or platform installation
fails, the host attempts to restore the exact set of backends that was running
before protection began. The installer is never called while an included
backend remains uncommitted or running. This guarantee applies to updates
installed from the in-app signed stable channel. Replacing the application
manually with a DMG, NSIS executable, AppImage, or an external package manager
does not pass through the in-app coordinator; close BiBCode before performing a
manual replacement.

The coordinated sequence rejects new mutations, drains admitted mutations,
quiesces background writers, checkpoints the WAL, publishes and reloads a
verified `pre-update` backup, stops the captured backend topology, and only then
invokes the platform installer. Windows waits for the packaged process to exit
before NSIS replaces files. macOS and Linux install the candidate and relaunch
the packaged application through their platform updater flow. A failed
prepare, backup, stop, install, or relaunch leaves the verified backup and any
recovery-preservation artifacts in the data root and attempts to restart the
exact prior backend set.

The primary backend is always protected and cannot be excluded. Each running
secondary is protected independently. A configured but unavailable secondary
is shown by its exact environment ID and may be explicitly excluded; a generic
"continue anyway" is not accepted. WSL-only intent never falls back to native
Windows during update preparation or recovery.

Linux AppImage updates launched through BiBCode use this coordinator. Replacing
an AppImage directly, installing through an external package manager, or
manually replacing an NSIS/DMG installation is outside the coordinator. Close
every BiBCode backend before those operations. Application files and project
data are separate: a normal in-place updater replaces application files and
must retain the selected project-data root.

### Seeded packaged-upgrade matrix

[`desktop-upgrade-smoke.yml`](../../.github/workflows/desktop-upgrade-smoke.yml)
runs real packaged previous-stable-to-candidate and protected-baseline upgrades
for Windows x64 NSIS, macOS arm64 DMG, macOS x64 DMG, and Linux x64 AppImage.
The protected lane verifies the same storage UUID, seeded project, and a
verified `pre-update` backup after restart. A separate Windows job exercises a
WSL primary when the runner declares WSL plus an installed distribution; an
unavailable capability produces an explicit skip reason rather than emulated
coverage.

The harness uses an isolated root outside the checkout, an ephemeral Tauri
updater key, a loopback-only mock updater, the packaged app's embedded
WebDriver, and bounded redacted evidence. It never opens or copies the SQLite
database directly. Linux additionally requires the normal Tauri/AppImage
libraries plus Xvfb. Run the host-compatible lane from the repository root with
fresh ports and a work root outside the checkout:

```sh
TAURI_SIGNING_PRIVATE_KEY=/absolute/path/to/ephemeral.key \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<ephemeral password>' \
node scripts/seeded-desktop-upgrade-smoke.ts \
  --platform mac --arch arm64 --bundle dmg \
  --candidate-version 0.3.11-upgrade.local.1 \
  --previous-tag v0.3.10 --previous-version 0.3.10 \
  --public-key-file /absolute/path/to/ephemeral.key.pub \
  --run-id local-mac-arm64 \
  --work-root /private/tmp/bibcode-seeded-upgrade/work \
  --artifact-dir /private/tmp/bibcode-seeded-upgrade/evidence \
  --updater-port 43120 --restart-timeout-ms 180000
```

Generate the ephemeral key with `vp exec tauri signer generate` from
`apps/desktop`, install frozen workspace dependencies, and ensure the host can
build and launch the selected native bundle. Never use production signing
secrets for this smoke. Evidence must remain bounded and redact roots,
bootstrap credentials, update-signing secrets, tokens, and database contents.

## Stable Release Runbook

1. Confirm the intended version and commit have passed the local verification
   commands below. Create and push the intended tag (or dispatch `stable` with
   that explicit version) with `publish` left at its default `false`.
2. Confirm the four native desktop build jobs and complete native server matrix
   finish. Confirm desktop updater secrets and the dedicated server Minisign
   secret are present; stable Windows server rows also require their dedicated
   certificate settings. Do not inspect or print secret values.
3. Confirm the workflow's descriptor-validation and updater-signature steps
   passed. The workflow must validate exactly four `updater-*.json` descriptors,
   one for each manifest target listed above, before it removes those internal
   descriptors from the public asset set.
4. Let the workflow create the GitHub Release as a **draft**. Before allowing
   publication, inspect its uploaded assets and `latest.json`:

   - `latest.json` has exactly the four manifest target entries above;
   - each target has a nonempty signature and a tag-specific HTTPS payload URL;
   - the release contains a nonempty `.sig` asset for each target;
   - the release contains `latest.json`, the two macOS DMGs, Linux AppImage,
     Windows NSIS installer, updater payload archives, and every server artifact
     listed in the verified complete `artifacts.json` matrix;
   - each server artifact has an adjacent `.minisig`, CycloneDX `.cdx.json`, and
     signed inventory coverage; and
   - no private key or passphrase is present in any asset, manifest, or log.

5. Compare the draft's sorted asset names with the workflow's
   `expected-assets.txt`. The workflow must leave the release a draft when the
   comparison or any verification fails.
6. After a human has inspected the draft, rerun the workflow manually with the
   same version, select the stable channel, and set `publish` to `true`. The
   approval run requires the existing draft, rebuilds the same tagged commit,
   repeats validation, and only then publishes it. It does not upload or
   replace the inspected draft assets. Only numeric non-prerelease stable
   releases are marked latest.
7. Install and smoke-test each ordinary desktop installer and server package on
   its target operating system after publication. Follow
   [Server installer validation](../testing/server-installers.md); missing
   native evidence is unavailable, never an inferred pass.

## Local Verification

The commands below remain release-specific checks. Use the
[testing runbooks](../testing/README.md) for repeatable native platform,
packaged UI, external-worktree, visual, process-cleanup, and compatibility
evidence. This release checklist owns publication and release-asset approval;
the runbooks own validation procedure and reporting.

Run the repository gates:

```powershell
vp check
vp run typecheck
vp test
vp run release:smoke
```

Run the updater/release regression set before changing stable release
infrastructure:

```powershell
vp test scripts/tauri-hardening.test.ts scripts/build-desktop-artifact.test.ts scripts/build-tauri-update-manifest.test.ts scripts/build-server-artifact.test.ts scripts/verify-server-artifacts.test.ts scripts/server-install-smoke.test.ts scripts/privacy-contract.test.ts scripts/legacy-cloud-removal-contract.test.ts scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts
vp test apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/components/AppSidebarLayout.test.tsx apps/web/src/tauriDesktopBridge.test.ts apps/web/src/components/desktopUpdate.logic.test.ts apps/web/src/state/desktopUpdate.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop -j 2
```

Build the native artifact for the current operating system:

```powershell
vp run build:desktop
```

On macOS 26, verify Finder's rendered application icon from the generated DMG
before publishing it. Build through the artifact wrapper without `--arch` so it
uses the current Mac's architecture. Choose a fresh, empty output directory and
use that same directory for the mount check:

```sh
(
set -e
artifact_dir=release/desktop/macos
node scripts/build-desktop-artifact.ts --platform mac --target dmg --output-dir "$artifact_dir" --verbose

dmg=$(find "$artifact_dir" -maxdepth 1 -type f -name '*.dmg' -print -quit)
test -n "$dmg"
mount_dir=$(mktemp -d /private/tmp/bibcode-icon-dmg.XXXXXX)
attached=0
cleanup() {
  if [ "$attached" -eq 1 ]; then hdiutil detach "$mount_dir"; fi
  rmdir "$mount_dir"
}
trap cleanup EXIT

hdiutil attach -readonly -nobrowse -noverify -mountpoint "$mount_dir" "$dmg"
attached=1
swift scripts/check-macos-app-icon.swift "$mount_dir/BiBCode.app"
)
```

Build a specific release target:

```powershell
node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64 --output-dir release --verbose
```

Equivalent root shortcuts are `dist:desktop:dmg`,
`dist:desktop:dmg:arm64`, `dist:desktop:dmg:x64`,
`dist:desktop:linux`, `dist:desktop:win`, and `dist:desktop:win:x64`. The root
package retains an ARM64 Windows artifact command for development experiments,
but Windows ARM is not a supported release target.

For a host-native server candidate, choose a fresh absolute output directory:

```powershell
node scripts/build-server-artifact.ts --target <native-rust-target> --formats native,portable --output-dir <fresh-absolute-output> --unsigned-test
```

This is local compatibility/build evidence, not a signed release. Finalization
uses `scripts/sign-server-artifacts.ts`; verification uses
`scripts/verify-server-artifacts.ts --require-complete-matrix`. Do not publish
an `unsigned-test` manifest or substitute a cross-built package for native
installer evidence.

## References

- [Tauri configuration](https://v2.tauri.app/reference/config/)
- [Tauri updater](https://v2.tauri.app/plugin/updater/)
- [GitHub-hosted runners](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)
