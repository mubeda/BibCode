import type { GitManagerBlockedReason } from "@bibcode/contracts";
import {
  CloudDownloadIcon,
  CloudUploadIcon,
  GitPullRequestArrowIcon,
  LoaderCircleIcon,
} from "lucide-react";
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

import type { SyncState, SyncStateKind } from "./syncButton.logic";

export type SyncOperationKind = Exclude<SyncStateKind, "running" | "no-remote" | "detached">;

export interface GitManagerSyncButtonProps {
  readonly state: SyncState;
  readonly currentBranchName: string | null;
  readonly remote: string;
  readonly blockedReason: GitManagerBlockedReason | null;
  readonly onOperation: (kind: SyncOperationKind) => void;
}

function SyncIcon({ kind }: { readonly kind: SyncStateKind }) {
  if (kind === "running") {
    return <LoaderCircleIcon aria-hidden="true" className="animate-spin" />;
  }
  if (kind === "push" || kind === "publish-branch" || kind === "force-push") {
    return <CloudUploadIcon aria-hidden="true" />;
  }
  if (kind === "pull") {
    return <GitPullRequestArrowIcon aria-hidden="true" />;
  }
  return <CloudDownloadIcon aria-hidden="true" />;
}

export const GitManagerSyncButton = memo(function GitManagerSyncButton({
  state,
  currentBranchName,
  remote,
  blockedReason,
  onOperation,
}: GitManagerSyncButtonProps) {
  const [confirmForcePush, setConfirmForcePush] = useState(false);
  const disabledReason = blockedReason?.message ?? state.disabledReason;
  const disabled = disabledReason !== null;
  const descriptionId = disabled ? "git-manager-sync-disabled-reason" : undefined;
  const activate = useCallback(() => {
    if (disabled) return;
    if (state.kind === "force-push") {
      setConfirmForcePush(true);
      return;
    }
    if (state.kind === "running" || state.kind === "no-remote" || state.kind === "detached") {
      return;
    }
    onOperation(state.kind);
  }, [disabled, onOperation, state.kind]);
  const confirm = useCallback(() => {
    setConfirmForcePush(false);
    onOperation("force-push");
  }, [onOperation]);

  return (
    <>
      <button
        aria-describedby={descriptionId}
        className="inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 disabled:opacity-60"
        disabled={disabled}
        title={disabledReason ?? undefined}
        type="button"
        onClick={activate}
      >
        <SyncIcon kind={state.kind} />
        <span className="truncate">{state.label}</span>
        {state.ahead > 0 ? (
          <span
            aria-label={`${state.ahead} ahead`}
            className="rounded bg-muted px-1 font-mono text-[10px]"
          >
            ↑{state.ahead}
          </span>
        ) : null}
        {state.behind > 0 ? (
          <span
            aria-label={`${state.behind} behind`}
            className="rounded bg-muted px-1 font-mono text-[10px]"
          >
            ↓{state.behind}
          </span>
        ) : null}
      </button>
      {disabledReason === null ? null : (
        <span className="sr-only" id={descriptionId}>
          {disabledReason}
        </span>
      )}
      <Dialog open={confirmForcePush} onOpenChange={setConfirmForcePush}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Force Push {currentBranchName ?? "Branch"}?</DialogTitle>
            <DialogDescription>
              This rewrites {remote}/{currentBranchName ?? "the remote branch"} using
              --force-with-lease. Remote commits that are not present locally will be replaced, and
              the push stops if the remote changed since the last fetch.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmForcePush(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirm}>
              Force push with lease
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
