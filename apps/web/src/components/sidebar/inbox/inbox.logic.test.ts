import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentShellSummary } from "@bibcode/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { HOST_SURFACE_ID } from "../../../centerPanelStore";
import type { InboxAgentGroupId, InboxAgentRowFields } from "./agentRowContract";
import {
  INBOX_CATEGORIES,
  countInboxCategories,
  inboxTargetSurfaceId,
  isInboxRowCurrent,
  resolveInboxDataState,
  resolveInboxOpenTarget,
  resolveInboxSelection,
  selectInboxRows,
} from "./inbox.logic";

const ENV = EnvironmentId.make("env-1");
const REMOTE = EnvironmentId.make("env-2");

function row(
  id: string,
  group: InboxAgentGroupId,
  overrides: Partial<InboxAgentRowFields> & { updatedAt?: string } = {},
): InboxAgentRowFields {
  const ref = overrides.ref ?? scopeThreadRef(ENV, ThreadId.make(id));
  return {
    key: overrides.key ?? scopedThreadKey(ref),
    ref,
    group,
    terminalId: overrides.terminalId ?? null,
    shell: overrides.shell ?? {
      kind: "workspace",
      title: id,
      updatedAt: overrides.updatedAt ?? "2026-10-27T10:00:00.000Z",
    },
  };
}

function summary(overrides: Partial<EnvironmentShellSummary> = {}): EnvironmentShellSummary {
  return {
    catalogHealth: { status: "ready" },
    catalogReady: true,
    desiredEnvironmentCount: 1,
    statuses: [{ environmentId: ENV, status: "live", hasSnapshot: true, error: null }],
    canShowEmptyProjects: true,
    hasSnapshot: true,
    hasSynchronizingShell: false,
    hasCachedShell: false,
    hasLiveShell: true,
    firstError: null,
    latestSnapshotUpdatedAt: null,
    ...overrides,
  };
}

describe("inbox category mapping", () => {
  const rows = [
    row("working", "working"),
    row("blocked", "blocked"),
    row("waiting", "waiting"),
    row("done", "done"),
    row("unknown", "unknown"),
  ];

  it("lists the four tiles in order with their labels", () => {
    expect(INBOX_CATEGORIES.map(({ id, label }) => [id, label])).toEqual([
      ["all", "All Agents"],
      ["attention", "Needs Attention"],
      ["working", "Working"],
      ["done", "Done"],
    ]);
  });

  it("counts blocked and waiting as attention and unknown only in All Agents", () => {
    expect(countInboxCategories(rows)).toEqual({ all: 5, attention: 2, working: 1, done: 1 });
  });

  it("filters each tile to its groups", () => {
    const keys = (category: Parameters<typeof selectInboxRows>[1]) =>
      selectInboxRows(rows, category).map((entry) => entry.shell.title);
    expect(keys("attention").toSorted()).toEqual(["blocked", "waiting"]);
    expect(keys("working")).toEqual(["working"]);
    expect(keys("done")).toEqual(["done"]);
    expect(keys("all")).toHaveLength(5);
  });

  it("orders a tile by most recent activity, then key", () => {
    const ordered = selectInboxRows(
      [
        row("old", "done", { updatedAt: "2026-10-27T09:00:00.000Z" }),
        row("b", "done", { updatedAt: "2026-10-27T11:00:00.000Z" }),
        row("a", "done", { updatedAt: "2026-10-27T11:00:00.000Z" }),
      ],
      "done",
    );
    expect(ordered.map((entry) => entry.shell.title)).toEqual(["a", "b", "old"]);
  });
});

describe("inbox data readiness", () => {
  it("is loading until the catalog and a snapshot arrive", () => {
    expect(resolveInboxDataState(summary({ catalogReady: false }))).toBe("loading");
    expect(
      resolveInboxDataState(
        summary({
          statuses: [{ environmentId: ENV, status: "synchronizing", hasSnapshot: false, error: null }],
          hasSnapshot: false,
          canShowEmptyProjects: false,
        }),
      ),
    ).toBe("loading");
  });

  it("is complete only when every environment is live with a snapshot", () => {
    expect(resolveInboxDataState(summary())).toBe("complete");
  });

  it("is partial while any environment is offline, reconnecting, or the catalog is unhealthy", () => {
    const remote = (status: "unavailable" | "synchronizing", hasSnapshot: boolean) =>
      summary({
        desiredEnvironmentCount: 2,
        canShowEmptyProjects: false,
        statuses: [
          { environmentId: ENV, status: "live", hasSnapshot: true, error: null },
          { environmentId: REMOTE, status, hasSnapshot, error: null },
        ],
      });
    expect(resolveInboxDataState(remote("unavailable", false))).toBe("partial");
    expect(resolveInboxDataState(remote("synchronizing", true))).toBe("partial");
    expect(
      resolveInboxDataState(
        summary({
          catalogHealth: { status: "recovery-required", message: "Saved servers unreadable" },
          canShowEmptyProjects: false,
        }),
      ),
    ).toBe("partial");
  });
});

