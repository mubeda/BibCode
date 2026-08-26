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
import { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  ENVIRONMENT_NAVIGATION_V1_MIGRATION_ID,
  createEmptyEnvironmentNavigationState,
  loadEnvironmentNavigationState,
  migrateLegacyEnvironmentNavigationState,
  reconcileEnvironmentNavigationSelection,
  synthesizeSelectedPathExpansion,
  toggleEnvironmentDisclosure,
  toggleProjectDisclosure,
  type EnvironmentNavigationProjectCandidate,
  type EnvironmentNavigationStateV2,
} from "./environmentNavigationStore";
import {
  legacyPhysicalProjectPreferenceKey,
  legacyProjectCwdPreferenceKey,
  type LegacyProjectNavigationPreferences,
} from "./uiStateStore";

const PRIMARY = EnvironmentId.make("environment-primary");
const REMOTE = EnvironmentId.make("environment-remote");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const PROJECT_C = ProjectId.make("project-c");
const MAIN_A = ThreadId.make("main-a");
const MAIN_B = ThreadId.make("main-b");
const MAIN_C = ThreadId.make("main-c");
const THREAD_A = ThreadId.make("thread-a");

function projectCandidate(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workspaceRoot: string,
  mainThreadId: ThreadId,
  threadIds: readonly ThreadId[] = [mainThreadId],
  legacyGroupKeys: readonly string[] = [],
): EnvironmentNavigationProjectCandidate {
  return {
    environmentId,
    projectId,
    workspaceRoot,
    mainThreadId,
    threadIds,
    legacyGroupKeys,
  };
}

const PROJECTS = [
  projectCandidate(
    PRIMARY,
    PROJECT_A,
    "/repo/shared",
    MAIN_A,
    [MAIN_A, THREAD_A],
    ["repository:shared"],
  ),
  projectCandidate(REMOTE, PROJECT_B, "/repo/shared", MAIN_B, [MAIN_B], ["repository:shared"]),
  projectCandidate(REMOTE, PROJECT_C, "/repo/other", MAIN_C),
] as const;

function state(
  overrides: Partial<EnvironmentNavigationStateV2> = {},
): EnvironmentNavigationStateV2 {
  return {
    schemaVersion: 2,
    selected: null,
    expandedEnvironmentIds: [],
    expandedProjectKeys: [],
    manuallyToggledKeys: [],
    environmentOrder: [PRIMARY, REMOTE],
    pinnedEnvironmentIds: [],
    projectOrderByEnvironment: {},
    ...overrides,
  };
}

function migrationInput(legacy: LegacyProjectNavigationPreferences) {
  return {
    legacy,
    environmentIds: [PRIMARY, REMOTE],
    projects: PROJECTS,
    selected: {
      environmentId: REMOTE,
      projectId: PROJECT_C,
      threadId: MAIN_C,
    },
  } as const;
}

describe("environment navigation migration", () => {
  it("creates a clean v2 document and expands only the selected path", () => {
    const migrated = migrateLegacyEnvironmentNavigationState(
      migrationInput({ projectExpandedById: {}, projectOrder: [] }),
    );

    expect(migrated).toEqual({
      schemaVersion: 2,
      selected: {
        environmentId: REMOTE,
        projectId: PROJECT_C,
        threadId: MAIN_C,
      },
      expandedEnvironmentIds: [REMOTE],
      expandedProjectKeys: [scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_C))],
      manuallyToggledKeys: [],
      environmentOrder: [PRIMARY, REMOTE],
      pinnedEnvironmentIds: [],
      projectOrderByEnvironment: {},
    });
  });

  it("maps an unambiguous legacy CWD collapse and order to its scoped project", () => {
    const cwdKey = legacyProjectCwdPreferenceKey("/repo/other/");
    const migrated = migrateLegacyEnvironmentNavigationState(
      migrationInput({
        projectExpandedById: { [cwdKey]: false },
        projectOrder: [cwdKey],
      }),
    );

    expect(migrated.expandedProjectKeys).toEqual([]);
    expect(migrated.manuallyToggledKeys).toEqual([
      `project:${scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_C))}`,
    ]);
    expect(migrated.projectOrderByEnvironment).toEqual({ [REMOTE]: [PROJECT_C] });
  });

  it("maps environment-qualified physical keys but drops ambiguous CWD and repository groups", () => {
    const primaryPhysicalKey = legacyPhysicalProjectPreferenceKey(PRIMARY, "/repo/shared");
    const remotePhysicalKey = legacyPhysicalProjectPreferenceKey(REMOTE, "/repo/shared");
    const ambiguousCwdKey = legacyProjectCwdPreferenceKey("/repo/shared");
    const migrated = migrateLegacyEnvironmentNavigationState(
      migrationInput({
        projectExpandedById: {
          [primaryPhysicalKey]: true,
          [remotePhysicalKey]: false,
          [ambiguousCwdKey]: true,
          "repository:shared": true,
        },
        projectOrder: ["repository:shared", primaryPhysicalKey, remotePhysicalKey],
      }),
    );

    expect(migrated.expandedProjectKeys).toEqual([
      scopedProjectKey(scopeProjectRef(PRIMARY, PROJECT_A)),
      scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_C)),
    ]);
    expect(migrated.manuallyToggledKeys).toEqual([
      `project:${scopedProjectKey(scopeProjectRef(PRIMARY, PROJECT_A))}`,
      `project:${scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_B))}`,
    ]);
    expect(migrated.projectOrderByEnvironment).toEqual({
      [PRIMARY]: [PROJECT_A],
      [REMOTE]: [PROJECT_B],
    });
  });

  it("ignores corrupt and removed legacy IDs", () => {
    const migrated = migrateLegacyEnvironmentNavigationState(
      migrationInput({
        projectExpandedById: { "": true, removed: false, invalid: "yes" as never },
        projectOrder: ["", "removed", "removed"],
      }),
    );

    expect(migrated.expandedProjectKeys).toEqual([
      scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_C)),
    ]);
    expect(migrated.manuallyToggledKeys).toEqual([]);
    expect(migrated.projectOrderByEnvironment).toEqual({});
  });
});

