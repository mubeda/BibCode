export const CONNECTION_DATABASE_NAME = "bibcode:connection-runtime";
export const CONNECTION_DATABASE_VERSION = 2;

export type ConnectionDatabaseHealthStatus = "ready" | "incompatible" | "blocked" | "unavailable";

export interface ConnectionDatabaseHealth {
  readonly status: ConnectionDatabaseHealthStatus;
  readonly message: string | null;
  /** The store missed a request deadline. A restart clears it, so a reset is never offered. */
  readonly timedOut?: true;
}

/** How long one connection database request may stay silent before it fails. */
export const CONNECTION_DATABASE_DEADLINE_MS = 10_000;

const READY_HEALTH: ConnectionDatabaseHealth = { status: "ready", message: null };
const DELETION_SETTLE_TIMEOUT_MS = 15_000;
let health: ConnectionDatabaseHealth = READY_HEALTH;
/**
 * Starting a deletion bumps the generation, so open requests that predate it
 * cannot clobber the deletion's status — while every later open publishes
 * normally. A deletion can therefore never permanently mute fault reporting.
 */
let openGeneration = 0;
const listeners = new Set<() => void>();

function publish(next: ConnectionDatabaseHealth): void {
  health = next;
  for (const listener of listeners) listener();
}

function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("name" in error)) return null;
  return typeof error.name === "string" ? error.name : null;
}

export function monitorConnectionDatabaseOpenRequest(request: IDBOpenDBRequest): void {
  const generation = openGeneration;
  const publishOpenHealth = (next: ConnectionDatabaseHealth) => {
    if (generation === openGeneration) publish(next);
  };
  request.addEventListener("blocked", () => {
    publishOpenHealth({
      status: "blocked",
      message: "Another tab or process is holding an older connection database open.",
    });
  });
  request.addEventListener("error", () => {
    const error = request.error;
    if (errorName(error) === "VersionError") {
      publishOpenHealth({
        status: "incompatible",
        message: "This browser cannot open connection data written by a newer BiBCode version.",
      });
      return;
    }
    // This WebKit message is the only IndexedDB API signal for this permanent
    // on-disk condition, and is verbatim in WebKitGTK 2.50 and 2.52.
    if (
      errorName(error) === "UnknownError" &&
      error?.message.includes("Unable to establish IDB database file")
    ) {
      publishOpenHealth({
        status: "incompatible",
        message:
          "This BiBCode build uses an older browser engine than the one that last wrote its connection data, so the connection database cannot be opened.",
      });
      return;
    }
    publishOpenHealth({
      status: "unavailable",
      message: `The connection database could not be opened: ${String(error ?? "unknown error")}`,
    });
  });
  request.addEventListener("success", () => publishOpenHealth(READY_HEALTH));
}

export function reportConnectionDatabaseUnavailable(cause: unknown): void {
  publish({
    status: "unavailable",
    message: `The connection database is unavailable: ${String(cause)}`,
  });
}

/**
 * A request missed its deadline. Open monitors that predate it are muted, so a
 * late success cannot report ready for a store the app already gave up on.
 */
export function reportConnectionDatabaseTimedOut(message: string): void {
  openGeneration += 1;
  publish({ status: "unavailable", message, timedOut: true });
}

export function getConnectionDatabaseHealth(): ConnectionDatabaseHealth {
  return health;
}

export function subscribeConnectionDatabaseHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function deleteIncompatibleConnectionDatabase(): Promise<"deleted"> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser context."));
      return;
    }
    let settled = false;
    let blocked = false;
    // A deletion the browser keeps queued, or never answers, must not leave
    // the caller waiting forever. It settles as a missed deadline, and any
    // event after that changes nothing, because the reset already failed.
    const settleTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const message = blocked
        ? "Deletion stayed blocked by other BiBCode tabs or windows. Close them, then quit BiBCode and open it again."
        : "The local connection store did not answer the request to delete it. Quit BiBCode and open it again.";
      reportConnectionDatabaseTimedOut(message);
      reject(new Error(message));
    }, DELETION_SETTLE_TIMEOUT_MS);
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(settleTimer);
      finish();
    };
    // Invalidate pre-deletion open monitors; later opens publish normally.
    openGeneration += 1;
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(CONNECTION_DATABASE_NAME);
    } catch (cause) {
      settle(() => reject(cause));
      return;
    }
    request.addEventListener("blocked", () => {
      if (settled) return;
      blocked = true;
      publish({
        status: "blocked",
        message:
          "The browser queued connection database deletion until other BiBCode tabs and windows close.",
      });
    });
    request.addEventListener("error", () => {
      settle(() => {
        const error = request.error ?? new Error("Unknown IndexedDB deletion error.");
        publish({
          status: "unavailable",
          message: `The connection database could not be deleted: ${String(error)}`,
        });
        reject(error);
      });
    });
    request.addEventListener("success", () => {
      settle(() => {
        publish(READY_HEALTH);
        resolve("deleted");
      });
    });
  });
}

/** @internal Test isolation for the renderer-wide external store. */
export function resetConnectionDatabaseHealthForTest(): void {
  openGeneration += 1;
  publish(READY_HEALTH);
}
