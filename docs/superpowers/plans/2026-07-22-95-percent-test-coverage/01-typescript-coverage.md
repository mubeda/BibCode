# TypeScript 95 Percent Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise repository-wide TypeScript statements, branches, functions, and lines to at least 95% while giving every below-target TypeScript ownership cohort a measured behavioral test pass.

**Architecture:** Work from smallest deterministic modules into the web application's existing capture harnesses, then close client-runtime and relay boundary gaps with Effect test layers and scripted requests. Re-run the complete V8 suite after each cohort and select reserve modules by their remaining uncovered branch and function counts rather than by file count.

**Tech Stack:** TypeScript 6, Vite+, Vitest, V8 coverage, React 19, React Testing Library, Effect 4, Cloudflare Worker request objects.

## Global Constraints

- Acceptance is repository-wide aggregate coverage, not a per-file or per-package gate.
- Statements, branches, functions, and lines must each be at least 95% in a fresh complete report.
- Preserve `coverageInclude` and `coverageExclude` exactly during this plan.
- Use the existing React capture harnesses in large component tests; assert rendered state, handler results, and external effects rather than mock call counts alone.
- Read `.repos/effect-smol/LLMS.md` before modifying client-runtime or relay Effect tests.
- Use `it.effect` and test `Layer`s for Effect-returning behavior. Do not introduce manual Effect runtimes in tests.
- Restore fake timers, DOM globals, storage, and mocked modules in `afterEach`.
- Keep thresholds at 90 until the final policy plan.
- Never commit `coverage/`.

---

## Measured Gap and Work Order

Baseline: statements 93.60%, branches 90.02%, functions 91.94%, lines 94.22%. At the current denominator, the limiting metric needs 1,480 additional covered branches. The initial ownership results are:

| Cohort | Statements | Branches | Functions | Lines | First targets |
| --- | ---: | ---: | ---: | ---: | --- |
| Marketing | 0.00% | 0.00% | 0.00% | 0.00% | releases and configuration |
| Web | 93.25% | 88.80% | 92.72% | ChatView, Sidebar, ConnectionsSettings, composer surfaces |
| Client runtime | 88.46% | 88.07% | 80.59% | registry, runtime, onboarding, server/VCS state |
| Contracts tooling | 98.71% | 90.13% | 98.80% | fixture exporter branches |
| Relay | 84.01% | 91.81% | 82.69% | HTTP API and worker functions |
| Shared/scripts/Oxlint | at or above 95% | at or above 95% | at or above 95% | at or above 95% | regression-only unless totals move |

### Task 1: Cover Marketing and Deployment Configuration

**Files:**

- Create: `apps/marketing/src/lib/releases.test.ts`
- Create: `apps/marketing/src/lib/catalog.test.ts`
- Create: `apps/marketing/config.test.ts`
- Create: `apps/web/vercel.test.ts`
- Test: `apps/marketing/src/lib/releases.ts`
- Test: `apps/marketing/src/lib/site.ts`
- Test: `apps/marketing/src/lib/tweets.ts`
- Test: `apps/marketing/vercel.ts`
- Test: `apps/marketing/astro.config.mjs`
- Test: `apps/web/vercel.ts`

**Interfaces:**

- Consumes: browser `sessionStorage`, `fetch`, exported static catalogs, and exported Vercel/Astro configurations.
- Produces: deterministic coverage of cache hit, cache miss, non-cacheable response, request failure, and all declarative route values.

- [ ] **Step 1: Add cache and fetch behavior tests**

Add this complete case structure to `apps/marketing/src/lib/releases.test.ts`, using a fresh in-memory `Storage` stub in `beforeEach`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLatestRelease, RELEASES_URL, type Release } from "./releases";

const release: Release = {
  tag_name: "v1.2.3",
  html_url: "https://github.com/mubeda/BibCode/releases/tag/v1.2.3",
  assets: [{ name: "T4Code.dmg", browser_download_url: "https://example.test/T4Code.dmg" }],
};

