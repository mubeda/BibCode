// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { Tabs, TabsList, TabsPanel, TabsTab } from "./tabs";

describe("Tabs", () => {
  it("renders the selected panel and switches on tab activation", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTab value="one">One</TabsTab>
            <TabsTab value="two">Two</TabsTab>
          </TabsList>
          <TabsPanel value="one">first panel</TabsPanel>
          <TabsPanel value="two">second panel</TabsPanel>
        </Tabs>,
      );
    });

    expect(container.textContent).toContain("first panel");
    expect(container.textContent).not.toContain("second panel");

    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    await act(async () => {
      (tabs[1] as HTMLElement).click();
    });
    expect(container.textContent).toContain("second panel");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("styles the selected tab through the data-active attribute Base UI sets on it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTab value="one">One</TabsTab>
            <TabsTab value="two">Two</TabsTab>
          </TabsList>
        </Tabs>,
      );
    });

    const [one, two] = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    // Base UI marks the selected tab data-active (TabsTabDataAttributes.active); it never
    // sets data-selected on a tab, so selection styles keyed to it would never apply.
    expect(one?.getAttribute("aria-selected")).toBe("true");
    expect(one?.hasAttribute("data-active")).toBe(true);
    expect(two?.hasAttribute("data-active")).toBe(false);
    expect(one?.className).toMatch(/(^|\s)data-active:text-foreground(\s|$)/);
    expect(one?.className).not.toMatch(/data-selected:/);

    await act(async () => two?.click());
    expect(two?.hasAttribute("data-active")).toBe(true);
    expect(one?.hasAttribute("data-active")).toBe(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
