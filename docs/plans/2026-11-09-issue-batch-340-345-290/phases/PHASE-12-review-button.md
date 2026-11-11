# Phase 12: Review button

- Goal: One click on "Review changes" in Source Control starts a review of the branch and its uncommitted changes in a chat panel or an AI Terminal, started in the provider's own read-only or approval mechanism wherever one exists and saying so where none exists (copy names the mechanism, never the outcome), with per-user and per-project prompts, a reviewed design note, tests, docs and a packaged end-to-end check (amendment A11; R90 to R105).
- Round: 6
- Depends on: 5 (migration 72 and its applied-id lists), 10 (no shared files, but both change `CHANGELOG.md` and `docs/user/workspace-ui.md`)
- Owns: `docs/plans/2026-11-11-code-review-button-design.md`; in `packages/contracts/src/`: `settings.ts`, `orchestration.ts`, `rpc.ts`, `environment.ts`, `keybindings.ts` and their tests; the regenerated files under `packages/contracts/fixtures/`; `apps/server/src/production/control.rs`, `apps/server/src/orchestration/engine.rs`, `apps/server/src/persistence/repositories.rs`, `apps/server/src/persistence/migrations.rs` (migrations 73 and 74 only), `apps/server/src/production/orchestration_rpc.rs`, `apps/server/src/production/worktree_catalog_rpc.rs`, `apps/server/src/lifecycle.rs` (capability only), the `ProjectionProject` and `ProjectionThread` literals the new fields break, `apps/server/src/process/executable.rs` (the batch command-line length check of Task 12.4, and the conditional encoder fix of Task 12.18 only), `apps/server/tests/{orchestration,repositories,windows_terminal_shims}.rs`; `.github/workflows/ci.yml` (one Windows step); `apps/web/src/codeReview.ts` and its test; `apps/web/src/components/SourceControlPanel.tsx`, `SourceControlPanel.logic.ts` and their tests; `apps/web/src/components/sourceControl/CodeReviewProjectPromptDialog.tsx` and its test; `apps/web/src/components/chat/providerTerminalActions.ts` and its test; `apps/web/src/centerPanelActions.ts` and its test; `apps/web/src/components/ChatView.tsx` (the review handler, its prop to the panel, and the Implement gates); `apps/web/src/components/chat/ComposerPrimaryActions.tsx`, `ProposedPlanCard.tsx`, `MessagesTimeline.tsx` (the card's caller), `apps/web/src/components/PlanSidebar.tsx` and their tests (the review gate only); `apps/web/src/components/settings/SettingsPanels.tsx` and its test (the Code review group); `packages/shared/src/keybindings.defaults.json` and its test; `apps/desktop/e2e/specs/source-control-review.e2e.ts` and the Claude fixture's review reply in `apps/desktop/e2e/support/test-project.ts`; `docs/architecture/rpc-and-orchestration.md` (the review panel paragraph)
- Must not touch: other migrations and other phases' rows in the applied-id lists beyond appending 73 and 74; `apps/server/src/terminal/pty.rs` (the length check lives beside the encoder in `executable.rs`); `apps/server/src/provider/**` (no driver mapping changes); `docs/plans/2026-11-09-issue-batch-340-345-290/{spec.md,plan.md,progress.md}` and other phase files
- Shared files: `packages/contracts/**` and its fixtures, `apps/server/src/persistence/migrations.rs` (migrations 73 and 74 are this phase's; it appends them to every hard-coded applied-id list, about 17 places that end in 72 today; the other phase drafted in parallel uses no migration), `CHANGELOG.md`, `docs/user/workspace-ui.md`, `apps/desktop/e2e/wdio.conf.ts` and `.github/workflows/ci.yml` are also changed by that other phase; the coordinator sequences them.
- Skills: test-driven-development (every behaviour starts from a failing test); vercel-react-best-practices (AGENTS.md requires it for the changed components and hooks); better-accessibility (the icon button, its menu, the dialog and their names)
- Read first: the design note `docs/plans/2026-11-11-code-review-button-design.md` (all of it: the guard table, the lead-in, D40 to D49); `spec.md` (R90 to R105); `UI.md` (Buttons and Actions, Forms, Errors, Text and Copy: no em dashes); `docs/architecture/rpc-and-orchestration.md` lines 2335 to 2350 (how `sideChat` is carried, the model for `codeReview`)
- Checkpoint: `cargo test -p bibcode-server --lib -j 2 code_review`, `cargo test -p bibcode-server --test orchestration -j 2 code_review` and, from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/codeReview.test.ts src/components/SourceControlPanel.logic.test.ts src/components/chat/providerTerminalActions.test.ts src/centerPanelActions.test.ts` exit 0. In the app, "Review changes" in Source Control opens a "Code review · Codex" tab whose first message is the review prompt.

Rust build slot: Tasks 12.1 to 12.4 compile Rust and run `vp run check:contracts` (which runs `cargo test -p bibcode-server --test rpc_wire`); they run only when no other lane compiles Rust. Tasks 12.5 onward are TypeScript, except that 12.11 needs a packaged build and the conditional 12.18 compiles Rust.

## Tasks

### Task 12.1: Review settings in the contract and on the server

- Satisfies: R93 (old settings document; patch round trip; replacing a model drops its old options; oversized prompt)
- Depends on: none
- Files: modify `packages/contracts/src/settings.ts`; test `packages/contracts/src/settings.test.ts`; modify `apps/server/src/production/control.rs` (validation, defaults, patch, and its test module); regenerate `packages/contracts/fixtures/rpc-wire/stream-shapes/subscribeServerConfig-00.json` and `-03.json` through `vp run check:contracts`
- Interfaces: produces in `settings.ts` `export const CODE_REVIEW_PROMPT_MAX_LENGTH = 7_680`, `export const DEFAULT_CODE_REVIEW_PROMPT: string` (the issue's text, verbatim), `ServerSettings.codeReviewAgent: DefaultAgentSelection` (default `DEFAULT_DEFAULT_AGENT_SELECTION`), `ServerSettings.codeReviewModelSelection: ModelSelection | null` (default `null`), `ServerSettings.codeReviewPrompt: string` (`Schema.String.check(Schema.isMaxLength(CODE_REVIEW_PROMPT_MAX_LENGTH))`, default `""`), and `ServerSettingsPatch` keys `codeReviewAgent`, `codeReviewModelSelection` (`Schema.optionalKey(Schema.NullOr(ModelSelection))`) and `codeReviewPrompt`. In `control.rs`: `validate_settings_document` checks the three keys (reuse `validate_default_agent`, `validate_model_selection` with null allowed, and a string check with the 7,680 limit counted in UTF-16 units as the contract does), `apply_settings_defaults` adds `"codeReviewAgent": {"kind":"chat","instanceId":"codex"}`, `"codeReviewModelSelection": null`, `"codeReviewPrompt": ""`, and `apply_settings_patch` replaces `codeReviewAgent` and `codeReviewModelSelection` whole (like `defaultAgent` at line 2645), so `null` clears the model instead of reaching `merge_patch`.
- Skills: none
- Read first: `packages/contracts/src/settings.ts` lines 548 to 615 and 751 to 790; `apps/server/src/production/control.rs` lines 2144 to 2215, 2324 to 2420 and 2583 to 2660
- Tier: standard
- TDD: red-green
- Done when: `node scripts/run-local-vp.mjs test run packages/contracts/src/settings.test.ts` and `cargo test -p bibcode-server --lib -j 2 code_review_settings` exit 0 with the new tests passing, and `vp run check:contracts` exits 0

Steps

1. [ ] In `settings.test.ts` write `decodes code review settings with their defaults` (an empty document gives chat `codex`, `null`, `""`), `round-trips code review patch keys` and `rejects a review prompt over 7680 characters`. Run the Done-when contracts command. Expected: FAIL, the keys do not exist.
2. [ ] Add the constants, fields and patch keys. Run it again. Expected: PASS.
3. [ ] In `control.rs` tests write `code_review_settings_default_when_missing`, `code_review_settings_patch_replaces_model_whole` (store `{"instanceId":"claudeAgent","model":"opus","options":[{"id":"effort","value":"high"}]}`, patch to `{"instanceId":"codex","model":"gpt-5"}`, read back exactly that object with no `options` key) and `code_review_settings_reject_long_prompt_and_bad_agent` (7,681 characters; `{"kind":"other"}`), each asserting the stored document is unchanged on rejection. Run `cargo test -p bibcode-server --lib -j 2 code_review_settings`. Expected: FAIL.
4. [ ] Implement validation, defaults and whole replacement. Run it again. Expected: PASS, 3 tests.
5. [ ] Prove a test can fail: remove `codeReviewModelSelection` from the whole-replacement list and run the patch test. Expected: FAIL, because `merge_patch` keeps the old `options`. (A `null` patch is assigned directly either way, so it cannot prove this.) Restore. Expected: PASS.
6. [ ] Run `vp run check:contracts`, commit the regenerated fixtures, then `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors and no remaining fixture diff.

### Task 12.2: The project review prompt, migration 73 and replay

- Satisfies: R94 (set, omit, reset, replay; old events; oversized project prompt)
- Depends on: 12.1 (uses `CODE_REVIEW_PROMPT_MAX_LENGTH`)
- Files: modify `packages/contracts/src/orchestration.ts`; test `packages/contracts/src/orchestration.test.ts`; modify `apps/server/src/orchestration/engine.rs`; modify `apps/server/src/persistence/repositories.rs`; modify `apps/server/src/persistence/migrations.rs`; modify `apps/server/src/production/orchestration_rpc.rs` (`project_shell` only); modify every `ProjectionProject { .. }` literal the new field breaks (`rg -n "ProjectionProject \{" apps/server`, about 23 places, including `apps/server/tests/support/load_fixture.rs`); test `apps/server/tests/repositories.rs` and `apps/server/tests/orchestration.rs`; regenerate `packages/contracts/fixtures/http-orchestration/full-read-model.json` and `packages/contracts/fixtures/rpc-wire/stream-shapes/orchestration__subscribeShell-00.json` and `-01.json`; add `codeReviewPrompt: ""` to every `OrchestrationProject` literal in web and client-runtime tests that the now-required decoded field breaks (`rg -ln worktreeDiscovery apps/web/src packages/client-runtime/src`, about 14 files, such as `apps/web/src/components/Sidebar.testHarness.tsx` and `packages/client-runtime/src/state/shellReducer.test.ts`)
- Interfaces: consumes `CODE_REVIEW_PROMPT_MAX_LENGTH`. Produces `codeReviewPrompt` with `Schema.withDecodingDefault(Effect.succeed(""))` on `OrchestrationProject` (line 295), `OrchestrationProjectShell` (about 669) and `ProjectCreatedPayload` (about 1496), and `Schema.optional(Schema.String.check(Schema.isMaxLength(CODE_REVIEW_PROMPT_MAX_LENGTH)))` on `ProjectMetaUpdateCommand` (957), `ClientProjectMetaUpdateCommand` (968) and `ProjectMetaUpdatedPayload` (1516). Server: `code_review_prompt: Option<String>` on `OrchestrationCommand::ProjectMetaUpdate` (engine.rs 433, `#[serde(rename = "codeReviewPrompt", default, skip_serializing_if = "Option::is_none")]`), refused by the decider when longer than 7,680 UTF-16 units; `"codeReviewPrompt": ""` in the `project.created` payload (4492); the projector's insert (7476) and update `code_review_prompt = COALESCE(?, code_review_prompt)` bound with `optional_string(payload.get("codeReviewPrompt"))` (7507); `pub code_review_prompt: String` on `ProjectionProject` (repositories.rs 3597), appended to `PROJECT_SELECT` (4185), `decode_project` (5124) and `upsert_project` (526); `"codeReviewPrompt"` in `project_shell` (orchestration_rpc.rs 2691); `Migration::new(73, "ProjectCodeReviewPrompt", migration_073)` with `ALTER TABLE projection_projects ADD COLUMN code_review_prompt TEXT NOT NULL DEFAULT ''` guarded by `table_exists` and `table_has_column` like `migration_052`. The public command check at orchestration_rpc.rs 335 stays as is: the client may set this field.
- Skills: none
- Read first: `apps/server/tests/orchestration.rs` line 452 (`omitted_worktree_discovery_metadata_update_preserves_custom_policy_through_replay`, the replay pattern); `apps/server/tests/repositories.rs` line 89 (`project_repository_identity_round_trips`); `apps/server/src/persistence/migrations.rs` `migration_052` (about 2519) and the test `migration_71_adds_taken_over_at_to_named_clients` (about 3524); `packages/contracts/src/orchestration.test.ts` lines 1155 to 1182 (legacy decode)
- Tier: most capable
- TDD: red-green
- Done when: `node scripts/run-local-vp.mjs test run packages/contracts/src/orchestration.test.ts`, `cargo test -p bibcode-server --lib -j 2 migration_73`, `cargo test -p bibcode-server --test repositories -j 2 code_review_prompt` and `cargo test -p bibcode-server --test orchestration -j 2 code_review_prompt` exit 0, and `vp run check:contracts` exits 0

Steps

1. [ ] Contract tests: the legacy payloads of lines 1155 to 1182 decode with `codeReviewPrompt === ""` on the project, the shell and `project.created`, and `Object.hasOwn(metaUpdated, "codeReviewPrompt") === false`; `ClientProjectMetaUpdateCommand` keeps `codeReviewPrompt: "Our rules"` (it is not stripped like `worktreeDiscovery`); a 7,681 character value fails. Run the contracts command. Expected: FAIL.
2. [ ] Add the contract fields. Expected: PASS.
3. [ ] Rust tests: `migration_73_adds_code_review_prompt_defaulting_empty` (migrate to 72, insert a legacy project row, migrate, assert applied `[73, 74]` once Task 12.3 lands and `[73]` now, the column is `""`, and running `migration_073` again is a no-op); `project_code_review_prompt_round_trips` in `tests/repositories.rs`; `code_review_prompt_survives_omitted_update_reset_and_replay` in `tests/orchestration.rs` (set "Project text", title-only update, rebuild projections as the line-452 test does, assert; update with "", rebuild, assert ""); `code_review_prompt_over_limit_is_rejected`. Run the four Done-when cargo filters. Expected: FAIL to compile.
4. [ ] Implement the server side, append 73 to `MIGRATIONS` after line 675 and to every hard-coded applied-id list (`rg -n "71, 72" apps/server/src/persistence/migrations.rs` plus the multi-line list near line 3780), and fix the `ProjectionProject` literals and the TypeScript project literals. Run the filters and `vp run typecheck`. Expected: PASS, no type errors.
5. [ ] Prove the reset test can fail: bind the update with `.filter(|value| !value.is_empty())` and run the orchestration filter. Expected: FAIL. Restore. Expected: PASS.
6. [ ] Run `vp run check:contracts` (regenerates the read-model and shell fixtures), `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors and no remaining fixture diff.

### Task 12.3: The review thread flag, migration 74 and the capability

- Satisfies: R96 (old thread), R90 (older server), support for 12.7
- Depends on: 12.2 (migration order)
- Files: modify `packages/contracts/src/orchestration.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/environment.ts`; test `packages/contracts/src/orchestration.test.ts`, `packages/contracts/src/rpc.test.ts`, `packages/contracts/src/environment.test.ts`; modify `apps/server/src/production/worktree_catalog_rpc.rs`, `apps/server/src/orchestration/engine.rs`, `apps/server/src/persistence/repositories.rs`, `apps/server/src/persistence/migrations.rs`, `apps/server/src/production/orchestration_rpc.rs`, `apps/server/src/lifecycle.rs`, `apps/server/src/production/control.rs` (descriptor only) and the `ProjectionThread` literals the new field breaks; regenerate the affected fixtures (the field is optional, so TypeScript literals need no change; `vp run typecheck` confirms it)
- Interfaces: produces `codeReview: Schema.optional(Schema.Boolean)` on `OrchestrationThread` (613), `OrchestrationThreadShell` (709) and the thread-created payload (next to `sideChat` at about 1544), sent only when true; `codeReview: Schema.optional(Schema.Boolean)` on `WorktreeCreatePanelInput` (rpc.ts 466); `codeReviews: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))` on the capabilities struct (environment.ts 104). Server: `code_review: bool` on `WorktreeCreatePanelInput` (worktree_catalog_rpc.rs 3530, `#[serde(default, skip_serializing_if = "std::ops::Not::not")]` so an old receipt keeps its digest), carried into the panel's `thread.create` the way `side_chat` is, stored in a new `projection_threads.code_review` column by `Migration::new(74, "ProjectionThreadCodeReview", migration_074)` (`ALTER TABLE projection_threads ADD COLUMN code_review INTEGER NOT NULL DEFAULT 0`, guarded like `migration_067`), `pub code_review: bool` on `ProjectionThread` (repositories.rs 3618), emitted as `"codeReview": true` only when set, and `"codeReviews": true` in both descriptors (lifecycle.rs 86, control.rs 2835). The engine accepts `codeReview` only on a `panel` with a host, as it does `sideChat`.
- Skills: none
- Read first: `docs/architecture/rpc-and-orchestration.md` lines 2335 to 2350; `rg -n "side_chat|sideChat" apps/server/src` (12 files: follow each place, skip the MCP tool and provider tests, which do not need the review flag); `migration_067` and its test (migrations.rs about 2967 and 3640)
- Tier: most capable
- TDD: red-green
- Done when: `node scripts/run-local-vp.mjs test run packages/contracts/src/orchestration.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/environment.test.ts`, `cargo test -p bibcode-server --lib -j 2 code_review_thread` and `cargo test -p bibcode-server --lib -j 2 migration_74` exit 0, and `vp run check:contracts` exits 0

