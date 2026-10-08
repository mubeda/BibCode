/** `incoming` replaces `current` only when `current` is unset or strictly older. */
export function newerObservedAt(current: number | null, incoming: number): boolean {
  return current === null || incoming > current;
}
