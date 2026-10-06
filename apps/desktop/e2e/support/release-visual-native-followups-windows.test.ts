import { expect, it } from "vite-plus/test";
import {
  nativeFollowupWindowsAclScript,
  secureNativeFollowupWindowsRoot,
} from "./release-visual-native-followups-windows.ts";
it("refuses system, drive, network and unprotected Windows ACL boundaries", async () => {
  for (const path of [
    "C:\\",
    "C:\\Windows\\System32",
    "C:\\Program Files\\BiBCode",
    "\\\\server\\share",
    "/unix/faked-windows",
  ])
    expect(() => nativeFollowupWindowsAclScript(path)).toThrow();
  const owner = { command: async () => Buffer.from('{"privateBoundary":false,"entryCount":3}') };
  await expect(
    secureNativeFollowupWindowsRoot(owner as never, "owned.exe", "C:\\owned\\native-followups"),
  ).rejects.toThrow();
});
