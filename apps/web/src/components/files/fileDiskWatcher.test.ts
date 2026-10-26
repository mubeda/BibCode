import type { ProjectFileVersion } from "@bibcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { type DiskWatchedSession, FileDiskWatcher } from "./fileDiskWatcher";

class FakeTarget {
  visibilityState: DocumentVisibilityState = "visible";
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, set) => count + set.size, 0);
  }
}

function fakeSession(overrides: Partial<DiskWatchedSession> = {}) {
  const requests = new Set<() => void>();
  const session = {
    relativePath: "src/app.ts",
    watchesDisk: true,
    beginDiskCheck: vi.fn(() => 1 as number | null),
    reconcileVersion: vi.fn<DiskWatchedSession["reconcileVersion"]>(() => "settled"),
    reconcileRead: vi.fn(),
    subscribeDiskCheckRequests: (listener: () => void) => {
      requests.add(listener);
      return () => requests.delete(listener);
    },
    request: () => {
      for (const listener of requests) listener();
    },
    requestListenerCount: () => requests.size,
    ...overrides,
  };
  return session;
}

const present: ProjectFileVersion = { _tag: "present", version: "v2" };

describe("FileDiskWatcher", () => {
  let document: FakeTarget;
  let window: FakeTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    document = new FakeTarget();
    window = new FakeTarget();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function startWatcher(session: ReturnType<typeof fakeSession>) {
    const getVersion = vi.fn(async () => present);
    const readFile = vi.fn(async () => ({ version: "v2", contents: "new\n" }));
    const watcher = new FileDiskWatcher({
      session,
      getVersion,
      readFile,
      document: document as unknown as Document,
      window: window as unknown as Window,
    });
    watcher.start();
    return { watcher, getVersion, readFile };
  }

  it("checks at once, then every two seconds only while the window is visible", async () => {
    const session = fakeSession();
    const { getVersion } = startWatcher(session);
    await vi.advanceTimersByTimeAsync(0);
    expect(getVersion).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(getVersion).toHaveBeenCalledTimes(2);

    document.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(6_000);
    expect(getVersion).toHaveBeenCalledTimes(2);

    document.visibilityState = "visible";
    document.dispatch("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(getVersion).toHaveBeenCalledTimes(3);
  });

  it("checks when the window regains focus and when the session asks", async () => {
    const session = fakeSession();
    const { getVersion } = startWatcher(session);
    await vi.advanceTimersByTimeAsync(0);

    window.dispatch("focus");
    await vi.advanceTimersByTimeAsync(0);
    session.request();
    await vi.advanceTimersByTimeAsync(0);

    expect(getVersion).toHaveBeenCalledTimes(3);
  });

  it("reads the file only when the version needs it, and hands the read the same token", async () => {
    const session = fakeSession({
      beginDiskCheck: vi.fn(() => 7),
      reconcileVersion: vi.fn<DiskWatchedSession["reconcileVersion"]>(() => "read"),
    });
    const { readFile } = startWatcher(session);
    await vi.advanceTimersByTimeAsync(0);

    expect(session.reconcileVersion).toHaveBeenCalledWith(7, present);
    expect(readFile).toHaveBeenCalledWith("src/app.ts");
    expect(session.reconcileRead).toHaveBeenCalledWith(7, { version: "v2", contents: "new\n" });
  });

  it("does not ask the server while the session may not reconcile", async () => {
    const session = fakeSession({ beginDiskCheck: vi.fn(() => null) });
    const { getVersion } = startWatcher(session);
    await vi.advanceTimersByTimeAsync(0);
    expect(getVersion).not.toHaveBeenCalled();
  });

  it("never overlaps checks, and runs one more after a request during one", async () => {
    const session = fakeSession();
    let resolveVersion!: (version: ProjectFileVersion) => void;
    const getVersion = vi.fn(
      () => new Promise<ProjectFileVersion>((resolve) => (resolveVersion = resolve)),
    );
    const watcher = new FileDiskWatcher({
      session,
      getVersion,
      readFile: vi.fn(async () => null),
      document: document as unknown as Document,
      window: window as unknown as Window,
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    session.request();
    session.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(getVersion).toHaveBeenCalledOnce();

    resolveVersion(present);
    await vi.advanceTimersByTimeAsync(0);
    expect(getVersion).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it("drops a result for a session renamed during the check", async () => {
    const session = fakeSession();
    const getVersion = vi.fn(async () => {
      session.relativePath = "src/renamed.ts";
      return present;
    });
    const watcher = new FileDiskWatcher({
      session,
      getVersion,
      readFile: vi.fn(async () => null),
      document: document as unknown as Document,
      window: window as unknown as Window,
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.reconcileVersion).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("stops polling and listening when disposed, and never starts for an unversioned file", async () => {
    const session = fakeSession();
    const { watcher, getVersion } = startWatcher(session);
    await vi.advanceTimersByTimeAsync(0);
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getVersion).toHaveBeenCalledOnce();
    expect(document.listenerCount() + window.listenerCount()).toBe(0);
    expect(session.requestListenerCount()).toBe(0);

    const unversioned = fakeSession({ watchesDisk: false });
    const second = startWatcher(unversioned);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(second.getVersion).not.toHaveBeenCalled();
  });
});
