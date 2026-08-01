# Rust Provider Maintenance Design

## Context

BiBCode retained T3 Code's provider-update contracts, settings, and UI during the Electron/Node.js to Tauri/Rust migration, but the native server did not retain the maintenance backend. `server.updateProvider` currently returns a hard-coded unsupported error, provider snapshots do not contain `versionAdvisory`, and `enableProviderUpdateChecks` is stored without affecting runtime behavior.

The original T3 Code implementation is the behavioral reference for installation-source detection, version advisories, update execution, coordination, and post-update verification. BiBCode will port that behavior into Rust and add an explicit hourly check requested for BiBCode.

## Goals

- Produce provider version advisories at startup and every hour.
- Keep provider installation user-triggered; scheduled work only checks and notifies.
- Restore safe one-click updates for Codex, Claude, OpenCode, and Cursor.
- Keep Grok manual-only.
- Work on Windows, macOS, and Linux.
- Preserve provider state and continue operating when a registry request or update command fails.
- Use existing Rust process supervision, provider refresh, and status publication paths.

## Non-goals

- Reintroducing Electron, Node.js, or the TypeScript server runtime.
- Automatically installing provider updates on a timer.
- Updating providers installed at an unrecognized explicit path.
- Adding new providers or changing the provider settings UI beyond the separately approved hidden add button.

## Architecture

Add a focused Rust provider-maintenance module under the production server. It owns:

- provider-specific package and native update definitions;
- installation-source detection;
- npm latest-version lookup and its one-hour cache;
- advisory creation;
- update command coordination and execution; and
- per-instance update action state.

`NativeServerControl` owns the maintenance state. Full provider probes pass their resolved executable, configured environment, installed version, and snapshot through the maintenance module before publication. The module attaches `versionAdvisory` and reapplies any `updateState`, so a concurrent refresh cannot erase update progress.

`server.updateProvider` delegates to the same module. Successful and failed update attempts return the contract's existing `{ providers }` payload after publishing the final state. Unsupported targets and duplicate updates for the same instance return `ServerProviderUpdateError`.

No contract change is required.

## Scheduled Checks

`ProductionRuntime` owns a cancellable provider-update-check task. The task requests a full provider refresh immediately after runtime startup and then once per hour. It uses the existing generation and probe-sequence guards, so stale or overlapping results cannot replace newer provider snapshots. The existing single-flight full-refresh guard prevents duplicate expensive probes when startup, settings changes, a UI refresh, or the timer coincide.

Runtime shutdown cancels and joins the task. Unit tests that construct `NativeServerControl` directly do not implicitly leak a permanent background task.

When `enableProviderUpdateChecks` is `false`, probes still report provider health and installed versions but do not contact the npm registry. Manual update actions remain available.

## Advisory Data Flow

For each enabled and installed provider with a detected current version:

1. Resolve its update capabilities from the configured binary and the resolved/canonical executable paths.
2. If update checks are enabled and the provider has an npm package, request `https://registry.npmjs.org/<package>/latest` with a four-second timeout.
3. Cache successful or unavailable results for one hour by package name.
4. Compare current and latest semantic versions.
5. Attach the existing `versionAdvisory` shape with `current`, `behind_latest`, or `unknown` status.

Registry, decoding, or timeout failures produce an `unknown` advisory and leave the rest of the provider snapshot intact. Use the Rust `semver` crate instead of maintaining a custom comparator.

## Provider Update Mapping

| Provider | Latest-version source | Supported update sources |
| --- | --- | --- |
| Codex | npm package `@openai/codex` | Vite+, Bun, pnpm, npm, Homebrew `codex` |
| Claude | npm package `@anthropic-ai/claude-code` | Native `claude update`, Vite+, Bun, pnpm, npm, Homebrew `claude-code` |
| OpenCode | npm package `opencode-ai` | Native `opencode upgrade`, Vite+, Bun, pnpm, npm, Homebrew `anomalyco/tap/opencode` |
| Cursor | No external latest-version lookup | Configured/resolved `cursor-agent update` |
| Grok | None | Manual-only |

A bare package-managed command defaults to npm when no more specific installation source is detected, matching T3 Code. An explicit path with an unrecognized source produces `canUpdate: false`; BiBCode must not guess which installation to mutate.

## Cross-platform Command Resolution

All commands use argument arrays, never interpolated shell command strings.

- Windows resolution honors `PATH` and `PATHEXT` and passes `.cmd`/`.bat` shims through the existing platform launch wrapper. Classifiers include npm, pnpm, Bun, and Vite+ locations under `AppData` as well as resolved package paths.
- macOS classification recognizes Apple Silicon and Intel Homebrew locations and package-manager installations.
- Linux classification recognizes native installer locations, npm, pnpm, Bun, Vite+, and Linuxbrew paths.

Detection considers both the resolved command and its canonical target so symlinks and package-manager shims select the correct updater. Provider-specific environment overrides are applied without discarding the ambient environment required to find package managers.

## Update Execution and Coordination

Updates reuse the existing supervised Rust process runner with:

- a five-minute timeout;
- stdout and stderr captured concurrently;
- output bounded to the contract's 10,000-character maximum;
- child cleanup on timeout, cancellation, or failure; and
- non-zero exits represented in the final update state.

Only one update may run for a provider instance. A second request for the same instance fails immediately. Different instances may queue behind a shared package-manager lock such as `npm-global`, `pnpm-global`, `homebrew`, or the relevant native updater. The queued state is published before waiting.

The state flow is:

`queued -> running -> succeeded | unchanged | failed`

After a zero exit, BiBCode refreshes only the target provider and recomputes its advisory. The result is:

- `succeeded` when the refreshed provider is no longer behind the latest version;
- `unchanged` when the command completed but the provider remains behind or cannot be verified; or
- `failed` for spawn, timeout, cancellation, or unexpected execution failures.

Command failures are represented in `updateState` and returned with the updated provider list, matching T3 Code. Unsupported updates and duplicate same-instance requests remain RPC errors.

## State and Failure Handling

- Advisory lookup failure never changes provider availability, authentication, models, or capabilities.
- Update state is stored separately by instance and overlaid on new snapshots so refreshes cannot lose it.
- Provider generation and probe sequence checks remain authoritative for publication ordering.
- Removing an instance removes its retained update state.
- Logs identify the provider instance and operation without logging secret environment values.
- Returned command output is bounded and must not include environment contents.

## Verification

Rust tests cover:

- Windows, macOS, and Linux installation-path classification;
- exact update command selection for every supported provider/source pair;
- unknown explicit paths remaining manual-only;
- semantic-version advisory states and registry failure fallback;
- one-hour cache behavior and disabled update checks;
- immediate startup check and subsequent hourly ticks using paused Tokio time;
- scheduler cancellation and refresh single-flight behavior;
- same-instance rejection and shared package-manager queuing;
- update state transitions, timeout/output bounds, and post-update verification; and
- `server.updateProvider` success, unsupported, and duplicate-request behavior.

Existing provider UI tests verify advisory and update-state rendering. Completion requires focused Rust and UI tests plus the repository-mandated `vp check` and `vp run typecheck`.
