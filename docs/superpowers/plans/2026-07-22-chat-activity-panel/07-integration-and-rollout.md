# Chat Activity Dock — Integration, Hardening, and Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the complete activity feature is provider-neutral, bounded, secure, accessible, performant, backward compatible, and ready for incremental rollout.

**Architecture:** Treat the activity protocol version and per-scope capability snapshot as the rollout gates. A shared provider-conformance suite validates graph invariants across Codex, Claude, and OpenCode. End-to-end tests exercise the dock, inspector, reconnect, responsive behavior, and supported terminal handshakes without weakening existing conversation fallbacks.

**Tech Stack:** Rust integration/property tests, Vitest/Testing Library, desktop Playwright/Webdriver E2E, repository checks and coverage tooling.

## Prerequisites and Constraints

- Complete Plans [01](./01-activity-foundation.md) through [06](./06-provider-terminal-observation.md).
- Do not enable a provider capability because of provider name alone. Enable only after its runtime handshake succeeds.
- Activity protocol v1 is additive; normal conversation rendering must remain functional when the client or server lacks it.
- Keep the release inspect-only and current-scope.
- Use `vp test` for built-in Vite+ tests and `vp run test` only for a package script.
- Repository completion requires `vp check` and `vp run typecheck`.

---

## Task 1: Add a cross-provider activity conformance suite

**Files:**

- Create: `apps/server/tests/activity_provider_conformance.rs`
- Create: `apps/server/tests/fixtures/activity-conformance/canonical-scenarios.json`
- Modify: `apps/server/tests/provider_codex.rs`
- Modify: `apps/server/tests/provider_claude.rs`
- Modify: `apps/server/tests/provider_opencode.rs`

- [ ] **Step 1: Define failing canonical scenario tests**

Create a provider-agnostic scenario format containing expected actors, work items, entries, counts, and final revision semantics. Each supported adapter supplies a native trace adapter that must satisfy the same cases:

- direct child start/running/waiting/completed;
- nested child with valid parent;
- failed, cancelled, interrupted, and unknown terminal/state cases;
- commentary, tool, command, result, error, state, and completion entry kinds;
- duplicate event delivery;
- late progress after terminal state;
- missing live event repaired by authoritative history;
- malformed/oversized native fields;
- loss of recovery with active records becoming interrupted; and
- exact counts while summary pages are capped.

The common assertion must compare semantic graph output after provider-native IDs are normalized to fixture aliases; it must not weaken adapter-specific identity checks.

- [ ] **Step 2: Add graph-invariant property cases**

Generate bounded event permutations and assert:

- IDs remain unique within a scope and namespaced across scopes;
- no parent edge escapes the scope;
- no visible cycle can be created;
- revisions strictly increase only for effective mutation batches;
- duplicate keys do not increment revision;
- a terminal state never regresses from an older/non-authoritative event;
- roster counts equal repository counts, not loaded page length; and
- every entry owner exists or is rejected transactionally.

Use deterministic seeds and print the seed on failure.

- [ ] **Step 3: Verify all three adapters**

```bash
cargo test -p bibcode-server --test activity_provider_conformance -- --nocapture
cargo test -p bibcode-server --test provider_codex activity -- --nocapture
cargo test -p bibcode-server --test provider_claude activity -- --nocapture
cargo test -p bibcode-server --test provider_opencode activity -- --nocapture
```

- [ ] **Step 4: Commit conformance coverage**

```bash
git add apps/server/tests/activity_provider_conformance.rs \
  apps/server/tests/fixtures/activity-conformance/canonical-scenarios.json \
  apps/server/tests/provider_codex.rs apps/server/tests/provider_claude.rs \
  apps/server/tests/provider_opencode.rs
git commit -m "test(activity): add provider conformance suite"
```

---

## Task 2: Harden authorization, scope membership, retention, and redaction

**Files:**

- Modify: `apps/server/src/activity/repository.rs`
- Modify: `apps/server/src/activity/projection.rs`
- Modify: `apps/server/src/activity/rpc.rs`
- Modify: `apps/server/src/auth/scope.rs`
- Modify: `apps/server/tests/activity_repository.rs`
- Modify: `apps/server/tests/activity_rpc.rs`
- Modify: `apps/server/tests/production_operational_logs.rs`
- Modify: `apps/server/tests/server_runtime.rs`

- [ ] **Step 1: Write failing authorization tests**

Prove for every unary and stream RPC:

- unauthenticated access is rejected;
- read scope is sufficient and write-only/irrelevant scope is not;
- a user cannot request another environment's scope;
- a terminal scope must belong to the host thread/environment;
- a descendant/record not reachable from the root returns `invalidScope` or `notFound` without revealing existence;
- forged parent/cycle mutations are rejected before persistence; and
- authorization is rechecked after reconnect/subscription replacement.

