import type { InlineFallbackObservation } from "./chat-inline-fallback.ts";
import { OLD_INLINE_SOURCE } from "./chat-inline-fallback.ts";
import type {
  BrowserInlineAction,
  BrowserInlineObservation,
  NativeInlineObservation,
} from "./chat-inline-mechanics.ts";
export interface OldInlineInput {
  readonly source: typeof OLD_INLINE_SOURCE;
  readonly serverVersion: "0.7.2";
  readonly binarySha256: string;
  readonly build: "immutable-source";
  readonly hermeticGuard: "unavailable-in-old-source";
  readonly contractProof: {
    readonly serveFlags: true;
    readonly pairingIssue: true;
    readonly inlineDataUrl: true;
    readonly capabilityAbsent: true;
    readonly operateScope: true;
  };
}
export function projectOldInlineInput(value: unknown): OldInlineInput | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const proof = row.contractProof;
  if (
    Object.keys(row).length !== 6 ||
    row.source !== OLD_INLINE_SOURCE ||
    row.serverVersion !== "0.7.2" ||
    row.build !== "immutable-source" ||
    row.hermeticGuard !== "unavailable-in-old-source" ||
    typeof row.binarySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.binarySha256) ||
    proof === null ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    Object.keys(proof).length !== 5 ||
    !["serveFlags", "pairingIssue", "inlineDataUrl", "capabilityAbsent", "operateScope"].every(
      (key) => Reflect.get(proof, key) === true,
    )
  )
    return null;
  return {
    source: OLD_INLINE_SOURCE,
    serverVersion: "0.7.2",
    binarySha256: row.binarySha256,
    build: "immutable-source",
    hermeticGuard: "unavailable-in-old-source",
    contractProof: {
      serveFlags: true,
      pairingIssue: true,
      inlineDataUrl: true,
      capabilityAbsent: true,
      operateScope: true,
    },
  };
}
export function projectBrowserInlineObservation(value: unknown): BrowserInlineObservation | null {
  const object = (input: unknown): Record<string, unknown> | null =>
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const row = object(value);
  const integer = (input: unknown, limit: number) =>
    Number.isSafeInteger(input) && (input as number) >= 0 && (input as number) <= limit;
  const nullable = (input: unknown, limit: number) => input === null || integer(input, limit);
  if (
    !row ||
    Object.keys(row).length !== 9 ||
    typeof row.action !== "string" ||
    !["mid-message-pong", "queued-before-close", "refused"].includes(row.action) ||
    !["failed", "closeCalled", "receivedCleanClose"].every(
      (key) => typeof row[key] === "boolean",
    ) ||
    ![0, 3145728].includes(row.sentBytes as number) ||
    !nullable(row.bufferedAfterSend, 4194304) ||
    !nullable(row.bufferedBeforeClose, 4194304) ||
    !nullable(row.receivedCloseCode, 4999) ||
    !Array.isArray(row.samples) ||
    row.samples.length > 256
  )
    return null;
  const samples: Array<{ elapsedMs: number; bufferedBytes: number }> = [];
  for (const value of row.samples) {
    const sample = object(value);
    if (
      !sample ||
      Object.keys(sample).length !== 2 ||
      !integer(sample.elapsedMs, 250000) ||
      !integer(sample.bufferedBytes, 4194304) ||
      (sample.elapsedMs as number) < (samples.at(-1)?.elapsedMs ?? 0)
    )
      return null;
    samples.push({
      elapsedMs: sample.elapsedMs as number,
      bufferedBytes: sample.bufferedBytes as number,
    });
  }
  return {
    action: row.action as BrowserInlineObservation["action"],
    failed: row.failed as boolean,
    sentBytes: row.sentBytes as number,
    bufferedAfterSend: row.bufferedAfterSend as number | null,
    bufferedBeforeClose: row.bufferedBeforeClose as number | null,
    closeCalled: row.closeCalled as boolean,
    receivedCloseCode: row.receivedCloseCode as number | null,
    receivedCleanClose: row.receivedCleanClose as boolean,
    samples,
  };
}
export interface RemainingQualificationPort {
  readonly capability: () => Promise<boolean | null>;
  readonly inline: () => Promise<InlineFallbackObservation>;
  readonly sendImage: () => Promise<void>;
  readonly receipt: () => Promise<{ count: number; matched: boolean }>;
  readonly ui: () => Promise<{
    deliveredImage: boolean;
    error: boolean;
    uploadNotice: boolean;
    composerUsable: boolean;
  }>;
  readonly captureTheme: (theme: "light" | "dark") => Promise<void>;
  readonly until: (check: () => Promise<boolean>, timeout?: number) => Promise<void>;
  readonly transport: (
    action: BrowserInlineAction,
  ) => Promise<{ browser: BrowserInlineObservation; native: NativeInlineObservation }>;
}
const requireProof = (value: boolean): void => {
  if (!value) throw new Error("Remaining qualification evidence refused.");
};
export async function runRemainingQualification(port: RemainingQualificationPort) {
  requireProof((await port.capability()) === false);
  const before = await port.inline();
  requireProof(
    before.complete &&
      before.plainSockets > 0 &&
      before.uploadRequests === 0 &&
      before.stagedReferences === 0,
  );
  await port.sendImage();
  await port.until(async () => {
    const receipt = await port.receipt();
    return receipt.count === 1 && receipt.matched;
  }, 60000);
  await port.until(async () => {
    const ui = await port.ui();
    return ui.deliveredImage && !ui.error && !ui.uploadNotice && ui.composerUsable;
  }, 30000);
  const after = await port.inline();
  requireProof(
    after.complete &&
      after.uploadRequests === 0 &&
      after.stagedReferences === 0 &&
      after.turnRequests - before.turnRequests === 1 &&
      after.inlineAttachments - before.inlineAttachments === 1 &&
      after.inlineBytes - before.inlineBytes === 10485760,
  );
  requireProof((await port.capability()) === false);
  for (const theme of ["light", "dark"] as const) await port.captureTheme(theme);
  const mid = await port.transport("mid-message-pong");
  const queued = await port.transport("queued-before-close");
  for (const observed of [mid, queued])
    requireProof(
      !observed.browser.failed &&
        observed.browser.sentBytes === 3145728 &&
        observed.browser.receivedCloseCode === 1000 &&
        observed.browser.receivedCleanClose &&
        observed.native.complete &&
        observed.native.messageFinished &&
        observed.native.messageBytes === 3145728 &&
        /^[a-f0-9]{64}$/.test(observed.native.messageDigest ?? "") &&
        observed.native.closeFrameReceived &&
        observed.native.closeAfterMessage &&
        !observed.native.partialFrame,
    );
  requireProof(
    mid.browser.action === "mid-message-pong" &&
      mid.native.nativePingWritesMidMessage === 1 &&
      mid.native.nativePongMidMessage + mid.native.nativePongAfterMessage === 1,
  );
  requireProof(
    queued.browser.action === "queued-before-close" &&
      queued.browser.closeCalled &&
      Number.isSafeInteger(queued.browser.bufferedBeforeClose) &&
      queued.browser.bufferedBeforeClose! > 0 &&
      queued.browser.bufferedBeforeClose! <= 3145728 &&
      queued.native.nativePingWritesMidMessage === 0 &&
      queued.native.nativePongMidMessage === 0 &&
      queued.native.nativePongAfterMessage === 0,
  );
  return {
    complete: true,
    fallback: {
      inlineBytes: after.inlineBytes - before.inlineBytes,
      uploadRequests: after.uploadRequests,
      carryingCapability: false,
      lightDarkCaptured: true,
    },
    browser: {
      pongPosition: mid.native.nativePongMidMessage === 1 ? "mid-message" : "after-message",
      queuedData: "received-before-close",
      measurements: [mid, queued],
    },
    webkitgtk: "not-measured",
    fullMatrixComplete: false,
  };
}
