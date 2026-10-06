// @effect-diagnostics nodeBuiltinImport:off - Real Git operates only inside a disposable temp fixture, never the checkout.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeZlib from "node:zlib";
import * as NodeVM from "node:vm";
import { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
import { bindOwnedBrowserAlertObservation } from "./owned-browser-alert.ts";
import { pullRequestsCaptureBindings } from "./release-visual-pull-requests.ts";
import { expect, it } from "vite-plus/test";
import { observePrViewportNumbers, observePrOuterNumbers } from "./delivery-browser-observation.ts";
import { preparePullRequestsHostingFixture } from "./release-visual-pull-requests-installer.ts";
import {
  createPullRequestsPhysicalJoins,
  type PullRequestsHostingRestorationProof,
  runOwnedPullRequestsSelection,
  validatePullRequestsCallerJoins,
} from "./release-visual-pull-requests-caller.ts";
it("joins actual private Git refs/origins and sealed fixture bytes, refusing source or filesystem drift", async () => {
  const parent = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-pr-caller-")),
    ),
    root = NodePath.join(parent, "light");
  NodeFS.mkdirSync(root, { mode: 0o700 });
  const empty = NodePath.join(parent, "empty.gitconfig");
  NodeFS.writeFileSync(empty, "", { mode: 0o600 });
  const git = async (cwd: string, args: readonly string[]) => {
    const result = NodeChildProcess.spawnSync(
      "git",
      [
        "-c",
        "user.name=Owned QA",
        "-c",
        "user.email=owned@visual.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty },
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
      },
    );
    return { status: result.status ?? -1, stdout: result.stdout };
  };
  try {
    const fixture = await preparePullRequestsHostingFixture({
      root,
      sourceSha: "a".repeat(40),
      node: NodeFS.realpathSync(process.execPath),
      ci: true,
      git,
    });
    const original = NodePath.join(root, "original");
    NodeFS.mkdirSync(original, { mode: 0o700 });
    await git(original, ["init", "--initial-branch=main"]);
    NodeFS.writeFileSync(NodePath.join(original, "owned.txt"), "Owned original\n");
    await git(original, ["add", "--", "owned.txt"]);
    await git(original, ["commit", "-m", "Owned original"]);
    const joins = await createPullRequestsPhysicalJoins({
      fixture,
      sourceSha: fixture.sourceSha,
      originalCwd: original,
      git,
    });
    for (const provider of ["github", "gitlab"] as const)
      await joins.verifySource(provider, {
        environmentId: "local",
        projectId: "owned",
        threadId: "owned-thread",
        title: provider,
        cwd: fixture.projects[provider].cwd,
        branch: "visual-request",
      });
    await joins.verifyOriginal();
    await expect(
      createPullRequestsPhysicalJoins({
        fixture,
        sourceSha: "b".repeat(40),
        originalCwd: original,
        git,
      }),
    ).rejects.toThrow("Owned request caller refused.");
    await git(original, ["switch", "-c", "foreign"]);
    await expect(joins.verifyOriginal()).rejects.toThrow("Owned request caller refused.");
    await git(original, ["switch", "main"]);
    NodeFS.chmodSync(fixture.engine, 0o600);
    NodeFS.appendFileSync(fixture.engine, "\n// drift");
    NodeFS.chmodSync(fixture.engine, 0o500);
    expect(() => joins.verifySealed()).toThrow("Owned request caller refused.");
  } finally {
    NodeFS.rmSync(parent, { recursive: true, force: true });
  }
});

