import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ServerArtifactProductSchema = Schema.Literal("bibcode-server");
export type ServerArtifactProduct = typeof ServerArtifactProductSchema.Type;

export const ServerArtifactOsSchema = Schema.Literals(["linux", "macos", "windows"]);
export type ServerArtifactOs = typeof ServerArtifactOsSchema.Type;

export const ServerArtifactArchitectureSchema = Schema.Literals(["x86_64", "aarch64", "universal"]);
export type ServerArtifactArchitecture = typeof ServerArtifactArchitectureSchema.Type;

export const ServerArtifactFormatSchema = Schema.Literals([
  "zip",
  "tar.gz",
  "msi",
  "pkg",
  "deb",
  "rpm",
]);
export type ServerArtifactFormat = typeof ServerArtifactFormatSchema.Type;

export const ServerArtifactChannelSchema = Schema.Literals([
  "stable",
  "beta",
  "nightly",
  "unsigned-test",
]);
export type ServerArtifactChannel = typeof ServerArtifactChannelSchema.Type;

export const NativeBinarySigningSchema = Schema.Literals([
  "none",
  "adhoc",
  "authenticode",
  "developer-id",
]);
export const NativePackageSigningSchema = Schema.Literals(["none", "authenticode", "developer-id"]);
export const NativeSigningStateSchema = Schema.Struct({
  binary: NativeBinarySigningSchema,
  package: NativePackageSigningSchema,
  verified: Schema.Boolean,
}).check(
  Schema.makeFilter(({ binary, package: packageSigning, verified }) => {
    const requiresVerification =
      binary === "authenticode" || binary === "developer-id" || packageSigning !== "none";
    return (
      verified === requiresVerification ||
      "Verified must be true exactly when a native certificate signature is present."
    );
  }),
);
export type NativeSigningState = typeof NativeSigningStateSchema.Type;

export const SafeArtifactBasename = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value) && value !== "." && value !== "..") ||
      "Artifact names must be single portable ASCII file names.",
  ),
);

export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const SourceSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));

const expectedTargetTriple = (
  os: ServerArtifactOs,
  architecture: ServerArtifactArchitecture,
): string | undefined => {
  switch (`${os}:${architecture}`) {
    case "windows:x86_64":
      return "x86_64-pc-windows-msvc";
    case "windows:aarch64":
      return "aarch64-pc-windows-msvc";
    case "macos:x86_64":
      return "x86_64-apple-darwin";
    case "macos:aarch64":
      return "aarch64-apple-darwin";
    case "macos:universal":
      return "universal-apple-darwin";
    case "linux:x86_64":
      return "x86_64-unknown-linux-gnu";
    case "linux:aarch64":
      return "aarch64-unknown-linux-gnu";
    default:
      return undefined;
  }
};

const formatMatchesOs = (os: ServerArtifactOs, format: ServerArtifactFormat): boolean => {
  switch (format) {
    case "zip":
    case "msi":
      return os === "windows";
    case "pkg":
      return os === "macos";
    case "deb":
    case "rpm":
      return os === "linux";
    case "tar.gz":
      return os === "macos" || os === "linux";
  }
};

export const ServerArtifactRequirementSchema = Schema.Struct({
  targetTriple: TrimmedNonEmptyString,
  os: ServerArtifactOsSchema,
  architecture: ServerArtifactArchitectureSchema,
  format: ServerArtifactFormatSchema,
}).check(
  Schema.makeFilter(
    ({ targetTriple, os, architecture, format }) =>
      (expectedTargetTriple(os, architecture) === targetTriple && formatMatchesOs(os, format)) ||
      "The required artifact tuple has an invalid target triple or OS format.",
  ),
);
export type ServerArtifactRequirement = typeof ServerArtifactRequirementSchema.Type;

export const ServerArtifactRecordSchema = Schema.Struct({
  product: ServerArtifactProductSchema,
  version: TrimmedNonEmptyString,
  sourceSha: SourceSha,
  targetTriple: TrimmedNonEmptyString,
  os: ServerArtifactOsSchema,
  architecture: ServerArtifactArchitectureSchema,
  format: ServerArtifactFormatSchema,
  downloadName: SafeArtifactBasename,
  size: PositiveInt,
  sha256: Sha256Hex,
  signatureName: SafeArtifactBasename,
  sbomName: SafeArtifactBasename,
  nativeSigning: NativeSigningStateSchema,
  notarized: Schema.Boolean,
}).check(
  Schema.makeFilter((record) => {
    if (
      expectedTargetTriple(record.os, record.architecture) !== record.targetTriple ||
      !formatMatchesOs(record.os, record.format)
    ) {
      return "The artifact target triple or format does not match its OS and architecture.";
    }
    if (
      new Set([record.downloadName, record.signatureName, record.sbomName]).size !== 3 ||
      (record.notarized &&
        (record.os !== "macos" ||
          record.nativeSigning.package !== "developer-id" ||
          !record.nativeSigning.verified))
    ) {
      return "Artifact links and notarization state must be internally consistent.";
    }
    return true;
  }),
);
export type ServerArtifactRecord = typeof ServerArtifactRecordSchema.Type;

