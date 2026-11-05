// @vitest-environment happy-dom

import { ThreadId } from "@bibcode/contracts";
import { act, Profiler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadCenterPanelState } from "~/centerPanelStore";

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  PointerSensor: function PointerSensor() {},
  closestCenter: vi.fn(() => []),
  pointerWithin: vi.fn(() => []),
  useSensor: (sensor: unknown, options: unknown) => ({ sensor, options }),
  useSensors: (...sensors: unknown[]) => sensors,
  useDroppable: () => ({ isOver: false, setNodeRef: () => undefined }),
}));

vi.mock("./CenterPanelTabs", () => ({
  CenterSurfaceIcon: () => null,
  CenterPanelTabs: () => null,
}));

import { CenterPanelWorkspace, type CenterPanelWorkspaceProps } from "./CenterPanelWorkspace";

const host = { id: "chat:host", kind: "chat-host" } as const;
const chat = {
  id: "chat:thread-1",
  kind: "chat",
  threadId: ThreadId.make("thread-1"),
  providerLabel: "Codex",
} as const;

const chatInLeft: ThreadCenterPanelState = {
  surfaces: [host, chat],
  groups: [
    { id: "group-left", surfaceIds: [host.id, chat.id], activeSurfaceId: chat.id },
    { id: "group-right", surfaceIds: [], activeSurfaceId: null },
  ],
  layout: {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "leaf", groupId: "group-left" },
    second: { type: "leaf", groupId: "group-right" },
  },
  focusedGroupId: "group-left",
};

const chatInRight: ThreadCenterPanelState = {
  ...chatInLeft,
  groups: [
    { id: "group-left", surfaceIds: [host.id], activeSurfaceId: host.id },
    { id: "group-right", surfaceIds: [chat.id], activeSurfaceId: chat.id },
  ],
  focusedGroupId: "group-right",
};

let container: HTMLDivElement;
let root: Root;
let frameCallbacks: FrameRequestCallback[];
let observers: FakeResizeObserver[];
let leftWidth: number;

class FakeResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(): void {}
  disconnect(): void {}
}

function workspaceProps(state: ThreadCenterPanelState): CenterPanelWorkspaceProps {
  return {
    state,
    hostLabel: "Codex",
    renderFocusedActions: () => null,
    renderSurface: (surface) => (
      <div className="min-h-0 flex-1" data-live-surface-content={surface.id} />
    ),
    onFocusGroup: vi.fn(),
    onActivate: vi.fn(),
    onCloseSurface: vi.fn(),
    onCloseOtherSurfaces: vi.fn(),
    onCloseSurfacesToRight: vi.fn(),
    onCloseAllSurfaces: vi.fn(),
    onDropSurface: vi.fn(),
    onMergeGroup: vi.fn(),
    onSetSplitRatio: vi.fn(),
  };
}

async function flushFrames(): Promise<void> {
  while (frameCallbacks.length > 0) {
    const callbacks = frameCallbacks;
    frameCallbacks = [];
    await act(async () => callbacks.forEach((callback) => callback(0)));
  }
}

async function renderWorkspace(state: ThreadCenterPanelState): Promise<void> {
  await act(async () => root.render(<CenterPanelWorkspace {...workspaceProps(state)} />));
  await flushFrames();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frameCallbacks = [];
  observers = [];
  leftWidth = 320;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const groupId = this.getAttribute("data-center-panel-body-target");
    if (groupId === "group-left") {
      return new DOMRect(0, 32, leftWidth, 368);
    }
    if (groupId === "group-right") {
      return new DOMRect(320, 32, 320, 368);
    }
    return new DOMRect(0, 0, 640, 400);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CenterPanelWorkspace surface hosts", () => {
  it("resizes through the real split without reading dirty layout or rerendering pane headers", async () => {
    const props = workspaceProps(chatInLeft);
    const headers = vi.fn(() => null);
    const commits = vi.fn();
    await act(async () =>
      root.render(
        <Profiler id="workspace" onRender={commits}>
          <CenterPanelWorkspace {...props} renderFocusedActions={headers} />
        </Profiler>,
      ),
    );
    await flushFrames();
    headers.mockClear();
    commits.mockClear();
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    Object.assign(separator, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const pointer = (type: string, x: number) =>
      separator.dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x }),
      );
    const measure = vi.mocked(Element.prototype.getBoundingClientRect);
    measure.mockClear();
    pointer("pointerdown", 320);
    pointer("pointermove", 400);
    pointer("pointermove", 380);
    await flushFrames();
    expect(measure).not.toHaveBeenCalled();
    leftWidth = 380;
    const observer = observers.find((entry) =>
      [...entry.targets].some((element) => element.hasAttribute("data-center-panel-body-target")),
    )!;
    await act(async () => observer.callback([], observer as unknown as ResizeObserver));
    await flushFrames();
    expect(headers).not.toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();
    const surface = container.querySelector<HTMLElement>(
      '[data-center-surface-host="chat:thread-1"]',
    )!;
    expect(surface.style.width).toBe("380px");
    pointer("pointerup", 380);
    await flushFrames();
    expect(props.onSetSplitRatio).toHaveBeenCalledWith([], 0.59375);
    expect(surface.style.width).toBe("380px");
    expect(commits).toHaveBeenCalledOnce();
  });

  it("gives live surface roots a bounded flex column while preserving their mounted content", async () => {
    await renderWorkspace(chatInLeft);
    const beforeHost = container.querySelector<HTMLElement>(
      '[data-center-surface-host="chat:thread-1"]',
    );
    const beforeContent = beforeHost?.querySelector('[data-live-surface-content="chat:thread-1"]');

    expect(beforeHost?.classList.contains("absolute")).toBe(true);
    expect(beforeHost?.classList.contains("overflow-hidden")).toBe(true);
    expect(beforeHost?.classList.contains("flex")).toBe(true);
    expect(beforeHost?.classList.contains("flex-col")).toBe(true);
    expect(beforeHost?.classList.contains("min-h-0")).toBe(true);
    expect(beforeHost?.classList.contains("min-w-0")).toBe(true);
    expect(beforeContent?.classList.contains("flex-1")).toBe(true);

    await renderWorkspace(chatInRight);
    const afterHost = container.querySelector<HTMLElement>(
      '[data-center-surface-host="chat:thread-1"]',
    );

    expect(afterHost).toBe(beforeHost);
    expect(afterHost?.querySelector('[data-live-surface-content="chat:thread-1"]')).toBe(
      beforeContent,
    );
    expect(afterHost?.dataset.centerSurfaceGroupId).toBe("group-right");
    expect(afterHost?.style.left).toBe("320px");
  });
});
