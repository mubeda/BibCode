import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  menuState: null as { file: Record<string, unknown>; x: number; y: number } | null,
  setMenu: vi.fn(),
  rowActions: [] as Array<Record<string, unknown>>,
  contextGroups: [] as Array<Array<Record<string, unknown>>>,
  buttons: [] as Array<Record<string, unknown>>,
  checkboxes: [] as Array<Record<string, unknown>>,
  menus: [] as Array<Record<string, unknown>>,
  popups: [] as Array<Record<string, unknown>>,
  menuItems: [] as Array<Record<string, unknown>>,
  separators: 0,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: () => [harness.menuState, harness.setMenu],
}));
vi.mock("./SourceControlRowActions.logic", () => ({
  buildRowContextMenu: () => ({ groups: harness.contextGroups }),
  getRowActions: () => harness.rowActions,
  rowAreaOf: (area: unknown) => area ?? "unstaged",
}));
vi.mock("~/components/chat/DiffStatLabel", () => ({
  DiffStatLabel: (props: Record<string, unknown>) => (
    <span>{`${props.additions as number}/${props.deletions as number}`}</span>
  ),
}));
vi.mock("~/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    harness.buttons.push(props);
    return <button type="button">{props.children as React.ReactNode}</button>;
  },
}));
vi.mock("~/components/ui/checkbox", () => ({
  Checkbox: (props: Record<string, unknown>) => {
    harness.checkboxes.push(props);
    return <input type="checkbox" />;
  },
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: (props: Record<string, unknown>) => {
    harness.menus.push(props);
    return <div>{props.children as React.ReactNode}</div>;
  },
  MenuPopup: (props: Record<string, unknown>) => {
    harness.popups.push(props);
    return <div>{props.children as React.ReactNode}</div>;
  },
  MenuItem: (props: Record<string, unknown>) => {
    harness.menuItems.push(props);
    return <button type="button">{props.children as React.ReactNode}</button>;
  },
  MenuSeparator: () => {
    harness.separators += 1;
    return <hr />;
  },
}));

import { SourceControlChangesList } from "./SourceControlChangesList";

const Icon = () => <span>icon</span>;
const nestedFile = {
  path: "src/file.ts",
  insertions: 3,
  deletions: 1,
  status: "modified" as const,
  area: "unstaged" as const,
};
const rootFile = {
  path: "README.md",
  insertions: 1,
  deletions: 0,
  status: "untracked" as const,
  area: "untracked" as const,
};

function visit(node: React.ReactNode, entries: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, entries);
    return entries;
  }
  if (!React.isValidElement(node)) return entries;
  entries.push(node);
  visit((node.props as { children?: React.ReactNode }).children, entries);
  return entries;
}

function renderList(overrides: Record<string, unknown> = {}) {
  const props = {
    files: [nestedFile, rootFile],
    onToggle: vi.fn(),
    onOpenFile: vi.fn(),
    ...overrides,
  };
  const tree = SourceControlChangesList(props as never);
  return { props, tree, markup: renderToStaticMarkup(tree) };
}

function invokeClick(props: Record<string, unknown> | undefined, event?: unknown): void {
  if (typeof props?.onClick !== "function") throw new Error("Missing click handler");
  props.onClick(event);
}

function invokeHandler(
  props: Record<string, unknown> | undefined,
  key: string,
  ...args: unknown[]
): void {
  const handler = props?.[key];
  if (typeof handler !== "function") throw new Error(`Missing ${key} handler`);
  handler(...args);
}

