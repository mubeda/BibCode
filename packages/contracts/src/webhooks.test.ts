import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import { WebhooksListResult } from "./webhooks.ts";

const decodeList = Schema.decodeUnknownSync(WebhooksListResult);
const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);

/** An endpoint as a v0.14 server lists it: none of the fields added since. */
const olderEndpoint = {
  id: "w1",
  name: "CI",
  url: "https://hooks.example.com/bibcode",
  enabled: true,
  eventTypes: ["thread.status_changed"],
  projectId: null,
  pairedClientId: null,
  consecutiveFailures: 0,
  disabledReason: null,
  pendingDeliveries: 0,
  lastDeliveryState: null,
  droppedDeliveries: 0,
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
};

describe("webhook contracts across versions", () => {
  it("decodes an older server's list", () => {
    const list = decodeList({ enabled: true, endpoints: [olderEndpoint], maxEndpoints: 20 });
    expect(list.endpoints[0]!.eventTypes).toEqual(["thread.status_changed"]);
    expect(list.endpoints[0]!.bearerTokenSet).toBe(false);
  });

  it("keeps an event type a newer server added", () => {
    const list = decodeList({
      enabled: true,
      endpoints: [{ ...olderEndpoint, eventTypes: ["input.requested", "future.event"] }],
      maxEndpoints: 20,
    });
    expect(list.endpoints[0]!.eventTypes).toEqual(["input.requested", "future.event"]);
  });

  it("reads the webhook capabilities as off when an older server leaves them out", () => {
    const capabilities = decodeCapabilities({});
    expect(capabilities.webhookQuestionEvents).toBe(false);
    expect(capabilities.webhookBearerToken).toBe(false);
  });
});
