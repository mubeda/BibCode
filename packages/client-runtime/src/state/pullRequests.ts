import {
  WS_METHODS,
  type EnvironmentId,
  type PullRequestsGetContextInput,
  type PullRequestsListInput,
} from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError, request } from "../rpc/client.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  environmentRpcKey,
} from "./runtime.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);

/** Success or the server's typed failure; not an interruption, a lost transport or a defect. */
function answered<A, E>(exit: Exit.Exit<A, E>): boolean {
  if (Exit.isSuccess(exit)) return true;
  if (Exit.hasInterrupts(exit)) return false;
  const error = Exit.findErrorOption(exit);
  return (
    Option.isSome(error) &&
    !isRpcClientError(error.value) &&
    !isEnvironmentRpcUnavailableError(error.value)
  );
}

/**
 * One-shot bypass requests for a query: `request` marks one environment and input,
 * and executions of that exact query send `field: true` until one is answered. An
 * interrupted read or a lost connection leaves the request for the next execution.
 * The query key never changes, so the current value stays visible meanwhile.
 */
export function createOneShotBypass<Field extends string>(field: Field) {
  const pending = new Set<string>();
  return {
    request(target: { readonly environmentId: EnvironmentId; readonly input: object }): void {
      pending.add(environmentRpcKey(target));
    },
    run<Input extends object & Partial<Record<Field, boolean | undefined>>, A, E, R>(
      environmentId: EnvironmentId,
      input: Input,
      send: (input: Input) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> {
      const key = environmentRpcKey({ environmentId, input });
      if (!pending.has(key)) return send(input);
      // The wire input declares the bypass field as an optional boolean.
      return send({ ...input, [field]: true }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (answered(exit)) pending.delete(key);
          }),
        ),
      );
    },
  };
}

export function createPullRequestsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Only Rescan and auth recovery bypass the server's bounded context caches.
  const contextRescans = createOneShotBypass("rescan");
  // Only an explicit list Refresh re-reads the repository-wide tab totals.
  const totalsRefreshes = createOneShotBypass("refreshTotals");
  return {
    getContext: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:get-context",
      staleTimeMs: 60_000,
      execute: (input: PullRequestsGetContextInput) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) =>
            contextRescans.run(supervisor.target.environmentId, input, (payload) =>
              request(WS_METHODS.pullRequestsGetContext, payload),
            ),
          ),
        ),
    }),
    /** The next `getContext` read of this input bypasses the server's context caches. */
    requestContextRescan: contextRescans.request,
    getVocabulary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:get-vocabulary",
      tag: WS_METHODS.pullRequestsGetVocabulary,
      staleTimeMs: 60_000,
    }),
    list: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list",
      staleTimeMs: 5_000,
      execute: (input: PullRequestsListInput) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) =>
            totalsRefreshes.run(supervisor.target.environmentId, input, (payload) =>
              request(WS_METHODS.pullRequestsList, payload),
            ),
          ),
        ),
    }),
    /** The next `list` read of this input re-reads the repository-wide tab totals. */
    requestListTotalsRefresh: totalsRefreshes.request,
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:get",
      tag: WS_METHODS.pullRequestsGet,
      staleTimeMs: 5_000,
    }),
    getTimeline: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:get-timeline",
      tag: WS_METHODS.pullRequestsGetTimeline,
      staleTimeMs: 5_000,
    }),
    getCommits: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:get-commits",
      tag: WS_METHODS.pullRequestsGetCommits,
      staleTimeMs: 30_000,
    }),
    getChecks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:get-checks",
      tag: WS_METHODS.pullRequestsGetChecks,
      staleTimeMs: 5_000,
    }),
    getFiles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:get-files",
      tag: WS_METHODS.pullRequestsGetFiles,
      staleTimeMs: 30_000,
    }),
    runAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:run-action",
      tag: WS_METHODS.pullRequestsRunAction,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    checkout: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:checkout",
      tag: WS_METHODS.pullRequestsCheckout,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}
