// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ServerArtifactManifestSchema, type ServerArtifactManifest } from "@bibcode/contracts";
import * as Schema from "effect/Schema";

export interface VerifyServerArtifactsOptions {
  readonly manifestPath: string;
  readonly directory: string;
  readonly allowUnsignedTest?: boolean;
}

const decodeManifest = Schema.decodeUnknownSync(ServerArtifactManifestSchema);

function requirePlainFile(directory: string, name: string): string {
  const path = NodePath.resolve(directory, name);
  if (NodePath.dirname(path) !== NodePath.resolve(directory)) {
    throw new Error(`Server artifact path escapes its release directory: ${name}`);
  }
  const metadata = NodeFS.lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Server artifact path is not a plain file: ${name}`);
  }
  return path;
}

async function sha256File(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function verifyServerArtifacts(
  options: VerifyServerArtifactsOptions,
): Promise<ServerArtifactManifest> {
  const directory = NodePath.resolve(options.directory);
  const manifestPath = NodePath.resolve(options.manifestPath);
  if (NodePath.dirname(manifestPath) !== directory) {
    throw new Error("The server artifact manifest must be inside the verified release directory.");
  }
  const verifiedManifestPath = requirePlainFile(directory, NodePath.basename(manifestPath));
  const manifest = decodeManifest(JSON.parse(NodeFS.readFileSync(verifiedManifestPath, "utf8")));
  if (manifest.channel === "unsigned-test" && options.allowUnsignedTest !== true) {
    throw new Error("Unsigned-test server artifacts require an explicit verifier opt-in.");
  }

  for (const artifact of manifest.artifacts) {
    const artifactPath = requirePlainFile(directory, artifact.downloadName);
    requirePlainFile(directory, artifact.signatureName);
    requirePlainFile(directory, artifact.sbomName);
    const metadata = NodeFS.statSync(artifactPath);
    if (metadata.size !== artifact.size) {
      throw new Error(`Server artifact size mismatch: ${artifact.downloadName}`);
    }
    if ((await sha256File(artifactPath)) !== artifact.sha256) {
      throw new Error(`Server artifact SHA-256 mismatch: ${artifact.downloadName}`);
    }
  }
  if (manifest.channel !== "unsigned-test") {
    requirePlainFile(directory, manifest.manifestSignatureName);
  }
  return manifest;
}

interface ParsedArguments extends VerifyServerArtifactsOptions {}

function parseArguments(argv: ReadonlyArray<string>): ParsedArguments {
  const values = new Map<string, string>();
  let allowUnsignedTest = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-unsigned-test") {
      allowUnsignedTest = true;
      continue;
    }
    const value = argv[index + 1];
    if (!argument?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid server artifact verifier argument: ${argument ?? "<missing>"}`);
    }
    values.set(argument, value);
    index += 1;
  }
  const manifestPath = values.get("--manifest");
  const directory = values.get("--directory");
  if (!manifestPath || !directory || values.size !== 2) {
    throw new Error(
      "Usage: verify-server-artifacts --manifest <path> --directory <path> [--allow-unsigned-test]",
    );
  }
  return { manifestPath, directory, allowUnsignedTest };
}

export async function runVerifyServerArtifactsMain(argv = process.argv.slice(2)): Promise<void> {
  await verifyServerArtifacts(parseArguments(argv));
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
const modulePath = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  runVerifyServerArtifactsMain().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Server artifact verification failed."}\n`,
    );
    process.exitCode = 1;
  });
}
