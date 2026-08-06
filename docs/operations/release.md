# Release Checklist

This document describes the Tauri 2 desktop release workflow. The repository
does not package or publish Electron artifacts.

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

## Cloud Configuration

BiBCode Connect public configuration is optional for this fork. When Cloudflare and
Clerk production configuration exists, the workflow resolves and injects:

- `BIBCODE_CLERK_PUBLISHABLE_KEY`;
- `BIBCODE_CLERK_JWT_TEMPLATE`;
- `BIBCODE_CLERK_CLI_OAUTH_CLIENT_ID`;
- `BIBCODE_RELAY_URL`.

`BIBCODE_CLERK_CLI_OAUTH_CLIENT_ID` remains in build and release plumbing, but
the current native runtime has no matching headless Connect CLI or OAuth
consumer. It does not enable a CLI login flow.

Without that configuration, desktop artifacts are still built with BiBCode Connect
disabled. Never place `CLERK_SECRET_KEY` in client build variables or artifacts.

Relay deployment and hosted web deployment are separate from this fork's
desktop release. The workflow intentionally does not publish the upstream
`bibcode` npm package or deploy the upstream Vercel project.

## Signing And OS Trust

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

## Stable Release Runbook

1. Confirm the intended version and commit have passed the local verification
   commands below. Create and push the intended tag (or dispatch `stable` with
   that explicit version) with `publish` left at its default `false`.
2. Confirm the four native build jobs complete and that the stable jobs received
   the two signing secrets above. Do not inspect or print their values.
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
     and Windows NSIS installer, plus the updater payload archives required by
     the manifest; and
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
7. Install and smoke-test each ordinary installer on its target operating
   system after publication.

## Local Verification

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
vp test scripts/tauri-hardening.test.ts scripts/build-desktop-artifact.test.ts scripts/build-tauri-update-manifest.test.ts scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts
vp test apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/components/AppSidebarLayout.test.tsx apps/web/src/tauriDesktopBridge.test.ts apps/web/src/components/desktopUpdate.logic.test.ts apps/web/src/state/desktopUpdate.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop -j 2 -- --test-threads=1
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

## References

- [Tauri configuration](https://v2.tauri.app/reference/config/)
- [Tauri updater](https://v2.tauri.app/plugin/updater/)
- [GitHub-hosted runners](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)
