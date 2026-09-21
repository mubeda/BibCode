# Pull Requests / Phase 10 — Docs, telemetry tripwires, full verification

> **For agentic workers:** implemented by Codex (`codex:rescue`) for the docs and tests; the coordinating Claude session runs the end-to-end verification and fills `handoff.md`. Tick checkboxes as you go.

**Goal:** Ship the living documentation, the zero-telemetry tripwires (web and server), the desktop e2e sibling spec, and the full verification record; mark the GitLab end-to-end run as pending until it happens on the requester's server.

**Architecture:** Documentation follows the Git Manager's placement in each file. Tripwires mirror `gitManagerTelemetry.test.tsx` and `git/manager/mod.rs`'s process-surface test.

**Tech Stack:** Markdown, Vitest, cargo test, the packaged-app wdio e2e spec pattern in `apps/desktop/e2e/specs/pierre-diffs.e2e.ts`.

---

## Files

- **Modify:** `docs/user/workspace-ui.md` (new "Pull Requests" section after "Git Manager"; sidebar highlight sentence), `docs/user/keybindings.md` (no keybinding commands note), `docs/integrations/source-control-providers.md` (capability matrix rows; self-hosted GitLab / GHE setup; version gates; the module's command inventory summary), `docs/architecture/rpc-and-orchestration.md` ("Pull Requests flow" with the ten methods, scopes, no-polling invariant, checkout guards), `docs/architecture/overview.md` (module ownership paragraph), `docs/README.md` (link if a new page is added — none expected), `docs/testing/*.md` runbooks that enumerate packaged UI flows (add the sidebar button and a list/detail smoke step), `README.md` if it lists features
- **Create:** `apps/web/src/components/pullRequests/pullRequestsTelemetry.test.tsx`
- **Modify:** `apps/server/src/pull_requests/mod.rs` — extend `mod tripwires` with the "only gh/glab/git from handlers" assertion and a source scan for timers
- **Modify:** `apps/desktop/e2e/specs/pierre-diffs.e2e.ts` (or a sibling spec) — click `button[aria-label="Pull Requests for ${label}"]`, assert URL contains `/pull-requests`
- **Modify:** `docs/plans/pull-requests/handoff.md`, `tasks.md`

## Dependencies

- All previous phases.

## Owner Agent

Codex via `codex:rescue` (docs, tests); coordinator (verification, handoff).

## Risk / Effort

Risk: Low-Medium. Effort: ~4 h + verification time.

---

## Discipline

- `AGENTS.md` § Testing Runbook Maintenance: every affected runbook is updated or explicitly recorded as **reviewed and remain accurate**.
- Docs describe current behaviour only; no roadmap language.

## Documents to Read

- `pull-requests-spec.md` (all), `docs/user/workspace-ui.md` § Git Manager, `docs/integrations/source-control-providers.md`, `docs/architecture/rpc-and-orchestration.md` § Git Manager flow, `apps/web/src/components/gitManager/gitManagerTelemetry.test.tsx`, `apps/server/src/git/manager/mod.rs` tests

---

## Pre-execution check

- [x] **Step 10.0: Claim the phase** (`codex-10`).

## Atomic steps

- [x] **Step 10.1: Web telemetry test.** `pullRequestsTelemetry.test.tsx` mirroring the Git Manager's: stub `fetch` and `Image` to throw; render `PullRequestsPanel` (list) and the detail with fixtures containing remote images and avatar URLs; assert no throw, no `<img>` in the DOM, no request on an idle 60 min (fake timers), exactly one `runAction`/query dispatch per explicit Refresh/action, and every actor renders initials.

- [x] **Step 10.2: Server tripwires.** In `pull_requests/mod.rs::tripwires`: (1) scan every module file for `tokio::time::interval`, `tokio::spawn(` outside `production/pull_requests_rpc.rs` handlers, and `std::thread::spawn` → none; (2) assert the runner's command specs are only `gh`, `glab`, `git` (construct `HostCommandRunner::new` and check); (3) assert no `reqwest` usage in the module (`include_str!` scan for `reqwest::`) — the module never speaks HTTP itself.

- [x] **Step 10.3: Docs.** Write the sections listed in § Files. `workspace-ui.md` covers: the sidebar button and highlight, availability states and the Settings switch, list tabs/filters, detail tabs, reviewing (pending review, popover, suggestions), editing with undo, merge box and confirmations, checkout targets and "Open Git Manager there", what refreshes and when (never on a timer). `source-control-providers.md` gains rows: List PRs / Review / Approve / Request changes / Merge / Edit metadata / Checkout / Revert / Delete with Yes/No per host and the GitLab version gates; the setup section explains self-hosted hosts via `gh auth login --hostname` / `glab auth login --hostname` and Rescan. `rpc-and-orchestration.md` gains the method→scope table and the invariants (server-authored permissions, no polling, bodies never in argv, guards reuse). `overview.md` gains one paragraph next to the Git Manager's. `keybindings.md` gains the "registers no KeybindingCommand" sentence.

- [x] **Step 10.4: Runbooks.** Update `docs/testing/*` that enumerate packaged UI flows with a Pull Requests smoke (open list, open a PR, files tab renders); for every other runbook write "reviewed and remain accurate" in `tasks.md`.

- [x] **Step 10.5: Desktop e2e sibling** in the packaged-app spec (same pattern as the Git Manager click at `pierre-diffs.e2e.ts:394-403`).

- [x] **Step 10.6: Gate.**

  ```bash
  vp run test
  cargo test -p bibcode-server -j 2
  vp check && vp run typecheck && cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings
  ```

- [x] **Step 10.7: Mark complete** (Codex part).

Codex Steps 10.0–10.7 are implemented and the prescribed gate was executed.
Step 10.6 is **not an all-green gate**: sandbox listener/process restrictions
and unrelated runtime/CLI failures remain recorded under Phase 10 in `tasks.md`.
The packaged spec is written/typechecked, not browser-executed. Row 10 stays
`in_progress`; coordinator verification and `handoff.md` remain open.

### Coordinator steps

- [x] **Step 10.8: GitHub end to end** _(read-only pass, checkout and all host writes done 2026-09-21 on mubeda/SourceControlTest)_ (Playwright, browser mode, `mubeda/BibCode` + `openai/codex` read-only): list, filters, detail tabs, files, comment/edit/react/delete, inline review + suggestion, label with undo, checkout into a worktree, permission reasons on the read-only repo, settings switch. Screenshots into the coordinator scratchpad; results into `handoff.md`.
- [x] **Step 10.9: GitLab end to end** _(done 2026-09-21 on luna.tripunkt.de/mubeda/sourcecontroltest, GitLab 19.3.2)_ — requires the requester's company server or a gitlab.com token. Until it runs, `tasks.md` keeps Phase 10 `in_progress` with the line "GitLab e2e pending: needs a GitLab host with an authenticated `glab`", exactly as the Git Manager plan kept its Phase 17 open.
- [x] **Step 10.10: Fill `handoff.md`** (what shipped, files by layer, deviations, TODOs, how to verify, recommended review order).

---

## Verification

- [x] Telemetry test and server tripwires exist and pass; `rg -n "<img|avatar" apps/web/src/components/pullRequests --glob '!*test*'` returns only the image-to-link component.
- [x] Docs updated per § Files; `docs/README.md` links unchanged or extended; runbooks updated or recorded as reviewed.
- [x] Whole test graph and the server suite green; fmt/clippy/typecheck/check clean.
- [x] GitHub e2e recorded with screenshots; GitLab e2e status recorded honestly.
- [x] `handoff.md` complete.
