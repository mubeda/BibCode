import { WS_METHODS } from "@bibcode/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcStreamCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createGitManagerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    getRefs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git-manager:get-refs",
      tag: WS_METHODS.gitManagerGetRefs,
      staleTimeMs: 5_000,
    }),
    getCommits: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git-manager:get-commits",
      tag: WS_METHODS.gitManagerGetCommits,
      staleTimeMs: 10_000,
    }),
    getDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git-manager:get-diff",
      tag: WS_METHODS.gitManagerGetDiff,
      staleTimeMs: 5_000,
    }),
    getStashes: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git-manager:get-stashes",
      tag: WS_METHODS.gitManagerGetStashes,
      staleTimeMs: 5_000,
    }),
    previewMerge: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git-manager:preview-merge",
      tag: WS_METHODS.gitManagerPreviewMerge,
      staleTimeMs: 5_000,
    }),
    listPullRequests: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git-manager:list-pull-requests",
      tag: WS_METHODS.gitManagerListPullRequests,
      staleTimeMs: 5_000,
    }),
    signal: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:git-manager:signal",
      tag: WS_METHODS.subscribeGitManagerSignal,
      idleTtlMs: 0,
    }),
    commit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-manager:commit",
      tag: WS_METHODS.gitManagerCommit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    undoCommit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-manager:undo-commit",
      tag: WS_METHODS.gitManagerUndoCommit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    discard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-manager:discard",
      tag: WS_METHODS.gitManagerDiscard,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    stagePartial: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-manager:stage-partial",
      tag: WS_METHODS.gitManagerStagePartial,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    unstagePartial: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-manager:unstage-partial",
      tag: WS_METHODS.gitManagerUnstagePartial,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    discardPartial: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git-manager:discard-partial",
      tag: WS_METHODS.gitManagerDiscardPartial,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    runOperation: createEnvironmentRpcStreamCommand(runtime, {
      label: "environment-data:git-manager:run-operation",
      tag: WS_METHODS.gitManagerRunOperation,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}
