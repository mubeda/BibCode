import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
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

const user = (text: string) => ({ role: "user" as const, text, streaming: false });
const assistant = (text: string, streaming = false) => ({
  role: "assistant" as const,
  text,
  streaming,
});
const HOST = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("host"));

describe("composeSideChatBringBack", () => {
  it("quotes the last finished answer", () => {
    expect(
      composeSideChatBringBack([
        user("first"),
        assistant("old answer"),
        user("why did you pick that file?"),
        assistant("Because it owns the parser.\n\nSee `parse.ts`."),
      ]),
    ).toBe("From the side chat:\n\n> Because it owns the parser.\n>\n> See `parse.ts`.");
  });

  it("skips an answer still streaming and has nothing before the first answer", () => {
    expect(composeSideChatBringBack([user("q")])).toBeNull();
    expect(composeSideChatBringBack([user("q"), assistant("partial", true)])).toBeNull();
    expect(
      composeSideChatBringBack([user("q1"), assistant("done"), user("q2"), assistant("hal", true)]),
    ).toBe("From the side chat:\n\n> done");
  });

  it("quotes the answer that follows a question queued while it ran", () => {
    // A is sent, B is queued behind A's turn, then A's answer lands: [A, B, answer-A].
    expect(
      composeSideChatBringBack([user("question A"), user("question B"), assistant("answer to A")]),
    ).toBe("From the side chat:\n\n> answer to A");
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
