import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type DefaultAgentSelection,
  type SendRequestsSendInput,
  type VcsStatusResult,
} from "@bibcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { codeReviewGuardLine, resolveCodeReviewPrompt } from "~/codeReview";
import { resolveCodeReviewScope } from "../SourceControlPanel.logic";
import type { AgentRow } from "../sidebar/agentsSection.logic";
import { useSendToAgentStore } from "~/sendToAgentStore";
import type { PromptedPanelResult } from "~/centerPanelActions";
import type { SendOutcome } from "~/state/sendRequests";
import {
  buildReviewContent,
  buildReviewScopeOptions,
  reviewEditWarning,
  reviewPanelProviders,
  REVIEW_PANEL_NOT_OPENED_MESSAGE,
} from "./review.logic";
import { describeSendFailure, type SendToAgentSource } from "./sendToAgent.logic";

const BASE: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/demo",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  defaultRefName: "main",
  aheadOfDefaultCount: 0,
};
const DIRTY: VcsStatusResult = {
  ...BASE,
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "a.ts", insertions: 1, deletions: 0, area: "unstaged" }],
    insertions: 1,
    deletions: 0,
  },
};

const source: SendToAgentSource = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("source"),
  terminalId: null,
  projectId: ProjectId.make("project-a"),
  title: "Source",
  checkout: "/repo/a",
  messages: [],
  terminalHasText: false,
};
const codex: DefaultAgentSelection = {
  kind: "chat",
  instanceId: ProviderInstanceId.make("codex"),
};
const BRANCH = { kind: "branch", base: "origin/main" } as const;

function agentRow(overrides: { runtimeMode?: string; terminalId?: string | null }): AgentRow {
  return {
    key: "beta",
    ref: { environmentId: source.environmentId, threadId: ThreadId.make("beta") },
    terminalId: overrides.terminalId ?? null,
    shell: { runtimeMode: overrides.runtimeMode ?? "approval-required", title: "beta" },
  } as unknown as AgentRow;
}
const agentTarget = (row: AgentRow) => ({ kind: "agent", row, address: "thread:beta" }) as const;

function build(
  overrides: Partial<Parameters<typeof buildReviewContent>[0]> = {},
  send: (input: SendRequestsSendInput) => Promise<SendOutcome> = () =>
    Promise.resolve({ kind: "sent" }),
) {
  let counter = 0;
  return buildReviewContent({
    scope: BRANCH,
    projectPrompt: "",
    userPrompt: "",
    target: { kind: "new-panel", selection: codex },
    guardLine: null,
    sourceKey: "source-key",
    source,
    send,
    newId: () => `request-${(counter += 1)}`,
    startNewPanelReview: () =>
      Promise.resolve({ threadId: null, created: false, messageId: null, sent: "not-sent" }),
    ...overrides,
  });
}

beforeEach(() => {
  useSendToAgentStore.setState({ notes: {}, pending: {}, panels: {} });
});

describe("buildReviewScopeOptions", () => {
  it("the default option is the scope the Code review button would use", () => {
    for (const status of [
      { ...DIRTY, aheadOfDefaultCount: 2 },
      DIRTY,
      { ...BASE, aheadOfDefaultCount: 2 },
      BASE,
    ]) {
      const expected = resolveCodeReviewScope(status);
      const defaults = buildReviewScopeOptions(status).filter((option) => option.isDefault);
      expect(defaults.map((option) => option.scope.kind)).toEqual(
        expected === null ? [] : [expected.kind],
      );
    }
  });

  it("both scopes are offered and one without changes is disabled with its reason", () => {
    const clean = buildReviewScopeOptions(BASE);
    expect(clean.map((option) => option.scope.kind)).toEqual(["branch", "uncommitted"]);
    expect(clean.map((option) => option.disabledReason)).toEqual([
      "No commits ahead of origin/main",
      "No uncommitted changes",
    ]);
    const ahead = buildReviewScopeOptions({ ...BASE, aheadOfDefaultCount: 3 });
    expect(ahead.map((option) => option.disabledReason)).toEqual([null, "No uncommitted changes"]);
    expect(buildReviewScopeOptions(DIRTY)[1]!.disabledReason).toBeNull();
  });
});

