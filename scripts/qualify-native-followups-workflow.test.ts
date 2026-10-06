// @effect-diagnostics nodeBuiltinImport:off - Static workflow and inert fixed-input policy tests never launch an OS or application.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as YAML from "yaml";
import { expect, it } from "vite-plus/test";
import {
  nativeFollowupWorkflowPlan,
  nativeFollowupWorkflowStatus,
} from "./qualify-native-followups-workflow.ts";
import { parseSeededDesktopUpgradeSmokeArgs } from "./seeded-desktop-upgrade-smoke.ts";
const root = NodePath.resolve(".");
const args = [
  "--native-followups",
  "--platform",
  "linux",
  "--arch",
  "x64",
  "--bundle",
  "appimage",
  "--candidate-version",
  "0.8.1-native.1",
  "--previous-tag",
  "v0.8.0",
  "--previous-version",
  "0.8.0",
  "--public-key-file",
  NodePath.resolve("/owned/key.pub"),
  "--run-id",
  "owned-1",
  "--work-root",
  NodePath.resolve("/owned/work"),
  "--artifact-dir",
  NodePath.resolve("/owned/evidence"),
  "--updater-port",
  "43120",
  "--restart-timeout-ms",
  "180000",
];
it("binds only the selected nonroot Linux or real Windows WSL owner and fixed scope", () => {
  const input = parseSeededDesktopUpgradeSmokeArgs(args, root),
    host = { CI: "true", actions: "true", platform: "linux", uid: 1000, sourceSha: "a".repeat(40) };
  expect(nativeFollowupWorkflowPlan(input, host)).toEqual({
    partition: "linux-menu-update",
    expectedOriginals: 6,
  });
  for (const value of [
    { ...host, uid: 0 },
    { ...host, CI: undefined },
    { ...host, platform: "darwin" },
  ])
    expect(() => nativeFollowupWorkflowPlan(input, value)).toThrow();
  expect(() => nativeFollowupWorkflowPlan({ ...input, nativeFollowups: false }, host)).toThrow();
  expect(
    nativeFollowupWorkflowPlan(
      { ...input, platform: "win", bundle: "nsis", wsl: true },
      { ...host, platform: "win32", uid: null },
    ),
  ).toEqual({ partition: "windows-wsl", expectedOriginals: 2 });
  expect(() =>
    nativeFollowupWorkflowPlan(
      { ...input, platform: "win", bundle: "nsis", wsl: false },
      { ...host, platform: "win32", uid: null },
    ),
  ).toThrow();
});
it("never describes an unavailable or partial partition as group acceptance", () => {
  expect(
    nativeFollowupWorkflowStatus("a".repeat(40), "windows-wsl", "unavailable", 0),
  ).toMatchObject({
    status: "unavailable",
    originalCount: 0,
    previewOriginalCount: 0,
    completeGroup: false,
  });
  expect(() =>
    nativeFollowupWorkflowStatus("a".repeat(40), "windows-wsl", "partition-complete", 0),
  ).toThrow();
  expect(
    nativeFollowupWorkflowStatus("a".repeat(40), "linux-menu-update", "partition-complete", 6),
  ).toMatchObject({ completeGroup: false, previewOriginalCount: 0, visualReview: "pending" });
});
it("preserves the normal matrix/default lanes and binds finite native evidence through the existing owner", () => {
  const upgrade = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ),
  );
  expect(upgrade.on.workflow_call.inputs.native_followups.default).toBe(false);
  expect(upgrade.jobs.seeded_upgrade_smoke.strategy.matrix.include).toHaveLength(6);
  expect(upgrade.jobs.seeded_upgrade_smoke["timeout-minutes"]).toBe(
    "${{ matrix.jobTimeoutMinutes }}",
  );
  const linux = upgrade.jobs.native_followups_linux;
  expect(linux.runsOn ?? linux["runs-on"]).toBe("ubuntu-22.04");
  expect(linux["timeout-minutes"]).toBe(240);
  const commands = linux.steps.map((step: { run?: string }) => step.run ?? "").join("\n");
  expect(commands).toContain("-screen 0 1280x960x24 -dpi 96");
  expect(commands).toContain("--native-followups --platform linux --arch x64 --bundle appimage");
  expect(commands).toContain("--restart-timeout-ms 180000");
  expect(commands).not.toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.");
  const artifact = linux.steps.find(
    (step: { name: string }) =>
      step.name === "Retain finite native Linux originals and closed status",
  );
  const names = artifact.with.path
    .split("\n")
    .filter(Boolean)
    .map((line: string) => line.slice(line.lastIndexOf("/") + 1));
  expect(names).toHaveLength(10);
  expect(names.filter((name: string) => name.endsWith(".png"))).toHaveLength(6);
  expect(names).not.toContain("native-preview-annotations-light.png");
  expect(artifact.with.path).not.toMatch(/\*|\.log|private|sign/);
  const win = upgrade.jobs.windows_wsl_upgrade_smoke;
  expect(win["timeout-minutes"]).toBe(240);
  expect(
    win.steps.some(
      (step: { name: string; if?: string }) =>
        step.name === "Record native WSL prerequisite unavailable" &&
        step.if?.includes("inputs.native_followups == true"),
    ),
  ).toBe(true);
  const visual = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
      "utf8",
    ),
  );
  expect(visual.jobs.native_followups.uses).toBe("./.github/workflows/desktop-upgrade-smoke.yml");
  expect(visual.jobs.native_followups.with.native_followups).toBe(true);
  expect(visual.jobs.native_followups.if).toContain("github.event.repository.default_branch");
});
