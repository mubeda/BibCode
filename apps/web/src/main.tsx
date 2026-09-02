import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";
import { runClientStateMigrationsV1 } from "./clientStateMigrations";
import { installDesktopCloseShortcutRouter } from "./desktopCloseShortcut";
import { isTauri } from "./env";
import { resolveStorage } from "./lib/storage";
import { applyLinuxWebkitTypography } from "./linuxWebkitTypography";

async function main(): Promise<void> {
  try {
    runClientStateMigrationsV1(
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    );
  } catch {
    // Ignore unavailable/storage errors so startup can continue.
  }
  if (import.meta.env.VITE_BIBCODE_DESKTOP_E2E === "1") {
    await import("@wdio/tauri-plugin");
  }
  if (isTauri) {
    await installDesktopCloseShortcutRouter().catch(() => undefined);
  }
  const [{ renderApplication }, { tauriDesktopBridgeReady }] = await Promise.all([
    import("./bootstrap"),
    import("./tauriDesktopBridge"),
  ]);
  await tauriDesktopBridgeReady.catch(() => undefined);
  applyLinuxWebkitTypography(document);
  await renderApplication();
}

void main();