describe("fetchLatestRelease", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns the cached release without fetching", async () => {
    values.set("t4code-latest-release", JSON.stringify(release));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(fetchLatestRelease()).resolves.toEqual(release);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches and caches a release with assets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => release })));
    await expect(fetchLatestRelease()).resolves.toEqual(release);
    expect(JSON.parse(values.get("t4code-latest-release")!)).toEqual(release);
  });

  it("does not cache an API payload without assets", async () => {
    const payload = { tag_name: "v1.2.3" };
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => payload })));
    await expect(fetchLatestRelease()).resolves.toEqual(payload);
    expect(values.has("t4code-latest-release")).toBe(false);
  });

  it("exposes the repository releases URL", () => {
    expect(RELEASES_URL).toBe("https://github.com/mubeda/BibCode/releases");
  });
});
```

- [ ] **Step 2: Verify the new test fails before relying on it**

Run: `vp test apps/marketing/src/lib/releases.test.ts`

Expected before any harness correction: the test either passes against the current contract or fails on an exact browser-global mismatch. Fix only the test harness for a characterization test; if production behavior is wrong, preserve the failure and fix it test-first.

- [ ] **Step 3: Add declarative catalog and configuration assertions**

In `catalog.test.ts`, assert the exact GitHub URL, marketing stats, nonempty tweet content/link values, unique handles, and that both optional-excerpt branches occur. In `config.test.ts`, dynamically import `./vercel.ts` and `./astro.config.mjs`, asserting the three Vercel commands and default port 4173. In `apps/web/vercel.test.ts`, assert the four route contracts, both channel cookies, nightly/latest destinations, and SPA rewrite.

Use this exact route projection so assertions do not depend on Vercel's matcher object identity:

```ts
const projectedRoutes = config.routes?.map((route) => ({
  src: route.src,
  dest: "dest" in route ? route.dest : undefined,
  status: "status" in route ? route.status : undefined,
  location: "headers" in route ? route.headers?.Location : undefined,
  cookie: "headers" in route ? route.headers?.["Set-Cookie"] : undefined,
}));
expect(projectedRoutes).toEqual([
  { src: "/__t4code/channel", dest: undefined, status: 302, location: "/", cookie: "t4code_web_channel=nightly; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax" },
  { src: "/__t4code/channel", dest: undefined, status: 302, location: "/", cookie: "t4code_web_channel=latest; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax" },
  { src: "/(.*)", dest: "https://nightly.app.t4code.codes/$1", status: undefined, location: undefined, cookie: undefined },
  { src: "/(.*)", dest: "https://latest.app.t4code.codes/$1", status: undefined, location: undefined, cookie: undefined },
]);
```

- [ ] **Step 4: Run and commit the cohort**

```bash
vp test apps/marketing/src/lib/releases.test.ts apps/marketing/src/lib/catalog.test.ts apps/marketing/config.test.ts apps/web/vercel.test.ts
git add apps/marketing apps/web/vercel.test.ts
git commit -m "test: cover marketing and deployment configuration"
```

Expected: all focused tests pass; no production file changes unless a failing assertion exposed a real defect.

### Task 2: Close Primary Web Shell Branches

**Files:**

- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`
- Modify: `apps/web/src/components/Sidebar.test.tsx`
- Modify: `apps/web/src/components/settings/ConnectionsSettings.test.tsx`
- Modify: `apps/web/src/components/ChatView.logic.test.ts`
- Modify: `apps/web/src/components/Sidebar.logic.test.ts`
- Modify: `apps/web/src/components/settings/ConnectionsSettings.logic.test.ts`

**Interfaces:**

- Consumes: existing `capturedProps`, `baseScenario`, `groupedScenario`, `control`, `invoke`, `clickButton`, fake local API, desktop bridge, and environment registry harnesses.
- Produces: observable coverage of shell lifecycle, failure, stale-result, narrow-layout, and connection-management behavior.

- [ ] **Step 1: Add the ChatView branch table**

Append named cases that use `seedEnvironment`, `seedProject`, `seedServerThread`, `renderServerRoute`, and `capturedProps`. Cover this exact environment matrix plus a separate deleted-thread case:

```ts
const connectionCases = [
  { phase: "connecting", variant: "warning", button: "Reconnecting...", disabled: true },
  { phase: "reconnecting", variant: "warning", button: "Reconnecting...", disabled: true },
  { phase: "error", variant: "error", button: "Reconnect", disabled: false },
] as const;
```

