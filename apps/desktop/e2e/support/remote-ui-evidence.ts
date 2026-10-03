// @effect-diagnostics nodeBuiltinImport:off - Inspect original CI screenshots without editing them.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

export const remoteUiThemes = ["light", "dark"] as const;
export type RemoteUiTheme = (typeof remoteUiThemes)[number];
export const remoteUiScenes = [
  "initial-row",
  "initial-card",
  "confirm-row",
  "confirm-card",
  "terminal-warning",
  "downloading-row",
  "downloading-card",
  "downloading-remounted",
  "backup",
  "restarting",
  "success",
  "failure",
  "row-retry",
  "toast-retry",
  "dismissed",
  "wrong-version",
  "not-back",
  "queued",
  "manual-archive",
  "manual-package",
  "manual-unknown",
  "reload-offer",
  "reload-complete",
] as const;
export type RemoteUiScene = (typeof remoteUiScenes)[number];

/** Closed facts from one current row after failure; never proof of the earlier click. */
export function projectRemoteUiCheckAgainObservation(input: unknown) {
  if (input === null || typeof input !== "object") return null;
  const row: Record<string, unknown> = {};
  try {
    if (Array.isArray(input)) return null;
    for (const key of [
      "safeLocation",
      "rowCount",
      "controlCount",
      "controlLabel",
      "controlVisible",
      "controlDisabled",
      "hitTarget",
      "updateActionPresent",
      "badgeVariant",
      "dismissPresent",
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined) continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      row[key] = descriptor.value;
    }
  } catch {
    return null;
  }
  const safeLocation = typeof row.safeLocation === "boolean" ? row.safeLocation : null;
  const source: Record<string, unknown> = safeLocation === true ? row : {};
  const choice = (key: string, values: readonly string[]) =>
    typeof source[key] === "string" && values.includes(source[key]) ? source[key] : null;
  const rowCount = choice("rowCount", ["none", "one", "multiple"]);
  const fields: Record<string, unknown> = rowCount === "one" ? source : {};
  const flag = (key: string) => (typeof fields[key] === "boolean" ? fields[key] : null);
  const enumField = (key: string, values: readonly string[]) =>
    typeof fields[key] === "string" && values.includes(fields[key]) ? fields[key] : null;
  const controlCount = enumField("controlCount", ["none", "one", "multiple"]);
  return {
    safeLocation,
    rowCount,
    controlCount,
    controlLabel:
      controlCount === "one"
        ? enumField("controlLabel", ["check", "check-again", "checking"])
        : null,
    controlVisible: controlCount === "one" ? flag("controlVisible") : null,
    controlDisabled: controlCount === "one" ? flag("controlDisabled") : null,
    hitTarget:
      controlCount === "one"
        ? enumField("hitTarget", ["target", "toast", "dialog", "other", "none", "outside-viewport"])
        : null,
    updateActionPresent: flag("updateActionPresent"),
    badgeVariant: enumField("badgeVariant", [
      "checking",
      "not-checked",
      "unreachable",
      "check-failed",
      "up-to-date",
      "update-available",
      "busy",
      "manual",
      "error",
    ]),
    dismissPresent: flag("dismissPresent"),
  };
}

/** Closed, presence-only failure facts. Missing/invalid observations stay unavailable. */
export function projectRemoteUiSetupObservation(input: unknown) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  const choice = (key: string, values: readonly string[]) =>
    typeof row[key] === "string" && values.includes(row[key]) ? row[key] : null;
  const flag = (key: string) => (typeof row[key] === "boolean" ? row[key] : null);
  return {
    route: choice("route", ["pair", "settings", "other"]),
    readyState: choice("readyState", ["loading", "interactive", "complete"]),
    tokenPresent: flag("tokenPresent"),
    submitPresent: flag("submitPresent"),
    submitDisabled: flag("submitDisabled"),
    sidebarPresent: flag("sidebarPresent"),
    importPathPresent: flag("importPathPresent"),
    importBusy: flag("importBusy"),
    importError: choice("importError", [
      "none",
      "path-required",
      "host-loading",
      "unsupported-windows",
      "path-relative",
      "unknown",
    ]),
    themeControlPresent: flag("themeControlPresent"),
    pairingPendingPresent: flag("pairingPendingPresent"),
    pairingError: choice("pairingError", [
      "none",
      "credential-required",
      "credential-rejected",
      "session-timeout",
      "request-failed",
      "unknown",
    ]),
  };
}