describe("environment navigation disclosure", () => {
  it("persists first-use selection ancestry but never reopens an explicit collapse", () => {
    const selected = state({
      selected: { environmentId: REMOTE, projectId: PROJECT_C, threadId: MAIN_C },
    });
    const expanded = synthesizeSelectedPathExpansion(selected);
    expect(expanded.expandedEnvironmentIds).toEqual([REMOTE]);
    expect(expanded.expandedProjectKeys).toEqual([
      scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_C)),
    ]);

    const collapsedProject = toggleProjectDisclosure(expanded, REMOTE, PROJECT_C);
    const collapsedEnvironment = toggleEnvironmentDisclosure(collapsedProject, REMOTE);
    expect(synthesizeSelectedPathExpansion(collapsedEnvironment)).toBe(collapsedEnvironment);
    expect(collapsedEnvironment.expandedEnvironmentIds).toEqual([]);
    expect(collapsedEnvironment.expandedProjectKeys).toEqual([]);
    expect(collapsedEnvironment.manuallyToggledKeys).toEqual([
      `project:${scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_C))}`,
      `environment:${REMOTE}`,
    ]);
  });

  it("expands untoggled selected ancestors despite unrelated manual toggles", () => {
    const selected = state({
      selected: { environmentId: REMOTE, projectId: PROJECT_C, threadId: MAIN_C },
      manuallyToggledKeys: [`project:${scopedProjectKey(scopeProjectRef(PRIMARY, PROJECT_A))}`],
    });

    const expanded = synthesizeSelectedPathExpansion(selected);

    expect(expanded.expandedEnvironmentIds).toEqual([REMOTE]);
    expect(expanded.expandedProjectKeys).toEqual([
      scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_C)),
    ]);
  });

  it("respects each selected ancestor's own manual disclosure", () => {
    const projectCollapsed = synthesizeSelectedPathExpansion(
      state({
        selected: { environmentId: REMOTE, projectId: PROJECT_C, threadId: MAIN_C },
        manuallyToggledKeys: [`project:${scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_C))}`],
      }),
    );
    expect(projectCollapsed.expandedEnvironmentIds).toEqual([REMOTE]);
    expect(projectCollapsed.expandedProjectKeys).toEqual([]);

    const environmentCollapsed = synthesizeSelectedPathExpansion(
      state({
        selected: { environmentId: REMOTE, projectId: PROJECT_C, threadId: MAIN_C },
        manuallyToggledKeys: [`environment:${REMOTE}`],
      }),
    );
    expect(environmentCollapsed.expandedEnvironmentIds).toEqual([]);
    expect(environmentCollapsed.expandedProjectKeys).toEqual([
      scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_C)),
    ]);
  });
});

