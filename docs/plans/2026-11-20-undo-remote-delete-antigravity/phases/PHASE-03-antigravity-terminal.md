# Phase 3: Antigravity terminal and chat

- Goal: An Antigravity provider instance can be enabled in Settings and offers an Antigravity Terminal that starts `agy` and an Antigravity chat over `agy acp`; tests and the provider documentation are in place.
- Round: 1
- Depends on: none
- Owns: `docs/plans/2026-11-20-antigravity-terminal-design.md`, `packages/contracts/src/settings.ts`, `packages/contracts/src/model.ts`, `packages/contracts/fixtures/**`, `apps/server/src/server_settings/**`, `apps/server/src/production/provider_inventory.rs`, `apps/server/src/production/control.rs`, `apps/server/src/production/provider_runtime.rs`, `apps/server/src/hermetic_guard.rs`, `apps/server/tests/support/hermetic_providers.rs`, `apps/server/src/test_support/mod.rs`, `apps/web/src/components/chat/provider*.ts`, `apps/web/src/components/chat/ChatHeaderPanelMenu.logic.ts`, `apps/web/src/components/settings/**`, `apps/web/src/session-logic.ts`, `apps/web/src/providerInstances.ts`, `apps/web/src/providerModels.ts`, `apps/web/src/threadProviderBinding.ts`, `apps/web/visual/typography/**`, `docs/providers/**`, `docs/architecture/providers.md`, `docs/README.md`
- Must not touch: `packages/contracts/src/editor.ts`, `apps/server/src/production/editor_launch.rs`, `apps/web/src/components/files/**`, `apps/web/src/components/gitManager/**`, `apps/server/src/git/**`, `apps/desktop/**`, `docs/user/workspace-ui.md` (phase 4 updates it)
- Skills: tdd (failing test first for every registration and launch rule)
- Read first: issue #399 (the request and acceptance criteria); `research-antigravity.md` in this plan folder (the CLI, ACP, SDK and terms facts, with what is unconfirmed); `reviews/plan-review-1.md` findings 3, 8, 9 and 10; `docs/providers/cursor.md` (a terminal without an observer); `docs/architecture/providers.md`
- Checkpoint: the Done when commands of Tasks 3.2 and 3.6 to 3.10 exit 0; in Settings > Agents an Antigravity card exists, disabled by default and marked Preview, and with it enabled the menu lists Antigravity Terminal and Antigravity chat.

Phase rules:

- The design note `docs/plans/2026-11-20-antigravity-terminal-design.md` is binding for Tasks 3.6 to 3.10 (decisions D-A1 to D-A15 and its registration table). Tasks 3.3 to 3.5 of the first draft (chat refusal and exclusion) were removed on 2026-11-20 when the owner ruled that the chat is built; their terminal and documentation work moved into Tasks 3.9 and 3.10.
- No unit or integration test spawns a real `agy`. Fixtures are written from the live handshake measured on 2026-11-20 (design note, facts table), with every account value replaced by a placeholder.
- This phase also owns `apps/server/src/provider/antigravity/**`, `apps/server/src/provider/mod.rs`, `README.md`, `docs/getting-started/provider-setup.md` and `docs/reference/encyclopedia.md`.
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

### Task 3.6: Add the Antigravity ACP session runtime

