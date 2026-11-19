import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Spinner } from "./spinner";

/*
 * Loading and refresh feedback, one model for every surface that reads from a host or
 * the server (Pull Requests, Pipelines, Git Manager and the repository module shell):
 *
 * 1. The status that names a wait (`role="status"`) is never inside an `aria-busy`
 *    region and is never busy itself: assistive technology may hold back what a busy
 *    region says until it settles, and by then the status is gone.
 * 2. The content being loaded or refreshed is the busy region, and it stays exposed to
 *    assistive technology (never `aria-hidden`).
 * 3. A first load with nothing on screen marks its own region busy: `LoadingState`
 *    renders the status and, beside it, the busy region that will hold the content.
 * 4. Exactly one status names a given read. A section with nothing on screen yet
 *    announces its own first load, and an outer refresh status leaves that read to it,
 *    even when the same action started both reads.
 *
 * Both components below render the status and the busy region as siblings, so a caller
 * cannot put one inside the other. Surfaces use them instead of setting `aria-busy` by
 * hand; content that sits apart from its status uses `RefreshRegion` without a `status`.
 */

// The Spinner's own status role and label are dropped: the wrapper names the operation once.
function Indicator({ className }: { className?: string }) {
  return (
    <Spinner
      aria-hidden="true"
      aria-label={undefined}
      role={undefined}
      className={cn("size-4 shrink-0 motion-reduce:animate-none", className)}
    />
  );
}

/**
 * First-load feedback: a spinner and a visible label, then the busy region with optional
 * layout-shaped skeletons. Skeleton and spinner stop moving when reduced motion is requested.
 */
export function LoadingState({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn("space-y-3 p-4 motion-reduce:[&_[data-slot=skeleton]]:animate-none", className)}
    >
      <p
        role="status"
        aria-label={label}
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Indicator />
        <span>{label}</span>
      </p>
      <div aria-busy="true" className="space-y-2">
        {children}
      </div>
    </div>
  );
}

/** Compact feedback for a read that runs while the current content stays on screen. */
export function RefreshIndicator({ label, className }: { label: string; className?: string }) {
  return (
    <p
      role="status"
      aria-label={label}
      className={cn(
        "flex items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <Indicator className="size-3" />
      <span>{label}</span>
    </p>
  );
}

/**
 * Content that stays on screen while it is read again: the refresh status, then the content
 * as the busy region. Omit `status` for a second region of the same read, whose status sits
 * beside another region. The wrapper always renders, so content keeps its state when a
 * refresh starts or ends.
 */
export function RefreshRegion({
  refreshing,
  status,
  className,
  children,
}: {
  refreshing: boolean;
  /** Names the read; shown only while `refreshing`. */
  status?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <>
      {refreshing && status !== undefined ? <RefreshIndicator label={status} /> : null}
      <div aria-busy={refreshing || undefined} className={className}>
        {children}
      </div>
    </>
  );
}
