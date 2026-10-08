# GitLab Merge Request Visible Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visible GitLab merge-request route refreshes itself every 20 seconds, prefetches a hovered row, and keeps the last good body on screen when a refresh fails.

**Architecture:** Timing and prefetch-cap decisions are pure functions under `apps/web`. A hook owns the document visibility listener and calls `revalidate` (not the explicit Refresh action). `usePullRequestsQuery` remembers the last displayed value so a later failure does not blank the panel. GitHub routes do not mount the timer or the prefetch.

**Tech Stack:** React 19, Vitest via `node scripts/run-local-vp.mjs`, happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-08-gitlab-merge-request-background-sync-design.md` (slice 1).

## Global Constraints

- GitLab only. `context.provider === "gitlab"`. GitHub routes keep today's atoms.
- Refresh period is 20_000 ms after the last successful response.
- The timer runs only while the route is mounted and `document.visibilityState === "visible"`.
- Showing the document refreshes immediately when the last success is older than 5_000 ms, then the 20_000 ms period starts.
- Do not use `Atom.withRefresh`. Do not use the supervisor `application-active` wakeup.
- The open detail refreshes `get` and the active tab only.
- Hover prefetch waits 150 ms, starts `get` and `getTimeline`, caps at 2 in flight per environment, and is not cancelled once started. Do not prefetch rows merely because they scrolled into view.
- A refresh failure with a previously displayed body keeps that body and shows a Retry banner. A failure with no displayed body keeps the full-panel error. The skeleton remains only when there is no body and no error.
- Use `revalidate`, not `refresh`, so a timer tick does not reset list scroll or set `refreshTotals`.
- Update `docs/architecture/rpc-and-orchestration.md` in the same change: a visible GitLab merge request route may refresh on the 20 s period; hidden and unmounted routes do not; GitHub stays on demand.
- Run web tests with `node ../../scripts/run-local-vp.mjs test run <file>` from `apps/web`.

---

### Task 1: Visible-refresh decisions

**Files:**
- Create: `apps/web/src/components/pullRequests/visibleRefresh.logic.ts`
- Test: `apps/web/src/components/pullRequests/visibleRefresh.logic.test.ts`

**Interfaces:**
- Produces: `VISIBLE_REFRESH_MS = 20_000`, `FRESH_MS = 5_000`, `visibleRefreshDelay(visible: boolean, lastSuccessAt: number | null, now: number): number | null`, `shouldRefreshOnShow(lastSuccessAt: number | null, now: number): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vite-plus/test";
import {
  FRESH_MS,
  VISIBLE_REFRESH_MS,
  shouldRefreshOnShow,
  visibleRefreshDelay,
} from "./visibleRefresh.logic";

describe("visibleRefreshDelay", () => {
  it("waits 20s from the last success while visible", () => {
    expect(visibleRefreshDelay(true, 1_000, 1_000)).toBe(VISIBLE_REFRESH_MS);
    expect(visibleRefreshDelay(true, 1_000, 6_000)).toBe(15_000);
  });

  it("does not schedule while hidden or before any success", () => {
    expect(visibleRefreshDelay(false, 1_000, 2_000)).toBeNull();
    expect(visibleRefreshDelay(true, null, 2_000)).toBeNull();
  });

  it("is due immediately once the period has elapsed", () => {
    expect(visibleRefreshDelay(true, 0, VISIBLE_REFRESH_MS)).toBe(0);
  });
});

