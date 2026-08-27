import { describe, expect, it } from "vite-plus/test";

import { resolvePairingDeepLink } from "./desktopDeepLink";

describe("resolvePairingDeepLink", () => {
  it("extracts the code from bibcode://pair deep links", () => {
    expect(resolvePairingDeepLink("bibcode://pair?code=abc123-_")).toEqual({
      code: "abc123-_",
    });
  });

  it("rejects other schemes, hosts, and codeless links", () => {
    expect(resolvePairingDeepLink("https://pair?code=abc")).toBeNull();
    expect(resolvePairingDeepLink("bibcode://other?code=abc")).toBeNull();
    expect(resolvePairingDeepLink("bibcode://pair")).toBeNull();
    expect(resolvePairingDeepLink("not a url")).toBeNull();
  });
});
