import { WS_METHODS } from "@bibcode/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createPullRequestsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    getContext: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:get-context",
      tag: WS_METHODS.pullRequestsGetContext,
      staleTimeMs: 60_000,
    }),
    getVocabulary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:get-vocabulary",
      tag: WS_METHODS.pullRequestsGetVocabulary,
      staleTimeMs: 60_000,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list",
      tag: WS_METHODS.pullRequestsList,
      staleTimeMs: 5_000,
    }),
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
