#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone assembler owns release filesystem boundaries.
// @effect-diagnostics globalConsole:off - The CLI reports bounded assembly errors and output metadata.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

import {
  RELEASE_TARGETS,
  TAURI_UPDATE_TARGETS,
  symbolArchiveName,
  type TauriUpdaterTarget,
} from "./lib/release-targets.ts";

const UpdaterDescriptorSchema = Schema.Struct({
  target: Schema.Literals(TAURI_UPDATE_TARGETS),
  artifact: Schema.String,
  signature: Schema.String,
});
const decodeUpdaterDescriptor = Schema.decodeUnknownSync(UpdaterDescriptorSchema);

export interface ReleaseAssetAssemblyInput {
  readonly assetsDir: string;
  readonly version: string;
  readonly updater: boolean;
  readonly stepSummaryPath?: string;
}

export interface ReleaseAssetAssemblyResult {
  readonly publishedAssets: ReadonlyArray<string>;
}

export class ReleaseAssetAssemblyError extends Error {
  override readonly name = "ReleaseAssetAssemblyError";
}

/** The desktop Breakpad symbol archives, one per release target. */
export function expectedSymbolAssetNames(version: string): ReadonlyArray<string> {
  return RELEASE_TARGETS.map((target) => symbolArchiveName("desktop", version, target));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireOne(entries: ReadonlyArray<string>, pattern: RegExp, label: string): string {
  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length !== 1) {
    throw new ReleaseAssetAssemblyError(`Expected exactly one ${label}, found ${matches.length}.`);
  }
  return matches[0]!;
}

function expectedDesktopAssets(
  entries: ReadonlyArray<string>,
  version: string,
): {
  readonly installers: ReadonlySet<string>;
  readonly updaterPayloads: Record<TauriUpdaterTarget, string>;
} {
  const escaped = escapeRegex(version);
  const macArm64 = requireOne(
    entries,
    new RegExp(`^BiBCode_${escaped}_(?:aarch64|arm64)\\.dmg$`),
    "macOS ARM64 DMG",
  );
  const macX64 = requireOne(
    entries,
    new RegExp(`^BiBCode_${escaped}_(?:x64|x86_64)\\.dmg$`),
    "macOS x64 DMG",
  );
  const linuxArm64 = requireOne(
    entries,
    new RegExp(`^BiBCode_${escaped}_(?:aarch64|arm64)\\.AppImage$`),
    "Linux ARM64 AppImage",
  );
  const linuxX64 = requireOne(
    entries,
    new RegExp(`^BiBCode_${escaped}_(?:amd64|x64|x86_64)\\.AppImage$`),
    "Linux x64 AppImage",
  );
  const winArm64 = requireOne(
    entries,
    new RegExp(`^BiBCode_${escaped}_arm64-setup\\.exe$`),
    "Windows ARM64 NSIS",
  );
  const winX64 = requireOne(
    entries,
    new RegExp(`^BiBCode_${escaped}_x64-setup\\.exe$`),
    "Windows x64 NSIS",
  );
  return {
    installers: new Set([macArm64, macX64, linuxArm64, linuxX64, winArm64, winX64]),
    updaterPayloads: {
      "darwin-aarch64": "bibcode-update-darwin-aarch64.app.tar.gz",
      "darwin-x86_64": "bibcode-update-darwin-x86_64.app.tar.gz",
      "linux-aarch64": linuxArm64,
      "linux-x86_64": linuxX64,
      "windows-aarch64": winArm64,
      "windows-x86_64": winX64,
    },
  };
}

