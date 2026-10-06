// @effect-diagnostics nodeBuiltinImport:off - Static policy checks never dispatch the preparation workflow.
import * as NodeFS from "node:fs";
import * as YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
const requestSource = NodeFS.readFileSync(
  new URL("../apps/desktop/e2e/support/release-visual-pull-requests.ts", import.meta.url),
  "utf8",
);
const pullRequestsCaptureBindings: Array<{ file: string }> = NodeVM.runInNewContext(
  NodeModule.stripTypeScriptTypes(
    requestSource.slice(
      requestSource.indexOf("export const pullRequestsVisualRows"),
      requestSource.indexOf("export interface PullRequestsExpectedHostContext"),
    ),
  ).replace(/^export /gm, "") + "\npullRequestsCaptureBindings",
);
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
  it("executes the real Classic selector regression in the existing lifecycle helper gate", () => {
    const workflow = NodeFS.readFileSync(
      new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
      "utf8",
    );
    const line = workflow
      .split("\n")
      .find(
        (value) =>
          value.trim().startsWith("vp test run ") &&
          value.includes("release-visual-project-lifecycle-wiring.test.ts"),
      );
    expect(line).toContain("apps/desktop/e2e/support/release-visual-classic-selectors.test.ts");
    const lifecycle = NodeFS.readFileSync(
      new URL(
        "../apps/desktop/e2e/support/release-visual-project-lifecycle.test.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(lifecycle).toContain("attachLifecycleSelectorPort");
    expect(lifecycle).toContain('import { attach } from "webdriverio"');
  });

  it("dispatches the exact contained PR selector and finite source-bound originals", () => {
    const value = YAML.parse(
      NodeFS.readFileSync(
        new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(value.on.workflow_dispatch.inputs.scene_selection.options).toContain(
      "release-visual-pull-requests",
    );
    const steps = value.jobs.visual_core.steps;
    const run = steps.find(
        (step: { name: string }) => step.name === "Run contained PR/MR visual batch",
      ),
      evidence = steps.find(
        (step: { name: string }) => step.name === "Retain explicit PR/MR evidence",
      );
    expect(run.if).toBe("${{ inputs.scene_selection == 'release-visual-pull-requests' }}");
    expect(run.run).toBe(
      "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-pull-requests",
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
      ...pullRequestsCaptureBindings.map((binding) => binding.file),
    ]);
    expect(evidence.with.path).not.toMatch(/\*|private|profile|\.log/);
  });
  it("checks supported descriptor capabilities on the real Linux server before dependent captures", () => {
    const value = YAML.parse(
      NodeFS.readFileSync(
        new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
        "utf8",
      ),
    );
    const steps = value.jobs.visual_core.steps as Array<{
      name?: string;
      if?: string;
      run?: string;
    }>;
    const gate = steps.find((step) => step.name === "Verify native server descriptor parity");
    expect(gate?.if).toBe(
      "${{ inputs.scene_selection == 'release-visual-project-lifecycle' || inputs.scene_selection == 'release-visual-settings-followups' || inputs.scene_selection == 'release-visual-pull-requests' }}",
    );
    expect(gate?.run?.trim().split("\n")).toEqual([
      "cargo fmt --all --check",
      "cargo test -p bibcode-server --test server_runtime -j 2",
      "cargo clippy -p bibcode-server --all-targets -j 2 -- -D warnings",
    ]);
    expect(steps.indexOf(gate!)).toBeLessThan(
      steps.findIndex((step) => step.name === "Build guarded production CLI"),
    );
  });
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
            "release-visual-workspace-substates",
            "release-visual-provider-chat",
            "release-visual-native-sharing",
            "release-visual-project-lifecycle",
            "release-visual-settings-followups",
            "release-visual-pull-requests",
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

it("binds the four Settings follow-up rows to exactly eighteen originals and seven closed receipts", () => {
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
    env?: Record<string, string>;
    with?: { name?: string; path?: string };
  }>;
  expect(value.jobs.visual_core.if).toBe(
    "${{ github.ref_name != github.event.repository.default_branch && inputs.scene_selection != 'release-visual-native-sharing' }}",
  );
  const run = steps.find((step) => step.name === "Run contained settings follow-up visual batch")!;
  expect(run.if).toBe("${{ inputs.scene_selection == 'release-visual-settings-followups' }}");
  expect(run.run).toBe(
    "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-settings-followups",
  );
  expect(run.env).toEqual({
    BIBCODE_UPLOAD_SERVER: "${{ runner.temp }}/issue29-visual-build/bibcode",
    BIBCODE_DELIVERY_UI_WEB: "${{ runner.temp }}/issue29-visual-build/web",
  });
  const evidence = steps.find(
    (step) => step.name === "Retain explicit settings follow-up evidence",
  )!;
  expect(evidence.with!.name).toBe(
    "issue29-settings-followups-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  expect(
    evidence
      .with!.path!.trim()
      .split("\n")
      .map((path) => path.slice(path.lastIndexOf("/") + 1)),
  ).toEqual([
    "phase.json",
    "failure.json",
    "provenance.json",
    "result.json",
    "assertions.json",
    "namespace-cleanup.json",
    "supervisor.json",
    ...[
      "settings-diagnostics",
      "diagnostics-live-processes",
      "diagnostics-unknown-duration",
      "usage-detail-available",
      "usage-detail",
      "remote-rename",
      "remote-rename-applied",
      "receiving-settings-row",
      "remote-receiving-settings",
    ].flatMap((scene) => [scene + "-light.png", scene + "-dark.png"]),
  ]);
  expect(evidence.with!.path).not.toMatch(/\*|private|profile|\.log/);
  expect(
    steps.find((step) => step.name === "Check owned helpers and namespace admission")!.run,
  ).toContain("support/release-visual-settings-followups-caller.test.ts");
});

it("retains exactly fourteen provider originals and seven closed receipts in a separate manual lane", () => {
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
  const run = steps.find((step) => step.name === "Run contained provider chat visual batch");
  expect(run?.run).toBe(
    "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-provider-chat",
  );
  expect(run?.if).toBe("${{ inputs.scene_selection == 'release-visual-provider-chat' }}");
  const retain = steps.find((step) => step.name === "Retain explicit provider chat evidence");
  expect(retain?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  expect(retain?.with?.name).toBe(
    "issue29-provider-chat-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  expect(
    retain?.with?.path
      ?.trim()
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
    ...[
      "composer-command-menu",
      "context-popover",
      "mcp-popover",
      "chat-markdown-plan",
      "activity-narrow",
      "chat-refused-model",
      "chat-held-workspace-loss",
    ].flatMap((scene) => [scene + "-light.png", scene + "-dark.png"]),
  ]);
  expect(retain?.with?.path).not.toMatch(/\*|private|profile|\.log|question-multiselect/);
  const helper = steps.map((step) => step.run ?? "").join("\n");
  for (const name of [
    "provider-chat",
    "provider-chat-fixture",
    "provider-chat-installer",
    "provider-chat-loss",
    "provider-chat-api",
    "provider-chat-media",
    "provider-chat-turns",
    "provider-chat-producer",
    "provider-chat-public",
    "provider-chat-wiring",
  ]) {
    expect(helper).toContain("release-visual-" + name + ".test.ts");
  }
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

it("keeps six workspace substate originals separate from the unchanged core nine", () => {
  const value = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps = value.jobs.visual_core.steps;
  const run = steps.find(
    (entry: { name: string }) => entry.name === "Run contained workspace substate batch",
  );
  expect(run.if).toBe("${{ inputs.scene_selection == 'release-visual-workspace-substates' }}");
  expect(run.run).toBe(
    "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-workspace-substates",
  );
  const evidence = steps.find(
    (entry: { name: string }) => entry.name === "Retain explicit workspace substate evidence",
  );
  expect(evidence.if).toBe(
    "${{ always() && inputs.scene_selection == 'release-visual-workspace-substates' }}",
  );
  expect(evidence.with["if-no-files-found"]).toBe("error");
  expect(evidence.with["retention-days"]).toBe(7);
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
    ...[
      "git-history-stashes-selected-diff",
      "files-editor-comment-item-context-menu",
      "workspace-composite-activity-lines",
    ].flatMap((prefix) => [prefix + "-light.png", prefix + "-dark.png"]),
  ]);
  expect(evidence.with.path).not.toMatch(/\*|private|profile|\.log/);
  expect(
    steps.find(
      (entry: { name: string }) => entry.name === "Check owned helpers and namespace admission",
    ).run,
  ).toContain("support/release-visual-workspace-substates.test.ts");
  expect(visualScenes).toHaveLength(9);
});

it("retains only six lifecycle originals and seven closed receipts while keeping native ownership separate", () => {
  const value = YAML.parse(
      NodeFS.readFileSync(
        new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
        "utf8",
      ),
    ),
    steps = value.jobs.visual_core.steps as Array<{
      name: string;
      if?: string;
      run?: string;
      uses?: string;
      with?: { name?: string; path?: string; retentionDays?: number };
    }>;
  const run = steps.find((step) => step.name === "Run contained project lifecycle visual batch");
  expect(run).toBeDefined();
  expect(run!.if).toBe("${{ inputs.scene_selection == 'release-visual-project-lifecycle' }}");
  expect(run!.run).toBe(
    "python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-project-lifecycle",
  );
  const evidence = steps.find((step) => step.name === "Retain explicit project lifecycle evidence");
  expect(evidence).toBeDefined();
  expect(evidence!.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  expect(evidence!.if).toBe(
    "${{ always() && inputs.scene_selection == 'release-visual-project-lifecycle' }}",
  );
  expect(evidence!.with!.name).toBe(
    "issue29-project-lifecycle-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  expect(
    evidence!
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
    ...["worktree-remove-busy", "project-clone-progress", "git-trust-refusal"].flatMap((scene) => [
      scene + "-light.png",
      scene + "-dark.png",
    ]),
  ]);
  expect(evidence!.with!.path).not.toMatch(/\*|private|profile|\.log/);
  const gate = steps.find(
    (step) => step.name === "Check owned helpers and namespace admission",
  )!.run!;
  for (const helper of [
    "release-visual-project-lifecycle",
    "release-visual-project-lifecycle.public",
    "release-visual-project-lifecycle-fixture",
    "release-visual-project-lifecycle-api",
    "release-visual-project-lifecycle-wiring",
  ])
    expect(gate).toContain("support/" + helper + ".test.ts");
  expect(value.jobs.visual_core.if).toBe(
    "${{ github.ref_name != github.event.repository.default_branch && inputs.scene_selection != 'release-visual-native-sharing' }}",
  );
  expect(value.jobs.native_sharing).toEqual({
    if: "${{ github.ref_name != github.event.repository.default_branch && inputs.scene_selection == 'release-visual-native-sharing' }}",
    uses: "./.github/workflows/desktop-ui-smoke.yml",
    with: { native_sharing: true },
  });
});
