#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const SERVER_RUST_SBOM_TOOL_VERSION = "0.5.9";
export const SERVER_CYCLONEDX_CLI_VERSION = "0.32.0";

const MAX_SBOM_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const SERVER_SBOM_TIMEOUT_MS = 10 * 60_000;

export interface ServerSbomCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ServerSbomCommandPlan {
  readonly rust: ServerSbomCommand;
  readonly web: ServerSbomCommand;
  readonly merge: ServerSbomCommand;
  readonly rustBomPath: string;
  readonly webBomPath: string;
  readonly mergedBomPath: string;
}

export interface ServerFileInventoryRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ServerSbomArtifactBinding {
  readonly downloadName: string;
  readonly version: string;
  readonly sourceSha: string;
  readonly targetTriple: string;
  readonly size: number;
  readonly sha256: string;
  readonly fileInventory: ReadonlyArray<ServerFileInventoryRecord>;
}

export interface ResolveServerSbomCommandPlanInput {
  readonly repoRoot: string;
  readonly workRoot: string;
  readonly targetTriple: string;
  readonly version: string;
  readonly sourceDateEpoch: number;
}

export interface GenerateServerSbomInput extends ResolveServerSbomCommandPlanInput {
  readonly artifact: ServerSbomArtifactBinding;
  readonly outputPath: string;
}

export type ServerSbomCommandRunner = (command: ServerSbomCommand) => Promise<void>;

type JsonRecord = Record<string, unknown>;

const fail = (message: string): never => {
  throw new Error(message);
};

const plainRecord = (value: unknown, label: string): JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
};

const safeSha256 = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);
const safeSourceSha = (value: string): boolean => /^[a-f0-9]{40}$/u.test(value);
const safeArtifactName = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value) && value !== "." && value !== "..";

export function resolveServerSbomCommandPlan(
  input: ResolveServerSbomCommandPlanInput,
): ServerSbomCommandPlan {
  if (!Number.isSafeInteger(input.sourceDateEpoch) || input.sourceDateEpoch <= 0) {
    return fail("The server SBOM source date epoch must be a positive integer.");
  }
  if (!/^[A-Za-z0-9_+.-]+$/u.test(input.targetTriple)) {
    return fail("The server SBOM target triple is invalid.");
  }
  const repoRoot = NodePath.resolve(input.repoRoot);
  const workRoot = NodePath.resolve(input.workRoot);
  const rustBomPath = NodePath.join(workRoot, "rust.cdx.json");
  const webBomPath = NodePath.join(workRoot, "web.cdx.json");
  const mergedBomPath = NodePath.join(workRoot, "merged.cdx.json");
  return {
    rustBomPath,
    webBomPath,
    mergedBomPath,
    rust: {
      command: "cargo",
      args: [
        "cyclonedx",
        "--quiet",
        "--manifest-path",
        NodePath.join(repoRoot, "apps/server/Cargo.toml"),
        "--format",
        "json",
        "--describe",
        "binaries",
        "--target",
        input.targetTriple,
        "--override-filename",
        rustBomPath,
        "--spec-version",
        "1.5",
      ],
      cwd: repoRoot,
      env: {
        ...process.env,
        CARGO_BUILD_TARGET: input.targetTriple,
        SOURCE_DATE_EPOCH: String(input.sourceDateEpoch),
      },
    },
    web: {
      command: "pnpm",
      args: [
        "sbom",
        "--filter",
        "@bibcode/web",
        "--prod",
        "--sbom-format",
        "cyclonedx",
        "--sbom-spec-version",
        "1.7",
        "--sbom-type",
        "application",
        "--out",
        webBomPath,
      ],
      cwd: repoRoot,
    },
    merge: {
      command: "cyclonedx",
      args: [
        "merge",
        "--input-files",
        rustBomPath,
        webBomPath,
        "--output-file",
        mergedBomPath,
        "--input-format",
        "json",
        "--output-format",
        "json",
        "--output-version",
        "v1_7",
        "--hierarchical",
        "--group",
        "BiBCode",
        "--name",
        "bibcode-server",
        "--version",
        input.version,
      ],
      cwd: repoRoot,
    },
  };
}

const componentIdentity = (component: JsonRecord): string =>
  `${String(component.name ?? "")} ${String(component.purl ?? "")}`.toLocaleLowerCase("en-US");

