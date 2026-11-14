Verdict: **Needs rework.** All 40 requirement IDs have task assignments, but several scenarios are contradicted or left incomplete by the implementation steps. The main problems are incompatible interfaces, person-request lifecycle gaps, and non-atomic recovery operations; these need correction before execution.

Coverage: requirement → tasks, with gaps marked.

Task numbers refer to the supplied phase files. “Covered” means the plan specifies relevant implementation and tests, not that those tests have run.

| Requirement | Tasks | Scenario coverage and gaps |
|---|---|---|
| R1 Directory | 5.3, 8.5 | Panels, terminals, caller exclusion and other-project invisibility covered; dependency problem below. |
| R2 Sending | 5.1, 5.4, 6.7, 9.2 | Acceptance, invalid input and initial atomic insertion covered. **Gap:** subsequent requeue is not atomic. |
| R3 Identity | 5.4, 8.2 | Spoofed sender and unknown fields covered. Preserve the separate person-only invariant. |
| R4 Project scope | 5.3, 5.4, 8.5 | Cross-project directory and send refusals covered. |
| R5 Opt-in | 5.2, 5.3, 6.4, 7.3, 9.2 | Default-off, switching off, rejoining and person-request exceptions covered. **Gap:** delivery races the asynchronous off-switch reconciliation. |
| R6 Mode ceiling | 6.1, 6.4, 8.2, 8.4, 9.2 | Higher/equal/lower modes, changes while waiting, terminal modes and person exception covered. **Gap:** recheck is separated from delivery claim. |
| R7 Chat delivery | 5.5, 11.3 | Idle and busy recipients covered. |
| R8 Envelope | 5.4, 9.2 | Attribution, forged delimiters and person-request rendering covered. **Gap:** literal delivery is not proved through every provider. |
| R9 No user authority | 6.2 | Pending approval, question and ready-session-with-open-request cases covered for agent messages. |
| R10 Replies | 5.6, 8.2, 9.2, 11.3 | Cross-provider round trip, wrong recipient, late replies, deleted sender and person-request no-turn reply covered. |
| R11 Status | 5.5, 5.6, 8.2 | Stage progression and sender-only reads covered. **Gap:** transport failures remain `accepted`. |
| R12 Idempotency | 6.3 | Timeout retry, conflicts, reply retry and concurrent duplicate IDs covered. |
| R13 Ordering | 6.4 | Two senders and interleaved person messages covered. Recovery after a requeue crash is missing. |
| R14 Hops | 6.5, 8.2, 8.4, 9.2 | Chat ping-pong, slow/fast terminal exchanges, person input and person-request reset covered. |
| R15 Limits | 6.6 | Flooding, rate window and backlog release covered sequentially. **Gap:** concurrent admission and person-row exclusion. |
| R16 Terminal identity | 8.1, 8.2 | Sibling identity, restart, terminal-to-panel and missing credential covered. **Gap:** revocation is terminal-wide rather than generation-specific. |
| R17 Terminal delivery | 8.3, 8.4, 11.3 | Ready/unsafe states and fetch-versus-paste distinction covered. **Gap:** real OpenCode submission proof is absent. |
| R18 Unavailable recipient | 6.7, 8.4 | Errored chat and terminal close covered for agent messages. |
| R19 Persistence | 5.1, 6.7 | Stored rows and running/idle restart cases assigned. **Gap:** crash-safe release of held messages. |
| R20 Cancellation | 6.7, 8.4 | Queued, held, delivered-but-unfetched terminal messages and too-late cancellation covered. |
| R21 Visibility | 5.4, 7.1, 7.2 | Transcript attribution, activity outcomes and diagnostic canaries covered. |
| R101 Control | 2.1, 9.1 | Chat keyboard path, AI Terminal controls and absence in plain terminals covered. |
| R102 Targets | 2.1 | Existing agents, new panel, source exclusion and other-project filtering covered. |
| R103 Disabled reasons | 2.1, 4.3, 9.3 | Listed reasons, visible disabled entries, terminal takeover exception and usage warning covered. |
| R104 Clicked source | 2.1, 2.2, 9.1 | Side-by-side source selection and preview naming covered. |
| R105 Preview | 2.2, 3.2, 4.2 | Trimming, removal, backing out and note preservation covered. |
| R106 Message | 2.2 | Note-only delivery and empty/whitespace refusal covered. |
| R107 Review | 2.1, 3.1 | Scope, provider guard, editable target warning and checkout filtering covered. **Gap:** new-panel sends bypass request tracking and asynchronous failure handling. |
| R108 Second opinion | 3.2, 9.1 | Long/streaming answers and empty terminal covered. **Gap:** “last person message” becomes “last user-role message,” including agent messages. |
| R109 Handoff | 4.1, 4.2 | Long thread, first message, tail and source continuing covered for the new RPC. **Gap:** D107’s shared builder is not adopted by resume and side-chat seeding. |
| R110 Takeover | 4.1, 4.2, 9.1, 9.3 | Unresponsive agent, terminal source/target and output fallback covered in intent. Terminal-source admission needs an explicit implementation contract. |
| R111 Terminal source | 9.1 | Selection precedence, bounded output and zero terminal input covered. |
| R112 CLI conversation | 10.1, 10.2 | Session/path refusal and fallback assigned. Dependency, test-sensitivity and profiler-classification gaps remain. |
| R113 Person delivery | 1.2 | Idle, cross-project refusal, credential separation and exemption from agent policies assigned. **Gap:** pending approvals/questions outside a running session. |
| R114 Provenance | 1.2, 2.3 | Person attribution and same-project cross-worktree delivery covered. |
| R115 Person→terminal | 9.2 | Off-switch exception, no-turn reply, queued/delivered/read distinctions and all seven amendments explicitly covered. Integration is incomplete below. |
| R116 Answer notice | 1.3, 3.3, 9.3, 11.2, 11.3 | Correct-turn answer, draft-only Bring back, reload, terminal source and failed turn assigned. **Gaps:** new-panel reviews, old/deleted-target answers, capped snapshots and terminal unread tracking. |
| R117 Usage hint | 4.3 | Usage reset and missing-signal cases covered. “Put Take over from first” is reinterpreted rather than implemented literally. |
| R118 Failed sends | 1.1, 1.2, 2.2 | Retry, conflict, lost response and missing target covered. **Gap:** the new-panel Review override declares success before creation/send finishes. |
| R119 Request state | 1.1, 1.3, 2.4, 9.3 | Most state rows assigned. **Gaps:** error-before-send, terminal cancellation, consumed terminal closing, and new-panel reviews. |

