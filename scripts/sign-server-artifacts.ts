#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import {
  NativeSigningStateSchema,
  ServerArtifactManifestSchema,
  type NativeSigningState,
  type ServerArtifactChannel,
  type ServerArtifactManifest,
  type ServerArtifactRecord,
} from "@bibcode/contracts";
import * as Schema from "effect/Schema";

import {
  generateServerSbom,
  type ServerFileInventoryRecord,
  type ServerSbomArtifactBinding,
} from "./generate-server-sbom.ts";

const MAX_SIGNER_OUTPUT_BYTES = 64 * 1024;
const SIGNER_TIMEOUT_MS = 2 * 60_000;
const SIGNATURE_SUFFIX = ".minisig";
const CHECKSUMS_NAME = "SHA256SUMS";
const MANIFEST_NAME = "artifacts.json";

interface ArtifactBuildMetadata {
  readonly schemaVersion: 1;
  readonly product: "bibcode-server";
  readonly buildMode: "unsigned-test" | "signing-candidate";
  readonly version: string;
  readonly sourceSha: string;
  readonly targetTriple: string;
  readonly sourceDateEpoch: number;
  readonly rustc: string;
  readonly binarySha256: string;
  readonly artifact: {
    readonly downloadName: string;
    readonly os: "linux" | "macos" | "windows";
    readonly architecture: "x86_64" | "aarch64" | "universal";
    readonly format: "zip" | "tar.gz" | "msi" | "pkg" | "deb" | "rpm";
    readonly nativeSigning: NativeSigningState;
    readonly notarized: boolean;
  };
  readonly fileInventory: ReadonlyArray<ServerFileInventoryRecord>;
}

export interface FinalizeServerArtifactsInput {
  readonly artifactRoot: string;
  readonly outputDir: string;
  readonly channel: ServerArtifactChannel;
  readonly generatedAt: string;
  readonly repoRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface GenerateSbomRequest {
  readonly artifact: ServerSbomArtifactBinding;
  readonly metadata: ArtifactBuildMetadata;
  readonly outputPath: string;
  readonly workRoot: string;
}

export interface SignFileRequest {
  readonly path: string;
  readonly signaturePath: string;
  readonly trustedComment: string;
}

export interface FinalizeServerArtifactsDependencies {
  readonly generateSbom?: (request: GenerateSbomRequest) => Promise<void>;
  readonly signFile?: (request: SignFileRequest) => Promise<void>;
}

export interface FinalizedServerArtifacts {
  readonly manifest: ServerArtifactManifest;
  readonly outputDir: string;
}

export function parseFinalizeServerArtifactsCliArgs(
  argv: ReadonlyArray<string>,
): FinalizeServerArtifactsInput {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: {
      "artifact-root": { type: "string" },
      "output-dir": { type: "string" },
      channel: { type: "string" },
      "generated-at": { type: "string" },
      "repo-root": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values["artifact-root"]) return fail("--artifact-root is required.");
  if (!values["output-dir"]) return fail("--output-dir is required.");
  if (!values["generated-at"]) return fail("--generated-at is required.");
  if (!values.channel || !["stable", "beta", "nightly", "unsigned-test"].includes(values.channel)) {
    return fail("--channel must be stable, beta, nightly, or unsigned-test.");
  }
  return {
    artifactRoot: values["artifact-root"],
    outputDir: values["output-dir"],
    channel: values.channel as ServerArtifactChannel,
    generatedAt: values["generated-at"],
    ...(values["repo-root"] ? { repoRoot: values["repo-root"] } : {}),
  };
}

export interface ServerDetachedSigningConfiguration {
  readonly privateKey: string;
  readonly password: string;
}

const decodeNativeSigning = Schema.decodeUnknownSync(NativeSigningStateSchema);
const decodeManifest = Schema.decodeUnknownSync(ServerArtifactManifestSchema);

const fail = (message: string): never => {
  throw new Error(message);
};

const sha256File = async (path: string): Promise<string> => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const isPlainFile = (path: string): boolean => {
  const metadata = NodeFS.lstatSync(path);
  return metadata.isFile() && !metadata.isSymbolicLink();
};

const safeName = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value) &&
  value !== "." &&
  value !== "..";

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    return fail(`${label} is invalid.`);
  }
  return value;
};

