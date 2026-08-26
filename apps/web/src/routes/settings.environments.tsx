import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@bibcode/contracts";
import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EyeIcon, EyeOffIcon, PlusIcon, ServerIcon, Trash2Icon } from "lucide-react";

import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { environmentCatalog } from "../connection/catalog";
import { useAtomCommand } from "../state/use-atom-command";

interface EnvironmentSettingsRecord {
  readonly environmentId: EnvironmentId;
  readonly alias: string | null;
  readonly hidden: boolean;
  readonly descriptor: { readonly label: string } | null;
  readonly bindings: ReadonlyArray<{ readonly _tag: string }>;
}

export interface EnvironmentSettingsRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly canonicalLabel: string | null;
  readonly hidden: boolean;
  readonly primary: boolean;
}

export function toEnvironmentSettingsRows(
  environments: Iterable<EnvironmentSettingsRecord>,
): EnvironmentSettingsRow[] {
  return [...environments]
    .map((environment) => ({
      environmentId: environment.environmentId,
      label:
        environment.alias ?? environment.descriptor?.label ?? String(environment.environmentId),
      canonicalLabel: environment.descriptor?.label ?? null,
      hidden: environment.hidden,
      primary: environment.bindings.some((binding) => binding._tag === "DesktopPrimaryBinding"),
    }))
    .toSorted(
      (left, right) =>
        Number(left.hidden) - Number(right.hidden) || left.label.localeCompare(right.label),
    );
}

function EnvironmentRow({
  row,
  onVisibilityChange,
}: {
  readonly row: EnvironmentSettingsRow;
  readonly onVisibilityChange: (row: EnvironmentSettingsRow, hidden: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground">
          {row.hidden ? (
            <EyeOffIcon className="size-3.5" aria-hidden />
          ) : (
            <ServerIcon className="size-3.5" aria-hidden />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{row.label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {row.canonicalLabel !== null && row.canonicalLabel !== row.label
              ? `${row.canonicalLabel} · `
              : ""}
            {row.environmentId}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              to="/environments/$environmentId"
              params={{ environmentId: row.environmentId }}
              search={{ tab: "overview" }}
            />
          }
        >
          Open
        </Button>
        {!row.primary ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onVisibilityChange(row, !row.hidden)}
            >
              {row.hidden ? (
                <EyeIcon className="size-3.5" aria-hidden />
              ) : (
                <EyeOffIcon className="size-3.5" aria-hidden />
              )}
              {row.hidden ? "Restore" : "Hide"}
            </Button>
            <Button
              size="sm"
              variant="destructive-outline"
              render={
                <Link
                  to="/environments/$environmentId/remove"
                  params={{ environmentId: row.environmentId }}
                  search={{ tab: "overview" }}
                />
              }
            >
              <Trash2Icon className="size-3.5" aria-hidden />
              Fully remove…
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function EmptyEnvironmentList({ hidden }: { readonly hidden: boolean }) {
  return (
    <p className="px-5 py-6 text-center text-xs text-muted-foreground">
      {hidden ? "No hidden environments." : "No known environments yet."}
    </p>
  );
}

function SettingsEnvironmentsRoute() {
  const records = useAtomValue(environmentCatalog.environmentRecordsValueAtom);
  const rows = toEnvironmentSettingsRows(records.values());
  const known = rows.filter((row) => !row.hidden);
  const hidden = rows.filter((row) => row.hidden);
  const hideEnvironment = useAtomCommand(environmentCatalog.hide, { reportFailure: false });
  const restoreEnvironment = useAtomCommand(environmentCatalog.restore, { reportFailure: false });

  const changeVisibility = async (row: EnvironmentSettingsRow, hide: boolean) => {
    const command = hide ? hideEnvironment : restoreEnvironment;
    const result = await command(row.environmentId);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: hide ? "Could not hide environment" : "Could not restore environment",
          description:
            error instanceof Error ? error.message : "The client metadata update failed.",
        }),
      );
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: hide ? `${row.label} hidden` : `${row.label} restored`,
        description: hide
          ? "Routes, credentials, cache, and settings remain."
          : "The environment is visible in navigation again.",
        actionProps: {
          children: "Undo",
          onClick: () => void (hide ? restoreEnvironment : hideEnvironment)(row.environmentId),
        },
      }),
    );
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Known environments"
        headerAction={
          <Button size="xs" render={<Link to="/environments/add" />}>
            <PlusIcon className="size-3.5" aria-hidden />
            Add environment
          </Button>
        }
      >
        {known.length === 0 ? (
          <EmptyEnvironmentList hidden={false} />
        ) : (
          known.map((row) => (
            <EnvironmentRow
              key={row.environmentId}
              row={row}
              onVisibilityChange={(candidate, hide) => void changeVisibility(candidate, hide)}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Hidden environments">
        {hidden.length === 0 ? (
          <EmptyEnvironmentList hidden />
        ) : (
          hidden.map((row) => (
            <EnvironmentRow
              key={row.environmentId}
              row={row}
              onVisibilityChange={(candidate, hide) => void changeVisibility(candidate, hide)}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/environments")({
  component: SettingsEnvironmentsRoute,
});