Steps

1. [ ] Contract tests: a thread and a shell without `codeReview` decode with it absent; `WorktreeCreatePanelInput` accepts `codeReview: true`; capabilities without `codeReviews` decode to `false`. Run the contracts command. Expected: FAIL.
2. [ ] Add the fields. Expected: PASS.
3. [ ] Rust tests next to the side chat ones in `worktree_catalog_rpc.rs` (about 5774): `code_review_thread_panel_is_marked_and_survives_replay` (create a host, create a panel with `codeReview: true`, assert the projection and the shell carry it, rebuild projections, assert again); `code_review_thread_flag_is_refused_without_a_host`; `code_review_thread_plain_panel_keeps_its_receipt_digest`; `migration_74_adds_code_review_defaulting_false`; and the descriptor assertions next to lifecycle.rs 1354 and control.rs 7336. Run the cargo filters. Expected: FAIL.
4. [ ] Implement, append 74 to `MIGRATIONS` and to every applied-id list. Expected: PASS.
5. [ ] Prove a test can fail: drop the column write in the projector and run the replay test. Expected: FAIL. Restore. Expected: PASS.
6. [ ] Run `vp run check:contracts`, `vp run typecheck`, `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors and no remaining fixture diff.

### Task 12.4: Windows batch launch: length check beside the encoder, and native argument tests

- Satisfies: R98 (too long for cmd.exe; arguments through an npm-style shim)
- Depends on: none
- Files: modify `apps/server/src/process/executable.rs` (`make_windows_batch_command_line`, line 164, and its unit tests); test `apps/server/src/terminal/pty.rs` tests only if the expected command line there needs the new error case (no product change in `pty.rs`); test `apps/server/tests/windows_terminal_shims.rs`; modify `.github/workflows/ci.yml` (one step on the Windows job, next to the #341 step at about line 415)
- Interfaces: produces `pub(crate) const WINDOWS_BATCH_COMMAND_LINE_MAX_CHARS: usize = 8_191` and, in `make_windows_batch_command_line`, an `Err("The command is too long for a Windows terminal (N of 8,191 characters). Shorten the review prompt or pick a chat reviewer.")` when the encoded line (counted in UTF-16 units, after quoting, `""`, backslash doubling and the `%` expansion) exceeds it; the existing terminal open failure path shows that text. Produces native tests named `review_prompt_shim_passes_<class>` for `quote`, `percent`, `ampersand`, `caret`, `pipe`, `redirect`, `bang`, `trailing_backslash`, `backslash_before_quote` and `combined`, and the CI step "Run review prompt argument tests (Windows)" running `node scripts/run-msvc.mjs cargo test -p bibcode-server --test windows_terminal_shims -j 2 -- review_prompt_shim_`. Produces for Tasks 12.17 and 12.18 the evidence: each class passed or failed on real Windows, with the observed `process.argv`.
- Skills: none
- Read first: `apps/server/src/process/executable.rs` lines 141 to 229 (the encoder; it has no length check today); `apps/server/tests/windows_terminal_shims.rs` lines 133 to 188 (`assert_shim_output`) and 585 to 632 (the batch shim test this extends; it sends `percent-value`, not a real `%`); `apps/server/src/terminal/pty.rs` line 2267 (the expected command line for `&`, `%PATH%` and `!`)
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 windows_batch_command_line` exits 0 on any host; on the Windows CI job or the local Windows VM, `node scripts/run-msvc.mjs cargo test -p bibcode-server --test windows_terminal_shims -j 2 -- review_prompt_shim_` has run, and the task report lists every class as passed or failed with its observed argv (a failing `percent` class is an expected possible outcome that opens Task 12.18, not a reason to edit the test)