const forbiddenProductionIdentityMarkers = [
  "tauri",
  ["bibcode", "connect"].join(" "),
  ["bibcode", "connect"].join("-"),
  ["bibcode", "connect"].join("_"),
  ["tele", "metry"].join(""),
  ["opentele", "metry"].join(""),
  "sentry",
] as const;

const forbiddenProductionComponent = (component: JsonRecord): boolean => {
  const identity = componentIdentity(component);
  const name = String(component.name ?? "").toLocaleLowerCase("en-US");
  return (
    name === "node" ||
    name === "node.js" ||
    forbiddenProductionIdentityMarkers.some((marker) => identity.includes(marker))
  );
};

const componentPurl = (component: JsonRecord): string => String(component.purl ?? "");

const isKnownUnshippedServerWebComponent = (component: JsonRecord): boolean =>
  componentPurl(component).startsWith("pkg:npm/%40tauri-apps/api@");

export function pruneKnownUnshippedServerWebComponents(value: unknown): JsonRecord {
  const document = plainRecord(value, "The merged server SBOM");
  const rawComponents = Array.isArray(document.components) ? document.components : [];
  const components = rawComponents.map((component) => plainRecord(component, "SBOM component"));
  const excluded = components.filter(isKnownUnshippedServerWebComponent);
  if (excluded.length === 0) return document;
  const excludedReferences = new Set(
    excluded
      .map((component) => component["bom-ref"])
      .filter((reference): reference is string => typeof reference === "string"),
  );
  const dependencies = Array.isArray(document.dependencies)
    ? document.dependencies.map((dependency) => plainRecord(dependency, "SBOM dependency"))
    : [];
  const metadata = plainRecord(document.metadata, "The merged server SBOM metadata");
  const existingProperties = Array.isArray(metadata.properties) ? metadata.properties : [];
  return {
    ...document,
    metadata: {
      ...metadata,
      properties: [
        ...existingProperties,
        ...excluded.map((component) => ({
          name: "bibcode:excludedUnshippedDeclaredDependency",
          value: componentPurl(component),
        })),
      ],
    },
    components: components.filter((component) => !isKnownUnshippedServerWebComponent(component)),
    dependencies: dependencies
      .filter((dependency) => !excludedReferences.has(String(dependency.ref ?? "")))
      .map((dependency) => ({
        ...dependency,
        ...(Array.isArray(dependency.dependsOn)
          ? {
              dependsOn: dependency.dependsOn.filter(
                (reference) => typeof reference !== "string" || !excludedReferences.has(reference),
              ),
            }
          : {}),
      })),
  };
}

const validateDependencyCoverage = (components: ReadonlyArray<JsonRecord>): void => {
  const hasRustRoot = components.some((component) =>
    componentPurl(component).startsWith("pkg:cargo/bibcode-server@"),
  );
  const hasRustDependency = components.some((component) => {
    const purl = componentPurl(component);
    return purl.startsWith("pkg:cargo/") && !purl.startsWith("pkg:cargo/bibcode-server@");
  });
  const hasWebRoot = components.some((component) =>
    componentPurl(component).startsWith("pkg:npm/%40bibcode/web@"),
  );
  const hasWebDependency = components.some((component) => {
    const purl = componentPurl(component);
    return purl.startsWith("pkg:npm/") && !purl.startsWith("pkg:npm/%40bibcode/web@");
  });
  if (!hasRustRoot || !hasRustDependency || !hasWebRoot || !hasWebDependency) {
    fail("The server SBOM must retain representative Rust and web dependency graphs.");
  }
};

const validateInventoryRecord = (record: ServerFileInventoryRecord): void => {
  const normalized = record.path.replaceAll("\\", "/");
  if (
    normalized !== record.path ||
    normalized.startsWith("/") ||
    normalized
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..") ||
    !Number.isSafeInteger(record.size) ||
    record.size <= 0 ||
    !safeSha256(record.sha256)
  ) {
    fail(`The staged server file inventory contains an invalid record: ${record.path}.`);
  }
};

