// @vitest-environment happy-dom
import {
  TERMINAL_TOKENS,
  UI_COLOR_TOKENS,
  UI_KEYWORD_TOKENS,
  UI_LENGTH_TOKENS,
  type ThemeFile,
} from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ThemeEditor } from "./ThemeEditor";
import {
  getTheme,
  handleThemesStorageEvent,
  saveCustomTheme,
  setSlot,
} from "../../themes/customThemes";

const mine: ThemeFile = {
  version: 1,
  id: "mine",
  name: "Mine",
  base: "dark",
  ui: { primary: "#3b82f6", background: "#101820" },
};

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

async function mount() {
  await act(async () => root.render(<ThemeEditor themeId="mine" onClose={onClose} />));
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}
const field = (key: string) => {
  const found = container.querySelector<HTMLElement>(`[data-theme-field="${key}"]`);
  if (!found) throw new Error(`No field ${key}`);
  return found;
};
const textOf = (key: string) =>
  field(key).querySelector<HTMLInputElement>('input:not([type="color"])')!;
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
const painted = (name: string) => document.documentElement.style.getPropertyValue(name);

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("bibcode:theme", "dark");
  handleThemesStorageEvent({ key: null });
  saveCustomTheme(mine);
  setSlot("dark", "mine");
  onClose.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  handleThemesStorageEvent({ key: null });
});