const parseBuildMetadata = (path: string): ArtifactBuildMetadata => {
  const value = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
  const artifact = value.artifact as Record<string, unknown> | undefined;
  if (
    value.schemaVersion !== 1 ||
    value.product !== "bibcode-server" ||
    (value.buildMode !== "unsigned-test" && value.buildMode !== "signing-candidate") ||
    artifact === undefined ||
    !safeName(artifact.downloadName) ||
    !["linux", "macos", "windows"].includes(String(artifact.os)) ||
    !["x86_64", "aarch64", "universal"].includes(String(artifact.architecture)) ||
    !["zip", "tar.gz", "msi", "pkg", "deb", "rpm"].includes(String(artifact.format)) ||
    typeof artifact.notarized !== "boolean" ||
    !Array.isArray(value.fileInventory)
  ) {
    return fail(`The server artifact build metadata is invalid: ${NodePath.basename(path)}.`);
  }
  const sourceSha = requiredString(value.sourceSha, "Build metadata source SHA");
  const binarySha256 = requiredString(value.binarySha256, "Build metadata binary SHA-256");
  if (!/^[a-f0-9]{40}$/u.test(sourceSha) || !/^[a-f0-9]{64}$/u.test(binarySha256)) {
    return fail(`The server artifact build identity is invalid: ${NodePath.basename(path)}.`);
  }
  if (!Number.isSafeInteger(value.sourceDateEpoch) || Number(value.sourceDateEpoch) <= 0) {
    return fail(`The server artifact source epoch is invalid: ${NodePath.basename(path)}.`);
  }
  return {
    schemaVersion: 1,
    product: "bibcode-server",
    buildMode: value.buildMode,
    version: requiredString(value.version, "Build metadata version"),
    sourceSha,
    targetTriple: requiredString(value.targetTriple, "Build metadata target triple"),
    sourceDateEpoch: Number(value.sourceDateEpoch),
    rustc: requiredString(value.rustc, "Build metadata rustc"),
    binarySha256,
    artifact: {
      downloadName: artifact.downloadName,
      os: artifact.os as ArtifactBuildMetadata["artifact"]["os"],
      architecture: artifact.architecture as ArtifactBuildMetadata["artifact"]["architecture"],
      format: artifact.format as ArtifactBuildMetadata["artifact"]["format"],
      nativeSigning: decodeNativeSigning(artifact.nativeSigning),
      notarized: artifact.notarized,
    },
    fileInventory: value.fileInventory as ReadonlyArray<ServerFileInventoryRecord>,
  };
};

const validateStableNativeSigning = (metadata: ArtifactBuildMetadata, channel: string): void => {
  if (channel !== "stable" || metadata.artifact.os !== "windows") return;
  const signing = metadata.artifact.nativeSigning;
  if (
    signing.binary !== "authenticode" ||
    !signing.verified ||
    !signing.timestamped ||
    (metadata.artifact.format === "msi" && signing.package !== "authenticode")
  ) {
    fail("Stable Windows server artifacts require verified timestamped Authenticode signatures.");
  }
};

const verifySbomBinding = (
  path: string,
  artifactName: string,
  artifactSha256: string,
  sourceSha: string,
): void => {
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
      (value as Record<string, unknown>).content === artifactSha256,
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
    component?.name !== artifactName ||
    !hashBound ||
    !sourceBound
  ) {
    fail(`The generated SBOM is not bound to final artifact bytes: ${artifactName}.`);
  }
};

export function resolveServerDetachedSigningConfiguration(
  channel: ServerArtifactChannel,
  env: NodeJS.ProcessEnv,
): ServerDetachedSigningConfiguration | null {
  if (channel === "unsigned-test") return null;
  const privateKey = env.BIBCODE_SERVER_SIGNING_PRIVATE_KEY;
  const password = env.BIBCODE_SERVER_SIGNING_PRIVATE_KEY_PASSWORD;
  if (!privateKey || !password) {
    return fail("Signed server releases require the dedicated server signing key and password.");
  }
  if (privateKey === env.TAURI_SIGNING_PRIVATE_KEY) {
    return fail("Server releases and desktop updates require independent signing keys.");
  }
  return { privateKey, password };
}

