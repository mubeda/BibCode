import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { useEffect, useEffectEvent, useState } from "react";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../../state/query";

export interface PullRequestsQueryOptions {
  /**
   * The value was read during this open (for example, the panel loaded the list's
   * first page alongside the context), so the first open shows it as is. Later opens
   * of another atom refresh as usual.
   */
  readonly freshOnOpen?: boolean;
}

/**
 * The wire key is a checkout path; origin and account can change at that path.
 * On an explicit view/picker open, refresh a cached value or failure before
 * displaying it. A query already revalidating on mount owns that read, so it is
 * not restarted.
 */
export function usePullRequestsQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
  options?: PullRequestsQueryOptions,
): EnvironmentQueryView<A, E> {
  const query = useEnvironmentQuery(atom);
  const [opened, setOpened] = useState(() =>
    openedView(atom, query, options?.freshOnOpen === true),
  );
  if (opened.atom !== atom) setOpened(openedView(atom, query, false));
  const refresh = useEffectEvent(() => query.refresh());
  useEffect(() => {
    if (opened.shouldRefresh) refresh();
  }, [opened]);
  if (opened.atom !== atom) return query;
  // Until the open's read answers, the cached failure or value it replaces stays hidden.
  const cause = query.emission._tag === "Failure" ? query.emission.cause : null;
  if (opened.cause !== null && cause === opened.cause)
    return {
      ...query,
      data: null,
      error: null,
      emission: AsyncResult.initial<A, E>(true),
      isPending: true,
    };
  return opened.data !== null && query.data === opened.data
    ? { ...query, data: null, isPending: query.isPending || query.error === null }
    : query;
}

/** What an open must hide until re-read, including an already revalidating value or failure. */
function openedView<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
  query: EnvironmentQueryView<A, E>,
  fresh: boolean,
) {
  const cached = atom !== null && !fresh;
  const data = cached ? query.data : null;
  const cause = cached && query.emission._tag === "Failure" ? query.emission.cause : null;
  return {
    atom,
    data,
    cause,
    shouldRefresh: !query.isPending && (data !== null || cause !== null),
  };
}
