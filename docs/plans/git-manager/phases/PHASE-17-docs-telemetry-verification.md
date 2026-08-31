# Git Manager / Phase 17 — Living documentation, telemetry test, full verification

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Close the feature by bringing every living document in line with what shipped, landing the executable zero-telemetry test, and running the full verification matrix against a local and a remote-hosted project.

**Architecture:** This is the final, sequential phase. Its only production code is the zero-telemetry test suite — the spec's constraint 4 and § 9 made executable in three places: a static source-and-manifest scan in `scripts/privacy-contract.test.ts` (which already owns a `zero-telemetry privacy contract` describe block), a web runtime test that denies all network and advances timers, and a Rust unit test that inspects every process the Git Manager spawns. Everything else is documentation under `docs/architecture/`, `docs/user/`, `docs/integrations/` and `docs/testing/`, plus the end-to-end verification runs. Because it is not code-heavy, its atomic steps are domain-appropriate rather than TDD — **except** Steps 17.7–17.12, which are real code and follow the red-green shape.

**Tech Stack:** Markdown living documentation across `docs/`, plus TypeScript / Vite+ tests (`vp test run <path>`, imports from `vite-plus/test`) and Rust 2021 inline `#[cfg(test)]` tests in `apps/server`. Gates: `vp check`, `vp run typecheck`, `vp run check:contracts`, `cargo fmt --all --check`, `cargo test -p bibcode-server`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`.

---

## Files

- **Modify:** `docs/architecture/rpc-and-orchestration.md` — the Git Manager operation flow, the broadcaster's refs/HEAD/worktree signature, the new invariants
- **Modify:** `docs/architecture/overview.md` — § Components (the `git/manager` module) and § Boundaries and invariants
- **Modify:** `docs/architecture/worktree-catalog.md` — the repository mutation lock now also serialises Git Manager operations
- **Modify:** `docs/architecture/connection-runtime.md` — the new default-false capability flags and their degradation behaviour
- **Modify:** `docs/user/workspace-ui.md` — a Git Manager section, and the § Source Control paragraph that currently says stash and amend are absent
- **Modify:** `docs/user/keybindings.md` — the panel's commands in § Available Commands
- **Modify:** `docs/integrations/source-control-providers.md` — the capability matrix row for checks, and the on-demand refresh rule
- **Modify:** `docs/testing/cross-platform-validation.md` — § VCS coordination gates and § Packaged visual validation
- **Modify:** `docs/testing/execution-report-template.md` — the evidence rows a Git Manager run must record
- **Reviewed only:** `docs/superpowers/plans/2026-08-18-git-manager/master-plan.md` and `.../tasks.md` — both already carry the superseded pointer to `docs/plans/git-manager/`; confirm it still reads true against what shipped
- **Modify:** `scripts/privacy-contract.test.ts` — Git Manager cases in the existing `zero-telemetry privacy contract` describe block
- **Create:** `apps/web/src/components/gitManager/gitManagerTelemetry.test.tsx` — the web runtime network-denial test
- **Modify:** `apps/server/src/git/manager/mod.rs` — an inline `#[cfg(test)] mod telemetry` asserting the spawned-process surface
- **Modify:** `apps/server/tests/git_rpc.rs` — a source-text tripwire for Git Manager polling and third-party hosts
- **Reviewed only (state the outcome, change only if the review finds drift):** `docs/README.md`, `docs/testing/README.md`, `docs/testing/windows-desktop.md`, `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/reference/scripts.md`, `docs/reference/workspace-layout.md`, `docs/reference/encyclopedia.md`, `docs/architecture/remote.md`, `docs/user/remote-access.md`

## Dependencies

