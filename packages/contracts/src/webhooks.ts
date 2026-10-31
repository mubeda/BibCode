import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Outbound webhooks (#139, slice X8): up to 20 HTTPS endpoints per environment, each sent the
 * events it chose, signed with its own secret. Administered with `access:read` and
 * `access:write`, which an outside agent's MCP session never holds.
 */

/** Every event an endpoint can choose, by category. `webhook.test` is sent on request only. */
export const WEBHOOK_EVENT_CATEGORIES = [
  {
    key: "threads",
    events: ["thread.status_changed", "worktree.created", "panel.created"],
  },
  { key: "approvals", events: ["approval.requested", "approval.resolved"] },
  {
    key: "operations",
    events: ["clone.completed", "scm.operation_completed", "transfer.completed", "transfer.failed"],
  },
  { key: "diagnostics", events: ["profiler.finding"] },
] as const;

export const WebhookEventType = Schema.Literals([
  "thread.status_changed",
  "worktree.created",
  "panel.created",
  "approval.requested",
  "approval.resolved",
  "clone.completed",
  "scm.operation_completed",
  "transfer.completed",
  "transfer.failed",
  "profiler.finding",
]);
export type WebhookEventType = typeof WebhookEventType.Type;

/** At most this many endpoints per environment. */
export const WEBHOOK_MAX_ENDPOINTS = 20;

/** Why an endpoint is off without a person turning it off. */
export const WebhookDisabledReason = Schema.Literals(["failures", "client-revoked"]);
export type WebhookDisabledReason = typeof WebhookDisabledReason.Type;

export const WebhookDeliveryState = Schema.Literals([
  "pending",
  "sending",
  "delivered",
  "failed",
  "abandoned",
]);
export type WebhookDeliveryState = typeof WebhookDeliveryState.Type;

export const WebhookEndpoint = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  url: Schema.String,
  enabled: Schema.Boolean,
  eventTypes: Schema.Array(WebhookEventType),
  projectId: Schema.NullOr(Schema.String),
  /** The outside agent's session it is paired with: revoking that client disables it. */
  pairedClientId: Schema.NullOr(Schema.String),
  consecutiveFailures: NonNegativeInt,
  disabledReason: Schema.NullOr(WebhookDisabledReason),
  pendingDeliveries: NonNegativeInt,
  lastDeliveryState: Schema.NullOr(WebhookDeliveryState),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WebhookEndpoint = typeof WebhookEndpoint.Type;

export const WebhookDelivery = Schema.Struct({
  deliveryId: TrimmedNonEmptyString,
  /** The same for each delivery of one event, so a receiver drops repeats. */
  eventId: TrimmedNonEmptyString,
  eventType: Schema.String,
  state: WebhookDeliveryState,
  attempts: NonNegativeInt,
  lastStatus: Schema.NullOr(Schema.Int),
  /**
   * Why the last attempt failed: `status` (see `lastStatus`), `timeout`, `connect`,
   * `unresolved`, `address_refused`, `url_refused`, `redirect`, `cancelled`, `queue_full`
   * or `interrupted`.
   */
  lastError: Schema.NullOr(Schema.String),
  latencyMs: Schema.NullOr(NonNegativeInt),
  /** When a pending delivery is tried next. */
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WebhookDelivery = typeof WebhookDelivery.Type;

export const WebhooksListInput = Schema.Struct({});
export const WebhooksListResult = Schema.Struct({
  /** `enableWebhooks`. */
  enabled: Schema.Boolean,
  endpoints: Schema.Array(WebhookEndpoint),
  maxEndpoints: NonNegativeInt,
});
export type WebhooksListResult = typeof WebhooksListResult.Type;

export const WebhooksListDeliveriesInput = Schema.Struct({
  endpointId: TrimmedNonEmptyString,
  /** 50 unless set; at most 200. */
  limit: Schema.optional(NonNegativeInt),
});
export type WebhooksListDeliveriesInput = typeof WebhooksListDeliveriesInput.Type;
export const WebhooksListDeliveriesResult = Schema.Struct({
  /** Newest first. */
  deliveries: Schema.Array(WebhookDelivery),
});
export type WebhooksListDeliveriesResult = typeof WebhooksListDeliveriesResult.Type;

/** Adds an endpoint (no `id`) or replaces one's editable fields. */
export const WebhooksUpsertInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: TrimmedNonEmptyString,
  /** `https://` with a public host and no user name or password. */
  url: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  eventTypes: Schema.Array(WebhookEventType),
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  pairedClientId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type WebhooksUpsertInput = typeof WebhooksUpsertInput.Type;
export const WebhooksUpsertResult = Schema.Struct({
  endpoint: WebhookEndpoint,
  /** Only when the endpoint is new: shown once, never returned again. */
  secret: Schema.optional(Schema.String),
});
export type WebhooksUpsertResult = typeof WebhooksUpsertResult.Type;

export const WebhooksEndpointInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type WebhooksEndpointInput = typeof WebhooksEndpointInput.Type;

export const WebhooksDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type WebhooksDeleteResult = typeof WebhooksDeleteResult.Type;

/** A new secret, shown once; the old one stops verifying at once. */
export const WebhooksRotateSecretResult = Schema.Struct({ secret: Schema.String });
export type WebhooksRotateSecretResult = typeof WebhooksRotateSecretResult.Type;

export const WebhooksRedeliverInput = Schema.Struct({ deliveryId: TrimmedNonEmptyString });
export type WebhooksRedeliverInput = typeof WebhooksRedeliverInput.Type;

/** `webhooks.sendTest` and `webhooks.redeliver`: the delivery after its first attempt. */
export const WebhooksSendResult = Schema.Struct({ delivery: WebhookDelivery });
export type WebhooksSendResult = typeof WebhooksSendResult.Type;

export class WebhookError extends Schema.TaggedError<WebhookError>()("WebhookError", {
  /**
   * `invalid`, `not_found`, `limit` (20 endpoints), `webhooks_off`, `endpoint_disabled` or
   * `storage`.
   */
  reason: Schema.Literals([
    "invalid",
    "not_found",
    "limit",
    "webhooks_off",
    "endpoint_disabled",
    "storage",
  ]),
  message: Schema.String,
}) {}
