import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import { scopedProjectKey, scopedThreadKey } from "@bibcode/client-runtime/environment";

import {
  createEnvironmentTreeProjector,
  environmentTreeEnvironmentKey,
  environmentTreeProjectKey,
  environmentTreeThreadKey,
  type EnvironmentTreeEnvironmentInput,
  type EnvironmentTreePreferences,
  type EnvironmentTreeProjectionInput,
  type EnvironmentTreeThreadInput,
} from "./environmentTree";

const PRIMARY = EnvironmentId.make("environment-primary");
const WSL = EnvironmentId.make("environment-wsl");
const REMOTE = EnvironmentId.make("environment-remote");
const OFFLINE = EnvironmentId.make("environment-offline");

const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");

const MAIN = ThreadId.make("thread-main");
const ORDINARY = ThreadId.make("thread-ordinary");
const PINNED_ORDINARY = ThreadId.make("thread-pinned-ordinary");
const WORKTREE = ThreadId.make("thread-worktree");
const PINNED_WORKTREE = ThreadId.make("thread-pinned-worktree");
const PANEL = ThreadId.make("thread-panel");

const EARLY = "2026-08-24T10:00:00.000Z";
const LATE = "2026-08-24T11:00:00.000Z";

function thread(
  id: ThreadId,
  projectId: ProjectId,
  overrides: Partial<EnvironmentTreeThreadInput> = {},
): EnvironmentTreeThreadInput {
  return {
    id,
    projectId,
    title: id,
    kind: "workspace",
    branch: null,
    worktreePath: null,
    createdAt: EARLY,
    updatedAt: EARLY,
    latestUserMessageAt: EARLY,
    archivedAt: null,
    activityLabel: null,
    ...overrides,
  };
}

function environment(
  environmentId: EnvironmentId,
  overrides: Partial<EnvironmentTreeEnvironmentInput> = {},
): EnvironmentTreeEnvironmentInput {
  return {
    environmentId,
    kind: "remote",
    status: "online",
    label: environmentId,
    canonicalLabel: environmentId,
    hidden: false,
    shellRevision: 1,
    cached: false,
    stale: false,
    lastSynchronizedAt: LATE,
    projects: [
      {
        id: PROJECT_A,
        title: "Shared repository",
        workspaceRoot: "/src/shared",
        createdAt: EARLY,
        updatedAt: LATE,
        activityLabel: null,
      },
    ],
    threads: [thread(MAIN, PROJECT_A, { kind: "default", title: "Stored main title" })],
    ...overrides,
  };
}

function preferences(
  overrides: Partial<EnvironmentTreePreferences> = {},
): EnvironmentTreePreferences {
  return {
    revision: 1,
    expandedEnvironmentIds: [PRIMARY, WSL, REMOTE, OFFLINE],
    expandedProjectKeys: [
      scopedProjectKey({ environmentId: PRIMARY, projectId: PROJECT_A }),
      scopedProjectKey({ environmentId: WSL, projectId: PROJECT_A }),
      scopedProjectKey({ environmentId: REMOTE, projectId: PROJECT_A }),
      scopedProjectKey({ environmentId: OFFLINE, projectId: PROJECT_A }),
    ],
    manuallyToggledKeys: [],
    environmentOrder: [],
    pinnedEnvironmentIds: [],
    projectOrderByEnvironment: {},
    pinnedThreadKeys: [],
    projectSortOrder: "manual",
    threadSortOrder: "updated_at",
    ...overrides,
  };
}

function input(
  environments: readonly EnvironmentTreeEnvironmentInput[],
  overrides: Partial<EnvironmentTreeProjectionInput> = {},
): EnvironmentTreeProjectionInput {
  return {
    environments,
    preferences: preferences(),
    selected: null,
    searchQuery: "",
    ...overrides,
  };
}

function rowKeys(
  projection: ReturnType<ReturnType<typeof createEnvironmentTreeProjector>>,
): string[] {
  return projection.rows.map((row) => row.key);
}

