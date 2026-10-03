import selections from "./chat-upload-matrix-cases.json" with { type: "json" };

export interface ChatMatrixCase {
  readonly case: string;
  readonly transport: "plain" | "noise";
  readonly upBytesPerSecond: 16384 | 65536;
  readonly theme: "light" | "dark";
  readonly action:
    | "delivery"
    | "freeze"
    | "cancel-pointer"
    | "cancel-enter"
    | "cancel-space"
    | "stop";
  readonly innerTimeoutSeconds: 1800;
  readonly outerTimeoutSeconds: 1860;
}
export const chatMatrixCases: ReadonlyArray<ChatMatrixCase> = Object.freeze(
  selections.map((selection) => Object.freeze(selection as ChatMatrixCase)),
);
export const matrixArtifactNames = Object.freeze([
  "matrix-progress.png",
  "matrix-result.png",
  "matrix-reconnecting.png",
  "matrix-cancel-restored.png",
  "matrix-stream-stop.png",
] as const);

/** A fixed covering case, never an arbitrary controller path, rate or deadline. */
export function parseChatMatrixCase(value: unknown): ChatMatrixCase {
  const selection = chatMatrixCases.find((candidate) => candidate.case === value);
  if (!selection) throw new Error("The upload matrix case is invalid.");
  return selection;
}

import type { remote } from "webdriverio";
import type { ChatUploadObservation } from "./chat-upload-observer.ts";
import type { ProxyMeasurements } from "../../../../scripts/throttle-proxy.ts";
export type MatrixBrowser = Awaited<ReturnType<typeof remote>>;
export const matrixEditor =
  '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]';
export const matrixCancel = '//button[normalize-space()="Cancel" and ../p[@role="status"]]';

export async function activateMatrixCancel(
  browser: MatrixBrowser,
  action: "cancel-pointer" | "cancel-enter" | "cancel-space",
): Promise<void> {
  const button = await browser.$(matrixCancel);
  await button.waitForDisplayed();
  await button.waitForEnabled();
  if (action === "cancel-pointer") {
    await button.click();
    return;
  }
  for (let attempt = 0; attempt < 128; attempt++) {
    const focused = await browser.execute(() => {
      const active = document.activeElement;
      return (
        active instanceof HTMLButtonElement &&
        active.textContent?.trim() === "Cancel" &&
        active.parentElement?.querySelector('p[role="status"]') !== null
      );
    });
    if (focused) {
      await browser.keys(action === "cancel-enter" ? "Enter" : " ");
      return;
    }
    await browser.keys("Tab");
  }
  throw new Error("Matrix evidence assertion failed.");
}

export interface MatrixUi {
  readonly progressUnits: number | null;
  readonly reconnecting: boolean;
  readonly validPreview: boolean;
  readonly restoredOutgoing: boolean;
  readonly newerPreserved: boolean;
  readonly error: boolean;
  readonly dripCount: number;
  readonly stopAvailable: boolean;
  readonly deliveredImage: boolean;
}
/** Read-only renderer boundary: retain fixed booleans and displayed tenths of MiB, never text/URLs/IDs. */
export function readChatMatrixDom(input: {
  readonly outgoing: string;
  readonly newer: string;
}): MatrixUi {
  const view = document.querySelector('[data-center-surface-host][data-visible="true"]');
  const notices = Array.from(view?.querySelectorAll('p[role="status"]') ?? []);
  const notice = notices.find(
    (node) => node.parentElement?.querySelector("button")?.textContent?.trim() === "Cancel",
  );
  const copy = notice?.textContent?.trim() ?? "";
  const match = /^Uploading 1 attachment — (\d+(?:\.\d+)?) of 10 MiB$/.exec(copy);
  const units = match ? Math.round(Number(match[1]) * 10) : null;
  const editor = view?.querySelector('[data-testid="composer-editor"]');
  const text = editor?.textContent ?? "";
  const assistant =
    Array.from(view?.querySelectorAll('[data-message-role="assistant"]') ?? []).at(-1)
      ?.textContent ?? "";
  const form = view?.querySelector('[data-chat-composer-form="true"]');
  return {
    progressUnits:
      units !== null && Number.isInteger(units) && units >= 0 && units <= 100 ? units : null,
    reconnecting: copy === "Reconnecting…",
    validPreview: Array.from(form?.querySelectorAll("img") ?? []).some(
      (image) =>
        image instanceof HTMLImageElement &&
        image.complete &&
        image.naturalWidth === 1 &&
        image.naturalHeight === 1,
    ),
    restoredOutgoing: text.includes(input.outgoing),
    newerPreserved: text.includes(input.newer),
    error:
      document.querySelector(
        '[data-type="error"][role="dialog"],[data-type="error"][role="alertdialog"]',
      ) !== null ||
      Array.from(view?.querySelectorAll('[role="alert"]') ?? []).some((node) =>
        node.classList.contains("text-destructive-foreground"),
      ),
    dripCount: Math.min(900, (assistant.match(/\bdrip\d+\./g) ?? []).length),
    deliveredImage: Array.from(view?.querySelectorAll('[data-message-role="user"] img') ?? []).some(
      (image) =>
        image instanceof HTMLImageElement &&
        image.complete &&
        image.naturalWidth === 1 &&
        image.naturalHeight === 1,
    ),
    stopAvailable:
      view?.querySelector('button[aria-label="Stop generation"]') !== null && view !== null,
  };
}

