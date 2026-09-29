# Release Checklist

This document describes the Tauri 2 desktop and native standalone-server release
workflow. The repository does not package or publish Electron artifacts.

## Release Workflow

`.github/workflows/release.yml` supports:

- stable releases from tags matching `v*.*.*`; and
- manual stable or nightly releases through `workflow_dispatch`.

For validation-only release-candidate verification from a feature branch, dispatch the workflow
with `validate_only=true`, `publish=false`, and a unique prerelease version such
as `0.4.2-validation.123`. This path runs the complete native desktop and server
matrices, assembles and checksums the public asset set, and uploads it as the
`validated-release-assets` Actions artifact. It does not create or modify a Git
tag or GitHub Release. It runs `vp check` and `vp run typecheck` before the
native matrices and relies on the pull-request CI workflow for the full test
graph. `validate_only` and `publish` are mutually exclusive.

Publication-capable preflight runs `vp check`, `vp run typecheck`, and
`vp run -r --concurrency-limit 1 test`; validation-only preflight skips the
duplicated full test graph after check and typecheck. The test graph runs one
package task at a time so each Cargo invocation finishes compiling before its
test binaries run: with the default concurrency the server suites ran while
`rustc` was still building the desktop crate, and tests that hold 2-second
deadlines (hook body reads, port-release probes) failed on starved hosted
runners. The direct recursive `-r` invocation applies the limit to package
tasks; a limit on the root `test` wrapper does not constrain its nested graph.
The publication preflight has a 60-minute budget because a cold
runner compiles the full Rust workspace through the package graph; measured
hosted runs exceeded both 30 and 45 minutes without a failing test. The build
matrix then creates native Tauri installers on the matching operating system:

| Platform | Runner                  | Architecture | Installer       |
| -------- | ----------------------- | ------------ | --------------- |
| macOS    | `macos-26`              | arm64        | DMG             |
| macOS    | `macos-26-intel`        | x64          | DMG             |
| Linux    | `ubuntu-22.04-arm`      | arm64        | AppImage        |
| Linux    | `ubuntu-22.04`          | x64          | AppImage        |
| Windows  | `windows-11-vs2026-arm` | arm64        | NSIS executable |
| Windows  | `windows-2025`          | x64          | NSIS executable |

Release builds retain `panic=unwind`. Wry's macOS custom-protocol handlers use
Objective-C exception recovery when navigation cancels an in-flight request;
`panic=abort` turns that recoverable condition into process termination. Thin LTO,
one codegen unit, and symbol stripping remain enabled. Native macOS CI executes
the release-profile `objc_exception_probe`, and the desktop crate rejects an
abort profile on macOS.

Each matrix job installs the frontend build toolchain and Rust, restores Cargo
caches, and runs `scripts/build-desktop-artifact.ts`. Tauri compiles the native
host and in-process server and embeds the built React assets. No Node runtime or
TypeScript server is packaged.

A separate native matrix builds `bibcode` plus the matching static web client for the
same six targets. macOS and Linux receive `.tar.gz` archives; Windows receives `.zip`.
Linux also receives direct-download `.deb` and `.rpm` packages for both architectures.
The Linux server binary is compiled on an Ubuntu 20.04 compatibility baseline, then its
packages are installed and exercised on Ubuntu 22.04, Ubuntu 24.04, Debian 12, Rocky
Linux 9, and Fedora 44.

Numeric stable versions are updater candidates and are marked latest only after
manual publication approval. Stable prerelease versions and manual nightly
releases are GitHub prereleases, are never marked latest, and publish desktop
installers plus standalone server distributions without updater metadata.

## Supported Platforms

- macOS 11 or newer on Apple Silicon (`arm64`) and Intel (`x64`);
- Windows 10 or 11 on `x64`, and Windows 11 on ARM64;
- Linux x64 and ARM64 AppImages built on matching Ubuntu 22.04 runners and exercised on Ubuntu 22.04,
  Ubuntu 24.04, and Debian 12.

