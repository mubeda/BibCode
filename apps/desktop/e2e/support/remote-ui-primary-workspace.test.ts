// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Owned Git fixture, DOM/card and public-reader replay.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import { expect, it, vi } from "vite-plus/test";
import {
  decodeReloadPrimaryWorkspace,
  decodeReloadPrimaryThreadProof,
  projectReloadPrimaryThreadWitness,
  readReloadPrimaryThread,
  readReloadPrimaryWorkspace,
} from "./remote-ui-primary-workspace.ts";
import { prepareDesktopUiTestContext } from "./test-project.ts";

const webRequire = NodeModule.createRequire(
  new NodeURL.URL("../../../web/package.json", import.meta.url),
);
const { transformSync } = NodeModule.createRequire(webRequire.resolve("vite-plus"))("esbuild");
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const { Window } = webRequire("happy-dom");
const cardModule = { exports: {} as Record<string, any> };
NodeVM.runInNewContext(
  transformSync(
    NodeFS.readFileSync(
      new NodeURL.URL("../../../web/src/components/sidebar/WorkspaceCard.tsx", import.meta.url),
      "utf8",
    ),
    { loader: "tsx", format: "cjs", jsx: "transform" },
  ).code,
  {
    React,
    module: cardModule,
    exports: cardModule.exports,
    require: (id: string) =>
      id.endsWith("lib/utils")
        ? { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }
        : id.endsWith("ui/sidebar")
          ? {
              SidebarMenuSubItem: (props: Record<string, unknown>) =>
                React.createElement("li", props, props.children),
            }
          : id.endsWith("ui/tooltip")
            ? {
                Tooltip: (props: Record<string, unknown>) =>
                  React.createElement(React.Fragment, null, props.children),
                TooltipTrigger: (props: any) =>
                  props.render ? React.cloneElement(props.render, undefined, props.children) : null,
                TooltipPopup: () => null,
              }
            : id.includes("ProviderInstanceIcon")
              ? { ProviderInstanceIcon: () => null }
              : id.includes("ThreadStatusIndicators")
                ? { ChangeRequestStatusIcon: () => null }
                : id.includes("RelativeAge")
                  ? { RelativeAge: () => null }
                  : webRequire(id),
  },
);
function productionFunction(file: string, name: string) {
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../../../web/src/" + file, import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export function " + name + "(");
  const end = source.indexOf("\n}\n", start) + 3;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end).replace("export function ", "function ");
}

