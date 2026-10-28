/**
 * Pure helpers for `CreateWorktreeDialog`. Kept side-effect free so the
 * Name and Smart/GitHub/Branch resolution rules can be unit tested
 * without rendering React or touching the network.
 */

import type { DefaultAgentSelection } from "@bibcode/contracts";

import {
  resolveEffectiveProviderAgentAction,
  type ProviderAgentAction,
} from "./chat/providerAgentActions";

export type WorktreeSourceMode = "smart" | "github" | "branch";

export interface GitHubWorkItemRef {
  readonly number: number;
  /** "unknown" when the input was a bare number/#-number with no URL to disambiguate. */
  readonly kind: "issue" | "pr" | "unknown";
}

const GITHUB_URL_RE = /github\.com\/[^/\s]+\/[^/\s]+\/(issues|pull)\/(\d+)/i;
const BARE_NUMBER_RE = /^#?(\d+)$/;

/**
 * Parses `#123`, `123`, or a `github.com/<owner>/<repo>/(issues|pull)/<n>`
 * URL into a work-item reference. Returns `null` for anything else.
 */
export function parseGitHubWorkItem(input: string): GitHubWorkItemRef | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const urlMatch = GITHUB_URL_RE.exec(trimmed);
  if (urlMatch) {
    const kindSegment = urlMatch[1];
    const numberText = urlMatch[2];
    const number = numberText ? Number.parseInt(numberText, 10) : Number.NaN;
    if (!Number.isFinite(number) || number <= 0) return null;
    return { number, kind: kindSegment === "pull" ? "pr" : "issue" };
  }

  const bareMatch = BARE_NUMBER_RE.exec(trimmed);
  if (bareMatch) {
    const numberText = bareMatch[1];
    const number = numberText ? Number.parseInt(numberText, 10) : Number.NaN;
    if (!Number.isFinite(number) || number <= 0) return null;
    return { number, kind: "unknown" };
  }

  return null;
}

/** Server-side PR checkout wiring lands later (see plan pinned item 6 note); for now this only seeds the branch name. */
export function githubWorkItemBranchName(item: GitHubWorkItemRef): string {
  return `pr-${item.number}`;
}

/** Sanitizes free text into a git-ref-safe branch/worktree name. */
export function sanitizeBranchName(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-./]+|[-./]+$/g, "");
}

export interface RefLike {
  readonly name: string;
  readonly isRemote?: boolean | undefined;
  readonly remoteName?: string | undefined;
  readonly current?: boolean | undefined;
  readonly worktreePath?: string | null | undefined;
}

/** Orca parity: only a free local branch can be checked out as-is. */
export function canReuseBranch(ref: RefLike | null): boolean {
  return ref !== null && ref.isRemote !== true && ref.current !== true && ref.worktreePath == null;
}

/**
 * Explains why the Reuse branch control is enabled or disabled for the selected ref.
 * `newBranchName` is the branch Name would create; an occupied branch names it when it is
 * not the occupied branch itself, which the server suffixes instead.
 */
export function reuseBranchHint(ref: RefLike, newBranchName?: string | null): string {
  if (canReuseBranch(ref)) {
    return "Check out the existing branch instead of creating a new one from it.";
  }
  if (ref.isRemote === true) {
    return `"${ref.name}" is a remote branch. A local branch will be created from it.`;
  }
  const created = newBranchName && newBranchName !== ref.name ? newBranchName : `${ref.name}-2`;
  return `"${ref.name}" is already checked out. A new branch ("${created}" or the next available name) will be created from it.`;
}

function isOccupiedLocalBranch(ref: RefLike): boolean {
  return ref.isRemote !== true && (ref.current === true || ref.worktreePath != null);
}

/** Client-side substring filter for the Branch tab result list. */
export function filterRefsByQuery<T extends RefLike>(refs: ReadonlyArray<T>, query: string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return [...refs];
  return refs.filter((ref) => ref.name.toLowerCase().includes(trimmed));
}

/** Mirrors Git's occupied-branch naming without treating remote refs as local collisions. */
export function suggestNextAvailableBranchName(name: string, refs: ReadonlyArray<RefLike>): string {
  const localNames = new Set(refs.filter((ref) => ref.isRemote !== true).map((ref) => ref.name));
  let suffix = 2;
  while (localNames.has(`${name}-${suffix}`)) suffix += 1;
  return `${name}-${suffix}`;
}

export function suggestWorktreeNameFromRef(ref: RefLike): string {
  if (ref.isRemote !== true) return ref.name;
  if (ref.remoteName && ref.name.startsWith(`${ref.remoteName}/`)) {
    return ref.name.slice(ref.remoteName.length + 1);
  }
  const separator = ref.name.indexOf("/");
  return separator === -1 ? ref.name : ref.name.slice(separator + 1);
}