describe("ThemeEditor", () => {
  it("tokens are grouped as Surfaces, Text, Accent and focus, Status, Sidebar and Terminal and every supported token appears once", async () => {
    await mount();
    expect([...container.querySelectorAll("fieldset > legend")].map((l) => l.textContent)).toEqual([
      "Surfaces",
      "Text",
      "Accent and focus",
      "Status",
      "Sidebar",
      "Terminal",
    ]);
    const keys = [...container.querySelectorAll("[data-theme-field]")].map((element) =>
      element.getAttribute("data-theme-field"),
    );
    const expected = [
      ...[...UI_COLOR_TOKENS, ...UI_LENGTH_TOKENS, ...UI_KEYWORD_TOKENS].map((t) => `ui.${t}`),
      ...TERMINAL_TOKENS.map((t) => `terminal.${t}`),
    ];
    expect(keys.toSorted()).toEqual(expected.toSorted());
  });

  it("the Sidebar group offers every level token and shows the five-level preview", async () => {
    await mount();
    const sidebar = [...container.querySelectorAll("fieldset")].find(
      (fieldset) => fieldset.querySelector("legend")?.textContent === "Sidebar",
    )!;
    for (const token of [
      "sidebar-env-accent",
      "sidebar-primary-badge",
      "sidebar-primary-badge-foreground",
      "sidebar-worktree",
      "sidebar-worktree-border",
      "sidebar-worktree-icon",
      "sidebar-chat-foreground",
      "sidebar-indent-guide",
    ]) {
      expect(sidebar.querySelector(`[data-theme-field="ui.${token}"]`), token).not.toBeNull();
    }
    const preview = sidebar.querySelector('figure[aria-label="Sidebar preview"]')!;
    for (const level of ["repo", "environment", "checkout", "worktree", "chat"]) {
      expect(preview.querySelector(`[data-sidebar-level="${level}"]`), level).not.toBeNull();
    }
  });

  it("a custom worktree color repaints the preview's surface variable and is saved", async () => {
    await mount();
    await type(textOf("ui.sidebar-worktree"), "#123456");
    expect(painted("--sidebar-worktree")).toBe("#123456");
    await click(button("Save"));
    expect(getTheme("mine")?.ui?.["sidebar-worktree"]).toBe("#123456");
  });

  it("changing primary repaints at once and Cancel restores the saved color", async () => {
    await mount();
    await type(textOf("ui.primary"), "#ff0000");
    expect(painted("--primary")).toBe("#ff0000");
    await click(button("Cancel"));
    expect(painted("--primary")).toBe("#3b82f6");
    expect(getTheme("mine")?.ui?.primary).toBe("#3b82f6");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Save stores the theme and closes", async () => {
    await mount();
    await type(textOf("ui.primary"), "#ff0000");
    await click(button("Save"));
    expect(getTheme("mine")?.ui?.primary).toBe("#ff0000");
    expect(painted("--primary")).toBe("#ff0000");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Reset on one token returns it to the base value and keeps the others", async () => {
    await mount();
    await click(button("Reset Background"));
    expect(textOf("ui.background").value).toBe("");
    expect(painted("--background")).toBe("");
    expect(painted("--primary")).toBe("#3b82f6");
    await click(button("Save"));
    expect(getTheme("mine")?.ui).toEqual({ primary: "#3b82f6" });
  });

  it("Reset all clears every override after a confirmation", async () => {
    await mount();
    await click(button("Reset all"));
    expect(painted("--primary")).toBe("#3b82f6");
    await click(button("Keep my changes"));
    expect(textOf("ui.primary").value).toBe("#3b82f6");
    await click(button("Reset all"));
    await click(button("Reset all values"));
    expect(textOf("ui.primary").value).toBe("");
    expect(painted("--primary")).toBe("");
    await click(button("Save"));
    expect(getTheme("mine")?.ui).toBeUndefined();
  });

  it("typing url(x) shows an error on that field, does not repaint and disables Save", async () => {
    await mount();
    const input = textOf("ui.primary");
    await type(input, "url(x)");
    const error = field("ui.primary").querySelector(`#${input.getAttribute("aria-describedby")}`);
    expect(error?.textContent).toContain("Use a hex, rgb(), hsl() or oklch() color.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(painted("--primary")).toBe("#3b82f6");
    expect(button("Save").disabled).toBe(true);
    await type(input, "#00ff00");
    expect(button("Save").disabled).toBe(false);
    expect(painted("--primary")).toBe("#00ff00");
  });

  it("text equal to background shows 1:1 with a warning that names both tokens and Save still works", async () => {
    await mount();
    await type(textOf("ui.foreground"), "#101820");
    const pair = container.querySelector('[data-contrast-pair="foreground:background"]')!;
    expect(pair.textContent).toContain("1.00:1");
    expect(pair.textContent).toContain("Low contrast");
    expect(pair.textContent).toContain("foreground on background");
    expect(pair.querySelector("svg")).not.toBeNull();
    await click(button("Save"));
    expect(getTheme("mine")?.ui?.foreground).toBe("#101820");
  });

  it("a grey environment band warns on the sidebar muted text and the worktree icon is held to 3:1", async () => {
    await mount();
    await type(textOf("ui.sidebar-env-band"), "#444444");
    const muted = container.querySelector(
      '[data-contrast-pair="sidebar-card-muted-foreground:sidebar-env-band"]',
    )!;
    expect(muted.textContent).toContain("Low contrast");
    // About 3.4:1: under the 4.5:1 of text, over the 3:1 of a graphic.
    await type(textOf("ui.sidebar-worktree-icon"), "#a06a40");
    const icon = container.querySelector(
      '[data-contrast-pair="sidebar-worktree-icon:sidebar-worktree"]',
    )!;
    expect(icon.textContent).toContain("needs 3:1");
    expect(icon.textContent).not.toContain("Low contrast");
  });

  it("the Terminal group sets ANSI red and the saved theme carries terminal.red", async () => {
    await mount();
    await type(textOf("terminal.red"), "#ff5555");
    await click(button("Save"));
    expect(getTheme("mine")?.terminal).toEqual({ red: "#ff5555" });
  });

  it("the keyword tokens have labelled controls", async () => {
    await mount();
    const shadow = container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Sidebar card shadow"]',
    )!;
    expect(shadow.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[aria-label="Control shadows"]')?.textContent).toContain(
      "Default",
    );
    await click(shadow);
    await click(button("Save"));
    expect(getTheme("mine")?.ui?.["sidebar-card-shadow"]).toBe("none");
  });

  it("the length tokens state their range and reject a value outside it", async () => {
    await mount();
    expect(field("ui.radius").textContent).toContain("0rem to 1rem");
    expect(field("ui.focus-ring-width").textContent).toContain("1px to 3px");
    expect(field("ui.focus-ring-offset").textContent).toContain("0px to 3px");
    await type(textOf("ui.radius"), "2rem");
    expect(field("ui.radius").textContent).toContain("Use a length from 0rem to 1rem.");
    expect(button("Save").disabled).toBe(true);
    await type(textOf("ui.radius"), "0.5rem");
    await click(button("Save"));
    expect(getTheme("mine")?.ui?.radius).toBe("0.5rem");
  });

  it("saving in another window while the editor is open does not overwrite the draft, and Cancel then shows the newly stored theme", async () => {
    await mount();
    await type(textOf("ui.primary"), "#ff0000");
    await act(async () => {
      saveCustomTheme({ ...mine, ui: { primary: "#00ff00" } });
      handleThemesStorageEvent({ key: "bibcode:themes:v1" });
    });
    expect(textOf("ui.primary").value).toBe("#ff0000");
    expect(painted("--primary")).toBe("#ff0000");
    await click(button("Cancel"));
    expect(painted("--primary")).toBe("#00ff00");
  });
});
