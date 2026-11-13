// @vitest-environment happy-dom

import type { GitManagerRefEntry, ScopedProjectRef } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitManagerStore } from "../../../gitManagerStore";
import { GitManagerBranchDropdown } from "./GitManagerBranchDropdown";

/**
 * The real LegendList inside the real kept-mounted Popover (#360). happy-dom lays nothing out, so
 * the test says what each element measures: 0 by 0 under a hidden ancestor, as a browser reports
 * it; otherwise a 30 px row, or the 240 px list viewport.
 */
const ROW_HEIGHT = 30;
const VIEWPORT_HEIGHT = 240;
const ROW_SELECTOR = '[class*="h-[30px]"]';

const projectRef = {
  environmentId: "environment-1",
  projectId: "project-1",
} as ScopedProjectRef;

function branches(count: number, generation: number): GitManagerRefEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `branch-${index.toString().padStart(5, "0")}`,
    tipSha: `sha-${generation}-${index}`,
    upstream: null,
    ahead: 0,
    behind: 0,
    current: index === generation,
    isDefault: index === 0,
    worktreePath: null,
    blocked: [],
  }));
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalStackTraceLimit = Error.stackTraceLimit;
let hiddenMeasurements = 0;
let container: HTMLDivElement;
let root: Root | null;
let uncaught: unknown[];
let onSelectBranch = vi.fn();

/** An exit transition the test finishes by hand; Base UI waits on its `finished` promise. */
let exitTransition: { finish: () => void; animation: Animation } | null = null;
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");

function startExitTransition() {
  let finish = () => undefined as void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const animation = {
    finished,
    pending: false,
    playState: "running",
    effect: { getTiming: () => ({ duration: 150, iterations: 1 }) },
  } as unknown as Animation;
  exitTransition = { finish, animation };
}

function stubAnimations() {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value(this: Element) {
      return exitTransition !== null && this.matches('[data-slot="popover-popup"]')
        ? [exitTransition.animation]
        : [];
    },
  });
}

function stubMeasurements() {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.closest("[hidden]") !== null) {
      hiddenMeasurements += 1;
      return DOMRect.fromRect({ width: 0, height: 0 });
    }
    const isRow = this.matches(ROW_SELECTOR) || this.querySelectorAll(ROW_SELECTOR).length === 1;
    return DOMRect.fromRect({ width: 512, height: isRow ? ROW_HEIGHT : VIEWPORT_HEIGHT });
  };
}

/**
 * happy-dom's ResizeObserver never reports. This one reports, like a browser after layout, every
 * observed element whose border box changed since its last report, and its first box.
 */
const observed = new Map<Element, { callback: ResizeObserverCallback; last: string | null }>();
class ReportingResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    observed.set(target, { callback: this.callback, last: null });
  }
  unobserve(target: Element) {
    observed.delete(target);
  }
  disconnect() {
    for (const [target, entry] of observed) {
      if (entry.callback === this.callback) observed.delete(target);
    }
  }
}
globalThis.ResizeObserver = ReportingResizeObserver as unknown as typeof ResizeObserver;

function reportResizes() {
  const byCallback = new Map<ResizeObserverCallback, ResizeObserverEntry[]>();
  for (const [target, entry] of observed) {
    if (!target.isConnected) continue;
    const rect = target.getBoundingClientRect();
    const box = `${rect.width}x${rect.height}`;
    if (box === entry.last) continue;
    entry.last = box;
    const size = [{ blockSize: rect.height, inlineSize: rect.width }];
    const entries = byCallback.get(entry.callback) ?? [];
    entries.push({
      target,
      contentRect: rect,
      borderBoxSize: size,
      contentBoxSize: size,
      devicePixelContentBoxSize: size,
    } as unknown as ResizeObserverEntry);
    byCallback.set(entry.callback, entries);
  }
  for (const [callback, entries] of byCallback) callback(entries, {} as ResizeObserver);
}

async function settle() {
  for (let frame = 0; frame < 5; frame += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    await act(async () => reportResizes());
  }
}

async function renderDropdown(refs: ReadonlyArray<GitManagerRefEntry>, currentBranchName: string) {
  await act(async () =>
    root?.render(
      <GitManagerBranchDropdown
        currentBranchName={currentBranchName}
        branchDisabledReason={null}
        mergeDisabledReason={null}
        triggerDisabledReason={null}
        noBranchLabel="Detached HEAD"
        projectRef={projectRef}
        recentNames={[]}
        refs={refs}
        remoteRefs={[]}
        selectedWorktreeCwd="/opaque/main"
        onCreateBranch={vi.fn()}
        onMergeInto={vi.fn()}
        onSelectBranch={onSelectBranch}
        onSwitchWorktree={vi.fn()}
      />,
    ),
  );
  await settle();
}

async function typeFilter(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]');
  if (input === null) throw new Error("Missing branch filter");
  // React tracks the last value it set; go through the native setter so onChange sees a change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

function branchRowNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>(`${ROW_SELECTOR} .font-mono`)].map(
    (element) => element.textContent ?? "",
  );
}

function trigger(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('[aria-label="Choose branch"]');
  if (button === null) throw new Error("Missing branch trigger");
  return button;
}

async function toggle() {
  await act(async () => trigger().click());
  await settle();
}

function positioner(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]');
  if (element === null) throw new Error("Missing popover positioner");
  return element;
}

function renderedRows(): number {
  return document.querySelectorAll(ROW_SELECTOR).length;
}

/** Names each failure by its message and whether it came from the list's layout measurement. */
function failures(thrown: unknown[]): string[] {
  return [...thrown, ...uncaught].map((error) =>
    error instanceof Error
      ? `${error.message.split(".")[0]} | from measureContainersInLayoutEffect: ${String(
          error.stack?.includes("measureContainersInLayoutEffect"),
        )}`
      : String(error),
  );
}

async function attempt(step: () => Promise<void>, thrown: unknown[]) {
  try {
    await step();
  } catch (error) {
    thrown.push(error);
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Deep enough to show whether an error came from the list's layout measurement.
  Error.stackTraceLimit = 50;
  useGitManagerStore.setState({ byProjectKey: {}, toolbarByProjectKey: {} });
  hiddenMeasurements = 0;
  onSelectBranch = vi.fn();
  observed.clear();
  uncaught = [];
  stubMeasurements();
  exitTransition = null;
  stubAnimations();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container, {
    onUncaughtError: (error) => uncaught.push(error),
    onCaughtError: (error) => uncaught.push(error),
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  document.body.replaceChildren();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  Error.stackTraceLimit = originalStackTraceLimit;
  if (originalGetAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("GitManagerBranchDropdown with the real list and popover (#360)", () => {
  it("a closed branch picker survives a refs update with thousands of branches", async () => {
    const thrown: unknown[] = [];
    await renderDropdown(branches(4_000, 1), "branch-00001");
    await toggle();
    expect(positioner().hidden).toBe(false);
    const rowsWhileOpen = renderedRows();
    expect(rowsWhileOpen).toBeGreaterThan(0);
    await toggle();
    expect(positioner().hidden).toBe(true);

    // A checkout or a fetch replaces the refs while the picker is closed.
    await attempt(() => renderDropdown(branches(4_000, 2), "branch-00002"), thrown);

    expect(failures(thrown)).toEqual([]);
    // Rows that measure 0 by 0 must not widen the hidden list's rendered range.
    expect(renderedRows()).toBeLessThanOrEqual(rowsWhileOpen);
  });

  it("renders and measures no branch row while closed, and reopens with its filter and the current branches", async () => {
    await renderDropdown(branches(4_000, 1), "branch-00001");
    await toggle();
    await typeFilter("branch-039");
    expect(branchRowNames().length).toBeGreaterThan(0);
    await toggle();
    expect(positioner().hidden).toBe(true);

    hiddenMeasurements = 0;
    const refreshed = [...branches(4_000, 2), { ...branches(1, 2)[0]!, name: "branch-039-new" }];
    await renderDropdown(refreshed, "branch-00002");

    expect(renderedRows()).toBe(0);
    expect(hiddenMeasurements).toBe(0);

    await toggle();
    expect(positioner().hidden).toBe(false);
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe(
      "branch-039",
    );
    const names = branchRowNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.includes("branch-039"))).toBe(true);

    await typeFilter("branch-039-new");
    expect(branchRowNames()).toEqual(["branch-039-new"]);
    const row = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "branch-039-new",
    );
    await act(async () => row?.click());
    await settle();
    expect(onSelectBranch).toHaveBeenCalledTimes(1);
    expect(onSelectBranch.mock.calls[0]?.[0]).toMatchObject({ name: "branch-039-new" });
    expect(positioner().hidden).toBe(true);
    expect(uncaught).toEqual([]);
  });

  it("keeps the rows through the closing transition and drops them once it has finished", async () => {
    await renderDropdown(branches(4_000, 1), "branch-00001");
    await toggle();
    const rowsWhileOpen = renderedRows();
    expect(rowsWhileOpen).toBeGreaterThan(0);

    startExitTransition();
    await toggle();
    // The popup is still fading out: its rows stay so it does not empty first.
    expect(positioner().hidden).toBe(false);
    expect(renderedRows()).toBe(rowsWhileOpen);

    await act(async () => exitTransition?.finish());
    await settle();
    expect(positioner().hidden).toBe(true);
    expect(renderedRows()).toBe(0);

    hiddenMeasurements = 0;
    await renderDropdown(branches(4_000, 2), "branch-00002");
    expect(renderedRows()).toBe(0);
    expect(hiddenMeasurements).toBe(0);
    expect(uncaught).toEqual([]);
  });
});
