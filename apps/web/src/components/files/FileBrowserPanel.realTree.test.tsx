// @vitest-environment happy-dom

/**
 * FileBrowserPanel with the real Pierre tree: the cases a stand-in tree cannot show. Only the
 * seams outside the web client are fakes (the entry list, git status, commands, stores).
 */

import { EnvironmentId, ThreadId, type ProjectEntry } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const entries: ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "src/a.ts", kind: "file" },
  { path: "src/b.ts", kind: "file" },
  { path: "docs", kind: "directory" },
  { path: "docs/readme.md", kind: "file" },
] as ProjectEntry[];

vi.mock("@bibcode/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => undefined,
}));
vi.mock("~/browser/openFileInPreview", () => ({
  isBrowserPreviewFile: () => false,
  openFileInPreview: vi.fn(),
}));
vi.mock("~/editorPreferences", () => ({ usePreferredEditor: () => [null] }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" as const }) }));
vi.mock("~/previewStateStore", () => ({ canPreviewAnyUrlInRuntime: () => false }));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: { label: "createUrl" } } }));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
  useEnvironmentHttpBaseUrl: () => null,
  useEnvironmentConnectionState: () => ({ data: { phase: "connected" } }),
}));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: { label: "open" } } }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    create: {},
    createEntry: {},
    createDownloadUrl: {},
    createUploadUrl: {},
    refreshEntries: {},
    renameEntry: {},
    deleteEntry: {},
    duplicateEntry: {},
  },
}));
vi.mock("~/state/shell", () => ({ shellEnvironment: { openInEditor: {} } }));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { status: () => ({}) } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../ui/toast", () => ({ stackedThreadToast: vi.fn(), toastManager: { add: vi.fn() } }));
vi.mock("./FileEntryDialog", () => ({ default: () => null }));
vi.mock("./FileTreeContextMenu", () => ({ default: () => null }));
// The list the mocked query serves; a test swaps it to model a refresh landing later.
const listState = vi.hoisted(() => ({
  entries: [] as ProjectEntry[],
  pending: false,
  revalidate: undefined as unknown as ReturnType<typeof import("vite-plus/test").vi.fn>,
}));
vi.mock("./projectFilesQueryState", () => ({
  useFileTreeEntries: () => ({
    data: { entries: listState.entries, truncated: false },
    isPending: listState.pending,
    revalidate: listState.revalidate,
    refresh: vi.fn(),
    error: null,
  }),
}));

import { useRightPanelStore } from "~/rightPanelStore";
import FileBrowserPanel, {
  fileTreeViewMemorySize,
  resetFileTreeViewMemory,
} from "./FileBrowserPanel";

const environmentId = EnvironmentId.make("environment-1");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };

describe("FileBrowserPanel with the real tree", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onOpenFile = vi.fn();

  const settle = async (rounds = 5) => {
    for (let i = 0; i < rounds; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  };
  const mount = async (panelKey = "a", cwd = "/repo", waitMs = 5) => {
    await act(async () => {
      root.render(
        <FileBrowserPanel
          key={panelKey}
          environmentId={environmentId}
          cwd={cwd}
          projectName="repo"
          threadRef={threadRef}
          availableEditors={[]}
          onOpenFile={onOpenFile}
          onBeginPathMutation={() => ({}) as never}
        />,
      );
    });
    await settle(waitMs);
  };
  const row = (path: string): HTMLElement | null => {
    const host = container.querySelector("file-tree-container");
    return (
      host?.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`) ??
      container.querySelector<HTMLElement>(`[data-item-path="${path}"]`)
    );
  };
  const click = async (path: string) => {
    const target = row(path);
    expect(target, `row ${path}`).not.toBeNull();
    await act(async () => {
      // A browser's click() is composed, so it crosses the tree's shadow root to the host.
      target!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, button: 0 }));
    });
    await settle();
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetFileTreeViewMemory();
    listState.entries = entries;
    listState.pending = false;
    listState.revalidate = vi.fn();
    useRightPanelStore.setState({ byThreadKey: {}, filesReveal: {} });
    onOpenFile.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("opens a file once per click, including the row that is already selected", async () => {
    await mount();
    await click("src/");
    await click("src/a.ts");
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenLastCalledWith("src/a.ts");

    // The tab was closed or left; the same selected row is clicked again.
    await click("src/a.ts");
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });

  it("restores the expanded folders and the selected row after a remount", async () => {
    await mount();
    await click("src/");
    await click("src/b.ts");
    onOpenFile.mockClear();

    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();

    expect(row("src/b.ts")).not.toBeNull();
    expect(row("src/b.ts")!.getAttribute("data-item-selected")).not.toBeNull();
    expect(row("docs/readme.md")).toBeNull();
    // Restoring the selection must not reopen the file.
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("restores across a keyed replacement committed in one render", async () => {
    await mount("thread-a");
    await click("src/");
    await click("src/b.ts");

    // Two threads on one workspace: the new panel renders before the old one's cleanup saves.
    await mount("thread-b");

    expect(row("src/b.ts")).not.toBeNull();
    expect(row("src/b.ts")!.getAttribute("data-item-selected")).not.toBeNull();
  });

  it("remembers at most 32 workspaces", async () => {
    for (let i = 0; i < 34; i += 1) await mount(`k${i}`, `/repo-${i}`, 3);
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(fileTreeViewMemorySize()).toBe(32);
  });

  it("reveals a requested path: opens its folders, selects it, and does not open a file", async () => {
    await mount();
    expect(row("src/a.ts")).toBeNull();

    await act(async () => useRightPanelStore.getState().revealInFiles(threadRef, "src/a.ts"));
    await settle();

    expect(row("src/a.ts")!.getAttribute("data-item-selected")).not.toBeNull();
    expect(row("docs/readme.md")).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(useRightPanelStore.getState().filesReveal).toEqual({});
  });

  it("selects a requested folder and moves the selection off the previous row", async () => {
    await mount();
    await click("src/");
    await click("src/b.ts");
    onOpenFile.mockClear();

    await act(async () => useRightPanelStore.getState().revealInFiles(threadRef, "docs"));
    await settle();

    expect(row("docs/")!.getAttribute("data-item-selected")).not.toBeNull();
    expect(row("src/b.ts")!.getAttribute("data-item-selected")).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("applies a request made before the Files tab mounted, over the remembered view", async () => {
    await mount();
    await click("src/");
    await click("src/b.ts");
    await act(async () => root.unmount());
    root = createRoot(container);

    useRightPanelStore.getState().revealInFiles(threadRef, "docs/readme.md");
    await mount();

    expect(row("docs/readme.md")!.getAttribute("data-item-selected")).not.toBeNull();
    expect(row("src/b.ts")!.getAttribute("data-item-selected")).toBeNull();
    expect(useRightPanelStore.getState().filesReveal).toEqual({});
  });

  it("keeps a request for a file the list does not have yet, and selects it once a refresh brings it", async () => {
    await mount();
    const created = [...entries, { path: "src/new.ts", kind: "file" } as ProjectEntry];

    await act(async () => useRightPanelStore.getState().revealInFiles(threadRef, "src/new.ts"));
    await settle();
    // Not in the list: ask for a fresh one, and keep the request while it is on its way.
    expect(listState.revalidate).toHaveBeenCalledTimes(1);
    expect(useRightPanelStore.getState().filesReveal).not.toEqual({});

    listState.entries = created;
    await mount();
    expect(row("src/new.ts")!.getAttribute("data-item-selected")).not.toBeNull();
    expect(useRightPanelStore.getState().filesReveal).toEqual({});
  });

  it("drops a request whose path a fresh list still lacks, after one refresh", async () => {
    await mount();
    await act(async () => useRightPanelStore.getState().revealInFiles(threadRef, "gone.ts"));
    await settle();
    expect(listState.revalidate).toHaveBeenCalledTimes(1);

    // The refresh lands with the same entries.
    listState.entries = [...entries];
    await mount();
    expect(useRightPanelStore.getState().filesReveal).toEqual({});
    expect(listState.revalidate).toHaveBeenCalledTimes(1);
  });

  it("waits while the list is pending instead of consuming the request", async () => {
    listState.pending = true;
    await mount();
    await act(async () => useRightPanelStore.getState().revealInFiles(threadRef, "src/a.ts"));
    await settle();
    expect(useRightPanelStore.getState().filesReveal).not.toEqual({});
    expect(listState.revalidate).not.toHaveBeenCalled();

    listState.pending = false;
    await mount();
    expect(row("src/a.ts")!.getAttribute("data-item-selected")).not.toBeNull();
  });

  it("clears an active search so a revealed path that does not match is visible", async () => {
    await mount();
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Search workspace files']")!.click(),
    );
    await settle();
    const input = container
      .querySelector("file-tree-container")!
      .shadowRoot!.querySelector<HTMLInputElement>("input");
    expect(input, "search input").not.toBeNull();
    await act(async () => {
      input!.value = "readme";
      input!.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    });
    await settle();
    expect(row("src/")).toBeNull();

    await act(async () => useRightPanelStore.getState().revealInFiles(threadRef, "src/a.ts"));
    await settle();

    expect(row("src/a.ts")).not.toBeNull();
    expect(row("src/a.ts")!.getAttribute("data-item-selected")).not.toBeNull();
  });
});
