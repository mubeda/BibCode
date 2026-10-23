// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests observe the native page-load log.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  SKIP_WDIO_PLUGIN_KEY,
  WEBDRIVER_RELOAD,
  type DesktopUiReloadVariant,
} from "./reload-variant.ts";

export function readNativePageLoad(log: string): { phase: string; id: string } | undefined {
  const events = [
    ...log.matchAll(/desktop_e2e_page_load_(started|finished) id=([0-9a-f-]{36})(?=\s|$)/g),
  ];
  const last = events.at(-1);
  return last ? { phase: last[1]!, id: last[2]! } : undefined;
}

interface DesktopUiReloadHost {
  readonly __TAURI__?: {
    readonly core?: { readonly invoke?: (command: string) => Promise<unknown> };
  };
}

/** Starts the reload; the caller waits for the replacement document. */
async function startReload(variant: DesktopUiReloadVariant): Promise<void> {
  switch (variant.mechanism) {
    case "webdriver":
      await browser.refresh();
      return;
    case "native": {
      const error = await browser.executeAsync((done: (error: string | null) => void) => {
        const invoke = (window as unknown as DesktopUiReloadHost).__TAURI__?.core?.invoke;
        if (invoke === undefined) {
          done("The Tauri bridge is unavailable for a native reload.");
          return;
        }
        invoke("desktop_e2e_reload_main_document").then(
          () => done(null),
          (reason: unknown) => done(String(reason)),
        );
      });
      if (error !== null) throw new Error(error);
      return;
    }
    case "page":
      // The script returns before the page reloads, as a reload from the app's own UI does.
      await browser.execute(
        (skipPlugin: boolean, key: string) => {
          if (skipPlugin) window.sessionStorage.setItem(key, "1");
          window.setTimeout(() => window.location.reload(), 50);
        },
        !variant.pluginAfterReload,
        SKIP_WDIO_PLUGIN_KEY,
      );
  }
}

export async function refreshDesktopUiDocument(
  stateRoot = process.env.BIBCODE_HOME,
  variant: DesktopUiReloadVariant = WEBDRIVER_RELOAD,
): Promise<void> {
  if (!stateRoot) throw new Error("The desktop UI fixture state root was not configured.");
  const path = NodePath.join(stateRoot, "userdata", "logs", "server.log");
  const read = () => {
    try {
      return readNativePageLoad(NodeFS.readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  let previous: string | undefined;
  await browser.waitUntil(
    () => {
      const current = read();
      if (current?.phase !== "finished") return false;
      previous = current.id;
      return true;
    },
    { timeoutMsg: "Tauri did not report the current desktop document finishing its load." },
  );
  await startReload(variant);
  // WebDriver JavaScript requests can be lost during navigation. Observe the
  // test-only native lifecycle log before sending any script to the new page.
  await browser.waitUntil(
    () => {
      const current = read();
      return current?.phase === "finished" && current.id !== previous;
    },
    { timeoutMsg: "Tauri did not report the replacement desktop document finishing its load." },
  );
  // WebKitGTK can report the native finish while the new DOM is interactive.
  // It is now safe to install a load listener in that replacement document.
  await browser.executeAsync((done: (result: string) => void) => {
    if (document.readyState === "complete") {
      done("ready");
      return;
    }
    window.addEventListener("load", () => done("ready"), { once: true });
  });
}
