// Pure flow helpers for the Files panel's Download and Upload commands. No React, no module-level
// I/O — `useFileTransfers` owns minting the signed transfer URLs (projects.createDownloadUrl /
// projects.createUploadUrl) and reporting outcomes, while the URL math, the desktop-vs-browser
// branch, and the server's response vocabulary are decided here so they are unit testable.

import {
  FileTransferClientError,
  type DownloadSink,
  type DownloadStart,
} from "@bibcode/client-runtime/operations";
import type { DownloadResult } from "@bibcode/client-runtime/state/file-transfers";
import type { DesktopBridge } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import { transferErrorMessage } from "./transferPresentation";

export type BrowserDownloadReady = Extract<DownloadResult, { readonly blob: Blob }>;
export type DesktopDownloadSaved = Extract<DownloadResult, { readonly path: string }>;
export type StreamingDownloadBridge = Required<
  Pick<
    DesktopBridge,
    "beginDownloadFile" | "appendDownloadFile" | "finishDownloadFile" | "abortDownloadFile"
  >
>;
const BROWSER_DOWNLOAD_LIMIT = 2 * 1024 ** 3;
const BROWSER_LIMIT_MESSAGE = "This download exceeds the 2 GiB browser limit. Use the desktop app.";

/** A smaller budget permits deterministic boundary tests; it cannot raise the browser ceiling. */
export function browserDownloadSink(options?: {
  readonly maximumBytes?: number;
}): DownloadSink<BrowserDownloadReady> {
  const maximumBytes = options?.maximumBytes ?? BROWSER_DOWNLOAD_LIMIT;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > BROWSER_DOWNLOAD_LIMIT
  )
    throw new RangeError("Browser download budget must be at most 2 GiB.");
  let parts: Uint8Array<ArrayBuffer>[] = [];
  let fileName: string | null = null;
  let storedBytes = 0;
  const limit = () =>
    new FileTransferClientError({ reason: "browser_limit", message: BROWSER_LIMIT_MESSAGE });
  const begin = Effect.fn("BrowserDownloadSink.start")(function* (start: DownloadStart) {
    if (start.sizeBytes !== null && start.sizeBytes > maximumBytes) return yield* limit();
    parts = [];
    storedBytes = 0;
    fileName = start.fileName;
  });
  return {
    start: begin,
    reset: begin,
    write: Effect.fn("BrowserDownloadSink.write")(function* (_offset, bytes) {
      if (storedBytes + bytes.byteLength > maximumBytes) return yield* limit();
      // One bounded chunk copy owns a stable ArrayBuffer even if the input view is reused.
      parts.push(bytes.slice());
      storedBytes += bytes.byteLength;
    }),
    finish: Effect.fn("BrowserDownloadSink.finish")(function* () {
      if (fileName === null)
        return yield* new FileTransferClientError({
          reason: "save",
          message: "Start the download again before saving it.",
        });
      const result = { fileName, blob: new Blob(parts, { type: "application/octet-stream" }) };
      parts = [];
      storedBytes = 0;
      fileName = null;
      return result;
    }),
    abort: Effect.fn("BrowserDownloadSink.abort")(() =>
      Effect.sync(() => {
        parts = [];
        storedBytes = 0;
        fileName = null;
      }),
    ),
  };
}

export function streamingDownloadBridge(
  bridge: TransferBridge | undefined,
): StreamingDownloadBridge | null {
  if (
    bridge === undefined ||
    typeof bridge.beginDownloadFile !== "function" ||
    typeof bridge.appendDownloadFile !== "function" ||
    typeof bridge.finishDownloadFile !== "function" ||
    typeof bridge.abortDownloadFile !== "function"
  )
    return null;
  return {
    beginDownloadFile: bridge.beginDownloadFile,
    appendDownloadFile: bridge.appendDownloadFile,
    finishDownloadFile: bridge.finishDownloadFile,
    abortDownloadFile: bridge.abortDownloadFile,
  };
}

