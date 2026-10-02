// @effect-diagnostics nodeBuiltinImport:off - Qualification contracts inspect checked-in YAML.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";

const path = NodePath.resolve(
  import.meta.dirname,
  "../.github/workflows/rpc-liveness-qualification.yml",
);
const source = NodeFS.readFileSync(path, "utf8");
const workflow = parseYaml(source) as {
  on: { push: { branches: Array<string> } };
  permissions: Record<string, string>;
  jobs: {
    qualification: {
      "runs-on": string;
      "timeout-minutes": number;
      steps: Array<{
        name: string;
        run?: string;
        if?: string;
        uses?: string;
        with?: Record<string, unknown>;
      }>;
    };
  };
};

function step(name: string) {
  const value = workflow.jobs.qualification.steps.find((item) => item.name === name);
  expect(value, name).toBeDefined();
  return value!;
}

describe("disposable RPC liveness qualification workflow", () => {
  it("runs only on its explicit evidence branch with read-only repository permissions", () => {
    expect(workflow.on).toEqual({ push: { branches: ["codex/qualify-issue39-linux"] } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["qualification"]);
    expect(workflow.jobs.qualification["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.jobs.qualification["timeout-minutes"]).toBe(120);
    expect(step("Checkout complete source history").with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
  });

  it("builds both source variants before load and restores the fixed test file", () => {
    const build = step("Build both versions before starting CPU contention").run ?? "";
    expect(build).toContain("git show 102691a329e84e7422348a44e192e560e57280fa:");
    expect(build).toContain("trap restore_fixed EXIT");
    expect(build).toContain("for phase in baseline fixed; do");
    expect(build).toContain("--no-run -j 2 --message-format=json");
    expect(build).toContain('cmp "$test_source" "$binary_dir/fixed-source.rs"');
    expect(build).not.toContain("docker");
    expect(build).not.toContain("sysctl");
    const names = workflow.jobs.qualification.steps.map((item) => item.name);
    expect(names.indexOf("Run paired native Linux qualification")).toBeGreaterThan(
      names.indexOf("Build both versions before starting CPU contention"),
    );
    expect(names.indexOf("Run paired native Linux qualification")).toBeGreaterThan(
      names.indexOf("Verify fixed controlled-clock observation and transport cases"),
    );
  });

  it("retains bounded evidence after success or failure without uploading binaries or fixtures", () => {
    const upload = step("Upload bounded qualification evidence");
    expect(upload.if).toBe("always()");
    expect(upload.with?.["retention-days"]).toBe(7);
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(upload.with?.path).toContain("issue39-evidence/baseline/*.json");
    expect(upload.with?.path).toContain("issue39-evidence/fixed/*.log");
    expect(upload.with?.path).not.toContain("binaries");
    expect(upload.with?.path).not.toContain("fixtures");
    expect(source).not.toContain("pull_request:");
  });
});
