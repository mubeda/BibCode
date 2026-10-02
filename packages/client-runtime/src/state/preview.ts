import { WS_METHODS, type EnvironmentId } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry, EnvironmentNotRegisteredError } from "../connection/registry.ts";
import {
  captureHttpFilePreviewAuthority,
  openCapturedHttpFilePreview,
  type HttpFilePreviewInput,
  type HttpFilePreviewResult,
} from "../operations/filePreview.ts";
import {
  sameFileContentIdentity,
  type FileContentIdentity,
} from "../operations/fileTransferSession.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  runInEnvironment,
  type AtomCommandResult,
  type AtomCommandRunOptions,
} from "./runtime.ts";

export interface HttpFilePreviewCommandResult extends HttpFilePreviewResult {
  /** Check immediately before manual UI publication; this cannot undo server effects. */
  readonly isCurrentContext: () => boolean;
}

export const previewAutomationHostFocusConcurrencyKey = (value: {
  readonly environmentId: string;
  readonly input: {
    readonly clientId: string;
    readonly connectionId: string;
  };
}): string => JSON.stringify([value.environmentId, value.input.clientId, value.input.connectionId]);

export function createPreviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const statusScheduler = createAtomCommandScheduler();
  const automationScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  type AuthorityResult = AtomCommandResult<
    FileContentIdentity,
    E | EnvironmentNotRegisteredError | EnvironmentRpcUnavailableError
  >;
  const notReady = (environmentId: EnvironmentId) =>
    new EnvironmentRpcUnavailableError({
      environmentId,
      message: "The connection is not ready for this preview. Try opening the file again.",
    });
  const captureCurrentAuthority = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ): AuthorityResult => {
    // Lifecycle metadata remains safe after disposal; do not recreate atoms in a retired/cold registry.
    const node = registry.getNodes().get(runtime);
    if (node === undefined || node.currentState() !== "valid")
      return AsyncResult.failure(Cause.fail(notReady(environmentId)));
    const context = node.value();
    if (!AsyncResult.isSuccess(context) || context.waiting)
      return AsyncResult.failure(Cause.fail(notReady(environmentId)));
    let accepting = true;
    const capture = runtime
      .atom(
        Effect.suspend(() => {
          if (!accepting) return Effect.interrupt;
          accepting = false;
          return runInEnvironment(environmentId, captureHttpFilePreviewAuthority());
        }).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(notReady(environmentId)),
          }),
        ),
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel("environment-data:preview:call-entry-authority"));
    let unmount = () => {};
    try {
      unmount = registry.mount(capture);
      const result = registry.get(capture);
      if (AsyncResult.isSuccess(result) && !result.waiting)
        return AsyncResult.success(result.value);
      if (AsyncResult.isFailure(result) && !result.waiting)
        return AsyncResult.failure(result.cause);
      return AsyncResult.failure(Cause.fail(notReady(environmentId)));
    } finally {
      accepting = false;
      try {
        // Unmount schedules removal. Invalidate the sealed cell now to stop any pending reader.
        if (registry.getNodes().has(capture)) registry.refresh(capture);
      } finally {
        unmount();
      }
    }
  };
  const openFileCommand = createRuntimeCommand(runtime, {
    label: "environment-data:preview:open-file",
    execute: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: HttpFilePreviewInput;
      readonly authority: FileContentIdentity;
      readonly isCurrentContext: () => boolean;
    }) =>
      runInEnvironment(
        target.environmentId,
        openCapturedHttpFilePreview(target.input, target.authority),
      ).pipe(
        Effect.map(
          (result) =>
            ({
              ...result,
              isCurrentContext: target.isCurrentContext,
            }) satisfies HttpFilePreviewCommandResult,
        ),
      ),
    scheduler: lifecycleScheduler,
    concurrency: lifecycleConcurrency,
  });
  const openFile = {
    label: openFileCommand.label,
    run: async (
      registry: AtomRegistry.AtomRegistry,
      target: { readonly environmentId: EnvironmentId; readonly input: HttpFilePreviewInput },
      options?: AtomCommandRunOptions,
    ): ReturnType<typeof openFileCommand.run> => {
      try {
        const snapshot = {
          environmentId: target.environmentId,
          input: { threadId: target.input.threadId, filePath: target.input.filePath },
        };
        const captured = options?.signal?.aborted
          ? AsyncResult.failure(Cause.interrupt())
          : captureCurrentAuthority(registry, snapshot.environmentId);
        if (captured._tag === "Failure")
          return await lifecycleScheduler.schedule(registry, lifecycleConcurrency, snapshot, () =>
            Promise.resolve(
              options?.signal?.aborted
                ? AsyncResult.failure(Cause.interrupt())
                : AsyncResult.failure(captured.cause),
            ),
          );
        const authority = captured.value;
        const entryRuntime = registry.getNodes().get(runtime);
        return await openFileCommand.run(
          registry,
          {
            ...snapshot,
            authority,
            isCurrentContext: () => {
              if (options?.signal?.aborted || entryRuntime?.currentState() !== "valid")
                return false;
              try {
                const current = captureCurrentAuthority(registry, snapshot.environmentId);
                return (
                  current._tag === "Success" && sameFileContentIdentity(authority, current.value)
                );
              } catch {
                return false;
              }
            },
          },
          options,
        );
      } catch (cause) {
        return AsyncResult.failure(Cause.die(cause));
      }
    },
  };
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:preview:list",
      tag: WS_METHODS.previewList,
      staleTimeMs: 5_000,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:events",
      tag: WS_METHODS.subscribePreviewEvents,
    }),
    discoveredServers: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:discovered-servers",
      tag: WS_METHODS.subscribeDiscoveredLocalServers,
    }),
    automationRequests: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:automation-requests",
      tag: WS_METHODS.previewAutomationConnect,
      // Automation requests are commands, not cached query data. Dispose the
      // stream immediately with its owner so stale requests cannot replay when
      // a thread remounts and the server can clear disconnected hosts promptly.
      idleTtlMs: 0,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:open",
      tag: WS_METHODS.previewOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    openFile,
    navigate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:navigate",
      tag: WS_METHODS.previewNavigate,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:resize",
      tag: WS_METHODS.previewResize,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:refresh",
      tag: WS_METHODS.previewRefresh,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:close",
      tag: WS_METHODS.previewClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    reportStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:report-status",
      tag: WS_METHODS.previewReportStatus,
      scheduler: statusScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.tabId]),
      },
    }),
    respondToAutomation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-respond",
      tag: WS_METHODS.previewAutomationRespond,
      scheduler: automationScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.connectionId, input.requestId]),
      },
    }),
    focusAutomationHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-focus-host",
      tag: WS_METHODS.previewAutomationFocusHost,
      scheduler: automationScheduler,
      concurrency: {
        mode: "latest",
        key: previewAutomationHostFocusConcurrencyKey,
      },
    }),
  };
}
