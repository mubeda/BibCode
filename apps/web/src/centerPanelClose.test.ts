/**
 * Every ordering of a chat panel's close against its creation (#265): when the live snapshot
 * arrives, when the tab closes, how `createPanel` ends, and whether the page reloads. However
 * they interleave, a closed panel ends archived exactly once (or is never created), a side chat
 * closed before its first send sends nothing and leaves its question in the host draft, the
 * tab never comes back, and no mark is left behind. Further rows play archive replies that
 * arrive late, out of order or never, against a reopen here and a reopen by another client:
 * the server's ordered state decides, so a close is honoured and another client's reopen is
 * never closed again.
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
    /** How the next archive reply behaves, once. */
    nextArchiveReply: "normal" as "normal" | "hold-reply" | "lose-reply" | "drop",
    heldReply: null as null | { resolve: () => void },
    /** The server's event sequence; every create, archive and unarchive advances it. */
    sequence: 1,
    nextThread: 0,
  };
});

/** The server's answer to `thread.archive`, optionally held until the test releases it. */
function serverArchive(
  threadId: string,
): Promise<{ _tag: string; cause?: unknown; interrupted?: boolean; value?: unknown }> {
  const apply = () => {
    const thread = h.server.get(threadId);
    if (!thread || thread.archived) {
      return { _tag: "Failure", cause: new Error(`Thread '${threadId}' cannot be archived.`) };
    }
    thread.archived = true;
    h.sequence += 1;
    h.archivedTimes.set(threadId, (h.archivedTimes.get(threadId) ?? 0) + 1);
    return { _tag: "Success", value: { sequence: h.sequence } };
  };
  const reply = h.nextArchiveReply;
  h.nextArchiveReply = "normal";
  // The request never reached the server.
  if (reply === "drop") return Promise.resolve({ _tag: "Failure", interrupted: true, cause: null });
  if (reply === "lose-reply") {
    apply();
    return Promise.resolve({ _tag: "Failure", interrupted: true, cause: null });
  }
  if (reply === "hold-reply") {
    const applied = apply();
    const held = h.deferred<void>();
    h.heldReply = { resolve: () => held.resolve() };
    return held.promise.then(() => applied);
  }
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
      unarchive: ({ input }: { input: { threadId: string } }) => {
        const thread = h.server.get(input.threadId);
        if (thread?.archived) {
          thread.archived = false;
          h.sequence += 1;
        }
        return Promise.resolve({ _tag: "Success", value: { sequence: h.sequence } });
      },
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
import * as closeMemory from "./centerPanelClose";
import { applyPanelThreadAdoption, createCenterPanelAdoptionTracker } from "./centerPanelAdoption";
import { selectThreadCenterPanelState, useCenterPanelStore } from "./centerPanelStore";

const ENV = EnvironmentId.make("environment-1");
const QUESTION = "why did you pick that file?";
const SUBMITTED = `:btw ${QUESTION}`;

type Outcome = "success" | "failure" | "interrupted";
type Close = "during" | "during-after-snapshot" | "after" | "during-archive";
type Reload = "none" | "before-respond" | "after-respond";
type Step =
  | "reopen-here"
  | "remote-reopen"
  | "hold-reply"
  | "lose-reply"
  | "drop-archive"
  | "release-reply"
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
  /** Rows where the panel ends reopened by another client, with its archives counted. */
  readonly reopenedElsewhere?: { readonly archives: number };
  /** The archives a row that ends closed expects (one unless it was closed twice). */
  readonly archives?: number;
}

