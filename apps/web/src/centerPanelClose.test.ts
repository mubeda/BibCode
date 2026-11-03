/**
 * Every ordering of a chat panel's close against its creation (#265): when the live snapshot
 * arrives, when the tab closes, how `createPanel` ends, and whether the page reloads. However
 * they interleave, a closed panel ends archived exactly once (or is never created), a side chat
 * closed before its first send sends nothing and leaves its question in the host draft, the
 * tab never comes back, and no mark is left behind.
 */
import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@bibcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  };
  return {
    deferred,
    server: new Map<string, { archived: boolean }>(),
    archivedTimes: new Map<string, number>(),
    sent: [] as string[],
    drafts: new Map<string, string>(),
    pendingCreate: null as null | { resolve: (value: unknown) => void },
    heldArchive: null as null | { resolve: () => void },
    holdNextArchive: false,
    nextThread: 0,
  };
});

/** The server's answer to `thread.archive`, optionally held until the test releases it. */
function serverArchive(threadId: string): Promise<{ _tag: string; cause?: unknown }> {
  const apply = () => {
    const thread = h.server.get(threadId);
    if (!thread || thread.archived) {
      return { _tag: "Failure", cause: new Error(`Thread '${threadId}' cannot be archived.`) };
    }
    thread.archived = true;
    h.archivedTimes.set(threadId, (h.archivedTimes.get(threadId) ?? 0) + 1);
    return { _tag: "Success" };
  };
  if (!h.holdNextArchive) return Promise.resolve(apply());
  h.holdNextArchive = false;
  const held = h.deferred<void>();
  h.heldArchive = { resolve: () => held.resolve() };
  return held.promise.then(apply);
}

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("@bibcode/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: { interrupted?: boolean }) => result.interrupted === true,
  squashAtomCommandFailure: (result: { cause?: unknown }) => result.cause,
}));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: () => undefined },
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: (ref: { threadId: string }) => {
        const prompt = h.drafts.get(ref.threadId);
        return prompt === undefined
          ? null
          : {
              prompt,
              attachments: [],
              terminalContexts: [],
              elementContexts: [],
              previewAnnotations: [],
              reviewComments: [],
            };
      },
      setPrompt: (ref: { threadId: string }, prompt: string) => h.drafts.set(ref.threadId, prompt),
    }),
  },
}));
vi.mock("~/lib/utils", () => ({
  newCommandId: () => "command",
  newMessageId: () => "message",
  newThreadId: () => `panel-${(h.nextThread += 1)}`,
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { openAgentSessionInPanel: "open" } }));
vi.mock("~/state/worktrees", () => ({ worktreeEnvironment: { createPanel: "create-panel" } }));
vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    archive: "archive",
    unarchive: "unarchive",
    interruptTurn: "interrupt",
    startTurn: "start-turn",
  },
}));
vi.mock("~/state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) => {
    const thread = h.server.get(ref.threadId);
    return thread
      ? { archivedAt: thread.archived ? "2026-11-03T00:00:00Z" : null, session: null }
      : null;
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    ({
      "create-panel": () => {
        const reply = h.deferred<unknown>();
        h.pendingCreate = { resolve: reply.resolve };
        return reply.promise;
      },
      archive: ({ input }: { input: { threadId: string } }) => serverArchive(input.threadId),
      unarchive: () => Promise.resolve({ _tag: "Success" }),
      interrupt: () => Promise.resolve({ _tag: "Success" }),
      open: () => Promise.resolve({ _tag: "Success" }),
      "start-turn": ({ input }: { input: { message: { text: string } } }) => {
        h.sent.push(input.message.text);
        return Promise.resolve({ _tag: "Success" });
      },
    })[command],
}));
vi.mock("./components/ThreadTerminalPanel", () => ({
  releaseTerminalUiResources: () => undefined,
}));

import { useCenterPanelActions } from "./centerPanelActions";
import { applyPanelThreadAdoption, createCenterPanelAdoptionTracker } from "./centerPanelAdoption";
import { selectThreadCenterPanelState, useCenterPanelStore } from "./centerPanelStore";

const ENV = EnvironmentId.make("environment-1");
const QUESTION = "why did you pick that file?";
const SUBMITTED = `:btw ${QUESTION}`;

type Outcome = "success" | "failure" | "interrupted";
type Close = "during" | "during-after-snapshot" | "after" | "during-archive";
type Reload = "none" | "before-respond" | "after-respond";
type Step =
  | "close"
  | "commit"
  | "snapshot"
  | "respond"
  | "reload"
  | "hold-archive"
  | "release-archive";

