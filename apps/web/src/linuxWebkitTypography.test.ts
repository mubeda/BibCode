// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyLinuxWebkitTypography,
  shouldApplyLinuxWebkitTypography,
} from "./linuxWebkitTypography";

const linuxUserAgent = "Test/1.0 (X11; Linux x86_64)";
const macUserAgent = "Test/1.0 (Macintosh; Intel Mac OS X)";

function installRuntime(input: { hasDesktopBridge: boolean; userAgent: string }): void {
  if (input.hasDesktopBridge) {
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {},
    });
  } else {
    Reflect.deleteProperty(window, "desktopBridge");
  }
  vi.stubGlobal("navigator", { userAgent: input.userAgent });
}

afterEach(() => {
  Reflect.deleteProperty(window, "desktopBridge");
  delete document.documentElement.dataset.linuxWebkit;
  vi.unstubAllGlobals();
});

describe("shouldApplyLinuxWebkitTypography", () => {
  it.each([
    [{ hasDesktopBridge: true, userAgent: linuxUserAgent }, true],
    [{ hasDesktopBridge: true, userAgent: macUserAgent }, false],
    [{ hasDesktopBridge: false, userAgent: linuxUserAgent }, false],
  ])("gates the runtime for %o", (input, expected) => {
    expect(shouldApplyLinuxWebkitTypography(input)).toBe(expected);
  });
});

describe("applyLinuxWebkitTypography", () => {
  it("marks the document for a Linux desktop webview", () => {
    installRuntime({ hasDesktopBridge: true, userAgent: linuxUserAgent });

    applyLinuxWebkitTypography(document);

    expect(document.documentElement.getAttribute("data-linux-webkit")).toBe("");
  });

  it.each([
    { hasDesktopBridge: true, userAgent: macUserAgent },
    { hasDesktopBridge: false, userAgent: linuxUserAgent },
  ])("leaves an ungated document unchanged for %o", (input) => {
    installRuntime(input);

    applyLinuxWebkitTypography(document);

    expect(document.documentElement.hasAttribute("data-linux-webkit")).toBe(false);
  });

  it("is idempotent", () => {
    installRuntime({ hasDesktopBridge: true, userAgent: linuxUserAgent });

    applyLinuxWebkitTypography(document);
    applyLinuxWebkitTypography(document);

    const markers = Array.from(document.documentElement.attributes).filter(
      (attribute) => attribute.name === "data-linux-webkit",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.value).toBe("");
  });
});
