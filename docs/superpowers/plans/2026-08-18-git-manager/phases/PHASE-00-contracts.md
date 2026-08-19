# Git Manager / Phase 00 — Wire contracts for the whole feature

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Land every Effect Schema and RPC declaration the Git Manager needs, in one pass, so no later phase has to edit `packages/contracts/src/rpc.ts` again.

**Architecture:** Implements § "Phase 1 — Contracts and server reads" and the contract blocks of Phases 4, 5 and 7 of `../master-plan.md`. New schemas live in a new schema-only module `packages/contracts/src/gitGraph.ts` (the existing `git.ts` is already 512 lines and is shared by unrelated callers); `rpc.ts` gains the six method names, their `Rpc.make` declarations, and their group membership. No runtime logic — `packages/contracts` is schema-only.

**Tech Stack:** TypeScript + `effect/Schema`. Test: `vp test packages/contracts/src/gitGraph.test.ts`. Gates: `vp check`, `vp run typecheck`. Coding rules: root `AGENTS.md`; Effect idioms from `.repos/effect-smol/LLMS.md`.

---

## Files

- **Create:** `packages/contracts/src/gitGraph.ts` — every new Git Manager schema.
- **Create:** `packages/contracts/src/gitGraph.test.ts` — schema decode/encode tests.
- **Modify:** `packages/contracts/src/index.ts` — export the new module.
- **Modify:** `packages/contracts/src/rpc.ts` — `WS_METHODS` entries, `Rpc.make` declarations, group membership.
- **Modify:** `packages/contracts/scripts/export-rust-rpc-fixtures.ts` — bump the hardcoded method/stream/fixture-count guards (lines ~707-731).
- **Modify (regenerated, do not hand-edit):** `packages/contracts/fixtures/rpc-wire/manifest.json` and the fixture files the export script writes — the checked-in wire fixtures that `rpcRustParity.test.ts` asserts against.

## Dependencies

None. This is the foundation phase.

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium (wide surface; every later phase compiles against these types). Effort: ~2 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the schema tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="ponytail:ponytail")` — keep the schema surface minimal, no speculative fields

> No Effect/Schema-specific skill exists in the current inventory; `.repos/effect-smol/LLMS.md` is the substitute and is listed below as required reading.

## Documents to Read

- `../master-plan.md` — § Global Constraints, § Technical Requirements → Contracts, and the Phase 1/4/7 interface blocks (the authoritative schema listings this phase transcribes).
- `../issue.specs` — the spec, including `## Interview Notes`.
- `AGENTS.md` (repo root) — architectural decision standards; note "keep `packages/contracts` schema-only".
- `.repos/effect-smol/LLMS.md` — required by `AGENTS.md` before writing Effect code.
- `packages/contracts/src/git.ts` — existing Git schemas; reuse `TrimmedNonEmptyString`, `NonNegativeInt`, `PositiveInt`, `VcsWorkingTreeFileStatus`, `GitActionProgressStream`, `GitCommandError`.
- `packages/contracts/src/rpc.ts` — `WS_METHODS`, the `Rpc.make` pattern (see `WsVcsListRefsRpc`, line ~764), and the exported group at the bottom.
- `packages/contracts/src/git.test.ts` — the schema-test pattern to mirror.
- `packages/contracts/src/rpcRustParity.test.ts` (line ~359) — the test that asserts the checked-in wire manifest matches the live RPC group. **Read this before you add a single method**: it is why Step 00.14 exists.
- `packages/contracts/scripts/export-rust-rpc-fixtures.ts` (lines ~707-731) — the regeneration script and its hardcoded count guards.

---

## Pre-execution check

- [ ] **Step 00.0: Claim the phase.** Open `../tasks.md`. Set Phase 00 → `Status = in_progress`, `Agent = phase-00`, `Started = YYYY-MM-DD HH:MM`. Append `- YYYY-MM-DD HH:MM — picked up` under Detailed Progress → Phase 00.

## Atomic steps

- [ ] **Step 00.1: Read the existing surface.** Open `packages/contracts/src/git.ts` and `rpc.ts`. Confirm the exact spelling of the shared base schemas (`TrimmedNonEmptyString`, `NonNegativeInt`, `PositiveInt`) and of the error union used by VCS methods (`GitCommandError`, `WorkspaceUnavailableError`, `WorkspaceIdentityError`, `EnvironmentAuthorizationError`). Note any deviation from what `../master-plan.md` assumed in `../tasks.md` § Detailed Progress.

