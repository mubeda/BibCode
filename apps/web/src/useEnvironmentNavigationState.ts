import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EnvironmentId } from "@bibcode/contracts";

import {
  createEmptyEnvironmentNavigationState,
  environmentNavigationCommands,
  synthesizeSelectedPathExpansion,
  type EnvironmentNavigationProjectCandidate,
  type EnvironmentNavigationSelection,
  type EnvironmentNavigationStateV2,
} from "./environmentNavigationStore";
import { useAtomCommand } from "./state/use-atom-command";

type NavigationStateUpdate = (
  current: EnvironmentNavigationStateV2,
) => EnvironmentNavigationStateV2;

export interface UseEnvironmentNavigationStateInput {
  readonly ready: boolean;
  readonly environmentIds: readonly EnvironmentId[];
  readonly projects: readonly EnvironmentNavigationProjectCandidate[];
  readonly selected: EnvironmentNavigationSelection | null;
}

export interface EnvironmentNavigationStateController {
  readonly state: EnvironmentNavigationStateV2;
  readonly hydrated: boolean;
  readonly update: (update: NavigationStateUpdate) => void;
}

function selectionsEqual(
  left: EnvironmentNavigationSelection | null,
  right: EnvironmentNavigationSelection | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.environmentId === right.environmentId &&
      left.projectId === right.projectId &&
      left.threadId === right.threadId)
  );
}

/**
 * Owns the React-facing lifecycle for the durable v2 navigation document.
 * Pre-hydration interactions are replayed over the loaded document so a slow
 * IndexedDB read cannot discard the user's first disclosure change.
 */
export function useEnvironmentNavigationState(
  input: UseEnvironmentNavigationStateInput,
): EnvironmentNavigationStateController {
  const load = useAtomCommand(environmentNavigationCommands.load, { reportFailure: true });
  const save = useAtomCommand(environmentNavigationCommands.save, { reportFailure: true });
  const fallback = useMemo(
    () =>
      synthesizeSelectedPathExpansion(
        createEmptyEnvironmentNavigationState({
          environmentIds: input.environmentIds,
          selected: input.selected,
        }),
      ),
    [input.environmentIds, input.selected],
  );
  const selectedRef = useRef(input.selected);
  selectedRef.current = input.selected;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const stateRef = useRef<EnvironmentNavigationStateV2 | null>(null);
  const pendingUpdatesRef = useRef<NavigationStateUpdate[]>([]);
  const hydrationStartedRef = useRef(false);
  const hydrationGenerationRef = useRef(0);
  const hydratedRef = useRef(false);
  const [state, setState] = useState<EnvironmentNavigationStateV2 | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const persist = useCallback(
    (next: EnvironmentNavigationStateV2) => {
      void save(next);
    },
    [save],
  );

  const update = useCallback(
    (apply: NavigationStateUpdate) => {
      const next = apply(stateRef.current ?? fallbackRef.current);
      stateRef.current = next;
      setState(next);
      if (hydratedRef.current) {
        persist(next);
      } else {
        pendingUpdatesRef.current.push(apply);
      }
    },
    [persist],
  );

  useEffect(() => {
    if (!input.ready || hydrationStartedRef.current || hydratedRef.current) return;
    hydrationStartedRef.current = true;
    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    const pendingAtStart = pendingUpdatesRef.current;

    void load({
      environmentIds: input.environmentIds,
      projects: input.projects,
      selected: input.selected,
      completedAt: new Date().toISOString(),
    }).then((result) => {
      if (hydrationGenerationRef.current !== generation) return;
      const loaded =
        result._tag === "Success"
          ? result.value
          : createEmptyEnvironmentNavigationState({
              environmentIds: input.environmentIds,
              selected: selectedRef.current,
            });
      let next = pendingAtStart.reduce((current, apply) => apply(current), loaded);
      if (!selectionsEqual(next.selected, selectedRef.current)) {
        next = synthesizeSelectedPathExpansion({ ...next, selected: selectedRef.current });
      }
      pendingUpdatesRef.current = [];
      stateRef.current = next;
      hydratedRef.current = true;
      setState(next);
      setHydrated(true);
      if (result._tag === "Success" && next !== result.value) persist(next);
    });

    return () => {
      if (hydrationGenerationRef.current !== generation || hydratedRef.current) return;
      hydrationGenerationRef.current += 1;
      hydrationStartedRef.current = false;
    };
  }, [input.environmentIds, input.projects, input.ready, input.selected, load, persist]);

  useEffect(() => {
    if (!hydrated || stateRef.current === null) return;
    if (selectionsEqual(stateRef.current.selected, input.selected)) return;
    update((current) =>
      synthesizeSelectedPathExpansion({
        ...current,
        selected: input.selected,
      }),
    );
  }, [hydrated, input.selected, update]);

  return { state: state ?? fallback, hydrated, update };
}
