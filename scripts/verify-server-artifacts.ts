// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ServerArtifactManifestSchema, type ServerArtifactManifest } from "@bibcode/contracts";
import * as Schema from "effect/Schema";

export interface VerifyServerArtifactsOptions {
  readonly manifestPath: string;
  readonly directory: string;
  readonly allowUnsignedTest?: boolean;
  readonly requireCompleteMatrix?: boolean;
  readonly publicKeyPath?: string;
  readonly verifySignature?: (input: VerifyDetachedSignatureInput) => Promise<void>;
}

export interface VerifyDetachedSignatureInput {
  readonly path: string;
  readonly signaturePath: string;
}

const decodeManifest = Schema.decodeUnknownSync(ServerArtifactManifestSchema);

const COMPLETE_RELEASE_TUPLES = [
  "x86_64-pc-windows-msvc:windows:x86_64:zip",
  "x86_64-pc-windows-msvc:windows:x86_64:msi",
  "aarch64-pc-windows-msvc:windows:aarch64:zip",
  "aarch64-pc-windows-msvc:windows:aarch64:msi",
  "x86_64-apple-darwin:macos:x86_64:tar.gz",
  "aarch64-apple-darwin:macos:aarch64:tar.gz",
  "universal-apple-darwin:macos:universal:pkg",
  "x86_64-unknown-linux-gnu:linux:x86_64:tar.gz",
  "x86_64-unknown-linux-gnu:linux:x86_64:deb",
  "x86_64-unknown-linux-gnu:linux:x86_64:rpm",
  "aarch64-unknown-linux-gnu:linux:aarch64:tar.gz",
  "aarch64-unknown-linux-gnu:linux:aarch64:deb",
  "aarch64-unknown-linux-gnu:linux:aarch64:rpm",
] as const;

const artifactTupleKey = ({
  targetTriple,
  os,
  architecture,
  format,
}: ServerArtifactManifest["requiredMatrix"][number]): string =>
  `${targetTriple}:${os}:${architecture}:${format}`;

function requireCompleteReleaseMatrix(manifest: ServerArtifactManifest): void {
  const observed = new Set(manifest.requiredMatrix.map(artifactTupleKey));
  if (
    observed.size !== COMPLETE_RELEASE_TUPLES.length ||
    manifest.artifacts.length !== COMPLETE_RELEASE_TUPLES.length ||
    COMPLETE_RELEASE_TUPLES.some((tuple) => !observed.has(tuple))
  ) {
    throw new Error("The manifest does not contain the complete server release matrix.");
  }
}

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

const defaultSignatureVerifier =
  (publicKeyPath: string) =>
  ({ path, signaturePath }: VerifyDetachedSignatureInput): Promise<void> =>
    new Promise((resolve, reject) => {
      NodeChildProcess.execFile(
        "minisign",
        ["-V", "-q", "-p", publicKeyPath, "-m", path, "-x", signaturePath],
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          shell: false,
          timeout: 2 * 60_000,
          windowsHide: true,
        },
        (error) => {
          if (error)
            reject(
              new Error(`Detached signature verification failed: ${NodePath.basename(path)}.`),
            );
          else resolve();
        },
      );
    });