interface Row {
  readonly name: string;
  readonly outcome: Outcome;
  readonly close: Close;
  readonly reload: Reload;
  readonly steps: readonly Step[];
}

function rows(): Row[] {
  const result: Row[] = [];
  for (const outcome of ["success", "failure", "interrupted"] as const) {
    for (const close of ["during", "during-after-snapshot", "after", "during-archive"] as const) {
      for (const reload of ["none", "before-respond", "after-respond"] as const) {
        for (const snapshotFirst of [false, true]) {
          if (close === "during-after-snapshot" && !snapshotFirst) continue;
          if (close === "during-archive" && (outcome !== "success" || reload === "before-respond"))
            continue;
          // A failed creation leaves no tab to close afterwards.
          if (close === "after" && outcome === "failure") continue;
          // A reload before the answer drops the tab with the page, so nothing closes after.
          if ((close === "after" || close === "during-archive") && reload === "before-respond")
            continue;
          if (outcome === "failure" && snapshotFirst) continue;
          const steps: Step[] = [];
          if (close === "during") steps.push("close");
          if (outcome !== "failure") steps.push("commit");
          if (snapshotFirst) steps.push("snapshot");
          if (close === "during-after-snapshot") steps.push("close");
          // A reload always starts with a live snapshot.
          steps.push(
            ...(reload === "before-respond"
              ? (["reload", "snapshot"] as const)
              : (["respond"] as const)),
          );
          if (close === "after") steps.push("close");
          if (close === "during-archive")
            steps.push("hold-archive", "close", "snapshot", "release-archive");
          if (reload === "after-respond") steps.push("reload", "snapshot");
          result.push({
            name: `${outcome}, close ${close}, reload ${reload}${snapshotFirst ? ", snapshot first" : ""}`,
            outcome,
            close,
            reload,
            steps,
          });
        }
      }
    }
  }
  return result;
}

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function play(row: Row, sideChat: boolean) {
  const hostId = ThreadId.make(`host-${row.name}`);
  const hostRef = scopeThreadRef(ENV, hostId);
  const panelId = ThreadId.make(`panel-${h.nextThread + 1}`);
  const panelRef = scopeThreadRef(ENV, panelId);
  h.server.set(hostId, { archived: false });
  h.drafts.set(hostId, SUBMITTED);
  let tracker = createCenterPanelAdoptionTracker();
  // Takes a ref; e4cab9463's adoption passed the thread id, so the red run accepts both.
  const adoptionArchive = (target: string | { threadId: string }) =>
    serverArchive(typeof target === "string" ? target : target.threadId).then((result) =>
      result._tag === "Success" ? "archived" : "refused",
    );
  const snapshot = () => {
    type ShellRow = Parameters<typeof applyPanelThreadAdoption>[2][number];
    const threads = [...h.server].flatMap(([id, thread]): ShellRow[] =>
      id === hostId
        ? [{ id: hostId, kind: "workspace" as const, title: "Host", archivedAt: null }]
        : // The live shell leaves archived threads out.
          id === panelId && !thread.archived
          ? [
              {
                id: panelId,
                kind: "panel" as const,
                hostThreadId: hostId,
                title: sideChat ? "Panel: Side chat · Codex" : "Panel: Codex",
                archivedAt: null,
              },
            ]
          : [],
    );
    applyPanelThreadAdoption(ENV, tracker, threads, false, adoptionArchive as never);
    // The lifecycle reconciler releases the reservation of every live thread it sees.
    for (const thread of threads) {
      if (thread.archivedAt === null) {
        useCenterPanelStore.getState().releaseChatPanelReservation(scopeThreadRef(ENV, thread.id));
      }
    }
  };
  const tabIds = () =>
    selectThreadCenterPanelState(useCenterPanelStore.getState().byThreadKey, hostRef).surfaces.map(
      (surface) => surface.id,
    );
  const actions = useCenterPanelActions({ onCloseTerminal: () => undefined });
  const input = {
    hostRef,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    providerLabel: "Codex",
  };
  void (sideChat
    ? actions.createSideChat({ ...input, question: QUESTION, submittedText: SUBMITTED })
    : actions.createChatPanel(input));
  const pendingCreate = h.pendingCreate!;
  let sentBeforeClose = false;
  let closed = false;
  let tabReturned = false;
  for (const step of row.steps) {
    switch (step) {
      case "commit":
        h.server.set(panelId, { archived: false });
        break;
      case "snapshot":
        snapshot();
        break;
      case "close": {
        sentBeforeClose = h.sent.length > 0;
        const state = selectThreadCenterPanelState(
          useCenterPanelStore.getState().byThreadKey,
          hostRef,
        );
        const group = state.groups.find((candidate) =>
          candidate.surfaceIds.includes(`chat:${panelId}`),
        );
        const surface = state.surfaces.find((candidate) => candidate.id === `chat:${panelId}`);
        expect(group && surface, "the tab to close").toBeTruthy();
        actions.closeSurface(hostRef, group!.id, surface!);
        closed = true;
        break;
      }
      case "respond":
        pendingCreate.resolve(
          row.outcome === "success"
            ? { _tag: "Success", value: undefined }
            : row.outcome === "failure"
              ? { _tag: "Failure", cause: new Error("Host thread is deleted.") }
              : { _tag: "Failure", interrupted: true, cause: null },
        );
        break;
      case "reload":
        // The page's memory goes; only what the store persists stays, and the open that was
        // waiting never resumes.
        useCenterPanelStore.setState({
          pendingChatPanelThreadKeys: new Set(),
          creatingChatPanelThreadKeys: new Set(),
          chatPanelCloseProgress: new Map(),
        } as never);
        tracker = createCenterPanelAdoptionTracker();
        break;
      case "hold-archive":
        h.holdNextArchive = true;
        break;
      case "release-archive":
        h.heldArchive?.resolve();
        break;
    }
    await flush();
    if (closed && tabIds().includes(`chat:${panelId}`)) tabReturned = true;
  }
  // What ended the creation settled the close itself, without waiting for another snapshot.
  const archivedWithoutMoreSnapshots = h.server.get(panelId)?.archived ?? false;
  // Later snapshots, as the shell keeps streaming.
  for (let index = 0; index < 3; index += 1) {
    snapshot();
    await flush();
    if (tabIds().includes(`chat:${panelId}`)) tabReturned = true;
  }

  const panel = h.server.get(panelId);
  const state = useCenterPanelStore.getState() as unknown as Record<string, unknown>;
  const leaked = Object.fromEntries(
    [
      "pendingChatPanelThreadKeys",
      "creatingChatPanelThreadKeys",
      "chatPanelCloseProgress",
      "closedBeforeCreated",
      "closingChatPanels",
    ].flatMap((field) => {
      const value = state[field] as
        | ReadonlySet<string>
        | ReadonlyMap<string, unknown>
        | readonly string[]
        | undefined;
      if (value === undefined) return [];
      const keys = Array.isArray(value) ? value : [...(value as ReadonlySet<string>).keys()];
      return keys.includes(scopedThreadKey(panelRef)) ? [[field, true]] : [];
    }),
  );
  return {
    created: panel !== undefined,
    archived: panel?.archived ?? false,
    archivedTimes: h.archivedTimes.get(panelId) ?? 0,
    tabBack: tabReturned || tabIds().includes(`chat:${panelId}`),
    archivedWithoutMoreSnapshots,
    sent: h.sent.length,
    sentBeforeClose,
    hostDraft: h.drafts.get(hostId),
    leaked,
  };
}

