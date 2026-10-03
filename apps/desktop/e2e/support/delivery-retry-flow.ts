export interface RetryDialogBrowser {
  isAlertOpen(): Promise<boolean>;
  getAlertText(): Promise<string>;
  dismissAlert(): Promise<unknown>;
  acceptAlert(): Promise<unknown>;
  waitUntil(
    probe: () => Promise<boolean>,
    options: { timeout: number; interval: number; timeoutMsg: string },
  ): Promise<unknown>;
}
/** No DOM/screenshot command while the real user-agent prompt is open. */
export async function resolveActualRetryPrompt(
  browser: RetryDialogBrowser,
  click: () => Promise<void>,
  action: "dismiss" | "accept",
) {
  try {
    if (await browser.isAlertOpen()) throw new Error();
    await click();
    await browser.waitUntil(() => browser.isAlertOpen(), {
      timeout: 5000,
      interval: 100,
      timeoutMsg: "Owned Retry prompt did not arrive.",
    });
    if ((await browser.getAlertText()) !== retryPrompt) throw new Error();
    if (action === "dismiss") await browser.dismissAlert();
    else await browser.acceptAlert();
    if (await browser.isAlertOpen()) throw new Error();
    return { observed: true, exactCopy: true, action } as const;
  } catch {
    throw new Error("Actual Retry prompt interaction failed.");
  }
}
import { retryPrompt } from "./delivery-retry-evidence.ts";
