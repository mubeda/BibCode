// @effect-diagnostics nodeBuiltinImport:off - Inert DOM/card and public-reader replay only.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import {
  decodeReloadPrimaryWorkspace,
  decodeReloadPrimaryThreadProof,
  projectReloadPrimaryThreadWitness,
  readReloadPrimaryThread,
  readReloadPrimaryWorkspace,
} from "./remote-ui-primary-workspace.ts";

const webRequire = NodeModule.createRequire(new URL("../../../web/package.json", import.meta.url));
const { transformSync } = NodeModule.createRequire(webRequire.resolve("vite-plus"))("esbuild");
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const { Window } = webRequire("happy-dom");
const cardModule = { exports: {} as Record<string, any> };
NodeVM.runInNewContext(
  transformSync(
    NodeFS.readFileSync(
      new URL("../../../web/src/components/sidebar/WorkspaceCard.tsx", import.meta.url),
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
  const source = NodeFS.readFileSync(new URL("../../../web/src/" + file, import.meta.url), "utf8");
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
  new URL("../../../web/src/components/Sidebar.tsx", import.meta.url),
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

const storedProjectionFixture = JSON.parse(
  NodeFS.readFileSync(
    new URL(
      "../../../../packages/contracts/fixtures/persistence/current-v33/snapshot.json",
      import.meta.url,
    ),
    "utf8",
  ),
).tables;

function rawSerializeFields(file: string, name: string) {
  const source = NodeFS.readFileSync(
    new URL("../../../server/src/" + file, import.meta.url),
    "utf8",
  );
  const declaration = source.match(
    new RegExp("#\\[derive\\(([^\\n]*)\\)\\]\\s*pub struct " + name + " \\{([\\s\\S]*?)\\n\\}"),
  );
  expect(declaration).not.toBeNull();
  expect(declaration![1]).toMatch(/\bSerialize\b/);
  expect(declaration![2]).not.toContain("#[serde");
  return Array.from(declaration![2]!.matchAll(/^\s*pub (\w+): ([^,\n]+),$/gm), (field) => ({
    name: field[1]!,
    type: field[2]!,
  }));
}

function rawProjectionRow(
  name: "ProjectionProject" | "ProjectionThread",
  changes: Record<string, unknown>,
) {
  const table = name === "ProjectionProject" ? "projection_projects" : "projection_threads";
  const stored = { ...storedProjectionFixture[table][0], ...changes };
  // Mirror current unrenamed Serialize fields; decode JSON columns as the real row decoder does.
  return Object.fromEntries(
    rawSerializeFields("persistence/repositories.rs", name).map((field) => {
      if (Object.hasOwn(stored, field.name)) return [field.name, stored[field.name]];
      if (Object.hasOwn(stored, field.name + "_json"))
        return [field.name, JSON.parse(stored[field.name + "_json"])];
      if (field.type.startsWith("Option<")) return [field.name, null];
      if (field.type === "i64") return [field.name, 0];
      expect(field.type).toBe("Value");
      return [field.name, {}];
    }),
  );
}

function rawHttpSnapshot(existing: boolean) {
  return Object.fromEntries(
    rawSerializeFields("orchestration/engine.rs", "Snapshot").map((field) => [
      field.name,
      field.name === "projects"
        ? [
            rawProjectionRow("ProjectionProject", {
              project_id: binding.projectId,
              deleted_at: null,
            }),
          ]
        : field.name === "threads" && existing
          ? [
              rawProjectionRow("ProjectionThread", {
                thread_id: binding.threadId,
                project_id: binding.projectId,
                kind: "default",
                branch: null,
                worktree_path: null,
                latest_turn_id: null,
                archived_at: null,
                deleted_at: null,
                pending_approval_count: 0,
                pending_user_input_count: 0,
                has_actionable_proposed_plan: 0,
              }),
            ]
          : [],
    ]),
  ) as { projects: Record<string, unknown>[]; threads: Record<string, unknown>[] };
}

it("takes HTTP fixture names from the actual unrenamed projection serializer, not the RPC contract", () => {
  const runtime = NodeFS.readFileSync(
    new URL("../../../server/src/production/runtime.rs", import.meta.url),
    "utf8",
  );
  const producer = runtime.slice(
    runtime.indexOf("JsonOperation::OrchestrationSnapshot =>"),
    runtime.indexOf("JsonOperation::OrchestrationDispatch =>"),
  );
  expect(producer).toContain("load_snapshot(&self.orchestration.repositories())");
  expect(producer).toContain("serde_json::to_value(snapshot)");
  const snapshot = rawHttpSnapshot(true);
  expect(snapshot.projects[0]).toMatchObject({ project_id: binding.projectId, deleted_at: null });
  expect(snapshot.threads[0]).toMatchObject({
    thread_id: binding.threadId,
    project_id: binding.projectId,
    kind: "default",
    archived_at: null,
    deleted_at: null,
    worktree_path: null,
  });
  expect(snapshot.projects[0]).not.toHaveProperty("id");
  expect(snapshot.threads[0]).not.toHaveProperty("id");
  expect(snapshot.threads[0]).not.toHaveProperty("projectId");
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
    snapshot: rawHttpSnapshot(existing),
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
    const thread = { ...f.snapshot.threads[0] };
    delete thread.branch;
    const absent = await publicThreadRead(f, { ...f.snapshot, threads: [thread] }).rawRead(input);
    expect(absent.matched).toBe(false);
    expect(absent.witness.branchNull).toBeNull();
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

it("refuses wrong, duplicated, deleted, archived or malformed public project/thread proof", async () => {
  const f = fixture(false, true, true);
  try {
    const project = f.snapshot.projects[0]!,
      thread = f.snapshot.threads[0]!;
    for (const snapshot of [
      null,
      { projects: [], threads: [thread] },
      { projects: [project, project], threads: [thread] },
      { projects: [project], threads: [thread, thread] },
      { projects: [{ ...project, deleted_at: "deleted" }], threads: [thread] },
      ...[
        { thread_id: "foreign-thread" },
        { project_id: "foreign-project" },
        { kind: "regular" },
        { archived_at: "archived" },
        { deleted_at: "deleted" },
        { branch: "foreign-branch" },
        { worktree_path: "private-path" },
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
});

it("refuses missing raw projection properties and never admits the camelCase contract as an alias", async () => {
  const f = fixture(false, true, true);
  const proofInput = { ...binding, snapshotPath: "/api/orchestration/snapshot" };
  try {
    for (const [collection, fields] of [
      ["projects", ["project_id", "deleted_at"]],
      [
        "threads",
        ["thread_id", "project_id", "kind", "archived_at", "deleted_at", "branch", "worktree_path"],
      ],
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
    const desiredContract = {
      projects: [{ id: binding.projectId, deletedAt: null }],
      threads: [
        {
          id: binding.threadId,
          projectId: binding.projectId,
          kind: "default",
          archivedAt: null,
          deletedAt: null,
          branch: null,
          worktreePath: null,
        },
      ],
    };
    expect(await publicThreadRead(f, desiredContract).read(proofInput)).toBe(false);
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