const previewLogic = NodeVM.runInNewContext(
  NodeModule.stripTypeScriptTypes(
    productionFunction("components/sidebar/agentsSection.logic.ts", "resolveAgentProvider") +
      productionFunction(
        "components/sidebar/agentsSection.logic.ts",
        "resolveConversationPreviewLine",
      ) +
      productionFunction(
        "components/sidebar/workspaceCard.logic.ts",
        "resolveWorkspaceCardPreview",
      ) +
      "\n({ resolveAgentProvider, resolveWorkspaceCardPreview })",
  ),
  {
    isProviderDriverKind: (value: string) => value === "codex",
    PROVIDER_DISPLAY_NAMES: { codex: "Codex" },
    formatProviderSlugLabel: (value: string) => value,
  },
);
const sidebarSource = NodeFS.readFileSync(
  new NodeURL.URL("../../../web/src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const primaryStart = sidebarSource.indexOf("const SidebarPrimaryCard = memo(");
const primaryEnd = sidebarSource.indexOf("\nconst SidebarProjectThreadList = memo(", primaryStart);
expect(primaryStart).toBeGreaterThan(0);
expect(primaryEnd).toBeGreaterThan(primaryStart);
// Run the actual card and preview projection. Only unrelated hook/query/command ports are inert.
const SidebarPrimaryCard = NodeVM.runInNewContext(
  transformSync(sidebarSource.slice(primaryStart, primaryEnd) + "\nSidebarPrimaryCard;", {
    loader: "tsx",
    format: "cjs",
    jsx: "transform",
  }).code,
  {
    React,
    ...React,
    ...cardModule.exports,
    ...previewLogic,
    useEnvironmentQuery: () => ({ data: null }),
    vcsEnvironment: { summary: () => null },
    resolveGitManagerRepositoryUnavailable: () => null,
    resolveWorkspaceBranchLabel: () => null,
    scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
    scopedThreadKey: (ref: { environmentId: string; threadId: string }) =>
      ref.environmentId + ":" + ref.threadId,
    useUiStateStore: (read: (state: unknown) => unknown) => read({ threadLastVisitedAtById: {} }),
    useSidebarWorkspaceMetaStore: (read: (state: unknown) => unknown) =>
      read({ markRead: () => {} }),
    useAtomCommand: () => () => {},
    previewEnvironment: { open: null },
    resolveWorkspaceCardStatus: () => ({ kind: "idle", label: "Idle", colorClass: "" }),
    WORKSPACE_CARD_STATUS: { idle: { kind: "idle", label: "Idle", colorClass: "" } },
    prStatusIndicator: () => null,
    resolveWorkspaceDirty: () => false,
    terminalStatusFromRunningIds: () => null,
    shouldShowWorkspaceBranchText: () => false,
    resolveWorkspaceCardAgeSource: () => null,
    resolveWorkspaceCardClassName: () => "",
  },
);
const binding = {
  environmentId: "primary",
  projectId: "owned-project",
  threadId: "owned-thread",
  sessionLinePresent: true,
};
const input = { projectName: "BiBCode UI Fixture", ...binding, requireSelected: true };

const publicHttpFixture = JSON.parse(
  NodeFS.readFileSync(
    new NodeURL.URL(
      "../../../../packages/contracts/fixtures/http-orchestration/full-read-model.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  snapshotSequence: number;
  updatedAt: string;
  projects: Record<string, unknown>[];
  threads: Record<string, unknown>[];
};

function httpSnapshotFixture(existing: boolean): typeof publicHttpFixture {
  const templateThread = publicHttpFixture.threads.find(
    (thread) =>
      thread.kind === "default" && thread.archivedAt === null && thread.deletedAt === null,
  )!;
  const templateProject = publicHttpFixture.projects.find(
    (project) => project.id === templateThread.projectId,
  )!;
  expect(templateThread).toBeDefined();
  expect(templateProject).toBeDefined();
  return {
    ...publicHttpFixture,
    projects: [{ ...templateProject, id: binding.projectId, deletedAt: null }],
    threads: existing
      ? [
          {
            ...templateThread,
            id: binding.threadId,
            projectId: binding.projectId,
            kind: "default",
            branch: null,
            worktreePath: null,
            archivedAt: null,
            deletedAt: null,
          },
        ]
      : [],
  };
}

it("uses the actual public HTTP read-model serializer and populated cross-language fixture", () => {
  const runtime = NodeFS.readFileSync(
    new NodeURL.URL("../../../server/src/production/runtime.rs", import.meta.url),
    "utf8",
  );
  const producer = runtime.slice(
    runtime.indexOf("JsonOperation::OrchestrationSnapshot =>"),
    runtime.indexOf("JsonOperation::OrchestrationDispatch =>"),
  );
  expect(producer).toContain("load_snapshot(&self.orchestration.repositories())");
  expect(producer).toContain("read_model_snapshot(&snapshot, &now_iso())");
  expect(producer).not.toContain("serde_json::to_value(snapshot)");
  const snapshot = httpSnapshotFixture(true);
  expect(Object.keys(snapshot).sort()).toEqual([
    "projects",
    "snapshotSequence",
    "threads",
    "updatedAt",
  ]);
  expect(snapshot.projects[0]).toMatchObject({ id: binding.projectId, deletedAt: null });
  expect(snapshot.threads[0]).toMatchObject({
    id: binding.threadId,
    projectId: binding.projectId,
    kind: "default",
    archivedAt: null,
    deletedAt: null,
    worktreePath: null,
  });
  expect(snapshot.projects[0]).not.toHaveProperty("project_id");
  expect(snapshot.threads[0]).not.toHaveProperty("thread_id");
});

function fixture(active = true, existing = true, empty = false) {
  const window = new Window();
  const primaryThread = existing
    ? {
        id: "owned-thread",
        projectId: "owned-project",
        environmentId: "primary",
        kind: "default",
        archivedAt: null,
        deletedAt: null,
        branch: null,
        worktreePath: null,
        session: empty ? null : { providerName: "codex" },
        unresolvedDelivery: null,
        conversationPreview: null,
        latestTurn: null,
      }
    : null;
  window.document.body.innerHTML = renderToStaticMarkup(
    React.createElement(
      "div",
      null,
      React.createElement("button", {
        "data-testid": "environment-rail-local",
        "aria-checked": "true",
      }),
      React.createElement(
        "li",
        { "data-slot": "sidebar-menu-item" },
        React.createElement(
          "button",
          { "data-sidebar": "menu-button", "aria-expanded": true },
          "BiBCode UI Fixture",
        ),
        React.createElement(
          "ul",
          null,
          React.createElement(SidebarPrimaryCard, {
            project: {
              id: "owned-project",
              environmentId: "primary",
              displayName: "BiBCode UI Fixture",
              workspaceRoot: "/owned/BiBCode UI Fixture",
            },
            primaryThread,
            isActive: active && existing,
            isPinned: false,
            isUnread: false,
            runningTerminalIds: [],
            discoveredPorts: [],
            modelLabel: "",
            moreChatsCount: 0,
            moreChatsStatus: null,
            onClick: () => {},
            onOpenMenu: () => {},
            openPrLink: () => {},
            navigateToThread: () => {},
          }),
        ),
      ),
    ),
  );
  const location = {
    origin: "http://localhost:4901",
    pathname: active ? "/primary/owned-thread" : "/removed-remote/old-thread",
    search: "",
    hash: "",
  };
  const read = NodeVM.runInNewContext("(" + readReloadPrimaryWorkspace.toString() + ")", {
    document: window.document,
    location,
  });
  return {
    window,
    location,
    read,
    snapshot: httpSnapshotFixture(existing),
  };
}

function publicThreadRead(
  f: ReturnType<typeof fixture>,
  snapshot: unknown = f.snapshot,
  decorate?: (response: { ok: boolean; status: number; text: () => Promise<string> }) => unknown,
) {
  const requests: Array<{ url: string; credentials: string; timeout: number }> = [];
  const rawRead = NodeVM.runInNewContext("(" + readReloadPrimaryThread.toString() + ")", {
    document: f.window.document,
    location: f.location,
    AbortSignal: { timeout: (timeout: number) => ({ timeout }) },
    fetch: async (url: string, options: { credentials: string; signal: { timeout: number } }) => {
      requests.push({ url, credentials: options.credentials, timeout: options.signal.timeout });
      const response = { ok: true, status: 200, text: async () => JSON.stringify(snapshot) };
      return decorate ? decorate(response) : response;
    },
  });
  return { read: async (input: unknown) => (await rawRead(input)).matched, rawRead, requests };
}

it("selects only the owned primary after the fixture's real Git branch synchronization", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-reload-branch-"));
  const f = fixture(false, true, true);
  try {
    const context = prepareDesktopUiTestContext({
      BIBCODE_E2E_RUN_ROOT: NodePath.join(root, "fixture"),
      BIBCODE_E2E_ARTIFACT_DIR: NodePath.join(root, "artifacts"),
      BIBCODE_E2E_PLATFORM: "linux",
    });
    const branch = NodeChildProcess.execFileSync(
      "git",
      ["-C", context.projectPath, "branch", "--show-current"],
      {
        encoding: "utf8",
      },
    ).trim();
    const synchronize = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        productionFunction(
          "components/GitActionsControl.logic.ts",
          "resolveLiveThreadBranchUpdate",
        ) + "\nresolveLiveThreadBranchUpdate",
      ),
    );
    const update = synchronize({ threadBranch: null, gitStatus: { refName: branch } });
    expect(update).toEqual({ branch: "main" });
    const snapshot = {
      ...f.snapshot,
      threads: [{ ...f.snapshot.threads[0], branch: update.branch }],
    };
    const probe = publicThreadRead(f, snapshot);
    const proof = await probe.rawRead({ ...binding, snapshotPath: "/api/orchestration/snapshot" });
    expect(proof.matched).toBe(true);
    expect(proof.witness.branchNull).toBe(false);
    expect(proof.witness.expectedBranchMatched).toBe(true);
    expect(probe.requests).toEqual([
      {
        url: "http://localhost:4887/api/orchestration/snapshot",
        credentials: "include",
        timeout: 10_000,
      },
    ]);
    expect(JSON.stringify(proof)).not.toMatch(/main|owned-project|owned-thread|localhost|http:/);

    // Replay the actual public preparation boundary with the real DOM and reader.
    const controller = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-remote-updates.ts", import.meta.url),
      "utf8",
    );
    const start = controller.indexOf(
      '  phase("reload-open-workspace");',
      controller.indexOf("async function reloadFlow("),
    );
    const end = controller.indexOf("  const draft =", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const actions: string[] = [];
    const controllerProbe = publicThreadRead(f, snapshot);
    const primaryWorkspace = { ...binding, sessionLinePresent: false };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function prep(){" + controller.slice(start, end) + "}\nprep",
      ),
      {
        phase: () => {},
        workspace: async () => actions.push("workspace"),
        click: async (selector: string) => {
          actions.push(selector);
          if (selector === '[data-testid="primary-card-button-owned-project"]') {
            f.window.document.querySelector(selector).setAttribute("aria-current", "page");
            f.location.pathname = "/primary/owned-thread";
          } else expect(selector).toBe('[data-testid="environment-rail-local"]');
        },
        required: () => ({
          execute: async (read: unknown, input: unknown) =>
            read === readReloadPrimaryThread ? controllerProbe.rawRead(input) : f.read(input),
          $: () => ({
            waitForDisplayed: async () => expect(f.location.pathname).toBe("/primary/owned-thread"),
          }),
        }),
        readReloadPrimaryWorkspace,
        readReloadPrimaryThread,
        decodeReloadPrimaryWorkspace,
        decodeReloadPrimaryThreadProof,
        EnvironmentOrchestrationHttpApi: {
          endpoints: { snapshot: { path: "/api/orchestration/snapshot" } },
        },
        primaryWorkspace,
        primaryRead: {
          projectName: "BiBCode UI Fixture",
          ...primaryWorkspace,
          requireSelected: true,
        },
        owner: { until: async (read: () => Promise<boolean>) => expect(await read()).toBe(true) },
        composer: "owned-composer",
        check: (value: unknown) => expect(value).toBe(true),
      },
    );
    await expect(run()).resolves.toBeUndefined();
    expect(actions).toEqual([
      "workspace",
      '[data-testid="environment-rail-local"]',
      '[data-testid="primary-card-button-owned-project"]',
    ]);
    expect(controllerProbe.requests).toEqual(probe.requests);
  } finally {
    await f.window.happyDOM.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("captures the actual empty primary card without starting or fabricating a provider session", async () => {
  const f = fixture(true, true, true);
  try {
    const card = f.window.document.querySelector(
      '[data-testid="primary-card-button-owned-project"]',
    );
    expect(card.getAttribute("aria-current")).toBe("page");
    expect(card.getAttribute("aria-describedby")).toBeNull();
    const emptyBinding = { ...binding, sessionLinePresent: false };
    expect(
      f.read({
        ...input,
        environmentId: null,
        projectId: null,
        threadId: null,
        sessionLinePresent: null,
      }),
    ).toEqual(emptyBinding);
    expect(f.read({ ...input, ...emptyBinding })).toEqual(emptyBinding);
    expect(f.read(input)).toBeNull();
    card.removeAttribute("aria-current");
    f.location.pathname = "/removed-remote/old-thread";
    expect(f.read({ ...input, ...emptyBinding })).toBeNull();
    expect(f.read({ ...input, ...emptyBinding, requireSelected: false })).toBe(true);
  } finally {
    await f.window.happyDOM.close();
  }
});

it("adds closed witness to the same read without accepting a refused branch or retaining private values", async () => {
  const f = fixture(false, true, true);
  try {
    const snapshot = {
      ...f.snapshot,
      threads: [{ ...f.snapshot.threads[0], branch: "private-branch" }],
    };
    const probe = publicThreadRead(f, snapshot);
    const proof = await probe.rawRead({ ...binding, snapshotPath: "/api/orchestration/snapshot" });
    expect(proof.matched).toBe(false);
    expect(probe.requests).toHaveLength(1);
    expect(proof.witness).toEqual({
      requestAdmitted: true,
      httpStatus: "success",
      body: "parsed",
      listsAdmitted: true,
      projectMatches: "one",
      threadMatches: "one",
      projectLive: true,
      threadProjectMatched: true,
      threadDefault: true,
      threadUnarchived: true,
      threadUndeleted: true,
      branchNull: false,
      expectedBranchMatched: false,
      worktreeNull: true,
    });
    expect(decodeReloadPrimaryThreadProof(proof)?.matched).toBe(false);
    expect(JSON.stringify(proof)).not.toMatch(/private|owned-project|owned-thread|localhost|http:/);
  } finally {
    await f.window.happyDOM.close();
  }
});

it("distinguishes HTTP refusal without reading its body and contains a throwing status observer", async () => {
  const f = fixture(false, true, true);
  const input = { ...binding, snapshotPath: "/api/orchestration/snapshot" };
  try {
    for (const [status, category] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not-found"],
      [409, "client-error"],
      [500, "server-error"],
      [302, "redirect"],
    ] as const) {
      const probe = publicThreadRead(f, f.snapshot, () => ({
        ok: false,
        status,
        text: () => {
          throw new Error("Refused body must not be read.");
        },
      }));
      const proof = await probe.rawRead(input);
      expect(proof.matched).toBe(false);
      expect(proof.witness.httpStatus).toBe(category);
      expect(proof.witness.body).toBeNull();
      expect(proof.witness.projectMatches).toBeNull();
      expect(probe.requests).toHaveLength(1);
    }
    const probe = publicThreadRead(f, f.snapshot, (response) => {
      Object.defineProperty(response, "status", {
        get() {
          throw new Error("private-status-error");
        },
      });
      return response;
    });
    const proof = await probe.rawRead(input);
    expect(proof.matched).toBe(true);
    expect(proof.witness.httpStatus).toBeNull();
    expect(proof.witness.body).toBe("parsed");
    expect(probe.requests).toHaveLength(1);
  } finally {
    await f.window.happyDOM.close();
  }
});

it("keeps unavailable parse/list/count/predicate observations unknown rather than inventing proof", async () => {
  const f = fixture(false, true, true);
  const input = { ...binding, snapshotPath: "/api/orchestration/snapshot" };
  try {
    const lists = await publicThreadRead(f, { projects: null, threads: [] }).rawRead(input);
    expect(lists.matched).toBe(false);
    expect(lists.witness.listsAdmitted).toBe(false);
    expect(lists.witness.projectMatches).toBeNull();
    const missing = await publicThreadRead(f, { projects: [], threads: [] }).rawRead(input);
    expect(missing.matched).toBe(false);
    expect(missing.witness.projectMatches).toBe("none");
    expect(missing.witness.threadMatches).toBe("none");
    expect(missing.witness.threadDefault).toBeNull();
    const duplicate = await publicThreadRead(f, {
      ...f.snapshot,
      threads: [f.snapshot.threads[0], f.snapshot.threads[0]],
    }).rawRead(input);
    expect(duplicate.matched).toBe(false);
    expect(duplicate.witness.threadMatches).toBe("multiple");
    expect(duplicate.witness.branchNull).toBeNull();
    expect(duplicate.witness.expectedBranchMatched).toBeNull();
    const thread = { ...f.snapshot.threads[0] };
    delete thread.branch;
    const absent = await publicThreadRead(f, { ...f.snapshot, threads: [thread] }).rawRead(input);
    expect(absent.matched).toBe(false);
    expect(absent.witness.branchNull).toBeNull();
    expect(absent.witness.expectedBranchMatched).toBeNull();
  } finally {
    await f.window.happyDOM.close();
  }
});

it("projects only finite own witness data and contains malformed/accessor/reflection facts", () => {
  const raw = {
    requestAdmitted: true,
    httpStatus: "success",
    branchNull: false,
    private: "private-secret",
  };
  const projected = projectReloadPrimaryThreadWitness(raw)!;
  expect(projected.requestAdmitted).toBe(true);
  expect(projected.branchNull).toBe(false);
  expect(projected.projectMatches).toBeNull();
  expect(JSON.stringify(projected)).not.toMatch(/private|secret/);
  expect(projectReloadPrimaryThreadWitness(Object.create(raw))?.requestAdmitted).toBeNull();
  for (const key of Object.keys(projected)) {
    let reads = 0;
    const input = { ...raw };
    Object.defineProperty(input, key, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("private-getter");
      },
    });
    expect(projectReloadPrimaryThreadWitness(input)).toBeNull();
    expect(reads).toBe(0);
  }
  for (const key of ["matched", "witness"]) {
    let reads = 0;
    const input = { matched: true, witness: raw };
    Object.defineProperty(input, key, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("private-getter");
      },
    });
    expect(decodeReloadPrimaryThreadProof(input)).toEqual(
      key === "matched" ? null : { matched: true, witness: null },
    );
    expect(reads).toBe(0);
  }
  const revoked = Proxy.revocable(raw, {});
  revoked.revoke();
  expect(projectReloadPrimaryThreadWitness(revoked.proxy)).toBeNull();
  expect(decodeReloadPrimaryThreadProof(revoked.proxy)).toBeNull();
  const brokenWitness = new Proxy(
    { matched: false, witness: raw },
    {
      getOwnPropertyDescriptor(target, key) {
        if (key === "witness") throw new Error("private-reflection-error");
        return Object.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  expect(decodeReloadPrimaryThreadProof(brokenWitness)).toEqual({ matched: false, witness: null });
});

it("never binds an unbackfilled primary card that the production projection cannot select", async () => {
  const f = fixture(true, false);
  try {
    const card = f.window.document.querySelector(
      '[data-testid="primary-card-button-owned-project"]',
    );
    expect(card.getAttribute("aria-current")).toBeNull();
    expect(card.getAttribute("aria-describedby")).toBeNull();
    expect(
      f.read({
        ...input,
        environmentId: null,
        projectId: null,
        threadId: null,
        sessionLinePresent: null,
      }),
    ).toBeNull();
  } finally {
    await f.window.happyDOM.close();
  }
});

it("proves a current empty bound thread through the existing public read and refuses null-primary fallback", async () => {
  for (const existing of [true, false]) {
    const f = fixture(false, existing, true);
    try {
      const probe = publicThreadRead(f);
      const result = await probe.read({
        ...binding,
        sessionLinePresent: false,
        snapshotPath: "/api/orchestration/snapshot",
      });
      expect(result).toBe(existing);
      expect(probe.requests).toEqual([
        {
          url: "http://localhost:4887/api/orchestration/snapshot",
          credentials: "include",
          timeout: 10_000,
        },
      ]);
      expect(typeof result).toBe("boolean");
    } finally {
      await f.window.happyDOM.close();
    }
  }
});

it.each([null, "main"])(
  "refuses wrong, duplicated, deleted, archived or malformed proof with branch %s",
  async (branch) => {
    const f = fixture(false, true, true);
    try {
      const project = f.snapshot.projects[0]!,
        thread = { ...f.snapshot.threads[0]!, branch };
      for (const snapshot of [
        null,
        { projects: [], threads: [thread] },
        { projects: [project, project], threads: [thread] },
        { projects: [project], threads: [thread, thread] },
        { projects: [{ ...project, deletedAt: "deleted" }], threads: [thread] },
        ...[
          { id: "foreign-thread" },
          { projectId: "foreign-project" },
          { kind: "regular" },
          { archivedAt: "archived" },
          { deletedAt: "deleted" },
          { branch: "foreign-branch" },
          { branch: "MAIN" },
          { branch: "refs/heads/main" },
          { branch: "main\n" },
          { branch: "" },
          { branch: true },
          { branch: 1 },
          { branch: [] },
          { branch: {} },
          { worktreePath: "private-path" },
        ].map((change) => ({ projects: [project], threads: [{ ...thread, ...change }] })),
      ]) {
        const probe = publicThreadRead(f, snapshot);
        expect(await probe.read({ ...binding, snapshotPath: "/api/orchestration/snapshot" })).toBe(
          false,
        );
      }
      for (const input of [
        { ...binding, threadId: "invalid/thread" },
        Object.create(binding),
        { ...binding, sessionLinePresent: null },
      ]) {
        const probe = publicThreadRead(f);
        expect(await probe.read({ ...input, snapshotPath: "/api/orchestration/snapshot" })).toBe(
          false,
        );
        expect(probe.requests).toEqual([]);
      }
    } finally {
      await f.window.happyDOM.close();
    }
  },
);

it("refuses missing public properties and never admits legacy projection rows as aliases", async () => {
  const f = fixture(false, true, true);
  const proofInput = { ...binding, snapshotPath: "/api/orchestration/snapshot" };
  try {
    for (const [collection, fields] of [
      ["projects", ["id", "deletedAt"]],
      ["threads", ["id", "projectId", "kind", "archivedAt", "deletedAt", "branch", "worktreePath"]],
    ] as const) {
      for (const field of fields) {
        const snapshot = {
          projects: f.snapshot.projects.map((row) => ({ ...row })),
          threads: f.snapshot.threads.map((row) => ({ ...row })),
        };
        delete snapshot[collection][0]![field];
        expect(await publicThreadRead(f, snapshot).read(proofInput)).toBe(false);
      }
    }
    const legacyProjection = {
      projects: [{ project_id: binding.projectId, deleted_at: null }],
      threads: [
        {
          thread_id: binding.threadId,
          project_id: binding.projectId,
          kind: "default",
          archived_at: null,
          deleted_at: null,
          branch: null,
          worktree_path: null,
        },
      ],
    };
    expect(await publicThreadRead(f, legacyProjection).read(proofInput)).toBe(false);
  } finally {
    await f.window.happyDOM.close();
  }
});

it("refuses unsafe scope and failed/unbounded public reads without exposing response or exception text", async () => {
  const f = fixture(false, true, true);
  const proofInput = { ...binding, snapshotPath: "/api/orchestration/snapshot" };
  try {
    for (const outcome of [
      "unauthorized",
      "fetch-error",
      "body-error",
      "too-large",
      "invalid-json",
    ]) {
      const read = NodeVM.runInNewContext("(" + readReloadPrimaryThread.toString() + ")", {
        document: f.window.document,
        location: f.location,
        AbortSignal: { timeout: () => null },
        fetch: async () => {
          if (outcome === "fetch-error") throw new Error("private-secret");
          return {
            ok: outcome !== "unauthorized",
            text: async () => {
              if (outcome === "body-error") throw new Error("private-secret");
              return outcome === "too-large" ? "x".repeat(2 * 1024 * 1024 + 1) : "private-secret";
            },
          };
        },
      });
      expect((await read(proofInput)).matched).toBe(false);
    }
    for (const field of Object.keys(binding)) {
      const probe = publicThreadRead(f);
      const input = { ...proofInput };
      let reads = 0;
      Object.defineProperty(input, field, {
        enumerable: true,
        get() {
          reads++;
          throw new Error("private-secret");
        },
      });
      expect(await probe.read(input)).toBe(false);
      expect(probe.requests).toEqual([]);
      expect(reads).toBe(0);
    }
    for (const location of [
      { origin: "http://private-host", search: "", hash: "" },
      { origin: "http://localhost:4901", search: "?private-secret", hash: "" },
      { origin: "http://localhost:4901", search: "", hash: "#private-secret" },
    ]) {
      Object.assign(f.location, location);
      const probe = publicThreadRead(f);
      expect(await probe.read(proofInput)).toBe(false);
      expect(probe.requests).toEqual([]);
    }
  } finally {
    await f.window.happyDOM.close();
  }
});

it("binds the real active primary-card markup and accepts only its stored route/identity", async () => {
  const f = fixture();
  try {
    const initial = f.read({
      ...input,
      environmentId: null,
      projectId: null,
      threadId: null,
      sessionLinePresent: null,
    });
    expect(initial).toEqual(binding);
    expect(decodeReloadPrimaryWorkspace(initial, binding)).toEqual(binding);
    expect(f.read(input)).toEqual(binding);
    for (const field of Object.keys(binding))
      expect(f.read({ ...input, [field]: "foreign" })).toBeNull();
  } finally {
    await f.window.happyDOM.close();
  }
});

it("admits only a rendered existing bound card as a candidate and never creates a default thread", async () => {
  for (const existing of [false, true]) {
    const f = fixture(false, existing);
    try {
      expect(f.read(input)).toBeNull();
      expect(f.read({ ...input, requireSelected: false })).toBe(existing ? true : null);
      expect(
        f.read({
          ...input,
          environmentId: null,
          projectId: null,
          threadId: null,
          sessionLinePresent: null,
          requireSelected: false,
        }),
      ).toBeNull();
    } finally {
      await f.window.happyDOM.close();
    }
  }
});

it("refuses unsafe location, missing/duplicate card, foreign project header and lost session proof", async () => {
  for (const mode of [
    "origin",
    "search",
    "hash",
    "route",
    "rail",
    "missing",
    "duplicate",
    "header",
    "session",
  ]) {
    const f = fixture();
    try {
      const card = f.window.document.querySelector(
        '[data-testid="primary-card-button-owned-project"]',
      );
      if (mode === "origin") f.location.origin = "http://private-host";
      if (mode === "search") f.location.search = "?private-credential";
      if (mode === "hash") f.location.hash = "#private-credential";
      if (mode === "route") f.location.pathname = "/primary/foreign-thread";
      if (mode === "rail")
        f.window.document
          .querySelector('[data-testid="environment-rail-local"]')
          .setAttribute("aria-checked", "false");
      if (mode === "missing") card.remove();
      if (mode === "duplicate") f.window.document.body.append(card.cloneNode(true));
      if (mode === "header")
        f.window.document.querySelector('[data-sidebar="menu-button"]').textContent =
          "Foreign project";
      if (mode === "session") card.removeAttribute("aria-describedby");
      expect(f.read(input), mode).toBeNull();
    } finally {
      await f.window.happyDOM.close();
    }
  }
});

it("reads only own enumerable identity data and refuses malformed/foreign/throwing bindings", () => {
  expect(decodeReloadPrimaryWorkspace(binding)).toEqual(binding);
  for (const raw of [
    null,
    undefined,
    [],
    "private",
    Object.create(binding),
    { ...binding, threadId: "invalid/thread" },
    { ...binding, environmentId: "foreign" },
  ])
    expect(decodeReloadPrimaryWorkspace(raw, binding)).toBeNull();
  for (const field of Object.keys(binding)) {
    let reads = 0;
    const getter = { ...binding };
    Object.defineProperty(getter, field, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("private getter");
      },
    });
    expect(decodeReloadPrimaryWorkspace(getter)).toBeNull();
    expect(decodeReloadPrimaryWorkspace(binding, getter)).toBeNull();
    expect(reads).toBe(0);
  }
  const revoked = Proxy.revocable(binding, {});
  revoked.revoke();
  expect(decodeReloadPrimaryWorkspace(revoked.proxy)).toBeNull();
});