describe("inbox tile selection", () => {
  const none = { all: 1, attention: 0, working: 1, done: 0 };
  const some = { all: 2, attention: 1, working: 1, done: 0 };

  it("keeps a persisted tile and settles nothing", () => {
    expect(
      resolveInboxSelection({ persisted: "done", counts: some, dataState: "complete" }),
    ).toEqual({ category: "done", settle: null });
  });

  it("settles Needs Attention as soon as an agent needs attention", () => {
    for (const dataState of ["partial", "complete"] as const) {
      expect(resolveInboxSelection({ persisted: null, counts: some, dataState })).toEqual({
        category: "attention",
        settle: "attention",
      });
    }
  });

  it("settles All Agents only on complete data", () => {
    expect(resolveInboxSelection({ persisted: null, counts: none, dataState: "complete" })).toEqual(
      { category: "all", settle: "all" },
    );
    for (const dataState of ["loading", "partial"] as const) {
      expect(resolveInboxSelection({ persisted: null, counts: none, dataState })).toEqual({
        category: "all",
        settle: null,
      });
    }
  });

  it("does not settle from loading data even with attention agents", () => {
    expect(resolveInboxSelection({ persisted: null, counts: some, dataState: "loading" })).toEqual(
      { category: "all", settle: null },
    );
  });
});

describe("opening an inbox agent", () => {
  it("opens a chat row's host chat on its own route", () => {
    const target = resolveInboxOpenTarget(row("chat", "done"));
    expect(target).toEqual({
      hostRef: scopeThreadRef(ENV, ThreadId.make("chat")),
      surface: { kind: "host" },
    });
    expect(inboxTargetSurfaceId(target)).toBe(HOST_SURFACE_ID);
  });

  it("opens a chat panel thread on its host thread", () => {
    const panel = row("panel-1", "working", {
      shell: {
        kind: "panel",
        hostThreadId: ThreadId.make("host-1"),
        title: "Panel — Codex",
        updatedAt: "2026-10-27T10:00:00.000Z",
      },
    });
    const target = resolveInboxOpenTarget(panel);
    expect(target).toEqual({
      hostRef: scopeThreadRef(ENV, ThreadId.make("host-1")),
      surface: { kind: "panel", threadId: ThreadId.make("panel-1"), providerLabel: "Codex" },
    });
    expect(inboxTargetSurfaceId(target)).toBe("chat:panel-1");
  });

  it("opens a terminal row's AI terminal by its id", () => {
    const hostRef = scopeThreadRef(ENV, ThreadId.make("host-2"));
    const terminal = row("host-2", "unknown", {
      ref: hostRef,
      key: `${scopedThreadKey(hostRef)}#terminal:term-7`,
      terminalId: "term-7",
    });
    const target = resolveInboxOpenTarget(terminal);
    expect(target).toEqual({ hostRef, surface: { kind: "terminal", terminalId: "term-7" } });
    expect(inboxTargetSurfaceId(target)).toBe("terminal:term-7");
  });

  it("marks the row current only when its host is routed and its surface focused", () => {
    const target = resolveInboxOpenTarget(row("chat", "done"));
    const hostKey = scopedThreadKey(target.hostRef);
    expect(isInboxRowCurrent(target, hostKey, HOST_SURFACE_ID)).toBe(true);
    expect(isInboxRowCurrent(target, hostKey, "terminal:term-1")).toBe(false);
    expect(isInboxRowCurrent(target, "env-1:other", HOST_SURFACE_ID)).toBe(false);
    expect(isInboxRowCurrent(target, null, null)).toBe(false);
  });
});
