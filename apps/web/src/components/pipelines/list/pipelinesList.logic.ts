import type {
  PipelinesListInput,
  PipelinesListPage,
  PipelinesListScope,
  PipelinesRow,
  PipelinesSubscribeInput,
  PullRequestsProviderKind,
} from "@bibcode/contracts";
import {
  DEFAULT_PIPELINES_FILTERS,
  sanitizePipelinesFilters,
  type PipelinesFilters,
} from "../../../pipelinesStore";
import {
  GITHUB_ACTIONS_REFUSED,
  githubRefused,
  type RepositoryPermission,
} from "../actions/pipelineActions.logic";

/** The list route's search parameters; each is left out at its default. */
export interface PipelinesRouteSearch {
  readonly scope?: Exclude<PipelinesListScope, "all">;
  readonly ref?: string;
  readonly workflow?: number;
}

export function validatePipelinesSearch(search: Record<string, unknown>): PipelinesRouteSearch {
  const workflow = typeof search.workflow === "string" ? Number(search.workflow) : search.workflow;
  return filtersSearch(
    sanitizePipelinesFilters({ scope: search.scope, ref: search.ref, workflowId: workflow }),
  );
}

/** The search parameters for `filters`, without the defaults, so a plain list URL stays plain. */
export function filtersSearch(filters: PipelinesFilters): PipelinesRouteSearch {
  return {
    ...(filters.scope === "all" ? {} : { scope: filters.scope }),
    ...(filters.ref === null ? {} : { ref: filters.ref }),
    ...(filters.workflowId === null ? {} : { workflow: filters.workflowId }),
  };
}

/**
 * The filters a list shows: the route's when it names any (Back and a copied link
 * keep them), otherwise the ones last used for the project.
 */
export function shownFilters(
  search: PipelinesRouteSearch | undefined,
  stored: PipelinesFilters,
): PipelinesFilters {
  if (
    search === undefined ||
    (search.scope === undefined && search.ref === undefined && search.workflow === undefined)
  )
    return stored;
  return {
    ...DEFAULT_PIPELINES_FILTERS,
    ...(search.scope === undefined ? {} : { scope: search.scope }),
    ...(search.ref === undefined ? {} : { ref: search.ref }),
    ...(search.workflow === undefined ? {} : { workflowId: search.workflow }),
  };
}

export function sameFilters(a: PipelinesFilters, b: PipelinesFilters): boolean {
  return a.scope === b.scope && a.ref === b.ref && a.workflowId === b.workflowId;
}

/** The first page's input. Every view reads it as `user`; a timer marks its own reads. */
export function buildPipelinesListInput(
  filters: PipelinesFilters,
  cwd: string,
): PipelinesListInput {
  return {
    cwd,
    scope: filters.scope,
    ref: filters.ref,
    workflowId: filters.workflowId,
    cursor: null,
    refresh: "user",
  };
}

/** The `readSnapshot` and `subscribe` input for the list key alone. */
export function listSnapshotInput(input: PipelinesListInput): PipelinesSubscribeInput {
  return { ...input, cursor: null, refresh: "user", pipelineId: null, attempt: null, jobId: null };
}

/**
 * Whether the list's visible timer may re-read its first page. GitLab: always, as the
 * fallback while its stream is not live (the stream pauses it). GitHub has no stream:
 * only while a shown pipeline can still change.
 */
export function listTimerEnabled(
  provider: PullRequestsProviderKind,
  rows: readonly Pick<PipelinesRow, "terminal">[],
): boolean {
  return provider === "gitlab" || rows.some((row) => !row.terminal);
}

/**
 * The first page and the later pages loaded after it, one row per pipeline. A poller
 * or timer replaces only the first page, read most recently, so its copy of a
 * pipeline wins and loaded later pages stay put.
 */
export function mergePipelineRows(
  firstPage: readonly PipelinesRow[],
  laterPages: readonly PipelinesRow[],
): readonly PipelinesRow[] {
  const rows = new Map<number, PipelinesRow>();
  for (const row of [...firstPage, ...laterPages]) if (!rows.has(row.id)) rows.set(row.id, row);
  return [...rows.values()];
}

