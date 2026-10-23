/**
 * Reload experiments for the packaged message-queue spec's mid-turn reload, chosen by
 * `BIBCODE_E2E_RELOAD_VARIANT`. The desktop app hands the same variable to each document, and
 * the web app's E2E entry turns console forwarding off and skips the WDIO frontend plugin to
 * match (`apps/web/src/main.tsx`).
 */
export type DesktopUiReloadMechanism = "webdriver" | "native" | "page";

export interface DesktopUiReloadVariant {
  readonly id: "A" | "B" | "C" | "D" | "E";
  /** WebDriver refresh (`location.reload()` through ExecuteScript), the host's own reload, or
   * a reload the page starts after the WebDriver script has returned. */
  readonly mechanism: DesktopUiReloadMechanism;
  /** Whether the WDIO frontend plugin forwards every console call to the host over IPC. */
  readonly consoleForwarding: boolean;
  /** Whether the reloaded document imports the WDIO frontend plugin again. */
  readonly pluginAfterReload: boolean;
}

/** The session-storage key that tells the next document to skip the WDIO frontend plugin. */
export const SKIP_WDIO_PLUGIN_KEY = "bibcode:e2e:skip-wdio-plugin";

const variants: Readonly<Record<DesktopUiReloadVariant["id"], DesktopUiReloadVariant>> = {
  A: { id: "A", mechanism: "webdriver", consoleForwarding: true, pluginAfterReload: true },
  B: { id: "B", mechanism: "native", consoleForwarding: true, pluginAfterReload: true },
  C: { id: "C", mechanism: "webdriver", consoleForwarding: false, pluginAfterReload: true },
  D: { id: "D", mechanism: "page", consoleForwarding: false, pluginAfterReload: false },
  E: { id: "E", mechanism: "page", consoleForwarding: true, pluginAfterReload: true },
};

export const WEBDRIVER_RELOAD: DesktopUiReloadVariant = variants.A;

export function desktopUiReloadVariant(
  value: string | undefined = process.env.BIBCODE_E2E_RELOAD_VARIANT,
): DesktopUiReloadVariant {
  const id = value?.trim().toUpperCase() || "A";
  const variant = variants[id as DesktopUiReloadVariant["id"]];
  if (variant === undefined) {
    throw new Error(`Unknown BIBCODE_E2E_RELOAD_VARIANT ${JSON.stringify(value)}; use A to E.`);
  }
  return variant;
}
