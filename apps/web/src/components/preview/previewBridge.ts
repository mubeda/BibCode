/**
 * Module-level handle to the desktop preview bridge.
 *
 * Resolved once at import time so React hooks don't pay for repeated
 * `window.desktopBridge?.preview` lookups on every render. `null` on the web
 * build where there is no native preview host.
 */
export const previewBridge =
  typeof window === "undefined" ? null : (window.desktopBridge?.preview ?? null);

/**
 * Browser mode: no desktop host, so no `DesktopBridge.openExternal`, no SSH
 * forwards and no internal browser. A desktop host without preview support
 * (`previewBridge` null) is still not browser mode. Read live, not at import.
 */
export function isBrowserMode(): boolean {
  return typeof window === "undefined" || !window.desktopBridge;
}
