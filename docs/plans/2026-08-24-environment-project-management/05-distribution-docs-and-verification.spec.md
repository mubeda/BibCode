# Distribution, Documentation, And Verification Specification

## Server-Only Product

Create independently installable BiBCode Server artifacts alongside the
existing Tauri desktop artifacts.

The server product contains:

- Native Rust `bibcode` executable with server and administrative CLI commands.
- Compiled `apps/web` static assets so secure same-origin browser use remains
  supported.
- Workstation/headless service definitions or installer actions.
- License/notices and platform-appropriate uninstall metadata.

It excludes:

- Tauri desktop shell and WebView dependencies.
- Production Node.js/TypeScript runtime.
- BiBCode Connect/cloud relay components.
- Telemetry/crash-upload agents.
- A privileged native helper sidecar.

## Artifact Matrix

| OS      | Architecture | Installer   | Portable | Default service                   |
| ------- | ------------ | ----------- | -------- | --------------------------------- |
| Windows | x86_64       | Signed MSI  | ZIP      | Per-user logon task               |
| Windows | ARM64        | Signed MSI  | ZIP      | Per-user logon task               |
| macOS   | Universal    | PKG         | —        | LaunchAgent                       |
| macOS   | x86_64       | —           | tar.gz   | Manual or LaunchAgent CLI install |
| macOS   | arm64        | —           | tar.gz   | Manual or LaunchAgent CLI install |
| Linux   | x86_64       | DEB and RPM | tar.gz   | systemd user service              |
| Linux   | ARM64        | DEB and RPM | tar.gz   | systemd user service              |

Every release also publishes:

- SHA-256 checksum manifest.
- Detached artifact signatures using the repository's approved release key
  mechanism.
- SBOM for server artifacts and bundled web dependencies.
- Build provenance/attestation where repository visibility/plan supports it.
- Machine-readable artifact manifest containing product, version, OS,
  architecture, format, checksum, size, signing/notarization state, and download
  name.

The artifact manifest, not filename guessing, drives SSH provisioning and
release smoke discovery.

## Packaging Strategy

Extend the existing Rust/web/release pipeline rather than replacing the current
desktop pipeline wholesale.

1. Build/test the web application once per reproducible input and stage its
   static assets for the server package.
2. Build the Rust server/CLI for each target.
3. Assemble deterministic portable layouts.
4. Build native installers with platform-native tooling/configuration owned by
   repository scripts.
5. Sign when the platform policy requires/credentials permit.
6. Generate checksums, SBOM, manifest, and attestations after final bytes exist.
7. Run artifact/install smoke before publication.
8. Publish server and desktop assets under unambiguous product names.

Evaluate cargo-dist or comparable tooling only as an implementation aid. Do not
adopt it if it cannot preserve the current desktop updater signatures, artifact
names/discovery, optional macOS signing path, native installer semantics, or
repository release checks without parallel sources of truth.

## Signing

### Windows

MSI and contained executable signing is required for the approved stable
artifact matrix. CI uses the existing repository-approved secret mechanism or a
documented signing service. Unsigned local/test packages may be built under a
clearly different non-release path and cannot be promoted as stable.

### macOS

Developer ID signing and notarization are optional. The current working
credential-free baseline uses Tauri's ad-hoc identity (`-`) for desktop and must
remain validated. Server PKG/tar builds must also succeed without Developer ID
credentials and clearly report `unsigned/ad-hoc, not notarized` in the artifact
manifest and documentation.

When Developer ID credentials are present, signing/notarization is an additive
release path with its own verification. Absence of those credentials does not
break ordinary builds.

Tauri updater signing is a separate integrity mechanism and remains required
where the current stable desktop updater requires it. Do not conflate updater
signatures with Apple identity/notarization.

### Linux And Common Integrity

DEB/RPM repository signing is outside the first direct-download scope unless an
actual package repository is introduced. Detached release signatures, checksum
verification, SBOM, and provenance apply to all downloadable artifacts.

## Installer Behavior

All installers:

- Show target version, architecture, install path, service mode, data path, and
  network default before mutation.
- Default to per-user workstation mode and loopback bind.
- Do not open a firewall port by default.
- Install/upgrade atomically where platform tooling permits.
- Preserve the data directory on uninstall by default.
- Offer headless/system mode only through an explicit elevated flow.
- Register a working `bibcode` CLI and local admin channel.
- Support unattended package-manager syntax only with explicit documented
  choices; unattended does not imply data purge or insecure bind.
