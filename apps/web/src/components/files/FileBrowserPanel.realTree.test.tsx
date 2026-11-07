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
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ remapFileSurfaces: vi.fn(), closeFileSurfacesUnder: vi.fn() }),
}));
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
vi.mock("./projectFilesQueryState", () => ({
  useFileTreeEntries: () => ({
    data: { entries, truncated: false },
    isPending: false,
    revalidate: vi.fn(),
    refresh: vi.fn(),
    error: null,
  }),
}));

import FileBrowserPanel, { resetFileTreeViewMemory } from "./FileBrowserPanel";

const environmentId = EnvironmentId.make("environment-1");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };

describe("FileBrowserPanel with the real tree", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onOpenFile = vi.fn();

  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  };
  const mount = async () => {
    await act(async () => {
      root.render(
        <FileBrowserPanel
          environmentId={environmentId}
          cwd="/repo"
          projectName="repo"
          threadRef={threadRef}
          availableEditors={[]}
          onOpenFile={onOpenFile}
          onBeginPathMutation={() => ({}) as never}
        />,
      );
    });
    await settle();
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
});
