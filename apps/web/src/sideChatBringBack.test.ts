import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import { applyThreadDetailEvent } from "@bibcode/client-runtime/state/thread-reducer";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@bibcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  drafts: new Map<string, string>(),
  hostChatsOpened: [] as string[],
}));

vi.mock("./composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: (ref: { threadId: string }) => {
        const prompt = h.drafts.get(ref.threadId);
        return prompt === undefined ? null : { prompt };
      },
      setPrompt: (ref: { threadId: string }, prompt: string) => h.drafts.set(ref.threadId, prompt),
    }),
  },
}));
vi.mock("./centerPanelStore", () => ({
  useCenterPanelStore: {
    getState: () => ({
      openHostChat: (ref: { threadId: string }) => h.hostChatsOpened.push(ref.threadId),
    }),
  },
}));

import {
  BRING_BACK_HOST_RUNNING_REASON,
  BRING_BACK_NO_ANSWER_REASON,
  bringBackToHost,
  composeSideChatBringBack,
  resolveBringBackUnavailableReason,
} from "./sideChatBringBack";

// Each message is created after the one before it, as a conversation is.
let clock = 0;
const createdAt = () => `2026-11-03T00:00:${String((clock += 1) % 60).padStart(2, "0")}.000Z`;
const user = (text: string) => ({
  role: "user" as const,
  text,
  streaming: false,
  turnId: null,
  createdAt: createdAt(),
});
const assistant = (text: string, streaming = false) => ({
  role: "assistant" as const,
  text,
  streaming,
  turnId: TurnId.make(`turn-${clock}`),
  createdAt: createdAt(),
});
const HOST = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("host"));

describe("composeSideChatBringBack", () => {
  it("quotes the last answer under the question it answers", () => {
    expect(
      composeSideChatBringBack([
        user("first"),
        assistant("old answer"),
        user("why did you pick that file?\nmore detail"),
        assistant("Because it owns the parser.\n\nSee `parse.ts`."),
      ]),
    ).toBe(
      "From the side chat (asked: why did you pick that file?):\n\n" +
        "> Because it owns the parser.\n>\n> See `parse.ts`.",
    );
  });

  it("skips an answer still streaming and has nothing before the first answer", () => {
    expect(composeSideChatBringBack([user("q")])).toBeNull();
    expect(composeSideChatBringBack([user("q"), assistant("partial", true)])).toBeNull();
    expect(
      composeSideChatBringBack([user("q1"), assistant("done"), user("q2"), assistant("hal", true)]),
    ).toBe("From the side chat (asked: q1):\n\n> done");
  });

  it("names the question that started the answer's turn, not one queued meanwhile", () => {
    // The real reducer: A is sent and starts turn 1, B is queued behind it, then A's answer
    // streams in. The list reads [A, B, answer-A].
    const at = (minute: number) => `2026-11-03T00:${String(minute).padStart(2, "0")}:00.000Z`;
    let sequence = 0;
    let thread: OrchestrationThread = {
      id: ThreadId.make("side"),
      projectId: ProjectId.make("project"),
      title: "Panel: Side chat · Codex",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: at(0),
      updatedAt: at(0),
      archivedAt: null,
      deletedAt: null,
      messages: [],
      reasoning: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    };
    const apply = (type: string, payload: Record<string, unknown>, minute: number) => {
      sequence += 1;
      const result = applyThreadDetailEvent(thread, {
        sequence,
        eventId: EventId.make(`event-${sequence}`),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        occurredAt: at(minute),
        aggregateKind: "thread",
        aggregateId: thread.id,
        type,
        payload: { threadId: thread.id, ...payload },
      } as never);
      if (result.kind === "updated") thread = result.thread;
    };
    const sent = (id: string, role: string, text: string, turnId: string | null, minute: number) =>
      apply(
        "thread.message-sent",
        {
          messageId: MessageId.make(id),
          role,
          text,
          turnId: turnId === null ? null : TurnId.make(turnId),
          streaming: false,
          createdAt: at(minute),
          updatedAt: at(minute),
        },
        minute,
      );
    const delivery = (id: string, state: string, minute: number) =>
      apply(
        "thread.turn-delivery-updated",
        {
          messageId: MessageId.make(id),
          delivery: { state, provider: "codex", mode: "start" },
          mode: "start",
          updatedAt: at(minute),
        },
        minute,
      );
    sent("a", "user", "question A", null, 1);
    apply(
      "thread.turn-start-requested",
      {
        messageId: MessageId.make("a"),
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: at(1),
      },
      1,
    );
    delivery("a", "delivered", 2);
    sent("b", "user", "question B", null, 3);
    delivery("b", "queued", 3);
    sent("answer-a", "assistant", "answer to A", "turn-1", 4);
    expect(thread.messages.map((message) => message.id)).toEqual(["a", "b", "answer-a"]);

    expect(composeSideChatBringBack(thread.messages)).toBe(
      "From the side chat (asked: question A):\n\n> answer to A",
    );
  });

  it("shortens a long question", () => {
    const summary = composeSideChatBringBack([user("x".repeat(200)), assistant("a")])!;
    expect(summary.split("\n", 1)[0]).toBe(`From the side chat (asked: ${"x".repeat(117)}...):`);
  });
});

describe("resolveBringBackUnavailableReason", () => {
  it("is unavailable while the host runs, and before an answer", () => {
    expect(resolveBringBackUnavailableReason({ hostRunning: true, summary: "s" })).toBe(
      BRING_BACK_HOST_RUNNING_REASON,
    );
    expect(BRING_BACK_HOST_RUNNING_REASON).toBe("Available when the thread is idle.");
    expect(resolveBringBackUnavailableReason({ hostRunning: false, summary: null })).toBe(
      BRING_BACK_NO_ANSWER_REASON,
    );
    expect(resolveBringBackUnavailableReason({ hostRunning: false, summary: "s" })).toBeNull();
  });
});

describe("bringBackToHost", () => {
  beforeEach(() => {
    h.drafts.clear();
    h.hostChatsOpened.length = 0;
  });

  it("writes the summary into an empty host draft and shows the host chat", () => {
    bringBackToHost(HOST, "summary");
    expect(h.drafts.get("host")).toBe("summary");
    expect(h.hostChatsOpened).toEqual(["host"]);
  });

  it("keeps what the user already typed in the host composer", () => {
    h.drafts.set("host", "my own notes  \n");
    bringBackToHost(HOST, "summary");
    expect(h.drafts.get("host")).toBe("my own notes\n\nsummary");
  });
});
