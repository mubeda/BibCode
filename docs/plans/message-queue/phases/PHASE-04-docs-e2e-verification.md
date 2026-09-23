# Message Queue / Phase 04 — Docs, WebdriverIO scenario, full verification, runbooks

> **For agentic workers:** this phase is implemented by Codex (`codex:rescue`) with the coordinating Claude session running the live acceptance. Atomic steps use checkbox (`- [ ]`) syntax.

**Goal:** The living documentation describes the queue as shipped, a packaged desktop end-to-end scenario proves the user-visible flow against the stub providers, the testing runbooks are updated or recorded as reviewed, and the full gate set is green.

**Architecture:** Documentation edits only in the living docs named below; one new WebdriverIO spec in the desktop e2e suite following `composer-native-triggers.e2e.ts`; the stub provider profile in `apps/desktop/e2e/support/test-project.ts` gains a "slow turn" mode so a turn stays running long enough to queue.

**Tech Stack:** Markdown, WebdriverIO + mocha, the packaged-app fixture (`apps/desktop/e2e/support/`), Playwright (coordinator).

---

## Files

- **Modify:** `docs/architecture/rpc-and-orchestration.md` § Provider turn flow (`:1220`, including the mermaid diagram: `queued` state, promote on settle, steer path) and § Invariants (`:1558`: queued rows never look like work; auto-send only into `ready`; steer attributed to the running turn; cancel never discards text).
- **Modify:** `docs/architecture/providers.md` § Execution path (`:20`) and the driver table — `steer` column (Codex `turn/steer`, Claude user line, others unsupported) and `supportsTurnSteer`.
- **Modify:** `docs/architecture/overview.md` § Request and event flow — one paragraph.
- **Modify:** `docs/user/workspace-ui.md` composer paragraphs (`:239-248`) — queued cards, statuses, Steer, Cancel, Stop drain, reload behaviour; keep the older "Cancel queued message" paragraph accurate (it now describes a blocked `pending` delivery, not a `queued` message).
- **Modify:** `docs/user/keybindings.md` — `thread.steerQueuedMessage` default and `when`.
- **Modify:** `docs/providers/codex.md` and `docs/providers/claude.md` — a short "Steering a running turn" subsection each.
- **Modify:** `docs/testing/*` — the runbook(s) that list packaged UI flows and provider visibility gain the queue scenario, or are recorded as reviewed and unchanged in `tasks.md`.
- **Create:** `apps/desktop/e2e/specs/composer-message-queue.e2e.ts`; register it in `apps/desktop/e2e/wdio.conf.ts:39-46`.
- **Modify:** `apps/desktop/e2e/support/test-project.ts` — stub provider "slow turn" prompt (e.g. a prompt containing `[[slow]]` keeps the stub turn running until a second sentinel or 20 s); `provider-input-log.ts` records steer inputs with `kind: "steer"`.
- **Modify:** `CHANGELOG.md` — Unreleased entry.

## Dependencies

Phase 03.

## Owner Agent

Codex (`codex:rescue`) for docs and the spec; coordinator for the Playwright live pass and the runbook review sign-off.

## Risk / Effort

Low risk, medium effort (the packaged e2e fixture build is slow; run it once at the end).

## Discipline

- Living docs describe current behaviour only; no plan language.
- Execution-specific numbers (timings, counts, versions) go into a report from the `docs/testing/` template, not into runbooks.
- No commits.

## Documents to Read

`AGENTS.md` § Testing Runbook Maintenance; spec § 8; `docs/testing/README.md` (or the index) and the runbooks it lists; `apps/desktop/e2e/specs/composer-native-triggers.e2e.ts`; `apps/desktop/e2e/support/{test-project,provider-input-log,ui-state}.ts`; Phase 03 notes (data attributes).

## Pre-execution check

- [ ] `git status --short` clean apart from this plan's docs and Phases 00–03.
- [ ] Phases 00–03 marked `completed` in `tasks.md`.

## Atomic steps

- [ ] **Step 1:** stub provider slow-turn mode + input-log `kind`; unit tests in `test-project.test.ts` and `provider-input-log.test.ts`.
- [ ] **Step 2 (red):** write `composer-message-queue.e2e.ts`: open a thread on the `codex` stub, send a `[[slow]]` prompt, wait for the working indicator, type "second" + Enter and "third" + Enter, assert two `[data-queued-message-row]` cards with `Queued`, click Steer on the head, assert the input log gains a `steer` entry for "second" and the head card disappears, click Cancel on "third", assert the composer contains "third" and no cards remain, then queue "fourth", reload the window (`browser.refresh()` per the fixture's conventions), assert the card is back, let the slow turn end, assert the input log gains a `start` entry for "fourth". Run against the packaged fixture (`vp run --filter @bibcode/desktop e2e` or the script the runbook names) — expect the assertions to hold; fix the spec, not the app, unless a defect is found (report it in `tasks.md`).
- [ ] **Step 3:** documentation edits listed under Files.
- [ ] **Step 4:** runbook review: for each runbook in `docs/testing/`, either edit or record "reviewed and remains accurate" in `tasks.md` under "Phase 04".
- [ ] **Step 5:** full gates: `vp check`, `vp run typecheck`, `vp run test`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test -p bibcode-server -j 2` (foreground; note any environmental flake per `memory: host-pipe-budget-flake`), the desktop e2e suite.
- [ ] **Step 6:** paste gate output under "Phase 04" in `tasks.md`.
- [ ] **Step 7 (coordinator):** live acceptance with Playwright against `vp run dev` for spec § 8 items 1–8 on Codex and Claude, screenshots in the scratchpad, evidence paths recorded in `tasks.md` § Coordination notes.

## Verification

- `vp run --filter @bibcode/desktop e2e` (or the runbook's command)
- `vp check` · `vp run typecheck` · `vp run test` · `cargo fmt --all --check` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test -p bibcode-server -j 2`
- Coordinator Playwright pass (spec § 8).

## Notes for downstream phases

None; this is the last phase. Record residual risks in `tasks.md`.
