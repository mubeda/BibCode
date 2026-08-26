import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@bibcode/client-runtime/environment";
import {
  ConnectionPersistenceError,
  EnvironmentMigrationStore,
  EnvironmentUiStateStore,
  type EnvironmentUiStateDocument,
} from "@bibcode/client-runtime/platform";
import type {
  EnvironmentId as EnvironmentIdType,
  ProjectId as ProjectIdType,
  ThreadId as ThreadIdType,
} from "@bibcode/contracts";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@bibcode/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  legacyPhysicalProjectPreferenceKey,
  legacyProjectCwdPreferenceKey,
  readLegacyProjectNavigationPreferences,
  type LegacyProjectNavigationPreferences,
} from "./uiStateStore";
import { connectionAtomRuntime } from "./connection/runtime";

export const ENVIRONMENT_NAVIGATION_V1_MIGRATION_ID = "environment-navigation-v1-to-v2";

export type EnvironmentNavigationStateV2 = EnvironmentUiStateDocument;

export interface EnvironmentNavigationSelection {
  readonly environmentId: EnvironmentIdType;
  readonly projectId: ProjectIdType | null;
  readonly threadId: ThreadIdType | null;
}

export interface EnvironmentNavigationProjectCandidate {
  readonly environmentId: EnvironmentIdType;
  readonly projectId: ProjectIdType;
  readonly workspaceRoot: string;
  readonly mainThreadId: ThreadIdType;
  readonly threadIds: readonly ThreadIdType[];
  /** Migration-only repository/group aliases written by the removed grouping model. */
  readonly legacyGroupKeys?: readonly string[];
}

export interface CreateEmptyEnvironmentNavigationStateInput {
  readonly environmentIds: readonly EnvironmentIdType[];
  readonly selected: EnvironmentNavigationSelection | null;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function createEmptyEnvironmentNavigationState(
  input: CreateEmptyEnvironmentNavigationStateInput,
): EnvironmentNavigationStateV2 {
  return {
    schemaVersion: 2,
    selected: input.selected,
    expandedEnvironmentIds: [],
    expandedProjectKeys: [],
    manuallyToggledKeys: [],
    environmentOrder: unique(input.environmentIds),
    pinnedEnvironmentIds: [],
    projectOrderByEnvironment: {},
  };
}

function environmentDisclosureKey(environmentId: EnvironmentIdType): string {
  return `environment:${environmentId}`;
}

function projectDisclosureKey(environmentId: EnvironmentIdType, projectId: ProjectIdType): string {
  return `project:${scopedProjectKey(scopeProjectRef(environmentId, projectId))}`;
}

function addAlias(
  aliases: Map<string, Set<EnvironmentNavigationProjectCandidate>>,
  key: string,
  project: EnvironmentNavigationProjectCandidate,
): void {
  if (!key) return;
  const matches = aliases.get(key);
  if (matches) {
    matches.add(project);
  } else {
    aliases.set(key, new Set([project]));
  }
}

function buildLegacyProjectAliases(
  projects: readonly EnvironmentNavigationProjectCandidate[],
): Map<string, Set<EnvironmentNavigationProjectCandidate>> {
  const aliases = new Map<string, Set<EnvironmentNavigationProjectCandidate>>();
  for (const project of projects) {
    addAlias(
      aliases,
      scopedProjectKey(scopeProjectRef(project.environmentId, project.projectId)),
      project,
    );
    addAlias(
      aliases,
      legacyPhysicalProjectPreferenceKey(project.environmentId, project.workspaceRoot),
      project,
    );
    addAlias(aliases, legacyProjectCwdPreferenceKey(project.workspaceRoot), project);
    for (const legacyGroupKey of project.legacyGroupKeys ?? []) {
      addAlias(aliases, legacyGroupKey, project);
    }
  }
  return aliases;
}

function resolveUnambiguousProject(
  aliases: ReadonlyMap<string, ReadonlySet<EnvironmentNavigationProjectCandidate>>,
  key: string,
): EnvironmentNavigationProjectCandidate | null {
  const matches = aliases.get(key);
  if (matches?.size !== 1) return null;
  return matches.values().next().value ?? null;
}

export interface MigrateLegacyEnvironmentNavigationStateInput extends CreateEmptyEnvironmentNavigationStateInput {
  readonly legacy: LegacyProjectNavigationPreferences;
  readonly projects: readonly EnvironmentNavigationProjectCandidate[];
}

export function migrateLegacyEnvironmentNavigationState(
  input: MigrateLegacyEnvironmentNavigationStateInput,
): EnvironmentNavigationStateV2 {
  const aliases = buildLegacyProjectAliases(input.projects);
  const expandedProjectKeys: string[] = [];
  const manuallyToggledKeys: string[] = [];
  const seenDisclosure = new Set<string>();

  for (const [legacyKey, expanded] of Object.entries(input.legacy.projectExpandedById)) {
    if (typeof expanded !== "boolean") continue;
    const project = resolveUnambiguousProject(aliases, legacyKey);
    if (!project) continue;
    const projectKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.projectId));
    const disclosureKey = `project:${projectKey}`;
    if (seenDisclosure.has(disclosureKey)) continue;
    seenDisclosure.add(disclosureKey);
    manuallyToggledKeys.push(disclosureKey);
    if (expanded) expandedProjectKeys.push(projectKey);
  }

  const projectOrderByEnvironment: Record<string, ProjectIdType[]> = {};
  const seenProjectOrderKeys = new Set<string>();
  for (const legacyKey of input.legacy.projectOrder) {
    const project = resolveUnambiguousProject(aliases, legacyKey);
    if (!project) continue;
    const projectKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.projectId));
    if (seenProjectOrderKeys.has(projectKey)) continue;
    seenProjectOrderKeys.add(projectKey);
    (projectOrderByEnvironment[project.environmentId] ??= []).push(project.projectId);
  }

  return synthesizeSelectedPathExpansion({
    ...createEmptyEnvironmentNavigationState(input),
    expandedProjectKeys,
    manuallyToggledKeys,
    projectOrderByEnvironment,
  });
}