/** True when `query` exactly matches a known ref name (case-sensitive, git refs are). */
export function findExactRefMatch<T extends RefLike>(
  refs: ReadonlyArray<T>,
  query: string,
): T | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  return refs.find((ref) => ref.name === trimmed) ?? null;
}

export type SmartRow =
  | { readonly kind: "branch"; readonly refName: string }
  | { readonly kind: "github"; readonly item: GitHubWorkItemRef };

const SMART_MAX_BRANCH_ROWS = 5;

/**
 * Builds the Smart-tab row list: a GitHub work item when detected, followed
 * by matching branch rows. Worktree naming is handled by the separate field.
 */
export function buildSmartRows(input: {
  readonly query: string;
  readonly refs: ReadonlyArray<RefLike>;
  readonly maxBranchRows?: number;
}): SmartRow[] {
  const trimmed = input.query.trim();
  if (trimmed.length === 0) return [];

  const rows: SmartRow[] = [];
  const githubItem = parseGitHubWorkItem(trimmed);
  if (githubItem) {
    rows.push({ kind: "github", item: githubItem });
  }

  const maxBranchRows = input.maxBranchRows ?? SMART_MAX_BRANCH_ROWS;
  const matches = filterRefsByQuery(input.refs, trimmed).slice(0, maxBranchRows);
  for (const match of matches) {
    rows.push({ kind: "branch", refName: match.name });
  }

  return rows;
}

/**
 * Auto-detects the effective mode for Smart-tab input: text that exactly
 * names a ref is that branch (a picked row fills the field with its name, and
 * a branch may be named `2026`), then a GitHub pattern wins, then a ref
 * prefix match resolves to "branch", otherwise it's treated as a plain name.
 */
export function detectSmartMode(
  query: string,
  refs: ReadonlyArray<RefLike>,
): "github" | "branch" | "search" {
  const trimmed = query.trim();
  if (trimmed.length === 0) return "search";
  if (findExactRefMatch(refs, trimmed)) return "branch";
  if (parseGitHubWorkItem(trimmed)) return "github";
  const lower = trimmed.toLowerCase();
  const hasPrefixMatch = refs.some((ref) => ref.name.toLowerCase().startsWith(lower));
  return hasPrefixMatch ? "branch" : "search";
}

export type WorktreeCreateResolution =
  | {
      readonly kind: "existing-ref";
      readonly title: string;
      readonly branchName: string;
      readonly refName: string;
      readonly newRefName: null;
      readonly baseRefName: null;
    }
  | {
      readonly kind: "new-branch";
      readonly title: string;
      readonly branchName: string;
      readonly refName: string;
      readonly newRefName: string;
      readonly baseRefName: string;
    };

/**
 * Resolves the final worktree creation intent from the current tab/selection
 * state. Returns `null` when nothing resolvable yet (submit should stay
 * disabled).
 */
export function resolveWorktreeCreateInput(input: {
  readonly mode: WorktreeSourceMode;
  readonly nameText: string;
  readonly sourceText?: string;
  readonly selectedBranchRefName: string | null;
  readonly selectedBranchRef?: RefLike | null;
  readonly reuseSelectedBranch?: boolean;
  readonly githubItem: GitHubWorkItemRef | null;
  readonly advancedBaseBranchOverride: string | null;
  readonly defaultBaseBranch: string | null;
}): WorktreeCreateResolution | null {
  const title = input.nameText.trim();
  if (title.length === 0) return null;
  const namedBranch = sanitizeBranchName(title);
  const existingRef = (refName: string): WorktreeCreateResolution => ({
    kind: "existing-ref",
    title,
    branchName: refName,
    refName,
    newRefName: null,
    baseRefName: null,
  });
  const newBranch = (
    branchName: string,
    selectedBaseRefName?: string,
  ): WorktreeCreateResolution => {
    const baseRefName =
      selectedBaseRefName ??
      (input.advancedBaseBranchOverride?.trim() || null) ??
      input.defaultBaseBranch ??
      "HEAD";
    return {
      kind: "new-branch",
      title,
      branchName,
      refName: baseRefName,
      newRefName: branchName,
      baseRefName,
    };
  };
  const selectedBranch = (): WorktreeCreateResolution | null => {
    if (!input.selectedBranchRefName) return null;
    if (input.selectedBranchRef === null) return null;
    // An occupied branch can't be checked out again: a Name of its own becomes the new
    // branch. Its own name is left to the server, which picks the next free suffix.
    if (
      input.selectedBranchRef &&
      isOccupiedLocalBranch(input.selectedBranchRef) &&
      namedBranch.length > 0 &&
      namedBranch !== input.selectedBranchRefName
    ) {
      return newBranch(namedBranch, input.selectedBranchRefName);
    }
    if (
      input.selectedBranchRef &&
      !isOccupiedLocalBranch(input.selectedBranchRef) &&
      !(canReuseBranch(input.selectedBranchRef) && input.reuseSelectedBranch === true)
    ) {
      return namedBranch.length > 0 ? newBranch(namedBranch, input.selectedBranchRefName) : null;
    }
    return existingRef(input.selectedBranchRefName);
  };

  if (input.mode === "branch") {
    if (input.selectedBranchRefName) return selectedBranch();
    if (input.sourceText?.trim()) return null;
  }

  if (input.mode === "github") {
    if (input.githubItem) {
      return namedBranch.length > 0 ? newBranch(namedBranch) : null;
    }
    if (input.sourceText?.trim()) return null;
  }

  if (input.mode === "smart") {
    // A selected branch the field names exactly is that branch, even when its name is a
    // number that also reads as a GitHub item.
    if (input.selectedBranchRefName && input.sourceText?.trim() === input.selectedBranchRefName) {
      return selectedBranch();
    }
    if (input.githubItem) {
      return namedBranch.length > 0 ? newBranch(namedBranch) : null;
    }
    if (input.selectedBranchRefName) return selectedBranch();
    if (input.sourceText?.trim()) return null;
  }

  // No selected source: create from the configured default.
  return namedBranch.length > 0 ? newBranch(namedBranch) : null;
}

