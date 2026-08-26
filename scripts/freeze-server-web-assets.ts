#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { collectWebAssetManifest, copyPlainTree } from "./build-server-artifact.ts";

export interface FreezeServerWebAssetsInput {
  readonly assetsDir: string;
  readonly outputDir: string;
  readonly sourceSha: string;
}

const fail = (message: string): never => {
  throw new Error(message);
};

const containsPath = (parent: string, child: string): boolean => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

export async function freezeServerWebAssets(input: FreezeServerWebAssetsInput): Promise<string> {
  const assetsDir = NodePath.resolve(input.assetsDir);
  const outputDir = NodePath.resolve(input.outputDir);
  if (!/^[a-f0-9]{40}$/u.test(input.sourceSha)) {
    return fail("The frozen server web asset source SHA is invalid.");
  }
  if (
    NodeFS.existsSync(outputDir) ||
    containsPath(assetsDir, outputDir) ||
    containsPath(outputDir, assetsDir)
  ) {
    return fail("The frozen server web output must be a fresh directory outside its input.");
  }
  const parent = NodePath.dirname(outputDir);
  await NodeFSP.mkdir(parent, { recursive: true });
  const staging = await NodeFSP.mkdtemp(
    NodePath.join(parent, `.${NodePath.basename(outputDir)}.staging-`),
  );
  try {
    const webOutput = NodePath.join(staging, "web");
    await copyPlainTree(assetsDir, webOutput);
    const manifest = await collectWebAssetManifest(webOutput);
    await NodeFSP.writeFile(
      NodePath.join(staging, "web-assets.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await NodeFSP.writeFile(NodePath.join(staging, "source-sha.txt"), `${input.sourceSha}\n`);
    await NodeFSP.rename(staging, outputDir);
    return outputDir;
  } catch (error) {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export function parseFreezeServerWebAssetsCliArgs(
  argv: ReadonlyArray<string>,
): FreezeServerWebAssetsInput {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: {
      "assets-dir": { type: "string" },
      "output-dir": { type: "string" },
      "source-sha": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values["assets-dir"]) return fail("--assets-dir is required.");
  if (!values["output-dir"]) return fail("--output-dir is required.");
  if (!values["source-sha"]) return fail("--source-sha is required.");
  return {
    assetsDir: values["assets-dir"],
    outputDir: values["output-dir"],
    sourceSha: values["source-sha"],
  };
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
const modulePath = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  freezeServerWebAssets(parseFreezeServerWebAssetsCliArgs(process.argv.slice(2)))
    .then((output) => process.stdout.write(`${output}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Server web asset freeze failed."}\n`,
      );
      process.exitCode = 1;
    });
}
