import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_PULL_REQUESTS_VIEW_STATE } from "../../../pullRequestsStore";
import { row } from "../testFixtures";
import { buildListInput, rowStateIcon, rowTimeLabel } from "./pullRequestsList.logic";
afterEach(() => vi.restoreAllMocks());
describe("pullRequestsList logic", () => {
  it("builds the exact first-page query, preserving opaque cwd and filters", () => {
    expect(
      buildListInput(
        {
          ...DEFAULT_PULL_REQUESTS_VIEW_STATE,
          listTab: "closed",
          filters: {
            ...DEFAULT_PULL_REQUESTS_VIEW_STATE.filters,
            search: " fix ",
            author: "@me",
            reviewer: "bob",
            labels: ["bug"],
            reviewStatus: "approved",
            draft: "exclude",
            milestone: "m1",
            targetBranch: "main",
          },
          sort: "oldest",
        },
        "Z:\\opaque\\repo",
      ),
    ).toEqual({
      cwd: "Z:\\opaque\\repo",
      state: "closed",
      search: "fix",
      author: "@me",
      assignee: null,
      reviewer: "bob",
      reviewStatus: "approved",
      draft: "exclude",
      labels: ["bug"],
      milestone: "m1",
      targetBranch: "main",
      sort: "oldest",
      cursor: null,
    });
  });
  it("normalizes blank text to null", () => {
    expect(
      buildListInput(
        {
          ...DEFAULT_PULL_REQUESTS_VIEW_STATE,
          filters: { ...DEFAULT_PULL_REQUESTS_VIEW_STATE.filters, search: "   " },
        },
        "/repo",
      ).search,
    ).toBeNull();
  });
  it.each([
    ["open", false, "open"],
    ["open", true, "draft"],
    ["merged", true, "merged"],
    ["closed", true, "closed"],
  ] as const)("chooses %s draft=%s icon", (state, isDraft, expected) => {
    expect(rowStateIcon({ ...row, state, isDraft })).toBe(expected);
  });
  it("formats creation time without a ticking subscription", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-20T12:00:00Z"));
    expect(rowTimeLabel(row)).toBe("1d ago");
    expect(rowTimeLabel({ ...row, createdAt: "bad" })).toBe("at an unknown time");
  });
});
