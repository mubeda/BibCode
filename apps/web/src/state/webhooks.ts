import type { EnvironmentId, WebhookEndpoint } from "@bibcode/contracts";
import { createWebhooksEnvironmentAtoms } from "@bibcode/client-runtime/state/webhooks";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const webhooksEnvironment = createWebhooksEnvironmentAtoms(connectionAtomRuntime);

/** One environment's webhook endpoints (`webhooks.list`); `null` reads nothing. */
export function useWebhookList(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : webhooksEnvironment.list({ environmentId, input: {} }),
  );
}

/** An endpoint that is off without a person turning it off, or whose deliveries are failing. */
export function isFailingEndpoint(endpoint: WebhookEndpoint): boolean {
  return endpoint.disabledReason !== null || (endpoint.enabled && endpoint.consecutiveFailures > 0);
}