describe("buildReviewContent", () => {
  it("the lead-in plus the note equals the button's prompt with the note as extra instructions", () => {
    const content = build({ projectPrompt: "Project rules", userPrompt: "" });
    const note = "  focus on the retry path  ";
    expect(`${content.leadIn}\n\n${note.trim()}`).toBe(
      resolveCodeReviewPrompt({
        project: "Project rules",
        user: "",
        scope: BRANCH,
        extra: note.trim(),
      }),
    );
  });

  it("a review attaches no diff", () => {
    const content = build();
    expect(content.attachments).toEqual([]);
    expect(content.leadIn).toContain("Do not edit files");
    expect(content.leadIn).toContain(
      "the commits on the current branch that are not on origin/main",
    );
  });

  it("a running agent in auto-accept-edits or full-access gets the edit warning", () => {
    const warning =
      "This agent can change files. The request asks it not to, but BiBCode cannot stop it.";
    expect(reviewEditWarning(agentTarget(agentRow({ runtimeMode: "auto-accept-edits" })))).toBe(
      warning,
    );
    expect(reviewEditWarning(agentTarget(agentRow({ runtimeMode: "full-access" })))).toBe(warning);
    expect(build({ target: agentTarget(agentRow({ runtimeMode: "full-access" })) }).warning).toBe(
      warning,
    );
  });

  it("an agent in approval-required gets none", () => {
    expect(
      reviewEditWarning(agentTarget(agentRow({ runtimeMode: "approval-required" }))),
    ).toBeNull();
  });

  it("any terminal agent gets the warning", () => {
    expect(
      reviewEditWarning(
        agentTarget(agentRow({ terminalId: "t1", runtimeMode: "approval-required" })),
      ),
    ).toBe(
      "This terminal agent can change files. The request asks it not to, but BiBCode cannot stop it.",
    );
  });

  it("a new panel shows the guard line of its reviewer", () => {
    const codexLine = codeReviewGuardLine({
      kind: "chat",
      driver: ProviderDriverKind.make("codex"),
    });
    expect(codexLine).toBe("Runs in Codex's read-only sandbox. Writes ask for your approval.");
    expect(build({ guardLine: codexLine }).warning).toBe(codexLine);
    const instructed = codeReviewGuardLine({
      kind: "chat",
      driver: ProviderDriverKind.make("gemini"),
    });
    expect(instructed).toBe("Told not to edit. BiBCode cannot block edits for this agent.");
    expect(build({ guardLine: instructed }).warning).toBe(instructed);
  });

  it("an agent target sends action review with the lead-in and the note and no attachments", async () => {
    const send = vi.fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>(() =>
      Promise.resolve({ kind: "sent" }),
    );
    const content = build({ target: agentTarget(agentRow({})) }, send);
    const outcome = await content.submit!({
      leadIn: content.leadIn,
      note: "look",
      attachments: [],
    });
    expect(outcome).toEqual({ kind: "sent" });
    expect(send).toHaveBeenCalledWith({
      requestId: "request-1",
      action: "review",
      source: "thread:source",
      target: "thread:beta",
      leadIn: content.leadIn,
      note: "look",
      attachments: [],
    });
  });

  it("a new-panel review creates its panel once through the launcher with the picked reviewer, then sends to thread:{panel}", async () => {
    const send = vi.fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>(() =>
      Promise.resolve({ kind: "sent" }),
    );
    const startNewPanelReview = vi.fn(
      async (input: {
        send: (panel: ThreadId) => Promise<SendOutcome>;
      }): Promise<PromptedPanelResult> => {
        await input.send(ThreadId.make("panel-1"));
        return { threadId: ThreadId.make("panel-1"), created: true, messageId: null, sent: "sent" };
      },
    );
    const content = build({ startNewPanelReview }, send);
    const outcome = await content.submit!({
      leadIn: content.leadIn,
      note: "look",
      attachments: [],
    });
    expect(outcome).toEqual({ kind: "sent" });
    expect(startNewPanelReview).toHaveBeenCalledTimes(1);
    expect(startNewPanelReview.mock.calls[0]![0]).toMatchObject({
      scope: BRANCH,
      selection: codex,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: "review", target: "thread:panel-1", note: "look" }),
    );
    expect(useSendToAgentStore.getState().panels).toEqual({});
  });

  it("a failed or unknown send keeps the preview, remembers the panel, and the retry sends to the same panel without creating another and without a second request id", async () => {
    const send = vi
      .fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>()
      .mockResolvedValueOnce({ kind: "failed", reason: "unknown_outcome", message: "lost" })
      .mockResolvedValueOnce({ kind: "sent" });
    const startNewPanelReview = vi.fn(
      async (input: {
        send: (panel: ThreadId) => Promise<SendOutcome>;
      }): Promise<PromptedPanelResult> => {
        await input.send(ThreadId.make("panel-1"));
        return {
          threadId: ThreadId.make("panel-1"),
          created: true,
          messageId: null,
          sent: "unknown",
        };
      },
    );
    const content = build({ startNewPanelReview }, send);
    const draft = { leadIn: content.leadIn, note: "look", attachments: [] };
    const first = await content.submit!(draft);
    expect(first).toMatchObject({ kind: "failed", reason: "unknown_outcome" });
    expect(Object.values(useSendToAgentStore.getState().panels)).toEqual(["panel-1"]);
    const second = await content.submit!(draft);
    expect(second).toEqual({ kind: "sent" });
    expect(startNewPanelReview).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].requestId).toBe(send.mock.calls[1]![0].requestId);
    expect(send.mock.calls[1]![0].target).toBe("thread:panel-1");
    expect(useSendToAgentStore.getState().panels).toEqual({});
  });

  it("a creation whose outcome is unknown keeps its panel id, so the retry sends there and creates nothing", async () => {
    const send = vi.fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>(() =>
      Promise.resolve({ kind: "sent" }),
    );
    // The launcher's creation response was lost: the panel id is known, the panel may exist.
    const startNewPanelReview = vi.fn(
      (): Promise<PromptedPanelResult> =>
        Promise.resolve({
          threadId: ThreadId.make("panel-1"),
          created: false,
          messageId: null,
          sent: "not-sent",
        }),
    );
    const content = build({ startNewPanelReview }, send);
    const draft = { leadIn: content.leadIn, note: "look", attachments: [] };
    const first = await content.submit!(draft);
    expect(first).toMatchObject({ kind: "failed", message: REVIEW_PANEL_NOT_OPENED_MESSAGE });
    expect(send).not.toHaveBeenCalled();
    const second = await content.submit!(draft);
    expect(second).toEqual({ kind: "sent" });
    expect(startNewPanelReview).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].target).toBe("thread:panel-1");
    expect(useSendToAgentStore.getState().panels).toEqual({});
  });

  it("a panel that could not be created keeps the preview and says so", async () => {
    const content = build();
    const outcome = await content.submit!({ leadIn: content.leadIn, note: "", attachments: [] });
    expect(outcome).toMatchObject({ kind: "failed", message: REVIEW_PANEL_NOT_OPENED_MESSAGE });
    expect(REVIEW_PANEL_NOT_OPENED_MESSAGE).toBe(
      "BiBCode could not open the review panel. Try again.",
    );
    expect(describeSendFailure(outcome as Extract<SendOutcome, { kind: "failed" }>)).toEqual({
      message: "BiBCode could not open the review panel. Try again.",
      next: "retry",
    });
  });
});

describe("reviewPanelProviders", () => {
  it("terminal reviewers are not offered for a new-panel Review", () => {
    const terminal: DefaultAgentSelection = {
      kind: "terminal",
      instanceId: ProviderInstanceId.make("codex"),
    };
    const providers = reviewPanelProviders([
      {
        value: "chat:codex",
        label: "Codex",
        selection: codex,
        guardLine: "g",
        disabledReason: null,
      },
      {
        value: "terminal:codex",
        label: "Codex Terminal",
        selection: terminal,
        guardLine: "g",
        disabledReason: null,
      },
    ]);
    expect(providers).toEqual([
      { value: "chat:codex", label: "Codex", selection: codex, disabledReason: null },
    ]);
  });
});
