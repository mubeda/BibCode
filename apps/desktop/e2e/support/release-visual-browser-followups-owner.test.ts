import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  withBrowserFollowupResource,
  withBrowserFollowupWindow,
  withBrowserFollowupHostedEntry,
} from "./release-visual-browser-followups-owner.ts";
import {
  startBrowserFollowupTransport,
  startBrowserFollowupNetwork,
} from "./release-visual-browser-followups-network.ts";
import type { QualificationBrowser } from "./qualification-owner.ts";
const netPorts = vi.hoisted(() => ({
  servers: [] as Array<{
    port: number;
    calls: number;
    callback: ((error?: Error | null) => void) | null;
  }>,
  failures: new Map<number, Error>(),
  throws: new Set<number>(),
  pending: new Set<number>(),
}));
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: () => {
      const index = netPorts.servers.length,
        record = { port: 0, calls: 0, callback: null as ((error?: Error | null) => void) | null };
      netPorts.servers.push(record);
      return {
        once: () => {},
        removeListener: () => {},
        listen: (port: number, _host: string, callback: () => void) => {
          record.port = port;
          callback();
        },
        address: () => ({ port: record.port }),
        close: (callback: (error?: Error | null) => void) => {
          record.calls++;
          record.callback = callback;
          if (netPorts.throws.has(index)) throw netPorts.failures.get(index);
          if (!netPorts.pending.has(index)) callback(netPorts.failures.get(index));
        },
      };
    },
    connect: () => {
      throw new Error("Unexpected inert socket connection");
    },
  };
});
beforeEach(() => {
  netPorts.servers.length = 0;
  netPorts.failures.clear();
  netPorts.throws.clear();
  netPorts.pending.clear();
});
it("retains the same failed transport close promise and joins observer teardown despite server refusal", async () => {
  const original = new Error("Inert server close refusal");
  netPorts.failures.set(0, original);
  let observerClosed = 0;
  const transport = await startBrowserFollowupTransport({
    CI: "true",
    listenPort: 4894,
    targetPort: 4897,
    observer: {
      close: () => {
        observerClosed++;
      },
    } as never,
  });
  const first = transport.close(),
    second = transport.close();
  await expect(first).rejects.toBe(original);
  await expect(second).rejects.toBe(original);
  expect(second).toBe(first);
  expect(netPorts.servers[0]!.calls).toBe(1);
  expect(observerClosed).toBe(1);
  expect(transport.observation()).toMatchObject({
    closed: true,
    failed: true,
    cleanupComplete: false,
    cleanupFailed: true,
  });
});
it("joins one pending transport teardown before declaring cleanup complete", async () => {
  netPorts.pending.add(0);
  let observerClosed = 0;
  const transport = await startBrowserFollowupTransport({
    CI: "true",
    listenPort: 4894,
    targetPort: 4897,
    observer: {
      close: () => {
        observerClosed++;
      },
    } as never,
  });
  const first = transport.close(),
    second = transport.close();
  expect(transport.observation()).toMatchObject({
    closed: true,
    cleanupComplete: false,
    cleanupFailed: false,
  });
  expect(second).toBe(first);
  expect(netPorts.servers[0]!.calls).toBe(1);
  expect(observerClosed).toBe(0);
  netPorts.servers[0]!.callback!(null);
  await first;
  await second;
  expect(observerClosed).toBe(1);
  expect(transport.observation()).toMatchObject({ cleanupComplete: true, cleanupFailed: false });
});
it("keeps the first server failure when observer teardown also refuses and never reports a completed cleanup", async () => {
  const original = new Error("Inert first close refusal"),
    later = new Error("Inert observer refusal");
  netPorts.failures.set(0, original);
  let observerAttempts = 0;
  const transport = await startBrowserFollowupTransport({
    CI: "true",
    listenPort: 4894,
    targetPort: 4897,
    observer: {
      close: () => {
        observerAttempts++;
        throw later;
      },
    } as never,
  });
  await expect(transport.close()).rejects.toBe(original);
  await expect(transport.close()).rejects.toBe(original);
  expect(observerAttempts).toBe(1);
  expect(transport.observation()).toMatchObject({
    cleanupComplete: false,
    cleanupFailed: true,
    failed: true,
  });
});
it("preserves the original outer network cleanup failure and reports unsafe once across repeated close calls", async () => {
  const original = new Error("Inert public proxy refusal");
  netPorts.failures.set(1, original);
  netPorts.throws.add(1);
  let unsafe = 0;
  const network = await startBrowserFollowupNetwork({
    CI: "true",
    listenPort: 4887,
    targetPort: 4897,
    png: Buffer.alloc(0),
    cwd: "/owned",
    threadId: "owned-thread",
    terminalId: "term-1",
    patch: () => "",
    observeUnsafeCleanup: () => {
      unsafe++;
    },
  });
  const first = network.close(),
    second = network.close();
  await expect(first).rejects.toBe(original);
  await expect(second).rejects.toBe(original);
  expect(second).toBe(first);
  expect(unsafe).toBe(1);
  expect(netPorts.servers.map((value) => value.calls)).toEqual([1, 1]);
});
it("revokes the owned unsubmitted hosted grant even when build admission fails", async () => {
  const original = new Error("Inert hosted source failure");
  let revoked = 0;
  await expect(
    withBrowserFollowupHostedEntry(
      {
        mode: "confirm",
        theme: "dark",
        browser: {} as QualificationBrowser,
        owner: { until: async () => {} },
        token: "owned-unused-token",
        verifyHostedBuild: async () => {
          throw original;
        },
        verifyOwnedUnsubmittedLink: async () => {},
        revokeOwnedUnsubmittedLink: async () => {
          revoked++;
        },
        observeUnsafeCleanup: () => {},
      },
      async () => {},
    ),
  ).rejects.toBe(original);
  expect(revoked).toBe(1);
});
it("retains the original failure while joining and reporting unsafe cleanup", async () => {
  const original = new Error("Inert original failure");
  let cleanup = 0,
    unsafe = 0;
  await expect(
    withBrowserFollowupResource({
      run: async () => {
        throw original;
      },
      cleanup: async () => {
        cleanup++;
        throw new Error("Inert cleanup failure");
      },
      observeUnsafeCleanup: () => unsafe++,
    }),
  ).rejects.toBe(original);
  expect(cleanup).toBe(1);
  expect(unsafe).toBe(1);
});
it("closes only the newly owned window after capture failure and restores the original handle", async () => {
  const handles = ["original"];
  let current = "original";
  const closed: string[] = [];
  const browser = {
    getWindowHandles: async () => [...handles],
    getWindowHandle: async () => current,
    newWindow: async () => {
      handles.push("created");
      current = "created";
      return { handle: "created" };
    },
    switchToWindow: async (handle: string) => {
      current = handle;
    },
    closeWindow: async () => {
      closed.push(current);
      handles.splice(handles.indexOf(current), 1);
    },
  } as unknown as QualificationBrowser;
  const original = new Error("Inert capture failure");
  await expect(
    withBrowserFollowupWindow(
      {
        browser,
        entry: "http://127.0.0.1:4885/local/owned-thread",
        observeUnsafeCleanup: () => {},
      },
      async () => {
        throw original;
      },
    ),
  ).rejects.toBe(original);
  expect(closed).toEqual(["created"]);
  expect(handles).toEqual(["original"]);
  expect(current).toBe("original");
});
it("refuses the real network adapter outside CI before opening any socket", async () => {
  await expect(
    startBrowserFollowupNetwork({
      CI: undefined,
      listenPort: 4887,
      targetPort: 4897,
      png: Buffer.alloc(0),
      cwd: "/owned",
      threadId: "owned-thread",
      terminalId: "term-1",
      patch: () => "",
      observeUnsafeCleanup: () => {},
    }),
  ).rejects.toThrow();
  await expect(
    startBrowserFollowupTransport({
      CI: undefined,
      listenPort: 4894,
      targetPort: 4887,
      observer: {} as never,
    }),
  ).rejects.toThrow();
});
