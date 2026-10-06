import { captureOwnedVisualScene } from "./owned-visual-capture.ts";
import {
  readNativeSharingDom,
  validateNativeSharingDom,
} from "./release-visual-native-sharing-dom.ts";
import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import type { NativeSharingRouteScope } from "./release-visual-native-sharing-route.ts";
import type { NativeSharingVisualPorts } from "./release-visual-native-sharing.ts";
export type NativeSharingBrowserPreparationStage =
  | "native-ui-ports-url-read"
  | "native-ui-ports-url-admission"
  | "native-ui-ports-general-navigate"
  | "native-ui-ports-theme-display"
  | "native-ui-ports-theme-text"
  | "native-ui-ports-theme-admission"
  | "native-ui-ports-original-restore";
export interface NativeSharingBrowserPreparationFacts {
  uiPortsUrlReturned: boolean;
  uiPortsUrlProtocolMatched: boolean;
  uiPortsUrlHostMatched: boolean;
  uiPortsUrlAuthorityClean: boolean;
  uiPortsUrlRootPathMatched: boolean;
  uiPortsUrlQueryClean: boolean;
  uiPortsUrlRouteAllowed: boolean;
  uiPortsGeneralNavigated: boolean;
  uiPortsThemeDisplayed: boolean;
  uiPortsThemeTextReturned: boolean;
  uiPortsThemeLabelAllowed: boolean;
  uiPortsThemeLabelSystem: boolean;
  uiPortsThemeLabelLight: boolean;
  uiPortsThemeLabelDark: boolean;
  uiPortsOriginalRestoreAttempted: boolean;
  uiPortsOriginalRestored: boolean;
  uiPortsOriginalRestoreFailed: boolean;
}
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
  readonly onPreparationStage?: (stage: NativeSharingBrowserPreparationStage) => void;
  readonly onPreparationFacts?: (facts: Partial<NativeSharingBrowserPreparationFacts>) => void;
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
  let observerFailed = false;
  const observerFailure = () => {
    observerFailed = true;
    try {
      input.unsafeCleanup();
    } catch {
      /* Attribution cannot replace a genuine operation failure. */
    }
  };
  const stage = (value: NativeSharingBrowserPreparationStage) => {
    try {
      input.onPreparationStage?.(value);
    } catch {
      observerFailure();
    }
  };
  const observe = (facts: Partial<NativeSharingBrowserPreparationFacts>) => {
    try {
      input.onPreparationFacts?.(facts);
    } catch {
      observerFailure();
    }
  };
  stage("native-ui-ports-url-read");
  const original = await browser.getUrl();
  observe({ uiPortsUrlReturned: true });
  stage("native-ui-ports-url-admission");
  const url = new URL(original);
  // Linux packaged assets use Tauri's custom scheme; URL.origin is opaque in Node.
  const origin = "tauri://localhost";
  observe({
    uiPortsUrlProtocolMatched: url.protocol === "tauri:",
    uiPortsUrlHostMatched: url.hostname === "localhost",
    uiPortsUrlAuthorityClean: url.port === "" && url.username === "" && url.password === "",
    uiPortsUrlRootPathMatched: url.pathname === "/",
    uiPortsUrlQueryClean: url.search === "",
    uiPortsUrlRouteAllowed: /^#\/(local\/[A-Za-z0-9._:-]+|settings\/[a-z-]+)$/.test(url.hash),
  });
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
    stage("native-ui-ports-general-navigate");
    await browser.url(general);
    observe({ uiPortsGeneralNavigated: true });
    stage("native-ui-ports-theme-display");
    const preference = browser.$('[aria-label="Theme preference"]');
    await preference.waitForDisplayed();
    observe({ uiPortsThemeDisplayed: true });
    stage("native-ui-ports-theme-text");
    prior = (await preference.getText()).trim();
    observe({
      uiPortsThemeTextReturned: true,
      uiPortsThemeLabelAllowed: ["System", "Light", "Dark"].includes(prior),
      uiPortsThemeLabelSystem: prior === "System",
      uiPortsThemeLabelLight: prior === "Light",
      uiPortsThemeLabelDark: prior === "Dark",
    });
    stage("native-ui-ports-theme-admission");
    if (!["System", "Light", "Dark"].includes(prior)) throw refused();
  } catch (error) {
    preferenceFailed = true;
    preferenceFailure = error;
  }
  try {
    if (!preferenceFailed) stage("native-ui-ports-original-restore");
    observe({ uiPortsOriginalRestoreAttempted: true });
    await browser.url(original);
    observe({ uiPortsOriginalRestored: true });
  } catch (error) {
    observe({ uiPortsOriginalRestoreFailed: true });
    try {
      input.unsafeCleanup();
    } catch {
      /* Original preference failure remains authoritative. */
    }
    if (!preferenceFailed) throw error;
  }
  if (preferenceFailed) throw preferenceFailure;
  if (observerFailed) throw refused();
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
