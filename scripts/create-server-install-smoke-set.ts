#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off - A source epoch becomes deterministic evidence metadata.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  finalizeServerArtifacts,
  type FinalizedServerArtifacts,
  type GenerateSbomRequest,
} from "./sign-server-artifacts.ts";

export interface CreateServerInstallSmokeSetInput {
  readonly artifactRoot: string;
  readonly outputDir: string;
  readonly sourceDateEpoch: number;
}

const fail = (message: string): never => {
  throw new Error(message);
};

export function parseCreateServerInstallSmokeSetCliArgs(
  argv: ReadonlyArray<string>,
): CreateServerInstallSmokeSetInput {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: {
      "artifact-root": { type: "string" },
      "output-dir": { type: "string" },
      "source-date-epoch": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values["artifact-root"] || !values["output-dir"] || !values["source-date-epoch"]) {
    return fail(
      "Usage: create-server-install-smoke-set --artifact-root <path> --output-dir <path> --source-date-epoch <seconds>",
    );
  }
  if (!/^[1-9][0-9]*$/u.test(values["source-date-epoch"])) {
    return fail("The install-smoke source date epoch must be a positive integer.");
  }
  const sourceDateEpoch = Number(values["source-date-epoch"]);
  if (!Number.isSafeInteger(sourceDateEpoch)) {
    return fail("The install-smoke source date epoch is outside the safe integer range.");
  }
  return {
    artifactRoot: values["artifact-root"],
    outputDir: values["output-dir"],
    sourceDateEpoch,
  };
}

const writeInstallSmokeSbom = async (request: GenerateSbomRequest): Promise<void> => {
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: request.artifact.downloadName,
        version: request.artifact.version,
        hashes: [{ alg: "SHA-256", content: request.artifact.sha256 }],
        properties: [
          { name: "bibcode:sourceSha", value: request.artifact.sourceSha },
          { name: "bibcode:targetTriple", value: request.artifact.targetTriple },
          { name: "bibcode:validationScope", value: "native-install-smoke" },
        ],
      },
    },
  };
  await NodeFSP.writeFile(request.outputPath, `${JSON.stringify(document, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
};

export async function createServerInstallSmokeSet(
  input: CreateServerInstallSmokeSetInput,
): Promise<FinalizedServerArtifacts> {
  if (!Number.isSafeInteger(input.sourceDateEpoch) || input.sourceDateEpoch <= 0) {
    return fail("The install-smoke source date epoch must be a positive integer.");
  }
  const artifactRoot = NodePath.resolve(input.artifactRoot);
  const outputDir = NodePath.resolve(input.outputDir);
  const artifactRootMetadata = await NodeFSP.lstat(artifactRoot);
  if (!artifactRootMetadata.isDirectory() || artifactRootMetadata.isSymbolicLink()) {
    return fail("The install-smoke candidate root must be a plain directory.");
  }
  const temporaryParent = NodePath.dirname(outputDir);
  await NodeFSP.mkdir(temporaryParent, { recursive: true });
  const normalized = await NodeFSP.mkdtemp(
    NodePath.join(temporaryParent, ".server-install-smoke-input-"),
  );
  try {
    for (const name of await NodeFSP.readdir(artifactRoot)) {
      const source = NodePath.join(artifactRoot, name);
      const metadata = await NodeFSP.lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return fail("The install-smoke candidate may contain only plain files.");
      }
      const destination = NodePath.join(normalized, name);
      if (!name.endsWith(".build.json")) {
        await NodeFSP.copyFile(source, destination);
        continue;
      }
      const value = JSON.parse(await NodeFSP.readFile(source, "utf8")) as Record<string, unknown>;
      if (value.buildMode !== "unsigned-test" && value.buildMode !== "signing-candidate") {
        return fail("The install-smoke build metadata mode is invalid.");
      }
      await NodeFSP.writeFile(
        destination,
        `${JSON.stringify({ ...value, buildMode: "unsigned-test" }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
    }
    return await finalizeServerArtifacts(
      {
        artifactRoot: normalized,
        outputDir,
        channel: "unsigned-test",
        generatedAt: new Date(input.sourceDateEpoch * 1_000).toISOString(),
      },
      { generateSbom: writeInstallSmokeSbom },
    );
  } finally {
    await NodeFSP.rm(normalized, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
const modulePath = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  createServerInstallSmokeSet(parseCreateServerInstallSmokeSetCliArgs(process.argv.slice(2)))
    .then(({ outputDir }) => process.stdout.write(`${outputDir}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Install-smoke set creation failed."}\n`,
      );
      process.exitCode = 1;
    });
}
