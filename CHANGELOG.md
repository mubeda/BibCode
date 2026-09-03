# Changelog

## [v0.5.0] - 2026-09-02

BiBCode v0.5.0 adds first-class remote environments, a complete project-level
Git Manager, and a dedicated Agents view. It also expands native desktop and
standalone-server releases to six OS/architecture targets and hardens the
connection, process, packaging, and test boundaries exercised by those
features.

### Remote servers and secure connectivity

- Added **Remote Servers** settings, pairing-code and `bibcode://` deep-link
  flows, manual and SSH-assisted connection setup, saved-server lifecycle
  controls, compatibility/version status, remote update actions, and an
  environment rail that scopes projects and actions to the selected machine.
- Added authenticated Noise NK transport with bounded record fragmentation,
  no-downgrade credentials, pinned host identity, transport-scoped sessions,
  and explicit protocol-compatibility negotiation for off-host connections.
- Added grant-derived sharing state and verified exposure transitions. Windows
  remote access uses a program-scoped firewall rule and rolls back firewall,
  listener, and persisted state when widening or narrowing cannot complete.
- Hardened pairing and session authority across cancellation, reconnects,
  concurrent server processes, stale delivery, duplicate requests, revocation,
  forwarded loopback peers, and bounded per-principal byte/message capacity.
  Remote failures remain typed and retryable without silently substituting a
  local or WSL backend.
- Added remote server update discovery and installation through the existing
  desktop-owned updater boundary, including status badges and bounded
  multi-server checks.

### Project-level Git Manager

- Added a GitHub Desktop-shaped centre panel for each project, covering working
  tree and staged changes, per-line and per-hunk selection, commit/amend/undo,
  safe discard, paged history and diffs, branches, tags, fetch/pull/push,
  publication and force-with-lease, stashes, merge previews, rebase,
  cherry-pick, squash, reorder, revert, reset, conflict recovery, and image
  diffs.
- Added an on-demand pull-request and checks pane with GitHub, GitLab, and Azure
  provider resolution. Pull-request creation now opens a non-mutating review
  dialog and only publishes the branch and creates the PR after final
  confirmation; retries reuse an existing pull request.
- Kept Git Manager activity server-owned, bounded, non-interactive, and free of
  background telemetry. Repository generations fence stale reads, concurrent
  mutations share one owner, capabilities degrade independently, and remote
  environments retain the same typed RPC boundary.
- Improved the final packaged behavior found during macOS and Windows native
  validation: clean checkouts select **History**, dirty/loading selections are
  preserved, merge recovery stays on **Changes**, history rejects stale pages,
  symbolic remote `*/HEAD` pointers are not shown as branches, and a temporarily
  missing upstream tracking ref no longer makes the manager unavailable.
- Redesigned the pull-request review dialog for readable repository/base/head
  metadata, clear branch-publication guidance, stable padding, and a fixed
  action footer.

### Agents view and interface polish

- Added a full-height **Agents** view with environment/project/status grouping,
  filtering, unread state, provider identity, branch and conversation previews,
  live detail, and capped server-pushed shell summaries.
- Raised the sidebar and navigation text floor, increased the default sidebar
  width with double-click reset, and improved Linux WebKitGTK font hinting and
  subpixel rendering without changing other applications' GTK settings.
- Added a shared orange panel-separator token and aligned the environment rail,
  sidebar, content headers, Git Manager, diff/file/preview panels, terminal,
  status bar, and top frame in both themes.
- Corrected route, capability, stale-status, dialog, and layout edge cases found
  during packaged macOS, Linux, and Windows interaction testing.

### Native releases and standalone server packages

- Expanded the release matrix to macOS, Linux, and Windows on both ARM64 and
  x64. Desktop downloads now include two DMGs, two AppImages, and two NSIS
  installers; the signed updater manifest contains all six matching targets.