export function remoteUiPlan(input: string | undefined) {
  const selection = input ?? "core";
  if (selection !== "core" && selection !== "full") throw new Error("Unknown remote UI selection.");
  const full = selection === "full";
  const flows = full
    ? (["success", "failure", "restart-failures", "queued", "manual", "reload"] as const)
    : (["success", "failure", "manual"] as const);
  return {
    selection,
    flows,
    scenes: full
      ? remoteUiScenes
      : remoteUiScenes.filter(
          (scene) =>
            !["wrong-version", "not-back", "queued", "reload-offer", "reload-complete"].includes(
              scene,
            ),
        ),
    pendingCases: full
      ? []
      : ["wrong-version", "real-no-return-deadline", "bounded-parallel", "actual-reload"],
  };
}

export function screenshotName(theme: RemoteUiTheme, scene: RemoteUiScene): string {
  if (!remoteUiThemes.includes(theme) || !remoteUiScenes.includes(scene))
    throw new Error("Unknown screenshot manifest entry.");
  return `${scene}-${theme}.png`;
}

const witnessKeys = [
  "themeMatched",
  "selectedMatched",
  "expectedTextMatched",
  "targetInView",
  "credentialAbsent",
  "bootShellAbsent",
] as const;
export function validateCaptureWitness(input: unknown) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Screenshot witness is unavailable.");
  const row = input as Record<string, unknown>;
  if (
    Object.keys(row).length !== witnessKeys.length ||
    !witnessKeys.every((key) => row[key] === true)
  )
    throw new Error("Screenshot precondition was not satisfied.");
  return Object.fromEntries(witnessKeys.map((key) => [key, true])) as Record<
    (typeof witnessKeys)[number],
    true
  >;
}

/** Parse only the maintained fake-host receipt prefix; never return requester data. */
export function countInstallRequests(text: string): number {
  if (Buffer.byteLength(text) > 65536) throw new Error("Requester receipt exceeded its bound.");
  return text
    .split("\n")
    .slice(0, -1)
    .filter((line) => /^install requested label=[^\r\n]* session=[^\r\n]*$/.test(line)).length;
}

/** Chrome's ordinary non-interlaced RGB/RGBA PNG; unsupported formats fail closed. */
export function inspectScreenshot(bytes: Buffer): {
  width: number;
  height: number;
  nonBlank: true;
  sha256: string;
} {
  const fail = () => {
    throw new Error("Original screenshot is invalid or blank.");
  };
  if (
    bytes.length < 45 ||
    bytes.length > 12 * 1024 ** 2 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return fail();
  let width = 0,
    height = 0,
    channels = 0,
    ended = false;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) return fail();
    const size = bytes.readUInt32BE(offset),
      end = offset + 12 + size;
    if (end > bytes.length) return fail();
    if (NodeZlib.crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      return fail();
    const name = bytes.toString("ascii", offset + 4, offset + 8),
      data = bytes.subarray(offset + 8, end - 4);
    if (name === "IHDR") {
      if (
        width !== 0 ||
        size !== 13 ||
        data[8] !== 8 ||
        ![2, 6].includes(data[9]!) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      )
        return fail();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 2 ? 3 : 4;
      if (
        width < 320 ||
        height < 240 ||
        width > 4096 ||
        height > 4096 ||
        width * height > 8_000_000
      )
        return fail();
    } else if (name === "IDAT") {
      if (width === 0) return fail();
      chunks.push(data);
    } else if (name === "IEND") {
      if (size !== 0 || end !== bytes.length) return fail();
      ended = true;
    }
    offset = end;
  }
  if (!ended || chunks.length === 0) return fail();
  const stride = width * channels,
    expected = (stride + 1) * height;
  const raw = NodeZlib.inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
  if (raw.length !== expected) return fail();
  let previous = Buffer.alloc(stride),
    first: number[] | undefined,
    different = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!,
      row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    if (filter > 4) return fail();
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels]! : 0,
        up = previous[x]!,
        upperLeft = x >= channels ? previous[x - channels]! : 0;
      const p = left + up - upperLeft;
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upperLeft)
          ? left
          : Math.abs(p - up) <= Math.abs(p - upperLeft)
            ? up
            : upperLeft;
      row[x] =
        (row[x]! +
          (filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paeth
                  : 0)) &
        255;
    }
    for (let x = 0; x < stride; x += channels) {
      const alpha = channels === 4 ? row[x + 3]! / 255 : 1;
      const pixel = [0, 1, 2].map((index) =>
        Math.round(row[x + index]! * alpha + 255 * (1 - alpha)),
      );
      first ??= pixel;
      if (pixel.some((value, index) => Math.abs(value - first![index]!) > 8)) different++;
    }
    previous = row;
  }
  if (different < 64) return fail();
  return {
    width,
    height,
    nonBlank: true,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  };
}
