/** `incoming` replaces `current` only when `current` is unset or strictly older. */
export function newerObservedAt(current: number | null, incoming: number): boolean {
  return current === null || incoming > current;
}

export interface SnapshotCopy<P> {
  readonly payload: P;
  readonly observedAt: number;
}

/** The copy a view shows for one key, and the live page and snapshot row it last took. */
export interface ShownCopy<P> extends SnapshotCopy<P> {
  readonly key: string;
  readonly live: P | null;
  readonly snapshot: SnapshotCopy<P> | null;
}

/** The snapshot read for a key: whether it has answered, and the row it answered with. */
export interface SnapshotSource<P> {
  readonly answered: boolean;
  readonly row: SnapshotCopy<P> | null;
}

/**
 * Picks the copy to show for `key`, dropping a copy kept for another key. A new
 * live page always replaces it, and a snapshot row replaces it only when its
 * `observedAt` is strictly newer. A live page is stamped on the server clock with
 * the newest snapshot `observedAt` seen when it answered, so only a copy stored
 * afterwards replaces it. Before the snapshot read answers, the client clock
 * stands in, so the older stored copy that read returns cannot replace the live page.
 */
export function shownCopy<P>(
  previous: ShownCopy<P> | null,
  key: string,
  live: P | null,
  source: SnapshotSource<P> | null,
  now: () => number = Date.now,
): ShownCopy<P> | null {
  let next = previous?.key === key ? previous : null;
  const snapshot = source?.row ?? null;
  if (live !== null && live !== next?.live) {
    const after = source === null ? 0 : source.answered ? (snapshot?.observedAt ?? 0) : now();
    next = {
      key,
      payload: live,
      observedAt: Math.max(after, next?.observedAt ?? 0),
      live,
      snapshot: next?.snapshot ?? null,
    };
  }
  if (
    snapshot !== null &&
    snapshot !== next?.snapshot &&
    newerObservedAt(next?.observedAt ?? null, snapshot.observedAt)
  ) {
    next = { key, ...snapshot, live: next?.live ?? null, snapshot };
  }
  return next;
}
