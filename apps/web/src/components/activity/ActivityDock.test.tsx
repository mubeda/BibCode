// @vitest-environment happy-dom

import type {
  ActivityActorSummary,
  ActivitySection,
  ActivitySnapshot,
  ActivityWorkItemSummary,
} from "@bibcode/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TooltipProvider } from "~/components/ui/tooltip";
import { ActivityDock, type ActivityDockProps } from "./ActivityDock";

const mounted: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = [];

function actor(id: string, updatedAt = "2026-07-22T20:09:00.000Z"): ActivityActorSummary {
  return {
    _tag: "actor",
    id,
    name: id,
    status: "running",
    summary: null,
    startedAt: "2026-07-22T20:00:00.000Z",
    updatedAt,
    terminalAt: null,
    parentActorId: null,
    role: null,
    providerType: null,
  } as unknown as ActivityActorSummary;
}

function workItem(id: string, updatedAt = "2026-07-22T20:09:00.000Z"): ActivityWorkItemSummary {
  return {
    _tag: "workItem",
    id,
    name: id,
    status: "running",
    summary: null,
    startedAt: "2026-07-22T20:05:00.000Z",
    updatedAt,
    terminalAt: null,
    ownerActorId: null,
    workKind: "process",
    command: null,
    cwd: null,
  } as unknown as ActivityWorkItemSummary;
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
      backgroundWork: true,
      historyRecovery: "full",
      terminalObservation: false,
      targetedActorCancellation: false,
    },
    observationState: "live",
    sections: {
      subagents: { state: "live", message: null, retryable: false },
      backgroundTasks: { state: "live", message: null, retryable: false },
    },
    counts: {
      subagents: { active: 2, done: 1 },
      backgroundTasks: { active: 1, done: 1 },
    },
    actors: [],
    workItems: [],
    actorsHasMore: false,
    workItemsHasMore: false,
    control: { scopeId: "scope-1", revision: 0, actors: [], operations: [] },
    updatedAt: "2026-07-22T20:09:00.000Z",
    ...overrides,
  } as unknown as ActivitySnapshot;
}

function counts(
  subagents: { readonly active: number; readonly done: number },
  backgroundTasks: { readonly active: number; readonly done: number },
): ActivitySnapshot["counts"] {
  return { subagents, backgroundTasks };
}

function sections(
  subagents: ActivitySnapshot["sections"]["subagents"]["state"],
  backgroundTasks: ActivitySnapshot["sections"]["backgroundTasks"]["state"],
): ActivitySnapshot["sections"] {
  return {
    subagents: { state: subagents, message: null, retryable: false },
    backgroundTasks: { state: backgroundTasks, message: null, retryable: false },
  };
}

function props(overrides: Partial<ActivityDockProps> = {}): ActivityDockProps {
  return {
    snapshot: snapshot(),
    compact: false,
    onToggle: vi.fn(),
    ...overrides,
  };
}

function withoutSnapshotField(field: keyof ActivitySnapshot): unknown {
  const result = { ...snapshot() } as Record<string, unknown>;
  Reflect.deleteProperty(result, field);
  return result;
}

async function mount(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(<TooltipProvider delay={0}>{element}</TooltipProvider>));
  return container;
}

async function rerender(container: HTMLDivElement, element: ReactElement): Promise<void> {
  const entry = mounted.find((candidate) => candidate.container === container);
  if (entry === undefined) {
    throw new Error("Cannot rerender an unmounted ActivityDock test tree.");
  }
  await act(async () => entry.root.render(<TooltipProvider delay={0}>{element}</TooltipProvider>));
}

function pill(container: HTMLElement): HTMLButtonElement {
  const buttons = container.querySelectorAll<HTMLButtonElement>("button");
  expect(buttons).toHaveLength(1);
  return buttons[0]!;
}

