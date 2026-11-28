// @vitest-environment happy-dom

import type { PreviewSessionSnapshot } from "@bibcode/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

const testState = vi.hoisted(() => ({
  contextMenuShow: vi.fn(),
  localApiAvailable: true,
}));

vi.mock("~/localApi", () => ({
  readLocalApi: () =>
    testState.localApiAvailable ? { contextMenu: { show: testState.contextMenuShow } } : undefined,
}));

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render?: React.ReactNode;
    children?: React.ReactNode;
  }) => <>{render ?? children}</>,
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => (
    <span data-testid="tooltip">{children}</span>
  ),
}));

vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    ref,
    hideScrollbars,
    scrollFade,
    ...props
  }: React.ComponentProps<"div"> & { hideScrollbars?: boolean; scrollFade?: boolean }) => {
    void hideScrollbars;
    void scrollFade;
    return (
      <div ref={ref} {...props}>
        {children}
      </div>
    );
  },
}));

vi.mock("./preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children, mode }: { children?: React.ReactNode; mode: string }) => (
    <section data-mode={mode}>{children}</section>
  ),
}));

vi.mock("./chat/PierreEntryIcon", () => ({
  PierreEntryIcon: ({ pathValue }: { pathValue: string }) => <span data-file-icon={pathValue} />,
}));

import { RightPanelTabs } from "./RightPanelTabs";

type TabsProps = Parameters<typeof RightPanelTabs>[0];

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];
const suiteScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
let originalScrollIntoViewDescriptor: PropertyDescriptor | undefined;

async function mount(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedTrees.push({ container, root });
  await act(async () => root.render(element));
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  return button!;
}

