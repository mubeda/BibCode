// @effect-diagnostics nodeBuiltinImport:off - The guard reads the checked-in component sources.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * The theme contrast check validates `selected-foreground` on `selected` only (#290, R50), so text
 * painted on a selected surface must use that token. A class string with `bg-selected` and any
 * other text colour shows `foreground` on `selected`, a pair nobody checks.
 *
 * Exceptions go here as "path: literal", with the reason beside them. There are none.
 */
const ALLOWED = new Set<string>();

const SRC = NodePath.resolve(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("selected surfaces", () => {
  it("every class string with bg-selected also sets text-selected-foreground", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = NodeFS.readFileSync(file, "utf8");
      for (const [literal] of text.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
        if (!/(?<![\w-])(?:[\w[\]=-]+:)*bg-selected(?![\w-])/.test(literal)) continue;
        if (literal.includes("text-selected-foreground")) continue;
        const key = `${NodePath.relative(SRC, file)}: ${literal}`;
        if (!ALLOWED.has(key)) offenders.push(key);
      }
    }
    expect(offenders).toEqual([]);
  });
});
