import type { InlineFallbackObservation } from "./chat-inline-fallback.ts";
import { OLD_INLINE_SOURCE } from "./chat-inline-fallback.ts";
import type {
  BrowserInlineAction,
  BrowserInlineObservation,
  BrowserInlineProgress,
  NativeInlineObservation,
} from "./chat-inline-mechanics.ts";
import type { ProxyMeasurements } from "../../../../scripts/throttle-proxy.ts";
import type { startInlineProbeReceiver } from "./chat-inline-receiver.ts";
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
export function projectBrowserInlineProgress(value: unknown): BrowserInlineProgress | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const names = [
      "action",
      "finished",
      "failed",
      "timedOut",
      "readyState",
      "sentBytes",
      "bufferedBytes",
      "closeCalled",
      "receivedCloseCode",
      "receivedCleanClose",
      "sampleCount",
    ];
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== names.length ||
      !keys.every((key) => typeof key === "string" && names.includes(key))
    )
      return null;
    const row = Object.create(null) as Record<string, unknown>;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      row[name] = descriptor.value;
    }
    const integer = (input: unknown, limit: number) =>
      Number.isSafeInteger(input) && (input as number) >= 0 && (input as number) <= limit;
    if (
      !["mid-message-pong", "queued-before-close", "refused"].includes(row.action as string) ||
      !["unavailable", "connecting", "open", "closing", "closed"].includes(
        row.readyState as string,
      ) ||
      !["finished", "failed", "timedOut", "closeCalled", "receivedCleanClose"].every(
        (key) => typeof row[key] === "boolean",
      ) ||
      ![0, 3145728].includes(row.sentBytes as number) ||
      !(row.bufferedBytes === null || integer(row.bufferedBytes, 4194304)) ||
      !(row.receivedCloseCode === null || integer(row.receivedCloseCode, 4999)) ||
      !integer(row.sampleCount, 256)
    )
      return null;
    return {
      action: row.action as BrowserInlineProgress["action"],
      finished: row.finished as boolean,
      failed: row.failed as boolean,
      timedOut: row.timedOut as boolean,
      readyState: row.readyState as BrowserInlineProgress["readyState"],
      sentBytes: row.sentBytes as number,
      bufferedBytes: row.bufferedBytes as number | null,
      closeCalled: row.closeCalled as boolean,
      receivedCloseCode: row.receivedCloseCode as number | null,
      receivedCleanClose: row.receivedCleanClose as boolean,
      sampleCount: row.sampleCount as number,
    };
  } catch {
    // Foreign reflection failures remain refused diagnostics, never probe failures.
    return null;
  }
}
type InlineReceiverRead = ReturnType<Awaited<ReturnType<typeof startInlineProbeReceiver>>["read"]>;
type InlineProbeStage =
  | "start"
  | "browser-result"
  | "receiver-close"
  | "cleanup"
  | "native-proof"
  | "complete";
