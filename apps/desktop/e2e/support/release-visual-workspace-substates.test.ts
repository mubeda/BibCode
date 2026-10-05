// @effect-diagnostics nodeBuiltinImport:off - Real source components, disposable Git and fake WebDriver ports; no native images.
// @vitest-environment happy-dom
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { buildFileTreeMenuModel } from "../../../web/src/components/files/FileTreeContextMenu.logic.ts";
import { resolveStashActionState } from "../../../web/src/components/gitManager/stash/GitManagerStashList.logic.ts";
import { prepareVisualProject } from "./release-visual-fixture.ts";
import { visualScenes } from "./release-visual-evidence.ts";
import {
  workspaceSubstateFileName,
  runFilesItemContextMenu,
  runSelectedStashDiff,
  runWorkspaceActivityLines,
  runWorkspaceSubstateBatch,
  readWorkspaceSubstate,
  validateWorkspaceSubstate,
  validateWorkspaceSubstateJoins,
  workspaceSubstates,
  workspaceSubstateRows,
  type WorkspaceSubstateFlowInput,
} from "./release-visual-workspace-substates.ts";

const web = NodeModule.createRequire(new NodeURL.URL("../../../web/package.json", import.meta.url));
const React = web("react");
const { createElement, act } = React;
const { createRoot } = web("react-dom/client");
const { transformSync } = NodeModule.createRequire(web.resolve("vite-plus"))("esbuild");
function sourceModule(path: string, ports: Record<string, unknown>) {
  const module = { exports: {} as Record<string, any> };
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../../../web/src/" + path, import.meta.url),
    "utf8",
  );
  NodeVM.runInNewContext(
    transformSync(source, { loader: "tsx", format: "cjs", jsx: "transform" }).code,
    {
      module,
      exports: module.exports,
      React,
      require: (id: string) => ports[id] ?? web(id),
    },
  );
  return module.exports;
}
function sourcePart(
  path: string,
  begin: string,
  end: string,
  name: string,
  ports: Record<string, unknown>,
) {
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../../../web/src/" + path, import.meta.url),
    "utf8",
  );
  const start = source.indexOf(begin),
    stop = source.indexOf(end, start);
  expect(start).toBeGreaterThan(0);
  expect(stop).toBeGreaterThan(start);
  return NodeVM.runInNewContext(
    transformSync(source.slice(start, stop), { loader: "tsx", format: "cjs", jsx: "transform" })
      .code +
      "\n" +
      name,
    { React, memo: React.memo, useCallback: React.useCallback, ...ports },
  );
}
const cn = (...items: unknown[]) => items.filter(Boolean).join(" ");
const menu = sourceModule("components/ui/menu.tsx", {
  "~/lib/utils": { cn },
  "../../lib/utils": { cn },
});
const tooltip = sourceModule("components/ui/tooltip.tsx", {
  "~/lib/utils": { cn },
  "../../lib/utils": { cn },
});
const FileTreeContextMenu = sourceModule("components/files/FileTreeContextMenu.tsx", {
  "~/components/ui/menu": menu,
}).default;
// Execute the actual card parts; unrelated icons, sidebar wrapper and clock are inert ports.
const {
  WorkspaceCardShell,
  WorkspaceCardBranchLine,
  WorkspaceCardTerminalIcon,
  WorkspaceCardMoreChats,
  WorkspaceCardSessionLine,
} = sourceModule("components/sidebar/WorkspaceCard.tsx", {
  "../../lib/utils": { cn },
  "../ui/tooltip": tooltip,
  "../ui/sidebar": {
    SidebarMenuSubItem: (props: any) => createElement("li", props, props.children),
  },
  "../chat/ProviderInstanceIcon": {
    ProviderInstanceIcon: (props: any) =>
      createElement("span", { className: props.className }, "Owned provider"),
  },
  "../ThreadStatusIndicators": { ChangeRequestStatusIcon: () => null },
  "./RelativeAge": {
    RelativeAge: (props: any) =>
      createElement("time", { dateTime: props.iso, className: props.className }, "now"),
  },
});
const terminalSource = NodeFS.readFileSync(
  new NodeURL.URL("../../../web/src/components/ThreadStatusIndicators.tsx", import.meta.url),
  "utf8",
);
const terminalStart = terminalSource.indexOf("export function terminalStatusFromRunningIds(");
const terminalEnd = terminalSource.indexOf("\n}\n", terminalStart) + 3;
const terminalStatusFromRunningIds = NodeVM.runInNewContext(
  NodeModule.stripTypeScriptTypes(terminalSource.slice(terminalStart, terminalEnd)).replace(
    "export ",
    "",
  ) + "\nterminalStatusFromRunningIds",
);
const icon = () => null;
const StashRow = sourcePart(
  "components/gitManager/stash/GitManagerStashList.tsx",
  "const GitManagerStashRowView =",
  "export interface GitManagerStashListProps",
  "GitManagerStashRowView",
  {
    cn,
    resolveStashActionState,
    stashRowViewPropsEqual: () => false,
    Button: ({ children, size: _size, variant: _variant, ...props }: any) =>
      createElement("button", props, children),
    ArchiveRestoreIcon: icon,
    PackageOpenIcon: icon,
    Trash2Icon: icon,
  },
);
const StashFileRow = sourcePart(
  "components/gitManager/stash/GitManagerStashDiff.tsx",
  "const StashFileRow =",
  "export interface GitManagerStashDiffProps",
  "StashFileRow",
  {
    cn,
    stashFileRowPropsEqual: () => false,
    FileIcon: icon,
  },
);

