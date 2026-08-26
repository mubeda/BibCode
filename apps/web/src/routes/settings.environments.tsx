import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@bibcode/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EyeOffIcon, PlusIcon, ServerIcon } from "lucide-react";

import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { environmentCatalog } from "../connection/catalog";

interface EnvironmentSettingsRecord {
  readonly environmentId: EnvironmentId;
  readonly alias: string | null;
  readonly hidden: boolean;
  readonly descriptor: { readonly label: string } | null;
}

export interface EnvironmentSettingsRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly canonicalLabel: string | null;
  readonly hidden: boolean;
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
    }))
    .toSorted(
      (left, right) =>
        Number(left.hidden) - Number(right.hidden) || left.label.localeCompare(right.label),
    );
}

function EnvironmentRow({ row }: { readonly row: EnvironmentSettingsRow }) {
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
          known.map((row) => <EnvironmentRow key={row.environmentId} row={row} />)
        )}
      </SettingsSection>

      <SettingsSection title="Hidden environments">
        {hidden.length === 0 ? (
          <EmptyEnvironmentList hidden />
        ) : (
          hidden.map((row) => <EnvironmentRow key={row.environmentId} row={row} />)
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/environments")({
  component: SettingsEnvironmentsRoute,
});
