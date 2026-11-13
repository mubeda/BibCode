// @vitest-environment happy-dom

import { ProviderInstanceId, type ServerProvider } from "@bibcode/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

// Settings are stable between renders, as in the app; a new favorites array per call would
// make the content recompute its list on every render.
const settings = vi.hoisted(() => ({ favorites: [] as unknown[], update: () => undefined }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (value: { favorites: unknown }) => T): T =>
    selector({ favorites: settings.favorites }),
  useUpdateClientSettings: () => settings.update,
}));

import { ProviderModelPicker } from "./ProviderModelPicker";

const codex: ProviderInstanceEntry = {
  instanceId: ProviderInstanceId.make("codex"),
  driverKind: "codex" as ProviderInstanceEntry["driverKind"],
  displayName: "Codex",
  accentColor: undefined,
  continuationGroupKey: undefined,
  enabled: true,
  installed: true,
  status: "ready",
  isDefault: true,
  isAvailable: true,
  snapshot: {} as ServerProvider,
  models: [],
};
const codexModels: ReadonlyArray<ModelEsque> = [
  { slug: "gpt-5", name: "GPT-5", shortName: "5" },
  { slug: "gpt-5-codex", name: "GPT-5 Codex", shortName: "Codex" },
];

let container: HTMLDivElement;
let root: Root;
let originalGetAnimations: PropertyDescriptor | undefined;

/** Owns `open` like the composer, whose imperative handle sets it without the picker. */
function Composer({ model = "gpt-5" }: { model?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-external-open onClick={() => setOpen(true)} />
      <button type="button" data-external-close onClick={() => setOpen(false)} />
      <ProviderModelPicker
        activeInstanceId={codex.instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={[codex]}
        modelOptionsByInstance={new Map([[codex.instanceId, codexModels]])}
        open={open}
        onOpenChange={setOpen}
        onInstanceModelChange={() => undefined}
      />
    </>
  );
}

function search(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Search models..."]');
  if (!input) throw new Error("Missing search input");
  return input;
}

async function press(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  await act(async () => element.click());
}

async function type(input: HTMLInputElement, value: string) {
  // React tracks the last value it set; go through the native setter so onChange sees a change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  if (originalGetAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("ProviderModelPicker with the real popover and content", () => {
  it("reopening through the controlled prop shows an empty search", async () => {
    await act(async () => root.render(<Composer />));
    await press("[data-external-open]");
    await type(search(), "gpt");
    expect(search().value).toBe("gpt");

    await press("[data-external-close]");
    await press("[data-external-open]");
    expect(search().value).toBe("");
    expect(document.activeElement).toBe(search());
  });

  it("reopening through the trigger shows an empty search", async () => {
    await act(async () => root.render(<Composer />));
    await press("[data-chat-provider-model-picker]");
    await type(search(), "gpt");
    expect(search().value).toBe("gpt");

    await press("[data-external-close]");
    await press("[data-chat-provider-model-picker]");
    expect(search().value).toBe("");
  });

  it("reopening after the model prop changed lists the new current model", async () => {
    await act(async () => root.render(<Composer />));
    await press("[data-external-open]");
    await type(search(), "codex");
    await press("[data-external-close]");

    await act(async () => root.render(<Composer model="gpt-5-codex" />));
    await press("[data-external-open]");
    expect(search().value).toBe("");
    // happy-dom lays out no virtualized rows; the combobox's form value names the current model.
    const selected = document.querySelector<HTMLInputElement>(
      "[data-model-picker-content] input[aria-hidden=true]",
    );
    expect(selected?.value).toBe("codex:gpt-5-codex");
  });
});