function expectSettled(row: Row, result: Awaited<ReturnType<typeof play>>, sideChat: boolean) {
  if (result.created) {
    expect({
      archived: result.archived,
      times: result.archivedTimes,
      withoutMoreSnapshots: result.archivedWithoutMoreSnapshots,
    }).toEqual({ archived: true, times: 1, withoutMoreSnapshots: true });
  } else {
    expect(result.archivedTimes).toBe(0);
  }
  expect(result.tabBack).toBe(false);
  if (sideChat) {
    if (result.sentBeforeClose) {
      // Closed after its first send went out: the question was handed over once.
      expect(result.sent).toBe(1);
      expect(result.hostDraft).toBe("");
    } else {
      expect(result.sent).toBe(0);
      expect(result.hostDraft).toBe(SUBMITTED);
    }
  } else {
    expect(result.sent).toBe(0);
  }
  // A reload while the server had not created the panel leaves only its close intent: nothing
  // can tell this page the panel will never exist. It is bounded, and harmless.
  const neverCreatedAcrossReload = !result.created && row.reload === "before-respond";
  const {
    closingChatPanels: _intent,
    closedBeforeCreated: _legacyIntent,
    ...marks
  } = result.leaked;
  expect(neverCreatedAcrossReload ? marks : result.leaked).toEqual({});
}

describe("closing a chat panel in every ordering", () => {
  it.each(rows().map((row) => [row.name, row] as const))("side chat: %s", async (_name, row) => {
    h.sent.length = 0;
    expectSettled(row, await play(row, true), true);
  });

  it.each(rows().map((row) => [row.name, row] as const))("plain panel: %s", async (_name, row) => {
    h.sent.length = 0;
    expectSettled(row, await play(row, false), false);
  });
});
