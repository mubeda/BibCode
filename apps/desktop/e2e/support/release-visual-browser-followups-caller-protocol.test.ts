import { projectBrowserTerminalGuard } from "./release-visual-browser-followups-source.ts";
import { it, expect, vi, afterEach } from "vite-plus/test";
import { createSizedPng } from "./chat-upload-fixture.ts";
import {
  pinBrowserFollowupTerminalReplay,
  createBrowserFollowupReplayObserver,
  readBrowserFollowupTerminalBaseline,
  readBrowserFollowupTerminalMetadata,
} from "./release-visual-browser-followups-caller-protocol.ts";
afterEach(() => vi.unstubAllGlobals());
it.each(["owned", "rejected", "send-failure"])(
  "joins the actual public baseline stream without creation or claim parameters: %s",
  async (mode) => {
    const requests: object[] = [];
    let closed = false;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ ticket: "inert-ticket", expiresAt: "2030-10-06T00:00:00.000Z" }),
          { status: 200 },
        ),
    );
    class Socket extends EventTarget {
      constructor(_url: URL) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(value: string) {
        const request = JSON.parse(value);
        requests.push(request);
        if (mode === "send-failure") throw new Error("inert send failure");
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify(
                mode === "rejected"
                  ? { _tag: "Exit", requestId: "1", exit: { _tag: "Failure" } }
                  : {
                      _tag: "Chunk",
                      requestId: "1",
                      values: [{ type: "snapshot", snapshot: baseline }],
                    },
              ),
            }),
          ),
        );
      }
      close() {
        closed = true;
        queueMicrotask(() => this.dispatchEvent(new Event("close")));
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    const pending = readBrowserFollowupTerminalBaseline({
      accessToken: "inert-access",
      threadId: "inert-thread",
      terminalId: "inert-terminal",
      cwd: "/inert/worktree",
    });
    if (mode === "owned") expect((await pending).pid).toBe(123);
    else await expect(pending).rejects.toThrow();
    expect(closed).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tag: "terminal.attach",
      payload: {
        threadId: "inert-thread",
        terminalId: "inert-terminal",
        restartIfNotRunning: false,
      },
    });
    const payload = (requests[0] as { payload: object }).payload;
    expect(Object.keys(payload).sort()).toEqual(["restartIfNotRunning", "terminalId", "threadId"]);
  },
);
const patch =
  "diff --git a/pierre-step5.ts b/pierre-step5.ts\n--- a/pierre-step5.ts\n+++ b/pierre-step5.ts\n@@ -1 +1 @@\n-original one\n+changed one\n";
