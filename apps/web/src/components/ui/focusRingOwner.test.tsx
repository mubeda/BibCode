import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Combobox, ComboboxChips, ComboboxChipsInput } from "./combobox";
import { InputGroup, InputGroupInput } from "./input-group";
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
