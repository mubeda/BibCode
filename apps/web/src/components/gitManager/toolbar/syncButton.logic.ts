export type SyncStateKind =
  | "running"
  | "no-remote"
  | "fetch-unborn"
  | "detached"
  | "publish-branch"
  | "fetch"
  | "force-push"
  | "pull"
  | "push";

export interface SyncStateInput {
  readonly isOperationRunning: boolean;
  readonly hasRemote: boolean;
  readonly isUnborn: boolean;
  readonly isDetached: boolean;
  readonly aheadBehind: { readonly ahead: number; readonly behind: number } | null;
  readonly forcePushRecommended: boolean;
  readonly remote?: string;
}

export interface SyncState {
  readonly kind: SyncStateKind;
  readonly label: string;
  readonly ahead: number;
  readonly behind: number;
  readonly disabledReason: string | null;
}

export function resolveSyncState(input: SyncStateInput): SyncState {
  const remote = input.remote ?? "origin";
  const visibleAhead = input.aheadBehind?.ahead ?? 0;
  if (input.isOperationRunning) {
    return {
      kind: "running",
      label: "Syncing…",
      ahead: visibleAhead,
      behind: input.aheadBehind?.behind ?? 0,
      disabledReason: "A Git Manager operation is already running.",
    };
  }
  if (!input.hasRemote) {
    return {
      kind: "no-remote",
      label: "No remote configured",
      ahead: visibleAhead,
      behind: input.aheadBehind?.behind ?? 0,
      disabledReason: "This repository has no configured remote.",
    };
  }
  if (input.isUnborn) {
    return {
      kind: "fetch-unborn",
      label: `Fetch ${remote}`,
      ahead: 0,
      behind: 0,
      disabledReason: null,
    };
  }
  if (input.isDetached) {
    return {
      kind: "detached",
      label: "Detached HEAD",
      ahead: 0,
      behind: 0,
      disabledReason: "Sync is unavailable while HEAD is detached.",
    };
  }
  if (input.aheadBehind === null) {
    return {
      kind: "publish-branch",
      label: `Publish branch to ${remote}`,
      ahead: 0,
      behind: 0,
      disabledReason: null,
    };
  }

  const { ahead: branchAhead, behind } = input.aheadBehind;
  const ahead = branchAhead;
  if (branchAhead === 0 && behind === 0) {
    return {
      kind: "fetch",
      label: `Fetch ${remote}`,
      ahead,
      behind,
      disabledReason: null,
    };
  }
  if (input.forcePushRecommended) {
    return {
      kind: "force-push",
      label: `Force push ${remote}`,
      ahead,
      behind,
      disabledReason: null,
    };
  }
  if (behind > 0) {
    return {
      kind: "pull",
      label: `Pull ${remote}`,
      ahead,
      behind,
      disabledReason: null,
    };
  }

  return {
    kind: "push",
    label: `Push ${remote}`,
    ahead,
    behind,
    disabledReason: null,
  };
}
