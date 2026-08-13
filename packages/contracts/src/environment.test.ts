import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { OrchestrationRpcSchemas } from "./orchestration.ts";

const decodeExecutionEnvironmentDescriptor = Schema.decodeUnknownSync(
  ExecutionEnvironmentDescriptor,
);

const descriptor = {
  environmentId: "local",
  label: "Local",
  platform: { os: "darwin" as const, arch: "arm64" as const },
  serverVersion: "0.1.0",
};

const LegacyExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  platform: Schema.Struct({
    os: Schema.Literals(["darwin", "linux", "windows", "unknown"]),
    arch: Schema.Literals(["arm64", "x64", "other"]),
  }),
  serverVersion: Schema.String,
  capabilities: Schema.Struct({
    repositoryIdentity: Schema.Boolean,
  }),
});
const decodeLegacyExecutionEnvironmentDescriptor = Schema.decodeUnknownSync(
  LegacyExecutionEnvironmentDescriptor,
);

const legacyClientDecoders = {
  "orchestration.dispatchCommand": Schema.decodeUnknownSync(
    OrchestrationRpcSchemas.dispatchCommand.output,
  ),
  "orchestration.subscribeThread": Schema.decodeUnknownSync(
    OrchestrationRpcSchemas.subscribeThread.output,
  ),
} as const;

describe("execution environment contracts", () => {
  it("defaults storage identity to null for an older remote descriptor", () => {
    const decoded = decodeExecutionEnvironmentDescriptor({
      ...descriptor,
      capabilities: { repositoryIdentity: true },
    });

    expect(decoded.storageInstanceId).toBeNull();
  });

  it("decodes a new server storage identity", () => {
    const decoded = decodeExecutionEnvironmentDescriptor({
      ...descriptor,
      storageInstanceId: "0d93cbea-f237-4f37-8829-d816667be35f",
      capabilities: { repositoryIdentity: true },
    });

    expect(decoded.storageInstanceId).toBe("0d93cbea-f237-4f37-8829-d816667be35f");
  });

  it("accepts a non-UUID storage identity from a third-party server", () => {
    const decoded = decodeExecutionEnvironmentDescriptor({
      ...descriptor,
      storageInstanceId: "third-party-store",
      capabilities: { repositoryIdentity: true },
    });

    expect(decoded.storageInstanceId).toBe("third-party-store");
  });

  it("trims surrounding whitespace from a supplied storage identity", () => {
    const decoded = decodeExecutionEnvironmentDescriptor({
      ...descriptor,
      storageInstanceId: "  third-party-store  ",
      capabilities: { repositoryIdentity: true },
    });

    expect(decoded.storageInstanceId).toBe("third-party-store");
  });

  it("rejects a whitespace-only storage identity", () => {
    expect(() =>
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        storageInstanceId: "   ",
        capabilities: { repositoryIdentity: true },
      }),
    ).toThrow();
  });

  it("defaults the activity protocol version for an old descriptor", () => {
    expect(
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        capabilities: { repositoryIdentity: true },
      }).capabilities.activityProtocolVersion,
    ).toBeNull();
  });

  it("allows a server descriptor to advertise activity protocol version 2", () => {
    expect(
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        capabilities: {
          repositoryIdentity: true,
          activityProtocolVersion: 2,
        },
      }).capabilities.activityProtocolVersion,
    ).toBe(2);
  });

  it("rejects obsolete and future activity protocol versions", () => {
    for (const activityProtocolVersion of [0, 1, 3]) {
      expect(() =>
        decodeExecutionEnvironmentDescriptor({
          ...descriptor,
          capabilities: {
            repositoryIdentity: true,
            activityProtocolVersion,
          },
        }),
      ).toThrow();
    }
  });

  it("keeps a legacy non-activity client compatible with additive descriptors and conversation traffic", () => {
    const legacyDescriptor = decodeLegacyExecutionEnvironmentDescriptor({
      ...descriptor,
      storageInstanceId: "0d93cbea-f237-4f37-8829-d816667be35f",
      capabilities: {
        repositoryIdentity: true,
        activityProtocolVersion: 1,
      },
    });
    const dispatchResponse = legacyClientDecoders["orchestration.dispatchCommand"]({
      sequence: 7,
      projectId: "project-1",
    });
    const conversationEvent = legacyClientDecoders["orchestration.subscribeThread"]({
      kind: "event",
      event: {
        sequence: 8,
        eventId: "event-1",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-07-29T12:00:00Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: "thread-1",
          messageId: "message-1",
          role: "assistant",
          text: "Conversation remains available.",
          turnId: null,
          streaming: false,
          createdAt: "2026-07-29T12:00:00Z",
          updatedAt: "2026-07-29T12:00:00Z",
        },
      },
    });

    expect(Object.keys(legacyClientDecoders)).toEqual([
      "orchestration.dispatchCommand",
      "orchestration.subscribeThread",
    ]);
    expect(legacyDescriptor.capabilities).toEqual({ repositoryIdentity: true });
    expect(dispatchResponse).toEqual({ sequence: 7, projectId: "project-1" });
    expect(conversationEvent.kind).toBe("event");
    if (conversationEvent.kind === "event") {
      expect(conversationEvent.event.type).toBe("thread.message-sent");
      expect(conversationEvent.event.payload).toMatchObject({
        threadId: "thread-1",
        text: "Conversation remains available.",
      });
    }
  });
});
