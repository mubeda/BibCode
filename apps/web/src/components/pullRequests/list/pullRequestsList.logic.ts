import type { PullRequestsListInput, PullRequestsListRow } from "@bibcode/contracts";
import type { PullRequestsViewState } from "../../../pullRequestsStore";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
export function buildListInput(
  state: Pick<PullRequestsViewState, "listTab" | "filters" | "sort">,
  cwd: string,
): PullRequestsListInput {
  const f = state.filters;
  return {
    cwd,
    state: state.listTab,
    search: f.search?.trim() || null,
    author: f.author?.trim() || null,
    assignee: f.assignee?.trim() || null,
    reviewer: f.reviewer?.trim() || null,
    reviewStatus: f.reviewStatus,
    draft: f.draft,
    labels: f.labels,
    milestone: f.milestone,
    targetBranch: f.targetBranch,
    sort: state.sort,
    cursor: null,
  };
}
export function rowTimeLabel(row: PullRequestsListRow): string {
  return Number.isFinite(Date.parse(row.createdAt))
    ? formatRelativeTimeLabel(row.createdAt)
    : "at an unknown time";
}
export function rowStateIcon(
  row: Pick<PullRequestsListRow, "state" | "isDraft">,
): "open" | "draft" | "closed" | "merged" {
  return row.state === "open" && row.isDraft ? "draft" : row.state;
}
