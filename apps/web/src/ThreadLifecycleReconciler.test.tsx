// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface TestThread {
  readonly id: string;
  readonly kind: "default" | "panel";
}

interface TestSnapshot {
  readonly snapshotSequence: number;
  readonly threads: ReadonlyArray<TestThread>;
  readonly capped?: boolean;
  readonly engineSequence?: number;
}

const h = vi.hoisted(() => ({
  shell: { status: "live", snapshot: { _tag: "None" } } as {
    status: string;
    snapshot: { readonly _tag: "Some"; readonly value: unknown } | { readonly _tag: "None" };
  },
  archived: {
    snapshots: [] as ReadonlyArray<{ environmentId: string; snapshot: unknown }>,
    error: null as string | null,
    isLoading: false,
  },
  // Server sequence at which each archived request still in flight started.
  inFlight: [] as number[],
  maxInFlight: 0,
  serverSequence: 0,
  refresh: vi.fn(),
  centerByThreadKey: {} as Record<string, { surfaces: [] }>,
  removeCenterThread: vi.fn<(ref: { environmentId: string; threadId: string }) => void>(),
  removeRightThread: vi.fn(),
  emptyDrafts: {},
  archivedOptions: undefined as unknown,
  // The server's answer to `getThreadShells`: ids it does not know are missing.
  known: new Set<string>(),
  lookups: [] as string[][],
  // While set, a lookup waits for it before it answers.
  holdLookups: null as Promise<void> | null,
  // Ids the server reports archived, with their kind.
  archivedKnown: new Map<string, "default" | "panel">(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => h.shell,
  useAtomSubscribe: () => undefined,
}));
vi.mock("./state/shell", () => ({
  environmentShell: { stateValueAtom: () => "shell-atom" },
}));
vi.mock("./state/offShell", () => ({
  requestThreadShells: async (environmentId: string, threadIds: ReadonlyArray<string>) => {
    h.lookups.push([...threadIds]);
    const { offShellThreads } = await import("@bibcode/client-runtime/state/off-shell-threads");
    const generation = offShellThreads.get(environmentId as never).generation;
    if (h.holdLookups !== null) await h.holdLookups;
    offShellThreads.applyLookup(environmentId as never, generation, {
      threads: [
        ...threadIds
          .filter((threadId) => h.known.has(threadId))
          .map((threadId) => ({ id: threadId, kind: "default", archivedAt: null })),
        ...threadIds.flatMap((threadId) => {
          const kind = h.archivedKnown.get(threadId);
          return kind === undefined ? [] : [{ id: threadId, kind, archivedAt: "2026-11-02" }];
        }),
      ] as never,
      missing: threadIds.filter(
        (threadId) => !h.known.has(threadId) && !h.archivedKnown.has(threadId),
      ) as never,
    });
  },
}));
vi.mock("./state/terminal", () => ({
  terminalEnvironment: { metadataEvents: () => "terminal-metadata-atom" },
}));
vi.mock("./state/threads", () => ({ threadEnvironment: { archive: "archive" } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => () => undefined }));
vi.mock("./state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "primary" }] }),
}));
vi.mock("./centerPanelAdoption", () => ({
  applyPanelThreadAdoption: () => undefined,
  applyTerminalMetadataAdoption: () => undefined,
  createCenterPanelAdoptionTracker: () => ({}),
}));
vi.mock("./centerPanelStore", () => ({
  useCenterPanelStore: {
    getState: () => ({
      byThreadKey: h.centerByThreadKey,
      pendingChatPanelThreadKeys: new Set<string>(),
      releaseChatPanelReservation: () => undefined,
      removeThread: h.removeCenterThread,
    }),
  },
}));
vi.mock("./rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ byThreadKey: {}, removeThread: h.removeRightThread }),
  },
}));
vi.mock("./composerDraftStore", () => ({
  useComposerDraftStore: (select: (state: { draftThreadsByThreadKey: object }) => unknown) =>
    select({ draftThreadsByThreadKey: h.emptyDrafts }),
}));
vi.mock("./lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: (_environmentIds: unknown, options: unknown) => {
    h.archivedOptions = options;
    return { ...h.archived, refresh: h.refresh };
  },
}));

import { offShellThreads } from "@bibcode/client-runtime/state/off-shell-threads";

import { ThreadLifecycleReconciler } from "./ThreadLifecycleReconciler";

let container: HTMLDivElement;
let root: Root;

function thread(id: string, kind: TestThread["kind"] = "default"): TestThread {
  return { id, kind };
}

function render(): void {
  act(() => {
    root.render(<ThreadLifecycleReconciler />);
  });
}

function setLive(
  snapshotSequence: number,
  threads: ReadonlyArray<TestThread>,
  capped = false,
): void {
  const snapshot: TestSnapshot = { snapshotSequence, threads, ...(capped ? { capped } : {}) };
  h.shell = { status: "live", snapshot: { _tag: "Some", value: snapshot } };
}

