// @effect-diagnostics nodeBuiltinImport:off - Static policy checks never dispatch the preparation workflow.
import * as NodeFS from "node:fs";
import * as YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
const visualScenes = [
  "workspace-composite",
  "workspace-card-menu",
  "worktree-create-ref",
  "git-image-diff",
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
  it("offers core, fixed settings, Git/project and the dedicated Cursor row with core as its default", () => {
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
          options: [
            "release-visual-core",
            "release-visual-settings",
            "release-visual-git-project",
            "release-visual-cursor-question",
          ],
        },
      },
    });
  });
  it("has no automatic trigger and retains only the fixed eighteen originals and closed receipts", () => {
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
      "release-visual-core-image",
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

it("retains the fixed partial Git/project lane separately from native upgrade qualification", () => {
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
  const canonical = read("qualify-release-visuals.yml");
  const upgrade = read("desktop-upgrade-smoke.yml");
  expect(Object.keys(upgrade.jobs)).toEqual(["seeded_upgrade_smoke", "windows_wsl_upgrade_smoke"]);
  expect(upgrade.jobs.visual_core).toBeUndefined();
  expect(upgrade.jobs.seeded_upgrade_smoke.strategy.matrix.include).toHaveLength(6);
  expect(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ).includes("TEMPORARY QA alias"),
  ).toBe(false);
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

it("runs one separate Cursor row with the actual inert-runtime gate and closed two-original evidence", () => {
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
    with?: { path?: string };
    env?: Record<string, string>;
  }>;
  const run = steps.find((step) => step.name === "Run contained Cursor later-question pair")!;
  expect(run.if).toBe("${{ inputs.scene_selection == 'release-visual-cursor-question' }}");
  expect(run.run).toBe(
    "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-cursor-question",
  );
  expect(run.env).toEqual({
    BIBCODE_UPLOAD_SERVER: "${{ runner.temp }}/issue29-visual-build/bibcode",
    BIBCODE_DELIVERY_UI_WEB: "${{ runner.temp }}/issue29-visual-build/web",
  });
  const replay = steps.find(
    (step) => step.name === "Verify inert Cursor runtime question protocol",
  )!;
  expect(replay.if).toBe(run.if);
  expect(replay.run).toContain(
    "provider::cursor::runtime::tests::owned_later_question_keeps_multiple_labels_and_original_prompt_correlation",
  );
  expect(replay.run).toContain("-- --exact");
  const evidence = steps.find((step) => step.name === "Retain explicit Cursor question evidence")!;
  expect(evidence.if).toBe(
    "${{ always() && inputs.scene_selection == 'release-visual-cursor-question' }}",
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
    "question-multiselect-light.png",
    "question-multiselect-dark.png",
  ]);
  expect(evidence.with!.path).not.toMatch(/\*|private|profile|\.log/);
  expect(value.jobs.visual_core["timeout-minutes"]).toBe(120);
  expect(visualScenes).toHaveLength(9);
  const tests = steps.find(
    (step) => step.name === "Check owned helpers and namespace admission",
  )!.run!;
  for (const helper of [
    "git-project-tab-interception",
    "owned-visual-capture",
    "release-visual-cursor-question",
    "release-visual-cursor-question-fixture",
  ])
    expect(tests).toContain("support/" + helper + ".test.ts");
});
