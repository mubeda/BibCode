import {
  type ExecutionEnvironmentDescriptor,
  type EnvironmentId,
  type ProjectWorktreeDiscoveryPolicy,
  type ThreadId,
  type VcsAdoptedWorktreeStatus,
  type VcsWorktreeCatalogSnapshot,
  type VcsWorktreeDescriptor,
  type WorktreeAdoptInput,
  type WorktreeAdoptResult,
  type WorktreeKey,
  WS_METHODS,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
  settlePromise,
} from "./runtime.ts";

export interface WorktreeDiscoveryStateInput {
  readonly snapshot: VcsWorktreeCatalogSnapshot;
  readonly policy: ProjectWorktreeDiscoveryPolicy;
}

export interface WorktreeDiscoveryState {
  readonly newCandidates: ReadonlyArray<VcsWorktreeDescriptor>;
  readonly acknowledgedCandidates: ReadonlyArray<VcsWorktreeDescriptor>;
  readonly showInitialPrompt: boolean;
  readonly showCollapsedHiddenLine: boolean;
  readonly shownCandidates: ReadonlyArray<VcsWorktreeDescriptor>;
}

export interface WorktreeAddAllInput {
  readonly candidates: ReadonlyArray<WorktreeAdoptInput>;
}

export type WorktreeAddAllItemResult =
  | {
      readonly _tag: "Success";
      readonly worktreeKey: WorktreeKey;
      readonly result: WorktreeAdoptResult;
    }
  | {
      readonly _tag: "Failure";
      readonly worktreeKey: WorktreeKey;
      readonly error: unknown;
    };

export interface WorktreeAddAllResult {
  readonly results: ReadonlyArray<WorktreeAddAllItemResult>;
}

export function deriveWorktreeDiscoveryState(
  input: WorktreeDiscoveryStateInput,
): WorktreeDiscoveryState {
  const candidates = input.snapshot.worktrees.filter((worktree) => worktree.eligibleForAdoption);
  const baselinePaths = new Set(input.policy.baselinePaths);
  const newCandidates = candidates.filter((worktree) => !baselinePaths.has(worktree.path));
  const acknowledgedCandidates = candidates.filter((worktree) => baselinePaths.has(worktree.path));
  const showInitialPrompt =
    input.policy.visibility === "hidden" &&
    (input.policy.initialPromptDismissedAt === null
      ? candidates.length > 0
      : newCandidates.length > 0);

  return {
    newCandidates,
    acknowledgedCandidates,
    showInitialPrompt,
    showCollapsedHiddenLine:
      input.policy.visibility === "hidden" && candidates.length > 0 && !showInitialPrompt,
    shownCandidates: input.policy.visibility === "shown" ? candidates : [],
  };
}

export function deriveAdoptedWorkspaceStateByThreadId(
  snapshot: VcsWorktreeCatalogSnapshot,
): ReadonlyMap<ThreadId, VcsAdoptedWorktreeStatus> {
  return new Map(snapshot.adoptedWorkspaces.map((workspace) => [workspace.threadId, workspace]));
}

export function isWorktreeCatalogSupported(
  environmentDescriptor: ExecutionEnvironmentDescriptor,
): boolean {
  return environmentDescriptor.capabilities.worktreeCatalog;
}

function retainLastUsableWorktreeCatalogRows<E, R>(
  stream: Stream.Stream<VcsWorktreeCatalogSnapshot, E, R>,
): Stream.Stream<VcsWorktreeCatalogSnapshot, E, R> {
  return stream.pipe(
    Stream.mapAccum(
      () => null as VcsWorktreeCatalogSnapshot | null,
      (lastAuthoritative, current) => {
        const retained =
          !current.authoritative &&
          current.scanStatus._tag === "degraded" &&
          lastAuthoritative !== null
            ? {
                ...current,
                worktrees: lastAuthoritative.worktrees,
                adoptedWorkspaces: lastAuthoritative.adoptedWorkspaces,
              }
            : current;
        return [current.authoritative ? current : lastAuthoritative, [retained]] as const;
      },
    ),
  );
}

export function createWorktreeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const bulkScheduler = createAtomCommandScheduler();
  const projectKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly projectId: string };
  }) => JSON.stringify([environmentId, input.projectId]);

  const addOne = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:worktrees:add-one",
    tag: WS_METHODS.worktreeAdopt,
    scheduler: commandScheduler,
    concurrency: { mode: "serial", key: projectKey },
  });
  const addAll = {
    label: "environment-data:worktrees:add-all",
    run: (
      registry: Parameters<typeof addOne.run>[0],
      target: { readonly environmentId: EnvironmentId; readonly input: WorktreeAddAllInput },
    ) =>
      bulkScheduler.schedule(
        registry,
        { mode: "serial", key: ({ environmentId }) => environmentId },
        target,
        () =>
          settlePromise(() => {
            const adoptCandidate = Effect.fn("Worktrees.adoptCandidate")(function* (
              candidate: WorktreeAdoptInput,
            ) {
              const result = yield* Effect.promise(() =>
                addOne.run(registry, {
                  environmentId: target.environmentId,
                  input: candidate,
                }),
              );
              return result._tag === "Success"
                ? ({
                    _tag: "Success",
                    worktreeKey: candidate.worktreeKey,
                    result: result.value,
                  } satisfies WorktreeAddAllItemResult)
                : ({
                    _tag: "Failure",
                    worktreeKey: candidate.worktreeKey,
                    error: Cause.squash(result.cause),
                  } satisfies WorktreeAddAllItemResult);
            });
            return Effect.runPromise(
              Effect.forEach(target.input.candidates, adoptCandidate, { concurrency: 4 }).pipe(
                Effect.map((results): WorktreeAddAllResult => ({ results })),
              ),
            );
          }),
      ),
  };

  return {
    catalog: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:worktrees:catalog",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.subscribeWorktreeCatalog>) =>
        retainLastUsableWorktreeCatalogRows(subscribe(WS_METHODS.subscribeWorktreeCatalog, input)),
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:worktrees:refresh",
      tag: WS_METHODS.vcsRefreshWorktreeCatalog,
      scheduler: commandScheduler,
      concurrency: { mode: "singleFlight", key: projectKey },
    }),
    updatePolicy: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:worktrees:update-policy",
      tag: WS_METHODS.worktreeUpdateDiscoveryPolicy,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: projectKey },
    }),
    addOne,
    addAll,
  };
}
