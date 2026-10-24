import type { EnvironmentId, ServerProvider } from "@bibcode/contracts";
import { fanOutRemoteUpdateChecks } from "@bibcode/client-runtime/state/remoteUpdates";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@bibcode/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  collectUpdatedProviderSnapshots,
  formatProviderList,
  getProviderUpdateProgressToastView,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "./ProviderUpdateLaunchNotification.logic";

/** The same copy the per-environment update rows show for an environment that dropped. */
export const DISCONNECTED_ENVIRONMENT_REASON =
  "This environment isn’t connected — try again once it reconnects.";
const UNCONFIRMED_UPDATE_MESSAGE =
  "Could not confirm the update finished. Refresh provider status to check.";

export type ProviderUpdateCommandResult = AtomCommandResult<
  { readonly providers: ReadonlyArray<ServerProvider> },
  unknown
>;

export interface ProviderUpdateEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
}

export interface ProviderUpdateSkip {
  readonly provider: ProviderUpdateCandidate;
  readonly reason: string;
}

export interface ProviderUpdatePlanEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Sent to `server.updateProvider`, one call per provider. */
  readonly updates: ReadonlyArray<ProviderUpdateCandidate>;
  /** Outdated, but not sent: they need a manual update or are already updating. */
  readonly skipped: ReadonlyArray<ProviderUpdateSkip>;
}

export interface ProviderUpdatePlan {
  /** Connected environments with at least one outdated provider, in input order. */
  readonly environments: ReadonlyArray<ProviderUpdatePlanEnvironment>;
  /** Environments whose last snapshot still shows outdated providers but that are not connected. */
  readonly disconnected: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly providerNames: string;
  }>;
  readonly updateCount: number;
}

function skipReason(
  candidate: ProviderUpdateCandidate,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  if (canOneClickUpdateProviderCandidate(candidate, providers)) {
    return null;
  }
  const name = formatProviderList([candidate]);
  return isProviderUpdateActive(candidate)
    ? `${name} is already updating.`
    : `${name} can be updated from provider settings.`;
}

/** Which outdated providers one "Update all" run sends, per environment, and which it skips. */
export function planProviderUpdates(
  environments: ReadonlyArray<ProviderUpdateEnvironmentInput>,
): ProviderUpdatePlan {
  const planned: ProviderUpdatePlanEnvironment[] = [];
  const disconnected: Array<ProviderUpdatePlan["disconnected"][number]> = [];
  for (const environment of environments) {
    const candidates = collectProviderUpdateCandidates(environment.providers);
    if (candidates.length === 0) {
      continue;
    }
    if (!environment.connected) {
      disconnected.push({
        environmentId: environment.environmentId,
        label: environment.label,
        providerNames: formatProviderList(candidates),
      });
      continue;
    }
    const updates: ProviderUpdateCandidate[] = [];
    const skipped: ProviderUpdateSkip[] = [];
    for (const candidate of candidates) {
      const reason = skipReason(candidate, environment.providers);
      if (reason === null) {
        updates.push(candidate);
      } else {
        skipped.push({ provider: candidate, reason });
      }
    }
    planned.push({
      environmentId: environment.environmentId,
      label: environment.label,
      updates,
      skipped,
    });
  }
  return {
    environments: planned,
    disconnected,
    updateCount: planned.reduce((count, environment) => count + environment.updates.length, 0),
  };
}

export type ProviderUpdateAllStatus =
  | "queued"
  | "updating"
  | "updated"
  | "unchanged"
  | "failed"
  | "skipped";

export interface ProviderUpdateAllRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly providerNames: string;
  readonly status: ProviderUpdateAllStatus;
  readonly message: string | null;
}

/** The summary a run starts from: queued environments, then everything it will not touch. */
export function initialProviderUpdateAllRows(
  plan: ProviderUpdatePlan,
): ReadonlyArray<ProviderUpdateAllRow> {
  return [
    ...plan.environments.map((environment): ProviderUpdateAllRow =>
      environment.updates.length > 0
        ? {
            environmentId: environment.environmentId,
            label: environment.label,
            providerNames: formatProviderList(environment.updates),
            status: "queued",
            message: null,
          }
        : {
            environmentId: environment.environmentId,
            label: environment.label,
            providerNames: formatProviderList(environment.skipped.map((skip) => skip.provider)),
            status: "skipped",
            message: environment.skipped.map((skip) => skip.reason).join(" "),
          },
    ),
    ...plan.disconnected.map((environment): ProviderUpdateAllRow => ({
      ...environment,
      status: "skipped",
      message: DISCONNECTED_ENVIRONMENT_REASON,
    })),
  ];
}

/**
 * One environment's result from its settled update commands. An RPC error
 * wins; an interrupted command or a snapshot that does not confirm the
 * update is never reported as updated.
 */
export function providerUpdateAllOutcome(
  targets: ReadonlyArray<ProviderUpdateCandidate>,
  results: ReadonlyArray<ProviderUpdateCommandResult>,
): { readonly status: ProviderUpdateAllStatus; readonly message: string | null } {
  for (const result of results) {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      return {
        status: "failed",
        message: error instanceof Error ? error.message : "Provider update failed.",
      };
    }
  }
  const view = getProviderUpdateProgressToastView({
    providers: collectUpdatedProviderSnapshots({
      results,
      providerInstanceIds: new Set(targets.map((target) => target.instanceId)),
    }),
    providerCount: targets.length,
  });
  if (results.some(isAtomCommandInterrupted)) {
    return { status: "unchanged", message: UNCONFIRMED_UPDATE_MESSAGE };
  }
  switch (view.phase) {
    case "succeeded":
      return { status: "updated", message: null };
    case "failed":
      return { status: "failed", message: view.description };
    case "unchanged":
      return { status: "unchanged", message: view.description };
    default:
      return { status: "unchanged", message: UNCONFIRMED_UPDATE_MESSAGE };
  }
}

/**
 * Runs a plan: at most two environments at a time, each environment's
 * providers through its own serial config queue. One environment's failure
 * never stops another.
 */
export async function runProviderUpdatePlan(input: {
  readonly plan: ProviderUpdatePlan;
  readonly update: (
    environmentId: EnvironmentId,
    candidate: ProviderUpdateCandidate,
  ) => Promise<ProviderUpdateCommandResult>;
  readonly publish: (
    environmentId: EnvironmentId,
    status: ProviderUpdateAllStatus,
    message: string | null,
  ) => void;
}): Promise<void> {
  const updatesByEnvironment = new Map(
    input.plan.environments
      .filter((environment) => environment.updates.length > 0)
      .map((environment) => [environment.environmentId, environment.updates] as const),
  );
  await fanOutRemoteUpdateChecks([...updatesByEnvironment.keys()], async (environmentId) => {
    const updates = updatesByEnvironment.get(environmentId) ?? [];
    input.publish(environmentId, "updating", null);
    try {
      const results = await Promise.all(
        updates.map((candidate) => input.update(environmentId, candidate)),
      );
      const outcome = providerUpdateAllOutcome(updates, results);
      input.publish(environmentId, outcome.status, outcome.message);
    } catch (error) {
      input.publish(
        environmentId,
        "failed",
        error instanceof Error ? error.message : "Provider update failed.",
      );
    }
    return AsyncResult.success(undefined);
  });
}
