import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";
import { runClientStateMigrationsV1 } from "./clientStateMigrations";
import { isTauri } from "./env";
import { resolveStorage } from "./lib/storage";

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
  if (import.meta.env.VITE_BIBCODE_SERVER_ASSETS !== "1" && isTauri) {
    await import("./desktopCloseShortcut")
      .then(({ installDesktopCloseShortcutRouter }) => installDesktopCloseShortcutRouter())
      .catch(() => undefined);
  }
  const { renderApplication } = await import("./bootstrap");
  await renderApplication();
}

void main();
