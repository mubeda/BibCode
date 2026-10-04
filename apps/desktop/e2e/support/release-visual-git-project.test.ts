// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Real card/reader execution with inert public-operation ports; no runtime launches.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as GitProject from "./release-visual-git-project.ts";
import { QualificationOwner } from "./qualification-owner.ts";
import { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  gitProjectVisualScenes,
  gitProjectVisualScreenshotName,
  validateGitProjectVisualWitness,
  projectGitProjectVisualCapture,
  captureGitProjectVisualScene,
  readGitProjectVisualWitness,
  runGitProjectVisual,
} from "./release-visual-git-project.ts";

// This unrelated icon module imports application connection state; the card's
// actual shell, branch line and UI primitives remain real.
vi.mock("../../../web/src/components/ThreadStatusIndicators.tsx", () => ({
  ChangeRequestStatusIcon: () => null,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

async function mountedNoRepositoryCard(theme: "light" | "dark") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const webRequire = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"));
  const { act, createElement } = webRequire("react") as {
    act: (run: () => void | Promise<void>) => Promise<void>;
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown;
  };
  const { createRoot } = webRequire("react-dom/client") as {
    createRoot: (container: Element) => { render: (node: unknown) => void; unmount: () => void };
  };
  const cardModule = "../../../web/src/components/sidebar/WorkspaceCard.tsx";
  const unavailableModule =
    "../../../web/src/components/gitManager/GitManagerRepositoryUnavailable.tsx";
  const { WorkspaceCardShell, WorkspaceCardBranchLine, workspaceCardIds } = await import(
    cardModule
  );
  const { GitManagerRepositoryUnavailable } = await import(unavailableModule);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const input = {
    scene: "git-no-repository" as const,
    coverage: "complete" as const,
    theme,
    origin: "http://127.0.0.1:4885",
    selection: {
      projectId: "owned-ordinary",
      threadId: "owned-default",
      environmentId: "primary",
      cwd: "/owned/visual-git-project/ordinary",
      branch: null,
      title: "ordinary",
    },
    directory: "/owned/visual-git-project/ordinary/nested",
    cloneUrl: "https://visual.invalid/visual-origin.git",
    cloneParent: "/owned/visual-git-project/clone-parent",
  };
  const noop = () => {};
  try {
    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(
            "div",
            { "data-testid": "environment-rail-local", "aria-checked": "true" },
            createElement("i", { "data-status": "connected" }),
          ),
          createElement(
            "ul",
            null,
            createElement(
              WorkspaceCardShell,
              {
                testId: "primary-card-owned-ordinary",
                buttonTestId: "primary-card-button-owned-ordinary",
                className: "",
                idBase: "owned-card",
                isActive: true,
                hasFlags: false,
                hasBranchLine: true,
                hasSessionLine: false,
                status: { kind: "idle", label: "No agent started", colorClass: "" },
                onClick: noop,
                onContextMenu: noop,
                onButtonKeyDown: noop,
              },
              createElement(WorkspaceCardBranchLine, {
                id: workspaceCardIds("owned-card").branch,
                branch: null,
                branchTooltip: null,
                notice: {
                  label: "Not a Git repository",
                  description: "This folder isn't a Git repository. Run git init to create one.",
                },
              }),
            ),
          ),
          createElement(
            "div",
            { "data-testid": "git-manager-environment" },
            createElement("span", {
              "data-testid": "git-manager-project",
              title: input.selection.cwd,
            }),
          ),
          createElement(
            "div",
            { role: "tabpanel" },
            createElement(GitManagerRepositoryUnavailable, {
              title: "Repository unavailable",
              reason: "absent",
              cwd: input.selection.cwd,
              retrying: false,
              onRetry: noop,
            }),
          ),
        ),
      );
    });
    vi.stubGlobal("location", {
      origin: input.origin,
      pathname: "/project/primary/owned-ordinary/git",
      search: "",
      hash: "",
    });
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 960);
    document.documentElement.classList.toggle("dark", theme === "dark");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 10, 500, 300),
    );
    vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
      container.querySelector('[role="tabpanel"]'),
    );
    return {
      input,
      container,
      close: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  } catch (error) {
    await act(async () => root.unmount());
    container.remove();
    throw error;
  }
}