- [ ] **Step 2: Write failing bounds and redaction tests**

Inject native payloads containing:

- bearer tokens, API keys, cookie values, hook URLs/tokens, environment entries;
- ANSI/OSC terminal escapes and HTML/script strings;
- multibyte strings at every byte boundary;
- 10,000 actors/work items and 1,000 entries per owner; and
- deeply nested/malformed JSON.

Assert RPC/operational logs contain only normalized, clipped text; terminal escapes are rendered as inert text by the client; secrets are absent; snapshot/page caps hold; and processing does not recurse through arbitrary JSON.

- [ ] **Step 3: Implement retention policy transactionally**

Use explicit constants in `activity/repository.rs` with these v1 values:

```text
summary records per scope: 2,000
entries per record:          200
journal rows per scope:    5,000
completed retention age:  30 days
```

Use these as the v1 defaults and change constants and tests together in any
future retention-policy change. Retention must:

1. preserve all active records;
2. preserve parent/owner records referenced by retained children/work items;
3. remove oldest eligible completed entries/records first;
4. keep exact current counts meaningful for retained history; and
5. run in a bounded transaction after projection, never on the UI request path.

- [ ] **Step 4: Verify and commit**

```bash
cargo test -p bibcode-server --test activity_repository retention -- --nocapture
cargo test -p bibcode-server --test activity_rpc authorization -- --nocapture
cargo test -p bibcode-server --test production_operational_logs activity -- --nocapture
cargo test -p bibcode-server --test server_runtime activity -- --nocapture
git add apps/server/src/activity/repository.rs apps/server/src/activity/projection.rs \
  apps/server/src/activity/rpc.rs apps/server/src/auth/scope.rs \
  apps/server/tests/activity_repository.rs apps/server/tests/activity_rpc.rs \
  apps/server/tests/production_operational_logs.rs apps/server/tests/server_runtime.rs
git commit -m "fix(activity): harden scope and retention boundaries"
```

---

## Task 3: Validate high-volume batching and reconnect performance

**Files:**

- Create: `apps/server/tests/activity_load.rs`
- Create: `packages/client-runtime/src/state/activityLoad.test.ts`
- Modify: `apps/server/src/activity/projection.rs`
- Modify: `packages/client-runtime/src/state/activityReducer.ts`
- Modify: `apps/web/src/components/activity/ActivityRoster.tsx`
- Modify: `apps/web/src/components/activity/ActivityPanel.test.tsx`

- [ ] **Step 1: Write deterministic server load tests**

On a temporary database, project 50 actors each emitting 100 rapid text/tool/status events. Assert:

- text coalescing/projection batching keeps mutation batches <= 256 changes;
- repository write queue stays bounded and ordered;
- snapshot contains at most 200 actor/work-item summaries;
- detail page contains at most requested/200 entries;
- a lagged subscriber receives a fresh snapshot rather than an unbounded replay;
- cancellation completes promptly; and
- peak retained journal data follows configured caps.

Record elapsed time for diagnostics, but use generous non-flaky upper bounds derived from repository CI norms. Do not assert millisecond-level timing.

- [ ] **Step 2: Write deterministic client load tests**

Feed 5,000 revisions in bounded batches and assert:

- reducer work remains ordered and no page exceeds caps;
- duplicate/gap handling remains correct;
- live announcements coalesce to at most one per 500ms window;
- the roster renders only the bounded/windowed row set; and
- switching scopes cancels the old stream and ignores its late delta.

- [ ] **Step 3: Profile before optimizing**

Run the load tests and inspect their timing/heap output. Optimize shared projection/reducer/list code only where the evidence identifies a bottleneck. Preserve simple bounded data structures over premature custom caching.

```bash
cargo test -p bibcode-server --test activity_load -- --nocapture
vp test run packages/client-runtime/src/state/activityLoad.test.ts \
  apps/web/src/components/activity/ActivityPanel.test.tsx
```

- [ ] **Step 4: Commit performance safeguards**

```bash
git add apps/server/tests/activity_load.rs apps/server/src/activity/projection.rs \
  packages/client-runtime/src/state/activityLoad.test.ts \
  packages/client-runtime/src/state/activityReducer.ts \
  apps/web/src/components/activity/ActivityRoster.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx
git commit -m "perf(activity): bound high-volume activity updates"
```

---

## Task 4: Add responsive, accessibility, and desktop end-to-end coverage

**Files:**

