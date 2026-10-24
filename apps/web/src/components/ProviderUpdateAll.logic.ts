import {
  type EnvironmentId,
  REMOTE_UPDATE_MANUAL_REQUIRED,
  RemoteUpdateInstallError,
  type RemoteUpdateSnapshot,
  type ServerProvider,
} from "@bibcode/contracts";
import {
  REMOTE_UPDATE_DOWNLOAD_BUDGET_MS,
  REMOTE_UPDATE_INSTALL_BUDGET_MS,
  REMOTE_UPDATE_INSTALL_TIMEOUT_MS,
  REMOTE_UPDATE_RESTART_BUDGET_MS,
  type RemoteUpdateRunState,
} from "@bibcode/client-runtime/state/remoteUpdateCoordinator";
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
import { remoteUpdateFailureMessage } from "./settings/remoteUpdatePresentation";

/** The same copy the per-environment update rows show for an environment that dropped. */
export const DISCONNECTED_ENVIRONMENT_REASON =
  "This environment isn’t connected — try again once it reconnects.";
/** The copy a manual host's install refusal carries. */
export const MANUAL_SERVER_UPDATE_REASON = new RemoteUpdateInstallError({
  code: REMOTE_UPDATE_MANUAL_REQUIRED,
}).message;
const UNCONFIRMED_UPDATE_MESSAGE =
  "Could not confirm the update finished. Refresh provider status to check.";
const UNCONFIRMED_SERVER_UPDATE_MESSAGE =
  "Could not confirm the server update finished. Check it in Settings → Connections.";
const PROVIDERS_UNFINISHED_REASON = "Not restarted because its providers did not update.";

/**
 * How long one provider update may take before the run stops waiting for it: the
 * server's five-minute command timeout plus a minute for its queue and the reply.
 * Calls on one environment share its serial queue, so an environment gets this once
 * per provider. A socket that dies without a close event then cannot hold a run.
 */
export const PROVIDER_UPDATE_EXPIRY_MS = 6 * 60_000;
/** The remote-update coordinator's own budgets end to end, plus two minutes. */
export const SERVER_INSTALL_EXPIRY_MS =
  REMOTE_UPDATE_INSTALL_TIMEOUT_MS +
  REMOTE_UPDATE_DOWNLOAD_BUDGET_MS +
  REMOTE_UPDATE_INSTALL_BUDGET_MS +
  REMOTE_UPDATE_RESTART_BUDGET_MS +
  2 * 60_000;

export type ProviderUpdateCommandResult = AtomCommandResult<
  { readonly providers: ReadonlyArray<ServerProvider> },
  unknown
>;

/** What a remote environment's updater reports; absent for the primary and desktop-local ones. */
export interface ServerUpdateInput {
  /** `capabilities.remoteUpdateProgress`: the confirmation may count running work. */
  readonly progress: boolean;
  /** The last `updater.status` snapshot; null until it loads. */
  readonly snapshot: RemoteUpdateSnapshot | null;
}

export interface ProviderUpdateEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  /**
   * Present only for a remote environment that advertises `remoteUpdateControl`. The
   * primary and desktop-local environments never carry it, so this control never
   * restarts the app it runs in.
   */
  readonly serverUpdate?: ServerUpdateInput;
}

export interface ProviderUpdateSkip {
  readonly provider: ProviderUpdateCandidate;
  readonly reason: string;
}

export type ServerInstallPlan =
  | { readonly kind: "install"; readonly targetVersion: string; readonly progress: boolean }
  | { readonly kind: "skipped"; readonly reason: string };

export type ServerInstallTarget = Extract<ServerInstallPlan, { readonly kind: "install" }>;

export interface ProviderUpdatePlanEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Sent to `server.updateProvider`, one call per provider. */
  readonly updates: ReadonlyArray<ProviderUpdateCandidate>;
  /** Outdated, but not sent: they need a manual update or are already updating. */
  readonly skipped: ReadonlyArray<ProviderUpdateSkip>;
  /** The server install that follows this environment's provider updates, if any. */
  readonly server: ServerInstallPlan | null;
}

export interface ProviderUpdatePlan {
  /** Connected environments with an outdated provider or a server update, in input order. */
  readonly environments: ReadonlyArray<ProviderUpdatePlanEnvironment>;
  /** Environments whose last snapshot still shows outdated providers but that are not connected. */
  readonly disconnected: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly providerNames: string;
  }>;
  readonly updateCount: number;
  readonly serverInstallCount: number;
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

/**
 * A server install needs an update the host reports and an automatic installer. A manual
 * host is named, with the manual copy, only beside provider work, because it never
 * reports whether it is behind. A provider update already running there holds it back.
 */