it("refuses an inactive duplicate of the selected bound card at capture and reselection", async () => {
  const f = fixture();
  try {
    const duplicate = f.window.document
      .querySelector('[data-testid="primary-card-button-owned-project"]')
      .cloneNode(true);
    duplicate.removeAttribute("aria-current");
    f.window.document.body.append(duplicate);
    expect(
      f.read({
        ...input,
        environmentId: null,
        projectId: null,
        threadId: null,
        sessionLinePresent: null,
      }),
    ).toBeNull();
    expect(f.read(input)).toBeNull();
    expect(f.read({ ...input, requireSelected: false })).toBeNull();
  } finally {
    await f.window.happyDOM.close();
  }
});

it.each(["input-and-change", "change-only"])(
  "runs the actual primary import typing against the controlled host-path form: %s",
  async (clearEvents) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const hostPathModule = "../../../web/src/components/add-project/AddProjectSteps.tsx";
    const workflowModule = "../../../web/src/components/add-project/useAddProjectWorkflow.ts";
    const { AddProjectHostPathStep } = await import(hostPathModule);
    const { useAddProjectWorkflowState } = await import(workflowModule);
    const { createRoot } = webRequire("react-dom/client");
    const { act, createElement, useState } = React;
    const expected = "/owned/dark/project with spaces";
    const submitted: string[] = [];
    const host = {
      environmentId: "primary",
      label: "Owned host",
      platform: "Linux",
      baseDirectory: "/owned/initial",
      isPrimary: true,
      desktopInstanceId: null,
      nativePickerAvailable: false,
    };
    function Harness() {
      const [closed, setClosed] = useState(false);
      const state = useAddProjectWorkflowState({
        open: !closed,
        onOpenChange: (open: boolean) => setClosed(!open),
        hosts: [host] as any,
        locationLabel: "Host",
        primaryEnvironmentId: "primary" as any,
        initialEnvironmentId: null,
        operations: {
          addFolder: async (value: { workspaceRoot: string }) => {
            submitted.push(value.workspaceRoot);
            return value.workspaceRoot === expected;
          },
          clone: async () => ({ _tag: "Opened" as const }),
          create: async () => true,
          cancelClone: async () => ({ _tag: "Success" as const, value: { cancelled: true } }),
        } as any,
        pickFolder: async () => ({ _tag: "Cancelled" as const }),
      });
      return closed
        ? createElement("div", { "data-testid": "composer-editor" })
        : createElement(AddProjectHostPathStep, {
            hostLabel: "Owned host",
            path: state.hostPath,
            platform: "Linux",
            busy: state.busy,
            error: state.error,
            onPathChange: state.setHostPath,
            onSubmit: () => void state.submitHostPath(),
          });
    }
    const desktop = NodeModule.createRequire(
      new NodeURL.URL("../../package.json", import.meta.url),
    );
    const sdkSource = NodeFS.readFileSync(
      NodePath.join(NodePath.dirname(desktop.resolve("webdriverio")), "node.js"),
      "utf8",
    );
    const cut = (name: string, async: boolean) => {
      const start = sdkSource.indexOf(`${async ? "async " : ""}function ${name}(`);
      const end = sdkSource.indexOf("\n//", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      return sdkSource.slice(start, end);
    };
    const sdk = NodeVM.runInNewContext(
      cut("clearValue", false) +
        cut("addValue", false) +
        cut("setValue", true) +
        "\n({clearValue, addValue, setValue})",
      { VALID_TYPES: ["string", "number"] },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const field = () => document.querySelector<HTMLInputElement>("#add-project-host-path")!;
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    let clears = 0,
      types = 0,
      clicks = 0;
    const input = {
      elementId: "owned-primary-path",
      clearValue: () => sdk.clearValue.call(input),
      addValue: (value: string) => sdk.addValue.call(input, value),
      elementClear: async () => {
        clears++;
        await act(async () => field().focus());
        await act(async () => {
          nativeValue.call(field(), "");
          if (clearEvents === "input-and-change")
            field().dispatchEvent(new Event("input", { bubbles: true }));
          field().dispatchEvent(new Event("change", { bubbles: true }));
        });
        await act(async () => field().blur());
      },
      elementSendKeys: async (_id: string, value: string) => {
        types++;
        await act(async () => field().focus());
        await act(async () => {
          nativeValue.call(field(), field().value + value);
          field().dispatchEvent(new Event("input", { bubbles: true }));
        });
      },
    };
    const browser = {
      $$: () => ({
        length: Promise.resolve(document.querySelectorAll("#add-project-host-path").length),
      }),
      $: (selector: string) =>
        selector === "#add-project-host-path"
          ? {
              elementId: "owned-primary-path",
              waitForDisplayed: async () => expect(field()).toBeInstanceOf(HTMLInputElement),
              setValue: (value: string) => sdk.setValue.call(input, value),
              getValue: async () => field().value,
              isFocused: async () => document.activeElement === field(),
            }
          : {
              waitForDisplayed: async () =>
                expect(document.querySelector('[data-testid="composer-editor"]')).not.toBeNull(),
            },
    };
    const source = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-remote-updates.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf('  primaryPhase("primary-import-path-input");');
    const end = source.indexOf("  if (host.devUrl) primaryImportExpectedPath = null;", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){ let primaryImportExpectedPath = null;" +
          source.slice(start, end) +
          "}\nrun",
      ),
      {
        host: { devUrl: "http://owned.invalid", project: expected },
        primaryPhase: () => {},
        required: () => browser,
        owner: { until: async (check: () => Promise<boolean>) => expect(await check()).toBe(true) },
        composer: '[data-testid="composer-editor"]',
        click: async (selector: string) => {
          expect(selector).toBe("button=Open project");
          clicks++;
          await act(async () => {
            const form = field().form!;
            form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          });
        },
      },
    );
    try {
      await act(async () => root.render(createElement(Harness, {})));
      await run();
      expect(submitted).toEqual([expected]);
      expect({ clears, types, clicks }).toEqual({ clears: 1, types: 1, clicks: 1 });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  "matched",
  "mismatched",
  "focus-lost",
  "stale",
  "duplicate",
  "read-failed",
  "malformed-id",
  "malformed-value",
])(
  "refuses primary import submission until the same focused path has its owned value: %s",
  async (mode) => {
    const expected = "/owned/dark/project with spaces";
    const original = new Error("Inert owned path read failed.");
    const calls: string[] = [];
    const field = {
      elementId: mode === "malformed-id" ? null : "owned-path",
      waitForDisplayed: async () => {},
      setValue: async () => calls.push("type"),
      isFocused: async () => mode !== "focus-lost",
      getValue: async () => {
        if (mode === "read-failed") throw original;
        return mode === "malformed-value"
          ? { value: expected }
          : mode === "mismatched"
            ? "/owned/unexpected"
            : expected;
      },
    };
    const browser = {
      $: (selector: string) =>
        selector === "#add-project-host-path"
          ? mode === "stale" && calls.length
            ? { ...field, elementId: "replacement-path" }
            : field
          : { waitForDisplayed: async () => {} },
      $$: () => ({ length: Promise.resolve(mode === "duplicate" ? 2 : 1) }),
    };
    const source = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-remote-updates.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf('  primaryPhase("primary-import-path-input");');
    const end = source.indexOf("  if (host.devUrl) primaryImportExpectedPath = null;", start);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){ let primaryImportExpectedPath = null;" +
          source.slice(start, end) +
          "}\nrun",
      ),
      {
        host: { devUrl: "http://owned.invalid", project: expected },
        primaryPhase: () => {},
        required: () => browser,
        composer: "owned-composer",
        click: async () => calls.push("submit"),
        owner: {
          until: async (check: () => Promise<boolean>) => {
            for (let i = 0; i < 2; i++) if (await check()) return;
            throw new Error("Inert owned path admission did not arrive.");
          },
        },
      },
    );
    const error = await run().catch((value: unknown) => value);
    if (mode === "matched") {
      expect(error).toBeUndefined();
      expect(calls).toEqual(["type", "submit"]);
    } else {
      if (mode === "read-failed") expect(error).toBe(original);
      else expect(error).toBeDefined();
      expect(calls).toEqual(["type"]);
    }
  },
);

