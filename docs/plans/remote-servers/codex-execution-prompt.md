# Codex execution prompt (paste into Codex)

Paste everything inside the fence below. To run a single phase instead of all seven,
change the "Execution order" section to name only that phase.

---

```text
Implement the BiBCode "Remote Servers" feature by executing the approved plan set in
docs/plans/remote-servers/. Work in /work/workspaces/orca/BibCode/develop (a git worktree —
stay inside it; never cd to the original repo root).

## Read first, in this order

1. AGENTS.md at the repo root (and any AGENTS.md closer to files you touch). Its Required
   Pre-Work, Architectural Decision Standards, and Task Completion Requirements are binding.
2. docs/plans/remote-servers/remote-servers-spec.md — the approved design. Section 4 pins
   cross-phase contracts (names, wire shapes, state machines). They are normative as
   amended in place: dated amendment markers override the original text, and dated
   remediation design documents under docs/plans/remote-servers/ supersede it where they
   say so. If implementation forces another deviation, amend the spec in the same patch and
   say so in the commit message — never silently diverge.
3. docs/plans/remote-servers/remote-servers-plan.md — the master plan: phase order,
   dependencies, cross-phase interface summary, and the Global Constraints that apply to
   every task.
4. The phase file you are currently executing (below).

Background, read as needed rather than up front: bibcode-current-state.md (survey of the
existing seams) and orca-remote-servers-research.md (research on the reference
implementation, plus an Errata section that supersedes its body where they conflict).

## Execution order

Sequential. Phases 1 and 2 are independent of each other; every later phase depends on
earlier ones as recorded in the master plan.

1. phases/phase-1-ssh-pairing-repair.md
2. phases/phase-2-protocol-compat.md
3. phases/phase-3-e2ee-pairing.md
4. phases/phase-4-settings-connect-tab.md
5. phases/phase-5-share-tab-exposure.md
6. phases/phase-6-environment-rail.md
7. phases/phase-7-remote-updates.md

Finish a phase completely — including its validation gate and documentation tasks — before
starting the next. Do not start a later phase to "unblock" an earlier one.

## How to execute a phase

Each phase file is a list of tasks; each task is a TDD cycle with real code in every step.
Follow the cycles as written:

- Write the failing test first. Run it. Confirm it fails for the stated reason.
- Write the minimal implementation. Run the test. Confirm it passes.
- Commit with the conventional-commit message the task supplies.
- Tick the task's checkboxes in the phase file as you complete them, and commit that too.

The plans quote real symbols, paths, and line numbers, but they were written against a
snapshot. Before editing a file, read it. When the plan and the source disagree, the source
wins for mechanics (names, signatures, line numbers) and the spec wins for behavior. Adjust
the plan's code to the real API and note the adjustment in your report — do not invent a
second definition of something that already exists, and do not skip a task because its
quoted line number moved.

If a task's premise is genuinely wrong (the seam it describes does not exist, or the
approach cannot work), stop that task, report what you found, and propose the smallest
correct alternative. Do not improvise a large redesign silently.

## Validation gate — every phase, before you call it done

1. Focused tests for every changed behavior (they exist because you wrote them first).
2. `vp check` and `vp run typecheck`.
3. For Rust changes: `cargo fmt --all --check`, the affected crates' tests, and Clippy for
   affected targets with warnings denied.
4. Broader integration/build checks when the phase crosses package or runtime boundaries.
5. `git diff` and `git status --short` review for unintended edits, generated files, debug
   output, and dependency drift.
6. Report the exact commands you ran, anything that could not run and why, and residual risk.

`vp test` is the built-in test command; `vp run test` is the workspace package-script graph.
A broad suite does not replace focused coverage for changed behavior.

## Hard rules

- The reference product's name must not appear anywhere you write — not in code,
  identifiers, comments, test names, UI copy, or commit messages. Product strings are
  "BiBCode" / "bibcode" by context. (The research filename in docs/plans/ is pre-existing;
  leave it alone.)
- Preserve unrelated worktree changes. Two files under
  docs/plans/2026-08-24-environment-project-management/ are staged for deletion by the user:
  leave them deleted, never restore or commit them.
- Never bare `git stash` / `git stash pop` — the stash stack is shared across worktrees.
  Prefer a temporary WIP commit if you must set work aside.
- Do not hand-edit, stage, or commit anything under .codegraph/.
- packages/contracts stays schema-only. Every new WS method needs its Rust mirror, a parity
  manifest entry, and exactly one declared scope in apps/server/src/auth/scope.rs.
- New contract and descriptor fields are additive and decode-defaulted so older servers keep
  working. No breaking wire changes.
- Privileged desktop operations cross DesktopBridge; ordinary traffic uses typed HTTP/WS RPC.
  No production Node runtime, no Electron host, no sidecars.
- Update living documentation in the same patch as the behavior it describes
  (docs/architecture/remote.md, connection-runtime.md, overview.md), and review the
  docs/testing/ runbooks each phase touches — update them or state that they were reviewed
  and remain accurate.

## Reporting

After each phase, report: what landed, the exact validation commands and their results,
every place the plan disagreed with the source and how you resolved it, any spec amendment
you made, and residual risk. Then continue to the next phase.

Known things to expect, so they do not surprise you: Phase 5's bind widening restarts the
local backend (live local turns terminate; durable state survives and clients reconnect) —
the plan warns the user before widening. Phase 3 adds new dependencies (the `snow` crate,
the noble crypto packages) and its first task verifies their current APIs before use, rather
than trusting the plan's snippets. Phase 4 splits a ~3,200-line settings file; keep that
task mechanical and reviewable.

Begin with Phase 1.
```
