# Execute Plan — Git Manager

This file is the **round-by-round orchestrator prompt** for the multi-agent execution of the decomposed plan in this folder.

**How to use:** open a fresh conversation, paste the entire "Coordinator Prompt" block below, and run it. The coordinator dispatches teammates one round at a time and advances as soon as every phase in the current round reaches `completed`. This plan is commit-free — no waiting for commits, no commit prompts anywhere in the workflow.

**Folder:** `X:/Workspaces/BiBCode/BibCode/develop-5/docs/superpowers/plans/2026-08-18-git-manager`
**Team name:** `git-manager`
**Master plan:** `X:/Workspaces/BiBCode/BibCode/develop-5/docs/superpowers/plans/2026-08-18-git-manager/master-plan.md`
**Spec:** `issue.specs` in the same folder (including its `## Interview Notes`)

## Rounds in this plan

### Round 0 (sequential — 1 teammate)
- `phases/PHASE-00-contracts.md` — Wire contracts for the whole feature — owner: `general-purpose`

### Round 1 (parallel — 3 teammates, no shared files)
- `phases/PHASE-01-server-read-rpcs.md` — Server read modules and read RPCs — owner: `general-purpose`
- `phases/PHASE-02-web-shell-and-route.md` — Project route, panel shell, store, sidebar button — owner: `general-purpose`
- `phases/PHASE-03-lane-layout-module.md` — Incremental lane-layout module — owner: `general-purpose`

### Round 2 (parallel — 3 teammates, no shared files)
- `phases/PHASE-04-server-operations.md` — Streaming repository operations — owner: `general-purpose`
- `phases/PHASE-05-ref-tree.md` — Ref tree with server-authored guards — owner: `general-purpose`
- `phases/PHASE-06-commit-graph.md` — Virtualized commit graph — owner: `general-purpose`

### Round 3 (parallel — 3 teammates, no shared files)
- `phases/PHASE-07-server-live-signal.md` — Live repository change signal — owner: `general-purpose`
- `phases/PHASE-08-commit-detail.md` — Commit detail pane with diff — owner: `general-purpose`
- `phases/PHASE-09-operations-ui.md` — Toolbar, progress banner, fetch/pull/push/merge dialogs — owner: `general-purpose`

### Round 4 (parallel — 2 teammates, no shared files)
- `phases/PHASE-10-branch-tag-lifecycle.md` — Branch and tag lifecycle — owner: `general-purpose`
- `phases/PHASE-11-live-refresh-wiring.md` — Client live-refresh wiring — owner: `general-purpose`

### Round 5 (sequential — 1 teammate)
- `phases/PHASE-12-docs-and-verification.md` — Living documentation and full verification — owner: `general-purpose`

---

## Coordinator Prompt

```
You are the coordinator for the implementation of "Git Manager" in the BiBCode repository.

The plan has been decomposed into atomic phase files in this folder:
X:/Workspaces/BiBCode/BibCode/develop-5/docs/superpowers/plans/2026-08-18-git-manager

The decomposition is organized in ROUNDS:
- Phases in the SAME round run in PARALLEL (dispatch all in a single message).
- Rounds run SEQUENTIALLY. Between rounds you write a round summary into
  tasks.md § Coordination Notes and proceed directly to the next round once
  every phase in the current round is `completed`. This plan is COMMIT-FREE —
  never ask the user (or any teammate) to commit anything, never wait for a
  commit, never reference git history as part of phase completion. "Commit-free"
  bans history-mutating git (`add`, `commit`, `push`, `tag`, `reset`, `rebase`);
  read-only inspection (`git status`, `git diff`, `git log`) and git inside test
  fixtures or the feature's own server code are expected and allowed.

## Setup (do once, before Round 0)

1. Invoke `Skill(skill="superpowers:using-superpowers")` — skill discipline.
2. Invoke `Skill(skill="superpowers:subagent-driven-development")` — dispatch discipline.
3. Invoke `Skill(skill="superpowers:dispatching-parallel-agents")` — Rounds 1–4 each have more than one phase.
4. Read `master-plan.md` end-to-end, then `issue.specs` (including `## Interview Notes`).
5. Read `tasks.md` — the single source of truth for status, and its
   § Coordination Notes → "Decomposition-time notes", which explain the two
   rules that keep parallel rounds conflict-free.
