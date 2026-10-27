// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <section className={className}>{children}</section>
  ),
}));

import { useUiStateStore } from "../../uiStateStore";
import { SidebarViewToggle } from "./SidebarViewToggle";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function buttons(): HTMLButtonElement[] {
  return Array.from(container!.querySelectorAll<HTMLButtonElement>('[role="group"] button'));
}

function pressed(): string[] {
  return buttons()
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.getAttribute("aria-label") ?? "");
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useUiStateStore.setState({ sidebarView: "environments" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<SidebarViewToggle />));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("SidebarViewToggle", () => {
  it("offers Environments, Repositories and Inbox, each named and with an icon", () => {
    expect(container!.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
      "Sidebar view",
    );
    expect(buttons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Environments view",
      "Repositories view",
      "Inbox view",
    ]);
    for (const button of buttons()) {
      expect(button.type).toBe("button");
      expect(button.querySelector("svg")).not.toBeNull();
      // The label can collapse to the icon at narrow widths, so the title still names it.
      expect(button.title).toBe(button.getAttribute("aria-label")?.replace(/ view$/, ""));
    }
    expect(pressed()).toEqual(["Environments view"]);
  });

  it("switches views by click and keeps exactly one pressed", async () => {
    await act(async () => buttons()[2]!.click());
    expect(useUiStateStore.getState().sidebarView).toBe("inbox");
    expect(pressed()).toEqual(["Inbox view"]);

    await act(async () => buttons()[1]!.click());
    expect(useUiStateStore.getState().sidebarView).toBe("repositories");
    expect(pressed()).toEqual(["Repositories view"]);
  });

  it("is reachable by keyboard: each option is a focusable native button", async () => {
    const inbox = buttons()[2]!;
    inbox.focus();
    expect(document.activeElement).toBe(inbox);
    expect(inbox.tabIndex).toBe(0);
    expect(inbox.disabled).toBe(false);
  });
});
