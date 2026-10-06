// @effect-diagnostics nodeBuiltinImport:off - Resolve the current contract package's Schema runtime without a production dependency.
// @effect-diagnostics globalFetch:off - Only the existing owned loopback server receives this CI transport.
import * as NodeModule from "node:module";
import { AuthWebSocketTicketResult } from "../../../../packages/contracts/src/auth.ts";
import {
  AssetCreateUrlInput,
  AssetCreateUrlResult,
} from "../../../../packages/contracts/src/assets.ts";
import {
  OrchestrationRpcSchemas,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
} from "../../../../packages/contracts/src/orchestration.ts";
import { bounded } from "./qualification-owner.ts";

const Schema = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const origin = "http://127.0.0.1:4885";
const refused = () => new Error("Owned provider public API refused.");
const Exit = Schema.Struct({
  _tag: Schema.Literal("Exit"),
  requestId: Schema.String,
  exit: Schema.Struct({ _tag: Schema.String, value: Schema.optionalKey(Schema.Unknown) }),
});
interface PublicSocket {
  readonly readyState: number;
  addEventListener: (name: string, callback: (event: { data?: unknown }) => void) => void;
  removeEventListener: (name: string, callback: (event: { data?: unknown }) => void) => void;
  send: (message: string) => void;
  close: () => void;
}
interface PublicPorts {
  fetch: (url: string, input: RequestInit) => Promise<Pick<Response, "ok" | "json">>;
  socket: (url: string) => PublicSocket;
}
function nativeSocket(url: string): PublicSocket {
  const socket = new WebSocket(url);
  const listeners = new Map<string, Map<(event: { data?: unknown }) => void, EventListener>>();
  return {
    get readyState() {
      return socket.readyState;
    },
    addEventListener: (name, callback) => {
      const listener: EventListener = (event) =>
        callback(event instanceof MessageEvent ? { data: event.data } : {});
      const group = listeners.get(name) ?? new Map();
      group.set(callback, listener);
      listeners.set(name, group);
      socket.addEventListener(name, listener);
    },
    removeEventListener: (name, callback) => {
      const listener = listeners.get(name)?.get(callback);
      if (listener) socket.removeEventListener(name, listener);
      listeners.get(name)?.delete(callback);
    },
    send: (message) => socket.send(message),
    close: () => socket.close(),
  };
}
/** Fixed typed public asset/replay transport owned by the provider-chat CI producer. */
export interface ProviderChatPublicApi {
  createAssetUrl: (threadId: string) => Promise<AssetCreateUrlResult>;
  replayEvents: (fromSequenceExclusive: number) => Promise<readonly OrchestrationEvent[]>;
}