function parseUpdaterDescriptor(descriptorPath: string, descriptorName: string) {
  try {
    return decodeUpdaterDescriptor(JSON.parse(NodeFS.readFileSync(descriptorPath, "utf8")));
  } catch (error) {
    throw new ReleaseAssetAssemblyError(
      `Invalid updater descriptor ${descriptorName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function assembleReleaseAssets(
  input: ReleaseAssetAssemblyInput,
): Promise<ReleaseAssetAssemblyResult> {
  const assetsDir = NodePath.resolve(input.assetsDir);
  const initialEntries = NodeFS.readdirSync(assetsDir).toSorted();
  const symbolAssets = expectedSymbolAssetNames(input.version);
  for (const asset of symbolAssets) {
    if (!initialEntries.includes(asset)) {
      throw new ReleaseAssetAssemblyError(`Missing symbol release asset ${asset}.`);
    }
  }
  const { installers: desktopAssets, updaterPayloads } = expectedDesktopAssets(
    initialEntries,
    input.version,
  );
  const descriptorNames = new Set(TAURI_UPDATE_TARGETS.map((target) => `updater-${target}.json`));
  const updaterArtifacts = new Set<string>();
  if (input.updater) {
    if (!initialEntries.includes("latest.json")) {
      throw new ReleaseAssetAssemblyError("Stable updater assembly requires latest.json.");
    }
    for (const target of TAURI_UPDATE_TARGETS) {
      const descriptor = `updater-${target}.json`;
      if (!initialEntries.includes(descriptor)) {
        throw new ReleaseAssetAssemblyError(`Missing internal updater descriptor ${descriptor}.`);
      }
      const decoded = parseUpdaterDescriptor(NodePath.join(assetsDir, descriptor), descriptor);
      if (decoded.target !== target) {
        throw new ReleaseAssetAssemblyError(`Updater descriptor target mismatch in ${descriptor}.`);
      }
      const expectedPayload = updaterPayloads[target];
      if (decoded.artifact !== expectedPayload) {
        throw new ReleaseAssetAssemblyError(
          `Updater artifact mismatch in ${descriptor}: expected ${expectedPayload}, got ${decoded.artifact}.`,
        );
      }
      if (decoded.signature !== `${decoded.artifact}.sig`) {
        throw new ReleaseAssetAssemblyError(`Updater signature mismatch in ${descriptor}.`);
      }
      for (const asset of [decoded.artifact, decoded.signature]) {
        if (!initialEntries.includes(asset)) {
          throw new ReleaseAssetAssemblyError(`Missing updater asset ${asset}.`);
        }
        updaterArtifacts.add(asset);
      }
    }
  }

  const allowed = new Set([...symbolAssets, ...desktopAssets]);
  for (const updaterArtifact of updaterArtifacts) allowed.add(updaterArtifact);
  if (input.updater) {
    allowed.add("latest.json");
    for (const descriptor of descriptorNames) {
      allowed.add(descriptor);
    }
  }
  for (const entry of initialEntries) {
    if (allowed.has(entry)) {
      continue;
    }
    throw new ReleaseAssetAssemblyError(`Unexpected release asset ${entry}.`);
  }

  if (input.updater) {
    for (const descriptor of descriptorNames) {
      await NodeFS.promises.rm(NodePath.join(assetsDir, descriptor));
    }
  }

  const publishedAssets = NodeFS.readdirSync(assetsDir).toSorted();
  if (input.stepSummaryPath !== undefined) {
    await NodeFS.promises.appendFile(
      input.stepSummaryPath,
      `Assembled ${publishedAssets.length} desktop release assets${input.updater ? " with stable updater metadata" : ""}.\n`,
    );
  }
  return {
    publishedAssets,
  };
}

function parseArguments(argv: ReadonlyArray<string>): ReleaseAssetAssemblyInput {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      "assets-dir": { type: "string" },
      version: { type: "string" },
      updater: { type: "boolean" },
      "step-summary": { type: "string" },
    },
  });
  if (typeof values["assets-dir"] !== "string" || typeof values.version !== "string") {
    throw new ReleaseAssetAssemblyError("--assets-dir and --version are required.");
  }
  return {
    assetsDir: values["assets-dir"],
    version: values.version,
    updater: values.updater === true,
    ...(typeof values["step-summary"] === "string"
      ? { stepSummaryPath: values["step-summary"] }
      : {}),
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  assembleReleaseAssets(parseArguments(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
