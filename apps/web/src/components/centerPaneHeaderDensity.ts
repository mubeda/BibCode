export type CenterPaneHeaderDensity = "expanded" | "compact";

export const EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH = 560;

export function resolveCenterPaneHeaderDensity(width: number): CenterPaneHeaderDensity {
  return Number.isFinite(width) && width >= EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH
    ? "expanded"
    : "compact";
}
