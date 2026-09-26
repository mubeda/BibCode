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
 * The Retry action of a failed load. While it cannot run, it is disabled and its label
 * says what it waits for.
 */
export function RetryButton({
  retrying,
  waitingForConnection = false,
  onRetry,
  className,
}: RetryButtonProps) {
  return (
    <Button
      className={className}
      disabled={retrying || waitingForConnection}
      size="xs"
      variant="outline"
      onClick={onRetry}
    >
      {retryLabel(retrying, waitingForConnection)}
    </Button>
  );
}
