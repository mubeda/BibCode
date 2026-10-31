import { ThreadId, type UiIntent } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applyUiIntentEvent, EMPTY_UI_INTENTS } from "./uiIntents.ts";

function intent(intentId: string): UiIntent {
  return {
    kind: "focus",
    intentId,
    threadId: ThreadId.make("thread-1"),
    surface: "files",
    path: "src/main.rs",
    actor: { kind: "mcp-client", clientId: "session-1", label: "Claude Code" },
    createdAt: "2026-10-31T00:00:00.000Z",
    expiresAt: "2026-10-31T00:01:00.000Z",
  };
}

describe("applyUiIntentEvent", () => {
  it("replaces on a snapshot and appends a new intent once", () => {
    const snapshot = applyUiIntentEvent(EMPTY_UI_INTENTS, {
      type: "snapshot",
      intents: [intent("a")],
    });
    expect(snapshot.map((entry) => entry.intentId)).toEqual(["a"]);
    const added = applyUiIntentEvent(snapshot, { type: "intent", intent: intent("b") });
    expect(added.map((entry) => entry.intentId)).toEqual(["a", "b"]);
    // The snapshot and the live event can both carry one published in between.
    expect(applyUiIntentEvent(added, { type: "intent", intent: intent("b") })).toBe(added);
  });

  it("keeps the newest 64", () => {
    let state = EMPTY_UI_INTENTS;
    for (let index = 0; index < 70; index += 1) {
      state = applyUiIntentEvent(state, { type: "intent", intent: intent(`i${index}`) });
    }
    expect(state).toHaveLength(64);
    expect(state[0]?.intentId).toBe("i6");
  });

  it("keeps the last commit message per folder apart from the focus cap", () => {
    let state = applyUiIntentEvent(EMPTY_UI_INTENTS, {
      type: "snapshot",
      intents: [commitMessage("m1", "/repo/a"), commitMessage("m2", "/repo/b")],
    });
    for (let index = 0; index < 70; index += 1) {
      state = applyUiIntentEvent(state, { type: "intent", intent: intent(`i${index}`) });
    }
    state = applyUiIntentEvent(state, {
      type: "intent",
      intent: commitMessage("m3", "/repo/a"),
    });
    const messages = state.filter((entry) => entry.kind === "commitMessage");
    expect(messages.map((entry) => entry.intentId)).toEqual(["m2", "m3"]);
    expect(state.filter((entry) => entry.kind === "focus")).toHaveLength(64);
  });
});

function commitMessage(intentId: string, cwd: string): UiIntent {
  return {
    kind: "commitMessage",
    intentId,
    threadId: ThreadId.make("thread-1"),
    cwd,
    message: "Fix the parser",
    actor: { kind: "mcp-client", clientId: "session-1", label: "Claude Code" },
    createdAt: "2026-10-31T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
  };
}
