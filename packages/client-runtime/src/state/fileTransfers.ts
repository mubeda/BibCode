import type { EnvironmentId } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { FileContentRoute } from "../operations/fileContentRoute.ts";
import {
  captureFileDownload,
  createFileDownloadAdmission,
  downloadCapturedFile,
  mintCapturedHttpDownload,
  readFileDownloadAvailability,
  type CapturedFileDownload,
  type FileDownloadAdmission,
  type FileDownloadAvailability,
} from "../operations/fileDownloadAdmission.ts";
import {
  FileTransferClientError,
  type DownloadSink,
  type FileTransferProgress,
} from "../operations/fileTransfers.ts";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  runInEnvironment,
  type AtomCommandRunOptions,
  type AtomCommandResult,
} from "./runtime.ts";

export type DownloadResult =
  | { readonly fileName: string; readonly blob: Blob }
  | { readonly path: string };
interface OperationMetadata {
  readonly operationId: number;
  readonly serverName: string;
  readonly fileName: string;
  readonly route: FileContentRoute | null;
  readonly cancellable: boolean;
}
type OperationValue =
  | {
      readonly phase: "preparing" | "running" | "reconnecting" | "cancelling" | "finishing";
      readonly progress: FileTransferProgress;
    }
  | { readonly phase: "ready"; readonly result: Extract<DownloadResult, { readonly blob: Blob }> }
  | { readonly phase: "saved"; readonly path: string }
  | { readonly phase: "failed"; readonly message: string };
export type FileTransferOperation = OperationMetadata & OperationValue;
type Stage =
  | "capturing"
  | "prepared"
  | "downloading"
  | "finishing"
  | "minting-http"
  | "http-active"
  | "ready"
  | "saved"
  | "failed";
interface Invocation {
  readonly environmentId: EnvironmentId;
  readonly operationId: number;
  readonly controller: AbortController;
  stage: Stage;
  progress: FileTransferProgress;
  serverName: string;
  route: FileContentRoute | null;
  captured: CapturedFileDownload | null;
  admission: FileDownloadAdmission | null;
  executing: boolean;
  cancelled: boolean;
  removed: boolean;
  finishing: boolean;
}
interface Owner {
  readonly records: Map<EnvironmentId, Invocation>;
  nextId: number;
  disposed: boolean;
  readonly owns: (record: Invocation) => boolean;
  readonly publish: (record: Invocation, value: OperationValue) => void;
  readonly discard: (record: Invocation) => void;
  readonly cancel: (record: Invocation) => void;
}
interface PreparedTarget {
  readonly environmentId: EnvironmentId;
  readonly admission: FileDownloadAdmission;
}
const busy = (record: Invocation) => record.stage !== "saved" && record.stage !== "failed";
const cancellable = (record: Invocation) =>
  !record.cancelled &&
  !record.finishing &&
  ["capturing", "prepared", "downloading", "minting-http"].includes(record.stage);
const invalidAdmission = () =>
  new FileTransferClientError({
    reason: "unavailable",
    message: "This download is no longer pending. Choose the file again.",
  });

function failureMessage(cause: Cause.Cause<unknown>): string {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag !== "RpcClientError" &&
      "message" in error &&
      typeof error.message === "string"
    )
      return error.message;
  }
  return "The download could not be completed. Try downloading it again.";
}

