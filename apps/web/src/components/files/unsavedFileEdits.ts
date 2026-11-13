import type {
  DesktopBridge,
  DesktopCloseReply,
  DesktopCloseRequest,
  DesktopUpdateState,
} from "@bibcode/contracts";

import { toastManager } from "../ui/toast";

/** A `FileEditingSessionRegistry` as the window-wide guard sees it. */
export interface UnsavedSource {
  unsavedSessions(): { path: string }[];
  saveAll(): Promise<"saved" | "blocked">;
  holdSavingForLeave(): () => void;
}

export type LeaveReason = "close" | "quit" | "restart" | "update";
export type LeaveChoice = "save" | "discard" | "cancel";

export interface LeaveQuestion {
  readonly reason: LeaveReason;
  readonly files: readonly string[];
  /** True while Save all runs; the dialog stays open and shows it. */
  readonly saving: boolean;
  answer(choice: LeaveChoice): void;
}

const sources = new Set<UnsavedSource>();
const questionListeners = new Set<() => void>();
let question: LeaveQuestion | null = null;
let pendingAsk: Promise<"proceed" | "stay"> | null = null;
let hostCount = 0;
/** Holds kept after Discard, released if the leave then fails. */
let discardHolds: (() => void)[] = [];
/**
 * Set from the moment the window allows a desktop update install until the desktop says it ended
 * without restarting. Saving is held and the installing dialog keeps edits out, so no edit made
 * during the install is lost when it restarts the app.
 */
let updateInstall: { readonly holds: (() => void)[]; readonly release: () => void } | null = null;

export function registerUnsavedSource(source: UnsavedSource): () => void {
  sources.add(source);
  // A registry that mounts during the install is held like the ones that were there before it.
  updateInstall?.holds.push(source.holdSavingForLeave());
  return () => {
    sources.delete(source);
  };
}

export function windowUnsavedFiles(): { path: string }[] {
  const paths = new Set<string>();
  for (const source of sources) {
    for (const { path } of source.unsavedSessions()) paths.add(path);
  }
  return [...paths].map((path) => ({ path }));
}

/** Saves every registered registry; "blocked" when any file could not be saved. */
export async function saveAll(): Promise<"saved" | "blocked"> {
  const results = await Promise.all([...sources].map((source) => source.saveAll()));
  return results.includes("blocked") ? "blocked" : "saved";
}

export function getLeaveQuestion(): LeaveQuestion | null {
  return question;
}

export function subscribeLeaveQuestion(listener: () => void): () => void {
  questionListeners.add(listener);
  return () => {
    questionListeners.delete(listener);
  };
}

function setQuestion(next: LeaveQuestion | null): void {
  question = next;
  notifyQuestionListeners();
}

function notifyQuestionListeners(): void {
  for (const listener of questionListeners) listener();
}

/** True while an allowed desktop update install runs; `subscribeLeaveQuestion` reports changes. */
export function isUpdateInstalling(): boolean {
  return updateInstall !== null;
}

/** Kept per window, so a reload during an allowed install restores the block before any save. */
const INSTALL_MARKER_KEY = "bibcode:update-install-allowed";

function readInstallMarker(): boolean {
  try {
    return window.sessionStorage.getItem(INSTALL_MARKER_KEY) === "1";
  } catch {
    return false;
  }
}

function writeInstallMarker(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(INSTALL_MARKER_KEY, "1");
    else window.sessionStorage.removeItem(INSTALL_MARKER_KEY);
  } catch {
    // An unusable sessionStorage means no marker: a reload then cannot restore the block.
  }
}

/** The desktop sets `phase` to protecting or installing only after the window allowed it. */
function isRemoteInstallRunning(state: DesktopUpdateState | null | undefined): boolean {
  return (
    state?.requestedBy != null && (state.phase === "protecting" || state.phase === "installing")
  );
}

/**
 * A confirmed state starts or ends the block. Only a cleared requester ends it: between the allow
 * and the backup the phase still reads "available" with the requester set.
 */
function settleInstallState(state: DesktopUpdateState | null | undefined): void {
  if (isRemoteInstallRunning(state)) blockForUpdateInstall();
  else if (state?.requestedBy == null && updateInstall !== null) endUpdateInstall();
}

