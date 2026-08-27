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
});
