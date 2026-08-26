import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import { desktopBridgeReady } from "./desktopBridgeReady";
import { isDesktopHost } from "./env";
import { installFrontendLogCapture } from "./diagnostics/frontendLogCapture";

export async function renderApplication(): Promise<void> {
  installFrontendLogCapture();
  await desktopBridgeReady;
  const [{ getRouter }, { AppRoot }] = await Promise.all([import("./router"), import("./AppRoot")]);

  // Desktop shells load bundled assets from custom/file origins, so hash history avoids path resolution issues.
  const history = isDesktopHost ? createHashHistory() : createBrowserHistory();
  const router = getRouter(history);
  const app = <AppRoot router={router} />;

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>{app}</React.StrictMode>,
  );
}