const context = {
  origin: "http://127.0.0.1:4885",
  theme: "light" as const,
  threadId: "owned-thread",
  projectId: "owned-project",
  branch: "codex/delivery-retry-light",
};
const common = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: true,
  targetInView: true,
  credentialAbsent: true,
  bootShellAbsent: true,
};
const fileFacts = {
  ...common,
  itemSelected: true,
  singleItemMenu: true,
  fileActions: true,
  fileEditorPresent: true,
  commentRetained: true,
};
const stashFacts = {
  ...common,
  selectedStash: true,
  selectedStashFile: true,
  actualStashDiff: true,
  containedStashList: true,
};
const workspaceFacts = {
  ...common,
  terminalActivity: true,
  terminalTooltip: true,
  sessionModelAge: true,
  oneOtherChat: true,
  originalWorkspaceRetained: true,
};
const roots: Array<ReturnType<typeof createRoot>> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", new NodeURL.URL(context.origin + "/local/" + context.threadId));
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 20,
    y: 20,
    left: 20,
    top: 20,
    right: 420,
    bottom: 300,
    width: 400,
    height: 280,
    toJSON: () => ({}),
  });
  document.documentElement.classList.remove("dark");
  document.body.innerHTML =
    '<button data-testid="environment-rail-local" aria-checked="true"><span data-status="connected"></span></button>' +
    '<li data-testid="thread-row-owned-thread"><button data-testid="thread-card-button-owned-thread" aria-current="page"></button></li>';
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
}

it("binds additional originals to existing rows rather than adding a scene", () => {
  expect(workspaceSubstateFileName("selected-stash-diff", "light")).toBe(
    "git-history-stashes-selected-diff-light.png",
  );
  expect(workspaceSubstateFileName("files-item-context-menu", "dark")).toBe(
    "files-editor-comment-item-context-menu-dark.png",
  );
  expect(workspaceSubstateFileName("workspace-activity-lines", "light")).toBe(
    "workspace-composite-activity-lines-light.png",
  );
  expect(visualScenes).toHaveLength(9);
  expect(workspaceSubstateRows).toEqual({
    "selected-stash-diff": "git-history-stashes",
    "files-item-context-menu": "files-editor-comment",
    "workspace-activity-lines": "workspace-composite",
  });
  expect(workspaceSubstates).toHaveLength(3);
});

it("uses the actual selected shadow-tree item public right-click and restores the menu", async () => {
  const calls: string[] = [];
  const entry = {
    waitForDisplayed: async () => {},
    waitForEnabled: async () => {},
    waitForClickable: async () => {},
    click: async (options: unknown) => {
      expect(options).toEqual({ button: "right" });
      calls.push("right-click");
    },
  };
  const input = {
    origin: "http://127.0.0.1:4885",
    theme: "light",
    threadId: "owned-thread",
    projectId: "owned-project",
    branch: "codex/delivery-retry-light",
    verifyManaged: async () => {},
    owner: { until: async (check: () => Promise<boolean>) => expect(await check()).toBe(true) },
    capture: async (substate: unknown) => {
      expect(substate).toBe("files-item-context-menu");
      calls.push("capture");
    },
    browser: {
      $: (selector: string) =>
        selector.includes("file-tree-container")
          ? {
              shadow$: (item: string) => {
                expect(item).toContain('data-item-path="src/nested/visual-note.ts"');
                return entry;
              },
            }
          : { waitForDisplayed: async () => {} },
      $$: () => ({ length: Promise.resolve(1) }),
      execute: async () => ({
        themeMatched: true,
        selectedMatched: true,
        credentialAbsent: true,
        bootShellAbsent: true,
        itemSelected: true,
      }),
      keys: async (key: string) => {
        expect(key).toBe("Escape");
        calls.push("escape");
      },
    },
  };
  await runFilesItemContextMenu(input as unknown as WorkspaceSubstateFlowInput);
  expect(calls).toEqual(["right-click", "capture", "escape"]);
});

