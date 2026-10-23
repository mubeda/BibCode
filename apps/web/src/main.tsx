import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";
import { runClientStateMigrationsV1 } from "./clientStateMigrations";
import { installDesktopCloseShortcutRouter } from "./desktopCloseShortcut";
import { isTauri } from "./env";
// Installs the app's single theme listeners at boot, so every route follows the OS.
import { applyStoredTheme } from "./hooks/useTheme";
import { resolveStorage } from "./lib/storage";
import { applyLinuxWebkitTypography } from "./linuxWebkitTypography";

/**
 * Imports the WDIO frontend plugin for packaged UI runs, set up for the reload experiment the
 * desktop host names (`apps/desktop/e2e/support/reload-variant.ts`): C and D turn its console
 * forwarding off, and D's page reload skips it in the next document.
 */
async function loadDesktopE2ePlugin(): Promise<void> {
  const host = window as Window & {
    readonly __BIBCODE_E2E_RELOAD_VARIANT__?: string;
    readonly __TAURI__?: Record<string, unknown>;
  };
  const variant = host.__BIBCODE_E2E_RELOAD_VARIANT__ ?? "A";
  const skipKey = "bibcode:e2e:skip-wdio-plugin";
  const skip = window.sessionStorage.getItem(skipKey) === "1";
  window.sessionStorage.removeItem(skipKey);
  if (variant === "D" && skip) return;
  if ((variant === "C" || variant === "D") && host.__TAURI__ !== undefined) {
    // The plugin forwards each console call to `__TAURI__.log` when it exists, instead of
    // invoking the host; a silent one keeps console calls off IPC.
    const silent = async () => undefined;
    Object.defineProperty(host.__TAURI__, "log", {
      configurable: true,
      value: { trace: silent, debug: silent, info: silent, warn: silent, error: silent },
    });
  }
  await import("@wdio/tauri-plugin");
}

async function main(): Promise<void> {
  try {
    runClientStateMigrationsV1(
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    );
  } catch {
    // Ignore unavailable/storage errors so startup can continue.
  }
  if (import.meta.env.VITE_BIBCODE_DESKTOP_E2E === "1") {
    await loadDesktopE2ePlugin();
  }
  if (isTauri) {
    await installDesktopCloseShortcutRouter().catch(() => undefined);
  }
  const [{ renderApplication }, { tauriDesktopBridgeReady }] = await Promise.all([
    import("./bootstrap"),
    import("./tauriDesktopBridge"),
  ]);
  await tauriDesktopBridgeReady.catch(() => undefined);
  // The theme module loaded before the desktop bridge existed; sync the shell now.
  applyStoredTheme();
  applyLinuxWebkitTypography(document);
  await renderApplication();
}

void main();