- Added standalone `bibcode` server archives for all six targets plus native
  ARM64/x64 Debian and RPM packages, install-and-run container tests, a sorted
  SHA-256 manifest, and optional minisign signatures.
- Hardened Windows ARM64 and x64 builds with architecture-aware MSVC setup,
  drive-safe portable ZIP creation, checkout-local Vite+ execution, cached NSIS
  tooling, explicit sidecar execution manifests, bind-only port probes that do
  not trigger firewall prompts, and targeted cleanup for test-generated rules.
- Hardened Linux packaging around an Ubuntu 20.04 server compatibility build,
  native package smoke matrices, AppImage portability, minimal RPM curl
  dependencies, and ownership restoration after container builds.
- Hardened macOS/Linux startup PATH hydration so login-shell probes detach from
  inherited controlling terminals, accept a complete framed result without
  waiting for lingering descendants, and reap their process group before
  desktop startup continues.

### Data, compatibility, and validation

- Database migrations 46–49 add pairing reach metadata, a durable pairing-offer
  idempotency ledger, shared authentication-authority revision state, and active
  pairing-delivery state. Existing stores continue through the verified
  pre-migration backup path.
- Remote transport, Git Manager, Agents-view, provider-check, and update
  contracts are additive; no intentional breaking API change is documented.
- Expanded native CI, release-candidate validation, packaged desktop UI and
  upgrade smoke tests, remote Docker validation, source-control fixtures, and
  cross-platform runbooks. The macOS Git Manager flow was exercised against a
  real private GitHub repository through branch, diff, staging, commit, history,
  push, pull-request, checks, tag, fetch, and checkout behavior.
- Stabilized release gates by target-gating macOS-only test imports, giving
  uncached Rust workspace jobs an explicit workflow budget, and replacing a
  scheduler-sensitive Git broadcaster teardown timer with canonical lifecycle
  retirement. Windows forced-shutdown coverage now exercises the production
  timeout instead of a scheduler-sensitive 250 ms fixture window, and
  cross-process auth revocation coverage distinguishes queued prior revisions
  from the forbidden post-revocation event.
- Removed an accidental literal NUL from tracked TypeScript source and added a
  repository-wide guard so text-source corruption fails tests immediately.

### Supported downloads and trust

- macOS 11+ Apple Silicon (`arm64`) DMG
- macOS 11+ Intel (`x64`) DMG
- Linux ARM64 AppImage
- Linux x64 AppImage
- Windows 11 ARM64 NSIS installer
- Windows 10/11 x64 NSIS installer
- Standalone server archives for all six targets, plus Linux ARM64/x64 `.deb`
  and `.rpm` packages and `bibcode-server-SHA256SUMS`

macOS builds remain ad-hoc signed and unnotarized, and Windows installers remain
without Authenticode. Tauri updater payloads are independently signed and
verified by BiBCode before publication.

