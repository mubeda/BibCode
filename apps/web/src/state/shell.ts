import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createConnectionCatalogHealthAtom,
  createShellEnvironmentAtoms,
} from "@bibcode/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@bibcode/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const connectionCatalogHealthAtom = createConnectionCatalogHealthAtom(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  catalogHealthAtom: connectionCatalogHealthAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

export interface CappedShellEnvironment {
  readonly environmentId: EnvironmentId;
  readonly live: boolean;
}

let previousCappedEnvironments: ReadonlyArray<CappedShellEnvironment> = [];

/** The environments whose live shell left finished threads out (#223), and which are live. */
export const cappedShellEnvironmentsAtom = Atom.make((get) => {
  const next: CappedShellEnvironment[] = [];
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const state = get(environmentShell.stateValueAtom(environmentId));
    if (Option.isSome(state.snapshot) && state.snapshot.value.capped === true) {
      next.push({ environmentId, live: state.status === "live" });
    }
  }
  const unchanged =
    next.length === previousCappedEnvironments.length &&
    next.every(
      (entry, index) =>
        entry.environmentId === previousCappedEnvironments[index]?.environmentId &&
        entry.live === previousCappedEnvironments[index]?.live,
    );
  if (!unchanged) previousCappedEnvironments = next;
  return previousCappedEnvironments;
}).pipe(Atom.withLabel("web-capped-shell-environments"));

export const environmentAvailabilityCommands = {
  retry: environmentCatalog.retryNow,
  adoptStorage: environmentCatalog.acceptStorageIdentity,
} as const;

export function useEnvironmentShellSummary() {
  return useAtomValue(environmentShellSummaryAtom);
}