Steps

1. [ ] Unit tests in `executable.rs`: `windows_batch_command_line_refuses_over_8191_chars` (a prompt ending in 4,200 backslashes, which encodes past the limit although its raw length is about 4,300; assert the error text and that its N is the encoded length) and `windows_batch_command_line_accepts_exactly_8191_chars`. Run `cargo test -p bibcode-server --lib -j 2 windows_batch_command_line`. Expected: FAIL, no check exists.
2. [ ] Add the check after encoding. Run it. Expected: PASS. Prove it can fail: raise the constant by 10,000 and run. Expected: FAIL. Restore.
3. [ ] Native tests: a temporary `review.cmd` shim containing `@echo off` and `node "%~dp0argv.js" %*` (the npm shim shape), and `argv.js` printing `JSON.stringify(process.argv.slice(2))` after a marker. Each class launches it through `PortablePtyBackend` with `--permission-mode`, `plan`, `--` and `Code review requested from BiBCode. ` followed by its sample (`say "hi"`; `100% %PATH%`; `a & b`; `a ^ b`; `a | b`; `c < d > e`; `!x!`; a text ending in three backslashes; `back\\"slash`; and one argument combining every sample), and asserts the decoded array equals the input exactly and that no file named `b`, `d` or `e` appears in the temporary directory. A test fails, not skips, when `node` is missing.
4. [ ] Run them on Windows. Prove they can fail: temporarily stop quoting arguments in `append_windows_batch_argument` and run. Expected: `ampersand` FAILS. Restore.
5. [ ] Add the CI step. Record each class's result in the task report. If `percent` (or any other class) fails, leave the encoder as it is in this task and open Task 12.18; the failing test stays in the file marked `#[ignore = "fails until Task 12.18"]` so 12.18 has its red test.
6. [ ] Run `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors.

### Task 12.5: Scope, prompt and reviewer resolution in the web

- Satisfies: R90 (all scenarios, as pure predicates, including saved reviewer unavailable and not listed), R91 (branch scope; uncommitted scope), R92 (all three set; blank values fall through), D41, D48, D49
- Depends on: 12.1
- Files: modify `apps/web/src/components/SourceControlPanel.logic.ts`; test `apps/web/src/components/SourceControlPanel.logic.test.ts`; create `apps/web/src/codeReview.ts`; test `apps/web/src/codeReview.test.ts`
- Interfaces: consumes `DEFAULT_CODE_REVIEW_PROMPT`, `VcsStatusResult`. Produces in `SourceControlPanel.logic.ts`: `export type CodeReviewScope = { readonly kind: "branch" | "uncommitted"; readonly base: string | null }`, `export function resolveCodeReviewScope(status: VcsStatusResult | null | undefined): CodeReviewScope | null` (branch when `aheadOfDefaultCount > 0` and `defaultRefName` is set, base `origin/<defaultRefName>`; uncommitted when files exist, base `origin/<defaultRefName>` or `null` without a default ref; `null` otherwise) and `export function resolveCodeReviewButtonState(input: { status: VcsStatusResult | null; scope: CodeReviewScope | null; unavailableReason: string | null }): { readonly disabled: boolean; readonly reason: string | null }` with the reasons "Checking for changes" and "No changes to review", `unavailableReason` taking precedence when set. In `codeReview.ts`: `export function codeReviewScopeText(scope: CodeReviewScope): string`; `export function resolveCodeReviewPrompt(input: { readonly project: string; readonly user: string; readonly scope: CodeReviewScope }): string` (lead-in, then the first non-blank of the three with every `{scope}` and `{base}` replaced, `{base}` falling back to `HEAD` when null); `export function resolveCodeReviewChatModes(driver: ProviderDriverKind): { readonly runtimeMode: "approval-required"; readonly interactionMode: "plan" | "default" }` (`plan` only for `claudeAgent`); `export function codeReviewGuardLine(reviewer: { readonly kind: "chat" | "terminal"; readonly driver: ProviderDriverKind }): string` with the seven mechanism lines of the design note's table (for example "Starts in Claude's plan mode."; none says "blocks" or "cannot edit"); `export function resolveSavedCodeReviewer(actions: ReadonlyArray<ProviderAgentAction>, selection: DefaultAgentSelection): { readonly action: ProviderAgentAction; readonly reason: null } | { readonly action: null; readonly reason: string }` that matches the saved kind and instance exactly and never falls back ("<label> is not available. Change the code review agent in Settings → Agents." for a listed but disabled entry, "The code review agent is not available on this environment. Change it in Settings → Agents." for an unlisted one); `export function resolveCodeReviewModelSelection(stored: ModelSelection | null, instanceId: ProviderInstanceId): ModelSelection | null` (returns `stored` only when its instance matches).
- Skills: none
- Read first: the design note sections "Read-only, per reviewer", "Prompt lead-in" and "Default prompt"; `apps/web/src/components/SourceControlPanel.logic.ts` lines 84 to 126
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/codeReview.test.ts src/components/SourceControlPanel.logic.test.ts` exits 0 with the new tests passing

