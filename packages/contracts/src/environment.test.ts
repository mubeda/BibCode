import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { OrchestrationRpcSchemas } from "./orchestration.ts";

const decodeExecutionEnvironmentDescriptor = Schema.decodeUnknownSync(
  ExecutionEnvironmentDescriptor,
);

const descriptor = {
  environmentId: "018f0f74-9d2f-7b57-9f17-7ea4f26c7e42",
  label: "Local",
  platform: { os: "darwin" as const, arch: "arm64" as const },
  serverVersion: "0.1.0",
  storageInstanceId: "0d93cbea-f237-4f37-8829-d816667be35f",
  protocol: { minimum: 1, maximum: 1 },
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
  it("defaults passive VCS summary support to false for an old descriptor", () => {
    expect(
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        capabilities: { repositoryIdentity: true },
      }).capabilities.vcsStatusSummary,
    ).toBe(false);
  });

  it("defaults worktree catalog support to false for an old descriptor", () => {
    expect(
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        capabilities: { repositoryIdentity: true },
      }).capabilities.worktreeCatalog,
    ).toBe(false);
  });

  it("decodes an advertised complete worktree catalog surface", () => {
    expect(
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        capabilities: { repositoryIdentity: true, worktreeCatalog: true },
      }).capabilities.worktreeCatalog,
    ).toBe(true);
  });

  it("defaults worktree catalog refresh-reason support to false for an old descriptor", () => {
    expect(
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        capabilities: { repositoryIdentity: true, worktreeCatalog: true },
      }).capabilities.worktreeCatalogRefreshReason,
    ).toBe(false);
  });

  it("decodes advertised worktree catalog refresh-reason support", () => {
    expect(
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        capabilities: {
          repositoryIdentity: true,
          worktreeCatalog: true,
          worktreeCatalogRefreshReason: true,
        },
      }).capabilities.worktreeCatalogRefreshReason,
    ).toBe(true);
  });

  it("requires strict durable UUID identities", () => {
    expect(() =>
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        environmentId: "local",
        capabilities: { repositoryIdentity: true },
      }),
    ).toThrow();
    expect(() =>
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        storageInstanceId: "third-party-store",
        capabilities: { repositoryIdentity: true },
      }),
    ).toThrow();
  });

  it("decodes a new server storage identity", () => {
    const decoded = decodeExecutionEnvironmentDescriptor({
      ...descriptor,
      capabilities: { repositoryIdentity: true },
    });

    expect(decoded.storageInstanceId).toBe("0d93cbea-f237-4f37-8829-d816667be35f");
  });

  it("requires a bounded protocol range", () => {
    expect(() =>
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        protocol: { minimum: 2, maximum: 1 },
        capabilities: { repositoryIdentity: true },
      }),
    ).toThrow();
    expect(
      decodeExecutionEnvironmentDescriptor({
        ...descriptor,
        capabilities: { repositoryIdentity: true },
      }).protocol,
    ).toEqual({ minimum: 1, maximum: 1 });
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