export interface MatrixPort {
  readonly phase: (name: string) => void;
  readonly stageAndSend: () => Promise<void>;
  readonly editNewer: () => Promise<void>;
  readonly startStream: () => Promise<void>;
  readonly stopGeneration: () => Promise<void>;
  readonly activateCancel: () => Promise<void>;
  readonly readUi: () => Promise<MatrixUi>;
  readonly receipt: () => Promise<{ count: number; matched: boolean }>;
  readonly capture: (name: (typeof matrixArtifactNames)[number]) => Promise<void>;
  readonly observe: () => Promise<ChatUploadObservation>;
  readonly measurements: () => ProxyMeasurements;
  readonly clock: () => Promise<number>;
  readonly freeze: (value: boolean) => void;
  readonly until: (check: () => Promise<boolean>, timeout?: number) => Promise<void>;
}
const matrixCheck = (value: boolean): void => {
  if (!value) throw new Error("Matrix evidence assertion failed.");
};

export async function runChatMatrixCase(selection: ChatMatrixCase, port: MatrixPort) {
  const samples: number[] = [];
  let clientCloseElapsedMs: number | null = null;
  let streamed = false,
    stopped = false,
    restored = false;
  let cancelRpcCount: number | null = null;
  let cancelBaseline: number | null = null;
  const sample = (ui: MatrixUi) => {
    matrixCheck(!ui.error);
    if (ui.progressUnits !== null)
      matrixCheck(
        Number.isInteger(ui.progressUnits) &&
          ui.progressUnits >= 0 &&
          ui.progressUnits <= 100 &&
          (samples.at(-1) === undefined || ui.progressUnits >= samples.at(-1)!),
      );
    if (ui.progressUnits !== null && samples.at(-1) !== ui.progressUnits && samples.length < 128)
      samples.push(ui.progressUnits);
  };
  if (selection.action === "stop") {
    port.phase("matrix-start-stream");
    await port.startStream();
    await port.until(async () => {
      const ui = await port.readUi();
      return ui.dripCount >= 2 && ui.stopAvailable;
    });
    streamed = true;
  }
  port.phase("matrix-send");
  await port.stageAndSend();
  await port.until(async () => {
    const ui = await port.readUi();
    sample(ui);
    return ui.progressUnits !== null && ui.progressUnits > 0;
  });
  const first = samples.at(-1)!;
  await port.until(async () => {
    const ui = await port.readUi();
    sample(ui);
    return ui.progressUnits !== null && ui.progressUnits > first;
  });
  await port.capture("matrix-progress.png");

  if (selection.action.startsWith("cancel")) {
    port.phase("matrix-type-newer");
    await port.editNewer();
    const beforeCancel = await port.observe();
    if (selection.transport === "plain") {
      matrixCheck(beforeCancel.plain.complete);
      cancelBaseline = beforeCancel.plain.requests.cancel;
    }
    await port.activateCancel();
    await port.until(async () => {
      const ui = await port.readUi();
      return (
        ui.progressUnits === null &&
        !ui.reconnecting &&
        ui.validPreview &&
        ui.restoredOutgoing &&
        ui.newerPreserved &&
        !ui.error
      );
    });
    matrixCheck((await port.receipt()).count === 0);
    restored = true;
    if (selection.transport === "plain") {
      await port.until(async () => {
        const current = await port.observe();
        matrixCheck(current.plain.complete);
        const count = current.plain.requests.cancel - cancelBaseline!;
        matrixCheck(count <= 1);
        return count === 1;
      });
    }
    await port.capture("matrix-cancel-restored.png");
  } else {
    if (selection.action === "freeze") {
      const beforeFreeze = (await port.observe())[selection.transport].close4408;
      matrixCheck(beforeFreeze.complete);
      const baseline = beforeFreeze.count;
      const started = await port.clock();
      const checkpoint = samples.at(-1)!;
      matrixCheck(Number.isFinite(started) && started >= 0);
      matrixCheck(beforeFreeze.lastAtMs === null || beforeFreeze.lastAtMs <= started);
      port.phase("matrix-freeze");
      port.freeze(true);
      try {
        await port.until(async () => {
          const snapshot = await port.observe();
          const observed = snapshot[selection.transport];
          matrixCheck(
            selection.transport === "noise"
              ? snapshot.noise.closeMetricsComplete
              : snapshot.plain.available && snapshot.plain.complete,
          );
          const witness = observed.close4408;
          matrixCheck(witness.complete);
          if (witness.count <= baseline || witness.lastAtMs === null) return false;
          clientCloseElapsedMs = witness.lastAtMs - started;
          matrixCheck(clientCloseElapsedMs >= 0 && clientCloseElapsedMs <= 33_000);
          return true;
        }, 35_000);
        await port.until(async () => (await port.readUi()).reconnecting);
        await port.capture("matrix-reconnecting.png");
      } finally {
        port.freeze(false);
      }
      port.phase("matrix-resume");
      await port.until(async () => {
        const ui = await port.readUi();
        sample(ui);
        if (ui.progressUnits !== null) matrixCheck(ui.progressUnits >= checkpoint);
        return ui.progressUnits !== null && ui.progressUnits > checkpoint;
      });
    }
    if (selection.action === "stop") {
      const ui = await port.readUi();
      const before = ui.dripCount;
      const checkpoint = samples.at(-1)!;
      matrixCheck(ui.stopAvailable);
      await port.until(async () => (await port.readUi()).dripCount > before);
      port.phase("matrix-stop-generation");
      await port.stopGeneration();
      await port.until(async () => {
        const current = await port.readUi();
        sample(current);
        return (
          !current.stopAvailable &&
          current.progressUnits !== null &&
          current.progressUnits > checkpoint
        );
      });
      stopped = true;
      await port.capture("matrix-stream-stop.png");
    }
    port.phase("matrix-wait-provider");
    await port.until(async () => {
      const receipt = await port.receipt();
      if (receipt.count > 0) matrixCheck(receipt.count === 1 && receipt.matched);
      return receipt.count === 1;
    }, 1_200_000);
    matrixCheck((await port.receipt()).matched);
    await port.until(async () => {
      const ui = await port.readUi();
      return (
        ui.progressUnits === null &&
        !ui.reconnecting &&
        !ui.error &&
        ui.deliveredImage &&
        !ui.stopAvailable
      );
    });
    await port.capture("matrix-result.png");
  }
  const observed = await port.observe();
  if (restored) {
    matrixCheck((await port.receipt()).count === 0);
    if (selection.transport === "plain") {
      matrixCheck(observed.plain.complete && cancelBaseline !== null);
      cancelRpcCount = observed.plain.requests.cancel - cancelBaseline!;
      matrixCheck(cancelRpcCount === 1);
    }
  }
  if (selection.action === "freeze") {
    matrixCheck(observed[selection.transport].close4408.complete);
    matrixCheck(
      selection.transport === "noise"
        ? observed.noise.closeMetricsComplete
        : observed.plain.available && observed.plain.complete,
    );
  }
  if (selection.transport === "plain" && selection.action === "delivery")
    matrixCheck(
      observed.plain.complete &&
        observed.plain.requests.begin > 0 &&
        observed.plain.append.maximumOutstandingPerSocket <= 2,
    );
  return {
    case: selection.case,
    transport: selection.transport,
    theme: selection.theme,
    action: selection.action,
    upBytesPerSecond: selection.upBytesPerSecond,
    advancingUi: samples.length >= 2,
    displayedUnit: "tenths-mib",
    uiSamples: samples,
    providerMatched: restored ? null : (await port.receipt()).matched,
    cancelActivations: restored ? 1 : 0,
    cancelRpcCount,
    restoredWithNewerWork: restored,
    streamed,
    stopped,
    clientCloseCode: clientCloseElapsedMs === null ? null : 4408,
    clientCloseElapsedMs,
    applicationMetricsAvailable: selection.transport === "plain",
    transportObservations: observed[selection.transport],
    proxyMeasurements: port.measurements(),
    fullMatrixComplete: false,
    deferred: {
      retention: true,
      oldServer: true,
      maxBatch: true,
      admissionRemount: true,
      nativeHeartbeat: true,
      webkitGtk: true,
    },
  };
}

/** Same narrow screenshot fence for normal failures and selected matrix scenes. */
export function qualificationScreenSafe(input: {
  readonly origin: string;
  readonly dark: boolean | null;
}): boolean {
  return (
    location.origin === input.origin &&
    location.search === "" &&
    location.hash === "" &&
    (input.dark === null || document.documentElement.classList.contains("dark") === input.dark) &&
    document.querySelector(
      '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder="bibcode://pair?code=…"]',
    ) === null
  );
}
