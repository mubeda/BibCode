import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { isRemoteUpdateRunActive } from "@bibcode/client-runtime/state/remoteUpdateCoordinator";
import { useContext, useMemo, useState } from "react";

import { APP_VERSION } from "~/branding";
import { cn } from "~/lib/utils";
import {
  dismissProviderUpdateAll,
  isProviderUpdateAllRunActive,
  providerUpdateAllRun,
  startProviderUpdateAll,
} from "~/state/providerUpdateAll";
import { useEnvironmentQuery } from "~/state/query";
import { remoteUpdateEnvironment } from "~/state/remoteUpdates";
import {
  DISCONNECTED_ENVIRONMENT_REASON,
  initialProviderUpdateAllRows,
  planProviderUpdates,
  type ProviderUpdateAllRow,
  type ProviderUpdatePlan,
  type ProviderUpdatePlanEnvironment,
  type ServerInstallTarget,
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
import { remoteUpdateConfirmation, remoteUpdateProgressLabel } from "./remoteUpdatePresentation";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function planEnvironmentCount(plan: ProviderUpdatePlan): number {
  return plan.environments.filter(
    (environment) => environment.updates.length > 0 || environment.server?.kind === "install",
  ).length;
}

function planSummary(plan: ProviderUpdatePlan): string {
  const parts = [
    ...(plan.updateCount > 0 ? [count(plan.updateCount, "provider update")] : []),
    ...(plan.serverInstallCount > 0 ? [count(plan.serverInstallCount, "server update")] : []),
  ];
  return parts.length === 0
    ? "Nothing here updates in one click."
    : `${parts.join(" and ")} on ${count(planEnvironmentCount(plan), "environment")}.`;
}

function confirmLabel(plan: ProviderUpdatePlan): string {
  const parts = [
    ...(plan.updateCount > 0 ? [count(plan.updateCount, "provider")] : []),
    ...(plan.serverInstallCount > 0 ? [count(plan.serverInstallCount, "server")] : []),
  ];
  return `Update ${parts.join(" and ")}`;
}

function statusText(row: ProviderUpdateAllRow): string {
  switch (row.status) {
    case "queued":
      return "Queued";
    case "updating":
      return "Updating…";
    case "updated":
      return row.message ?? "Updated";
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

/**
 * What a server install will stop, read only while the confirmation is open. The
 * counts are advice: a pending or failed read never blocks confirming.
 */
function ServerInstallNotice({
  environment,
  server,
}: {
  readonly environment: ProviderUpdatePlanEnvironment;
  readonly server: ServerInstallTarget;
}) {
  const work = useEnvironmentQuery(
    server.progress
      ? remoteUpdateEnvironment.activeWork({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const { lines } = remoteUpdateConfirmation({
    name: environment.label,
    targetVersion: server.targetVersion,
    activeWork: server.progress && work.error === null ? work.data : null,
    counting: server.progress && work.isPending && work.data === null,
    appVersion: APP_VERSION,
  });
  return lines.map((line) => (
    <p key={line} className="text-xs text-muted-foreground">
      {line}
    </p>
  ));
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
  const servers = plan.serverInstallCount > 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {servers ? "Update every environment?" : "Update providers on every environment?"}
          </DialogTitle>
          <DialogDescription>
            Each environment installs its own updates. New sessions use the new versions.
            {servers ? " A server restarts only after its providers update." : ""}
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
                {environment.server?.kind === "install" ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · Server v{environment.server.targetVersion}
                  </span>
                ) : null}
                {environment.skipped.map((skip) => (
                  <p key={skip.provider.instanceId} className="text-xs text-muted-foreground">
                    Skipped: {skip.reason}
                  </p>
                ))}
                {environment.server?.kind === "install" ? (
                  <ServerInstallNotice environment={environment} server={environment.server} />
                ) : environment.server?.kind === "skipped" ? (
                  <p className="text-xs text-muted-foreground">
                    Server skipped: {environment.server.reason}
                  </p>
                ) : null}
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
            {confirmLabel(plan)}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A server row while its install runs shows the shared run's own progress. */
function ServerRowStatus({ row }: { readonly row: ProviderUpdateAllRow }) {
  const run = useAtomValue(remoteUpdateEnvironment.run(row.environmentId));
  const progress =
    isRemoteUpdateRunActive(run) && run !== null ? remoteUpdateProgressLabel(run) : null;
  return <>{progress ?? statusText(row)}</>;
}

function ProviderUpdateAllRows({ rows }: { readonly rows: ReadonlyArray<ProviderUpdateAllRow> }) {
  return (
    <ul className="grid gap-1.5">
      {rows.map((row) => (
        <li
          key={`${row.environmentId}:${row.subject}`}
          className="flex items-start justify-between gap-3 text-sm"
          data-provider-update-all-row={row.environmentId}
          data-status={row.status}
          data-subject={row.subject}
        >
          <span className="min-w-0">
            <span className="font-medium text-foreground">{row.label}</span>
            <span className="text-muted-foreground"> · {row.detail}</span>
          </span>
          <span
            className={cn(
              "flex min-w-0 shrink items-center gap-1.5 text-right text-xs",
              statusTone(row),
            )}
          >
            {row.status === "updating" ? <Spinner className="size-3.5" /> : null}
            {row.subject === "server" && row.status === "updating" ? (
              <ServerRowStatus row={row} />
            ) : (
              statusText(row)
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One action that updates outdated providers on every connected environment,
 * remote ones included, then each remote server with an update available, and
 * keeps the per-environment result until cleared.
 */
export function ProviderUpdateAllSection() {
  const registry = useContext(RegistryContext);
  const environments = useProviderUpdateEnvironments();
  const plan = useMemo(() => planProviderUpdates(environments), [environments]);
  const rows = useAtomValue(providerUpdateAllRun);
  const [confirming, setConfirming] = useState(false);
  const running = isProviderUpdateAllRunActive(rows);
  const runnable = plan.updateCount + plan.serverInstallCount > 0;
  // Before any run, a plan that can do nothing still says why for each environment.
  const skippedRows = useMemo(
    () => (rows === null && !runnable ? initialProviderUpdateAllRows(plan) : null),
    [plan, rows, runnable],
  );

  if (rows === null && plan.environments.length === 0 && plan.disconnected.length === 0) {
    return null;
  }

  return (
    <SettingsSection title="Provider updates">
      <SettingsRow
        title="Update all environments"
        description={running ? "Updating…" : planSummary(plan)}
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={running || !runnable}
            onClick={() => setConfirming(true)}
          >
            Update all…
          </Button>
        }
      >
        {rows === null ? (
          skippedRows === null || skippedRows.length === 0 ? null : (
            <div className="mt-3 border-t border-border/60 py-2">
              <ProviderUpdateAllRows rows={skippedRows} />
            </div>
          )
        ) : (
          <div className="mt-3 border-t border-border/60 py-2">
            <ProviderUpdateAllRows rows={rows} />
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
