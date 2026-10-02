// @effect-diagnostics nodeBuiltinImport:off - This CI fixture owns one loopback HTTP request.
// @effect-diagnostics globalTimers:off - Every admission, hold and cleanup phase is bounded.
import * as NodeHttp from "node:http";
import { assertRemoteInstallPort } from "../seeded-desktop-upgrade-smoke.ts";

export interface HeldWorkspaceUploadReceipt {
  readonly status: 201;
  readonly bytesSent: 2;
  readonly requestClosed: true;
}
export interface HeldWorkspaceUpload {
  /** Resolves or rejects only after the owned request closes, or reports a close timeout. */
  readonly completion: Promise<HeldWorkspaceUploadReceipt>;
  /** Completes the harmless two-byte body once; repeat calls join the same completion. */
  readonly finish: () => Promise<HeldWorkspaceUploadReceipt>;
  /** Joins local request cleanup; this does not prove remote partial-file cleanup. */
  readonly abort: () => Promise<void>;
}
export interface HeldWorkspaceUploadInput {
  readonly endpoint: string;
  readonly relativeUrl: string;
  readonly relativePath: string;
  readonly limits?: Partial<{
    admissionMs: number;
    holdMs: number;
    completionMs: number;
    closeMs: number;
  }>;
}
const DEFAULT_LIMITS = { admissionMs: 5_000, holdMs: 20_000, completionMs: 5_000, closeMs: 1_000 };
const MAX_RESPONSE_BYTES = 4_096;
const MESSAGES = {
  "invalid-target": "The held upload fixture target or bounds are invalid.",
  "admission-refused": "The held upload was refused before body admission.",
  "admission-timeout": "The held upload did not receive body admission in time.",
  "hold-timeout": "The held upload exceeded its observation window.",
  "completion-timeout": "The held upload did not finish in time.",
  "close-timeout": "The held upload request did not confirm cleanup in time.",
  "invalid-response": "The held upload returned an invalid completion receipt.",
  transport: "The held upload connection failed.",
  aborted: "The held upload fixture was aborted.",
} as const;
type FailureReason = keyof typeof MESSAGES;

/** Closed messages only: a Node HTTP error/cause can contain the signed capability. */
export class HeldWorkspaceUploadError extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason) {
    super(MESSAGES[reason]);
    this.name = "HeldWorkspaceUploadError";
    this.reason = reason;
  }
}

/**
 * Test-only ordinary HTTP upload. A real 100 Continue precedes publication of this handle.
 * The hold watchdog sends the final byte but retains its failure for the qualification owner.
 * Once install is dispatched that owner must release this body AND join its coordinator;
 * rejecting completion is not cancellation of the already-admitted update.
 */
