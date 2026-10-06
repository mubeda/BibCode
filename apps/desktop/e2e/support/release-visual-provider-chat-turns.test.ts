// @effect-diagnostics nodeBuiltinImport:off - Genuine contract decoding with inert native input records only.
import * as NodeModule from "node:module";
import { OrchestrationThread } from "../../../../packages/contracts/src/orchestration.ts";
import * as Turns from "./release-visual-provider-chat-turns.ts";
import { expect, it } from "vite-plus/test";
const Schema = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const api = Turns as unknown as {
  bindProviderChatMessage: (input: object) => object;
  verifyProviderChatDelivery: (input: object) => object;
  verifyProviderChatCheckpoint: (thread: OrchestrationThread, binding: object) => object;
};
const time = "2026-10-05T00:00:00.000Z";
function thread(
  messages: unknown[] = [],
  state: "running" | "completed" | "error" = "running",
): OrchestrationThread {
  return Schema.decodeUnknownSync(OrchestrationThread)({
    id: "owned-panel",
    projectId: "owned-project",
    title: "Owned panel",
    kind: "panel",
    branch: "codex/delivery-retry-light",
    worktreePath: "/owned/managed",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    latestTurn: messages.length
      ? {
          turnId: "native-turn",
          state,
          requestedAt: time,
          startedAt: time,
          completedAt: state === "running" ? null : time,
          assistantMessageId: "assistant-native",
        }
      : null,
    createdAt: time,
    updatedAt: time,
    deletedAt: null,
    messages,
    activities: [],
    checkpoints: [],
    session: {
      threadId: "owned-panel",
      status: state === "running" ? "running" : state === "error" ? "error" : "ready",
      providerName: "codex",
      providerInstanceId: "codex",
      activeTurnId: state === "running" ? "native-turn" : null,
      runtimeMode: "full-access",
      lastError: null,
      updatedAt: time,
    },
  });
}
const user = {
  id: "owned-message",
  role: "user",
  text: "Owned visual partial reply [[slow]]",
  turnId: "native-turn",
  streaming: false,
  delivery: { state: "delivered", provider: "codex", providerInstanceId: "codex", mode: "start" },
  createdAt: time,
  updatedAt: time,
};
const assistant = {
  id: "assistant-native",
  role: "assistant",
  text: "BiBCode deterministic streamed fixture response.",
  turnId: "native-turn",
  streaming: true,
  createdAt: time,
  updatedAt: time,
};
const queued = {
  id: "owned-queue",
  role: "user",
  text: "Owned visual message waiting behind partial reply",
  turnId: null,
  streaming: false,
  delivery: {
    state: "queued",
    provider: "codex",
    providerInstanceId: "codex",
    mode: "start",
    held: true,
  },
  createdAt: time,
  updatedAt: time,
};
const native = [
  { provider: "codex", kind: "start", prompt: user.text, turnId: "native-turn", recordedAt: time },
];

