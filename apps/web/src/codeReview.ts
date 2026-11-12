import {
  DEFAULT_CODE_REVIEW_PROMPT,
  type DefaultAgentSelection,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@bibcode/contracts";

import type { ProviderAgentAction } from "./components/chat/providerAgentActions";
import { CODE_REVIEW_DRIVERS_WITH_TERMINALS } from "./components/chat/providerTerminalActions";
import type { ProviderInstanceEntry } from "./providerInstances";
import type { CodeReviewScope } from "./components/SourceControlPanel.logic";

export function codeReviewScopeText(scope: CodeReviewScope): string {
  return scope.kind === "branch"
    ? `the commits on the current branch that are not on ${scope.base ?? "HEAD"}, plus all staged, unstaged and untracked changes`
    : "the staged, unstaged and untracked changes in the working tree";
}

/**
 * The fixed lead-in keeps a saved prompt from ever reaching a CLI as its first token and keeps
 * the scope and "do not edit" line in every review (design note, "Prompt lead-in").
 */
export function resolveCodeReviewPrompt(input: {
  readonly project: string;
  readonly user: string;
  readonly scope: CodeReviewScope;
}): string {
  const scopeText = codeReviewScopeText(input.scope);
  const base = input.scope.base ?? "HEAD";
  const lead =
    `Code review requested from BiBCode. Do not edit files. Scope: ${scopeText}.` +
    (input.scope.kind === "branch" ? ` Base: ${base}.` : "");
  const body =
    [input.project, input.user].find((value) => value.trim().length > 0) ??
    DEFAULT_CODE_REVIEW_PROMPT;
  // One pass with a replacer: a ref name may hold `$`, and replaced text is never re-expanded.
  const resolved = body.replace(/\{scope\}|\{base\}/g, (match) =>
    match === "{scope}" ? scopeText : base,
  );
  return `${lead}\n\n${resolved}`;
}

export function resolveCodeReviewChatModes(driver: ProviderDriverKind): {
  readonly runtimeMode: "approval-required";
  readonly interactionMode: "plan" | "default";
} {
  return {
    runtimeMode: "approval-required",
    interactionMode: driver === "claudeAgent" ? "plan" : "default",
  };
}

const INSTRUCTED_GUARD_LINE = "Told not to edit. BiBCode cannot block edits for this agent.";

/** The mechanism each reviewer starts with; never a promise of the outcome (design note table). */
export function codeReviewGuardLine(reviewer: {
  readonly kind: "chat" | "terminal";
  readonly driver: ProviderDriverKind;
}): string {
  if (reviewer.driver === "claudeAgent") return "Starts in Claude's plan mode.";
  if (reviewer.driver === "codex") {
    return reviewer.kind === "terminal"
      ? "Runs in Codex's read-only sandbox."
      : "Runs in Codex's read-only sandbox. Writes ask for your approval.";
  }
  if (reviewer.driver === "opencode" && reviewer.kind === "chat") {
    return "Edits and commands ask for your approval.";
  }
  return INSTRUCTED_GUARD_LINE;
}

export const CODE_REVIEW_SERVER_UPDATE_REASON =
  "Update the BiBCode server on this environment to use Review.";
export const CODE_REVIEW_DRAFT_REASON = "Send a first message in this chat, then review from here.";
export const CODE_REVIEW_UNLISTED_REASON =
  "The code review agent is not available on this environment. Change it in Settings → Agents.";

const unavailableReviewerReason = (label: string) =>
  `${label} is not available. Change the code review agent in Settings → Agents.`;

/**
 * Exact match only: a fallback would silently change the provider and its guard (D48).
 * `knownEntries` are every instance the environment reports, including the disabled ones that
 * `actions` leave out, so a disabled reviewer is named instead of called unlisted.
 */
export function resolveSavedCodeReviewer(
  actions: ReadonlyArray<ProviderAgentAction>,
  selection: DefaultAgentSelection,
  knownEntries: ReadonlyArray<Pick<ProviderInstanceEntry, "instanceId" | "displayName">> = [],
):
  | { readonly action: ProviderAgentAction; readonly reason: null }
  | { readonly action: null; readonly reason: string } {
  const saved = actions.find(
    (action) => action.kind === selection.kind && action.entry.instanceId === selection.instanceId,
  );
  if (saved && !saved.disabled) return { action: saved, reason: null };
  if (saved) return { action: null, reason: unavailableReviewerReason(saved.label) };
  const known = knownEntries.find((entry) => entry.instanceId === selection.instanceId);
  if (known) {
    const label =
      selection.kind === "terminal" ? `${known.displayName} Terminal` : known.displayName;
    return { action: null, reason: unavailableReviewerReason(label) };
  }
  return { action: null, reason: CODE_REVIEW_UNLISTED_REASON };
}

/** The reviewers Settings and the review menu offer: chats, and terminals only for the CLIs whose read-only flags are verified (design note). */
export function codeReviewerActions(
  actions: ReadonlyArray<ProviderAgentAction>,
): ReadonlyArray<ProviderAgentAction> {
  return actions.filter(
    (action) =>
      action.kind === "chat" || CODE_REVIEW_DRIVERS_WITH_TERMINALS.has(action.entry.driverKind),
  );
}

/** A reviewer the Source Control review menu offers for one review (R103). */
export interface CodeReviewMenuReviewer {
  readonly value: string;
  readonly label: string;
  readonly selection: DefaultAgentSelection;
  readonly guardLine: string;
  readonly disabledReason: string | null;
}

export function buildCodeReviewMenuReviewers(
  actions: ReadonlyArray<ProviderAgentAction>,
  reasonFor: (action: ProviderAgentAction) => string | null,
): ReadonlyArray<CodeReviewMenuReviewer> {
  return codeReviewerActions(actions).map((action) => ({
    value: action.value,
    label: action.label,
    selection: action.selection,
    guardLine: codeReviewGuardLine({ kind: action.kind, driver: action.entry.driverKind }),
    disabledReason: reasonFor(action),
  }));
}

/** The stored review model applies only to its own instance (D49). */
export function resolveCodeReviewModelSelection(
  stored: ModelSelection | null,
  instanceId: ProviderInstanceId,
): ModelSelection | null {
  return stored?.instanceId === instanceId ? stored : null;
}
