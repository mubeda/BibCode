// @effect-diagnostics nodeBuiltinImport:off - One bounded, immutable loopback content fixture for the actual native child webview.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type { QualificationBrowser } from "./qualification-owner.ts";
import { bounded } from "./qualification-owner.ts";
import { nativeFollowupPublicClick } from "./release-visual-native-followups-public.ts";
import type { DesktopPreviewTabState } from "../../../../packages/contracts/src/ipc.ts";
import type { NativeFollowupWindow } from "./release-visual-native-followups-state.ts";
export const nativeFollowupPreviewHtml =
  '<!doctype html><html><head><meta charset="utf-8"><title>Native preview fixture</title><style>:root{color-scheme:light dark}body{font:18px system-ui;margin:40px;background:Canvas;color:CanvasText}button{font:inherit;padding:16px}</style></head><body><h1>Native preview fixture</h1><button id="owned-native-element">Owned preview element</button><p>Owned loopback content for native viewport preparation.</p></body></html>';
export function respondNativeFollowupPreview(method: string, path: string, peer: string) {
  const allowed =
    method === "GET" &&
    path === "/native-preview-fixture" &&
    ["127.0.0.1", "::ffff:127.0.0.1"].includes(peer);
  return {
    status: allowed ? 200 : 404,
    bytes: allowed ? Buffer.from(nativeFollowupPreviewHtml) : Buffer.alloc(0),
    sha256: NodeCrypto.createHash("sha256").update(nativeFollowupPreviewHtml).digest("hex"),
  };
}
interface PreviewObservation {
  state: DesktopPreviewTabState | null;
  dispose: () => void;
}
type ObservedWindow = NativeFollowupWindow & {
  __bibcodeNativeFollowupPreviewRead?: PreviewObservation;
};
/** A private passive observer only. It never populates bridge, provider, canonical, or composer state. */
export function startNativeFollowupPreviewRead() {
  const host = window as ObservedWindow;
  if (host.__bibcodeNativeFollowupPreviewRead || !host.desktopBridge?.preview)
    throw new Error("Native preview observer refused.");
  const observation: PreviewObservation = { state: null, dispose: () => {} };
  observation.dispose = host.desktopBridge.preview.onStateChange((_tab, state) => {
    observation.state = state;
  });
  host.__bibcodeNativeFollowupPreviewRead = observation;
}
export function readNativeFollowupPreview() {
  return (window as ObservedWindow).__bibcodeNativeFollowupPreviewRead?.state ?? null;
}
export function stopNativeFollowupPreviewRead() {
  const host = window as ObservedWindow;
  host.__bibcodeNativeFollowupPreviewRead?.dispose();
  delete host.__bibcodeNativeFollowupPreviewRead;
}

/** Prepares current supported native preview controls; no annotation row original is captured. */
export async function prepareNativeFollowupSupportedPreview(input: {
  browser: QualificationBrowser;
  until: (read: () => Promise<boolean>) => Promise<void>;
  verify: () => Promise<void>;
  unsafe: () => void;
}) {
  let requestCount = 0,
    overflow = false,
    observer = false,
    opened = false;
  const server = NodeHttp.createServer((request, response) => {
    requestCount++;
    const result = respondNativeFollowupPreview(
      request.method ?? "",
      request.url ?? "",
      request.socket.remoteAddress ?? "",
    );
    if (requestCount > 128 || (request.url?.length ?? 0) > 1024 || request.method !== "GET") {
      overflow = true;
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(result.status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-length": result.bytes.length,
    });
    response.end(result.bytes);
  });
  server.maxConnections = 8;
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  let failed = false,
    original: unknown,
    observation: DesktopPreviewTabState | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1")
      throw new Error("Native preview loopback ownership refused.");
    const url = "http://127.0.0.1:" + address.port + "/native-preview-fixture";
    await input.verify();
    await input.browser.execute(startNativeFollowupPreviewRead);
    observer = true;
    const toggle = input.browser.$('[aria-label="Toggle right panel"]');
    if ((await toggle.getAttribute("aria-pressed")) !== "true")
      await nativeFollowupPublicClick(input.browser, '[aria-label="Toggle right panel"]');
    await nativeFollowupPublicClick(
      input.browser,
      '//button[.//span[normalize-space()="Browser"] and .//span[normalize-space()="Open a local app or URL."]]',
    );
    opened = true;
    const field = input.browser.$("[data-preview-url-input]");
    await field.waitForDisplayed();
    await field.setValue(url);
    await input.browser.keys("Enter");
    await input.until(async () => {
      observation = await input.browser.execute(readNativeFollowupPreview);
      return (
        observation?.navStatus.kind === "Success" &&
        observation.navStatus.url === url &&
        observation.navStatus.title === "Native preview fixture"
      );
    });
    await nativeFollowupPublicClick(input.browser, '[aria-label="Preview menu"]');
    await nativeFollowupPublicClick(
      input.browser,
      '//*[@role="menuitem" and normalize-space()="Show device toolbar"]',
    );
    await input.browser.$('[aria-label="Browser device toolbar"]').waitForDisplayed();
    const supported = await input.browser.execute(() => ({
      deviceToolbar: document.querySelector('[aria-label="Browser device toolbar"]') !== null,
      pickerAbsent: document.querySelector('[aria-label="Annotate preview"]') === null,
      cardsAbsent: document.querySelector('[aria-label="Remove preview annotation"]') === null,
    }));
    if (
      !supported.deviceToolbar ||
      !supported.pickerAbsent ||
      !supported.cardsAbsent ||
      requestCount < 1 ||
      overflow ||
      !observation
    )
      throw new Error("Native supported preview preparation refused.");
    await input.verify();
    return {
      scene: "native-preview-annotations",
      status: "unavailable",
      reason: "production-native-picker-unsupported",
      supportedPreparation: "observed",
      childSuccessRead: true,
      contentSha256: NodeCrypto.createHash("sha256")
        .update(nativeFollowupPreviewHtml)
        .digest("hex"),
      tabIdentitySha256: NodeCrypto.createHash("sha256")
        .update((observation as DesktopPreviewTabState).tabId)
        .digest("hex"),
      deviceToolbar: true,
      originalCount: 0,
    };
  } catch (error) {
    failed = true;
    original = error;
  } finally {
    try {
      if (opened)
        await nativeFollowupPublicClick(
          input.browser,
          'button[aria-label="Close Native preview fixture"]',
        );
    } catch {
      input.unsafe();
    }
    try {
      if (observer) await input.browser.execute(stopNativeFollowupPreviewRead);
    } catch {
      input.unsafe();
    }
    try {
      server.closeAllConnections();
      await bounded(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        5000,
      );
    } catch {
      input.unsafe();
    }
  }
  if (failed) throw original;
  throw new Error("Native preview preparation unavailable.");
}
