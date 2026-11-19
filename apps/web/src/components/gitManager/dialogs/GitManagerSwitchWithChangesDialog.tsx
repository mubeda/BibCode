import { memo, useCallback } from "react";

import { GitManagerDisabledReasonButton } from "../GitManagerDisabledReasonButton";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

export interface GitManagerSwitchWithChangesDialogProps {
  readonly open: boolean;
  readonly branchName: string;
  readonly busy: boolean;
  readonly errorMessage?: string | null;
  readonly branchDisabledReason?: string | null;
  readonly stashDisabledReason?: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onResolve: (resolution: { readonly strategy: "stash" | "bring" }) => Promise<void>;
}

export const GitManagerSwitchWithChangesDialog = memo(function GitManagerSwitchWithChangesDialog({
  open,
  branchName,
  busy,
  errorMessage = null,
  branchDisabledReason = null,
  stashDisabledReason = null,
  onOpenChange,
  onResolve,
}: GitManagerSwitchWithChangesDialogProps) {
  const leaveChangesDisabledReason = branchDisabledReason ?? stashDisabledReason;
  const leaveChanges = useCallback(() => void onResolve({ strategy: "stash" }), [onResolve]);
  const bringChanges = useCallback(() => void onResolve({ strategy: "bring" }), [onResolve]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Switch to {branchName}?</DialogTitle>
          <DialogDescription>
            Choose what to do with the uncommitted changes in this checkout.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-4 text-sm">
          <p>
            <strong>Leave my changes</strong> saves them, new files included, in an ordinary,
            visible stash entry, then switches branches. The stash appears in the repository&apos;s
            normal stash list.
          </p>
          <p>
            <strong>Bring my changes</strong> switches branches while carrying the current
            working-tree changes across.
          </p>
          {errorMessage === null ? null : (
            <p role="alert" className="text-destructive">
              {errorMessage}
            </p>
          )}
        </div>
        <DialogFooter>
          <GitManagerDisabledReasonButton
            disabled={busy}
            disabledReason={leaveChangesDisabledReason}
            variant="outline"
            onClick={leaveChanges}
          >
            Leave my changes
          </GitManagerDisabledReasonButton>
          <GitManagerDisabledReasonButton
            disabled={busy}
            disabledReason={branchDisabledReason}
            onClick={bringChanges}
          >
            Bring my changes
          </GitManagerDisabledReasonButton>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