`scripts/run-msvc.mjs` selects the requested native MSVC architecture. Linux desktop
release artifacts use Ubuntu 22.04; standalone server builds use the older compatibility
baseline described above.

## Standalone Server Assets

Each release contains `bibcode-server-v<version>-<os>-<architecture>.tar.gz` for macOS
and Linux or `.zip` for Windows. Public OS/architecture keys are
`darwin-{aarch64,x86_64}`, `linux-{aarch64,x86_64}`, and
`windows-{aarch64,x86_64}`. Linux also publishes:

- `bibcode-server_<version>_arm64.deb`
- `bibcode-server_<version>_amd64.deb`
- `bibcode-server-<version>-1.aarch64.rpm`
- `bibcode-server-<version>-1.x86_64.rpm`

The packages are direct GitHub Release downloads, not hosted APT or RPM repositories.
Every release includes `bibcode-server-SHA256SUMS`; optional server `.minisig` files
appear only when both dedicated server-signing secrets are configured.
Windows server archives are written through `scripts/create-portable-zip.ps1`, which assigns
forward-slash entry names explicitly. The artifact builder rejects a mislabeled non-ZIP payload,
backslash entry names, duplicate entries, traversal, or paths outside the versioned root.

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

macOS bundles merge `apps/desktop/src-tauri/Info.plist`, which relaxes App
Transport Security for web content only so the desktop can reach plain-HTTP
remote servers on a LAN or tailnet, and declares the Local Network usage
description. macOS application bundles are signed with Tauri's ad-hoc `-` identity. This
seals the complete bundle so Gatekeeper can verify that it is intact, but it
does not associate the app with an Apple Developer team or notarize it. Users
must approve a browser-downloaded build through Settings > Privacy & Security.
Release CI mounts both macOS DMGs and verifies their recursive bundle
signatures before upload.

Windows artifacts remain without Authenticode. macOS remains ad-hoc
signed/unnotarized by decision (2026-09-18): an ad-hoc identity changes with
every build, so macOS privacy grants (folder access, local network) are
re-requested after each update. Only a Developer ID certificate with
notarization would make those grants persist; adopting one requires an Apple
Developer account and new signing secrets in the release workflow. Tauri updater signatures verify update payloads; they do
not replace Apple Developer ID signing, macOS notarization, or Windows
Authenticode.

Every server artifact is covered by `bibcode-server-SHA256SUMS`. If both
`BIBCODE_SERVER_SIGNING_PRIVATE_KEY` and `BIBCODE_SERVER_SIGNING_PUBLIC_KEY` are
configured, release assembly also creates and verifies `.minisig` files. Server signing
is optional and uses a key separate from the mandatory Tauri updater key.

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
- `linux-aarch64`
- `linux-x86_64`
- `windows-aarch64`
- `windows-x86_64`

The payload URLs inside the manifest must be tag-specific HTTPS GitHub Release
URLs, not the moving `latest/download` endpoint. The moving endpoint is used
only to fetch `latest.json`. Before creating a draft, release CI verifies every
manifest payload with the public key from the release overlay and requires each
manifest signature to match its adjacent `.sig` asset.

Stable-channel and nightly prereleases never receive the updater signing overlay,
updater signatures, descriptors, or `latest.json`, and never feed the app updater. They
still publish the validated standalone server matrix and checksums.

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
for Linux ARM64/x64 AppImages, Windows ARM64/x64 NSIS installers, and macOS
ARM64/x64 DMGs.
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

Run this harness only on a disposable host or session with no unrelated
BiBCode instance. Its restarted-application cleanup currently selects the
process name (`pkill -TERM -x bibcode-desktop` on Unix and an image-name
`taskkill` on Windows), so an isolated data root does not protect another
running app from that cleanup.

## Maintainer branch flow

Maintainer integrations are local `--no-ff` merges into `main`, followed by a
push of `main` and synchronization of `develop`. They do not require a pull
request. Use the checkout that owns each branch; inspect `git worktree list`
instead of assuming a checkout location. Preserve unrelated changes.

