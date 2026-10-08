// @effect-diagnostics nodeBuiltinImport:off - Static workflow and inert fixed-input policy tests never launch an OS or application.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as YAML from "yaml";
import { expect, it } from "vite-plus/test";
import {
  nativeFollowupWorkflowPlan,
  nativeFollowupWorkflowStatus,
  projectNativeFollowupLinuxServiceAdmission,
} from "./qualify-native-followups-workflow.ts";
import { parseSeededDesktopUpgradeSmokeArgs } from "./seeded-desktop-upgrade-smoke.ts";
const root = NodePath.resolve(".");
it("runs the owned WSL fixture caller and policy checks in both native partitions", () => {
  const workflow = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ),
  );
  const runs: string[] = [];
  for (const job of Object.values(workflow.jobs)) {
    if (!job || typeof job !== "object" || !("steps" in job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (
        typeof step.run === "string" &&
        step.run.includes("release-visual-native-followups-backup.test.ts")
      )
        runs.push(step.run);
    }
  }
  expect(runs).toHaveLength(2);
  for (const run of runs) {
    expect(run).toContain("scripts/owned-wsl2-fixture-caller.test.ts");
    expect(run).toContain("scripts/lib/owned-wsl2-fixture.test.ts");
  }
});
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
    "inputs.native_followups != true && steps.wsl.outputs.available != 'true'",
  );
  expect(steps.find((step) => step.name === "Record native WSL prerequisite unavailable")!.if).toBe(
    "always() && inputs.native_followups == true && steps.native_wsl.outputs.available != 'true'",
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
      {
        ...input,
        platform: "win",
        bundle: "nsis",
        wsl: true,
        ownedWslManifest: NodePath.resolve("/owned/manifest.secret.json"),
      },
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

it("selects the existing Windows partition without repeating Linux only when explicitly requested", () => {
  const upgrade = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ),
  );
  for (const event of ["workflow_dispatch", "workflow_call"]) {
    expect(upgrade.on[event].inputs.native_windows_only).toMatchObject({
      type: "boolean",
      default: false,
    });
  }
  const admits = (condition: string | undefined, native: boolean, windows: boolean) =>
    condition === undefined ||
    NodeVM.runInNewContext(condition.slice(3, -2).trim(), {
      inputs: { native_followups: native, native_windows_only: windows },
    });
  const combinations: ReadonlyArray<
    readonly [native: boolean, windows: boolean, linuxExpected: boolean, ordinaryExpected: boolean]
  > = [
    [false, false, false, true],
    [false, true, false, true],
    [true, false, true, false],
    [true, true, false, false],
  ];
  for (const [native, windows, linuxExpected, ordinaryExpected] of combinations) {
    expect(admits(upgrade.jobs.native_followups_linux.if, native, windows)).toBe(linuxExpected);
    expect(admits(upgrade.jobs.seeded_upgrade_smoke.if, native, windows)).toBe(ordinaryExpected);
    expect(admits(upgrade.jobs.windows_wsl_upgrade_smoke.if, native, windows)).toBe(true);
  }
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
  expect(source).toMatch(
    /nativeFollowupWorkflowStatus\(\s*sourceSha,\s*plan\.partition,\s*status,\s*count,\s*observation\.phase,\s*observation\.phase === "native-linux-service-admission"\s*\? observation\.linuxServiceAdmission\s*: null,?\s*status === "failed" \? observation\.nativeDriverEvidence : null,?\s*\)/,
  );
});

it.each([
  "native-driver-command-timeout",
  "native-driver-command-rejected",
  "native-linux-service-admission",
] as const)("retains only the fixed native driver outcome phase: %s", (phase) => {
  expect(
    nativeFollowupWorkflowStatus("a".repeat(40), "linux-menu-update", "failed", 0, phase),
  ).toMatchObject({ phase, originalCount: 0, status: "failed", completeGroup: false });
});

it("refuses nonclosed Linux service metadata at the existing status boundary", () => {
  const value = {
    driverOutcome: "nonzero",
    services: ["dbus", "openbox", "xsettings", "accessibility", "portal-gtk", "portal"].map(
      (role) => ({ role, done: role === "portal", overflow: false }),
    ),
  };
  expect(projectNativeFollowupLinuxServiceAdmission(value)).toEqual(value);
  let traps = 0;
  const accessor = { ...value };
  Object.defineProperty(accessor, "services", {
    enumerable: true,
    get: () => {
      traps++;
      return value.services;
    },
  });
  for (const invalid of [
    { ...value, pid: 1 },
    { ...value, driverOutcome: "success" },
    { ...value, services: value.services.slice(1) },
    { ...value, services: value.services.map((row) => ({ ...row, done: 1 })) },
    { ...value, services: [...value.services.slice(0, 5), value.services[0]] },
    accessor,
    new Proxy(value, {
      ownKeys: () => {
        traps++;
        return Reflect.ownKeys(value);
      },
    }),
  ])
    expect(() => projectNativeFollowupLinuxServiceAdmission(invalid)).toThrow();
  expect(traps).toBe(0);
  expect(() =>
    nativeFollowupWorkflowStatus(
      "a".repeat(40),
      "linux-menu-update",
      "partition-complete",
      6,
      "native-result-admission",
      value,
    ),
  ).toThrow();
  expect(() =>
    nativeFollowupWorkflowStatus(
      "a".repeat(40),
      "windows-wsl",
      "failed",
      0,
      "native-linux-service-admission",
      value,
    ),
  ).toThrow();
});