- Leave recoverable diagnostics and rollback instructions on partial failure.

Portable archives do not silently register services. They include commands for
manual foreground use and explicit service installation.

## Connection After Install

### Same Host

1. Service starts on loopback.
2. User runs `bibcode auth pairing create` or opens the local server URL.
3. Same-origin browser uses a secure session cookie; desktop client redeems the
   pairing credential and stores a DPoP-bound secret.

### SSH Remote

1. BiBCode desktop tests SSH and probes the installed server/service.
2. It invokes `bibcode auth pairing create --format json` through SSH.
3. It establishes a local loopback SSH forward to the remote loopback server.
4. It verifies descriptor identity before consuming the one-time credential.
5. It adds/updates the SSH route under the proved environment.

### Direct HTTPS

1. Administrator explicitly configures non-loopback TLS on the host.
2. Pairing is created locally/through SSH.
3. Client verifies system trust or the fingerprint obtained through that secure
   enrollment channel.
4. It redeems pairing and records the HTTPS route.

Installer completion must not claim a remote client is connected merely because
the service started.

## CI/CD Workflow

Keep desktop release behavior working while adding a separately named server
matrix. Jobs should isolate build, package, sign, smoke, attest, and publish so a
failure cannot publish a partial platform as a complete stable release.

### Required Gates

- Source/contract tests and required repository checks before packaging.
- Rust format, focused/all affected tests, and Clippy with warnings denied.
- Web production build and static-asset integrity.
- Portable server foreground start, descriptor, pairing, authenticated
  WebSocket/RPC, graceful shutdown, and process reaping.
- Native installer install/start/restart/upgrade/uninstall smoke on native
  runners for supported host architectures where available.
- Cross-built architecture artifacts receive at least format/static inspection;
  native ARM64 execution is required before declaring that platform fully
  supported for stable release.
- Artifact manifest/checksum/signature/SBOM/provenance verification.
- Existing desktop packaging, ad-hoc macOS mount/launch checks, and updater
  signing/discovery remain green.

### Installer Smoke Scenarios

1. Clean per-user install.
2. Service starts only once and listens on loopback.
3. Local pairing expires/single-use and creates an authenticated session.
4. Browser static assets load without Node runtime.
5. Restart preserves environment/storage identities.
6. Upgrade preserves data and identity.
7. Failed upgrade restores the old binary without database downgrade.
8. Uninstall removes binary/service but preserves data.
9. Reinstall adopts preserved data/identity.
10. Explicit purge removes only the verified data root.
11. Headless install uses dedicated account and correct ACLs.
12. No service, child process, temporary tunnel, or installer helper remains
    after stop/uninstall/failure.

## Test Strategy

### Contracts And Client Runtime

- Environment/route/discovery-binding schemas and migration.
- Multiple routes for one identity, route ordering/pin/stickiness/failover.
- Environment/storage/certificate mismatch and stale-generation suppression.
- Secret-provider unavailable/session-only behavior and redaction.
- Scoped cache collision, encryption envelope, eviction, Forget clearing.
- Cold-start exact selection and offline cache behavior.

### Server

- Durable environment/storage marker initialization and legacy migration under
  crash/race/corruption/restore.
- Project repository claims: duplicate, independent clone, concurrency,
  idempotency, delete/re-add, worktree guards, replay/rebuild.
- One active Main index and Main mutation rejection.
- Pairing CLI/control IPC ACL, expiry, consumption race, DPoP binding,
  revocation, and redaction.
- Non-loopback HTTP startup rejection and TLS configuration.
- Service locks, drain, update, restart verification, rollback, shutdown/reaping.

### Desktop And WSL

- WSL UTF output parsing, all running distros, stopped retention, malformed
  lines, missing/disabled WSL, timeout/cancellation, rename/identity reconcile.
- Explicit setup/install; no stopped-distro start and no unregister command.
- OS secret-store bridge behavior on Windows/macOS/Linux.
- SSH probe/provision/pair/tunnel on Linux, macOS, and Windows OpenSSH,
  including quoting, host-key changes, cancellation, partial transfer/install,
  and cleanup.

### Web UX

