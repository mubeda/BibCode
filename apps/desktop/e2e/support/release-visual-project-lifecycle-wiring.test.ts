// @effect-diagnostics nodeBuiltinImport:off - Actual qualifier fragments execute only with hermetic ports.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";
import * as NodePath from "node:path";
import * as Lifecycle from "./release-visual-project-lifecycle.ts";
import * as Fixture from "./release-visual-project-lifecycle-fixture.ts";
import {
  OrchestrationReadModel,
  type ClientOrchestrationCommand,
} from "../../../../packages/contracts/src/orchestration.ts";
import { classifyQualificationFailure } from "./chat-upload-evidence.ts";
import { deliveryConfiguration } from "../qualify-delivery-retry.ts";
const environment = {
  CI: "true",
  BIBCODE_UPLOAD_SOURCE: "a".repeat(40),
  BIBCODE_UPLOAD_FIXTURE: "/owned/fixture",
  BIBCODE_UPLOAD_EVIDENCE: "/owned/evidence",
  BIBCODE_UPLOAD_SERVER: "/owned/server",
  BIBCODE_DELIVERY_UI_WEB: "/owned/web",
  BIBCODE_UPLOAD_CHROME: "/owned/chrome",
  BIBCODE_UPLOAD_DRIVER: "/owned/driver",
  BIBCODE_UPLOAD_NETNS: "net:[2]",
};
it("admits the fixed lifecycle selection through the actual configuration guard", () => {
  expect(
    deliveryConfiguration(
      { ...environment, BIBCODE_DELIVERY_UI_SELECTION: "release-visual-project-lifecycle" },
      () => "net:[2]",
    ).selection,
  ).toBe("release-visual-project-lifecycle");
});
it.each([
  undefined,
  "delivery-retry-ui",
  "release-visual-core",
  "release-visual-settings",
  "release-visual-git-project",
  "release-visual-cursor-question",
  "release-visual-workspace-substates",
  "release-visual-provider-chat",
])("preserves prior/default selection %s", (selection) => {
  expect(
    deliveryConfiguration(
      { ...environment, ...(selection ? { BIBCODE_DELIVERY_UI_SELECTION: selection } : {}) },
      () => "net:[2]",
    ).selection,
  ).toBe(selection ?? "delivery-retry-ui");
});
it.each([
  "arbitrary",
  "../release-visual-project-lifecycle",
  "release-visual-project-lifecycle-extra",
])("refuses foreign lifecycle selector %s", (selection) => {
  expect(() =>
    deliveryConfiguration(
      { ...environment, BIBCODE_DELIVERY_UI_SELECTION: selection },
      () => "net:[2]",
    ),
  ).toThrow();
});
it.each([
  "release-visual-project-lifecycle",
  "release-visual-cursor-question",
  "release-visual-core",
  "release-visual-settings",
  "release-visual-workspace-substates",
  "release-visual-provider-chat",
  "delivery-retry-ui",
])("the actual common baseline preserves selection %s", async (selection) => {
  const source = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    ),
    start = source.indexOf("      const baseline = "),
    end = source.indexOf("      if (config.selection === ", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  {
    const send = vi.fn(async () => {}),
      fragment = NodeModule.stripTypeScriptTypes(source.slice(start, end));
    await NodeVM.runInNewContext("(async()=>{ " + fragment + " })()", {
      config: { selection },
      theme: "light",
      step: () => {},
      send,
      owner: { until: async (read: () => Promise<boolean>) => expect(await read()).toBe(true) },
      browser: {
        $: () => ({
          getText: async () => "BiBCode deterministic streamed fixture response.",
          isDisplayed: async () => false,
          waitForDisplayed: async () => {},
        }),
      },
      surface: "owned",
      form: "owned",
      check: (value: boolean) => expect(value).toBe(true),
      newConversationNotice: "new-session",
    });
    expect(send).toHaveBeenCalledTimes(
      ["release-visual-project-lifecycle", "release-visual-cursor-question"].includes(selection)
        ? 0
        : 1,
    );
  }
});