Add separate handler tests for send rejection/retry; pending user input accept/reject; unavailable/loading/failing checkpoint diff; model and environment replacement; failed terminal/script launch; narrow-layout right-panel toggle; and a deferred send completion resolved after switching to a different thread. Each case must assert the rendered label or final public store state and the exact typed command input.

- [ ] **Step 2: Run the ChatView tests**

Run: `vp test apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/ChatView.logic.test.ts`

Expected: all existing and new cases pass without unresolved deferred promises.

- [ ] **Step 3: Add Sidebar transition and action tests**

Use `baseScenario`, `groupedScenario`, `mustFindProps`, and `invoke` for empty/loading/error environment rows; collapsed/expanded grouping; valid and invalid rename; rename failure; delete/restore; update progress/failure; unread count; keyboard-opened context menu; canceled drag; disconnected actions; and stale rename completion after environment replacement.

Use this exact input matrix through the captured rename form: empty string, whitespace-only string, unchanged `same-name`, and changed `renamed`. Assert the first three keep submit disabled and the last enables it. Do not add a new production helper solely for this test.

- [ ] **Step 4: Add ConnectionsSettings state-machine tests**

Use `render`, `control`, `invoke`, `stubDesktopWindow`, `clientSession`, `accessSnapshot`, `endpoint`, and `environment` for create/edit/delete success and typed failure; blank/duplicate validation; OAuth and device-code pending/expired/rejected states; reconnect; model refresh; unavailable capability; bridge rejection; and a deferred response resolved after environment selection changes. Assert public control labels, disabled state, saved endpoint values, and error copy.

- [ ] **Step 5: Run and measure the cohort**

```bash
vp test apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/ChatView.logic.test.ts apps/web/src/components/Sidebar.test.tsx apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/settings/ConnectionsSettings.test.tsx apps/web/src/components/settings/ConnectionsSettings.logic.test.ts
vp test --coverage --coverage.reporter=json --coverage.reporter=json-summary --coverage.reporter=text
```

Expected: the focused suite is green and uncovered branches fall in all three production components. Record the four aggregate deltas.

- [ ] **Step 6: Commit the shell cohort**

```bash
git add apps/web/src/components/ChatView*.test.* apps/web/src/components/Sidebar*.test.* apps/web/src/components/settings/ConnectionsSettings*.test.*
git commit -m "test: cover web shell state transitions"
```

### Task 3: Close Composer and Timeline Branches

**Files:**

- Modify: `apps/web/src/components/chat/ChatComposer.test.tsx`
- Modify: `apps/web/src/components/chat/MessagesTimeline.test.tsx`
- Modify: `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`
- Modify: `apps/web/src/composerDraftStore.test.ts`
- Modify: `apps/web/src/components/ComposerPromptEditor.test.tsx`

**Interfaces:**

- Consumes: `renderComposer`, `lastCapture`, `captureByLabel`, `buildAssistantTimelineEntry`, `buildWorkTimelineEntry`, `draftFor`, `createMockStorage`, `renderEditor`, and Lexical selection helpers.
- Produces: covered draft migration, attachment, keyboard, minimap, work-row, selection, and cleanup behavior.

- [ ] **Step 1: Extend ChatComposer behavior coverage**

Add named cases for empty/nonempty submit; Shift+Enter; interrupted send; pending-user-input submission; object URL creation/revocation; failed image read; terminal/element/review context removal; model picker close/replace; plan-mode toggle; command menu keyboard wrap; disabled provider; and unmount cleanup. Drive effects with `flushQueuedEffects`, animation with `runAnimationFrames`, and cleanup with `runCleanups`. Assert final editor snapshot and draft state, not only captured handler calls.

- [ ] **Step 2: Extend MessagesTimeline behavior coverage**

Use the existing builders to cover empty and populated minimap; minimap viewport click/drag; incomplete timer and invalid timestamp; grouped work rows; raw-work fallback; user-message expand/collapse/copy; proposed plan accept/reject; review cards; terminal context bodies; malformed diff; and scroll-to-bottom visibility. Table-drive work rows with this exact label set:

```ts
const workRows = [
  { tone: "thinking", label: "Reasoning" },
  { tone: "tool", label: "Command" },
  { tone: "info", label: "Info" },
  { tone: "error", label: "Error" },
] as const;
```

Pass each row's `tone` and `label` through `buildWorkTimelineEntry` and assert the row label plus tone-specific chrome. These are the four discriminants already defined by `WorkLogEntry`; do not add compatibility-only production discriminants.

- [ ] **Step 3: Cover draft persistence and migration boundaries**

Extend the existing `composerDraftStore` suites with invalid JSON, null storage, legacy entries with and without environment IDs, unknown provider options, duplicate images/contexts, missing remove targets, debounced overwrite, flush-before-timeout, hydration merge precedence, invalid draft target, and provider selection fallback. Use `vi.useFakeTimers()` only inside the storage suites and always restore real timers.

- [ ] **Step 4: Cover Lexical selection and imperative paths**

Use `renderEditor`, `lastEditor`, `setCollapsedSelection`, `setRangeSelection`, `setDoctoredTokenSelection`, `keyEvent`, and `commitUpdates` for root/no-root focus; before/inside/after token arrow movement; backspace at token boundaries; reversed range normalization; selection-change serialization; composition guard; empty paragraph; terminal-token removal; and imperative `replaceText`/`setCursor` clamping.

- [ ] **Step 5: Run, measure, and commit**

```bash
vp test apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/components/chat/MessagesTimeline.logic.test.ts apps/web/src/composerDraftStore.test.ts apps/web/src/components/ComposerPromptEditor.test.tsx
vp test --coverage --coverage.reporter=json --coverage.reporter=json-summary --coverage.reporter=text
git add apps/web/src/components/chat apps/web/src/composerDraftStore.test.ts apps/web/src/components/ComposerPromptEditor.test.tsx
git commit -m "test: cover composer and timeline boundaries"
```

Expected: focused tests and full coverage pass at the existing 90 gates; branches and functions improve materially in all five modules.

### Task 4: Cover Git, Terminal, and Add-Project Workflows

**Files:**

