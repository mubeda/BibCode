# Source-Aware Provider Updates Design

## Context

BiBCode checks provider versions at startup, every hour, and after a manual
provider refresh. The Rust maintenance backend currently chooses the installed
version from the resolved provider executable, but it does not apply the same
standard to the latest-version source or update command. Codex, Claude, and
OpenCode always use an npm latest-version lookup, while a small set of path
patterns selects the update command. If no pattern matches and the configured
binary is a bare command such as `codex` or `claude`, the resolver assumes npm
even when that command resolved to a standalone binary, WinGet package, system
package, or custom wrapper.

The original T3 Code implementation has the useful shape of provider-owned
maintenance definitions feeding a shared resolver and command runner. It also
contains the same unsafe bare-command fallback, npm-only latest-version model,
and unverifiable Cursor update behavior. It is historical design evidence, not
a correct implementation to port unchanged.

The observed failures are:

- Codex standalone installations and custom wrappers are mapped to npm.
- Claude WinGet, Linux system-package, and custom installations are mapped to
  npm.
- the Claude Homebrew `claude-code@latest` cask is mapped to the stable cask;
- every Claude installation is compared with the npm latest release even when
  its native or Homebrew configuration follows the stable channel;
- Cursor has a native update command but no latest-version source, so it never
  becomes an update candidate; and
- a successful Cursor update command is reported as unverifiable because
  post-update verification requires a semantic-version advisory to become
  current.

The earlier provider refresh reliability design remains authoritative for
manual cache invalidation, retryable lookup failures, visible failure states,
and npm `/latest` response handling. This design extends that work; it does not
reverse those guarantees.

## Goals

- Select latest-version checks and update actions from the installation that
  owns the resolved provider executable.
- Fix OpenCode, Codex, Claude, and Cursor update detection on supported Windows,
  macOS, Linux, and WSL installations.
- Preserve safe one-click updates for recognized unprivileged installers.
- Show a copyable manual command for recognized privileged Linux package
  managers without executing it.
- Respect Claude stable and latest release channels when they can be determined
  from the installation or provider settings.
- Detect Cursor releases without executing a downloaded installer script.
- Verify a completed update from the refreshed installed version and the same
  latest-version source used before the update.
- Fail closed for custom wrappers and unrecognized paths.

## Non-goals

- Automatically installing provider updates on a timer.
- Running `sudo`, prompting for elevation, or executing `apt`, `dnf`, or `apk`
  from BiBCode.
- Updating arbitrary custom wrappers or provider-compatible third-party CLIs.
- Adding a production Node.js runtime or moving provider maintenance into the
  Tauri desktop host.
- Changing provider settings, persisted data, RPC method names, or public RPC
  payload shapes.
- Guaranteeing that a newly published provider release has already propagated
  to every package-manager mirror. Provider documentation acknowledges that
  package-manager availability can lag the provider release channel.

## Ownership and Boundaries

`apps/server` remains the source of truth for provider maintenance. The server
owns the provider environment, executable resolution, filesystem view, network
checks, update process, cache, coordination locks, and post-update inventory
refresh. This preserves browser, desktop, WSL, SSH, and relay behavior because
the operation runs in the environment that owns the provider rather than on the
client or desktop host.

Provider-specific policy is expressed as declarative maintenance definitions
inside the provider-maintenance module. Shared logic owns path normalization,
source classification helpers, bounded HTTP fetching, caching, comparison,
command execution, and verification. The contracts package remains schema-only
and does not gain runtime policy.

No public contract change is required. The existing advisory fields can express
both safe and manual actions:

- `updateCommand` is the command shown to the user, whether automatic or
  manual;
- `canUpdate: true` means the server owns an allowlisted executable action; and
- `canUpdate: false` means BiBCode may show and copy the command but must not
  execute it.

## Internal Maintenance Model

Replace the current `package_name + optional update` capability with an
internal source-aware result containing:

