// @effect-diagnostics nodeBuiltinImport:off - Isolated release verification owns its loopback transport.
// @effect-diagnostics globalFetch:off - The driver authenticates only its test-owned loopback endpoint.
// @effect-diagnostics globalTimers:off - Transport requests have bounded cancellation-aware timers.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  AuthAccessTokenResult,
  AuthWebSocketTicketResult,
  RemoteUpdateActiveWork,
  RemoteUpdateSnapshot,
  RemoteUpdateInstallError,
} from "@bibcode/contracts";
import {
  runRemoteUpdate,
  type RemoteUpdatePort,
  type RemoteUpdateRunState,
} from "@bibcode/client-runtime/state/remoteUpdateCoordinator";
import { assertRemoteInstallPort } from "../seeded-desktop-upgrade-smoke.ts";

const ConfigIdentity = Schema.Struct({
  environment: Schema.Struct({
    bootId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    serverVersion: Schema.String,
    storageInstanceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    capabilities: Schema.Struct({ remoteUpdateProgress: Schema.optionalKey(Schema.Boolean) }),
  }),
});
const ExitEnvelope = Schema.Struct({
  _tag: Schema.Literal("Exit"),
  requestId: Schema.String,
  exit: Schema.Struct({
    _tag: Schema.String,
    value: Schema.optionalKey(Schema.Unknown),
    cause: Schema.optionalKey(Schema.Unknown),
  }),
});
const FailureCause = Schema.Array(Schema.TaggedStruct("Fail", { error: Schema.Unknown }));
class RemoteInstallTransportError extends Schema.TaggedError<RemoteInstallTransportError>()(
  "RemoteInstallTransportError",
  { message: Schema.String },
) {}

const decodeIdentity = Schema.decodeUnknownSync(ConfigIdentity);
const decodeIdentityEffect = Schema.decodeUnknownEffect(ConfigIdentity);
const decodeExitEnvelope = Schema.decodeUnknownOption(ExitEnvelope);
const decodeFailureCause = Schema.decodeUnknownOption(FailureCause);
const decodeInstallError = Schema.decodeUnknownOption(RemoteUpdateInstallError);
const isInstallError = Schema.is(RemoteUpdateInstallError);
const decodeAccessToken = Schema.decodeUnknownSync(Schema.toCodecJson(AuthAccessTokenResult));
const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(AuthWebSocketTicketResult));
const decodeActiveWork = Schema.decodeUnknownSync(RemoteUpdateActiveWork);
const decodeSnapshot = Schema.decodeUnknownSync(RemoteUpdateSnapshot);
const decodeSnapshotEffect = Schema.decodeUnknownEffect(RemoteUpdateSnapshot);
const WideDescriptor = Schema.Struct({
  bootId: Schema.NullOr(Schema.String),
  storageInstanceId: Schema.NullOr(Schema.String),
});
const readWideDescriptor = HttpClientResponse.schemaBodyJson(WideDescriptor);

export function identityFromConfig(input: unknown) {
  const { environment } = decodeIdentity(input);
  return {
    bootId: environment.bootId ?? null,
    serverVersion: environment.serverVersion,
    progress: environment.capabilities.remoteUpdateProgress ?? false,
  };
}
export function encodeRequest(id: string, tag: string): string {
  return JSON.stringify({ _tag: "Request", id, tag, payload: {}, headers: [] });
}
/** Unrelated/control frames never settle a pending request. */
export function decodeExit(input: unknown, id: string): unknown {
  const parsed = decodeExitEnvelope(input);
  if (Option.isNone(parsed) || parsed.value.requestId !== id) return undefined;
  if (parsed.value.exit._tag !== "Success") {
    const cause = decodeFailureCause(parsed.value.exit.cause);
    if (Option.isSome(cause)) {
      for (const reason of cause.value) {
        const error = decodeInstallError(reason.error);
        if (Option.isSome(error)) throw error.value;
      }
    }
    throw new Error("Remote verification RPC failed.");
  }
  return parsed.value.exit.value;
}

export interface RemoteInstallDriverInput {
  readonly endpoint: string;
  readonly bootstrapToken: string;
  /** A live grant widened the host: identities must come from a boot reachable off loopback. */
  readonly requireWide?: boolean;
}
export interface RemoteInstallDriverEvidence {
  readonly before: {
    readonly bootId: string;
    readonly serverVersion: string;
    readonly storageInstanceId: string;
  };
  readonly after: {
    readonly bootId: string;
    readonly serverVersion: string;
    readonly storageInstanceId: string;
  };
  readonly phases: ReadonlyArray<string>;
  readonly sawPercent: boolean;
  readonly sawStage: boolean;
}

