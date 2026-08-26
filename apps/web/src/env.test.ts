import { afterEach, describe, expect, it, vi } from "vite-plus/test";

describe("runtime host detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps an ordinary browser outside the desktop trust boundary", async () => {
    vi.stubGlobal("window", {});

    await expect(import("./env")).resolves.toMatchObject({
      isDesktopHost: false,
      isTauri: false,
    });
  });

  it.each([{ __TAURI__: {} }, { __TAURI_INTERNALS__: {} }])(
    "recognizes a Tauri desktop global without bundling the Tauri API for detection",
    async (windowValue) => {
      vi.stubGlobal("window", windowValue);

      await expect(import("./env")).resolves.toMatchObject({
        isDesktopHost: true,
        isTauri: true,
      });
    },
  );

  it("recognizes a non-Tauri desktop bridge", async () => {
    vi.stubGlobal("window", { desktopBridge: {} });

    await expect(import("./env")).resolves.toMatchObject({
      isDesktopHost: true,
      isTauri: false,
    });
  });
});
