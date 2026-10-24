// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FileDiskConflictBar, fileDiskConflictSaveReason } from "./FileDiskConflictBar";
import type { FileDiskConflict } from "./fileEditingSession";

const changed: FileDiskConflict = { reason: "changed", diskKnown: true, unreadable: null };

describe("FileDiskConflictBar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalGetAnimations: PropertyDescriptor | undefined;

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

  const render = async (props: Parameters<typeof FileDiskConflictBar>[0]) => {
    await act(async () => root.render(<FileDiskConflictBar {...props} />));
  };

  const button = (label: string): HTMLButtonElement => {
    const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
  };

  it("reloads at once from the source view, where Undo brings the edits back", async () => {
    const onReload = vi.fn();
    const onOverwrite = vi.fn();
    await render({ conflict: changed, confirmReload: false, onReload, onOverwrite });

    expect(container.textContent).toContain("Changed on disk.");
    await act(async () => button("Reload from disk").click());
    expect(onReload).toHaveBeenCalledOnce();
    await act(async () => button("Overwrite disk").click());
    expect(onOverwrite).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Discard your unsaved edits?");
  });

  it("asks before a reload that cannot be undone, and Cancel keeps the edits", async () => {
    const onReload = vi.fn();
    await render({ conflict: changed, confirmReload: true, onReload, onOverwrite: vi.fn() });

    await act(async () => button("Reload from disk").click());
    expect(document.body.textContent).toContain("Discard your unsaved edits?");
    expect(onReload).not.toHaveBeenCalled();
    await act(async () => button("Cancel").click());
    expect(onReload).not.toHaveBeenCalled();

    await act(async () => button("Reload from disk").click());
    await act(async () => button("Discard edits").click());
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("names a deletion and offers only Overwrite disk for an unreadable file", async () => {
    await render({
      conflict: { reason: "deleted", diskKnown: true, unreadable: null },
      confirmReload: true,
      onReload: vi.fn(),
      onOverwrite: vi.fn(),
    });
    expect(container.textContent).toContain("Deleted on disk.");

    await render({
      conflict: { reason: "unreadable", diskKnown: true, unreadable: "binary_file" },
      confirmReload: false,
      onReload: vi.fn(),
      onOverwrite: vi.fn(),
    });
    expect(container.textContent).toContain("It is now a binary file");
    expect([...container.querySelectorAll("button")].map((node) => node.textContent)).toEqual([
      "Overwrite disk",
    ]);
  });

  it("disables both choices until the disk state behind a refused save is known", async () => {
    await render({
      conflict: { reason: "changed", diskKnown: false, unreadable: null },
      confirmReload: false,
      onReload: vi.fn(),
      onOverwrite: vi.fn(),
    });
    expect(button("Reload from disk").disabled).toBe(true);
    expect(button("Overwrite disk").disabled).toBe(true);
    expect(container.textContent).toContain("Checking the file on disk…");
  });

  it("explains why Save is disabled", () => {
    expect(fileDiskConflictSaveReason(changed)).toBe(
      "Changed on disk. Choose Reload from disk or Overwrite disk.",
    );
  });
});
