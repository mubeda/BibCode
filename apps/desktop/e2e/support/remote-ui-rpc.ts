// @effect-diagnostics globalFetch:off - Only validated test-owned loopback hosts are authenticated.
// @effect-diagnostics globalTimers:off - The browser-owned fixture socket has bounded request/close waits.
import type { QualificationBrowser } from "./qualification-owner.ts";

export async function fixtureRpcTicket(
  endpoint: string,
  credential: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const base = new URL(endpoint);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    !Number.isInteger(Number(base.port)) ||
    Number(base.port) < 4800 ||
    Number(base.port) > 4899
  )
    throw new Error("Fixture RPC endpoint refused.");
  const token = await fetcher(new URL("/oauth/token", base), {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:bibcode:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Owned UI terminal fixture",
      client_device_type: "desktop",
    }),
  });
  if (!token.ok) throw new Error("Fixture authentication refused.");
  const payload = (await token.json()) as { access_token?: unknown };
  if (
    typeof payload.access_token !== "string" ||
    payload.access_token.length === 0 ||
    payload.access_token.length > 16384
  )
    throw new Error("Fixture authentication shape refused.");
  const response = await fetcher(new URL("/api/auth/websocket-ticket", base), {
    method: "POST",
    headers: { authorization: `Bearer ${payload.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Fixture socket authorization refused.");
  const value = (await response.json()) as { ticket?: unknown };
  if (typeof value.ticket !== "string" || value.ticket.length === 0 || value.ticket.length > 16384)
    throw new Error("Fixture ticket shape refused.");
  const socket = new URL("/ws", base);
  socket.protocol = "ws:";
  socket.searchParams.set("wsTicket", value.ticket);
  return socket.href;
}

export type FixtureRpcMethod = "terminal.open" | "terminal.close" | "updater.activeWork";
type FixtureRpcInput = { socketUrl: string; method: string; payload: Record<string, unknown> };
export type FixtureRpcReceipt = {
  ok: boolean;
  reason?: string;
  running?: boolean;
  pid?: number | null;
  closed?: boolean;
  runningTurns?: number | null;
  liveTerminals?: number | null;
};

/** A temporary real public-RPC client, owned by the fixture browser; no app state access. */
export function fixtureRpcBrowserRequest(
  input: FixtureRpcInput,
  done: (value: FixtureRpcReceipt) => void,
): void {
  if (!["terminal.open", "terminal.close", "updater.activeWork"].includes(input.method)) {
    done({ ok: false, reason: "method-refused" });
    return;
  }
  try {
    const endpoint = new URL(input.socketUrl);
    if (
      endpoint.protocol !== "ws:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.pathname !== "/ws" ||
      Number(endpoint.port) < 4800 ||
      Number(endpoint.port) > 4899 ||
      !endpoint.searchParams.get("wsTicket") ||
      endpoint.searchParams.getAll("wsTicket").length !== 1 ||
      [...endpoint.searchParams.keys()].some((key) => key !== "wsTicket")
    )
      throw new Error();
  } catch {
    done({ ok: false, reason: "endpoint-refused" });
    return;
  }
  let socket: WebSocket;
  try {
    socket = new WebSocket(input.socketUrl);
  } catch {
    done({ ok: false, reason: "socket-unavailable" });
    return;
  }
  let returned = false,
    reply: FixtureRpcReceipt | undefined;
  let closing: ReturnType<typeof setTimeout> | undefined;
  const finish = (value: FixtureRpcReceipt) => {
    if (returned) return;
    returned = true;
    clearTimeout(request);
    clearTimeout(closing);
    done(value);
  };
  const close = (value: FixtureRpcReceipt) => {
    if (reply !== undefined || returned) return;
    reply = value;
    clearTimeout(request);
    closing = setTimeout(() => finish({ ok: false, reason: "socket-close-timeout" }), 2_000);
    try {
      socket.close();
    } catch {
      finish({ ok: false, reason: "socket-close-failed" });
    }
  };
  const request = setTimeout(() => close({ ok: false, reason: "rpc-timeout" }), 10_000);
  socket.addEventListener("close", () => finish(reply ?? { ok: false, reason: "socket-closed" }));
  socket.addEventListener("error", () => close({ ok: false, reason: "socket-failed" }));
  socket.addEventListener("open", () => {
    if (returned || reply !== undefined) return;
    try {
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: input.method,
          payload: input.payload,
          headers: [],
        }),
      );
    } catch {
      close({ ok: false, reason: "send-failed" });
    }
  });
  socket.addEventListener("message", (event) => {
    if (returned || reply !== undefined) return;
    if (typeof event.data !== "string" || event.data.length > 2 * 1024 * 1024) {
      close({ ok: false, reason: "frame-refused" });
      return;
    }
    try {
      const envelope = JSON.parse(event.data);
      if (envelope?._tag !== "Exit" || envelope.requestId !== "1") return;
      if (envelope.exit?._tag !== "Success") {
        close({ ok: false, reason: "rpc-rejected" });
        return;
      }
      const value = envelope.exit.value;
      const count = (candidate: unknown, positive = false) =>
        typeof candidate === "number" &&
        Number.isInteger(candidate) &&
        candidate >= (positive ? 1 : 0) &&
        candidate <= 2_147_483_647
          ? candidate
          : null;
      if (input.method === "terminal.open")
        close({ ok: true, running: value?.status === "running", pid: count(value?.pid, true) });
      else if (input.method === "terminal.close") close({ ok: true, closed: value == null });
      else
        close({
          ok: true,
          runningTurns: count(value?.runningTurns),
          liveTerminals: count(value?.liveTerminals),
        });
    } catch {
      close({ ok: false, reason: "frame-refused" });
    }
  });
}

export async function callFixtureRpc(
  browser: QualificationBrowser,
  endpoint: string,
  credential: string,
  method: FixtureRpcMethod,
  payload: Record<string, unknown>,
): Promise<FixtureRpcReceipt> {
  const socketUrl = await fixtureRpcTicket(endpoint, credential);
  const receipt = await browser.executeAsync(fixtureRpcBrowserRequest, {
    socketUrl,
    method,
    payload,
  });
  if (receipt.ok !== true) throw new Error("Owned terminal RPC failed.");
  return receipt;
}