There are **no completely unassigned requirement IDs**. Tasks 1.1, 1.4 and 11.1 are supporting work with identifiable consumers; I found no wholly unrelated task. The missing work is mostly inside supposedly covered requirements.

Findings, most severe first:

For compactness, `P1`–`P11` below mean the corresponding `docs/plans/2026-11-13-agent-messaging/phases/PHASE-*.md` file supplied in the reading list. `Spec` and `Plan` mean `spec.md` and `plan.md` in that same plan directory.

| # | Severity | Location (file:line) | Issue | Evidence | Fix |
|---|---|---|---|---|---|
| 1 | Blocker | P1:106; P5:48,59 | **Two tasks independently export `AgentAddress`.** | Task 1.4 creates a validated address schema in `sendRequests.ts`; 5.2 creates another in `agentMessaging.ts`. Both instruct adding wildcard exports to the contracts index, whose existing structure is wildcard exports (`packages/contracts/src/index.ts:1`). This leaves an ambiguous public export and different validation policies. | Define the address schema once and import/re-export that same declaration. Specify its canonical owner in both interfaces. |
| 2 | Major | P1:50,68; P5:105 | **The shared dispatcher contract loses the information needed for actor attribution, and the later actor change weakens the person-send engine guard.** | Task 1.2 extracts admission into a dispatcher accepting only command and `UploadOwner`. Existing attribution needs `RpcSessionContext` and stamps the admission claim (`apps/server/src/production/orchestration_rpc.rs:164`). Separately, 1.2 rejects `person_send` when `from_agent`; 5.4 changes that predicate to mean only `mcp-client`, excluding hosted agents. | Specify one dispatcher accepting an already authenticated/stamped claim or explicit trusted actor context. Keep separate predicates for “outside-agent provenance permitted” and “any agent forbidden from person-send.” Test both actor kinds with `personSend`. |
| 3 | Major | P1:64,69,93; Plan:460 | **Person sends bypass the required waiting behavior.** | The approval test deliberately makes the session `running`. Existing dispatch resolves `queued: true` to false unless the session is running/starting or compacting (`apps/server/src/production/orchestration_rpc.rs:715`). Pending claims do not repeat the approval gate (`apps/server/src/persistence/repositories.rs:1343`); that gate belongs to queued promotion (`:5315`). Task 1.3 also substitutes a different scenario for Spec R119’s error-before-send case (`Spec:1285`). P13 records a proposed exception, not approval. | Add person-request admission for open approvals/questions and already-held/error queues. Test `ready + pending approval`, `ready + pending question`, and **error first, then send**, without changing the spec scenario. |
| 4 | Major | P3:30 | **New-panel Review intentionally drops three binding guarantees.** | The task creates no request, row or answer notice, despite “for every send” in R119 (`Spec:1276`) and the explicit new-panel target (`Spec:935`). It treats the launcher’s immediate `null` as success, but the launcher starts `createPromptedChatPanel` with `void` and returns immediately (`apps/web/src/components/ChatView.tsx:5045`). Consequently later creation/send failure cannot preserve this preview under R118. | Extend/reuse the launcher through an awaited result containing panel/message identity. Create and track the request, and preserve the preview on failed or unknown outcomes. Do not infer a spec exemption from the current return type. |
| 5 | Major | P1:96; P9:42,56 | **Queued person requests to terminals have no cancellation implementation.** | Task 1.3 implements cancellation solely through `thread.turn-delivery.resolve`. Task 9.2 deliberately stores terminal requests without an outbox entry, but does not extend `SendRequestsService::cancel`. Existing cancellation only resolves an existing queued outbox row (`apps/server/src/orchestration/engine.rs:7053`, `:7076`). | Add a person-authorized terminal cancellation branch, atomically canceling the request and its unfetched mailbox row. Test cancellation racing inbox fetch and pointer delivery. |
| 6 | Major | P8:81; P9:66,75 | **A terminal request already read can remain unanswered forever after its generation ends.** | The pointer only fails **unconsumed** rows. Task 9.3 relies on those failure callbacks to change requests from `read` to `not_answered`. A consumed person request produces no such failure, although R119 explicitly includes read requests (`Spec:1291`). The task’s close/restart tests do not require starting from `read`. | On generation termination, reconcile every unanswered person request, including consumed ones. Keep completed answers. Test close, exit, restart, replacement and server restart after inbox fetch. |
| 7 | Major | P3:63,77,79 | **Bring back cannot reliably retrieve the stored answer.** | The plan stores only an answer message ID, then searches `useThreadDetail`’s messages. That hook reads the ordinary thread state (`apps/web/src/state/queries.ts:39`), whose subscription requests a history window (`packages/client-runtime/src/state/threads.ts:388`); the initial window is bounded to ten user turns (`apps/server/src/production/orchestration_rpc/thread_history.rs:32`). Deleted targets are not readable through thread snapshots (`apps/server/src/production/orchestration_rpc.rs:2405`). Therefore an old answer, or an answer retained after target deletion, becomes “no longer available.” | Provide request-scoped answer retrieval independent of the current history window and target visibility. Test reload after more than ten later turns and Bring back after target deletion. |
| 8 | Major | P6:80,91 | **Releasing a held message can duplicate delivery after a crash.** | `requeue` dispatches a fresh turn and **then** calls `replace_delivery`. A crash between those operations leaves a live outbox entry while the message still names its old entry. Startup can requeue it again or reconcile against the wrong command. The initial insertion’s transaction in 5.1 does not cover this release path. | Commit the new outbox entry, delivery linkage and held→queued transition together, using an expected previous state/link. Add a crash-boundary test and concurrent release/cancel test. |
| 9 | Major | P5:117; P6:140 | **A failed transport can leave an agent message permanently `accepted`.** | Task 5.5 maps outbox `uncertain` and `failed` to `accepted`. Task 6.7 adds held-queue handling but never replaces those mappings. The actual worker can settle delivery to `Uncertain` after exhausted recovery (`apps/server/src/production/turn_delivery.rs:998`). The planned tests cover a failed recipient turn, not delivery that never starts one. | Define readable states/reasons for definite delivery failure and uncertain delivery, including what a later person retry does. Test both paths through the tracker. |
| 10 | Major | P6:19,30,80 | **The safety check is not bound to delivery admission.** | The guard runs while collecting candidates, before further awaited work and the final claim (`apps/server/src/production/turn_delivery.rs:1140`). The existing SQL claim checks neither messaging enablement nor the mode ceiling (`apps/server/src/persistence/repositories.rs:1343`). Turning messaging off is handled separately by an asynchronous tracker. A candidate can pass the check, then be claimed after either policy changes. | Fence/check the authoritative policy at the delivery claim boundary and coordinate policy changes with that boundary. Add paused-between-check-and-claim tests for both mode changes and switching off. |
| 11 | Major | P6:120,129,131 | **Rate and backlog limits are check-then-insert races.** | The task counts rows before dispatch; two concurrent calls can both see 29 sends or 19 pending messages and both commit. Its six tests are sequential. Also, `count_unconsumed` is specified by status only, so later person mailbox rows can consume the agent-message backlog allowance. | Enforce counts and insertion within the same admission transaction or equivalent serialized reservation. Count agent-origin rows only. Test simultaneous sends from one sender and multiple senders. |
| 12 | Major | P8:23,35 | **The credential revoker can revoke the newly restarted terminal.** | The API is `revoke_terminal(thread_id, terminal_id)`, and the task calls it on `Restarted`. The launch hook runs before the new session is published (`apps/server/src/terminal/manager.rs:2336`), while `Restarted` carries the new snapshot, not an ended-generation field (`apps/server/src/terminal/model.rs:377`). A terminal-wide revocation can remove the new credential as well as the old one; a delayed old exit has the same problem. | Revoke a specific generation, or sweep credentials against the current live generation. Assert that the **new token still verifies after all restart/old-exit events have been processed**. |
| 13 | Major | P2:22; P3:41,50; P4:32 | **“From the person” is incorrectly inferred from `role === "user"`.** | The proposed source type retains only role/text/streaming, and 3.2 explicitly tests that the last user message is the last person message. But 5.4 delivers agent envelopes as user-role messages with a hosted-agent actor (`P5:102`). Existing message events also use user role for attributed messages (`apps/server/src/orchestration/engine.rs:5342`). Second opinion and handoff can therefore label another agent’s text as the person’s task. | Preserve attribution in the source type and define a shared person-message predicate. Test person → hosted-agent message → answer, plus a thread whose first message came from an agent. |
| 14 | Major | P4:29,33 | **D107’s shared first-message handoff is not implemented.** | The task explicitly keeps resume and side-chat output unchanged and leaves their wrappers calling the old tail builder. Those callers currently use `thread_context_lines` directly (`apps/server/src/production/provider_runtime.rs:8230`, `:8243`). D107 requires resume, side-chat seeding, Hand off and Take over to use one first-message-plus-tail builder (`Spec:1445`). | After characterization/extraction, change all four consumers to the agreed builder and update their expected output. Preserve framing and escaping, not the obsolete tail-only content. |
| 15 | Major | P1:84,96; P3:77; P9:66,79 | **Durable notices can disappear from the client without dismissal.** | The only web subscription requests the newest 200 requests for the whole environment, with no paging. Older undismissed requests fall out after reload. Separately, 3.3 expressly excludes terminal sources from unread tracking, whereas 9.3 assumes the tracker already marks their owning thread and does not name the tracker among its edits. | Add a complete bounded paging/per-thread retrieval strategy for undismissed requests. Explicitly extend the unread tracker for terminal sources and test reload beyond 200 requests and an answer arriving while the terminal is closed. |
| 16 | Major | P8:89,102,113,115; P10:40,42; P6:98,118 | **The task dependency graph permits consumers before their producers.** | 8.2 tests terminal directory entries supplied by 8.5, but the prescribed order runs 8.2 first. 8.5 consumes `TerminalPointer`/`PointerTerminals` from 8.4 without depending on it. 10.2 consumes types and a file created by 10.1 but depends only on 9.1. Tasks 6.5/6.6 modify `policy.rs`, created by 6.1, without that edge. | Add the missing edges; resolve the 8.2/8.5 sequencing by moving the complete terminal-directory behavior before the CLI integration test or moving that test to the later task. Serialize tasks that share files. |
| 17 | Major | P5:101,106,107; P11:77 | **The literal-delivery and terminal acceptance gates are weaker than the spec.** | A parser assertion proves only that the outer envelope is not recognized by BiBCode’s command parser. The task permits unsupported Claude flags or possible Codex skill expansion to be recorded and still closed, without the required received-input proof. R8 requires no command, skill or file expansion (`Spec:333`). R17 verification also calls for each observable CLI (`Spec:759`), but 11.3 names only Claude and Codex. | Make provider-boundary literal-delivery tests an acceptance gate; unresolved behavior must remain unresolved. Include OpenCode in terminal submission/inbox proof. |
| 18 | Minor | P1:24; P5:19; P9:42; P10:34 | **Several additional interfaces or test instructions cannot be followed literally.** | 1.3 requires automatic dismissal at `read`, but the only store dismissal API accepts final states and `StateChange` cannot set `dismissed_at`. 5.1 exposes crate-private `NewAgentMessage` through public `CommandAdmission` (`apps/server/src/orchestration/delivery.rs:79`), conflicting with warnings-denied validation. 9.2 edits `reply_as` in `delivery.rs`, although 8.2 produces it in `mod.rs`, which phase 9 forbids touching. 10.1’s proposed `File::open` mutation would still be rejected by its earlier `symlink_metadata` check, so the stated link test need not fail. | Reconcile the exact APIs, visibility and file ownership before execution. Add a real swap-between-check-and-open test for the descriptor-based file safety guarantee. |
| 19 | Minor | P11:52,55,80,82; P10:42,55 | **Final validation overstates what it proves.** | The reload case may assert notice absence after Bring back, which does not prove survival of a pending notice. Changing an assertion to an intentionally wrong value tests the assertion, not the product regression. The final Rust command is `--lib`, omitting the integration targets changed by phase 1; the repository server test script runs the whole package (`apps/server/package.json:9`). Finally, the report says no RPC waits on a provider, while 10.2 adds a five-second Codex request; such methods belong in `is_long_running` (`apps/server/src/diagnostics/profiler/latency.rs:105`). | Reload before consuming/dismissing the notice; mutate product behavior for sensitivity checks; run affected integration targets; add the Codex conversation RPC to profiler classification and correct the coverage report. |