const decodePrivateKey = (value: string): string => {
  if (value.startsWith("untrusted comment:")) return value.endsWith("\n") ? value : `${value}\n`;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return fail("The dedicated server signing key is not valid text or base64.");
  }
  if (!decoded.startsWith("untrusted comment:")) {
    return fail("The dedicated server signing key is malformed.");
  }
  return decoded.endsWith("\n") ? decoded : `${decoded}\n`;
};

const runMinisign = async (input: {
  readonly args: ReadonlyArray<string>;
  readonly password?: string;
}): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("minisign", [...input.args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let outputBytes = 0;
    const observe = (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_SIGNER_OUTPUT_BYTES) child.kill();
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    const timeout = setTimeout(() => child.kill(), SIGNER_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("The Minisign process could not start."));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 && outputBytes <= MAX_SIGNER_OUTPUT_BYTES) resolve();
      else reject(new Error("The Minisign operation failed."));
    });
    child.stdin.end(input.password === undefined ? undefined : `${input.password}\n`);
  });

const withDefaultSigner = async <T>(input: {
  readonly configuration: ServerDetachedSigningConfiguration;
  readonly publicKeyPath: string;
  readonly temporaryParent: string;
  readonly run: (signer: (request: SignFileRequest) => Promise<void>) => Promise<T>;
}): Promise<T> => {
  const temporary = await NodeFSP.mkdtemp(NodePath.join(input.temporaryParent, ".server-key-"));
  const secretPath = NodePath.join(temporary, "server-release.key");
  try {
    await NodeFSP.writeFile(secretPath, decodePrivateKey(input.configuration.privateKey), {
      mode: 0o600,
    });
    return await input.run(async (request) => {
      await runMinisign({
        args: [
          "-S",
          "-s",
          secretPath,
          "-m",
          request.path,
          "-x",
          request.signaturePath,
          "-t",
          request.trustedComment,
        ],
        password: input.configuration.password,
      });
      await runMinisign({
        args: [
          "-V",
          "-q",
          "-p",
          input.publicKeyPath,
          "-m",
          request.path,
          "-x",
          request.signaturePath,
        ],
      });
    });
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
};

const finalizeWithSigner = async (
  input: FinalizeServerArtifactsInput,
  dependencies: Required<FinalizeServerArtifactsDependencies>,
): Promise<FinalizedServerArtifacts> => {
  const artifactRoot = NodePath.resolve(input.artifactRoot);
  const outputDir = NodePath.resolve(input.outputDir);
  const relativeOutput = NodePath.relative(artifactRoot, outputDir);
  const relativeInput = NodePath.relative(outputDir, artifactRoot);
  if (
    artifactRoot === outputDir ||
    (!relativeOutput.startsWith("..") && !NodePath.isAbsolute(relativeOutput)) ||
    (!relativeInput.startsWith("..") && !NodePath.isAbsolute(relativeInput)) ||
    NodeFS.existsSync(outputDir)
  ) {
    return fail("The finalized server artifact output must be a fresh distinct directory.");
  }
  const rootMetadata = NodeFS.lstatSync(artifactRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    return fail("The server artifact input root must be a plain directory.");
  }
  if (!Number.isFinite(Date.parse(input.generatedAt))) {
    return fail("The server artifact manifest timestamp is invalid.");
  }
  const entries = NodeFS.readdirSync(artifactRoot).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  const metadataNames = entries.filter((name) => name.endsWith(".build.json"));
  if (metadataNames.length === 0) return fail("No server artifact build records were found.");
  const metadataRecords = metadataNames.map((name) => {
    const path = NodePath.join(artifactRoot, name);
    if (!isPlainFile(path)) return fail(`Server artifact metadata must be a plain file: ${name}.`);
    const metadata = parseBuildMetadata(path);
    if (
      (input.channel === "unsigned-test" && metadata.buildMode !== "unsigned-test") ||
      (input.channel !== "unsigned-test" && metadata.buildMode !== "signing-candidate")
    ) {
      return fail("The server artifact build mode does not match the final release channel.");
    }
    if (name !== `${metadata.artifact.downloadName}.build.json`) {
      return fail(`Server artifact metadata is not named for its exact artifact: ${name}.`);
    }
    const artifactPath = NodePath.join(artifactRoot, metadata.artifact.downloadName);
    if (!NodeFS.existsSync(artifactPath) || !isPlainFile(artifactPath)) {
      return fail(
        `Server artifact is missing or not a plain file: ${metadata.artifact.downloadName}.`,
      );
    }
    validateStableNativeSigning(metadata, input.channel);
    return { metadata, artifactPath };
  });
  const linkedInputNames = new Set(
    metadataRecords.flatMap(({ metadata }) => [
      metadata.artifact.downloadName,
      `${metadata.artifact.downloadName}.build.json`,
    ]),
  );
  if (entries.some((name) => !linkedInputNames.has(name))) {
    return fail("The server artifact input root contains an unlinked file.");
  }
  const first = metadataRecords[0]?.metadata ?? fail("Server artifact metadata disappeared.");
  if (
    metadataRecords.some(
      ({ metadata }) =>
        metadata.version !== first.version || metadata.sourceSha !== first.sourceSha,
    )
  ) {
    return fail("Server artifact build records do not share one version and source SHA.");
  }

  const outputParent = NodePath.dirname(outputDir);
  await NodeFSP.mkdir(outputParent, { recursive: true });
  const staging = await NodeFSP.mkdtemp(
    NodePath.join(outputParent, `.${NodePath.basename(outputDir)}.staging-`),
  );
  try {
    const records: ServerArtifactRecord[] = [];
    const checksumEntries: Array<{ readonly name: string; readonly sha256: string }> = [];
    for (const { metadata, artifactPath } of metadataRecords) {
      const downloadName = metadata.artifact.downloadName;
      const publishedArtifactPath = NodePath.join(staging, downloadName);
      await NodeFSP.copyFile(artifactPath, publishedArtifactPath, NodeFS.constants.COPYFILE_EXCL);
      const artifactStats = await NodeFSP.stat(publishedArtifactPath);
      const artifactSha256 = await sha256File(publishedArtifactPath);
      const artifact: ServerSbomArtifactBinding = {
        downloadName,
        version: metadata.version,
        sourceSha: metadata.sourceSha,
        targetTriple: metadata.targetTriple,
        size: artifactStats.size,
        sha256: artifactSha256,
        fileInventory: metadata.fileInventory,
      };
      const sbomName = `${downloadName}.cdx.json`;
      const sbomPath = NodePath.join(staging, sbomName);
      await dependencies.generateSbom({
        artifact,
        metadata,
        outputPath: sbomPath,
        workRoot: NodePath.join(staging, ".sbom-work", artifactSha256),
      });
      if (!NodeFS.existsSync(sbomPath) || !isPlainFile(sbomPath)) {
        return fail(`Server artifact SBOM was not generated: ${sbomName}.`);
      }
      verifySbomBinding(sbomPath, downloadName, artifactSha256, metadata.sourceSha);
      const sbomSha256 = await sha256File(sbomPath);
      const signatureName = `${downloadName}${SIGNATURE_SUFFIX}`;
      const sbomSignatureName = `${sbomName}${SIGNATURE_SUFFIX}`;
      if (input.channel !== "unsigned-test") {
        await dependencies.signFile({
          path: publishedArtifactPath,
          signaturePath: NodePath.join(staging, signatureName),
          trustedComment: `bibcode-server ${metadata.sourceSha} ${downloadName}`,
        });
        await dependencies.signFile({
          path: sbomPath,
          signaturePath: NodePath.join(staging, sbomSignatureName),
          trustedComment: `bibcode-server SBOM ${metadata.sourceSha} ${sbomName}`,
        });
      }
      checksumEntries.push(
        { name: downloadName, sha256: artifactSha256 },
        { name: sbomName, sha256: sbomSha256 },
      );
      records.push({
        product: "bibcode-server",
        version: metadata.version,
        sourceSha: metadata.sourceSha,
        targetTriple: metadata.targetTriple,
        os: metadata.artifact.os,
        architecture: metadata.artifact.architecture,
        format: metadata.artifact.format,
        downloadName,
        size: artifactStats.size,
        sha256: artifactSha256,
        signatureName,
        sbomName,
        sbomSha256,
        sbomSignatureName,
        nativeSigning: metadata.artifact.nativeSigning,
        notarized: metadata.artifact.notarized,
      });
    }
    checksumEntries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
    );
    const checksumsPath = NodePath.join(staging, CHECKSUMS_NAME);
    await NodeFSP.writeFile(
      checksumsPath,
      checksumEntries.map((entry) => `${entry.sha256}  ${entry.name}\n`).join(""),
    );
    const checksumsSha256 = await sha256File(checksumsPath);
    const checksumsSignatureName = `${CHECKSUMS_NAME}${SIGNATURE_SUFFIX}`;
    if (input.channel !== "unsigned-test") {
      await dependencies.signFile({
        path: checksumsPath,
        signaturePath: NodePath.join(staging, checksumsSignatureName),
        trustedComment: `bibcode-server checksums ${first.sourceSha}`,
      });
    }
    records.sort((left, right) =>
      Buffer.compare(Buffer.from(left.downloadName), Buffer.from(right.downloadName)),
    );
    const manifestValue = {
      schemaVersion: 1 as const,
      product: "bibcode-server" as const,
      version: first.version,
      channel: input.channel,
      sourceSha: first.sourceSha,
      generatedAt: input.generatedAt,
      requiredMatrix: records.map(({ targetTriple, os, architecture, format }) => ({
        targetTriple,
        os,
        architecture,
        format,
      })),
      artifacts: records,
      checksumsName: CHECKSUMS_NAME,
      checksumsSha256,
      checksumsSignatureName,
      manifestSignatureName: `${MANIFEST_NAME}${SIGNATURE_SUFFIX}`,
    };
    const manifest = decodeManifest(manifestValue);
    const manifestPath = NodePath.join(staging, MANIFEST_NAME);
    await NodeFSP.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (input.channel !== "unsigned-test") {
      await dependencies.signFile({
        path: manifestPath,
        signaturePath: NodePath.join(staging, manifest.manifestSignatureName),
        trustedComment: `bibcode-server manifest ${first.sourceSha}`,
      });
    }
    await NodeFSP.rm(NodePath.join(staging, ".sbom-work"), { recursive: true, force: true });
    await NodeFSP.rename(staging, outputDir);
    return { manifest, outputDir };
  } catch (error) {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    throw error;
  }
};