it.each(["../private", "workspace-composite", null, {}, Symbol("private")])(
  "refuses unknown file namespaces before constructing evidence names: %s",
  (value) => {
    expect(() => workspaceSubstateFileName(value, "light")).toThrow(
      "Owned workspace substate refused.",
    );
  },
);

it.each(["targetInView", "credentialAbsent", "itemSelected", "singleItemMenu", "commentRetained"])(
  "does not admit a missing/unsafe Files state: %s",
  (key) => {
    expect(() =>
      validateWorkspaceSubstate("files-item-context-menu", { ...fileFacts, [key]: false }),
    ).toThrow();
  },
);
it("validates fixed facts without reading getters, proxies, private extras or inherited fields", () => {
  expect(validateWorkspaceSubstate("files-item-context-menu", fileFacts)).toEqual(fileFacts);
  let reads = 0;
  const getter = { ...fileFacts };
  Object.defineProperty(getter, "itemSelected", {
    enumerable: true,
    get: () => {
      reads++;
      return true;
    },
  });
  const proxy = new Proxy(fileFacts, {
    ownKeys: () => {
      reads++;
      return [];
    },
  });
  const revoked = Proxy.revocable(fileFacts, {});
  revoked.revoke();
  for (const value of [
    getter,
    proxy,
    revoked.proxy,
    Object.create(fileFacts),
    { ...fileFacts, private: true },
  ])
    expect(() => validateWorkspaceSubstate("files-item-context-menu", value)).toThrow();
  expect(reads).toBe(0);
});

it.each([false, true])(
  "preserves the original capture error even if menu cleanup also fails: %s",
  async (cleanupFails) => {
    const original = new Error("inert capture refusal"),
      cleanup = new Error("inert menu close refusal");
    let opened = 0,
      closed = 0,
      observed = 0;
    const input = {
      ...context,
      owner: { until: async () => {} },
      verifyManaged: async () => {},
      capture: async () => {
        throw original;
      },
      observeCleanupFailure: () => {
        observed++;
      },
      browser: {
        execute: async () => fileFacts,
        $: (selector: string) =>
          selector.includes("file-tree-container")
            ? {
                shadow$: () => ({
                  waitForDisplayed: async () => {},
                  waitForEnabled: async () => {},
                  waitForClickable: async () => {},
                  click: async () => {
                    opened++;
                  },
                }),
              }
            : { waitForDisplayed: async () => {} },
        keys: async () => {
          closed++;
          if (cleanupFails) throw cleanup;
        },
      },
    };
    await expect(
      runFilesItemContextMenu(input as unknown as WorkspaceSubstateFlowInput),
    ).rejects.toBe(original);
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    expect(observed).toBe(cleanupFails ? 1 : 0);
  },
);
it("keeps a successful capture incomplete when its menu cannot be closed", async () => {
  const cleanup = new Error("inert close refusal");
  const input = {
    ...context,
    owner: { until: async () => {} },
    verifyManaged: async () => {},
    capture: async () => {},
    browser: {
      execute: async () => fileFacts,
      keys: async () => {
        throw cleanup;
      },
      $: (selector: string) =>
        selector.includes("file-tree-container")
          ? {
              shadow$: () => ({
                waitForDisplayed: async () => {},
                waitForEnabled: async () => {},
                waitForClickable: async () => {},
                click: async () => {},
              }),
            }
          : { waitForDisplayed: async () => {} },
    },
  };
  await expect(
    runFilesItemContextMenu(input as unknown as WorkspaceSubstateFlowInput),
  ).rejects.toBe(cleanup);
});