async function actualLifecycleCaller(
  mode = "valid",
  theme: "light" | "dark" = "light",
  initialFailure?: string,
) {
  const source = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    ),
    start = source.indexOf('        step("visual-project-lifecycle-bind");'),
    end = source.indexOf(
      '      } else if (config.selection === "release-visual-workspace-substates")',
      start,
    );
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const Schema = NodeModule.createRequire(
      new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
    )("effect/Schema"),
    template = JSON.parse(
      NodeFS.readFileSync(
        new NodeURL.URL(
          "../../../../packages/contracts/fixtures/http-orchestration/full-read-model.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
    time = template.updatedAt;
  const root = "/owned/" + theme,
    primary = root + "/primary",
    managed = root + "/managed-worktrees/primary/codex-delivery-retry-" + theme,
    trust = root + "/visual-project-lifecycle/visual trust 'checkout",
    serverArgs = ["/owned/server", "serve"],
    namespace = { net: "net:[2]", pid: "pid:[3]", user: "user:[4]" };
  const project = {
      ...template.projects[0],
      id: "owned-project",
      title: "Primary",
      workspaceRoot: primary,
      deletedAt: null,
    },
    base = {
      ...template.threads[0],
      projectId: project.id,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      session: null,
      messages: [],
      activities: [],
      checkpoints: [],
      proposedPlans: [],
      archivedAt: null,
      deletedAt: null,
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    },
    host = {
      ...base,
      id: "owned-workspace",
      title: "Owned workspace",
      kind: "workspace",
      branch: "codex/delivery-retry-" + theme,
      worktreePath: managed,
    },
    main = { ...base, id: "owned-primary", title: "Primary", kind: "default" };
  let model = { ...template, projects: [project], threads: [host, main] },
    selected = host.id,
    trusted = true,
    dialog = false,
    clone = false,
    hook = false;
  const records = new Map<number, Fixture.LifecycleProcessRecord>([
      [
        42,
        {
          pid: 42,
          parent: 1,
          uid: 1001,
          state: "S",
          started: "11",
          executable: "/owned/server",
          cwd: "/owned/repo",
          args: serverArgs,
          namespaces: namespace,
        },
      ],
    ]),
    inputs: Array<{
      provider: "codex";
      kind: "start";
      prompt: string;
      turnId: string;
      recordedAt: string;
    }> = [],
    actions: string[] = [],
    joins: Lifecycle.ProjectLifecycleObservation[] = [],
    original = new Error("Inert original capture failure.");
  let rejectClone!: (error: unknown) => void;
  const attached = new Promise((_, reject) => {
    rejectClone = reject;
  });
  void attached.catch(() => {});
  const fixture = {
    primaryCheckout: primary,
    trustCheckout: trust,
    cloneUrl: "https://visual.invalid/lifecycle-origin.git",
    cloneParent: root + "/visual-project-lifecycle/clone-parent",
    verifyInputsRetained: async () => expect(trusted).toBe(true),
    verifyCloneConfiguration: async () => {},
    heldTransferReady: async () => hook,
    verifyHeldTransferOwner: async (pid: number) => {
      expect(pid).toBe(42);
      expect(hook).toBe(true);
      return {
        phase: "real-pack-held",
        forwardedBytes: 4096,
        totalBytes: 5000,
        packSha256: "a".repeat(64),
        delegateReaped: true,
      };
    },
    verifyHeldTransferReaped: async () => expect(hook).toBe(false),
    verifyTargetExemptionRemoved: async () => expect(trusted).toBe(false),
    setTargetTrust: async (path: string, allow: boolean) => {
      expect(path).toBe(trust);
      actions.push(allow ? "trust-restored" : "trust-denied");
      if (mode === "cleanup-failure" && allow) throw new Error("Inert restore failure.");
      trusted = allow;
    },
  };
  const snapshot = async () => Schema.decodeUnknownSync(OrchestrationReadModel)(model);
  const api = {
    snapshot,
    dispatch: async (command: ClientOrchestrationCommand) => {
      if (command.type === "thread.turn.start") {
        expect(command.message.text).toBe(Lifecycle.lifecycleBusyPrompt);
        actions.push("native-start");
        inputs.push({
          provider: "codex",
          kind: "start",
          prompt: command.message.text,
          turnId: "native-turn",
          recordedAt: time,
        });
        Object.assign(host, {
          messages: [
            {
              id: command.message.messageId,
              role: "user",
              text: command.message.text,
              turnId: null,
              streaming: false,
              attachments: [],
              createdAt: time,
              updatedAt: time,
              delivery: {
                state: "delivered",
                provider: "codex",
                providerInstanceId: "codex",
                mode: "start",
              },
            },
          ],
          session: {
            threadId: host.id,
            status: "running",
            providerName: "codex",
            providerInstanceId: "codex",
            runtimeMode: "full-access",
            activeTurnId: "native-turn",
            lastError: null,
            updatedAt: time,
          },
          latestTurn: {
            turnId: "native-turn",
            state: "running",
            requestedAt: time,
            startedAt: time,
            completedAt: null,
            assistantMessageId: null,
          },
        });
        records.set(57, {
          pid: 57,
          parent: 42,
          uid: 1001,
          state: "S",
          started: "12",
          executable: "/owned/node",
          cwd: managed,
          args: [
            "/owned/node",
            root + "/shims/codex-fixture.mjs",
            "-c",
            "mcp_servers.bibcode.url=http://127.0.0.1:4885/mcp",
            "-c",
            'mcp_servers.bibcode.bearer_token_env_var="BIBCODE_MCP_BEARER_TOKEN"',
            "app-server",
          ],
          namespaces: namespace,
        });
      } else {
        expect(command.type).toBe("thread.session.stop");
        actions.push("native-stop");
        Object.assign(host, {
          session: {
            threadId: host.id,
            status: "stopped",
            providerName: "codex",
            providerInstanceId: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: time,
          },
          latestTurn: {
            turnId: "native-turn",
            state: "interrupted",
            requestedAt: time,
            startedAt: time,
            completedAt: time,
            assistantMessageId: null,
          },
        });
        records.delete(57);
      }
      return { sequence: 1 };
    },
    removalPlan: async () => ({
      planToken: "a".repeat(64),
      generation: 1,
      availability: "present",
      registered: true,
      locked: false,
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      pruneImpact: [],
    }),
    remove: async () => {
      actions.push("real-refusal");
      throw {
        _tag: "WorktreeRemovalError",
        reason: "session-running",
        message: "Owned maintained turn.",
      };
    },
    attachClone: async (payload: unknown) => {
      expect(payload).toEqual({
        url: fixture.cloneUrl,
        parentDir: fixture.cloneParent,
        attach: true,
      });
      expect(hook).toBe(true);
      actions.push("attach-only");
      return attached;
    },
    refreshStatus: async (payload: unknown) => {
      expect(payload).toEqual({ cwd: trust });
      return {
        isRepo: trusted,
        repositoryUnavailableReason: trusted ? undefined : "untrusted",
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      };
    },
  };
  const values = new Map<string, string>(),
    browser = {
      $$: async () => ({ length: Promise.resolve(1) }),
      $: (selector: string) => ({
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        waitForExist: async () => {},
        isExisting: async () => dialog,
        isFocused: async () => true,
        getValue: async () => values.get(selector) ?? "",
        setValue: async (value: string) => {
          values.set(selector, value);
        },
        click: async (options?: unknown) => {
          actions.push("click");
          if (selector.includes("Delete Worktree")) dialog = true;
          if (selector.endsWith(" button=Cancel")) dialog = false;
          if (selector.includes('normalize-space()="Clone"')) {
            dialog = true;
            clone = true;
            hook = true;
          }
          if (selector.includes("Cancel clone")) {
            expect(clone).toBe(true);
            clone = false;
            hook = false;
            rejectClone({
              _tag: "GitCloneOperationError",
              reason: "cancelled",
              destination: fixture.cloneParent + "/lifecycle-origin",
              message: "Owned cancel.",
            });
          }
          if (selector.includes("primary-card-button-owned-project")) selected = main.id;
          if (selector.includes("primary-card-button-trust-project")) selected = "trust-thread";
        },
      }),
      keys: async () => {},
      execute: async (
        _read: unknown,
        input: { boundThreadId?: string; selection?: { threadId: string } },
      ) =>
        input.boundThreadId
          ? { threadId: selected === host.id ? host.id : "foreign" }
          : selected === input.selection?.threadId,
    };
  const owner = {
    until: async (read: () => Promise<boolean>) => expect(await read()).toBe(true),
    json: async () => ({ credential: "owned-private-credential" }),
    failures: [] as object[],
  };
  const captures: object[] = [],
    assertions: object[] = [],
    descriptor = {
      environmentId: "local",
      bootId: "owned-boot",
      storageInstanceId: "owned-storage",
      capabilities: { vcsCloneReattach: mode !== "capability-false" },
    };
  const scope = {
    step: (phase: string) => actions.push(phase),
    projectLifecycleFixture: fixture,
    lifecycleSnapshot: snapshot,
    server: { child: { pid: 42, spawnargs: serverArgs } },
    configured: { worktreeBaseDirectory: root + "/managed-worktrees" },
    workspace: {
      threadId: host.id,
      path: managed,
      branch: host.branch,
      commonDirectory: primary + "/.git",
    },
    context: {
      projectPath: primary,
      shimDirectory: root + "/shims",
      providerInputLogPath: root + "/native-input",
      stateRoot: root + "/state",
    },
    runRoot: root,
    root: "/owned/repo",
    origin: "http://127.0.0.1:4885",
    theme,
    config: { fixture: "/owned/fixture", binary: "/owned/server", evidence: "/owned/evidence" },
    childEnv: {
      CI: "true",
      BIBCODE_UPLOAD_NETNS: namespace.net,
      BIBCODE_UPLOAD_PIDNS: namespace.pid,
      BIBCODE_UPLOAD_USERNS: namespace.user,
    },
    NodePath,
    NodeFS: {
      lstatSync: () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: 1001,
        dev: 1,
        ino: 2,
      }),
      readFileSync: () => Buffer.from("gitdir: owned"),
      realpathSync: (path: string) => path,
      readdirSync: () => [...records.keys()].map(String),
    },
    process: { execPath: "/owned/node" },
    readOwnedGitProjectDescriptor: async () => descriptor,
    readOwnedDeliveryWorktree: () => ({
      path: managed,
      branch: host.branch,
      commonDirectory: primary + "/.git",
    }),
    createLifecycleProcessProof: Fixture.createLifecycleProcessProof,
    readLifecycleProcessRecord: (pid: number) => records.get(pid) ?? null,
    Schema,
    OrchestrationReadModel,
    check: (value: boolean) => expect(value).toBe(true),
    owner,
    NodeCrypto: { randomUUID: () => "owned-command" },
    DateTime: { formatIso: () => time, nowUnsafe: () => time },
    fixtureAccessToken: async () => "owned-private-bearer",
    withProjectLifecycleApi: async (
      input: { projectId: string; verifyTarget: () => Promise<void> },
      run: (client: typeof api) => Promise<void>,
    ) => {
      expect(input.projectId).toBe(project.id);
      await input.verifyTarget();
      await run(api);
    },
    createProjectLifecycleSourceJoins: (input: Lifecycle.ProjectLifecycleSourceJoinInput) => {
      expect(input.rpc).toBe(api);
      joins.push(input.binding);
      return Lifecycle.createProjectLifecycleSourceJoins(input);
    },
    createProjectLifecycleBrowserFlows: Lifecycle.createProjectLifecycleBrowserFlows,
    runProjectLifecycleScene: Lifecycle.runProjectLifecycleScene,
    captureProjectLifecycleScene: async (
      input: Lifecycle.ProjectLifecycleObservation & {
        verifyOwnedIdentity: () => Promise<void>;
        verifySource: () => Promise<void>;
      },
    ) => {
      await input.verifyOwnedIdentity();
      await input.verifySource();
      if (mode === "cleanup-failure" && input.scene === "git-trust-refusal") throw original;
      return {
        scene: input.scene,
        theme: input.theme,
        file: Lifecycle.lifecycleScreenshotName(input.scene, input.theme),
        witness: {
          themeMatched: true,
          selectedMatched: true,
          expectedTextMatched: true,
          targetInView: true,
          credentialAbsent: true,
          bootShellAbsent: true,
          ...(input.scene === "worktree-remove-busy"
            ? {
                singleRemovalDialog: true,
                runningReason: true,
                destructiveDisabled: true,
                reasonLinked: true,
                checkoutIdentityMatched: true,
              }
            : input.scene === "project-clone-progress"
              ? {
                  singleCloneForm: true,
                  cloneRunning: true,
                  cancelEnabled: true,
                  inputsRetained: true,
                  inputsDisabled: true,
                }
              : {
                  singleTrustAlert: true,
                  quotedTrustCommand: true,
                  retryEnabled: true,
                  operationsDisabled: true,
                  disabledReasons: true,
                }),
        },
        width: 1280,
        height: 960,
        nonBlank: true,
        sha256: "a".repeat(64),
      };
    },
    readProviderChatInputs: () => inputs,
    b: () => browser,
    readSelectedDeliveryWorktree: () => {},
    readGitProjectSelection: () => {},
    click: async (selector: string) => browser.$(selector).click(),
    classifyQualificationFailure,
    importProject: async (path: string) => {
      expect(path).toBe(trust);
      model.projects.push({
        ...project,
        id: "trust-project",
        title: "visual trust 'checkout",
        workspaceRoot: trust,
      });
      model.threads.push({
        ...base,
        id: "trust-thread",
        projectId: "trust-project",
        title: "visual trust 'checkout",
        kind: "default",
      });
      selected = "trust-thread";
    },
    captures,
    assertions,
    capturedVisuals: new Set<string>(),
    write: () => {},
    projectLifecycleAssertion: Lifecycle.projectLifecycleAssertion,
    projectLifecycleFixtureSafeToDelete: true,
    visualInput: {},
  };
  const refusedInitial = () => {
    throw original;
  };
  if (initialFailure === "snapshot") scope.lifecycleSnapshot = refusedInitial;
  if (initialFailure === "descriptor") scope.readOwnedGitProjectDescriptor = refusedInitial;
  if (initialFailure === "path") scope.configured.worktreeBaseDirectory = root + "/foreign";
  if (initialFailure === "checkout") scope.NodeFS.lstatSync = refusedInitial;
  if (initialFailure === "process") scope.createLifecycleProcessProof = refusedInitial;
  if (initialFailure === "decode") scope.lifecycleSnapshot = async () => ({}) as never;
  if (initialFailure === "workspace") scope.workspace.threadId = "foreign-workspace";
  if (initialFailure === "project") project.workspaceRoot = root + "/foreign-project";
  if (initialFailure === "grant") scope.owner.json = refusedInitial;
  if (initialFailure === "token") scope.fixtureAccessToken = refusedInitial;
  if (initialFailure === "api") scope.withProjectLifecycleApi = refusedInitial;
  let error: unknown;
  try {
    await NodeVM.runInNewContext(
      "(async()=>{" + NodeModule.stripTypeScriptTypes(source.slice(start, end)) + "})()",
      scope,
    );
  } catch (value) {
    error = value;
  }
  return { scope, actions, joins, error, original, trusted };
}
it("executes the actual full caller with decoded current-source joins, public actions and clone-last cleanup", async () => {
  const result = await actualLifecycleCaller();
  expect(
    result.error === undefined,
    result.actions.filter((value) => value.startsWith("visual-")).at(-1),
  ).toBe(true);
  expect(result.joins.map((value) => value.scene)).toEqual([
    "worktree-remove-busy",
    "git-trust-refusal",
    "project-clone-progress",
  ]);
  expect(result.scope.captures).toHaveLength(3);
  expect(result.scope.assertions).toHaveLength(1);
  expect(result.actions.filter((value) => value === "native-start")).toHaveLength(1);
  expect(result.actions.filter((value) => value === "attach-only")).toHaveLength(1);
  expect(result.actions).toContain("native-stop");
  expect(result.trusted).toBe(true);
  expect(result.scope.owner.failures).toEqual([]);
  expect(
    result.actions.filter((value) => value.startsWith("visual-project-lifecycle-bind-")),
  ).toEqual(
    [
      "snapshot",
      "descriptor",
      "path",
      "checkout",
      "process",
      "decode",
      "workspace",
      "project",
      "grant",
      "token",
      "api",
    ].map((boundary) => "visual-project-lifecycle-bind-" + boundary),
  );
});
it("the actual caller preserves the original capture failure while reporting failed restoration and retaining the fixture", async () => {
  const result = await actualLifecycleCaller("cleanup-failure");
  expect(result.error).toBe(result.original);
  expect(result.scope.projectLifecycleFixtureSafeToDelete).toBe(false);
  expect(result.scope.owner.failures.length).toBeGreaterThan(0);
  expect(result.actions).not.toContain("attach-only");
});

