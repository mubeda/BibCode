// @effect-diagnostics nodeBuiltinImport:off - WDIO configuration manages host test artifacts.
// @effect-diagnostics globalConsole:off - WDIO configuration reports the retained artifact path.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { resolveDesktopAppPath, type DesktopUiPlatform } from "./support/app-path.ts";
import {
  deferDesktopUiTestContextCleanupUntilExit,
  prepareDesktopUiTestContext,
} from "./support/test-project.ts";
import { normalizeWebDriverRequest } from "./support/webdriver-request.ts";

// oxlint-disable-next-line bibcode/no-global-process-runtime -- The standalone WDIO config detects the host once and passes it to pure adapters.
const hostPlatform = process.platform;
const platform: DesktopUiPlatform =
  process.env.BIBCODE_E2E_PLATFORM === "mac" ||
  process.env.BIBCODE_E2E_PLATFORM === "linux" ||
  process.env.BIBCODE_E2E_PLATFORM === "win"
    ? process.env.BIBCODE_E2E_PLATFORM
    : hostPlatform === "darwin"
      ? "mac"
      : hostPlatform === "win32"
        ? "win"
        : "linux";
const testContext = prepareDesktopUiTestContext();
const appBinaryPath = resolveDesktopAppPath({
  platform,
  environment: process.env,
});
const requestedSpec = process.env.BIBCODE_E2E_SPEC?.trim();

if (!NodeFS.existsSync(appBinaryPath)) {
  throw new Error(`Packaged BiBCode application does not exist: ${appBinaryPath}`);
}

const screenshotPath = (title: string): string =>
  NodePath.join(
    testContext.artifactDirectory,
    `${title
      .replaceAll(/[^a-z0-9]+/gi, "-")
      .replaceAll(/(^-|-$)/g, "")
      .toLowerCase()}.png`,
  );

async function resetDesktopUiConnectionCache(): Promise<void> {
  const resetError = await browser.executeAsync((done: (error: string | null) => void) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      done(error);
    };
    const openRequest = indexedDB.open("bibcode:connection-runtime", 2);
    openRequest.addEventListener("error", () => {
      finish(String(openRequest.error ?? "Could not open the E2E connection catalog."));
    });
    openRequest.addEventListener("upgradeneeded", () => {
      finish("The E2E connection catalog schema was unexpectedly missing.");
    });
    openRequest.addEventListener("success", () => {
      const database = openRequest.result;
      const storeNames = ["catalog", "shell", "thread"];
      const transaction = database.transaction(storeNames, "readwrite");
      transaction.addEventListener("error", () => {
        database.close();
        finish(String(transaction.error ?? "Could not reset the E2E connection catalog."));
      });
      transaction.addEventListener("complete", () => {
        database.close();
        finish(null);
      });
      for (const storeName of storeNames) {
        transaction.objectStore(storeName).clear();
      }
    });
  });
  if (resetError !== null) {
    throw new Error(resetError);
  }
  await browser.refresh();
}

export const config = {
  runner: "local",
  specs:
    requestedSpec && requestedSpec.length > 0
      ? [requestedSpec]
      : [
          "./specs/main-window.e2e.ts",
          "./specs/project-session-terminal.e2e.ts",
          "./specs/platform-capabilities.e2e.ts",
          "./specs/terminal-font.e2e.ts",
          "./specs/composer-native-triggers.e2e.ts",
          "./specs/chat-activity-panel.e2e.ts",
        ],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        driverProvider: "embedded",
        embeddedPort: Number(process.env.BIBCODE_E2E_WEBDRIVER_PORT ?? 4_445),
        startTimeout: 90_000,
        statusPollTimeout: 10_000,
        commandTimeout: 30_000,
        logDir: testContext.artifactDirectory,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinaryPath,
      },
    },
  ],
  logLevel: "info",
  outputDir: testContext.artifactDirectory,
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  transformRequest: normalizeWebDriverRequest,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
  before: async () => {
    await resetDesktopUiConnectionCache();
    await browser.execute(() => {
      const sheet = [...document.styleSheets].find((candidate) => {
        try {
          void candidate.cssRules;
          return true;
        } catch {
          return false;
        }
      });
      if (sheet === undefined) {
        throw new Error("No writable bundled stylesheet is available for desktop UI automation.");
      }
      const rules = [
        `
        html:not([data-bibcode-desktop-ui-motion="native"]) *,
        html:not([data-bibcode-desktop-ui-motion="native"]) *::before,
        html:not([data-bibcode-desktop-ui-motion="native"]) *::after {
          animation-delay: 0s !important;
          animation-duration: 0s !important;
          transition-delay: 0s !important;
          transition-duration: 0s !important;
        }`,
        `
        [data-open][data-starting-style] {
          opacity: 1 !important;
          scale: 1 !important;
          translate: none !important;
          transform: none !important;
        }`,
        `
        [data-closed] {
          display: none !important;
        }`,
        `
        [data-slot="sidebar-group"]:has([data-testid="new-main-chat-button"])
          ul[data-sidebar="menu"] > li {
          opacity: 1 !important;
          transform: none !important;
        }`,
      ];
      for (const rule of rules) {
        sheet.insertRule(rule, sheet.cssRules.length);
      }
      document.documentElement.dataset.bibcodeDesktopUiMotion = "disabled";
    });
  },
  afterTest: async (
    test: { readonly title: string },
    _context: unknown,
    result: { readonly passed: boolean },
  ) => {
    if (!result.passed) {
      await browser.saveScreenshot(screenshotPath(`failure-${test.title}`));
      NodeFS.writeFileSync(
        screenshotPath(`failure-source-${test.title}`).replace(/\.png$/, ".html"),
        await browser.getPageSource(),
      );
    }
  },
  onComplete: () => {
    // WDIO invokes configuration hooks before launcher service hooks. Defer shared fixture cleanup
    // until process exit so the Tauri service has released Windows filesystem handles first.
    deferDesktopUiTestContextCleanupUntilExit(testContext, process);
    console.log(`Desktop UI artifacts: ${testContext.artifactDirectory}`);
  },
};
