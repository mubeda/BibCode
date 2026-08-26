import type { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@bibcode/contracts/settings";
import { scopedProjectKey, scopedThreadKey } from "@bibcode/client-runtime/environment";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "./lib/threadSort";

export type EnvironmentTreeStatus =
  | "online"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "authentication-required"
  | "version-incompatible"
  | "updating"
  | "stopped"
  | "setup-required";

export type EnvironmentTreeEnvironmentKind = "primary" | "wsl" | "remote";

export interface EnvironmentTreeProjectInput {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activityLabel: string | null;
}

export interface EnvironmentTreeThreadInput extends ThreadSortInput {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly kind?: "default" | "workspace" | "panel" | undefined;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
  readonly activityLabel: string | null;
}

export interface EnvironmentTreeEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly kind: EnvironmentTreeEnvironmentKind;
  readonly status: EnvironmentTreeStatus;
  readonly label: string;
  readonly canonicalLabel: string;
  readonly hidden: boolean;
  /**
   * Monotonic shell revision supplied by the environment state owner. Callers
   * must increment it when any project/thread or compact presentation value
   * changes.
   */
  readonly shellRevision: string | number;
  /** Whether the current descendants originated from durable cache. */
  readonly cached: boolean;
  /** Whether descendants are non-authoritative, regardless of their origin. */
  readonly stale: boolean;
  readonly lastSynchronizedAt: string | null;
  readonly projects: readonly EnvironmentTreeProjectInput[];
  readonly threads: readonly EnvironmentTreeThreadInput[];
}

export interface EnvironmentTreeSelection {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
}

export interface EnvironmentTreePreferences {
  /** Incremented whenever any tree preference changes. */
  readonly revision: string | number;
  readonly expandedEnvironmentIds: readonly EnvironmentId[];
  /** Scoped project keys (`environmentId:projectId`). */
  readonly expandedProjectKeys: readonly string[];
  /** Full tree row keys explicitly toggled by the client. */
  readonly manuallyToggledKeys: readonly string[];
  readonly environmentOrder: readonly EnvironmentId[];
  readonly pinnedEnvironmentIds: readonly EnvironmentId[];
  readonly projectOrderByEnvironment: Readonly<Record<string, readonly ProjectId[] | undefined>>;
  /** Scoped thread keys (`environmentId:threadId`). */
  readonly pinnedThreadKeys: readonly string[];
  readonly projectSortOrder: SidebarProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
}

export interface EnvironmentTreeProjectionInput {
  readonly environments: readonly EnvironmentTreeEnvironmentInput[];
  readonly preferences: EnvironmentTreePreferences;
  readonly selected: EnvironmentTreeSelection | null;
  readonly searchQuery: string;
}

interface EnvironmentTreeRowBase {
  readonly key: string;
  readonly parentKey: string | null;
  readonly level: 1 | 2 | 3;
  readonly label: string;
  readonly secondaryLabel: string | null;
  readonly activityLabel: string | null;
  readonly isExpanded: boolean;
  readonly isSelected: boolean;
  readonly isCached: boolean;
  readonly isStale: boolean;
  readonly ariaPosInSet: number;
  readonly ariaSetSize: number;
}

export interface EnvironmentTreeEnvironmentRow extends EnvironmentTreeRowBase {
  readonly kind: "environment";
  readonly environmentId: EnvironmentId;
  readonly environmentKind: EnvironmentTreeEnvironmentKind;
  readonly status: EnvironmentTreeStatus;
  readonly statusText: string;
  readonly canonicalLabel: string;
  readonly lastSynchronizedAt: string | null;
  readonly level: 1;
  readonly parentKey: null;
}

export interface EnvironmentTreeProjectRow extends EnvironmentTreeRowBase {
  readonly kind: "project";
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly level: 2;
}

export interface EnvironmentTreeThreadRow extends EnvironmentTreeRowBase {
  readonly kind: "thread";
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly role: "main" | "ordinary" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly level: 3;
  readonly isExpanded: false;
}

export type EnvironmentTreeRow =
  | EnvironmentTreeEnvironmentRow
  | EnvironmentTreeProjectRow
  | EnvironmentTreeThreadRow;