export function desktopDownloadSink(
  bridge: StreamingDownloadBridge,
  directory: string,
): DownloadSink<DesktopDownloadSaved> {
  let handle: string | null = null;
  const nativeError = (error: unknown) =>
    new FileTransferClientError({
      reason: "save",
      message: transferErrorMessage(
        error,
        "The download could not be saved. Pick another folder and try again.",
      ),
    });
  const close = Effect.fn("DesktopDownloadSink.close")(function* () {
    if (handle === null) return;
    const current = handle;
    yield* Effect.tryPromise({
      try: () => bridge.abortDownloadFile({ handle: current }),
      catch: nativeError,
    });
    if (handle === current) handle = null;
  }, Effect.uninterruptible);
  const begin = Effect.fn("DesktopDownloadSink.start")(function* (start: DownloadStart) {
    if (handle !== null)
      return yield* nativeError("Cancel the previous download before starting it again.");
    const value = yield* Effect.tryPromise({
      try: () => bridge.beginDownloadFile({ directory, fileName: start.fileName }),
      catch: nativeError,
    });
    handle = value.handle;
  }, Effect.uninterruptible);
  return {
    start: begin,
    reset: Effect.fn("DesktopDownloadSink.reset")(function* (start) {
      yield* close();
      yield* begin(start);
    }),
    write: Effect.fn("DesktopDownloadSink.write")(function* (_offset, bytes) {
      if (handle === null) return yield* nativeError("Start the download again before saving it.");
      const current = handle;
      yield* Effect.tryPromise({
        try: () => bridge.appendDownloadFile({ handle: current, bytes }),
        catch: nativeError,
      });
    }),
    finish: Effect.fn("DesktopDownloadSink.finish")(function* () {
      if (handle === null) return yield* nativeError("Start the download again before saving it.");
      const current = handle;
      const result = yield* Effect.tryPromise({
        try: () => bridge.finishDownloadFile({ handle: current }),
        catch: nativeError,
      });
      if (handle === current) handle = null;
      return result;
    }, Effect.uninterruptible),
    abort: Effect.fn("DesktopDownloadSink.abort")(function* () {
      yield* close().pipe(Effect.catch((error) => Effect.logWarning(error.message)));
    }),
  };
}

/** Save remains a user gesture; no Blob URL is allocated while the ready toast waits. */
export function saveBrowserDownload(
  value: BrowserDownloadReady,
  documentRef: Document = document,
  urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
): void {
  const url = urls.createObjectURL(value.blob);
  let anchor: HTMLAnchorElement | undefined;
  let clicked = false;
  try {
    anchor = documentRef.createElement("a");
    anchor.href = url;
    anchor.download = value.fileName;
    anchor.rel = "noopener";
    documentRef.body.appendChild(anchor);
    anchor.click();
    clicked = true;
  } finally {
    anchor?.remove();
    // Give the browser its next task to consume the clicked URL before releasing it.
    if (clicked) setTimeout(() => urls.revokeObjectURL(url), 0);
    else urls.revokeObjectURL(url);
  }
}

/**
 * The part of `window.desktopBridge` a transfer needs. Structurally a subset of `DesktopBridge`, so
 * the panel can hand the live bridge straight in; the streaming commands are optional because an
 * older desktop host (or the browser) does not implement them.
 */
export type TransferBridge = Pick<
  DesktopBridge,
  | "pickFolder"
  | "pickFiles"
  | "downloadToFolder"
  | "uploadFile"
  | "beginDownloadFile"
  | "appendDownloadFile"
  | "finishDownloadFile"
  | "abortDownloadFile"
>;

export type DownloadOutcome =
  | { _tag: "Saved"; path: string }
  | { _tag: "BrowserDownload"; url: string; fileName: string }
  | { _tag: "Cancelled" };

/**
 * On the desktop the host asks for a destination folder and streams the transfer itself, so the
 * download never silently overwrites a local file (the host uniquifies the name). Everywhere else
 * the caller hands the URL to the browser, which applies its own download location and rules.
 * Mint only after the picker settles so waiting for a destination cannot expire the token.
 */
export async function downloadWithBridge(input: {
  prepare: () => Promise<{ url: string; fileName: string } | null>;
  bridge: TransferBridge | undefined;
}): Promise<DownloadOutcome> {
  const { bridge } = input;
  if (bridge?.downloadToFolder === undefined) {
    const prepared = await input.prepare();
    return prepared === null ? { _tag: "Cancelled" } : { _tag: "BrowserDownload", ...prepared };
  }
  const directory = await bridge.pickFolder({ initialPath: null });
  if (directory === null) return { _tag: "Cancelled" };
  const prepared = await input.prepare();
  if (prepared === null) return { _tag: "Cancelled" };
  const path = await bridge.downloadToFolder({
    ...prepared,
    directory,
  });
  return { _tag: "Saved", path };
}

