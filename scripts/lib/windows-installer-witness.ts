// @effect-diagnostics nodeBuiltinImport:off - This CI-only helper owns one diagnostic child.
// @effect-diagnostics globalTimers:off - Observer setup and joining have finite QA-only bounds.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const MAX_OUTPUT_BYTES = 65_536;
const MAX_EVENTS = 256;
const MAX_DURATION_MS = 3_600_000;
const READY_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 5_000;
const kinds = [
  "ready",
  "application-start",
  "application-stop",
  "installer-start",
  "installer-stop",
  "stopped",
  "unavailable",
  "limit",
] as const;

export interface WindowsInstallerWitnessEvent {
  readonly kind: (typeof kinds)[number];
  readonly elapsedMs: number;
  readonly parentMatched: boolean | null;
  readonly locationMatched: boolean | null;
  readonly hashMatched: boolean | null;
  readonly exitCode: number | null;
  readonly droppedCount: number;
}

interface DecodedWitness {
  readonly status: "observed" | "unavailable" | "invalid" | "incomplete" | "limited";
  readonly events: ReadonlyArray<WindowsInstallerWitnessEvent>;
}

export interface WindowsInstallerWitnessEvidence {
  readonly status: DecodedWitness["status"] | "cleanup-failed";
  readonly events: ReadonlyArray<WindowsInstallerWitnessEvent>;
  readonly closeVerified: boolean;
}

export interface WindowsInstallerWitnessPort {
  readonly ready: Promise<boolean>;
  readonly stop: () => Promise<{ readonly output: string; readonly closeVerified: boolean }>;
}

const boundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
const nullableBoolean = (value: unknown): value is boolean | null =>
  value === null || typeof value === "boolean";

/** Reject the entire stream before retention when any field is outside the closed protocol. */
export function decodeWindowsInstallerWitness(output: string): DecodedWitness {
  const invalid: DecodedWitness = { status: "invalid", events: [] };
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) return invalid;
  const lines = output
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { status: "unavailable", events: [] };
  if (lines.length > MAX_EVENTS) return invalid;
  const events: WindowsInstallerWitnessEvent[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return invalid;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "droppedCount,elapsedMs,exitCode,hashMatched,kind,locationMatched,parentMatched" ||
      !kinds.some((kind) => record.kind === kind) ||
      !boundedInteger(record.elapsedMs, MAX_DURATION_MS) ||
      !nullableBoolean(record.parentMatched) ||
      !nullableBoolean(record.locationMatched) ||
      !nullableBoolean(record.hashMatched) ||
      !(record.exitCode === null || boundedInteger(record.exitCode, 4_294_967_295)) ||
      !boundedInteger(record.droppedCount, MAX_EVENTS)
    )
      return invalid;
    events.push({
      kind: record.kind as WindowsInstallerWitnessEvent["kind"],
      elapsedMs: record.elapsedMs,
      parentMatched: record.parentMatched,
      locationMatched: record.locationMatched,
      hashMatched: record.hashMatched,
      exitCode: record.exitCode,
      droppedCount: record.droppedCount,
    });
  }
  const status = events.some((event) => event.kind === "unavailable")
    ? "unavailable"
    : events.some((event) => event.kind === "limit")
      ? "limited"
      : events[0]?.kind === "ready" && events.at(-1)?.kind === "stopped"
        ? "observed"
        : "incomplete";
  return { status, events };
}

/** Missing observation never changes the profile verdict; an unjoined observer cannot pass. */
export async function runWithWindowsInstallerWitness<T>(
  input: {
    readonly open: () => Promise<WindowsInstallerWitnessPort>;
    readonly retain: (value: WindowsInstallerWitnessEvidence) => Promise<void>;
  },
  operation: () => Promise<T>,
): Promise<T> {
  let port: WindowsInstallerWitnessPort | undefined;
  let ready = false;
  let result: T | undefined;
  let failed = false;
  let failure: unknown;
  let stopped: Awaited<ReturnType<WindowsInstallerWitnessPort["stop"]>> | undefined;
  try {
    try {
      port = await input.open();
      ready = await port.ready;
      if (!ready) stopped = await port.stop();
    } catch {
      // Setup details are private. The finally path still owns any returned child.
    }
    if (port !== undefined && !ready && stopped?.closeVerified !== true) {
      failed = true;
      failure = new Error("The Windows QA observer did not stop.");
    } else {
      try {
        result = await operation();
      } catch (cause) {
        failed = true;
        failure = cause;
      }
    }
  } finally {
    let closeVerified = port === undefined;
    let decoded: DecodedWitness = { status: "unavailable", events: [] };
    if (port !== undefined) {
      try {
        stopped ??= await port.stop();
        closeVerified = stopped.closeVerified;
        decoded = decodeWindowsInstallerWitness(stopped.output);
        if (!ready && decoded.status !== "invalid") decoded = { status: "unavailable", events: [] };
      } catch {
        closeVerified = false;
      }
    }
    const evidence: WindowsInstallerWitnessEvidence = closeVerified
      ? { ...decoded, closeVerified }
      : { status: "cleanup-failed", events: [], closeVerified: false };
    try {
      await input.retain(evidence);
    } catch {
      if (!failed) {
        failed = true;
        failure = new Error("The Windows QA witness could not be retained.");
      }
    }
    if (!closeVerified && !failed) {
      failed = true;
      failure = new Error("The Windows QA observer did not stop.");
    }
  }
  if (failed) throw failure;
  return result as T;
}

/** Narrow process port allows inert lifecycle tests without executing PowerShell or WMI. */
export interface WindowsWitnessChild {
  readonly pid: () => number | undefined;
  readonly exited: () => boolean;
  readonly output: (receive: (chunk: string) => void) => void;
  readonly closed: (receive: () => void) => void;
  readonly failed: (receive: () => void) => void;
  readonly terminate: () => void;
}