const INSTALL_STATE_TIMEOUT_MS = 5_000;
const INSTALL_STATE_RETRY_MS = 2_000;

/**
 * Asks the desktop for its update state until it answers. A rejection or a timeout is not an
 * answer: it changes nothing and asks again. Returns the function that stops asking.
 */
function askInstallState(
  bridge: Pick<DesktopBridge, "getUpdateState">,
  onAnswer: (state: DesktopUpdateState | null | undefined) => void,
  onAttemptFailed?: () => void,
): () => void {
  let stopped = false;
  let warned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = () => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled || stopped) return;
      settled = true;
      clearTimeout(timer);
      if (!warned) {
        warned = true;
        console.warn("[unsaved-file-edits] could not read the desktop update state", error);
      }
      timer = setTimeout(attempt, INSTALL_STATE_RETRY_MS);
      onAttemptFailed?.();
    };
    timer = setTimeout(() => fail(new Error("no answer in time")), INSTALL_STATE_TIMEOUT_MS);
    new Promise<DesktopUpdateState>((resolve) => resolve(bridge.getUpdateState())).then((state) => {
      // An answer after its own timeout or after stopping is stale.
      if (settled || stopped) return;
      settled = true;
      stopped = true;
      clearTimeout(timer);
      onAnswer(state);
    }, fail);
  };
  attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function blockForUpdateInstall(): void {
  if (updateInstall !== null) return;
  writeInstallMarker(true);
  const holds = [...sources].map((source) => source.holdSavingForLeave());
  updateInstall = {
    holds,
    release: () => {
      for (const release of holds) release();
    },
  };
  notifyQuestionListeners();
}

/** The desktop install ended without a restart: saving and editing run again. */
function endUpdateInstall(): void {
  releaseLeaveHolds();
  writeInstallMarker(false);
  const install = updateInstall;
  if (install === null) return;
  updateInstall = null;
  install.release();
  notifyQuestionListeners();
  toastManager.add({
    type: "error",
    title: "The update did not install",
    description:
      "BiBCode did not restart. Files can be edited again. If saving fails, open the Update not installed dialog and choose Restart server.",
  });
}

/**
 * The one dialog host of the window announces itself here. A host that unmounts with the
 * question open answers Cancel, so nothing waits on a dialog nobody can see.
 */
export function attachLeaveQuestionHost(): () => void {
  hostCount += 1;
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    hostCount -= 1;
    if (hostCount === 0) question?.answer("cancel");
  };
}

/** Lets saving run again after Discard when the restart or install did not happen. */
export function releaseLeaveHolds(): void {
  const holds = discardHolds;
  discardHolds = [];
  for (const release of holds) release();
}

/**
 * Asks before the window closes, the app quits, restarts or installs an update. Resolves
 * "proceed" at once when nothing is unsaved, otherwise after Save all succeeded or Discard.
 */
export function askBeforeLeaving(reason: LeaveReason): Promise<"proceed" | "stay"> {
  pendingAsk ??= ask(reason).finally(() => {
    pendingAsk = null;
  });
  return pendingAsk;
}

async function ask(reason: LeaveReason): Promise<"proceed" | "stay"> {
  // Blurring commits an IME composition into the editor before the registries are read.
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  focused?.blur();
  const answer = await askUnfocused(reason);
  // Staying puts the person back where they were, after the dialog returned its own focus.
  if (answer === "stay" && focused?.isConnected) setTimeout(() => focused.focus(), 0);
  return answer;
}

async function askUnfocused(reason: LeaveReason): Promise<"proceed" | "stay"> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const files = windowUnsavedFiles().map(({ path }) => path);
  if (files.length === 0) return "proceed";
  if (hostCount === 0) return "stay";

  const holds = [...sources].map((source) => source.holdSavingForLeave());
  const releaseHolds = () => {
    for (const release of holds) release();
  };
  const choice = await new Promise<LeaveChoice>((resolve) => {
    let answered = false;
    setQuestion({
      reason,
      files,
      saving: false,
      answer: (next) => {
        if (answered) return;
        answered = true;
        setQuestion(next === "save" ? { reason, files, saving: true, answer: () => {} } : null);
        resolve(next);
      },
    });
  });

  if (choice === "cancel") {
    releaseHolds();
    return "stay";
  }
  if (choice === "discard") {
    discardHolds.push(...holds);
    return "proceed";
  }
  releaseHolds();
  const saved = await saveAll();
  setQuestion(null);
  if (saved === "saved") return "proceed";
  const unsaved = windowUnsavedFiles().map(({ path }) => path);
  toastManager.add({
    type: "error",
    title: unsaved.length === 1 ? "A file was not saved" : `${unsaved.length} files were not saved`,
    description: `${unsaved.join(", ")}. Open each file to reload, overwrite or retry the save.`,
  });
  return "stay";
}

