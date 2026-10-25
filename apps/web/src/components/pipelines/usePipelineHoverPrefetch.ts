import type { EnvironmentId } from "@bibcode/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pipelinesEnvironment } from "../../state/pipelines";
import {
  HOVER_PREFETCH_MS,
  prefetchGate,
  prefetchedWithin,
  recordPrefetch,
} from "../pullRequests/hoverPrefetch.logic";
import { usePullRequestsQuery } from "../pullRequests/shared/usePullRequestsQuery";

/**
 * Reads a pipeline's detail after its row is hovered for `HOVER_PREFETCH_MS`, so the
 * pipeline page usually opens on data already in the atom cache. It shares the merge
 * request rows' gate: at most two prefetches in flight per environment, and none for
 * a pipeline whose detail a prefetch answered within `FRESH_MS`.
 */
export function usePipelineHoverPrefetch({
  environmentId,
  cwd,
  pipelineId,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  pipelineId: number;
}): { onPointerEnter(): void; onPointerLeave(): void } {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);
  const gateRef = useRef<ReturnType<typeof prefetchGate> | null>(null);
  const request = useMemo(
    () => ({
      environmentId,
      input: { cwd, pipelineId, attempt: null, refresh: "user" as const },
    }),
    [cwd, environmentId, pipelineId],
  );
  const detailAtom = useMemo(
    () => (armed ? pipelinesEnvironment.get(request) : null),
    [armed, request],
  );
  const detail = usePullRequestsQuery(detailAtom);
  const settled = !detail.isPending && (detail.data !== null || detail.error !== null);
  const answer = detail.data !== null && detail.error === null && !detail.isPending;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const releaseGate = useCallback(() => {
    gateRef.current?.release();
    gateRef.current = null;
  }, []);

  useEffect(() => {
    if (armed && settled) releaseGate();
  }, [armed, releaseGate, settled]);
  useEffect(() => {
    if (answer) recordPrefetch("pipelines.get", request, Date.now());
  }, [answer, request]);
  useEffect(
    () => () => {
      clearTimer();
      if (armed) releaseGate();
    },
    [armed, clearTimer, releaseGate],
  );

  const onPointerEnter = useCallback(() => {
    if (armed) return;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (prefetchedWithin("pipelines.get", request, Date.now())) return;
      const gate = prefetchGate(environmentId);
      if (!gate.tryAcquire()) return;
      gateRef.current = gate;
      setArmed(true);
    }, HOVER_PREFETCH_MS);
  }, [armed, clearTimer, environmentId, request]);

  const onPointerLeave = useCallback(() => {
    if (armed) return;
    clearTimer();
  }, [armed, clearTimer]);

  return { onPointerEnter, onPointerLeave };
}
