// @effect-diagnostics nodeBuiltinImport:off - Current schema runtime belongs to the existing contract package.
// @effect-diagnostics globalFetch:off - This fixed CI-only public loopback transport is a development fixture.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import {
  ServerConfig,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
} from "../../../../packages/contracts/src/server.ts";
import {
  ServerProviderUsageResult,
  ServerProviderUsageRefreshInput,
} from "../../../../packages/contracts/src/providerUsage.ts";
import {
  GitManagerCwdInput,
  GitManagerOperationError,
} from "../../../../packages/contracts/src/gitManager.ts";
import { AuthWebSocketTicketResult } from "../../../../packages/contracts/src/auth.ts";
import { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import { EnvironmentOrchestrationHttpApi } from "../../../../packages/contracts/src/environmentHttp.ts";
import { bounded } from "./qualification-owner.ts";
import type { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
export interface SettingsFollowupApiSocket {
  readonly readyState: number;
  addEventListener: (name: string, callback: (event: { data?: unknown }) => void) => void;
  removeEventListener: (name: string, callback: (event: { data?: unknown }) => void) => void;
  send: (text: string) => void;
  close: () => void;
}
export interface SettingsFollowupApiPorts {
  fetch: (url: string, input: RequestInit) => Promise<Pick<Response, "ok" | "json">>;
  socket: (url: string) => SettingsFollowupApiSocket;
}
export interface SettingsFollowupApi {
  snapshot: () => Promise<OrchestrationReadModel>;
  config: () => Promise<ServerConfig>;
  diagnostics: () => Promise<ServerTraceDiagnosticsResult>;
  processes: () => Promise<ServerProcessDiagnosticsResult>;
  usage: () => Promise<ServerProviderUsageResult>;
  refreshUsage: () => Promise<ServerProviderUsageResult>;
  requestOwnedReadFailure: (
    cwd: string,
  ) => Promise<{ ownedReadFailure: true; error: GitManagerOperationError }>;
}
async function nativeFetch(url: string, input: RequestInit) {
  const response = await fetch(url, input);
  return {
    ok: response.ok,
    json: async () => {
      if (!response.body) throw refused();
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 1_048_576) throw refused();
          chunks.push(next.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const refused = () => new Error("Owned settings API refused.");
const Exit = Schema.Struct({
  _tag: Schema.Literal("Exit"),
  requestId: Schema.String,
  exit: Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.Unknown }),
    Schema.Struct({
      _tag: Schema.Literal("Failure"),
      cause: Schema.Array(Schema.Struct({ _tag: Schema.Literal("Fail"), error: Schema.Unknown })),
    }),
  ]),
});
function nativeSocket(url: string): SettingsFollowupApiSocket {
  const socket = new WebSocket(url),
    listeners = new Map<string, Map<(event: { data?: unknown }) => void, EventListener>>();
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (value) => socket.send(value),
    close: () => socket.close(),
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
  };
}
export async function withSettingsFollowupApi<A>(
  input: {
    CI: string | undefined;
    origin: "http://127.0.0.1:4885" | "http://127.0.0.1:4888";
    ownedRoot: string;
    accessToken: string;
    descriptor: ExecutionEnvironmentDescriptor;
    verifyTarget: () => Promise<void>;
    observeUnsafeCleanup: () => void;
    ports?: SettingsFollowupApiPorts;
  },
  run: (api: SettingsFollowupApi) => Promise<A>,
): Promise<A> {
  if (
    input.CI !== "true" ||
    !["http://127.0.0.1:4885", "http://127.0.0.1:4888"].includes(input.origin) ||
    typeof input.accessToken !== "string" ||
    input.accessToken.length < 8 ||
    input.accessToken.length > 16384 ||
    !NodePath.isAbsolute(input.ownedRoot) ||
    input.ownedRoot === NodePath.parse(input.ownedRoot).root ||
    NodePath.normalize(input.ownedRoot) !== input.ownedRoot ||
    input.descriptor.bootId === null ||
    input.descriptor.storageInstanceId === null
  )
    throw refused();
  const ports = input.ports ?? { fetch: nativeFetch, socket: nativeSocket };
  let socket: SettingsFollowupApiSocket | undefined,
    pending: {
      id: string;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    } | null = null,
    count = 0,
    busy = false,
    admissionClosed = false;
  const active = new Set<Promise<unknown>>();
  const operation = async <A>(run: () => Promise<A>): Promise<A> => {
    if (admissionClosed || busy || ++count > 128) throw refused();
    busy = true;
    const task = bounded(
      (async () => {
        await input.verifyTarget();
        const result = await run();
        await input.verifyTarget();
        return result;
      })(),
      2000,
    );
    active.add(task);
    try {
      return await task;
    } finally {
      active.delete(task);
      busy = false;
    }
  };
  const onMessage = (event: { data?: unknown }) => {
    try {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 1_048_576)
        throw refused();
      const data: unknown = JSON.parse(event.data);
      if (data && typeof data === "object" && "_tag" in data && data._tag === "Ping") {
        if (!admissionClosed && socket?.readyState === 1)
          socket.send(JSON.stringify({ _tag: "Pong" }));
        return;
      }
      if (!pending) return;
      if (data && typeof data === "object" && "_tag" in data && data._tag === "Pong") return;
      const exit = Schema.decodeUnknownSync(Exit)(data);
      if (exit.requestId === pending.id) pending.resolve(exit.exit);
    } catch {
      pending?.reject(refused());
    }
  };
  const onClosed = () => pending?.reject(refused());
  const request = async (
    tag:
      | "server.getConfig"
      | "server.getTraceDiagnostics"
      | "server.getProcessDiagnostics"
      | "server.getProviderUsage"
      | "server.refreshProviderUsage"
      | "gitManager.getRefs",
    payload: object,
    expectedFailure = false,
  ): Promise<unknown> => {
    if (socket?.readyState !== 1 || pending !== null || admissionClosed) throw refused();
    const id = String(count);
    let value: unknown;
    try {
      value = await bounded(
        new Promise((resolve, reject) => {
          pending = { id, resolve, reject };
          socket!.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
        }),
        2000,
      );
    } finally {
      pending = null;
    }
    const exit:
      | { _tag: "Success"; value: unknown }
      | { _tag: "Failure"; cause: readonly { error: unknown }[] } = Schema.decodeUnknownSync(Exit)({
      _tag: "Exit",
      requestId: id,
      exit: value,
    }).exit;
    if (expectedFailure) {
      if (exit._tag !== "Failure" || exit.cause.length !== 1) throw refused();
      const error: GitManagerOperationError = Schema.decodeUnknownSync(
        Schema.toCodecJson(GitManagerOperationError),
      )(exit.cause[0]!.error);
      if (error.operation !== tag || error.blocked !== null) throw refused();
      return error;
    }
    if (exit._tag !== "Success") throw refused();
    return exit.value;
  };
  let failed = false,
    error: unknown,
    result: A | undefined;
  try {
    await input.verifyTarget();
    const response = await bounded(
      ports.fetch(input.origin + "/api/auth/websocket-ticket", {
        method: "POST",
        headers: { authorization: "Bearer " + input.accessToken },
        signal: AbortSignal.timeout(1000),
      }),
      2000,
    );
    if (!response.ok) throw refused();
    const ticket: AuthWebSocketTicketResult = Schema.decodeUnknownSync(
      Schema.toCodecJson(AuthWebSocketTicketResult),
    )(await bounded(response.json(), 2000));
    const url = new NodeURL.URL("/ws", input.origin);
    url.protocol = "ws:";
    url.searchParams.set("wsTicket", ticket.ticket);
    socket = ports.socket(url.toString());
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClosed);
    socket.addEventListener("error", onClosed);
    if (socket.readyState !== 1)
      await bounded(
        new Promise<void>((resolve, reject) => {
          socket!.addEventListener("open", () => resolve());
          socket!.addEventListener("error", () => reject(refused()));
        }),
        2000,
      );
    const api: SettingsFollowupApi = {
      snapshot: () =>
        operation(async () => {
          const response = await ports.fetch(
            input.origin + EnvironmentOrchestrationHttpApi.endpoints.snapshot.path,
            {
              method: "GET",
              headers: { authorization: "Bearer " + input.accessToken },
              signal: AbortSignal.timeout(1000),
            },
          );
          if (!response.ok) throw refused();
          const value: unknown = await response.json();
          if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw refused();
          return Schema.decodeUnknownSync(OrchestrationReadModel)(value);
        }),
      config: async () => {
        const value: ServerConfig = Schema.decodeUnknownSync(Schema.toCodecJson(ServerConfig))(
          await operation(() => request("server.getConfig", {})),
        );
        if (
          value.environment.environmentId !== input.descriptor.environmentId ||
          value.environment.bootId !== input.descriptor.bootId ||
          value.environment.storageInstanceId !== input.descriptor.storageInstanceId
        )
          throw refused();
        return value;
      },
      diagnostics: async () =>
        Schema.decodeUnknownSync(Schema.toCodecJson(ServerTraceDiagnosticsResult))(
          await operation(() => request("server.getTraceDiagnostics", {})),
        ),
      processes: async () =>
        Schema.decodeUnknownSync(Schema.toCodecJson(ServerProcessDiagnosticsResult))(
          await operation(() => request("server.getProcessDiagnostics", {})),
        ),
      usage: async () =>
        Schema.decodeUnknownSync(Schema.toCodecJson(ServerProviderUsageResult))(
          await operation(() => request("server.getProviderUsage", {})),
        ),
      refreshUsage: async () => {
        const payload = Schema.decodeUnknownSync(ServerProviderUsageRefreshInput)({
          providers: ["codex"],
          force: true,
        });
        return Schema.decodeUnknownSync(Schema.toCodecJson(ServerProviderUsageResult))(
          await operation(() => request("server.refreshProviderUsage", payload)),
        );
      },
      requestOwnedReadFailure: async (cwd) => {
        const relative = NodePath.relative(input.ownedRoot, cwd);
        if (
          !NodePath.isAbsolute(cwd) ||
          !relative ||
          relative === ".." ||
          relative.startsWith(".." + NodePath.sep) ||
          NodePath.isAbsolute(relative) ||
          NodePath.normalize(cwd) !== cwd
        )
          throw refused();
        const payload = Schema.decodeUnknownSync(GitManagerCwdInput)({ cwd });
        const error = await operation(() => request("gitManager.getRefs", payload, true));
        return {
          ownedReadFailure: true,
          error: Schema.decodeUnknownSync(Schema.toCodecJson(GitManagerOperationError))(error),
        };
      },
    };
    result = await run(api);
  } catch (cause) {
    failed = true;
    error = cause;
  }
  let cleanupFailed = false;
  admissionClosed = true;
  try {
    onClosed();
    await Promise.allSettled(Array.from(active));
    if (socket && socket.readyState !== 3) {
      const owned = socket,
        closed = new Promise<void>((resolve) => owned.addEventListener("close", () => resolve()));
      owned.close();
      await bounded(closed, 2000);
      if (owned.readyState !== 3) throw refused();
    }
  } catch {
    cleanupFailed = true;
    try {
      input.observeUnsafeCleanup();
    } catch {
      /* Original error stays primary. */
    }
  } finally {
    socket?.removeEventListener("message", onMessage);
    socket?.removeEventListener("close", onClosed);
    socket?.removeEventListener("error", onClosed);
  }
  if (failed) throw error;
  if (cleanupFailed) throw refused();
  return result as A;
}
