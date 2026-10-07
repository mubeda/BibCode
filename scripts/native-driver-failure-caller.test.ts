// @effect-diagnostics nodeBuiltinImport:off - Inert complete caller tests own TempFS and execute checked-in generated bodies.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import {
  createSeededUpgradeDriverSpec,
  assertWebDriverPhaseExit,
  SeededUpgradeCommandTimeoutError,
} from "./seeded-desktop-upgrade-smoke.ts";
import { nativeFollowupWorkflowStatus } from "./qualify-native-followups-workflow.ts";
import {
  projectNativeDriverHandoff,
  projectNativeDriverEvidence,
  readOwnedNativeDriverResult,
} from "./lib/native-driver-evidence.ts";

it("retains the generated native driver's closed failure handoff without replacing the inner error", async () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-handoff-")),
  );
  const resultPath = NodePath.join(root, "before.json");
  const original = Object.freeze(new Error("inert original refusal"));
  const observation = {
    appVersion: "0.8.1",
    effectiveRoot: root,
    projectId: "owned",
    projectIds: ["owned"],
    storageInstanceId: "inert",
    preUpdateBackups: [],
  };
  const spec = createSeededUpgradeDriverSpec({
    appBinaryPath: NodePath.join(root, "app"),
    expectedDataRoot: root,
    dataRoot: root,
    workspaceRoot: root,
    candidateVersion: "0.8.2",
    evidenceDirectory: root,
    phase: "seed-and-install",
    lane: "native-followups",
    platform: "linux",
    projectId: "owned",
    resultPath,
    wsl: false,
    repositoryRoot: root,
    nativeFollowupsControllerPath: NodePath.join(root, "controller.ts"),
    sourceSha: "a".repeat(40),
    runRoot: root,
  });
  const start = spec.indexOf("    const observation = await observe(");
  const end = spec.indexOf("\n  });", start);
  expect(start > 0 && end > start).toBe(true);
  const body = spec
    .slice(start, end)
    .replace(/await import\(input\.nativeFollowupsControllerPath\)/g, "await loadController()");
  let sinkReached = false;
  const execute = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes("async function execute(){" + body + "} execute;"),
    {
      NodeFS,
      input: {
        resultPath,
        phase: "seed-and-install",
        platform: "linux",
        sourceSha: "a".repeat(40),
      },
      process: { env: {}, platform: "linux", getuid: () => 1000 },
      browser: {},
      observe: async () => observation,
      loadController: async () => ({
        projectNativeDriverHandoff,
        runSeededNativeFollowups: async (
          _browser: unknown,
          input: { observeNativeDriverEvidence?: (value: unknown) => void },
        ) => {
          sinkReached = typeof input.observeNativeDriverEvidence === "function";
          input.observeNativeDriverEvidence?.({
            schemaVersion: 1,
            selection: "release-visual-native-followups",
            sourceSha: "a".repeat(40),
            partition: "linux-menu-update",
            innerPhase: "native-menu-theme-light",
            innerFailure: {
              status: "unavailable",
              reason: "native-observation-refused",
              originalCount: 0,
            },
            innerResult: null,
          });
          throw original;
        },
      }),
    },
  );
  try {
    await expect(execute()).rejects.toBe(original);
    expect(sinkReached).toBe(true);
    expect(JSON.parse(NodeFS.readFileSync(resultPath, "utf8"))).toHaveProperty(
      "nativeDriverEvidence.innerPhase",
      "native-menu-theme-light",
    );
    expect(NodeFS.readdirSync(root)).toEqual(["before.json"]);
    expect(NodeFS.statSync(resultPath).mode & 0o777).toBe(0o600);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

const sourceSha = "a".repeat(40);
const handoff = () => ({
  schemaVersion: 1,
  selection: "release-visual-native-followups",
  sourceSha,
  partition: "linux-menu-update",
  innerPhase: "native-update-recovery-light",
  innerFailure: { status: "unavailable", reason: "native-observation-refused", originalCount: 2 },
  innerResult: {
    originalCount: 2,
    outstandingRowCount: 4,
    cleanup: "joined",
    partitionComplete: false,
    sourceMatches: true,
  },
});

it.each([
  "missing",
  "partial",
  "extra",
  "wrong-source",
  "wrong-partition",
  "wrong-selection",
  "phase",
  "count",
  "private",
  "symlink",
  "hardlink",
  "outside",
  "alias",
  "oversize",
  "replacement",
])("refuses the existing result's unsafe closed input: %s", (mode) => {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-result-")),
  );
  const runRoot = NodePath.join(base, "run");
  NodeFS.mkdirSync(runRoot, { mode: 0o700 });
  let resultPath = NodePath.join(runRoot, "before.json");
  const value = handoff();
  if (mode === "wrong-source") value.sourceSha = "b".repeat(40);
  if (mode === "wrong-partition") value.partition = "windows-wsl";
  if (mode === "wrong-selection") value.selection = "other";
  if (mode === "phase") value.innerPhase = "private /host/path";
  if (mode === "count") value.innerResult.originalCount = 7;
  const record =
    mode === "extra" || mode === "private"
      ? { ...value, privateError: "inert private value" }
      : value;
  if (mode !== "missing")
    NodeFS.writeFileSync(
      resultPath,
      mode === "partial"
        ? "{"
        : mode === "oversize"
          ? JSON.stringify({ nativeDriverEvidence: value, padding: "x".repeat(1024 * 1024 + 1) })
          : JSON.stringify({ nativeDriverEvidence: record }),
      { mode: 0o600 },
    );
  if (mode === "symlink") {
    NodeFS.renameSync(resultPath, NodePath.join(base, "target"));
    NodeFS.symlinkSync(NodePath.join(base, "target"), resultPath);
  }
  if (mode === "hardlink") NodeFS.linkSync(resultPath, NodePath.join(base, "linked"));
  if (mode === "outside") {
    resultPath = NodePath.join(base, "before.json");
    NodeFS.writeFileSync(resultPath, JSON.stringify({ nativeDriverEvidence: value }), {
      mode: 0o600,
    });
  }
  if (mode === "alias") resultPath = NodePath.join(runRoot, "alias.json");
  try {
    if (mode !== "replacement")
      expect(readOwnedNativeDriverResult({ runRoot, resultPath, sourceSha })).toBeNull();
    else {
      const helper = NodeFS.readFileSync(
        new URL("./lib/native-driver-evidence.ts", import.meta.url),
        "utf8",
      );
      const originalRead = NodeFS.readSync;
      let replaced = false;
      const read = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          helper.replace(/^import .*$/gm, "").replace(/export /g, ""),
        ) + ";readOwnedNativeDriverResult;",
        {
          NodeFS: {
            ...NodeFS,
            readSync: (...args: Parameters<typeof NodeFS.readSync>) => {
              const n = originalRead(...args);
              if (!replaced) {
                replaced = true;
                NodeFS.renameSync(resultPath, NodePath.join(base, "old"));
                NodeFS.writeFileSync(resultPath, JSON.stringify({ nativeDriverEvidence: value }), {
                  mode: 0o600,
                });
              }
              return n;
            },
          },
          NodePath,
          NodeUtil,
          process,
          Buffer,
          Object,
          Reflect,
          Number,
          Error,
        },
      );
      expect(read({ runRoot, resultPath, sourceSha })).toBeNull();
    }
  } finally {
    NodeFS.rmSync(base, { recursive: true, force: true });
  }
});