Steps

1. [ ] Write failing tests for the scope and button state: dirty tree with no commits, clean tree with 2 commits ahead, both, neither, `aheadOfDefaultCount` absent, the default branch with edits, no `defaultRefName`, status `null` (each with the exact reason). Write failing tests for the prompt: all three set (the R92 text, exactly), project blank, both blank, whitespace-only values, both scopes, repeated placeholders, and a project prompt "purge" whose resolved text starts with "Code review requested from BiBCode." Write failing tests for modes, guard lines (no line contains "block" or "cannot"), the model rule, and `resolveSavedCodeReviewer`: saved chat `claudeAgent` disabled while chat `cursor` is enabled returns the Claude reason and no action; an unlisted instance returns the unlisted reason. Run the Done-when command. Expected: FAIL, the functions do not exist.
2. [ ] Implement the functions. Run it. Expected: PASS.
3. [ ] Prove a test can fail: make `resolveCodeReviewChatModes` return `plan` for `codex` and run it. Expected: FAIL. Restore. Expected: PASS.
4. [ ] Run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 12.6: The review terminal command

- Satisfies: R97 (Claude arguments; Codex arguments; oversized prompt), R98 (off until proven; line breaks), R92 (a prompt that looks like a command)
- Depends on: 12.5
- Files: modify `apps/web/src/components/chat/providerTerminalActions.ts`; test `apps/web/src/components/chat/providerTerminalActions.test.ts`
- Interfaces: consumes `resolveProviderSessionDefault`, `decodeTerminalLaunchCommand`, `resolveCodeReviewModelSelection`. Produces `export const WINDOWS_TERMINAL_REVIEWS_ENABLED = false` (a one-line comment names Task 12.17 as the only place that turns it on), `export const CODE_REVIEW_DRIVERS_WITH_TERMINALS: ReadonlySet<ProviderDriverKind>` (`claudeAgent`, `codex`), and `export function resolveProviderReviewTerminalAction(entry: ProviderInstanceEntry, settings: ProviderTerminalSettings, input: { readonly prompt: string; readonly platformOs: string | null; readonly modelSelection: ModelSelection | null }): ProviderTerminalActionItem | null`, returning `null` for other drivers, label `${entry.displayName} Review`, arguments `["--permission-mode", "plan", ...providerArguments, "--", prompt]` for Claude and `["--sandbox", "read-only", "--ask-for-approval", "never", ...providerArguments, "--", prompt]` for Codex (no `DEFINITIONS` bypass arguments), the reasons of R97, and on Windows: while `WINDOWS_TERMINAL_REVIEWS_ENABLED` is false, a disabled action with "Terminal reviews are off on Windows for now. Pick a chat reviewer in Settings → Agents."; once true, the prompt with `/\r\n|\r|\n/g` replaced by one space. No web-side length estimate: the server's batch encoder refuses an over-long line (Task 12.4). It reuses `binaryPath`, `providerArguments` and the activity block of `resolveProviderTerminalAction` instead of copying them.
- Skills: none
- Read first: `apps/web/src/components/chat/providerTerminalActions.ts` (all, 203 lines); the design note's "Installed CLIs" table
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/chat/providerTerminalActions.test.ts` exits 0 with the new tests passing

Steps

1. [ ] Write failing tests: Claude and Codex arguments exactly as R97, the prompt last and right after `--`, neither bypass flag present, the model override used only for its own instance, `null` for `cursor`, the 8,192 and control-character reasons, a prompt starting with `-` still after `--`, the Windows-off reason on Windows only (never on macOS or Linux), and, with the switch forced on in the test, Windows line breaks flattened. Run the Done-when command. Expected: FAIL.
2. [ ] Implement. Run it. Expected: PASS.
3. [ ] Prove a test can fail: append the Claude bypass flag from `DEFINITIONS` and run. Expected: FAIL. Restore. Expected: PASS.
4. [ ] Run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 12.7: A review thread offers no Implement

- Satisfies: R96 (Claude ends with a plan)
- Depends on: 12.3
- Files: modify `apps/web/src/components/ChatView.tsx` (`showPlanFollowUpPrompt` and the props to the composer, the timeline and the plan sidebar); modify `apps/web/src/components/chat/MessagesTimeline.tsx` (it renders `ProposedPlanCard` at about line 1679 and must pass the flag through its row context); modify `apps/web/src/components/chat/ComposerPrimaryActions.tsx`, `apps/web/src/components/chat/ProposedPlanCard.tsx`, `apps/web/src/components/PlanSidebar.tsx`; test `apps/web/src/components/chat/MessagesTimeline.test.tsx`, `apps/web/src/components/chat/ComposerPrimaryActions.behavior.test.tsx`, `apps/web/src/components/PlanSidebar.test.tsx`, `apps/web/src/components/ChatView.test.tsx`
- Interfaces: consumes `OrchestrationThread.codeReview`. Produces `const isCodeReviewThread = activeThread?.codeReview === true` in `ChatView`, folded into `showPlanFollowUpPrompt` (so an empty Enter never implements), and a `isCodeReview: boolean` prop on the plan card and plan sidebar that hides every Implement entry point and titles the card "Review findings" while keeping copy and download.
- Skills: vercel-react-best-practices (ChatView is a hot render path; derive, do not add state)
- Read first: `apps/web/src/components/ChatView.tsx` lines 2335 to 2365 and 5740 to 5760; `apps/web/src/proposedPlan.ts` lines 85 to 110; `rg -n "Implement" apps/web/src/components` (list every entry point before changing any)
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/chat/MessagesTimeline.test.tsx src/components/chat/ComposerPrimaryActions.behavior.test.tsx src/components/PlanSidebar.test.tsx src/components/ChatView.test.tsx` exits 0 with the new tests passing