Before the release merge, compare content. The long-lived working branch does
not receive `main`'s release merge commits back, so an ancestry check alone can
reject a branch that already contains all of `main`'s content:

```sh
work_branch='<working-branch>'
git fetch origin
git diff --quiet "$(git merge-base origin/main "$work_branch")" origin/main
```

Exit zero proves `main` adds no content relative to the merge base. A nonzero
result needs inspection and reconciliation before merging; do not assume it
is only merge history. After reconciliation, rerun candidate verification.

Prepare the intended version and curated `CHANGELOG.md` entry on the working
branch. The version updater owns both application Cargo manifests and
`Cargo.lock` as well as the four package manifests:

```sh
version='<numeric-stable-version>'
node scripts/update-release-package-versions.ts "$version"
vp fmt apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json
vp install --lockfile-only --ignore-scripts
cargo check --workspace --all-targets --locked
vp run release:smoke
```

Review and commit the preparation only when authorized. Pre-bumping all version
sources makes finalization a no-op when nothing else has changed.

Write the merge and annotated-tag messages to files. Give the merge a summary
of the requested change, implementation, tests, documentation, and review; give
the tag a `BiBCode v<version>` subject and release summary. `git merge -F -`
treats `-` as a filename. Use file-backed messages for both merge and tag so a
failed message read cannot leave a tag on the old `main`.

From the clean checkout of `main`, after the local verification below passes:

```sh
set -eu
merge_message='<merge-message-file>'
tag_message='<tag-message-file>'
tag="v$version"
git merge --ff-only origin/main
git merge --no-ff "$work_branch" -F "$merge_message"
git diff --quiet "$work_branch" HEAD
git push origin main
git tag -a "$tag" -F "$tag_message" main
test "$(git rev-parse "$tag^{commit}")" = "$(git rev-parse main)"
git push origin "refs/tags/$tag"
```

For an ordinary integration, bring `develop` up after pushing `main`. For a
release, do it after publication and finalization, so any workflow version
commit is included. Fetch again and update the clean `main` checkout first:

```sh
git fetch origin
git merge --ff-only origin/main
git merge-base --is-ancestor origin/develop main
```

If the ancestry check succeeds, run `git push origin main:develop`. If it
fails, create a disposable detached worktree at `origin/develop`, merge `main`
there with `--no-ff -F <message-file>`, resolve and verify any conflicts, and
push `HEAD:develop`. Never force `develop` to discard its own content. Remove
only that disposable worktree after a successful integration.

## Stable Release Runbook

1. Confirm the intended version and commit have passed the local verification
   commands below. Create and push the intended tag (or dispatch `stable` with
   that explicit version) with `publish` left at its default `false`.
   If a tag-triggered run exposes a release-controller defect after the native
   artifacts have built, fix and verify the controller on `main`, then start a
   manual repair run for the same version with `publish=false`. The manual
   repair run uses current release tooling only for assembly and verification;
   every desktop and server artifact remains built from the immutable tagged
   commit resolved by preflight.
2. Confirm the six native desktop and six native server build jobs complete and
   that the stable desktop jobs received
   the two signing secrets above. Do not inspect or print their values.
3. Confirm the workflow's descriptor-validation and updater-signature steps
   passed. The workflow must validate exactly six `updater-*.json` descriptors,
   one for each manifest target listed above, before it removes those internal
   descriptors from the public asset set.
4. Let the workflow create the GitHub Release as a **draft**. Before allowing
   publication, inspect its uploaded assets and `latest.json`:

   - `latest.json` has exactly the six manifest target entries above;
   - each target has a nonempty signature and a tag-specific HTTPS payload URL;
   - the release contains a nonempty `.sig` asset for each target;
   - the release contains `latest.json`, two macOS DMGs, two Linux AppImages,
     and two Windows NSIS installers, plus the standalone server archives,
     Linux `.deb`/`.rpm` packages, and updater payload archives required by the
     manifest; and
   - no private key or passphrase is present in any asset, manifest, or log.

