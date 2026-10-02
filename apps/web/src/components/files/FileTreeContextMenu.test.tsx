// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const callbacks = vi.hoisted(() => [] as Array<() => void>);
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  MenuSeparator: () => <hr />,
  MenuItem: ({
    children,
    disabled,
    onClick,
    "aria-describedby": describedBy,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    "aria-describedby"?: string;
  }) => {
    if (onClick) callbacks.push(onClick);
    return (
      <button role="menuitem" disabled={disabled} onClick={onClick} aria-describedby={describedBy}>
        {children}
      </button>
    );
  },
}));
import FileTreeContextMenu from "./FileTreeContextMenu";
import { buildFileTreeMenuModel } from "./FileTreeContextMenu.logic";
afterEach(() => {
  callbacks.length = 0;
});
describe("File tree disabled transfer explanation", () => {
  it("renders visible accessible reasons and refuses a programmatically invoked disabled action", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    const download = vi.fn();
    const close = vi.fn();
    const reason = "Update Studio to transfer files over its encrypted connection";
    try {
      await act(async () =>
        root.render(
          <FileTreeContextMenu
            model={buildFileTreeMenuModel({
              entryKind: "file",
              isPreviewable: false,
              isMarkdown: false,
              isPrimaryEnv: false,
              hasWorkspaceRoot: true,
              downloadDisabledReason: reason,
            })}
            actions={{ onDownload: download }}
            anchor={{ getBoundingClientRect: () => new DOMRect() }}
            onClose={close}
          />,
        ),
      );
      const item = rootElement.querySelector<HTMLButtonElement>("button")!;
      expect(item.disabled).toBe(true);
      const description = rootElement.querySelector(
        `#${CSS.escape(item.getAttribute("aria-describedby") ?? "missing")}`,
      );
      expect(description?.textContent).toBe(reason);
      expect(description?.className).toContain("text-xs");
      expect(description?.className).not.toMatch(/text-muted-foreground\//);
      callbacks[0]?.();
      expect(download).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      rootElement.remove();
    }
  });
});
