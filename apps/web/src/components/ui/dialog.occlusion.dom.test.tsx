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
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./alert-dialog";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "./dialog";

let container: HTMLDivElement;
let root: Root;
let originalGetAnimations: PropertyDescriptor | undefined;
let platform: PropertyDescriptor | undefined;

const leases = () => useBrowserSurfaceStore.getState().occlusionOwners.size;

function DialogCase() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-open onClick={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogTitle>Panel</DialogTitle>
          <DialogClose data-close>Done</DialogClose>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function AlertCase() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-open onClick={() => setOpen(true)} />
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogTitle>Delete</AlertDialogTitle>
          <AlertDialogDescription>Sure?</AlertDialogDescription>
          <AlertDialogClose data-close>Cancel</AlertDialogClose>
        </AlertDialogPopup>
      </AlertDialog>
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

describe.each([
  ["Dialog", DialogCase],
  ["AlertDialog", AlertCase],
])("%s over a native preview on the macOS desktop app", (_name, Case) => {
  it("holds an occlusion lease while open and releases it when it closes", async () => {
    await act(async () => root.render(<Case />));
    expect(leases()).toBe(0);
    await press("[data-open]");
    expect(leases()).toBe(1);
    await press("[data-close]");
    expect(leases()).toBe(0);
  });

  it("releases the lease when it unmounts while open", async () => {
    await act(async () => root.render(<Case />));
    await press("[data-open]");
    expect(leases()).toBe(1);
    await act(async () => root.render(null));
    expect(leases()).toBe(0);
  });

  it("takes no lease in the browser or off macOS", async () => {
    host.desktop = false;
    await act(async () => root.render(<Case />));
    await press("[data-open]");
    expect(leases()).toBe(0);
    await press("[data-close]");

    host.desktop = true;
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    await press("[data-open]");
    expect(leases()).toBe(0);
  });
});
