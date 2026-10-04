// @effect-diagnostics nodeBuiltinImport:off - Pure path/config admission; never launches or writes a fixture.
import * as NodePath from "node:path";

interface FixtureProviderSettings {
  enabled: boolean;
  binaryPath: string;
  [key: string]: unknown;
}
interface FixtureProviderInstance {
  driver: string;
  enabled: boolean;
  config: Record<string, unknown>;
  environment?: Array<{ name: string; value: string; sensitive: boolean }>;
  [key: string]: unknown;
}
interface FixtureSettings {
  providers: Record<string, FixtureProviderSettings>;
  providerInstances: Record<string, FixtureProviderInstance>;
  [key: string]: unknown;
}
/** These file facts are supplied by the existing owner's read-only preflight, before server admission. */
export interface SettingsVisualProviderSeedInput {
  fixtureRoot: string;
  runRoot: string;
  theme: "light" | "dark";
  shimDirectory: string;
  binDirectory: string;
  home: string;
  childEnv: NodeJS.ProcessEnv;
  guardedCli: { path: string; guardMode: "default Abort"; executableVerified: boolean };
  generatedClaude: {
    launcherPath: string;
    launcherContents: string;
    fixturePath: string;
    fixtureContents: string;
    launcherRegular: boolean;
    launcherExecutable: boolean;
    launcherSymlink: boolean;
    fixtureRegular: boolean;
    fixtureSymlink: boolean;
  };
  configured: FixtureSettings;
}

/** Dedicated Linux selection only. Caller retains/writes the returned private configuration. */
export function prepareSettingsVisualProviders(
  input: SettingsVisualProviderSeedInput,
): FixtureSettings {
  const refused = () => new Error("Owned settings provider seed refused.");
  try {
    const {
      fixtureRoot,
      runRoot,
      shimDirectory,
      binDirectory,
      home,
      childEnv,
      generatedClaude: generated,
      guardedCli,
      configured,
    } = input;
    if (
      !NodePath.isAbsolute(fixtureRoot) ||
      NodePath.normalize(fixtureRoot) !== fixtureRoot ||
      fixtureRoot === NodePath.parse(fixtureRoot).root ||
      !["light", "dark"].includes(input.theme) ||
      runRoot !== NodePath.join(fixtureRoot, input.theme) ||
      shimDirectory !== NodePath.join(runRoot, "provider-shims") ||
      binDirectory !== NodePath.join(fixtureRoot, "bin") ||
      home !== NodePath.join(runRoot, "fixture-user-home") ||
      childEnv.PATH !== shimDirectory + NodePath.delimiter + binDirectory ||
      childEnv.HOME !== home ||
      childEnv.CLAUDE_CONFIG_DIR !== NodePath.join(home, ".claude") ||
      childEnv.BIBCODE_E2E_RUN_ROOT !== runRoot ||
      childEnv.BIBCODE_E2E_SHIM_DIRECTORY !== shimDirectory ||
      childEnv.BIBCODE_E2E_USER_HOME !== home ||
      childEnv.BIBCODE_UPLOAD_FIXTURE !== fixtureRoot ||
      childEnv.BIBCODE_UPLOAD_SERVER !== guardedCli.path ||
      !NodePath.isAbsolute(guardedCli.path) ||
      guardedCli.guardMode !== "default Abort" ||
      guardedCli.executableVerified !== true ||
      generated.launcherPath !== NodePath.join(shimDirectory, "claude") ||
      generated.fixturePath !== NodePath.join(shimDirectory, "claude-fixture.mjs") ||
      generated.launcherRegular !== true ||
      generated.launcherExecutable !== true ||
      generated.launcherSymlink !== false ||
      generated.fixtureRegular !== true ||
      generated.fixtureSymlink !== false ||
      generated.launcherContents !==
        '#!/bin/sh\nexec node "$(dirname "$0")/claude-fixture.mjs" "$@"\n' ||
      generated.fixtureContents.length > 65_536 ||
      !generated.fixtureContents.includes(
        'import { appendProviderInput, promptTextFromParts } from "./provider-input-log-fixture.mjs";',
      ) ||
      !generated.fixtureContents.includes('email: "fixture@example.test",') ||
      !generated.fixtureContents.includes('appendProviderInput("claudeAgent", prompt);')
    )
      throw refused();
    const drivers = ["codex", "claudeAgent", "cursor", "grok", "opencode"];
    const missing = NodePath.join(runRoot, "missing-provider");
    if (
      !configured ||
      typeof configured !== "object" ||
      !configured.providers ||
      !configured.providerInstances ||
      Object.keys(configured.providers).length !== drivers.length ||
      !Object.keys(configured.providerInstances).every((driver) => drivers.includes(driver)) ||
      !configured.providerInstances.claudeAgent
    )
      throw refused();
    for (const driver of drivers) {
      const provider = configured.providers[driver],
        instance = configured.providerInstances[driver];
      const expectedBinary = driver === "claudeAgent" ? generated.launcherPath : missing;
      if (
        !provider ||
        provider.enabled !== (driver === "claudeAgent") ||
        provider.binaryPath !== expectedBinary ||
        (instance !== undefined &&
          (instance.driver !== driver ||
            instance.enabled !== (driver === "claudeAgent") ||
            !instance.config ||
            instance.config.binaryPath !== expectedBinary ||
            (Object.hasOwn(instance, "environment") &&
              (!Array.isArray(instance.environment) || instance.environment.length !== 0))))
      )
        throw refused();
    }
    const next = structuredClone(configured);
    next.providerInstances = Object.fromEntries(
      drivers.map((driver) => [
        driver,
        {
          driver,
          enabled: false,
          config: { binaryPath: missing },
          environment: [],
        },
      ]),
    );
    // No provider source, host path, authentication or resolver policy changes.
    next.providers.claudeAgent = {
      enabled: true,
      binaryPath: "claude",
      homePath: "",
      launchArgs: "",
    };
    next.providerInstances.claudeAgent = {
      driver: "claudeAgent",
      enabled: true,
      config: { binaryPath: "claude", homePath: "", launchArgs: "" },
      environment: [],
    };
    // This enabled-but-missing owned path permits truthful unavailable status;
    // disabled providers remain disabled and cannot fall back to host binaries.
    next.providers.cursor = { enabled: true, binaryPath: missing };
    next.providerInstances.cursor = {
      driver: "cursor",
      enabled: true,
      config: { binaryPath: missing },
      environment: [],
    };
    next.enableProviderUpdateChecks = false;
    return next;
  } catch {
    throw refused();
  }
}
