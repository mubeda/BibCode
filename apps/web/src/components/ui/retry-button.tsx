import { cn } from "~/lib/utils";

import { Button } from "./button";

export interface RetryButtonProps {
  /** A read, started by Retry or automatically, is in flight. */
  readonly retrying: boolean;
  /**
   * The environment's connection is down. Retry cannot reach the server meanwhile, and
   * the view reads again by itself once the connection is back.
   */
  readonly waitingForConnection?: boolean;
  readonly onRetry: () => void;
  readonly className?: string;
}

function retryLabel(retrying: boolean, waitingForConnection: boolean): string {
  if (waitingForConnection) return "Waiting for the connection…";
  return retrying ? "Retrying…" : "Retry";
}

/**
 * The Retry action of a failed load. While it cannot run, it stays focusable, ignores
 * activation, and its label says what it waits for.
 */
export function RetryButton({
  retrying,
  waitingForConnection = false,
  onRetry,
  className,
}: RetryButtonProps) {
  const unavailable = retrying || waitingForConnection;

  return (
    <Button
      className={cn("aria-disabled:cursor-not-allowed aria-disabled:opacity-64", className)}
      aria-disabled={unavailable || undefined}
      size="xs"
      variant="outline"
      onClick={() => {
        if (unavailable) return;
        onRetry();
      }}
    >
      {retryLabel(retrying, waitingForConnection)}
    </Button>
  );
}
