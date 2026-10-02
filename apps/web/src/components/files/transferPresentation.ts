import type { FileTransferProgress } from "@bibcode/client-runtime/operations";
import * as Predicate from "effect/Predicate";
import { formatTransferBytes } from "~/lib/formatTransferBytes";

export function transferProgressCopy(progress: FileTransferProgress): string {
  if (progress.phase === "reconnecting") return "Reconnecting…";
  const verb = progress.direction === "download" ? "Downloading" : "Uploading";
  return `${verb} ${progress.fileName} — ${formatTransferBytes(progress.sentBytes, progress.totalBytes)}`;
}

export function transferUnavailableCopy(serverName: string): string {
  return `Update ${serverName} to transfer files over its encrypted connection`;
}

export function transferBusyCopy(phase: string): string {
  return phase === "ready"
    ? "Save or dismiss the ready download before starting another."
    : "Finish or cancel the current transfer.";
}

export function transferErrorMessage(error: unknown, fallback: string): string {
  const message = Predicate.isString(error)
    ? error
    : Predicate.isObject(error) && "message" in error && Predicate.isString(error.message)
      ? error.message
      : "";
  return message.trim() || fallback;
}

export type TransferToastState =
  | {
      readonly phase: "preparing";
      readonly operationId: number;
      readonly fileName: string;
      readonly cancel: () => void;
    }
  | {
      readonly phase: "cancelling" | "http";
      readonly operationId: number;
      readonly fileName: string;
    }
  | {
      readonly phase: "running";
      readonly operationId: number;
      readonly progress: FileTransferProgress;
      readonly cancel: () => void;
    }
  | {
      readonly phase: "ready";
      readonly operationId: number;
      readonly fileName: string;
      readonly save: () => void;
      readonly discard: () => void;
    }
  | { readonly phase: "finishing"; readonly operationId: number; readonly fileName: string }
  | {
      readonly phase: "saved";
      readonly operationId: number;
      readonly path: string;
      readonly discard: () => void;
    }
  | {
      readonly phase: "failed";
      readonly operationId: number;
      readonly fileName: string;
      readonly message: string;
      readonly discard: () => void;
    };

export interface FileTransferToastPayload {
  readonly title: string;
  readonly description?: string | undefined;
  readonly type: "loading" | "success" | "error";
  readonly timeout: number;
  readonly data: { readonly actionLayout: "stacked-end"; readonly hideCopyButton: true };
  readonly actionProps?:
    | { readonly children: "Cancel" | "Save"; readonly onClick: () => void }
    | undefined;
  readonly onClose: () => void;
}
interface TransferToastManager {
  readonly add: (payload: FileTransferToastPayload) => string;
  readonly update: (id: string, payload: FileTransferToastPayload) => void;
  readonly close: (id: string) => void;
}

/** Display ownership only; actions always read the current runtime projection. */
export function createFileTransferToastController(
  manager: TransferToastManager,
  read: () => TransferToastState | null,
) {
  let toastId: string | null = null;
  let toastInstance: object | null = null;
  let operationId: number | null = null;
  let signature = "";
  let consumed = false;
  let disposed = false;
  let programmaticClose = false;
  let saveError: string | undefined;
  const closeView = () => {
    if (toastId === null) return;
    const id = toastId;
    toastId = null;
    toastInstance = null;
    programmaticClose = true;
    try {
      manager.close(id);
    } finally {
      programmaticClose = false;
    }
  };
  const current = (id: number, instance: object) => {
    if (disposed || toastInstance !== instance || operationId !== id) return null;
    const state = read();
    return state?.operationId === id ? state : null;
  };
  const action = (id: number, instance: object) => {
    const state = current(id, instance);
    if (state === null || consumed) return;
    if (state.phase === "running" || state.phase === "preparing") {
      consumed = true;
      state.cancel();
    } else if (state.phase === "ready") {
      consumed = true;
      try {
        state.save();
        state.discard();
        closeView();
      } catch (error) {
        consumed = false;
        saveError = transferErrorMessage(
          error,
          "The browser could not start the download. Try Save again.",
        );
        sync();
      }
    }
  };
  const dismissed = (id: number, instance: object) => {
    if (programmaticClose || disposed) return;
    const state = current(id, instance);
    if (state === null || consumed) return;
    toastId = null;
    toastInstance = null;
    // Hiding an already admitted publish is a view action, not a terminal dismissal.
    if (state.phase !== "finishing" && state.phase !== "http" && state.phase !== "cancelling")
      consumed = true;
    if (state.phase === "running" || state.phase === "preparing") state.cancel();
    else if (state.phase === "ready" || state.phase === "saved" || state.phase === "failed")
      state.discard();
  };
  const sync = () => {
    if (disposed) return;
    const state = read();
    if (state === null) {
      closeView();
      operationId = null;
      signature = "";
      return;
    }
    if (operationId !== state.operationId) {
      closeView();
      operationId = state.operationId;
      signature = "";
      consumed = false;
      saveError = undefined;
    }
    const id = state.operationId;
    const title =
      state.phase === "preparing"
        ? `Preparing ${state.fileName}…`
        : state.phase === "cancelling"
          ? `Cancelling ${state.fileName}…`
          : state.phase === "http"
            ? `Downloading ${state.fileName}…`
            : state.phase === "running"
              ? state.progress.phase === "reconnecting"
                ? `${state.progress.direction === "download" ? "Downloading" : "Uploading"} ${state.progress.fileName}`
                : transferProgressCopy(state.progress)
              : state.phase === "ready"
                ? `${state.fileName} is ready`
                : state.phase === "finishing"
                  ? `Finishing ${state.fileName}…`
                  : state.phase === "saved"
                    ? "Download saved"
                    : `Failed to download ${state.fileName}`;
    const description =
      state.phase === "saved"
        ? state.path
        : state.phase === "failed"
          ? state.message
          : state.phase === "running" && state.progress.phase === "reconnecting"
            ? "Reconnecting…"
            : saveError;
    const type =
      state.phase === "saved" ? "success" : state.phase === "failed" ? "error" : "loading";
    const next = `${id}\n${state.phase}\n${title}\n${description ?? ""}`;
    if (toastId !== null && signature === next) return;
    const instance = toastInstance ?? {};
    toastInstance = instance;
    const payload: FileTransferToastPayload = {
      title,
      description,
      type,
      timeout: 0,
      data: { actionLayout: "stacked-end", hideCopyButton: true },
      actionProps:
        state.phase === "running" || state.phase === "preparing"
          ? { children: "Cancel", onClick: () => action(id, instance) }
          : state.phase === "ready"
            ? { children: "Save", onClick: () => action(id, instance) }
            : undefined,
      onClose: () => dismissed(id, instance),
    };
    if (toastId === null) toastId = manager.add(payload);
    else manager.update(toastId, payload);
    signature = next;
  };
  return {
    sync,
    dispose: () => {
      disposed = true;
      closeView();
    },
  };
}
