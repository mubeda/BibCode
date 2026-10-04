// @effect-diagnostics nodeBuiltinImport:off - Static policy checks never dispatch the preparation workflow.
import * as NodeFS from "node:fs";
import * as YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
const visualScenes = [
  "workspace-composite",
  "workspace-card-menu",
  "worktree-create-ref",
  "git-changes-diff",
  "git-history-stashes",
  "git-branch-menu",
  "files-editor-comment",
  "command-palette",
];

describe("first visual batch workflow boundary", () => {
  it("retains only the separate eight settings originals and the same seven closed receipts", () => {
    const value = YAML.parse(
      NodeFS.readFileSync(
        new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
        "utf8",
      ),
    );
    const steps = value.jobs.visual_core.steps as Array<{
      name: string;
      if?: string;
      run?: string;
      uses?: string;
      with?: { path?: string; name?: string };
    }>;
    const run = steps.find((step) => step.name === "Run contained settings visual batch")!;
    expect(run.run).toBe(
      "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-settings",
    );
    expect(run.if).toBe("${{ inputs.scene_selection == 'release-visual-settings' }}");
    const evidence = steps.find((step) => step.name === "Retain explicit settings evidence")!;
    expect(evidence.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(evidence.with!.name).toBe(
      "issue29-settings-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(
      evidence
        .with!.path!.trim()
        .split("\n")
        .map((line) => line.slice(line.lastIndexOf("/") + 1)),
    ).toEqual([
      "phase.json",
      "failure.json",
      "provenance.json",
      "result.json",
      "assertions.json",
      "namespace-cleanup.json",
      "supervisor.json",
      "settings-provider-form-light.png",
      "settings-provider-form-dark.png",
      "model-picker-light.png",
      "model-picker-dark.png",
      "settings-keybindings-light.png",
      "settings-keybindings-dark.png",
      "settings-source-control-light.png",
      "settings-source-control-dark.png",
    ]);
    expect(evidence.with!.path).not.toMatch(/\*|private|profile|\.log|core-/);
    expect(steps.find((step) => step.name === "Run contained first visual batch")!.if).toBe(
      "${{ inputs.scene_selection == 'release-visual-core' || inputs.scene_selection == '' }}",
    );
    expect(
      steps.some((step) =>
        step.run?.includes(
          "cargo build -p bibcode-server --bin bibcode --features hermetic-test-guard -j 2",
        ),
      ),
    ).toBe(true);
  });
  it("offers only core, fixed settings and Git/project selections with core as its default", () => {
    const value = YAML.parse(
      NodeFS.readFileSync(
        new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(value.on.workflow_dispatch).toEqual({
      inputs: {
        scene_selection: {
          description: "Fixed visual preparation selection",
          type: "choice",
          required: true,
          default: "release-visual-core",
          options: ["release-visual-core", "release-visual-settings", "release-visual-git-project"],
        },
      },
    });
  });
  it("has no automatic trigger and retains only the fixed sixteen originals and closed receipts", () => {
    const path = new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url);
    expect(NodeFS.existsSync(path)).toBe(true);
    const value = YAML.parse(NodeFS.readFileSync(path, "utf8"));
    expect(Object.keys(value.on)).toEqual(["workflow_dispatch"]);
    const steps = value.jobs.visual_core.steps as Array<{
      name?: string;
      run?: string;
      uses?: string;
      with?: { path?: string };
    }>;
    expect(steps.find((entry) => entry.name === "Run contained first visual batch")?.run).toBe(
      "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-core",
    );
    const evidence = steps.find((entry) => entry.name === "Retain explicit safe evidence")!;
    expect(evidence.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    const filenames = evidence
      .with!.path!.trim()
      .split("\n")
      .map((line) => line.slice(line.lastIndexOf("/") + 1));
    expect(filenames).toEqual([
      "phase.json",
      "failure.json",
      "provenance.json",
      "result.json",
      "assertions.json",
      "namespace-cleanup.json",
      "supervisor.json",
      ...visualScenes.flatMap((scene) => [`${scene}-light.png`, `${scene}-dark.png`]),
    ]);
    expect(evidence.with!.path).not.toMatch(/\*|private|profile|\.log/);
    const gate = steps.find(
      (entry) => entry.name === "Check owned helpers and namespace admission",
    )!.run!;
    for (const name of [
      "release-visual-fixture",
      "release-visual-core",
      "release-visual-evidence",
      "release-visual-observation",
      "release-visual-boundaries",
      "delivery-retry-workspace",
      "delivery-retry-controller",
      "delivery-import-observation",
    ])
      expect(gate).toContain(`support/${name}.test.ts`);
  });
});

it("retains the fixed partial Git/project lane identically in canonical and TEMP workflows", () => {
  const scenes = [
    "worktree-discovery",
    "project-open-directory",
    "project-clone-chooser",
    "project-clone-incomplete",
    "git-tags",
    "git-switch-with-changes",
    "git-merge-conflict",
    "git-rewrite-preview",
    "git-unborn",
    "git-no-repository",
    "git-broken-recovery",
  ];
  const read = (name: string) =>
    YAML.parse(
      NodeFS.readFileSync(new URL("../.github/workflows/" + name, import.meta.url), "utf8"),
    );
  const canonical = read("qualify-release-visuals.yml"),
    temporary = read("desktop-upgrade-smoke.yml");
  expect(temporary).toEqual(canonical);
  expect(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ).startsWith("# TEMPORARY QA alias: restore/exclude before final issue integration.\n"),
  ).toBe(true);
  const steps = canonical.jobs.visual_core.steps;
  const run = steps.find(
    (step: { name: string }) => step.name === "Run contained Git/project visual batch",
  );
  expect(run.if).toBe("${{ inputs.scene_selection == 'release-visual-git-project' }}");
  expect(run.run).toBe(
    "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-git-project",
  );
  const evidence = steps.find(
    (step: { name: string }) => step.name === "Retain explicit Git/project evidence",
  );
  expect(evidence.if).toBe(
    "${{ always() && inputs.scene_selection == 'release-visual-git-project' }}",
  );
  expect(
    evidence.with.path
      .trim()
      .split("\n")
      .map((line: string) => line.slice(line.lastIndexOf("/") + 1)),
  ).toEqual([
    "phase.json",
    "failure.json",
    "provenance.json",
    "result.json",
    "assertions.json",
    "namespace-cleanup.json",
    "supervisor.json",
    ...scenes.flatMap((scene) => [scene + "-light.png", scene + "-dark.png"]),
  ]);
  expect(evidence.with.path).not.toMatch(/\*/);
});
