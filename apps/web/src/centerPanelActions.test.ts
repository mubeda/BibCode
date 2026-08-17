import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@bibcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  createResult: { _tag: "Success", value: undefined } as unknown,
  deleteResults: [] as unknown[],
  createPanel: vi.fn(),
  deleteThread: vi.fn(),
  addToast: vi.fn(),
  reserveChatPanel: vi.fn(),
  releaseChatPanelReservation: vi.fn(),
  removeThread: vi.fn(),
  activateSurface: vi.fn(),
  closeSurface: vi.fn(),
  closeOtherSurfaces: vi.fn(),
  closeSurfacesToRight: vi.fn(),
  closeAllSurfaces: vi.fn(),
  dropSurface: vi.fn(),
  mergeGroup: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
}));

vi.mock("@bibcode/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: { interrupted?: boolean }) => result.interrupted === true,
  squashAtomCommandFailure: (result: { cause?: unknown }) => result.cause,
}));

vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: h.addToast },
}));

vi.mock("~/centerPanelStore", () => ({
  HOST_SURFACE_ID: "host",
  useCenterPanelStore: {
    getState: () => ({
      reserveChatPanel: h.reserveChatPanel,
      releaseChatPanelReservation: h.releaseChatPanelReservation,
      removeThread: h.removeThread,
      activateSurface: h.activateSurface,
      closeSurface: h.closeSurface,
      closeOtherSurfaces: h.closeOtherSurfaces,
      closeSurfacesToRight: h.closeSurfacesToRight,
      closeAllSurfaces: h.closeAllSurfaces,
      dropSurface: h.dropSurface,
      mergeGroup: h.mergeGroup,
    }),
  },
}));

vi.mock("~/lib/utils", () => ({
  newCommandId: () => "command-panel-create",
  newThreadId: () => "new-panel-thread",
}));

vi.mock("~/state/threads", () => ({
  threadEnvironment: { delete: "delete" },
}));

vi.mock("~/state/worktrees", () => ({
  worktreeEnvironment: { createPanel: "create-panel" },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "create-panel" ? h.createPanel : h.deleteThread,
}));

import { useCenterPanelActions } from "./centerPanelActions";
import { useCenterPanelStore } from "~/centerPanelStore";

const hostRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("host-thread"),
};

