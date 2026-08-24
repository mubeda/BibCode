# Changelog

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
