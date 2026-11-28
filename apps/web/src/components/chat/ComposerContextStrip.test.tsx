// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { showContextMenuMock, toastAddMock } = vi.hoisted(() => ({
  showContextMenuMock: vi.fn(),
  toastAddMock: vi.fn(),
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: {
      show: showContextMenuMock,
    },
  }),
}));

vi.mock("../ui/toast", () => ({
  toastManager: {
    add: toastAddMock,
  },
}));

import {
  ComposerContextStrip,
  deriveComposerContextStripState,
  folderBasename,
} from "./ComposerContextStrip";

describe("folderBasename", () => {
  it("extracts folder names from Unix and Windows paths without splitting POSIX backslashes", () => {
    expect(folderBasename("/workspace/projects/bibcode")).toBe("bibcode");
    expect(folderBasename("/workspace/projects/bibcode/")).toBe("bibcode");
    expect(folderBasename("/work/a\\b")).toBe("a\\b");
    expect(folderBasename("C:\\repo\\worktrees\\feat-ui\\")).toBe("feat-ui");
    expect(folderBasename("/")).toBe("/");
    expect(folderBasename("C:\\")).toBe("C:\\");
  });
});

describe("deriveComposerContextStripState", () => {
  it("derives Main checkout for primary checkouts and Worktree for linked worktrees across Windows and POSIX paths", () => {
    const primary = deriveComposerContextStripState({
      environmentLabel: "Local",
      projectCwd: "/workspace/bibcode",
      worktreePath: null,
      fallbackBranch: "main",
      vcsStatus: {
        data: { isRepo: true, refName: "main" },
        isPending: false,
        error: null,
      },
    });
    expect(primary).toEqual({
      environmentLabel: "Local",
      checkoutPath: "/workspace/bibcode",
      checkoutKind: "Main checkout",
      branch: "main",
    });

    const sameWindowsPath = deriveComposerContextStripState({
      environmentLabel: "Local",
      projectCwd: "C:\\Work\\Repo",
      worktreePath: "c:/work/repo/",
      fallbackBranch: null,
      vcsStatus: {
        data: { isRepo: true, refName: "main" },
        isPending: false,
        error: null,
      },
    });
    expect(sameWindowsPath.checkoutKind).toBe("Main checkout");

    const distinctPosixBackslash = deriveComposerContextStripState({
      environmentLabel: "Local",
      projectCwd: "/work/a\\b",
      worktreePath: "/work/a/b",
      fallbackBranch: null,
      vcsStatus: {
        data: { isRepo: true, refName: "main" },
        isPending: false,
        error: null,
      },
    });
    expect(distinctPosixBackslash.checkoutKind).toBe("Worktree");

    const linked = deriveComposerContextStripState({
      environmentLabel: "Build Host",
      projectCwd: "/workspace/bibcode",
      worktreePath: "/workspace/bibcode-wt/feature-x",
      fallbackBranch: "stale-branch",
      vcsStatus: {
        data: { isRepo: true, refName: "feature/x" },
        isPending: false,
        error: null,
      },
    });
    expect(linked).toEqual({
      environmentLabel: "Build Host",
      checkoutPath: "/workspace/bibcode-wt/feature-x",
      checkoutKind: "Worktree",
      branch: "feature/x",
    });
  });

  it("omits folder and checkout kind without a resolved project and omits stale branch on non-repo or detached HEAD", () => {
    expect(
      deriveComposerContextStripState({
        environmentLabel: "Local",
        projectCwd: null,
        worktreePath: "/workspace/stale-draft-worktree",
        fallbackBranch: "historical-branch",
        vcsStatus: null,
      }),
    ).toEqual({
      environmentLabel: "Local",
      checkoutPath: null,
      checkoutKind: null,
      branch: null,
    });

    expect(
      deriveComposerContextStripState({
        environmentLabel: "Local",
        projectCwd: "/workspace/plain-folder",
        worktreePath: null,
        fallbackBranch: "historical-branch",
        vcsStatus: {
          data: { isRepo: false, refName: null },
          isPending: false,
          error: null,
        },
      }).branch,
    ).toBeNull();

    expect(
      deriveComposerContextStripState({
        environmentLabel: "Local",
        projectCwd: "/workspace/bibcode",
        worktreePath: null,
        fallbackBranch: "historical-branch",
        vcsStatus: {
          data: { isRepo: true, refName: null },
          isPending: false,
          error: null,
        },
      }).branch,
    ).toBeNull();

    expect(
      deriveComposerContextStripState({
        environmentLabel: "Local",
        projectCwd: "/workspace/bibcode",
        worktreePath: null,
        fallbackBranch: "pending-branch",
        vcsStatus: {
          data: null,
          isPending: true,
          error: null,
        },
      }).branch,
    ).toBe("pending-branch");
  });
});

