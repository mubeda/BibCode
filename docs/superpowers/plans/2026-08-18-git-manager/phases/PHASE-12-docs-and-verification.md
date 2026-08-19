# Git Manager / Phase 12 — Living documentation and full verification

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Land the living documentation the feature changes require and prove the whole feature passes every repository gate end to end.

**Architecture:** Implements the documentation half of § "Phase 7" and the § Validation & Testing / § Success Criteria sections of `../master-plan.md`. `AGENTS.md` requires living architecture docs and testing runbooks to change in the same work as the behavior; the prior phases each shipped code, so this phase closes the documentation and whole-feature verification obligation in one pass.

**Tech Stack:** Markdown (documentation) plus the repository's full gate set — Rust (`cargo fmt`/`clippy`/`test`) and TypeScript (`vp check`, `vp run typecheck`, `vp test`). No production code changes; if a gate fails, the fix belongs in a follow-up phase, not silently here.

---

## Files

- **Create:** `docs/architecture/git-manager.md` — the living architecture document for the feature.
- **Modify:** `docs/README.md` — index the new architecture page.
- **Modify:** `docs/architecture/rpc-and-orchestration.md` — reflect the six new methods and their scopes.
- **Modify:** `docs/user/workspace-ui.md` — the project-card button and the project-scoped Git Manager view.
- **Modify:** the affected runbooks under `docs/testing/` — packaged-UI flows and required validation evidence now include the Git Manager.

## Dependencies

- Phases 00–11 (all).

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Low (documentation), but the verification sweep can surface real defects. Effort: ~2 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:verification-before-completion")` — this phase *is* the verification gate

> No TDD step: this phase writes documentation and runs existing gates rather than production code. No domain-specific skills in the current inventory match a documentation sweep; the always-on set covers it.

## Documents to Read

- `../master-plan.md` — § Validation & Testing, § Acceptance Criteria, § Success Criteria, § Alternatives Considered (the trade-offs the architecture doc should record).
- `../tasks.md` — every phase's Detailed Progress and completion notes: the shipped behavior, not the planned behavior, is what gets documented.
- `AGENTS.md` (repo root) — § Testing Runbook Maintenance (the explicit list of triggers this feature hits: new RPC surface, provider/worktree visibility, packaged UI flows, required validation evidence).
- `docs/README.md`, `docs/architecture/overview.md`, `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/worktree-catalog.md` — the shape and tone living docs use here.
- `docs/testing/README.md` and the runbooks it indexes — find every one that enumerates packaged UI flows or validation evidence.

---

## Pre-execution check

- [ ] **Step 12.0: Claim the phase.** Set Phase 12 in `../tasks.md` → `in_progress`, `Agent = phase-12`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 12.1: Read what actually shipped.** Go through every phase's Detailed Progress in `../tasks.md` and list the deviations from `../master-plan.md`. The documentation describes the delivered behavior; deviations that contradict the master plan get called out in your notes and in `handoff.md`.

- [ ] **Step 12.2: Inventory the runbooks that need changes.**

	```bash
	grep -rln "packaged UI\|validation evidence\|worktree" docs/testing/
	```

	List each hit and decide: change, or "reviewed and remains accurate". `AGENTS.md` requires the final report to state which.

- [ ] **Step 12.3: Write `docs/architecture/git-manager.md`.** Sections: ownership and sources of truth (server computes guards, client renders), the project-scoped surface and its visibility rule, the six RPC methods with their scopes, the read/paging model (`generation`, cursor, lane layout on the client), the operation model (tagged union, per-repository lock, failure codes, merge-conflict resolution), the live change signal (broadcaster signature, observed staleness), and the documented invariants: no Git policy in React, non-interactive git environment, worktree-owned branches cannot be checked out, one project view at a time with a two-project cache.

- [ ] **Step 12.4: Index it** in `docs/README.md` under Architecture, in the same style as the neighbouring entries.

