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
  it("defaults the activity protocol version for an old descriptor", () => {
    expect(
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        capabilities: { repositoryIdentity: true },
      }).capabilities.activityProtocolVersion,
    ).toBeNull();
  });

  it("allows a server descriptor to advertise activity protocol version 1", () => {
    expect(
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        capabilities: {
          repositoryIdentity: true,
          activityProtocolVersion: 1,
        },
      }).capabilities.activityProtocolVersion,
    ).toBe(1);
  });

  it("keeps a legacy non-activity client compatible with additive descriptors and conversation traffic", () => {
    const legacyDescriptor = decodeLegacyExecutionEnvironmentDescriptor({
      ...descriptor,
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
