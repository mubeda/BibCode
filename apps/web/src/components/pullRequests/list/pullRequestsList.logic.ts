import type { PullRequestsListInput, PullRequestsListRow } from "@bibcode/contracts";
import {
  DEFAULT_PULL_REQUESTS_VIEW_STATE,
  type PullRequestsViewState,
} from "../../../pullRequestsStore";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
type ListViewState = Pick<PullRequestsViewState, "filters" | "listTab" | "sort">;
/** The list settings the list view reads; the panel's first-page read uses the same. */
export const selectListFilters = (view: ListViewState | undefined) =>
  view?.filters ?? DEFAULT_PULL_REQUESTS_VIEW_STATE.filters;
export const selectListTab = (view: ListViewState | undefined) =>
  view?.listTab ?? DEFAULT_PULL_REQUESTS_VIEW_STATE.listTab;
export const selectListSort = (view: ListViewState | undefined) =>
  view?.sort ?? DEFAULT_PULL_REQUESTS_VIEW_STATE.sort;
/**
 * The Open or Closed first page the list opens on, which the panel reads
 * alongside a pending context. Merged and All wait: GitHub folds them into Closed.
 */
export function firstPagePrefetchInput(
  view: ListViewState | undefined,
  cwd: string,
): PullRequestsListInput | null {
  const tab = selectListTab(view);
  return tab === "open" || tab === "closed"
    ? buildListInput(
        { filters: selectListFilters(view), listTab: tab, sort: selectListSort(view) },
        cwd,
      )
    : null;
}
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