it("admits optional GPG evidence only in the selected manual Windows context", () => {
  const workflow = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps = workflow.jobs.windows_wsl_upgrade_smoke.steps;
  const reserve = steps.find((step: { id?: string }) => step.id === "gpg_private_root");
  expect(reserve).toBeDefined();
  const upload = steps.find((step: { id?: string }) => step.id === "gpg_private_upload");
  expect(upload).toBeDefined();
  const evaluate = (
    expression: string,
    event: string,
    native: boolean,
    windows: boolean,
    key: string,
    fingerprint: string,
  ) =>
    NodeVM.runInNewContext(expression.replace(/\$\{\{|\}\}/g, ""), {
      github: { event_name: event },
      inputs: {
        native_followups: native,
        native_windows_only: windows,
        gpg_evidence_public_spki: key,
        gpg_evidence_public_sha256: fingerprint,
      },
      always: () => true,
      steps: { gpg_private_root: { outputs: { ready: "true" } } },
    });
  for (const [event, native, windows, key, fingerprint, want] of [
    ["workflow_dispatch", true, true, "inert", "inert", true],
    ["workflow_call", true, true, "inert", "inert", false],
    ["pull_request", true, true, "inert", "inert", false],
    ["workflow_dispatch", false, true, "inert", "inert", false],
    ["workflow_dispatch", true, false, "inert", "inert", false],
    ["workflow_dispatch", true, true, "", "inert", false],
    ["workflow_dispatch", true, true, "inert", "", false],
  ] satisfies Array<[string, boolean, boolean, string, string, boolean]>) {
    expect(evaluate(reserve.if, event, native, windows, key, fingerprint)).toBe(want);
    expect(evaluate(upload.if, event, native, windows, key, fingerprint)).toBe(want);
  }
  expect(workflow.on.workflow_dispatch.inputs.gpg_evidence_public_spki.default).toBe("");
  expect(workflow.on.workflow_dispatch.inputs.gpg_evidence_public_sha256.default).toBe("");
  expect(workflow.on.workflow_call.inputs.gpg_evidence_public_spki).toBeUndefined();
  expect(workflow.on.workflow_call.inputs.gpg_evidence_public_sha256).toBeUndefined();
  expect(steps.indexOf(reserve)).toBeLessThan(
    steps.findIndex((step: { id?: string }) => step.id === "native_wsl"),
  );
  expect(reserve["continue-on-error"]).toBe(true);
  expect(upload["continue-on-error"]).toBe(true);
  expect(upload.with["retention-days"]).toBe(1);
  expect(upload.with["if-no-files-found"]).toBe("ignore");
  expect(
    upload.with.path
      .split("\n")
      .filter(Boolean)
      .map((path: string) => path.split("/").at(-1)),
  ).toEqual([
    "context.json",
    "stderr.aesgcm.bin",
    "key.rsa-oaep-sha256.bin",
    "nonce.bin",
    "tag.bin",
  ]);
  expect(upload.with.path).not.toMatch(/\*|TestDrive|command-/);
});

