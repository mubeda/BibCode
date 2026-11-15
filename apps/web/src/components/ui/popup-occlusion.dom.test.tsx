// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const host = vi.hoisted(() => ({ desktop: true }));
vi.mock("~/env", () => ({
  get isDesktopHost() {
    return host.desktop;
  },
}));

import {
  acquireBrowserSurface,
  isBrowserSurfaceOccluded,
  useBrowserSurfaceStore,
} from "~/browser/browserSurfaceStore";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteList,
  AutocompletePopup,
} from "./autocomplete";
import { Combobox, ComboboxInput, ComboboxList, ComboboxPopup } from "./combobox";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

let container: HTMLDivElement;
let root: Root;
let originalGetAnimations: PropertyDescriptor | undefined;
let platform: PropertyDescriptor | undefined;
let frames: FrameRequestCallback[] = [];

const owners = () => useBrowserSurfaceStore.getState().occlusionOwners;

function flushFrames() {
  const pending = frames;
  frames = [];
  act(() => {
    for (const frame of pending) frame(0);
  });
}

function PopoverCase({ open }: { open: boolean }) {
  return (
    <Popover open={open}>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverPopup>Inside</PopoverPopup>
    </Popover>
  );
}

const cases: Array<[string, (props: { open: boolean }) => ReactNode]> = [
  ["Popover", PopoverCase],
  [
    "Menu",
    ({ open }) => (
      <Menu open={open}>
        <MenuTrigger>Open</MenuTrigger>
        <MenuPopup>
          <MenuItem>Item</MenuItem>
        </MenuPopup>
      </Menu>
    ),
  ],
  [
    "Select",
    ({ open }) => (
      <Select open={open} items={[{ value: "a", label: "A" }]}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="a">A</SelectItem>
        </SelectPopup>
      </Select>
    ),
  ],
  [
    "Combobox",
    ({ open }) => (
      <Combobox open={open} items={["a"]}>
        <ComboboxInput aria-label="Pick" />
        <ComboboxPopup>
          <ComboboxList>{(item: string) => <span key={item}>{item}</span>}</ComboboxList>
        </ComboboxPopup>
      </Combobox>
    ),
  ],
  [
    "Autocomplete",
    ({ open }) => (
      <Autocomplete open={open} items={["a"]}>
        <AutocompleteInput aria-label="Find" />
        <AutocompletePopup>
          <AutocompleteList>{(item: string) => <span key={item}>{item}</span>}</AutocompleteList>
        </AutocompletePopup>
      </Autocomplete>
    ),
  ],
];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  platform = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  host.desktop = true;
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    // A cancelled frame must not run; ids are positions in the current queue.
    if (frames[id - 1]) frames[id - 1] = () => undefined;
  });
  useBrowserSurfaceStore.setState({ byTabId: {}, occlusionOwners: new Map() });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  if (platform) Object.defineProperty(navigator, "platform", platform);
  else Reflect.deleteProperty(navigator, "platform");
  if (originalGetAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe.each(cases)("%s on the macOS desktop app", (_name, Case) => {
  it("leases its rectangle while open and releases it when it closes", async () => {
    await act(async () => root.render(<Case open={false} />));
    expect(owners().size).toBe(0);

    await act(async () => root.render(<Case open />));
    expect(owners().size).toBe(1);
    expect([...owners().values()][0]).not.toBeNull();

    await act(async () => root.render(<Case open={false} />));
    expect(owners().size).toBe(0);
  });

  it("releases the lease when it unmounts while open", async () => {
    await act(async () => root.render(<Case open />));
    expect(owners().size).toBe(1);
    await act(async () => root.render(null));
    expect(owners().size).toBe(0);
  });

  it("takes no lease in the browser or off macOS", async () => {
    host.desktop = false;
    await act(async () => root.render(<Case open />));
    expect(owners().size).toBe(0);
    await act(async () => root.render(null));

    host.desktop = true;
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    await act(async () => root.render(<Case open />));
    expect(owners().size).toBe(0);
  });
});

describe("a kept-mounted popover", () => {
  it("marks its positioner open only while open, and holds no lease when it never opened", async () => {
    await act(async () => root.render(<PopoverCase open={false} />));
    const positioner = document.querySelector("[data-slot=popover-positioner]");
    expect(positioner).not.toBeNull();
    expect(positioner?.hasAttribute("data-open")).toBe(false);
    expect(owners().size).toBe(0);

    await act(async () => root.render(<PopoverCase open />));
    expect(positioner?.hasAttribute("data-open")).toBe(true);

    await act(async () => root.render(<PopoverCase open={false} />));
    expect(document.querySelector("[data-slot=popover-positioner]")).toBe(positioner);
    expect(positioner?.hasAttribute("data-open")).toBe(false);
    expect(owners().size).toBe(0);
  });

  it("follows the popup when it moves without resizing", async () => {
    const surfaceRect = { x: 0, y: 0, width: 400, height: 300 };
    const surface = acquireBrowserSurface("tab");
    surface.present(surfaceRect, true);
    const box = { x: 500, y: 0, width: 120, height: 80 };

    await act(async () => root.render(<PopoverCase open={false} />));
    const positioner = document.querySelector<HTMLElement>("[data-slot=popover-positioner]");
    if (!positioner) throw new Error("Missing positioner");
    positioner.getBoundingClientRect = () => DOMRect.fromRect(box);

    await act(async () => root.render(<PopoverCase open />));
    flushFrames();
    expect([...owners().values()]).toEqual([box]);
    expect(isBrowserSurfaceOccluded(surfaceRect, owners())).toBe(false);

    box.x = 100;
    box.y = 100;
    flushFrames();
    expect([...owners().values()]).toEqual([{ x: 100, y: 100, width: 120, height: 80 }]);
    expect(isBrowserSurfaceOccluded(surfaceRect, owners())).toBe(true);

    box.x = 450;
    flushFrames();
    expect([...owners().values()]).toEqual([{ x: 450, y: 100, width: 120, height: 80 }]);
    expect(isBrowserSurfaceOccluded(surfaceRect, owners())).toBe(false);

    await act(async () => root.render(<PopoverCase open={false} />));
    expect(owners().size).toBe(0);
    surface.release();
  });
});

describe("a tooltip", () => {
  it("holds no lease while open", async () => {
    await act(async () =>
      root.render(
        <Tooltip open>
          <TooltipTrigger>Hint</TooltipTrigger>
          <TooltipPopup>Text</TooltipPopup>
        </Tooltip>,
      ),
    );
    expect(document.body.textContent).toContain("Text");
    expect(owners().size).toBe(0);
  });
});