export interface EnvironmentTreeProjection {
  readonly rows: readonly EnvironmentTreeRow[];
  readonly rowByKey: ReadonlyMap<string, EnvironmentTreeRow>;
  readonly indexByKey: ReadonlyMap<string, number>;
  readonly parentByKey: ReadonlyMap<string, string | null>;
  /** Complete known-environment order, including hidden environments. */
  readonly environmentOrder: readonly EnvironmentId[];
  readonly environmentOrderChanged: boolean;
}

export function environmentTreeEnvironmentKey(environmentId: EnvironmentId): string {
  return `environment:${environmentId}`;
}

export function environmentTreeProjectKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): string {
  return `project:${scopedProjectKey({ environmentId, projectId })}`;
}

export function environmentTreeThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `thread:${scopedThreadKey({ environmentId, threadId })}`;
}

export interface WorkspaceRowThreadInput {
  readonly kind?: "default" | "workspace" | "panel" | undefined;
}

export function findDefaultThread<T extends WorkspaceRowThreadInput>(
  threads: readonly T[],
): T | null {
  return threads.find((thread) => thread.kind === "default") ?? null;
}

export function splitPrimaryAndWorkspaceThreads<T extends WorkspaceRowThreadInput>(
  threads: readonly T[],
): { primaryThread: T | null; workspaceThreads: T[] } {
  const primaryThread = findDefaultThread(threads);
  const workspaceThreads = threads.filter(
    (thread) => thread !== primaryThread && thread.kind !== "panel",
  );
  return { primaryThread, workspaceThreads };
}

export function orderRowsWithPins<T>(
  items: readonly T[],
  pinnedKeys: ReadonlySet<string> | readonly string[],
  getKey: (item: T) => string,
): T[] {
  const pinned = pinnedKeys instanceof Set ? pinnedKeys : new Set(pinnedKeys);
  const pinnedItems: T[] = [];
  const restItems: T[] = [];
  for (const item of items) {
    (pinned.has(getKey(item)) ? pinnedItems : restItems).push(item);
  }
  return [...pinnedItems, ...restItems];
}

interface SidebarProject {
  readonly id: string;
  readonly title: string;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends { readonly projectId: string } & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      threadsByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      threadsByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
}

function orderItemsByPreferredIds<TItem, TId>(input: {
  readonly items: readonly TItem[];
  readonly preferredIds: readonly TId[];
  readonly getId: (item: TItem) => TId;
}): TItem[] {
  const byId = new Map(input.items.map((item) => [input.getId(item), item]));
  const emitted = new Set<TId>();
  const result: TItem[] = [];
  for (const id of input.preferredIds) {
    const item = byId.get(id);
    if (item === undefined || emitted.has(id)) continue;
    emitted.add(id);
    result.push(item);
  }
  for (const item of input.items) {
    if (!emitted.has(input.getId(item))) result.push(item);
  }
  return result;
}

function placementRank(
  environment: EnvironmentTreeEnvironmentInput,
  pinnedEnvironmentIds: ReadonlySet<EnvironmentId>,
): number {
  if (pinnedEnvironmentIds.has(environment.environmentId)) return 0;
  if (environment.kind === "primary") return 1;
  if (
    environment.kind === "wsl" &&
    environment.status !== "stopped" &&
    environment.status !== "offline" &&
    environment.status !== "setup-required"
  ) {
    return 2;
  }
  if (environment.kind === "remote" && environment.status === "online") return 3;
  return 4;
}

