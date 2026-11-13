import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@bibcode/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useContext } from "react";

/** The environment whose Host dashboard is open, or null; one sheet serves every entry point. */
export const hostDashboardRequest: Atom.Writable<{ readonly environmentId: EnvironmentId } | null> =
  Atom.make<{ readonly environmentId: EnvironmentId } | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("web-host-dashboard:request"),
  );

export function useOpenHostDashboard(): (environmentId: EnvironmentId) => void {
  const registry = useContext(RegistryContext);
  return useCallback(
    (environmentId: EnvironmentId) => registry.set(hostDashboardRequest, { environmentId }),
    [registry],
  );
}