/** Starts an archived request: what the archived atom does on mount and on refresh. */
function startArchivedRequest(): void {
  h.inFlight.push(h.serverSequence);
  h.maxInFlight = Math.max(h.maxInFlight, h.inFlight.length);
  h.archived = { ...h.archived, isLoading: true };
}

/** Mounts with the live shell at sequence 1 and the archived atom's first request running. */
function mount(threads: ReadonlyArray<TestThread>): void {
  h.serverSequence = 1;
  setLive(1, threads);
  startArchivedRequest();
  render();
}

/** Commits a server event and delivers the live shell snapshot it produces. */
function advanceLive(threads: ReadonlyArray<TestThread>): void {
  h.serverSequence += 1;
  setLive(h.serverSequence, threads);
  render();
}

/** Completes the oldest archived request with the archived threads at its start. */
function settleArchived(threads: ReadonlyArray<TestThread>): void {
  const startedAt = h.inFlight.shift();
  if (startedAt === undefined) throw new Error("no archived request in flight");
  const snapshot: TestSnapshot = { snapshotSequence: startedAt, threads };
  h.archived = {
    snapshots: [{ environmentId: "primary", snapshot }],
    error: null,
    isLoading: h.inFlight.length > 0,
  };
  render();
}

function removedThreadIds(): string[] {
  return h.removeCenterThread.mock.calls.map(([ref]) => ref.threadId);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.shell = { status: "live", snapshot: { _tag: "None" } };
  h.archived = { snapshots: [], error: null, isLoading: false };
  h.inFlight = [];
  h.maxInFlight = 0;
  h.serverSequence = 0;
  h.centerByThreadKey = {};
  h.refresh.mockReset();
  h.refresh.mockImplementation(startArchivedRequest);
  h.removeCenterThread.mockReset();
  h.removeCenterThread.mockImplementation(({ environmentId, threadId }) => {
    delete h.centerByThreadKey[`${environmentId}:${threadId}`];
  });
  h.removeRightThread.mockReset();
  h.known = new Set();
  h.lookups = [];
  h.holdLookups = null;
  h.archivedKnown = new Map();
  offShellThreads.reset("primary" as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("ThreadLifecycleReconciler", () => {
  it("does not refetch archived threads while a turn advances the live shell", () => {
    const live = [thread("a"), thread("b")];
    mount(live);
    for (let event = 0; event < 20; event += 1) {
      advanceLive(live);
      if (h.inFlight.length > 0) settleArchived([]);
    }

    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.maxInFlight).toBe(1);
    // Mounted for the app's lifetime, it opts out of the lists' refetch on mount.
    expect(h.archivedOptions).toEqual({ revalidateOnMount: false });
  });

  it("refetches once per lifecycle change and never overlaps archived requests", () => {
    h.centerByThreadKey = {
      "primary:a": { surfaces: [] },
      "primary:b": { surfaces: [] },
      "primary:gone": { surfaces: [] },
    };
    mount([thread("a"), thread("b")]);
    settleArchived([]);
    // Authoritative: the thread missing from both lists loses its state.
    expect(removedThreadIds()).toEqual(["gone"]);
    h.removeCenterThread.mockClear();

    // Thread b is archived: it leaves the live list.
    advanceLive([thread("a")]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // The turn keeps streaming while the archived request runs.
    advanceLive([thread("a")]);
    advanceLive([thread("a")]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // No archived snapshot has seen b's archive yet, so b's state must survive.
    expect(h.removeCenterThread).not.toHaveBeenCalled();

    settleArchived([thread("b")]);
    advanceLive([thread("a")]);
    advanceLive([thread("a")]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.removeCenterThread).not.toHaveBeenCalled();
    expect(h.maxInFlight).toBe(1);
  });

  it("refetches when a lifecycle change lands during an archived request", () => {
    h.centerByThreadKey = { "primary:a": { surfaces: [] }, "primary:b": { surfaces: [] } };
    mount([thread("a"), thread("b")]);
    // Thread b is archived while the mount request is still running.
    advanceLive([thread("a")]);
    expect(h.refresh).not.toHaveBeenCalled();

    // The mount request predates the archive, so it cannot decide b's fate.
    settleArchived([]);
    expect(h.removeCenterThread).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(1);

    settleArchived([thread("b")]);
    expect(h.removeCenterThread).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.maxInFlight).toBe(1);
  });

  it("waits for the live shell to catch up with a newer archived snapshot", () => {
    h.centerByThreadKey = { "primary:a": { surfaces: [] }, "primary:c": { surfaces: [] } };
    // Thread c is unarchived at sequence 2; the archived request sees it, the live shell not yet.
    h.serverSequence = 2;
    setLive(1, [thread("a")]);
    startArchivedRequest();
    render();
    settleArchived([]);
    expect(h.removeCenterThread).not.toHaveBeenCalled();

    setLive(2, [thread("a"), thread("c")]);
    render();
    expect(h.removeCenterThread).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe("ThreadLifecycleReconciler with a capped shell (#223)", () => {
  /** A capped live shell at sequence 1 whose archived snapshot then settles with `archived`. */
  async function settleCapped(
    live: ReadonlyArray<TestThread>,
    archived: ReadonlyArray<TestThread>,
  ): Promise<void> {
    h.serverSequence = 1;
    setLive(1, live, true);
    startArchivedRequest();
    render();
    await act(async () => {
      settleArchived(archived);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("keeps panel state of a thread left out of a capped snapshot", async () => {
    h.centerByThreadKey = { "primary:a": { surfaces: [] }, "primary:older": { surfaces: [] } };
    h.known = new Set(["older"]);
    await settleCapped([thread("a")], []);
    expect(h.lookups).toEqual([["older"]]);
    expect(removedThreadIds()).toEqual([]);
  });

  it("deletes panel state only for ids getThreadShells reports missing", async () => {
    h.centerByThreadKey = {
      "primary:a": { surfaces: [] },
      "primary:older": { surfaces: [] },
      "primary:gone": { surfaces: [] },
    };
    h.known = new Set(["older"]);
    await settleCapped([thread("a")], []);
    expect(removedThreadIds()).toEqual(["gone"]);
  });

  it("keeps an archived workspace's state after a removal item and restores it on unarchive", async () => {
    h.centerByThreadKey = { "primary:a": { surfaces: [] }, "primary:archived": { surfaces: [] } };
    // Archived: the live shell sent a removal item, which deletes nothing on its own.
    await settleCapped([thread("a")], [thread("archived")]);
    expect(h.lookups).toEqual([]);
    expect(removedThreadIds()).toEqual([]);
    // Unarchived: back in the live shell with its saved state.
    advanceLive([thread("a"), thread("archived")]);
    expect(h.centerByThreadKey["primary:archived"]).toBeDefined();
  });

  it("drops an archived chat panel's state", async () => {
    h.centerByThreadKey = { "primary:a": { surfaces: [] }, "primary:closed": { surfaces: [] } };
    await settleCapped([thread("a")], [thread("closed", "panel")]);
    expect(removedThreadIds()).toEqual(["closed"]);
  });

  it("drops a panel the lookup finds closed, and keeps a workspace it finds archived", async () => {
    h.centerByThreadKey = {
      "primary:a": { surfaces: [] },
      "primary:closed-elsewhere": { surfaces: [] },
      "primary:archived-workspace": { surfaces: [] },
    };
    // Closed or archived after the archived snapshot, while the capped shell left them out.
    h.archivedKnown = new Map([
      ["closed-elsewhere", "panel"],
      ["archived-workspace", "default"],
    ]);
    await settleCapped([thread("a")], []);
    expect(removedThreadIds()).toEqual(["closed-elsewhere"]);
  });

  it("does not look a resolved thread up again on every shell update", async () => {
    h.centerByThreadKey = { "primary:a": { surfaces: [] }, "primary:older": { surfaces: [] } };
    h.known = new Set(["older"]);
    await settleCapped([thread("a")], []);
    expect(h.lookups).toEqual([["older"]]);
    // A turn streams: the shell's sequence advances, its membership does not.
    for (let sequence = 2; sequence < 6; sequence += 1) {
      await act(async () => {
        setLive(sequence, [thread("a")], true);
        render();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(h.lookups).toEqual([["older"]]);
    expect(removedThreadIds()).toEqual([]);
  });

  it("drops a delayed cleanup when a newer shell reopened a closed panel", async () => {
    h.centerByThreadKey = {
      "primary:a": { surfaces: [] },
      "primary:older": { surfaces: [] },
      "primary:closed": { surfaces: [] },
    };
    h.known = new Set(["older"]);
    let release = () => {};
    h.holdLookups = new Promise<void>((resolve) => {
      release = resolve;
    });
    // `older` is looked up while `closed` is still an archived panel.
    await settleCapped([thread("a")], [thread("closed", "panel")]);
    expect(h.lookups).toEqual([["older"]]);
    // Reopened before the lookup answers: back in the live shell.
    await act(async () => {
      h.serverSequence = 2;
      setLive(2, [thread("a"), thread("closed", "panel")], true);
      render();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(removedThreadIds()).not.toContain("closed");
  });

  it("compares the archived snapshot with the engine's sequence, not one past it", async () => {
    h.centerByThreadKey = { "primary:a": { surfaces: [] } };
    await settleCapped([thread("a")], []);
    h.centerByThreadKey["primary:gone"] = { surfaces: [] };
    // A terminal's agent started working: its host joins at sequence 2, past the engine's 1.
    await act(async () => {
      h.shell = {
        status: "live",
        snapshot: {
          _tag: "Some",
          value: {
            snapshotSequence: 2,
            engineSequence: 1,
            threads: [thread("a"), thread("host")],
            capped: true,
          } satisfies TestSnapshot,
        },
      };
      render();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (h.inFlight.length > 0) {
      await act(async () => {
        settleArchived([]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(removedThreadIds()).toEqual(["gone"]);
  });
});
