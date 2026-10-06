import { expect, it } from "vite-plus/test";
import { runSeededNativeFollowups } from "../qualify-native-followups.ts";
import { parseSeededDesktopUpgradeSmokeArgs } from "../../../../scripts/seeded-desktop-upgrade-smoke.ts";
const base = [
  "--arch",
  "x64",
  "--bundle",
  "appimage",
  "--candidate-version",
  "0.8.1-upgrade.1",
  "--platform",
  "linux",
  "--previous-tag",
  "v0.8.0",
  "--previous-version",
  "0.8.0",
  "--public-key-file",
  "/owned/key.pub",
  "--run-id",
  "test-1",
  "--work-root",
  "/owned/work",
  "--artifact-dir",
  "/owned/evidence",
];
it("the native visual lane is explicit opt-in and is unavailable on an unsupported native host", () => {
  expect(parseSeededDesktopUpgradeSmokeArgs(base, "/owned/source").nativeFollowups).toBeUndefined();
  expect(
    parseSeededDesktopUpgradeSmokeArgs([...base, "--native-followups"], "/owned/source")
      .nativeFollowups,
  ).toBe(true);
  expect(() =>
    parseSeededDesktopUpgradeSmokeArgs(
      [
        ...base.map((value) => (value === "linux" ? "mac" : value === "appimage" ? "dmg" : value)),
        "--native-followups",
      ],
      "/owned/source",
    ),
  ).toThrow();
});
it("cannot touch a live browser before actual CI and native platform admission", async () => {
  let calls = 0;
  const browser = new Proxy(
    {},
    {
      get: () => {
        calls++;
        throw new Error("native call attempted");
      },
    },
  );
  await expect(
    runSeededNativeFollowups(browser as never, { platform: "linux" } as never, {
      environment: {},
      platform: "linux",
      uid: 1000,
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
