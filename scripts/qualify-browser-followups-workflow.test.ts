// @effect-diagnostics nodeBuiltinImport:off - Static workflow and current fixed-row policy only; no dispatch or product execution.
import * as NodeFS from "node:fs";
import * as YAML from "yaml";
import { it, expect } from "vite-plus/test";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
const rowSource = NodeFS.readFileSync(
  new URL("../apps/desktop/e2e/support/release-visual-browser-followups.ts", import.meta.url),
  "utf8",
);
const browserFollowupScenes = NodeVM.runInNewContext(
  NodeModule.stripTypeScriptTypes(
    rowSource.slice(
      rowSource.indexOf("export const browserFollowupRows ="),
      rowSource.indexOf("export type BrowserFollowupRow ="),
    ),
  ).replace(/^export /gm, "") + "\nbrowserFollowupScenes",
) as readonly string[];
const workflow = YAML.parse(
  NodeFS.readFileSync(
    new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
    "utf8",
  ),
);
it("registers only the fixed browser selection and contained scalar owner", () => {
  const choices = workflow.on.workflow_dispatch.inputs.scene_selection.options;
  expect(
    choices.filter((value: string) => value === "release-visual-browser-followups"),
  ).toHaveLength(1);
  expect(workflow.permissions).toEqual({ contents: "read" });
  const steps = workflow.jobs.visual_core.steps,
    run = steps.find(
      (step: { run?: string }) =>
        step.run ===
        "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-browser-followups",
    );
  expect(run.if).toBe("${{ inputs.scene_selection == 'release-visual-browser-followups' }}");
  expect(Object.keys(run.env).sort()).toEqual(["BIBCODE_DELIVERY_UI_WEB", "BIBCODE_UPLOAD_SERVER"]);
});
it("builds two fresh immutable current-source modes and preserves guarded Rust", () => {
  const steps = workflow.jobs.visual_core.steps,
    build = steps.find((step: { run?: string }) =>
      step.run?.includes("build-browser-followup-ui.mjs --build primary"),
    );
  expect(build.if).toBe("${{ inputs.scene_selection == 'release-visual-browser-followups' }}");
  expect(build.run).toContain(
    'node scripts/build-browser-followup-ui.mjs --build hosted "$RUNNER_TEMP/issue29-browser-build" "$GITHUB_SHA"',
  );
  expect(
    steps.find((step: { name?: string }) => step.name === "Build guarded production CLI").run,
  ).toBe("cargo build -p bibcode-server --bin bibcode --features hermetic-test-guard -j 2");
});
it("publishes only seven closed receipts and the fourteen exact source-bound originals", () => {
  const step = workflow.jobs.visual_core.steps.find((value: { with?: { name?: string } }) =>
    value.with?.name?.startsWith("issue29-browser-followups-"),
  );
  expect(step.if).toBe(
    "${{ always() && inputs.scene_selection == 'release-visual-browser-followups' }}",
  );
  expect(step.with["if-no-files-found"]).toBe("error");
  expect(step.with["retention-days"]).toBe(7);
  const names = step.with.path
    .trim()
    .split(/\n/)
    .map((path: string) => path.slice(path.lastIndexOf("/") + 1));
  expect(names).toHaveLength(21);
  expect(new Set(names).size).toBe(21);
  expect(names.filter((name: string) => name.endsWith(".png")).sort()).toEqual(
    browserFollowupScenes.flatMap((scene) => [scene + "-light.png", scene + "-dark.png"]).sort(),
  );
  expect(names.filter((name: string) => !name.endsWith(".png")).sort()).toEqual(
    [
      "phase.json",
      "failure.json",
      "provenance.json",
      "result.json",
      "assertions.json",
      "namespace-cleanup.json",
      "supervisor.json",
    ].sort(),
  );
  expect(step.with.path).not.toMatch(/[?*]/);
});