function sameIds(left: readonly EnvironmentId[], right: readonly EnvironmentId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function resolveEnvironmentOrder(input: EnvironmentTreeProjectionInput): {
  readonly environments: readonly EnvironmentTreeEnvironmentInput[];
  readonly ids: readonly EnvironmentId[];
  readonly changed: boolean;
} {
  const uniqueEnvironments: EnvironmentTreeEnvironmentInput[] = [];
  const byId = new Map<EnvironmentId, EnvironmentTreeEnvironmentInput>();
  for (const environment of input.environments) {
    if (byId.has(environment.environmentId)) continue;
    byId.set(environment.environmentId, environment);
    uniqueEnvironments.push(environment);
  }
  const emittedStoredIds = new Set<EnvironmentId>();
  const stored = input.preferences.environmentOrder.flatMap((environmentId) => {
    if (emittedStoredIds.has(environmentId)) return [];
    const environment = byId.get(environmentId);
    if (environment === undefined) return [];
    emittedStoredIds.add(environmentId);
    return [environment];
  });
  const storedIds = new Set(stored.map((environment) => environment.environmentId));
  const pinnedIds = new Set(input.preferences.pinnedEnvironmentIds);
  const missing = uniqueEnvironments
    .filter((environment) => !storedIds.has(environment.environmentId))
    .map((environment, inputIndex) => ({ environment, inputIndex }))
    .toSorted(
      (left, right) =>
        placementRank(left.environment, pinnedIds) - placementRank(right.environment, pinnedIds) ||
        left.inputIndex - right.inputIndex,
    )
    .map(({ environment }) => environment);

  const ordered = [...stored];
  for (const environment of missing) {
    const rank = placementRank(environment, pinnedIds);
    const insertionIndex = ordered.findIndex(
      (candidate) => placementRank(candidate, pinnedIds) > rank,
    );
    if (insertionIndex === -1) {
      ordered.push(environment);
    } else {
      ordered.splice(insertionIndex, 0, environment);
    }
  }
  const ids = ordered.map((environment) => environment.environmentId);
  return {
    environments: ordered,
    ids,
    changed: !sameIds(ids, input.preferences.environmentOrder),
  };
}

function statusText(status: EnvironmentTreeStatus): string {
  switch (status) {
    case "online":
      return "Online";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
    case "authentication-required":
      return "Authentication required";
    case "version-incompatible":
      return "Version incompatible";
    case "updating":
      return "Updating";
    case "stopped":
      return "Stopped";
    case "setup-required":
      return "Setup required";
  }
}

function normalizedSearchValue(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

function normalizedSearchTerms(
  ...values: readonly (string | null | undefined)[]
): readonly string[] {
  return values.map((value) => normalizedSearchValue(value ?? ""));
}

function matchesSearchTerms(query: string, terms: readonly string[]): boolean {
  return terms.some((term) => term.includes(query));
}

function threadSearchLabel(thread: EnvironmentTreeThreadInput): string {
  return thread.kind === "default" ? "Main" : thread.title;
}

interface EnvironmentSearchIndex {
  readonly environmentTerms: readonly string[];
  readonly projectTerms: ReadonlyMap<ProjectId, readonly string[]>;
  readonly threadTerms: ReadonlyMap<ThreadId, readonly string[]>;
}

function buildEnvironmentSearchIndex(
  environment: EnvironmentTreeEnvironmentInput,
): EnvironmentSearchIndex {
  return {
    environmentTerms: normalizedSearchTerms(environment.label, environment.canonicalLabel),
    projectTerms: new Map(
      environment.projects.map((project) => [
        project.id,
        normalizedSearchTerms(project.title, project.workspaceRoot),
      ]),
    ),
    threadTerms: new Map(
      environment.threads.map((thread) => [
        thread.id,
        normalizedSearchTerms(threadSearchLabel(thread), thread.branch, thread.worktreePath),
      ]),
    ),
  };
}

function environmentContainsSearchMatch(
  environment: EnvironmentTreeEnvironmentInput,
  index: EnvironmentSearchIndex,
  query: string,
): boolean {
  if (query.length === 0 || matchesSearchTerms(query, index.environmentTerms)) {
    return true;
  }
  const projectIds = new Set(environment.projects.map((project) => project.id));
  return (
    environment.projects.some((project) =>
      matchesSearchTerms(query, index.projectTerms.get(project.id) ?? []),
    ) ||
    environment.threads.some(
      (thread) =>
        projectIds.has(thread.projectId) &&
        thread.archivedAt === null &&
        thread.kind !== "panel" &&
        matchesSearchTerms(query, index.threadTerms.get(thread.id) ?? []),
    )
  );
}

function classifyThreadRole(thread: EnvironmentTreeThreadInput): EnvironmentTreeThreadRow["role"] {
  if (thread.kind === "default") return "main";
  return thread.worktreePath === null ? "ordinary" : "worktree";
}

function orderProjectThreads(input: {
  readonly environmentId: EnvironmentId;
  readonly threads: readonly EnvironmentTreeThreadInput[];
  readonly preferences: EnvironmentTreePreferences;
}): EnvironmentTreeThreadInput[] {
  const activeThreads = input.threads.filter(
    (thread) => thread.archivedAt === null && thread.kind !== "panel",
  );
  const { primaryThread, workspaceThreads } = splitPrimaryAndWorkspaceThreads(activeThreads);
  const sorted = sortThreads(workspaceThreads, input.preferences.threadSortOrder);
  const ordinary = sorted.filter((thread) => classifyThreadRole(thread) === "ordinary");
  const worktrees = sorted.filter((thread) => classifyThreadRole(thread) === "worktree");
  const key = (thread: EnvironmentTreeThreadInput) =>
    scopedThreadKey({ environmentId: input.environmentId, threadId: thread.id });
  return [
    ...(primaryThread === null ? [] : [primaryThread]),
    ...orderRowsWithPins(ordinary, input.preferences.pinnedThreadKeys, key),
    ...orderRowsWithPins(worktrees, input.preferences.pinnedThreadKeys, key),
  ];
}

interface SearchProjection {
  readonly includeEnvironment: boolean;
  readonly projects: ReadonlyMap<ProjectId, readonly EnvironmentTreeThreadInput[]>;
}

function projectSearch(
  environment: EnvironmentTreeEnvironmentInput,
  orderedProjects: readonly EnvironmentTreeProjectInput[],
  orderedThreadsByProject: ReadonlyMap<ProjectId, readonly EnvironmentTreeThreadInput[]>,
  index: EnvironmentSearchIndex,
  query: string,
): SearchProjection {
  if (query.length === 0) {
    return {
      includeEnvironment: true,
      projects: new Map(
        orderedProjects.map((project) => [
          project.id,
          orderedThreadsByProject.get(project.id) ?? [],
        ]),
      ),
    };
  }

  const environmentMatches = matchesSearchTerms(query, index.environmentTerms);
  const projects = new Map<ProjectId, readonly EnvironmentTreeThreadInput[]>();
  for (const project of orderedProjects) {
    const orderedThreads = orderedThreadsByProject.get(project.id) ?? [];
    const matchingThreads = orderedThreads.filter((thread) =>
      matchesSearchTerms(query, index.threadTerms.get(thread.id) ?? []),
    );
    if (
      matchesSearchTerms(query, index.projectTerms.get(project.id) ?? []) ||
      matchingThreads.length > 0
    ) {
      projects.set(project.id, matchingThreads);
    }
  }
  return {
    includeEnvironment: environmentMatches || projects.size > 0,
    projects,
  };
}

function selectedProjectId(
  selected: EnvironmentTreeSelection | null,
  environmentId: EnvironmentId,
): ProjectId | null {
  return selected?.environmentId === environmentId ? selected.projectId : null;
}

function selectedThreadId(
  selected: EnvironmentTreeSelection | null,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): ThreadId | null {
  return selected?.environmentId === environmentId && selected.projectId === projectId
    ? selected.threadId
    : null;
}

function isEnvironmentSelected(
  selected: EnvironmentTreeSelection | null,
  environmentId: EnvironmentId,
): boolean {
  return (
    selected?.environmentId === environmentId &&
    selected.projectId === null &&
    selected.threadId === null
  );
}

function isProjectSelected(
  selected: EnvironmentTreeSelection | null,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  return (
    selected?.environmentId === environmentId &&
    selected.projectId === projectId &&
    selected.threadId === null
  );
}

function isThreadSelected(
  selected: EnvironmentTreeSelection | null,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
): boolean {
  return (
    selected?.environmentId === environmentId &&
    selected.projectId === projectId &&
    selected.threadId === threadId
  );
}

function buildEnvironmentRows(input: {
  readonly environment: EnvironmentTreeEnvironmentInput;
  readonly preferences: EnvironmentTreePreferences;
  readonly selected: EnvironmentTreeSelection | null;
  readonly searchIndex: EnvironmentSearchIndex;
  readonly query: string;
  readonly ariaPosInSet: number;
  readonly ariaSetSize: number;
}): readonly EnvironmentTreeRow[] {
  const { environment, preferences, selected, searchIndex, query } = input;
  const environmentKey = environmentTreeEnvironmentKey(environment.environmentId);
  const manuallyToggled = new Set(preferences.manuallyToggledKeys);
  const savedEnvironmentExpanded = preferences.expandedEnvironmentIds.includes(
    environment.environmentId,
  );
  const selectedProject = selectedProjectId(selected, environment.environmentId);
  const selectedPathExpandsEnvironment =
    selectedProject !== null && !manuallyToggled.has(environmentKey);

  const activeThreads = environment.threads.filter(
    (thread) => thread.archivedAt === null && thread.kind !== "panel",
  );
  const sortedProjects = sortProjectsForSidebar(
    environment.projects,
    activeThreads,
    preferences.projectSortOrder,
  );
  const orderedProjects = orderItemsByPreferredIds({
    items: sortedProjects,
    preferredIds:
      preferences.projectSortOrder === "manual"
        ? (preferences.projectOrderByEnvironment[environment.environmentId] ?? [])
        : [],
    getId: (project) => project.id,
  });
  const activeThreadsByProject = new Map<ProjectId, EnvironmentTreeThreadInput[]>();
  for (const thread of activeThreads) {
    const projectThreads = activeThreadsByProject.get(thread.projectId);
    if (projectThreads === undefined) {
      activeThreadsByProject.set(thread.projectId, [thread]);
    } else {
      projectThreads.push(thread);
    }
  }
  const orderedThreadsByProject = new Map(
    orderedProjects.map((project) => [
      project.id,
      orderProjectThreads({
        environmentId: environment.environmentId,
        threads: activeThreadsByProject.get(project.id) ?? [],
        preferences,
      }),
    ]),
  );
  const search = projectSearch(
    environment,
    orderedProjects,
    orderedThreadsByProject,
    searchIndex,
    query,
  );
  if (!search.includeEnvironment) return [];

  const visibleProjects = orderedProjects.filter((project) => search.projects.has(project.id));
  const environmentExpanded =
    query.length > 0
      ? visibleProjects.length > 0
      : savedEnvironmentExpanded || selectedPathExpandsEnvironment;
  const rows: EnvironmentTreeRow[] = [
    {
      kind: "environment",
      key: environmentKey,
      parentKey: null,
      environmentId: environment.environmentId,
      environmentKind: environment.kind,
      status: environment.status,
      statusText: statusText(environment.status),
      canonicalLabel: environment.canonicalLabel,
      lastSynchronizedAt: environment.lastSynchronizedAt,
      level: 1,
      label: environment.label,
      secondaryLabel:
        environment.label === environment.canonicalLabel ? null : environment.canonicalLabel,
      activityLabel: null,
      isExpanded: environmentExpanded,
      isSelected: isEnvironmentSelected(selected, environment.environmentId),
      isCached: environment.cached,
      isStale: environment.stale,
      ariaPosInSet: input.ariaPosInSet,
      ariaSetSize: input.ariaSetSize,
    },
  ];
  if (!environmentExpanded) return rows;

  for (const [projectIndex, project] of visibleProjects.entries()) {
    const projectKey = environmentTreeProjectKey(environment.environmentId, project.id);
    const scopedKey = scopedProjectKey({
      environmentId: environment.environmentId,
      projectId: project.id,
    });
    const selectedThread = selectedThreadId(selected, environment.environmentId, project.id);
    const selectedPathExpandsProject = selectedThread !== null && !manuallyToggled.has(projectKey);
    const matchingThreads = search.projects.get(project.id) ?? [];
    const projectExpanded =
      query.length > 0
        ? matchingThreads.length > 0
        : preferences.expandedProjectKeys.includes(scopedKey) || selectedPathExpandsProject;
    rows.push({
      kind: "project",
      key: projectKey,
      parentKey: environmentKey,
      environmentId: environment.environmentId,
      projectId: project.id,
      workspaceRoot: project.workspaceRoot,
      level: 2,
      label: project.title,
      secondaryLabel: project.workspaceRoot,
      activityLabel: project.activityLabel,
      isExpanded: projectExpanded,
      isSelected: isProjectSelected(selected, environment.environmentId, project.id),
      isCached: environment.cached,
      isStale: environment.stale,
      ariaPosInSet: projectIndex + 1,
      ariaSetSize: visibleProjects.length,
    });
    if (!projectExpanded) continue;

    for (const [threadIndex, thread] of matchingThreads.entries()) {
      const role = classifyThreadRole(thread);
      rows.push({
        kind: "thread",
        key: environmentTreeThreadKey(environment.environmentId, thread.id),
        parentKey: projectKey,
        environmentId: environment.environmentId,
        projectId: project.id,
        threadId: thread.id,
        role,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        level: 3,
        label: role === "main" ? "Main" : thread.title,
        secondaryLabel: role === "worktree" ? (thread.branch ?? thread.worktreePath) : null,
        activityLabel: thread.activityLabel,
        isExpanded: false,
        isSelected: isThreadSelected(selected, environment.environmentId, project.id, thread.id),
        isCached: environment.cached,
        isStale: environment.stale,
        ariaPosInSet: threadIndex + 1,
        ariaSetSize: matchingThreads.length,
      });
    }
  }
  return rows;
}

interface CachedEnvironmentRows {
  readonly signature: string;
  readonly rows: readonly EnvironmentTreeRow[];
}

interface CachedEnvironmentSearchIndex {
  readonly shellRevision: string | number;
  readonly index: EnvironmentSearchIndex;
}

function environmentCacheSignature(input: {
  readonly environment: EnvironmentTreeEnvironmentInput;
  readonly preferences: EnvironmentTreePreferences;
  readonly selected: EnvironmentTreeSelection | null;
  readonly query: string;
  readonly ariaPosInSet: number;
  readonly ariaSetSize: number;
}): string {
  const selected =
    input.selected?.environmentId === input.environment.environmentId ? input.selected : null;
  return [
    input.environment.shellRevision,
    input.preferences.revision,
    input.query,
    input.ariaPosInSet,
    input.ariaSetSize,
    selected?.environmentId ?? "",
    selected?.projectId ?? "",
    selected?.threadId ?? "",
  ].join("\u0000");
}

export type EnvironmentTreeProjector = (
  input: EnvironmentTreeProjectionInput,
) => EnvironmentTreeProjection;

/**
 * Creates an independent pure projector instance. Its only retained state is a
 * per-environment memo table used to preserve row object identity when the
 * shell and preference revisions have not changed.
 */
export function createEnvironmentTreeProjector(): EnvironmentTreeProjector {
  const cache = new Map<EnvironmentId, CachedEnvironmentRows>();
  const searchIndexCache = new Map<EnvironmentId, CachedEnvironmentSearchIndex>();

  return (input) => {
    const currentEnvironmentIds = new Set(
      input.environments.map((environment) => environment.environmentId),
    );
    for (const environmentId of cache.keys()) {
      if (!currentEnvironmentIds.has(environmentId)) cache.delete(environmentId);
    }
    for (const environmentId of searchIndexCache.keys()) {
      if (!currentEnvironmentIds.has(environmentId)) searchIndexCache.delete(environmentId);
    }
    const ordered = resolveEnvironmentOrder(input);
    const query = normalizedSearchValue(input.searchQuery.trim());
    const visibleEnvironments = ordered.environments
      .filter((environment) => !environment.hidden)
      .map((environment) => {
        const cached = searchIndexCache.get(environment.environmentId);
        const searchIndex =
          cached?.shellRevision === environment.shellRevision
            ? cached.index
            : buildEnvironmentSearchIndex(environment);
        if (searchIndex !== cached?.index) {
          searchIndexCache.set(environment.environmentId, {
            shellRevision: environment.shellRevision,
            index: searchIndex,
          });
        }
        return { environment, searchIndex };
      })
      .filter(({ environment, searchIndex }) =>
        environmentContainsSearchMatch(environment, searchIndex, query),
      );
    const candidateRows = visibleEnvironments.map(
      ({ environment, searchIndex }, environmentIndex) => {
        const signature = environmentCacheSignature({
          environment,
          preferences: input.preferences,
          selected: input.selected,
          query,
          ariaPosInSet: environmentIndex + 1,
          ariaSetSize: visibleEnvironments.length,
        });
        const cached = cache.get(environment.environmentId);
        if (cached?.signature === signature) return cached.rows;
        const rows = buildEnvironmentRows({
          environment,
          preferences: input.preferences,
          selected: input.selected,
          searchIndex,
          query,
          ariaPosInSet: environmentIndex + 1,
          ariaSetSize: visibleEnvironments.length,
        });
        cache.set(environment.environmentId, { signature, rows });
        return rows;
      },
    );
    const rows = candidateRows.flat();
    const rowByKey = new Map<string, EnvironmentTreeRow>();
    const indexByKey = new Map<string, number>();
    const parentByKey = new Map<string, string | null>();
    for (const [index, row] of rows.entries()) {
      rowByKey.set(row.key, row);
      indexByKey.set(row.key, index);
      parentByKey.set(row.key, row.parentKey);
    }

    return {
      rows,
      rowByKey,
      indexByKey,
      parentByKey,
      environmentOrder: ordered.ids,
      environmentOrderChanged: ordered.changed,
    };
  };
}
