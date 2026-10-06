// @effect-diagnostics nodeBuiltinImport:off - Static registration policy does not dispatch or activate the UI owner.
import * as NodeFS from "node:fs";
import * as YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";

const workflow = YAML.parse(
  NodeFS.readFileSync(
    new URL("../.github/workflows/qualify-release-ui.yml", import.meta.url),
    "utf8",
  ),
);

describe("controlled remote UI dispatch registration", () => {
  it("keeps the existing core/full matrix input and read-only permissions", () => {
    expect(workflow.name).toBe("Issue 16 controlled remote update UI");
    expect(workflow.on.workflow_dispatch.inputs).toEqual({
      matrix: {
        description: "Core feedback or the complete browser matrix",
        type: "choice",
        required: true,
        default: "core",
        options: ["core", "full"],
      },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("keeps stub and nominated-owner modes explicit without a default-branch automatic trigger", () => {
    const registration = workflow.jobs.registration_only;
    const owner = workflow.jobs.remote_ui;
    expect(Object.keys(workflow.jobs)).toEqual(
      owner && registration
        ? ["remote_ui", "registration_only"]
        : [registration ? "registration_only" : "remote_ui"],
    );
    const job = registration ?? workflow.jobs.remote_ui;
    for (const candidate of [registration, owner].filter(Boolean)) {
      expect(candidate.permissions).toBeUndefined();
      expect(candidate.strategy).toBeUndefined();
      expect(candidate["continue-on-error"]).toBeUndefined();
    }
    expect(job.permissions).toBeUndefined();
    if (owner && registration) {
      expect(registration.if).toBe(
        "${{ github.ref_name == github.event.repository.default_branch }}",
      );
      expect(owner.if).toBe("${{ github.ref_name != github.event.repository.default_branch }}");
    } else expect(job.if).toBeUndefined();
    expect(job.strategy).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    if (registration && !owner) {
      expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
      expect(job.env).toBeUndefined();
      expect(job.steps).toHaveLength(1);
    } else {
      expect(Object.keys(workflow.on)).toEqual(["push", "workflow_dispatch"]);
      expect(workflow.on.push).toEqual({ branches: ["codex/qualify-release-ui"] });
      expect(owner["runs-on"]).toBe("ubuntu-22.04");
      expect(owner["timeout-minutes"]).toBe(120);
      expect(owner.env).toEqual({
        CARGO_BUILD_JOBS: "2",
        CARGO_PROFILE_DEV_DEBUG: "0",
        BIBCODE_RELEASE_UI_MATRIX: "${{ inputs.matrix || 'core' }}",
      });
    }
  });

  it("refuses the stub or preserves the full source-bound guarded UI producer", () => {
    const registration = workflow.jobs.registration_only;
    const steps = (registration ?? workflow.jobs.remote_ui).steps;
    if (registration) {
      const refusal = steps[0];
      expect(refusal.uses).toBeUndefined();
      expect(refusal.env).toBeUndefined();
      expect(refusal.if).toBeUndefined();
      expect(refusal["continue-on-error"]).toBeUndefined();
      expect(refusal.shell).toBe("bash");
      expect(refusal.run.trim()).toBe(
        "printf '%s\\n' 'QUALIFICATION_REQUIRES_NOMINATED_QA_REF'\nexit 1",
      );
    }
    if (workflow.jobs.remote_ui) {
      const steps = workflow.jobs.remote_ui.steps;
      const checkout = steps.find((step: { uses?: string }) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkout.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
      expect(checkout.with.ref).toBeUndefined();
      expect(checkout.with["persist-credentials"]).toBe(false);
      const named = (name: string) => steps.find((step: { name?: string }) => step.name === name);
      expect(named("Check owned helpers and namespace admission").run).toContain(
        "python3 -B scripts/qualify-chat-uploads.py preflight",
      );
      expect(named("Required static gates").run).toContain("vp check");
      expect(named("Build guarded server and maintained interactive fake host").run).toBe(
        "cargo build -p bibcode-server --bin bibcode --example remote_update_fake_host --features hermetic-test-guard -j 2",
      );
      expect(named("Run contained remote update UI selection").run).toBe(
        'python3 -B scripts/qualify-chat-uploads.py --scenario remote-updates-ui --matrix "$BIBCODE_RELEASE_UI_MATRIX"',
      );
      const evidence = named("Retain explicit safe evidence");
      expect(evidence.if).toBe("always()");
      expect(evidence.uses).toBe(
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      );
      expect(evidence.with.name).toBe(
        "issue16-ui-${{ inputs.matrix || 'core' }}-${{ github.run_id }}-${{ github.run_attempt }}",
      );
      expect(evidence.with.path).not.toMatch(/\*|private|profile|\.log/);
      for (const receipt of [
        "phase.json",
        "failure.json",
        "provenance.json",
        "result.json",
        "assertions.json",
        "namespace-cleanup.json",
        "supervisor.json",
      ]) {
        expect(evidence.with.path).toContain(`/issue16-ui-\${{ github.run_id }}/${receipt}`);
      }
    }
  });
});