async function activateNativeButton(
  target: HTMLButtonElement,
  key: "Enter" | " ",
): Promise<KeyboardEvent> {
  const keydown = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    target.dispatchEvent(keydown);
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    if (!keydown.defaultPrevented) {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    }
  });
  return keydown;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  document.querySelectorAll('[data-slot="tooltip-positioner"]').forEach((node) => node.remove());
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ActivityDock", () => {
  it("renders no DOM when neither activity section is visible", async () => {
    const invisible = snapshot({
      capabilities: {
        actors: false,
        attributedActivity: false,
        backgroundWork: false,
        historyRecovery: "none",
        terminalObservation: false,
        targetedActorCancellation: false,
      },
      sections: sections("unsupported", "unsupported"),
      counts: counts({ active: 0, done: 0 }, { active: 0, done: 0 }),
    });

    const container = await mount(<ActivityDock {...props({ snapshot: invisible })} />);
    expect(container.childElementCount).toBe(0);

    const alwaysVisible = await mount(
      <ActivityDock {...props({ snapshot: invisible, alwaysVisible: true })} />,
    );
    expect(alwaysVisible.childElementCount).toBe(0);
  });

  it.each([
    ["no loaded actors", [], false],
    ["one loaded actor", [actor("actor-a")], false],
    ["three loaded actors", [actor("actor-a"), actor("actor-b"), actor("actor-c")], false],
    ["truncated actors", [actor("actor-a"), actor("actor-b"), actor("actor-c")], true],
    ["count-only actors", [], true],
  ])(
    "renders one scope provider glyph regardless of %s",
    async (_caseName, actors, actorsHasMore) => {
      const container = await mount(
        <ActivityDock
          {...props({
            snapshot: snapshot({
              counts: counts({ active: 1, done: 2 }, { active: 0, done: 0 }),
              actors,
              actorsHasMore,
            }),
          })}
        />,
      );

      expect(container.querySelectorAll("[data-activity-provider-glyph]")).toHaveLength(1);
      expect(container.querySelectorAll("[data-activity-glyph]")).toHaveLength(0);
      expect(container.textContent).not.toContain("+2");
      expect(container.textContent).toContain("Active 1");
      expect(container.textContent).toContain("Done 2");
    },
  );

  it.each<[string, Partial<ActivitySnapshot>, ActivitySection]>([
    [
      "the failing section over running work",
      {
        sections: sections("live", "error"),
        counts: counts({ active: 2, done: 0 }, { active: 0, done: 1 }),
      },
      "backgroundTasks",
    ],
    ["Subagents when both sections fail", { sections: sections("error", "error") }, "subagents"],
    [
      "Subagents when both sections run work",
      { counts: counts({ active: 1, done: 0 }, { active: 3, done: 0 }) },
      "subagents",
    ],
    [
      "the only section with running work",
      { counts: counts({ active: 0, done: 4 }, { active: 1, done: 0 }) },
      "backgroundTasks",
    ],
    [
      "the section with the most recent record when nothing runs",
      {
        counts: counts({ active: 0, done: 1 }, { active: 0, done: 1 }),
        actors: [actor("actor-a", "2026-07-22T20:01:00.000Z")],
        workItems: [workItem("work-a", "2026-07-22T20:02:00.000Z")],
      },
      "backgroundTasks",
    ],
    [
      "Subagents when its latest record is newer",
      {
        counts: counts({ active: 0, done: 2 }, { active: 0, done: 1 }),
        actors: [
          actor("actor-a", "2026-07-22T20:01:00.000Z"),
          actor("actor-b", "2026-07-22T20:03:00.000Z"),
        ],
        workItems: [workItem("work-a", "2026-07-22T20:02:00.000Z")],
      },
      "subagents",
    ],
    [
      "the only visible section",
      {
        sections: sections("unsupported", "live"),
        counts: counts({ active: 0, done: 0 }, { active: 0, done: 2 }),
      },
      "backgroundTasks",
    ],
  ])("opens %s in one click", async (_caseName, overrides, expected) => {
    const onToggle = vi.fn();
    const container = await mount(
      <ActivityDock {...props({ onToggle, snapshot: snapshot(overrides) })} />,
    );

    await act(async () => pill(container).click());

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(expected);
  });

  it("reports every click to its pane, which decides whether to open or close", async () => {
    const onToggle = vi.fn();
    const container = await mount(<ActivityDock {...props({ onToggle })} />);
    const button = pill(container);

    await act(async () => button.click());
    await act(async () => button.click());

    expect(onToggle.mock.calls).toEqual([["subagents"], ["subagents"]]);
    expect(pill(container)).toBe(button);
    expect(container.querySelector("[data-activity-section]")).toBeNull();
  });

  it("is a disclosure whose name stays the same whether its panel is open or closed", async () => {
    const collapsedProps = props({
      alwaysVisible: true,
      snapshot: snapshot({ counts: counts({ active: 1, done: 6 }, { active: 0, done: 0 }) }),
    });
    const container = await mount(<ActivityDock {...collapsedProps} />);
    const button = pill(container);
    const name = "Activity: Subagents 1 active, 6 done; Background tasks 0 active, 0 done";

    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe(name);
    expect(
      container
        .querySelector("[data-activity-dock-chevron]")
        ?.getAttribute("data-activity-dock-chevron"),
    ).toBe("collapsed");

    await rerender(
      container,
      <ActivityDock {...collapsedProps} expanded controlsId="activity-pane-body" />,
    );
    expect(pill(container).getAttribute("aria-expanded")).toBe("true");
    expect(pill(container).getAttribute("aria-controls")).toBe("activity-pane-body");
    expect(pill(container).getAttribute("aria-label")).toBe(name);
    expect(
      container
        .querySelector("[data-activity-dock-chevron]")
        ?.getAttribute("data-activity-dock-chevron"),
    ).toBe("expanded");
  });

  it("shows the same breakdown in a tooltip", async () => {
    const container = await mount(<ActivityDock {...props()} />);
    const button = pill(container);

    await act(async () => {
      button.focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      [...document.body.querySelectorAll('[data-slot="tooltip-popup"]')].some(
        (popup) =>
          popup.textContent === "Subagents 2 active, 1 done; Background tasks 1 active, 1 done",
      ),
    ).toBe(true);
  });

  it.each([
    ["an errored section", sections("live", "error"), "live", "error"],
    ["a stale section", sections("stale", "live"), "live", "stale"],
    ["errors over stale", sections("stale", "error"), "live", "error"],
    ["a reconnecting observation", sections("live", "live"), "reconnecting", "stale"],
    ["a failed observation", sections("live", "live"), "error", "error"],
  ] as const)(
    "marks the pill for %s",
    async (_caseName, sectionHealth, observationState, expected) => {
      const container = await mount(
        <ActivityDock
          {...props({ snapshot: snapshot({ sections: sectionHealth, observationState }) })}
        />,
      );
      const button = pill(container);

      expect(button.querySelectorAll("[data-activity-status]")).toHaveLength(1);
      expect(button.querySelector(`[data-activity-status="${expected}"]`)).not.toBeNull();
      expect(button.getAttribute("aria-label")).toBe(
        `Activity: Subagents 2 active, 1 done; Background tasks 1 active, 1 done. Status: ${expected}`,
      );
      expect(button.textContent).toContain("Active 3");
      expect(button.textContent).toContain("Done 2");
    },
  );

  it.each([
    ["off", false],
    ["on", true],
  ] as const)(
    "marks and opens a failing section that has no records yet, with always visible %s",
    async (_setting, alwaysVisible) => {
      const onToggle = vi.fn();
      // Codex rejected its background-terminal list before any record arrived.
      const failedBeforeRecords = snapshot({
        capabilities: {
          actors: true,
          attributedActivity: true,
          backgroundWork: false,
          historyRecovery: "full",
          terminalObservation: false,
          targetedActorCancellation: false,
        },
        sections: sections("live", "error"),
        counts: counts({ active: 1, done: 1 }, { active: 0, done: 0 }),
      });
      const container = await mount(
        <ActivityDock {...props({ alwaysVisible, onToggle, snapshot: failedBeforeRecords })} />,
      );
      const button = pill(container);

      expect(button.querySelector('[data-activity-status="error"]')).not.toBeNull();
      expect(button.getAttribute("aria-label")).toBe(
        "Activity: Subagents 1 active, 1 done. Status: error",
      );
      await act(async () => button.click());
      expect(onToggle).toHaveBeenCalledWith("backgroundTasks");
    },
  );

  it("shows no marker while every section is live", async () => {
    const container = await mount(<ActivityDock {...props()} />);
    expect(container.querySelector("[data-activity-status]")).toBeNull();
  });

  it("shows an idle Activity button before any record when always visible", async () => {
    const onToggle = vi.fn();
    const empty = snapshot({ counts: counts({ active: 0, done: 0 }, { active: 0, done: 0 }) });

    const hidden = await mount(<ActivityDock {...props({ snapshot: empty })} />);
    expect(hidden.childElementCount).toBe(0);

    const container = await mount(
      <ActivityDock {...props({ snapshot: empty, alwaysVisible: true, onToggle })} />,
    );
    const button = pill(container);
    const label = button.querySelector<HTMLElement>("[data-activity-idle]");

    expect(label?.textContent).toBe("Activity");
    expect(label?.className).toContain("text-muted-foreground");
    expect(button.querySelector("[data-activity-count]")).toBeNull();
    expect(button.textContent).not.toContain("Active 0");
    expect(button.querySelectorAll("[data-activity-provider-glyph]")).toHaveLength(1);
    expect(button.getAttribute("aria-label")).toBe(
      "Activity: Subagents 0 active, 0 done; Background tasks 0 active, 0 done",
    );

    await act(async () => button.click());
    expect(onToggle).toHaveBeenCalledWith("subagents");
  });

  it("leaves an unclaimed empty section out of the idle button", async () => {
    const container = await mount(
      <ActivityDock
        {...props({
          alwaysVisible: true,
          snapshot: snapshot({
            capabilities: {
              actors: true,
              attributedActivity: true,
              backgroundWork: false,
              historyRecovery: "bounded",
              terminalObservation: false,
              targetedActorCancellation: false,
            },
            sections: sections("live", "unsupported"),
            counts: counts({ active: 0, done: 0 }, { active: 0, done: 0 }),
          }),
        })}
      />,
    );

    expect(pill(container).getAttribute("aria-label")).toBe("Activity: Subagents 0 active, 0 done");
  });

  it.each([
    ["null snapshot", null],
    ["undefined snapshot", undefined],
    ["missing capabilities", withoutSnapshotField("capabilities")],
    ["null capabilities", { ...snapshot(), capabilities: null }],
    ["missing sections", withoutSnapshotField("sections")],
    ["null sections", { ...snapshot(), sections: null }],
    ["missing counts", withoutSnapshotField("counts")],
    ["null counts", { ...snapshot(), counts: null }],
    ["missing actors", withoutSnapshotField("actors")],
    ["null actors", { ...snapshot(), actors: null }],
    ["missing work items", withoutSnapshotField("workItems")],
    ["null work items", { ...snapshot(), workItems: null }],
  ])("renders no DOM for a structurally unusable %s", async (_label, malformed) => {
    const container = await mount(
      <ActivityDock
        {...props({
          snapshot: malformed as ActivitySnapshot,
        })}
      />,
    );

    expect(container.childElementCount).toBe(0);
  });

  it("sanitizes malformed leaves and filters malformed records without throwing", async () => {
    const onToggle = vi.fn();
    const malformed = {
      ...snapshot(),
      provider: { unexpected: true },
      observationState: "unexpected",
      updatedAt: 42,
      capabilities: {
        actors: true,
        attributedActivity: "yes",
        backgroundWork: true,
        historyRecovery: "unexpected",
        terminalObservation: null,
      },
      sections: {
        subagents: { state: "unexpected", message: 42, retryable: "yes" },
        backgroundTasks: { state: "live", message: null, retryable: false },
      },
      counts: {
        subagents: { active: Number.NaN, done: "2" },
        backgroundTasks: { active: -4, done: 3.8 },
      },
      actors: [null, {}, { ...actor("wrong-id"), id: 42 }, actor("valid-actor")],
      workItems: [undefined, { id: "missing-fields" }, { ...workItem("valid"), updatedAt: 7 }],
    } as unknown as ActivitySnapshot;

    const container = await mount(<ActivityDock {...props({ onToggle, snapshot: malformed })} />);
    const button = pill(container);

    expect(button.getAttribute("aria-label")).toBe("Activity: Background tasks 0 active, 3 done");
    expect(button.textContent).toContain("Active 0");
    expect(button.textContent).toContain("Done 3");
    expect(button.textContent).not.toContain("NaN");
    expect(button.textContent).not.toContain("Infinity");
    expect(container.querySelector('[data-activity-provider-glyph="unknown"]')).not.toBeNull();

    await act(async () => button.click());
    expect(onToggle).toHaveBeenCalledWith("backgroundTasks");
  });

  it("activates the single native button once with Enter or Space", async () => {
    const onToggle = vi.fn();
    const container = await mount(<ActivityDock {...props({ onToggle })} />);
    const button = pill(container);

    expect(button.tabIndex).toBe(0);
    const enter = await activateNativeButton(button, "Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(onToggle).toHaveBeenCalledTimes(1);

    const space = await activateNativeButton(button, " ");
    expect(space.defaultPrevented).toBe(false);
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenLastCalledWith("subagents");
  });

  it("does not consume Escape for its surroundings", async () => {
    const onSurroundingKeyDown = vi.fn();
    const container = await mount(
      <div onKeyDown={onSurroundingKeyDown}>
        <ActivityDock {...props()} />
      </div>,
    );
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });

    await act(async () => pill(container).dispatchEvent(escape));

    expect(escape.defaultPrevented).toBe(false);
    expect(onSurroundingKeyDown).toHaveBeenCalledTimes(1);
  });

  it("keeps one polite live region stable and updates it for count changes", async () => {
    vi.useFakeTimers();
    const initialSnapshot = snapshot({ actors: [actor("actor-a")] });
    const initialProps = props({ snapshot: initialSnapshot });
    const container = await mount(<ActivityDock {...initialProps} />);
    const liveRegion = container.querySelector<HTMLElement>('[aria-live="polite"]');

    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(liveRegion?.getAttribute("role")).toBe("status");
    expect(liveRegion?.textContent).toBe(
      "Activity update: 2 active subagents, 1 done subagent, 1 active background task, 1 done background task",
    );

    const changedSnapshot = snapshot({
      ...initialSnapshot,
      revision: 2,
      counts: counts({ active: 3, done: 1 }, { active: 1, done: 1 }),
    });
    await rerender(container, <ActivityDock {...initialProps} snapshot={changedSnapshot} />);
    expect(container.querySelector('[aria-live="polite"]')).toBe(liveRegion);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(liveRegion?.textContent).toContain("3 active subagents");
  });

  it("coalesces rapid live announcements to the latest activity counts once per 500ms window", async () => {
    vi.useFakeTimers();
    const initialProps = props();
    const container = await mount(<ActivityDock {...initialProps} />);
    const liveRegion = container.querySelector<HTMLElement>('[aria-live="polite"]')!;
    const initialAnnouncement = liveRegion.textContent;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(liveRegion, { childList: true, characterData: true, subtree: true });

    for (const active of [3, 4, 5]) {
      await rerender(
        container,
        <ActivityDock
          {...initialProps}
          snapshot={snapshot({
            revision: active,
            counts: counts({ active, done: 1 }, { active: 1, done: 1 }),
          })}
        />,
      );
    }

    expect(liveRegion.textContent).toBe(initialAnnouncement);
    expect(mutations).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(liveRegion.textContent).toContain("5 active subagents");
    expect(mutations.length).toBeLessThanOrEqual(1);
    observer.disconnect();
  });

  it("separates the compact counts with a bold dot", async () => {
    const container = await mount(<ActivityDock {...props({ compact: true })} />);
    const button = pill(container);

    expect(button.querySelectorAll("[data-activity-provider-glyph]")).toHaveLength(1);
    expect(button.textContent).toContain("Active 3");
    expect(button.textContent).toContain("·");
    expect(button.textContent).toContain("Done 2");
    const separator = button.querySelector<HTMLSpanElement>("[data-activity-count-separator]");
    expect(separator?.textContent).toBe("·");
    expect(separator?.classList.contains("text-base")).toBe(true);
    expect(separator?.classList.contains("font-bold")).toBe(true);
    expect(separator?.classList.contains("leading-none")).toBe(true);
    expect(separator?.classList.contains("text-foreground")).toBe(true);
    expect(separator?.getAttribute("aria-hidden")).toBe("true");

    const wide = await mount(<ActivityDock {...props({ compact: false })} />);
    expect(wide.querySelector("[data-activity-count-separator]")).toBeNull();
  });

  it("saturates unsafe finite counts and never renders overflow, Infinity, or NaN", async () => {
    const unsafeSnapshot = snapshot({
      counts: {
        subagents: {
          active: Number.MAX_SAFE_INTEGER + 100,
          done: Number.NaN,
        },
        backgroundTasks: {
          active: 1,
          done: Number.POSITIVE_INFINITY,
        },
      },
    } as Partial<ActivitySnapshot>);
    const container = await mount(<ActivityDock {...props({ snapshot: unsafeSnapshot })} />);
    const button = pill(container);

    expect(button.textContent).toContain(`Active ${Number.MAX_SAFE_INTEGER}`);
    expect(button.textContent).toContain("Done 0");
    expect(button.textContent).not.toContain("Infinity");
    expect(button.textContent).not.toContain("NaN");
    expect(button.getAttribute("aria-label")).toContain(
      `Subagents ${Number.MAX_SAFE_INTEGER} active`,
    );
  });

  it("never names an unsupported section while another section remains visible", async () => {
    const onToggle = vi.fn();
    const backgroundOnly = snapshot({
      capabilities: {
        actors: false,
        attributedActivity: false,
        backgroundWork: true,
        historyRecovery: "bounded",
        terminalObservation: false,
        targetedActorCancellation: false,
      },
      sections: sections("unsupported", "live"),
      counts: counts({ active: 1, done: 1 }, { active: 2, done: 3 }),
      actors: [actor("unsupported-actor", "2026-07-22T21:00:00.000Z")],
      workItems: [workItem("work-a")],
    });
    const container = await mount(
      <ActivityDock {...props({ onToggle, snapshot: backgroundOnly })} />,
    );
    const button = pill(container);

    expect(button.getAttribute("aria-label")).toBe("Activity: Background tasks 2 active, 3 done");
    expect(button.textContent).toContain("Active 2");
    expect(container.textContent).not.toContain("unsupported-actor");
    await act(async () => button.click());
    expect(onToggle).toHaveBeenCalledWith("backgroundTasks");
  });

  it("shows the mapped provider glyph", async () => {
    const container = await mount(<ActivityDock {...props()} />);
    const glyph = container.querySelector<HTMLElement>('[data-activity-provider-glyph="codex"]');
    const icon = glyph?.querySelector("svg");

    expect(glyph).not.toBeNull();
    expect(icon?.getAttribute("viewBox")).toBe("0 0 256 260");
    expect(icon?.classList.contains("lucide-bot")).toBe(false);
  });

  it.each(["constructor", "toString", "ordinary-unknown-provider"])(
    "uses the exact Bot fallback for the unknown provider slug %s",
    async (provider) => {
      const unknownProviderSnapshot = snapshot({
        provider: provider as ActivitySnapshot["provider"],
      });

      const container = await mount(
        <ActivityDock {...props({ snapshot: unknownProviderSnapshot })} />,
      );
      const glyph = container.querySelector<HTMLElement>(
        `[data-activity-provider-glyph="${provider}"]`,
      );
      const icon = glyph?.querySelector("svg");

      expect(glyph).not.toBeNull();
      expect(icon?.classList.contains("lucide-bot")).toBe(true);
      expect(icon?.getAttribute("viewBox")).toBe("0 0 24 24");
    },
  );

  it("keeps exact counts when actor summaries are truncated", async () => {
    const truncatedSnapshot = snapshot({
      counts: counts({ active: 8, done: 3 }, { active: 0, done: 0 }),
      actors: [actor("actor-f"), actor("actor-b"), actor("actor-d")],
      actorsHasMore: true,
    });
    const dockProps = props({ snapshot: truncatedSnapshot });
    const container = await mount(<ActivityDock {...dockProps} />);

    expect(container.textContent).not.toContain("+7");
    expect(container.textContent).toContain("Active 8");
    expect(container.textContent).toContain("Done 3");

    await rerender(
      container,
      <ActivityDock {...dockProps} snapshot={snapshot({ ...truncatedSnapshot, actors: [] })} />,
    );
    expect(container.querySelectorAll("[data-activity-provider-glyph]")).toHaveLength(1);
    expect(container.textContent).toContain("Active 8");
  });

  it("sits in its pane's layout, end-aligned, with bounded focus and card classes", async () => {
    const container = await mount(<ActivityDock {...props()} />);
    const placement = container.querySelector<HTMLElement>('[data-testid="activity-dock"]');
    const card = placement?.firstElementChild as HTMLElement | null;
    const button = pill(container);

    expect(placement?.className).toContain("pointer-events-auto");
    expect(placement?.className).toContain("justify-end");
    expect(placement?.className).not.toContain("absolute");
    expect(card?.className.split(/\s+/u)).toContain("w-fit");
    expect(card?.className).toContain("max-w-72");
    expect(card?.className).toContain("border-border");
    expect(card?.className).toContain("bg-popover");
    expect(card?.className).toContain("text-popover-foreground");
    expect(card?.className).not.toContain("transition");
    expect(button.className).toContain("min-h-9");
    expect(button.className).toContain("focus-visible:ring-2");
  });
});