describe("shouldRefreshOnShow", () => {
  it("refreshes when the last success is older than 5s", () => {
    expect(shouldRefreshOnShow(0, FRESH_MS)).toBe(false);
    expect(shouldRefreshOnShow(0, FRESH_MS + 1)).toBe(true);
    expect(shouldRefreshOnShow(null, 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/web`: `node ../../scripts/run-local-vp.mjs test run src/components/pullRequests/visibleRefresh.logic.test.ts`

Expected: FAIL — cannot find `./visibleRefresh.logic`.

- [ ] **Step 3: Implement the decisions**

```ts
export const VISIBLE_REFRESH_MS = 20_000;
export const FRESH_MS = 5_000;

export function visibleRefreshDelay(
  visible: boolean,
  lastSuccessAt: number | null,
  now: number,
): number | null {
  if (!visible || lastSuccessAt === null) return null;
  return Math.max(0, lastSuccessAt + VISIBLE_REFRESH_MS - now);
}

export function shouldRefreshOnShow(lastSuccessAt: number | null, now: number): boolean {
  return lastSuccessAt !== null && now - lastSuccessAt > FRESH_MS;
}
```

- [ ] **Step 4: Re-run the test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/pullRequests/visibleRefresh.logic.ts apps/web/src/components/pullRequests/visibleRefresh.logic.test.ts
git commit -m "test(web): decide when a visible merge request refreshes"
```

### Task 2: Visibility hook on the list and the detail

**Files:**
- Create: `apps/web/src/components/pullRequests/useVisiblePullRequestRefresh.ts`
- Modify: `apps/web/src/components/pullRequests/list/PullRequestsListView.tsx` (the `PullRequestsListView` function, after `firstQuery`)
- Modify: `apps/web/src/components/pullRequests/detail/PullRequestsDetailView.tsx` (after `activeQuery`)
- Test: `apps/web/src/components/pullRequests/useVisiblePullRequestRefresh.test.tsx`

**Interfaces:**
- Consumes: `visibleRefreshDelay`, `shouldRefreshOnShow`.
- Produces: `useVisiblePullRequestRefresh({ enabled, succeeded, revalidate }: { enabled: boolean; succeeded: boolean; revalidate: () => void }): void`.

- [ ] **Step 1: Write the failing hook test**

```tsx
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useVisiblePullRequestRefresh } from "./useVisiblePullRequestRefresh";

function Probe({
  enabled,
  succeeded,
  revalidate,
}: {
  enabled: boolean;
  succeeded: boolean;
  revalidate: () => void;
}) {
  useVisiblePullRequestRefresh({ enabled, succeeded, revalidate });
  return null;
}

describe("useVisiblePullRequestRefresh", () => {
  let root: Root;
  let node: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    node = document.createElement("div");
    document.body.appendChild(node);
    root = createRoot(node);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    act(() => root.unmount());
    node.remove();
    vi.useRealTimers();
  });

  it("revalidates 20s after a visible success and stops when hidden", () => {
    const revalidate = vi.fn();
    act(() => {
      root.render(createElement(Probe, { enabled: true, succeeded: true, revalidate }));
    });
    act(() => vi.advanceTimersByTime(19_999));
    expect(revalidate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(revalidate).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(60_000));
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("does not schedule for a disabled route", () => {
    const revalidate = vi.fn();
    act(() => {
      root.render(createElement(Probe, { enabled: false, succeeded: true, revalidate }));
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("revalidates on show when the last success is older than 5s", () => {
    const revalidate = vi.fn();
    act(() => {
      root.render(createElement(Probe, { enabled: true, succeeded: true, revalidate }));
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(5_001));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it**

Run from `apps/web`: `node ../../scripts/run-local-vp.mjs test run src/components/pullRequests/useVisiblePullRequestRefresh.test.tsx`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook and mount it**

```ts
import { useEffect, useRef } from "react";
import { shouldRefreshOnShow, visibleRefreshDelay } from "./visibleRefresh.logic";

export function useVisiblePullRequestRefresh({
  enabled,
  succeeded,
  revalidate,
}: {
  enabled: boolean;
  succeeded: boolean;
  revalidate: () => void;
}): void {
  const lastSuccessAt = useRef<number | null>(null);
  const revalidateRef = useRef(revalidate);
  revalidateRef.current = revalidate;
  if (succeeded && lastSuccessAt.current === null) lastSuccessAt.current = Date.now();

  useEffect(() => {
    if (!enabled) return;
    let timer: number | null = null;
    const clear = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      clear();
      const delay = visibleRefreshDelay(
        document.visibilityState === "visible",
        lastSuccessAt.current,
        Date.now(),
      );
      if (delay === null) return;
      timer = window.setTimeout(() => {
        lastSuccessAt.current = null;
        revalidateRef.current();
      }, delay);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        clear();
        return;
      }
      if (shouldRefreshOnShow(lastSuccessAt.current, Date.now())) {
        lastSuccessAt.current = null;
        revalidateRef.current();
        return;
      }
      arm();
    };
    document.addEventListener("visibilitychange", onVisibility);
    arm();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clear();
    };
  }, [enabled, succeeded]);
}
```

In `PullRequestsListView`, after `firstQuery` is created:

```tsx
useVisiblePullRequestRefresh({
  enabled: context.provider === "gitlab",
  succeeded: firstQuery.data !== null && firstQuery.error === null && !firstQuery.isPending,
  revalidate: firstQuery.revalidate,
});
```

In `PullRequestsDetailView`, after `activeQuery`:

```tsx
useVisiblePullRequestRefresh({
  enabled: context.provider === "gitlab",
  succeeded: detailQuery.data !== null && detailQuery.error === null && !detailQuery.isPending,
  revalidate: detailQuery.revalidate,
});
useVisiblePullRequestRefresh({
  enabled: context.provider === "gitlab" && activeQuery.data !== null,
  succeeded: activeQuery.data !== null && activeQuery.error === null && !activeQuery.isPending,
  revalidate: activeQuery.revalidate,
});
```

Pass `enabled: context.provider === "gitlab"` for both calls. Inactive tabs already pass `null` to `usePullRequestsQuery`, and `revalidate` on that empty query is the no-op from `useEnvironmentQuery`.

- [ ] **Step 4: Re-run the hook test**

Expected: PASS. Then run `node ../../scripts/run-local-vp.mjs test run src/components/pullRequests/list/PullRequestsListView.test.tsx src/components/pullRequests/detail/PullRequestsDetailView.test.tsx`.

Expected: PASS. If a list or detail test renders with `provider: "gitlab"` and fake timers are not installed, the new effect only listens for `visibilitychange`; it must not call `refresh`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/pullRequests/useVisiblePullRequestRefresh.ts apps/web/src/components/pullRequests/useVisiblePullRequestRefresh.test.tsx apps/web/src/components/pullRequests/list/PullRequestsListView.tsx apps/web/src/components/pullRequests/detail/PullRequestsDetailView.tsx
git commit -m "feat(web): refresh a visible GitLab merge request every 20s"
```

### Task 3: Hover prefetch cap

**Files:**
- Create: `apps/web/src/components/pullRequests/hoverPrefetch.logic.ts`
- Create: `apps/web/src/components/pullRequests/useMergeRequestHoverPrefetch.ts`
- Modify: `apps/web/src/components/pullRequests/list/PullRequestsRow.tsx` (props and the root `div`)
- Modify: `apps/web/src/components/pullRequests/list/PullRequestsListView.tsx` (`renderRow`, pass `scope`)
- Test: `apps/web/src/components/pullRequests/hoverPrefetch.logic.test.ts`
- Test: `apps/web/src/components/pullRequests/useMergeRequestHoverPrefetch.test.tsx`

**Interfaces:**
- Produces: `HOVER_PREFETCH_MS = 150`, `MAX_HOVER_PREFETCHES = 2`, `createPrefetchGate(): { tryAcquire(): boolean; release(): void }`.
- Produces: `useMergeRequestHoverPrefetch({ enabled, environmentId, cwd, number }): { onPointerEnter(): void; onPointerLeave(): void }`. On fire it mounts reads by calling `pullRequestsEnvironment.get` and `pullRequestsEnvironment.getTimeline` with `{ environmentId, input: { cwd, number } }` and subscribes with a module-level `Atom.runtime` is the wrong layer. Subscribe from the hook with `useAtomValue` only after the gate is acquired: local state `armed: boolean`, set true after 150 ms if `tryAcquire()` returns true, render nothing, and `usePullRequestsQuery` both atoms while `armed` is true. Release the gate when both queries have settled (`!isPending` and (`data !== null` or `error !== null`)).

- [ ] **Step 1: Write the failing gate test**

```ts
import { describe, expect, it } from "vite-plus/test";
import { createPrefetchGate, MAX_HOVER_PREFETCHES } from "./hoverPrefetch.logic";

describe("createPrefetchGate", () => {
  it("allows two acquisitions and refuses the third until one releases", () => {
    const gate = createPrefetchGate();
    expect(MAX_HOVER_PREFETCHES).toBe(2);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    gate.release();
    expect(gate.tryAcquire()).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

Run from `apps/web`: `node ../../scripts/run-local-vp.mjs test run src/components/pullRequests/hoverPrefetch.logic.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the gate**

```ts
export const HOVER_PREFETCH_MS = 150;
export const MAX_HOVER_PREFETCHES = 2;

export function createPrefetchGate() {
  let inflight = 0;
  return {
    tryAcquire(): boolean {
      if (inflight >= MAX_HOVER_PREFETCHES) return false;
      inflight += 1;
      return true;
    },
    release(): void {
      inflight = Math.max(0, inflight - 1);
    },
  };
}

export const hoverPrefetchGate = createPrefetchGate();
```

One module-level `hoverPrefetchGate` is the per-page cap. The spec says per environment. Key the gates:

```ts
const gates = new Map<string, ReturnType<typeof createPrefetchGate>>();
export function prefetchGate(environmentId: string) {
  let gate = gates.get(environmentId);
  if (!gate) {
    gate = createPrefetchGate();
    gates.set(environmentId, gate);
  }
  return gate;
}
```

- [ ] **Step 4: Write the hook test and implement the hook**

Test, in `useMergeRequestHoverPrefetch.test.tsx` (`@vitest-environment happy-dom`): render a probe that spreads the hook's pointer handlers onto a `div`. Mock `../../../state/pullRequests` so `get` and `getTimeline` return distinct tokens and record calls. Mock `usePullRequestsQuery` to return `{ data: null, error: null, isPending: true, emission: { _tag: "Initial" } }` until the test flips a `settled` flag. Assert:

- pointerenter then 149 ms: `get` was not called
- 1 ms more: `get` and `getTimeline` were each called once with `{ environmentId, input: { cwd, number } }`
- pointerleave before 150 ms: neither was called
- a third probe in the same environment does not call `get` while two are still pending
- after the first probe's queries settle, `release` allows another acquire (call `get` for a new number)

Implement `useMergeRequestHoverPrefetch` with `window.setTimeout(..., HOVER_PREFETCH_MS)`. Clear that timeout on pointerleave and on unmount when not yet armed. After arming, do not clear the reads. While armed, call `usePullRequestsQuery(pullRequestsEnvironment.get(...))` and `usePullRequestsQuery(pullRequestsEnvironment.getTimeline(...))`. Hooks cannot be conditional: always call both `useMemo` atom factories and pass `armed ? atom : null` to `usePullRequestsQuery`, which already accepts null.

`PullRequestsRow` gains optional `scope?: { environmentId: EnvironmentId; cwd: string }`. When `scope` is present and `context.provider === "gitlab"`, attach `onPointerEnter` and `onPointerLeave`. `renderRow` passes `scope`.

- [ ] **Step 5: Re-run both tests plus `PullRequestsListView.test.tsx`**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/pullRequests/hoverPrefetch.logic.ts apps/web/src/components/pullRequests/hoverPrefetch.logic.test.ts apps/web/src/components/pullRequests/useMergeRequestHoverPrefetch.ts apps/web/src/components/pullRequests/useMergeRequestHoverPrefetch.test.tsx apps/web/src/components/pullRequests/list/PullRequestsRow.tsx apps/web/src/components/pullRequests/list/PullRequestsListView.tsx
git commit -m "feat(web): prefetch a hovered GitLab merge request"
```

### Task 4: Keep the last body when a refresh fails

**Files:**
- Modify: `apps/web/src/components/pullRequests/shared/usePullRequestsQuery.ts`
- Modify: `apps/web/src/components/pullRequests/detail/PullRequestsQueryState.tsx`
- Test: `apps/web/src/components/pullRequests/shared/usePullRequestsQuery.test.tsx`
- Test: `apps/web/src/components/pullRequests/detail/PullRequestsQueryState.test.tsx`

**Interfaces:**
- Consumes: `EnvironmentQueryView` from `apps/web/src/state/query.ts`.
- The displayed-data ref lives inside `usePullRequestsQuery` and resets when `atom` changes.

- [ ] **Step 1: Write the failing query test**

Drive `usePullRequestsQuery` with a fake `useEnvironmentQuery` by rendering a probe. First emission: `{ data: { rows: [1] }, error: null, isPending: false, emission: { _tag: "Success", waiting: false }, requiresRetry: false, refresh() {}, revalidate() {} }`. Second emission, same atom: `{ data: null, error: "GitLab timed out", isPending: false, emission: { _tag: "Failure" }, ... }`. Expect the hook's returned `data` to still be `{ rows: [1] }` and `error` to be `"GitLab timed out"`. A different atom must not keep the previous atom's data.

- [ ] **Step 2: Run it**

Expected: FAIL — data is null on the failure emission.

- [ ] **Step 3: Remember the last displayed value**

At the end of `usePullRequestsQuery`, after the existing open-hide returns:

```ts
const shown = useRef<{ atom: typeof atom; data: A | null }>({ atom, data: null });
if (shown.current.atom !== atom) shown.current = { atom, data: null };
const view = /* the value the function already returns */;
if (view.data !== null) shown.current = { atom, data: view.data };
if (view.data === null && view.error !== null && shown.current.data !== null)
  return { ...view, data: shown.current.data };
return view;
```

Do this only on the final return. The open-hide branch returns `data: null` and `error: null` while a cached failure is being replaced; that branch must stay as it is, and it must not write `shown`.

- [ ] **Step 4: Banner in `PullRequestsQueryState`**

When `message !== null && query.data !== null`, render the existing alert (message, `hostDetail`, Retry) as a `role="alert"` banner, then `{children}`. When `message !== null && query.data === null`, keep today's full-panel return. Add `PullRequestsQueryState.test.tsx` with two cases: data plus error renders the alert and the child text; error and `data: null` renders the alert and does not render the child.

- [ ] **Step 5: Re-run the new tests and `PullRequestsDetailView.test.tsx`**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/pullRequests/shared/usePullRequestsQuery.ts apps/web/src/components/pullRequests/shared/usePullRequestsQuery.test.tsx apps/web/src/components/pullRequests/detail/PullRequestsQueryState.tsx apps/web/src/components/pullRequests/detail/PullRequestsQueryState.test.tsx
git commit -m "fix(web): keep merge request content when a refresh fails"
```

### Task 5: Living rule

**Files:**
- Modify: `docs/architecture/rpc-and-orchestration.md` (the paragraph that begins "Reads begin on route/tab/picker open")

- [ ] **Step 1: Add one sentence after the existing "No timer..." sentence**

A visible, mounted GitLab merge request list or detail route refreshes its mounted queries 20 s after the last success and prefetches `get` plus `getTimeline` for a row hovered 150 ms, at most two per environment. Hiding the document or leaving the route stops that timer. GitHub routes do not. The explicit Refresh action is unchanged.

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/rpc-and-orchestration.md
git commit -m "docs: record the visible GitLab merge request refresh"
```

## Slice 1 done when

- The three new test files and the existing list and detail tests pass.
- A GitHub context never calls the timer's `revalidate` in the hook test's disabled case, and the list/detail views pass `enabled: context.provider === "gitlab"`.
- `docs/architecture/rpc-and-orchestration.md` names the 20 s visible refresh and the hover cap.