describe("authoritative navigation fallback", () => {
  it("preserves hidden and cached offline selections absent from stale discovery", () => {
    const selected = state({
      selected: { environmentId: REMOTE, projectId: PROJECT_C, threadId: MAIN_C },
    });

    expect(
      reconcileEnvironmentNavigationSelection(selected, {
        primaryEnvironmentId: PRIMARY,
        environments: [
          { environmentId: PRIMARY, hidden: false, authoritative: true, projects: [PROJECTS[0]] },
          { environmentId: REMOTE, hidden: true, authoritative: false, projects: [] },
        ],
        forgottenEnvironmentIds: [],
        removedProjectKeys: [],
        removedThreadKeys: [],
      }),
    ).toBe(selected);
  });

  it("falls from an authoritatively removed thread to its surviving project", () => {
    const selected = state({
      selected: { environmentId: PRIMARY, projectId: PROJECT_A, threadId: THREAD_A },
    });
    const next = reconcileEnvironmentNavigationSelection(selected, {
      primaryEnvironmentId: PRIMARY,
      environments: [
        {
          environmentId: PRIMARY,
          hidden: false,
          authoritative: true,
          projects: [projectCandidate(PRIMARY, PROJECT_A, "/repo/shared", MAIN_A, [MAIN_A])],
        },
      ],
      forgottenEnvironmentIds: [],
      removedProjectKeys: [],
      removedThreadKeys: [],
    });

    expect(next.selected).toEqual({
      environmentId: PRIMARY,
      projectId: PROJECT_A,
      threadId: null,
    });
  });

  it("falls from a removed project to the next project's Main, then its environment", () => {
    const selected = state({
      selected: { environmentId: REMOTE, projectId: PROJECT_B, threadId: MAIN_B },
      projectOrderByEnvironment: { [REMOTE]: [PROJECT_B, PROJECT_C] },
    });
    const next = reconcileEnvironmentNavigationSelection(selected, {
      primaryEnvironmentId: PRIMARY,
      environments: [
        { environmentId: PRIMARY, hidden: false, authoritative: true, projects: [PROJECTS[0]] },
        { environmentId: REMOTE, hidden: false, authoritative: true, projects: [PROJECTS[2]] },
      ],
      forgottenEnvironmentIds: [],
      removedProjectKeys: [],
      removedThreadKeys: [],
    });
    expect(next.selected).toEqual({
      environmentId: REMOTE,
      projectId: PROJECT_C,
      threadId: MAIN_C,
    });

    const environmentOnly = reconcileEnvironmentNavigationSelection(selected, {
      primaryEnvironmentId: PRIMARY,
      environments: [
        { environmentId: PRIMARY, hidden: false, authoritative: true, projects: [PROJECTS[0]] },
        { environmentId: REMOTE, hidden: false, authoritative: true, projects: [] },
      ],
      forgottenEnvironmentIds: [],
      removedProjectKeys: [],
      removedThreadKeys: [],
    });
    expect(environmentOnly.selected).toEqual({
      environmentId: REMOTE,
      projectId: null,
      threadId: null,
    });
  });

  it("falls from an explicitly forgotten environment to the primary overview", () => {
    const selected = state({
      selected: { environmentId: REMOTE, projectId: PROJECT_C, threadId: MAIN_C },
    });
    const next = reconcileEnvironmentNavigationSelection(selected, {
      primaryEnvironmentId: PRIMARY,
      environments: [
        { environmentId: PRIMARY, hidden: false, authoritative: true, projects: [PROJECTS[0]] },
      ],
      forgottenEnvironmentIds: [REMOTE],
      removedProjectKeys: [],
      removedThreadKeys: [],
    });

    expect(next.selected).toEqual({
      environmentId: PRIMARY,
      projectId: null,
      threadId: null,
    });
  });
});

interface PersistenceHarness {
  readonly ui: EnvironmentUiStateStore["Service"];
  readonly migrations: EnvironmentMigrationStore["Service"];
  readonly getState: () => EnvironmentUiStateDocument | null;
  readonly getReceiptId: () => string | null;
}

function persistenceHarness(input?: {
  readonly state?: EnvironmentUiStateDocument | null;
  readonly receiptId?: string | null;
  readonly failMigration?: boolean;
}): PersistenceHarness {
  let durableState = input?.state ?? null;
  let receiptId = input?.receiptId ?? null;
  return {
    ui: EnvironmentUiStateStore.of({
      load: Effect.sync(() => Option.fromNullishOr(durableState)),
      save: (next) => Effect.sync(() => void (durableState = next)),
      clearEnvironment: () => Effect.void,
      migrateLegacy: (next, receipt) =>
        input?.failMigration
          ? Effect.fail(
              new ConnectionPersistenceError({
                operation: "save-environment-ui-state",
                message: "QuotaExceededError",
              }),
            )
          : Effect.sync(() => {
              if (receiptId !== null) return "already-applied" as const;
              durableState = next;
              receiptId = receipt.id;
              return "applied" as const;
            }),
    }),
    migrations: EnvironmentMigrationStore.of({
      load: (id) =>
        Effect.sync(() =>
          receiptId === id
            ? Option.some({ id, completedAt: "2026-08-25T00:00:00.000Z" })
            : Option.none(),
        ),
      save: () => Effect.die("navigation migration must use the atomic UI-store boundary"),
    }),
    getState: () => durableState,
    getReceiptId: () => receiptId,
  };
}