export async function finalizeServerArtifacts(
  input: FinalizeServerArtifactsInput,
  dependencies: FinalizeServerArtifactsDependencies = {},
): Promise<FinalizedServerArtifacts> {
  const repoRoot = NodePath.resolve(
    input.repoRoot ?? NodeURL.fileURLToPath(new URL("..", import.meta.url)),
  );
  const generateSbom =
    dependencies.generateSbom ??
    ((request: GenerateSbomRequest) =>
      generateServerSbom({
        repoRoot,
        workRoot: request.workRoot,
        targetTriple: request.metadata.targetTriple,
        version: request.metadata.version,
        sourceDateEpoch: request.metadata.sourceDateEpoch,
        artifact: request.artifact,
        outputPath: request.outputPath,
      }));
  if (dependencies.signFile !== undefined || input.channel === "unsigned-test") {
    return finalizeWithSigner(input, {
      generateSbom,
      signFile:
        dependencies.signFile ??
        (() => Promise.reject(new Error("Unsigned-test output cannot invoke a signer."))),
    });
  }
  const configuration = resolveServerDetachedSigningConfiguration(
    input.channel,
    input.env ?? process.env,
  );
  if (configuration === null)
    return fail("Signed server artifact finalization has no signing key.");
  const publicKeyPath = NodePath.join(repoRoot, "packaging/server/server-release.pub");
  if (!NodeFS.existsSync(publicKeyPath) || !isPlainFile(publicKeyPath)) {
    return fail("The checked-in server release public key is missing.");
  }
  const temporaryParent = NodePath.dirname(NodePath.resolve(input.outputDir));
  await NodeFSP.mkdir(temporaryParent, { recursive: true });
  return withDefaultSigner({
    configuration,
    publicKeyPath,
    temporaryParent,
    run: (signFile) => finalizeWithSigner(input, { generateSbom, signFile }),
  });
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
const modulePath = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  finalizeServerArtifacts(parseFinalizeServerArtifactsCliArgs(process.argv.slice(2)))
    .then(({ outputDir }) => process.stdout.write(`${outputDir}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Server artifact finalization failed."}\n`,
      );
      process.exitCode = 1;
    });
}
