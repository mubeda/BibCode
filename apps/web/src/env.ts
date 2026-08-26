export const isTauri =
  import.meta.env.VITE_BIBCODE_SERVER_ASSETS !== "1" &&
  typeof window !== "undefined" &&
  (window.__TAURI__ !== undefined || window.__TAURI_INTERNALS__ !== undefined);

export const isDesktopHost =
  typeof window !== "undefined" && (isTauri || window.desktopBridge !== undefined);
