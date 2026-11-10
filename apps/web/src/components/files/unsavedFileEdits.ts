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
  readonly files: readonly string[];
  answer(choice: LeaveChoice): void;
}

const sources = new Set<UnsavedSource>();
const questionListeners = new Set<() => void>();
let question: LeaveQuestion | null = null;
let pendingAsk: Promise<"proceed" | "stay"> | null = null;
let hostCount = 0;
/** Holds kept after Discard, released if the leave then fails. */
let discardHolds: (() => void)[] = [];

export function registerUnsavedSource(source: UnsavedSource): () => void {
  sources.add(source);
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
  for (const listener of questionListeners) listener();
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

async function ask(_reason: LeaveReason): Promise<"proceed" | "stay"> {
  // Blurring commits an IME composition into the editor before the registries are read.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
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
      files,
      answer: (next) => {
        if (answered) return;
        answered = true;
        setQuestion(null);
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
  if ((await saveAll()) === "saved") return "proceed";
  const unsaved = windowUnsavedFiles().map(({ path }) => path);
  toastManager.add({
    type: "error",
    title: unsaved.length === 1 ? "A file was not saved" : `${unsaved.length} files were not saved`,
    description: `${unsaved.join(", ")}. Open each file to reload, overwrite or retry the save.`,
  });
  return "stay";
}

if (typeof window !== "undefined") {
  // Browser mode only: the desktop app asks through its close protocol instead.
  window.addEventListener("beforeunload", (event) => {
    if (window.desktopBridge !== undefined) return;
    if (windowUnsavedFiles().length > 0) event.preventDefault();
  });
}
