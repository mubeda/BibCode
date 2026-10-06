import { expect, it } from "vite-plus/test";
import {
  runNativeSharingVisual,
  type NativeSharingVisualPorts,
} from "./release-visual-native-sharing.ts";
import type { NativeSharingRouteScope } from "./release-visual-native-sharing-route.ts";
function fixture(fault?: "capture" | "restore") {
  const calls: string[] = [];
  let route: "absent" | "owned" = "owned",
    theme: "light" | "dark" = "light";
  const original = new Error("Inert original native sharing capture failure.");
  const ports = {
    theme: async (next: "light" | "dark") => {
      theme = next;
      calls.push("theme:" + next);
    },
    openShare: async () => {
      calls.push("public-share");
    },
    refresh: async () => {
      calls.push("public-refresh");
    },
    verifyIdentity: async () => {
      calls.push("identity");
    },
    withMissingRoute: async (run: (scope: NativeSharingRouteScope) => Promise<void>) => {
      route = "absent";
      calls.push("remove-route");
      const scope = {
        kind: "native-sharing-private-route" as const,
        restore: async () => {
          route = "owned";
          calls.push("restore-route");
        },
      };
      try {
        await run(scope);
      } finally {
        route = "owned";
        calls.push("route-cleanup");
      }
    },
    verifyRoute: async (_scope: NativeSharingRouteScope, expected: "absent" | "owned") => {
      expect(route).toBe(expected);
      calls.push("route:" + expected);
    },
    capture: async (
      scene: "native-share-no-route" | "native-share-refresh",
      actualTheme: "light" | "dark",
    ) => {
      expect(actualTheme).toBe(theme);
      expect(route).toBe(scene === "native-share-no-route" ? "absent" : "owned");
      calls.push("capture:" + scene + ":" + theme);
      if (fault === "capture") throw original;
    },
    restoreOriginal: async () => {
      calls.push("restore-original");
      if (fault === "restore") throw new Error("Inert UI restore failure.");
    },
    unsafeCleanup: () => calls.push("unsafe"),
  } as NativeSharingVisualPorts;
  return { ports, calls, original };
}
it("captures exactly the two approved native sharing rows in each theme through genuine public operations", async () => {
  const f = fixture();
  await runNativeSharingVisual(f.ports);
  expect(f.calls.filter((call) => call.startsWith("capture:"))).toEqual([
    "capture:native-share-no-route:light",
    "capture:native-share-refresh:light",
    "capture:native-share-no-route:dark",
    "capture:native-share-refresh:dark",
  ]);
  expect(f.calls.filter((call) => call === "public-refresh")).toHaveLength(4);
  expect(f.calls.at(-1)).toBe("identity");
  expect(f.calls).not.toContain("unsafe");
});
it("preserves capture failure and closes native route and original UI scope", async () => {
  const f = fixture("capture");
  await expect(runNativeSharingVisual(f.ports)).rejects.toBe(f.original);
  expect(f.calls).toContain("route-cleanup");
  expect(f.calls).toContain("restore-original");
});
it("keeps successful images unqualified when original UI restoration fails", async () => {
  const f = fixture("restore");
  await expect(runNativeSharingVisual(f.ports)).rejects.toThrow();
  expect(f.calls).toContain("unsafe");
});
