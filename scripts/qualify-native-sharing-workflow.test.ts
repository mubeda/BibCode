// @effect-diagnostics nodeBuiltinImport:off - Read the CI contract without launching a native application.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as YAML from "yaml";
import { expect, it } from "vite-plus/test";
const workflow = () =>
  YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
      "utf8",
    ),
  );
const packagedWorkflow = () =>
  YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-ui-smoke.yml", import.meta.url),
      "utf8",
    ),
  );
it("runs actual SDK navigation and native cleanup regressions before packaged capture builds", () => {
  const steps = packagedWorkflow().jobs.native_sharing.steps;
  const admission = steps.findIndex(
    (step: { name: string }) => step.name === "Check native ownership and namespace admission",
  );
  const build = steps.findIndex(
    (step: { name: string }) => step.name === "Build guarded packaged native app",
  );
  expect(admission).toBeGreaterThanOrEqual(0);
  expect(build).toBeGreaterThan(admission);
  expect(steps[admission].run).toContain(
    "apps/desktop/e2e/support/release-visual-native-sharing-navigation.test.ts",
  );
  expect(steps[admission].run).toContain(
    "apps/desktop/e2e/support/release-visual-native-sharing-session.test.ts",
  );
});
it("runs the actual SDK client-viewport regression before packaged native sharing qualification", () => {
  const steps = packagedWorkflow().jobs.native_sharing.steps;
  const admission = steps.findIndex(
    (step: { name: string }) => step.name === "Check native ownership and namespace admission",
  );
  const capture = steps.findIndex(
    (step: { name: string }) => step.name === "Run contained native sharing scenes",
  );
  expect(admission).toBeGreaterThanOrEqual(0);
  expect(capture).toBeGreaterThan(admission);
  expect(steps[admission].run).toContain(
    "apps/desktop/e2e/support/release-visual-native-sharing-viewport.test.ts",
  );
  expect(steps[admission].run).toContain(
    "apps/desktop/e2e/support/release-visual-native-sharing-geometry.test.ts",
  );
});
it("validates native feature Rust contracts and warning-free targets before packaging", () => {
  const steps = packagedWorkflow().jobs.native_sharing.steps;
  const staticGate = steps.findIndex(
    (step: { name: string }) => step.name === "Required native static gates",
  );
  const rust = steps.findIndex(
    (step: { name: string }) => step.name === "Validate native desktop-e2e Rust geometry",
  );
  const build = steps.findIndex(
    (step: { name: string }) => step.name === "Build guarded packaged native app",
  );
  expect(rust).toBeGreaterThan(staticGate);
  expect(build).toBeGreaterThan(rust);
  expect(steps[rust].run.trim().split("\n")).toEqual([
    "cargo fmt --all --check",
    "cargo test --locked -p bibcode-desktop --lib --features desktop-e2e,bibcode-server/hermetic-test-guard -j 2",
    "cargo clippy --locked -p bibcode-desktop --all-targets --features desktop-e2e,bibcode-server/hermetic-test-guard -- -D warnings",
  ]);
});
it("admits a separate Linux packaged-app selection and skips the Chromium owner for it", () => {
  const value = workflow();
  expect(value.on.workflow_dispatch.inputs.scene_selection.options).toContain(
    "release-visual-native-sharing",
  );
  expect(value.jobs.native_sharing).toBeDefined();
  expect(value.jobs.native_sharing.if).toBe(
    "${{ github.ref_name != github.event.repository.default_branch && inputs.scene_selection == 'release-visual-native-sharing' }}",
  );
  expect(value.jobs.visual_core.if).toBe(
    "${{ github.ref_name != github.event.repository.default_branch && inputs.scene_selection != 'release-visual-native-sharing' && inputs.scene_selection != 'release-visual-native-followups' }}",
  );
  expect(value.jobs.native_sharing.uses).toBe("./.github/workflows/desktop-ui-smoke.yml");
  expect(value.jobs.native_sharing.with.native_sharing).toBe(true);
  const callee = packagedWorkflow();
  expect(callee.on.workflow_call.inputs.native_sharing.default).toBe(false);
  expect(callee.jobs.desktop_ui_smoke.if).toBe("${{ !inputs.native_sharing }}");
  expect(callee.jobs.native_sharing["runs-on"]).toBe("ubuntu-22.04");
});
it("builds the native embedded driver and guard, then passes only immutable AppImage/display inputs to PID1", () => {
  const job = packagedWorkflow().jobs.native_sharing;
  expect(job).toBeDefined();
  const build = job.steps.find(
    (step: { name: string }) => step.name === "Build guarded packaged native app",
  );
  expect(build["working-directory"]).toBe("apps/desktop");
  expect(build.env.VITE_BIBCODE_DESKTOP_E2E).toBe("1");
  expect(build.run).toContain("--features desktop-e2e,bibcode-server/hermetic-test-guard");
  expect(build.run).toContain("--target x86_64-unknown-linux-gnu");
  const run = job.steps.find(
    (step: { name: string }) => step.name === "Run contained native sharing scenes",
  );
  expect(run.run).toBe(
    "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-native-sharing",
  );
  expect(run.env.BIBCODE_NATIVE_SHARING_APP).toBe(
    "${{ runner.temp }}/issue29-native-build/BiBCode.AppImage",
  );
  expect(run.env.BIBCODE_DELIVERY_UI_WEB).toBeUndefined();
});
it("retains exactly four existing-row originals and eight closed receipts without private logs or wildcards", () => {
  const job = packagedWorkflow().jobs.native_sharing;
  expect(job).toBeDefined();
  const step = job.steps.find(
    (step: { name: string }) => step.name === "Retain explicit native sharing evidence",
  );
  const uploads = job.steps.filter((value: { uses?: string }) =>
    value.uses?.startsWith("actions/upload-artifact@"),
  );
  expect(uploads).toHaveLength(1);
  expect(
    packagedWorkflow().jobs.desktop_ui_smoke.steps.some(
      (value: { name: string }) => value.name === "Upload desktop UI screenshots and logs",
    ),
  ).toBe(true);
  expect(step.if).toBe("${{ always() }}");
  expect(step.with["if-no-files-found"]).toBe("error");
  const names = step.with.path
    .trim()
    .split("\n")
    .map((line: string) => line.slice(line.lastIndexOf("/") + 1));
  expect(names).toEqual([
    "phase.json",
    "failure.json",
    "provenance.json",
    "result.json",
    "assertions.json",
    "owned-cleanup.json",
    "namespace-cleanup.json",
    "supervisor.json",
    "native-share-no-route-light.png",
    "native-share-no-route-dark.png",
    "native-share-refresh-light.png",
    "native-share-refresh-dark.png",
  ]);
  expect(step.with.path).not.toMatch(/\*|private|\.log|profile/);
});
it.each(["owned", "symlink", "empty", "wrong-arch", "existing-target"])(
  "executes the actual immutable-input copy on inert bytes and preserves other files: %s",
  (mode) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-input-copy-"));
    const temporary = NodePath.join(root, "temporary"),
      build = NodePath.join(root, "target/x86_64-unknown-linux-gnu/release/bundle/appimage");
    NodeFS.mkdirSync(temporary, { mode: 0o700 });
    NodeFS.mkdirSync(build, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(root, "apps/desktop"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/desktop/package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );
    const app = NodePath.join(
      build,
      "BiBCode_1.2.3_" + (mode === "wrong-arch" ? "aarch64" : "amd64") + ".AppImage",
    );
    NodeFS.writeFileSync(app, mode === "empty" ? "" : "inert owned image bytes");
    if (mode === "symlink") {
      NodeFS.renameSync(app, NodePath.join(root, "other"));
      NodeFS.symlinkSync(NodePath.join(root, "other"), app);
    }
    const target = NodePath.join(temporary, "issue29-native-build");
    if (mode === "existing-target") {
      NodeFS.mkdirSync(target);
      NodeFS.writeFileSync(NodePath.join(target, "keep"), "unrelated bytes");
    }
    const copy = packagedWorkflow().jobs.native_sharing.steps.find(
      (step: { name: string }) => step.name === "Copy immutable native inputs",
    ).run;
    const script = copy.slice(copy.indexOf("\n") + 1, copy.lastIndexOf("PYTHON"));
    try {
      const result = NodeChildProcess.spawnSync("python3", ["-c", script], {
        cwd: root,
        env: { ...process.env, RUNNER_TEMP: temporary },
        encoding: "utf8",
      });
      expect(result.status === 0).toBe(mode === "owned");
      if (mode === "owned") {
        expect(NodeFS.readFileSync(NodePath.join(target, "BiBCode.AppImage"), "utf8")).toBe(
          "inert owned image bytes",
        );
        expect(NodeFS.statSync(target).mode & 0o777).toBe(0o700);
        expect(NodeFS.statSync(NodePath.join(target, "BiBCode.AppImage")).mode & 0o777).toBe(0o500);
      } else if (mode === "existing-target")
        expect(NodeFS.readFileSync(NodePath.join(target, "keep"), "utf8")).toBe("unrelated bytes");
      else expect(NodeFS.existsSync(target)).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
