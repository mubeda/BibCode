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
  "ERR_INVALID_URL",
  "EAI_AGAIN",
  "ENETUNREACH",
]);
const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "TimeoutError",
  "WebDriverError",
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

/** Pairing diagnostics describe controls and lifecycle only; never copy input or page text. */
export function projectPairingObservation(input: unknown) {
  const source =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const boolean = (key: string): boolean | null =>
    typeof source[key] === "boolean" ? source[key] : null;
  const count = (key: string): number | null => {
    const value = source[key];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 20000
      ? value
      : null;
  };
  return {
    route:
      typeof source.route === "string" &&
      ["pair", "root", "local-project", "other"].includes(source.route)
        ? source.route
        : null,
    readyState:
      typeof source.readyState === "string" &&
      ["loading", "interactive", "complete"].includes(source.readyState)
        ? source.readyState
        : null,
    tokenInputPresent: boolean("tokenInputPresent"),
    tokenInputDisabled: boolean("tokenInputDisabled"),
    submitPresent: boolean("submitPresent"),
    submitDisabled: boolean("submitDisabled"),
    errorNoticePresent: boolean("errorNoticePresent"),
    pendingHeadingPresent: boolean("pendingHeadingPresent"),
    sidebarPresent: boolean("sidebarPresent"),
    observerPresent: boolean("observerPresent"),
    plainSocketCreated: count("plainSocketCreated"),
    plainSocketOpened: count("plainSocketOpened"),
  };
}

/** A pre-pair screenshot is allowed only before any attempted credential entry. */
export function mayCaptureQualificationFailure(input: {
  readonly phase: string;
  readonly credentialEntryAttempted: boolean;
  readonly pairingCompleted: boolean;
  readonly screenSafe: boolean;
}): boolean {
  return (
    input.screenSafe === true &&
    (input.pairingCompleted === true ||
      (input.phase === "pair-wait-token" && input.credentialEntryAttempted === false))
  );
}

/** Never retain messages, stack, names, stdout, stderr, request arguments or auth objects. */
export function classifyQualificationFailure(error: unknown) {
  const source =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const message = typeof source.message === "string" ? source.message.slice(0, 4096) : "";
  let kind = ownErrors.get(message) ?? "unclassified";
  if (kind === "unclassified") {
    if (/no such element|element.*(?:wasn.t found|not found)/i.test(message))
      kind = "missing-element";
    else if (/click intercepted|other element would receive/i.test(message))
      kind = "click-intercepted";
    else if (/stale element/i.test(message)) kind = "stale-element";
    else if (/not interactable/i.test(message)) kind = "element-not-interactable";
    else if (/invalid session|session not created/i.test(message))
      kind = "browser-session-unavailable";
    else if (/timeout|timed out|still not displayed after/i.test(message)) kind = "timeout";
  }
  return {
    kind,
    errorClass: typeof source.name === "string" && errorNames.has(source.name) ? source.name : null,
    launchMarkers: {
      sandbox: /sandbox|zygote|namespace|running as root/i.test(message),
      endpoint: /invalid url|parse url|failed to fetch|connect|socket hang up/i.test(message),
      origin: /allowed.?ips|allowed.?origins|origin|not allowed/i.test(message),
      driver: /chromedriver|driver process|driver exited/i.test(message),
      capabilities: /capabilit|invalid argument|session not created/i.test(message),
      browserVersion: /chrome version|browser version/i.test(message),
    },
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
    role: ["plain", "noise", "web", "driver"].includes(input.role) ? input.role : "unknown",
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
