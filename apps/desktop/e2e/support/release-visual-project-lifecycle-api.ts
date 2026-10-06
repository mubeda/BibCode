// @effect-diagnostics nodeBuiltinImport:off - Exact QA transport resolves the contract-owning runtime.
// @effect-diagnostics globalFetch:off - Only the verified owned loopback server receives requests.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import { AuthWebSocketTicketResult } from "../../../../packages/contracts/src/auth.ts";
import { EnvironmentOrchestrationHttpApi } from "../../../../packages/contracts/src/environmentHttp.ts";
import {
  ClientOrchestrationCommand,
  OrchestrationReadModel,
  OrchestrationRpcSchemas,
} from "../../../../packages/contracts/src/orchestration.ts";
import { GitCloneInput, VcsStatusInput } from "../../../../packages/contracts/src/git.ts";
import {
  WorktreeGetRemovalPlanInput,
  WorktreeRemoveInput,
  WS_METHODS,
  WsWorktreeGetRemovalPlanRpc,
  WsWorktreeRemoveRpc,
  WsVcsCloneRpc,
  WsVcsRefreshStatusRpc,
} from "../../../../packages/contracts/src/rpc.ts";
import { bounded } from "./qualification-owner.ts";
import { lifecycleBusyPrompt } from "./release-visual-project-lifecycle.ts";
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const origin = "http://127.0.0.1:4885",
  refused = () => new Error("Owned lifecycle public API refused.");
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
export interface ProjectLifecycleApiSocket {
  readonly readyState: number;
  addEventListener: (name: string, callback: (event: { data?: unknown }) => void) => void;
  removeEventListener: (name: string, callback: (event: { data?: unknown }) => void) => void;
  send: (value: string) => void;
  close: () => void;
}
export interface ProjectLifecycleApiPorts {
  fetch: (url: string, input: RequestInit) => Promise<Pick<Response, "ok" | "json">>;
  socket: (url: string) => ProjectLifecycleApiSocket;
}
function nativeSocket(url: string): ProjectLifecycleApiSocket {
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
/** Only the exact owned lifecycle methods; clone is always join-only. */
export async function withProjectLifecycleApi<A>(
  input: {
    CI: string | undefined;
    ownedRoot: string;
    accessToken: string;
    projectId: string;
    threadId: string;
    managedCheckout: string;
    trustCheckout: string;
    cloneUrl: string;
    cloneParent: string;
    verifyTarget: () => Promise<void>;
    observeUnsafeCleanup: () => void;
    ports?: ProjectLifecycleApiPorts;
  },
  run: (api: {
    snapshot: () => Promise<OrchestrationReadModel>;
    dispatch: (
      input: ClientOrchestrationCommand,
    ) => Promise<typeof OrchestrationRpcSchemas.dispatchCommand.output.Type>;
    removalPlan: (
      input: WorktreeGetRemovalPlanInput,
    ) => Promise<typeof WsWorktreeGetRemovalPlanRpc.successSchema.Type>;
    remove: (input: WorktreeRemoveInput) => Promise<typeof WsWorktreeRemoveRpc.successSchema.Type>;
    attachClone: (input: GitCloneInput) => Promise<typeof WsVcsCloneRpc.successSchema.Type>;
    refreshStatus: (
      input: VcsStatusInput,
    ) => Promise<typeof WsVcsRefreshStatusRpc.successSchema.Type>;
  }) => Promise<A>,
): Promise<A> {
  const inside = (path: string) => {
    const relative = NodePath.relative(input.ownedRoot, path);
    return (
      NodePath.isAbsolute(path) &&
      NodePath.normalize(path) === path &&
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(".." + NodePath.sep) &&
      !NodePath.isAbsolute(relative)
    );
  };
  if (
    input.CI !== "true" ||
    typeof input.accessToken !== "string" ||
    input.accessToken.length < 8 ||
    input.accessToken.length > 16384 ||
    !NodePath.isAbsolute(input.ownedRoot) ||
    NodePath.normalize(input.ownedRoot) !== input.ownedRoot ||
    input.ownedRoot === NodePath.parse(input.ownedRoot).root ||
    ![input.projectId, input.threadId].every((id) => /^[A-Za-z0-9._:-]{1,128}$/.test(id)) ||
    ![input.managedCheckout, input.trustCheckout, input.cloneParent].every(inside) ||
    input.cloneUrl !== "https://visual.invalid/lifecycle-origin.git" ||
    input.trustCheckout !==
      NodePath.join(input.ownedRoot, "visual-project-lifecycle", "visual trust 'checkout") ||
    input.cloneParent !== NodePath.join(input.ownedRoot, "visual-project-lifecycle", "clone-parent")
  )
    throw refused();
  const unsafe = () => {
    try {
      input.observeUnsafeCleanup();
    } catch {
      /* Attribution cannot replace the original or joined cleanup. */
    }
  };
  const ports = input.ports ?? { fetch, socket: nativeSocket };
  let socket: ProjectLifecycleApiSocket | undefined,
    pending: {
      id: string;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    } | null = null,
    count = 0;
  const readPending = (): typeof pending => pending;
  const disposeListeners: Array<() => void> = [];
  const active = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation);
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation),
    );
    return operation;
  };
  let outcome: { value: A } | { error: unknown } | undefined;
  const onClosed = () => pending?.reject(refused());
  const onMessage = (event: { data?: unknown }) => {
    if (typeof event.data !== "string") return;
    if (Buffer.byteLength(event.data) > 1048576) {
      onClosed();
      return;
    }
    try {
      const value = JSON.parse(event.data);
      if (value?._tag === "Ping") {
        socket?.send(JSON.stringify({ _tag: "Pong" }));
        return;
      }
      if (value?._tag !== "Exit") return;
      const frame = Schema.decodeUnknownSync(Exit)(value);
      if (!pending || frame.requestId !== pending.id) return;
      pending.resolve(frame.exit);
    } catch {
      onClosed();
    }
  };
  const request = <I, O, E>(
    tag: "worktree.getRemovalPlan" | "worktree.remove" | "vcs.clone" | "vcs.refreshStatus",
    rpc: {
      payloadSchema: { readonly Type: I };
      successSchema: { readonly Type: O };
      errorSchema: { readonly Type: E };
    },
    payload: I,
    timeout = 2000,
  ): Promise<O> =>
    track(
      (async (): Promise<O> => {
        await input.verifyTarget();
        const decoded = Schema.decodeUnknownSync(rpc.payloadSchema)(payload);
        if (socket?.readyState !== 1 || pending !== null || ++count > 128) throw refused();
        const id = String(count);
        const wait = bounded(
          new Promise<unknown>((resolve, reject) => {
            pending = { id, resolve, reject };
            socket!.send(
              JSON.stringify({ _tag: "Request", id, tag, payload: decoded, headers: [] }),
            );
          }),
          timeout,
        );
        let exit;
        try {
          exit = await wait;
        } finally {
          pending = null;
        }
        await input.verifyTarget();
        const frame = Schema.decodeUnknownSync(Exit)({ _tag: "Exit", requestId: id, exit }).exit;
        if (frame._tag === "Failure") {
          if (frame.cause.length !== 1) throw refused();
          throw Schema.decodeUnknownSync(rpc.errorSchema)(frame.cause[0].error);
        }
        return Schema.decodeUnknownSync(rpc.successSchema)(frame.value);
      })(),
    );
  const readHttp = <O>(
    path: string,
    schema: { readonly Type: O },
    body?: ClientOrchestrationCommand,
  ): Promise<O> =>
    track(
      (async (): Promise<O> => {
        await input.verifyTarget();
        const response = await ports.fetch(origin + path, {
          method: body ? "POST" : "GET",
          headers: {
            authorization: "Bearer " + input.accessToken,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(1000),
        });
        if (!response.ok) throw refused();
        const result = Schema.decodeUnknownSync(schema)(await bounded(response.json(), 2000));
        await input.verifyTarget();
        return result;
      })(),
    );
  try {
    await input.verifyTarget();
    const response = await ports.fetch(origin + "/api/auth/websocket-ticket", {
      method: "POST",
      headers: { authorization: "Bearer " + input.accessToken },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) throw refused();
    const ticket = Schema.decodeUnknownSync(Schema.toCodecJson(AuthWebSocketTicketResult))(
        await bounded(response.json(), 2000),
      ),
      endpoint = new NodeURL.URL("/ws", origin);
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
              socket!.removeEventListener("error", failed);
              resolve();
            },
            failed = () => {
              socket!.removeEventListener("open", opened);
              socket!.removeEventListener("error", failed);
              reject(refused());
            };
          disposeListeners.push(() => {
            socket!.removeEventListener("open", opened);
            socket!.removeEventListener("error", failed);
          });
          socket!.addEventListener("open", opened);
          socket!.addEventListener("error", failed);
        }),
        2000,
      );
    outcome = {
      value: await run({
        snapshot: () =>
          readHttp(EnvironmentOrchestrationHttpApi.endpoints.snapshot.path, OrchestrationReadModel),
        dispatch: async (value) => {
          const command = Schema.decodeUnknownSync(ClientOrchestrationCommand)(value);
          if (
            command.threadId !== input.threadId ||
            !["thread.turn.start", "thread.session.stop"].includes(command.type) ||
            (command.type === "thread.turn.start" &&
              (command.message.text !== lifecycleBusyPrompt ||
                command.modelSelection?.instanceId !== "codex"))
          )
            throw refused();
          return readHttp(
            EnvironmentOrchestrationHttpApi.endpoints.dispatch.path,
            OrchestrationRpcSchemas.dispatchCommand.output,
            command,
          );
        },
        removalPlan: async (value) => {
          const payload = Schema.decodeUnknownSync(WorktreeGetRemovalPlanInput)(value);
          if (payload.projectId !== input.projectId || payload.threadId !== input.threadId)
            throw refused();
          return request(WS_METHODS.worktreeGetRemovalPlan, WsWorktreeGetRemovalPlanRpc, payload);
        },
        remove: async (value) => {
          const payload = Schema.decodeUnknownSync(WorktreeRemoveInput)(value);
          if (
            payload.projectId !== input.projectId ||
            payload.threadId !== input.threadId ||
            payload.mode !== "delete-git-worktree" ||
            payload.forceDirty !== false ||
            payload.confirmRepositoryWidePrune !== false
          )
            throw refused();
          return request(WS_METHODS.worktreeRemove, WsWorktreeRemoveRpc, payload);
        },
        attachClone: async (value) => {
          const payload = Schema.decodeUnknownSync(GitCloneInput)(value);
          if (
            payload.url !== input.cloneUrl ||
            payload.parentDir !== input.cloneParent ||
            payload.attach !== true
          )
            throw refused();
          return request(WS_METHODS.vcsClone, WsVcsCloneRpc, payload, 90000);
        },
        refreshStatus: async (value) => {
          const payload = Schema.decodeUnknownSync(VcsStatusInput)(value);
          if (payload.cwd !== input.trustCheckout) throw refused();
          return request(WS_METHODS.vcsRefreshStatus, WsVcsRefreshStatusRpc, payload);
        },
      }),
    };
  } catch (error) {
    outcome = { error };
  } finally {
    try {
      const outstanding = readPending();
      if (active.size > 0) unsafe();
      if (outstanding !== null) {
        unsafe();
        outstanding.reject(refused());
      }
      await bounded(Promise.allSettled([...active]), 2000);
      if (socket) {
        if (socket.readyState !== 3) {
          await bounded(
            new Promise<void>((resolve) => {
              const closed = () => {
                socket!.removeEventListener("close", closed);
                resolve();
              };
              disposeListeners.push(() => socket!.removeEventListener("close", closed));
              socket!.addEventListener("close", closed);
              socket!.close();
              if (socket!.readyState === 3) closed();
            }),
            2000,
          );
        }
      }
    } catch (error) {
      unsafe();
      if (!outcome || !("error" in outcome)) outcome = { error };
    } finally {
      for (const dispose of disposeListeners) {
        try {
          dispose();
        } catch {
          unsafe();
        }
      }
      if (socket) {
        try {
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("close", onClosed);
          socket.removeEventListener("error", onClosed);
        } catch {
          unsafe();
        }
      }
    }
  }
  if (!outcome) throw refused();
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
