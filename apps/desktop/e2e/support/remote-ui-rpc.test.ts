import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import { fixtureRpcBrowserRequest, fixtureRpcTicket } from "./remote-ui-rpc.ts";

it("refuses non-owned endpoints and never requests an install method", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw new Error("must not fetch");
  };
  for (const endpoint of [
    "http://127.0.0.1:3773",
    "https://outside.invalid",
    "http://user:secret@127.0.0.1:4888",
    "http://127.0.0.1:4888/private",
  ]) {
    await expect(fixtureRpcTicket(endpoint, "owned-grant", fetcher)).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

it("exchanges a real fixture grant through the maintained public auth paths", async () => {
  const seen: string[] = [];
  const ticket = await fixtureRpcTicket(
    "http://127.0.0.1:4888",
    "owned-grant",
    async (input, init) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      if (url.pathname === "/oauth/token") {
        expect(new URLSearchParams(String(init?.body)).get("subject_token")).toBe("owned-grant");
        return new Response(JSON.stringify({ access_token: "owned-bearer" }));
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owned-bearer");
      return new Response(JSON.stringify({ ticket: "owned-ticket" }));
    },
  );
  expect(seen).toEqual(["/oauth/token", "/api/auth/websocket-ticket"]);
  expect(new URL(ticket).searchParams.get("wsTicket")).toBe("owned-ticket");
});

async function replay(
  method: string,
  failure = false,
  value: unknown = { status: "running", pid: 123, cwd: "private-path", history: "private-secret" },
) {
  const sent: unknown[] = [],
    sockets: Array<{ closed: boolean }> = [];
  class Socket {
    closed = false;
    listeners = new Map<string, (event: unknown) => void>();
    constructor(_url: string) {
      sockets.push(this);
      queueMicrotask(() => this.listeners.get("open")?.({}));
    }
    addEventListener(name: string, listener: (event: unknown) => void) {
      this.listeners.set(name, listener);
    }
    send(text: string) {
      sent.push(JSON.parse(text));
      queueMicrotask(() =>
        this.listeners.get("message")?.({
          data: JSON.stringify({
            _tag: "Exit",
            requestId: "1",
            exit: failure
              ? { _tag: "Failure", cause: "private-secret" }
              : {
                  _tag: "Success",
                  value,
                },
          }),
        }),
      );
    }
    close() {
      this.closed = true;
      queueMicrotask(() => this.listeners.get("close")?.({}));
    }
  }
  const callback = NodeVM.runInNewContext(`(${fixtureRpcBrowserRequest.toString()})`, {
    WebSocket: Socket,
    setTimeout,
    clearTimeout,
    URL,
  });
  const receipt = await new Promise((resolve) =>
    callback(
      {
        socketUrl: "ws://127.0.0.1:4888/ws?wsTicket=owned",
        method,
        payload: { threadId: "owned", terminalId: "term-owned" },
      },
      resolve,
    ),
  );
  return { receipt, sent, sockets };
}

it("sends the public terminal request, waits for socket close and projects away private fields", async () => {
  const result = await replay("terminal.open");
  expect(result.sent).toMatchObject([
    { _tag: "Request", tag: "terminal.open", payload: { threadId: "owned" } },
  ]);
  expect(result.receipt).toEqual({ ok: true, running: true, pid: 123 });
  expect(result.sockets.every((socket) => socket.closed)).toBe(true);
  expect(JSON.stringify(result.receipt)).not.toMatch(/private|secret|wsTicket/);
});

it("projects actual close and active-work replies without retaining extra fields", async () => {
  expect((await replay("terminal.close", false, null)).receipt).toEqual({ ok: true, closed: true });
  expect(
    (
      await replay("updater.activeWork", false, {
        runningTurns: 0,
        liveTerminals: 1,
        credential: "private-secret",
      })
    ).receipt,
  ).toEqual({ ok: true, runningTurns: 0, liveTerminals: 1 });
  expect(
    (await replay("updater.activeWork", false, { runningTurns: -1, liveTerminals: "1" })).receipt,
  ).toEqual({ ok: true, runningTurns: null, liveTerminals: null });
});

it("never dispatches a late open after the request deadline and completes only after close", () => {
  const timers = new Map<number, () => void>();
  const listeners = new Map<string, (event: unknown) => void>();
  const receipts: unknown[] = [];
  let next = 0,
    sends = 0,
    closes = 0;
  class Socket {
    addEventListener(name: string, listener: (event: unknown) => void) {
      listeners.set(name, listener);
    }
    send() {
      sends++;
    }
    close() {
      closes++;
    }
  }
  const callback = NodeVM.runInNewContext(`(${fixtureRpcBrowserRequest.toString()})`, {
    WebSocket: Socket,
    URL,
    setTimeout: (callback: () => void) => {
      timers.set(++next, callback);
      return next;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  callback(
    { socketUrl: "ws://127.0.0.1:4888/ws?wsTicket=owned", method: "terminal.open", payload: {} },
    (value: unknown) => receipts.push(value),
  );
  timers.get(1)!();
  expect(closes).toBe(1);
  expect(receipts).toEqual([]);
  listeners.get("open")!({});
  expect(sends).toBe(0);
  listeners.get("close")!({});
  listeners.get("message")!({
    data: JSON.stringify({
      _tag: "Exit",
      requestId: "1",
      exit: { _tag: "Success", value: { pid: 123, status: "running" } },
    }),
  });
  expect(receipts).toEqual([{ ok: false, reason: "rpc-timeout" }]);
});

it("refuses unexpected methods and retains only a closed failure on RPC rejection", async () => {
  const refused = await replay("updater.install");
  expect(refused.sent).toEqual([]);
  expect(refused.sockets).toEqual([]);
  expect(refused.receipt).toEqual({ ok: false, reason: "method-refused" });
  const failed = await replay("terminal.open", true);
  expect(failed.receipt).toEqual({ ok: false, reason: "rpc-rejected" });
  expect(failed.sockets.every((socket) => socket.closed)).toBe(true);
});
