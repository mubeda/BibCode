import { runAtomCommand } from "@bibcode/client-runtime/state/runtime";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  initialProviderUpdateAllRows,
  runProviderUpdatePlan,
  type ProviderUpdateAllRow,
  type ProviderUpdatePlan,
} from "../components/ProviderUpdateAll.logic";
import { serverEnvironment } from "./server";

/** The latest "Update all" run, kept in the registry so it outlives the Settings page. */
export const providerUpdateAllRun: Atom.Writable<ReadonlyArray<ProviderUpdateAllRow> | null> =
  Atom.make<ReadonlyArray<ProviderUpdateAllRow> | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("web-provider-update-all:run"),
  );

export function isProviderUpdateAllRunActive(
  rows: ReadonlyArray<ProviderUpdateAllRow> | null,
): boolean {
  return rows?.some((row) => row.status === "queued" || row.status === "updating") === true;
}

/** Starts a run unless one is still in flight; the RPCs continue after the caller unmounts. */
export function startProviderUpdateAll(
  registry: AtomRegistry.AtomRegistry,
  plan: ProviderUpdatePlan,
): void {
  if (isProviderUpdateAllRunActive(registry.get(providerUpdateAllRun))) {
    return;
  }
  registry.set(providerUpdateAllRun, initialProviderUpdateAllRows(plan));
  void runProviderUpdatePlan({
    plan,
    update: (environmentId, candidate) =>
      runAtomCommand(
        registry,
        serverEnvironment.updateProvider,
        {
          environmentId,
          input: { provider: candidate.driver, instanceId: candidate.instanceId },
        },
        { label: serverEnvironment.updateProvider.label, reportFailure: false },
      ),
    publish: (environmentId, status, message) =>
      registry.update(providerUpdateAllRun, (rows) =>
        rows === null
          ? rows
          : rows.map((row) =>
              row.environmentId === environmentId ? { ...row, status, message } : row,
            ),
      ),
  });
}

/** Clears a finished run's summary; a run still in flight stays. */
export function dismissProviderUpdateAll(registry: AtomRegistry.AtomRegistry): void {
  if (!isProviderUpdateAllRunActive(registry.get(providerUpdateAllRun))) {
    registry.set(providerUpdateAllRun, null);
  }
}
