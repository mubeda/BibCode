// @effect-diagnostics globalFetch:off - WebDriver evaluates this request inside the packaged browser.
import {
  desktopActivityComposerFollowupTurnCommand,
  desktopActivityFixture,
  desktopActivityFollowupTurnCommand,
  desktopActivitySessionCommands,
} from "./activity-events.ts";

export interface DesktopActivitySessionMaterialization {
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly threadId: string;
}

interface DesktopActivityBridge {
  readonly getLocalEnvironmentBearerToken: () => Promise<string>;
  readonly getLocalEnvironmentBootstraps: () => ReadonlyArray<{
    readonly httpBaseUrl: string;
    readonly id: string;
    readonly wsBaseUrl: string;
  }>;
}

interface DesktopActivityRpcRequest {
  readonly payload: Record<string, unknown>;
  readonly tag: string;
}

async function dispatchDesktopActivityCommands(
  commands: ReadonlyArray<Record<string, unknown>>,
  requestedProjectId: string | null,
  setupRequests: ReadonlyArray<DesktopActivityRpcRequest> = [],
): Promise<DesktopActivitySessionMaterialization> {
  return browser.execute(
    async (input: {
      readonly commands: ReadonlyArray<Record<string, unknown>>;
      readonly requestedProjectId: string | null;
      readonly setupRequests: ReadonlyArray<DesktopActivityRpcRequest>;
      readonly threadId: string;
    }) => {
      const bridge = (window as Window & { readonly desktopBridge?: DesktopActivityBridge })
        .desktopBridge;
      const bootstrap = bridge
        ?.getLocalEnvironmentBootstraps()
        .find(
          (candidate) =>
            candidate.id === "primary" &&
            typeof candidate.httpBaseUrl === "string" &&
            typeof candidate.wsBaseUrl === "string",
        );
      if (!bridge || !bootstrap) {
        throw new Error("The packaged primary environment bootstrap is unavailable.");
      }
      const bearerToken = await bridge.getLocalEnvironmentBearerToken();
      const ticketAbort = new AbortController();
      const ticketTimeout = window.setTimeout(() => ticketAbort.abort(), 15_000);
      let ticketResponse: Response;
      try {
        ticketResponse = await fetch(new URL("/api/auth/websocket-ticket", bootstrap.httpBaseUrl), {
          method: "POST",
          headers: { authorization: `Bearer ${bearerToken}` },
          signal: ticketAbort.signal,
        });
      } catch (error) {
        if (ticketAbort.signal.aborted) {
          throw new Error("Timed out requesting the activity fixture WebSocket ticket.", {
            cause: error,
          });
        }
        throw error;
      } finally {
        window.clearTimeout(ticketTimeout);
      }
      if (!ticketResponse.ok) {
        throw new Error(`WebSocket ticket request failed with HTTP ${ticketResponse.status}.`);
      }
      const ticketPayload = (await ticketResponse.json()) as { readonly ticket?: unknown };
      if (typeof ticketPayload.ticket !== "string" || ticketPayload.ticket.length === 0) {
        throw new Error("WebSocket ticket response did not contain a ticket.");
      }
      const socketUrl = new URL(bootstrap.wsBaseUrl);
      if (socketUrl.pathname === "" || socketUrl.pathname === "/") {
        socketUrl.pathname = "/ws";
      }
      socketUrl.searchParams.set("wsTicket", ticketPayload.ticket);
      const socket = new WebSocket(socketUrl);
      const closeSocket = () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ _tag: "Eof" }));
        }
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      };
      let disposeSocketListeners = () => {};
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            window.clearTimeout(timeout);
            socket.removeEventListener("open", onOpen);
            socket.removeEventListener("error", onError);
            socket.removeEventListener("close", onClose);
          };
          const onOpen = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(new Error("The activity fixture RPC socket failed to open."));
          };
          const onClose = () => {
            cleanup();
            reject(new Error("The activity fixture RPC socket closed before opening."));
          };
          const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error("Timed out opening the activity fixture RPC socket."));
          }, 15_000);
          socket.addEventListener("open", onOpen);
          socket.addEventListener("error", onError);
          socket.addEventListener("close", onClose);
        });

        let requestSequence = 0;
        interface PendingRequest {
          readonly mode: "chunk" | "exit" | "thread-ready";
          readonly reject: (error: Error) => void;
          readonly resolve: (value: Record<string, unknown>) => void;
          readonly timeout: number;
        }
        const pending = new Map<string, PendingRequest>();
        const rejectPending = (error: Error) => {
          for (const request of pending.values()) {
            window.clearTimeout(request.timeout);
            request.reject(error);
          }
          pending.clear();
        };
        const onMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          let message: {
            readonly _tag?: string;
            readonly requestId?: string;
            readonly values?: unknown;
            readonly exit?: {
              readonly _tag?: string;
              readonly value?: unknown;
              readonly cause?: unknown;
            };
          };
          try {
            message = JSON.parse(event.data) as typeof message;
          } catch {
            rejectPending(new Error("Activity fixture RPC socket received malformed JSON."));
            return;
          }
          if (typeof message.requestId !== "string") return;
          const request = pending.get(message.requestId);
          if (!request) return;
          if (
            (request.mode === "chunk" || request.mode === "thread-ready") &&
            message._tag === "Chunk"
          ) {
            const first = Array.isArray(message.values) ? message.values[0] : null;
            if (first === null || typeof first !== "object") {
              window.clearTimeout(request.timeout);
              pending.delete(message.requestId);
              request.reject(new Error("Activity fixture RPC stream returned an invalid chunk."));
              return;
            }
            if (request.mode === "thread-ready") {
              const envelope = first as Record<string, unknown>;
              const snapshot =
                envelope.kind === "snapshot" &&
                envelope.snapshot !== null &&
                typeof envelope.snapshot === "object"
                  ? (envelope.snapshot as Record<string, unknown>)
                  : null;
              const thread =
                snapshot?.thread !== null && typeof snapshot?.thread === "object"
                  ? (snapshot.thread as Record<string, unknown>)
                  : null;
              const session =
                thread?.session !== null && typeof thread?.session === "object"
                  ? (thread.session as Record<string, unknown>)
                  : null;
              if (typeof session?.providerInstanceId !== "string") return;
            }
            window.clearTimeout(request.timeout);
            pending.delete(message.requestId);
            socket.send(JSON.stringify({ _tag: "Interrupt", requestId: message.requestId }));
            request.resolve(first as Record<string, unknown>);
            return;
          }
          if (message._tag !== "Exit") return;
          window.clearTimeout(request.timeout);
          pending.delete(message.requestId);
          if (message.exit?._tag !== "Success") {
            request.reject(
              new Error(
                `Activity fixture RPC failed: ${JSON.stringify(message.exit?.cause ?? null)}`,
              ),
            );
            return;
          }
          const value = message.exit.value;
          request.resolve(
            value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {},
          );
        };
        const onClose = () =>
          rejectPending(new Error("Activity fixture RPC socket closed with requests pending."));
        const onError = () =>
          rejectPending(new Error("Activity fixture RPC socket failed with requests pending."));
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onError);
        disposeSocketListeners = () => {
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("close", onClose);
          socket.removeEventListener("error", onError);
          rejectPending(new Error("Activity fixture RPC socket was disposed."));
        };

        const request = (
          tag: string,
          payload: Record<string, unknown>,
          mode: "chunk" | "exit" | "thread-ready" = "exit",
        ): Promise<Record<string, unknown>> =>
          new Promise((resolve, reject) => {
            const requestId = String(requestSequence++);
            const timeout = window.setTimeout(() => {
              pending.delete(requestId);
              reject(new Error(`Timed out waiting for activity fixture RPC ${tag}.`));
            }, 15_000);
            pending.set(requestId, { mode, reject, resolve, timeout });
            socket.send(
              JSON.stringify({
                _tag: "Request",
                id: requestId,
                tag,
                payload,
                headers: [],
              }),
            );
          });

        for (const setupRequest of input.setupRequests) {
          await request(setupRequest.tag, setupRequest.payload);
        }

        let resolvedProjectId = input.requestedProjectId;
        for (const command of input.commands) {
          const payload =
            command.type === "thread.create" && resolvedProjectId !== null
              ? { ...command, projectId: resolvedProjectId }
              : command;
          const result = await request("orchestration.dispatchCommand", payload);
          if (command.type === "project.create" && typeof result.projectId === "string") {
            resolvedProjectId = result.projectId;
          }
        }
        if (!input.commands.some((command) => command.type === "thread.create")) {
          return { projectId: "", providerInstanceId: "", threadId: "" };
        }
        const envelope = await request(
          "orchestration.subscribeThread",
          { threadId: input.threadId },
          "thread-ready",
        );
        const streamSnapshot =
          envelope.kind === "snapshot" &&
          envelope.snapshot !== null &&
          typeof envelope.snapshot === "object"
            ? (envelope.snapshot as Record<string, unknown>)
            : null;
        const snapshot =
          streamSnapshot?.thread !== null && typeof streamSnapshot?.thread === "object"
            ? (streamSnapshot.thread as Record<string, unknown>)
            : null;
        const session =
          snapshot?.session !== null && typeof snapshot?.session === "object"
            ? (snapshot.session as Record<string, unknown>)
            : null;
        if (
          typeof snapshot?.id !== "string" ||
          typeof snapshot.projectId !== "string" ||
          typeof session?.providerInstanceId !== "string"
        ) {
          throw new Error(
            `Activity fixture thread snapshot did not contain resolved identifiers: ${JSON.stringify(
              snapshot,
            )}`,
          );
        }
        return {
          projectId: snapshot.projectId,
          providerInstanceId: session.providerInstanceId,
          threadId: snapshot.id,
        };
      } finally {
        disposeSocketListeners();
        closeSocket();
      }
    },
    {
      commands,
      requestedProjectId,
      setupRequests,
      threadId: desktopActivityFixture.thread.id,
    },
  );
}