export function synthesizeSelectedPathExpansion(
  state: EnvironmentNavigationStateV2,
): EnvironmentNavigationStateV2 {
  if (!state.selected || state.selected.projectId === null) return state;
  const environmentKey = environmentDisclosureKey(state.selected.environmentId);
  const projectKey = scopedProjectKey(
    scopeProjectRef(state.selected.environmentId, state.selected.projectId),
  );
  const expandedEnvironmentIds = state.manuallyToggledKeys.includes(environmentKey)
    ? [...state.expandedEnvironmentIds]
    : unique([...state.expandedEnvironmentIds, state.selected.environmentId]);
  const expandedProjectKeys =
    state.selected.threadId === null ||
    state.manuallyToggledKeys.includes(
      projectDisclosureKey(state.selected.environmentId, state.selected.projectId),
    )
      ? [...state.expandedProjectKeys]
      : unique([...state.expandedProjectKeys, projectKey]);
  if (
    expandedEnvironmentIds.length === state.expandedEnvironmentIds.length &&
    expandedProjectKeys.length === state.expandedProjectKeys.length
  ) {
    return state;
  }
  return { ...state, expandedEnvironmentIds, expandedProjectKeys };
}

function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function recordManualToggle(state: EnvironmentNavigationStateV2, key: string): string[] {
  return state.manuallyToggledKeys.includes(key)
    ? [...state.manuallyToggledKeys]
    : [...state.manuallyToggledKeys, key];
}

export function toggleEnvironmentDisclosure(
  state: EnvironmentNavigationStateV2,
  environmentId: EnvironmentIdType,
): EnvironmentNavigationStateV2 {
  return {
    ...state,
    expandedEnvironmentIds: toggleValue(state.expandedEnvironmentIds, environmentId),
    manuallyToggledKeys: recordManualToggle(state, environmentDisclosureKey(environmentId)),
  };
}

export function toggleProjectDisclosure(
  state: EnvironmentNavigationStateV2,
  environmentId: EnvironmentIdType,
  projectId: ProjectIdType,
): EnvironmentNavigationStateV2 {
  const projectKey = scopedProjectKey(scopeProjectRef(environmentId, projectId));
  return {
    ...state,
    expandedProjectKeys: toggleValue(state.expandedProjectKeys, projectKey),
    manuallyToggledKeys: recordManualToggle(state, projectDisclosureKey(environmentId, projectId)),
  };
}

export interface EnvironmentNavigationAuthoritativeEnvironment {
  readonly environmentId: EnvironmentIdType;
  readonly hidden: boolean;
  /** True only for a current, online server snapshot. */
  readonly authoritative: boolean;
  readonly projects: readonly EnvironmentNavigationProjectCandidate[];
}

export interface ReconcileEnvironmentNavigationSelectionInput {
  readonly primaryEnvironmentId: EnvironmentIdType | null;
  readonly environments: readonly EnvironmentNavigationAuthoritativeEnvironment[];
  readonly forgottenEnvironmentIds: readonly EnvironmentIdType[];
  readonly removedProjectKeys: readonly string[];
  readonly removedThreadKeys: readonly string[];
}

function primaryOverview(
  primaryEnvironmentId: EnvironmentIdType | null,
): EnvironmentNavigationSelection | null {
  return primaryEnvironmentId
    ? { environmentId: primaryEnvironmentId, projectId: null, threadId: null }
    : null;
}

function nextSurvivingProject(
  state: EnvironmentNavigationStateV2,
  environment: EnvironmentNavigationAuthoritativeEnvironment,
  removedProjectId: ProjectIdType,
): EnvironmentNavigationProjectCandidate | null {
  const projectsById = new Map(environment.projects.map((project) => [project.projectId, project]));
  const storedOrder = state.projectOrderByEnvironment[environment.environmentId] ?? [];
  const completeOrder = unique([
    ...storedOrder,
    ...environment.projects.map((project) => project.projectId),
  ]);
  const removedIndex = completeOrder.indexOf(removedProjectId);
  const candidates =
    removedIndex < 0
      ? completeOrder
      : [...completeOrder.slice(removedIndex + 1), ...completeOrder.slice(0, removedIndex)];
  for (const candidate of candidates) {
    const project = projectsById.get(candidate);
    if (project) return project;
  }
  return null;
}

