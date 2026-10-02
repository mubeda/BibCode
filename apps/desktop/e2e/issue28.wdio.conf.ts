// @effect-diagnostics nodeBuiltinImport:off - Disposable native qualification config.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { config as desktopConfig } from "./wdio.conf.ts";

const stateRoot = process.env.BIBCODE_HOME;
if (!stateRoot || !process.env.BIBCODE_E2E_RUN_ROOT) {
  throw new Error("The isolated desktop fixture was not prepared.");
}
const settingsPath = NodePath.join(stateRoot, "userdata", "settings.json");
const settings: Record<string, unknown> = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
settings.enableProviderUpdateChecks = false;
// All five legacy drivers already have absolute, test-owned executable pins.
// Give the modern Cursor instance the same explicit pin as well.
settings.providerInstances = {
  cursor: {
    driver: "cursor",
    enabled: false,
    config: {
      binaryPath: NodePath.join(process.env.BIBCODE_E2E_RUN_ROOT, "provider-shims", "cursor-agent"),
    },
  },
};
NodeFS.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

export const config = {
  ...desktopConfig,
  logLevel: "error",
  mochaOpts: { ...desktopConfig.mochaOpts, timeout: 240_000 },
};