6. Read every `phases/PHASE-*.md` so you know goals, dependencies, owner
   agents and acceptance criteria across the whole plan.
7. Read the repository's `AGENTS.md` — it governs every teammate's work
   (architecture boundaries, log hygiene, task completion requirements).
8. Print a one-paragraph summary of what you are about to run, including the
   round structure and the file-conflict-matrix verdict from tasks.md.

## Per-round loop

Repeat until all rounds are completed.

### A. Pick the next round

The next round is the lowest-numbered round where at least one phase has
status `pending`. If every phase in the current round is `completed`, advance.

### B. Dispatch every ready phase in the round IN PARALLEL

A phase is ready when its status is `pending` AND every phase it names under
`Dependencies` has status `completed`.

In a SINGLE message, make one Agent tool call per ready phase:

  Agent(
    subagent_type="general-purpose",
    name="phase-{NN}",
    team_name="git-manager",
    description="Execute phase {NN}: {Phase Title}",
    prompt="""
    You are teammate `phase-{NN}` working on phase {NN} of the BiBCode Git Manager.

    Your single source of truth is the phase file:
      X:/Workspaces/BiBCode/BibCode/develop-5/docs/superpowers/plans/2026-08-18-git-manager/phases/PHASE-{NN}-{slug}.md

    Workflow:
    1. Read your phase file in full, then `../master-plan.md` sections it cites.
    2. Invoke EVERY skill listed under "Skills to Invoke (teammate-side)" via the
       Skill tool, in the order listed, starting with
       `superpowers:using-superpowers`.
    3. Read EVERY file listed under "Documents to Read". If one is missing,
       record that in your tasks.md progress notes and continue.
    4. Perform the Pre-execution check: claim Phase {NN} in tasks.md
       (status=in_progress, Agent, Started) and append a "picked up" line. Do
       NOT run, suggest, or wait for any git operation.
    5. Execute every Atomic Step in order, appending progress lines as you land
       milestones. There are NO commit steps.
    6. Verify EVERY item in "Verification", using
       `superpowers:verification-before-completion` before claiming done. UI
       phases must be exercised in the running app, not only in tests.
    7. Only when every Verification item is green, set your row to
       `Status = completed` and append a final summary — including everything
       your phase file's "Notes for downstream phases" told you to record.
    8. If you hit a blocker you cannot resolve, set Status = blocked, fill
       tasks.md § Active blockers, and return control with a one-paragraph
       summary.

    Hard rules:
    - Edit ONLY Phase {NN}'s row and your own Detailed Progress section in tasks.md.
    - Touch ONLY the files listed under your phase's "Files" section. The
      conflict-free property of this round depends on it: if you believe you
      must edit a file another phase owns, STOP and report it to the
      coordinator instead.
    - Never edit `master-plan.md` or `issue.specs`.
    - Follow the repository `AGENTS.md`: server owns Git policy, React renders
      it; `packages/contracts` stays schema-only; no internal context (branch
      names, paths, remote URLs, git stderr) in log strings; no new runtime
      dependencies.
    - This plan is COMMIT-FREE: never run, propose, or wait for a
      history-mutating git operation (`git add`, `git commit`, `git push`,
      `git tag`, `git reset`, `git rebase`). Read-only inspection
      (`git status`, `git diff`, `git log`) and git inside test fixtures or the
      feature's own server code are expected and allowed.
    - Your phase's full-workspace gates (`vp check`, `vp run typecheck`) see
      files a same-round teammate may still be writing. If such a gate fails on
      a file outside your phase's Files list, say so in your progress notes and
      report it to the coordinator — do NOT fix a neighbour's file and do NOT
      flip to `blocked` for it.

    Report back when you finish (or get blocked) with a one-paragraph summary
    of what landed and any deviations from the plan.
    """
  )

