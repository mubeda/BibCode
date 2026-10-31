// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type AnyProps = Record<string, unknown>;

vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: AnyProps) => <>{props.children as ReactNode}</>,
  TooltipTrigger: (props: AnyProps) => {
    const render = props.render as { props: AnyProps } | undefined;
    return <span {...(render?.props ?? {})}>{props.children as ReactNode}</span>;
  },
  TooltipPopup: (props: AnyProps) => <div data-tooltip-popup>{props.children as ReactNode}</div>,
}));

import { AgentActorChip, agentChipText } from "./AgentActorChip";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(node);
  });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("AgentActorChip", () => {
  it("names the agent and puts its purpose in the tooltip", async () => {
    const container = await render(
      <AgentActorChip label="Claude Code" purpose="Fix the flaky test" />,
    );
    expect(container.querySelector("[data-agent-chip]")?.textContent).toBe("Agent · Claude Code");
    expect(container.querySelector("[data-tooltip-popup]")?.textContent).toContain(
      "Fix the flaky test",
    );
  });

  it("renders a label as text, never as markup", async () => {
    const container = await render(<AgentActorChip label="<img src=x onerror=alert(1)>" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("falls back to Agent for an agent with no label, and keeps compact text readable", async () => {
    expect(agentChipText(null)).toBe("Agent");
    expect(agentChipText("  ")).toBe("Agent");
    const container = await render(<AgentActorChip compact label="Codex" />);
    expect(container.querySelector(".sr-only")?.textContent).toBe("Agent · Codex");
  });
});
