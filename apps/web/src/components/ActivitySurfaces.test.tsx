// @vitest-environment happy-dom

import type {
  ActivityActorControl,
  ActivityActorSummary,
  ActivitySnapshot,
} from "@bibcode/contracts";
import { ActivityScopeId, ThreadId } from "@bibcode/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ActivityPanel,
  type ActivityPanelProps,
  type ActivityRosterPageData,
} from "./activity/ActivityPanel";
import { RightPanelSheet } from "./RightPanelSheet";
import { TooltipProvider } from "./ui/tooltip";

const mounted: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = [];
const scopeId = ActivityScopeId.make("scope:surface");
const threadId = ThreadId.make("thread-1");

function actor(): ActivityActorSummary {
  return {
    _tag: "actor",
    id: "actor:surface",
    parentActorId: null,
    name: "Surface agent",
    role: "reviewer",
    providerType: "codex",
    status: "running",
    summary: "Still working",
    startedAt: "2026-08-11T20:00:00.000Z",
    updatedAt: "2026-08-11T20:01:00.000Z",
    terminalAt: null,
  } as ActivityActorSummary;
}

function control(): ActivityActorControl {
  return {
    actorId: actor().id,
    state: "available",
    controlRevision: 7,
    activeDescendantCount: 1,
  } as ActivityActorControl;
}

function snapshot(scope: ActivitySnapshot["scope"]): ActivitySnapshot {
  const current = actor();
  return {
    protocolVersion: 2,
    scopeId,
    scope,
    revision: 3,
    provider: "codex",
    providerInstanceId: null,
    capabilities: {
      actors: true,
      attributedActivity: true,
      backgroundWork: false,
      historyRecovery: "full",
      terminalObservation: scope._tag === "terminal",
      targetedActorCancellation: true,
    },
    observationState: "live",
    sections: {
      subagents: { state: "live", message: null, retryable: false },
      backgroundTasks: { state: "unsupported", message: null, retryable: false },
    },
    counts: {
      subagents: { active: 1, done: 0 },
      backgroundTasks: { active: 0, done: 0 },
    },
    actors: [current],
    workItems: [],
    actorsHasMore: false,
    workItemsHasMore: false,
    control: {
      scopeId,
      revision: 9,
      actors: [control()],
      operations: [],
    },
    updatedAt: "2026-08-11T20:01:00.000Z",
  } as unknown as ActivitySnapshot;
}

function panelProps(
  scope: ActivitySnapshot["scope"],
  onCancelActor: NonNullable<ActivityPanelProps["onCancelActor"]>,
  onNavigate: ActivityPanelProps["onNavigate"],
): ActivityPanelProps {
  const current = actor();
  const page = {
    records: [current],
    actorControls: [control()],
    nextCursor: null,
  } as ActivityRosterPageData;
  return {
    route: {
      section: "subagents",
      selectedRecordKind: null,
      selectedRecordId: null,
    },
    snapshot: snapshot(scope),
    roster: {
      active: { pages: [page], loading: false, error: null },
      done: { pages: [], loading: false, error: null },
    },
    detail: null,
    now: "2026-08-11T20:02:00.000Z",
    onNavigate,
    onLoadMoreRoster: vi.fn(),
    onLoadMoreDetail: vi.fn(),
    onRefreshSnapshot: vi.fn(),
    onCancelActor,
  };
}

async function mount(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<TooltipProvider delay={0}>{element}</TooltipProvider>);
  });
  return container;
}

async function activate(target: HTMLButtonElement, key: "Enter" | " "): Promise<void> {
  const keydown = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(keydown);
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    if (!keydown.defaultPrevented) {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    }
  });
}

async function pressTab(from: HTMLElement, to: HTMLElement): Promise<KeyboardEvent> {
  const keydown = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    from.dispatchEvent(keydown);
    if (!keydown.defaultPrevented) {
      to.focus();
    }
    from.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
  });
  return keydown;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

afterEach(async () => {
  for (const tree of mounted.splice(0)) {
    await act(async () => tree.root.unmount());
    tree.container.remove();
  }
  document.querySelectorAll('[data-slot="tooltip-positioner"]').forEach((node) => node.remove());
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
});

describe("Activity cancellation surfaces", () => {
  it.each([
    ["right panel", false, "Enter"],
    ["responsive sheet", true, " "],
  ] as const)(
    "keeps the trailing Stop action keyboard-reachable in the %s",
    async (_name, sheet, key) => {
      const onCancelActor = vi.fn();
      const onNavigate = vi.fn();
      const roster = (
        <ActivityPanel {...panelProps({ _tag: "thread", threadId }, onCancelActor, onNavigate)} />
      );
      const container = await mount(
        sheet ? (
          <RightPanelSheet open onClose={vi.fn()}>
            {roster}
          </RightPanelSheet>
        ) : (
          <section aria-label="Activity right panel">{roster}</section>
        ),
      );
      const searchRoot = sheet ? document.body : container;
      const detail = searchRoot.querySelector<HTMLButtonElement>(
        'button[data-activity-row="actor:surface"]',
      );
      const stop = searchRoot.querySelector<HTMLButtonElement>(
        'button[aria-label="Stop Surface agent and 1 child agent"]',
      );

      expect(detail).not.toBeNull();
      expect(stop?.tabIndex).toBe(0);
      expect(detail?.contains(stop!)).toBe(false);
      expect(stop?.querySelector("button")).toBeNull();
      detail?.focus();
      const tab = await pressTab(detail!, stop!);
      expect(tab.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(stop);
      await activate(stop!, key);
      expect(onCancelActor).toHaveBeenCalledTimes(1);
      expect(onCancelActor).toHaveBeenCalledWith("actor:surface", 7);
      expect(onNavigate).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(stop);
    },
  );

  it("keeps provider-terminal Activity observable and read-only", async () => {
    const onCancelActor = vi.fn();
    const onNavigate = vi.fn();
    const container = await mount(
      <ActivityPanel
        {...panelProps(
          { _tag: "terminal", threadId, terminalId: "terminal-1" },
          onCancelActor,
          onNavigate,
        )}
      />,
    );

    expect(container.querySelector('button[data-activity-row="actor:surface"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label^="Stop "]')).toBeNull();
    expect(onCancelActor).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
