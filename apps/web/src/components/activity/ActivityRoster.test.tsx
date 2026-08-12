// @vitest-environment happy-dom

import type {
  ActivityActorControl,
  ActivityActorSummary,
  ActivitySnapshot,
} from "@bibcode/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TooltipProvider } from "~/components/ui/tooltip";
import { ActivityRoster, type ActivityRosterProps } from "./ActivityRoster";
import type { ActivityRosterPageData } from "./ActivityPanel";

const mounted: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = [];

function actor(
  id: string,
  name: string,
  overrides: Partial<ActivityActorSummary> = {},
): ActivityActorSummary {
  return {
    _tag: "actor",
    id,
    name,
    status: "running",
    summary: null,
    startedAt: "2026-08-11T20:00:00.000Z",
    updatedAt: "2026-08-11T20:01:00.000Z",
    terminalAt: null,
    parentActorId: null,
    role: "reviewer",
    providerType: "codex",
    ...overrides,
  } as ActivityActorSummary;
}

function control(
  actorId: string,
  state: ActivityActorControl["state"],
  activeDescendantCount = 0,
  controlRevision = 3,
): ActivityActorControl {
  return { actorId, state, activeDescendantCount, controlRevision } as ActivityActorControl;
}

function snapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    protocolVersion: 2,
    scopeId: "scope-1",
    scope: { _tag: "thread", threadId: "thread-1" },
    revision: 1,
    provider: "codex",
    providerInstanceId: null,
    capabilities: {
      actors: true,
      attributedActivity: true,
      backgroundWork: false,
      historyRecovery: "full",
      terminalObservation: false,
      targetedActorCancellation: true,
    },
    observationState: "live",
    sections: {
      subagents: { state: "live", message: null, retryable: false },
      backgroundTasks: { state: "unsupported", message: null, retryable: false },
    },
    counts: {
      subagents: { active: 3, done: 1 },
      backgroundTasks: { active: 0, done: 0 },
    },
    actors: [],
    workItems: [],
    actorsHasMore: false,
    workItemsHasMore: false,
    control: { scopeId: "scope-1", revision: 4, actors: [], operations: [] },
    updatedAt: "2026-08-11T20:02:00.000Z",
    ...overrides,
  } as ActivitySnapshot;
}

function page(
  records: ActivityRosterPageData["records"],
  actorControls: readonly ActivityActorControl[] = [],
): ActivityRosterPageData {
  return { records, actorControls, nextCursor: null } as ActivityRosterPageData;
}

