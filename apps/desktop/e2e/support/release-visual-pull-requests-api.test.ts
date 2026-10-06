// @effect-diagnostics nodeBuiltinImport:off - Typed owned WS request/close behavior runs on inert transport ports.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { expect, it, vi } from "vite-plus/test";
const path = "./release-visual-pull-requests-api.ts";
const api = await import(path).catch((error) => {
  if (NodeFS.existsSync(new NodeURL.URL(path, import.meta.url))) throw error;
  return {};
});
const execute = (
  input: unknown,
  run: (api: { getContext: (cwd: string) => Promise<unknown> }) => Promise<unknown>,
) => {
  const method = Reflect.get(api, "withPullRequestsPublicApi");
  return typeof method === "function" ? method(input, run) : Promise.resolve(null);
};
const fixturePath = "../../../web/src/components/pullRequests/testFixtures.ts";
const fixtures = await import(fixturePath);
function probe(mode = "valid") {
  const events = new Map<string, Set<(event: { data?: string }) => void>>();
  const frames: Record<string, unknown>[] = [],
    calls: string[] = [];
  let cleanup = 0;
  const context = {
    ...fixtures.context,
    host: "github.visual.invalid",
    repository: "owned/requests",
    webUrl: "https://github.visual.invalid/owned/requests",
    account: { ...fixtures.context.account, login: "viewer" },
  };
  const socket = {
    readyState: mode === "open-timeout" ? 0 : 1,
    addEventListener: (name: string, callback: (event: { data?: string }) => void) => {
      const set = events.get(name) ?? new Set();
      set.add(callback);
      events.set(name, set);
    },
    removeEventListener: (name: string, callback: (event: { data?: string }) => void) =>
      events.get(name)?.delete(callback),
    send: (text: string) => {
      const request = JSON.parse(text);
      frames.push(request);
      if (request._tag === "Pong") return;
      if (mode === "late") return;
      queueMicrotask(() => {
        if (mode === "close" || mode === "error") {
          for (const callback of events.get(mode) ?? []) callback({});
          return;
        }
        const frame = {
          _tag: "Exit",
          requestId: mode === "foreign-id" ? "foreign" : request.id,
          exit: {
            _tag: mode === "failure" ? "Failure" : "Success",
            value:
              mode === "malformed"
                ? {}
                : mode === "foreign-host"
                  ? { ...context, host: "github.com" }
                  : context,
          },
        };
        for (const callback of events.get("message") ?? [])
          callback({ data: JSON.stringify(frame) });
      });
    },
    close: () => {
      calls.push("close");
      if (mode === "close-failed") return;
      socket.readyState = 3;
      for (const callback of events.get("close") ?? []) callback({});
    },
  };
  const input = {
    CI: "true",
    accessToken: "owned-private-test-token",
    bindings: [
      {
        cwd: "/owned/light/requests/github",
        provider: "github",
        host: "github.visual.invalid",
        repository: "owned/requests",
        account: "viewer",
      },
    ],
    observeCleanupFailure: () => {
      cleanup++;
    },
    ports: {
      fetch: async (url: string, request: RequestInit) => {
        calls.push("ticket");
        expect(url).toBe("http://127.0.0.1:4885/api/auth/websocket-ticket");
        expect(request.method).toBe("POST");
        return {
          ok: true,
          json: async () => ({ ticket: "owned-ticket", expiresAt: "2026-10-06T01:00:00Z" }),
        };
      },
      socket: (url: string) => {
        calls.push("socket");
        expect(new URL(url).origin).toBe("ws://127.0.0.1:4885");
        return socket;
      },
    },
  };
  return {
    input,
    frames,
    calls,
    context,
    cleanup: () => cleanup,
    listenerCount: () => [...events.values()].reduce((count, group) => count + group.size, 0),
  };
}
it("sends only actual typed getContext and returns its decoded bound public context", async () => {
  const p = probe();
  expect(await execute(p.input, (api) => api.getContext("/owned/light/requests/github"))).toEqual(
    p.context,
  );
  expect(p.frames).toEqual([
    {
      _tag: "Request",
      id: "1",
      tag: "pullRequests.getContext",
      payload: { cwd: "/owned/light/requests/github", rescan: false },
      headers: [],
    },
  ]);
  expect(p.calls).toEqual(["ticket", "socket", "close"]);
});
it.each(["not-ci", "foreign-cwd", "foreign-host", "malformed", "failure", "close", "error"])(
  "refuses unavailable/foreign public reads while closing its owned connection: %s",
  async (mode) => {
    const p = probe(mode);
    if (mode === "not-ci") p.input.CI = "false";
    await expect(
      execute(p.input, (api) =>
        api.getContext(mode === "foreign-cwd" ? "/foreign" : "/owned/light/requests/github"),
      ),
    ).rejects.toThrow();
    if (mode === "not-ci") expect(p.calls).toEqual([]);
    else expect(p.calls.at(-1)).toBe("close");
  },
);
it.each(["late", "foreign-id"])(
  "times out an unanswered original request without retrying: %s",
  async (mode) => {
    vi.useFakeTimers();
    try {
      const p = probe(mode);
      const result = execute(p.input, (api) =>
        api.getContext("/owned/light/requests/github"),
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2100);
      expect(await result).toBeInstanceOf(Error);
      expect(p.frames).toHaveLength(1);
      expect(p.calls.at(-1)).toBe("close");
    } finally {
      vi.useRealTimers();
    }
  },
);
it("preserves the original callback error even when the owned close fails logically", async () => {
  vi.useFakeTimers();
  try {
    const p = probe("close-failed"),
      original = new Error("Inert original callback failure");
    const result = execute(p.input, async () => {
      throw original;
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2100);
    expect(await result).toBe(original);
    expect(p.cleanup()).toBe(1);
    expect(p.listenerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it.each(["provider-cwd", "getter", "extra", "array-getter"])(
  "refuses malformed explicit context bindings before any transport: %s",
  async (mode) => {
    const p = probe();
    let getterCalls = 0;
    const binding = p.input.bindings[0]!;
    if (mode === "provider-cwd") binding.cwd = "/owned/light/requests/gitlab";
    if (mode === "getter")
      Object.defineProperty(binding, "host", {
        enumerable: true,
        get: () => {
          getterCalls++;
          return "github.visual.invalid";
        },
      });
    if (mode === "extra")
      Object.defineProperty(binding, "unowned", { enumerable: true, value: true });
    if (mode === "array-getter")
      Object.defineProperty(p.input.bindings, "0", {
        enumerable: true,
        get: () => {
          getterCalls++;
          return binding;
        },
      });
    await expect(execute(p.input, async () => true)).rejects.toThrow(
      "Owned request public API refused.",
    );
    expect(getterCalls).toBe(0);
    expect(p.calls).toEqual([]);
  },
);
it("removes opening listeners after the existing timeout and closes the owned connection without a request", async () => {
  vi.useFakeTimers();
  try {
    const p = probe("open-timeout");
    const outcome = execute(p.input, async () => true).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2100);
    expect(await outcome).toBeInstanceOf(Error);
    expect(p.frames).toHaveLength(0);
    expect(p.calls.at(-1)).toBe("close");
    expect(p.listenerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
