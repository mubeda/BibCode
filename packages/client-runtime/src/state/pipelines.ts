import {
  WS_METHODS,
  type EnvironmentId,
  type PipelinesGetInput,
  type PipelinesJobInput,
  type PipelinesListInput,
  type PipelinesRefresh,
} from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  environmentRpcKey,
} from "./runtime.ts";

/**
 * A read's `refresh` kind without a second cache entry. Views key their atoms with
 * `refresh: "user"` (opening a route, Refresh, Load more); a visible-refresh timer
 * marks the next execution of that exact atom as `timer` before revalidating it, so
 * the server can reuse a list's total instead of reading it again. Every kind honors
 * the host's backoff deadline on the server, so the marker never changes what a read
 * may reach.
 */
export function createTimerReadMarker() {
  const pending = new Set<string>();
  return {
    request(target: { readonly environmentId: EnvironmentId; readonly input: object }): void {
      pending.add(environmentRpcKey(target));
    },
    run<Input extends { readonly refresh: PipelinesRefresh }, A, E, R>(
      environmentId: EnvironmentId,
      input: Input,
      send: (input: Input) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> {
      const key = environmentRpcKey({ environmentId, input });
      // One mark describes one execution: the read it starts is the timer's.
      if (!pending.delete(key)) return send(input);
      return send({ ...input, refresh: "timer" });
    },
  };
}

/**
 * The Pipelines module's reads, mirroring `createPullRequestsEnvironmentAtoms`. The
 * repository context is not here: both modules read `pullRequests.getContext`
 * through the Pull Requests family, so they share one cache and one sign-in state.
 */
export function createPipelinesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const timerReads = createTimerReadMarker();
  const timed = <Input extends { readonly refresh: PipelinesRefresh }, A, Err, Req>(
    send: (input: Input) => Effect.Effect<A, Err, Req>,
  ) => {
    return (input: Input) =>
      EnvironmentSupervisor.pipe(
        Effect.flatMap((supervisor) =>
          timerReads.run(supervisor.target.environmentId, input, send),
        ),
      );
  };
  return {
    list: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pipelines:list",
      staleTimeMs: 5_000,
      execute: timed((input: PipelinesListInput) => request(WS_METHODS.pipelinesList, input)),
    }),
    get: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pipelines:get",
      staleTimeMs: 5_000,
      execute: timed((input: PipelinesGetInput) => request(WS_METHODS.pipelinesGet, input)),
    }),
    getJob: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pipelines:get-job",
      staleTimeMs: 5_000,
      execute: timed((input: PipelinesJobInput) => request(WS_METHODS.pipelinesGetJob, input)),
    }),
    /** The next `list`, `get` or `getJob` read of this exact input is sent as `timer`. */
    requestTimerRead: timerReads.request,
    // A one-shot read per window: the log view's worker owns the chunks, so no atom
    // keeps a second copy of a large log, and every window (tail, follow, earlier
    // text) is its own input.
    getJobLog: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pipelines:get-job-log",
      tag: WS_METHODS.pipelinesGetJobLog,
    }),
    // A stored payload is a point-in-time copy; every call re-reads it, so the
    // caller's own `shownCopy` / `keepNewestCopy` decides whether to paint it.
    readSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pipelines:read-snapshot",
      tag: WS_METHODS.pipelinesReadSnapshot,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    /** The GitLab poller's change events for the mounted list key and pipeline. */
    subscribe: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:pipelines:subscribe",
      tag: WS_METHODS.pipelinesSubscribe,
      idleTtlMs: 0,
    }),
  };
}
