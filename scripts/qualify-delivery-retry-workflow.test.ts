// @effect-diagnostics nodeBuiltinImport:off - Validate a static QA workflow without executing it.
import * as NodeFS from "node:fs";
import * as YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";

describe("delivery Retry workflow", () => {
  it("keeps the temporary workflow on the fixed entrypoint with only declared artifacts", () => {
    const value = YAML.parse(
      NodeFS.readFileSync(
        new URL("../.github/workflows/qualify-delivery-retry.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(value.on).toEqual({
      push: { branches: ["codex/qualify-delivery-retry"] },
      workflow_dispatch: null,
    });
    const steps = value.jobs.delivery_retry.steps as Array<{
      name?: string;
      run?: string;
      uses?: string;
      with?: { path?: string };
    }>;
    expect(
      steps.find((entry) => entry.name === "Run contained actual Retry interaction")?.run,
    ).toBe("python3 -B scripts/qualify-chat-uploads.py --scenario delivery-retry-ui");
    const artifacts = steps.find((entry) => entry.name === "Retain explicit safe evidence");
    expect(artifacts?.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    const names = artifacts!
      .with!.path!.trim()
      .split("\n")
      .map((line) => line.slice(line.lastIndexOf("/") + 1));
    expect(names).toEqual([
      "phase.json",
      "failure.json",
      "provenance.json",
      "result.json",
      "assertions.json",
      "namespace-cleanup.json",
      "supervisor.json",
      "uncertain-light.png",
      "uncertain-dark.png",
      "retry-cancelled-light.png",
      "retry-cancelled-dark.png",
      "new-conversation-light.png",
      "new-conversation-dark.png",
    ]);
    expect(artifacts!.with!.path).not.toMatch(/\*|private|profile|\.log/);
  });
});