export const EMPTY_LIST_COPY: Record<PipelinesListScope, string> = {
  all: "No pipelines yet",
  running: "Nothing running",
  finished: "No finished pipelines",
};

type Workflows = NonNullable<PipelinesListPage["workflows"]>;

/** The Workflow filter's choices: every run, then each workflow, keeping a chosen one. */
export function workflowFilterItems(
  workflows: Workflows,
  value: number | null,
): readonly { readonly value: string; readonly label: string }[] {
  const items = [
    { value: "all", label: "All workflows" },
    ...workflows.map((workflow) => ({ value: String(workflow.id), label: workflow.name })),
  ];
  if (value !== null && !workflows.some((workflow) => workflow.id === value))
    items.push({ value: String(value), label: `Workflow ${value}` });
  return items;
}

/**
 * What an empty list says. GitHub returning no runs and no workflows for an unfiltered
 * list means the repository has none, not that nothing ran yet.
 */
export function emptyListCopy({
  provider,
  filters,
  workflows,
}: {
  provider: PullRequestsProviderKind;
  filters: PipelinesFilters;
  workflows: Workflows | null;
}): string {
  if (filters.ref !== null) return `No pipelines on ${filters.ref}`;
  if (filters.workflowId !== null) {
    const workflow = workflows?.find((candidate) => candidate.id === filters.workflowId);
    return workflow ? `No runs of ${workflow.name}` : "No runs of this workflow";
  }
  if (provider === "github" && filters.scope === "all" && workflows?.length === 0)
    return "This repository has no workflows.";
  return EMPTY_LIST_COPY[filters.scope];
}

export interface PipelineActionPermission {
  readonly allowed: boolean;
  readonly reason: string | null;
}

// GitHub's only refusal it can read is the repository role below write.
const DENIED: Record<PullRequestsProviderKind, Record<"retry" | "cancel", string>> = {
  gitlab: {
    retry: "You don't have permission to retry pipelines in this project.",
    cancel: "You don't have permission to cancel pipelines in this project.",
  },
  github: {
    retry: "You need write access to this repository to re-run workflows.",
    cancel: "You need write access to this repository to cancel workflow runs.",
  },
};

function actionPermission(
  action: "retry" | "cancel",
  permissions: PipelinesRow["permissions"],
  mutationsDisabledReason: string | null,
  provider: PullRequestsProviderKind,
  repositoryPermission: RepositoryPermission | null,
): PipelineActionPermission {
  // The host's own answer comes first: no server update lets a refused account act.
  if (permissions?.[action] === "denied")
    return {
      allowed: false,
      reason:
        provider === "github" && githubRefused(repositoryPermission)
          ? GITHUB_ACTIONS_REFUSED
          : DENIED[provider][action],
    };
  if (mutationsDisabledReason !== null) return { allowed: false, reason: mutationsDisabledReason };
  if (permissions === null)
    return { allowed: false, reason: `The host didn't say whether you can ${action} pipelines.` };
  return { allowed: true, reason: null };
}

/**
 * The row's Retry and Cancel, each `null` when it does not apply: Retry for a finished
 * pipeline that did not pass, Cancel for one that can still run. A disabled action
 * says why. On GitHub a denial with repository write or higher is GitHub's own
 * refusal of an earlier action, which the server remembers until a rescan.
 */
export function pipelineRowActions(
  row: Pick<PipelinesRow, "status" | "terminal" | "permissions">,
  mutationsDisabledReason: string | null,
  provider: PullRequestsProviderKind = "gitlab",
  repositoryPermission: RepositoryPermission | null = null,
): {
  readonly retry: PipelineActionPermission | null;
  readonly cancel: PipelineActionPermission | null;
} {
  const permission = (action: "retry" | "cancel") =>
    actionPermission(
      action,
      row.permissions,
      mutationsDisabledReason,
      provider,
      repositoryPermission,
    );
  return {
    retry: row.terminal && row.status !== "success" ? permission("retry") : null,
    cancel: row.terminal ? null : permission("cancel"),
  };
}