Steps

1. [ ] Check what the sidebar and Agents view show for a thread with an actionable proposed plan (`has_actionable_proposed_plan`, `Sidebar.logic.ts`); if they call it a plan awaiting implementation, gate that label on `codeReview` the same way and add it to this task's tests. Write failing tests: a thread with `codeReview: true`, plan interaction mode and an unimplemented proposed plan shows no Implement, Refine or "Implement in a new thread", Enter with an empty composer dispatches nothing, and the card reads "Review findings", asserted on the full rendered path (a `ChatView` with that thread renders the timeline row through `MessagesTimeline`, not only `ProposedPlanCard` in isolation); the same thread without the flag keeps today's actions. Run the Done-when command. Expected: FAIL.
2. [ ] Implement the gate. Run it. Expected: PASS.
3. [ ] Prove a test can fail: drop the flag from `showPlanFollowUpPrompt` and run. Expected: FAIL. Restore. Expected: PASS.
4. [ ] Review the changed components against `vercel-react-best-practices` and record the result. Run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 12.8: The Review button starts a chat or terminal review

- Satisfies: R90 (all scenarios, in the rendered panel), R95 (all scenarios), R97 (through the real launch path)
- Depends on: 12.5, 12.6, 12.7
- Files: modify `apps/web/src/centerPanelActions.ts`; test `apps/web/src/centerPanelActions.test.ts`; modify `apps/web/src/components/ChatView.tsx` (the review handler and one prop); modify `apps/web/src/components/SourceControlPanel.tsx`; test `apps/web/src/components/SourceControlPanel.test.tsx`
- Interfaces: consumes everything from 12.5 and 12.6, `worktreeEnvironment.createPanel`, `startTurn`, `handleOpenProviderTerminalPanel`, `resolveSavedCodeReviewer` (never `resolveEffectiveProviderAgentAction`, whose fallback would start a different agent), `buildProviderAgentActions`, and the environment's settings and `capabilities.codeReviews`. Produces in `centerPanelActions.ts` `createPromptedChatPanel: (input: CreatePromptedChatPanelInput) => Promise<ThreadId | null>` on `CenterPanelActions`, with `interface CreatePromptedChatPanelInput extends CreateChatPanelInput { readonly label: string; readonly prompt: string; readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode; readonly codeReview: boolean }`. It reuses `createPanelThread` and `settlePanelCreation`, which take the thread defaults and the flag as parameters instead of the side-chat booleans, keeps one creation per host in flight, and on a refused first message puts the prompt in the panel's composer and shows "Couldn't start the review" / "The review prompt is in its composer." Side chats keep their behaviour and tests. In `SourceControlPanel.tsx` a new optional prop `codeReview?: { readonly unavailableReason: string | null; readonly guardLine: string | null; readonly onStart: (scope: CodeReviewScope) => void } | null` and, in `header`, an icon button `aria-label="Review changes"` with a tooltip (the reason when disabled, "Review changes" and the guard line when enabled), shown after the upstream counts. In `ChatView.tsx` one handler that resolves the reviewer, the prompt, the modes and the model, then calls `createPromptedChatPanel` with host `activeThread.hostThreadId ?? activeThread.id` and label `Code review · <provider>`, or `handleOpenProviderTerminalPanel` with the review terminal action; it computes `unavailableReason` for: no `codeReviews` capability, `workspaceUnavailable`, a draft thread for both reviewer kinds (a draft has no panel host and `resolveCenterPanelLaunchContext` returns `null`, so a terminal would be refused), and the reason from `resolveSavedCodeReviewer`.
- Skills: vercel-react-best-practices (the header renders on every status update; keep the predicate memoized and the handler a latest handler, as `handleOpenProviderTerminalPanel` is); better-accessibility (icon button name, tooltip on focus, disabled reason reachable by keyboard)
- Read first: `apps/web/src/centerPanelActions.ts` lines 56 to 100 and 300 to 470; `apps/web/src/components/ChatView.tsx` lines 4440 to 4480 (`handleCreateChatPanel`, the model resolution to copy) and 4800 to 4815; `apps/web/src/components/SourceControlPanel.tsx` lines 1075 to 1097 and 1205 to 1220 (the header and the existing AI icon button style)
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/centerPanelActions.test.ts src/components/SourceControlPanel.test.tsx src/components/ChatView.test.tsx` exits 0 with the new tests passing

Steps

1. [ ] In `centerPanelActions.test.ts` write failing tests: `createPromptedChatPanel` sends one `worktree.createPanel` with `threadDefaults` `{ runtimeMode: "approval-required", interactionMode: "plan" }`, `codeReview: true`, title `Panel: Code review · Claude`, then one `thread.turn.start` whose text is the prompt; a second call while the first is pending sends nothing; a refused first message leaves the prompt in the composer and shows the toast; a tab closed while creating sends no message. Existing side chat tests still pass.
2. [ ] In `SourceControlPanel.test.tsx` write failing tests: the button's enabled state and tooltip for each R90 scenario, and a click calls `onStart` with the resolved scope.
3. [ ] In `ChatView.test.tsx` write failing tests: with reviewer chat `codex` in a worktree thread, a click produces one panel creation with host the current thread and `interactionMode: "default"`; with reviewer Claude Terminal, a click opens a center terminal whose command is the review command; a draft thread gives the draft reason for chat `codex` and for Claude Terminal, and no terminal opens; saved chat `claudeAgent` disabled with chat `cursor` enabled gives the Claude reason and a click dispatches nothing. Run the Done-when command. Expected: FAIL.
4. [ ] Implement. Run it. Expected: PASS.
5. [ ] Prove a test can fail: send `DEFAULT_RUNTIME_MODE` instead of the resolved runtime mode and run. Expected: FAIL. Restore. Expected: PASS.
6. [ ] Check the panel in an isolated dev build (light and dark) with a dirty fixture repository: the button, its tooltip, a chat review and a terminal review. Save screenshots outside the repository.
7. [ ] Review the changed components and hooks against `vercel-react-best-practices` and the panel against `UI.md`; record both. Run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 12.9: The project prompt dialog

- Satisfies: R100 (save and reset; save fails)
- Depends on: 12.2, 12.8
- Files: create `apps/web/src/components/sourceControl/CodeReviewProjectPromptDialog.tsx`; test `apps/web/src/components/sourceControl/CodeReviewProjectPromptDialog.test.tsx`; modify `apps/web/src/components/SourceControlPanel.tsx` (a menu button next to "Review changes" with the item "Review prompt for this project…")
- Interfaces: consumes `projectEnvironment.update` through `useAtomCommand(projectEnvironment.update, { reportFailure: false })` (the `ChatView.tsx` line 1074 pattern), `OrchestrationProject.codeReviewPrompt`, `CODE_REVIEW_PROMPT_MAX_LENGTH`, `DEFAULT_CODE_REVIEW_PROMPT`. Produces `CodeReviewProjectPromptDialog({ open, onOpenChange, environmentId, projectId, projectPrompt, userPrompt })`: a textarea showing the project prompt, or the user prompt or the default when blank, a counter `N / 7,680`, Reset (sets the field to the effective lower-level text and stores "" on Save), Save (stores "" when the text equals the effective lower-level text), Cancel; on failure it stays open, keeps the text and shows the error under the field. The menu item is disabled with "Update the BiBCode server on this environment to use Review." without `capabilities.codeReviews`, because an older server would ignore the field without an error.
- Skills: vercel-react-best-practices (the dialog state stays local); better-accessibility (dialog title, labelled field, counter announced politely)
- Read first: `apps/web/src/components/SourceControlPanel.tsx` (existing dialogs, such as the discard confirm); `apps/web/src/components/ChatView.tsx` lines 2980 to 2995 (the `updateProject` call shape); `UI.md` Forms and Errors
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/sourceControl/CodeReviewProjectPromptDialog.test.tsx src/components/SourceControlPanel.test.tsx` exits 0 with the new tests passing

