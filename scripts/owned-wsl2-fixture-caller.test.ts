// @effect-diagnostics nodeBuiltinImport:off - Actual workflow/harness source, inert command ports only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
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

it("keeps Pester URI extraction and fake download output aligned with the actual owner", () => {
  const owner = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
  const tests = NodeFS.readFileSync(
    new URL("./owned-wsl2-fixture.Tests.ps1", import.meta.url),
    "utf8",
  );
  const start = owner.indexOf("foreach($download in ");
  const end = owner.indexOf(") {", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(owner.slice(start, end)).toContain("$ReleaseBase+'SHA256SUMS.gpg'");
  expect(tests).toContain("$source.IndexOf(') {', $start, [StringComparison]::Ordinal)");
  expect(tests).not.toContain(") { Invoke-WebRequest");
  expect(tests).toContain(
    "function Invoke-WebRequest([switch]$PassThru) { Test-StageFault;if($PassThru){@{StatusCode=200}} }",
  );
  expect(owner).toContain("-MaximumRedirection 0 -PassThru");
  expect(owner).toContain("-TimeoutSec 300 -MaximumRedirection 0;Set-OwnerAcl $image");
  // Source consistency only: execution of these PowerShell ports remains a Windows CI gate.
});
it("keeps real GPG assertions and exposes only closed facts from its owned command receipt", () => {
  const tests = NodeFS.readFileSync(
    new URL("./owned-wsl2-fixture.Tests.ps1", import.meta.url),
    "utf8",
  );
  for (const operation of ["gpg-import", "fingerprint-admission", "signature-admission"]) {
    expect(tests).toContain(`Invoke-PinnedMetadataCommand '${operation}'`);
  }
  expect(tests).toContain("commandReceiptPresent=true; commandExit=");
  expect(tests).toContain("($command.stdout.Length -gt 0)");
  expect(tests).toContain("($command.stderr.Length -gt 0)");
  expect(tests).toContain(
    "$command.exitCode|Should -Be $script:OwnedWslSignedMetadata.commandExit",
  );
  expect(tests).toContain("throw $originalFailure");
  expect(tests).toContain("$corrupt)}|Should -Throw");
  expect(tests).toContain("Assert-PhysicalPin $gpgPin");
});

it("keeps GPG category projection test-only and based on the already-read stderr", () => {
  const tests = NodeFS.readFileSync(
    new URL("./owned-wsl2-fixture.Tests.ps1", import.meta.url),
    "utf8",
  );
  const owner = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
  expect(tests).toContain("Get-PinnedGpgErrorCategory $command.stderr");
  expect(tests).toContain("keybox ''[^''\\r\\n]+'': ");
  expect(tests).not.toContain("keybox .+:|");
  for (const category of [
    "other",
    "input-open-read",
    "storage-open-create",
    "storage-permission",
  ]) {
    expect(tests).toMatch(new RegExp(`C:/inert[^\\n]+Category='${category}'`));
  }
  expect(tests).toContain("Owned WSL2 pinned GPG closed error category (inert)");
  expect(owner).not.toContain("Get-PinnedGpgErrorCategory");
  const start = tests.indexOf("function Get-PinnedGpgErrorCategory");
  const end = tests.indexOf("return 'other'", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(
    [...tests.slice(start, end).matchAll(/return '([^']+)'/g)].map((match) => match[1]),
  ).toEqual([
    "storage-permission",
    "storage-open-create",
    "invalid-key-data",
    "input-open-read",
    "runtime-agent",
  ]);
  expect(tests.slice(start, end)).not.toMatch(/Invoke-|Get-Content|Start-Process|Write-/);
  expect(tests).toContain("if($command.exitCode -ne 0){");
  expect(tests).toContain("throw $originalFailure");
  // Source consistency only; classifier and real GPG execution require Windows Pester.
});

it("keeps complete import-input failure facts passive and test-only", () => {
  const tests = NodeFS.readFileSync(
    new URL("./owned-wsl2-fixture.Tests.ps1", import.meta.url),
    "utf8",
  );
  const owner = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
  expect(owner).not.toContain("Get-PinnedGpgInputError");
  expect(tests).toContain("Get-PinnedGpgInputError $command.stderr $ExpectedInput");
  expect(tests).toContain("$lines.Count -ne 1");
  expect(tests).toContain("[IO.Path]::IsPathFullyQualified($operand)");
  expect(tests).toContain("[StringComparison]::OrdinalIgnoreCase");
  expect(tests).toContain("$key) $key|Out-Null");
  expect(tests).toContain("if($Operation -ceq 'gpg-import')");
  const start = tests.indexOf("function Get-PinnedGpgInputError");
  const end = tests.indexOf('. "$PSScriptRoot/owned-wsl2-fixture.ps1"', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const helper = tests.slice(start, end);
  expect(helper).not.toMatch(/Invoke-|Get-Content|Start-Process|Write-|Test-Path/);
  expect([...helper.matchAll(/result\.errno='([^']+)'/g)].map((match) => match[1])).toEqual([
    "missing-input",
    "permission-denied",
    "invalid-argument",
    "io-error",
  ]);
  expect(helper).toContain("errno='other';expectedInputMatched=$false");
  expect(tests).toContain("throw $failureMessage");
  expect(tests).toContain("throw $originalFailure");
  expect(tests).toContain("$testsSource.Substring($start,$end-$start)+$call");
  expect(tests).toContain("errno=permission-denied; expectedInputMatched=True");
  // Source consistency only; complete Pester helper/real GPG execution remains CI-only.
});

it("confines private GPG evidence to the existing failed import catch", () => {
  const tests = NodeFS.readFileSync(
    new URL("./owned-wsl2-fixture.Tests.ps1", import.meta.url),
    "utf8",
  );
  const owner = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
  expect(owner).not.toMatch(/OwnedGpgEvidenceV1|Save-GpgPrivateEvidence/);
  const start = tests.indexOf("function Invoke-PinnedMetadataCommand(");
  const end = tests.indexOf("\n      Invoke-PinnedMetadataCommand 'gpg-import'", start);
  const wrapper = tests.slice(start, end);
  expect(wrapper).toContain("[void](Save-GpgPrivateEvidence $command.stderr)");
  expect(wrapper).toContain(
    "$Operation -ceq 'gpg-import' -and $script:GpgPrivateEvidenceRealContext -eq $true",
  );
  expect(wrapper).toContain("catch { }");
  expect(wrapper).toContain("throw $failureMessage");
  expect(wrapper).toContain("throw $originalFailure");
  expect(tests).toContain("int length = utf8.GetByteCount(stderr);");
  expect(tests).toContain("length > 1048576");
  expect(tests).toContain("CryptographicOperations.ZeroMemory(plaintext)");
  expect(tests).toContain("rsa.ImportSubjectPublicKeyInfo(der, out consumed)");
  expect(tests).toContain("Directory.Move(pending, ready)");
  // Source-consistency only. Actual Pester and managed SDK controls are Windows CI requirements.
});

it("preserves absent script metadata in the actual optional/inactive Pester wrapper controls", () => {
  const tests = NodeFS.readFileSync(
    new URL("./owned-wsl2-fixture.Tests.ps1", import.meta.url),
    "utf8",
  );
  expect(
    tests.match(
      /\$savedMetadataVariable=Get-Variable -Name OwnedWslSignedMetadata -Scope Script -ErrorAction SilentlyContinue/g,
    ),
  ).toHaveLength(2);
  expect(tests.match(/\$savedMetadataExists=\$null -ne \$savedMetadataVariable/g)).toHaveLength(2);
  expect(
    tests.match(
      /if\(\$savedMetadataExists\)\{\$script:OwnedWslSignedMetadata=\$savedMetadata\}else\{Remove-Variable -Name OwnedWslSignedMetadata -Scope Script -ErrorAction SilentlyContinue\}/g,
    ),
  ).toHaveLength(2);
  expect(tests).not.toContain("$savedMetadata=$script:OwnedWslSignedMetadata");
  expect(tests).toContain("$testsSource.Substring($start,$end-$start)");
  expect(tests).toContain("$script:GpgPrivateEvidenceAttempted|Should -BeFalse");
  // Source consistency only: actual strict-mode Pester setup/extracted-wrapper execution requires Windows CI.
});

it("uses the owning pinned-Git GPG home transform with absolute-path/refusal guards", () => {
  const owner = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
  const start = owner.indexOf("function Get-PinnedGitGpgHomeArgument(");
  const end = owner.indexOf("function Invoke-FixtureCommand(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  const helper = owner.slice(start, end);
  const regex = helper.match(/-cnotmatch '([^']+)'/)?.[1];
  if (!regex) throw new Error("Owned home argument admission unavailable.");
  const admitted = new RegExp(regex.replace(/\\A/g, "^"));
  // Execute the exact source return expression with string-operation ports.
  // Node win32.normalize is supporting validation evidence, not .NET interop.
  const expression = helper.match(/return (.+)/)?.[1];
  if (!expression) throw new Error("Owned home argument transform unavailable.");
  const run = (value: string) => {
    const native = value.replaceAll("/", "\\");
    if (!admitted.test(native) || NodePath.win32.normalize(native) !== native)
      throw new Error("Owned home argument refused.");
    const port = {
      Substring: (start: number, length?: number) => ({
        ToLowerInvariant: () =>
          native.slice(start, length === undefined ? undefined : start + length).toLowerCase(),
        Replace: (from: string, to: string) =>
          native
            .slice(start, length === undefined ? undefined : start + length)
            .replaceAll(from, to),
      }),
    };
    return NodeVM.runInNewContext(
      expression
        .replace(/'([^']*)'/g, (_literal: string, value: string) => JSON.stringify(value))
        .replace(/\$native/g, "native"),
      { native: port },
    );
  };
  for (const [value, expected] of [
    ["C:\\Owned\\gnupg", "/c/Owned/gnupg"],
    ["D:\\Owned Space\\gnupg", "/d/Owned Space/gnupg"],
    ["c:/Owned/gnupg", "/c/Owned/gnupg"],
    ["Z:\\", "/z/"],
  ] as const)
    expect(run(value)).toBe(expected);
  for (const value of [
    "relative\\gnupg",
    "C:relative",
    "\\\\host\\share",
    "\\\\?\\C:\\Owned",
    "/c/Owned",
    "C:\\Owned\\..\\gnupg",
    "C:\\Owned\\.\\gnupg",
    "",
  ])
    expect(() => run(value)).toThrow();
  NodeAssert.equal(regex, "\\A[A-Za-z]:\\\\");
});

it("keeps every pinned public metadata operation agent-free without changing operands or crypto gates", () => {
  for (const file of ["./owned-wsl2-fixture.ps1", "./owned-wsl2-fixture.Tests.ps1"]) {
    const source = NodeFS.readFileSync(new URL(file, import.meta.url), "utf8");
    const calls = source
      .split("\n")
      .filter(
        (line) =>
          line.includes("@('--homedir'") &&
          (line.includes("Invoke-FixtureCommand $gpg ") ||
            line.includes("Invoke-PinnedMetadataCommand ")),
      );
    expect(calls.length).toBe(file.endsWith("Tests.ps1") ? 4 : 3);
    for (const call of calls) {
      const array = call.match(/@\(([^)]+)\)/)?.[1];
      if (!array) throw new Error("Actual public verifier arguments unavailable.");
      const tokens = array.split(",").map((token) => token.trim());
      const args = tokens.map((token) =>
        token.startsWith("'") ? token.slice(1, -1) : "owned:" + token,
      );
      const received: string[] = [];
      const invoke = NodeVM.runInNewContext(
        "(args) => { for (const argument of args) port.Add(argument); }",
        { port: { Add: (argument: string) => received.push(argument) } },
      );
      invoke(args);
      expect(received).toEqual(args);
      expect(received.filter((argument) => argument === "--no-autostart")).toHaveLength(1);
      expect(received).not.toEqual(
        expect.arrayContaining([
          "--trust-model",
          "--skip-verify",
          "--ignore-time-conflict",
          "--ignore-crc-error",
        ]),
      );
      expect(
        received.some((argument) => ["--import", "--fingerprint", "--verify"].includes(argument)),
      ).toBe(true);
    }
  }
  // Source/argument-port evidence only; real Windows crypto remains a mandatory CI counterfactual.
});