it.each(["light", "dark"] as const)(
  "reads the real sibling sidebar notice and accessible reason for %s no-repository capture",
  async (theme) => {
    const page = await mountedNoRepositoryCard(theme);
    try {
      const button = page.container.querySelector(
        '[data-testid="primary-card-button-owned-ordinary"]',
      )!;
      expect(button.textContent).toBe("");
      const witness = readGitProjectVisualWitness(page.input);
      expect(witness?.sidebarReason).toBe(true);
      expect(witness?.sameReason).toBe(true);
      expect(validateGitProjectVisualWitness("git-no-repository", "complete", witness)).toEqual({
        ...common,
        sidebarReason: true,
        tabReason: true,
        sameReason: true,
      });
      expect(JSON.stringify(witness)).not.toMatch(/owned|4885|ordinary|repository|git init/);
    } finally {
      await page.close();
    }
  },
);

it.each([
  "wrong-label",
  "wrong-description",
  "hidden-notice",
  "missing-description",
  "foreign-description",
  "duplicate-owned-card",
  "wrong-panel-reason",
] as const)("refuses the real no-repository card after %s", async (failure) => {
  const page = await mountedNoRepositoryCard("light");
  try {
    const card = page.container.querySelector('[data-testid="primary-card-owned-ordinary"]')!;
    const notice = card.querySelector('[data-slot="tooltip-trigger"][aria-hidden]')!;
    const description = card.querySelector(".sr-only")!;
    if (failure === "wrong-label") notice.textContent = "Repository unreadable";
    if (failure === "wrong-description")
      description.textContent = "Git can't read this repository.";
    if (failure === "hidden-notice") (notice as HTMLElement).style.display = "none";
    if (failure === "missing-description") description.remove();
    if (failure === "foreign-description") {
      const foreign = card.cloneNode(true) as HTMLElement;
      foreign.setAttribute("data-testid", "primary-card-foreign");
      foreign.querySelector("button")!.setAttribute("data-testid", "primary-card-button-foreign");
      page.container.append(foreign);
      description.remove();
    }
    if (failure === "duplicate-owned-card") page.container.append(card.cloneNode(true));
    if (failure === "wrong-panel-reason")
      page.container.querySelector('[role="alert"]')!.textContent =
        "Git can't read this repository.";
    expect(() =>
      validateGitProjectVisualWitness(
        "git-no-repository",
        "complete",
        readGitProjectVisualWitness(page.input),
      ),
    ).toThrow();
  } finally {
    await page.close();
  }
});

it("retains all eleven approved scene identities and refuses unrelated capture names", () => {
  expect(gitProjectVisualScenes).toEqual([
    "worktree-discovery",
    "project-open-directory",
    "project-clone-chooser",
    "project-clone-incomplete",
    "git-tags",
    "git-switch-with-changes",
    "git-merge-conflict",
    "git-rewrite-preview",
    "git-unborn",
    "git-no-repository",
    "git-broken-recovery",
  ]);
  expect(gitProjectVisualScreenshotName("git-tags", "dark")).toBe("git-tags-dark.png");
  for (const [scene, theme] of [
    ["../private", "light"],
    ["git-tags", "../private"],
  ])
    expect(() => gitProjectVisualScreenshotName(scene!, theme!)).toThrow();
});

const common = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: true,
  targetInView: true,
  credentialAbsent: true,
  bootShellAbsent: true,
};
const tagFacts = {
  ...common,
  localTags: true,
  remoteTags: true,
  tagNames: true,
  disabledTagActions: true,
};
it("requires every approved tag fact for complete coverage and labels partial groups/names separately", () => {
  expect(validateGitProjectVisualWitness("git-tags", "complete", tagFacts)).toEqual(tagFacts);
  expect(() =>
    validateGitProjectVisualWitness("git-tags", "complete", {
      ...tagFacts,
      disabledTagActions: false,
    }),
  ).toThrow();
  const { disabledTagActions: _, ...partial } = tagFacts;
  expect(validateGitProjectVisualWitness("git-tags", "groups-and-names-only", partial)).toEqual(
    partial,
  );
  expect(() =>
    validateGitProjectVisualWitness("git-unborn", "groups-and-names-only", partial),
  ).toThrow();
  for (const field of Object.keys(tagFacts)) {
    expect(() =>
      validateGitProjectVisualWitness("git-tags", "complete", { ...tagFacts, [field]: false }),
    ).toThrow();
    const row = { ...tagFacts };
    Object.defineProperty(row, field, {
      get() {
        throw new Error("private getter");
      },
    });
    expect(() => validateGitProjectVisualWitness("git-tags", "complete", row)).toThrow();
  }
  const proxy = Proxy.revocable(tagFacts, {});
  proxy.revoke();
  expect(() => validateGitProjectVisualWitness("git-tags", "complete", proxy.proxy)).toThrow();
});

