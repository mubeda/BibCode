import type { DownloadedDiagnosticLogs } from "@bibcode/client-runtime/diagnostics";
import type { DiagnosticLogsDownloadInput, EnvironmentId } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { runPrimaryRawHttp } from "../lib/runtime";
import { downloadEnvironmentDiagnosticLogs } from "./environmentDiagnosticLogs";

export const MAX_DIAGNOSTIC_REQUEST_BYTES = 512 * 1024;
const OMITTED_RECORDS_MARKER = "[oldest frontend records omitted]\n";

export interface DiagnosticLogsRequest {
  readonly url: string;
  readonly contentType: "application/json";
  readonly body: string;
}

export interface DiagnosticLogsTransportResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly contentDisposition: string | null;
  readonly bytes: Uint8Array;
}

interface DiagnosticDownloadAnchor {
  href: string;
  download: string;
  click(): void;
  remove(): void;
}

interface DiagnosticDownloadDependencies {
  readonly execute: (request: DiagnosticLogsRequest) => Promise<DiagnosticLogsTransportResponse>;
  /** The bundle of an environment other than the primary, over its own RPC connection. */
  readonly downloadFromEnvironment: (
    environmentId: EnvironmentId,
    label: string,
    input: DiagnosticLogsDownloadInput,
  ) => Promise<DownloadedDiagnosticLogs>;
  readonly resolveUrl: (path: string) => string;
  readonly createAnchor: () => DiagnosticDownloadAnchor;
  readonly appendAnchor: (anchor: DiagnosticDownloadAnchor) => void;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly now: () => Date;
  readonly saveArchive:
    | ((filename: string, bytes: Uint8Array) => Promise<string | null>)
    | undefined;
}

export type DiagnosticLogsDownloadResult =
  | { readonly status: "saved"; readonly filename: string; readonly path: string }
  | { readonly status: "downloaded"; readonly filename: string }
  | { readonly status: "cancelled"; readonly filename: string };

export interface DiagnosticLogsOptions {
  /** Crash dumps can hold fragments of memory, so the server leaves them out unless asked. */
  readonly includeCrashDumps?: boolean;
  /**
   * An environment other than the primary, whose own server builds the bundle. Absent: the
   * primary environment, over its HTTP route as before.
   */
  readonly environment?: { readonly environmentId: EnvironmentId; readonly label: string };
}

function requestBody(frontendLog: string, options: DiagnosticLogsOptions): string {
  const encoder = new TextEncoder();
  const encode = (value: string) =>
    JSON.stringify({
      frontendLog: value,
      ...(options.includeCrashDumps === true ? { includeCrashDumps: true } : {}),
    });
  const original = encode(frontendLog);
  if (encoder.encode(original).byteLength <= MAX_DIAGNOSTIC_REQUEST_BYTES) return original;

  let lower = 0;
  let upper = frontendLog.length;
  while (lower < upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    const candidate = encode(`${OMITTED_RECORDS_MARKER}${frontendLog.slice(midpoint)}`);
    if (encoder.encode(candidate).byteLength <= MAX_DIAGNOSTIC_REQUEST_BYTES) {
      upper = midpoint;
    } else {
      lower = midpoint + 1;
    }
  }
  let start = lower;
  if (
    start > 0 &&
    /[\uD800-\uDBFF]/.test(frontendLog[start - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(frontendLog[start] ?? "")
  ) {
    start += 1;
  }
  return encode(`${OMITTED_RECORDS_MARKER}${frontendLog.slice(start)}`);
}

function timestampedFilename(now: Date): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `bibcode-diagnostics-${timestamp}.zip`;
}

function safeResponseFilename(contentDisposition: string | null, now: Date): string {
  const encoded = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = contentDisposition?.match(/filename="([^"]+)"/i)?.[1];
  const plain = contentDisposition?.match(/filename=([^;\s]+)/i)?.[1];
  let candidate = encoded ?? quoted ?? plain ?? "";
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    candidate = "";
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(candidate)) return candidate;
  return timestampedFilename(now);
}

