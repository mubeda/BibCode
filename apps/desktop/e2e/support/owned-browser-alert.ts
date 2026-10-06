import type { QualificationBrowser } from "./qualification-owner.ts";

export function bindOwnedBrowserAlertObservation(
  browser: QualificationBrowser,
): QualificationBrowser {
  if (
    typeof Reflect.get(browser, "ownedIsAlertOpen") !== "undefined" ||
    typeof browser.getAlertText !== "function"
  )
    throw new Error("Owned alert observation binding refused.");
  browser.addCommand(
    "ownedIsAlertOpen",
    async function (this: QualificationBrowser): Promise<boolean> {
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
    },
  );
  return browser;
}

/** Read only the qualification-owned command; Chromium protocol commands remain untouched. */
export function observeOwnedBrowserAlert(browser: QualificationBrowser): Promise<boolean> {
  const command = Reflect.get(browser, "ownedIsAlertOpen");
  if (typeof command !== "function") throw new Error("Owned alert observation binding refused.");
  return command.call(browser) as Promise<boolean>;
}