it("propagates first capture failure after genuine selection verification without proceeding to later scenes", async () => {
  const failure = new Error("capture refused");
  const order: string[] = [];
  const selected = {
    projectId: "owned-project",
    threadId: "owned-thread",
    environmentId: "primary",
    cwd: "/owned/visual-git-project/rich",
    branch: "main",
    title: "rich",
  };
  const fixture = { rich: selected.cwd };
  await expect(
    runGitProjectVisual({
      browser: {},
      owner: {},
      theme: "light",
      origin: "http://127.0.0.1:4885",
      fixture,
      step: (phase: string) => order.push(phase),
      selectProject: async (kind: string) => {
        order.push("select-" + kind);
        return selected;
      },
      verifyOwnedIdentity: async () => {
        order.push("verify-identity");
      },
      openHiddenWorktrees: async () => {
        order.push("show-hidden-worktrees");
      },
      capture: async (scene: string) => {
        order.push("capture-" + scene);
        throw failure;
      },
    } as never),
  ).rejects.toBe(failure);
  expect(order).toEqual([
    "select-rich",
    "verify-identity",
    "visual-git-project-worktree-discovery",
    "verify-identity",
    "capture-worktree-discovery",
  ]);
});

it("projects only owned original capture facts and refuses invented full coverage or private fields", () => {
  const record = {
    scene: "git-tags",
    coverage: "complete",
    theme: "light",
    file: "git-tags-light.png",
    witness: tagFacts,
    width: 1280,
    height: 960,
    nonBlank: true,
    sha256: "a".repeat(64),
  };
  expect(projectGitProjectVisualCapture(record)).toEqual(record);
  for (const mutation of [
    { file: "../private.png" },
    { width: 960 },
    { nonBlank: false },
    { sha256: "private-sha" },
    { privatePath: "/private" },
    { coverage: "full" },
    { witness: { ...tagFacts, credentialAbsent: false } },
  ])
    expect(() => projectGitProjectVisualCapture({ ...record, ...mutation })).toThrow();
  const getter = { ...record };
  Object.defineProperty(getter, "sha256", {
    enumerable: true,
    get() {
      throw new Error("private");
    },
  });
  expect(() => projectGitProjectVisualCapture(getter)).toThrow();
});

