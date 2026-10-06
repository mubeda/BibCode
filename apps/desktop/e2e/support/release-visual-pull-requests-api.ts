// @effect-diagnostics nodeBuiltinImport:off - Resolve the actual contracts Schema runtime for this development-only fixture transport.
// @effect-diagnostics globalFetch:off - Only the existing owned loopback server receives this CI read.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { AuthWebSocketTicketResult } from "../../../../packages/contracts/src/auth.ts";
import {
  PullRequestsGetContextInput,
  PullRequestsContext,
  type PullRequestsContext as Context,
} from "../../../../packages/contracts/src/pullRequests.ts";
import { WS_METHODS } from "../../../../packages/contracts/src/rpc.ts";
import { bounded } from "./qualification-owner.ts";
import {
  projectPullRequestsHostContext,
  type PullRequestsExpectedHostContext,
} from "./release-visual-pull-requests.ts";
const Schema = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const origin = "http://127.0.0.1:4885",
  refused = () => new Error("Owned request public API refused.");
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
export interface PullRequestsPublicPorts {
  fetch: (url: string, input: RequestInit) => Promise<Pick<Response, "ok" | "json">>;
  socket: (url: string) => PublicSocket;
}
function nativeSocket(url: string): PublicSocket {
  const socket = new WebSocket(url),
    listeners = new Map<string, Map<(event: { data?: unknown }) => void, EventListener>>();
  return {
    get readyState() {
      return socket.readyState;
    },
    addEventListener: (name, callback) => {
      const listener: EventListener = (event) =>
          callback(event instanceof MessageEvent ? { data: event.data } : {}),
        group = listeners.get(name) ?? new Map();
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
export interface PullRequestsPublicBinding extends PullRequestsExpectedHostContext {
  cwd: string;
}
export interface PullRequestsPublicApi {
  getContext: (cwd: string) => Promise<Context>;
}
function publicBinding(value: unknown): PullRequestsPublicBinding {
  const keys = ["cwd", "provider", "host", "repository", "account"];
  if (!value || typeof value !== "object" || NodeUtil.types.isProxy(value) || Array.isArray(value))
    throw refused();
  const names = Reflect.ownKeys(value);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw refused();
  const fields = keys.map((key) => Object.getOwnPropertyDescriptor(value, key));
  if (fields.some((field) => !field?.enumerable || !Object.hasOwn(field, "value"))) throw refused();
  const [cwd, provider, host, repository, account] = fields.map((field) => field!.value);
  if (
    typeof cwd !== "string" ||
    !NodePath.isAbsolute(cwd) ||
    NodePath.normalize(cwd) !== cwd ||
    !/[\/](?:light|dark)[\/]requests[\/](github|gitlab)$/.test(cwd) ||
    (provider !== "github" && provider !== "gitlab") ||
    NodePath.basename(cwd) !== provider ||
    host !== provider + ".visual.invalid" ||
    repository !== "owned/requests" ||
    account !== "viewer"
  )
    throw refused();
  return { cwd, provider, host, repository, account };
}
/** Fixed getContext only, one in-flight request, no generic RPC, retry, reconnect or state mutation. */
export async function withPullRequestsPublicApi<A>(
  input: {
    CI: string | undefined;
    accessToken: string;
    bindings: readonly PullRequestsPublicBinding[];
    ports?: PullRequestsPublicPorts;
    observeCleanupFailure: () => void;
  },
  run: (api: PullRequestsPublicApi) => Promise<A>,
): Promise<A> {
  if (
    input.CI !== "true" ||
    typeof input.accessToken !== "string" ||
    input.accessToken.length < 8 ||
    input.accessToken.length > 16384 ||
    NodeUtil.types.isProxy(input.bindings) ||
    !Array.isArray(input.bindings) ||
    input.bindings.length < 1 ||
    input.bindings.length > 2
  )
    throw refused();
  const bindings = new Map<string, PullRequestsPublicBinding>();
  if (Reflect.ownKeys(input.bindings).length !== input.bindings.length + 1) throw refused();
  for (let index = 0; index < input.bindings.length; index++) {
    const field = Object.getOwnPropertyDescriptor(input.bindings, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw refused();
    const binding = publicBinding(field.value);
    if (bindings.has(binding.cwd)) throw refused();
    bindings.set(binding.cwd, binding);
  }
  const ports = input.ports ?? { fetch, socket: nativeSocket };
  let socket: PublicSocket | undefined,
    pending: {
      id: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    } | null = null,
    requestCount = 0,
    outcome: { value: A } | { error: unknown } | undefined;
  const onMessage = (event: { data?: unknown }) => {
    if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 1048576) return;
    try {
      const message = JSON.parse(event.data);
      if (message?._tag === "Ping") {
        socket?.send(JSON.stringify({ _tag: "Pong" }));
        return;
      }
      if (message?._tag !== "Exit") return;
      const frame = Schema.decodeUnknownSync(Exit)(message);
      if (!pending || frame.requestId !== pending.id) return;
      if (frame.exit._tag !== "Success") pending.reject(refused());
      else pending.resolve(frame.exit.value);
    } catch {
      pending?.reject(refused());
    }
  };
  const onClosed = () => pending?.reject(refused());
  const request = async (payload: object): Promise<unknown> => {
    if (socket?.readyState !== 1 || pending !== null || ++requestCount > 128) throw refused();
    const id = String(requestCount);
    try {
      return await bounded(
        new Promise((resolve, reject) => {
          pending = { id, resolve, reject };
          socket!.send(
            JSON.stringify({
              _tag: "Request",
              id,
              tag: WS_METHODS.pullRequestsGetContext,
              payload,
              headers: [],
            }),
          );
        }),
        2000,
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
      await bounded(response.json(), 2000),
    );
    const endpoint = new URL("/ws", origin);
    endpoint.protocol = "ws:";
    endpoint.searchParams.set("wsTicket", ticket.ticket);
    socket = ports.socket(endpoint.toString());
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClosed);
    socket.addEventListener("error", onClosed);
    if (socket.readyState !== 1) {
      const owned = socket;
      let removeOpening = () => {};
      try {
        await bounded(
          new Promise<void>((resolve, reject) => {
            const opened = () => {
              removeOpening();
              resolve();
            };
            const failed = () => {
              removeOpening();
              reject(refused());
            };
            removeOpening = () => {
              owned.removeEventListener("open", opened);
              owned.removeEventListener("error", failed);
            };
            owned.addEventListener("open", opened);
            owned.addEventListener("error", failed);
          }),
          2000,
        );
      } finally {
        removeOpening();
      }
    }
    const value = await run({
      getContext: async (cwd) => {
        const binding = bindings.get(cwd);
        if (!binding) throw refused();
        const payload = Schema.decodeUnknownSync(PullRequestsGetContextInput)({
          cwd,
          rescan: false,
        });
        const context: Context = Schema.decodeUnknownSync(PullRequestsContext)(
          await request(payload),
        );
        if (!projectPullRequestsHostContext(context, binding)) throw refused();
        return context;
      },
    });
    outcome = { value };
  } catch (error) {
    outcome = { error };
  }
  let cleanupFailed = false;
  try {
    if (socket && socket.readyState !== 3) {
      const owned = socket;
      let removeClosing = () => {};
      try {
        const closed = new Promise<void>((resolve) => {
          const close = () => {
            resolve();
          };
          removeClosing = () => owned.removeEventListener("close", close);
          owned.addEventListener("close", close);
        });
        owned.close();
        await bounded(closed, 2000);
      } finally {
        removeClosing();
      }
      if (owned.readyState !== 3) throw refused();
    }
  } catch {
    cleanupFailed = true;
    try {
      input.observeCleanupFailure();
    } catch {
      /* The original read/callback and logical cleanup retain their outcomes. */
    }
  } finally {
    socket?.removeEventListener("message", onMessage);
    socket?.removeEventListener("close", onClosed);
    socket?.removeEventListener("error", onClosed);
  }
  if (!outcome) throw refused();
  if ("error" in outcome) throw outcome.error;
  if (cleanupFailed) throw refused();
  return outcome.value;
}