Steps

1. [ ] Write failing tests: Save sends `{ projectId, codeReviewPrompt: "Our rules" }`; Reset then Save sends `""`; text equal to the effective default sends `""`; a refused update keeps the dialog open with the text and the message; the counter stops input at 7,680; the menu item opens the dialog. Run the Done-when command. Expected: FAIL.
2. [ ] Implement. Run it. Expected: PASS.
3. [ ] Prove a test can fail: send the raw text even when it equals the default. Expected: FAIL. Restore. Expected: PASS.
4. [ ] Review against `vercel-react-best-practices` and `UI.md`; run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 12.10: The Code review group in Settings → Agents

- Satisfies: R99 (unedited prompt; reset and default text; instructed reviewer)
- Depends on: 12.1, 12.5, 12.6
- Files: modify `apps/web/src/components/settings/SettingsPanels.tsx` (`AgentsSettingsPanel`, line 933); test `apps/web/src/components/settings/SettingsPanels.test.tsx`
- Interfaces: consumes `buildProviderAgentActions`, `resolveSavedCodeReviewer`, `CODE_REVIEW_DRIVERS_WITH_TERMINALS`, `codeReviewGuardLine`, `useUpdatePrimarySettings`, the Default Agent row's `Select` markup (lines 970 to 1012) and `SettingResetButton`. Produces a "Code review" `SettingsSection` with rows "Code review agent" (chat entries plus only the Claude and Codex terminal entries; the guard line as the row status; a saved reviewer that is unavailable stays shown as saved with its reason instead of displaying a fallback), "Review model" ("Provider default" plus the models of the selected reviewer's instance; stores `null` for Provider default) and "Review prompt" (textarea prefilled with `DEFAULT_CODE_REVIEW_PROMPT` when stored `""`, counter, saved on blur, Reset stores `""`, text equal to the default stores `""`). Without `capabilities.codeReviews` on the primary environment each row shows "Update the BiBCode server on this environment to use Review." and its control is disabled.
- Skills: vercel-react-best-practices (the panel re-renders on every settings change; keep the draft local to the textarea); better-accessibility (labels and the counter)
- Read first: `apps/web/src/components/settings/SettingsPanels.tsx` lines 933 to 1080
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/settings/SettingsPanels.test.tsx` exits 0 with the new tests passing

Steps

1. [ ] Write failing tests: the unedited field shows the default text and no Reset; Reset stores `""`; saving the default text stores `""`; the reviewer list has chats and exactly the Claude and Codex terminals; picking chat `cursor` shows its guard line; "Provider default" stores `null`. Run the Done-when command. Expected: FAIL.
2. [ ] Implement. Run it. Expected: PASS.
3. [ ] Prove a test can fail: store the textarea text verbatim on blur. Expected: FAIL. Restore. Expected: PASS.
4. [ ] Review against `vercel-react-best-practices` and `UI.md`; run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 12.11: Packaged desktop end-to-end review

- Satisfies: R101 (packaged review; packaged Claude review ending in a plan)
- Depends on: 12.8
- Files: create `apps/desktop/e2e/specs/source-control-review.e2e.ts`; modify `apps/desktop/e2e/support/test-project.ts` (the Claude fixture source near line 772: when the prompt starts with "Code review requested from BiBCode.", reply with an assistant message holding an `ExitPlanMode` tool use whose `plan` is "## Review findings\n\n- Low: example finding", then the result); modify `apps/desktop/e2e/wdio.conf.ts` (add the spec to the list near line 67); modify `docs/testing/cross-platform-validation.md` if it lists the packaged UI specs
- Interfaces: consumes `desktopUiFixture`, `readProviderInputLog`, `waitForProviderInputLogEntry` and the UI helpers used by `apps/desktop/e2e/specs/chat-side-chat.e2e.ts`. The fixture settings for this spec set `codeReviewAgent` to chat `claudeAgent` for the Claude case. The provider log records only prompts, so the spec observes the modes through the review panel's visible runtime and interaction pickers.
- Skills: none
- Read first: `apps/desktop/e2e/specs/chat-side-chat.e2e.ts` (fixture import, panel tab selectors, provider input log); `apps/desktop/e2e/support/test-project.ts` lines 588 to 810 (the Claude fixture); `docs/testing/cross-platform-validation.md` (how a packaged spec runs per platform)
- Tier: standard
- TDD: red-green
- TDD note: the spec fails before the button lands, and the Claude case fails without the review flag
- Done when: the packaged desktop E2E run for the host platform, as `docs/testing/cross-platform-validation.md` describes it, exits 0 with `source-control-review.e2e.ts` passing both cases

Steps

1. [ ] Codex case: import the fixture project, modify one tracked file, open Source Control, click "Review changes", wait for a tab whose label starts "Code review · ", wait for a provider input `start` entry containing "Scope: the staged, unstaged and untracked changes in the working tree", and assert the panel's runtime picker shows approval required.
2. [ ] Claude case: with the reviewer chat `claudeAgent`, start a review, wait for the plan card titled "Review findings", assert there is no Implement, Refine or "Implement in a new thread" control and that Enter in the empty composer sends nothing, reload the window, and assert the same again. Save screenshots to the artifact directory.
3. [ ] Run it before 12.8 is merged into the branch. Expected: FAIL at the missing button.
4. [ ] Prove the Claude case can fail: build with the `codeReview` flag dropped from the panel request (or from `showPlanFollowUpPrompt`), run. Expected: FAIL, Implement is shown. Restore.
5. [ ] Run it on the integrated branch. Expected: PASS, both cases.

### Task 12.12: Changelog, user guide, architecture and runbook review

- Satisfies: R101 (documentation)
- Depends on: 12.8, 12.9, 12.10
- Files: modify `CHANGELOG.md` (Unreleased, a "Git" or "Source Control" line); modify `docs/user/workspace-ui.md` (section "Source Control", line 2139); modify `docs/architecture/rpc-and-orchestration.md` (a review panel paragraph after the side chat one, about line 2350: the `codeReview` flag, the capability, migrations 73 and 74, the project prompt field); review `docs/testing/README.md` and `docs/testing/cross-platform-validation.md`
- Interfaces: none
- Skills: better-writing (plain, short user copy without em dashes)
- Read first: the design note's guard table (the docs may claim no more than it); `AGENTS.md` (Testing Runbook Maintenance)
- Tier: cheap
- TDD: exempt (documentation only)
- Done when: `vp run check:markdown-links` exits 0 and `vp fmt --check CHANGELOG.md docs/user/workspace-ui.md docs/architecture/rpc-and-orchestration.md` reports no changes

Steps

1. [ ] Changelog line, for example: "Source Control has a Review button that starts a code review of your branch and uncommitted changes in a chat panel or an AI Terminal. A Claude review starts in Claude's plan mode, a Codex review runs in Codex's read-only sandbox, and other chat agents are asked not to edit; Settings → Agents shows which applies. Terminal reviews are off on Windows for now. The review prompt can be set per user and per project. (#293)" Expected: the wording names mechanisms and never says a review cannot edit; the user guide also says that the person's and the repository's Claude settings still apply.
2. [ ] User guide: the button, the disabled reasons, scope and base, the reviewer and its guard line, the prompt precedence and lead-in, the project prompt dialog, and that the composer pickers can change a review's modes.
3. [ ] Architecture paragraph as listed under Files.
4. [ ] Review the testing runbooks: Task 12.4 adds a Windows CI step and Task 12.11 a packaged spec, so update the affected runbook entries, or state in the report that they were reviewed and remain accurate.
5. [ ] Run the Done-when commands. Expected: exit 0, no changes.

### Task 12.13: Keyboard shortcut for a review (P1.1)

- Satisfies: R102 (shortcut)
- Depends on: 12.8
- Files: modify `packages/contracts/src/keybindings.ts` (`STATIC_KEYBINDING_COMMANDS`, line 50); modify `packages/shared/src/keybindings.defaults.json`; test `packages/shared/src/keybindings.test.ts`; modify `apps/web/src/components/ChatView.tsx` (the command handler, calling the 12.8 handler); test `apps/web/src/components/ChatView.test.tsx`; modify `docs/user/workspace-ui.md` (one line)
- Interfaces: produces the command `sourceControl.review` and the default `{ "key": "mod+alt+shift+r", "command": "sourceControl.review", "when": "!terminalFocus" }`. The server reads the same JSON (`apps/server/src/production/keybindings.rs` line 6), so no Rust change; its tests must still pass.
- Skills: none
- Read first: design note D46; `packages/shared/src/keybindings.defaults.json`
- Tier: cheap
- TDD: red-green
- Done when: `node scripts/run-local-vp.mjs test run packages/shared/src/keybindings.test.ts` and, from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/ChatView.test.tsx` exit 0, and `cargo test -p bibcode-server --lib -j 2 keybindings` exits 0

