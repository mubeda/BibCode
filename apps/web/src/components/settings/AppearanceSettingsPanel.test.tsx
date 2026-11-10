// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DesktopBridge } from "@bibcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { toastAdd, toastClose } = vi.hoisted(() => ({
  toastAdd: vi.fn((_toast: unknown) => "toast-1"),
  toastClose: vi.fn(),
}));
vi.mock("../ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast")>()),
  toastManager: { add: toastAdd, close: toastClose },
}));

import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";
import {
  deleteCustomTheme,
  getTheme,
  handleThemesStorageEvent,
  readSlots,
  saveCustomTheme,
  setSlot,
} from "../../themes/customThemes";
import { resolveToken } from "../../themes/themeColor";

let container: HTMLDivElement;
let root: Root;

async function mount() {
  await act(async () => root.render(<AppearanceSettingsPanel />));
}

// The row menu renders in a portal, so buttons and menu items are looked up in the document.
const buttons = () => [...document.querySelectorAll<HTMLElement>("button, [role=menuitem]")];
function button(name: string): HTMLElement {
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
/** The row's own control: the whole row applies the theme. */
const select = (id: string) => row(id).querySelector<HTMLButtonElement>("[data-theme-select]")!;
async function menuAction(themeName: string, action: string) {
  await click(button(`More actions for ${themeName}`));
  await click(button(action));
}
const mode = () => window.localStorage.getItem("bibcode:theme");
/** The inline status line that offers Undo after a row switched the mode. */
const undoButton = () => container.querySelector<HTMLButtonElement>('[role="status"] button');
async function undo() {
  const found = undoButton();
  if (!found) throw new Error("No Undo offered");
  expect(found.textContent).toBe("Undo");
  await click(found);
}
const rootStyle = (name: string) => document.documentElement.style.getPropertyValue(name);
const showsDark = () => document.documentElement.classList.contains("dark");
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  vi.restoreAllMocks();
  toastAdd.mockClear();
  toastClose.mockClear();
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

  it("the six built-ins are listed in order within their base's group, then custom themes, each with a preview", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    await mount();
    expect(rowNames()).toEqual([
      "light",
      "matrix-light",
      "verdant-light",
      "dark",
      "tokyo-night",
      "matrix-dark",
      "mine",
    ]);
    expect(row("mine").textContent).toContain("Custom");
    expect(row("tokyo-night").querySelectorAll("[data-swatch]")).toHaveLength(5);
  });

  it("a built-in row offers Duplicate only, a custom row offers Edit, Duplicate, Export and Delete, in a menu outside the row's control", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    await mount();
    const actions = async (name: string) => {
      await click(button(`More actions for ${name}`));
      const items = [...document.querySelectorAll("[role=menuitem][data-theme-action]")].map(
        (element) => element.getAttribute("data-theme-action"),
      );
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      return items;
    };
    expect(await actions("Tokyo Night")).toEqual(["duplicate"]);
    expect(await actions("Mine")).toEqual(["edit", "duplicate", "export", "delete"]);
    expect(select("mine").contains(button("More actions for Mine"))).toBe(false);
  });

  it("themes are grouped under Light themes and Dark themes, and the group on screen says Showing now", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    await mount();
    const group = (label: string) =>
      container.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`)!;
    const ids = (label: string) =>
      [...group(label).querySelectorAll("[data-theme-row]")].map((element) =>
        element.getAttribute("data-theme-row"),
      );
    expect(ids("Light themes")).toEqual(["light", "matrix-light", "verdant-light"]);
    expect(ids("Dark themes")).toEqual(["dark", "tokyo-night", "matrix-dark", "mine"]);
    expect(group("Light themes").textContent).toContain("Showing now");
    expect(group("Dark themes").textContent).not.toContain("Showing now");
  });

  it("the theme in use in each group is marked with a check, In use and aria-pressed", async () => {
    await mount();
    expect(select("light").getAttribute("aria-pressed")).toBe("true");
    expect(select("dark").getAttribute("aria-pressed")).toBe("true");
    expect(select("tokyo-night").getAttribute("aria-pressed")).toBe("false");
    expect(select("dark").textContent).toContain("In use");
    expect(select("dark").querySelector("[data-theme-in-use-icon]")).not.toBeNull();
    expect(select("tokyo-night").textContent).not.toContain("In use");
    expect(select("tokyo-night").querySelector("[data-theme-in-use-icon]")).toBeNull();
  });

  it("clicking a dark theme in Light mode applies it, switches to Dark, and Undo restores Light and the previous dark theme", async () => {
    setSlot("dark", "matrix-dark");
    await mount();
    await click(select("tokyo-night"));
    expect(readSlots().dark).toBe("tokyo-night");
    expect(mode()).toBe("dark");
    expect(showsDark()).toBe(true);
    expect(rootStyle("--background")).toBe(resolveToken(getTheme("tokyo-night")!, "background"));
    expect(select("tokyo-night").getAttribute("aria-pressed")).toBe("true");
    // The line sits after the clicked row's group, so no row above the pointer moves.
    const darkGroup = container.querySelector('[role="group"][aria-label="Dark themes"]')!;
    const status = darkGroup.querySelector('[role="status"]')!;
    expect(status.textContent).toContain("Switched to dark mode to show Tokyo Night.");
    expect(
      row("matrix-dark").compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(2);

    await undo();
    expect(mode()).toBe("light");
    expect(readSlots().dark).toBe("matrix-dark");
    expect(showsDark()).toBe(false);
    expect(undoButton()).toBeNull();
    expect(document.activeElement).toBe(select("tokyo-night"));
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("clicking a dark theme while System shows light switches to Dark, and Undo returns to System", async () => {
    window.localStorage.setItem("bibcode:theme", "system");
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    await mount();
    expect(showsDark()).toBe(false);
    await click(select("matrix-dark"));
    expect(mode()).toBe("dark");
    expect(readSlots().dark).toBe("matrix-dark");
    expect(rootStyle("--background")).toBe(resolveToken(getTheme("matrix-dark")!, "background"));

    await undo();
    expect(mode()).toBe("system");
    expect(readSlots().dark).toBe("dark");
    expect(showsDark()).toBe(false);
  });

  it("clicking a theme of the base on screen applies it without changing the mode or offering Undo", async () => {
    window.localStorage.setItem("bibcode:theme", "dark");
    await mount();
    await click(select("tokyo-night"));
    expect(readSlots().dark).toBe("tokyo-night");
    expect(mode()).toBe("dark");
    expect(rootStyle("--background")).toBe(resolveToken(getTheme("tokyo-night")!, "background"));
    expect(undoButton()).toBeNull();
  });

  it("a Mode change withdraws the Undo, and returning to the same mode does not bring it back", async () => {
    window.localStorage.setItem("bibcode:theme", "dark");
    await mount();
    await click(select("verdant-light"));
    expect(mode()).toBe("light");
    expect(readSlots().light).toBe("verdant-light");
    expect(showsDark()).toBe(false);
    expect(undoButton()).not.toBeNull();

    await click(button("Dark"));
    expect(undoButton()).toBeNull();
    await click(button("Light"));
    expect(undoButton()).toBeNull();
  });

  it("a newer theme choice in the same slot withdraws the Undo", async () => {
    await mount();
    await click(select("tokyo-night"));
    await click(select("matrix-dark"));
    expect(undoButton()).toBeNull();
    expect(readSlots().dark).toBe("matrix-dark");
  });

  it("another window changing the slot withdraws the Undo", async () => {
    await mount();
    await click(select("tokyo-night"));
    await act(async () => {
      setSlot("dark", "matrix-dark");
      handleThemesStorageEvent({ key: null });
    });
    expect(undoButton()).toBeNull();
    expect(mode()).toBe("dark");
    expect(readSlots().dark).toBe("matrix-dark");
  });

  it("deleting the previous theme withdraws the Undo instead of reverting only the mode", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    setSlot("dark", "mine");
    await mount();
    await click(select("tokyo-night"));
    expect(undoButton()).not.toBeNull();
    await act(async () => {
      deleteCustomTheme("mine");
    });
    expect(undoButton()).toBeNull();
    expect(mode()).toBe("dark");
    expect(readSlots().dark).toBe("tokyo-night");
  });

  it("replacing the previous theme with a light theme of the same id withdraws the Undo", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    setSlot("dark", "mine");
    await mount();
    await click(select("tokyo-night"));
    await act(async () => {
      saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "light" });
    });
    expect(undoButton()).toBeNull();
    expect(mode()).toBe("dark");
  });

  it("an Undo that cannot save the slot keeps the mode and says so", async () => {
    setSlot("dark", "matrix-dark");
    await mount();
    await click(select("tokyo-night"));
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await undo();
    setItem.mockRestore();
    expect(mode()).toBe("dark");
    expect(readSlots().dark).toBe("tokyo-night");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not undo the theme choice.",
    );
  });

  it("a remounted panel offers no Undo for an earlier click", async () => {
    await mount();
    await click(select("tokyo-night"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(undoButton()).toBeNull();
    expect(mode()).toBe("dark");
  });

  it("the row menu button reserves its touch target in the layout", async () => {
    await mount();
    const trigger = button("More actions for Tokyo Night");
    expect(trigger.parentElement?.className).toContain("pointer-coarse:size-11");
    expect(select("tokyo-night").contains(trigger.parentElement)).toBe(false);
  });

  it("a secondary action runs without applying the row's theme", async () => {
    await mount();
    await menuAction("Tokyo Night", "Duplicate");
    expect(container.textContent).toContain("Tokyo Night copy");
    expect(readSlots().dark).toBe("dark");
    expect(mode()).toBe("light");
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("rows are native buttons (Enter and Space click them) and arrow keys move between rows", async () => {
    window.localStorage.setItem("bibcode:theme", "dark");
    await mount();
    const key = async (target: HTMLElement, name: string) =>
      act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
      });
    select("dark").focus();
    await key(select("dark"), "ArrowDown");
    expect(document.activeElement).toBe(select("tokyo-night"));
    await key(select("tokyo-night"), "ArrowUp");
    expect(document.activeElement).toBe(select("dark"));
    expect(select("tokyo-night").tagName).toBe("BUTTON");
    expect(select("tokyo-night").type).toBe("button");
    await click(select("tokyo-night"));
    expect(readSlots().dark).toBe("tokyo-night");
  });

  it('Duplicate on Tokyo Night adds "Tokyo Night copy"', async () => {
    await mount();
    await menuAction("Tokyo Night", "Duplicate");
    expect(container.textContent).toContain("Tokyo Night copy");
  });

  it("Delete asks for confirmation, cancel changes nothing, confirm removes the theme and the slot falls back to Dark", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    setSlot("dark", "mine");
    await mount();
    await menuAction("Mine", "Delete");
    expect(container.textContent).toContain("Delete Mine?");
    await vi.waitFor(() => expect(document.activeElement).toBe(button("Cancel")));
    await click(button("Cancel"));
    expect(getTheme("mine")).toBeDefined();
    expect(readSlots().dark).toBe("mine");
    expect(document.activeElement).toBe(button("More actions for Mine"));

    await menuAction("Mine", "Delete");
    await click(button("Delete theme"));
    expect(getTheme("mine")).toBeUndefined();
    expect(readSlots().dark).toBe("dark");
    expect(rowNames()).not.toContain("mine");
  });

  it("after Delete theme, focus moves to the next row, else the previous one", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    saveCustomTheme({ version: 1, id: "mine-2", name: "Mine 2", base: "dark" });
    await mount();
    await menuAction("Mine", "Delete");
    await click(button("Delete theme"));
    expect(document.activeElement).toBe(select("mine-2"));

    await menuAction("Mine 2", "Delete");
    await click(button("Delete theme"));
    expect(document.activeElement).toBe(select("matrix-dark"));
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
    expect(container.querySelector("[data-theme-editor]")).toBeNull();

    await click(container.querySelector<HTMLInputElement>('input[value="dark"]')!);
    await type(name, "Night shift");
    await click(button("Create theme"));
    const editor = container.querySelector("[data-theme-editor]");
    expect(editor).not.toBeNull();
    const created = getTheme(editor!.getAttribute("data-theme-editor")!);
    expect(created).toMatchObject({ name: "Night shift", base: "dark" });
    expect(created?.ui).toBeUndefined();

    await click(button("Cancel"));
    expect(container.querySelector("[data-theme-editor]")).toBeNull();
    expect(document.activeElement).toBe(button("More actions for Night shift"));
  });

  it("Export downloads the theme as <id>.theme.json", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:theme");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let downloaded: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });
    await mount();
    await menuAction("Mine", "Export");
    expect(downloaded).toBe("mine.theme.json");
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(JSON.parse(await blob.text())).toMatchObject({ id: "mine", name: "Mine" });
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:theme"));
  });

  describe("Export in the desktop app", () => {
    const saveTextFile = vi.fn<NonNullable<DesktopBridge["saveTextFile"]>>();
    beforeEach(() => {
      saveTextFile.mockReset();
      window.desktopBridge = { saveTextFile } as unknown as DesktopBridge;
      saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    });
    afterEach(() => {
      delete window.desktopBridge;
    });

    it("Export in the desktop app saves through the bridge with <id>.theme.json", async () => {
      saveTextFile.mockResolvedValue("/chosen/mine.theme.json");
      const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
      await mount();
      await menuAction("Mine", "Export");
      expect(saveTextFile).toHaveBeenCalledOnce();
      const input = saveTextFile.mock.calls[0]![0];
      expect(input.suggestedName).toBe("mine.theme.json");
      expect(JSON.parse(input.contents)).toMatchObject({ id: "mine", name: "Mine" });
      expect(anchorClick).not.toHaveBeenCalled();
      expect(toastAdd).not.toHaveBeenCalled();
    });

    it("a cancelled save writes nothing and shows no error", async () => {
      saveTextFile.mockResolvedValue(null);
      await mount();
      await menuAction("Mine", "Export");
      expect(saveTextFile).toHaveBeenCalledOnce();
      expect(toastAdd).not.toHaveBeenCalled();
    });

    it("a failed save shows an error", async () => {
      saveTextFile.mockRejectedValue(new Error("Could not save the file: disk full"));
      await mount();
      await menuAction("Mine", "Export");
      await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledOnce());
      expect(toastAdd.mock.calls[0]![0]).toMatchObject({
        type: "error",
        description: "Could not save the file: disk full",
      });
    });
  });

  it("Export in the browser keeps the download link", async () => {
    saveCustomTheme({ version: 1, id: "mine", name: "Mine", base: "dark" });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:theme");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    expect(window.desktopBridge).toBeUndefined();
    await mount();
    await menuAction("Mine", "Export");
    expect(anchorClick).toHaveBeenCalledOnce();
  });

  it("Import theme opens the import dialog", async () => {
    await mount();
    await click(button("Import theme"));
    expect(document.body.textContent).toContain("Choose a .json theme file or paste its contents.");
  });

  it("with no custom themes the six built-ins and the New theme action are shown", async () => {
    await mount();
    expect(rowNames()).toHaveLength(6);
    expect(button("New theme")).toBeDefined();
  });
});