- Phases 00–16: every preceding phase must be `completed`

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
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the zero-telemetry test, the one real code deliverable here
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="superpowers:requesting-code-review")` — *this closes the slice; the whole feature needs a review pass*
6. `Skill(skill="code-review")` — *the final `git diff` sweep across sixteen phases of accumulated change*

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules; § Testing Runbook Maintenance governs this phase directly
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 2 constraint 4 and § 9 are what the telemetry test makes executable; § 11 supersession
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; § Validation and § Documentation to update are this phase's checklist
- `docs/README.md` — the documentation index that decides which living documents own what
- `docs/architecture/overview.md`, `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/worktree-catalog.md`, `docs/architecture/connection-runtime.md` — the four architecture documents this feature touches
- `docs/testing/README.md` and `docs/testing/cross-platform-validation.md` — the runbook contract and the shared procedure
- `docs/user/remote-access.md` — how to attach the remote-hosted environment used for end-to-end verification
- `scripts/privacy-contract.test.ts` — the existing zero-telemetry contract test this phase extends
- `docs/reference/scripts.md` — the exact commands used below

---

## Pre-execution check

- [ ] **Step 17.0: Claim the phase.** Open `../tasks.md`. Change Phase 17 row → `Status = in_progress`, `Agent = phase-17` (or your subagent name), `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 17.1: Inventory what actually shipped.** Read `../tasks.md` end to end, then `git diff --stat` against the branch point. List every new RPC method, capability flag, persisted key, server module, web directory and store field that phases 00–16 landed. Note every deviation those phases recorded. This list, not the plan, is what the documentation must describe.

- [ ] **Step 17.2: Update `docs/architecture/rpc-and-orchestration.md`.** Add a Git Manager section describing: the `gitManager.*` method set and their scopes; the single streaming operation RPC and its `started` / `output` / `finished` / `failed` events; the serialisation rule (the worktree catalog's existing project-then-repository lock, `operation-in-flight` rejection, no second lock); server-authored blocked reasons rendered verbatim by the client; and tip-pinned history paging with generation splicing. Extend the existing § VCS status and mutation coordination with the broadcaster's refs/HEAD/worktree signature added by PHASE-09, and add the new invariants to § Invariants.

- [ ] **Step 17.3: Update `docs/architecture/overview.md`, `worktree-catalog.md` and `connection-runtime.md`.** In `overview.md` § Components, name the `apps/server/src/git/manager/` module and what it owns; in § Boundaries and invariants add: the Git Manager performs no repository lifecycle, force push is always `--force-with-lease`, and `--ignore-other-worktrees` / `git worktree add -f` / plumbing `update-ref` are forbidden. In `worktree-catalog.md`, record that the repository mutation lock now also serialises Git Manager operations, in the same acquisition order. In `connection-runtime.md`, add the new default-false capability flags and describe the feature-by-feature degradation an older server produces.

- [ ] **Step 17.4: Update `docs/user/workspace-ui.md`, `docs/user/keybindings.md` and `docs/integrations/source-control-providers.md`.** Add a Git Manager section to `workspace-ui.md` covering the entry-point button, the route, the three toolbar segments, the Changes and History tabs, stash, conflicts, and the view-state cache. **Correct the § Source Control paragraph that currently ends "Stash and amend are intentionally not present"** — that remains true of the right-panel surface but is now misleading beside a panel that has both; qualify it explicitly. Review § Current limitations and update it. Add the panel's commands to `keybindings.md` § Available Commands. In `source-control-providers.md`, add a checks row to the capability matrix with its real per-provider availability, and state that the Git Manager's pull-request and check data refresh only on explicit user action, never on a timer.

- [ ] **Step 17.5: Update the runbooks under `docs/testing/`, per AGENTS.md § Testing Runbook Maintenance.** In `cross-platform-validation.md`: extend § VCS coordination gates' focused-test list with the Git Manager test files that now own this behaviour, and extend § Packaged visual validation's bullet list with the Git Manager flows a packaged run must screenshot (panel open from the sidebar, worktree selector, changes list with partial staging gutter, history with a commit diff, branch dropdown, sync states, stash list, a conflict state). In `execution-report-template.md`, add the evidence rows a Git Manager run must record. Then **review** `docs/testing/README.md`, `windows-desktop.md`, `linux-desktop.md` and `macos-desktop.md` against what shipped; change them only where they drifted, and record explicitly in the final report which of them were **reviewed and remain accurate**. Keep execution-specific values — SHAs, versions, test counts, timings, screenshots, machine paths — out of the runbooks; they belong in a report created from the template.

- [ ] **Step 17.6: Confirm the supersession pointer.** Per `git-manager-spec.md` § 11 and the plan's § Documentation to update, `docs/superpowers/plans/2026-08-18-git-manager/master-plan.md` and `.../tasks.md` already carry a "SUPERSEDED (2026-08-31)" note pointing at `docs/plans/git-manager/`. Re-read both and confirm the note still describes what shipped — in particular its list of carried-forward findings (tip-pinned paging, the broadcaster generation signal, reuse of the worktree catalog's repository lock, the server-authored guard module, the wire-fixture count gate). Correct it only if the feature diverged. Do not delete the historical folder.

