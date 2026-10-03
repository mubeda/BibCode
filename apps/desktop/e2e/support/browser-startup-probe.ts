export type QualificationMode =
  | "upload-smoke"
  | "startup-only"
  | "upload-matrix"
  | "remaining-qualification";

export function parseQualificationMode(value: unknown): QualificationMode {
  if (value === undefined || value === "upload-smoke") return "upload-smoke";
  if (value === "startup-only" || value === "upload-matrix" || value === "remaining-qualification")
    return value;
  throw new Error("The qualification mode is invalid.");
}

const types = [
  "document",
  "stylesheet",
  "image",
  "font",
  "script",
  "xhr",
  "fetch",
  "websocket",
  "other",
  "unknown",
] as const;
const errors = [
  "network-changed",
  "disconnected",
  "connection",
  "dns",
  "timeout",
  "aborted",
  "blocked",
  "failed",
  "unknown",
] as const;
const maximumEntries = 4096;
const typeMap: Readonly<Record<string, (typeof types)[number]>> = {
  Document: "document",
  Stylesheet: "stylesheet",
  Image: "image",
  Font: "font",
  Script: "script",
  XHR: "xhr",
  Fetch: "fetch",
  WebSocket: "websocket",
  Other: "other",
};
const errorMap: Readonly<Record<string, (typeof errors)[number]>> = {
  "net::ERR_NETWORK_CHANGED": "network-changed",
  "net::ERR_INTERNET_DISCONNECTED": "disconnected",
  "net::ERR_CONNECTION_REFUSED": "connection",
  "net::ERR_CONNECTION_RESET": "connection",
  "net::ERR_CONNECTION_CLOSED": "connection",
  "net::ERR_CONNECTION_FAILED": "connection",
  "net::ERR_NAME_NOT_RESOLVED": "dns",
  "net::ERR_TIMED_OUT": "timeout",
  "net::ERR_CONNECTION_TIMED_OUT": "timeout",
  "net::ERR_ABORTED": "aborted",
  "net::ERR_BLOCKED_BY_CLIENT": "blocked",
  "net::ERR_BLOCKED_BY_RESPONSE": "blocked",
  "net::ERR_FAILED": "failed",
};

function row(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Native performance records are transient input; only this closed projection can be retained. */
export function projectStartupNetworkLogs(input: unknown) {
  const available = Array.isArray(input);
  const typeCounts = Object.fromEntries(types.map((type) => [type, 0])) as Record<
    (typeof types)[number],
    number
  >;
  const errorCounts = Object.fromEntries(errors.map((error) => [error, 0])) as Record<
    (typeof errors)[number],
    number
  >;
  let malformed = 0,
    failures = 0,
    canceled = 0;
  if (available)
    for (const entry of input.slice(0, maximumEntries)) {
      try {
        const message = row(entry).message;
        if (typeof message !== "string" || message.length > 16_384) {
          malformed++;
          continue;
        }
        const envelope: unknown = JSON.parse(message);
        if (
          !isRecord(envelope) ||
          !isRecord(envelope.message) ||
          typeof envelope.message.method !== "string" ||
          envelope.message.method.trim().length === 0
        ) {
          malformed++;
          continue;
        }
        const event = envelope.message;
        if (event.method !== "Network.loadingFailed") continue;
        failures++;
        const params = row(event.params);
        const type =
          typeof params.type === "string" && Object.hasOwn(typeMap, params.type)
            ? typeMap[params.type]!
            : "unknown";
        const error =
          typeof params.errorText === "string" && Object.hasOwn(errorMap, params.errorText)
            ? errorMap[params.errorText]!
            : "unknown";
        typeCounts[type]++;
        errorCounts[error]++;
        if (params.canceled === true) canceled++;
      } catch {
        malformed++;
      }
    }
  return {
    available,
    truncated: available ? input.length > maximumEntries || malformed > 0 : null,
    entries: available ? Math.min(input.length, maximumEntries) : null,
    malformed: available ? malformed : null,
    failures: available ? failures : null,
    canceled: available ? canceled : null,
    types: available ? typeCounts : null,
    errors: available ? errorCounts : null,
  };
}

/** No credential, project or upload port exists in this startup-only operation. */
export async function runCredentialFreeStartupProbe(port: {
  readonly readPerformanceLogs: () => Promise<unknown>;
  readonly navigate: () => Promise<void>;
  readonly waitForPairingControl: () => Promise<void>;
}) {
  let reachedPairingControl = false;
  try {
    // Classic getLogs resets its buffer. Discard launch/network-setup records before navigation.
    const before = await port.readPerformanceLogs();
    if (!Array.isArray(before))
      return { reachedPairingControl, network: projectStartupNetworkLogs(null) };
  } catch {
    return { reachedPairingControl, network: projectStartupNetworkLogs(null) };
  }
  try {
    await port.navigate();
    await port.waitForPairingControl();
    reachedPairingControl = true;
  } catch {
    /* A failed readiness observation never becomes an authentication attempt. */
  }
  let network: ReturnType<typeof projectStartupNetworkLogs>;
  try {
    network = projectStartupNetworkLogs(await port.readPerformanceLogs());
  } catch {
    network = projectStartupNetworkLogs(null);
  }
  return { reachedPairingControl, network };
}
