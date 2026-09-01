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

export interface GitManagerSwitchWithChangesDialogProps {
  readonly open: boolean;
  readonly branchName: string;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onResolve: (resolution: { readonly strategy: "stash" | "bring" }) => Promise<void>;
}

export const GitManagerSwitchWithChangesDialog = memo(function GitManagerSwitchWithChangesDialog({
  open,
  branchName,
  busy,
  onOpenChange,
  onResolve,
}: GitManagerSwitchWithChangesDialogProps) {
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
            <strong>Leave my changes</strong> creates an ordinary, visible stash entry, then
            switches branches. The stash appears in the repository&apos;s normal stash list.
          </p>
          <p>
            <strong>Bring my changes</strong> switches branches while carrying the current
            working-tree changes across.
          </p>
        </div>
        <DialogFooter>
          <Button disabled={busy} variant="outline" onClick={leaveChanges}>
            Leave my changes
          </Button>
          <Button disabled={busy} onClick={bringChanges}>
            Bring my changes
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
