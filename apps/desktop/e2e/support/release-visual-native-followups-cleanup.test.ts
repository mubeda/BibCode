import { expect, it } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off - The actual cleanup callback executes only with inert filesystem/process ports.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { stopNativeFollowupApplication } from "./release-visual-native-followups-cleanup.ts";
it("cannot close any application when its real CI owner or private installed path is absent", async () => {
  await expect(
    stopNativeFollowupApplication({
      app: "/user/app",
      dataRoot: "/user/data",
      runRoot: "/other/fixture",
      platform: "linux",
      environment: {},
    }),
  ).rejects.toThrow("ownership");
  await expect(
    stopNativeFollowupApplication({
      app: "/user/app",
      dataRoot: "/user/data",
      runRoot: "/other/fixture",
      platform: "linux",
      environment: { CI: "true", GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "1" },
    }),
  ).rejects.toThrow("ownership");
});

it("refuses a foreign same-home AppImage before sending any cleanup signal", async () => {
  const source = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "release-visual-native-followups-cleanup.ts"),
    "utf8",
  );
  const start = source.indexOf("export async function stopNativeFollowupApplication");
  const original = new Error("Inert exact binding refusal.");
  let kills = 0;
  const fields = Array<string>(30).fill("0");
  fields[19] = "12345";
  const stop = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(start)).replace(
      "export async function",
      "async function",
    ) + "\nstopNativeFollowupApplication",
    {
      NodePath,
      NodeCrypto,
      NodeFS: {
        realpathSync: (path: string) => path,
        mkdirSync: () => {},
        writeFileSync: () => {},
        readdirSync: () => (kills ? [] : ["101"]),
        readlinkSync: () => "/tmp/.mount_foreign/usr/bin/bibcode-desktop",
        readFileSync: (path: string) =>
          path.endsWith("/environ")
            ? "BIBCODE_HOME=/owned/run/data\0"
            : path.endsWith("/cmdline")
              ? "/foreign/AppImage\0"
              : "101 (inert) " + fields.join(" "),
      },
      NodeProcess: {
        kill: () => {
          kills++;
        },
      },
      readNativeFollowupLinuxBinding: () => {
        throw original;
      },
      Date,
      setTimeout,
      Promise,
    },
  );
  await expect(
    stop({
      app: "/owned/run/installed/BiBCode.AppImage",
      dataRoot: "/owned/run/data",
      runRoot: "/owned/run",
      platform: "linux",
      environment: { CI: "true", GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "1" },
    }),
  ).rejects.toBe(original);
  expect(kills).toBe(0);
});
