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
export interface BrowserNetworkProof {
  readonly before: boolean | null;
  readonly after: boolean | null;
  readonly setupRan: boolean;
  readonly elapsedMs: number;
  readonly containment: NetworkContainmentProof | null;
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
  const proof = (): BrowserNetworkProof => ({
    before,
    after,
    setupRan,
    containment,
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
  } catch {
    throw new BrowserConnectivityFailure(proof());
  }
}
