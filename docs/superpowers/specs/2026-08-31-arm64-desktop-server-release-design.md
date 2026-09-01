# ARM64 Desktop and Standalone Server Release Design

**Date:** 2026-08-31
**Status:** Approved in design review
**Scope:** Native desktop installers, standalone server distributions, release assembly,
package validation, updater metadata, and installation documentation

## Summary

BiBCode will publish native desktop installers and standalone server distributions for
macOS, Linux, and Windows on both x64 and ARM64. Desktop artifacts retain the existing
Tauri installer and updater model. Standalone server artifacts contain the native
`bibcode` executable, the version-matched static web client, the license, and a focused
installation guide.

The release pipeline uses independent native desktop and server matrices. A final
assembly job verifies the complete public artifact contract before a stable release can
be published. Linux server distributions include portable archives plus direct-download
`.deb` and `.rpm` packages. This design does not create package repositories, install
background services, configure firewalls, or automatically provision remote machines.

## Context

The current release workflow publishes:

- macOS DMGs for Apple Silicon and Intel;
- one Linux x64 AppImage;
- one Windows x64 NSIS installer; and
- a four-platform Tauri `latest.json` updater manifest.

The build planner already maps Linux and Windows ARM64 to
`aarch64-unknown-linux-gnu` and `aarch64-pc-windows-msvc`, and the release workflow
contains a disabled Windows ARM64 entry. The remaining release code intentionally
restricts Linux and Windows updater targets to x64. Windows package scripts also route
through an x64-specific MSVC environment launcher.

Remote Servers increases the value of a separately distributable `bibcode` executable.
Desktop-managed SSH expects a compatible native `bibcode` command on the remote host's
non-interactive `PATH`, while direct and paired clients can connect to an independently
running headless server. The native server can serve a browser client only when a static
web directory is supplied, so a complete standalone distribution must include and
discover the version-matched web build.

## Goals

1. Support native desktop releases on macOS, Linux, and Windows for x64 and ARM64.
2. Publish standalone server distributions for the same six native targets.
3. Publish Linux server `.deb` and `.rpm` packages for x64 and ARM64 in addition to
   portable archives.
4. Preserve the existing stable Tauri updater trust chain while extending it to Linux
   and Windows ARM64.
5. Bundle version-matched static web assets with every standalone server distribution.
6. Make packaged web assets discoverable without requiring `--static-dir`, while
   preserving an explicit override.
7. Prove the architecture, installability, startup, pairing, connection, shutdown, and
   packaged desktop UI behavior on native hosts.
8. Prevent partial or incomplete stable releases from becoming public.
9. Keep package and support documentation aligned with the executable release contract.

## Non-goals

- Creating APT, DNF, or YUM repositories.
- Registering `launchd`, `systemd`, or Windows services.
- Adding login items, scheduled tasks, privileged helpers, firewall rules, users, or
  groups.
- Automatically installing or updating `bibcode` on a remote host.
- Adding self-update behavior to the standalone server.
- Deleting or migrating user-owned BiBCode data during package removal.
- Adding a production Node.js runtime, TypeScript server, Electron host, or sidecar.
- Adding Apple Developer ID/notarization or Windows Authenticode in this change.
- Replacing current desktop installer formats with additional macOS or Windows formats.

## Public artifact contract

### Desktop artifacts

Every stable release must contain the following native installers and updater artifacts:

| Platform | Architecture | Installer | Stable updater target |
| --- | --- | --- | --- |
| macOS | ARM64 | DMG | `darwin-aarch64` |
| macOS | x64 | DMG | `darwin-x86_64` |
| Linux | ARM64 | AppImage | `linux-aarch64` |
| Linux | x64 | AppImage | `linux-x86_64` |
| Windows | ARM64 | NSIS | `windows-aarch64` |
| Windows | x64 | NSIS | `windows-x86_64` |

The Tauri static updater manifest uses the standard `OS-ARCH` keys. Numeric stable
releases require all six valid entries. Prereleases and nightlies retain the current
installer-only behavior and do not become updater candidates.

Tauri-generated installer basenames remain authoritative. Release validation must map
each native build target to exactly one expected installer and updater descriptor rather
than depending on a single architecture spelling in the filename.

### Standalone server artifacts

Every release publishes these portable server archives:

- `bibcode-server-vVERSION-darwin-x86_64.tar.gz`
- `bibcode-server-vVERSION-darwin-aarch64.tar.gz`
- `bibcode-server-vVERSION-linux-x86_64.tar.gz`
- `bibcode-server-vVERSION-linux-aarch64.tar.gz`
- `bibcode-server-vVERSION-windows-x86_64.zip`
- `bibcode-server-vVERSION-windows-aarch64.zip`

Linux additionally publishes:

- `bibcode-server_VERSION_amd64.deb`
- `bibcode-server_VERSION_arm64.deb`
- `bibcode-server-VERSION-1.x86_64.rpm`
- `bibcode-server-VERSION-1.aarch64.rpm`

The RPM release field is `1`. Package versions and architectures must match the release
tag and target exactly.

Portable archives contain one versioned top-level directory with:

- `bibcode` or `bibcode.exe`;
- `web/`, containing the complete version-matched production web build;
- `README.md`, copied from the living standalone server installation guide; and
- `LICENSE`.

Linux packages install:

- `/usr/bin/bibcode`;
- `/usr/share/bibcode/web/`;
- `/usr/share/doc/bibcode-server/README.md`; and
- `/usr/share/doc/bibcode-server/LICENSE`.

The Linux package name is `bibcode-server`; the public command remains `bibcode`.
Package scripts must not create or modify user data, services, accounts, firewall state,
or machine-wide configuration. Removal deletes only package-owned paths. User data such
as `~/.bibcode` remains untouched.

### Checksums and optional server signatures

Every server archive and package is covered by `bibcode-server-SHA256SUMS`. Missing or
incorrect checksums block publication.

Server artifact signing is optional in this phase. When a dedicated server signing key
is configured, the release emits and verifies `<artifact>.minisig` for each server
artifact plus `bibcode-server-SHA256SUMS.minisig`. When no server signing key is
configured, the workflow reports that the server artifacts are unsigned and continues.
It must not claim signatures exist or silently publish invalid signature files.

The optional server key is independent of the Tauri updater key. Stable desktop updater
signatures remain mandatory because installed desktop clients rely on that trust chain.

## Runtime static asset discovery

The server's static directory precedence is:

1. An explicit CLI `--static-dir` value.
2. A validated distribution-relative `web/` directory beside the packaged executable.
3. The installed package location `/usr/share/bibcode/web` on Linux, resolved from the
   executable layout rather than the process working directory.
4. No static web directory, preserving the existing API-only headless mode for source
   builds or intentionally minimal deployments.

Automatic discovery accepts a candidate only when it is a directory and contains the
required production entry point. An invalid explicit `--static-dir` remains an explicit
configuration error and must not fall through to packaged assets. Discovery never
searches arbitrary current-working-directory or user-writable paths.

`bibcode start` and `bibcode serve` use the same resolved static directory. An explicit
override therefore remains predictable, while a packaged installation works without
requiring users to locate its web files. The selected source is logged without exposing
credentials or pairing material.

## Release architecture

### Shared target catalog

One release-target definition owns, for each supported target:

- public platform and architecture names;
- Rust target triple;
- native runner label;
- desktop installer kind;
- Tauri updater key;
- server archive kind;
- package-manager architecture spelling; and
- validation expectations.

Build planning, updater serialization, server packaging, release completeness checks,
workflow contract tests, and seeded upgrade fixtures must consume or validate against
that definition. GitHub workflow YAML cannot import TypeScript directly, so repository
tests enforce exact parity between the declared workflow matrices and the target catalog.

### Desktop build matrix

| Target | Runner |
| --- | --- |
| macOS ARM64 | `macos-26` |
| macOS x64 | `macos-26-intel` |
| Linux ARM64 | `ubuntu-22.04-arm` |
| Linux x64 | `ubuntu-22.04` |
| Windows ARM64 | `windows-11-vs2026-arm` |
| Windows x64 | `windows-2025` |

Each job builds on the target architecture. Linux ARM64 AppImages are not
cross-compiled because the AppImage toolchain requires an ARM host. Windows ARM64 uses
the native MSVC target and produces a native ARM64 application; the NSIS bootstrap may
execute through Windows emulation as documented by Tauri.

The x64-only MSVC launcher becomes an architecture-aware Windows MSVC launcher. It
selects the component requirement, `vcvarsall` argument, Cargo target runner, temporary
script identity, and environment key from the requested Rust target. Existing x64
behavior remains covered and no second ARM-only wrapper becomes another source of
policy.

### Server build matrix

The server uses a separate six-target native matrix with the same runner selection. A
server job:

1. aligns package versions to the release version;
2. builds the production web client once for that distribution;
3. builds `apps/server`'s `bibcode` release executable for the native Rust target;
4. verifies the binary target and reported version;
5. stages the portable distribution layout;
6. creates the platform archive;
7. creates `.deb` and `.rpm` packages for Linux; and
8. executes the native distribution smoke tests before upload.

Desktop and server artifacts remain separate job outputs. A desktop packaging failure
does not hide server status, and a server packaging failure does not get folded into a
successful desktop result.

### Release assembly

The final release job receives artifacts only from successful matrix jobs and performs
these steps in order:

1. Download every internal desktop and server artifact into isolated directories.
2. Reject missing, duplicate, incorrectly named, or unexpected public assets.
3. Validate versions and architecture metadata against the release target catalog.
4. Build the six-platform Tauri `latest.json` for updater candidates.
5. Cryptographically verify every Tauri updater payload and manifest entry.
6. Generate `bibcode-server-SHA256SUMS` from the final public bytes.
7. Optionally sign and verify server artifacts when the dedicated key is configured.
8. Create or update the GitHub draft with the complete validated asset set.
9. Publish or mark latest only through the existing stable-release approval path.

Stable publication is atomic at the GitHub release boundary: no release is made public
until the complete contract passes. A failed rerun must not combine stale assets from a
previous attempt with current outputs.

## Direct-download package model

`.deb` and `.rpm` files are GitHub Release assets. This change does not create repository
metadata, GPG repository roots, mirror infrastructure, install scripts, or `curl | sh`
flows. Documentation shows explicit download, checksum verification, package inspection,
installation, upgrade, and removal commands.

APT/YUM repository hosting is a future architectural decision because it adds persistent
index availability, repository signing, key rotation, retention, and mirror semantics.

## Validation strategy

### Static and contract tests

Repository tests cover:

- all six target mappings and Rust triples;
- workflow matrix parity with the shared target catalog;
- ARM64 updater descriptor encoding and six-platform manifest completeness;
- target-specific artifact suffixes and package architecture spellings;
- architecture-aware MSVC environment selection;
- deterministic archive contents and path traversal rejection;
- checksum generation and optional signing behavior;
- release rejection for missing, duplicate, stale, or unexpected assets;
- explicit-versus-packaged static directory precedence; and
- invalid or incomplete packaged web directories.

The normal required gates remain `vp check`, `vp run typecheck`, Rust formatting,
relevant Rust tests, and Clippy with warnings denied.

### Native desktop validation

Normal CI expands its native desktop build matrix to all six targets. The packaged UI
and seeded upgrade workflows also add Linux ARM64 and Windows ARM64.

For every desktop target, validation confirms:

- the installer is produced by the native target job;
- the installed application binary has the expected architecture;
- the packaged UI scenario suite completes against the native artifact;
- Remote Servers and Another-device scenarios retain their existing coverage;
- screenshots and diagnostic logs are uploaded on success or failure; and
- installer and spawned-process cleanup completes.

Linux uses Xvfb where no interactive display is available and retains the AppImage
portability inspection. Windows retains silent NSIS install and installed-executable
discovery. macOS retains DMG mounting and recursive application signature inspection.
Seeded updater validation exercises the new Linux and Windows ARM64 updater entries rather
than validating only manifest serialization.

### Native server validation

Every server target validates the exact staged distribution, not only Cargo output:

1. Inspect the executable and confirm its native architecture.
2. Run `bibcode --version` and require the release version.
3. Extract or install into an isolated environment.
4. Start `bibcode serve` with a temporary data root and no explicit `--static-dir`.
5. Verify that packaged web discovery serves the production entry point.
6. Probe the environment/readiness endpoint.
7. Issue pairing material and establish a real client connection.
8. Shut down and prove owned process cleanup.

The Linux package matrix additionally performs native-architecture container checks:

| Package | Validation systems |
| --- | --- |
| `.deb` | Ubuntu 22.04, Ubuntu 24.04, Debian 12 |
| `.rpm` | Rocky Linux 9, Fedora 44 |

Tests inspect package metadata and contents, install the local package, run the server
smoke, remove it, confirm package-owned paths are gone, and confirm a sentinel in an
isolated BiBCode data root remains. ARM64 validation runs in native ARM64 containers on
the ARM64 GitHub runner; x64 validation runs natively on the x64 runner. Emulation or a
cross-compiled binary does not replace native release evidence while hosted native
runners are available.

## Failure handling

- A missing architecture, installer, updater descriptor, server artifact, package,
  checksum, or required validation result blocks stable publication.
