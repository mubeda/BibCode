// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { showContextMenuFallback } from "./contextMenuFallback";

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

function focusedText(): string {
  return document.activeElement?.textContent?.trim() ?? "";
}

function menus(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'));
}

function focusTrigger(): HTMLButtonElement {
  const trigger = document.createElement("button");
  trigger.textContent = "Card";
  document.body.append(trigger);
  trigger.focus();
  return trigger;
}

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("showContextMenuFallback keyboard support", () => {
  it("exposes menu roles and starts on the first enabled item", async () => {
    const trigger = focusTrigger();
    const selection = showContextMenuFallback([
      { id: "disabled", label: "Disabled", disabled: true },
      { id: "open-in", label: "Open in", children: [{ id: "open-in:vscode", label: "VS Code" }] },
      { separator: true },
      { id: "copy-path", label: "Copy Path" },
    ]);
    const [menu] = menus();
    expect(menu?.getAttribute("aria-orientation")).toBe("vertical");
    expect(menu?.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(menu?.querySelector('[aria-disabled="true"]')?.textContent).toBe("Disabled");
    expect(menu?.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(focusedText()).toContain("Open in");

    press("Escape");
    await expect(selection).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("moves with the arrow keys onto disabled items, skipping separators, and wraps", async () => {
    focusTrigger();
    const selection = showContextMenuFallback([
      { id: "rename", label: "Rename…" },
      { separator: true },
      { id: "disabled", label: "Disabled", disabled: true },
      { id: "copy-path", label: "Copy Path" },
      { separator: true },
      { id: "delete", label: "Delete", destructive: true },
    ]);
    expect(focusedText()).toBe("Rename…");
    press("ArrowDown");
    expect(focusedText()).toBe("Disabled");
    press("ArrowDown");
    expect(focusedText()).toBe("Copy Path");
    press("ArrowDown");
    expect(focusedText()).toBe("Delete");
    press("ArrowDown");
    expect(focusedText()).toBe("Rename…");
    press("ArrowUp");
    expect(focusedText()).toBe("Delete");
    press("ArrowUp");
    expect(focusedText()).toBe("Copy Path");
    press("ArrowUp");
    expect(focusedText()).toBe("Disabled");
    press("Home");
    expect(focusedText()).toBe("Rename…");
    press("End");
    expect(focusedText()).toBe("Delete");

    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("keeps a disabled item focusable: aria-disabled, never the disabled attribute", async () => {
    const selection = showContextMenuFallback([
      { id: "pull", label: "Pull" },
      { id: "open-in", label: "Open in", disabled: true, description: "Unavailable." },
    ]);
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-disabled]')!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.hasAttribute("disabled")).toBe(false);
    expect(item.disabled).toBe(false);
    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("lands Home and End on disabled items at either end, but opens on the first enabled one", async () => {
    focusTrigger();
    const selection = showContextMenuFallback([
      { id: "open-in", label: "Open in", disabled: true, description: "No local opener." },
      { id: "pull", label: "Pull" },
      { separator: true },
      {
        id: "delete",
        label: "Delete Worktree…",
        destructive: true,
        disabled: true,
        description: "Stop the running session before deleting this worktree.",
      },
    ]);
    expect(focusedText()).toBe("Pull");
    press("End");
    expect(focusedText()).toBe(
      "Delete Worktree…Stop the running session before deleting this worktree.",
    );
    expect(document.activeElement?.getAttribute("aria-disabled")).toBe("true");
    press("Home");
    expect(focusedText()).toBe("Open inNo local opener.");
    press("ArrowUp");
    expect(focusedText()).toContain("Delete Worktree…");

    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("chooses nothing and stays open on Enter, Space or click on a disabled item", async () => {
    const trigger = focusTrigger();
    const chosen = vi.fn();
    const selection = showContextMenuFallback([
      { id: "pull", label: "Pull" },
      {
        id: "delete",
        label: "Delete Worktree…",
        destructive: true,
        disabled: true,
        description: "Stop the running session before deleting this worktree.",
      },
    ]);
    void selection.then(chosen);
    press("ArrowDown");
    const item = document.activeElement as HTMLElement;
    expect(item.getAttribute("aria-disabled")).toBe("true");

    expect(press("Enter").defaultPrevented).toBe(true);
    expect(press(" ").defaultPrevented).toBe(true);
    item.click();
    await Promise.resolve();

    expect(chosen).not.toHaveBeenCalled();
    expect(menus()).toHaveLength(1);
    expect(document.activeElement).toBe(item);
    press("Escape");
    await expect(selection).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("never opens a disabled item's submenu", async () => {
    focusTrigger();
    const selection = showContextMenuFallback([
      {
        id: "move-to-split",
        label: "Move Tab to Split",
        disabled: true,
        children: [{ id: "move-to-split:left", label: "Left" }],
      },
      { id: "close", label: "Close" },
    ]);
    expect(focusedText()).toBe("Close");
    press("ArrowUp");
    const parent = document.activeElement as HTMLElement;
    expect(parent.getAttribute("aria-haspopup")).toBe("menu");

    press("ArrowRight");
    press("Enter");
    press(" ");
    parent.dispatchEvent(new MouseEvent("mouseenter"));

    expect(menus()).toHaveLength(1);
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(parent);
    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("opens a submenu on its first enabled item and reaches its disabled ones", async () => {
    focusTrigger();
    const selection = showContextMenuFallback([
      {
        id: "move-to-split",
        label: "Move Tab to Split",
        children: [
          { id: "move-to-split:left", label: "Left", disabled: true },
          { id: "move-to-split:right", label: "Right" },
        ],
      },
    ]);
    press("ArrowRight");
    expect(menus()).toHaveLength(2);
    expect(focusedText()).toBe("Right");
    press("ArrowUp");
    expect(focusedText()).toBe("Left");
    press("Enter");
    expect(menus()).toHaveLength(2);
    press("ArrowLeft");
    expect(menus()).toHaveLength(1);

    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("focuses the first item when every item is disabled", async () => {
    focusTrigger();
    const selection = showContextMenuFallback([
      { id: "open-in", label: "Open in", disabled: true, description: "No local opener." },
      { id: "pull", label: "Pull", disabled: true, description: "Workspace is unavailable." },
    ]);
    expect(focusedText()).toBe("Open inNo local opener.");
    press("ArrowDown");
    expect(focusedText()).toBe("PullWorkspace is unavailable.");
    press("Enter");
    expect(menus()).toHaveLength(1);

    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("shows focus on a disabled item without giving it the hover style", async () => {
    focusTrigger();
    const selection = showContextMenuFallback([
      { id: "pull", label: "Pull" },
      {
        id: "delete",
        label: "Delete Worktree…",
        destructive: true,
        disabled: true,
        icon: "trash",
        description: "Stop the running session before deleting this worktree.",
      },
    ]);
    const [pull, item] = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    press("ArrowDown");
    expect(document.activeElement).toBe(item);
    expect(item!.dataset.active).toBe("true");
    expect(item!.style.background).toBe("var(--accent)");
    // Focus never makes a disabled row look actionable: its text stays muted.
    expect(item!.style.color).toBe("var(--muted-foreground)");
    expect(pull!.dataset.active).toBe("false");

    // The pointer moving to an enabled row takes focus and the highlight with it.
    pull!.dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.activeElement).toBe(pull);
    expect(item!.dataset.active).toBe("false");
    expect(item!.style.color).toBe("var(--muted-foreground)");

    // Hovering the disabled row is inert: focus and highlight stay put.
    item!.dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.activeElement).toBe(pull);
    expect(pull!.dataset.active).toBe("true");
    expect(item!.dataset.active).toBe("false");

    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("opens a submenu with ArrowRight or Enter and closes it with ArrowLeft", async () => {
    focusTrigger();
    const selection = showContextMenuFallback([
      {
        id: "open-in",
        label: "Open in",
        children: [
          { id: "open-in:file-explorer", label: "File Explorer" },
          { id: "open-in:vscode", label: "VS Code" },
        ],
      },
      { id: "pull", label: "Pull" },
    ]);
    const parent = menus()[0]!.querySelector<HTMLElement>('[aria-haspopup="menu"]')!;

    press("ArrowRight");
    expect(menus()).toHaveLength(2);
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    expect(focusedText()).toBe("File Explorer");
    press("ArrowDown");
    expect(focusedText()).toBe("VS Code");

    press("ArrowLeft");
    expect(menus()).toHaveLength(1);
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(parent);

    press("Enter");
    expect(menus()).toHaveLength(2);
    expect(focusedText()).toBe("File Explorer");
    press("Enter");
    await expect(selection).resolves.toBe("open-in:file-explorer");
    expect(menus()).toHaveLength(0);
  });

  it("chooses the focused item with Space and returns focus to the trigger", async () => {
    const trigger = focusTrigger();
    const selection = showContextMenuFallback([
      { id: "rename", label: "Rename…" },
      { id: "copy-path", label: "Copy Path" },
    ]);
    press("ArrowDown");
    const space = press(" ");
    expect(space.defaultPrevented).toBe(true);
    await expect(selection).resolves.toBe("copy-path");
    expect(document.activeElement).toBe(trigger);
  });

  it("scrolls each arrow/Home/End focus into the visible menu viewport", async () => {
    focusTrigger();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const selection = showContextMenuFallback(
      Array.from({ length: 40 }, (_, index) => ({ id: String(index), label: `Item ${index}` })),
    );
    for (const key of ["End", "Home", "ArrowDown", "ArrowUp"]) {
      scroll.mockClear();
      press(key);
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
      expect(scroll.mock.contexts.at(-1)).toBe(document.activeElement);
    }
    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("explains disabled Open in and Pull to sighted and assistive users", async () => {
    const selection = showContextMenuFallback([
      {
        id: "open-in",
        label: "Open in",
        disabled: true,
        description: "No local opener is available.",
      },
      { id: "pull", label: "Pull", disabled: true, description: "Workspace is unavailable." },
    ]);
    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
    for (const [index, reason] of [
      "No local opener is available.",
      "Workspace is unavailable.",
    ].entries()) {
      expect(items[index]?.getAttribute("aria-description")).toBe(reason);
      expect(items[index]?.textContent).toContain(reason);
    }
    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("names a disabled item by its label and describes it by its reason, once each", async () => {
    const selection = showContextMenuFallback([
      { id: "open-in", label: "Open in", disabled: true, description: "No local opener." },
      { id: "pull", label: "Pull", disabled: true, description: "Workspace is unavailable." },
    ]);
    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const textOf = (ids: string | null | undefined) =>
      (ids ?? "")
        .split(" ")
        .filter((id) => id.length > 0)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    for (const [index, [label, reason]] of [
      ["Open in", "No local opener."],
      ["Pull", "Workspace is unavailable."],
    ].entries()) {
      // The content holds label and reason; without these references the reason
      // would be read twice: once in the name, once as the description.
      expect(textOf(items[index]?.getAttribute("aria-labelledby"))).toBe(label);
      expect(textOf(items[index]?.getAttribute("aria-describedby"))).toBe(reason);
    }
    press("Escape");
    await expect(selection).resolves.toBeNull();
  });

  it("closes on Tab without choosing anything", async () => {
    const trigger = focusTrigger();
    const selection = showContextMenuFallback([{ id: "copy-path", label: "Copy Path" }]);
    press("Tab");
    await expect(selection).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps one active item across hover and keyboard input", async () => {
    focusTrigger();
    const selection = showContextMenuFallback([
      { id: "open-in", label: "Open in", disabled: true, description: "Unavailable." },
      { id: "pull", label: "Pull" },
      { id: "copy-path", label: "Copy Path" },
    ]);
    expect(focusedText()).toBe("Pull");
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const pull = items.find((item) => item.textContent === "Pull")!;
    const copyPath = items.find((item) => item.textContent === "Copy Path")!;
    copyPath.dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.activeElement).toBe(copyPath);
    expect(pull.dataset.active).toBe("false");
    expect(copyPath.dataset.active).toBe("true");
    press("ArrowUp");
    expect(focusedText()).toBe("Pull");
    copyPath.dispatchEvent(new MouseEvent("mouseenter"));
    press("Enter");
    await expect(selection).resolves.toBe("copy-path");
  });

  it("dims a disabled label but keeps its explanation at full contrast", async () => {
    const reason = "The worktree directory is missing.";
    const selection = showContextMenuFallback([
      { id: "pull", label: "Pull", disabled: true, description: reason },
      { id: "copy-path", label: "Copy Path" },
    ]);
    const item = document.querySelector<HTMLElement>('[role="menuitem"][aria-disabled="true"]')!;
    const explanation = Array.from(item.querySelectorAll<HTMLElement>("*")).find(
      (element) => element.textContent === reason,
    )!;
    expect(explanation).toBeDefined();
    // Nothing between the explanation and the menu may dim it: opacity multiplies.
    for (
      let node: HTMLElement | null = explanation;
      node && node !== item.parentElement;
      node = node.parentElement
    ) {
      expect(node.className).not.toMatch(/\bopacity-/);
      expect(["", "1"]).toContain(node.style.opacity);
    }
    expect(explanation.className).toContain("text-muted-foreground");
    expect(explanation.className).not.toMatch(/text-muted-foreground\//);
    expect(explanation.className).toContain("text-xs");
    const label = Array.from(item.querySelectorAll<HTMLElement>("*")).find(
      (element) => element.textContent === "Pull",
    )!;
    expect(label.style.opacity).toBe("0.64");
    press("Escape");
    await expect(selection).resolves.toBeNull();
  });
});
