import {
  type DefaultAgentSelection,
  type EnvironmentId,
  type OrchestrationMessage,
  type ProjectId,
  SEND_REQUEST_MAX_CHARS,
  type SendRequestAction,
  type SendRequestsSendInput,
  type TerminalSummary,
  ThreadId,
} from "@bibcode/contracts";
import type { ReactNode } from "react";

import { sendSourceKey, useSendToAgentStore } from "~/sendToAgentStore";
import type { SendOutcome } from "~/state/sendRequests";
import type { AgentRow } from "../sidebar/agentsSection.logic";
import type { OutOfTokensHint } from "./outOfTokens.logic";

export const SEND_TO_AGENT_ACTIONS: ReadonlyArray<{
  readonly action: SendRequestAction;
  readonly label: string;
}> = [
  { action: "review", label: "Review" },
  { action: "second-opinion", label: "Second opinion" },
  { action: "hand-off", label: "Hand off" },
  { action: "take-over", label: "Take over from" },
  { action: "message", label: "Message" },
];

export const NO_ANSWER_REASON = "No answer to review yet";
export const OTHER_CHECKOUT_REASON =
  "This agent works in another checkout and cannot see these changes";
export const TERMINAL_NOT_NOTIFIABLE_REASON = "This terminal cannot be notified of new requests";
export const NOTHING_TO_TAKE_OVER_REASON = "Nothing to take over yet";
export const NOTHING_TO_ATTACH_REASON = "Nothing to attach yet";
export const SEND_TO_AGENT_SERVER_UPDATE_REASON =
  "Update the BiBCode server on this environment to use Send to agent.";

export const EMPTY_MESSAGE_REASON = "Write a message first";
export const OVER_LIMIT_REASON =
  "This request is over the 48,000 character limit. Remove or shorten an attachment.";

export interface SendToAgentSource {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  terminalId: string | null;
  projectId: ProjectId;
  title: string;
  checkout: string;
  messages: ReadonlyArray<
    Pick<OrchestrationMessage, "id" | "role" | "text" | "streaming" | "actor" | "personSend">
  >;
  terminalHasText: boolean;
  /**
   * A terminal source can be notified of a request, so Take over from, which goes to the source
   * itself, can reach it. Unknown counts as notifiable.
   */
  terminalNotifiable?: boolean;
}

export type SendTarget =
  | { kind: "agent"; row: AgentRow; address: string }
  | { kind: "new-panel"; selection: DefaultAgentSelection };

export interface SendTargetEntry {
  key: string;
  target: SendTarget;
  title: string;
  providerLabel: string | null;
  busy: boolean;
  disabledReason: string | null;
  /** Out of context or usage; the agent stays pickable. */
  hint: OutOfTokensHint | null;
}

export interface NewPanelProvider {
  value: string;
  selection: DefaultAgentSelection;
  label: string;
  disabledReason: string | null;
}

export function agentAddress(row: Pick<AgentRow, "ref" | "terminalId">): string {
  return row.terminalId === null
    ? `thread:${row.ref.threadId}`
    : `terminal:${row.ref.threadId}/${row.terminalId}`;
}

export function parseAgentAddress(
  address: string,
): { threadId: ThreadId; terminalId: string | null } | null {
  const thread = /^thread:([^\s/]+)$/.exec(address);
  if (thread?.[1] !== undefined) return { threadId: ThreadId.make(thread[1]), terminalId: null };
  const terminal = /^terminal:([^\s/]+)\/([^\s/]+)$/.exec(address);
  if (terminal?.[1] !== undefined && terminal[2] !== undefined) {
    return { threadId: ThreadId.make(terminal[1]), terminalId: terminal[2] };
  }
  return null;
}

/** A user message with no `actor`. An agent's envelope has an actor and is not the person's. */
export function isPersonMessage(message: Pick<OrchestrationMessage, "role" | "actor">): boolean {
  return message.role === "user" && message.actor === undefined;
}

