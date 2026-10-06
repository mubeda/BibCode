// @effect-diagnostics nodeBuiltinImport:off - Static workflow and inert fixed-input policy tests never launch an OS or application.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as YAML from "yaml";
import { expect, it } from "vite-plus/test";
import {
  nativeFollowupWorkflowPlan,
  nativeFollowupWorkflowStatus,
} from "./qualify-native-followups-workflow.ts";
import { parseSeededDesktopUpgradeSmokeArgs } from "./seeded-desktop-upgrade-smoke.ts";
const root = NodePath.resolve(".");
function wslSteps() {
  const source = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ),
  );
  return source.jobs.windows_wsl_upgrade_smoke.steps as Array<{
    name: string;
    id?: string;
    if?: string;
    run?: string;
  }>;
}
// Evaluate only the workflow's closed boolean expressions, never a PowerShell/WSL command.
function sourceBoolean(expression: string, values: Record<string, unknown>) {
  const text = expression
    .replace(/\$distros\.Count/g, "distroCount")
    .replace(/\$true\b/g, "true")
    .replace(/\$false\b/g, "false")
    .replace(/\$null\b/g, "null")
    .replace(
      /\$(statusAvailable|nativeSelected|listSucceeded|listObserved|statusSucceeded|reasonCode)\b/g,
      "$1",
    )
    .replace(/-eq\b/g, "===")
    .replace(/-gt\b/g, ">")
    .replace(/-and\b/g, "&&")
    .replace(/-or\b/g, "||")
    .replace(/-not\b/g, "!");
  if (/\$|;|\{|\}|\bwsl\s+--|\b(?:Invoke|Out-File)\b/.test(text))
    throw new Error("Unsupported closed workflow expression.");
  return NodeVM.runInNewContext("(" + text + ")", values) as boolean;
}
function precedingSourceCondition(script: string, index: number) {
  const line = script
    .slice(0, index)
    .split("\n")
    .toReversed()
    .find((value) => /^\s*if \(.+\) \{\s*$/.test(value));
  if (!line) throw new Error("Closed workflow condition unavailable.");
  return line.trim().slice(4, -3);
}
function closedWslDetection(
  nativeSelected: boolean,
  statusAvailable: boolean,
  listSucceeded: boolean | null,
  distroCount: number,
) {
  const script = wslSteps().find((step) => step.id === "wsl")!.run!;
  const line = script
    .split("\n")
    .find((value) => value.trim().startsWith("if ($statusAvailable -and $distros.Count"))!;
  const availability = line.trim().slice(4, -3);
  const values = { nativeSelected, statusAvailable, listSucceeded, distroCount };
  const available = sourceBoolean(availability, values);
  const reason = script.match(
    /\$reasonCode = if \(([^\n]+)\) \{ '([^']+)' \} elseif \(([^\n]+)\) \{ '([^']+)' \} else \{ '([^']+)' \}/,
  );
  expect(reason).not.toBeNull();
  const reasonSelected = sourceBoolean(
    precedingSourceCondition(script, script.indexOf("$reasonCode = if")),
    values,
  );
  const reasonCode =
    available || !reasonSelected
      ? null
      : sourceBoolean(reason![1]!, values)
        ? reason![2]
        : sourceBoolean(reason![3]!, values)
          ? reason![4]
          : reason![5];
  return { available, reasonCode };
}
function closedWslUnavailable(
  reasonCode: string,
  statusSucceeded: boolean,
  listObserved: boolean,
  listSucceeded: boolean | null,
) {
  const script = wslSteps().find(
    (step) => step.name === "Record native WSL prerequisite unavailable",
  )!.run!;
  const allowed = script.match(/\$reasonCode -notin @\(([^)]+)\)/);
  const condition = script.match(
    /\$reasonMatches = \(([\s\S]*?)\)\n\s*if \(-not \$reasonMatches\)/,
  );
  expect(allowed).not.toBeNull();
  expect(condition).not.toBeNull();
  if (
    !allowed![1]!
      .split(",")
      .map((value) => value.trim().slice(1, -1))
      .includes(reasonCode) ||
    !sourceBoolean(condition![1]!, { reasonCode, statusSucceeded, listObserved, listSucceeded })
  )
    return null;
  const literal = script.match(
    /@\{schemaVersion=1;selection='release-visual-native-followups';[^}]+\}/,
  );
  expect(literal).not.toBeNull();
  const values: Record<string, unknown> = {
    $reasonCode: reasonCode,
    $statusSucceeded: statusSucceeded,
    $listObserved: listObserved,
    $listSucceeded: listSucceeded,
    "$env:GITHUB_SHA": "a".repeat(40),
    $true: true,
    $false: false,
    $null: null,
  };
  return Object.fromEntries(
    literal![0]
      .slice(2, -1)
      .split(";")
      .map((field) => {
        const [key, expression] = field.split("=");
        const value = Object.hasOwn(values, expression!)
          ? values[expression!]
          : expression!.startsWith("'")
            ? expression!.slice(1, -1)
            : Number(expression);
        return [key, value];
      }),
  );
}
it.each([
  {
    native: true,
    status: false,
    list: null,
    count: 0,
    available: false,
    reason: "wsl-status-failed",
  },
  {
    native: true,
    status: true,
    list: false,
    count: 0,
    available: false,
    reason: "wsl-list-failed",
  },
  {
    native: true,
    status: true,
    list: false,
    count: 2,
    available: false,
    reason: "wsl-list-failed",
  },
  { native: true, status: true, list: true, count: 0, available: false, reason: "wsl-no-distro" },
  { native: true, status: true, list: true, count: 2, available: true, reason: null },
  { native: false, status: false, list: null, count: 0, available: false, reason: null },
  { native: false, status: true, list: false, count: 2, available: true, reason: null },
  { native: false, status: true, list: true, count: 0, available: false, reason: null },
])(
  "keeps actual native/default WSL decisions and closed reasons: $native/$status/$list/$count",
  (value) => {
    expect(closedWslDetection(value.native, value.status, value.list, value.count)).toEqual({
      available: value.available,
      reasonCode: value.reason,
    });
  },
);
it.each([
  { reason: "wsl-status-failed", status: false, observed: false, list: null },
  { reason: "wsl-list-failed", status: true, observed: true, list: false },
  { reason: "wsl-no-distro", status: true, observed: true, list: true },
])("retains a closed zero-original unavailable artifact before failure: $reason", (value) => {
  expect(closedWslUnavailable(value.reason, value.status, value.observed, value.list)).toEqual({
    schemaVersion: 1,
    selection: "release-visual-native-followups",
    sourceSha: "a".repeat(40),
    partition: "windows-wsl",
    status: "unavailable",
    reasonCode: value.reason,
    wslStatusSucceeded: value.status,
    wslListObserved: value.observed,
    wslListSucceeded: value.list,
    originalCount: 0,
    requiredPartitionOriginalCount: 2,
    previewOriginalCount: 0,
    completeGroup: false,
    visualReview: "pending",
  });
  const script = wslSteps().find(
    (step) => step.name === "Record native WSL prerequisite unavailable",
  )!.run!;
  expect(script.indexOf("Set-Acl -LiteralPath $root -AclObject $acl")).toBeLessThan(
    script.indexOf("Set-Content -LiteralPath"),
  );
  expect(script.indexOf("Set-Content -LiteralPath")).toBeLessThan(
    script.indexOf("throw 'Native WSL partition remains unavailable'"),
  );
});
it.each([
  { reason: "foreign", status: false, observed: false, list: null },
  { reason: "wsl-status-failed", status: true, observed: false, list: null },
  { reason: "wsl-status-failed", status: false, observed: true, list: false },
  { reason: "wsl-list-failed", status: true, observed: false, list: null },
  { reason: "wsl-list-failed", status: true, observed: true, list: true },
  { reason: "wsl-no-distro", status: true, observed: true, list: false },
  { reason: "wsl-no-distro", status: false, observed: false, list: null },
])(
  "refuses contradictory native unavailable metadata: $reason/$status/$observed/$list",
  (value) => {
    expect(closedWslUnavailable(value.reason, value.status, value.observed, value.list)).toBeNull();
  },
);
it("uses only the original WSL reads and keeps default skip separate", () => {
  const steps = wslSteps(),
    script = steps.find((step) => step.id === "wsl")!.run!;
  expect(script.match(/\$output = wsl --status\b/g)).toHaveLength(1);
  expect(script.match(/\$distros = @\(wsl --list --quiet\b/g)).toHaveLength(1);
  const list = script.indexOf("$distros = @(wsl --list --quiet");
  expect(script.lastIndexOf("if ($statusAvailable) {", list)).toBeGreaterThan(0);
  expect(sourceBoolean(precedingSourceCondition(script, list), { statusAvailable: false })).toBe(
    false,
  );
  expect(sourceBoolean(precedingSourceCondition(script, list), { statusAvailable: true })).toBe(
    true,
  );
  for (const field of ["status_succeeded", "list_observed", "list_succeeded", "reason_code"]) {
    const condition = precedingSourceCondition(script, script.indexOf('"' + field + "="));
    expect(sourceBoolean(condition, { nativeSelected: false })).toBe(false);
    expect(sourceBoolean(condition, { nativeSelected: true })).toBe(true);
  }
  expect(script).not.toMatch(
    /--(?:install|import|update|set-default|shutdown)|Invoke-WebRequest|Restart-Computer/,
  );
  expect(steps.find((step) => step.name === "Record unavailable WSL capability")!.if).toBe(
    "steps.wsl.outputs.available != 'true'",
  );
  expect(steps.find((step) => step.name === "Record native WSL prerequisite unavailable")!.if).toBe(
    "inputs.native_followups == true && steps.wsl.outputs.available != 'true'",
  );
});
const args = [
  "--native-followups",
  "--platform",
  "linux",
  "--arch",
  "x64",
  "--bundle",
  "appimage",
  "--candidate-version",
  "0.8.1-native.1",
  "--previous-tag",
  "v0.8.0",
  "--previous-version",
  "0.8.0",
  "--public-key-file",
  NodePath.resolve("/owned/key.pub"),
  "--run-id",
  "owned-1",
  "--work-root",
  NodePath.resolve("/owned/work"),
  "--artifact-dir",
  NodePath.resolve("/owned/evidence"),
  "--updater-port",
  "43120",
  "--restart-timeout-ms",
  "180000",
];
it("binds only the selected nonroot Linux or real Windows WSL owner and fixed scope", () => {
  const input = parseSeededDesktopUpgradeSmokeArgs(args, root),
    host = { CI: "true", actions: "true", platform: "linux", uid: 1000, sourceSha: "a".repeat(40) };
  expect(nativeFollowupWorkflowPlan(input, host)).toEqual({
    partition: "linux-menu-update",
    expectedOriginals: 6,
  });
  for (const value of [
    { ...host, uid: 0 },
    { ...host, CI: undefined },
    { ...host, platform: "darwin" },
  ])
    expect(() => nativeFollowupWorkflowPlan(input, value)).toThrow();
  expect(() => nativeFollowupWorkflowPlan({ ...input, nativeFollowups: false }, host)).toThrow();
  expect(
    nativeFollowupWorkflowPlan(
      { ...input, platform: "win", bundle: "nsis", wsl: true },
      { ...host, platform: "win32", uid: null },
    ),
  ).toEqual({ partition: "windows-wsl", expectedOriginals: 2 });
  expect(() =>
    nativeFollowupWorkflowPlan(
      { ...input, platform: "win", bundle: "nsis", wsl: false },
      { ...host, platform: "win32", uid: null },
    ),
  ).toThrow();
});
it("never describes an unavailable or partial partition as group acceptance", () => {
  expect(
    nativeFollowupWorkflowStatus("a".repeat(40), "windows-wsl", "unavailable", 0),
  ).toMatchObject({
    status: "unavailable",
    originalCount: 0,
    previewOriginalCount: 0,
    completeGroup: false,
  });
  expect(() =>
    nativeFollowupWorkflowStatus("a".repeat(40), "windows-wsl", "partition-complete", 0),
  ).toThrow();
  expect(
    nativeFollowupWorkflowStatus("a".repeat(40), "linux-menu-update", "partition-complete", 6),
  ).toMatchObject({ completeGroup: false, previewOriginalCount: 0, visualReview: "pending" });
});
it("preserves the normal matrix/default lanes and binds finite native evidence through the existing owner", () => {
  const upgrade = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ),
  );
  expect(upgrade.on.workflow_call.inputs.native_followups.default).toBe(false);
  expect(upgrade.jobs.seeded_upgrade_smoke.strategy.matrix.include).toHaveLength(6);
  expect(upgrade.jobs.seeded_upgrade_smoke["timeout-minutes"]).toBe(
    "${{ matrix.jobTimeoutMinutes }}",
  );
  const linux = upgrade.jobs.native_followups_linux;
  expect(linux.runsOn ?? linux["runs-on"]).toBe("ubuntu-22.04");
  expect(linux["timeout-minutes"]).toBe(240);
  const commands = linux.steps.map((step: { run?: string }) => step.run ?? "").join("\n");
  expect(commands).toContain("-screen 0 1280x960x24 -dpi 96");
  expect(commands).toContain("--native-followups --platform linux --arch x64 --bundle appimage");
  expect(commands).toContain("--restart-timeout-ms 180000");
  expect(commands).not.toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.");
  const artifact = linux.steps.find(
    (step: { name: string }) =>
      step.name === "Retain finite native Linux originals and closed status",
  );
  const names = artifact.with.path
    .split("\n")
    .filter(Boolean)
    .map((line: string) => line.slice(line.lastIndexOf("/") + 1));
  expect(names).toHaveLength(10);
  expect(names.filter((name: string) => name.endsWith(".png"))).toHaveLength(6);
  expect(names).not.toContain("native-preview-annotations-light.png");
  expect(artifact.with.path).not.toMatch(/\*|\.log|private|sign/);
  const win = upgrade.jobs.windows_wsl_upgrade_smoke;
  expect(win["timeout-minutes"]).toBe(240);
  expect(
    win.steps.some(
      (step: { name: string; if?: string }) =>
        step.name === "Record native WSL prerequisite unavailable" &&
        step.if?.includes("inputs.native_followups == true"),
    ),
  ).toBe(true);
  const visual = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/qualify-release-visuals.yml", import.meta.url),
      "utf8",
    ),
  );
  expect(visual.jobs.native_followups.uses).toBe("./.github/workflows/desktop-upgrade-smoke.yml");
  expect(visual.jobs.native_followups.with.native_followups).toBe(true);
  expect(visual.jobs.native_followups.if).toContain("github.event.repository.default_branch");
});

it("retains only fixed owning terminal phases in the existing status packet", () => {
  expect(
    nativeFollowupWorkflowStatus(
      "a".repeat(40),
      "linux-menu-update",
      "failed",
      0,
      "native-linux-address",
    ),
  ).toMatchObject({
    phase: "native-linux-address",
    originalCount: 0,
    status: "failed",
    completeGroup: false,
  });
  expect(() =>
    nativeFollowupWorkflowStatus(
      "a".repeat(40),
      "linux-menu-update",
      "failed",
      0,
      "inert private value" as never,
    ),
  ).toThrow();
  const source = NodeFS.readFileSync(
    new URL("./qualify-native-followups-workflow.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("observeNativeFollowupPhase:");
  expect(source).toContain('phase = "native-result-admission";');
  expect(source).toContain(
    "nativeFollowupWorkflowStatus(sourceSha, plan.partition, status, count, phase)",
  );
});