function planServerInstall(
  serverUpdate: ServerUpdateInput | undefined,
  providers: ReadonlyArray<ServerProvider>,
): ServerInstallPlan | null {
  const snapshot = serverUpdate?.snapshot ?? null;
  if (serverUpdate === undefined || snapshot === null) {
    return null;
  }
  if (snapshot.support.installMode === "manual") {
    return { kind: "skipped", reason: MANUAL_SERVER_UPDATE_REASON };
  }
  if (snapshot.state !== "update-available" || snapshot.latestVersion === null) {
    return null;
  }
  const updating = providers.filter(isProviderUpdateActive);
  if (updating.length > 0) {
    return {
      kind: "skipped",
      reason: `${formatProviderList(updating)} ${updating.length === 1 ? "is" : "are"} still updating. Update this server once ${updating.length === 1 ? "it finishes" : "they finish"}.`,
    };
  }
  return {
    kind: "install",
    targetVersion: snapshot.latestVersion,
    progress: serverUpdate.progress,
  };
}

/** Which outdated providers and servers one "Update all" run updates, and which it skips. */
export function planProviderUpdates(
  environments: ReadonlyArray<ProviderUpdateEnvironmentInput>,
): ProviderUpdatePlan {
  const planned: ProviderUpdatePlanEnvironment[] = [];
  const disconnected: Array<ProviderUpdatePlan["disconnected"][number]> = [];
  for (const environment of environments) {
    const candidates = collectProviderUpdateCandidates(environment.providers);
    if (!environment.connected) {
      if (candidates.length > 0) {
        disconnected.push({
          environmentId: environment.environmentId,
          label: environment.label,
          providerNames: formatProviderList(candidates),
        });
      }
      continue;
    }
    const server = planServerInstall(environment.serverUpdate, environment.providers);
    if (candidates.length === 0 && server?.kind !== "install") {
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
      server,
    });
  }
  return {
    environments: planned,
    disconnected,
    updateCount: planned.reduce((count, environment) => count + environment.updates.length, 0),
    serverInstallCount: planned.filter((environment) => environment.server?.kind === "install")
      .length,
  };
}

export type ProviderUpdateAllStatus =
  | "queued"
  | "updating"
  | "updated"
  | "unchanged"
  | "failed"
  | "skipped";

/** An environment's providers, or the server install that follows them. */
export type ProviderUpdateAllSubject = "providers" | "server";

export interface ProviderUpdateAllRowTarget {
  readonly environmentId: EnvironmentId;
  readonly subject: ProviderUpdateAllSubject;
}

export interface ProviderUpdateAllRow extends ProviderUpdateAllRowTarget {
  readonly label: string;
  /** The providers the row updates or skips, or the server and its target version. */
  readonly detail: string;
  readonly status: ProviderUpdateAllStatus;
  readonly message: string | null;
}

export interface ProviderUpdateAllOutcome {
  readonly status: ProviderUpdateAllStatus;
  readonly message: string | null;
}

function serverRow(environment: ProviderUpdatePlanEnvironment): ProviderUpdateAllRow | null {
  const server = environment.server;
  if (server === null) {
    return null;
  }
  return server.kind === "install"
    ? {
        environmentId: environment.environmentId,
        subject: "server",
        label: environment.label,
        detail: `Server v${server.targetVersion}`,
        status: "queued",
        message: null,
      }
    : {
        environmentId: environment.environmentId,
        subject: "server",
        label: environment.label,
        detail: "Server",
        status: "skipped",
        message: server.reason,
      };
}

function providerRow(environment: ProviderUpdatePlanEnvironment): ProviderUpdateAllRow | null {
  if (environment.updates.length > 0) {
    return {
      environmentId: environment.environmentId,
      subject: "providers",
      label: environment.label,
      detail: formatProviderList(environment.updates),
      status: "queued",
      message: null,
    };
  }
  if (environment.skipped.length > 0) {
    return {
      environmentId: environment.environmentId,
      subject: "providers",
      label: environment.label,
      detail: formatProviderList(environment.skipped.map((skip) => skip.provider)),
      status: "skipped",
      message: environment.skipped.map((skip) => skip.reason).join(" "),
    };
  }
  return null;
}

/**
 * The summary a run starts from: each environment's providers then its server, then
 * the disconnected environments it will not touch.
 */
export function initialProviderUpdateAllRows(
  plan: ProviderUpdatePlan,
): ReadonlyArray<ProviderUpdateAllRow> {
  const rows: ProviderUpdateAllRow[] = [];
  for (const environment of plan.environments) {
    const providers = providerRow(environment);
    const server = serverRow(environment);
    if (providers !== null) rows.push(providers);
    if (server !== null) rows.push(server);
  }
  for (const environment of plan.disconnected) {
    rows.push({
      environmentId: environment.environmentId,
      subject: "providers",
      label: environment.label,
      detail: environment.providerNames,
      status: "skipped",
      message: DISCONNECTED_ENVIRONMENT_REASON,
    });
  }
  return rows;
}

/** One published status applied to a summary; a cleared summary stays cleared. */
export function applyProviderUpdateAllPublish(
  rows: ReadonlyArray<ProviderUpdateAllRow> | null,
  target: ProviderUpdateAllRowTarget,
  status: ProviderUpdateAllStatus,
  message: string | null,
): ReadonlyArray<ProviderUpdateAllRow> | null {
  return rows === null
    ? rows
    : rows.map((row) =>
        row.environmentId === target.environmentId && row.subject === target.subject
          ? { ...row, status, message }
          : row,
      );
}