/** One application owner per AtomRegistry, shared by prepare, encrypted read and legacy HTTP. */
export function createFileTransferEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const operations = Atom.make<ReadonlyMap<EnvironmentId, FileTransferOperation>>(new Map()).pipe(
    Atom.keepAlive,
  );
  const operation = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => get(operations).get(id) ?? null),
  );
  const scheduler = createAtomCommandScheduler();
  const owners = new WeakMap<AtomRegistry.AtomRegistry, Owner>();
  const ownerAtom = Atom.make<Owner>((get) => {
    const records = new Map<EnvironmentId, Invocation>();
    const owns = (record: Invocation) => records.get(record.environmentId) === record;
    const owner: Owner = {
      records,
      nextId: 1,
      disposed: false,
      owns,
      publish: (record, value) => {
        if (owner.disposed || !owns(record)) return;
        const metadata: OperationMetadata = {
          operationId: record.operationId,
          serverName: record.serverName,
          fileName: record.progress.fileName,
          route: record.route,
          cancellable: cancellable(record),
        };
        get.registry.set(
          operations,
          new Map(get.registry.get(operations)).set(record.environmentId, {
            ...metadata,
            ...value,
          }),
        );
      },
      discard: (record) => {
        if (!owns(record)) return;
        records.delete(record.environmentId);
        if (!owner.disposed) {
          const next = new Map(get.registry.get(operations));
          next.delete(record.environmentId);
          get.registry.set(operations, next);
        }
      },
      cancel: (record) => {
        if (!owns(record) || !cancellable(record)) return;
        record.cancelled = true;
        owner.publish(record, { phase: "cancelling", progress: record.progress });
        record.controller.abort();
        if (!record.executing) owner.discard(record);
      },
    };
    owners.set(get.registry, owner);
    get.mount(
      runtime.atom(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* SubscriptionRef.changes(registry.entries).pipe(
            Stream.runForEach(() =>
              Effect.gen(function* () {
                for (const record of records.values()) {
                  const lifetime = yield* registry
                    .registrationLifetime(record.environmentId)
                    .pipe(Effect.option);
                  if (!owns(record)) continue;
                  // A queued change may predate a newly admitted registration.
                  // Judge this invocation against the catalog after its lookup.
                  const entries = yield* SubscriptionRef.get(registry.entries);
                  if (
                    entries.has(record.environmentId) &&
                    (record.captured === null ||
                      (Option.isSome(lifetime) &&
                        lifetime.value === record.captured.identity.registrationLifetime))
                  )
                    continue;
                  record.removed = true;
                  // These operations have no cancellation mechanism after handoff.
                  if (record.stage === "finishing" || record.stage === "http-active") continue;
                  if (record.executing) owner.cancel(record);
                  else owner.discard(record);
                }
              }),
            ),
          );
        }),
      ),
    );
    get.addFinalizer(() => {
      owner.disposed = true;
      for (const record of records.values()) {
        record.removed = true;
        if (!record.finishing && record.stage !== "http-active") record.controller.abort();
        if (!record.executing && record.stage !== "http-active")
          records.delete(record.environmentId);
      }
    });
    return owner;
  }).pipe(Atom.keepAlive);
  const liveOwner = (registry: AtomRegistry.AtomRegistry) => registry.get(ownerAtom);
  const completeFailure = (owner: Owner, record: Invocation, cause: Cause.Cause<unknown>) => {
    if (!owner.owns(record)) return;
    record.executing = false;
    if (
      owner.disposed ||
      (!record.finishing && (record.cancelled || record.removed)) ||
      Cause.hasInterruptsOnly(cause)
    )
      owner.discard(record);
    else {
      record.stage = "failed";
      owner.publish(record, { phase: "failed", message: failureMessage(cause) });
    }
  };
  const withSignal = async <A, Failure>(
    owner: Owner,
    record: Invocation,
    options: AtomCommandRunOptions | undefined,
    run: () => Promise<AtomCommandResult<A, Failure>>,
  ) => {
    const abort = () => owner.cancel(record);
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (options?.signal?.aborted) abort();
    try {
      const result = await run();
      // A runtime-layer failure can settle the command without entering its Effect.
      if (
        result._tag === "Failure" &&
        !record.executing &&
        ["capturing", "downloading", "minting-http"].includes(record.stage)
      )
        completeFailure(owner, record, result.cause);
      return result;
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      if (!record.executing && record.cancelled) owner.discard(record);
    }
  };
  const concurrency = {
    mode: "serial" as const,
    key: ({ record }: { readonly record: Invocation }) => record.environmentId,
  };

  const captureCommand = createRuntimeCommand(runtime, {
    label: "environment-data:transfers:prepare",
    scheduler,
    concurrency,
    execute: (
      {
        record,
        cwd,
        relativePath,
      }: { readonly record: Invocation; readonly cwd: string; readonly relativePath: string },
      registry,
    ) => {
      const owner = liveOwner(registry);
      let executionAdmitted = false;
      return Effect.gen(function* () {
        if (
          record.stage !== "capturing" ||
          !owner.owns(record) ||
          record.controller.signal.aborted ||
          owner.disposed
        )
          return yield* Effect.interrupt;
        executionAdmitted = true;
        record.executing = true;
        const captured = yield* runInEnvironment(
          record.environmentId,
          captureFileDownload({ cwd, relativePath }),
        );
        if (!owner.owns(record) || record.cancelled || record.removed)
          return yield* Effect.interrupt;
        record.captured = captured;
        record.route = captured.route;
        record.serverName = captured.serverName;
        record.admission = createFileDownloadAdmission(record.operationId, captured);
        record.stage = "prepared";
        owner.publish(record, { phase: "preparing", progress: record.progress });
        return record.admission;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!executionAdmitted) return;
            if (Exit.isFailure(exit)) completeFailure(owner, record, exit.cause);
            else record.executing = false;
          }),
        ),
      );
    },
  });
  const downloadCommand = createRuntimeCommand(runtime, {
    label: "environment-data:transfers:download",
    scheduler,
    concurrency,
    execute: (
      {
        record,
        captured,
        sink,
      }: {
        readonly record: Invocation;
        readonly captured: CapturedFileDownload;
        readonly sink: DownloadSink<DownloadResult>;
      },
      registry,
    ) => {
      const owner = liveOwner(registry);
      let executionAdmitted = false;
      return Effect.gen(function* () {
        if (
          record.stage !== "downloading" ||
          !owner.owns(record) ||
          record.controller.signal.aborted ||
          owner.disposed
        )
          return yield* Effect.interrupt;
        executionAdmitted = true;
        record.executing = true;
        return yield* runInEnvironment(
          record.environmentId,
          downloadCapturedFile(
            captured,
            {
              ...sink,
              finish: () => {
                if (
                  !owner.owns(record) ||
                  record.cancelled ||
                  record.removed ||
                  owner.disposed ||
                  record.controller.signal.aborted
                )
                  return Effect.interrupt;
                record.finishing = true;
                record.stage = "finishing";
                owner.publish(record, { phase: "finishing", progress: record.progress });
                return Effect.uninterruptible(sink.finish());
              },
            },
            (progress) => {
              if (!owner.owns(record) || record.cancelled || record.removed || owner.disposed)
                return;
              record.progress = progress;
              owner.publish(record, {
                phase: progress.phase === "reconnecting" ? "reconnecting" : "running",
                progress,
              });
            },
          ),
        );
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!executionAdmitted) return;
            if (!owner.owns(record)) return;
            if (Exit.isFailure(exit)) {
              completeFailure(owner, record, exit.cause);
              return;
            }
            record.executing = false;
            if (owner.disposed) {
              owner.discard(record);
              return;
            }
            if ("blob" in exit.value) {
              record.stage = "ready";
              owner.publish(record, { phase: "ready", result: exit.value });
            } else {
              record.stage = "saved";
              owner.publish(record, { phase: "saved", path: exit.value.path });
            }
          }),
        ),
      );
    },
  });
  const httpCommand = createRuntimeCommand(runtime, {
    label: "environment-data:transfers:prepare-http",
    scheduler,
    concurrency,
    execute: (
      {
        record,
        captured,
      }: { readonly record: Invocation; readonly captured: CapturedFileDownload },
      registry,
    ) => {
      const owner = liveOwner(registry);
      let executionAdmitted = false;
      return Effect.gen(function* () {
        if (
          record.stage !== "minting-http" ||
          !owner.owns(record) ||
          record.controller.signal.aborted ||
          owner.disposed
        )
          return yield* Effect.interrupt;
        executionAdmitted = true;
        record.executing = true;
        const result = yield* runInEnvironment(
          record.environmentId,
          mintCapturedHttpDownload(captured),
        );
        if (!owner.owns(record) || record.cancelled || record.removed)
          return yield* Effect.interrupt;
        record.stage = "http-active";
        record.progress = { ...record.progress, fileName: result.fileName };
        owner.publish(record, { phase: "running", progress: record.progress });
        return result;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!executionAdmitted) return;
            if (Exit.isFailure(exit)) completeFailure(owner, record, exit.cause);
            else record.executing = false;
          }),
        ),
      );
    },
  });

  const take = (owner: Owner, target: PreparedTarget, route: "http" | "in-channel") => {
    const record = owner.records.get(target.environmentId);
    if (
      owner.disposed ||
      record === undefined ||
      record.admission !== target.admission ||
      record.stage !== "prepared" ||
      record.cancelled ||
      record.removed ||
      record.captured === null ||
      record.route !== route
    )
      return null;
    return { record, captured: record.captured };
  };
  const prepareDownload = {
    label: captureCommand.label,
    run: async (
      registry: AtomRegistry.AtomRegistry,
      target: {
        readonly environmentId: EnvironmentId;
        readonly cwd: string;
        readonly relativePath: string;
      },
      options?: AtomCommandRunOptions,
    ): ReturnType<typeof captureCommand.run> => {
      if (options?.signal?.aborted) return AsyncResult.failure(Cause.interrupt());
      const owner = liveOwner(registry);
      const current = owner.records.get(target.environmentId);
      if (current !== undefined && busy(current))
        return AsyncResult.failure(
          Cause.fail(
            new FileTransferClientError({
              reason: "busy",
              message:
                "A file transfer is already active. Save or dismiss a ready download before starting another.",
            }),
          ),
        );
      const record: Invocation = {
        environmentId: target.environmentId,
        operationId: owner.nextId++,
        controller: new AbortController(),
        stage: "capturing",
        progress: {
          direction: "download",
          fileName: target.relativePath.split(/[\\/]/).at(-1) || "Download",
          sentBytes: 0,
          totalBytes: null,
          phase: "transferring",
        },
        serverName: "Server",
        route: null,
        captured: null,
        admission: null,
        executing: false,
        cancelled: false,
        removed: false,
        finishing: false,
      };
      owner.records.set(target.environmentId, record);
      owner.publish(record, { phase: "preparing", progress: record.progress });
      try {
        return await withSignal(owner, record, options, () =>
          captureCommand.run(
            registry,
            { record, cwd: target.cwd, relativePath: target.relativePath },
            { signal: record.controller.signal },
          ),
        );
      } finally {
        if (!record.executing && record.stage === "capturing") owner.discard(record);
      }
    },
  };
  const download = {
    label: downloadCommand.label,
    run: async (
      registry: AtomRegistry.AtomRegistry,
      target: PreparedTarget & { readonly sink: DownloadSink<DownloadResult> },
      options?: AtomCommandRunOptions,
    ): ReturnType<typeof downloadCommand.run> => {
      const owner = liveOwner(registry);
      const active = take(owner, target, "in-channel");
      if (active === null) return AsyncResult.failure(Cause.fail(invalidAdmission()));
      active.record.stage = "downloading";
      owner.publish(active.record, { phase: "running", progress: active.record.progress });
      return await withSignal(owner, active.record, options, () =>
        downloadCommand.run(
          registry,
          { ...active, sink: target.sink },
          { signal: active.record.controller.signal },
        ),
      );
    },
  };
  const prepareHttpDownload = {
    label: httpCommand.label,
    run: async (
      registry: AtomRegistry.AtomRegistry,
      target: PreparedTarget,
      options?: AtomCommandRunOptions,
    ): ReturnType<typeof httpCommand.run> => {
      const owner = liveOwner(registry);
      const active = take(owner, target, "http");
      if (active === null) return AsyncResult.failure(Cause.fail(invalidAdmission()));
      active.record.stage = "minting-http";
      owner.publish(active.record, { phase: "preparing", progress: active.record.progress });
      return await withSignal(owner, active.record, options, () =>
        httpCommand.run(registry, active, { signal: active.record.controller.signal }),
      );
    },
  };
  const availabilityResult = Atom.family((id: EnvironmentId) =>
    runtime.atom(
      Stream.unwrap(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const current = registry.followStream(
            id,
            Stream.unwrap(
              EnvironmentSupervisor.pipe(
                Effect.map((supervisor) =>
                  Stream.merge(
                    SubscriptionRef.changes(supervisor.state).pipe(Stream.map(() => undefined)),
                    SubscriptionRef.changes(registry.entries).pipe(Stream.map(() => undefined)),
                  ).pipe(Stream.mapEffect(() => readFileDownloadAvailability())),
                ),
              ),
            ),
          );
          const removed = SubscriptionRef.changes(registry.entries).pipe(
            Stream.filter((entries) => !entries.has(id)),
            Stream.map((): FileDownloadAvailability => ({
              route: "unavailable",
              connected: false,
              serverName: "Server",
            })),
          );
          return Stream.merge(current, removed);
        }),
      ),
      {
        initialValue: {
          route: "unavailable",
          connected: false,
          serverName: "Server",
        } satisfies FileDownloadAvailability,
      },
    ),
  );
  const availability = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(availabilityResult(id));
      return AsyncResult.isSuccess(result)
        ? result.value
        : ({
            route: "unavailable",
            connected: false,
            serverName: "Server",
          } satisfies FileDownloadAvailability);
    }),
  );
  return {
    prepareDownload,
    download,
    prepareHttpDownload,
    operations,
    operation,
    availability,
    releaseAdmission: (
      registry: AtomRegistry.AtomRegistry,
      id: EnvironmentId,
      admission: FileDownloadAdmission,
    ): void => {
      const owner = owners.get(registry);
      const record = owner?.records.get(id);
      if (owner === undefined || record === undefined || record.admission !== admission) return;
      if (record.stage === "prepared") owner.cancel(record);
      else if (record.stage === "http-active") owner.discard(record);
    },
    cancel: (registry: AtomRegistry.AtomRegistry, id: EnvironmentId, operationId: number): void => {
      const owner = owners.get(registry);
      const record = owner?.records.get(id);
      if (owner !== undefined && !owner.disposed && record?.operationId === operationId)
        owner.cancel(record);
    },
    dismiss: (
      registry: AtomRegistry.AtomRegistry,
      id: EnvironmentId,
      operationId: number,
    ): void => {
      const owner = owners.get(registry);
      const record = owner?.records.get(id);
      if (
        owner !== undefined &&
        record?.operationId === operationId &&
        ["ready", "saved", "failed"].includes(record.stage)
      )
        owner.discard(record);
    },
  };
}