export function hasFinishedAnswer(
  messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "text" | "streaming">>,
): boolean {
  return messages.some(
    (message) => message.role === "assistant" && !message.streaming && message.text.trim() !== "",
  );
}

export function checkoutOf(
  row: AgentRow,
  projectRootByProjectId: ReadonlyMap<string, string>,
): string {
  return row.shell.worktreePath ?? projectRootByProjectId.get(row.shell.projectId) ?? "";
}

/** The control's accessible name, naming the answers that wait for the person. */
export function sendToAgentControlLabel(waitingAnswers: number): string {
  if (waitingAnswers <= 0) return "Send to agent";
  return `Send to agent, ${waitingAnswers} ${waitingAnswers === 1 ? "answer" : "answers"} waiting`;
}

/** The providers whose readiness BiBCode observes, as the server's `canReceive` names them. */
const OBSERVED_TERMINAL_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "opencode",
]);

/** Whether BiBCode can tell this AI Terminal about a request: the server's `canReceive` rule. */
export function canNotifyTerminalRow(summary: TerminalSummary | undefined): boolean {
  return (
    summary !== undefined &&
    summary.status === "running" &&
    summary.agentStatus !== undefined &&
    summary.agentStatus.state !== "unavailable" &&
    OBSERVED_TERMINAL_DRIVERS.has(summary.command?.activity?.driverKind ?? "")
  );
}

export function resolveActionAvailability(input: {
  source: SendToAgentSource;
  action: SendRequestAction;
  serverSupported: boolean;
}): { disabledReason: string | null } {
  const { source, action } = input;
  if (!input.serverSupported) return { disabledReason: SEND_TO_AGENT_SERVER_UPDATE_REASON };
  if (action === "take-over" && source.terminalId !== null && source.terminalNotifiable === false) {
    return { disabledReason: TERMINAL_NOT_NOTIFIABLE_REASON };
  }
  if (action === "second-opinion" || action === "hand-off") {
    if (source.terminalId !== null && !source.terminalHasText) {
      return { disabledReason: NOTHING_TO_ATTACH_REASON };
    }
    if (action === "second-opinion" && source.terminalId === null) {
      if (!hasFinishedAnswer(source.messages)) return { disabledReason: NO_ANSWER_REASON };
    }
  }
  return { disabledReason: null };
}

function hasNoMessages(row: AgentRow): boolean {
  return (
    row.terminalId === null &&
    row.shell.latestUserMessageAt === null &&
    row.shell.latestTurn === null
  );
}

export function buildSendTargets(input: {
  source: SendToAgentSource;
  action: SendRequestAction;
  rows: ReadonlyArray<AgentRow>;
  projectRootByProjectId: ReadonlyMap<string, string>;
  newPanelProviders: ReadonlyArray<NewPanelProvider>;
  canNotifyTerminal: (row: AgentRow) => boolean;
  hintFor?: (row: AgentRow) => OutOfTokensHint | null;
}): ReadonlyArray<SendTargetEntry> {
  const { source, action, hintFor } = input;
  const candidates = input.rows
    .filter(
      (row) =>
        row.ref.environmentId === source.environmentId &&
        row.shell.projectId === source.projectId &&
        !(row.ref.threadId === source.threadId && row.terminalId === source.terminalId),
    )
    .toSorted((a, b) => Date.parse(b.shell.updatedAt) - Date.parse(a.shell.updatedAt));
  const entries: SendTargetEntry[] = candidates.map((row) => {
    let disabledReason: string | null = null;
    if (action === "take-over" && hasNoMessages(row)) {
      disabledReason = NOTHING_TO_TAKE_OVER_REASON;
    } else if (action !== "take-over" && row.terminalId !== null && !input.canNotifyTerminal(row)) {
      disabledReason = TERMINAL_NOT_NOTIFIABLE_REASON;
    } else if (
      action === "review" &&
      checkoutOf(row, input.projectRootByProjectId) !== source.checkout
    ) {
      disabledReason = OTHER_CHECKOUT_REASON;
    }
    return {
      key: row.key,
      target: { kind: "agent", row, address: agentAddress(row) },
      title: row.shell.title,
      providerLabel: row.providerLabel,
      busy: row.group === "working",
      disabledReason,
      hint: hintFor?.(row) ?? null,
    };
  });
  if (action === "take-over") {
    // An agent that ran out is the likely one to take over from (R117); the sort is stable,
    // so each group keeps its recency order.
    return entries.toSorted((a, b) => Number(b.hint !== null) - Number(a.hint !== null));
  }
  for (const provider of input.newPanelProviders) {
    entries.push({
      key: `new-panel:${provider.value}`,
      target: { kind: "new-panel", selection: provider.selection },
      title: provider.label,
      providerLabel: null,
      busy: false,
      disabledReason: provider.disabledReason,
      hint: null,
    });
  }
  return entries;
}