it("refuses an unadvertised join-only clone capability before any row or native input", async () => {
  const result = await actualLifecycleCaller("capability-false");
  expect(result.error).toBeDefined();
  expect(result.joins).toEqual([]);
  expect(result.actions).not.toContain("native-start");
});

it("the actual two-theme caller closes the unchanged six-original lifecycle contract", async () => {
  const light = await actualLifecycleCaller("valid", "light"),
    dark = await actualLifecycleCaller("valid", "dark");
  expect(light.error).toBeUndefined();
  expect(dark.error).toBeUndefined();
  expect(
    Lifecycle.validateProjectLifecycleJoins(
      [...light.scope.captures, ...dark.scope.captures],
      [...light.scope.assertions, ...dark.scope.assertions],
    ),
  ).toEqual({ existingRowsOnly: true, completeGroup: false, originalCount: 6 });
});
it.each([
  "snapshot",
  "descriptor",
  "path",
  "checkout",
  "process",
  "decode",
  "workspace",
  "project",
  "grant",
  "token",
  "api",
])("attributes the existing initial %s boundary without starting a row", async (boundary) => {
  const result = await actualLifecycleCaller("valid", "light", boundary);
  expect(result.error).toBeDefined();
  expect(result.actions.filter((value) => value.startsWith("visual-")).at(-1)).toBe(
    "visual-project-lifecycle-bind-" + boundary,
  );
  expect(result.scope.captures).toEqual([]);
  expect(result.joins).toEqual([]);
  expect(result.actions).not.toContain("native-start");
  if (!["path", "decode", "workspace", "project"].includes(boundary))
    expect(result.error).toBe(result.original);
});
