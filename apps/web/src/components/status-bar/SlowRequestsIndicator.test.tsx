// @vitest-environment happy-dom

import { DEFAULT_CLIENT_SETTINGS } from "@bibcode/contracts/settings";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import {
  acknowledgeRpcRequest,
  resetRequestLatencyStateForTests,
  SLOW_RPC_ACK_THRESHOLD_MS,
  trackRpcRequestSent,
} from "../../rpc/requestLatencyState";
import { formatTimestamp } from "../../timestampFormat";
import { AppStatusBarView, SlowRequestsStatusBar } from "./AppStatusBar";
import { SlowRequestsIndicator } from "./SlowRequestsIndicator";

// Counts renders of the indicator: it reads the slow-request list once per render.
const subscription = vi.hoisted(() => ({ renders: 0 }));

vi.mock("../../rpc/requestLatencyState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rpc/requestLatencyState")>();
  return {
    ...actual,
    useSlowRpcAckRequests: () => {
      subscription.renders += 1;
      return actual.useSlowRpcAckRequests();
    },
  };
});

const FIRST_STARTED_AT = "2026-09-26T10:00:00.000Z";
const SECOND_STARTED_AT = "2026-09-26T10:00:04.000Z";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render(children: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<AppAtomRegistryProvider>{children}</AppAtomRegistryProvider>);
  });
  return container;
}

async function rerender(children: ReactNode): Promise<void> {
  const entry = mounted.at(-1);
  if (entry === undefined) throw new Error("Nothing is mounted to re-render.");
  await act(async () => {
    entry.root.render(<AppAtomRegistryProvider>{children}</AppAtomRegistryProvider>);
  });
}

function statusBarView(
  terminalCount: number,
  { showResourceUsage = false }: { readonly showResourceUsage?: boolean } = {},
): ReactNode {
  return (
    <AppStatusBarView
      usage={null}
      diagnostics={{ diagnostics: null, queryError: null }}
      localDiagnostics={null}
      terminalCount={terminalCount}
      showResourceUsage={showResourceUsage}
      onRefresh={() => undefined}
    />
  );
}

/**
 * Sends requests through the real latency tracker and lets the slow threshold pass
 * without an acknowledgement. Each request starts at its own fixed time.
 */
function sendUnansweredRequests(
  requests: ReadonlyArray<{
    readonly id: string;
    readonly tag: string;
    readonly startedAt: string;
  }>,
): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    for (const request of requests) {
      vi.setSystemTime(new Date(request.startedAt));
      trackRpcRequestSent(request.id, request.tag);
    }
    act(() => {
      vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS);
    });
  } finally {
    vi.useRealTimers();
  }
}

async function finish(requestId: string): Promise<void> {
  await act(async () => {
    acknowledgeRpcRequest(requestId);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Lets animation-frame work run, such as Base UI moving or returning focus. */
async function nextFrames(): Promise<void> {
  await act(async () => {
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

function oneSlowRequest(): void {
  sendUnansweredRequests([
    { id: "one", tag: "projects.listEntries · primary", startedAt: FIRST_STARTED_AT },
  ]);
}

function indicator(container: ParentNode = document): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      /slow request/.test(button.textContent ?? ""),
    ) ?? null
  );
}

function requireIndicator(container: ParentNode = document): HTMLButtonElement {
  const button = indicator(container);
  if (button === null) throw new Error("The slow-request indicator was not rendered.");
  return button;
}

function openList(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-slot="popover-popup"]')).find(
      (popup) => !popup.closest('[data-slot="popover-positioner"]')?.hasAttribute("hidden"),
    ) ?? null
  );
}

function announcement(container: ParentNode): string | null {
  return container.querySelector('[role="status"]')?.textContent ?? null;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

async function pressEnter(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    const keydown = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    target.dispatchEvent(keydown);
    target.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }),
    );
    if (!keydown.defaultPrevented) {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    }
  });
  await settle();
}