/** Runs the product coordinator through an authenticated, independently reconnecting test client. */
export async function runRemoteInstallDriver(
  input: RemoteInstallDriverInput,
): Promise<RemoteInstallDriverEvidence> {
  const endpoint = new URL(input.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  )
    throw new Error("Remote verification requires a test-owned loopback endpoint.");
  assertRemoteInstallPort(Number(endpoint.port));
  const tokenResponse = await fetch(new URL("/oauth/token", endpoint), {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: input.bootstrapToken,
      subject_token_type: "urn:bibcode:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Remote update verification",
      client_device_type: "desktop",
    }),
  });
  if (!tokenResponse.ok) throw new Error("Remote verification authentication was rejected.");
  const tokenPayload: unknown = await tokenResponse.json();
  let bearer: string;
  try {
    bearer = decodeAccessToken(tokenPayload).access_token;
  } catch {
    throw new Error("Invalid verification authentication response.");
  }
  let socket: WebSocket | null = null;
  let connectedEpoch = 0;
  let phase: "connected" | "backoff" | "blocked" = "backoff";
  let sequence = 0;
  let opening: Promise<void> | null = null;
  const pending = new Map<
    string,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly dispose: () => void;
    }
  >();

  const open = async (): Promise<void> => {
    if (socket?.readyState === WebSocket.OPEN) return;
    if (opening !== null) return opening;
    opening = (async () => {
      const ticketResponse = await fetch(new URL("/api/auth/websocket-ticket", endpoint), {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!ticketResponse.ok) {
        if (ticketResponse.status === 401 || ticketResponse.status === 403) phase = "blocked";
        throw new Error("Remote verification socket authorization failed.");
      }
      const ticketPayload: unknown = await ticketResponse.json();
      let ticket: string;
      try {
        ticket = decodeTicket(ticketPayload).ticket;
      } catch {
        throw new Error("Invalid verification ticket response.");
      }
      const url = new URL("/ws", endpoint);
      url.protocol = "ws:";
      url.searchParams.set("wsTicket", ticket);
      const current = new WebSocket(url);
      socket = current;
      current.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let decoded: unknown;
        try {
          decoded = JSON.parse(event.data);
        } catch {
          return;
        }
        const exit = decodeExitEnvelope(decoded);
        if (Option.isNone(exit)) return;
        const id = exit.value.requestId;
        const waiter = pending.get(id);
        if (waiter === undefined) return;
        pending.delete(id);
        waiter.dispose();
        try {
          waiter.resolve(decodeExit(decoded, id));
        } catch (error) {
          waiter.reject(
            error instanceof Error ? error : new Error("Remote verification RPC failed."),
          );
        }
      });
      current.addEventListener("close", () => {
        if (socket !== current) return;
        phase = "backoff";
        for (const waiter of pending.values()) {
          waiter.dispose();
          waiter.reject(new Error("Remote verification connection closed."));
        }
        pending.clear();
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          current.close();
          reject(new Error("Remote verification socket timed out."));
        }, 10_000);
        current.addEventListener(
          "open",
          () => {
            clearTimeout(timeout);
            phase = "connected";
            connectedEpoch += 1;
            resolve();
          },
          { once: true },
        );
        current.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            current.close();
            reject(new Error("Remote verification socket failed."));
          },
          { once: true },
        );
      });
    })();
    try {
      await opening;
    } finally {
      opening = null;
    }
  };
  const request = async (tag: string, signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted || socket?.readyState !== WebSocket.OPEN)
      throw new Error("Remote verification request interrupted.");
    const current = socket;
    const id = String(sequence++);
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        dispose();
        if (current.readyState === WebSocket.OPEN)
          current.send(JSON.stringify({ _tag: "Interrupt", requestId: id }));
        reject(new Error("Remote verification request interrupted."));
      };
      const timeout = setTimeout(abort, 10_000);
      const dispose = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      pending.set(id, { resolve, reject, dispose });
      signal?.addEventListener("abort", abort, { once: true });
      current.send(encodeRequest(id, tag));
    });
  };
  const rpc = Effect.fn("RemoteInstall.rpc")(function* (tag: string) {
    return yield* Effect.tryPromise({
      try: (signal) => request(tag, signal),
      catch: (cause) =>
        isInstallError(cause)
          ? cause
          : new RemoteInstallTransportError({ message: "Remote verification transport failed." }),
    });
  });
  const closeSocket = (): void => {
    socket?.close();
  };
  const observedIdentity = (config: unknown) => {
    const { environment } = decodeIdentity(config);
    if (!environment.bootId || !environment.storageInstanceId)
      throw new Error("Remote verification requires boot and storage identity.");
    return {
      bootId: environment.bootId,
      serverVersion: environment.serverVersion,
      storageInstanceId: environment.storageInstanceId,
    };
  };
  const readyIdentity = Effect.fn("RemoteInstall.readyIdentity")(function* (config: unknown) {
    const { environment } = yield* decodeIdentityEffect(config);
    if (!environment.bootId || !environment.storageInstanceId)
      return yield* new RemoteInstallTransportError({
        message: "The verified host has no boot or storage identity.",
      });
    if (input.requireWide) {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const addresses = yield* Effect.sync(() =>
        Object.values(NodeOS.networkInterfaces())
          .flatMap((entries) => entries ?? [])
          .filter((address) => address.family === "IPv4" && !address.internal),
      );
      let reachable = false;
      for (const address of addresses) {
        const observed = yield* client
          .get(`http://${address.address}:${endpoint.port}/.well-known/bibcode/environment`)
          .pipe(Effect.flatMap(readWideDescriptor), Effect.timeout(1_000), Effect.option);
        if (
          Option.isSome(observed) &&
          observed.value.bootId === environment.bootId &&
          observed.value.storageInstanceId === environment.storageInstanceId
        ) {
          reachable = true;
          break;
        }
      }
      if (!reachable)
        return yield* new RemoteInstallTransportError({
          message: "The verified boot is not reachable through its wide listener.",
        });
    }
    return {
      bootId: environment.bootId,
      serverVersion: environment.serverVersion,
      progress: environment.capabilities.remoteUpdateProgress ?? false,
    };
  }, Effect.provide(FetchHttpClient.layer));
  try {
    await open();
    const before = observedIdentity(await request("server.getConfig"));
    const work = decodeActiveWork(await request("updater.activeWork"));
    if (work.runningTurns !== 0 || work.liveTerminals !== 0 || work.queuedMessages !== 0)
      throw new Error("The remote verification host is not idle.");
    const port: RemoteUpdatePort = {
      connection: Effect.sync(() => ({
        phase,
        connectedEpoch,
        blockedMessage: phase === "blocked" ? "The verification session was rejected" : null,
      })),
      identity: rpc("server.getConfig").pipe(Effect.flatMap(readyIdentity)),
      status: rpc("updater.status").pipe(Effect.map(decodeSnapshot)),
      install: rpc("updater.install").pipe(Effect.map(decodeSnapshot)),
      retryNow: Effect.promise(async () => {
        if (phase === "blocked") return;
        try {
          await open();
        } catch {
          /* The coordinator owns retry bounds and reports connection state. */
        }
      }),
    };
    const phases: string[] = [];
    let sawPercent = false;
    let sawStage = false;
    // Local transfers can finish between the coordinator's one-second polls. This
    // test-only observer records brief progress without changing product deadlines.
    const progressAbort = new AbortController();
    const progressProbe = (async () => {
      while (!progressAbort.signal.aborted) {
        try {
          const snapshot = await Effect.runPromise(
            decodeSnapshotEffect(await request("updater.status", progressAbort.signal)),
          );
          if (snapshot.downloadPercent !== null) sawPercent = true;
          if (snapshot.installStage !== null) sawStage = true;
        } catch {
          if (progressAbort.signal.aborted) return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 50);
          function done() {
            clearTimeout(timer);
            progressAbort.signal.removeEventListener("abort", done);
            resolve();
          }
          progressAbort.signal.addEventListener("abort", done, { once: true });
        });
      }
    })();
    let result: RemoteUpdateRunState;
    try {
      result = await Effect.runPromise(
        runRemoteUpdate(port, (state: RemoteUpdateRunState) =>
          Effect.sync(() => {
            if (!phases.includes(state.phase)) phases.push(state.phase);
            if (state.phase === "downloading" && state.percent !== null) sawPercent = true;
            if (state.phase === "installing" && state.stage !== null) sawStage = true;
          }),
        ),
      );
    } finally {
      progressAbort.abort();
      await progressProbe;
    }
    if (result.phase !== "succeeded")
      throw new Error("Remote verification coordinator did not succeed.");
    return {
      before,
      after: observedIdentity(await request("server.getConfig")),
      phases,
      sawPercent,
      sawStage,
    };
  } finally {
    for (const waiter of pending.values()) {
      waiter.dispose();
      waiter.reject(new Error("Remote verification finished."));
    }
    pending.clear();
    closeSocket();
  }
}