beforeEach(() => {
  harness.menuState = null;
  harness.setMenu.mockReset();
  harness.rowActions = [];
  harness.contextGroups = [];
  harness.buttons.length = 0;
  harness.checkboxes.length = 0;
  harness.menus.length = 0;
  harness.popups.length = 0;
  harness.menuItems.length = 0;
  harness.separators = 0;
  vi.stubGlobal(
    "DOMRect",
    class {
      constructor(
        readonly x: number,
        readonly y: number,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SourceControlChangesList", () => {
  it("renders its empty state", () => {
    const { markup } = renderList({ files: [] });
    expect(markup).toContain("No changes");
  });

  it("renders rows, opens files, and captures context-menu coordinates", () => {
    const onOpenFile = vi.fn();
    const renderBadge = vi.fn(() => <span>badge</span>);
    const { tree, markup } = renderList({ onOpenFile, renderBadge });
    expect(markup).toContain("src");
    expect(markup).toContain("README.md");
    expect(markup).toContain("3/1");
    expect(markup).toContain("badge");

    const elements = visit(tree);
    const row = elements.find(
      (element) =>
        element.type === "div" &&
        typeof (element.props as Record<string, unknown>).onContextMenu === "function",
    );
    const openButton = elements.find(
      (element) =>
        element.type === "button" &&
        String((element.props as Record<string, unknown>).className).includes("min-w-0"),
    );
    invokeHandler(openButton?.props as Record<string, unknown> | undefined, "onClick");
    expect(onOpenFile).toHaveBeenCalledWith("src/file.ts", "unstaged");
    const preventDefault = vi.fn();
    invokeHandler(row?.props as Record<string, unknown> | undefined, "onContextMenu", {
      preventDefault,
      clientX: 12,
      clientY: 34,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(harness.setMenu).toHaveBeenCalledWith({ file: nestedFile, x: 12, y: 34 });
  });

  it("renders one staging checkbox per row in normal mode", () => {
    renderList({
      checked: () => false,
      selected: () => false,
      onSelect: vi.fn(),
    });

    expect(harness.checkboxes).toHaveLength(2);
    expect(harness.checkboxes.map((props) => props["aria-label"])).toEqual([
      "Stage src/file.ts",
      "Stage README.md",
    ]);
  });

  it("replaces staging with selection and hides row mutations in selection mode", () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    harness.rowActions = [{ kind: "stage", label: "Stage", destructive: false, icon: Icon }];

    const { markup } = renderList({
      selectionMode: true,
      checked: () => false,
      selected: (file: typeof nestedFile) => file.path === nestedFile.path,
      onToggle,
      onSelect,
      onStageFile: vi.fn(),
    });

    expect(harness.checkboxes).toHaveLength(2);
    expect(harness.checkboxes[0]?.["aria-label"]).toBe("Deselect src/file.ts");
    expect(harness.checkboxes[1]?.["aria-label"]).toBe("Select README.md");
    invokeHandler(harness.checkboxes[1], "onCheckedChange", true);
    expect(onSelect).toHaveBeenCalledWith("README.md", true);
    expect(onToggle).not.toHaveBeenCalled();
    expect(harness.buttons).toHaveLength(0);
    expect(markup).toContain("bg-accent/70");
  });

  it("keeps the right-click menu mutation-free in selection mode", () => {
    harness.menuState = { file: nestedFile, x: 20, y: 30 };
    harness.contextGroups = [
      [{ id: "view", label: "View", enabled: true }],
      [
        { id: "ignore-file-name", label: "Ignore File", enabled: true },
        { id: "ignore-parent-folder", label: "Ignore Parent", enabled: true },
      ],
    ];
    const onIgnoreFileName = vi.fn();
    const onIgnoreParentFolder = vi.fn();
    const { tree } = renderList({
      selectionMode: true,
      onIgnoreFileName,
      onIgnoreParentFolder,
    });

    const row = visit(tree).find(
      (element) =>
        element.type === "div" &&
        typeof (element.props as Record<string, unknown>).onContextMenu === "function",
    );
    const preventDefault = vi.fn();
    invokeHandler(row?.props as Record<string, unknown> | undefined, "onContextMenu", {
      preventDefault,
      clientX: 20,
      clientY: 30,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(harness.setMenu).toHaveBeenCalledWith({ file: nestedFile, x: 20, y: 30 });
    expect(harness.menuItems.map((item) => item.children)).toEqual(["View"]);
    expect(onIgnoreFileName).not.toHaveBeenCalled();
    expect(onIgnoreParentFolder).not.toHaveBeenCalled();
  });

  it("executes every available context-menu action and closes the menu", () => {
    harness.menuState = { file: nestedFile, x: 20, y: 30 };
    harness.contextGroups = [
      [
        { id: "view", label: "View", enabled: true },
        { id: "copy-path", label: "Copy Path", enabled: true },
        { id: "copy-relative-path", label: "Copy Relative", enabled: true },
      ],
      [
        { id: "ignore-file-name", label: "Ignore File", enabled: true },
        { id: "ignore-parent-folder", label: "Ignore Parent", enabled: false },
        { id: "open-external-editor", label: "Open External", enabled: true },
      ],
    ];
    const onViewFile = vi.fn();
    const onCopyPath = vi.fn();
    const onIgnoreFileName = vi.fn();
    const onIgnoreParentFolder = vi.fn();
    const onOpenExternalEditor = vi.fn();
    renderList({
      isPrimaryEnv: true,
      onViewFile,
      onCopyPath,
      onIgnoreFileName,
      onIgnoreParentFolder,
      onOpenExternalEditor,
    });
    expect(harness.menuItems).toHaveLength(6);
    expect(harness.separators).toBe(1);
    for (const item of harness.menuItems) invokeClick(item);
    expect(onViewFile).toHaveBeenCalledWith("src/file.ts", "unstaged");
    expect(onCopyPath).toHaveBeenNthCalledWith(1, "src/file.ts", false);
    expect(onCopyPath).toHaveBeenNthCalledWith(2, "src/file.ts", true);
    expect(onIgnoreFileName).toHaveBeenCalledWith("src/file.ts");
    expect(onIgnoreParentFolder).toHaveBeenCalledWith("src/file.ts");
    expect(onOpenExternalEditor).toHaveBeenCalledWith("src/file.ts");
    expect(harness.setMenu).toHaveBeenCalledWith(null);

    const onOpenChange = harness.menus[0]?.onOpenChange;
    if (typeof onOpenChange !== "function") throw new Error("Missing menu handler");
    harness.setMenu.mockClear();
    onOpenChange(true);
    expect(harness.setMenu).not.toHaveBeenCalled();
    onOpenChange(false);
    expect(harness.setMenu).toHaveBeenCalledWith(null);

    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    invokeHandler(harness.popups[0], "onClick", { stopPropagation });
    invokeHandler(harness.popups[0], "onContextMenu", { preventDefault });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    const anchor = harness.popups[0]?.anchor as { getBoundingClientRect: () => unknown };
    expect(anchor.getBoundingClientRect()).toMatchObject({ x: 20, y: 30, width: 0, height: 0 });
  });

  it("drops context-menu groups whose handlers are unavailable", () => {
    harness.menuState = { file: rootFile, x: 0, y: 0 };
    harness.contextGroups = [
      [
        { id: "copy-path", label: "Copy", enabled: true },
        { id: "copy-relative-path", label: "Copy Relative", enabled: true },
        { id: "ignore-file-name", label: "Ignore", enabled: true },
        { id: "ignore-parent-folder", label: "Ignore Parent", enabled: true },
        { id: "open-external-editor", label: "Open", enabled: true },
      ],
    ];
    renderList();
    expect(harness.menus).toHaveLength(0);
  });
});
