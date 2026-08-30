export const CONNECTION_DATABASE_NAME = "bibcode:connection-runtime";
export const CONNECTION_DATABASE_VERSION = 2;

export type ConnectionDatabaseHealthStatus = "ready" | "incompatible" | "blocked" | "unavailable";

export interface ConnectionDatabaseHealth {
  readonly status: ConnectionDatabaseHealthStatus;
  readonly message: string | null;
}

const READY_HEALTH: ConnectionDatabaseHealth = { status: "ready", message: null };
let health: ConnectionDatabaseHealth = READY_HEALTH;
let activeDeletionRequest: IDBOpenDBRequest | null = null;
const listeners = new Set<() => void>();

function publish(next: ConnectionDatabaseHealth): void {
  health = next;
  for (const listener of listeners) listener();
}

function publishOpenHealth(next: ConnectionDatabaseHealth): void {
  if (activeDeletionRequest === null) publish(next);
}

function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("name" in error)) return null;
  return typeof error.name === "string" ? error.name : null;
}

export function monitorConnectionDatabaseOpenRequest(request: IDBOpenDBRequest): void {
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
        message: "This browser has a newer, incompatible BiBCode connection database.",
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
  publishOpenHealth({
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

export function deleteIncompatibleConnectionDatabase(): Promise<"deleted"> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser context."));
      return;
    }
    let settled = false;
    const request = indexedDB.deleteDatabase(CONNECTION_DATABASE_NAME);
    activeDeletionRequest = request;
    request.addEventListener("blocked", () => {
      if (activeDeletionRequest !== request) return;
      publish({
        status: "blocked",
        message:
          "The browser queued connection database deletion until other BiBCode tabs and windows close.",
      });
    });
    request.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      const error = request.error ?? new Error("Unknown IndexedDB deletion error.");
      if (activeDeletionRequest === request) {
        activeDeletionRequest = null;
        publish({
          status: "unavailable",
          message: `The connection database could not be deleted: ${String(error)}`,
        });
      }
      reject(error);
    });
    request.addEventListener("success", () => {
      if (settled) return;
      settled = true;
      if (activeDeletionRequest === request) {
        activeDeletionRequest = null;
        publish(READY_HEALTH);
      }
      resolve("deleted");
    });
  });
}

/** @internal Test isolation for the renderer-wide external store. */
export function resetConnectionDatabaseHealthForTest(): void {
  activeDeletionRequest = null;
  publish(READY_HEALTH);
}
