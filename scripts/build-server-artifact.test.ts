// @effect-diagnostics nodeBuiltinImport:off - This release-script test uses real temporary filesystem fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ServerArtifactConfigurationError,
  parseServerArtifactArguments,
  planServerArtifact,
  stageServerDistribution,
} from "./build-server-artifact.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-server-artifact-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("server artifact builder", () => {
  it("expands every nFPM content source from the staged package root", () => {
    const config = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../apps/server/package/nfpm.yaml"),
      "utf8",
    );
    expect(
      config.match(/- src: \$\{BIBCODE_SERVER_PACKAGE_ROOT\}[^\n]*\n\s+expand: true/g),
    ).toHaveLength(4);
  });

  it("defaults CLI version and output from the repository server package", () => {
    const root = temporaryRoot();
    NodeFS.mkdirSync(NodePath.join(root, "apps/server"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/server/package.json"),
      `${JSON.stringify({ version: "1.2.3" })}\n`,
    );

    expect(parseServerArtifactArguments(["--platform", "linux", "--arch", "arm64"], root)).toEqual({
      platform: "linux",
      arch: "arm64",
      version: "1.2.3",
      outputDir: "release/server/linux-aarch64",
    });
  });

  it("plans the Linux ARM64 archive from the shared release target", () => {
    const root = temporaryRoot();
    const plan = planServerArtifact(
      {
        platform: "linux",
        arch: "arm64",
        version: "0.4.3",
        outputDir: NodePath.join(root, "out"),
        skipBuild: true,
        binaryPath: NodePath.join(root, "bibcode"),
        webDir: NodePath.join(root, "web"),
      },
      { platform: "linux", arch: "arm64" },
      root,
    );

    expect(plan.target.rustTarget).toBe("aarch64-unknown-linux-gnu");
    expect(plan.archiveName).toBe("bibcode-server-v0.4.3-linux-aarch64.tar.gz");
    expect(plan.distributionRootName).toBe("bibcode-server-v0.4.3-linux-aarch64");
    expect(plan.archiveCommand).toEqual({
      command: "tar",
      args: [
        "-czf",
        NodePath.join(root, "out", "bibcode-server-v0.4.3-linux-aarch64.tar.gz"),
        "-C",
        NodePath.join(root, "out", "staging"),
        "bibcode-server-v0.4.3-linux-aarch64",
      ],
    });
    expect(plan.packageArtifacts).toEqual([
      NodePath.join(root, "out", "bibcode-server_0.4.3_arm64.deb"),
      NodePath.join(root, "out", "bibcode-server-0.4.3-1.aarch64.rpm"),
    ]);
  });

  it("stages the executable, web client, guide, and license under one versioned root", async () => {
    const root = temporaryRoot();
    const binary = NodePath.join(root, "bibcode");
    const web = NodePath.join(root, "web");
    const guide = NodePath.join(root, "server-installation.md");
    const license = NodePath.join(root, "LICENSE");
    NodeFS.mkdirSync(web);
    NodeFS.writeFileSync(binary, "binary");
    NodeFS.writeFileSync(NodePath.join(web, "index.html"), "<main>BiBCode</main>");
    NodeFS.writeFileSync(NodePath.join(web, "app.js"), "console.log('BiBCode')");
    NodeFS.writeFileSync(guide, "# Server installation\n");
    NodeFS.writeFileSync(license, "MIT\n");
    const plan = planServerArtifact(
      {
        platform: "linux",
        arch: "arm64",
        version: "0.4.3",
        outputDir: NodePath.join(root, "out"),
        skipBuild: true,
        binaryPath: binary,
        webDir: web,
      },
      { platform: "linux", arch: "arm64" },
      root,
      { guidePath: guide, licensePath: license },
    );

    const staged = await stageServerDistribution(plan);

    expect(staged).toEqual(["LICENSE", "README.md", "bibcode", "web/app.js", "web/index.html"]);
    expect(NodeFS.readFileSync(NodePath.join(plan.stagingDir, "README.md"), "utf8")).toBe(
      "# Server installation\n",
    );
  });

  it("rejects incomplete web assets and overlapping source/output trees", async () => {
    const root = temporaryRoot();
    const binary = NodePath.join(root, "bibcode");
    const web = NodePath.join(root, "web");
    const output = NodePath.join(root, "out");
    NodeFS.mkdirSync(web);
    NodeFS.writeFileSync(binary, "binary");
    const base = {
      platform: "linux" as const,
      arch: "arm64" as const,
      version: "0.4.3",
      outputDir: output,
      skipBuild: true,
      binaryPath: binary,
      webDir: web,
    };
    const plan = planServerArtifact(base, { platform: "linux", arch: "arm64" }, root, {
      guidePath: binary,
      licensePath: binary,
    });

    await expect(stageServerDistribution(plan)).rejects.toThrow("web/index.html");
    expect(() =>
      planServerArtifact(
        { ...base, binaryPath: NodePath.join(output, "bibcode") },
        { platform: "linux", arch: "arm64" },
        root,
      ),
    ).toThrow(ServerArtifactConfigurationError);
  });
});