function iconButton(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-right-panel-icon-bar] button[aria-label="${label}"]`,
  );
  expect(button).not.toBeNull();
  return button!;
}

function snapshot(navStatus: PreviewSessionSnapshot["navStatus"]): PreviewSessionSnapshot {
  return {
    threadId: "thread-1",
    tabId: "preview-1",
    navStatus,
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

const fileSurface: RightPanelSurface = {
  id: "file:src/main.ts",
  kind: "file",
  relativePath: "src/main.ts",
  revealLine: null,
  revealRequestId: 0,
};
const previewSurface: RightPanelSurface = {
  id: "browser:1",
  kind: "preview",
  resourceId: "preview-1",
};
const secondPreviewSurface: RightPanelSurface = {
  id: "browser:2",
  kind: "preview",
  resourceId: "preview-2",
};

function tabsProps(overrides: Partial<TabsProps> = {}): TabsProps {
  return {
    mode: "inline",
    surfaces: [fileSurface, previewSurface],
    activeSurfaceId: fileSurface.id,
    pendingSurfaceIds: new Set<string>(),
    previewSessions: {
      "preview-1": snapshot({
        _tag: "Success",
        url: "https://example.test/docs",
        title: "Project docs",
      }),
    },
    previewDesktopByTabId: {},
    terminalLabelsById: new Map<string, string>(),
    onActivate: vi.fn(),
    onCloseSurface: vi.fn(),
    onCloseOtherSurfaces: vi.fn(),
    onCloseSurfacesToRight: vi.fn(),
    onCloseAllSurfaces: vi.fn(),
    onCopyFilePath: vi.fn(),
    onSelectBrowser: vi.fn(),
    onSelectTerminal: vi.fn(),
    onSelectFiles: vi.fn(),
    onSelectDiff: vi.fn(),
    onSelectSourceControl: vi.fn(),
    onSelectGitManager: vi.fn(),
    onSelectPipelines: vi.fn(),
    onSelectPullRequest: vi.fn(),
    browserAvailable: true,
    terminalAvailable: true,
    diffAvailable: true,
    filesAvailable: true,
    sourceControlAvailable: true,
    gitManagerAvailable: true,
    pipelinesAvailable: true,
    pullRequestAvailable: true,
    children: <div>active content</div>,
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testState.localApiAvailable = true;
  testState.contextMenuShow.mockReset().mockResolvedValue(null);
  originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
    writable: true,
  });
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  if (originalScrollIntoViewDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      originalScrollIntoViewDescriptor,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  originalScrollIntoViewDescriptor = undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
});

afterAll(() => {
  expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")).toEqual(
    suiteScrollIntoViewDescriptor,
  );
});

describe("RightPanelTabs mounted interactions", () => {
  it("always shows the fixed top outline-icon bar with zero empty-state card grid or + menu", async () => {
    const onSelectTerminal = vi.fn();
    const onSelectGitManager = vi.fn();
    const onSelectPipelines = vi.fn();
    const onSelectPullRequest = vi.fn();
    await mount(
      <RightPanelTabs
        {...tabsProps({
          surfaces: [],
          activeSurfaceId: null,
          onSelectTerminal,
          onSelectGitManager,
          onSelectPipelines,
          onSelectPullRequest,
        })}
      />,
    );

    expect(document.body.textContent).not.toContain("Open a surface");
    expect(document.querySelector('[aria-label="Add panel surface"]')).toBeNull();
    expect(document.body.textContent).toContain("Select a surface from the bar above.");

    const icons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-right-panel-icon-bar] button"),
    ).map((button) => button.getAttribute("aria-label"));
    expect(icons).toEqual([
      "Browser",
      "Terminal",
      "Files",
      "Diff",
      "Source Control",
      "Git Manager",
      "Pipelines",
      "Pull Request",
    ]);

    await click(iconButton("Terminal"));
    await click(iconButton("Git Manager"));
    await click(iconButton("Pipelines"));
    await click(iconButton("Pull Request"));
    expect(onSelectTerminal).toHaveBeenCalledOnce();
    expect(onSelectGitManager).toHaveBeenCalledOnce();
    expect(onSelectPipelines).toHaveBeenCalledOnce();
    expect(onSelectPullRequest).toHaveBeenCalledOnce();
  });

  it("underlines the active singleton icon and keeps it selected on re-click (D6)", async () => {
    const onSelectDiff = vi.fn();
    await mount(
      <RightPanelTabs
        {...tabsProps({
          surfaces: [{ id: "diff", kind: "diff" }],
          activeSurfaceId: "diff",
          onSelectDiff,
        })}
      />,
    );

    const diffIcon = iconButton("Diff");
    expect(diffIcon.getAttribute("data-active-icon")).toBe("true");
    expect(diffIcon.getAttribute("aria-pressed")).toBe("true");
    expect(diffIcon.className).toContain("after:bg-foreground");

    // Re-clicking calls onSelectDiff (which keeps diff active, never toggling it off).
    await click(diffIcon);
    expect(onSelectDiff).toHaveBeenCalledOnce();
    expect(diffIcon.getAttribute("data-active-icon")).toBe("true");
    // Singleton surfaces do not appear as closable tabs beside the icon bar.
    expect(document.querySelector('[aria-label="Close Diff"]')).toBeNull();
  });

  it("omits Device when off and shows Device as the 9th icon when enabled", async () => {
    await mount(<RightPanelTabs {...tabsProps({ surfaces: [], activeSurfaceId: null })} />);
    expect(document.querySelector('[aria-label="Device"]')).toBeNull();

    const onSelectDevice = vi.fn();
    await mount(
      <RightPanelTabs
        {...tabsProps({
          surfaces: [{ id: "device", kind: "device" }],
          activeSurfaceId: "device",
          onSelectDevice,
        })}
      />,
    );
    const deviceIcon = iconButton("Device");
    expect(deviceIcon.getAttribute("data-active-icon")).toBe("true");
    await click(deviceIcon);
    expect(onSelectDevice).toHaveBeenCalledOnce();
  });

  it("keeps unavailable icons visible with aria-disabled and explanatory tooltips", async () => {
    const onSelectBrowser = vi.fn();
    const onSelectDiff = vi.fn();
    const onSelectPipelines = vi.fn();
    await mount(
      <RightPanelTabs
        {...tabsProps({
          surfaces: [],
          activeSurfaceId: null,
          browserAvailable: false,
          diffAvailable: false,
          filesAvailable: false,
          sourceControlAvailable: false,
          gitManagerAvailable: false,
          pipelinesAvailable: false,
          pullRequestAvailable: false,
          pipelinesDisabledReason: "Pipelines are turned off in Settings → Source Control.",
          onSelectBrowser,
          onSelectDiff,
          onSelectPipelines,
        })}
      />,
    );

    expect(
      document.querySelectorAll('[data-right-panel-icon-bar] [aria-disabled="true"]'),
    ).toHaveLength(7);
    await click(iconButton("Browser"));
    await click(iconButton("Diff"));
    await click(iconButton("Pipelines"));
    expect(onSelectBrowser).not.toHaveBeenCalled();
    expect(onSelectDiff).not.toHaveBeenCalled();
    expect(onSelectPipelines).not.toHaveBeenCalled();
    const tooltips = Array.from(document.querySelectorAll('[data-testid="tooltip"]')).map(
      (node) => node.textContent,
    );
    expect(tooltips).toContain("Browser previews are only available in the BiBCode desktop app.");
    expect(tooltips).toContain("Pipelines are turned off in Settings → Source Control.");
  });

  it("supports keyboard arrow, Home, and End navigation across the fixed icon bar", async () => {
    await mount(<RightPanelTabs {...tabsProps({ surfaces: [], activeSurfaceId: null })} />);
    const browserIcon = iconButton("Browser");
    const terminalIcon = iconButton("Terminal");
    const pullRequestIcon = iconButton("Pull Request");
    browserIcon.focus();

    await act(async () => {
      browserIcon.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(terminalIcon);

    await act(async () => {
      terminalIcon.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement).toBe(pullRequestIcon);

    await act(async () => {
      pullRequestIcon.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(document.activeElement).toBe(browserIcon);

    await act(async () => {
      browserIcon.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(document.activeElement).toBe(pullRequestIcon);
  });

  it("activates, closes, and middle-clicks dynamic file and multi-Browser tabs beside Files root", async () => {
    const onActivate = vi.fn();
    const onCloseSurface = vi.fn();
    const onSelectFiles = vi.fn();
    await mount(
      <RightPanelTabs
        {...tabsProps({
          surfaces: [
            { id: "files", kind: "files" },
            fileSurface,
            previewSurface,
            secondPreviewSurface,
          ],
          activeSurfaceId: fileSurface.id,
          previewSessions: {
            "preview-1": snapshot({
              _tag: "Success",
              url: "https://example.test/docs",
              title: "Project docs",
            }),
            "preview-2": snapshot({
              _tag: "Success",
              url: "https://example.test/app",
              title: "Preview app",
            }),
          },
          onActivate,
          onCloseSurface,
          onSelectFiles,
        })}
      />,
    );

    expect(document.body.textContent).toContain("main.ts");
    expect(document.body.textContent).toContain("Project docs");
    expect(document.body.textContent).toContain("Preview app");
    // Files singleton is in the icon bar, not repeated as a closable tab.
    expect(document.querySelector('[aria-label="Close Files"]')).toBeNull();
    await click(iconButton("Files"));
    expect(onSelectFiles).toHaveBeenCalledOnce();

    await click(buttonWithText("Project docs"));
    expect(onActivate).toHaveBeenCalledWith(previewSurface);

    await click(document.querySelector<HTMLButtonElement>('[aria-label="Close main.ts"]')!);
    expect(onCloseSurface).toHaveBeenCalledWith(fileSurface);

    const previewTab = buttonWithText("Project docs").parentElement!;
    await act(async () => {
      previewTab.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      previewTab.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 0 }));
      previewTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      previewTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 1 }));
    });
    expect(onCloseSurface).toHaveBeenLastCalledWith(previewSurface);
  });

  it("opens the native tab context menu and copies a file path", async () => {
    const onCopyFilePath = vi.fn();
    testState.contextMenuShow.mockResolvedValue("copy-path");
    await mount(<RightPanelTabs {...tabsProps({ onCopyFilePath })} />);

    const fileTab = buttonWithText("main.ts").parentElement!;
    await act(async () => {
      fileTab.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 34,
        }),
      );
    });

    expect(testState.contextMenuShow).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "copy-path", label: "Copy path" }),
        expect.objectContaining({ id: "close", label: "Close" }),
      ]),
      { x: 12, y: 34 },
    );
    expect(onCopyFilePath).toHaveBeenCalledWith("src/main.ts");
  });

  it("marks a file tab whose edits conflict with the disk, even in the background", async () => {
    await mount(
      <RightPanelTabs
        {...tabsProps({
          activeSurfaceId: previewSurface.id,
          conflictSurfaceIds: new Set([fileSurface.id]),
        })}
      />,
    );

    const close = document.querySelector('[aria-label="Close main.ts"]');
    expect(close?.querySelector("[data-file-disk-conflict]")).not.toBeNull();
    expect(document.body.textContent).toContain("(changed on disk)");
    expect(
      document.querySelector('[aria-label="Close Project docs"] [data-file-disk-conflict]'),
    ).toBeNull();
  });

  it("uses the live desktop title for preview tabs and renders local globe icon", async () => {
    await mount(
      <RightPanelTabs
        {...tabsProps({
          activeSurfaceId: previewSurface.id,
          previewDesktopByTabId: {
            "preview-1": {
              url: "https://example.test/current",
              title: "Current page",
              canGoBack: true,
              canGoForward: false,
              loading: false,
              zoomFactor: 1,
              controller: "human",
            },
          },
        })}
      />,
    );

    expect(buttonWithText("Current page").querySelector("svg.lucide-earth")).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(iconButton("Browser").getAttribute("data-active-icon")).toBe("true");
  });

  it("can suppress the icon bar when allowAddSurfaces is false", async () => {
    await mount(<RightPanelTabs {...tabsProps({ allowAddSurfaces: false })} />);
    expect(document.querySelector("[data-right-panel-icon-bar]")).toBeNull();
  });

  it("dispatches every native context-menu close action and ignores unavailable menus", async () => {
    const onCloseSurface = vi.fn();
    const onCloseOtherSurfaces = vi.fn();
    const onCloseSurfacesToRight = vi.fn();
    const onCloseAllSurfaces = vi.fn();
    await mount(
      <RightPanelTabs
        {...tabsProps({
          onCloseSurface,
          onCloseOtherSurfaces,
          onCloseSurfacesToRight,
          onCloseAllSurfaces,
        })}
      />,
    );
    const previewTab = buttonWithText("Project docs").parentElement!;
    for (const action of ["close", "close-others", "close-to-right", "close-all", null]) {
      testState.contextMenuShow.mockResolvedValueOnce(action);
      await act(async () => {
        previewTab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      });
    }
    expect(onCloseSurface).toHaveBeenCalledWith(previewSurface);
    expect(onCloseOtherSurfaces).toHaveBeenCalledWith(previewSurface);
    expect(onCloseSurfacesToRight).toHaveBeenCalledWith(previewSurface);
    expect(onCloseAllSurfaces).toHaveBeenCalledOnce();

    testState.localApiAvailable = false;
    const callsBeforeUnavailable = testState.contextMenuShow.mock.calls.length;
    await act(async () => {
      previewTab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    expect(testState.contextMenuShow).toHaveBeenCalledTimes(callsBeforeUnavailable);
  });
});