- Create: `apps/desktop/e2e/specs/chat-activity-panel.e2e.ts`
- Create: `apps/desktop/e2e/support/activity-events.ts`
- Modify: `apps/web/src/components/activity/ActivityDock.test.tsx`
- Modify: `apps/web/src/components/activity/ActivityPanel.test.tsx`
- Modify: `apps/web/src/components/ChatView.test.tsx`

- [ ] **Step 1: Add failing geometry scenarios**

With deterministic synthetic activity data, capture/assert:

| Viewport | Required behavior |
|---|---|
| >= 1200px | detailed dock and inline right panel |
| 800–1199px | compact icon/count dock |
| < existing 980px panel breakpoint | existing right-panel sheet |
| terminal center surface | dock stays below toolbar and inside terminal bounds |

Assert the dock does not overlap the composer, terminal toolbar, window titlebar inset, or inspector bounds.

- [ ] **Step 2: Add keyboard/focus E2E flow**

Exercise:

1. Tab to dock;
2. Enter to expand;
3. Arrow/Tab to Subagents and Enter;
4. open an actor;
5. use Back;
6. Escape closes expanded summary before the surrounding sheet; and
7. close/reopen restores section without stealing chat/terminal focus on live updates.

Assert accessible names include exact active/done meanings; status is never color-only; and one polite live region announces coalesced count changes.

- [ ] **Step 3: Add reduced-motion and contrast assertions**

Under `prefers-reduced-motion: reduce`, assert no width/count transition class is active. Check the dock/panel use shared theme tokens in both light and dark themes and visible focus rings meet the repository's existing accessibility conventions.

- [ ] **Step 4: Run and commit UI acceptance tests**

```bash
vp test run apps/web/src/components/activity/ActivityDock.test.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/ChatView.test.tsx
vp run --filter @bibcode/desktop test:ui -- chat-activity-panel
git add apps/desktop/e2e/specs/chat-activity-panel.e2e.ts \
  apps/desktop/e2e/support/activity-events.ts \
  apps/web/src/components/activity/ActivityDock.test.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/ChatView.test.tsx
git commit -m "test(activity): cover responsive activity experience"
```

---

## Task 5: Document protocol, support matrix, and operational behavior

**Files:**

- Create: `docs/architecture/activity-observation.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/providers.md`
- Modify: `docs/providers/codex.md`
- Modify: `docs/providers/claude.md`
- Modify: `docs/README.md`

- [ ] **Step 1: Write the architecture document**

Document:

- canonical scope/actor/work-item/entry definitions;
- lifecycle and terminal-state monotonicity;
- snapshot/delta/revision and resync rules;
- activity protocol v1 negotiation;
- provider capability matrix and truthful downgrade behavior;
- structured chat vs provider-terminal topology;
- terminal handshake and fallback guarantees;
- bounds, retention, authorization, redaction, and hidden-reasoning policy; and
- troubleshooting states: live, reconnecting, stale, error, interrupted.

Use Mermaid only for the cross-layer data flow where it materially clarifies ownership.

- [ ] **Step 2: Update provider docs**

Codex and Claude docs list required/version-gated switches and how T4Code falls back. `providers.md` includes OpenCode and explicitly states Cursor/Grok terminal activity is unsupported in v1.

Do not promise exact provider CLI versions indefinitely. Describe feature detection and link to the fixture/conformance tests.

- [ ] **Step 3: Verify docs and commit**

```bash
vp fmt --check docs/architecture/activity-observation.md docs/architecture/overview.md \
  docs/architecture/providers.md docs/providers/codex.md docs/providers/claude.md docs/README.md
git add docs/architecture/activity-observation.md docs/architecture/overview.md \
  docs/architecture/providers.md docs/providers/codex.md docs/providers/claude.md docs/README.md
git commit -m "docs: describe provider activity observation"
```

---

## Task 6: Gate rollout by protocol and provider capabilities

**Files:**

- Modify: `packages/contracts/src/environment.ts`
- Modify: `packages/client-runtime/src/state/activity.ts`
- Modify: `apps/server/src/production/control.rs`
- Modify: `apps/server/tests/production_control.rs`
- Modify: `apps/web/src/components/ChatView.test.tsx`

- [ ] **Step 1: Write backward-compatibility tests**

Prove:

- a descriptor without `activityProtocolVersion` decodes with null/default and never subscribes;
- a server advertising v1 plus a provider with no capabilities renders no dock;
- a background-only failure marks only Background Tasks stale and preserves the live Subagents section;
- v1 plus Codex-only support enables Codex without affecting Claude/OpenCode;
- terminal observation remains false independently from structured-chat activity;
- an older client fixture ignores additive server fields and conversation RPC/events still decode; and
- disabling/downgrading activity never disables normal provider chat or terminal launch.

- [ ] **Step 2: Make protocol registration atomic**