export function reconcileEnvironmentNavigationSelection(
  state: EnvironmentNavigationStateV2,
  input: ReconcileEnvironmentNavigationSelectionInput,
): EnvironmentNavigationStateV2 {
  const selected = state.selected;
  if (!selected) return state;
  if (input.forgottenEnvironmentIds.includes(selected.environmentId)) {
    return { ...state, selected: primaryOverview(input.primaryEnvironmentId) };
  }

  const environment = input.environments.find(
    (candidate) => candidate.environmentId === selected.environmentId,
  );
  if (!environment || selected.projectId === null) return state;

  const selectedProjectKey = scopedProjectKey(
    scopeProjectRef(selected.environmentId, selected.projectId),
  );
  const project = environment.projects.find(
    (candidate) => candidate.projectId === selected.projectId,
  );
  if (!project) {
    if (!environment.authoritative && !input.removedProjectKeys.includes(selectedProjectKey)) {
      return state;
    }
    const nextProject = nextSurvivingProject(state, environment, selected.projectId);
    return {
      ...state,
      selected: nextProject
        ? {
            environmentId: environment.environmentId,
            projectId: nextProject.projectId,
            threadId: nextProject.mainThreadId,
          }
        : { environmentId: environment.environmentId, projectId: null, threadId: null },
    };
  }

  if (selected.threadId === null || project.threadIds.includes(selected.threadId)) return state;
  const selectedThreadKey = scopedThreadKey(
    scopeThreadRef(selected.environmentId, selected.threadId),
  );
  if (!environment.authoritative && !input.removedThreadKeys.includes(selectedThreadKey)) {
    return state;
  }
  return {
    ...state,
    selected: {
      environmentId: selected.environmentId,
      projectId: selected.projectId,
      threadId: null,
    },
  };
}

export interface LoadEnvironmentNavigationStateInput extends Omit<
  MigrateLegacyEnvironmentNavigationStateInput,
  "legacy"
> {
  readonly completedAt: string;
  readonly readLegacyPreferences?: () => LegacyProjectNavigationPreferences;
}

export const loadEnvironmentNavigationState = Effect.fn(
  "web.environmentNavigationStore.loadEnvironmentNavigationState",
)(function* (input: LoadEnvironmentNavigationStateInput) {
  const uiStateStore = yield* EnvironmentUiStateStore;
  const migrationStore = yield* EnvironmentMigrationStore;
  const receipt = yield* migrationStore.load(ENVIRONMENT_NAVIGATION_V1_MIGRATION_ID);
  if (Option.isSome(receipt)) {
    const persisted = yield* uiStateStore.load;
    if (Option.isNone(persisted)) {
      return yield* new ConnectionPersistenceError({
        operation: "load-environment-ui-state",
        message: "Navigation migration receipt exists without its atomic v2 state document.",
      });
    }
    const loaded = synthesizeSelectedPathExpansion(persisted.value);
    if (loaded !== persisted.value) {
      yield* uiStateStore.save(loaded);
    }
    return loaded;
  }

  const legacy = yield* Effect.try({
    try: input.readLegacyPreferences ?? readLegacyProjectNavigationPreferences,
    catch: (cause) =>
      new ConnectionPersistenceError({
        operation: "load-environment-ui-state",
        message: `Could not read legacy environment navigation preferences: ${String(cause)}`,
      }),
  });
  const migrated = migrateLegacyEnvironmentNavigationState({ ...input, legacy });
  const outcome = yield* uiStateStore.migrateLegacy(migrated, {
    id: ENVIRONMENT_NAVIGATION_V1_MIGRATION_ID,
    completedAt: input.completedAt,
  });
  if (outcome === "applied") return migrated;

  const raced = yield* uiStateStore.load;
  return yield* Option.match(raced, {
    onNone: () =>
      Effect.fail(
        new ConnectionPersistenceError({
          operation: "load-environment-ui-state",
          message: "Navigation migration receipt exists without its v2 state document.",
        }),
      ),
    onSome: Effect.succeed,
  });
});

const environmentNavigationScheduler = createAtomCommandScheduler();

export const environmentNavigationCommands = {
  load: createRuntimeCommand(connectionAtomRuntime, {
    label: "environment-navigation:load",
    scheduler: environmentNavigationScheduler,
    concurrency: { mode: "serial", key: () => "environment-navigation" },
    execute: loadEnvironmentNavigationState,
  }),
  save: createRuntimeCommand(connectionAtomRuntime, {
    label: "environment-navigation:save",
    scheduler: environmentNavigationScheduler,
    concurrency: { mode: "serial", key: () => "environment-navigation" },
    execute: (state: EnvironmentNavigationStateV2) =>
      EnvironmentUiStateStore.pipe(Effect.flatMap((store) => store.save(state))),
  }),
} as const;