it("selects only a genuine stash diff and restores history without touching mutation controls", async () => {
  const calls: string[] = [],
    controls: string[] = [];
  const input = {
    ...context,
    owner: { until: async () => {} },
    verifyManaged: async () => {},
    capture: async (selected: string) => {
      expect(selected).toBe("selected-stash-diff");
      calls.push("capture");
    },
    browser: {
      execute: async (read: unknown) => (read === readWorkspaceSubstate ? common : { x: 0, y: 0 }),
      $$: () => ({ length: Promise.resolve(1) }),
      $: (selector: string) => ({
        getAttribute: async () => "true",
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        scrollIntoView: async () => {},
        waitForClickable: async () => {},
        click: async () => {
          controls.push(selector);
          calls.push("click");
        },
      }),
    },
  };
  await runSelectedStashDiff(input as unknown as WorkspaceSubstateFlowInput);
  expect(calls).toEqual(["click", "capture", "click"]);
  expect(controls[0]).toBe('button[aria-label="Select stash stash@{11}"]');
  expect(controls[1]).toContain("Visual qualification baseline");
  expect(controls.join(" ")).not.toMatch(/Apply|Pop|Drop/);
});

it("reads the real file item menu model and renderer, not a background or folder menu", async () => {
  const panel = document.createElement("div");
  panel.setAttribute("data-preview-panel-mode", "file");
  const tree = document.createElement("file-tree-container");
  const shadow = tree.attachShadow({ mode: "open" });
  const item = document.createElement("div");
  item.setAttribute("role", "treeitem");
  item.setAttribute("data-item-path", "src/nested/visual-note.ts");
  item.setAttribute("aria-selected", "true");
  shadow.append(item);
  panel.append(tree);
  const editor = document.createElement("diffs-container");
  const editorRoot = editor.attachShadow({ mode: "open" });
  const text = document.createElement("div");
  text.setAttribute("role", "textbox");
  text.setAttribute("aria-label", "src/nested/visual-note.ts");
  text.textContent = 'export const note = "Review this owned file";';
  editorRoot.append(text);
  panel.append(editor);
  const annotation = document.createElement("div");
  annotation.setAttribute("data-file-comment-annotation", "true");
  annotation.textContent = "Review this owned line";
  panel.append(annotation);
  const remove = document.createElement("button");
  remove.setAttribute("aria-label", "Delete comment");
  panel.append(remove);
  document.body.append(panel);
  const model = buildFileTreeMenuModel({
    entryKind: "file",
    isPreviewable: false,
    isMarkdown: false,
    isPrimaryEnv: false,
    hasWorkspaceRoot: true,
  });
  await mount(
    createElement(FileTreeContextMenu, {
      model,
      anchor: item,
      onClose: () => {},
      actions: {
        onNewFile: () => {},
        onNewFolder: () => {},
        onCopyPath: () => {},
        onCopyRelativePath: () => {},
        onDuplicate: () => {},
        onRename: () => {},
        onDelete: () => {},
        onDownload: () => {},
        onUpload: () => {},
      },
    }),
  );
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-file-tree-context-menu-root="true"][role="menu"]'),
    ).not.toBeNull(),
  );
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector('[data-file-tree-context-menu-root="true"][role="menu"]'),
  );
  const observed = readWorkspaceSubstate({ ...context, substate: "files-item-context-menu" });
  expect(observed).toEqual(fileFacts);
  item.setAttribute("aria-selected", "false");
  expect(
    readWorkspaceSubstate({ ...context, substate: "files-item-context-menu" })?.itemSelected,
  ).toBe(false);
  expect(JSON.stringify(observed)).not.toMatch(/visual-note|owned-thread|Copy|private|<|http/);
});

