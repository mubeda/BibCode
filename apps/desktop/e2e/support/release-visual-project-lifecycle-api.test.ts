// @effect-diagnostics nodeBuiltinImport:off - Hermetic ports decode the owning public contracts.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { expect, it, vi } from "vite-plus/test";
import { ClientOrchestrationCommand } from "../../../../packages/contracts/src/orchestration.ts";
import {
  WorktreeGetRemovalPlanInput,
  WorktreeRemoveInput,
} from "../../../../packages/contracts/src/rpc.ts";
import { GitCloneInput, VcsStatusInput } from "../../../../packages/contracts/src/git.ts";
import {
  withProjectLifecycleApi,
  type ProjectLifecycleApiPorts,
} from "./release-visual-project-lifecycle-api.ts";
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const now = "2026-10-06T00:00:00Z";
function fixture(mode = "normal") {
  const requests: Array<{ id: string; tag: string; payload: unknown }> = [],
    fetches: Array<{ url: string; input: RequestInit }> = [],
    listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  let state = mode === "never-open" ? 0 : 1,
    closed = 0;
  const emit = (name: string, event: { data?: unknown } = {}) => {
    for (const cb of listeners.get(name) ?? []) cb(event);
  };
  const socket = {
    get readyState() {
      return state;
    },
    addEventListener: (name: string, cb: (event: { data?: unknown }) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(cb);
      listeners.set(name, set);
    },
    removeEventListener: (name: string, cb: (event: { data?: unknown }) => void) => {
      listeners.get(name)?.delete(cb);
    },
    close: () => {
      closed++;
      state = 3;
      emit("close");
    },
    send: (raw: string) => {
      const request = JSON.parse(raw);
      if (request._tag === "Pong") return;
      requests.push(request);
      if (mode === "hold") return;
      const value =
        request.tag === "worktree.getRemovalPlan"
          ? {
              planToken: "a".repeat(64),
              generation: 1,
              availability: "present",
              registered: true,
              locked: false,
              trackedChangeCount: 0,
              untrackedFileCount: 0,
              pruneImpact: [],
            }
          : request.tag === "vcs.refreshStatus"
            ? {
                isRepo: false,
                repositoryUnavailableReason: "untrusted",
                hasPrimaryRemote: false,
                isDefaultRef: false,
                refName: null,
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }
            : null;
      const error =
        request.tag === "worktree.remove"
          ? {
              _tag: "WorktreeRemovalError",
              reason: "session-running",
              message: "Owned running session.",
            }
          : {
              _tag: "GitCloneOperationError",
              reason: "cancelled",
              destination: "/owned/light/visual-project-lifecycle/clone-parent/lifecycle-origin",
              message: "Owned clone cancelled.",
            };
      const exit = ["worktree.remove", "vcs.clone"].includes(request.tag)
        ? {
            _tag: "Failure",
            cause: [
              { _tag: "Fail", error: mode === "wrong-error" ? { _tag: "ForeignError" } : error },
            ],
          }
        : { _tag: "Success", value: mode === "malformed" ? {} : value };
      queueMicrotask(() => {
        if (mode === "foreign-then-valid")
          emit("message", { data: JSON.stringify({ _tag: "Exit", requestId: "foreign", exit }) });
        emit("message", { data: JSON.stringify({ _tag: "Exit", requestId: request.id, exit }) });
      });
    },
  };
  const ports: ProjectLifecycleApiPorts = {
    fetch: async (url, input) => {
      fetches.push({ url, input });
      return {
        ok: true,
        json: async () =>
          url.endsWith("websocket-ticket")
            ? { ticket: "owned-ticket", expiresAt: now }
            : url.endsWith("snapshot")
              ? { snapshotSequence: 0, projects: [], threads: [], updatedAt: now }
              : { sequence: 1 },
      };
    },
    socket: () => socket,
  };
  const input = {
    CI: "true",
    ownedRoot: "/owned/light",
    accessToken: "owned-private-token",
    projectId: "owned-project",
    threadId: "owned-workspace",
    managedCheckout: "/owned/light/managed-worktrees/primary/codex-delivery-retry-light",
    trustCheckout: "/owned/light/visual-project-lifecycle/visual trust 'checkout",
    cloneUrl: "https://visual.invalid/lifecycle-origin.git",
    cloneParent: "/owned/light/visual-project-lifecycle/clone-parent",
    verifyTarget: vi.fn(async () => {}),
    observeUnsafeCleanup: vi.fn(),
    ports,
  };
  return {
    input,
    requests,
    fetches,
    socket,
    result: () => ({
      closed,
      listeners: [...listeners.values()].reduce((n, group) => n + group.size, 0),
    }),
  };
}
function removeInput() {
  return Schema.decodeUnknownSync(WorktreeRemoveInput)({
    commandId: "owned-remove",
    projectId: "owned-project",
    threadId: "owned-workspace",
    mode: "delete-git-worktree",
    expectedGeneration: 1,
    planToken: "a".repeat(64),
    forceDirty: false,
    confirmRepositoryWidePrune: false,
  });
}
it("uses only exact typed public lifecycle ports and preserves native typed refusal/cancellation", async () => {
  const f = fixture();
  await withProjectLifecycleApi(f.input, async (api) => {
    expect((await api.snapshot()).snapshotSequence).toBe(0);
    await api.dispatch(
      Schema.decodeUnknownSync(ClientOrchestrationCommand)({
        type: "thread.session.stop",
        commandId: "owned-stop",
        threadId: "owned-workspace",
        createdAt: now,
      }),
    );
    expect(
      (
        await api.removalPlan(
          Schema.decodeUnknownSync(WorktreeGetRemovalPlanInput)({
            projectId: "owned-project",
            threadId: "owned-workspace",
          }),
        )
      ).generation,
    ).toBe(1);
    await expect(api.remove(removeInput())).rejects.toMatchObject({
      _tag: "WorktreeRemovalError",
      reason: "session-running",
    });
    await expect(
      api.attachClone(
        Schema.decodeUnknownSync(GitCloneInput)({
          url: f.input.cloneUrl,
          parentDir: f.input.cloneParent,
          attach: true,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "GitCloneOperationError", reason: "cancelled" });
    expect(
      (
        await api.refreshStatus(
          Schema.decodeUnknownSync(VcsStatusInput)({ cwd: f.input.trustCheckout }),
        )
      ).repositoryUnavailableReason,
    ).toBe("untrusted");
  });
  expect(f.requests.map((value) => value.tag)).toEqual([
    "worktree.getRemovalPlan",
    "worktree.remove",
    "vcs.clone",
    "vcs.refreshStatus",
  ]);
  expect(f.fetches.map((value) => value.url)).toEqual([
    "http://127.0.0.1:4885/api/auth/websocket-ticket",
    "http://127.0.0.1:4885/api/orchestration/snapshot",
    "http://127.0.0.1:4885/api/orchestration/dispatch",
  ]);
  expect(f.result()).toEqual({ closed: 1, listeners: 0 });
});
it.each(["malformed", "wrong-error"])(
  "refuses %s data while joining owned cleanup",
  async (mode) => {
    const f = fixture(mode);
    if (mode === "wrong-error")
      await expect(
        withProjectLifecycleApi(f.input, (api) => api.remove(removeInput())),
      ).rejects.toThrow();
    else
      await expect(
        withProjectLifecycleApi(f.input, (api) =>
          api.removalPlan(
            Schema.decodeUnknownSync(WorktreeGetRemovalPlanInput)({
              projectId: "owned-project",
              threadId: "owned-workspace",
            }),
          ),
        ),
      ).rejects.toThrow();
    expect(f.result()).toEqual({ closed: 1, listeners: 0 });
  },
);
it("ignores a foreign response without losing the exact owned pending request", async () => {
  const f = fixture("foreign-then-valid");
  await withProjectLifecycleApi(f.input, (api) =>
    api.removalPlan(
      Schema.decodeUnknownSync(WorktreeGetRemovalPlanInput)({
        projectId: "owned-project",
        threadId: "owned-workspace",
      }),
    ),
  );
  expect(f.requests).toHaveLength(1);
  expect(f.result().closed).toBe(1);
});
it("never starts an absent clone through the attach port and refuses foreign targets before requests", async () => {
  const f = fixture();
  await withProjectLifecycleApi(f.input, async (api) => {
    for (const payload of [
      { url: f.input.cloneUrl, parentDir: f.input.cloneParent, attach: false },
      { url: f.input.cloneUrl, parentDir: "/owned/foreign", attach: true },
    ])
      await expect(
        api.attachClone(Schema.decodeUnknownSync(GitCloneInput)(payload)),
      ).rejects.toThrow();
    await expect(
      api.refreshStatus(Schema.decodeUnknownSync(VcsStatusInput)({ cwd: "/owned/foreign" })),
    ).rejects.toThrow();
    await expect(
      api.remove(
        Schema.decodeUnknownSync(WorktreeRemoveInput)({ ...removeInput(), threadId: "foreign" }),
      ),
    ).rejects.toThrow();
  });
  expect(f.requests).toHaveLength(0);
});
it("rejects pending waiters on callback failure, preserves the original and closes the socket", async () => {
  const f = fixture("hold"),
    original = new Error("Inert original callback failure.");
  let joined: Promise<unknown> | undefined;
  await expect(
    withProjectLifecycleApi(f.input, async (api) => {
      joined = api
        .attachClone(
          Schema.decodeUnknownSync(GitCloneInput)({
            url: f.input.cloneUrl,
            parentDir: f.input.cloneParent,
            attach: true,
          }),
        )
        .catch(() => "joined");
      await Promise.resolve();
      throw original;
    }),
  ).rejects.toBe(original);
  expect(await joined).toBe("joined");
  expect(f.input.observeUnsafeCleanup).toHaveBeenCalled();
  expect(f.result()).toEqual({ closed: 1, listeners: 0 });
});
it("refuses outside CI before every transport or target observation", async () => {
  const f = fixture();
  await expect(
    withProjectLifecycleApi({ ...f.input, CI: undefined }, async () => {}),
  ).rejects.toThrow();
  expect(f.fetches).toHaveLength(0);
  expect(f.input.verifyTarget).not.toHaveBeenCalled();
});

it("contains cleanup observation exceptions while rejecting waiters and retaining the original callback failure", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture("hold"),
      original = new Error("Inert original ownership failure.");
    f.input.observeUnsafeCleanup.mockImplementation(() => {
      throw new Error("Inert observer failure.");
    });
    let joined: Promise<unknown> | undefined;
    await expect(
      withProjectLifecycleApi(f.input, async (api) => {
        joined = api
          .attachClone(
            Schema.decodeUnknownSync(GitCloneInput)({
              url: f.input.cloneUrl,
              parentDir: f.input.cloneParent,
              attach: true,
            }),
          )
          .catch(() => "joined");
        await Promise.resolve();
        throw original;
      }),
    ).rejects.toBe(original);
    expect(await joined).toBe("joined");
    expect(f.result()).toEqual({ closed: 1, listeners: 0 });
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("joins the entire post-response target check before returning the original callback failure", async () => {
  const f = fixture(),
    original = new Error("Inert callback failed after a received response.");
  let arrive!: () => void,
    release!: () => void,
    calls = 0,
    settled = false;
  const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.input.verifyTarget.mockImplementation(async () => {
    if (++calls === 3) {
      arrive();
      await gate;
    }
  });
  let request: Promise<unknown> | undefined;
  const result = withProjectLifecycleApi(f.input, async (api) => {
    request = api.removalPlan(
      Schema.decodeUnknownSync(WorktreeGetRemovalPlanInput)({
        projectId: "owned-project",
        threadId: "owned-workspace",
      }),
    );
    void request.catch(() => {});
    await arrived;
    throw original;
  }).catch((error) => {
    settled = true;
    return error;
  });
  try {
    await arrived;
    for (let i = 0; i < 16; i++) await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    release();
  }
  expect(await result).toBe(original);
  await request;
  expect(f.input.observeUnsafeCleanup).toHaveBeenCalled();
  expect(f.result()).toEqual({ closed: 1, listeners: 0 });
});

it("removes all temporary open/error listeners when the owned socket never opens", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture("never-open"),
      run = withProjectLifecycleApi(f.input, async () => "unreachable").catch(() => "refused");
    await vi.runAllTimersAsync();
    expect(await run).toBe("refused");
    expect(f.result()).toEqual({ closed: 1, listeners: 0 });
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