- [ ] **Step 12.5: Update `docs/architecture/rpc-and-orchestration.md`** — the new unary methods (`vcs.listCommitGraph`, `vcs.graphRefs`, `vcs.commitDetail`, `vcs.commitDiff`), the new streams (`git.runRepositoryOperation`, `subscribeVcsGraph`), and their scopes. Keep pointing at `ACTIVE_RPC_METHODS` / `required_scope` as the authoritative inventory rather than duplicating the list.

- [ ] **Step 12.6: Update `docs/user/workspace-ui.md`** — the Git Manager button on the project card, what the view shows, what it deliberately does not (local changes, stash, submodules, rebase, worktree operations), the worktree-blocked-checkout rule, and how conflicts are handled.

- [ ] **Step 12.7: Update the affected `docs/testing/` runbooks** — add the Git Manager to the packaged-UI validation flow (open from a project card, ref tree with a worktree-owned branch, graph paging, commit diff, fetch/push against a scratch remote, a conflicting merge with both resolutions, a branch and tag lifecycle, an external change appearing live). Keep execution-specific SHAs, timings, screenshots and machine paths **out** of the runbooks — those belong in a report created from the template.

- [ ] **Step 12.8: Run the full Rust gate.**

	```bash
	cargo fmt --all --check
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	cargo test -p bibcode-server
	```

	Record the exact output status in your progress notes.

- [ ] **Step 12.9: Run the full TypeScript gate.**

	```bash
	vp check
	vp run typecheck
	vp test
	```

	Record the outcome, including any pre-existing failures unrelated to this feature (name them explicitly rather than lumping them in).

- [ ] **Step 12.10: Walk the acceptance criteria.** Take `../master-plan.md` § Acceptance Criteria items 1–13 one at a time against the running app and mark each pass/fail in your progress notes. Any fail is a blocker entry in `../tasks.md`, not a silent omission.

- [ ] **Step 12.11: Dependency and diff review.**

	```bash
	git status --short
	git diff --stat
	git diff -- package.json apps/web/package.json apps/server/Cargo.toml Cargo.toml
	```

	Confirm: no new runtime dependency, no stray generated files, no debug output, no `.codegraph/` changes staged.

- [ ] **Step 12.12: Log-hygiene sweep across the feature.**

	```bash
	grep -rn "tracing::\|log::" apps/server/src/git/graph.rs apps/server/src/git/refs.rs apps/server/src/git/guards.rs apps/server/src/git/operations.rs
	```

	Confirm no branch names, paths, remote URLs, or git stderr text in log strings.

- [ ] **Step 12.13: Mark complete.** Phase 12 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, with a summary listing: docs written/updated, runbooks changed vs reviewed-and-accurate, gate results, acceptance-criteria verdicts, and any residual risk.

> **No commit step.** This plan is commit-free — the coordinator hands the working tree to the user, who decides what to commit.

---

## Verification

- [ ] `docs/architecture/git-manager.md` exists, describes the shipped behavior, and records the documented invariants.
- [ ] `docs/README.md`, `docs/architecture/rpc-and-orchestration.md` and `docs/user/workspace-ui.md` reflect the new surface.
- [ ] Every affected `docs/testing/` runbook is either updated or explicitly stated as "reviewed and remains accurate".
- [ ] `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `cargo test -p bibcode-server` results recorded.
- [ ] `vp check`, `vp run typecheck`, `vp test` results recorded, with any pre-existing failures named.
- [ ] All 13 acceptance criteria walked against the running app with a pass/fail verdict each.
- [ ] No new runtime dependency in `apps/web`, `apps/server`, or `packages/contracts`.
- [ ] No internal context in log strings anywhere in the feature.

## Notes for downstream phases

- None — this is the last phase. Hand the coordinator: the gate results, the acceptance-criteria table, the deviation list, and anything that should become a follow-up phase rather than shipping as-is. The coordinator writes `../tasks.md` § Final Summary and fills `../handoff.md` from your notes.
