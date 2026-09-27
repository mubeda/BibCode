// @effect-diagnostics nodeBuiltinImport:off - Repository module-name guard inspects tracked paths directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const MODULE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|css)$/;

function findModuleCaseCollisions(paths: readonly string[]): Array<readonly [string, string]> {
  const seen = new Map<string, { name: string; path: string }>();
  const collisions: Array<readonly [string, string]> = [];

  for (const path of paths) {
    if (path.startsWith(".repos/") || !MODULE_EXTENSION.test(path)) continue;
    const { dir, name } = NodePath.posix.parse(path);
    const key = `${dir}/${name.toLowerCase()}`;
    const previous = seen.get(key);
    if (previous && previous.name !== name) {
      collisions.push([previous.path, path]);
    } else {
      seen.set(key, { name, path });
    }
  }

  return collisions;
}

describe("repository module names", () => {
  it("detects case-divergent component and logic modules across extensions", () => {
    const component = "apps/web/src/components/gitManager/GitManagerRepositoryUnavailable.tsx";
    const logic = "apps/web/src/components/gitManager/gitManagerRepositoryUnavailable.ts";

    expect(findModuleCaseCollisions([component, logic])).toEqual([[component, logic]]);
  });

  it.each(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "css"])(
    "checks .%s modules",
    (extension) => {
      const path = `src/Widget.${extension}`;
      expect(findModuleCaseCollisions([path, "src/widget.ts"])).toEqual([[path, "src/widget.ts"]]);
    },
  );

  it("ignores vendored files, non-modules, separate directories, and identical stems", () => {
    expect(
      findModuleCaseCollisions([
        ".repos/example/Widget.tsx",
        ".repos/example/widget.ts",
        "src/Widget.md",
        "src/widget.ts",
        "other/Widget.tsx",
        "src/Widget.tsx.txt",
        "Src/Widget.tsx",
        "src/widget.css",
      ]),
    ).toEqual([]);
  });

  it("keeps tracked modules portable across case-sensitive and case-insensitive filesystems", () => {
    const paths = NodeChildProcess.execFileSync(
      "git",
      ["ls-files", "-z", "--", ".", ":(exclude).repos/**"],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    )
      .split("\0")
      // Deleted or renamed files can still be in the index before changes are staged.
      .filter((path) => path !== "" && NodeFS.existsSync(NodePath.join(REPOSITORY_ROOT, path)));
    const collisions = findModuleCaseCollisions(paths);
    const message = collisions
      .map(
        ([first, second]) =>
          `${first} and ${second}: case-divergent module names resolve to different files on macOS/Windows.`,
      )
      .join("\n");

    expect(collisions, message).toEqual([]);
  });
});
