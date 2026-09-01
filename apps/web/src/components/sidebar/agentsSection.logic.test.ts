import type { EnvironmentAvailabilityStatus } from "@bibcode/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@bibcode/contracts";
import { createModelSelection } from "@bibcode/shared/model";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadStatusPill } from "../Sidebar.logic";
import {
  buildAgentRows,
  groupAgentRows,
  resolveAgentGroup,
  resolveAgentPreviewLine,
} from "./agentsSection.logic";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");
const PROJECT_A = ProjectId.make("project-a");
const UPDATED_AT = "2026-08-31T12:00:00.000Z";

type ThreadSession = NonNullable<EnvironmentThreadShell["session"]>;

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: ThreadId.make("thread-default"),
    status: "ready",
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: UPDATED_AT,
    ...overrides,
  } as ThreadSession;
}

function makeShell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  const id = overrides.id ?? ThreadId.make("thread-default");
  return {
    id,
    projectId: PROJECT_A,
    title: "Default thread",
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
    session: makeSession({ threadId: id }),
    latestUserMessageAt: UPDATED_AT,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    conversationPreview: null,
    environmentId: ENVIRONMENT_A,
    ...overrides,
  } as EnvironmentThreadShell;
}

function buildRows(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  overrides: {
    readonly projectTitleById?: ReadonlyMap<string, string>;
    readonly environmentLabelById?: ReadonlyMap<string, string>;
    readonly availabilityByEnvironmentId?: ReadonlyMap<string, EnvironmentAvailabilityStatus>;
  } = {},
) {
  return buildAgentRows({
    shells,
    projectTitleById:
      overrides.projectTitleById ?? new Map<string, string>([[PROJECT_A, "Project Alpha"]]),
    environmentLabelById:
      overrides.environmentLabelById ??
      new Map<string, string>([
        [ENVIRONMENT_A, "Local"],
        [ENVIRONMENT_B, "Build farm"],
      ]),
    availabilityByEnvironmentId:
      overrides.availabilityByEnvironmentId ??
      new Map<string, EnvironmentAvailabilityStatus>([
        [ENVIRONMENT_A, "live"],
        [ENVIRONMENT_B, "live"],
      ]),
  });
}

const pillRest = {
  colorClass: "text-test",
  dotClass: "bg-test",
  pulse: false,
} as const;
const workingPill: ThreadStatusPill = { label: "Working", ...pillRest };
const completedPill: ThreadStatusPill = { label: "Completed", ...pillRest };

describe("resolveAgentGroup", () => {
  it("maps pill labels to groups per spec §3.3", () => {
    expect(resolveAgentGroup({ label: "Working", ...pillRest })).toBe("working");
    expect(resolveAgentGroup({ label: "Connecting", ...pillRest })).toBe("working");
    expect(resolveAgentGroup({ label: "Pending Approval", ...pillRest })).toBe("blocked");
    expect(resolveAgentGroup({ label: "Awaiting Input", ...pillRest })).toBe("waiting");
    expect(resolveAgentGroup({ label: "Plan Ready", ...pillRest })).toBe("waiting");
    expect(resolveAgentGroup({ label: "Completed", ...pillRest })).toBe("done");
    expect(resolveAgentGroup(null)).toBe("done");
  });
});

describe("resolveAgentPreviewLine", () => {
  it("shows the tool line only while working, else assistant, else prompt", () => {
    const preview = { prompt: "p", tool: "Bash: ls", assistantMessage: "a" };
    expect(resolveAgentPreviewLine(workingPill, preview)).toBe("Bash: ls");
    expect(resolveAgentPreviewLine({ label: "Connecting", ...pillRest }, preview)).toBe("Bash: ls");
    expect(resolveAgentPreviewLine(workingPill, { ...preview, tool: null })).toBe("a");
    expect(resolveAgentPreviewLine(completedPill, preview)).toBe("a");
    expect(resolveAgentPreviewLine(completedPill, { ...preview, assistantMessage: null })).toBe(
      "p",
    );
    expect(
      resolveAgentPreviewLine(completedPill, {
        prompt: null,
        tool: null,
        assistantMessage: null,
      }),
    ).toBeNull();
    expect(resolveAgentPreviewLine(completedPill, null)).toBeNull();
    expect(resolveAgentPreviewLine(completedPill, undefined)).toBeNull();
  });
});

