import { memo, useCallback } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

export type GitManagerResetMode = "hard" | "mixed" | "soft";

export interface GitManagerResetDialogProps {
  readonly sha: string | null;
  readonly disabledReason?: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (mode: GitManagerResetMode) => void;
}

export const GitManagerResetDialog = memo(function GitManagerResetDialog({
  sha,
  disabledReason = null,
  onClose,
  onConfirm,
}: GitManagerResetDialogProps) {
  const resetSoft = useCallback(() => onConfirm("soft"), [onConfirm]);
  const resetMixed = useCallback(() => onConfirm("mixed"), [onConfirm]);
  const resetHard = useCallback(() => onConfirm("hard"), [onConfirm]);

  return (
    <Dialog open={sha !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Reset to {sha?.slice(0, 7)}?</DialogTitle>
          <DialogDescription>
            Move the current branch to this commit. Choose whether to keep or discard later changes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 px-6 pb-4 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Keep all changes</strong> leaves later changes
            staged.
          </p>
          {disabledReason === null ? null : (
            <p id="git-manager-reset-disabled-reason">{disabledReason}</p>
          )}
          <p>
            <strong className="text-foreground">Keep changes unstaged</strong> preserves the files
            but clears their staging state.
          </p>
          <p>
            <strong className="text-foreground">Discard changes and reset</strong> permanently
            removes later commits and local file changes.
          </p>
        </div>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            aria-describedby={
              disabledReason === null ? undefined : "git-manager-reset-disabled-reason"
            }
            disabled={disabledReason !== null}
            title={disabledReason ?? undefined}
            variant="outline"
            onClick={resetSoft}
          >
            Keep All Changes
          </Button>
          <Button
            aria-describedby={
              disabledReason === null ? undefined : "git-manager-reset-disabled-reason"
            }
            disabled={disabledReason !== null}
            title={disabledReason ?? undefined}
            variant="outline"
            onClick={resetMixed}
          >
            Keep Changes Unstaged
          </Button>
          <Button
            aria-describedby={
              disabledReason === null ? undefined : "git-manager-reset-disabled-reason"
            }
            disabled={disabledReason !== null}
            title={disabledReason ?? undefined}
            variant="destructive"
            onClick={resetHard}
          >
            Discard Changes and Reset
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
