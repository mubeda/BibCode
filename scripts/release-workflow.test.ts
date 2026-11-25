// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const releaseWorkflow = NodeFS.readFileSync(
  NodePath.join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8",
);
const releaseDocumentation = NodeFS.readFileSync(
  NodePath.join(repoRoot, "docs", "operations", "release.md"),
  "utf8",
);

it("keeps nightly releases manual-only", () => {
  assert.equal(
    /^\s{2}schedule:/m.test(releaseWorkflow),
    false,
    "release workflow must not declare a schedule trigger",
  );
  assert.equal(
    /^\s{2}check_changes:/m.test(releaseWorkflow),
    false,
    "release workflow must not contain the scheduled-only change detector",
  );
  assert.notInclude(releaseWorkflow, "github.event_name == 'schedule'");
  assert.notInclude(releaseWorkflow, '"${GITHUB_EVENT_NAME}" == "schedule"');

  assert.equal(/^\s{2}workflow_dispatch:/m.test(releaseWorkflow), true);
  assert.include(releaseWorkflow, "channel:");
  assert.include(releaseWorkflow, "- nightly");
  assert.include(releaseWorkflow, "scripts/resolve-nightly-release.ts");
});

it("documents nightly releases as manual-only", () => {
  assert.notInclude(releaseDocumentation, "scheduled nightly");
  assert.notInclude(releaseDocumentation, "every three hours");
  assert.include(releaseDocumentation, "manual stable or nightly releases");
  assert.match(releaseDocumentation, /manual nightly\s+releases are GitHub prereleases/i);
});

it("checks Finder's rendered icon from the exact macOS release DMG before upload", () => {
  const macVerification =
    /- name: Verify macOS ad-hoc application signature\n[\s\S]*?(?=\n      - name:)/.exec(
      releaseWorkflow,
    )?.[0];
  assert.isDefined(macVerification);
  assert.include(macVerification!, "if: matrix.platform == 'mac'");
  assert.include(macVerification!, "set -euo pipefail");
  assert.include(macVerification!, "hdiutil attach -readonly -nobrowse -noautoopen");
  assert.include(macVerification!, 'app_paths=("$mount_dir"/*.app)');
  assert.include(macVerification!, 'swift scripts/check-macos-app-icon.swift "${app_paths[0]}"');
  assert.notInclude(macVerification!, "continue-on-error");
  assert.notInclude(macVerification!, 'check-macos-app-icon.swift "${app_paths[0]}" ||');
});

it("runs native raster fixtures before building without replacing the mounted icon check", () => {
  const fixtureStep = /- name: Verify macOS icon raster fixtures\n[\s\S]*?(?=\n      - name:)/.exec(
    releaseWorkflow,
  )?.[0];
  assert.isDefined(fixtureStep);
  assert.include(fixtureStep!, "if: matrix.platform == 'mac'");
  assert.include(fixtureStep!, "swift scripts/check-macos-app-icon.swift --self-test");
  assert.notInclude(fixtureStep!, "continue-on-error");
  assert.isBelow(
    releaseWorkflow.indexOf(fixtureStep!),
    releaseWorkflow.indexOf("- name: Build desktop artifact"),
  );
  assert.isAbove(
    releaseWorkflow.indexOf('swift scripts/check-macos-app-icon.swift "${app_paths[0]}"'),
    releaseWorkflow.indexOf("- name: Build desktop artifact"),
  );
});

it("publishes stable updater metadata atomically from a verified draft", () => {
  assert.include(releaseWorkflow, 'echo "name=BiBCode v$version"');
  assert.match(releaseWorkflow, /build-tauri-update-manifest\.ts/);
  assert.match(
    releaseWorkflow,
    /name: Verify Tauri update signatures[\s\S]*cargo run --locked -p bibcode-updater-verifier -- apps\/desktop\/src-tauri\/tauri\.release\.conf\.json release-assets\/latest\.json release-assets/,
  );
  assert.match(releaseWorkflow, /draft:\s*true/);
  assert.match(releaseWorkflow, /gh release view/);
  assert.match(releaseWorkflow, /gh release edit[\s\S]*--draft=false/);
  assert.match(
    releaseWorkflow,
    /if: needs\.preflight\.outputs\.is_update_candidate == 'true'[\s\S]*build-tauri-update-manifest\.ts/,
  );
  assert.match(
    releaseWorkflow,
    /if:[^\n]*needs\.preflight\.outputs\.release_channel == 'stable' && needs\.preflight\.outputs\.publish_requested == 'true'[\s\S]*gh release edit/,
  );
  assert.match(releaseWorkflow, /assemble-release-assets\.ts/);
  assert.match(releaseWorkflow, /pattern:\s*desktop-\*/);
  assert.notMatch(releaseWorkflow, /pattern:\s*server-\*/);
  assert.notMatch(releaseWorkflow, /release-downloads\/server/);
  assert.notMatch(releaseWorkflow, /minisign/);
  assert.notMatch(releaseWorkflow, /BIBCODE_SERVER_SIGNING/);
  assert.match(releaseWorkflow, /files:\s*\|\s*\n\s+release-assets\/\*/);
});

