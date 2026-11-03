import {
  AgentSessionsError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@bibcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  createResult: { _tag: "Success", value: undefined } as unknown,
  archiveResults: [] as unknown[],
  unarchiveResult: { _tag: "Success", value: undefined } as unknown,
  shells: new Map<string, unknown>(),
  createPanel: vi.fn(),
  archiveThread: vi.fn(),
  unarchiveThread: vi.fn(),
  interruptTurn: vi.fn(),
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
  openChatPanel: vi.fn(),
  openInPanel: vi.fn(),
  openInPanelResult: { _tag: "Success", value: undefined } as unknown,
  newCommandId: vi.fn(),
  startTurn: vi.fn(),
  pending: new Set<string>(),
  creating: new Set<string>(),
  closed: [] as Array<{ key: string; closeId: string; liveAt?: number; archivedAt?: number }>,
  drafts: new Map<string, { prompt: string; attachments: unknown[] }>(),
}));

const emptyDraft = {
  attachments: [],
  terminalContexts: [],
  elementContexts: [],
  previewAnnotations: [],
  reviewComments: [],
};

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: (ref: { threadId: string }) => {
        const draft = h.drafts.get(ref.threadId);
        return draft ? { ...emptyDraft, ...draft } : null;
      },
      setPrompt: (ref: { threadId: string }, prompt: string) => {
        h.drafts.set(ref.threadId, { attachments: [], ...h.drafts.get(ref.threadId), prompt });
      },
    }),
  },
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
      openChatPanel: h.openChatPanel,
      pendingChatPanelThreadKeys: h.pending,
      creatingChatPanelThreadKeys: h.creating,
      beginChatPanelCreation: (ref: { environmentId: string; threadId: string }) =>
        h.creating.add(`${ref.environmentId}:${ref.threadId}`),
      endChatPanelCreation: (ref: { environmentId: string; threadId: string }) =>
        h.creating.delete(`${ref.environmentId}:${ref.threadId}`),
      closingChatPanels: h.closed,
      recordChatPanelClose: (ref: { environmentId: string; threadId: string }) => {
        const key = `${ref.environmentId}:${ref.threadId}`;
        const index = h.closed.findIndex((intent) => intent.key === key);
        if (index >= 0) h.closed.splice(index, 1);
        const closeId = `close-${h.closed.length + 1}`;
        h.closed.push({ key, closeId });
        return closeId;
      },
      updateChatPanelClose: (
        ref: { environmentId: string; threadId: string },
        closeId: string,
        patch: object,
      ) => {
        const intent = h.closed.find(
          (candidate) =>
            candidate.key === `${ref.environmentId}:${ref.threadId}` &&
            candidate.closeId === closeId,
        );
        if (intent) Object.assign(intent, patch);
      },
      clearChatPanelClose: (ref: { environmentId: string; threadId: string }) => {
        const index = h.closed.findIndex(
          (intent) => intent.key === `${ref.environmentId}:${ref.threadId}`,
        );
        if (index >= 0) h.closed.splice(index, 1);
      },
    }),
  },
}));

vi.mock("@bibcode/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
  scopedThreadKey: (ref: { environmentId: string; threadId: string }) =>
    `${ref.environmentId}:${ref.threadId}`,
  parseScopedThreadKey: (key: string) => {
    const [environmentId, threadId] = key.split(":");
    return environmentId && threadId ? { environmentId, threadId } : null;
  },
}));

vi.mock("~/state/projects", () => ({
  projectEnvironment: { openAgentSessionInPanel: "open-in-panel" },
}));

vi.mock("~/lib/utils", () => ({
  newCommandId: () => h.newCommandId(),
  newMessageId: () => "side-question",
  newThreadId: () => "new-panel-thread",
}));

vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    archive: "archive",
    unarchive: "unarchive",
    interruptTurn: "interrupt",
    startTurn: "start-turn",
  },
}));

vi.mock("~/state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) => h.shells.get(ref.threadId) ?? null,
}));

