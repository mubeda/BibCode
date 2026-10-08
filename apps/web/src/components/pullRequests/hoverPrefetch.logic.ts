export const HOVER_PREFETCH_MS = 150;
export const MAX_HOVER_PREFETCHES = 2;

export function createPrefetchGate() {
  let inflight = 0;
  return {
    tryAcquire(): boolean {
      if (inflight >= MAX_HOVER_PREFETCHES) return false;
      inflight += 1;
      return true;
    },
    release(): void {
      inflight = Math.max(0, inflight - 1);
    },
  };
}

const gates = new Map<string, ReturnType<typeof createPrefetchGate>>();

export function prefetchGate(environmentId: string) {
  let gate = gates.get(environmentId);
  if (!gate) {
    gate = createPrefetchGate();
    gates.set(environmentId, gate);
  }
  return gate;
}

export function resetPrefetchGates(): void {
  gates.clear();
}
