# Git Manager / Phase 16 — Tags, image diffs, provider surfaces

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Complete the panel with tag create/delete/push, the four image-diff modes, and pull requests and checks read through the existing provider CLI on explicit user action only.

**Architecture:** This phase spans server and web. On the server it adds `apps/server/src/git/manager/tags.rs` (tag commands), a byte-preserving blob read for image diffs, and `apps/server/src/source_control/checks.rs` extending the existing `PullRequestService` (which already shells to `gh`/`glab`/`az`). On the web it adds `tags/`, `diff/` and `provider/` directories under `apps/web/src/components/gitManager/`. It implements Slice 7 (`git-manager-plan.md` § Slices). The zero-telemetry constraint bites hardest here: every provider call is user-initiated, there is no timer, no refresh-on-mount, and no third-party asset fetch — image bytes come from the repository through the server, never from a host.

**Tech Stack:** Rust 2021 / Axum / Tokio — apps/server. Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`. Plus React 19 / Vite+ / TanStack Router / zustand / Effect Atom — apps/web; Tailwind CSS 4 + @base-ui/react + lucide-react; diffs @pierre/diffs. Test: `vp test run <path>` (tests import from `vite-plus/test`). Checks: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/server/src/git/manager/tags.rs` — tag create / delete / push / list, with inline `#[cfg(test)]` command-shape tests
- **Create:** `apps/server/src/source_control/checks.rs` — provider check-run reads through the existing CLI seam
- **Modify:** `apps/server/src/git/manager/mod.rs` — declare `tags`
- **Modify:** `apps/server/src/git/manager/operations.rs` — add the tag operation arms
- **Modify:** `apps/server/src/git/manager/refs.rs` — surface an image-blob read for a `(commitish, path)` pair
- **Modify:** `apps/server/src/git/process.rs` — add a byte-preserving output path (see Step 16.5); do not change the existing lossy path
- **Modify:** `apps/server/src/source_control/mod.rs` — declare `checks`
- **Modify:** `apps/server/src/production/git_manager_rpc.rs` — dispatch tags, image blobs, pull requests and checks
- **Modify:** `apps/server/tests/production_git_manager_rpc.rs` — integration coverage for tags and the image blob over a real temp repository
- **Modify:** `apps/web/src/components/gitManager/history/diffLadder.ts` — add an image branch to PHASE-06's `classifyDiffPayload` rather than bypassing it
- **Modify:** `apps/web/src/components/gitManager/toolbar/syncButton.logic.ts` — add the tags-to-push contribution to `resolveSyncState`'s `ahead`, where PHASE-10 said it belongs
- **Create:** `apps/web/src/components/gitManager/tags/GitManagerTagDialog.tsx` + `.logic.ts` + `.logic.test.ts` + `.test.tsx`
- **Create:** `apps/web/src/components/gitManager/diff/GitManagerImageDiff.tsx` + `gitManagerImageDiff.logic.ts` + `.logic.test.ts` + `.test.tsx`
- **Create:** `apps/web/src/components/gitManager/provider/GitManagerPullRequestPanel.tsx` + `.logic.ts` + `.logic.test.ts` + `.test.tsx`
- **Modify:** `apps/web/src/gitManagerStore.ts` — add ONLY the `imageDiffMode` and `providerPaneOpen` fields; do not touch other slices
- **Modify:** `packages/contracts/src/rpc.ts`, `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs`, `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, `apps/server/tests/rpc_wire.rs` — ONLY if a method PHASE-00 did not declare turns out to be required (see Step 16.2)

## Dependencies

- Phase 07: Server branch and sync operations (streaming)
- Phase 10: Web toolbar, branch dropdown, sync UI

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium. Effort: ~3 h.

---

## Skills to Invoke (teammate-side)

Invoke these skills via the `Skill` tool BEFORE doing any work. Order matters: always-on first, then matched.

**Always-on (every phase):**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the new tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="web-design-guidelines")` — *four image-diff modes need labelled controls and non-pointer operation*
6. `Skill(skill="vercel-react-best-practices")` — *swipe and onion-skin modes must not re-decode images per frame*

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 2 constraints 4 and 5, § 3.1 (tags, PRs and checks, image diffs), § 9 (the zero-telemetry invariant this phase is most exposed to)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; § Global Constraints (no new dependencies, log hygiene), § Slices (Slice 7)
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 3.9 tag commands, § 3.6 unpushed-tag detection, § 1.5 image diff modes, § 5 the GitHub-API entanglement this phase must not reproduce
- `docs/plans/git-manager/research/bibcode-integration-surface.md` — § 3.1 the existing `source_control` module, § 4 the registration checklist
- `docs/integrations/source-control-providers.md` — the current, shipped provider capability matrix this phase extends
- `docs/architecture/providers.md` — provider boundary conventions
- `docs/reference/scripts.md` — the exact commands used below
- `apps/server/src/source_control/pull_request.rs` — the existing `PullRequestService`, `ProviderCommandSpec` and `run_provider_os` seam this phase extends

