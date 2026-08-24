import type {
  DesktopBridge,
  DesktopUpdateProtection,
  DesktopUpdateState,
} from "@bibcode/contracts";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

type InstallUpdate = Pick<DesktopBridge, "installUpdate">["installUpdate"];

interface UpdateProtectionDialogProps {
  readonly open: boolean;
  readonly state: DesktopUpdateState;
  readonly onOpenChange: (open: boolean) => void;
  readonly installUpdate: InstallUpdate;
  readonly onDiagnostics: () => void;
  readonly onError?: (message: string) => void;
}

function protectionLabel(entry: DesktopUpdateProtection, protecting: boolean): string {
  switch (entry.status) {
    case "pending":
      return protecting ? `Protecting ${entry.label}` : `Waiting to protect ${entry.label}`;
    case "protected":
      return `Protected ${entry.label}`;
    case "failed":
      return `Could not protect ${entry.label}`;
    case "excluded":
      return `Excluded ${entry.label}`;
    case "skipped":
      return `Skipped backup for ${entry.label}`;
  }
}

function protectionProgress(entry: DesktopUpdateProtection): string | null {
  if (entry.stage === undefined || entry.stage === null) return null;
  const stage = (() => {
    switch (entry.stage) {
      case "waiting-for-mutations":
        return "Waiting for active operations";
      case "quiescing-runtime":
        return "Stopping active tasks";
      case "acquiring-store-lock":
        return "Preparing the project database";
      case "checkpointing-database":
        return "Checkpointing the project database";
      case "creating-verified-backup":
        return "Creating and verifying the backup";
      case "stopping-backend":
        return "Stopping the local backend";
    }
  })();
  const details = [stage];
  if (entry.blockedOperationCount !== undefined && entry.blockedOperationCount !== null) {
    details.push(
      `${entry.blockedOperationCount} active operation${entry.blockedOperationCount === 1 ? "" : "s"}`,
    );
  }
  if (entry.elapsedMs !== undefined && entry.elapsedMs !== null) {
    details.push(`${Math.floor(entry.elapsedMs / 1_000)}s elapsed`);
  }
  return details.join(" · ");
}

export function UpdateProtectionDialog({
  open,
  state,
  onOpenChange,
  installUpdate,
  onDiagnostics,
  onError,
}: UpdateProtectionDialogProps) {
  const [excludedEnvironmentIds, setExcludedEnvironmentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [skipProtectionAcknowledged, setSkipProtectionAcknowledged] = useState(false);
  const protection = state.protection ?? [];
  const phase = state.phase ?? "idle";
  const protecting = phase === "protecting";
  const working = protecting || phase === "installing" || submitting;
  const primaryFailure = protection.find(
    (entry) => entry.environmentId === "primary" && entry.status === "failed",
  );
  const failedSecondaries = protection.filter(
    (entry) => entry.environmentId !== "primary" && entry.status === "failed",
  );
  const hasProtectionFailure = primaryFailure !== undefined || failedSecondaries.length > 0;
  const exclusionsComplete = failedSecondaries.every((entry) =>
    excludedEnvironmentIds.has(entry.environmentId),
  );

  useEffect(() => {
    if (!open || protecting) {
      setExcludedEnvironmentIds(new Set());
      setSubmitting(false);
      setSkipProtectionAcknowledged(false);
    }
  }, [open, protecting]);

  const installLabel = useMemo(() => {
    if (working) return protecting ? "Protecting projects…" : "Installing update…";
    if (primaryFailure) return "Retry protection";
    if (failedSecondaries.length > 0) return "Install with exclusions";
    if (phase === "failed") return "Retry installation";
    return "Protect projects and install";
  }, [failedSecondaries.length, phase, primaryFailure, protecting, working]);

  const startInstall = async () => {
    if (working || (failedSecondaries.length > 0 && !exclusionsComplete)) return;
    setSubmitting(true);
    try {
      const exclusions = [...excludedEnvironmentIds];
      const result = await installUpdate(
        exclusions.length > 0 ? { excludedEnvironmentIds: exclusions } : undefined,
      );
      if (!result.completed && result.state.message) {
        onError?.(result.state.message);
      }
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "An unexpected error occurred.");
    } finally {
      setSubmitting(false);
    }
  };

  const startUnprotectedInstall = async () => {
    if (working || !hasProtectionFailure || !skipProtectionAcknowledged) return;
    setSubmitting(true);
    try {
      const result = await installUpdate({ skipProtection: true });
      if (!result.completed && result.state.message) {
        onError?.(result.state.message);
      }
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "An unexpected error occurred.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!working) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton={!working}>
        <DialogHeader>
          <DialogTitle>Protect projects before updating</DialogTitle>
          <DialogDescription>
            BiBCode creates a verified project database backup by default before stopping each
            included local backend. Running tasks will be interrupted.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {protection.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The primary project store will be protected before installation begins.
            </p>
          ) : (
            <ul className="space-y-2">
              {protection.map((entry) => (
                <li key={entry.environmentId} className="rounded-lg border p-3 text-sm">
                  <div className="font-medium">{protectionLabel(entry, protecting)}</div>
                  {entry.message ? (
                    <p className="mt-1 text-xs text-muted-foreground">{entry.message}</p>
                  ) : null}
                  {entry.status === "pending" && protectionProgress(entry) ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {protectionProgress(entry)}
                    </p>
                  ) : null}
                  {entry.status === "failed" && entry.environmentId !== "primary" ? (
                    <label className="mt-2 flex items-center gap-2">
                      <Checkbox
                        aria-label={`Exclude ${entry.label}`}
                        checked={excludedEnvironmentIds.has(entry.environmentId)}
                        disabled={working}
                        onCheckedChange={(checked) => {
                          setExcludedEnvironmentIds((current) => {
                            const next = new Set(current);
                            if (checked) next.add(entry.environmentId);
                            else next.delete(entry.environmentId);
                            return next;
                          });
                        }}
                      />
                      <span>Exclude {entry.label} from this update</span>
                    </label>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {hasProtectionFailure ? (
            <div
              aria-label="Continue without a backup"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
              role="group"
            >
              <p className="font-medium">Continue without a backup</p>
              <p className="mt-1 text-xs text-muted-foreground">
                This update will stop local backends without creating a verified rollback backup.
              </p>
              <label className="mt-2 flex items-center gap-2">
                <Checkbox
                  aria-label="Acknowledge update without backup"
                  checked={skipProtectionAcknowledged}
                  disabled={working}
                  onCheckedChange={setSkipProtectionAcknowledged}
                />
                <span>I understand that this update will not create a backup</span>
              </label>
              <div className="mt-3 flex justify-end">
                <Button
                  className="w-full sm:w-auto"
                  variant="destructive"
                  disabled={working || !skipProtectionAcknowledged}
                  onClick={() => void startUnprotectedInstall()}
                >
                  Install without backup
                </Button>
              </div>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={working} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {primaryFailure ? (
            <Button variant="outline" disabled={working} onClick={onDiagnostics}>
              Diagnostics
            </Button>
          ) : null}
          <Button
            disabled={working || (failedSecondaries.length > 0 && !exclusionsComplete)}
            onClick={() => void startInstall()}
          >
            {installLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
