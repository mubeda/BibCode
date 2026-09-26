import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { normalizeContextMenuEntries, showContextMenuFallback } from "./contextMenuFallback";

type FakeListener = (event: FakeDomEvent) => void;

class FakeDomEvent {
  defaultPrevented = false;

  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {}
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> & { cssText?: string } = {};
  dataset: Record<string, string> = {};
  className = "";
  disabled = false;
  type = "";
  readonly attributes: Record<string, string> = {};
  private textValue = "";
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly tagName: string) {}

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }

  contains(target: unknown): boolean {
    if (target === this) return true;
    return this.children.some((child) => child.contains(target));
  }

  remove() {
    if (!this.parent) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  set textContent(value: string) {
    this.textValue = value;
  }

  get textContent() {
    return `${this.textValue}${this.children.map((child) => child.textContent).join("")}`;
  }

  querySelectorAll(tagName: string): FakeElement[] {
    const matches: FakeElement[] = [];
    if (this.tagName === tagName) {
      matches.push(this);
    }
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(tagName));
    }
    return matches;
  }

  getBoundingClientRect() {
    const left = Number.parseInt(this.style.left ?? "0", 10) || 0;
    const top = Number.parseInt(this.style.top ?? "0", 10) || 0;
    const width = this.tagName === "div" ? 180 : 140;
    const height = this.tagName === "div" ? 120 : 28;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
}

class FakeBody extends FakeElement {
  private html = "";

  constructor() {
    super("body");
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }
}

class FakeDocument {
  body = new FakeBody();
  private readonly listeners = new Map<string, FakeListener[]>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  createElementNS(_namespace: string, tagName: string) {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type);
    if (!existing) {
      return;
    }
    const index = existing.indexOf(listener);
    if (index >= 0) {
      existing.splice(index, 1);
    }
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  querySelectorAll(tagName: string) {
    return this.body.querySelectorAll(tagName);
  }
}

function findButton(label: string): FakeElement | undefined {
  return (document as unknown as FakeDocument)
    .querySelectorAll("button")
    .find((button) => button.textContent.includes(label));
}