const baseline = {
  threadId: "inert-thread",
  terminalId: "inert-terminal",
  cwd: "/inert/worktree",
  worktreePath: "/inert/worktree",
  status: "running",
  pid: 123,
  history: "inert command\r\nOwned shared terminal output\r\n",
  exitCode: null,
  exitSignal: null,
  label: "Terminal 1",
  updatedAt: "2026-10-06T00:00:00.000Z",
  sequence: 3,
  size: { cols: 91, rows: 24, sizeClaim: "first-owner" },
};
function observer() {
  const pin = pinBrowserFollowupTerminalReplay(
    baseline as never,
    "inert-thread",
    "inert-terminal",
    "/inert/worktree",
  );
  return createBrowserFollowupReplayObserver({
    png: createSizedPng(512 * 1024, "browser-followup"),
    cwd: "/inert/worktree",
    threadId: "inert-thread",
    terminalId: "inert-terminal",
    patch: () => patch,
    slowTransport: () => true,
    baseline: pin,
  });
}
function attach(
  value: ReturnType<typeof observer>,
  connection: string,
  claim: string,
  snapshot = baseline,
) {
  value.observe(connection, "request", {
    _tag: "Request",
    id: "1",
    tag: "subscribeServerConfig",
    payload: {},
    headers: [],
  });
  value.observe(connection, "request", {
    _tag: "Request",
    id: "2",
    tag: "terminal.attach",
    payload: {
      threadId: "inert-thread",
      terminalId: "inert-terminal",
      cwd: "/inert/worktree",
      worktreePath: "/inert/worktree",
      sizeClaim: claim,
    },
    headers: [],
  });
  value.observe(connection, "reply", {
    _tag: "Chunk",
    requestId: "2",
    values: [
      {
        type: "snapshot",
        snapshot: { ...snapshot, size: { ...snapshot.size, sizeClaim: "first-owner" } },
      },
    ],
  });
}
it("joins exact baseline PID/history with current claimed renderer attachments and reviewed B1 proofs", () => {
  const value = observer();
  attach(value, "first", "first-owner");
  value.replay.verify();
  value.terminalRestored();
  attach(value, "second", "second-owner");
  expect(value.terminal().sameTerminalMatched).toBe(true);
  value.replay.verify();
  value.connectionClosed("second");
  value.terminalRestored();
});
it.each(["pid", "history", "sequence", "thread", "cwd"])(
  "refuses same-ID reconnect with changed %s before a capture",
  (mode) => {
    const value = observer(),
      changed = {
        ...baseline,
        ...(mode === "pid"
          ? { pid: 124 }
          : mode === "history"
            ? { history: "Owned shared terminal output\r\nchanged" }
            : mode === "sequence"
              ? { sequence: 2 }
              : mode === "thread"
                ? { threadId: "foreign" }
                : { cwd: "/foreign" }),
      };
    expect(() => attach(value, "first", "first-owner", changed)).toThrow();
    expect(() => value.replay.verify()).toThrow();
  },
);
it("retired or closed connections cannot leave a stale replay proof", () => {
  const value = observer();
  attach(value, "first", "first-owner");
  value.replay.verify();
  value.connectionClosed("first");
  expect(() => value.replay.verify()).toThrow();
  value.close();
  expect(() => value.replay.verify()).toThrow();
});
it("a command echo without the actual standalone output line is not an original terminal baseline", () => {
  expect(() =>
    pinBrowserFollowupTerminalReplay(
      { ...baseline, history: "printf 'Owned shared terminal output'" } as never,
      "inert-thread",
      "inert-terminal",
      "/inert/worktree",
    ),
  ).toThrow();
});

it.each(["owned", "send", "undefined", "close"])(
  "actual metadata stream joins its socket and preserves original failures: %s",
  async (mode) => {
    const requests: object[] = [],
      fault = new Error("inert exact send failure"),
      closeFault = new Error("inert exact close failure");
    let closes = 0,
      unsafe = 0;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ ticket: "inert-ticket", expiresAt: "2030-10-06T00:00:00.000Z" }),
          { status: 200 },
        ),
    );
    class Socket extends EventTarget {
      constructor(_url: URL) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(raw: string) {
        requests.push(JSON.parse(raw));
        if (mode === "send") throw fault;
        if (mode === "undefined") throw undefined;
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Chunk",
                requestId: "1",
                values: [
                  { type: "snapshot", terminals: [{ ...baseline, hasRunningSubprocess: true }] },
                ],
              }),
            }),
          ),
        );
      }
      close() {
        closes++;
        if (mode === "close") throw closeFault;
        queueMicrotask(() => this.dispatchEvent(new Event("close")));
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    const pending = readBrowserFollowupTerminalMetadata("inert-access", () => {
      unsafe++;
    });
    if (mode === "owned") {
      expect((await pending)[0]?.pid).toBe(123);
    } else {
      let failed = false,
        error: unknown;
      try {
        await pending;
      } catch (value) {
        failed = true;
        error = value;
      }
      expect(failed).toBe(true);
      expect(error).toBe(mode === "undefined" ? undefined : mode === "close" ? closeFault : fault);
    }
    expect(closes).toBe(1);
    expect(unsafe).toBe(mode === "close" ? 1 : 0);
    expect(requests).toEqual([
      { _tag: "Request", id: "1", tag: "subscribeTerminalMetadata", payload: {}, headers: [] },
    ]);
  },
);

