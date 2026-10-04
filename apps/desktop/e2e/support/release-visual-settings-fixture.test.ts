// @effect-diagnostics nodeBuiltinImport:off - Pure fixture admission and configuration; no process/filesystem mutation.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  prepareSettingsVisualProviders,
  type SettingsVisualProviderSeedInput,
} from "./release-visual-settings-fixture.ts";

function input(): SettingsVisualProviderSeedInput {
  const fixtureRoot = "/owned/qualification",
    runRoot = fixtureRoot + "/light";
  const shimDirectory = runRoot + "/provider-shims",
    home = runRoot + "/fixture-user-home";
  const missing = runRoot + "/missing-provider";
  return {
    fixtureRoot,
    runRoot,
    theme: "light",
    shimDirectory,
    home,
    binDirectory: fixtureRoot + "/bin",
    guardedCli: {
      path: "/owned/bibcode-guarded",
      guardMode: "default Abort",
      executableVerified: true,
    },
    generatedClaude: {
      launcherPath: shimDirectory + "/claude",
      launcherContents: '#!/bin/sh\nexec node "$(dirname "$0")/claude-fixture.mjs" "$@"\n',
      fixturePath: shimDirectory + "/claude-fixture.mjs",
      fixtureContents:
        'import { appendProviderInput, promptTextFromParts } from "./provider-input-log-fixture.mjs";\nemail: "fixture@example.test",\nappendProviderInput("claudeAgent", prompt);',
      launcherRegular: true,
      launcherExecutable: true,
      launcherSymlink: false,
      fixtureRegular: true,
      fixtureSymlink: false,
    },
    childEnv: {
      PATH: shimDirectory + NodePath.delimiter + fixtureRoot + "/bin",
      HOME: home,
      CLAUDE_CONFIG_DIR: home + "/.claude",
      BIBCODE_E2E_RUN_ROOT: runRoot,
      BIBCODE_E2E_SHIM_DIRECTORY: shimDirectory,
      BIBCODE_E2E_USER_HOME: home,
      BIBCODE_UPLOAD_FIXTURE: fixtureRoot,
      BIBCODE_UPLOAD_SERVER: "/owned/bibcode-guarded",
    },
    configured: {
      unrelatedSetting: "retained",
      enableProviderUpdateChecks: false,
      providers: Object.fromEntries(
        ["codex", "claudeAgent", "cursor", "grok", "opencode"].map((driver) => [
          driver,
          {
            enabled: driver === "claudeAgent",
            binaryPath: driver === "claudeAgent" ? shimDirectory + "/claude" : missing,
          },
        ]),
      ),
      providerInstances: Object.fromEntries(
        ["codex", "claudeAgent", "cursor", "grok", "opencode"].map((driver) => [
          driver,
          {
            driver,
            enabled: driver === "claudeAgent",
            config: { binaryPath: driver === "claudeAgent" ? shimDirectory + "/claude" : missing },
            environment: [],
          },
        ]),
      ),
    },
  };
}
describe("dedicated owned settings provider seed", () => {
  it("accepts the current default fixture's two explicit instances and supplies only known owned disabled defaults", () => {
    const source = input();
    source.configured.providerInstances = {
      cursor: source.configured.providerInstances.cursor!,
      claudeAgent: {
        driver: "claudeAgent",
        enabled: true,
        config: { binaryPath: source.generatedClaude.launcherPath },
      },
    };
    const before = structuredClone(source);
    expect(source.configured.providerInstances.claudeAgent).toEqual({
      driver: "claudeAgent",
      enabled: true,
      config: { binaryPath: "/owned/qualification/light/provider-shims/claude" },
    });
    const next = prepareSettingsVisualProviders(source);
    expect(source).toEqual(before);
    expect(next.providerInstances.codex).toEqual({
      driver: "codex",
      enabled: false,
      config: { binaryPath: "/owned/qualification/light/missing-provider" },
      environment: [],
    });
    expect(next.providerInstances.claudeAgent).toMatchObject({
      enabled: true,
      config: { binaryPath: "claude" },
    });
    expect(Object.keys(source.configured.providerInstances).sort()).toEqual([
      "claudeAgent",
      "cursor",
    ]);
  });
  it("returns path-free Claude form fields without changing the supplied settings or activating host providers", () => {
    const source = input(),
      before = structuredClone(source);
    const next = prepareSettingsVisualProviders(source);
    expect(source).toEqual(before);
    expect(next.unrelatedSetting).toBe("retained");
    expect(next.providers.claudeAgent).toEqual({
      enabled: true,
      binaryPath: "claude",
      homePath: "",
      launchArgs: "",
    });
    expect(next.providerInstances.claudeAgent).toEqual({
      driver: "claudeAgent",
      enabled: true,
      config: { binaryPath: "claude", homePath: "", launchArgs: "" },
      environment: [],
    });
    expect(next.providerInstances.cursor).toMatchObject({
      enabled: true,
      config: { binaryPath: "/owned/qualification/light/missing-provider" },
    });
    expect(next.providerInstances.codex!.enabled).toBe(false);
    expect(next.providerInstances.opencode!.enabled).toBe(false);
    expect(next.providerInstances.grok!.enabled).toBe(false);
    expect(next.enableProviderUpdateChecks).toBe(false);
  });
  it.each([
    "path",
    "home",
    "guard",
    "marker",
    "launcher",
    "missing-executable",
    "symlink",
    "unknown-provider",
    "unknown-instance",
    "host-provider",
    "secret-environment",
    "environment-null",
    "environment-string",
    "environment-object",
    "environment-undefined",
    "nonempty-environment",
    "server",
  ])("refuses %s admission before returning a configuration", (failure) => {
    const source = input(),
      before = structuredClone(source);
    if (failure === "path") source.childEnv.PATH += NodePath.delimiter + "/usr/bin";
    if (failure === "home") source.childEnv.HOME = "/real/home";
    if (failure === "guard") source.guardedCli.guardMode = "unverified" as never;
    if (failure === "marker") source.generatedClaude.fixtureContents = "not the generated fixture";
    if (failure === "launcher")
      source.generatedClaude.launcherContents = "#!/bin/sh\nexec /host/claude\n";
    if (failure === "missing-executable") source.generatedClaude.launcherExecutable = false;
    if (failure === "symlink") source.generatedClaude.fixtureSymlink = true;
    if (failure === "unknown-provider")
      source.configured.providers.host = { enabled: false, binaryPath: "/host/provider" };
    if (failure === "unknown-instance")
      source.configured.providerInstances.personal = {
        driver: "claudeAgent",
        enabled: true,
        config: { binaryPath: "/host/claude" },
        environment: [],
      };
    if (failure === "host-provider") source.configured.providers.codex!.enabled = true;
    if (failure === "secret-environment")
      source.configured.providerInstances.claudeAgent!.environment = [
        { name: "TOKEN", value: "private", sensitive: true },
      ];
    if (failure === "environment-null")
      source.configured.providerInstances.claudeAgent!.environment = null as never;
    if (failure === "environment-string")
      source.configured.providerInstances.claudeAgent!.environment = "" as never;
    if (failure === "environment-object")
      source.configured.providerInstances.claudeAgent!.environment = {} as never;
    if (failure === "environment-undefined")
      source.configured.providerInstances.claudeAgent!.environment = undefined as never;
    if (failure === "nonempty-environment")
      source.configured.providerInstances.claudeAgent!.environment = [
        { name: "FIXTURE_TAG", value: "owned", sensitive: false },
      ];
    if (failure === "server") source.childEnv.BIBCODE_UPLOAD_SERVER = "/host/server";
    expect(() => prepareSettingsVisualProviders(source)).toThrow(
      "Owned settings provider seed refused.",
    );
    // Refusal also leaves the mutated caller input unchanged.
    if (failure === "marker") expect(source.configured).toEqual(before.configured);
  });
});
