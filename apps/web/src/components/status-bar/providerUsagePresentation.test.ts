import type { ServerProviderUsageSnapshot } from "@bibcode/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderUsageViewModel,
  providerUsageRelativeLabelKey,
} from "./providerUsagePresentation";

const now = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");
const updatedAt = DateTime.makeUnsafe("2026-07-07T17:59:00.000Z");

function providerSnapshot(
  patch: Partial<ServerProviderUsageSnapshot> = {},
): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    status: "ok",
    session: {
      usedPercent: 20,
      windowMinutes: 300,
      resetsAt: DateTime.makeUnsafe("2026-07-07T18:05:00.000Z"),
      resetDescription: "Resets later today",
    },
    weekly: {
      usedPercent: 80,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null,
    },
    fableWeekly: {
      usedPercent: 65,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null,
    },
    windowGroups: [],
    planType: null,
    rateLimitResetCredits: null,
    updatedAt,
    error: null,
    metadata: {},
    ...patch,
  };
}

describe("providerUsagePresentation", () => {
  it("clamps consumed values before deriving remaining display and fill", () => {
    const vm = buildProviderUsageViewModel(
      providerSnapshot({
        session: { usedPercent: -5, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: {
          usedPercent: 150,
          windowMinutes: 10080,
          resetsAt: null,
          resetDescription: null,
        },
        fableWeekly: {
          usedPercent: Number.NaN,
          windowMinutes: 10080,
          resetsAt: null,
          resetDescription: null,
        },
      }),
      { now },
    );

    expect(vm.windows.map((window) => window.consumedPercent)).toEqual([0, 100, 0]);
    expect(vm.windows.map((window) => window.displayedPercent)).toEqual([100, 0, 100]);
    expect(vm.windows.map((window) => window.fillPercent)).toEqual([100, 0, 100]);
    expect(vm.windows.map((window) => window.percentageLabel)).toEqual([
      "100% remaining",
      "0% remaining",
      "100% remaining",
    ]);
    expect(vm.compactWindows.map((window) => window.key)).toEqual(["weekly"]);
  });

  it("changes only labels and fills for Used display", () => {
    const snapshot = providerSnapshot({
      session: { usedPercent: 25, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: null, resetDescription: null },
      fableWeekly: null,
    });

    const remaining = buildProviderUsageViewModel(snapshot, {
      now,
      percentageDisplay: "remaining",
    });
    const used = buildProviderUsageViewModel(snapshot, { now, percentageDisplay: "used" });

    expect(remaining.windows.map((window) => window.consumedPercent)).toEqual([25, 80]);
    expect(used.windows.map((window) => window.consumedPercent)).toEqual([25, 80]);
    expect(remaining.compactWindows.map((window) => window.key)).toEqual(["weekly"]);
    expect(used.compactWindows.map((window) => window.key)).toEqual(["weekly"]);
    expect(remaining.windows.map((window) => [window.fillPercent, window.percentageLabel])).toEqual(
      [
        [75, "75% remaining"],
        [20, "20% remaining"],
      ],
    );
    expect(used.windows.map((window) => [window.fillPercent, window.percentageLabel])).toEqual([
      [25, "25% used"],
      [80, "80% used"],
    ]);
  });

  it("keeps detailed windows in Session, Weekly, Fable order and makes compact output single-window", () => {
    const vm = buildProviderUsageViewModel(providerSnapshot(), { now });

    expect(vm.windows.map((window) => [window.key, window.label])).toEqual([
      ["session", "Session"],
      ["weekly", "Weekly"],
      ["fable", "Fable"],
    ]);
    expect(vm.detailedWindows.map((window) => window.key)).toEqual(["session", "weekly", "fable"]);
    expect(vm.compactWindows.map((window) => window.key)).toEqual(["weekly"]);
  });

  it("handles missing windows without fabricated compact output", () => {
    const vm = buildProviderUsageViewModel(
      providerSnapshot({ session: null, weekly: null, fableWeekly: null }),
      { now },
    );

    expect(vm.windows).toEqual([]);
    expect(vm.compactWindows).toEqual([]);
  });

  it("uses deterministic reset countdowns and presentation-only plan title casing", () => {
    const snapshot = providerSnapshot({ planType: "  chatgpt plus  " });
    const vm = buildProviderUsageViewModel(snapshot, { now });

    expect(vm.windows[0]?.resetLabel).toBe("Resets in 5m");
    expect(vm.plan?.label).toBe("Chatgpt Plus");
    expect(vm.plan?.value).toBe("  chatgpt plus  ");
    expect(snapshot.planType).toBe("  chatgpt plus  ");
  });
});

describe("window groups", () => {
  const groupWindow = (usedPercent: number, minutes: number, resetsAt: string | null) => ({
    usedPercent,
    windowMinutes: minutes,
    resetsAt: resetsAt === null ? null : DateTime.makeUnsafe(resetsAt),
    resetDescription: null,
  });
  const antigravity = providerSnapshot({
    provider: "antigravity",
    session: null,
    weekly: null,
    fableWeekly: null,
    windowGroups: [
      {
        id: "gemini",
        label: "Gemini models",
        session: groupWindow(3, 300, "2026-07-07T18:05:00.000Z"),
        weekly: groupWindow(1, 10080, null),
      },
      {
        id: "third-party",
        label: "Claude and GPT models",
        session: groupWindow(90, 300, null),
        weekly: null,
      },
    ],
  });

  it("flattens every group window and compacts to the tightest one", () => {
    const vm = buildProviderUsageViewModel(antigravity, { now });
    expect(vm.windows.map((window) => window.label)).toEqual([
      "Gemini 5-hour",
      "Gemini weekly",
      "Claude/GPT 5-hour",
    ]);
    expect(vm.windows.map((window) => window.key)).toEqual([
      "gemini-session",
      "gemini-weekly",
      "third-party-session",
    ]);
    expect(vm.compactWindows.map((window) => window.label)).toEqual(["Claude/GPT 5-hour"]);
    // The bar shows the tightest window in detailed mode too; the popover shows the groups.
    expect(vm.detailedWindows).toEqual(vm.compactWindows);
    expect(
      vm.groups.map((group) => [group.label, group.windows.map((window) => window.label)]),
    ).toEqual([
      ["Gemini models", ["5-hour", "Weekly"]],
      ["Claude and GPT models", ["5-hour"]],
    ]);
  });

  it("drops the meters of an expired or unavailable snapshot and keeps an error's", () => {
    for (const status of ["unavailable", "fetching", "idle"] as const) {
      const vm = buildProviderUsageViewModel({ ...antigravity, status }, { now });
      expect([vm.windows, vm.groups, vm.detailedWindows]).toEqual([[], [], []]);
    }
    const retained = buildProviderUsageViewModel({ ...antigravity, status: "error" }, { now });
    expect(retained.groups).toHaveLength(2);
  });

  it("shows no update time for the server's not-fetched placeholder", () => {
    const vm = buildProviderUsageViewModel(
      {
        ...antigravity,
        status: "unavailable",
        windowGroups: [],
        error: "Provider usage has not been fetched yet.",
      },
      { now },
    );
    expect(vm.updatedAt).toBeNull();
  });

  it("keys the countdown cache on group windows, so an expired reset changes the key", () => {
    const before = providerUsageRelativeLabelKey([antigravity], now);
    const after = providerUsageRelativeLabelKey(
      [antigravity],
      DateTime.makeUnsafe("2026-07-07T18:30:00.000Z"),
    );
    expect(before).not.toBe(after);
  });
});
