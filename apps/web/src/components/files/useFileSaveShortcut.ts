import { type RefObject, useEffect } from "react";

/**
 * Wire an explicit Ctrl+S / Cmd+S save onto the file-surface container. The chord
 * flushes the pending debounced write immediately and always preventDefaults so
 * the browser's own save dialog can never open. The listener is scoped to the
 * container (capture phase, so it wins before the Pierre editor's own handlers)
 * and only fires while focus lives inside the surface.
 */
export function useFileSaveShortcut(
  containerRef: RefObject<HTMLElement | null>,
  session: { flush(): Promise<unknown> } | null,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !session) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveChord =
        (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s";
      if (!isSaveChord) return;
      event.preventDefault();
      void session.flush();
    };
    container.addEventListener("keydown", handleKeyDown, true);
    return () => container.removeEventListener("keydown", handleKeyDown, true);
  }, [containerRef, session]);
}
