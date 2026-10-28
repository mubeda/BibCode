// @vitest-environment happy-dom

/**
 * The sidebar prewarmer keeps a thread's subscription warm without React holding its data, and
 * the subscription outlives the prewarmer for the idle retention window only.
 */
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The real thread state atom's TTL is pinned in client-runtime's threads-atoms.test.ts.
const THREAD_STATE_IDLE_TTL_MS = vi.hoisted(() => 5 * 60_000);

const harness = vi.hoisted(() => ({
  mounted: new Map<string, number>(),
  released: new Map<string, number>(),
  atoms: new Map<string, unknown>(),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: {} } }));
vi.mock("./shell", () => ({ environmentSnapshotAtom: {} }));
vi.mock("@bibcode/client-runtime/state/threads", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const { AsyncResult } = await import("effect/reactivity");
  const original = await importOriginal<typeof import("@bibcode/client-runtime/state/threads")>();
  return {
    ...original,
    createThreadEnvironmentAtoms: () => ({}),
    createEnvironmentThreadDetailAtoms: () => ({}),
    createEnvironmentThreadShellAtoms: () => ({}),
    createEnvironmentThreadStateAtoms: () => ({
      stateAtom: (_environmentId: string, threadId: string) => {
        const existing = harness.atoms.get(threadId);
        if (existing !== undefined) return existing;
        const atom = Atom.readable((get) => {
          harness.mounted.set(threadId, (harness.mounted.get(threadId) ?? 0) + 1);
          get.addFinalizer(() =>
            harness.released.set(threadId, (harness.released.get(threadId) ?? 0) + 1),
          );
          return AsyncResult.success(original.EMPTY_ENVIRONMENT_THREAD_STATE);
        }).pipe(Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS));
        harness.atoms.set(threadId, atom);
        return atom;
      },
    }),
  };
});

import { usePrewarmEnvironmentThread } from "./threads";

const environmentId = EnvironmentId.make("environment-prewarm");

function Prewarmer({ threadId }: { readonly threadId: string }) {
  usePrewarmEnvironmentThread(environmentId, ThreadId.make(threadId));
  return null;
}

describe("usePrewarmEnvironmentThread", () => {
  let registry: AtomRegistry.AtomRegistry;
  let container: HTMLElement;
  let root: Root;

  const render = (threadId: string | null) =>
    act(() => {
      root.render(
        <RegistryContext.Provider value={registry}>
          {threadId === null ? null : <Prewarmer threadId={threadId} />}
        </RegistryContext.Provider>,
      );
    });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    harness.mounted.clear();
    harness.released.clear();
    harness.atoms.clear();
    registry = AtomRegistry.make();
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("subscribes on mount and renders no thread data", async () => {
    await render("thread-a");
    expect(harness.mounted.get("thread-a")).toBe(1);
    expect(container.innerHTML).toBe("");
  });

  it("moves the subscription when the thread switches, retaining the previous one for its idle window", async () => {
    await render("thread-a");
    await render("thread-b");
    expect(harness.mounted.get("thread-b")).toBe(1);
    expect(harness.released.get("thread-a") ?? 0).toBe(0);
    vi.advanceTimersByTime(THREAD_STATE_IDLE_TTL_MS + 1_000);
    expect(harness.released.get("thread-a")).toBe(1);
    expect(harness.released.get("thread-b") ?? 0).toBe(0);
  });

  it("keeps the subscription for the idle window after unmount, then releases it", async () => {
    await render("thread-a");
    await render(null);
    vi.advanceTimersByTime(THREAD_STATE_IDLE_TTL_MS - 1_000);
    expect(harness.released.get("thread-a") ?? 0).toBe(0);
    vi.advanceTimersByTime(2_000);
    expect(harness.released.get("thread-a")).toBe(1);
  });
});
