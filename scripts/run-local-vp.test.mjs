import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import { LOCAL_VP_MISSING_EXIT_CODE, resolveLocalVitePlus, runLocalVp } from "./run-local-vp.mjs";

const repoRoot = NodePath.resolve("/checkout");
const packagePath = NodePath.join(repoRoot, "node_modules", "vite-plus", "package.json");
const binPath = NodePath.join(repoRoot, "node_modules", "vite-plus", "bin", "vp.js");

function fakeFs(files) {
  return {
    existsSync: (path) => Object.hasOwn(files, path),
    readFileSync: (path) => {
      if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
  };
}

describe("run-local-vp", () => {
  it("resolves the vp bin declared by the checkout-local vite-plus package", () => {
    const fs = fakeFs({
      [packagePath]: JSON.stringify({
        version: "0.3.0",
        bin: { vp: "bin/vp.js", vpx: "bin/vpx.js" },
      }),
      [binPath]: "",
    });

    expect(resolveLocalVitePlus({ repoRoot, ...fs })).toEqual({
      kind: "resolved",
      binPath,
      packagePath,
      version: "0.3.0",
    });
  });

  it("accepts a string bin entry", () => {
    const fs = fakeFs({
      [packagePath]: JSON.stringify({ version: "0.3.0", bin: "bin/vp.js" }),
      [binPath]: "",
    });

    expect(resolveLocalVitePlus({ repoRoot, ...fs }).kind).toBe("resolved");
  });

  it("fails clearly when workspace dependencies are not installed", () => {
    const resolved = resolveLocalVitePlus({ repoRoot, ...fakeFs({}) });

    expect(resolved.kind).toBe("missing");
    expect(resolved.message).toContain("Workspace dependencies are not installed");
    expect(resolved.message).toContain("vp install --frozen-lockfile");
    expect(resolved.message).toContain(repoRoot);
  });

  it("fails clearly when the package exists without a vp entry", () => {
    const withoutBin = resolveLocalVitePlus({
      repoRoot,
      ...fakeFs({ [packagePath]: JSON.stringify({ version: "0.3.0" }) }),
    });
    expect(withoutBin.kind).toBe("missing");
    expect(withoutBin.message).toContain("does not declare a `vp` bin entry");

    const danglingBin = resolveLocalVitePlus({
      repoRoot,
      ...fakeFs({ [packagePath]: JSON.stringify({ version: "0.3.0", bin: { vp: "bin/vp.js" } }) }),
    });
    expect(danglingBin.kind).toBe("missing");
    expect(danglingBin.message).toContain(binPath);
  });

  it("executes the local entry with the current Node and forwards arguments and exit codes", () => {
    const fs = fakeFs({
      [packagePath]: JSON.stringify({ version: "0.3.0", bin: { vp: "bin/vp.js" } }),
      [binPath]: "",
    });
    const spawnSync = vi.fn(() => ({ status: 7 }));
    const env = { PATH: "/global/vp/shadow" };

    expect(
      runLocalVp(["test", "run", "packages/client-runtime/src/state/vcs.test.ts"], {
        repoRoot,
        ...fs,
        spawnSync,
        execPath: "/usr/bin/node",
        cwd: repoRoot,
        env,
      }),
    ).toBe(7);
    expect(spawnSync).toHaveBeenCalledWith(
      "/usr/bin/node",
      [binPath, "test", "run", "packages/client-runtime/src/state/vcs.test.ts"],
      expect.objectContaining({ stdio: "inherit", shell: false, cwd: repoRoot, env }),
    );
  });

  it("never spawns when the local installation is missing", () => {
    const consoleError = vi.fn();
    const spawnSync = vi.fn();

    expect(runLocalVp(["test"], { repoRoot, ...fakeFs({}), spawnSync, consoleError })).toBe(
      LOCAL_VP_MISSING_EXIT_CODE,
    );
    expect(spawnSync).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0][0]).toContain("[run-local-vp]");
  });

  it("reports a spawn failure instead of throwing", () => {
    const consoleError = vi.fn();
    const spawnSync = vi.fn(() => ({ status: null, error: new Error("EACCES") }));
    const fs = fakeFs({
      [packagePath]: JSON.stringify({ version: "0.3.0", bin: { vp: "bin/vp.js" } }),
      [binPath]: "",
    });

    expect(runLocalVp(["test"], { repoRoot, ...fs, spawnSync, consoleError })).toBe(1);
    expect(consoleError.mock.calls[0][0]).toContain("EACCES");
  });
});
