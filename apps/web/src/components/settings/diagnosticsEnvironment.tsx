import { EnvironmentId } from "@bibcode/contracts";
import { useEffect } from "react";

import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

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
  // A choice stays while its environment is in the catalog, connected or not: a link from a
  // remote thread must keep naming that remote (its download disabled until it reconnects),
  // never fall back to this machine's logs. Only an environment that was removed drops it,
  // and only once the catalog has loaded, since before that it may simply not be known yet.
  const selectionGone =
    isReady &&
    selectedEnvironmentId !== null &&
    !environments.some((candidate) => candidate.environmentId === selectedEnvironmentId);
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
