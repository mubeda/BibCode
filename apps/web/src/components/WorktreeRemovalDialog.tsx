import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import type {
  AdoptedWorktreeAvailability,
  EnvironmentId,
  ProjectId,
  ThreadId,
  VcsWorktreeRegistrationState,
  WorktreeRemovalMode,
  WorktreeRemovalPlan,
  WorktreeRemovalResult,
} from "@bibcode/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { newCommandId } from "../lib/utils";
import { worktreeEnvironment } from "../state/worktrees";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export interface WorktreeRemovalTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly path: string;
  readonly branch: string | null;
  readonly availability: AdoptedWorktreeAvailability;
  readonly registrationState: VcsWorktreeRegistrationState | null;
  readonly locked: boolean;
  readonly lockReason?: string;
}

export interface WorktreeRemovalDialogProps {
  readonly open: boolean;
  readonly target: WorktreeRemovalTarget | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRemoved: (target: WorktreeRemovalTarget, result: WorktreeRemovalResult) => void;
}

type ConfirmationStep = "choices" | "dirty" | "prune";

function failureMessage(result: { readonly cause: unknown }): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The removal request failed.";
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

export function WorktreeRemovalDialog({
  open,
  target,
  onOpenChange,
  onRemoved,
}: WorktreeRemovalDialogProps) {
  const getRemovalPlan = useAtomCommand(worktreeEnvironment.getRemovalPlan, {
    reportFailure: false,
  });
  const removeFromBibCode = useAtomCommand(worktreeEnvironment.removeFromBibCode, {
    reportFailure: false,
  });
  const remove = useAtomCommand(worktreeEnvironment.remove, { reportFailure: false });
  const [plan, setPlan] = useState<WorktreeRemovalPlan | null>(null);
  const [step, setStep] = useState<ConfirmationStep>("choices");
  const [isLoadingPlan, setIsLoadingPlan] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planChanged, setPlanChanged] = useState(false);
  const [completed, setCompleted] = useState<WorktreeRemovalResult | null>(null);
  const asyncEpochRef = useRef(0);

  const loadPlanForTarget = useCallback(
    async (requestTarget: WorktreeRemovalTarget, epoch: number) => {
      setIsLoadingPlan(true);
      setError(null);
      const result = await getRemovalPlan({
        environmentId: requestTarget.environmentId,
        input: { projectId: requestTarget.projectId, threadId: requestTarget.threadId },
      });
      if (epoch !== asyncEpochRef.current) return;
      setIsLoadingPlan(false);
      if (result._tag === "Failure") {
        setError(failureMessage(result));
        return;
      }
      setPlan(result.value);
    },
    [getRemovalPlan],
  );

  useEffect(() => {
    const epoch = asyncEpochRef.current + 1;
    asyncEpochRef.current = epoch;
    setPlan(null);
    setStep("choices");
    setIsLoadingPlan(false);
    setIsRemoving(false);
    setError(null);
    setPlanChanged(false);
    setCompleted(null);
    if (open && target && target.availability !== "removing") {
      void loadPlanForTarget(target, epoch);
    }
    return () => {
      if (asyncEpochRef.current === epoch) {
        asyncEpochRef.current += 1;
      }
    };
  }, [loadPlanForTarget, open, target]);

  const retryLoadPlan = useCallback(() => {
    if (!target || target.availability === "removing") return;
    const epoch = asyncEpochRef.current + 1;
    asyncEpochRef.current = epoch;
    void loadPlanForTarget(target, epoch);
  }, [loadPlanForTarget, target]);

  const finishRemoval = useCallback(
    (
      requestTarget: WorktreeRemovalTarget,
      result: WorktreeRemovalResult,
      showCompletion: boolean,
    ) => {
      if (showCompletion) setCompleted(result);
      onRemoved(requestTarget, result);
    },
    [onRemoved],
  );

  const detach = useCallback(async () => {
    if (!target || isRemoving) return;
    const requestTarget = target;
    const epoch = asyncEpochRef.current + 1;
    asyncEpochRef.current = epoch;
    setIsRemoving(true);
    setError(null);
    const result = await removeFromBibCode({
      environmentId: requestTarget.environmentId,
      input: {
        commandId: newCommandId(),
        projectId: requestTarget.projectId,
        threadId: requestTarget.threadId,
      },
    });
    const isCurrent = epoch === asyncEpochRef.current;
    if (isCurrent) setIsRemoving(false);
    if (result._tag === "Failure") {
      if (isCurrent) setError(failureMessage(result));
      return;
    }
    finishRemoval(requestTarget, result.value, isCurrent);
  }, [finishRemoval, isRemoving, removeFromBibCode, target]);

  const executeDestructiveRemoval = useCallback(
    async (mode: WorktreeRemovalMode, forceDirty: boolean, confirmPrune: boolean) => {
      if (!target || !plan || isRemoving) return;
      const requestTarget = target;
      const requestPlan = plan;
      const epoch = asyncEpochRef.current + 1;
      asyncEpochRef.current = epoch;
      setIsRemoving(true);
      setError(null);
      setPlanChanged(false);
      const result = await remove({
        environmentId: requestTarget.environmentId,
        input: {
          commandId: newCommandId(),
          projectId: requestTarget.projectId,
          threadId: requestTarget.threadId,
          mode,
          expectedGeneration: requestPlan.generation,
          planToken: requestPlan.planToken,
          forceDirty,
          confirmRepositoryWidePrune: confirmPrune,
        },
      });
      const isCurrent = epoch === asyncEpochRef.current;
      if (isCurrent) setIsRemoving(false);
      if (result._tag === "Failure") {
        if (isCurrent) setError(failureMessage(result));
        return;
      }
      if (result.value._tag === "PlanChanged") {
        if (!isCurrent) return;
        setPlan(result.value.plan);
        setPlanChanged(true);
        setStep("choices");
        return;
      }
      finishRemoval(requestTarget, result.value.result, isCurrent);
    },
    [finishRemoval, isRemoving, plan, remove, target],
  );

  const beginDestructiveRemoval = useCallback(() => {
    if (!plan) return;
    if (plan.trackedChangeCount > 0 || plan.untrackedFileCount > 0) {
      setStep("dirty");
      return;
    }
    if (plan.pruneImpact.length > 0) {
      setStep("prune");
      return;
    }
    void executeDestructiveRemoval(
      plan.availability === "missing-registered"
        ? "cleanup-stale-registration"
        : "delete-git-worktree",
      false,
      false,
    );
  }, [executeDestructiveRemoval, plan]);

  const confirmDirty = useCallback(() => {
    if (!plan) return;
    if (plan.pruneImpact.length > 0) {
      setStep("prune");
      return;
    }
    void executeDestructiveRemoval(
      plan.availability === "missing-registered"
        ? "cleanup-stale-registration"
        : "delete-git-worktree",
      true,
      false,
    );
  }, [executeDestructiveRemoval, plan]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && isRemoving) return;
      onOpenChange(nextOpen);
    },
    [isRemoving, onOpenChange],
  );
  const removalUnavailable = target?.availability === "removing";
  const hasDirtyChanges =
    plan !== null && (plan.trackedChangeCount > 0 || plan.untrackedFileCount > 0);
  const destructiveLabel =
    plan?.availability === "missing-registered"
      ? "Clean stale Git registration and remove"
      : "Delete Git worktree and remove";
  const destructiveEligible =
    plan !== null &&
    !plan.locked &&
    (plan.availability === "present" ||
      (plan.availability === "missing-registered" && plan.registered));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-xl" showCloseButton={!isRemoving}>
        <DialogHeader>
          <DialogTitle>Remove worktree</DialogTitle>
          <DialogDescription>
            Choose whether to remove only BiBCode history or also modify Git.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {target ? (
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="font-medium">Workspace</dt>
                <dd>{target.title}</dd>
              </div>
              <div>
                <dt className="font-medium">Last-known branch</dt>
                <dd>{target.branch ?? "Detached HEAD"}</dd>
              </div>
              <div>
                <dt className="font-medium">Path</dt>
                <dd className="break-all font-mono text-xs">{target.path}</dd>
              </div>
              <div>
                <dt className="font-medium">Git registration</dt>
                <dd>
                  {(plan?.registered ?? target.registrationState !== null)
                    ? "Registration remains"
                    : "Not registered"}
                </dd>
              </div>
            </dl>
          ) : null}

          {removalUnavailable ? (
            <p role="status" className="text-sm text-muted-foreground">
              Removal is already in progress.
            </p>
          ) : null}
          {isLoadingPlan ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading removal details…
            </p>
          ) : null}
          {planChanged ? (
            <p role="alert" className="text-sm text-warning">
              Removal details changed. Review the updated plan before continuing.
            </p>
          ) : null}
          {step === "choices" && hasDirtyChanges && plan ? (
            <p className="text-sm text-warning">
              Local changes detected: {plural(plan.trackedChangeCount, "tracked change")} and{" "}
              {plural(plan.untrackedFileCount, "untracked file")}.
            </p>
          ) : null}
          {error ? (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={retryLoadPlan}>
                Retry removal details
              </Button>
            </div>
          ) : null}
          {(plan?.locked || target?.locked) && !completed ? (
            <p role="alert" className="text-sm text-warning">
              Git cleanup is unavailable because this registration is locked
              {(plan?.lockReason ?? target?.lockReason)
                ? `: ${plan?.lockReason ?? target?.lockReason}`
                : "."}
            </p>
          ) : null}

          {completed ? (
            <div role="status" className="space-y-2 text-sm">
              <p className="font-medium">Removed from BiBCode</p>
              {completed.gitOutcome === "failed" || completed.orphanCleanupPending ? (
                <p className="text-warning">
                  Git cleanup still needs attention. {completed.detail ?? "Clean it up manually."}
                </p>
              ) : completed.detail ? (
                <p>{completed.detail}</p>
              ) : null}
            </div>
          ) : step === "dirty" && plan ? (
            <div role="alert" className="space-y-2 text-sm">
              <p className="font-medium">This worktree contains local changes.</p>
              <p>
                Deleting it discards {plural(plan.trackedChangeCount, "tracked change")} and{" "}
                {plural(plan.untrackedFileCount, "untracked file")}.
              </p>
            </div>
          ) : step === "prune" && plan ? (
            <div role="alert" className="space-y-2 text-sm">
              <p className="font-medium">Repository-wide prune affects these registrations:</p>
              <ul className="list-disc space-y-2 pl-5">
                {plan.pruneImpact.map((impact) => (
                  <li key={`${impact.path}:${impact.pruneReason}`}>
                    <span className="block break-all font-mono text-xs">{impact.path}</span>
                    <span>{impact.pruneReason}</span>
                    {impact.lockReason ? <span> — {impact.lockReason}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {completed ? (
            <Button type="button" onClick={close}>
              Close
            </Button>
          ) : step === "dirty" ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={isRemoving}
                onClick={() => setStep("choices")}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={isRemoving}
                onClick={confirmDirty}
              >
                Delete dirty worktree
              </Button>
            </>
          ) : step === "prune" && plan ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={isRemoving}
                onClick={() => setStep("choices")}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={isRemoving}
                onClick={() =>
                  void executeDestructiveRemoval(
                    plan.availability === "missing-registered"
                      ? "cleanup-stale-registration"
                      : "delete-git-worktree",
                    hasDirtyChanges,
                    true,
                  )
                }
              >
                Confirm repository-wide prune
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" disabled={isRemoving} onClick={close}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={isRemoving || removalUnavailable || target === null}
                onClick={() => void detach()}
              >
                Remove from BiBCode
              </Button>
              {destructiveEligible ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isRemoving}
                  onClick={beginDestructiveRemoval}
                >
                  {destructiveLabel}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