/** Unicode scalar values, as the server counts them. */
export function countCharacters(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function canSend(input: {
  action: SendRequestAction;
  note: string;
  attachments: ReadonlyArray<{ text: string }>;
  sending: boolean;
}): { allowed: boolean; reason: string | null } {
  if (input.sending) return { allowed: false, reason: null };
  if (input.action === "message" && input.note.trim() === "") {
    return { allowed: false, reason: EMPTY_MESSAGE_REASON };
  }
  let total = countCharacters(input.note);
  for (const attachment of input.attachments) total += countCharacters(attachment.text);
  if (total > SEND_REQUEST_MAX_CHARS) return { allowed: false, reason: OVER_LIMIT_REASON };
  return { allowed: true, reason: null };
}

export interface PreviewAttachment {
  id: string;
  label: string;
  text: string;
  leftOut: string | null;
  /** Says where the text came from when that is not what the label promises. */
  note?: string | null;
}

export interface PreviewDraft {
  leadIn: string;
  note: string;
  attachments: ReadonlyArray<{ label: string; text: string }>;
}

export interface SendChoice {
  source: SendToAgentSource;
  action: SendRequestAction;
  target: SendTarget;
}

/** What the preview shows for a choice; a `submit` replaces the default send. */
export interface PreviewContent {
  leadIn: string;
  attachments: ReadonlyArray<PreviewAttachment>;
  extraContent?: ReactNode;
  warning?: string | null;
  /**
   * `isCurrent` says whether the preview that sent still owns the screen. A send finishing for a
   * preview that was closed or replaced must not activate a tab: that can unmount a newer one.
   */
  submit?: (draft: PreviewDraft, isCurrent?: () => boolean) => Promise<SendOutcome>;
  /** Attachments read when the preview opens, after `attachments`; Send waits for them. */
  loadAttachments?: () => Promise<ReadonlyArray<PreviewAttachment>>;
  /** The error shown when `loadAttachments` fails; the preview's own wording otherwise. */
  loadFailedMessage?: string;
}

export function sourceAddressOf(
  source: Pick<SendToAgentSource, "threadId" | "terminalId">,
): string {
  return source.terminalId === null
    ? `thread:${source.threadId}`
    : `terminal:${source.threadId}/${source.terminalId}`;
}

/**
 * The addresses of a send. Take over from is queued on the source's own agent and names the
 * picked agent as taken over; every other action goes to the picked agent or the new panel.
 */
export function resolveRequestRoles(
  choice: SendChoice,
  newPanelAddress: string | null,
): { source: string; target: string; takenOver: string | null } {
  const source = sourceAddressOf(choice.source);
  const picked = choice.target.kind === "agent" ? choice.target.address : newPanelAddress;
  if (picked === null) throw new Error("A send to a new panel needs the panel's address.");
  return choice.action === "take-over"
    ? { source, target: source, takenOver: picked }
    : { source, target: picked, takenOver: null };
}

/** The store key of one panel's send of one action: its note, request id and new panel. */
export function sendChoiceKey(choice: Pick<SendChoice, "source" | "action">): string {
  return `${sendSourceKey(choice.source)}:${choice.action}`;
}

/**
 * Sends a previewed choice. The request id is reused while the draft and the target are
 * unchanged, so pressing Send again after a lost connection sends the same request, and a new
 * panel is created once. A sent request settles the choice and reveals the panel it created.
 */
export async function submitSendChoice(
  deps: {
    send: (input: SendRequestsSendInput) => Promise<SendOutcome>;
    createPanel: (selection: DefaultAgentSelection) => Promise<ThreadId | null>;
    newId: () => string;
    /** Brings a new panel forward once its request was sent; it was created inactive. */
    revealPanel?: (panel: ThreadId) => void;
  },
  choice: SendChoice,
  draft: PreviewDraft,
  isCurrent: () => boolean = () => true,
): Promise<SendOutcome> {
  const store = useSendToAgentStore.getState();
  const key = sendChoiceKey(choice);
  const { target: chosen } = choice;
  const panelKey =
    chosen.kind === "new-panel"
      ? `${key}#${chosen.selection.kind}:${chosen.selection.instanceId}`
      : null;
  const requestId = store.requestIdFor(
    key,
    JSON.stringify([chosen.kind === "agent" ? chosen.address : panelKey, draft]),
    deps.newId,
  );
  let panel: ThreadId | null = null;
  if (chosen.kind === "new-panel") {
    panel = store.panelFor(panelKey ?? "");
    if (panel === null) {
      panel = await deps.createPanel(chosen.selection);
      if (panel === null) {
        return { kind: "failed", reason: "invalid", message: "The panel could not be created." };
      }
      store.rememberPanel(panelKey ?? "", panel);
    }
  }
  const roles = resolveRequestRoles(choice, panel === null ? null : `thread:${panel}`);
  const outcome = await deps.send({
    requestId,
    action: choice.action,
    source: roles.source,
    target: roles.target,
    ...(roles.takenOver === null ? {} : { takenOver: roles.takenOver }),
    leadIn: draft.leadIn,
    note: draft.note,
    attachments: draft.attachments,
  });
  if (outcome.kind === "sent") {
    useSendToAgentStore.getState().settle(key, { requestId, note: draft.note, panelKey });
    if (panel !== null && isCurrent()) deps.revealPanel?.(panel);
  }
  return outcome;
}

const GENERIC_FAILURE = "BiBCode could not send this. Try again.";

/** Client-made failure of a Review to a new panel; the only message shown from an outcome as is. */
export const REVIEW_PANEL_NOT_OPENED_MESSAGE =
  "BiBCode could not open the review panel. Try again.";
export const REVIEW_NO_CHANGES_MESSAGE = "No changes to review. Make a change, then try again.";

export function describeSendFailure(outcome: Extract<SendOutcome, { kind: "failed" }>): {
  message: string;
  next: "retry" | "pick-another" | "trim" | "none";
} {
  if (
    outcome.message === REVIEW_PANEL_NOT_OPENED_MESSAGE ||
    outcome.message === REVIEW_NO_CHANGES_MESSAGE
  ) {
    return { message: outcome.message, next: "retry" };
  }
  switch (outcome.reason) {
    case "too_long":
      return { message: OVER_LIMIT_REASON, next: "trim" };
    case "unknown_thread":
      return { message: "This agent no longer exists. Pick another agent.", next: "pick-another" };
    case "other_project":
      return {
        message: "This agent belongs to another project. Pick an agent from this project.",
        next: "pick-another",
      };
    case "target_not_notifiable":
      return {
        message: "This terminal cannot be notified of new requests. Pick another agent.",
        next: "pick-another",
      };
    case "unknown_outcome":
      return {
        message:
          "BiBCode could not confirm the send. Press Send again; the agent receives it once.",
        next: "retry",
      };
    default:
      return { message: GENERIC_FAILURE, next: "retry" };
  }
}
