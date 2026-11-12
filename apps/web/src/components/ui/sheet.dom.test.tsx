// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const host = vi.hoisted(() => ({ desktop: true }));
vi.mock("~/env", () => ({
  get isDesktopHost() {
    return host.desktop;
  },
}));

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { Sheet, SheetClose, SheetPopup, SheetTitle } from "./sheet";

let container: HTMLDivElement;
let root: Root;
let originalGetAnimations: PropertyDescriptor | undefined;
let platform: PropertyDescriptor | undefined;

const leases = () => useBrowserSurfaceStore.getState().occlusionOwners.size;

function Controlled({ keepMounted }: { readonly keepMounted?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-open-sheet onClick={() => setOpen(true)} />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup {...(keepMounted === undefined ? {} : { keepMounted })}>
          <SheetTitle>Panel</SheetTitle>
          <SheetClose data-close-sheet>Done</SheetClose>
        </SheetPopup>
      </Sheet>
    </>
  );
}

async function press(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  await act(async () => element.click());
}

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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  if (platform) Object.defineProperty(navigator, "platform", platform);
  else Reflect.deleteProperty(navigator, "platform");
  if (originalGetAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Sheet over a native preview on the macOS desktop app", () => {
  it("holds an occlusion lease while open and releases it when it closes", async () => {
    await act(async () => root.render(<Controlled />));
    expect(leases()).toBe(0);
    await press("[data-open-sheet]");
    expect(leases()).toBe(1);
    await press("[data-close-sheet]");
    expect(leases()).toBe(0);
  });

  it("holds no lease while a kept-mounted sheet is closed", async () => {
    await act(async () => root.render(<Controlled keepMounted />));
    expect(leases()).toBe(0);
    await press("[data-open-sheet]");
    expect(leases()).toBe(1);
    await press("[data-close-sheet]");
    expect(leases()).toBe(0);
  });

  it("releases the lease when the sheet unmounts while open", async () => {
    await act(async () => root.render(<Controlled />));
    await press("[data-open-sheet]");
    expect(leases()).toBe(1);
    await act(async () => root.render(null));
    expect(leases()).toBe(0);
  });

  it("takes no lease in the browser or off macOS", async () => {
    host.desktop = false;
    await act(async () => root.render(<Controlled />));
    await press("[data-open-sheet]");
    expect(leases()).toBe(0);
    await press("[data-close-sheet]");

    host.desktop = true;
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    await press("[data-open-sheet]");
    expect(leases()).toBe(0);
  });
});