it("rejects proxies and accessor/private fields without evaluating them", () => {
  let touched = 0;
  const value = handoff();
  const getter = { ...value };
  Object.defineProperty(getter, "innerResult", {
    enumerable: true,
    get: () => {
      touched++;
      throw new Error("inert private getter");
    },
  });
  expect(projectNativeDriverHandoff(getter, sourceSha)).toBeNull();
  expect(
    projectNativeDriverHandoff(
      new Proxy(value, {
        ownKeys: () => {
          touched++;
          throw new Error("inert proxy");
        },
      }),
      sourceSha,
    ),
  ).toBeNull();
  expect(
    projectNativeDriverHandoff(
      { ...value, innerFailure: { ...value.innerFailure, error: "inert private error" } },
      sourceSha,
    ),
  ).toBeNull();
  expect(
    projectNativeDriverEvidence({
      driverOutcome: "nonzero",
      driverExitCode: 7,
      innerPhase: value.innerPhase,
      innerFailure: value.innerFailure,
      innerResult: value.innerResult,
      outerCleanupJoined: false,
    }),
  ).toBeNull();
  expect(touched).toBe(0);
});

it.each([
  "nonzero",
  "zero-later-refusal",
  "timeout",
  "rejected",
  "missing",
  "partial",
  "inner-unsafe",
  "session-unsafe",
  "outer-cleanup-failure",
  "observer-failure",
  "publication-failure",
  "malformed",
])("joins the generated driver, seeded owner and closed failure status: %s", async (mode) => {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-caller-")),
  );
  const runRoot = NodePath.join(base, "run"),
    evidence = NodePath.join(runRoot, "evidence"),
    sessionRoot = NodePath.join(base, "session"),
    artifacts = NodePath.join(base, "artifacts");
  NodeFS.mkdirSync(runRoot, { mode: 0o700 });
  NodeFS.mkdirSync(evidence, { mode: 0o700 });
  NodeFS.mkdirSync(sessionRoot, { mode: 0o700 });
  const events: string[] = [],
    phases: string[] = [],
    rootError = Object.freeze(new Error("inert original joined refusal"));
  const input = {
    appBinaryPath: NodePath.join(base, "app"),
    backendPort: 43124,
    candidateVersion: "0.8.2",
    dataRoot: runRoot,
    expectedDataRoot: runRoot,
    evidenceDirectory: evidence,
    lane: "native-followups",
    phase: "seed-and-install",
    platform: "linux",
    projectId: "owned",
    repositoryRoot: base,
    restartTimeoutMs: 1,
    resultPath: NodePath.join(runRoot, "before.json"),
    runRoot,
    workspaceRoot: runRoot,
    webdriverPort: 43224,
    wsl: false,
    sourceSha,
  } satisfies Parameters<typeof createSeededUpgradeDriverSpec>[0] & {
    readonly backendPort: number;
    readonly restartTimeoutMs: number;
    readonly webdriverPort: number;
  };
  const driver = createSeededUpgradeDriverSpec({
    ...input,
    nativeFollowupsControllerPath: NodePath.join(base, "controller.ts"),
  });
  const driverStart = driver.indexOf("    const observation = await observe("),
    driverEnd = driver.indexOf("\n  });", driverStart);
  expect(driverStart > 0 && driverEnd > driverStart).toBe(true);
  const driverBody = driver
    .slice(driverStart, driverEnd)
    .replace(/await import\(input\.nativeFollowupsControllerPath\)/g, "await loadController()");
  const runGenerated = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes("async function generated(){" + driverBody + "} generated;"),
    {
      NodeFS: {
        ...NodeFS,
        writeFileSync: (
          file: NodeFS.PathOrFileDescriptor,
          data: string,
          options?: NodeFS.WriteFileOptions,
        ) => {
          if (mode === "publication-failure" && NodeFS.existsSync(String(file))) throw rootError;
          NodeFS.writeFileSync(file, data, options);
        },
      },
      process: { env: {}, platform: "linux", getuid: () => 1000 },
      input,
      browser: {},
      observe: async () => ({
        appVersion: "0.8.1",
        effectiveRoot: runRoot,
        projectId: "owned",
        projectIds: ["owned"],
        storageInstanceId: "inert",
        preUpdateBackups: [],
      }),
      loadController: async () => ({
        projectNativeDriverHandoff,
        runSeededNativeFollowups: async (
          _browser: unknown,
          args: { observeNativeDriverEvidence: (value: unknown) => void },
        ) => {
          const value =
            mode === "zero-later-refusal"
              ? {
                  ...handoff(),
                  innerPhase: "native-update-recovery-dark",
                  innerFailure: null,
                  innerResult: {
                    ...handoff().innerResult,
                    originalCount: 6,
                    partitionComplete: true,
                  },
                }
              : handoff();
          if (mode === "inner-unsafe") value.innerResult.cleanup = "unsafe";
          if (mode === "malformed") value.innerPhase = "inert private path";
          args.observeNativeDriverEvidence(value);
          if (mode === "zero-later-refusal") return { originalCount: 6, partitionComplete: true };
          throw rootError;
        },
      }),
    },
  );
  const ownerSource = NodeFS.readFileSync(
    new URL("./seeded-desktop-upgrade-smoke.ts", import.meta.url),
    "utf8",
  );
  const sessionSource = NodeFS.readFileSync(
    new URL(
      "../apps/desktop/e2e/support/release-visual-native-followups-session.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const declaration = sessionSource.indexOf("  let failed = false"),
    declarationEnd = sessionSource.indexOf("  try {", declaration),
    action = sessionSource.indexOf('    observe("native-linux-driver");', declaration),
    tail = sessionSource.indexOf("  } catch (error)", action);
  expect(declaration > 0 && declarationEnd > declaration && tail > action).toBe(true);
  const session = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function session(input,run){const root=privateSessionRoot,environment=input.environment,children=[];const observe=(phase)=>{try{input.onStage?.(phase)}catch{}};" +
        sessionSource.slice(declaration, declarationEnd) +
        "try{" +
        sessionSource.slice(action, tail) +
        sessionSource.slice(tail) +
        ";session;",
    ),
    {
      NodeFS: {
        ...NodeFS,
        writeFileSync: (file: string, data: string, options: NodeFS.WriteFileOptions) => {
          events.push("session-cleanup");
          if (mode === "session-unsafe") throw rootError;
          NodeFS.writeFileSync(file, data, options);
        },
      },
      NodePath,
      privateSessionRoot: sessionRoot,
      Error,
      Object,
    },
  );
  const start = ownerSource.indexOf("const runWebDriverPhase = async"),
    end = ownerSource.indexOf("const startMockUpdateServer", start);
  let body = ownerSource.slice(start, end);
  const importEnd = body.indexOf(").withNativeFollowupsLinuxSession"),
    importStart = body.lastIndexOf("await import(", importEnd);
  expect(importStart > 0 && importEnd > importStart).toBe(true);
  body = body.slice(0, importStart) + "await loadSession()\n" + body.slice(importEnd);
  const runPhase = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(body) + ";runWebDriverPhase;",
    {
      NodeFS,
      NodePath,
      NodeURL,
      process: { env: {} },
      seededUpgradeNativeHostPlatform: "linux",
      seededUpgradeVitePlusExecutable: "inert-vp",
      createSeededUpgradeDriverSpec: () => "inert spec",
      createSeededUpgradeWdioConfig: () => "inert config",
      SeededUpgradeCommandTimeoutError,
      readOwnedNativeDriverResult: (value: Parameters<typeof readOwnedNativeDriverResult>[0]) => {
        events.push("result-read");
        return readOwnedNativeDriverResult(value);
      },
      loadSession: async () => ({ withNativeFollowupsLinuxSession: session }),
      runCommand: async () => {
        events.push("generated-driver");
        if (mode !== "missing")
          await runGenerated().catch((error: unknown) => {
            expect(error).toBe(rootError);
          });
        if (mode === "partial") NodeFS.writeFileSync(input.resultPath, "{", { mode: 0o600 });
        if (mode === "timeout") throw new SeededUpgradeCommandTimeoutError("inert owned timeout");
        if (mode === "rejected") throw rootError;
        return { exitCode: mode === "zero-later-refusal" ? 0 : 7, stdout: "", stderr: "" };
      },
      redactAndBoundUpgradeEvidence: () => "inert bounded log",
      assertWebDriverPhaseExit,
    },
  );
  const finallyStart = ownerSource.indexOf("    const secrets = [signingKey, signingPassword];"),
    finallyEnd = ownerSource.indexOf("\n  }\n  if (failed || failure !== undefined)", finallyStart);
  expect(finallyStart > 0 && finallyEnd > finallyStart).toBe(true);
  let finalBody = ownerSource
    .slice(finallyStart, finallyEnd)
    .replace(
      /await import\(\s*NodeURL\.pathToFileURL\([\s\S]*?\)\.href\s*\)/g,
      "await loadRetainer()",
    );
  const runOwner = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function owner(input){let failed=false,failure,nativeDriverEvidence={value:null},outerCleanupJoined=false,remotePhaseStarted=false;try{await runPhase({...phaseInput,observeNativePhase,observeNativeDriverEvidence:(value)=>{nativeDriverEvidence.value=value;}})}catch(error){failed=true;failure=error;}finally{" +
        finalBody +
        "}if(failed||failure!==undefined)throw failure;} owner;",
    ),
    {
      NodeFS,
      NodePath,
      NodeURL,
      process: { env: {} },
      signingKey: "",
      signingPassword: "",
      layout: {
        remoteInstall: { dataRoot: NodePath.join(base, "remote", "data") },
        nativeFollowups: { evidenceDirectory: evidence },
      },
      phaseInput: input,
      runPhase,
      observeNativePhase: (phase: string) => phases.push(phase),
      readObservation: async () => ({ installAttempted: false }),
      readRemoteFixtureSecrets: async () => [],
      cleanup: {
        cleanup: async () => {
          events.push("outer-cleanup");
          if (mode === "outer-cleanup-failure") throw rootError;
        },
      },
      loadRetainer: async () => ({
        retainNativeFollowupEvidence: () => {
          throw rootError;
        },
      }),
      seededUpgradeNativeHostPlatform: "linux",
      SeededDesktopUpgradeSmokeError: Error,
    },
  );
  let retained: unknown = null,
    caught: unknown;
  try {
    await runOwner({
      nativeFollowups: true,
      platform: "linux",
      artifactDirectory: artifacts,
      observeNativeFollowupDriverEvidence: (value: unknown) => {
        retained = value;
        if (mode === "observer-failure") throw rootError;
      },
    }).catch((error: unknown) => {
      caught = error;
    });
    expect(caught).not.toBeUndefined();
    const workflow = NodeFS.readFileSync(
      new URL("./qualify-native-followups-workflow.ts", import.meta.url),
      "utf8",
    );
    const privateStart = workflow.indexOf("function privateWrite("),
      mainStart = workflow.indexOf("async function main()", privateStart);
    const finallyStart = workflow.lastIndexOf("  } finally {"),
      finallyEnd = workflow.indexOf("\n  }\n}\nif", finallyStart);
    expect(privateStart > 0 && mainStart > privateStart && finallyEnd > finallyStart).toBe(true);
    const publish = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        workflow.slice(privateStart, mainStart) +
          "async function publish(){" +
          workflow.slice(finallyStart + "  } finally {".length, finallyEnd) +
          "} publish;",
      ),
      {
        NodeFS: {
          ...NodeFS,
          writeFileSync: (file: string, value: string, options: NodeFS.WriteFileOptions) => {
            events.push("status-write");
            NodeFS.writeFileSync(file, value, options);
          },
        },
        NodePath,
        owningHostProcessPlatform: "linux",
        input: { artifactDirectory: artifacts },
        status: "failed",
        count: 0,
        observation: {
          phase: phases.at(-1),
          linuxServiceAdmission: null,
          nativeDriverEvidence: retained,
        },
        sourceSha,
        plan: { partition: "linux-menu-update" },
        nativeFollowupWorkflowStatus,
      },
    );
    await publish();
    const status = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(artifacts, "native-followups-workflow-status.json"),
        "utf8",
      ),
    );
    expect(status).toMatchObject({
      status: "failed",
      originalCount: 0,
      completeGroup: false,
      visualReview: "pending",
    });
    expect(status).toHaveProperty(
      "nativeDriverEvidence.driverOutcome",
      mode === "timeout"
        ? "timeout"
        : mode === "rejected"
          ? "rejected"
          : mode === "zero-later-refusal"
            ? "zero"
            : "nonzero",
    );
    expect(status).toHaveProperty(
      "nativeDriverEvidence.driverExitCode",
      mode === "timeout" || mode === "rejected" ? null : mode === "zero-later-refusal" ? 0 : 7,
    );
    expect(status).toHaveProperty(
      "nativeDriverEvidence.outerCleanupJoined",
      mode !== "outer-cleanup-failure",
    );
    const innerMissing = [
      "missing",
      "partial",
      "session-unsafe",
      "outer-cleanup-failure",
      "publication-failure",
      "malformed",
    ].includes(mode);
    expect(status).toHaveProperty(
      "nativeDriverEvidence.innerPhase",
      innerMissing
        ? null
        : mode === "zero-later-refusal"
          ? "native-update-recovery-dark"
          : "native-update-recovery-light",
    );
    if (mode === "inner-unsafe")
      expect(status).toHaveProperty("nativeDriverEvidence.innerResult.cleanup", "unsafe");
    expect(events.indexOf("session-cleanup")).toBeLessThan(events.indexOf("result-read"));
    expect(events.filter((value) => value === "result-read")).toHaveLength(1);
    expect(events.indexOf("outer-cleanup")).toBeLessThan(events.indexOf("status-write"));
    expect(NodeFS.readdirSync(artifacts)).toEqual(["native-followups-workflow-status.json"]);
    expect(JSON.stringify(status)).not.toContain("inert private");
  } finally {
    NodeFS.rmSync(base, { recursive: true, force: true });
  }
});

