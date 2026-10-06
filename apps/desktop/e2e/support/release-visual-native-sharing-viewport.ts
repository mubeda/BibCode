// @effect-diagnostics nodeBuiltinImport:off - Closed geometry admission rejects proxies before reflection.
import * as NodeUtil from "node:util";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
export interface NativeSharingViewportFacts {
  viewportMeasurementReturned: boolean;
  viewportDisplayMatched: boolean;
  viewportScaleMatched: boolean;
  viewportChromeBounded: boolean;
  viewportClientExact: boolean;
  viewportCorrectionAttempted: boolean;
  viewportLeaseActive: boolean;
  viewportRestoreAttempted: boolean;
  viewportOriginalRectRestored: boolean;
  viewportRestoreFailed: boolean;
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Measurement {
  width: number;
  height: number;
  scale: number;
  screenWidth: number;
  screenHeight: number;
}
const refused = () => new Error("Owned native sharing viewport refused.");
/** Native WebKit client measurements only; there is no URL, markup, text, credential or private identity. */
export function readNativeSharingViewport(): unknown {
  return {
    width: innerWidth,
    height: innerHeight,
    scale: devicePixelRatio,
    screenWidth: screen.width,
    screenHeight: screen.height,
  };
}
function fields(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || NodeUtil.types.isProxy(value))
    throw refused();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  )
    throw refused();
  const result: Record<string, number> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (
      !field?.enumerable ||
      !Object.hasOwn(field, "value") ||
      typeof field.value !== "number" ||
      !Number.isFinite(field.value) ||
      !Number.isInteger(field.value)
    )
      throw refused();
    result[key] = field.value;
  }
  return result;
}
function rect(value: unknown): Rect {
  const valueRect = fields(value, ["x", "y", "width", "height"]);
  if (
    valueRect.x! < 0 ||
    valueRect.y! < 0 ||
    valueRect.width! <= 0 ||
    valueRect.height! <= 0 ||
    valueRect.x! + valueRect.width! > 1920 ||
    valueRect.y! + valueRect.height! > 1440
  )
    throw refused();
  return valueRect as unknown as Rect;
}
function measurement(value: unknown): Measurement {
  const measured = fields(value, ["width", "height", "scale", "screenWidth", "screenHeight"]);
  if (
    measured.width! <= 0 ||
    measured.height! <= 0 ||
    measured.width! > 1920 ||
    measured.height! > 1440
  )
    throw refused();
  return measured as unknown as Measurement;
}
/** The exact original outer rectangle is leased, not changed into a second source of UI geometry. */
export function createNativeSharingViewport(input: {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  original: unknown;
  identity: () => Promise<void>;
  unsafeCleanup: () => void;
  observe?: (facts: Partial<NativeSharingViewportFacts>) => void;
}) {
  const original = Object.freeze(rect(input.original));
  let active = false,
    mutated = false,
    observerFailed = false,
    unsafe = false,
    restoreResult: Promise<void> | undefined;
  const markUnsafe = () => {
    if (unsafe) return;
    unsafe = true;
    try {
      input.unsafeCleanup();
    } catch {
      /* Preserve genuine failures. */
    }
  };
  const observe = (facts: Partial<NativeSharingViewportFacts>) => {
    try {
      input.observe?.(facts);
    } catch {
      observerFailed = true;
      markUnsafe();
    }
  };
  const read = async () => {
    const value = measurement(
      await bounded(input.browser.execute(readNativeSharingViewport), 2000),
    );
    observe({
      viewportMeasurementReturned: true,
      viewportDisplayMatched: value.screenWidth === 1920 && value.screenHeight === 1440,
      viewportScaleMatched: value.scale === 1,
      viewportClientExact: value.width === 1280 && value.height === 960,
    });
    if (value.screenWidth !== 1920 || value.screenHeight !== 1440 || value.scale !== 1)
      throw refused();
    return value;
  };
  const verify = async () => {
    await input.identity();
    if (!active) return;
    const value = await read();
    if (value.width !== 1280 || value.height !== 960 || observerFailed) throw refused();
  };
  const fit = async () => {
    if (active || restoreResult) throw refused();
    let previous: string | null = null,
      requested: Rect | null = null,
      corrections = 0;
    try {
      await input.owner.until(async () => {
        await input.identity();
        const current = rect(await bounded(input.browser.getWindowRect(), 2000)),
          client = await read();
        if (requested && JSON.stringify(current) !== JSON.stringify(requested)) {
          previous = null;
          return false;
        }
        const fingerprint = JSON.stringify({ current, client });
        if (fingerprint !== previous) {
          previous = fingerprint;
          return false;
        }
        const chromeWidth = current.width - client.width,
          chromeHeight = current.height - client.height;
        const boundedChrome =
          chromeWidth >= 0 && chromeHeight >= 0 && chromeWidth <= 256 && chromeHeight <= 256;
        observe({ viewportChromeBounded: boundedChrome });
        if (!boundedChrome) throw refused();
        if (client.width === 1280 && client.height === 960) {
          if (observerFailed) throw refused();
          active = true;
          observe({ viewportLeaseActive: true });
          if (observerFailed) {
            active = false;
            throw refused();
          }
          return true;
        }
        if (corrections >= 3) throw refused();
        const width = 1280 + chromeWidth,
          height = 960 + chromeHeight;
        const next = rect({
          x: Math.min(current.x, 1920 - width),
          y: Math.min(current.y, 1440 - height),
          width,
          height,
        });
        if (JSON.stringify(next) === JSON.stringify(current)) throw refused();
        await input.identity();
        mutated = true;
        corrections++;
        observe({ viewportCorrectionAttempted: true });
        await bounded(input.browser.setWindowRect(next.x, next.y, next.width, next.height), 2000);
        requested = next;
        previous = null;
        return false;
      });
    } catch (error) {
      active = false;
      if (mutated) markUnsafe();
      throw error;
    }
  };
  const restore = () => {
    if (restoreResult) return restoreResult;
    let resolve!: () => void, reject!: (error: unknown) => void;
    restoreResult = new Promise<void>((ok, bad) => {
      resolve = ok;
      reject = bad;
    });
    active = false;
    observe({ viewportLeaseActive: false, viewportRestoreAttempted: true });
    void (async () => {
      try {
        await input.identity();
        await bounded(
          input.browser.setWindowRect(original.x, original.y, original.width, original.height),
          2000,
        );
        await input.owner.until(async () => {
          await input.identity();
          await read();
          return (
            JSON.stringify(rect(await bounded(input.browser.getWindowRect(), 2000))) ===
            JSON.stringify(original)
          );
        });
        observe({ viewportOriginalRectRestored: true });
        if (observerFailed) throw refused();
      } catch (error) {
        observe({ viewportRestoreFailed: true });
        markUnsafe();
        throw error;
      }
    })().then(resolve, reject);
    return restoreResult;
  };
  return { fit, verify, restore };
}
