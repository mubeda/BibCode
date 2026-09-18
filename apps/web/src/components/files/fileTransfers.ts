// Pure flow helpers for the Files panel's Download and Upload commands. No React, no module-level
// I/O — the panel owns minting the signed transfer URLs (projects.createDownloadUrl /
// projects.createUploadUrl) and reporting outcomes, while the URL math, the desktop-vs-browser
// branch, and the server's response vocabulary are decided here so they are unit testable.

/**
 * The part of `window.desktopBridge` a transfer needs. Structurally a subset of `DesktopBridge`, so
 * the panel can hand the live bridge straight in; the streaming commands are optional because an
 * older desktop host (or the browser) does not implement them.
 */
export interface TransferBridge {
  pickFolder: (options?: { initialPath?: string | null }) => Promise<string | null>;
  pickFiles?: (options?: { title?: string }) => Promise<readonly string[]>;
  downloadToFolder?: (input: {
    url: string;
    directory: string;
    fileName: string;
  }) => Promise<string>;
  uploadFile?: (input: { url: string; path: string }) => Promise<{ status: number; body: string }>;
}

export type DownloadOutcome =
  | { _tag: "Saved"; path: string }
  | { _tag: "BrowserDownload"; url: string; fileName: string }
  | { _tag: "Cancelled" };

/**
 * On the desktop the host asks for a destination folder and streams the transfer itself, so the
 * download never silently overwrites a local file (the host uniquifies the name). Everywhere else
 * the caller hands the URL to the browser, which applies its own download location and rules.
 */
export async function downloadWithBridge(input: {
  url: string;
  fileName: string;
  bridge: TransferBridge | undefined;
}): Promise<DownloadOutcome> {
  const { bridge } = input;
  if (bridge?.downloadToFolder === undefined) {
    return { _tag: "BrowserDownload", url: input.url, fileName: input.fileName };
  }
  const directory = await bridge.pickFolder({ initialPath: null });
  if (directory === null) return { _tag: "Cancelled" };
  const path = await bridge.downloadToFolder({
    url: input.url,
    directory,
    fileName: input.fileName,
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