it("arms approved Prepare refusal evidence only after passing Pester and revokes inside invocation/receipt lifetime", () => {
  const source = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ),
  );
  expect(source.on.workflow_dispatch.inputs.wsl_prepare_refusal_evidence).toEqual({
    description: "Optional encrypted original Windows owned Prepare refusal",
    type: "boolean",
    default: false,
  });
  expect(source.on.workflow_call.inputs.wsl_prepare_refusal_evidence).toBeUndefined();
  const step = source.jobs.windows_wsl_upgrade_smoke.steps.find(
    (value: { id?: string }) => value.id === "native_wsl",
  );
  const condition = step.env.BIBCODE_PREPARE_REFUSAL_SELECTED.slice(3, -2).trim();
  for (const event of ["workflow_dispatch", "pull_request", "workflow_call"]) {
    for (const selected of [true, false]) {
      const admitted = NodeVM.runInNewContext(condition, {
        github: { event_name: event },
        inputs: {
          native_followups: true,
          native_windows_only: true,
          wsl_prepare_refusal_evidence: selected,
        },
      });
      expect(admitted).toBe(event === "workflow_dispatch" && selected);
    }
  }
  const body: string = step.run;
  expect(body.indexOf("$tests.FailedCount -ne 0")).toBeLessThan(
    body.indexOf("$prepareEvidenceState=@"),
  );
  expect(body.indexOf("RecipientAdmitted(")).toBeLessThan(
    body.indexOf("$prepareEvidenceState.active=$null"),
  );
  expect(body).toContain("scope='wsl-owned-prepare-refusal'");
  expect(body).toContain("-PrepareRefusalObserver $prepareRefusalObserver");
  const invoke = body.indexOf("$result = & ./scripts/owned-wsl2-fixture.ps1 -Action Prepare");
  const receipt = body.indexOf("$receipt = $result | ConvertFrom-Json", invoke);
  const revoke = body.indexOf("$prepareEvidenceState.active=$false", receipt);
  expect(invoke).toBeGreaterThan(0);
  expect(receipt).toBeGreaterThan(invoke);
  expect(revoke).toBeGreaterThan(receipt);
  expect(body).toContain("} finally {");
  const artifact = source.jobs.windows_wsl_upgrade_smoke.steps.find(
    (value: { id?: string }) => value.id === "gpg_private_upload",
  );
  expect(artifact.with.path.trim().split("\n")).toHaveLength(5);
  expect(artifact.with["retention-days"]).toBe(1);
  expect(artifact["continue-on-error"]).toBe(true);
  expect(artifact.with.path).not.toMatch(/\*|\.log|\.ps1/);
});

it("keeps real Linux backend tests registered and adds the same cheap frozen Windows helper gate", () => {
  const upgrade = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ),
  );
  const cheap = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/owned-wsl-fixture-controls.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps: Array<{ name?: string; run?: string }> = cheap.jobs.caller_controls.steps;
  const pester = steps.findIndex((step) => step.run?.includes("Invoke-Pester"));
  const frozen = steps.findIndex((step) => step.run === "vp install --frozen-lockfile");
  const helper = steps.findIndex((step) =>
    step.run?.includes("release-visual-native-followups-portable.test.ts"),
  );
  expect(pester).toBeGreaterThan(0);
  expect(frozen).toBeGreaterThan(pester);
  expect(helper).toBeGreaterThan(frozen);
  expect(cheap.jobs.caller_controls["runs-on"]).toBe("${{ matrix.runner }}");
  expect(cheap.jobs.caller_controls.strategy.matrix.runner).toEqual([
    "windows-2025",
    "ubuntu-22.04",
  ]);
  expect(steps[pester]).toHaveProperty("if", "runner.os == 'Windows'");
  for (const role of ["backup", "session", "update"]) {
    const name = "apps/desktop/e2e/support/release-visual-native-followups-" + role + ".test.ts";
    const linuxRuns = upgrade.jobs.native_followups_linux.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(linuxRuns).toContain(name);
    expect(steps[helper]?.run).toContain(name);
    const source = NodeFS.readFileSync(new URL("../" + name, import.meta.url), "utf8");
    expect(source).toContain('const linuxIt = it.runIf(fixturePlatform === "linux")');
    expect(source).toContain("const fixturePlatform = HostProcessPlatform.defaultValue()");
  }
  expect(steps[helper]?.run).toContain("scripts/seeded-desktop-upgrade-smoke.test.ts");
});

it("requires child IPC readiness and preserves the primary late-tail fixture error", () => {
  const tests = NodeFS.readFileSync(
    new URL("./seeded-desktop-upgrade-smoke.test.ts", import.meta.url),
    "utf8",
  );
  const begin = tests.indexOf(
    'it("retains late stdout and waits for close after the normal command exits"',
  );
  const end = tests.indexOf('it.each(["raw",', begin);
  const body = tests.slice(begin, end);
  expect(body).toContain('writer.once("message"');
  expect(body).not.toContain('writer.once("spawn"');
  expect(body).toContain('process.send("writer-ready")');
  expect(body).toContain('expect(result.stdout).toBe("early|late-tail")');
  expect(body).toContain("if (!failed) original = error");
  expect(body).toContain("if (writerJoined)");
});

