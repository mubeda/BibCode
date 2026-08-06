import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@bibcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  createResult: { _tag: "Success", value: undefined } as unknown,
  deleteResults: [] as unknown[],
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  addToast: vi.fn(),
  openChatPanel: vi.fn(),
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
      openChatPanel: h.openChatPanel,
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
  newThreadId: () => "new-panel-thread",
}));

vi.mock("~/state/threads", () => ({
  threadEnvironment: { create: "create", delete: "delete" },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "create" ? h.createThread : h.deleteThread),
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
  h.createThread.mockImplementation(() => Promise.resolve(h.createResult));
  h.deleteThread.mockImplementation(() =>
    Promise.resolve(h.deleteResults.shift() ?? { _tag: "Success", value: undefined }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("center panel actions", () => {
  it("creates chat panels with the resolved selection and copied workspace values", async () => {
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
    expect(h.createThread).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: expect.objectContaining({
        threadId: "new-panel-thread",
        title: "Panel — Codex",
        branch: "feature/panels",
        worktreePath: null,
        modelSelection,
        kind: "panel",
      }),
    });
    expect(h.createThread.mock.calls[0]?.[0].input.modelSelection).toBe(modelSelection);
    expect(h.openChatPanel).toHaveBeenCalledWith(hostRef, threadId, "Codex");

    await actions.createChatPanel({
      hostRef,
      projectId: ProjectId.make("project-1"),
      worktreePath: "/tmp/worktree",
      branch: null,
      modelSelection,
      providerLabel: "Codex",
    });
    expect(h.createThread).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ branch: null, worktreePath: "/tmp/worktree" }),
      }),
    );
  });

  it("returns null for interrupted creation and reports typed and untyped failures", async () => {
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
    await expect(actions.createChatPanel(input)).resolves.toBeNull();
    expect(h.addToast).not.toHaveBeenCalled();

    h.createResult = { _tag: "Failure", cause: new Error("server offline") };
    await expect(actions.createChatPanel(input)).resolves.toBeNull();
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
