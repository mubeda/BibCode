import {
  type VcsStatusResult,
  type VcsStatusStreamEvent,
  type VcsStatusSummary,
  WS_METHODS,
} from "@bibcode/contracts";
import { applyGitStatusStreamEvent } from "@bibcode/shared/git";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  environmentRpcKey,
  followStreamInEnvironment,
  parseEnvironmentRpcKey,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { ConnectionAttemptError } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import {
  subscribe,
  subscribeInSession,
  type EnvironmentRpcInput,
  type EnvironmentRpcStreamFailure,
} from "../rpc/client.ts";
import {
  vcsCloneCommandConcurrency,
  vcsCommandConcurrency,
  vcsCommandScheduler,
  vcsGenerateScheduler,
  vcsStatusRefreshConcurrency,
  vcsStatusRefreshScheduler,
} from "./vcsCommandScheduler.ts";

export type VcsPassiveStatus = VcsStatusSummary | VcsStatusResult;

type VcsSummaryStreamFailure = EnvironmentRpcStreamFailure<
  typeof WS_METHODS.subscribeVcsStatusSummary
>;

function reduceStatusEvents<E, R>(
  stream: Stream.Stream<VcsStatusStreamEvent, E, R>,
): Stream.Stream<VcsStatusResult, E, R> {
  return stream.pipe(
    Stream.mapAccum(
      () => null as VcsStatusResult | null,
      (current, event) => {
        const next = applyGitStatusStreamEvent(current, event);
        return [next, [next]] as const;
      },
    ),
  );
}

function subscribeToVcsSummary<E, R>(
  input: EnvironmentRpcInput<typeof WS_METHODS.subscribeVcsStatusSummary>,
  legacyStatus: Stream.Stream<VcsStatusResult, E, R>,
): Stream.Stream<
  VcsPassiveStatus,
  E | VcsSummaryStreamFailure | ConnectionAttemptError,
  R | EnvironmentSupervisor
> {
  return Stream.unwrap(
    EnvironmentSupervisor.pipe(
      Effect.map((supervisor) =>
        SubscriptionRef.changes(supervisor.session).pipe(
          Stream.switchMap(
            Option.match({
              onNone: () => Stream.empty,
              onSome: (session) =>
                Stream.fromEffect(session.initialConfig).pipe(
                  Stream.flatMap(
                    (config): Stream.Stream<VcsPassiveStatus, E | VcsSummaryStreamFailure, R> =>
                      config.environment.capabilities.vcsStatusSummary === true
                        ? subscribeInSession(
                            session,
                            supervisor.target.environmentId,
                            WS_METHODS.subscribeVcsStatusSummary,
                            input,
                            {
                              onExpectedFailure: (cause) =>
                                Effect.logWarning(
                                  "Could not refresh the passive VCS summary; retrying.",
                                ).pipe(
                                  Effect.annotateLogs({
                                    ...safeErrorLogAttributes(Cause.squash(cause)),
                                  }),
                                ),
                              retryExpectedFailureAfter: "30 seconds",
                            },
                          ).pipe(Stream.map((value): VcsPassiveStatus => value))
                        : legacyStatus.pipe(Stream.map((value): VcsPassiveStatus => value)),
                  ),
                ),
            }),
          ),
        ),
      ),
    ),
  );
}

export function createVcsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const status = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:vcs:status",
    subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.subscribeVcsStatus>) =>
      reduceStatusEvents(subscribe(WS_METHODS.subscribeVcsStatus, input)),
    idleTtlMs: 0,
  });
  const summaryFamily = Atom.family((key: string) => {
    const target =
      parseEnvironmentRpcKey<EnvironmentRpcInput<typeof WS_METHODS.subscribeVcsStatusSummary>>(key);
    return runtime
      .atom((get) =>
        followStreamInEnvironment(
          target.environmentId,
          subscribeToVcsSummary(
            target.input,
            AtomRegistry.toStreamResult(get.registry, status(target)),
          ),
        ),
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-data:vcs:summary:${key}`));
  });
  const summary = (target: Parameters<typeof status>[0]) =>
    summaryFamily(environmentRpcKey(target));

  return {
    listRefs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:list-refs",
      tag: WS_METHODS.vcsListRefs,
      staleTimeMs: 5_000,
    }),
    listCommits: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:list-commits",
      tag: WS_METHODS.vcsListCommits,
      staleTimeMs: 10_000,
    }),
    status,
    summary,
    pull: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:pull",
      tag: WS_METHODS.vcsPull,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    refreshStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:refresh-status",
      tag: WS_METHODS.vcsRefreshStatus,
      scheduler: vcsStatusRefreshScheduler,
      concurrency: vcsStatusRefreshConcurrency,
    }),
    clone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:clone",
      tag: WS_METHODS.vcsClone,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCloneCommandConcurrency,
    }),
    createRef: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:create-ref",
      tag: WS_METHODS.vcsCreateRef,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    switchRef: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:switch-ref",
      tag: WS_METHODS.vcsSwitchRef,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    init: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:init",
      tag: WS_METHODS.vcsInit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    generateCommitMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:generate-commit-message",
      tag: WS_METHODS.vcsGenerateCommitMessage,
      // Own lane: a slow generation must not block stage/unstage/discard/commit.
      scheduler: vcsGenerateScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    stageFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:stage-files",
      tag: WS_METHODS.vcsStageFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    unstageFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:unstage-files",
      tag: WS_METHODS.vcsUnstageFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    discardFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:discard-files",
      tag: WS_METHODS.vcsDiscardFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}

export * from "./gitActions.ts";
export * from "./vcsAction.ts";
export * from "./vcsRef.ts";
export * from "./vcsStatus.ts";
