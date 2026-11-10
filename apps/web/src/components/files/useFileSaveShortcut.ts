import { type RefObject, useEffect } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";

export interface SavableSession {
  flush(): Promise<unknown>;
  getSnapshot(): { readonly editPending: boolean };
}

/**
 * Explains a Save, Reload or Overwrite that did nothing: a rendered edit still pending after
 * the action means its delivery threw, and the action refused to run without it.
 */
export function explainUndeliveredEdit(session: Pick<SavableSession, "getSnapshot">): void {
  if (!session.getSnapshot().editPending) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Your last edit could not be applied to the file.",
      description: "Switch to source view to keep it.",
    }),
  );
}

/** An explicit save from the toolbar or the shortcut. */
export function saveFile(session: SavableSession): void {
  // `flush` delivers the pending edit before its first await, so the snapshot is current here.
  void session.flush();
  explainUndeliveredEdit(session);
}

/**
 * Wire an explicit Ctrl+S / Cmd+S save onto the file-surface container. The chord
 * flushes the pending debounced write immediately and always preventDefaults so
 * the browser's own save dialog can never open. The listener is scoped to the
 * container (capture phase, so it wins before the Pierre editor's own handlers)
 * and only fires while focus lives inside the surface.
 */
export function useFileSaveShortcut(
  containerRef: RefObject<HTMLElement | null>,
  session: SavableSession | null,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !session) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveChord =
        (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s";
      if (!isSaveChord) return;
      event.preventDefault();
      saveFile(session);
    };
    container.addEventListener("keydown", handleKeyDown, true);
    return () => container.removeEventListener("keydown", handleKeyDown, true);
  }, [containerRef, session]);
}
