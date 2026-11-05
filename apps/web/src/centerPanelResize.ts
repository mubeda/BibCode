export const CENTER_PANEL_RESIZE_END_EVENT = "bibcode:center-panel-resize-end";

export function isCenterPanelResizing(element: Element): boolean {
  return element.closest("[data-center-panel-workspace]")?.getAttribute("data-resizing") === "true";
}
