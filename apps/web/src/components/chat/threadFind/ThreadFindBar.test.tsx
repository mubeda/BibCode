// @vitest-environment happy-dom
import {
  EnvironmentId,
  OrchestrationGetThreadHistoryPageError,
  ThreadId,
  type ScopedThreadRef,
} from "@bibcode/contracts";
import type { ThreadOlderHistory } from "@bibcode/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  describeThreadFindStatus,
  ThreadFindBar,
  type ThreadFindOlderHistory,
  useSearchAllOlder,
} from "./ThreadFindBar";
import type { ThreadFindStatus } from "./useThreadFind";

const h = vi.hoisted(() => ({
  olderHistory: null as ThreadOlderHistory | null,
}));

vi.mock("~/state/threads", () => ({
  useThreadFindLoadState: () => ({ status: "live", error: null, hasData: true }),
  useThreadOlderHistory: () => h.olderHistory,
}));

const THREAD_REF: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

function olderHistoryWith(loadAllOlder: ThreadOlderHistory["loadAllOlder"]): ThreadOlderHistory {
  return { status: "idle", loadOlder: Effect.void, loadAllOlder };
}

const roots: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

function controllerWith(status: ThreadFindStatus) {
  return {
    status,
    close: vi.fn(),
    setQuery: vi.fn(),
    submit: vi.fn(),
    step: vi.fn(),
  };
}

async function renderBar(controller: ReturnType<typeof controllerWith>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () =>
    root.render(
      <ThreadFindBar
        query="needle"
        status={controller.status}
        attachInput={() => {}}
        onQueryChange={controller.setQuery}
        onSubmit={controller.submit}
        onStep={controller.step}
        onClose={controller.close}
      />,
    ),
  );
  return container;
}