it("runs only the finite public sequence and keeps the partial/unbound rows unqualified", async () => {
  const captures: Array<[string, string]> = [];
  const actions: string[] = [];
  const values = new Map<string, string>();
  let tab = "History",
    broken = false;
  const fixture = {
    rich: "/owned/visual-git-project/rich",
    merge: "/owned/visual-git-project/merge",
    unborn: "/owned/visual-git-project/unborn",
    ordinary: "/owned/visual-git-project/ordinary",
    broken: "/owned/visual-git-project/broken",
    cloneParent: "/owned/visual-git-project/clone-parent",
    cloneUrl: "https://visual.invalid/visual-origin.git",
    verifyCloneAlias: async () => {
      actions.push("verify-private-alias");
    },
    verifyIncompleteRetained: () => {
      actions.push("verify-incomplete");
    },
    verifyDirtyRetained: async () => {
      actions.push("verify-dirty");
    },
    verifyMergeAborted: async () => {
      actions.push("verify-aborted");
    },
    breakMetadata: async () => {
      broken = true;
      actions.push("break-private-config");
    },
    restoreMetadata: async () => {
      broken = false;
      actions.push("restore-private-config");
    },
  };
  const element = (selector: string) => ({
    waitForExist: async () => {},
    waitForDisplayed: async () => {},
    waitForEnabled: async () => {},
    isFocused: async () => true,
    click: async () => {
      actions.push("click:" + selector);
      if (selector.includes('role="tab"')) {
        if (selector.includes('"Tags"')) tab = "Tags";
        if (selector.includes('"History"')) tab = "History";
      }
      if (selector.includes('title="Choose parent folder"'))
        values.set('[aria-label="Server directory path"]', fixture.cloneParent);
    },
    setValue: async (value: string) => {
      values.set(selector, value);
    },
    getValue: async () => values.get(selector),
    getText: async () =>
      selector === "[data-worktree-candidate-row]"
        ? "visual-discovered"
        : selector === '[role="tab"][aria-selected="true"]'
          ? tab
          : selector === '[role="tabpanel"]' && broken
            ? "Git can't read this repository."
            : "An incomplete clone exists at",
    isDisplayed: async () => true,
  });
  const result = await runGitProjectVisual({
    browser: { $: element, $$: () => ({ length: Promise.resolve(1) }), keys: async () => {} },
    owner: {
      until: async (read: () => Promise<boolean>) => {
        expect(await read()).toBe(true);
      },
      cleanup: async (_role: string, run: () => Promise<void>) => run(),
    },
    theme: "light",
    origin: "http://127.0.0.1:4885",
    fixture,
    step: () => {},
    selectProject: async (kind: string, cwd: string) => ({
      projectId: "owned-" + kind,
      threadId: "thread-" + kind,
      environmentId: "primary",
      cwd,
      branch: "main",
      title: kind,
    }),
    openHiddenWorktrees: async () => {
      actions.push("public-show-hidden");
    },
    verifyOwnedIdentity: async () => {},
    verifyNoCloneImport: async () => {
      actions.push("verify-no-clone-import");
    },
    capture: async (scene: string, _selection: unknown, coverage: string) => {
      captures.push([scene, coverage]);
    },
  } as never);
  expect(captures).toEqual([
    ["worktree-discovery", "complete"],
    ["project-open-directory", "complete"],
    ["project-clone-chooser", "complete"],
    ["project-clone-incomplete", "complete"],
    ["git-tags", "groups-and-names-only"],
    ["git-switch-with-changes", "complete"],
    ["git-merge-conflict", "complete"],
    ["git-unborn", "complete"],
    ["git-no-repository", "complete"],
    ["git-broken-recovery", "complete"],
  ]);
  expect(GitProject.projectGitProjectVisualAssertion("light", result)).toMatchObject({
    completeGroup: false,
    partialScenes: ["git-tags"],
  });
  expect(result).toMatchObject({
    completeGroup: false,
    partialScenes: ["git-tags"],
    cloneExecuted: false,
    noEditableCloneName: true,
    chooserRetained: true,
    dirtyWorkRetained: true,
    mergeAborted: true,
    brokenMetadataRestored: true,
    selectedTabRetained: true,
  });
  expect(actions.filter((value) => value.startsWith("click:"))).not.toContain(
    "click:button=Refresh",
  );
  expect(actions).toContain("verify-private-alias");
  expect(actions).toContain("restore-private-config");
  expect(actions.filter((value) => value === "verify-no-clone-import")).toHaveLength(2);
});

it.each(["owner-refused", "alert-open", "missing-fact"])(
  "refuses unsafe capture before screenshot or evidence writes: %s",
  async (mode) => {
    const evidence = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gp-cap-")),
    );
    const captured = new Set<string>();
    let screenshots = 0;
    const original = new Error("identity refused");
    try {
      const input = {
        scene: "git-tags",
        coverage: "complete",
        theme: "light",
        origin: "http://127.0.0.1:4885",
        selection: {
          projectId: "owned",
          threadId: "owned",
          environmentId: "primary",
          cwd: "/owned/rich",
          branch: "main",
          title: "rich",
        },
        directory: "/owned/ordinary/nested",
        cloneUrl: "https://visual.invalid/visual-origin.git",
        cloneParent: "/owned/clone-parent",
        evidence,
        captured,
        verifyOwnedIdentity: async () => {
          if (mode === "owner-refused") throw original;
        },
        browser: {
          isAlertOpen: async () => mode === "alert-open",
          execute: async () => ({ ...tagFacts, credentialAbsent: false }),
          takeScreenshot: async () => {
            screenshots++;
            return "";
          },
        },
        owner: {
          until: async (read: () => Promise<boolean>) => {
            if (!(await read())) throw original;
          },
        },
      };
      if (mode === "alert-open")
        await expect(captureGitProjectVisualScene(input as never)).rejects.toThrow();
      else await expect(captureGitProjectVisualScene(input as never)).rejects.toBe(original);
      expect(screenshots).toBe(0);
      expect(captured.size).toBe(0);
      expect(NodeFS.readdirSync(evidence)).toEqual([]);
    } finally {
      NodeFS.rmSync(evidence, { recursive: true, force: true });
    }
  },
);

