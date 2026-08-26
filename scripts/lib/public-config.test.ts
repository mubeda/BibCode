// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("returns no synthetic values for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env).toEqual({});
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env"), "BIBCODE_PORT=4100\nSOURCE=root\n");
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "BIBCODE_PORT=4200\nSOURCE=local\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).BIBCODE_PORT).toBe("4200");
    expect(
      loadRepoEnv({
        baseEnv: {
          BIBCODE_PORT: "4300",
          SOURCE: "process",
        },
        repoRoot,
      }),
    ).toMatchObject({
      BIBCODE_PORT: "4300",
      SOURCE: "process",
    });
  });

  it("preserves unrelated environment entries", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          UNRELATED: "kept",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toMatchObject({
      UNRELATED: "kept",
    });
  });

  it("surfaces environment file read errors", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.mkdirSync(NodePath.join(repoRoot, ".env"));

    expect(() => loadRepoEnv({ baseEnv: {}, repoRoot })).toThrow();
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
