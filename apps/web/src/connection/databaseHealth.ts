export const CONNECTION_DATABASE_NAME = "bibcode:connection-runtime";
export const CONNECTION_DATABASE_VERSION = 2;

export type ConnectionDatabaseHealthStatus = "ready" | "incompatible" | "blocked" | "unavailable";

export interface ConnectionDatabaseHealth {
  readonly status: ConnectionDatabaseHealthStatus;
  readonly message: string | null;
}

const READY_HEALTH: ConnectionDatabaseHealth = { status: "ready", message: null };
let health: ConnectionDatabaseHealth = READY_HEALTH;
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
  request.addEventListener("blocked", () => {
    publish({
      status: "blocked",
      message: "Another tab or process is holding an older connection database open.",
    });
  });
  request.addEventListener("error", () => {
    const error = request.error;
    if (errorName(error) === "VersionError") {
      publish({
        status: "incompatible",
        message: "This browser has a newer, incompatible BiBCode connection database.",
      });
      return;
    }
    publish({
      status: "unavailable",
      message: `The connection database could not be opened: ${String(error ?? "unknown error")}`,
    });
  });
  request.addEventListener("success", () => publish(READY_HEALTH));
}

export function reportConnectionDatabaseUnavailable(cause: unknown): void {
  publish({
    status: "unavailable",
    message: `The connection database is unavailable: ${String(cause)}`,
  });
}

export function getConnectionDatabaseHealth(): ConnectionDatabaseHealth {
  return health;
}

export function subscribeConnectionDatabaseHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function deleteIncompatibleConnectionDatabase(): Promise<"deleted" | "blocked"> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser context."));
      return;
    }
    let settled = false;
    const request = indexedDB.deleteDatabase(CONNECTION_DATABASE_NAME);
    request.addEventListener("blocked", () => {
      if (settled) return;
      settled = true;
      resolve("blocked");
    });
    request.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("Unknown IndexedDB deletion error."));
    });
    request.addEventListener("success", () => {
      if (settled) return;
      settled = true;
      publish(READY_HEALTH);
      resolve("deleted");
    });
  });
}

/** @internal Test isolation for the renderer-wide external store. */
export function resetConnectionDatabaseHealthForTest(): void {
  publish(READY_HEALTH);
}
