import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import type { EnvironmentAvailabilityStatus } from "@bibcode/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@bibcode/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TerminalSummary,
} from "@bibcode/contracts";
import { createModelSelection } from "@bibcode/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_STATUS_STALE_AFTER_MS } from "../Sidebar.logic";
import {
  AGENT_GROUP_ORDER,
  type AgentRowFreshness,
  agentRowUnreadKey,
  buildAgentRows,
  buildAgentViewGroups,
  countUnreadAgentRows,
  resolveAgentGroup,
  terminalAgentRowKey,
} from "./agentsSection.logic";

// Rows per agent, the unknown group and its reasons (#187), on the shared row contract
// with the Inbox (#186).

const ENVIRONMENT = EnvironmentId.make("environment-a");
const PROJECT = ProjectId.make("project-a");
const AT = "2026-10-27T11:00:00.000Z";
const NOW = Date.parse("2026-10-27T12:00:00.000Z");

function shell(
  id: string,
  sessionStatus: "running" | "ready" | "error" | null,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: PROJECT,
    title: id,
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    session:
      sessionStatus === null
        ? null
        : {
            threadId,
            status: sessionStatus,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: AT,
          },
    latestUserMessageAt: AT,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    conversationPreview: null,
    environmentId: ENVIRONMENT,
    ...overrides,
  } as EnvironmentThreadShell;
}

function aiTerminal(
  threadId: string,
  terminalId: string,
  driverKind: string,
  agentStatus: TerminalSummary["agentStatus"],
  status: TerminalSummary["status"] = "running",
): TerminalSummary {
  return {
    threadId,
    terminalId,
    cwd: "/repo",
    worktreePath: null,
    status,
    pid: 1,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    label: driverKind,
    updatedAt: AT,
    centerPanel: true,
    command: {
      executable: driverKind,
      args: [],
      label: `${driverKind} Terminal`,
      activity: {
        driverKind: driverKind as never,
        providerInstanceId: ProviderInstanceId.make(driverKind),
      },
    },
    ...(agentStatus === undefined ? {} : { agentStatus }),
  } as TerminalSummary;
}

const fresh: AgentRowFreshness = { now: NOW, evidenceAt: () => NOW - 60_000 };
const stale: AgentRowFreshness = {
  now: NOW,
  evidenceAt: (_key, evidence) =>
    evidence === undefined ? null : NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
};

function rows(input: {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly terminals?: ReadonlyArray<TerminalSummary>;
  readonly availability?: EnvironmentAvailabilityStatus;
  readonly freshness?: AgentRowFreshness;
}) {
  return buildAgentRows({
    shells: input.shells,
    projectTitleById: new Map([[PROJECT, "Project"]]),
    environmentLabelById: new Map([[ENVIRONMENT, "Local"]]),
    availabilityByEnvironmentId: new Map([[ENVIRONMENT, input.availability ?? "live"]]),
    terminals: [{ environmentId: ENVIRONMENT, rows: input.terminals ?? [] }],
    freshness: input.freshness ?? fresh,
  });
}

const keyOf = (id: string) => scopedThreadKey(scopeThreadRef(ENVIRONMENT, ThreadId.make(id)));

