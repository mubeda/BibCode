# Execute Plan — Pull Requests

This file is the **coordinator procedure** for executing the decomposed plan in this folder with Codex as the implementer and the Claude session as reviewer, per the requester's instruction: "the one that implement the changes is the Codex AI, but the one that review this changes are you as a project manager".

**Folder:** `docs/plans/pull-requests`
**Spec:** `pull-requests-spec.md` · **Master plan:** `pull-requests-plan.md` · **Tracker:** `tasks.md`

## Phase order (strictly sequential)

00 contracts → 01 server context/list → 02 web shell/list → 03 server detail reads → 04 web detail → 05 server review mutations → 06 web review → 07 server edit/merge/state → 08 web edit/merge → 09 checkout → 10 docs/telemetry/verification.

## Coordinator loop (per phase)

1. **Pre-flight.** Re-read the phase file. Run `git status --short` (must be clean apart from this plan's docs). Record `BASE=$(git rev-parse HEAD)` in the coordinator's ledger. Re-verify every `path:line` the phase cites; when the working tree differs, add a "Working-tree corrections" note to the Codex task.
2. **Dispatch Codex.** Invoke the `codex:codex-rescue` subagent with a task of this shape (no coordinator opinions, only the phase's requirements and the constraints):

   ```
   --fresh --write
   Implement Phase NN of docs/plans/pull-requests: read docs/plans/pull-requests/phases/PHASE-NN-<slug>.md first — it is your requirements; then AGENTS.md, pull-requests-spec.md and pull-requests-plan.md § Global Constraints. Work in this worktree only. Follow every atomic step in order, red → green, run the phase's Gate commands and paste their output into docs/plans/pull-requests/tasks.md under "Phase NN". Do not commit. Do not add dependencies. Report deviations in tasks.md.
   Working-tree corrections: <list or "none">
   ```

   Use `--resume` with the numbered findings for a `changes_requested` round. Poll with `codex-companion.mjs status <task-id>`; fetch with `result <task-id>`.

3. **Review.** Read the full diff (`git diff $BASE`), the report in `tasks.md`, and the phase's Verification list. Run the gates yourself (never trust the pasted output alone): `vp check`, `vp run typecheck`, `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, the phase's cargo test filters (`-j 2`, foreground), the affected `vp run --filter <pkg> test`. For web phases: `vercel-react-best-practices` review of every changed component/hook, `UI.md` review of every user-visible change, and a Playwright script in the scratchpad against `vp run dev` (browser mode) with screenshots viewed by the coordinator.
4. **Verdict.** `completed` (record evidence paths in `tasks.md` § Coordination notes) or `changes_requested` (numbered findings; back to step 2 with `--resume`). At most five fix rounds; then escalate to the requester with the open findings.
5. **Ledger.** Append to the coordinator's ledger: phase, verdict, commits (none), evidence.

## Non-negotiable constraints enforced on every phase

- Server-computed permissions rendered verbatim; the client derives no policy.
- Zero telemetry: no avatars, images, analytics, pollers, timers, focus refetch; only user-initiated `gh`/`glab`/`git` traffic.
- One `PullRequestHost` trait with two adapters; host specifics live in adapter capabilities.
- No new dependencies. No repository lifecycle. No internal host endpoints.
- Every process call through `ProcessRunner`; bodies never in `argv`; hosts via env/`--hostname`; `--repo` pinned.
- Every new RPC registered in all gates with counts bumped.
- Log hygiene. Living docs in the same change (Phase 10 for the bulk; each phase's Notes).
- Phases are commit-free; the coordinator commits only when the requester asks, with a task resume in the message.

## Blockers

- **Mutation verification touches a real host account.** Reads may run against `mubeda/BibCode` and `openai/codex`. Writes (comments, labels, reviews, merge, revert, delete, checkout) run only in a repository the requester designates or authorizes the coordinator to create; Phases 06–10's Playwright write steps wait for that designation. GitLab writes additionally need the company server or a token.

- Codex cannot allocate a dev-server port in its sandbox (known from the Git Manager). Web-phase visual verification is the coordinator's job; Codex's gate is tests + typecheck + check.
- GitLab end to end needs a host with an authenticated `glab`; Phase 10 stays open until the requester runs it or provides a token.
- A phase that needs a contract field the plan lacks reports it in `tasks.md`; the coordinator decides, updates the plan, and re-dispatches.