5. Confirm the workflow's comparison of sorted asset names with its generated
   `expected-assets.txt` passed, then perform [Draft inspection](#draft-inspection).
   The workflow must leave the release a draft when the comparison or any
   verification fails. Apply the curated release notes before approval.
6. After a human has inspected the draft, rerun the workflow manually with the
   same version, select the stable channel, and set `publish` to `true`. The
   approval run requires the existing draft, rebuilds the same tagged commit,
   repeats validation, and only then publishes it. It does not upload or
   replace the inspected draft assets. Only numeric non-prerelease stable
   releases are marked latest.
7. Confirm publication through the REST latest endpoint as described below,
   inspect finalization, and synchronize `develop` using the maintainer branch
   flow. Install and smoke-test each ordinary installer on its target operating
   system after publication.

### Failed release runs

For a one-off infrastructure failure, such as an artifact upload timeout after
a successful build, inspect the failed job and rerun only failed jobs:

```sh
gh run view "$failed_run" --log-failed
gh run rerun "$failed_run" --failed
```

Two timing failures in a row require reproducing and hardening the test before
another release attempt; use [Flaky-test diagnosis](../testing/flaky-tests.md).
The approval run repeats preflight, so retrying until the tag run passes does
not establish reliable publication. Keep product deadlines and assertions
intact.

Replacing a tag is a routine recovery option only for an unpublished candidate
whose failed run produced no draft. It still requires authorization to move
that tag; existing authorization for the same recovery remains valid. Never
retag a published release. If a draft already exists, stop this procedure and
reconcile its commit and assets explicitly; approval requires the inspected
draft to match the tag. A controller-only repair can instead use the manual
repair path in step 1 without moving the tag.

After the fix has passed verification and been merged and pushed to `main`,
confirm all old runs for this tag have stopped. Use an authenticated maintainer
account that can see drafts. A failed API request is not proof of absence:

```sh
set -eu
repository=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
recovery_dir=$(mktemp -d)
gh run view "$failed_run" --json status,conclusion,headSha,event
gh run list --workflow release.yml --branch "$tag" --json status,conclusion,headSha
gh api --paginate "repos/$repository/releases?per_page=100" > "$recovery_dir/releases.json"
jq -s -e --arg tag "$tag" 'all(.[][]; .tag_name != $tag)' "$recovery_dir/releases.json"
old_tag_object=$(git ls-remote origin "refs/tags/$tag" | cut -f1)
test -n "$old_tag_object"
git tag -f -a "$tag" -F "$tag_message" main
test "$(git rev-parse "$tag^{commit}")" = "$(git rev-parse main)"
git push --force-with-lease="refs/tags/$tag:$old_tag_object" origin "refs/tags/$tag:refs/tags/$tag"
test "$(git ls-remote origin "refs/tags/$tag^{}" | cut -f1)" = "$(git rev-parse main)"
```

Inspect the new run's resolved commit. Repeat draft inspection and reapply
curated notes after every new or regenerated draft.

### Draft inspection

Use a fresh inspection directory and the previous stable tag. Compare asset
names with only the version replaced; a changed asset set needs an explanation
from the current workflow, rather than a fixed historical asset count:

```sh
set -eu
previous_tag='<previous-stable-tag>'
inspection_dir=$(mktemp -d)
gh release view "$previous_tag" --json assets > "$inspection_dir/previous.json"
gh release view "$tag" --json isDraft,targetCommitish,assets > "$inspection_dir/draft.json"
jq -r --arg old "${previous_tag#v}" --arg new "$version" \
  '.assets[].name | split($old) | join($new)' "$inspection_dir/previous.json" \
  | LC_ALL=C sort > "$inspection_dir/expected-from-previous.txt"
jq -r '.assets[].name' "$inspection_dir/draft.json" \
  | LC_ALL=C sort > "$inspection_dir/uploaded.txt"
diff -u "$inspection_dir/expected-from-previous.txt" "$inspection_dir/uploaded.txt"
jq -e '.isDraft and (.assets | length > 0 and all(.[]; .size > 0))' "$inspection_dir/draft.json"
test "$(jq -r .targetCommitish "$inspection_dir/draft.json")" = "$(git rev-parse "$tag^{commit}")"
gh release download "$tag" --dir "$inspection_dir/assets"
```

For the first release, use the current workflow's asset validation without a
previous-release comparison. Inspect the downloaded stable manifest and verify
its payloads, using the release overlay from the candidate commit:

```sh
repository=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
jq -e --arg version "$version" \
  --arg prefix "https://github.com/$repository/releases/download/$tag/" '
  .version == $version and
  (.platforms | keys == ["darwin-aarch64", "darwin-x86_64", "linux-aarch64",
                        "linux-x86_64", "windows-aarch64", "windows-x86_64"]) and
  all(.platforms[];
      (.signature | type == "string" and length > 0) and
      (.url | startswith($prefix)))
  ' "$inspection_dir/assets/latest.json"
cargo run --locked -p bibcode-updater-verifier -- \
  apps/desktop/src-tauri/tauri.release.conf.json \
  "$inspection_dir/assets/latest.json" "$inspection_dir/assets"
```

Replace the draft's generated notes with the curated `CHANGELOG.md` entry,
without its heading, saved in a notes file. Each new draft needs this step:

```sh
gh release edit "$tag" --notes-file "$notes_file"
```

After human inspection, dispatch approval and wait for the workflow to succeed:

```sh
gh workflow run release.yml --ref main -f channel=stable -f version="$version" -f publish=true
```

Both runs perform preflight and the native build matrices. The current job
budgets are 60 minutes for preflight, 90 for each desktop build, and 120 for
each server build; these are timeouts, not expected completion durations.
Use Actions job timings to plan the tag and approval runs separately.

After publication, check latest through the REST endpoint. `isLatest` is not a
supported `gh release view --json` field:

```sh
test "$(gh release view "$tag" --json isDraft --jq .isDraft)" = false
test "$(gh api "repos/$repository/releases/latest" --jq .tag_name)" = "$tag"
```

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
vp run -r --concurrency-limit 1 test
vp run release:smoke
```

Before tagging, every workspace package's `test` script must finish
successfully. Check the inventory in `pnpm-workspace.yaml` and each package's
`package.json`, including `scripts`, `oxlint-plugin-bibcode`, and `infra/relay`;
root `vp test` alone omits the package graph and Rust suites. The serialized
preflight stops at the first failed package task. Cargo likewise stops after
the first failing test binary, leaving later binaries unrun; tests within that
binary normally run to completion. A failed early gate is not evidence about
later packages or integration targets. After fixing it, rerun the complete
graph and account for every package.

Linux's case-sensitive filesystem does not reproduce module-resolution
collisions seen on case-insensitive Windows/macOS filesystems. The scripts
package's `module-case-collisions.test.ts` guards tracked module stems,
including `.ts`/`.tsx` pairs that differ only by letter case. Keep it in the
pre-tag test graph and retain native builds; the guard does not cover every
filesystem difference.

Run the updater/release regression set before changing stable release
infrastructure:

```powershell
vp test scripts/tauri-hardening.test.ts scripts/build-desktop-artifact.test.ts scripts/build-tauri-update-manifest.test.ts scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts
vp test apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/components/AppSidebarLayout.test.tsx apps/web/src/tauriDesktopBridge.test.ts apps/web/src/components/desktopUpdate.logic.test.ts apps/web/src/state/desktopUpdate.test.ts
node scripts/run-msvc.mjs cargo test -p bibcode-desktop -j 2
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
package also exposes `dist:desktop:win:arm64`; Windows 11 ARM64 and Windows
10/11 x64 are both supported release targets and require their matching native
release runners.

## References

- [Tauri configuration](https://v2.tauri.app/reference/config/)
- [Tauri updater](https://v2.tauri.app/plugin/updater/)
- [GitHub-hosted runners](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)