/** The desktop waits 5 seconds for each, so a throttled timer still has five chances. */
const KEEPALIVE_INTERVAL_MS = 1_000;

/**
 * Answers the desktop's close and quit requests through the leave question. Keepalives run only
 * while this subscription holds a request, and stopping it with one pending answers stay.
 */
export function respondToDesktopCloseRequests(
  bridge: Pick<DesktopBridge, "onCloseRequest" | "replyCloseRequest" | "onUpdateInstallEnded"> &
    Partial<Pick<DesktopBridge, "getUpdateState" | "onUpdateState">>,
): () => void {
  const { onCloseRequest, replyCloseRequest, onUpdateInstallEnded, getUpdateState, onUpdateState } =
    bridge;
  if (!onCloseRequest || !replyCloseRequest) return () => {};
  let stopAsking = () => {};
  const askAgain = () =>
    new Promise<void>((resolve) => {
      stopAsking();
      if (!getUpdateState) {
        settleInstallState(null);
        resolve();
        return;
      }
      stopAsking = askInstallState(
        bridge as Pick<DesktopBridge, "getUpdateState">,
        (state) => {
          settleInstallState(state);
          resolve();
        },
        resolve,
      );
    });
  let active: {
    readonly requestId: number;
    readonly reason: DesktopCloseRequest["reason"];
    readonly keepalive: ReturnType<typeof setInterval>;
  } | null = null;
  const reply = (requestId: number, answer: DesktopCloseReply) => {
    replyCloseRequest(requestId, answer).catch((error: unknown) => {
      console.warn("[unsaved-file-edits] could not answer the desktop close request", error);
    });
  };
  const finish = (answer: "allow" | "stay") => {
    if (active === null) return;
    clearInterval(active.keepalive);
    reply(active.requestId, answer);
    active = null;
  };
  const unsubscribe = onCloseRequest(({ requestId, reason }) => {
    if (active?.requestId === requestId) return;
    finish("stay");
    reply(requestId, "acknowledge");
    const current = {
      requestId,
      reason,
      keepalive: setInterval(() => reply(requestId, "keepalive"), KEEPALIVE_INTERVAL_MS),
    };
    active = current;
    void askBeforeLeaving(reason).then((answer) => {
      if (active !== current) return;
      // Only a remote install asks with "update"; it keeps running long after this answer.
      if (answer === "proceed" && reason === "update") {
        // An answer to a query sent before this allow would be stale.
        stopAsking();
        blockForUpdateInstall();
      }
      finish(answer === "proceed" ? "allow" : "stay");
    });
  });
  const stopUpdateState = onUpdateState?.(() => {
    stopAsking();
  });
  if (getUpdateState) {
    // The reload of a window that allowed an install: hold saving before anything can run.
    if (readInstallMarker()) blockForUpdateInstall();
    void askAgain();
  } else if (updateInstall === null) {
    // Nothing can confirm an install on this desktop, so it counts as not installing.
    writeInstallMarker(false);
  }
  const stopEnded = onUpdateInstallEnded?.(() => {
    stopAsking();
    // The person forced the install from the native prompt while this question was open; a late
    // answer must not start a block that no signal will end.
    if (active?.reason === "update") {
      clearInterval(active.keepalive);
      active = null;
      question?.answer("cancel");
    }
    endUpdateInstall();
  });
  return () => {
    unsubscribe();
    stopEnded?.();
    stopUpdateState?.();
    stopAsking();
    if (active === null) return;
    finish("stay");
    question?.answer("cancel");
  };
}

if (typeof window !== "undefined") {
  // Browser mode only: the desktop app asks through its close protocol instead.
  window.addEventListener("beforeunload", (event) => {
    if (window.desktopBridge !== undefined) return;
    if (windowUnsavedFiles().length > 0) event.preventDefault();
  });
}