it("keeps stable prereleases outside the updater signing overlay", () => {
  assert.match(
    releaseWorkflow,
    /if \[\[ "\$version" =~ \^\[0-9\][\s\S]*echo "is_update_candidate=true"[\s\S]*else[\s\S]*echo "is_update_candidate=false"/,
  );
  assert.match(
    releaseWorkflow,
    /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ needs\.preflight\.outputs\.is_update_candidate == 'true'/,
  );
  assert.match(
    releaseWorkflow,
    /if \[\[ "\$\{\{ needs\.preflight\.outputs\.is_update_candidate \}\}" == "true" \]\]; then[\s\S]*--updater/,
  );
  assert.match(
    releaseWorkflow,
    /name: Build Tauri update manifest\s*\n\s*if: needs\.preflight\.outputs\.is_update_candidate == 'true'/,
  );
});

it("requires explicit manual approval to publish a previously inspected stable draft", () => {
  assert.match(
    releaseWorkflow,
    /publish:\s*\n\s+description:[^\n]+\n\s+required: false\n\s+default: false\n\s+type: boolean/,
  );
  assert.match(
    releaseWorkflow,
    /name: Require inspected stable draft[\s\S]*publish_requested == 'true'[\s\S]*gh release view/,
  );
  assert.match(
    releaseWorkflow,
    /name: Require inspected stable draft[\s\S]*RELEASE_REF: \$\{\{ needs\.preflight\.outputs\.ref \}\}[\s\S]*--json targetCommitish[\s\S]*"\$RELEASE_REF"/,
  );
  assert.equal(/git rev-list -n 1 "\$RELEASE_TAG"/.test(releaseWorkflow), false);
  assert.match(
    releaseWorkflow,
    /name: Publish approved stable release[\s\S]*publish_requested == 'true'[\s\S]*gh release edit/,
  );
  assert.match(
    releaseWorkflow,
    /name: Publish stable release\s*\n\s*if:[^\n]*publish_requested != 'true'/,
  );
  assert.match(
    releaseWorkflow,
    /name: Publish first stable release\s*\n\s*if:[^\n]*publish_requested != 'true'/,
  );
  assert.match(releaseDocumentation, /rerun[\s\S]*same version[\s\S]*publish[\s\S]*true/i);
});

it("uses current release tooling for manual repairs while preserving the tagged product ref", () => {
  assert.match(
    releaseWorkflow,
    /name: Publish GitHub Release[\s\S]*ref: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.sha \|\| needs\.preflight\.outputs\.ref \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /name: Build \$\{\{ matrix\.label \}\}[\s\S]*ref: \$\{\{ needs\.preflight\.outputs\.ref \}\}/,
  );
  assert.equal(/^\s{2}build_server:/m.test(releaseWorkflow), false);
  assert.match(releaseWorkflow, /needs:\s*\[\s*preflight,\s*build_desktop\s*\]/);
  assert.match(releaseWorkflow, /relay_public_config:/);
  assert.match(
    releaseWorkflow,
    /build_desktop:[\s\S]*?needs:\s*\[\s*preflight,\s*relay_public_config\s*\]/,
  );
  assert.notMatch(releaseWorkflow, /needs\.build_server/);
  assert.match(
    releaseDocumentation,
    /manual repair run[\s\S]*current release tooling[\s\S]*tagged commit/i,
  );
});

it("assembles final assets without creating a GitHub release in validation-only runs", () => {
  assert.match(
    releaseWorkflow,
    /validate_only:\s*\n\s+description:[^\n]+\n\s+required: false\n\s+default: false\n\s+type: boolean/,
  );
  assert.include(releaseWorkflow, "validate_only: ${{ steps.release_meta.outputs.validate_only }}");
  assert.match(
    releaseWorkflow,
    /name: Upload validated release assets\s*\n\s*if: needs\.preflight\.outputs\.validate_only == 'true'[\s\S]*name: validated-release-assets[\s\S]*path:\s*release-assets\/\*/,
  );
  assert.match(
    releaseWorkflow,
    /name: Test\s*\n\s*if: steps\.release_meta\.outputs\.validate_only != 'true' && steps\.ci_tests\.outputs\.green != 'true'\s*\n\s*run: vp run -r --concurrency-limit 1 test/,
  );

  const releaseMutationStepNames = [
    "Require inspected stable draft",
    "Prepare stable release assets",
    "Publish stable release",
    "Publish first stable release",
    "Publish nightly release",
    "Publish first nightly release",
    "Verify stable draft release assets",
    "Publish approved stable release",
  ];

  for (const stepName of releaseMutationStepNames) {
    assert.match(
      releaseWorkflow,
      new RegExp(`name: ${stepName}\\s*\\n\\s*if:[^\\n]*validate_only != 'true'`),
      `${stepName} must be disabled during validation-only runs`,
    );
  }

  assert.match(releaseWorkflow, /name: Finalize release\s*\n\s*if:[^\n]*validate_only != 'true'/);
  assert.match(releaseDocumentation, /validation-only[\s\S]*validated-release-assets/i);
});

it("builds the stable manifest with a runner-generated UTC publication timestamp", () => {
  assert.notInclude(releaseWorkflow, "github.run_started_at");
  assert.match(
    releaseWorkflow,
    /- id: release_timestamp[\s\S]*printf 'pub_date=%s\\n' "\$\(date -u \+['"]%Y-%m-%dT%H:%M:%SZ['"]\)" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(
    releaseWorkflow,
    /--pub-date "\$\{\{ steps\.release_timestamp\.outputs\.pub_date \}\}"/,
  );
});

it("verifies remote stable draft assets against expected-assets.txt on publish approval runs", () => {
  const parsed = parseYaml(releaseWorkflow) as {
    readonly jobs?: Record<
      string,
      {
        readonly steps?: ReadonlyArray<{
          readonly name?: string;
          readonly if?: string;
          readonly run?: string;
        }>;
      }
    >;
  };
  const steps = parsed.jobs?.release?.steps ?? [];
  const prepareStep = steps.find((step) => step.name === "Prepare stable release assets");
  const verifyStep = steps.find((step) => step.name === "Verify stable draft release assets");
  const publishStep = steps.find((step) => step.name === "Publish approved stable release");

  assert.isDefined(prepareStep?.run);
  assert.isDefined(verifyStep?.run);
  assert.isDefined(publishStep?.run);
  assert.notInclude(prepareStep?.if ?? "", "publish_requested != 'true'");
  assert.notInclude(verifyStep?.if ?? "", "publish_requested != 'true'");
  assert.include(prepareStep?.if ?? "", "release_channel == 'stable'");
  assert.include(verifyStep?.if ?? "", "release_channel == 'stable'");
  assert.isBelow(steps.indexOf(prepareStep!), steps.indexOf(verifyStep!));
  assert.isBelow(steps.indexOf(verifyStep!), steps.indexOf(publishStep!));

  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-draft-verify-"));
  try {
    const assetsDir = NodePath.join(tempDir, "release-assets");
    const binDir = NodePath.join(tempDir, "bin");
    NodeFS.mkdirSync(assetsDir);
    NodeFS.mkdirSync(binDir);

    const desktopAssets = [
      "BiBCode_0.4.3_aarch64.dmg",
      "BiBCode_0.4.3_x64.dmg",
      "BiBCode_0.4.3_aarch64.AppImage",
      "BiBCode_0.4.3_amd64.AppImage",
      "BiBCode_0.4.3_arm64-setup.exe",
      "BiBCode_0.4.3_x64-setup.exe",
      "bibcode-desktop-symbols-0.4.3-darwin-aarch64.zip",
      "bibcode-desktop-symbols-0.4.3-darwin-x86_64.zip",
      "bibcode-desktop-symbols-0.4.3-linux-aarch64.zip",
      "bibcode-desktop-symbols-0.4.3-linux-x86_64.zip",
      "bibcode-desktop-symbols-0.4.3-windows-aarch64.zip",
      "bibcode-desktop-symbols-0.4.3-windows-x86_64.zip",
      "latest.json",
    ];
    for (const name of desktopAssets) {
      NodeFS.writeFileSync(NodePath.join(assetsDir, name), name);
    }

    const mockGhPath = NodePath.join(binDir, "gh");
    NodeFS.writeFileSync(
      mockGhPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$*" == *"--jq .isDraft"* ]]; then',
        '  printf "%s\\n" "${MOCK_IS_DRAFT}"',
        "  exit 0",
        "fi",
        'if [[ "$*" == *"--jq .assets[].name"* ]]; then',
        '  printf "%s" "${MOCK_DRAFT_ASSETS}"',
        "  exit 0",
        "fi",
        'echo "unexpected gh args: $*" >&2',
        "exit 2",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const combinedScript = `${prepareStep!.run}\n${verifyStep!.run}`;
    const runVerification = (isDraft: string, draftAssets: ReadonlyArray<string>) =>
      NodeChildProcess.spawnSync("bash", ["-c", combinedScript], {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          RELEASE_TAG: "v0.4.3",
          MOCK_IS_DRAFT: isDraft,
          MOCK_DRAFT_ASSETS: draftAssets.map((name) => `${name}\n`).join(""),
        },
      });

    const okResult = runVerification("true", desktopAssets);
    assert.equal(okResult.status, 0, `${okResult.stdout}\n${okResult.stderr}`);

    const extraServerAsset = runVerification("true", [
      ...desktopAssets,
      "bibcode-server-SHA256SUMS",
    ]);
    assert.notEqual(extraServerAsset.status, 0, "must reject stale draft with server checksums");
    assert.include(extraServerAsset.stdout, "bibcode-server-SHA256SUMS");

    const missingDesktopAsset = runVerification(
      "true",
      desktopAssets.filter((name) => name !== "BiBCode_0.4.3_x64-setup.exe"),
    );
    assert.notEqual(missingDesktopAsset.status, 0, "must reject draft missing desktop installer");
    assert.include(missingDesktopAsset.stdout, "BiBCode_0.4.3_x64-setup.exe");

    const notDraft = runVerification("false", desktopAssets);
    assert.notEqual(notDraft.status, 0, "must reject non-draft release");
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
});
