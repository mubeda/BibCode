Verdict: **Needs rework.** Most round-1 corrections are present, but the revised plan still has gaps in authorization preservation, retry recovery, terminal safety, and live request updates. Several interfaces and task dependencies also contradict their prescribed implementation or tests.

References below use **P1–P11** for the corresponding phase files under `docs/plans/2026-11-13-agent-messaging/phases/`, and **Plan**, **Spec**, and **Progress** for files in that plan directory. Findings describe consequences of implementing the plan as written, not defects already implemented.

**Coverage: requirement → tasks**

“Covered” means implementation and scenario tests are assigned; it does not mean validation ran.

| Requirement | Tasks | Coverage / remaining gap |
|---|---|---|
| R1 Directory | 5.3, 8.5 | Covered: caller exclusion, panels, terminals, project isolation. |
| R2 Sending | 5.1, 5.4, 6.7, 8.4 | Initial atomic admission covered; recovery gap in finding 6. |
| R3 Identity | 5.4, 8.2 | Credential-derived identity and strict arguments covered. |
| R4 Project scope | 5.3, 5.4, 8.5 | Covered. |
| R5 Opt-in | 5.2, 5.3, 6.1, 6.4, 7.3, 9.2 | **Gaps:** claim synchronization and terminal holding, findings 5–7. |
| R6 Mode ceiling | 6.1, 6.4, 8.2, 8.4, 9.2 | Send/claim checks and person exceptions assigned. |
| R7 Chat delivery | 5.5, 11.3 | Idle/busy scenarios covered. |
| R8 Envelope | 5.7, 9.2 | Forgery, literal-delivery gates and person exception covered. |
| R9 No user authority | 6.2 | Pending approval/question scenarios covered. |
| R10 Replies | 5.6, 8.2, 9.2, 11.3 | Correlation, wrong recipient, late reply and no-turn person answer covered. |
| R11 Status | 5.5, 5.6, 8.2 | **Gap:** retrying a final failed delivery, finding 10. |
| R12 Idempotency | 6.3 | Agent send/reply retries and conflicts covered. |
| R13 Ordering | 6.4 | Normal FIFO covered; held-entry recovery gap, finding 6. |
| R14 Hops | 6.5, 8.6, 8.2, 9.2 | Chat/terminal exchanges, elapsed time and person resets covered. |
| R15 Limits | 6.6 | **Gap:** terminal-recipient insertion bypasses the admission checks, finding 7. |
| R16 Terminal identity | 8.1, 8.2 | Sibling isolation, generation revocation and CLI identity covered. |
| R17 Terminal delivery | 8.3, 8.4, 8.6, 11.3 | Readiness, pointer versus fetch and three-CLI proof covered. |
| R18 Unavailable recipient | 6.7, 8.6 | Error, close and generation-ending scenarios covered. |
| R19 Persistence | 5.1, 6.7 | Restart scenarios assigned; held withdrawal recovery gap, finding 6. |
| R20 Cancellation | 6.7, 8.6 | Agent cancellation scenarios covered. |
| R21 Visibility | 5.4, 7.1, 7.2 | Attribution, activity and diagnostic canaries covered. |
| R101 Control | 2.1, 9.1 | Chat keyboard path, AI Terminal controls and plain-terminal exclusion covered. |
| R102 Targets | 2.1 | Existing agents, new panels and isolation covered. |
| R103 Disabled reasons | 2.1, 4.3, 9.3 | Listed scenarios covered. |
| R104 Clicked source | 2.1, 2.2, 9.1 | Covered. |
| R105 Preview | 2.2, 3.2, 4.2 | Trimming, removal, backing out and draft preservation covered. |
| R106 Message | 2.2 | Note-only and empty/whitespace cases covered. |
| R107 Review | 3.1 | Scope, checkout, guard and tracked new-panel launch covered. |
| R108 Second opinion | 3.2, 9.1 | Person attribution, long/streaming answer and empty-terminal scenarios covered. |
| R109 Handoff | 4.1, 4.2 | Shared builder covered; contradictory boundary test, finding 14. |
| R110 Takeover | 4.1, 4.2, 9.1, 9.3 | No-send-to-picked-agent and terminal paths covered. |
| R111 Terminal source | 9.1 | Selection precedence, bounded output and zero terminal input covered. |
| R112 CLI conversation | 10.1, 10.2 | Reader safety/fallback assigned; **metadata gap**, finding 13. |
| R113 Person delivery | 1.2 | Blocking states and credential refusal covered; preserve existing outside-agent attribution, finding 1. |
| R114 Provenance | 1.2, 2.3 | Covered. |
| R115 Person→terminal | 9.2 | Seven amendments assigned; **live state-update gap**, finding 8. |
| R116 Answer notice | 1.3, 1.6, 3.1, 3.3, 9.3, 11.2, 11.3 | **Gaps:** Claude review findings, terminal updates and paged unread tracking, findings 4, 8, 9. |
| R117 Usage hint | 4.3 | Signals covered; action-order interpretation still awaits approval under Plan:462. |
| R118 Failed sends | 1.5, 2.2, 3.1 | **Gap:** replay rules, finding 2. |
| R119 Request state | 1.1, 1.3, 1.6, 2.4, 9.2, 9.3 | **Gaps:** pending-row cancellation and terminal updates, findings 3, 8. |

