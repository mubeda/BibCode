import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CONNECTION_DATABASE_NAME,
  deleteIncompatibleConnectionDatabase,
  getConnectionDatabaseHealth,
  monitorConnectionDatabaseOpenRequest,
  resetConnectionDatabaseHealthForTest,
  subscribeConnectionDatabaseHealth,
} from "./databaseHealth";

class FakeRequest {
  error: DOMException | null = null;
  private readonly listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

afterEach(() => {
  resetConnectionDatabaseHealthForTest();
  vi.unstubAllGlobals();
});

describe("connection database health", () => {
  it("classifies version conflicts, blocked opens, generic failures, and later success", () => {
    const request = new FakeRequest();
    const snapshots: string[] = [];
    const unsubscribe = subscribeConnectionDatabaseHealth(() => {
      snapshots.push(getConnectionDatabaseHealth().status);
    });
    monitorConnectionDatabaseOpenRequest(request as unknown as IDBOpenDBRequest);

    request.fire("blocked");
    expect(getConnectionDatabaseHealth().status).toBe("blocked");

    request.fire("success");
    expect(getConnectionDatabaseHealth().status).toBe("ready");

    request.error = new DOMException("newer database", "VersionError");
    request.fire("error");
    expect(getConnectionDatabaseHealth().status).toBe("incompatible");

    request.error = new DOMException("permission denied", "UnknownError");
    request.fire("error");
    expect(getConnectionDatabaseHealth()).toMatchObject({ status: "unavailable" });
    expect(snapshots).toEqual(["blocked", "ready", "incompatible", "unavailable"]);
    unsubscribe();
  });

  it("reports blocked deletion without treating it as success", async () => {
    const request = new FakeRequest();
    const deleteDatabase = vi.fn(() => {
      queueMicrotask(() => request.fire("blocked"));
      return request as unknown as IDBOpenDBRequest;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase });

    await expect(deleteIncompatibleConnectionDatabase()).resolves.toBe("blocked");
    expect(deleteDatabase).toHaveBeenCalledWith(CONNECTION_DATABASE_NAME);
  });

  it("publishes ready only after successful deletion", async () => {
    const open = new FakeRequest();
    open.error = new DOMException("newer database", "VersionError");
    monitorConnectionDatabaseOpenRequest(open as unknown as IDBOpenDBRequest);
    open.fire("error");
    const deletion = new FakeRequest();
    vi.stubGlobal("indexedDB", {
      deleteDatabase: () => {
        queueMicrotask(() => deletion.fire("success"));
        return deletion;
      },
    });

    await expect(deleteIncompatibleConnectionDatabase()).resolves.toBe("deleted");
    expect(getConnectionDatabaseHealth().status).toBe("ready");
  });
});
