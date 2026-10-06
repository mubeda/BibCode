import { expect, it } from "vite-plus/test";
import { withNativeFollowupsLinuxSession } from "./release-visual-native-followups-session.ts";
it("refuses a local or relabelled native session before launching any OS or browser work", async () => {
  let calls = 0;
  for (const input of [
    { environment: {}, platform: "linux", root: "/missing/private-session" },
    {
      environment: { CI: "true", GITHUB_ACTIONS: "true", DISPLAY: ":99" },
      platform: "darwin",
      root: "/missing/private-session",
    },
  ])
    await expect(
      withNativeFollowupsLinuxSession(input, async () => {
        calls++;
      }),
    ).rejects.toThrow();
  expect(calls).toBe(0);
});