const tupleKey = ({ targetTriple, os, architecture, format }: ServerArtifactRequirement): string =>
  `${targetTriple}:${os}:${architecture}:${format}`;

export const ServerArtifactManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  product: ServerArtifactProductSchema,
  version: TrimmedNonEmptyString,
  channel: ServerArtifactChannelSchema,
  sourceSha: SourceSha,
  generatedAt: IsoDateTime,
  requiredMatrix: Schema.Array(ServerArtifactRequirementSchema).check(Schema.isMinLength(1)),
  artifacts: Schema.Array(ServerArtifactRecordSchema).check(Schema.isMinLength(1)),
  manifestSignatureName: SafeArtifactBasename,
}).check(
  Schema.makeFilter((manifest) => {
    const required = new Set<string>();
    for (const tuple of manifest.requiredMatrix) {
      const key = tupleKey(tuple);
      if (required.has(key)) {
        return "The required server artifact matrix cannot contain duplicate tuples.";
      }
      required.add(key);
    }
    const records = new Set<string>();
    const linkedNames = new Set<string>([manifest.manifestSignatureName]);
    for (const artifact of manifest.artifacts) {
      if (
        artifact.product !== manifest.product ||
        artifact.version !== manifest.version ||
        artifact.sourceSha !== manifest.sourceSha
      ) {
        return "Every artifact must match the manifest product, version, and source SHA.";
      }
      const key = tupleKey(artifact);
      const names = [artifact.downloadName, artifact.signatureName, artifact.sbomName];
      if (required.has(key) && !records.has(key) && names.every((name) => !linkedNames.has(name))) {
        records.add(key);
        names.forEach((name) => linkedNames.add(name));
      } else {
        return "Artifacts must match the required matrix exactly without duplicate linked names or tuples.";
      }
      if (
        manifest.channel === "stable" &&
        artifact.os === "windows" &&
        (artifact.nativeSigning.binary !== "authenticode" ||
          !artifact.nativeSigning.verified ||
          (artifact.format === "msi" && artifact.nativeSigning.package !== "authenticode"))
      ) {
        return "Stable Windows binaries and MSI packages must be Authenticode verified.";
      }
    }
    if (records.size !== required.size) {
      return "Every required server artifact tuple must have exactly one record.";
    }
    const hasUniversal = manifest.artifacts.some(
      (artifact) => artifact.architecture === "universal",
    );
    if (
      hasUniversal &&
      !(["x86_64", "aarch64"] as const).every((architecture) =>
        manifest.artifacts.some(
          (artifact) => artifact.os === "macos" && artifact.architecture === architecture,
        ),
      )
    ) {
      return "A universal macOS artifact requires both verified architecture slices.";
    }
    return true;
  }),
);
export type ServerArtifactManifest = typeof ServerArtifactManifestSchema.Type;

export const ServerArtifactTargetSchema = Schema.Struct({
  product: ServerArtifactProductSchema,
  version: TrimmedNonEmptyString,
  os: ServerArtifactOsSchema,
  architecture: Schema.Literals(["x86_64", "aarch64"]),
  preferredFormats: Schema.Array(ServerArtifactFormatSchema).check(Schema.isMinLength(1)),
});
export type ServerArtifactTarget = typeof ServerArtifactTargetSchema.Type;

export const ServerArtifactSelectionSchema = Schema.Struct({
  target: ServerArtifactTargetSchema,
  artifact: ServerArtifactRecordSchema,
}).check(
  Schema.makeFilter(({ target, artifact }) => {
    const architectureMatches =
      artifact.architecture === target.architecture ||
      (artifact.os === "macos" && artifact.architecture === "universal");
    return (
      (artifact.product === target.product &&
        artifact.version === target.version &&
        artifact.os === target.os &&
        architectureMatches &&
        target.preferredFormats.includes(artifact.format)) ||
      "The selected artifact must match the requested tuple and preferred formats."
    );
  }),
);
export type ServerArtifactSelection = typeof ServerArtifactSelectionSchema.Type;
