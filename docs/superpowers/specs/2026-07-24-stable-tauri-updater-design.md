# Stable Tauri Updater

## Goal

Restore trusted desktop update checks after the Electron-to-Tauri migration.
BiBCode will discover stable GitHub Releases on Windows x64, Linux x64, macOS
x64, and macOS arm64. It will check shortly after startup and every two hours,
notify when an update is available, and wait for the user to download and
install it.

## Current State

The Tauri updater plugin, native update manager, desktop bridge, and update UI
already exist. They are intentionally disabled because
`apps/desktop/src-tauri/tauri.conf.json` contains an empty updater public key and
no endpoints. The release workflow publishes installers but no updater
signatures or metadata.

The previous Electron implementation checked 15 seconds after startup and then
polled every four minutes. The Tauri migration retained manual update
operations but did not migrate signing, release feeds, or background polling.
The Settings UI still exposes Stable and Nightly even though neither channel can
currently check for updates.

## Requirements

- Only stable, non-prerelease GitHub Releases are update candidates.
- Cover Windows x64, Linux x64, macOS x64, and macOS arm64.
- Check 15 seconds after startup and two hours after each completed background
  check.
- A discovered update is notification-only until the user clicks Download.
- Installation continues to require explicit confirmation because it restarts
  the application and interrupts running tasks.
- Manual checks from Settings and the Help menu use the same native check path
  as background checks.
- Concurrent triggers must not produce overlapping network checks.
- Development and desktop E2E builds must remain updater-disabled and must not
  contact the production release feed.
- Background checks must not run while an update is downloading or waiting to
  be installed.
- Remove Nightly from the UI, bridge, contracts, and persisted desktop settings.
- Fail releases that lack any required updater artifact, signature, or manifest
  entry.
- Existing v0.2.10 installations require one manual installation of the first
  updater-enabled stable release.

## Selected Approach

Use a static Tauri updater manifest hosted as a GitHub Release asset:

`https://github.com/mubeda/BibCode/releases/latest/download/latest.json`

GitHub's `latest` release route excludes drafts and prereleases, so the endpoint
is stable-only without a custom service. The manifest will contain immutable,
tag-specific artifact URLs and embedded Tauri signatures for the four supported
targets.

This approach adds no production service, database, or runtime dependency.
GitHub Releases remains the single artifact host, and Tauri performs mandatory
signature verification before installation.

## Signing-Key Custody

A new dedicated Tauri updater keypair will be generated through the Tauri CLI.
The passphrase will be entered through a local secure prompt and will not appear
in chat, command output, source control, or repository files.

- Commit the public key value in `tauri.conf.json`.
- Store the private key in the GitHub Actions secret
  `TAURI_SIGNING_PRIVATE_KEY`.
- Store its passphrase separately in
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Write the requested recoverable private-key backup to
  `C:\Users\mauro\Downloads\bibcode-updater.key`.
- Refuse to overwrite an existing key backup at that path.
- The user must preserve the passphrase separately from the key backup.

GitHub Actions secrets are write-only. Losing both the private-key backup and
its passphrase would prevent future releases from updating installations that
trust this public key.

## Tauri Configuration

The base `apps/desktop/src-tauri/tauri.conf.json` will retain its empty updater
configuration so development and desktop E2E builds remain deterministic and
offline. A committed release-only Tauri configuration overlay will:

- set `bundle.createUpdaterArtifacts` to `true`;
- embed the generated public key;
- configure the stable GitHub `latest.json` endpoint; and
- retain the default passive Windows updater install mode.

`scripts/build-desktop-artifact.ts` will pass this overlay to Tauri for packaged
release artifacts. The overlay is compiled into those applications; it is not a
runtime configuration file and contains no private material.

The existing updater plugin registration and native download/install manager
remain the implementation boundary. Updater artifact signatures are independent
of operating-system code signing: macOS remains ad-hoc signed and unnotarized,
and Windows remains unsigned unless those distribution policies are changed in
a separate project.

## Release Pipeline

The existing release build matrix will receive the two Tauri signing secrets.
Tauri will generate platform-specific update bundles and `.sig` files:

| Manifest target | Update artifact |
| --- | --- |
| `windows-x86_64` | NSIS installer |
| `linux-x86_64` | AppImage |
| `darwin-x86_64` | macOS application archive |
| `darwin-aarch64` | macOS application archive |

The desktop artifact collector will copy the updater artifacts and signatures
alongside the existing DMG, AppImage, and NSIS release files. It must account
for the macOS updater archive being emitted under the sibling `macos` bundle
directory rather than the `dmg` directory.

A small repository script will assemble `latest.json` after all matrix artifacts
have been downloaded. It will:

1. require exactly one artifact and signature for each supported manifest
   target;
2. require a nonempty signature value and HTTPS, tag-specific artifact URL;
3. require the manifest version to match the stable release tag;
4. reject missing, duplicate, unknown, or malformed target entries; and
5. serialize deterministic JSON for release publication.