it("corrects the actual content viewport before admitting the primary import", async () => {
  const { correctDesktopUiOuterSize } = await import("./window-size.ts");
  const { readVisualViewport } = await import("./release-visual-observation.ts");
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../qualify-remote-updates.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf('    phase("primary-pair-wait-sidebar");');
  const end = source.indexOf("    let primaryWorkspace:", start);
  const sizes: unknown[] = [];
  const viewport = { width: 1280, height: 817, devicePixelRatio: 1 };
  const browser = {
    $: () => ({ waitForDisplayed: async () => {} }),
    getWindowSize: async () => ({ width: 1280, height: 960 }),
    setWindowSize: async (width: number, height: number) => {
      sizes.push({ width, height });
      viewport.width = width;
      viewport.height = height - 143;
    },
    execute: async (read: () => unknown) =>
      NodeVM.runInNewContext("(" + read.toString() + ")()", {
        innerWidth: viewport.width,
        innerHeight: viewport.height,
        devicePixelRatio: 1,
      }),
  };
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes("async function run(){" + source.slice(start, end) + "}\nrun"),
    {
      phase: () => {},
      browser,
      primary: {},
      bounded: async (value: Promise<unknown>, timeout: number) => {
        expect(timeout).toBe(2000);
        return value;
      },
      owner: { until: async (check: () => Promise<boolean>) => expect(await check()).toBe(true) },
      correctDesktopUiOuterSize,
      readVisualViewport,
      importProject: async () =>
        expect(viewport).toEqual({ width: 1280, height: 960, devicePixelRatio: 1 }),
    },
  );
  await run();
  expect(sizes).toEqual([{ width: 1280, height: 1103 }]);
});