vi.mock("~/state/worktrees", () => ({
  worktreeEnvironment: { createPanel: "create-panel" },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    ({
      "create-panel": h.createPanel,
      archive: h.archiveThread,
      unarchive: h.unarchiveThread,
      interrupt: h.interruptTurn,
      "open-in-panel": h.openInPanel,
      "start-turn": h.startTurn,
    })[command],
}));

import { takeComposerFocusRequest, useCenterPanelActions } from "./centerPanelActions";
import { useCenterPanelStore } from "~/centerPanelStore";

const hostRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("host-thread"),
};

const onCloseTerminal = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  h.createResult = { _tag: "Success", value: undefined };
  h.archiveResults = [];
  h.unarchiveResult = { _tag: "Success", value: undefined };
  h.shells.clear();
  h.createPanel.mockImplementation(() => Promise.resolve(h.createResult));
  h.archiveThread.mockImplementation(() =>
    Promise.resolve(h.archiveResults.shift() ?? { _tag: "Success", value: { sequence: 1 } }),
  );
  h.unarchiveThread.mockImplementation(() => Promise.resolve(h.unarchiveResult));
  h.openInPanelResult = { _tag: "Success", value: undefined };
  h.openInPanel.mockImplementation(() => Promise.resolve(h.openInPanelResult));
  h.newCommandId.mockImplementation(() => "command-panel-create");
  h.interruptTurn.mockImplementation(() =>
    Promise.resolve({ _tag: "Failure", cause: new Error("no running turn") }),
  );
  h.pending.clear();
  h.creating.clear();
  h.closed.length = 0;
  h.drafts.clear();
  h.reserveChatPanel.mockImplementation((_host: unknown, threadId: string) =>
    h.pending.add(`${hostRef.environmentId}:${threadId}`),
  );
  h.releaseChatPanelReservation.mockImplementation((ref: { threadId: string }) =>
    h.pending.delete(`${hostRef.environmentId}:${ref.threadId}`),
  );
  h.startTurn.mockImplementation(() => Promise.resolve({ _tag: "Success", value: undefined }));
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
        title: "Panel: Codex",
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
    expect(h.archiveThread).not.toHaveBeenCalled();
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
    expect(h.archiveThread).toHaveBeenCalledOnce();
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
    await flush();
    expect(h.archiveThread).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: { threadId: removedChat.threadId },
    });
    expect(onCloseTerminal).toHaveBeenCalledWith(hostRef, removedTerminal);
    expect(onCloseTerminal).not.toHaveBeenCalledWith(hostRef, terminalInOtherGroup);

    h.archiveThread.mockClear();
    h.closeSurfacesToRight.mockReturnValueOnce([removedChat]);
    actions.closeSurfacesToRight(hostRef, "group-right", chatSurface);
    await flush();
    expect(h.archiveThread).toHaveBeenCalledOnce();

    h.archiveThread.mockClear();
    h.closeSurfacesToRight.mockReturnValueOnce([]);
    actions.closeSurfacesToRight(hostRef, "group-right", terminalInOtherGroup);
    expect(h.archiveThread).not.toHaveBeenCalled();

    h.closeAllSurfaces.mockReturnValueOnce([chatSurface, removedChat]);
    actions.closeAllSurfaces(hostRef, "group-right");
    await flush();
    expect(h.archiveThread).toHaveBeenCalledTimes(2);
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

    expect(h.archiveThread).not.toHaveBeenCalled();
    expect(onCloseTerminal).not.toHaveBeenCalled();
  });

  it("reports non-interrupted panel archive failures", async () => {
    h.archiveResults = [
      { _tag: "Failure", interrupted: true, cause: new Error("cancelled") },
      { _tag: "Failure", cause: new Error("archive failed") },
      { _tag: "Failure", cause: "unknown" },
    ];
    const actions = useCenterPanelActions({ onCloseTerminal });
    for (const index of [1, 2, 3]) {
      const threadId = ThreadId.make(`panel-${index}`);
      // A panel this page knows to be live; a not yet created one is archived when it shows.
      h.shells.set(threadId, { archivedAt: null, session: null });
      const surface = { id: `chat:${threadId}`, kind: "chat", threadId } as never;
      h.closeSurface.mockReturnValueOnce([surface]);
      actions.closeSurface(hostRef, "group-left", surface);
    }
    await flush();

    expect(h.addToast).toHaveBeenCalledTimes(2);
    expect(h.addToast).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: "Failed to close chat panel",
        description: "archive failed",
      }),
    );
    expect(h.addToast).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ description: "An error occurred." }),
    );
  });
  it("interrupts a running panel turn before archiving it, even when the interrupt fails", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    const running = { id: "chat:panel-run", kind: "chat", threadId: ThreadId.make("panel-run") };
    const idle = { id: "chat:panel-idle", kind: "chat", threadId: ThreadId.make("panel-idle") };
    h.shells.set("panel-run", { session: { status: "running", activeTurnId: "turn-1" } });
    h.shells.set("panel-idle", { session: { status: "ready", activeTurnId: null } });

    h.closeSurface.mockReturnValueOnce([running, idle]);
    actions.closeSurface(hostRef, "group-left", running as never);
    await flush();

    expect(h.interruptTurn).toHaveBeenCalledOnce();
    expect(h.interruptTurn).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: { threadId: "panel-run", turnId: "turn-1" },
    });
    expect(h.archiveThread).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: { threadId: "panel-run" },
    });
    expect(h.archiveThread).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: { threadId: "panel-idle" },
    });
    const archiveRunOrder =
      h.archiveThread.mock.invocationCallOrder[
        h.archiveThread.mock.calls.findIndex(([call]) => call.input.threadId === "panel-run")
      ]!;
    expect(h.interruptTurn.mock.invocationCallOrder[0]).toBeLessThan(archiveRunOrder);
    expect(h.addToast).not.toHaveBeenCalled();
  });

  it("forgets a close when the panel is reopened, so nothing archives it again", async () => {
    h.closed.push({ key: `${hostRef.environmentId}:panel-1`, closeId: "close-1", archivedAt: 3 });
    const actions = useCenterPanelActions({ onCloseTerminal });
    await actions.reopenChatPanel(hostRef, ThreadId.make("panel-1"), "Codex");
    expect(h.closed).toEqual([]);
  });

  it("reopens a closed chat panel as the active tab and rolls back explicit failures", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    const panelId = ThreadId.make("panel-closed");
    const panelRef = { environmentId: hostRef.environmentId, threadId: panelId };

    await actions.reopenChatPanel(hostRef, panelId, "Claude");
    expect(h.reserveChatPanel).toHaveBeenCalledWith(hostRef, panelId, "Claude");
    expect(h.reserveChatPanel.mock.invocationCallOrder[0]).toBeLessThan(
      h.unarchiveThread.mock.invocationCallOrder[0]!,
    );
    expect(h.unarchiveThread).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: { threadId: panelId },
    });
    expect(h.removeThread).not.toHaveBeenCalled();

    h.unarchiveResult = { _tag: "Failure", interrupted: true, cause: new Error("cancelled") };
    await actions.reopenChatPanel(hostRef, panelId, "Claude");
    expect(h.removeThread).not.toHaveBeenCalled();
    expect(h.addToast).not.toHaveBeenCalled();

    h.unarchiveResult = { _tag: "Failure", cause: new Error("server offline") };
    await actions.reopenChatPanel(hostRef, panelId, "Claude");
    expect(h.removeThread).toHaveBeenCalledWith(panelRef);
    expect(h.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to reopen chat panel",
        description: "server offline",
      }),
    );
  });

  it("keeps the tab when another client reopened the panel first", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    const panelId = ThreadId.make("panel-reopened-elsewhere");
    const panelRef = { environmentId: hostRef.environmentId, threadId: panelId };
    // The other client's unarchive already made the panel live here.
    h.shells.set(panelId, { session: null, archivedAt: null });
    h.unarchiveResult = { _tag: "Failure", cause: new Error("Thread is not archived.") };

    await actions.reopenChatPanel(hostRef, panelId, "Claude");

    expect(h.removeThread).not.toHaveBeenCalled();
    expect(h.releaseChatPanelReservation).toHaveBeenCalledWith(panelRef);
    expect(h.addToast).not.toHaveBeenCalled();
  });

  it("continues a terminal session in a panel of the host and makes it the active tab", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    const opened = {
      threadId: ThreadId.make("import:claudeAgent:session-1"),
      hostThreadId: hostRef.threadId,
      outcome: "created",
    };
    h.openInPanelResult = { _tag: "Success", value: opened };

    await expect(
      actions.openSessionPanel(hostRef, {
        sessionId: "session-1",
        mode: "resume",
        title: "Flaky test",
      }),
    ).resolves.toEqual(opened);
    expect(h.openInPanel).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: {
        commandId: "command-panel-create",
        hostThreadId: hostRef.threadId,
        sessionId: "session-1",
        mode: "resume",
      },
    });
    expect(h.openChatPanel).toHaveBeenCalledWith(hostRef, opened.threadId, "Flaky test");
    expect(h.unarchiveThread).not.toHaveBeenCalled();
  });

  it("reopens an existing closed panel of the host and leaves other threads to the caller", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    const closed = ThreadId.make("import:claudeAgent:session-2");
    h.shells.set(closed, { archivedAt: "2026-10-20T10:00:00.000Z" });
    h.openInPanelResult = {
      _tag: "Success",
      value: { threadId: closed, hostThreadId: hostRef.threadId, outcome: "existing" },
    };
    await actions.openSessionPanel(hostRef, {
      sessionId: "session-2",
      mode: "resume",
      title: "Old",
    });
    expect(h.reserveChatPanel).toHaveBeenCalledWith(hostRef, closed, "Old");
    expect(h.unarchiveThread).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: { threadId: closed },
    });

    vi.clearAllMocks();
    const elsewhere = {
      threadId: ThreadId.make("import:claudeAgent:session-3"),
      hostThreadId: null,
      outcome: "existing",
    };
    h.openInPanel.mockResolvedValueOnce({ _tag: "Success", value: elsewhere });
    await expect(
      actions.openSessionPanel(hostRef, { sessionId: "session-3", mode: "resume", title: "Side" }),
    ).resolves.toEqual(elsewhere);
    expect(h.openChatPanel).not.toHaveBeenCalled();
    expect(h.reserveChatPanel).not.toHaveBeenCalled();
  });

  it("shows why a session did not open and resolves nothing", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    h.openInPanelResult = {
      _tag: "Failure",
      cause: new Error("This session is open in a terminal. Choose Continue in a copy."),
    };
    await expect(
      actions.openSessionPanel(hostRef, { sessionId: "session-4", mode: "resume", title: "Live" }),
    ).resolves.toBeNull();
    expect(h.addToast).toHaveBeenCalledWith({
      type: "error",
      title: "Couldn't open the session",
      description: "This session is open in a terminal. Choose Continue in a copy.",
    });
    expect(h.openChatPanel).not.toHaveBeenCalled();
  });

  it("retries an open whose outcome is unknown under its command, so one copy is made", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    let next = 0;
    h.newCommandId.mockImplementation(() => `command-${++next}`);
    const open = () =>
      actions.openSessionPanel(hostRef, { sessionId: "session-5", mode: "fork", title: "Copy" });

    // The connection dropped before the answer, by interruption or by a transport failure.
    h.openInPanelResult = { _tag: "Failure", interrupted: true };
    await open();
    h.openInPanelResult = { _tag: "Failure", cause: new Error("The connection closed.") };
    await open();
    h.openInPanelResult = {
      _tag: "Success",
      value: {
        threadId: ThreadId.make("copy:claudeAgent:fork-1"),
        hostThreadId: hostRef.threadId,
        outcome: "existing",
      },
    };
    await open();
    // Settled: the next Continue in a copy is another copy.
    await open();
    expect(
      h.openInPanel.mock.calls.map(([call]) => (call as { input: { commandId: string } }).input),
    ).toEqual(
      ["command-1", "command-1", "command-1", "command-2"].map((commandId) => ({
        commandId,
        hostThreadId: hostRef.threadId,
        sessionId: "session-5",
        mode: "fork",
      })),
    );
  });

  it("sends a new command after the server refuses an open", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    let next = 0;
    h.newCommandId.mockImplementation(() => `command-${++next}`);
    h.openInPanelResult = {
      _tag: "Failure",
      cause: new AgentSessionsError({ message: "This copy's chat was deleted." }),
    };
    const open = () =>
      actions.openSessionPanel(hostRef, { sessionId: "session-6", mode: "fork", title: "Copy" });
    await open();
    await open();
    expect(
      h.openInPanel.mock.calls.map(
        ([call]) => (call as { input: { commandId: string } }).input.commandId,
      ),
    ).toEqual(["command-1", "command-2"]);
  });

  it("activates a live panel thread and reopens a closed one", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    const live = ThreadId.make("live-panel");
    h.shells.set(live, { archivedAt: null });
    await actions.openPanelThread(hostRef, live, "Live");
    expect(h.openChatPanel).toHaveBeenCalledWith(hostRef, live, "Live");
    expect(h.unarchiveThread).not.toHaveBeenCalled();
    await actions.openPanelThread(hostRef, live, "Live", true);
    expect(h.unarchiveThread).toHaveBeenCalledTimes(1);
  });
});

