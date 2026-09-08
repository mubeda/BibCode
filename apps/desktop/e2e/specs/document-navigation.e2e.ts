import { refreshDesktopUiDocument } from "../support/document-navigation.ts";

describe("packaged native document readiness", () => {
  it("waits for each replacement document before executing JavaScript", async () => {
    const origins = new Set([await browser.execute(() => performance.timeOrigin)]);
    for (let reload = 0; reload < 3; reload += 1) {
      await refreshDesktopUiDocument();
      const page = await browser.execute(() => ({
        origin: performance.timeOrigin,
        ready: document.readyState,
      }));
      expect(page.ready).toBe("complete");
      expect(origins.has(page.origin)).toBe(false);
      origins.add(page.origin);
    }
  });
});
