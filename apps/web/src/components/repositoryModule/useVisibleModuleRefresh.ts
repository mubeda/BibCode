import { useEffect, useLayoutEffect, useRef } from "react";
import {
  VISIBLE_REFRESH_MS,
  shouldRefreshOnShow,
  visibleRefreshDelay,
} from "./visibleRefresh.logic";

/**
 * Re-reads a module view while the document is visible: `intervalMs` after its last
 * success, and on show when that success is older than `FRESH_MS`. Shared by the
 * Pull Requests and Pipelines views.
 */
export function useVisibleModuleRefresh({
  enabled,
  succeeded,
  paused = false,
  intervalMs = VISIBLE_REFRESH_MS,
  revalidate,
}: {
  enabled: boolean;
  succeeded: boolean;
  /** The subscribe stream is pushing change events, so the client's own timer stands down. */
  paused?: boolean;
  /** The period after the last success; 20 s unless a view follows something faster. */
  intervalMs?: number;
  revalidate: () => void;
}): void {
  const lastSuccessAt = useRef<number | null>(null);
  const revalidateRef = useRef(revalidate);
  useLayoutEffect(() => {
    revalidateRef.current = revalidate;
  }, [revalidate]);

  useEffect(() => {
    if (succeeded && lastSuccessAt.current === null) lastSuccessAt.current = Date.now();
    if (!enabled || paused) return;
    let timer: number | null = null;
    const clear = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      clear();
      const delay = visibleRefreshDelay(
        document.visibilityState === "visible",
        lastSuccessAt.current,
        Date.now(),
        intervalMs,
      );
      if (delay === null) return;
      timer = window.setTimeout(() => {
        lastSuccessAt.current = null;
        revalidateRef.current();
      }, delay);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        clear();
        return;
      }
      if (shouldRefreshOnShow(lastSuccessAt.current, Date.now())) {
        lastSuccessAt.current = null;
        revalidateRef.current();
        return;
      }
      arm();
    };
    document.addEventListener("visibilitychange", onVisibility);
    arm();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clear();
    };
  }, [enabled, intervalMs, paused, succeeded]);
}
