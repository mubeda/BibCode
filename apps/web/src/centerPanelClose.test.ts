/**
 * Every ordering of a chat panel's close against its creation (#265): when the live snapshot
 * arrives, when the tab closes, how `createPanel` ends, and whether the page reloads. However
 * they interleave, a closed panel ends archived exactly once (or is never created), a side chat
 * closed before its first send sends nothing and leaves its question in the host draft, the
 * tab never comes back, and no mark is left behind. Further rows play archive replies that
 * arrive late, out of order or never, against a reopen here and a reopen by another client.
 * An archive whose outcome is uncertain is never retried, so this page never closes a panel
 * someone else reopened; such a row says so: the panel comes back as a tab instead.
 * Every row runs again against a server that deletes an unused side chat: a side chat closed
 * before anything was sent to it ends deleted instead of archived, and everything else ends as
 * the row says. More rows race the delete against a send, here and on another client.
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
    server: new Map<
      string,
      { archived: boolean; deleted?: boolean; used?: boolean; sideChat?: boolean }
    >(),
    /** The server advertises `threadDeleteOnlyIfUnused`. */
    deletesUnused: false,
    /** `thread.delete` requests this page sent. */
    deletes: 0,
    nextDeleteReply: "normal" as "normal" | "lose-reply" | "drop",
    /** The next send waits for the test before the server takes it. */
    holdNextSend: false,
    heldSend: null as null | { resolve: () => void },
    archivedTimes: new Map<string, number>(),
    sent: [] as string[],
    drafts: new Map<string, string>(),
    pendingCreate: null as null | { resolve: (value: unknown) => void },
    heldArchive: null as null | { resolve: () => void },
    holdNextArchive: false,
    /** How the next archive reply behaves, once. */
    nextArchiveReply: "normal" as "normal" | "hold-reply" | "lose-reply" | "drop",
    heldReply: null as null | { resolve: () => void },
    nextThread: 0,
    /** The server's event sequence; every create, archive, unarchive advances it. */
    sequence: 1,
  };
});

