// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - The focus ring checks read the checked-in stylesheet.
import * as NodeFS from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "./button";
import { Combobox, ComboboxChips, ComboboxChipsInput } from "./combobox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./input-group";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "./number-field";
import { Textarea } from "./textarea";

/** The element with `data-slot="<slot>"` carries the focus ring owner marker (#290, R59). */
function ownsFocusRing(markup: string, slot: string): boolean {
  const tag = new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`).exec(markup)?.[0] ?? "";
  return tag.includes('data-focus-ring-owner=""');
}

describe("focus ring owners", () => {
  it.each([
    ["textarea-control", () => <Textarea aria-label="Notes" />],
    [
      "input-group",
      () => (
        <InputGroup>
          <InputGroupInput aria-label="Search" />
        </InputGroup>
      ),
    ],
    [
      "number-field-group",
      () => (
        <NumberField defaultValue={1}>
          <NumberFieldGroup>
            <NumberFieldInput />
          </NumberFieldGroup>
        </NumberField>
      ),
    ],
    [
      "combobox-chips",
      () => (
        <Combobox multiple items={["a"]}>
          <ComboboxChips>
            <ComboboxChipsInput aria-label="Tags" />
          </ComboboxChips>
        </Combobox>
      ),
    ],
  ])("the %s wrapper that draws the ring when its control is focused is marked", (slot, render) => {
    expect(ownsFocusRing(renderToStaticMarkup(render()), slot)).toBe(true);
  });
});

/** The unlayered theme focus ring rules of index.css, which happy-dom applies (#290, R59). */
function focusRingRules(): string {
  const css = NodeFS.readFileSync(`${import.meta.dirname}/../../index.css`, "utf8");
  const start = css.indexOf("/* A theme's focus ring");
  const end = css.indexOf("/* Removes the drop shadows");
  if (start < 0 || end < start) throw new Error("index.css has no theme focus ring block");
  // happy-dom drops a selector list that breaks a line inside :not(), so the text is joined.
  return css.slice(start, end).replace(/\s+/g, " ");
}

describe("an input group under a theme focus ring", () => {
  async function mountGroup() {
    const style = document.createElement("style");
    style.textContent = focusRingRules();
    document.head.append(style);
    const html = document.documentElement;
    html.setAttribute("data-theme-focus-ring", "");
    html.style.setProperty("--ring", "#16a34a");
    html.style.setProperty("--focus-ring-width", "2px");
    html.style.setProperty("--focus-ring-offset", "2px");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <InputGroup>
          <InputGroupInput aria-label="Address" />
          <InputGroupAddon align="inline-end">
            <Button aria-label="Open" size="icon-xs" variant="ghost" />
          </InputGroupAddon>
        </InputGroup>,
      ),
    );
    return {
      group: host.querySelector<HTMLElement>('[data-slot="input-group"]')!,
      input: host.querySelector("input")!,
      button: host.querySelector("button")!,
      async unmount() {
        await act(async () => root.unmount());
        host.remove();
        style.remove();
        html.removeAttribute("data-theme-focus-ring");
        for (const name of ["--ring", "--focus-ring-width", "--focus-ring-offset"]) {
          html.style.removeProperty(name);
        }
      },
    };
  }

  it("the group draws the outline for its text field", async () => {
    const { group, input, unmount } = await mountGroup();
    input.focus();
    expect(getComputedStyle(group).outlineStyle).toBe("solid");
    expect(getComputedStyle(input).outlineStyle).not.toBe("solid");
    await unmount();
  });

  it("a button in an addon keeps its own outline and the group draws none", async () => {
    const { group, button, unmount } = await mountGroup();
    button.focus();
    expect(getComputedStyle(button).outlineStyle).toBe("solid");
    expect(getComputedStyle(group).outlineStyle).not.toBe("solid");
    await unmount();
  });
});
