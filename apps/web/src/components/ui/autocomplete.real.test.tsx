// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "./autocomplete";

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

async function renderAutocomplete() {
  const onChoose = vi.fn();
  await act(async () => {
    root.render(
      <Autocomplete open inline mode="none" autoHighlight="always">
        <AutocompleteInput aria-label="Find an item" />
        <AutocompleteList>
          <AutocompleteItem value="Alpha">Alpha</AutocompleteItem>
          <AutocompleteItem value="Beta">Beta</AutocompleteItem>
          <AutocompleteItem value="Gamma" onClick={onChoose}>
            Gamma
          </AutocompleteItem>
          <AutocompleteItem value="Unavailable" disabled>
            Unavailable
          </AutocompleteItem>
        </AutocompleteList>
      </Autocomplete>,
    );
  });
  const input = container.querySelector("input");
  if (input === null) throw new Error("Autocomplete rendered no input.");
  await act(async () => input.focus());
  return { input, onChoose };
}

function items() {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-slot=autocomplete-item]"));
}

function expectHighlight(title: string) {
  const highlighted = items().filter((item) => item.hasAttribute("data-highlighted"));
  expect(highlighted).toHaveLength(1);
  expect(highlighted[0]?.textContent).toBe(title);
  expect(items()).toHaveLength(4);
  for (const item of items()) {
    expect(item.hasAttribute("data-selected")).toBe(false);
    expect(item.classList.contains("data-highlighted:bg-accent")).toBe(true);
    expect(item.classList.contains("data-highlighted:text-accent-foreground")).toBe(true);
  }
}

describe("Autocomplete with real Base UI items", () => {
  it.each(["Enter", "click"])(
    "moves the highlight without selecting, including after %s",
    async (activation) => {
      const { input, onChoose } = await renderAutocomplete();
      expectHighlight("Alpha");

      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expectHighlight("Beta");

      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expectHighlight("Gamma");

      await act(async () => {
        if (activation === "Enter") {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        } else {
          items()[2]?.click();
        }
      });
      expect(onChoose).toHaveBeenCalledOnce();
      expect(items()).toHaveLength(4);
      for (const item of items()) {
        expect(item.hasAttribute("data-selected")).toBe(false);
      }
    },
  );

  it("styles highlight and disabled states without dead selected-state classes", async () => {
    await renderAutocomplete();

    for (const item of items()) {
      expect.soft(item.className).not.toContain("data-selected");
      expect(item.classList.contains("hover:bg-accent")).toBe(true);
      expect(item.classList.contains("data-highlighted:bg-accent")).toBe(true);
      expect(item.classList.contains("data-highlighted:text-accent-foreground")).toBe(true);
      expect(item.classList.contains("data-disabled:pointer-events-none")).toBe(true);
      expect(item.classList.contains("data-disabled:opacity-64")).toBe(true);
    }
  });
});
