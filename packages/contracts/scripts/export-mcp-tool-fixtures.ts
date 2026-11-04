// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { previewToolFixture } from "./previewToolSchemas.ts";

const outputDirectory = NodePath.resolve(import.meta.dirname, "../fixtures/mcp-tools");
await NodeFSP.mkdir(outputDirectory, { recursive: true });
await NodeFSP.writeFile(
  NodePath.join(outputDirectory, "preview-tools.json"),
  `${JSON.stringify(previewToolFixture(), null, 2)}\n`,
);

// Format through the checkout-local Vite+ launcher, as the RPC fixture exporter does.
const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../..");
const formatResult = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(repositoryRoot, "scripts", "run-local-vp.mjs"), "fmt", "--write", outputDirectory],
  { cwd: repositoryRoot, stdio: "inherit" },
);
if (formatResult.error !== undefined) {
  throw new Error(`Failed to start the MCP fixture formatter: ${formatResult.error.message}`);
}
if (formatResult.status !== 0) {
  throw new Error(`The MCP fixture formatter exited with status ${formatResult.status}.`);
}