All 40 requirement IDs have assignments. I found no wholly unrelated task; store, contract and documentation tasks have identifiable consumers. The assignment inventory is in Plan:357–396; the gaps are within assigned behavior.

**Findings, most severe first**

| # | Severity | Location (file:line) | Issue | Evidence | Fix |
|---|---|---|---|---|---|
| 1 | Major | P1:52,72; P5:92 | **The shared dispatcher still cannot preserve an outside MCP actor.** | P1 replaces the public handler’s body with a dispatcher accepting only `Person` or `HostedAgent`, stamping nothing for `Person`. The existing public path obtains an `mcp-client` actor from `RpcSessionContext` at `apps/server/src/production/orchestration_rpc.rs:164`; outside tools call that handler at `apps/server/src/mcp/control.rs:1387`. Neither new variant represents that actor. Mapping it to `Person` loses provenance; mapping it to hosted changes existing source-thread permissions. | Preserve the authenticated outside-agent actor through a trusted actor variant or an already-stamped admission claim. Test an existing outside-agent panel send through the extracted dispatcher. |
| 2 | Major | P1:73,139–143 | **Person-send replay does not reconstruct a stable command or distinguish rejected receipts.** | Task 1.5 rereads thread modes while claiming to rebuild an identical command, and treats every receipt outside `reserved`/`prepared` as accepted. The engine compares the complete payload digest and distinguishes `accepted` from rejection at `apps/server/src/orchestration/engine.rs:2579–2588`. A mode change after reservation causes `CommandConflict`; a rejected receipt can be returned as a successful send. The earlier live-target validation also conflicts with the deleted-target replay test. | Look up an existing request before fresh-target validation; preserve the original command inputs; treat only accepted receipts as acceptance. Add mode-change, rejected-receipt and deleted-target replay cases. |
| 3 | Major | P1:97,152,165 | **A request shown as waiting can offer Cancel that cannot cancel it.** | Task 1.3 explicitly maps a `pending` delivery behind a failed/uncertain head to `waiting`. Task 1.6 cancels only through `Cancel`, which accepts exclusively `queued` outbox rows (`apps/server/src/orchestration/engine.rs:7071–7076`). Thus this planned waiting state cannot satisfy R119’s Cancel behavior. | Specify cancellation for an unclaimed pending delivery, coordinated with claiming. Test the exact “pending behind failed head” scenario and a concurrent claim. |
| 4 | Major | P1:99; P3:30 | **A Claude review can finish with findings but be reported as unanswered.** | The launcher preserves Claude plan mode (`apps/web/src/codeReview.ts:49–55`). Claude’s `ExitPlanMode` findings become `turn.proposed.completed`, then `ThreadProposedPlanUpsert`, not an assistant message (`apps/server/src/provider/claude/runtime.rs:2528–2541`; `apps/server/src/production/provider_runtime.rs:12591–12610`). The existing review fixture emits exactly this result (`apps/desktop/e2e/support/test-project.ts:845–869`). P1 only captures `assistant_message_id`, otherwise recording `no_answer`. | Define the answer for a review completed as a plan card, preserve its turn correlation, and test a tracked new-panel Claude review through answer retrieval and Bring back. |
| 5 | Major | P6:19,28–30 | **Moving the setting check into the SQLite closure does not synchronize it with settings changes.** | The gate returns a `ClaimDecision` after reading a `watch` value; the claiming UPDATE follows. Settings publish independently through `send_if_modified` (`apps/server/src/production/control.rs:692–716`). Switching off between the gate’s read and the UPDATE remains possible. The new tests pause before calling `claim_provider_turn`, not between its policy read and claim. | Hold a policy guard through admission, or serialize policy changes with claiming. Add a deterministic pause inside that boundary. The database mode check is improved; the independent setting still needs coordination. |
| 6 | Major | P6:19,80,91 | **A crash or claim-gate hold can leave the old outbox entry blocking the thread.** | The plan first stores `held`, then separately withdraws the old entry. Startup repeats the off reconciliation, but its stated selection is only `accepted`/`queued`. A crash between those writes—or the claim gate itself setting `held`—leaves a held message with a live pending entry. Requeue atomically creates the replacement but does not retire that old entry. The worker selects only the oldest delivery per thread (`apps/server/src/production/turn_delivery.rs:1641–1645`). | Reconcile held rows whose old delivery remains live before release, or make hold/withdrawal atomic. Test restart between hold and withdrawal, and a claim-gate hold followed by re-enable with a person’s message behind it. |
| 7 | Major | P6:120,131; P8:68,78–80,99 | **Terminal recipients bypass parts of the safety policy.** | Rate/backlog enforcement exists only in `persist_command`; `TerminalPointer::accept` inserts directly without an outbox or `AdmissionLimits`. Therefore terminal sends can exceed both limits. P8 also explicitly excludes terminal rows from messaging-off reconciliation; inbox merely skips them while off, and pointer delivery has no specified off-switch gate or held transition. | Apply atomic agent-only limits to mailbox insertion, and define terminal hold/release and pointer admission while messaging is off. Test chat→terminal and terminal→terminal limits, off while queued, and re-enable. Preserve the person exceptions. |
| 8 | Major | P1:85–86,165; P9:43,56,66 | **Terminal request changes have no specified path to the live request subscription.** | The stream consumes `SendRequestsService::subscribe_changes`. Terminal delivery uses `request_state_sink(store: SendRequestStore)`, replies call store transitions, and generation termination also receives only the store. None is given the service’s `RequestChange` publisher. Terminal mailbox changes produce no chat-turn event for the follower to observe. Stored states can change while the visible row remains queued until reconnect. | Route all request transitions through one publisher, or supply a service-owned transition callback to the terminal paths. Test the subscribed stream through queued→delivered→read→answered and generation termination, without reload. |
| 9 | Major | P1:109,165; P3:66–77 | **Paged bootstrap and one unread timestamp can skip unseen answers.** | Requests arrive newest-first in separate snapshot/page events. The unread tracker stores one maximum `lastSeenAt` per environment. After page one advances it, older pages can contain previously unseen answers that now compare as already seen. There is no bootstrap-complete event or per-request seen identity. The subscription steps also put the initial read before subscribing to changes. | Subscribe before reading; define a completed bootstrap boundary and defer watermark advancement until it, or track notice identities. Test answers on later pages and an update arriving during snapshot construction. |
| 10 | Major | P5:115,124,126; P6:19 | **The new failed-delivery retry test has no implementation path that can enforce it.** | P5 says final failed messages are never recomputed and the tracker reads open messages, yet requires it to dismiss a subsequently retried failed delivery before anything reaches the provider. Existing Retry moves failed outbox rows to pending (`apps/server/src/orchestration/engine.rs:7091–7096`); the new claim gate blocks held messages, not failed ones. The retry can therefore run while the sender still sees final failure. | Define retry policy at the authoritative resolution/claim boundary. Either reject such retries or explicitly support their lifecycle; do not rely on an asynchronous tracker that excludes the row. |
| 11 | Major | P6:89,139–152; P8:12,88,111 | **The dependency graph still allows—or requires—consumers before producers.** | Task 6.4 must pass a release-versus-cancel test, but `AgentMessaging::cancel` is produced only by 6.7, which transitively depends on 6.4. Separately, 8.5 and 8.6 both edit `agent_messaging/mod.rs` without an ordering edge, despite the phase promising serialized shared-file edits. | Move the cancel-race test to 6.7 or introduce cancellation earlier without a cycle. Add an explicit 8.6→8.5 edge if the printed phase order is intended. |
| 12 | Minor | P2:22; P3:41; P5:47–48; P9:43 | **Several exact producer/consumer contracts remain incompatible.** | `SendToAgentSource.messages` omits `id`, but `lastPersonMessage`/`lastFinishedAnswer` must return it. Terminal cancellation emits `not_cancellable`, absent from P1:109’s error union. Task 5.2 adds required decoded capability `agentMessaging` without extending the typed capability fixture (`packages/shared/src/testSupport.ts:4–7,48–52`) or naming that file. | Include message IDs or remove that output requirement; add/use a defined cancellation result; assign the capability fixture update to 5.2. |
| 13 | Minor | P4:45,54; P9:19,30; P10:42 | **Conversation provenance is discarded before takeover previews can display it.** | `TerminalOutputLoader` returns only `{text,truncated}` and takeover labels it “Recent terminal output.” The richer terminal RPC returns `usedSource`/`fellBack`, but `makeTerminalOutputLoader` strips them. P10 additionally requires “The start of the conversation is not included,” without adding a result field or web task that carries that fact. | Carry attachment provenance, fallback and missing-start metadata through the loader and preview contract. Test takeover from readable and unreadable terminal conversations, including bounded Codex history. |
| 14 | Minor | P4:19,30–32; P5:36–39 | **Some prescribed tests cannot prove the stated result.** | P4 requires a 41-message thread to remain byte-identical to the old 40-message tail, while its new algorithm must add the omitted first person message. P5’s filter `turn_delivery_queue_tests::agent_message` selects `agent_message_and_queue_entry_commit_together`, but not the separately named failed-insert and stale-relink tests, despite expecting three tests. | Correct the short-thread boundary and explicitly run all three transactional tests. Require observed test names/counts, not only exit zero. |
| 15 | Nit | Plan:65,328,347; P11:28,31 | **The master inventory and documentation instructions were not fully updated.** | The method inventory/documentation still says six methods and omits `getAnswer`; P11 says four agent-message reasons despite P5 defining seven. The file map still calls `reference_docs.rs` modified although P11:18–19 says read-only, and its fixture-writer list omits phase 7’s regeneration. | Regenerate the inventory from current task contracts and distinguish read-only references from edits. |

