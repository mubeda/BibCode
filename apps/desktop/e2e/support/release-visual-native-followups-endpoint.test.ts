import { expect, it } from "vite-plus/test";
import { admitNativeFollowupEndpoint } from "./release-visual-native-followups-endpoint.ts";
it("admits only native loopback or the exact real WSL private address, never a relabelled remote", () => {
  expect(
    admitNativeFollowupEndpoint("http://172.27.0.99:4883", "win32", "OwnedDistro", ["172.27.0.99"])
      .hostname,
  ).toBe("172.27.0.99");
  expect(admitNativeFollowupEndpoint("http://127.0.0.1:4883", "linux", null, []).hostname).toBe(
    "127.0.0.1",
  );
  for (const [url, platform, distro, hosts] of [
    ["http://172.27.0.99:4883", "linux", "OwnedDistro", ["172.27.0.99"]],
    ["http://172.27.0.99:4883", "win32", "OwnedDistro", ["172.27.0.98"]],
    ["http://198.51.100.1:4883", "win32", "OwnedDistro", ["198.51.100.1"]],
    ["http://user:secret@127.0.0.1:4883", "linux", null, []],
  ] as const)
    expect(() => admitNativeFollowupEndpoint(url, platform, distro, hosts)).toThrow();
});
