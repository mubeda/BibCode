# Execute Plan — Git Manager

This file is the **round-by-round orchestrator prompt** for the multi-agent execution of the decomposed plan in this folder.

**How to use:** open a fresh conversation, paste the entire "Coordinator Prompt" block below, and run it. The coordinator dispatches teammates one round at a time and advances as soon as every phase in the current round reaches `completed`. This plan is commit-free — no waiting for commits, no commit prompts anywhere in the workflow.

**Folder:** `/work/workspaces/orca/BibCode/develop-2/docs/plans/git-manager`
**Team name:** `git-manager`
**Spec:** `git-manager-spec.md`
**Master plan:** `git-manager-plan.md`

## Rounds in this plan

### Round 0 (sequential — 1 teammate)
- `phases/PHASE-00-contracts.md` — Wire contracts for the whole feature — owner: `general-purpose`

### Round 1 (parallel — 3 teammates)
- `phases/PHASE-01-server-read-rpcs.md` — Server read modules and read RPCs — owner: `general-purpose`
- `phases/PHASE-02-guards-module.md` — Pure guards module — owner: `general-purpose`
- `phases/PHASE-03-web-panel-shell.md` — Web panel shell: route, button, store — owner: `general-purpose`

### Round 2 (parallel — 3 teammates)
- `phases/PHASE-04-server-commit-operations.md` — Server staging and commit operations — owner: `general-purpose`
- `phases/PHASE-05-web-changes-view.md` — Web changes view — owner: `general-purpose`
- `phases/PHASE-06-web-history-view.md` — Web history view and diffs — owner: `general-purpose`

### Round 3 (parallel — 2 teammates)
- `phases/PHASE-07-server-branch-sync-operations.md` — Server branch and sync operations — owner: `general-purpose`
- `phases/PHASE-08-web-staging-commit-ui.md` — Web staging and commit UI — owner: `general-purpose`

### Round 4 (parallel — 2 teammates)
- `phases/PHASE-09-server-stash-merge-live-signal.md` — Server stash, merge, live signal — owner: `general-purpose`
- `phases/PHASE-10-web-toolbar-branch-sync.md` — Web toolbar, branch dropdown, sync UI — owner: `general-purpose`

### Round 5 (parallel — 2 teammates)
- `phases/PHASE-11-server-hunk-staging.md` — Server hunk and line staging — owner: `general-purpose`
- `phases/PHASE-12-web-stash-merge-ui.md` — Web stash and merge UI — owner: `general-purpose`

### Round 6 (parallel — 2 teammates)
- `phases/PHASE-13-server-history-rewriting.md` — Server history-rewriting operations — owner: `general-purpose`
- `phases/PHASE-14-web-partial-staging.md` — Web partial staging gutter — owner: `general-purpose`

### Round 7 (parallel — 2 teammates)
- `phases/PHASE-15-web-rewriting-conflicts-ui.md` — Web history rewriting and conflict UI — owner: `general-purpose`
- `phases/PHASE-16-tags-images-provider.md` — Tags, image diffs, provider surfaces — owner: `general-purpose`

### Round 8 (sequential — 1 teammate)
- `phases/PHASE-17-docs-telemetry-verification.md` — Docs, telemetry test, full verification — owner: `general-purpose`

---

## Coordinator Prompt

