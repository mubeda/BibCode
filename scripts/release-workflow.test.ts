// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

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
    /if: needs\.preflight\.outputs\.release_channel == 'stable' && needs\.preflight\.outputs\.publish_requested == 'true'[\s\S]*gh release edit/,
  );
  assert.match(releaseWorkflow, /rm -f release-assets\/updater-\*\.json/);
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
    /name: Require inspected stable draft[\s\S]*--json targetCommitish[\s\S]*git rev-parse HEAD/,
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
