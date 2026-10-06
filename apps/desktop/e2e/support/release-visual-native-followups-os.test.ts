import { expect, it } from "vite-plus/test";
import {
  nativeFollowupOsPlan,
  parseNativeFollowupPortalScheme,
  withNativeFollowupOsTheme,
} from "./release-visual-native-followups-os.ts";

it("selects actual OS operations and refuses relabelled Windows or unsupported original capture", () => {
  expect(nativeFollowupOsPlan("linux", "linux", "dark")).toMatchObject({
    themeArgs: ["set", "org.gnome.desktop.interface", "color-scheme", "prefer-dark"],
    captureArgs: ["-window", "root"],
  });
  expect(() => nativeFollowupOsPlan("win32", "linux", "dark")).toThrow();
  expect(() => nativeFollowupOsPlan("darwin", "darwin", "light")).toThrow();
  expect(parseNativeFollowupPortalScheme("(<uint32 1>,)")).toBe("dark");
  expect(parseNativeFollowupPortalScheme("(<<uint32 2>>,)")).toBe("light");
  expect(parseNativeFollowupPortalScheme("(<uint32 0>,)")).toBe("light");
  for (const value of ["(<uint32 3>,)", "error: SECRET", "(<uint32 1>,) extra"])
    expect(() => parseNativeFollowupPortalScheme(value)).toThrow();
});

it("restores the real prior OS theme after verification or capture failure and preserves the original error", async () => {
  const original = new Error("original");
  const calls: string[] = [];
  const ports = {
    read: async () => "prefer-light",
    write: async (theme: string) => {
      calls.push(theme);
      if (theme === "prefer-light") throw new Error("cleanup");
    },
    verify: async () => {},
    unsafe: () => {
      calls.push("unsafe");
    },
  };
  await expect(
    withNativeFollowupOsTheme(ports, "dark", async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  expect(calls).toEqual(["prefer-dark", "prefer-light", "unsafe"]);
});
