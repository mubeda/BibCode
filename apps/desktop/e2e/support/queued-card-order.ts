export interface DesktopUiQueuedCardObservation {
  readonly id: string;
  readonly text: string;
  readonly y: number;
  readonly displayed: boolean;
}

export function queuedCardIdsInVisualOrder(
  observations: readonly DesktopUiQueuedCardObservation[],
  expectedPrompts: readonly string[],
): string[] | null {
  if (observations.length !== expectedPrompts.length) return null;
  if (
    observations.some((card) => !card.displayed || !card.id || !Number.isFinite(card.y)) ||
    new Set(observations.map((card) => card.id)).size !== observations.length
  ) {
    return null;
  }
  const ordered = [...observations].sort((left, right) => left.y - right.y);
  if (
    ordered.some(
      (card, index) =>
        !card.text.includes(expectedPrompts[index]!) ||
        (index > 0 && card.y <= ordered[index - 1]!.y),
    )
  ) {
    return null;
  }
  return ordered.map((card) => card.id);
}
