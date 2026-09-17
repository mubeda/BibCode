import { describe, expect, it } from "vite-plus/test";

import {
  buildLocalTagRows,
  buildRemoteTagRows,
  describeRemoteTagPresence,
  remoteTagSection,
  summarizeRemoteTagsQuery,
} from "./GitManagerTagsView.logic";

describe("tag rows", () => {
  it("sorts version-like tags numerically, newest first, with short shas", () => {
    const rows = buildLocalTagRows([
      { name: "v0.5.9", tipSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { name: "v0.5.11", tipSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      { name: "v0.5.10", tipSha: "cccccccccccccccccccccccccccccccccccccccc" },
    ]);
    expect(rows.map((row) => row.name)).toEqual(["v0.5.11", "v0.5.10", "v0.5.9"]);
    expect(rows[0]?.shortSha).toBe("bbbbbbbb");
  });

  it("marks remote tags as same, differing, or not fetched against the local set", () => {
    const rows = buildRemoteTagRows(
      [
        { name: "v1", targetSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { name: "v2", targetSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        { name: "v3", targetSha: "cccccccccccccccccccccccccccccccccccccccc" },
      ],
      [
        { name: "v1", tipSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { name: "v2", tipSha: "dddddddddddddddddddddddddddddddddddddddd" },
      ],
    );
    expect(rows.map((row) => [row.name, row.presence])).toEqual([
      ["v3", "not-fetched"],
      ["v2", "differs"],
      ["v1", "same"],
    ]);
    expect(describeRemoteTagPresence("same")).toBeNull();
    expect(describeRemoteTagPresence("differs")).toBe("differs locally");
    expect(describeRemoteTagPresence("not-fetched")).toBe("not fetched");
  });

  it("keys remote sections by remote name", () => {
    expect(remoteTagSection("origin")).toBe("remote:origin");
  });
});

describe("summarizeRemoteTagsQuery", () => {
  const base = { remote: "origin", pending: false, error: null };

  it("reports loading, error, unavailable, empty, and ready states", () => {
    expect(summarizeRemoteTagsQuery({ ...base, result: null })).toEqual({
      kind: "loading",
      message: "Loading tags from origin…",
    });
    expect(summarizeRemoteTagsQuery({ ...base, result: null, error: "boom" })).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(
      summarizeRemoteTagsQuery({
        ...base,
        result: { remote: "origin", status: "unavailable", reason: "no route", tags: [] },
      }),
    ).toEqual({ kind: "unavailable", message: "no route" });
    expect(
      summarizeRemoteTagsQuery({
        ...base,
        result: { remote: "origin", status: "available", reason: null, tags: [] },
      }),
    ).toEqual({ kind: "empty", message: "No tags on origin." });
    expect(
      summarizeRemoteTagsQuery({
        ...base,
        pending: true,
        result: {
          remote: "origin",
          status: "available",
          reason: null,
          tags: [{ name: "v1", targetSha: "a" }],
        },
      }),
    ).toEqual({ kind: "ready", message: "Refreshing…" });
  });
});
