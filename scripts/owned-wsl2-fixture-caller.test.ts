// @effect-diagnostics nodeBuiltinImport:off - Actual workflow/harness source, inert command ports only.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import * as YAML from "yaml";
import { it, expect } from "vite-plus/test";
import { joinOwnedWslCleanup } from "./lib/owned-wsl2-fixture.ts";
const harness = NodeFS.readFileSync(
  new URL("./seeded-desktop-upgrade-smoke.ts", import.meta.url),
  "utf8",
);
const workflow = YAML.parse(
  NodeFS.readFileSync(
    new URL("../.github/workflows/desktop-upgrade-smoke.yml", import.meta.url),
    "utf8",
  ),
);
it("the actual native owner closes app before fixture and retains evidence only after all cleanup", () => {
  const fixture = harness.indexOf('cleanup.add("owned WSL2 test fixture", close)'),
    app = harness.indexOf('cleanup.add("isolated native follow-up application"', fixture),
    attempt = harness.indexOf('await invokeWslFixture("AppAttempted")', app),
    driver = harness.indexOf("await runUpgradeLane({", attempt),
    cleanup = harness.indexOf("await cleanup.cleanup()", driver),
    retain = harness.indexOf("retainNativeFollowupEvidence({", cleanup);
  expect(fixture).toBeGreaterThan(0);
  expect(app).toBeGreaterThan(fixture);
  expect(attempt).toBeGreaterThan(app);
  expect(driver).toBeGreaterThan(attempt);
  expect(retain).toBeGreaterThan(cleanup);
  expect(harness.slice(app, attempt)).toContain('await invokeWslFixture("AppJoined")');
});
it("the actual cleanup factory independently joins terminate/unregister/restoration and stops before deletion on failure", async () => {
  const begin = harness.indexOf("        const close = joinOwnedWslCleanup("),
    end = harness.indexOf('        cleanup.add("owned WSL2 test fixture", close);', begin);
  expect(begin).toBeGreaterThan(0);
  const events: string[] = [],
    fault = new Error("inert exact terminate failure");
  const close = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(harness.slice(begin, end)) + "\nclose",
    {
      joinOwnedWslCleanup,
      invokeWslFixture: async (action: string) => {
        events.push(action);
        if (action === "Terminate") throw fault;
      },
    },
  ) as () => Promise<void>;
  await expect(close()).rejects.toBe(fault);
  expect(events).toEqual(["VerifyOwner", "Terminate", "Unregister", "Restored"]);
});
it("the complete selected workflow gates a real kernel fixture and passes its manifest without affecting the ordinary matrix", () => {
  const steps = workflow.jobs.windows_wsl_upgrade_smoke.steps,
    prepare = steps.find((step: { id?: string }) => step.id === "native_wsl");
  expect(prepare.if).toBe("inputs.native_followups == true");
  expect(prepare.run).toContain("-Action Prepare");
  expect(prepare.run).toContain("status_succeeded");
  expect(prepare.run).toContain("list_succeeded");
  const run = steps.find(
    (step: { name?: string }) => step.name === "Run existing native Local WSL originals",
  );
  expect(run.if).toBe(
    "inputs.native_followups == true && steps.native_wsl.outputs.available == 'true'",
  );
  expect(run.run).toContain('--owned-wsl-manifest "$BIBCODE_NATIVE_WSL_MANIFEST"');
  const restore = steps.findIndex(
      (step: { name?: string }) =>
        step.name === "Join only the owned native WSL2 fixture after native app cleanup",
    ),
    publish = steps.findIndex(
      (step: { name?: string }) =>
        step.name === "Retain finite native WSL originals and closed status",
    );
  expect(restore).toBeLessThan(publish);
  expect(steps[restore].run).toContain("@('Terminate','Unregister','Restored')");
  expect(steps[restore].run).not.toMatch(/--shutdown|--set-default/);
  const ordinary = steps.find(
    (step: { name?: string }) => step.name === "Run protected WSL storage-identity upgrade",
  );
  expect(ordinary.run).not.toContain("--owned-wsl-manifest");
  expect(ordinary.if).toBe(
    "steps.wsl.outputs.available == 'true' && inputs.native_followups != true",
  );
});

const prepareStages = [
  "runtime-admission",
  "private-root-acl",
  "launcher-admission",
  "empty-inventory",
  "launcher-readiness",
  "verifier-admission",
  "signed-metadata",
  "image-admission",
  "intent-write",
  "owned-import",
  "kernel-admission",
  "mapping-admission",
] as const;
it("keeps Prepare stage labels and actual PowerShell recorder validations source-consistent", () => {
  const source = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
  expect(
    [...source.matchAll(/\$script:OwnedWslPrepareStage='([^']+)'/g)].map((match) => match[1]),
  ).toEqual([...prepareStages]);
  const steps = workflow.jobs.windows_wsl_upgrade_smoke.steps,
    prepare = steps.find((step: { id?: string }) => step.id === "native_wsl"),
    recorder = steps.find(
      (step: { name?: string }) => step.name === "Record native WSL prerequisite unavailable",
    );
  expect(prepare.run).toContain("(-not ($receipt.completed -is [bool]))");
  expect(prepare.run).toContain("$receipt.completed -ne $false");
  for (const body of [prepare.run, recorder.run]) {
    expect(body).toContain("(-not ($prepareStage -is [string]))");
    const list = body.match(/\$prepareStage -cnotin @\(([^)]+)\)/)?.[1];
    expect(list?.split(",").map((value: string) => value.trim().slice(1, -1))).toEqual([
      ...prepareStages,
    ]);
  }
  expect(recorder.run).toContain("if ($reasonCode -eq 'wsl-fixture-owner-refused')");
  expect(recorder.run).toContain("$status.prepareStage = $prepareStage");
  // These are source-consistency assertions, not execution of PowerShell admission or serialization.
});

it("keeps signed metadata schema confined to actual failed receipt/recorder source", () => {
  const steps = workflow.jobs.windows_wsl_upgrade_smoke.steps,
    prepare = steps.find((step: { id?: string }) => step.id === "native_wsl"),
    recorder = steps.find(
      (step: { name?: string }) => step.name === "Record native WSL prerequisite unavailable",
    );
  for (const body of [prepare.run, recorder.run]) {
    expect(body).toContain("function Assert-SignedMetadata($value)");
    expect(body).toContain("(-not ($value.item -is [string]))");
    expect(body).toContain("-cnotin @('key','checksums','signature')");
    expect(body).toContain("(-not ($value.$key -is [bool]))");
    expect(body).toContain("(-not ($number -is [int]))");
    expect(body).toContain("$number -gt $high");
  }
  expect(prepare.run).toContain("if($prepareStage -ceq 'signed-metadata')");
  expect(recorder.run).toContain("$status.signedMetadata=$signedMetadata");
  const owner = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
  expect(owner).toContain("$receipt.signedMetadata=[ordered]@{}");
  expect(owner).toContain("$child.ExitCode");
});
