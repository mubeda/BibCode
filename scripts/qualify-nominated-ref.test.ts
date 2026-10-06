// @effect-diagnostics nodeBuiltinImport:off - Evaluate only repository job conditions in an inert VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as YAML from "yaml";
import { expect, it } from "vite-plus/test";
const read = (name: string) =>
  YAML.parse(NodeFS.readFileSync(new URL("../.github/workflows/" + name, import.meta.url), "utf8"));
function enabled(expression: string | undefined, ref: string, scene = "release-visual-core") {
  if (!expression) return true;
  const source = expression.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  return NodeVM.runInNewContext(source, {
    github: { ref_name: ref, event: { repository: { default_branch: "main" } } },
    inputs: { scene_selection: scene },
  });
}
it.each(["qualify-release-ui.yml", "qualify-release-visuals.yml"])(
  "keeps default-branch registration fail-closed while allowing the reviewed QA ref: %s",
  (name) => {
    const jobs = read(name).jobs;
    expect(enabled(jobs.registration_only?.if, "main")).toBe(true);
    expect(enabled(jobs.registration_only?.if, "codex/qualified")).toBe(false);
    for (const [id, value] of Object.entries(jobs)) {
      if (id === "registration_only") continue;
      const job = value as { if?: string };
      expect(enabled(job.if, "main", "release-visual-core")).toBe(false);
      expect(enabled(job.if, "main", "release-visual-native-sharing")).toBe(false);
    }
    const owner = jobs.remote_ui ?? jobs.visual_core;
    expect(enabled(owner.if, "codex/qualified")).toBe(true);
  },
);
