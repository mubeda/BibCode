// @effect-diagnostics nodeBuiltinImport:off - UI policy coverage reads checked-in product sources.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { textSizesBelowTextXs } from "./uiTypography";

const sourceRoot = NodePath.resolve(import.meta.dirname, "..");
const sourceExtensions = new Set([".ts", ".tsx", ".css", ".html"]);

function productSources(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "test" ? [] : productSources(path);
    }
    if (entry.name.includes(".test.") || entry.name.includes(".spec.")) return [];
    return sourceExtensions.has(NodePath.extname(entry.name)) ? [path] : [];
  });
}

describe("product typography", () => {
  it("keeps every product text size at 12 px or larger, including responsive and shared styles", () => {
    const sources = productSources(sourceRoot);
    expect(sources.length).toBeGreaterThan(0);
    const violations = sources.flatMap((path) =>
      textSizesBelowTextXs(NodeFS.readFileSync(path, "utf8")).map(
        (size) => `${NodePath.relative(sourceRoot, path)}: ${size}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