it.each(["success", "inner-error", "inner-undefined"])(
  "preserves controller and publication error priority in the actual generated driver: %s",
  async (mode) => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-publication-")),
    );
    const resultPath = NodePath.join(root, "before.json");
    const innerError = Object.freeze(new Error("inert controller error"));
    const writeError = Object.freeze(new Error("inert publication error"));
    const input = {
      candidateVersion: "0.8.2",
      expectedDataRoot: root,
      dataRoot: root,
      workspaceRoot: root,
      lane: "native-followups",
      phase: "seed-and-install",
      platform: "linux",
      projectId: "owned",
      resultPath,
      wsl: false,
      repositoryRoot: root,
      runRoot: root,
      evidenceDirectory: root,
      appBinaryPath: NodePath.join(root, "app"),
      nativeFollowupsControllerPath: NodePath.join(root, "controller.ts"),
      sourceSha,
    } satisfies Parameters<typeof createSeededUpgradeDriverSpec>[0];
    const spec = createSeededUpgradeDriverSpec(input);
    const start = spec.indexOf("    const observation = await observe("),
      end = spec.indexOf("\n  });", start);
    expect(start > 0 && end > start).toBe(true);
    const body = spec
      .slice(start, end)
      .replace(/await import\(input\.nativeFollowupsControllerPath\)/g, "await loadController()");
    let writes = 0;
    const execute = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes("async function execute(){" + body + "} execute;"),
      {
        NodeFS: {
          ...NodeFS,
          writeFileSync: (
            file: NodeFS.PathOrFileDescriptor,
            value: string,
            options?: NodeFS.WriteFileOptions,
          ) => {
            writes++;
            if (writes === 2) throw writeError;
            NodeFS.writeFileSync(file, value, options);
          },
        },
        input,
        process: { env: {}, platform: "linux", getuid: () => 1000 },
        browser: {},
        observe: async () => ({
          appVersion: "0.8.1",
          effectiveRoot: root,
          projectId: "owned",
          projectIds: ["owned"],
          storageInstanceId: "inert",
          preUpdateBackups: [],
        }),
        loadController: async () => ({
          projectNativeDriverHandoff,
          runSeededNativeFollowups: async () => {
            if (mode === "inner-error") throw innerError;
            if (mode === "inner-undefined") throw undefined;
            return { originalCount: 6, partitionComplete: true };
          },
        }),
      },
    );
    try {
      await expect(execute()).rejects.toBe(
        mode === "success" ? writeError : mode === "inner-error" ? innerError : undefined,
      );
      expect(writes).toBe(2);
      expect(NodeFS.readdirSync(root)).toEqual(["before.json"]);
      expect(NodeFS.statSync(resultPath).mode & 0o777).toBe(0o600);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