it("admits failed Windows prerequisite status only after installed dependencies and skipped wrapper", () => {
  const source = NodeFS.readFileSync(
    new URL("./qualify-native-followups-workflow.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("export function nativeFollowupFailedWindowsStatusEligible(");
  const begin = source.indexOf("export function nativeFollowupFailedWindowsStatusEligible("),
    end = source.indexOf("export async function recordFailedNativeWindowsStatus(", begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const method = NodeVM.runInNewContext(
    source
      .slice(begin, end)
      .replace(/^export /, " ")
      .replace(/: NodeJS.ProcessEnv/g, "")
      .replace(/: string/g, "") + "\nnativeFollowupFailedWindowsStatusEligible;",
  );
  const env = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    BIBCODE_NATIVE_STATUS_SELECTED: "true",
    BIBCODE_NATIVE_STATUS_PREPARE_AVAILABLE: "true",
    BIBCODE_NATIVE_STATUS_DEPENDENCIES: "success",
    BIBCODE_NATIVE_STATUS_PREREQUISITE: "failure",
    BIBCODE_NATIVE_STATUS_WRAPPER: "skipped",
    BIBCODE_NATIVE_STATUS_CANCELLED: "false",
  };
  expect(method(env, "win32")).toBe(true);
  for (const [field, value] of [
    ["CI", "false"],
    ["GITHUB_ACTIONS", "false"],
    ["BIBCODE_NATIVE_STATUS_SELECTED", "false"],
    ["BIBCODE_NATIVE_STATUS_PREPARE_AVAILABLE", "false"],
    ["BIBCODE_NATIVE_STATUS_DEPENDENCIES", "failure"],
    ["BIBCODE_NATIVE_STATUS_PREREQUISITE", "success"],
    ["BIBCODE_NATIVE_STATUS_PREREQUISITE", "skipped"],
    ["BIBCODE_NATIVE_STATUS_PREREQUISITE", "cancelled"],
    ["BIBCODE_NATIVE_STATUS_WRAPPER", "success"],
    ["BIBCODE_NATIVE_STATUS_WRAPPER", "failure"],
    ["BIBCODE_NATIVE_STATUS_CANCELLED", "true"],
  ] as const)
    expect(method({ ...env, [field]: value }, "win32")).toBe(false);
  expect(method(env, "linux")).toBe(false);
  expect(method(env, "darwin")).toBe(false);
});
it("workflow retains failure-only status with the original six-item artifact policy", () => {
  const source = YAML.parse(
    NodeFS.readFileSync(
      new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps = source.jobs.windows_wsl_upgrade_smoke.steps;
  const fallback = steps.find((step: { id?: string }) => step.id === "native_wsl_failed_status");
  expect(fallback).toBeDefined();
  expect(fallback.run).toContain("--failed-windows-prerequisite-status");
  expect(fallback.if).toContain("!cancelled()");
  expect(fallback.env.BIBCODE_NATIVE_STATUS_CANCELLED).toBe("false");
  for (const value of Object.values(fallback.env))
    expect(value).not.toMatch(/\b(?:always|cancelled|failure|success)\(\)/);
  expect(fallback.if).toContain("steps.wsl_dependencies.outcome == 'success'");
  expect(fallback.if).toContain("steps.native_wsl_visuals.outcome == 'skipped'");
  const expression = fallback.if.replace(/\$\{\{|\}\}/g, "");
  const conditions = {
    inputs: { native_followups: true },
    runner: { os: "Windows" },
    steps: {
      native_wsl: { outputs: { available: "true" } },
      wsl_dependencies: { outcome: "success" },
      native_wsl_visuals: { outcome: "skipped" },
      native_wsl_source_gates: { outcome: "failure" },
      native_wsl_public_controls: { outcome: "skipped" },
      wsl_versions: { outcome: "skipped" },
      native_wsl_signing: { outcome: "skipped" },
    },
    always: () => true,
    cancelled: () => false,
  };
  expect(NodeVM.runInNewContext(expression, conditions)).toBe(true);
  for (const override of [
    { cancelled: () => true },
    { inputs: { native_followups: false } },
    { runner: { os: "Linux" } },
    { steps: { ...conditions.steps, native_wsl: { outputs: { available: "false" } } } },
    { steps: { ...conditions.steps, native_wsl_visuals: { outcome: "failure" } } },
    { steps: { ...conditions.steps, wsl_dependencies: { outcome: "failure" } } },
  ])
    expect(NodeVM.runInNewContext(expression, { ...conditions, ...override })).toBe(false);
  const upload = steps.find(
    (step: { name?: string }) =>
      step.name === "Retain finite native WSL originals and closed status",
  );
  expect(upload.with.path.split("\n").filter(Boolean)).toHaveLength(6);
  expect(upload.with["if-no-files-found"]).toBe("error");
  expect(upload.with["retention-days"]).toBe(7);
  expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  expect(steps.indexOf(fallback)).toBeLessThan(steps.indexOf(upload));
});