/** The server's answer to `thread.archive`, optionally held until the test releases it. */
function serverArchive(
  threadId: string,
): Promise<{ _tag: string; cause?: unknown; interrupted?: boolean; value?: unknown }> {
  const apply = () => {
    const thread = h.server.get(threadId);
    if (!thread || thread.archived || thread.deleted) {
      return { _tag: "Failure", cause: new Error(`Thread '${threadId}' cannot be archived.`) };
    }
    thread.archived = true;
    h.sequence += 1;
    h.archivedTimes.set(threadId, (h.archivedTimes.get(threadId) ?? 0) + 1);
    // A dispatch answers with its event's sequence.
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

/** The server's answer to `thread.delete` with `onlyIfUnused`. */
function serverDelete(
  threadId: string,
): Promise<{ _tag: string; cause?: unknown; interrupted?: boolean; value?: unknown }> {
  h.deletes += 1;
  const reply = h.nextDeleteReply;
  h.nextDeleteReply = "normal";
  if (reply === "drop") return Promise.resolve({ _tag: "Failure", interrupted: true, cause: null });
  const thread = h.server.get(threadId);
  let result: { _tag: string; cause?: unknown; value?: unknown };
  if (!thread || thread.deleted) {
    result = { _tag: "Failure", cause: new Error(`Thread '${threadId}' does not exist.`) };
  } else if (thread.used) {
    result = {
      _tag: "Failure",
      cause: { _tag: "OrchestrationThreadInUseError", message: "Used.", threadId },
    };
  } else {
    thread.deleted = true;
    h.sequence += 1;
    result = { _tag: "Success", value: { sequence: h.sequence } };
  }
  if (reply === "lose-reply") {
    return Promise.resolve({ _tag: "Failure", interrupted: true, cause: null });
  }
  return Promise.resolve(result);
}

/** The server takes a send: the thread is used from then on. */
function serverSend(threadId: string): { _tag: string; cause?: unknown } {
  const thread = h.server.get(threadId);
  if (!thread || thread.deleted) {
    return { _tag: "Failure", cause: new Error(`Thread '${threadId}' is deleted.`) };
  }
  thread.used = true;
  h.sequence += 1;
  return { _tag: "Success" };
}

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("~/state/session", () => ({
  readPreparedConnection: () => ({
    descriptor: { capabilities: { threadDeleteOnlyIfUnused: h.deletesUnused } },
  }),
}));
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
    delete: "delete",
    unarchive: "unarchive",
    interruptTurn: "interrupt",
    startTurn: "start-turn",
  },
}));
vi.mock("~/state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) => {
    const thread = h.server.get(ref.threadId);
    return thread && !thread.deleted
      ? {
          archivedAt: thread.archived ? "2026-11-03T00:00:00Z" : null,
          session: null,
          ...(thread.sideChat ? { sideChat: true } : {}),
        }
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
      delete: ({ input }: { input: { threadId: string; onlyIfUnused?: boolean } }) => {
        expect(input.onlyIfUnused).toBe(true);
        return serverDelete(input.threadId);
      },
      unarchive: ({ input }: { input: { threadId: string } }) => {
        const thread = h.server.get(input.threadId);
        if (thread?.archived) {
          thread.archived = false;
          h.sequence += 1;
        }
        return Promise.resolve({ _tag: "Success", value: undefined });
      },
      interrupt: () => Promise.resolve({ _tag: "Success" }),
      open: () => Promise.resolve({ _tag: "Success" }),
      "start-turn": ({ input }: { input: { threadId: string; message: { text: string } } }) => {
        h.sent.push(input.message.text);
        if (!h.holdNextSend) return Promise.resolve(serverSend(input.threadId));
        h.holdNextSend = false;
        const held = h.deferred<void>();
        h.heldSend = { resolve: () => held.resolve() };
        return held.promise.then(() => serverSend(input.threadId));
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
type Step =
  | "hold-send"
  | "release-send"
  | "remote-send"
  | "lose-delete-reply"
  | "drop-delete"
  | "reopen-here"
  | "remote-reopen"
  | "remote-archive"
  | "interleaved-deltas"
  | "hold-reply"
  | "lose-reply"
  | "drop-archive"
  | "release-reply"
  | "close"
  | "commit"
  | "snapshot"
  | "capped-snapshot"
  | "respond"
  | "reload"
  | "hold-archive"
  | "release-archive";

/** Where a row must end. */
interface Expected {
  /** The server has the panel archived. */
  readonly archived: boolean;
  /** How many archives this page committed. */
  readonly archives: number;
  /** The panel's tab is on screen. */
  readonly shown: boolean;
  /** The tab never came back after the close, at any step. */
  readonly neverReturned: boolean;
}

interface Row {
  readonly name: string;
  readonly outcome: Outcome;
  readonly steps: readonly Step[];
  readonly expected: Expected;
  /** Judged right after the steps, before the shell streams anything more. */
  readonly withoutMoreSnapshots?: boolean;
}

const CLOSED: Expected = { archived: true, archives: 1, shown: false, neverReturned: true };
/**
 * An archive that landed but whose reply was lost is uncertain: the tab comes back from the
 * shell this page holds until a newer shell drops it.
 */
const CLOSED_AFTER_UNCERTAIN: Expected = { ...CLOSED, neverReturned: false };
/**
 * The close stands down: the panel is live, so its tab comes back and nothing archives it.
 * `reopenedElsewhere`: it comes back because another client reopened it, not while this page
 * still had it closed.
 */
const RETURNS = (archives: number, reopenedElsewhere = false): Expected => ({
  archived: false,
  archives,
  shown: true,
  neverReturned: reopenedElsewhere,
});

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
            steps,
            expected:
              outcome === "failure"
                ? { archived: false, archives: 0, shown: false, neverReturned: true }
                : reload === "before-respond"
                  ? // The page that was closing it is gone; the live panel comes back as a tab.
                    RETURNS(0)
                  : CLOSED,
          });
        }
      }
    }
  }
  return result;
}