---

## Pre-execution check

- [ ] **Step 16.0: Claim the phase.** Open `../tasks.md`. Change Phase 16 row → `Status = in_progress`, `Agent = phase-16` (or your subagent name), `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 16.1: Locate the surface area being changed.**

	```bash
	rg -n "pub struct PullRequestService|ProviderCommandSpec|fn run_provider_os|pub async fn resolve_current|pub async fn create" apps/server/src/source_control/pull_request.rs
	rg -n "SUMMARY_FRESHNESS|sleep_until|load_pull_request" apps/server/src/git/summary.rs
	rg -n "GitManagerTag|GitManagerImage|GitManagerPullRequest|GitManagerCheck" packages/contracts/src/gitManager.ts
	rg -n "fn render\(|SupervisedStreamOutput|bytes" apps/server/src/git/process.rs apps/server/src/process/supervised.rs
	```

	`packages/contracts/src/gitManager.ts` is authoritative for every schema and method name. Read `apps/server/src/source_control/pull_request.rs` in full before touching it: `PullRequestService` (indicative :117) already holds `github_command`/`gitlab_command`/`azure_command` as `ProviderCommandSpec` (indicative :19) defaulting to `gh`/`glab`/`az`, and `run_provider_os` (indicative :963) is the single exec seam. Record deviations in the per-phase notes of `tasks.md`.

- [ ] **Step 16.2: Confirm the wire surface, and only cross the registration gate if you must.**

	Confirm PHASE-00 declared the tag operation variants, the image-blob read and the pull-request/checks reads. If any is missing, add it and re-run the whole gate: `WS_METHODS` + `Rpc.make` + the exported `RpcGroup.make` in `packages/contracts/src/rpc.ts`; `pnpm --filter @bibcode/contracts generate:rust-rpc-fixtures`; `ACTIVE_RPC_METHODS` in `apps/server/src/rpc/methods.rs`; exactly one `required_scope` arm in `apps/server/src/auth/scope.rs`; and the two hard-coded count sites — `packages/contracts/scripts/export-rust-rpc-fixtures.ts` and `apps/server/tests/rpc_wire.rs` (indicative :85 `101`, :90 `18`, :92-95 `65`/`23`/`65`/`242` — **re-read them; earlier phases have moved them**). The image-blob read, the pull-request read and the checks read are **reads** and must use the read scope; note that the pre-existing `git.resolvePullRequest` is classified `mutation_unary` today, which is exactly why this feature needs its own read-scoped method rather than reusing it. No `apps/server/src/maintenance.rs` edit is needed — PHASE-07 confirmed that mutability is derived from `ACTIVE_RPC_METHODS` via `method_mutability`.

- [ ] **Step 16.3: Author the first failing test — tag command shapes.**

	Path: `apps/server/src/git/manager/tags.rs`, inline `#[cfg(test)] mod tests`, using `GitRepository::with_runner_for_test` with a recording runner in the style of `RecordingGitRunner` (indicative `repository.rs:5035`). Pin one behaviour: creating a tag runs exactly

	```text
	git tag -a -m '' <name> <sha>
	```

	with the mutation environment from `git_environment()` (indicative `repository.rs:4759`), and the tag name is validated before the process is spawned (max 245 characters, plus git's ref-name rules).

- [ ] **Step 16.4: Run the new test; expect FAIL, then implement `tags.rs` and re-run to PASS.**

	```bash
	cargo test -p bibcode-server git::manager::tags
	```

	Then add the remaining tag tests and implementation, one at a time. These are the exact command lines, from `research/github-desktop-analysis.md` § 3.9 and § 3.6:

	```text
	create   git tag -a -m '' <name> <sha>
	delete   git tag -d <name>
	list     git show-ref --tags -d          (normalise the "^{}" annotated-tag suffix)
	push     git push <remote> refs/tags/<name>
	```

	Cover: deleting a non-existent tag yields a structured error, not a panic; the list normalises `^{}`; pushing a tag runs `--force-with-lease`-free (a tag push is not a force push) and never bare `--force`.

	**Deliberate divergence from the reference, record it in the phase notes:** GitHub Desktop tracks unpushed tags in `localStorage` and batches them as extra refspecs onto the next branch push. That is client-held git state that can desync from the repository and would need a persisted store; this phase pushes one named tag on one explicit user action instead. Remote tag deletion (`git push <remote> :refs/tags/<name>`) is **out of this pass** — it is a separate destructive confirmation surface; state that in the phase notes rather than smuggling it in.

- [ ] **Step 16.5: Add the byte-preserving blob read tests, then implement it.**

	The image sides come from the repository via

	```text
	git show <commitish>:<path>
	```

	`ProcessOutput.stdout` is a `String` and `apps/server/src/git/process.rs` lossy-converts the supervised layer's `SupervisedStreamOutput.bytes` through its private `render` helper (indicative :173) — **a binary blob read through the existing path is corrupted.** The supervised layer already carries `Vec<u8>`, so add a byte-preserving variant alongside the existing one (do not change the lossy path any existing caller depends on) and base64-encode at the RPC boundary. Cap the blob at the spec's image budget and return a structured "too large" result rather than truncating silently; a truncated image is worse than an absent one. Test with a real binary fixture that a round trip is byte-identical.

	`assets.createUrl` is **not** an alternative: its `AssetResource` union (`packages/contracts/src/assets.ts`) is keyed by `ThreadId` or attachment id and cannot address a commit blob.

- [ ] **Step 16.6: Add the provider-checks tests, then implement `apps/server/src/source_control/checks.rs`.**

	Extend the existing `PullRequestService` seam rather than adding a second process path: reuse `ProviderCommandSpec` and `run_provider_os` so the executable stays injectable for tests, exactly as `resolve_current` does. GitHub first:

	```text
	gh pr checks <number> --json name,state,link,workflow
	```

	Verify the available `--json` field set against the `gh` on the host before pinning it, and record what you used. GitLab and Azure DevOps have no equivalent single-command check read at parity; return a structured `unavailable` result for them in this pass, mirroring how native repository publishing is already GitHub-only in `docs/integrations/source-control-providers.md`. Bitbucket has no CLI here at all and stays unavailable.

	**The hard constraint of this step:** the checks read runs only when called. Assert with a test that constructing the service, and letting time pass, spawns no process. Do not add a timer, an interval, a `sleep_until` loop, or a subscription that refreshes on its own. The one existing periodic provider call in this repository is the 30-second cycle in `apps/server/src/git/summary.rs` (`SUMMARY_FRESHNESS`, indicative :20), which is subscriber-scoped, predates this feature, and must not be extended to carry checks. Also note the live tripwire in `apps/server/tests/git_rpc.rs` (indicative :36) that fails the build if `Duration::from_secs(3)` appears in `apps/server/src/production/git_vcs.rs`.

- [ ] **Step 16.7: Wire the server handlers.**

	Add the dispatch arms in `apps/server/src/production/git_manager_rpc.rs`. Tag create, delete and push are mutations and follow PHASE-07's published `run_branch_or_sync_operation` order exactly: `GitManagerOperationRegistry::try_begin` → the worktree catalog lock via `with_project_mutation_lock_cancellation` → guard re-validation under the lock → `StatusBroadcaster::begin_mutation` → execute → always `mutation.finish()`. Reuse PHASE-07's registry and its `classify_operation_failure`; add no second registry and no second stderr matcher. The blob read, the pull-request read and the checks read are reads: they use the read scope, `git_read_environment()` where they touch git, and take no lock. No log line may interpolate a tag name, ref name, absolute path, remote URL, provider output or git stderr.

- [ ] **Step 16.8: Run the server gate.**

	```bash
	cargo fmt --all --check
	cargo test -p bibcode-server git::manager::tags
	cargo test -p bibcode-server source_control::checks
	cargo test -p bibcode-server --test production_git_manager_rpc
	cargo test -p bibcode-server --test git_rpc
	cargo test -p bibcode-server --test rpc_wire
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	```

- [ ] **Step 16.9: Author the failing web test for the tag dialog, then implement it.**

	Path: `apps/web/src/components/gitManager/tags/GitManagerTagDialog.logic.test.ts` then `.logic.ts` and `.tsx`. Import `describe, expect, it` from `"vite-plus/test"`. Export `validateTagName(name, existingTags)` returning `{ valid: boolean; reason: string | null }` — duplicate check immediate, length cap 245 — and `resolveTagDeleteDialogCopy(tag)` for the destructive confirmation (spec § 6.5). Build the dialog on `Dialog` from `apps/web/src/components/ui/dialog.tsx` with nullable `pending*` state, the house convention. Every dispatch goes through the `createRuntimeCommand` wrapper PHASE-10 established (`gitManager.runOperation` is a streaming command in `EnvironmentStreamCommandRpcTag`) on the per-`(environmentId, cwd)` lane, and progress renders through PHASE-10's single `<GitManagerOperationBanner>`. The component receives `{ scope: { environmentId, cwd }, projectRef }` per PHASE-03's prop contract, and gates its capability through PHASE-03's `gitManagerAvailability.ts`.

	Then add the tags-to-push contribution to `resolveSyncState` in `apps/web/src/components/gitManager/toolbar/syncButton.logic.ts` — PHASE-10 reserved that seam so the count is computed in the logic module, not in the toolbar component. Cover it with a test in PHASE-10's existing `syncButton.logic.test.ts`.

- [ ] **Step 16.10: Author the failing web tests for the image diff, then implement it.**

	Path: `apps/web/src/components/gitManager/diff/gitManagerImageDiff.logic.ts` then `GitManagerImageDiff.tsx`. Add the image branch to PHASE-06's `classifyDiffPayload` in `apps/web/src/components/gitManager/history/diffLadder.ts` — PHASE-06's note requires extending it rather than bypassing it — so an image is routed here and an oversized one still falls through the ladder. Support exactly the four reference modes (`research/github-desktop-analysis.md` § 1.5): **2-up**, **swipe**, **onion-skin**, **difference**. Cover the extension set `png, jpg, jpeg, gif, ico, webp, bmp, avif`. Both sides render from `data:` URIs built from the server's base64 payload — assert with a test that no rendered `img` has an `http`/`https` `src`, that no `fetch` is issued, and that a missing side (added or deleted file) renders a one-sided presentation rather than a broken image. Memoise the object URLs so swipe and onion-skin do not re-decode per pointer move. Add `// @vitest-environment happy-dom` on line 1 only for the tests that need DOM.

- [ ] **Step 16.11: Author the failing web tests for the provider pane, then implement it.**

	Path: `apps/web/src/components/gitManager/provider/GitManagerPullRequestPanel.logic.ts` then `.tsx`. The pane shows the resolved pull request and its checks, and a Refresh button. Assert, and this is the phase's most important test:

	- mounting the component issues **no** provider request — the pane starts in an explicit "not loaded" state with a Refresh affordance;
	- advancing fake timers by an hour issues no request;
	- exactly one request is issued per Refresh press;
	- an `unavailable` provider result renders as an explanatory state, not an error toast;
	- the "Create pull request" action reuses the existing stacked-action path (`git.runStackedAction` with `create_pr`) rather than adding a second creation route.

	There is no sign-in, no OAuth, no fork surface and no avatar: author identity is rendered from local commit data only (spec § 6.7).

- [ ] **Step 16.12: Add the store fields and their test.**

	Add only `imageDiffMode: "two-up" | "swipe" | "onion" | "difference"` and `providerPaneOpen: boolean` to `apps/web/src/gitManagerStore.ts`, inside the existing per-project view-state record keyed by `(environmentId, projectId)`, plus their setters alongside PHASE-03's existing action set, and add both to the sanitiser. Persisted key stays `bibcode:git-manager-state:v1`. PHASE-03's note requires a new field to be requested through `tasks.md` before it is added, and **PHASE-15 shares this round and also edits this file** — coordinate both before editing. Extend PHASE-03's existing store test.

- [ ] **Step 16.13: Full build + test gate.**

	```bash
	vp test run apps/web/src/components/gitManager/tags apps/web/src/components/gitManager/diff apps/web/src/components/gitManager/provider apps/web/src/gitManagerStore.test.ts
	vp run typecheck
	vp check
	vp run check:contracts
	```

	Expected: zero warnings, zero errors, all tests green. Run `vp run check:contracts` whether or not Step 16.2 changed a contract — it also re-verifies deterministic fixture export.

- [ ] **Step 16.14: Exercise the surfaces in the running app.**

	`vp run dev`, and verify against **both** a local project and a remote-hosted project (attach one per `docs/user/remote-access.md`): creating, deleting and pushing a tag works and the tag appears in the refs snapshot; an image file changed in a commit renders in all four modes; the pull-request pane loads only when Refresh is pressed. With the panel open and idle for several minutes, confirm from the server log that no provider process was spawned.

- [ ] **Step 16.15: TDD proof.** Make `validateTagName` always return valid and the checks reader return an empty list unconditionally. Re-run the Step 16.8 and Step 16.13 filters and confirm the affected tests DO fail. Restore the real implementations.

- [ ] **Step 16.16: Mark phase complete.** Change Phase 16 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry under your Detailed Progress section: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] Tag create, delete, list and push produce exactly the four command lines in Step 16.4, asserted argv for argv by recording-runner tests.
- [ ] The image blob round-trips byte-identically; a `git show` of a PNG is not corrupted by the lossy string path, and an over-budget image returns a structured result rather than a truncated one.
- [ ] Image sides render from `data:` URIs only. `rg -n 'src=\{?"https?://' apps/web/src/components/gitManager` returns nothing, and no `fetch`/`XMLHttpRequest`/`new Image()` call to a remote host exists under `apps/web/src/components/gitManager`.
- [ ] The provider pane issues zero requests on mount and zero on any timer; the test that advances fake timers by an hour proves it.
- [ ] No new periodic task exists: `rg -n "interval|sleep_until|spawn.*loop" apps/server/src/source_control/checks.rs` returns nothing, and `apps/server/tests/git_rpc.rs`'s existing source-text tripwire still passes.
- [ ] Provider calls go through the existing `PullRequestService` / `ProviderCommandSpec` / `run_provider_os` seam; there is no second provider process path.
- [ ] `cargo fmt --all --check` clean; `cargo test -p bibcode-server` green; `cargo clippy -p bibcode-server --all-targets -- -D warnings` clean.
- [ ] `vp check` clean, `vp run typecheck` clean, `vp run check:contracts` clean with both hard-coded count sites bumped if a contract changed.
- [ ] Validated end to end against **both** a local project and a remote-hosted project.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counter, remote feature flag, avatar or identity fetch, third-party host contact, or new dependency. Confirm `git diff apps/web/package.json apps/server/Cargo.toml Cargo.lock` is empty; the only outbound traffic this phase can produce is a `git push` to a configured remote and a `gh`/`glab`/`az` invocation inside an explicit user action.
- [ ] Final `git diff` and `git status --short` review for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **PHASE-17 verifies this phase's constraint directly.** The zero-telemetry test it lands asserts (a) no host other than a configured remote or the configured provider CLI is contacted, (b) no background timer issues a provider call, and (c) no dependency was added. The concrete hooks it uses are: `GitManagerPullRequestPanel`'s "not loaded until Refresh" state, `apps/server/src/source_control/checks.rs` having no timer, and this phase leaving `apps/web/package.json` / `apps/server/Cargo.toml` untouched. Do not weaken any of the three.
- **PHASE-15 shares this round.** This phase owns `apps/web/src/components/gitManager/tags/**`, `.../diff/**`, `.../provider/**`, the image branch of `.../history/diffLadder.ts`, the tags-to-push contribution in `.../toolbar/syncButton.logic.ts`, and the store fields `imageDiffMode` / `providerPaneOpen`. PHASE-15 owns `.../rewrite/**` and `multiCommitSelection`. The only genuinely shared files are `apps/web/src/gitManagerStore.ts` and `apps/web/src/components/gitManager/history/GitManagerCommitList.tsx` — coordinate both edits through `tasks.md` before starting. Tag menu entries are emitted by PHASE-15's `buildCommitMenuItems` in `apps/web/src/components/gitManager/rewrite/GitManagerCommitContextMenu.logic.ts`; this phase supplies the `onSelect` handlers and must not fork that builder.
- Exported contracts other phases rely on: `validateTagName(name, existingTags)`, `resolveTagDeleteDialogCopy(tag)`, `GitManagerImageDiff` with props `{ before: string | null; after: string | null; mode: GitManagerImageDiffMode; onModeChange: (mode: GitManagerImageDiffMode) => void }`, and `GitManagerPullRequestPanel` with props `{ scope: { environmentId: EnvironmentId; cwd: string }; onRefresh: () => void }`. Pass stable memoized callbacks.
- This phase uses the diff cache scope string `"git-manager-image"` with `getRenderablePatch`; PHASE-12 uses `"git-manager-stash"` and PHASE-14 uses `"git-manager-staging"`.
- **Divergences found, already handled here:**
  1. `apps/server/src/git/process.rs` loses binary fidelity (its `render` helper string-converts the supervised layer's `Vec<u8>`), so a byte-preserving path is required for image blobs — the plan did not anticipate this.
  2. There is no checks/CI support anywhere in the server today: `statusCheckRollup`, `checkRuns`, `checkSuite` and `ci_status` appear nowhere, and neither `ResolvedPullRequest` nor `VcsSummaryChangeRequest` carries a checks field. Checks are entirely new.
  3. The only pre-existing periodic provider call is `apps/server/src/git/summary.rs`'s 30-second subscriber-scoped cycle. It is not this feature's, must not be extended, and PHASE-17's telemetry test must scope around it explicitly.
