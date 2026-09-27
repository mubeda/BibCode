// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CommandPaletteActionItem, CommandPaletteGroup } from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { Command, CommandInput } from "./ui/command";

const actionItems: CommandPaletteActionItem[] = [
  {
    kind: "action",
    value: "alpha",
    title: "Alpha",
    description: "Open the first project",
    timestamp: "2m",
    searchTerms: [],
    icon: null,
    run: async () => undefined,
  },
  {
    kind: "action",
    value: "unavailable",
    title: "Unavailable",
    description: "Connect to use this command",
    disabled: true,
    searchTerms: [],
    icon: null,
    run: async () => undefined,
  },
  {
    kind: "action",
    value: "beta",
    title: "Beta",
    searchTerms: [],
    icon: null,
    run: async () => undefined,
  },
  {
    kind: "action",
    value: "gamma",
    title: "Gamma",
    searchTerms: [],
    icon: null,
    run: async () => undefined,
  },
];
const groups: CommandPaletteGroup[] = [
  { value: "commands", label: "Commands", items: actionItems },
];

function PaletteHarness({
  onExecuteItem,
}: {
  onExecuteItem: ComponentProps<typeof CommandPaletteResults>["onExecuteItem"];
}) {
  const [query, setQuery] = useState("");
  const filteredGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.value.includes(query.toLowerCase())),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <Command
      aria-label="Command palette"
      autoHighlight="always"
      mode="none"
      value={query}
      onValueChange={setQuery}
    >
      <CommandInput aria-label="Find a command" />
      <CommandPaletteResults
        groups={filteredGroups}
        isActionsOnly={false}
        keybindings={[]}
        onExecuteItem={onExecuteItem}
      />
    </Command>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function renderPalette() {
  const onExecuteItem = vi.fn();
  await act(async () => root.render(<PaletteHarness onExecuteItem={onExecuteItem} />));
  const input = container.querySelector("input");
  if (input === null) throw new Error("Command palette rendered no input.");
  return { input, onExecuteItem };
}

function rows() {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-slot=command-item]"));
}

function expectActiveRow(index: number) {
  const currentRows = rows();
  expect(currentRows.filter((row) => row.hasAttribute("data-highlighted"))).toEqual([
    currentRows[index],
  ]);
  for (const row of currentRows) {
    expect(row.hasAttribute("data-selected")).toBe(false);
  }
}

function expectHighlightStyles(row: HTMLElement) {
  expect(row.className).toMatch(/(?:^|\s)data-highlighted:bg-accent!?(?:\s|$)/);
  expect(row.className).toMatch(/(?:^|\s)data-highlighted:text-accent-foreground!?(?:\s|$)/);
  expect(row.classList.contains("data-highlighted:bg-transparent")).toBe(false);
  expect(row.classList.contains("data-highlighted:text-inherit")).toBe(false);
  expect(row.classList.contains("bg-accent!")).toBe(false);
  expect(row.classList.contains("text-accent-foreground!")).toBe(false);
}

describe("CommandPaletteResults with real command wrappers", () => {
  it("moves the Base UI highlight to the next enabled row with ArrowDown", async () => {
    const { input, onExecuteItem } = await renderPalette();
    expect(rows()).toHaveLength(3);
    expectActiveRow(0);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expectActiveRow(1);
    expect(rows()[1]?.textContent).toBe("Beta");

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expectActiveRow(2);
    expect(rows()[2]?.textContent).toBe("Gamma");

    await act(async () => rows()[2]?.click());
    expect(onExecuteItem).toHaveBeenCalledExactlyOnceWith(actionItems[3]);
    expect(rows()).toHaveLength(3);
    expect(container.querySelector("[data-selected]")).toBeNull();
  });

  it("styles the Base UI highlight with transparent hover and no selected-state classes", async () => {
    await renderPalette();

    for (const row of rows()) {
      expect.soft(row.className).not.toContain("data-selected");
      expect(row.classList.contains("hover:bg-transparent")).toBe(true);
      expect(row.classList.contains("hover:text-inherit")).toBe(true);
      expectHighlightStyles(row);
    }
  });

  it("highlights and executes the replacement item after filtering keeps the active index", async () => {
    const { input, onExecuteItem } = await renderPalette();
    expectActiveRow(0);
    expect(rows()[0]?.textContent).toContain("Alpha");

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("Input value setter is unavailable.");
    await act(async () => {
      setValue.call(input, "be");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(input.value).toBe("be");
    expect(rows()).toHaveLength(1);
    expectActiveRow(0);
    const remainingRow = rows()[0]!;
    expect(remainingRow.textContent).toBe("Beta");

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onExecuteItem).toHaveBeenCalledExactlyOnceWith(actionItems[2]);
    expect(container.querySelector("[data-selected]")).toBeNull();
    expectHighlightStyles(remainingRow);
  });

  it("uses legible typography for enabled and disabled descriptions and timestamps", async () => {
    await renderPalette();
    expect(container.textContent).toContain("Open the first project");
    expect(container.textContent).toContain("Connect to use this command");
    expect(container.textContent).toContain("2m");

    const tokens = Array.from(container.querySelectorAll<HTMLElement>("[class]")).flatMap(
      (element) => Array.from(element.classList),
    );
    expect.soft(tokens).not.toContain("text-[10px]");
    expect.soft(tokens).not.toContain("text-muted-foreground/70");
  });
});
