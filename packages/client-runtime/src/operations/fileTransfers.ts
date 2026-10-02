import { type ProjectDownloadEvent, WS_METHODS } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { isSessionTransportLoss, nextSession } from "../connection/nextSession.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  currentSession,
  EnvironmentRpcUnavailableError,
  runStreamInSession,
  type EnvironmentRpcStreamFailure,
} from "../rpc/client.ts";
import { fileContentRoute } from "./fileContentRoute.ts";
import {
  assertFileContentIdentity,
  fileContentInvalidated,
  readFileTransferSession,
  sameFileContentIdentity,
  type FileContentIdentity,
} from "./fileTransferSession.ts";

export type DownloadStart = Extract<ProjectDownloadEvent, { readonly _tag: "start" }>;
export interface FileTransferProgress {
  readonly direction: "download" | "upload";
  readonly fileName: string;
  readonly sentBytes: number;
  readonly totalBytes: number | null;
  readonly phase: "transferring" | "reconnecting";
}
export class FileTransferClientError extends Schema.TaggedError<FileTransferClientError>()(
  "FileTransferClientError",
  {
    reason: Schema.Literals(["unavailable", "protocol", "browser_limit", "busy", "save"]),
    message: Schema.String,
  },
) {}
export interface DownloadSink<A> {
  readonly start: (start: DownloadStart) => Effect.Effect<void, FileTransferClientError>;
  readonly write: (
    offset: number,
    bytes: Uint8Array,
  ) => Effect.Effect<void, FileTransferClientError>;
  readonly reset: (start: DownloadStart) => Effect.Effect<void, FileTransferClientError>;
  readonly finish: () => Effect.Effect<A, FileTransferClientError>;
  readonly abort: () => Effect.Effect<void>;
}
export interface DownloadFileInput<A> {
  readonly cwd: string;
  readonly relativePath: string;
  readonly sink: DownloadSink<A>;
  readonly onProgress?: (progress: FileTransferProgress) => void;
}
export type DownloadFailure =
  | EnvironmentRpcStreamFailure<typeof WS_METHODS.projectsReadDownload>
  | FileTransferClientError
  | EnvironmentRpcUnavailableError;

const protocolError = () =>
  new FileTransferClientError({
    reason: "protocol",
    message: "The server sent an incomplete or invalid file. Download it again.",
  });

/** Shared bounded canonical wire decoding for downloads and exact assets. */
export function decodeTransferChunk(
  data: string,
): Effect.Effect<Uint8Array, FileTransferClientError> {
  if (data.length === 0 || data.length > 1_398_104) return Effect.fail(protocolError());
  const decoded = Encoding.decodeBase64(data);
  return Result.isFailure(decoded) ||
    decoded.success.byteLength === 0 ||
    decoded.success.byteLength > 1024 * 1024 ||
    Encoding.encodeBase64(decoded.success) !== data
    ? Effect.fail(protocolError())
    : Effect.succeed(decoded.success);
}

function validStart(start: DownloadStart): boolean {
  return start.kind === "archive"
    ? start.sizeBytes === null && start.version === null
    : start.sizeBytes !== null &&
        Number.isSafeInteger(start.sizeBytes) &&
        start.sizeBytes >= 0 &&
        start.version !== null &&
        start.version.sizeBytes === start.sizeBytes;
}
function sameStart(a: DownloadStart, b: DownloadStart): boolean {
  return (
    a.kind === b.kind &&
    a.fileName === b.fileName &&
    a.sizeBytes === b.sizeBytes &&
    a.version?.sizeBytes === b.version?.sizeBytes &&
    a.version?.modifiedAtNs === b.version?.modifiedAtNs
  );
}

