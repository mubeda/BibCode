// @effect-diagnostics nodeBuiltinImport:off - Test-owned filesystem proofs only; no Git/provider/server launches.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  readSettingsVisualProviderConfiguration,
  type SettingsVisualPreflightInput,
} from "./release-visual-settings-preflight.ts";

function fixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-owner-proof-")),
  );
  const runRoot = NodePath.join(root, "light"),
    shimDirectory = NodePath.join(runRoot, "provider-shims"),
    home = NodePath.join(runRoot, "fixture-user-home"),
    binDirectory = NodePath.join(root, "bin"),
    evidence = NodePath.join(root, "evidence");
  for (const directory of [shimDirectory, home, binDirectory, evidence])
    NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const binary = NodePath.join(root, "guarded-binary");
  NodeFS.writeFileSync(binary, "test-owned immutable binary input", { mode: 0o500 });
  const launcher = NodePath.join(shimDirectory, "claude"),
    marker = NodePath.join(shimDirectory, "claude-fixture.mjs");
  NodeFS.writeFileSync(
    launcher,
    '#!/bin/sh\nexec node "$(dirname "$0")/claude-fixture.mjs" "$@"\n',
    { mode: 0o700 },
  );
  NodeFS.writeFileSync(
    marker,
    'import { appendProviderInput, promptTextFromParts } from "./provider-input-log-fixture.mjs";\nemail: "fixture@example.test",\nappendProviderInput("claudeAgent", prompt);',
  );
  const provenance = {
    source: "a".repeat(40),
    scenario: "release-visual-settings",
    guardMode: "default Abort",
    inputs: {
      serverSha256: NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(binary))
        .digest("hex"),
    },
  };
  const receipt = NodePath.join(evidence, "provenance.json");
  NodeFS.writeFileSync(receipt, JSON.stringify(provenance));
  const missing = NodePath.join(runRoot, "missing-provider");
  const input: SettingsVisualPreflightInput = {
    fixtureRoot: root,
    runRoot,
    theme: "light",
    shimDirectory,
    home,
    binDirectory,
    binary,
    evidence,
    source: provenance.source,
    childEnv: {
      PATH: shimDirectory + NodePath.delimiter + binDirectory,
      HOME: home,
      CLAUDE_CONFIG_DIR: NodePath.join(home, ".claude"),
      BIBCODE_E2E_RUN_ROOT: runRoot,
      BIBCODE_E2E_SHIM_DIRECTORY: shimDirectory,
      BIBCODE_E2E_USER_HOME: home,
      BIBCODE_UPLOAD_FIXTURE: root,
      BIBCODE_UPLOAD_SERVER: binary,
    },
    configured: {
      providers: Object.fromEntries(
        ["codex", "claudeAgent", "cursor", "grok", "opencode"].map((driver) => [
          driver,
          {
            enabled: driver === "claudeAgent",
            binaryPath: driver === "claudeAgent" ? launcher : missing,
          },
        ]),
      ),
      providerInstances: {
        claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: launcher } },
        cursor: {
          driver: "cursor",
          enabled: false,
          config: { binaryPath: missing },
          environment: [],
        },
      },
    },
  };
  return {
    input,
    root,
    provenance,
    receipt,
    launcher,
    marker,
    close: () => {
      NodeFS.chmodSync(binary, 0o700);
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}
describe("real owned settings metadata admission", () => {
  it("joins private source provenance, actual executable/marker files and the unchanged default fixture before returning configuration", () => {
    const f = fixture();
    try {
      const before = structuredClone(f.input);
      expect(
        readSettingsVisualProviderConfiguration(f.input).providerInstances.claudeAgent,
      ).toEqual({
        driver: "claudeAgent",
        enabled: true,
        config: { binaryPath: "claude", homePath: "", launchArgs: "" },
        environment: [],
      });
      expect(f.input).toEqual(before);
    } finally {
      f.close();
    }
  });
  it.each([
    "source",
    "scenario",
    "guard",
    "hash",
    "binary-mode",
    "marker-missing",
    "marker-symlink",
    "marker-contents",
    "launcher-mode",
    "wrong-path",
    "guard-override",
    "unknown-instance",
  ])("refuses actual %s proof loss before any configuration write", (failure) => {
    const f = fixture();
    try {
      if (failure === "source") f.provenance.source = "b".repeat(40);
      if (failure === "scenario") f.provenance.scenario = "release-visual-core";
      if (failure === "guard") f.provenance.guardMode = "report";
      if (failure === "hash") f.provenance.inputs.serverSha256 = "b".repeat(64);
      if (failure === "binary-mode") NodeFS.chmodSync(f.input.binary, 0o600);
      if (failure === "marker-missing") NodeFS.unlinkSync(f.marker);
      if (failure === "marker-symlink") {
        NodeFS.renameSync(f.marker, f.marker + ".owned");
        NodeFS.symlinkSync(f.marker + ".owned", f.marker);
      }
      if (failure === "marker-contents") NodeFS.writeFileSync(f.marker, "unknown marker");
      if (failure === "launcher-mode") NodeFS.chmodSync(f.launcher, 0o600);
      if (failure === "wrong-path") f.input.childEnv.PATH += NodePath.delimiter + "/usr/bin";
      if (failure === "guard-override") f.input.childEnv.BIBCODE_HERMETIC_GUARD = "report";
      if (failure === "unknown-instance")
        f.input.configured.providerInstances.personal = {
          driver: "claudeAgent",
          enabled: true,
          config: { binaryPath: "/host/claude" },
        };
      NodeFS.writeFileSync(f.receipt, JSON.stringify(f.provenance));
      const before = structuredClone(f.input.configured);
      expect(() => readSettingsVisualProviderConfiguration(f.input)).toThrow(
        "Owned settings fixture preflight refused.",
      );
      expect(f.input.configured).toEqual(before);
    } finally {
      f.close();
    }
  });
});
