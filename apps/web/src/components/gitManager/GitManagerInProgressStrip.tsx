import type { GitManagerBlockedReason, GitManagerInProgressOperation } from "@bibcode/contracts";
import { AlertTriangleIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

import {
  describeInProgressOperation,
  resolveInProgressBlockedReason,
} from "./GitManagerInProgressStrip.logic";

export interface GitManagerInProgressStripProps {
  readonly operation: GitManagerInProgressOperation;
  readonly onContinue: () => void;
  readonly onAbort: () => void;
  readonly blocked: GitManagerBlockedReason | null;
  readonly disabledReason?: string | null;
}

export const GitManagerInProgressStrip = memo(function GitManagerInProgressStrip({
  operation,
  onContinue,
  onAbort,
  blocked,
  disabledReason = null,
}: GitManagerInProgressStripProps) {
  const [abortConfirmationOpen, setAbortConfirmationOpen] = useState(false);
  const presentation = describeInProgressOperation(operation);
  const blockedReason = disabledReason ?? resolveInProgressBlockedReason(blocked);
  const disabledReasonId =
    disabledReason === null ? undefined : "git-manager-in-progress-disabled-reason";
  const requestAbort = useCallback(() => setAbortConfirmationOpen(true), []);
  const confirmAbort = useCallback(() => {
    setAbortConfirmationOpen(false);
    onAbort();
  }, [onAbort]);

  return (
    <>
      <section
        aria-atomic="true"
        className="border-b border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs"
        data-in-progress-kind={operation.kind}
        role="alert"
      >
        <div className="flex min-w-0 items-center gap-2">
          <AlertTriangleIcon aria-hidden="true" className="size-4 shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1 font-medium">
            {presentation.label}
            {presentation.progress === null ? null : (
              <span className="ml-2 font-normal text-muted-foreground">
                {presentation.progress}
              </span>
            )}
          </span>
          <Button
            aria-describedby={disabledReasonId}
            disabled={disabledReason !== null}
            size="xs"
            title={disabledReason ?? undefined}
            variant="outline"
            onClick={onContinue}
          >
            Continue
          </Button>
          <Button
            aria-describedby={disabledReasonId}
            disabled={disabledReason !== null}
            size="xs"
            title={disabledReason ?? undefined}
            variant="destructive-outline"
            onClick={requestAbort}
          >
            Abort
          </Button>
        </div>
        {blockedReason === null ? null : (
          <p className="mt-1 text-[11px] text-muted-foreground" id={disabledReasonId}>
            {blockedReason}
          </p>
        )}
      </section>
      <Dialog open={abortConfirmationOpen} onOpenChange={setAbortConfirmationOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Abort {operation.kind}?</DialogTitle>
            <DialogDescription>
              Abort the repository&apos;s current {operation.kind} operation. Any conflict
              resolution completed for this operation may be discarded.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbortConfirmationOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmAbort}>
              Abort {presentation.actionLabel}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