/**
 * One environment's result from its settled update commands. An RPC error
 * wins; an interrupted command or a snapshot that does not confirm the
 * update is never reported as updated.
 */
export function providerUpdateAllOutcome(
  targets: ReadonlyArray<ProviderUpdateCandidate>,
  results: ReadonlyArray<ProviderUpdateCommandResult>,
): ProviderUpdateAllOutcome {
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

/** A server install's result from the shared remote-update run it joined or started. */
export function serverInstallOutcome(
  label: string,
  result: AtomCommandResult<RemoteUpdateRunState, unknown>,
): ProviderUpdateAllOutcome {
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) {
      return { status: "unchanged", message: UNCONFIRMED_SERVER_UPDATE_MESSAGE };
    }
    const error = squashAtomCommandFailure(result);
    return {
      status: "failed",
      message:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Server update failed.",
    };
  }
  const state = result.value;
  switch (state.phase) {
    case "succeeded":
      return { status: "updated", message: `Updated to v${state.version}` };
    case "up-to-date":
      return { status: "unchanged", message: "Already up to date" };
    case "failed":
      return { status: "failed", message: remoteUpdateFailureMessage(label, state.failure) };
    default:
      return { status: "unchanged", message: UNCONFIRMED_SERVER_UPDATE_MESSAGE };
  }
}

type Settled<T> = { readonly settled: true; readonly value: T } | { readonly settled: false };

/** Resolves with the promise's value, or unsettled once `ms` passes; never rejects on time. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  return Promise.race([
    promise.then((value): Settled<T> => ({ settled: true, value })),
    expired,
  ]).finally(() => clearTimeout(timer));
}

function failedOutcome(error: unknown, fallback: string): ProviderUpdateAllOutcome {
  return { status: "failed", message: error instanceof Error ? error.message : fallback };
}

/**
 * Runs a plan: at most two environments at a time, each environment's providers
 * through its own serial config queue, then that environment's server install. The
 * install starts only after every provider call on the environment settled as
 * updated; a failed, unchanged, or unconfirmed provider update skips it. One
 * environment's failure never stops another, and each phase gives up after its
 * expiry, so a silently dead socket cannot hold the run.
 */
export async function runProviderUpdatePlan(input: {
  readonly plan: ProviderUpdatePlan;
  readonly update: (
    environmentId: EnvironmentId,
    candidate: ProviderUpdateCandidate,
  ) => Promise<ProviderUpdateCommandResult>;
  readonly installServer: (
    environmentId: EnvironmentId,
    target: ServerInstallTarget,
  ) => Promise<ProviderUpdateAllOutcome>;
  readonly publish: (
    target: ProviderUpdateAllRowTarget,
    status: ProviderUpdateAllStatus,
    message: string | null,
  ) => void;
}): Promise<void> {
  const environments = new Map(
    input.plan.environments
      .filter(
        (environment) => environment.updates.length > 0 || environment.server?.kind === "install",
      )
      .map((environment) => [environment.environmentId, environment] as const),
  );
  const providersPhase = async (
    environment: ProviderUpdatePlanEnvironment,
  ): Promise<ProviderUpdateAllOutcome> => {
    const target = { environmentId: environment.environmentId, subject: "providers" } as const;
    input.publish(target, "updating", null);
    let outcome: ProviderUpdateAllOutcome;
    try {
      const results = await settleWithin(
        Promise.all(
          environment.updates.map((candidate) =>
            input.update(environment.environmentId, candidate),
          ),
        ),
        PROVIDER_UPDATE_EXPIRY_MS * environment.updates.length,
      );
      outcome = results.settled
        ? providerUpdateAllOutcome(environment.updates, results.value)
        : { status: "unchanged", message: UNCONFIRMED_UPDATE_MESSAGE };
    } catch (error) {
      outcome = failedOutcome(error, "Provider update failed.");
    }
    input.publish(target, outcome.status, outcome.message);
    return outcome;
  };
  const serverPhase = async (
    environmentId: EnvironmentId,
    server: ServerInstallTarget,
  ): Promise<void> => {
    const target = { environmentId, subject: "server" } as const;
    input.publish(target, "updating", null);
    let outcome: ProviderUpdateAllOutcome;
    try {
      const result = await settleWithin(
        input.installServer(environmentId, server),
        SERVER_INSTALL_EXPIRY_MS,
      );
      outcome = result.settled
        ? result.value
        : { status: "unchanged", message: UNCONFIRMED_SERVER_UPDATE_MESSAGE };
    } catch (error) {
      outcome = failedOutcome(error, "Server update failed.");
    }
    input.publish(target, outcome.status, outcome.message);
  };

  await fanOutRemoteUpdateChecks([...environments.keys()], async (environmentId) => {
    const environment = environments.get(environmentId)!;
    const providers = environment.updates.length > 0 ? await providersPhase(environment) : null;
    const server = environment.server;
    if (server?.kind === "install") {
      if (providers === null || providers.status === "updated") {
        await serverPhase(environmentId, server);
      } else {
        input.publish({ environmentId, subject: "server" }, "skipped", PROVIDERS_UNFINISHED_REASON);
      }
    }
    return AsyncResult.success(undefined);
  });
}