it("binds the exact new decoded user/native turn without manufactured metadata", () => {
  expect(api.bindProviderChatMessage).toBeTypeOf("function");
  const bound = api.bindProviderChatMessage({
    before: thread(),
    after: thread([user, assistant]),
    prompt: user.text,
    provider: "codex",
    state: "running",
    inputs: native,
    beforeInputCount: 0,
  });
  expect(bound).toMatchObject({ messageId: user.id, turnId: "native-turn" });
});
it.each(["native-id", "duplicate-input", "duplicate-message", "instance", "thread"])(
  "refuses an unjoined message/native turn: %s",
  (mode) => {
    expect(api.bindProviderChatMessage).toBeTypeOf("function");
    const originalAfter = thread([
      user,
      assistant,
      ...(mode === "duplicate-message" ? [{ ...user, id: "duplicate" }] : []),
    ]);
    const inputs =
      mode === "duplicate-input"
        ? [...native, ...native]
        : mode === "native-id"
          ? [{ ...native[0], turnId: "foreign" }]
          : native;
    const after: OrchestrationThread = Schema.decodeUnknownSync(OrchestrationThread)({
      ...originalAfter,
      ...(mode === "instance"
        ? { session: { ...originalAfter.session, providerInstanceId: "foreign" } }
        : {}),
      ...(mode === "thread" ? { id: "foreign" } : {}),
    });
    expect(() =>
      api.bindProviderChatMessage({
        before: thread(),
        after,
        prompt: user.text,
        provider: "codex",
        state: "running",
        inputs,
        beforeInputCount: 0,
      }),
    ).toThrow("Owned provider turn proof refused.");
  },
);
it("proves the exact ended partial turn and held FIFO after real loss, refusing a resend", () => {
  expect(api.verifyProviderChatDelivery).toBeTypeOf("function");
  const binding = {
    messageId: user.id,
    turnId: "native-turn",
    threadId: "owned-panel",
    provider: "codex",
    prompt: user.text,
    beforeInputCount: 0,
  };
  const loss = thread([user, { ...assistant, streaming: false }, queued], "error");
  expect(
    api.verifyProviderChatDelivery({
      scene: "chat-held-workspace-loss",
      thread: loss,
      original: binding,
      queuedMessageId: queued.id,
      inputs: native,
    }),
  ).toMatchObject({ exactNativeTurn: true, exactFifo: true, noAutomaticResend: true });
  expect(() =>
    api.verifyProviderChatDelivery({
      scene: "chat-held-workspace-loss",
      thread: loss,
      original: binding,
      queuedMessageId: queued.id,
      inputs: [...native, { ...native[0], prompt: queued.text }],
    }),
  ).toThrow("Owned provider turn proof refused.");
});
it("requires actual model-refused failure and the exact later queue with no native dispatch", () => {
  expect(api.verifyProviderChatDelivery).toBeTypeOf("function");
  const failed = {
    ...user,
    text: "Owned visual refused option",
    turnId: null,
    delivery: { ...user.delivery, state: "failed", reason: "modelSelectionRefused" },
  };
  const second = {
    ...queued,
    text: "Owned visual message waiting behind refusal",
    delivery: { ...queued.delivery, held: false },
  };
  const value = thread([failed, second], "completed");
  const binding = {
    messageId: failed.id,
    turnId: null,
    threadId: "owned-panel",
    provider: "codex",
    prompt: failed.text,
    beforeInputCount: 0,
  };
  expect(
    api.verifyProviderChatDelivery({
      scene: "chat-refused-model",
      thread: value,
      original: binding,
      queuedMessageId: second.id,
      inputs: [],
    }),
  ).toMatchObject({ exactFifo: true, modelSelectionRefused: true, noAutomaticResend: true });
  const malformed = thread(
    [{ ...failed, delivery: { ...failed.delivery, reason: undefined } }, second],
    "completed",
  );
  expect(() =>
    api.verifyProviderChatDelivery({
      scene: "chat-refused-model",
      thread: malformed,
      original: binding,
      queuedMessageId: second.id,
      inputs: [],
    }),
  ).toThrow();
});
it("joins the completed plan to its real checkpoint file and assistant", () => {
  expect(api.verifyProviderChatCheckpoint).toBeTypeOf("function");
  const value: OrchestrationThread = Schema.decodeUnknownSync(OrchestrationThread)({
    ...thread([user, { ...assistant, streaming: false }], "completed"),
    proposedPlans: [
      {
        id: "owned-plan",
        turnId: "native-turn",
        planMarkdown: "# Owned visual plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: time,
        updatedAt: time,
      },
    ],
    checkpoints: [
      {
        turnId: "native-turn",
        checkpointTurnCount: 2,
        checkpointRef: "refs/bibcode/checkpoints/owned-panel/turn/2",
        status: "ready",
        files: [{ path: "visual-chat.ts", kind: "modified", additions: 1, deletions: 1 }],
        assistantMessageId: "assistant-native",
        completedAt: time,
      },
    ],
  });
  expect(
    api.verifyProviderChatCheckpoint(value, { messageId: user.id, turnId: "native-turn" }),
  ).toMatchObject({ checkpointFileJoined: true, planTurnJoined: true });
  const wrongCheckpoint: OrchestrationThread = Schema.decodeUnknownSync(OrchestrationThread)({
    ...value,
    checkpoints: [{ ...value.checkpoints[0], turnId: "foreign" }],
  });
  expect(() =>
    api.verifyProviderChatCheckpoint(wrongCheckpoint, {
      messageId: user.id,
      turnId: "native-turn",
    }),
  ).toThrow();
});