/** Replies that arrive late, out of order or never, against reopens here and elsewhere. */
function replyRows(): Row[] {
  const base = { outcome: "success", close: "after", reload: "none" } as const;
  const opened: Step[] = ["commit", "respond", "snapshot"];
  const result: Row[] = [];
  for (const reload of [false, true]) {
    const tail: Step[] = reload ? ["reload", "snapshot"] : [];
    const suffix = reload ? ", then a reload" : "";
    // Finding 1: the first close's late reply must not settle the second close.
    const outOfOrder: Step[] = [
      ...opened,
      "hold-reply",
      "close",
      "reopen-here",
      "snapshot",
      "drop-archive",
      "close",
      "release-reply",
      ...tail,
    ];
    result.push({
      ...base,
      name: `close, reopen, close, first reply last${suffix}`,
      steps: outOfOrder,
      archives: 2,
    });
    result.push({
      ...base,
      name: `close, reopen, close, first reply last, reopened elsewhere${suffix}`,
      steps: [...outOfOrder, "snapshot", "remote-reopen"],
      reopenedElsewhere: { archives: 2 },
    });
    // Finding 2: the snapshot that drops the panel comes before the archive's reply.
    const snapshotFirst: Step[] = [
      ...opened,
      "hold-reply",
      "close",
      "snapshot",
      "release-reply",
      ...tail,
    ];
    result.push({
      ...base,
      name: `snapshot before the archive reply${suffix}`,
      steps: snapshotFirst,
    });
    result.push({
      ...base,
      name: `snapshot before the archive reply, reopened elsewhere${suffix}`,
      steps: [...snapshotFirst, "remote-reopen"],
      reopenedElsewhere: { archives: 1 },
    });
    // Finding 3: the archive committed, its reply was lost, and a snapshot shows it archived.
    const lostReply: Step[] = [...opened, "lose-reply", "close", "snapshot", ...tail];
    result.push({
      ...base,
      name: `lost archive reply, archived snapshot${suffix}`,
      steps: lostReply,
    });
    result.push({
      ...base,
      name: `lost archive reply, archived snapshot, reopened elsewhere${suffix}`,
      steps: [...lostReply, "remote-reopen"],
      reopenedElsewhere: { archives: 1 },
    });
  }
  return result;
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
      result._tag === "Success"
        ? { kind: "archived", sequence: (result.value as { sequence: number }).sequence }
        : { kind: result.interrupted === true ? "interrupted" : "refused" },
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
    (applyPanelThreadAdoption as (...args: unknown[]) => void)(
      ENV,
      tracker,
      threads,
      false,
      adoptionArchive,
      h.sequence,
    );
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
        h.sequence += 1;
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
        (closeMemory as { resetChatPanelCloseMemory?: () => void }).resetChatPanelCloseMemory?.();
        break;
      case "hold-archive":
        h.holdNextArchive = true;
        break;
      case "hold-reply":
      case "lose-reply":
        h.nextArchiveReply = step;
        break;
      case "drop-archive":
        h.nextArchiveReply = "drop";
        break;
      case "release-reply":
        h.heldReply?.resolve();
        break;
      case "reopen-here":
        closed = false;
        await actions.reopenChatPanel(hostRef, panelId, sideChat ? "Side chat · Codex" : "Codex");
        break;
      case "remote-reopen": {
        // Another client reopens it through the server.
        const thread = h.server.get(panelId);
        if (thread?.archived) {
          thread.archived = false;
          h.sequence += 1;
        }
        closed = false;
        break;
      }
      case "release-archive":
        h.heldArchive?.resolve();
        break;
    }
    await flush();
    if (closed && tabIds().includes(`chat:${panelId}`)) tabReturned = true;
  }
  const reopenedElsewhere = row.steps.at(-1) === "remote-reopen";
  // What ended the creation settled the close itself, without waiting for another snapshot.
  const archivedWithoutMoreSnapshots = h.server.get(panelId)?.archived ?? false;
  // Later snapshots, as the shell keeps streaming.
  for (let index = 0; index < 3; index += 1) {
    snapshot();
    await flush();
    if (!reopenedElsewhere && tabIds().includes(`chat:${panelId}`)) tabReturned = true;
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
      const keys = Array.isArray(value)
        ? value.map((entry: string | { key: string }) =>
            typeof entry === "string" ? entry : entry.key,
          )
        : [...(value as ReadonlySet<string>).keys()];
      return keys.includes(scopedThreadKey(panelRef)) ? [[field, true]] : [];
    }),
  );
  const archiving = (
    closeMemory as { archivingChatPanels?: () => ReadonlySet<string> }
  ).archivingChatPanels?.();
  if (archiving?.has(scopedThreadKey(panelRef))) leaked["archiving"] = true;
  return {
    tabShown: tabIds().includes(`chat:${panelId}`),
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
  if (row.reopenedElsewhere) {
    // Another client's reopen stands: it is shown here and never closed again.
    expect({
      archived: result.archived,
      times: result.archivedTimes,
      shown: result.tabShown,
      leaked: result.leaked,
    }).toEqual({ archived: false, times: row.reopenedElsewhere.archives, shown: true, leaked: {} });
    return;
  }
  if (row.archives !== undefined) {
    expect({
      archived: result.archived,
      times: result.archivedTimes,
      back: result.tabBack,
    }).toEqual({
      archived: true,
      times: row.archives,
      back: false,
    });
    expect(result.leaked).toEqual({});
    return;
  }
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
  it.each([...rows(), ...replyRows()].map((row) => [row.name, row] as const))(
    "side chat: %s",
    async (_name, row) => {
      h.sent.length = 0;
      expectSettled(row, await play(row, true), true);
    },
  );

  it.each([...rows(), ...replyRows()].map((row) => [row.name, row] as const))(
    "plain panel: %s",
    async (_name, row) => {
      h.sent.length = 0;
      expectSettled(row, await play(row, false), false);
    },
  );
});