The server advertises `activityProtocolVersion: 1` only when migration, repository, projection, RPC methods, and stream registration all construct successfully. If activity construction fails, server startup follows the repository's required-component policy; do not advertise a half-installed protocol.

The UI checks environment protocol support once, then relies on the scope snapshot's capability fields. It never branches on provider name.

- [ ] **Step 3: Verify incremental enablement and commit**

```bash
vp test run packages/contracts/src/environment.test.ts \
  packages/client-runtime/src/state/activity.test.ts \
  apps/web/src/components/ChatView.test.tsx
cargo test -p bibcode-server --test production_control activity -- --nocapture
git add packages/contracts/src/environment.ts packages/client-runtime/src/state/activity.ts \
  apps/server/src/production/control.rs apps/server/tests/production_control.rs \
  apps/web/src/components/ChatView.test.tsx
git commit -m "feat(activity): gate rollout by negotiated capabilities"
```

---

## Task 7: Run final repository verification and acceptance smoke tests

**Files:** No product-code changes expected. Fix only failures caused by this feature and commit those fixes separately.

- [ ] **Step 1: Run all focused TypeScript suites**

```bash
vp test run packages/contracts/src/activity.test.ts packages/contracts/src/environment.test.ts \
  packages/contracts/src/terminal.test.ts packages/contracts/src/rpc.test.ts \
  packages/contracts/src/rpcRustParity.test.ts \
  packages/client-runtime/src/state/activityReducer.test.ts \
  packages/client-runtime/src/state/activity.test.ts \
  packages/client-runtime/src/state/activityLoad.test.ts \
  apps/web/src/activityDockStore.test.ts apps/web/src/rightPanelStore.test.ts \
  apps/web/src/components/activity/activityPresentation.test.ts \
  apps/web/src/components/activity/ActivityDock.test.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/activity/ProviderTerminalActivityDock.test.tsx \
  apps/web/src/components/chat/providerTerminalActions.test.ts \
  apps/web/src/components/ThreadTerminalDrawer.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx \
  apps/web/src/components/ChatView.test.tsx
```

- [ ] **Step 2: Run all focused Rust suites**

```bash
cargo test -p bibcode-server --test activity_repository -- --nocapture
cargo test -p bibcode-server --test activity_rpc -- --nocapture
cargo test -p bibcode-server --test activity_provider_conformance -- --nocapture
cargo test -p bibcode-server --test activity_load -- --nocapture
cargo test -p bibcode-server --test provider_codex -- --nocapture
cargo test -p bibcode-server --test provider_claude -- --nocapture
cargo test -p bibcode-server --test provider_opencode -- --nocapture
cargo test -p bibcode-server --test provider_terminal_supervisor -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc -- --nocapture
```

- [ ] **Step 3: Run repository coverage and required gates**

```bash
vp run test:coverage
vp check
vp run typecheck
```

Expected: all commands exit 0. Coverage must satisfy the repository-wide aggregate thresholds configured in `vite.config.shared.ts` and `scripts/check-rust-coverage.ts`; do not exclude new activity modules to make the gate pass.

- [ ] **Step 4: Run the manual acceptance matrix**

For Codex, Claude, and OpenCode structured chats:

- create direct/nested child activity;
- inspect Active and Done rosters and detail;
- close/reopen the panel;
- reload and reconnect; and
- verify root conversation output remains correct.

For each supported provider terminal:

- start through T4Code's provider-terminal action;
- wait for handshake before expecting a dock;
- spawn/inspect child activity;
- restart and verify generation separation; and
- simulate observer setup failure and confirm a usable terminal with no dock.

For Cursor and Grok terminals, confirm ordinary launch and no dock.

- [ ] **Step 5: Review acceptance criteria one by one**

Record evidence in the pull request or implementation handoff for all nine design acceptance criteria. Include command output summaries, provider versions used for smoke tests, and responsive screenshots. Do not include tokens, raw settings, or provider transcripts.

- [ ] **Step 6: Request code review**

Use `superpowers:requesting-code-review` against the full implementation diff. Address correctness, security, protocol compatibility, and test findings before invoking `superpowers:finishing-a-development-branch`.

---

## Plan 07 Completion Gate

The feature is complete only when:

- activity protocol v1 negotiates additively;
- supported structured chats satisfy provider conformance;
- supported T4Code-owned terminals handshake before showing activity;
- unsupported/empty/failed scopes show no misleading dock;
- the UI is inspect-only, responsive, keyboard accessible, and bounded;
- reconnect/restart/late-event invariants pass;
- no raw secrets, hidden reasoning, terminal control sequences, or unbounded provider JSON reach the client; and
- focused suites, coverage, `vp check`, and `vp run typecheck` all pass.