export function bindServerArtifactSbom(input: {
  readonly merged: unknown;
  readonly artifact: ServerSbomArtifactBinding;
}): JsonRecord {
  const merged = plainRecord(input.merged, "The merged server SBOM");
  if (merged.bomFormat !== "CycloneDX" || merged.specVersion !== "1.7") {
    return fail("The merged server SBOM must be CycloneDX 1.7 JSON.");
  }
  if (
    !safeArtifactName(input.artifact.downloadName) ||
    !safeSourceSha(input.artifact.sourceSha) ||
    !safeSha256(input.artifact.sha256) ||
    !Number.isSafeInteger(input.artifact.size) ||
    input.artifact.size <= 0
  ) {
    return fail("The server SBOM artifact binding is invalid.");
  }
  const metadata = plainRecord(merged.metadata, "The merged server SBOM metadata");
  const rootComponent = plainRecord(metadata.component, "The merged server SBOM root component");
  const rawComponents = Array.isArray(merged.components) ? merged.components : [];
  const components = [
    rootComponent,
    ...rawComponents.map((value) => plainRecord(value, "SBOM component")),
  ];
  const forbidden = components.find(forbiddenProductionComponent);
  if (forbidden !== undefined) {
    return fail(
      `The SBOM contains a forbidden production server component: ${String(forbidden.name ?? "unknown")}.`,
    );
  }
  validateDependencyCoverage(components);

  const inventoryPaths = new Set<string>();
  const inventoryComponents = input.artifact.fileInventory.map((record) => {
    validateInventoryRecord(record);
    if (inventoryPaths.has(record.path)) {
      return fail(`The staged server file inventory contains a duplicate path: ${record.path}.`);
    }
    inventoryPaths.add(record.path);
    return {
      type: "file",
      name: record.path,
      "bom-ref": `urn:bibcode:file:${record.sha256}:${encodeURIComponent(record.path)}`,
      hashes: [{ alg: "SHA-256", content: record.sha256 }],
      properties: [{ name: "bibcode:size", value: String(record.size) }],
    };
  });
  const dependencyComponents = rawComponents.map((value) => plainRecord(value, "SBOM component"));
  const allComponents = [...dependencyComponents, ...inventoryComponents];
  const artifactReference = `urn:bibcode:artifact:${input.artifact.sha256}`;
  const dependencyReferences = allComponents
    .map((component) => component["bom-ref"])
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return {
    ...merged,
    version: 1,
    metadata: {
      ...metadata,
      component: {
        type: "application",
        name: input.artifact.downloadName,
        version: input.artifact.version,
        "bom-ref": artifactReference,
        hashes: [{ alg: "SHA-256", content: input.artifact.sha256 }],
        properties: [
          { name: "bibcode:sourceSha", value: input.artifact.sourceSha },
          { name: "bibcode:targetTriple", value: input.artifact.targetTriple },
          { name: "bibcode:size", value: String(input.artifact.size) },
        ],
      },
    },
    components: allComponents,
    dependencies: [
      ...(Array.isArray(merged.dependencies) ? merged.dependencies : []),
      { ref: artifactReference, dependsOn: dependencyReferences },
    ],
  };
}

const defaultCommandRunner: ServerSbomCommandRunner = (command) =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command.command,
      [...command.args],
      {
        cwd: command.cwd,
        ...(command.env ? { env: command.env } : {}),
        encoding: "utf8",
        maxBuffer: MAX_SBOM_COMMAND_OUTPUT_BYTES,
        shell: false,
        timeout: SERVER_SBOM_TIMEOUT_MS,
        windowsHide: true,
      },
      (error) => {
        if (error)
          reject(new Error(`Server SBOM command failed: ${NodePath.basename(command.command)}.`));
        else resolve();
      },
    );
  });

export async function generateServerSbom(
  input: GenerateServerSbomInput,
  commandRunner: ServerSbomCommandRunner = defaultCommandRunner,
): Promise<void> {
  const plan = resolveServerSbomCommandPlan(input);
  await NodeFSP.mkdir(NodePath.resolve(input.workRoot), { recursive: true });
  await commandRunner(plan.rust);
  await commandRunner(plan.web);
  await commandRunner(plan.merge);
  const merged = JSON.parse(await NodeFSP.readFile(plan.mergedBomPath, "utf8")) as unknown;
  const pruned = pruneKnownUnshippedServerWebComponents(merged);
  const bound = bindServerArtifactSbom({ merged: pruned, artifact: input.artifact });
  await NodeFSP.writeFile(
    NodePath.resolve(input.outputPath),
    `${JSON.stringify(bound, null, 2)}\n`,
  );
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
const modulePath = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  process.stderr.write(
    "generate-server-sbom is an internal library entry point; use sign-server-artifacts to finalize a release set.\n",
  );
  process.exitCode = 2;
}
