# External Research

**Research date:** 2026-08-24

Primary/official sources were preferred. These sources inform the design; they
do not override BiBCode's repository boundaries or prove implementation.

## Remote Development Architecture

### VS Code Remote SSH

Source: [Remote Development using SSH](https://code.visualstudio.com/docs/remote/ssh)

Relevant findings:

- A local client can keep source and execution on the remote host by installing
  a backend there.
- Ordinary client/backend communication can remain inside an authenticated SSH
  tunnel.
- Host-specific settings are a first-class concept.
- The server supports Linux, Windows OpenSSH, and macOS hosts.

Design implication: keep projects/server state environment-local, make SSH the
safe default remote route, and expose environment-specific settings rather than
copying remote source into a central client store.

### VS Code WSL And Remote Model

Sources:

- [Remote development in WSL](https://code.visualstudio.com/docs/remote/wsl-tutorial)
- [Remote Development FAQ](https://code.visualstudio.com/docs/remote/faq)
- [Visual Studio Code Server](https://code.visualstudio.com/docs/remote/vscode-server)

Relevant findings:

- WSL is treated as an isolated Linux execution context with its own tools and
  backend.
- Remote systems remain distinct authorities while a local client presents a
  unified experience.

Design implication: each WSL distro is an environment, not a project label or
terminal mode inside the Windows environment.

### JetBrains Gateway

Sources:

- [JetBrains Gateway](https://www.jetbrains.com/remote-development/gateway/)
- [Connect and work with JetBrains Gateway](https://www.jetbrains.com/help/idea/remote-development-a.html)

Relevant findings:

- Gateway connects through SSH, probes/configures the host, deploys a backend,
  and opens the remote project with execution kept remote.
- Backend install/stop/uninstall is an explicit lifecycle rather than an
  invisible local project mutation.

Design implication: BiBCode's SSH flow should probe, ask before provisioning,
install the exact target, and manage the server lifecycle separately from
project ownership.

## WSL And Windows Remote Access

### WSL Commands

Source: [Basic commands for WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)

Relevant findings:

- `wsl.exe --list --verbose` exposes installed distributions, running/stopped
  state, the default marker, and WSL version.
- `wsl --unregister` permanently removes a distribution and its data.

Design implication: preserve the verbose fields, auto-present running distros,
retain accepted stopped distros, and never expose/call unregister.

### Windows OpenSSH

Source: [Get started with OpenSSH for Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)

Relevant finding: current Windows client/server editions can expose an
OpenSSH-compatible encrypted remote-login service.

Design implication: the SSH provisioner needs a real Windows/PowerShell path;
POSIX-only commands are insufficient.

### Task Scheduler Logon Trigger

Source: [Starting an Executable When a User Logs On](https://learn.microsoft.com/en-us/windows/win32/taskschd/starting-an-executable-when-a-user-logs-on)

Relevant finding: a logon trigger can start an executable for a specific user.

Design implication: use a per-user logon task for default workstation mode;
reserve a Windows Service/dedicated account for explicit headless mode.

## macOS And Linux Services

### Apple Service Management

Sources:

- [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
- [Registering an SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice/register%28%29)
- [Updating an app package installer to use Service Management](https://developer.apple.com/documentation/ServiceManagement/updating-your-app-package-installer-to-use-the-new-service-management-api)
- [Managing ongoing background processes](https://developer.apple.com/documentation/appkit/managing-ongoing-background-processes-in-your-mac)

Relevant findings:

- LaunchAgents are per-user/login scoped; LaunchDaemons are system/boot scoped
  and require stronger administrator approval.
- Apple provides a package-installer pattern for registering services, and
  users can control background items.

Design implication: default to LaunchAgent workstation mode, expose service
approval/status, and make LaunchDaemon headless mode explicit.

### systemd User Services And Linger

Sources:

- [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)

Relevant finding: user services run under a user manager, while `enable-linger`
allows that manager to exist after logout/from boot and is an explicit policy
change.

Design implication: default to a systemd user service, explain logout behavior,
and never silently enable linger; use a dedicated system service/account for
headless mode.

## Pairing And Sender-Constrained Authentication

### OAuth Device Authorization

Source: [RFC 8628](https://www.rfc-editor.org/info/rfc8628/)

Relevant findings:

- Short-lived separate-device codes are appropriate where direct browser
  interaction is unavailable.
- TLS, user-initiated flow, expiry, and bounded polling/backoff are important.

Design implication: use a short, single-use local pairing flow, but keep it
self-hosted and initiated through the protected local/SSH control channel.

### DPoP

Source: [RFC 9449](https://www.rfc-editor.org/info/rfc9449/)

Relevant findings:

- DPoP binds access tokens to a client public key and requires a fresh signed
  proof for requests.
- DPoP is sender constraint, not authorization by itself.

Design implication: preserve BiBCode's DPoP/session scopes, bind the key during
pairing, retain replay defense, and do not treat possession as a permission
model.

### NIST Authentication Guidance

Source: [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)

Relevant findings: authenticated protected channels, freshness/nonces, replay
resistance, and verifier/channel binding reduce stolen/replayed credential risk.

Design implication: verify SSH/TLS and server identity before credential use;
use single-use pairing plus sender-constrained sessions rather than reusable URL
tokens.

## Secret Storage

### Windows DPAPI

Source: [CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

Relevant findings:

- Default protection is normally tied to the same user credentials and machine.
- Machine scope permits other users on the machine to decrypt and is not the
  desired client-secret posture.
- DPAPI includes integrity protection.

Design implication: use user-scoped DPAPI and fail closed on unavailable or
integrity-failed secrets.

### Apple Keychain

Sources:

- [Keychain services](https://developer.apple.com/documentation/security/keychain-services)
- [Storing keys in the Keychain](https://developer.apple.com/documentation/security/storing-keys-in-the-keychain)

Relevant finding: Keychain is the platform API for small secrets such as
passwords and cryptographic keys.

Design implication: keep client credentials, DPoP private material, and cache
keys out of IndexedDB/plain files on macOS.

### Linux Secret Service

Source: [Secret Service API](https://specifications.freedesktop.org/secret-service/latest/)

Relevant finding: Secret Service provides collections/items, lookup attributes,
sessions, locking/unlocking, and prompting through a desktop service.

Design implication: use it when available and treat locked/missing service as a
session-only condition rather than falling back to plaintext.

## SQLite Integrity And Concurrency

Sources:

- [Partial indexes](https://www.sqlite.org/partialindex.html)
- [Foreign key support](https://www.sqlite.org/foreignkeys.html)
- [Write-ahead logging](https://www.sqlite.org/wal.html)
- [Transactions](https://www.sqlite.org/lang_transaction.html)

Relevant findings:

- A unique partial index can enforce one special active row per group.
- Foreign-key enforcement must be explicitly enabled per connection and indexed
  appropriately.
- WAL/transactions improve concurrent access but do not replace application
  command/idempotency/locking invariants.

Design implication: add a unique active-Main invariant and a transactional
repository claim, while retaining current orchestration lock/idempotency rules.
Do not retrofit redundant environment columns into an already environment-local
database.

## Accessible Hierarchical Navigation

Source: [WAI-ARIA Tree View Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)

Relevant findings:

- A tree is appropriate for hierarchical expandable navigation when it
  implements the required roles, expanded/selected states, keyboard movement,
  focus distinction, and type-ahead.
- Virtualized/incomplete DOM trees need explicit level/set/position metadata.

Design implication: implement the environment/project/thread panel as a tested
single-select tree, not merely visually indented clickable divs.

## Packaging, Signing, And Supply Chain

### Tauri Distribution

Sources:

- [Tauri distribution](https://v2.tauri.app/distribute/)
- [Tauri GitHub pipelines](https://v2.tauri.app/distribute/pipelines/github/)
- [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/)
- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri updater](https://v2.tauri.app/plugin/updater/)

Relevant findings:

- Tauri's existing desktop pipeline supports native platform bundles and
  updater artifacts, with distinct platform-signing concerns.
- Tauri documents ad-hoc macOS identity `-` as a credential-free option, while
  Developer ID/notarization is a separate stronger distribution path.
- Windows signing and updater signing have their own workflows.

Design implication: extend and preserve the working desktop/release pipeline;
keep macOS Developer ID/notarization optional as approved, and do not confuse it
with required updater integrity.

### Native Server Packaging Toolchain

Sources:

- [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [WiX command-line reference](https://docs.firegiant.com/wix/tools/wixexe/)
- [Using WiX with the SDK and command line](https://docs.firegiant.com/wix/using-wix/)
- [Microsoft SignTool reference](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- [Apple: Packaging Mac software for distribution](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
- [Apple: Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
- [Apple Distribution Definition XML reference](https://developer.apple.com/library/archive/documentation/DeveloperTools/Reference/DistributionDefinitionRef/Chapters/Distribution_XML_Ref.html)
- [`cargo-deb` project documentation](https://github.com/kornelski/cargo-deb)
- [`cargo-generate-rpm` project documentation](https://github.com/cat-in-136/cargo-generate-rpm)

Relevant findings verified on 2026-08-24:

- GitHub documents native `ubuntu-22.04-arm` and `windows-11-arm` labels in
  addition to the repository's existing x64/macOS runners. ARM support must
  still be treated as native evidence only when those jobs execute, not merely
  because the labels exist.
- The current WiX SDK example is `WixToolset.Sdk/7.0.0`; the WiX CLI accepts
  explicit x64 and ARM64 package architectures and provides MSI validation.
- Current SignTool requires explicit file and timestamp digest algorithms; use
  SHA-256 and verify both the contained executable and final MSI.
- `pkgbuild`/`productbuild` create native macOS installer packages and make
  package signing conditional on an available identity. This supports the
  approved unsigned/ad-hoc baseline plus an additive Developer ID path.
- `cargo-deb` and `cargo-generate-rpm` both model explicit assets and package
  script hooks. The plan must inspect generated contents/scripts and must not
  let either tool infer data deletion or service policy.

Design implication: use pinned native tools on matching runners, keep package
policy in repository-owned templates/tests, and block stable ARM publication
without native execution. Do not replace the working Tauri desktop pipeline.

### CycloneDX From The Locked Workspace

Sources:

- [pnpm 11 built-in SBOM command](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md)
- [pnpm CycloneDX version selection](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.1.md)
- [CycloneDX Rust/Cargo project](https://github.com/CycloneDX/cyclonedx-rust-cargo)
- [CycloneDX CLI project](https://github.com/CycloneDX/cyclonedx-cli)
- [Reviewed CycloneDX NPM command-injection advisory](https://github.com/advisories/GHSA-v75r-vx73-82pj)

Relevant findings:

- The repository-pinned pnpm 11 line has a built-in command that emits
  CycloneDX 1.7 or SPDX 2.3 from the pnpm workspace. It is a better source for
  the compiled web dependency closure than introducing an npm-specific lockfile
  or resolver.
- `cargo-cyclonedx` emits the Rust dependency BOM and CycloneDX CLI can merge
  and validate BOMs across platforms.
- `@cyclonedx/cyclonedx-npm` versions before 5.0.0 had a reviewed shell
  injection issue in workspace handling. The implementation plan therefore
  uses the repository-pinned pnpm command and still passes only constant,
  repository-owned filter values to subprocesses.

Design implication: generate Rust and exact production-web BOMs from the locked
workspace, merge them with the staged file inventory, sign the final SBOM, and
test that unrelated workspace development packages do not leak into the server
product inventory.

### GitHub Artifact Attestations

Source: [Using artifact attestations to establish build provenance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

Relevant finding: GitHub Actions can attest binary provenance and associate an
SBOM, subject to repository/plan permissions.

Design implication: publish checksums/signatures/SBOM for every artifact and add
provenance attestations where supported, recording availability in the artifact
manifest rather than silently omitting it.

### cargo-dist Evaluation

Source: [cargo-dist documentation](https://opensource.axo.dev/cargo-dist/)

Design implication: cargo-dist may help build Rust archives/installers, but it
is not selected by this specification. Adoption requires proving compatibility
with the current web embedding, desktop updater, artifact discovery/naming,
native service actions, optional macOS signing, and release verification.

## Research Conclusions

The common successful pattern is a lightweight local client with a backend that
runs beside the source/runtime in each environment. SSH is a robust bootstrap
and default remote transport; OS-native service managers and secret stores
should own lifecycle and credentials. Stable server identity must be separate
from route/host presentation. Database constraints should reinforce, not
replace, transactional domain authority. Accessible hierarchy and explicit
destructive consequences are part of architecture because they prevent users
from acting on the wrong environment.
