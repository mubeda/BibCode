# Git Manager / Phase 07 — Live repository change signal

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Emit a repository change event whenever refs, HEAD, or the worktree inventory change, so the Git Manager stays current without polling from the client.

**Architecture:** Implements § "Phase 7 — Live change signal" of `../master-plan.md`. This phase adds a cheap refs signature to the broadcaster's **existing** ref tick and exposes `subscribeVcsGraph`. **No additional poller task and no filesystem watcher** — reusing the existing machinery is the whole point.

Three facts about the current implementation, verified before this plan was written, shape the work:

1. `RepositoryState` (`broadcaster.rs:43-49`) holds only `local`, `remote`, `subscribers`, `local_refresh_requests` and `poller_cancellation` — **the signature and generation are new fields you add**, alongside a graph-subscriber map (the existing `subscribers` map carries `VcsStatusStreamEvent` senders and should not be overloaded).
2. There are already **two** poller tasks per repository — `spawn_local_status_poller` and `spawn_remote_and_ref_poller`, spawned together at `broadcaster.rs:158-163`. The signature check belongs on the ref poller's existing tick. Adding a third task would violate the constraint above.
3. Both are started **only when the first subscriber arrives** (`broadcaster.rs:128,158-163`). So `subscribeVcsGraph` must go through the same subscribe-driven start path and keep the pollers alive while only a graph subscriber exists — otherwise a Git Manager open with no status subscriber gets no ticks at all.

The tick is `REF_REFRESH_INTERVAL = 3s` (`apps/server/src/production/git_vcs.rs:40`); that is the worst-case staleness the docs should state.

**Tech Stack:** Rust (Axum/Tokio). Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server git::broadcaster`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`.

---

## Files

- **Modify:** `apps/server/src/git/broadcaster.rs` — refs signature, generation counter, graph subscriber fan-out (with tests).
- **Modify:** `apps/server/src/production/git_vcs.rs` — `subscribeVcsGraph` stream handler; add it to `GIT_VCS_STREAM_METHODS`.
- **Modify:** `apps/server/src/rpc/methods.rs` — register the streaming method.
- **Modify:** `apps/server/src/auth/scope.rs` — map it to `SCOPE_ORCHESTRATION_READ` (next to `subscribeVcsStatus`).
- **Modify:** `apps/server/src/maintenance.rs` — add it to the read-only allowlist.

## Dependencies

