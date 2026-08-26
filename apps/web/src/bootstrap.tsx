import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import { isDesktopHost } from "./env";
import { tauriDesktopBridgeReady } from "./tauriDesktopBridge";
import { installFrontendLogCapture } from "./diagnostics/frontendLogCapture";

export async function renderApplication(): Promise<void> {
  installFrontendLogCapture();
  await tauriDesktopBridgeReady.catch(() => undefined);
  const [{ getRouter }, { AppRoot }] = await Promise.all([import("./router"), import("./AppRoot")]);

  // Desktop shells load bundled assets from custom/file origins, so hash history avoids path resolution issues.
  const history = isDesktopHost ? createHashHistory() : createBrowserHistory();
  const router = getRouter(history);
  const app = <AppRoot router={router} />;

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>{app}</React.StrictMode>,
  );
}
