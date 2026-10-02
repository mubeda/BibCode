export interface NetworkContainmentProof {
  readonly privateNet: true;
  readonly pidOwnerMatches: true;
  readonly userOwnerMatches: true;
  readonly loopbackOnlyBefore: true;
  readonly linksContained: true;
  readonly routeContained: true;
  readonly interfaceCount: 3;
  readonly elapsedMs: number;
}
const failureStages = [
  "helper-config",
  "helper-process",
  "platform-check",
  "owner-shape",
  "owner-python",
  "owner-helper",
  "owner-host-ip",
  "namespace-host",
  "namespace-net",
  "namespace-pid",
  "namespace-user",
  "namespace-private",
  "ip-executable",
  "before-links-read",
  "before-addresses-read",
  "before-ipv4-routes-read",
  "before-ipv6-routes-read",
  "before-links-check",
  "before-routes-check",
  "before-addresses-check",
  "before-loopback-check",
  "mutation-pair",
  "mutation-address-in",
  "mutation-address-peer",
  "mutation-up-in",
  "mutation-up-peer",
  "mutation-default",
  "after-links-read",
  "after-addresses-read",
  "after-ipv4-routes-read",
  "after-ipv6-routes-read",
  "after-links-check",
  "after-loopback-check",
  "after-ifindex-check",
  "after-peer-relation-check",
  "after-peer-format-check",
  "after-peer-namespace-check",
  "after-indices-check",
  "after-veth-check",
  "after-carrier-check",
  "after-addresses-check",
  "after-default-check",
  "after-routes-check",
  "deadline",
] as const;
export interface NetworkFailureProof {
  readonly stage: (typeof failureStages)[number];
  readonly attemptedMutations: number | null;
  readonly completedMutations: number | null;
  readonly netAdminEffective: boolean | null;
  readonly lastCommand: {
    readonly exitCode: number | null;
    readonly timedOut: boolean | null;
    readonly cancelled: boolean | null;
    readonly reaped: boolean | null;
  } | null;
}
const unknownNetworkFailure: NetworkFailureProof = {
  stage: "helper-process",
  attemptedMutations: null,
  completedMutations: null,
  netAdminEffective: null,
  lastCommand: null,
};
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Contained refusal proof refused.");
  return value as Record<string, unknown>;
}
function nullableBoolean(value: unknown): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new Error("Contained refusal proof refused.");
}
function nullableInt(value: unknown, low: number, high: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high)
    throw new Error("Contained refusal proof refused.");
  return value;
}
/** Copy known fields again at the error boundary; a foreign exception field is never evidence. */
function projectNetworkFailure(value: unknown): NetworkFailureProof {
  const row = object(value);
  if (!failureStages.some((stage) => row.stage === stage))
    throw new Error("Contained refusal proof refused.");
  const attemptedMutations = nullableInt(row.attemptedMutations, 0, 6);
  const completedMutations = nullableInt(row.completedMutations, 0, 6);
  if (
    row.stage === "helper-process"
      ? attemptedMutations !== null || completedMutations !== null
      : attemptedMutations === null ||
        completedMutations === null ||
        completedMutations > attemptedMutations
  )
    throw new Error("Contained refusal proof refused.");
  const status = row.lastCommand === null ? null : object(row.lastCommand);
  return {
    stage: row.stage as NetworkFailureProof["stage"],
    attemptedMutations,
    completedMutations,
    netAdminEffective: nullableBoolean(row.netAdminEffective),
    lastCommand:
      status === null
        ? null
        : {
            exitCode: nullableInt(status.exitCode, -128, 255),
            timedOut: nullableBoolean(status.timedOut),
            cancelled: nullableBoolean(status.cancelled),
            reaped: nullableBoolean(status.reaped),
          },
  };
}
export function parseNetworkFailure(output: string): NetworkFailureProof {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    throw new Error("Contained refusal proof refused.");
  }
  const receipt = object(decoded);
  const failure = object(receipt.failure);
  if (
    Object.keys(receipt).length !== 2 ||
    receipt.refused !== true ||
    Object.keys(failure).length !== 5 ||
    ![
      "stage",
      "attemptedMutations",
      "completedMutations",
      "netAdminEffective",
      "lastCommand",
    ].every((key) => Object.hasOwn(failure, key))
  )
    throw new Error("Contained refusal proof refused.");
  if (failure.lastCommand !== null) {
    const status = object(failure.lastCommand);
    if (
      Object.keys(status).length !== 4 ||
      !["exitCode", "timedOut", "cancelled", "reaped"].every((key) => Object.hasOwn(status, key))
    )
      throw new Error("Contained refusal proof refused.");
  }
  return projectNetworkFailure(failure);
}
export class NetworkSetupFailure extends Error {
  readonly failure: NetworkFailureProof;
  constructor(failure: NetworkFailureProof) {
    super("Contained network helper refused.");
    this.failure = projectNetworkFailure(failure);
  }
}

