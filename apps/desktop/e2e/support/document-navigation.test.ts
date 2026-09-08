import { afterEach, expect, it, vi } from "vite-plus/test";

import { refreshDesktopUiDocument } from "./document-navigation.ts";

afterEach(() => vi.unstubAllGlobals());

it("does not mistake the previous complete document for the refreshed page", async () => {
  const navigation = { timeOrigin: 1 };
  const document = { readyState: "complete" };
  const readiness: boolean[] = [];
  vi.stubGlobal("performance", navigation);
  vi.stubGlobal("document", document);
  vi.stubGlobal("browser", {
    execute: async (callback: (value?: number) => unknown, value?: number) => callback(value),
    refresh: async () => undefined,
    waitUntil: async (predicate: () => Promise<boolean>) => {
      readiness.push(await predicate());
      navigation.timeOrigin = 2;
      document.readyState = "loading";
      readiness.push(await predicate());
      document.readyState = "complete";
      readiness.push(await predicate());
      if (!readiness.at(-1)) throw new Error("New document not ready.");
    },
  });
  await refreshDesktopUiDocument();
  expect(readiness).toEqual([false, false, true]);
});