- Satisfies: R13
- Depends on: 3.2
- Files: create `apps/server/src/provider/antigravity/mod.rs`; create `apps/server/src/provider/antigravity/runtime.rs`; modify `apps/server/src/provider/mod.rs`
- Interfaces: consumes `provider::cursor::acp` (`AcpJsonRpcConnection`, `acp_turn_state`), re-exported as `provider/grok/mod.rs` does; produces `AntigravitySessionRuntime` with open (new, resume, load), prompt, cancel, set mode, set config option and permission answering, for Task 3.7
- Skills: rust-best-practices (error types, ownership across the pump); tdd (fixture peer first)
- Read first: design note D-A5, D-A7 to D-A11; `apps/server/src/provider/grok/runtime.rs` (the fixture-peer tests); `apps/server/src/provider/cursor/runtime.rs`
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server antigravity` exits 0

Steps

1. [ ] Write the failing tests against a fixture ACP peer over in-memory pipes: `initialize` with protocol 1 and no `authenticate`; another protocol version refused; the CLI version read from `agentInfo.version`; `session/new` with cwd and empty `mcpServers`; resume, load and neither capability; replayed and stale-session updates dropped; transient, missing-session and `-32000` failures; permission answers in full access and approval-required; a mode change; cancel with a pending approval; an unanswered cancel; an empty `end_turn`; secret markers stay out of logs. Run `cargo test -p bibcode-server antigravity`. Expected: FAIL (the new tests fail to compile or fail).
2. [ ] Implement the runtime as the design note decides. Run the same command. Expected: PASS (exit 0).
3. [ ] Break one rule (accept protocol version 2) and run the command. Expected: the version test fails; restore it.

### Task 3.7: Dispatch Antigravity chats in the provider runtime

- Satisfies: R13
- Depends on: 3.6
- Files: modify `apps/server/src/production/provider_runtime.rs`
- Interfaces: consumes `AntigravitySessionRuntime` (Task 3.6) and the registration of Task 3.2; produces `AntigravityDriver`, adapter key `antigravity-acp`, and the `sessionId` resume cursor
- Skills: rust-best-practices (delivery outcome mapping); tdd
- Read first: design note D-A4, D-A8, D-A11, D-A12; `GrokDriver` and `CursorDriver::deliver` in `provider_runtime.rs`; the `ACP_FIXTURE` scripted executable
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server provider_runtime` exits 0 and `cargo test -p bibcode-server turn_delivery` exits 0

Steps

1. [ ] Write the failing tests through the scripted executable: a chat start for the default and a custom `antigravity` instance spawns `<binary> acp` with the checkout as cwd; the version rule (1.5.3 refused with its message, 1.5.4 allowed); a child that exits during `initialize`; delivery outcomes (not sent, rejected, ambiguous, accepted); a missing session; the adapter-key and line-too-long tables; error labels. Run `cargo test -p bibcode-server provider_runtime`. Expected: FAIL (the new tests fail).
2. [ ] Implement the driver and its dispatch. Run both Done when commands. Expected: PASS (exit 0).
3. [ ] Confirm the child spawns through `spawn_child` so it is supervised and attributed (AGENTS.md, Profiler coverage). Expected: the supervision test of step 1 passes.

### Task 3.8: Probe Antigravity sign-in state and models in the inventory

- Satisfies: R11, R13
- Depends on: 3.2
- Files: modify `apps/server/src/production/provider_inventory.rs`; modify `apps/server/src/production/control.rs`
- Interfaces: consumes the measured `session/new` shapes (`configOptions` ids `model`, `thought_level`, `mode`; `models.availableModels`); produces the instance's models, thinking levels and auth state in the provider snapshot, for Task 3.9
- Skills: rust-best-practices; tdd
- Read first: design note D-A6, D-A11; `probe_cursor_models` and `merge_provider_snapshot` in `provider_inventory.rs`
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server provider_inventory` exits 0 and `cargo test -p bibcode-server control` exits 0

Steps

1. [ ] Write the failing tests with a scripted executable: the slow probe sends `initialize`, `session/new` and `session/close` and yields models and thinking levels from `configOptions`, and from `models` when `configOptions` is absent; `-32000` "Authentication required" reads unauthenticated with status `ready`; any other error keeps custom models; the quick probe starts no ACP process and keeps the last auth and models; a disabled instance is not probed; no account or plan value from `_meta` reaches the snapshot. Run `cargo test -p bibcode-server provider_inventory`. Expected: FAIL (the new tests fail).
2. [ ] Implement the probe, supervised and registered for attribution. Run both Done when commands. Expected: PASS (exit 0).

### Task 3.9: Offer Antigravity Terminal and Antigravity chat in the client

- Satisfies: R11, R12, R13
- Depends on: 3.2, 3.7, 3.8
- Files: modify `apps/web/src/components/chat/providerTerminalActions.ts` and its test; modify `apps/web/src/components/settings/providerDriverMeta.ts`; modify `apps/web/src/components/chat/providerIconUtils.ts`; modify `apps/web/src/session-logic.ts`; modify the Settings card files and their tests; modify `apps/web/src/components/ChatView.test.tsx`
- Interfaces: consumes the `"antigravity"` driver kind and `AntigravitySettings` (Task 3.2), the snapshot models and auth state (Task 3.8), `ProviderSessionDefault`, and `AntigravityIcon`; produces nothing another task uses
- Skills: vercel-react-best-practices (required review); better-ui (Preview badge and the sign-in hint explain themselves); tdd
- Read first: design note D-A2, D-A5, D-A6, D-A13, D-A14 and the registration table; `apps/web/src/components/chat/providerTerminalActions.ts`; `UI.md`
- Tier: most capable
- TDD: red-green
- Done when: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/chat src/components/settings src/components/ChatView.test.tsx` exits 0 and `vp run typecheck` exits 0