- an explicit installation source;
- an optional latest-version source;
- a version comparison strategy;
- an optional displayed command; and
- an optional executable update action with its coordination lock.

The latest-version source is a closed internal enum rather than an arbitrary
URL. Its initial variants are:

- npm package `/latest` JSON;
- an allowlisted plain-text release-channel endpoint; and
- the allowlisted Cursor installer document with a dedicated parser.

Cache and single-flight keys use the complete latest-version source identity,
including a Claude channel, rather than only an npm package name. Thus Claude
stable and latest lookups cannot share a cached value. Successful results retain
the one-hour TTL. Failures remain uncached. Manual refresh continues to advance
the generation for every source.

The version comparison strategy is either semantic versioning or a Cursor
release identifier. Cursor versions have a `YYYY.MM.DD-build` form whose
zero-padded date components are invalid strict semantic versions. Cursor
comparison parses the numeric date tuple. Exact identifiers are current; an
older date is behind; a newer date is current; and different build identifiers
on the same date are unknown because the suffix has no documented ordering.

## Source Classification

Classification uses the configured binary, resolved executable, and canonical
target. Paths are normalized for slash direction and case before matching.
Resolved and canonical paths are authoritative over a bare configured command.

The resolver applies these rules in order:

1. provider-specific native or OS package sources;
2. Vite+, Bun, pnpm, and npm global package locations;
3. exact Homebrew Cellar or Caskroom identities; and
4. recognized system-package paths with matching package repository markers.

If a resolved path exists but no rule matches, the result is custom/unknown. It
has no latest-version source and no update command. A bare configured command
never falls back to npm after resolving to an unknown location. If command
resolution itself fails, the provider inventory remains authoritative for its
installed/uninstalled state and maintenance exposes no action.

Generic `/opt/homebrew/bin`, `/usr/local/bin`, or `/usr/bin` prefixes are not
enough to select a package manager. Canonical targets must identify the owning
Cellar, Caskroom, package tree, or provider-native release tree. This prevents a
custom symlink from mutating an unrelated global package installation.

## Provider Matrix

### OpenCode

| Installation | Latest-version source | Displayed command | One-click |
| --- | --- | --- | --- |
| native `~/.opencode/bin` | npm `opencode-ai` latest | resolved `opencode upgrade` | yes |
| npm | npm `opencode-ai` latest | `npm install -g opencode-ai@latest` | yes |
| pnpm | npm `opencode-ai` latest | `pnpm add -g opencode-ai@latest` | yes |
| Bun | npm `opencode-ai` latest | `bun i -g opencode-ai@latest` | yes |
| Vite+ | npm `opencode-ai` latest | `vp i -g opencode-ai` | yes |
| Homebrew tap | npm `opencode-ai` latest | `brew upgrade anomalyco/tap/opencode` | yes |
| unknown/custom | none | none | no |

The Windows npm locations already used by OpenCode, including AppData npm
shims and canonical `node_modules` targets, remain covered.

### Codex

| Installation | Latest-version source | Displayed command | One-click |
| --- | --- | --- | --- |
| standalone release tree | npm `@openai/codex` latest | resolved `codex update` | yes |
| npm/pnpm/Bun/Vite+ | npm `@openai/codex` latest | owning package-manager command | yes |
| Homebrew cask | npm `@openai/codex` latest | `brew upgrade --cask codex` | yes |
| unknown/custom | none | none | no |

Standalone detection includes the canonical Codex packages tree and the
official user-local launch paths on Unix and Windows. The update action invokes
the resolved provider executable, not an ambient `codex`, so multiple provider
environments cannot update the wrong installation.

### Claude

