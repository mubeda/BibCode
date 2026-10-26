import type { PullRequestsOperationError } from "@bibcode/contracts";
import { useEffect, useEffectEvent, useState } from "react";

/**
 * Seconds until a rate-limited host takes reads again, counting down from the
 * server's `retryAfterSeconds`, or `null` when `error` is not such an answer. Every
 * pipelines read honors that deadline on the server, so a Refresh before it would
 * only be refused again; `onElapsed` runs once when it passes, to read again.
 */
export function useRateLimitCountdown(
  error: PullRequestsOperationError | null,
  onElapsed: () => void,
): number | null {
  const seconds =
    error?.code === "rate_limited" && error.retryAfterSeconds !== undefined
      ? error.retryAfterSeconds
      : null;
  const [remaining, setRemaining] = useState<{ error: unknown; seconds: number } | null>(null);
  const elapsed = useEffectEvent(onElapsed);
  useEffect(() => {
    if (seconds === null) return;
    // At least a second, so a host answering `0` cannot spin reads.
    const deadline = Date.now() + Math.max(1, seconds) * 1_000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
      setRemaining({ error, seconds: left });
      if (left === 0) {
        window.clearInterval(timer);
        elapsed();
      }
    };
    const timer = window.setInterval(tick, 1_000);
    tick();
    return () => window.clearInterval(timer);
  }, [error, seconds]);
  if (seconds === null) return null;
  return remaining?.error === error ? remaining.seconds : seconds;
}