**Dependencies and parallelism**

- **Round 3, phases 3 and 5:** no direct source-file intersection in the task Files lists. The type-only exceptions in 5.4 affect files phase 3 explicitly excludes. The 33 existing `CommandAdmission` construction sites are spread across the files listed by 5.1; they do not collide with phase 3’s web files. Some are omitted from the master file map, so that map is not actually a complete generated inventory (`P5:18`; `Plan:185`).
- **Round 4, phases 4 and 6:** no direct source-file intersection either. Phase 4’s `provider_runtime.rs` change follows phase 5’s edits in the previous round; it does not overlap phase 6.
- **Build outputs are shared:** both parallel rounds run workspace typechecks/Cargo checks against the same checkout and `target` directory. The runbook expressly calls for sequential broad validation (`docs/testing/cross-platform-validation.md:1858`). Reserve integrated validation for the executor or provide isolated checkouts/output directories.
- I found no clearly unnecessary **phase** dependency that should be removed. The important missing dependencies are within phases, listed in finding 16.

**Task size, self-containment, skills and consistency**

These are planning judgments, distinct from the source-backed failures above:

- Tasks **1.2, 1.3, 5.4 and 8.4** are too broad for dependable fresh-session execution: each combines several runtime boundaries, a substantial test harness and multiple failure policies. Split them into independently verifiable behavior changes—for example, person-send admission versus retry recovery, and terminal inbox semantics versus pointer publication.
- The store/contracts tasks are layer-oriented, but their shared consumers justify them. I would not remove them as trivial work.
- Every task has a `Done when`, and the main command steps generally have expected outcomes. The remaining self-containment problem is incompatible or missing APIs, not generic “TBD” prose.
- The security, Rust, accessibility, React and profiler skill selections generally fit. **`rust-best-practices` is not available in this session’s supplied skill catalog**, despite the plan recording a Claude installation. Execution must record that host-specific gap under `execute-plan.md:59`. Task 10.1 also requires a React review in its steps without listing that skill.
- The **43 task IDs and titles match progress.md**, and the recorded spec hash matches the current file. However, `execute-plan.md:8` already claims a completed Codex review while `progress.md:6` says pending. Phase 7 still says phase 4 owns files “in this round” despite being in round 5 (`P7:7`), and the master map calls `reference_docs.rs` a modification while 11.1 specifies read-only inspection (`Plan:326`; `P11:18`).

