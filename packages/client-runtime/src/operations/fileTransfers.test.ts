import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ProjectDownloadError,
  WS_METHODS,
  type ProjectDownloadEvent,
  type ProjectReadDownloadInput,
  type ServerConfig,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  downloadFile,
  FileTransferClientError,
  type DownloadFailure,
  type DownloadSink,
  type DownloadStart,
  type FileTransferProgress,
} from "./fileTransfers.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("test-host"),
  label: "Host",
  httpBaseUrl: "https://host.invalid",
  wsBaseUrl: "wss://host.invalid",
});
const decodeDescriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor);
const descriptor = (capable = true, storageInstanceId: string | null = "store") =>
  decodeDescriptor({
    environmentId: target.environmentId,
    label: "Host",
    serverVersion: "test",
    platform: { os: "linux", arch: "x64" },
    storageInstanceId,
    capabilities: { inChannelTransfers: capable },
  });
const start = (sizeBytes = 3): DownloadStart => ({
  _tag: "start",
  kind: "file",
  fileName: "a.txt",
  sizeBytes,
  version: { sizeBytes, modifiedAtNs: "1234567890123456789" },
});
const archive: DownloadStart = {
  _tag: "start",
  kind: "archive",
  fileName: "folder.zip",
  sizeBytes: null,
  version: null,
};
const bytes = (offset = 0, data = "YWJj"): ProjectDownloadEvent => ({
  _tag: "bytes",
  offset,
  data,
});
const end = (totalBytes = 3): ProjectDownloadEvent => ({ _tag: "end", totalBytes });
const transport = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({
    message: "fixture transport lost",
    cause: "fixture",
  }),
});
type Read = (
  input: ProjectReadDownloadInput,
) => Stream.Stream<ProjectDownloadEvent, DownloadFailure>;

const harness = Effect.fn(function* (read: Read) {
  const lifetime = {};
  const calls: ProjectReadDownloadInput[] = [];
  const options: unknown[] = [];
  const makeSession = (
    nextRead: Read,
    capable = true,
    store: string | null = "store",
  ): RpcSession => ({
    client: {
      [WS_METHODS.projectsReadDownload]: (input: ProjectReadDownloadInput, opts: unknown) => {
        calls.push(input);
        options.push(opts);
        return nextRead(input);
      },
    } as unknown as RpcSession["client"],
    initialConfig: Effect.succeed({ environment: descriptor(capable, store) } as ServerConfig),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  });
  const prepared: PreparedConnection = {
    target,
    environmentId: target.environmentId,
    label: "Host",
    descriptor: descriptor(),
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: `${target.wsBaseUrl}/ws-e2ee`,
    httpAuthorization: null,
    e2ee: { hostKey: "pin", auth: { kind: "bearer", credential: "fixture" } },
  };
  const supervisor = EnvironmentSupervisor.of({
    target,
    session: yield* SubscriptionRef.make(Option.some(makeSession(read))),
    prepared: yield* SubscriptionRef.make(Option.some(prepared)),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected",
      generation: 1,
    }),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[target.environmentId, { target, profile: Option.none() }]]),
  );
  const fixture: Pick<
    EnvironmentRegistry["Service"],
    "entries" | "registrationLifetime" | "run" | "followStream"
  > = {
    entries,
    registrationLifetime: () => Effect.succeed(lifetime),
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  };
  const registry = fixture as EnvironmentRegistry["Service"];
  return {
    calls,
    options,
    supervisor,
    registry,
    run: <A, E>(effect: Effect.Effect<A, E, EnvironmentRegistry | EnvironmentSupervisor>) =>
      effect.pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(EnvironmentSupervisor, supervisor),
      ),
    reconnect: (nextRead: Read, capable = true, store: string | null = "store") =>
      SubscriptionRef.set(
        supervisor.session,
        Option.some(makeSession(nextRead, capable, store)),
      ).pipe(
        Effect.andThen(
          SubscriptionRef.update(supervisor.state, (value) => ({
            ...value,
            generation: value.generation + 1,
          })),
        ),
      ),
  };
});