function verifySbomBinding(
  path: string,
  artifact: ServerArtifactManifest["artifacts"][number],
  sourceSha: string,
): void {
  const document = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
  const metadata = document.metadata as Record<string, unknown> | undefined;
  const component = metadata?.component as Record<string, unknown> | undefined;
  const hashes = Array.isArray(component?.hashes) ? component.hashes : [];
  const properties = Array.isArray(component?.properties) ? component.properties : [];
  const hashBound = hashes.some(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      (value as Record<string, unknown>).alg === "SHA-256" &&
      (value as Record<string, unknown>).content === artifact.sha256,
  );
  const sourceBound = properties.some(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      (value as Record<string, unknown>).name === "bibcode:sourceSha" &&
      (value as Record<string, unknown>).value === sourceSha,
  );
  if (
    document.bomFormat !== "CycloneDX" ||
    document.specVersion !== "1.7" ||
    component?.name !== artifact.downloadName ||
    !hashBound ||
    !sourceBound
  ) {
    throw new Error(
      `Server artifact SBOM is not bound to final artifact bytes: ${artifact.sbomName}`,
    );
  }
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
  if (options.requireCompleteMatrix === true) requireCompleteReleaseMatrix(manifest);
  const signed = manifest.channel !== "unsigned-test";
  const verifySignature =
    options.verifySignature ??
    (options.publicKeyPath === undefined
      ? undefined
      : defaultSignatureVerifier(NodePath.resolve(options.publicKeyPath)));
  if (signed && verifySignature === undefined) {
    throw new Error("Signed server artifacts require a detached-signature verifier.");
  }
  if (signed) {
    if (manifest.manifestSignatureName !== `${NodePath.basename(manifestPath)}.minisig`) {
      throw new Error("The server artifact manifest signature name is not canonical.");
    }
    await verifySignature?.({
      path: verifiedManifestPath,
      signaturePath: requirePlainFile(directory, manifest.manifestSignatureName),
    });
  }

  const checksumEntries: Array<{ readonly name: string; readonly sha256: string }> = [];
  for (const artifact of manifest.artifacts) {
    const artifactPath = requirePlainFile(directory, artifact.downloadName);
    const sbomPath = requirePlainFile(directory, artifact.sbomName);
    const metadata = NodeFS.statSync(artifactPath);
    if (metadata.size !== artifact.size) {
      throw new Error(`Server artifact size mismatch: ${artifact.downloadName}`);
    }
    if ((await sha256File(artifactPath)) !== artifact.sha256) {
      throw new Error(`Server artifact SHA-256 mismatch: ${artifact.downloadName}`);
    }
    if ((await sha256File(sbomPath)) !== artifact.sbomSha256) {
      throw new Error(`Server artifact SBOM SHA-256 mismatch: ${artifact.sbomName}`);
    }
    verifySbomBinding(sbomPath, artifact, manifest.sourceSha);
    if (signed) {
      await verifySignature?.({
        path: artifactPath,
        signaturePath: requirePlainFile(directory, artifact.signatureName),
      });
      await verifySignature?.({
        path: sbomPath,
        signaturePath: requirePlainFile(directory, artifact.sbomSignatureName),
      });
    }
    checksumEntries.push(
      { name: artifact.downloadName, sha256: artifact.sha256 },
      { name: artifact.sbomName, sha256: artifact.sbomSha256 },
    );
  }
  const checksumsPath = requirePlainFile(directory, manifest.checksumsName);
  if ((await sha256File(checksumsPath)) !== manifest.checksumsSha256) {
    throw new Error("Server artifact checksum file SHA-256 mismatch.");
  }
  checksumEntries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
  );
  const expectedChecksums = checksumEntries
    .map((entry) => `${entry.sha256}  ${entry.name}\n`)
    .join("");
  if (NodeFS.readFileSync(checksumsPath, "utf8") !== expectedChecksums) {
    throw new Error("Server artifact checksum set does not match the signed manifest exactly.");
  }
  if (signed) {
    await verifySignature?.({
      path: checksumsPath,
      signaturePath: requirePlainFile(directory, manifest.checksumsSignatureName),
    });
  }
  return manifest;
}

interface ParsedArguments extends VerifyServerArtifactsOptions {}

function parseArguments(argv: ReadonlyArray<string>): ParsedArguments {
  const values = new Map<string, string>();
  let allowUnsignedTest = false;
  let requireCompleteMatrix = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-unsigned-test") {
      allowUnsignedTest = true;
      continue;
    }
    if (argument === "--require-complete-matrix") {
      requireCompleteMatrix = true;
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
  const publicKeyPath = values.get("--public-key");
  if (!manifestPath || !directory || values.size !== (publicKeyPath === undefined ? 2 : 3)) {
    throw new Error(
      "Usage: verify-server-artifacts --manifest <path> --directory <path> [--public-key <path>] [--allow-unsigned-test] [--require-complete-matrix]",
    );
  }
  return {
    manifestPath,
    directory,
    allowUnsignedTest,
    requireCompleteMatrix,
    ...(publicKeyPath === undefined ? {} : { publicKeyPath }),
  };
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
