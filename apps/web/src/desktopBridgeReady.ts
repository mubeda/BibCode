import { isTauri } from "./env";

export const desktopBridgeReady: Promise<void> =
  import.meta.env.VITE_BIBCODE_SERVER_ASSETS !== "1" && isTauri
    ? import("./tauriDesktopBridge").then(({ tauriDesktopBridgeReady }) =>
        tauriDesktopBridgeReady.catch(() => undefined),
      )
    : Promise.resolve();
