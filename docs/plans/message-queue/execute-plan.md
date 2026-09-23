# Execute Plan — Message Queue

This file is the **coordinator procedure** for executing the decomposed plan in this folder with Codex as the implementer and the Claude session as reviewer, per the requester's standing instruction from the Pull Requests module: the one that implements the changes is Codex, the one that reviews is the coordinating Claude session.

**Folder:** `docs/plans/message-queue`
**Spec:** `message-queue-spec.md` · **Master plan:** `message-queue-plan.md` · **Tracker:** `tasks.md`

## Phase order (strictly sequential)

00 contracts → 01 server queue → 02 server steer → 03 web → 04 docs/e2e/verification.

## Coordinator loop (per phase)

1. **Pre-flight.** Re-read the phase file. Run `git status --short` (must be clean apart from this plan's docs and earlier phases). Record `BASE=$(git rev-parse HEAD)` in the coordinator's ledger. Re-verify every `path:line` the phase cites; when the working tree differs, add a "Working-tree corrections" note to the Codex task.
2. **Dispatch Codex.** Invoke the `codex:codex-rescue` subagent with a task of this shape (no coordinator opinions, only the phase's requirements and the constraints):

   ```
   --fresh --write
   Implement Phase NN of docs/plans/message-queue: read docs/plans/message-queue/phases/PHASE-NN-<slug>.md first — it is your requirements; then AGENTS.md, message-queue-spec.md and message-queue-plan.md § Global Constraints. Work in this worktree only. Follow every atomic step in order, red → green, run the phase's Verification commands and paste their output into docs/plans/message-queue/tasks.md under "Phase NN". Do not commit. Do not add dependencies. Report deviations in tasks.md.
   Working-tree corrections: <list or "none">
   ```

   Use `--resume` with the numbered findings for a `changes_requested` round. Monitor liveness with the Monitor tool on `codex-companion.mjs status` keyed on the exact task id; fetch with `result <task-id>`.

3. **Review.** Read the full diff (`git diff $BASE`), the report in `tasks.md`, and the phase's Verification list. Run the gates yourself (never trust the pasted output alone): `vp check`, `vp run typecheck`, `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, the phase's cargo test filters (`-j 2`, foreground), the affected `vp run --filter <pkg> test`. For Phase 03: `vercel-react-best-practices` review of every changed component/hook, `UI.md` review of every user-visible change, and a Playwright script in the scratchpad against `vp run dev` (browser mode) with screenshots viewed by the coordinator. For Phase 04: run the packaged e2e suite and the live acceptance in spec § 8.
4. **Verdict.** `completed` (record evidence paths in `tasks.md` § Coordination notes) or `changes_requested` (numbered findings; back to step 2 with `--resume`). At most five fix rounds; then escalate to the requester with the open findings.
5. **Ledger.** Append to the coordinator's ledger: phase, verdict, commits (none), evidence.

## Non-negotiable constraints enforced on every phase

- Server-owned queue; no client-side queue store.
- Queued rows never look like work (no turn-start-requested, no pending projection turn, no `Working`).
- Auto-send only into `ready`; never while an approval or question is pending.
- Steer through `ProviderDriver::steer`, attributed to the running turn, gated by `supportsTurnSteer`; never a second `turn/start`; Codex keeps its active turn id; Claude never re-labels a running turn.
- Cancel and Stop return user text to the composer.
- No new dependencies. Contracts schema-only. Every gate and pinned count updated in the same change.
- Living docs and runbooks in Phase 04; each phase's notes in `tasks.md`.
- Phases are commit-free; the coordinator commits only when the requester asks, with a task resume in the message.

## Blockers

- Codex cannot allocate a dev-server port in its sandbox (known). Web-phase visual verification is the coordinator's job; Codex's gate is tests + typecheck + check.
- Live steer verification needs a real Codex thread (`codex-cli` ≥ 0.155, installed 0.155.1) and a real Claude thread (Claude Code 2.1.278 installed); the coordinator runs these against `vp run dev`.
- Pipe-heavy server suites can fail on an exhausted host pipe budget (see the coordinator's memory `host-pipe-budget-flake`); probe before blaming the change.
- A phase that needs a contract field the plan lacks reports it in `tasks.md`; the coordinator decides, updates the plan, and re-dispatches.
