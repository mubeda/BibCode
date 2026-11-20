# Phase 3: Antigravity terminal

- Goal: An Antigravity provider instance can be enabled in Settings and offers an Antigravity Terminal that starts `agy`; it never offers or starts a chat; tests and the provider guide are in place.
- Round: 1
- Depends on: none
- Owns: `docs/plans/2026-11-20-antigravity-terminal-design.md`, `packages/contracts/src/settings.ts`, `packages/contracts/src/model.ts`, `packages/contracts/fixtures/**`, `apps/server/src/server_settings/**`, `apps/server/src/production/provider_inventory.rs`, `apps/server/src/production/control.rs`, `apps/server/src/production/provider_runtime.rs`, `apps/server/src/hermetic_guard.rs`, `apps/server/tests/support/hermetic_providers.rs`, `apps/server/src/test_support/mod.rs`, `apps/web/src/components/chat/provider*.ts`, `apps/web/src/components/chat/ChatHeaderPanelMenu.logic.ts`, `apps/web/src/components/settings/**`, `apps/web/src/session-logic.ts`, `apps/web/src/providerInstances.ts`, `apps/web/src/providerModels.ts`, `apps/web/src/threadProviderBinding.ts`, `apps/web/visual/typography/**`, `docs/providers/**`, `docs/architecture/providers.md`, `docs/README.md`
- Must not touch: `packages/contracts/src/editor.ts`, `apps/server/src/production/editor_launch.rs`, `apps/web/src/components/files/**`, `apps/web/src/components/gitManager/**`, `apps/server/src/git/**`, `apps/desktop/**`, `docs/user/workspace-ui.md` (phase 4 updates it)
- Skills: tdd (failing test first for every registration and launch rule)
- Read first: issue #399 (the request and acceptance criteria); `research-antigravity.md` in this plan folder (the CLI, ACP, SDK and terms facts, with what is unconfirmed); `reviews/plan-review-1.md` findings 3, 8, 9 and 10; `docs/providers/cursor.md` (a terminal without an observer); `docs/architecture/providers.md`
- Checkpoint: the Done when commands of Tasks 3.2 to 3.4 exit 0; in Settings > Agents an Antigravity card exists, disabled by default, and with it enabled the AI Terminal menu lists Antigravity Terminal and no Antigravity chat.

Phase rules:

- Chat exclusion is one shared rule applied where a chat is chosen. No file outside this phase's ownership is edited for it; `FileBrowserPanel.tsx` (phase 1's folder) and `useAddProjectWorkflow.ts` get the rule through `resolveDefaultAgentInstanceId`.
- Each `cargo test` invocation takes one filter. Every `cargo` command runs under the executor's shared build lock.
- `ProviderDriverKind` is an open branded string (`packages/contracts/src/providerInstance.ts:16-32`), so no closed union gains a member.

## Tasks

### Task 3.1: Write and review the Antigravity terminal design note

- Satisfies: R10
- Depends on: none
- Files: create `docs/plans/2026-11-20-antigravity-terminal-design.md`
- Interfaces: consumes `research-antigravity.md`; produces the classified registration table, the chat-eligibility rule and the model and effort rule that Tasks 3.2 to 3.5 implement
- Skills: mstack-research (re-check any flag the research marks unconfirmed)
- Read first: `apps/web/src/components/chat/providerTerminalActions.ts:33-236`; `apps/web/src/components/chat/providerAgentActions.ts`; `apps/web/src/components/chat/ChatHeaderPanelMenu.logic.ts`; `apps/web/src/providerModels.ts:92-105`; `apps/server/src/production/provider_inventory.rs:181-191,215-314,2012-2064`; `apps/server/src/production/provider_runtime.rs:2468-2473,2532-2543,6730-6737,6975-6985`; `apps/server/src/production/control.rs:2817-2841,2976-3013`; `packages/contracts/src/settings.ts:425-470,571-578,650-670,762-830`; `packages/shared/src/providerSessionDefaults.ts:89-137,242-254,303-337`; an existing note, `docs/plans/2026-11-18-server-commands-design.md` (the shape)
- Tier: most capable
- TDD: exempt (a design document with no behavior to test)
- Done when: `test -s docs/plans/2026-11-20-antigravity-terminal-design.md` exits 0, `vp check` exits 0, and the note's "Review record" section lists a Codex review and an advisor review with every finding handled; observable in the note

