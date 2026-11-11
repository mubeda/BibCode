// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { classOf, levelTextTags, textColorUtilities } from "../sidebar/sidebarLevels.testSupport";
import { SidebarLevelsPreview } from "./SidebarLevelsPreview";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SidebarLevelsPreview />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const levels = (level: string) => [
  ...container.querySelectorAll<HTMLElement>(`[data-sidebar-level="${level}"]`),
];

describe("SidebarLevelsPreview", () => {
  it("draws one repository, two environments, a primary checkout, two worktrees and chat rows", () => {
    expect(levels("repo")).toHaveLength(1);
    expect(levels("environment")).toHaveLength(2);
    expect(levels("checkout")).toHaveLength(1);
    expect(levels("worktree")).toHaveLength(2);
    expect(levels("chat").length).toBeGreaterThanOrEqual(3);
    expect(levels("chat").some((row) => /^\d+ more chats$/.test(row.textContent ?? ""))).toBe(true);
  });

  it("marks the primary checkout with data-primary, an icon, a badge and a label", () => {
    const [checkout] = levels("checkout");
    expect(checkout!.hasAttribute("data-primary")).toBe(true);
    expect(checkout!.querySelector("svg[data-sidebar-icon]")).not.toBeNull();
    expect(checkout!.querySelector("[data-sidebar-badge]")?.textContent).toBe("primary");
    expect(checkout!.querySelector("[data-sidebar-label]")?.textContent).toBe("main");
    for (const worktree of levels("worktree")) {
      expect(worktree.hasAttribute("data-primary")).toBe(false);
      expect(worktree.querySelector("svg[data-sidebar-icon]")).not.toBeNull();
    }
  });

  it("selects one worktree, marks the primary checkout active, and dims the unavailable environment", () => {
    const selected = levels("worktree").filter((row) => row.dataset.selected === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.className).toContain("bg-primary/15");
    const active = container.querySelectorAll('[data-active="true"]');
    expect(active).toHaveLength(1);
    expect(active[0]).toBe(levels("checkout")[0]);
    expect(levels("checkout")[0]!.dataset.selected).toBeUndefined();
    const [, unavailable] = levels("environment");
    expect(unavailable!.className).toContain("opacity-60");
    expect(unavailable!.textContent).toContain("Unavailable");
  });

  it("leads each worktree with its branch label and puts its chats below at chat level", () => {
    for (const worktree of levels("worktree")) {
      const label = worktree.querySelector("[data-sidebar-label]")!;
      expect(label.textContent).toMatch(/^feature\//);
      const chat = worktree.querySelector('[data-sidebar-level="chat"]')!;
      expect(label.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("shows one unread chat with a dot before its title, the label at foreground", () => {
    const unread = [...container.querySelectorAll<HTMLElement>('[data-unread="true"]')];
    expect(unread).toHaveLength(1);
    expect(unread[0]!.getAttribute("data-sidebar-level")).toBe("chat");
    const dot = unread[0]!.parentElement!.querySelector("[data-sidebar-unread]")!;
    expect(dot.className).toMatch(/\brounded-full\b/);
    expect(dot.compareDocumentPosition(unread[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("[data-sidebar-unread]")).toHaveLength(1);
  });

  it("gives no level label or chat text a colour utility", () => {
    const tags = levelTextTags(container.innerHTML);
    expect(tags.length).toBeGreaterThan(4);
    for (const tag of tags) expect(textColorUtilities(classOf(tag)), tag).toEqual([]);
  });

  it("sits in a sidebar card on the well, is hidden from interaction and uses placeholder names only", () => {
    const [repo] = levels("repo");
    expect(repo!.getAttribute("data-sidebar-card")).toBe("true");
    expect(repo!.className).toContain("bg-sidebar-card");
    const figure = container.querySelector("figure")!;
    expect(figure.getAttribute("aria-label")).toBe("Sidebar preview");
    expect(figure.querySelector("[inert]")).not.toBeNull();
    expect(container.querySelectorAll("button, a, input")).toHaveLength(0);
    const text = container.textContent ?? "";
    expect(text).toContain("example-group/sample-project");
    expect(text).toContain("example-server");
    expect(text).toContain("feature/sample");
  });
});