describe("side chats", () => {
  const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
  const question = "why did you pick that file?";
  const submittedText = `:btw ${question}`;
  const sideChat = (overrides: { submittedText?: string; question?: string } = {}) => ({
    hostRef,
    projectId: ProjectId.make("project-1"),
    modelSelection: codex,
    providerLabel: "Codex",
    question,
    submittedText,
    ...overrides,
  });
  const panelRef = { environmentId: hostRef.environmentId, threadId: "new-panel-thread" };

  it("creates a side chat in approval-required on the host's model and sends the question", async () => {
    h.drafts.set(hostRef.threadId, { prompt: submittedText, attachments: [] });
    const actions = useCenterPanelActions({ onCloseTerminal });

    await expect(actions.createSideChat(sideChat())).resolves.toBe("new-panel-thread");

    expect(h.createPanel).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: {
        commandId: "command-panel-create",
        hostThreadId: hostRef.threadId,
        threadId: "new-panel-thread",
        title: "Panel: Side chat · Codex",
        threadDefaults: {
          modelSelection: codex,
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        sideChat: true,
      },
    });
    expect(h.reserveChatPanel).toHaveBeenCalledWith(
      hostRef,
      "new-panel-thread",
      "Side chat · Codex",
    );
    expect(h.startTurn).toHaveBeenCalledWith({
      environmentId: hostRef.environmentId,
      input: {
        threadId: "new-panel-thread",
        message: { messageId: "side-question", role: "user", text: question, attachments: [] },
        modelSelection: codex,
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    });
    // Nothing reaches the host, and its `:btw` text is cleared once handed over.
    expect(h.drafts.get(hostRef.threadId)?.prompt).toBe("");
    expect(h.drafts.has("new-panel-thread")).toBe(false);
  });

  it("keeps the question in the host draft until creation succeeds", async () => {
    h.drafts.set(hostRef.threadId, { prompt: submittedText, attachments: [] });
    const creation = deferred<unknown>();
    h.createPanel.mockReturnValueOnce(creation.promise);
    const actions = useCenterPanelActions({ onCloseTerminal });

    const opening = actions.createSideChat(sideChat());
    await flush();
    // A reload now finds the text in the host's persisted draft.
    expect(h.drafts.get(hostRef.threadId)?.prompt).toBe(submittedText);
    // A second Enter on the same `:btw` opens nothing more.
    await expect(actions.createSideChat(sideChat())).resolves.toBeNull();
    expect(h.createPanel).toHaveBeenCalledOnce();

    creation.resolve({ _tag: "Success", value: undefined });
    await opening;
    expect(h.drafts.get(hostRef.threadId)?.prompt).toBe("");
  });

  it("leaves the host draft untouched when creation fails", async () => {
    h.drafts.set(hostRef.threadId, { prompt: submittedText, attachments: [] });
    h.createResult = { _tag: "Failure", cause: new Error("Host thread is deleted.") };
    const actions = useCenterPanelActions({ onCloseTerminal });

    await expect(actions.createSideChat(sideChat())).resolves.toBeNull();

    expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.drafts.get(hostRef.threadId)?.prompt).toBe(submittedText);
    expect(h.removeThread).toHaveBeenCalledWith(panelRef);
    expect(h.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to open chat panel",
        description: "Host thread is deleted.",
      }),
    );
  });

  it("merges the question into the side chat's draft when the send fails", async () => {
    h.drafts.set(hostRef.threadId, { prompt: submittedText, attachments: [] });
    h.drafts.set("new-panel-thread", { prompt: "typed meanwhile", attachments: [] });
    h.startTurn.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("offline") });
    const actions = useCenterPanelActions({ onCloseTerminal });

    await actions.createSideChat(sideChat());

    expect(h.drafts.get("new-panel-thread")?.prompt).toBe(`typed meanwhile\n\n${question}`);
    expect(h.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't send to the side chat",
        description: "Your question is in its composer.",
      }),
    );
    expect(h.drafts.get(hostRef.threadId)?.prompt).toBe("");
  });

  it("keeps the host draft when the send outcome is unknown", async () => {
    h.drafts.set(hostRef.threadId, { prompt: submittedText, attachments: [] });
    h.startTurn.mockResolvedValueOnce({ _tag: "Failure", interrupted: true, cause: null });
    const actions = useCenterPanelActions({ onCloseTerminal });

    await actions.createSideChat(sideChat());

    expect(h.drafts.get(hostRef.threadId)?.prompt).toBe(submittedText);
    expect(h.drafts.has("new-panel-thread")).toBe(false);
  });

  it("edits_in_the_side_chat_during_a_pending_send_are_kept", async () => {
    const send = deferred<unknown>();
    h.startTurn.mockReturnValueOnce(send.promise);
    const actions = useCenterPanelActions({ onCloseTerminal });

    const opening = actions.createSideChat(sideChat());
    await flush();
    const typed = { prompt: "and also this", attachments: [{ id: "image-1" }] };
    h.drafts.set("new-panel-thread", typed);
    send.resolve({ _tag: "Success", value: undefined });
    await opening;

    expect(h.drafts.get("new-panel-thread")).toEqual(typed);
  });

  it("focuses an empty side chat's composer once, and not one opened with a question", async () => {
    const actions = useCenterPanelActions({ onCloseTerminal });
    await actions.createSideChat(sideChat({ question: "", submittedText: ":btw" }));
    expect(takeComposerFocusRequest(panelRef as never)).toBe(true);
    expect(takeComposerFocusRequest(panelRef as never)).toBe(false);
    expect(h.drafts.get(hostRef.threadId)).toBeUndefined();

    await actions.createSideChat(sideChat());
    expect(takeComposerFocusRequest(panelRef as never)).toBe(false);
  });

  it("leaves the host draft alone on the menu path and after an edit", async () => {
    h.drafts.set(hostRef.threadId, { prompt: "an unsent host draft", attachments: [] });
    const actions = useCenterPanelActions({ onCloseTerminal });
    const { submittedText: _omitted, ...fromMenu } = sideChat({ question: "" });
    await actions.createSideChat(fromMenu);
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.drafts.get(hostRef.threadId)?.prompt).toBe("an unsent host draft");

    const creation = deferred<unknown>();
    h.createPanel.mockReturnValueOnce(creation.promise);
    h.drafts.set(hostRef.threadId, { prompt: submittedText, attachments: [] });
    const opening = actions.createSideChat(sideChat());
    h.drafts.set(hostRef.threadId, { prompt: `${submittedText} and more`, attachments: [] });
    creation.resolve({ _tag: "Success", value: undefined });
    await opening;
    expect(h.drafts.get(hostRef.threadId)?.prompt).toBe(`${submittedText} and more`);
  });
});