- Phase 00: Wire contracts for the whole feature.
- Phase 01: Server read modules and read RPCs (the `refs_signature` helper).
- Phase 04: Streaming repository operations (the completion-triggered refresh must land on the same channel).

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium (touches a shared poller used by existing status subscribers — a regression here degrades unrelated features). Effort: ~2 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the generation tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="ponytail:ponytail")` — extend the existing poller, do not add a watcher subsystem

## Documents to Read

- `../master-plan.md` — § Phase 7, § Technical Requirements → Server (change detection paragraph).
- `../issue.specs` — § Interview Notes → "Live updates".
- `AGENTS.md` (repo root) — performance/reliability priorities; predictable behavior under load and reconnect.
- `apps/server/src/git/broadcaster.rs` — `Inner`, `RepositoryState`, `ref_refresh_interval`, `local_refresh_requests`, subscriber capacity and the failure backoff constants.
- `apps/server/src/git/refs.rs` (Phase 01) — the `refs_signature` helper to reuse.
- `apps/server/src/production/git_vcs.rs` — the `subscribeVcsStatus` handler as the streaming precedent.

---

## Pre-execution check

- [ ] **Step 07.0: Claim the phase.** Set Phase 07 in `../tasks.md` → `in_progress`, `Agent = phase-07`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 07.1: Locate the surface area.**

	```bash
	grep -n "struct RepositoryState\|ref_refresh_interval\|local_refresh_requests\|subscriber" apps/server/src/git/broadcaster.rs | head -25
	grep -n "subscribeVcsStatus" apps/server/src/production/git_vcs.rs | head
	```

	Understand the existing poll tick, how subscribers are registered and dropped, and how remote-failure backoff works. Record deviations in `../tasks.md`.

- [ ] **Step 07.2: Author the first failing test** in `broadcaster.rs`:

	```rust
	#[tokio::test]
	async fn bumps_the_generation_once_when_a_new_commit_lands() {
	    let repo = fixture_repo().await;
	    let broadcaster = StatusBroadcaster::with_refresh_intervals(/* fast intervals */);
	    let mut graph = broadcaster.subscribe_graph(repo.path()).await;
	    let first = graph.recv().await.expect("initial generation");
	    repo.commit_file("a.txt", "one").await;
	    let bumped = graph.recv().await.expect("generation after commit");
	    assert!(bumped.generation > first.generation);
	}
	```

- [ ] **Step 07.3: Run it; expect FAIL** (`subscribe_graph` not found).

	```bash
	cargo test -p bibcode-server git::broadcaster::
	```

- [ ] **Step 07.4: Implement the signature + generation.** On the existing ref-refresh tick, compute `refs_signature` (Phase 01's helper: hash of `for-each-ref` objectnames+refnames, resolved HEAD, and the worktree inventory generation). When it differs from the stored value, increment the repository's generation and notify graph subscribers with `{ generation, changed_at_ms }`.

- [ ] **Step 07.5: Run the test; expect PASS.**

- [ ] **Step 07.6: Add the no-op test** — two consecutive polls with no repository change emit nothing beyond the initial value. This is the test that proves the signal is not a disguised poll-through.

- [ ] **Step 07.7: Add the poller-lifecycle tests.** (a) Subscribing to both status and graph for one repository starts **no more poller tasks than exist today** (the two spawned at `broadcaster.rs:158-163`) — assert on the broadcaster's internal state/task handles, not on timing. (b) A **graph-only** subscriber (no status subscriber anywhere) still starts those pollers and receives generation bumps — this is the failure mode the existing subscribe-gated start would otherwise produce for a Git Manager opened on its own.

- [ ] **Step 07.8: Add the immediate-refresh test** — a completed operation (Phase 04 fires the existing refresh request) produces a generation bump without waiting for the next tick.

- [ ] **Step 07.9: Add lifecycle tests** — dropping the last graph subscriber stops the extra work but does not tear down a still-subscribed status stream; re-subscribing after a drop resumes and delivers the current generation first.

- [ ] **Step 07.10: Wire `subscribeVcsGraph`.** Stream handler in `git_vcs.rs` following `subscribeVcsStatus` (admission, child cancellation, sender), added to `GIT_VCS_STREAM_METHODS`, registered in `rpc/methods.rs`, scoped read in `auth/scope.rs`, allowlisted in `maintenance.rs`. Add an RPC-level test that a subscriber receives the current generation immediately on connect.

- [ ] **Step 07.11: Cost check.** Confirm the signature costs one `for-each-ref` (plus the HEAD read already performed) per tick and does not add a `git log`, `git status`, or per-ref invocation. Note the measured command count in your progress entry.

- [ ] **Step 07.12: Log-hygiene sweep.** No ref names, paths, or signature contents in log strings — generation numbers and counts only.

- [ ] **Step 07.13: Full gate.**

	```bash
	cargo fmt --all --check
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	cargo test -p bibcode-server
	```

- [ ] **Step 07.14: TDD proof.** Make the signature a constant, re-run — the "bumps once when a commit lands" and immediate-refresh tests must fail while the no-op test still passes. Restore, re-run, confirm green.

- [ ] **Step 07.15: Mark complete.** Phase 07 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, plus a summary including the per-tick command count.

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] A commit, branch change, tag change, or worktree change made outside BiBCode bumps the generation exactly once.
- [ ] A quiet poll tick emits nothing.
- [ ] No poller task was added beyond the two that already exist per repository, and no filesystem watcher was introduced.
- [ ] A graph-only subscriber (no status subscriber) still starts the pollers and receives bumps.
- [ ] A completed operation triggers an immediate generation bump.
- [ ] Existing `subscribeVcsStatus` behavior is unchanged (its tests still pass untouched).
- [ ] `cargo fmt --all --check`, clippy with `-D warnings`, `cargo test -p bibcode-server` all clean.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 11 subscribes from the client. Record in your notes: the event shape you emit, whether the current generation is delivered on connect (it must be), and the reconnect semantics — a client that reconnects must be able to detect it missed changes by comparing generations.
- If the generation is per-repository rather than per-project (it should be — several projects can share a common directory), say so explicitly; Phase 11 keys its cache on that assumption.
- Note the poll interval actually in effect, so the docs phase can state the real worst-case staleness rather than guessing.