it("rejects unrelated scene or origin before consulting any DOM", () => {
  expect(
    readGitProjectVisualWitness({
      scene: "git-tags",
      theme: "light",
      coverage: "complete",
      origin: "http://private-host",
    } as never),
  ).toBeNull();
  expect(
    readGitProjectVisualWitness({
      scene: "unrelated",
      theme: "light",
      coverage: "complete",
      origin: "http://127.0.0.1:4885",
    } as never),
  ).toBeNull();
});

// Source boundary: only the new fixed owner selection may use the existing public adapter.
it("requires the genuine snapshot adapter and closed incomplete-group projector", () => {
  expect(typeof Reflect.get(GitProject, "createGitProjectOwnerAdapters")).toBe("function");
  expect(typeof Reflect.get(GitProject, "projectGitProjectVisualAssertion")).toBe("function");
});

function adapterSnapshot(kind = "rich") {
  const contractsRequire = NodeModule.createRequire(
    NodePath.resolve("packages/contracts/package.json"),
  );
  const schema: { decodeUnknownSync: <A>(value: { readonly Type: A }) => (input: unknown) => A } =
    contractsRequire("effect/Schema");
  const timestamp = "2026-10-04T00:00:00.000Z";
  return schema.decodeUnknownSync(OrchestrationReadModel)({
    snapshotSequence: 0,
    updatedAt: timestamp,
    projects: [
      {
        id: "owned-project",
        title: kind,
        workspaceRoot: "/owned/visual-git-project/" + kind,
        defaultModelSelection: null,
        scripts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: "owned-thread",
        projectId: "owned-project",
        title: kind,
        kind: "default",
        modelSelection: { provider: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
        messages: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
  });
}
function actualOwnerAdapters(options: { kind?: string; fault?: string } = {}) {
  const kind = options.kind ?? "rich";
  let snapshot = adapterSnapshot(kind);
  const calls: string[] = [];
  let mounted = false,
    focused = false;
  const source = NodeFS.readFileSync(
    NodePath.resolve("apps/desktop/e2e/support/release-visual-git-project.ts"),
    "utf8",
  );
  const start = source.indexOf("export function createGitProjectOwnerAdapters(");
  const end = source.indexOf("/** Exact fixed incomplete-group result", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const create = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      source.slice(start, end).replace("export ", "") + "\ncreateGitProjectOwnerAdapters",
    ),
    {
      NodePath,
      refused: () => new Error("Visual Git/project precondition failed."),
      readGitProjectSelection: GitProject.readGitProjectSelection,
    },
  );
  const fixture = Object.fromEntries(
    ["rich", "merge", "unborn", "ordinary", "broken", "incomplete"].map((value) => [
      value,
      "/owned/visual-git-project/" + value,
    ]),
  );
  const input = {
    origin: "http://127.0.0.1:4885",
    fixture,
    importProject: async (
      cwd: string,
      bindSource?: () => Promise<GitProject.GitProjectVisualSelection>,
    ) => {
      expect(cwd).toBe(fixture[kind]);
      calls.push("import");
      if (bindSource) await bindSource();
      calls.push("model");
    },
    readSnapshot: async () => {
      calls.push("snapshot");
      if (options.fault === "duplicate-project")
        return { ...snapshot, projects: [...snapshot.projects, ...snapshot.projects] };
      if (options.fault === "duplicate-thread")
        return { ...snapshot, threads: [...snapshot.threads, ...snapshot.threads] };
      if (options.fault === "wrong-default")
        return {
          ...snapshot,
          threads: snapshot.threads.map((thread) => ({ ...thread, kind: "workspace" })),
        };
      return snapshot;
    },
    verifyServer: async () => {
      calls.push("server");
      if (options.fault === "server") throw new Error("source identity refused");
    },
    readBranch: (cwd: string) => {
      expect(cwd).toBe(fixture[kind]);
      calls.push("branch");
      return kind === "ordinary" ? null : "main";
    },
    verifySource: (selection: GitProject.GitProjectVisualSelection) => {
      expect(selection.cwd).toBe(fixture[kind]);
      calls.push("source");
      if (options.fault === "source") throw new Error("source identity refused");
    },
    owner: {
      until: async (read: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < 2; attempt++) if (await read()) return;
        throw new Error("Visual Git/project precondition failed.");
      },
    },
    browser: {
      $: (selector: string) => ({
        waitForExist: async () => {
          calls.push("exist:" + selector);
        },
        waitForDisplayed: async () => {
          mounted = true;
          calls.push("display:" + selector);
        },
        waitForEnabled: async () => {},
        click: async () => {
          calls.push("click:" + selector);
        },
        isFocused: async () => focused,
      }),
      $$: (_selector: string) => ({
        length: Promise.resolve(options.fault === "duplicate-control" ? 2 : mounted ? 1 : 0),
      }),
      keys: async (key: string) => {
        calls.push("key:" + key);
        if (key === "Tab") focused = true;
      },
      execute: async (
        reader: unknown,
        input: { origin: string; selection: GitProject.GitProjectVisualSelection },
      ) => {
        expect(reader).toBe(GitProject.readGitProjectSelection);
        expect(input.origin).toBe("http://127.0.0.1:4885");
        calls.push("public");
        return options.fault !== "selected";
      },
    },
  };
  return {
    adapter: create(input),
    calls,
    fixture,
    replaceSnapshot: (value: typeof snapshot) => {
      snapshot = value;
    },
    snapshot: () => snapshot,
  };
}
it("binds and verifies the imported source before model selection without duplicating the snapshot loop", async () => {
  const f = actualOwnerAdapters();
  await f.adapter.selectProject("rich", f.fixture.rich);
  expect(f.calls.indexOf("snapshot")).toBeLessThan(f.calls.indexOf("model"));
  expect(f.calls.indexOf("source")).toBeLessThan(f.calls.indexOf("model"));
  expect(f.calls.indexOf('click:[data-testid="primary-card-button-owned-project"]')).toBeLessThan(
    f.calls.indexOf("model"),
  );
  expect(f.calls.indexOf("public")).toBeLessThan(f.calls.indexOf("model"));
  expect(f.calls.filter((call) => call === "snapshot")).toHaveLength(2);
});
it.each(["duplicate-project", "duplicate-thread", "wrong-default", "source"])(
  "refuses ambiguous imported identity before model selection: %s",
  async (fault) => {
    const f = actualOwnerAdapters({ fault });
    await expect(f.adapter.selectProject("rich", f.fixture.rich)).rejects.toThrow();
    expect(f.calls).not.toContain("model");
  },
);
it("refuses stale other-primary selection before any model action", async () => {
  const f = actualOwnerAdapters({ fault: "selected" });
  await expect(f.adapter.selectProject("rich", f.fixture.rich)).rejects.toThrow();
  expect(f.calls).toContain("public");
  expect(f.calls).not.toContain("model");
});
it.each(["rich", "merge", "unborn", "ordinary", "broken"])(
  "binds real typed default-thread identity after async public mounting: %s",
  async (kind) => {
    const f = actualOwnerAdapters({ kind });
    const selected = await f.adapter.selectProject(kind, f.fixture[kind]);
    expect(selected).toEqual({
      environmentId: "local",
      projectId: "owned-project",
      threadId: "owned-thread",
      title: kind,
      cwd: f.fixture[kind],
      branch: kind === "ordinary" ? null : "main",
    });
    expect(f.calls.indexOf("import")).toBeLessThan(f.calls.indexOf("branch"));
    expect(f.calls.indexOf("source")).toBeLessThan(f.calls.indexOf("public"));
    await f.adapter.verifyOwnedIdentity(selected);
    await expect(f.adapter.verifyOwnedIdentity({ ...selected })).rejects.toThrow();
  },
);
it.each([
  "duplicate-project",
  "duplicate-thread",
  "wrong-default",
  "server",
  "source",
  "selected",
  "duplicate-control",
])("refuses an unproven real owner adapter before capture: %s", async (fault) => {
  const f = actualOwnerAdapters({ fault });
  await expect(f.adapter.selectProject("rich", f.fixture.rich)).rejects.toThrow();
  if (
    [
      "duplicate-project",
      "duplicate-thread",
      "wrong-default",
      "server",
      "duplicate-control",
    ].includes(fault)
  )
    expect(f.calls.some((call) => call.startsWith("click:"))).toBe(false);
});
it("opens the real hidden-worktree public project menu with owned focus and refuses false clone import", async () => {
  const f = actualOwnerAdapters();
  const selected = await f.adapter.selectProject("rich", f.fixture.rich);
  await f.adapter.openHiddenWorktrees(selected);
  expect(f.calls.filter((call) => call.startsWith("key:"))).toEqual(["key:Tab", "key:Enter"]);
  expect(f.calls.at(-1)).toContain("Show Hidden Worktrees");
  await f.adapter.verifyNoCloneImport();
  await f.adapter.verifyNoCloneImport();
  const snapshot = f.snapshot();
  f.replaceSnapshot({
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      workspaceRoot: "/owned/visual-git-project/incomplete",
    })),
  });
  await expect(f.adapter.verifyNoCloneImport()).rejects.toThrow();
});