/** Gate for the primary "Create worktree" button. */
export function getCreateWorktreeDisabled(input: {
  readonly hasProject: boolean;
  /** False while the project's server has no agent to start, which the agent notice explains. */
  readonly hasAgent: boolean;
  readonly resolution: WorktreeCreateResolution | null;
  readonly isSubmitting: boolean;
}): boolean {
  return !input.hasProject || !input.hasAgent || input.resolution === null || input.isSubmitting;
}

/** The project's server connection, as far as starting an agent there is concerned. */
export type AgentServerConnection = "connected" | "connecting" | "disconnected";

/**
 * The agent the dialog starts on: Settings' Default Agent (the primary-server setting) applied
 * to the agents of the project's own environment. Create waits while there is no agent to start,
 * and a fallback from the saved default says why.
 */
export type DefaultAgentChoice =
  | {
      readonly status: "disconnected" | "connecting" | "loading" | "unavailable";
      readonly action: null;
      readonly notice: string;
    }
  | {
      readonly status: "ready";
      readonly action: ProviderAgentAction;
      readonly notice: string | null;
    };

export function resolveDefaultAgentChoice(input: {
  /** The environment's agents; `null` while its server config has not arrived. */
  readonly actions: ReadonlyArray<ProviderAgentAction> | null;
  readonly selection: DefaultAgentSelection;
  readonly environmentLabel: string | null;
  /** A config snapshot outlives a lost session, so the connection decides first. */
  readonly connection: AgentServerConnection;
  /** Settings → Providers manages the primary server's agents only. */
  readonly isPrimaryServer: boolean;
}): DefaultAgentChoice {
  const { actions, selection } = input;
  const environmentLabel = input.environmentLabel ?? "this server";
  if (input.connection === "disconnected") {
    return {
      status: "disconnected",
      action: null,
      notice: `${environmentLabel} is not connected. Create waits until it reconnects.`,
    };
  }
  if (input.connection === "connecting") {
    return {
      status: "connecting",
      action: null,
      notice: `Connecting to ${environmentLabel}. Create waits until it connects.`,
    };
  }
  if (actions === null) {
    return {
      status: "loading",
      action: null,
      notice: "Loading this project's agents. Create waits until they arrive.",
    };
  }
  const action = resolveEffectiveProviderAgentAction(actions, selection);
  if (action === null) {
    const where = input.isPrimaryServer ? "in Settings → Providers" : "on that server";
    return {
      status: "unavailable",
      action: null,
      notice: `No agent is ready on ${environmentLabel}. Sign in to or enable one ${where}.`,
    };
  }
  if (action.kind === selection.kind && action.entry.instanceId === selection.instanceId) {
    return { status: "ready", action, notice: null };
  }
  const saved = actions.find(
    (candidate) =>
      candidate.kind === selection.kind && candidate.entry.instanceId === selection.instanceId,
  );
  const reason = saved?.disabledReason ? ` (${saved.disabledReason})` : "";
  const notice = saved
    ? `${saved.label} is unavailable${reason}, so ${action.label} is selected.`
    : `Your default agent is not available on ${environmentLabel}, so ${action.label} is selected.`;
  return { status: "ready", action, notice };
}
