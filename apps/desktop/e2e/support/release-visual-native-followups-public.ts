import type { QualificationBrowser } from "./qualification-owner.ts";
import type { NativeFollowupWindow } from "./release-visual-native-followups-state.ts";
export async function nativeFollowupPublicClick(browser: QualificationBrowser, selector: string) {
  const node = browser.$(selector);
  await node.waitForDisplayed();
  await node.waitForEnabled();
  if ((await (await browser.$$(selector)).length) !== 1)
    throw new Error("Native follow-up public control ambiguous.");
  await node.click();
}
export async function selectNativeFollowupTheme(
  browser: QualificationBrowser,
  label: "System" | "Light" | "Dark",
  origin: string,
) {
  await browser.url(origin + "/#/settings/general");
  await nativeFollowupPublicClick(browser, '[aria-label="Theme preference"]');
  await nativeFollowupPublicClick(
    browser,
    '//*[@role="option" and normalize-space()="' + label + '"]',
  );
}
export async function openNativeFollowupUpdate(browser: QualificationBrowser, origin: string) {
  await browser.url(origin + "/#/settings/about");
  await nativeFollowupPublicClick(browser, '//button[normalize-space()="Install"]');
}
export async function prepareNativeFollowupDownload(
  browser: QualificationBrowser,
  origin: string,
  version: string,
  until: (check: () => Promise<boolean>) => Promise<void>,
) {
  await browser.url(origin + "/#/settings/about");
  const initial = await browser.execute(async () => {
    const state = await (window as NativeFollowupWindow).desktopBridge!.getUpdateState();
    return {
      status: state.status,
      availableVersion: state.availableVersion,
      downloadedVersion: state.downloadedVersion,
    };
  });
  if (initial.status === "downloaded" && initial.downloadedVersion === version) return;
  if (initial.status === "idle")
    await nativeFollowupPublicClick(browser, '//button[normalize-space()="Check for Updates"]');
  else if (
    initial.status !== "checking" &&
    !(initial.status === "available" && initial.availableVersion === version)
  )
    throw new Error("Native follow-up signed update availability refused.");
  await until(async () =>
    browser.execute(async (version) => {
      const state = await (window as NativeFollowupWindow).desktopBridge!.getUpdateState();
      return state.status === "available" && state.availableVersion === version;
    }, version),
  );
  await nativeFollowupPublicClick(browser, '//button[normalize-space()="Download"]');
  await until(async () =>
    browser.execute(async (version) => {
      const state = await (window as NativeFollowupWindow).desktopBridge!.getUpdateState();
      return state.status === "downloaded" && state.downloadedVersion === version;
    }, version),
  );
}
