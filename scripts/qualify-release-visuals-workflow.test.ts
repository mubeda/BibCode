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
  it("has no automatic trigger and retains only the fixed sixteen originals and closed receipts", () => {
    const path = new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url);
    expect(NodeFS.existsSync(path)).toBe(true);
    const value = YAML.parse(NodeFS.readFileSync(path, "utf8"));
    expect(value.on).toEqual({ workflow_dispatch: null });
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