describe("agent groups (#187)", () => {
  it("orders unknown between the groups that need attention and Done", () => {
    expect(AGENT_GROUP_ORDER.map((group) => group.id)).toEqual([
      "working",
      "blocked",
      "waiting",
      "unknown",
      "done",
    ]);
    expect(resolveAgentGroup(null, "stale")).toBe("unknown");
    expect(resolveAgentGroup(null)).toBe("done");
  });

  it("maps every chat status to its group", () => {
    const groups = rows({
      shells: [
        shell("working", "running"),
        shell("question", "running", { hasPendingUserInput: true }),
        shell("approval", "running", { hasPendingApprovals: true }),
        shell("failed", "error"),
        shell("finished", "ready"),
      ],
    }).map((row) => [row.shell.title, row.group, row.pill?.label ?? null] as const);
    expect(groups).toEqual([
      ["working", "working", "Working"],
      ["question", "waiting", "Awaiting Input"],
      ["approval", "blocked", "Pending Approval"],
      ["failed", "done", "Failed"],
      ["finished", "done", null],
    ]);
  });

  it("moves a silent Working agent to unknown, never to Done", () => {
    const [row] = rows({
      shells: [shell("silent", "running", { lastActivityAt: AT, lastActivityAgeMs: 0 })],
      freshness: stale,
    });
    expect(row).toMatchObject({
      group: "unknown",
      unknownReason: "stale",
      pill: { label: "No update" },
    });
  });

  it("lists a disconnected environment's agents as unknown and offline", () => {
    const [row] = rows({ shells: [shell("cached", "running")], availability: "unavailable" });
    expect(row).toMatchObject({ group: "unknown", unknownReason: "offline" });
  });
});

describe("AI Terminal rows (#187)", () => {
  it("adds one row per terminal agent, keyed apart from its host's chat row", () => {
    const listed = rows({
      shells: [shell("host", "ready")],
      terminals: [
        aiTerminal("host", "t-claude", "claudeAgent", { state: "waiting", failed: false }),
      ],
    });
    expect(listed.map((row) => [row.key, row.terminalId, row.group])).toEqual([
      [keyOf("host"), null, "done"],
      [terminalAgentRowKey(keyOf("host"), "t-claude"), "t-claude", "waiting"],
    ]);
    expect(listed[1]).toMatchObject({
      ref: scopeThreadRef(ENVIRONMENT, ThreadId.make("host")),
      providerDriverKind: "claudeAgent",
      previewLine: "claudeAgent Terminal",
    });
  });

  it("lists a terminal agent in a workspace with no chat session", () => {
    const listed = rows({
      shells: [shell("terminal-only", null)],
      terminals: [aiTerminal("terminal-only", "t1", "codex", { state: "working", failed: false })],
    });
    expect(listed.map((row) => [row.terminalId, row.group])).toEqual([["t1", "working"]]);
  });

  it("shows an unobserved agent as unknown while it runs and drops it once it ends", () => {
    const running = rows({
      shells: [shell("host", null)],
      terminals: [
        aiTerminal("host", "t-cursor", "cursor", { state: "unavailable", failed: false }),
      ],
    });
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ group: "unknown", unknownReason: "unavailable" });
    expect(
      rows({
        shells: [shell("host", null)],
        terminals: [
          aiTerminal(
            "host",
            "t-cursor",
            "cursor",
            { state: "unavailable", failed: false },
            "exited",
          ),
        ],
      }),
    ).toEqual([]);
  });

  it("ignores plain shells and terminals of archived threads", () => {
    expect(
      rows({
        shells: [shell("archived", null, { archivedAt: AT }), shell("host", null)],
        terminals: [
          aiTerminal("archived", "t1", "codex", { state: "working", failed: false }),
          aiTerminal("host", "shell", "zsh", undefined),
        ],
      }),
    ).toEqual([]);
  });

  it("shares its host thread's unread state and is counted once", () => {
    const listed = rows({
      shells: [shell("host", "ready")],
      terminals: [aiTerminal("host", "t1", "codex", { state: "done", failed: false })],
    });
    expect(listed.map(agentRowUnreadKey)).toEqual([keyOf("host"), keyOf("host")]);
    expect(countUnreadAgentRows(listed, [keyOf("host")])).toBe(1);
    const unreadOnly = buildAgentViewGroups(listed, {
      query: "",
      groupBy: "status",
      unreadOnly: true,
      unreadThreadKeys: [keyOf("host")],
      selectedKey: null,
    });
    expect(unreadOnly.flatMap((group) => group.rows.map((row) => row.terminalId))).toEqual([
      null,
      "t1",
    ]);
  });
});
