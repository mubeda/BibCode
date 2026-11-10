**Verdict: Needs rework.**

R62’s ordinary Save all, Discard, Cancel, conflict, and clean-close cases are testable. The remaining gaps concern lifecycle guarantees, integration ownership, and native proof.

1. **P1 — The timeout explicitly permits an unclosable app.** [Phase 9:63](phases/PHASE-09-desktop-save-and-close.md) says an unanswered request keeps the window open, contradicting line 17 and the test that expects eventual closure. A crashed renderer can therefore reject every close forever. **Fix:** choose one bounded escape policy, distinguish “awaiting the person” from “renderer unavailable,” and make the implementation instruction and tests agree.

2. **P1 — Close interception alone cannot protect every exit path.** Phase 9:16 and :63 defer or omit essential ordering. [`lib.rs:286`](apps/desktop/src-tauri/src/lib.rs) immediately stops the embedded server on `ExitRequested`; Save all must finish before this happens. [`bridge.rs:1104`](apps/desktop/src-tauri/src/bridge.rs) requests restart, while [`updates.rs:896`](apps/desktop/src-tauri/src/updates.rs) stops backends before restarting at line 935. The locked Tauri version ignores `prevent_exit()` for restart requests. Windows logout can reach `Exit` without `ExitRequested` (`lib.rs:317`). **Fix:** specify asynchronous ordinary-close/quit approval before teardown; guard relaunch and update installation before their irreversible preparation; allocate `updates.rs`; and state the policy and limitations for OS termination explicitly. Add path-specific tests, including Cancel leaving the backend usable.

3. **P2 — The close dialog has no allocated application-level mount point.** Phase 9:6 and :52 own the Files directory but omit [`ChatView.tsx:1778`](apps/web/src/components/ChatView.tsx), which owns the registry. Its Files view is conditionally mounted (`ChatView.tsx:7279`), so attaching the guard only there misses retained edits while another surface is shown. **Fix:** allocate the registry owner or an appropriate persistent application host, its bridge subscription, dialog mounting, and integration tests. Cover closing while Files is hidden and closing with no Files component mounted.

4. **P2 — The added plan-download fix lacks a defined error owner and focused tests.** Phase 9:42 changes `proposedPlan.ts`, but [`downloadPlanAsTextFile`](apps/web/src/proposedPlan.ts:117) currently returns `void`; both [`PlanSidebar.tsx:100`](apps/web/src/components/PlanSidebar.tsx:100) and [`ProposedPlanCard.tsx:100`](apps/web/src/components/chat/ProposedPlanCard.tsx:100) ignore its result. Introducing a rejecting native save promise without handling it can leave failures silent. **Fix:** explicitly handle rejection inside the helper or allocate the callers and their error UI. Add save, cancellation, failure, and browser-fallback tests for this additional changed behavior.

5. **P2 — The native close E2E needs an owned lifecycle recipe.** Phase 9:62 requires actually closing the application, but the current runner groups specs into one session (`wdio.conf.ts:55`). Its shutdown helper also stops the backend **before** requesting window close ([`app-lifecycle.ts:29`](apps/desktop/e2e/support/app-lifecycle.ts:29)), which cannot prove Save all through the live server. Phase 8’s executable task steps still register and run only the older two specs despite its expanded checkpoint. **Fix:** allocate the lifecycle helper/config changes, isolate destructive close cases, handle an already-closed application during teardown, and add the third spec’s execution step. Require a native close request → real DesktopBridge event → rendered dialog → reply command → disk/process assertion. The export seam should bypass only the picker, preserving the real command and write.

6. **P2 — “Contract steps may run beside a server phase” is unsafe scheduling guidance.** Phase 9:12 makes this exception, but [`package.json:33`](package.json:33) shows `vp run check:contracts` invokes `cargo test -p bibcode-server --test rpc_wire`. **Fix:** place that command, workspace Clippy, desktop tests, and other Rust-bearing checks under the same exclusive Rust build slot. Pure TypeScript work can remain parallel.

7. **P3 — Round 2 has an undeclared shared-document owner.** Phase 9:6 and [Phase 3:6](phases/PHASE-03-status-during-push.md) both own `docs/architecture/overview.md`, while `plan.md:152` still says rounds 2–5 contain one phase each. **Fix:** record both round-2 lanes and assign section ownership or executor integration for that document.

The export’s main wiring ownership is otherwise covered: contracts → `tauriDesktopBridge.ts` → Rust command → permission → production registration and audited command lists in `lib.rs`. Serializing desktop Cargo work is also correct because `bibcode-desktop` depends on `bibcode-server`.

Read-only validation: reviewed the requested diff and source; `git diff --check 3075a1355 -- docs/plans/2026-11-09-issue-batch-340-345-290` passed. No files were written.  
Not run: tests, builds, native scenarios, or CodeGraph sync. Profiler-related risk is shutdown ordering and warning coverage, which Phase 9 must preserve and verify.



## Handling (coordinator with the advisor, 2026-11-10)

Reviewer: Codex gpt-6.1-sol, effort high, round 1 of 2 for the Phase 9 change. All seven findings accepted.

1. Accepted. One escape rule: without an acknowledge from the web within a few seconds the window closes with a logged warning; after an acknowledge the desktop waits for the person. Written into R62, the design-note list (item 2) and Task 9.3's tests.
2. Accepted. Approval must finish before `lib.rs` line 286 stops the embedded server (design-note item 3, Task 9.3 test `quit_waits_for_the_web_before_the_server_stops`, Cancel keeps the server usable). Restart and update install start from the web through `restartApp` and `installUpdate`, so the web asks before calling them (Task 9.2); `updates.rs` needs no change. OS session end is written into R62 as outside the requirement.
3. Accepted. `ChatView.tsx` hosts the guard and the dialog next to the registry owner; Task 9.2 tests the guard with the Files view unmounted.
4. Accepted. `downloadPlanAsTextFile` handles a rejection itself with the existing toast; Task 9.1 adds save, cancel, failure and browser-fallback tests for it.
5. Accepted. The end-to-end spec and the lifecycle change move to a new Task 8.6 in Phase 8, which owns the specs and `wdio.conf.ts`; destructive close cases run in their own app session and teardown tolerates an exited app.
6. Accepted. Every cargo, contract-check and Clippy step of Phase 9 waits for the Rust slot; the native protocol is its own Task 9.3 in the Rust queue; Tasks 9.1 and 9.2 keep their TypeScript work parallel.
7. Accepted. `plan.md` now records Phase 3 and Phase 9 in round 2, and the coordinator writes Phase 9's DesktopBridge paragraph in `docs/architecture/overview.md` at integration.

Also folded in: amendment A6 (Task 6.10, read-only checkbox keeps source history), approved by the user.