/** One owned connection, one in-flight unary request, no reconnect/retry or production state mutation. */
export async function withProviderChatPublicApi<A>(
  input: {
    CI: string | undefined;
    accessToken: string;
    ports?: PublicPorts;
    observeCleanupFailure: () => void;
  },
  run: (api: ProviderChatPublicApi) => Promise<A>,
): Promise<A> {
  if (
    input.CI !== "true" ||
    typeof input.accessToken !== "string" ||
    input.accessToken.length < 8 ||
    input.accessToken.length > 16384
  )
    throw refused();
  const ports: PublicPorts = input.ports ?? { fetch, socket: nativeSocket };
  let socket: PublicSocket | undefined,
    requestCount = 0;
  let pending: {
    id: string;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let failed = false,
    failure: unknown,
    result: A | undefined;
  const onMessage = (event: { data?: unknown }) => {
    if (!pending || typeof event.data !== "string") return;
    if (event.data.length > 262144) {
      pending.reject(refused());
      return;
    }
    try {
      const value: unknown = JSON.parse(event.data);
      if (value && typeof value === "object" && "_tag" in value && value._tag === "Pong") return;
      const frame = Schema.decodeUnknownSync(Exit)(value);
      if (frame.requestId !== pending.id) return;
      if (frame.exit._tag !== "Success") pending.reject(refused());
      else pending.resolve(frame.exit.value);
    } catch {
      pending.reject(refused());
    }
  };
  const onClosed = () => pending?.reject(refused());
  const request = async (
    tag: "assets.createUrl" | "orchestration.replayEvents",
    payload: object,
  ): Promise<unknown> => {
    if (socket?.readyState !== 1 || pending !== null || ++requestCount > 128) throw refused();
    const id = String(requestCount);
    try {
      return await bounded(
        new Promise<unknown>((resolve, reject) => {
          pending = { id, resolve, reject };
          // The same Effect-RPC encoded unary request used by the current public server.
          socket!.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
        }),
        2_000,
      );
    } finally {
      pending = null;
    }
  };
  try {
    const response = await ports.fetch(origin + "/api/auth/websocket-ticket", {
      method: "POST",
      headers: { authorization: "Bearer " + input.accessToken },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) throw refused();
    const ticket = Schema.decodeUnknownSync(Schema.toCodecJson(AuthWebSocketTicketResult))(
      await bounded(response.json(), 2_000),
    );
    const endpoint = new URL("/ws", origin);
    endpoint.protocol = "ws:";
    endpoint.searchParams.set("wsTicket", ticket.ticket);
    socket = ports.socket(endpoint.toString());
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClosed);
    socket.addEventListener("error", onClosed);
    if (socket.readyState !== 1)
      await bounded(
        new Promise<void>((resolve, reject) => {
          const opened = () => {
            socket!.removeEventListener("open", opened);
            socket!.removeEventListener("error", rejected);
            resolve();
          };
          const rejected = () => {
            socket!.removeEventListener("open", opened);
            socket!.removeEventListener("error", rejected);
            reject(refused());
          };
          socket!.addEventListener("open", opened);
          socket!.addEventListener("error", rejected);
        }),
        2_000,
      );
    result = await run({
      createAssetUrl: async (threadId) => {
        const payload: AssetCreateUrlInput = Schema.decodeUnknownSync(AssetCreateUrlInput)({
          resource: { _tag: "workspace-file", threadId, path: "visual-swatch.png" },
        });
        const value: AssetCreateUrlResult = Schema.decodeUnknownSync(AssetCreateUrlResult)(
          await request("assets.createUrl", payload),
        );
        const url = new URL(value.relativeUrl, origin);
        if (
          !value.relativeUrl.startsWith("/api/assets/") ||
          url.origin !== origin ||
          url.username ||
          url.password ||
          url.hash
        )
          throw refused();
        return value;
      },
      replayEvents: async (sequence) => {
        const payload = Schema.decodeUnknownSync(OrchestrationRpcSchemas.replayEvents.input)({
          fromSequenceExclusive: sequence,
          paged: true,
        });
        const page = Schema.decodeUnknownSync(OrchestrationRpcSchemas.replayEvents.output)(
          await request(ORCHESTRATION_WS_METHODS.replayEvents, payload),
        );
        if (Array.isArray(page) || page.exhausted !== true || page.events.length > 512)
          throw refused();
        return page.events;
      },
    });
  } catch (error) {
    failed = true;
    failure = error;
  }
  let cleanupFailed = false;
  try {
    if (socket && socket.readyState !== 3) {
      const owned = socket;
      const closed = new Promise<void>((resolve) => {
        owned.addEventListener("close", () => resolve());
      });
      owned.close();
      await bounded(closed, 2_000);
      if (owned.readyState !== 3) throw refused();
    }
  } catch {
    cleanupFailed = true;
    try {
      input.observeCleanupFailure();
    } catch {
      /* Original operation and cleanup stay authoritative. */
    }
  } finally {
    socket?.removeEventListener("message", onMessage);
    socket?.removeEventListener("close", onClosed);
    socket?.removeEventListener("error", onClosed);
  }
  if (failed) throw failure;
  if (cleanupFailed) throw refused();
  return result as A;
}
