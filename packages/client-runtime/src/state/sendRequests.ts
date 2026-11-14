import type { SendRequest, SendRequestsStreamEvent } from "@bibcode/contracts";
import { WS_METHODS } from "@bibcode/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

const EMPTY_REQUESTS: ReadonlyArray<SendRequest> = [];

/** Newest first; ties order by id so a re-fold never reorders rows. */
function newestFirst(a: SendRequest, b: SendRequest): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
}

function merge(
  current: ReadonlyArray<SendRequest>,
  incoming: ReadonlyArray<SendRequest>,
): ReadonlyArray<SendRequest> {
  const byId = new Map(current.map((request) => [request.requestId, request]));
  for (const request of incoming) {
    const known = byId.get(request.requestId);
    // The row of the later `updatedAt` wins, so a late page never rolls a row back.
    if (known === undefined || request.updatedAt >= known.updatedAt) {
      byId.set(request.requestId, request);
    }
  }
  return [...byId.values()].sort(newestFirst);
}

/**
 * Folds one `sendRequests.subscribe` event into the list (newest first). Dismissed rows stay
 * in the list so that a page arriving later cannot bring them back; readers hide them.
 */
export function applySendRequestsEvent(
  current: ReadonlyArray<SendRequest>,
  event: SendRequestsStreamEvent,
): ReadonlyArray<SendRequest> {
  switch (event.type) {
    case "snapshot":
      return [...event.requests].sort(newestFirst);
    case "page":
      return merge(current, event.requests);
    case "upsert":
      return merge(current, [event.request]);
    case "remove":
      return current.filter((request) => request.requestId !== event.requestId);
  }
}

function project(
  current: ReadonlyArray<SendRequest>,
  event: SendRequestsStreamEvent,
): readonly [ReadonlyArray<SendRequest>, ReadonlyArray<ReadonlyArray<SendRequest>>] {
  const next = applySendRequestsEvent(current, event);
  return [next, [next]];
}

/** A person's requests to agents: four commands and the live list of one environment. */
export function createSendRequestsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    send: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:send-requests:send",
      tag: WS_METHODS.sendRequestsSend,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:send-requests:cancel",
      tag: WS_METHODS.sendRequestsCancel,
      scheduler,
    }),
    dismiss: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:send-requests:dismiss",
      tag: WS_METHODS.sendRequestsDismiss,
      scheduler,
    }),
    getAnswer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:send-requests:get-answer",
      tag: WS_METHODS.sendRequestsGetAnswer,
    }),
    requests: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:send-requests:requests",
      subscribe: (input: Record<string, never>) =>
        subscribe(WS_METHODS.sendRequestsSubscribe, input).pipe(
          Stream.mapAccum(() => EMPTY_REQUESTS, project),
        ),
    }),
  };
}