it("reads actual card parts and an explicitly inert linked-tooltip fixture with closed semantic binding", async () => {
  document.querySelector('[data-testid="thread-row-owned-thread"]')!.remove();
  const terminal = terminalStatusFromRunningIds(["owned-terminal"])!;
  const idle = { kind: "idle" as const, label: "Idle", colorClass: "text-muted-foreground" };
  await mount(
    createElement(
      WorkspaceCardShell,
      {
        testId: "thread-row-owned-thread",
        buttonTestId: "thread-card-button-owned-thread",
        className: "",
        idBase: "owned-card",
        isActive: true,
        hasFlags: false,
        hasBranchLine: true,
        hasSessionLine: true,
        status: idle,
        onClick: () => {},
        onContextMenu: () => {},
        onButtonKeyDown: () => {},
      },
      createElement(
        WorkspaceCardBranchLine,
        {
          key: "branch",
          id: "owned-card-branch",
          branch: context.branch,
          branchTooltip: null,
        },
        createElement(WorkspaceCardTerminalIcon, terminal),
      ),
      createElement(WorkspaceCardSessionLine, {
        key: "session",
        id: "owned-card-session",
        provider: { driverKind: "codex", label: "Codex" },
        preview: { text: "Owned response", tone: "muted" },
        model: "Owned Fixture Model",
        ageIso: "2026-10-05T00:00:00.000Z",
      }),
      createElement(WorkspaceCardMoreChats, { key: "other", count: 1, status: idle }),
    ),
  );
  const row = document.querySelector('[data-testid="thread-row-owned-thread"]')!;
  expect(row.querySelector('[aria-label="Terminal process running"]')).not.toBeNull();
  expect(row.querySelector("time")?.textContent).toBeTruthy();
  expect(row.textContent).toContain("Owned Fixture Model");
  expect(row.textContent).toContain("1 more chat");
  const surface = document.createElement("div");
  surface.setAttribute("data-center-surface-host", "true");
  surface.setAttribute("data-visible", "true");
  surface.textContent = "BiBCode deterministic streamed fixture response.";
  const composer = document.createElement("div");
  composer.setAttribute("data-testid", "composer-editor");
  composer.textContent = "Owned visual review draft";
  surface.append(composer);
  document.body.append(surface);
  const indicator = row.querySelector('[aria-label="Terminal process running"]')!;
  // HappyDOM does not prove the installed tooltip's hover. This tests only the
  // strict reader binding; the CI action must open the real linked tooltip.
  const popup = document.createElement("div");
  popup.id = "inert-owned-tooltip";
  popup.setAttribute("role", "tooltip");
  popup.textContent = "Terminal process running";
  document.body.append(popup);
  indicator.setAttribute("aria-describedby", popup.id);
  vi.spyOn(document, "elementFromPoint").mockReturnValue(row);
  vi.spyOn(popup, "getBoundingClientRect").mockReturnValue({
    x: 500,
    y: 50,
    left: 500,
    top: 50,
    right: 700,
    bottom: 80,
    width: 200,
    height: 30,
    toJSON: () => ({}),
  });
  vi.mocked(document.elementFromPoint).mockImplementation((x) => (x > 450 ? popup : row));
  const observed = readWorkspaceSubstate({ ...context, substate: "workspace-activity-lines" });
  expect(observed).toEqual(workspaceFacts);
  popup.textContent = "Unrelated tooltip";
  expect(
    readWorkspaceSubstate({ ...context, substate: "workspace-activity-lines" })?.terminalTooltip,
  ).toBe(false);
  expect(JSON.stringify(observed)).not.toMatch(/Owned|http|thread|Terminal|</);
});

it("binds selected stash and file readers to actual stash source row components", async () => {
  vi.stubGlobal(
    "location",
    new NodeURL.URL(context.origin + "/project/local/" + context.projectId + "/git"),
  );
  for (const label of ["Worktree", "Choose branch"]) {
    const button = document.createElement("button");
    button.setAttribute("aria-label", label);
    button.textContent = context.branch;
    document.body.append(button);
  }
  const list = document.createElement("div");
  list.setAttribute("role", "listbox");
  document.body.append(list);
  let selected = 0,
    mutations = 0;
  const rowContainer = await mount(
    createElement(StashRow, {
      row: {
        index: 11,
        sha: "owned-stash",
        message: "Visual stash 01",
        files: [{ path: "visual-stash.txt" }],
        blocked: null,
      },
      selected: true,
      operationInFlight: false,
      disabledReason: null,
      onSelectStash: () => {
        selected++;
      },
      onApply: () => {
        mutations++;
      },
      onPop: () => {
        mutations++;
      },
      onRequestDrop: () => {
        mutations++;
      },
    }),
  );
  list.append(rowContainer);
  const section = document.createElement("section");
  section.setAttribute("aria-label", "Stash 11 diff");
  document.body.append(section);
  section.append(
    await mount(
      createElement(StashFileRow, {
        file: { path: "visual-stash.txt", insertions: 1, deletions: 1 },
        selected: true,
        onSelectPath: () => {},
      }),
    ),
  );
  const diff = document.createElement("diffs-container");
  diff.attachShadow({ mode: "open" }).textContent = "-Visual stash baseline\n+Owned stash change 1";
  section.append(diff);
  vi.spyOn(document, "elementFromPoint").mockReturnValue(section);
  await act(async () =>
    (list.querySelector('button[aria-label="Select stash stash@{11}"]') as HTMLElement).click(),
  );
  const observed = readWorkspaceSubstate({ ...context, substate: "selected-stash-diff" });
  expect(observed).toEqual(stashFacts);
  expect(selected).toBe(1);
  expect(mutations).toBe(0);
  diff.shadowRoot!.textContent = "Unrelated commit patch";
  expect(
    readWorkspaceSubstate({ ...context, substate: "selected-stash-diff" })?.actualStashDiff,
  ).toBe(false);
  expect(JSON.stringify(observed)).not.toMatch(/owned|stash@|http|visual-stash|</);
});