**Round-1 verification**

Confirmed resolved in the current plan:

- **#1:** one `AgentAddress` declaration, imported by messaging — P1:109; P5:48.
- **#3:** ready-with-approval/question and error-before-send cases — P1:68,72,97.
- **#4:** awaited, tracked new-panel Review and preserved failed-send preview — P3:19,28–30.
- **#5:** terminal cancellation branch and transactional race tests — P9:43,54.
- **#6:** ended-generation reconciliation includes already-read requests — P8:100; P9:66,75.
- **#7:** stored answer text and request-scoped retrieval — P1:24,163–165; P3:77.
- **#8:** replacement outbox entry and relink now share a transaction — P5:36–38; P6:80. Finding 6 above concerns the separate hold/withdrawal boundary.
- **#9:** failed/uncertain transport outcomes no longer remain accepted — P5:115. Finding 10 above concerns the newly specified retry behavior.
- **#11:** chat admission counts are transactional and exclude person rows — P6:120,129–131. Terminal admission remains the new gap above.
- **#12:** generation-specific revocation and delayed-old-event testing — P8:23,33–35.
- **#13:** explicit person-message predicates preserve actor information — P2:22–26; P3:50; P4:19.
- **#14:** resume, side-chat seed and both handoff actions use the shared builder — P4:32.
- **#15:** the fixed request cap is removed and terminal sources use their owning thread for unread tracking — P1:163–165; P3:66,77. Finding 9 is the new paging interaction.
- **#16:** the originally identified producer edges were added — P6:98,118; P8:111,132; P10:40. Finding 11 identifies remaining/new dependencies.
- **#17:** literal delivery is now a closure gate, and OpenCode is included in terminal acceptance — P5:162; P11:77.
- **#18:** transition dismissal, public companion types, `reply_as` ownership and the check/open swap test are specified — P1:25; P5:19; P9:42; P10:29,34.
- **#19:** reload precedes notice consumption, mutation changes product behavior, full-package Rust tests run, and the Codex wait is classified — P11:52–55,80; P10:58.