function props(overrides: Partial<ActivityRosterProps> = {}): ActivityRosterProps {
  const available = actor("available", "Lovelace");
  const requested = actor("requested", "Turing");
  const unsupported = actor("unsupported", "Hopper");
  const done = actor("done", "Hamilton", {
    status: "completed",
    terminalAt: "2026-08-11T20:02:00.000Z",
  });
  const activePage = page(
    [available, requested, unsupported],
    [
      control(available.id, "available", 2),
      control(requested.id, "requested"),
      control(unsupported.id, "unsupported"),
    ],
  );
  const donePage = page([done], [control(done.id, "available")]);
  return {
    section: "subagents",
    snapshot: snapshot(),
    active: { pages: [activePage], loading: false, error: null },
    done: { pages: [donePage], loading: false, error: null },
    reconciled: { active: [available, requested, unsupported], done: [done] },
    now: "2026-08-11T20:02:00.000Z",
    notification: null,
    focusRecordId: null,
    onFocusRestored: vi.fn(),
    onSelect: vi.fn(),
    onLoadMore: vi.fn(),
    onCancelActor: vi.fn(),
    ...overrides,
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

describe("ActivityRoster targeted cancellation controls", () => {
  it("renders sibling Stop controls only for active server-controlled actors", async () => {
    const onCancelActor = vi.fn();
    const onSelect = vi.fn();
    const container = await mount(<ActivityRoster {...props({ onCancelActor, onSelect })} />);

    const availableStop = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop Lovelace and 2 child agents"]',
    );
    const requestedStop = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop Turing"]',
    );
    expect(availableStop).not.toBeNull();
    expect(requestedStop?.disabled).toBe(true);
    expect(container.textContent).toContain("Stopping");
    expect(container.querySelector('button[aria-label^="Stop Hopper"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Stop Hamilton"]')).toBeNull();

    const detailButton = container.querySelector<HTMLButtonElement>(
      'button[data-activity-row="available"]',
    );
    expect(detailButton).not.toBeNull();
    expect(detailButton?.parentElement).toBe(availableStop?.parentElement);
    expect(detailButton?.contains(availableStop)).toBe(false);
    expect(availableStop?.className).toContain("focus-visible:ring-2");
    expect(availableStop?.className).toContain("shrink-0");
    expect(detailButton?.className).toContain("min-w-0");
    expect(detailButton?.className).toContain("flex-1");
    expect(detailButton?.parentElement?.className).toContain("min-w-0");

    availableStop?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await act(async () => availableStop?.click());
    expect(onCancelActor).toHaveBeenCalledWith("available", 3);
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => detailButton?.click());
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "available" }));
  });

  it("is keyboard reachable and exposes the same exact subtree impact in its tooltip", async () => {
    const container = await mount(<ActivityRoster {...props()} />);
    const stop = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop Lovelace and 2 child agents"]',
    );
    expect(stop?.tabIndex).toBe(0);

    await act(async () => {
      stop?.focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(stop);
    expect(
      [...document.body.querySelectorAll('[data-slot="tooltip-popup"]')].some(
        (popup) => popup.textContent === "Stop Lovelace and 2 child agents",
      ),
    ).toBe(true);
  });

  it("uses snapshot controls as initial fallback and lets roster-page controls override them", async () => {
    const fallbackActor = actor("fallback", "Ada");
    const overriddenActor = actor("overridden", "Grace");
    const activePage = page(
      [fallbackActor, overriddenActor],
      [control(overriddenActor.id, "requested", 0, 8)],
    );
    const customSnapshot = snapshot({
      counts: {
        subagents: { active: 2, done: 0 },
        backgroundTasks: { active: 0, done: 0 },
      },
      control: {
        scopeId: "scope-1" as ActivitySnapshot["scopeId"],
        revision: 9,
        actors: [
          control(fallbackActor.id, "available", 0, 7),
          control(overriddenActor.id, "available", 0, 7),
        ],
        operations: [],
      },
    });
    const container = await mount(
      <ActivityRoster
        {...props({
          snapshot: customSnapshot,
          active: { pages: [activePage], loading: false, error: null },
          done: { pages: [page([])], loading: false, error: null },
          reconciled: { active: [fallbackActor, overriddenActor], done: [] },
        })}
      />,
    );

    expect(container.querySelector('button[aria-label="Stop Ada"]')).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Stop Grace"]')?.disabled,
    ).toBe(true);
  });

  it("restores focus to the main detail action instead of the trailing Stop control", async () => {
    const onFocusRestored = vi.fn();
    const container = await mount(
      <ActivityRoster {...props({ focusRecordId: "available", onFocusRestored })} />,
    );

    expect(document.activeElement).toBe(
      container.querySelector('button[data-activity-row="available"]'),
    );
    expect(document.activeElement).not.toBe(
      container.querySelector('button[aria-label^="Stop Lovelace"]'),
    );
    expect(onFocusRestored).toHaveBeenCalledTimes(1);
  });

  it("omits mutation controls for terminal and background-task surfaces", async () => {
    const terminal = await mount(
      <ActivityRoster
        {...props({
          snapshot: snapshot({
            scope: {
              _tag: "terminal",
              threadId: "thread-1",
              terminalId: "terminal-1",
            } as ActivitySnapshot["scope"],
          }),
        })}
      />,
    );
    expect(terminal.querySelector('button[aria-label^="Stop "]')).toBeNull();

    const background = await mount(<ActivityRoster {...props({ section: "backgroundTasks" })} />);
    expect(background.querySelector('button[aria-label^="Stop "]')).toBeNull();
  });
});