- Environment-owned tree; no cross-environment repository merging.
- Expansion/order/pin/alias/search/selection persistence.
- Environment overview/settings ownership and host-control gating.
- Status vocabulary and cached read-only states.
- Duplicate add focus behavior.
- Hide/restore, online removal options, offline force warning, typed purge.
- Main/ordinary/worktree rows and center-only panel tabs.
- Keyboard/tree ARIA, focus/selection, screen reader names, non-color status,
  reduced motion, narrow/large tree.

### Privacy And Negative Policy

- Dependency/source/bundle scans reject telemetry, crash-upload, Clerk,
  Cloudflare relay, managed endpoints, and BiBCode Connect.
- Logs/diagnostic exports are exercised with seeded credentials, tokens, host
  data, and paths to prove redaction.
- Network tests prove no unexpected outbound request during startup, ordinary
  use, crash, or diagnostics; update checks use only documented endpoints and
  disclose their behavior.

## Living Documentation Changes

Implementation is not complete until every affected living document is updated
and verified against source, scripts, tests, CI, and release workflows.

### Entry Points And User Guides

- Root README and `docs/README.md` installation/usage/index links.
- First run and primary environment.
- Left-panel environment/project/thread navigation.
- Adding local WSL, SSH, and HTTPS environments.
- Offline cache/search/status behavior.
- Environment settings and paired-client management.

### Administration

- Windows/macOS/Linux server installation and uninstall.
- Workstation versus headless service accounts/startup.
- SSH prerequisites, probing, provisioning, host keys, and tunneling.
- TLS certificate configuration and pin/system trust.
- Pairing, revocation, secret storage, updates, backup/restore, migration,
  uninstall, force remove, and purge.
- Privacy/no-telemetry contract and explicit diagnostics export.
- Troubleshooting for identity mismatch, auth required, incompatible versions,
  service failure, locked secret stores, WSL, SSH, TLS, and update recovery.

### Architecture And Reference

- `docs/architecture/overview.md`.
- `docs/architecture/remote.md`.
- `docs/architecture/connection-runtime.md`.
- RPC/auth/provider/process/worktree architecture documents where call paths or
  invariants change.
- Workspace layout and encyclopedia terminology.
- Scripts, environment variables, package/workspace, and CLI reference.
- Removal of living Connect/cloud documents and index entries.

### Operations And Testing

- CI and release artifact discovery/signing/publication.
- Native Windows, macOS, Linux, WSL, remote-environment, provider-visibility,
  worktree, process-lifecycle, and packaged visual runbooks under `docs/testing/`.
- Execution report template fields for server artifact, identity, route,
  service mode, installer/signing state, and explicit no-telemetry evidence.

Historical dated plans are not rewritten to claim current behavior.

## Performance And Reliability Gates

- Connection supervision has bounded concurrent attempts, per-attempt timeout,
  cancellation, jittered backoff, and no unowned tasks.
- WSL discovery and sidebar rendering do not poll or recompute Git/network state
  per row.
- 100 environments/1,000 visible cached rows remain responsive and stable.
- Cache has explicit byte/age budgets; updates and logs have bounded storage.
- SSH transfer/install and update pipelines stream bounded I/O and report
  progress without buffering arbitrary output.
- Reconnect/duplicate delivery/partial stream/stale result/restart tests preserve
  current correctness guarantees.

## Repository Validation Baseline

Every implementation phase runs focused tests first. Before completion, run all
applicable repository requirements, including:

```text
vp check
vp run typecheck
cargo fmt --all --check
relevant Rust tests
Clippy for affected targets with warnings denied
```

Also run affected web/client/runtime/package tests, installer/release smoke,
native runbooks, dependency/policy scans, and final `git diff`/`git status`
review. Exact commands belong in the implementation plan after confirming the
then-current manifests/scripts.

## Release Acceptance Criteria

- Every matrix artifact exists, is discoverable from the manifest, and has
  checksum/signature/SBOM/provenance evidence.
- Server installs and connects through the documented local/SSH/HTTPS flow on
  Linux, Windows, and macOS.
- Server-only artifacts require no production Node runtime or desktop shell.
- Current desktop builds/updater remain functional; macOS credential-free
  ad-hoc signing still passes its established checks.
- Uninstall preserves data; purge is explicit and verified.
- Living docs and testing runbooks match the implementation and no living
  Connect instructions remain.
- No telemetry/crash upload/cloud relay behavior or dependency exists.