it.each(["selected-stash-diff", "workspace-activity-lines"] as const)(
  "requires every fixed fact for %s without retaining unexpected fields",
  (selected) => {
    const facts = selected === "selected-stash-diff" ? stashFacts : workspaceFacts;
    expect(validateWorkspaceSubstate(selected, facts)).toEqual(facts);
    for (const key of Object.keys(facts))
      expect(() => validateWorkspaceSubstate(selected, { ...facts, [key]: false })).toThrow();
    expect(() => validateWorkspaceSubstate(selected, { ...facts, private: "opaque" })).toThrow();
  },
);

it("joins exactly six closed originals to the three existing rows and two incomplete-group proofs", () => {
  const captures = (["light", "dark"] as const).flatMap((theme) =>
    workspaceSubstates.map((substate) => ({
      scene: workspaceSubstateRows[substate],
      substate,
      theme,
      file: workspaceSubstateFileName(substate, theme),
      witness:
        substate === "selected-stash-diff"
          ? stashFacts
          : substate === "files-item-context-menu"
            ? fileFacts
            : workspaceFacts,
      width: 1280,
      height: 960,
      nonBlank: true,
      sha256: "a".repeat(64),
    })),
  );
  const assertions = ["light", "dark"].map((theme) => ({
    theme,
    existingRowsOnly: true,
    fixedSubstates: true,
    extraOriginals: true,
    completeGroup: false,
  }));
  expect(() => validateWorkspaceSubstateJoins(captures, assertions)).not.toThrow();
  for (const bad of [
    captures.slice(1),
    [...captures.slice(1), captures[1]],
    captures.map((value, index) =>
      index === 0 ? { ...value, scene: "workspace-card-menu" } : value,
    ),
    captures.map((value, index) => (index === 0 ? { ...value, private: "opaque" } : value)),
  ])
    expect(() => validateWorkspaceSubstateJoins(bad, assertions)).toThrow();
  expect(() =>
    validateWorkspaceSubstateJoins(
      captures,
      assertions.map((value) => ({ ...value, completeGroup: true })),
    ),
  ).toThrow();
});

it.each(["foreign-origin", "query", "hash", "foreign-project", "foreign-branch", "wrong-theme"])(
  "refuses foreign/malformed context: %s",
  (mode) => {
    const input = { ...context, substate: "selected-stash-diff" as const };
    vi.stubGlobal(
      "location",
      new NodeURL.URL(context.origin + "/project/local/" + context.projectId + "/git"),
    );
    if (mode === "foreign-origin")
      vi.stubGlobal("location", new NodeURL.URL("https://example.test/"));
    if (mode === "query") vi.stubGlobal("location", new NodeURL.URL(String(location) + "?private"));
    if (mode === "hash") vi.stubGlobal("location", new NodeURL.URL(String(location) + "#private"));
    if (mode === "foreign-project") input.projectId = "foreign-project";
    if (mode === "foreign-branch") input.branch = "main";
    if (mode === "wrong-theme") document.documentElement.classList.add("dark");
    const observed = readWorkspaceSubstate(input);
    expect(() => validateWorkspaceSubstate(input.substate, observed)).toThrow();
  },
);

it("refuses an otherwise hit-testable workspace target hidden by its ancestor opacity", () => {
  const row = document.querySelector<HTMLElement>('[data-testid="thread-row-owned-thread"]')!;
  const parent = document.createElement("div");
  row.replaceWith(parent);
  parent.append(row);
  parent.style.opacity = "0";
  vi.spyOn(document, "elementFromPoint").mockReturnValue(row);
  expect(
    readWorkspaceSubstate({ ...context, substate: "workspace-activity-lines" })?.targetInView,
  ).toBe(false);
});