- Modify: `apps/web/src/components/GitActionsControl.test.tsx`
- Modify: `apps/web/src/components/GitActionsControl.logic.test.ts`
- Modify: `apps/web/src/components/SourceControlPanel.test.tsx`
- Modify: `apps/web/src/components/SourceControlPanel.logic.test.ts`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.test.ts`
- Modify: `apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx`
- Modify: `apps/web/src/components/add-project/useAddProjectWorkflow.public.test.tsx`

**Interfaces:**

- Consumes: existing VCS status/result fixtures, captured button/menu helpers, drawer prop builders, and integrated add-project operations.
- Produces: deterministic success/failure/cancellation/stale-completion coverage for Git, terminal session, and project onboarding workflows.

- [ ] **Step 1: Cover GitActionsControl commands and dialogs**

Test clean/dirty/no-repository status; fetch/pull/push/publish success, typed failure, interruption, duplicate suppression, and stale completion; upstream-present/absent; detached HEAD; stacked result variants; publish dialog validation/cancel/failure; and browser open failure. Assert visible status, disabled buttons, dialog lifecycle, and exact command payloads.

- [ ] **Step 2: Cover SourceControlPanel modes**

Test empty/loading/error status; staging and legacy layouts; stage/unstage/discard all and one file; ignored/untracked/renamed/deleted entries; section collapse; menu actions; commit blank-message refusal/success/failure; refresh; and command completion after the selected environment changes.

- [ ] **Step 3: Cover terminal drawer behavior**

Test zero/one/multiple sessions; active session deletion; split creation/removal/orientation; persisted sizes; keyboard traversal; focus handoff; failed open/close/write/resize; delayed selection action for single/double/triple click; sidebar label fallback; and stale output after selection changes. Use fake timers only for the existing selection-delay contract.

- [ ] **Step 4: Cover add-project workflow decisions**

Use `WorkflowProbe`, `deferredResult`, and `makeIntegratedOperations` for no host/one host/many hosts; invalid directory; choose existing project; clone success/failure/cancel; create worktree success/failure; duplicate project; picker unavailable; public hook closed state; and a deferred picker result resolved after the workflow closes.

- [ ] **Step 5: Run, measure, and commit**

```bash
vp test apps/web/src/components/GitActionsControl.test.tsx apps/web/src/components/GitActionsControl.logic.test.ts apps/web/src/components/SourceControlPanel.test.tsx apps/web/src/components/SourceControlPanel.logic.test.ts apps/web/src/components/ThreadTerminalDrawer.test.tsx apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx apps/web/src/components/ThreadTerminalDrawer.test.ts apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx apps/web/src/components/add-project/useAddProjectWorkflow.public.test.tsx
vp test --coverage --coverage.reporter=json --coverage.reporter=json-summary --coverage.reporter=text
git add apps/web/src/components/GitActionsControl* apps/web/src/components/SourceControlPanel* apps/web/src/components/ThreadTerminalDrawer* apps/web/src/components/add-project
git commit -m "test: cover Git terminal and project workflows"
```

Expected: the focused suite is green and each named production module has fewer uncovered branches and functions.

### Task 5: Cover Client-Runtime State and Connection Failures

**Files:**

- Modify: `packages/client-runtime/src/connection/registry.test.ts`
- Modify: `packages/client-runtime/src/connection/onboarding.test.ts`
- Modify: `packages/client-runtime/src/connection/supervisor.test.ts`
- Modify: `packages/client-runtime/src/state/runtime.test.ts`
- Modify: `packages/client-runtime/src/state/server.test.ts`
- Modify: `packages/client-runtime/src/state/vcsAction.test.ts`
- Modify: `packages/client-runtime/src/state/connections.test.ts`
- Modify: `packages/client-runtime/src/operations/commands.test.ts`
- Modify: `packages/client-runtime/src/relay/managedRelay.test.ts`
- Modify: `packages/client-runtime/src/rpc/session.test.ts`

**Interfaces:**

- Consumes: existing `makeHarness`, environment RPC factories, state fixtures, scoped layers, and `it.effect` helpers.
- Produces: covered registry disposal, observer failure, reconnection, cancellation, stale-result, rollback, and session shutdown behavior.

- [ ] **Step 1: Read the required Effect guidance**

Run: `sed -n '1,260p' .repos/effect-smol/LLMS.md`

Expected: read the file completely before editing these tests; continue with later chunks if it exceeds 260 lines.

- [ ] **Step 2: Extend registry and supervisor tests**

Using `makeHarness`, cover first registration, duplicate registration, replacement, active-environment removal, disconnected retention, observer failure, reconnecting state, concurrent updates, explicit disposal, disposal during connection, and late connection completion. Assert registry snapshots and scoped finalizers.

- [ ] **Step 3: Extend runtime and state tests**

Cover environment RPC creation with missing/complete credentials; success, typed failure, interruption, transport failure, optimistic update rollback, duplicate command suppression, stale completion, refresh, reset, and last-good data retention. For server/VCS state, add disconnected/reconnecting/auth-required and invalid-revision cases.

- [ ] **Step 4: Extend onboarding, relay, and RPC tests**

Cover discovery none/one/many; invalid endpoint; pairing cancellation/expiry; credential rejection; token refresh; unlink during connection; reconnect backoff; session close before ready; malformed frame; abort propagation; and late result suppression. Use `TestClock` for time-based behavior and scoped fibers for cancellation.

- [ ] **Step 5: Run, measure, and commit**

```bash
vp test packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/connection/onboarding.test.ts packages/client-runtime/src/connection/supervisor.test.ts packages/client-runtime/src/state/runtime.test.ts packages/client-runtime/src/state/server.test.ts packages/client-runtime/src/state/vcsAction.test.ts packages/client-runtime/src/state/connections.test.ts packages/client-runtime/src/operations/commands.test.ts packages/client-runtime/src/relay/managedRelay.test.ts packages/client-runtime/src/rpc/session.test.ts
vp test --coverage --coverage.reporter=json --coverage.reporter=json-summary --coverage.reporter=text
git add packages/client-runtime/src
git commit -m "test: cover client runtime failure paths"
```

Expected: no manual Effect runtime lint errors, leaked fibers, or real connections; client-runtime functions and branches move above 95% or their remaining gaps are enumerated for Task 8.

### Task 6: Cover Relay HTTP and Worker Boundaries

**Files:**

- Modify: `infra/relay/src/http/Api.test.ts`
- Create: `infra/relay/src/worker.test.ts`
- Test: `infra/relay/src/worker.ts`

**Interfaces:**

- Consumes: existing request builders, auth fixtures, DPoP fixtures, Effect layers, and Worker fetch handler.
- Produces: behavioral coverage for authentication, unlink, proxy, replay, tracing, abort, malformed upstream, and fallback routing.

- [ ] **Step 1: Extend the API request matrix**

Add cases for absent/malformed bearer token; unknown environment; invalid DPoP proof, nonce, method, URL, and replay; unlink authorization; malformed JSON; wrong content type; upstream typed failure; malformed upstream response; canceled request; trace header propagation; and unknown route. Assert status, stable error code, response content type, and required headers.

Use table-driven authentication rows with exact request mutations:

```ts
const authCases = [
  ["missing authorization", {}],
  ["wrong scheme", { Authorization: "Basic abc" }],
  ["empty bearer", { Authorization: "Bearer " }],
  ["missing proof", { Authorization: "Bearer relay-token" }],
] as const;
```

- [ ] **Step 2: Extend Worker lifecycle tests**

Mock the Alchemy and Cloudflare provisioning boundaries before dynamically importing `worker.ts`. Assert `Api.make` receives the deployment effect and worker-construction effect; the worker declares the `2026-05-22` compatibility date and `nodejs_compat` flag; cron uses `*/5 * * * *`; all required runtime binding layers are provided; the API, docs, redirect, CORS, ETag, tracing, and not-found layers participate in fetch construction; and a provisioning failure rejects the import with its original cause. Reset modules between success and failure cases so top-level construction runs twice.

- [ ] **Step 3: Run, measure, and commit**

```bash
vp test infra/relay/src/http/Api.test.ts infra/relay/src/worker.test.ts
vp test --coverage --coverage.reporter=json --coverage.reporter=json-summary --coverage.reporter=text
git add infra/relay/src
git commit -m "test: cover relay request boundaries"
```

Expected: relay functions and lines improve materially without live Clerk, Postgres, or upstream relay calls.

### Task 7: Close Contracts Exporter Branches

**Files:**

- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`
- Modify: `packages/contracts/scripts/export-rust-auth-fixtures.test.ts`
- Test: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`
- Test: `packages/contracts/scripts/export-rust-auth-fixtures.ts`
- Verify unchanged: `packages/contracts/fixtures/rpc-wire/**`
- Verify unchanged: `packages/contracts/fixtures/auth-http/**`

**Interfaces:**

- Consumes: mocked `node:fs/promises` and `node:child_process` boundaries around the real schema reflection and deterministic generators.
- Produces: coverage of formatter success/failure, stale identifiers, optional schemas, stable ordering, and complete manifests.

- [ ] **Step 1: Add deterministic exporter cases**

Assert RPC counts of 80 methods, 14 stream methods, 54 stream-shape fixtures, 122 typed-failure fixtures, 22 orchestration event shapes, 190 sorted paths, and the three known stale method identifiers. Assert auth counts of ten route manifests, 24 fingerprints, and 21 sorted request/response/error fixtures. Import each top-level script twice with `vi.resetModules()` and assert byte-for-byte identical writes.

- [ ] **Step 2: Add formatter failure rows**

Use numeric exit status `2`, signal/null status, rejected spawn, and successful status `0`. Assert the manifest write occurs before formatting failure and the thrown error retains the status description.

- [ ] **Step 3: Run, regenerate, and commit**

```bash
vp test packages/contracts/scripts/export-rust-rpc-fixtures.test.ts packages/contracts/scripts/export-rust-auth-fixtures.test.ts
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
vp run --filter @bibcode/contracts generate:rust-auth-fixtures
git diff --exit-code -- packages/contracts/fixtures
vp test --coverage --coverage.reporter=json --coverage.reporter=json-summary --coverage.reporter=text
git add packages/contracts/scripts
git commit -m "test: cover fixture exporter branches"
```

Expected: fixture regeneration is byte-for-byte clean and contracts branch coverage rises above 95%.

### Task 8: Exhaust the Ranked TypeScript Reserve and Prove 95%

**Files:**

- Modify the existing same-directory tests named in the ordered reserve below, including `scripts/check-dependency-upgrade-ledger.test.ts` for the final script entry.
- Generate locally: `coverage/coverage-final.json`
- Generate locally: `coverage/coverage-summary.json`

**Interfaces:**

- Consumes: fresh per-file V8 counts after Tasks 1-7.
- Produces: a complete report with statements, branches, functions, and lines each at least 95.20% before policy changes.

- [ ] **Step 1: Print the remaining ranked files**

```bash
node - <<'NODE'
const report = require("./coverage/coverage-final.json");
const rows = Object.entries(report).map(([file, value]) => {
  const branches = Object.values(value.b).flat();
  const functions = Object.values(value.f);
  const statements = Object.values(value.s);
  const missedBranches = branches.filter((n) => n === 0).length;
  const missedFunctions = functions.filter((n) => n === 0).length;
  const missedStatements = statements.filter((n) => n === 0).length;
  return { file, score: missedBranches * 3 + missedFunctions * 2 + missedStatements, missedBranches, missedFunctions, missedStatements };
}).filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
console.table(rows.slice(0, 40));
NODE
```

Expected: a descending list based on actual remaining uncovered behavior.

- [ ] **Step 2: Consume the reserve in this fixed ownership order**

For each file still contributing meaningful uncovered counts, add its named behaviors and rerun full coverage before proceeding:

1. `apps/web/src/components/ChatMarkdown.tsx`: safe/unsafe links, copy success/failure, fenced language fallback, long block expand/collapse, tables/task lists, malformed input.
2. `apps/web/src/components/settings/SettingsPanels.tsx`: each panel selection, unavailable panel, narrow navigation, changed connection state.
3. `apps/web/src/components/DiffPanel.tsx`: empty/loading/error/populated, whitespace toggle, file selection, annotation lifecycle.
4. `apps/web/src/components/settings/KeybindingsSettings.tsx`: defaults, search, conflict, invalid chord, reset, persistence failure.
5. `apps/web/src/components/preview/PreviewView.tsx`: no session, create/loading/error, navigation, screenshot, bridge disconnect, stale session.
6. `packages/client-runtime/src/state/runtime.ts`: remaining query/command cancellation and finalizer branches.
7. `packages/client-runtime/src/connection/registry.ts`: remaining replacement/disposal/observer branches.
8. `packages/client-runtime/src/connection/onboarding.ts`: fallback host and pairing branches.
9. `packages/client-runtime/src/state/server.ts`: snapshot/delta/reconnect and malformed revision branches.
10. `packages/client-runtime/src/state/vcsAction.ts`: queued/canceled/stale/rollback branches.
11. `infra/relay/src/worker.ts`: remaining service construction and response finalization functions.
12. `scripts/check-dependency-upgrade-ledger.ts`: missing/invalid/duplicate/sorted/unsorted ledger entries and process exit behavior.

Each reserve test must assert output, public state, typed error, resource cleanup, or exact boundary request. Do not stop because a file's percentage is low; stop only when the aggregate result meets the next step.

- [ ] **Step 3: Run the complete TypeScript report and assert the margin**

```bash
vp test --coverage --coverage.reporter=json --coverage.reporter=json-summary --coverage.reporter=text
node - <<'NODE'
const total = require("./coverage/coverage-summary.json").total;
const required = ["statements", "branches", "functions", "lines"];
for (const metric of required) {
  const value = total[metric].pct;
  if (value < 95.2) throw new Error(`${metric} is ${value}%, below the 95.2% implementation margin`);
  console.log(`${metric}: ${value}%`);
}
NODE
```

Expected: all four metrics print values at or above 95.20%.

- [ ] **Step 4: Commit the final TypeScript cohort**

```bash
git add apps/marketing apps/web infra/relay packages/client-runtime packages/contracts scripts
git status --short
git commit -m "test: reach 95 percent TypeScript coverage"
```

Expected: only intentional source/test files are staged; coverage artifacts remain ignored.
