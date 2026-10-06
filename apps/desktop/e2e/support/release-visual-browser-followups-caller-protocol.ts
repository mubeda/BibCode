// @effect-diagnostics nodeBuiltinImport:off - Original public terminal envelopes remain private at the owned raw-wire boundary.
// @effect-diagnostics globalFetch:off - One fixed authenticated loopback endpoint.
// @effect-diagnostics globalTimers:off - Joined, bounded fixture-only public stream.
import * as NodeModule from "node:module";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalSessionSnapshot,
  TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "../../../../packages/contracts/src/terminal.ts";
import { AuthWebSocketTicketResult } from "../../../../packages/contracts/src/auth.ts";
import { createBrowserFollowupProtocolObserver } from "./release-visual-browser-followups-protocol.ts";
import { startBrowserFollowupTransport } from "./release-visual-browser-followups-network.ts";
import { startThrottleProxy } from "../../../../scripts/throttle-proxy.ts";
import { joinBrowserFollowupCleanup } from "./release-visual-browser-followups-caller-resources.ts";
const Schema = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const refused = () => new Error("Owned browser follow-up replay refused.");
const decode = <A>(schema: unknown, value: unknown): A =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema))(value) as A;
export function pinBrowserFollowupTerminalReplay(
  value: TerminalSessionSnapshot,
  threadId: string,
  terminalId: string,
  cwd: string,
) {
  if (
    value.threadId !== threadId ||
    value.terminalId !== terminalId ||
    value.cwd !== cwd ||
    value.worktreePath !== cwd ||
    value.status !== "running" ||
    value.pid === null ||
    !Number.isInteger(value.pid) ||
    value.history.length > 65536 ||
    !/(?:^|\r?\n)Owned shared terminal output\r?\n/.test(value.history)
  )
    throw refused();
  return Object.freeze({
    threadId,
    terminalId,
    cwd,
    pid: value.pid,
    history: value.history,
    sequence: value.sequence,
  });
}
/** Claims and live attachment retirement remain the reviewed B1 source of truth; this adds the original bootstrap join. */
export function createBrowserFollowupReplayObserver(
  input: Parameters<typeof createBrowserFollowupProtocolObserver>[0] & {
    baseline: ReturnType<typeof pinBrowserFollowupTerminalReplay>;
  },
) {
  const base = createBrowserFollowupProtocolObserver(input),
    requests = new Map<string, string>(),
    snapshots = new Map<string, TerminalSessionSnapshot>();
  const uploadRequests = new Map<string, string>();
  let closed = false,
    failed = false;
  let uploadPending = false;
  const check = (value: TerminalSessionSnapshot) => {
    const pin = input.baseline;
    if (
      value.threadId !== pin.threadId ||
      value.terminalId !== pin.terminalId ||
      value.cwd !== pin.cwd ||
      value.worktreePath !== pin.cwd ||
      value.pid !== pin.pid ||
      value.status !== "running" ||
      value.history !== pin.history ||
      (pin.sequence !== undefined &&
        (value.sequence === undefined || value.sequence < pin.sequence))
    )
      throw refused();
  };
  const verify = () => {
    if (closed || failed || snapshots.size < 1 || snapshots.size > 2) throw refused();
    for (const [connection, value] of snapshots) {
      if (!base.rendererConnection(connection)) throw refused();
      check(value);
    }
  };
  return {
    ...base,
    observe: (
      connection: string,
      direction: "request" | "reply",
      value: Readonly<Record<string, unknown>>,
    ) => {
      try {
        base.observe(connection, direction, value);
        if (
          direction === "request" &&
          value._tag === "Request" &&
          ["uploads.begin", "uploads.cancel"].includes(String(value.tag))
        )
          uploadRequests.set(connection + ":" + value.id, String(value.tag));
        if (direction === "reply" && value._tag === "Exit") {
          const key = connection + ":" + value.requestId,
            tag = uploadRequests.get(key),
            exit = value.exit as { _tag?: unknown } | null;
          if (tag && exit?._tag === "Success") {
            uploadPending = tag === "uploads.begin";
          }
          uploadRequests.delete(key);
        }
        if (
          direction === "request" &&
          value._tag === "Request" &&
          value.tag === "terminal.attach"
        ) {
          const payload = decode<TerminalAttachInput>(TerminalAttachInput, value.payload);
          if (
            payload.threadId !== input.threadId ||
            payload.terminalId !== input.terminalId ||
            payload.cwd !== input.cwd ||
            !payload.sizeClaim
          )
            throw refused();
          requests.set(connection + ":" + value.id, connection);
        } else if (direction === "reply" && (value._tag === "Chunk" || value._tag === "Exit")) {
          const key = connection + ":" + value.requestId;
          if (!requests.has(key)) return;
          if (value._tag === "Exit") {
            requests.delete(key);
            snapshots.delete(connection);
            return;
          }
          if (!Array.isArray(value.values)) throw refused();
          for (const raw of value.values) {
            const event = decode<TerminalAttachStreamEvent>(TerminalAttachStreamEvent, raw);
            if (event.type === "snapshot") {
              check(event.snapshot);
              snapshots.set(connection, event.snapshot);
            } else if (event.type === "output") {
              const previous = snapshots.get(connection);
              if (!previous) throw refused();
              const current = { ...previous, history: previous.history + event.data };
              check(current);
              snapshots.set(connection, current);
            } else if (["exited", "closed", "error", "restarted", "cleared"].includes(event.type))
              throw refused();
          }
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    terminal: () => {
      verify();
      return base.terminal();
    },
    fitted: () => {
      verify();
      return base.fitted();
    },
    terminalRestored: () => {
      verify();
      return base.terminalRestored();
    },
    connectionClosed: (connection: string) => {
      base.connectionClosed(connection);
      snapshots.delete(connection);
      for (const key of requests.keys()) if (key.startsWith(connection + ":")) requests.delete(key);
    },
    close: () => {
      closed = true;
      base.close();
      requests.clear();
      snapshots.clear();
    },
    replay: { verify },
    stagePending: () => uploadPending,
  };
}
/** Both read-only current terminal streams close before returning, including synchronous send/close failures. */
async function readPublicTerminalStream<A>(input: {
  accessToken: string;
  tag: "terminal.attach" | "subscribeTerminalMetadata";
  payload: unknown;
  read: (value: unknown) => A;
  observeUnsafeCleanup?: () => void;
}): Promise<A> {
  const response = await fetch("http://127.0.0.1:4887/api/auth/websocket-ticket", {
    method: "POST",
    headers: { authorization: "Bearer " + input.accessToken },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw refused();
  const ticket = decode<AuthWebSocketTicketResult>(
      AuthWebSocketTicketResult,
      await response.json(),
    ),
    url = new URL("ws://127.0.0.1:4887/ws");
  url.searchParams.set("wsTicket", ticket.ticket);
  const socket = new WebSocket(url);
  return new Promise<A>((resolve, reject) => {
    let finished = false,
      closing = false,
      failed = false,
      error: unknown,
      result: A | undefined,
      closeTimer: ReturnType<typeof setTimeout> | undefined;
    const unsafe = () => {
      try {
        input.observeUnsafeCleanup?.();
      } catch {
        /* original failure wins */
      }
    };
    const fail = (value: unknown) => {
      if (!failed) {
        failed = true;
        error = value;
      }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      if (failed) reject(error);
      else if (result !== undefined) resolve(result);
      else reject(refused());
    };
    const close = (isFailure: boolean, failure?: unknown) => {
      if (closing || finished) return;
      closing = true;
      clearTimeout(timer);
      if (isFailure) fail(failure);
      closeTimer = setTimeout(() => {
        unsafe();
        fail(refused());
        finish();
      }, 2000);
      try {
        socket.close();
      } catch (value) {
        unsafe();
        fail(value);
        finish();
      }
    };
    const timer = setTimeout(() => close(true, refused()), 10000);
    socket.addEventListener("close", finish);
    socket.addEventListener("error", () => close(true, refused()));
    socket.addEventListener("open", () => {
      try {
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: input.tag,
            payload: input.payload,
            headers: [],
          }),
        );
      } catch (value) {
        close(true, value);
      }
    });
    socket.addEventListener("message", (event) => {
      if (closing || finished) return;
      try {
        if (typeof event.data !== "string" || event.data.length > 2 * 1024 * 1024) throw refused();
        const envelope = JSON.parse(event.data);
        if (envelope.requestId !== "1") return;
        if (
          envelope._tag !== "Chunk" ||
          !Array.isArray(envelope.values) ||
          envelope.values.length !== 1
        )
          throw refused();
        result = input.read(envelope.values[0]);
        close(false);
      } catch (value) {
        close(true, value);
      }
    });
  });
}
export function readBrowserFollowupTerminalMetadata(
  accessToken: string,
  observeUnsafeCleanup?: () => void,
): Promise<TerminalSummary[]> {
  return readPublicTerminalStream({
    accessToken,
    tag: "subscribeTerminalMetadata",
    payload: {},
    ...(observeUnsafeCleanup ? { observeUnsafeCleanup } : {}),
    read: (value) => {
      const event = decode<TerminalMetadataStreamEvent>(TerminalMetadataStreamEvent, value);
      if (event.type !== "snapshot") throw refused();
      return [...event.terminals];
    },
  });
}
/** No cwd/command/size claim is supplied: the real server refuses a missing terminal rather than creating or resizing it. */
export function readBrowserFollowupTerminalBaseline(input: {
  accessToken: string;
  threadId: string;
  terminalId: string;
  cwd: string;
  observeUnsafeCleanup?: () => void;
}) {
  const payload = decode<TerminalAttachInput>(TerminalAttachInput, {
    threadId: input.threadId,
    terminalId: input.terminalId,
    restartIfNotRunning: false,
  });
  return readPublicTerminalStream({
    ...input,
    tag: "terminal.attach",
    payload,
    read: (value) => {
      const event = decode<TerminalAttachStreamEvent>(TerminalAttachStreamEvent, value);
      if (event.type !== "snapshot") throw refused();
      return event.snapshot;
    },
  });
}
/** Concrete maintained throttle/raw-transport composition; every reviewed B1/B2/B3 method remains delegated. */
export async function startBrowserFollowupReplayNetwork(
  input: Parameters<typeof createBrowserFollowupReplayObserver>[0] & {
    CI: string | undefined;
    observeUnsafeCleanup: () => void;
  },
) {
  let proxy: Awaited<ReturnType<typeof startThrottleProxy>> | undefined;
  const observer = createBrowserFollowupReplayObserver({
    ...input,
    slowTransport: () => {
      const value = proxy?.settings();
      return value?.up === 4096 && value.down === 0 && !value.frozen;
    },
  });
  const transport = await startBrowserFollowupTransport({
    CI: input.CI,
    listenPort: 4894,
    targetPort: 4897,
    observer,
  });
  try {
    proxy = await startThrottleProxy({
      listenHost: "127.0.0.1",
      listenPort: 4887,
      targetHost: "127.0.0.1",
      targetPort: 4894,
    });
  } catch (error) {
    try {
      await transport.close();
    } catch {
      try {
        input.observeUnsafeCleanup();
      } catch {}
    }
    throw error;
  }
  const close = joinBrowserFollowupCleanup(
    [transport.close, proxy.close],
    input.observeUnsafeCleanup,
  );
  return { port: 4887, proxy, transport, observer, close };
}
