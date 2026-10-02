import type {
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@bibcode/contracts";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@bibcode/client-runtime/state/runtime";
import {
  FILE_PREVIEW_UNCERTAIN_MESSAGE,
  FilePreviewUncertainError,
  type FileDownloadAvailability,
} from "@bibcode/client-runtime/operations";
import type { HttpFilePreviewCommandResult } from "@bibcode/client-runtime/state/preview";
import type { AtomCommandRunOptions } from "@bibcode/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  rememberPreviewUrl,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export const ENCRYPTED_FILE_PREVIEW_REASON =
  "Preview isn't available over encrypted connections yet. Download this file to open it.";
export type FilePreviewAvailability =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: string };

/** File capability previews are legacy HTTP; renderer images use leased asset URLs. */
export function filePreviewAvailability(
  availability: Pick<FileDownloadAvailability, "route" | "connected"> | null,
  _filePath: string,
): FilePreviewAvailability {
  if (availability === null || !availability.connected)
    return {
      enabled: false,
      reason: "Reconnect to this environment before opening its file preview.",
    };
  return availability.route === "http"
    ? { enabled: true }
    : { enabled: false, reason: ENCRYPTED_FILE_PREVIEW_REASON };
}

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, url: input.url },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    rememberPreviewUrl(input.threadRef, input.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

export function filePreviewFailureTitle(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "FilePreviewUncertainError"
    ? "Preview could not be confirmed"
    : "Unable to open file in browser";
}

export type OpenFilePreviewMutation<E = unknown> = (
  target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ScopedThreadRef["threadId"]; readonly filePath: string };
  },
  options?: AtomCommandRunOptions,
) => Promise<AtomCommandResult<HttpFilePreviewCommandResult, E>>;

export async function openFileInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly availability: FilePreviewAvailability;
  readonly openFile: OpenFilePreviewMutation<E>;
  readonly signal?: AbortSignal;
  readonly isCurrent: () => boolean;
}): Promise<
  AtomCommandResult<void, E | BrowserPreviewUnavailableError | FilePreviewUncertainError>
> {
  const interrupted = () =>
    AsyncResult.failure<void, E | BrowserPreviewUnavailableError | FilePreviewUncertainError>(
      Cause.interrupt(),
    );
  const current = () => !input.signal?.aborted && input.isCurrent();
  if (!current()) return interrupted();
  if (!isPreviewSupportedInRuntime()) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  if (!input.availability.enabled) {
    return AsyncResult.failure(
      Cause.fail(new BrowserPreviewUnavailableError({ message: input.availability.reason })),
    );
  }
  const result = await input.openFile(
    {
      environmentId: input.threadRef.environmentId,
      input: { threadId: input.threadRef.threadId, filePath: input.filePath },
    },
    { signal: input.signal },
  );
  // An admitted Opened event may already have a native effect. This fences only manual UI
  // publication; it does not roll back or retry the server operation.
  if (!current()) return interrupted();
  if (result._tag === "Failure") return AsyncResult.failure(result.cause);
  const publishable = () =>
    typeof result.value.isCurrentContext === "function" && result.value.isCurrentContext();
  const uncertain = () =>
    AsyncResult.failure<void, E | BrowserPreviewUnavailableError | FilePreviewUncertainError>(
      Cause.fail(
        new FilePreviewUncertainError({
          message: FILE_PREVIEW_UNCERTAIN_MESSAGE,
        }),
      ),
    );
  if (!publishable()) return uncertain();
  const { url, snapshot } = result.value;
  applyPreviewServerSnapshot(input.threadRef, snapshot);
  if (!current()) return interrupted();
  if (!publishable()) return uncertain();
  rememberPreviewUrl(input.threadRef, url);
  if (!current()) return interrupted();
  if (!publishable()) return uncertain();
  useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  return AsyncResult.success(undefined);
}
