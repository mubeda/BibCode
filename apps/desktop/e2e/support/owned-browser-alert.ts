import type { QualificationBrowser } from "./qualification-owner.ts";

export function bindOwnedBrowserAlertObservation(
  browser: QualificationBrowser,
): QualificationBrowser {
  if (typeof browser.isAlertOpen !== "undefined" || typeof browser.getAlertText !== "function")
    throw new Error("Owned alert observation binding refused.");
  browser.addCommand("isAlertOpen", async function (this: QualificationBrowser): Promise<boolean> {
    try {
      await this.getAlertText();
      return true;
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "no such alert"
      )
        return false;
      throw error;
    }
  });
  return browser;
}
