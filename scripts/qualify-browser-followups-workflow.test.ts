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
it("checks the native origin and matching pairing profile before the split-origin browser fixture", () => {
  const steps = workflow.jobs.visual_core.steps;
  const gate = steps.find(
    (step: { name?: string }) => step.name === "Verify cookie origin and pairing profile contracts",
  );
  expect(gate.if).toBe("${{ inputs.scene_selection == 'release-visual-browser-followups' }}");
  expect(gate.run.trim().split("\n")).toEqual([
    "cargo test -p bibcode-server --lib auth::http::tests::cookie_origin_matches_host_or_the_dev_origin -j 2 -- --exact",
    "cargo test -p bibcode-server --lib config::tests::pairing_commands_preserve_dev_url_and_select_the_matching_state -j 2 -- --exact",
  ]);
  expect(steps.indexOf(gate)).toBeLessThan(
    steps.findIndex((step: { name?: string }) => step.name === "Build guarded production CLI"),
  );
});
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
  expect(Object.keys(run.env).sort()).toEqual([
    "BIBCODE_DELIVERY_UI_WEB",
    "BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256",
    "BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI",
    "BIBCODE_IMPORT_EVIDENCE_SELECTED",
    "BIBCODE_UPLOAD_SERVER",
  ]);
});
it("keeps private import evidence optional and publishes only the encrypted envelope", () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(inputs.import_evidence_public_spki.default).toBe("");
  expect(inputs.import_evidence_public_sha256.default).toBe("");
  const step = workflow.jobs.visual_core.steps.find(
    (value: { name?: string }) => value.name === "Retain optional encrypted import failure",
  );
  expect(step.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(step.if).toContain("inputs.scene_selection == 'release-visual-browser-followups'");
  expect(step.if).toContain("inputs.import_evidence_public_spki != ''");
  expect(step.if).toContain("inputs.import_evidence_public_sha256 != ''");
  expect(step.with["if-no-files-found"]).toBe("ignore");
  expect(
    step.with.path
      .trim()
      .split("\n")
      .map((value: string) => value.slice(value.lastIndexOf("/") + 1)),
  ).toEqual([
    "context.json",
    "reply.aesgcm.bin",
    "key.rsa-oaep-sha256.bin",
    "nonce.bin",
    "tag.bin",
  ]);
  expect(step.with.path).not.toMatch(/\.log|\.pem|\*/);
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

it("runs every fixed-endpoint browser composition file with exclusive file ownership", () => {
  const steps = workflow.jobs.visual_core.steps;
  const browser = steps.find(
    (step: { name?: string }) =>
      step.name === "Verify browser follow-up composition and current public controls",
  );
  expect(browser.if).toBe("${{ inputs.scene_selection == 'release-visual-browser-followups' }}");
  const command = browser.run.trim().split(/\s+/);
  expect(command.slice(0, 4)).toEqual(["vp", "test", "run", "--no-file-parallelism"]);
  expect(command.slice(4)).toEqual([
    "apps/desktop/e2e/support/release-visual-browser-followups-caller.test.ts",
    "apps/desktop/e2e/support/release-visual-browser-followups-caller-resources.test.ts",
    "apps/desktop/e2e/support/release-visual-browser-followups-caller-protocol.test.ts",
    "apps/desktop/e2e/support/release-visual-browser-followups-owner.test.ts",
    "apps/desktop/e2e/support/release-visual-browser-followups-producer.test.ts",
    "apps/desktop/e2e/support/release-visual-browser-followups-protocol.test.ts",
    "apps/desktop/e2e/support/release-visual-browser-followups-transport.test.ts",
    "apps/desktop/e2e/support/ci-import-private-evidence.test.ts",
    "apps/desktop/e2e/support/release-visual-import-evidence.test.ts",
    "apps/desktop/e2e/support/release-visual-import-evidence.integration.test.ts",
    "scripts/throttle-proxy.test.ts",
    "scripts/build-browser-followup-ui.test.mjs",
    "apps/desktop/e2e/support/release-visual-browser-followups-wiring.test.ts",
    "scripts/qualify-browser-followups-workflow.test.ts",
  ]);
  expect(
    steps
      .filter((step: { run?: string }) => step.run?.includes("--no-file-parallelism"))
      .map((step: { name: string }) => step.name),
  ).toEqual(["Verify browser follow-up composition and current public controls"]);
});