describe("ComposerContextStrip", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const writeTextMock = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    showContextMenuMock.mockReset();
    toastAddMock.mockReset();
    writeTextMock.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders environment, truncated folder, checkout kind, and branch with tooltips and right-click copy menus", async () => {
    await act(async () => {
      root.render(
        <ComposerContextStrip
          environmentLabel="Local"
          checkoutPath="/workspace/projects/my-repo"
          checkoutKind="Main checkout"
          branch="feat/composer-info-row"
        />,
      );
    });

    const strip = container.querySelector('[data-testid="composer-context-strip"]');
    expect(strip).not.toBeNull();
    expect(strip?.className).toContain("max-w-3xl");
    expect(strip?.className).toContain("px-5");
    expect(strip?.className).toContain("text-xs");
    expect(strip?.className).toContain("text-muted-foreground");
    expect(strip?.className).not.toMatch(/text-muted-foreground\//);

    const folder = container.querySelector<HTMLElement>('[data-testid="composer-context-folder"]');
    const checkoutKind = container.querySelector<HTMLElement>(
      '[data-testid="composer-context-checkout-kind"]',
    );
    const branch = container.querySelector<HTMLElement>('[data-testid="composer-context-branch"]');

    expect(strip?.textContent).toContain("Local");
    expect(folder?.textContent).toBe("my-repo");
    expect(folder?.getAttribute("title")).toBe("/workspace/projects/my-repo");
    expect(checkoutKind?.textContent).toBe("Main checkout");
    expect(branch?.textContent).toBe("feat/composer-info-row");
    expect(branch?.getAttribute("title")).toBe("feat/composer-info-row");

    // Right-clicking folder offers "Copy full path" and copies the full path.
    showContextMenuMock.mockResolvedValueOnce("copy-full-path");
    await act(async () => {
      folder?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 80,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(showContextMenuMock).toHaveBeenCalledWith(
      [{ id: "copy-full-path", label: "Copy full path" }],
      { x: 40, y: 80 },
    );
    expect(writeTextMock).toHaveBeenCalledWith("/workspace/projects/my-repo");

    // Right-clicking branch offers "Copy branch name" and copies the branch name.
    showContextMenuMock.mockResolvedValueOnce("copy-branch-name");
    await act(async () => {
      branch?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 80,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(showContextMenuMock).toHaveBeenCalledWith(
      [{ id: "copy-branch-name", label: "Copy branch name" }],
      { x: 120, y: 80 },
    );
    expect(writeTextMock).toHaveBeenCalledWith("feat/composer-info-row");
  });

  it("omits missing folder, checkout kind, and branch segments cleanly", async () => {
    await act(async () => {
      root.render(
        <ComposerContextStrip
          environmentLabel="Remote Lab"
          checkoutPath={null}
          checkoutKind={null}
          branch={null}
        />,
      );
    });

    expect(container.querySelector('[data-testid="composer-context-strip"]')?.textContent).toBe(
      "Remote Lab",
    );
    expect(container.querySelector('[data-testid="composer-context-folder"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-context-checkout-kind"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-context-branch"]')).toBeNull();
  });
});
