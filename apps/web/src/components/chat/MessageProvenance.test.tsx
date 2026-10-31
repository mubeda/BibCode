// @vitest-environment happy-dom

import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type AnyProps = Record<string, unknown>;

const shells = vi.hoisted(() => new Map<string, { title: string }>());
vi.mock("~/state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : (shells.get(ref.threadId) ?? null),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: AnyProps) => <>{props.children as ReactNode}</>,
  TooltipTrigger: (props: AnyProps) => {
    const render = props.render as { props: AnyProps } | undefined;
    return <span {...(render?.props ?? {})}>{props.children as ReactNode}</span>;
  },
  TooltipPopup: (props: AnyProps) => <div data-tooltip-popup>{props.children as ReactNode}</div>,
}));

import { MessageProvenance, provenanceText } from "./MessageProvenance";

const environmentId = EnvironmentId.make("env-1");
const actor = { kind: "mcp-client" as const, clientId: "session-1", label: "Claude Code" };
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(node));
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  shells.clear();
});

describe("MessageProvenance", () => {
  it("names the panel a message came from beside the agent chip", async () => {
    shells.set("panel-1", { title: "Review panel" });
    const container = await render(
      <MessageProvenance
        actor={actor}
        sourceThreadId={ThreadId.make("panel-1")}
        environmentId={environmentId}
      />,
    );
    expect(container.querySelector("[data-message-provenance]")?.textContent).toBe(
      "From Review panel",
    );
    expect(container.querySelector("[data-agent-chip]")?.textContent).toContain(
      "Agent · Claude Code",
    );
  });

  it("renders a title as text and says so when the source is gone", async () => {
    shells.set("panel-1", { title: "<img src=x onerror=alert(1)>" });
    const container = await render(
      <MessageProvenance
        actor={actor}
        sourceThreadId={ThreadId.make("panel-1")}
        environmentId={environmentId}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(provenanceText(undefined)).toBe("From another thread");
  });

  it("shows only the chip for an agent's message without a source, and nothing for a person's", async () => {
    const agentOnly = await render(
      <MessageProvenance actor={actor} sourceThreadId={undefined} environmentId={environmentId} />,
    );
    expect(agentOnly.querySelector("[data-message-provenance]")).toBeNull();
    expect(agentOnly.querySelector("[data-agent-chip]")).not.toBeNull();
    const person = await render(
      <MessageProvenance
        actor={undefined}
        sourceThreadId={undefined}
        environmentId={environmentId}
      />,
    );
    expect(person.innerHTML).toBe("");
  });
});
