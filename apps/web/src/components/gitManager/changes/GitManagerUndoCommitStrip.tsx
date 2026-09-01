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
import { formatRelativeTimeLabel } from "~/timestampFormat";

export interface GitManagerUndoCommitStripProps {
  readonly committedAtMs: number;
  readonly isAmending: boolean;
  readonly isBusy: boolean;
  readonly isMerge: boolean;
  readonly workingTreeDirty: boolean;
  readonly onUndo: () => Promise<void>;
}

export const GitManagerUndoCommitStrip = memo(function GitManagerUndoCommitStrip({
  committedAtMs,
  isAmending,
  isBusy,
  isMerge,
  workingTreeDirty,
  onUndo,
}: GitManagerUndoCommitStripProps) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const undoingRef = useRef(false);
  const openConfirmation = useCallback(() => setConfirmationOpen(true), []);
  const closeConfirmation = useCallback(() => setConfirmationOpen(false), []);
  const handleOpenChange = useCallback((open: boolean) => setConfirmationOpen(open), []);
  const confirmUndo = useCallback(async () => {
    if (undoingRef.current) return;
    undoingRef.current = true;
    setIsUndoing(true);
    try {
      await onUndo();
      setConfirmationOpen(false);
    } catch {
      // The owner renders the typed failure and the confirmation stays open.
    } finally {
      undoingRef.current = false;
      setIsUndoing(false);
    }
  }, [onUndo]);

  if (isAmending || isBusy) return null;

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span>Committed {formatRelativeTimeLabel(new Date(committedAtMs).toISOString())}</span>
        <Button size="xs" variant="ghost" onClick={openConfirmation}>
          Undo
        </Button>
      </div>
      <Dialog open={confirmationOpen} onOpenChange={handleOpenChange}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Undo Latest Commit?</DialogTitle>
            <DialogDescription>
              This moves the latest commit&apos;s changes back into the working tree. No files are
              deleted.
              {isMerge ? " This merge commit will be reset to its first parent." : ""}
              {workingTreeDirty
                ? " Your current working tree changes will remain and may be combined with the restored changes."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button autoFocus disabled={isUndoing} variant="outline" onClick={closeConfirmation}>
              Cancel
            </Button>
            <Button disabled={isUndoing} variant="destructive" onClick={() => void confirmUndo()}>
              {isUndoing ? "Undoing…" : "Undo Commit"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