it("replay owner separates absent and retired ready proof from a permanently refused foreign replay", () => {
  const value = observer();
  expect(() => value.replay.throwIfFailed()).not.toThrow();
  expect(() => value.terminalRestored()).toThrow();
  attach(value, "first", "first-owner");
  value.terminalRestored();
  value.connectionClosed("first");
  expect(() => value.replay.throwIfFailed()).not.toThrow();
  expect(() => value.terminalRestored()).toThrow();
  let original;
  try {
    attach(value, "foreign", "first-owner", { ...baseline, pid: 124 });
  } catch (error) {
    original = error;
  }
  expect(original).toBeDefined();
  expect(() => value.replay.throwIfFailed()).toThrow();
  let caught;
  try {
    value.replay.throwIfFailed();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(original);
  value.close();
  try {
    value.replay.throwIfFailed();
  } catch (error) {
    expect(error).toBe(original);
  }
});

it("preserves original/second roles when the original wire is retired and reinserted", () => {
  const value = observer();
  attach(value, "first", "first-owner");
  value.terminalRestored();
  attach(value, "second", "second-owner");
  expect(value.terminal().sizeOwnerMatched).toBe(true);
  value.connectionClosed("first");
  attach(value, "replacement", "first-owner");
  expect(value.terminal().sizeOwnerMatched).toBe(true);
  value.replay.throwIfFailed();
  value.connectionClosed("second");
  value.terminalRestored();
  value.close();
});
it.each([
  "unbound",
  "missing-original",
  "new-original",
  "new-second",
  "wrong-owner",
  "wrong-geometry",
] as const)("refuses role ambiguity or drift without accepting %s", (mode) => {
  const value = observer();
  attach(value, "first", "first-owner");
  if (mode !== "unbound") value.terminalRestored();
  attach(value, "second", "second-owner");
  if (mode !== "unbound") value.terminal();
  if (mode === "missing-original") value.connectionClosed("first");
  if (mode === "new-original") {
    value.connectionClosed("first");
    attach(value, "replacement", "foreign-original");
  }
  if (mode === "new-second") {
    value.connectionClosed("second");
    attach(value, "replacement", "foreign-second");
  }
  if (mode === "wrong-owner" || mode === "wrong-geometry")
    value.observe("second", "reply", {
      _tag: "Chunk",
      requestId: "2",
      values: [
        {
          type: "resized",
          threadId: baseline.threadId,
          terminalId: baseline.terminalId,
          size: {
            cols: mode === "wrong-geometry" ? 92 : 91,
            rows: 24,
            sizeClaim: mode === "wrong-owner" ? "second-owner" : "first-owner",
          },
        },
      ],
    });
  expect(() => value.terminal()).toThrow();
  value.close();
});

it("refuses extra or stale resize actors after role binding", () => {
  for (const mode of ["extra", "stale"]) {
    const value = observer();
    attach(value, "first", "first-owner");
    value.terminalRestored();
    attach(value, "second", "second-owner");
    value.terminal();
    if (mode === "extra") expect(() => attach(value, "third", "third-owner")).toThrow();
    else {
      value.connectionClosed("first");
      attach(value, "replacement", "first-owner");
      expect(() =>
        value.observe("first", "request", {
          _tag: "Request",
          id: "3",
          tag: "terminal.resize",
          payload: {
            threadId: baseline.threadId,
            terminalId: baseline.terminalId,
            cols: 91,
            rows: 24,
            sizeClaim: "first-owner",
          },
        }),
      ).toThrow();
    }
    expect(() => value.terminal()).toThrow();
    value.close();
  }
});

it("marks replay pin refusal without replacing the stored original failure", () => {
  const value = observer();
  let original: unknown;
  try {
    attach(value, "first", "first-owner", {
      ...baseline,
      history: baseline.history + "late delta",
    });
  } catch (error) {
    original = error;
  }
  expect(projectBrowserTerminalGuard(original)).toBe("current-attachment-invalid");
  let retained: unknown;
  try {
    value.replay.throwIfFailed();
  } catch (error) {
    retained = error;
  }
  expect(retained).toBe(original);
  let terminalError: unknown;
  try {
    value.terminal();
  } catch (error) {
    terminalError = error;
  }
  expect(projectBrowserTerminalGuard(terminalError)).toBe("observer-unavailable");
});
