# Git Manager — Hand-off for code review

**Last touched:** 2026-08-31 (scaffold created at decomposition time)
**Branch:** _(to be filled by the coordinator)_
**Status:** _(to be filled by the coordinator after the last round)_

_(This file is the single document a code reviewer reads first. The coordinator fills every section after the final round completes. Until then, the placeholders below stand in.)_

## What this iteration delivered

_(2–4 numbered bullets in plain English. Reference the spec's § 1 Outcome. Call out the user-visible behaviour change.)_

1. _(to be filled)_
2. _(to be filled)_

**Out of scope this iteration (acknowledged)** — copied from the spec's § 3.2, permanently excluded:

- Repository lifecycle of any kind: add, create, clone, publish, remove, delete.
- GitHub sign-in, SAML re-authentication, token management, fork creation, fork
  settings, upstream-remote management, "publish repository", push-protection
  and repository-rules dialogs, the tutorial repository.
- GitHub-hosted avatars and any other third-party asset fetch.
- A Fork-style lane commit graph.
- Copilot-branded features from the reference tree.

## Background docs (read in this order before reviewing code)

1. `git-manager-spec.md` — the authored scope: hard constraints, in/out of
   scope, surface and lifecycle, toolbar, behaviour decisions, guard table,
   performance contract, zero-telemetry invariant, and the decision log.
2. `git-manager-plan.md` — architecture, ownership table, contract-registration
   gate, client design, slices, risks, validation.
3. `tasks.md` — phase-by-phase status board with per-phase deviations, the
   file-conflict matrix, and the coordinator's round summaries.
4. `phases/PHASE-00-contracts.md` … `phases/PHASE-17-docs-telemetry-verification.md`
   — per-phase atomic-step instructions; the source of truth each implementing
   teammate worked from.
5. `research/github-desktop-analysis.md`, `research/bibcode-integration-surface.md`,
   `research/worktree-checkout-restrictions.md` — the evidence base. Read these
   when a review question is "why was it done this way".

## Files touched

_(Quick summary by layer. The full map lives in each phase file's "Files" section.)_

**Contracts (`packages/contracts`):**
- _(to be filled — file paths)_

**Server (`apps/server`):**
- _(to be filled)_

**Client runtime (`packages/client-runtime`):**
- _(to be filled)_

**Web (`apps/web`):**
- _(to be filled)_

**Documentation (`docs/`):**
- _(to be filled)_

**Tests:**
- _(to be filled — list each new test file and the test count)_

Total: _(N)_ new tests. Build status: _(0 warnings / 0 errors, or report deviations)_.

## Key deviations from the original plan (worth scrutinising)

_(Numbered list. For each: what the spec or plan assumed, what the code does, and why. This is the section reviewers spend the most time on. Draw these from the per-phase Detailed Progress entries in `tasks.md`.)_

1. _(to be filled)_
2. _(to be filled)_

## TODOs / known limitations left in code

- _(every TODO comment that landed, with rationale)_
- _(every acknowledged limitation, citing where it is documented in the spec)_
- Known deferrals recorded at design time, expected to still be true:
  - Renaming a branch held by another worktree is blocked rather than performed
    transactionally (spec § 7.2).
  - Network operations rely on ambient credentials; there is no in-app
    credential prompt (spec § 12, decision 3).

## How to verify before merging

1. `vp check` — clean.
2. `vp run typecheck` — no type errors.
3. `vp run check:contracts` — fixture and parity pipeline green (mandatory
   because this feature adds RPC methods).
4. `vp test apps/web/src/components/gitManager` and the other focused paths
   named in the phase files — green.
5. `cargo fmt --all --check` — clean.
6. `cargo test -p bibcode-server` — green.
7. `cargo clippy -p bibcode-server --all-targets -- -D warnings` — clean.
8. **Zero-telemetry test** (Phase 17) — green. This is the executable form of a
   hard constraint; a failure here blocks merge regardless of everything else.
9. **Manual end-to-end verification, against BOTH a local project and a
   remote-hosted project** — the routing difference between them is this
   feature's main environmental risk, and no automated gate covers it:
   - Open the Git Manager from the project header button; confirm it opens on
     the main checkout and that reopening focuses rather than duplicating.
   - Reload the page; confirm the panel is restored.
   - Switch to a worktree; confirm the panel rescopes.
   - Attempt to check out a branch held by another worktree; confirm it
     redirects visibly to that worktree with a stated reason.
   - Have an agent session write files while the panel is open; confirm the
     changes list updates live and the agent-activity indicator appears.
   - Stage, commit, and confirm the commit appears in history.
   - Disconnect the remote environment; confirm the unavailable state names the
     reason and that the panel does not re-dial it.
10. `git status --short` and `git diff` review for unintended edits, generated
    files, debug output and dependency drift.

## Recommended code review

Run `/code-review` against the branch. Focus areas specific to this feature:

**Constraint compliance (check first — these are the reasons the feature is shaped this way):**
1. No code path can add, create, clone, publish, remove or delete a repository.
2. No outbound request to any host other than a configured git remote or the
   configured provider CLI; no background provider polling; no new dependency.
3. Every blocked reason is authored server-side and rendered verbatim; no git
   policy is re-derived in React.
4. Force-push uses `--force-with-lease` only; no `--ignore-other-worktrees`, no
   `git worktree add -f`, no plumbing `update-ref`.
5. Only the worktree catalog's existing repository lock is used.

**Rust:**
- Every git invocation goes through the supervised process path with a timeout,
  output cap and cancellation token, and the non-interactive git environment.
- Every mutation passes through the status broadcaster's mutation fence.
- Guards re-validated under the lock immediately before execution.
- Log hygiene: no branch names, paths, remote URLs or git stderr in log strings.
- Error classification is used for reporting only, never for guard decisions.

**React:**
- Hook rules, stale closures, unstable references in virtualised lists.
- Re-render behaviour under a live status stream — this panel updates
  continuously while agents write, so a re-render storm is a real risk.
- State keys are `(environmentId, projectId)` / `(environmentId, cwd)`, never a
  bare `projectId`.
- Subscriptions are not held for projects that are not being viewed.
- Accessibility: icon-only controls labelled; disabled controls expose their
  reason through both tooltip and `aria-describedby`.
- Commit-draft state is genuinely shared with the existing `SourceControlPanel`
  rather than duplicated.

**Contracts:**
- Every new method registered in all required places with exactly one scope;
  read-only methods do not require a write scope.
- Capability flags default to false.
- Existing `VcsCommit` was not changed in place.

For each finding, suggest a concrete fix or document a follow-up. After the
review, summarise the verdict (ship / fix-before-merge / refactor-first) and
list any follow-up work to open.

## Open questions for the reviewer to consider

- Is the tip-pinned history paging holding up under a repository where agents
  commit continuously, or does the generation-splice path need a bound?
- Is the LRU-2 view-state cache the right size in practice, or does returning
  to a third project feel slow enough to justify caching more?
- Does the occupied-branch redirect read clearly, or does it need a stronger
  visual transition to make the worktree change obvious?
- _(add questions surfaced during implementation)_