```
You are the coordinator for the implementation of the BiBCode "Git Manager".

The plan has been decomposed into atomic phase files in this folder:
/work/workspaces/orca/BibCode/develop-2/docs/plans/git-manager

The decomposition is organized in ROUNDS:
- Phases in the SAME round run in PARALLEL (dispatch all in a single message).
- Rounds run SEQUENTIALLY. Between rounds, write a round summary into
  tasks.md § Coordination Notes and proceed to the next round once every phase
  in the current round is `completed`. This plan is COMMIT-FREE — never ask
  anyone to commit, never wait for a commit, never treat git history as part of
  phase completion. (Read-only `git status` / `git diff` review IS required by
  the verification gates.)

## Setup (do once, before Round 0)

1. Invoke `Skill(skill="superpowers:using-superpowers")` — skill discipline.
2. Invoke `Skill(skill="superpowers:subagent-driven-development")` — dispatch
   discipline.
3. Invoke `Skill(skill="superpowers:dispatching-parallel-agents")` — every round
   except 0 and 8 has more than one phase.
4. Read `AGENTS.md` at the repository root. It governs required pre-work,
   evidence standards, architectural decision standards, testing-runbook
   maintenance, and task-completion requirements for every phase.
5. Read `docs/plans/git-manager/git-manager-spec.md` end-to-end — it is the
   authored scope, including the hard constraints.
6. Read `docs/plans/git-manager/git-manager-plan.md` end-to-end — architecture
   and global constraints.
7. Read `docs/plans/git-manager/tasks.md` — single source of truth for status,
   the file-conflict matrix, and the decomposition notes.
8. Read every `docs/plans/git-manager/phases/PHASE-*.md` so you know goals,
   dependencies and acceptance criteria across the whole plan.
9. Print a one-paragraph summary of what you are about to run, including the
   round structure and the file-conflict-matrix verdict.

## Non-negotiable constraints you enforce on every teammate

These come from the spec and are the reason this feature exists in this shape.
Reject any phase result that violates one:

- NO repository lifecycle. Nothing may add, create, clone, publish or remove a
  repository, or delete the repository.
- ZERO telemetry. No analytics, crash reporting, usage counters, remote feature
  flags, avatar or identity fetches, or third-party host contact. The only
  permitted outbound traffic is user-initiated git network operations against
  the repository's own remotes, and provider-CLI calls for pull requests and
  checks — never polled in the background.
- NO new dependencies. If a teammate believes one is required, that is a
  blocker for you to decide, not something they add.
- Server is the single git authority; the client renders server-authored
  blocked reasons verbatim and derives no git policy.
- Force-push is always `--force-with-lease`. `--ignore-other-worktrees`,
  `git worktree add -f`, and plumbing `update-ref` are forbidden.
- One repository lock: reuse the worktree catalog's existing lock; never
  introduce a second.
- Log hygiene: no branch names, ref names, absolute paths, remote URLs or git
  stderr interpolated into log strings.

## Per-round loop

Repeat until all rounds are completed.

### A. Pick the next round

The next round is the lowest-numbered round where at least one phase has status
`pending`. If every phase in the current round is `completed`, advance.

### B. Dispatch every ready phase in the round IN PARALLEL

A phase is ready when its status is `pending` AND all phases in earlier rounds
(and any explicit `Dependencies` it names) are `completed`.

In a SINGLE message, make one Agent tool call per ready phase:

  Agent(
    subagent_type="general-purpose",
    name="phase-{NN}",
    team_name="git-manager",
    description="Execute phase {NN}: {Phase Title}",
    prompt="""
    You are teammate `phase-{NN}` working on phase {NN} of the BiBCode Git
    Manager. Work in /work/workspaces/orca/BibCode/develop-2.

    Your single source of truth is the phase file:
      docs/plans/git-manager/phases/PHASE-{NN}-{slug}.md

    Workflow:
    1. Read your phase file in full.
    2. Invoke EVERY skill listed under "Skills to Invoke (teammate-side)" via
       the Skill tool, in the order listed, starting with
       `superpowers:using-superpowers`.
    3. Read EVERY file listed under "Documents to Read", including AGENTS.md.
       If a file is missing, report it in your tasks.md per-phase notes and
       continue.
    4. Perform the Pre-execution check: claim Phase {NN} in
       docs/plans/git-manager/tasks.md (status=in_progress, fill Agent +
       Started) and append a "picked up" line to your Detailed Progress
       section.
    5. Execute every Atomic Step in order, appending progress entries as you
       land meaningful milestones. There are NO commit steps.
    6. Verify EVERY item in "Verification", using
       `superpowers:verification-before-completion` before claiming done. Run
       the real gates: focused tests, `vp check`, `vp run typecheck`, and for
       Rust changes `cargo fmt --all --check`, `cargo test -p bibcode-server`,
       `cargo clippy -p bibcode-server --all-targets -- -D warnings`; for
       contract changes `vp run check:contracts`.
    7. Only when every Verification item is green, set your row to
       `Status = completed` and append a final summary entry.
    8. If blocked, set Status = blocked, fill § Active blockers, and return
       control with a one-paragraph explanation.

    Hard rules:
    - Only edit Phase {NN}'s row and your own Detailed Progress section in
      tasks.md. Never touch other phases' rows or sections.
    - Do not start phases other than your own.
    - Follow AGENTS.md and every applicable nested AGENTS.md.
    - Preserve unrelated working-tree changes.
    - Never run, propose or wait for a history-mutating git operation
      (`git add`, `git commit`, `git push`, `git tag`). Read-only `git status`
      and `git diff` review is required by the verification gates.
    - Respect the non-negotiable constraints in the spec: no repository
      lifecycle, zero telemetry, no new dependencies, server-authored git
      policy, `--force-with-lease` only, one repository lock, log hygiene.

    Report back when you finish (or get blocked) with a one-paragraph summary
    of what landed and any deviations from the plan.
    """
  )

### C. Monitor running teammates

Re-read tasks.md to track status. Use `SendMessage(to="phase-{NN}", message=…)`
to ask a still-running teammate for an update. The Agent harness notifies you
when a teammate completes — do not sit in a polling loop.

### D. End-of-round summary (mandatory)

When every phase in the round has reached `completed` (or `blocked`/`dropped`):

1. Re-read tasks.md to confirm.
2. Read every Detailed Progress section for the round — flag deviations that
   downstream phases need.
3. Append a `### Round {R} summary` block to `## Coordination Notes` with:
   phases completed, key deviations, file-coordination outcomes, and anything
   Round {R+1} teammates should know. Pay particular attention to any change in
   the shape of the `gitManager.*` contracts or the `gitManagerStore`, since
   later rounds are written against the names fixed in Round 0 and Round 1.
