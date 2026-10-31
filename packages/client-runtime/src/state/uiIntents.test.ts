import { ThreadId, type UiIntent } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applyUiIntentEvent, EMPTY_UI_INTENTS } from "./uiIntents.ts";

/** The fixtures' clock: every intent below is pending at this time. */
const NOW = Date.parse("2026-10-31T00:00:00.000Z");
const DAY = 86_400_000;

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
    expiresInMs: 60_000,
  };
}

function commitMessage(
  intentId: string,
  cwd: string,
  sequence: number,
  bootId = "boot-1",
): UiIntent {
  return {
    kind: "commitMessage",
    intentId,
    bootId,
    sequence,
    threadId: ThreadId.make("thread-1"),
    cwd,
    message: "Fix the parser",
    actor: { kind: "mcp-client", clientId: "session-1", label: "Claude Code" },
    createdAt: "2026-10-31T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    expiresInMs: DAY,
  };
}

const ids = (state: ReadonlyArray<UiIntent>) => state.map((entry) => entry.intentId);

describe("applyUiIntentEvent", () => {
  it("replaces on a snapshot and appends a new intent once", () => {
    const snapshot = applyUiIntentEvent(
      EMPTY_UI_INTENTS,
      { type: "snapshot", intents: [intent("a")] },
      NOW,
    );
    expect(ids(snapshot)).toEqual(["a"]);
    const added = applyUiIntentEvent(snapshot, { type: "intent", intent: intent("b") }, NOW);
    expect(ids(added)).toEqual(["a", "b"]);
    // The snapshot and the live event can both carry one published in between.
    expect(applyUiIntentEvent(added, { type: "intent", intent: intent("b") }, NOW)).toBe(added);
  });

  it("keeps the newest 64", () => {
    let state = EMPTY_UI_INTENTS;
    for (let index = 0; index < 70; index += 1) {
      state = applyUiIntentEvent(state, { type: "intent", intent: intent(`i${index}`) }, NOW);
    }
    expect(state).toHaveLength(64);
    expect(state[0]?.intentId).toBe("i6");
  });

  it("keeps the last commit message per folder apart from the focus cap", () => {
    let state = applyUiIntentEvent(
      EMPTY_UI_INTENTS,
      {
        type: "snapshot",
        intents: [commitMessage("m1", "/repo/a", 1), commitMessage("m2", "/repo/b", 2)],
      },
      NOW,
    );
    for (let index = 0; index < 70; index += 1) {
      state = applyUiIntentEvent(state, { type: "intent", intent: intent(`i${index}`) }, NOW);
    }
    state = applyUiIntentEvent(
      state,
      { type: "intent", intent: commitMessage("m3", "/repo/a", 3) },
      NOW,
    );
    expect(ids(state.filter((entry) => entry.kind === "commitMessage"))).toEqual(["m2", "m3"]);
    expect(state.filter((entry) => entry.kind === "focus")).toHaveLength(64);
  });

  it("keeps a folder's highest sequence, whatever order the messages arrive in", () => {
    // A snapshot can carry a newer message than a live event still on its way.
    let state = applyUiIntentEvent(
      EMPTY_UI_INTENTS,
      { type: "snapshot", intents: [commitMessage("newer", "/repo", 7)] },
      NOW,
    );
    state = applyUiIntentEvent(
      state,
      { type: "intent", intent: commitMessage("older", "/repo", 6) },
      NOW,
    );
    expect(ids(state)).toEqual(["newer"]);
  });

  it("takes a restarted server's message as newer, even with a lower sequence", () => {
    // A clock set back across a restart can issue a lower sequence; the boot differs.
    let state = applyUiIntentEvent(
      EMPTY_UI_INTENTS,
      { type: "snapshot", intents: [commitMessage("before", "/repo", 100, "boot-1")] },
      NOW,
    );
    state = applyUiIntentEvent(
      state,
      { type: "intent", intent: commitMessage("after", "/repo", 5, "boot-2") },
      NOW,
    );
    expect(ids(state)).toEqual(["after"]);
  });

  it("drops intents when the time they had left runs out on this client", () => {
    const pending = applyUiIntentEvent(
      EMPTY_UI_INTENTS,
      { type: "snapshot", intents: [intent("focus"), commitMessage("message", "/repo", 1)] },
      NOW,
    );
    expect(pending).toHaveLength(2);
    // A minute later the focus intent is gone; a day later the message is too.
    const minute = applyUiIntentEvent(
      pending,
      { type: "intent", intent: commitMessage("other", "/repo/b", 2) },
      NOW + 60_000,
    );
    expect(ids(minute)).toEqual(["message", "other"]);
    const day = applyUiIntentEvent(minute, { type: "intent", intent: intent("later") }, NOW + DAY);
    expect(ids(day)).toEqual(["other", "later"]);
  });

  it("keeps a fresh suggestion on a client whose clock runs 25 hours ahead", () => {
    // By this client's clock the server's expiresAt has passed; the time left has not.
    const ahead = NOW + 25 * 3_600_000;
    const state = applyUiIntentEvent(
      EMPTY_UI_INTENTS,
      { type: "intent", intent: commitMessage("fresh", "/repo", 1) },
      ahead,
    );
    expect(ids(state)).toEqual(["fresh"]);
    expect(state[0]?.deadline).toBe(ahead + DAY);
    const expired = applyUiIntentEvent(
      state,
      { type: "intent", intent: intent("later") },
      ahead + DAY,
    );
    expect(ids(expired)).toEqual(["later"]);
  });
});
