import { describe, expect, it } from "vite-plus/test";
import type { PendingInlineComment } from "../../../pullRequestsStore";
import { reconcilePendingReview, reviewComments } from "./pendingReview.logic";
const first: PendingInlineComment = {
  id: "a",
  path: "a.ts",
  line: 4,
  startLine: null,
  side: "right",
  body: "First",
};
const second: PendingInlineComment = { ...first, id: "b", line: 5, body: "Second" };
describe("pending review reconciliation", () => {
  it("matches the failed body when different comments share a line", () => {
    const other = { ...first, id: "other", body: "Other body" };
    expect(
      reconcilePendingReview([first, other], [first, other], {
        kind: "reviewSubmitted",
        reviewPosted: true,
        landed: 1,
        failed: [{ path: first.path, line: first.line, body: other.body, message: "Rejected" }],
      }),
    ).toEqual([other]);
  });
  it("omits local ids on the wire", () =>
    expect(reviewComments([first])).toEqual([
      { path: "a.ts", line: 4, startLine: null, side: "right", body: "First" },
    ]));
  it("keeps exactly failed comments by location and submitted body", () =>
    expect(
      reconcilePendingReview([first, second], [first, second], {
        kind: "reviewSubmitted",
        reviewPosted: true,
        landed: 1,
        failed: [{ path: "a.ts", line: 5, body: "Second", message: "Invalid position" }],
      }),
    ).toEqual([second]));
  it("keeps every comment when none landed", () =>
    expect(
      reconcilePendingReview([first, second], [first, second], {
        kind: "reviewSubmitted",
        reviewPosted: true,
        landed: 0,
        failed: [
          { path: "a.ts", line: 4, body: "First", message: "Invalid" },
          { path: "a.ts", line: 5, body: "Second", message: "Invalid" },
        ],
      }),
    ).toEqual([first, second]));
  it("does not erase comments added or edited while the submitted snapshot was in flight", () => {
    const edit = { ...first, body: "New text" };
    const added = { ...second, id: "c" };
    expect(
      reconcilePendingReview([edit, second, added], [first, second], {
        kind: "reviewSubmitted",
        reviewPosted: true,
        landed: 2,
        failed: [],
      }),
    ).toEqual([edit, added]);
  });
  it("preserves indistinguishable identical failed comments without local ids", () => {
    const duplicate = { ...first, id: "b" };
    expect(
      reconcilePendingReview([first, duplicate], [first, duplicate], {
        kind: "reviewSubmitted",
        reviewPosted: true,
        landed: 1,
        failed: [{ path: "a.ts", line: 4, body: "First", message: "Invalid" }],
      }),
    ).toEqual([first, duplicate]);
  });
});
