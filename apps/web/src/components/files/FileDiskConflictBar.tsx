import { TriangleAlert } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

import type { FileDiskConflict } from "./fileEditingSession";

export interface FileDiskConflictBarProps {
  readonly conflict: FileDiskConflict;
  /**
   * Reloading would discard edits no editor can bring back with Undo (the rendered Markdown
   * view, or a file deleted on disk), so it asks first.
   */
  readonly confirmReload: boolean;
  readonly onReload: () => void;
  readonly onOverwrite: () => void;
}

/** The reason Save is disabled while a conflict stands. */
export function fileDiskConflictSaveReason(conflict: FileDiskConflict): string {
  return conflict.reason === "deleted"
    ? "Deleted on disk. Choose Reload from disk or Overwrite disk."
    : conflict.reason === "unreadable"
      ? "Changed on disk. Choose Overwrite disk to save your version."
      : "Changed on disk. Choose Reload from disk or Overwrite disk.";
}

function conflictDetail(conflict: FileDiskConflict): string | null {
  // Both choices wait for this check, which a refused save starts at once.
  if (!conflict.diskKnown) return "Checking the file on disk…";
  if (conflict.reason !== "unreadable") return null;
  return conflict.unreadable === "binary_file"
    ? "It is now a binary file and cannot be opened here."
    : "It is now over 1 MB and cannot be edited here.";
}

/**
 * One line under the editor toolbar, shown while the file on disk changed under unsaved edits
 * (or became unreadable): the user picks which version wins, and nothing is saved until then.
 */
export function FileDiskConflictBar({
  conflict,
  confirmReload,
  onReload,
  onOverwrite,
}: FileDiskConflictBarProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canReload = conflict.reason !== "unreadable";
  const detail = conflictDetail(conflict);

  return (
    <div
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200"
      data-file-disk-conflict={conflict.reason}
      role="status"
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium">
          {conflict.reason === "deleted" ? "Deleted on disk." : "Changed on disk."}
        </span>
        {detail ? <span className="truncate">{detail}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {canReload ? (
          <Button
            disabled={!conflict.diskKnown}
            size="xs"
            variant="outline"
            onClick={() => {
              if (confirmReload) setConfirmOpen(true);
              else onReload();
            }}
          >
            Reload from disk
          </Button>
        ) : null}
        <Button disabled={!conflict.diskKnown} size="xs" variant="outline" onClick={onOverwrite}>
          Overwrite disk
        </Button>
      </span>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your unsaved edits?</AlertDialogTitle>
            <AlertDialogDescription>
              {conflict.reason === "deleted"
                ? "The file was deleted on disk. Your edits cannot be recovered."
                : "The file shows its version on disk. Your edits cannot be recovered."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onReload();
              }}
            >
              Discard edits
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
