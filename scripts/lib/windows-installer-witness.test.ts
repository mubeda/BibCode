// @effect-diagnostics nodeBuiltinImport:off - These tests inspect the QA observer without launching it.
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { seededUpgradePhaseTimeoutMs } from "../seeded-desktop-upgrade-smoke.ts";

import {
  decodeWindowsInstallerWitness,
  createWindowsWitnessProcessPort,
  runWithWindowsInstallerWitness,
  type WindowsInstallerWitnessPort,
  type WindowsWitnessChild,
} from "./windows-installer-witness.ts";

const fact = (kind: string, elapsedMs: number, override: Record<string, unknown> = {}) => ({
  kind,
  elapsedMs,
  parentMatched: null,
  locationMatched: null,
  hashMatched: null,
  exitCode: null,
  droppedCount: 0,
  ...override,
});
const output = (...facts: ReadonlyArray<unknown>) =>
  facts.map((entry) => JSON.stringify(entry)).join("\n");

// oxlint-disable-next-line bibcode/no-global-process-runtime -- The pure AST fixture samples its native parser host once; it never launches the observer.
const isNativeWindowsParserHost = process.platform === "win32";

describe("bounded Windows installer witness", () => {
  it.each([null, false, true] as const)(
    "preserves parent attribution %s through both retained installer events",
    (parentMatched) => {
      const decoded = decodeWindowsInstallerWitness(
        output(
          fact("ready", 0),
          fact("installer-start", 54, { parentMatched }),
          fact("installer-stop", 58, { parentMatched, exitCode: 2 }),
          fact("stopped", 80),
        ),
      );
      expect(decoded.status).toBe("observed");
      expect(decoded.events[1]?.parentMatched).toBe(parentMatched);
      expect(decoded.events[2]?.parentMatched).toBe(parentMatched);
    },
  );

  it.skipIf(!isNativeWindowsParserHost)(
    "parses the actual PowerShell and preserves unknown versus observed parent mismatch without WMI",
    () => {
      const script = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:BIBCODE_TEST_WITNESS_SOURCE, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'witness-parse-failed' }
$definitions = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -in @('Get-InstallerParentMatch', 'Write-Fact')
}, $true))
if ($definitions.Count -ne 2) { throw 'witness-pure-functions-unavailable' }
foreach ($definition in $definitions) {
  $commands = @($definition.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
  }, $true))
  if (@($commands | Where-Object { $_.GetCommandName() -notin @('ConvertTo-Json', 'Write-Output') }).Count -ne 0) {
    throw 'witness-pure-function-not-inert'
  }
  . ([ScriptBlock]::Create($definition.Extent.Text))
}
$cache = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
  $node.Left.Extent.Text -eq '$installers[$key]'
}, $true))
$starts = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.CommandAst] -and
  $node.GetCommandName() -eq 'Write-Fact' -and $node.CommandElements[1].Extent.Text -eq "'installer-start'"
}, $true))
$stops = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.CommandAst] -and
  $node.GetCommandName() -eq 'Write-Fact' -and $node.CommandElements[1].Extent.Text -eq "'installer-stop'"
}, $true))
if ($cache.Count -ne 1 -or $starts.Count -ne 1 -or $stops.Count -ne 1) { throw 'witness-serialization-unavailable' }
$origin = [DateTime]'2026-01-01T00:00:00Z'
$eventTime = $origin.AddSeconds(10)
$expectedStates = @('unknown', 'known-match', 'known-mismatch')
foreach ($state in $expectedStates) {
  $apps = @{}
  $expected = $null
  if ($state -eq 'known-match') {
    $apps['parent'] = @{ created = $origin; stopped = $null }
    $expected = $true
  } elseif ($state -eq 'known-mismatch') {
    $apps['parent'] = @{ created = $origin; stopped = $origin.AddSeconds(5) }
    $expected = $false
  }
  $parentMatched = Get-InstallerParentMatch $apps 'parent' $eventTime
  $installers = @{}
  $key = 'installer'
  $at = 54
  $locationMatched = $null
  $hashMatched = $null
  . ([ScriptBlock]::Create($cache[0].Extent.Text))
  $start = (. ([ScriptBlock]::Create($starts[0].Extent.Text))) | ConvertFrom-Json
  $identity = $installers[$key]
  $exitStatus = 2
  $stop = (. ([ScriptBlock]::Create($stops[0].Extent.Text))) | ConvertFrom-Json
  if ($null -eq $expected) {
    if ($null -ne $parentMatched -or $null -ne $start.parentMatched -or $null -ne $stop.parentMatched) {
      throw 'unknown-parent-coerced'
    }
  } elseif ($parentMatched -ne $expected -or $start.parentMatched -ne $expected -or $stop.parentMatched -ne $expected) {
    throw 'known-parent-classification-changed'
  }
}
[ordered]@{ parsed = $true; triStateCases = 3; wmiExecuted = $false } | ConvertTo-Json -Compress
`;
      const result = NodeChildProcess.spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: {
            ...process.env,
            BIBCODE_TEST_WITNESS_SOURCE: NodeURL.fileURLToPath(
              new URL("./windows-installer-witness.ps1", import.meta.url),
            ),
          },
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
          shell: false,
        },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        parsed: true,
        triStateCases: 3,
        wmiExecuted: false,
      });
    },
  );

  it("retains a short-lived installer start and unsuccessful exit without exposing its identity", () => {
    expect(
      decodeWindowsInstallerWitness(
        output(
          fact("ready", 0),
          fact("application-start", 20, { locationMatched: true }),
          fact("installer-start", 54, {
            parentMatched: true,
            locationMatched: true,
            hashMatched: true,
          }),
          fact("installer-stop", 58, { exitCode: 2 }),
          fact("stopped", 80),
        ),
      ),
    ).toEqual({
      status: "observed",
      events: [
        fact("ready", 0),
        fact("application-start", 20, { locationMatched: true }),
        fact("installer-start", 54, {
          parentMatched: true,
          locationMatched: true,
          hashMatched: true,
        }),
        fact("installer-stop", 58, { exitCode: 2 }),
        fact("stopped", 80),
      ],
    });
  });

  it("keeps missing installer events unobserved rather than reporting no launch", () => {
    expect(decodeWindowsInstallerWitness(output(fact("ready", 0), fact("stopped", 100)))).toEqual({
      status: "observed",
      events: [fact("ready", 0), fact("stopped", 100)],
    });
    expect(decodeWindowsInstallerWitness("")).toEqual({ status: "unavailable", events: [] });
  });

  it.each([
    { path: "private-path" },
    { processId: 91 },
    { credential: "private-grant" },
    { kind: "unexpected-kind" },
    { exitCode: -1 },
    { elapsedMs: Number.MAX_SAFE_INTEGER },
    { hashMatched: "private-value" },
  ])(
    "rejects an entire stream containing an unknown field or invalid closed value (%j)",
    (override) => {
      expect(
        decodeWindowsInstallerWitness(
          output(fact("ready", 0), fact("installer-start", 50, override)),
        ),
      ).toEqual({ status: "invalid", events: [] });
    },
  );

  it("rejects output beyond either byte or event bounds", () => {
    expect(decodeWindowsInstallerWitness("x".repeat(65_537))).toEqual({
      status: "invalid",
      events: [],
    });
    expect(
      decodeWindowsInstallerWitness(output(...Array.from({ length: 257 }, () => fact("ready", 0)))),
    ).toEqual({ status: "invalid", events: [] });
  });

  it("awaits readiness before dispatch and joins its observer after the handoff finishes", async () => {
    const order: string[] = [];
    let releaseReady: ((ready: boolean) => void) | undefined;
    const ready = new Promise<boolean>((resolve) => {
      releaseReady = resolve;
    });
    const port: WindowsInstallerWitnessPort = {
      ready,
      stop: async () => {
        order.push("joined");
        return { output: output(fact("ready", 0), fact("stopped", 90)), closeVerified: true };
      },
    };
    const pending = runWithWindowsInstallerWitness(
      {
        open: async () => port,
        retain: async (evidence) => {
          order.push(evidence.status);
        },
      },
      async () => {
        order.push("dispatch");
        return 7;
      },
    );
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseReady?.(true);
    await expect(pending).resolves.toBe(7);
    expect(order).toEqual(["dispatch", "joined", "observed"]);
  });

  it("preserves the original profile failure after observer teardown fails", async () => {
    const original = new Error("original-profile-failure");
    const evidence: unknown[] = [];
    await expect(
      runWithWindowsInstallerWitness(
        {
          open: async () => ({
            ready: Promise.resolve(true),
            stop: async () => {
              throw new Error("private-cleanup-error");
            },
          }),
          retain: async (value) => {
            evidence.push(value);
          },
        },
        async () => {
          throw original;
        },
      ),
    ).rejects.toBe(original);
    expect(evidence).toEqual([{ status: "cleanup-failed", events: [], closeVerified: false }]);
  });

  it("refuses completion when the owned observer has not been joined", async () => {
    await expect(
      runWithWindowsInstallerWitness(
        {
          open: async () => ({
            ready: Promise.resolve(true),
            stop: async () => ({ output: "", closeVerified: false }),
          }),
          retain: async () => {},
        },
        async () => 7,
      ),
    ).rejects.toThrow("The Windows QA observer did not stop.");
  });

  it("does not dispatch the driver after unavailable observation fails to stop", async () => {
    let dispatched = false;
    await expect(
      runWithWindowsInstallerWitness(
        {
          open: async () => ({
            ready: Promise.resolve(false),
            stop: async () => ({ output: "", closeVerified: false }),
          }),
          retain: async () => {},
        },
        async () => {
          dispatched = true;
          return 7;
        },
      ),
    ).rejects.toThrow("The Windows QA observer did not stop.");
    expect(dispatched).toBe(false);
  });

  it("reports unavailable observation without changing a successful profile result", async () => {
    const evidence: unknown[] = [];
    await expect(
      runWithWindowsInstallerWitness(
        {
          open: async () => {
            throw new Error("private-startup-error");
          },
          retain: async (value) => {
            evidence.push(value);
          },
        },
        async () => 7,
      ),
    ).resolves.toBe(7);
    expect(evidence).toEqual([{ status: "unavailable", events: [], closeVerified: true }]);
  });

  function childFixture() {
    let pid = 91;
    let exited = false;
    let receiveOutput: ((chunk: string) => void) | undefined;
    let receiveClose: (() => void) | undefined;
    let receiveFailure: (() => void) | undefined;
    let terminations = 0;
    const child: WindowsWitnessChild = {
      pid: () => pid,
      exited: () => exited,
      output: (receive) => {
        receiveOutput = receive;
      },
      closed: (receive) => {
        receiveClose = receive;
      },
      failed: (receive) => {
        receiveFailure = receive;
      },
      terminate: () => {
        terminations++;
        exited = true;
        receiveClose?.();
      },
    };
    return {
      child,
      output: (chunk: string) => receiveOutput?.(chunk),
      close: () => {
        exited = true;
        receiveClose?.();
      },
      fail: () => receiveFailure?.(),
      replaceIdentity: () => {
        pid = 92;
      },
      terminations: () => terminations,
    };
  }

  it("does not interpret a partial stdout chunk as unavailable readiness", async () => {
    const fixture = childFixture();
    const port = createWindowsWitnessProcessPort({
      child: fixture.child,
      requestStop: async () => fixture.close(),
      lifetimeMs: 1000,
    });
    const readyLine = output(fact("ready", 0)) + "\n";
    fixture.output(readyLine.slice(0, 9));
    fixture.output(readyLine.slice(9));
    await expect(port.ready).resolves.toBe(true);
    await expect(port.stop()).resolves.toMatchObject({ closeVerified: true });
    expect(fixture.terminations()).toBe(0);
  });

  it("terminates and joins only the captured observer when cooperative stop expires", async () => {
    vi.useFakeTimers();
    try {
      const fixture = childFixture();
      const port = createWindowsWitnessProcessPort({
        child: fixture.child,
        requestStop: async () => {},
        lifetimeMs: 1000,
        joinTimeoutMs: 5,
      });
      const stopping = port.stop();
      await vi.advanceTimersByTimeAsync(5);
      await expect(stopping).resolves.toMatchObject({ closeVerified: true });
      expect(fixture.terminations()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stop-request port that never settles", async () => {
    vi.useFakeTimers();
    try {
      const fixture = childFixture();
      const port = createWindowsWitnessProcessPort({
        child: fixture.child,
        requestStop: () => new Promise<void>(() => {}),
        lifetimeMs: 1000,
        joinTimeoutMs: 5,
      });
      let joined = false;
      const stopping = port.stop().then((result) => {
        joined = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(16);
      expect(joined).toBe(true);
      await expect(stopping).resolves.toMatchObject({ closeVerified: true });
      expect(fixture.terminations()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never terminates a replacement PID and marks its join unverified", async () => {
    vi.useFakeTimers();
    try {
      const fixture = childFixture();
      const port = createWindowsWitnessProcessPort({
        child: fixture.child,
        requestStop: async () => {},
        lifetimeMs: 1000,
        joinTimeoutMs: 5,
      });
      fixture.replaceIdentity();
      const stopping = port.stop();
      await vi.advanceTimersByTimeAsync(11);
      await expect(stopping).resolves.toMatchObject({ closeVerified: false });
      expect(fixture.terminations()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds raw child output before it can be retained", async () => {
    const fixture = childFixture();
    const port = createWindowsWitnessProcessPort({
      child: fixture.child,
      requestStop: async () => fixture.close(),
      lifetimeMs: 1000,
    });
    fixture.output("private-value".repeat(6000));
    await expect(port.ready).resolves.toBe(false);
    const result = await port.stop();
    expect(result).toEqual({ output: "invalid", closeVerified: true });
    expect(decodeWindowsInstallerWitness(result.output)).toEqual({ status: "invalid", events: [] });
  });

  it.each([
    ["previous-stable", 270_000],
    ["protected-baseline", 270_000],
    ["remote-install", 1_170_000],
  ] as const)(
    "wraps the actual %s lane before dispatch and preserves a failed handoff",
    async (lane, originalPhaseBudget) => {
      const root = await NodeFS.promises.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "inert-witness-lane-"),
      );
      try {
        const updaterRoot = NodePath.join(root, "updater");
        const evidenceDirectory = NodePath.join(root, "evidence");
        await NodeFS.promises.mkdir(updaterRoot);
        const payloadPath = NodePath.join(updaterRoot, "fixture.exe");
        await NodeFS.promises.writeFile(payloadPath, "inert-payload");
        const configRoot = NodePath.join(root, "apps/desktop/src-tauri");
        await NodeFS.promises.mkdir(configRoot, { recursive: true });
        await NodeFS.promises.writeFile(
          NodePath.join(configRoot, "tauri.conf.json"),
          JSON.stringify({ productName: "BiBCode" }),
        );
        const source = await NodeFS.promises.readFile(
          new URL("../seeded-desktop-upgrade-smoke.ts", import.meta.url),
          "utf8",
        );
        const start = source.indexOf("const runUpgradeLane = async");
        const end = source.indexOf("\nconst copyBoundedEvidence", start);
        const order: string[] = [];
        const original = new Error("original-installation-handoff-failure");
        let opened: Record<string, unknown> | undefined;
        const context = NodeVM.createContext({
          NodeFS,
          NodePath,
          NodeCrypto,
          seededUpgradePhaseTimeoutMs,
          runWithWindowsInstallerWitness,
          findExactlyOne: async (directory: string) => {
            expect(directory).toBe(updaterRoot);
            return payloadPath;
          },
          openWindowsInstallerWitness: async (input: Record<string, unknown>) => {
            opened = input;
            order.push("observer-open");
            return {
              ready: Promise.resolve(true),
              stop: async () => {
                order.push("observer-joined");
                return {
                  output: output(fact("ready", 0), fact("stopped", 90)),
                  closeVerified: true,
                };
              },
            };
          },
          runWebDriverPhase: async (input: { readonly phase: string }) => {
            expect(input.phase).toBe("seed-and-install");
            order.push("driver-dispatch");
          },
          waitForWindowsInstalledCandidate: async (input: { readonly timeoutMs: number }) => {
            expect(input.timeoutMs).toBe(180_000);
            order.push("handoff-wait");
            throw original;
          },
          writePrivateJson: async (path: string, value: unknown) => {
            order.push("witness-retained");
            await NodeFS.promises.writeFile(path, JSON.stringify(value), { mode: 0o600 });
          },
          laneInput: {
            appBinaryPath: "C:\\isolated\\installed\\bibcode-desktop.exe",
            backendPort: 43001,
            candidateVersion: "0.7.3-upgrade.46",
            windowsCandidateRoot: updaterRoot,
            layout: {
              dataRoot: NodePath.join(root, "data"),
              evidenceDirectory,
              workspaceRoot: NodePath.join(root, "workspace"),
            },
            lane,
            platform: "win",
            projectId: "inert-project",
            repositoryRoot: root,
            restartTimeoutMs: 180_000,
            webdriverPort: 43101,
            wsl: false,
          },
        });
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const pending = NodeVM.runInContext(
          NodeModule.stripTypeScriptTypes(
            `(async () => { ${source.slice(start, end)}; return runUpgradeLane(laneInput); })()`,
          ),
          context,
          { timeout: 1000 },
        ) as Promise<void>;
        await expect(pending).rejects.toBe(original);
        expect(order).toEqual([
          "observer-open",
          "driver-dispatch",
          "handoff-wait",
          "observer-joined",
          "witness-retained",
        ]);
        expect(opened).toMatchObject({
          candidateSha256: "46c85eb593e8f6e7067e11beae048cd04868fdf176912cfbd027036b5e0c179d",
          productName: "BiBCode",
          lifetimeMs: originalPhaseBudget + 180_000 + 10_000,
        });
        const retained = JSON.parse(
          await NodeFS.promises.readFile(
            NodePath.join(evidenceDirectory, "windows-installer-events.json"),
            "utf8",
          ),
        );
        expect(retained).toEqual({
          status: "observed",
          events: [fact("ready", 0), fact("stopped", 90)],
          closeVerified: true,
        });
      } finally {
        await NodeFS.promises.rm(root, { recursive: true, force: true });
      }
    },
  );
});