**#2 and #10 are only partially resolved**, as findings 1 and 5 explain.

**What the plan got right**

- The person-only guard and hosted-agent provenance are now separate policies; preserve that distinction while repairing the dispatcher — P1:52–53; P5:102–105.
- All seven person-to-terminal amendments have explicit tests — P9:53.
- Request-scoped answer storage removes dependence on loaded history and target survival — P1:163–165.
- Rounds **3 and 4 have no direct source-file collisions**. Task 5.1’s wider `CommandAdmission` edits are server-side; phase 3 owns separate web files. Phase 4’s `provider_runtime.rs` edits follow phase 5, while phase 6 excludes that file — P3:18,40,62; P5:18,91; P4:18; P6:6–7.
- Lane-local broad checks followed by integrated checks address the previous shared-output problem — P3:10; P4:10.
- The 47 task IDs agree with Progress; the spec hash matches. The task splits help, although 1.2, 8.2 and 9.1 remain the largest execution risks by scope — P1:50–77; P8:133–151; P9:18–36.
- Skills generally fit. The Rust-skill absence is explicitly handled; React, accessibility and UI reviews are assigned — P1:27; P2:8; P10:20. No task is obviously unrelated or too trivial to justify its supporting role.

**Open questions the plan cannot answer**

- Whether each installed provider preserves literal text through its actual CLI, and whether all three terminal CLIs submit the pointer successfully. These now correctly remain acceptance gates — P5:162–172; P11:77.
- Whether the live Codex observer can supply the required conversation text; the fallback is explicit — P10:51–52.
- Whether P13’s remaining interpretations are approved, particularly replacing “put Take over from first” with sorting agents inside that action — Plan:454–463; Spec:1306–1308.

