// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv, resolvePublicConfig } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("does not project cloud configuration for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.BIBCODE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.BIBCODE_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.BIBCODE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.BIBCODE_RELAY_URL).toBeUndefined();
    expect(env.VITE_BIBCODE_RELAY_URL).toBeUndefined();
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "BIBCODE_CLERK_PUBLISHABLE_KEY=pk_root\nBIBCODE_CLERK_JWT_TEMPLATE=template_root\nBIBCODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nBIBCODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "BIBCODE_CLERK_PUBLISHABLE_KEY=pk_local\nBIBCODE_CLERK_JWT_TEMPLATE=template_local\nBIBCODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nBIBCODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).BIBCODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          BIBCODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          BIBCODE_CLERK_JWT_TEMPLATE: "template_ci",
          BIBCODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          BIBCODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      BIBCODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      BIBCODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      BIBCODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      BIBCODE_RELAY_URL: "https://ci.example.test",
      VITE_BIBCODE_RELAY_URL: "https://ci.example.test",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        VITE_CLERK_JWT_TEMPLATE: "template_legacy",
        BIBCODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_canonical",
        VITE_BIBCODE_RELAY_URL: "https://legacy.example.test",
      }),
    ).toEqual({
      clerkPublishableKey: "pk_legacy",
      clerkJwtTemplate: "template_legacy",
      clerkCliOAuthClientId: "oauth_canonical",
      relayUrl: "https://legacy.example.test",
    });
  });

  it("trims values, skips empty aliases, and preserves unrelated environment entries", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          UNRELATED: "kept",
          BIBCODE_CLERK_PUBLISHABLE_KEY: "   ",
          VITE_CLERK_PUBLISHABLE_KEY: " pk_trimmed ",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toMatchObject({
      UNRELATED: "kept",
      BIBCODE_CLERK_PUBLISHABLE_KEY: "pk_trimmed",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_trimmed",
    });
  });

  it("surfaces environment file read errors", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.mkdirSync(NodePath.join(repoRoot, ".env"));

    expect(() => loadRepoEnv({ baseEnv: {}, repoRoot })).toThrow();
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