it.each([817, 960])(
  "admits only approved screenshot content height before writing originals: %s",
  async (height) => {
    const source = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-remote-updates.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("  const proof = validateCaptureWitness(witness);");
    const end = source.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const written: unknown[] = [];
    const captures: unknown[] = [];
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){" + source.slice(start, end) + "}\nrun",
      ),
      {
        validateCaptureWitness: () => ({}),
        witness: {},
        Buffer,
        required: () => ({
          takeScreenshot: async () => Buffer.from("owned-inert-image").toString("base64"),
        }),
        bounded: async (value: Promise<unknown>) => value,
        inspectScreenshot: () => ({ width: 1280, height, nonBlank: true, sha256: "owned-hash" }),
        screenshotName: () => "owned-light.png",
        currentTheme: "light",
        scene: "owned",
        check: (value: boolean) => {
          if (!value) throw new Error("Inert approved viewport refusal.");
        },
        NodeFS: { writeFileSync: () => written.push(true) },
        NodePath,
        evidence: "/owned/inert",
        captures,
        assertions: [],
        write: () => {},
      },
    );
    const error = await run().catch((value: unknown) => value);
    if (height === 960) {
      expect(error).toBeUndefined();
      expect(written).toHaveLength(1);
      expect(captures).toHaveLength(1);
    } else {
      expect(error).toBeDefined();
      expect(written).toHaveLength(0);
      expect(captures).toHaveLength(0);
    }
  },
);
