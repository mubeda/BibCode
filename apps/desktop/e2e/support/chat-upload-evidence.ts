// @effect-diagnostics nodeBuiltinImport:off - Retain bounded metadata from owned private qualification logs.
import * as NodeFS from "node:fs";

const systemCodes = new Set([
  "ENOENT",
  "EACCES",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
]);
const signals = new Set([
  "SIGABRT",
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGSEGV",
  "SIGILL",
  "SIGPIPE",
]);
const ownErrors = new Map([
  ["Owned operation exceeded its bound.", "owned-timeout"],
  ["An owned fixture process exited before qualification completed.", "child-exited"],
  ["The required live observation did not arrive within its bound.", "observation-timeout"],
  ["Browser transport observation could not be installed.", "transport-observer-unavailable"],
  ["Owned pairing command returned no credential.", "pairing-command-shape"],
  ["The provider did not receive the exact composer attachment.", "provider-byte-mismatch"],
  ["The actual browser did not exercise staged uploads.", "staged-path-not-observed"],
]);

/** Never retain messages, stack, names, stdout, stderr, request arguments or auth objects. */
export function classifyQualificationFailure(error: unknown) {
  const source =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const message = typeof source.message === "string" ? source.message.slice(0, 4096) : "";
  let kind = ownErrors.get(message) ?? "unclassified";
  if (kind === "unclassified") {
    if (/no such element/i.test(message)) kind = "missing-element";
    else if (/not interactable/i.test(message)) kind = "element-not-interactable";
    else if (/invalid session|session not created/i.test(message))
      kind = "browser-session-unavailable";
    else if (/timeout|timed out/i.test(message)) kind = "timeout";
  }
  return {
    kind,
    systemCode:
      typeof source.code === "string" && systemCodes.has(source.code) ? source.code : null,
    processExitCode:
      typeof source.status === "number" &&
      Number.isInteger(source.status) &&
      source.status >= 0 &&
      source.status <= 255
        ? source.status
        : null,
    signal: typeof source.signal === "string" && signals.has(source.signal) ? source.signal : null,
  };
}

export function projectQualificationProcess(input: {
  role: string;
  exitCode: number | null;
  signal: string | null;
  spawnFailure: ReturnType<typeof classifyQualificationFailure> | null;
  log: string;
}) {
  let logBytes = 0;
  let logBytesScanned = 0;
  let guardRefusals = 0;
  let logReadable = false;
  try {
    const fd = NodeFS.openSync(input.log, "r");
    try {
      logBytes = NodeFS.fstatSync(fd).size;
      const bytes = Buffer.alloc(Math.min(65536, logBytes));
      logBytesScanned = NodeFS.readSync(fd, bytes, 0, bytes.length, logBytes - bytes.length);
      guardRefusals =
        bytes.toString("utf8", 0, logBytesScanned).split("hermetic-test-guard: refused").length - 1;
      logReadable = true;
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    /* Missing log evidence stays explicitly unavailable. */
  }
  return {
    role: ["plain", "noise", "web"].includes(input.role) ? input.role : "unknown",
    exitCode: input.exitCode,
    signal: input.signal !== null && signals.has(input.signal) ? input.signal : null,
    spawnFailure: input.spawnFailure,
    logReadable,
    logBytes,
    logBytesScanned,
    logTruncated: logBytes > logBytesScanned,
    guardRefusals,
  };
}
