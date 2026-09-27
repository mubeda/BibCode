// @effect-diagnostics nodeBuiltinImport:off - Repository skill parity checks read the actual files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");

function skillFiles(directory: string): Array<string> {
  if (!NodeFS.existsSync(directory)) return [];
  return NodeFS.globSync("*/SKILL.md", { cwd: directory }).sort();
}

it("keeps Codex and Claude repository skills as identical plain files in both directions", () => {
  const codexRoot = NodePath.join(REPOSITORY_ROOT, ".agents", "skills");
  const claudeRoot = NodePath.join(REPOSITORY_ROOT, ".claude", "skills");
  const codexFiles = skillFiles(codexRoot);
  const claudeFiles = skillFiles(claudeRoot);

  expect(codexFiles, "Repository skills must exist").not.toEqual([]);
  expect(claudeFiles, "Every skill must be present for both agents").toEqual(codexFiles);

  for (const relativePath of codexFiles) {
    const codexPath = NodePath.join(codexRoot, relativePath);
    const claudePath = NodePath.join(claudeRoot, relativePath);
    expect(NodeFS.lstatSync(codexPath).isFile(), `${codexPath} must be a plain file`).toBe(true);
    expect(NodeFS.lstatSync(claudePath).isFile(), `${claudePath} must be a plain file`).toBe(true);
    expect(NodeFS.readFileSync(claudePath), `${relativePath} must match byte for byte`).toEqual(
      NodeFS.readFileSync(codexPath),
    );
  }
});