beforeEach(() => {
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "MouseEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
  vi.stubGlobal(
    "KeyboardEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showContextMenuFallback", () => {
  it("resolves a clicked flat menu item", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", destructive: true },
    ]);

    const renameButton = findButton("Rename");
    expect(renameButton).toBeTruthy();
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("renders separators and drops leading, trailing and repeated ones", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([
      { separator: true },
      { id: "open", label: "Open" },
      { separator: true },
      { separator: true },
      { id: "copy", label: "Copy" },
      { separator: true },
    ]);
    const inner = fakeDocument.body.children[0]!.children[0]!;
    expect(inner.children.map((child) => child.tagName)).toEqual(["button", "div", "button"]);
    const separator = inner.children[1]!;
    expect(separator.attributes["role"]).toBe("separator");
    expect(separator.className).toBe("my-1 mx-1.5 h-px bg-border");

    findButton("Copy")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(selectionPromise).resolves.toBe("copy");
  });

  it("normalizes separators inside submenus", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([
      {
        id: "open-in",
        label: "Open in",
        children: [
          { id: "open-in:file-explorer", label: "File Explorer" },
          { separator: true },
          { separator: true },
          { id: "open-in:vscode", label: "VS Code" },
          { separator: true },
        ],
      },
    ]);
    findButton("Open in")?.dispatchEvent(new FakeDomEvent("mouseenter"));
    const submenuInner = fakeDocument.body.children[1]!.children[0]!;
    expect(submenuInner.children.map((child) => child.tagName)).toEqual([
      "button",
      "div",
      "button",
    ]);

    findButton("VS Code")?.dispatchEvent(new FakeDomEvent("click"));
    await expect(selectionPromise).resolves.toBe("open-in:vscode");
  });

  it("opens nested submenus and resolves the clicked leaf id", async () => {
    const selectionPromise = showContextMenuFallback([
      {
        id: "rename:submenu",
        label: "Rename project",
        children: [
          { id: "rename:project-a", label: "/tmp/project-a" },
          { id: "rename:project-b", label: "/tmp/project-b" },
        ],
      },
    ]);

    const parentButton = findButton("Rename project");
    expect(parentButton).toBeTruthy();
    parentButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    const childButton = findButton("/tmp/project-b");
    expect(childButton).toBeTruthy();
    childButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename:project-b");
  });

  it("renders headers, icon variants, disabled rows, and hover tones", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "header", label: "Actions", header: true },
      { id: "copy", label: "Copy", icon: "copy" },
      { id: "disabled", label: "Disabled", icon: "missing", disabled: true },
      { id: "remove", label: "Remove", icon: "trash", destructive: true },
    ]);
    const fakeDocument = document as unknown as FakeDocument;
    expect(fakeDocument.querySelectorAll("svg")).toHaveLength(2);
    expect(fakeDocument.body.textContent).toContain("Actions");

    const copy = findButton("Copy")!;
    copy.dispatchEvent(new FakeDomEvent("mouseenter"));
    expect(copy.style.background).toBe("var(--accent)");
    copy.dispatchEvent(new FakeDomEvent("mouseleave"));
    expect(copy.style.color).toBe("var(--foreground)");

    // A disabled row stays reachable (aria-disabled, not `disabled`), but a
    // click or hover neither chooses it nor closes the menu.
    const disabled = findButton("Disabled")!;
    expect(disabled.disabled).toBe(false);
    expect(disabled.attributes["aria-disabled"]).toBe("true");
    disabled.dispatchEvent(new FakeDomEvent("mouseenter"));
    disabled.dispatchEvent(new FakeDomEvent("click"));
    expect(disabled.dataset.active).not.toBe("true");
    expect(disabled.style.color).toBe("var(--muted-foreground)");
    expect(fakeDocument.body.children).toHaveLength(1);

    const remove = findButton("Remove")!;
    remove.dispatchEvent(new FakeDomEvent("mouseenter"));
    expect(remove.style.color).toBe("var(--destructive-foreground)");
    remove.dispatchEvent(new FakeDomEvent("mouseleave"));
    remove.dispatchEvent(new FakeDomEvent("click"));
    remove.dispatchEvent(new FakeDomEvent("click"));
    await expect(selectionPromise).resolves.toBe("remove");
  });

  it("dismisses with Escape but ignores other keys", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }]);
    fakeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }) as FakeDomEvent);
    expect(fakeDocument.body.children).toHaveLength(1);
    const escape = new KeyboardEvent("keydown", { key: "Escape" }) as FakeDomEvent;
    fakeDocument.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("ignores inside pointer events and dismisses outside pointer events", async () => {
    vi.stubGlobal("Node", FakeElement);
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }]);
    const button = findButton("Copy")!;
    fakeDocument.dispatchEvent(
      new FakeDomEvent("pointerdown", { target: button }) as unknown as PointerEvent,
    );
    expect(fakeDocument.body.children).toHaveLength(1);
    fakeDocument.dispatchEvent(
      new FakeDomEvent("pointerdown", {
        target: new FakeElement("outside"),
      }) as unknown as PointerEvent,
    );
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("uses fallback parent chains and context-menu cancellation", async () => {
    vi.stubGlobal("Node", undefined);
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }]);
    const menu = fakeDocument.body.children[0]!;
    fakeDocument.dispatchEvent(
      new FakeDomEvent("contextmenu", { target: { parent: menu } }) as unknown as MouseEvent,
    );
    expect(fakeDocument.body.children).toHaveLength(1);
    const outside = new FakeDomEvent("contextmenu", { target: { parent: null } });
    fakeDocument.dispatchEvent(outside as unknown as MouseEvent);
    expect(outside.defaultPrevented).toBe(true);
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("does not dismiss from pointers before the animation frame", async () => {
    const frames: Array<(time: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }]);
    fakeDocument.dispatchEvent(
      new FakeDomEvent("pointerdown", { target: null }) as unknown as PointerEvent,
    );
    expect(fakeDocument.body.children).toHaveLength(1);
    for (const frame of frames) frame(0);
    fakeDocument.dispatchEvent(
      new FakeDomEvent("pointerdown", { target: null }) as unknown as PointerEvent,
    );
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("positions the menu inside the viewport before it can paint", async () => {
    vi.stubGlobal("window", { innerWidth: 400, innerHeight: 300 });
    const frames: Array<(time: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    const fakeDocument = document as unknown as FakeDocument;
    const visibilityAtInsert: Array<string | undefined> = [];
    const append = fakeDocument.body.appendChild.bind(fakeDocument.body);
    fakeDocument.body.appendChild = (child: FakeElement) => {
      visibilityAtInsert.push(child.style.visibility);
      return append(child);
    };
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }], {
      x: 390,
      y: 290,
    });
    const menu = fakeDocument.body.children[0]!;
    // Inserted hidden, then measured and clamped before any frame could paint it.
    expect(visibilityAtInsert).toEqual(["hidden"]);
    expect(frames.length).toBeGreaterThan(0);
    expect(menu.style.left).toBe(`${400 - 180 - 4}px`);
    expect(menu.style.top).toBe(`${300 - 120 - 4}px`);
    expect(menu.style.visibility).toBe("visible");
    findButton("Copy")?.dispatchEvent(new FakeDomEvent("click"));
    await expect(selectionPromise).resolves.toBe("copy");
  });

  it("clamps nested menus, prevents parent clicks, and closes child levels", async () => {
    vi.stubGlobal("window", { innerWidth: 250, innerHeight: 180 });
    const frames: Array<(time: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback(
      [
        {
          id: "parent",
          label: "Parent",
          children: [{ id: "child", label: "Child" }],
        },
      ],
      { x: 240, y: 170 },
    );
    for (const frame of frames.splice(0)) frame(0);
    const parent = findButton("Parent")!;
    parent.dispatchEvent(new FakeDomEvent("mouseenter"));
    expect(fakeDocument.body.children).toHaveLength(2);
    expect(fakeDocument.body.children[1]?.style.left).toBe("4px");
    const click = new FakeDomEvent("click");
    parent.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    fakeDocument.body.children[0]?.dispatchEvent(new FakeDomEvent("mouseenter"));
    expect(fakeDocument.body.children).toHaveLength(1);
    findButton("Parent")?.dispatchEvent(new FakeDomEvent("mouseenter"));
    findButton("Child")?.dispatchEvent(new FakeDomEvent("mouseenter"));
    findButton("Child")?.dispatchEvent(new FakeDomEvent("click"));
    await expect(selectionPromise).resolves.toBe("child");
  });
});

describe("normalizeContextMenuEntries", () => {
  it("trims leading and trailing separators and collapses runs", () => {
    expect(
      normalizeContextMenuEntries([
        { separator: true },
        { id: "a", label: "A" },
        { separator: true },
        { separator: true },
        { id: "b", label: "B" },
        { separator: true },
      ]),
    ).toEqual([{ id: "a", label: "A" }, { separator: true }, { id: "b", label: "B" }]);
  });

  it("returns nothing for a list of separators", () => {
    expect(normalizeContextMenuEntries([{ separator: true }, { separator: true }])).toEqual([]);
  });
});