4. Proceed to the next round. Print the summary and the proposed dispatch list
   for transparency, but do not block on any external event.

Pause between rounds only if the user asked for a checkpoint, or a phase ended
`blocked`.

## Handling blockers

When a phase reports `blocked`:
- Read § Active blockers and the phase's Detailed Progress.
- Decide: resolve manually, re-dispatch with new context, drop the phase, or
  pause the round.
- Record the decision in `## Decisions`.
- If resolving, dispatch a fresh teammate with the same name and team but a
  prompt naming the blocker and its resolution.

Escalate to the user rather than deciding yourself when the blocker is: a
request to add a dependency, a request to weaken one of the non-negotiable
constraints, or a contract change that invalidates a later phase's named types.

## Completion

When the last round completes:

1. Re-read every Detailed Progress section in tasks.md.
2. Write the `## Final Summary` block: what was delivered against the spec,
   phase count, test count, files created/modified, deviations, open items.
3. Populate `docs/plans/git-manager/handoff.md` (the scaffold exists; fill every
   section).
4. Report back to the user with a one-paragraph summary, the paths to tasks.md
   and handoff.md, and the recommended next step (run `/code-review` against
   the branch, and the manual end-to-end verification against both a local and
   a remote-hosted project).
```

---

## Tips for the coordinator (out-of-band reminders)

- **Parallelism is the point.** When a round has N phases, all N are dispatched in one message containing N Agent calls. Sequential dispatch wastes wall-clock time.
- **One Rust registry-editing phase per round** is the invariant that makes parallelism safe here. Do not "helpfully" pull a later server phase forward into an earlier round.
- **Round 0 is load-bearing.** It crosses the RPC fixture and hard-coded-count gate once for the whole feature. If it lands a wrong or incomplete contract surface, every later round pays for it. Review its output carefully before dispatching Round 1.
- **Shippable checkpoints.** After Round 2 the feature is a usable read-only git viewer. That is a natural place for the user to look at the app before committing to the remaining rounds.
- **Commit-free.** No phase produces a git commit. Whether to commit the resulting work is the user's decision after execution.
- **End-of-plan verification.** Before flipping Phase 17 to `completed`, re-read the spec and confirm every section is reflected in delivered work. If something is missing, open a follow-up phase rather than silently dropping it.
