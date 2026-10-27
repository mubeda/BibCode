import {
  DIAGNOSTIC_LOGS_CHUNK_BYTES,
  DIAGNOSTIC_LOGS_MAX_ARCHIVE_BYTES,
  type DiagnosticLogsDownloadEvent,
  type DiagnosticLogsDownloadInput,
  type DiagnosticLogsManifest,
  WS_METHODS,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { currentSession } from "../rpc/client.ts";

/** Why an environment's diagnostic logs could not be downloaded. */
export type DiagnosticLogsFailureReason =
  | "not-connected"
  | "unsupported"
  | "unverified"
  | "wrong-environment"
  | "incomplete"
  | "too-large"
  | "not-permitted"
  | "crash-dumps-refused"
  | "server-failed"
  | "connection-lost";

/** A failed download. `message` names the environment and says what to do next. */
export class DiagnosticLogsDownloadError extends Data.TaggedError("DiagnosticLogsDownloadError")<{
  readonly reason: DiagnosticLogsFailureReason;
  readonly environmentLabel: string;
  readonly message: string;
}> {}

export interface DiagnosticLogsFailureContext {
  /** Whether the request asked for crash dumps, which decides what a size failure says. */
  readonly crashDumpsRequested?: boolean;
}

export interface DownloadedDiagnosticLogs {
  readonly fileName: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly manifest: DiagnosticLogsManifest;
}

const ARCHIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;

/** What a failure says, naming the environment: also the copy for a disabled download. */
export function diagnosticLogsFailureMessage(
  reason: DiagnosticLogsFailureReason,
  label: string,
  context: DiagnosticLogsFailureContext = {},
): string {
  switch (reason) {
    case "not-connected":
      return `${label} is not connected. Reconnect it to download its logs.`;
    case "unsupported":
      return `${label} runs an older BiBCode server that cannot send its logs. Update it to download them here.`;
    case "unverified":
      return `${label} did not identify its data store, so its logs cannot be checked. Update its server and try again.`;
    case "wrong-environment":
      return `The logs that arrived are not from ${label}. Nothing was saved. Try again.`;
    case "incomplete":
      return `${label} sent an incomplete archive. Nothing was saved. Try again.`;
    case "too-large":
      return context.crashDumpsRequested === true
        ? `${label}'s logs are over the 20 MiB download limit. Turn off Include crash dumps and try again.`
        : `${label}'s logs are over the 20 MiB download limit. Download them on that machine instead.`;
    case "not-permitted":
      return `This connection to ${label} cannot read its logs. Pair again with full access.`;
    case "crash-dumps-refused":
      return `This connection to ${label} cannot read crash dumps. Turn off Include crash dumps, or pair again with full access.`;
    case "server-failed":
      return `${label} could not prepare its logs. Try again.`;
    case "connection-lost":
      return `The connection to ${label} was lost. Reconnect and try again.`;
  }
}

export function diagnosticLogsError(
  reason: DiagnosticLogsFailureReason,
  environmentLabel: string,
  context: DiagnosticLogsFailureContext = {},
): DiagnosticLogsDownloadError {
  return new DiagnosticLogsDownloadError({
    reason,
    environmentLabel,
    message: diagnosticLogsFailureMessage(reason, environmentLabel, context),
  });
}

/**
 * Checks and assembles the stream's items into one archive. Every bound is checked before
 * any allocation or decoding: the archive size against the limit, each item's encoded length
 * against the item bound, and its decoded length against the bytes still expected. Accepted
 * items are decoded straight into the one output buffer.
 */
export class DiagnosticLogsAssembler {
  private started: {
    readonly fileName: string;
    readonly manifest: DiagnosticLogsManifest;
    readonly bytes: Uint8Array<ArrayBuffer>;
  } | null = null;
  private offset = 0;
  private readonly environmentLabel: string;
  /** The storage id the connection itself verified; the manifest must name the same. */
  private readonly expectedStorageInstanceId: string;
  private readonly context: DiagnosticLogsFailureContext;

  constructor(
    environmentLabel: string,
    expectedStorageInstanceId: string,
    context: DiagnosticLogsFailureContext = {},
  ) {
    this.environmentLabel = environmentLabel;
    this.expectedStorageInstanceId = expectedStorageInstanceId;
    this.context = context;
  }

  private fail(reason: DiagnosticLogsFailureReason): DiagnosticLogsDownloadError {
    return diagnosticLogsError(reason, this.environmentLabel, this.context);
  }

  accept(event: DiagnosticLogsDownloadEvent): DiagnosticLogsDownloadError | null {
    if (event._tag === "Started") {
      if (this.started !== null) return this.fail("incomplete");
      if (event.byteLength > DIAGNOSTIC_LOGS_MAX_ARCHIVE_BYTES) return this.fail("too-large");
      if (!ARCHIVE_NAME.test(event.fileName)) return this.fail("incomplete");
      if (event.manifest.storageInstanceId !== this.expectedStorageInstanceId) {
        return this.fail("wrong-environment");
      }
      this.started = {
        fileName: event.fileName,
        manifest: event.manifest,
        bytes: new Uint8Array(event.byteLength),
      };
      return null;
    }
    const started = this.started;
    if (started === null) return this.fail("incomplete");
    const data = event.data;
    if (data.length === 0 || data.length % 4 !== 0) return this.fail("incomplete");
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    // From the length alone, before anything is decoded.
    const decodedLength = (data.length / 4) * 3 - padding;
    if (
      decodedLength > DIAGNOSTIC_LOGS_CHUNK_BYTES ||
      decodedLength > started.bytes.byteLength - this.offset
    ) {
      return this.fail("incomplete");
    }
    let binary: string;
    try {
      binary = atob(data);
    } catch {
      return this.fail("incomplete");
    }
    if (binary.length !== decodedLength) return this.fail("incomplete");
    for (let index = 0; index < binary.length; index += 1) {
      started.bytes[this.offset + index] = binary.charCodeAt(index);
    }
    this.offset += binary.length;
    return null;
  }

  finish(): DownloadedDiagnosticLogs | DiagnosticLogsDownloadError {
    const started = this.started;
    if (started === null || this.offset !== started.bytes.byteLength) {
      return this.fail("incomplete");
    }
    return { fileName: started.fileName, bytes: started.bytes, manifest: started.manifest };
  }
}

type StreamFailure =
  | { readonly _tag: "DiagnosticLogsError"; readonly reason: string }
  | { readonly _tag: "EnvironmentAuthorizationError"; readonly requiredScope: string }
  | { readonly _tag: string };

function streamFailureReason(failure: StreamFailure): DiagnosticLogsFailureReason {
  switch (failure._tag) {
    case "DiagnosticLogsError":
      return "reason" in failure && failure.reason === "too-large" ? "too-large" : "server-failed";
    case "EnvironmentAuthorizationError":
      return "requiredScope" in failure && failure.requiredScope === "orchestration:operate"
        ? "crash-dumps-refused"
        : "not-permitted";
    case "UpdateMaintenanceActiveError":
      return "server-failed";
    default:
      // `RpcClientError`: the socket ended or the transport failed underneath the stream.
      return "connection-lost";
  }
}

/**
 * Anything that ended the stream other than a typed failure: an interrupt (the session
 * closed or was replaced) is a lost connection; an item that does not decode is an
 * incomplete archive; any other defect is the server's failure, never "connection lost".
 */
function streamDefectReason(cause: Cause.Cause<unknown>): DiagnosticLogsFailureReason {
  if (Cause.hasInterruptsOnly(cause)) return "connection-lost";
  return Schema.isSchemaError(Cause.squash(cause)) ? "incomplete" : "server-failed";
}

/**
 * Downloads the current environment's diagnostic bundle over its own RPC connection
 * (`server.downloadDiagnosticLogs`), never another environment's. Fails closed: the server
 * must advertise the method and identify its store, and the archive's manifest must name the
 * store this connection verified. Never sent to a server without the capability, because an
 * older server fails the whole connection on an unknown method.
 */
export const downloadDiagnosticLogs = Effect.fn("DiagnosticLogs.download")(function* (
  input: DiagnosticLogsDownloadInput,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const label = supervisor.target.label;
  const session = yield* currentSession().pipe(
    Effect.mapError(() => diagnosticLogsError("not-connected", label)),
  );
  const config = yield* session.initialConfig.pipe(
    Effect.mapError(() => diagnosticLogsError("connection-lost", label)),
  );
  if (!config.environment.capabilities.diagnosticLogs) {
    return yield* diagnosticLogsError("unsupported", label);
  }
  const expectedStorageInstanceId = config.environment.storageInstanceId;
  if (expectedStorageInstanceId === null) {
    return yield* diagnosticLogsError("unverified", label);
  }
  const context = { crashDumpsRequested: input.includeCrashDumps === true };
  const assembler = new DiagnosticLogsAssembler(label, expectedStorageInstanceId, context);
  yield* session.client[WS_METHODS.serverDownloadDiagnosticLogs](input).pipe(
    Stream.mapError((failure) => diagnosticLogsError(streamFailureReason(failure), label, context)),
    Stream.runForEach((event) => {
      const failure = assembler.accept(event);
      return failure === null ? Effect.void : Effect.fail(failure);
    }),
    Effect.catchCause((cause) => {
      const failure = Cause.squash(cause);
      return Effect.fail(
        failure instanceof DiagnosticLogsDownloadError
          ? failure
          : diagnosticLogsError(streamDefectReason(cause), label, context),
      );
    }),
  );
  const result = assembler.finish();
  if (result instanceof DiagnosticLogsDownloadError) return yield* result;
  return result;
});
