import { describe, expect, it } from "vite-plus/test";

import { desktopUiReloadVariant } from "./reload-variant.ts";

describe("packaged reload experiments", () => {
  it("defaults to the WebDriver refresh with the plugin fully on", () => {
    expect(desktopUiReloadVariant(undefined)).toEqual({
      id: "A",
      mechanism: "webdriver",
      consoleForwarding: true,
      pluginAfterReload: true,
    });
    expect(desktopUiReloadVariant(" ")).toMatchObject({ id: "A" });
  });

  it("isolates the reload mechanism, console forwarding and the reloaded plugin", () => {
    expect(desktopUiReloadVariant("b")).toMatchObject({
      mechanism: "native",
      consoleForwarding: true,
    });
    expect(desktopUiReloadVariant("C")).toMatchObject({
      mechanism: "webdriver",
      consoleForwarding: false,
    });
    expect(desktopUiReloadVariant("D")).toMatchObject({
      mechanism: "page",
      consoleForwarding: false,
      pluginAfterReload: false,
    });
    expect(desktopUiReloadVariant("E")).toMatchObject({
      mechanism: "page",
      consoleForwarding: true,
    });
  });

  it("rejects an unknown variant instead of running the default", () => {
    expect(() => desktopUiReloadVariant("F")).toThrow(/Unknown BIBCODE_E2E_RELOAD_VARIANT/);
  });
});