const onCloseTerminal = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  h.createResult = { _tag: "Success", value: undefined };
  h.deleteResults = [];
  h.createPanel.mockImplementation(() => Promise.resolve(h.createResult));
  h.deleteThread.mockImplementation(() =>
    Promise.resolve(h.deleteResults.shift() ?? { _tag: "Success", value: undefined }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("center panel actions", () => {
  it("registers a reserved chat panel before the server command settles", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    let resolveCreatePanel!: (value: unknown) => void;
    const createPanelResult = new Promise<unknown>((resolve) => {
      resolveCreatePanel = resolve;
    });
    h.createPanel.mockReturnValueOnce(createPanelResult);

    const creation = actions.createChatPanel({
      hostRef,
      projectId: ProjectId.make("project-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("cursor"),
        model: "cursor-fixture",
      },
      providerLabel: "Cursor",
    });

    expect(h.reserveChatPanel).toHaveBeenCalledWith(hostRef, "new-panel-thread", "Cursor");
    resolveCreatePanel({ _tag: "Success", value: undefined });
    await expect(creation).resolves.toBe("new-panel-thread");
    expect(h.removeThread).not.toHaveBeenCalled();
  });

  it("creates chat panels through the server-resolved panel API", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    };
    const threadId = await actions.createChatPanel({
      hostRef,
      projectId: ProjectId.make("project-1"),
      worktreePath: "",
      branch: "feature/panels",
      modelSelection,
      providerLabel: "Codex",
    });

    expect(threadId).toBe("new-panel-thread");
    expect(h.createPanel).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: {
        commandId: "command-panel-create",
        hostThreadId: hostRef.threadId,
        threadId: "new-panel-thread",
        title: "Panel — Codex",
        threadDefaults: {
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      },
    });
    expect(h.createPanel.mock.calls[0]?.[0].input.threadDefaults.modelSelection).toBe(
      modelSelection,
    );
    expect(h.createPanel.mock.calls[0]?.[0].input).not.toHaveProperty("projectId");
    expect(h.createPanel.mock.calls[0]?.[0].input).not.toHaveProperty("worktreePath");
    expect(h.createPanel.mock.calls[0]?.[0].input).not.toHaveProperty("branch");
    expect(h.createPanel.mock.calls[0]?.[0].input).not.toHaveProperty("kind");
    expect(h.reserveChatPanel).toHaveBeenCalledWith(hostRef, threadId, "Codex");

    await actions.createChatPanel({
      hostRef,
      projectId: ProjectId.make("project-1"),
      worktreePath: "/tmp/worktree",
      branch: null,
      modelSelection,
      providerLabel: "Codex",
    });
    expect(h.createPanel).toHaveBeenCalledTimes(2);
    expect(h.createPanel.mock.calls[1]?.[0].input).toEqual(h.createPanel.mock.calls[0]?.[0].input);
  });

  it("retains ambiguous interrupted creation and rolls back explicit failures", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    const input = {
      hostRef,
      projectId: ProjectId.make("project-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex-instance"),
        model: "gpt-5.4",
      },
      providerLabel: "Codex",
    };

    h.createResult = { _tag: "Failure", interrupted: true, cause: new Error("cancelled") };
    await expect(actions.createChatPanel(input)).resolves.toBe("new-panel-thread");
    expect(h.addToast).not.toHaveBeenCalled();
    expect(h.removeThread).not.toHaveBeenCalled();

    h.createResult = { _tag: "Failure", cause: new Error("server offline") };
    await expect(actions.createChatPanel(input)).resolves.toBeNull();
    expect(h.removeThread).toHaveBeenLastCalledWith({
      environmentId: hostRef.environmentId,
      threadId: "new-panel-thread",
    });
    expect(h.addToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "server offline" }),
    );

    h.createResult = { _tag: "Failure", cause: "unknown" };
    await expect(actions.createChatPanel(input)).resolves.toBeNull();
    expect(h.addToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "An error occurred." }),
    );
  });

  it("activates and closes individual surfaces within the selected group", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    actions.activateSurface(hostRef, "group-left", "terminal:term-2");
    expect(h.activateSurface).toHaveBeenCalledWith(hostRef, "group-left", "terminal:term-2");

    const terminal = {
      id: "terminal:term-2",
      kind: "terminal",
      terminalId: "term-2",
    } as const;
    h.closeSurface.mockReturnValueOnce([terminal]);
    actions.closeSurface(hostRef, "group-left", terminal);
    expect(h.deleteThread).not.toHaveBeenCalled();
    expect(onCloseTerminal).toHaveBeenCalledWith(hostRef, terminal);

    const chat = {
      id: "chat:panel-1",
      kind: "chat",
      threadId: ThreadId.make("panel-1"),
    } as const;
    h.closeSurface.mockReturnValueOnce([chat]);
    actions.closeSurface(hostRef, "group-left", chat);
    await Promise.resolve();
    expect(h.closeSurface).toHaveBeenLastCalledWith(hostRef, "group-left", chat.id);
    expect(h.deleteThread).toHaveBeenCalledOnce();
  });

  it("cleans up only the exact surfaces removed from the selected group", async () => {
    const chatSurface = {
      id: "chat:panel-1",
      kind: "chat",
      threadId: ThreadId.make("panel-1"),
    } as const;
    const removedChat = {
      id: "chat:panel-2",
      kind: "chat",
      threadId: ThreadId.make("panel-2"),
    } as const;
    const removedTerminal = {
      id: "terminal:term-1",
      kind: "terminal",
      terminalId: "term-1",
    } as const;
    const terminalInOtherGroup = {
      id: "terminal:term-2",
      kind: "terminal",
      terminalId: "term-2",
    } as const;
    h.closeOtherSurfaces.mockReturnValueOnce([removedChat, removedTerminal]);
    const actions = useCenterPanelActions({ onCloseTerminal });

    actions.closeOtherSurfaces(hostRef, "group-right", chatSurface);
    await Promise.resolve();
    expect(h.deleteThread).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: { threadId: removedChat.threadId },
    });
    expect(onCloseTerminal).toHaveBeenCalledWith(hostRef, removedTerminal);
    expect(onCloseTerminal).not.toHaveBeenCalledWith(hostRef, terminalInOtherGroup);

    h.deleteThread.mockClear();
    h.closeSurfacesToRight.mockReturnValueOnce([removedChat]);
    actions.closeSurfacesToRight(hostRef, "group-right", chatSurface);
    await Promise.resolve();
    expect(h.deleteThread).toHaveBeenCalledOnce();

    h.deleteThread.mockClear();
    h.closeSurfacesToRight.mockReturnValueOnce([]);
    actions.closeSurfacesToRight(hostRef, "group-right", terminalInOtherGroup);
    expect(h.deleteThread).not.toHaveBeenCalled();

    h.closeAllSurfaces.mockReturnValueOnce([chatSurface, removedChat]);
    actions.closeAllSurfaces(hostRef, "group-right");
    await Promise.resolve();
    expect(h.deleteThread).toHaveBeenCalledTimes(2);
  });

  it("does not clean up surfaces during layout-only drop and merge operations", () => {
    const terminal = {
      id: "terminal:term-1",
      kind: "terminal",
      terminalId: "term-1",
    } as const;
    useCenterPanelStore.getState().dropSurface(hostRef, terminal.id, {
      groupId: "group-right",
      index: 0,
    });
    useCenterPanelStore.getState().mergeGroup(hostRef, "group-right");

    expect(h.deleteThread).not.toHaveBeenCalled();
    expect(onCloseTerminal).not.toHaveBeenCalled();
  });

  it("reports non-interrupted panel deletion failures", async () => {
    h.deleteResults = [
      { _tag: "Failure", interrupted: true, cause: new Error("cancelled") },
      { _tag: "Failure", cause: new Error("delete failed") },
      { _tag: "Failure", cause: "unknown" },
    ];
    const actions = useCenterPanelActions({ onCloseTerminal });
    const surface = {
      id: "chat:panel-1",
      kind: "chat",
      threadId: ThreadId.make("panel-1"),
    } as never;

    h.closeSurface.mockReturnValue([surface]);
    actions.closeSurface(hostRef, "group-left", surface);
    actions.closeSurface(hostRef, "group-left", surface);
    actions.closeSurface(hostRef, "group-left", surface);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.addToast).toHaveBeenCalledTimes(2);
    expect(h.addToast).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ description: "delete failed" }),
    );
    expect(h.addToast).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ description: "An error occurred." }),
    );
  });
});
