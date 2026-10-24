import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  dismissProviderUpdateAll,
  isProviderUpdateAllRunActive,
  providerUpdateAllRun,
  startProviderUpdateAll,
} from "~/state/providerUpdateAll";
import {
  DISCONNECTED_ENVIRONMENT_REASON,
  planProviderUpdates,
  type ProviderUpdateAllRow,
  type ProviderUpdatePlan,
} from "../ProviderUpdateAll.logic";
import { formatProviderList } from "../ProviderUpdateLaunchNotification.logic";
import { useProviderUpdateEnvironments } from "../ProviderUpdateLaunchNotification.environments";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function planSummary(plan: ProviderUpdatePlan): string {
  const environments = plan.environments.filter((environment) => environment.updates.length > 0);
  return plan.updateCount === 0
    ? "No provider can update in one click. Open a provider for its update command."
    : `${count(plan.updateCount, "provider update")} on ${count(environments.length, "environment")}.`;
}

function statusText(row: ProviderUpdateAllRow): string {
  switch (row.status) {
    case "queued":
      return "Queued";
    case "updating":
      return "Updating…";
    case "updated":
      return "Updated";
    default:
      return row.message ?? "";
  }
}

function statusTone(row: ProviderUpdateAllRow): string {
  switch (row.status) {
    case "updated":
      return "text-success";
    case "failed":
      return "text-destructive";
    case "unchanged":
      return "text-warning";
    default:
      return "text-muted-foreground";
  }
}

function ConfirmUpdateAllDialog({
  plan,
  onClose,
  onConfirm,
}: {
  readonly plan: ProviderUpdatePlan;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Update providers on every environment?</DialogTitle>
          <DialogDescription>
            Each environment installs its own updates. New sessions use the new versions.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul data-text-surface="background" className="grid gap-2 bg-background text-sm">
            {plan.environments.map((environment) => (
              <li key={environment.environmentId}>
                <span className="font-medium text-foreground">{environment.label}</span>
                {environment.updates.length > 0 ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {formatProviderList(environment.updates)}
                  </span>
                ) : null}
                {environment.skipped.map((skip) => (
                  <p key={skip.provider.instanceId} className="text-xs text-muted-foreground">
                    Skipped: {skip.reason}
                  </p>
                ))}
              </li>
            ))}
            {plan.disconnected.map((environment) => (
              <li key={environment.environmentId}>
                <span className="font-medium text-foreground">{environment.label}</span>
                <span className="text-muted-foreground"> · {environment.providerNames}</span>
                <p className="text-xs text-muted-foreground">
                  Skipped: {DISCONNECTED_ENVIRONMENT_REASON}
                </p>
              </li>
            ))}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Update {count(plan.updateCount, "provider")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * One action that updates outdated providers on every connected environment,
 * remote ones included, and keeps the per-environment result until cleared.
 */
export function ProviderUpdateAllSection() {
  const registry = useContext(RegistryContext);
  const environments = useProviderUpdateEnvironments();
  const plan = useMemo(() => planProviderUpdates(environments), [environments]);
  const rows = useAtomValue(providerUpdateAllRun);
  const [confirming, setConfirming] = useState(false);
  const running = isProviderUpdateAllRunActive(rows);

  if (rows === null && plan.environments.length === 0 && plan.disconnected.length === 0) {
    return null;
  }

  return (
    <SettingsSection title="Provider updates">
      <SettingsRow
        title="Update all environments"
        description={running ? "Updating providers…" : planSummary(plan)}
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={running || plan.updateCount === 0}
            onClick={() => setConfirming(true)}
          >
            Update all…
          </Button>
        }
      >
        {rows === null ? null : (
          <div className="mt-3 border-t border-border/60 py-2">
            <ul className="grid gap-1.5">
              {rows.map((row) => (
                <li
                  key={row.environmentId}
                  className="flex items-start justify-between gap-3 text-sm"
                  data-provider-update-all-row={row.environmentId}
                  data-status={row.status}
                >
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{row.label}</span>
                    <span className="text-muted-foreground"> · {row.providerNames}</span>
                  </span>
                  <span
                    className={cn(
                      "flex min-w-0 shrink items-center gap-1.5 text-right text-xs",
                      statusTone(row),
                    )}
                  >
                    {row.status === "updating" ? <Spinner className="size-3.5" /> : null}
                    {statusText(row)}
                  </span>
                </li>
              ))}
            </ul>
            {running ? null : (
              <div className="mt-2 flex justify-end">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => dismissProviderUpdateAll(registry)}
                >
                  Clear
                </Button>
              </div>
            )}
          </div>
        )}
      </SettingsRow>
      {confirming ? (
        <ConfirmUpdateAllDialog
          plan={plan}
          onClose={() => setConfirming(false)}
          onConfirm={() => startProviderUpdateAll(registry, plan)}
        />
      ) : null}
    </SettingsSection>
  );
}
