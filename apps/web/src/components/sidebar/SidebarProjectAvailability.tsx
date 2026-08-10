import type { EnvironmentId } from "@bibcode/contracts";

import type { SidebarProjectAvailabilityView } from "../Sidebar.logic";
import { Button } from "../ui/button";

export interface SidebarProjectAvailabilityProps {
  readonly view: SidebarProjectAvailabilityView;
  readonly onRetry: (environmentId: EnvironmentId) => void;
  readonly onOpenSettings: () => void;
  readonly onViewDiagnostics: () => void;
  readonly onAdoptStorage: (environmentId: EnvironmentId) => void;
}

function availabilityCopy(view: SidebarProjectAvailabilityView): string | null {
  switch (view.kind) {
    case "available":
      return null;
    case "empty-confirmed":
      return "No projects yet";
    case "loading":
      return "Project data is still loading";
    case "degraded":
      return "Showing cached projects";
    case "storage-changed":
      return "Project data location changed";
    case "recovery-required":
      return "Project data needs recovery";
    case "unavailable":
      return "Projects are unavailable";
    case "configuration-error":
      return "Project data configuration needs attention";
  }
}

export function SidebarProjectAvailability({
  view,
  onRetry,
  onOpenSettings,
  onViewDiagnostics,
  onAdoptStorage,
}: SidebarProjectAvailabilityProps) {
  const copy = availabilityCopy(view);
  if (copy === null) {
    return null;
  }
  const canActOnEnvironment = view.environmentId !== null;
  const showRecoveryActions =
    view.kind === "degraded" ||
    view.kind === "storage-changed" ||
    view.kind === "recovery-required" ||
    view.kind === "unavailable" ||
    view.kind === "configuration-error";

  return (
    <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
      <div>{copy}</div>
      {view.kind !== "empty-confirmed" && view.kind !== "loading" && view.error ? (
        <div className="mt-1 break-words">{view.error}</div>
      ) : null}
      {showRecoveryActions && view.hasCachedProjects && view.kind !== "degraded" ? (
        <div className="mt-1">Cached projects remain visible.</div>
      ) : null}
      {showRecoveryActions ? (
        <div className="mt-2 flex flex-wrap justify-center gap-1">
          {canActOnEnvironment ? (
            <Button size="xs" variant="ghost" onClick={() => onRetry(view.environmentId!)}>
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={onOpenSettings}>
            Settings
          </Button>
          <Button size="xs" variant="ghost" onClick={onViewDiagnostics}>
            Diagnostics
          </Button>
          {view.kind === "storage-changed" && canActOnEnvironment ? (
            <Button size="xs" variant="outline" onClick={() => onAdoptStorage(view.environmentId!)}>
              Use this data location
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
