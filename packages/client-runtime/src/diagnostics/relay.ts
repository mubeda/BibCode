import {
  DIAGNOSTIC_LOGS_CHUNK_BYTES,
  type DiagnosticLogsRelayEnvironment,
  type DiagnosticLogsRelayEvent,
  type DiagnosticLogsRelayFailureReason,
  type DiagnosticLogsRelayItem,
  WS_METHODS,
} from "@bibcode/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { currentSession } from "../rpc/client.ts";
import { DiagnosticLogsDownloadError, type DownloadedDiagnosticLogs } from "./logs.ts";

/**
 * The desktop app's side of `bibcode diagnostics download` (#201). The command on this host
 * asks the primary server; the server announces it here, the user approves it, the app
 * downloads the named environment's bundle over that environment's own connection (with
 * every check of {@link downloadDiagnosticLogs}) and sends it back through the primary.
 */

/** Why the primary refused a relay call: the request is over, or its command left. */
export class DiagnosticLogsRelaySendError extends Data.TaggedError("DiagnosticLogsRelaySendError")<{
  readonly reason: "stale" | "cancelled" | "invalid" | "not-desktop" | "connection-lost";
}> {}

function sendErrorReason(failure: unknown): DiagnosticLogsRelaySendError["reason"] {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "DiagnosticLogsRelayError" &&
    "reason" in failure &&
    (failure.reason === "stale" ||
      failure.reason === "cancelled" ||
      failure.reason === "invalid" ||
      failure.reason === "not-desktop")
  ) {
    return failure.reason;
  }
  return "connection-lost";
}

const relaySendError = (failure: unknown) =>
  new DiagnosticLogsRelaySendError({ reason: sendErrorReason(failure) });

/**
 * Calls `onEvent` for every relay event the primary announces to this session, until
 * interrupted. Only the desktop app's own session may subscribe.
 */
export const watchDiagnosticLogsRelay = Effect.fn("DiagnosticLogsRelay.watch")(function* (
  onEvent: (event: DiagnosticLogsRelayEvent) => void,
) {
  const session = yield* currentSession().pipe(
    Effect.mapError(() => new DiagnosticLogsRelaySendError({ reason: "connection-lost" })),
  );
  yield* session.client[WS_METHODS.serverSubscribeDiagnosticLogsRelay]({}).pipe(
    Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
    Effect.mapError(relaySendError),
  );
});

/** Takes a waiting request for this connection; `false` when another window took it first. */
export const claimDiagnosticLogsRelay = Effect.fn("DiagnosticLogsRelay.claim")(function* (
  requestId: string,
) {
  const session = yield* currentSession().pipe(
    Effect.mapError(() => new DiagnosticLogsRelaySendError({ reason: "connection-lost" })),
  );
  const result = yield* session.client[WS_METHODS.serverClaimDiagnosticLogsRelay]({
    requestId,
  }).pipe(Effect.mapError(relaySendError));
  return result.claimed;
});

/** Sends one item of a claimed request; it answers once the command took the one before. */
export const sendDiagnosticLogsRelayItem = Effect.fn("DiagnosticLogsRelay.send")(function* (
  requestId: string,
  item: DiagnosticLogsRelayItem,
) {
  const session = yield* currentSession().pipe(
    Effect.mapError(() => new DiagnosticLogsRelaySendError({ reason: "connection-lost" })),
  );
  yield* session.client[WS_METHODS.serverSendDiagnosticLogsRelayItem]({ requestId, item }).pipe(
    Effect.mapError(relaySendError),
  );
});

/** An environment the app can reach, as the relay resolves a command's selector against. */
export interface RelayEnvironmentCandidate {
  readonly environmentId: string;
  readonly label: string;
  readonly connected: boolean;
}

export type RelayEnvironmentResolution =
  | { readonly kind: "found"; readonly environment: RelayEnvironmentCandidate }
  | {
      readonly kind: "unknown-environment" | "ambiguous-environment" | "not-connected";
      readonly message: string;
      readonly environments: ReadonlyArray<DiagnosticLogsRelayEnvironment>;
    };

/**
 * Resolves the command's `environment`: an exact id first, then a label (trimmed, ignoring
 * case) that exactly one environment has. Anything else fails with the reachable list, so
 * the command can say which names to use.
 */
export function resolveRelayEnvironment(
  selector: string,
  candidates: ReadonlyArray<RelayEnvironmentCandidate>,
): RelayEnvironmentResolution {
  const listed = candidates.map(({ environmentId, label, connected }) => ({
    environmentId,
    label,
    connected,
  }));
  const wanted = selector.trim();
  const byId = candidates.find((candidate) => candidate.environmentId === wanted);
  const byLabel = candidates.filter(
    (candidate) => candidate.label.trim().toLowerCase() === wanted.toLowerCase(),
  );
  const match = byId ?? (byLabel.length === 1 ? byLabel[0] : undefined);
  if (match === undefined) {
    return byLabel.length > 1
      ? {
          kind: "ambiguous-environment",
          message: `Several environments in BiBCode are named ${wanted}. Pass its id with --environment.`,
          environments: listed,
        }
      : {
          kind: "unknown-environment",
          message: `BiBCode has no environment named ${wanted}.`,
          environments: listed,
        };
  }
  if (!match.connected) {
    return {
      kind: "not-connected",
      message: `${match.label.trim() || match.environmentId} is not connected in BiBCode. Reconnect it, then try again.`,
      environments: listed,
    };
  }
  return { kind: "found", environment: match };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The relay items for a verified archive: `Started`, its `Data` items, then `Finished`. */
export function* relayItemsForArchive(
  archive: DownloadedDiagnosticLogs,
): Generator<DiagnosticLogsRelayItem> {
  yield {
    _tag: "Started",
    fileName: archive.fileName,
    byteLength: archive.bytes.byteLength,
    manifest: archive.manifest,
  };
  for (let offset = 0; offset < archive.bytes.byteLength; offset += DIAGNOSTIC_LOGS_CHUNK_BYTES) {
    yield {
      _tag: "Data",
      data: base64(archive.bytes.subarray(offset, offset + DIAGNOSTIC_LOGS_CHUNK_BYTES)),
    };
  }
  yield { _tag: "Finished" };
}

/** The `Failed` item for a download that failed, with the copy Settings shows for it. */
export function relayFailureItem(error: unknown, label: string): DiagnosticLogsRelayItem {
  if (error instanceof DiagnosticLogsDownloadError) {
    return {
      _tag: "Failed",
      reason: error.reason satisfies DiagnosticLogsRelayFailureReason,
      message: error.message,
    };
  }
  return {
    _tag: "Failed",
    reason: "connection-lost",
    message: `The connection to ${label} was lost. Reconnect and try again.`,
  };
}