**What the plan got right**

- It explicitly separates person authority from agent authority and enumerates all seven person-to-terminal amendments (`P9:40,53`).
- Initial agent-message/outbox insertion is placed in the existing transaction, with a rollback test (`P5:36,38`).
- Terminal generation binding, readiness distinct from activity, and consumed distinct from pasted are explicit design constraints (`P8:23,45,67`).
- Answer correlation uses the initiating turn rather than the target’s latest answer; Bring back remains a draft (`P1:93`; `P3:64`).
- The proposed parallel rounds avoid direct source-file collisions. Preserve that separation while fixing shared validation and intra-phase ordering.
- The approved choices—off by default, same project, fixed limits, terminal recipients treated as full access, no steering, and pointer-only terminal input—are **out of scope for criticism**.

**Open questions the plan cannot answer**

- Whether each supported provider actually preserves literal agent-message text without command, skill or file expansion.
- Whether the installed Codex terminal can call the loopback agent endpoint under its actual sandbox, beyond merely retaining the environment variable.
- Whether the observed Codex connection returns the required root-conversation text. The conditional fallback is documented, but remains unverified.
- Whether P13’s requested spec departures were ever approved. The supplied binding spec still requires those behaviors, so this review treats them as gaps.

The most likely execution stops are the duplicate contracts export, phase 8’s directory/CLI ordering, phase 10’s missing dependency, terminal cancellation integration, and the new-panel Review acceptance tests.

