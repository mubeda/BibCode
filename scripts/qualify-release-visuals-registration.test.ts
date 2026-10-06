// @effect-diagnostics nodeBuiltinImport:off - Static registration policy never dispatches or starts the qualification runtime.
import * as NodeFS from "node:fs";
import * as YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";

const workflow = YAML.parse(
  NodeFS.readFileSync(
    new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
    "utf8",
  ),
);

describe("visual qualification dispatch registration", () => {
  it("registers manual dispatch with closed fixed scene choices for the current mode", () => {
    expect(workflow.name).toBe("First release visual batch (manual preparation lane)");
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["scene_selection"]);
    const { options: declaredChoices, ...definition } =
      workflow.on.workflow_dispatch.inputs.scene_selection;
    expect(definition).toEqual({
      description: "Fixed visual preparation selection",
      type: "choice",
      required: true,
      default: "release-visual-core",
    });
    const choices = declaredChoices as string[];
    const baseline = [
      "release-visual-core",
      "release-visual-settings",
      "release-visual-git-project",
    ];
    if (!workflow.jobs.visual_core) expect(choices).toEqual(baseline);
    else {
      expect(choices.slice(0, 3)).toEqual(baseline);
      expect(new Set(choices).size).toBe(choices.length);
      for (const choice of choices)
        expect([
          ...baseline,
          "release-visual-cursor-question",
          "release-visual-workspace-substates",
          "release-visual-provider-chat",
          "release-visual-native-sharing",
          "release-visual-project-lifecycle",
        ]).toContain(choice);
    }
  });

  it("keeps both workflow versions read-only and requires one explicit mode", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    const registration = workflow.jobs.registration_only;
    const owner = workflow.jobs.visual_core;
    if (registration && !owner) expect(Object.keys(workflow.jobs)).toEqual(["registration_only"]);
    else {
      expect(Object.keys(workflow.jobs)).toContain("visual_core");
      for (const key of Object.keys(workflow.jobs))
        expect(["visual_core", "registration_only", "native_sharing"]).toContain(key);
    }
    const job = registration ?? workflow.jobs.visual_core;
    for (const candidate of [registration, owner, workflow.jobs.native_sharing].filter(Boolean)) {
      expect(candidate.permissions).toBeUndefined();
      expect(candidate.strategy).toBeUndefined();
      expect(candidate["continue-on-error"]).toBeUndefined();
    }
    expect(job.permissions).toBeUndefined();
    expect(job.strategy).toBeUndefined();
    if (registration) {
      expect(job.env).toBeUndefined();
      expect(job.steps).toHaveLength(1);
      expect(job.steps[0].uses).toBeUndefined();
      expect(job.steps[0].env).toBeUndefined();
    }
    if (owner) {
      expect(owner["runs-on"]).toBe("ubuntu-22.04");
      expect(owner["timeout-minutes"]).toBe(120);
      expect(owner.env).toEqual({ CARGO_BUILD_JOBS: "2", CARGO_PROFILE_DEV_DEBUG: "0" });
    }
  });

  it("refuses the registration stub or preserves the nominated ref's full owner gates", () => {
    const registration = workflow.jobs.registration_only;
    const job = registration ?? workflow.jobs.visual_core;
    if (registration && workflow.jobs.visual_core) {
      expect(registration.if).toBe(
        "${{ github.ref_name == github.event.repository.default_branch }}",
      );
      expect(workflow.jobs.visual_core.if).toContain(
        "github.ref_name != github.event.repository.default_branch",
      );
    } else expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    if (registration) {
      const refusal = job.steps[0];
      expect(refusal.if).toBeUndefined();
      expect(refusal["continue-on-error"]).toBeUndefined();
      expect(refusal.shell).toBe("bash");
      expect(refusal.run.trim()).toBe(
        "printf '%s\\n' 'QUALIFICATION_REQUIRES_NOMINATED_QA_REF'\nexit 1",
      );
    }
    if (workflow.jobs.visual_core) {
      const steps = workflow.jobs.visual_core.steps as Array<{
        name?: string;
        uses?: string;
        run?: string;
        if?: string;
        with?: { ref?: string; "persist-credentials"?: boolean; "if-no-files-found"?: string };
      }>;
      const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
      expect(checkout.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
      expect(checkout.with?.ref).toBeUndefined();
      expect(checkout.with?.["persist-credentials"]).toBe(false);
      const admission = steps.find(
        (step) => step.name === "Check owned helpers and namespace admission",
      )!;
      expect(admission.run).toContain("python3 -B scripts/qualify-chat-uploads.py preflight");
      expect(admission.run).toContain("scripts/qualify-release-visuals-workflow.test.ts");
      expect(steps.find((step) => step.name === "Build guarded production CLI")?.run).toBe(
        "cargo build -p bibcode-server --bin bibcode --features hermetic-test-guard -j 2",
      );
      const selections = [
        ["Run contained first visual batch", "release-visual-core"],
        ["Run contained settings visual batch", "release-visual-settings"],
        ["Run contained Git/project visual batch", "release-visual-git-project"],
      ];
      for (const [name, selection] of selections) {
        const run = steps.find((step) => step.name === name)!;
        expect(run.run).toBe(`python3 -B scripts/qualify-chat-uploads.py --scenario ${selection}`);
        expect(run.if).toBe(
          selection === "release-visual-core"
            ? "${{ inputs.scene_selection == 'release-visual-core' || inputs.scene_selection == '' }}"
            : `\${{ inputs.scene_selection == '${selection}' }}`,
        );
      }
      const evidence = steps.filter((step) => step.name?.startsWith("Retain explicit"));
      expect(evidence.length).toBeGreaterThanOrEqual(3);
      for (const step of evidence) {
        expect(step.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
        expect(step.with?.["if-no-files-found"]).toBe("error");
      }
    }
  });
});
