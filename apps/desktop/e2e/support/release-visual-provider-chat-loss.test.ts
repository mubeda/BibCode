// @effect-diagnostics nodeBuiltinImport:off - Disposable TempGit and inert public snapshots only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import { OrchestrationThread } from "../../../../packages/contracts/src/orchestration.ts";
import * as Loss from "./release-visual-provider-chat-loss.ts";
import { readOwnedDeliveryWorktree } from "./delivery-retry-workspace.ts";
import { expect, it } from "vite-plus/test";

const Schema = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");

const api = Loss as unknown as {
  bindProviderChatWorkspaceLoss: (input: object, thread: object) => object;
  readProviderChatWorkspaceLoss: (scope: object, thread: object) => object;
  withProviderChatWorkspaceLoss: (
    input: object,
    run: (scope: object) => Promise<unknown>,
  ) => Promise<unknown>;
};
function fixture(primary = false, outside = false) {
  const temp = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-loss-")),
  );
  const root = NodePath.join(temp, "owned"),
    home = NodePath.join(root, "home"),
    project = NodePath.join(root, "primary"),
    worktree = NodePath.join(outside ? temp : root, "managed");
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(project, { mode: 0o700 });
  const branch = "codex/delivery-retry-light",
    git = "/usr/bin/git";
  const run = (args: string[]) =>
    NodeChildProcess.execFileSync(
      git,
      [
        "-C",
        project,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Owned Fixture",
        "-c",
        "user.email=fixture@example.test",
        ...args,
      ],
      {
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
  run(["init", "--initial-branch=" + (primary ? branch : "main")]);
  NodeFS.writeFileSync(NodePath.join(project, "owned.txt"), "owned\n");
  run(["add", "owned.txt"]);
  run(["commit", "-m", "owned"]);
  run(["worktree", "add", "-b", primary ? "codex/other" : branch, worktree]);
  const input = { root, home, project, git, branch };
  const thread: OrchestrationThread = Schema.decodeUnknownSync(OrchestrationThread)({
    id: "owned-thread",
    projectId: "owned-project",
    title: "Owned worktree",
    runtimeMode: "full-access",
    kind: "workspace",
    branch,
    worktreePath: worktree,
    deletedAt: null,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    latestTurn: null,
    messages: [],
    activities: [],
    checkpoints: [],
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    session: {
      threadId: "owned-thread",
      status: "ready",
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-10-05T00:00:00.000Z",
    },
  });
  return {
    root,
    project,
    worktree,
    input,
    thread,
    run,
    held: worktree + ".delivery-missing",
    close: () => NodeFS.rmSync(temp, { recursive: true, force: true }),
  };
}

it("admits only a separately bound registered managed loss and keeps ordinary identity strict", () => {
  expect(api.bindProviderChatWorkspaceLoss).toBeTypeOf("function");
  const f = fixture();
  try {
    expect(Object.hasOwn(f.thread.modelSelection, "provider")).toBe(false);
    expect(f.thread.modelSelection.instanceId).toBe("codex");
    const scope = api.bindProviderChatWorkspaceLoss(f.input, { host: f.thread, target: f.thread });
    expect(() =>
      api.readProviderChatWorkspaceLoss(scope, { host: f.thread, target: f.thread }),
    ).toThrow("Owned provider workspace loss refused.");
    NodeFS.renameSync(f.worktree, f.held);
    expect(() => readOwnedDeliveryWorktree(f.input)).toThrow(
      "Owned delivery worktree identity refused.",
    );
    expect(api.readProviderChatWorkspaceLoss(scope, { host: f.thread, target: f.thread })).toEqual({
      registeredManagedLoss: true,
      originalAbsent: true,
      renamedIdentityMatched: true,
      primaryAnchorsRetained: true,
      threadProviderMatched: true,
    });
    expect(() =>
      api.readProviderChatWorkspaceLoss({ ...scope }, { host: f.thread, target: f.thread }),
    ).toThrow();
  } finally {
    f.close();
  }
});

it("joins a genuinely decoded host workspace and owned Codex panel on the same managed path", () => {
  const f = fixture();
  try {
    const host: OrchestrationThread = Schema.decodeUnknownSync(OrchestrationThread)({
      ...f.thread,
      modelSelection: { instanceId: "claudeAgent", model: "opus" },
      session: {
        ...f.thread.session,
        providerName: "claudeAgent",
        providerInstanceId: "claudeAgent",
      },
    });
    const target: OrchestrationThread = Schema.decodeUnknownSync(OrchestrationThread)({
      ...f.thread,
      id: "owned-panel",
      kind: "panel",
      session: { ...f.thread.session, threadId: "owned-panel" },
    });
    const binding = { host, target };
    const scope = api.bindProviderChatWorkspaceLoss(f.input, binding);
    NodeFS.renameSync(f.worktree, f.held);
    expect(api.readProviderChatWorkspaceLoss(scope, binding)).toMatchObject({
      threadProviderMatched: true,
      registeredManagedLoss: true,
    });
    expect(() =>
      api.readProviderChatWorkspaceLoss(scope, {
        host,
        target: { ...target, projectId: "foreign-project" },
      }),
    ).toThrow("Owned provider workspace loss refused.");
  } finally {
    f.close();
  }
});

it.each(["primary", "outside", "symlink", "foreign-thread", "foreign-provider"])(
  "refuses unsafe loss admission before rename: %s",
  (mode) => {
    expect(api.bindProviderChatWorkspaceLoss).toBeTypeOf("function");
    const f = fixture(mode === "primary", mode === "outside");
    try {
      if (mode === "symlink") {
        NodeFS.renameSync(f.worktree, f.held);
        NodeFS.symlinkSync(f.held, f.worktree);
      }
      const thread = {
        ...f.thread,
        ...(mode === "foreign-thread" ? { worktreePath: f.project } : {}),
        ...(mode === "foreign-provider"
          ? { session: { providerName: "claudeAgent", providerInstanceId: "claudeAgent" } }
          : {}),
      };
      expect(() =>
        api.bindProviderChatWorkspaceLoss(f.input, { host: f.thread, target: thread }),
      ).toThrow("Owned provider workspace loss refused.");
    } finally {
      f.close();
    }
  },
);

it.each([
  "replacement",
  "symlink",
  "registration",
  "common",
  "restored",
  "foreign-thread",
  "foreign-provider",
])("refuses changed loss proof: %s", (mode) => {
  expect(api.bindProviderChatWorkspaceLoss).toBeTypeOf("function");
  const f = fixture();
  try {
    const scope = api.bindProviderChatWorkspaceLoss(f.input, { host: f.thread, target: f.thread });
    NodeFS.renameSync(f.worktree, f.held);
    if (mode === "replacement") {
      NodeFS.renameSync(f.held, f.held + ".retained");
      NodeFS.mkdirSync(f.held);
    }
    if (mode === "symlink") {
      NodeFS.renameSync(f.held, f.held + ".retained");
      NodeFS.symlinkSync(f.held + ".retained", f.held);
    }
    if (mode === "registration") f.run(["worktree", "prune"]);
    if (mode === "common")
      NodeFS.renameSync(
        NodePath.join(f.project, ".git"),
        NodePath.join(f.project, ".git-replaced"),
      );
    if (mode === "restored") NodeFS.renameSync(f.held, f.worktree);
    const thread = {
      ...f.thread,
      ...(mode === "foreign-thread" ? { id: "foreign" } : {}),
      ...(mode === "foreign-provider"
        ? { session: { providerName: "claudeAgent", providerInstanceId: "claudeAgent" } }
        : {}),
    };
    expect(() =>
      api.readProviderChatWorkspaceLoss(scope, { host: f.thread, target: thread }),
    ).toThrow("Owned provider workspace loss refused.");
  } finally {
    f.close();
  }
});

it.each([false, true])(
  "restores the exact directory, preserves the original body error and records unsafe restoration: %s",
  async (unsafe) => {
    expect(api.withProviderChatWorkspaceLoss).toBeTypeOf("function");
    const f = fixture();
    const original = new Error("Inert original capture refusal.");
    let observations = 0;
    try {
      await expect(
        api.withProviderChatWorkspaceLoss(
          {
            worktree: f.input,
            readBinding: async () => ({ host: f.thread, target: f.thread }),
            observeUnsafeCleanup: () => {
              observations++;
            },
          },
          async (scope) => {
            expect(
              api.readProviderChatWorkspaceLoss(scope, { host: f.thread, target: f.thread }),
            ).toMatchObject({
              originalAbsent: true,
            });
            if (unsafe) NodeFS.mkdirSync(f.worktree);
            throw original;
          },
        ),
      ).rejects.toBe(original);
      expect(observations).toBe(unsafe ? 1 : 0);
      if (unsafe) expect(NodeFS.existsSync(f.held)).toBe(true);
      else expect(readOwnedDeliveryWorktree(f.input).path).toBe(f.worktree);
    } finally {
      f.close();
    }
  },
);

it("fails a successful capture if restoration cannot prove ordinary identity", async () => {
  expect(api.withProviderChatWorkspaceLoss).toBeTypeOf("function");
  const f = fixture();
  let unsafe = false;
  try {
    await expect(
      api.withProviderChatWorkspaceLoss(
        {
          worktree: f.input,
          readBinding: async () => ({ host: f.thread, target: f.thread }),
          observeUnsafeCleanup: () => {
            unsafe = true;
          },
        },
        async () => {
          NodeFS.mkdirSync(f.worktree);
        },
      ),
    ).rejects.toThrow("Owned provider workspace loss refused.");
    expect(unsafe).toBe(true);
  } finally {
    f.close();
  }
});