The most likely execution stops are the dispatcher extraction, retry tests, cancellation dependency cycle, capability typecheck, Claude review answer test, and terminal stream integration.

This was a static, read-only review at `a9938193b`. No files changed and no builds, tests, provider probes or UI runs were executed. CodeGraph sync was deliberately skipped because it writes generated data. Profiler coverage was reviewed only; no runtime coverage is claimed.


## Handling

Reviewer: Codex gpt-6-astra, effort high, round 2 (the last round). Verdict: Needs rework. It
confirmed 17 of the 19 round-1 fixes. The fixes below were applied after this round and were not
reviewed again. The plan owner verified the citations of findings 1 and 4 in the code; the rest
were checked by the authors of the affected phase files.

| # | Outcome | Reason or change |
|---|---|---|
| 1 | fixed | The public dispatch handler keeps its own actor stamping; the new dispatcher is a separate server-only entry point (task 1.2), with a test that an outside agent's panel send keeps its actor. |
| 2 | fixed | Replay looks the request up before validating the target, rebuilds from stored inputs, and counts only accepted receipts (task 1.5). |
| 3 | fixed as an invariant | Cancel works in every state shown as queued or waiting; two named tests; mechanism left to the implementer (task 1.6). |
| 4 | decided by the user | A proposed plan counts as the answer; the spec's D16 was amended (tasks 1.3, plan decision P17). |
| 5 | accepted as a limit | A delivery being claimed when the setting flips may complete; recorded as plan decision P18 (task 6.1). |
| 6 | fixed as an invariant | A held or failed message never has a live queue entry; two named tests (tasks 6.1, 6.4, 6.7). |
| 7 | fixed | Terminal recipients obey the limits and the off switch; a person's request keeps its exceptions (tasks 6.6, 8.4, 8.6). |
| 8 | fixed | Every request transition goes through one publishing function of the service (tasks 1.3, 9.2, 9.3). |
| 9 | simplified | Unread is derived from undismissed, unopened notices; the timestamp watermark is removed (task 3.3, plan decision P20). |
| 10 | simplified | A failed message's queue entry is withdrawn, so nothing remains to retry; the retry test is removed (tasks 5.5, 6.7). |
| 11 | fixed | The release-versus-cancel test moved to task 6.7; task 8.5 depends on 8.6. |
| 12 | fixed | Message ids in the source type, `not_cancellable` in the error reasons, the capability fixture named in task 5.2. |
| 13 | fixed | The terminal output loader carries which source was used, whether it fell back and whether the start is missing (tasks 4.2, 9.1, 10.1, 10.2). |
| 14 | fixed | The short-thread boundary of task 4.1 and the three named tests of task 5.1. |
| 15 | fixed | Seven methods and the full reason list in the documentation task; the file map is regenerated from the tasks. |
