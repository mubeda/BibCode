// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ThemeImportDialog } from "./ThemeImportDialog";
import { getTheme, handleThemesStorageEvent, saveCustomTheme } from "../../themes/customThemes";

const night = {
  version: 1,
  id: "night",
  name: "Night",
  base: "dark",
  ui: { primary: "#1d4ed8" },
} as const;

let container: HTMLDivElement;
let root: Root;
const onOpenChange = vi.fn();
let originalGetAnimations: PropertyDescriptor | undefined;

async function mount() {
  await act(async () => root.render(<ThemeImportDialog open onOpenChange={onOpenChange} />));
}
function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function paste(text: string) {
  const area = document.querySelector<HTMLTextAreaElement>("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const dialogText = () => document.querySelector('[data-slot="dialog-popup"]')?.textContent ?? "";

beforeEach(() => {
  originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  window.localStorage.clear();
  handleThemesStorageEvent({ key: null });
  onOpenChange.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalGetAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  }
  window.localStorage.clear();
  handleThemesStorageEvent({ key: null });
});

describe("ThemeImportDialog", () => {
  it("pasted JSON with errors lists each field and its message and stores nothing", async () => {
    await mount();
    await paste(JSON.stringify({ ...night, ui: { primary: "url(x)" }, terminal: { red: "red" } }));
    await click(button("Validate"));
    const items = [...document.querySelectorAll("[data-import-error]")].map(
      (item) => item.textContent,
    );
    expect(items).toEqual([
      "ui.primary: Use a hex, rgb(), hsl() or oklch() color.",
      "terminal.red: Use a hex, rgb(), hsl() or oklch() color.",
    ]);
    expect(getTheme("night")).toBeUndefined();
    expect(() => button("Import")).toThrow();
  });

  it("a file over 16 KiB is refused by its size before it is read", async () => {
    await mount();
    const file = new File([JSON.stringify(night)], "night.theme.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "size", { value: 16 * 1024 + 1 });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {});
    const items = [...document.querySelectorAll("[data-import-error]")].map(
      (item) => item.textContent,
    );
    expect(items).toEqual(["file: A theme file can be at most 16 KiB."]);
    expect(() => button("Import")).toThrow();
  });

  it("a valid file with a conflict asks Replace or Keep both before storing", async () => {
    saveCustomTheme({ ...night, ui: { primary: "#00ff00" } });
    await mount();
    await paste(JSON.stringify(night));
    await click(button("Validate"));
    expect(dialogText()).toContain("A theme with the id night already exists.");
    expect(getTheme("night")?.ui?.primary).toBe("#00ff00");
    await click(button("Keep both"));
    expect(getTheme("night")?.ui?.primary).toBe("#00ff00");
    expect(dialogText()).toContain("Imported Night.");
  });

  it("Import asks Replace or Keep both when another window stored the same id after Validate", async () => {
    await mount();
    await paste(JSON.stringify(night));
    await click(button("Validate"));
    saveCustomTheme({ ...night, ui: { primary: "#00ff00" } });
    await click(button("Import"));
    expect(getTheme("night")?.ui?.primary).toBe("#00ff00");
    expect(dialogText()).toContain("A theme with the id night already exists.");
    await click(button("Replace"));
    expect(getTheme("night")?.ui?.primary).toBe("#1d4ed8");
    expect(dialogText()).toContain("Imported Night.");
  });

  it("Done and Cancel close the dialog and the next opening starts empty", async () => {
    await mount();
    await paste(JSON.stringify(night));
    await click(button("Validate"));
    await click(button("Import"));
    await click(button("Done"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(document.querySelector("textarea")?.value).toBe("");
    await paste("{}");
    await click(button("Cancel"));
    expect(document.querySelector("textarea")?.value).toBe("");
  });

  it("after import a notice names the pairs that were reset to base values", async () => {
    await mount();
    await paste(JSON.stringify({ ...night, ui: { ...night.ui, "muted-foreground": "#484d55" } }));
    await click(button("Validate"));
    await click(button("Import"));
    expect(getTheme("night")?.ui?.["muted-foreground"]).toBeUndefined();
    const notice = document.querySelector('[role="status"]')?.textContent ?? "";
    expect(notice).toContain("Imported Night.");
    expect(notice).toContain("Muted text on background");
  });
});