Steps

1. [ ] Write the failing tests: terminal argv is `<binary> --dangerously-skip-permissions`, plus `--model` and `--effort` only from session defaults, never `--continue` or `--conversation`; the menu lists Antigravity chat and Antigravity Terminal for a ready instance; the Settings card has binary path `agy`, writes `enabled` explicitly, shows the Preview badge and the session-defaults control; one production-shaped test from an inventory snapshot through the menu to the terminal-open request in `ChatView`; the text-generation fallback never picks a disabled Antigravity. Run the web command. Expected: FAIL (the new tests fail).
2. [ ] Implement. Run both Done when commands. Expected: PASS (exit 0).
3. [ ] Review the changed components against `vercel-react-best-practices` and `UI.md` and note the result in the report. Expected: no open finding.

### Task 3.10: Document Antigravity everywhere the providers are listed

- Satisfies: R14
- Depends on: 3.6, 3.7, 3.8, 3.9
- Files: create `docs/providers/antigravity.md`; modify `docs/providers/README.md`; modify `docs/architecture/providers.md`; modify `docs/architecture/overview.md`; modify `docs/README.md`; modify `README.md`; modify `docs/getting-started/provider-setup.md`; modify `docs/reference/encyclopedia.md`
- Interfaces: consumes the shipped behavior of Tasks 3.2 and 3.6 to 3.9; produces the guide that phase 4 links from `docs/user/workspace-ui.md`, the testing runbooks and `CHANGELOG.md`
- Skills: better-writing (plain provider guide wording)
- Read first: `docs/providers/cursor.md` (the guide shape); the design note; `research-antigravity.md` in this plan folder
- Tier: cheap
- TDD: exempt (documentation with no behavior to test)
- Done when: `vp run check:markdown-links` exits 0 and `vp check` exits 0

Steps

1. [ ] Write `docs/providers/antigravity.md`: what is supported (AI Terminal, and chat as Preview over ACP), install check `agy --version` and the 1.5.4 minimum for chat, sign-in (`agy`, or `agy acp --login` without a browser), the first-run prompts, the launch commands and what `--dangerously-skip-permissions` means, the chat modes and approvals, the binary path setting, how a model and thinking-level default reaches the terminal and the chat, known limits, the PATH clash between the `agy` CLI and an IDE launcher of the same name, and Google's stated position on third-party hosts for consumer plans with a link to its terms. Versions and command names only; no account, host or local path. Expected: the guide exists with each of those sections.
2. [ ] Name Antigravity in `README.md` (the intro sentence and the provider setup list, marked Preview), `docs/README.md`, `docs/providers/README.md`, `docs/getting-started/provider-setup.md`, `docs/architecture/providers.md`, `docs/architecture/overview.md` and `docs/reference/encyclopedia.md`, wherever each lists the providers. Expected: `rg -n "OpenCode" README.md docs/README.md docs/getting-started docs/architecture/providers.md docs/reference/encyclopedia.md` shows no provider list that lacks Antigravity.
3. [ ] Run `vp run check:markdown-links` and `vp check`. Expected: exit 0 for both.
