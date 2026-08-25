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

const ArtifactFileNameSchema = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      (value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\")) ||
      "Artifact names must be single safe file names.",
  ),
);

const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const ServerArtifactRecordSchema = Schema.Struct({
  product: ServerArtifactProductSchema,
  version: TrimmedNonEmptyString,
  os: ServerArtifactOsSchema,
  architecture: ServerArtifactArchitectureSchema,
  format: ServerArtifactFormatSchema,
  downloadName: ArtifactFileNameSchema,
  size: PositiveInt,
  sha256: Sha256Schema,
  signatureName: ArtifactFileNameSchema,
}).check(
  Schema.makeFilter(
    ({ os, architecture }) =>
      architecture !== "universal" ||
      os === "macos" ||
      "Universal server artifacts are valid only for macOS.",
  ),
);
export type ServerArtifactRecord = typeof ServerArtifactRecordSchema.Type;

export const ServerArtifactManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  product: ServerArtifactProductSchema,
  version: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  artifacts: Schema.Array(ServerArtifactRecordSchema),
}).check(
  Schema.makeFilter((manifest) => {
    const keys = new Set<string>();
    for (const artifact of manifest.artifacts) {
      if (artifact.product !== manifest.product || artifact.version !== manifest.version) {
        return "Every artifact must match the manifest product and version.";
      }
      const key = `${artifact.os}:${artifact.architecture}:${artifact.format}`;
      if (keys.has(key)) {
        return "A manifest cannot contain duplicate OS/architecture/format records.";
      }
      keys.add(key);
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
        architectureMatches) ||
      "The selected artifact must match the requested product, version, OS, and architecture."
    );
  }),
);
export type ServerArtifactSelection = typeof ServerArtifactSelectionSchema.Type;
