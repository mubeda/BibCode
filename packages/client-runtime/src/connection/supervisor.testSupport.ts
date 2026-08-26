import type { EnvironmentId } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  EnvironmentSupervisor,
  legacyCatalogEnvironment,
  type EnvironmentRouteResult,
} from "./supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";

interface ConnectedSupervisorTestOptions {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly client: WsRpcProtocolClient;
  readonly state?: SupervisorConnectionState;
}

/** Creates a structurally complete connected supervisor for state-layer tests. */
export const makeConnectedSupervisorForTest = Effect.fn(
  "EnvironmentSupervisor.makeConnectedForTest",
)(function* (options: ConnectedSupervisorTestOptions) {
  const target = new PrimaryConnectionTarget({
    environmentId: options.environmentId,
    label: options.label,
    httpBaseUrl: "http://127.0.0.1:43110",
    wsBaseUrl: "ws://127.0.0.1:43110",
  });
  const session: RpcSession.RpcSession = {
    client: options.client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };

  return EnvironmentSupervisor.of({
    environment: legacyCatalogEnvironment({ target, profile: Option.none() }),
    target,
    activeRouteId: yield* SubscriptionRef.make<string | null>(null),
    routeResults: yield* SubscriptionRef.make<ReadonlyArray<EnvironmentRouteResult>>([]),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(
      options.state ?? {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "connected",
        generation: 1,
      },
    ),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor["Service"]);
});