- A checksum mismatch or configured-signature verification failure blocks publication.
- The absence of the optional server signing key is reported but does not fail the
  release.
- The absence of the Tauri updater key for a stable updater candidate remains fatal.
- No architecture silently falls back to x64, emulation, cross-compilation, or a
  different package format.
- Build jobs use unique artifact names and clean staging directories so reruns cannot
  reuse stale outputs.
- A failed Linux package install must not be relabeled as archive-only support.
- Failures upload bounded logs, package inventories, and UI evidence without uploading
  credentials, signing keys, pairing tokens, or user data.

## Documentation and download surfaces

The implementation updates these living surfaces together:

- `docs/operations/release.md`: full runner, installer, server, checksum, signing, and
  publication contract.
- `docs/operations/ci.md`: native ARM64 and package validation gates.
- `docs/reference/scripts.md`: desktop and server packaging commands.
- `docs/testing/cross-platform-validation.md` and native platform runbooks: required ARM64
  and server distribution evidence.
- `docs/user/remote-access.md`: direct-download prerequisites and manual-update behavior.
- a new living standalone server installation guide used as each archive's `README.md`.
- `docs/README.md`: link to the server installation guide.
- the root `README.md` and marketing download page: supported desktop and server matrix.

Execution-specific versions, SHAs, timings, screenshots, and machine paths remain in
dated test reports rather than living runbooks.

## Security and trust boundaries

- Desktop updater signing continues to use its existing private key and verifier.
- Optional server signatures use a separate secret and public key identity.
- Build logs never print private key content or passwords.
- Static asset discovery is executable-relative and validates the entry point; it does
  not search arbitrary writable directories.
- Packages do not widen the server listener, create pairing credentials, open firewall
  ports, or enable public access. Listener and pairing behavior remain explicit runtime
  choices.
- Direct package installation requires the user's normal OS privilege escalation; the
  package itself performs no hidden privilege-bearing setup.
- macOS remains ad-hoc signed/unnotarized and Windows remains without Authenticode in
  this scope. Documentation must describe those existing OS trust limitations honestly.

## Alternatives considered

### Build desktop and server together in one matrix

This would reduce runner count and might reuse some compilation. It was rejected because
desktop packaging and server distribution have different artifact, signing, and
validation contracts. Independent matrices make failures attributable and permit future
server-only releases without restructuring the pipeline.

### Cross-compile server artifacts from fewer hosts

Rust supports the requested targets, but native builds provide stronger evidence for
platform libraries, process behavior, package metadata, and startup. Hosted native
runners are available for all six targets, so cross-compilation is not the release
source of truth.

### Publish only portable archives

Archives remain necessary for unmanaged hosts, but `.deb` and `.rpm` make `bibcode`
available on the normal non-interactive `PATH`, support clean upgrades/removal, and fit
desktop-managed SSH prerequisites. The packages remain deliberately free of service and
network side effects.

### Install persistent OS services

Service installation was rejected for this phase. It would add privileged lifecycle,
credential storage, logging, boot ordering, update rollback, and uninstall semantics on
three operating systems.

### Host APT and RPM repositories

Repository hosting was rejected for this phase. Direct GitHub assets meet the requested
installation contract without adding a persistent distribution control plane.

### Ship only the server executable

This was rejected because browser use would require users to find a separately built,
version-matched web client. Bundling static assets produces a self-contained server
distribution without adding a production Node runtime.

## Completion criteria

The implementation is complete only when:

1. CI and release matrices contain all six native desktop and server targets.
2. Stable updater manifests require and verify all six desktop targets.
3. Releases contain six server archives and four Linux server packages with exact
   version and architecture metadata.
4. Every server distribution includes and automatically serves the version-matched web
   client when no explicit static directory is supplied.
5. Native desktop packaged UI and seeded updater coverage includes Linux and Windows
   ARM64.
6. Native server distribution smoke passes on all six targets.
7. `.deb` and `.rpm` installation, execution, removal, and data-preservation checks pass
   on the documented Linux systems and both architectures.
8. Release assembly rejects incomplete, stale, duplicate, mis-architected, or
   checksum-invalid outputs before publication.
9. Stable Tauri updater signing remains mandatory; server checksum generation is
   mandatory; server signatures behave exactly as the optional configuration specifies.
10. Living documentation and download surfaces describe the shipped matrix and manual
    installation/update model accurately.
11. Required repository checks pass and the final diff contains no unrelated or
    generated changes.
