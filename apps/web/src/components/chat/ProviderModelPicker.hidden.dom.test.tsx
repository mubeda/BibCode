// @vitest-environment happy-dom

import { ProviderInstanceId, type ServerProvider } from "@bibcode/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

const settings = vi.hoisted(() => ({ favorites: [] as unknown[], update: () => undefined }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (value: { favorites: unknown }) => T): T =>
    selector({ favorites: settings.favorites }),
  useUpdateClientSettings: () => settings.update,
}));

import { ProviderModelPicker } from "./ProviderModelPicker";

/**
 * The real model list inside the real kept-mounted Popover (#360). happy-dom lays nothing out, so
 * the test says what each element measures: 0 by 0 under a hidden ancestor, as a browser reports
 * it; otherwise a 48 px row, or the 300 px list viewport.
 */
const ROW = "[data-model-picker-model-slug]";
const ROW_HEIGHT = 48;
const VIEWPORT_HEIGHT = 300;

const codex: ProviderInstanceEntry = {
  instanceId: ProviderInstanceId.make("codex"),
  driverKind: "codex" as ProviderInstanceEntry["driverKind"],
  displayName: "Codex",
  accentColor: undefined,
  continuationGroupKey: undefined,
  enabled: true,
  installed: true,
  status: "ready",
  isDefault: true,
  isAvailable: true,
  snapshot: {} as ServerProvider,
  models: [],
};

function models(first: number, count: number): ModelEsque[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `model-${first + index}`,
    name: `Model ${first + index}`,
    shortName: `${first + index}`,
  }));
}

/** Reports, like a browser after layout, each observed element whose box changed. */
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

function Composer({ options }: { options: ReadonlyArray<ModelEsque> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-external-open onClick={() => setOpen(true)} />
      <button type="button" data-external-close onClick={() => setOpen(false)} />
      <ProviderModelPicker
        activeInstanceId={codex.instanceId}
        model="model-1"
        lockedProvider={null}
        instanceEntries={[codex]}
        modelOptionsByInstance={new Map([[codex.instanceId, options]])}
        open={open}
        onOpenChange={setOpen}
        onInstanceModelChange={() => undefined}
      />
    </>
  );
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalStackTraceLimit = Error.stackTraceLimit;
let originalGetAnimations: PropertyDescriptor | undefined;
let container: HTMLDivElement;
let root: Root;
let uncaught: unknown[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Deep enough to show whether an error came from the list's layout measurement.
  Error.stackTraceLimit = 50;
  originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.closest("[hidden]") !== null) return DOMRect.fromRect({ width: 0, height: 0 });
    const isRow = this.matches(ROW) || this.querySelectorAll(ROW).length === 1;
    return DOMRect.fromRect({ width: 320, height: isRow ? ROW_HEIGHT : VIEWPORT_HEIGHT });
  };
  observed.clear();
  uncaught = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container, { onUncaughtError: (error) => uncaught.push(error) });
});

afterEach(async () => {
  await act(async () => root.unmount());
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

async function press(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  await act(async () => element.click());
  await settle();
}

describe("ProviderModelPicker with the real list and popover (#360)", () => {
  it("a closed model picker survives a model list whose keys changed", async () => {
    const thrown: unknown[] = [];
    await act(async () => root.render(<Composer options={models(0, 50)} />));
    await settle();
    await press("[data-external-open]");
    const rowsWhileOpen = document.querySelectorAll(ROW).length;
    expect(rowsWhileOpen).toBeGreaterThan(0);
    await press("[data-external-close]");
    expect(document.querySelector(ROW)?.closest("[hidden]")).not.toBeNull();

    // A provider refresh replaces the models while the picker is closed.
    try {
      await act(async () => root.render(<Composer options={models(1, 99)} />));
      await settle();
    } catch (error) {
      thrown.push(error);
    }

    expect(
      [...thrown, ...uncaught].map((error) =>
        error instanceof Error
          ? `${error.message.split(".")[0]} | from measureContainersInLayoutEffect: ${String(
              error.stack?.includes("measureContainersInLayoutEffect"),
            )}`
          : String(error),
      ),
    ).toEqual([]);
    // Rows that measure 0 by 0 must not widen the hidden list's rendered range.
    expect(document.querySelectorAll(ROW).length).toBeLessThanOrEqual(rowsWhileOpen);
  });
});
