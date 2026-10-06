import { captureOwnedVisualScene } from "./owned-visual-capture.ts";
import {
  readNativeSharingDom,
  validateNativeSharingDom,
} from "./release-visual-native-sharing-dom.ts";
import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import type { NativeSharingRouteScope } from "./release-visual-native-sharing-route.ts";
import type { NativeSharingVisualPorts } from "./release-visual-native-sharing.ts";
export interface NativeSharingBrowserInput {
  readonly browser: QualificationBrowser;
  readonly owner: Pick<QualificationOwner, "until">;
  readonly evidence: string;
  readonly captured: Set<string>;
  readonly routeScope: (run: (scope: NativeSharingRouteScope) => Promise<void>) => Promise<void>;
  readonly verifyRoute: (
    scope: NativeSharingRouteScope,
    expected: "absent" | "owned",
  ) => Promise<void>;
  readonly identity: () => Promise<void>;
  readonly unsafeCleanup: () => void;
  readonly onCapture?: (receipt: Readonly<Record<string, unknown>>) => void;
  readonly onScene?: (
    scene: "native-share-no-route" | "native-share-refresh",
    theme: "light" | "dark",
  ) => void;
}
export async function createNativeSharingBrowserPorts(
  input: NativeSharingBrowserInput,
): Promise<NativeSharingVisualPorts> {
  const browser = input.browser,
    refused = () => new Error("Owned native sharing browser refused.");
  const original = await browser.getUrl();
  const url = new URL(original);
  // Linux packaged assets use Tauri's custom scheme; URL.origin is opaque in Node.
  const origin = "tauri://localhost";
  if (
    url.protocol !== "tauri:" ||
    url.hostname !== "localhost" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search ||
    !/^#\/(local\/[A-Za-z0-9._:-]+|settings\/[a-z-]+)$/.test(url.hash)
  )
    throw refused();
  const click = async (selector: string) => {
    const control = browser.$(selector);
    await control.waitForDisplayed();
    await control.waitForEnabled();
    const matches = await browser.$$(selector);
    if ((await matches.length) !== 1) throw refused();
    await input.identity();
    await control.click();
  };
  const general = origin + "/#/settings/general",
    share = origin + "/#/settings/remote-servers";
  let prior = "";
  let preferenceFailed = false,
    preferenceFailure: unknown;
  try {
    await browser.url(general);
    const preference = browser.$('[aria-label="Theme preference"]');
    await preference.waitForDisplayed();
    prior = (await preference.getText()).trim();
    if (!["System", "Light", "Dark"].includes(prior)) throw refused();
  } catch (error) {
    preferenceFailed = true;
    preferenceFailure = error;
  }
  try {
    await browser.url(original);
  } catch (error) {
    try {
      input.unsafeCleanup();
    } catch {
      /* Original preference failure remains authoritative. */
    }
    if (!preferenceFailed) throw error;
  }
  if (preferenceFailed) throw preferenceFailure;
  let scope: NativeSharingRouteScope | null = null,
    expected: "absent" | "owned" = "owned";
  const selectTheme = async (label: "System" | "Light" | "Dark") => {
    await browser.url(general);
    await click('[aria-label="Theme preference"]');
    await click('//*[@role="option" and normalize-space()="' + label + '"]');
  };
  const verify = async () => {
    await input.identity();
    if (scope) await input.verifyRoute(scope, expected);
  };
  return {
    theme: async (theme) => selectTheme(theme === "light" ? "Light" : "Dark"),
    openShare: async () => {
      await browser.url(share);
      await click('//*[@role="tab" and normalize-space()="Share this host"]');
    },
    refresh: () => click('button[aria-label="Refresh addresses"]'),
    verifyIdentity: input.identity,
    withMissingRoute: async (run) =>
      input.routeScope(async (current) => {
        scope = current;
        expected = "absent";
        try {
          await run(current);
        } finally {
          scope = null;
          expected = "owned";
        }
      }),
    verifyRoute: async (current, state) => {
      if (scope !== current) throw refused();
      expected = state;
      await input.verifyRoute(current, state);
    },
    capture: async (scene, theme) => {
      if (scope === null) throw refused();
      input.onScene?.(scene, theme);
      expected = scene === "native-share-no-route" ? "absent" : "owned";
      const receipt = await captureOwnedVisualScene({
        browser,
        owner: input.owner,
        evidence: input.evidence,
        file: scene + "-" + theme + ".png",
        captured: input.captured,
        observation: () => ({ scene, theme, origin }),
        read: (value) => browser.execute(readNativeSharingDom, value),
        verifyOwnedIdentity: verify,
        validate: validateNativeSharingDom,
        project: ({ file, witness, ...image }) =>
          Object.freeze({ scene, theme, file, witness, ...image }),
        refused,
      });
      input.onCapture?.(receipt);
    },
    restoreOriginal: async () => {
      await selectTheme(prior as "System" | "Light" | "Dark");
      await browser.url(original);
    },
    unsafeCleanup: input.unsafeCleanup,
  };
}
