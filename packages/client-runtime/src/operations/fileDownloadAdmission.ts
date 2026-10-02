import { type EnvironmentId, ProjectReadDownloadInput, WS_METHODS } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  currentSession,
  requestInSession,
  type EnvironmentRpcFailure,
  type EnvironmentRpcUnavailableError,
} from "../rpc/client.ts";
import { fileContentRoute, type FileContentRoute } from "./fileContentRoute.ts";
import {
  readFileTransferSession,
  sameFileContentIdentity,
  type FileContentIdentity,
} from "./fileTransferSession.ts";
import {
  downloadFileWithIdentity,
  FileTransferClientError,
  type DownloadSink,
  type FileTransferProgress,
} from "./fileTransfers.ts";

const AdmissionBrand = Symbol("FileDownloadAdmission");
const decodeDownloadInput = Schema.decodeEffect(ProjectReadDownloadInput);
export interface FileDownloadAdmission {
  readonly [AdmissionBrand]: true;
  readonly operationId: number;
  readonly route: FileContentRoute;
  readonly serverName: string;
}
export interface GuardedHttpDownload {
  readonly httpBaseUrl: string;
  readonly url: string;
  readonly fileName: string;
}
export interface FileDownloadAvailability {
  readonly route: FileContentRoute;
  readonly serverName: string;
  readonly connected: boolean;
}
export type HttpDownloadFailure =
  | EnvironmentRpcFailure<typeof WS_METHODS.projectsCreateDownloadUrl>
  | FileTransferClientError
  | EnvironmentRpcUnavailableError;

/** Kept in the runtime's invocation, never on the public token or in persisted state. */
export interface CapturedFileDownload {
  readonly environmentId: EnvironmentId;
  readonly identity: FileContentIdentity;
  readonly cwd: string;
  readonly relativePath: string;
  readonly serverName: string;
  readonly route: "http" | "in-channel";
}
const changed = () =>
  new FileTransferClientError({
    reason: "unavailable",
    message: "This download's connection changed. Choose the file again from the intended server.",
  });

export const captureFileDownload = Effect.fn("FileDownloads.capture")(function* (input: {
  readonly cwd: string;
  readonly relativePath: string;
}) {
  const paths = yield* decodeDownloadInput(input).pipe(
    Effect.mapError(
      () =>
        new FileTransferClientError({
          reason: "protocol",
          message: "Choose a file or folder in a workspace before downloading.",
        }),
    ),
  );
  const registry = yield* EnvironmentRegistry;
  const supervisor = yield* EnvironmentSupervisor;
  const current = yield* readFileTransferSession(registry, supervisor, yield* currentSession());
  const route = fileContentRoute(current.prepared, current.config);
  if (route === "unavailable")
    return yield* new FileTransferClientError({
      reason: "unavailable",
      message:
        "Update this server and reconnect to download files through its encrypted connection.",
    });
  return Object.freeze({
    environmentId: supervisor.target.environmentId,
    identity: Object.freeze({ ...current.identity }),
    cwd: paths.cwd,
    relativePath: paths.relativePath,
    route,
    serverName: supervisor.target.label,
  }) satisfies CapturedFileDownload;
});

export function createFileDownloadAdmission(
  operationId: number,
  captured: CapturedFileDownload,
): FileDownloadAdmission {
  const token: FileDownloadAdmission = {
    [AdmissionBrand]: true,
    operationId,
    route: captured.route,
    serverName: captured.serverName,
  };
  Object.defineProperty(token, AdmissionBrand, { enumerable: false });
  return Object.freeze(token);
}

const currentCapturedSession = Effect.fn("FileDownloads.currentCapturedSession")(function* (
  captured: CapturedFileDownload,
) {
  const registry = yield* EnvironmentRegistry;
  const supervisor = yield* EnvironmentSupervisor;
  if (supervisor.target.environmentId !== captured.environmentId) return yield* changed();
  const session = yield* currentSession();
  const current = yield* readFileTransferSession(registry, supervisor, session);
  if (
    !sameFileContentIdentity(captured.identity, current.identity) ||
    fileContentRoute(current.prepared, current.config) !== captured.route
  )
    return yield* changed();
  return current;
});

export const downloadCapturedFile = Effect.fn("FileDownloads.downloadCaptured")(function* <A>(
  captured: CapturedFileDownload,
  sink: DownloadSink<A>,
  onProgress: (progress: FileTransferProgress) => void,
) {
  const supervisor = yield* EnvironmentSupervisor;
  if (captured.route !== "in-channel" || captured.environmentId !== supervisor.target.environmentId)
    return yield* changed();
  return yield* downloadFileWithIdentity(
    { cwd: captured.cwd, relativePath: captured.relativePath, sink, onProgress },
    captured.identity,
  );
});

export const mintCapturedHttpDownload = Effect.fn("FileDownloads.mintHttp")(function* (
  captured: CapturedFileDownload,
) {
  if (captured.route !== "http") return yield* changed();
  const current = yield* currentCapturedSession(captured);
  const result = yield* requestInSession(
    current.session,
    captured.environmentId,
    WS_METHODS.projectsCreateDownloadUrl,
    { cwd: captured.cwd, relativePath: captured.relativePath },
  );
  const registry = yield* EnvironmentRegistry;
  const after = yield* readFileTransferSession(registry, current.supervisor, current.session);
  if (
    !sameFileContentIdentity(captured.identity, after.identity) ||
    fileContentRoute(after.prepared, after.config) !== "http"
  )
    return yield* changed();
  const url = yield* Effect.try({
    try: () => {
      const base = new URL(after.prepared.httpBaseUrl);
      const resolved = new URL(result.relativeUrl, base);
      if (
        resolved.origin !== base.origin ||
        !["http:", "https:"].includes(resolved.protocol) ||
        !resolved.pathname.startsWith("/api/transfers/")
      )
        throw new Error("Unexpected download address");
      return resolved.toString();
    },
    catch: () =>
      new FileTransferClientError({
        reason: "protocol",
        message: "The server returned an invalid download address.",
      }),
  });
  return {
    httpBaseUrl: after.prepared.httpBaseUrl,
    url,
    fileName: result.fileName,
  } satisfies GuardedHttpDownload;
});

export const readFileDownloadAvailability = Effect.fn("FileDownloads.availability")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const registry = yield* EnvironmentRegistry;
  return yield* currentSession().pipe(
    Effect.flatMap((session) => readFileTransferSession(registry, supervisor, session)),
    Effect.map(
      (current) =>
        ({
          route: fileContentRoute(current.prepared, current.config),
          serverName: supervisor.target.label,
          connected: true,
        }) satisfies FileDownloadAvailability,
    ),
    Effect.catch(() =>
      Effect.succeed({
        route: "unavailable",
        serverName: supervisor.target.label,
        connected: false,
      } satisfies FileDownloadAvailability),
    ),
  );
});
