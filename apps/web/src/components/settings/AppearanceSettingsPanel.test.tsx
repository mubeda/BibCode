// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";
import {
  getTheme,
  handleThemesStorageEvent,
  readSlots,
  saveCustomTheme,
  setSlot,
} from "../../themes/customThemes";

let container: HTMLDivElement;
let root: Root;
const onEdit = vi.fn();

async function mount() {
  await act(async () => root.render(<AppearanceSettingsPanel onEdit={onEdit} />));
}

const buttons = () => [...container.querySelectorAll("button")];
function button(name: string): HTMLButtonElement {
  const found = buttons().find(
    (element) =>
      element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}
const rowNames = () =>
  [...container.querySelectorAll("[data-theme-row]")].map((row) =>
    row.getAttribute("data-theme-row"),
  );
const row = (id: string) => container.querySelector(`[data-theme-row="${id}"]`)!;
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("bibcode:theme", "light");
  handleThemesStorageEvent({ key: null });
  onEdit.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
});

describe("AppearanceSettingsPanel", () => {
  it("the mode select offers System, Light and Dark", async () => {
    await mount();
    const group = container.querySelector('[role="group"][aria-label="Mode"]')!;
    expect([...group.querySelectorAll("button")].map((element) => element.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(button("Light").getAttribute("aria-pressed")).toBe("true");
    await click(button("Dark"));
    expect(window.localStorage.getItem("bibcode:theme")).toBe("dark");
  });

  it("the six built-ins are listed in order, then custom themes, each with its base and a preview", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    await mount();
    expect(rowNames()).toEqual([
      "light",
      "dark",
      "tokyo-night",
      "matrix-dark",
      "matrix-light",
      "verdant-light",
      "mine",
    ]);
    expect(row("tokyo-night").textContent).toContain("Dark base");
    expect(row("verdant-light").textContent).toContain("Light base");
    expect(row("mine").textContent).toContain("Custom");
    expect(row("tokyo-night").querySelectorAll("[data-swatch]")).toHaveLength(5);
  });

  it("a built-in row offers Duplicate only, a custom row offers Edit, Duplicate, Export and Delete", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    await mount();
    const actions = (id: string) =>
      [...row(id).querySelectorAll("[data-theme-action]")].map((element) =>
        element.getAttribute("data-theme-action"),
      );
    expect(actions("tokyo-night")).toEqual(["duplicate"]);
    expect(actions("mine")).toEqual(["edit", "duplicate", "export", "delete"]);
  });

  it("Use for dark puts the theme in the dark slot and marks the row", async () => {
    await mount();
    await click(button("Use Tokyo Night for dark"));
    expect(readSlots().dark).toBe("tokyo-night");
    expect(row("tokyo-night").textContent).toContain("In use for dark");
  });

  it('picking a dark theme in Light mode keeps the mode and offers "Switch to dark now", which sets the mode to Dark', async () => {
    await mount();
    await click(button("Use Matrix Dark for dark"));
    expect(window.localStorage.getItem("bibcode:theme")).toBe("light");
    await click(button("Switch to dark now"));
    expect(window.localStorage.getItem("bibcode:theme")).toBe("dark");
  });

  it('Duplicate on Tokyo Night adds "Tokyo Night copy"', async () => {
    await mount();
    await click(button("Duplicate Tokyo Night"));
    expect(container.textContent).toContain("Tokyo Night copy");
  });

  it("Delete asks for confirmation, cancel changes nothing, confirm removes the theme and the slot falls back to Dark", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    setSlot("dark", "mine");
    await mount();
    await click(button("Delete Mine"));
    expect(container.textContent).toContain("Delete Mine?");
    await click(button("Cancel"));
    expect(getTheme("mine")).toBeDefined();
    expect(readSlots().dark).toBe("mine");

    await click(button("Delete Mine"));
    await click(button("Delete theme"));
    expect(getTheme("mine")).toBeUndefined();
    expect(readSlots().dark).toBe("dark");
    expect(rowNames()).not.toContain("mine");
  });

  it("New theme asks for a base and a name, rejects an empty name and a name over 48 characters with the rule that failed, and opens the editor", async () => {
    await mount();
    await click(button("New theme"));
    const name = container.querySelector<HTMLInputElement>('input[name="theme-name"]')!;
    await click(button("Create theme"));
    expect(container.textContent).toContain("Enter a name.");
    await type(name, "x".repeat(49));
    await click(button("Create theme"));
    expect(container.textContent).toContain("Use 48 characters or fewer.");
    expect(onEdit).not.toHaveBeenCalled();

    await click(container.querySelector<HTMLInputElement>('input[value="dark"]')!);
    await type(name, "Night shift");
    await click(button("Create theme"));
    expect(onEdit).toHaveBeenCalledOnce();
    const created = getTheme(onEdit.mock.calls[0]![0] as string);
    expect(created).toMatchObject({ name: "Night shift", base: "dark" });
    expect(created?.ui).toBeUndefined();
  });

  it("with no custom themes the six built-ins and the New theme action are shown", async () => {
    await mount();
    expect(rowNames()).toHaveLength(6);
    expect(button("New theme")).toBeDefined();
  });
});
