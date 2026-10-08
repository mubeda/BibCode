export const VISIBLE_REFRESH_MS = 20_000;
export const FRESH_MS = 5_000;

export function visibleRefreshDelay(
  visible: boolean,
  lastSuccessAt: number | null,
  now: number,
): number | null {
  if (!visible || lastSuccessAt === null) return null;
  return Math.max(0, lastSuccessAt + VISIBLE_REFRESH_MS - now);
}

export function shouldRefreshOnShow(lastSuccessAt: number | null, now: number): boolean {
  return lastSuccessAt !== null && now - lastSuccessAt > FRESH_MS;
}