function sink(overrides: Partial<DownloadSink<readonly number[]>> = {}) {
  const saved: number[] = [];
  const events: string[] = [];
  const result: DownloadSink<readonly number[]> = {
    start: () =>
      Effect.sync(() => {
        events.push("start");
      }),
    reset: () =>
      Effect.sync(() => {
        events.push("reset");
        saved.length = 0;
      }),
    write: (offset, value) =>
      Effect.sync(() => {
        expect(offset).toBe(saved.length);
        events.push(`write:${offset}`);
        saved.push(...value);
      }),
    finish: () =>
      Effect.sync(() => {
        events.push("finish");
        return [...saved];
      }),
    abort: () =>
      Effect.sync(() => {
        events.push("abort");
      }),
    ...overrides,
  };
  return { saved, events, result };
}
const input = <A>(
  result: DownloadSink<A>,
  onProgress?: (progress: FileTransferProgress) => void,
) => ({
  cwd: "/repo",
  relativePath: "a.txt",
  sink: result,
  ...(onProgress === undefined ? {} : { onProgress }),
});

describe("in-channel downloads", () => {
  for (const change of ["retarget", "remove", "store"] as const) {
    it.effect(`rechecks ${change} made by the final sink write before saving`, () =>
      Effect.gen(function* () {
        const h = yield* harness(() => Stream.make(start(), bytes(), end()));
        const s = sink();
        const mutate =
          change === "store"
            ? h.reconnect(() => Stream.empty, true, "other-store")
            : SubscriptionRef.set(
                h.registry.entries,
                change === "remove"
                  ? new Map()
                  : new Map([
                      [
                        target.environmentId,
                        {
                          target: new PrimaryConnectionTarget({
                            ...target,
                            httpBaseUrl: "https://changed.invalid",
                          }),
                          profile: Option.none(),
                        },
                      ],
                    ]),
              );
        const result = yield* Effect.exit(
          h.run(
            downloadFile(
              input({
                ...s.result,
                write: (offset, data) => s.result.write(offset, data).pipe(Effect.andThen(mutate)),
              }),
            ),
          ),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(s.events).not.toContain("finish");
        expect(s.events.at(-1)).toBe("abort");
      }),
    );
  }
  for (const size of [0, 3])
    it.effect(`saves an exact ${size}-byte file only after successful stream completion`, () =>
      Effect.gen(function* () {
        const h = yield* harness(() =>
          Stream.fromArray(size === 0 ? [start(0), end(0)] : [start(), bytes(), end()]),
        );
        const s = sink();
        expect(yield* h.run(downloadFile(input(s.result)))).toEqual(size === 0 ? [] : [97, 98, 99]);
        expect(s.events).toEqual(size === 0 ? ["start", "finish"] : ["start", "write:0", "finish"]);
        expect(h.options).toEqual([{ streamBufferSize: 2 }]);
      }),
    );

  const invalid: ReadonlyArray<readonly [string, Read]> = [
    ["missing start", () => Stream.make(bytes(), end())],
    ["missing end", () => Stream.make(start(), bytes())],
    ["duplicate start", () => Stream.make(start(), start(), bytes(), end())],
    ["duplicate end", () => Stream.make(start(0), end(0), end(0))],
    ["bytes after end", () => Stream.make(start(0), end(0), bytes())],
    ["wrong total", () => Stream.make(start(), bytes(), end(2))],
    ["early end", () => Stream.make(start(), end(0))],
    ["gap", () => Stream.make(start(), bytes(1), end())],
    ["overlap", () => Stream.make(start(6), bytes(), bytes(0), end(6))],
    ["malformed base64", () => Stream.make(start(), bytes(0, "!not-base64!"), end())],
    ["noncanonical base64", () => Stream.make(start(1), bytes(0, "YR=="), end(1))],
    ["empty byte event", () => Stream.make(start(0), bytes(0, ""), end(0))],
    [
      "oversized chunk",
      () =>
        Stream.make(
          start(1024 * 1024 + 1),
          bytes(0, Encoding.encodeBase64(new Uint8Array(1024 * 1024 + 1))),
          end(1024 * 1024 + 1),
        ),
    ],
    [
      "incoherent file version",
      () =>
        Stream.make({ ...start(), version: { sizeBytes: 5, modifiedAtNs: "1" } }, bytes(), end()),
    ],
    ["incoherent archive", () => Stream.make({ ...archive, sizeBytes: 3 }, bytes(), end())],
    [
      "failure after end",
      () =>
        Stream.make(start(), bytes(), end()).pipe(
          Stream.concat(
            Stream.fail(new ProjectDownloadError({ reason: "changed", message: "changed" })),
          ),
        ),
    ],
  ];
  for (const [name, read] of invalid)
    it.effect(`aborts exactly once for ${name}`, () =>
      Effect.gen(function* () {
        const h = yield* harness(read);
        const s = sink();
        const failure = yield* Effect.exit(h.run(downloadFile(input(s.result))));
        expect(failure).toMatchObject({
          _tag: "Failure",
          cause: {
            reasons: [
              {
                _tag: "Fail",
                error: {
                  _tag:
                    name === "failure after end"
                      ? "ProjectDownloadError"
                      : "FileTransferClientError",
                  reason: name === "failure after end" ? "changed" : "protocol",
                },
              },
            ],
          },
        });
        expect(s.events.filter((value) => value === "abort")).toHaveLength(1);
        expect(s.events).not.toContain("finish");
      }),
    );

  for (const reason of ["changed", "capacity", "not_resumable"] as const)
    it.effect(`preserves typed ${reason} refusal without retry`, () =>
      Effect.gen(function* () {
        const failure = new ProjectDownloadError({ reason, message: "fixture refusal" });
        const h = yield* harness(() => Stream.fail(failure));
        const s = sink();
        const result = yield* Effect.exit(h.run(downloadFile(input(s.result))));
        expect(result).toMatchObject({ _tag: "Failure", cause: { reasons: [{ error: failure }] } });
        expect(h.calls).toHaveLength(1);
        expect(s.events).toEqual(["abort"]);
      }),
    );

  it.effect(
    "does not advance progress or consume the next chunk until a blocked write commits",
    () =>
      Effect.gen(function* () {
        const writing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const h = yield* harness(() => Stream.make(start(), bytes(), end()));
        const progress: FileTransferProgress[] = [];
        const s = sink();
        const pending = yield* h
          .run(
            downloadFile(
              input(
                {
                  ...s.result,
                  write: (offset, value) =>
                    Deferred.succeed(writing, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(s.result.write(offset, value)),
                    ),
                },
                (value) => progress.push(value),
              ),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(writing);
        expect(progress.at(-1)?.sentBytes).toBe(0);
        expect(s.events).toEqual(["start"]);
        yield* Deferred.succeed(release, undefined);
        expect(Exit.isSuccess(yield* Fiber.await(pending))).toBe(true);
        expect(progress.at(-1)?.sentBytes).toBe(3);
      }),
  );

  for (const lastByte of [false, true])
    it.effect(`resumes from committed bytes${lastByte ? " when only the exit was lost" : ""}`, () =>
      Effect.gen(function* () {
        let cut = Effect.void;
        const h = yield* harness(() =>
          Stream.make(start(), bytes(0, "YQ==")).pipe(
            Stream.concat(Stream.fromEffect(Effect.suspend(() => cut)).pipe(Stream.drain)),
            Stream.concat(Stream.fail(transport)),
          ),
        );
        cut = h.reconnect(() =>
          Stream.fromArray(lastByte ? [start(1), end(1)] : [start(), bytes(1, "YmM="), end()]),
        );
        if (lastByte) {
          yield* h.reconnect(() =>
            Stream.make(start(1), bytes(0, "YQ==")).pipe(
              Stream.concat(Stream.fromEffect(cut).pipe(Stream.drain)),
              Stream.concat(Stream.fail(transport)),
            ),
          );
        }
        const s = sink();
        expect(yield* h.run(downloadFile(input(s.result)))).toEqual(lastByte ? [97] : [97, 98, 99]);
        expect(h.calls.at(-1)).toEqual({
          cwd: "/repo",
          relativePath: "a.txt",
          offset: 1,
          expect: start(lastByte ? 1 : 3).version,
        });
        expect(s.events).not.toContain("reset");
        expect(s.events.filter((value) => value === "start")).toHaveLength(1);
      }),
    );

  it.effect("restarts an archive once and refuses a second cut", () =>
    Effect.gen(function* () {
      let cut = Effect.void;
      const read: Read = () =>
        Stream.make(archive, bytes()).pipe(
          Stream.concat(Stream.fromEffect(Effect.suspend(() => cut)).pipe(Stream.drain)),
          Stream.concat(Stream.fail(transport)),
        );
      const h = yield* harness(read);
      cut = h.reconnect(read);
      const s = sink();
      expect(Exit.isFailure(yield* Effect.exit(h.run(downloadFile(input(s.result)))))).toBe(true);
      expect(h.calls).toHaveLength(2);
      expect(s.events).toEqual(["start", "write:0", "reset", "write:0", "abort"]);
    }),
  );

  it.effect("saves a restarted archive without appending to its old partial bytes", () =>
    Effect.gen(function* () {
      let cut = Effect.void;
      const h = yield* harness(() =>
        Stream.make(archive, bytes()).pipe(
          Stream.concat(Stream.fromEffect(Effect.suspend(() => cut)).pipe(Stream.drain)),
          Stream.concat(Stream.fail(transport)),
        ),
      );
      cut = h.reconnect(() => Stream.make(archive, bytes(0, "ZGVm"), end()));
      const s = sink();
      expect(yield* h.run(downloadFile(input(s.result)))).toEqual([100, 101, 102]);
      expect(s.events).toEqual(["start", "write:0", "reset", "write:0", "finish"]);
      expect(h.calls.at(-1)).toEqual({ cwd: "/repo", relativePath: "a.txt" });
    }),
  );

  it.effect("does not reset an unstarted sink after a pre-start transport cut", () =>
    Effect.gen(function* () {
      let cut = Effect.void;
      const h = yield* harness(() =>
        Stream.fromEffect(Effect.suspend(() => cut)).pipe(
          Stream.drain,
          Stream.concat(Stream.failCause(Cause.interrupt())),
        ),
      );
      cut = h.reconnect(() => Stream.make(start(), bytes(), end()));
      const s = sink();
      expect(yield* h.run(downloadFile(input(s.result)))).toEqual([97, 98, 99]);
      expect(s.events).toEqual(["start", "write:0", "finish"]);
    }),
  );

  for (const mutation of ["name", "version", "kind"] as const)
    it.effect(`refuses resumed ${mutation} mismatch`, () =>
      Effect.gen(function* () {
        let cut = Effect.void;
        const h = yield* harness(() =>
          Stream.make(start(), bytes(0, "YQ==")).pipe(
            Stream.concat(Stream.fromEffect(Effect.suspend(() => cut)).pipe(Stream.drain)),
            Stream.concat(Stream.fail(transport)),
          ),
        );
        const replacement =
          mutation === "kind"
            ? archive
            : mutation === "name"
              ? { ...start(), fileName: "other.txt" }
              : { ...start(), version: { sizeBytes: 3, modifiedAtNs: "2" } };
        cut = h.reconnect(() => Stream.make(replacement, bytes(1, "YmM="), end()));
        const s = sink();
        const result = yield* Effect.exit(h.run(downloadFile(input(s.result))));
        expect(result).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { reason: "protocol" } }] },
        });
        expect(s.events).toEqual(["start", "write:0", "abort"]);
      }),
    );

  it.effect("aborts if resetting an archive sink fails", () =>
    Effect.gen(function* () {
      let cut = Effect.void;
      const h = yield* harness(() =>
        Stream.make(archive, bytes()).pipe(
          Stream.concat(Stream.fromEffect(Effect.suspend(() => cut)).pipe(Stream.drain)),
          Stream.concat(Stream.fail(transport)),
        ),
      );
      cut = h.reconnect(() => Stream.make(archive, bytes(), end()));
      const s = sink({
        reset: () =>
          Effect.fail(new FileTransferClientError({ reason: "save", message: "reset failed" })),
      });
      const result = yield* Effect.exit(h.run(downloadFile(input(s.result))));
      expect(result).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { reason: "save" } }] },
      });
      expect(s.events).toEqual(["start", "write:0", "abort"]);
    }),
  );

  it.effect("refuses a pinned incapable server without issuing a read", () =>
    Effect.gen(function* () {
      const h = yield* harness(() => Stream.make(start(), bytes(), end()));
      yield* h.reconnect(() => Stream.make(start(), bytes(), end()), false);
      const s = sink();
      const result = yield* Effect.exit(h.run(downloadFile(input(s.result))));
      expect(result).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { reason: "unavailable" } }] },
      });
      expect(h.calls).toHaveLength(0);
      expect(s.events).toEqual(["abort"]);
    }),
  );

  for (const change of ["capability", "store"] as const)
    it.effect(`refuses replacement ${change} before issuing a resumed RPC`, () =>
      Effect.gen(function* () {
        let cut = Effect.void;
        const h = yield* harness(() =>
          Stream.make(start(), bytes()).pipe(
            Stream.concat(Stream.fromEffect(Effect.suspend(() => cut)).pipe(Stream.drain)),
            Stream.concat(Stream.fail(transport)),
          ),
        );
        cut = h.reconnect(
          () => Stream.make(start(), end()),
          change !== "capability",
          change === "store" ? "other-store" : "store",
        );
        const s = sink();
        expect(Exit.isFailure(yield* Effect.exit(h.run(downloadFile(input(s.result)))))).toBe(true);
        expect(h.calls).toHaveLength(1);
        expect(s.events).not.toContain("finish");
        expect(s.events.at(-1)).toBe("abort");
      }),
    );

  for (const stage of ["start", "write", "finish"] as const)
    it.effect(`joins one abort after sink ${stage} failure`, () =>
      Effect.gen(function* () {
        const h = yield* harness(() => Stream.make(start(), bytes(), end()));
        const failure = new FileTransferClientError({
          reason: "save",
          message: "fixture sink failed",
        });
        const s = sink({ [stage]: () => Effect.fail(failure) });
        const result = yield* Effect.exit(h.run(downloadFile(input(s.result))));
        expect(result).toMatchObject({ _tag: "Failure", cause: { reasons: [{ error: failure }] } });
        expect(s.events.filter((value) => value === "abort")).toHaveLength(1);
      }),
    );

  it.effect("keeps explicit cancellation pending until the sink abort joins", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const h = yield* harness(() => Stream.make(start()).pipe(Stream.concat(Stream.never)));
      const s = sink({
        start: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
        abort: () =>
          Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(cleaned))),
      });
      const pending = yield* h.run(downloadFile(input(s.result))).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const cancel = yield* Fiber.interrupt(pending).pipe(Effect.forkChild);
      yield* Deferred.await(cleaning);
      expect(cancel.pollUnsafe()).toBeUndefined();
      expect(h.calls).toHaveLength(1);
      yield* Deferred.succeed(cleaned, undefined);
      yield* Fiber.join(cancel);
    }),
  );

  it.effect(
    "a catalog retarget cancels a blocked sink write before accepting another host's content",
    () =>
      Effect.gen(function* () {
        const writing = yield* Deferred.make<void>();
        const h = yield* harness(() => Stream.make(start(), bytes(), end()));
        const s = sink({
          write: () => Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const pending = yield* h.run(downloadFile(input(s.result))).pipe(Effect.forkChild);
        yield* Deferred.await(writing);
        yield* SubscriptionRef.set(
          h.registry.entries,
          new Map([
            [
              target.environmentId,
              {
                target: new PrimaryConnectionTarget({
                  ...target,
                  httpBaseUrl: "https://other.invalid",
                }),
                profile: Option.none(),
              },
            ],
          ]),
        );
        expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
        expect(s.events.at(-1)).toBe("abort");
        expect(s.events).not.toContain("finish");
      }),
  );
});