export interface BrowserNetworkProof {
  readonly before: boolean | null;
  readonly after: boolean | null;
  readonly setupRan: boolean;
  readonly elapsedMs: number;
  readonly containment: NetworkContainmentProof | null;
  readonly setupFailure: NetworkFailureProof | null;
}
export class BrowserConnectivityFailure extends Error {
  readonly proof: BrowserNetworkProof;
  constructor(proof: BrowserNetworkProof) {
    super("Owned browser connectivity qualification failed.");
    this.proof = proof;
  }
}

/** Project the helper's exact closed proof; never retain command output or arbitrary fields. */
export function parseNetworkProof(output: string): NetworkContainmentProof {
  const value: unknown = JSON.parse(output);
  const boolKeys = [
    "privateNet",
    "pidOwnerMatches",
    "userOwnerMatches",
    "loopbackOnlyBefore",
    "linksContained",
    "routeContained",
  ];
  if (typeof value !== "object" || value === null)
    throw new Error("Contained network proof refused.");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 8 ||
    !boolKeys.every((key) => row[key] === true) ||
    row.interfaceCount !== 3 ||
    typeof row.elapsedMs !== "number" ||
    !Number.isInteger(row.elapsedMs) ||
    row.elapsedMs < 0 ||
    row.elapsedMs > 30_000
  )
    throw new Error("Contained network proof refused.");
  return {
    privateNet: true,
    pidOwnerMatches: true,
    userOwnerMatches: true,
    loopbackOnlyBefore: true,
    linksContained: true,
    routeContained: true,
    interfaceCount: 3,
    elapsedMs: row.elapsedMs,
  };
}

/** The joined child callback carries a typed refusal even when its exit is nonzero. */
export function readNetworkCommandResult(failed: boolean, output: string): NetworkContainmentProof {
  if (!failed) return parseNetworkProof(output);
  let failure = unknownNetworkFailure;
  try {
    failure = parseNetworkFailure(output);
  } catch {
    /* Never retain malformed/raw output. */
  }
  throw new NetworkSetupFailure(failure);
}

/** Actual browser observations gate setup and navigation; this never writes browser/app state. */
export async function ensureBrowserOnline(port: {
  readonly readOnline: () => Promise<unknown>;
  readonly setup: () => Promise<NetworkContainmentProof>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<BrowserNetworkProof> {
  const started = port.now();
  let before: boolean | null = null,
    after: boolean | null = null;
  let setupRan = false;
  let containment: NetworkContainmentProof | null = null;
  let setupFailure: NetworkFailureProof | null = null;
  const proof = (): BrowserNetworkProof => ({
    before,
    after,
    setupRan,
    containment,
    setupFailure,
    elapsedMs: Math.max(0, Math.floor(port.now() - started)),
  });
  const observe = async () => {
    const value = await port.readOnline();
    if (typeof value !== "boolean") throw new Error("Browser connectivity observation refused.");
    return value;
  };
  try {
    before = await observe();
    after = before;
    if (before) return proof();
    setupRan = true;
    containment = await port.setup();
    const deadline = port.now() + 10_000;
    while (true) {
      after = await observe();
      if (port.now() > deadline) throw new Error("Browser connectivity observation refused.");
      if (after) return proof();
      const remaining = deadline - port.now();
      if (remaining <= 0) throw new Error("Browser connectivity observation refused.");
      await port.sleep(Math.min(100, remaining));
    }
  } catch (error) {
    if (setupRan && containment === null) {
      setupFailure = projectNetworkFailure(unknownNetworkFailure);
      if (error instanceof NetworkSetupFailure) {
        try {
          setupFailure = projectNetworkFailure(error.failure);
        } catch {
          /* Unknown proof stays closed. */
        }
      }
    }
    throw new BrowserConnectivityFailure(proof());
  }
}