- [ ] **Step 17.7: Author the first failing telemetry test — the static contract.**

	Path: `scripts/privacy-contract.test.ts`, inside the existing `describe("zero-telemetry privacy contract", …)` block.

	Add `it("adds no dependency for the Git Manager", …)` asserting that the dependency **name** lists of `apps/web/package.json` (`dependencies` + `devDependencies`) and of `apps/server/Cargo.toml` (`[dependencies]` keys) match an inline expected array. This makes any future addition a visible, deliberate test edit rather than a silent drift — which is exactly what spec constraint 6 and § 9's last bullet require. Write the expected arrays deliberately wrong first so the test fails.

- [ ] **Step 17.8: Run it; expect FAIL, then correct the expected arrays and re-run to PASS.**

	```bash
	vp test run scripts/privacy-contract.test.ts
	```

- [ ] **Step 17.9: Add the static host-scan case, red first.**

	In the same describe block, add `it("contacts no third-party host from Git Manager code", …)`: scan every file under `apps/web/src/components/gitManager`, `apps/web/src/gitManagerStore.ts`, `packages/client-runtime/src/state/gitManager.ts`, `apps/server/src/git/manager` and `apps/server/src/source_control/checks.rs` and assert none contains an absolute `http://` or `https://` URL literal, `sendBeacon`, `navigator.connection`, `gravatar`, `avatars.githubusercontent.com`, or an `import` of a network client. Reuse the file's existing `sourceFiles` walker and the `telemetryViolations` shape rather than writing a second walker. Prove red by temporarily adding a URL literal to one of those files, then remove it.

- [ ] **Step 17.10: Add the web runtime test, red first.**

	Path: `apps/web/src/components/gitManager/gitManagerTelemetry.test.tsx`, with `// @vitest-environment happy-dom` as line 1.

	**Build the harness in-file:** `msw` 2.15.0 is a devDependency of `apps/web` but is used by no test today and there is no global setup file, so nothing exists to extend. Use `setupServer` from `msw/node` with `onUnhandledRequest: "error"` in `beforeAll`, `server.resetHandlers()` in `afterEach`, `server.close()` in `afterAll`, and register **zero** handlers — any request at all is therefore a failure. Additionally `vi.stubGlobal("fetch", …)` with a function that throws, and stub `Image`, `WebSocket` and `XMLHttpRequest` the same way, so a request made outside msw's interception still fails loudly.

	Then assert, in order:
	1. Rendering the Git Manager panel with the environment atoms stubbed issues no request and constructs no `Image`.
	2. `vi.useFakeTimers()` plus `await vi.advanceTimersByTimeAsync(60 * 60 * 1000)` issues no provider request and no third-party request — this is the "no background timer issues provider calls" clause of spec § 9 made executable.
	3. Pressing Refresh on `GitManagerPullRequestPanel` dispatches exactly one provider command through the environment-scoped atom, and no direct network call.
	4. Every rendered author identity is local — an identicon or initials derived from the commit email — and no `img` has an `http`/`https` `src`.

	Prove red by temporarily adding a `useEffect(() => { void fetch("https://example.invalid"); }, [])` to the panel, then remove it.