If a round has one ready phase, dispatch it alone with the same shape.

### C. Monitor running teammates

Re-read tasks.md to track status. Use `SendMessage(to="phase-{NN}", message="…")`
to ask a still-running teammate for an update. Do not sit in a sleep loop — the
harness notifies you when a teammate completes.

### D. End-of-round summary (mandatory)

When every phase in the round has reached `completed` (or `blocked`/`dropped`):

1. Re-read tasks.md to confirm.
2. Read every Detailed Progress section for the round and extract the items
   later phases were told to record — for example: Phase 01's `refs_signature`
   helper name (Phase 07 needs it), Phase 03's exported layout symbols (Phase
   06), Phase 04's `started` label and `finished` summary strings (Phase 09),
   Phase 05's ref-action seam and Phase 09's toolbar seam (Phase 10), Phase
   07's event shape and poll interval (Phase 11).
3. Append a `### Round {R} summary` block to tasks.md § Coordination Notes with
   phases completed, deviations, and the handoff facts from step 2.
4. Proceed directly to the next round. Print the summary and the proposed next
   dispatch list, but do NOT block waiting for any commit or external git event.

Pause between rounds only if the user asked for a checkpoint, or a phase ended
`blocked`.

## Handling blockers

When a phase reports `blocked`:
- Read the blocker entry and that phase's Detailed Progress.
- Decide: resolve manually, re-dispatch with new context, drop the phase, or
  pause the round.
- Record the decision in tasks.md § Decisions.
- If a blocker requires changing a contract from Phase 00, treat it as a
  cross-phase change: record it in § Coordination Notes and make ONE phase
  responsible for the edit.

## Completion

When Round 5 completes:

1. Re-read every Detailed Progress section in tasks.md.
2. Write the `## Final Summary` block: what was delivered against the master
   plan, phase/test/file counts, deviations, open items.
3. Populate `handoff.md` — fill every section from the phase notes and Phase
   12's verification results. It is the artifact the reviewer reads first.
4. Report back to the user with a one-paragraph summary, the paths to tasks.md
   and handoff.md, the gate results from Phase 12, and the recommended next
   step (run `/code-review` over the working tree, then decide what to commit —
   the user owns that decision).
```

---

## Tips for the coordinator (out-of-band reminders)

- **Parallelism is the point.** Rounds 1, 2 and 3 each hold three phases — dispatch all three in one message, not sequentially.
- **The conflict-free property is structural, not luck.** One server phase per round owns the shared Rust registries; each web phase owns exactly one region file under `components/git-manager/`. If a teammate strays outside its Files list, that guarantee is gone — pull it back rather than letting it "just fix" a neighbouring file.
- **Round 3 depends on Round 2's notes.** Phase 09 needs Phase 04's event label strings; Phase 08 needs Phase 06's selection contract. Extract them into the round summary before dispatching.
- **Commit-free.** No commit steps, no commit prompts, no SHAs in artifacts. The work product is the working tree plus tasks.md. Read-only `git status`/`git diff` (Phase 12 needs them) and git inside fixtures are fine.
- **Shared working tree.** Teammates run in one checkout, so full-workspace gates (`vp check`, `vp run typecheck`, `cargo test`) can transiently fail on a same-round neighbour's half-written file. Treat such a failure as noise during the round: re-run the full gate yourself at end-of-round, before writing the round summary, and only then investigate what is still red. Never let a teammate mark itself `blocked` over a neighbour's in-flight file.
- **High-risk phases:** 01 (new Git parsing + shared registries), 04 (destructive operations, concurrency, cancellation), 09 (streaming UI + conflict decisions). Read those teammates' summaries carefully before advancing.
- **End-of-plan check.** Before flipping Phase 12 to `completed`, confirm all 13 acceptance criteria in `master-plan.md` were walked with a verdict. Anything missing becomes a follow-up phase, not a silent gap.
