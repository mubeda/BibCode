import type { EnvironmentId, RemoteUpdateSnapshot } from "@bibcode/contracts";
import { runAtomCommand } from "@bibcode/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  applyProviderUpdateAllPublish,
  initialProviderUpdateAllRows,
  runProviderUpdatePlan,
  serverInstallOutcome,
  type ProviderUpdateAllRow,
  type ProviderUpdatePlan,
} from "../components/ProviderUpdateAll.logic";
import { remoteUpdateEnvironment } from "./remoteUpdates";
import { serverEnvironment } from "./server";

/** The latest "Update all" run, kept in the registry so it outlives the Settings page. */
export const providerUpdateAllRun: Atom.Writable<ReadonlyArray<ProviderUpdateAllRow> | null> =
  Atom.make<ReadonlyArray<ProviderUpdateAllRow> | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("web-provider-update-all:run"),
  );

/**
 * The `updater.status` snapshot of each environment in a JSON array key, null until it
 * loads. Observing it keeps each environment's own status query alive and polled.
 */
export const serverUpdateSnapshots = Atom.family((key: string) =>
  Atom.make((get): ReadonlyMap<EnvironmentId, RemoteUpdateSnapshot | null> => {
    const snapshots = new Map<EnvironmentId, RemoteUpdateSnapshot | null>();
    for (const environmentId of JSON.parse(key) as EnvironmentId[]) {
      snapshots.set(
        environmentId,
        Option.getOrNull(
          AsyncResult.value(get(remoteUpdateEnvironment.snapshot({ environmentId, input: {} }))),
        ),
      );
    }
    return snapshots;
  }).pipe(Atom.withLabel(`web-provider-update-all:server-snapshots:${key}`)),
);

export function isProviderUpdateAllRunActive(
  rows: ReadonlyArray<ProviderUpdateAllRow> | null,
): boolean {
  return rows?.some((row) => row.status === "queued" || row.status === "updating") === true;
}

/**
 * Starts a run unless one is still in flight; the RPCs and server installs continue
 * after the caller unmounts. A server install joins the environment's shared
 * remote-update run, so Settings → Connections shows the same progress.
 */
export function startProviderUpdateAll(
  registry: AtomRegistry.AtomRegistry,
  plan: ProviderUpdatePlan,
): void {
  if (isProviderUpdateAllRunActive(registry.get(providerUpdateAllRun))) {
    return;
  }
  registry.set(providerUpdateAllRun, initialProviderUpdateAllRows(plan));
  const labels = new Map(
    plan.environments.map((environment) => [environment.environmentId, environment.label]),
  );
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
    installServer: async (environmentId) =>
      serverInstallOutcome(
        labels.get(environmentId) ?? environmentId,
        await runAtomCommand(
          registry,
          remoteUpdateEnvironment.update,
          { environmentId, input: {} },
          { label: remoteUpdateEnvironment.update.label, reportFailure: false },
        ),
      ),
    // Each phase settles or expires inside its worker before its row's last publish,
    // and a new run starts only once every row is terminal, so no late publish of an
    // earlier run can reach a newer summary.
    publish: (target, status, message) =>
      registry.update(providerUpdateAllRun, (rows) =>
        applyProviderUpdateAllPublish(rows, target, status, message),
      ),
  });
}

/** Clears a finished run's summary; a run still in flight stays. */
export function dismissProviderUpdateAll(registry: AtomRegistry.AtomRegistry): void {
  if (!isProviderUpdateAllRunActive(registry.get(providerUpdateAllRun))) {
    registry.set(providerUpdateAllRun, null);
  }
}