- [ ] **Step 17.11: Add the Rust runtime test, red first.**

	Path: `apps/server/src/git/manager/mod.rs`, inline `#[cfg(test)] mod telemetry`.

	It must be **inline**, not an integration test in `apps/server/tests/`: the injection seam `GitProcessRunner` is `pub(crate)` (`apps/server/src/git/repository.rs`, indicative :60) and is not reachable from an integration target. Use `GitRepository::with_runner_for_test(Arc<dyn GitProcessRunner>)` (indicative :260) with a recording runner in the style of `RecordingGitRunner` (indicative :5035) that captures every `ProcessRequest`. Then assert:
	1. Driving each Git Manager read and each operation records only requests whose `command` is `git`.
	2. Every recorded request carries the non-interactive environment — `GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`, `SSH_ASKPASS_REQUIRE=never`, `GIT_CONFIG_NOSYSTEM=1` — and every read additionally carries `GIT_OPTIONAL_LOCKS=0`.
	3. Constructing the services and then letting the runtime idle records **zero** requests: no Git Manager code path starts a timer. Scope this assertion to the Git Manager surface and state in a comment that `apps/server/src/git/summary.rs`'s 30-second subscriber-scoped cycle (`SUMMARY_FRESHNESS`, indicative :20) and `apps/server/src/git/fetch_owner.rs`'s automatic fetch predate this feature, are git-only or provider-on-subscription, and are deliberately out of scope.
	4. The only non-`git` process the feature can spawn is the provider CLI, and only from inside the explicit pull-request/checks handler — assert it by driving that handler and nothing else.

	Prove red by temporarily changing one Git Manager command to spawn a different program, then restore it.

- [ ] **Step 17.12: Add the Rust source-text tripwire, red first.**

	In `apps/server/tests/git_rpc.rs`, add a test in the style of the existing `production_vcs_observation_has_no_periodic_ref_worker` (indicative :36): `include_str!` the Git Manager modules and `apps/server/src/source_control/checks.rs`, truncate each at its `\nmod tests {` boundary, and assert the production halves contain none of `"interval("`, `"sleep_until"`, `"tokio::spawn"` paired with a loop, `"https://"`, or `"reqwest"`. This catches a reintroduced poller in review even when the runtime test is skipped.

- [ ] **Step 17.13: Run every gate.**

	```bash
	vp run check:contracts
	vp check
	vp run typecheck
	vp test run scripts/privacy-contract.test.ts apps/web/src/components/gitManager
	vp run test
	cargo fmt --all --check
	cargo test -p bibcode-server
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	```

	Static lint evidence must be freshly derived rather than replayed from the Cargo cache, per `docs/testing/README.md`:

	```bash
	cargo clean -p bibcode-server -p bibcode-desktop -p bibcode-updater-verifier
	cargo clippy --workspace --all-targets -- -D warnings
	```

	Record every command that could not run and why.

- [ ] **Step 17.14: End-to-end verification against a LOCAL project.**

	`vp run dev`, open a local project's Git Manager, and exercise one read, one mutation and one provider action on every surface: the changes list and a per-file diff; staging a partial line selection and committing; creating, checking out, renaming and deleting a branch; fetch, pull and push; stash apply and drop; a merge with a mergeability preview; a rebase that conflicts, resolved with theirs and continued; a cherry-pick by drag; a revert; a reset behind its confirmation; a tag created and pushed; an image diff in all four modes; and the pull-request pane refreshed once by hand. Confirm the occupied-branch redirect switches the panel to the owning worktree and says why. Record the evidence in a report created from `docs/testing/execution-report-template.md`.

- [ ] **Step 17.15: End-to-end verification against a REMOTE-HOSTED project.**

	Attach a remote environment per `docs/user/remote-access.md` and repeat Step 17.14 against a project owned by it. Additionally verify: the panel never resolves a path client-side and treats `workspaceRoot` as opaque; disconnecting the environment renders the explicit unavailable state naming the reason and does **not** re-dial it; reconnecting re-attaches the status and operation subscriptions transparently; and a server that lacks a capability degrades that one surface rather than erroring the panel. This is the feature's main environmental risk (`git-manager-plan.md` § Risks) and both runs are required.

- [ ] **Step 17.16: Final review sweep.** Run `git diff` and `git status --short` across the whole feature and check for unintended edits, generated files, debug output, dependency drift, `.codegraph/` data, and any living document left behind. Invoke `superpowers:requesting-code-review` for the accumulated change.