This was a static, read-only review at `a9938193b`. No files changed; builds, tests, provider probes and UI runs were not executed. CodeGraph sync was skipped because it can write generated files; graph data was not used.


## Handling

Reviewer: Codex gpt-6-astra, effort high, round 1. Verdict: Needs rework. All 19 findings were
accepted and none was rejected. The three authors of the phase files checked the findings that
touched their files against the code; the plan owner spot-checked the citations of findings 2, 3
and 4 and did not re-verify the rest.

| # | Outcome | What changed |
|---|---|---|
| 1 | fixed | `AgentAddress` is declared once in task 1.4; task 5.2 imports it. |
| 2 | fixed | Task 1.2 produces `ServerActor` and a dispatcher that stamps the claim; two engine predicates; both actor kinds tested with `personSend`. |
| 3 | fixed | A person's send queues behind an open approval, question, held queue or errored session; the spec's order is tested. The proposed departure is withdrawn. |
| 4 | fixed | A new-panel Review is a tracked request through an awaited launcher result. The proposed departure is withdrawn. |
| 5 | fixed | Task 9.2 adds a person-authorized cancel for terminal requests, with race tests. |
| 6 | fixed | Task 9.3 marks every unanswered request of an ended generation not answered, read ones included. |
| 7 | fixed | Answer text is stored with the request and read through `sendRequests.getAnswer` (tasks 1.1, 1.3, 1.6, 3.3). |
| 8 | fixed | Release of a held message is one transaction with an expected previous state (tasks 5.1, 6.4). |
| 9 | fixed | Transport failure and uncertain delivery have readable states and reasons (tasks 5.5, 6.7). |
| 10 | fixed | The messaging and mode checks run inside the delivery claim (task 6.1). |
| 11 | fixed | Rate and backlog are counted in the insert transaction, for agent rows only (task 6.6). |
| 12 | fixed | Credentials are revoked per generation; the new token is tested after restart events (task 8.1). |
| 13 | fixed | A shared person-message predicate on the web and the server (tasks 2.1, 3.2, 4.1). |
| 14 | fixed | Resume, side-chat seed, Hand off and Take over use the one builder (task 4.1). |
| 15 | fixed | The request stream is paged with no cap; the unread tracker keys on the source thread (tasks 1.6, 3.3). |
| 16 | fixed | Missing dependency edges added in phases 6, 8 and 10. |
| 17 | fixed | Literal delivery is an acceptance gate in the new task 5.7; OpenCode is in the final run. |
| 18 | fixed | The four interface and test-instruction mismatches are corrected. |
| 19 | fixed | Reload before the notice is consumed, full-package server tests, the waiting Codex request classified as long running. |
| notes | fixed | Tasks 1.2, 1.3, 5.4 and 8.4 split (1.5, 1.6, 5.7, 8.6); header and file-map inconsistencies corrected; broad checks run per lane and after integration. |
| open questions | kept for approval | Three readings of the spec are listed as P13 in plan.md. |