/** Replies that arrive late, out of order or never, against reopens here and elsewhere. */
function replyRows(): Row[] {
  const opened: Step[] = ["commit", "respond", "snapshot"];
  const result: Row[] = [];
  const add = (name: string, steps: Step[], expected: Expected, withoutMoreSnapshots = false) =>
    result.push({ name, outcome: "success", steps, expected, withoutMoreSnapshots });
  for (const reload of [false, true]) {
    const tail: Step[] = reload ? ["reload", "snapshot"] : [];
    const suffix = reload ? ", then a reload" : "";
    // The second close's archive never reached the server: it is not retried, so the reopened
    // panel comes back as a tab.
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
    add(`close, reopen, close, first reply last${suffix}`, outOfOrder, RETURNS(1));
    add(
      `close, reopen, close, first reply last, reopened elsewhere${suffix}`,
      [...outOfOrder, "snapshot", "remote-reopen"],
      // The second close's archive did not land, so the tab is back before the remote reopen.
      RETURNS(1),
    );
    const snapshotFirst: Step[] = [
      ...opened,
      "hold-reply",
      "close",
      "snapshot",
      "release-reply",
      ...tail,
    ];
    add(`snapshot before the archive reply${suffix}`, snapshotFirst, CLOSED);
    add(
      `snapshot before the archive reply, reopened elsewhere${suffix}`,
      [...snapshotFirst, "remote-reopen"],
      RETURNS(1, true),
    );
    const lostReply: Step[] = [...opened, "lose-reply", "close", "snapshot", ...tail];
    add(`lost archive reply, archived snapshot${suffix}`, lostReply, CLOSED_AFTER_UNCERTAIN);
    add(
      `lost archive reply, archived snapshot, reopened elsewhere${suffix}`,
      [...lostReply, "remote-reopen"],
      RETURNS(1),
    );
  }
  // A: the reply comes after the reopen's snapshot, and nothing streams after it.
  add(
    "reply after a reopen's snapshot, nothing after it",
    [...opened, "hold-reply", "close", "remote-reopen", "snapshot", "release-reply"],
    RETURNS(1, true),
    true,
  );
  // B: capped snapshots only, a lost reply, then another client's reopen.
  add(
    "lost reply, capped snapshots, reopened elsewhere",
    [
      "commit",
      "respond",
      "capped-snapshot",
      "lose-reply",
      "close",
      "capped-snapshot",
      "remote-reopen",
      "capped-snapshot",
    ],
    RETURNS(1),
  );
  return result;
}

/** The shell reflects a successful archive only after its reply: the tab must not come back. */
function delayedShellRows(): Row[] {
  return [
    {
      name: "delayed shell after a normal close",
      outcome: "success",
      steps: ["commit", "respond", "snapshot", "close", "snapshot"],
      expected: CLOSED,
    },
    {
      name: "delayed shell after a close during creation",
      outcome: "success",
      steps: ["commit", "snapshot", "close", "respond", "snapshot"],
      expected: CLOSED,
    },
    {
      name: "per-thread deltas, another thread's first",
      outcome: "success",
      steps: ["commit", "respond", "snapshot", "close", "interleaved-deltas"],
      expected: CLOSED,
    },
    {
      // A reopen after the archive shows once the publication is complete.
      name: "per-thread deltas, another thread's first, then a reopen",
      outcome: "success",
      steps: ["commit", "respond", "snapshot", "close", "remote-reopen", "interleaved-deltas"],
      expected: RETURNS(1, true),
    },
    {
      // The shell that reflects the archive shows it live again: someone reopened it.
      name: "delayed shell that shows a reopen after the archive",
      outcome: "success",
      steps: ["commit", "respond", "snapshot", "close", "remote-reopen", "snapshot"],
      expected: RETURNS(1, true),
    },
  ];
}

