import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import { planPackagedDesktopUiBuild } from "../apps/desktop/e2e/support/build-packaged-app.ts";

const plan = planPackagedDesktopUiBuild({ platform: "linux", arch: "x64" });
const desktopDirectory = NodePath.resolve(import.meta.dirname, "../apps/desktop");
const cli = NodePath.join(desktopDirectory, "node_modules/@tauri-apps/cli/tauri.js");
const tauriIndex = plan.args.indexOf("tauri");
if (tauriIndex < 0 || plan.args[tauriIndex + 1] !== "build" || !NodeFS.existsSync(cli)) {
  throw new Error("The maintained build plan or pinned workspace Tauri CLI is unavailable.");
}
// setup-vp exposes its package manager inside package tasks; this standalone
// adapter invokes the already-installed CLI directly and preserves the plan.
const args = [cli, ...plan.args.slice(tauriIndex + 1), "--debug"];
args[args.indexOf("--features") + 1] = "desktop-e2e,bibcode-server/hermetic-test-guard";
const output = NodePath.join(process.env.RUNNER_TEMP, "issue28-evidence");
NodeFS.mkdirSync(output, { recursive: true, mode: 0o700 });
NodeFS.writeFileSync(
  NodePath.join(output, "build.json"),
  JSON.stringify(
    { source: process.env.GITHUB_SHA, kind: "debug packaged AppImage", args },
    null,
    2,
  ),
);
const child = NodeChildProcess.spawnSync(process.execPath, args, {
  cwd: desktopDirectory,
  env: { ...process.env, ...plan.environment },
  stdio: "inherit",
  shell: false,
});
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
