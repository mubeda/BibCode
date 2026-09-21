import type { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useEffectEvent, useState } from "react";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../../state/query";

/**
 * The wire key is a checkout path; origin and account can change at that path.
 * On an explicit view/picker open, refresh a cached value before displaying it.
 * A query already revalidating on mount owns that read, so it is not restarted.
 */
export function usePullRequestsQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A, E> {
  const query = useEnvironmentQuery(atom);
  const [opened, setOpened] = useState(() => ({
    atom,
    data: query.data,
    pending: query.isPending,
  }));
  if (opened.atom !== atom) setOpened({ atom, data: query.data, pending: query.isPending });
  const refresh = useEffectEvent(() => query.refresh());
  useEffect(() => {
    if (opened.atom !== null && opened.data !== null && !opened.pending) refresh();
  }, [opened]);
  const stale = opened.atom === atom && opened.data !== null && query.data === opened.data;
  return stale
    ? { ...query, data: null, isPending: query.isPending || query.error === null }
    : query;
}