const Schema = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const publicFixturePath = "../../../web/src/components/pullRequests/testFixtures.ts";
const publicFixtures = await import(publicFixturePath);
function inertOriginal() {
  const chunk = (kind: string, data: Buffer) => {
    const value = Buffer.alloc(data.length + 12);
    value.writeUInt32BE(data.length);
    value.write(kind, 4, "ascii");
    data.copy(value, 8);
    value.writeUInt32BE(NodeZlib.crc32(value.subarray(4, value.length - 4)), value.length - 4);
    return value;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280);
  header.writeUInt32BE(960, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((1280 * 3 + 1) * 960);
  for (let y = 0; y < 960; y++)
    for (let x = 0; x < 1280; x++) {
      const i = y * (1280 * 3 + 1) + 1 + x * 3;
      pixels[i] = x < 640 ? 200 : 20;
      pixels[i + 1] = 40;
      pixels[i + 2] = x < 640 ? 20 : 200;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
it.each([
  "ordinary",
  "immediate-undo",
  "delayed-undo",
  "cancelled-undo",
  "late-undo",
  "capture-failure",
  "foreign-boot",
] as const)(
  "runs the actual composed caller with real private Git and typed public traffic: %s",
  async (mode) => {
    const displayParent = NodeFS.mkdtempSync("/tmp/bc-vr-public-caller-"),
      parent = NodeFS.realpathSync(displayParent),
      root = NodePath.join(parent, "light"),
      evidence = NodePath.join(parent, "evidence"),
      home = NodePath.join(parent, "home");
    for (const directory of [root, evidence, home]) NodeFS.mkdirSync(directory, { mode: 0o700 });
    const empty = NodePath.join(home, "empty.gitconfig");
    NodeFS.writeFileSync(empty, "", { mode: 0o600 });
    const git = async (cwd: string, args: readonly string[]) => {
      const result = NodeChildProcess.spawnSync(
        "git",
        [
          "-c",
          "user.name=Owned QA",
          "-c",
          "user.email=owned@visual.invalid",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        {
          cwd,
          env: {
            ...process.env,
            HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: empty,
            GIT_TERMINAL_PROMPT: "0",
          },
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 65536,
        },
      );
      return { status: result.status ?? -1, stdout: result.stdout };
    };
    try {
      const fixture = await preparePullRequestsHostingFixture({
          root,
          sourceSha: "a".repeat(40),
          node: NodeFS.realpathSync(process.execPath),
          ci: true,
          git,
        }),
        originalCwd = NodePath.join(root, "original");
      NodeFS.mkdirSync(originalCwd, { mode: 0o700 });
      await git(originalCwd, ["init", "--initial-branch=main"]);
      NodeFS.writeFileSync(NodePath.join(originalCwd, "owned.txt"), "Owned original\n");
      await git(originalCwd, ["add", "--", "owned.txt"]);
      await git(originalCwd, ["commit", "-m", "Owned original"]);
      const timestamp = "2026-10-06T00:00:00.000Z",
        projects: unknown[] = [],
        threads: unknown[] = [],
        calls: string[] = [],
        frames: Record<string, unknown>[] = [],
        values = new Map<string, string>(),
        captures: object[] = [],
        assertions: object[] = [],
        events = new Map<string, Set<(event: { data?: unknown }) => void>>();
      let selected = "original",
        unsafe = 0,
        descriptorReads = 0,
        grants = 0,
        restores = 0,
        alertReads = 0;
      const originalError = new Error("Inert original capture failure."),
        image = inertOriginal();
      const socket = {
        readyState: 1,
        addEventListener: (name: string, callback: (event: { data?: unknown }) => void) => {
          const group = events.get(name) ?? new Set();
          group.add(callback);
          events.set(name, group);
        },
        removeEventListener: (name: string, callback: (event: { data?: unknown }) => void) =>
          events.get(name)?.delete(callback),
        send: (text: string) => {
          const frame = JSON.parse(text);
          frames.push(frame);
          if (frame._tag === "Pong") return;
          const provider = NodePath.basename(frame.payload.cwd);
          const context = {
            ...publicFixtures.context,
            provider,
            host: provider + ".visual.invalid",
            repository: "owned/requests",
            webUrl: "https://" + provider + ".visual.invalid/owned/requests",
            account: { ...publicFixtures.context.account, login: "viewer" },
          };
          queueMicrotask(() => {
            for (const callback of events.get("message") ?? [])
              callback({
                data: JSON.stringify({
                  _tag: "Exit",
                  requestId: frame.id,
                  exit: { _tag: "Success", value: context },
                }),
              });
          });
        },
        close: () => {
          calls.push("api-close");
          socket.readyState = 3;
          for (const callback of events.get("close") ?? []) callback({});
        },
      };
      const rawHosting = JSON.parse(NodeFS.readFileSync(fixture.config, "utf8"));
      const labelEntry = (direction: string): string[] => {
        const entry = rawHosting.exchanges.github.find(
          (value: { kind: string; argv: string[] }) =>
            value.kind === "labels" && value.argv.includes(direction),
        );
        if (!entry) throw new Error("Missing owned label exchange.");
        return entry.argv;
      };
      const runLabel = (direction: string) =>
        new Promise<void>((resolve, reject) => {
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            CI: "true",
            GH_HOST: "github.visual.invalid",
          };
          delete env.NODE_OPTIONS;
          delete env.NODE_PATH;
          const child = NodeChildProcess.spawn(
            NodeFS.realpathSync(process.execPath),
            [fixture.executables.github, ...labelEntry(direction)],
            { cwd: fixture.projects.github.cwd, env, stdio: "ignore", timeout: 3000 },
          );
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve() : reject(new Error("Owned label exchange refused.")),
          );
        });
      let releaseUndo: () => void = () => {},
        undoCompletion: Promise<void> | null = null,
        undoIssued = false,
        immediateUndoClosedBeforeVerification = false,
        hostingPendingObserved = false;
      const gate = new Promise<void>((resolve) => {
        releaseUndo = resolve;
      });
      const hostingOwners: Array<() => PullRequestsHostingRestorationProof> = [];
      const browser = {
        getAlertText: async () => {
          alertReads++;
          throw { name: "no such alert" };
        },
        addCommand: (name: string, command: () => Promise<boolean>) => {
          Object.defineProperty(browser, name, { value: command.bind(browser) });
        },
        $: (selector: string) => ({
          waitForDisplayed: async () => {},
          waitForExist: async () => {},
          waitForEnabled: async () => {},
          isFocused: async () => true,
          isDisplayed: async () => true,
          click: async () => {
            calls.push(selector);
            if (selector.includes('normalize-space()="Done"')) await runLabel("--add-label");
            if (selector.includes('normalize-space()="Undo"')) {
              undoIssued = true;
              if (mode === "immediate-undo") {
                undoCompletion = runLabel("--remove-label");
                await undoCompletion;
                immediateUndoClosedBeforeVerification = true;
              } else if (mode !== "cancelled-undo")
                undoCompletion = gate.then(() => runLabel("--remove-label"));
            }
            if (selector.includes("primary-card-button-owned-project-original")) {
              selected = "original";
              restores++;
            }
          },
          setValue: async (value: string) => {
            values.set(selector, value);
          },
          getValue: async () => values.get(selector) ?? "",
          getText: async () => "The host rejected this operation.",
          getAttribute: async () => "text-destructive",
          scrollIntoView: async () => {},
        }),
        $$: () => ({ length: Promise.resolve(1) }),
        keys: async () => {},
        performActions: async () => {},
        execute: async (fn: Function) =>
          fn.name === "readPullRequestsCaptureWitness"
            ? {
                contextMatched: true,
                themeMatched: true,
                targetVisible: true,
                controlsVisible: true,
                expectedVisible: true,
                credentialsAbsent: true,
                bootAbsent: true,
              }
            : true,
        takeScreenshot: async () => {
          if (mode === "capture-failure") throw originalError;
          return image;
        },
      };
      bindOwnedBrowserAlertObservation(browser as never);
      const input = {
        CI: "true",
        sourceSha: fixture.sourceSha,
        theme: "light" as const,
        origin: "http://127.0.0.1:4885",
        fixture,
        originalCwd,
        git,
        browser: browser as never,
        owner: {
          until: async (read: () => Promise<boolean>) => {
            if (undoIssued && mode === "immediate-undo")
              expect(immediateUndoClosedBeforeVerification).toBe(true);
            if (await read()) return;
            if (undoIssued)
              expect(JSON.parse(NodeFS.readFileSync(rawHosting.state, "utf8"))).toEqual({
                labelApplied: true,
              });
            hostingPendingObserved = true;
            if (undoIssued && (mode === "cancelled-undo" || mode === "late-undo"))
              throw originalError;
            releaseUndo();
            if (undoCompletion) await undoCompletion;
            expect(await read()).toBe(true);
          },
          cleanup: async (_role: string, cleanup: () => Promise<void>) => cleanup(),
        },
        readSnapshot: async () =>
          Schema.decodeUnknownSync(OrchestrationReadModel)({
            snapshotSequence: 0,
            updatedAt: timestamp,
            projects,
            threads,
          }),
        readDescriptor: async () => {
          descriptorReads++;
          return Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
            environmentId: "local",
            label: "Owned local",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.7.2",
            bootId: mode === "foreign-boot" && descriptorReads > 1 ? "foreign" : "owned",
            storageInstanceId: "owned",
            capabilities: {
              gitManagerReads: true,
              gitManagerBranchSyncOperations: true,
              repositoryIdentity: true,
              pullRequestsReads: true,
              pullRequestsMutations: true,
              gitPullRequestBranchSelection: true,
              gitManagerPullRequests: true,
            },
          });
        },
        issueContextAccessToken: async () => {
          grants++;
          return "owned-private-context-token";
        },
        publicPorts: {
          fetch: async (url: string, request: RequestInit) => {
            expect(url).toBe("http://127.0.0.1:4885/api/auth/websocket-ticket");
            expect(request.headers).toEqual({
              authorization: "Bearer owned-private-context-token",
            });
            calls.push("api-ticket");
            return {
              ok: true,
              json: async () => ({ ticket: "owned-ticket", expiresAt: timestamp }),
            };
          },
          socket: () => socket,
        },
        importProject: async (cwd: string, bind?: () => Promise<unknown>) => {
          const provider = NodePath.basename(cwd);
          selected = provider;
          calls.push("import:" + provider);
          if (!projects.some((p) => Reflect.get(p as object, "workspaceRoot") === cwd)) {
            projects.push({
              id: "owned-project-" + provider,
              title: provider,
              workspaceRoot: cwd,
              defaultModelSelection: null,
              scripts: [],
              createdAt: timestamp,
              updatedAt: timestamp,
              deletedAt: null,
              repositoryIdentity:
                provider === "original"
                  ? null
                  : {
                      canonicalKey: provider + ".visual.invalid/owned/requests",
                      locator: {
                        source: "git-remote",
                        remoteName: "origin",
                        remoteUrl: "https://" + provider + ".visual.invalid/owned/requests.git",
                      },
                      rootPath: cwd,
                      displayName: "requests",
                      owner: "owned",
                      name: "requests",
                    },
            });
            threads.push({
              id: "owned-thread-" + provider,
              projectId: "owned-project-" + provider,
              title: provider,
              kind: "default",
              modelSelection: { instanceId: "claude", model: "claude-opus-4-6" },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              latestTurn: null,
              session: null,
              createdAt: timestamp,
              updatedAt: timestamp,
              deletedAt: null,
              messages: [],
              activities: [],
              checkpoints: [],
            });
          }
          expect(bind).toBeTypeOf("function");
          await bind!();
        },
        evidence,
        captured: new Set<string>(),
        captures,
        assertions,
        step: (phase: string) => calls.push(phase),
        write: () => {},
        registerHostingRestorationOwner: (verify: () => PullRequestsHostingRestorationProof) => {
          hostingOwners.push(verify);
        },
        unsafe: () => {
          unsafe++;
        },
      };
      if (mode === "ordinary" || mode === "immediate-undo" || mode === "delayed-undo") {
        const result = await runOwnedPullRequestsSelection(input);
        expect(result.files).toHaveLength(24);
        expect(result.hostingBaselineRestored).toBe(true);
        expect(hostingOwners).toHaveLength(1);
        expect(hostingOwners[0]!()).toMatchObject({
          baselineRestored: true,
          undoCompleted: true,
          ownedProcessesJoined: true,
        });
        expect(JSON.parse(NodeFS.readFileSync(rawHosting.state, "utf8"))).toEqual({
          labelApplied: false,
        });
        expect(immediateUndoClosedBeforeVerification).toBe(mode === "immediate-undo");
        expect(hostingPendingObserved).toBe(mode !== "immediate-undo");
        expect(captures).toHaveLength(24);
        expect(NodeFS.readdirSync(evidence)).toHaveLength(24);
        expect(grants).toBe(1);
        expect(restores).toBe(1);
        expect(selected).toBe("original");
        expect(alertReads).toBe(24);
        expect(unsafe).toBe(0);
        expect(calls.at(-1)).toBe("api-close");
        expect(frames.length).toBeGreaterThan(48);
        expect(frames.every((frame) => frame.tag === "pullRequests.getContext")).toBe(true);
        expect(
          frames.every((frame) =>
            [fixture.projects.github.cwd, fixture.projects.gitlab.cwd].includes(
              Reflect.get(frame.payload as object, "cwd"),
            ),
          ),
        ).toBe(true);
      } else {
        const failure = await runOwnedPullRequestsSelection(input).catch((error: unknown) => error);
        if (mode === "capture-failure" || mode === "cancelled-undo" || mode === "late-undo") {
          expect(failure).toBe(originalError);
          expect(restores).toBe(1);
          expect(calls.at(-1)).toBe("api-close");
          expect(selected).toBe("original");
        } else expect(failure).toBeInstanceOf(Error);
        expect(unsafe).toBe(1);
        expect(NodeFS.readdirSync(evidence)).toHaveLength(
          mode === "cancelled-undo" || mode === "late-undo" ? 24 : 0,
        );
        if (mode === "cancelled-undo" || mode === "late-undo") {
          expect(undoIssued).toBe(true);
          expect(hostingPendingObserved).toBe(true);
          expect(assertions).toHaveLength(0);
          expect(JSON.parse(NodeFS.readFileSync(rawHosting.state, "utf8"))).toEqual({
            labelApplied: true,
          });
          expect(() => hostingOwners[0]!()).toThrow();
          if (mode === "late-undo") {
            releaseUndo();
            if (undoCompletion) await undoCompletion;
            expect(hostingOwners[0]!()).toMatchObject({ baselineRestored: true });
            expect(unsafe).toBe(1);
          }
          NodeFS.writeFileSync(
            NodePath.join(evidence, "namespace-cleanup.json"),
            JSON.stringify({ remaining: [], controllerReaped: true }),
            { mode: 0o600 },
          );
          NodeFS.writeFileSync(
            NodePath.join(evidence, "result.json"),
            JSON.stringify({
              selection: "release-visual-pull-requests",
              source: fixture.sourceSha,
              pullRequestsFixtureSafeToDelete: unsafe === 0,
              childProcessesClosed: true,
              cleanupFailures: [],
              pullRequestsHostingRestorationProofs:
                mode === "late-undo" ? [hostingOwners[0]!()] : [],
            }),
            { mode: 0o600 },
          );
          const python =
            "import importlib.util,json,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('owned_qualification',sys.argv[1]);q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)\nvalue=json.load(sys.stdin)\nprint(json.dumps(q.cleanup_ui_fixture(Path(value['fixture']),Path(value['evidence']),{'supervisorReaped':True,'hostNetworkNamespaceUnchanged':True,'buildInputsUnchanged':True},'release-visual-pull-requests')))";
          const deletion = NodeChildProcess.spawnSync(
            "python3",
            ["-B", "-c", python, NodePath.resolve("scripts/qualify-chat-uploads.py")],
            {
              input: JSON.stringify({ fixture: displayParent, evidence }),
              env: { ...process.env, GITHUB_SHA: fixture.sourceSha },
              encoding: "utf8",
              timeout: 5000,
              maxBuffer: 4096,
            },
          );
          expect(deletion.status).toBe(0);
          expect(JSON.parse(deletion.stdout)).toBe(false);
          expect(NodeFS.existsSync(parent)).toBe(true);
          expect(unsafe).toBe(1);
        }
      }
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  },
);
it("requires every finite receipt and the actual seven-fact witness without invoking accessors", () => {
  const witness = {
    contextMatched: true,
    themeMatched: true,
    targetVisible: true,
    controlsVisible: true,
    expectedVisible: true,
    credentialsAbsent: true,
    bootAbsent: true,
  };
  const captures = pullRequestsCaptureBindings.map((binding) => ({
    ...binding,
    sha256: "a".repeat(64),
    width: 1280,
    height: 960,
    witness,
  }));
  const assertions = ["light", "dark"].map((theme) => ({
    theme,
    baseRows: 5,
    supplementalOriginals: 19,
    originalContextRestored: true,
    hostingBaselineRestored: true,
    files: pullRequestsCaptureBindings
      .filter((binding) => binding.theme === theme)
      .map((binding) => binding.file),
  }));
  expect(() => validatePullRequestsCallerJoins(captures, assertions)).not.toThrow();
  for (const field of ["file", "witness", "sha256"]) {
    let read = false;
    const altered = [...captures];
    altered[0] = Object.defineProperty({ ...captures[0]! }, field, {
      enumerable: true,
      get() {
        read = true;
        return captures[0]![field as "file"];
      },
    });
    expect(() => validatePullRequestsCallerJoins(altered, assertions)).toThrow();
    expect(read).toBe(false);
  }
  expect(() =>
    validatePullRequestsCallerJoins(
      [
        {
          ...captures[0]!,
          witness: {
            one: true,
            two: true,
            three: true,
            four: true,
            five: true,
            six: true,
            seven: true,
          },
        },
        ...captures.slice(1),
      ],
      assertions,
    ),
  ).toThrow();
  expect(() =>
    validatePullRequestsCallerJoins(captures, [
      { ...assertions[0]!, originalContextRestored: false },
      assertions[1]!,
    ]),
  ).toThrow();
  expect(() =>
    validatePullRequestsCallerJoins([...captures.slice(1), captures[1]!], assertions),
  ).toThrow();
});

it.each(["ordinary", "producer-failure", "cleanup-failure"] as const)(
  "binds the actual qualifier branch before workspace/provider baseline: %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
        new URL("../qualify-delivery-retry.ts", import.meta.url),
        "utf8",
      ),
      anchor = source.indexOf("await setTheme();"),
      start = source.indexOf('if (config.selection === "release-visual-pull-requests")', anchor),
      end = source.indexOf('step("import");', start);
    expect(start).toBeGreaterThan(anchor);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThan(source.indexOf("await importProject(context.projectPath);", end));
    const calls: string[] = [],
      original = new Error("Inert caller failure."),
      snapshotReader = async () => ({ owned: true }),
      fixture = {
        binDirectory: "/owned/light/requests/bin",
        gitConfig: "/owned/light/requests/origins.gitconfig",
      },
      context = { stateRoot: "/owned/light/state", projectPath: "/owned/light/original" },
      childEnv = { CI: "true" },
      config = {
        selection: "release-visual-pull-requests",
        source: "a".repeat(40),
        binary: "/owned/server",
        evidence: "/owned/evidence",
      },
      server = {},
      driver = {};
    const browser = {
      execute: async () => ({ width: 1280, height: 960, devicePixelRatio: 1 }),
      getWindowSize: async () => ({ width: 1280, height: 1040 }),
      setWindowSize: async (w: number, h: number) => {
        expect([w, h]).toEqual([1280, 1040]);
        calls.push("viewport");
      },
      deleteSession: async () => {
        calls.push("session-close");
      },
    };
    let unsafe = false,
      grants = 0,
      cleanupFailures: object[] = [];
    const owner = {
      until: async (check: () => Promise<boolean>) => {
        expect(await check()).toBe(true);
      },
      json: async (binary: string, args: string[], env: unknown) => {
        expect(binary).toBe(config.binary);
        expect(args).toEqual(["pairing", "issue", "--base-dir", context.stateRoot, "--json"]);
        expect(env).toBe(childEnv);
        grants++;
        return { credential: "inert-private-grant" };
      },
      cleanup: async (_role: string, run: () => Promise<void>) => run(),
      stop: async (child: unknown) => {
        calls.push(child === driver ? "driver-stop" : "server-stop");
        if (mode === "cleanup-failure") cleanupFailures = [{ role: "owned", failure: "refused" }];
      },
      get failures() {
        return cleanupFailures;
      },
      childrenClosed: () => mode !== "cleanup-failure",
    };
    const scope = {
      Error,
      config,
      childEnv,
      context,
      theme: "light",
      origin: "http://127.0.0.1:4885",
      prViewportObservation: null,
      observePrViewportNumbers,
      observePrOuterNumbers,
      pullRequestsFixture: fixture,
      pullRequestsFixtureSafeToDelete: true,
      browser,
      owner,
      opened: { driver },
      server,
      pullRequestsHostingOwners: [],
      capturedVisuals: new Set(),
      captures: [],
      assertions: [],
      step: (phase: string) => calls.push(phase),
      write: () => {},
      importProject: async () => {},
      gitProjectCommand: async () => ({ status: 0, stdout: "" }),
      readVisualViewport: () => {},
      correctDesktopUiOuterSize: () => ({ width: 1280, height: 1040 }),
      bounded: async (value: Promise<unknown>, ms: number) => {
        expect([2000, 15000]).toContain(ms);
        return value;
      },
      createOwnedGitProjectSnapshotReader: (issue: () => Promise<unknown>) => {
        calls.push("snapshot-adapter");
        return async () => {
          await issue();
          return snapshotReader();
        };
      },
      readOwnedGitProjectDescriptor: async () => ({ owned: true }),
      fixtureAccessToken: async (origin: string, credential: string) => {
        expect(origin).toBe("http://127.0.0.1:4885");
        expect(credential).toBe("inert-private-grant");
        return "inert-private-token";
      },
      runOwnedPullRequestsSelection: async (input: Record<string, unknown>) => {
        calls.push("caller");
        expect(input.fixture).toBe(fixture);
        expect(input.importProject).toBe(scope.importProject);
        expect(input.originalCwd).toBe(context.projectPath);
        expect(input.sourceSha).toBe(config.source);
        expect(input.browser).toBe(browser);
        expect(input.owner).toBe(owner);
        await (input.readSnapshot as () => Promise<unknown>)();
        expect(await (input.issueContextAccessToken as () => Promise<string>)()).toBe(
          "inert-private-token",
        );
        expect(grants).toBe(2);
        if (mode === "producer-failure") {
          (input.unsafe as () => void)();
          throw original;
        }
      },
    };
    Object.defineProperty(scope, "pullRequestsFixtureSafeToDelete", {
      get: () => !unsafe,
      set: (value: boolean) => {
        unsafe = !value;
      },
    });
    const execute = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){for(const entry of [null]){" +
          source.slice(start, end) +
          'throw new Error("Unexpected fallthrough");}}\nrun',
      ),
      scope,
    );
    const outcome = await execute().catch((error: unknown) => error);
    if (mode === "ordinary") {
      expect(outcome).toBeUndefined();
      expect(calls.slice(-4)).toEqual([
        "theme-cleanup",
        "session-close",
        "driver-stop",
        "server-stop",
      ]);
      expect(unsafe).toBe(false);
    } else {
      expect(outcome).toBeInstanceOf(Error);
      expect(unsafe).toBe(true);
      if (mode === "producer-failure") expect(outcome).toBe(original);
    }
  },
);
it("seals the actual hosting setup before server startup without forwarding Node runtime options", async () => {
  const source = NodeFS.readFileSync(
      new URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    ),
    start = source.indexOf(
      'if (config.selection === "release-visual-pull-requests")',
      source.indexOf("const gitProjectCommand ="),
    ),
    end = source.indexOf('if (config.selection === "release-visual-git-project")', start);
  expect(start).toBeGreaterThan(source.indexOf("const gitProjectCommand ="));
  expect(end).toBeLessThan(source.indexOf("const server = owner.spawn(", end));
  const childEnv: Record<string, string> = {
      CI: "true",
      PATH: "/owned/bin",
      NODE_OPTIONS: "inert",
      NODE_PATH: "inert",
    },
    git = async () => ({ status: 0, stdout: "" }),
    fixture = {
      binDirectory: "/owned/light/requests/bin",
      gitConfig: "/owned/light/requests/origins.gitconfig",
    };
  const scope = {
    config: { selection: "release-visual-pull-requests", source: "a".repeat(40) },
    runRoot: "/owned/light",
    childEnv,
    NodePath,
    NodeFS: { realpathSync: () => "/owned/node" },
    process: { execPath: "/owned/node" },
    pullRequestsFixture: null,
    gitProjectCommand: git,
    step: () => {},
    preparePullRequestsHostingFixture: async (input: {
      git: (cwd: string, args: readonly string[]) => Promise<unknown>;
      root: string;
      sourceSha: string;
      node: string;
      ci: boolean;
    }) => {
      expect(input.root).toBe("/owned/light");
      expect(input.sourceSha).toBe("a".repeat(40));
      expect(input.node).toBe("/owned/node");
      expect(input.ci).toBe(true);
      expect(await input.git("/owned/light", ["status"])).toEqual(await git());
      return fixture;
    },
  };
  await NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes("(async()=>{" + source.slice(start, end) + "})()"),
    scope,
  );
  expect(scope.pullRequestsFixture).toBe(fixture);
  expect(childEnv.PATH).toBe(fixture.binDirectory + NodePath.delimiter + "/owned/bin");
  expect(childEnv.GIT_CONFIG_GLOBAL).toBe(fixture.gitConfig);
  expect(Object.hasOwn(childEnv, "NODE_OPTIONS")).toBe(false);
  expect(Object.hasOwn(childEnv, "NODE_PATH")).toBe(false);
});