Stable releases will remain draft releases until all ordinary installers,
updater bundles, signatures, and `latest.json` have uploaded and their asset
names have been verified. Only then will CI publish the draft. Because GitHub's
`latest` endpoint excludes drafts, clients continue seeing the previous complete
stable release during publication.

Nightly releases may continue to exist as GitHub prereleases, but BiBCode will
not select or expose them. They do not update `latest.json` and are never
returned by the configured endpoint.

## Runtime Update Flow

`DesktopUpdateManager` remains the single owner of update state and update
operations.

1. At application startup, the desktop host starts one background updater task.
2. The task waits 15 seconds so update I/O does not contend with startup.
3. It calls the same `check_for_update` operation used by manual triggers.
4. The manager emits `checking`, then either `available`, `up-to-date`, or
   retryable `error`.
5. After the check completes, the task waits two hours and repeats.
6. An in-flight guard coalesces overlapping startup, timer, Settings, and Help
   menu triggers.
7. A scheduled check is skipped while an update is downloading or downloaded,
   preserving the pending installer until the user acts.
8. When an update is available, the existing sidebar and Settings state becomes
   actionable. No bytes are downloaded automatically.
9. Download and install continue through the existing native manager. Tauri
   verifies the signature before installation, and the UI asks for confirmation
   before restarting.

Background failures do not display unsolicited toasts. They emit the existing
retryable error state, allow an immediate manual retry, and are retried by the
next scheduled check.

## Stable-Only Cleanup

The implementation will remove:

- the Nightly/Stable selector and channel-change error handling;
- `DesktopUpdateChannel` and its schema;
- `DesktopBridge.setUpdateChannel`;
- the native `desktop_bridge_set_update_channel` command and permission;
- update-channel fields and normalization from persisted desktop settings; and
- channel parameters that currently flow through native update state helpers.

The update-state contract no longer needs a `channel` field. Existing settings
files may still contain the old JSON properties; Serde ignores those unknown
properties, and a later settings write naturally drops them. No migration file
or compatibility abstraction is needed.

The Help > Check for Updates menu action will be connected to the same manual
check behavior instead of only emitting an unhandled renderer event.

## Error Handling

- Missing signing secrets fail the release build.
- An existing private-key backup path aborts key generation instead of being
  overwritten.
- Missing or malformed updater artifacts fail manifest assembly.
- Release publication remains blocked while updater assets are incomplete.
- Endpoint or network failures become retryable update-state errors.
- A busy manager coalesces duplicate checks without reporting a false failure.
- Signature verification failure prevents installation and preserves a
  retryable download/install error for the user.
- No background or failed check clears an already downloaded update.

## Verification

Automated checks will cover:

- deterministic four-platform `latest.json` generation;
- rejection of missing, duplicate, malformed, or mismatched artifacts;
- stable-only workflow gating and draft-before-publish behavior;
- release-overlay configuration of `createUpdaterArtifacts`, public key, and
  HTTPS endpoint while base development/E2E configuration remains disabled;
- removal of Nightly contracts, settings, commands, and UI;
- startup delay and two-hour scheduling with controlled time;
- overlapping-check coalescing;
- Help menu and Settings manual checks;
- available, up-to-date, network failure, download, signature failure, and
  install paths; and
- existing desktop bridge and platform capability contracts.

The implementation completion gates are:

```text
vp check
vp run typecheck
```

Targeted frontend, release-script, Rust updater, and signed mock-feed tests will
also run. A release dry run must prove that all four signed updater artifacts
produce a valid `latest.json` before the first updater-enabled stable release is
published.

## Rollout

The first release containing the public key and endpoint cannot be discovered by
v0.2.10 because that version embeds neither. Existing users must manually
install that release from GitHub once. Every later stable release can use the
signed in-app update flow.

Release notes for the bootstrap release must state this one-time requirement and
must not claim that v0.2.10 can self-update.

## Alternatives Rejected

- **Dynamic update service.** It adds hosting, monitoring, authentication, and
  another runtime failure point without improving the stable-only requirement.
- **GitHub API detection with browser downloads.** It can announce releases but
  does not restore trusted in-app download and installation.
- **Re-enable the button without signing.** Tauri does not permit unsigned
  updater installation, and presenting an actionable button without a trusted
  feed would be misleading.
- **Retain Nightly as a dormant channel.** It preserves dead settings, bridge,
  and contract surface that contradicts the stable-only product decision.

## Non-Goals

- Updating v0.2.10 without a one-time manual bootstrap installation.
- Automatic downloading or unattended installation.
- A Nightly or prerelease update channel.
- Apple Developer ID signing, notarization, or Windows Authenticode signing.
- A hosted update API or database.
- Replacing or mutating already published release assets.

## References

- [Tauri updater](https://v2.tauri.app/plugin/updater/)
- [Tauri configuration](https://v2.tauri.app/reference/config/)
- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