/** C: closed while created, archived elsewhere and settled by a snapshot before the answer. */
function creationRows(): Row[] {
  return [
    {
      name: "closed while created, archived elsewhere before the answer",
      outcome: "success",
      steps: ["commit", "snapshot", "close", "remote-archive", "snapshot", "respond"],
      expected: { archived: true, archives: 0, shown: false, neverReturned: true },
    },
  ];
}

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function play(row: Row, sideChat: boolean) {
  // Unique per play: a creation an earlier play left waiting keeps its host busy.
  const hostId = ThreadId.make(`host-${h.nextThread + 1}-${row.name}`);
  const hostRef = scopeThreadRef(ENV, hostId);
  const panelId = ThreadId.make(`panel-${h.nextThread + 1}`);
  const panelRef = scopeThreadRef(ENV, panelId);
  h.server.set(hostId, { archived: false });
  h.drafts.set(hostId, SUBMITTED);
  let tracker = createCenterPanelAdoptionTracker();
  type ShellRow = Parameters<typeof applyPanelThreadAdoption>[2][number];
  /**
   * The shell this page holds. The server publishes it late (it batches for 500 ms), so a
   * reply can arrive before the shell that reflects it; the reconciler replays what it holds.
   */
  /** `complete`: the shell ends a publication (a snapshot, or a delta chunk's last item). */
  let held: { threads: ShellRow[]; capped: boolean; sequence: number; complete: boolean } | null =
    null;
  const adopt = () => {
    if (!held) return;
    (applyPanelThreadAdoption as (...args: unknown[]) => void)(
      ENV,
      tracker,
      held.threads,
      held.capped,
      undefined,
      held.sequence,
      undefined,
      held.complete,
    );
    // The lifecycle reconciler releases the reservation of every live thread it sees.
    for (const thread of held.threads) {
      useCenterPanelStore.getState().releaseChatPanelReservation(scopeThreadRef(ENV, thread.id));
    }
  };
  /** The shell publishes the server's state as of now. */
  const snapshot = (capped: boolean) => {
    const threads = [...h.server].flatMap(([id, thread]): ShellRow[] =>
      id === hostId
        ? [{ id: hostId, kind: "workspace" as const, title: "Host", archivedAt: null }]
        : // The live shell leaves archived threads out.
          id === panelId && !thread.archived && !thread.deleted
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
    held = { threads, capped, sequence: h.sequence, complete: true };
    adopt();
  };
  // The reconciler also runs adoption again, on the shell it holds, when a close changes.
  const unsubscribe = useCenterPanelStore.subscribe((state, previous) => {
    const changed = (["closingChatPanels", "reshowChatPanels"] as const).some(
      (field) => state[field] !== previous[field],
    );
    if (changed) adopt();
  });
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
  let closedAtLeastOnce = false;
  let closed = false;
  let tabReturned = false;
  for (const step of row.steps) {
    switch (step) {
      case "commit":
        h.server.set(panelId, { archived: false, ...(sideChat ? { sideChat: true } : {}) });
        h.sequence += 1;
        break;
      case "snapshot":
      case "capped-snapshot":
        snapshot(step === "capped-snapshot");
        break;
      case "close": {
        if (!closedAtLeastOnce) sentBeforeClose = h.sent.length > 0;
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
        closedAtLeastOnce = true;
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
        // The page's memory goes (the shell it held with it), and the open that was waiting
        // never resumes.
        held = null;
        tracker = createCenterPanelAdoptionTracker();
        useCenterPanelStore.setState({
          pendingChatPanelThreadKeys: new Set(),
          closingChatPanels: new Map(),
          reshowChatPanels: new Set(),
        });
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
      case "remote-reopen":
      case "remote-archive": {
        // Another client changes it through the server.
        const thread = h.server.get(panelId);
        const archived = step === "remote-archive";
        if (thread && thread.archived !== archived) {
          thread.archived = archived;
          h.sequence += 1;
        }
        if (!archived) closed = false;
        break;
      }
      case "release-archive":
        h.heldArchive?.resolve();
        break;
      case "hold-send":
        h.holdNextSend = true;
        break;
      case "release-send":
        h.heldSend?.resolve();
        break;
      case "remote-send": {
        // Another client's first send lands.
        const thread = h.server.get(panelId);
        if (thread) thread.used = true;
        break;
      }
      case "lose-delete-reply":
        h.nextDeleteReply = "lose-reply";
        break;
      case "drop-delete":
        h.nextDeleteReply = "drop";
        break;
      case "interleaved-deltas":
        // Another thread changed after the archive, in the same publication; the shell
        // streams per-thread deltas, and that thread's comes first. Between the two items the
        // shell is past the archive but still lists the panel as it was.
        h.sequence += 1;
        if (held) {
          held = {
            threads: [
              ...held.threads,
              {
                id: ThreadId.make(`other-${row.name}`),
                kind: "workspace",
                title: "Other",
                archivedAt: null,
              },
            ],
            capped: held.capped,
            sequence: h.sequence,
            complete: false,
          };
          adopt();
          await flush();
          if (closed && tabIds().includes(`chat:${panelId}`)) tabReturned = true;
        }
        snapshot(false);
        break;
    }
    await flush();
    if (closed && tabIds().includes(`chat:${panelId}`)) tabReturned = true;
  }
  const isArchived = () => {
    const thread = h.server.get(panelId);
    return thread?.archived === true && thread.deleted !== true;
  };
  const judgedNow = {
    archived: isArchived(),
    shown: tabIds().includes(`chat:${panelId}`),
  };
  // Later snapshots, as the shell keeps streaming.
  for (let index = 0; index < 3; index += 1) {
    snapshot(false);
    await flush();
    if (closed && tabIds().includes(`chat:${panelId}`)) tabReturned = true;
  }
  unsubscribe();

  const key = scopedThreadKey(panelRef);
  const state = useCenterPanelStore.getState();
  const leaked = {
    ...(state.pendingChatPanelThreadKeys.has(key) ? { pending: true } : {}),
    ...(state.closingChatPanels.has(key) ? { closing: true } : {}),
    ...(state.reshowChatPanels.has(key) ? { reshow: true } : {}),
  };
  const ended = row.withoutMoreSnapshots
    ? judgedNow
    : {
        archived: isArchived(),
        shown: tabIds().includes(`chat:${panelId}`),
      };
  return {
    deleted: h.server.get(panelId)?.deleted === true,
    outcome: {
      archived: ended.archived,
      archives: h.archivedTimes.get(panelId) ?? 0,
      shown: ended.shown,
      neverReturned: !tabReturned,
    } satisfies Expected,
    sent: h.sent.length,
    sentBeforeClose,
    hostDraft: h.drafts.get(hostId),
    leaked,
  };
}

function expectSettled(row: Row, result: Awaited<ReturnType<typeof play>>, sideChat: boolean) {
  expect(result.outcome).toEqual(row.expected);
  if (sideChat && result.sentBeforeClose) {
    // Closed after its first send went out: the question was handed over once.
    expect({ sent: result.sent, hostDraft: result.hostDraft }).toEqual({ sent: 1, hostDraft: "" });
  } else if (sideChat) {
    // Closed before its first send: the question was never sent, and the host draft keeps it.
    expect({ sent: result.sent, hostDraft: result.hostDraft }).toEqual({
      sent: 0,
      hostDraft: SUBMITTED,
    });
  } else {
    expect(result.sent).toBe(0);
  }
  expect(result.leaked).toEqual({});
}

/** Where a side chat closed before anything was sent to it ends on a deleting server. */
const DELETED: Expected = { archived: false, archives: 0, shown: false, neverReturned: true };

/** Closes racing a delete's reply or a send, on a server that deletes unused side chats. */
function deleteRows(): Array<Row & { readonly deleted: boolean }> {
  return [
    {
      // An uncertain delete is not retried: the tab comes back from the held shell until a
      // newer shell drops the deleted panel.
      name: "lost delete reply",
      outcome: "success",
      steps: ["commit", "snapshot", "lose-delete-reply", "close", "respond", "snapshot"],
      expected: { ...DELETED, neverReturned: false },
      deleted: true,
    },
    {
      name: "a delete that never reached the server",
      outcome: "success",
      steps: ["commit", "snapshot", "drop-delete", "close", "respond", "snapshot"],
      expected: RETURNS(0),
      deleted: false,
    },
    {
      // This page's first send is still on its way when the tab closes: archived, not deleted,
      // and the question was handed over.
      name: "closed while this page's first send is on its way",
      outcome: "success",
      steps: ["commit", "snapshot", "hold-send", "respond", "close", "release-send", "snapshot"],
      expected: CLOSED,
      deleted: false,
    },
    {
      // Another client's first send landed before this page's close: the delete is refused and
      // the side chat is archived.
      name: "another client's first send lands before the close",
      outcome: "success",
      steps: ["commit", "snapshot", "remote-send", "close", "respond", "snapshot"],
      expected: CLOSED,
      deleted: false,
    },
  ];
}

describe("closing a chat panel in every ordering", () => {
  const all = [...rows(), ...replyRows(), ...creationRows(), ...delayedShellRows()].map(
    (row) => [row.name, row] as const,
  );

  it.each(all)("side chat: %s", async (_name, row) => {
    h.sent.length = 0;
    h.deletesUnused = false;
    h.deletes = 0;
    const result = await play(row, true);
    expectSettled(row, result, true);
    // An older server is never asked to delete.
    expect({ deletes: h.deletes, deleted: result.deleted }).toEqual({ deletes: 0, deleted: false });
  });

  it.each(all)("plain panel: %s", async (_name, row) => {
    h.sent.length = 0;
    h.deletesUnused = false;
    expectSettled(row, await play(row, false), false);
  });

  it.each(all)("side chat on a server that deletes unused ones: %s", async (_name, row) => {
    h.sent.length = 0;
    h.deletesUnused = true;
    const result = await play(row, true);
    // Closed before anything was sent to it: deleted where the row archives it.
    const deleted = row.expected.archived && !result.sentBeforeClose;
    expectSettled(
      deleted
        ? { ...row, expected: { ...DELETED, neverReturned: row.expected.neverReturned } }
        : row,
      result,
      true,
    );
    expect(result.deleted).toBe(deleted);
  });

  it.each(all)("plain panel on a server that deletes unused ones: %s", async (_name, row) => {
    h.sent.length = 0;
    h.deletesUnused = true;
    h.deletes = 0;
    const result = await play(row, false);
    expectSettled(row, result, false);
    expect({ deletes: h.deletes, deleted: result.deleted }).toEqual({ deletes: 0, deleted: false });
  });

  it.each(deleteRows().map((row) => [row.name, row] as const))(
    "side chat delete race: %s",
    async (_name, row) => {
      h.sent.length = 0;
      h.deletesUnused = true;
      const result = await play(row, true);
      expectSettled(row, result, true);
      expect(result.deleted).toBe(row.deleted);
    },
  );
});