/**
 * Materializes the activity spec's project, thread, and live provider session
 * through the same authenticated orchestration RPC used by the packaged app.
 */
export async function materializeDesktopActivitySession(
  projectPath: string,
): Promise<DesktopActivitySessionMaterialization> {
  return dispatchDesktopActivityCommands(
    desktopActivitySessionCommands(projectPath),
    desktopActivityFixture.project.id,
  );
}

export async function startDesktopActivityFollowupTurn(): Promise<void> {
  await dispatchDesktopActivityCommands([desktopActivityFollowupTurnCommand()], null);
}

export async function startDesktopActivityComposerFollowupTurn(): Promise<void> {
  await dispatchDesktopActivityCommands([desktopActivityComposerFollowupTurnCommand()], null);
}

/**
 * Refreshes the server config stream with the same absolute Codex executable
 * that the disposable provider inventory authorizes for the terminal launch.
 */
export async function configureDesktopActivityCodexExecutable(executable: string): Promise<void> {
  await dispatchDesktopActivityCommands([], null, [
    {
      tag: "server.updateSettings",
      payload: {
        patch: {
          enableTerminalAgentActivity: true,
          providers: {
            codex: {
              enabled: true,
              binaryPath: executable,
            },
          },
        },
      },
    },
  ]);
}
