// @effect-diagnostics nodeBuiltinImport:off - Inert fake listener lifecycle and temporary installation protection.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  withNativeFollowupInstallFailure,
  acquireNativeFollowupPortHold,
} from "./release-visual-native-followups-update.ts";

it("limits installer failure permission changes to its owned physical installation and restores them", async () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-install-failure-")),
  );
  try {
    const installed = NodePath.join(root, "installed");
    NodeFS.mkdirSync(installed, { mode: 0o700 });
    const app = NodePath.join(installed, "BiBCode.AppImage");
    NodeFS.writeFileSync(app, "immutable packaged executable", { mode: 0o500 });
    const original = new Error("original capture failure");
    await expect(
      withNativeFollowupInstallFailure(
        { laneRoot: root, app, platform: "linux", unsafe: () => {} },
        async () => {
          expect(NodeFS.statSync(installed).mode & 0o777).toBe(0o500);
          throw original;
        },
      ),
    ).rejects.toBe(original);
    expect(NodeFS.statSync(installed).mode & 0o777).toBe(0o700);
    expect(NodeFS.readFileSync(app, "utf8")).toBe("immutable packaged executable");
    await expect(
      withNativeFollowupInstallFailure(
        { laneRoot: installed, app, platform: "linux", unsafe: () => {} },
        async () => {},
      ),
    ).rejects.toThrow();
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("a port holder cannot report ready until the original listener has actually released the exact port", async () => {
  let count = 0;
  let closed = false;
  const hold = await acquireNativeFollowupPortHold({
    port: 4883,
    deadlineMs: 100,
    probe: async () => {
      count++;
      return count < 3
        ? null
        : {
            verify: async () => {},
            close: async () => {
              closed = true;
            },
          };
    },
    pause: async () => {},
  });
  expect(count).toBe(3);
  await hold.verify();
  await hold.close();
  expect(closed).toBe(true);
  await expect(
    acquireNativeFollowupPortHold({
      port: 3773,
      deadlineMs: 100,
      probe: async () => {
        throw new Error("should not bind");
      },
      pause: async () => {},
    }),
  ).rejects.toThrow();
});
it("joins a newly acquired holder when cancellation wins the admission race", async () => {
  const cancel = new AbortController();
  let closed = false;
  await expect(
    acquireNativeFollowupPortHold({
      port: 4883,
      deadlineMs: 100,
      signal: cancel.signal,
      pause: async () => {},
      probe: async () => {
        cancel.abort();
        return {
          verify: async () => {},
          close: async () => {
            closed = true;
          },
        };
      },
    }),
  ).rejects.toThrow("cancelled");
  expect(closed).toBe(true);
});
