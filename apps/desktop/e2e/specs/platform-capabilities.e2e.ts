// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests save native screenshots.
import * as NodePath from "node:path";

import { ensureMainSidebarOpen, setDesktopUiWindowSize } from "../support/ui-state.ts";

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
if (!artifactDirectory) {
  throw new Error("BIBCODE_E2E_ARTIFACT_DIR is required.");
}

describe("packaged preferences, native integrations, and platform capabilities", () => {
  it("exercises settings, updater-disabled state, provider shims, and openers", async () => {
    await ensureMainSidebarOpen();
    const settings = browser.$("button=Settings");
    await expect(settings).toBeDisplayed();
    await settings.click();
    const appOrigin = await browser.execute(() => window.location.origin);
    await browser.url(`${appOrigin}/#/settings/about`);
    const checkForUpdates = browser.$("button=Check for Updates");
    await checkForUpdates.scrollIntoView();
    await expect(checkForUpdates).toBeDisplayed();
    await expect(checkForUpdates).toBeDisabled();

    await browser.url(`${appOrigin}/#/settings/general`);
    const themePreference = browser.$('[aria-label="Theme preference"]');
    await themePreference.scrollIntoView();
    await expect(themePreference).toBeDisplayed();
    await themePreference.click();
    const darkTheme = browser.$('//*[@role="option" and normalize-space()="Dark"]');
    await darkTheme.waitForDisplayed();
    await darkTheme.click();
    await expect(browser.$("html")).toHaveElementClass(expect.stringContaining("dark"));

    const providers = browser.$(
      "//button[@data-sidebar='menu-button'][.//span[normalize-space()='Providers']]",
    );
    await expect(providers).toBeDisplayed();
    await providers.click();
    await expect(browser.$("//*[normalize-space()='Codex']")).toBeDisplayed();
    const revealAccountEmail = browser.$('button[aria-label="Toggle account email visibility"]');
    await expect(revealAccountEmail).toBeDisplayed();
    await revealAccountEmail.click();
    await expect(browser.$("//*[contains(., 'fixture@example.test')]")).toBeDisplayed();

    await browser.url(`${appOrigin}/#/settings/connections`);
    await browser.waitUntil(
      async () => (await browser.getUrl()).endsWith("/#/settings/environments"),
      {
        timeoutMsg: "Legacy Connections settings did not redirect to Environments.",
      },
    );
    await expect(browser.$("//*[normalize-space()='Known environments']")).toBeDisplayed();
    await expect(browser.$("//*[normalize-space()='Hidden environments']")).toBeDisplayed();
    const addEnvironment = browser.$("a=Add environment");
    await expect(addEnvironment).toBeDisplayed();
    await addEnvironment.click();
    await expect(browser.$('main[aria-label="Add environment workspace"]')).toBeDisplayed();
    await expect(browser.$("//*[normalize-space()='SSH']")).toBeDisplayed();
    await expect(browser.$("//*[normalize-space()='Direct HTTPS']")).toBeDisplayed();
    await expect(browser.$("//*[contains(., 'https:// or wss:// endpoint')]")).toBeDisplayed();
    await expect(browser.$("//*[contains(., 'insecure override')]")).not.toExist();
    await expect(browser.$("//*[contains(., 'BiBCode Connect')]")).not.toExist();

    if (process.env.BIBCODE_E2E_PLATFORM === "win") {
      const wslState = await browser.execute(async () => {
        const bridge = Reflect.get(window, "desktopBridge") as
          | {
              readonly getWslState?: () => Promise<{
                readonly available: boolean;
                readonly enabled: boolean;
                readonly wslOnly: boolean;
              }>;
            }
          | undefined;
        return (await bridge?.getWslState?.()) ?? null;
      });
      if (!wslState) {
        throw new Error("Expected the packaged Windows desktop bridge to report WSL state.");
      }

      await expect(
        browser.$("//*[normalize-space()='Windows Subsystem for Linux']"),
      ).toBeDisplayed();
    } else {
      await expect(browser.$("//*[normalize-space()='Windows Subsystem for Linux']")).not.toExist();
    }

    await expect(browser.$("//*[normalize-space()='Network access']")).not.toExist();
    await expect(browser.$("//*[normalize-space()='Tailscale HTTPS']")).not.toExist();

    await browser.url(`${appOrigin}/#/settings/diagnostics`);
    const openLogsFolder = browser.$('button[aria-label="Open logs folder"]');
    await expect(openLogsFolder).toBeEnabled();
    await openLogsFolder.click();

    await setDesktopUiWindowSize(960, 640);
    await browser.saveScreenshot(
      NodePath.join(artifactDirectory, "platform-capabilities-minimum-size.png"),
    );
  });
});
