import {
  AssetCreateUrlInput,
  PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ThreadId,
  WS_METHODS,
} from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  currentSession,
  EnvironmentRpcUnavailableError,
  requestInSession,
  type EnvironmentRpcFailure,
} from "../rpc/client.ts";
import {
  readFileTransferSession,
  sameFileContentIdentity,
  type FileContentIdentity,
  type FileTransferSession,
} from "./fileTransferSession.ts";

export interface HttpFilePreviewInput {
  readonly threadId: ThreadId;
  readonly filePath: string;
}
export interface HttpFilePreviewResult {
  readonly url: string;
  readonly snapshot: PreviewSessionSnapshot;
}
export class FilePreviewUncertainError extends Schema.TaggedError<FilePreviewUncertainError>()(
  "FilePreviewUncertainError",
  { message: Schema.String },
) {}
export const FILE_PREVIEW_UNCERTAIN_MESSAGE =
  "The preview may already have opened. Check Preview before trying again.";
export type HttpFilePreviewFailure =
  | EnvironmentRpcFailure<typeof WS_METHODS.assetsCreateUrl>
  | EnvironmentRpcFailure<typeof WS_METHODS.previewOpen>
  | EnvironmentRpcUnavailableError
  | FilePreviewUncertainError;

const decodeAssetInput = Schema.decodeEffect(AssetCreateUrlInput);
const decodeOpenInput = Schema.decodeEffect(PreviewOpenInput);
const uncertain = () =>
  new FilePreviewUncertainError({
    message: FILE_PREVIEW_UNCERTAIN_MESSAGE,
  });
const unavailable = (environmentId: string, message: string) =>
  new EnvironmentRpcUnavailableError({ environmentId, message });

const recheck = Effect.fn("FilePreview.recheck")(function* (
  registry: EnvironmentRegistry["Service"],
  initial: FileTransferSession,
) {
  const current = yield* readFileTransferSession(registry, initial.supervisor, initial.session);
  if (
    current.prepared.e2ee !== null ||
    !sameFileContentIdentity(initial.identity, current.identity)
  )
    return yield* unavailable(
      initial.prepared.environmentId,
      "This file's connection changed. Choose the file again from the intended server.",
    );
  return current;
});

const readUnpinnedSession = Effect.fn("FilePreview.readUnpinnedSession")(function* () {
  const registry = yield* EnvironmentRegistry;
  const supervisor = yield* EnvironmentSupervisor;
  const current = yield* readFileTransferSession(registry, supervisor, yield* currentSession());
  if (current.prepared.e2ee !== null)
    return yield* unavailable(
      supervisor.target.environmentId,
      "Preview isn't available over encrypted connections yet. Download this file to open it.",
    );
  return current;
});

/** Package-private call-entry witness, never exported through the operations package surface. */
export const captureHttpFilePreviewAuthority = Effect.fn("FilePreview.captureAuthority")(
  function* () {
    return Object.freeze({ ...(yield* readUnpinnedSession()).identity });
  },
);

const performHttpFilePreview = Effect.fn("FilePreview.openHttpFile")(function* (
  input: HttpFilePreviewInput,
  expected: FileContentIdentity | null,
): Effect.fn.Return<
  HttpFilePreviewResult,
  HttpFilePreviewFailure,
  EnvironmentRegistry | EnvironmentSupervisor
> {
  const registry = yield* EnvironmentRegistry;
  const supervisor = yield* EnvironmentSupervisor;
  const environmentId = supervisor.target.environmentId;
  const initial = yield* readUnpinnedSession();
  if (expected !== null && !sameFileContentIdentity(expected, initial.identity))
    return yield* unavailable(
      environmentId,
      "This file's connection changed. Choose the file again from the intended server.",
    );
  const assetInput = yield* decodeAssetInput({
    resource: { _tag: "workspace-file", threadId: input.threadId, path: input.filePath },
  }).pipe(
    Effect.mapError(() =>
      unavailable(environmentId, "Choose a workspace file before opening its preview."),
    ),
  );
  const minted = yield* requestInSession(
    initial.session,
    environmentId,
    WS_METHODS.assetsCreateUrl,
    assetInput,
  );
  const current = yield* recheck(registry, initial);
  const url = yield* Effect.try({
    try: () => {
      const base = new URL(current.prepared.httpBaseUrl);
      const resolved = new URL(minted.relativeUrl, base);
      if (
        !["http:", "https:"].includes(resolved.protocol) ||
        resolved.origin !== base.origin ||
        !resolved.pathname.startsWith("/api/assets/")
      )
        throw new Error("Invalid asset address");
      return resolved.toString();
    },
    catch: () =>
      unavailable(
        environmentId,
        "The server returned an invalid preview address. Try opening the file again.",
      ),
  });
  const openInput = yield* decodeOpenInput({ threadId: input.threadId, url }).pipe(
    Effect.mapError(() =>
      unavailable(
        environmentId,
        "The server returned an invalid preview address. Try opening the file again.",
      ),
    ),
  );
  yield* recheck(registry, initial);
  // Opened events/native loading can precede this reply. Never retry or close automatically.
  const snapshot = yield* requestInSession(
    initial.session,
    environmentId,
    WS_METHODS.previewOpen,
    openInput,
  ).pipe(Effect.catchTag("RpcClientError", () => Effect.fail(uncertain())));
  yield* recheck(registry, initial).pipe(Effect.mapError(uncertain));
  return { url, snapshot };
});

/** One non-idempotent open, bound to the same unpinned session as its capability mint. */
export const openHttpFilePreview = (input: HttpFilePreviewInput) =>
  performHttpFilePreview(input, null);

/** Package-private queued admission with the original call-entry authority. */
export const openCapturedHttpFilePreview = (
  input: HttpFilePreviewInput,
  authority: FileContentIdentity,
) => performHttpFilePreview(input, authority);