it("reads existing fixture stash data from disposable Git without applying or dropping it", () => {
  const git = "/usr/bin/git";
  expect(NodeFS.existsSync(git)).toBe(true);
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workspace-substates-")),
  );
  const project = NodePath.join(root, "project"),
    home = NodePath.join(root, "home");
  NodeFS.mkdirSync(project);
  NodeFS.mkdirSync(home);
  const run = (args: string[]) =>
    NodeChildProcess.execFileSync(
      git,
      [
        "-C",
        project,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Owned Fixture",
        "-c",
        "user.email=fixture@example.test",
        ...args,
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
  try {
    run(["init", "--initial-branch=main"]);
    NodeFS.writeFileSync(NodePath.join(project, "README.md"), "owned\n");
    run(["add", "README.md"]);
    run(["commit", "-m", "owned"]);
    prepareVisualProject({ root, project, home, git });
    const before = run(["stash", "list", "--format=%H"]);
    const patch = run(["stash", "show", "--patch", "stash@{11}"]);
    expect(patch).toContain("+Owned stash change 1");
    expect(patch).toContain("-Visual stash baseline");
    expect(before.trim().split("\n")).toHaveLength(12);
    expect(run(["stash", "list", "--format=%H"])).toBe(before);
    expect(run(["status", "--porcelain"])).toBe("");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function publicWorkspacePorts(captureFailure?: Error, interruptFailure?: Error) {
  const calls: string[] = [];
  let terminals = 0,
    chats = 0,
    running = false,
    active = "host",
    focused = false,
    messageSent = false,
    typedCommand = false;
  const input = {
    ...context,
    verifyManaged: async () => {},
    owner: {
      until: async (check: () => Promise<boolean>) => {
        if (!(await check())) throw new Error("Inert readiness refusal.");
      },
    },
    capture: async (substate: string) => {
      expect(substate).toBe("workspace-activity-lines");
      expect({ terminals, chats, running, active, messageSent }).toEqual({
        terminals: 1,
        chats: 1,
        running: true,
        active: "host",
        messageSent: true,
      });
      calls.push("capture");
      if (captureFailure) throw captureFailure;
    },
    observeCleanupFailure: () => calls.push("cleanup-fault"),
    browser: {
      execute: async (read: unknown) =>
        read === readWorkspaceSubstate ? fileFacts : focused || (terminals === 0 && chats === 0),
      $$: (selector: string) => ({
        length: Promise.resolve(
          selector === "[data-center-panel-tab-id]"
            ? 1 + terminals + chats
            : selector.includes('^="terminal:')
              ? terminals
              : selector.includes('^="chat:')
                ? chats
                : 1,
        ),
      }),
      $: (selector: string) => ({
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        waitForClickable: async () => {},
        isFocused: async () => true,
        isDisplayed: async () => (selector.includes("Terminal process running") ? running : true),
        getText: async () =>
          messageSent ? "BiBCode deterministic streamed fixture response." : "",
        moveTo: async () => calls.push("hover"),
        click: async () => {
          if (selector.includes('normalize-space()="Open Terminal"')) {
            terminals++;
            active = "terminal";
            calls.push("open-terminal");
          } else if (selector.includes('normalize-space()="Claude"')) {
            chats++;
            active = "chat";
            calls.push("open-chat");
          } else if (selector.includes('normalize-space()="Codex"'))
            throw new Error("Inert disabled provider refusal.");
          else if (selector.includes('aria-label^="Close ') && selector.includes('^="chat:')) {
            chats--;
            calls.push("close-chat");
          } else if (
            selector.includes('aria-label^="Close ') &&
            selector.includes('^="terminal:')
          ) {
            terminals--;
            running = false;
            calls.push("close-terminal");
          } else if (selector.includes("chat:host")) {
            active = "host";
            calls.push("host");
          } else if (selector.includes('^="terminal:')) active = "terminal";
          else if (selector.includes("xterm-screen")) {
            focused = active === "terminal";
            calls.push("terminal-focus");
          } else if (selector.includes('aria-label="Send message"')) {
            messageSent = true;
            calls.push("send-chat");
          }
        },
      }),
      keys: async (key: string | string[]) => {
        if (key === "/bin/sleep 600") {
          expect(focused).toBe(true);
          typedCommand = true;
          calls.push("typed-owned-command");
        } else if (key === "Enter" && typedCommand) {
          running = true;
          typedCommand = false;
          calls.push("command-enter");
        } else if (key === "Enter" || key === "Tab" || key === "Escape") calls.push(key);
        else if (key === "Owned workspace substate chat") calls.push("typed-owned-chat");
        else {
          expect(key).toEqual(["Control", "c"]);
          calls.push("interrupt");
          if (interruptFailure) throw interruptFailure;
          running = false;
        }
      },
    },
  };
  return {
    input: input as unknown as WorkspaceSubstateFlowInput,
    calls,
    result: () => ({ terminals, chats, running, active }),
  };
}

it("creates terminal activity and a real public second chat before capture, then closes only owned panels", async () => {
  const fake = publicWorkspacePorts();
  await runWorkspaceActivityLines(fake.input);
  expect(fake.calls.indexOf("typed-owned-command")).toBeGreaterThan(
    fake.calls.indexOf("terminal-focus"),
  );
  expect(fake.calls.indexOf("capture")).toBeGreaterThan(fake.calls.indexOf("send-chat"));
  expect(fake.calls.filter((call) => call === "capture")).toHaveLength(1);
  expect(fake.calls.filter((call) => call === "open-terminal")).toHaveLength(1);
  expect(fake.calls.filter((call) => call === "open-chat")).toHaveLength(1);
  expect(fake.result()).toEqual({ terminals: 0, chats: 0, running: false, active: "host" });
});

it.each([false, true])(
  "preserves a workspace capture error and attempts both owned cleanup paths: %s",
  async (interruptFails) => {
    const original = new Error("Inert original capture refusal.");
    const fake = publicWorkspacePorts(
      original,
      interruptFails ? new Error("Inert interrupt refusal.") : undefined,
    );
    await expect(runWorkspaceActivityLines(fake.input)).rejects.toBe(original);
    expect(fake.calls).toContain("close-chat");
    expect(fake.calls).toContain("close-terminal");
    expect(fake.result()).toEqual({ terminals: 0, chats: 0, running: false, active: "host" });
    expect(fake.calls.filter((call) => call === "cleanup-fault")).toHaveLength(
      interruptFails ? 1 : 0,
    );
  },
);

it("keeps a workspace screenshot unqualified when public interruption fails despite successful close", async () => {
  const failure = new Error("Inert interrupt refusal.");
  const fake = publicWorkspacePorts(undefined, failure);
  await expect(runWorkspaceActivityLines(fake.input)).rejects.toBe(failure);
  expect(fake.calls).toContain("close-terminal");
});

it("runs exactly the separate three-substate batch through genuine public prerequisite controls", async () => {
  const fake = publicWorkspacePorts(),
    captures: string[] = [],
    calls: string[] = [];
  const browser = fake.input.browser;
  const originalDollar = browser.$.bind(browser),
    execute = browser.execute.bind(browser);
  const adapted = {
    ...fake.input,
    capture: async (selected: string) => {
      captures.push(selected);
    },
    browser: {
      ...browser,
      execute: async (read: unknown, ...args: unknown[]) =>
        read === readWorkspaceSubstate
          ? fileFacts
          : String(read).includes("scrollX")
            ? { x: 0, y: 0 }
            : execute(read as never, ...args),
      $: (selector: string) => ({
        ...originalDollar(selector),
        getAttribute: async () => "false",
        scrollIntoView: async () => {
          calls.push("contained-scroll");
        },
        setValue: async (value: string) => {
          expect(value).toBe("Review this owned line");
          calls.push("comment-input");
        },
        shadow$: (selected: string) => ({
          waitForDisplayed: async () => {},
          waitForEnabled: async () => {},
          waitForClickable: async () => {},
          click: async (options?: unknown) => {
            calls.push(selected);
            if (options) expect(options).toEqual({ button: "right" });
          },
        }),
      }),
    },
  };
  const receipt = await runWorkspaceSubstateBatch(adapted as unknown as WorkspaceSubstateFlowInput);
  expect(captures).toEqual([
    "workspace-activity-lines",
    "selected-stash-diff",
    "files-item-context-menu",
  ]);
  expect(receipt).toEqual({
    existingRowsOnly: true,
    fixedSubstates: true,
    extraOriginals: true,
    completeGroup: false,
  });
  expect(calls).toContain('[role="treeitem"][data-item-path="src/nested/visual-note.ts"]');
  expect(calls).toContain('[data-gutter] [data-column-number="1"]');
  expect(calls).toContain("comment-input");
  expect(calls).toContain("contained-scroll");
  expect(fake.result()).toEqual({ terminals: 0, chats: 0, running: false, active: "host" });
});