function inlineProbeSnapshot(
  action: BrowserInlineAction,
  stage: InlineProbeStage,
  outcome: "running" | "failed" | "complete",
  browser: BrowserInlineProgress | null,
  browserProgressState: "not-observed" | "observed" | "refused",
  browserResultReceived: boolean,
  ownedCleanupJoined: boolean,
  native: InlineReceiverRead,
  proxy: ProxyMeasurements,
) {
  const direction = (row: ProxyMeasurements["up"]) => ({
    complete: row.complete,
    overflow: row.overflow,
    receivedBytes: row.receivedBytes,
    destinationAcceptedBytes: row.destinationAcceptedBytes,
    queuedBytes: row.queuedBytes,
    discardedBytes: row.discardedBytes,
    backpressureEvents: row.backpressureEvents,
    drainEvents: row.drainEvents,
    abandonedDrainWaits: row.abandonedDrainWaits,
  });
  return {
    action,
    stage,
    outcome,
    browser,
    browserProgressState,
    browserResultReceived,
    ownedCleanupJoined,
    native: {
      parserValid: native.complete,
      upgraded: native.upgraded,
      upgradeCount: native.upgradeCount,
      timedOut: native.timedOut,
      messageBytes: native.messageBytes,
      messageFinished: native.messageFinished,
      digest: !native.messageFinished
        ? "not-complete"
        : native.messageDigest === native.expectedDigest
          ? "matched"
          : "mismatched",
      nativePingWritesMidMessage: native.nativePingWritesMidMessage,
      nativePongMidMessage: native.nativePongMidMessage,
      nativePongAfterMessage: native.nativePongAfterMessage,
      closeWritten: native.closeWritten,
      closeFrameReceived: native.closeFrameReceived,
      closeAfterMessage: native.closeAfterMessage,
      partialFrame: native.partialFrame,
    },
    proxy: {
      complete: proxy.complete,
      overflow: proxy.overflow,
      connections: {
        created: proxy.connections.created,
        active: proxy.connections.active,
        closed: proxy.connections.closed,
      },
      up: direction(proxy.up),
      down: direction(proxy.down),
    },
  };
}
export type InlineProbeProgress = ReturnType<typeof inlineProbeSnapshot>;
/** The existing controller seam, retaining only closed progress without changing probe admission or bounds. */
export async function observeInlineTransportProbe(port: {
  readonly action: BrowserInlineAction;
  readonly start: () => Promise<void>;
  readonly readBrowser: () => Promise<{ result: unknown; progress: unknown }>;
  readonly readNative: () => InlineReceiverRead;
  readonly readProxy: () => ProxyMeasurements;
  readonly until: RemainingQualificationPort["until"];
  readonly closeProxy: () => Promise<void>;
  readonly closeReceiver: () => Promise<void>;
  readonly capture: (value: InlineProbeProgress) => void;
}) {
  if (port.action !== "mid-message-pong" && port.action !== "queued-before-close")
    throw new Error("Inline probe action refused.");
  let stage: InlineProbeStage = "start";
  let browser: BrowserInlineObservation | null = null;
  let progress: BrowserInlineProgress | null = null;
  let browserProgressState: InlineProbeProgress["browserProgressState"] = "not-observed";
  let ownedCleanupJoined = false;
  const capture = (outcome: InlineProbeProgress["outcome"]) => {
    try {
      port.capture(
        inlineProbeSnapshot(
          port.action,
          stage,
          outcome,
          progress,
          browserProgressState,
          browser !== null,
          ownedCleanupJoined,
          port.readNative(),
          port.readProxy(),
        ),
      );
    } catch {
      // New diagnostic callbacks cannot interrupt the probe or replace its original failure.
    }
  };
  try {
    capture("running");
    await port.start();
    stage = "browser-result";
    capture("running");
    await port.until(async () => {
      const raw = await port.readBrowser();
      progress = projectBrowserInlineProgress(raw.progress);
      if (progress?.action !== port.action) progress = null;
      browserProgressState =
        raw.progress === null ? "not-observed" : progress ? "observed" : "refused";
      capture("running");
      if (raw.result === null) return false;
      browser = projectBrowserInlineObservation(raw.result);
      if (!browser) throw new Error("Remaining qualification evidence refused.");
      return true;
    }, 250000);
    stage = "receiver-close";
    capture("running");
    await port.until(async () => port.readNative().closeFrameReceived, 5000);
    stage = "cleanup";
    capture("running");
    await port.closeProxy();
    await port.closeReceiver();
    ownedCleanupJoined = true;
    stage = "native-proof";
    capture("running");
    const native = port.readNative();
    if (
      !native.upgraded ||
      native.upgradeCount !== 1 ||
      native.messageDigest !== native.expectedDigest ||
      native.expectedBytes !== 3145728 ||
      !native.complete ||
      !browser
    )
      throw new Error("Remaining qualification evidence refused.");
    stage = "complete";
    capture("complete");
    return { browser, native, ownedCleanupJoined: true };
  } catch (error) {
    capture("failed");
    throw error;
  }
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