function actualRestorationBoundary(mode: "success" | "restore-fails" | "both-fail") {
  const source = NodeFS.readFileSync(
    NodePath.resolve("apps/desktop/e2e/support/release-visual-git-project.ts"),
    "utf8",
  );
  const begin = source.indexOf('  const broken = await select("broken");');
  const end = source.indexOf("\nexport function projectGitProjectVisualCapture", begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const owner = new QualificationOwner("/owned/source", "/owned/fixture");
  const captureFailure = new Error("original capture failure");
  const restorationFailure = new Error("owned metadata restoration refused");
  let restoreAttempts = 0;
  const downstream: string[] = [];
  const selection = {
    projectId: "owned",
    threadId: "owned-thread",
    environmentId: "local",
    cwd: "/owned/broken",
    branch: "main",
    title: "broken",
  };
  const run: () => Promise<Record<string, unknown>> = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function lastScene() {" + source.slice(begin, end) + "\nlastScene",
    ),
    {
      select: async (kind: string) => {
        expect(kind).toBe("broken");
        return selection;
      },
      openGit: async (value: unknown) => {
        expect(value).toEqual(selection);
      },
      tab: async (name: string) => {
        expect(name).toBe("Tags");
      },
      fixture: {
        breakMetadata: async () => {},
        restoreMetadata: async () => {
          restoreAttempts++;
          if (mode !== "success") throw restorationFailure;
        },
      },
      input: {
        owner,
        verifyOwnedIdentity: async (value: unknown) => {
          expect(value).toEqual(selection);
          downstream.push("identity");
        },
      },
      browser: {
        $: (selector: string) => ({
          waitForDisplayed: async () => {
            downstream.push("retry-display");
          },
          isDisplayed: async () => {
            downstream.push("tags-display");
            return true;
          },
          getText: async () =>
            selector === '[role="tab"][aria-selected="true"]'
              ? "Tags"
              : "Git can't read this repository.",
        }),
      },
      click: async () => {},
      capture: async () => {
        if (mode === "both-fail") throw captureFailure;
      },
      gitProjectVisualScenes,
      completed: gitProjectVisualScenes.filter(
        (scene) => scene !== "git-tags" && scene !== "git-rewrite-preview",
      ),
      refused: () => new Error("Visual Git/project precondition failed."),
    },
  );
  return { run, owner, captureFailure, downstream, restoreAttempts: () => restoreAttempts };
}
it("refuses a restoration failure caught by the real owner even when later Tags and identity would pass", async () => {
  const f = actualRestorationBoundary("restore-fails");
  let failure: unknown = null;
  const result = await f.run().catch((error: unknown) => {
    failure = error;
    return null;
  });
  expect(f.restoreAttempts()).toBe(1);
  expect(f.owner.failures).toHaveLength(1);
  expect(result).toBeNull();
  expect(failure).toBeInstanceOf(Error);
  expect(f.downstream).toEqual([]);
});
it("preserves the original capture exception when real catching cleanup also fails restoration", async () => {
  const f = actualRestorationBoundary("both-fail");
  await expect(f.run()).rejects.toBe(f.captureFailure);
  expect(f.restoreAttempts()).toBe(1);
  expect(f.owner.failures).toHaveLength(1);
  expect(f.downstream).toEqual([]);
});
it("credits restoration only after the real cleanup callback successfully acknowledges it", async () => {
  const f = actualRestorationBoundary("success");
  expect(await f.run()).toMatchObject({ brokenMetadataRestored: true, completeGroup: false });
  expect(f.restoreAttempts()).toBe(1);
  expect(f.owner.failures).toEqual([]);
  expect(f.downstream).toEqual(["retry-display", "tags-display", "identity"]);
});