| Installation | Channel/version source | Displayed command | One-click |
| --- | --- | --- | --- |
| native | effective `stable` or `latest` plain-text endpoint | resolved `claude update` | yes |
| npm/pnpm/Bun/Vite+ | npm latest | owning package-manager command | yes |
| Homebrew `claude-code` | stable endpoint | `brew upgrade --cask claude-code` | yes |
| Homebrew `claude-code@latest` | latest endpoint | `brew upgrade --cask claude-code@latest` | yes |
| WinGet | latest endpoint | `winget upgrade Anthropic.ClaudeCode` | yes |
| apt stable/latest repository | matching channel endpoint | `sudo apt update && sudo apt upgrade claude-code` | no |
| dnf stable/latest repository | matching channel endpoint | `sudo dnf upgrade claude-code` | no |
| apk stable/latest repository | matching channel endpoint | `apk update && apk upgrade claude-code` | no |
| unknown/custom | none | none | no |

Native Claude defaults to the latest channel. The resolver reads
`autoUpdatesChannel` from the provider-specific configuration directory
(`CLAUDE_CONFIG_DIR`, otherwise the configured `HOME`/`USERPROFILE`) and
supported file-based managed settings, applying managed-over-user precedence.
Only the values `stable` and `latest` are accepted. Malformed or unreadable
settings do not fail provider inventory; they fall back to the documented
default unless a recognized managed settings file contains an invalid channel,
in which case the advisory becomes unknown rather than claiming latest.

If the provider environment or locally visible effective settings set
`DISABLE_UPDATES`, native Claude retains its version advisory but exposes no
one-click action. `DISABLE_AUTOUPDATER` does not remove the manual
`claude update` action because Claude documents it as disabling only background
updates.

Homebrew channel selection comes from the canonical Caskroom identity, not the
symlink name. Linux package channel selection comes from Anthropic repository
markers in the standard apt, dnf, or apk configuration files. A `/usr/bin`
binary without a matching repository marker is unknown/custom and does not get
an npm action.

OS-managed Claude policies that are not available through the provider
filesystem, including server-delivered enterprise settings, cannot be
authoritatively inspected. If such a policy overrides the locally visible
channel, BiBCode may show the documented default channel until the provider
exposes a non-interactive effective-settings API. This residual limitation is
documented rather than addressed with an interactive or mutating CLI probe.

### Cursor

| Installation | Latest-version source | Displayed command | One-click |
| --- | --- | --- | --- |
| official native release tree | parsed `https://cursor.com/install` | resolved `cursor-agent update` | yes |
| unknown/custom | none | none | no |

The server downloads the installer as bounded text and parses the release
identifier embedded in its official download and final-directory constants. It
never pipes, launches, or evaluates the script. The parser requires consistent
identifiers when the document contains both values; disagreement or an
unexpected document produces a visible failed-check advisory and remains
uncached.

Cursor is officially installed on macOS, Linux, and Windows through WSL. Native
Windows custom paths are not inferred as official Cursor installations without
an official path signature.

## Advisory and UI Behavior

Only a recognized installation with a latest-version source performs a network
check. The advisory remains `unknown` without a message when checks are disabled
or the installation source is intentionally unsupported. A network or parsing
failure for a recognized source uses the existing visible failed-check message.

A provider becomes an update candidate only when the source-specific comparison
returns `behind_latest`. Settings shows the exact source-specific command. The
primary and environment update notifications offer one-click execution only
when `canUpdate` is true. Manual Linux package commands remain copyable from
provider settings and never enter the server update runner.

The current RPC schema and dismissal key shape remain unchanged. A latest
version or source change naturally produces a new notification key through the
existing version-based logic.

## Update Execution and Verification

All executable actions remain closed, argument-vector commands. No fetched
content, shell interpolation, or displayed manual command is executable by the
server. Existing per-instance reservations, package-manager locks, cancellation,
five-minute timeout, bounded output, and publication fencing remain in force.

Before execution, the control layer retains the installed provider version.
After a zero exit it refreshes only the target instance, forces a fresh lookup
generation, and evaluates the refreshed snapshot:

- `succeeded` when the source-specific advisory is current;
- `succeeded` when the installed version advanced according to the provider's
  comparison strategy and the latest-version lookup is temporarily unavailable;
- `unchanged` when the provider remains behind;
- `unchanged` when the installed version did not change and correctness cannot
  otherwise be verified; and
- `failed` for spawn, cancellation, timeout, or non-zero exit.

The version-advance fallback never turns a command failure into success, does
not accept a downgrade, and does not claim that an unchanged or ambiguously
ordered executable updated. It specifically removes the current Cursor
false-negative while keeping verification truthful during a transient metadata
outage.

## Network, Filesystem, and Security Constraints

- Latest-version URLs and response parsers are compile-time allowlisted.
- HTTP requests retain a four-second timeout and add bounded response bodies.
- Installer scripts are parsed as data and never executed.
- Provider environment variables determine command resolution and the provider
  home, but secret values are never logged or returned.
- Settings and repository marker reads are bounded, read-only, and limited to
  documented provider or system configuration files.
- Privileged Linux commands are display-only.
- Unknown paths expose neither a guessed latest source nor a guessed updater.

## Failure and Concurrency Semantics

Source classification is recomputed for each full provider probe so changing a
configured binary cannot retain stale capabilities. Latest-version lookups for
the same source and generation remain single-flight; different sources remain
concurrent. Successful results are cached for one hour, while transport,
status, decoding, validation, and installer-parser failures retry on the next
probe and always retry after manual refresh.

An advisory failure never changes installation, authentication, readiness,
models, commands, skills, or agents. Concurrent refresh publication continues
to use settings generations and provider probe sequences, and update lifecycle
state remains overlaid by instance.

## Testing

Server unit tests use table-driven resolved/canonical path cases for:

- OpenCode native and Windows npm installations;
- Codex standalone on Unix and Windows, npm-family managers, Homebrew, and a
  custom wrapper;
- Claude native Unix and Windows paths, stable/latest settings, both Homebrew
  casks, WinGet, apt/dnf/apk repository markers, and custom/system paths without
  a marker; and
- Cursor official native paths, custom wrappers, valid date releases, same-day
  ambiguous builds, and malformed installer documents.

HTTP fixture tests cover npm JSON, Claude plain-text stable/latest endpoints,
Cursor installer parsing, cache isolation by source/channel, forced refresh,
failure retry, response bounds, timeout, and cross-source concurrency.

Control integration tests cover:

- every executable command vector and lock key;
- manual commands being rejected by `server.updateProvider`;
- before/after version-advance verification, including downgrade and ambiguous
  Cursor build rejection;
- unchanged, still-behind, and metadata-failure outcomes;
- Windows command resolution for npm and WinGet shims; and
- scheduler and manual-refresh behavior across all latest-source variants.

Web and contract tests confirm manual commands remain visible while one-click
actions are absent, Cursor becomes a normal update candidate, failed checks do
not expose update actions, and multi-environment command disagreement remains
safe.

Focused suites run after each behavior slice. Completion also requires the full
server package tests, applicable web suites, Rust formatting and Clippy, `vp
check`, `vp run typecheck`, final diff/status inspection, and the repository's
documented provider architecture and provider setup pages updated to match the
implemented matrix.

## Rollout and Residual Risk

This is an in-place server behavior correction with no migration or feature
flag. Existing clients already understand the advisory fields. The main
external risk is an upstream installer, path, or metadata format changing.
Closed source variants, strict parsing, visible uncached failures, and
table-driven fixtures make those changes fail visibly instead of selecting a
wrong updater.

The remaining known limitation is an enterprise Claude channel supplied only
through a non-file managed mechanism that BiBCode cannot inspect. Supporting it
requires a documented, non-interactive effective-settings interface from
Claude; BiBCode will not start an interactive CLI or infer private provider
state to eliminate that limitation.