async function keydown(target: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

const MATCH: ThreadFindStatus = { kind: "match", position: 3, total: 17, stale: false };

describe("ThreadFindBar", () => {
  it("steps with Enter and Shift+Enter, Mod+G, Mod+Shift+G, F3 and Shift+F3", async () => {
    const controller = controllerWith(MATCH);
    const container = await renderBar(controller);
    const input = container.querySelector("input")!;
    const mod = navigator.platform.toLowerCase().includes("mac")
      ? { metaKey: true }
      : { ctrlKey: true };

    await keydown(input, "Enter");
    await keydown(input, "Enter", { shiftKey: true });
    expect(controller.submit).toHaveBeenNthCalledWith(1, "next");
    expect(controller.submit).toHaveBeenNthCalledWith(2, "previous");

    await keydown(input, "g", mod);
    await keydown(input, "G", { ...mod, shiftKey: true });
    await keydown(input, "F3");
    await keydown(input, "F3", { shiftKey: true });
    expect(vi.mocked(controller.step).mock.calls).toEqual([
      ["next"],
      ["previous"],
      ["next"],
      ["previous"],
    ]);
  });

  it("closes on Escape from the input or a button", async () => {
    const controller = controllerWith(MATCH);
    const container = await renderBar(controller);
    await keydown(container.querySelector("input")!, "Escape");
    await keydown(container.querySelector('button[aria-label="Next match"]')!, "Escape");
    expect(controller.close).toHaveBeenCalledTimes(2);
  });

  it("does nothing while an input method composes", async () => {
    const controller = controllerWith(MATCH);
    const container = await renderBar(controller);
    await keydown(container.querySelector("input")!, "Enter", {
      isComposing: true,
    } as KeyboardEventInit);
    expect(controller.submit).not.toHaveBeenCalled();
  });

  it("shows the count with an accessible name, and limits the query to 256 units", async () => {
    const container = await renderBar(controllerWith(MATCH));
    expect(container.textContent).toContain("3/17");
    expect(describeThreadFindStatus(MATCH).announcement).toBe("3 of 17 matches");
    const input = container.querySelector("input")!;
    expect(input.maxLength).toBe(256);
    expect(input.getAttribute("placeholder")).toBe("Find in thread");
    expect(container.querySelector('[role="search"]')?.getAttribute("aria-label")).toBe(
      "Find in thread",
    );
    for (const label of ["Previous match", "Next match", "Close"]) {
      expect(container.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    }
  });

  it("disables Previous and Next with no results and says why beside them", async () => {
    const container = await renderBar(controllerWith({ kind: "none", stale: false }));
    expect(container.textContent).toContain("No results in messages, plans, or commands");
    const previous = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous match"]',
    );
    const next = container.querySelector<HTMLButtonElement>('button[aria-label="Next match"]');
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(true);
  });

  it.each([
    [{ kind: "loading" }, "Loading thread…"],
    [{ kind: "unavailable" }, "This thread could not be loaded"],
    [{ kind: "searching" }, "Searching…"],
    [
      { kind: "none", stale: true },
      "No results in messages, plans, or commands · may be out of date",
    ],
    [{ kind: "match", position: 1, total: 2, stale: true }, "May be out of date"],
  ] as const)("shows the %o status", async (status, text) => {
    const container = await renderBar(controllerWith(status));
    expect(container.textContent).toContain(text);
  });
});

// The thread history window (#226): find searches the loaded messages and says so.
describe("ThreadFindBar with older history", () => {
  async function renderWithOlder(
    status: ThreadFindStatus,
    olderHistory: ThreadFindOlderHistory,
  ): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () =>
      root.render(
        <ThreadFindBar
          query="needle"
          status={status}
          olderHistory={olderHistory}
          attachInput={() => {}}
          onQueryChange={() => {}}
          onSubmit={() => {}}
          onStep={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    return container;
  }
  const button = (container: HTMLElement, text: string) =>
    [...container.querySelectorAll("button")].find((element) => element.textContent === text);

  it("says it searched loaded messages while older history remains", async () => {
    const onSearchAll = vi.fn();
    const container = await renderWithOlder(MATCH, { state: "partial", onSearchAll });
    expect(container.textContent).toContain("Searched loaded messages.");
    await act(async () => button(container, "Search all")!.click());
    expect(onSearchAll).toHaveBeenCalledTimes(1);
    const none = await renderWithOlder(
      { kind: "none", stale: false },
      { state: "loading", onSearchAll },
    );
    expect(none.textContent).toContain("Loading earlier messages…");
    expect(button(none, "Search all")).toBeUndefined();
    // Before a scan there is nothing to qualify.
    const idle = await renderWithOlder({ kind: "idle" }, { state: "partial", onSearchAll });
    expect(idle.textContent).not.toContain("Searched loaded messages.");
  });
});

describe("useSearchAllOlder", () => {
  function Probe(props: { readonly isOpen: boolean }) {
    const olderHistory = useSearchAllOlder(THREAD_REF, true, props.isOpen);
    return (
      <button type="button" data-state={olderHistory?.state} onClick={olderHistory?.onSearchAll}>
        Search all
      </button>
    );
  }
  async function mountProbe() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => root.render(<Probe isOpen />));
    const button = container.querySelector("button")!;
    return {
      state: () => container.querySelector("button")?.dataset.state,
      searchAll: () => act(async () => button.click()),
      close: () => act(async () => root.render(<Probe isOpen={false} />)),
    };
  }
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  it("Search all loads every older page and rescans", async () => {
    let release = () => {};
    const pages = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    h.olderHistory = olderHistoryWith(
      Effect.suspend(() => {
        calls += 1;
        return Effect.promise(() => pages);
      }),
    );
    const probe = await mountProbe();
    await probe.searchAll();
    expect(probe.state()).toBe("loading");
    release();
    await settle();
    expect(calls).toBe(1);
    // Every page loaded: the scan reruns over the new rows (the controller recounts on data).
    expect(probe.state()).toBe("partial");
  });

  it("Search all reports a failed page and offers retry", async () => {
    let fail = true;
    h.olderHistory = olderHistoryWith(
      Effect.suspend(() =>
        fail
          ? Effect.fail(new OrchestrationGetThreadHistoryPageError({ message: "offline" }))
          : Effect.void,
      ),
    );
    const probe = await mountProbe();
    await probe.searchAll();
    await settle();
    expect(probe.state()).toBe("failed");
    fail = false;
    await probe.searchAll();
    await settle();
    expect(probe.state()).toBe("partial");
  });

  it("closing the bar interrupts Search all", async () => {
    let interrupted = false;
    h.olderHistory = olderHistoryWith(
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true)))),
    );
    const probe = await mountProbe();
    await probe.searchAll();
    await settle();
    await probe.close();
    await settle();
    expect(interrupted).toBe(true);
    expect(probe.state()).toBe("partial");
  });
});
