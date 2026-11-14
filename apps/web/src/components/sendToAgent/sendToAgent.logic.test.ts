import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type SendRequestAction,
  ThreadId,
  type TerminalSummary,
} from "@bibcode/contracts";
import { createModelSelection } from "@bibcode/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { buildAgentRows, type AgentRow } from "../sidebar/agentsSection.logic";
import type { OutOfTokensHint } from "./outOfTokens.logic";
import {
  agentAddress,
  buildSendTargets,
  canSend,
  checkoutOf,
  countCharacters,
  describeSendFailure,
  hasFinishedAnswer,
  isPersonMessage,
  parseAgentAddress,
  resolveActionAvailability,
  SEND_TO_AGENT_ACTIONS,
  type SendToAgentSource,
} from "./sendToAgent.logic";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const PROJECT = ProjectId.make("project-a");
const OTHER_PROJECT = ProjectId.make("project-b");
const AT = "2026-11-13T10:00:00.000Z";
const ROOTS = new Map<string, string>([
  [PROJECT, "/repo/a"],
  [OTHER_PROJECT, "/repo/b"],
]);

function shell(
  id: string,
  provider: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: PROJECT,
    title: id,
    modelSelection: createModelSelection(ProviderInstanceId.make(provider), "model"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    session: {
      threadId,
      status: "ready",
      providerName: provider,
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

function aiTerminal(threadId: string, terminalId: string, driverKind: string): TerminalSummary {
  return {
    threadId,
    terminalId,
    cwd: "/repo/a",
    worktreePath: null,
    status: "running",
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
    agentStatus: { state: "waiting", failed: false },
  } as TerminalSummary;
}

function rowsOf(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  terminals: ReadonlyArray<TerminalSummary> = [],
): ReadonlyArray<AgentRow> {
  return buildAgentRows({
    shells,
    projectTitleById: new Map([
      [PROJECT, "Project A"],
      [OTHER_PROJECT, "Project B"],
    ]),
    environmentLabelById: new Map([[ENVIRONMENT, "Local"]]),
    availabilityByEnvironmentId: new Map([[ENVIRONMENT, "live"]]),
    terminals: [{ environmentId: ENVIRONMENT, rows: terminals }],
  });
}

const assistant = (text: string, streaming = false) =>
  ({
    id: `m-${text}`,
    role: "assistant",
    text,
    streaming,
  }) as SendToAgentSource["messages"][number];

function source(overrides: Partial<SendToAgentSource> = {}): SendToAgentSource {
  return {
    environmentId: ENVIRONMENT,
    threadId: ThreadId.make("source"),
    terminalId: null,
    projectId: PROJECT,
    title: "Source",
    checkout: "/repo/a",
    messages: [assistant("Done.")],
    terminalHasText: false,
    ...overrides,
  };
}

const NEW_PANEL_PROVIDERS = [
  {
    value: "chat:codex",
    selection: { kind: "chat", instanceId: ProviderInstanceId.make("codex") } as const,
    label: "Codex",
    disabledReason: null,
  },
];

function targets(
  action: SendRequestAction,
  rows: ReadonlyArray<AgentRow>,
  overrides: {
    source?: SendToAgentSource;
    canNotifyTerminal?: (row: AgentRow) => boolean;
  } = {},
) {
  return buildSendTargets({
    source: overrides.source ?? source(),
    action,
    rows,
    projectRootByProjectId: ROOTS,
    newPanelProviders: NEW_PANEL_PROVIDERS,
    canNotifyTerminal: overrides.canNotifyTerminal ?? (() => false),
  });
}

const baseRows = () =>
  rowsOf(
    [
      shell("source", "claudeAgent"),
      shell("codex-panel", "codex", { updatedAt: "2026-11-13T11:00:00.000Z" }),
      shell("host", "codex"),
      shell("elsewhere", "codex", { projectId: OTHER_PROJECT }),
      shell("other-environment", "codex", { environmentId: EnvironmentId.make("environment-b") }),
      shell("worktree-panel", "codex", { worktreePath: "/repo/a-wt" }),
    ],
    [aiTerminal("host", "t1", "codex")],
  );

const byTitle = (entries: ReturnType<typeof targets>, title: string) =>
  entries.find((entry) => entry.title === title);

describe("buildSendTargets", () => {
  it("lists the Codex panel, the Codex terminal and the new-panel entry for Second opinion with title, provider and busy flag", () => {
    const entries = targets("second-opinion", baseRows());
    const panel = byTitle(entries, "codex-panel");
    expect(panel).toMatchObject({ title: "codex-panel", busy: false });
    expect(panel?.providerLabel).toBeTruthy();
    const terminal = entries.find(
      (entry) => entry.target.kind === "agent" && entry.target.row.terminalId === "t1",
    );
    expect(terminal?.target).toMatchObject({ address: "terminal:host/t1" });
    expect(entries.at(-1)).toMatchObject({
      target: { kind: "new-panel" },
      title: "Codex",
      disabledReason: null,
    });
  });

  it("lists no agent of another project or environment", () => {
    const entries = targets("second-opinion", baseRows());
    expect(byTitle(entries, "elsewhere")).toBeUndefined();
    expect(byTitle(entries, "other-environment")).toBeUndefined();
    expect(byTitle(entries, "codex-panel")).toBeDefined();
  });

  it("never lists the source itself but lists the chat agent that owns a source terminal", () => {
    const rows = baseRows();
    expect(byTitle(targets("message", rows), "source")).toBeUndefined();
    const terminalSource = source({
      threadId: ThreadId.make("host"),
      terminalId: "t1",
      terminalHasText: true,
    });
    const entries = targets("message", rows, {
      source: terminalSource,
      canNotifyTerminal: () => true,
    });
    expect(entries.filter((entry) => entry.title === "host")).toHaveLength(1);
    expect(
      entries.some(
        (entry) => entry.target.kind === "agent" && entry.target.row.terminalId === "t1",
      ),
    ).toBe(false);
  });

  it("offers no new-panel entry for Take over from", () => {
    expect(
      targets("take-over", baseRows()).some((entry) => entry.target.kind === "new-panel"),
    ).toBe(false);
  });

  it('Review to an agent in another checkout is disabled with "This agent works in another checkout and cannot see these changes"', () => {
    const entries = targets("review", baseRows());
    expect(byTitle(entries, "worktree-panel")?.disabledReason).toBe(
      "This agent works in another checkout and cannot see these changes",
    );
  });

  it("an agent in the same checkout can be picked for Review, and a terminal counts with its thread's checkout", () => {
    const entries = targets("review", baseRows(), { canNotifyTerminal: () => true });
    expect(byTitle(entries, "codex-panel")?.disabledReason).toBeNull();
    const terminal = entries.find(
      (entry) => entry.target.kind === "agent" && entry.target.row.terminalId === "t1",
    );
    expect(terminal?.disabledReason).toBeNull();
    const row = baseRows().find((candidate) => candidate.terminalId === "t1");
    expect(row && checkoutOf(row, ROOTS)).toBe("/repo/a");
  });

  it('a terminal that cannot be notified is disabled with "This terminal cannot be notified of new requests" for Review, Second opinion, Hand off and Message', () => {
    for (const action of ["review", "second-opinion", "hand-off", "message"] as const) {
      const entries = targets(action, baseRows());
      const terminal = entries.find(
        (entry) => entry.target.kind === "agent" && entry.target.row.terminalId === "t1",
      );
      expect(terminal?.disabledReason, action).toBe(
        "This terminal cannot be notified of new requests",
      );
    }
  });

  it("the same terminal can be picked for Take over from", () => {
    const terminal = targets("take-over", baseRows()).find(
      (entry) => entry.target.kind === "agent" && entry.target.row.terminalId === "t1",
    );
    expect(terminal?.disabledReason).toBeNull();
  });

  it('Take over from an agent with no messages is disabled with "Nothing to take over yet"', () => {
    const rows = rowsOf([
      shell("source", "claudeAgent"),
      shell("empty", "codex", { latestUserMessageAt: null, latestTurn: null }),
    ]);
    expect(byTitle(targets("take-over", rows), "empty")?.disabledReason).toBe(
      "Nothing to take over yet",
    );
  });

  it("a disabled agent stays in the list", () => {
    expect(byTitle(targets("review", baseRows()), "worktree-panel")).toBeDefined();
  });

  it("keeps the newest agent first and marks a working agent busy", () => {
    const rows = rowsOf([
      shell("source", "claudeAgent"),
      shell("older", "codex"),
      shell("newer", "codex", {
        updatedAt: "2026-11-13T12:00:00.000Z",
        session: {
          threadId: ThreadId.make("newer"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: AT,
        } as never,
      }),
    ]);
    const entries = targets("message", rows);
    expect(entries.map((entry) => entry.title).slice(0, 2)).toEqual(["newer", "older"]);
    expect(entries[0]?.busy).toBe(true);
  });

  describe("out-of-tokens hints", () => {
    const usageHint: OutOfTokensHint = {
      kind: "usage-limit",
      text: "Out of usage until 3:30 PM",
      resetsAt: null,
    };
    const hintedRows = () =>
      rowsOf([
        shell("newest", "codex", { updatedAt: "2026-11-13T12:00:00.000Z" }),
        shell("claude-new", "claudeAgent", { updatedAt: "2026-11-13T11:00:00.000Z" }),
        shell("middle", "codex", { updatedAt: "2026-11-13T10:30:00.000Z" }),
        shell("claude-old", "claudeAgent", { updatedAt: "2026-11-13T10:00:00.000Z" }),
        shell("cursor", "cursor", { updatedAt: "2026-11-13T09:00:00.000Z" }),
      ]);
    const hintFor = (row: AgentRow) => (row.shell.title.startsWith("claude") ? usageHint : null);
    const hinted = (action: SendRequestAction) =>
      buildSendTargets({
        source: source(),
        action,
        rows: hintedRows(),
        projectRootByProjectId: ROOTS,
        newPanelProviders: NEW_PANEL_PROVIDERS,
        canNotifyTerminal: () => false,
        hintFor,
      });

    it("Take over from lists hinted agents first and keeps recency order inside each group", () => {
      expect(hinted("take-over").map((entry) => entry.title)).toEqual([
        "claude-new",
        "claude-old",
        "newest",
        "middle",
        "cursor",
      ]);
      expect(
        hinted("message")
          .map((entry) => entry.title)
          .slice(0, 5),
      ).toEqual(["newest", "claude-new", "middle", "claude-old", "cursor"]);
    });

    it("a hinted agent is not disabled for Review, Second opinion, Hand off or Message", () => {
      for (const action of ["review", "second-opinion", "hand-off", "message"] as const) {
        const entry = byTitle(hinted(action), "claude-new");
        expect(entry?.hint, action).toEqual(usageHint);
        expect(entry?.disabledReason, action).toBeNull();
      }
    });

    it("a Cursor agent with no hint can still be taken over from", () => {
      const entry = byTitle(hinted("take-over"), "cursor");
      expect(entry?.hint).toBeNull();
      expect(entry?.disabledReason).toBeNull();
    });
  });
});

describe("resolveActionAvailability", () => {
  it('Second opinion with no finished answer is disabled with "No answer to review yet" (also when the only assistant message is streaming)', () => {
    for (const messages of [[], [assistant("Working", true)]]) {
      expect(
        resolveActionAvailability({
          source: source({ messages }),
          action: "second-opinion",
          serverSupported: true,
        }).disabledReason,
      ).toBe("No answer to review yet");
    }
    expect(
      resolveActionAvailability({
        source: source(),
        action: "second-opinion",
        serverSupported: true,
      }).disabledReason,
    ).toBeNull();
  });

  it('a terminal source with no selection and no output disables Second opinion and Hand off with "Nothing to attach yet"', () => {
    const terminal = source({ terminalId: "t1", terminalHasText: false, messages: [] });
    for (const action of ["second-opinion", "hand-off"] as const) {
      expect(
        resolveActionAvailability({ source: terminal, action, serverSupported: true })
          .disabledReason,
      ).toBe("Nothing to attach yet");
    }
    expect(
      resolveActionAvailability({
        source: { ...terminal, terminalHasText: true },
        action: "second-opinion",
        serverSupported: true,
      }).disabledReason,
    ).toBeNull();
  });

  it("an environment without the sendRequests capability disables every action with the update reason", () => {
    for (const { action } of SEND_TO_AGENT_ACTIONS) {
      expect(
        resolveActionAvailability({ source: source(), action, serverSupported: false })
          .disabledReason,
      ).toBe("Update the BiBCode server on this environment to use Send to agent.");
    }
  });
});

describe("agent addresses and message predicates", () => {
  it("agentAddress and parseAgentAddress round-trip thread and terminal addresses", () => {
    const rows = baseRows();
    const chat = rows.find((row) => row.terminalId === null && row.ref.threadId === "host");
    const terminal = rows.find((row) => row.terminalId === "t1");
    expect(chat && agentAddress(chat)).toBe("thread:host");
    expect(terminal && agentAddress(terminal)).toBe("terminal:host/t1");
    expect(parseAgentAddress("thread:host")).toEqual({ threadId: "host", terminalId: null });
    expect(parseAgentAddress("terminal:host/t1")).toEqual({ threadId: "host", terminalId: "t1" });
    expect(parseAgentAddress("nonsense")).toBeNull();
  });

  it("hasFinishedAnswer ignores streaming and empty assistant messages", () => {
    expect(hasFinishedAnswer([assistant("Working", true), assistant("  ")])).toBe(false);
    expect(hasFinishedAnswer([assistant("Done")])).toBe(true);
  });

  it("isPersonMessage is true for a user message without an actor and false for an assistant message and for a user message with an actor", () => {
    expect(isPersonMessage({ role: "user", actor: undefined })).toBe(true);
    expect(isPersonMessage({ role: "assistant", actor: undefined })).toBe(false);
    expect(
      isPersonMessage({
        role: "user",
        actor: { kind: "hosted-agent", address: "thread:x", label: "Agent" } as never,
      }),
    ).toBe(false);
  });
});

describe("request limits and failure copy", () => {
  it("countCharacters counts a non-BMP character as one", () => {
    expect(countCharacters("a\u{1F600}b")).toBe(3);
  });

  it('canSend refuses an empty or whitespace Message with "Write a message first"', () => {
    for (const note of ["", "  \n"]) {
      expect(canSend({ action: "message", note, attachments: [], sending: false })).toEqual({
        allowed: false,
        reason: "Write a message first",
      });
    }
  });

  it("canSend allows an empty note for the other four actions", () => {
    for (const action of ["review", "second-opinion", "hand-off", "take-over"] as const) {
      expect(canSend({ action, note: "", attachments: [], sending: false }).allowed).toBe(true);
    }
  });

  it("canSend refuses a request over 48,000 characters, and accepts exactly 48,000 non-BMP characters", () => {
    const limit = "\u{1F600}".repeat(48_000);
    expect(
      canSend({ action: "review", note: "", attachments: [{ text: limit }], sending: false })
        .allowed,
    ).toBe(true);
    const over = canSend({
      action: "review",
      note: "x",
      attachments: [{ text: limit }],
      sending: false,
    });
    expect(over.allowed).toBe(false);
    expect(over.reason).toContain("48,000");
  });

  it("canSend refuses while a send is in flight", () => {
    expect(canSend({ action: "message", note: "hi", attachments: [], sending: true }).allowed).toBe(
      false,
    );
  });

  it("describeSendFailure covers every reason with copy that names what to do", () => {
    const reasons = [
      "person_only",
      "invalid",
      "too_long",
      "other_project",
      "unknown_thread",
      "target_not_notifiable",
      "request_conflict",
      "not_found",
      "not_final",
      "not_answered",
      "not_cancellable",
      "storage",
      "unknown_outcome",
    ] as const;
    for (const reason of reasons) {
      const described = describeSendFailure({ kind: "failed", reason, message: "server text" });
      expect(described.message, reason).toMatch(/(Try again|Press Send again|Pick|Remove)/);
      expect(described.message).not.toContain("server text");
    }
    expect(describeSendFailure({ kind: "failed", reason: "unknown_thread", message: "" })).toEqual({
      message: "This agent no longer exists. Pick another agent.",
      next: "pick-another",
    });
    expect(describeSendFailure({ kind: "failed", reason: "too_long", message: "" }).next).toBe(
      "trim",
    );
    expect(describeSendFailure({ kind: "failed", reason: "unknown_outcome", message: "" })).toEqual(
      {
        message:
          "BiBCode could not confirm the send. Press Send again; the agent receives it once.",
        next: "retry",
      },
    );
  });
});
