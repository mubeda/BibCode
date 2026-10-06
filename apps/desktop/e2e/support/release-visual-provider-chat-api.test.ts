// @effect-diagnostics nodeBuiltinImport:off - Actual public transport code with inert fetch/socket ports only.
import * as Api from "./release-visual-provider-chat-api.ts";
import { expect, it, vi } from "vite-plus/test";

const execute = Api as unknown as {
  withProviderChatPublicApi: <A>(
    input: object,
    run: (api: {
      createAssetUrl: (threadId: string) => Promise<unknown>;
      replayEvents: (sequence: number) => Promise<unknown>;
    }) => Promise<A>,
  ) => Promise<A>;
};
function fixture(mode = "valid") {
  const handlers = new Map<string, Array<(event: { data?: string }) => void>>();
  const requests: Array<Record<string, unknown>> = [];
  let fetches = 0,
    sockets = 0,
    closed = 0,
    pongs = 0;
  const socket = {
    readyState: 1,
    addEventListener: (name: string, callback: (event: { data?: string }) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), callback]);
    },
    removeEventListener: () => {},
    send: (text: string) => {
      const request = JSON.parse(text);
      if (request._tag === "Pong") {
        pongs++;
        return;
      }
      requests.push(request);
      if (mode === "late") return;
      const value =
        request.tag === "assets.createUrl"
          ? {
              relativeUrl:
                mode === "foreign-asset"
                  ? "https://example.test/private"
                  : "/api/assets/owned-token/visual-swatch.png",
              expiresAt: 9000000000000,
            }
          : { events: [], exhausted: true };
      const frame = {
        _tag: "Exit",
        requestId: request.id,
        exit: { _tag: "Success", value: mode === "malformed" ? {} : value },
      };
      queueMicrotask(() => {
        if (mode === "control")
          for (const callback of handlers.get("message") ?? []) {
            callback({ data: JSON.stringify({ _tag: "Pong" }) });
            callback({ data: JSON.stringify({ ...frame, requestId: "foreign-request" }) });
          }
        for (const callback of handlers.get("message") ?? [])
          callback({ data: JSON.stringify(frame) });
      });
    },
    close: () => {
      closed++;
      if (mode === "close-failed") return;
      socket.readyState = 3;
      for (const callback of handlers.get("close") ?? []) callback({});
    },
  };
  const input = {
    CI: "true",
    accessToken: "owned-private-access-token",
    ports: {
      fetch: async (url: string, init: RequestInit) => {
        fetches++;
        expect(url).toBe("http://127.0.0.1:4885/api/auth/websocket-ticket");
        expect(new Headers(init.headers).get("authorization")).toBe(
          "Bearer owned-private-access-token",
        );
        return {
          ok: true,
          json: async () => ({
            ticket: "owned-private-ticket",
            expiresAt: "2030-01-01T00:00:00.000Z",
          }),
        };
      },
      socket: (url: string) => {
        sockets++;
        const endpoint = new URL(url);
        expect(endpoint.origin).toBe("ws://127.0.0.1:4885");
        expect(endpoint.pathname).toBe("/ws");
        expect(endpoint.searchParams.get("wsTicket")).toBe("owned-private-ticket");
        return socket;
      },
    },
    observeCleanupFailure: vi.fn(),
  };
  return { input, requests, result: () => ({ fetches, sockets, closed }), pongs: () => pongs };
}

it("uses fixed authenticated public methods with actual contract decoding and closes its socket", async () => {
  expect(execute.withProviderChatPublicApi).toBeTypeOf("function");
  const f = fixture();
  const result = await execute.withProviderChatPublicApi(f.input, async (api) => {
    const asset = await api.createAssetUrl("owned-thread");
    expect(asset).toMatchObject({ relativeUrl: "/api/assets/owned-token/visual-swatch.png" });
    expect(await api.replayEvents(17)).toEqual([]);
    return "closed";
  });
  expect(result).toBe("closed");
  expect(f.requests.map((row) => ({ tag: row.tag, payload: row.payload }))).toEqual([
    {
      tag: "assets.createUrl",
      payload: {
        resource: { _tag: "workspace-file", threadId: "owned-thread", path: "visual-swatch.png" },
      },
    },
    { tag: "orchestration.replayEvents", payload: { fromSequenceExclusive: 17, paged: true } },
  ]);
  expect(f.result()).toEqual({ fetches: 1, sockets: 1, closed: 1 });
});

it("ignores the server protocol Pong and a foreign response without losing the original request", async () => {
  const f = fixture("control");
  await execute.withProviderChatPublicApi(f.input, (api) => api.createAssetUrl("owned-thread"));
  expect(f.pongs()).toBe(0);
  expect(f.requests).toHaveLength(1);
  expect(f.result().closed).toBe(1);
});

it.each(["malformed", "foreign-asset"])(
  "refuses malformed or foreign asset data and still closes: %s",
  async (mode) => {
    expect(execute.withProviderChatPublicApi).toBeTypeOf("function");
    const f = fixture(mode);
    await expect(
      execute.withProviderChatPublicApi(f.input, (api) => api.createAssetUrl("owned-thread")),
    ).rejects.toThrow();
    expect(f.result().closed).toBe(1);
  },
);

it("refuses outside CI before all public ports", async () => {
  expect(execute.withProviderChatPublicApi).toBeTypeOf("function");
  const f = fixture();
  await expect(
    execute.withProviderChatPublicApi({ ...f.input, CI: "false" }, async () => {}),
  ).rejects.toThrow("Owned provider public API refused.");
  expect(f.result()).toEqual({ fetches: 0, sockets: 0, closed: 0 });
});

it.each(["late", "close-failed"])(
  "preserves an original failure while late/failed owned transport cleanup stays closed: %s",
  async (mode) => {
    expect(execute.withProviderChatPublicApi).toBeTypeOf("function");
    const f = fixture(mode);
    vi.useFakeTimers();
    const original = new Error("Inert original capture refusal.");
    try {
      const result = execute.withProviderChatPublicApi(f.input, async (api) => {
        if (mode === "late") await api.createAssetUrl("owned-thread");
        throw original;
      });
      const failure =
        mode === "late" ? expect(result).rejects.toThrow() : expect(result).rejects.toBe(original);
      await vi.advanceTimersByTimeAsync(4_001);
      await failure;
      expect(f.result().closed).toBe(1);
      expect(f.input.observeCleanupFailure).toHaveBeenCalledTimes(mode === "close-failed" ? 1 : 0);
    } finally {
      vi.useRealTimers();
    }
  },
);
