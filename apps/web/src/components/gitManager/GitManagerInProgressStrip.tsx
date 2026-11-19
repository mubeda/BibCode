import type { GitManagerBlockedReason, GitManagerInProgressOperation } from "@bibcode/contracts";
import { AlertTriangleIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import { Button } from "~/components/ui/button";
import { GitManagerDisabledReasonButton } from "./GitManagerDisabledReasonButton";
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
  /** Disables Continue and Abort (busy, missing capability). */
  readonly disabledReason?: string | null;
  /** Disables only Continue, e.g. while conflicts remain; Abort stays available. */
  readonly continueDisabledReason?: string | null;
  readonly continueLabel?: string;
}

export const GitManagerInProgressStrip = memo(function GitManagerInProgressStrip({
  operation,
  onContinue,
  onAbort,
  blocked,
  disabledReason = null,
  continueDisabledReason = null,
  continueLabel = "Continue",
}: GitManagerInProgressStripProps) {
  const [abortConfirmationOpen, setAbortConfirmationOpen] = useState(false);
  const presentation = describeInProgressOperation(operation);
  const continueReason = disabledReason ?? continueDisabledReason;
  const blockedReason = continueReason ?? resolveInProgressBlockedReason(blocked);
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
          <GitManagerDisabledReasonButton
            disabledReason={continueReason}
            size="xs"
            variant="outline"
            onClick={onContinue}
          >
            {continueLabel}
          </GitManagerDisabledReasonButton>
          <GitManagerDisabledReasonButton
            disabledReason={disabledReason}
            size="xs"
            variant="destructive-outline"
            onClick={requestAbort}
          >
            Abort
          </GitManagerDisabledReasonButton>
        </div>
        {blockedReason === null ? null : (
          <p className="mt-1 text-xs text-muted-foreground">{blockedReason}</p>
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