// Execute the actual optional callback statements with inert managed SDK ports.
// Managed ErrorRecord admission, projection and PInvoke execution stay Windows CI-only.
function actualPrepareRefusalObserver(script: string, ports: object) {
  const begin = script.indexOf("$prepareRefusalObserver={");
  const end = script.indexOf("}.GetNewClosure()", begin);
  if (begin < 0 || end < begin) throw new Error("Prepare callback source unavailable.");
  const body = script
    .slice(begin + "$prepareRefusalObserver={".length, end)
    .replace(/param\(\$originalErrorRecord\)/, "")
    .replace(/\[OwnedWslPrepareProjection\]::Serialize/g, "projection.Serialize")
    .replace(/\[OwnedGpgEvidenceV1\]::Seal/g, "sdk.Seal")
    .replace(/\[OwnedGpgEvidenceV1\]::Publish/g, "sdk.Publish")
    .replace(/\$true\b/g, "true")
    .replace(/\$null\b/g, "null")
    .replace(/-ne\b/g, "!==")
    .replace(/-eq\b/g, "===")
    .replace(/-or\b/g, "||")
    .replace(/\$(prepareEvidenceState|originalErrorRecord|payload|parts)\b/g, "$1");
  if (/\$|\[Owned|::|\bparam\(/.test(body)) throw new Error("Unexecuted callback expression.");
  const callback = NodeVM.runInNewContext(
    "(function(originalErrorRecord){let payload,parts;" + body + "})",
    ports,
  );
  if (typeof callback !== "function") throw new Error("Prepare callback refused.");
  return callback;
}

function actualPrepareRefusalCatch(owner: string, ports: object) {
  const begin = owner.indexOf("if($MyInvocation.InvocationName -ne '.') {");
  if (begin < 0) throw new Error("Actual owner catch unavailable.");
  const body = owner
    .slice(begin)
    .replace("if($MyInvocation.InvocationName -ne '.')", "if(invocation !== '.')")
    .replace("Invoke-OwnedFixtureAction $Action", "invoke(Action)")
    .replace(/Write-Output ('[^\n]+?')/g, "write($1)")
    .replace(/exit ([01])/g, "return finish($1)")
    .replace("$originalFailure=$_", "originalFailure=caught")
    .replace("} catch {\n    originalFailure", "} catch(caught) {\n    originalFailure")
    .replace(
      "& $PrepareRefusalObserver $originalFailure *> $null",
      "PrepareRefusalObserver(originalFailure)",
    )
    .replace(
      "[ordered]@{completed=$false;prepareStage=$script:OwnedWslPrepareStage}",
      "{completed:false,prepareStage:stage}",
    )
    .replace("[ordered]@{}", "{}")
    .replace(
      "foreach($name in $script:OwnedWslSignedMetadata.Keys)",
      "for(const name of Object.keys(metadata))",
    )
    .replace(
      "$receipt|ConvertTo-Json -Depth 4 -Compress|Write-Output",
      "write(JSON.stringify(receipt))",
    )
    .replace(/\[int\]/g, "")
    .replace(/\$script:OwnedWslPrepareStage/g, "stage")
    .replace(/\$script:OwnedWslSignedMetadata/g, "metadata")
    .replace(/\$true\b/g, "true")
    .replace(/\$false\b/g, "false")
    .replace(/\$null\b/g, "null")
    .replace(/-ceq\b|-eq\b/g, "===")
    .replace(/-ne\b/g, "!==")
    .replace(/-and\b/g, "&&")
    .replace(/-ge\b/g, ">=")
    .replace(/-le\b/g, "<=")
    .replace(/\$(Action|originalFailure|PrepareRefusalObserver|receipt|code|name)\b/g, "$1");
  if (/\$|::|\[ordered\]|\bWrite-Output|\bConvertTo-Json/.test(body))
    throw new Error("Actual catch expression unexecuted.");
  const run = NodeVM.runInNewContext(
    "(function(){let originalFailure,receipt,code;" + body + "})",
    ports,
  );
  if (typeof run !== "function") throw new Error("Actual catch refused.");
  return run;
}
it.each(["success", "projection", "seal", "publication"])(
  "actual Prepare optional callback keeps original identity and closed receipt through %s",
  (fault) => {
    const steps = workflow.jobs.windows_wsl_upgrade_smoke.steps;
    const source = steps.find((step: { id?: string }) => step.id === "native_wsl").run;
    const original = new Error("inert original refusal");
    const events: string[] = [];
    const state = {
      active: true,
      attempted: false,
      public: "inert-public",
      fingerprint: "a".repeat(64),
      context: new Uint8Array([1]),
      root: "inert-owned-root",
    };
    const callback = actualPrepareRefusalObserver(source, {
      prepareEvidenceState: state,
      projection: {
        Serialize: (record: unknown) => {
          NodeAssert.equal(record, original);
          events.push("projection");
          if (fault === "projection") throw undefined;
          return JSON.stringify({ payloadVersion: 1 });
        },
      },
      sdk: {
        Seal: (_public: string, _fingerprint: string, payload: string, context: Uint8Array) => {
          NodeAssert.equal(JSON.parse(payload).payloadVersion, 1);
          NodeAssert.equal(context, state.context);
          events.push("seal");
          if (fault === "seal") throw new Error("inert seal refusal");
          return [
            context,
            new Uint8Array([2]),
            new Uint8Array(384),
            new Uint8Array(12),
            new Uint8Array(16),
          ];
        },
        Publish: (_root: string, parts: Uint8Array[]) => {
          NodeAssert.equal(parts.length, 5);
          events.push("publication");
          if (fault === "publication") throw new Error("inert publication refusal");
        },
      },
    });
    // Source catch owns this same record; callback errors are fully optional.
    const output: string[] = [];
    let exitCode = -1;
    const owner = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
    const run = actualPrepareRefusalCatch(owner, {
      invocation: "file",
      Action: "Prepare",
      stage: "intent-write",
      metadata: {},
      PrepareRefusalObserver: callback,
      invoke: () => {
        throw original;
      },
      write: (value: string) => output.push(value),
      finish: (code: number) => {
        exitCode = code;
      },
    });
    run();
    callback(original);
    NodeAssert.equal(exitCode, 1);
    NodeAssert.equal(output.length, 1);
    NodeAssert.equal(state.attempted, true);
    NodeAssert.equal(events.filter((event) => event === "projection").length, 1);
    const retained = JSON.parse(output[0] ?? "null");
    NodeAssert.deepEqual(retained, { completed: false, prepareStage: "intent-write" });
    NodeAssert.equal(original.message, "inert original refusal");
    state.active = false;
    callback(original);
    NodeAssert.equal(events.filter((event) => event === "projection").length, 1);
  },
);
it("omits inactive callback despite operational-looking public environment", () => {
  const source = workflow.jobs.windows_wsl_upgrade_smoke.steps.find(
    (step: { id?: string }) => step.id === "native_wsl",
  ).run;
  let reads = 0;
  const callback = actualPrepareRefusalObserver(source, {
    prepareEvidenceState: { active: false, attempted: false },
    projection: {
      Serialize: () => {
        reads++;
        throw new Error("must remain inactive");
      },
    },
    sdk: {},
  });
  callback(undefined);
  expect(reads).toBe(0);
});
it("attributes named intent statements separately without extra filesystem reads", () => {
  const owner = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
  const statements = [
    "[IO.Directory]::CreateDirectory($import)|Out-Null",
    "Set-OwnerAcl $import",
    "root=Get-PhysicalPin $root",
    "importRoot=Get-PhysicalPin $import",
    "wsl=Get-TrustedWslLauncher $wsl",
    "$hash=(Get-FileHash -LiteralPath $Path",
    "imagePin=Get-PhysicalPin $image",
    "checkout=Get-PhysicalPin $env:GITHUB_WORKSPACE",
    "$m.manifestPin=Get-PhysicalPin $OwnerManifest",
    "$json=$Manifest|ConvertTo-Json",
    "[IO.File]::WriteAllText($OwnerManifest,$json)",
    "Set-OwnerAcl $OwnerManifest",
    "$acl = Get-Acl -LiteralPath $Path",
    "$acl.SetOwner($me)",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$acl.RemoveAccessRuleAll($rule)",
    "$acl.AddAccessRule(",
    "Set-Acl -LiteralPath $Path -AclObject $acl",
  ];
  const lines = owner.split("\n");
  const observed = statements.map((statement) =>
    lines.findIndex((line) => line.includes(statement)),
  );
  expect(observed.every((line) => line >= 0)).toBe(true);
  expect(new Set(observed).size).toBe(statements.length);
  const intent = owner.slice(
    owner.indexOf("$script:OwnedWslPrepareStage='intent-write'"),
    owner.indexOf("$script:OwnedWslPrepareStage='owned-import'"),
  );
  expect(intent.match(/Save-FixtureManifest \$m/g)).toHaveLength(2);
  const native = owner.slice(
    owner.indexOf("public static string Read("),
    owner.indexOf("public sealed class OwnedWslPrepareFailure"),
  );
  expect(native.match(/GetLastWin32Error\(\)/g)).toHaveLength(2);
  expect(native).toContain("role==PinRole.OwnedObject&&!directory&&i.Links!=1");
  expect(native).not.toMatch(/GetFileAttributes|GetFinalPathName|GetVolume/);
});

it("executes source native role predicates while keeping owned-file single-link admission", () => {
  const source = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
  const conditions = [
    ...source.matchAll(
      /if\((role==PinRole\.[^\n]+)\)throw OwnedWslPrepareFailure.Native\("SingleLinkPolicy"/g,
    ),
  ].map((match) => {
    const condition = match[1];
    if (condition === undefined) throw new Error("Native role predicate capture missing.");
    return condition;
  });
  expect(conditions).toHaveLength(2);
  const refuse = (
    role: "OwnedObject" | "SystemLauncher",
    directory: boolean,
    links: number,
    attributes: number,
  ) =>
    conditions.some((condition) =>
      NodeVM.runInNewContext(
        condition
          .replace(/PinRole\.(OwnedObject|SystemLauncher)/g, '"$1"')
          .replace(/0x10u/g, "0x10"),
        { role, directory, i: { Links: links, Attributes: attributes } },
      ),
    );
  expect(refuse("OwnedObject", false, 1, 0)).toBe(false);
  expect(refuse("OwnedObject", false, 2, 0)).toBe(true);
  expect(refuse("OwnedObject", false, 0, 0)).toBe(true);
  expect(refuse("OwnedObject", true, 2, 16)).toBe(false);
  expect(refuse("SystemLauncher", false, 2, 0)).toBe(false);
  expect(refuse("SystemLauncher", false, 0, 0)).toBe(true);
  expect(refuse("SystemLauncher", false, 2, 16)).toBe(true);
  // Predicate compatibility only: no PowerShell/.NET/native filesystem execution.
});
it("keeps system launcher routing fixed and separate from generic owned pin consumers", () => {
  const source = NodeFS.readFileSync(new URL("./owned-wsl2-fixture.ps1", import.meta.url), "utf8");
  const prepare = source.slice(
    source.indexOf("function Prepare-Fixture {"),
    source.indexOf("function Invoke-OwnedFixtureAction("),
  );
  expect(prepare).toContain(
    "$wsl=Get-WslSystemLauncherPath;$certificate=Get-AuthenticodeSignature -LiteralPath $wsl",
  );
  expect(prepare).not.toContain("$env:SystemRoot");
  expect(prepare).toContain("wsl=Get-TrustedWslLauncher $wsl");
  for (const path of ["$root", "$import", "$image", "$env:GITHUB_WORKSPACE"])
    expect(prepare).toContain("Get-PhysicalPin " + path);
  const reader = source.slice(
    source.indexOf("function Read-FixtureManifest {"),
    source.indexOf("function Assert-OwnedRegistration("),
  );
  expect(reader).toContain("Assert-TrustedWslLauncher $m.wsl");
  expect(reader).not.toContain("Assert-PhysicalPin $m.wsl.pin");
  const trusted = source.slice(
    source.indexOf("function Get-TrustedWslLauncher("),
    source.indexOf("function Set-OwnerAcl("),
  );
  expect(trusted).toContain("$Path -ine (Get-WslSystemLauncherPath)");
  expect(trusted).toContain("Get-PhysicalPinForRole $Path 'system-launcher'");
  expect(trusted).toContain("Get-AuthenticodeSignature -LiteralPath $Path");
  expect(trusted).toContain("$certificate.Status -ne 'Valid'");
  expect(trusted).toContain("Subject -notmatch 'Microsoft'");
  expect(trusted).toContain("$now.pin.identity -cne $Launcher.pin.identity");
  expect(trusted).toContain("$now.pin.directory -ne $Launcher.pin.directory");
  expect(trusted).toContain("$now.sha256 -cne $Launcher.sha256");
  expect(source).toContain("ReadIdentity(path,directory,PinRole.OwnedObject)");
  expect(source).toContain("ReadIdentity(path,false,PinRole.SystemLauncher)");
  expect(source).toContain("Environment.GetFolderPath(Environment.SpecialFolder.System)");
  // Static compatibility; actual complete Prepare/manifest/lifecycle tests are Pester CI-only.
});

it("binds CI manifest fixture inputs and restores SystemRoot before real trust admission", () => {
  const tests = NodeFS.readFileSync(
    new URL("./owned-wsl2-fixture.Tests.ps1", import.meta.url),
    "utf8",
  );
  const group = tests.slice(
    tests.indexOf("Describe 'Actual manifest reader and lifecycle trusted launcher consumer"),
  );
  const binding = group.indexOf(
    "$script:OwnerManifest=Join-Path $TestDrive 'inert-owner.secret.json'",
  );
  const source = group.indexOf("$script:SourceSha='a'*40");
  const manifest = group.indexOf("$script:launcherManifest=@");
  expect(binding).toBeGreaterThan(0);
  expect(source).toBeGreaterThan(binding);
  expect(manifest).toBeGreaterThan(source);
  const start = tests.indexOf(
    "It 'uses the actual managed system launcher even when SystemRoot points elsewhere'",
  );
  const end = tests.indexOf("It 'refuses a saved alternate path", start);
  const altered = tests.slice(start, end);
  const nativeRead = altered.indexOf("[OwnedWslPhysical]::ReadSystemLauncher($actual)");
  const restore = altered.indexOf("finally {$env:SystemRoot=$saved}");
  const trust = altered.indexOf("$launcher=Get-TrustedWslLauncher $actual");
  expect(nativeRead).toBeGreaterThan(0);
  expect(restore).toBeGreaterThan(nativeRead);
  expect(trust).toBeGreaterThan(restore);
  expect(altered).toContain("Assert-TrustedWslLauncher $launcher");
  expect(altered).not.toContain("Mock Get-AuthenticodeSignature");
  // Static fixture compatibility only; actual Pester and WinTrust behavior are CI-only.
});
