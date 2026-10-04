// @effect-diagnostics nodeBuiltinImport:off - Read only the owned immutable CI inputs and generated fixture metadata.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  prepareSettingsVisualProviders,
  type SettingsVisualProviderSeedInput,
} from "./release-visual-settings-fixture.ts";

export interface SettingsVisualPreflightInput extends Omit<
  SettingsVisualProviderSeedInput,
  "guardedCli" | "generatedClaude"
> {
  binary: string;
  evidence: string;
  source: string;
}
/** Existing Python-owner provenance is joined to actual files, never replaced by positive flags. */
export function readSettingsVisualProviderConfiguration(input: SettingsVisualPreflightInput) {
  const refused = () => new Error("Owned settings fixture preflight refused.");
  try {
    const directory = (path: string) => {
      const stat = NodeFS.lstatSync(path);
      if (
        !NodePath.isAbsolute(path) ||
        NodeFS.realpathSync(path) !== path ||
        !stat.isDirectory() ||
        stat.isSymbolicLink()
      )
        throw refused();
    };
    for (const path of [
      input.fixtureRoot,
      input.runRoot,
      input.shimDirectory,
      input.home,
      input.binDirectory,
      input.evidence,
    ])
      directory(path);
    const file = (path: string, maximum: number) => {
      const stat = NodeFS.lstatSync(path);
      if (
        NodeFS.realpathSync(path) !== path ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size < 1 ||
        stat.size > maximum
      )
        throw refused();
      return stat;
    };
    const receiptPath = NodePath.join(input.evidence, "provenance.json");
    file(receiptPath, 65_536);
    const provenance = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8"));
    if (
      !provenance ||
      typeof provenance !== "object" ||
      provenance.scenario !== "release-visual-settings" ||
      !/^[0-9a-f]{40}$/.test(input.source) ||
      provenance.source !== input.source ||
      provenance.guardMode !== "default Abort" ||
      !/^[0-9a-f]{64}$/.test(provenance.inputs?.serverSha256 ?? "") ||
      input.childEnv.BIBCODE_HERMETIC_GUARD !== undefined
    )
      throw refused();
    const binaryStat = file(input.binary, 256 * 1024 * 1024);
    NodeFS.accessSync(input.binary, NodeFS.constants.X_OK);
    const digest = NodeCrypto.createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024);
    const fd = NodeFS.openSync(input.binary, "r");
    try {
      const opened = NodeFS.fstatSync(fd);
      if (
        opened.dev !== binaryStat.dev ||
        opened.ino !== binaryStat.ino ||
        opened.size !== binaryStat.size
      )
        throw refused();
      let size = 0,
        read: number;
      while ((read = NodeFS.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        size += read;
        if (size > binaryStat.size) throw refused();
        digest.update(buffer.subarray(0, read));
      }
      const after = NodeFS.fstatSync(fd);
      if (
        size !== binaryStat.size ||
        after.size !== binaryStat.size ||
        after.mtimeMs !== binaryStat.mtimeMs ||
        digest.digest("hex") !== provenance.inputs.serverSha256
      )
        throw refused();
    } finally {
      NodeFS.closeSync(fd);
    }
    const launcherPath = NodePath.join(input.shimDirectory, "claude"),
      fixturePath = NodePath.join(input.shimDirectory, "claude-fixture.mjs");
    const launcher = file(launcherPath, 4096),
      fixture = file(fixturePath, 65_536);
    NodeFS.accessSync(launcherPath, NodeFS.constants.X_OK);
    return prepareSettingsVisualProviders({
      ...input,
      guardedCli: {
        path: input.binary,
        guardMode: provenance.guardMode,
        executableVerified: (binaryStat.mode & 0o111) !== 0,
      },
      generatedClaude: {
        launcherPath,
        fixturePath,
        launcherContents: NodeFS.readFileSync(launcherPath, "utf8"),
        fixtureContents: NodeFS.readFileSync(fixturePath, "utf8"),
        launcherRegular: launcher.isFile(),
        launcherExecutable: (launcher.mode & 0o111) !== 0,
        launcherSymlink: launcher.isSymbolicLink(),
        fixtureRegular: fixture.isFile(),
        fixtureSymlink: fixture.isSymbolicLink(),
      },
    });
  } catch {
    throw refused();
  }
}
