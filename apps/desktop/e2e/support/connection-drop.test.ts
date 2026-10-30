import { describe, expect, it } from "vite-plus/test";

import { threadDraftEntries } from "./connection-drop.ts";

function store(drafts: Record<string, { prompt?: string }>): string {
  return JSON.stringify({ state: { draftsByThreadKey: drafts } });
}

describe("threadDraftEntries", () => {
  it("returns the environment-scoped draft for exactly this thread id", () => {
    expect(
      threadDraftEntries(
        store({
          "environment-local:thread-1": { prompt: "kept" },
          "environment-local:thread-10": { prompt: "other thread" },
          "environment-local:prefix:thread-1": { prompt: "not a scoped key" },
        }),
        "thread-1",
      ),
    ).toEqual([{ key: "environment-local:thread-1", prompt: "kept" }]);
  });

  it("reports every environment's draft for a shared thread id so callers can require one", () => {
    expect(
      threadDraftEntries(
        store({
          "environment-local:thread-1": { prompt: "local" },
          "environment-remote:thread-1": {},
        }),
        "thread-1",
      ),
    ).toEqual([
      { key: "environment-local:thread-1", prompt: "local" },
      { key: "environment-remote:thread-1", prompt: "" },
    ]);
  });

  it("treats a missing store as no drafts", () => {
    expect(threadDraftEntries(null, "thread-1")).toEqual([]);
  });
});