function runLoad(
  harness: PersistenceHarness,
  readLegacyPreferences: () => LegacyProjectNavigationPreferences,
) {
  return loadEnvironmentNavigationState({
    environmentIds: [PRIMARY, REMOTE],
    projects: PROJECTS,
    selected: { environmentId: REMOTE, projectId: PROJECT_C, threadId: MAIN_C },
    completedAt: "2026-08-25T00:00:00.000Z",
    readLegacyPreferences,
  }).pipe(
    Effect.provideService(EnvironmentUiStateStore, harness.ui),
    Effect.provideService(EnvironmentMigrationStore, harness.migrations),
  );
}

describe("environment navigation restart persistence", () => {
  it.effect("commits clean-start state and one migration receipt", () => {
    const harness = persistenceHarness();
    const readLegacy = vi.fn(() => ({ projectExpandedById: {}, projectOrder: [] }));

    return Effect.gen(function* () {
      const loaded = yield* runLoad(harness, readLegacy);
      expect(loaded.selected?.environmentId).toBe(REMOTE);
      expect(harness.getState()).toEqual(loaded);
      expect(harness.getReceiptId()).toBe(ENVIRONMENT_NAVIGATION_V1_MIGRATION_ID);
      expect(readLegacy).toHaveBeenCalledOnce();
    });
  });

  it.effect("does not read v1 preferences after the receipt exists", () => {
    const persisted = createEmptyEnvironmentNavigationState({
      environmentIds: [PRIMARY],
      selected: { environmentId: PRIMARY, projectId: null, threadId: null },
    });
    const harness = persistenceHarness({
      state: persisted,
      receiptId: ENVIRONMENT_NAVIGATION_V1_MIGRATION_ID,
    });
    const readLegacy = vi.fn(() => {
      throw new Error("legacy state must not be read");
    });

    return Effect.gen(function* () {
      expect(yield* runLoad(harness, readLegacy)).toEqual(persisted);
      expect(readLegacy).not.toHaveBeenCalled();
    });
  });

  it.effect("fails closed when a receipt exists without its atomic v2 state", () => {
    const harness = persistenceHarness({
      state: null,
      receiptId: ENVIRONMENT_NAVIGATION_V1_MIGRATION_ID,
    });
    const readLegacy = vi.fn(() => ({ projectExpandedById: {}, projectOrder: [] }));

    return Effect.gen(function* () {
      yield* runLoad(harness, readLegacy).pipe(Effect.flip);
      expect(harness.getState()).toBeNull();
      expect(readLegacy).not.toHaveBeenCalled();
    });
  });

  it.effect("restores a manual collapse exactly after reload", () => {
    const collapsed = state({
      selected: { environmentId: REMOTE, projectId: PROJECT_C, threadId: MAIN_C },
      expandedEnvironmentIds: [REMOTE],
      expandedProjectKeys: [],
      manuallyToggledKeys: [`project:${scopedProjectKey(scopeProjectRef(REMOTE, PROJECT_C))}`],
    });
    const harness = persistenceHarness({
      state: collapsed,
      receiptId: ENVIRONMENT_NAVIGATION_V1_MIGRATION_ID,
    });

    return Effect.gen(function* () {
      const loaded = yield* runLoad(harness, () => ({
        projectExpandedById: {},
        projectOrder: [],
      }));
      expect(loaded).toEqual(collapsed);
      expect(loaded.expandedProjectKeys).toEqual([]);
    });
  });

  it.effect("does not publish a receipt when quota failure aborts migration", () => {
    const harness = persistenceHarness({ failMigration: true });
    return Effect.gen(function* () {
      yield* runLoad(harness, () => ({ projectExpandedById: {}, projectOrder: [] })).pipe(
        Effect.flip,
      );
      expect(harness.getState()).toBeNull();
      expect(harness.getReceiptId()).toBeNull();
    });
  });
});

describe("scoped thread key fixtures", () => {
  it("keeps project and thread IDs environment scoped", () => {
    expect(scopedProjectKey(scopeProjectRef(PRIMARY, PROJECT_A))).toBe(`${PRIMARY}:${PROJECT_A}`);
    expect(scopedThreadKey(scopeThreadRef(PRIMARY, THREAD_A))).toBe(`${PRIMARY}:${THREAD_A}`);
    expect(scopedThreadKey(scopeThreadRef(REMOTE, THREAD_A))).not.toBe(
      scopedThreadKey(scopeThreadRef(PRIMARY, THREAD_A)),
    );
  });
});