const executeAuthenticatedRequest = async (
  input: DiagnosticLogsRequest,
): Promise<DiagnosticLogsTransportResponse> =>
  runPrimaryRawHttp(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(input.url, {
          body: HttpBody.text(input.body, input.contentType),
        }),
      );
      return {
        status: response.status,
        contentType: response.headers["content-type"] ?? null,
        contentDisposition: response.headers["content-disposition"] ?? null,
        bytes: new Uint8Array(yield* response.arrayBuffer),
      };
    }),
  );

const liveDependencies: DiagnosticDownloadDependencies = {
  execute: executeAuthenticatedRequest,
  downloadFromEnvironment: downloadEnvironmentDiagnosticLogs,
  resolveUrl: resolvePrimaryEnvironmentHttpUrl,
  createAnchor: () => document.createElement("a"),
  appendAnchor: (anchor) => document.body.append(anchor as HTMLAnchorElement),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  now: () => new Date(),
  get saveArchive() {
    return window.desktopBridge?.saveDiagnosticLogs;
  },
};

export async function downloadDiagnosticLogs(
  frontendLog: string,
  options: DiagnosticLogsOptions = {},
  dependencies: DiagnosticDownloadDependencies = liveDependencies,
): Promise<DiagnosticLogsDownloadResult> {
  const { filename, archiveBytes } =
    options.environment === undefined
      ? await downloadFromPrimary(frontendLog, options, dependencies)
      : await downloadFromEnvironment(frontendLog, options, options.environment, dependencies);
  return saveArchive(filename, archiveBytes, dependencies);
}

async function downloadFromEnvironment(
  frontendLog: string,
  options: DiagnosticLogsOptions,
  environment: { readonly environmentId: EnvironmentId; readonly label: string },
  dependencies: DiagnosticDownloadDependencies,
): Promise<{ filename: string; archiveBytes: Uint8Array<ArrayBuffer> }> {
  // The same bounded body as the HTTP route, so the remote bundle's frontend.log matches.
  const input = JSON.parse(requestBody(frontendLog, options)) as DiagnosticLogsDownloadInput;
  const archive = await dependencies.downloadFromEnvironment(
    environment.environmentId,
    environment.label,
    input,
  );
  return { filename: archive.fileName, archiveBytes: archive.bytes };
}

async function downloadFromPrimary(
  frontendLog: string,
  options: DiagnosticLogsOptions,
  dependencies: DiagnosticDownloadDependencies,
): Promise<{ filename: string; archiveBytes: Uint8Array<ArrayBuffer> }> {
  const response = await dependencies.execute({
    url: dependencies.resolveUrl("/api/diagnostics/logs.zip"),
    contentType: "application/json",
    body: requestBody(frontendLog, options),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Diagnostic logs server returned ${response.status}.`);
  }
  if (!response.contentType?.toLowerCase().startsWith("application/zip")) {
    throw new Error("Diagnostic logs server did not return a ZIP archive.");
  }

  const filename = safeResponseFilename(response.contentDisposition, dependencies.now());
  const archiveBytes = new Uint8Array(response.bytes.byteLength);
  archiveBytes.set(response.bytes);
  return { filename, archiveBytes };
}

async function saveArchive(
  filename: string,
  archiveBytes: Uint8Array<ArrayBuffer>,
  dependencies: DiagnosticDownloadDependencies,
): Promise<DiagnosticLogsDownloadResult> {
  if (dependencies.saveArchive) {
    const path = await dependencies.saveArchive(filename, archiveBytes);
    return path === null ? { status: "cancelled", filename } : { status: "saved", filename, path };
  }

  const blob = new Blob([archiveBytes.buffer], { type: "application/zip" });
  const objectUrl = dependencies.createObjectURL(blob);
  const anchor = dependencies.createAnchor();
  try {
    anchor.href = objectUrl;
    anchor.download = filename;
    dependencies.appendAnchor(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    dependencies.revokeObjectURL(objectUrl);
  }
  return { status: "downloaded", filename };
}
