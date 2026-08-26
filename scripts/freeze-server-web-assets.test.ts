// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  freezeServerWebAssets,
  parseFreezeServerWebAssetsCliArgs,
} from "./freeze-server-web-assets.ts";

describe("frozen server web assets", () => {
  it("publishes one source-bound immutable asset input", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bibcode-frozen-web-"));
    const input = NodePath.join(root, "input");
    const output = NodePath.join(root, "output");
    await NodeFSP.mkdir(NodePath.join(input, "assets"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(input, "index.html"), "index");
    await NodeFSP.writeFile(NodePath.join(input, "assets/app.js"), "app");

    await freezeServerWebAssets({ assetsDir: input, outputDir: output, sourceSha: "a".repeat(40) });

    expect(NodeFS.readFileSync(NodePath.join(output, "source-sha.txt"), "utf8")).toBe(
      `${"a".repeat(40)}\n`,
    );
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(output, "web-assets.json"), "utf8"),
    ) as { readonly files: ReadonlyArray<{ readonly path: string }> };
    expect(manifest.files.map((file) => file.path)).toEqual(["assets/app.js", "index.html"]);
  });

  it("rejects overlap, stale output, and incomplete CLI identity", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bibcode-frozen-web-"));
    const input = NodePath.join(root, "input");
    await NodeFSP.mkdir(input);
    await NodeFSP.writeFile(NodePath.join(input, "index.html"), "index");
    await expect(
      freezeServerWebAssets({
        assetsDir: input,
        outputDir: NodePath.join(input, "output"),
        sourceSha: "a".repeat(40),
      }),
    ).rejects.toThrow(/outside/iu);
    expect(() => parseFreezeServerWebAssetsCliArgs(["--assets-dir", input])).toThrow(
      /output-dir/iu,
    );
  });
});