Steps

1. [ ] Confirm from https://antigravity.google/docs/cli/reference/ the spelling of `--model`, `--effort` and `--dangerously-skip-permissions`, and that plain `agy` starts the TUI. That page does not list `--version`: cite Google's getting-started page for `agy --version`, or record it as unverified in the note. A flag that differs changes spec R12 only through a Ruling logged in `progress.md`.
2. [ ] Run `rg -n '"cursor"|cursor-agent|CursorSettings|CURSOR_DRIVER_KIND|make\("cursor"\)|"grok"' packages apps/web/src apps/web/visual apps/server/src apps/server/tests -g '!**/provider/cursor/**' -g '!**/provider/grok/**'`. Expected: a list of sites; classify each in a table as "needs an antigravity entry", "chat only, must not get one" or "unrelated". The table must include the sites review finding 8 names.
3. [ ] Decide and write, each with the alternative that lost and its trade-off: driver slug `antigravity`; default disabled (spec D7); the Settings card (binary path, the existing icon, a line that chat is not supported yet, and whether a model and effort default can be set there); the permission flag (spec D8); model and effort: argv takes `--model` and `--effort` only from the raw `settings.providerSessionDefaults.antigravity` value (`model`, and the effort option in `options`), never from the resolver's fallback, because the driver has no catalog and the fallback model belongs to another vendor; chat eligibility: one exported predicate used by `buildProviderAgentActions`, `resolveDefaultAgentInstanceId`, `resolveSelectableProvider` and any other chooser the table finds; the server refusal placed before `canonical_provider_kind` with its own error text; the display name on the Rust label path; first-run prompts of the TUI appearing in the embedded terminal; the PATH clash with an IDE launcher; and Google's stated position on third-party hosts for consumer plans, with what the terminal does (it runs the user's own unmodified CLI interactively).
4. [ ] Get a Codex read-only review of the note (the `codex` skill, `gpt-6.2-sol` at `high`) and an advisor review (the executing session's advisor tool, called with no arguments after the note is saved; a host without it runs a second fresh-context, read-only review on the most capable model and logs it as such). Process both with `mstack-receive-review`, fix accepted findings, and append a "Review record" section with each finding and its outcome. By spec D6 this is the note's approval.
5. [ ] Run `vp check`. Expected: exit 0.

### Task 3.2: Register the antigravity driver in settings, inventory and the hermetic lists

- Satisfies: R11, R14
- Depends on: 3.1
- Files: modify `packages/contracts/src/settings.ts`; modify `packages/contracts/src/model.ts`; modify `packages/contracts/fixtures/**` (regenerated); modify `apps/server/src/server_settings/mod.rs`; modify `apps/server/src/production/control.rs`; modify `apps/server/src/production/provider_inventory.rs`; modify `apps/server/src/production/provider_runtime.rs` (the label only); modify `apps/server/src/hermetic_guard.rs`; modify `apps/server/tests/support/hermetic_providers.rs`; modify `apps/server/src/test_support/mod.rs`
- Interfaces: consumes the design note's table; produces the contract `AntigravitySettings` (`enabled`, default `false`; `binaryPath`, default `"agy"`; `customModels`), the `providers.antigravity` key with its patch schema, and a `ServerProvider` snapshot with `driver: "antigravity"` and `displayName: "Antigravity"`, which Tasks 3.3 and 3.4 use
- Skills: rust-best-practices (settings and inventory changes stay idiomatic)
- Read first: `docs/plans/2026-11-20-antigravity-terminal-design.md` (binding); `apps/server/src/server_settings/mod.rs:10-80,330-340,636-700`; `apps/server/src/production/provider_inventory.rs:2915-2925` (the exact-order inventory assertion); `.repos/effect-smol/LLMS.md` (before editing Schema code)
- Tier: most capable
- TDD: red-green
- Done when: each of `cargo test -p bibcode-server server_settings`, `cargo test -p bibcode-server provider_inventory`, `cargo test -p bibcode-server hermetic` and `cargo test -p bibcode-server control` exits 0 with the new tests, and `vp run check:contracts` exits 0 after the regenerated fixtures are staged

Steps

1. [ ] Write failing Rust tests: `BUILTIN_DEFAULTS` gains `("antigravity", false, "agy")`; a settings file with no `antigravity` key decodes and yields a disabled instance; a partial object `{ "binaryPath": "custom-agy" }` keeps `enabled` false; an explicit `enabled: true` persists through a settings patch, and `validate_legacy_provider_settings` accepts `providers.antigravity` with `binaryPath` and rejects a non-string one; `default_provider_binary("antigravity")` is `"agy"`; `is_builtin_driver("antigravity")` is true; the synthesized roster and the exact-order assertion include it; a disabled instance is not probed, an enabled one is probed with the configured binary and the single argument `--version` through the existing fixture mechanism (success; a binary that cannot be started reported as not installed; a binary whose `--version` exits non-zero reported as installed with a warning, which is the existing inventory behavior at `provider_inventory.rs:731-742`; both failure cases use an inert fixture executable); the snapshot's `displayName` is "Antigravity"; `GUARDED_PROGRAMS` contains `"agy"`; `BUILTIN_PROVIDER_DRIVERS` and the hermetic enabled table include `antigravity`, so the existing parity test passes.
2. [ ] Run the four `cargo test` commands of Done when, one at a time. Expected: FAIL on each new assertion.
3. [ ] Implement, following the design note's table: `AntigravitySettings` and its patch in `settings.ts` next to `CursorSettings`; the label in `model.ts` and in the Rust label function; the defaults, the patch validation and the roster; the `agy` case in `default_provider_binary`; `"agy"` in `GUARDED_PROGRAMS`; the hermetic lists.
4. [ ] Run the four `cargo test` commands. Expected: PASS.
5. [ ] Regenerate and check the contract fixtures: run `vp run check:contracts`. Expected: it rewrites `packages/contracts/fixtures` and then fails its final `git diff --exit-code` if a fixture changed; review that diff, stage it with `git add packages/contracts/fixtures`, and run the command again. Expected: exit 0.
6. [ ] Prove a test can fail: return the driver slug from `default_provider_binary` for `antigravity`, run `cargo test -p bibcode-server provider_inventory`. Expected: FAIL. Restore and run again. Expected: PASS.
7. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 3.3: Refuse a chat start for an Antigravity instance on the server

- Satisfies: R13
- Depends on: 3.2
- Files: modify `apps/server/src/production/provider_runtime.rs`
- Interfaces: consumes the instance-to-driver resolution at `provider_runtime.rs:6730-6737` and `canonical_provider_kind` (`:6975-6985`); produces a `ProviderRuntimeError` variant or message for a terminal-only driver, shown to the user as "Antigravity does not support chat yet. Open an Antigravity Terminal instead."
- Skills: rust-best-practices (error variant and boundary logging)
- Read first: `apps/server/src/production/provider_runtime.rs:2440-2545,6700-6760,6960-6990`; `docs/plans/2026-11-20-antigravity-terminal-design.md`
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server provider_runtime` exits 0 with the new tests

Steps

1. [ ] Write failing tests: a chat start that names an Antigravity instance by its default id, and one that names a custom instance id whose driver is `antigravity`, both fail with the message above, before any process is spawned (assert through the hermetic fixture that no program ran); a start for an unknown driver still gives the existing "turned off or not set up" message.
2. [ ] Run `cargo test -p bibcode-server provider_runtime`. Expected: FAIL, because both starts give the generic message.
3. [ ] Implement the refusal before `canonical_provider_kind` is called, with `tracing::warn!` at that boundary and no prompt or message content in the log.
4. [ ] Run `cargo test -p bibcode-server provider_runtime`. Expected: PASS.
5. [ ] Prove the test can fail: remove the early refusal, run the command. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 3.4: Offer Antigravity Terminal and never an Antigravity chat in the client

- Satisfies: R11, R12, R13
- Depends on: 3.2
- Files: modify `apps/web/src/components/chat/providerTerminalActions.ts`; test `apps/web/src/components/chat/providerTerminalActions.test.ts`; modify `apps/web/src/components/chat/providerAgentActions.ts`; test `apps/web/src/components/chat/providerAgentActions.test.ts`; modify `apps/web/src/providerModels.ts` and its test; modify `apps/web/src/threadProviderBinding.ts`; test `apps/web/src/threadProviderBinding.test.ts`; modify `apps/web/src/components/settings/providerDriverMeta.ts`; modify `apps/web/src/components/settings/SettingsPanels.tsx` and `ProviderInstanceCard.tsx` where the card or the defaults control needs the terminal-only case; test `apps/web/src/components/settings/SettingsPanels.test.tsx`; modify `apps/web/src/components/chat/providerIconUtils.ts`; modify `apps/web/src/session-logic.ts`; modify `apps/web/visual/typography/settings.tsx` and its tests if the new Settings entry changes them
- Interfaces: consumes the `"antigravity"` driver kind and `AntigravitySettings` from Task 3.2, `ProviderSessionDefault` (`model`, optional `options`; `packages/contracts/src/settings.ts:571-578`), and `AntigravityIcon` (`apps/web/src/components/Icons.tsx:641-646`); produces `isChatCapableDriver(driver: ProviderDriverKind): boolean` exported from `apps/web/src/providerInstances.ts`
- Skills: vercel-react-best-practices (required review for the changed components); better-ui (the terminal-only Settings card explains itself)
- Read first: `docs/plans/2026-11-20-antigravity-terminal-design.md` (binding); `apps/web/src/components/chat/providerTerminalActions.ts:119-236`; `apps/web/src/components/chat/providerAgentActions.ts:40-114`; `apps/web/src/providerModels.ts:92-105`; `apps/web/src/components/settings/SettingsPanels.tsx:2077-2117`; `apps/web/src/components/settings/ProviderInstanceCard.tsx:771-779`
- Tier: most capable
- TDD: red-green
- Done when: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/chat src/components/settings src/providerModels.test.ts src/threadProviderBinding.test.ts` exits 0

Rules for this task

- Chat eligibility lives in the two central selectors, `resolveSelectableProvider` (`apps/web/src/providerModels.ts`) and `resolveThreadProviderBinding` (`apps/web/src/threadProviderBinding.ts:108-139,237-245`), which `ChatView`, the Sidebar's default-thread creation and worktree adoption all go through, and in `buildProviderAgentActions` / `resolveDefaultAgentInstanceId`. Add tests in `threadProviderBinding.test.ts` that an enabled Antigravity instance listed first, or alone, never becomes the implicit chat target of a fresh thread, a default thread or an adopted worktree, and that an explicit terminal selection is kept. A caller that bypasses the selectors is named in the task report and handed to the executor, not edited.
- Add one production-shaped test: an inventory snapshot with an enabled, installed Antigravity instance goes through the real menu builder, the terminal action is clicked, and the terminal-open request carries the thread's checkout as working directory, the command and the activity.
- The typography gallery is not in the `unit` project. If a typography fixture changes, run `cd apps/web && node ../../scripts/run-local-vp.mjs test run --config visual/typography/vite.config.mjs` (from `docs/testing/typography-fixtures.md`). Expected: PASS.

Steps

1. [ ] Write failing launch tests for an enabled Antigravity entry: executable `agy`; args exactly `["--dangerously-skip-permissions"]` when `providerSessionDefaults` has no `antigravity` key, even though the resolver would supply a fallback model; `["--dangerously-skip-permissions", "--model", "m1"]` with a raw default of model `m1` alone; with model `m1` and effort `high`, the same plus `"--effort", "high"`; `activity` equals `{ driverKind: "antigravity", providerInstanceId: <the instance id> }`; an instance `binaryPath` of `custom-agy` replaces the executable; no arg is `--continue`, `-c` or `--conversation`; the label is "Antigravity Terminal"; a model value long enough to exceed the command bounds yields the disabled action with the existing bounds reason.
2. [ ] Write failing chat-eligibility tests: `buildProviderAgentActions` returns a terminal action and no chat action for an Antigravity entry; `resolveEffectiveProviderAgentAction` with a saved chat selection naming it falls back to another ready chat, and a saved terminal selection naming it is kept; `resolveDefaultAgentInstanceId` never returns the Antigravity instance for a chat default, including when it is the only instance (it returns the built-in default instance id instead); `resolveSelectableProvider` skips an enabled Antigravity entry when it falls back. Add a Settings test that the Antigravity card renders with the binary path placeholder `agy`, the line that chat is not supported yet, and no control that leads to a chat.
3. [ ] Run the Done when command. Expected: FAIL, on the missing launch definition and the present chat action.
4. [ ] Implement: `isChatCapableDriver`; the `antigravity` entry in `DEFINITIONS` and argv built from the raw settings value as the design note rules; the predicate in the four choosers; the Settings definition with `AntigravityIcon`, the icon map entry, and the card text.
5. [ ] Run the Done when command. Expected: PASS.
6. [ ] Prove a test can fail: make `isChatCapableDriver` return true always, run the Done when command. Expected: FAIL in the chat-eligibility tests. Restore and run again. Expected: PASS.
7. [ ] Run `vp run typecheck`. Expected: no type errors. If a typography fixture changed, review `docs/testing/typography-fixtures.md` and say so in the task report.
8. [ ] Review the changed components against `vercel-react-best-practices` and the Settings card and menu against `UI.md`; record both in the task report, with the user-visible text for the phase 4 update of `docs/user/workspace-ui.md`.

### Task 3.5: Document the Antigravity terminal

- Satisfies: R14
- Depends on: 3.3, 3.4
- Files: create `docs/providers/antigravity.md`; modify `docs/providers/README.md`; modify `docs/architecture/providers.md`; modify `docs/README.md`
- Interfaces: consumes the shipped behavior of Tasks 3.2 to 3.4; produces nothing another task uses
- Skills: better-writing (plain provider guide wording)
- Read first: `docs/providers/cursor.md` (the guide shape and how `--yolo` is documented); `docs/plans/2026-11-20-antigravity-terminal-design.md`; `research-antigravity.md` in this plan folder
- Tier: cheap
- TDD: exempt (documentation with no behavior to test)
- Done when: `vp run check:markdown-links` exits 0 and `vp check` exits 0

Steps

1. [ ] Write `docs/providers/antigravity.md`: what is supported (AI Terminal only; chat is not yet), install check `agy --version`, sign-in (`agy` interactively, or `agy acp --login` on a machine without a browser), the first-run prompts the TUI shows in the terminal, the launch command and what `--dangerously-skip-permissions` means, the binary path setting, how a model and effort default reaches the command, status reported as unavailable, the PATH clash between the `agy` CLI and an IDE launcher of the same name with how to check which one is found, and Google's stated position on third-party hosts for consumer plans with a link to its terms. Versions and command names only; no account, host or local path. Expected: the guide exists with each of those sections.
2. [ ] Add the guide to `docs/providers/README.md` and to `docs/README.md` under Provider guides, and add the terminal-only mode and the disabled default to `docs/architecture/providers.md`.
3. [ ] Run `vp run check:markdown-links` and `vp check`. Expected: exit 0 for both.
