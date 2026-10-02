import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  scheduler: { name: "scheduler" },
  configs: [] as Array<Record<string, unknown>>,
  operations: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("./runtime.ts", () => ({
  createAtomCommandScheduler: () => harness.scheduler,
  createEnvironmentCommand: (_runtime: unknown, config: Record<string, unknown>) => {
    harness.configs.push(config);
    return { label: config.label };
  },
}));

vi.mock("../operations/commands.ts", () => {
  const names = [
    "archiveThread",
    "createThread",
    "deleteThread",
    "interruptThreadTurn",
    "respondToThreadApproval",
    "respondToThreadUserInput",
    "resolveTurnDelivery",
    "revertThreadCheckpoint",
    "setThreadInteractionMode",
    "setThreadRuntimeMode",
    "startThreadTurn",
    "steerThreadTurn",
    "promoteThreadTurn",
    "stopThreadSession",
    "unarchiveThread",
    "updateThreadMetadata",
  ];
  return Object.fromEntries(
    names.map((name) => {
      const operation = vi.fn((input: unknown) => ({ name, input }));
      harness.operations.set(name, operation);
      return [name, operation];
    }),
  );
});

import { createThreadEnvironmentAtoms } from "./threadCommands.ts";
vi.mock("../operations/attachmentAdmissionAuthority.ts", () => ({
  readAttachmentAdmissionAuthority: () => ({ name: "readAttachmentAdmissionAuthority" }),
  admitStagedThreadTurn: (input: unknown, authority: unknown) => ({
    name: "admitStagedThreadTurn",
    input,
    authority,
  }),
}));
vi.mock("../operations/attachmentStaging.ts", () =>
  Object.fromEntries(
    ["stageAttachments", "releaseStagedAttachments", "keepStagedAttachmentsAlive"].map((name) => {
      const operation = vi.fn((input: unknown) => ({ name, input }));
      harness.operations.set(name, operation);
      return [name, operation];
    }),
  ),
);

describe("createThreadEnvironmentAtoms", () => {
  it("creates serial per-thread commands and delegates every operation", () => {
    harness.configs.length = 0;
    const runtime = { name: "runtime" } as never;
    const atoms = createThreadEnvironmentAtoms(runtime);
    const expected = [
      ["create", "createThread"],
      ["delete", "deleteThread"],
      ["archive", "archiveThread"],
      ["unarchive", "unarchiveThread"],
      ["updateMetadata", "updateThreadMetadata"],
      ["setRuntimeMode", "setThreadRuntimeMode"],
      ["setInteractionMode", "setThreadInteractionMode"],
      ["startTurn", "startThreadTurn"],
      ["steerTurn", "steerThreadTurn"],
      ["promoteTurn", "promoteThreadTurn"],
      ["interruptTurn", "interruptThreadTurn"],
      ["resolveDelivery", "resolveTurnDelivery"],
      ["respondToApproval", "respondToThreadApproval"],
      ["respondToUserInput", "respondToThreadUserInput"],
      ["revertCheckpoint", "revertThreadCheckpoint"],
      ["stopSession", "stopThreadSession"],
    ] as const;

    expect(Object.keys(atoms)).toEqual([
      "attachmentAdmissionAuthority",
      "stageAttachments",
      "releaseStagedAttachments",
      "keepStagedAttachmentsAlive",
      ...expected.map(([key]) => key),
    ]);
    expect(harness.configs).toHaveLength(expected.length + 4);
    expect(harness.configs[0]?.scheduler).toBeUndefined();
    expect((harness.configs[0]!.execute as () => unknown)()).toEqual({
      name: "readAttachmentAdmissionAuthority",
    });
    for (const [index, name] of [
      "stageAttachments",
      "releaseStagedAttachments",
      "keepStagedAttachmentsAlive",
    ].entries()) {
      const config = harness.configs[index + 1]!;
      expect(config.scheduler).toBeUndefined();
      expect(config.concurrency).toBeUndefined();
      expect(config.timeoutMs).toBeUndefined();
      const input = { attachments: [] };
      expect((config.execute as (value: unknown) => unknown)(input)).toEqual({ name, input });
    }
    for (const [index, [, operationName]] of expected.entries()) {
      const config = harness.configs[index + 4]!;
      const input = { threadId: `thread-${index}` };
      expect(config.scheduler).toBe(harness.scheduler);
      expect(config.concurrency).toMatchObject({ mode: "serial" });
      expect((config.execute as (value: unknown) => unknown)(input)).toEqual({
        name: operationName,
        input,
      });
      expect(harness.operations.get(operationName)).toHaveBeenCalledWith(input);
    }

    const concurrency = harness.configs[4]!.concurrency as {
      key: (value: { environmentId: string; input: { threadId: string } }) => string;
    };
    expect(concurrency.key({ environmentId: "env-1", input: { threadId: "thread-1" } })).toBe(
      '["env-1","thread-1"]',
    );
  });
});
