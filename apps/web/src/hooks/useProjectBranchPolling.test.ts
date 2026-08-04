import { EnvironmentId } from "@bibcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  map: new Map<string, string | null>(),
  updates: [] as Array<(current: Map<string, string | null>) => Map<string, string | null>>,
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
  query: {} as { data?: { refName?: string | null } },
  descriptors: [] as unknown[],
  refreshStatus: vi.fn(),
  intervals: [] as Array<{ callback: () => void; delay: number; id: number }>,
  clears: [] as number[],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useRef: (initial: unknown) => {
    const ref = { current: initial };
    harness.refs.push(ref);
    return ref;
  },
  useState: () => [
    harness.map,
    (update: (current: Map<string, string | null>) => Map<string, string | null>) =>
      harness.updates.push(update),
  ],
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (descriptor: unknown) => {
    harness.descriptors.push(descriptor);
    return harness.query;
  },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => harness.refreshStatus,
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    refreshStatus: "refresh-status",
    status: (input: unknown) => ({ status: input }),
  },
}));

import {
  useProjectBranchPolling,
  type ProjectBranchPollingProject,
} from "./useProjectBranchPolling";

const projects: ProjectBranchPollingProject[] = [
  {
    key: "active",
    environmentId: EnvironmentId.make("environment-1"),
    workspaceRoot: "/active",
  },
  {
    key: "background",
    environmentId: EnvironmentId.make("environment-2"),
    workspaceRoot: "/background",
  },
];

beforeEach(() => {
  harness.map = new Map();
  harness.updates.length = 0;
  harness.effects.length = 0;
  harness.refs.length = 0;
  harness.query = {};
  harness.descriptors.length = 0;
  harness.refreshStatus.mockReset();
  harness.refreshStatus.mockResolvedValue(undefined);
  harness.intervals.length = 0;
  harness.clears.length = 0;
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("window", {
    setInterval: (callback: () => void, delay: number) => {
      const id = harness.intervals.length + 1;
      harness.intervals.push({ callback, delay, id });
      return id;
    },
    clearInterval: (id: number) => harness.clears.push(id),
  });
});

function runEffect(index: number): void | (() => void) {
  return harness.effects[index]?.();
}

describe("useProjectBranchPolling", () => {
  it("does not issue heavyweight full-status requests from its polling loop", () => {
    useProjectBranchPolling({ projects, activeProjectKey: "active" });
    for (const effect of harness.effects) effect();

    expect(harness.intervals).toEqual([]);
    expect(harness.refreshStatus).not.toHaveBeenCalled();
  });

  it("skips active polling when there is no active project", () => {
    const result = useProjectBranchPolling({ projects, activeProjectKey: null });
    expect(result.branchByProjectKey).toBe(harness.map);
    expect(harness.descriptors).toEqual([null]);
    expect(runEffect(0)).toBeUndefined();
    expect(harness.intervals).toEqual([]);
  });

  it("publishes changed branches while preserving identical state", () => {
    harness.query = { data: { refName: "feature" } };
    useProjectBranchPolling({ projects, activeProjectKey: "active" });
    runEffect(0);
    const update = harness.updates[0]!;
    const changed = update(new Map());
    expect(changed).not.toBe(harness.map);
    expect(changed.get("active")).toBe("feature");
    expect(update(new Map([["active", "feature"]])).get("active")).toBe("feature");

    harness.effects.length = 0;
    harness.updates.length = 0;
    harness.query = {};
    useProjectBranchPolling({ projects, activeProjectKey: "active" });
    runEffect(0);
    expect(harness.updates[0]!(new Map()).get("active")).toBeNull();
  });
});
