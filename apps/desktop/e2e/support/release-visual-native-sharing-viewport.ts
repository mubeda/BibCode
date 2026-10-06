// @effect-diagnostics nodeBuiltinImport:off - Closed geometry admission rejects proxies before reflection.
import * as NodeUtil from "node:util";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
import type { NativeSharingGeometryPort } from "./release-visual-native-sharing-geometry.ts";
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
  viewportRestoreIdentityVerified: boolean;
  viewportRestoreCommandReturned: boolean;
  viewportRestoreOriginalFrameMatched: boolean | null;
}
export interface NativeSharingOriginalRectFacts {
  originalRectRecordMatched: boolean | null;
  originalRectKeysMatched: boolean | null;
  originalRectNumbersFinite: boolean | null;
  originalRectNumbersInteger: boolean | null;
  originalRectPositionNonnegative: boolean | null;
  originalRectDimensionsPositive: boolean | null;
  originalRectHorizontalWithinDisplay: boolean | null;
  originalRectVerticalWithinDisplay: boolean | null;
}
export const unknownNativeSharingOriginalRectFacts: Readonly<NativeSharingOriginalRectFacts> =
  Object.freeze({
    originalRectRecordMatched: null,
    originalRectKeysMatched: null,
    originalRectNumbersFinite: null,
    originalRectNumbersInteger: null,
    originalRectPositionNonnegative: null,
    originalRectDimensionsPositive: null,
    originalRectHorizontalWithinDisplay: null,
    originalRectVerticalWithinDisplay: null,
  });
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
function fields(value: unknown, keys: readonly string[], facts?: NativeSharingOriginalRectFacts) {
  if (!value || typeof value !== "object" || Array.isArray(value) || NodeUtil.types.isProxy(value))
    throw refused();
  if (facts) facts.originalRectRecordMatched = true;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  ) {
    if (facts) facts.originalRectKeysMatched = false;
    throw refused();
  }
  if (facts) facts.originalRectKeysMatched = true;
  const result: Record<string, number> = {};
  for (const [index, key] of keys.entries()) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) {
      if (facts) Object.assign(facts, unknownNativeSharingOriginalRectFacts);
      throw refused();
    }
    const number = field.value;
    if (typeof number !== "number" || !Number.isFinite(number)) {
      if (facts) facts.originalRectNumbersFinite = false;
      throw refused();
    }
    if (!Number.isInteger(number)) {
      if (facts) {
        // Keep the original early exit: later fields have not been inspected.
        facts.originalRectNumbersFinite = index === keys.length - 1 ? true : null;
        facts.originalRectNumbersInteger = false;
      }
      throw refused();
    }
    result[key] = number;
  }
  if (facts) {
    facts.originalRectNumbersFinite = true;
    facts.originalRectNumbersInteger = true;
  }
  return result;
}
function inspectRect(value: unknown): {
  facts: Readonly<NativeSharingOriginalRectFacts>;
} & ({ accepted: true; rectangle: Rect } | { accepted: false; error: unknown }) {
  const facts: NativeSharingOriginalRectFacts = { ...unknownNativeSharingOriginalRectFacts };
  try {
    const valueRect = fields(value, ["x", "y", "width", "height"], facts);
    facts.originalRectPositionNonnegative = valueRect.x! >= 0 && valueRect.y! >= 0;
    facts.originalRectDimensionsPositive = valueRect.width! > 0 && valueRect.height! > 0;
    facts.originalRectHorizontalWithinDisplay =
      valueRect.x! >= 0 && valueRect.x! + valueRect.width! <= 1920;
    facts.originalRectVerticalWithinDisplay =
      valueRect.y! >= 0 && valueRect.y! + valueRect.height! <= 1440;
    if (
      !facts.originalRectPositionNonnegative ||
      !facts.originalRectDimensionsPositive ||
      !facts.originalRectHorizontalWithinDisplay ||
      !facts.originalRectVerticalWithinDisplay
    )
      throw refused();
    return {
      facts: Object.freeze(facts),
      accepted: true,
      rectangle: Object.freeze(valueRect) as unknown as Rect,
    };
  } catch (error) {
    return { facts: Object.freeze(facts), accepted: false, error };
  }
}
function rect(value: unknown): Rect {
  const inspected = inspectRect(value);
  if (!inspected.accepted) throw inspected.error;
  return inspected.rectangle;
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
  geometry: Pick<NativeSharingGeometryPort, "read" | "set" | "restore">;
  identity: () => Promise<void>;
  unsafeCleanup: () => void;
  observe?: (facts: Partial<NativeSharingViewportFacts>) => void;
  onOriginalRectFacts?: (facts: Readonly<NativeSharingOriginalRectFacts>) => void;
}) {
  const inspected = inspectRect(input.original);
  try {
    input.onOriginalRectFacts?.(inspected.facts);
  } catch {
    /* Passive attribution cannot change admission or replace its original refusal. */
  }
  if (!inspected.accepted) throw inspected.error;
  const original = inspected.rectangle;
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
        const native = await input.geometry.read(),
          current = rect(native.rectangle),
          client = await read();
        if (requested && JSON.stringify(current) !== JSON.stringify(requested)) {
          previous = null;
          return false;
        }
        const fingerprint = JSON.stringify({ native, client });
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
        await input.geometry.set(native, next);
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
    observe({
      viewportLeaseActive: false,
      viewportRestoreAttempted: true,
      viewportRestoreIdentityVerified: false,
      viewportRestoreCommandReturned: false,
      viewportRestoreOriginalFrameMatched: null,
    });
    void (async () => {
      try {
        await input.identity();
        observe({ viewportRestoreIdentityVerified: true });
        await input.geometry.restore();
        observe({ viewportRestoreCommandReturned: true });
        await input.owner.until(async () => {
          try {
            await input.identity();
          } catch (error) {
            observe({ viewportRestoreIdentityVerified: false });
            throw error;
          }
          observe({ viewportRestoreIdentityVerified: true });
          await read();
          const originalFrameMatched =
            JSON.stringify(rect((await input.geometry.read()).rectangle)) ===
            JSON.stringify(original);
          observe({ viewportRestoreOriginalFrameMatched: originalFrameMatched });
          return originalFrameMatched;
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
