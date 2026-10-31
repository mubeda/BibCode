import { WS_METHODS } from "@bibcode/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** How often an open Webhooks tab rereads the endpoints, so a failing one shows up. */
export const WEBHOOKS_REFRESH_INTERVAL_MS = 15_000;

/**
 * Outbound webhooks of one environment (#139, slice X8): the endpoints and their recent
 * deliveries, read with `access:read`, and the administration commands (`access:write`).
 * Commands of one environment run one at a time, so an edit never races a delete.
 */
export function createWebhooksEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:webhooks:list",
      tag: WS_METHODS.webhooksList,
      refreshIntervalMs: WEBHOOKS_REFRESH_INTERVAL_MS,
    }),
    deliveries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:webhooks:deliveries",
      tag: WS_METHODS.webhooksListDeliveries,
      refreshIntervalMs: WEBHOOKS_REFRESH_INTERVAL_MS,
    }),
    upsert: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:webhooks:upsert",
      tag: WS_METHODS.webhooksUpsert,
      scheduler,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:webhooks:delete",
      tag: WS_METHODS.webhooksDelete,
      scheduler,
    }),
    rotateSecret: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:webhooks:rotate-secret",
      tag: WS_METHODS.webhooksRotateSecret,
      scheduler,
    }),
    sendTest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:webhooks:send-test",
      tag: WS_METHODS.webhooksSendTest,
      scheduler,
    }),
    redeliver: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:webhooks:redeliver",
      tag: WS_METHODS.webhooksRedeliver,
      scheduler,
    }),
  };
}