describe("buildAgentRows", () => {
  it("includes only non-archived shells with a session", () => {
    const included = makeShell({ id: ThreadId.make("thread-included") });
    const archived = makeShell({
      id: ThreadId.make("thread-archived"),
      archivedAt: "2026-08-30T12:00:00.000Z",
    });
    const sessionless = makeShell({
      id: ThreadId.make("thread-sessionless"),
      session: null,
    });

    const rows = buildRows([archived, included, sessionless]);

    expect(rows.map((row) => row.shell.id)).toEqual([ThreadId.make("thread-included")]);
    expect(rows[0]?.key).toBe("environment-a:thread-included");
    expect(rows[0]?.ref).toEqual({
      environmentId: ENVIRONMENT_A,
      threadId: ThreadId.make("thread-included"),
    });
  });

  it("marks rows stale when availability is not 'live'", () => {
    const stale = makeShell({ id: ThreadId.make("thread-stale") });
    const unknown = makeShell({
      id: ThreadId.make("thread-unknown"),
      environmentId: ENVIRONMENT_B,
    });

    const rows = buildRows([stale, unknown], {
      availabilityByEnvironmentId: new Map<string, EnvironmentAvailabilityStatus>([
        [ENVIRONMENT_A, "degraded"],
      ]),
    });

    expect(
      rows.map((row) => ({
        id: row.shell.id,
        environmentLive: row.environmentLive,
        environmentStatus: row.environmentStatus,
      })),
    ).toEqual([
      {
        id: ThreadId.make("thread-stale"),
        environmentLive: false,
        environmentStatus: "degraded",
      },
      {
        id: ThreadId.make("thread-unknown"),
        environmentLive: false,
        environmentStatus: null,
      },
    ]);
  });

  it("builds a lowercase haystack containing title, project, branch, env label, provider, pill label, previews", () => {
    const shell = makeShell({
      title: "Fix Auth Flow",
      branch: "Feature/Login",
      session: makeSession({ status: "running", providerName: "Claude Code" }),
      conversationPreview: {
        prompt: "Prompt Text",
        tool: "Bash: pnpm TEST",
        assistantMessage: "Assistant Reply",
      },
    });

    const rows = buildRows([shell], {
      projectTitleById: new Map<string, string>([[PROJECT_A, "Orca UI"]]),
      environmentLabelById: new Map<string, string>([[ENVIRONMENT_A, "Build Farm"]]),
    });
    const searchText = rows[0]?.searchText;

    expect(searchText).toBe(searchText?.toLowerCase());
    for (const part of [
      "fix auth flow",
      "orca ui",
      "feature/login",
      "build farm",
      "claude code",
      "working",
      "prompt text",
      "bash: pnpm test",
      "assistant reply",
    ]) {
      expect(searchText).toContain(part);
    }
  });
});

describe("groupAgentRows", () => {
  it("orders groups working → blocked → waiting → done and elides empty groups", () => {
    const rows = buildRows([
      makeShell({ id: ThreadId.make("thread-done") }),
      makeShell({ id: ThreadId.make("thread-waiting"), hasPendingUserInput: true }),
      makeShell({ id: ThreadId.make("thread-blocked"), hasPendingApprovals: true }),
      makeShell({
        id: ThreadId.make("thread-working"),
        session: makeSession({ status: "running" }),
      }),
    ]);

    expect(groupAgentRows(rows, "").map((group) => ({ id: group.id, label: group.label }))).toEqual(
      [
        { id: "working", label: "Working" },
        { id: "blocked", label: "Pending Approval" },
        { id: "waiting", label: "Awaiting Input" },
        { id: "done", label: "Done" },
      ],
    );
    expect(
      groupAgentRows(
        rows.filter((row) => row.group !== "blocked"),
        "",
      ).map((group) => group.id),
    ).toEqual(["working", "waiting", "done"]);
  });

  it("sorts rows by updatedAt desc with key tie-break", () => {
    const rows = buildRows([
      makeShell({
        id: ThreadId.make("thread-tie-b"),
        updatedAt: "2026-08-31T13:00:00.000Z",
      }),
      makeShell({
        id: ThreadId.make("thread-oldest"),
        updatedAt: "2026-08-31T11:00:00.000Z",
      }),
      makeShell({
        id: ThreadId.make("thread-newest"),
        updatedAt: "2026-08-31T14:00:00.000Z",
      }),
      makeShell({
        id: ThreadId.make("thread-tie-a"),
        updatedAt: "2026-08-31T13:00:00.000Z",
      }),
    ]);

    expect(groupAgentRows(rows, "")[0]?.rows.map((row) => row.shell.id)).toEqual([
      ThreadId.make("thread-newest"),
      ThreadId.make("thread-tie-a"),
      ThreadId.make("thread-tie-b"),
      ThreadId.make("thread-oldest"),
    ]);
  });

  it("filters by normalized substring and fails closed past 2048 bytes", () => {
    const rows = buildRows([
      makeShell({
        id: ThreadId.make("thread-match"),
        conversationPreview: {
          prompt: "Initial prompt",
          tool: null,
          assistantMessage: "Assistant Reply",
        },
      }),
      makeShell({ id: ThreadId.make("thread-other"), title: "Unrelated work" }),
    ]);

    expect(
      groupAgentRows(rows, "  ASSISTANT   REPLY ").flatMap((group) =>
        group.rows.map((row) => row.shell.id),
      ),
    ).toEqual([ThreadId.make("thread-match")]);
    expect(groupAgentRows(rows, "x".repeat(3000))).toEqual([]);

    const atByteLimit = "é".repeat(1024);
    const pastByteLimit = `${atByteLimit}é`;
    const longSearchRow = { ...rows[0]!, searchText: pastByteLimit };
    expect(groupAgentRows([longSearchRow], atByteLimit)[0]?.rows).toEqual([longSearchRow]);
    expect(groupAgentRows([longSearchRow], pastByteLimit)).toEqual([]);
  });
});