/** Hand a transfer URL to the browser's own downloader through a throwaway anchor. */
export function triggerBrowserDownload(
  url: string,
  fileName: string,
  documentRef: Document = document,
): void {
  const anchor = documentRef.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  documentRef.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export type UploadStep =
  | { _tag: "Uploaded"; relativePath: string }
  | { _tag: "Exists" }
  | { _tag: "TooLarge"; limit: number }
  | { _tag: "Failed"; message: string };

const TRANSFER_PATH_PREFIX = "/api/transfers/";

/**
 * Resolves a minted transfer URL against this environment's own server, or `null` if it does not
 * land there.
 *
 * The minted `relativeUrl` is data from the server, and a download or upload URL is handed
 * straight to the desktop host's `fetch` (which carries host privileges, not the WebView's) or to
 * the browser's downloader. An absolute URL, a protocol-relative `//host/...`, or a path that
 * traverses out of the transfer namespace would point that transfer somewhere else entirely, so the
 * resolved URL must share the environment's origin and stay under `/api/transfers/` — the same
 * shape `previewUrlPresentation` requires of an asset URL.
 */
export function resolveTransferUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    const url = new URL(relativeUrl, httpBaseUrl);
    const environmentUrl = new URL(httpBaseUrl);
    if (url.origin !== environmentUrl.origin) return null;
    if (!url.pathname.startsWith(TRANSFER_PATH_PREFIX)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Adds one upload's query to an already-resolved transfer URL.
 *
 * The file name is not part of the query: the token minted by `projects.createUploadUrl` names the
 * one file it authorises, so a leaked URL cannot be pointed at a different name. Only the
 * replace-after-prompt retry adds anything, and it reuses the same token.
 */
export function uploadUrlFor(transferUrl: string, overwrite: boolean): string {
  if (!overwrite) return transferUrl;
  const url = new URL(transferUrl);
  url.searchParams.set("overwrite", "1");
  return url.toString();
}

/**
 * Browser-mode upload. `credentials: "omit"` on purpose: the server answers cross-origin requests
 * with `Access-Control-Allow-Origin: *` unless a dev URL is configured, and a browser refuses a
 * credentialed request against a wildcard origin. The signed token in the URL is the authentication,
 * so no cookie or header is needed.
 */
export async function sendBrowserUpload(
  url: string,
  file: File,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: string }> {
  const response = await fetchImpl(url, { method: "POST", body: file, credentials: "omit" });
  return { status: response.status, body: await response.text() };
}

/** A byte cap as a person reads it: "1 GiB", "1.5 MiB", "900 bytes". */
export function describeByteLimit(bytes: number): string {
  const units = [
    { label: "GiB", size: 1024 ** 3 },
    { label: "MiB", size: 1024 ** 2 },
    { label: "KiB", size: 1024 },
  ] as const;
  for (const unit of units) {
    if (bytes >= unit.size) {
      const value = bytes / unit.size;
      return `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit.label}`;
    }
  }
  return `${bytes} bytes`;
}

/**
 * Translate one upload response into the next step of the flow.
 *
 * An unexpected status shows the server's own `message` when the body is the JSON error shape the
 * routes emit, and otherwise a plain sentence naming the status. The raw body is never shown: a
 * proxy's HTML error page or a JSON blob in a toast tells the reader nothing they can act on.
 */
export function interpretUploadResponse(status: number, body: string): UploadStep {
  let parsed: { _tag?: string; relativePath?: string; limit?: number; message?: string } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    parsed = {};
  }
  if (status === 201 && typeof parsed.relativePath === "string") {
    return { _tag: "Uploaded", relativePath: parsed.relativePath };
  }
  if (status === 409) return { _tag: "Exists" };
  if (status === 413) {
    return { _tag: "TooLarge", limit: typeof parsed.limit === "number" ? parsed.limit : 0 };
  }
  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
  return {
    _tag: "Failed",
    message: message.length > 0 ? message : `Upload failed with HTTP ${status}.`,
  };
}