Steps

1. [ ] Write failing tests: the default resolves for `sourceControl.review`; no other default uses the same key and `when`; `mod+shift+r` is not bound by any default; pressing the shortcut with an enabled button starts a review and with terminal focus does nothing. Run. Expected: FAIL.
2. [ ] Implement. Run. Expected: PASS.
3. [ ] Run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 12.14: One-off reviewer from the menu (P1.2)

- Satisfies: R103 (one-off reviewer)
- Depends on: 12.9
- Files: modify `apps/web/src/components/SourceControlPanel.tsx` (the 12.9 menu); modify `apps/web/src/components/ChatView.tsx` (the handler accepts an optional reviewer); test `apps/web/src/components/SourceControlPanel.test.tsx` and `apps/web/src/components/ChatView.test.tsx`
- Interfaces: `onStart(scope: CodeReviewScope, reviewer?: DefaultAgentSelection)`; the menu lists the reviewers of Task 12.10 with their guard lines and disabled reasons.
- Skills: better-accessibility (menu items, disabled items keep their reason)
- Read first: Task 12.10's reviewer list
- Tier: cheap
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/SourceControlPanel.test.tsx src/components/ChatView.test.tsx` exits 0 with the new tests passing

Steps

1. [ ] Write failing tests: picking "Claude Terminal" opens a review terminal and dispatches no settings update. Run. Expected: FAIL.
2. [ ] Implement. Run. Expected: PASS. Review against `UI.md`; run `vp check` and `vp run typecheck`.

### Task 12.15: Scope in the tooltip (P1.3)

- Satisfies: R104 (branch scope tooltip)
- Depends on: 12.8
- Files: modify `apps/web/src/components/SourceControlPanel.logic.ts` and its test; modify `apps/web/src/components/SourceControlPanel.tsx`
- Interfaces: `export function codeReviewTooltip(scope: CodeReviewScope): string` returning "Review branch vs origin/main and uncommitted changes" or "Review uncommitted changes".
- Skills: none
- Read first: Task 12.5's scope type
- Tier: cheap
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/SourceControlPanel.logic.test.ts src/components/SourceControlPanel.test.tsx` exits 0 with the new tests passing