describe("environment tree projection", () => {
  it("projects primary, WSL, and remote environments without joining equal repositories", () => {
    const primary = environment(PRIMARY, {
      kind: "primary",
      label: "This Mac",
      projects: [
        {
          id: PROJECT_A,
          title: "Shared repository",
          workspaceRoot: "/Users/me/shared",
          createdAt: EARLY,
          updatedAt: LATE,
          activityLabel: null,
        },
      ],
    });
    const wsl = environment(WSL, {
      kind: "wsl",
      label: "WSL Ubuntu",
      projects: [
        {
          id: PROJECT_A,
          title: "Shared repository",
          workspaceRoot: "/home/me/shared",
          createdAt: EARLY,
          updatedAt: LATE,
          activityLabel: null,
        },
      ],
    });

    const projection = createEnvironmentTreeProjector()(input([wsl, primary]));

    expect(projection.environmentOrder).toEqual([PRIMARY, WSL]);
    expect(projection.environmentOrderChanged).toBe(true);
    expect(projection.rows.filter((row) => row.kind === "project")).toHaveLength(2);
    expect(
      projection.rows
        .filter((row) => row.kind === "project")
        .map((row) => [row.environmentId, row.projectId]),
    ).toEqual([
      [PRIMARY, PROJECT_A],
      [WSL, PROJECT_A],
    ]);
  });

  it("places new environments once and does not reorder stored rows after status changes", () => {
    const firstInput = input([
      environment(OFFLINE, { status: "offline" }),
      environment(REMOTE, { status: "online" }),
      environment(WSL, { kind: "wsl", status: "online" }),
      environment(PRIMARY, { kind: "primary" }),
    ]);
    const projector = createEnvironmentTreeProjector();
    const first = projector(firstInput);

    expect(first.environmentOrder).toEqual([PRIMARY, WSL, REMOTE, OFFLINE]);

    const second = projector({
      ...firstInput,
      environments: firstInput.environments.map((candidate) =>
        candidate.environmentId === REMOTE
          ? { ...candidate, status: "offline" as const, shellRevision: 2 }
          : candidate.environmentId === OFFLINE
            ? { ...candidate, status: "online" as const, shellRevision: 2 }
            : candidate,
      ),
      preferences: preferences({ environmentOrder: first.environmentOrder, revision: 2 }),
    });

    expect(second.environmentOrder).toEqual([PRIMARY, WSL, REMOTE, OFFLINE]);
    expect(second.environmentOrderChanged).toBe(false);
  });

  it("inserts newly discovered environments by default placement without reordering stored peers", () => {
    const projection = createEnvironmentTreeProjector()(
      input(
        [
          environment(OFFLINE, { status: "offline" }),
          environment(REMOTE, { status: "online" }),
          environment(WSL, { kind: "wsl", status: "online" }),
          environment(PRIMARY, { kind: "primary" }),
        ],
        {
          preferences: preferences({ environmentOrder: [REMOTE, OFFLINE] }),
        },
      ),
    );

    expect(projection.environmentOrder).toEqual([PRIMARY, WSL, REMOTE, OFFLINE]);
  });

  it("deduplicates malformed stored order and repeated environment inputs by first occurrence", () => {
    const first = environment(REMOTE, { label: "First occurrence" });
    const duplicate = environment(REMOTE, {
      label: "Duplicate occurrence",
      shellRevision: 2,
    });
    const projection = createEnvironmentTreeProjector()(
      input([first, duplicate], {
        preferences: preferences({ environmentOrder: [REMOTE, REMOTE] }),
      }),
    );

    expect(projection.environmentOrder).toEqual([REMOTE]);
    expect(projection.rows.filter((row) => row.kind === "environment")).toHaveLength(1);
    expect(projection.rowByKey.get(environmentTreeEnvironmentKey(REMOTE))).toMatchObject({
      label: "First occurrence",
    });
  });

  it("orders Main, pinned ordinary, ordinary, pinned worktree, and worktree and excludes panels", () => {
    const threads = [
      thread(WORKTREE, PROJECT_A, { worktreePath: "/wt/plain", updatedAt: LATE }),
      thread(ORDINARY, PROJECT_A, { updatedAt: LATE }),
      thread(PINNED_WORKTREE, PROJECT_A, {
        worktreePath: "/wt/pinned",
        updatedAt: EARLY,
      }),
      thread(PINNED_ORDINARY, PROJECT_A, { updatedAt: EARLY }),
      thread(PANEL, PROJECT_A, { kind: "panel", updatedAt: LATE }),
      thread(MAIN, PROJECT_A, { kind: "default", updatedAt: EARLY }),
    ];
    const pinnedThreadKeys = [
      scopedThreadKey({ environmentId: PRIMARY, threadId: PINNED_ORDINARY }),
      scopedThreadKey({ environmentId: PRIMARY, threadId: PINNED_WORKTREE }),
    ];

    const projection = createEnvironmentTreeProjector()(
      input([environment(PRIMARY, { kind: "primary", threads })], {
        preferences: preferences({ pinnedThreadKeys }),
      }),
    );

    expect(
      projection.rows.filter((row) => row.kind === "thread").map((row) => [row.threadId, row.role]),
    ).toEqual([
      [MAIN, "main"],
      [PINNED_ORDINARY, "ordinary"],
      [ORDINARY, "ordinary"],
      [PINNED_WORKTREE, "worktree"],
      [WORKTREE, "worktree"],
    ]);
    expect(projection.rowByKey.get(environmentTreeThreadKey(PRIMARY, MAIN))).toMatchObject({
      label: "Main",
    });
    expect(projection.indexByKey.has(environmentTreeThreadKey(PRIMARY, PANEL))).toBe(false);
  });

  it("scopes manual project order to each owning environment", () => {
    const projectA = environment(PRIMARY).projects[0]!;
    const projectB = {
      ...projectA,
      id: PROJECT_B,
      title: "Second project",
      workspaceRoot: "/src/second",
    };
    const primary = environment(PRIMARY, { kind: "primary", projects: [projectA, projectB] });
    const remote = environment(REMOTE, { projects: [projectA, projectB] });

    const projection = createEnvironmentTreeProjector()(
      input([primary, remote], {
        preferences: preferences({
          projectOrderByEnvironment: {
            [PRIMARY]: [PROJECT_B, PROJECT_A],
            [REMOTE]: [PROJECT_A, PROJECT_B],
          },
          expandedProjectKeys: [],
        }),
      }),
    );

    expect(
      projection.rows
        .filter((row) => row.kind === "project")
        .map((row) => [row.environmentId, row.projectId]),
    ).toEqual([
      [PRIMARY, PROJECT_B],
      [PRIMARY, PROJECT_A],
      [REMOTE, PROJECT_A],
      [REMOTE, PROJECT_B],
    ]);
  });

  it("uses configured project sorting instead of stale manual order preferences", () => {
    const projectA = { ...environment(PRIMARY).projects[0]!, updatedAt: EARLY };
    const projectB = {
      ...projectA,
      id: PROJECT_B,
      title: "Recently updated",
      workspaceRoot: "/src/recent",
      updatedAt: LATE,
    };
    const projection = createEnvironmentTreeProjector()(
      input(
        [
          environment(PRIMARY, {
            kind: "primary",
            projects: [projectA, projectB],
            threads: [
              thread(MAIN, PROJECT_A, { kind: "default", updatedAt: EARLY }),
              thread(ThreadId.make("thread-main-b"), PROJECT_B, {
                kind: "default",
                updatedAt: LATE,
              }),
            ],
          }),
        ],
        {
          preferences: preferences({
            projectSortOrder: "updated_at",
            projectOrderByEnvironment: { [PRIMARY]: [PROJECT_A, PROJECT_B] },
            expandedProjectKeys: [],
          }),
        },
      ),
    );

    expect(
      projection.rows.filter((row) => row.kind === "project").map((row) => row.projectId),
    ).toEqual([PROJECT_B, PROJECT_A]);
  });

  it("shows only expanded descendants and computes ARIA metadata after panel filtering", () => {
    const primary = environment(PRIMARY, {
      kind: "primary",
      threads: [
        thread(MAIN, PROJECT_A, { kind: "default" }),
        thread(ORDINARY, PROJECT_A),
        thread(PANEL, PROJECT_A, { kind: "panel" }),
      ],
    });
    const projection = createEnvironmentTreeProjector()(
      input([primary], {
        preferences: preferences({ expandedProjectKeys: [] }),
      }),
    );

    expect(rowKeys(projection)).toEqual([
      environmentTreeEnvironmentKey(PRIMARY),
      environmentTreeProjectKey(PRIMARY, PROJECT_A),
    ]);
    expect(projection.rows[1]).toMatchObject({
      ariaPosInSet: 1,
      ariaSetSize: 1,
      isExpanded: false,
      level: 2,
    });
  });

  it("expands the selected ancestor path only before a manual toggle exists", () => {
    const selected = { environmentId: PRIMARY, projectId: PROJECT_A, threadId: ORDINARY };
    const primary = environment(PRIMARY, {
      kind: "primary",
      threads: [thread(MAIN, PROJECT_A, { kind: "default" }), thread(ORDINARY, PROJECT_A)],
    });
    const projectKey = environmentTreeProjectKey(PRIMARY, PROJECT_A);
    const collapsedPreferences = preferences({
      expandedEnvironmentIds: [],
      expandedProjectKeys: [],
    });
    const firstUse = createEnvironmentTreeProjector()(
      input([primary], { preferences: collapsedPreferences, selected }),
    );

    expect(firstUse.indexByKey.has(environmentTreeThreadKey(PRIMARY, ORDINARY))).toBe(true);

    const later = createEnvironmentTreeProjector()(
      input([primary], {
        preferences: {
          ...collapsedPreferences,
          manuallyToggledKeys: [projectKey],
          revision: 2,
        },
        selected,
      }),
    );

    expect(later.indexByKey.has(environmentTreeThreadKey(PRIMARY, ORDINARY))).toBe(false);
    expect(later.rowByKey.get(projectKey)).toMatchObject({ isExpanded: false });

    const environmentCollapsed = createEnvironmentTreeProjector()(
      input([primary], {
        preferences: {
          ...collapsedPreferences,
          manuallyToggledKeys: [environmentTreeEnvironmentKey(PRIMARY)],
          revision: 3,
        },
        selected,
      }),
    );
    expect(rowKeys(environmentCollapsed)).toEqual([environmentTreeEnvironmentKey(PRIMARY)]);
  });

  it.each(["offline", "stopped"] as const)(
    "retains cached descendants for an %s environment and marks them stale",
    (status) => {
      const projection = createEnvironmentTreeProjector()(
        input([
          environment(OFFLINE, {
            kind: status === "stopped" ? "wsl" : "remote",
            status,
            cached: true,
            stale: true,
            threads: [thread(MAIN, PROJECT_A, { kind: "default" }), thread(ORDINARY, PROJECT_A)],
          }),
        ]),
      );

      expect(projection.rows).toHaveLength(4);
      expect(projection.rows.every((row) => row.isCached && row.isStale)).toBe(true);
    },
  );

  it("marks an in-memory snapshot stale after reconnect starts without calling it cached", () => {
    const projection = createEnvironmentTreeProjector()(
      input([
        environment(REMOTE, {
          status: "reconnecting",
          cached: false,
          stale: true,
        }),
      ]),
    );

    expect(projection.rows.every((row) => !row.isCached && row.isStale)).toBe(true);
  });

  it("searches descendants while retaining their environment and project ancestors", () => {
    const projection = createEnvironmentTreeProjector()(
      input(
        [
          environment(PRIMARY, {
            kind: "primary",
            threads: [
              thread(MAIN, PROJECT_A, { kind: "default" }),
              thread(WORKTREE, PROJECT_A, {
                title: "Authentication refactor",
                branch: "feature/auth",
                worktreePath: "/tmp/auth-refactor",
              }),
              thread(ORDINARY, PROJECT_A, { title: "Unrelated thread" }),
            ],
          }),
        ],
        {
          preferences: preferences({
            expandedEnvironmentIds: [],
            expandedProjectKeys: [],
            manuallyToggledKeys: [environmentTreeEnvironmentKey(PRIMARY)],
          }),
          searchQuery: "auth",
        },
      ),
    );

    expect(rowKeys(projection)).toEqual([
      environmentTreeEnvironmentKey(PRIMARY),
      environmentTreeProjectKey(PRIMARY, PROJECT_A),
      environmentTreeThreadKey(PRIMARY, WORKTREE),
    ]);
  });

  it("searches the system Main label instead of a legacy stored default-thread title", () => {
    const projection = createEnvironmentTreeProjector()(
      input(
        [
          environment(PRIMARY, {
            kind: "primary",
            threads: [thread(MAIN, PROJECT_A, { kind: "default", title: "Legacy default" })],
          }),
        ],
        { searchQuery: "main" },
      ),
    );

    expect(rowKeys(projection)).toEqual([
      environmentTreeEnvironmentKey(PRIMARY),
      environmentTreeProjectKey(PRIMARY, PROJECT_A),
      environmentTreeThreadKey(PRIMARY, MAIN),
    ]);
    expect(projection.rows[2]).toMatchObject({ label: "Main" });
  });

  it("folds Unicode case and accents while omitting hidden matches", () => {
    const projection = createEnvironmentTreeProjector()(
      input(
        [
          environment(PRIMARY, {
            kind: "primary",
            label: "Máquina Local",
            canonicalLabel: "DEV-MAC",
          }),
          environment(REMOTE, {
            hidden: true,
            label: "Máquina Secreta",
          }),
        ],
        { searchQuery: "MAQUINA" },
      ),
    );

    expect(projection.rows.filter((row) => row.kind === "environment")).toHaveLength(1);
    expect(projection.rows[0]).toMatchObject({ environmentId: PRIMARY, label: "Máquina Local" });
  });

  it("computes environment ARIA positions from search results rather than hidden siblings", () => {
    const projection = createEnvironmentTreeProjector()(
      input(
        [
          environment(PRIMARY, { kind: "primary", label: "This Mac" }),
          environment(REMOTE, {
            label: "Build PC",
            threads: [
              thread(MAIN, PROJECT_A, { kind: "default" }),
              thread(ORDINARY, PROJECT_A, { title: "Authentication review" }),
            ],
          }),
        ],
        { searchQuery: "authentication" },
      ),
    );

    expect(projection.rows[0]).toMatchObject({
      environmentId: REMOTE,
      ariaPosInSet: 1,
      ariaSetSize: 1,
    });
  });

  it("reuses every row for an unchanged environment revision and rebuilds only a changed subtree", () => {
    const projector = createEnvironmentTreeProjector();
    const primary = environment(PRIMARY, { kind: "primary" });
    const remote = environment(REMOTE);
    const firstInput = input([primary, remote]);
    const first = projector(firstInput);
    const second = projector(firstInput);

    expect(second.rows.every((row, index) => row === first.rows[index])).toBe(true);

    const changed = projector({
      ...firstInput,
      environments: [primary, { ...remote, shellRevision: 2, label: "Renamed remote" }],
    });
    const primaryKeys = new Set(
      first.rows.filter((row) => row.environmentId === PRIMARY).map((row) => row.key),
    );
    expect(
      changed.rows
        .filter((row) => primaryKeys.has(row.key))
        .every((row) => row === first.rowByKey.get(row.key)),
    ).toBe(true);
    expect(changed.rowByKey.get(environmentTreeEnvironmentKey(REMOTE))).not.toBe(
      first.rowByKey.get(environmentTreeEnvironmentKey(REMOTE)),
    );
  });

  it("does not rebuild an unrelated environment subtree when selection moves", () => {
    const projector = createEnvironmentTreeProjector();
    const environments = [
      environment(PRIMARY, { kind: "primary" }),
      environment(REMOTE),
      environment(OFFLINE, { status: "offline", cached: true, stale: true }),
    ];
    const first = projector(
      input(environments, {
        selected: { environmentId: PRIMARY, projectId: null, threadId: null },
      }),
    );
    const second = projector(
      input(environments, {
        selected: { environmentId: REMOTE, projectId: null, threadId: null },
      }),
    );

    const offlineKey = environmentTreeEnvironmentKey(OFFLINE);
    expect(second.rowByKey.get(offlineKey)).toBe(first.rowByKey.get(offlineKey));
  });

  it("evicts removed environment rows before the same identity is later re-added", () => {
    const projector = createEnvironmentTreeProjector();
    const first = projector(input([environment(REMOTE, { label: "Old remote" })]));

    expect(first.rowByKey.get(environmentTreeEnvironmentKey(REMOTE))).toMatchObject({
      label: "Old remote",
    });
    projector(input([]));

    const readded = projector(input([environment(REMOTE, { label: "New remote" })]));
    expect(readded.rowByKey.get(environmentTreeEnvironmentKey(REMOTE))).toMatchObject({
      label: "New remote",
    });
    expect(readded.rowByKey.get(environmentTreeEnvironmentKey(REMOTE))).not.toBe(
      first.rowByKey.get(environmentTreeEnvironmentKey(REMOTE)),
    );
  });

  it("derives 1,000 visible rows within the recorded 250ms cold budget", () => {
    const environments = Array.from({ length: 100 }, (_, environmentIndex) => {
      const environmentId = EnvironmentId.make(`environment-${environmentIndex}`);
      const projects = Array.from({ length: 3 }, (_, projectIndex) => ({
        id: ProjectId.make(`project-${projectIndex}`),
        title: `Project ${projectIndex}`,
        workspaceRoot: `/src/${projectIndex}`,
        createdAt: EARLY,
        updatedAt: LATE,
        activityLabel: null,
      }));
      const threads = projects.flatMap((project, projectIndex) =>
        Array.from({ length: projectIndex === 0 ? 3 : 2 }, (_, threadIndex) =>
          thread(ThreadId.make(`thread-${projectIndex}-${threadIndex}`), project.id, {
            kind: threadIndex === 0 ? "default" : "workspace",
          }),
        ),
      );
      return environment(environmentId, { projects, threads });
    });
    const expandedProjectKeys = environments.flatMap((candidate) =>
      candidate.projects.map((project) =>
        scopedProjectKey({ environmentId: candidate.environmentId, projectId: project.id }),
      ),
    );
    const start = performance.now();
    const projection = createEnvironmentTreeProjector()(
      input(environments, {
        preferences: preferences({
          expandedEnvironmentIds: environments.map((candidate) => candidate.environmentId),
          expandedProjectKeys,
        }),
      }),
    );
    const elapsedMs = performance.now() - start;

    expect(projection.rows).toHaveLength(1_100);
    expect(elapsedMs).toBeLessThan(250);
  });
});
