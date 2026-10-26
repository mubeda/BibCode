import {
  type CheckpointDiffState,
  type CheckpointDiffTarget,
} from "@bibcode/client-runtime/state/threads";

import { useCheckpointDiff as useCheckpointDiffQuery } from "../state/queries";

/** A checkpoint diff, with the explicit Retry its error offers. */
export interface CheckpointDiffView extends CheckpointDiffState {
  readonly refresh: () => void;
}

export function useCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
): CheckpointDiffView {
  const state = useCheckpointDiffQuery(target, options);
  return {
    data: state.data,
    error: state.error,
    isPending: state.isPending,
    refresh: state.refresh,
  };
}
