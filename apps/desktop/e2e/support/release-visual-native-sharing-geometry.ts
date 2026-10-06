// @effect-diagnostics nodeBuiltinImport:off - Reject unsafe IPC metadata before reflecting private native fields.
import * as NodeUtil from "node:util";
import { bounded, type QualificationBrowser } from "./qualification-owner.ts";

export interface NativeSharingRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface NativeSharingGeometrySnapshot {
  readonly rectangle: NativeSharingRectangle;
  readonly resizeWidth: number;
  readonly resizeHeight: number;
  readonly scaleFactor: number;
}
export interface NativeSharingGeometryPort {
  acquire: () => Promise<NativeSharingGeometrySnapshot>;
  read: () => Promise<NativeSharingGeometrySnapshot>;
  set: (expected: NativeSharingGeometrySnapshot, target: NativeSharingRectangle) => Promise<void>;
  restore: () => Promise<void>;
}
type GeometryRequest =
  | { operation: "acquire" }
  | { operation: "read" | "restore"; lease: string }
  | {
      operation: "set";
      lease: string;
      expected: NativeSharingGeometrySnapshot;
      target: NativeSharingRectangle;
    };
const refused = () => new Error("Owned native sharing geometry refused.");
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || NodeUtil.types.isProxy(value))
    throw refused();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  )
    throw refused();
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw refused();
    fields[key] = field.value;
  }
  return fields;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw refused();
  return value;
}
function snapshot(value: unknown): NativeSharingGeometrySnapshot {
  const fields = record(value, ["rectangle", "resizeWidth", "resizeHeight", "scaleFactor"]),
    rect = record(fields.rectangle, ["x", "y", "width", "height"]),
    rectangle = Object.freeze({
      x: integer(rect.x),
      y: integer(rect.y),
      width: integer(rect.width),
      height: integer(rect.height),
    }),
    resizeWidth = integer(fields.resizeWidth),
    resizeHeight = integer(fields.resizeHeight),
    scaleFactor = integer(fields.scaleFactor);
  if (
    rectangle.x < 0 ||
    rectangle.y < 0 ||
    rectangle.width <= 0 ||
    rectangle.height <= 0 ||
    rectangle.x + rectangle.width > 1920 ||
    rectangle.y + rectangle.height > 1440 ||
    resizeWidth <= 0 ||
    resizeHeight <= 0 ||
    scaleFactor !== 1 ||
    rectangle.width - resizeWidth < 0 ||
    rectangle.height - resizeHeight < 0 ||
    rectangle.width - resizeWidth > 256 ||
    rectangle.height - resizeHeight > 256
  )
    throw refused();
  return Object.freeze({ rectangle, resizeWidth, resizeHeight, scaleFactor });
}
/** One supported test-only command on the original SDK; native errors remain rejected operations. */
async function invokeMainGeometry(request: GeometryRequest): Promise<unknown> {
  const host = window as Window & {
      __TAURI__?: { core?: { invoke?: (command: string, args: object) => Promise<unknown> } };
    },
    invoke = host.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") throw new Error("Owned native sharing geometry refused.");
  return invoke("desktop_e2e_main_window_geometry", { request });
}
export function createNativeSharingGeometry(input: {
  browser: QualificationBrowser;
  unsafeCleanup: () => void;
}): NativeSharingGeometryPort {
  let acquired: { lease: string; snapshot: NativeSharingGeometrySnapshot } | undefined,
    acquisition: Promise<NativeSharingGeometrySnapshot> | undefined,
    restoration: Promise<void> | undefined,
    closing = false,
    unsafe = false;
  const markUnsafe = () => {
    if (unsafe) return;
    unsafe = true;
    try {
      input.unsafeCleanup();
    } catch {
      /* Preserve the original operation failure. */
    }
  };
  const invoke = async (request: GeometryRequest) => {
    try {
      return await bounded(input.browser.execute(invokeMainGeometry, request), 2000);
    } catch (error) {
      markUnsafe();
      throw error;
    }
  };
  const requireLease = () => {
    if (!acquired) throw refused();
    return acquired;
  };
  const acknowledge = (value: unknown) => {
    if (record(value, ["requested"]).requested !== true) throw refused();
  };
  const acquire = () => {
    if (acquisition) return acquisition;
    let resolve!: (value: NativeSharingGeometrySnapshot) => void, reject!: (error: unknown) => void;
    acquisition = new Promise<NativeSharingGeometrySnapshot>((ok, bad) => {
      resolve = ok;
      reject = bad;
    });
    void (async () => {
      try {
        const value = record(await invoke({ operation: "acquire" }), ["lease", "snapshot"]);
        if (
          typeof value.lease !== "string" ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.lease)
        )
          throw refused();
        acquired = { lease: value.lease, snapshot: snapshot(value.snapshot) };
        return acquired.snapshot;
      } catch (error) {
        markUnsafe();
        throw error;
      }
    })().then(resolve, reject);
    return acquisition;
  };
  return {
    acquire,
    read: async () => {
      try {
        return snapshot(await invoke({ operation: "read", lease: requireLease().lease }));
      } catch (error) {
        markUnsafe();
        throw error;
      }
    },
    set: async (expected, target) => {
      if (closing || unsafe) throw refused();
      try {
        acknowledge(
          await invoke({ operation: "set", lease: requireLease().lease, expected, target }),
        );
      } catch (error) {
        markUnsafe();
        throw error;
      }
    },
    restore: () => {
      if (restoration) return restoration;
      closing = true;
      let resolve!: () => void, reject!: (error: unknown) => void;
      restoration = new Promise<void>((ok, bad) => {
        resolve = ok;
        reject = bad;
      });
      void (async () => {
        try {
          acknowledge(await invoke({ operation: "restore", lease: requireLease().lease }));
        } catch (error) {
          markUnsafe();
          throw error;
        }
      })().then(resolve, reject);
      return restoration;
    },
  };
}
