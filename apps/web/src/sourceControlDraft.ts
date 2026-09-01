import { useCallback, useEffect, useMemo } from "react";

import { selectCwdSourceControlDraft, useSourceControlPanelStore } from "./sourceControlPanelStore";

interface SourceControlDraftScope {
  readonly environmentId: string;
  readonly cwd: string;
  readonly legacyThreadKey?: string;
}

export function sourceControlDraftKey({ environmentId, cwd }: SourceControlDraftScope): string {
  const normalizedCwd = cwd.length > 1 ? cwd.replace(/[\\/]$/, "") : cwd;
  return `${environmentId}::${normalizedCwd}`;
}

export interface SourceControlDraftBinding {
  readonly message: string;
  readonly setMessage: (message: string) => void;
  readonly clear: () => void;
}

export function useSourceControlDraft(scope: SourceControlDraftScope): SourceControlDraftBinding {
  const cwdKey = sourceControlDraftKey(scope);
  const selectMessage = useCallback(
    (state: ReturnType<typeof useSourceControlPanelStore.getState>) =>
      selectCwdSourceControlDraft(state.byCwdKey, cwdKey).message,
    [cwdKey],
  );
  const message = useSourceControlPanelStore(selectMessage);
  const setCwdMessage = useSourceControlPanelStore((state) => state.setCwdMessage);
  const clearCwdDraft = useSourceControlPanelStore((state) => state.clearCwdDraft);
  const promoteThreadDraft = useSourceControlPanelStore((state) => state.promoteThreadDraft);
  const setMessage = useCallback(
    (nextMessage: string) => setCwdMessage(cwdKey, nextMessage),
    [cwdKey, setCwdMessage],
  );
  const clear = useCallback(() => clearCwdDraft(cwdKey), [clearCwdDraft, cwdKey]);
  const legacyThreadKey = scope.legacyThreadKey;
  useEffect(() => {
    if (legacyThreadKey !== undefined) promoteThreadDraft(legacyThreadKey, cwdKey);
  }, [cwdKey, legacyThreadKey, promoteThreadDraft]);

  return useMemo(() => ({ message, setMessage, clear }), [clear, message, setMessage]);
}
