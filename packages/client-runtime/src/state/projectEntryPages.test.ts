import type {
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
} from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { PROJECT_ENTRY_PAGE_RESTARTS, readProjectEntryPages } from "./projectEntryPages.ts";

const entry = (path: string): ProjectEntry => ({ path, kind: "file" });
const stale = { _tag: "ProjectListEntriesError", failure: "search_index_cursor_stale" } as const;

/** A fake server: answers each request from `replies` in order and records what it was asked. */
function server(replies: ReadonlyArray<ProjectListEntriesResult | typeof stale>) {
  const requests: ProjectListEntriesInput[] = [];
  const requestPage = (input: ProjectListEntriesInput) => {
    requests.push(input);
    const reply = replies[requests.length - 1];
    if (reply === undefined) return Effect.die("unexpected request");
    return "failure" in reply ? Effect.fail(reply) : Effect.succeed(reply);
  };
  return { requests, requestPage };
}

describe("readProjectEntryPages", () => {
  it.effect("follows nextCursor and joins the pages into one list", () =>
    Effect.gen(function* () {
      const fake = server([
        { entries: [entry("a")], truncated: false, nextCursor: "7.1" },
        { entries: [entry("b")], truncated: false, nextCursor: "7.2" },
        { entries: [entry("c")], truncated: false },
      ]);
      const list = yield* readProjectEntryPages({ cwd: "/w", refresh: true }, fake.requestPage);
      expect(list).toEqual({ entries: [entry("a"), entry("b"), entry("c")], truncated: false });
      expect(fake.requests).toEqual([
        { cwd: "/w", refresh: true, paged: true },
        { cwd: "/w", cursor: "7.1" },
        { cwd: "/w", cursor: "7.2" },
      ]);
    }),
  );

  it.effect("takes an older server's whole list without nextCursor as one complete page", () =>
    Effect.gen(function* () {
      const whole = { entries: [entry("a"), entry("b")], truncated: true };
      const fake = server([whole]);
      const list = yield* readProjectEntryPages({ cwd: "/w" }, fake.requestPage);
      expect(list).toEqual(whole);
      expect(fake.requests).toHaveLength(1);
    }),
  );

  it.effect("starts over from the first page when the index changed mid-read", () =>
    Effect.gen(function* () {
      const fake = server([
        { entries: [entry("old-a")], truncated: false, nextCursor: "1.1" },
        stale,
        { entries: [entry("new-a")], truncated: false, nextCursor: "2.1" },
        { entries: [entry("new-b")], truncated: false },
      ]);
      const list = yield* readProjectEntryPages({ cwd: "/w", refresh: true }, fake.requestPage);
      // No page of the old snapshot survives, and the restart does not rebuild the index again.
      expect(list.entries).toEqual([entry("new-a"), entry("new-b")]);
      expect(fake.requests[2]).toEqual({ cwd: "/w", paged: true });
    }),
  );

  it.effect("fails with the stale-cursor error after the bounded restarts", () =>
    Effect.gen(function* () {
      const replies = Array.from({ length: PROJECT_ENTRY_PAGE_RESTARTS + 1 }, (_, index) => [
        { entries: [entry("a")], truncated: false, nextCursor: `${index}.1` },
        stale,
      ]).flat();
      const fake = server(replies);
      const error = yield* Effect.flip(readProjectEntryPages({ cwd: "/w" }, fake.requestPage));
      expect(error).toBe(stale);
      expect(fake.requests).toHaveLength(replies.length);
    }),
  );
});
