import type { EnvironmentConnectionPhase } from "@bibcode/client-runtime/connection";
import { EnvironmentId } from "@bibcode/contracts";
import { useEffect } from "react";

import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

// A selected environment in one of these phases is kept: it is connected, or on its way.
const STILL_CONNECTING_PHASES: ReadonlySet<EnvironmentConnectionPhase> = new Set([
  "connected",
  "available",
  "connecting",
  "reconnecting",
]);

export interface DiagnosticsEnvironmentSelection {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly connected: ReadonlyArray<EnvironmentPresentation>;
  readonly primaryEnvironment: EnvironmentPresentation | null;
  /** The environment the page shows: the chosen one when connected, else a stand-in. */
  readonly environment: EnvironmentPresentation | null;
  /** The requested environment (the chosen one, else the primary) while it is not connected and a stand-in shows instead. */
  readonly waitingFor: EnvironmentPresentation | undefined;
}

/**
 * The one environment selection the Diagnostics page's Profiler and Diagnostic logs sections
 * share, kept by the route (`?environment=`) so a link can set it. Without one it is the
 * primary environment.
 */
export function useDiagnosticsEnvironment(
  selectedEnvironmentId: EnvironmentId | null,
  onSelectEnvironment: (environmentId: EnvironmentId | null) => void,
): DiagnosticsEnvironmentSelection {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const connected = environments.filter((candidate) => candidate.connection.phase === "connected");
  const primaryConnected =
    connected.find((candidate) => candidate.environmentId === primaryEnvironment?.environmentId) ??
    null;
  const environment =
    connected.find((candidate) => candidate.environmentId === selectedEnvironmentId) ??
    primaryConnected ??
    connected[0] ??
    primaryEnvironment ??
    null;
  // A choice whose environment has gone is dropped, so coming back online does not revive it.
  // One that has not connected yet (a reload on a link) is kept, as is any choice while the
  // catalog is loading, because the environment may simply not be known yet.
  const selectionGone =
    isReady &&
    selectedEnvironmentId !== null &&
    !environments.some(
      (candidate) =>
        candidate.environmentId === selectedEnvironmentId &&
        STILL_CONNECTING_PHASES.has(candidate.connection.phase),
    );
  useEffect(() => {
    if (selectionGone) onSelectEnvironment(null);
  }, [selectionGone, onSelectEnvironment]);
  // The requested environment (the chosen one, else the primary) is not connected, so another
  // one shows in the meantime.
  const requested =
    selectedEnvironmentId === null
      ? (primaryEnvironment ?? undefined)
      : environments.find((candidate) => candidate.environmentId === selectedEnvironmentId);
  const waitingFor =
    environment !== null &&
    requested !== undefined &&
    requested.environmentId !== environment.environmentId
      ? requested
      : undefined;
  return { environments, connected, primaryEnvironment, environment, waitingFor };
}

/** Picks a connected environment; one that is not connected is listed but disabled. */
export function DiagnosticsEnvironmentSelect({
  environments,
  value,
  onSelectEnvironment,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly value: EnvironmentPresentation;
  readonly onSelectEnvironment: (environmentId: EnvironmentId | null) => void;
}) {
  return (
    <Select
      value={value.environmentId}
      onValueChange={(next) => {
        if (next !== null) onSelectEnvironment(EnvironmentId.make(next));
      }}
    >
      <SelectTrigger aria-label="Environment" className="w-full sm:w-48">
        <SelectValue>{value.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {environments.map((candidate) => (
          <SelectItem
            hideIndicator
            disabled={candidate.connection.phase !== "connected"}
            key={candidate.environmentId}
            value={candidate.environmentId}
          >
            {candidate.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