- [ ] **Step 17.17: Mark phase complete.** Change Phase 17 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry: the documents updated, the documents reviewed and unchanged, the tests landed, the commands that could not run, and the residual risk.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] `docs/architecture/rpc-and-orchestration.md`, `overview.md`, `worktree-catalog.md` and `connection-runtime.md` describe the shipped protocol flow, lock reuse, capability gating and invariants — with no statement that the code contradicts.
- [ ] `docs/user/workspace-ui.md` documents the panel, and its § Source Control "stash and amend are intentionally not present" paragraph is corrected so it can no longer be read as describing the whole product.
- [ ] `docs/integrations/source-control-providers.md` states the checks availability per provider and the on-demand-only refresh rule.
- [ ] `docs/testing/cross-platform-validation.md` § VCS coordination gates and § Packaged visual validation list the Git Manager tests and flows; `docs/testing/execution-report-template.md` carries the new evidence rows.
- [ ] `docs/testing/README.md`, `windows-desktop.md`, `linux-desktop.md` and `macos-desktop.md` are each either updated or explicitly recorded in the final report as **reviewed and remain accurate**.
- [ ] The zero-telemetry test exists in all three places — `scripts/privacy-contract.test.ts`, `apps/web/src/components/gitManager/gitManagerTelemetry.test.tsx`, `apps/server/src/git/manager/mod.rs` `#[cfg(test)] mod telemetry` — plus the source-text tripwire in `apps/server/tests/git_rpc.rs`, and each was proven red before it was made green.
- [ ] The telemetry test asserts all three clauses of spec § 9: no host other than a configured git remote or the configured provider CLI is contacted; no background timer issues a provider call; and the feature added no dependency.
- [ ] `vp run check:contracts` clean; `vp check` clean; `vp run typecheck` clean; `vp run test` green.
- [ ] `cargo fmt --all --check` clean; `cargo test -p bibcode-server` green; freshly re-derived `cargo clippy --workspace --all-targets -- -D warnings` clean.
- [ ] End-to-end verification completed against **both** a local project and a remote-hosted project, with evidence recorded in a report created from `docs/testing/execution-report-template.md`.
- [ ] Final `git diff` and `git status --short` review for unintended edits, generated files, debug output, dependency drift and missing documentation.
- [ ] TDD-proof performed for Steps 17.7–17.12 and described in the per-phase notes; the documentation steps are verified by review against source rather than by mutation.

## Notes for downstream phases

- This is the last phase; nothing follows it. What follows is the user's decision to commit, which no phase makes.
- **Divergences found while writing this phase, which its steps already account for:**
  1. `scripts/privacy-contract.test.ts` **already exists** and already owns a `describe("zero-telemetry privacy contract")` block with a forbidden-marker source scan, a dedicated-telemetry-module absence check, and third-party-telemetry-off assertions. The Git Manager cases extend it; they do not create a new contract file.
  2. `msw` 2.15.0 is a devDependency of `apps/web` but **no test uses it**, `apps/web/public/mockServiceWorker.js` is a leftover artifact, and there is **no global test setup file** anywhere in the repository. The web telemetry harness must therefore be built in-file.
  3. No test in this repository asserts the *absence* of network calls today. `onUnhandledRequest` appears nowhere; `vi.stubGlobal("fetch", …)` is used only to return canned responses. This phase introduces the pattern.
  4. The `GitProcessRunner` injection seam is `pub(crate)`, so the Rust runtime telemetry test must be an inline `#[cfg(test)]` unit test, not an integration test under `apps/server/tests/`.
  5. `apps/server/src/maintenance.rs` has no read-only allowlist constant; mutability is derived from `ACTIVE_RPC_METHODS` in `apps/server/src/rpc/methods.rs` and an unlisted method fails safe as a mutation.
  6. Two pre-existing periodic workers must be named and excluded by scope in the telemetry test rather than being flagged: `apps/server/src/git/summary.rs`'s 30-second subscriber-scoped provider enrichment and `apps/server/src/git/fetch_owner.rs`'s automatic git fetch. Neither belongs to this feature.
