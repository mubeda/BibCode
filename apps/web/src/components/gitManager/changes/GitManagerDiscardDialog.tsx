import { memo, useCallback, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

const MAX_FILES_TO_LIST = 10;

export interface GitManagerDiscardDialogProps {
  readonly open: boolean;
  readonly paths: ReadonlyArray<string>;
  readonly disposition: "trash" | "permanent";
  readonly isBusy: boolean;
  readonly errorMessage?: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => Promise<"keep-open" | void>;
}

export const GitManagerDiscardDialog = memo(function GitManagerDiscardDialog({
  open,
  paths,
  disposition,
  isBusy,
  errorMessage = null,
  onOpenChange,
  onConfirm,
}: GitManagerDiscardDialogProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const busy = isBusy || isConfirming;
  const visiblePaths = paths.slice(0, MAX_FILES_TO_LIST);
  const hiddenCount = Math.max(0, paths.length - visiblePaths.length);
  const cancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  const confirm = useCallback(async () => {
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setIsConfirming(true);
    try {
      const next = await onConfirm();
      if (next !== "keep-open") onOpenChange(false);
    } catch {
      // The owner renders the typed failure and the confirmation stays open.
    } finally {
      confirmingRef.current = false;
      setIsConfirming(false);
    }
  }, [onConfirm, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {disposition === "trash" ? "Move Changes to Trash?" : "Discard Changes Permanently?"}
          </DialogTitle>
          <DialogDescription>
            {disposition === "trash"
              ? "This asks the server to move these files to the OS trash. If trash is unavailable, no affected path is permanently discarded without another confirmation."
              : "The server reported that OS trash is unavailable for these paths. Confirming permanently discards their changes and cannot be undone."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 overscroll-contain overflow-y-auto px-6 pb-4">
          <ul aria-label="Files to discard" className="space-y-1 text-sm">
            {visiblePaths.map((path) => (
              <li className="break-words font-mono text-xs" key={path}>
                {path}
              </li>
            ))}
          </ul>
          {hiddenCount > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">and {hiddenCount} more</p>
          ) : null}
          {errorMessage === null ? null : (
            <p aria-live="polite" className="mt-3 text-sm text-destructive">
              {errorMessage}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button autoFocus disabled={busy} variant="outline" onClick={cancel}>
            Cancel
          </Button>
          <Button
            disabled={busy || paths.length === 0}
            variant="destructive"
            onClick={() => void confirm()}
          >
            {busy
              ? "Discarding…"
              : disposition === "trash"
                ? "Move to Trash"
                : "Discard Permanently"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
