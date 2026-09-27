// @vitest-environment happy-dom

/**
 * Guards the React Compiler lane of the web unit tests.
 *
 * The client build compiles components and hooks with the React Compiler. The web
 * package's own test config (`vp run test`, which CI runs) compiles happy-dom files
 * the same way. Node-environment files are not compiled, and the repository-root
 * config (`vp test`) runs no React plugins, so it excludes this file. See
 * docs/testing/README.md.
 *
 * The fixture reproduces a real bug. A hook read mutable state during render through
 * a call whose only argument was a stable key. The compiler cached that read on the
 * key, so whether a query was awaiting Retry was computed once, at mount. The rule
 * that fixed it, reading the latch against the rendered emission, is in
 * docs/architecture/connection-runtime.md under "State and retry policy".
 */
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

interface Emission {
  readonly failed: boolean;
}

/** An emission source, like an environment query atom. */
interface Query {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => Emission;
  /** Latches the query and emits a failure together, as the query runtime does. */
  readonly failAndLatch: () => void;
}

/** Mutable state keyed by a stable object, like the query runtime's Retry latch. */
const latches = new WeakMap<Query, boolean>();

function makeQuery(): Query {
  let emission: Emission = { failed: false };
  const listeners = new Set<() => void>();
  const query: Query = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => emission,
    failAndLatch: () => {
      latches.set(query, true);
      emission = { failed: true };
      for (const listener of listeners) listener();
    },
  };
  return query;
}

/** The buggy read: its only argument is the stable query. */
function isLatched(query: Query): boolean {
  return latches.get(query) ?? false;
}

/** The fix: the rendered emission is an argument too, so a new emission re-reads the latch. */
function isLatchedWhileFailing(query: Query, emission: Emission): boolean {
  return emission.failed && (latches.get(query) ?? false);
}

// Two hooks on purpose: a shared one would cache its read on the emission, disarming the guard.
function useStaleLatchView(query: Query) {
  const emission = useSyncExternalStore(query.subscribe, query.getSnapshot);
  return { emission, latched: isLatched(query) };
}

function useFreshLatchView(query: Query) {
  const emission = useSyncExternalStore(query.subscribe, query.getSnapshot);
  return { emission, latched: isLatchedWhileFailing(query, emission) };
}

// Two probes on purpose: the compiler won't compile a probe that takes its hook as a prop.
function StaleLatchProbe({ query }: { readonly query: Query }) {
  const view = useStaleLatchView(query);
  return <output>{`failed=${view.emission.failed} latched=${view.latched}`}</output>;
}

function FreshLatchProbe({ query }: { readonly query: Query }) {
  const view = useFreshLatchView(query);
  return <output>{`failed=${view.emission.failed} latched=${view.latched}`}</output>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("React Compiler in happy-dom unit tests", () => {
  it("caches a render-time read on its stable argument, so the read goes stale", async () => {
    const query = makeQuery();
    await act(async () => root.render(<StaleLatchProbe query={query} />));
    expect(container.textContent).toBe("failed=false latched=false");

    await act(async () => query.failAndLatch());

    // The new emission rendered, but the compiled hook reused the latch read it
    // cached on the unchanged query.
    expect(
      container.textContent,
      "latched=true: this file no longer runs through the React Compiler, or the compiler " +
        "stopped caching this read by its arguments (for example after an upgrade of " +
        "babel-plugin-react-compiler, which apps/web pins at 1.0.0)",
    ).toBe("failed=true latched=false");
  });

  it("re-reads the state when the rendered emission is an argument of the read", async () => {
    const query = makeQuery();
    await act(async () => root.render(<FreshLatchProbe query={query} />));
    expect(container.textContent).toBe("failed=false latched=false");

    await act(async () => query.failAndLatch());

    expect(container.textContent).toBe("failed=true latched=true");
  });
});
