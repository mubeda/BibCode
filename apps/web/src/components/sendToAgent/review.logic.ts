/**
 * What the Review action previews and sends. The lead-in is the Code review button's prompt for
 * the picked scope, so a review from here and from the button ask for the same thing. A review
 * attaches nothing: the agent reads the checkout itself.
 */
import type {
  DefaultAgentSelection,
  SendRequestsSendInput,
  ThreadId,
  VcsStatusResult,
} from "@bibcode/contracts";

import type { PromptedPanelResult } from "~/centerPanelActions";
import { resolveCodeReviewPrompt, type CodeReviewMenuReviewer } from "~/codeReview";
import { useSendToAgentStore } from "~/sendToAgentStore";
import type { SendOutcome } from "~/state/sendRequests";
import { resolveCodeReviewScope, type CodeReviewScope } from "../SourceControlPanel.logic";
import {
  REVIEW_PANEL_NOT_OPENED_MESSAGE,
  sendChoiceKey,
  sourceAddressOf,
  submitSendChoice,
  type NewPanelProvider,
  type PreviewContent,
  type PreviewDraft,
  type SendTarget,
  type SendToAgentSource,
} from "./sendToAgent.logic";

export { REVIEW_PANEL_NOT_OPENED_MESSAGE } from "./sendToAgent.logic";

export interface ReviewScopeOption {
  scope: CodeReviewScope;
  label: string;
  disabledReason: string | null;
  isDefault: boolean;
}

const CHECKING_REASON = "Checking for changes";

export function buildReviewScopeOptions(
  status: VcsStatusResult | null | undefined,
): ReadonlyArray<ReviewScopeOption> {
  const base = status?.isRepo && status.defaultRefName ? `origin/${status.defaultRefName}` : null;
  const known = status?.isRepo === true;
  const defaultKind = resolveCodeReviewScope(status)?.kind ?? null;
  const ahead = known && base !== null && (status.aheadOfDefaultCount ?? 0) > 0;
  const dirty = known && (status.hasWorkingTreeChanges || status.workingTree.files.length > 0);
  return [
    {
      scope: { kind: "branch", base },
      label: base === null ? "Branch changes" : `Branch vs ${base} and uncommitted changes`,
      disabledReason: ahead
        ? null
        : !known
          ? CHECKING_REASON
          : base === null
            ? "No base branch to compare with"
            : `No commits ahead of ${base}`,
      isDefault: defaultKind === "branch",
    },
    {
      scope: { kind: "uncommitted", base },
      label: "Uncommitted changes",
      disabledReason: dirty ? null : known ? "No uncommitted changes" : CHECKING_REASON,
      isDefault: defaultKind === "uncommitted",
    },
  ];
}

const AGENT_EDIT_WARNING =
  "This agent can change files. The request asks it not to, but BiBCode cannot stop it.";
const TERMINAL_EDIT_WARNING =
  "This terminal agent can change files. The request asks it not to, but BiBCode cannot stop it.";

export function reviewEditWarning(target: SendTarget): string | null {
  if (target.kind !== "agent") return null;
  if (target.row.terminalId !== null) return TERMINAL_EDIT_WARNING;
  const mode = target.row.shell.runtimeMode;
  return mode === "auto-accept-edits" || mode === "full-access" ? AGENT_EDIT_WARNING : null;
}

/** Chat reviewers only: a launched CLI has no thread or message to track (plan decision P13b). */
export function reviewPanelProviders(
  reviewers: ReadonlyArray<CodeReviewMenuReviewer>,
): ReadonlyArray<NewPanelProvider> {
  return reviewers
    .filter((reviewer) => reviewer.selection.kind === "chat")
    .map(({ value, selection, label, disabledReason }) => ({
      value,
      selection,
      label,
      disabledReason,
    }));
}

export interface StartNewPanelReviewInput {
  scope: CodeReviewScope;
  selection: DefaultAgentSelection;
  /** The launcher calls this once the panel exists; its outcome is the review's send. */
  send: (panelThreadId: ThreadId) => Promise<SendOutcome>;
}

export function buildReviewContent(input: {
  scope: CodeReviewScope;
  projectPrompt: string;
  userPrompt: string;
  target: SendTarget;
  guardLine: string | null;
  sourceKey: string;
  source: SendToAgentSource;
  send: (input: SendRequestsSendInput) => Promise<SendOutcome>;
  newId: () => string;
  startNewPanelReview: (input: StartNewPanelReviewInput) => Promise<PromptedPanelResult>;
}): PreviewContent {
  const { scope, target, source } = input;
  const leadIn = resolveCodeReviewPrompt({
    project: input.projectPrompt,
    user: input.userPrompt,
    scope,
  });
  const choice = { source, action: "review", target } as const;
  const submit =
    target.kind === "agent"
      ? (draft: PreviewDraft) =>
          submitSendChoice(
            { send: input.send, createPanel: () => Promise.resolve(null), newId: input.newId },
            choice,
            draft,
          )
      : (draft: PreviewDraft) => submitToNewPanel(input, target.selection, draft);
  return {
    leadIn,
    attachments: [],
    warning: target.kind === "new-panel" ? input.guardLine : reviewEditWarning(target),
    submit,
  };
}

/**
 * Creates the review panel once and sends to it. A panel whose send failed or is unknown is
 * remembered, so the retry sends the same request to it and creates nothing.
 */
async function submitToNewPanel(
  input: Parameters<typeof buildReviewContent>[0],
  selection: DefaultAgentSelection,
  draft: PreviewDraft,
): Promise<SendOutcome> {
  const store = useSendToAgentStore.getState();
  const key = sendChoiceKey({ source: input.source, action: "review" });
  const panelKey = `${key}#${selection.kind}:${selection.instanceId}`;
  const requestId = store.requestIdFor(key, JSON.stringify([panelKey, draft]), input.newId);
  const sendTo = (panel: ThreadId) =>
    input.send({
      requestId,
      action: "review",
      source: sourceAddressOf(input.source),
      target: `thread:${panel}`,
      leadIn: draft.leadIn,
      note: draft.note,
      attachments: draft.attachments,
    });
  const remembered = store.panelFor(panelKey);
  const sent: { outcome: SendOutcome | null } = { outcome: null };
  if (remembered !== null) {
    sent.outcome = await sendTo(remembered);
  } else {
    const result = await input.startNewPanelReview({
      scope: input.scope,
      selection,
      send: async (panel) => (sent.outcome = await sendTo(panel)),
    });
    if (result.threadId !== null && result.created && sent.outcome?.kind === "failed") {
      useSendToAgentStore.getState().rememberPanel(panelKey, result.threadId);
    }
  }
  const { outcome } = sent;
  if (outcome === null) {
    return { kind: "failed", reason: "invalid", message: REVIEW_PANEL_NOT_OPENED_MESSAGE };
  }
  if (outcome.kind === "sent") {
    useSendToAgentStore.getState().settle(key, { requestId, note: draft.note, panelKey });
  }
  return outcome;
}
