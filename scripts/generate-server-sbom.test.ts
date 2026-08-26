// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  bindServerArtifactSbom,
  pruneKnownUnshippedServerWebComponents,
  resolveServerSbomCommandPlan,
  SERVER_CYCLONEDX_CLI_VERSION,
  SERVER_RUST_SBOM_TOOL_VERSION,
} from "./generate-server-sbom.ts";

const sourceSha = "1".repeat(40);
const artifactSha256 = NodeCrypto.createHash("sha256").update("artifact").digest("hex");

const component = (name: string, version: string, purl: string) => ({
  type: "library",
  name,
  version,
  purl,
  "bom-ref": purl,
});

describe("server SBOM generation", () => {
  it("pins target-specific Rust, exact web production, and CycloneDX merge commands", () => {
    const plan = resolveServerSbomCommandPlan({
      repoRoot: "/repo",
      workRoot: "/work",
      targetTriple: "aarch64-unknown-linux-gnu",
      version: "0.4.2",
      sourceDateEpoch: 1_787_600_000,
    });

    expect(SERVER_RUST_SBOM_TOOL_VERSION).toBe("0.5.9");
    expect(SERVER_CYCLONEDX_CLI_VERSION).toBe("0.32.0");
    expect(plan.rust.args).toEqual(
      expect.arrayContaining([
        "cyclonedx",
        "--manifest-path",
        "/repo/apps/server/Cargo.toml",
        "--format",
        "json",
        "--describe",
        "binaries",
        "--target",
        "aarch64-unknown-linux-gnu",
        "--spec-version",
        "1.5",
      ]),
    );
    expect(plan.rust.env).toMatchObject({
      CARGO_BUILD_TARGET: "aarch64-unknown-linux-gnu",
      SOURCE_DATE_EPOCH: "1787600000",
    });
    expect(plan.web.command).toBe("pnpm");
    expect(plan.web.args).toEqual([
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
      "/work/web.cdx.json",
    ]);
    expect(plan.merge.command).toBe("cyclonedx");
    expect(plan.merge.args).toEqual(
      expect.arrayContaining(["merge", "--hierarchical", "--output-version", "v1_7"]),
    );
  });

  it("binds merged dependency and staged-file inventory to exact artifact bytes", () => {
    const bound = bindServerArtifactSbom({
      merged: {
        bomFormat: "CycloneDX",
        specVersion: "1.7",
        version: 1,
        metadata: {
          component: {
            type: "application",
            name: "bibcode-server",
            version: "0.4.2",
            "bom-ref": "pkg:generic/bibcode-server@0.4.2",
          },
        },
        components: [
          component("bibcode-server", "0.4.2", "pkg:cargo/bibcode-server@0.4.2"),
          component("tokio", "1.47.1", "pkg:cargo/tokio@1.47.1"),
          component("@bibcode/web", "0.4.2", "pkg:npm/%40bibcode/web@0.4.2"),
          component("react", "19.2.7", "pkg:npm/react@19.2.7"),
        ],
        dependencies: [],
      },
      artifact: {
        downloadName: "bibcode-server-0.4.2-aarch64-unknown-linux-gnu.tar.gz",
        version: "0.4.2",
        sourceSha,
        targetTriple: "aarch64-unknown-linux-gnu",
        size: 8,
        sha256: artifactSha256,
        fileInventory: [
          { path: "bin/bibcode", size: 4, sha256: "a".repeat(64) },
          { path: "share/bibcode/web/index.html", size: 4, sha256: "b".repeat(64) },
        ],
      },
    });

    const metadata = bound.metadata as {
      component: { name: string; hashes: unknown[]; properties: unknown[] };
    };
    const components = bound.components as Array<Record<string, unknown>>;
    expect(metadata.component.name).toBe("bibcode-server-0.4.2-aarch64-unknown-linux-gnu.tar.gz");
    expect(metadata.component.hashes).toContainEqual({
      alg: "SHA-256",
      content: artifactSha256,
    });
    expect(metadata.component.properties).toEqual(
      expect.arrayContaining([
        { name: "bibcode:sourceSha", value: sourceSha },
        { name: "bibcode:targetTriple", value: "aarch64-unknown-linux-gnu" },
      ]),
    );
    expect(components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tokio" }),
        expect.objectContaining({ name: "react" }),
        expect.objectContaining({ name: "bin/bibcode", type: "file" }),
      ]),
    );
  });

  it("records and removes only the desktop API declared but absent from server asset bytes", () => {
    const tauriReference = "pkg:npm/%40tauri-apps/api@2.11.1";
    const pruned = pruneKnownUnshippedServerWebComponents({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      metadata: {
        component: component("bibcode-server", "0.4.2", "pkg:cargo/bibcode-server@0.4.2"),
      },
      components: [
        component("bibcode-server", "0.4.2", "pkg:cargo/bibcode-server@0.4.2"),
        component("tokio", "1.47.1", "pkg:cargo/tokio@1.47.1"),
        component("@bibcode/web", "0.4.2", "pkg:npm/%40bibcode/web@0.4.2"),
        component("react", "19.2.7", "pkg:npm/react@19.2.7"),
        component("api", "2.11.1", tauriReference),
      ],
      dependencies: [
        { ref: "pkg:npm/%40bibcode/web@0.4.2", dependsOn: [tauriReference] },
        { ref: tauriReference, dependsOn: [] },
      ],
    });
    expect(pruned.components).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ purl: tauriReference })]),
    );
    const dependencies = pruned.dependencies as Array<{
      readonly ref: string;
      readonly dependsOn: ReadonlyArray<string>;
    }>;
    expect(dependencies.some((dependency) => dependency.ref === tauriReference)).toBe(false);
    expect(dependencies.flatMap((dependency) => dependency.dependsOn)).not.toContain(
      tauriReference,
    );
    expect((pruned.metadata as { properties: unknown[] }).properties).toContainEqual({
      name: "bibcode:excludedUnshippedDeclaredDependency",
      value: tauriReference,
    });
    expect(() =>
      bindServerArtifactSbom({
        merged: pruned,
        artifact: {
          downloadName: "server.tar.gz",
          version: "0.4.2",
          sourceSha,
          targetTriple: "x86_64-unknown-linux-gnu",
          size: 8,
          sha256: artifactSha256,
          fileInventory: [],
        },
      }),
    ).not.toThrow();
  });

  it.each([
    component("node", "26.5.0", "pkg:generic/node@26.5.0"),
    component("@tauri-apps/api", "2.11.1", "pkg:npm/%40tauri-apps/api@2.11.1"),
    component("BibCode Connect", "1.0.0", "pkg:generic/bibcode-connect@1.0.0"),
    component("telemetry-client", "1.0.0", "pkg:npm/telemetry-client@1.0.0"),
  ])("rejects forbidden production server component $name", (forbidden) => {
    expect(() =>
      bindServerArtifactSbom({
        merged: {
          bomFormat: "CycloneDX",
          specVersion: "1.7",
          version: 1,
          metadata: { component: forbidden },
          components: [forbidden],
          dependencies: [],
        },
        artifact: {
          downloadName: "server.tar.gz",
          version: "0.4.2",
          sourceSha,
          targetTriple: "x86_64-unknown-linux-gnu",
          size: 8,
          sha256: artifactSha256,
          fileInventory: [],
        },
      }),
    ).toThrow(/forbidden production server component/iu);
  });

  it("requires representative direct and transitive Rust and web components", () => {
    expect(() =>
      bindServerArtifactSbom({
        merged: {
          bomFormat: "CycloneDX",
          specVersion: "1.7",
          version: 1,
          metadata: {
            component: component("bibcode-server", "0.4.2", "pkg:cargo/bibcode-server@0.4.2"),
          },
          components: [component("bibcode-server", "0.4.2", "pkg:cargo/bibcode-server@0.4.2")],
          dependencies: [],
        },
        artifact: {
          downloadName: "server.tar.gz",
          version: "0.4.2",
          sourceSha,
          targetTriple: "x86_64-unknown-linux-gnu",
          size: 8,
          sha256: artifactSha256,
          fileInventory: [],
        },
      }),
    ).toThrow(/Rust and web dependency graphs/iu);
  });
});
