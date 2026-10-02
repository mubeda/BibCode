import { describe, expect, it } from "vite-plus/test";
import { serverReloadVersion } from "./serverReload.logic";

const firstBoot = { bootId: "boot-before", serverVersion: "0.7.2" };
describe("serverReloadVersion", () => {
  it("offers the changed server version after a new boot", () => {
    expect(
      serverReloadVersion({
        desktop: false,
        bundleVersion: "0.7.2",
        firstBoot,
        current: { bootId: "boot-after", serverVersion: "0.7.3" },
      }),
    ).toBe("0.7.3");
  });
  it.each([
    { desktop: true, current: { bootId: "boot-after", serverVersion: "0.7.3" } },
    { desktop: false, current: firstBoot },
    { desktop: false, current: { bootId: "boot-after", serverVersion: "0.7.2" } },
    { desktop: false, current: { bootId: null, serverVersion: "0.7.3" } },
    { desktop: false, current: null },
  ])("stays quiet for %j", ({ desktop, current }) => {
    expect(serverReloadVersion({ desktop, bundleVersion: "0.7.2", firstBoot, current })).toBeNull();
  });
  it("requires a known first boot", () => {
    expect(
      serverReloadVersion({
        desktop: false,
        bundleVersion: "0.7.2",
        firstBoot: null,
        current: { bootId: "boot-after", serverVersion: "0.7.3" },
      }),
    ).toBeNull();
    expect(
      serverReloadVersion({
        desktop: false,
        bundleVersion: "0.7.2",
        firstBoot: { bootId: null, serverVersion: "0.7.2" },
        current: { bootId: "boot-after", serverVersion: "0.7.3" },
      }),
    ).toBeNull();
  });
});