Steps

1. [ ] Write failing tests for both scopes and the rendered tooltip with the guard line. Run. Expected: FAIL.
2. [ ] Implement. Run. Expected: PASS. Run `vp check`.

### Task 12.16: Review with one-off instructions (P2.1)

- Satisfies: R105 (added instructions)
- Depends on: 12.14
- Files: modify `apps/web/src/components/SourceControlPanel.tsx` (a "Review with instructions…" menu item and a small dialog); modify `apps/web/src/codeReview.ts` and its test; modify `apps/web/src/components/ChatView.tsx` (the 12.8 review handler forwards `extra` into `resolveCodeReviewPrompt` for both the chat and the terminal path); test `apps/web/src/components/SourceControlPanel.test.tsx` and `apps/web/src/components/ChatView.test.tsx`
- Interfaces: `resolveCodeReviewPrompt` gains `readonly extra?: string` (at most 1,000 characters, appended after a blank line, after placeholder replacement so `{base}` in it is not replaced); `onStart(scope, reviewer?, extra?)`.
- Skills: better-accessibility (dialog field label)
- Read first: Task 12.9's dialog
- Tier: cheap
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/codeReview.test.ts src/components/SourceControlPanel.test.tsx src/components/ChatView.test.tsx` exits 0 with the new tests passing

Steps

1. [ ] Write failing tests: through the full launch path (`ChatView` with a review handler, the menu item, the dialog, Start), the chat panel's first message ends with "\n\nFocus on the parser." and the terminal command's last argument ends with " Focus on the parser." on Windows-free hosts; the saved prompts are unchanged; 1,001 characters are refused next to the field. Run. Expected: FAIL.
2. [ ] Implement. Run. Expected: PASS. Run `vp check` and `vp run typecheck`.

### Task 12.17: Turn on terminal reviews on Windows

- Satisfies: R98 (off until proven; line breaks, now on real Windows)
- Depends on: 12.4, 12.6, and 12.18 when 12.4 opened it
- Files: modify `apps/web/src/components/chat/providerTerminalActions.ts` (`WINDOWS_TERMINAL_REVIEWS_ENABLED = true`) and its test; modify `docs/user/workspace-ui.md` and `CHANGELOG.md` (drop "off on Windows")
- Interfaces: consumes Task 12.4's evidence.
- Skills: none
- Read first: Task 12.4's report; Task 12.18's report if it ran
- Tier: cheap
- TDD: red-green
- Done when: Task 12.4's native class tests (none ignored) have run green on real Windows, in the Windows CI job or the local Windows VM, the run is linked in the task report, and from `apps/web` `node ../../scripts/run-local-vp.mjs test run --project unit src/components/chat/providerTerminalActions.test.ts` exits 0

Steps

1. [ ] Gate: confirm the green Windows run of `review_prompt_shim_` with no ignored test. Expected: a run on real Windows whose output lists every `review_prompt_shim_` case as ok and none as ignored. Without it, stop: this task stays Open.
2. [ ] Change the Windows-off test to expect an enabled action with flattened line breaks on Windows. Run. Expected: FAIL. Set the switch. Run. Expected: PASS.
3. [ ] Update the two docs, run `vp check`. Expected: no errors.

### Task 12.18: Fix the Windows batch `%` encoding (conditional)

- Satisfies: R98 (arguments through an npm-style shim, `percent` and any other failing class)
- Depends on: 12.4, and runs only when 12.4 recorded a failing class
- Files: modify `apps/server/src/process/executable.rs` (`append_windows_batch_argument`); test the same file's unit tests, `apps/server/src/terminal/pty.rs` line 2267 (the expected command line), and `apps/server/tests/windows_terminal_shims.rs` (remove the `#[ignore]` from the failing class)
- Interfaces: none new; every caller of the batch encoder (provider launches through `process::wrap_windows_batch_command` and terminals through `pty.rs` line 685) gets the fix, so the task report lists them and the Windows provider tests are run too.
- Skills: none
- Read first: Task 12.4's report (the observed argv); the Rust standard library's `append_bat_arg` in `library/std/src/sys/args/windows.rs` of the pinned toolchain's `rust-src` (the encoder the comment says it follows)
- Tier: most capable
- TDD: red-green
- Done when: on real Windows, `node scripts/run-msvc.mjs cargo test -p bibcode-server --test windows_terminal_shims -j 2 -- review_prompt_shim_` exits 0 with no ignored test, and `cargo test -p bibcode-server --lib -j 2 windows_batch` exits 0 on any host

Steps

1. [ ] Remove the `#[ignore]` from the failing class. Run on Windows. Expected: FAIL with the argv from 12.4's report.
2. [ ] Fix the encoding the smallest way that matches the observed behaviour, update the `pty.rs` expected string, and add a unit test pinning the new encoding of `%PATH%`. Run both commands. Expected: PASS.
3. [ ] Run the rest of `windows_terminal_shims` and the Windows Git tests the CI job runs. Expected: PASS. Run `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors.