- [ ] **Step 00.2: Author the first failing test.** Path `packages/contracts/src/gitGraph.test.ts`:

	```ts
	import { describe, expect, it } from "vite-plus/test";
	import * as Schema from "effect/Schema";
	import { VcsGraphCommit } from "./gitGraph.ts";

	describe("VcsGraphCommit", () => {
	  it("decodes a merge commit with two parents and a ref badge", () => {
	    const decoded = Schema.decodeUnknownSync(VcsGraphCommit)({
	      sha: "9569e81eda5009c6aeb7a7b004bf678852d0ceba",
	      shortSha: "9569e81",
	      parents: ["0ecd0de1111111111111111111111111111111111", "b58fe80222222222222222222222222222222222"],
	      refs: [{ name: "develop", kind: "local-branch" }],
	      subject: "Merge branch 'feature' into develop",
	      authorName: "mubeda",
	      authorEmail: "mauro.ubeda@example.invalid",
	      authoredAtMs: 1_780_000_000_000,
	      committedAtMs: 1_780_000_000_000,
	    });
	    expect(decoded.parents).toHaveLength(2);
	    expect(decoded.refs[0]?.kind).toBe("local-branch");
	  });
	});
	```

- [ ] **Step 00.3: Run it; expect FAIL** — `Cannot find module './gitGraph.ts'`.

	```bash
	vp test packages/contracts/src/gitGraph.test.ts
	```

- [ ] **Step 00.4: Create `gitGraph.ts` with the minimum** — `VcsGraphRefKind`, `VcsGraphRefBadge`, `VcsGraphCommit` only. Copy the field lists verbatim from `../master-plan.md` § Phase 1 "Interfaces produced".

- [ ] **Step 00.5: Run the test; expect PASS.**

- [ ] **Step 00.6: Add the graph paging schemas + tests** — `VcsListCommitGraphInput` (with the `limit ≤ 1000` check **and** the optional `tips` array capped at 500) and `VcsListCommitGraphResult` (with `tips` and `tipsPinned`). The tip snapshot is what keeps `--skip` offsets valid while the repository moves; copy the field comments from `../master-plan.md` § Phase 1 so the intent travels with the schema. Tests: `limit: 1001` rejected, `limit: 1000` accepted, a 501-entry `tips` array rejected, and a result with `tipsPinned: false` plus an empty `tips` array (the over-cap fallback) decodes.

- [ ] **Step 00.7: Add the refs snapshot schemas + tests** — `VcsGraphOperationKind`, `VcsGraphBlockedCode`, `VcsGraphBlockedReason`, `VcsGraphBranch`, `VcsGraphRemoteBranch`, `VcsGraphTag`, `VcsGraphWorktree`, `VcsGraphRunningOperation`, `VcsGraphRefsInput`, `VcsGraphRefsResult`. The result MUST include `mergeInProgress: Schema.Boolean` and `conflictedPaths` — a pending merge has to be observable from state after a reconnect. Tests: a branch carrying a `worktree-checked-out` blocked reason round-trips; a snapshot with `mergeInProgress: true` plus two conflicted paths decodes; and a snapshot **missing** `mergeInProgress` is rejected (the field is required — a pending merge must never be silently absent).

- [ ] **Step 00.8: Add the commit-detail and commit-diff schemas + tests** — `VcsCommitFileChange`, `VcsCommitDetailInput`, `VcsCommitDetailResult`, `VcsCommitDiffInput`, `VcsCommitDiffResult`. Test that `baseRef: null` (root commit) decodes.

- [ ] **Step 00.9: Add the operation union + event union + tests** — `GitRepositoryOperation` (11 tags: `fetch`, `pull`, `push`, `merge`, `resolveMergeConflict`, `createBranch`, `checkout`, `createTag`, `deleteBranch`, `renameBranch`, `deleteTag`), `GitRunRepositoryOperationInput`, `GitRepositoryOperationFailureCode`, `GitRepositoryOperationEvent` (5 tags). Test: each operation tag decodes; an unknown `_tag` is rejected; a `failed` event with code `authentication` decodes.

- [ ] **Step 00.10: Add the graph change event + input** — `VcsGraphChangedEvent` (`{ generation: NonNegativeInt, changedAtMs: NonNegativeInt }`) and `SubscribeVcsGraphInput` (`{ cwd }`), for the Phase 07 stream. Test the round-trip.

- [ ] **Step 00.11: Export from `index.ts`** — add `export * from "./gitGraph.ts";` next to the existing `export * from "./git.ts";`.