const completesWithin = async (
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export function createWindowsWitnessProcessPort(input: {
  readonly child: WindowsWitnessChild;
  readonly requestStop: () => Promise<void>;
  readonly lifetimeMs: number;
  readonly readyTimeoutMs?: number;
  readonly joinTimeoutMs?: number;
}): WindowsInstallerWitnessPort {
  const ownedPid = input.child.pid();
  let output = "";
  let oversized = false;
  let closeObserved = false;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let resolveReady: ((ready: boolean) => void) | undefined;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  const readyTimer = setTimeout(
    () => resolveReady?.(false),
    input.readyTimeoutMs ?? READY_TIMEOUT_MS,
  );
  const terminateOwned = () => {
    if (
      !closeObserved &&
      !input.child.exited() &&
      ownedPid !== undefined &&
      input.child.pid() === ownedPid
    ) {
      try {
        input.child.terminate();
      } catch {
        /* An unjoined handle remains a cleanup failure. */
      }
    }
  };
  const lifetimeTimer = setTimeout(terminateOwned, input.lifetimeMs);
  input.child.output((chunk) => {
    if (oversized) return;
    if (Buffer.byteLength(output, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_OUTPUT_BYTES) {
      oversized = true;
      output = "";
      resolveReady?.(false);
      terminateOwned();
      return;
    }
    output += chunk;
    const completed = output.slice(0, output.lastIndexOf("\n") + 1);
    const decoded = decodeWindowsInstallerWitness(completed);
    if (decoded.status === "invalid") resolveReady?.(false);
    else if (decoded.events.some((event) => event.kind === "ready")) resolveReady?.(true);
    else if (decoded.events.some((event) => event.kind === "unavailable")) resolveReady?.(false);
  });
  input.child.failed(() => resolveReady?.(false));
  input.child.closed(() => {
    closeObserved = true;
    clearTimeout(readyTimer);
    clearTimeout(lifetimeTimer);
    resolveReady?.(false);
    resolveClosed?.();
  });
  let stop: ReturnType<WindowsInstallerWitnessPort["stop"]> | undefined;
  return {
    ready,
    stop: () => {
      stop ??= (async () => {
        clearTimeout(readyTimer);
        clearTimeout(lifetimeTimer);
        const joinTimeout = input.joinTimeoutMs ?? JOIN_TIMEOUT_MS;
        try {
          if (!(await completesWithin(input.requestStop(), joinTimeout))) terminateOwned();
        } catch {
          terminateOwned();
        }
        if (!(await completesWithin(closed, joinTimeout))) {
          terminateOwned();
          await completesWithin(closed, joinTimeout);
        }
        return {
          output: oversized ? "invalid" : output,
          closeVerified: closeObserved && input.child.pid() === ownedPid,
        };
      })();
      return stop;
    },
  };
}

export async function openWindowsInstallerWitness(input: {
  readonly appBinaryPath: string;
  readonly candidateVersion: string;
  readonly candidateSha256: string;
  readonly productName: string;
  readonly controlRoot: string;
  readonly lifetimeMs: number;
}): Promise<WindowsInstallerWitnessPort> {
  if (
    !boundedInteger(input.lifetimeMs, MAX_DURATION_MS) ||
    input.lifetimeMs === 0 ||
    !/^[a-f\d]{64}$/i.test(input.candidateSha256) ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(input.productName) ||
    !/^[0-9A-Za-z.+-]{1,128}$/.test(input.candidateVersion) ||
    !NodePath.win32.isAbsolute(input.appBinaryPath)
  )
    throw new Error("The Windows QA witness inputs are invalid.");
  const observerScript = await NodeFS.promises.readFile(
    NodeURL.fileURLToPath(new URL("./windows-installer-witness.ps1", import.meta.url)),
    "utf8",
  );
  const controlDirectory = await NodeFS.promises.mkdtemp(
    NodePath.join(input.controlRoot, "windows-witness-"),
  );
  const stopPath = NodePath.join(controlDirectory, "stop");
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", observerScript],
      {
        env: {
          ...process.env,
          BIBCODE_WITNESS_APPLICATION: input.appBinaryPath,
          BIBCODE_WITNESS_PRODUCT: input.productName,
          BIBCODE_WITNESS_VERSION: input.candidateVersion,
          BIBCODE_WITNESS_SHA256: input.candidateSha256,
          BIBCODE_WITNESS_STOP: stopPath,
          BIBCODE_WITNESS_LIFETIME_MS: String(input.lifetimeMs),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      },
    );
  } catch {
    await NodeFS.promises.rm(controlDirectory, { recursive: true, force: true });
    throw new Error("The Windows QA observer could not start.");
  }
  // Native diagnostics may contain private paths; drain without retaining or echoing them.
  child.stderr?.resume();
  const port = createWindowsWitnessProcessPort({
    child: {
      pid: () => child.pid,
      exited: () => child.exitCode !== null || child.signalCode !== null,
      output: (receive) => {
        child.stdout?.on("data", (chunk: Buffer) => receive(chunk.toString("utf8")));
      },
      closed: (receive) => {
        child.once("close", receive);
      },
      failed: (receive) => {
        child.once("error", receive);
      },
      terminate: () => {
        child.kill("SIGTERM");
      },
    },
    requestStop: async () => {
      await NodeFS.promises.writeFile(stopPath, "stop", { flag: "wx", mode: 0o600 });
    },
    lifetimeMs: input.lifetimeMs,
  });
  return {
    ready: port.ready,
    stop: async () => {
      const result = await port.stop();
      if (result.closeVerified)
        await NodeFS.promises.rm(controlDirectory, { recursive: true, force: true });
      return result;
    },
  };
}