**Full changelog:** [v0.4.2...v0.5.0](https://github.com/mubeda/BibCode/compare/v0.4.2...v0.5.0)

## [v0.4.2] - 2026-08-25

BiBCode v0.4.2 makes desktop updates easier to understand and recover from,
while keeping Codex and Claude terminal interfaces readable across app-theme
changes.

### Safer, observable desktop updates

- Added live update-protection progress for every local backend, including the
  current protection stage, elapsed time, and active mutation count while
  BiBCode drains work, quiesces the runtime, checkpoints SQLite, creates a
  verified backup, and stops the backend.
- Classified RPC methods through the typed contract inventory so long-lived
  read subscriptions do not block an update, while unknown methods still fail
  closed as mutations.
- Kept verified backup protection as the default and the primary retry path.
  Installing without a backup is available only after a real protection
  attempt fails and the user explicitly acknowledges the risk; the native host
  rejects forged first-attempt bypasses.
- Preserved exact backend-topology safety for the acknowledged fallback: the
  desktop host still snapshots and stops the running native and WSL backends,
  restarts that same set if installation fails, and reports each environment
  as skipped instead of protected.
- Improved the protection-failure dialog so retry, exact secondary exclusions,
  and the destructive no-backup action remain distinct and correctly laid out.

### Terminal and agent compatibility

- Kept each Codex terminal on its launch palette until an explicit restart, so
  changing the BiBCode app theme cannot make Codex composer text disappear or
  leave the terminal half-repainted on macOS, Linux, or Windows.
- Applied the resolved terminal palette when opening agent and script
  terminals, including the OSC foreground, background, cursor, and Windows
  console markers that terminal applications snapshot at spawn.
- Prevented a light in-band color-scheme reply from selecting Claude Code's
  broken fullscreen light path inside the embedded xterm host, while retaining
  dark-scheme and OSC color support.
- Removed inherited `NO_COLOR`/disabled-color host settings from PTY launches
  unless the launch explicitly opts out, and advertised true-color support so
  agent TUIs do not silently lose their ANSI colors.
- Changed the device-local terminal-theme default to **Follow app theme**;
  **Always dark** remains available for users who prefer a fixed terminal
  palette.

### Release reliability

- Prevented the chat surface from reading an unavailable nested platform value
  while server configuration is still partial, so opening a local draft cannot
  fail during configuration bootstrap.
- Made the startup activity-recovery test use a current fixture timestamp so it
  continues to exercise unresolved-versus-completed recovery after the
  production 30-day completed-activity retention window advances.

### Compatibility and downloads

- No database migration or intentional breaking API change is included. New
  updater progress and skipped-protection fields are additive and decode with
  safe defaults.
- The release pipeline provides macOS 11+ Apple Silicon and Intel DMGs, a Linux
  x64 AppImage, and a Windows 10/11 x64 NSIS installer, plus signed updater
  payloads and the four-platform `latest.json` manifest.
- macOS builds remain ad-hoc signed and unnotarized; Windows installers remain
  without Authenticode. Tauri updater payloads are independently signed and
  verified by BiBCode.

**Full changelog:** [v0.4.1...v0.4.2](https://github.com/mubeda/BibCode/compare/v0.4.1...v0.4.2)

## [v0.4.1] - 2026-08-24

BiBCode v0.4.1 is a reliability release for Git/worktree coordination, the
Files surface, provider error reporting, and embedded terminals. It replaces
poll-heavy or ambiguous state with lifecycle-owned observation, keeps UI state
honest across races and failures, and restores the intended Create Worktree
flow.

### Source control and worktrees

- Replaced per-project branch polling with server-owned, event-driven VCS
  observation. Native worktree and Git-metadata watches coalesce bursts, retain
  one trailing read, and use a bounded 60–300 second safety read when native
  observation is unavailable or misses an event.
- Added shared local/full status-read owners with cancellation leases, mutation
  epochs, publication fences, deterministic shutdown, and clean reattachment.
  A slow remote fetch, provider lookup, or cancelled caller can no longer delay
  or publish over newer local state.
- Added one automatic-fetch owner per physical repository. Linked worktrees
  share the default 180-second fetch, exact remotes are fetched once, failures
  use bounded backoff, and `0` still disables automatic fetch.
- Added lightweight passive VCS summaries for sidebar state. Fresh local and
  provider data publishes independently from pull-request enrichment; a prior
  matching PR may be retained for only one stale cycle, and provider failures
  no longer make the repository appear clean or unavailable.
- Reduced Git work by using one porcelain-v2 status snapshot, running numstat
  only for areas that exist, and setting `GIT_OPTIONAL_LOCKS=0` on background
  reads. Added native measurement tooling for Git-process rate and foreground
  mutation queue latency.
- Added bounded, no-follow repository fingerprints so healthy Focus refreshes
  can reuse trusted worktree inventory between mandatory five-minute Git
  reconciliations. Unknown, changed, malformed, replaced, or over-limit inputs
  fail open to a real inventory scan.
- Hardened create, publish, retarget, detach, remove, file-write, and stacked Git
  mutations so their status/catalog invalidation settles after the actual
  filesystem, Git, and durable ownership result—even when the requester
  disconnects, cancellation races, or a panic occurs.
- Reworked Create Worktree around one permanent Name editor plus optional
  Smart/GitHub/Branch sources. Exact local and remote refs no longer appear as a
  duplicate result, free local branches enable **Reuse branch** by default, and
  edited names remain stable.
- If a selected remote branch becomes local before submission, the server now
  reuses that free local branch. A branch already checked out by another
  worktree retains the safe suffixed-branch fallback, including concurrent
  creation races.
- Added strict Bitbucket request/body bounds and exact selected-remote handling
  when publishing repositories, including protection against option-shaped
  remote names.

### Files surface

- Added a server-authoritative workspace entry stream and immediate **Refresh**
  action. External file/folder creates, renames, and removals rescan without
  collapsing expanded folders; watcher startup now closes the initial-snapshot
  race with an explicit resync.
- Rebuilt the cached file index from concurrent tracked/ignored Git listings
  plus bounded directory walks. Ignored trees and empty directories remain
  visible, cold callers share one build, and ordinary warm reads start no Git
  work.
- Added explicit cache invalidation for create, rename, delete, duplicate, new
  parent paths, `.gitignore`, and `.git` classification controls while keeping
  ordinary existing-file content saves inexpensive.
- Added drag-and-drop moves to folders or the workspace root, correct new-entry
  parent selection, open-tab path updates after rename/move, and close-on-delete
  behavior.
- Failed, cancelled, or availability-raced moves and mutations now roll the
  optimistic tree back to server truth instead of leaving duplicated or stale
  rows. Refresh failures preserve the existing tree and remain retryable.
- Kept every directory as its own row rather than merging single-child folder
  chains, so actions and paths always target the directory the user sees.

### Providers, delivery, and runtime lifecycle

- Added compatible runtime error classes beside provider messages. The UI can
  now distinguish a provider-reported failure from a BiBCode transport,
  permission, or validation failure without guessing who is at fault.
- Preserved provider-native failure details and terminal reasons for Claude,
  Codex, Cursor, Grok, and OpenCode. Fixed healthy Codex turns with `error: null`
  being reported as failures and mapped documented refusal, output-limit, and
  content-filter outcomes truthfully.
- Made refused or uncertain delivery visible in the sidebar and thread status,
  derived atomically from the durable outbox. Retry, dismissal, or successful
  delivery clears it without overwriting provider-session identity or state.
- Hardened OpenCode event-stream handling so connection failures, HTTP errors,
  clean EOF, chunk failures, and explicit stop all publish their terminal state
  and close the provider stream. Supervisors no longer wait forever on a sender
  retained by a completed runtime.
- Tightened process, logging, provider, VCS, watcher, workspace, and catalog
  ownership across shutdown and reattachment so cancellation-ignoring work is
  still awaited and cannot publish into a replacement lifecycle.

### Terminal and interface fixes

- Added a device-local Terminal theme setting: **Always dark** by default,
  **Always light**, or **Follow app theme**. Terminal OSC colors and xterm's
  extended grayscale palette now match that choice, avoiding dark TUI panels on
  an otherwise light terminal.
- Fixed resize bursts that could strand Codex or another full-screen TUI at an
  intermediate PTY size. Every requested resize is retained and the worker
  coalesces only to the newest dimensions.
- Fixed center-panel separators disappearing against adjacent surfaces.
- Prevented stale sidebar and thread-status updates from overwriting newer
  unresolved-delivery, worktree, provider, or availability state.

### Data, compatibility, and documentation

- Database migrations 44–45 add provider error attribution and unresolved
  delivery projection fields. Existing stores upgrade through the normal
  verified pre-migration backup path.
- Contract additions are additive and older error-class values decode safely as
  unknown. No intentional breaking API change is documented.
- Expanded living architecture, source-control, workspace, observability, and
  cross-platform validation documentation. Added implementation plans and
  reference screenshots for the future full Git Manager UI; those planning
  documents do not claim that the complete planned Git Manager interface ships
  in v0.4.1.

### Validation and supported downloads

- `vp check`, all 11 `vp run typecheck` targets, 8,266 Vite+ tests, release
  smoke, Rust formatting, workspace Clippy with warnings denied, the full Rust
  workspace test suite, and the production desktop build passed with Rust
  1.97.1.
- Packaged macOS interaction was visually verified with Codex Computer Use,
  including the single-editor Create Worktree dialog and the checked/unchecked
  **Reuse branch** behavior.
- The release pipeline builds and verifies macOS 11+ Apple Silicon and Intel
  DMGs, a Linux x64 AppImage, and a Windows 10/11 x64 NSIS installer, together
  with signed updater payloads and the four-platform `latest.json` manifest.
- macOS builds remain ad-hoc signed and unnotarized; Windows installers remain
  without Authenticode. Tauri updater payloads are independently signed and
  verified by BiBCode.

### Known limitations

- External Files changes are detected within seconds rather than instantly;
  use **Refresh** for an immediate rescan. An arbitrary custom Git
  `core.excludesFile` also requires manual Refresh after it changes.
- The complete Git Manager interface described in the new implementation plans
  is future work; this release ships its VCS coordination, summaries,
  measurement, and reliability foundations.

**Full changelog:** [v0.4.0...v0.4.1](https://github.com/mubeda/BibCode/compare/v0.4.0...v0.4.1)

## [v0.4.0] - 2026-08-17

### Highlights

- Added an authoritative worktree catalog that discovers existing Git worktrees, lets users adopt one or all discovered checkouts without recreating them, and preserves physical identity across path aliases and reconnects.
- Added explicit recovery and removal flows for missing or present worktrees, including fresh server-side plans, dirty/stale-registration confirmations, durable retry receipts, and identity-safe cleanup on Windows, macOS, and Linux.
- Improved local desktop presentation: macOS and Linux now focus on the local environment, Windows keeps truthful WSL location and recovery controls, Cursor is enabled as a supported provider, and legacy Grok actions are hidden.
- Improved Activity timestamps and hierarchy while bounding Claude fallback ambiguity so stale or unrelated processes are not presented as controllable activity.
- Hardened provider, terminal, logging, persistence, update, and shutdown ownership under parallel load, including bounded OpenCode reaping, isolated native fixtures, and per-runtime process cleanup that preserves sibling desktop runtimes.
- Hardened Linux packaging and expanded repeatable native validation across macOS arm64/x64, Linux x64, and Windows x64.

### Data and compatibility

- Database migrations 40–43 add per-project worktree discovery state, repository identity pins, and durable worktree-removal receipts. Existing stores are migrated through the normal verified pre-migration backup path.
- No intentional breaking API change is documented. Older servers that do not advertise worktree-catalog support continue without the new catalog controls.
- macOS artifacts remain ad-hoc signed and unnotarized; Windows installers remain unsigned.

### Known issues

- Native Windows, Linux, and both macOS architectures require their respective release runners for final installer and updater verification.

**Full changelog:** [v0.3.13...v0.4.0](https://github.com/mubeda/BibCode/compare/v0.3.13...v0.4.0)

[v0.4.0]: https://github.com/mubeda/BibCode/releases/tag/v0.4.0
[v0.4.1]: https://github.com/mubeda/BibCode/releases/tag/v0.4.1
[v0.4.2]: https://github.com/mubeda/BibCode/releases/tag/v0.4.2
[v0.5.0]: https://github.com/mubeda/BibCode/releases/tag/v0.5.0