- [ ] **Step 00.12: Register all six methods in `rpc.ts`.** Add to `WS_METHODS` under a `// Git manager methods` comment:

	```ts
	  vcsListCommitGraph: "vcs.listCommitGraph",
	  vcsGraphRefs: "vcs.graphRefs",
	  vcsCommitDetail: "vcs.commitDetail",
	  vcsCommitDiff: "vcs.commitDiff",
	  gitRunRepositoryOperation: "git.runRepositoryOperation",
	  subscribeVcsGraph: "subscribeVcsGraph",
	```

	Then one `Rpc.make` per method following the `WsVcsListRefsRpc` shape, with the same four-member error union. `git.runRepositoryOperation` and `subscribeVcsGraph` are **streaming** — copy the stream declaration shape from the existing `git.runStackedAction` / `subscribeVcsStatus` RPCs rather than inventing one. Add all six to the exported group at the bottom of the file.

- [ ] **Step 00.13: Add an rpc-level test** asserting each of the six names is present in `WS_METHODS` and that the group contains six more entries than before.

- [ ] **Step 00.14: Regenerate the wire fixtures — this phase fails its own gate without it.** `packages/contracts/src/rpcRustParity.test.ts:359` asserts `manifest.methods` equals the list derived from the live RPC group, and `packages/contracts/fixtures/rpc-wire/manifest.json` currently pins 95 methods. Adding six methods (two streaming) invalidates it.

	First bump the hardcoded guards in `packages/contracts/scripts/export-rust-rpc-fixtures.ts` (lines ~707-731), which throw before writing anything:

	```
	if (methods.length !== 95)                 →  101
	if (streamMethodCount !== 16)              →  18
	if (typedFailureFixtures.length !== 224)   →  the new count
	if (orchestrationEventShapeCount !== 23)   →  unchanged (this feature adds no orchestration events)
	expectedStale = ["projects.add", "projects.list", "projects.remove"]  →  unchanged
	```

	Do not guess the typed-failure count: run the script, read the actual number from the thrown message, set it, and re-run. The other two counts follow directly from the six methods you added (four unary + two streaming). Then run the export script the way the repo runs it (check `packages/contracts/package.json` for the script name) and let it rewrite `manifest.json` and the fixture files. **Never hand-edit a generated fixture.**

	If the script's own test (`export-rust-rpc-fixtures.test.ts`) encodes any of these numbers too, update it in the same step.

- [ ] **Step 00.15: Full gate.**

	```bash
	vp test packages/contracts
	vp run typecheck
	vp check
	```

	Expected: all green — including `rpcRustParity.test.ts`, which is the test that proves Step 00.14 landed. Zero lint errors.

- [ ] **Step 00.16: TDD proof.** Temporarily change `VcsGraphRefsResult.mergeInProgress` to `Schema.optional(Schema.Boolean)` and re-run the Step 00.7 tests — the "missing `mergeInProgress` is rejected" test must fail while the round-trip test still passes. Restore, re-run, confirm green. Describe the mutation in your progress notes.

- [ ] **Step 00.17: Mark complete.** Set the Phase 00 row → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`, and append a summary (schemas added, test count, deviations).

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] `packages/contracts/src/gitGraph.ts` exports every schema named in `../master-plan.md` Phases 1, 4, 5 and 7, with no extra speculative fields.
- [ ] All six methods appear in `WS_METHODS`, have an `Rpc.make` declaration, and are members of the exported group.
- [ ] The wire fixtures were **regenerated by the script** (never hand-edited), the hardcoded counts in `export-rust-rpc-fixtures.ts` were bumped to match, and `rpcRustParity.test.ts` passes.
- [ ] `vp test packages/contracts` green; `vp run typecheck` clean; `vp check` clean.
- [ ] No runtime logic added to `packages/contracts` (schemas and types only).
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 01 implements handlers for `vcs.listCommitGraph`, `vcs.graphRefs`, `vcs.commitDetail`, `vcs.commitDiff`; Phase 04 for `git.runRepositoryOperation`; Phase 07 for `subscribeVcsGraph`. Declaring all six here is safe: the TypeScript contracts and the Rust `ACTIVE_RPC_METHODS` list are independent, and no test asserts parity between them (verified at decomposition time). A method declared here but not yet registered server-side simply has no handler — and nothing calls it until its phase lands. The rule that *does* bite: a name added to `ACTIVE_RPC_METHODS` must get exactly one scope in `apps/server/src/auth/scope.rs` in the **same** phase, or the server scope test fails.
- Record the new fixture counts (methods, streams, typed failures) in your completion notes. If any later phase adds or renames a method, it must repeat Step 00.14 — the fixtures are checked in and the parity test is unforgiving.
- Field names are frozen after this phase. If a later phase needs a new field, it must be raised in `../tasks.md` § Coordination Notes rather than edited silently — every web and server phase compiles against these types.
- Web phases import from `@bibcode/contracts` (the barrel), not from the file path.
