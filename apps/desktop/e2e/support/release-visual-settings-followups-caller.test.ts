// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Hermetic private filesystem and actual caller seams only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { transformWithOxc } from "vite-plus";
import {
  prepareSettingsFollowupCallerUsage,
  bindSettingsFollowupTarget,
} from "./release-visual-settings-followups-caller.ts";
import { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import * as NodeCrypto from "node:crypto";
import { settingsSourceFixture } from "./release-visual-settings-followups-test-fixtures.ts";
import { verifySettingsFollowupSource } from "./release-visual-settings-followups-source.ts";
import { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import type { SettingsFollowupProducerInput } from "./release-visual-settings-followups-producer.ts";
import type { SettingsFollowupCallerInput } from "./release-visual-settings-followups-caller.ts";
const controllerConfigurationSource = NodeFS.readFileSync(
  new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
  "utf8",
);
const configurationStart = controllerConfigurationSource.indexOf(
    "export function deliveryConfiguration(",
  ),
  configurationEnd = controllerConfigurationSource.indexOf(
    "export function projectDeliveryWorktreeObservation(",
    configurationStart,
  );
const deliveryConfiguration = NodeVM.runInNewContext(
  NodeModule.stripTypeScriptTypes(
    controllerConfigurationSource
      .slice(configurationStart, configurationEnd)
      .replace("export ", ""),
  ) + "\ndeliveryConfiguration",
  { NodeFS, NodePath },
) as typeof import("../qualify-delivery-retry.ts").deliveryConfiguration;
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");

it("admits only the fixed Settings selector through the actual shared configuration", () => {
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
    BIBCODE_DELIVERY_UI_SELECTION: "release-visual-settings-followups",
  };
  expect(deliveryConfiguration(environment, () => "net:[2]").selection).toBe(
    "release-visual-settings-followups",
  );
  expect(() => deliveryConfiguration({ ...environment, CI: "false" }, () => "net:[2]")).toThrow();
  expect(() =>
    deliveryConfiguration(
      { ...environment, BIBCODE_DELIVERY_UI_SELECTION: "release-visual-settings-followups-extra" },
      () => "net:[2]",
    ),
  ).toThrow();
});

it("executes the actual shared caller branch with registered Git, immutable admission and original failure ownership", async () => {
  const source = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    ),
    start = source.indexOf(
      '      } else if (config.selection === "release-visual-settings-followups") {',
    ),
    end = source.indexOf(
      '      } else if (config.selection === "release-visual-settings") {',
      start,
    );
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end).slice(source.slice(start, end).indexOf("{") + 1),
    original = new Error("Owned caller original failure"),
    events: string[] = [];
  const context = { fixtureUserHomePath: "/owned/theme/home" },
    remoteContext = { fixtureUserHomePath: "/owned/theme/remote/home" },
    workspace = {
      threadId: "owned-thread",
      path: "/owned/theme/managed",
      branch: "main",
      commonDirectory: "/owned/theme/project/.git",
    },
    config = {
      selection: "release-visual-settings-followups",
      fixture: "/owned",
      source: "a".repeat(40),
      binary: "/owned/binary",
      assets: "/owned/assets",
      evidence: "/owned/evidence",
    };
  let safe = true;
  const run = NodeVM.runInNewContext("(async()=>{" + body + "})", {
    config,
    settingsFollowupUsage: {},
    server: { child: { pid: 42 } },
    owner: {},
    browser: {},
    context,
    childEnv: { CI: "true" },
    theme: "light",
    runRoot: "/owned/theme",
    workspace,
    visualInput: {},
    capturedVisuals: new Set(),
    captures: [],
    assertions: [],
    process: { env: {} },
    NodePath,
    importProject: async (project: string) => {
      expect(project).toBe("/owned/theme/remote/project");
      events.push("shared-import-B");
    },
    type: async (value: string) => {
      expect(value).toBe("Owned visual review draft");
      events.push("draft");
    },
    step: () => {},
    write: () => {},
    check: (condition: boolean) => {
      if (!condition) throw new Error("Owned source refused");
    },
    deliveryConfiguration: () => config,
    readOwnedDeliveryWorktree: () => ({
      path: workspace.path,
      branch: workspace.branch,
      commonDirectory: workspace.commonDirectory,
    }),
    runOwnedGitProjectCommand: (
      input: { home: string; git: string },
      cwd: string,
      args: readonly string[],
    ) => {
      expect(input.home).toBe(remoteContext.fixtureUserHomePath);
      expect(input.git).toBe("/owned/bin/git");
      expect(cwd).toBe("/owned/theme/remote/project");
      expect(args).toEqual(["rev-parse", "HEAD"]);
      events.push("physical");
      return { status: 0, stdout: "a".repeat(40) };
    },
    get settingsFollowupFixtureSafeToDelete() {
      return safe;
    },
    set settingsFollowupFixtureSafeToDelete(value: boolean) {
      safe = value;
    },
    runSettingsFollowupCaller: async (input: SettingsFollowupCallerInput) => {
      events.push("caller");
      await input.importProject("/owned/theme/remote/project");
      await input.admitOwner();
      input.verifyPrimaryGit();
      input.git(remoteContext as never, "/owned/theme/remote/project", ["rev-parse", "HEAD"]);
      input.observeUnsafeCleanup();
      throw original;
    },
  }) as () => Promise<void>;
  await expect(run()).rejects.toBe(original);
  expect(safe).toBe(false);
  expect(events).toEqual(["draft", "caller", "shared-import-B", "physical"]);
});
it("owns copied inert interpreter bytes, clears only child CODEX_HOME, and refuses deletion before process joins", async () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-caller-")),
  );
  try {
    const home = NodePath.join(root, "home"),
      source = NodePath.join(root, "source-node");
    NodeFS.mkdirSync(home, { mode: 0o700 });
    NodeFS.writeFileSync(source, "inert interpreter", { mode: 0o500 });
    const inherited = {
      CI: "true",
      CODEX_HOME: "/foreign",
      codex_home: "/foreign-lower",
      HOME: home,
    };
    let joined = false,
      unsafe = 0;
    const fixture = await prepareSettingsFollowupCallerUsage({
      CI: "true",
      root,
      home,
      nodeExecutable: source,
      environment: inherited,
      admitOwner: async () => {},
      childrenJoined: () => joined,
      inputsSafeToDelete: () => true,
      observeUnsafeCleanup: () => unsafe++,
    });
    expect(inherited.CODEX_HOME).toBe("/foreign");
    expect(fixture.environment.CODEX_HOME).toBeUndefined();
    expect(fixture.environment.codex_home).toBeUndefined();
    expect(fixture.environment.CODEX_BIN).toBe(fixture.executable);
    fixture.verify();
    expect(() => fixture.close()).toThrow();
    expect(unsafe).toBe(1);
    expect(NodeFS.existsSync(fixture.executable)).toBe(true);
    joined = true;
    expect(() => fixture.close()).toThrow();
    expect(NodeFS.existsSync(fixture.executable)).toBe(true);
    expect(NodeFS.existsSync(fixture.node)).toBe(true);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
it("pins copied interpreter contents and refuses substituted bytes during cleanup", async () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-caller-")),
  );
  try {
    const home = NodePath.join(root, "home"),
      source = NodePath.join(root, "source-node");
    NodeFS.mkdirSync(home, { mode: 0o700 });
    NodeFS.writeFileSync(source, "inert", { mode: 0o500 });
    let unsafe = false;
    const fixture = await prepareSettingsFollowupCallerUsage({
      CI: "true",
      root,
      home,
      nodeExecutable: source,
      environment: { CI: "true" },
      admitOwner: async () => {},
      childrenJoined: () => true,
      inputsSafeToDelete: () => true,
      observeUnsafeCleanup: () => {
        unsafe = true;
      },
    });
    NodeFS.chmodSync(fixture.node, 0o700);
    NodeFS.writeFileSync(fixture.node, "alien");
    NodeFS.chmodSync(fixture.node, 0o500);
    expect(() => fixture.verify()).toThrow();
    expect(() => fixture.close()).toThrow();
    expect(unsafe).toBe(true);
    expect(NodeFS.existsSync(fixture.executable)).toBe(true);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
it("refuses a foreign home before changing its permissions or creating any interpreter input", async () => {
  const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-caller-")),
    ),
    foreign = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-foreign-")),
    );
  try {
    NodeFS.chmodSync(foreign, 0o750);
    const source = NodePath.join(root, "source-node");
    NodeFS.writeFileSync(source, "inert", { mode: 0o500 });
    await expect(
      prepareSettingsFollowupCallerUsage({
        CI: "true",
        root,
        home: foreign,
        nodeExecutable: source,
        environment: {},
        admitOwner: async () => {},
        childrenJoined: () => true,
        inputsSafeToDelete: () => true,
        observeUnsafeCleanup: () => {},
      }),
    ).rejects.toThrow();
    expect(NodeFS.statSync(foreign).mode & 0o777).toBe(0o750);
    expect(NodeFS.readdirSync(root)).toEqual(["source-node"]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(foreign, { recursive: true, force: true });
  }
});

it("preserves both exact inputs after an external owner unsafe signal even with joined children", async () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-caller-")),
  );
  try {
    const home = NodePath.join(root, "home"),
      source = NodePath.join(root, "source-node");
    NodeFS.mkdirSync(home, { mode: 0o700 });
    NodeFS.writeFileSync(source, "inert", { mode: 0o500 });
    let safe = true;
    const signalUnsafe = () => {
      safe = false;
    };
    const fixture = await prepareSettingsFollowupCallerUsage({
      CI: "true",
      root,
      home,
      nodeExecutable: source,
      environment: { CI: "true" },
      admitOwner: async () => {},
      childrenJoined: () => true,
      inputsSafeToDelete: () => safe,
      observeUnsafeCleanup: signalUnsafe,
    });
    const executable = NodeFS.readFileSync(fixture.executable),
      node = NodeFS.readFileSync(fixture.node);
    signalUnsafe();
    expect(() => fixture.close()).toThrow();
    expect(() => fixture.close()).toThrow();
    expect(NodeFS.readFileSync(fixture.executable)).toEqual(executable);
    expect(NodeFS.readFileSync(fixture.node)).toEqual(node);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.each(["current", "stale-browse", "stale-path"])(
  "executes the shared import adapter against mounted current public controls and refuses stale selectors: %s",
  async (mode) => {
    const require = NodeModule.createRequire(NodePath.resolve("apps/web/package.json")),
      React = require("react"),
      { createRoot } = require("react-dom/client");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const source = NodeFS.readFileSync(
        NodePath.resolve("apps/web/src/components/add-project/AddProjectSteps.tsx"),
        "utf8",
      ),
      start = source.indexOf("function StepHeading("),
      end = source.indexOf("const CLONE_SUBMIT_LABELS"),
      declaration = source.slice(start, end).replace(/export /g, "");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const paths = [
      "../../../web/src/components/ui/button.tsx",
      "../../../web/src/components/ui/input.tsx",
      "../../../web/src/components/ui/kbd.tsx",
      "../../../web/src/lib/utils.ts",
    ];
    const modules = await Promise.all(paths.map((path) => import(path)));
    const ports = Object.assign(
      {},
      React,
      {
        React,
        ...require("lucide-react"),
        RemoteDirectoryBrowser: (props: {
          secondaryAction: { label: string; onClick: () => void };
        }) =>
          React.createElement(
            "button",
            { onClick: props.secondaryAction.onClick },
            props.secondaryAction.label,
          ),
      },
      ...modules,
    );
    const compiled = await transformWithOxc(declaration, "AddProjectSteps.tsx", {
      jsx: { runtime: "classic" },
    });
    const steps = new Function(
      ...Object.keys(ports),
      compiled.code +
        "\nreturn {AddProjectStartStep,AddProjectRemoteBrowseStep,AddProjectHostPathStep};",
    )(...Object.values(ports));
    const mount = document.createElement("div");
    document.body.append(mount);
    const root = createRoot(mount),
      project = "/owned/remote/project",
      calls: string[] = [];
    let path = "";
    const draw = async (stage: "start" | "browse" | "path" | "composer") => {
      const render = (next: typeof stage) => {
        void draw(next);
      };
      const value =
        stage === "start"
          ? React.createElement(steps.AddProjectStartStep, {
              hosts: [],
              locationLabel: null,
              selectedEnvironmentId: "remote:owned-store",
              busy: false,
              error: null,
              onSelectHost: () => {},
              onBrowse: () => render("browse"),
              onOpenClone: () => {},
              onOpenCreate: () => {},
            })
          : stage === "browse"
            ? React.createElement(steps.AddProjectRemoteBrowseStep, {
                hostLabel: "Owned remote",
                environmentId: "remote:owned-store",
                initialPath: "/owned",
                busy: false,
                error: null,
                onSelect: () => {},
                onTypePath: () => render("path"),
              })
            : stage === "path"
              ? React.createElement(steps.AddProjectHostPathStep, {
                  hostLabel: "Owned remote",
                  path,
                  platform: "linux",
                  error: null,
                  busy: false,
                  onPathChange: () => {},
                  onSubmit: () => render("composer"),
                })
              : React.createElement("form", { "data-chat-composer-form": "true" });
      await React.act(async () => root.render(value));
    };
    const find = (selector: string): HTMLElement | null => {
      if (selector === '[data-testid="sidebar-add-project-trigger"]') return trigger;
      if (selector.startsWith("//button[@data-add-project-action"))
        return (
          Array.from(mount.querySelectorAll<HTMLElement>("button[data-add-project-action]")).find(
            (node) =>
              Array.from(node.querySelectorAll("span")).some(
                (span) => span.textContent?.trim() === "Browse folder",
              ),
          ) ?? null
        );
      if (selector.startsWith('[role="menuitem"]='))
        return (
          Array.from(mount.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
            (node) => node.textContent?.trim() === selector.slice(selector.indexOf("]=") + 2),
          ) ?? null
        );
      if (selector.startsWith("button="))
        return (
          Array.from(mount.querySelectorAll<HTMLElement>("button")).find(
            (node) => node.textContent?.trim() === selector.slice(7),
          ) ?? null
        );
      return mount.querySelector<HTMLElement>(selector);
    };
    const trigger = document.createElement("button");
    trigger.dataset.testid = "sidebar-add-project-trigger";
    const element = (selector: string) => ({
      isDisplayed: async () => find(selector) !== null,
      isExisting: async () => find(selector) !== null,
      waitForDisplayed: async () => {
        if (!find(selector)) throw new Error("Owned current public control absent");
      },
      waitForEnabled: async () => {
        const node = find(selector);
        if (!node || (node as HTMLButtonElement).disabled)
          throw new Error("Owned current public control disabled");
      },
      click: async () => {
        calls.push(selector);
        if (selector.includes("sidebar-add-project-trigger")) await draw("start");
        else {
          const node = find(selector);
          if (!node) throw new Error("Owned current public control absent");
          await React.act(async () => node.click());
        }
      },
      setValue: async (value: string) => {
        expect(selector).toBe("#add-project-host-path");
        expect(find(selector)?.id).toBe("add-project-host-path");
        path = value;
        await draw("path");
      },
    });
    const controller = NodeFS.readFileSync(
        new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
        "utf8",
      ),
      begin = controller.indexOf("  async function importProject("),
      finish = controller.indexOf("  async function selectClaudeModel(", begin);
    let body = controller.slice(begin, finish);
    if (mode === "stale-browse")
      body = body.replace(
        JSON.stringify(
          "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
        ),
        JSON.stringify('[role="menuitem"]=Browse folder…'),
      );
    if (mode === "stale-path") body = body.replaceAll("Type a path instead", "Type path");
    const run = NodeVM.runInNewContext(NodeModule.stripTypeScriptTypes(body) + "\nimportProject", {
      importModelBinding: undefined,
      step: () => {},
      click: async (selector: string) => {
        const node = element(selector);
        await node.waitForDisplayed();
        await node.waitForEnabled();
        await node.click();
      },
      b: () => ({ $: element }),
      owner: {
        until: async (check: () => Promise<boolean>) => {
          if (!(await check())) throw new Error("Owned current public control absent");
        },
      },
      composer: '[data-chat-composer-form="true"]',
      selectClaudeModel: async (scope: string, binding: unknown) => {
        expect(scope).toBe("import");
        expect(binding).toBeUndefined();
        calls.push("selected-remote-Claude");
      },
    }) as (path: string) => Promise<void>;
    try {
      if (mode === "current") {
        await run(project);
        expect(mount.querySelector('[data-chat-composer-form="true"]')).not.toBeNull();
        expect(calls).toContain("button=Type a path instead");
        expect(calls.at(-1)).toBe("selected-remote-Claude");
      } else await expect(run(project)).rejects.toThrow("current public control absent");
    } finally {
      await React.act(async () => root.unmount());
      mount.remove();
      vi.unstubAllGlobals();
    }
  },
);
it("binds the remote client ID from a genuine native descriptor and refuses foreign source/workspace joins", () => {
  const fixture = settingsSourceFixture("remote");
  const input = {
    ownedRoot: fixture.target.ownedRoot,
    descriptor: fixture.config.environment,
    config: fixture.config,
    snapshot: fixture.snapshot,
    threadId: fixture.target.threadId,
    workspaceKind: "primary" as const,
    physical: fixture.physical,
    remote: true,
  };
  expect(bindSettingsFollowupTarget(input).environmentId).toBe("remote:remote-store");
  expect(() => bindSettingsFollowupTarget({ ...input, threadId: "foreign" })).toThrow();
  expect(() => bindSettingsFollowupTarget({ ...input, workspaceKind: "worktree" })).toThrow();
});

it.each([
  "success",
  "delayed-import",
  "producer-failure",
  "producer-and-join-failure",
  "join-failure",
  "source-drift",
  "git-substitution",
])(
  "executes the actual caller with hermetic native boundaries and joined scopes: %s",
  async (mode) => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-caller-")),
    );
    try {
      const events: string[] = [],
        original = new Error("Owned original failure"),
        a = settingsSourceFixture(),
        b = settingsSourceFixture("remote"),
        primaryPath = NodePath.join(root, "primary"),
        managedPath = NodePath.join(root, "managed"),
        remotePath = NodePath.join(root, "remote-settings", "project");
      const context = (runRoot: string, projectPath: string) => ({
        runRoot,
        projectPath,
        stateRoot: NodePath.join(runRoot, "state"),
        fixtureUserHomePath: NodePath.join(runRoot, "home"),
        shimDirectory: NodePath.join(runRoot, "shims"),
        artifactDirectory: NodePath.join(runRoot, "private"),
        nativeActionLogPath: NodePath.join(runRoot, "private", "native.jsonl"),
        providerInputLogPath: NodePath.join(runRoot, "input.jsonl"),
      });
      const primaryContext = context(root, primaryPath);
      NodeFS.mkdirSync(NodePath.join(primaryPath, ".git"), { recursive: true });
      if (mode === "git-substitution") {
        NodeFS.rmdirSync(NodePath.join(primaryPath, ".git"));
        NodeFS.mkdirSync(NodePath.join(root, "foreign-admin"));
        NodeFS.symlinkSync(
          NodePath.join(root, "foreign-admin"),
          NodePath.join(primaryPath, ".git"),
        );
      }
      const snapshot = (fixture: typeof a, path: string, worktree: string | null) =>
        Schema.decodeUnknownSync(OrchestrationReadModel)({
          ...fixture.snapshot,
          projects: [{ ...fixture.snapshot.projects[0], workspaceRoot: path }],
          threads: [{ ...fixture.snapshot.threads[0], worktreePath: worktree }],
        });
      const aSnapshot = snapshot(a, primaryPath, managedPath),
        bSnapshot = snapshot(b, remotePath, null);
      const server = { child: { pid: 123, exitCode: null, signalCode: null } };
      let registered = false,
        unsafe = false,
        producerRan = false,
        imported = false,
        remoteReads = 0;
      const browser = {
        $: (selector: string) => ({
          waitForDisplayed: async () => {
            if (
              [
                '[role="menuitem"]=Browse folder…',
                'button[aria-label="Switch to path mode"]',
                "button=Type path",
              ].includes(selector)
            )
              throw new Error("Owned current public control absent");
          },
          waitForEnabled: async () => {},
          waitForExist: async () => {},
          isDisplayed: async () => selector.includes("Remote Servers"),
          isExisting: async () => selector.includes("More actions for Owned") && registered,
          setValue: async () => {},
          getText: async () =>
            selector.includes("composer-editor") ? "Owned visual review draft" : "Claude · Opus",
          click: async () => {
            events.push(selector);
            if (selector.includes("button=Add Server") && selector.includes("dialog-popup"))
              registered = true;
            if (selector.includes("alertdialog")) registered = false;
            if (selector === "button=Open project") imported = true;
          },
        }),
        $$: (selector: string) => (selector.includes("toast-close") ? [] : [{}]),
      };
      const api = (fixture: typeof a, snapshot: OrchestrationReadModel) => ({
        config: async () => fixture.config,
        snapshot: async () =>
          fixture === b && mode === "delayed-import" && (!imported || ++remoteReads < 2)
            ? { ...snapshot, projects: [], threads: [] }
            : snapshot,
      });
      const source = NodeFS.readFileSync(
        new NodeURL.URL("./release-visual-settings-followups-caller.ts", import.meta.url),
        "utf8",
      );
      const code = NodeModule.stripTypeScriptTypes(source, { mode: "strip" })
        .replace(/^import[\s\S]*?;\n/gm, "")
        .replace(/const Schema = [\s\S]*?\);\n/, "")
        .replace(/\bexport /g, "");
      const run = NodeVM.runInNewContext(code + "\nrunSettingsFollowupCaller", {
        NodeFS,
        NodePath,
        NodeCrypto,
        Schema,
        ExecutionEnvironmentDescriptor,
        Buffer,
        AbortSignal,
        NodeNet: {
          createServer: () => ({
            once: () => {},
            listen: (port: number, host: string, ready: () => void) => {
              expect(port).toBe(4888);
              expect(host).toBe("127.0.0.1");
              events.push("port-B");
              ready();
            },
            close: (done: (error?: Error) => void) => done(),
          }),
        },
        remoteEnvironmentId: (id: string) => "remote:" + id,
        verifySettingsFollowupSource,
        bounded: async (value: Promise<unknown>) => value,
        fetch: async (url: string) => ({
          ok: true,
          text: async () =>
            JSON.stringify(url.includes("4888") ? b.config.environment : a.config.environment),
        }),
        prepareDesktopUiTestContext: (environment: NodeJS.ProcessEnv) => {
          events.push("prepare-B");
          expect(environment.CODEX_BIN).toBeUndefined();
          expect(environment.CODEX_HOME).toBeUndefined();
          const c = context(environment.BIBCODE_E2E_RUN_ROOT!, remotePath);
          NodeFS.mkdirSync(NodePath.join(c.stateRoot, "userdata"), { recursive: true });
          NodeFS.mkdirSync(NodePath.join(c.projectPath, ".git"), { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(c.stateRoot, "userdata", "settings.json"),
            JSON.stringify({ providers: { codex: {} }, providerInstances: { codex: {} } }),
          );
          environment.HOME = c.fixtureUserHomePath;
          return c;
        },
        fixtureAccessToken: async (origin: string) => {
          events.push("token-" + origin.slice(-4));
          return "owned-token";
        },
        withSettingsFollowupSocket: async (
          input: { admitOwner: () => Promise<void> },
          callback: (socket: object) => Promise<void>,
        ) => {
          await input.admitOwner();
          events.push("socket-open");
          try {
            await callback({ observation: () => ({ closed: false }) });
          } finally {
            events.push("socket-close");
          }
        },
        withSettingsFollowupApi: async (
          input: { origin: string; verifyTarget: () => Promise<void> },
          callback: (api: object) => Promise<void>,
        ) => {
          await input.verifyTarget();
          const remote = input.origin.includes("4888");
          events.push(remote ? "api-B-open" : "api-A-open");
          try {
            await callback(api(remote ? b : a, remote ? bSnapshot : aSnapshot));
          } finally {
            events.push(remote ? "api-B-close" : "api-A-close");
          }
        },
        captureSettingsFollowup: async (input: { verifyOwnedIdentity: () => Promise<void> }) => {
          await input.verifyOwnedIdentity();
          events.push("capture");
          await input.verifyOwnedIdentity();
          return { owned: true };
        },
        projectSettingsFollowupAssertion: () => ({ theme: "light", completeGroup: false }),
        runSettingsFollowupProducer: async (input: SettingsFollowupProducerInput) => {
          producerRan = true;
          events.push("producer");
          expect(input.primary.target.environmentId).toBe("local");
          expect(input.remote.target.environmentId).toBe("remote:remote-store");
          expect(input.primary.target.workspaceKind).toBe("worktree");
          expect(input.remote.target.workspaceKind).toBe("primary");
          expect(server.child.exitCode).toBeNull();
          await input.primary.readPhysical();
          await input.remote.readPhysical();
          if (mode === "producer-failure" || mode === "producer-and-join-failure") throw original;
          await input.capture({} as never, async () => {
            events.push("capture-source");
          });
          await input.removeOwnedRemoteRegistration();
          expect(server.child.exitCode).toBeNull();
          await input.verifyOriginalRestored();
          return {};
        },
      }) as (input: SettingsFollowupCallerInput) => Promise<void>;
      const input = {
        CI: "true",
        root,
        binary: "/owned/binary",
        assets: "/owned/assets",
        theme: "light",
        browser,
        primaryContext,
        primaryEnvironment: {
          CI: "true",
          PATH: "/owned/shims:/owned/bin",
          CODEX_BIN: "/owned/usage",
          CODEX_HOME: "/foreign",
        },
        importProject: async (project: string) => {
          expect(project).toBe(remotePath);
          events.push("shared-import-B");
          imported = true;
        },
        primaryServer: server,
        threadId: a.target.threadId,
        usage: { verify: () => events.push("usage-verify") },
        evidence: "/owned/evidence",
        captured: new Set(),
        captures: [],
        assertions: [],
        step: () => {},
        write: () => {},
        admitOwner: async () => {},
        verifyPrimaryGit: () => {
          if (mode === "source-drift") throw original;
        },
        observeUnsafeCleanup: () => {
          unsafe = true;
        },
        owner: {
          spawn: (_command: string, args: string[], env: NodeJS.ProcessEnv) => {
            expect(args).toContain("4888");
            expect(env.CODEX_BIN).toBeUndefined();
            events.push("spawn-B");
            return server;
          },
          until: async (check: () => Promise<boolean>) => {
            for (let count = 0; count < 3; count++) if (await check()) return;
            throw new Error("Owned readiness failed");
          },
          json: async (_command: string, args: string[]) => {
            events.push(args[1] === "offer" ? "offer" : "grant");
            return args[1] === "offer"
              ? { link: "bibcode://pair?code=owned" }
              : { credential: "owned-credential" };
          },
          stop: async () => {
            events.push("stop-B");
            if (mode === "join-failure" || mode === "producer-and-join-failure")
              throw new Error("Owned cleanup failed");
            server.child.exitCode = 0 as never;
          },
        },
        git: (_context: unknown, cwd: string, args: readonly string[]) => ({
          status: 0,
          stdout: args.includes("--show-toplevel")
            ? cwd
            : args.includes("--git-common-dir")
              ? (cwd === managedPath ? primaryPath : cwd) + "/.git"
              : args[0] === "symbolic-ref"
                ? "main"
                : "a".repeat(40),
        }),
      } as unknown as SettingsFollowupCallerInput;
      if (mode === "success" || mode === "delayed-import") await run(input);
      else if (mode === "join-failure" || mode === "git-substitution")
        await expect(run(input)).rejects.toThrow("caller refused");
      else await expect(run(input)).rejects.toBe(original);
      expect(events.at(-1)).toBe("stop-B");
      expect(registered).toBe(false);
      expect(unsafe).toBe(mode === "join-failure" || mode === "producer-and-join-failure");
      if (mode !== "source-drift" && mode !== "git-substitution") {
        expect(producerRan).toBe(true);
        expect(events).toContain('[data-testid="thread-card-button-owned-thread"]');
        expect(events.filter((value) => value === "grant")).toHaveLength(2);
        expect(events.indexOf("api-B-close")).toBeLessThan(events.indexOf("socket-close"));
        expect(events.indexOf("socket-close")).toBeLessThan(events.indexOf("stop-B"));
      }
      if (mode === "success")
        expect(events.filter((value) => value === "capture-source")).toHaveLength(2);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
