import { useEffect, useRef } from "react";
import { shouldRefreshOnShow, visibleRefreshDelay } from "./visibleRefresh.logic";

export function useVisiblePullRequestRefresh({
  enabled,
  succeeded,
  revalidate,
}: {
  enabled: boolean;
  succeeded: boolean;
  revalidate: () => void;
}): void {
  const lastSuccessAt = useRef<number | null>(null);
  const revalidateRef = useRef(revalidate);
  revalidateRef.current = revalidate;
  if (succeeded && lastSuccessAt.current === null) lastSuccessAt.current = Date.now();

  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, succeeded]);
}