export async function beginHeldWorkspaceUpload(
  input: HeldWorkspaceUploadInput,
): Promise<HeldWorkspaceUpload> {
  let target: URL;
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  try {
    const endpoint = new URL(input.endpoint);
    assertRemoteInstallPort(Number(endpoint.port));
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.search !== "" ||
      endpoint.hash !== "" ||
      endpoint.pathname !== "/" ||
      !/^\/api\/transfers\/[A-Za-z0-9._~-]+$/.test(input.relativeUrl) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(input.relativePath)
    ) {
      throw new HeldWorkspaceUploadError("invalid-target");
    }
    target = new URL(input.relativeUrl, endpoint);
    if (target.origin !== endpoint.origin || target.pathname !== input.relativeUrl)
      throw new HeldWorkspaceUploadError("invalid-target");
    for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof typeof DEFAULT_LIMITS>) {
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] <= 0 ||
        limits[key] > DEFAULT_LIMITS[key]
      ) {
        throw new HeldWorkspaceUploadError("invalid-target");
      }
    }
  } catch {
    throw new HeldWorkspaceUploadError("invalid-target");
  }

  const admission = Promise.withResolvers<HeldWorkspaceUpload>();
  const completion = Promise.withResolvers<HeldWorkspaceUploadReceipt>();
  // The held operation may fail before the caller begins joining it. Retain the original
  // rejecting promise while marking it handled during that ownership interval.
  void completion.promise.catch(() => undefined);
  let phase: "admitting" | "held" | "finishing" | "closing" | "closed" = "admitting";
  let failure: FailureReason | null = null;
  let validResponse = false;
  let response: NodeHttp.IncomingMessage | undefined;
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let request: NodeHttp.ClientRequest;
  const clearTimers = () => {
    clearTimeout(admissionTimer);
    clearTimeout(holdTimer);
    clearTimeout(completionTimer);
    clearTimeout(closeTimer);
  };
  const settled = (closeConfirmed: boolean) => {
    if (phase === "closed") return;
    phase = "closed";
    clearTimers();
    if (!closeConfirmed) failure = "close-timeout";
    else if (!validResponse && failure === null) failure = "transport";
    if (failure === null) completion.resolve({ status: 201, bytesSent: 2, requestClosed: true });
    else {
      const error = new HeldWorkspaceUploadError(failure);
      admission.reject(error);
      completion.reject(error);
    }
  };
  const stop = (reason: FailureReason) => {
    if (phase === "closed") return;
    failure ??= reason;
    if (phase === "closing") return;
    phase = "closing";
    clearTimers();
    closeTimer = setTimeout(() => settled(false), limits.closeMs);
    response?.destroy();
    request.destroy();
  };
  const finish = (): Promise<HeldWorkspaceUploadReceipt> => {
    if (phase === "held") {
      phase = "finishing";
      clearTimeout(holdTimer);
      completionTimer = setTimeout(() => stop("completion-timeout"), limits.completionMs);
      try {
        request.end(Buffer.from("k"));
      } catch {
        stop("transport");
      }
    }
    return completion.promise;
  };
  const handle: HeldWorkspaceUpload = {
    completion: completion.promise,
    finish,
    abort: async () => {
      if (phase !== "closed") stop("aborted");
      try {
        await completion.promise;
      } catch (error) {
        if (error instanceof HeldWorkspaceUploadError && error.reason === "close-timeout")
          throw error;
      }
    },
  };

  try {
    request = NodeHttp.request(target, {
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "2",
        expect: "100-continue",
        connection: "close",
      },
    });
  } catch {
    throw new HeldWorkspaceUploadError("transport");
  }
  request.once("close", () => settled(true));
  request.once("error", () => stop("transport"));
  request.once("continue", () => {
    if (phase !== "admitting") return;
    clearTimeout(admissionTimer);
    phase = "held";
    holdTimer = setTimeout(() => {
      failure ??= "hold-timeout";
      void finish();
    }, limits.holdMs);
    try {
      request.write(Buffer.from("o"));
      admission.resolve(handle);
    } catch {
      stop("transport");
    }
  });
  request.once("response", (incoming) => {
    response = incoming;
    if (phase !== "finishing") {
      stop(phase === "admitting" ? "admission-refused" : "invalid-response");
      return;
    }
    if (incoming.statusCode !== 201) {
      stop("invalid-response");
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    incoming.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        stop("invalid-response");
        return;
      }
      chunks.push(chunk);
    });
    incoming.once("error", () => stop("transport"));
    incoming.once("end", () => {
      try {
        const receipt: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !incoming.complete ||
          typeof receipt !== "object" ||
          receipt === null ||
          !("relativePath" in receipt) ||
          receipt.relativePath !== input.relativePath
        ) {
          stop("invalid-response");
          return;
        }
        validResponse = true;
      } catch {
        stop("invalid-response");
      }
    });
  });
  admissionTimer = setTimeout(() => stop("admission-timeout"), limits.admissionMs);
  try {
    request.flushHeaders();
  } catch {
    stop("transport");
  }
  return admission.promise;
}
