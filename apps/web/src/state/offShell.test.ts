import { offShellThreads } from "@bibcode/client-runtime/state/off-shell-threads";
import { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  capped: true,
  calls: [] as Array<{ tag: string; input: unknown }>,
  answer: (_input: { threadIds: ReadonlyArray<string> }) =>
    ({ threads: [], missing: [] }) as { threads: unknown[]; missing: string[] },
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => ({
      status: "live",
      snapshot: h.capped ? { _tag: "Some", value: { capped: true } } : { _tag: "Some", value: {} },
    }),
  },
}));
vi.mock("./shell", () => ({ environmentShell: { stateValueAtom: () => "shell-atom" } }));
vi.mock("./orchestration", () => ({
  orchestrationEnvironment: {
    listOlderThreads: { tag: "listOlderThreads" },
    getThreadShells: { tag: "getThreadShells" },
  },
}));
vi.mock("@bibcode/client-runtime/state/runtime", () => ({
  runAtomCommand: async (
    _registry: unknown,
    command: { tag: string },
    target: { input: { threadIds: ReadonlyArray<string> } },
  ) => {
    h.calls.push({ tag: command.tag, input: target.input });
    return { _tag: "Success", value: h.answer(target.input) };
  },
}));

import { requestThreadShells, resolveThreadShellWith } from "./offShell";

const ENVIRONMENT = EnvironmentId.make("environment-resolver");

function shell(id: string, archivedAt: string | null = null) {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    archivedAt,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const ref = (threadId: string) => ({
  environmentId: ENVIRONMENT,
  threadId: ThreadId.make(threadId),
});
const noLiveShell = () => null;

beforeEach(() => {
  h.capped = true;
  h.calls = [];
  h.answer = ({ threadIds }) => ({ threads: [], missing: [...threadIds] });
  offShellThreads.reset(ENVIRONMENT);
});

describe("thread resolver (#223)", () => {
  it("resolves shell, then off-shell, then the server", async () => {
    const live = { ...shell("live"), environmentId: ENVIRONMENT } as never;
    expect(await resolveThreadShellWith(ref("live"), () => live)).toEqual({
      kind: "resolved",
      thread: live,
    });
    offShellThreads.applyLookup(ENVIRONMENT, offShellThreads.get(ENVIRONMENT).generation, {
      threads: [shell("paged") as never],
      missing: [],
    });
    const paged = await resolveThreadShellWith(ref("paged"), noLiveShell);
    expect(paged.kind === "resolved" && paged.thread.title).toBe("paged");
    expect(h.calls).toEqual([]);
    h.answer = () => ({ threads: [shell("remote")], missing: [] });
    const remote = await resolveThreadShellWith(ref("remote"), noLiveShell);
    expect(remote.kind === "resolved" && remote.thread.title).toBe("remote");
    expect(h.calls).toEqual([{ tag: "getThreadShells", input: { threadIds: ["remote"] } }]);
  });

  it("remembers missing for the session", async () => {
    expect(await resolveThreadShellWith(ref("gone"), noLiveShell)).toEqual({ kind: "missing" });
    expect(await resolveThreadShellWith(ref("gone"), noLiveShell)).toEqual({ kind: "missing" });
    expect(h.calls).toHaveLength(1);
  });

  it("batches lookups per tick", async () => {
    await Promise.all([
      requestThreadShells(ENVIRONMENT, [ThreadId.make("a")]),
      requestThreadShells(ENVIRONMENT, [ThreadId.make("b"), ThreadId.make("a")]),
    ]);
    expect(h.calls).toEqual([{ tag: "getThreadShells", input: { threadIds: ["a", "b"] } }]);
  });

  it("answers Unknown, never Missing, for an uncapped shell", async () => {
    h.capped = false;
    expect(await resolveThreadShellWith(ref("anything"), noLiveShell)).toEqual({ kind: "unknown" });
    expect(h.calls).toEqual([]);
  });

  it("resolves an archived thread with archivedAt", async () => {
    h.answer = () => ({ threads: [shell("archived", "2026-07-12T00:00:00.000Z")], missing: [] });
    const archived = await resolveThreadShellWith(ref("archived"), noLiveShell);
    expect(archived.kind === "resolved" && archived.thread.archivedAt).toBe(
      "2026-07-12T00:00:00.000Z",
    );
  });
});