async function pressEscape(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    target.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetRequestLatencyStateForTests();
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  resetRequestLatencyStateForTests();
  vi.useRealTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("SlowRequestsIndicator", () => {
  it("stays hidden while no request is slow", async () => {
    const container = await render(<SlowRequestsIndicator />);
    expect(indicator(container)).toBeNull();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      trackRpcRequestSent("pending", "git.status · primary");
      act(() => {
        vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS - 1);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(indicator(container)).toBeNull();
    expect(announcement(container)).toBe("");
  });

  it("counts one slow request in the singular and several in the plural", async () => {
    const container = await render(<SlowRequestsIndicator />);

    sendUnansweredRequests([
      { id: "one", tag: "projects.listEntries · primary", startedAt: FIRST_STARTED_AT },
    ]);
    const trigger = requireIndicator(container);
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.type).toBe("button");
    expect(trigger.textContent).toBe("1 slow request");

    sendUnansweredRequests([
      { id: "two", tag: "git.status · primary", startedAt: SECOND_STARTED_AT },
    ]);
    expect(requireIndicator(container).textContent).toBe("2 slow requests");
  });

  it("lists each slow request's name and start time", async () => {
    const container = await render(<SlowRequestsIndicator />);
    sendUnansweredRequests([
      { id: "one", tag: "projects.listEntries · primary", startedAt: FIRST_STARTED_AT },
      { id: "two", tag: "git.status · remote-1", startedAt: SECOND_STARTED_AT },
    ]);

    await click(requireIndicator(container));

    const list = openList();
    if (list === null) throw new Error("The slow-request list did not open.");
    const items = Array.from(list.querySelectorAll("li"));
    expect(items.map((item) => item.querySelector("time")?.getAttribute("dateTime"))).toEqual([
      FIRST_STARTED_AT,
      SECOND_STARTED_AT,
    ]);
    expect(items[0]?.textContent).toContain("projects.listEntries · primary");
    expect(items[0]?.querySelector("time")?.textContent).toBe(
      formatTimestamp(FIRST_STARTED_AT, DEFAULT_CLIENT_SETTINGS.timestampFormat),
    );
    expect(items[1]?.textContent).toContain("git.status · remote-1");
    expect(items[1]?.querySelector("time")?.textContent).toBe(
      formatTimestamp(SECOND_STARTED_AT, DEFAULT_CLIENT_SETTINGS.timestampFormat),
    );
  });

  it("disappears when the slow requests finish", async () => {
    const container = await render(<SlowRequestsIndicator />);
    sendUnansweredRequests([
      { id: "one", tag: "projects.listEntries · primary", startedAt: FIRST_STARTED_AT },
      { id: "two", tag: "git.status · primary", startedAt: SECOND_STARTED_AT },
    ]);

    await finish("one");
    expect(requireIndicator(container).textContent).toBe("1 slow request");

    await finish("two");
    expect(indicator(container)).toBeNull();
  });

  it("closes an open list when the last slow request finishes", async () => {
    const container = await render(<SlowRequestsIndicator />);
    sendUnansweredRequests([
      { id: "one", tag: "projects.listEntries · primary", startedAt: FIRST_STARTED_AT },
    ]);
    await click(requireIndicator(container));
    expect(openList()).not.toBeNull();

    await finish("one");

    expect(indicator(container)).toBeNull();
    expect(openList()).toBeNull();
  });

  it("names the list with its heading and describes the wait", async () => {
    const container = await render(<SlowRequestsIndicator />);
    oneSlowRequest();

    await click(requireIndicator(container));

    const list = openList();
    if (list === null) throw new Error("The slow-request list did not open.");
    expect(list.hasAttribute("aria-label")).toBe(false);
    const heading = document.getElementById(list.getAttribute("aria-labelledby") ?? "");
    expect(heading?.tagName).toBe("H2");
    expect(heading?.textContent).toBe("Slow requests");
    const description = document.getElementById(list.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Waiting more than 15 seconds for a response.");
  });

  it("opens from the keyboard, closes on Escape, and returns focus to the trigger", async () => {
    const container = await render(<SlowRequestsIndicator />);
    oneSlowRequest();
    const trigger = requireIndicator(container);

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await pressEnter(trigger);
    await nextFrames();
    const list = openList();
    if (list === null) throw new Error("Enter did not open the slow-request list.");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // Focus moves into the list, so a screen reader starts reading it.
    expect(list.contains(document.activeElement)).toBe(true);

    await pressEscape(document.activeElement ?? trigger);

    expect(openList()).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("announces the first slow request once, not on every count change", async () => {
    const container = await render(<SlowRequestsIndicator />);
    const region = container.querySelector('[role="status"]');
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(announcement(container)).toBe("");

    sendUnansweredRequests([
      { id: "one", tag: "projects.listEntries · primary", startedAt: FIRST_STARTED_AT },
    ]);
    expect(announcement(container)).toBe("Some requests are slow");
    // The same live region stays mounted, so screen readers hear changes to it.
    expect(container.querySelector('[role="status"]')).toBe(region);

    sendUnansweredRequests([
      { id: "two", tag: "git.status · primary", startedAt: SECOND_STARTED_AT },
    ]);
    expect(announcement(container)).toBe("Some requests are slow");

    await finish("one");
    expect(announcement(container)).toBe("Some requests are slow");

    await finish("two");
    expect(announcement(container)).toBe("");
    expect(container.querySelector('[role="status"]')).toBe(region);
  });

  it("appears in the status bar", async () => {
    const container = await render(statusBarView(0));
    const statusBar = container.querySelector('[data-testid="app-status-bar"]');
    if (statusBar === null) throw new Error("The status bar was not rendered.");
    expect(indicator(statusBar)).toBeNull();

    sendUnansweredRequests([
      { id: "one", tag: "projects.listEntries · primary", startedAt: FIRST_STARTED_AT },
    ]);

    expect(requireIndicator(statusBar).textContent).toBe("1 slow request");
  });

  it("does not re-render when the rest of the status bar re-renders", async () => {
    await render(statusBarView(0));
    sendUnansweredRequests([
      { id: "one", tag: "projects.listEntries · primary", startedAt: FIRST_STARTED_AT },
    ]);
    const rendersWithSlowRequest = subscription.renders;

    // The status bar re-renders on its own polling, for example when the terminal count changes.
    await rerender(statusBarView(1));
    await rerender(statusBarView(2));

    expect(subscription.renders).toBe(rendersWithSlowRequest);
    expect(requireIndicator().textContent).toBe("1 slow request");
  });
});

describe("focus when the indicator leaves", () => {
  it("moves focus to the next status bar item when the last request finishes inside the open list", async () => {
    await render(statusBarView(0, { showResourceUsage: true }));
    oneSlowRequest();
    const trigger = requireIndicator();
    trigger.focus();
    await pressEnter(trigger);
    await nextFrames();
    expect(openList()?.contains(document.activeElement)).toBe(true);

    await finish("one");
    await nextFrames();

    const resources = document.querySelector<HTMLButtonElement>(
      '[aria-label^="Combined monitored resources"]',
    );
    expect(resources).not.toBeNull();
    expect(document.activeElement).toBe(resources);
  });

  it("moves focus to the control before the indicator when nothing follows it in the bar", async () => {
    await render(
      <>
        <button type="button">Last control</button>
        <SlowRequestsStatusBar />
      </>,
    );
    oneSlowRequest();
    const trigger = requireIndicator();
    trigger.focus();

    await finish("one");
    await nextFrames();

    expect(document.activeElement?.textContent).toBe("Last control");
  });

  it("leaves focus alone when the indicator did not have it", async () => {
    await render(
      <>
        <button type="button">Elsewhere</button>
        {statusBarView(0, { showResourceUsage: true })}
      </>,
    );
    oneSlowRequest();
    const elsewhere = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Elsewhere",
    );
    if (elsewhere === undefined) throw new Error("The other control was not rendered.");
    elsewhere.focus();

    await finish("one");
    await nextFrames();

    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("SlowRequestsStatusBar", () => {
  it("takes no space until a request is slow, then shows the indicator", async () => {
    const container = await render(<SlowRequestsStatusBar />);
    const bar = container.querySelector<HTMLElement>('[data-testid="slow-requests-status-bar"]');
    if (bar === null) throw new Error("The hosted status bar was not rendered.");
    const region = bar.querySelector('[role="status"]');
    expect(bar.hasAttribute("data-collapsed")).toBe(true);
    expect(indicator(bar)).toBeNull();
    expect(region?.textContent).toBe("");

    oneSlowRequest();

    expect(bar.hasAttribute("data-collapsed")).toBe(false);
    expect(requireIndicator(bar).textContent).toBe("1 slow request");
    // The live region stays mounted while the bar collapses and opens.
    expect(bar.querySelector('[role="status"]')).toBe(region);
    expect(region?.textContent).toBe("Some requests are slow");

    await finish("one");

    expect(bar.hasAttribute("data-collapsed")).toBe(true);
    expect(indicator(bar)).toBeNull();
    expect(bar.querySelector('[role="status"]')).toBe(region);
  });
});