/** Sink acknowledgement is the only committed resume boundary. */
const performDownload = Effect.fn("FileTransfers.downloadFile")(function* <A>(
  input: DownloadFileInput<A>,
  expectedIdentity: FileContentIdentity | null,
): Effect.fn.Return<A, DownloadFailure, EnvironmentRegistry | EnvironmentSupervisor> {
  const run = Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const supervisor = yield* EnvironmentSupervisor;
    const initial = yield* readFileTransferSession(registry, supervisor, yield* currentSession());
    const unavailable = () =>
      new FileTransferClientError({
        reason: "unavailable",
        message: "This connection cannot transfer files securely. Update the server and reconnect.",
      });
    if (
      (expectedIdentity !== null && !sameFileContentIdentity(expectedIdentity, initial.identity)) ||
      fileContentRoute(initial.prepared, initial.config) !== "in-channel"
    )
      return yield* unavailable();
    let carrying = initial;
    let original: DownloadStart | null = null;
    let committed = 0;
    let archiveRestarts = 0;
    let resetArchive = false;
    const report = (phase: FileTransferProgress["phase"]) =>
      input.onProgress?.({
        direction: "download",
        fileName: original?.fileName ?? input.relativePath,
        sentBytes: committed,
        totalBytes: original?.sizeBytes ?? null,
        phase,
      });
    const transfer = Effect.gen(function* () {
      while (true) {
        let started = false;
        let ended = false;
        const values = runStreamInSession(
          carrying.session,
          supervisor.target.environmentId,
          WS_METHODS.projectsReadDownload,
          {
            cwd: input.cwd,
            relativePath: input.relativePath,
            ...(original?.kind === "file" && original.version !== null
              ? { offset: committed, expect: original.version }
              : {}),
          },
          { streamBufferSize: 2 },
        );
        const attempt = yield* Effect.exit(
          values.pipe(
            Stream.runForEach(
              Effect.fn("FileTransfers.acceptEvent")(function* (event) {
                if (ended) return yield* protocolError();
                switch (event._tag) {
                  case "start":
                    if (
                      started ||
                      !validStart(event) ||
                      (original !== null && !sameStart(original, event))
                    )
                      return yield* protocolError();
                    started = true;
                    if (original === null) {
                      original = event;
                      yield* input.sink.start(event);
                    } else if (resetArchive) {
                      yield* input.sink.reset(event);
                      committed = 0;
                      resetArchive = false;
                    }
                    report("transferring");
                    return;
                  case "bytes": {
                    if (!started || event.offset !== committed) return yield* protocolError();
                    const bytes = yield* decodeTransferChunk(event.data);
                    const next = committed + bytes.byteLength;
                    if (
                      !Number.isSafeInteger(next) ||
                      (original?.sizeBytes != null && next > original.sizeBytes)
                    )
                      return yield* protocolError();
                    yield* input.sink.write(committed, bytes);
                    committed = next;
                    report("transferring");
                    return;
                  }
                  case "end":
                    if (
                      !started ||
                      event.totalBytes !== committed ||
                      (original?.sizeBytes != null && event.totalBytes !== original.sizeBytes)
                    )
                      return yield* protocolError();
                    ended = true;
                }
              }),
            ),
          ),
        );
        if (Exit.isSuccess(attempt)) {
          if (!ended) return yield* protocolError();
          return;
        }
        if (!isSessionTransportLoss(attempt.cause)) return yield* Effect.failCause(attempt.cause);
        if (original?.kind === "archive") {
          if (archiveRestarts >= 1)
            return yield* new FileTransferClientError({
              reason: "unavailable",
              message: "The archive connection was lost twice. Download the archive again.",
            });
          archiveRestarts += 1;
          resetArchive = true;
        }
        report("reconnecting");
        const next = yield* nextSession(registry, carrying.supervisor, carrying.session);
        if (next._tag === "Stopped") return yield* unavailable();
        carrying = yield* readFileTransferSession(registry, next.supervisor, next.session);
        if (
          fileContentRoute(carrying.prepared, carrying.config) !== "in-channel" ||
          !sameFileContentIdentity(initial.identity, carrying.identity)
        )
          return yield* unavailable();
      }
    });
    yield* Effect.raceFirst(transfer, fileContentInvalidated(registry, initial));
    yield* assertFileContentIdentity(registry, initial);
    // All bytes and authority are committed before the sink's final publication.
    // A later environment event cannot interrupt an already admitted native rename.
    return yield* input.sink.finish();
  });
  return yield* run.pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? input.sink.abort() : Effect.void)),
  );
});

export function downloadFile<A>(input: DownloadFileInput<A>) {
  return performDownload(input, null);
}

/** Package-private admission path; authority is checked inside the same initial read attempt. */
export function downloadFileWithIdentity<A>(
  input: DownloadFileInput<A>,
  identity: FileContentIdentity,
) {
  return performDownload(input, identity);
}
